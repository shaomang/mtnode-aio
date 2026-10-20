/**
 * mcp-media-agent.js — MCP 自用回环的**媒体生成执行体**（主进程）
 *
 * 干什么：把 mtnode_generate 一次调用翻成 MTNode 自己那条生成链的一次真实调用 ——
 *   图像 = 与应用 / 函数节点同一个内核（main.js 的 fnImageCall → apps-store 的 hostImageGenerate）；
 *   语音 = breeze 宿主（generateBreezeFile）；音乐 = music3 宿主（generateMusic）；
 *   视频 = h3 宿主（generateVideo）。
 *
 * 为什么放在主进程：这四个后端都是主进程模块，而且**全局只有一把音视频互斥锁**
 *   （media-gen-global-lock.js：画布节点、手机接管、这次回环排的是同一队）。
 *   绕开主进程另起一条执行路就会多出一个不受这把锁约束的入口。
 *
 * 依赖注入（main.js 的 mcp() 工厂）：本模块不 require 任何后端模块，四个生成函数与两个
 *   取消函数由调用方传进来 —— 依赖方向单向，也便于冒烟测试塞假实现。
 *
 * 回执口径：{ ok, kind, path, bytes, mime?, model?, warnings? } 或 { ok:false, error, message?, code? }。
 *   path 一定是**本机绝对路径**且文件真的在盘上（这里再 stat 一次，不让上层拿到幻影路径）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const KINDS = ["image", "music", "speech", "video"];

function bad(message, error) {
  return { ok: false, error: String(error || "failed"), message: String(message || "") };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 一个作业的稳定 nodeId：后端用它占全局锁、按它取消（MCP 作业 id 一一对应）。 */
function nodeIdOf(jobId) {
  const id = String(jobId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return "mcp-" + (id || "job");
}

function createMediaAgent(o) {
  const deps = o && typeof o === "object" ? o : {};
  const log = typeof deps.log === "function" ? deps.log : () => {};

  /** 在跑的作业：jobId → { kind, nodeId }。取消时按它找到后端那次调用的 nodeId。 */
  const active = new Map();

  /** 文件真的在盘上才算成功：后端回执缺 path / 路径不存在时一律判失败（绝不回幻影路径）。 */
  function finish(kind, r, wantPath) {
    const res = r && typeof r === "object" ? r : {};
    if (res.ok === false) {
      return {
        ok: false,
        kind,
        error: String(res.error || "failed"),
        message: String(res.message || res.error || ""),
        code: String(res.code || ""),
        warnings: Array.isArray(res.warnings) ? res.warnings.slice(0, 8) : [],
      };
    }
    let file = String(res.path || res.file || "").trim();
    if (!file && wantPath) file = String(wantPath);
    if (!file) return bad("生成回执里没有产物路径", "no_output");
    try {
      file = path.resolve(file);
      const st = fs.statSync(file);
      if (!st.isFile() || st.size <= 0) return bad("产物文件为空或不是文件：" + file, "bad_output");
      return {
        ok: true,
        kind,
        path: file,
        bytes: Number(res.bytes) || st.size,
        mime: String(res.mime || ""),
        model: String(res.model || ""),
        via: String(res.via || ""),
        durationSec: num(res.durationSec),
        warnings: Array.isArray(res.warnings) ? res.warnings.slice(0, 8) : [],
      };
    } catch (e) {
      return bad("产物落盘后找不到文件：" + file, "missing_output");
    }
  }

  /** 自定义 outputPath：把后端产物搬过去（跨盘用 copyFile，失败回错误而不是假装成功）。 */
  function moveTo(file, wantPath) {
    const dest = String(wantPath || "").trim();
    if (!dest) return file;
    try {
      const abs = path.resolve(dest);
      if (abs === path.resolve(file)) return abs;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(file, abs);
      return abs;
    } catch (e) {
      log("[mcp] 产物另存失败：" + ((e && e.message) || e));
      return file;
    }
  }

  async function runImage(p, ctx) {
    if (typeof deps.image !== "function") return bad("图像生成内核不可用", "no_kernel");
    const prompt = String(p.prompt || "").trim();
    if (!prompt) return bad("image 需要 prompt", "no_prompt");
    const ref = String(p.refImage || "").trim();
    const model = String(p.model || "").trim();
    const args = {
      prompt,
      model,
      nodeId: ctx.nodeId,
      wfId: String(p.wfId || ""),
    };
    if (ref) args.img = { path: ref, model };
    if (String(p.size || "").trim()) args.size = String(p.size).trim();
    if (p.seed !== undefined && p.seed !== null && p.seed !== "") args.seed = p.seed;
    const r = await deps.image(args);
    const out = finish("image", r, "");
    if (!out.ok) return out;
    out.path = moveTo(out.path, p.outputPath);
    return out;
  }

  async function runSpeech(p, ctx) {
    if (typeof deps.speech !== "function") return bad("语音生成内核不可用", "no_kernel");
    const text = String(p.text || "").trim();
    if (!text) return bad("speech 需要 text（要念的台词）", "no_text");
    const r = await deps.speech({
      nodeId: ctx.nodeId,
      workflowId: String(p.wfId || ""),
      text,
      voice: String(p.voice || ""),
      presetId: String(p.presetId || ""),
      instruction: String(p.instruction || ""),
      refAudio: String(p.refAudio || ""),
      refText: String(p.refText || ""),
      response_format: String(p.format || "wav"),
      seed: p.seed,
      outputPath: String(p.outputPath || ""),
    });
    return finish("speech", r, "");
  }

  async function runMusic(p, ctx) {
    if (typeof deps.music !== "function") return bad("音乐生成内核不可用", "no_kernel");
    const prompt = String(p.prompt || "").trim();
    const lyrics = String(p.lyrics || "").trim();
    if (!prompt && !lyrics) return bad("music 需要 prompt 或 lyrics", "no_prompt");
    const extra = {};
    const dest = String(p.outputPath || "").trim();
    if (dest) {
      extra.outputDir = path.dirname(path.resolve(dest));
      extra.filename = path.basename(path.resolve(dest));
    }
    const r = await deps.music(
      Object.assign(
        {
          nodeId: ctx.nodeId,
          workflowId: String(p.wfId || ""),
          prompt,
          lyrics,
          audioDuration: num(p.duration),
          seed: p.seed,
        },
        extra,
      ),
    );
    return finish("music", r, "");
  }

  async function runVideo(p, ctx) {
    if (typeof deps.video !== "function") return bad("视频生成内核不可用", "no_kernel");
    const prompt = String(p.prompt || "").trim();
    if (!prompt) return bad("video 需要 prompt", "no_prompt");
    const extra = {};
    const dest = String(p.outputPath || "").trim();
    if (dest) {
      extra.outputDir = path.dirname(path.resolve(dest));
      extra.filename = path.basename(path.resolve(dest));
    }
    const r = await deps.video(
      Object.assign(
        {
          nodeId: ctx.nodeId,
          workflowId: String(p.wfId || ""),
          prompt,
          duration: num(p.duration),
          outputRes: String(p.outputRes || ""),
          seed: p.seed,
          firstImage: String(p.refImage || ""),
        },
        extra,
      ),
    );
    return finish("video", r, "");
  }

  /**
   * 跑一次生成（阻塞直到出结果）。ctx = { jobId }。
   * 回 { ok, kind, path, bytes, … } 或 { ok:false, error, message }。
   */
  async function run(kind, params, ctx) {
    const k = String(kind || "").trim();
    if (!KINDS.includes(k)) return bad("kind 必须是 " + KINDS.join(" / "), "bad_kind");
    const p = params && typeof params === "object" ? params : {};
    const c = { nodeId: nodeIdOf(ctx && ctx.jobId) };
    active.set(String((ctx && ctx.jobId) || ""), { kind: k, nodeId: c.nodeId });
    let out = null;
    try {
      if (k === "image") out = await runImage(p, c);
      else if (k === "speech") out = await runSpeech(p, c);
      else if (k === "music") out = await runMusic(p, c);
      else out = await runVideo(p, c);
    } catch (e) {
      out = {
        ok: false,
        kind: k,
        error: String((e && e.code) || "failed"),
        message: String((e && e.message) || e),
      };
    } finally {
      active.delete(String((ctx && ctx.jobId) || ""));
    }
    /* 产物一律顺手收进素材库（p.archive === false 可关）：回执里带上素材条目，
       用户在工作台上能直接看见、能复用；归档失败只记一句，不影响「文件已生成」这件事。 */
    if (out && out.ok && typeof deps.archive === "function" && p.archive !== false) {
      try {
        const a = deps.archive({
          paths: [out.path],
          name: String(p.title || "").trim(),
          category: String(p.category || "MCP 产物"),
          desc: "MCP 生成 · " + k,
        });
        if (a && a.ok && a.asset) {
          out.asset = { id: a.asset.id, rel: a.asset.rel, displayName: a.asset.displayName };
        } else if (a && a.error) {
          out.warnings = (out.warnings || []).concat(["素材库归档失败：" + a.error]);
        }
      } catch (e) {
        out.warnings = (out.warnings || []).concat(["素材库归档失败：" + ((e && e.message) || e)]);
      }
    }
    return out;
  }

  /** 尽力取消：music / video 有真取消口；image / speech 没有（图像是「一次请求等结果」，
      语音也没有中断口）→ 如实回 cancel_unsupported，让调用方等它跑完。 */
  function cancel(jobId) {
    const rec = active.get(String(jobId || ""));
    if (!rec) return { ok: false, error: "job_not_running", message: "该作业不在运行中（可能已完成）" };
    const nid = rec.nodeId;
    try {
      if (rec.kind === "music" && typeof deps.cancelMusic === "function") {
        deps.cancelMusic(nid);
        return { ok: true, kind: rec.kind, cancelled: true };
      }
      if (rec.kind === "video" && typeof deps.cancelVideo === "function") {
        deps.cancelVideo(nid);
        return { ok: true, kind: rec.kind, cancelled: true };
      }
      if (rec.kind === "image" && typeof deps.cancelImage === "function") {
        const r = deps.cancelImage(nid);
        return { ok: true, kind: rec.kind, cancelled: !!(r && r.cancelled) };
      }
    } catch (e) {
      return { ok: false, error: "cancel_failed", message: String((e && e.message) || e) };
    }
    return {
      ok: false,
      error: "cancel_unsupported",
      message: rec.kind + " 这一路没有取消口：让它跑完（或到界面上按 ■）",
    };
  }

  return { run, cancel, kinds: KINDS.slice() };
}

module.exports = { createMediaAgent, KINDS };

"use strict";
/* MCP 自用回环（应用内 Agent 经 MCP 调自己的生成能力）—— 冒烟测试（纯 Node，不启 Electron）
 *   node test/smoke-mcp-self-loop.js
 * 口径：这条回环的意义是「自己调自己走的是同一套入口」，所以这里钉的是**真实行为**：
 *   真的起 HTTP 服务端、真的发 JSON-RPC、真的跑作业表；媒体后端塞假实现（不碰 GPU / 网络）。
 * 覆盖：
 *   [1] 令牌可以走 query（?token=…）—— dsh 的 HTTP MCP 客户端塞不了自定义头
 *   [2] 回环注册：监听成功即回调 enabled + url（含端口与令牌），关掉即回调 enabled:false
 *   [3] 作业：异步立刻回 jobId、status 取结果、list、未知 id 回 JOB_GONE
 *   [4] 同步 wait:true 一次拿到结果；createNode 缺 canvas/baseHash 只加警告不建节点
 *   [5] 媒体执行体：四路 kind 分派、必填校验、产物 stat、素材库归档、取消口径
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { createMcpHost } = require("../mcp-server.js");
const { createMediaAgent, KINDS } = require("../mcp-media-agent.js");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-self-loop-"));
const outFile = path.join(TMP, "out.png");
fs.writeFileSync(outFile, Buffer.from("fake-image"));

/* ── 假的媒体执行体（真链路的回执形状照抄 mcp-media-agent.js） ───────────────── */
function fakeMedia(opts) {
  const o = opts || {};
  const seen = [];
  return {
    seen,
    async run(kind, params, ctx) {
      seen.push({ kind, params, ctx });
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (kind === "speech" && !params.text) return { ok: false, error: "no_text", message: "speech 需要 text" };
      const p = path.join(TMP, "out-" + kind + (kind === "image" ? ".png" : kind === "video" ? ".mp4" : ".wav"));
      fs.writeFileSync(p, Buffer.from("fake-" + kind));
      return { ok: true, kind, path: p, bytes: fs.statSync(p).size, mime: "", model: "fake", warnings: [] };
    },
    cancel(jobId) {
      return { ok: false, error: "cancel_unsupported", message: "fake: " + jobId };
    },
  };
}

function postJson(port, p, obj, headers) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        headers: Object.assign({ "content-type": "application/json", "content-length": body.length }, headers || {}),
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch {
            /* 非 JSON = 401 之类的空体 */
          }
          resolve({ status: res.statusCode, json, text: buf });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const call = (port, id, name, args, headers, qtok) =>
  postJson(
    port,
    "/mcp" + (qtok ? "?token=" + encodeURIComponent(qtok) : ""),
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    headers,
  );

/* 工具回执是 JSON 文本包在 content[0].text 里（MCP 口径） */
function payload(r) {
  try {
    return JSON.parse(r.json.result.content[0].text);
  } catch {
    return { __raw: r.json, __text: r.text };
  }
}

(async () => {
  /* ── [1][2][3][4] 服务端整体 ──────────────────────────────────────────── */
  console.log("[1] 令牌走 query（dsh 的 HTTP MCP 客户端只能给 url）");
  const loopCalls = [];
  const media = fakeMedia({ delayMs: 40 });
  const host = createMcpHost({
    dataDir: TMP,
    appRoot: ROOT,
    sendToRenderer: () => {
      throw new Error("这里不该推渲染层（媒体与作业都在主进程）");
    },
    media,
    selfLoop: (cfg) => {
      loopCalls.push(cfg);
      return { ok: true, enabled: !!cfg.enabled };
    },
    log: () => {},
  });
  const st = await host.start();
  ok(st.running && st.port > 0, "服务端起来了：port=" + st.port);
  const auth = { authorization: "Bearer " + st.token };
  const q = await call(st.port, 1, "mtnode_generate", { action: "list" }, {}, st.token);
  ok(q.status === 200 && q.json && !q.json.error, "query 里的令牌能过鉴权（不带头）");
  const bad = await call(st.port, 2, "mtnode_generate", { action: "list" }, {}, "nope");
  ok(bad.status === 401, "query 里令牌不对仍然 401");

  console.log("[2] 回环注册（监听即挂、关掉即撤）");
  const first = loopCalls[0] || {};
  ok(first.enabled === true, "监听成功后回调 enabled:true");
  ok(/^http:\/\/127\.0\.0\.1:\d+\/mcp\?token=/.test(String(first.url || "")), "回环 url 带端口与令牌：" + String(first.url || "").replace(/token=.*/, "token=***"));
  ok(
    Array.isArray(first.tools) && first.tools.length === 4 && first.tools.includes("mtnode_generate") && first.tools.includes("mtnode_session"),
    "只挂四项子集：" + (first.tools || []).join(" / "),
  );
  ok(st.selfLoop === true && st.selfLoopActive === true, "status 报自用回环已生效");
  host.setSelfLoop(false);
  ok((loopCalls[loopCalls.length - 1] || {}).enabled === false, "关掉自用回环 → 回调 enabled:false（引擎那边撤掉那一行）");
  ok(host.status().selfLoopActive === false, "status 立刻反映已关闭");
  host.setSelfLoop(true);
  ok((loopCalls[loopCalls.length - 1] || {}).enabled === true, "再打开 → 重新回调 enabled:true");

  console.log("[3] 作业：异步立刻回 jobId");
  const a = await call(st.port, 3, "mtnode_generate", { kind: "image", prompt: "一只猫" }, auth);
  const aj = payload(a);
  ok(aj.ok === true && /^job-/.test(String(aj.jobId || "")), "wait:false 立刻回 jobId=" + aj.jobId);
  ok(aj.status === "running", "刚起时状态是 running");
  const s1 = payload(await call(st.port, 4, "mtnode_generate", { action: "status", jobId: aj.jobId, wait: true }, auth));
  ok(s1.ok === true && s1.status === "ok", "status + wait 拿到结果（status=" + s1.status + "）");
  ok(s1.result && s1.result.ok && s1.result.path === outFile.replace("out.png", "out-image.png"), "结果里是本机绝对路径");
  ok(fs.existsSync(s1.result.path), "产物文件真的在盘上");
  const list = payload(await call(st.port, 5, "mtnode_generate", { action: "list" }, auth));
  ok(list.ok === true && list.count >= 1 && list.jobs.some((j) => j.jobId === aj.jobId), "action:list 列出刚跑完的作业");
  ok(host.listJobs().length >= 1, "主进程也拿得到作业表（面板用）");
  const gone = payload(await call(st.port, 6, "mtnode_generate", { action: "status", jobId: "job-deadbeef" }, auth));
  ok(gone.ok === false && gone.error === "JOB_GONE", "查不存在的作业 → JOB_GONE（重启即丢，不假装有结果）");

  console.log("[4] 同步等待 / createNode 前置条件");
  const sync = payload(await call(st.port, 7, "mtnode_generate", { kind: "speech", text: "你好", wait: true }, auth));
  ok(sync.ok === true && sync.status === "ok", "wait:true 一次拿到结果");
  ok(sync.result && sync.result.kind === "speech", "结果是 speech 的产物");
  const cn = payload(
    await call(st.port, 8, "mtnode_generate", { kind: "image", prompt: "狗", createNode: true, wait: true }, auth),
  );
  ok(cn.ok === true && !cn.result.node, "createNode 没给 canvas/baseHash → 不建节点");
  ok(
    (cn.result.warnings || []).some((w) => /canvas 与 baseHash/.test(w)),
    "并且明确说清缺什么（不是静默忽略）",
  );
  const noKind = await call(st.port, 9, "mtnode_generate", { prompt: "x" }, auth);
  const noKindText = String((noKind.json.result && noKind.json.result.content[0].text) || "");
  ok(
    (noKind.json.result && noKind.json.result.isError === true) || (noKind.json.error && /kind/.test(noKind.json.error.message)),
    "缺 kind → 明确报错",
  );
  ok(/kind/.test(noKindText) || (noKind.json.error && /kind/.test(noKind.json.error.message)), "错误文本点名 kind");

  host.stop();

  /* ── [5] 媒体执行体本体（直接调，不经过 HTTP） ───────────────────────────── */
  console.log("[5] 媒体执行体：分派 / 校验 / 归档 / 取消");
  ok(KINDS.join(",") === "image,music,speech,video", "kind 全集 = image / music / speech / video");
  let archived = null;
  const agent = createMediaAgent({
    image: async (args) => {
      fs.writeFileSync(outFile, Buffer.from("img"));
      return { ok: true, path: outFile, model: args.model || "m", via: "test" };
    },
    speech: async () => ({ ok: true, path: path.join(TMP, "s.wav") }),
    music: async () => ({ ok: true, path: path.join(TMP, "m.wav") }),
    video: async () => ({ ok: true, path: path.join(TMP, "v.mp4") }),
    archive: (a) => {
      archived = a;
      return { ok: true, asset: { id: "as1", rel: "MCP 产物/x", displayName: "x" } };
    },
    log: () => {},
  });
  const badKind = await agent.run("pdf", {}, { jobId: "job-1" });
  ok(badKind.ok === false && badKind.error === "bad_kind", "未知 kind → bad_kind");
  const noPrompt = await agent.run("image", {}, { jobId: "job-1" });
  ok(noPrompt.ok === false && noPrompt.error === "no_prompt", "image 缺 prompt → no_prompt");
  const noText = await agent.run("speech", {}, { jobId: "job-1" });
  ok(noText.ok === false && noText.error === "no_text", "speech 缺 text → no_text");
  const img = await agent.run("image", { prompt: "猫", title: "一只猫" }, { jobId: "job-2" });
  ok(img.ok === true && img.path === path.resolve(outFile), "image 成功并回绝对路径");
  ok(img.bytes > 0, "回执带真实字节数（stat 过）");
  ok(img.asset && img.asset.id === "as1", "产物默认收进素材库（回执带 asset）");
  ok(archived && archived.category === "MCP 产物" && /一只猫/.test(archived.name), "归档带上标题与分类");
  archived = null;
  await agent.run("video", { prompt: "海", archive: false }, { jobId: "job-3" });
  ok(archived === null, "archive:false 时不进素材库");
  const missing = createMediaAgent({ image: async () => ({ ok: true, path: path.join(TMP, "nope.png") }), log: () => {} });
  const ghost = await missing.run("image", { prompt: "x" }, { jobId: "job-4" });
  ok(ghost.ok === false && ghost.error === "missing_output", "后端回了不存在的路径 → missing_output（绝不回幻影路径）");
  const noKernel = createMediaAgent({});
  ok((await noKernel.run("music", { prompt: "x" }, {})).error === "no_kernel", "没注入内核 → no_kernel");
  ok(noKernel.cancel("job-x").error === "job_not_running", "取消不在跑的作业 → job_not_running");
  ok(agent.kinds.length === 4, "回执 kinds 与 KINDS 同源");

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("");
  console.log(fails ? "✗ " + fails + " / " + checks + " 项未通过" : "✓ 全部 " + checks + " 项通过");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log("FAIL  冒烟自身异常：" + ((e && e.stack) || e));
  process.exit(1);
});

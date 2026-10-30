"use strict";
/**
 * 质检节点（qa_text / qa_image / qa_video / qa_audio / qa_file）· 主进程媒体 / 落盘 / 模板宿主
 *
 * 只有四件事，全部是「渲染层做不了的本机活」：
 *   ① probe     —— ffprobe 读硬指标（时长 / 分辨率 / 帧率 / 码率）+ blackdetect 数黑帧段；
 *   ② frames    —— 按时间点均匀抽帧成 PNG（默认 7 张、上限 12，单帧宽 ≤1280），交给 VLM；
 *   ③ writeReport —— 把 qa 报告落到 <工程根>/qa/reports/{shot_id}.json（+ 历史 .r{n}.json）；
 *   ④ templates —— 列出内置 / 数据目录 / 工程三处 JSON 评分标准（同基本名后者覆盖前者）。
 *
 * 边界（与 manifest-store 同一口径）：
 *   · 工程根只认渲染层传进来的 root，主进程不猜、不兜底到数据目录；
 *   · 抽帧写系统临时目录，不进工程、不进应用目录；
 *   · ffmpeg 查找顺序与 dsh 的 media-plugin 一致：PATH → Remotion 安装目录 → 其它本地后端便携目录，
 *     都没有就报错并给安装指引（不自动下载）。
 */

const { ipcMain, app } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = process.platform === "win32" ? ".exe" : "";
const PROBE_TIMEOUT_MS = 60000;
const FRAME_TIMEOUT_MS = 60000;
const MAX_FRAMES = 12;
const NOT_FOUND_HINT =
  "没有找到本机 ffmpeg：请装 Remotion 插件（自带 ffmpeg），或把 ffmpeg 放进 PATH 再试。";

let ffmpegCache = null;

function dataRoot() {
  try {
    return app.getPath("userData");
  } catch (_) {
    return "";
  }
}

function exists(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

function fromPath() {
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, ["ffmpeg"], { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) return "";
  const line = String(r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return exists(line) ? line : "";
}

function fromKnownLayouts(root) {
  if (!root) return "";
  const cands = [
    path.join(root, "ffmpeg" + EXE),
    path.join(root, "bin", "ffmpeg" + EXE),
    path.join(root, "tools", "ffmpeg", "ffmpeg" + EXE),
    path.join(root, "tools", "ffmpeg", "bin", "ffmpeg" + EXE),
  ];
  for (const c of cands) if (exists(c)) return c;
  return "";
}

function fromRemotion(installDir) {
  const known = fromKnownLayouts(installDir);
  if (known) return known;
  const base = path.join(installDir, "node_modules", "@remotion");
  if (!fs.existsSync(base)) return "";
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (_) {
    return "";
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^compositor-/i.test(ent.name)) continue;
    const hit = path.join(base, ent.name, "ffmpeg" + EXE);
    if (exists(hit)) return hit;
  }
  return "";
}

const BACKEND_DIRS = ["remotion", "breeze", "h3", "music3", "yue", "llama"];

function fromBackends(root) {
  if (!root) return "";
  for (const id of BACKEND_DIRS) {
    const cfg = readJson(path.join(root, id, "config.json"));
    const dir = cfg && typeof cfg.installDir === "string" ? cfg.installDir.trim() : "";
    if (!dir || !fs.existsSync(dir)) continue;
    const hit = id === "remotion" ? fromRemotion(dir) : fromKnownLayouts(dir);
    if (hit) return hit;
  }
  return "";
}

function resolveFfmpeg(force) {
  const now = Date.now();
  if (!force && ffmpegCache && now - ffmpegCache.at < 60000 && exists(ffmpegCache.ffmpeg)) {
    return ffmpegCache;
  }
  const root = dataRoot();
  const candidates = [
    ["PATH", fromPath()],
  ];
  const remotionCfg = root ? readJson(path.join(root, "remotion", "config.json")) : null;
  const remotionDir =
    remotionCfg && typeof remotionCfg.installDir === "string"
      ? remotionCfg.installDir.trim()
      : "";
  if (remotionDir) candidates.push(["Remotion 安装目录", fromRemotion(remotionDir)]);
  candidates.push(["本机已装后端的便携 ffmpeg", fromBackends(root)]);
  for (const [source, ffmpeg] of candidates) {
    if (!exists(ffmpeg)) continue;
    const sibling = path.join(path.dirname(ffmpeg), "ffprobe" + EXE);
    ffmpegCache = {
      ffmpeg,
      ffprobe: exists(sibling) ? sibling : "",
      source,
      at: now,
    };
    return ffmpegCache;
  }
  throw new Error(NOT_FOUND_HINT);
}

/* ── 外部进程 ─────────────────────────────────────────────────────────────── */

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const out = [];
    const err = [];
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e), stdout: "", stderr: "" });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch (_) {}
      resolve({
        ok: false,
        error: "命令超时（" + Math.round(timeoutMs / 1000) + " 秒）：" + path.basename(bin),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    }, timeoutMs);
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        error: String((e && e.message) || e),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        error: code === 0 ? "" : "退出码 " + code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

/* ── ① probe ──────────────────────────────────────────────────────────────── */

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

async function probeMedia(file) {
  const f = String(file || "").trim();
  if (!f) return { ok: false, error: "缺少媒体路径" };
  if (!exists(f)) return { ok: false, error: "文件不存在：" + f };
  let ff;
  try {
    ff = resolveFfmpeg();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  let meta = null;
  if (ff.ffprobe) {
    const r = await run(
      ff.ffprobe,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        f,
      ],
      PROBE_TIMEOUT_MS,
    );
    if (r.ok) {
      try {
        meta = JSON.parse(r.stdout);
      } catch (_) {
        meta = null;
      }
    }
  }
  const streams = (meta && meta.streams) || [];
  const v = streams.find((s) => s && s.codec_type === "video") || null;
  const a = streams.find((s) => s && s.codec_type === "audio") || null;
  const dur = num(meta && meta.format && meta.format.duration) || num(v && v.duration);
  const fpsRaw = String((v && (v.avg_frame_rate || v.r_frame_rate)) || "");
  let fps = 0;
  const mm = /^(\d+)\/(\d+)$/.exec(fpsRaw);
  if (mm && Number(mm[2])) fps = Number(mm[1]) / Number(mm[2]);
  /* 黑帧段（technical 硬指标之一）：0.08 秒以上、像素阈值 10% 算黑 */
  let blackSpans = 0;
  if (v) {
    const b = await run(
      ff.ffmpeg,
      ["-hide_banner", "-nostats", "-i", f, "-vf", "blackdetect=d=0.08:pix_th=0.10", "-an", "-f", "null", "-"],
      PROBE_TIMEOUT_MS,
    );
    const hits = String(b.stderr || "").match(/black_start:/g);
    blackSpans = hits ? hits.length : 0;
  }
  return {
    ok: true,
    path: f,
    ffmpegSource: ff.source,
    durationSec: dur,
    width: num(v && v.width),
    height: num(v && v.height),
    fps: Math.round(fps * 100) / 100,
    bitrate: num(meta && meta.format && meta.format.bit_rate),
    hasVideo: !!v,
    hasAudio: !!a,
    blackSpans,
  };
}

/* ── ② frames ─────────────────────────────────────────────────────────────── */

function timePoints(durationSec, count) {
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(count) || 7)));
  if (!durationSec || durationSec <= 0) return { times: [], count: n };
  const times = [];
  for (let i = 0; i < n; i++) {
    /* 避开首尾各 3%：首帧常是黑场、尾帧常是转场 */
    const t = durationSec * (0.03 + (0.94 * (i + 0.5)) / n);
    times.push(Math.max(0, Math.round(t * 1000) / 1000));
  }
  return { times, count: n };
}

async function extractFrames(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const file = String(p.path || "").trim();
  const times = Array.isArray(p.times)
    ? p.times.map((x) => num(x)).filter((t) => t >= 0).slice(0, MAX_FRAMES)
    : [];
  if (!file) return { ok: false, error: "缺少媒体路径" };
  if (!exists(file)) return { ok: false, error: "文件不存在：" + file };
  let ff;
  try {
    ff = resolveFfmpeg();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  const shot = String(p.shotId || "candidate").replace(/[^\w.-]+/g, "_") || "candidate";
  const dir = path.join(os.tmpdir(), "mtnode-qa", shot, String(Date.now()));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "建临时目录失败：" + String((e && e.message) || e) };
  }
  const list = times.length ? times : [0];
  const frames = [];
  for (let i = 0; i < list.length; i++) {
    const out = path.join(dir, "f" + String(i + 1).padStart(2, "0") + ".png");
    const r = await run(
      ff.ffmpeg,
      [
        "-hide_banner",
        "-nostats",
        "-ss",
        String(list[i]),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2",
        "-y",
        out,
      ],
      FRAME_TIMEOUT_MS,
    );
    if (r.ok && exists(out)) frames.push({ t: list[i], path: out });
  }
  if (!frames.length) {
    return {
      ok: false,
      error: "抽帧失败：一个时间点都没取到图（文件可能损坏 / 没有视频轨 / 时间点超出时长）",
      dir,
    };
  }
  return { ok: true, dir, frames, wanted: list.length };
}

/* ── ③ writeReport ────────────────────────────────────────────────────────── */

function safeAbs(root) {
  const r = String(root || "").trim();
  if (!r) throw new Error("没有工程根目录：请给画布设置「画布工作目录」");
  const abs = path.resolve(r);
  const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!st || !st.isDirectory()) throw new Error("工程根目录不存在：" + abs);
  return abs;
}

function safeName(id) {
  const s = String(id || "").trim().replace(/[^\w.-]+/g, "_");
  if (!s) throw new Error("报告缺少镜头 id（shot_id）");
  return s;
}

async function writeReport(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  let abs;
  try {
    abs = safeAbs(p.root);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  let name;
  try {
    name = safeName(p.shotId);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  const dir = path.join(abs, "qa", "reports");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "建报告目录失败：" + String((e && e.message) || e) };
  }
  const text = JSON.stringify(p.report || {}, null, 2) + "\n";
  const main = path.join(dir, name + ".json");
  const written = [];
  try {
    fs.writeFileSync(main, text, "utf8");
    written.push(main);
    const round = Math.max(0, Math.floor(Number(p.round) || 0));
    if (round > 0) {
      const hist = path.join(dir, name + ".r" + round + ".json");
      fs.writeFileSync(hist, text, "utf8");
      written.push(hist);
    }
  } catch (e) {
    return { ok: false, error: "写报告失败：" + String((e && e.message) || e) };
  }
  return {
    ok: true,
    path: main,
    rel: path.relative(abs, main).replace(/\\/g, "/"),
    written,
    root: abs,
  };
}

/* ── ④ 质检模板库（随包内置 + 数据目录 + 工程目录）────────────────────────────
 * 评分标准不进代码：模板是纯 JSON，MTNode 只提供目录与校验口径。
 *   内置：<appPath>/qa-templates/*.json（随包，只读）
 *   用户：<数据目录>/qa-templates/*.json（全局标准，可自建）
 *   工程：<工程根>/qa/templates/*.json（项目专用，同名覆盖上面两份）
 * 同名 = 文件基本名相同（不分大小写）；后出现的来源覆盖前面的。 */

const TEMPLATE_DIR = "qa-templates";

function builtinTemplateDir() {
  try {
    return path.join(app.getAppPath(), TEMPLATE_DIR);
  } catch (_) {
    return "";
  }
}

function templateDirs(root) {
  const list = [];
  const builtin = builtinTemplateDir();
  if (builtin) list.push({ source: "builtin", dir: builtin, writable: false });
  const data = dataRoot();
  if (data) list.push({ source: "user", dir: path.join(data, TEMPLATE_DIR), writable: true });
  const r = String(root || "").trim();
  if (r) {
    list.push({ source: "project", dir: path.join(path.resolve(r), "qa", "templates"), writable: true });
  }
  return list;
}

function readTemplateFile(file, source) {
  const base = path.basename(file).replace(/\.json$/i, "");
  const entry = {
    id: source + "/" + base,
    source,
    file,
    kind: "",
    title: "",
    description: "",
    passLine: 80,
    dimensions: [],
    error: "",
  };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    entry.error = "JSON 解析失败：" + String((e && e.message) || e);
    return entry;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    entry.error = "模板必须是一个 JSON 对象";
    return entry;
  }
  entry.kind = String(raw.kind || "").trim().toLowerCase();
  entry.title = String(raw.title || base).trim();
  entry.description = String(raw.description || "").trim();
  const pass = Number(raw.passLine);
  entry.passLine = isFinite(pass) ? Math.max(0, Math.min(100, pass)) : 80;
  entry.version = num(raw.version) || 1;
  entry.dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : [])
    .filter((d) => d && typeof d === "object")
    .map((d) => ({
      id: String(d.id || "").trim(),
      title: String(d.title || d.id || "").trim(),
      weight: num(d.weight),
      minScore: d.minScore == null ? null : num(d.minScore),
      criteria: String(d.criteria || "").trim(),
    }))
    .filter((d) => d.id);
  if (!entry.dimensions.length) entry.error = "模板里没有任何 dimensions（至少一维）";
  /* 原文快照：渲染层把它整份写进报告，换模板后仍能复现当时的判据 */
  entry.json = raw;
  return entry;
}

function listTemplates(root) {
  const dirs = templateDirs(root);
  const byKey = new Map();
  const broken = [];
  for (const d of dirs) {
    if (d.writable) {
      try {
        fs.mkdirSync(d.dir, { recursive: true });
      } catch (_) {}
    }
    let names = [];
    try {
      names = fs.readdirSync(d.dir).filter((n) => /\.json$/i.test(n));
    } catch (_) {
      names = [];
    }
    for (const n of names.sort()) {
      const entry = readTemplateFile(path.join(d.dir, n), d.source);
      const key = n.replace(/\.json$/i, "").toLowerCase();
      byKey.set(key, entry);
      if (entry.error) broken.push(entry.id + "：" + entry.error);
    }
  }
  const templates = Array.from(byKey.values()).sort((a, b) => {
    if (a.kind !== b.kind) return String(a.kind).localeCompare(String(b.kind));
    return String(a.title).localeCompare(String(b.title), "zh");
  });
  return {
    ok: true,
    templates,
    dirs,
    broken,
    builtin: builtinTemplateDir(),
  };
}

/* ── IPC ──────────────────────────────────────────────────────────────────── */

/** 把节点 body 里改好的 JSON 另存为用户模板（只写 <数据目录>/qa-templates/，绝不碰内置模板）。
 *  同名不覆盖：自动追加 -2 / -3…，返回新 id 供渲染层直接选中。 */
function saveTemplate(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const obj = p.json;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "要保存的标准必须是一个 JSON 对象" };
  }
  const dirs = templateDirs(p.root).filter((d) => d.source === "user");
  const dir = dirs.length ? dirs[0].dir : "";
  if (!dir) return { ok: false, error: "用户模板目录不可用" };
  let base = String(p.name || "").trim();
  if (!base) base = String(obj.title || "").trim();
  base = base
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!base) return { ok: false, error: "给这份标准起个文件名（或填一个 title）" };
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "建模板目录失败：" + String((e && e.message) || e) };
  }
  let name = base;
  let file = path.join(dir, name + ".json");
  for (let i = 2; fs.existsSync(file) && i < 500; i++) {
    name = base + "-" + i;
    file = path.join(dir, name + ".json");
  }
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
  } catch (e) {
    return { ok: false, error: "写模板失败：" + String((e && e.message) || e) };
  }
  return { ok: true, id: "user/" + name, name, path: file, dir };
}

let registered = false;

function registerQaMediaIpc() {
  if (registered) return;
  registered = true;
  ipcMain.handle("qa:probe", (_e, payload) => probeMedia(payload && payload.path));
  ipcMain.handle("qa:frames", (_e, payload) => extractFrames(payload));
  ipcMain.handle("qa:report", (_e, payload) => writeReport(payload));
  ipcMain.handle("qa:frametimes", (_e, payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    return Object.assign({ ok: true }, timePoints(num(p.durationSec), p.count));
  });
  ipcMain.handle("qa:templates", (_e, payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    return listTemplates(p.root);
  });
  ipcMain.handle("qa:template-save", (_e, payload) => saveTemplate(payload));
}

module.exports = {
  registerQaMediaIpc,
  probeMedia,
  extractFrames,
  writeReport,
  timePoints,
  resolveFfmpeg,
  listTemplates,
  templateDirs,
  saveTemplate,
};

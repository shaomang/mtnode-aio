"use strict";
/**
 * Remotion 主进程宿主：
 * - 数据目录 %APPDATA%/pipeline-console/remotion：config.json / installed.json / console.log / ui/
 * - install：选目录 → 复制 remotion-pack → npm install（remotion:progress 进度事件）
 * - status：安装目录 / runtimeReady（node_modules/remotion 存在）/ remotion 版本 / 渲染中
 * - render：写 src/Composition.tsx + src/index.tsx + render.json → spawn `node render.mjs`
 *   （Composition 优先用渲染层下发的 LLM 动效代码 params.tsx，无则回退内置标题卡模板）
 *   并解析其 JSON Lines 进度 → remotion:progress 事件 → 完成返回 { ok, outputPath }
 * - cancel：kill 渲染子进程
 * - removePluginMeta：仅移除数据目录入口（ui 等），保留安装目录
 * - 渲染前取 media-gen-global-lock 全局互斥（与 H3 / Music3 全局唯一音视频任务）
 * 全部参照 h3 模式：ensureUiRuntime 把 ui/ 复制到数据目录，控制台窗用独立 preload。
 */
const {
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  app,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const {
  refreshStaleLock,
  tryAcquireLock,
  clearLock,
  releaseLock,
  busyMessage,
} = require("../media-gen-global-lock.js");

const PLUGIN_ID = "remotion";
/** 宿主生成的入口文件名与 render.json 里的相对路径（必须 .tsx：模板含 JSX） */
const ENTRY_BASENAME = "index.tsx";
const ENTRY_POINT = "src/" + ENTRY_BASENAME;
/** remotion-pack 脚手架体积提示（npm 依赖 + 渲染器，远小于模型后端） */
const DISK_HINT_GB = 8;
/** 渲染最长等待（默认 30 分钟） */
const RENDER_MAX_MS = 30 * 60 * 1000;

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let consoleWin = null;
let installing = false;
let installCancel = false;
/** @type {{ nodeId: string, child: import('child_process').ChildProcess|null, abort?: boolean, pct?: number, outputPath?: string }|null} */
let renderProc = null;

/* ------------------------------------------------------------------ */
/* 路径 / JSON 工具                                                    */
/* ------------------------------------------------------------------ */
function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function remotionRoot() {
  return mk(join(getDataDir(), "remotion"));
}
function configPath() {
  return join(remotionRoot(), "config.json");
}
function installedMetaPath() {
  return join(remotionRoot(), "installed.json");
}
function consoleLogPath() {
  return join(remotionRoot(), "console.log");
}
/** 随包脚手架：打包后取 resourcesPath/remotion-pack，开发时取项目根 remotion-pack */
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "remotion-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "remotion-pack");
}
function uiEntry() {
  const packed = join(remotionRoot(), "ui", "index.html");
  if (fs.existsSync(packed)) return packed;
  return join(__dirname, "ui", "index.html");
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function defaultConfig() {
  return {
    installDir: "",
  };
}
function loadConfig() {
  return Object.assign(defaultConfig(), readJson(configPath(), {}) || {});
}
function saveConfig(partial) {
  const next = Object.assign(loadConfig(), partial || {});
  writeJson(configPath(), next);
  return next;
}

/* ------------------------------------------------------------------ */
/* 日志 / 广播                                                         */
/* ------------------------------------------------------------------ */
function appendConsole(line) {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.appendFileSync(p, String(line).replace(/\r?\n$/, "") + "\n", "utf8");
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) {
      const raw = fs.readFileSync(p, "utf8");
      fs.writeFileSync(p, raw.slice(-1024 * 1024), "utf8");
    }
  } catch {}
  broadcast("remotion:console", { line: String(line) });
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    } catch {}
  }
}

function emitProgress(ev) {
  broadcast("remotion:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
}

function consoleTail(maxBytes) {
  try {
    const p = consoleLogPath();
    if (!fs.existsSync(p)) return { ok: true, text: "" };
    const st = fs.statSync(p);
    const n = Math.min(st.size, Number(maxBytes) || 64 * 1024);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, Math.max(0, st.size - n));
    fs.closeSync(fd);
    return { ok: true, text: buf.toString("utf8") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* 目录安全 / 复制 / 磁盘                                              */
/* ------------------------------------------------------------------ */
function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  const resolved = path.resolve(raw);
  const norm = resolved.replace(/[/\\]+$/, "");
  const rootMatch = /^[a-zA-Z]:\\?$/.test(norm) || norm === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(norm);
  if (rootMatch) return { ok: false, error: "refuse_root" };
  const banned = [
    path.resolve("C:\\Windows"),
    path.resolve("C:\\Program Files"),
    path.resolve("C:\\Program Files (x86)"),
    path.resolve(process.env.SystemRoot || "C:\\Windows"),
  ];
  for (const b of banned) {
    if (norm.toLowerCase() === b.toLowerCase() || norm.toLowerCase().startsWith(b.toLowerCase() + path.sep)) {
      return { ok: false, error: "refuse_system" };
    }
  }
  return { ok: true, path: norm };
}

function freeDiskGb(dir) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== "win32") return resolve(null);
      const drive = path.parse(path.resolve(dir)).root.replace(/\\/g, "");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-PSDrive -Name '${drive.replace(":", "")}').Free / 1GB`],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const n = parseFloat(String(stdout || "").trim());
          resolve(isFinite(n) ? Math.round(n * 10) / 10 : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || ["node_modules", ".git", "out", "output", "__pycache__"]);
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d, skip);
    else {
      mk(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}

function ensureUiRuntime() {
  const srcUi = join(__dirname, "ui");
  const destUi = join(remotionRoot(), "ui");
  if (!fs.existsSync(srcUi)) return;
  copyDirRecursive(srcUi, destUi, []);
}

function uniqueFileInDir(dir, preferredName, defaultExt) {
  mk(dir);
  let name = String(preferredName || "").trim() || "out" + (defaultExt || "");
  const extMatch = name.match(/(\.[a-z0-9]+)$/i);
  const ext = (extMatch && extMatch[1]) || defaultExt || "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  const baseStem = stem || "out";
  if (!extMatch && ext) name = baseStem + ext;
  let dest = join(dir, name);
  if (!fs.existsSync(dest)) return { path: dest, filename: name, renamed: false };
  for (let i = 1; i < 10000; i++) {
    const fn = baseStem + "_" + i + ext;
    dest = join(dir, fn);
    if (!fs.existsSync(dest)) return { path: dest, filename: fn, renamed: true };
  }
  throw new Error("unique_filename_exhausted");
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */
function runtimeReadyAt(dir) {
  const root = String(dir || "").trim();
  if (!root || !fs.existsSync(root)) return false;
  return fs.existsSync(join(root, "node_modules", "remotion", "package.json"));
}

function remotionVersionAt(dir) {
  try {
    const pkg = readJson(join(String(dir || ""), "node_modules", "remotion", "package.json"), null);
    return String((pkg && pkg.version) || "") || "";
  } catch {
    return "";
  }
}

/**
 * npm install 进度解析：npm 不输出百分比，按里程碑推进 + 顺带解析行内 %。
 * 返回累计 pct（15→88 区间由调用方做上下限映射）。
 */
function parseNpmInstallLine(line, cur) {
  const s = String(line || "");
  const pctMatch = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) {
    const n = Number(pctMatch[1]);
    if (isFinite(n)) cur.pct = Math.max(cur.pct, Math.min(88, n));
  }
  if (/^added\s+\d+\s+packages?/i.test(s)) cur.pct = Math.max(cur.pct, 70);
  else if (/^changed\s+\d+\s+packages?/i.test(s)) cur.pct = Math.max(cur.pct, 72);
  else if (/up to date/i.test(s)) cur.pct = Math.max(cur.pct, 85);
  else if (/reify/i.test(s)) cur.pct = Math.max(cur.pct, 35);
  else if (/\badded\s+\d+\s+packages? in\b/i.test(s)) cur.pct = Math.max(cur.pct, 86);
  return s;
}

function runNpmInstall(installDir, nodeId) {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = ["install", "--no-audit", "--no-fund", "--loglevel=info"];
    appendConsole("$ " + npmCmd + " " + args.join(" "));
    /* Windows 的 .cmd 与 POSIX 的 npm shell 脚本都不是 PE/ELF 可执行文件，
       不经 shell 包装 spawn 会报 ERROR_BAD_EXE_FORMAT → spawn EINVAL（errno -4071）。
       因此统一走 shell:true，且拼成单字符串命令（避免 Node≥24 对
       "shell:true + 参数数组" 的 DEP0190 弃用告警）。 */
    const cmdline = [npmCmd, ...args]
      .map((a) => (/\s/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a))
      .join(" ");
    const child = spawn(cmdline, {
      shell: true,
      cwd: installDir,
      windowsHide: true,
      env: Object.assign({}, process.env, { npm_config_progress: "true" }),
    });
    const cur = { pct: 15 };
    let out = "";
    const onData = (d, isErr) => {
      const s = d.toString();
      out += s;
      for (const rawLine of s.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        appendConsole((isErr ? "[err] " : "") + line);
        if (installCancel) return;
        parseNpmInstallLine(line, cur);
        emitProgress({
          phase: "install",
          nodeId,
          step: "npm",
          stepLabel: "安装依赖",
          message: line.slice(0, 120),
          pct: Math.max(15, Math.min(88, cur.pct)),
        });
      }
    };
    child.stdout.on("data", (d) => onData(d, false));
    child.stderr.on("data", (d) => onData(d, true));
    child.on("error", (e) => reject(new Error("npm_spawn: " + String((e && e.message) || e))));
    child.on("close", (code) => {
      if (installCancel) return reject(new Error("cancelled"));
      if (code !== 0) return reject(new Error("npm_exit_" + code + ": " + out.slice(-800)));
      resolve(out);
    });
  });
}

async function installProject(opts) {
  opts = opts || {};
  if (installing) return { ok: false, error: "busy" };
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  installing = true;
  installCancel = false;
  try {
    emitProgress({
      phase: "install",
      step: "disk",
      stepLabel: "检查磁盘空间",
      message: `建议预留 ≥${DISK_HINT_GB}GB`,
      pct: 3,
    });
    const free = await freeDiskGb(installDir);
    if (free != null && free < DISK_HINT_GB && !opts.force) {
      return {
        ok: false,
        error: "low_disk",
        freeGb: free,
        needGb: DISK_HINT_GB,
        message: `磁盘剩余约 ${free}GB，建议预留 ≥${DISK_HINT_GB}GB（remotion 依赖 + 渲染器）`,
      };
    }
    appendConsole(`disk free≈${free}GB (hint ≥${DISK_HINT_GB}GB)`);

    /* 1) 复制 remotion-pack → 安装目录 */
    const pack = bundledPackRoot();
    if (!fs.existsSync(pack)) {
      throw new Error("pack_missing: " + pack);
    }
    emitProgress({
      phase: "install",
      step: "copy",
      stepLabel: "复制脚手架",
      message: "remotion-pack → " + installDir,
      pct: 10,
    });
    appendConsole("[install] copy pack " + pack + " → " + installDir);
    copyDirRecursive(pack, installDir, ["node_modules", ".git", "out", "output"]);
    appendConsole("[install] pack copied");

    /* 2) npm install（进度事件） */
    emitProgress({
      phase: "install",
      step: "npm",
      stepLabel: "安装依赖",
      message: "npm install（remotion / react / @remotion/renderer）…",
      pct: 15,
    });
    await runNpmInstall(installDir, opts.nodeId || "");

    /* 3) 校验 runtimeReady + 版本 */
    emitProgress({
      phase: "install",
      step: "verify",
      stepLabel: "校验运行时",
      message: "检查 node_modules/remotion …",
      pct: 90,
    });
    if (!runtimeReadyAt(installDir)) {
      throw new Error("runtime_missing: node_modules/remotion 未找到（npm install 可能被中断）");
    }
    const version = remotionVersionAt(installDir) || "0.0.0";
    writeJson(installedMetaPath(), {
      ok: true,
      version,
      installDir,
      source: pack,
      installedAt: new Date().toISOString(),
    });
    appendConsole("[install] ok version=" + version + " dir=" + installDir);
    emitProgress({ phase: "install", step: "done", stepLabel: "完成", pct: 100 });
    return { ok: true, installDir, version };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[install] failed: " + msg);
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    return { ok: false, error: msg };
  } finally {
    installing = false;
  }
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
async function statusForUi() {
  const cfg = loadConfig();
  const meta = readJson(installedMetaPath(), null);
  const installDir = cfg.installDir || "";
  const runtimeReady = runtimeReadyAt(installDir);
  const version =
    remotionVersionAt(installDir) || String((meta && meta.version) || "") || "";
  const rendering = !!(renderProc && renderProc.child);
  return {
    ok: true,
    id: PLUGIN_ID,
    installDir,
    installed: !!(meta && meta.ok) || runtimeReady,
    runtimeReady,
    version,
    rendering,
    renderState: renderProc
      ? {
          nodeId: renderProc.nodeId || "",
          pct: Number(renderProc.pct) || 0,
          outputPath: renderProc.outputPath || "",
        }
      : null,
    installing,
    lock: refreshStaleLock(),
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    consolePath: consoleLogPath(),
  };
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/**
 * 渲染模板：src/Composition.tsx（可编辑的通用模板：背景色 + 可选全屏图 + 标题/副标题
 * 淡入动画，帧号驱动）。参数以 CFG 内联 JSON 嵌入，单文件自洽。
 */
function buildCompositionSource(params) {
  const width = Number(params.width) || 1280;
  const height = Number(params.height) || 720;
  const fps = Number(params.fps) || 30;
  const duration = Math.max(1, Math.round(Number(params.durationSeconds) || 5));
  const durationInFrames = Math.max(1, Math.round(duration * fps));
  const cfg = {
    width,
    height,
    fps,
    durationInFrames,
    backgroundColor: params.backgroundColor || "#0f1218",
    title: String(params.title || ""),
    subtitle: String(params.subtitle || ""),
    images: Array.isArray(params.images)
      ? params.images.filter((p) => p && typeof p === "string")
      : params.image
        ? [params.image]
        : [],
    audioPath: params.audioPath || "",
  };
  return `import React from "react";
import {
  AbsoluteFill,
  Img,
  Audio,
  useCurrentFrame,
  interpolate,
  spring,
} from "remotion";

export const CFG: {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  backgroundColor: string;
  title: string;
  subtitle: string;
  images: string[];
  audioPath: string;
} = ${JSON.stringify(cfg, null, 2)};

export const Main: React.FC = () => {
  const frame = useCurrentFrame();
  /* durationInFrames=1 时 inputRange 会退化为 [0,0]，Remotion 校验要求 inputRange 严格递增，
     直接报 "inputRange must be strictly monotonically increasing"，此时跳过淡入恒为 1 */
  const fadeIn =
    CFG.durationInFrames <= 1
      ? 1
      : interpolate(frame, [0, Math.min(20, CFG.durationInFrames - 1)], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  const pop = spring({ frame, fps: CFG.fps, config: { damping: 12 } });
  const bg = CFG.images[0] || "";
  return (
    <AbsoluteFill
      style={{
        width: CFG.width,
        height: CFG.height,
        backgroundColor: CFG.backgroundColor,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, 'Microsoft YaHei', sans-serif",
      }}
    >
      {bg ? (
        <Img
          src={bg}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: fadeIn,
          }}
        />
      ) : null}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          padding: 48,
        }}
      >
        {CFG.title ? (
          <div
            style={{
              color: "#fff",
              fontSize: Math.max(28, Math.round(CFG.width * 0.055)),
              fontWeight: 700,
              transform: \`scale(\${0.92 + pop * 0.08})\`,
              opacity: fadeIn,
              textShadow: "0 4px 24px rgba(0,0,0,.55)",
            }}
          >
            {CFG.title}
          </div>
        ) : null}
        {CFG.subtitle ? (
          <div
            style={{
              color: "rgba(255,255,255,.85)",
              fontSize: Math.max(16, Math.round(CFG.width * 0.024)),
              marginTop: 18,
              opacity: fadeIn,
            }}
          >
            {CFG.subtitle}
          </div>
        ) : null}
      </AbsoluteFill>
      {CFG.audioPath ? <Audio src={CFG.audioPath} /> : null}
    </AbsoluteFill>
  );
};
`;
}

/** 自定义合成的依赖白名单：安装目录只装了 react / remotion，其它包打包必失败 */
const CUSTOM_IMPORT_ALLOWED = /^(?:react|remotion)(?:\/|$)/;

/** 文件内是否声明过该标识名（default 导出别名前的防误判） */
function declaredHere(src, name) {
  const re = new RegExp(
    "^[ \\t]*(?:export[ \\t]+)?(?:const|let|var|function|class)[ \\t]+" + name + "\\b",
    "m",
  );
  return re.test(src);
}

/**
 * 把 remotion 渲染子进程的原始错误翻译成可定位、可行动的中文指引。
 * 主要针对 LLM 动效代码最常见的运行时错误：interpolate 的 inputRange 关键帧数组
 * 出现重复值 / 倒序（如 [220,280,280]），Remotion 校验直接抛错（错误栈 in Array.map）。
 */
function friendlyRenderError(err, usingCustom) {
  const s = String(err || "");
  const m = s.match(
    /inputRange must be strictly monotonically increasing but got \[([^\]]*)\]/,
  );
  if (m) {
    return (
      "动效代码渲染失败：interpolate() 的关键帧数组 inputRange 必须严格递增且元素不重复，" +
      "但收到 [" +
      m[1] +
      "]。\n" +
      "请检查 Main 组件中所有 interpolate(frame, inputRange, ...) 的 inputRange：\n" +
      "· 删掉重复 / 乱序的帧号（如 [220,280,280] 改成 [220,280] 或 [220,280,340]）；\n" +
      "· 在 map / 循环里用 i 计算关键帧时，后一个帧号必须严格大于前一个" +
      "（例如 [140+i*10, 200+i*10, Math.max(280, 220+i*10)] 用 Math.max 兜底，避免 i 增大后与固定帧重复或倒序）；\n" +
      "· 可在节点 💬 会话中把这段报错发给智能体直接修复，或重跑节点重新生成动效代码。"
    );
  }
  return s;
}

/**
 * 规整渲染层下发的 LLM 动效代码（params.tsx / params.prompt）：
 * 返回 { source, error }；source 为空串且 error 为空 = 没有自定义合成，调用方回退内置模板。
 * 契约（见渲染层 remotionTsxPrompt）：导出名为 Main 的组件，且只从 react / remotion 导入。
 * 容错：剥 markdown 围栏；default 导出或唯一大写具名导出自动补 Main 别名。
 * 硬失败（比渲染栈更好定位，直接回到节点 error）：
 *   custom_tsx_bad_import: <模块列表> / custom_tsx_no_main_export
 */
function normalizeCustomComposition(raw) {
  let src = String(raw || "").trim();
  if (!src) return { source: "", error: "" };
  const fence = src.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/);
  if (fence) src = String(fence[1]).trim();
  if (!src) return { source: "", error: "" };

  /* 依赖白名单：静态 import / require() / 动态 import() 全扫（相对路径放行） */
  const specs = [];
  const push = (s) => {
    if (s && specs.indexOf(s) < 0) specs.push(s);
  };
  let m;
  const reStatic = /(?:^|[\s;{}])import\s[^'"`]*?['"]([^'"]+)['"]/g;
  while ((m = reStatic.exec(src))) push(m[1]);
  const reCall = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reCall.exec(src))) push(m[1]);
  const bad = specs.filter(
    (s) => s[0] !== "." && s[0] !== "/" && !CUSTOM_IMPORT_ALLOWED.test(s),
  );
  if (bad.length) return { source: "", error: "custom_tsx_bad_import: " + bad.join(", ") };

  /* 组件注册：入口固定以 id "Main" 引用 ./Composition 的 Main */
  if (/export\s+(?:const|let|var|function|class)\s+Main\b/.test(src)) {
    return { source: src + "\n", error: "" };
  }
  let alias = "";
  const defFn = src.match(/export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  const defCls = src.match(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
  const defId = src.match(/export\s+default\s+([A-Za-z_$][\w$]*)[ \t]*;?[ \t]*(?:\r?\n|$)/);
  if (defCls) alias = defCls[1];
  else if (defFn) alias = defFn[1];
  else if (defId && declaredHere(src, defId[1])) alias = defId[1];
  if (!alias) {
    /* 无 default：唯一的大写具名导出视为组件 */
    const named = [];
    const reNamed = /export\s+(?:const|let|var|function|class)\s+([A-Z][\w$]*)/g;
    while ((m = reNamed.exec(src))) if (named.indexOf(m[1]) < 0) named.push(m[1]);
    if (named.length === 1) alias = named[0];
  }
  if (!alias) return { source: "", error: "custom_tsx_no_main_export" };
  /* 不带类型标注：别名行不依赖 React 是否被 import */
  return { source: src + "\n\nexport const Main = " + alias + ";\n", error: "" };
}

/**
 * 入口模板：注册唯一合成（id "Main"）。
 * 只 import { Main }（不 import CFG）——自定义合成不导出 CFG；
 * 这里的时长/尺寸只是占位，render.json 的同名字段会在 selectComposition 后就地覆盖。
 */
function buildIndexSource(params) {
  params = params || {};
  const width = Number(params.width) || 1280;
  const height = Number(params.height) || 720;
  const fps = Number(params.fps) || 30;
  const duration = Math.max(1, Math.round(Number(params.durationSeconds) || 5));
  const durationInFrames = Math.max(1, duration * fps);
  return `import React from "react";
import { registerRoot, Composition } from "remotion";
import { Main } from "./Composition";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Main"
      component={Main}
      durationInFrames={${durationInFrames}}
      fps={${fps}}
      width={${width}}
      height={${height}}
    />
  );
};

registerRoot(RemotionRoot);
`;
}

/**
 * 写 src/Composition.tsx + src/index.tsx 模板（每次渲染前重写，参数即最新）。
 * Composition 优先采用渲染层下发的 LLM 动效代码（params.tsx / params.prompt），
 * 只有它为空时才回退内置标题卡模板（结构化参数 title / subtitle / bgColor / images / audioPath）。
 * 入口后缀必须是 .tsx：模板含 JSX（<Composition>），esbuild 只在 .tsx/.jsx 中解析 JSX，
 * 写成 .ts 会在打包阶段报 `Expected ">" but found "id"`。
 * @returns {{ custom: boolean, error: string }} error 非空 = 自定义合成不合规（不静默回退，直接失败）
 */
function writeRenderSources(installDir, params) {
  const srcDir = mk(join(installDir, "src"));
  const custom = normalizeCustomComposition(
    String(params.tsx || "").trim() || String(params.prompt || "").trim(),
  );
  if (custom.error) return { custom: false, error: custom.error };
  const usingCustom = !!custom.source;
  fs.writeFileSync(
    join(srcDir, "Composition.tsx"),
    usingCustom ? custom.source : buildCompositionSource(params),
    "utf8",
  );
  fs.writeFileSync(join(srcDir, ENTRY_BASENAME), buildIndexSource(params), "utf8");
  /* 清理历史版本写错后缀的入口，避免旧 render.json 继续引用它 */
  try {
    fs.rmSync(join(srcDir, "index.ts"), { force: true });
  } catch {}
  appendConsole(
    "[render] templates written → " +
      srcDir +
      (usingCustom
        ? " (composition=custom tsx " + custom.source.length + " chars)"
        : " (composition=builtin template)"),
  );
  return { custom: usingCustom, error: "" };
}

/** 输出路径：显式 outputPath > outputDir+filename（自动去重）> 安装目录 out/ 默认名 */
function resolveOutputPath(installDir, params) {
  const ext = ".mp4";
  if (String(params.outputPath || "").trim()) {
    return path.resolve(String(params.outputPath).trim());
  }
  const dir = String(params.outputDir || "").trim()
    ? path.resolve(String(params.outputDir).trim())
    : join(installDir, "out");
  const preferred = String(params.filename || "").trim() || "render" + ext;
  return uniqueFileInDir(dir, preferred, ext).path;
}

/**
 * 解析 render.mjs 的进度输出（JSON Lines 契约，见 remotion-pack/render.mjs）：
 *   {"type":"progress","progress":0.42}     渲染进度 0..1（0.5% 步进节流）
 *   {"type":"done","outputLocation":"..."}  完成，输出绝对路径
 *   {"type":"error","message":"..."}        失败原因（脚本以退出码 1 结束）
 * 另保留 remotion 标准 "Rendered x/y (z%)" 进度行兜底。
 */
function parseRenderProgressLine(line, cur) {
  const s = String(line || "").trim();
  if (s.startsWith("{")) {
    let obj = null;
    try {
      obj = JSON.parse(s);
    } catch {}
    if (obj && typeof obj === "object") {
      if (obj.type === "progress" && typeof obj.progress === "number") {
        cur.pct = Number(obj.progress) * 100;
      } else if (obj.type === "done" && typeof obj.outputLocation === "string") {
        cur.outputPath = obj.outputLocation.trim();
      } else if (obj.type === "error" && typeof obj.message === "string") {
        cur.error = String(obj.message);
      }
    }
  }
  const m2 = s.match(/Rendered\s+(\d+)\s*\/\s*(\d+)\s*\(\s*([\d.]+)%\s*\)/);
  if (m2) cur.pct = Number(m2[3]);
  if (cur.pct != null && isFinite(cur.pct)) {
    cur.pct = Math.max(0, Math.min(100, Number(cur.pct)));
  }
}

/**
 * spawn `node render.mjs`（remotion-pack 内的渲染脚本，契约见 remotion-pack/render.mjs）：
 * - 渲染前按契约写 render.json（脚本只读它，不再使用环境变量）：
 *   entryPoint（宿主生成的 src/index.tsx 入口）/ composition / fps / width / height /
 *   durationInFrames / inputProps{title,subtitle,bgColor,audioPath?} / codec:h264 /
 *   outputLocation=resolveOutputPath 结果（绝对路径）
 * - stdout 逐行 JSON Lines：{"type":"progress","progress":0..1}（渲染进度）、
 *   {"type":"done","outputLocation":"..."}（完成路径）、{"type":"error","message":"..."}（失败）
 * - 退出码 0 = 成功；非 0 = 失败（优先带脚本 error message，尾部日志兜底）
 */
function runRender(installDir, params, nodeId) {
  return new Promise((resolve, reject) => {
    const script = join(installDir, "render.mjs");
    if (!fs.existsSync(script)) {
      return reject(new Error("render_script_missing: " + script + "（remotion-pack 缺少 render.mjs）"));
    }
    const outPath = resolveOutputPath(installDir, params);
    /* ---- 按 remotion-pack/render.mjs 契约写 render.json（render.mjs 默认读 ./render.json） ---- */
    const fps = Number(params.fps) || 30;
    const duration = Math.max(1, Math.round(Number(params.durationSeconds) || 5));
    const renderJson = {
      entryPoint: ENTRY_POINT /* 宿主生成的 index 入口（writeRenderSources 写入 src/index.tsx） */,
      composition: String(params.compositionId || "Main"),
      fps,
      width: Number(params.width) || 1280,
      height: Number(params.height) || 720,
      durationInFrames: Math.max(1, Math.round(duration * fps)),
      inputProps: {
        title: String(params.title || ""),
        subtitle: String(params.subtitle || ""),
        bgColor: String(params.backgroundColor || "#0f1218"),
      },
      codec: "h264",
      outputLocation: outPath,
    };
    if (String(params.audioPath || "").trim()) {
      renderJson.inputProps.audioPath = String(params.audioPath).trim();
    }
    writeJson(join(installDir, "render.json"), renderJson);
    appendConsole(
      "[render] render.json written (composition=" +
        renderJson.composition +
        " entry=" +
        renderJson.entryPoint +
        " output=" +
        outPath +
        ")",
    );
    const child = spawn("node", ["render.mjs"], {
      cwd: installDir,
      windowsHide: true,
    });
    renderProc = { nodeId, child, abort: false, pct: 0, outputPath: "" };
    const cur = { pct: 0, outputPath: "", error: "" };
    let out = "";
    const deadline = Date.now() + RENDER_MAX_MS;

    const onData = (d, isErr) => {
      const s = d.toString();
      out += s;
      for (const rawLine of s.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        appendConsole((isErr ? "[err] " : "") + line);
        parseRenderProgressLine(line, cur);
        if (cur.pct != null && isFinite(cur.pct)) {
          renderProc.pct = cur.pct;
          emitProgress({
            phase: "render",
            nodeId,
            message: "渲染 " + Math.round(cur.pct) + "%",
            pct: Math.max(1, Math.min(95, Math.round(cur.pct * 0.95))),
          });
        }
        if (cur.outputPath) renderProc.outputPath = cur.outputPath;
      }
    };
    child.stdout.on("data", (d) => onData(d, false));
    child.stderr.on("data", (d) => onData(d, true));
    child.on("error", (e) => {
      renderProc = null;
      reject(new Error("render_spawn: " + String((e && e.message) || e)));
    });
    child.on("close", (code) => {
      const proc = renderProc;
      renderProc = null;
      if (proc && proc.abort) return reject(new Error("cancelled"));
      if (code !== 0) {
        return reject(
          new Error("render_exit_" + code + (cur.error ? ": " + cur.error : ": " + out.slice(-1200))),
        );
      }
      const realOut = cur.outputPath || outPath;
      if (!fs.existsSync(realOut)) {
        return reject(new Error("output_missing: " + realOut));
      }
      resolve({ outputPath: realOut });
    });
    /* 超时保护：超时未退出则杀子进程 */
    const timer = setTimeout(() => {
      appendConsole("[render] timeout after " + RENDER_MAX_MS + "ms — killing");
      try {
        if (renderProc && renderProc.child) renderProc.child.kill();
      } catch {}
    }, RENDER_MAX_MS);
    if (timer.unref) timer.unref();
  });
}

function killPidTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      resolve();
    }
  });
}

/**
 * 渲染任务：渲染前取 media-gen-global-lock 全局互斥（与 H3 / Music3 全局唯一音视频任务）。
 * 完成返回 { ok, path, bytes, message }。
 */
async function renderVideo(params) {
  params = params || {};
  const nodeId = String(params.nodeId || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };

  const cfg = loadConfig();
  const installDir = String(cfg.installDir || "").trim();
  if (!installDir || !fs.existsSync(installDir)) return { ok: false, error: "not_installed" };
  if (!runtimeReadyAt(installDir)) return { ok: false, error: "not_ready" };

  const acq = tryAcquireLock({ nodeId, workflowId: params.workflowId || "", kind: "video_gen" });
  if (!acq.ok) {
    const lock = acq.lock;
    appendConsole("[job] busy_other_node: " + (lock && lock.nodeId ? lock.nodeId : ""));
    return { ok: false, error: "busy_other_node", lock, message: busyMessage(lock) };
  }

  let written = null;
  try {
    appendConsole("[job] render start node=" + nodeId);
    emitProgress({ phase: "render", nodeId, message: "准备渲染源文件…", pct: 2 });
    written = writeRenderSources(installDir, params);
    if (written.error) throw new Error(written.error);

    emitProgress({ phase: "render", nodeId, message: "spawn node render.mjs…", pct: 4 });
    const r = await runRender(installDir, params, nodeId);

    const outPath = r.outputPath;
    let sz = 0;
    try {
      sz = fs.statSync(outPath).size || 0;
    } catch {}
    if (sz < 64) throw new Error("output_file_empty_or_too_small: " + outPath);

    clearLock();
    emitProgress({ phase: "render", nodeId, message: "完成", pct: 100, done: true });
    appendConsole("[job] ok path=" + outPath + " bytes=" + sz);
    return { ok: true, path: outPath, outputPath: outPath, bytes: sz, message: "Saved: " + outPath };
  } catch (e) {
    const raw = String((e && e.message) || e);
    /* 渲染子进程的原始错误（如 interpolate inputRange 校验失败）翻译成可定位的中文指引 */
    const err = friendlyRenderError(raw, !!(written && written.custom));
    appendConsole("[job] error: " + err);
    clearLock();
    emitProgress({ phase: "render", nodeId, message: err, error: true, pct: 0 });
    return { ok: false, error: err, message: err };
  }
}

function cancelRender(nodeId) {
  const nid = String(nodeId || "");
  let hitNodeId = "";
  if (renderProc && renderProc.child && (!nid || renderProc.nodeId === nid)) {
    hitNodeId = renderProc.nodeId || "";
    renderProc.abort = true;
    const pid = renderProc.child.pid;
    appendConsole("[cancel] render cancelled node=" + (hitNodeId || "?") + " pid=" + pid);
    try {
      renderProc.child.kill();
    } catch {}
    killPidTree(pid);
    renderProc = null;
  }
  releaseLock(nid || undefined);
  emitProgress({
    phase: "render",
    nodeId: nid || hitNodeId,
    message: "已取消渲染",
    error: true,
    cancelled: true,
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 控制台窗 / 卸载元数据                                                */
/* ------------------------------------------------------------------ */
function openConsoleWindow() {
  ensureUiRuntime();
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    notifyConsoleChanged(true);
    return { ok: true, open: true };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) return { ok: false, error: "ui_missing" };

  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 460,
    height: 600,
    x: Math.min(wa.x + wa.width - 480, wa.x + wa.width - 100),
    y: wa.y + 40,
    frame: true,
    show: true,
    title: "Remotion · 本地渲染",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-remotion.js"),
    },
  });
  consoleWin.loadFile(entry);
  consoleWin.on("closed", () => {
    consoleWin = null;
    notifyConsoleChanged(false);
  });
  notifyConsoleChanged(true);
  return { ok: true, open: true };
}

function closeConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  notifyConsoleChanged(false);
  return { ok: true, open: false };
}

function notifyConsoleChanged(open) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) {
      w.webContents.send("remotion:consoleChanged", { open: !!open });
    }
  } catch {}
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 Remotion 安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  const ready = runtimeReadyAt(safe.path);
  if (ready) {
    writeJson(installedMetaPath(), {
      ok: true,
      version: remotionVersionAt(safe.path) || "0.0.0",
      installDir: safe.path,
      discovered: true,
      installedAt: new Date().toISOString(),
    });
  }
  return { ok: true, installDir: safe.path, runtimeReady: ready };
}

/** removePluginMeta：仅移除数据目录入口（ui / 控制台等），保留安装目录与配置 */
function removePluginMetaOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  try {
    if (renderProc && renderProc.child) {
      renderProc.abort = true;
      try {
        renderProc.child.kill();
      } catch {}
      renderProc = null;
    }
  } catch {}
  const ui = join(remotionRoot(), "ui");
  try {
    if (fs.existsSync(ui)) fs.rmSync(ui, { recursive: true, force: true });
  } catch {}
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

/* ------------------------------------------------------------------ */
/* IPC 注册                                                            */
/* ------------------------------------------------------------------ */
function registerRemotionIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");

  ensureUiRuntime();
  refreshStaleLock();

  ipcMain.handle("remotion:getStatus", async () => statusForUi());
  ipcMain.handle("remotion:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("remotion:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    const ready = runtimeReadyAt(safe.path);
    if (ready) {
      writeJson(installedMetaPath(), {
        ok: true,
        version: remotionVersionAt(safe.path) || "0.0.0",
        installDir: safe.path,
        discovered: true,
        installedAt: new Date().toISOString(),
      });
    }
    return { ok: true, installDir: safe.path, runtimeReady: ready };
  });
  ipcMain.handle("remotion:install", async (e, opts) => installProject(opts || {}));
  ipcMain.handle("remotion:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("remotion:render", async (e, params) => renderVideo(params || {}));
  ipcMain.handle("remotion:cancelRender", async (e, nodeId) => cancelRender(nodeId));
  ipcMain.handle("remotion:getLock", async () => ({ ok: true, lock: refreshStaleLock() }));
  ipcMain.handle("remotion:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("remotion:open", async () => openConsoleWindow());
  ipcMain.handle("remotion:close", async () => closeConsoleWindow());
  ipcMain.handle("remotion:removePluginMeta", async () => removePluginMetaOnly());
  ipcMain.handle("remotion:freeDisk", async () => {
    const cfg = loadConfig();
    const dir = cfg.installDir || app.getPath("home");
    const freeGb = await freeDiskGb(dir);
    return { ok: true, freeGb, needGb: DISK_HINT_GB };
  });
}

/** 应用退出时只关控制台窗；渲染子进程 / 安装目录一律保留（同 h3 服务常驻语义）。 */
function shutdownRemotionUiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
}

module.exports = {
  registerRemotionIpc,
  shutdownRemotionUiOnly,
  statusForUi,
  PLUGIN_ID,
  DISK_HINT_GB,
};

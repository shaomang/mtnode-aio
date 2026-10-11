"use strict";
/**
 * 应用插件目录（右上角「插件」）：
 * 从云端 catalog.json 拉取列表；window 类型可下载 zip 安装，不必升级主程序。
 * 桌宠（pet）仍由主程序实现；讨论区等窗口插件的 UI 从 zip 加载，宿主 IPC 在主程序。
 * 下载 / 校验 / 解压安装 / 更新任一环节失败都上报插件报错总线（见 plugin-error-repair.js），
 * 让非后端类插件的报错也在主窗口弹窗，而不是只藏在卡片进度条里。
 */
const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
/* 插件报错总线：窗口插件没有各自的主进程宿主，失败出口统一往这里报 */
const pluginErrors = require("../plugin-error-repair.js");
/* 安装窗编排（主进程单例）：窗口插件的下载 / 校验 / 解压也进那只窗，逐步骤可见。
   步骤表（prepare / download / verify / extract / done）的真源在 plugins/main-install.js
   的 WINDOW_PLUGIN_MANIFEST，本模块只负责把 appPlugins:progress 翻成步骤事件。 */
const installHost = require("./main-install.js");

const PLUGIN_FEED =
  process.env.MTNODE_PLUGIN_URL || "http://mt-agent.com/mtnode/plugins";
const KNOWN_KINDS = new Set(["builtin", "pet", "window", "music3", "yue2", "sensenova", "h3", "llama", "tts", "breeze", "remotion", "asr"]);
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const MAX_CATALOG = 512 * 1024;
const MAX_ZIP = 80 * 1024 * 1024;

let getDataDir = null;
let getMainWin = null;
let getAppVersion = null;
let appRoot = "";
const pluginWins = new Map();
const wcToPluginId = new WeakMap();
const installing = Object.create(null);
/** pluginId → { ac: AbortController|null, cancelled: bool }：窗口插件 / 桌宠的下载可中断。
 *  这些安装是主进程自建的 HTTP 下载（没有子进程可杀），取消靠 AbortController 掐断连接 +
 *  一个 cancelled 标志在后续每一步之间判「用户已经取消」，不与后端那套 taskkill 混用。 */
const installAbort = Object.create(null);

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function pluginsRoot() {
  return mk(join(getDataDir(), "app-plugins"));
}
function cacheCatalogPath() {
  return join(pluginsRoot(), "catalog.json");
}
function pluginDir(id) {
  return join(pluginsRoot(), String(id));
}

/* ---------------- 插件根目录（唯一真源在 plugins/plugin-root.js） ----------------
   本轮需求：插件界面放一个总的根目录设置（第一次打开时提示设置）；需要目录的插件
   默认用「根目录 + 默认子目录名」，但插件里仍可单独更换安装目录。
   渲染层（renderer/app-plugins.js）与安装窗（plugins/main-install.js）都从这里取口径，
   谁也不许再抄一份子目录名表或自行拼路径。 */
const { createPluginRoot, normDir, subDirNameOf } = require("./plugin-root.js");
let pluginRoot = null;
function initPluginRoot() {
  pluginRoot = createPluginRoot({
    getDataDir: () => (typeof getDataDir === "function" ? getDataDir() : ""),
    /* 应用目录（含 exe 同目录）：根目录命中它就拒收 —— 数据不落应用文件夹 */
    getAppDirs: () => {
      const out = [];
      try {
        if (typeof appRoot === "string" && appRoot) {
          out.push(appRoot);
          out.push(join(appRoot, ".."));
        }
      } catch {}
      try {
        out.push(app.getPath("exe") ? path.dirname(app.getPath("exe")) : "");
      } catch {}
      return out.filter(Boolean);
    },
  });
  return pluginRoot;
}
function pluginRootMod() {
  return pluginRoot || initPluginRoot();
}

/**
 * 某个插件的安装目录（全应用唯一口径）：
 *   ① 插件自己的配置里设过 installDir → 用它（「插件中仍然允许更换安装目录」）；
 *   ② 没设过、且它是「需目录的插件」→ 插件根目录 + 默认子目录名（根目录没设时为空串，
 *      由渲染层去提示设置根目录 —— 见 resolvePluginInstallDir）；
 *   ③ 其余（窗口插件 / 桌宠 / 云端新插件）→ 老口径 <数据目录>/app-plugins/<id>。
 */
function installDirOf(id) {
  const sid = String(id || "");
  if (!sid) return "";
  try {
    const mod = pluginRootMod();
    const own = mod.pluginDir(sid);
    if (own) return own;
    if (mod.needsDir(sid)) return mod.defaultDir(sid) || "";
  } catch {}
  return pluginDir(sid);
}
/**
 * 「这个插件现在该装到哪」——渲染层卡片「安装 / 重装」点下去时问一次。
 * 三种回执：
 *   · { ok:true, dir, source:"plugin" }   插件自己设过目录 → 直接用，不再问根目录
 *   · { ok:true, dir, source:"root" }     用 根目录 + 默认子目录名（本轮共识的默认值）
 *   · { ok:false, error:"need_root" }     需目录的插件而根目录还没设 → 渲染层提示去设置根目录
 * 不必需目录的插件（窗口 / 桌宠）永远走老口径，不会被根目录设置拦住。
 */
function resolvePluginInstallDir(id) {
  const sid = String(id || "");
  if (!sid) return { ok: false, error: "bad_id" };
  const mod = pluginRootMod();
  const subDir = mod.subDir(sid);
  const own = mod.pluginDir(sid);
  /* 默认目录（根目录 + 子目录名）在**主进程**拼（path.join，跨平台分隔符正确）——
     渲染层只显示，不许自己拼路径。 */
  const def = mod.needsDir(sid) ? mod.defaultDir(sid) : "";
  if (own) return { ok: true, dir: own, own, defaultDir: def, source: "plugin", subDir };
  if (!mod.needsDir(sid)) {
    return { ok: true, dir: pluginDir(sid), own: "", defaultDir: "", source: "legacy", subDir: "" };
  }
  if (!def) {
    return {
      ok: false,
      error: "need_root",
      own: "",
      defaultDir: "",
      subDir,
      message: "还没有设置插件根目录：先在插件界面顶部选一个插件根目录。",
    };
  }
  return { ok: true, dir: def, own: "", defaultDir: def, source: "root", subDir };
}

function runtimeDir(id) {
  return join(pluginDir(id), "runtime");
}
function installedMetaPath(id) {
  return join(pluginDir(id), "installed.json");
}
function dataPath(id) {
  return join(pluginDir(id), "data.json");
}
function defaultCatalogPath() {
  return join(__dirname, "catalog.default.json");
}

/* 原生内置窗口插件：不依赖云端目录 / 下载安装，直接以应用内目录为根装载。
   讨论区（forum）＝内置组件，entry 固定 chat.html，窗口参数用内置常量。
   preload 仍统一走 plugins/preload-window.js（forum/preload-forum.js 由 chat.html 侧使用）。 */
const BUILTIN_WINDOW_PLUGINS = {
  forum: {
    dir: () => join(__dirname, "..", "forum"),
    entry: "chat.html",
    title: "MTNode 讨论区",
    window: {
      width: 1040,
      height: 760,
      minWidth: 560,
      minHeight: 460,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
    },
  },
};

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
function rmDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
function copyDirRecursive(src, dest) {
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fetchBuffer(url, onProgress, maxBytes, signal) {
  const cap = maxBytes || MAX_ZIP;
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("https") ? https : http;
    let aborted = false;
    /* 注意：req 还没赋值时不能碰它（取消可能在 lib.get 之前就发生）—— 这里只置标志，
       真正的 destroy 交给 data 回调（它一定在 req 赋值之后才跑）。 */
    const onAbort = () => {
      aborted = true;
      reject(new Error("cancelled"));
    };
    const req = lib.get(
      url,
      {
        headers: { "User-Agent": "MTNodeAIO/1.1-plugins" },
        timeout: 120000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchBuffer(res.headers.location, onProgress, cap, signal).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        const total = Number(res.headers["content-length"]) || 0;
        if (total > cap) {
          res.resume();
          reject(new Error("too_large"));
          return;
        }
        const chunks = [];
        let got = 0;
        res.on("data", (c) => {
          if (aborted || (signal && signal.aborted)) {
            try {
              req.destroy();
            } catch {}
            reject(new Error("cancelled"));
            return;
          }
          got += c.length;
          if (got > cap) {
            req.destroy();
            reject(new Error("too_large"));
            return;
          }
          chunks.push(c);
          if (onProgress) onProgress({ got, total });
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        try {
          req.destroy();
        } catch {}
        reject(new Error("cancelled"));
        return;
      }
      if (typeof signal.addEventListener === "function") {
        signal.addEventListener(
          "abort",
          () => {
            try {
              req.destroy();
            } catch {}
            onAbort();
          },
          { once: true },
        );
      }
    }
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function unzipBuffer(buf, destDir) {
  mk(destDir);
  let o = 0;
  while (o + 4 <= buf.length) {
    const sig = buf.readUInt32LE(o);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(o + 8);
    const compSize = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nameLen).toString("utf8");
    const dataStart = o + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw new Error("zip truncated");
    o = dataEnd;
    if (!name || name.endsWith("/")) continue;
    const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (norm.includes("..")) continue;
    const outPath = join(destDir, ...norm.split("/"));
    mk(path.dirname(outPath));
    const compressed = buf.slice(dataStart, dataEnd);
    let raw;
    if (method === 0) raw = compressed;
    else if (method === 8) raw = zlib.inflateRawSync(compressed);
    else throw new Error("unsupported zip method " + method);
    fs.writeFileSync(outPath, raw);
  }
}

function safeIconName(v) {
  const s = String(v || "").replace(/\\/g, "/").split("/").pop() || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpe?g|webp)$/i.test(s)) return "";
  return s;
}
function iconMime(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}
function iconSearchDirs() {
  const dirs = [join(__dirname, "icons"), join(__dirname, "..", "renderer", "plugin-icons")];
  if (appRoot) {
    dirs.push(join(appRoot, "renderer", "plugin-icons"));
    dirs.push(join(appRoot, "plugins", "icons"));
  }
  return dirs;
}
function pluginIconDataUrl(name) {
  const n = safeIconName(name);
  if (!n) return "";
  const seen = new Set();
  for (const dir of iconSearchDirs()) {
    const p = join(dir, n);
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      if (!buf || !buf.length || buf.length > 2 * 1024 * 1024) continue;
      return "data:" + iconMime(n) + ";base64," + buf.toString("base64");
    } catch {}
  }
  return "";
}

function locObj(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return {
      zh: String(v.zh || v.en || ""),
      en: String(v.en || v.zh || ""),
    };
  }
  const s = String(v || "");
  return { zh: s, en: s };
}

function verParts(s) {
  return String(s || "0")
    .split(/[^\d]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
}
function verCmp(a, b) {
  const pa = verParts(a);
  const pb = verParts(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
function verGte(a, b) {
  return verCmp(a, b) >= 0;
}
function verGt(a, b) {
  return verCmp(a, b) > 0;
}

function appVer() {
  try {
    return String((getAppVersion && getAppVersion()) || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function normalizePlugin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!ID_OK.test(id)) return null;
  if (raw.enabled === false || raw.hidden === true) return null;
  let kind = String(raw.kind || "").trim().toLowerCase();
  if (!kind && raw.handler === "pet") kind = "pet";
  if (!kind && raw.handler === "music3") kind = "music3";
  if (!kind && raw.handler === "yue2") kind = "yue2";
  if (!kind && raw.handler === "sensenova") kind = "sensenova";
  if (!kind && raw.handler === "h3") kind = "h3";
  if (!kind && raw.handler === "llama") kind = "llama";
  if (!kind && raw.handler === "tts") kind = "tts";
  if (!kind && raw.handler === "breeze") kind = "breeze";
  if (!kind && raw.handler === "remotion") kind = "remotion";
  if (!kind && raw.handler === "asr") kind = "asr";
  const iconName = safeIconName(raw.icon) || (id + ".png");
  const known = KNOWN_KINDS.has(kind);
  const win = (raw.window && typeof raw.window === "object") ? raw.window : {};
  const minApp = String(raw.minAppVersion || "").trim();
  const compatible = !minApp || verGte(appVer(), minApp);
  return {
    id,
    kind: known ? kind : "unknown",
    handler: String(raw.handler || (kind === "pet" ? "pet" : kind === "music3" ? "music3" : kind === "yue2" ? "yue2" : kind === "sensenova" ? "sensenova" : kind === "h3" ? "h3" : kind === "llama" ? "llama" : kind === "tts" ? "tts" : kind === "breeze" ? "breeze" : kind === "remotion" ? "remotion" : kind === "asr" ? "asr" : kind === "builtin" ? id : "")).trim(),
    order: Number(raw.order) || 100,
    title: locObj(raw.title || raw.name || id),
    subtitle: locObj(raw.subtitle || raw.description || ""),
    icon: iconName,
    iconDataUrl: pluginIconDataUrl(iconName),
    version: String(raw.version || ""),
    minAppVersion: minApp,
    compatible,
    zipUrl: String(raw.zipUrl || ""),
    sha256: String(raw.sha256 || ""),
    entry: String(raw.entry || "index.html").replace(/\\/g, "/"),
    window: {
      width: Math.max(280, Math.min(1200, Number(win.width) || 380)),
      height: Math.max(320, Math.min(1200, Number(win.height) || 520)),
      frame: win.frame === true,
      transparent: win.transparent !== false,
      alwaysOnTop: win.alwaysOnTop !== false,
      skipTaskbar: win.skipTaskbar !== false,
    },
  };
}

function parseCatalogDoc(doc) {
  const plugins = [];
  const list = doc && Array.isArray(doc.plugins) ? doc.plugins : [];
  for (const raw of list) {
    const p = normalizePlugin(raw);
    if (p) plugins.push(p);
  }
  plugins.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return {
    version: Number(doc && doc.version) || 1,
    updatedAt: String((doc && doc.updatedAt) || ""),
    plugins,
  };
}

function loadDefaultCatalog() {
  return parseCatalogDoc(readJson(defaultCatalogPath(), { plugins: [] }));
}

function listInstalledWindowIds() {
  const out = [];
  try {
    for (const ent of fs.readdirSync(pluginsRoot(), { withFileTypes: true })) {
      if (!ent.isDirectory() || !ID_OK.test(ent.name)) continue;
      if (isWindowInstalled(ent.name)) out.push(ent.name);
    }
  } catch {}
  return out;
}

function isWindowInstalled(id) {
  const meta = readJson(installedMetaPath(id), null);
  if (!meta || !meta.version) return false;
  const entry = String(meta.entry || "index.html");
  return fs.existsSync(join(runtimeDir(id), ...entry.split("/").filter(Boolean)));
}

function installedInfo(id) {
  const meta = readJson(installedMetaPath(id), null) || {};
  return {
    installed: isWindowInstalled(id),
    version: String(meta.version || ""),
    installedAt: Number(meta.installedAt) || 0,
  };
}

function attachInstalled(plugins) {
  const seen = new Set();
  const out = [];
  for (const p of plugins) {
    seen.add(p.id);
    if (p.kind === "window") {
      const st = installedInfo(p.id);
      out.push(Object.assign({}, p, {
        installed: st.installed,
        installedVersion: st.version,
        updateAvailable: !!(st.installed && p.version && verGt(p.version, st.version)),
      }));
    } else if (p.kind === "music3" || p.handler === "music3" || p.kind === "yue2" || p.handler === "yue2" || p.kind === "sensenova" || p.handler === "sensenova" || p.kind === "h3" || p.handler === "h3" || p.kind === "llama" || p.handler === "llama" || p.kind === "tts" || p.handler === "tts" || p.kind === "breeze" || p.handler === "breeze" || p.kind === "remotion" || p.handler === "remotion" || p.kind === "asr" || p.handler === "asr") {
      /* 版本/可更新状态由 music3/yue2/sensenova/h3/llama/tts/breeze/remotion/asr 主进程 status 异步判定；此处仅占位 */
      out.push(Object.assign({}, p, {
        installed: true,
        installedVersion: p.version || "",
        updateAvailable: false,
      }));
    } else {
      out.push(Object.assign({}, p, { installed: p.kind === "builtin", installedVersion: "", updateAvailable: false }));
    }
  }
  for (const id of listInstalledWindowIds()) {
    if (seen.has(id)) continue;
    const st = installedInfo(id);
    out.push({
      id,
      kind: "window",
      handler: "",
      order: 900,
      title: locObj(id),
      subtitle: locObj(""),
      icon: id + ".png",
      iconDataUrl: pluginIconDataUrl(id + ".png"),
      version: st.version,
      minAppVersion: "",
      compatible: true,
      zipUrl: "",
      sha256: "",
      entry: "index.html",
      window: { width: 380, height: 520, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
      installed: true,
      installedVersion: st.version,
      updateAvailable: false,
      retired: true,
    });
  }
  return out;
}

function sendProgress(data) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) w.webContents.send("appPlugins:progress", data);
  } catch {}
  /* 同一份进度也进安装窗（步骤行 + 逐步日志）：卡片 / 控制台状态行仍照旧收 appPlugins:progress */
  try {
    reportInstallProgress(data || {});
  } catch {}
}

/** 把窗口插件的下载 / 校验 / 解压进度翻成安装步骤事件（安装窗的步骤表口径）。 */
function reportInstallProgress(d) {
  const id = String(d.id || "");
  if (!id) return;
  const pct = Math.max(0, Math.min(100, Math.round(Number(d.percent) || 0)));
  const phase = String(d.phase || "");
  const step = (sid, status, message) =>
    installHost.reportPluginStep({
      pluginId: id,
      kind: "step",
      step: Object.assign({ id: sid, status, pct }, message ? { message: String(message).slice(0, 500) } : {}),
    });
  if (phase === "start") {
    step("prepare", "run", d.version ? "目标版本 " + d.version : "");
    return;
  }
  if (phase === "download") {
    if (d.got != null && d.total) {
      step("download", "run", `${Math.round((d.got / d.total) * 100)}%（${fmtMb(d.got)} / ${fmtMb(d.total)}）`);
    } else {
      step("download", "run");
    }
    /* 下载阶段每一步的百分比都当日志行留档（安装窗右侧看得见进度数字） */
    installHost.reportPluginStep({
      pluginId: id,
      kind: "log",
      stepId: "download",
      line: `download ${pct}%` + (d.total ? ` (${fmtMb(d.got)} / ${fmtMb(d.total)})` : ""),
      stream: "host",
    });
    return;
  }
  if (phase === "extract") {
    step("download", "ok");
    step("verify", "ok");
    step("extract", "run");
    return;
  }
  if (phase === "done") {
    step("extract", "ok");
    step("done", "ok");
    installHost.finishPluginInstall({ id, ok: true });
    return;
  }
  if (phase === "error") {
    const msg = String(d.error || "install failed");
    /* 停在哪一步：能认出来的（sha256_mismatch / pack_missing_entry / HTTP xxx）停在对应步 */
    const sid = /sha256/i.test(msg)
      ? "verify"
      : /pack_missing|entry/i.test(msg)
        ? "extract"
        : /^HTTP|timeout|ECONN|ENOTFOUND|EAI|too_large|bad_zip_url|need_app_update|not_window_plugin/i.test(msg)
          ? "download"
          : "download";
    step(sid, "fail", msg);
    installHost.finishPluginInstall({
      id,
      ok: false,
      error: msg,
      hint: installFailHint(msg) || "看这一步的日志；重下一次仍失败就把日志交给会话修复。",
    });
  }
}

function fmtMb(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return "0MB";
  return (n / (1024 * 1024)).toFixed(1) + "MB";
}

function catalogUrl() {
  return PLUGIN_FEED.replace(/\/$/, "") + "/catalog.json";
}

function resolveZipUrl(zipUrl) {
  let u = String(zipUrl || "").trim();
  if (!u) return "";
  if (u.startsWith("/")) return PLUGIN_FEED.replace(/\/$/, "") + u;
  if (!/^https?:\/\//i.test(u)) {
    return PLUGIN_FEED.replace(/\/$/, "") + "/" + u.replace(/^\.\//, "");
  }
  try {
    const feed = new URL(PLUGIN_FEED);
    const zip = new URL(u);
    if (zip.protocol !== "http:" && zip.protocol !== "https:") return "";
    if (zip.hostname.toLowerCase() !== feed.hostname.toLowerCase()) return "";
    return zip.toString();
  } catch {
    return "";
  }
}

function safeEntry(entry) {
  const e = String(entry || "index.html").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!e || e.includes("..") || e.includes(":")) return "";
  if (!/\.html?$/i.test(e)) return "";
  return e;
}

async function fetchRemoteCatalog() {
  const buf = await fetchBuffer(catalogUrl(), null, MAX_CATALOG);
  const doc = JSON.parse(buf.toString("utf8"));
  const parsed = parseCatalogDoc(doc);
  if (!parsed.plugins.length && !(doc && Array.isArray(doc.plugins))) {
    throw new Error("bad_catalog");
  }
  writeJson(cacheCatalogPath(), {
    fetchedAt: Date.now(),
    sourceUrl: catalogUrl(),
    doc,
  });
  return parsed;
}

async function loadCatalog() {
  const fallback = loadDefaultCatalog();
  function mergeLocalOnly(plugins) {
    const list = Array.isArray(plugins) ? plugins.slice() : [];
    const have = new Set(list.map((p) => p && p.id).filter(Boolean));
    for (const p of fallback.plugins || []) {
      if (!p || !p.id || have.has(p.id)) continue;
      // Keep built-in handlers (pet/music3) visible even if remote catalog omits them
      if (p.kind === "music3" || p.handler === "music3" || p.kind === "yue2" || p.handler === "yue2" || p.kind === "sensenova" || p.handler === "sensenova" || p.kind === "h3" || p.handler === "h3" || p.kind === "llama" || p.handler === "llama" || p.kind === "tts" || p.handler === "tts" || p.kind === "breeze" || p.handler === "breeze" || p.kind === "remotion" || p.handler === "remotion" || p.kind === "asr" || p.handler === "asr" || p.kind === "pet" || p.handler === "pet") {
        list.push(p);
        have.add(p.id);
      }
    }
    return list;
  }
  try {
    const remote = await fetchRemoteCatalog();
    return {
      ok: true,
      source: "remote",
      fetchedAt: Date.now(),
      plugins: attachInstalled(mergeLocalOnly(remote.plugins)),
      appVersion: appVer(),
    };
  } catch (remoteErr) {
    const cached = readJson(cacheCatalogPath(), null);
    if (cached && cached.doc) {
      const parsed = parseCatalogDoc(cached.doc);
      return {
        ok: true,
        source: "cache",
        fetchedAt: Number(cached.fetchedAt) || 0,
        plugins: attachInstalled(mergeLocalOnly(parsed.plugins)),
        appVersion: appVer(),
        remoteError: String((remoteErr && remoteErr.message) || remoteErr),
      };
    }
    return {
      ok: true,
      source: "fallback",
      fetchedAt: 0,
      plugins: attachInstalled(fallback.plugins),
      appVersion: appVer(),
      remoteError: String((remoteErr && remoteErr.message) || remoteErr),
    };
  }
}

function findCatalogPlugin(id) {
  const cached = readJson(cacheCatalogPath(), null);
  const docs = [];
  if (cached && cached.doc) docs.push(cached.doc);
  docs.push(readJson(defaultCatalogPath(), { plugins: [] }));
  for (const doc of docs) {
    const parsed = parseCatalogDoc(doc);
    const hit = parsed.plugins.find((p) => p.id === id);
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 报错总线：窗口插件的安装链也弹窗                                     */
/* ------------------------------------------------------------------ */

/** 插件中文名（报告标题用）：优先云端 / 内置目录里的 title，取不到就用 id。 */
function pluginDisplayName(id) {
  const sid = String(id || "");
  try {
    const spec = findCatalogPlugin(sid);
    const t = spec && spec.title;
    const name = String((t && (t.zh || t.en)) || "").trim();
    if (name) return name;
  } catch {}
  return sid;
}

/**
 * 按需登记宿主：窗口插件（kind:window）没有自己的主进程模块，启动期不会注册进总线，
 * 只有真失败过一次才登记。现场 = 该插件在 %APPDATA% 下的安装目录（= 修复会话的可写工作区）；
 * 这类插件没有 console.log，所以**不注册 tailConsole** —— 报告里 logTail 为空，但报告照发。
 * 同名 id 已被后端宿主占用时（catalog 里 remotion / minimax-h3 这类）一律不覆盖，沿用其现场入口。
 */
function ensureReportHost(id) {
  const sid = String(id || "");
  if (!sid) return;
  try {
    if (pluginErrors.getPluginHost(sid)) return;
    pluginErrors.registerPluginHost({
      id: sid,
      name: pluginDisplayName(sid),
      skillName: "",
      getInstallDir: () => installDirOf(sid),
    });
  } catch {}
}

/** 错误码 → 一眼看懂是哪一步炸的（认不出的码只带原文，不编造结论）。 */
function installFailHint(code) {
  const s = String(code || "");
  if (/^sha256_mismatch/.test(s)) return "安装包校验失败（sha256 与云端目录声明不一致）";
  if (/^HTTP\s?\d+/.test(s)) return "下载安装包失败（服务端返回 " + s.replace(/^HTTP\s?/, "") + "）";
  if (/^timeout/.test(s)) return "下载安装包超时";
  if (/^too_large/.test(s)) return "安装包超过允许体积上限";
  if (/^ECONN|^ENOTFOUND|^EAI|^EHOST|^ERR_/.test(s)) return "连接插件下载源失败（" + s + "）";
  if (/^bad_zip_url/.test(s)) return "云端目录里该插件的下载地址不合法（只允许同源 http/https）";
  if (/^not_window_plugin/.test(s)) return "云端目录里找不到这个可下载的窗口插件";
  if (/^need_app_update/.test(s)) return "该插件要求的 MTNode 版本高于当前版本";
  if (/^pack_missing_entry/.test(s)) return "安装包解压后缺少入口 HTML（云端包结构不对）";
  if (/zip truncated|unsupported zip method/.test(s)) return "安装包损坏或压缩方式不受支持";
  if (/^bad_id/.test(s)) return "插件 id 不合法";
  if (/^EACCES|^EPERM|^ENOENT|^ENOSPC/.test(s)) return "写入插件目录失败（" + s + "）";
  return "";
}

/**
 * 失败上报：总线内部吞异常，这里再包一层 —— 安装链绝不能被报告拖住。
 * extra: { phase: "install" | "update" }
 */
function reportErr(id, code, message, extra) {
  const sid = String(id || "");
  if (!sid) return;
  try {
    ensureReportHost(sid);
    pluginErrors.reportPluginError(
      sid,
      Object.assign({ code: String(code || ""), message: String(message || "") }, extra || {}),
    );
  } catch {}
}

/**
 * 取消窗口插件的下载 / 安装：掐断正在下载的 HTTP 连接（AbortController），
 * 后续每一步之间的 `throwIfCancelled` 也会立刻收手 —— 主进程自建下载没有子进程可杀。
 * 真正的终局（state=cancelled）由 catch 分支统一落（含清掉 _extract_tmp）。
 */
function cancelWindowPluginInstall(id) {
  const sid = String(id || "");
  if (!sid) return { ok: false, error: "bad_id" };
  const job = installAbort[sid];
  if (!job) return { ok: true, noop: true, id: sid };
  job.cancelled = true;
  try {
    if (job.ac) job.ac.abort();
  } catch {}
  return { ok: true, id: sid, cancelled: true };
}

async function installWindowPlugin(id) {
  if (!ID_OK.test(id)) return { ok: false, error: "bad_id" };
  if (installing[id]) {
    reportErr(id, "busy", pluginDisplayName(id) + " 已有下载 / 安装任务在跑，本次被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  installing[id] = true;
  /* 已经装过再点一次就是「更新」：报告按实际动作分类，用户看到的是「更新失败」而不是「安装失败」 */
  const ctx = { phase: isWindowInstalled(id) ? "update" : "install" };
  /* 安装窗：开一次会话（步骤表由 plugins/main-install.js 的兜底表给出 —— 窗口插件没有 steps.json）。
     目录走统一口径（窗口插件回落 <数据目录>/app-plugins/<id>，后端插件走根目录 + 子目录名） */
  installHost.beginPluginInstall({ id, action: ctx.phase, installDir: installDirOf(id) });
  /* 本次下载的取消句柄：安装窗点「取消安装」→ cancelWindowPluginInstall */
  const job = { ac: typeof AbortController === "function" ? new AbortController() : null, cancelled: false };
  installAbort[id] = job;
  const throwIfCancelled = () => {
    if (job.cancelled) throw new Error("cancelled");
  };
  sendProgress({ id, phase: "start", percent: 0 });
  try {
    let spec = findCatalogPlugin(id);
    if (!spec || spec.kind !== "window") {
      const cat = await loadCatalog();
      spec = (cat.plugins || []).find((p) => p.id === id);
    }
    if (spec && spec.kind === "window" && !spec.zipUrl) {
      const def = (loadDefaultCatalog().plugins || []).find((p) => p.id === id);
      if (def && def.zipUrl) {
        spec = Object.assign({}, spec, {
          zipUrl: def.zipUrl,
          version: spec.version || def.version,
          entry: spec.entry || def.entry,
          sha256: spec.sha256 || def.sha256,
          window: spec.window || def.window,
        });
      }
    }
    if (!spec || spec.kind !== "window") throw new Error("not_window_plugin");
    if (!spec.compatible) throw new Error("need_app_update");
    const zipUrl = resolveZipUrl(spec.zipUrl);
    if (!zipUrl) throw new Error("bad_zip_url");
    throwIfCancelled();
    sendProgress({ id, phase: "download", percent: 5, version: spec.version });
    const zipBuf = await fetchBuffer(
      zipUrl,
      ({ got, total }) => {
        const pct = total ? Math.min(90, 5 + Math.floor((got / total) * 85)) : 40;
        sendProgress({ id, phase: "download", percent: pct, got, total, version: spec.version });
      },
      null,
      job.ac ? job.ac.signal : null,
    );
    throwIfCancelled();
    if (spec.sha256) {
      const h = sha256(zipBuf);
      if (h.toLowerCase() !== String(spec.sha256).toLowerCase()) throw new Error("sha256_mismatch");
    }
    sendProgress({ id, phase: "extract", percent: 92 });
    const tmp = join(pluginDir(id), "_extract_tmp");
    rmDirRecursive(tmp);
    mk(tmp);
    try {
      unzipBuffer(zipBuf, tmp);
    } catch (e) {
      /* 解压中途的异常（含取消）也要把临时目录收干净，别把半份 runtime 留在盘上 */
      rmDirRecursive(tmp);
      throw e;
    }
    throwIfCancelled();
    let srcDir = tmp;
    const ents = fs.readdirSync(tmp);
    const entry = safeEntry(spec.entry) || "index.html";
    if (ents.length === 1) {
      const only = join(tmp, ents[0]);
      if (fs.statSync(only).isDirectory() && fs.existsSync(join(only, ...entry.split("/")))) {
        srcDir = only;
      }
    }
    if (!fs.existsSync(join(srcDir, ...entry.split("/")))) throw new Error("pack_missing_entry");
    closePluginWindow(id);
    rmDirRecursive(runtimeDir(id));
    copyDirRecursive(srcDir, runtimeDir(id));
    rmDirRecursive(tmp);
    writeJson(installedMetaPath(id), {
      version: spec.version || "0.0.0",
      entry,
      source: zipUrl,
      installedAt: Date.now(),
    });
    sendProgress({ id, phase: "done", percent: 100, version: spec.version });
    installing[id] = false;
    delete installAbort[id];
    return { ok: true, version: spec.version || "0.0.0" };
  } catch (err) {
    installing[id] = false;
    delete installAbort[id];
    const msg = String((err && err.message) || err);
    /* 用户主动取消：落成「已取消」终局（不弹报错报告窗），并把半份解压目录清掉 */
    if (job.cancelled || msg === "cancelled") {
      rmDirRecursive(join(pluginDir(id), "_extract_tmp"));
      sendProgress({ id, phase: "cancel", percent: 0, error: "cancelled" });
      installHost.finishPluginInstall({
        id,
        ok: false,
        cancelled: true,
        error: "cancelled",
        hint: "",
      });
      return { ok: false, cancelled: true, error: "cancelled" };
    }
    const hint = installFailHint(msg);
    /* 进度与返回值都保持原错误码原文：渲染层 pluginErrText 按整串精确匹配出中文文案 */
    sendProgress({ id, phase: "error", percent: 0, error: msg });
    /* 下载 / 校验 / 解压 / 写元数据任一环节炸了都上报：主窗口弹报告（现场 = 该插件安装目录）。
       code 传原文，由总线自己认码（sha256_mismatch / HTTP 404 / not_window_plugin …），
       message 里再补一句是哪一步 —— 认不出来的码只带原文，不编造结论。 */
    reportErr(
      id,
      msg,
      pluginDisplayName(id) +
        (ctx.phase === "update" ? " 更新失败：" : " 安装失败：") +
        (hint ? hint + "：" : "") +
        msg,
      ctx,
    );
    return { ok: false, error: msg };
  }
}

function uninstallWindowPlugin(id) {
  if (!ID_OK.test(id)) return { ok: false, error: "bad_id" };
  closePluginWindow(id);
  rmDirRecursive(pluginDir(id));
  return { ok: true };
}

function pluginRightBounds(w, h) {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  return {
    width: w,
    height: h,
    x: Math.max(wa.x, wa.x + wa.width - w - 16),
    y: Math.max(wa.y, wa.y + Math.round((wa.height - h) / 2)),
  };
}

function closePluginWindow(id) {
  const w = pluginWins.get(id);
  if (w && !w.isDestroyed()) {
    try { w.close(); } catch {}
  }
  pluginWins.delete(id);
}

function isPluginWindowOpen(id) {
  const w = pluginWins.get(id);
  return !!(w && !w.isDestroyed());
}

function notifyPluginWindowChanged(id, open) {
  try {
    const mw = getMainWin && getMainWin();
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send("appPlugins:windowChanged", { id: String(id || ""), open: !!open });
    }
  } catch {}
}

function notifyPluginShown(id) {
  const w = pluginWins.get(id);
  if (!w || w.isDestroyed()) return;
  try {
    w.webContents.send("plugin:shown");
  } catch {}
}

function showPluginWindowSafe(id) {
  const w = pluginWins.get(id);
  if (!w || w.isDestroyed()) return;
  try {
    w.show();
    w.focus();
    w.moveTop();
  } catch {}
  notifyPluginShown(id);
}

function pluginIdOfSender(e) {
  return wcToPluginId.get(e.sender) || "";
}

function openWindowPlugin(id) {
  if (!getDataDir) return { ok: false, error: "not_ready" };
  if (!ID_OK.test(id)) return { ok: false, error: "bad_id" };
  const existing = pluginWins.get(id);
  if (existing && !existing.isDestroyed()) {
    showPluginWindowSafe(id);
    notifyPluginWindowChanged(id, true);
    return { ok: true, open: true };
  }
  const builtin = BUILTIN_WINDOW_PLUGINS[id];
  let html = "";
  let winSpec = null;
  let winTitle = id;
  if (builtin) {
    /* 内置组件：以应用内目录为根，无需 installedMetaPath；缺文件时返回明确错误 */
    const entry = safeEntry(builtin.entry) || "chat.html";
    html = join(builtin.dir(), ...entry.split("/"));
    if (!fs.existsSync(html)) return { ok: false, error: "builtin_missing" };
    winSpec = builtin.window;
    winTitle = builtin.title || id;
  } else {
    const meta = readJson(installedMetaPath(id), null);
    if (!meta) return { ok: false, error: "not_installed" };
    const entry = safeEntry(meta.entry || "index.html");
    if (!entry) return { ok: false, error: "bad_entry" };
    html = join(runtimeDir(id), ...entry.split("/"));
    if (!fs.existsSync(html)) return { ok: false, error: "missing_entry" };
    const spec = findCatalogPlugin(id);
    winSpec = (spec && spec.window) || {
      width: 380,
      height: 520,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
    };
    winTitle = (spec && spec.title && spec.title.zh) || id;
  }
  const pos = pluginRightBounds(winSpec.width, winSpec.height);
  const w = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    minWidth: Number(winSpec.minWidth) > 0 ? Number(winSpec.minWidth) : 280,
    minHeight: Number(winSpec.minHeight) > 0 ? Number(winSpec.minHeight) : 320,
    frame: !!winSpec.frame,
    transparent: !!winSpec.transparent,
    backgroundColor: winSpec.transparent ? "#00000000" : "#0d1016",
    hasShadow: true,
    alwaysOnTop: !!winSpec.alwaysOnTop,
    skipTaskbar: !!winSpec.skipTaskbar,
    resizable: true,
    show: false,
    title: winTitle,
    webPreferences: {
      preload: join(__dirname, "preload-window.js"),
      additionalArguments: ["--mtnode-plugin-id=" + id],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  w.setMenu(null);
  if (winSpec.alwaysOnTop) {
    try { w.setAlwaysOnTop(true, "screen-saver"); } catch {}
  }
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(String(url || ""))) {
      try { shell.openExternal(String(url)); } catch {}
    }
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (ev, url) => {
    if (url && url !== w.getURL()) ev.preventDefault();
  });
  wcToPluginId.set(w.webContents, id);
  pluginWins.set(id, w);
  w.loadFile(html);
  w.once("ready-to-show", () => showPluginWindowSafe(id));
  w.webContents.once("did-finish-load", () => {
    setTimeout(() => showPluginWindowSafe(id), 30);
  });
  w.on("closed", () => {
    pluginWins.delete(id);
    notifyPluginWindowChanged(id, false);
  });
  notifyPluginWindowChanged(id, true);
  return { ok: true, open: true };
}

function closeSenderWindow(e) {
  const id = pluginIdOfSender(e);
  if (id) closePluginWindow(id);
  else {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.close();
  }
  return { ok: true };
}

function shutdownAppPlugins() {
  for (const id of [...pluginWins.keys()]) closePluginWindow(id);
}

function registerAppPluginsIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  getAppVersion = opts.getAppVersion;
  appRoot = String((opts && opts.appRoot) || "");
  ipcMain.handle("appPlugins:catalog", () => loadCatalog());
  ipcMain.handle("appPlugins:icon", (e, name) => {
    const dataUrl = pluginIconDataUrl(name);
    return dataUrl ? { ok: true, dataUrl } : { ok: false };
  });
  ipcMain.handle("appPlugins:install", (e, id) => installWindowPlugin(String(id || "")));
  /* 安装窗「取消安装」对窗口插件走这条（id 来自云端目录，逐个 registerInstallTarget 登记不了） */
  ipcMain.handle("appPlugins:cancelInstall", (e, id) => cancelWindowPluginInstall(String(id || "")));
  installHost.registerCancelFallback((id) => cancelWindowPluginInstall(String(id || "")));
  ipcMain.handle("appPlugins:uninstall", (e, id) => uninstallWindowPlugin(String(id || "")));
  ipcMain.handle("appPlugins:open", (e, id) => openWindowPlugin(String(id || "")));
  ipcMain.handle("appPlugins:close", (e) => closeSenderWindow(e));
  ipcMain.handle("appPlugins:closeById", (e, id) => {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return { ok: false, error: "bad_id" };
    closePluginWindow(sid);
    notifyPluginWindowChanged(sid, false);
    return { ok: true, open: false };
  });
  ipcMain.handle("appPlugins:isOpen", (e, id) => {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return { ok: false, open: false, error: "bad_id" };
    return { ok: true, open: isPluginWindowOpen(sid) };
  });
  ipcMain.handle("appPlugins:dataGet", (e) => {
    const id = pluginIdOfSender(e);
    if (!id) return { ok: false, error: "no_plugin" };
    return { ok: true, data: readJson(dataPath(id), {}) || {} };
  });
  ipcMain.handle("appPlugins:dataSet", (e, data) => {
    const id = pluginIdOfSender(e);
    if (!id) return { ok: false, error: "no_plugin" };
    writeJson(dataPath(id), data && typeof data === "object" ? data : {});
    return { ok: true };
  });

  /* ── 插件根目录（本轮需求：总的根目录 + 首次打开提示设置）──────────────────
     真源在 plugins/plugin-root.js：值存 <数据目录>/config.json 的 plugins.installDir，
     推断值（按已设 installDir 的插件的公共父目录）**只预填不写盘**，用户点确认才落。
     桥：RootStatus / RootSet / RootPick / RootOpen / InstallDirOfPlugin。
     渲染层只负责画，不许自己拼「根目录 + 子目录名」。 */
  initPluginRoot();
  const asText = (s) => String(s == null ? "" : s);
  ipcMain.handle("appPlugins:rootStatus", () => {
    try {
      return pluginRootMod().status();
    } catch (e) {
      return { ok: false, error: asText((e && e.message) || e) };
    }
  });
  ipcMain.handle("appPlugins:rootSet", (e, dir) => rootSetImpl(asText(dir)));
  ipcMain.handle("appPlugins:rootPick", () => {
    const mod = pluginRootMod();
    const cur = mod.get();
    const inf = mod.status().inferred;
    let picked = [];
    try {
      picked =
        dialog.showOpenDialogSync(getMainWin && getMainWin(), {
          title: "选择插件根目录（所有需要目录的插件默认装到它下面的子目录）",
          properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
          defaultPath: cur || inf || undefined,
        }) || [];
    } catch (err) {
      return { ok: false, error: asText((err && err.message) || err) };
    }
    if (!picked.length) return { ok: false, cancelled: true };
    return rootSetImpl(picked[0]);
  });
  ipcMain.handle("appPlugins:rootOpen", () => {
    const mod = pluginRootMod();
    const dir = mod.get() || mod.status().inferred;
    if (!dir) return { ok: false, error: "no_root" };
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    try {
      shell.openPath(dir);
      return { ok: true, dir };
    } catch (err) {
      return { ok: false, error: asText((err && err.message) || err) };
    }
  });
  /* 详情面板「打开目录」：把某个插件的安装目录在文件管理器里打开（不存在就建出来）。
     只服务插件目录这一件事 —— 只接受绝对路径，盘符根一律拒绝，不做通用「打开任意路径」。 */
  ipcMain.handle("appPlugins:openPath", (e, dir) => {
    const n = normDir(asText(dir));
    if (!n) return { ok: false, error: "bad_path" };
    if (/^[a-zA-Z]:\\?$/.test(n) || n === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(n)) {
      return { ok: false, error: "refuse_root" };
    }
    try {
      fs.mkdirSync(n, { recursive: true });
    } catch {}
    try {
      shell.openPath(n);
      return { ok: true, dir: n };
    } catch (err) {
      return { ok: false, error: asText((err && err.message) || err) };
    }
  });
  /* 卡片「安装 / 重装」先问这里：拿该插件这次该用的目录；需目录而根目录没设 → need_root */
  ipcMain.handle("appPlugins:installDirOfPlugin", (e, id) => resolvePluginInstallDir(id));
  /* 插件自己的安装目录：读现状 / 写回（「恢复默认」= default:true → 改写成根目录+子目录名） */
  ipcMain.handle("appPlugins:pluginInstallDir", (e, payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    const id = String(p.id || "");
    const mod = pluginRootMod();
    const own = mod.pluginDir(id);
    if (!p || p.default !== true) return { ok: true, id, installDir: own, isDefault: false };
    if (!mod.needsDir(id)) return { ok: false, error: "not_dir_plugin" };
    const dir = mod.defaultDir(id);
    if (!dir) return { ok: false, error: "need_root", message: "还没有设置插件根目录。" };
    const w = mod.writePluginDir(dataDirImpl(), id, dir);
    if (!w.ok) return Object.assign({ ok: false, id }, w);
    return { ok: true, id, installDir: dir, isDefault: true };
  });
}

/** 写插件根目录（rootSet 与 rootPick 共用一份口径）。 */
function rootSetImpl(dir) {
  const mod = pluginRootMod();
  const r = mod.set(String(dir || ""));
  if (!r.ok) {
    const why = {
      empty_dir: "目录为空",
      refuse_root: "不能把插件根目录设成盘符根目录（如 E:\\）—— 请选一个专门放插件的文件夹",
      refuse_app_dir: "插件根目录不能落在应用目录里（升级 / 卸载会带走）—— 请另选一个文件夹",
      refuse_data_dir: "插件根目录不能落在数据目录里 —— 请另选一个文件夹",
    };
    r.message = why[r.error] || r.error;
  }
  return r;
}
/** 数据目录（IPC 归一回调与模块内共用）：registerAppPluginsIpc 时已注入 getDataDir。 */
function dataDirImpl() {
  try {
    return typeof getDataDir === "function" ? String(getDataDir() || "") : "";
  } catch {
    return "";
  }
}

module.exports = {
  registerAppPluginsIpc,
  shutdownAppPlugins,
  openWindowPlugin,
  closePluginWindow,
  isPluginWindowOpen,
  installWindowPlugin,
  cancelWindowPluginInstall,
  /* 安装目录口径（渲染层卡片 / 安装窗 / 权重指路共用）：插件自己的目录优先，
     没设过就用「插件根目录 + 默认子目录名」—— 见 plugins/plugin-root.js */
  installDirOf,
  resolvePluginInstallDir,
};

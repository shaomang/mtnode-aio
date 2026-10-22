"use strict";
/**
 * Blender 本地插件 · 主进程宿主（应用插件 kind = blender，id = blender-local）
 *
 * ── 它解决什么 ───────────────────────────────────────────────────────────
 * 让 MTNode 的 Agent 能真正操作 Blender：装一份**官方** Blender（便携 zip，最新稳定版），
 * 装社区事实标准 MCP 服务端 `mcp-for-blender`（原 blender-mcp）与它的 Blender addon，
 * 把该 MCP 服务器写进 dsh 的 cordis-user.yml —— 之后 Agent 会话里就多出 blender 工具。
 * 装完还会真跑一次端到端冒烟（启 Blender → addon 起 socket → MCP 握手），
 * 只有这一步过了才算「装好了」。
 *
 * ── 硬口径（都在代码里落实，改前先看这里）────────────────────────────────
 *   · Blender 只从**官方** download.blender.org 下：先解析目录取最新稳定版（当前 5.2.x），
 *     拉不到版本号才回退到内置清单（KNOWN_VERSIONS），并在界面明示「非实时最新」。
 *     安装包必须过 sha256 校验，支持断点续传 + 重试。
 *   · 便携 zip 解压到**用户在插件根目录下选定的目录**（默认 <插件根目录>/blender），
 *     不写注册表、不要管理员；卸载时按共识把这份安装目录一并删掉（先弹确认，见 UI）。
 *   · **已装就跳过，不自动升级**：装过就只做 status / 冒烟，不静默拉新版。
 *   · MCP 走 `uvx mcp-for-blender`；uv 先复用本机已装的，缺了跑官方 install.ps1
 *     （失败再回退到官方 GitHub release 的 uv zip，sha256 校验后解到插件目录）。
 *   · addon 写进**用户默认 Blender 配置**（%APPDATA%\Blender Foundation\Blender\<ver>\scripts\addons），
 *     改 userpref 前先备份到 <数据目录>/blender-backup/（卸载不删这份备份）。
 *   · 端口 9876 被占就在 9876–9886 里挑一个空闲的，同步写进 MCP 行的 --port；
 *     启动 Blender 时用 --python-expr 把同一个端口写进 scene.blendermcp_port。
 *   · 启停口径：只关**插件自己拉起的** Blender（进程树按 PID 收），用户手开的实例只检测不杀。
 *   · 失败一律走 plugin-error-repair 的报错总线（弹窗 +「自动修复」开会话），
 *     技能真源 skills/blender-local-install/SKILL.md。
 *   · 数据只写 %APPDATA%\pipeline-console（配置 / 日志 / 备份）与用户选定的安装目录。
 */

const { BrowserWindow, ipcMain, dialog, screen, app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");

const pluginErrors = require("../plugin-error-repair.js");
const installHost = require("../plugins/main-install.js");
const installKill = require("../plugins/install-cancel.js");
const { registerPluginSelfcheck } = require("../plugins/plugin-selfcheck.js");

const PLUGIN_ID = "blender-local";
const PLUGIN_NAME = "Blender 本地插件";
const API = "blender";
const SKILL_NAME = "blender-local-install";
const MCP_PKG = "@deepseek-ai/dsh-mcp-client";
const MCP_ID = "blender-local-mcp-blender";
const MCP_SERVER_NAME = "blender";
const RELEASE_INDEX = "https://download.blender.org/release/";
const UV_INSTALL_PS1 = "https://astral.sh/uv/install.ps1";
const UV_RELEASE_API = "https://api.github.com/repos/astral-sh/uv/releases/latest";
const PORT_BASE = 9876;
const PORT_MAX = 9886;

/** 内置兜底清单（官方站点解析失败时用；随插件发版更新，界面会明示「非实时最新」）。
 *  2026-10-23 查证：官方最新稳定版 5.2.3（2026-10-22 发布）。 */
const KNOWN_VERSIONS = ["5.2.3", "5.2.2", "5.2.1"];

let getDataDir = null;
let getMainWin = null;
/* dsh 网关客户端（main.js 注入）：MCP 行必须走它注册 —— 直接改 cordis-user.yml 会在下次启动
   被网关持久化的用户段冲掉（真机验收踩到过）。 */
let getDsh = null;
function dshApi() {
  try {
    return (typeof getDsh === "function" && getDsh()) || null;
  } catch {
    return null;
  }
}
let appRoot = path.join(__dirname, "..");

let consoleWin = null;
let uiBusy = "";
let installState = { installing: false, lastError: "", lastOkAt: 0 };
/* 安装取消：用户点「取消安装」→ 置位 → 安装链在**下一个检查点**当场收手。
   口径：取消不是失败。终局 state="cancelled" 由 plugins/main-install.js 在取消那一刻落好，
   这里只负责「真的停下来」—— 不继续装 addon、不写 MCP 行、不再拉起 Blender 做冒烟，
   也不再上报 finish（否则会把 cancelled 覆盖成 done / failed）。
   历史 bug（真机跑出来的）：取消只杀了当时的子进程，链继续一路跑到 done，
   期间还拉起过 Blender；快照最终 state=done 但 error 里留着 cancelled。 */
let installCancelled = false;
let blenderChild = null; // 插件拉起的 Blender（{ child, pid, startedAt }）
let smokeJob = null;
let lastLogLines = [];

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */
function dataDir() {
  try {
    const d = typeof getDataDir === "function" ? getDataDir() : "";
    return String(d || "");
  } catch {
    return "";
  }
}
function pluginRoot() {
  return path.join(dataDir(), "blender");
}
/** 配置 / 日志 / 备份都在数据目录；安装目录由 config.installDir 指定（用户插件根目录下） */
function configPath() {
  return path.join(pluginRoot(), "config.json");
}
function logPath() {
  return path.join(pluginRoot(), "console.log");
}
function backupRoot() {
  return path.join(dataDir(), "blender-backup");
}
function mk(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
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
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtBytes(n) {
  const b = Number(n || 0);
  if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}
function tail(s, n) {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(-n) : t;
}

function loadConfig() {
  const c = readJson(configPath(), {});
  return {
    installDir: String((c && c.installDir) || ""),
    blenderVersion: String((c && c.blenderVersion) || ""),
    blenderExe: String((c && c.blenderExe) || ""),
    uvPath: String((c && c.uvPath) || ""),
    port: Number((c && c.port) || 0) || 0,
    mcpRegistered: !!(c && c.mcpRegistered),
    lastVersionCheck: Number((c && c.lastVersionCheck) || 0),
    latestSeen: String((c && c.latestSeen) || ""),
    latestSource: String((c && c.latestSource) || ""),
  };
}
function saveConfig(patch) {
  const next = Object.assign({}, loadConfig(), patch || {});
  writeJson(configPath(), next);
  return next;
}

/** 日志：内存环（控制台 / 状态取用）+ 文件（排查用，超过 512KB 轮转一次） */
function appendConsole(line) {
  const text = "[" + nowStamp() + "] " + String(line == null ? "" : line);
  lastLogLines.push(text);
  if (lastLogLines.length > 400) lastLogLines = lastLogLines.slice(-300);
  try {
    mk(pluginRoot());
    const p = logPath();
    try {
      if (exists(p) && fs.statSync(p).size > 512 * 1024) fs.renameSync(p, p + ".1");
    } catch {}
    fs.appendFileSync(p, text + "\n", "utf8");
  } catch {}
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send(API + ":console", { line: text });
  } catch {}
  return text;
}
function consoleTail(n) {
  const want = Math.max(1, Math.min(2000, Number(n || 200)));
  return lastLogLines.slice(-want);
}
function consoleClear() {
  lastLogLines = [];
  try {
    if (exists(logPath())) fs.unlinkSync(logPath());
  } catch {}
}

function notifyMain(channel, payload) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload || {});
  } catch {}
}
function notifyConsoleChanged(open) {
  notifyMain(API + ":consoleChanged", { open: !!open });
}

/** 目录安全性：不许把 Blender 解到应用目录 / 数据目录自身里（AGENTS.md 数据纪律） */
function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  if (!path.isAbsolute(raw)) return { ok: false, error: "not_absolute" };
  const d = path.resolve(raw);
  const bad = [app.getAppPath(), path.dirname(process.execPath), dataDir()].filter(Boolean).map((x) => path.resolve(x));
  for (const b of bad) {
    const rel = path.relative(b, d);
    if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return { ok: false, error: "unsafe_dir", message: "安装目录不能落在应用目录 / 数据目录里：" + d };
    }
  }
  return { ok: true, path: d };
}

/* ------------------------------------------------------------------ */
/* 进程 / 命令                                                         */
/* ------------------------------------------------------------------ */
function runCapture(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child = null;
    let done = false;
    const finish = (code, extra) => {
      if (done) return;
      done = true;
      resolve(Object.assign({ ok: code === 0, code, stdout: out, stderr: err }, extra || {}));
    };
    try {
      child = spawn(cmd, args, {
        cwd: o.cwd || undefined,
        env: Object.assign({}, process.env, o.env || {}),
        windowsHide: true,
      });
    } catch (e) {
      return finish(-1, { error: String((e && e.message) || e) });
    }
    if (o.track !== false) {
      try {
        installKill.track(PLUGIN_ID, child);
      } catch {}
    }
    const timer = o.timeoutMs
      ? setTimeout(() => {
          try {
            spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
          } catch {}
          finish(-2, { error: "timeout", timeout: true });
        }, o.timeoutMs)
      : null;
    child.stdout.on("data", (d) => {
      const s = d.toString("utf8");
      out += s;
      if (typeof o.onLine === "function") s.split(/\r?\n/).filter(Boolean).forEach(o.onLine);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      err += s;
      if (typeof o.onLine === "function") s.split(/\r?\n/).filter(Boolean).forEach(o.onLine);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      finish(-1, { error: String((e && e.message) || e) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      try {
        installKill.untrack(PLUGIN_ID);
      } catch {}
      finish(typeof code === "number" ? code : -1, { child });
    });
  });
}

function psQuote(s) {
  return "'" + String(s || "").replace(/'/g, "''") + "'";
}
function runPowerShell(script, opts) {
  return runCapture(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    Object.assign({ timeoutMs: 10 * 60 * 1000 }, opts || {}),
  );
}

/* ------------------------------------------------------------------ */
/* HTTP：目录索引 / 断点续传下载 / sha256                               */
/* ------------------------------------------------------------------ */
function httpRequest(url, opts) {
  const o = opts || {};
  const lib = /^http:\/\//i.test(url) ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.get(
      url,
      {
        headers: Object.assign(
          {
            "User-Agent": "MTNode-Blender-Plugin/1.0",
            "Accept-Encoding": "gzip, deflate",
          },
          o.headers || {},
        ),
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if ((o.redirects || 0) > 5) return reject(new Error("too_many_redirects"));
          const next = new URL(res.headers.location, url).toString();
          return resolve(httpRequest(next, Object.assign({}, o, { redirects: (o.redirects || 0) + 1 })));
        }
        resolve(res);
      },
    );
    req.on("error", reject);
    req.setTimeout(o.timeoutMs || 60000, () => req.destroy(new Error("timeout")));
    if (o.range) req.setHeader("Range", "bytes=" + o.range);
  });
}
async function httpGetText(url, opts) {
  const res = await httpRequest(url, opts);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error("HTTP " + res.statusCode + " " + url);
  }
  const enc = String(res.headers["content-encoding"] || "");
  let stream = res;
  if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
  else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
  return await new Promise((resolve, reject) => {
    let buf = "";
    stream.on("data", (d) => (buf += d.toString("utf8")));
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
}

/** 下载（带续传 + 重试）。返回 { ok, path, bytes, resumed } */
async function downloadTo(url, dest, opts) {
  const o = opts || {};
  const part = dest + ".part";
  mk(path.dirname(dest));
  const attempts = Math.max(1, Number(o.attempts || 3));
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      appendConsole("[download] 第 " + (i + 1) + " 次尝试：" + url);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
    let start = 0;
    try {
      start = exists(part) ? fs.statSync(part).size : 0;
    } catch {
      start = 0;
    }
    try {
      const res = await httpRequest(url, { range: start > 0 ? start : 0, timeoutMs: 120000 });
      if (res.statusCode === 416 && start > 0) {
        res.resume();
        fs.renameSync(part, dest);
        return { ok: true, path: dest, bytes: fs.statSync(dest).size, resumed: true };
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        throw new Error("HTTP " + res.statusCode);
      }
      if (res.statusCode === 200) start = 0;
      const total = Number(res.headers["content-length"] || 0) + start;
      const out = fs.createWriteStream(part, { flags: start > 0 ? "a" : "w" });
      let got = start;
      let lastTick = 0;
      await new Promise((resolve, reject) => {
        res.on("data", (chunk) => {
          got += chunk.length;
          const t = Date.now();
          if (t - lastTick > 1000 && typeof o.onProgress === "function") {
            lastTick = t;
            try {
              o.onProgress({ got, total });
            } catch {}
          }
        });
        res.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        res.pipe(out);
      });
      if (exists(dest)) fs.unlinkSync(dest);
      fs.renameSync(part, dest);
      return { ok: true, path: dest, bytes: fs.statSync(dest).size, resumed: start > 0 };
    } catch (e) {
      lastErr = e;
      appendConsole("[download] 失败：" + String((e && e.message) || e));
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr || "download_failed") };
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/* 版本探测（官方目录）                                                 */
/* ------------------------------------------------------------------ */
function cmpVer(a, b) {
  const pa = String(a).split(".").map((n) => Number(n) || 0);
  const pb = String(b).split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 解析官方目录：先取最高 BlenderX.Y/，再在里面取最高的 windows-x64.zip */
async function resolveLatestOfficial() {
  const index = await httpGetText(RELEASE_INDEX, { timeoutMs: 30000 });
  const dirs = [];
  const reDir = /Blender(\d+)\.(\d+)\//g;
  let m;
  while ((m = reDir.exec(index))) dirs.push({ key: Number(m[1]) + "." + Number(m[2]), major: Number(m[1]), minor: Number(m[2]) });
  dirs.sort((a, b) => b.major - a.major || b.minor - a.minor);
  for (const d of dirs.slice(0, 3)) {
    const dirUrl = RELEASE_INDEX + "Blender" + d.key + "/";
    let html = "";
    try {
      html = await httpGetText(dirUrl, { timeoutMs: 30000 });
    } catch {
      continue;
    }
    const files = [];
    const reZip = /blender-(\d+\.\d+\.\d+)-windows-x64\.zip/gi;
    let z;
    while ((z = reZip.exec(html))) files.push(z[1]);
    files.sort((a, b) => cmpVer(b, a));
    if (!files.length) continue;
    const version = files[0];
    return {
      version,
      dirUrl,
      zip: "blender-" + version + "-windows-x64.zip",
      sha256Url: dirUrl + "blender-" + version + ".sha256",
      source: "official",
    };
  }
  throw new Error("no_windows_zip_in_index");
}
/** 官方索引不可用 → 用内置清单；下载地址仍是官方同一路径 */
function resolveFromKnown(version) {
  const ver = String(version || KNOWN_VERSIONS[0]);
  const dirUrl = RELEASE_INDEX + "Blender" + ver.split(".").slice(0, 2).join(".") + "/";
  return {
    version: ver,
    dirUrl,
    zip: "blender-" + ver + "-windows-x64.zip",
    sha256Url: dirUrl + "blender-" + ver + ".sha256",
    source: "builtin",
  };
}
/** 期望的 sha256（官方 .sha256 文件里是 "<hash>  <file>"） */
async function fetchExpectedSha(shaUrl, zipName) {
  const text = await httpGetText(shaUrl, { timeoutMs: 30000 });
  const want = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(t);
    if (m && (!zipName || path.basename(m[2].trim()) === zipName)) want.push(m[1].toLowerCase());
  }
  return want;
}

/* ------------------------------------------------------------------ */
/* 解压                                                                */
/* ------------------------------------------------------------------ */
function extractZip(zipPath, destDir) {
  mk(destDir);
  /* Windows 10+ 的 bsdtar 能直接解 zip；比 Expand-Archive 快，也不受 PowerShell 策略影响 */
  const r = spawnSync("tar.exe", ["-xf", zipPath, "-C", destDir], { windowsHide: true, encoding: "utf8" });
  if (r.status === 0) return { ok: true };
  const r2 = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath " + psQuote(zipPath) + " -DestinationPath " + psQuote(destDir) + " -Force"], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (r2.status === 0) return { ok: true };
  return { ok: false, error: tail((r2.stderr || r.stderr || "") + (r2.stdout || ""), 800) || "extract_failed" };
}
/** 官方 zip 里多套一层 blender-<ver>-windows-x64/：把这层剥掉，让 blender.exe 直接躺在用户选的目录里
 *  （路径更短、目录体检的 READY_MARKERS 也能认出「装过东西」）。失败就保留原结构，findBlenderExe 两种都认。 */
function flattenSingleDir(target) {
  if (exists(path.join(target, "blender.exe"))) return { ok: true, moved: false };
  let subs = [];
  try {
    subs = fs.readdirSync(target, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== ".download");
  } catch {
    return { ok: false };
  }
  if (subs.length !== 1) return { ok: true, moved: false };
  const inner = path.join(target, subs[0].name);
  if (!exists(path.join(inner, "blender.exe"))) return { ok: true, moved: false };
  try {
    for (const name of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, name), path.join(target, name));
    }
    fs.rmdirSync(inner);
    return { ok: true, moved: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
function findBlenderExe(installDir) {
  const root = String(installDir || "");
  if (!root) return "";
  const direct = path.join(root, "blender.exe");
  if (exists(direct)) return direct;
  try {
    const subs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const s of subs) {
      const p = path.join(root, s.name, "blender.exe");
      if (exists(p)) return p;
    }
  } catch {}
  return "";
}

/* ------------------------------------------------------------------ */
/* uv（MCP 服务端运行时）                                               */
/* ------------------------------------------------------------------ */
function findUv() {
  const cfg = loadConfig();
  const cands = [];
  if (cfg.uvPath) cands.push(cfg.uvPath);
  cands.push(path.join(os.homedir(), ".local", "bin", "uv.exe"));
  cands.push(path.join(os.homedir(), ".cargo", "bin", "uv.exe"));
  cands.push(path.join(pluginRoot(), ".uv", "uv.exe"));
  cands.push(path.join(loadConfig().installDir || "", ".uv", "uv.exe"));
  for (const c of cands) {
    if (c && exists(c)) return c;
  }
  try {
    const r = spawnSync("where.exe", ["uv"], { windowsHide: true, encoding: "utf8" });
    if (r.status === 0) {
      const first = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && exists(first)) return first;
    }
  } catch {}
  return "";
}
function uvxOf(uvPath) {
  const dir = path.dirname(uvPath);
  const cands = [path.join(dir, "uvx.exe"), path.join(dir, "uvx")];
  for (const c of cands) if (exists(c)) return c;
  return "";
}

async function downloadUvZipFallback(onLine) {
  const api = JSON.parse(await httpGetText(UV_RELEASE_API, { timeoutMs: 30000 }));
  const tag = String((api && api.tag_name) || "").trim();
  const assets = Array.isArray(api && api.assets) ? api.assets : [];
  const zip = assets.find((a) => /uv-x86_64-pc-windows-msvc\.zip$/i.test(String(a.name || "")));
  const sha = assets.find((a) => /uv-x86_64-pc-windows-msvc\.zip\.sha256$/i.test(String(a.name || "")));
  if (!zip) throw new Error("uv_asset_missing");
  const destDir = mk(path.join(pluginRoot(), ".uv"));
  const dest = path.join(destDir, zip.name);
  onLine && onLine("[uv] 回退：下载官方 release " + (tag || "") + " " + zip.name);
  const dl = await downloadTo(zip.browser_download_url, dest, { attempts: 3, onProgress: o => onLine && onLine("[uv] " + Math.round((o.got / Math.max(1, o.total)) * 100) + "%") });
  if (!dl.ok) throw new Error("uv_download_failed: " + dl.error);
  if (sha) {
    const txt = await httpGetText(sha.browser_download_url, { timeoutMs: 30000 });
    const want = (String(txt).trim().split(/\s+/)[0] || "").toLowerCase();
    const got = await sha256File(dest);
    if (want && want !== got) throw new Error("uv_sha256_mismatch");
    onLine && onLine("[uv] sha256 校验通过");
  }
  const ex = extractZip(dest, destDir);
  if (!ex.ok) throw new Error("uv_extract_failed: " + ex.error);
  try {
    fs.unlinkSync(dest);
  } catch {}
  const found = findUv();
  if (!found) throw new Error("uv_not_found_after_extract");
  return found;
}

/** 装 uv：先官方 install.ps1（用户选定），失败再回退官方 release zip（agent 崩之前先自修） */
async function ensureUv(onLine) {
  const have = findUv();
  if (have) {
    saveConfig({ uvPath: have });
    onLine && onLine("[uv] 复用本机已有的 uv：" + have);
    return { ok: true, path: have, reused: true };
  }
  onLine && onLine("[uv] 本机没有 uv：跑官方 install.ps1（装到 ~/.local/bin，并改用户 PATH）");
  const r = await runPowerShell("$ErrorActionPreference='Stop'; irm " + UV_INSTALL_PS1 + " | iex", {
    onLine: (l) => onLine && onLine("[uv] " + l),
  });
  let found = findUv();
  if (found) {
    saveConfig({ uvPath: found });
    return { ok: true, path: found, reused: false };
  }
  onLine && onLine("[uv] install.ps1 没装上（code=" + r.code + "）：回退官方 release zip");
  try {
    found = await downloadUvZipFallback(onLine);
    saveConfig({ uvPath: found });
    return { ok: true, path: found, reused: false, fallback: true };
  } catch (e) {
    return { ok: false, error: "uv_install_failed", detail: String((e && e.message) || e) + " / install.ps1 code=" + r.code + " " + tail(r.stderr, 300) };
  }
}

/* ------------------------------------------------------------------ */
/* Blender addon（MCP for Blender）                                     */
/* ------------------------------------------------------------------ */
function blenderConfigBase() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Blender Foundation", "Blender");
}
function addonsDirOf(version) {
  const mm = String(version || "").split(".").slice(0, 2).join(".");
  return path.join(blenderConfigBase(), mm, "scripts", "addons");
}
function guessInstalledVersion(installDir) {
  const exe = findBlenderExe(installDir);
  if (!exe) return "";
  const m = /blender-(\d+\.\d+\.\d+)-windows-x64/i.exec(String(installDir));
  if (m) return m[1];
  const r = spawnSync(exe, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
  const t = String((r && r.stdout) || "");
  const vm = /Blender\s+(\d+\.\d+\.\d+)/i.exec(t);
  return vm ? vm[1] : "";
}

const ENABLE_ADDON_SCRIPT = [
  "import json, sys",
  "import addon_utils, bpy",
  'module = sys.argv[sys.argv.index("--") + 1]',
  'result = {"already": [], "enabled": False, "error": None}',
  "try:",
  "    enabled = {a.module for a in bpy.context.preferences.addons}",
  "    names = {'MCP for Blender', 'Blender MCP'}",
  "    for mod in addon_utils.modules(refresh=True):",
  "        if mod.__name__ in enabled and addon_utils.module_bl_info(mod).get('name') in names:",
  "            result['already'].append(mod.__name__)",
  "    if not result['already']:",
  "        result['enabled'] = addon_utils.enable(module, default_set=True) is not None",
  "        if result['enabled']:",
  "            bpy.ops.wm.save_userpref()",
  "        else:",
  "            result['error'] = 'Blender 没能加载 ' + module",
  "except Exception as e:",
  "    result['error'] = str(e)",
  "print('MTNODE_BLENDER_RESULT ' + json.dumps(result))",
].join("\n");

function backupUserPref(version) {
  const mm = String(version || "").split(".").slice(0, 2).join(".");
  const src = path.join(blenderConfigBase(), mm, "config", "userpref.blend");
  if (!exists(src)) return "";
  const dest = path.join(backupRoot(), "userpref-" + mm + "-" + Date.now() + ".blend");
  mk(path.dirname(dest));
  try {
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return "";
  }
}

async function installAddon(opts) {
  const o = opts || {};
  const uvx = uvxOf(o.uvPath || "") || "";
  if (!uvx) return { ok: false, error: "uvx_missing" };
  const addonsDir = o.addonsDir;
  mk(addonsDir);
  /* uvx 没有 --yes（那是 uv pip 的选项）：带上它 uvx 直接报 unexpected argument 退出，
     而旧 addon 文件还在原地 → 会静默沿用旧协议版本。所以既不带它，也必须看退出码。 */
  const args = ["mcp-for-blender", "install-addon", "--addons-dir", addonsDir];
  const r = await runCapture(uvx, args, {
    timeoutMs: 10 * 60 * 1000,
    env: o.env || {},
    onLine: (l) => o.onLine && o.onLine("[addon] " + l),
  });
  if (!r.ok) {
    return { ok: false, error: "addon_install_failed", detail: tail(r.stdout + r.stderr, 800) };
  }
  const target = path.join(addonsDir, "blender_mcp.py");
  if (!exists(target)) {
    return { ok: false, error: "addon_file_missing", detail: tail(r.stdout + r.stderr, 800) };
  }
  return { ok: true, addonPath: target, output: tail(r.stdout, 400) };
}

async function enableAddon(blenderExe, version, onLine) {
  const bak = backupUserPref(version);
  if (bak) onLine && onLine("[addon] 已备份 userpref：" + bak);
  const args = ["--background", "--python-expr", ENABLE_ADDON_SCRIPT, "--", "blender_mcp"];
  const r = await runCapture(blenderExe, args, {
    timeoutMs: 3 * 60 * 1000,
    env: { BLENDERMCP_NO_UPDATE_CHECK: "1" },
    onLine: (l) => onLine && onLine("[blender] " + l),
  });
  const text = String(r.stdout || "");
  const line = text.split(/\r?\n/).find((x) => x.startsWith("MTNODE_BLENDER_RESULT "));
  if (!line) return { ok: false, error: "blender_no_result", detail: tail(text + r.stderr, 600) };
  let res = {};
  try {
    res = JSON.parse(line.slice("MTNODE_BLENDER_RESULT ".length));
  } catch {}
  if (res.already && res.already.length) return { ok: true, already: true, backup: bak };
  if (res.enabled) return { ok: true, backup: bak };
  return { ok: false, error: "addon_enable_failed", detail: String(res.error || "") };
}

/* ------------------------------------------------------------------ */
/* 端口                                                                */
/* ------------------------------------------------------------------ */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}
function portListenable(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(1200, () => {
      s.destroy();
      resolve(false);
    });
  });
}
async function pickPort(preferred) {
  const want = Number(preferred || 0);
  if (want >= 1024 && (await portFree(want))) return { ok: true, port: want };
  for (let p = PORT_BASE; p <= PORT_MAX; p++) {
    if (await portFree(p)) return { ok: true, port: p };
  }
  return { ok: false, error: "no_free_port" };
}

/* ------------------------------------------------------------------ */
/* MCP 注册（cordis-user.yml）                                          */
/* ------------------------------------------------------------------ */
function mcpYmlPath() {
  return path.join(dataDir(), "dsh-home", "cordis-user.yml");
}
function yamlStr(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'";
}
function mcpRowBlock(uvxPath, port) {
  return [
    "",
    "- id: " + MCP_ID,
    "  name: '" + MCP_PKG + "'",
    "  config:",
    "    serverName: '" + MCP_SERVER_NAME + "'",
    "    transport: 'stdio'",
    "    command: " + yamlStr(uvxPath),
    "    args: ['mcp-for-blender', '--host', '127.0.0.1', '--port', '" + String(port) + "']",
  ].join("\n");
}
function mcpStatus() {
  const p = mcpYmlPath();
  const text = exists(p) ? fs.readFileSync(p, "utf8") : "";
  /* 认 serverName（真源）而不是我们自己写的那行 id：走 dsh.mcpAdd 时行 id 是 user-mcp-xxx，
     手写 YAML 时才是 blender-local-mcp-blender；两种都该被认出来。 */
  const re = new RegExp("serverName: '" + MCP_SERVER_NAME + "'[\\s\\S]{0,600}?--port', '([0-9]+)'");
  const hit = re.exec(text);
  const block = /(?:^|\n)- id: [^\n]*\n(?:[^\n]*\n)*?[^\n]*serverName: 'blender'/m.exec(text);
  return { ok: true, path: p, registered: !!(hit || block), port: hit ? Number(hit[1]) : 0 };
}
/** 写 MCP 行：优先走 dsh 自己的注册口（网关会把用户段持久化，下次启动不会被冲掉）；
 *  拿不到网关时退回直接写 YAML（仅测试 / 极端降级）。 */
async function writeMcpRow(uvxPath, port) {
  const api = dshApi();
  if (api && typeof api.mcpAdd === "function") {
    try {
      /* 网关回的是一层信封：mcpList → { servers: [...] }（实测），两种形状都认。 */
      const raw = typeof api.mcpList === "function" ? await api.mcpList() : null;
      const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.servers) ? raw.servers : []);
      if (rows.some((r) => r && r.serverName === MCP_SERVER_NAME)) {
        await api.mcpRemove(MCP_SERVER_NAME);
      }
      await api.mcpAdd({
        serverName: MCP_SERVER_NAME,
        transport: "stdio",
        command: String(uvxPath),
        args: ["mcp-for-blender", "--host", "127.0.0.1", "--port", String(port)],
      });
      saveConfig({ mcpRegistered: true, port: Number(port) || 0 });
      appendConsole("[mcp] 已注册到 dsh（serverName=" + MCP_SERVER_NAME + " port=" + port + "）");
      return { ok: true, path: mcpYmlPath(), via: "dsh" };
    } catch (e) {
      const detail = String((e && (e.stack || e.message)) || e || "unknown");
      appendConsole("[mcp] 注册失败：" + detail);
      return { ok: false, error: "mcp_register_failed", detail };
    }
  }
  const p = mcpYmlPath();
  const cur = exists(p) ? fs.readFileSync(p, "utf8") : "";
  removeMcpRowQuiet();
  mk(path.dirname(p));
  fs.appendFileSync(p, mcpRowBlock(uvxPath, port) + "\n", "utf8");
  saveConfig({ mcpRegistered: true, port: Number(port) || 0 });
  appendConsole("[mcp] 已写入 " + p + "（serverName=" + MCP_SERVER_NAME + " port=" + port + "）");
  return { ok: true, path: p, previous: cur.length, via: "yaml" };
}
function removeMcpRowQuiet() {
  const p = mcpYmlPath();
  if (!exists(p)) return { ok: true, removed: false };
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  const out = [];
  let skipping = false;
  let removed = false;
  for (const line of lines) {
    if (!skipping && /^- id: blender-local-mcp-blender\s*$/.test(line)) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping) {
      if (/^- (id|name): /.test(line)) {
        skipping = false;
      } else {
        continue;
      }
    }
    out.push(line);
  }
  let text = out.join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(p, text, "utf8");
  saveConfig({ mcpRegistered: false });
  return { ok: true, removed };
}
async function removeMcpRow() {
  const api = dshApi();
  if (api && typeof api.mcpRemove === "function") {
    try {
      await api.mcpRemove(MCP_SERVER_NAME);
      saveConfig({ mcpRegistered: false });
      appendConsole("[mcp] 已从 dsh 撤下 " + MCP_SERVER_NAME);
      return { ok: true, removed: true, via: "dsh" };
    } catch (e) {
      return { ok: false, removed: false, error: String((e && e.message) || e) };
    }
  }
  const r = removeMcpRowQuiet();
  if (r.removed) appendConsole("[mcp] 已撤下 " + MCP_ID);
  return r;
}

/* ------------------------------------------------------------------ */
/* Blender 启动 / 停止 / 冒烟                                          */
/* ------------------------------------------------------------------ */
function blenderRunningPid() {
  if (!blenderChild) return 0;
  try {
    process.kill(blenderChild.pid, 0);
    return blenderChild.pid;
  } catch {
    blenderChild = null;
    return 0;
  }
}
function isUserBlenderRunning() {
  try {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq blender.exe", "/NH"], { windowsHide: true, encoding: "utf8" });
    return /blender\.exe/i.test(String(r.stdout || ""));
  } catch {
    return false;
  }
}

function startScript(port) {
  return [
    "import bpy, importlib",
    "PORT = " + String(port),
    "try:",
    "    m = importlib.import_module('blender_mcp')",
    "    sc = bpy.context.scene",
    "    if hasattr(sc, 'blendermcp_port'):",
    "        sc.blendermcp_port = PORT",
    "    if hasattr(sc, 'blendermcp_auto_start_server'):",
    "        sc.blendermcp_auto_start_server = True",
    "    srv = getattr(bpy.types, 'blendermcp_server', None)",
    "    if srv is not None and getattr(srv, 'running', False) and getattr(srv, 'port', PORT) != PORT:",
    "        srv.stop()",
    "        bpy.types.blendermcp_server = None",
    "        srv = None",
    "    if srv is None:",
    "        m._blendermcp_ensure_server_running()",
    "    print('MTNODE_BLENDER_SERVER_PORT', PORT)",
    "except Exception as e:",
    "    print('MTNODE_BLENDER_START_ERROR', e)",
  ].join("\n");
}

/** 启 Blender（插件的那个实例）。gui=false 只用于测试。 */
function launchBlender(opts) {
  const o = opts || {};
  const cfg = loadConfig();
  const exe = cfg.blenderExe || findBlenderExe(cfg.installDir);
  if (!exe || !exists(exe)) return { ok: false, error: "blender_missing" };
  const port = Number(o.port || cfg.port || PORT_BASE) || PORT_BASE;
  const args = ["--python-expr", startScript(port)];
  if (o.file && exists(o.file)) args.unshift(o.file);
  let child = null;
  try {
    child = spawn(exe, args, { windowsHide: false, detached: false, stdio: "ignore" });
  } catch (e) {
    return { ok: false, error: "spawn_failed", detail: String((e && e.message) || e) };
  }
  blenderChild = { child, pid: child.pid, startedAt: Date.now(), port };
  appendConsole("[blender] 启动 pid=" + child.pid + " port=" + port + " exe=" + exe);
  try {
    child.on("close", (code) => {
      appendConsole("[blender] 退出 pid=" + child.pid + " code=" + code);
      if (blenderChild && blenderChild.pid === child.pid) blenderChild = null;
      notifyConsoleChanged(false);
    });
  } catch {}
  return { ok: true, pid: child.pid, port, exe };
}

function stopBlender(opts) {
  const o = opts || {};
  const pid = blenderRunningPid();
  if (!pid) return { ok: true, stopped: false, note: "插件没有拉起 Blender（用户手开的实例不碰）" };
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  blenderChild = null;
  appendConsole("[blender] 已关闭插件拉起的实例 pid=" + pid + (o.reason ? "（" + o.reason + "）" : ""));
  notifyConsoleChanged(false);
  return { ok: true, stopped: true, pid };
}

/** addon socket 探活：blender_mcp.py 说的是它自己的行分隔 JSON（{"type":"ping"}），不是 MCP。 */
function addonPing(port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    let sock = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        if (sock) sock.destroy();
      } catch {}
      resolve(r);
    };
    try {
      sock = net.connect({ host: "127.0.0.1", port: Number(port) }, () => {
        try {
          sock.write(JSON.stringify({ type: "ping" }) + "\n");
        } catch {}
      });
    } catch (e) {
      return finish({ ok: false, error: "addon_ping_spawn_failed", detail: String((e && e.message) || e) });
    }
    sock.setTimeout(timeoutMs || 15000);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      /* addon 的应答是**裸 JSON、不带换行**（sendall 后连接继续开着），所以按整段解析，
         不能等 \n —— 等换行只会等到超时。 */
      let msg = null;
      try {
        msg = JSON.parse(buf);
      } catch {
        return;
      }
      if (msg && msg.status === "success") return finish({ ok: true, pong: true });
      finish({ ok: false, error: "addon_ping_failed", detail: tail(buf, 400) });
    });
    sock.on("timeout", () => finish({ ok: false, error: "addon_ping_timeout" }));
    sock.on("error", (e) => finish({ ok: false, error: "addon_ping_error", detail: String((e && e.message) || e) }));
  });
}

/** MCP 握手：起 uvx 服务端（stdio），走 JSON-RPC initialize + tools/list，读回工具数 */
function mcpHandshake(uvxPath, port, timeoutMs) {
  return new Promise((resolve) => {
    const args = ["mcp-for-blender", "--host", "127.0.0.1", "--port", String(port)];
    let child = null;
    let buf = "";
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        if (child) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: "handshake_timeout", log: tail(buf, 600) }), timeoutMs || 60000);
    try {
      child = spawn(uvxPath, args, { windowsHide: true, env: Object.assign({}, process.env, { BLENDERMCP_NO_UPDATE_CHECK: "1" }) });
    } catch (e) {
      clearTimeout(timer);
      return done({ ok: false, error: "handshake_spawn_failed", detail: String((e && e.message) || e) });
    }
    const send = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch {}
    };
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          const tools = Array.isArray(msg.result.tools) ? msg.result.tools : [];
          return done({ ok: true, tools: tools.length, names: tools.slice(0, 12).map((t) => t.name) });
        }
      }
    });
    child.stderr.on("data", (d) => {
      buf += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, error: "handshake_error", detail: String((e && e.message) || e) });
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mtnode-blender-smoke", version: "1.0.0" } },
    });
  });
}

async function waitPort(port, timeoutMs) {
  const end = Date.now() + (timeoutMs || 90000);
  while (Date.now() < end) {
    if (installCancelled) return false; /* 取消后不再等端口：冒烟这一步要当场收手 */
    if (await portListenable(port)) return true;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 安装编排                                                             */
/* ------------------------------------------------------------------ */
function emitStep(step) {
  try {
    installHost.reportPluginStep({ pluginId: PLUGIN_ID, kind: "step", step: step || {} });
  } catch {}
}
function emitLog(stepId, line, stream) {
  try {
    installHost.reportPluginStep({ pluginId: PLUGIN_ID, kind: "log", stepId, line: String(line || ""), stream: stream || "host" });
  } catch {}
}
/** 取消收尾：把宿主侧状态放干净，回答「这次是被取消的」，不报终局（终局已由主进程落好）。
 *  调用口径统一写成 `if (installCancelled) return cancelledExit("uv");` —— 取消之后每一步都要先问一次。 */
function cancelledExit(stepId) {
  installState.installing = false;
  uiBusy = "";
  try {
    if (blenderRunningPid()) stopBlender({ reason: "已取消" });
  } catch {}
  try {
    installKill.untrack(PLUGIN_ID);
  } catch {}
  appendConsole("[install] 已取消：停在 " + (stepId || "未知步骤") + "（已下好的文件保留，重试会接着跑）");
  notifyConsoleChanged(!!(consoleWin && !consoleWin.isDestroyed()));
  return { ok: false, error: "cancelled", cancelled: true, step: stepId || "" };
}

function failAt(stepId, code, message, detail) {
  if (installCancelled) return cancelledExit(stepId);
  installState.installing = false;
  uiBusy = "";
  emitStep({ id: stepId, status: "fail", code, message });
  emitLog(stepId, message);
  const text = message + (detail ? "\n" + tail(detail, 800) : "");
  try {
    pluginErrors.reportPluginError(PLUGIN_ID, { code, message: text, step: stepId });
  } catch {}
  installState.lastError = text;
  try {
    installHost.reportPluginStep({ pluginId: PLUGIN_ID, kind: "finish", ok: false, error: message, hint: "" });
  } catch {}
  appendConsole("[install] 失败（" + stepId + "/" + code + "）：" + message);
  notifyConsoleChanged(!!(consoleWin && !consoleWin.isDestroyed()));
  return { ok: false, error: code, message, step: stepId, detail: detail || "" };
}

/** 安装入口（<key>:install 通道；安装窗「开始安装 / 重试」调它） */
async function installBackend(opts) {
  const o = opts || {};
  if (installState.installing)
    return { ok: false, error: "busy", message: installCancelled ? "上一轮安装正在收手，稍等一下再重试。" : "已经在装了" };
  const cfg0 = loadConfig();
  const dir = String(o.installDir || cfg0.installDir || installHost.installDirOf(PLUGIN_ID) || "");
  const safe = isSafeInstallDir(dir);
  if (!safe.ok) {
    const msg = safe.error === "empty_dir" ? "还没有设置安装目录：先在插件根目录下选一个位置。" : safe.message || "安装目录不可用：" + safe.error;
    return { ok: false, error: safe.error, message: msg, installDir: dir };
  }
  const target = safe.path;
  installState = { installing: true, lastError: "", lastOkAt: installState.lastOkAt };
  installCancelled = false;
  uiBusy = "install";
  const man = installHost.readManifest([__dirname]);
  try {
    installHost.beginPluginInstall({
      id: PLUGIN_ID,
      name: PLUGIN_NAME,
      action: "install",
      installDir: target,
      steps: (man && man.steps) || [],
    });
  } catch {}
  appendConsole("[install] 开始：目录=" + target);

  /* ① probe：已装就跳过（共识：不自动升级），但仍然查一次官方最新版号用于展示 */
  emitStep({ id: "probe", status: "run" });
  let known = "";
  try {
    const latest = await resolveLatestOfficial();
    known = latest.version;
    saveConfig({ lastVersionCheck: Date.now(), latestSeen: latest.version, latestSource: latest.source });
    emitLog("probe", "官方最新稳定版：" + latest.version);
  } catch (e) {
    const fallback = KNOWN_VERSIONS[0];
    saveConfig({ lastVersionCheck: Date.now(), latestSeen: fallback, latestSource: "builtin" });
    emitLog("probe", "官方目录取不到版本号（" + String((e && e.message) || e) + "）：回退内置清单 " + fallback + "（非实时最新）");
    known = fallback;
  }
  if (installCancelled) return cancelledExit("probe");
  const existingExe = findBlenderExe(target) || cfg0.blenderExe;
  if (existingExe && exists(existingExe)) {
    const ver = guessInstalledVersion(existingExe) || cfg0.blenderVersion || "";
    const addonsDir = addonsDirOf(ver);
    const addonPath = path.join(addonsDir, "blender_mcp.py");
    saveConfig({ installDir: target, blenderExe: existingExe, blenderVersion: ver });
    emitStep({ id: "probe", status: "ok", message: "已装 " + (ver || "未知版本") + "：跳过下载（不自动升级）" });
    ["download", "extract", "uv", "addon", "mcp"].forEach((id) => emitStep({ id, status: "skip", message: "已装，本次跳过" }));
    if (!exists(addonPath)) {
      /* 已装 Blender 但 addon 丢了：仍要补 addon / MCP，否则「装好了但连不上」 */
      emitLog("probe", "addon 缺失，补装：" + addonPath);
      for (const id of ["download", "extract"]) emitStep({ id, status: "skip", message: "Blender 已存在" });
      return await finishAddonAndMcp({ target, exe: existingExe, version: ver, addonsDir, known });
    }
    if (!mcpStatus().registered) {
      /* 已装 Blender + addon，但 MCP 行没了（被网关重写 / 用户手动删过）：
         只补这一行，不重装 Blender，也不动别的配置。 */
      emitStep({ id: "mcp", status: "run", message: "补注册 MCP" });
      const uv = await ensureUv((l) => emitLog("uv", l));
      if (!uv.ok) return failAt("mcp", "blender.uv_failed", "补注册 MCP 需要 uvx，但装 uv 失败。", uv.detail || uv.error);
      const uvx = uvxOf(uv.path);
      if (!uvx) return failAt("mcp", "blender.uvx_missing", "找到了 uv 但没有 uvx.exe。", uv.path);
      const pk = await pickPort(cfg0.port || 0);
      if (!pk.ok) return failAt("mcp", "blender.no_free_port", "9876–9886 都被占用了，找不到可用的 MCP 端口。", "");
      const wr = await writeMcpRow(uvx, pk.port);
      if (installCancelled) return cancelledExit("mcp");
      if (!wr.ok) return failAt("mcp", "blender.mcp_write_failed", "注册 MCP 服务器失败。", String(wr.detail || wr.error || ""));
      saveConfig({ port: pk.port, mcpRegistered: true });
      emitStep({ id: "mcp", status: "ok", message: "已补注册 serverName=blender · port=" + pk.port });
    }
    return await finishSmokeAndDone({ target, exe: existingExe, version: ver, known });
  }

  /* ② download：官方 zip + sha256 + 断点续传 */
  emitStep({ id: "probe", status: "ok", message: "准备安装最新稳定版 " + known });
  let targetInfo = null;
  try {
    targetInfo = await resolveLatestOfficial();
  } catch {
    targetInfo = resolveFromKnown(known);
  }
  if (targetInfo.version !== known) {
    saveConfig({ latestSeen: targetInfo.version, latestSource: targetInfo.source });
  }
  const dlDir = path.join(target, ".download");
  const zipPath = path.join(dlDir, targetInfo.zip);
  emitStep({ id: "download", status: "run", message: "下载 " + targetInfo.zip + "（官方源）" });
  appendConsole("[install] 下载 " + targetInfo.dirUrl + targetInfo.zip);
  let expected = [];
  try {
    expected = await fetchExpectedSha(targetInfo.sha256Url, targetInfo.zip);
  } catch (e) {
    return failAt("download", "blender.sha256_unavailable", "拿不到官方 sha256 校验文件，按共识不装未校验的包。", String((e && e.message) || e));
  }
  if (!expected.length) return failAt("download", "blender.sha256_missing", "官方 sha256 文件里没有这个 zip 的校验值。", targetInfo.sha256Url);
  const dl = await downloadTo(targetInfo.dirUrl + targetInfo.zip, zipPath, {
    attempts: 3,
    onProgress: (p) => {
      const pct = p.total ? Math.min(99, Math.floor((p.got / p.total) * 100)) : 0;
      emitLog("download", "已下载 " + fmtBytes(p.got) + (p.total ? " / " + fmtBytes(p.total) + "（" + pct + "%）" : ""));
    },
  });
  if (installCancelled) return cancelledExit("download");
  if (!dl.ok) {
    return failAt("download", "blender.download_failed", "下载 Blender 安装包失败（官方源）。", dl.error + "\n" + targetInfo.dirUrl + targetInfo.zip);
  }
  emitLog("download", "下载完成：" + fmtBytes(dl.bytes) + (dl.resumed ? "（续传）" : ""));
  emitStep({ id: "download", status: "run", message: "校验 sha256…" });
  const gotSha = await sha256File(zipPath);
  if (!expected.includes(gotSha)) {
    try {
      fs.unlinkSync(zipPath);
    } catch {}
    return failAt("download", "blender.sha256_mismatch", "sha256 校验不一致，已删掉这次下载的包（可能是网络截断）。", "期望 " + expected.join("/") + "，实际 " + gotSha);
  }
  emitStep({ id: "download", status: "ok", message: "sha256 通过（" + targetInfo.version + "）" });

  /* ③ extract */
  emitStep({ id: "extract", status: "run" });
  const ex = extractZip(zipPath, target);
  if (installCancelled) return cancelledExit("extract");
  if (!ex.ok) return failAt("extract", "blender.extract_failed", "解压 Blender 安装包失败。", ex.error);
  const flat = flattenSingleDir(target);
  if (!flat.ok) emitLog("extract", "剥壳失败（不影响使用）：" + flat.error);
  const exe = findBlenderExe(target);
  if (!exe) return failAt("extract", "blender.exe_missing", "解压后找不到 blender.exe。", target);
  saveConfig({ installDir: target, blenderExe: exe, blenderVersion: targetInfo.version });
  try {
    fs.unlinkSync(zipPath);
  } catch {}
  emitStep({ id: "extract", status: "ok", message: exe });

  return await finishAddonAndMcp({
    target,
    exe,
    version: targetInfo.version,
    addonsDir: addonsDirOf(targetInfo.version),
    known,
  });
}

/** ④ uv ⑤ addon ⑥ mcp → ⑦ smoke ⑧ done */
async function finishAddonAndMcp(ctx) {
  const c = ctx;
  emitStep({ id: "uv", status: "run" });
  const uv = await ensureUv((l) => emitLog("uv", l));
  if (installCancelled) return cancelledExit("uv");
  if (!uv.ok) return failAt("uv", "blender.uv_failed", "装 uv 失败（mcp-for-blender 要靠 uvx 跑）。", uv.detail || uv.error);
  const uvx = uvxOf(uv.path);
  if (!uvx) return failAt("uv", "blender.uvx_missing", "找到了 uv 但没有 uvx.exe。", uv.path);
  emitStep({ id: "uv", status: "ok", message: uv.path });

  emitStep({ id: "addon", status: "run" });
  const addon = await installAddon({ uvPath: uv.path, addonsDir: c.addonsDir, onLine: (l) => emitLog("addon", l) });
  if (installCancelled) return cancelledExit("addon");
  if (!addon.ok) return failAt("addon", "blender.addon_install_failed", "装 Blender addon（MCP for Blender）失败。", addon.detail || addon.error);
  emitLog("addon", "addon 已落盘：" + addon.addonPath);
  const en = await enableAddon(c.exe, c.version, (l) => emitLog("addon", l));
  if (installCancelled) return cancelledExit("addon");
  if (!en.ok) return failAt("addon", "blender.addon_enable_failed", "addon 已装但没能在 Blender 里启用（userpref 写入失败）。", en.detail || en.error);
  emitStep({ id: "addon", status: "ok", message: en.already ? "已在 Blender 里启用" : "已启用并保存 userpref" });

  emitStep({ id: "mcp", status: "run" });
  const cur = loadConfig();
  const pk = await pickPort(cur.port || 0);
  if (!pk.ok) return failAt("mcp", "blender.no_free_port", "9876–9886 都被占用了，找不到可用的 MCP 端口。", "");
  if (cur.port && cur.port !== pk.port && (await portListenable(cur.port))) {
    emitLog("mcp", "端口 " + cur.port + " 已被占用（可能是已在跑的 Blender），本次改用 " + pk.port);
  }
  try {
    const wr = await writeMcpRow(uvx, pk.port);
    if (installCancelled) return cancelledExit("mcp");
    if (!wr.ok) {
      return failAt("mcp", "blender.mcp_write_failed", "注册 MCP 服务器失败。", String(wr.detail || wr.error || ""));
    }
  } catch (e) {
    return failAt("mcp", "blender.mcp_write_failed", "注册 MCP 服务器失败。", String((e && e.message) || e));
  }
  saveConfig({ port: pk.port, mcpRegistered: true });
  emitStep({ id: "mcp", status: "ok", message: "serverName=blender · port=" + pk.port + "（重启 MTNode 后生效）" });

  return await finishSmokeAndDone({ target: c.target, exe: c.exe, version: c.version, known: c.known });
}

async function finishSmokeAndDone(ctx) {
  const c = ctx;
  const cfg = loadConfig();
  const uvx = uvxOf(cfg.uvPath) || uvxOf(findUv());
  const port = Number(cfg.port || 0) || PORT_BASE;
  emitStep({ id: "smoke", status: "run", message: "端到端冒烟：启 Blender → addon socket → MCP 握手" });
  if (installCancelled) return cancelledExit("smoke");
  if (process.env.MTNODE_BLENDER_SKIP_SMOKE === "1") {
    emitStep({ id: "smoke", status: "skip", message: "已按环境变量跳过冒烟（测试）" });
    return doneOk(c, { smoke: { skipped: true } });
  }
  if (!uvx) return failAt("smoke", "blender.uvx_missing", "冒烟前找不到 uvx，无法验证 MCP 握手。", "");
  const existing = blenderRunningPid();
  const started = existing ? { ok: true, pid: existing, port, reused: true } : launchBlender({ port });
  if (!started.ok) return failAt("smoke", "blender.launch_failed", "启动 Blender 做冒烟失败。", started.detail || started.error);
  emitLog("smoke", "Blender pid=" + started.pid + "，等 addon 起 socket（端口 " + port + "）");
  const up = await waitPort(port, 120000);
  if (installCancelled) {
    stopBlender({ reason: "已取消" });
    return cancelledExit("smoke");
  }
  if (!up) {
    stopBlender({ reason: "冒烟失败后收尾" });
    return failAt(
      "smoke",
      "blender.socket_timeout",
      "Blender 起来了，但 addon 没在 120 秒内监听端口 " + port + "（常见原因：addon 没启用 / 端口被别的进程占了）。",
      "",
    );
  }
  const ping = await addonPing(port, 20000);
  if (!ping.ok) {
    stopBlender({ reason: "冒烟失败后收尾" });
    return failAt(
      "smoke",
      "blender.addon_ping_failed",
      "Blender 起来了、端口也开了，但 addon 没回 ping（多半是 addon 版本旧 / 没真的启用）。",
      ping.detail || ping.error || "",
    );
  }
  emitLog("smoke", "addon socket 已应答 ping");
  const hs = await mcpHandshake(uvx, port, 90000);
  if (installCancelled) {
    stopBlender({ reason: "已取消" });
    return cancelledExit("smoke");
  }
  if (!hs.ok) {
    stopBlender({ reason: "冒烟失败后收尾" });
    return failAt("smoke", "blender.mcp_handshake_failed", "MCP 握手失败（服务端能起，但没拿到工具列表）。", hs.detail || hs.log || hs.error);
  }
  emitLog("smoke", "MCP 握手成功：工具 " + hs.tools + " 个 → " + (hs.names || []).join(", "));
  if (!started.reused) stopBlender({ reason: "冒烟完成" });
  emitStep({ id: "smoke", status: "ok", message: "工具 " + hs.tools + " 个可用" });
  return doneOk(c, { smoke: { tools: hs.tools, port } });
}

function doneOk(ctx, extra) {
  if (installCancelled) return cancelledExit("done");
  installState.installing = false;
  installState.lastOkAt = Date.now();
  uiBusy = "";
  emitStep({ id: "done", status: "ok", message: "装好了：重启 MTNode 后 Agent 里就有 blender 工具" });
  try {
    installHost.reportPluginStep({ pluginId: PLUGIN_ID, kind: "finish", ok: true, error: "", hint: "" });
  } catch {}
  appendConsole("[install] 完成 " + (ctx && ctx.version ? "v" + ctx.version : ""));
  notifyConsoleChanged(!!(consoleWin && !consoleWin.isDestroyed()));
  return Object.assign({ ok: true, installDir: ctx.target, blenderExe: ctx.exe, version: ctx.version, restartRequired: true }, extra || {});
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
function statusForUi() {
  const cfg = loadConfig();
  const dir = cfg.installDir || installHost.installDirOf(PLUGIN_ID) || "";
  const exe = (cfg.blenderExe && exists(cfg.blenderExe) ? cfg.blenderExe : findBlenderExe(dir)) || "";
  const version = cfg.blenderVersion || (exe ? guessInstalledVersion(dir) : "");
  const addonPath = version ? path.join(addonsDirOf(version), "blender_mcp.py") : "";
  const uv = findUv();
  const uvx = uvxOf(uv);
  const mcp = mcpStatus();
  return {
    version: app.getVersion ? app.getVersion() : "",
    pluginVersion: "1.0.0",
    installed: !!exe,
    installing: !!installState.installing,
    running: !!blenderRunningPid(),
    wantRunning: false,
    userBlenderRunning: isUserBlenderRunning(),
    installDir: dir,
    blenderExe: exe,
    blenderVersion: version,
    latestSeen: cfg.latestSeen,
    latestSource: cfg.latestSource,
    lastVersionCheck: cfg.lastVersionCheck,
    uvPath: uv,
    uvxPath: uvx,
    addonPath,
    addonInstalled: !!(addonPath && exists(addonPath)),
    mcpRegistered: !!mcp.registered,
    mcpPort: mcp.port || cfg.port || 0,
    port: cfg.port || PORT_BASE,
    logs: consoleTail(60),
    lastError: installState.lastError,
    open: !!(consoleWin && !consoleWin.isDestroyed()),
  };
}

/* ------------------------------------------------------------------ */
/* 控制台窗                                                             */
/* ------------------------------------------------------------------ */
function uiEntry() {
  return path.join(__dirname, "ui", "index.html");
}
function openConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    notifyConsoleChanged(true);
    return { ok: true, open: true };
  }
  const entry = uiEntry();
  if (!exists(entry)) return { ok: false, error: "ui_missing" };
  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 560,
    height: 720,
    x: Math.min(wa.x + wa.width - 600, wa.x + wa.width - 100),
    y: wa.y + 30,
    frame: true,
    show: true,
    title: PLUGIN_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload-blender.js"),
    },
  });
  consoleWin.loadFile(entry);
  consoleWin.on("closed", () => {
    consoleWin = null;
    notifyConsoleChanged(false);
  });
  consoleWin.webContents.on("did-finish-load", () => {
    /* 不在这里回放日志：控制台 boot 自己会取 consoleTail(200) 打底，
       两处都灌一遍就会出现「每条日志都显示两遍」。 */
    notifyConsoleChanged(true);
  });
  notifyConsoleChanged(true);
  appendConsole("[console] 打开控制台窗");
  return { ok: true, open: true };
}
function closeConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  notifyConsoleChanged(false);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 卸载                                                                */
/* ------------------------------------------------------------------ */
async function uninstallPreview() {
  const cfg = loadConfig();
  const dir = cfg.installDir || "";
  let size = 0;
  if (dir && exists(dir)) size = dirSize(dir);
  return {
    ok: true,
    installDir: dir,
    bytes: size,
    willDelete: [dir || "(未设置安装目录)", cfg.blenderVersion ? path.join(addonsDirOf(cfg.blenderVersion), "blender_mcp.py") : ""].filter(Boolean),
    willKeep: [
      path.join(dataDir(), "blender-backup") + "（userpref 备份）",
      "本机已装的 uv（可能被别的工具用）",
      "你的 .blend 工程文件",
    ],
  };
}
function dirSize(dir) {
  let total = 0;
  const walk = (p, depth) => {
    if (depth > 6) return;
    let items = [];
    try {
      items = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const q = path.join(p, it.name);
      try {
        if (it.isDirectory()) walk(q, depth + 1);
        else total += fs.statSync(q).size;
      } catch {}
    }
  };
  walk(dir, 0);
  return total;
}
async function uninstallRun() {
  const cfg = loadConfig();
  const dir = cfg.installDir || "";
  const errors = [];
  stopBlender({ reason: "卸载插件" });
  try {
    await removeMcpRow();
  } catch (e) {
    errors.push("撤 MCP 行：" + String((e && e.message) || e));
  }
  if (cfg.blenderVersion) {
    const addon = path.join(addonsDirOf(cfg.blenderVersion), "blender_mcp.py");
    try {
      if (exists(addon)) fs.unlinkSync(addon);
    } catch (e) {
      errors.push("删 addon：" + String((e && e.message) || e));
    }
  }
  const safe = isSafeInstallDir(dir);
  if (dir && safe.ok) {
    try {
      fs.rmSync(safe.path, { recursive: true, force: true });
    } catch (e) {
      errors.push("删安装目录：" + String((e && e.message) || e));
    }
  } else if (dir) {
    errors.push("拒绝删除不在白名单里的目录：" + dir);
  }
  try {
    if (exists(pluginRoot())) fs.rmSync(pluginRoot(), { recursive: true, force: true });
  } catch {}
  closeConsoleWindow();
  appendConsole("[uninstall] 完成 errors=" + errors.length);
  return { ok: errors.length === 0, installDir: dir, errors };
}

/* ------------------------------------------------------------------ */
/* 自检内核（安装窗「安装后自检」）                                      */
/* ------------------------------------------------------------------ */
function selfcheckBlender() {
  const st = statusForUi();
  const items = [
    { key: "blender", label: "Blender 本体", ok: !!st.installed, detail: st.blenderExe || "未找到 blender.exe" },
    { key: "addon", label: "MCP for Blender addon", ok: !!st.addonInstalled, detail: st.addonPath || "addon 未落盘" },
    { key: "uv", label: "uv / uvx", ok: !!(st.uvPath && st.uvxPath), detail: st.uvxPath || "未找到 uvx.exe" },
    { key: "mcp", label: "MCP 注册（cordis-user.yml）", ok: !!st.mcpRegistered, detail: "serverName=blender · port=" + (st.mcpPort || "?") },
  ];
  return { ok: items.every((i) => i.ok), items, summary: items.map((i) => (i.ok ? "✓ " : "✗ ") + i.label + "：" + i.detail) };
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
function registerBlenderIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  if (typeof opts.getDsh === "function") getDsh = opts.getDsh;
  appRoot = opts.appRoot || appRoot;

  mk(pluginRoot());
  const cfg = loadConfig();
  if (!cfg.installDir) {
    try {
      const def = installHost.installDirOf(PLUGIN_ID);
      if (def) saveConfig({ installDir: def });
    } catch {}
  }
  appendConsole("[boot] 宿主注册（installed=" + !!statusForUi().installed + "）");

  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    skillName: SKILL_NAME,
    getInstallDir: () => loadConfig().installDir,
    tailConsole: () => consoleTail(80).join("\n"),
    selfRepair: async () => {
      appendConsole("[repair] 自动修复：补 uv / addon / MCP 行");
      const st = statusForUi();
      if (!st.installed) return { ok: false, error: "blender_missing", message: "Blender 本体没装：请走安装窗。" };
      const uv = await ensureUv((l) => appendConsole(l));
      if (!uv.ok) return { ok: false, error: "uv_install_failed", message: uv.detail || uv.error };
      const addon = await installAddon({ uvPath: uv.path, addonsDir: addonsDirOf(st.blenderVersion), onLine: (l) => appendConsole(l) });
      if (!addon.ok) return { ok: false, error: "addon_install_failed", message: addon.detail || addon.error };
      const en = await enableAddon(st.blenderExe, st.blenderVersion, (l) => appendConsole(l));
      if (!en.ok) return { ok: false, error: "addon_enable_failed", message: en.detail || en.error };
      const pk = await pickPort(loadConfig().port || 0);
      if (!pk.ok) return { ok: false, error: "no_free_port", message: "9876–9886 都被占用" };
      const wr = await writeMcpRow(uvxOf(uv.path), pk.port);
      if (!wr.ok) return { ok: false, error: "mcp_register_failed", message: wr.detail || wr.error };
      saveConfig({ port: pk.port, mcpRegistered: true });
      return { ok: true, note: "已补好 uv / addon / MCP（端口 " + pk.port + "），重启 MTNode 生效" };
    },
  });

  installHost.registerInstallTarget({
    id: PLUGIN_ID,
    key: "blender",
    name: PLUGIN_NAME,
    skill: SKILL_NAME,
    kindLabel: "本地应用 + MCP",
    packRoots: [__dirname],
    getInstallDir: () => loadConfig().installDir || installHost.installDirOf(PLUGIN_ID),
    cancel: () => cancelInstall(),
  });

  try {
    registerPluginSelfcheck({
      id: PLUGIN_ID,
      key: "blender",
      label: PLUGIN_NAME,
      kind: "blender",
      check: async () => selfcheckBlender(),
    });
  } catch (e) {
    appendConsole("[boot] 自检登记失败：" + String((e && e.message) || e));
  }

  const handle = (ch, fn) =>
    ipcMain.handle(API + ":" + ch, async (e, arg) => {
      try {
        return await fn(arg || {});
      } catch (err) {
        const msg = String((err && err.message) || err);
        appendConsole("[ipc] " + ch + " 失败：" + msg);
        return { ok: false, error: "exception", message: msg };
      }
    });

  handle("getStatus", () => statusForUi());
  handle("install", (arg) => installBackend(arg));
  handle("pickInstallDir", () => pickDir());
  handle("open", () => openConsoleWindow());
  handle("close", () => closeConsoleWindow());
  handle("start", async () => {
    const st = statusForUi();
    if (!st.installed) return { ok: false, error: "blender_missing", message: "还没装 Blender：先点安装。" };
    if (blenderRunningPid()) return { ok: true, already: true, pid: blenderRunningPid() };
    const pk = await pickPort(loadConfig().port || 0);
    if (!pk.ok) return { ok: false, error: "no_free_port" };
    const r = launchBlender({ port: pk.port });
    if (r.ok) saveConfig({ port: pk.port });
    return r;
  });
  handle("stop", () => stopBlender({ reason: "控制台停用" }));
  handle("checkUpdate", async () => {
    try {
      const latest = await resolveLatestOfficial();
      saveConfig({ lastVersionCheck: Date.now(), latestSeen: latest.version, latestSource: "official" });
      const cur = loadConfig().blenderVersion;
      return { ok: true, latest: latest.version, current: cur, newer: !!(latest.version && cur && cmpVer(latest.version, cur) > 0), note: "本插件不自动升级：已装就跳过。" };
    } catch (e) {
      return { ok: false, error: "index_unreachable", message: String((e && e.message) || e) };
    }
  });
  handle("smoke", async () => {
    if (smokeJob) return { ok: false, error: "busy" };
    const st = statusForUi();
    const uvx = uvxOf(st.uvPath) || uvxOf(findUv());
    if (!st.installed || !uvx) return { ok: false, error: "not_ready" };
    smokeJob = { startedAt: Date.now() };
    try {
      const port = st.port || PORT_BASE;
      const wasRunning = blenderRunningPid();
      if (!wasRunning) {
        const lr = launchBlender({ port });
        if (!lr.ok) return lr;
      }
      const up = await waitPort(port, 120000);
      if (!up) return { ok: false, error: "socket_timeout", message: "addon 没监听端口 " + port };
      const ping = await addonPing(port, 20000);
      if (!ping.ok) return { ok: false, error: ping.error, message: ping.detail || "" };
      const hs = await mcpHandshake(uvx, port, 90000);
      if (!wasRunning) stopBlender({ reason: "手动冒烟完成" });
      return hs.ok ? { ok: true, tools: hs.tools, names: hs.names } : { ok: false, error: hs.error, message: hs.detail || hs.log };
    } finally {
      smokeJob = null;
    }
  });
  handle("consoleTail", (arg) => ({ ok: true, lines: consoleTail(arg && arg.n) }));
  handle("consoleClear", () => {
    consoleClear();
    return { ok: true };
  });
  handle("uninstallPreview", () => uninstallPreview());
  handle("uninstall", () => uninstallRun());
  handle("revealInstallDir", () => {
    const d = loadConfig().installDir;
    if (!d || !exists(d)) return { ok: false, error: "missing" };
    try {
      shell.openPath(d);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  handle("removePluginMeta", () => removePluginMetaOnly());
  handle("restartRequiredHint", () => ({ ok: true, text: "MCP 配置在 MTNode 启动时读取：装完请重启应用，Agent 会话里才会出现 blender 工具。" }));
}

function pickDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 Blender 安装目录（便携包会解压到这里）",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || installHost.installDirOf(PLUGIN_ID) || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error, message: safe.message || "这个目录不能用：" + safe.error };
  saveConfig({ installDir: safe.path });
  return { ok: true, installDir: safe.path, project: { blender: findBlenderExe(safe.path) } };
}

/** 取消安装：置取消标志（安装链在下一个检查点收手）+ 强杀安装期间拉起的子进程，
 *  冒烟阶段拉起的 Blender 也一并关掉（那是插件拉起的实例，不是用户自己开的）。
 *  这里**不**把 installing 放开：链还在收尾，放开会让「重试」起第二条链与它并行跑。
 *  下载是流式的，取消后下一次从断点续传。 */
async function cancelInstall() {
  installCancelled = true;
  uiBusy = "";
  appendConsole("[install] 用户取消");
  try {
    if (blenderRunningPid()) stopBlender({ reason: "用户取消" });
  } catch {}
  try {
    return await installKill.cancelInstall(PLUGIN_ID);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function removePluginMetaOnly() {
  closeConsoleWindow();
  try {
    const ui = path.join(pluginRoot(), "ui");
    if (exists(ui)) fs.rmSync(ui, { recursive: true, force: true });
  } catch {}
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

/** MTNode 退出：只回收插件拉起的 Blender（用户手开的不动）；MCP 配置保持不动 */
function shutdownBlenderUiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  const pid = blenderRunningPid();
  if (pid) {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      appendConsole("[quit] 已关闭插件拉起的 Blender pid=" + pid);
    } catch {}
  }
  blenderChild = null;
  return { ok: true };
}

module.exports = {
  registerBlenderIpc,
  shutdownBlenderUiOnly,
  statusForUi,
  selfcheckBlender,
  /* 纯逻辑出口（冒烟测试用假 electron 加载本文件后直呼） */
  __internals: {
    PLUGIN_ID,
    KNOWN_VERSIONS,
    resolveLatestOfficial,
    resolveFromKnown,
    cmpVer,
    mcpStatus,
    writeMcpRow,
    removeMcpRow,
    addonsDirOf,
    blenderConfigBase,
    isSafeInstallDir,
    pickPort,
    portFree,
    findBlenderExe,
    flattenSingleDir,
    guessInstalledVersion,
    mcpHandshake,
    statusForUi,
    cancelInstall,
    cancelledExit,
    cancelState: () => ({ cancelled: !!installCancelled, installing: !!installState.installing }),
    overrideDirs: (o) => {
      if (o && o.getDataDir) getDataDir = o.getDataDir;
      if (o && o.getMainWin) getMainWin = o.getMainWin;
    },
  },
};

"use strict";
/**
 * Paseo 手机接管 · 主进程宿主（应用插件 kind = paseo，id = paseo-remote）
 *
 * ── 它解决什么 ───────────────────────────────────────────────────────────
 * MTNode 里本来就有「会话桥」（paseo/acp-bridge.mjs + session-bridge.js + 渲染层那一半），
 * 但接入全靠手工：自己装 Paseo、自己把 provider 片段粘进 ~/.paseo/config.json、自己跑 reload，
 * 配对二维码还要去 Paseo 自己的界面里找。本宿主把那三步做进插件的控制台窗：
 *   1. **认后端**：优先复用本机已装的 Paseo（Desktop 自带 resources\bin\paseo.cmd，或 PATH 里的 paseo）；
 *      检测不到才在用户选定目录 `npm i @getpaseo/cli` 装一份独立后端（常驻，不随 MTNode 退出）。
 *   2. **配对二维码**：调官方 `paseo daemon pair --json` 拿 url，交给控制台自己画成清晰二维码
 *      （官方返回的 qr 是带 ANSI 的终端字符画，塞进 Electron 界面会变形，故不用它）。
 *   3. **注册 provider**：用官方 CLI `paseo daemon config set agents.providers.mtnode '<json>'`
 *      （官方负责合并与自动 reload），移除走同一条路的 `config unset` —— 不手改用户配置文件。
 *
 * ── 几条硬口径（都在代码里落实，改前先看这里）──────────────────────────────
 *   · 只碰会话层：本宿主不画布、不节点、不动 mtnode 的其它设置；唯一的例外是「本机服务端」
 *     那一颗一键开启按钮（桥的会话族正是走它，用户点了才开，不静默改）。
 *   · 「远程连接」总开关**默认关**：关着时会话族一律拒绝（gate 注入给 mcp-server.js），
 *     配对完由用户在控制台里打开 —— 不给人一个「装好就已经能被远程读会话」的默认态。
 *   · 「断开所有远程设备」只断 MTNode 这一侧的接管（关总开关 + 收掉所有 SSE 观察者）；
 *     配对凭据（二维码里的 offer）在手机里，MTNode 撤不掉 —— 真要作废走「重置配对凭据」，
 *     它重新生成 daemon 密钥（**会作废所有已配对设备**，UI 上必须二次确认）。
 *   · daemon 不随 MTNode 退出（与 llama / music3 那族单例后端同一口径）：手机随时要用，
 *     宿主退出时只关控制台窗；要停后端走控制台上的「停止后端」。
 *   · 用户数据只落 %APPDATA%\pipeline-console\app-plugins\paseo-remote（config / 日志 / 自建后端）。
 *
 * 新增根目录之外的模块：paseo/** 已在 build.json 的 files 白名单里（本轮扩成整目录）。
 */
const { BrowserWindow, ipcMain, dialog, screen, app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 指路），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");
/* 桥的落点与 provider 片段单一真源（与 paseo/acp-bridge.mjs 的 --config / --check 同一份） */
const bridgeInfo = require("./bridge-info.js");
/* 国内镜像源单一真源（npm registry 等）：自建后端走 npm install 时用它的 installEnv */
const mirrors = require("../cn-mirrors.js");
/* 真 Node 的选择口径（dsh 用同一份）：桥必须由**真 Node**拉起，Electron 自带的那个不算 */
const dshNode = require("../dsh-node.js");

const PLUGIN_ID = "paseo-remote";
const KIND = "paseo";
/** 配套的安装 / 修复 skill 名（真源在仓库根 skills/paseo-remote-install/SKILL.md，随包内置） */
const INSTALL_SKILL = "paseo-remote-install";
/** 官方后端包名（npm 公开包，Apache-2.0；见 docs 与调研记录） */
const NPM_PACKAGE = "@getpaseo/cli";
/** 官方 relay（写进 provider 之外的配置不改；这里只用于文案与自检提示） */
const RELAY_ENDPOINT = "relay.paseo.sh:443";
/** CLI 调用的默认超时：pair / config 这类短命令用 20 秒，起 daemon 用 120 秒 */
const CLI_TIMEOUT_MS = 20000;
const DAEMON_START_TIMEOUT_MS = 120000;
/** 自检（`paseo --version`）超时：真 Node 冷启动也够，失败时用户不必干等 */
const CLI_PROBE_TIMEOUT_MS = 15000;
/** 等「真 Node」就位的上限（dsh 的后台托管安装要下载解包，实测 20~40 秒量级） */
const NODE_WAIT_MS = 90000;

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
/** 取 MCP 服务端宿主（main.js 注入）：只用来读状态、一键开启、收掉会话 SSE 观察者 */
let getMcp = null;
let consoleWin = null;
/** 正在跑的安装 / 起停（UI 置灰与状态行用） */
let busy = "";
let pairCache = null;

/* ------------------------------------------------------------------ */
/* 路径 / JSON / 日志                                                   */
/* ------------------------------------------------------------------ */
function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}
/** 数据目录：宿主注册时注入；没注册（隔离安装测试 / 修复脚本）时读 MTNODE_DATA_DIR */
function dataDir() {
  let d = "";
  try {
    d = typeof getDataDir === "function" ? getDataDir() : "";
  } catch (e) {
    d = "";
  }
  if (!d) d = String(process.env.MTNODE_DATA_DIR || "");
  if (!d) throw new Error("数据目录未注入（registerPaseoRemoteIpc 的 getDataDir）");
  return d;
}
function pluginRoot() {
  return mk(join(dataDir(), "app-plugins", PLUGIN_ID));
}
function configPath() {
  return join(pluginRoot(), "config.json");
}
function consoleLogPath() {
  return join(pluginRoot(), "console.log");
}
function uiEntry() {
  const packed = join(pluginRoot(), "ui", "index.html");
  if (exists(packed)) return packed;
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
    /** "reuse" = 用本机已装的 Paseo；"own" = 用插件自己装的那份（独立 home） */
    mode: "reuse",
    /** 自建后端的安装目录（npm --prefix），仅 mode=own 用 */
    installDir: "",
    /** 自建后端的 daemon home（与用户 ~/.paseo 隔离，避免抢 6767 端口与配对身份） */
    ownHome: "",
    /** 远程连接总开关：默认关（配对完由用户打开） */
    remoteEnabled: false,
    /** 上一次配对二维码生成时间（UI 提示「刚生成 / 可能已过期」用，不做自动失效） */
    lastPairAt: 0,
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

function appendConsole(line) {
  const text = String(line == null ? "" : line).replace(/\r?\n$/, "");
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.appendFileSync(p, text + "\n", "utf8");
    const st = fs.statSync(p);
    if (st.size > 1024 * 1024) fs.writeFileSync(p, fs.readFileSync(p, "utf8").slice(-512 * 1024), "utf8");
  } catch {
    /* 日志写不进去不该拖住主流程 */
  }
  broadcast("paseoRemote:console", { line: text });
}
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    } catch {}
  }
}
function consoleTail(maxBytes) {
  try {
    const p = consoleLogPath();
    if (!exists(p)) return { ok: true, text: "" };
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
function clearConsoleLog() {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.writeFileSync(p, "", "utf8");
    broadcast("paseoRemote:consoleCleared", { at: Date.now() });
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 失败上报：控制台窗只有开着的人看得到，同一次失败同时送报错总线（主窗口报告 + 指路） */
function reportErr(code, message, extra) {
  try {
    pluginErrors.reportPluginError(
      PLUGIN_ID,
      Object.assign({ code: String(code || ""), message: String(message || "") }, extra || {}),
    );
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 后端检测：CLI / home / daemon / relay                                */
/* ------------------------------------------------------------------ */
/* ── 隔离测试用的路径注入 ────────────────────────────────────────────────
 * 「未装 Paseo 的新客户机」这类现场没法在开发机上凭空造出来（本机通常装着 Paseo 桌面端），
 * 所以把「去哪找 Paseo」做成可注入：`MTNODE_PASEO_DIRS`（path.delimiter 分隔的目录列表）。
 * 非空时，desktop CLI 候选只看这些目录，`where paseo` 的 PATH 探测也一并关掉 ——
 * 于是测试可以用一个空目录模拟「这台机器上什么都没有」，用桩 CLI 模拟「装好了」。
 * 只有「去哪找 Paseo」被改口径：**PATH 本身不动**（npm / where 这些还得照常用，
 * 否则模拟出来的不是「没装 Paseo 的机器」，而是「连 Node 都没有的废机器」）。
 * 空着（默认）时行为与过去完全一致。这是**测试钩子**，不是用户配置项。
 * ─────────────────────────────────────────────────────────────────────── */
function overrideDirs() {
  try {
    return String(process.env.MTNODE_PASEO_DIRS || "")
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
function homeDir() {
  return process.env.MTNODE_PASEO_USERPROFILE || process.env.USERPROFILE || process.env.HOME || os.homedir();
}
/** 本机 Paseo 的 home：复用模式 = ~/.paseo；自建模式 = 插件数据目录下的独立 home */
function paseoHomeOf(cfg) {
  const c = cfg || loadConfig();
  if (c.mode === "own") return String(c.ownHome || join(pluginRoot(), "paseo-home"));
  return join(homeDir(), ".paseo");
}
/** Desktop 自带的 CLI 候选（官方安装包的 resources\bin\paseo.cmd；支持 allusers / currentuser 两种落点） */
function desktopCliCandidates() {
  const injected = overrideDirs();
  if (injected.length) return injected.map((d) => join(d, "resources", "bin", "paseo.cmd"));
  const out = [];
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "";
  const local = process.env.LOCALAPPDATA || "";
  out.push(join(pf, "Paseo", "resources", "bin", "paseo.cmd"));
  if (pf86) out.push(join(pf86, "Paseo", "resources", "bin", "paseo.cmd"));
  if (local) out.push(join(local, "Programs", "Paseo", "resources", "bin", "paseo.cmd"));
  return out;
}
function wherePaseoCli() {
  if (overrideDirs().length) return "";
  try {
    const r = spawnSync("where", ["paseo"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    if (r.status !== 0) return "";
    const first = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
    return first;
  } catch {
    return "";
  }
}
/** 自建模式 CLi 落点（npm --prefix 的 bin shim） */
function ownCliPath(cfg) {
  const c = cfg || loadConfig();
  return c.installDir ? join(c.installDir, "node_modules", ".bin", "paseo.cmd") : "";
}
/**
 * CLI 解析：自建模式优先用自己装的那份；**自己那份不可用时回落到本机已装的 Paseo**
 * （own 模式过去的死胡同：installDir 选错 / 装了一半，此后一律 cli_missing，且无路可退）。
 * fallback=false 时只认自有那份 —— 供「安装自检」这类必须确认确实是自建那份的场合用。
 */
function resolveCli(cfg, opts) {
  const c = cfg || loadConfig();
  const ownOnly = !!(opts && opts.ownOnly);
  if (c.mode === "own") {
    const own = ownCliPath(c);
    if (exists(own)) return { cli: own, source: "own" };
    if (ownOnly) return { cli: "", source: "" };
  }
  for (const p of desktopCliCandidates()) if (exists(p)) return { cli: p, source: "desktop" };
  const w = wherePaseoCli();
  if (w && exists(w)) return { cli: w, source: "path" };
  return { cli: "", source: "" };
}
/** 本机是否还装着别的 Paseo（own 模式走不通时给用户的一键回落出口） */
function reuseCandidate() {
  const cli = resolveCli({ mode: "reuse" });
  if (cli.cli) return { available: true, cli: cli.cli, source: cli.source };
  return { available: false, cli: "", source: "" };
}
/* ── 跑 npm / CLI 用的那份 Node（本轮新增）────────────────────────────────
 * 现场（用户设备，2026-10）：`npm i @getpaseo/cli --prefix <dir>` 在这台机器上「装成功」，
 * 但 CLI 一跑就崩 —— PATH 里的 Node 是 **v18.13.0 / npm 8.19.3**，而依赖链要 Node ≥20
 * （传递依赖 @vercel/oidc@3.0.3），npm 只给一串 `EBADENGINE` 警告就放行，装出来的
 * `.bin\paseo.cmd` 走 PATH 那份 node，于是界面只能报 `cli_not_runnable`「CLI 装上了但跑不起来」。
 *
 * 口径（本轮共识）：
 *   1. 能拿到真 Node（≥ NODE_MIN_VERSION）就用**它**跑 npm 与 CLI（不经 .cmd shim，
 *      免得又落回 PATH 里那份旧 Node）；
 *   2. 缺 Node 或版本过旧 → 复用 dsh 那套托管安装（dsh-node.js 的 installManagedNode）
 *      自动下一份真 Node 到 `<数据目录>\node-runtime`，与 dsh 共用同一份，不另建目录；
 *   3. Node 下不来（内网/断网）→ **直接拒绝安装**，并说清卡在哪一步；
 *      绝不退回「先用旧 Node 试着装」—— 那正是这次出问题的姿势。
 *
 * 不改 dsh-node.js、也不改它的解析结果：paseo 只是**再解析一次**（多一条「本地那份 Node 到底是
 * PATH 的旧版本还是托管的够版本」的判断，供自动安装决策用）。
 * ─────────────────────────────────────────────────────────────────────── */
const NODE_MIN_VERSION = String(dshNode.NODE_MIN_VERSION || "22.19.0");
/** 托管安装的目标版本：与 dsh 完全一致（同一份 dsh-node.js 常量） */
const MANAGED_NODE_VERSION = String(dshNode.MANAGED_NODE_VERSION || "22.22.1");
/** Node 自动安装允许的耗时（下载 + 解包；dsh 侧实测 20~40 秒，给足余量） */
const NODE_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** 真 Node 的判定：与 dsh 同一份探针口径（能跑、不是 Electron、版本 ≥ NODE_MIN_VERSION） */
function probeNodeKind(bin) {
  if (!bin || !exists(bin)) return { ok: false, reason: "missing", version: "" };
  try {
    return dshNode.probeNodeBin(bin, { fresh: true });
  } catch (e) {
    return { ok: false, reason: "probe-failed", version: "", error: String((e && e.message) || e) };
  }
}
/** `<nodeDir>\node_modules\npm\bin\npm-cli.js`（POSIX 布局在上一级 lib，一并试） */
function npmCliOf(nodeBin) {
  const dir = path.dirname(String(nodeBin || ""));
  if (!dir) return "";
  const cands = [
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of cands) if (exists(c)) return c;
  return "";
}
/** 与解析出的 Node 配套的 npm：`<真 Node> <npm-cli.js>`（不经 npm.cmd，也就不受 PATH 影响） */
function npmSpecFor(nodeBin) {
  const cli = npmCliOf(nodeBin);
  if (!cli) return null;
  return { node: String(nodeBin), cli, args: [cli] };
}
/** 自建后端的 CLI 入口（npm 的 bin 目标 `bin/paseo`，无扩展名，由真 Node 直跑） */
function ownCliEntry(cfg) {
  const c = cfg || loadConfig();
  return c.installDir ? join(c.installDir, "node_modules", NPM_PACKAGE, "bin", "paseo") : "";
}
/** 自建那份 CLI 的调用姿势：真 Node + 入口（拿不到真 Node 时才退回 .cmd shim） */
function ownCliSpec(runtime, cfg) {
  const node = String((runtime && runtime.bin) || "");
  const entry = ownCliEntry(cfg);
  if (node && exists(node) && exists(entry)) return { node, args: [entry] };
  return null;
}
/** 真 Node 缺失 / 过旧时统一的一句话（三条出口：自动装、自己装、改用桌面端） */
function nodeRuntimeMsg(rt) {
  const have = String((rt && rt.version) || "");
  const tail =
    "装 Node ≥" + NODE_MIN_VERSION + " 后重试，或在控制台点「等真 Node 就位」让插件把 Node 装进数据目录，" +
    "或改用本机已装的 Paseo 桌面端。";
  if (rt && rt.error === "download-failed") return "本机 Node 版本/可用性不达标" + (have ? "（现在是 " + have + "）" : "") + "，而自动安装 Node 失败（下载不通）。" + tail;
  if (rt && rt.error === "install-failed") return "本机 Node 版本/可用性不达标" + (have ? "（现在是 " + have + "）" : "") + "，自动安装 Node 也没成功。";
  return "本机没有可用的真 Node（≥" + NODE_MIN_VERSION + "）" + (have ? "：现在只有 " + have : "") + "。";
}
/** 当前该用哪份 Node 跑 npm 与 CLI（只查、不装） */
function pickNodeRuntime(opts) {
  const o = opts || {};
  const data = dataDir();
  const managedBin = join(data, dshNode.MANAGED_DIR || "node-runtime", process.platform === "win32" ? "node.exe" : "node");
  const managedProbe = probeNodeKind(managedBin);
  const fromPath = String((process.env.PATH || process.env.Path || "").split(path.delimiter).map((s) => String(s || "").trim().replace(/^"+|"+$/g, "")).filter(Boolean)[0] || "");
  const pathBin = fromPath ? join(fromPath, process.platform === "win32" ? "node.exe" : "node") : "";
  const pathProbe = pathBin ? probeNodeKind(pathBin) : { ok: false, reason: "missing", version: "" };
  const explicit = String(process.env.MTNODE_NODE_BIN || "");
  if (explicit) {
    const p = probeNodeKind(explicit);
    if (p.ok) return { ready: true, bin: explicit, version: p.version, source: "env:MTNODE_NODE_BIN" };
    return {
      ready: false,
      reason: p.reason === "too-old" ? "too_old" : "unusable",
      version: String(p.version || ""),
      managedBin,
      managed: false,
      devOverride: explicit,
    };
  }
  if (managedProbe.ok) return { ready: true, bin: managedBin, version: managedProbe.version, source: "managed" };
  if (pathProbe.ok) return { ready: true, bin: pathBin, version: pathProbe.version, source: "path" };
  let resolved = null;
  try {
    resolved = dshNode.resolveDshNode({ dataDir: data, refresh: !!o.refresh, log: (l) => appendConsole(l) });
  } catch {
    resolved = null;
  }
  if (resolved && resolved.bin && !resolved.electron) {
    const p = probeNodeKind(resolved.bin);
    if (p.ok) return { ready: true, bin: resolved.bin, version: p.version, source: resolved.source || "resolved" };
  }
  const why = managedProbe.reason === "too-old" || pathProbe.reason === "too-old" ? "too_old" : "missing";
  return {
    ready: false,
    reason: why,
    version: String(managedProbe.version || pathProbe.version || ""),
    managedBin,
    managed: !!(managedProbe.version && !managedProbe.ok && /too-old/.test(String(managedProbe.reason || ""))),
  };
}
/**
 * 确保有可用的真 Node：缺 / 过旧就自动装一份（dsh 的托管安装，同一份 22.22.1、同一个目录）。
 * 返回 `{ ok, bin, version, source, installed?, error? }`；**装不上就是失败**，调用方据此拒绝安装。
 */
async function ensureNodeRuntime(opts) {
  const o = opts || {};
  const first = pickNodeRuntime(o);
  if (first.ready) return { ok: true, bin: first.bin, version: first.version, source: first.source, installed: false };
  if (first.devOverride) {
    appendConsole("[node] 本机 Node 不达标（" + (first.version || first.reason) + "）→ 自动装一份 Node " + MANAGED_NODE_VERSION);
  } else {
    appendConsole("[node] 没有达标的真 Node（≥" + NODE_MIN_VERSION + "）→ 自动装一份 Node " + MANAGED_NODE_VERSION);
  }
  broadcast("paseoRemote:progress", { phase: "node", message: "自动安装 Node " + MANAGED_NODE_VERSION + "（下载 + 解包，几十 MB，稍等）…" });
  let r = null;
  try {
    r = await withTimeout(
      Promise.resolve(
        dshNode.installManagedNode({
          dataDir: dataDir(),
          version: MANAGED_NODE_VERSION,
          log: (l) => {
            appendConsole(l);
            broadcast("paseoRemote:progress", { phase: "node", message: String(l).slice(0, 200) });
          },
        }),
      ),
      NODE_INSTALL_TIMEOUT_MS,
      "node_install_timeout",
    );
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  if (!r || !r.ok) {
    const disabled = /disabled|download-failed/i.test(String((r && r.error) || ""));
    appendConsole("[node] 自动安装 Node 失败：" + String((r && r.error) || "unknown") + " → 拒绝安装（不退回旧 Node）");
    return {
      ok: false,
      error: disabled ? "download-failed" : "install-failed",
      version: String(first.version || ""),
      detail: String((r && r.error) || "unknown"),
    };
  }
  appendConsole("[node] 托管 Node 就位：" + r.bin + "（" + String(r.version || "") + "）");
  /* 刚装好：清掉两边缓存再解析一次，免得拿到「装之前」的旧结论 */
  nodeRuntimeCache = null;
  try {
    dshNode.resetDshNodeCache();
  } catch {}
  const again = pickNodeRuntime({ refresh: true });
  if (again.ready) return { ok: true, bin: again.bin, version: again.version, source: again.source, installed: true };
  return { ok: true, bin: r.bin, version: String(r.version || ""), source: "managed", installed: true };
}
/** 超时包装（Node 下载卡住时不让安装窗无限等；dsh 的下载自己还有 180s 超时） */
function withTimeout(promise, ms, code) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(code));
    }, Number(ms) || 1000);
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
/** stderr 里的 `current: { node: 'v18.13.0' … }`（npm 的 EBADENGINE 现场） */
function nodeVersionFromText(text) {
  const m = /node['":\s]+v?(\d+\.\d+\.\d+)/i.exec(String(text || ""));
  return m ? m[1] : "";
}
/**
 * 跑一次 `<cli> --version` 判断这份 CLI 到底能不能用（返回版本号或空）。
 * runtime（真 Node）优先：`.cmd` shim 会去 PATH 找 node，那正是旧 Node 现场的病根。
 */
async function cliVersionOf(cli, opts) {
  const o = opts || {};
  if (!cli || !exists(cli)) return { ok: false, version: "", code: -1, detail: "CLI 文件不在" };
  const nodeBin = String(o.node || "");
  const viaNode = !!(nodeBin && exists(nodeBin));
  const r = viaNode
    ? await spawnCli(nodeBin, [cli, "--version"], { timeoutMs: o.timeoutMs || CLI_PROBE_TIMEOUT_MS })
    : await spawnCli(cli, ["--version"], { timeoutMs: o.timeoutMs || CLI_PROBE_TIMEOUT_MS });
  const out = String(r.stdout || "").trim();
  const version = out.split(/\s+/).filter(Boolean).pop() || "";
  const ok = !!r.ok && /^\d+\.\d+/.test(version);
  const rawDetail = String(r.stderr || out || "没拿到版本号");
  return {
    ok,
    version: ok ? version : "",
    code: r.code,
    viaNode,
    detail: ok ? "" : rawDetail.slice(-200),
    /* 跑不起来的原因是「机型里的 Node 太旧」时单独标出来（界面据此说人话） */
    nodeTooOld: !ok && !!nodeVersionFromText(rawDetail) && !dshNode.versionAtLeast(nodeVersionFromText(rawDetail), NODE_MIN_VERSION),
    sawNodeVersion: nodeVersionFromText(rawDetail),
  };
}
/**
 * 自检「这份 CLI 到底能不能报版本」：首选 `<真Node> <入口>`（正是运行时真正会走的那条路），
 * 失败且入口与 shim 不是同一个文件时再给 shim 一次机会 —— 有的机器上 npm 只生成了 `.bin\*.cmd`。
 */
async function cliVersionAny(entry, shim, nodeBin) {
  const first = await cliVersionOf(entry, { node: nodeBin });
  if (first.ok) return first;
  if (shim && shim !== entry && exists(shim)) {
    const second = await cliVersionOf(shim, { node: nodeBin });
    if (second.ok) return second;
    /* 两条都失败：把「更像根因」的那条报上去（Node 太旧的判据优先） */
    return second.nodeTooOld && !first.nodeTooOld ? second : first;
  }
  return first;
}
/**
 * 自建后端「装好了没」：CLI 入口在位 + 真能报版本（不再只看 node_modules 目录在不在）。
 * `opts.node` = 用来跑 CLI 的那份真 Node（拿得到就用它，不经 .cmd shim）；拿不到时退回 shim，
 * 但此时若 CLI 报的是「Node 版本太旧」，原因记为 `node_too_old`（界面据此给可操作出口）。
 */
async function verifyOwnInstall(cfg, opts) {
  const c = cfg || loadConfig();
  const o = opts || {};
  const cli = ownCliPath(c);
  const entry = ownCliEntry(c);
  const dep = c.installDir ? join(c.installDir, "node_modules", NPM_PACKAGE) : "";
  const depExists = exists(dep);
  const nodeBin = String(o.node || "");
  const target = nodeBin && exists(nodeBin) && exists(entry) ? entry : cli;
  if (!exists(target)) {
    return { ok: false, cli, entry, dep, depExists, version: "", reason: depExists ? "cli_bin_missing" : "dep_missing" };
  }
  const v = await cliVersionAny(target, cli, nodeBin);
  if (v.ok) return { ok: true, cli, entry, dep, depExists, version: v.version, reason: "", detail: "", viaNode: v.viaNode };
  /* 跑不起来 + 已知「跑它的那份 Node」不达标 → 原因归到 node_too_old（界面走「清干净重装」那条出口）。
     注意：**不知道**跑它的 Node 是多少（节点版本没传）时不能推定太旧 —— 否则会把「CLI 自己坏了」
     误报成 node_too_old（现场那种半成品就会被指错方向）。 */
  const knownBad =
    !nodeBin && !!o.nodeVersion && !dshNode.versionAtLeast(String(o.nodeVersion || ""), NODE_MIN_VERSION);
  const tooOld = !!v.nodeTooOld || knownBad;
  return {
    ok: false,
    cli,
    entry,
    dep,
    depExists,
    version: "",
    reason: tooOld ? "node_too_old" : "cli_not_runnable",
    detail: v.detail,
    viaNode: v.viaNode,
    sawNodeVersion: v.sawNodeVersion || "",
  };
}
/** 真 Node（桥的 command 第一条必须是它）：与 dsh 同一份解析口径 */
function realNode() {
  try {
    return dshNode.resolveDshNode({ dataDir: dataDir(), log: (l) => appendConsole(l) });
  } catch (e) {
    return { bin: process.execPath, source: "electron-fallback", version: process.versions.node, electron: true };
  }
}
function nodeReadyOf(n) {
  return !!n && !!n.bin && !n.electron;
}
function nodeMissingMsg(n) {
  const v = String((n && n.version) || process.versions.node || "");
  return (
    "本机没有可用的真 Node（≥" +
    String(dshNode.NODE_MIN_VERSION || "22.19.0") +
    "）：现在只找到 Electron 自带的 Node " +
    v +
    "，Paseo 拉起桥时会拒绝它。" +
    "装上 Node（或等 dsh 的托管 Node 装好）后重试。"
  );
}
/**
 * 等「真 Node」就位（最多 NODE_WAIT_MS）。
 * 为什么值得等：dsh 找不到真 Node 时会在后台把托管 Node 装进数据目录（下载 + 解包，实测 20~40 秒），
 * 而 provider 片段里的 command[0] 必须是真 Node —— 这段窗口里若直接注册，写进去的就是 Electron 可执行文件，
 * 表现为「provider 注册成功但手机上一个会话都建不起来」。宁可在这里等一等，也别写一份错的配置。
 * 不主动装、不改 dsh-node.js：只轮询它的解析结果（用户口径：不动 dsh 本体）。
 */
async function waitRealNode(opts) {
  const o = opts || {};
  const budget = Number(o.timeoutMs) || NODE_WAIT_MS;
  const t0 = Date.now();
  let n = realNode();
  if (nodeReadyOf(n)) return { ok: true, node: n, waitedMs: 0 };
  broadcast("paseoRemote:progress", { phase: "node", message: "等真 Node 就位（dsh 托管安装可能正在后台跑）…" });
  appendConsole("[node] 暂时只有 Electron 自带的 Node，开始等真 Node（上限 " + Math.round(budget / 1000) + "s）");
  while (Date.now() - t0 < budget) {
    if (!o.keepWaiting || !o.keepWaiting()) break;
    await new Promise((r) => setTimeout(r, 2000));
    n = realNode();
    if (nodeReadyOf(n)) {
      appendConsole("[node] 真 Node 已就位：" + n.bin + "（" + String(n.version || "") + "，" + Math.round((Date.now() - t0) / 1000) + "s）");
      return { ok: true, node: n, waitedMs: Date.now() - t0 };
    }
  }
  appendConsole("[node] 等不到真 Node：" + nodeMissingMsg(n));
  return { ok: false, node: n, waitedMs: Date.now() - t0, error: "real_node_missing", detail: nodeMissingMsg(n) };
}
/** daemon 的实例锁（<home>/paseo.pid）：listen / pid / 是否由桌面端托管 */
function daemonLock(home) {
  return readJson(join(home, "paseo.pid"), null) || null;
}
/** HTTP 探活 /api/status（唯一免鉴权端点）：800ms 拿不到就当没在跑 */
function probeDaemon(listen) {
  return new Promise((resolve) => {
    const host = String(listen || "").split(":")[0] || "127.0.0.1";
    const port = Number(String(listen || "").split(":")[1]) || 6767;
    const req = http.get({ host, port, path: "/api/status", timeout: 800 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        body += d;
        if (body.length > 4096) req.destroy();
      });
      res.on("end", () => {
        const j = readJsonText(body);
        resolve({ ok: res.statusCode === 200 && !!j, status: j || null });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: null });
    });
    req.on("error", () => resolve({ ok: false, status: null }));
  });
}
function readJsonText(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}
/** relay 开关：读 <home>/config.json 的 daemon.relay.enabled（新装默认 false —— 这条是实测结论） */
function homeConfig(home) {
  return readJson(join(home, "config.json"), {}) || {};
}
function relayEnabledOf(home) {
  const c = homeConfig(home);
  const v = c && c.daemon && c.daemon.relay && c.daemon.relay.enabled;
  return v === true;
}
function serverIdOf(home) {
  try {
    return String(fs.readFileSync(join(home, "server-id"), "utf8")).trim();
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* CLI 调用                                                             */
/* ------------------------------------------------------------------ */
/**
 * Windows 命令行参数转义（CommandLineToArgvW 规则）：**每个**参数都用双引号包起来，
 * 参数内部的 `"` 写成 `\"`；整条命令再包一层引号交给 `cmd /d /s /c`（/s 会剥掉最外层）。
 * 这正是 `.cmd`（不是 PE 文件）在 Windows 上唯一稳的调用姿势 —— 实测过三条路：
 *   · `spawn(cli, args, { shell: true })`：cmd 的剥引号规则把 JSON 参数拆坏（code=1）；
 *   · `powershell.exe -Command "& 'cli' … 'json'"`：PS 5.1 给原生命令传参时不转义内部双引号，
 *     CLI 收到的是被撕开的字符串，`config set` 报「expected record, received string」；
 *   · 本方案（cmd + 逐参数转义 + windowsVerbatimArguments）：`config set agents.providers '<json>'`
 *     返回 code=0、`appliedPaths: ["agents.providers"]`。
 */
function winArg(s) {
  return '"' + String(s == null ? "" : s).replace(/"/g, '\\"') + '"';
}
/**
 * 解析「裸命令」到可执行文件（npm / npm.cmd / node.exe…）。
 * 为什么需要：Windows 上 `npm` 是 `npm.cmd`（脚本），`spawn("npm", …)` 不带 shell 会直接 EINVAL；
 * 而走 shell 又会把参数拆坏（见上）。所以这里先用 `where` 拿到 `.cmd` 的真实路径，
 * 后面仍旧走「cmd.exe + 逐参数转义」那一条稳的路。
 * 找不到（真的没有 npm）就回空串，调用方据此报 npm_missing —— 这正是**一台没装 Node 的新机器**的现场。
 */
function resolveCommandPath(cmd) {
  const c = String(cmd || "");
  if (!c || /[\\/]/.test(c)) return c;
  if (process.platform !== "win32") return c;
  try {
    const r = spawnSync("where", [c], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    if (r.status !== 0) return "";
    const first = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
    /* 优先 .cmd（npm 的入口就是它）：where 会同时列出 npm 与 npm.cmd */
    const all = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return all.find((p) => /\.cmd$/i.test(p)) || first;
  } catch {
    return "";
  }
}
/**
 * 跑一次官方 CLI。
 * Windows 上 CLI 是 `.cmd`：必须经 cmd.exe，且参数得自己按上面那套规则转义
 * （Node 在 shell 模式下不会替我们转义 —— 而 provider 片段是一整段 JSON，全是双引号）。
 */
/** Windows 上的 cmd.exe 命令行：可执行文件与逐参数都按 CommandLineToArgvW 规则加引号 */
function cmdLineOf(exe, args) {
  return '"' + [exe].concat(args || []).map(winArg).join(" ") + '"';
}
/* 已经解析好的那份真 Node（本次会话内缓存；安装完托管 Node 后由 installBackend 清掉重解析）。
   为什么缓存：控制台每次刷新状态都会调一次 CLI，重复扫候选目录 + 起探针进程没必要。 */
let nodeRuntimeCache = null;
function cachedNodeRuntime(opts) {
  if (nodeRuntimeCache && !(opts && opts.refresh)) return nodeRuntimeCache;
  nodeRuntimeCache = pickNodeRuntime(opts);
  return nodeRuntimeCache;
}
/**
 * 跑官方 CLI 的统一入口（本轮新增）：能拿到真 Node 就 `<真Node> <自建入口|shim> …`
 * —— `.cmd` shim 会去 PATH 找 node，PATH 里是 v18 时就是这次现场的根因。
 */
function spawnPaseoCli(cfg, args, opts) {
  const c = cfg || loadConfig();
  const spec = ownCliSpec(pickNodeRuntime({}), c);
  if (c.mode === "own" && spec) return spawnCli(spec.node, spec.args.concat(args), opts);
  const cli = resolveCli(c);
  if (!cli.cli) return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: "CLI 未找到", timedOut: false });
  return spawnCli(cli.cli, args, opts);
}
function spawnCli(cli, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    if (!cli) return resolve({ ok: false, code: -1, stdout: "", stderr: "CLI 未找到", timedOut: false });
    const win = process.platform === "win32";
    const argv = args || [];
    const env = Object.assign({}, process.env, o.env || {});
    let child = null;
    let timedOut = false;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      if (win) {
        /* 裸命令（npm）先解析成 npm.cmd：spawn 不带 shell 找不到 .cmd，带 shell 又会拆坏参数 */
        const resolved = exists(cli) ? cli : resolveCommandPath(cli);
        if (!resolved) {
          return resolve({ ok: false, code: -1, stdout: "", stderr: "命令不在 PATH 里：" + cli, timedOut: false });
        }
        child = spawn("cmd.exe", ["/d", "/s", "/c", cmdLineOf(resolved, argv)], {
          windowsVerbatimArguments: true,
          windowsHide: true,
          env,
          cwd: o.cwd || undefined,
        });
      } else {
        child = spawn(cli, argv, { windowsHide: true, env, cwd: o.cwd || undefined });
      }
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: "", stderr: String((e && e.message) || e), timedOut: false });
    }
    let stdout = "";
    let stderr = "";
    /* 逐行回调（o.onLine）：长跑命令（如提问通道自检）的输出要能**实时**进控制台，
       不能等它跑完才一次性刷出来。 */
    let lineBuf = "";
    const feedLines = (text) => {
      if (typeof o.onLine !== "function") return;
      lineBuf += text;
      let i;
      while ((i = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, i).replace(/\r$/, "");
        lineBuf = lineBuf.slice(i + 1);
        if (line.trim()) o.onLine(line);
      }
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      if (stdout.length > 512 * 1024) stdout = stdout.slice(-256 * 1024);
      if (typeof o.onStdout === "function") o.onStdout(d.toString("utf8"));
      feedLines(d.toString("utf8"));
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-128 * 1024);
      if (typeof o.onStderr === "function") o.onStderr(d.toString("utf8"));
      feedLines(d.toString("utf8"));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish({ ok: false, code: -1, stdout, stderr: stderr + "\n[超时 " + (o.timeoutMs || CLI_TIMEOUT_MS) + "ms]", timedOut: true });
    }, Number(o.timeoutMs) || CLI_TIMEOUT_MS);
    child.on("error", (e) => finish({ ok: false, code: -1, stdout, stderr: stderr + String((e && e.message) || e), timedOut }));
    child.on("close", (code) => finish({ ok: code === 0, code: Number(code), stdout, stderr, timedOut }));
  });
}
/** 按进程树强杀（.cmd 会再起 node 子进程，只 kill 父进程会留孤儿） */
function killTree(child) {
  try {
    if (!child || !child.pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
    } else {
      child.kill("SIGKILL");
    }
  } catch {}
}
/** 给命令补 --home（config / pair / start / restart 这些 local-only 子命令都认它） */
function withHome(args, cfg) {
  const c = cfg || loadConfig();
  if (c.mode !== "own") return args.slice();
  return args.concat(["--home", paseoHomeOf(c)]);
}
/** CLI --json 输出里取 JSON（stdout 可能夹着别的行，取最后一段完整对象） */
function lastJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const direct = readJsonText(s);
  if (direct) return direct;
  const i = s.lastIndexOf("{");
  const j = s.indexOf("}", i);
  if (i >= 0 && j > i) return readJsonText(s.slice(i, j + 1));
  return null;
}

/* ------------------------------------------------------------------ */
/* 后端状态汇总（UI 与卡片共用一份）                                      */
/* ------------------------------------------------------------------ */
async function detectBackend() {
  const cfg = loadConfig();
  const cli = resolveCli(cfg);
  const home = paseoHomeOf(cfg);
  const node = realNode();
  /* 跑 CLI 用的那份 Node（不触发自动安装：状态查询是只读动作） */
  const rt = cachedNodeRuntime({});
  const lock = daemonLock(home);
  const listen = String((lock && lock.listen) || "");
  const probe = listen ? await probeDaemon(listen) : { ok: false, status: null };
  let version = "";
  if (cli.cli) {
    /* 有真 Node 就直接问 CLI 入口（不经 .cmd shim —— shim 会去 PATH 找 node，旧 Node 现场就是这么崩的） */
    const cliEntry = cfg.mode === "own" && rt.ready && exists(ownCliEntry(cfg)) ? ownCliEntry(cfg) : cli.cli;
    version = (await cliVersionOf(cliEntry, { timeoutMs: 12000, node: rt.ready ? rt.bin : "" })).version;
  }
  /* 自建模式的「装好了没」以**自检**为准：CLI bin 在位且真能报版本。
     只看 `node_modules\@getpaseo\cli` 目录在不在会把两种情况误报成未安装 ——
     目录在但 bin 没生成（安装半途 / 目录结构不同）、以及装好了却被判成 false（现场那个 installed=false）。 */
  const ownVerify = cfg.mode === "own" ? await verifyOwnInstall(cfg, { node: rt.ready ? rt.bin : "", nodeVersion: rt.version }) : null;
  const reuse = cfg.mode === "own" ? reuseCandidate() : { available: !!cli.cli && cli.source !== "own", cli: cli.cli, source: cli.source };
  return {
    mode: cfg.mode === "own" ? "own" : "reuse",
    cli: cli.cli,
    cliSource: cli.source,
    cliCandidates: desktopCliCandidates(),
    version,
    home,
    homeExists: exists(home),
    daemon: {
      running: !!probe.ok,
      listen,
      pid: Number((lock && lock.pid) || 0),
      desktopManaged: !!(lock && lock.desktopManaged),
      serverId: serverIdOf(home) || String((probe.status && probe.status.serverId) || ""),
      reportedVersion: String((probe.status && probe.status.version) || ""),
    },
    relay: relayEnabledOf(home),
    nodeBin: node.bin,
    nodeSource: node.source,
    nodeVersion: node.version,
    nodeElectronFallback: !!node.electron,
    nodeReady: nodeReadyOf(node),
    /* 跑 npm / 自建 CLI 用的那份 Node（与桥那份可能不同：这份必须 ≥22.19） */
    nodeRuntime: {
      ready: !!rt.ready,
      bin: String(rt.bin || ""),
      version: String(rt.version || ""),
      source: String(rt.source || ""),
      reason: String(rt.reason || ""),
      min: NODE_MIN_VERSION,
      managedBin: String(rt.managedBin || ""),
    },
    installDir: String(cfg.installDir || ""),
    /* own：自检结论（含失败原因与自检版本）；reuse：能找到可用 CLI 就算装好 */
    installed: cfg.mode === "own" ? !!(ownVerify && ownVerify.ok) : !!cli.cli,
    installCheck: ownVerify
      ? {
          cli: ownVerify.cli,
          dep: ownVerify.dep,
          depExists: ownVerify.depExists,
          version: ownVerify.version,
          reason: ownVerify.reason || "",
          detail: ownVerify.detail || "",
        }
      : null,
    /* own 模式走不通时的出口：本机其实还装着别的 Paseo（桌面端 / PATH） */
    reuse,
    npmAvailable: !!probeCommand("npm"),
  };
}
function probeCommand(cmd) {
  /* `.cmd`（npm.cmd）在 Windows 上**不能**直接 spawnSync —— Node 会回 `spawnSync npm.cmd EINVAL`，
     现场表现就是「明明装了 Node，插件却说 PATH 里没有 npm」。走 cmd.exe 执行（与 spawnCli 同一姿势），
     并且不吃 Node 的 DEP0190 警告（不带 shell:true）。 */
  try {
    if (process.platform === "win32") {
      const r = spawnSync("cmd.exe", ["/d", "/s", "/c", '"' + String(cmd) + '.cmd --version"'], {
        encoding: "utf8",
        windowsVerbatimArguments: true,
        windowsHide: true,
        timeout: 8000,
      });
      return r.status === 0 ? String(r.stdout || "").trim() : "";
    }
    const r = spawnSync(cmd, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    return r.status === 0 ? String(r.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

/** provider 现状：直接读 <home>/config.json（CLI 的 get 与它同一份真源，少一次进程开销） */
function providerState(home) {
  const c = homeConfig(home);
  const p = c && c.agents && c.agents.providers ? c.agents.providers.mtnode : null;
  return {
    registered: !!p,
    value: p || null,
  };
}

/** 控制台要的那一份完整状态 */
async function statusForUi() {
  const cfg = loadConfig();
  const backend = await detectBackend();
  const prov = providerState(backend.home);
  const snippet = (() => {
    try {
      const full = JSON.parse(
        bridgeInfo.providerSnippet({
          appRoot,
          resourcesDir: process.resourcesPath || "",
          dataDir: dataDir(),
          nodeBin: backend.nodeBin,
        }),
      );
      return full.agents.providers.mtnode;
    } catch {
      return null;
    }
  })();
  const bridge = (() => {
    try {
      return bridgeInfo.bridgePaths({
        appRoot,
        resourcesDir: process.resourcesPath || "",
        dataDir: dataDir(),
        nodeBin: backend.nodeBin,
      });
    } catch {
      return { script: "", node: "", dataDir: "" };
    }
  })();
  const stats = (() => {
    try {
      const m = getMcp ? getMcp() : null;
      const s = m ? m.status() : null;
      return s || {};
    } catch {
      return {};
    }
  })();
  /* 观察者数只在 status() 的 sessionBridge.stats() 里（会话族不出现在 tools/list，
     它是「手机此刻正在接几条」的**唯一**真实信号，卡片与控制台都靠它）。 */
  const bridgeStats = (stats && stats.sessionBridge) || {};
  return {
    ok: true,
    busy,
    plugin: { id: PLUGIN_ID, kind: KIND, version: app.getVersion() },
    backend,
    provider: {
      registered: prov.registered,
      value: prov.value,
      snippet,
      bridgeScript: bridge.script || "",
      bridgeExists: exists(bridge.script),
      node: bridge.node || "",
      protocolVersion: bridgeInfo.ACP_PROTOCOL_VERSION,
      paseoMinVersion: bridgeInfo.PASEO_MIN_VERSION,
      relayEndpoint: RELAY_ENDPOINT,
    },
    remote: {
      enabled: isRemoteEnabled(),
      watchers: Number(bridgeStats.watchers || 0),
      sessions: Number(bridgeStats.sessions || 0),
    },
    server: {
      enabled: !!stats.enabled,
      running: !!stats.running,
      port: Number(stats.port || 0),
    },
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    paths: {
      dataDir: dataDir(),
      pluginRoot: pluginRoot(),
      log: consoleLogPath(),
      ui: uiEntry(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 配对二维码                                                           */
/* ------------------------------------------------------------------ */
/**
 * 拿官方配对 offer。
 * 走 `paseo daemon pair --json`：daemon 在跑就经 RPC 取，没跑也能用本地密钥**离线**算出来
 * （官方 resolveLocalPairingOffer 的行为），所以「刚装好还没起后端」也能先出码。
 * 只回 url（二维码内容）与 connectionUri，不回官方那份 ANSI 字符画 —— 界面自己画。
 */
async function pairingOffer() {
  const cfg = loadConfig();
  const cli = resolveCli(cfg);
  if (!cli.cli) return { ok: false, error: "cli_missing" };
  const args = withHome(["daemon", "pair", "--json"], cfg);
  const r = await spawnPaseoCli(cfg, args, { timeoutMs: CLI_TIMEOUT_MS });
  const j = lastJson(r.stdout);
  if (!j) {
    appendConsole("[pair] CLI 未回 JSON（code=" + r.code + "）：" + String(r.stderr || "").slice(-400));
    return { ok: false, error: "pair_failed", detail: String(r.stderr || r.stdout || "").slice(-400) };
  }
  if (!j.relayEnabled || !j.url) {
    return { ok: false, error: "relay_disabled", detail: String(j.message || "") };
  }
  saveConfig({ lastPairAt: Date.now() });
  pairCache = { url: j.url, at: Date.now() };
  /* 日志只记长度与前缀：整条 url 就是配对凭据（官方口径：treat it like a password），不进日志 */
  appendConsole("[pair] 已生成配对链接（" + String(j.url).length + " 字符，relay=" + (j.relayEnabled ? "on" : "off") + "）");
  return { ok: true, url: String(j.url), connectionUri: String(j.connectionUri || ""), relayEnabled: true };
}
/** 打开 relay（新装的 Paseo home 默认是关的 —— 关着时 pair 会以退出码 1 报 RELAY_DISABLED） */
async function enableRelay() {
  const cfg = loadConfig();
  const cli = resolveCli(cfg);
  if (!cli.cli) return { ok: false, error: "cli_missing" };
  const args = withHome(["daemon", "config", "set", "daemon.relay.enabled", "true"], cfg);
  const r = await spawnPaseoCli(cfg, args, { timeoutMs: CLI_TIMEOUT_MS });
  appendConsole("[relay] 开启 relay：" + (r.ok ? "已写入并重载" : "失败 code=" + r.code));
  if (!r.ok) return { ok: false, error: "relay_set_failed", detail: String(r.stderr || "").slice(-400) };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* provider 注册（官方 CLI 写配置 + 自动 reload）                          */
/* ------------------------------------------------------------------ */
/**
 * 把 MTNode 会话注册成 Paseo 的一个 ACP provider。
 *
 * ── 为什么不是一句 `config set agents.providers.mtnode '<json>'` ──────────────
 * 官方 CLI 的点路径**只认已存在的静态键**；`agents.providers.<自定义 id>` 是动态键，
 * 直接 set 会被拒：`Error: Unknown configuration path: agents.providers.mtnode.
 * Replace its containing object with JSON for dynamic keys.`（2026-10-14 真机实测）。
 * 所以正确姿势是官方提示的那一句：**读出 agents.providers 整段 → 合并 → 整段写回**。
 * 这样仍然完全走官方 CLI（合并与 reload 都由它负责），只是把「改哪一段」交给它自己校验。
 *
 * CLI 万一失败（老版本 / 权限 / 参数被环境吃掉）才回退到「直接改 config.json + daemon reload」，
 * 两条路都不动用户配置里的其它键。回退前会把原文件备份到插件数据目录。
 *
 * @param {{confirm?:boolean}} opts confirm=false 时若 Paseo 里还有活跃 agent 就先不写，
 *        回 needConfirm 让界面提示一次（共识：可能打断正在跑的会话，先提示）。
 */
async function applyProvider(opts) {
  const o = opts || {};
  const cfg = loadConfig();
  const cli = resolveCli(cfg);
  if (!cli.cli) return { ok: false, error: "cli_missing" };
  /* 桥的 command[0] 必须是真 Node：dsh 的托管安装可能还在后台跑，先等一小会儿再取片段，
     免得把 Electron 可执行文件写进 provider（注册成功但手机上一个会话都建不起来）。
     等不到就明确回 real_node_missing —— 不写一份错的配置。 */
  const node = await waitRealNode({ timeoutMs: 20000 });
  if (!node.ok) return { ok: false, error: node.error, detail: node.detail };
  const home = paseoHomeOf(cfg);
  const st = await statusForUi();
  const snippet = st.provider.snippet;
  if (!snippet) return { ok: false, error: "snippet_missing" };
  if (!o.confirm) {
    const running = await runningAgents(cfg);
    if (running.count > 0) return { ok: false, error: "need_confirm", runningSessions: running.count, names: running.names };
  }
  busy = "provider";
  broadcast("paseoRemote:progress", { phase: "provider", message: "读取 Paseo 现有 provider 配置…" });
  /* 1) 读现状：拿不到就当作空表（后面整段写回，等于只加了我们这一条） */
  const cur = await readProviders(cfg);
  const next = Object.assign({}, cur.value || {}, { mtnode: snippet });
  busy = "provider";
  broadcast("paseoRemote:progress", { phase: "provider", message: "写入 provider 配置…" });
  const r = await spawnPaseoCli(cfg, withHome(["daemon", "config", "set", "agents.providers", JSON.stringify(next)], cfg), {
    timeoutMs: CLI_TIMEOUT_MS,
  });
  appendConsole(
    "[provider] config set agents.providers → code=" +
      r.code +
      (r.ok ? "（官方已合并并重载）" : "：回退到直接改文件 · " + String(r.stderr || "").replace(/\s+/g, " ").slice(-200)),
  );
  if (!r.ok) {
    const fb = writeProviderFile(home, snippet);
    if (!fb.ok) {
      busy = "";
      reportErr("provider_set_failed", "写入 Paseo provider 配置失败：" + String(r.stderr || "").slice(-300), { phase: "provider" });
      return { ok: false, error: "provider_set_failed", detail: String(r.stderr || "").slice(-400) };
    }
    const rel = await spawnPaseoCli(cfg, withHome(["daemon", "reload"], cfg), { timeoutMs: CLI_TIMEOUT_MS });
    appendConsole("[provider] 直接改文件后 reload → code=" + rel.code);
  }
  busy = "";
  const after = providerState(home);
  broadcast("paseoRemote:progress", { phase: "provider", message: after.registered ? "已注册" : "未生效" });
  return { ok: after.registered, registered: after.registered, value: after.value, viaCli: !!r.ok };
}
/** 读 `agents.providers` 整段（CLI 的 get 会回 {source,path,set,value}；失败回空表） */
async function readProviders(cfg) {
  const r = await spawnPaseoCli(cfg, withHome(["daemon", "config", "get", "agents.providers", "--json"], cfg), {
    timeoutMs: CLI_TIMEOUT_MS,
  });
  const j = lastJson(r.stdout);
  const v = j && j.value && typeof j.value === "object" && !Array.isArray(j.value) ? j.value : {};
  return { ok: !!r.ok, value: v };
}
/** 回退路径：只增/改 agents.providers.mtnode 这一个键（先备份原文件） */
function writeProviderFile(home, snippet) {
  try {
    const p = join(home, "config.json");
    const cur = readJson(p, {}) || {};
    if (exists(p)) {
      const bak = join(pluginRoot(), "config-backup", "config-" + Date.now() + ".json");
      mk(path.dirname(bak));
      fs.copyFileSync(p, bak);
    }
    cur.agents = cur.agents || {};
    cur.agents.providers = cur.agents.providers || {};
    cur.agents.providers.mtnode = snippet;
    writeJson(p, cur);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
/** Paseo 里正在跑的 agent（拿不到就回 0：宁可不提示，也不虚报） */
async function runningAgents(cfg) {
  try {
    const r = await spawnPaseoCli(cfg, withHome(["agent", "ls", "--json"], cfg), { timeoutMs: 12000 });
    const j = lastJson(r.stdout);
    const arr = Array.isArray(j) ? j : (j && (j.agents || j.items)) || [];
    const busyOnes = arr.filter((a) => a && (a.running || a.status === "running" || a.lifecycle === "running"));
    return { count: busyOnes.length, names: busyOnes.slice(0, 3).map((a) => String(a.title || a.name || a.id || "")) };
  } catch {
    return { count: 0, names: [] };
  }
}
/** 从 Paseo 移除本 provider：同样整段替换（动态键不能单独 unset），清空后直接 unset 整段 */
async function removeProvider() {
  const cfg = loadConfig();
  const cli = resolveCli(cfg);
  if (!cli.cli) return { ok: false, error: "cli_missing" };
  const home = paseoHomeOf(cfg);
  const cur = await readProviders(cfg);
  const next = Object.assign({}, cur.value || {});
  delete next.mtnode;
  const rest = Object.keys(next).length;
  const args = rest
    ? ["daemon", "config", "set", "agents.providers", JSON.stringify(next)]
    : ["daemon", "config", "unset", "agents.providers"];
  const r = await spawnPaseoCli(cfg, withHome(args, cfg), { timeoutMs: CLI_TIMEOUT_MS });
  appendConsole(
    "[provider] " + (rest ? "config set（删掉 mtnode 后写回）" : "config unset agents.providers") + " → code=" + r.code,
  );
  if (!r.ok) {
    try {
      const p = join(home, "config.json");
      const raw = readJson(p, {}) || {};
      if (raw.agents && raw.agents.providers) delete raw.agents.providers.mtnode;
      writeJson(p, raw);
    } catch (e) {
      return { ok: false, error: "provider_unset_failed", detail: String((e && e.message) || e) };
    }
    await spawnPaseoCli(cfg, withHome(["daemon", "reload"], cfg), { timeoutMs: CLI_TIMEOUT_MS });
  }
  return { ok: !providerState(home).registered };
}

/* ------------------------------------------------------------------ */
/* 远程连接总开关（会话族 gate）                                          */
/* ------------------------------------------------------------------ */
function isRemoteEnabled() {
  try {
    return !!loadConfig().remoteEnabled;
  } catch {
    return false;
  }
}
/** 注入给 mcp-server.js 的会话族闸门：关着时一律拒绝，并给一句人话指路 */
function sessionGate() {
  if (isRemoteEnabled()) return { allowed: true };
  return {
    allowed: false,
    reason: "远程接管已关闭：在「插件 → Paseo 手机接管」的控制台里打开「远程连接」后再试。",
  };
}
function setRemoteEnabled(on) {
  const next = saveConfig({ remoteEnabled: !!on });
  appendConsole("[remote] 远程连接总开关 → " + (next.remoteEnabled ? "开" : "关"));
  return { ok: true, remoteEnabled: next.remoteEnabled };
}
/** 断开所有远程设备 = 关总开关 + 收掉现在挂着的 SSE 观察者（配对凭据不动，那要「重置配对凭据」） */
function disconnectAllRemote() {
  setRemoteEnabled(false);
  let closed = 0;
  try {
    const m = getMcp ? getMcp() : null;
    if (m && typeof m.dropSessionStreams === "function") {
      const r = m.dropSessionStreams("远程连接已关闭");
      closed = Number((r && r.closed) || 0);
    }
  } catch (e) {
    appendConsole("[remote] 收观察者失败：" + String((e && e.message) || e));
  }
  return { ok: true, closed };
}

/* ------------------------------------------------------------------ */
/* 重置配对凭据（重新生成 daemon 密钥 —— 会作废所有已配对设备）             */
/* ------------------------------------------------------------------ */
/**
 * 官方没有「撤销配对」这回事：配对凭据就是 offer（serverId + daemon 公钥 + relay），
 * 手机里存着，MTNode 撤不掉。唯一有效的作废手段是换掉 daemon 密钥对（<home>/daemon-keypair.json）：
 * 旧 offer 里的公钥对不上新密钥，握手必然失败。
 * **只动密钥文件，不动 relay 开关**（共识：不牵连用户在 Paseo 里的其它用途）。
 * 密钥先备份到插件数据目录（回滚是人工的，但至少有原件）。
 */
async function resetPairing() {
  const cfg = loadConfig();
  const cli = resolveCli(cfg);
  const home = paseoHomeOf(cfg);
  const kp = join(home, "daemon-keypair.json");
  if (!exists(kp)) return { ok: false, error: "keypair_missing", home };
  const bak = join(pluginRoot(), "keypair-backup", "daemon-keypair-" + Date.now() + ".json");
  mk(path.dirname(bak));
  fs.copyFileSync(kp, bak);
  fs.unlinkSync(kp);
  appendConsole("[reset] 已移除 daemon 密钥（备份：" + bak + "），重启 daemon 让它重新生成");
  let restarted = false;
  if (cli.cli) {
    const r = await spawnPaseoCli(cfg, withHome(["daemon", "restart"], cfg), { timeoutMs: DAEMON_START_TIMEOUT_MS });
    restarted = !!r.ok;
    appendConsole("[reset] daemon restart → code=" + r.code);
  }
  pairCache = null;
  return {
    ok: true,
    backup: bak,
    restarted,
    hint: restarted
      ? "所有已配对设备已失效，请重新扫码配对。"
      : "密钥已重置，但 daemon 没重启成功 —— 请手动重启 Paseo（桌面端退出重开，或跑 paseo daemon restart）后重新扫码。",
  };
}

/* ------------------------------------------------------------------ */
/* 自建后端：npm 装 @getpaseo/cli + 起独立 daemon                        */
/* ------------------------------------------------------------------ */
function isSafeInstallDir(dir) {
  const d = path.resolve(String(dir || ""));
  if (!d) return { ok: false, error: "empty_dir" };
  const guards = [app.getAppPath(), path.dirname(process.execPath)];
  const lower = d.toLowerCase();
  for (const g of guards) {
    const gl = String(g || "").toLowerCase();
    if (!gl) continue;
    if (lower === gl || lower.startsWith(gl + path.sep)) return { ok: false, error: "app_dir" };
  }
  try {
    mk(d);
    fs.accessSync(d, fs.constants.W_OK);
  } catch {
    return { ok: false, error: "not_writable" };
  }
  return { ok: true, path: d };
}
function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 Paseo 后端安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path, mode: "own", ownHome: cfg.ownHome || join(pluginRoot(), "paseo-home") });
  return { ok: true, installDir: safe.path };
}
/**
 * 安装自建后端：`npm i @getpaseo/cli --prefix <dir>`（走 cn-mirrors 的国内源）。
 * 这条分支只在「本机没有 Paseo」时才会被用户用到（有 Desktop 就直接复用它的 CLI）。
 *
 * ── 为什么「装完还要自检」────────────────────────────────────────────────
 * 现场（新客户机）报的是 `[install] 完成：code=0 installed=false`：npm 正常退出、依赖也落了盘，
 * 但插件只拿 `node_modules\@getpaseo\cli` 这个目录在不在当判据 —— 目录在而 bin 没生成（半途中断 /
 * 目录结构差异）时会误报，用户看到的是「装不上」，且怎么重装都一样。
 * 现在改成自检口径：**CLI bin 在位 + `paseo --version` 真能报版本**才算装好；
 * 不通过就清掉这个目录里的 node_modules / lock 重装一次（半成品是常见元凶），再失败给可操作原因。
 * ───────────────────────────────────────────────────────────────────────
 */
function cleanOwnDeps(dir) {
  const targets = [join(dir, "node_modules"), join(dir, "package-lock.json"), join(dir, "npm-shrinkwrap.json")];
  const removed = [];
  for (const t of targets) {
    try {
      if (!exists(t)) continue;
      fs.rmSync(t, { recursive: true, force: true });
      removed.push(t);
    } catch (e) {
      appendConsole("[install] 清理失败（继续重装）：" + t + " · " + String((e && e.message) || e));
    }
  }
  if (removed.length) appendConsole("[install] 已清理：" + removed.join(" | "));
  return removed;
}
/**
 * 跑一次 npm i（真正的网络那一步）。
 * `node`（真 Node ≥22.19）+ `cli`（同目录的 npm-cli.js）= 本轮新增的正路：
 * npm.cmd 会去 PATH 找 node，PATH 里是 v18 时正是这次现场的根因，所以只要拿得到真 Node 就不经它。
 * 拿不到真 Node 时**不跑**（调用方已拒绝安装）—— 这里的路径参数只作兜底。
 */
async function npmInstallOnce(dir, spec) {
  const useNode = !!(spec && spec.node && spec.cli && exists(spec.cli));
  appendConsole("[install] npm i " + NPM_PACKAGE + " --prefix " + dir + (useNode ? "（用真 Node " + spec.node + "）" : ""));
  const args = ["i", NPM_PACKAGE, "--prefix", dir, "--no-audit", "--no-fund"];
  const r = useNode
    ? await spawnCli(spec.node, [spec.cli].concat(args), {
        timeoutMs: 30 * 60 * 1000,
        env: mirrors.installEnv({ npm_config_progress: "true" }),
        onStdout: (t) => {
          const line = String(t).trim();
          if (line) broadcast("paseoRemote:progress", { phase: "install", message: line.slice(0, 200) });
        },
      })
    : await spawnCli("npm", args, {
        timeoutMs: 30 * 60 * 1000,
        env: mirrors.installEnv({ npm_config_progress: "true" }),
      });
  appendConsole("[install] npm 退出：code=" + r.code + (r.timedOut ? "（超时）" : ""));
  if (r.code !== 0) {
    /* npm 的 EBADENGINE 只在 stderr 里说人话；把它摘出来，别让用户在一屏 WARN 里找 */
    const eng = /EBADENGINE/i.test(String(r.stderr || ""));
    if (eng) {
      const cur = nodeVersionFromText(r.stderr);
      appendConsole("[install] npm 报了 EBADENGINE（引擎不满足）：本轮要求 Node ≥" + NODE_MIN_VERSION + (cur ? "，npm 报的 current = v" + cur : ""));
    }
    appendConsole("[install] npm stderr 尾部：" + String(r.stderr || "").replace(/\s+/g, " ").slice(-400));
  }
  return r;
}
const INSTALL_REASON_TEXT = {
  dep_missing: "依赖没落盘（npm 报了错，或被中途打断）：npm 装 " + NPM_PACKAGE + " 失败。",
  cli_bin_missing: "依赖目录在，但 node_modules\\.bin\\paseo.cmd 没生成 —— 安装不完整，重装一次通常就好。",
  cli_not_runnable: "CLI 装上了但跑不起来（`paseo --version` 没回版本号）。",
  node_too_old:
    "这份 CLI 是被旧 Node 装出来的 / 正在被旧 Node 跑：" +
    "本轮要求 Node ≥" + NODE_MIN_VERSION + "，更低的 Node 会被 npm 放行（只给 EBADENGINE 警告）却跑不起来。" +
    "先在控制台点「清干净重装」（会删掉这个目录的 node_modules 后用真 Node 重装）。",
};
async function installBackend(opts) {
  const o = opts || {};
  const cfg = loadConfig();
  const dir = o.installDir || cfg.installDir;
  const safe = isSafeInstallDir(dir);
  if (!safe.ok) return { ok: false, error: safe.error };
  busy = "install";
  broadcast("paseoRemote:progress", { phase: "install", message: "检查 Node 运行时（要真 Node ≥" + NODE_MIN_VERSION + "）…" });

  /* ── 预检（本轮新增，这次的现场就出在这一步）───────────────────────────
   * 先拿到一份够版本的**真 Node**：PATH 里的旧 Node 会被 npm 放行、却让 CLI 起不来，
   * 所以这里缺就自动装（dsh 托管那份）、装不上就**直接拒绝**，不跑 npm。 */
  const rt = await ensureNodeRuntime({});
  if (!rt.ok) {
    busy = "";
    const why = nodeRuntimeMsg(rt);
    const detail = String(rt.detail || "").slice(-300);
    appendConsole("[install] 预检不过（" + rt.error + "）：" + why + " " + detail);
    reportErr("install_failed", "Paseo 后端安装前置不满足（" + rt.error + "）：" + why, { phase: "install" });
    return {
      ok: false,
      error: "install_failed",
      reason: rt.error === "download-failed" ? "node_install_failed" : "node_too_old",
      message: why + (detail ? "（" + detail + "）" : ""),
      detail,
      hint: "装 Node ≥" + NODE_MIN_VERSION + " 后重试；或点「等真 Node 就位」让插件把 Node 装进数据目录；或点「改用本机已装的 Paseo」。",
      installDir: safe.path,
    };
  }
  const spec = npmSpecFor(rt.bin);
  if (!spec) {
    busy = "";
    const why =
      "真 Node 在（" + rt.bin + "，" + String(rt.version || "") + "），但没找到随它的 npm（node_modules\\npm\\bin\\npm-cli.js）：" +
      "这份 Node 是不带 npm 的精简包。";
    appendConsole("[install] 预检不过（npm_missing for node）：" + why);
    reportErr("npm_missing", why, { phase: "install" });
    return { ok: false, error: "install_failed", reason: "npm_missing", message: why, installDir: safe.path };
  }
  appendConsole("[install] Node 运行时就绪：node=" + rt.bin + "（" + String(rt.version || "") + "，" + rt.source + "）· npm=" + spec.cli);

  saveConfig({ mode: "own", installDir: safe.path, ownHome: cfg.ownHome || join(pluginRoot(), "paseo-home") });
  broadcast("paseoRemote:progress", { phase: "install", message: "npm 安装 " + NPM_PACKAGE + " …" });

  let r = await npmInstallOnce(safe.path, spec);
  let check = await verifyOwnInstall(loadConfig(), { node: rt.bin, nodeVersion: rt.version });
  appendConsole(
    "[install] 完成：code=" + r.code + " installed=" + check.ok + " 自检=" + (check.ok ? "v" + check.version : check.reason),
  );
  /* 第一次自检不过：清掉半成品再装一次（用户口径：重装一次，仍失败才报）。
     超时不重试：那次多半已经跑了半小时，再跑一遍只是让用户多等半小时。 */
  if (!check.ok && !o.noRetry && !r.timedOut) {
    broadcast("paseoRemote:progress", { phase: "install", message: "首次安装自检没过（" + (check.reason || "") + "），清理后重装一次…" });
    cleanOwnDeps(safe.path);
    r = await npmInstallOnce(safe.path, spec);
    check = await verifyOwnInstall(loadConfig(), { node: rt.bin, nodeVersion: rt.version });
    appendConsole(
      "[install] 重装完成：code=" + r.code + " installed=" + check.ok + " 自检=" + (check.ok ? "v" + check.version : check.reason),
    );
  }
  busy = "";
  if (!check.ok) {
    const why = INSTALL_REASON_TEXT[check.reason] || "安装自检没过。";
    const detail = String(r.stderr || check.detail || "").replace(/\s+/g, " ").slice(-400);
    reportErr("install_failed", "npm 安装 " + NPM_PACKAGE + " 失败（" + (check.reason || "unknown") + "）：" + why + " " + detail.slice(-200), {
      phase: "install",
    });
    return {
      ok: false,
      error: "install_failed",
      reason: check.reason || "",
      message: why,
      detail,
      installDir: safe.path,
      hint:
        check.reason === "node_too_old"
          ? "点「清干净重装」把这份用旧 Node 装出来的依赖删掉，再用真 Node 重装。"
          : "换一个安装目录（不要选应用自己所在的目录、也不要用需要管理员权限的位置）后重试；仍失败就看日志里的 npm 输出。",
    };
  }
  /* 首次安装顺带开 relay：新 home 默认关着，关着时 pair 一定失败（实测结论） */
  const home = paseoHomeOf(loadConfig());
  mk(home);
  const pre = await cliSetDaemonConfig(check.cli, home, "daemon.relay.enabled", "true", rt.bin);
  appendConsole("[install] relay 开启 → code=" + pre.code + " home=" + home);
  if (!pre.ok) {
    appendConsole("[install] relay 开启失败（可在控制台点「开启 relay」重试）：" + String(pre.stderr || "").slice(-200));
  }
  /* 自建后端**必须**避开本机已装 Paseo 的 6767**：官方 daemon 的 listen 是从持久配置读的
     （`daemon.listen`，见 @getpaseo/server 的 resolveListenAddress），默认 6767 ——
     而 Paseo 桌面端那份长期占着 6767，自建 daemon 一起来就 `EADDRINUSE` 退出，
     现场表现成「依赖装好了、后端起不来」。这里给它钉一个本地空闲端口（只写自建 home 的配置，
     不碰用户自己那份；用户若已配过 daemon.listen 则一字不改）。 */
  const port = await ensureOwnListen(check.cli, home, { node: rt.bin });
  broadcast("paseoRemote:progress", { phase: "install", message: "依赖已就位（自检 v" + check.version + "）" });
  return { ok: true, installDir: safe.path, home, version: check.version, listen: port.listen, check };
}
/** 端口是否空闲（本地回环上试占一下；占了就换一个，不去动占着它的那个进程） */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, "127.0.0.1");
    } catch {
      resolve(false);
    }
  });
}
/** 读一个 daemon 配置键（官方 CLI 的 get --json） */
async function cliGetDaemonConfig(cli, home, path0, node) {
  const r = await spawnConfigCli(cli, ["daemon", "config", "get", path0, "--json", "--home", home], node);
  const j = lastJson(r.stdout);
  return { ok: !!r.ok, set: !!(j && j.set), value: j ? j.value : null };
}
/** 写一个 daemon 配置键（官方 CLI 的 set） */
function cliSetDaemonConfig(cli, home, path0, value, node) {
  return spawnConfigCli(cli, ["daemon", "config", "set", path0, String(value), "--home", home], node);
}
/** 配置类 CLI 调用：拿得到真 Node 与自建入口时就 `<真Node> <入口>`，否则退回 shim */
function spawnConfigCli(cli, args, node) {
  const spec = ownCliSpec({ node: node || "" }, loadConfig());
  if (spec && String(cli || "") === ownCliPath(loadConfig())) return spawnCli(spec.node, spec.args.concat(args), { timeoutMs: CLI_TIMEOUT_MS });
  return spawnCli(cli, args, { timeoutMs: CLI_TIMEOUT_MS });
}
/** 自建后端要用的端口：默认按「6767 空闲就用，被占就 6768+」挑；
 *  `MTNODE_PASEO_PORT` 可指定（隔离测试用，避免在开发机上正好撞到别的服务的端口）。 */
function preferredOwnPort() {
  const n = Number(process.env.MTNODE_PASEO_PORT || 0);
  return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : 0;
}
/** 确保自建 daemon 的 listen 不与本机已装 Paseo（默认 6767）抢：没配过就钉一个空闲端口。
 *  force=true（起后端时撞了 EADDRINUSE）：无论配过没有，都换一个当下真正空闲的端口。 */
async function ensureOwnListen(cli, home, opts) {
  const force = !!(opts && opts.force);
  const node = String((opts && opts.node) || "");
  const cur = await cliGetDaemonConfig(cli, home, "daemon.listen", node);
  if (!force && cur.set && cur.value) {
    appendConsole("[install] daemon.listen 已配置（沿用用户口径）：" + String(cur.value));
    return { ok: true, listen: String(cur.value), kept: true };
  }
  const want = preferredOwnPort();
  let base = 0;
  if (want && (await portFree(want))) base = want;
  else if (!force && !want && (await portFree(6767))) {
    appendConsole("[install] 6767 空闲：沿用官方默认端口");
    return { ok: true, listen: "127.0.0.1:6767", kept: true };
  }
  if (!base) {
    for (let p = 6768; p <= 6787; p++) {
      if (!(await portFree(p))) continue;
      base = p;
      break;
    }
  }
  if (!base) {
    appendConsole("[install] 6767~6787 全被占：没有可用端口给自建后端");
    return { ok: false, listen: "", error: "no_free_port" };
  }
  const set = await cliSetDaemonConfig(cli, home, "daemon.listen", "127.0.0.1:" + base, node);
  appendConsole("[install] 6767 被别人占着 → 自建 daemon 改用 127.0.0.1:" + base + "（code=" + set.code + "）");
  return { ok: true, listen: "127.0.0.1:" + base, kept: false };
}
/**
 * 「改用本机已装的 Paseo」：把模式切回复用。
 * 为什么要这颗按钮：own 模式一旦指向一个装不成的目录就是死胡同（旧代码在 own 下不看桌面端与 PATH），
 * 用户明明机器上装着 Paseo 也用不上。**只改用户亲手点的这一下**，不静默改写配置。
 */
function switchToReuse() {
  const cand = reuseCandidate();
  if (!cand.available) return { ok: false, error: "no_reuse_cli" };
  const cfg = loadConfig();
  saveConfig({ mode: "reuse", installDir: "", ownHome: cfg.ownHome || join(pluginRoot(), "paseo-home") });
  appendConsole("[mode] 已切回复用本机已装的 Paseo：" + cand.cli + "（" + cand.source + "）");
  return { ok: true, cli: cand.cli, source: cand.source };
}
/** 起后端（自建模式；复用模式由 Paseo Desktop 自己管，按钮不显示） */
async function startDaemon() {
  const cfg = loadConfig();
  const cli = resolveCli(cfg);
  if (!cli.cli) return { ok: false, error: "cli_missing" };
  busy = "start";
  const r = await spawnPaseoCli(cfg, withHome(["daemon", "start"], cfg), { timeoutMs: DAEMON_START_TIMEOUT_MS });
  const j = lastJson(r.stdout);
  appendConsole("[daemon] start → code=" + r.code + (j && j.listen ? " listen=" + j.listen : ""));
  /* 端口被占是最常见的起不来（本机已装的 Paseo 常占着 6767）：换一个空闲端口再试一次 */
  const text = String(r.stdout || "") + String(r.stderr || "");
  if (!r.ok && /EADDRINUSE|address already in use/i.test(text)) {
    const home = paseoHomeOf(cfg);
    appendConsole("[daemon] 端口被占 → 给自建后端换一个空闲端口再试");
    broadcast("paseoRemote:progress", { phase: "start", message: "端口被本机已装的 Paseo 占着，换端口重试…" });
    const listen = await ensureOwnListen(cli.cli, home, { force: true });
    if (listen.ok) {
      const r2 = await spawnPaseoCli(cfg, withHome(["daemon", "start"], cfg), { timeoutMs: DAEMON_START_TIMEOUT_MS });
      const j2 = lastJson(r2.stdout);
      busy = "";
      appendConsole("[daemon] 换端口后 start → code=" + r2.code + " listen=" + String(listen.listen || ""));
      if (r2.ok) return { ok: true, listen: String(listen.listen || (j2 && j2.listen) || ""), retriedPort: true };
      reportErr("daemon_start_failed", "Paseo daemon 启动失败（换端口重试仍失败）：" + String(r2.stderr || "").slice(-300), { phase: "start" });
      return { ok: false, error: "daemon_start_failed", detail: String(r2.stderr || "").slice(-400) };
    }
  }
  busy = "";
  if (!r.ok) {
    reportErr("daemon_start_failed", "Paseo daemon 启动失败：" + String(r.stderr || "").slice(-300), { phase: "start" });
    return { ok: false, error: "daemon_start_failed", detail: String(r.stderr || "").slice(-400) };
  }
  return { ok: true, listen: String((j && j.listen) || "") };
}
async function stopDaemon() {
  const cfg = loadConfig();
  const cli = resolveCli(cfg);
  if (!cli.cli) return { ok: false, error: "cli_missing" };
  busy = "stop";
  const r = await spawnPaseoCli(cfg, withHome(["daemon", "stop"], cfg), { timeoutMs: 30000 });
  busy = "";
  appendConsole("[daemon] stop → code=" + r.code);
  return { ok: r.ok };
}

/* ------------------------------------------------------------------ */
/* 控制台窗                                                             */
/* ------------------------------------------------------------------ */
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
    width: 520,
    height: 720,
    x: Math.min(wa.x + wa.width - 560, wa.x + wa.width - 100),
    y: wa.y + 30,
    frame: true,
    show: true,
    title: "Paseo 手机接管",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-paseo.js"),
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
    if (w && !w.isDestroyed()) w.webContents.send("paseoRemote:consoleChanged", { open: !!open });
  } catch {}
}
/** removePluginMeta：只移除数据目录里的入口副本（ui/），保留配置与自建后端 */
function removePluginMetaOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  const ui = join(pluginRoot(), "ui");
  try {
    if (exists(ui)) fs.rmSync(ui, { recursive: true, force: true });
  } catch {}
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

/* ------------------------------------------------------------------ */
/* IPC 注册                                                             */
/* ------------------------------------------------------------------ */
function registerPaseoRemoteIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || join(__dirname, "..");
  getMcp = typeof opts.getMcp === "function" ? opts.getMcp : null;

  mk(pluginRoot());
  appendConsole("[boot] 宿主注册（mode=" + loadConfig().mode + "）");

  /* 报错总线：注册宿主（现场目录 = 自建安装目录，日志 = 控制台日志尾部；
     修复入口由渲染层那条看得见的会话走，skill 名指向 paseo-remote-install）。 */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "Paseo 手机接管",
    skillName: INSTALL_SKILL,
    getInstallDir: () => {
      const c = loadConfig();
      if (c.installDir && exists(c.installDir)) return c.installDir;
      return pluginRoot();
    },
    tailConsole: (n) => consoleTail(n),
    /* 修完的「重启该服务」：先停旧 daemon 再拉起（renderer/app-repair.js 的收尾走这里；
       复用桌面端那份 daemon 时，重启同样经官方 CLI，不会去动桌面端进程本身）。 */
    restart: async () => {
      await stopDaemon();
      return await startDaemon();
    },
  });

  const handle = (ch, fn) => ipcMain.handle("paseoRemote:" + ch, async (e, arg) => {
    try {
      return await fn(arg);
    } catch (err) {
      const msg = String((err && err.message) || err);
      appendConsole("[ipc] " + ch + " 失败：" + msg);
      return { ok: false, error: msg };
    }
  });

  handle("getStatus", () => statusForUi());
  handle("pair", () => pairingOffer());
  handle("enableRelay", () => enableRelay());
  handle("providerApply", (o) => applyProvider(o || {}));
  handle("providerRemove", () => removeProvider());
  handle("remoteSet", (o) => setRemoteEnabled(o && o.on));
  handle("disconnectAll", () => disconnectAllRemote());
  handle("resetPairing", () => resetPairing());
  handle("install", (o) => installBackend(o || {}));
  handle("pickInstallDir", () => pickInstallDir());
  /* 一键改用本机已装的 Paseo（own 走不通时的出口；只改用户亲手点的这一下） */
  handle("useReuse", () => switchToReuse());
  /* 真 Node 前置：先看有没有达标的真 Node（缺 / 过旧就自动装一份托管 Node），
     装到再顺带等桥要的那份（同一份，不主动改 dsh 的解析结果）。 */
  handle("waitNode", async () => {
    const rt = await ensureNodeRuntime({});
    const r = await waitRealNode({ timeoutMs: NODE_WAIT_MS });
    if (!rt.ok) {
      return { ok: false, error: rt.error === "download-failed" ? "node_install_failed" : "node_too_old", detail: nodeRuntimeMsg(rt), nodeBin: "" };
    }
    return r.ok
      ? { ok: true, node: r.node, waitedMs: r.waitedMs, runtime: { bin: rt.bin, version: rt.version, installed: !!rt.installed } }
      : { ok: false, error: r.error, detail: r.detail, nodeBin: (r.node && r.node.bin) || "" };
  });
  /* 「清干净重装」：用旧 Node 装出来的依赖只能删掉重来 —— **用户点这一下才删**，不静默动目录 */
  handle("cleanReinstall", async (o) => {
    const arg = o || {};
    const cfg = loadConfig();
    const dir = arg.installDir || cfg.installDir;
    if (!dir) return { ok: false, error: "empty_dir" };
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    const removed = cleanOwnDeps(safe.path);
    appendConsole("[install] 清干净重装：已删 " + (removed.length ? removed.join(" | ") : "（无残留可删）"));
    return await installBackend({ installDir: safe.path });
  });
  handle("startDaemon", () => startDaemon());
  handle("stopDaemon", () => stopDaemon());
  handle("consoleTail", (n) => consoleTail(n));
  handle("consoleClear", () => clearConsoleLog());
  /* 前置依赖：本机服务端（会话族走它）。不静默改用户设置 —— 这里只做「用户点了才开」。 */
  handle("serverEnable", async () => {
    const m = getMcp ? getMcp() : null;
    if (!m) return { ok: false, error: "mcp_unavailable" };
    await m.setEnabled(true);
    const s = m.status();
    return { ok: !!s.enabled, status: { enabled: !!s.enabled, port: Number(s.port || 0) } };
  });
  handle("open", () => openConsoleWindow());
  handle("close", () => closeConsoleWindow());
  handle("removePluginMeta", () => removePluginMetaOnly());
  /* 桥自检（复用既有 --check）：真 spawn 一次桥脚本，读数据目录并探活本机服务端 */
  handle("bridgeCheck", async () => {
    const node = realNode();
    const bp = bridgeInfo.bridgePaths({
      appRoot,
      resourcesDir: process.resourcesPath || "",
      dataDir: dataDir(),
      nodeBin: node.bin,
    });
    if (!exists(bp.script)) return { ok: false, error: "bridge_missing", script: bp.script };
    const r = await spawnCli(node.bin, [bp.script, "--check"], { timeoutMs: 20000 });
    return { ok: r.ok, code: r.code, text: String(r.stdout || "") + String(r.stderr || "") };
  });
  /* 提问通道自检（桥的 --probe-question）：真跑一次「MTNode 发询问卡 → 桥以 form
     elicitation 交给客户端 → 表单应答 → 回执送回 MTNode」这条链，四拍逐个报。
     为什么要它：手机上「询问框没弹出 / 答了回不到 MTNode」时，光看日志分不清断在哪一拍。 */
  handle("bridgeProbeQuestion", async () => {
    const node = realNode();
    const bp = bridgeInfo.bridgePaths({
      appRoot,
      resourcesDir: process.resourcesPath || "",
      dataDir: dataDir(),
      nodeBin: node.bin,
    });
    if (!exists(bp.script)) return { ok: false, error: "bridge_missing", script: bp.script };
    appendConsole("[提问通道自检] 开始（" + bp.script + "）…");
    const r = await spawnCli(node.bin, [bp.script, "--probe-question"], {
      timeoutMs: 120000,
      onLine: (line) => appendConsole("[提问通道自检] " + line),
    });
    const text = String(r.stdout || "") + String(r.stderr || "");
    appendConsole("[提问通道自检] 结束（code=" + r.code + "）");
    return { ok: r.ok && r.code === 0, code: r.code, text };
  });
}

/** 应用退出时只关控制台窗：daemon 是常驻单例（手机随时要用），一律不动它。 */
function shutdownPaseoRemoteUiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
}

module.exports = {
  registerPaseoRemoteIpc,
  shutdownPaseoRemoteUiOnly,
  statusForUi,
  isRemoteEnabled,
  sessionGate,
  setRemoteEnabled,
  disconnectAllRemote,
  /* 隔离安装测试（test/smoke-paseo-install-isolation.js）与自我修复用的纯逻辑出口：
     这些函数不碰 Electron，只在宿主的模块作用域里（测试用假 electron 加载本文件后直呼）。 */
  __internals: {
    overrideDirs,
    homeDir,
    desktopCliCandidates,
    resolveCli,
    reuseCandidate,
    ownCliPath,
    ownCliEntry,
    ownCliSpec,
    cliVersionOf,
    verifyOwnInstall,
    resolveCommandPath,
    cliSetDaemonConfig,
    cliGetDaemonConfig,
    ensureOwnListen,
    portFree,
    startDaemon,
    stopDaemon,
    statusForUi,
    nodeReadyOf,
    waitRealNode,
    detectBackend,
    installBackend,
    switchToReuse,
    cleanOwnDeps,
    isSafeInstallDir,
    paseoHomeOf,
    /* 本轮新增：Node 运行时预检 / 自动安装 / 与解析出的 Node 配套的 npm */
    NODE_MIN_VERSION,
    MANAGED_NODE_VERSION,
    pickNodeRuntime,
    ensureNodeRuntime,
    npmCliOf,
    npmSpecFor,
    probeNodeKind,
    nodeRuntimeMsg,
    nodeVersionFromText,
    spawnPaseoCli,
    cachedNodeRuntime,
  },
  PLUGIN_ID,
  KIND,
  INSTALL_SKILL,
};

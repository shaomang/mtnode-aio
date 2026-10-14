#!/usr/bin/env node
/* 「Paseo 手机接管」隔离安装 · 真装实测（要网络，默认不跑；run-all 归入 MANUAL）：
 *   node test/smoke-paseo-install-real.mjs
 *
 * 它回答的是现场那个问题：**一台没装 Paseo 的机器，在安装窗里点「开始安装」到底装不装得上？**
 * 所以这里走真实链路，只用隔离目录、隔离 home、隔离端口（不动本机 ~/.paseo 与已装的 Paseo）：
 *   [1] 隔离「空机器」：MTNODE_PASEO_DIRS 指向空目录 → 复用模式找不到 CLI（复现现场前提）
 *   [2] **走宿主真身**：假 electron 加载 paseo/main-paseo.js，调它真正的 installBackend()
 *       （npm i → 自检 → 开 relay），判据与界面上的「安装自检 / installed」完全同一份
 *   [3] 起独立 daemon（PASEO_HOME + PASEO_LISTEN=127.0.0.1:6789）→ 探 /api/status → stop
 *   [4] own 走不通时的一键回落：把 installDir 改成一个空目录，再用真身点 switchToReuse()
 * 全程产物写 <临时根>/paseo-install-real-<pid>/，收尾整目录删除（用户口径：只留结论）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const PORT = Number(process.env.PASEO_TEST_PORT || 6789);
const TEST_PORT = PORT; // 自建后端要用的隔离端口（宿主 MTNODE_PASEO_PORT 优先用它）
const KEEP = !!process.env.PASEO_TEST_KEEP;

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
function note(s) {
  console.log("  ·  " + s);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      windowsVerbatimArguments: !!opts.verbatim,
      env: Object.assign({}, process.env, opts.env || {}),
      cwd: opts.cwd || undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, opts.timeoutMs || 30 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: Number(code), out, err, cmd: cmd + " " + args.join(" ") });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + String((e && e.message) || e), cmd: cmd + " " + args.join(" ") });
    });
  });
}

/** Windows 上 CLI 是 .cmd：经 cmd.exe 调用（与宿主 spawnCli 同一姿势：
 *  每个参数各自加引号、整条命令再包一层，交 /d /s /c 剥最外层） */
function cliRun(cli, args, opts = {}) {
  /* 注意：下面这些调用是**测试自己**发起的，不能带上测试注入（MTNODE_PASEO_DIRS） */
  const cleanEnv = Object.assign({}, process.env, opts.env || {});
  delete cleanEnv.MTNODE_PASEO_DIRS;
  if (process.platform !== "win32") return run(cli, args, Object.assign({}, opts, { env: cleanEnv }));
  const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '\\"') + '"';
  const line = q(cli) + " " + args.map(q).join(" ");
  return run("cmd.exe", ["/d", "/s", "/c", '"' + line + '"'], Object.assign({}, opts, { env: cleanEnv, verbatim: true }));
}

function probeStatus(listen) {
  return new Promise((resolve) => {
    const [host, port] = String(listen).split(":");
    const req = http.get({ host: host || "127.0.0.1", port: Number(port), path: "/api/status", timeout: 2000 }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, json: JSON.parse(b) });
        } catch {
          resolve({ ok: false, json: null });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, json: null });
    });
    req.on("error", () => resolve({ ok: false, json: null }));
  });
}

const SANDBOX = path.join(os.tmpdir(), "paseo-install-real-" + process.pid);
const DATA_DIR = path.join(SANDBOX, "data");
const EMPTY_MACHINE = path.join(SANDBOX, "empty-machine");
const INSTALL_DIR = path.join(SANDBOX, "own-backend");
for (const d of [DATA_DIR, EMPTY_MACHINE, INSTALL_DIR]) fs.mkdirSync(d, { recursive: true });

/* 把宿主拉进纯 Node：先用假 electron 占住 require.cache（仓库里其它冒烟同法） */
const electronEntry = require.resolve("electron");
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: {
      getVersion: () => "0.0.0-smoke",
      getAppPath: () => ROOT,
      getPath: () => DATA_DIR,
    },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    ipcMain: { handle: () => {} },
    dialog: { showOpenDialogSync: () => undefined },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
  },
  children: [],
  paths: [],
};
process.env.MTNODE_DATA_DIR = DATA_DIR;
process.env.MTNODE_PASEO_USERPROFILE = SANDBOX;
process.env.MTNODE_PASEO_DIRS = EMPTY_MACHINE; // 这台「机器」上什么都没装
process.env.MTNODE_PASEO_PORT = String(TEST_PORT); // 隔离端口：连「6767 被占」这条分支一起验

const host = require(path.join(ROOT, "paseo", "main-paseo.js"));
const I = host.__internals;
/* 自建模式的 home 由宿主决定（数据目录下的 paseo\paseo-home，见宿主 pluginRoot()）：
   安装回执里会带回来，安装前先按同一份口径算出来给 daemon 那几步用 */
const HOME_DIR = path.join(DATA_DIR, "paseo", "paseo-home");

console.log("隔离根：" + SANDBOX);
console.log("（宿主真身：" + path.join("paseo", "main-paseo.js") + " · 数据目录 " + DATA_DIR + "）");
console.log("[1] 隔离「空机器」：复用模式找不到 CLI");
{
  ok(I.resolveCli({ mode: "reuse" }).cli === "", "空机器 + 复用模式 → cli_missing（现场前提成立）");
  ok(I.reuseCandidate().available === false, "空机器上没有可回落的本机 Paseo");
}

console.log("[2] 走宿主真身：installBackend()（npm i → 自检 → 开 relay）");
let installRes = null;
try {
  /* forceOwn = 安装窗里那个「仍要自建一份（忽略本机已装的 Paseo）」复选框：
     不勾它的话探测步骤会优先复用本机那份 Paseo，这里要验的正是「自建这条路装不装得上」 */
  installRes = await I.installBackend({ installDir: INSTALL_DIR, forceOwn: true });
} catch (e) {
  ok(false, "installBackend 抛异常：" + ((e && e.message) || e));
}
const CLI = path.join(INSTALL_DIR, "node_modules", ".bin", "paseo.cmd");
const DEP = path.join(INSTALL_DIR, "node_modules", "@getpaseo", "cli");
if (installRes) {
  if (!installRes.ok) note("installBackend 回执：" + JSON.stringify(installRes).slice(0, 600));
  ok(installRes.ok === true, "installBackend 返回 ok（自检版本 v" + (installRes.version || "?") + "）");
  ok(typeof installRes.version === "string" && /^\d+\.\d+/.test(installRes.version), "自检报出版本号：" + installRes.version);
  ok(fs.existsSync(DEP), "依赖落点 node_modules\\@getpaseo\\cli 存在");
  ok(fs.existsSync(CLI), "bin shim node_modules\\.bin\\paseo.cmd 生成");
  let relayOn = false;
  try {
    relayOn = JSON.parse(fs.readFileSync(path.join(HOME_DIR, "config.json"), "utf8")).daemon.relay.enabled === true;
  } catch {}
  if (!relayOn) {
    note("relay 未生效：HOME_DIR=" + HOME_DIR + " 存在=" + fs.existsSync(HOME_DIR) + "（installRes.home=" + (installRes.home || "-") + "）");
  }
  ok(relayOn, "隔离 home 的 config.json：daemon.relay.enabled === true（新 home 默认关，宿主已开）");
  const pre = await cliRun(CLI, ["daemon", "config", "get", "daemon.relay", "--json", "--home", HOME_DIR], { timeoutMs: 60000 });
  note("daemon config get daemon.relay → " + (pre.out || pre.err).trim().split(/\r?\n/).slice(-1)[0]);
  const st = await I.detectBackend();
  ok(st.mode === "own" && st.installed === true, "detectBackend：own + installed=true（界面状态行同源）");
  ok(st.cliSource === "own" && st.cli === CLI, "cliSource=own 且指向隔离目录那份");
  ok(st.installCheck && st.installCheck.ok !== false && !st.installCheck.reason, "安装自检通过（无失败原因）");
  const v = await I.cliVersionOf(CLI);
  ok(v.ok && v.version === installRes.version, "自检函数可重复调用（幂等）：v" + v.version);
} else {
  ok(false, "installBackend 没返回（看上面日志）");
}

console.log("[3] 起后端：走宿主真身 startDaemon()（须避开本机已装 Paseo 的 6767）");
let started = false;
let listen = "";
if (installRes && installRes.ok) {
  const r = await I.startDaemon();
  listen = String(r.listen || "");
  note("startDaemon 回执：" + JSON.stringify(r).slice(0, 300));
  ok(r.ok === true, "startDaemon 成功（listen=" + (listen || "?") + "）");
  ok(!!listen && !/:6767$/.test(listen), "自建后端没有去抢 6767（listen=" + listen + "）");
  const probe = await probeStatus(listen);
  started = probe.ok;
  ok(probe.ok, "探 /api/status（" + listen + "）→ " + (probe.ok ? "status=" + String(probe.json && probe.json.status) : "无响应"));
  if (probe.ok && probe.json) {
    note("/api/status 回执（去噪）：" + JSON.stringify(probe.json).slice(0, 240));
    ok(!!probe.json.serverId, "daemon 报了 serverId（" + String(probe.json.serverId) + "）");
  }
  const pidFile = path.join(HOME_DIR, "paseo.pid");
  ok(fs.existsSync(pidFile), "隔离 home 里有 paseo.pid（宿主据此探活）");
  if (fs.existsSync(pidFile)) {
    let lock = null;
    try {
      lock = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    } catch {}
    ok(!!lock && String(lock.listen || "") === listen, "paseo.pid 里的 listen 与回执一致（" + String(lock && lock.listen) + "）");
  }
  const st2 = await I.detectBackend();
  ok(st2.daemon && st2.daemon.running === true, "detectBackend：daemon.running=true（宿主真探到了）");
} else {
  ok(false, "跳过 daemon：安装没成功");
}

console.log("[4] own 走不通时的一键回落（安装窗探测步骤用的 switchToReuse）");
{
  const broken = path.join(SANDBOX, "broken-own");
  fs.mkdirSync(broken, { recursive: true });
  const cfgPath = path.join(DATA_DIR, "paseo", "config.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  }
  cfg.installDir = broken;
  cfg.mode = "own";
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const st = await I.detectBackend();
  ok(st.installed === false && st.installCheck && st.installCheck.reason === "dep_missing", "把安装目录改坏：自检如实报 dep_missing（不再只看目录残留）");
  const noReuse = I.switchToReuse();
  ok(noReuse.ok === false && noReuse.error === "no_reuse_cli", "这台机器确实没有别的 Paseo → 一键回落如实拒绝（不假装成功）");
  /* 现在「这台机器装上了 Paseo 桌面端」：注入一个桌面端形态的 CLI 再回落 */
  const desk = path.join(SANDBOX, "fake-desktop");
  fs.mkdirSync(path.join(desk, "resources", "bin"), { recursive: true });
  const js = path.join(desk, "cli.js");
  fs.writeFileSync(js, 'if (process.argv[2] === "--version") { console.log("8.8.8"); process.exit(0); }\nprocess.exit(0);\n', "utf8");
  const cmd = path.join(desk, "resources", "bin", "paseo.cmd");
  fs.writeFileSync(cmd, "@echo off\r\n" + '"' + process.execPath + '" "' + js + '" %*\r\n', "utf8");
  process.env.MTNODE_PASEO_DIRS = desk;
  const re = I.switchToReuse();
  ok(re.ok === true && re.source === "desktop", "装了桌面端后：一键回落成功（cli=" + re.cli + "）");
  const st2 = await I.detectBackend();
  ok(st2.mode === "reuse" && st2.installed === true && st2.version === "8.8.8", "回落后的状态：reuse + installed=true + v8.8.8");
}

console.log("[5] 收尾：停 daemon + 删隔离目录");
if (started) {
  const stop = await I.stopDaemon();
  ok(stop && stop.ok === true, "宿主 stopDaemon() → ok=" + (stop && stop.ok));
} else {
  note("daemon 没起来，无需停止");
}
if (KEEP) {
  note("PASEO_TEST_KEEP=1：保留隔离目录供人工复核 → " + SANDBOX);
} else {
  /* daemon stop 停的是 supervisor，worker 进程可能还活着并压着隔离目录里的文件句柄 ——
     证据：跑完 stopDaemon 后仍有 `node …\<沙盒>\own-backend\node_modules\@getpaseo\server\…` 在跑。
     只收「命令行里带这个沙盒路径」的 node 进程（不按镜像名乱杀，免得碰到本机别的 node）。 */
  if (process.platform === "win32") {
    const q = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*" +
          SANDBOX +
          "*' } | ForEach-Object { $_.ProcessId }",
      ],
      { timeoutMs: 30000 },
    );
    const pids = String(q.out || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
    for (const pid of pids) await run("taskkill", ["/PID", pid, "/T", "/F"], { timeoutMs: 20000 });
    if (pids.length) note("收尾清掉隔离进程 " + pids.join(","));
    else note("没有残留的隔离进程");
    await new Promise((r) => setTimeout(r, 1500));
  }
  let removed = false;
  for (let i = 0; i < 6 && !removed; i++) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      removed = !fs.existsSync(SANDBOX);
    } catch {
      removed = false;
    }
    if (!removed) await new Promise((r) => setTimeout(r, 2000));
  }
  if (removed) ok(true, "隔离目录已删除：" + SANDBOX);
  else note("隔离目录没删干净（daemon worker 未退干净）：" + SANDBOX + "（可人工删）");
}

console.log("");
console.log(fails === 0 ? "全部通过：" + checks + " 项" : "失败 " + fails + " / " + checks + " 项");
process.exit(fails === 0 ? 0 : 1);

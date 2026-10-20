"use strict";
/* 「Paseo 手机接管」自建后端**后台静默**冒烟（纯 Node，不需要 Electron）：
 *   node test/smoke-paseo-daemon-silent.js
 *
 * 钉的是本轮共识（2026-10）：自建 daemon 改由**宿主持有** `paseo daemon run --home <自建 home>`
 * （`windowsHide` + stdio 管道），因此
 *   [1] 静态口径：宿主不再用官方 `paseo daemon start` 起后端；静默启动的那一处必须带
 *       `windowsHide: true` / `stdio` 管道 / `daemon run`；退出收尾真的会停它
 *   [2] **真测量**（Windows + 真装好的自建 CLI 时）：真起一次后端，
 *       用 `scripts/probe-console-windows.ps1`（项目自带的真尺子：枚举可见的
 *       ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS / PseudoConsoleWindow 窗口）数窗口 ——
 *       断言**零新增可见控制台窗口**，这才是「不再冒那只会被误关的终端窗口」的证据
 *   [3] 就绪与生命周期：`/api/status` 真的通、pid 锁里的 pid 就是宿主持有的那个子进程、
 *       `stopOwnDaemon()` 之后进程真的没了（不留孤儿）
 *   [4] 存量迁移判据 `ownDaemonHosted()`：不是宿主持有的那份一律判 false（旧方式起的会被换掉）
 *
 * 为什么是「真测量」而不是断言代码里写了 `windowsHide`：这次的问题恰恰是**官方 CLI 内部**
 * detached 出窗口，光看我们自己的 spawn 参数看不出来（对照组实测：`daemon start` 一次新增 2 只窗口）。
 *
 * 环境不具备时如实 SKIP（不算失败）：非 win32、没装自建 CLI、窗口探针 / PowerShell 不可用。
 * 隔离纪律：全程只用一个 %TEMP% 下的数据目录 + 独立 daemon home + 独立端口，
 * 绝不碰用户真实数据目录、`~/.paseo`、6767/6768 上那份正在跑的后端。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

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
function skipIt(msg) {
  console.log("  skip  " + msg);
}

const ROOT = path.join(__dirname, "..");
const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const exists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

/* ── 假 Electron：宿主只用到这几样（与 smoke-paseo-install-isolation.js 同一套） ── */
const fakeElectron = {
  app: {
    getVersion: () => "0.0.0-smoke",
    getAppPath: () => ROOT,
    getPath: () => path.join(os.tmpdir(), "mtnode-paseo-silent-userdata"),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  ipcMain: { handle: () => {} },
  dialog: { showOpenDialogSync: () => undefined },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
};
const electronEntry = require.resolve("electron");
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: fakeElectron,
  children: [],
  paths: [],
};

/* ── 隔离现场 ───────────────────────────────────────────────────────────── */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-silent-"));
const DATA_DIR = path.join(SANDBOX, "data");
const EMPTY_MACHINE = path.join(SANDBOX, "no-desktop-paseo"); // 「这台机器没有别的 Paseo」
const OWN_HOME = path.join(SANDBOX, "own-home");
for (const d of [DATA_DIR, EMPTY_MACHINE, OWN_HOME]) fs.mkdirSync(d, { recursive: true });
process.env.MTNODE_DATA_DIR = DATA_DIR;
process.env.MTNODE_PASEO_USERPROFILE = SANDBOX;
process.env.MTNODE_PASEO_DIRS = EMPTY_MACHINE;

const host = require(abs("paseo/main-paseo.js"));
const I = host.__internals;
const DATA_ROOT = path.join(DATA_DIR, "paseo");
const CONFIG = path.join(DATA_ROOT, "config.json");
const CONSOLE_LOG = path.join(DATA_ROOT, "console.log");
const PORT = 6795;
const LISTEN = "127.0.0.1:" + PORT;

/** 本机上真装好的自建后端（宿主自建模式用的就是它）；没有就 SKIP 真测量那两段 */
function findRealInstallDir() {
  if (process.env.MTNODE_PASEO_SMOKE_INSTALL_DIR) return process.env.MTNODE_PASEO_SMOKE_INSTALL_DIR;
  const cands = [
    "E:\\mtnode-plugins\\paseo",
    path.join(os.homedir(), "mtnode-plugins", "paseo"),
    path.join(String(process.env.LOCALAPPDATA || ""), "mtnode-plugins", "paseo"),
  ];
  return cands.find((d) => exists(path.join(d, "node_modules", "@getpaseo", "cli", "bin", "paseo"))) || "";
}
const INSTALL_DIR = findRealInstallDir();

function writeCfg(o) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(o, null, 2), "utf8");
}
/** 探针：枚举当前可见的控制台类窗口（项目自带真尺子） */
function probeSnapshot() {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", abs("scripts/probe-console-windows.ps1"), "-Pretty"],
    { encoding: "utf8", windowsHide: true, timeout: 60000 },
  );
  try {
    return JSON.parse(String(r.stdout || ""));
  } catch {
    return null;
  }
}
/** 盯 seconds 秒（探针自己采样，避免每帧起一只 PowerShell） */
function watchWindows(seconds) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          abs("scripts/probe-console-windows.ps1"),
          "-WatchSeconds",
          String(seconds),
          "-IntervalMs",
          "120",
        ],
        { windowsHide: true },
      );
    } catch {
      return resolve(null);
    }
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve(null);
      }
    });
  });
}
function newWindows(before, after) {
  const seen = new Set(((before && before.items) || []).map((i) => i.handle));
  return ((after && after.items) || []).filter((i) => !seen.has(i.handle));
}
function daemonStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/status", timeout: 1500 }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ code: res.statusCode, body: b }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}
function pidAlive(pid) {
  if (!pid) return false;
  try {
    const r = spawnSync("tasklist", ["/FI", "PID eq " + pid, "/NH"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    return new RegExp("\\b" + pid + "\\b").test(String(r.stdout || ""));
  } catch {
    return false;
  }
}
/** 按命令里出现的隔离 home 路径找残留进程（收尾兜底） */
function homeProcesses(home) {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*" +
        String(home).replace(/\\/g, "\\\\") +
        "*' } | Select-Object -ExpandProperty ProcessId",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  return String(r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function killPids(pids) {
  for (const p of pids) {
    try {
      spawnSync("taskkill", ["/pid", String(p), "/T", "/F"], { windowsHide: true, timeout: 8000 });
    } catch {}
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ═════════ [1] 静态口径：真的不再用 daemon start，静默启动的那一处参数齐备 ═════════ */
  console.log("\n[1] 静态口径：宿主持有 `paseo daemon run`（不再用官方 daemon start）");
  const src = read("paseo/main-paseo.js");
  const codeOnly = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join("\n");
  ok(!/\[\s*"daemon"\s*,\s*"start"/.test(codeOnly), "代码里不再有 `daemon start` 的调用（只有注释里作为来龙去脉留档）");
  ok(/\[\s*"daemon"\s*,\s*"run"\s*,/.test(codeOnly), "静默启动走 `daemon run --home <自建 home>`");
  const spawnSeg = codeOnly.slice(codeOnly.indexOf("async function startOwnDaemonSilently"), codeOnly.indexOf("async function stopOwnDaemon"));
  ok(/windowsHide:\s*true/.test(spawnSeg), "静默启动的 spawn 带 windowsHide: true");
  ok(/stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/.test(spawnSeg), "静默启动的 spawn 接管 stdio（输出逐行进控制台日志）");
  ok(/detached:\s*false/.test(spawnSeg), "不 detached（进程随宿主走：MTNode 退出即停）");
  ok(/attachOwnStdio\(child\)/.test(spawnSeg) && /appendConsole\("\[daemon\] " \+ line\)/.test(src), "daemon 输出逐行写进控制台日志");
  const startSeg = codeOnly.slice(codeOnly.indexOf("async function startDaemon"), codeOnly.indexOf("async function stopDaemon"));
  ok(/ensureOwnDaemon\(/.test(startSeg), "startDaemon 走 ensureOwnDaemon（含存量旧实例迁移）");
  ok(/EADDRINUSE/.test(startSeg) && /force:\s*true/.test(startSeg), "端口被占仍会换一个空闲端口重试一次");
  const shutdownSeg = codeOnly.slice(codeOnly.indexOf("function shutdownPaseoRemoteUiOnly"));
  ok(/stopOwnDaemon\(/.test(shutdownSeg), "退出收尾真的会停宿主持有的 daemon");
  ok(/RESTART_MAX\s*=\s*3/.test(codeOnly), "意外退出重启上限为 3 次（与共识一致）");
  ok(/DAEMON_STOP_GRACE_MS\s*=\s*5000/.test(codeOnly), "优雅停止窗口 5 秒（超时按进程树强杀）");
  const mainSrc = read("main.js");
  ok(
    /paseoRemote\.shutdownPaseoRemoteUiOnly\(\)/.test(mainSrc) && /before-quit/.test(mainSrc),
    "main.js 的 before-quit 仍接在退出链上（调用点不 await：不拦 MTNode 退出）",
  );

  /* ═════════ [2] 走一遍真宿主逻辑（隔离 home + 独立端口） ═════════ */
  console.log("\n[2] 宿主逻辑：起一次静默后端（隔离 home / 独立端口 " + PORT + "）");
  const rt = I.pickNodeRuntime({});
  const envOk = process.platform === "win32" && !!INSTALL_DIR && exists(path.join(INSTALL_DIR, "node_modules", "@getpaseo", "cli", "bin", "paseo"));
  if (!envOk) {
    skipIt(
      "真启动这一段需要 win32 + 一份真装好的自建后端：现在 platform=" +
        process.platform +
        "，installDir=" +
        (INSTALL_DIR || "(未找到；可用 MTNODE_PASEO_SMOKE_INSTALL_DIR 指定)"),
    );
  } else if (!rt.ready) {
    skipIt("本机没有达标的真 Node（≥" + I.NODE_MIN_VERSION + "；现在 " + (rt.version || rt.reason) + "）：跳过真启动");
  } else {
    writeCfg({ mode: "own", installDir: INSTALL_DIR, ownHome: OWN_HOME, remoteEnabled: false, lastPairAt: 0 });
    /* 钉住 listen：绝不碰 6767/6768 上用户正在跑的那两份。
       传 ownCliPath（= .bin\paseo.cmd）：宿主内部会拿真 Node + 真入口跑，正是生产那条路。 */
    const set = await I.cliSetDaemonConfig(I.ownCliPath(), OWN_HOME, "daemon.listen", LISTEN, rt.bin);
    ok(!!set && (set.ok || set.code === 0), "隔离 home 的 daemon.listen 已钉到 " + LISTEN + "（code=" + (set && set.code) + "）");

    const before = probeSnapshot();
    if (!before || before.ok !== true) {
      skipIt("窗口探针跑不起来（PowerShell / Add-Type 不可用）：跳过窗口真测量");
    }
    const watching = before && before.ok === true ? watchWindows(16) : Promise.resolve(null);
    await sleep(1200);
    const started = await I.startOwnDaemonSilently({ home: OWN_HOME, timeoutMs: 90000 });
    const after = await watching;
    ok(!!started.ok, "静默启动成功：" + JSON.stringify({ ok: started.ok, listen: started.listen, pid: started.pid, error: started.error, detail: String(started.detail || "").slice(0, 160) }));
    if (started.ok) {
      ok(String(started.listen || "") === LISTEN, "listen 与钉住的配置一致（" + String(started.listen || "") + "）");
      const st = await daemonStatus(PORT);
      ok(!!st && st.code === 200 && /server_info/.test(String(st.body || "")), "/api/status 真的通（HTTP " + (st && st.code) + "）");
      const lock = JSON.parse(fs.readFileSync(path.join(OWN_HOME, "paseo.pid"), "utf8"));
      const childPid = Number((I.ownDaemonState() || {}).childPid || 0);
      const childIsAncestor = (() => {
        const map = I.processParentMap();
        let cur = Number(lock.pid);
        for (let i = 0; i < 12 && cur; i++) {
          if (cur === childPid) return true;
          cur = Number(map.get(cur) || 0);
        }
        return false;
      })();
      ok(
        !!childPid && (Number(lock.pid) === childPid || childIsAncestor),
        "pid 锁与宿主持有者同一棵进程树（lock=" + lock.pid + " child=" + childPid + "，child 是 lock 的祖先：宿主持有的是 `paseo daemon run`，锁记的是它拉起的官方 supervisor）",
      );
      ok(I.ownDaemonHosted(OWN_HOME) === true, "ownDaemonHosted() 判为 true（这份是宿主持有的静默实例）");
      const logText = exists(CONSOLE_LOG) ? fs.readFileSync(CONSOLE_LOG, "utf8") : "";
      ok(/\[daemon\] 静默启动（宿主持有）/.test(logText), "控制台日志记下了「静默启动（宿主持有）」");
      ok(/\[daemon\] .*"level"/.test(logText) || /\[daemon\] .*daemon|Paseo/i.test(logText), "daemon 输出真的进了控制台日志（逐行）");

      /* 窗口真测量：这是本次需求的核心证据 */
      if (after) {
        const added = newWindows(before, after);
        console.log(
          "  · 窗口读数：起之前 distinct=" + before.distinct + " → 起之后 distinct=" + after.distinct +
            "；新增 " + added.length + " 只 " + JSON.stringify(added),
        );
        ok(added.length === 0, "启动自建后端**零新增可见控制台窗口**（新增 " + added.length + " 只）");
      }

      /* 意外退出（模拟崩溃）→ 宿主必须按 RESTART_MAX 的口径自动重启（官方 managed supervisor 的
         crash-restart 由宿主等价补齐；这里直接 kill 掉宿主持有的那个进程，看它自己回来）。
         为什么排在窗口测量之后：窗口测量还要看这一段期间有没有新增窗口 —— 重启也不该冒窗口。 */
      const beforeCrash = Number((I.ownDaemonState() || {}).childPid || 0);
      if (beforeCrash) {
        const beforeCrashSnap = probeSnapshot();
        const watchCrash = beforeCrashSnap && beforeCrashSnap.ok === true ? watchWindows(22) : Promise.resolve(null);
        await sleep(600);
        try {
          spawnSync("taskkill", ["/pid", String(beforeCrash), "/T", "/F"], { windowsHide: true, timeout: 8000 });
        } catch {}
        let back = false;
        for (let i = 0; i < 40; i++) {
          await sleep(500);
          const st3 = await daemonStatus(PORT);
          const childNow = Number((I.ownDaemonState() || {}).childPid || 0);
          if (st3 && st3.code === 200 && childNow && childNow !== beforeCrash) {
            back = true;
            break;
          }
        }
        const afterCrashSnap = await watchCrash;
        ok(back, "意外退出后宿主自动重启（新子进程接管同一个 listen=" + LISTEN + "；上限 " + I.SILENT.restartMax + " 次）");
        if (afterCrashSnap && beforeCrashSnap && beforeCrashSnap.ok === true) {
          const added2 = newWindows(beforeCrashSnap, afterCrashSnap);
          ok(added2.length === 0, "重启路径也**零新增可见控制台窗口**（新增 " + added2.length + " 只 " + JSON.stringify(added2) + "）");
        } else {
          skipIt("重启那一段没拿到窗口读数：跳过「重启不冒窗口」断言");
        }
        const logText2 = exists(CONSOLE_LOG) ? fs.readFileSync(CONSOLE_LOG, "utf8") : "";
        ok(/\[daemon\] 意外退出/.test(logText2) && /秒后自动重启（第 1\//.test(logText2), "控制台日志记下了「意外退出」与「自动重启（第 N 次）」");
      }

      /* [3] 优雅停止：停完进程真的没了、端口真的空出来（用的是**重启后**那个新子进程） */
      const finalChild = Number((I.ownDaemonState() || {}).childPid || 0);
      const stopped = await I.stopOwnDaemon({ graceMs: 8000 });
      ok(!!stopped.ok, "stopOwnDaemon() 返回 ok（forced=" + !!stopped.forced + " pid=" + finalChild + "）");
      await sleep(1200);
      ok(!pidAlive(finalChild), "停止后子进程 " + finalChild + " 已消失（不留孤儿）");
      const st2 = await daemonStatus(PORT);
      ok(!st2, "停止后 /api/status 不再应答（端口已释放）");
      /* 我们主动停的**不该**触发自动重启（stopping 闸门） */
      await sleep(4000);
      ok(!(await daemonStatus(PORT)) && !Number((I.ownDaemonState() || {}).childPid || 0), "主动「停止后端」之后不会被自动重启拉起来（stopping 闸门）");
      const logText3 = exists(CONSOLE_LOG) ? fs.readFileSync(CONSOLE_LOG, "utf8") : "";
      ok(/\[daemon\] 已停止/.test(logText3), "控制台日志记下「已停止」（区分于「意外退出」）");

      /* [4] ownDaemonHosted：不是我们持有的那份一律 false（旧方式起的会被静默换掉） */
      ok(I.ownDaemonHosted(OWN_HOME) === false, "停掉之后 ownDaemonHosted() 立刻判 false（旧实例判据）");
    }
  }

  /* ═════════ [3] 存量迁移判据（不启真后端：用 pid 锁与宿主状态对照） ═════════ */
  console.log("\n[3] 存量迁移判据：旧「带窗口」实例必须被判成「不是宿主持有」");
  {
    fs.mkdirSync(OWN_HOME, { recursive: true });
    /* 伪造一份「旧方式起的」pid 锁：pid 是一个肯定不是我们子进程的进程（自己） */
    fs.writeFileSync(
      path.join(OWN_HOME, "paseo.pid"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), listen: LISTEN, heartbeat: true }, null, 2),
      "utf8",
    );
    ok(I.ownDaemonHosted(OWN_HOME) === false, "pid 锁指向别人（旧实例）→ ownDaemonHosted() 判 false，ensureOwnDaemon 会先停后静默起");
    const src2 = read("paseo/main-paseo.js");
    ok(/stopForeignOwnDaemon\(/.test(src2) && /waitDaemonGone\(/.test(src2), "迁移路径：先停旧实例（CLI stop → 等它真消失 → 没停掉才按进程树强杀）");
    /* 本轮共识（默认不启用）：开机那一段只按启用标记恢复，未启用时一个进程都不 spawn */
    ok(
      /bootResumeDaemon/.test(src2) && /setTimeout\(\(\) => \{\s*bootResumeDaemon\(\)/.test(src2),
      "宿主注册时只跑 bootResumeDaemon（按启用标记恢复，不拦启动）",
    );
    ok(
      /function bootResumeDaemon\(\)[\s\S]{0,2400}if \(!isEnabled\(\)\)/.test(src2),
      "bootResumeDaemon 先判启用标记：未启用直接返回（不再「只要 mode=own 就自己起」）",
    );
    ok(!/migrateOwnDaemonToSilent/.test(src2), "旧的「开机静默接管」入口已下线（它就是「没开也会跑」的根源）");
  }

  /* ═════════ [4] 真迁移：跑着一份「旧方式」起的 daemon，ensureOwnDaemon 必须把它换成静默托管 ═════════
     这一段用真 CLI 的 `daemon start` 模拟用户机器上现存的那份（正是会带窗口的那种起法），
     再走 ensureOwnDaemon（= 用户点「启动后端」/ 开机接管那条路）。收尾一律自清。 */
  console.log("\n[4] 真迁移：旧方式（daemon start）起的实例 → 换成宿主静默托管");
  {
    const canMigrate = process.platform === "win32" && !!INSTALL_DIR && I.pickNodeRuntime({}).ready;
    if (!canMigrate) {
      skipIt("这一段需要 win32 + 真装好的自建后端 + 达标真 Node：跳过真迁移");
    } else {
      const rt2 = I.pickNodeRuntime({});
      writeCfg({ mode: "own", installDir: INSTALL_DIR, ownHome: OWN_HOME, remoteEnabled: false, lastPairAt: 0 });
      await I.cliSetDaemonConfig(I.ownCliPath(), OWN_HOME, "daemon.listen", LISTEN, rt2.bin);
      try {
        await I.stopOwnDaemon({ quiet: true, graceMs: 3000 });
      } catch {}
      /* 上一段 [3] 伪造的那份 pid 锁形状不全（缺 uid / serverId），官方 CLI 读它会报
         `Invalid lock shape` —— 真起之前先删掉，免得把「迁移」误判成「起不来」。 */
      try {
        fs.rmSync(path.join(OWN_HOME, "paseo.pid"), { force: true });
      } catch {}
      /* 模拟「旧方式」：官方 daemon start（它自己 detached 一个 supervisor —— 就是会带窗口的那条路） */
      const oldCfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
      const oldStart = await I.spawnPaseoCli(oldCfg, ["daemon", "start", "--home", OWN_HOME], { timeoutMs: 90000 });
      const oldUp = /Started:|listening/i.test(String((oldStart && oldStart.stdout) || "")) || (oldStart && oldStart.code === 0);
      if (!oldUp) {
        skipIt(
          "旧方式那一步没起来（code=" + (oldStart && oldStart.code) + "）：跳过真迁移（stdout：" +
            String((oldStart && oldStart.stdout) || "").slice(0, 120) + " / stderr：" +
            String((oldStart && oldStart.stderr) || "").slice(0, 200) + " / daemon.log 尾：" +
            I.daemonLogTail(OWN_HOME, 300) + "）",
        );
      } else {
        await sleep(3000);
        const oldSt = await daemonStatus(PORT);
        ok(!!oldSt && oldSt.code === 200, "旧方式起的实例在跑（模拟用户机器上现存的那份）");
        ok(I.ownDaemonHosted(OWN_HOME) === false, "这份被判为「不是宿主持有」→ 迁移判据生效（不会把它当成自己的而放过）");
        const mig = await I.ensureOwnDaemon({ home: OWN_HOME, timeoutMs: 90000 });
        ok(
          !!mig.ok && mig.hosted === true,
          "ensureOwnDaemon() 把它换成了宿主静默托管：" +
            JSON.stringify({ ok: mig.ok, listen: mig.listen, hosted: mig.hosted, error: mig.error, detail: String(mig.detail || "").slice(0, 140) }),
        );
        if (mig.ok) {
          const st4 = await daemonStatus(PORT);
          ok(!!st4 && st4.code === 200, "迁移后同一个 listen 仍然活着（HTTP " + (st4 && st4.code) + "）");
          ok(I.ownDaemonHosted(OWN_HOME) === true, "迁移后 ownDaemonHosted() 判 true（这份现在归宿主静默托管）");
          const logText4 = exists(CONSOLE_LOG) ? fs.readFileSync(CONSOLE_LOG, "utf8") : "";
          ok(/换成宿主静默托管/.test(logText4), "控制台日志记下了「换成宿主静默托管」这一步");
        }
      }
    }
  }

  /* ── 收尾：无论在哪个分支退出，都清干净隔离现场里的进程 ── */
  try {
    await I.stopOwnDaemon({ quiet: true, graceMs: 5000 });
  } catch {}
  const leftovers = homeProcesses(OWN_HOME);
  if (leftovers.length) {
    killPids(leftovers);
    console.log("  · 收尾清掉隔离 home 的残留进程：" + JSON.stringify(leftovers));
  }
  ok(homeProcesses(OWN_HOME).length === 0, "隔离现场收尾干净（没有残留进程压着测试目录）");
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 });
  } catch {}

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

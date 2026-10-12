"use strict";
/* llama.cpp「登记进 MTNode 模型列表」——真机自验（手动跑，不属于冒烟套件）
 *   node test/_verify-llama-registry.cjs
 *
 * 为什么放在这里：本轮需求是「部署模型后未登记在 mtnode 模型列表中」，最有力的证据是
 * **真起一次后端、真部署一个 GGUF**，而不是只读源码做静态断言（静态那部分在
 * test/smoke-llama-registry.js）。本脚本落在 test/ 下的手动档（下划线前缀，
 * 与 _dbg-ui.js 同性质），不进任何自动跑批。
 *
 * 这不是 mock：用的就是仓库里的真模块（llama/main-llama.js + llama/provider-sync.js +
 * config-providers.js），后端是从真实安装目录（默认 E:\mtnode-plugins\vLLM，含 gemma 两个
 * GGUF 与 llama-server.exe）真拉起来的真管理服务，部署的是真权重。
 * 只有 electron 打桩（本脚本跑在纯 Node 里）：桩只提供 ipcMain.handle / app /
 * BrowserWindow.getAllWindows / dialog / screen / Tray 这些**登记期会碰到的形状**，
 * 业务逻辑一行都没替换。
 *
 * 环境变量（都可省）：
 *   VERIFY_INSTALL  真实安装目录（省 = E:\mtnode-plugins\vLLM）
 *   VERIFY_PORT     本次用的端口（省 = 8791；8765 上可能跑着另一份安装目录的 manager，
 *                   那正好用来验「安装目录冲突不静默复用」）
 *   VERIFY_DATA     独立数据目录（省 = <TEMP>\mtnode-llama-verify；绝不碰用户真实数据目录）
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const HERE = __dirname;
const DATA = process.env.VERIFY_DATA || path.join(os.tmpdir(), "mtnode-llama-verify");
const INSTALL = process.env.VERIFY_INSTALL || "E:\\mtnode-plugins\\vLLM";
/* 第二份安装目录：用来验「端口上跑的是别人那份」的冲突口径（本机真有的那一份） */
const INSTALL2 = process.env.VERIFY_INSTALL2 || "E:\\mtnode-test\\vLLM";
const PORT = Number(process.env.VERIFY_PORT || 8791);
const OTHER_PORT = 8765;
fs.mkdirSync(DATA, { recursive: true });

let step = 0;
function log(msg) {
  console.log("[verify " + ++step + "] " + msg);
}
function ok(cond, msg) {
  console.log((cond ? "  ok    " : "  FAIL  ") + msg);
  if (!cond) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── electron 打桩（只补登记期会用到的形状） ───────────────────────────────
   ipcMain.handle 把句柄收进 IPC 表：脚本按**真 IPC 通道**驱动（llama:start / llama:deployModel /
   llama:resolveRootChoice …），与界面点按钮走的是同一段代码。 */
const IPC = new Map();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    return {
      ipcMain: {
        handle(ch, fn) {
          IPC.set(ch, fn);
        },
        on() {},
        removeHandler() {},
      },
      app: {
        isPackaged: false,
        getPath: () => path.join(os.tmpdir(), "llama-verify-app"),
        setPath() {},
        getName: () => "mtnode-verify",
        on() {},
        quit() {},
      },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
      },
      dialog: { showOpenDialogSync: () => null },
      screen: {
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      },
      Tray: class {},
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }), createEmpty: () => ({}) },
    };
  }
  return origLoad.apply(this, arguments);
};

const syncSignal = require(path.join(REPO, "llama", "provider-sync.js"));
const host = require(path.join(REPO, "llama", "main-llama.js"));

const LLAMA_ROOT = path.join(DATA, "llama");
const LLAMA_CFG = path.join(LLAMA_ROOT, "config.json");
const CFG = path.join(DATA, "config.json");
fs.mkdirSync(LLAMA_ROOT, { recursive: true });
fs.writeFileSync(
  LLAMA_CFG,
  JSON.stringify({ installDir: INSTALL, port: PORT, wantRunning: false, syncToMtnode: true }, null, 2),
);
fs.writeFileSync(CFG, JSON.stringify({ providers: [] }), "utf8");
fs.writeFileSync(
  path.join(LLAMA_ROOT, "config.json"),
  JSON.stringify({ installDir: INSTALL, port: PORT, wantRunning: false, syncToMtnode: true }, null, 2),
);

host.registerLlamaIpc({ getDataDir: () => DATA, getMainWin: () => null, appRoot: REPO, getDsh: () => null });

const readProvider = () => {
  const c = JSON.parse(fs.readFileSync(CFG, "utf8"));
  return (c.providers || []).find((p) => p.id === "llama-local") || null;
};
const readRows = (p) => (p && Array.isArray(p.llamaModels) ? p.llamaModels : []);
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {}
      resolve(false);
    });
  });
}

(async () => {
  console.log("=== 现场 ===");
  console.log("数据目录（独立）: " + DATA);
  console.log("安装目录（真实）: " + INSTALL);
  console.log("本次端口        : " + PORT + "（" + OTHER_PORT + " 上可能另有其 root 的 manager）");
  console.log("");

  /* ── ① 后端没起：也要登记（清单来自安装目录的注册表文件） ── */
  log("后端未启动时同步");
  await host.syncProviderToMtnode();
  let p = readProvider();
  ok(!!p, "config.json 里出现了 llama-local 服务商条目");
  ok(!!p && p.models.length >= 1, "已下载的模型都登记了（不只 running）：" + JSON.stringify(p && p.models));
  ok(!!p && p.source === "llama-plugin", "带插件来源标记 source=llama-plugin");
  ok(!!p && !!p.apiKey, "离线回退读的是 <installDir>/.api-key：" + (p && p.apiKey.slice(0, 8)) + "…");
  ok(
    readRows(p).every((x) => x.status !== "running"),
    "离线时没有「运行中」的假状态：" + JSON.stringify(readRows(p).map((x) => x.status)),
  );
  ok(!!(p && p.llamaSync) && p.llamaSync.mode === "own" && p.llamaSync.online === false, "llamaSync 记下 mode=own / online=false");

  /* ── ② 真拉起后端（真实安装目录的 venv + llama-server）：走真 IPC 通道 llama:start ── */
  log("llama:start（真起管理服务）");
  const started = await IPC.get("llama:start")();
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    up = await health(PORT);
    if (!up) await sleep(1000);
  }
  ok(up, "管理服务在 :" + PORT + " 真的起来了（/api/health 200）；llama:start=" + JSON.stringify(started));
  if (!up) throw new Error("后端没起来，后面几步无法进行（看 " + path.join(LLAMA_ROOT, "console.log") + "）");

  /* ── ③ 在线时：apiKey 以 /api/status 为准 + installRoot 一致 ── */
  log("后端在线后同步（apiKey 权威口径 + installRoot）");
  await host.syncProviderToMtnode();
  p = readProvider();
  const live = await syncSignal.liveStatus(PORT);
  ok(!!live, "/api/status 可读");
  ok(!!live && syncSignal.normRoot(live.installRoot) === syncSignal.normRoot(INSTALL), "/api/status 的 installRoot = " + (live && live.installRoot));
  ok(!!p && p.apiKey === live.apiKey, "apiKey 已换成在线 manager 认的那一串：" + (p && p.apiKey.slice(0, 8)) + "…");
  ok(!!p && p.llamaSync.online === true && p.llamaSync.mismatch === false, "llamaSync.online=true / mismatch=false");

  /* ── ④ 运行前闸门：未部署的模型自动加载（真部署真权重），走真 IPC 通道 llama:ensureModel ── */
  const target = (p.models || []).find((m) => /E2B/i.test(m)) || p.models[0];
  log("llama:ensureModel('" + target + "')：未部署 → 自动加载（真权重，可能要一两分钟）");
  const t0 = Date.now();
  const ens = await IPC.get("llama:ensureModel")({}, target);
  const secs = Math.round((Date.now() - t0) / 1000);
  ok(!!ens && ens.ok === true, "闸门返回就绪（" + secs + "s）：" + JSON.stringify(ens));
  await host.syncProviderToMtnode();
  p = readProvider();
  const runningRow = readRows(p).find((x) => x.id === target);
  ok(!!runningRow && runningRow.status === "running", "登记里这一条变成「运行中」：" + JSON.stringify(runningRow));
  ok(!!p && p.models[0] === target, "运行中的模型排到 models 第一位：" + JSON.stringify(p && p.models));
  ok(
    readRows(p).length === p.models.length,
    "逐条状态与模型清单等长（" + readRows(p).length + " / " + p.models.length + "）：" +
      JSON.stringify(readRows(p).map((x) => [x.id, x.status])),
  );

  /* ── ⑤ 停止：条目保留并退回「未部署」（不是消失） ── */
  log("llama:stopModel('" + target + "')：停止后登记应保留该模型并标未部署");
  const st = await IPC.get("llama:stopModel")({}, target);
  ok(!!st && st.ok === true, "停止返回 ok：" + JSON.stringify(st));
  await sleep(2000);
  await host.syncProviderToMtnode();
  p = readProvider();
  const after = readRows(p).find((x) => x.id === target);
  if (!after || after.status === "running") {
    const liveNow = await syncSignal.liveStatus(PORT);
    console.log(
      "  · 诊断：/api/status.deployed = " + JSON.stringify((liveNow && liveNow.deployed) || null),
    );
    console.log(
      "  · 诊断：/api/models = " +
        JSON.stringify(
          ((await syncSignal.liveModels(PORT, liveNow && liveNow.apiKey)) || []).map((m) => [m.id, m.status, m.deployed]),
        ),
    );
  }
  ok(!!after && after.status !== "running", "停止后状态不再是运行中：" + (after && after.status));
  ok(!!p && p.models.indexOf(target) >= 0, "停止后模型仍在 MTNode 列表里（按未部署登记）");

  /* ── ⑥ 安装目录冲突：端口上那份 installRoot 与配置的 installDir 不一致时不静默复用 ──
     真实现场：:PORT 上跑的是 INSTALL 那份，把配置里的 installDir 临时改成**另一份真实目录**
     （INSTALL2，本机真有的第二份脚手架）→ 冲突成立，走的正是用户机器上的那条判定路径。 */
  log("安装目录冲突：端口上是 " + INSTALL + "，配置却指向 " + INSTALL2);
  const llamaCfg = JSON.parse(fs.readFileSync(LLAMA_CFG, "utf8"));
  llamaCfg.installDir = INSTALL2;
  llamaCfg.port = PORT;
  llamaCfg.reuseExternal = false;
  fs.writeFileSync(LLAMA_CFG, JSON.stringify(llamaCfg, null, 2));
  const liveNow = await syncSignal.liveStatus(PORT);
  ok(
    !!liveNow && syncSignal.normRoot(liveNow.installRoot) !== syncSignal.normRoot(INSTALL2),
    "两份目录确实不同：live=" + (liveNow && liveNow.installRoot) + " / configured=" + INSTALL2,
  );
  await host.syncProviderToMtnode();
  p = readProvider();
  ok(!!p && p.llamaSync.conflict === true, "登记里记下 conflict=true（不静默复用别人那份）");
  ok(
    !!p && !!p.llamaSync.liveRoot && syncSignal.normRoot(p.llamaSync.liveRoot) !== syncSignal.normRoot(INSTALL2),
    "liveRoot 如实记下端口上那份（没被配置的 installDir 顶掉）：" + (p && p.llamaSync.liveRoot),
  );
  ok(
    !!p && p.models.length > 0 && !p.models.some((m) => /gemma/i.test(m)),
    "清单以「配置的 installDir」那份为准（不含端口上那份的 gemma）：" + JSON.stringify(p && p.models),
  );
  const gate = await IPC.get("llama:ensureModel")({}, "gemma-4-E2B-it");
  ok(
    !!gate && gate.ok === false && gate.error === "root_conflict",
    "冲突未决时运行前闸门明确拒绝并给出原因：" + (gate && gate.message),
  );
  /* 插件卡片画的那条告警读的就是 statusForUi().rootConflict（这里按真 IPC 通道读它） */
  const stUi = await IPC.get("llama:getStatus")();
  ok(
    !!stUi && !!stUi.rootConflict && syncSignal.normRoot(stUi.rootConflict.liveRoot) === syncSignal.normRoot(INSTALL),
    "llama:getStatus 把冲突带给卡片：liveRoot=" +
      (stUi && stUi.rootConflict && stUi.rootConflict.liveRoot) +
      " / configuredRoot=" +
      (stUi && stUi.rootConflict && stUi.rootConflict.configuredRoot),
  );
  ok(
    !!stUi && Array.isArray(stUi.modelRows) && stUi.modelRows.length > 0,
    "statusForUi 带上逐条模型状态（卡片与控制台同源）：" +
      JSON.stringify((stUi.modelRows || []).map((r) => [r.id, r.status])),
  );
  /* 用户选「继续用这份」→ 冲突解除（reuseExternal），此后以端口上那份为准 */
  const resolved = await IPC.get("llama:resolveRootChoice")({}, "external");
  ok(!!resolved && resolved.ok === true, "llama:resolveRootChoice('external') 成功：" + JSON.stringify(resolved));
  const p2 = readProvider();
  ok(
    !!p2 && p2.llamaSync.mode === "external" && p2.llamaSync.conflict === false,
    "选完之后按「端口上那份」登记，冲突解除（conflict=false / mismatch=" + (p2 && p2.llamaSync.mismatch) + "）",
  );
  ok(
    !!p2 && !p2.models.some((m) => /Flash-Next/.test(m)),
    "切换权威后，原先那份 installDir 的模型被清掉、没混进来：models=" + JSON.stringify(p2 && p2.models),
  );
  const gate2 = await IPC.get("llama:ensureModel")({}, p2.models[0]);
  ok(!!gate2 && gate2.error !== "root_conflict", "冲突解除后闸门不再拒绝（可以正常加载/复用）");
  /* 换端口起自己的：挑一个空闲端口并把配置挪过去 */
  const own = await IPC.get("llama:resolveRootChoice")({}, "own");
  ok(!!own && own.ok === true && Number(own.port) > 0, "llama:resolveRootChoice('own') 换到空闲端口：" + JSON.stringify(own));
  const cfgNow = JSON.parse(fs.readFileSync(LLAMA_CFG, "utf8"));
  ok(Number(cfgNow.port) === Number(own.port) && cfgNow.reuseExternal === false, "配置已挪到新端口且取消 reuseExternal");
  /* 还原成本次现场（配置目录 = INSTALL、端口 = PORT） */
  llamaCfg.installDir = INSTALL;
  llamaCfg.port = PORT;
  llamaCfg.reuseExternal = false;
  fs.writeFileSync(LLAMA_CFG, JSON.stringify(llamaCfg, null, 2));
  await host.syncProviderToMtnode();
  p = readProvider();
  ok(!!p && p.llamaSync.mismatch === false && p.llamaSync.mode === "own", "还原后回到自己的那份（conflict=false）");

  /* ── ⑦ 托盘路径：真写 config.json + 脏信号，主进程把它消费掉 ── */
  log("托盘路径 syncProviderToConfig()（MTNode 关着时的那条路）");
  const tray = await syncSignal.syncProviderToConfig({
    port: PORT,
    installDir: INSTALL,
    configPath: CFG,
    dataDir: DATA,
    mode: "external",
  });
  ok(!!tray && tray.ok === true, "托盘登记返回 ok：" + JSON.stringify({ ok: tray.ok, changed: tray.changed, models: tray.models }));
  p = readProvider();
  ok(readRows(p).length >= 1, "托盘写完后条目照旧完整：" + JSON.stringify(readRows(p).map((x) => x.id)));
  ok(fs.existsSync(syncSignal.dirtyPath(DATA)), "脏信号文件已写出：" + syncSignal.dirtyPath(DATA));
  await sleep(4500);
  ok(!fs.existsSync(syncSignal.dirtyPath(DATA)), "主进程的脏信号轮询已消费它（MTNode 开着就会即时刷新）");
  const reloaded = readProvider();
  ok(!!reloaded && !!reloaded.llamaSync, "消费后重新登记过（llamaSync.at 刷新）：" + new Date(reloaded.llamaSync.at).toISOString());

  /* ── 收尾：停后端（也把这次 spawn 的托盘进程一起带走），现场留给复核 ── */
  log("收尾：llama:stop（释放显存 / 杀进程树 / 停托盘）");
  const stopped = await IPC.get("llama:stop")();
  ok(!!stopped && stopped.ok === true, "stopBackend 返回 ok：" + JSON.stringify(stopped));
  await sleep(1500);
  ok(!(await health(PORT)), ":" + PORT + " 上的管理服务已退（端口不再应答）");

  console.log("\n=== 最终登记（" + CFG + " 的 llama-local 条目）===");
  console.log(JSON.stringify(readProvider(), null, 2));
  console.log("\n" + (process.exitCode ? "FAILED" : "ALL PASS") + " （现场 " + DATA + "）");
  process.exit(process.exitCode ? 1 : 0);
})().catch((e) => {
  console.error("verify 抛错：" + ((e && e.stack) || e));
  process.exit(1);
});

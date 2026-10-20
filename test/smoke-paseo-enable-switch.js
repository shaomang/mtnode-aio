"use strict";
/* 「Paseo 手机接管」**默认不启用**冒烟（纯 Node，不需要 Electron）：
 *   node test/smoke-paseo-enable-switch.js
 *
 * 本轮共识：默认**不启用**，必须显式开启（插件卡片「启用」/ 控制台「启用后端」/ 安装窗装完那一次）
 * 才开始生效；开机那一段只按启用标记恢复。这里钉的是开关本身与两侧的接线：
 *   [1] 静态：默认配置 enabled:false；install 收尾写启用；start/stop 与启用/停用等价；
 *       报错卡只给人话（不再把 daemon 的 JSON 日志尾巴糊进 message）
 *   [2] 真行为（隔离数据目录）：未启用时 bootResumeDaemon 一个进程都不 spawn；
 *       存量配置（没有 enabled 键）静默迁移成未启用；setEnabled 落盘 enabled + remoteEnabled
 *   [3] 停用的边界：没有 CLI、也没有我们持有的进程时，「停用」的意图仍要落地（清标记并回 ok）
 *
 * 隔离纪律：只用 %TEMP% 下的数据目录 + 空目录冒充「这台机器没有别的 Paseo」，
 * 绝不碰用户真实数据目录、`~/.paseo` 与 6767 上那份正在跑的后端（全程不真起 daemon）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

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
const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");

/* ── 假 Electron：宿主只用到这几样（与 smoke-paseo-daemon-silent.js 同一套） ── */
const fakeElectron = {
  app: {
    getVersion: () => "0.0.0-smoke",
    getAppPath: () => ROOT,
    getPath: () => path.join(os.tmpdir(), "mtnode-paseo-enable-userdata"),
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
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-enable-"));
const DATA_DIR = path.join(SANDBOX, "data");
const EMPTY_MACHINE = path.join(SANDBOX, "no-desktop-paseo");
for (const d of [DATA_DIR, EMPTY_MACHINE]) fs.mkdirSync(d, { recursive: true });
process.env.MTNODE_DATA_DIR = DATA_DIR;
process.env.MTNODE_PASEO_USERPROFILE = SANDBOX;
process.env.MTNODE_PASEO_DIRS = EMPTY_MACHINE;

const host = require(abs("paseo/main-paseo.js"));
const I = host.__internals;
const CONFIG_DIR = path.join(DATA_DIR, "paseo");
const CONFIG = path.join(CONFIG_DIR, "config.json");
const LOG = path.join(CONFIG_DIR, "console.log");

function writeCfg(obj) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2), "utf8");
}
function readCfg() {
  return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
}
function logText() {
  try {
    return fs.readFileSync(LOG, "utf8");
  } catch {
    return "";
  }
}

(async () => {
  /* ── [1] 静态口径 ────────────────────────────────────────────────────── */
  console.log("[1] 静态口径（默认关 / 三个入口都写启用 / 报错只给人话）");
  {
    const src = read("paseo/main-paseo.js");
    ok(/function defaultConfig\(\)[\s\S]{0,900}enabled: false/.test(src), "默认配置 enabled:false（默认不启用）");
    ok(/function setEnabled\(on\)/.test(src) && /enabled: want, remoteEnabled: want/.test(src), "setEnabled：启用标记与远程总开关一起写");
    ok(
      /async function startDaemon\(\)[\s\S]{0,2600}setEnabled\(true\)/.test(src),
      "启动后端 = 启用（成功路径写启用标记）",
    );
    ok(
      /async function stopDaemon\(\)[\s\S]{0,2200}setEnabled\(false\)/.test(src),
      "停止后端 = 停用（清启用标记）",
    );
    ok(
      /── ⑧ 收尾[\s\S]{0,600}setEnabled\(true\)/.test(src),
      "安装窗装完那一次 = 进入启用态（之后开机会按已启用恢复）",
    );
    ok(/enabled: isEnabled\(\)/.test(src), "statusForUi 把启用状态摊到顶层（卡片按它判）");
    ok(/mode: backend\.mode/.test(src) && /serviceWhen: \(st\) => !!st && st\.mode !== "reuse"/.test(read("renderer/app-plugins.js")), "复用模式不显示启用 / 停用（那份后端归 Paseo Desktop 管）");
    ok(
      /async function stopDaemon\(\)[\s\S]{0,1200}cfg\.mode !== "own"[\s\S]{0,400}Paseo Desktop 那份后端不动/.test(src),
      "复用模式下「停用」不替桌面端停它的 daemon（只清标记 + 关远程）",
    );
    ok(!/migrateOwnDaemonToSilent/.test(src), "旧的「只要 mode=own 就开机起」入口已下线");
    const errs = src.match(/reportErr\(\s*"daemon_exited",[\s\S]{0,320}?\)/g) || [];
    ok(errs.length >= 2, "daemon_exited 两处报错仍在（重启失败 / 达上限）");
    ok(
      errs.every((s) => !/tail/.test(s) && /打开控制台/.test(s)),
      "报错卡只给人话 + 指路（日志尾巴不再糊进 message）",
    );
    const plug = read("renderer/app-plugins.js");
    ok(/hasService: true/.test(plug) && /startFn: "paseoRemoteStartDaemon"/.test(plug), "卡片：启用 / 停用走既有启停桥");
  }

  /* ── [2] 真行为：未启用时一个进程都不 spawn ─────────────────────────────── */
  console.log("[2] 真行为：未启用 → bootResumeDaemon 不 spawn");
  {
    writeCfg({ mode: "own", installDir: path.join(SANDBOX, "not-installed"), ownHome: path.join(SANDBOX, "own-home"), enabled: false, remoteEnabled: false });
    ok(I.isEnabled() === false, "isEnabled() 读的是落盘的启用标记（false）");
    const r = await I.bootResumeDaemon();
    ok(r && r.ok === true && r.skipped === "not_enabled", "bootResumeDaemon：未启用 → skipped=not_enabled");
    ok(!I.ownDaemonState().child, "没有起任何子进程（ownDaemon.child 为空）");
  }

  /* ── [3] 存量配置迁移：没有 enabled 键 → 未启用 ─────────────────────────── */
  console.log("[3] 存量迁移：老配置没有启用记录 → 视为未启用");
  {
    writeCfg({ mode: "own", installDir: path.join(SANDBOX, "not-installed"), ownHome: path.join(SANDBOX, "own-home"), remoteEnabled: true });
    const r = await I.bootResumeDaemon();
    ok(r && r.skipped === "not_enabled", "老配置开机 → 按未启用处理（不启动）");
    const cfg = readCfg();
    ok(cfg.enabled === false, "迁移把 enabled 落成 false（不是 undefined）");
    ok(cfg.remoteEnabled === true, "迁移**不动**用户自己开过的远程总开关（只负责不再自己起后端）");
    ok(/迁移：存量配置没有启用记录/.test(logText()), "控制台记下了迁移这件事（不弹窗）");
    ok(!I.ownDaemonState().child, "迁移过程同样没有起进程");
  }

  /* ── [4] 启用 / 停用的落盘 ─────────────────────────────────────────────── */
  console.log("[4] 启用 / 停用：标记与远程总开关一起动");
  {
    I.setEnabled(true);
    let cfg = readCfg();
    ok(cfg.enabled === true && cfg.remoteEnabled === true, "启用 → enabled=true 且 remoteEnabled=true");
    ok(I.isEnabled() === true, "isEnabled() 跟着变 true");
    I.setEnabled(false);
    cfg = readCfg();
    ok(cfg.enabled === false && cfg.remoteEnabled === false, "停用 → 两个标记一起清");
    ok(/\[enable\] 启用状态/.test(logText()), "控制台记下启用状态变化");
  }

  /* ── [5] 停用的边界：没有进程可停也要把意图落地 ──────────────────────────── */
  console.log("[5] 停用边界：没有 CLI / 没有我们持有的进程");
  {
    writeCfg({ mode: "own", installDir: path.join(SANDBOX, "not-installed"), ownHome: path.join(SANDBOX, "own-home"), enabled: true, remoteEnabled: true });
    const r = await I.stopDaemon();
    ok(r && r.ok === true && r.noProcess === true, "stopDaemon：无事可停时仍回 ok（不报 cli_missing）");
    const cfg = readCfg();
    ok(cfg.enabled === false && cfg.remoteEnabled === false, "这种情况下也把启用标记清掉（下次启动不会再自己起）");
    ok(I.isEnabled() === false, "isEnabled() 变 false");
  }

  /* ── 收尾 ─────────────────────────────────────────────────────────────── */
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
  console.log("");
  console.log(fails === 0 ? "全部通过：" + checks + " 项" : "失败 " + fails + " / " + checks + " 项");
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  未捕获异常：" + ((e && e.stack) || e));
  process.exit(1);
});

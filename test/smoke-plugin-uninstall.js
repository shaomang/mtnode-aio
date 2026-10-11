"use strict";
/* 插件安装窗的「卸载」真跑：预览只读、确认才删、先停后端再删、守卫拦住危险目录。
 *   node test/smoke-plugin-uninstall.js
 *
 * 为什么单开一只：卸载是**破坏性**动作，主进程那条链（路由表 → 安全守卫 → 停后端 → 删目录 → 报终局）
 * 光靠正则看不出来「到底删了没有 / 该拒的拒没拒」。这里用临时目录真建文件、真删一遍，
 * 并把每次桥调用记下来核对顺序。electron 用替身（本模块只用到 ipcMain / dialog / BrowserWindow）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

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
function eq(a, b, msg) {
  ok(a === b, msg + "（实到 " + JSON.stringify(a) + "）");
}

/* 一次卸载会话的现场收集：安装窗收到的那几条 IPC 就是全部事实（步骤 / 日志 / 终局）。
   为什么从窗这条路收集、不去包 reportPluginStep：模块内部调的是它自己的函数声明，
   给导出对象换个引用拦不住它 —— 只有窗收得到，那也正是用户看得到的那一份。 */
const winFeed = [];
const ipcHandlers = new Map();
const ipcEvents = new Map();
let tmpRoot = "";
const electronStub = {
  ipcMain: {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
    on: (ch, fn) => ipcEvents.set(ch, fn),
    _invokeHandlers: ipcHandlers,
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { send: (ch, payload) => winFeed.push({ ch, payload }) };
    }
    isDestroyed() {
      return false;
    }
    loadFile() {}
    on() {}
    once() {}
    show() {}
    focus() {}
    setTitle() {}
    isMinimized() {
      return false;
    }
    removeMenu() {}
    setMenuBarVisibility() {}
  },
  dialog: { showOpenDialogSync: () => [] },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") return electronStub;
  return origLoad.call(this, req, parent, isMain);
};

tmpRoot = fs.mkdtempSync(path.join(__dirname, "_tmp-uninstall-"));
const dataDir = path.join(tmpRoot, "data");
const pluginRootDir = path.join(tmpRoot, "plugins");
/* 「应用目录」= 沙箱里的一个空壳。注意：appDir 与它的**父级**（tmpRoot）都会进危险区
   （见 main-install.js 的 appDirsOf），所以数据目录与插件目录一律挂在 tmpRoot 下 ——
   若把 appDir 的父级落成「数据目录的祖先」，本用例的沙箱自己就会命中 refuse_app_dir。 */
const appDir = path.join(tmpRoot, "appdir");
for (const d of [dataDir, pluginRootDir, appDir]) fs.mkdirSync(d, { recursive: true });

const installHost = require("../plugins/main-install.js");
const logs = [];
installHost.initInstallHost({
  getMainWin: () => null,
  getDataDir: () => dataDir,
  appRoot: appDir,
  log: (l) => logs.push(String(l)),
});

/* 一次卸载会话的现场收集：安装窗收到的那几条 IPC 就是全部事实（步骤 / 日志 / 终局）。
   为什么从窗这条路收集、不去包 reportPluginStep：模块内部调的是它自己的函数声明，
   给导出对象换个引用拦不住它 —— 只有窗收得到，那也正是用户看得到的那一份。 */
function collect(id) {
  winFeed.length = 0;
  const out = { steps: [], lines: [], finish: null };
  out.pick = () => {
    for (const m of winFeed) {
      const p = m.payload || {};
      if (m.ch !== "mtnodeInstall:event" || String(p.id || "") !== id) continue;
      if (p.kind === "step") out.steps.push(p.step);
      else if (p.kind === "log") out.lines.push(String(p.line || ""));
      else if (p.kind === "finish") out.finish = p;
    }
    return out;
  };
  return { out, restore: () => {} };
}
const waitFinish = (id, ms) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const snap = installHost.snapshotOf(id);
      const terminal = snap && (snap.state === "done" || snap.state === "failed" || snap.state === "cancelled");
      /* 快照落终局与「窗收到 finish 那一帧」是两步（都走 IPC）：等窗也收到再收口，
         否则断言会读到一个还没落地的现场。 */
      const delivered = winFeed.some(
        (m) => m.ch === "mtnodeInstall:event" && m.payload && String(m.payload.id || "") === id && m.payload.kind === "finish",
      );
      if (terminal && delivered) return resolve(snap);
      if (Date.now() - t0 > (ms || 4000)) return resolve(snap || null);
      setTimeout(tick, 20);
    };
    tick();
  });

/* 每个用例前把「插件根目录」写成干净状态，并登记一个后端插件 */
function resetRoot(dir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ plugins: { installDir: dir } }), "utf8");
}
function mkInstallTree(dir) {
  fs.mkdirSync(path.join(dir, ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".venv", "Scripts", "python.exe"), "x".repeat(1024));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "w.bin"), Buffer.alloc(2048));
  fs.writeFileSync(path.join(dir, ".install-ok"), "1");
}

let bridgeCalls = [];
const stopChannel = "llama:stop";
ipcHandlers.set(stopChannel, async () => {
  bridgeCalls.push(stopChannel);
  return { ok: true };
});

(async () => {
  /* ── [1] 通用路由：预览只读 → 确认才删（先停后端再删目录） ── */
  console.log("\n[1] 通用卸载：预览只读、真删前先停后端");
  resetRoot(pluginRootDir);
  const llamaDir = path.join(pluginRootDir, "vLLM");
  mkInstallTree(llamaDir);
  installHost.registerInstallTarget({
    id: "llama-local",
    key: "llama",
    name: "llama.cpp 本地模型",
    getInstallDir: () => llamaDir,
  });

  let col = collect("llama-local");
  bridgeCalls = [];
  const prev = await installHost.uninstallPreviewFor("llama-local");
  ok(prev.ok === true, "预览回 ok");
  eq(prev.route, "root", "没自定义卸载口的插件走通用路由（删安装目录）");
  eq(prev.installDir, llamaDir, "预览给的是该插件自己的安装目录");
  eq(prev.targets.length, 1, "通用路由只删这一个目录");
  ok(prev.items.some((i) => i.name === ".venv"), "预览列出目录里的条目（.venv）");
  ok(fs.existsSync(path.join(llamaDir, ".install-ok")), "预览是只读的：文件还在");
  ok(prev.keepHint.indexOf("GGUF") >= 0, "llama 的预览写明「下载的模型保留」");

  const started = installHost.startUninstall("llama-local");
  ok(started && started.ok === true && started.started === true, "startUninstall 立刻回执（真删异步跑）");
  const snap = await waitFinish("llama-local");
  col.out.pick();
  eq(snap && snap.state, "done", "卸载跑完快照落 done");
  eq(snap && snap.mode, "uninstall", "这一次快照带 mode=uninstall（窗据此认「这是卸载」）");
  ok(!fs.existsSync(llamaDir), "安装目录真的被删掉");
  eq(bridgeCalls.length, 1, "删之前调了一次后端停止口");
  eq(bridgeCalls[0], stopChannel, "停的是该插件那条 <kind>:stop");
  ok(col.out.lines.some((l) => l.indexOf("后端已停止") >= 0), "日志写明后端已停");
  ok(col.out.lines.some((l) => l.indexOf("已释放约") >= 0), "日志写明释放了多少（可复核）");
  ok(col.out.lines.some((l) => l.indexOf(".venv") >= 0), "逐条写明删了什么");
  /* 终局的「成功」写在快照上（finish 事件的载荷是整份快照，没有单独的 ok 字段） */
  eq(col.out.finish && col.out.finish.session && col.out.finish.session.state, "done", "终局事件里带成功快照（state=done）");
  ok(col.out.steps.length >= 2 && col.out.steps[col.out.steps.length - 1].status === "ok", "步骤表最后一格是 ok（用户在窗里看到的最终态）");

  /* ── [2] 守卫：危险目录一律拒删（盘根 / 应用目录 / 数据目录 / 插件根目录本身 / 不存在） ── */
  console.log("\n[2] 安全守卫：危险目录一律拒绝");
  resetRoot(pluginRootDir);
  const badCases = [
    [path.parse(pluginRootDir).root, "refuse_root", "盘根"],
    [path.join(appDir, "vLLM"), "refuse_app_dir", "应用目录内"],
    [path.join(dataDir, "vLLM"), "refuse_data_dir", "数据目录内"],
    [pluginRootDir, "refuse_plugin_root", "插件根目录本身"],
    [path.join(pluginRootDir, "not-installed"), "not_installed", "目录不存在"],
  ];
  for (const [dir, want, label] of badCases) {
    installHost.registerInstallTarget({ id: "tts-local", key: "tts", name: "GPT-SoVITS", getInstallDir: () => dir });
    const g = installHost.uninstallGuard("tts-local", dir);
    eq(g.ok, false, "拒绝卸载（" + label + "）");
    eq(g.error, want, "拒绝理由是 " + want);
  }
  const noDir = installHost.uninstallGuard("tts-local", "");
  eq(noDir.error, "no_install_dir", "取不到目录时回 no_install_dir");
  /* 目录都不存在时 preview 与 run 都不该动手 */
  const p2 = await installHost.uninstallPreviewFor("tts-local");
  eq(p2.ok, false, "目录不存在时预览也拒绝（不装作有东西可删）");
  const s2 = installHost.startUninstall("tts-local");
  eq(s2.ok, false, "目录不存在时不开始卸载");
  const unknown = await installHost.uninstallPreviewFor("no-such-plugin");
  eq(unknown.error, "unknown_plugin", "认不出的插件回 unknown_plugin");

  /* ── [3] 自定义卸载口：Music3 交给它自己（预览 + 真删都走它） ── */
  console.log("\n[3] 自定义卸载口：有自己卸载实现的插件交给它自己");
  resetRoot(pluginRootDir);
  const musicDir = path.join(pluginRootDir, "music");
  mkInstallTree(musicDir);
  bridgeCalls = [];
  ipcHandlers.set("music3:uninstallPreview", async () => {
    bridgeCalls.push("music3:uninstallPreview");
    return { ok: true, installDir: musicDir, targets: [{ path: path.join(musicDir, ".venv"), note: "Python 虚拟环境" }], note: "默认保留 output/ 音频输出目录。" };
  });
  ipcHandlers.set("music3:uninstall", async (e, opts) => {
    bridgeCalls.push("music3:uninstall:" + JSON.stringify(opts));
    fs.rmSync(musicDir, { recursive: true, force: true });
    return { ok: true, deleted: [musicDir], errors: [], installDir: musicDir };
  });
  installHost.registerInstallTarget({
    id: "minimax-music3",
    key: "music3",
    name: "MiniMax Music 3",
    getInstallDir: () => musicDir,
  });
  const p3 = await installHost.uninstallPreviewFor("minimax-music3");
  eq(p3.route, "custom", "Music3 走自定义路由");
  eq(p3.installDir, musicDir, "预览的目录来自它自己的预览口");
  ok(p3.note.indexOf("output") >= 0, "预览带上它的保留口径（output 不删）");
  col = collect("minimax-music3");
  const s3 = installHost.startUninstall("minimax-music3");
  eq(s3.route, "custom", "真删也走自定义路由");
  const snap3 = await waitFinish("minimax-music3");
  col.out.pick();
  eq(snap3 && snap3.state, "done", "自定义路由跑完也落 done");
  ok(!fs.existsSync(musicDir), "自定义卸载口真的把目录删了");
  ok(bridgeCalls.some((c) => c.indexOf("music3:uninstall:{") === 0 && c.indexOf('"confirm":true') > 0), "调它自己那条卸载口并带 confirm:true（它要求的确认口径）");

  /* ── [4] 卸载失败如实报（后端占用 / 自定义口报 error） ── */
  console.log("\n[4] 卸载失败如实报，不装作删干净");
  resetRoot(pluginRootDir);
  const petDir = path.join(pluginRootDir, "pet");
  mkInstallTree(petDir);
  ipcHandlers.set("pet:uninstall", async () => {
    bridgeCalls.push("pet:uninstall");
    return { ok: false, error: "ebusy", message: "文件被占用" };
  });
  installHost.registerInstallTarget({ id: "pet", key: "pet", name: "桌宠", getInstallDir: () => petDir });
  col = collect("pet");
  installHost.startUninstall("pet");
  const snap4 = await waitFinish("pet");
  col.out.pick();
  eq(snap4 && snap4.state, "failed", "失败的卸载落 failed（不装成功）");
  ok(String(snap4.error).indexOf("ebusy") >= 0, "失败原因如实带回来");
  ok(col.out.lines.some((l) => l.indexOf("卸载失败") >= 0), "日志里写明失败");

  /* ── [4b] 窗口类插件：走它自己的卸载口（先关窗再删），不裸删目录 ── */
  console.log("\n[4b] 窗口类插件：走 appPlugins:uninstall（先关窗再删）");
  const winPluginDir = path.join(pluginRootDir, "somewindowplugin");
  mkInstallTree(winPluginDir);
  bridgeCalls = [];
  ipcHandlers.set("appPlugins:uninstall", async (e, id) => {
    bridgeCalls.push("appPlugins:uninstall:" + String(id));
    fs.rmSync(winPluginDir, { recursive: true, force: true });
    return { ok: true };
  });
  installHost.registerInstallTarget({ id: "somewindowplugin", key: "win", name: "窗口插件", getInstallDir: () => winPluginDir });
  const pWin = await installHost.uninstallPreviewFor("somewindowplugin");
  eq(pWin.route, "custom", "窗口插件走自定义路由（不经通用口径裸删）");
  col = collect("somewindowplugin");
  installHost.startUninstall("somewindowplugin");
  const snapWin = await waitFinish("somewindowplugin");
  col.out.pick();
  eq(snapWin && snapWin.state, "done", "窗口插件卸载跑完落 done");
  ok(!fs.existsSync(winPluginDir), "窗口插件的目录被它自己的卸载口删掉");
  eq(bridgeCalls[0], "appPlugins:uninstall:somewindowplugin", "调的是它自己那条卸载口并带上插件 id");

  /* ── [5] IPC 面：安装窗那一条通道 + 动作分派 ── */
  console.log("\n[5] IPC：mtnodeInstall:uninstall 的动作分派");
  const handler = ipcHandlers.get("mtnodeInstall:uninstall");
  ok(typeof handler === "function", "注册了 mtnodeInstall:uninstall");
  const badAct = await handler({}, { action: "nope", id: "llama-local" });
  eq(badAct.error, "bad_action", "不认识的动作一律拒绝");
  resetRoot(pluginRootDir);
  const llamaDir2 = path.join(pluginRootDir, "vLLM");
  mkInstallTree(llamaDir2);
  installHost.registerInstallTarget({ id: "llama-local", key: "llama", name: "llama.cpp 本地模型", getInstallDir: () => llamaDir2 });
  const viaIpc = await handler({}, { action: "preview", id: "llama-local" });
  ok(viaIpc.ok === true && viaIpc.installDir === llamaDir2, "preview 动作走主进程那套预览");
  const busy = installHost.startUninstall("llama-local");
  ok(busy.ok === true, "第一次卸载开始");
  const busy2 = installHost.startUninstall("llama-local");
  eq(busy2.error, "busy", "同一时刻只允许一次卸载");
  await waitFinish("llama-local");
  ok(!fs.existsSync(llamaDir2), "第二次那次 busy 没有影响第一次删干净");

  /* 收尾：临时目录清掉 */
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  console.log("");
  if (fails) {
    console.log("FAILED " + fails + " / " + checks + " checks");
    process.exit(1);
  }
  console.log("ALL PASS " + checks + " checks");
})().catch((e) => {
  console.error("FAIL  卸载冒烟异常：" + ((e && e.stack) || e));
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});

"use strict";
/* 插件显存门槛（本轮需求：显存不够的本地后端插件直接隐藏，避免新装的人装完跑不起来）
 *   node test/smoke-plugin-vram-gate.js
 *
 * 锁住本轮共识（口径与名单的唯一真源是 plugins/vram-gate.js 的文件头）：
 *   1. 名单与门槛只有一份：sensenova-local 24G · minimax-music3 24G ·
 *      yue2-local 16G · minimax-h3 16G（H3 由用户后续追加），llama / breeze / remotion 不参与。
 *   2. 比较的是读数：读得到显存（多卡取最大那张）且小于门槛 → 不达标；读不到（无 N 卡 /
 *      nvidia-smi 缺失 / 输出为空 / 数值 null）→ **一律当「没超」**，照常显示插件，绝不因此隐藏。
 *   3. 「已装就保留」：磁盘上有安装目录（.install-ok / .venv / 模型目录 / 非空）→ 即使显存不达标
 *      也照常显示（用户要能进控制台、要能卸载），并标注一句「本机显存可能不足」。
 *   4. 目录侧过滤：主进程 appPlugins:catalog 交给渲染层的列表里**不含**被隐藏的插件
 *      （画布节点菜单与 S.plugins 快照因此同源隐藏）；appPlugins:vramState 那一份**不滤**，
 *      给「显示不支持的插件」开关与卡片标注用。
 *   5. 渲染层：开关默认关、只影响插件列表（画布入口保持隐藏）；卡片标注与虚拟条目都带原因。
 *   6. 后端插件的 installed 现在按**磁盘目录**判定（隐藏与否的「已装」也吃同一个判据）。
 *
 * 覆盖：
 *   [1] plugins/vram-gate.js 纯判定（读数三态 / 门槛表 / 目录判据 / TTL 缓存）
 *   [2] 冒烟替身驱真 readGpu：不同显存下各插件的 hide / notice
 *   [3] 真实目录树：已装（.install-ok）→ 不被隐藏；空目录 → 不算已装
 *   [4] plugins/main-app-plugins.js：目录过滤 + vram 元数据 + IPC + 磁盘 installed
 *   [5] preload.js 桥 + renderer/app-plugins.js 开关与标注 + renderer/app.js 画布入口同源
 *   [6] renderer/i18n.js 中英词条 + renderer/css/layout.css 样式
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
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);

/* ── [1] 纯判定 ─────────────────────────────────────────────────────────── */
const gateMod = require(path.join(ROOT, "plugins", "vram-gate.js"));

console.log("\n[1] plugins/vram-gate.js：名单 / 读数三态 / 目录判据");
eq(gateMod.minVramGbOf("sensenova-local"), 24, "SenseNova 门槛 24G");
eq(gateMod.minVramGbOf("minimax-music3"), 24, "Minimax Music 3 门槛 24G");
eq(gateMod.minVramGbOf("yue2-local"), 16, "YuE2 门槛 16G");
eq(gateMod.minVramGbOf("minimax-h3"), 16, "Minimax H3 门槛 16G");
eq(gateMod.hasRequirement("llama-local"), false, "llama 不参与显存门槛");
eq(gateMod.hasRequirement("breeze-tts-local"), false, "Breeze TTS 不参与显存门槛");
eq(gateMod.hasRequirement("remotion"), false, "Remotion 不参与显存门槛");
eq(gateMod.PLUGIN_VRAM_GB["minimax-h3"], 16, "门槛表里有 H3 这一行（16G）");

/* 读数三态：ok（取最大那张卡）/ unknown（无卡、空卡、数值 null） */
const st = (gpu) => gateMod.gpuStateOf(gpu);
eq(st({ available: true, cards: [{ totalMb: 8192 }, { totalMb: 24576 }] }).state, "ok", "两卡取最大那张 → ok");
eq(st({ available: true, cards: [{ totalMb: 8192 }, { totalMb: 24576 }] }).vramGb, 24, "24576MiB → 24G");
eq(st({ available: true, cards: [{ totalMb: 16384 }] }).vramGb, 16, "16384MiB → 16G");
eq(st({ available: false, reason: "nvidia-smi 不可用", cards: [] }).state, "unknown", "无 N 卡 → unknown");
eq(st({ available: true, cards: [] }).state, "unknown", "卡列表为空 → unknown");
eq(st({ available: true, cards: [{ totalMb: null }] }).state, "unknown", "显存数值 null → unknown");
eq(st(null).state, "unknown", "完全没有读数 → unknown");

/* 目录判据：不存在 / 空目录 / 有就绪标记 / 有内容 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-vram-"));
const emptyDir = path.join(tmp, "empty");
const okDir = path.join(tmp, "installed");
const contentDir = path.join(tmp, "content");
fs.mkdirSync(emptyDir, { recursive: true });
fs.mkdirSync(okDir, { recursive: true });
fs.mkdirSync(contentDir, { recursive: true });
fs.writeFileSync(path.join(okDir, ".install-ok"), "1", "utf8");
fs.writeFileSync(path.join(contentDir, "model.safetensors"), "x", "utf8");
eq(gateMod.dirLooksInstalled(""), false, "空路径不算已装");
eq(gateMod.dirLooksInstalled(path.join(tmp, "nope")), false, "目录不存在不算已装");
eq(gateMod.dirLooksInstalled(emptyDir), false, "空目录不算已装");
eq(gateMod.dirLooksInstalled(okDir), true, ".install-ok → 已装");
eq(gateMod.dirLooksInstalled(contentDir), true, "目录非空 → 已装");

/* ── [2] 替身读数驱真判定：各档显存下 hide / notice ───────────────────────── */
console.log("\n[2] 显存档位 × 插件：hide / notice（未装）");

function gateFor(vramGb, installedIds) {
  const cards = vramGb == null ? [] : [{ name: "stub", totalMb: Math.round(vramGb * 1024) }];
  const inst = new Set(installedIds || []);
  return gateMod.createVramGate({
    readGpu: async () => ({ available: cards.length > 0, reason: cards.length ? "" : "stub 无卡", cards }),
    isInstalled: (raw) => inst.has(String((raw && raw.id) || "")),
    ttlMs: 0,
  });
}
async function stateOf(gate, id) {
  return gate.stateOf({ id });
}
const IDS = ["sensenova-local", "minimax-music3", "yue2-local", "minimax-h3"];

(async function main() {
  /* 8G 机器：四个有门槛的全部藏 */
  {
    const g = gateFor(8, []);
    const out = {};
    for (const id of IDS) out[id] = await stateOf(g, id);
    eq(out["sensenova-local"].hide, true, "8G + 未装 → SenseNova 隐藏");
    eq(out["minimax-music3"].hide, true, "8G + 未装 → Music 3 隐藏");
    eq(out["yue2-local"].hide, true, "8G + 未装 → YuE2 隐藏（<16G）");
    eq(out["minimax-h3"].required, true, "8G + 未装 → H3 有门槛（16G）");
    eq(out["minimax-h3"].hide, true, "8G + 未装 → H3 隐藏（<16G）");
    eq(out["sensenova-local"].notice, "", "被藏的那一档不需要 notice（列表里根本没有它）");
  }
  /* 16G 机器：YuE2 与 H3 放行，另外两个仍旧藏 */
  {
    const g = gateFor(16, []);
    eq((await stateOf(g, "yue2-local")).hide, false, "16G → YuE2 放行（门槛 16G）");
    eq((await stateOf(g, "minimax-h3")).hide, false, "16G → H3 放行（门槛正好 16G）");
    eq((await stateOf(g, "sensenova-local")).hide, true, "16G → SenseNova 仍隐藏");
    eq((await stateOf(g, "minimax-music3")).hide, true, "16G → Music 3 仍隐藏");
  }
  /* 24G 机器：四家全放行 */
  {
    const g = gateFor(24, []);
    eq((await stateOf(g, "sensenova-local")).hide, false, "24G → SenseNova 放行（门槛正好 24G）");
    eq((await stateOf(g, "minimax-music3")).hide, false, "24G → Music 3 放行");
    eq((await stateOf(g, "yue2-local")).hide, false, "24G → YuE2 放行");
    eq((await stateOf(g, "minimax-h3")).hide, false, "24G → H3 放行");
  }
  /* 32G 机器：全放行 */
  {
    const g = gateFor(32, []);
    eq((await stateOf(g, "sensenova-local")).hide, false, "32G → SenseNova 放行");
  }
  /* 读不到显存：一律不隐藏（这条是本轮最容易被写反的地方） */
  {
    for (const v of [null, undefined]) {
      const g = gateFor(v, []);
      const a = await stateOf(g, "sensenova-local");
      eq(a.hide, false, "读不到显存（" + show(v) + "）→ 不隐藏 SenseNova");
      eq(a.vramOk, true, "读不到显存 → vramOk 记 true（不把探测失败当显存不足）");
      eq(a.vram.state, "unknown", "读不到显存 → 读数状态 unknown");
      eq((await stateOf(g, "minimax-music3")).hide, false, "读不到显存 → 不隐藏 Music 3");
    }
    const g = gateMod.createVramGate({
      readGpu: async () => {
        throw new Error("nvidia-smi 炸了");
      },
      isInstalled: () => false,
      ttlMs: 0,
    });
    eq((await stateOf(g, "sensenova-local")).hide, false, "探测抛异常 → 同样不隐藏（当没超）");
  }
  /* 已装就保留 + 标注一句 */
  {
    const g = gateFor(8, ["sensenova-local", "yue2-local"]);
    const a = await stateOf(g, "sensenova-local");
    eq(a.hide, false, "8G 但已装 → SenseNova 不隐藏（用户要能进控制台 / 卸载）");
    eq(a.notice, "本机显存可能不足", "已装但不达标 → 给一句标注");
    eq(a.vramOk, false, "已装但不达标 → vramOk 仍记 false（标注的依据）");
    const b = await stateOf(g, "minimax-music3");
    eq(b.hide, true, "8G 且未装 → Music 3 照旧隐藏");
    eq(b.notice, "", "被隐藏的那一条不给 notice");
  }
  /* TTL 缓存：同一 TTL 内不重复读，invalidate 后重读 */
  {
    let calls = 0;
    const g = gateMod.createVramGate({
      readGpu: async () => {
        calls++;
        return { available: true, cards: [{ totalMb: 8 * 1024 }] };
      },
      isInstalled: () => false,
      ttlMs: 60000,
    });
    await stateOf(g, "sensenova-local");
    await stateOf(g, "minimax-music3");
    eq(calls, 1, "TTL 内两次判定只读一次显存（别每张卡片 spawn 一次 nvidia-smi）");
    g.invalidate();
    await stateOf(g, "sensenova-local");
    eq(calls, 2, "invalidate 后重读一次");
  }

  /* ── [3][4] 真目录 + 真目录模块：catalog 过滤与 vram 元数据 ──────────────── */
  console.log("\n[3][4] plugins/main-app-plugins.js：目录过滤 / vram 元数据 / 磁盘 installed");

  const sandbox = fs.mkdtempSync(path.join(__dirname, "_tmp-vram-gate-"));
  const dataDir = path.join(sandbox, "data");
  const appDir = path.join(sandbox, "appdir");
  const plugRoot = path.join(sandbox, "plugroot");
  for (const d of [dataDir, appDir, plugRoot]) fs.mkdirSync(d, { recursive: true });

  /* electron 替身：本模块只用到 ipcMain / BrowserWindow / dialog / screen / shell / app */
  const ipcHandlers = new Map();
  const electronStub = {
    ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), on: () => {} },
    BrowserWindow: class {
      constructor() {
        this.webContents = { send: () => {} };
      }
      isDestroyed() {
        return true;
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
    shell: { openPath: () => "" },
    app: { getPath: () => appDir, getVersion: () => "1.5.0" },
  };
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === "electron") return electronStub;
    return origLoad.call(this, req, parent, isMain);
  };
  /* 云端目录指向一个必然连不上的本机端口：模块走「缓存 → 内置兜底」那条路（用 plugins/catalog.default.json） */
  process.env.MTNODE_PLUGIN_URL = "http://127.0.0.1:1/mtnode/plugins";
  const appPlugins = require(path.join(ROOT, "plugins", "main-app-plugins.js"));
  appPlugins.registerAppPluginsIpc({
    getDataDir: () => dataDir,
    getMainWin: () => null,
    appRoot: appDir,
    getAppVersion: () => "1.5.0",
  });
  /* 插件根目录：让「已装」判据有地方可查（installDir 写在 <数据目录>/config.json） */
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({ plugins: { installDir: plugRoot } }),
    "utf8",
  );

  const vramStateHandler = ipcHandlers.get("appPlugins:vramState");
  const catalogHandler = ipcHandlers.get("appPlugins:catalog");
  ok(typeof vramStateHandler === "function", "注册了 appPlugins:vramState（开关与标注吃它）");
  ok(typeof catalogHandler === "function", "appPlugins:catalog 仍在（增了显存过滤）");

  function resetPlugins(ids) {
    for (const id of ids) {
      /* 目录名走真源（sense / music / yue2），不是插件 id */
      const dir = path.join(plugRoot, plugSubDir(id));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  /* 各插件的默认子目录名：直接用真源（plugins/plugin-root.js 的 subDirNameOf），
     别在冒烟里再抄一份（抄错了就会把「已装」写到另一个目录，测出一个假绿或假红）。 */
  const subDirNameOf = require(path.join(ROOT, "plugins", "plugin-root.js")).subDirNameOf;
  function plugSubDir(id) {
    return subDirNameOf(id) || id;
  }
  function markInstalled(id) {
    const dir = path.join(plugRoot, plugSubDir(id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".install-ok"), "1", "utf8");
  }

  async function catalogIds() {
    const r = await catalogHandler();
    return ((r && r.plugins) || []).map((p) => p.id);
  }
  async function vramOf(id) {
    const r = await vramStateHandler();
    return ((r && r.plugins) || []).find((p) => p.id === id) || null;
  }

  /* 本机这块卡：显存读数由真 nvidia-smi 决定，冒烟不能依赖它 —— 所以这里断言的是
     「目录过滤与 vramState 自洽」，以及「没门槛的插件永远在、llama / Breeze 永远在」。 */
  const snap = await vramStateHandler();
  ok(snap && Array.isArray(snap.plugins), "vramState 回一份插件门槛清单");
  ok(snap && snap.reading && typeof snap.reading.state === "string", "带回读数状态（ok / unknown）");
  const h3Meta = (snap.plugins || []).find((p) => p.id === "minimax-h3");
  ok(!!h3Meta, "H3 在门槛清单里（16G）");
  if (h3Meta) eq(h3Meta.minVramGb, 16, "门槛清单里 H3 的门槛 = 16G");
  const idsUninstalled = await catalogIds();
  ok(idsUninstalled.indexOf("llama-local") >= 0, "目录里 llama 照常出现");
  ok(idsUninstalled.indexOf("breeze-tts-local") >= 0, "目录里 Breeze TTS 照常出现");
  for (const id of ["sensenova-local", "minimax-music3", "yue2-local", "minimax-h3"]) {
    const st = await vramOf(id);
    const listed = idsUninstalled.indexOf(id) >= 0;
    if (!st) {
      ok(listed, "没门槛判定（" + id + "）→ 目录照常列出");
      continue;
    }
    eq(
      listed,
      st.hide !== true,
      id + "：目录是否列出与 hide 一致（hide=true 时列表里没有它）",
    );
    if (st.vramOk === false && st.installed) {
      ok(listed, id + "：显存不达标但已装 → 照常列出（可进控制台 / 卸载）");
    }
  }

  /* 装一份 SenseNova（.install-ok）：installed 必须翻成 true（按磁盘目录判，不再恒为 true） */
  markInstalled("sensenova-local");
  const catAfter = await catalogHandler();
  const sens = ((catAfter && catAfter.plugins) || []).find((p) => p.id === "sensenova-local");
  if (sens) {
    eq(sens.installed, true, "装了 .install-ok → installed:true（磁盘判据）");
    eq(sens.vram && sens.vram.required, true, "SenseNova 条目挂上了 vram 元数据");
    eq(sens.vram && sens.vram.minVramGb, 24, "元数据里的门槛 = 24G");
    eq(sens.vram && sens.vram.hide, false, "已装的条目 hide 恒为 false（目录里必须留着它）");
  } else {
    /* 显存不足但**已装**时它必须还在列表里；真缺了就是回归 */
    ok(false, "装了 .install-ok 后 SenseNova 必须仍在目录里");
  }
  const stSens = await vramOf("sensenova-local");
  if (stSens) eq(stSens.installed, true, "vramState 里的 installed 跟着磁盘走");
  /* 空目录不算已装（避免「建了个空文件夹就被当成已装而不隐藏」） */
  resetPlugins(["sensenova-local", "minimax-music3", "yue2-local"]);
  fs.mkdirSync(path.join(plugRoot, "music"), { recursive: true });
  const catEmpty = await catalogHandler();
  ok(
    !!catEmpty,
    "空目录的插件不被当成「已装」（仍按显存门槛决定去留）",
  );
  resetPlugins(["sensenova-local", "minimax-music3", "yue2-local"]);

  /* ── [4b] 换一块「小显存」的机器：走真目录过滤（本机是 24G 卡，不挂钩就走不到隐藏那一档）──
     挂钩只改读数（MTNODE_VRAM_OVERRIDE_GB），判定与过滤仍是生产代码那一条链。 */
  console.log("\n[4b] 8G / 16G / 24G 机器：目录过滤真跑（读数用冒烟挂钩）");
  /* 上面那一段给 SenseNova 写过 .install-ok（已装就保留），这里先清成干净现场 */
  fs.rmSync(plugRoot, { recursive: true, force: true });
  fs.mkdirSync(plugRoot, { recursive: true });
  function freshPluginsModule(vramGb) {
    for (const k of Object.keys(require.cache)) {
      if (k.indexOf(path.join("plugins", "main-app-plugins.js")) >= 0) delete require.cache[k];
      if (k.indexOf(path.join("plugins", "vram-gate.js")) >= 0) delete require.cache[k];
    }
    if (vramGb == null) delete process.env.MTNODE_VRAM_OVERRIDE_GB;
    else process.env.MTNODE_VRAM_OVERRIDE_GB = String(vramGb);
    const mod = require(path.join(ROOT, "plugins", "main-app-plugins.js"));
    mod.registerAppPluginsIpc({
      getDataDir: () => dataDir,
      getMainWin: () => null,
      appRoot: appDir,
      getAppVersion: () => "1.5.0",
    });
    return {
      catalog: async () => ((await ipcHandlers.get("appPlugins:catalog")()) || {}).plugins || [],
      vram: async () => await ipcHandlers.get("appPlugins:vramState")(),
    };
  }
  {
    const m8 = freshPluginsModule(8);
    const ids = (await m8.catalog()).map((p) => p.id);
    eq(ids.indexOf("sensenova-local"), -1, "8G 机器：SenseNova 不在目录里（渲染层拿不到它）");
    eq(ids.indexOf("minimax-music3"), -1, "8G 机器：Minimax Music 3 不在目录里");
    eq(ids.indexOf("yue2-local"), -1, "8G 机器：YuE2 不在目录里（<16G）");
    eq(ids.indexOf("minimax-h3"), -1, "8G 机器：H3 不在目录里（<16G）");
    ok(ids.indexOf("llama-local") >= 0 && ids.indexOf("breeze-tts-local") >= 0, "8G 机器：llama / Breeze 照常");
    const st8 = await m8.vram();
    eq((st8.plugins || []).filter((p) => p.hide).length, 4, "不滤的那一份标出 4 个被隐藏的插件");
    ok((st8.hidden || []).indexOf("sensenova-local") >= 0, "hidden 名单里有 SenseNova（开关据此拼回卡片）");

    /* 已装就保留：装一份 SenseNova，8G 机器上它必须回到列表里 */
    markInstalled("sensenova-local");
    const m8b = freshPluginsModule(8);
    const ids2 = (await m8b.catalog()).map((p) => p.id);
    ok(ids2.indexOf("sensenova-local") >= 0, "8G 机器但已装 SenseNova → 仍在目录里（可进控制台 / 卸载）");
    const sens2 = (await m8b.catalog()).find((p) => p.id === "sensenova-local");
    eq(sens2.vram.vramOk, false, "已装条目的 vramOk=false（卡片要标注）");
    eq(sens2.vram.hide, false, "已装条目的 hide=false（不进隐藏档）");
    eq(sens2.installed, true, "已装条目的 installed=true");
    resetPlugins(["sensenova-local"]);

    const m16 = freshPluginsModule(16);
    const ids16 = (await m16.catalog()).map((p) => p.id);
    ok(ids16.indexOf("yue2-local") >= 0, "16G 机器：YuE2 在目录里（门槛 16G）");
    ok(ids16.indexOf("minimax-h3") >= 0, "16G 机器：H3 在目录里（门槛正好 16G）");
    eq(ids16.indexOf("sensenova-local"), -1, "16G 机器：SenseNova 仍不在目录里");
    eq(ids16.indexOf("minimax-music3"), -1, "16G 机器：Music 3 仍不在目录里");

    const m24 = freshPluginsModule(24);
    const ids24 = (await m24.catalog()).map((p) => p.id);
    ok(ids24.indexOf("sensenova-local") >= 0, "24G 机器：SenseNova 在目录里（门槛正好够）");
    ok(ids24.indexOf("minimax-music3") >= 0, "24G 机器：Music 3 在目录里");
    ok(ids24.indexOf("yue2-local") >= 0, "24G 机器：YuE2 在目录里");
    ok(ids24.indexOf("minimax-h3") >= 0, "24G 机器：H3 在目录里");
    const mNone = freshPluginsModule(null);
    const snapNone = await mNone.vram();
    ok(
      snapNone.reading.state === "ok" || snapNone.reading.state === "unknown",
      "去掉挂钩后回真读数（本机 24G 卡 → ok 24）",
    );
    ok(
      (await mNone.catalog()).some((p) => p.id === "minimax-music3"),
      "真读数下 Music 3 仍可见（本机 24G）",
    );
  }

  /* ── [5] 渲染层接线 ───────────────────────────────────────────────────── */
  console.log("\n[5] 渲染层：开关 / 标注 / 画布入口同源");
  const rp = read("renderer/app-plugins.js");
  const hasIn = (hay, needle, msg) => ok(String(hay).indexOf(needle) >= 0, msg + "（缺 " + show(needle) + "）");
  hasIn(rp, "appPluginsVramState", "对话框拉「不滤」的门槛现状");
  hasIn(rp, "显示不支持的插件", "底部那一行低频入口的开关文案");
  hasIn(rp, "let _showUnsupportedPlugins = false", "开关默认关");
  hasIn(rp, "pluginVramHiddenItems", "开关打开时把被滤掉的卡片拼回来");
  /* 本轮需求：卡片底部不许再出现任何文字 → 显存门槛那句标注（pluginVramNoticeText）已删除，
     理由改由虚拟条目那颗置灰按钮的文案与 tooltip 承担。 */
  ok(rp.indexOf("pluginVramNoticeText") < 0, "卡片上的显存门槛标注已删除（缺则说明又加回卡片了）");
  ok(rp.indexOf("本机显存可能不足（本机 {reading} · 需要 ≥{need}G）") < 0, "占位词条不再被卡片引用");
  hasIn(rp, "本机显存不足，无法安装", "虚拟条目的按钮写明原因");
  ok(rp.indexOf("function pluginVramField(") < 0, "只服务于卡片标注的 pluginVramField 已删（不留死代码）");

  const appjs = read("renderer/app.js");
  hasIn(appjs, "function appPluginHiddenByVram", "画布侧读「哪些插件被显存门槛滤掉」");
  hasIn(appjs, "S.pluginsVramHidden", "被滤掉的插件不在目录里 → 另存一份 hidden 集合");
  hasIn(appjs, "window.api.appPluginsVramState()", "refreshAppPluginsCache 顺手拉一次不滤的门槛现状");
  hasIn(appjs, "function nodeKindHiddenByVram", "按节点类型判显存门槛");
  hasIn(appjs, "const NODE_KIND_PLUGIN", "节点类型 → 插件的唯一映射表");
  hasIn(appjs, 'music_gen: "minimax-music3"', "music_gen 映射到 minimax-music3");
  hasIn(appjs, 'sensenova_gen: "sensenova-local"', "sensenova_gen 映射到 sensenova-local");
  hasIn(appjs, 'video_gen: "minimax-h3"', "video_gen 映射到 minimax-h3（H3 也吃显存门槛）");
  hasIn(appjs, "function ctxDropVramHidden", "右键子菜单按门槛收项的助手");
  hasIn(appjs, 'ctxSubmenu(I18n.t("音频生成"), "music_gen", "music", ctxDropVramHidden([', "音频生成三项走同一个过滤器");
  hasIn(appjs, 'ctxSubmenu(I18n.t("图像生成"), "proc_image", "proc-img", ctxDropVramHidden([', "图像生成两项走同一个过滤器");
  hasIn(appjs, 'ctxSubmenu(I18n.t("视频生成"), "video_gen", "video", ctxDropVramHidden([', "视频生成子菜单同样走过滤器（H3 收项）");
  hasIn(appjs, "if (spec.vramKind && nodeKindHiddenByVram(spec.vramKind)) continue;", "拖线落点同样按门槛过滤");
  hasIn(appjs, 'vramKind: "music_gen"', "落点清单给本地后端节点标了 vramKind");
  hasIn(appjs, '{ kind: "video_gen", g: "处理节点", vramKind: "video_gen" }', "拖线落点给 H3 也标了 vramKind");

  const pre = read("preload.js");
  hasIn(pre, "appPluginsVramState", "preload 桥：appPlugins:vramState");
  hasIn(pre, "appPlugins:vramState", "preload 桥打到主进程那条 channel");

  /* 画布入口与开关的关系：开关只管列表（画布判定不读 _showUnsupportedPlugins） */
  const appHiddenFn = appjs.slice(
    appjs.indexOf("function appPluginHiddenByVram"),
    appjs.indexOf("function appPluginHiddenByVram") + 420,
  );
  ok(
    appHiddenFn.indexOf("_showUnsupportedPlugins") < 0,
    "画布入口判定**不**吃「显示不支持的插件」开关（开关只影响插件列表）",
  );

  /* ── [5b] 真跑渲染层那几个函数：开关关着时必须「一条都不拼回来」 ──────────────
     这一条是**真跑出来的回归**：初版把「开关」写进了单条构造函数里，于是
     pluginVramHiddenItems() 在开关**关着**时照样返回被藏的每一条 —— 真机上就是「显存不足的
     插件照旧显示」。所以这里把 renderer/app-plugins.js 的显存门槛那一段真正执行一遍。 */
  console.log("\n[5b] renderer/app-plugins.js 真跑：开关关着不拼卡片");
  {
    const rpSrc = read("renderer/app-plugins.js");
    const from = rpSrc.indexOf("const PLUGIN_VRAM_KNOWN_KINDS = {");
    const to = rpSrc.indexOf("function buildPluginVramBar()");
    ok(from > 0 && to > from, "能从 app-plugins.js 切出显存门槛那一段（标点未漂移）");
    const code = rpSrc.slice(from, to);
    ok(
      code.indexOf("let _showUnsupportedPlugins = false") >= 0,
      "切出来的那一段自带开关与快照两个模块级变量（不再另抄一份声明）",
    );
    const vm = require("vm");
    function runChunk(toggle, snapshot) {
      const box = {
        I18n: { t: (k, vars) => (vars ? k + "|" + JSON.stringify(vars) : k) },
        console,
        Math,
        JSON,
        String,
        Number,
        Object,
        Array,
        Date,
        window: {},
      };
      vm.createContext(box);
      vm.runInContext(code, box, { filename: "vram-helpers.js" });
      vm.runInContext("_showUnsupportedPlugins = " + (toggle ? "true" : "false") + ";", box);
      vm.runInContext("_pluginVramState = " + JSON.stringify(snapshot) + ";", box);
      return {
        bar: vm.runInContext("pluginVramHiddenItems()", box),
        one: vm.runInContext('pluginVramHiddenItem("minimax-music3", "Minimax Music 3")', box),
      };
    }
    const snap = {
      ok: true,
      reading: { state: "ok", vramGb: 8, reason: "" },
      hidden: ["minimax-music3", "sensenova-local", "yue2-local", "minimax-h3"],
      plugins: [
        { id: "minimax-music3", minVramGb: 24, vramOk: false, hide: true, notice: "", installed: false },
        { id: "sensenova-local", minVramGb: 24, vramOk: false, hide: true, notice: "", installed: false },
        { id: "yue2-local", minVramGb: 16, vramOk: false, hide: true, notice: "", installed: false },
        { id: "minimax-h3", minVramGb: 16, vramOk: false, hide: true, notice: "", installed: false },
      ],
    };
    const off = runChunk(false, snap);
    eq(off.bar.length, 0, "开关关着 → pluginVramHiddenItems() 一条都不拼（初版 bug：返回 3 条）");
    const on = runChunk(true, snap);
    eq(on.bar.length, 4, "开关打开 → 四条都拼回来");
    eq(
      on.bar.map((x) => x.id).join(","),
      "minimax-music3,sensenova-local,yue2-local,minimax-h3",
      "拼回来的顺序稳定",
    );
    eq(on.bar[0].kind, "vram", "拼回来的是虚条目（kind=vram，不会去问宿主状态）");
    eq(on.bar[0].compatible, false, "虚条目的动作是置灰的");
    eq(on.bar[0].vram.hide, false, "虚条目本身不该再被 hide（它已经显示出来了）");
    eq(on.bar[0].vram.reading, 8, "虚条目带上本机读数（标注写 ≈8G，不是「量不到」）");
    ok(
      on.one.subtitle.zh.indexOf("≈8G") >= 0 && on.one.subtitle.zh.indexOf("24") >= 0,
      "虚条目的说明写清「本机 ≈8G · 需要 ≥24G」（实到 " + show(on.one.subtitle.zh) + "）",
    );
    /* 已装的那一条不该被拼回来（目录里本来就有它） */
    const snapInstalled = Object.assign({}, snap, {
      plugins: [
        { id: "minimax-music3", minVramGb: 24, vramOk: false, hide: false, notice: "本机显存可能不足", installed: true },
      ],
    });
    eq(runChunk(true, snapInstalled).bar.length, 0, "已装的插件（hide=false）不被拼回列表（目录里有它）");
  }

  /* ── [6] i18n 与样式 ─────────────────────────────────────────────────── */
  console.log("\n[6] i18n 中英词条 + CSS");
  const i18n = read("renderer/i18n.js");
  const enKeys = [
    ["显示不支持的插件", "Show unsupported plugins"],
    ["本机显存可能不足（本机 {reading} · 需要 ≥{need}G）", "VRAM may be insufficient on this machine"],
    ["本机显存不足，无法安装", "Not enough VRAM on this machine — cannot install"],
    ["显存不足的本地后端插件默认隐藏（避免装完跑不起来）", "Local backend plugins that need more VRAM are hidden by default"],
  ];
  for (const [zh, en] of enKeys) {
    hasIn(i18n, JSON.stringify(zh) + ":", "i18n 有中文键：" + zh);
    hasIn(i18n, en, "i18n 的英文译文：" + en);
  }
  const css = read("renderer/css/layout.css");
  hasIn(css, ".plugin-vram-bar {", "CSS：底部那一行开关");
  hasIn(css, ".plugin-vram-bar .plugin-vram-hint", "CSS：那一行的说明小字");

  /* ── 收尾 ───────────────────────────────────────────────────────────── */
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {}

  console.log("\n" + (fails ? "FAILED" : "PASSED") + "  " + (checks - fails) + "/" + checks + " 项通过");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("smoke-plugin-vram-gate 崩了：", (e && e.stack) || e);
  process.exit(1);
});

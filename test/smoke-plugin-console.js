"use strict";
/* 插件界面内嵌 console + 「插件不再呼出独立的后端窗口」的回归
 *   node test/smoke-plugin-console.js
 *
 * 锁住本轮共识（8 个本地后端插件一次改齐：music3 / yue2 / sensenova / h3 / llama / tts /
 * breeze / remotion）：
 *   1. 卡片主按钮 = 启动 / 停止后端（<api>Start / <api>Stop）—— 点「启动」只是静默后台拉起后端
 *      （后端进程本来就 windowsHide，stdout 落日志文件），不再打开那只独立窗；
 *      未安装时主按钮 = 「安装」（先弹系统目录选择框，仍然不开插件窗）；启动中显示「启动中…」
 *      且再点一次 = 停止。
 *   2. 次按钮 = 「控制台」（<api>Open）：那只独立窗仍保留（安装 / 卸载 / H3 工作流编辑器等重功能
 *      还在里面），但只由用户显式打开（卡片按钮 / 托盘菜单）。
 *   3. 卡片详情浮层内嵌**只读** console：状态行（运行中 / 端口 / 进度 / 显存）+ 后端 stdout
 *      日志尾部（2s 增量轮询；可复制 / 清屏；关浮层即停）。
 *   4. 后端求助（llama / TTS / Breeze 的 ui-signal）不再自动开窗 → 卡片角标 + 状态行一句
 *      + console 里一行（宿主 statusForUi 的 notice 字段 + <prefix>:notice 事件）。
 *   5. Remotion 没有常驻后端（无 start / stop）：只给「安装 / 重装」+「控制台」。
 *   6. 关掉控制台窗不影响后端（后端单例不随 MTNode 退出）—— 本轮没动这条，回归里钉住没被改坏。
 *
 * 覆盖：
 *   [1] app-plugins.js：8 个 spec / 共用卡片 / 新「控制台」图标 / 卡片角标
 *   [2] 内嵌 console：只读、增量轮询、复制 / 清屏、关浮层即停
 *   [3] preload.js 桥：8 个 ConsoleTail + 3 个 Notice，与宿主 handle / 事件通道一一成对
 *   [4] 三个宿主：ui-signal 不再自动开窗（改 noteBackendNotice + status.notice + 开窗清提示）
 *   [5] 8 个插件的启停 / 安装 / 选目录 / 开窗桥一个不缺；Remotion 明确没有启停
 *   [6] 关窗不停后端（单例口径没被改坏）
 *   [7] i18n 中英词条 + CSS + 指南同步
 *   [8] 后端解释器口径：venv 的 python.exe → pythonw.exe（GUI 子系统不分配控制台，
 *       否则 Store 版 Python 的 venv python.exe shim 再拉真解释器时会多弹一只终端窗口）
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + show(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + show(needle) + "）"));
};
/* 按名字切出顶层函数体（不改动源文件） */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\("));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体不闭合：" + name);
}

/* 8 个本地后端插件：kind → { api 前缀, 宿主文件, 宿主 IPC 前缀 } */
const PLUGINS = {
  music3: { api: "music3", host: "music3/main-music3.js", ipc: "music3" },
  yue2: { api: "yue2", host: "yue/main-yue.js", ipc: "yue" },
  sensenova: { api: "sensenova", host: "sensenova/main-sensenova.js", ipc: "sensenova" },
  h3: { api: "h3", host: "h3/main-h3.js", ipc: "h3" },
  llama: { api: "llama", host: "llama/main-llama.js", ipc: "llama" },
  tts: { api: "tts", host: "tts/main-tts.js", ipc: "tts" },
  breeze: { api: "breeze", host: "breeze/main-breeze.js", ipc: "breeze" },
  remotion: { api: "remotion", host: "remotion/main-remotion.js", ipc: "remotion" },
};
/* 卡片按 spec.api 取桥名：<api>Status / Start / Stop / Install / PickInstallDir / Open / ConsoleTail */
const BRIDGE = {
  music3: ["Start", "Stop", "Install", "PickInstallDir", "Open", "ConsoleTail"],
  yue2: ["Start", "Stop", "Install", "PickInstallDir", "Open", "ConsoleTail"],
  sensenova: ["Start", "Stop", "Install", "PickInstallDir", "Open", "ConsoleTail"],
  h3: ["Start", "Stop", "Install", "PickInstallDir", "Open", "ConsoleTail"],
  llama: ["Start", "Stop", "Install", "PickInstallDir", "Open", "ConsoleTail"],
  tts: ["Start", "Stop", "Install", "PickInstallDir", "Open", "ConsoleTail"],
  breeze: ["Start", "Stop", "Install", "PickInstallDir", "Open", "ConsoleTail"],
  remotion: ["Install", "PickInstallDir", "Open", "ConsoleTail"],
};
const TAIL_BRIDGE = {
  music3: "music3ConsoleTail",
  yue2: "yue2ConsoleTail",
  sensenova: "sensenovaConsoleTail",
  h3: "h3ConsoleTail",
  llama: "llamaConsoleTail",
  tts: "ttsConsoleTail",
  breeze: "breezeConsoleTail",
  remotion: "remotionConsoleTail",
};

(async () => {
  const pluginsSrc = read("renderer/app-plugins.js");
  const preloadSrc = read("preload.js");
  const i18nSrc = read("renderer/i18n.js");
  const cssSrc = read("renderer/css/layout.css");
  const specs = pluginsSrc.slice(
    pluginsSrc.indexOf("const BACKEND_PLUGIN_SPECS = {"),
    pluginsSrc.indexOf("};", pluginsSrc.indexOf("const BACKEND_PLUGIN_SPECS = {")),
  );
  const backendCard = fnBody(pluginsSrc, "refreshBackendPluginCard");
  const popConsole = fnBody(pluginsSrc, "mountPluginPopConsole");
  const closePop = fnBody(pluginsSrc, "closePluginPop");

  /* ═════════ [1] 8 个 spec + 共用卡片 + 新图标 + 角标 ═════════ */
  console.log("\n[1] app-plugins.js：8 个本地后端插件共用一份卡片实现");
  has(pluginsSrc, "const BACKEND_PLUGIN_SPECS = {", "有 BACKEND_PLUGIN_SPECS 规格表");
  for (const k of Object.keys(PLUGINS)) {
    has(specs, k + ": { key: \"" + k + "\", api: \"" + PLUGINS[k].api + "\"", "spec 登记 " + k);
    has(
      pluginsSrc,
      "refreshBackendPluginCard(root, BACKEND_PLUGIN_SPECS." + k,
      "refresh" + k + " 卡走共用实现（薄壳只传 spec / opts）",
    );
  }
  has(
    specs,
    'remotion: { key: "remotion", api: "remotion", hasService: false }',
    "Remotion 标记 hasService:false（没有常驻后端，不给启动 / 停止）",
  );
  const svgTable = pluginsSrc.slice(
    pluginsSrc.indexOf("const PLUGIN_ACT_SVG = {"),
    pluginsSrc.indexOf("};", pluginsSrc.indexOf("const PLUGIN_ACT_SVG = {")),
  );
  has(svgTable, "console:", "PLUGIN_ACT_SVG 新增「控制台」图标（不复用 gear，避免与设置混同）");
  const usedKinds = [...new Set([...backendCard.matchAll(/addBtn\("([a-z]+)"/g)].map((m) => m[1]))];
  ok(
    usedKinds.length > 0 && usedKinds.every((k) => svgTable.indexOf(k + ":") >= 0),
    "共用卡片用到的图标全在 PLUGIN_ACT_SVG 里（" + usedKinds.join("/") + "）",
  );
  has(backendCard, 'pluginApiFn(spec.api + "Start")', "主按钮调 <api>Start（静默后台拉起后端）");
  has(backendCard, 'pluginApiFn(spec.api + "Stop")', "主按钮调 <api>Stop（停止 = 停后端）");
  has(backendCard, 'pluginApiFn(spec.api + "Open")', "次按钮调 <api>Open（控制台 = 显式开窗）");
  has(backendCard, 'I18n.t("启动")', "主按钮文案「启动」");
  has(backendCard, 'I18n.t("停止")', "主按钮文案「停止」");
  has(backendCard, 'I18n.t("控制台")', "次按钮文案「控制台」");
  has(backendCard, 'I18n.t("启动中…（点此停止）")', "启动中按钮可点 = 停止");
  hasnt(backendCard, 'I18n.t("运行")', "共用卡片里不再有「运行 = 开窗」那套文案");
  hasnt(backendCard, 'I18n.t("打开控制台")', "共用卡片里不再有「打开控制台」当主按钮");
  has(backendCard, "_backendStarting", "启动中状态按插件记账（跨重绘保留）");
  has(backendCard, "_backendLastErr", "启动 / 安装失败写进卡片状态行（不静默、不弹窗）");
  has(pluginsSrc, "function setPluginNotice(", "有卡片角标绘制 setPluginNotice");
  has(
    pluginsSrc,
    'plugin-tile-notice" data-plugin-notice hidden',
    "卡片壳里带角标元素",
  );
  has(pluginsSrc, "function backendCardLine(", "卡片状态行统一口径 backendCardLine");
  has(pluginsSrc, 'I18n.t(" —— 可点「控制台」看日志")', "失败时指向「控制台」看日志");
  has(pluginsSrc, "function pluginApiFn(", "桥调用统一走 pluginApiFn（缺桥不炸）");

  /* ═════════ [2] 详情浮层内嵌 console（只读 + 轮询 + 复制 / 清屏） ═════════ */
  console.log("\n[2] 详情浮层内嵌 console：只读、增量轮询、关浮层即停");
  has(pluginsSrc, "function stopPluginPopConsole(", "有关浮层停轮询的 stopPluginPopConsole");
  has(closePop, "stopPluginPopConsole()", "closePluginPop 里停掉内嵌 console");
  has(pluginsSrc, "function stripAnsiText(", "日志去掉 ANSI 转义（免得进 UI 是乱码）");
  has(popConsole, 'pluginApiFn(spec.api + "ConsoleTail")', "日志尾部走 <api>ConsoleTail（只读一次文件，不 probe）");
  has(popConsole, 'pluginApiFn(spec.api + "Status")', "状态行走 <api>Status");
  has(popConsole, "}, 2000);", "日志 2s 一拉");
  has(popConsole, "tick % 8 === 0", "状态每 ~16s 一次（别每 2s spawn 一次 nvidia-smi）");
  has(popConsole, "data-console-copy", "有「复制」键");
  has(popConsole, "data-console-clear", "有「清屏」键");
  has(popConsole, "startsWith(lastTail)", "日志按增量拼接（不整篇重画）");
  hasnt(popConsole, 'spec.api + "Install"', "内嵌 console 只读：不放安装写操作");
  hasnt(popConsole, 'spec.api + "Start"', "内嵌 console 只读：不放启动写操作");
  hasnt(popConsole, 'spec.api + "Stop"', "内嵌 console 只读：不放停止写操作");
  has(pluginsSrc, 'I18n.t("后端运行中")', "状态行写「后端运行中」");
  has(pluginsSrc, 'I18n.t("后端未运行")', "状态行写「后端未运行」");
  has(pluginsSrc, "mountPluginPopConsole(pop, item)", "详情浮层挂上 console 区块");

  /* ═════════ [3] preload 桥 ⇄ 宿主 handle / 事件成对 ═════════ */
  console.log("\n[3] preload.js：8 个 ConsoleTail 桥 + 3 个 Notice 订阅，与宿主一一成对");
  for (const [k, m] of Object.entries(TAIL_BRIDGE)) {
    const p = PLUGINS[k];
    has(preloadSrc, m + ":", "preload 暴露 " + m);
    has(
      read(p.host),
      'ipcMain.handle("' + p.ipc + ':consoleTail"',
      p.host + " 注册 " + p.ipc + ":consoleTail",
    );
    has(preloadSrc, "'" + p.ipc + ":consoleTail'", m + " 转发到 " + p.ipc + ":consoleTail");
  }
  /* 求助通知：只有带 ui-signal 的三个宿主有这条事件通道 */
  for (const [k, api] of [["llama", "llama"], ["tts", "tts"], ["breeze", "breeze"]]) {
    const p = PLUGINS[k];
    has(preloadSrc, "on" + api[0].toUpperCase() + api.slice(1) + "Notice:", "preload 暴露 on" + api[0].toUpperCase() + api.slice(1) + "Notice");
    has(read(p.host), 'broadcast("' + api + ':notice"', p.host + " 广播 " + api + ":notice");
    has(pluginsSrc, "on" + api[0].toUpperCase() + api.slice(1) + "Notice", "插件卡片订阅 " + api + ":notice");
  }
  hasnt(preloadSrc, "llamaNoticeRaw:", "没有多余的 llama notice 旁路桥");

  /* ═════════ [4] 三个宿主：ui-signal 不再自动开窗 ═════════ */
  console.log("\n[4] llama / tts / breeze：后端求助不再自动弹出控制台窗");
  for (const [k, api] of [["llama", "llama"], ["tts", "tts"], ["breeze", "breeze"]]) {
    const src = read(PLUGINS[k].host);
    const watch = src.slice(
      src.indexOf("function startUiSignalWatch()"),
      src.indexOf("function stopUiSignalWatch()"),
    );
    has(watch, "noteBackendNotice(", PLUGINS[k].host + " 的 ui-signal 走 noteBackendNotice");
    hasnt(watch, "openConsoleWindow()", PLUGINS[k].host + " 的 ui-signal 不再开窗");
    has(src, "function noteBackendNotice(", PLUGINS[k].host + " 有 noteBackendNotice");
    has(src, "function clearBackendNotice(", PLUGINS[k].host + " 有 clearBackendNotice");
    has(src, 'notice: pendingNotice ? pendingNotice.text : ""', PLUGINS[k].host + " statusForUi 回传 notice");
    const openFn = src.slice(
      src.indexOf("function openConsoleWindow()"),
      src.indexOf("function closeConsoleWindow()"),
    );
    has(openFn, "clearBackendNotice()", PLUGINS[k].host + " 用户亲手开窗即清掉提示");
    has(watch.replace(/\s+/g, " "), "}, 400);", PLUGINS[k].host + " 求助信号仍是 400ms 轮询（只换了处置方式）");
  }

  /* ═════════ [5] 8 个插件的桥一个不缺；Remotion 明确没有启停 ═════════ */
  console.log("\n[5] 卡片按 spec.api 取桥：8 个插件的启停 / 安装 / 选目录 / 开窗桥齐全");
  for (const [k, names] of Object.entries(BRIDGE)) {
    const api = PLUGINS[k].api;
    for (const n of names) {
      has(preloadSrc, api + n + ":", "preload 暴露 " + api + n + "（" + k + " 卡片要用）");
    }
  }
  has(pluginsSrc, "pluginApiFn(spec.api + \"PickInstallDir\")", "「安装」前先弹系统目录选择框（不开插件窗）");
  has(pluginsSrc, "pluginApiFn(spec.api + \"Install\")", "安装仍可只在卡片上完成");
  hasnt(preloadSrc, "remotionStart:", "Remotion 没有 remotionStart（它没有常驻后端）");
  hasnt(preloadSrc, "remotionStop:", "Remotion 没有 remotionStop（它没有常驻后端）");
  has(pluginsSrc, 'I18n.t("重装")', "Remotion 已装时主按钮 = 「重装」");
  /* 卡片文案口径（本轮共识）：卡片上只剩图标 + 标题 + 动作按钮 ——
     安装口径 / 权重许可这类说明行不再写进卡片（hint 渲染已从共用卡片里移除），
     状态行（安装中 / 启动失败原因）仍由 backendCardLine 显示，失败不静默。 */
  hasnt(pluginsSrc, "const hint = typeof o.hint", "共用卡片不再渲染 hint 说明行");
  hasnt(pluginsSrc, 'I18n.t("权重许可：")', "Breeze 卡片的权重许可小字已移除");

  /* ═════════ [6] 关窗不停后端（单例口径没被改坏） ═════════ */
  console.log("\n[6] 关掉控制台窗不影响后端（后端单例不随 MTNode 退出）");
  for (const k of Object.keys(PLUGINS)) {
    const src = read(PLUGINS[k].host);
    const at = src.indexOf("function closeConsoleWindow()");
    if (at < 0) {
      ok(false, PLUGINS[k].host + " 有 closeConsoleWindow");
      continue;
    }
    const closeFn = src.slice(at, at + 420);
    hasnt(closeFn, "stopBackend()", PLUGINS[k].host + " 的关窗不动后端");
    hasnt(closeFn, "killPidTree", PLUGINS[k].host + " 的关窗不杀后端进程");
  }

  /* ═════════ [7] i18n / CSS / 指南 ═════════ */
  console.log("\n[7] i18n 中英词条 + 样式 + 指南同步");
  for (const [zh, en] of [
    ["启动", "Start"],
    ["控制台", "Console"],
    ["重装", "Reinstall"],
    ["后端提示", "Backend notice"],
    ["后端运行中", "Backend running"],
    ["后端未运行", "Backend stopped"],
    ["清屏", "Clear"],
    ["启动中…（点此停止）", "Starting… (click to stop)"],
  ]) {
    has(i18nSrc, '"' + zh + '": "' + en + '"', "i18n 中英词条：" + zh);
  }
  has(cssSrc, ".plugin-pop.has-console", "详情浮层为内嵌 console 留出宽度");
  has(cssSrc, ".plugin-console-log", "日志区样式（等宽 / 固定高 / 可滚）");
  has(cssSrc, ".plugin-console-status", "状态行样式");
  has(cssSrc, ".plugin-tile-notice", "卡片角标样式");
  has(read("guides/manual/media-gen.md"), "插件卡片", "手册写明新的卡片入口（不再让人先去开控制台窗）");
  has(read("guides/nodes/sensenova_gen.md"), "卡片", "节点指南写明卡片入口");
  hasnt(read("guides/nodes/remotion.md"), "打开控制台安装", "Remotion 指南不再写「打开控制台安装」这个旧入口");

  /* ═════════ [8] 后端解释器：venv python.exe → pythonw.exe（不弹终端窗） ═════════ */
  console.log("\n[8] 后端解释器口径：venv 的 python.exe → pythonw.exe");
  const bpSrc = read("backend-python.js");
  has(bpSrc, "function quietPython(", "backend-python.js 提供 quietPython");
  has(bpSrc, "module.exports = { quietPython }", "backend-python.js 导出 quietPython");
  has(
    read("build.json"),
    '"backend-python.js"',
    "build.json files 白名单收录 backend-python.js（漏了就打包后 Cannot find module）",
  );
  /* 纯函数行为：真建文件判定（不靠正则猜） */
  const { quietPython } = require("../backend-python.js");
  const bpTmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-backend-python-"));
  const mkFile = (name) => {
    const p = path.join(bpTmp, name);
    fs.writeFileSync(p, "stub");
    return p;
  };
  const pyExeReal = mkFile("python.exe");
  const pywReal = mkFile("pythonw.exe");
  const py310 = mkFile("python3.10.exe");
  const py310w = mkFile("python3.10w.exe");
  const nodeExe = mkFile("node.exe");
  const onlyExe = path.join(bpTmp, "no-w", "python.exe");
  fs.mkdirSync(path.dirname(onlyExe), { recursive: true });
  fs.writeFileSync(onlyExe, "stub");
  ok(quietPython(pyExeReal) === pywReal, "同目录有 pythonw.exe 时返回 pythonw.exe");
  ok(quietPython(py310) === py310w, "带版本号同理：python3.10.exe → python3.10w.exe");
  ok(quietPython(onlyExe) === onlyExe, "没有 pythonw.exe 时原样返回 python.exe（uv / 少见 venv 不炸）");
  ok(quietPython(nodeExe) === nodeExe, "非 python*.exe 原样返回（不误改解释器）");
  ok(quietPython(pywReal) === pywReal, "已经是 pythonw.exe 不再追加 w");
  ok(quietPython("") === "", "空路径原样返回");
  /* 7 个起 python 后端的宿主：都走统一口径 */
  const PY_WIRING = {
    "llama/main-llama.js": ['const py = quietPython(pyExe);'],
    "tts/main-tts.js": ['const py = quietPython(pyExe);'],
    "breeze/main-breeze.js": ['const py = quietPython(pyExe);'],
    "music3/main-music3.js": ['const py = quietPython(pyExe);'],
    "yue/main-yue.js": ['const py = quietPython(pyExe);', 'return fs.existsSync(py) ? quietPython(py) : "";'],
    "sensenova/main-sensenova.js": ['return fs.existsSync(py) ? quietPython(py) : "";'],
    "h3/main-h3.js": [
      'const py = quietPython(pyExe);',
      'return fs.existsSync(py) ? quietPython(py) : "";',
      'return quietPython(join(c, "venv", "Scripts", "python.exe"));',
    ],
  };
  for (const [f, marks] of Object.entries(PY_WIRING)) {
    const src = read(f);
    has(src, 'require("../backend-python.js")', f + " require 统一口径模块");
    for (const m of marks) has(src, m, f + " 走 quietPython：" + m);
    hasnt(
      src,
      'const py = join(installDir, ".venv", "Scripts", "python.exe");',
      f + " 不再把 venv python.exe 直接当后端起进程（旧写法会弹终端窗）",
    );
  }
  hasnt(
    read("h3/main-h3.js"),
    'const py = join(comfy, "venv", "Scripts", "python.exe");',
    "h3/main-h3.js 起 ComfyUI 也不再直接用 venv python.exe",
  );
  hasnt(
    read("remotion/main-remotion.js"),
    'Scripts", "python.exe"',
    "Remotion（node 后端，无常驻 python）不掺和解释器口径",
  );
  has(read("guides/manual/media-gen.md"), "pythonw", "手册写明后端用 pythonw 静默拉起（不留终端窗）");
  /* 后端自己无控制台后，它拉起的子进程（nvidia-smi / tasklist / taskkill / ffmpeg / pip）若不显式
     要 CREATE_NO_WINDOW，Windows 会给它们各新建一只终端窗口 —— 探一次显存就闪一下。这里一律钉住。 */
  const PACK_PY = [
    "breeze-pack/app/server.py",
    "breeze-pack/app/audio.py",
    "breeze-pack/app/engine.py",
    "h3-pack/app/__main__.py",
    "llama-pack/app/gpu.py",
    "llama-pack/app/models.py",
    "tts-pack/app/gpu.py",
    "tts-pack/app/server.py",
    "tts-pack/app/tts.py",
    "tts-pack/app/train.py",
  ];
  const packBad = [];
  for (const f of PACK_PY) {
    const src = read(f);
    const re = /subprocess\.(run|check_output|Popen|call)\(/g;
    let m;
    while ((m = re.exec(src))) {
      const seg = src.slice(m.index, m.index + 500);
      if (seg.indexOf("creationflags") >= 0 || seg.indexOf("**kwargs") >= 0) continue;
      if (seg.slice(0, 200).indexOf("lsof") >= 0) continue; /* POSIX 专用分支，Windows 上不跑 */
      packBad.push(f + " 第 " + src.slice(0, m.index).split("\n").length + " 行");
    }
  }
  ok(
    packBad.length === 0,
    "包内 subprocess 一律带 creationflags（无控制台的父进程别让子进程新建控制台）" +
      (packBad.length ? "（漏：" + packBad.join("、") + "）" : ""),
  );

  console.log(
    "\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks",
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

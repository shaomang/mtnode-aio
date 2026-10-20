"use strict";
/* 插件界面内嵌 console + 「插件不再呼出独立的后端窗口」的回归
 *   node test/smoke-plugin-console.js
 *
 * 锁住本轮共识（7 个本地后端插件一次改齐：music3 / yue2 / sensenova / h3 / llama /
 * breeze / remotion）：
 *   1. 卡片三颗按钮 = 安装 / 启用 / 控制台（本轮需求）：
 *      · 「安装」常驻 —— 未装 = 「安装」，已装 = 「重装」，两者都只是那只安装窗的入口；
 *      · 「启用」**只在已安装时出现**（<api>Start / <api>Stop）—— 点「启用」只是静默后台拉起后端
 *        （后端进程本来就 windowsHide，stdout 落日志文件），运行中那颗按钮显示「停用」，再点一次 = 停用；
 *        未安装时卡片上只有「安装」+「控制台」两颗。
 *   2. 「控制台」常驻（<api>Open）：那只独立窗仍保留（安装 / 卸载 / H3 工作流编辑器等重功能
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

/* 顶层 const 的对象字面量（PLUGIN_ACT_SVG / BACKEND_PLUGIN_SPECS 这类「表」）按名字抠出来 */
function constBlock(src, name) {
  const at = src.indexOf("const " + name + " = {");
  if (at < 0) throw new Error("找不到常量：" + name);
  return src.slice(at, src.indexOf("\n};", at) + 3);
}
/* 迷你 DOM（与 smoke-trajectory-view.js 同思路：只实现卡片真用到的那几个方法） */
function mkCardEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    attrs: {},
    _cls: "",
    _text: "",
    _html: "",
    title: "",
    disabled: false,
    parentNode: null,
    addEventListener() {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k]; },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    /* 与 DOM 同口径：childElementCount 就是子元素个数（卡片「骨架先画」靠它判断动作行空不空） */
    get childElementCount() { return el.children.length; },
    querySelector(sel) {
      const want = String(sel).replace(/^\[|\]$/g, "");
      const walk = (n) => {
        for (const c of n.children) {
          if (want === c.className || (c.attrs && c.attrs[want] !== undefined)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    },
  };
  Object.defineProperty(el, "className", { get: () => el._cls, set: (v) => { el._cls = String(v); } });
  Object.defineProperty(el, "textContent", { get: () => el._text, set: (v) => { el._text = String(v); el.children.length = 0; } });
  /* 与 DOM 同口径：innerHTML = "" 会清掉原有子节点（卡片「骨架先画 → 状态回来整行重画」
     正是靠它清场；桩不照这个行为，断言就会看到骨架 + 终态两套按钮叠在一起） */
  Object.defineProperty(el, "innerHTML", {
    get: () => el._html,
    set: (v) => {
      if (!v) el.children.length = 0;
      el._html = String(v);
    },
  });
  return el;
}
/* ═══════ 真跑一遍共用卡片：把 refreshBackendPluginCard 拉进沙箱（配最小 DOM 与桥桩）═══════
   卡片的按钮口径（本轮需求：三颗按钮 = 安装 / 启用 / 控制台）靠「按状态建哪几颗」说话：
   光扫源码字符串看不出「未安装时到底建没建启用那颗」，所以这里真跑 —— async 函数 +
   await statusFn，断言看得见按钮清单本身（文案 / 置灰 / 图标）。 */
async function runBackendCard(st, spec, opts, sets) {
  const src = read("renderer/app-plugins.js");
  const code =
    constBlock(src, "PLUGIN_ACT_SVG") + "\n" +
    constBlock(src, "BACKEND_PLUGIN_SPECS") + "\n" +
    constBlock(src, "BACKEND_INSTALL_IDS") + "\n" +
    fnBody(src, "mkPluginActBtn") + "\n" +
    fnBody(src, "pluginErrText") + "\n" +
    fnBody(src, "setPluginVer") + "\n" +
    fnBody(src, "pluginVerLabel") + "\n" +
    fnBody(src, "pluginApiFn") + "\n" +
    fnBody(src, "pluginLoc") + "\n" +
    fnBody(src, "refreshBackendPluginCard");
  const api = {};
  api[spec.api + "Status"] = async () => st;
  api[spec.api + "Start"] = async () => ({ ok: true });
  api[spec.api + "Stop"] = async () => ({ ok: true });
  api[spec.api + "Open"] = async () => ({ ok: true });
  const windowStub = { api };
  const documentStub = { createElement: (t) => mkCardEl(t) };
  const i18nStub = { t: (s) => String(s) };
  const fn = new Function(
    "window,document,I18n,toast,_backendStarting,_backendStopping,_backendLastErr,_plugRoots,plugRootWarn,plugInstallDir,openPluginInstallWindow",
    code + "\nreturn refreshBackendPluginCard;",
  )(
    windowStub,
    documentStub,
    i18nStub,
    () => {},
    sets.starting,
    sets.stopping,
    new Map(),
    new Map(),
    () => {},
    async () => ({ ok: true, dir: "C:\\x", sub: "s" }),
    async () => ({ ok: true }),
  );
  const root = mkCardEl("div");
  const actions = mkCardEl("div");
  actions.className = "plugin-tile-actions";
  actions.setAttribute("data-plugin-actions", "1");
  root.appendChild(actions);
  await fn(root, spec, opts || {});
  const btns = actions.children.map((b) => ({
    title: b.title,
    disabled: !!b.disabled,
    hasIcon: !!b.innerHTML,
    cls: b.className,
  }));
  /* root 里**除了动作区不能再长出任何节点**（本轮需求：卡片底部一个字的正文都不留）。
     返回 textNodes 供用例断言「卡片这次重绘没有往卡片上写文字」。 */
  const textNodes = root.children
    .filter((c) => c !== actions)
    .map((c) => (c.attrs && c.attrs["data-plugin-progress-txt"] !== undefined ? "progress-txt" : c.className || c.tagName));
  return { btns, labels: btns.map((b) => b.title + (b.disabled ? "（置灰）" : "")), icons: btns.map((b) => b.hasIcon), textNodes };
}

/* 7 个本地后端插件：kind → { api 前缀, 宿主文件, 宿主 IPC 前缀 } */
const PLUGINS = {
  music3: { api: "music3", host: "music3/main-music3.js", ipc: "music3" },
  yue2: { api: "yue2", host: "yue/main-yue.js", ipc: "yue" },
  sensenova: { api: "sensenova", host: "sensenova/main-sensenova.js", ipc: "sensenova" },
  h3: { api: "h3", host: "h3/main-h3.js", ipc: "h3" },
  llama: { api: "llama", host: "llama/main-llama.js", ipc: "llama" },
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
  breeze: ["Start", "Stop", "Install", "PickInstallDir", "Open", "ConsoleTail"],
  remotion: ["Install", "PickInstallDir", "Open", "ConsoleTail"],
};
const TAIL_BRIDGE = {
  music3: "music3ConsoleTail",
  yue2: "yue2ConsoleTail",
  sensenova: "sensenovaConsoleTail",
  h3: "h3ConsoleTail",
  llama: "llamaConsoleTail",
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
  /* 本轮需求：卡片三颗按钮 = 安装 / 启用 / 控制台 —— 启停那一颗改用电源图标（open = 已启用） */
  has(svgTable, "power:", "PLUGIN_ACT_SVG 有「启用 / 停用」共用的电源图标 power");
  const usedKinds = [...new Set([...backendCard.matchAll(/addBtn\("([a-z]+)"/g)].map((m) => m[1]))];
  ok(
    usedKinds.length > 0 && usedKinds.every((k) => svgTable.indexOf(k + ":") >= 0),
    "共用卡片用到的图标全在 PLUGIN_ACT_SVG 里（" + usedKinds.join("/") + "）",
  );
  has(backendCard, 'spec.startFn || spec.api + "Start"', "主按钮调 <api>Start（静默后台拉起后端；个别插件可用 startFn 覆盖）");
  has(backendCard, 'spec.stopFn || spec.api + "Stop"', "主按钮调 <api>Stop（停止 = 停后端；个别插件可用 stopFn 覆盖）");
  has(backendCard, 'pluginApiFn(spec.api + "Open")', "次按钮调 <api>Open（控制台 = 显式开窗）");
  has(backendCard, 'I18n.t("启用")', "启用那一颗按钮文案「启用」");
  has(backendCard, 'I18n.t("停用")', "已启用时同一颗按钮显示「停用」");
  has(backendCard, 'I18n.t("控制台")', "第三颗按钮文案「控制台」");
  has(backendCard, 'I18n.t("启用中…（首次加载模型可能几分钟）")', "启用中那颗按钮置灰并说明原因");
  has(backendCard, 'I18n.t("停用中…")', "停用过程同样在按钮上写明状态");
  hasnt(backendCard, 'I18n.t("运行")', "共用卡片里不再有「运行 = 开窗」那套文案");
  hasnt(backendCard, 'I18n.t("打开控制台")', "共用卡片里不再有「打开控制台」当主按钮");
  /* 本轮需求：三颗按钮的建法 —— 安装常驻、启用只在已安装时建、控制台常驻 */
  has(backendCard, 'if (!st.installed) {', "安装常驻：未装 = 主按钮「安装」");
  has(backendCard, 'addBtn("download", reinstallLabel || I18n.t("重装"), installBackend);', "已装时那颗按钮变「重装」（仍是安装窗入口）");
  has(backendCard, 'if (st.installed && spec.hasService && (!spec.serviceWhen || spec.serviceWhen(st))) {', "「启用」只在已安装（且有常驻后端、且插件没否决）时出现 —— 未安装时整颗不建");
  has(backendCard, 'addBtn("power", title, running ? stopBackend : startBackend, {', "启停是同一颗按钮：未启用点它 = 启用，运行中点它 = 停用");
  has(backendCard, "disabled: starting || stopping", "启停过程中那颗按钮置灰（免得连点出第二次启停）");
  has(backendCard, "_backendStarting", "启动中状态按插件记账（跨重绘保留）");
  has(backendCard, "_backendStopping", "停止中状态同样按插件记账（按钮据此置灰）");
  has(backendCard, "_backendLastErr", "启动 / 安装失败仍记账（用户可见出口 = toast + 浮层日志，不静默）");
  /* 本轮需求：卡片底部不许再出现任何文字 —— 状态文字行与「后端提示」角标整块下线 */
  hasnt(pluginsSrc, "function backendCardLine(", "卡片状态文字行 backendCardLine 已删除");
  hasnt(pluginsSrc, "function setPluginNotice(", "卡片角标绘制 setPluginNotice 已删除");
  hasnt(pluginsSrc, "plugin-tile-notice", "卡片壳里不再有角标元素");
  hasnt(pluginsSrc, "data-plugin-progress-txt", "卡片壳里不再有状态文字行元素");
  hasnt(pluginsSrc, "data-pet-progress-txt", "桌宠那条状态行元素也一并删除");
  hasnt(pluginsSrc, "progTxt", "再无任何往卡片状态行写字的代码路径");

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
  /* 本轮需求：清除日志 = **真清除**（清宿主日志文件，不是只清显示） */
  has(popConsole, 'pluginApiFn(spec.api + "ConsoleClear")', "「清屏」走 <api>ConsoleClear（真清日志文件）");
  has(popConsole, "lastTail = \"\"", "清屏同时丢弃本地已聚合的正文与游标（关浮层再开不回填旧日志）");
  hasnt(popConsole, "只看此刻之后的新行", "不再有「只清显示、文件不动」的旧口径");
  /* 安装进度一律不上卡片：进度条元素与 bind*Progress 都已下线，改由安装窗显示 */
  hasnt(pluginsSrc, 'data-plugin-progress"', "卡片壳里不再有安装进度条元素");
  hasnt(backendCard, 'I18n.t("安装中…")', "卡片状态行不再有「安装中…」");
  hasnt(backendCard, 'I18n.t("更新中…")', "卡片状态行不再有「更新中…」");
  hasnt(backendCard, "prog.style.display", "共用卡片不再画进度条");
  for (const name of [
    "bindMusic3Progress",
    "bindYueProgress",
    "bindSensenovaProgress",
    "bindH3Progress",
    "bindRemotionProgress",
    "bindLlamaProgress",
    "bindBreezeProgress",
    "bindTtsProgress",
    "bindPluginProgress",
  ]) {    hasnt(pluginsSrc, "function " + name + "(", "app-plugins.js 不再有 " + name + "（安装进度不上卡片）");
  }
  has(pluginsSrc, "function repaintPluginCard(", "有统一的卡片重画入口（安装跑完重画用）");
  /* 本轮需求：重画分派表必须覆盖**每一个后端 kind**（paseo 曾漏过 → 装完卡片被画成窗口插件那套） */
  {
    const seg = pluginsSrc.slice(
      pluginsSrc.indexOf("function repaintPluginCard("),
      pluginsSrc.indexOf("async function refreshWindowPluginCard("),
    );
    for (const k of [...Object.keys(PLUGINS), "paseo"]) {
      has(seg, k + ": refresh", "重画分派表登记了 kind " + k + "（漏一个就会被画成窗口插件）");
    }
    hasnt(seg, "paseo: refreshWindowPluginCard", "paseo 不走窗口插件兜底分支");
  }
  /* 本轮需求：先画骨架、再补状态 —— 状态查询要起外部进程（paseo 最慢），等它回来才画按钮就是
     「打开插件窗先没有按钮，过几秒才出来」的现场 */
  {
    const skeletonAt = backendCard.indexOf("actions.childElementCount");
    const awaitAt = backendCard.indexOf("await statusFn()");
    ok(
      skeletonAt > 0 && awaitAt > skeletonAt,
      "骨架先画：动作行空着时先画「控制台 + 灰态安装占位」，再去 await 状态",
    );
    has(backendCard, 'I18n.t("正在读取插件状态…")', "占位那颗写明「正在读取插件状态…」（工具提示说清为什么不可点）");
    has(backendCard, 'mkPluginActBtn("console", I18n.t("控制台"), openConsole)', "控制台那颗立刻可用（与状态无关，不等查询）");
    has(backendCard, "disabled: true", "占位那颗置灰不可点（状态没回来之前不假装能装）");
    has(backendCard, 'actions.innerHTML = ""', "状态回来后整行重画成最终形态（骨架不残留）");
  }
  has(pluginsSrc, "onMtnodeInstallFinished", "插件对话框订阅「安装窗跑完」事件并重画卡片");
  has(preloadSrc, "onMtnodeInstallFinished:", "preload 暴露安装终局订阅 mtnodeInstall:finished");
  has(pluginsSrc, 'I18n.t("后端运行中")', "状态行写「后端运行中」");
  has(pluginsSrc, 'I18n.t("后端未运行")', "状态行写「后端未运行」");
  has(pluginsSrc, "mountPluginPopConsole(pop, item)", "详情浮层挂上 console 区块");

  /* ═════════ [3] preload 桥 ⇄ 宿主 handle / 事件成对 ═════════ */
  console.log("\n[3] preload.js：8 个 ConsoleTail / ConsoleClear 桥 + 3 个 Notice 订阅，与宿主一一成对");
  for (const [k, m] of Object.entries(TAIL_BRIDGE)) {
    const p = PLUGINS[k];
    has(preloadSrc, m + ":", "preload 暴露 " + m);
    has(
      read(p.host),
      'ipcMain.handle("' + p.ipc + ':consoleTail"',
      p.host + " 注册 " + p.ipc + ":consoleTail",
    );
    has(preloadSrc, "'" + p.ipc + ":consoleTail'", m + " 转发到 " + p.ipc + ":consoleTail");
    /* 清空日志：桥 + 宿主 handle + 真 truncate（三个都钉住，免得退回「只清显示」） */
    has(preloadSrc, p.api + "ConsoleClear:", "preload 暴露 " + p.api + "ConsoleClear");
    has(preloadSrc, "'" + p.ipc + ":consoleClear'", p.api + "ConsoleClear 转发到 " + p.ipc + ":consoleClear");
    const hostSrc = read(p.host);
    has(hostSrc, 'ipcMain.handle("' + p.ipc + ':consoleClear"', p.host + " 注册 " + p.ipc + ":consoleClear");
    has(hostSrc, "function clearConsoleLog(", p.host + " 有 clearConsoleLog（真清日志文件）");
    ok(
      /clearConsoleLog[\s\S]{0,600}(writeFileSync\(p,\s*""|truncateSync\(p,\s*0)/.test(hostSrc),
      p.host + " 把日志清到 0 字节（truncate / 空写，保留文件与运行中后端的句柄）",
    );
    has(hostSrc, '"' + p.ipc + ':consoleCleared"', p.host + " 广播 " + p.ipc + ":consoleCleared（打开着的日志窗就地清空）");
  }
  /* 求助通知：只有带 ui-signal 的两个宿主有这条事件通道（tts 已随该插件移除） */
  for (const [k, api] of [["llama", "llama"], ["breeze", "breeze"]]) {
    const p = PLUGINS[k];
    has(preloadSrc, "on" + api[0].toUpperCase() + api.slice(1) + "Notice:", "preload 暴露 on" + api[0].toUpperCase() + api.slice(1) + "Notice");
    has(read(p.host), 'broadcast("' + api + ':notice"', p.host + " 广播 " + api + ":notice");
    has(pluginsSrc, "on" + api[0].toUpperCase() + api.slice(1) + "Notice", "插件卡片订阅 " + api + ":notice");
  }
  hasnt(preloadSrc, "llamaNoticeRaw:", "没有多余的 llama notice 旁路桥");

  /* ═════════ [4] 两个宿主：ui-signal 不再自动开窗 ═════════ */
  console.log("\n[4] llama / breeze：后端求助不再自动弹出控制台窗");
  for (const [k, api] of [["llama", "llama"], ["breeze", "breeze"]]) {
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
  /* 目录口径本轮改了（插件根目录）：卡片不再先弹系统目录框，而是问「这次该装到哪」——
     插件自己设过 installDir 就用它，没设过 = 插件根目录 + 默认子目录名；根目录没设 → need_root 提示。
     系统目录框（<api>PickInstallDir）仍在，由安装窗 / 控制台里的「选择安装目录」用。 */
  has(pluginsSrc, "const target = await plugInstallDir(id);", "卡片「安装」先问这次该装到哪（plugInstallDir）");
  has(pluginsSrc, 'target.error === "need_root"', "根目录没设时先提示去设置（不弹系统目录框、不开始安装）");
  has(pluginsSrc, "appPluginsInstallDirOf", "该插件的目录口径走主进程桥 appPluginsInstallDirOf");
  has(preloadSrc, "appPluginsRootStatus:", "preload 暴露插件根目录现状桥 appPluginsRootStatus");
  has(preloadSrc, "appPluginsRootPick:", "preload 暴露插件根目录选择桥 appPluginsRootPick");
  has(pluginsSrc, "function buildPlugRootBar()", "插件对话框顶部有「插件根目录」那一行");
  /* 本轮共识：安装不再在卡片上静默跑，一律开那只独立安装窗（逐步骤 + 失败定位 + 会话修复）。
     桥仍在（安装窗经 mtnodeInstall:api 白名单转调它们），所以这里钉的是**入口口径**。 */
  has(
    pluginsSrc,
    'await openPluginInstallWindow({ id, action: "install", installDir: target.dir })',
    "卡片「安装 / 重装」改为开独立安装窗（并把解析好的安装目录带过去）",
  );
  has(pluginsSrc, "BACKEND_INSTALL_IDS", "卡片知道每个后端插件在安装窗里的 id（id 与 kind 分开维护）");
  has(preloadSrc, "mtnodeInstallOpen:", "preload 暴露安装窗入口 mtnodeInstallOpen");
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
    ["启用", "Enable"],
    ["启用", "Enable"],
    ["停用", "Disable"],
    ["启用中…（首次加载模型可能几分钟）", "Enabling… (the first model load can take minutes)"],
    ["停用中…", "Disabling…"],
    ["控制台", "Console"],
    ["重装", "Reinstall"],
    ["后端提示", "Backend notice"],
    ["后端运行中", "Backend running"],
    ["后端未运行", "Backend stopped"],
    ["清屏", "Clear"],
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
  has(
    bpSrc,
    "module.exports = { quietPython, pythonHealth, pyvenvCfgPath, shimsDir, silentEnv, syncShims }",
    "backend-python.js 导出 quietPython + pythonHealth + 静默三项（shimsDir / silentEnv / syncShims）",
  );
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
  /* 6 个起 python 后端的宿主：都走统一口径（tts 已随该插件移除） */
  const PY_WIRING = {
    "llama/main-llama.js": ['const py = quietPython(pyExe);'],
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

  /* ═════════ [9] 整条子进程子树的静默：sitecustomize 垫片 + PYTHONPATH ═════════
     [8] 只管住「后端自己那只解释器」；引擎里的第三方调用（ffmpeg-python / uvr5
     的 os.system、ComfyUI 装依赖）我们改不了源码，只能在进程级补默认标志。真枚举窗口的断言在
     test/smoke-console-silent.js（那条要真跑 pythonw），这里钉接线与随包口径。 */
  console.log("\n[9] 整条子树静默：pack-shims/sitecustomize.py + 宿主 PYTHONPATH");
  const SHIM_SRC = "pack-shims/sitecustomize.py";
  has(read(SHIM_SRC), "_CREATE_NO_WINDOW = 0x08000000", "垫片真源定义 CREATE_NO_WINDOW");
  has(read(SHIM_SRC), 'sys.platform == "win32"', "垫片只在 win32 生效");
  const { silentEnv, shimsDir, syncShims } = require("../backend-python.js");
  ok(
    silentEnv("C:/x/tts", { PYTHONPATH: "C:/old" }).PYTHONPATH === shimsDir("C:/x/tts") + path.delimiter + "C:/old",
    "silentEnv 把 <installDir>/shims 挂在 PYTHONPATH 最前（不动原有值）",
  );
  ok(silentEnv("", {}).PYTHONPATH === undefined, "installDir 为空时不乱塞 PYTHONPATH");
  const smTmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-sync-shims-"));
  fs.mkdirSync(path.join(smTmp, "pack", "shims"), { recursive: true });
  fs.writeFileSync(path.join(smTmp, "pack", "shims", "sitecustomize.py"), "stub");
  fs.mkdirSync(path.join(smTmp, "install"), { recursive: true });
  const smRes = syncShims(path.join(smTmp, "pack"), path.join(smTmp, "install"));
  ok(
    smRes.ok && smRes.copied === 1 && fs.existsSync(path.join(smTmp, "install", "shims", "sitecustomize.py")),
    "syncShims 真把 pack 的 shims/ 拷进安装目录（h3 / music3 / yue 只挑着拷 app/*.py，靠这一句补齐）",
  );
  const SILENT_WIRING = {
    "h3/main-h3.js": true,
    "music3/main-music3.js": true,
    "yue/main-yue.js": true,
    "breeze/main-breeze.js": true,
    "llama/main-llama.js": true,
    "sensenova/main-sensenova.js": true,
  };
  for (const f of Object.keys(SILENT_WIRING)) {
    const src = read(f);
    has(src, "silentEnv(", f + " 起后端时把 shims 挂上 PYTHONPATH（整条子树静默）");
    has(src, "silentEnv", f + " 从 backend-python.js 取静默口径（不各写一份）");
  }
  /* pack 副本必须与真源逐字节一致（同 pack-steps/step.ps1 的「真源 + 各包副本」约定） */
  const ROOTDIR = path.join(__dirname, "..");
  const shimBytes = fs.readFileSync(path.join(ROOTDIR, SHIM_SRC));
  const shimDiff = [];
  for (const rel of ["h3-pack", "music3-pack", "yue-pack", "breeze-pack", "llama-pack", "sensenova-pack"]) {
    const p = path.join(ROOTDIR, rel, "shims", "sitecustomize.py");
    if (!fs.existsSync(p) || !fs.readFileSync(p).equals(shimBytes)) shimDiff.push(rel);
  }
  ok(shimDiff.length === 0, "6 个 pack 的 shims/sitecustomize.py 与真源逐字节一致" + (shimDiff.length ? "（不一致：" + shimDiff.join("、") + "）" : ""));
  has(read("build.json"), '"shims/**"', "build.json 的 pack 白名单里有 shims/**（随包分发，否则打包后垫片不到位）");
  has(read("guides/manual/media-gen.md"), "sitecustomize", "手册写明整条子树静默的机制（sitecustomize 垫片）");
  has(read("backend-python.js"), "pythonw", "解释器口径真源写明 pythonw（安装链 / 运行期同一条链）");

  /* ═════════ [9.2] 安装链静默：宿主起安装 PowerShell 时不许弹出控制台窗 ═════════
     宿主直接创建的那只 powershell.exe 靠 spawn 的 windowsHide: true（= CREATE_NO_WINDOW）压住；
     它拉起的子孙（pip / git / py）继承宿主给的那份 env（含 PYTHONPATH 上的 shims），
     由垫片在解释器启动时再补 CREATE_NO_WINDOW —— 整条安装链同样不冒窗口。
     口径真源见 docs/plugin-install-window.md；此处只钉「每个 Python 宿主都走 runPs + windowsHide」。 */
  const RUNPS_HOSTS = [
    "llama/main-llama.js",
    "breeze/main-breeze.js",
    "h3/main-h3.js",
    "music3/main-music3.js",
    "sensenova/main-sensenova.js",
  ];
  for (const rel of RUNPS_HOSTS) {
    const src = read(rel);
    has(src, "function runPs(", rel + " 有统一的安装脚本 spawn 路径 runPs");
    const at = src.indexOf("function runPs(");
    const seg = src.slice(at, at + 900);
    has(seg, "windowsHide: true", rel + " 的 runPs 用 windowsHide 起 powershell（宿主自己那只不留窗）");
  }
  for (const rel of ["breeze-pack", "sensenova-pack", "yue-pack", "h3-pack", "music3-pack", "llama-pack"]) {
    has(
      read(rel + "/scripts/install.ps1"),
      ".install-ok",
      rel + "/scripts/install.ps1 只在整链跑通后才写 .install-ok（失败项自己 Step-Fail）",
    );
  }

  /* ═════════ [10] 解释器体检：基座被删的 venv 不许 spawn（否则弹「Python Launcher … No Python at …」） ═════════
     现场：用户手工删掉 conda 环境（C:\ProgramData\miniconda3\envs\seg）后，用它的基座建的 venv
     （music / video(ComfyUI) / yue2）里那只 pythonw.exe 只是 venv 重定向器 —— 每次 spawn 都按
     pyvenv.cfg 找基座，找不到就弹一只模态消息框（GUI 子系统 ⇒ MessageBox）。体检 = 起进程前的唯一闸门。 */
  console.log("\n[10] 解释器体检：venv 基座被删不许 spawn（Python Launcher 消息框）");
  const { pythonHealth } = require("../backend-python.js");
  const hpTmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-python-health-"));
  const mkPy = (p) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "stub"); /* 268KB 重定向器只要「小文件」，内容无关 */
    return p;
  };
  const mkVenv = (name, home, opts) => {
    const o = opts || {};
    const venv = path.join(hpTmp, name);
    const exe = mkPy(path.join(venv, "Scripts", "pythonw.exe"));
    fs.writeFileSync(
      path.join(venv, "pyvenv.cfg"),
      "home = " + home + "\r\ninclude-system-site-packages = false\r\nversion = 3.10.16\r\n",
    );
    if (o.copy) fs.writeFileSync(exe, Buffer.alloc(2 * 1024 * 1024, 32)); /* --copies 的真解释器副本 */
    return exe;
  };
  /* 正常 venv：基座还在 → 放行 */
  const goodBase = path.join(hpTmp, "base-ok");
  mkPy(path.join(goodBase, "pythonw.exe"));
  const goodVenv = mkVenv("venv-ok", goodBase);
  ok(pythonHealth(goodVenv).ok === true, "基座还在的 venv → 放行（bad=null 不拦）");
  /* 基座被删（正是本次现场）→ 判死，且报出那个不存在的基座路径 */
  const goneBase = path.join(hpTmp, "conda-envs", "seg");
  const deadVenv = mkVenv("venv-stale", goneBase);
  const dead = pythonHealth(deadVenv);
  ok(dead.ok === false && dead.code === "stale_venv", "基座被删的 venv → stale_venv（不再 spawn）");
  ok(
    dead.base === path.join(goneBase, "pythonw.exe"),
    "报出的就是重定向器要找的那个基座（与消息框里 No Python at '…' 同路径）",
  );
  has(dead.message, "重装", "话术给出可执行出路（在插件安装窗重装）");
  /* 解释器本身没了 */
  ok(pythonHealth(path.join(hpTmp, "nope", "pythonw.exe")).code === "missing", "解释器文件不存在 → missing");
  /* 真解释器副本（--copies）：基座没了也照样能跑 ⇒ 不许误判 */
  const copyVenv = mkVenv("venv-copies", goneBase, { copy: true });
  ok(pythonHealth(copyVenv).ok === true, ">1MB 的真解释器副本（--copies）不按重定向器判死");
  /* 非 venv 布局 / PATH 裸名 / 空值：一律放行（体检只拦「一定会弹框」那一种） */
  const plainPy = mkPy(path.join(hpTmp, "plain", "python.exe"));
  ok(pythonHealth(plainPy).ok === true, "没有 pyvenv.cfg 的解释器 → 放行");
  ok(pythonHealth("pythonw").ok === true, "PATH 裸名（python / pythonw）→ 放行（不查 PATH 猜存在）");
  ok(pythonHealth("").ok === true, "空路径 → 放行（上游自己处理空值）");
  /* 接线：7 个起后端的宿主都在 spawn 前体检 */
  for (const f of Object.keys(SILENT_WIRING)) {
    const src = read(f);
    has(src, "pythonHealth", f + " 取到体检真源（backend-python.js）");
    has(src, 'const pyBad = pythonHealth(py);', f + " 起后端前先体检（坏了不 spawn）");
    has(src, '"stale_python"', f + " 体检失败以 stale_python 上报（不 spawn、不弹框）");
  }
  const h3Src = read("h3/main-h3.js");
  const h3Guards = (h3Src.match(/pythonHealth\(/g) || []).length;
  ok(
    h3Guards >= 6,
    "h3 的每条起 python 的路都挂上体检（健康检查 / Sage 探针 / pip 补装 / 后处理超分补帧 / 起 ComfyUI，实到 " +
      h3Guards +
      " 处)",
  );
  has(h3Src, "stale_python", "h3 的 Sage 缺包话术认得 stale_python 并指向重装");
  has(read("yue/main-yue.js"), "const bad = pythonHealth(exe);", "yue 探针 / 转码（runExe）先体检");
  has(read("sensenova/main-sensenova.js"), "const bad = pythonHealth(exe);", "sensenova 依赖自检（runExe）先体检");
  has(
    read("backend-python.js"),
    "Python Launcher",
    "根因口径记下 venv 重定向器那只消息框（与终端窗同一份「静默」口径）",
  );

  /* ═════════ [11] 三颗按钮的建法真跑一遍（安装 / 启用 / 控制台） ═════════
     本轮需求：插件界面三颗按钮 —— 安装常驻、启用只在已安装时出现、控制台常驻。
     这里不只是扫源码：把 refreshBackendPluginCard 拉进沙箱真跑（最小 DOM + 桥桩），
     断言看得见按钮清单本身（建了几颗 / 文案 / 置灰 / 图标），见 runBackendCard。 */
  console.log("\n[11] 卡片三颗按钮：未装 = 安装+控制台，装好才出现「启用」");
  const LLAMA_SPEC = { key: "llama", api: "llama", hasService: true };
  const REMOTION_SPEC = { key: "remotion", api: "remotion", hasService: false };
  const mkSets = () => ({ starting: new Set(), stopping: new Set() });

  let card = await runBackendCard({ installed: false, running: false, wantRunning: false }, LLAMA_SPEC, {}, mkSets());
  ok(
    card.labels.length === 2 && card.labels[0] === "安装" && card.labels[1] === "控制台",
    "未安装：只有「安装」+「控制台」（实到 " + JSON.stringify(card.labels) + "）",
  );
  ok(card.labels.join("|").indexOf("启用") < 0, "未安装：「启用」整颗不建");
  ok(card.icons.every(Boolean), "未安装那两颗都有图标（取自 PLUGIN_ACT_SVG）");

  card = await runBackendCard({ installed: true, running: false, wantRunning: false }, LLAMA_SPEC, {}, mkSets());
  ok(
    card.labels.length === 3 && card.labels[0] === "重装" && card.labels[1] === "启用" && card.labels[2] === "控制台",
    "已安装：三颗 = 安装(重装) / 启用 / 控制台（实到 " + JSON.stringify(card.labels) + "）",
  );
  ok(card.icons.every(Boolean), "三颗按钮都有图标");
  ok(/plugin-act/.test(card.btns[1].cls) && / primary/.test(card.btns[1].cls), "未启用时「启用」是主按钮");

  card = await runBackendCard({ installed: true, running: true, wantRunning: true }, LLAMA_SPEC, {}, mkSets());
  ok(card.labels[1] === "停用", "运行中：同一颗按钮显示「停用」（实到 " + JSON.stringify(card.labels) + "）");
  ok(/\bon\b/.test(card.btns[1].cls), "运行中：「停用」高亮（on）");

  const setsStop = mkSets();
  setsStop.stopping.add("llama");
  card = await runBackendCard({ installed: true, running: true, wantRunning: true }, LLAMA_SPEC, {}, setsStop);
  ok(card.labels[1] === "停用中…（置灰）", "停用过程：「停用中…」那颗置灰（实到 " + JSON.stringify(card.labels) + "）");

  const setsStart = mkSets();
  setsStart.starting.add("llama");
  card = await runBackendCard({ installed: true, running: false, wantRunning: false }, LLAMA_SPEC, {}, setsStart);
  ok(
    card.labels[1] === "启用中…（首次加载模型可能几分钟）（置灰）",
    "启用过程：「启用中…」那颗置灰并说明原因（实到 " + JSON.stringify(card.labels) + "）",
  );

  card = await runBackendCard({ installed: true }, REMOTION_SPEC, { reinstallLabel: "重装" }, mkSets());
  ok(
    card.labels.length === 2 && card.labels.join("|").indexOf("启用") < 0,
    "Remotion（无常驻后端）：只有「重装」+「控制台」，没有「启用」（实到 " + JSON.stringify(card.labels) + "）",
  );

  /* ═════════ [12] 本轮需求：卡片底部不许再出现任何文字 ═════════
     把几种「以前会往卡片状态行写字的」状态各真跑一遍，断言卡片根节点上
     除了动作按钮区**没有多出任何节点**（runBackendCard 回的是 root.children 里动作区之外的节点）。 */
  console.log("\n[12] 卡片底部无字：任何状态都不再往卡片上长文字行");
  for (const [label, st, sets] of [
    ["普通态", { installed: true, running: false, wantRunning: false }, mkSets()],
    ["启用中", { installed: true, running: false, wantRunning: false }, (() => { const s = mkSets(); s.starting.add("llama"); return s; })()],
    ["停用中", { installed: true, running: true, wantRunning: true }, (() => { const s = mkSets(); s.stopping.add("llama"); return s; })()],
    ["带 notice", { installed: true, running: true, wantRunning: true, notice: "后端自检提示" }, mkSets()],
    ["端口冲突", { installed: true, running: false, wantRunning: false, rootConflict: { port: 8080, liveRoot: "A", configuredRoot: "B" } }, mkSets()],
  ]) {
    const c = await runBackendCard(st, LLAMA_SPEC, {}, sets);
    ok(
      c.textNodes.length === 0,
      label + "：卡片上除动作区外没有任何节点（实到 " + JSON.stringify(c.textNodes) + "）",
    );
  }

  /* ═════════ [13] 本轮需求：信息入口 = 封面右上角 ⓘ（卡片本体不再可点） ═════════
     两条一起钉：① 浮层入口只剩 ⓘ；② 浮层自己多了显式出口（✕ / Esc），
     出口口径与 AGENTS.md 一致（不算「点外部即关」）。 */
  console.log("\n[13] 插件信息入口：封面右上角 ⓘ + 浮层的显式关闭（✕ / Esc）");
  {
    const popSrc = fnBody(pluginsSrc, "openPluginPop");
    has(pluginsSrc, "function mountPluginPopClose(", "有把 ✕ 挂进浮层的唯一入口 mountPluginPopClose");
    has(fnBody(pluginsSrc, "mountPluginPopClose"), "closePluginPop(wrap, pop)", "✕ 只关浮层（不关插件窗）");
    has(fnBody(pluginsSrc, "mountPluginPopClose"), 'I18n.t("关闭")', "✕ 的可读名走 i18n「关闭」");
    ok(
      (popSrc.match(/mountPluginPopClose\(wrap, pop\)/g) || []).length >= 2,
      "两条分支（用户自建插件面板 / 普通插件信息）都挂 ✕",
    );
    const upPanelAt = popSrc.indexOf("renderUserPluginPanel(pop, item)");
    const closeAt = popSrc.indexOf("mountPluginPopClose(wrap, pop)", upPanelAt);
    ok(
      upPanelAt > 0 && closeAt > upPanelAt,
      "自建插件那条分支里 ✕ 挂在那块面板**之后**（面板会清空浮层，先挂就被清掉）",
    );
    /* Esc：先关浮层、再按一次才关插件窗（捕获阶段拦下，别让同一个 Esc 派给画布） */
    has(pluginsSrc, 'document.addEventListener("keydown", onEscKey, true)', "Esc 在捕获阶段接管");
    has(pluginsSrc, 'document.removeEventListener("keydown", onEscKey, true)', "关窗时摘掉 Esc 监听（不留悬挂）");
    const escSrc = pluginsSrc.slice(pluginsSrc.indexOf("const onEscKey = (ev)"), pluginsSrc.indexOf("document.addEventListener(\"keydown\", onEscKey, true)"));
    ok(
      escSrc.indexOf("closePluginPop(wrap, pop)") > 0 && escSrc.indexOf("closeDialog()") > escSrc.indexOf("closePluginPop(wrap, pop)"),
      "浮层开着 → 先关浮层；浮层没开 → 才关插件窗",
    );
    has(pluginsSrc, "function closeDialog()", "插件窗的关闭收口只有一处 closeDialog（底栏「关闭」与 Esc 共用）");
    const dlgSrc = fnBody(pluginsSrc, "openAppPluginsDialog");
    ok(
      !/document\.addEventListener\(\s*"(mousedown|click)"/.test(dlgSrc) &&
        !/window\.addEventListener\(\s*"(mousedown|click)"/.test(dlgSrc),
      "插件窗不挂任何「点外部即关」的监听（对话框一律 persistent）",
    );
    /* 样式与词条 */
    has(cssSrc, ".plugin-tile-info {", "ⓘ 的样式在 layout.css");
    const coverCss = cssSrc.slice(cssSrc.indexOf(".plugin-tile-cover {"), cssSrc.indexOf(".plugin-tile-cover img {"));
    ok(coverCss.indexOf("position: relative;") > 0, "封面是定位上下文（ⓘ 锚在封面右上角）");
    ok(/\.plugin-tile-info\s*\{[^}]*opacity:\s*\.55/.test(cssSrc), "ⓘ 常态半透明（不抢封面）");
    ok(
      /\.plugin-tile:hover \.plugin-tile-info[\s\S]{0,120}opacity:\s*1/.test(cssSrc),
      "悬停卡片时 ⓘ 提亮到不透明",
    );
    ok(/\.plugin-tile-info:focus-visible/.test(cssSrc), "键盘聚焦时同样提亮（Tab 找得到它）");
    has(cssSrc, ".plugin-pop-close {", "浮层 ✕ 的样式在 layout.css");
    has(i18nSrc, '"插件信息": "Plugin info"', "i18n 中英成对：插件信息");
    has(i18nSrc, '"正在读取插件状态…": "Reading plugin status…"', "i18n 中英成对：正在读取插件状态…");
  }

  console.log(
    "\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks",
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

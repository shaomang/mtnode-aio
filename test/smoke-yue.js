"use strict";
/* YuE2 本地音乐生成节点（yue_gen · 插件 yue2-local）的注册与契约回归
 *   node test/smoke-yue.js
 * 与 test/smoke-media-gen-menu.js 同一套路：能用真实函数验的（端子数 / 类型名 / 描边）就从
 * renderer 源码里按名字抠出来在 vm 里真跑，其余（菜单成员、IPC 通道对、打包白名单、插件卡
 * 分支、指南与图标）做源码级契约断言。**不依赖真实后端**：不装环境、不起服务、不生成音频。
 *
 * 锁住的需求（YuE2 节点移植）：
 *   1. 渲染层节点注册点齐全：KIND_CLS / KIND_ICON_SVG / NODE_DEFAULTS / 端子 4 入 2 出
 *   2. 右键「音频生成」子菜单里有 YuE2（夹在 Minimax Music 3 与 SoVITS 语音之间）
 *   3. 执行链：playYueGenNode + 媒体串行链 + 全局音视频锁 + 抽卡种子 + 取消 + 音频输出
 *   4. 端子契约：端口 0/1/2 = 风格 / 歌词 / ABC（只吃文本来源）· 端口 3 = 控制输入
 *   5. 设置表单：思维链档位 / 抽卡 / 种子 / 摇数 / 输出路径 / offload
 *   6. IPC：preload 白名单 ⇄ yue/main-yue.js 的 handle 与事件一一成对；main.js 三处接线
 *   7. 打包与插件：build.json 白名单 / extraResources · catalog 卡片 · 插件卡与自动修复分支
 *   8. i18n 中英词条齐 · 节点指南（中英 + 索引 + 图）齐 · 图标双份
 *   9. 后端契约：yue-pack manifest（id / 端口 / 入口 / 模型）与宿主 Gradio 8 槽调用面
 *
 * 覆盖：
 *   [1] app.js 注册点（真实 inputCount / outputCount / minWFor / nodeKindLabel 在 vm 里跑）
 *   [2] 菜单 / 拖线落点 / 停止 / 迁移
 *   [3] app-nodes.js 执行链与连线规则
 *   [4] app-canvas.js 设置表单与节点体
 *   [5] 全局音视频互斥锁
 *   [6] IPC 通道与 main.js 接线
 *   [7] build.json / 插件目录 / 插件卡 / 自动修复
 *   [8] i18n / 指南 / 图标
 *   [9] yue-pack 与 hosted Gradio 契约
 *  [10] 缺依赖自修复：app/ui.py 守卫 · 宿主 ensurePythonDeps / 报错指纹 · 安装脚本与技能同步
 *  [11] 注意力档位自修复：随包 windows_patch 探针 · 宿主 parseAttentionHint / ensureAttentionBackend
 *       · sync 回执与 runtime 口径 · 安装脚本与技能口径同步
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + show(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + show(needle) + "）"));
};
const uniq = (arr) => [...new Set(arr)];
const sorted = (arr) => arr.slice().sort();
const buildSrc = read("build.json"); /* JSONC（含块注释）：按文本断言，不做 JSON.parse */

/* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (isFn) {
    const i = src.indexOf("{", at);
    if (i < 0) throw new Error("找不到函数体：" + name);
    let depth = 0;
    let inStr = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr) {
        if (c === inStr && p !== "\\") inStr = null;
        continue;
      }
      if (c === "/" && src[j + 1] === "/") {
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数体不完整：" + name);
  }
  const iBrace = src.indexOf("{", at);
  const iBracket = src.indexOf("[", at);
  const start = iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
  if (start < 0) throw new Error("找不到常量体：" + name);
  let depth2 = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "[") depth2++;
    else if (c === "}" || c === "]") {
      depth2--;
      if (!depth2) return src.slice(at, j + 1) + ";";
    }
  }
  throw new Error("常量体不完整：" + name);
}

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");
const canvasSrc = read("renderer/app-canvas.js");
const i18nSrc = read("renderer/i18n.js");
const lockSrc = read("media-gen-global-lock.js");
const preloadSrc = read("preload.js");
const mainSrc = read("main.js");
const hostSrc = read("yue/main-yue.js");
const pluginsMainSrc = read("plugins/main-app-plugins.js");
const appPluginsSrc = read("renderer/app-plugins.js");
const appRepairSrc = read("renderer/app-repair.js");
const catalog = JSON.parse(read("plugins/catalog.default.json"));
const nodeIdx = JSON.parse(read("guides/nodes/index.json"));

/* ---------- [1] 真实函数跑在 vm 里（端子数 / 类型名 / 尺寸按源文件真值验） ---------- */
const SANDBOX_STUBS = {
  I18n: { t: (s) => String(s) },
  /* 只在该 kind 走到对应分支时才会被调；yue_gen 用不到，给安全替身避免 ReferenceError */
  allWiresTo: () => [],
  assetItems: () => [],
  superIsOpenShell: () => false,
  superExternalInWiresAll: () => [],
  superInternalBridgeWiresAll: () => [],
  superExternalOutWiresAll: () => [],
  superInternalOutFeedsAll: () => [],
  superDynamicPortCount: () => 0,
  fnToolParamList: () => [],
  videoGenInputCount: () => 2,
  videoPostInputCount: () => 2,
};
const APP_FNS = [
  "KIND_CLS",
  "KIND_ICON_SVG",
  "nodeKindCls",
  "nodeKindLabel",
  "nodeKindPurposeKey",
  "inputCount",
  "outputCount",
  "minWFor",
  "minHFor",
  "ctrlRoleOf",
  "isExecStart",
  "isExecEnd",
  "isSaveKind",
  "isSaveNode",
  "isToolNode",
  "isFunctionNode",
  "isFnToolNode",
  "isVideoPostKind",
];
const sandbox = Object.assign(
  {
    console,
    Math,
    JSON,
    Set,
    Map,
    WeakMap,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
  },
  SANDBOX_STUBS,
);
vm.createContext(sandbox);
vm.runInContext(APP_FNS.map((n) => fnBody(appSrc, n)).join("\n"), sandbox, {
  filename: "yue-extract.js",
});
const G = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);

/* NODE_DEFAULTS 是数据块（initializer 引用别的常量），按源码文本核对 */
const ndBlock = (() => {
  const at = appSrc.indexOf("const NODE_DEFAULTS = {");
  const end = appSrc.indexOf("\n};", at);
  return at < 0 ? "" : appSrc.slice(at, end);
})();
const yueDefaults = (ndBlock.match(/yue_gen:\s*\{([\s\S]*?)\n  \},/) || [null, ""])[1];

/* ---------------------------------------------------------------- */
(async function main() {
  console.log("\n[ex] 源码抽取自检");
  eqArr(
    APP_FNS.filter((n) => n !== "KIND_CLS" && n !== "KIND_ICON_SVG").filter((n) => typeof G(n) !== "function"),
    [],
    "app.js 目标函数全部抽到真实实现",
  );
  ok(G("KIND_CLS") && typeof G("KIND_CLS") === "object", "KIND_CLS 数据块已抽到");
  ok(G("KIND_ICON_SVG") && typeof G("KIND_ICON_SVG") === "object", "KIND_ICON_SVG 数据块已抽到");

  /* ===================== [1] app.js 注册点 ===================== */
  console.log("\n[1] app.js：节点注册点与端子（真实函数在 vm 里跑）");
  eqStr(G("KIND_CLS").yue_gen, "music", "KIND_CLS.yue_gen 复用音乐族配色（music）");
  const icon = G("KIND_ICON_SVG").yue_gen;
  ok(typeof icon === "string" && icon.indexOf("<svg") === 0 && icon.indexOf("</svg>") > 0, "KIND_ICON_SVG.yue_gen 是一段完整 SVG");
  has(icon, "stroke=\"currentColor\"", "图标用 currentColor 描边（跟相邻线性图标同风格）");
  ok(icon !== G("KIND_ICON_SVG").music_gen, "YuE2 图标不与 Minimax Music 3 雷同");

  ok(yueDefaults.length > 0, "NODE_DEFAULTS 里有 yue_gen 的默认值");
  has(yueDefaults, 'title: "YuE2 音乐节点"', "新建 yue_gen 的默认标题");
  eqStr(yueDefaults.match(/w:\s*(\d+)/)[1], "360", "yue_gen 默认宽 360");
  eqStr(yueDefaults.match(/h:\s*(\d+)/)[1], "300", "yue_gen 默认高 300");
  for (const f of ["style", "lyrics", "abc", "cot", "attempts", "seed", "rerollSeed", "outputPath", "offload", "yueStatus"])
    has(yueDefaults, f + ":", "NODE_DEFAULTS.yue_gen 带字段 " + f);

  const yueNode = { id: "y1", kind: "yue_gen", title: "YuE2" };
  eqNum(G("inputCount")(yueNode), 4, "yue_gen 输入端子数 = 4（0=风格 · 1=歌词 · 2=ABC · 3=控制）");
  eqNum(G("outputCount")(yueNode), 2, "yue_gen 输出端子数 = 2（0=音频 · 1=控制）");
  eqNum(G("minWFor")(yueNode), 320, "yue_gen 最小宽 320");
  eqNum(G("minHFor")(yueNode), 220, "yue_gen 最小高 220");
  eqStr(G("nodeKindLabel")(yueNode), "YuE2", "nodeKindLabel(yue_gen) = YuE2");
  eqStr(G("nodeKindCls")(yueNode), "music", "nodeKindCls(yue_gen) 落到音乐族");
  const purpose = G("nodeKindPurposeKey")(yueNode);
  ok(!!purpose, "yue_gen 有用途文案键");
  has(i18nSrc, '"' + purpose + '"', "用途文案键在 i18n 里有词条：" + purpose);

  /* ===================== [2] 菜单 / 拖线落点 / 停止 / 迁移 ===================== */
  console.log("\n[2] 右键菜单 · 拖线落点 · 停止 · 老档迁移");
  const subAt = appSrc.indexOf('ctxSubmenu(I18n.t("音频生成")');
  ok(subAt > 0, "「音频生成」一级子菜单存在");
  const subBlock = appSrc.slice(subAt, appSrc.indexOf("]),", subAt));
  eqArr(
    ["music_gen", "yue_gen", "tts_gen"].filter((k) => subBlock.indexOf('"' + k + '"') >= 0),
    ["music_gen", "yue_gen", "tts_gen"],
    "「音频生成」成员含 music_gen / yue_gen / tts_gen",
  );
  ok(
    subBlock.indexOf('"music_gen"') < subBlock.indexOf('"yue_gen"') &&
      subBlock.indexOf('"yue_gen"') < subBlock.indexOf('"tts_gen"'),
    "YuE2 夹在 Minimax Music 3 与 SoVITS 语音之间（菜单顺序）",
  );
  has(subBlock, 'I18n.t("YuE2（歌词→整曲 · 可编辑谱面）")', "菜单项文案带「歌词→整曲 · 可编辑谱面」");
  has(subBlock, 'addNode("yue_gen"', "点菜单项真实建 yue_gen");
  const dropAt = appSrc.indexOf("const WIRE_DROP_TARGETS = [");
  const dropBlock = appSrc.slice(dropAt, appSrc.indexOf("];", dropAt));
  has(dropBlock, '{ kind: "yue_gen", g: "处理节点" }', "WIRE_DROP_TARGETS 收 yue_gen（拖线落空白处可就地新建）");
  has(appSrc, "else if (node.kind === \"yue_gen\") node.yueStatus = I18n.t(\"已取消\");", "停止 yue_gen 时写 yueStatus");
  const migAt = appSrc.indexOf("function migrateWf");
  ok(migAt > 0, "migrateWf 存在");
  const migBlock = appSrc.slice(migAt, appSrc.indexOf("\nfunction ", migAt + 10));
  has(migBlock, '"yue_gen"', "migrateWf 认识 yue_gen（老档归一）");
  has(migBlock, "cot", "迁移里归一 cot 档位");

  /* ===================== [3] app-nodes.js 执行链与连线 ===================== */
  console.log("\n[3] app-nodes.js：执行链 / 串行 / 抽卡 / 取消 / 连线规则");
  const playBody = fnBody(nodesSrc, "playYueGenNode");
  ok(!!playBody, "playYueGenNode 存在");
  has(playBody, "window.api.yue2Generate", "生成走桥 api.yue2Generate");
  has(playBody, "fetchMediaGenLock", "取全局音视频互斥锁（全局仅 1 个任务）");
  has(playBody, "mediaGenLockBusyMsg", "锁被别的节点占用时按「音乐」提示并让位");
  has(playBody, "nextMediaGenSeed", "抽卡用通用种子 +1 逻辑");
  has(fnBody(nodesSrc, "mediaGenCancelRemote"), "yue2CancelGenerate", "取消经 api.yue2CancelGenerate 下发");
  has(playBody, "kind: \"audio\"", "产出标记为音频内容输出（node.output.kind = audio）");
  has(playBody, "fireControlOutgoing", "完成后驱动控制输出端子");
  has(playBody, "yueGenCotOf", "下发生成请求前取思维链档位");
  for (const k of ["prompt", "lyrics", "abc", "cot", "seed"])
    has(playBody, k + ",", "生成载荷带 " + k + "（宿主按此接 Gradio）");
  for (const k of ["outputDir", "filename", "offload"])
    has(playBody, k + ":", "生成载荷带 " + k + "（宿主按此接 Gradio）");

  const dispatch = fnBody(nodesSrc, "playNodeBody");
  has(dispatch, 'node.kind === "yue_gen"', "playNodeBody 认识 yue_gen");
  has(dispatch, "runMediaGenSerial(node, () => playYueGenNode(node, quiet))", "yue_gen 经媒体串行链排队");
  const med = fnBody(nodesSrc, "isMediaGenNode");
  has(med, '"yue_gen"', "isMediaGenNode 名单里有 yue_gen（后端探活 / 终止 / 队列同一套）");
  const fetchFn = fnBody(nodesSrc, "fetchMediaBackendStatus");
  has(fetchFn, "window.api.yue2Status", "后端探活问 api.yue2Status");
  const listenFn = fnBody(nodesSrc, "bindMediaBackendListeners");
  has(listenFn, 'window.api.onYueProgress', "订阅 onYueProgress（生成进度）");
  has(listenFn, 'window.api.onYueGpu', "订阅 onYueGpu（显存监视）");
  has(hostSrc, '"yue:progress"', "宿主会发 yue:progress");
  has(hostSrc, '"yue:gpu"', "宿主会发 yue:gpu");
  has(fnBody(nodesSrc, "mediaGenCancelRemote"), 'yue2CancelGenerate', "画布「停止」调到 api.yue2CancelGenerate");

  /* 连线规则：数据只落端口 0–2 且只吃文本来源；控制只落端口 3 */
  has(nodesSrc, 'return I18n.t("YuE2 音乐节点需要文本来源（风格提示词 / 歌词 / ABC 谱）");', "连图片/音频等非文本来源 → 拒绝并说明需要的来源");
  has(nodesSrc, 'return I18n.t("YuE2 音乐节点控制输入端子为端口 3");', "控制线连错端口 → 拒绝并指回端口 3");
  has(nodesSrc, "if (slot != null && (slot < 0 || slot > 2)) return I18n.t(\"无效的输入端子\");", "数据线只允许端口 0–2");
  has(nodesSrc, "nextFreeMediaDataSlot(to, from, fi)", "未指定端子时按空闲数据槽落点");
  const ctrlDrop = nodesSrc.slice(nodesSrc.indexOf("if (fromN && isControlKind(fromN))"), nodesSrc.indexOf("if (fromN && isControlKind(fromN))") + 900);
  has(ctrlDrop, "toN.kind === \"yue_gen\"", "addWire 自动落点认识 yue_gen");
  has(ctrlDrop, "? 3", "yue_gen 的控制线自动落到端口 3");

  /* ===================== [4] app-canvas.js 设置表单与节点体 ===================== */
  console.log("\n[4] app-canvas.js：设置表单 / 端子渲染 / 节点体");
  const formAt = canvasSrc.indexOf('registerNodeSettingsForm("yue_gen"');
  ok(formAt > 0, "registerNodeSettingsForm('yue_gen') 已登记");
  const formBlock = canvasSrc.slice(formAt, canvasSrc.indexOf("\n});", formAt));
  has(formBlock, "nsYueGenParamFields", "表单挂思维链 / 抽卡 / 种子 / 摇数");
  has(formBlock, 'nsMediaGenPathField(ctx, node, "audio")', "表单挂输出路径（音频口径）");
  has(formBlock, "node.offload", "表单写 offload");
  has(fnBody(nodesSrc, "nsYueGenParamFields"), "node.attempts", "抽卡次数写 node.attempts");
  has(fnBody(nodesSrc, "nsYueGenParamFields"), "node.cot", "思维链档位写 node.cot");
  has(fnBody(nodesSrc, "nsYueGenParamFields"), "node.seed", "种子写 node.seed");
  has(fnBody(nodesSrc, "nsYueGenParamFields"), "node.rerollSeed", "摇数写 node.rerollSeed");
  has(fnBody(nodesSrc, "nsYueGenParamFields"), '"full"', "档位含 full");
  has(fnBody(nodesSrc, "nsYueGenParamFields"), '"melody"', "档位含 melody");
  has(fnBody(nodesSrc, "nsYueGenParamFields"), '"off"', "档位含 off");
  has(canvasSrc, '(node.kind === "yue_gen" && i === 3)', "端子渲染：yue_gen 端口 3 上控制色");
  has(canvasSrc, 'appPluginInstalled("yue2-local")', "节点体按插件 id yue2-local 判未装警示条");
  has(canvasSrc, "appendYueGenSummaryBody(node, body)", "节点体画 yue_gen 参数摘要");
  has(canvasSrc, "node.yueStatus", "节点体有 yue_status 状态行");

  /* ===================== [5] 全局音视频互斥锁 ===================== */
  console.log("\n[5] media-gen-global-lock.js：忙时文案按「音乐」说");
  const busy = fnBody(lockSrc, "busyMessage");
  has(busy, '"yue_gen"', "busyMessage 认识 yue_gen");
  has(busy, '"音乐"', "忙时文案复用「音乐」标签");

  /* ===================== [6] IPC 通道与 main.js 接线 ===================== */
  console.log("\n[6] IPC：preload 白名单 ⇄ 宿主 handle / 事件 一一成对");
  const handles = uniq([...hostSrc.matchAll(/ipcMain\.handle\("(yue:[^"]+)"/g)].map((m) => m[1]));
  const invokes = uniq([...preloadSrc.matchAll(/ipcRenderer\.invoke\('(yue:[^']+)'/g)].map((m) => m[1]));
  eqNum(handles.length, 12, "宿主注册 12 个 yue: handle");
  eqArr(sorted(invokes), sorted(handles), "preload invoke 通道与宿主 handle 完全一致（不多不少）");
  const expectedHandles = [
    "yue:getStatus",
    "yue:pickInstallDir",
    "yue:install",
    "yue:cancelInstall",
    "yue:start",
    "yue:stop",
    "yue:generate",
    "yue:cancelGenerate",
    "yue:getLock",
    "yue:open",
    "yue:close",
    "yue:removePluginMeta",
  ];
  eqArr(sorted(handles), sorted(expectedHandles), "12 个通道名与冻结清单逐个对上");
  const sends = uniq([...hostSrc.matchAll(/"yue:(progress|gpu|consoleChanged)"/g)].map((m) => "yue:" + m[1]));
  const ons = uniq([...preloadSrc.matchAll(/ipcRenderer\.on\('(yue:[^']+)'/g)].map((m) => m[1]));
  eqArr(sorted(sends), sorted(["yue:progress", "yue:gpu", "yue:consoleChanged"]), "宿主发 3 个事件通道");
  eqArr(sorted(ons), sorted(sends), "preload 订阅的事件与宿主发送的一一对应");
  for (const m of ["yue2Status", "yue2Open", "yue2Close", "yue2Install", "yue2CancelInstall", "yue2Start", "yue2Stop", "yue2PickInstallDir", "yue2Generate", "yue2CancelGenerate", "yue2GetLock", "yue2RemovePluginMeta"])
    has(preloadSrc, m + ":", "preload 暴露 " + m);
  for (const e of ["onYueProgress", "onYueConsoleChanged", "onYueGpu"])
    has(preloadSrc, e + ":", "preload 暴露 " + e + "（返回退订函数）");
  has(mainSrc, 'require("./yue/main-yue.js")', "main.js require yue/main-yue.js");
  has(mainSrc, "registerYueIpc({", "main.js 调 registerYueIpc");
  has(mainSrc, "onYueDshEvent(ev)", "main.js 在 dsh 事件转发里调 onYueDshEvent");
  has(mainSrc, "shutdownYueUiOnly()", "退出路径只 shutdownYueUiOnly（后端单例不随 MTNode 退出）");
  const reqBlock = mainSrc.slice(mainSrc.indexOf("registerYueIpc({"), mainSrc.indexOf("registerYueIpc({") + 300);
  for (const k of ["getDataDir", "getMainWin", "appRoot", "getDsh"])
    has(reqBlock, k, "registerYueIpc 传参含 " + k);
  const expBlock = hostSrc.slice(hostSrc.indexOf("module.exports = {"));
  for (const e of ["registerYueIpc", "shutdownYueUiOnly", "onYueDshEvent"])
    has(expBlock, e, "yue/main-yue.js 导出 " + e);

  /* ===================== [7] 打包 / 插件目录 / 插件卡 / 自动修复 ===================== */
  console.log("\n[7] 打包白名单 · catalog 卡片 · 插件卡与自动修复分支");
  ok(/\n\s*"yue\/\*\*",/.test(buildSrc), "build.json files 白名单含 yue/**（否则打包后 Cannot find module）");
  const extraAt = buildSrc.indexOf('"from": "yue-pack"');
  ok(extraAt > 0, "build.json extraResources 含 yue-pack 脚手架");
  const extraBlock = buildSrc.slice(extraAt, buildSrc.indexOf("}", extraAt));
  has(extraBlock, '"to": "yue-pack"', "yue-pack 打到 resources/yue-pack");
  for (const f of ["app/**", "scripts/**", "requirements.txt", "manifest.json"])
    has(extraBlock, '"' + f + '"', "yue-pack filter 覆盖 " + f);

  const card = (catalog.plugins || catalog.items || []).find((p) => p && p.id === "yue2-local");
  ok(!!card, "catalog.default.json 里有 yue2-local 卡片");
  eqStr(card.kind, "yue2", "卡片 kind = yue2");
  eqStr(card.handler, "yue2", "卡片 handler = yue2");
  eqStr(card.icon, "yue2-local.png", "卡片图标 = yue2-local.png");
  const m3 = (catalog.plugins || catalog.items || []).find((p) => p && p.id === "minimax-music3");
  const h3 = (catalog.plugins || catalog.items || []).find((p) => p && p.id === "minimax-h3");
  ok(card.order > m3.order && card.order < h3.order, "卡片排序夹在 Music 3 与 H3 之间（" + card.order + "）");
  ok(!!(card.title && card.title.zh && card.title.en), "卡片标题中英齐备");
  has(pluginsMainSrc, '"yue2"', "plugins/main-app-plugins.js 的 KNOWN_KINDS 认 yue2");
  has(pluginsMainSrc, 'raw.handler === "yue2"', "handler → kind 推断认 yue2");
  has(appPluginsSrc, "async function refreshYuePluginCard", "插件卡刷新函数 refreshYuePluginCard 存在");
  has(appPluginsSrc, 'item.kind === "yue2" || item.handler === "yue2"', "插件卡分发链有 yue2 分支");
  has(appPluginsSrc, "onYueConsoleChanged", "卡片订阅控制台开关变化就地刷新");
  has(appPluginsSrc, "bindYueProgress", "卡片绑定安装/更新进度");
  has(appRepairSrc, 'yue2: "yue2-local-install"', "自动修复：yue2 → 技能 yue2-local-install");
  has(appRepairSrc, 'yue2: "yue2Open"', "自动修复：yue2 → 控制台入口 yue2Open");
  has(appRepairSrc, 'label: "YuE2 本地音乐"', "常驻服务表登记 YuE2 本地音乐");
  has(appRepairSrc, '"yue_gen"', "自动修复别名表含节点 kind yue_gen");
  has(hostSrc, 'INSTALL_SKILL = "yue2-local-install"', "宿主安装用的技能名 = 仓内真实技能目录名");
  ok(exists("skills/yue2-local-install/SKILL.md"), "skills/yue2-local-install/SKILL.md 存在");
  for (const p of ["renderer/plugin-icons/yue2-local.png", "plugins/icons/yue2-local.png"])
    ok(exists(p), "占位图标存在：" + p);
  const png = fs.readFileSync(path.join(ROOT, "renderer", "plugin-icons", "yue2-local.png"));
  ok(
    png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
    "插件图标是合法 PNG（魔数校验）",
  );

  /* ===================== [8] i18n / 指南 / 图标 ===================== */
  console.log("\n[8] i18n 词条 · 节点指南（中英 + 索引 + 图）");
  const NEW_KEYS = [
    "YuE2",
    "YuE2 音乐节点",
    "YuE2（歌词→整曲 · 可编辑谱面）",
    "YuE2（音乐生成 · 风格提示词 + 歌词 → 整曲 · 可编辑 ABC 谱面）",
    "音乐",
    "风格",
    "歌词",
    "ABC",
    "ABC 谱",
    "风格提示词（曲风 / 人声 / 乐器 / 情绪）",
    "歌词（含 [Verse]/[Chorus] 等结构标签）",
    "ABC 谱（可选：手工谱面，留空则由模型生成）",
    "思维链",
    "思维链档位",
    "思维链 / 抽卡 / 种子 / 输出路径 / offload",
    "full（完整思维链）",
    "melody（旋律引导）",
    "off（关思维链）",
    "YuE2 的思维链（CoT）档位：full 质量最好、melody 更快、off 仅按提示词",
    "思维链 ",
    "调用 YuE2 本地后端生成音乐",
    "YuE2 · 端子 P=风格提示词 · L=歌词 · ABC=谱面（可选）· 执行时自动启停后端",
    "⚠ YuE2 插件未安装：请在「插件 · YuE2 本地音乐」中安装后使用本节点",
    "待生成（端子 P=风格提示词 · L=歌词 · ABC=谱面可选）",
    "请连接风格提示词输入（端子 P），或直接在节点上填写风格提示词",
    "请连接歌词输入（端子 L），或直接在节点上填写歌词",
    "YuE2 音乐插件未就绪",
    "启动后端并生成…",
    "生成中…",
    "YuE2 音乐节点需要文本来源（风格提示词 / 歌词 / ABC 谱）",
    "YuE2 音乐节点控制输入端子为端口 3",
  ];
  eqArr(
    NEW_KEYS.filter((k) => i18nSrc.indexOf('"' + k + '"') < 0),
    [],
    "全部新文案在 i18n 里都有词条（" + NEW_KEYS.length + " 条）",
  );
  /* 泛化收口：源码里所有字面提到 YuE2 的界面取词都必须登记英文词条（新文案不许漏登记） */
  const yueCopy = uniq(
    [...(appSrc + "\n" + nodesSrc + "\n" + canvasSrc).matchAll(/I18n\.t\(\s*"([^"]*YuE2[^"]*)"/g)].map((m) => m[1]),
  );
  ok(yueCopy.length >= 8, "扫到 YuE2 界面取词 " + yueCopy.length + " 条");
  eqArr(
    yueCopy.filter((k) => i18nSrc.indexOf('"' + k + '"') < 0),
    [],
    "所有 YuE2 界面取词在 i18n 里都有英文词条（缺一即红）",
  );
  /* 中英成对：抽几个非同名键确认英文侧不是照抄中文（YuE2 / ABC 本身中英同形，属预期） */
  const i18nObj = require(path.join(ROOT, "renderer", "i18n.js"));
  const prevLocale = i18nObj.getLocale ? i18nObj.getLocale() : "zh";
  i18nObj.setLocale("en");
  eqStr(i18nObj.t("YuE2 音乐节点"), "YuE2 Music Node", "英文词条：节点名");
  eqStr(i18nObj.t("思维链档位"), "Chain-of-thought tier", "英文词条：思维链档位");
  eqStr(i18nObj.t("YuE2 音乐插件未就绪"), "YuE2 music plugin is not ready", "英文词条：插件未就绪");
  eqStr(i18nObj.t("YuE2 音乐节点控制输入端子为端口 3"), "YuE2 music node control input is port 3", "英文词条：控制端口提示");
  i18nObj.setLocale(prevLocale || "zh");

  for (const p of ["guides/nodes/yue_gen.md", "guides/nodes/en/yue_gen.md", "guides/nodes/img/yue_gen.svg"])
    ok(exists(p), "节点指南文件存在：" + p);
  ok(nodeIdx.ids.indexOf("yue_gen") >= 0, "yue_gen 已进节点指南索引");
  eqNum(nodeIdx.ids.indexOf("yue_gen"), nodeIdx.ids.indexOf("music_gen") + 1, "索引里 yue_gen 紧跟 music_gen");
  eqStr(nodeIdx.ids[nodeIdx.ids.indexOf("yue_gen") + 1], "tts_gen", "索引里 tts_gen 紧跟 yue_gen（音频生成三类相邻）");
  const guideZh = read("guides/nodes/yue_gen.md");
  has(guideZh, "YuE2", "中文指南写明节点名");
  has(guideZh, "端口 3 = 控制输入", "中文指南写明控制输入端口");
  has(guideZh, "yue2-local-install", "中文指南写明自动修复技能名");
  const guideEn = read("guides/nodes/en/yue_gen.md");
  has(guideEn, "port 3 = control input", "英文指南与中文成对（端口口径）");
  const svg = read("guides/nodes/img/yue_gen.svg");
  ok(svg.indexOf("<svg") >= 0 && svg.indexOf("</svg>") > 0, "节点指南配图是合法单根 SVG");
  hasnt(svg, "placeholder", "配图无 placeholder 残留");

  /* ===================== [9] yue-pack 与宿主 Gradio 契约 ===================== */
  console.log("\n[9] yue-pack manifest 与宿主调用面");
  for (const p of ["yue-pack/manifest.json", "yue-pack/requirements.txt", "yue-pack/start_backend.cmd", "yue-pack/app/__main__.py", "yue-pack/app/server.py", "yue-pack/scripts/install.ps1"])
    ok(exists(p), "后端脚手架文件存在：" + p);
  const manifest = JSON.parse(read("yue-pack/manifest.json"));
  eqStr(manifest.id, "yue2-local", "manifest id = yue2-local");
  eqStr(manifest.entry, "app", "后端入口 = python -m app");
  eqNum(manifest.apiPort, 8773, "后端 API 端口 8773");
  eqStr(manifest.model, "m-a-p/YuE2-3B", "权重 = m-a-p/YuE2-3B");
  eqStr(manifest.vae, "m-a-p/YuE2-Vae", "VAE = m-a-p/YuE2-Vae");
  eqArr(manifest.chainOfThought, ["full", "melody", "off"], "思维链档位与节点下拉三档一致");
  /* 宿主调到 Gradio 的调用面冻结为 8 槽（提示词 / 歌词 / 时长 / 种子 / 输出目录 / 文件名 / 模型 / offload） */
  const dataAt = hostSrc.indexOf("const data = [");
  const dataBlock = hostSrc.slice(dataAt, hostSrc.indexOf("];", dataAt));
  for (const token of ["promptStr", "lyricsStr", "params.audioDuration", "params.seed", "stagingDir", "stagingName", "modelPath", "params.offload"])
    has(dataBlock, token, "Gradio data 槽含 " + token);
  eqNum((dataBlock.match(/\n\s+[^\s\]]/g) || []).length, 8, "Gradio data 恰好 8 槽（前后端调用面冻结）");
  has(hostSrc, 'LOCK_KIND = "yue_gen"', "宿主锁 kind = yue_gen（与节点 kind 同名）");
  has(hostSrc, 'PLUGIN_ID = "yue"', "宿主插件 id = yue");
  for (const p of ["yue/main-yue.js", "yue/preload-yue.js", "yue/ui/index.html", "yue/ui/ui.js"])
    ok(exists(p), "宿主文件存在：" + p);

  /* ===== [10] 缺依赖自修复（app/ui.py 守卫 · 宿主补装与报错指纹 · 安装链同步） ===== */
  console.log("\n[10] 缺依赖自修复：入口守卫 / 自动补装 / 报错指纹 / 安装脚本与技能");

  /* --- 10.1 yue-pack 补 Gradio 入口与依赖（修根因） --- */
  has(read("yue-pack/requirements.txt"), "gradio", "requirements.txt 声明 gradio");
  hasnt(read("yue-pack/requirements.txt"), "\ntorch", "requirements.txt 仍不写 torch（由 install.ps1 按驱动装）");
  ok(exists("yue-pack/app/ui.py"), "yue-pack/app/ui.py 存在（宿主唯一认的 -m app.ui 入口）");
  const uiPy = read("yue-pack/app/ui.py");
  const guardAt = uiPy.indexOf("MTNODE_MISSING_DEP=gradio");
  has(uiPy, "import gradio as gr", "ui.py 导入 gradio");
  ok(guardAt > 0 && guardAt < uiPy.indexOf("from app import engine"), "ui.py 缺依赖守卫在其它 import 之前");
  has(uiPy.slice(guardAt, guardAt + 700), "SystemExit(3)", "缺 gradio 时守卫打印标记后以非 0 退出");
  has(uiPy, "run_generate", "ui.py 暴露 run_generate");
  const sigAt = uiPy.indexOf("def run_generate(");
  const sigBlock = uiPy.slice(sigAt, uiPy.indexOf("progress: gr.Progress", sigAt));
  eqNum((sigBlock.match(/\n    [A-Za-z_][\w]*\s*:/g) || []).length, 8, "run_generate 恰好 8 个业务参数（与宿主 data 槽冻结）");
  {
    const order = ["style", "lyrics", "durationSec", "seed", "outputDir", "filename", "modelDir", "offload"].map((n) =>
      sigBlock.search(new RegExp("\\n    " + n + "\\s*:")),
    );
    ok(
      order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]),
      "run_generate 8 槽顺序与宿主 data 严格一致",
    );
  }
  has(uiPy, "queue(max_size=1", "ui.py Gradio 队列串行（busy → 429 语义与 music3 对齐）");
  has(read("yue-pack/app/__main__.py"), "", "app/__main__.py 仍在（stdlib 自查入口不回归）");
  /* 覆盖机制：pack/app/*.py 会被拷进安装目录，用户机上坏掉的 ui.py 由这份覆盖 */
  has(hostSrc, "syncPackAppToInstall(installDir)", "startBackend 先 syncPackAppToInstall（覆盖用户机上的坏 ui.py）");

  /* --- 10.2 宿主缺依赖自检 + 自动补装（核心自修复） --- */
  ok(exists("yue/main-yue.js"), "yue/main-yue.js 存在");
  const ensureBody = fnBody(hostSrc, "ensurePythonDeps");
  has(ensureBody, "pip", "ensurePythonDeps 用 pip 补装");
  has(ensureBody, "--isolated", "ensurePythonDeps 走 --isolated");
  has(ensureBody, "import ", "ensurePythonDeps 逐模块 import 探测");
  const pipChain = hostSrc.slice(hostSrc.indexOf("pip 索引"), hostSrc.indexOf("function indexHostOf"));
  has(pipChain, "pypi.tuna.tsinghua.edu.cn", "pip 索引链含清华");
  has(pipChain, "mirrors.aliyun.com", "pip 索引链含阿里云回退");
  has(hostSrc, "MT_YUE2_PIP_INDEX", "pip 索引可用 MT_YUE2_PIP_INDEX 覆盖");
  has(hostSrc, "depsInstallTried", "同一次启动不重复装同一包（节流）");
  has(ensureBody, "force", "定向补装支持 force（绕过节流重试一次）");
  has(hostSrc, "reportMissingDeps", "缺依赖统一失败出口 reportMissingDeps");
  has(hostSrc, 'reportErr("missing_dep"', "失败报错码 missing_dep");
  {
    /* 补装必须在 spawn 之前：否则只会崩在 import gradio */
    const sb = fnBody(hostSrc, "startBackend");
    const depAt = sb.indexOf("ensurePythonDeps(");
    const spawnAt = sb.indexOf("spawn(py,");
    ok(depAt > 0 && spawnAt > 0 && depAt < spawnAt, "startBackend 中依赖自检在 spawn 之前");
    has(sb, "reportMissingDeps", "补不上就不 spawn，直接报 missing_dep");
  }
  {
    const job = fnBody(hostSrc, "ensureBackendReadyForJob");
    has(job, "ensurePythonDeps", "ensureBackendReadyForJob 前置同一自检");
  }
  {
    const st = fnBody(hostSrc, "statusForUi");
    has(st, "missingDeps", "statusForUi 回传 missingDeps（供渲染层提示 / 一键修复）");
  }

  /* --- 10.3 报错指纹 → 定向修复（真实函数在 vm 里跑四类信号） --- */
  const depSandbox = { console, String, RegExp };
  vm.createContext(depSandbox);
  /* parseMissingDepHint 体内含带引号的字面正则，fnBody 的朴素大括号扫描会被误判成字符串，
     这里按「函数头 → 下一个 JSDoc」切片取整只函数（内容仍来自源文件真值）。 */
  const depFnAt = hostSrc.indexOf("function parseMissingDepHint(");
  const depFnEnd = hostSrc.indexOf("/** 缺依赖的定向失败出口");
  ok(depFnAt > 0 && depFnEnd > depFnAt, "能从宿主源码切出 parseMissingDepHint");
  vm.runInContext(hostSrc.slice(depFnAt, depFnEnd).trim(), depSandbox, { filename: "yue-dep-extract.js" });
  const fpOf = (t) => vm.runInContext("parseMissingDepHint(" + JSON.stringify(t) + ")", depSandbox);
  eqStr((fpOf("MTNODE_MISSING_DEP=gradio\n缺少依赖 gradio") || {}).module, "gradio", "指纹识别 MTNODE_MISSING_DEP 机器标记");
  eqStr((fpOf("ModuleNotFoundError: No module named 'soundfile'") || {}).module, "soundfile", "指纹识别 ModuleNotFoundError");
  eqStr((fpOf('File "x.py", line 3\nImportError: cannot import name y from \'librosa\'') || {}).module, "librosa", "指纹识别 ImportError from");
  eqStr((fpOf("RuntimeError: Gradio 未安装：请用 .venv\\Scripts\\python.exe -m pip install gradio 后重试") || {}).module, "gradio", "指纹识别本次中文字面「Gradio 未安装」");
  ok(fpOf("Traceback (most recent call last):\nValueError: boom") === null, "无缺依赖信号时指纹为 null");
  has(hostSrc, 'reportErr("missing_dep:" + name', "定向失败出口报错码带具体模块名");
  {
    const sb = fnBody(hostSrc, "startBackend");
    has(sb, "parseMissingDepHint", "backend_exited 分支读报错指纹");
    has(sb, "repairedDeps", "同一轮启动对同一模块只自动重试一次（防递归）");
    const fpAt = sb.indexOf("parseMissingDepHint");
    const retryAt = sb.indexOf("startBackend(repairedDeps)");
    ok(fpAt > 0 && retryAt > fpAt, "命中指纹 → 定向补装后重试启动一次");
  }
  {
    const sr = fnBody(hostSrc, "selfRepairFromConsole");
    has(sr, "parseMissingDepHint", "selfRepairFromConsole 注入依赖指纹");
    has(sr, "先 pip install 补依赖，不要重下模型", "dsh 提示词首位指向补依赖而非重下权重");
    const leadAt = sr.indexOf("depLead");
    const hintAt = sr.indexOf('【自我修复任务');
    ok(leadAt > 0 && hintAt > leadAt, "依赖指纹拼在 dsh 提示词首位");
  }

  /* --- 10.4 安装脚本与安装技能同步（A 组） --- */
  const installPs1 = read("yue-pack/scripts/install.ps1");
  has(installPs1, "gradio", "install.ps1 依赖步骤显式含 gradio");
  has(installPs1, "import gradio; print('gradio'", "install.ps1 装完做 import gradio 自检");
  has(installPs1, "requirements_install_failed", "gradio 自检失败记 reason=requirements_install_failed");
  has(installPs1, "import app.ui", "install.ps1 冒烟前检查 ui.py 入口可导入");
  has(installPs1, "ui_entry_import_failed", "ui.py 入口 ModuleNotFoundError 记 reason=ui_entry_import_failed");
  const skill = read("skills/yue2-local-install/SKILL.md");
  has(skill, "gradio", "安装技能依赖清单含 gradio");
  has(skill, "app\\ui.py", "安装技能工程文件清单含 app\\ui.py");
  has(skill, "gradio_missing", "失败自查表含 gradio_missing 行");
  has(skill, "import app.ui", "成功标准含 import app.ui 不报 ModuleNotFoundError");
  has(read("yue-pack/README.md"), "app.ui", "README 写清宿主 -m app.ui 入口");
  has(read("yue-pack/start_backend.cmd"), "gradio", "start_backend.cmd 提示缺 gradio 先补装");

  /* --- 10.5 IPC 面未变（未新增通道 → 无需 preload 同步） --- */
  hasnt(hostSrc, '"yue:repairDeps"', "未新增 yue:repairDeps 通道");
  hasnt(preloadSrc, "yue2RepairDeps", "preload 未出现无主的 yue2RepairDeps");
  eqNum(uniq([...hostSrc.matchAll(/ipcMain\.handle\("(yue:[^"]+)"/g)].map((m) => m[1])).length, 12, "宿主 handle 仍为 12 个（[6] 成对断言基准不变）");
  has(read("renderer/i18n.js"), "缺依赖 ", "渲染层有缺依赖文案词条（一键修复口径）");

  /* ===== [11] 注意力档位自修复（flash 无 kernel → 探针选档 / 报错指纹 / 安装链口径） ===== */
  console.log("\n[11] 注意力档位自修复：随包补丁 · 宿主探针与报错指纹 · 同步回执 · 安装链");

  /* --- 11.1 随包脚手架补丁（修根因：不再被每轮 sync 覆盖掉的单一真源） --- */
  ok(exists("yue-pack/app/windows_patch.py"), "yue-pack/app/windows_patch.py 存在（随包单一真源）");
  const wpPy = read("yue-pack/app/windows_patch.py");
  for (const fn of ["forced_backend", "_probe_flash", "_probe_cudnn", "_probe_sdpa", "probe_backends", "best_attention_backend", "apply_yue2_windows_patch", "describe", "cache_file"])
    has(wpPy, "def " + fn + "(", "windows_patch 暴露 " + fn);
  /* 三档真跑探针（schema 在 ≠ kernel 在）：不是 hasattr 就算数 */
  has(wpPy, "torch.ops.aten._flash_attention_forward(", "flash 档真调 aten op");
  has(wpPy, "sdpa_kernel(SDPBackend.CUDNN_ATTENTION)", "cudnn 档真跑 CUDNN_ATTENTION");
  has(wpPy, "F.scaled_dot_product_attention(", "sdpa 兜底档真跑前向");
  has(wpPy, '("flash", "cudnn", "sdpa")', "档位顺序 flash → cudnn → sdpa");
  /* 幂等包 GraphAR：attention_backend="auto" 换成实测档 */
  has(wpPy, "cg.GraphAR.__init__ = patched", "幂等包 GraphAR.__init__");
  has(wpPy, "if _APPLIED:", "已打过补丁就直接返回（重装 yue2 不必重打）");
  has(wpPy, "attention_backend == \"auto\"", "只改 auto（显式档位不动）");
  has(wpPy, "attention_backend = forced", "显式覆盖直接信任、跳过探针");
  has(wpPy, "attention_backend = best_attention_backend()", "auto 时走实测探针");
  has(wpPy, "YUE2_ATTENTION_BACKEND", "支持 YUE2_ATTENTION_BACKEND 显式覆盖");
  has(wpPy, '"attention_backend_unsupported"', "三档全失败抛短码 attention_backend_unsupported");
  has(wpPy, "def cache_file()", "探针记录路径可查");
  has(wpPy, '".attention-backend"', "探针结果落 <INSTALL_DIR>\\.attention-backend");

  /* --- 11.2 engine.py：import 期接线 + 短码收敛 --- */
  const engPy = read("yue-pack/app/engine.py");
  has(engPy, "WINDOWS_PATCH: str = apply_windows_patch()", "engine.py import 期即应用补丁");
  has(engPy, "from app import windows_patch", "engine.py 引随包补丁模块（同包，两种入口都命中）");
  has(engPy, "def attention_backend()", "engine.py 暴露 attention_backend() 供宿主 / UI 读");
  has(engPy, "def _precheck_attention_backend(", "engine.py 构造 pipeline 前预检档位");
  has(engPy, "_precheck_attention_backend(self._pick_device())", "_new_pipeline 内接预检");
  has(engPy, "attention_backend_unsupported", "探针全失败收敛成短码");
  has(engPy, 'USE_FLASH_ATTENTION', "裸 torch 断言纳入指纹");
  has(engPy, "No available kernel", "No available kernel 纳入指纹");
  has(engPy, "def _attention_engine_error(", "统一转成 EngineError 短码（不裸报英文断言）");

  /* --- 11.3 探针脚本（只做语法 / 参数契约断言，不执行） --- */
  ok(exists("yue-pack/scripts/probe_attention.py"), "yue-pack/scripts/probe_attention.py 存在");
  const probePy = read("yue-pack/scripts/probe_attention.py");
  has(probePy, 'ap.add_argument("--json"', "探针脚本支持 --json（机器可读一份）");
  has(probePy, "from app import windows_patch as wp", "探针复用补丁模块（探针实现只此一处）");
  has(probePy, 'wp.cache_file()', "探针写 .attention-backend 记录");
  has(probePy, 'if __name__ == "__main__"', "探针脚本有 __main__ 入口");
  has(probePy, "ROOT = Path(__file__).resolve().parent.parent", "探针自行反推安装根（任何 cwd 可导入）");
  ok(!/\bimport\s+torch\.\w+\s*\(/.test(probePy), "探针脚本不在 import 期真跑 torch 计算");

  /* --- 11.4 install.ps1：安装期探针与自检 --- */
  has(installPs1, "probe_attention.py", "install.ps1 跑注意力档位探针");
  has(installPs1, ".attention-backend", "install.ps1 把档位写 <INSTALL_DIR>\\.attention-backend");
  has(installPs1, "attention_backend_unsupported", "无可用档记 reason=attention_backend_unsupported");
  has(installPs1, "app\\windows_patch.py", "工程文件清单含 app\\windows_patch.py");
  has(installPs1, "必须**同时**存在", "清单提示 windows_patch 与 engine 必须同时存在（防 sync 覆盖）");

  /* --- 11.5 SKILL.md：纠正「缺 flash_attn 不是故障」旧口径 --- */
  hasnt(skill, "只慢，不算失败", "旧口径「只慢，不算失败」已删除");
  hasnt(skill, "只慢，不是故障", "旧口径「只慢，不是故障」已删除");
  has(skill, "是故障、不是只慢", "新口径：Windows 缺 flash kernel 是故障不是只慢");
  has(skill, "attention_backend_unsupported", "失败自查表新增 attention_backend_unsupported 行");
  has(skill, "Planning score", "自查行指出 Planning score 阶段硬失败");
  has(skill, "probe_attention.py", "处置指向探针选档");
  has(skill, "windows_patch.py", "处置指向 app\\windows_patch.py");
  has(skill, "注意力档位重探针", "自我修复模式含「注意力档位重探针」一条");
  has(skill, "不要装 flash-attn", "明确不要用装 flash-attn 绕过");
  has(read("yue-pack/README.md"), "注意力档位与 Windows 差异", "README 增「注意力档位与 Windows 差异」一节");
  has(read("yue-pack/README.md"), "YUE2_ATTENTION_BACKEND", "README 记录 env 覆盖口径");
  has(read("yue-pack/app/ui.py"), 'f"[yue2] attention=', "ui.py 启动打一行 attention=<档位>");
  eqStr(JSON.parse(read("yue-pack/manifest.json")).version, "1.0.1", "manifest version 提升到 1.0.1（走 runtime 覆盖通道）");

  /* --- 11.6 宿主：报错指纹（真函数在 vm 里跑四类信号） --- */
  const attSandbox = { console, String, RegExp, Date, Number };
  vm.createContext(attSandbox);
  vm.runInContext(fnBody(hostSrc, "parseAttentionHint"), attSandbox, { filename: "yue-attention-extract.js" });
  const attOf = (t) => vm.runInContext("parseAttentionHint(" + JSON.stringify(t) + ")", attSandbox);
  eqStr((attOf("RuntimeError: USE_FLASH_ATTENTION was not enabled for build.") || {}).code, "attention_backend_unsupported", "指纹识别 USE_FLASH_ATTENTION was not enabled for build.");
  eqStr((attOf("[YuE2] Failed Planning score\nNo available kernel") || {}).hit, "no_kernel", "指纹识别 No available kernel");
  eqStr((attOf("[YuE2] Failed Planning score") || {}).hit, "planning_score", "指纹识别 [YuE2] Failed Planning score");
  eqStr((attOf("Error: attention_backend_unsupported") || {}).hit, "shortcode", "指纹识别短码 attention_backend_unsupported");
  ok(attOf("Traceback (most recent call last):\nValueError: boom") === null, "无注意力信号时指纹为 null");
  ok(attOf("") === null, "空文本指纹为 null");

  /* --- 11.7 宿主：探针选档 + env 下发（探针必须在 spawn 之前） --- */
  has(hostSrc, 'const ATTENTION_FALLBACK = "sdpa";', "探针失败回落 sdpa");
  has(hostSrc, "const ATTENTION_PROBE_TIMEOUT_MS = 180 * 1000;", "探针超时 180s");
  has(hostSrc, "const ATTENTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;", "档位缓存 TTL 6h");
  has(hostSrc, 'join(yueRoot(), "attention.json")', "档位缓存落 <DATA>\\yue\\attention.json");
  has(hostSrc, 'join(installDir, "scripts", "probe_attention.py")', "探针脚本优先用安装目录那份");
  has(hostSrc, 'join(packRoot(), "scripts", "probe_attention.py")', "探针脚本缺失时从随包脚手架补拷");
  {
    const att = fnBody(hostSrc, "ensureAttentionBackend");
    has(att, '"--json"', "ensureAttentionBackend 用 --json 调探针");
    has(att, "ATTENTION_PROBE_TIMEOUT_MS", "探针带超时");
    has(att, "process.env.YUE2_ATTENTION_BACKEND", "显式 env 覆盖优先");
    has(att, "rememberAttentionBackend", "探针结论记缓存 + 内存");
    has(att, "ATTENTION_FALLBACK", "无可用档回落 sdpa");
    has(att, "attentionProbePending", "并发探针去重（同一次只探一次）");
  }
  has(hostSrc, "function invalidateAttentionCache(", "失败后作废缓存（下次重探）");
  {
    const sb = fnBody(hostSrc, "startBackend");
    const probeAt = sb.indexOf("ensureAttentionBackend(");
    const spawnAt = sb.indexOf('spawn(py, ["-m", "app.ui"]');
    ok(probeAt > 0 && spawnAt > 0 && probeAt < spawnAt, "startBackend 中注意力探针在 spawn 之前");
    has(sb, "env.YUE2_ATTENTION_BACKEND = att", "spawn env 注入 YUE2_ATTENTION_BACKEND");
  }
  {
    const rep = fnBody(hostSrc, "reportAttentionBackend");
    has(rep, '"attention_backend_unsupported"', "定向失败出口报错码 attention_backend_unsupported");
    has(rep, "attentionBackend", "回执带 attentionBackend 字段");
  }
  has(hostSrc, 'reportAttentionBackend(attFp', "生成失败命中指纹 → 走定向修复出口");
  has(hostSrc, "invalidateAttentionCache(attFp.hit)", "命中后作废缓存并后台重探");
  {
    const sr = fnBody(hostSrc, "selfRepairFromConsole");
    has(sr, "parseAttentionHint", "selfRepairFromConsole 注入注意力指纹");
    has(sr, "不要重下模型、不要装 flash-attn", "dsh 提示词写明不要重下权重 / 装 flash-attn");
    const hintAt = sr.indexOf("const hint =");
    const attUse = sr.indexOf("attLead", hintAt);
    const depUse = sr.indexOf("depLead", attUse);
    const bodyAt = sr.indexOf("【自我修复任务");
    ok(
      hintAt > 0 && attUse > hintAt && depUse > attUse && bodyAt > depUse,
      "注意力指纹拼在 dsh 提示词首位（先于缺依赖与任务正文）",
    );
  }
  {
    const st = fnBody(hostSrc, "statusForUi");
    has(st, "attentionBackend", "statusForUi 回传 attentionBackend");
    has(st, "attentionSource", "statusForUi 回传 attentionSource");
  }
  has(read("yue/ui/ui.js"), "attentionBackend", "控制台窗显示注意力档位");
  has(read("yue/ui/index.html"), 'id="attBadge"', "控制台窗标题行有 attBadge");
  has(i18nSrc, "注意力档位用了 flash", "i18n 有注意力定向修复文案（中英）");
  has(i18nSrc, "未探到可用注意力档位，已回落 sdpa", "i18n 有回落 sdpa 文案");

  /* --- 11.8 同步不再回退补丁 + runtime 生效口径 --- */
  has(hostSrc, "function sha256OfFile(", "同步按 sha256 判内容（内容相同即跳过）");
  has(hostSrc, "function packSyncStampPath(", "同步回执落 app/.pack-sync.json");
  has(hostSrc, '".pack-sync.json"', "回执文件名 .pack-sync.json");
  has(hostSrc, "files: hashes", "回执含每个 .py 的 sha256");
  has(hostSrc, '"[sync] keep local: "', "pack 没带的本地 .py 显式留痕（不再静默）");
  has(hostSrc, '"[sync] updated="', "同步回执打 updated/added/skipped");
  has(hostSrc, "skipped++", "内容相同不拷（减少 mtime 抖动）");
  has(hostSrc, '"[pack] root="', "packRoot 打生效包口径（bundled / runtime）");
  has(hostSrc, "lastPackChoiceKey", "生效包口径只在变化时打一行");
  has(hostSrc, 'const PACK_ID = "yue2-local";', "manifest 期望 id 常量为 yue2-local（噪声告警消失）");
  has(hostSrc, 'out.problems.push("manifest.id=" + man.id + "（期望 " + PACK_ID + "）")', "validatePackManifest 期望值改用 PACK_ID");
  has(hostSrc, 'PLUGIN_ID = "yue"', "插件 kind 仍为 yue（与 PACK_ID 区分，未串味）");

  console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
  if (fails) {
    console.log(fails + " 项失败");
    process.exit(1);
  }
  console.log("全部通过");
})();

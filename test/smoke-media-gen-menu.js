"use strict";
/* 音频 / 视频生成菜单、SoVITS 语音节点与媒体端子口径的回归
 *   node test/smoke-media-gen-menu.js
 * 与 test/smoke-wire-drop-menu.js 同一套路：用 vm 从 renderer 源码里按名字抠出**真实函数**来跑，
 * 只有建节点 / 落盘 / DOM 渲染这些与判定无关的部分用测试侧替身。
 *
 * 锁住的需求：
 *   1. 两种视频生成收进一级子菜单「视频生成」（成员 Minimax H3 · 视频超分 · 视频补帧 · Remotion 视频）
 *   1b. 文本处理与 PDF生成 收进悬停展开的一级子菜单「文本生成」（成员口径见 test/smoke-pdf-gen.js）
 *   1c. 云端文生图 proc_image 与本地 SenseNova 图像生成（sensenova_gen）收进一级子菜单「图像生成」
 *   2. 音乐收进一级子菜单「音频生成」，并改名 Minimax Music 3
 *   3. 「音频生成」新增 SoVITS 语音生成（tts_gen · 接本机 GPT-SoVITS TTS 插件）
 *   4. 音频 / 视频输入节点开始输出：值是该文件的 file:/// URL
 *
 * 覆盖：
 *   [1] 一级子菜单成员（跑真实 canvasCreateMenuGroups；选一项看它到底建出哪一类节点）
 *   [1b] 「工具」一级菜单＝工具 / 函数节点的创建入口（顶栏只留「工具库」；开发 / 数据库壳层不列）
 *   [2] 类型名与用途文案改名 · 旧文案与旧 i18n 词条无残留 · 新词条中英齐备 · 节点指南齐备
 *   [3] tts_gen 端子契约（2 入 2 出 · 端口1=控制）与 connectError 各分支
 *   [4] 执行链：媒体串行链认识它 · playNodeBody 分发 · playTtsGenNode 真跑一次合成
 *   [5] 音频 / 视频输入节点：各 1 个数据输出端子，值里带 file:/// URL
 *   [6] file:// URL ⇄ 本机绝对路径 归一（逐例） */
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
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
  const start =
    iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
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
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");
/* 标量常量（NODE_DEFAULTS 之类会引用）：按源码里的字面量原样带进沙箱 */
function extractConsts(src, names) {
  return names
    .map((n) => {
      const m = src.match(new RegExp("\\n(?:const|var) " + n + "\\s*=\\s*([\\s\\S]*?);\\s*\\r?\\n"));
      if (!m) throw new Error("找不到标量常量：" + n);
      return "const " + n + " = " + m[1].trim() + ";";
    })
    .join("\n");
}

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");
const canvasSrc = read("renderer/app-canvas.js");
const i18nSrc = read("renderer/i18n.js");
const lockSrc = read("media-gen-global-lock.js");

/* ---------- 测试侧替身（只替与判定无关的 DOM / 落盘 / 渲染部分） ---------- */
let uidN = 0;
const S = { wf: { nodes: [], wires: [] }, cam: { z: 1 } };
const added = [];
const ctrlFired = [];
let ttsCalls = [];
let remotionInstalled = true;
let ttsStatus = {
  running: true,
  installed: true,
  apiUp: true,
  apiStatus: { voices: [{ id: "v1", name: "女声一" }] },
};
const uiStates = new Map();
const sandbox = {
  S,
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
  Promise,
  Date,
  URL,
  setTimeout,
  clearTimeout,
  setImmediate,
  decodeURIComponent,
  encodeURIComponent,
  /* 后端等待用的两个节拍常量（本用例走不到慢启动分支，只为避免引用落空） */
  TTS_API_POLL_MS: 2000,
  TTS_API_WAIT_MS: 180000,
  I18n: { t: (s) => String(s) },
  toast: () => {},
  renderCanvas: () => {},
  scheduleSave: () => {},
  updateRunQueuePanel: () => {},
  /* addWire 的旁支（历史 / 渲染 / 自动切视觉模型）与端子落点无关，一律替身 */
  uid: (p) => p + "_w" + ++uidN,
  clearDownstream: () => {},
  ensureProcTextVision: () => {},
  applySavePathExt: () => {},
  pushHistory: () => {},
  /* 建节点替身：菜单项 run() 之后看它到底建出哪一类节点 */
  addNode: (kind, x, y, extra) => {
    const n = Object.assign({ id: "n" + ++uidN, kind, x, y }, extra || {});
    added.push(n);
    return n;
  },
  addMark: () => {},
  promptBuildWorkflow: () => {},
  nextNetChannel: () => 41001,
  appPluginInstalled: (id) => (id === "remotion" ? remotionInstalled : true),
  /* 层级判定替身：一律按顶层画布 */
  currentSuperFocus: () => "",
  currentTaskFocus: () => "",
  currentDbSuper: () => "",
  dbCreateMenuOpenAt: () => false,
  superHostAtWorld: () => null,
  /* 取值替身：真实 valueForInput 要读 DOM 与批量态，这里按 kind 给最小可信值 */
  valueForInput: (src) => {
    if (!src) return null;
    if (src.kind === "input_text") return { kind: "text", text: String(src.text || "") };
    if (src.kind === "input_image" || src.kind === "proc_image")
      return { kind: "image", path: "E:/assets/pic.png" };
    if (src.kind === "input_audio" || src.kind === "input_video")
      return sandbox.mediaInputValueOf(src);
    return { kind: "text", text: "" };
  },
  valueFromWire: (w) => sandbox.valueForInput(sandbox.nodeById(w.from)),
  displayValueOf: (n) => {
    const v = sandbox.valueForInput(n);
    if (!v) return null;
    return {
      text: v.text != null ? v.text : v.path,
      image: v.kind === "image" ? v.path : null,
    };
  },
  attemptCount: (n) => Math.max(1, Number(n && n.attempts) || 1),
  /* 输出路径解析：本用例只关心取数与桥接参数，落盘口给固定结果 */
  requireMediaGenExport: () => ({ ok: true, path: "E:/out/voice.wav", filename: "voice.wav", outputDir: "E:/out" }),
  prepareMediaGenRollExport: () => ({ ok: true, path: "E:/out/voice.wav", filename: "voice.wav", outputDir: "E:/out" }),
  syncMediaGenPathFromExport: () => {},
  savePathResolveError: (c) => "bad-path:" + c,
  mediaGenDoneMsg: () => "完成",
  mediaGenRollProgressTag: () => "",
  ensureBackendUiState: (n) => {
    if (!uiStates.has(n.id)) uiStates.set(n.id, {});
    return uiStates.get(n.id);
  },
  stopMediaBackendProbe: () => {},
  startMediaBackendRunWatcher: () => {},
  stopMediaBackendRunWatcher: () => {},
  stopAllMediaBackendRunWatchers: () => {},
  refreshMediaNodeUi: () => {},
  markMediaBackendDown: () => {},
  summarizeMediaBackendStatus: () => "backend",
  looksLikeBackendConnError: () => false,
  mediaRunStopped: () => false,
  mediaGenMarkDropped: () => {},
  beginNodeRun: () => {},
  nodeHasOutputContent: (n) => !!(n && n.output),
  fireControlOutgoing: (n, port) => {
    ctrlFired.push({ id: n.id, port: Number(port) });
    return Promise.resolve();
  },
  /* 主进程桥：状态查询与合成请求都从这里过 */
  window: {
    api: {
      /* 与 preload 桥一致：直接借 Node 的 pathToFileURL（中文 / 空格自动编码，盘符冒号保留） */
      toFileUrl: (p) => require("url").pathToFileURL(String(p)).href,
      ttsStatus: async () => ttsStatus,
      ttsStart: async () => ({ ok: true }),
      ttsGenerate: async (body) => {
        ttsCalls.push(body);
        return { ok: true, path: "E:/out/voice.wav" };
      },
    },
  },
};
vm.createContext(sandbox);
const G = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);

/* ---------- 真实函数：菜单 / 端子 / 连线校验 / 合成执行体全部来自源文件 ---------- */
const APP_FNS = [
  "KIND_CLS",
  "nodeKindIconKey",
  "nodeKindIconCls",
  "ctxKindItem",
  "ctxSubmenu",
  "ctxAction",
  "canvasCreateMenuGroups",
  "nodeById",
  "nodeParentSuperId",
  "isSuperLikeNode",
  "ctrlRoleOf",
  "isExecStart",
  "isExecEnd",
  "isControlKind",
  "inPortIsControl",
  "inPortKindOf",
  "isFnToolNode",
  "hasFixedInPorts",
  "wireFromIsControl",
  "nodeByIdIn",
  "nodeEmitsControlOnPort",
  "superInPortIsControl",
  "superOutPortIsControl",
  "superExternalInWires",
  "superExternalOutWires",
  "superInternalBridgeWires",
  "superInternalOutFeeds",
  "wiresTo",
  "allWiresTo",
  "hasOutput",
  "outputCount",
  "inputCount",
  "isTextSource",
  "isImageSource",
  "isRefableSource",
  "isSaveKind",
  "isSaveNode",
  "saveDataSources",
  "saveDataLinks",
  "saveMediaKind",
  "inferMediaFromSource",
  "wireSourceMediaType",
  "videoGenMode",
  "videoGenMaxImages",
  "videoGenMaxVideos",
  "videoGenMaxAudios",
  "videoGenMaxChains",
  /* 衔接槽的位置真源（FL2VA 槽 4 · R2V 槽 17）：videoGenSlotMeta 会调它，不抽进沙箱就 ReferenceError */
  "videoGenChainSlotIndex",
  "videoGenSlotOccupied",
  "videoGenProgressiveCount",
  "videoGenInputCount",
  "videoGenControlPort",
  "videoGenIsDataPort",
  "videoGenDataSlotsTotal",
  "videoGenPortOfSlot",
  "videoGenSlotOfPort",
  "videoGenPortMeta",
  "videoGenSlotMeta",
  "isCustomVideoGen",
  "isVideoPostKind",
  "videoPostInputCount",
  "videoPostSlotMeta",
  "videoGenWfFileParams",
  "videoGenWfTextParam",
  "customWfInputCount",
  "customWfSlotMeta",
  "inPortIsSpare",
  "inPortWireCount",
  "firstFreeInPortIndex",
  "isAssetNode",
  "assetInWireAt",
  "assetInPortOccupied",
  "superDynamicPortCount",
  "superIsOpenShell",
  "isToolNode",
  "isFunctionNode",
  "isFnToolNode",
  "fnToolParamList",
  "fnToolPortKind",
  "fnToolInPortOccupied",
  "fnToolOutPortOccupied",
  "fnToolFreePortIndex",
  "fnToolInPortIsControl",
  "fnToolOutPortIsControl",
  "superExternalInWiresAll",
  "superInternalBridgeWiresAll",
  "superExternalOutWiresAll",
  "superInternalOutFeedsAll",
  "nodeKindLabel",
  "nodeKindPurposeKey",
  "splitCtxParenLabel",
  "mediaFileUrlOf",
  "pathFromMediaUrl",
  "pathFromMediaValue",
  "mediaInputValueOf",
];
const NODES_FNS = [
  "connectError",
  "dataNodeControlInPort",
  "addWire",
  "wouldCycle",
  "logicalDataEdgesFromWire",
  "buildLogicalWireAdj",
  "reachableInAdj",
  "nextFreeMediaDataSlot",
  "wireActsAsImage",
  "wireActsAsText",
  "wireParamKind",
  "fnToolFreePortForMedia",
  "nextFreeVideoPostSlot",
  "fnToolInPortIndex",
  "fnToolInPortTypeError",
  "isMediaGenNode",
  "musicGenSlotText",
  "fetchMediaBackendStatus",
  "ttsVoicesFromStatus",
  "ttsDefaultVoiceFromStatus",
  "ttsSpeedOf",
  "ttsFormatOf",
  "ttsErrorText",
  "ensureTtsBackendReady",
  "playTtsGenNode",
];
const SCALAR_CONSTS = {
  "renderer/app.js": ["DEFAULT_IMAGE_SIZE", "IN_PORT_DATA_KINDS"],
  "renderer/app-nodes.js": ["TTS_API_POLL_MS", "TTS_API_WAIT_MS"],
};
vm.runInContext(
  [
    extractConsts(appSrc, SCALAR_CONSTS["renderer/app.js"]),
    extractConsts(nodesSrc, SCALAR_CONSTS["renderer/app-nodes.js"]),
    extract(appSrc, APP_FNS),
    extract(nodesSrc, NODES_FNS),
  ].join("\n"),
  sandbox,
  { filename: "media-gen-menu-extract.js" },
);
const F = new Proxy({}, { get: (_t, k) => G(String(k)) });

/* ---------- 菜单读法：一级子菜单 = { label, submenu } ---------- */
const menuGroups = () => F.canvasCreateMenuGroups({ x: 120, y: 80 });
const groupOf = (title) => (menuGroups().find((g) => g[0] === title) || [null, []])[1];
const subOf = (items, label) => {
  const it = (items || []).find((x) => x.label === label);
  return it && Array.isArray(it.submenu) ? it : null;
};
/* 真实 ctxKindItem 不带 kind（那是渲染层的事）：跑一次 run() 看它建出哪一类 */
const kindsBuiltBy = (items) => {
  added.length = 0;
  for (const it of items) it.run();
  return added.map((n) => n.kind);
};
const labelsOf = (items) => items.map((it) => it.label);

function scene(nodes, wires) {
  S.wf = { nodes: (nodes || []).slice(), wires: (wires || []).slice() };
}
const mk = (id, kind, extra) =>
  Object.assign({ id, kind, title: id, parentSuperId: "", parentTaskId: "" }, extra || {});

(async function main() {
  console.log("\n[ex] 源码抽取自检");
  eqArr(
    APP_FNS.filter((n) => !["KIND_CLS", "NODE_DEFAULTS"].includes(n)).filter(
      (n) => typeof G(n) !== "function",
    ),
    [],
    "app.js 目标函数全部抽到真实实现",
  );
  eqArr(
    NODES_FNS.filter((n) => typeof G(n) !== "function"),
    [],
    "app-nodes.js 目标函数全部抽到真实实现",
  );
  /* NODE_DEFAULTS 是数据块（ initializer 引用别的常量），按源码文本核对，不塞进沙箱 */
  const ndBlock = (() => {
    const at = appSrc.indexOf("const NODE_DEFAULTS = {");
    const end = appSrc.indexOf("\n};", at);
    return at < 0 ? "" : appSrc.slice(at, end);
  })();
  const ndKinds = new Set([...ndBlock.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]));
  ok(ndKinds.has("tts_gen"), "NODE_DEFAULTS 里有 tts_gen 的默认值");
  const ttsDefaults = (ndBlock.match(/tts_gen:\s*\{([\s\S]*?)\},/) || [null, ""])[1];
  has(ttsDefaults, 'title: "SoVITS 语音节点"', "新建 tts_gen 的默认标题");
  for (const f of ["voice", "speed", "ttsFormat", "outputPath", "attempts"])
    has(ttsDefaults, f + ":", "tts_gen 默认值带 " + f + " 字段");

  /* ===================== [1] 四个一级子菜单 ===================== */
  console.log("\n[1] 画布右键 · 处理节点：文本生成 / 图像生成 / 视频生成 / 音频生成 四个一级子菜单");
  const proc = groupOf("处理节点（提示词 + Play）");
  ok(proc.length > 0, "「处理节点」分组存在");
  const subLabels = proc.filter((it) => Array.isArray(it.submenu)).map((it) => it.label);
  eqArr(
    subLabels,
    ["文本生成", "图像生成", "视频生成", "音频生成"],
    "「处理节点」里的一级子菜单正好是文本生成 + 图像生成 + 视频生成 + 音频生成",
  );
  const iSub = subOf(proc, "图像生成");
  ok(!!iSub, "「图像生成」一级子菜单存在（云端文生图 + 本地 SenseNova 收在一处）");
  eqArr(
    labelsOf(iSub.submenu),
    ["文生图（云端服务商 · 图像生成）", "SenseNova（本地图像生成 · SenseNova-U1.5-8B-MoT）"],
    "「图像生成」成员：云端文生图 → SenseNova 本地图像生成",
  );
  eqArr(
    kindsBuiltBy(iSub.submenu),
    ["proc_image", "sensenova_gen"],
    "选「图像生成」成员 → 真实建出 proc_image / sensenova_gen",
  );
  const vSub = subOf(proc, "视频生成");
  const aSub = subOf(proc, "音频生成");
  eqArr(
    labelsOf(vSub.submenu),
    [
      "Minimax H3（视频生成 · 文本 / 图像 / 音频 / 视频）",
      "视频超分（Real-ESRGAN x4 / x2 超分 · 独立后处理）",
      "视频补帧（RIFE 补帧 · 独立后处理）",
      "Remotion 视频（React 动效合成）",
    ],
    "「视频生成」成员：Minimax H3 → 视频超分 → 视频补帧 → Remotion 视频",
  );
  eqArr(
    labelsOf(aSub.submenu),
    [
      "Minimax Music 3（音乐生成 · 提示词 + 歌词）",
      "YuE2（歌词→整曲 · 可编辑谱面）",
      "SoVITS 语音生成（文本转语音 · GPT-SoVITS）",
    ],
    "「音频生成」成员：Minimax Music 3 → YuE2 → SoVITS 语音生成",
  );
  eqArr(
    kindsBuiltBy(vSub.submenu),
    ["video_gen", "video_upscale", "video_interp", "remotion"],
    "选「视频生成」成员 → 真实建出 video_gen / video_upscale / video_interp / remotion",
  );
  eqArr(kindsBuiltBy(aSub.submenu), ["music_gen", "yue_gen", "tts_gen"], "选「音频生成」成员 → 真实建出 music_gen / yue_gen / tts_gen");
  /* 子菜单成员按插件安装态变化：必须重新读一次菜单（旧数组是上一次构建的结果） */
  remotionInstalled = false;
  eqArr(kindsBuiltBy(subOf(groupOf("处理节点（提示词 + Play）"), "视频生成").submenu), ["video_gen", "video_upscale", "video_interp"], "Remotion 插件未装时「视频生成」只剩 Minimax H3 + 超分 + 补帧");
  remotionInstalled = true;
  eqArr(kindsBuiltBy(subOf(groupOf("处理节点（提示词 + Play）"), "视频生成").submenu), ["video_gen", "video_upscale", "video_interp", "remotion"], "装了就回到四位成员");
  eqArr(
    kindsBuiltBy(proc.filter((x) => !Array.isArray(x.submenu))).filter((k) =>
      ["video_gen", "video_upscale", "video_interp", "remotion", "music_gen", "yue_gen", "tts_gen", "proc_image", "sensenova_gen"].includes(k),
    ),
    [],
    "媒体生成 / 后处理节点都不再平铺在「处理节点」一级（全收进了子菜单）",
  );
  const inGroup = groupOf("输入节点（仅输出）");
  /* 本轮需求：文本节点直接列在这一组里、排在「文件节点」之上（只想写一段文字 / 一条路径
     时不必先建文件节点再转类型）；图像 / 音频 / 视频三类仍只给泛用「文件节点」（上传什么
     文件就变成那种节点）。四类 kind 本体一律保留，兼容性口径见 test/smoke-file-node.js */
  eqArr(
    kindsBuiltBy(inGroup),
    ["input_text", "input_any"],
    "输入分组：文本节点 + 「文件节点」（图像 / 音频 / 视频三类不再平铺）",
  );
  has(inGroup[0].label, "文本节点", "第一项就是文本节点（排在文件节点之上）");
  has(inGroup[1].label, "自动转为对应节点", "「文件节点」菜单文案写明上传后自动转为对应节点");
  hasnt(
    JSON.stringify(inGroup),
    "input_image",
    "图像节点仍不单独出现在画布右键「输入节点」分组里（走文件节点自动转换）",
  );

  /* ===================== [1b] 一级菜单「工具」＝工具 / 函数节点的创建入口 =====================
   * 顶栏不再有创建入口（那一格改叫「工具库」，只管理已保存的工具包）；两类节点的
   * 新建回到画布右键菜单，收在一个名为「工具」的一级子菜单下。 */
  console.log("\n[1b] 画布右键 · 「工具」一级菜单（工具 / 函数节点的创建入口）");
  const allMenuItems = () => [].concat(...menuGroups().map((g) => g[1] || []));
  {
    const tSub = subOf(allMenuItems(), "工具");
    ok(!!tSub, "顶层画布右键菜单里有「工具」一级菜单（不必再从顶栏建节点）");
    eqArr(
      labelsOf(tSub.submenu),
      ["工具（Agent 可调用 · 入参出参端子）", "函数（JS 计算 · 自定义入参出参）"],
      "「工具」二级成员：工具节点在前、函数节点在后",
    );
    eqArr(
      kindsBuiltBy(tSub.submenu),
      ["tool", "function"],
      "点二级成员 → 真实建出 tool / function（形态换算在 makeNode，菜单只交 kind）",
    );
    ok(
      !allMenuItems().some((it) => !Array.isArray(it.submenu) && /^(工具|函数)（/.test(it.label)),
      "两类节点不再平铺在一级（全收进「工具」子菜单）",
    );
    /* 壳层口径：流程壳（普通超级 / 工具壳）里继续列 → 工具内部可套工具与函数；
       开发 / 数据库壳是架构与事实容器，不列。 */
    const withHost = (host) => {
      sandbox.superHostAtWorld = () => host;
      const r = !!subOf(allMenuItems(), "工具");
      sandbox.superHostAtWorld = () => null;
      return r;
    };
    ok(withHost({ id: "sh", kind: "super", title: "sh" }), "展开的流程壳内右键仍列「工具」");
    ok(withHost({ id: "sh", kind: "super", tool: true, title: "sh" }), "工具壳内右键仍列「工具」（工具里能继续套工具 / 函数）");
    ok(!withHost({ id: "sh", kind: "super", db: true, title: "sh" }), "数据库壳层内不列「工具」");
    ok(!withHost({ id: "sh", kind: "super", dev: true, title: "sh" }), "开发壳层内不列「工具」");
  }

  /* ===================== [2] 改名口径与旧文案残留 ===================== */
  console.log("\n[2] 类型名 / 用途文案改名 · 旧文案与旧 i18n 词条无残留");
  eqStr(F.nodeKindLabel({ kind: "music_gen" }), "Minimax Music 3", "music_gen 类型名改为 Minimax Music 3");
  eqStr(F.nodeKindLabel({ kind: "video_gen" }), "Minimax H3", "video_gen 类型名改为 Minimax H3");
  eqStr(F.nodeKindLabel({ kind: "video_upscale" }), "视频超分", "video_upscale 类型名为视频超分");
  eqStr(F.nodeKindLabel({ kind: "video_interp" }), "视频补帧", "video_interp 类型名为视频补帧");
  eqStr(F.nodeKindLabel({ kind: "tts_gen" }), "SoVITS 语音", "tts_gen 类型名为 SoVITS 语音");
  eqStr(F.nodeKindLabel({ kind: "input_audio" }), "音频", "input_audio 类型名为音频");
  eqStr(F.nodeKindLabel({ kind: "input_video" }), "视频", "input_video 类型名为视频");
  has(ttsDefaults, "SoVITS 语音节点", "新建 tts_gen 的默认标题仍是 SoVITS 语音节点");
  const rendererAll = appSrc + "\n" + nodesSrc + "\n" + canvasSrc;
  hasnt(rendererAll, '"音乐生成（MiniMax Music 3）"', "旧 music_gen 用途文案已删");
  hasnt(rendererAll, '"视频生成（MiniMax H3', "旧 video_gen 用途文案已删");
  hasnt(rendererAll, "音频节点（仅预览", "旧「仅预览」音频菜单文案已删");
  hasnt(rendererAll, "视频节点（仅预览", "旧「仅预览」视频菜单文案已删");
  /* 界面取词（I18n.t 的键）里不能再有「仅预览 / 无输出端子」这一类旧说法 */
  const uiCopy = [...rendererAll.matchAll(/I18n\.t\(\s*"([^"]*)"/g)].map((m) => m[1]);
  ok(uiCopy.length > 100, "扫到界面取词 " + uiCopy.length + " 条");
  eqArr(
    uiCopy.filter((s) => /仅预览|暂无输出端子|无输出端子/.test(s)),
    [],
    "界面取词里没有「仅预览 / 无输出端子」这类旧说法残留",
  );
  hasnt(i18nSrc, "（仅预览", "i18n 里旧「仅预览」词条已删");
  hasnt(i18nSrc, "暂无输出端子", "i18n 里旧「暂无输出端子」词条已删");
  hasnt(i18nSrc, "仅用于选择并预览本机音视频文件", "i18n 里旧端子说明词条已删");
  const NEW_KEYS = [
    "视频生成",
    "音频生成",
    "图像生成",
    "文生图（云端服务商 · 图像生成）",
    "SenseNova（本地图像生成 · SenseNova-U1.5-8B-MoT）",
    "Minimax Music 3（音乐生成 · 提示词 + 歌词）",
    "Minimax H3（视频生成 · 文本 / 图像 / 音频 / 视频）",
    "视频超分（Real-ESRGAN x4 / x2 超分 · 独立后处理）",
    "视频补帧（RIFE 补帧 · 独立后处理）",
    "视频超分",
    "视频补帧",
    "SoVITS 语音生成（文本转语音 · GPT-SoVITS）",
    "Minimax Music 3",
    "Minimax H3",
    "SoVITS 语音",
    "SoVITS 语音节点",
    "音频节点（选择文件 · 输出 URL）",
    "视频节点（选择文件 · 输出 URL）",
    "音频输入（输出该文件的 URL）",
    "视频输入（输出该文件的 URL）",
    "音频输入 · 输出该文件的 URL",
    "视频输入 · 输出该文件的 URL",
    "语音生成节点需要文本来源（待合成文本）",
    "语音生成节点控制输入端子为端口 1",
    "请连接文本来源（待合成文本 · 端子 T）",
    "语音合成插件未就绪",
    "启动后端并合成…",
    "语音合成中…",
    "语音已生成：",
  ];
  eqArr(
    NEW_KEYS.filter((k) => i18nSrc.indexOf('"' + k + '"') < 0),
    [],
    "新用到的中文文案在 i18n 里都有英文词条",
  );
  eqArr(
    ["music_gen", "video_gen", "video_upscale", "video_interp", "tts_gen", "remotion", "input_audio", "input_video"].filter((k) => {
      const key = F.nodeKindPurposeKey({ kind: k });
      return !key || i18nSrc.indexOf('"' + key + '"') < 0;
    }),
    [],
    "八类媒体节点的用途文案都有英文词条",
  );
  /* 文档口径：tts_gen 要有节点指南，并且中英都齐 */
  const gdir = path.join(__dirname, "..", "guides", "nodes");
  ok(fs.existsSync(path.join(gdir, "tts_gen.md")), "guides/nodes/tts_gen.md 存在");
  ok(fs.existsSync(path.join(gdir, "en", "tts_gen.md")), "guides/nodes/en/tts_gen.md 存在");
  const nodeIdx = JSON.parse(read("guides/nodes/index.json"));
  ok(nodeIdx.ids.indexOf("tts_gen") >= 0, "tts_gen 已进节点指南索引");
  eqStr(nodeIdx.ids[nodeIdx.ids.indexOf("music_gen") + 1], "yue_gen", "索引里 yue_gen 紧跟 music_gen（音频生成三类相邻）");
  eqStr(nodeIdx.ids[nodeIdx.ids.indexOf("yue_gen") + 1], "tts_gen", "索引里 tts_gen 紧跟 yue_gen");
  const ttsGuide = read("guides/nodes/tts_gen.md");
  has(ttsGuide, "GPT-SoVITS", "语音节点指南写明后端");
  has(ttsGuide, "音频生成", "语音节点指南写明新的菜单位置");
  has(read("guides/nodes/input_audio.md"), "file:///", "音频输入指南写明输出 URL");
  hasnt(read("guides/nodes/input_audio.md") + read("guides/nodes/input_video.md"), "暂无输出端子", "节点指南里没有旧的「暂无输出端子」说法");
  /* 视频后处理两类（超分 / 补帧）也各要中英指南 + 进索引 */
  ["video_upscale", "video_interp"].forEach((id) => {
    ok(fs.existsSync(path.join(gdir, id + ".md")), "guides/nodes/" + id + ".md 存在");
    ok(fs.existsSync(path.join(gdir, "en", id + ".md")), "guides/nodes/en/" + id + ".md 存在");
    ok(nodeIdx.ids.indexOf(id) >= 0, id + " 已进节点指南索引");
  });
  has(read("guides/nodes/video_upscale.md"), "视频生成", "超分指南写明新的菜单位置");
  has(read("guides/nodes/video_interp.md"), "视频生成", "补帧指南写明新的菜单位置");

  /* ===================== [3] tts_gen 端子契约 ===================== */
  console.log("\n[3] tts_gen 端子：2 入（文本 / 控制）· 2 出（音频 / 控制）");
  const tts = mk("tts", "tts_gen");
  const txt = mk("txt", "input_text", { text: "把这段念出来" });
  const txt2 = mk("txt2", "input_text", { text: "再来一段" });
  const img = mk("img", "input_image");
  const ctl = mk("ctl", "control");
  const save = mk("save", "save", { savePath: "o.wav" });
  scene([tts, txt, img, ctl, save]);
  eqNum(F.inputCount(tts), 2, "tts_gen 输入端子数");
  eqNum(F.outputCount(tts), 2, "tts_gen 输出端子数（0=音频 · 1=控制）");
  eqNum(F.outputCount(mk("a", "input_audio")), 1, "input_audio 输出端子数");
  eqNum(F.outputCount(mk("v", "input_video")), 1, "input_video 输出端子数");
  ok(F.nodeEmitsControlOnPort(tts, 1), "tts_gen 端口1 是控制输出");
  ok(!F.nodeEmitsControlOnPort(tts, 0), "tts_gen 端口0 是数据输出（音频）");
  ok(F.isMediaGenNode(tts), "tts_gen 归入媒体生成族（串行链 / 进度 / 终止同一套）");
  eqStr(F.inferMediaFromSource(tts, 0), "audio", "tts_gen 的输出按音频判定");
  /* connectError(fromId, toId, toIndex, fromIndex) —— 全部走真实函数 */
  const CE = (from, to, toIndex, fromIndex) => F.connectError(from, to, toIndex, fromIndex) || "";
  eqStr(CE("txt", "tts", 0, 0), "", "文本 → tts_gen 端口0：放行");
  has(CE("img", "tts", 0, 0), "需要文本来源", "图像 → tts_gen 端口0：拒绝（要文本来源）");
  has(CE("txt", "tts", 1, 0), "无效的输入端子", "数据线连到端口1：拒绝（端口1 是控制口）");
  eqStr(CE("ctl", "tts", 1, 0), "", "控制线 → 端口1：放行");
  has(CE("ctl", "tts", 0, 0), "控制输入端子为端口 1", "控制线连到端口0：拒绝并说明正确端口");
  eqStr(CE("ctl", "tts", null, 0), "", "控制线未指定端子 → 自动落控制输入");
  scene([tts, txt, txt2, img, ctl, save], [{ from: "txt", to: "tts", fromIndex: 0, toIndex: 0 }]);
  has(CE("txt2", "tts", 0, 0), "已被占用", "第二个文本来源被拒（唯一的文本端子已占用）");
  eqStr(F.nextFreeMediaDataSlot(tts, txt2, 0), null, "nextFreeMediaDataSlot：唯一数据端子被占 → null");
  scene([tts, txt, txt2, img, ctl, save], [{ from: "txt", to: "tts", fromIndex: 0, toIndex: 1 }]);
  has(CE("ctl", "tts", 1, 0), "控制输入端子已被数据线占用", "控制口被数据线占了 → 控制线也连不上");
  scene([tts, txt, txt2, img, ctl, save], [{ from: "ctl", to: "tts", fromIndex: 0, toIndex: 1 }]);
  has(CE("ctl", "tts", 1, 0), "已连接", "同一对节点不重复连（含控制线）");
  eqStr(CE("txt2", "tts", 0, 0), "", "控制线占着端口1 时，文本线仍可连端口0");
  scene([tts, txt, txt2, img, ctl, save]);
  eqStr(CE("tts", "save", 0, 0), "", "tts_gen 端口0 的音频可连保存节点");
  has(CE("tts", "save", 0, 2), "没有输出端子", "端子序号越界（tts_gen 只有 0=音频 / 1=控制）被拦下");

  /* ===================== [4] 执行链与合成桥接 ===================== */
  console.log("\n[4] playNodeBody 分发 · 串行链注册 · playTtsGenNode 真实跑通");
  const bodySrc = fnBody(nodesSrc, "playNodeBody");
  has(bodySrc, 'node.kind === "tts_gen"', "playNodeBody 认识 tts_gen");
  has(bodySrc, "runMediaGenSerial(node, () => playTtsGenNode(node, quiet))", "tts_gen 走媒体串行链（同一时刻只跑一个生成任务）");
  has(fnBody(nodesSrc, "isMediaGenNode"), '"tts_gen"', "isMediaGenNode 名单里有 tts_gen");
  has(fnBody(appSrc, "valueForInput"), "tts_gen", "valueForInput 知道 tts_gen 的输出值");
  has(fnBody(appSrc, "outputCount"), '"tts_gen"', "outputCount 认识 tts_gen（音频 + 控制两个端子）");
  /* 音乐 / 语音 / 视频三类都挂在同一条串行链上（同一时刻只跑一个生成任务） */
  const serialWrapped = (k) =>
    new RegExp('node\\.kind === "' + k + '"[\\s\\S]{0,200}runMediaGenSerial\\(').test(bodySrc);
  ok(
    ["music_gen", "tts_gen", "video_gen", "remotion"].every(serialWrapped),
    "四类生成节点全部经 runMediaGenSerial 排队",
  );
  /* SoVITS 走自己的管理进程：不持主进程那份「全局仅 1 个音视频任务」的锁（只有 music3 / h3 抢它） */
  hasnt(fnBody(nodesSrc, "playTtsGenNode"), "requireMediaGenGlobalLock", "语音合成不参与全局音视频锁");
  has(lockSrc, "tts_gen", "全局锁模块认识 tts_gen（忙时提示按「语音」说）");
  has(lockSrc, '"语音"', "忙时文案区分「语音」");

  scene([tts, txt, img, ctl, save], [{ from: "txt", to: "tts", fromIndex: 0, toIndex: 0 }]);
  ttsCalls = [];
  ctrlFired.length = 0;
  tts.speed = 3; /* 越界 → 夹到 2.0 */
  tts.ttsFormat = "mp3";
  tts.output = null;
  tts.error = null;
  await F.playTtsGenNode(tts, true);
  eqNum(ttsCalls.length, 1, "合成请求发出一次（真实 playTtsGenNode → api.ttsGenerate）");
  const call = ttsCalls[0] || {};
  eqStr(call.text, "把这段念出来", "待合成文本取自端口0 的上游文本节点");
  eqStr(call.voice, "v1", "节点没选音色 → 用后端音色清单的第一个");
  eqNum(call.speed, 2, "语速越界被夹到 2.0");
  eqStr(call.response_format, "mp3", "输出格式按节点参数下发");
  eqStr(call.outputPath, "E:/out/voice.wav", "输出路径来自主进程的导出解析");
  eqStr(call.nodeId, "tts", "请求带 nodeId（主进程按节点取消 / 进度归位）");
  eqStr(tts.output && tts.output.kind, "audio", "节点输出值标记为音频");
  eqStr(tts.output && tts.output.path, "E:/out/voice.wav", "节点输出值带本机路径");
  eqNum(tts.running, false, "跑完置回非运行态");
  eqArr(ctrlFired.map((c) => c.port), [1], "生成完成后驱动端口1 的控制输出");
  /* 没接文本来源：按端子缺失报错，不发请求 */
  scene([tts, txt, img, ctl, save]);
  ttsCalls = [];
  tts.output = null;
  tts.error = null;
  await F.playTtsGenNode(tts, true);
  eqNum(ttsCalls.length, 0, "没接文本来源时不发合成请求");
  has(tts.error, "请连接文本来源", "节点状态行写明缺的是哪个端子");
  /* 后端错误码 → 能照着做的中文提示 */
  eqStr(F.ttsErrorText("voice_not_found"), "音色不存在（请重新选择音色）", "错误码翻译成中文提示");
  has(F.ttsErrorText('{"detail":"no_voice"}'), "没有可用音色", "FastAPI 的 detail 体也能翻译");
  eqStr(F.ttsFormatOf({}), "wav", "输出格式默认 wav");
  eqNum(F.ttsSpeedOf({ speed: 0.1 }), 0.5, "语速下限 0.5");
  eqNum(F.ttsSpeedOf({}), 1, "语速缺省 1.0");

  /* ===================== [5] 音视频输入节点的输出值 ===================== */
  console.log("\n[5] 音频 / 视频输入节点：输出端子给 file:/// URL");
  const aIn = mk("ain", "input_audio", { mediaAsset: "E:/素材/人声 1.wav" });
  const vIn = mk("vin", "input_video", { mediaAsset: "E:/clips/demo.mp4" });
  const emptyIn = mk("ain0", "input_audio", { mediaAsset: "" });
  const av = F.mediaInputValueOf(aIn);
  ok(!!av, "选了文件的音频节点给出端子值");
  eqStr(av.kind, "audio", "音频节点值标记 kind=audio");
  eqStr(av.path, "E:/素材/人声 1.wav", "值里保留本机绝对路径");
  has(av.url, "file:///", "值里带 file:/// URL");
  eqStr(av.text, av.url, "文本口径（@引用 / 下游展示）就是这个 URL");
  has(av.url, "%E4%BA%BA%E5%A3%B0", "URL 里中文文件名被百分号编码");
  has(av.url, "1.wav", "空格被编码、文件后缀仍可辨认");
  eqStr(F.mediaInputValueOf(vIn).kind, "video", "视频节点值标记 kind=video");
  eqStr(F.mediaInputValueOf(emptyIn), null, "没选文件 = 未就绪（null，不硬造 URL）");
  ok(F.isTextSource(aIn), "音频节点算文本来源（URL 是字符串，进得了只吃文本的端子）");
  ok(F.isRefableSource(aIn), "音频节点可被 @ 引用");
  eqStr(F.inferMediaFromSource(aIn, 0), "audio", "音频输入按音频判定");
  eqStr(F.inferMediaFromSource(vIn, 0), "video", "视频输入按视频判定");
  eqStr(F.wireSourceMediaType(aIn, 0), "audio", "端子级媒体类型 = audio");
  has(appSrc, "return mediaInputValueOf(src);", "valueForInput 的分发里真的取了这个值");
  hasnt(canvasSrc, "无输出端子", "画布渲染层不再说输入节点「无输出端子」");

  /* ===================== [6] URL ⇄ 路径归一 ===================== */
  console.log("\n[6] file:// URL ⇄ 本机绝对路径 归一（逐例）");
  /* 生产口径：走主进程桥（Node pathToFileURL）。关键是「能来回」：URL 归一后就是原文件路径 */
  for (const p of ["E:/素材/人声 1.wav", "E:\\a b\\c.wav", "E:/out/voice.wav", "C:/Program Files/x/歌.mp3"]) {
    const u = F.mediaFileUrlOf(p);
    has(u, "file:///", "路径 → URL 前缀：" + p);
    eqStr(F.pathFromMediaUrl(u), p.replace(/\//g, "\\"), "URL → 路径来回一致：" + p);
  }
  eqStr(F.mediaFileUrlOf("file:///E:/x.wav"), "file:///E:/x.wav", "已是 URL：原样返回（不二次编码）");
  eqStr(F.mediaFileUrlOf(""), "", "空路径不给 URL");
  /* 没有桥的环境（测试沙箱 / 未来别的宿主）：回退算法必须给出同一个口径 */
  const bridge = sandbox.window.api.toFileUrl;
  sandbox.window.api.toFileUrl = undefined;
  eqStr(F.mediaFileUrlOf("E:/素材/人声 1.wav"), "file:///E:/%E7%B4%A0%E6%9D%90/%E4%BA%BA%E5%A3%B0%201.wav", "回退算法与桥同口径（盘符不编码 · 中文百分号编码）");
  eqStr(F.mediaFileUrlOf("E:\\a b\\c.wav"), "file:///E:/a%20b/c.wav", "回退算法把反斜杠统一成正斜杠");
  eqStr(F.mediaFileUrlOf("/home/u/m/人声.wav"), "file:///home/u/m/%E4%BA%BA%E5%A3%B0.wav", "回退算法支持 POSIX 路径");
  sandbox.window.api.toFileUrl = bridge;
  eqStr(F.pathFromMediaUrl("file:///home/u/m/%E4%BA%BA%E5%A3%B0.wav"), "/home/u/m/人声.wav", "URL → POSIX 路径（不乱翻斜杠）");
  eqStr(F.pathFromMediaUrl("file://nas/share/%E5%A3%B0.wav"), "\\\\nas\\share\\声.wav", "UNC 共享路径归一成 \\\\host\\share");
  eqStr(F.pathFromMediaUrl("E:/plain/path.wav"), "E:/plain/path.wav", "非 URL 原样返回");
  eqStr(F.pathFromMediaUrl("plain text"), "plain text", "既不是路径也不是 URL：原样返回，可无脑套在任何取数口");
  eqStr(F.pathFromMediaUrl(""), "", "空 URL 归一为空");
  eqStr(F.pathFromMediaValue({ kind: "audio", path: "file:///E:/x.wav", url: "file:///E:/y.wav" }), "E:\\x.wav", "值里有 path 时优先用 path");
  eqStr(F.pathFromMediaValue({ kind: "text", text: "file:///E:/y.wav" }), "E:\\y.wav", "裸 URL 文本也能归一");
  eqStr(F.pathFromMediaValue("file:///E:/z.wav"), "E:\\z.wav", "字符串入参同样归一");
  eqStr(F.pathFromMediaValue({ kind: "video", url: "file:///E:/v.mp4" }), "E:\\v.mp4", "只有 url 字段时用它");
  eqStr(F.pathFromMediaValue({ kind: "image", path: "E:/a.png" }), "E:/a.png", "图片端子值不受影响（非 URL 原样）");
  eqStr(F.pathFromMediaValue(null), "", "空值归一为空串");
  /* 消费点：H3 的参考音频 / 视频端子拿到的是本机路径，不是 URL */
  has(fnBody(nodesSrc, "videoGenSlotValue"), "pathFromMediaValue", "H3 端子取值走归一");
  has(fnBody(nodesSrc, "saveMediaFileOnce"), "pathFromMediaValue", "保存节点复制媒体源也走归一");

  /* ===================== [7] H3 R2V 参考音频端子 ===================== */
  console.log("\n[7] Minimax H3（端子布局 v5 · 控制输入固定端口 0）：参考音频与拖线落点");
  const h3r = mk("h3r", "video_gen", { videoMode: "r2v" });
  const h3f = mk("h3f", "video_gen", { videoMode: "fl2va" });
  const ctlSrc = mk("ctl", "control");
  eqNum(F.videoGenMaxAudios(h3r), 3, "R2V 支持 3 个参考音频");
  eqNum(F.videoGenMaxAudios(h3f), 0, "FL2VA 没有参考音频端子（零回归）");
  scene([h3r, h3f, ctlSrc, aIn, vIn, txt]);
  eqNum(F.videoGenInputCount(h3r), 17, "R2V：控制输入（端口 0）+ 1 提示词 + 9 图 + 3 视频 + 3 音频 = 17 个端子");
  eqArr(
    [1, 2, 10, 11, 13, 14, 16].map((i) => F.videoGenSlotMeta(h3r, i).kind),
    ["text", "image", "image", "video", "video", "audio", "audio"],
    "数据槽号（1 起始）：P=1 · 图 2..10 · 视频 11..13 · 音频 14..16",
  );
  eqStr(F.videoGenSlotMeta(h3r, 14).label, "A1", "14 号数据槽 = 第一个参考音频 A1");
  eqStr(F.videoGenSlotMeta(h3r, 16).label, "A3", "16 号数据槽 = 第三个参考音频 A3");
  eqNum(F.videoGenControlPort(h3r), 0, "R2V 控制输入 = 端口 0（v5：固定放在第一个端子）");
  /* 回归：端子排必须逐号有落得住的元数据，且端口 0 正是控制口、数据端口号 ≡ 数据槽号
     （历史 bug：控制口写 N+1 越界 → 那颗控制端子根本不渲染、端口 0 显示成一个错槽） */
  eqArr(
    [0, 1, 16].map((i) => (F.videoGenPortMeta(h3r, i) || {}).kind),
    ["ctrl", "text", "audio"],
    "R2V 端子排：端口 0=控制 · 1=提示词 · 16=最后一个音频（数据端口号 ≡ 数据槽号）",
  );
  eqNum(F.videoGenPortMeta(h3r, 17), null, "越界端口没有端子（不再猜一个槽出来）");
  ok(!F.videoGenIsDataPort(h3r, 0), "端口 0 不是数据端子（数据线不得占控制口）");
  ok(F.videoGenIsDataPort(h3r, 1), "端口 1 起才是数据端子");
  eqNum(F.videoGenInputCount(h3f), 4, "FL2VA：控制 + 提示词 + 首末帧 = 4");
  eqNum(F.videoGenControlPort(h3f), 0, "FL2VA 控制输入 = 端口 0（与超分 / 补帧 / Remotion 同构）");
  eqArr(
    [0, 1, 2, 3].map((i) => (F.videoGenPortMeta(h3f, i) || {}).kind),
    ["ctrl", "text", "image", "image"],
    "FL2VA 端子排：端口 0=控制 · 1=提示词 · 2=首帧 · 3=末帧",
  );
  eqArr(
    [1, 2, 3].map((i) => F.videoGenSlotMeta(h3f, i).kind),
    ["text", "image", "image"],
    "FL2VA 数据槽号不变：1 提示词 · 2 首帧 · 3 末帧",
  );
  /* ---- 分段衔接（长视频无缝衔接）：勾选后多一个「↩ 上一段视频」槽，位置按模式分 ---- */
  eqNum(F.videoGenMaxChains(h3f), 0, "未勾选衔接：FL2VA 不加槽（默认零回归）");
  eqNum(F.videoGenMaxChains(h3r), 0, "未勾选衔接：R2V 不加槽（默认 16 个数据槽 · 零回归）");
  eqNum(F.videoGenChainSlotIndex(h3f), 0, "未勾选衔接：没有衔接槽（槽号 0 = 不存在，不会误命中提示词槽）");
  const h3c = mk("h3c", "video_gen", { videoMode: "fl2va", chainEnabled: true });
  const h3rc = mk("h3rc", "video_gen", { videoMode: "r2v", chainEnabled: true });
  const h3cCustom = mk("h3cc", "video_gen", { videoMode: "fl2va", chainEnabled: true, workflowId: "wf-1" });
  const h3rcCustom = mk("h3rcc", "video_gen", { videoMode: "r2v", chainEnabled: true, workflowId: "wf-1" });
  scene([h3r, h3f, h3c, h3rc, ctlSrc, aIn, vIn, txt]);
  eqNum(F.videoGenMaxChains(h3c), 1, "勾选衔接：内置 FL2VA 多一个数据槽");
  eqNum(F.videoGenMaxChains(h3rc), 1, "勾选衔接：内置 R2V（多参考）同样多一个数据槽");
  eqNum(F.videoGenMaxChains(h3cCustom), 0, "自建工作流模式不加衔接槽（端口由参数表决定）");
  eqNum(F.videoGenMaxChains(h3rcCustom), 0, "自建工作流 + R2V 也不加衔接槽");
  eqNum(F.videoGenInputCount(h3c), 5, "FL2VA 开衔接：控制 + 提示词 + 首末帧 + ↩ 上一段视频 = 5 个端子");
  eqNum(F.videoGenControlPort(h3c), 0, "开衔接：控制输入仍在端口 0（不随数据槽数顺延）");
  eqArr(
    [0, 1, 2, 3, 4].map((i) => (F.videoGenPortMeta(h3c, i) || {}).kind),
    ["ctrl", "text", "image", "image", "video"],
    "FL2VA 开衔接端子排：端口 0 控制 · 1 提示词 · 2 首帧 · 3 末帧 · 4 = ↩ 上一段视频",
  );
  eqNum(F.videoGenPortMeta(h3c, 5), null, "开衔接后越界端口仍没有端子");
  eqNum(F.videoGenSlotMeta(h3c, 4).kind, "video", "FL2VA 数据槽 4 = 视频类端子（接上一段成片）");
  eqNum(F.videoGenSlotMeta(h3c, 4).key, "chain", "FL2VA 数据槽 4 的 key = chain（取值/下发按它）");
  eqNum(F.videoGenSlotMeta(h3c, 4).label, "↩", "FL2VA 数据槽 4 端子标签 = ↩");
  eqArr(
    [1, 2, 3, 4].map((i) => F.videoGenSlotMeta(h3c, i).kind),
    ["text", "image", "image", "video"],
    "FL2VA 开衔接数据槽号：1 提示词 · 2 首帧 · 3 末帧 · 4 ↩ 上一段视频",
  );
  /* R2V（多参考）开衔接 —— 防回归重点：衔接槽**必须排在参考音频组之后**（槽 17）。
     照搬 FL2VA 的「末帧之后」判定在 R2V 下命中的位置正好是 A1，会把参考音频端子吃掉。 */
  eqNum(F.videoGenDataSlotsTotal(h3r), 16, "R2V 未开衔接：16 个数据槽（图 2..10 · 视频 11..13 · 音频 14..16）");
  eqNum(F.videoGenDataSlotsTotal(h3rc), 17, "R2V 开衔接：17 个数据槽（衔接槽排在音频组之后）");
  eqNum(F.videoGenInputCount(h3rc), 18, "R2V 开衔接：控制（端口 0）+ 16 原有 + ↩ = 18 个端子");
  eqNum(F.videoGenControlPort(h3rc), 0, "R2V 开衔接：控制输入仍固定在端口 0");
  eqNum(F.videoGenChainSlotIndex(h3rc), 17, "R2V 的衔接槽号 = 17（不是照搬 FL2VA 的 4）");
  eqNum(F.videoGenChainSlotIndex(h3c), 4, "FL2VA 的衔接槽号 = 4（紧跟首 / 末帧）");
  eqArr(
    [11, 12, 13, 14, 15, 16, 17].map((i) => F.videoGenSlotMeta(h3rc, i).label),
    ["V1", "V2", "V3", "A1", "A2", "A3", "↩"],
    "R2V 开衔接：V1–V3 / A1–A3 槽号一个没动，↩ 只追加在末尾（参考音频未被顶掉）",
  );
  eqArr(
    [14, 15, 16].map((i) => F.videoGenSlotMeta(h3rc, i).kind),
    ["audio", "audio", "audio"],
    "R2V 开衔接后槽 14..16 仍是三个参考音频（衔接槽没侵占音频组）",
  );
  eqNum(F.videoGenSlotMeta(h3rc, 17).kind, "video", "R2V 数据槽 17 = 视频类端子（接上一段成片）");
  eqNum(F.videoGenSlotMeta(h3rc, 17).key, "chain", "R2V 数据槽 17 的 key = chain");
  eqNum(F.videoGenSlotMeta(h3rc, 17).label, "↩", "R2V 数据槽 17 端子标签 = ↩");
  eqNum(F.videoGenSlotMeta(h3rc, 4).label, "I3", "R2V 开衔接不动原槽：4 号仍是参考图 I3（≠ FL2VA 的衔接槽）");
  eqArr(
    [16, 17, 18].map((i) => (F.videoGenPortMeta(h3rc, i) || {}).kind),
    ["audio", "video", null],
    "R2V 开衔接端子排：端口 16=A3 · 17=↩（视频类）· 18 越界无端子",
  );
  eqNum(F.videoGenPortMeta(h3rc, 18), null, "R2V 开衔接后越界端口没有端子（不再猜一个槽出来）");
  eqNum(F.nextFreeMediaDataSlot(h3r, aIn, 0), 14, "音频来源落参考音频端子 A1（端口 14 · 不挤提示词槽、更不占控制口）");
  eqNum(F.nextFreeMediaDataSlot(h3r, vIn, 0), 11, "视频来源落参考视频端子 V1（端口 11）");
  eqNum(F.nextFreeMediaDataSlot(h3r, txt, 0), 1, "文本来源落提示词槽（端口 1 = 数据槽 1）");
  const h3r2 = mk("h3r2", "video_gen", { videoMode: "r2v" });
  scene([h3r2, aIn, vIn, txt], [{ id: "wP", from: "txt", to: "h3r2", fromIndex: 0, toIndex: 1 }]);
  eqNum(F.nextFreeMediaDataSlot(h3r2, aIn, 0), 14, "提示词槽已占时，音频来源仍落 A1");
  /* 控制线落点：固定端口 0；连别处一律拒绝并指回端口 0 */
  scene([h3r, h3f, ctlSrc, aIn, vIn, txt]);
  const ce = (from, to, toIndex, fromIndex) => F.connectError(from, to, toIndex, fromIndex) || "";
  eqStr(ce("ctl", "h3r", 0, 0), "", "控制线连端口 0 → 放行（控制输入就在第一个端子）");
  eqStr(ce("ctl", "h3r", 16, 0), "视频节点控制输入端子为端口 0", "控制线连别处 → 拒绝并指回端口 0");
  eqStr(ce("txt", "h3r", 0, 0), "无效的输入端子", "数据线连端口 0 → 挡下（控制口不收数据线）");
  eqStr(ce("txt", "h3r", 1, 0), "", "数据线连端口 1（提示词）→ 放行");
  has(fnBody(nodesSrc, "buildVideoGenRunParams"), "refAudios", "画布收集参考音频路径进运行参数");
  has(read("h3/main-h3.js"), "ref_audio_", "H3 后端把参考音频接成 ref_audio_N（LoadAudio → MiniMaxH3ReferenceToVideo）");
  /* 真源核对：控制口位置只写在一处，且端子布局版本标记齐备（老档靠它迁移） */
  ok(
    /function videoGenControlPort\(node\)\s*\{\s*return 0;\s*\}/.test(appSrc),
    "H3 控制输入端口真源固定为 0（第一个端子）",
  );
  has(ndBlock, "videoPortV5: true", "新建 video_gen 默认带 v5 布局标记（旧档加载时迁移）");

  /* ===================== [8] 输入端子空闲高亮：固定端子逐号看占用 ===================== */
  console.log("\n[8] 端子空闲（变暗）判定：没接线的控制端子不得被当成已连接");
  /* 历史 bug：空闲与否一律按「端子号 ≥ 入线总数」推断 → 数据线落在靠后的端子时，
     最前面那颗根本没接线的控制端子反倒显示成已连接（被上色），真接了线的显示成空的。 */
  const rm = mk("rm", "remotion");
  scene([rm, txt], [{ id: "w1", from: "txt", to: "rm", fromIndex: 0, toIndex: 1 }]);
  ok(F.inPortIsSpare(rm, 0) === true, "Remotion：端口 0 控制口没接线 → 仍是空闲（变暗）");
  ok(F.inPortIsSpare(rm, 1) === false, "Remotion：端口 1 真接了线 → 不算空闲");
  const h3hl = mk("h3hl", "video_gen", { videoMode: "fl2va" });
  scene(
    [h3hl, ctlSrc, txt],
    [
      { id: "wc1", from: "ctl", to: "h3hl", fromIndex: 0, toIndex: 0 },
      { id: "wp1", from: "txt", to: "h3hl", fromIndex: 0, toIndex: 1 },
    ],
  );
  ok(F.inPortIsSpare(h3hl, 0) === false, "H3：控制口已接 ▶ → 不算空闲");
  ok(F.inPortIsSpare(h3hl, 1) === false, "H3：提示词端子已接 → 不算空闲");
  ok(F.inPortIsSpare(h3hl, 2) === true, "H3：首帧端子还没接 → 空闲");
  const mghl = mk("mghl", "music_gen");
  scene([mghl, ctlSrc], [{ id: "wm1", from: "ctl", to: "mghl", fromIndex: 0, toIndex: 2 }]);
  ok(F.inPortIsSpare(mghl, 0) === true, "Music3：只接了控制线 → 提示词端子仍是空闲");
  ok(F.inPortIsSpare(mghl, 2) === false, "Music3：控制端子（端口 2）已接 → 不算空闲");
  const pthl = mk("pthl", "proc_text");
  scene([pthl, txt], [{ id: "wp2", from: "txt", to: "pthl", fromIndex: 0, toIndex: 0 }]);
  ok(F.inPortIsSpare(pthl, 0) === false, "动态端子的普通节点：已挂线的号不算空闲（行为不变）");
  ok(F.inPortIsSpare(pthl, 1) === true, "动态端子的普通节点：末尾多出的空号仍显示空闲（行为不变）");
  /* 渲染层必须走这一份判定；控制口颜色要认得视频后处理节点 */
  has(canvasSrc, "inPortIsSpare(node, i)", "端子渲染的空闲判定统一问 inPortIsSpare（不再按入线总数猜）");
  hasnt(canvasSrc, "i >= wiredIn", "旧的「端子号 ≥ 入线总数」判定已从端子渲染里移除");
  /* 控制端子判定（含超分 / 补帧的端口 0）改走共享真源 inPortIsControl：
     画布端子配色 / 接线校验 / 拖线落点三处同一份归类，任一处自算一份就会错位。 */
  has(canvasSrc, "const ctrlIn = inPortIsControl(node, i);", "端子渲染的控制口判定走共享真源 inPortIsControl");
  hasnt(canvasSrc, "(isVideoPostKind(node) && i === 0)", "端子渲染不再内联复制控制口名单（同一份归类只写在 app.js）");
  has(appSrc, "function inPortIsControl(node, idx) {", "app.js 有 inPortIsControl（控制 / 数据端子归类的单一真源）");
  has(appSrc, "function inPortKindOf(node, idx) {", "app.js 有 inPortKindOf（端子声明类型的单一真源）");
  const ipcBody = fnBody(appSrc, "inPortIsControl");
  ok(ipcBody.indexOf("videoGenControlPort(node)") >= 0, "inPortIsControl 认得 H3 的控制口（端口由 videoGenControlPort 给）");
  ok(ipcBody.indexOf("isVideoPostKind(node)") >= 0, "inPortIsControl 认得超分 / 补帧的控制口（端口 0）");
  ok(ipcBody.indexOf('node.kind === "remotion"') >= 0, "inPortIsControl 认得 Remotion 的控制口（端口 0）");
  /* 同一根源的连侧：固定端子节点的通用占用判定也逐号问，不再按「端子号 < 入线总数」推断
     （历史：Remotion 文本端子先接线后，▶ 连端口 0 会被误报「该输入端子已被占用」） */
  const rm2 = mk("rm2", "remotion");
  scene([rm2, txt, ctlSrc], [{ id: "wr1", from: "txt", to: "rm2", fromIndex: 0, toIndex: 1 }]);
  eqStr(
    F.connectError("ctl", "rm2", 0, 0) || "",
    "",
    "Remotion：端口 1 已接数据线时，控制线仍能连端口 0（空闲端子不再被误判已占用）",
  );
  scene([rm2, txt, ctlSrc], [
    { id: "wr1", from: "txt", to: "rm2", fromIndex: 0, toIndex: 1 },
    { id: "wr2", from: "ctl", to: "rm2", fromIndex: 0, toIndex: 0 },
  ]);
  const txtB = mk("txtB", "input_text");
  scene([rm2, txtB], [
    { id: "wr3", from: "txt2", to: "rm2", fromIndex: 0, toIndex: 1 },
  ]);
  has(
    F.connectError("txtB", "rm2", 1, 0) || "",
    "该输入端子已被占用",
    "真占着的端子仍然照旧拒绝（不是把校验放宽）",
  );
  /* —— 动态端子的普通节点也一样：端子号有空洞时不得谎报已连接 ——
     历史规则「端子号 ≥ 入线总数 才算空闲」在空洞出现时（删过中间一条线 / 旧档显式 toIndex）
     会把空着的那颗端子当成已连接上色，而它反倒接不上线。 */
  const pth = mk("pth", "proc_text");
  const txtH = mk("txth", "input_text");
  scene(
    [pth, txt, txtH],
    [
      { id: "hd1", from: "txt", to: "pth", fromIndex: 0, toIndex: 0 },
      { id: "hd2", from: "txt", to: "pth", fromIndex: 0, toIndex: 2 },
    ],
  );
  ok(F.inPortIsSpare(pth, 1) === true, "动态端子：中间那颗空号显示空闲（旧规则按入线总数=2 谎报已连接）");
  ok(F.inPortIsSpare(pth, 2) === false, "动态端子：真挂了线的端口 2 不算空闲");
  eqStr(F.connectError("txth", "pth", 1, 0) || "", "", "动态端子：空闲的空号能补线（高亮与占用校验同一口径）");

  /* —— Minimax H3 家族：自动落点（未指定端子）绝不再踩端口 0 的控制输入 —— */
  const lastWire = () => S.wf.wires[S.wf.wires.length - 1];
  const imgIn = mk("img", "input_image");
  const h3w = mk("h3w", "video_gen", { videoMode: "fl2va" });
  scene([h3w, ctlSrc, txt, imgIn, vIn], []);
  ok(F.inPortIsSpare(h3w, 0) === true, "H3：一颗线都没接 → 端口 0 的控制口是空闲");
  F.addWire("txt", "h3w", null, { fromIndex: 0 });
  eqNum(lastWire().toIndex, 1, "H3：数据线自动落端口 1（提示词）· 旧口径落「入线总数」= 端口 0，把控制开关占掉");
  F.addWire("img", "h3w", null, { fromIndex: 0 });
  eqNum(lastWire().toIndex, 2, "H3：图像源自动落端口 2（首帧）");
  F.addWire("ctl", "h3w", null, { fromIndex: 0 });
  eqNum(lastWire().toIndex, 0, "H3：▶ 控制线自动落端口 0（固定放在第一个端子）");
  ok(F.inPortIsSpare(h3w, 0) === false, "H3：控制口已接 ▶ → 不算空闲");
  ok(F.inPortIsSpare(h3w, 3) === true, "H3：末帧端子（端口 3）还没接线 → 空闲");
  eqStr(F.connectError("vin", "h3w", 0, 0) || "", "无效的输入端子", "H3：数据线连端口 0 → 挡下（控制口不收数据线）");

  const up1 = mk("up1", "video_upscale");
  scene([up1, ctlSrc, txt, vIn], []);
  ok(F.inPortIsSpare(up1, 0) === true, "视频超分：没接线 → 控制口空闲");
  F.addWire("vin", "up1", null, { fromIndex: 0 });
  eqNum(lastWire().toIndex, 1, "视频超分：数据线自动落端口 1（源视频），绝不占端口 0");
  ok(F.inPortIsSpare(up1, 0) === true, "视频超分：只接了数据线 → 端口 0 的控制口仍是空闲（历史被上色）");
  ok(F.inPortIsSpare(up1, 1) === false, "视频超分：端口 1 真接了线 → 不算空闲");
  F.addWire("ctl", "up1", null, { fromIndex: 0 });
  eqNum(lastWire().toIndex, 0, "视频超分：▶ 控制线自动落端口 0（此前它按入线总数落到端口 1，被 connectError 判拒）");
  const ip1 = mk("ip1", "video_interp");
  scene(
    [ip1, ctlSrc, txt, vIn],
    [{ id: "wi0", from: "txt", to: "ip1", fromIndex: 0, toIndex: 1 }],
  );
  F.addWire("ctl", "ip1", null, { fromIndex: 0 });
  eqNum(lastWire().toIndex, 0, "视频补帧：源视频已接线时 ▶ 仍自动落端口 0（旧口径落端口 1 → 永远接不上）");
  eqStr(F.connectError("vin", "ip1", 0, 0) || "", "无效的输入端子", "视频补帧：端口 0 不收数据线");
  /* 自动落点补空洞，而不是堆到空洞之后 */
  const pth2 = mk("pth2", "proc_text");
  scene(
    [pth2, txt],
    [
      { id: "he1", from: "txt", to: "pth2", fromIndex: 0, toIndex: 0 },
      { id: "he2", from: "txt", to: "pth2", fromIndex: 0, toIndex: 2 },
    ],
  );
  F.addWire("txt", "pth2", null, { fromIndex: 0 });
  eqNum(lastWire().toIndex, 1, "动态端子：未指定端子的线补进空洞（端口 1），不再按入线总数落到端口 2");
  /* 真源核对：三处判定（空闲高亮 / 占用校验 / 自动落点）都逐号问，旧的顺延推断一律不在 */
  hasnt(appSrc, "Number(idx) >= allWiresTo(node.id).length", "端子渲染不再按「端子号 ≥ 入线总数」推断空闲（所有节点逐号看占用）");
  has(
    nodesSrc,
    'if (inPortWireCount(to, toIndex) > 0) return I18n.t("该输入端子已被占用");',
    "connectError 的通用占用判定对所有节点逐号问 inPortWireCount",
  );
  hasnt(nodesSrc, "toIndex < allWiresTo(toId).length", "connectError 不再按入线总数推断占用");
  has(nodesSrc, "firstFreeInPortIndex(toN)", "addWire 的动态端子落点走 firstFreeInPortIndex");
  has(nodesSrc, "nextFreeVideoPostSlot(toN)", "addWire 认得后处理节点的空闲数据槽");
  /* 输出侧同一口径：H3 家族（超分 / 补帧）的输出端子也要与 video_gen 一样点名「内容 / 控制」
     （徽标 + tooltip + zh-label 三处都认得它，用户不必猜哪颗是开关） */
  const outBlock = canvasSrc.slice(
    canvasSrc.indexOf("const oc = outputCount(node);"),
    canvasSrc.indexOf('bindPortTip(p, node, "out", oi)'),
  );
  ok(
    (outBlock.match(/isVideoPostKind\(node\)/g) || []).length >= 4,
    "后处理节点的输出端子：控制输出上色 / 徽标「内容 · 控制」/ tooltip 与视频生成同口径（得到 " +
      (outBlock.match(/isVideoPostKind\(node\)/g) || []).length +
      " 处）",
  );

  /* ===================== [9] 老画布加载：端子布局一次性归一到 v5 ===================== */
  console.log("\n[9] migrateWf 视频端子迁移：v1 / v2 / v3 / v4 全部归一到 v5（控制回端口 0）");
  {
    /* 真跑 app.js 里的 migrateWf：按名字抠函数，抠不到的（与视频端子无关的旁支）用替身，
       以免为了一个迁移分支把整个渲染层搬进沙箱。 */
    const grab = (name) => {
      try {
        return fnBody(appSrc, name);
      } catch (e) {
        /* */
      }
      try {
        return fnBody(nodesSrc, name);
      } catch (e) {
        /* */
      }
      return "function " + name + "(){ return false; }";
    };
    const MIG = [
      "migrateWf",
      "stripSuperIoNodes",
      "isSuperIoNode",
      "isSaveNode",
      "isSaveKind",
      "isVideoPostKind",
      "canUseGlobalRefs",
      "detachBoundMediaSaves",
      "isMediaGenNode",
      "isControlKind",
      "videoGenControlPort",
      "isExecStart",
      "ctrlRoleOf",
      "isExecEnd",
    ];
    const migSandbox = {
      S: { wf: { nodes: [], wires: [] } },
      I18n: { t: (k) => k },
      console,
      String, Object, Array, JSON, Number, Math, Set, Map, RegExp, Error, Boolean,
      isFinite, isNaN, parseInt, parseFloat,
    };
    vm.createContext(migSandbox);
    vm.runInContext(MIG.map((n) => grab(n)).join("\n") + "\nglobalThis.migrateWfRef = migrateWf;", migSandbox, {
      filename: "migrate-extract",
    });
    const oldWf = () => ({
      nodes: [
        { id: "ctl", kind: "control" },
        { id: "txt", kind: "input_text" },
        /* v4：数据端口 0 起 + 末位控制口 */
        { id: "h4", kind: "video_gen", videoPortV2: true, videoPortV3: true, videoPortV4: true },
        /* v1：什么标记都没有（端口0=提示词 · 末尾动态控制槽） */
        { id: "h1", kind: "video_gen", videoCtrlPort: 3 },
        /* v2 / v3：控制口在端口 0（或写越界），数据端口 ≡ 槽号 */
        { id: "h2", kind: "video_gen", videoPortV2: true, videoPortV3: true },
      ],
      wires: [
        { id: "a1", from: "txt", to: "h4", fromIndex: 0, toIndex: 0 },
        { id: "a2", from: "txt", to: "h4", fromIndex: 0, toIndex: 1 },
        { id: "a3", from: "ctl", to: "h4", fromIndex: 0, toIndex: 4 },
        { id: "b1", from: "txt", to: "h1", fromIndex: 0, toIndex: 0 },
        { id: "b2", from: "ctl", to: "h1", fromIndex: 0, toIndex: 3 },
        { id: "c1", from: "txt", to: "h2", fromIndex: 0, toIndex: 1 },
        { id: "c2", from: "ctl", to: "h2", fromIndex: 0, toIndex: 4 },
      ],
    });
    const wf = oldWf();
    eqNum(migSandbox.migrateWfRef(wf), true, "有视频节点需要从旧布局迁移 → migrateWf 报告改过");
    const ti = (id) => (wf.wires.find((w) => w.id === id) || {}).toIndex;
    eqNum(ti("a1"), 1, "v4：提示词数据线 端口 0 → 端口 1（整体 +1）");
    eqNum(ti("a2"), 2, "v4：第二条数据线 端口 1 → 端口 2");
    eqNum(ti("a3"), 0, "v4：控制线 末位端口 4 → 端口 0");
    eqNum(ti("b1"), 1, "v1：提示词数据线 端口 0 → 端口 1");
    eqNum(ti("b2"), 0, "v1：末尾动态控制槽上的控制线 → 端口 0");
    eqNum(ti("c1"), 1, "v2 / v3：数据端口 ≡ 槽号 → 不动");
    eqNum(ti("c2"), 0, "v2 / v3：控制线一律回端口 0");
    const vids = wf.nodes.filter((n) => n.kind === "video_gen");
    ok(vids.every((n) => n.videoPortV5 === true), "三代旧档都打上 v5 标记（幂等防重迁）");
    ok(vids.every((n) => n.videoCtrlPort === undefined), "旧的 videoCtrlPort 字段已清掉");
    const again = JSON.stringify(wf);
    eqNum(migSandbox.migrateWfRef(wf), false, "再跑一次不再改动（迁移幂等，不会把端口反复 +1）");
    eqStr(JSON.stringify(wf), again, "二次加载后端子号与标记完全不变");
  }

  /* ===================== 控制端子只与控制端子相连 ===================== */
  console.log("\n[ctrl] 控制端子 / 数据端子归类：控制线只落控制端子，数据线不占控制端子");
  /* 端子归类真源（画布配色 / 接线校验 / 落点三处同一份） */
  const ctlT = mk("ctlT", "control");
  const toolT = mk("toolT", "tool", { toolParams: [{ name: "a", kind: "text", dir: "in" }] });
  const fnT = mk("fnT", "function", { jscode: "return {}" });
  const supT = mk("supT", "super");
  const spR = mk("spR", "remotion");
  const spP = mk("spP", "video_upscale");
  const spV = mk("spV", "video_gen", { videoMode: "fl2va" });
  const spD = mk("spD", "proc_text");
  const mgD = mk("mgD", "music_gen");
  scene([ctlT, toolT, fnT, supT, spR, spP, spV, spD, mgD, txt, h3w]);
  eqArr(
    [0, 1, 2, 3].map((i) => F.inPortIsControl(toolT, i)),
    [true, false, false, false],
    "工具节点：端口 0 是控制入，参数端子不是",
  );
  eqArr([0, 1].map((i) => F.inPortIsControl(fnT, i)), [true, false], "函数节点：端口 0 是控制入");
  eqArr([0, 1].map((i) => F.inPortIsControl(spR, i)), [true, false], "Remotion：端口 0 是控制入");
  eqNum(F.inPortIsControl(spP, 0), true, "视频超分：端口 0 是控制入");
  eqNum(F.inPortIsControl(spV, 0), true, "H3：端口 0 是控制入");
  eqNum(F.inPortIsControl(spD, 0), false, "动态端子节点：端口 0 是提示词入口，不是控制端子");
  eqNum(F.inPortIsControl(supT, 0), false, "普通超级节点未接线时端口 0 不是纯控制");
  ok(
    F.inPortKindOf(spD, 0) == null,
    "动态端子节点：端口 0 不是控制端子（提示词 / 文本入口）",
  );
  eqNum(F.inPortKindOf(spV, 0), "control", "H3：端口 0 声明 control（数据线不得占）");
  eqNum(F.inPortKindOf(spR, 0), "control", "Remotion：端口 0 声明 control");
  eqNum(F.inPortKindOf(spR, 1), "text", "Remotion：端口 1 是描述文本端子");

  /* 数据线 → 控制端子：一律挡下（此前只有媒体节点的专用分支在挡） */
  scene([ctlT, spR, spD, mgD, txt]);
  has(
    F.connectError("txt", "spR", 0, 0) || "",
    "为端口 1",
    "文本线 → Remotion 端口 0（控制口）：拒绝并点名文本端子在端口 1",
  );
  eqStr(F.connectError("ctlT", "spR", 0, 0) || "", "", "控制线 → Remotion 端口 0：放行（控制端子只与控制端子相连）");
  eqStr(
    F.connectError("txt", "spD", null, 0) || "",
    "",
    "文本线 → 动态端子节点：放行（端口 0 本就是数据端子）",
  );
  const nsT = mk("nsT", "net_send");
  scene([ctlT, nsT, txt, spR, spD, mgD]);
  has(
    F.connectError("ctlT", "nsT", 0, 0) || "",
    "数据端子",
    "控制线 → net_send 的信息端子（端口 0）：拒绝并点名它是数据端子",
  );
  eqStr(F.connectError("ctlT", "nsT", 1, 0) || "", "", "控制线 → net_send 的控制端子（端口 1）：放行");
  has(
    F.connectError("txt", "nsT", 1, 0) || "",
    "控制输入端子",
    "数据线 → net_send 的控制端子（端口 1）：拒绝并点名它是控制端子",
  );

  /* 控制线 → 数据端子：挡下 */
  has(
    F.connectError("ctlT", "mgD", 0, 0) || "",
    "控制输入端子为端口 2",
    "控制线 → Music3 的提示词端子（端口 0）：拒绝并点名控制口在端口 2",
  );
  eqStr(F.connectError("ctlT", "mgD", 2, 0) || "", "", "控制线 → Music3 的控制端子（端口 2）：放行");

  /* 未指定端子的控制线：落动态端子节点的控制端子（数据端子之后那颗），绝不占端口 0 */
  scene([spD, txt, ctlT], [{ id: "cd1", from: "txt", to: "spD", fromIndex: 0, toIndex: 0 }]);
  eqStr(F.connectError("ctlT", "spD", null, 0) || "", "", "控制线未指定端子 → 落到动态端子节点的控制端子：放行");
  F.addWire("ctlT", "spD", null, { fromIndex: 0 });
  eqNum(S.wf.wires.length, 2, "控制线真的接上了");
  eqNum(
    Number(S.wf.wires[S.wf.wires.length - 1].toIndex),
    1,
    "控制线落端口 1 的控制端子，不占用端口 0 的提示词入口",
  );
  scene([spD, txt, ctlT]);
  F.addWire("ctlT", "spD", null, { fromIndex: 0 });
  eqNum(S.wf.wires.length, 1, "未接线时控制线也能自动落点（按 inputCount 顺延出控制端子）");
  eqNum(
    Number(S.wf.wires[S.wf.wires.length - 1].toIndex),
    0,
    "未接线时控制线仍落在唯一那颗端子上（不占任何数据端子）",
  );

  /* 已存在连线的合法性也走同一条规则（数据线占着控制端子 → 报错） */
  scene(
    [spD, txt, ctlT],
    [
      { id: "bad0", from: "txt", to: "spD", fromIndex: 0, toIndex: 0 },
      { id: "bad1", from: "txt", to: "spD", fromIndex: 0, toIndex: 1 },
    ],
  );
  eqNum(
    !!F.connectError("txt", "spD", null, 0),
    true,
    "数据线占着端子时控制线也进不来（占位判定仍先行，不放宽）",
  );

  /* 新文案要有英文词条（i18n 里没有中文键就漏译） */
  ok(
    i18nSrc.indexOf('"该端子是数据端子，不接受控制连线（控制线只能连到控制输入端子）"') >= 0 &&
      i18nSrc.indexOf('"该端子是控制输入端子，只接受控制连线（数据线请连数据端子）"') >= 0,
    "控制 / 数据端子互斥的两条新文案都有英文词条",
  );
  console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
  if (fails) {
    console.log(fails + " 项失败");
    process.exit(1);
  }
  console.log("全部通过");
})();

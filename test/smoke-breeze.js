"use strict";
/* Breeze TTS 2 本地 TTS 插件 + 画布节点 breeze_gen 的回归
 *   node test/smoke-breeze.js
 * 与 test/smoke-media-gen-menu.js 同一套路：用 vm 从 renderer 源码里按名字抠出**真实函数**来跑，
 * 只有建节点 / 落盘 / DOM 渲染这些与判定无关的部分用测试侧替身。
 *
 * 锁住的需求（本模块共识，逐条对应）：
 *   1. 插件标识：id=breeze-tts-local · kind/handler=breeze · 目录 breeze/ · pack breeze-pack/
 *   2. 原生 Windows 直接跑：安装脚本走 aliyun pytorch 轮子镜像 + ModelScope/hf-mirror 权重，不启 fast 路径
 *   3. 独立节点 breeze_gen（不动 tts_gen）：4 数据入 + 控制入 端口4 · 出 0=音频 / 1=控制
 *   4. 参考源优先级：端子优先，端子空了才用节点设置里的音色；参考音频与文稿必须成对
 *   5. 能力语义：clone / design / direction / auto（auto 按参数推导）
 *   6. 输出格式 wav / flac / mp3（mp3 需 ffmpeg，缺了给明确中文指路）
 *   7. 运行口径：进媒体串行链 + 持全局音视频互斥锁
 *   8. 六层接线 + 打包白名单 + 许可告知 + 常驻单例后端（不随 MTNode 退出）
 *
 * 覆盖：
 *   [1] 插件标识与五层接线（catalog / KNOWN_KINDS / main.js / preload.js / 卡片）
 *   [2] breeze-pack 脚手架与安装链（镜像、权重三通道、便携 ffmpeg、许可告知）
 *   [3] 后端契约（管理服务接口 / PCM 封装 / 音色库 / 引擎编排 / 单例常驻）
 *   [4] 节点端子契约（5 入 2 出 · 端口 4=控制入 · 端口 1=音频）与 connectError 各分支
 *   [5] 参考源解析优先级 + 成对校验 + 错误码译法
 *   [6] 执行链：媒体串行链 / 全局锁 / playNodeBody 分发 / playBreezeGenNode 真跑一次合成
 *   [7] 文档与技能：中英指南 + 索引 + 修复技能 + i18n + 图标
 *   [8] 安装自愈：宿主前置阶段兜底 / 冒烟闸门 / 引擎与合成上报 / 控制台修复入口
 *   [9] 安装自愈行为验证：原事故条件复现 + 闸门真跑（三种结局）+ 不修判定真跑
 *   [10] 引擎按需拉起：合成入口自动拉起（不堵事件循环）/ 徽章「用时自动加载」/ 引擎日志 / 错误码细分进总线
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(__dirname, "..", rel.split("/").join(path.sep)));
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
const count = (s, re) => (String(s).match(re) || []).length;

/* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
/* 花括号计数要能正确穿过字符串 / 模板串 / 注释 —— 旧写法只记「开引号」不管转义，
   正文里出现一个反引号（哪怕在注释里，如 app.js 讲 @ 切词的那段）就会被判成
   「进了字符串」而把后面所有花括号当内容，一路吞到文件里下一个反引号处：
   抽出来的函数体比真函数大两个数量级，还顺手把沿途的 const 一起带进沙箱
   （同一 vm 上下文里重复 const = SyntaxError，整只测试直接崩）。这里按字符级扫干净。 */
function skipJsLiteral(s, j) {
  const c = s[j];
  if (c === "/" && s[j + 1] === "/") {
    const e = s.indexOf("\n", j);
    return e < 0 ? s.length : e;
  }
  if (c === "/" && s[j + 1] === "*") {
    const e = s.indexOf("*/", j);
    return e < 0 ? s.length : e + 1;
  }
  if (c !== '"' && c !== "'" && c !== "`") return j;
  for (let k = j + 1; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\") {
      k++;
      continue;
    }
    if (c === "`" && ch === "$" && s[k + 1] === "{") {
      /* 模板串插值：里面的表达式按代码扫，直到配对的 } */
      let d = 1;
      k += 2;
      while (k < s.length && d) {
        const k2 = skipJsLiteral(s, k);
        if (k2 !== k) {
          k = k2;
          continue;
        }
        if (s[k] === "{") d++;
        else if (s[k] === "}") d--;
        k++;
      }
      k--;
      continue;
    }
    if (ch === c) return k;
  }
  return s.length;
}
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
    for (let j = i; j < src.length; j++) {
      const skipped = skipJsLiteral(src, j);
      if (skipped !== j) {
        j = skipped;
        continue;
      }
      const c = src[j];
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
    const skipped = skipJsLiteral(src, j);
    if (skipped !== j) {
      j = skipped;
      continue;
    }
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
const asrSrc = read("renderer/app-asr.js");
const nodesSrc = read("renderer/app-nodes.js");
const canvasSrc = read("renderer/app-canvas.js");
const pluginsSrc = read("renderer/app-plugins.js");
const i18nSrc = read("renderer/i18n.js");
const mainSrc = read("main.js");
const preloadSrc = read("preload.js");
const lockSrc = read("media-gen-global-lock.js");
const hostSrc = read("breeze/main-breeze.js");
const serverSrc = read("breeze-pack/app/server.py");
const engineSrc = read("breeze-pack/app/engine.py");
const audioSrc = read("breeze-pack/app/audio.py");
const voicesSrc = read("breeze-pack/app/voices.py");
const configSrc = read("breeze-pack/app/config.py");
const installPs1 = read("breeze-pack/scripts/install.ps1");
const dlWeights = read("breeze-pack/scripts/download_weights.py");
const catalog = JSON.parse(read("plugins/catalog.default.json"));
const buildJson = read("build.json");
const appPluginsMain = read("plugins/main-app-plugins.js");

/* ---------- 测试侧替身（只替与判定无关的 DOM / 落盘 / 渲染部分） ---------- */
let uidN = 0;
const S = {
  wf: { nodes: [], wires: [] },
  cam: { z: 1 },
  /* 运行队列的三个真源（sweepOrphanPendingRuns / clearPendingRun 读它们）：
     本用例只造「排队中」这一态，所以在飞的三个一律空着。 */
  pendingRun: new Set(),
  runPromises: new Map(),
  _scheduledRunIds: null,
};
const added = [];
const ctrlFired = [];
let genCalls = [];
/* 节点头部那对键（appendMediaPlayBtns）里 ■ 的去向：只记「点了谁」，不真停 */
let stopCalls = [];
let breezeStatus = {
  running: true,
  installed: true,
  apiUp: true,
  apiStatus: {
    engine: { up: true, port: 8773, sampleRate: 24000 },
    voices: [
      { id: "播音", name: "播音", hasAudio: true, hasText: true, ready: true, text: "这是一段参考文稿。" },
      { id: "缺文稿", name: "缺文稿", hasAudio: true, hasText: false, ready: false, text: "" },
    ],
  },
};
/* 极小 DOM 替身：只为真跑「两个文本框」的构造（元素 / 事件 / 只读态），不模拟渲染 */
function fakeEl(tag) {
  return {
    tag,
    children: [],
    className: "",
    id: "",
    textContent: "",
    value: "",
    readOnly: false,
    placeholder: "",
    title: "",
    rows: 0,
    spellcheck: true,
    disabled: false,
    type: "",
    style: {},
    _ev: {},
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener(k, fn) {
      (this._ev[k] = this._ev[k] || []).push(fn);
    },
    fire(k) {
      /* on<事件> 属性（节点头部那对键走的就是它）与 addEventListener 两条都要认 */
      const ev = { stopPropagation() {} };
      if (typeof this["on" + k] === "function") this["on" + k](ev);
      (this._ev[k] || []).forEach((fn) => fn(ev));
    },
  };
}
const fakeDoc = { createElement: (t) => fakeEl(t) };

const uiStates = new Map();
const sandbox = {
  S,
  /* 媒体串行链的排队表（app-nodes.js 的 mediaGenWaiters）：沙箱里由本替身提供 ——
     mediaGenQueueHolds / sweepOrphanPendingRuns / clearPendingRun 都读它。
     注意它必须挂在沙箱**顶层**（不是 S 上）：源码里是模块级 const。 */
  mediaGenWaiters: new Map(),
  console,
  document: fakeDoc,
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
  BREEZE_API_POLL_MS: 2000,
  BREEZE_API_WAIT_MS: 180000,
  I18n: { t: (s) => String(s) },
  toast: () => {},
  renderCanvas: () => {},
  scheduleSave: () => {},
  updateRunQueuePanel: () => {},
  renderStatus: () => {},
  /* ■ 的落点：appendMediaPlayBtns 只把点击转给 stopNode（真停止链在 app.js，不在本用例范围） */
  stopNode: (n) => {
    stopCalls.push(n && n.id);
  },
  playUserNode: (n) => {
    stopCalls.push("play:" + (n && n.id));
  },
  uid: (p) => p + "_w" + ++uidN,
  clearDownstream: () => {},
  applySavePathExt: () => {},
  pushHistory: () => {},
  addNode: (kind, x, y, extra) => {
    const n = Object.assign({ id: "n" + ++uidN, kind, x, y }, extra || {});
    added.push(n);
    return n;
  },
  appPluginInstalled: () => true,
  attemptCount: (n) => Math.max(1, Number(n && n.attempts) || 1),
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
  inputValuesFor: (node, port) => {
    /* 端口 1 = 参考音频：node.__refAudio 显式给路径 = 「端子直接给了一个音频值」 */
    if (Number(port) === 1) {
      if (node && "__refAudio" in node) {
        const p = node.__refAudio;
        return p ? [{ value: { kind: "audio", path: p, text: p } }] : [];
      }
      return [];
    }
    /* 其余端口按线取数（端口 2 接音频 / 视频输入节点那一路要用真值：音频值 = 该文件的
       file:/// URL，转写值 = 该节点自己的 asrTranscripts 文本）。
       **端子号与 app.js:14934 的 inputValuesFor 同口径**：只有超级节点 / 素材条目节点按线上的
       fromIndex 取，其余节点用的是「这个入端口的号」（idx）—— 上一版替身把 fromIndex 硬塞给
       所有节点，替身行为与真身不同，等于替真身开绿灯。
       nodeById / valueFromInput 都走 sandbox.：这只替身是在沙箱**外面**闭包求值的，
       裸名在这里取不到沙箱里的名字（以前静默 ReferenceError → 取值恒空）。 */
    return (S.wf.wires || [])
      .filter((w) => w.to === node.id && Number(w.toIndex) === Number(port))
      .map((w) => {
        const src = sandbox.nodeById(w.from);
        const itemPort =
          (typeof sandbox.isSuperLikeNode === "function" && sandbox.isSuperLikeNode(src)) ||
          (typeof sandbox.isItemPortSource === "function" && sandbox.isItemPortSource(src));
        const fromIdx = itemPort ? Number(w.fromIndex || 0) : Number(port);
        return {
          title: (src || {}).title || "",
          value: sandbox.valueForInput(src, fromIdx),
        };
      })
      .filter((it) => it.value);
  },
  /* 取值替身：真实 valueForInput 要读 DOM 与批量态，这里按 kind 给最小可信值
     （inferMediaFromSource / wireSourceMediaType 会调它）。
     音频 / 视频输入节点按**端子号**分：端口 0 = 该文件的音频值（path + file:/// URL），
     端口 1 = 转写输出（asrTranscripts 里那条文本，没有就是空文本）—— 与 app.js:14176 同口径。 */
  valueForInput: (src, idx) => {
    if (!src) return null;
    if (src.kind === "input_text") return { kind: "text", text: String(src.text || "hi") };
    if (src.kind === "input_image" || src.kind === "proc_image")
      return { kind: "image", path: "E:/assets/pic.png" };
    if (src.kind === "input_audio" || src.kind === "input_video") {
      if (Number(idx) > 0) return { kind: "text", text: String(src.__transcript || "") };
      const p = String(src.mediaAsset || "E:/assets/a.wav");
      return { kind: "audio", path: p, url: sandbox.mediaFileUrlOf(p), text: sandbox.mediaFileUrlOf(p) };
    }
    /* 保存节点（音频 / 视频）：值是**该文件本身**（本机路径，不是 file:/// URL） */
    if (src.kind === "save" || src.kind === "save_audio" || src.kind === "save_video") {
      const p = String(src.__savedPath || src.savedPath || "");
      if (!p) return null;
      return src.kind === "save_video"
        ? { kind: "video", path: p, url: sandbox.mediaFileUrlOf(p), text: p }
        : { kind: "audio", path: p, url: sandbox.mediaFileUrlOf(p), text: p };
    }
    /* __pathText：把一条本机媒体路径当**纯文本**给出的来源（函数 / 工具 / 插件节点的一支） */
    if (src.__pathText) return { kind: "text", text: String(src.__pathText) };
    return { kind: "text", text: String(src.text || "hi") };
  },
  /* 真实 valueFromWire（app.js:4698）：**只有超级节点 / 素材条目节点**按线上的 fromIndex 取
     端子，其余节点拿 batchIdx 当端子号（musicGenSlotText 传 0）。
     ⚠ 上一版替身对音视频输入节点按 fromIndex 取（w.fromIndex > 0 就回转写）—— 替身比真身聪明，
     真身里「音频节点端口 1 接进 breeze 参考文稿口」其实拿回的是端口 0 的那串 file:/// URL，
     于是用户在界面上看到路径、冒烟却全绿（本轮用户报的 bug 正是被这层替身掩盖的）。 */
  valueFromWire: (w, consumer, batchIdx) => {
    const src = sandbox.nodeById(w.from);
    const itemPort =
      (typeof sandbox.isSuperLikeNode === "function" && sandbox.isSuperLikeNode(src)) ||
      (typeof sandbox.isItemPortSource === "function" && sandbox.isItemPortSource(src));
    const idx = itemPort ? Number(w.fromIndex || 0) : batchIdx == null ? 0 : batchIdx;
    return sandbox.valueForInput(src, idx);
  },
  fetchMediaGenLock: async () => null,
  mediaGenLockBusyMsg: (l) => "全局媒体任务忙（" + ((l && l.nodeId) || "") + "）",
  wiresTo: (id) => (S.wf.wires || []).filter((w) => w.to === id),
  nodeById: (id) => (S.wf.nodes || []).find((n) => n.id === id) || null,
  /* 真实 displayValueOf（app.js:14889）：音视频输入节点对外可读内容 = 该文件的 file:/// URL；
     保存节点 = 它落盘的那份路径。
     ⚠ 这里以前恒 null，而它正是用户那条 bug 的最后一步：musicGenSlotText 的端子号一丢，
     取回端口 0 的音频值（不是 text）→ 落回 displayValueOf → 就是那串 file:///…mp3。
     替身恒 null = 冒烟永远看不见「参考文本里显示路径」，所以现在照真身补齐。 */
  displayValueOf: (src) => {
    if (!src) return null;
    if (src.kind === "input_audio" || src.kind === "input_video") {
      const p = String(src.mediaAsset || "");
      return p ? { text: sandbox.mediaFileUrlOf(p) } : null;
    }
    if (src.kind === "save" || src.kind === "save_audio" || src.kind === "save_video") {
      const p = String(src.__savedPath || src.savedPath || "");
      return p ? { text: p } : null;
    }
    return null;
  },
  window: {
    api: {
      breezeStatus: async () => breezeStatus,
      breezeStart: async () => ({ ok: true }),      apiFetch: async () => ({ ok: true }),
      breezeGenerate: async (body) => {
        genCalls.push(body);
        return { ok: true, path: "E:/out/voice.wav", mode: body.mode };
      },
    },
  },
};
vm.createContext(sandbox);
const G = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);

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
  "mediaGenExt",
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
  "isBreezeMediaSource",
  "BREEZE_AUDIO_EXTS",
  "BREEZE_VIDEO_EXTS",
  "breezeHasExt",
  "breezeHasAudioExt",
  "breezeHasVideoExt",
  "breezeIsFileUrl",
  "breezeIsMediaFilePath",
  "breezeIsMediaValue",
  "breezeAudioPathOfValue",
  "fetchMediaBackendStatus",
  "breezeModeOf",
  "breezeFormatOf",
  "breezeCfgScaleOf",
  "breezeSeedOf",
  "breezeTextSlot",
  "breezeAudioSlotPath",
  /* 两个文本框（renderer/app-nodes.js 的 输入文本 / 参考文本）：状态判定与取数这几只是
     breezeResolveRef / playBreezeGenNode 的直接依赖，切片时一并带上，否则沙箱里会以
     ReferenceError 收场。DOM 那两只（breezeTextBoxFor / breezeTextBoxesFor）不进沙箱。 */
  "breezeTextOf",
  "breezeTextBoxState",
  "breezeSlotHasMediaSource",
  "breezeSlotHasAnySource",
  "breezeSrcTextOf",
  "breezeTextBoxStateText",
  /* DOM 那两只：沙箱里带一个极小 document 替身，就为真跑「只读 / 可编辑 / 写回」这三件事 */
  "breezeTextBoxFor",
  "breezeTextBoxesFor",
  "breezeTextBoxCommit",
  "breezeTextBoxClear",
  "breezeResolveRef",
  "breezeErrorText",
  /* 排队真源那一对 + 自愈扫把 + 头部的 ▶/■ 都切进沙箱，做行为断言。
     mediaGenQueueHolds 读的 mediaGenWaiters 由本文件的替身提供（见 sandbox.mediaGenWaiters）。 */
  "mediaGenQueueHolds",
  "clearPendingRun",
  "sweepOrphanPendingRuns",
  "isNodePending",
  "appendMediaPlayBtns",
  "appendNodePlayBtns",
  "ensureBreezeBackendReady",
  /* 媒体值接参考文稿口那一支会真跑 playBreezeGenNode：它要问「这条路径是不是托管路径」，
     少了这只替身会以 ReferenceError 收场（不是本节点要考的断言） */
  "mediaGenManagedTag",
  "playBreezeGenNode",
];
const SCALAR_CONSTS = {
  "renderer/app.js": ["DEFAULT_IMAGE_SIZE", "IN_PORT_DATA_KINDS"],
  /* 两个轮询常量 + 两个文本框的真源表随函数体一起切过来 */
  "renderer/app-nodes.js": ["BREEZE_API_POLL_MS", "BREEZE_API_WAIT_MS", "BREEZE_TEXT_BOXES"],
};
vm.runInContext(
  [
    extractConsts(appSrc, SCALAR_CONSTS["renderer/app.js"]),
    extractConsts(nodesSrc, SCALAR_CONSTS["renderer/app-nodes.js"]),
    extract(appSrc, APP_FNS),
    extract(nodesSrc, NODES_FNS),
  ].join("\n"),
  sandbox,
  { filename: "breeze-extract.js" },
);
const F = new Proxy({}, { get: (_t, k) => G(String(k)) });

const mk = (id, kind, extra) =>
  Object.assign({ id, kind, title: id, parentSuperId: "", parentTaskId: "" }, extra || {});
function scene(nodes, wires) {
  S.wf = { nodes: (nodes || []).slice(), wires: (wires || []).slice() };
}

(async function main() {
  /* ═════════════ [1] 插件标识与五层接线 ═════════════ */
  console.log("\n[1] 插件标识与五层接线（catalog / KNOWN_KINDS / main.js / preload.js / 卡片）");
  const entry = (catalog.plugins || []).find((p) => p.id === "breeze-tts-local");
  ok(!!entry, "catalog.default.json 有 breeze-tts-local 词条");
  eqStr(entry.kind, "breeze", "catalog kind = breeze");
  eqStr(entry.handler, "breeze", "catalog handler = breeze");
  eqNum(entry.order, 62, "catalog order = 62（紧挨 tts-local=60 之后）");
  eqStr(entry.version, "1.0.0", "catalog 版本 = 1.0.0");
  eqStr(entry.minAppVersion, "1.4.0", "catalog minAppVersion = 1.4.0");
  eqStr(entry.icon, "breeze-tts-local.png", "catalog 图标 = breeze-tts-local.png");
  has(entry.title.zh, "Breeze TTS 2", "catalog 中文标题");
  has(entry.subtitle.zh, "非商用", "catalog 中文简介写明非商用限制");
  has(entry.subtitle.en, "non-commercial", "catalog 英文简介写明 non-commercial");

  has(appPluginsMain, '"breeze"', "plugins/main-app-plugins.js 的 KNOWN_KINDS 收 breeze");
  has(appPluginsMain, 'raw.handler === "breeze"', "normalizePlugin 的 handler 兜底链认识 breeze");
  ok(
    count(appPluginsMain, /p\.kind === "breeze" \|\| p\.handler === "breeze"/g) === 2,
    "两处「已安装占位 / 内置兜底」分支都带上 breeze（得到 " +
      count(appPluginsMain, /p\.kind === "breeze" \|\| p\.handler === "breeze"/g) +
      "）",
  );
  has(mainSrc, 'require("./breeze/main-breeze.js")', "main.js 引到 breeze 宿主");
  has(mainSrc, "registerBreezeIpc({", "main.js 注册 breeze 的 IPC");
  has(mainSrc, "shutdownBreezeUiOnly();", "main.js before-quit 调 shutdownBreezeUiOnly（只关控制台窗）");
  has(mainSrc, "onBreezeDshEvent", "main.js 的 dsh 事件分发挂到 breeze");
  has(mainSrc, "如果真 Node".slice(0, 0) + "breeze/main-breeze.js", "main.js 的注释指向宿主文件（可复核）");
  for (const m of [
    "breezeStatus",
    "breezeOpen",
    "breezeClose",
    "breezeInstall",
    "breezeCancelInstall",
    "breezeStart",
    "breezeStop",
    "breezePickInstallDir",
    "breezeRemovePluginMeta",
    "breezeApiFetch",
    "breezeGenerate",
    "onBreezeProgress",
    "onBreezeConsoleChanged",
  ])
    has(preloadSrc, m + ":", "preload.js 暴露 " + m);

  has(pluginsSrc, "function refreshBreezePluginCard(", "app-plugins.js 有 refreshBreezePluginCard");
  has(pluginsSrc, "function bindBreezeProgress(", "app-plugins.js 有 bindBreezeProgress");
  has(
    pluginsSrc,
    'item.kind === "breeze" || item.handler === "breeze"',
    "openAppPluginsDialog 的 kind 链挂上 breeze",
  );
  has(pluginsSrc, 'id: "breeze-tts-local"', "app-plugins.js 的内建兜底词条含 breeze-tts-local");
  has(pluginsSrc, 'onBreezeConsoleChanged', "卡片订阅 breeze 控制台开关事件");
  /* 卡片动作图标只能取 PLUGIN_ACT_SVG 已有 kind ——
     本轮起 8 个本地后端插件的卡片共用 app-plugins.js 的 refreshBackendPluginCard（薄壳只传 spec），
     所以图标清单从那份共用实现里取；薄壳自身不许出现卸载入口。 */
  const breezeCard = pluginsSrc.slice(
    pluginsSrc.indexOf("async function refreshBreezePluginCard("),
    pluginsSrc.indexOf("function bindBreezeProgress("),
  );
  const backendCard = pluginsSrc.slice(
    pluginsSrc.indexOf("async function refreshBackendPluginCard("),
    pluginsSrc.indexOf("async function refreshMusic3PluginCard("),
  );
  const actKinds = [...backendCard.matchAll(/addBtn\("([a-z]+)"/g)].map((m) => m[1]);
  const svgTable = pluginsSrc.slice(
    pluginsSrc.indexOf("const PLUGIN_ACT_SVG = {"),
    pluginsSrc.indexOf("};", pluginsSrc.indexOf("const PLUGIN_ACT_SVG = {")),
  );
  ok(
    actKinds.length > 0 && actKinds.every((k) => svgTable.indexOf(k + ":") >= 0),
    "卡片动作图标全部取自 PLUGIN_ACT_SVG（共用卡片用到的 kind：" + actKinds.join("/") + "）",
  );
  has(
    pluginsSrc,
    'breeze: { key: "breeze", api: "breeze", hasService: true }',
    "breeze 登记进 BACKEND_PLUGIN_SPECS（共用卡片按它取桥名）",
  );
  hasnt(breezeCard, '"uninstall"', "卡片不做卸载入口（卸载留在控制台窗内）");

  /* 报错归属与修复技能（app-repair.js） */
  const repair = read("renderer/app-repair.js");
  has(repair, 'breeze: "breeze-tts-local-install"', "app-repair.js 把 breeze 归到安装技能");
  has(repair, '"breeze-tts-local": "breezeOpen"', "app-repair.js 的「打开控制台」桥对准 breezeOpen");
  has(repair, 'label: "Breeze TTS 2"', "app-repair.js 登记了 Breeze 服务（resident 常驻）");
  has(read("dsh/main-dsh.js"), "'breeze-tts-local-install'", "dsh 的安装技能同步表含 breeze-tts-local-install");

  /* ═════════════ [2] breeze-pack 脚手架与安装链 ═════════════ */
  console.log("\n[2] breeze-pack：安装链 / 镜像 / 权重三通道 / 便携 ffmpeg / 许可告知");
  for (const f of [
    "breeze-pack/manifest.json",
    "breeze-pack/start_backend.cmd",
    "breeze-pack/.gitignore",
    "breeze-pack/README.md",
    "breeze-pack/scripts/install.ps1",
    "breeze-pack/scripts/download_weights.py",
    "breeze-pack/app/__init__.py",
    "breeze-pack/app/__main__.py",
    "breeze-pack/app/config.py",
    "breeze-pack/app/console_banner.py",
    "breeze-pack/app/audio.py",
    "breeze-pack/app/voices.py",
    "breeze-pack/app/engine.py",
    "breeze-pack/app/server.py",
  ])
    ok(exists(f), "脚手架文件存在：" + f);

  const man = JSON.parse(read("breeze-pack/manifest.json"));
  eqStr(man.id, "breeze-tts-local", "manifest.id 与 catalog 一致");
  eqNum(man.apiPort, 8772, "manifest.apiPort = 8772");
  has(man.license.weights, "Non-Commercial", "manifest 写明权重许可 = Non-Commercial");
  has(installPs1, "pytorch-wheels/cu128", "安装脚本 torch 走 aliyun cu128 镜像");
  has(installPs1, "pytorch-wheels/cu126", "安装脚本有 cu126 回退");
  has(installPs1, "pypi.tuna.tsinghua.edu.cn", "安装脚本 pip 走清华镜像");
  has(installPs1, "ghproxy.com", "安装脚本 GitHub 走 ghproxy 回退");
  has(installPs1, "BREEZE_WEIGHTS_DIR", "安装脚本支持手填已有权重目录");
  has(installPs1, "download_weights.py", "安装脚本调独立权重下载器");
  has(installPs1, "ffmpeg", "安装脚本下便携 ffmpeg");
  has(installPs1, "Non-Commercial", "安装脚本打印非商用许可告知");
  has(installPs1, "[breeze-install] progress:", "安装脚本带宿主能解析的进度口径");
  has(installPs1, "fast", "安装脚本说明不启用 fast 路径");
  hasnt(installPs1, "_probe_", "安装脚本不带探针脚本（不随包）");
  has(dlWeights, "snapshot_download", "权重下载器用 snapshot_download");
  has(dlWeights, "modelscope", "权重下载器 ModelScope 优先");
  has(dlWeights, "hf-mirror.com", "权重下载器回退 hf-mirror");
  has(dlWeights, "huggingface.co", "权重下载器最后回退 HF 官方");
  has(dlWeights, "Non-Commercial", "权重下载器打印非商用许可告知");

  /* 打包白名单 */
  has(buildJson, '"breeze/**"', "build.json files 已加 breeze/**");
  has(read("build.json"), '"from": "breeze-pack"', "build.json extraResources 已加 breeze-pack");
  ok(
    /"from": "breeze-pack"[\s\S]{0,220}\.gitignore/.test(read("build.json")),
    "breeze-pack 的 extraResources filter 是正向白名单（不含 venv / 权重）",
  );

  /* ═════════════ [3] 后端契约 ═════════════ */
  console.log("\n[3] 后端契约：管理服务接口 / PCM 封装 / 音色库 / 引擎编排 / 常驻单例");
  for (const route of [
    '"/health"',
    '"/api/health"',
    '"/api/status"',
    '"/api/engine/start"',
    '"/api/engine/stop"',
    '"/api/voices"',
    '"/api/voices/add"',
    '"/api/voices/delete"',
    '"/api/voices/rename"',
    '"/api/voices/audio"',
    '"/api/voices/preview"',
    '"/api/preview"',
    '"/v1/audio/speech"',
    '"/api/shutdown"',
  ])
    has(serverSrc, route, "管理服务有接口 " + route);
  has(serverSrc, "require_key(", "管理服务有 Bearer 鉴权");
  has(serverSrc, "API_KEY", "管理服务持 API Key");
  has(serverSrc, "load_api_key", "API Key 由服务生成并落盘");
  has(serverSrc, "忙碌时重试" .slice(0, 0) + "busy_engine", "引擎单并发忙时归一成 busy_engine");
  has(serverSrc, "engine_loading", "加载中归一成 engine_loading");
  has(serverSrc, "ref_text_required", "参考音频缺文稿时给 ref_text_required");
  has(serverSrc, "mode_conflict", "设计模式误接参考音频时给 mode_conflict");
  has(serverSrc, "instruction_required", "导演模式缺 instruction 时给 instruction_required");
  has(serverSrc, '"cfg_scale"', "管理服务接受 cfg_scale 参数");
  has(serverSrc, "cfg_scale = 4.0 if instruction else 1.0", "cfg_scale 默认：有 instruction 时 4、否则 1");
  /* 能力判定（官方语义，本机实测踩过一次坑）：**没有参考音频就是音色设计**，
     不能因为带了 instruction 就判成导演 —— 那样「音色设计」这条无参考音频的路会被误判掉。 */
  {
    const at = serverSrc.indexOf('if mode == "auto":');
    const seg = at < 0 ? "" : serverSrc.slice(at, at + 420);
    has(seg, "if ref_audio_path:", "auto 判定先看有没有参考音频");
    has(seg, '"direction" if instruction else "clone"', "有参考音频：带 instruction 判导演、否则克隆");
    has(seg, 'mode = "design"', "无参考音频：判音色设计");
  }
  has(serverSrc, "speech", "有 OpenAI 兼容的合成端点");
  /* PCM → 容器：官方返回的是 24kHz s16le PCM，不是 wav */
  has(audioSrc, "pcm16_to_float", "audio.py 有 PCM16 解码");
  has(audioSrc, "<i2", "PCM 按小端 s16 解析");
  has(audioSrc, "SAMPLE_RATE_DEFAULT = 24000", "默认采样率 24000（官方口径）");
  for (const f of ['"wav"', '"flac"', '"mp3"']) has(audioSrc, f, "audio.py 支持输出格式 " + f);
  has(audioSrc, "missing_ffmpeg", "缺 ffmpeg 时给 missing_ffmpeg（节点侧译成中文指路）");
  has(audioSrc, "libmp3lame", "mp3 走 ffmpeg libmp3lame");
  has(audioSrc, "X-Sample-Rate".slice(0, 0) + "resample_linear", "参考音频采样率不一致时线性重采样");
  has(voicesSrc, '"ref.wav"', "音色库参考音频固定名 ref.*");
  has(voicesSrc, '"ref.txt"', "音色库文稿固定名 ref.txt");
  has(voicesSrc, "sanitize_id", "音色 id 做目录名消毒");
  has(voicesSrc, "voice_audio_required", "音色缺参考音频时报错");
  has(engineSrc, "breeze_infer.api", "引擎以官方 breeze_infer.api 模块启动");
  has(engineSrc, "def start(", "引擎有启动编排");
  has(engineSrc, "def stop(", "引擎有停止编排");
  has(engineSrc, "taskkill", "Windows 下用 taskkill 杀进程树");
  has(engineSrc, "cuda_unavailable", "无 CUDA 时给 cuda_unavailable");
  has(engineSrc, "no_weights", "缺权重时给 no_weights");
  has(engineSrc, "engine_loading".slice(0, 0) + '"loading"', "引擎 /health 区分 loading");
  has(configSrc, "非商用", "config.py 写许可告知（中文）");
  has(configSrc, "NON-COMMERCIAL", "config.py 写许可告知（英文）");
  has(configSrc, "ffmpeg_exe", "config.py 提供便携 ffmpeg 定位（优先自带，其次 PATH）");
  has(read("breeze-pack/app/console_banner.py"), "非商用", "启动横幅打印非商用许可告知");
  has(read("breeze-pack/start_backend.cmd"), "-m app", "start_backend.cmd 以 python -m app 起服务");

  /* 宿主：常驻单例、不随 MTNode 退出、安装列表护栏 */
  has(hostSrc, 'const PLUGIN_ID = "breeze-tts-local"', "宿主 PLUGIN_ID = breeze-tts-local");
  has(hostSrc, "const INSTALL_SKILL = \"breeze-tts-local-install\"", "宿主 INSTALL_SKILL 常量");
  has(hostSrc, "不随 MTNode 退出", "宿主注释写明「后端不随 MTNode 退出」的取舍");
  has(hostSrc, 'if (typeof app !== "undefined" && app && app.isPackaged)', "宿主按打包态解析 breeze-pack 资源目录（并对 app 标识符兜底）");
  has(hostSrc, 'require("../plugin-error-repair.js")', "宿主接报错总线");
  has(hostSrc, "registerPluginHost({", "宿主注册进报错总线");
  has(hostSrc, "selfRepair: (o) => selfRepairFromConsole(o || {})", "宿主注册自我修复入口");
  has(hostSrc, "function selfRepairFromConsole(", "宿主有 selfRepairFromConsole");
  ok(
    /selfRepairFromConsole[\s\S]{0,1400}agentRecoverInstall\(/.test(hostSrc),
    "自我修复复用 Agent 恢复安装链",
  );
  has(
    hostSrc,
    "restart: async () => {\n      await stopBackend();\n      return startBackend();",
    "重启 = 先停旧进程再拉起",
  );
  has(hostSrc, "function reportErr(", "宿主有 reportErr 包装");
  ok(count(hostSrc, /\breportErr\(/g) - 1 >= 6, "失败出口接了上报（" + (count(hostSrc, /\breportErr\(/g) - 1) + " 处）");
  has(hostSrc, "function isSafeInstallDir(", "安装目录有护栏");
  has(hostSrc, "refuse_app_dir", "护栏拒绝把安装目录选进应用目录");
  has(hostSrc, "refuse_system", "护栏拒绝系统目录");
  has(hostSrc, "function packFingerprint(", "有插件代码指纹（旧的后端进程要被识别）");
  has(hostSrc, 'ipcMain.handle("breeze:generate"', "宿主暴露 breeze:generate");
  has(hostSrc, '"/v1/audio/speech"', "generateBreezeFile 走 OpenAI 兼容端点");
  has(hostSrc, "mode: String(params.mode", "generate 把能力档透传给后端");
  has(hostSrc, "refAudio", "generate 把参考音频路径透传给后端");
  has(hostSrc, "cfgScale", "generate 把 cfg_scale 透传给后端");
  has(hostSrc, "writeFileSync(outputPath, buf)", "音频字节由主进程写盘（渲染层不碰二进制）");
  has(hostSrc, "function shutdownBreezeUiOnly(", "宿主只关控制台窗（后端常驻）");
  hasnt(hostSrc, "shutdownBreezeUiOnly() {\n  stopBackend", "退出时不杀后端（与常驻口径一致）");
  has(lockSrc, "tts_gen", "全局锁模块认识语音类节点（忙时提示按「语音」说）");

  /* ═════════════ [4] 节点端子契约 ═════════════ */
  console.log("\n[4] breeze_gen 端子：5 入（文本/参考音频/参考文稿/指令/控制）· 2 出（音频/控制）");
  const ndBlock = (() => {
    const at = appSrc.indexOf("const NODE_DEFAULTS = {");
    const end = appSrc.indexOf("\n};", at);
    return at < 0 ? "" : appSrc.slice(at, end);
  })();
  const ndKinds = new Set([...ndBlock.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]));
  ok(ndKinds.has("breeze_gen"), "NODE_DEFAULTS 里有 breeze_gen 的默认值");
  const bDefaults = (ndBlock.match(/breeze_gen:\s*\{([\s\S]*?)\n  \},/) || [null, ""])[1];
  has(bDefaults, 'title: "Breeze 语音节点"', "新建默认标题 = Breeze 语音节点");
  for (const f of ["attempts", "voice", "voiceMode", "instruction", "cfgScale", "seed", "ttsFormat", "outputPath"])
    has(bDefaults, f + ":", "breeze_gen 默认值带 " + f + " 字段");
  has(bDefaults, 'voiceMode: "auto"', "能力档默认 auto（按参数自动判定）");
  has(bDefaults, 'ttsFormat: "wav"', "输出格式默认 wav");

  const bNode = mk("b", "breeze_gen");
  eqNum(F.inputCount(bNode), 5, "breeze_gen 输入端子数 = 5");
  eqNum(F.outputCount(bNode), 2, "breeze_gen 输出端子数 = 2（0=音频 · 1=控制）");
  ok(F.inPortIsControl(bNode, 4), "端口 4 是控制输入");
  ok(!F.inPortIsControl(bNode, 0), "端口 0 是数据口（待合成文本）");
  eqStr(F.inPortKindOf(bNode, 0), "text", "端口 0 声明 text");
  eqStr(F.inPortKindOf(bNode, 1), "audio", "端口 1 声明 audio（参考音频）");
  eqStr(F.inPortKindOf(bNode, 2), "text", "端口 2 声明 text（参考文稿）");
  eqStr(F.inPortKindOf(bNode, 3), "text", "端口 3 声明 text（指令）");
  eqStr(F.inPortKindOf(bNode, 4), "control", "端口 4 声明 control");
  ok(F.hasFixedInPorts(bNode), "breeze_gen 归入固定端子节点（端子号不随连线漂移）");
  ok(F.nodeEmitsControlOnPort(bNode, 1), "端口 1 是控制输出");
  ok(!F.nodeEmitsControlOnPort(bNode, 0), "端口 0 是数据输出（音频）");
  ok(F.isMediaGenNode(bNode), "breeze_gen 归入媒体生成族（串行链 / 进度 / 终止同一套）");
  eqStr(F.inferMediaFromSource(bNode, 0), "audio", "breeze_gen 的输出按音频判定");
  eqStr(F.mediaGenExt({ kind: "breeze_gen", ttsFormat: "flac" }), ".flac", "flac 格式的落盘扩展名");
  eqStr(F.mediaGenExt({ kind: "breeze_gen", ttsFormat: "mp3" }), ".mp3", "mp3 格式的落盘扩展名");
  eqStr(F.mediaGenExt({ kind: "breeze_gen", ttsFormat: "wav" }), ".wav", "wav 格式的落盘扩展名");
  eqStr(F.nodeKindLabel({ kind: "breeze_gen" }), "Breeze 语音", "类型名 = Breeze 语音（i18n 前的中文 key）");
  has(
    F.nodeKindPurposeKey({ kind: "breeze_gen" }),
    "Breeze 语音生成",
    "用途文案写明是 Breeze 语音生成",
  );

  /* connectError：文本 / 音频 / 控制 三条路的准入 */
  const CE = (fromKind, toKind, ti, fi) => {
    const from = mk("f", fromKind, { text: "hi" });
    const to = mk("t", toKind);
    scene([from, to], []);
    return F.connectError("f", "t", ti, fi);
  };
  eqStr(CE("input_text", "breeze_gen", 0, 0) || "", "", "文本 → breeze_gen 端口0：放行");
  has(CE("input_image", "breeze_gen", 0, 0), "需要文本来源", "图像 → 端口0：拒绝（要文本来源）");
  eqStr(CE("input_text", "breeze_gen", 2, 0) || "", "", "文本 → 端口2（参考文稿）：放行");
  eqStr(CE("input_text", "breeze_gen", 3, 0) || "", "", "文本 → 端口3（指令）：放行");
  eqStr(CE("input_audio", "breeze_gen", 1, 0) || "", "", "音频 → 端口1（参考音频）：放行");
  eqStr(
    CE("input_audio", "breeze_gen", 2, 0) || "",
    "",
    "音频节点 → 端口2（参考文稿）：放行（该路的音频也当参考音频用）",
  );
  eqStr(
    CE("input_video", "breeze_gen", 2, 0) || "",
    "",
    "视频节点 → 端口2（参考文稿）：放行（取其音轨）",
  );
  has(CE("input_text", "breeze_gen", 1, 0), "需要音频来源", "文本 → 端口1：拒绝（参考音频要音频来源）");
  has(CE("input_text", "breeze_gen", 5, 0), "无效的输入端子", "越界端子（5）被拦下");
  has(CE("control", "breeze_gen", 0, 0), "端口 4", "控制线落到端口0：报「控制输入端子为端口 4」");
  eqStr(CE("control", "breeze_gen", 4, 0) || "", "", "控制线落到端口4：放行");
  eqStr(CE("breeze_gen", "save", 0, 0) || "", "", "breeze_gen 端口0 的音频可连保存节点");
  has(CE("breeze_gen", "save", 0, 2), "没有输出端子", "端子序号越界（breeze_gen 只有 0=音频 / 1=控制）被拦下");
  /* 端口已被占：同一条线重复连会被「两节点已连接」先拦下；换一个来源节点才轮到端子占用判定 */
  {
    const f1 = mk("f", "input_text", { text: "hi" });
    const f2 = mk("f2", "input_text", { text: "hi2" });
    const to = mk("t", "breeze_gen");
    scene([f1, f2, to], [{ id: "w1", from: "f", to: "t", toIndex: 0, fromIndex: 0 }]);
    has(F.connectError("f", "t", 0, 0), "已连接", "同一条线重复连被「两节点已连接」拦下");
    has(F.connectError("f2", "t", 0, 0), "已被占用", "端口 0 已被别人占用时再连被拦下");
    eqStr(F.connectError("f2", "t", 2, 0) || "", "", "端口 0 被占不影响端口 2（参考文稿）");
  }
  /* 拖线落点：音频来源落参考音频槽（1），文本来源落空闲文本槽 */
  {
    const to = mk("t", "breeze_gen");
    scene([to], []);
    eqNum(F.nextFreeMediaDataSlot(to, mk("a", "input_audio"), 0), 1, "音频来源优先落端口 1（参考音频）");
    eqNum(F.nextFreeMediaDataSlot(to, mk("x", "input_text"), 0), 0, "文本来源落端口 0（待合成文本）");
    /* 端口占用按真实线判定（occupied 读 S.wf.wires 的 to/toIndex），所以这里把线真摆上去 */
    const txt = mk("txt", "input_text", { text: "x" });
    scene([to, txt], [{ id: "w1", from: "txt", to: "t", toIndex: 0, fromIndex: 0 }]);
    eqNum(F.nextFreeMediaDataSlot(to, mk("x", "input_text"), 0), 2, "端口 0 占了 → 文本落端口 2（参考文稿）");
    scene([to, txt], [
      { id: "w1", from: "txt", to: "t", toIndex: 0, fromIndex: 0 },
      { id: "w2", from: "txt", to: "t", toIndex: 2, fromIndex: 0 },
    ]);
    eqNum(F.nextFreeMediaDataSlot(to, mk("x", "input_text"), 0), 3, "端口 0/2 都占了 → 文本落端口 3（指令）");
    scene([to, txt], [
      { id: "w1", from: "txt", to: "t", toIndex: 0, fromIndex: 0 },
      { id: "w2", from: "txt", to: "t", toIndex: 2, fromIndex: 0 },
      { id: "w3", from: "txt", to: "t", toIndex: 3, fromIndex: 0 },
    ]);
    eqNum(F.nextFreeMediaDataSlot(to, mk("x", "input_text"), 0), null, "文本槽占满 → 无落点（返回 null）");
    eqNum(F.nextFreeMediaDataSlot(to, mk("a", "input_audio"), 0), 1, "音频槽仍空 → 音频来源照样能落端口 1");
  }
  /* 头部按钮 / 设置面板 / body 分支都挂在真实源码上 */
  has(canvasSrc, 'node.kind === "breeze_gen"', "app-canvas.js 认识 breeze_gen");
  has(canvasSrc, "appendBackendProbeBtn(head, node)", "节点头部带后端探活按钮");
  has(canvasSrc, 'appendMediaConsoleBtn(head, node)', "节点头部带控制台按钮");
  /* ▶ / ■ 那一对键：本轮起由 app-nodes.js 的 appendMediaPlayBtns 统一构造（8 个生成族
     节点共用），所以 tooltip 文案作为实参传给那只函数 —— 断言跟着换到调用点。 */
  has(
    canvasSrc,
    'appendMediaPlayBtns(head, node, "调用 Breeze TTS 2 后端合成语音")',
    "▶ 按钮的 tooltip 指到 Breeze 后端",
  );
  has(canvasSrc, 'registerNodeSettingsForm("breeze_gen"', "设置面板登记了 breeze_gen");
  const bForm = canvasSrc.slice(
    canvasSrc.indexOf('registerNodeSettingsForm("breeze_gen"'),
    /* 窗口 9000：本轮在表单里插了一块「参考文稿」区块（注释 + 区块宿主），
       原来的 7000 刚好把后面的格式下拉挤出窗口 —— 断言本身没变，只是窗口要跟上。 */
    canvasSrc.indexOf('registerNodeSettingsForm("breeze_gen"') + 9000,
  );
  for (const f of ["voiceMode", "cfgScale", "seed", "instruction", "attempts", "ttsFormat"])
    has(bForm, "node." + f, "设置面板会写回 node." + f);
  has(bForm, "breezeStatus", "设置面板音色下拉从 breezeStatus 读音色库");
  has(bForm, '["wav", "wav"]', "格式下拉含 wav");
  has(bForm, '["flac", "flac"]', "格式下拉含 flac");
  has(bForm, '["mp3", "mp3（需 ffmpeg）"]', "格式下拉含 mp3 并标注需 ffmpeg");
  has(nodesSrc, "appendBreezeGenSummaryBody", "app-nodes.js 提供 body 摘要");
  has(canvasSrc, 'appendBreezeGenSummaryBody(node, body, "audio")', "body 用了 breeze 专属摘要");
  has(canvasSrc, 'appPluginInstalled("breeze-tts-local")', "未装插件时节点出警示条");

  /* ═════════════ [5] 参考源优先级 / 能力 / 错误码 ═════════════ */
  console.log("\n[5] 参考源优先级（端子优先）· 能力语义 · 错误码译法");
  const voices = breezeStatus.apiStatus.voices;
  {
    const n = mk("n1", "breeze_gen", { voice: "播音", __refAudio: "" });
    const r = F.breezeResolveRef(n, voices);
    eqStr(r.source, "音色库：播音", "端子为空 → 用节点设置里的音色（状态行写明来源）");
    eqStr(r.refText, "这是一段参考文稿。", "音色库的文稿被带进来");
    eqStr(r.voiceId, "播音", "voiceId = 播音");
  }
  {
    const n = mk("n2", "breeze_gen", { voice: "播音", __refAudio: "E:/ref/temp.wav" });
    const r = F.breezeResolveRef(n, voices);
    eqStr(r.source, "参考音频端子", "端子有音频 → 端子优先，不再用音色");
    eqStr(r.audioPath, "E:/ref/temp.wav", "audioPath 取端子的那条");
    eqStr(r.voiceId, "", "此时不下发 voiceId（避免两套参考源打架）");
  }
  {
    const n = mk("n3", "breeze_gen", { voice: "", __refAudio: "" });
    const r = F.breezeResolveRef(n, voices);
    has(r.source, "音色设计", "两者都没有 → 认定为音色设计");
  }
  eqNum(F.breezeCfgScaleOf({ cfgScale: 0 }), 1, "cfg_scale 非法（0）时回落到 1");
  eqNum(F.breezeCfgScaleOf({ cfgScale: 99 }), 10, "cfg_scale 超过上限时夹到 10");
  eqNum(F.breezeSeedOf({ seed: 7 }), 7, "seed 按整数透传");
  eqNum(F.breezeSeedOf({ seed: 3.9 }), 3, "seed 取整");
  /* seed 缺省回落：breezeSeedOf 里的 `isFinite(Math.floor(Number(...)))` 保证 NaN → 42，
     这里按源码口径静态核对（Number("") === 0 是合法种子，不该被当成缺省） */
  {
    const at = nodesSrc.indexOf("function breezeSeedOf(");
    const seg = at < 0 ? "" : nodesSrc.slice(at, at + 260);
    has(seg, "isFinite(v) ? v : 42", "seed 缺失 / 非法时回落到 42");
    has(seg, "Math.floor(Number(node && node.seed))", "seed 按整数解析（Number(\"\") === 0 不会被误判成缺省）");
  }
  eqStr(F.breezeFormatOf({ ttsFormat: "MP3" }), "mp3", "格式大小写归一");
  eqStr(F.breezeFormatOf({ ttsFormat: "ogg" }), "wav", "不支持的格式回落到 wav");
  eqStr(F.breezeModeOf({ voiceMode: "xx" }), "auto", "瞎填的能力档回落到 auto");
  /* 错误码译法：认得出的给中文，认不出的原样回显 */
  {
    const t = F.breezeErrorText('{"detail":{"code":"missing_ffmpeg","message":"x"}}');
    has(t, "ffmpeg", "missing_ffmpeg → 中文指路提到 ffmpeg");
    has(t, "ffmpeg", "missing_ffmpeg 的提示可照着做");
    eqStr(F.breezeErrorText("no_api_key"), "Breeze TTS 2 服务密钥缺失（请先在「插件 · Breeze TTS 2 本地 TTS」启动一次后端）", "no_api_key 的固定中文文案");
    has(F.breezeErrorText("ref_text_required"), "参考音频必须与参考文本成对提供", "参考音频缺参考文本有明确指路");
    has(F.breezeErrorText("ref_text_required"), "「参考文本」框", "指路落在节点上的那个框（不是控制台音色库）");
    has(F.breezeErrorText("busy_engine"), "引擎正忙", "busy_engine → 引擎忙");
    has(F.breezeErrorText("engine_loading"), "加载权重", "engine_loading → 正在加载权重");
    has(F.breezeErrorText("cuda_unavailable"), "CUDA", "cuda_unavailable → 说明要 N 卡");
    has(F.breezeErrorText("ecx_unknown_thing"), "ecx_unknown_thing", "认不出的码原样回显（不编造）");
  }

  /* ═════════════ [6] 执行链 ═════════════ */
  console.log("\n[6] 执行链：媒体串行链 / 全局锁 / 分发 / 真跑一次合成");
  has(nodesSrc, 'node.kind === "breeze_gen"', "playNodeBody 认识 breeze_gen");
  has(
    nodesSrc,
    "runMediaGenSerial(node, () => playBreezeGenNode(node, quiet))",
    "breeze_gen 走媒体串行链（同一时刻只跑一个生成任务）",
  );
  has(nodesSrc, "eager 就要约 7.7GB 显存", "串行链的注释写明为什么持全局锁");
  has(nodesSrc, "fetchMediaGenLock", "playBreezeGenNode 做全局锁前置判定");
  has(nodesSrc, "mediaGenLockBusyMsg(lock)", "playBreezeGenNode 被别人占锁时写忙碌提示");
  has(nodesSrc, 'node.kind === "breeze_gen"', "playNodeBody 的媒体分支含 breeze_gen");
  has(nodesSrc, 'node.kind === "breeze_gen") node.breezeStatus = msg', "终止/丢队列时写 breezeStatus");
  has(appSrc, "breezeStatus = I18n.t(\"已取消\")", "单节点停止时写 breezeStatus = 已取消");
  has(appSrc, '{ kind: "breeze_gen", g: "处理节点" }', "WIRE_DROP_TARGETS 收 breeze_gen（拖线落空白可就地新建）");
  has(appSrc, '"breeze_gen"', "app.js 的成员表收 breeze_gen");
  {
    const searchSrc = read("renderer/app-search.js");
    has(searchSrc, '"breeze_gen"', "手册搜索的指南清单含 breeze_gen");
  }

  /* 真跑一次：文本 + 音色库（无端子音频） */
  breezeStatus = {
    running: true,
    installed: true,
    apiUp: true,
    apiStatus: {
      engine: { up: true, port: 8773, sampleRate: 24000 },
      voices,
    },
  };
  genCalls = [];
  {
    const n = mk("nRun", "breeze_gen", {
      voice: "播音",
      voiceMode: "clone",
      instruction: "",
      cfgScale: 1,
      seed: 7,
      ttsFormat: "wav",
      outputPath: "E:/out/voice.wav",
      attempts: 1,
    });
    const txt = mk("nRunTxt", "input_text", { text: "hi" });
    scene([n, txt], [{ id: "wr0", from: "nRunTxt", to: n.id, toIndex: 0, fromIndex: 0 }]);
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 1, "合成请求发出一次（真实 playBreezeGenNode → api.breezeGenerate）");
    const b = genCalls[0] || {};
    eqStr(b.text, "hi", "请求带待合成文本");
    eqStr(b.voice, "播音", "请求带音色库音色");
    eqStr(b.refAudio, "", "端子没接 → refAudio 空");
    eqStr(b.refText, "这是一段参考文稿。", "参考文稿从音色库带出");
    eqStr(b.mode, "clone", "能力档透传");
    eqNum(b.cfgScale, 1, "cfg_scale 透传");
    eqNum(b.seed, 7, "seed 透传");
    eqStr(b.response_format, "wav", "输出格式透传");
    eqStr(b.outputPath, "E:/out/voice.wav", "输出路径透传");
    ok(!!n.output && n.output.kind === "audio", "合成后节点 output 是音频");
    eqArr(ctrlFired.filter((c) => c.id === "nRun").map((c) => c.port), [1], "跑完驱动下游控制口（端口 1）");
  }
  /* 端子优先：接了参考音频且参考文稿也有（成对）→ 端子赢，不下发 voiceId */
  {
    genCalls = [];
    const n = mk("nRun2", "breeze_gen", {
      voice: "播音",
      voiceMode: "auto",
      instruction: "",
      cfgScale: 4,
      seed: 42,
      ttsFormat: "flac",
      outputPath: "E:/out/voice.flac",
      attempts: 1,
      __refAudio: "E:/ref/terminal.wav",
    });
    const t0 = mk("nRun2T", "input_text", { text: "hi" });
    const t2 = mk("nRun2R", "input_text", { text: "端子里的文稿" });
    scene([n, t0, t2], [
      { id: "w0", from: "nRun2T", to: n.id, toIndex: 0, fromIndex: 0 },
      { id: "w2", from: "nRun2R", to: n.id, toIndex: 2, fromIndex: 0 },
    ]);
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 1, "端子给了成对的参考音频 + 文稿 → 正常发请求");
    const b2 = genCalls[0] || {};
    eqStr(b2.refAudio, "E:/ref/terminal.wav", "端子优先：参考音频取端子的那条");
    eqStr(b2.voice, "", "端子优先时不下发音色库 id（两套参考源不打架）");
    eqStr(b2.refText, "端子里的文稿", "参考文稿也取端子的那条");
    eqStr(b2.mode, "auto", "未指定能力档时按参数自动判定（后端判定）");
    eqStr(b2.response_format, "flac", "flac 格式透传");
  }
  /* 端口 0 没接文本 → 用节点上「输入文本」框里那份（node.srcText） */
  {
    genCalls = [];
    const n = mk("nSrcBox", "breeze_gen", {
      voice: "播音",
      voiceMode: "clone",
      instruction: "",
      cfgScale: 1,
      seed: 42,
      ttsFormat: "wav",
      outputPath: "E:/out/voice.wav",
      attempts: 1,
      srcText: "框里这句要念",
    });
    scene([n], []);
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 1, "端口 0 空着 → 用节点「输入文本」框里的文字发请求");
    eqStr(genCalls[0].text, "框里这句要念", "待合成文本取自 srcText");
    eqStr(genCalls[0].refText, "这是一段参考文稿。", "参考文本仍从音色库带出");
  }
  /* 端口 0 与「输入文本」框都有内容 → 端子优先（框只读回显，不参与取数） */
  {
    genCalls = [];
    const n = mk("nSrcWin", "breeze_gen", {
      voice: "播音",
      voiceMode: "clone",
      instruction: "",
      cfgScale: 1,
      seed: 42,
      ttsFormat: "wav",
      outputPath: "E:/out/voice.wav",
      attempts: 1,
      srcText: "框里这句不算数",
    });
    const t = mk("nSrcWinT", "input_text", { text: "端口这句才算数" });
    scene([n, t], [{ id: "wh0", from: "nSrcWinT", to: n.id, toIndex: 0, fromIndex: 0 }]);
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 1, "端口 0 有输入 → 正常发请求");
    eqStr(genCalls[0].text, "端口这句才算数", "端子优先：端口 0 赢过节点框里那份");
  }
  /* 端口 2 没接文本 → 用节点上「参考文本」框里那份（node.refText），与端口 1 的音频成对 */
  {
    genCalls = [];
    const n = mk("nRefBox", "breeze_gen", {
      voice: "",
      voiceMode: "clone",
      instruction: "",
      cfgScale: 1,
      seed: 42,
      ttsFormat: "wav",
      outputPath: "E:/out/voice.wav",
      attempts: 1,
      __refAudio: "E:/ref/terminal.wav",
      refText: "框里这份参考文本",
    });
    const t = mk("nRefBoxT", "input_text", { text: "hi" });
    scene([n, t], [{ id: "wi0", from: "nRefBoxT", to: n.id, toIndex: 0, fromIndex: 0 }]);
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 1, "参考音频 + 框里的参考文本成对 → 发请求");
    eqStr(genCalls[0].refText, "框里这份参考文本", "参考文本取自节点上的 refText 框");
    eqStr(genCalls[0].refAudio, "E:/ref/terminal.wav", "参考音频照旧取端口 1");
  }
  /* 有参考音频、两个来源都没参考文本 → 本地拦下并指路到「参考文本」框（本节点不做转录） */
  {
    genCalls = [];
    const n = mk("nRefMiss", "breeze_gen", {
      voice: "",
      voiceMode: "clone",
      instruction: "",
      cfgScale: 1,
      seed: 42,
      ttsFormat: "wav",
      outputPath: "E:/out/voice.wav",
      attempts: 1,
      __refAudio: "E:/ref/terminal.wav",
    });
    const t = mk("nRefMissT", "input_text", { text: "hi" });
    scene([n, t], [{ id: "wj0", from: "nRefMissT", to: n.id, toIndex: 0, fromIndex: 0 }]);
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 0, "参考音频缺参考文本 → 不发请求（本地拦下）");
    has(String(n.error || n.breezeStatus || ""), "参考文本", "节点状态行说清缺的是参考文本");
    has(String(n.error || ""), "「参考文本」框", "提示指路到节点上的「参考文本」框");
  }
  /* 音频节点接在「参考文稿」端口 2 上（用户报的两条症状）：文本只认文字（端口 2 的音频
     URL 绝不当参考文本），而那只音频节点自己的音频文件要当参考音频（并归一回本机路径，
     不能把 file:/// …%E5%8E%9F… 原样下发给后端 —— 那是 ref_audio_missing 的成因）。 */
  const URL_ENC =
    "file:///E:/dev/voice_db/%E5%8E%9F%E7%A5%9E(%E4%B8%AD)/%E9%92%9F%E7%A6%BB/17.%E5%85%B3%E4%BA%8E%E7%A5%9E.mp3";
  const LOCAL_AUDIO = "E:\\dev\\voice_db\\原神(中)\\钟离\\17.关于神.mp3";
  {
    const t = mk("nP2T", "input_text", { text: "hi" });
    /* 音频节点自己的转写（端口 1 的转写输出）还没跑出来 → 框里空着 */
    const a = mk("nP2A", "input_audio", { mediaAsset: LOCAL_AUDIO });
    const n = mk("nP2", "breeze_gen", {
      voice: "",
      voiceMode: "clone",
      instruction: "",
      cfgScale: 1,
      seed: 42,
      ttsFormat: "wav",
      outputPath: "E:/out/voice.wav",
      attempts: 1,
    });
    scene(
      [n, t, a],
      [
        { id: "wp0", from: "nP2T", to: n.id, toIndex: 0, fromIndex: 0 },
        { id: "wp2", from: "nP2A", to: n.id, toIndex: 2, fromIndex: 0 },
      ],
    );
    eqStr(F.breezeTextSlot(n, 2), "", "端口 2 接音频节点 → 不把那条 file:/// URL 当参考文本");
    eqStr(F.breezeAudioSlotPath(n, 2), LOCAL_AUDIO, "端口 2 的音频节点 → 它的音频文件当参考音频");
    eqStr(F.breezeResolveRef(n, voices).audioPath, LOCAL_AUDIO, "参考源解析：audioPath 取端口 2 的音频");
    has(F.breezeResolveRef(n, voices).source, "端口 2", "状态行写明音频来自端口 2");
    /* 还没有转写 → 本地拦下并指路去音频节点转录，不发注定失败的请求 */
    genCalls = [];
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 0, "音频接端口 2 但还没转写 → 不发请求（本地拦下）");
    has(String(n.error || ""), "「参考文本」框", "指路仍写清可以先在框里填");
    has(String(n.error || ""), "转写输出", "同时指路到音频节点的「转写输出」");
  }
  {
    /* 音频节点接端口 1（参考音频）+ 端口 2（它的**转写输出**）→ 文字取转写，音频取该节点 */
    const a = mk("nP2B", "input_audio", { mediaAsset: LOCAL_AUDIO, __transcript: "关于「神之眼」的那段话。" });
    const n = mk("nP2B2", "breeze_gen", {
      voice: "",
      voiceMode: "clone",
      instruction: "",
      cfgScale: 1,
      seed: 42,
      ttsFormat: "wav",
      outputPath: "E:/out/voice.wav",
      attempts: 1,
    });
    const t = mk("nP2B2T", "input_text", { text: "hi" });
    scene(
      [n, t, a],
      [
        { id: "wq0", from: "nP2B2T", to: n.id, toIndex: 0, fromIndex: 0 },
        { id: "wq1", from: "nP2B", to: n.id, toIndex: 1, fromIndex: 0 },
        { id: "wq2", from: "nP2B", to: n.id, toIndex: 2, fromIndex: 1 },
      ],
    );
    eqStr(F.breezeTextSlot(n, 2), "关于「神之眼」的那段话。", "端口 2 接转写输出 → 框里显示转写文字");
    /* ★ 本轮 bug 的根因（用户报「参考文本里仍然显示 file:///…mp3，不显示参考文字」）：
       musicGenSlotText 以前把 valueFromWire 的端子号写死成 0，而真身对普通节点用 batchIdx
       当端子号 → 「音频节点端口 1（转写输出）」被读成端口 0，拿回那串 file:/// URL；更糟的是
       breezeTextSlot 给音视频来源开了一条**早退分支**，那道媒体值闸门被绕过，URL 直接被当成
       参考文字回显。两条一起修：端子号按线上的 fromIndex 取，闸门不再有旁路。 */
    eqStr(
      F.musicGenSlotText(n, 2),
      "关于「神之眼」的那段话。",
      "musicGenSlotText 认线上端子号：转写输出给的是转写文字，不是端口 0 的媒体 URL",
    );
    has(F.musicGenSlotText(n, 2), "神之眼", "取回的是正文（不是 file:/// 那串路径）");
    eqNum(F.musicGenSlotText(n, 2).indexOf("file:///") === 0 ? 1 : 0, 0, "取回的值不以 file:/// 开头");
    /* 端口 0（该文件本身）接进参考文稿口：即便这只音频节点已经有转写，也不许拿它顶上来
       —— 那个口给的是「音频」这件事本身，参考文本该由端口 1 或框里给。 */
    scene(
      [n, t, a],
      [
        { id: "wq0", from: "nP2B2T", to: n.id, toIndex: 0, fromIndex: 0 },
        { id: "wq1", from: "nP2B", to: n.id, toIndex: 1, fromIndex: 0 },
        { id: "wq2", from: "nP2B", to: n.id, toIndex: 2, fromIndex: 0 },
      ],
    );
    eqStr(F.breezeTextSlot(n, 2), "", "端口 2 接音频输出（端口 0）→ 该口没有文字，框里空着");
    eqNum(
      String(F.breezeTextSlot(n, 2)).indexOf("file:///") === 0 ? 1 : 0,
      0,
      "端口 0 那一路的 file:/// URL 绝不当参考文本（闸门仍在）",
    );
    scene(
      [n, t, a],
      [
        { id: "wq0", from: "nP2B2T", to: n.id, toIndex: 0, fromIndex: 0 },
        { id: "wq1", from: "nP2B", to: n.id, toIndex: 1, fromIndex: 0 },
        { id: "wq2", from: "nP2B", to: n.id, toIndex: 2, fromIndex: 1 },
      ],
    );
    genCalls = [];
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 1, "音频 + 转写成对 → 发请求");
    eqStr(genCalls[0].refAudio, LOCAL_AUDIO, "参考音频 = 音频节点的本机路径");
    eqStr(genCalls[0].refText, "关于「神之眼」的那段话。", "参考文本 = 那条转写");
  }
  {
    /* 端子值直接给一条百分号编码的 file:/// URL（音频节点端口 0 的对外口径）：
       归一成本机路径，绝不把 URL 丢给后端（否则后端报 ref_audio_missing）。 */
    eqStr(F.breezeAudioPathOfValue({ kind: "audio", text: URL_ENC }), LOCAL_AUDIO, "file:/// URL 归一成本机路径（含中文百分号编码）");
    eqStr(F.breezeAudioPathOfValue(URL_ENC), LOCAL_AUDIO, "裸 file:/// URL 同样归一");
    eqStr(F.breezeAudioPathOfValue(LOCAL_AUDIO), LOCAL_AUDIO, "本机路径原样透传");
    eqStr(F.breezeAudioPathOfValue("file:///E:/x/notes.txt"), "", "非音频文件不当参考音频");
  }
  /* 文本为空时不发请求 */
  {
    genCalls = [];
    const n = mk("nRun3", "breeze_gen", { voice: "播音", outputPath: "E:/out/v.wav", attempts: 1 });
    scene([n], []);
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 0, "待合成文本为空 → 不发请求");
    has(String(n.error || ""), "文本来源", "状态行提示要接文本来源");
    has(String(n.error || ""), "「输入文本」框", "提示指路到节点上的「输入文本」框");
  }
  /* 插件未装 → 明确指路 */
  {
    genCalls = [];
    breezeStatus = { installed: false, apiUp: false, apiStatus: null };
    const n = mk("nRun4", "breeze_gen", { voice: "", outputPath: "E:/out/v.wav", attempts: 1 });
    const t4 = mk("nRun4T", "input_text", { text: "hi" });
    scene([n, t4], [{ id: "wc0", from: "nRun4T", to: n.id, toIndex: 0, fromIndex: 0 }]);
    await F.playBreezeGenNode(n, true);
    eqNum(genCalls.length, 0, "后端未安装 → 不发请求");
    has(String(n.error || ""), "尚未安装", "状态行指路去插件里安装");
  }

  /* ═════════════ [7] 两个文本框：入口两处 + 端子只读口径 + 不做转录 + 样式词条 ═════════════ */
  console.log("\n[7] 输入文本 / 参考文本：设置窗与卡片 body 两个入口 · 端子有输入只读 · 本节点不做转录");
  {
    /* 两个框的真源与顺序（BREEZE_TEXT_BOXES：端口 0 → srcText，端口 2 → refText） */
    has(nodesSrc, "const BREEZE_TEXT_BOXES = [", "两个文本框有一份真源表");
    has(nodesSrc, 'label: "输入文本（需要念的）"', "第一个框 = 输入文本（需要念的）");
    has(nodesSrc, 'label: "参考文本（参考音频对应的文字）"', "第二个框 = 参考文本（参考音频对应的文字）");
    has(nodesSrc, 'field: "srcText"', "输入文本落在 node.srcText");
    has(nodesSrc, 'field: "refText"', "参考文本落在 node.refText");
    has(appSrc, "srcText: \"\"", "breeze_gen 默认值里有 srcText（随节点持久化）");
    has(appSrc, "refText: \"\"", "breeze_gen 默认值里有 refText");
    /* 端子优先：有输入就只读，没输入才可编辑（同一行代码同时钉住两个框） */
    has(nodesSrc, "ta.readOnly = !!st.locked", "端子有输入时文本框切只读（端子优先）");
    has(
      nodesSrc,
      "if (slotText) return { text: slotText, locked: true };",
      "判定就一条：端子有值 → 只读回显；端子空 → 节点上那份可编辑",
    );
    has(nodesSrc, "breezeTextBoxStateText(node, spec)", "状态胶囊写明这个框现在归谁");
    has(nodesSrc, '"（端子优先，本框只读）"', "只读时写明原因（端子优先）");
    has(nodesSrc, "端子为空 · 可编辑", "可编辑时也有一句现况");
    has(nodesSrc, "breezeTextBoxCommit(node, spec, ta.value)", "框里改字写回节点（input 事件即落库）");
    has(nodesSrc, "function breezeSrcTextOf(node)", "待合成文本的取数口 = breezeSrcTextOf");
    has(nodesSrc, "breezeTextSlot(node, 0) || breezeTextOf(node, \"srcText\").trim()", "端口 0 优先、端子为空才用框里那份");
    has(nodesSrc, "const text = breezeSrcTextOf(node);", "playBreezeGenNode 就按这个口径取待合成文本");
    /* ★ 本轮 bug 的两条根因各钉一颗钉子（用户：参考文本里仍然显示 file:///…mp3）：
       ① musicGenSlotText 必须按线上的端子号取音视频输入节点的值；
       ② breezeTextSlot 里不许再有「音视频来源」的早退分支（它会绕过媒体值闸门）。 */
    has(
      nodesSrc,
      "const srcIdx = src && isBreezeMediaSource(src) ? Number(w.fromIndex || 0) : 0;",
      "musicGenSlotText 认音视频输入节点的端子号（端口 1 = 转写文字，不再读成端口 0 的 URL）",
    );
    has(
      nodesSrc,
      "if (isBreezeMediaSource(src) && Number(w.fromIndex || 0) <= 0) return \"\";",
      "breezeTextSlot 只把「端口 0 = 该文件本身」判为空，其余一律落到媒体值闸门",
    );
    ok(
      !/return Number\(w\.fromIndex\) > 0 \? musicGenSlotText\(node, slot\)\.trim\(\) : "";/.test(
        nodesSrc,
      ),
      "旧的无闸门早退分支已删除（它就是 URL 被当参考文字回显的旁路）",
    );
    has(
      nodesSrc,
      "return breezeIsMediaValue(text) ? \"\" : text;",
      "媒体值闸门仍在（本机路径 / file:/// URL 一律不当参考文字）",
    );
    /* 两处入口共用一份实现（设置窗调用期取，不能顶层求值 —— 老 TDZ 事故见 index.html 注释） */
    has(canvasSrc, "breezeTextBoxesFor(node, {}", "设置窗调用 breezeTextBoxesFor 建两个框");
    has(canvasSrc, "文本（端子有输入时只读，端子为空才可编辑）", "设置窗那一格写明只读口径");
    has(canvasSrc, "function breezeTextBoxPlaceholder(", "app-nodes.js 未加载时的占位有一只手写实现");
    has(nodesSrc, "function breezeTextBoxesFor(", "两个框共用同一份实现");
    has(nodesSrc, "function appendBreezeTextBoxesBody(", "卡片 body 的挂载入口已定义");
    has(nodesSrc, "appendBreezeTextBoxesBody(node, body)", "卡片 body 上挂了这两个框");
    has(canvasSrc, "appendBreezeGenSummaryBody(node, body, \"audio\")", "卡片 body 仍走 breeze 专属摘要（末尾挂框）");
    /* 本节点不做转录：转录通道 / 上游转录复用 / 音色库写回一律不再出现（breeze 文本槽那一段
       自己那句注释里会提到 SenseVoice，所以这里不核对这个词，只核对真代码入口） */
    const breezeTextSec = (() => {
      const a = nodesSrc.indexOf("Breeze 文本槽");
      const b = nodesSrc.indexOf("/* 参考源解析");
      return a >= 0 && b > a ? nodesSrc.slice(a, b) : "";
    })();
    ok(breezeTextSec.length > 0, "切得出 breeze 文本槽那一段（静态核对的依据）");
    for (const gone of [
      "spTranscribeFile",
      "asrTranscriptOf",
      "breezeEnsureRefText",
      "breezeFillVoiceRefText",
      "api/voices/add",
    ])
      hasnt(breezeTextSec, gone, "breeze 文本框这一段不再有转录痕迹：" + gone);
    hasnt(nodesSrc, "breezeEnsureRefText", "全仓不再有 breezeEnsureRefText");
    hasnt(nodesSrc, "breezeFillVoiceRefText", "全仓不再有 breezeFillVoiceRefText");
    hasnt(nodesSrc, "spTranscribeFile(", "breeze 侧不再调本机转写（app-nodes.js 里没有这条通道）");
    hasnt(nodesSrc, "node.refAsrState", "转录状态机（refAsrState）已随转录一起摘掉");
    /* 样式与词条 */
    const asrCss = read("renderer/css/asr.css");
    has(asrCss, ".n-reftext-state", "两个框有状态胶囊样式");
    has(asrCss, ".n-reftext-state.locked", "只读态胶囊有自己的配色");
    has(asrCss, ".n-textslots", "两个框之间的间距有样式");
    has(asrCss, ".n-reftext-ops", "操作行样式留着（清空）");
    has(asrCss, "body.theme-light .n-reftext-host-card", "亮色主题有覆盖");
    has(i18nSrc, "输入文本（需要念的）", "i18n 有「输入文本」词条");
    has(i18nSrc, "参考文本（参考音频对应的文字）", "i18n 有「参考文本」词条");
    has(i18nSrc, "（端子优先，本框只读）", "i18n 有只读口径词条");
    has(i18nSrc, "端子为空 · 可编辑", "i18n 有可编辑口径词条");
    hasnt(i18nSrc, "生成文稿（SenseVoice）", "i18n 里转录词条已清掉");
  }
  /* 真跑一遍 DOM 构造（带极小 document 替身）：只读 / 可编辑 / 写回 / 清空四条行为 */
  {
    const taOf = (host, i) => (host.children[i].children || []).find((c) => c.tag === "textarea");
    const pillOf = (host, i) =>
      ((host.children[i].children[0] || {}).children || []).find(
        (c) => String(c.className || "").indexOf("n-reftext-state") === 0,
      );
    const btnOf = (host, i) => {
      const inner = host.children[i].children || [];
      const ops = inner.find((c) => String(c.className || "").indexOf("n-reftext-ops") >= 0);
      return ops ? (ops.children || [])[0] : undefined;
    };

    /* ① 两个端口都空着 → 两个框都可编辑，内容回显节点字段，打字立即写回 */
    const n1 = mk("nBox", "breeze_gen", { srcText: "框里要念的话" });
    scene([n1], []);
    const b1 = F.breezeTextBoxesFor(n1, { compact: true });
    eqNum(b1.children.length, 2, "两个框：输入文本 + 参考文本");
    eqStr(taOf(b1, 0).value, "框里要念的话", "输入文本框回显 node.srcText");
    eqNum(taOf(b1, 0).readOnly ? 1 : 0, 0, "端口 0 空着 → 输入文本框可编辑");
    eqNum(taOf(b1, 1).readOnly ? 1 : 0, 0, "端口 2 空着 → 参考文本框可编辑");
    has(pillOf(b1, 0).textContent, "可编辑", "可编辑时状态胶囊写明「端子为空 · 可编辑」");
    eqStr(taOf(b1, 0).id, "breezetext-nBox-srcText-card", "卡片 body 上那只是 -card 后缀（与设置窗不撞 id）");
    eqStr(taOf(b1, 1).id, "breezetext-nBox-refText-card", "参考文本框同理");
    taOf(b1, 0).value = "改过的话";
    taOf(b1, 0).fire("input");
    eqStr(n1.srcText, "改过的话", "在输入文本框里打字 → 立即写回 node.srcText");
    taOf(b1, 1).value = "改过的参考文本";
    taOf(b1, 1).fire("input");
    eqStr(n1.refText, "改过的参考文本", "在参考文本框里打字 → 立即写回 node.refText");
    btnOf(b1, 0).onclick({ stopPropagation() {} });
    eqStr(n1.srcText, "", "可编辑时那颗「清空」把字段清掉");

    /* ② 两个端口都有输入 → 两个框都只读，回显端子的那份（端子优先），打字不落库 */
    const n2 = mk("nBox2", "breeze_gen", { srcText: "框里不算数", refText: "框里也不算数" });
    const t0 = mk("nBox2T", "input_text", { text: "端子这句才算数" });
    const t2 = mk("nBox2R", "input_text", { text: "端子参考文本" });
    scene(
      [n2, t0, t2],
      [
        { id: "wb0", from: "nBox2T", to: n2.id, toIndex: 0, fromIndex: 0 },
        { id: "wb2", from: "nBox2R", to: n2.id, toIndex: 2, fromIndex: 0 },
      ],
    );
    const b2 = F.breezeTextBoxesFor(n2, { compact: true });
    eqNum(taOf(b2, 0).readOnly ? 1 : 0, 1, "端口 0 有输入 → 输入文本框切只读");
    eqStr(taOf(b2, 0).value, "端子这句才算数", "只读框回显端子的那份（端子优先）");
    eqNum(taOf(b2, 1).readOnly ? 1 : 0, 1, "端口 2 有输入 → 参考文本框切只读");
    eqStr(taOf(b2, 1).value, "端子参考文本", "参考文本框同样回显端子那份");
    has(pillOf(b2, 0).textContent, "来自端口 0", "状态胶囊写明「来自端口 0」");
    has(pillOf(b2, 1).textContent, "来自端口 2", "状态胶囊写明「来自端口 2」");
    eqNum(btnOf(b2, 0) ? 1 : 0, 0, "只读的框上没有「清空」按钮");
    taOf(b2, 0).value = "手改只读框";
    taOf(b2, 0).fire("input");
    eqStr(n2.srcText, "框里不算数", "只读框里的输入不写回节点（那一格不归用户改）");

    /* ③ 卡片与设置窗同一个节点各来一份 → DOM id 必须区分，真源是同一个字段 */
    const bSet = F.breezeTextBoxesFor(n2, {});
    eqStr(taOf(bSet, 0).id, "breezetext-nBox2-srcText-set", "设置窗那份是 -set 后缀");
    eqStr(taOf(bSet, 0).value, "端子这句才算数", "两处回显同一份真源（端子优先）");
    /* ④ 选了音色库音色 → 多一句「留空时用音色库自带的那份参考文本」 */
    const n3 = mk("nBox3", "breeze_gen", { voice: "播音" });
    const b3 = F.breezeTextBoxesFor(n3, { compact: true });
    eqNum(b3.children.length, 3, "选了音色 → 两个框 + 一句音色库提示");
    has(b3.children[2].textContent, "音色库", "提示写明留空时用音色库自带的那份");

    /* ⑤ 端口 2 接音频节点 → 框只读；还没有转写 → 框里空着 + 一句「先去它上面转录」 */
    const n4 = mk("nBox4", "breeze_gen", { refText: "框里这份不算数" });
    const a4 = mk("nBox4A", "input_audio", { mediaAsset: LOCAL_AUDIO });
    scene([n4, a4], [{ id: "wd2", from: "nBox4A", to: n4.id, toIndex: 2, fromIndex: 0 }]);
    const b4 = F.breezeTextBoxesFor(n4, { compact: true });
    eqNum(taOf(b4, 1).readOnly ? 1 : 0, 1, "端口 2 接音频节点 → 参考文本框只读（不显示那条 URL）");
    eqStr(taOf(b4, 1).value, "", "还没有转写 → 框里空着（绝不回显 file:/// 路径）");
    has(pillOf(b4, 1).textContent, "来自端口 2", "只读原因仍写明「来自端口 2」");
    has(b4.children[2].textContent, "转录", "框下补一句：先去那只音频节点点「转录」");
    /* ⑥ 那串路径到底从哪来（用户报的「参考文本里显示 file:///…mp3」）：音频节点**端口 0**
       这一路的值就是 file:/// 那串 URL（app.js 的 displayValueOf 口径）—— 旧代码把端子号
       写死成 0，于是它被当成「参考文稿」交到框里显示。现在：它只可能来自端口 0，且一律被
       媒体值闸门挡下；端口 1（转写输出）才给文字。 */
    has(
      F.musicGenSlotText(n4, 2),
      "file:///",
      "端口 0 那一路的值确实是 file:/// 那串 URL（旧代码就是把它当参考文字显示的）",
    );
    eqStr(F.breezeTextSlot(n4, 2), "", "但它进不了「参考文本」框：媒体值闸门挡下");
    /* ⑥ 媒体值接进「参考文本」口 → **任何来源**都不当文字（用户报的漏口：音频文件的
       本机路径 / URL 仍被当成参考文本显示）。音频值由 breezeAudioSlotPath 当参考音频取走，
       文字槽一律空 → 文本框空着（不显示路径），节点在本地拦停并指路框里填 / 去转录。 */
    {
      /* 上一组把插件状态改成了「未安装」：这里要真跑到合成入口，先恢复就绪态 */
      breezeStatus = { installed: true, apiUp: true, apiStatus: { voices: [] } };
      const n5 = mk("nBox5", "breeze_gen", {
        refText: "",
        voice: "",
        outputPath: "E:/out/voice.wav",
        attempts: 1,
      });
      const t0b = mk("nBox5T", "input_text", { text: "要念的话" });
      const g5 = mk("nBox5G", "save", { __savedPath: "E:/out/ref.wav" });
      scene(
        [n5, t0b, g5],
        [
          { id: "we0", from: "nBox5T", to: n5.id, toIndex: 0, fromIndex: 0 },
          { id: "we2", from: "nBox5G", to: n5.id, toIndex: 2, fromIndex: 0 },
        ],
      );
      eqStr(F.breezeTextSlot(n5, 2), "", "音频来源接端口 2 → 本机路径不当参考文本");
      const ref5 = F.breezeResolveRef(n5, []);
      eqStr(ref5.refText, "", "参考源解析同样不把路径当参考文本");
      /* 这条线上没给出「成对的参考音频 + 文稿」：跑起来必须本地拦停并指路，不白跑引擎 */
      genCalls = [];
      await F.playBreezeGenNode(n5, true);
      eqNum(genCalls.length, 0, "媒体值接参考文稿口 → 不发注定失败的请求");
      has(String(n5.error || ""), "「参考文本」框", "状态行指路到「参考文本」框里填");
      /* 文本端子直接给一条媒体路径（用户把音频路径填进文本节点 / 函数节点的那一支）同样拦住 */
      const fp = mk("nBox5F", "input_text", { text: "E:\\voice_db\\原神(中)\\钟离\\17.关于神.mp3" });
      scene(
        [n5, fp],
        [{ id: "we2b", from: "nBox5F", to: n5.id, toIndex: 2, fromIndex: 0 }],
      );
      eqStr(F.breezeTextSlot(n5, 2), "", "文本端子给的媒体路径也不当参考文本");
      const b5 = F.breezeTextBoxesFor(n5, { compact: true });
      eqStr(taOf(b5, 1).value, "", "参考文本框里空着（绝不回显那条路径）");
      eqNum(taOf(b5, 1).readOnly ? 1 : 0, 1, "端子有输入 → 那个框仍然只读");
      has(b5.children[b5.children.length - 1].textContent, "音频 / 视频", "框下写清「这个口给的是音频 / 视频」");
      /* 判据本身：媒体文件路径 / 音频视频值命中，真文字不误伤 */
      eqNum(F.breezeIsMediaFilePath("E:\\out\\ref.wav") ? 1 : 0, 1, "本机音频路径判为媒体文件");
      eqNum(F.breezeIsMediaFilePath("file:///E:/out/ref.m4a") ? 1 : 0, 1, "file:/// 音频 URL 判为媒体文件");
      eqNum(F.breezeIsMediaFilePath("E:/out/clip.MP4") ? 1 : 0, 1, "视频路径（大写扩展名）判为媒体文件");
      eqNum(F.breezeIsMediaFilePath("这是一段普通的参考文稿。") ? 1 : 0, 0, "普通文字不误判");
      eqNum(F.breezeIsMediaValue({ kind: "audio", path: "E:/out/a.wav" }) ? 1 : 0, 1, "结构化音频值判为媒体");
      eqNum(F.breezeIsMediaValue({ kind: "text", text: "参考文稿" }) ? 1 : 0, 0, "文本值不算媒体");
    }
    /* 转写接进来之后 → 框里就是那段文字，提示条不再出现 */
    const a4b = mk("nBox4B", "input_audio", { mediaAsset: LOCAL_AUDIO, __transcript: "转写好的文稿" });
    scene([n4, a4b], [{ id: "wd3", from: "nBox4B", to: n4.id, toIndex: 2, fromIndex: 1 }]);
    const b4b = F.breezeTextBoxesFor(n4, { compact: true });
    eqStr(taOf(b4b, 1).value, "转写好的文稿", "端口 2 接转写输出 → 框里回显那段转写");
    eqNum(b4b.children.length, 2, "有转写 → 不再挂「先去转录」那句提示");
  }

  /* ═════════════ [7b] 等待态自愈（本轮 bug） ═════════════ */
  console.log("\n[7b] 「等待中」不再卡死：幽灵 pending 自愈 + 排队中可停 + ▶ / ■ 两态");
  {
    /* ① 幽灵 pending（没有任何队列 / 运行体在等它）→ 扫掉，▶ 立刻回到可点 */
    S.pendingRun = new Set(["nOrphan"]);
    S.runPromises = new Map();
    S._scheduledRunIds = null;
    scene([mk("nOrphan", "breeze_gen")], []);
    eqNum(F.sweepOrphanPendingRuns(), 1, "幽灵等待态被扫掉（没有队列 / 运行体在等它）");
    eqNum(S.pendingRun.size, 0, "扫过之后 S.pendingRun 里不留那条");
    eqNum(F.isNodePending({ id: "nOrphan" }) ? 1 : 0, 0, "isNodePending 随之转假 → ▶ 不再被钉成等待中");

    /* ② 还在媒体串行链上排队 / 正在跑 / 挂着运行 promise 的，绝不误伤 */
    const nHold = mk("nHold", "breeze_gen");
    S.pendingRun = new Set(["nHold"]);
    sandbox.mediaGenWaiters.set("nHold", { token: {}, seq: 0, tick: 0 });
    eqNum(F.sweepOrphanPendingRuns(), 0, "仍在串行链上排队 → 扫把不碰它");
    sandbox.mediaGenWaiters.delete("nHold");
    const nBusy = mk("nBusy", "breeze_gen", { running: true });
    scene([nBusy], []);
    S.pendingRun = new Set(["nBusy"]);
    eqNum(F.sweepOrphanPendingRuns(), 0, "正在跑的节点不会被扫掉");
    nBusy.running = false;
    S.runPromises = new Map([[nBusy.id, Promise.resolve()]]);
    eqNum(F.sweepOrphanPendingRuns(), 0, "挂着运行 promise 的节点不会被扫掉");
    S.runPromises = new Map();
    eqNum(F.sweepOrphanPendingRuns(), 1, "运行 promise 一撤，同一条立刻可扫");

    /* ③ 一轮跑完（本节点正在跑）→ 收尾就把自己的等待态摘干净。
       ⚠ 这里刻意**不**在 mediaGenWaiters 里留项：媒体串行链的出队点是先摘表再起跑，
       「还在排队」的 id 本来就该留着等待态（那是真等待，不是幽灵）。
       注：S/串行链表都在外层的共享作用域里，本用例不整体换掉它们。 */
    breezeStatus = {
      running: true,
      installed: true,
      apiUp: true,
      apiStatus: { engine: { up: true, port: 8773 }, voices },
    };
    genCalls = [];
    const nDone = mk("nDone", "breeze_gen", {
      voice: "播音",
      voiceMode: "clone",
      ttsFormat: "wav",
      outputPath: "E:/out/done.wav",
      attempts: 1,
    });
    const tDone = mk("nDoneT", "input_text", { text: "念这句" });
    scene([nDone, tDone], [{ id: "wd0", from: "nDoneT", to: nDone.id, toIndex: 0, fromIndex: 0 }]);
    /* 像真队列那样：入队时挂在 mediaGenWaiters 上，出队（起跑）时摘掉 */
    sandbox.mediaGenWaiters.set(nDone.id, { token: {}, seq: 0, tick: 0 });
    sandbox.mediaGenWaiters.delete(nDone.id);
    sandbox.S.pendingRun = new Set([nDone.id]);
    eqNum(F.isNodePending(nDone) ? 1 : 0, 1, "起跑前：这一条还挂在「等待中」上（▶ 显示排队）");
    await F.playBreezeGenNode(nDone, true);
    eqNum(genCalls.length, 1, "nDone 真跑了一趟（合成请求发出一次）");
    eqNum(S.pendingRun.has(nDone.id) ? 1 : 0, 0, "跑完的节点不再留在「等待中」");
    eqNum(F.isNodePending(nDone) ? 1 : 0, 0, "isNodePending 转假 → ▶ 回到可点");
    eqNum(F.breezeTextSlot(nDone, 0), "念这句", "取数口未受等待态收尾影响（端子文本照旧）");

    /* ④ 头部那对键：排队中同样给 ■（这才是「关得掉」） */
    const nPend = mk("nPend", "breeze_gen");
    scene([nPend], []);
    S.pendingRun = new Set([nPend.id]);
    stopCalls = [];
    const headPend = fakeEl("div");
    F.appendMediaPlayBtns(headPend, nPend, "调用 Breeze TTS 2 后端合成语音");
    eqNum(headPend.children.length, 2, "排队中 → ▶ 与 ■ 都在（旧写法只有一颗点不动的 ▶）");
    eqStr(headPend.children[0].textContent, "…", "排队中的 ▶ 显示 …");
    eqStr(headPend.children[0].title, "排队等待中…", "排队中的 ▶ 提示「排队等待中…」");
    eqStr(headPend.children[1].className, "n-play n-stop", "排队中给的是 ■（可停）那颗键");
    has(headPend.children[1].title, "取消排队", "排队中的 ■ 写明「取消排队」");
    headPend.children[1].fire("click");
    eqArr(stopCalls, [nPend.id], "点排队中的 ■ → 真的走 stopNode（不再点了没反应）");
    /* 未跑未排队：只有一颗 ▶，且不再显示等待文案 */
    S.pendingRun = new Set();
    const headIdle = fakeEl("div");
    F.appendMediaPlayBtns(headIdle, nPend, "调用 Breeze TTS 2 后端合成语音");
    eqNum(headIdle.children.length, 1, "空闲态只有 ▶ 一颗键");
    eqStr(headIdle.children[0].textContent, "▶", "空闲态 ▶ 可点");
    eqStr(headIdle.children[0].title, "调用 Breeze TTS 2 后端合成语音", "空闲态提示回到「调用后端」");
    /* 在跑：▶ 转圈 + ■（与旧行为一致） */
    const nLive = mk("nLive", "breeze_gen", { running: true });
    scene([nLive], []);
    const headLive = fakeEl("div");
    F.appendMediaPlayBtns(headLive, nLive, "调用 Breeze TTS 2 后端合成语音");
    eqNum(headLive.children.length, 2, "在跑 → ▶（…）与 ■ 都在");
    eqStr(headLive.children[0].textContent, "…", "在跑的 ▶ 显示 …");
    has(headLive.children[0].className, "running", "在跑的 ▶ 带 running 态");
    eqStr(headLive.children[1].title, "取消生成请求", "在跑的 ■ 仍是「取消生成请求」");

    /* ⑤ 静态钉住：8 个生成族节点头部共用这一只实现（不再各抄一遍，
          否则「排队中不给 ■」这种漏改会再次发生）；收尾与停止链里的自愈调用也要在 */
    for (const kw of [
      "调用 Minimax Music 3 后端生成",
      "调用 YuE2 本地后端生成音乐",
      "调用 SenseNova 本地后端生成图像",
      "调用 Minimax H3 后端生成",
      "调用 GPT-SoVITS 后端合成语音",
      "调用 Breeze TTS 2 后端合成语音",
      "生成动效代码并本地渲染视频",
    ])
      has(
        canvasSrc,
        'appendMediaPlayBtns(head, node, "' + kw + '")',
        "节点头部改走唯一实现：" + kw,
      );
    has(
      canvasSrc,
      'appendMediaPlayBtns(head, node, isUpscale ? "运行视频超分后处理" : "运行视频补帧后处理"',
      "节点头部改走唯一实现：视频后处理（标题按超分 / 补帧分岔）",
    );
    hasnt(canvasSrc, 'stop.title = I18n.t("取消生成请求")', "生成族头部不再各抄一份 ■ 的构造");
    has(nodesSrc, "function appendMediaPlayBtns(", "▶ / ■ 的唯一实现落在 app-nodes.js");
    /* ⑥ 处理族（proc / task / wait_file / 函数工具）那 4 处同样是「排队中不给 ■」的旧写法：
          本轮一并收口到 appendNodePlayBtns —— 局部行为断言 + 调用点静态断言 */
    has(nodesSrc, "function appendNodePlayBtns(", "处理族的 ▶ / ■ 也有一份唯一实现");
    const nGenPend = mk("nGenPend", "proc_text");
    scene([nGenPend], []);
    S.pendingRun = new Set([nGenPend.id]);
    stopCalls = [];
    const headGen = fakeEl("div");
    F.appendNodePlayBtns(headGen, nGenPend, "运行：基于提示词与输入内容调用文本模型", {
      stopTitle: "停止运行（立即中止模型请求）",
    });
    eqNum(headGen.children.length, 2, "处理节点排队中 → ▶ 与 ■ 都在");
    eqStr(headGen.children[0].title, "排队等待中…", "处理节点排队中的 ▶ 提示「排队等待中…」");
    has(headGen.children[1].title, "取消排队", "处理节点排队中的 ■ 写明「取消排队」");
    headGen.children[1].fire("click");
    eqArr(stopCalls, [nGenPend.id], "处理节点排队中点 ■ → 也真的走 stopNode");
    S.pendingRun = new Set();
    const headGenIdle = fakeEl("div");
    F.appendNodePlayBtns(headGenIdle, nGenPend, "运行：基于提示词与输入内容调用文本模型", {
      stopTitle: "停止运行（立即中止模型请求）",
    });
    eqNum(headGenIdle.children.length, 1, "处理节点空闲态仍然只有 ▶ 一颗键（不噪声）");
    for (const kw of [
      'appendNodePlayBtns(head, node, "开始监视文件"',
      'appendNodePlayBtns(head, node, "按序执行：从起点沿控制流跑到成功/失败终点"',
      "appendNodePlayBtns(",
    ])
      has(canvasSrc, kw, "处理族节点头部改走唯一实现：" + kw);
    /* 处理族那 4 处（proc / task / wait_file / 函数工具）头部同样收口：断言里的跨行片段
       对 CRLF 不敏感 —— 源码是 CRLF，直接写 \n 会永远「找不到」而假绿。 */
    ok(
      !/\n\s{2,}stop\.title = I18n\.t\("停止运行（立即中止模型请求）"\);/.test(canvasSrc) &&
        !/\n\s{2,}stop\.title = I18n\.t\("停止等待"\);/.test(canvasSrc),
      "proc / wait_file 节点头部不再各抄一份 ■ 的构造",
    );
    has(nodesSrc, "function sweepOrphanPendingRuns(", "等待态自愈扫把在 app-nodes.js");
    has(
      nodesSrc,
      "clearPendingRun([node.id]);",
      "playBreezeGenNode 收尾兜底清等待态",
    );
    ok(
      /clearPendingRun\(\[node\.id\]\);\s*\r?\n\s*sweepOrphanPendingRuns\(\);/.test(nodesSrc),
      "收尾是「先清自己 + 再扫整表幽灵」两步（跨行断言，CRLF 也认）",
    );
    has(appSrc, "sweepOrphanPendingRuns();", "运行队列取数前先自愈（collectRunQueue 口径）");
    has(
      appSrc,
      'if (typeof sweepOrphanPendingRuns === "function") sweepOrphanPendingRuns();',
      "停止链：排队 / 幽灵等待态点 ■ 也能摘掉（不再直接 return）",
    );
    has(appSrc, "该节点没有正在运行或排队中的任务", "什么都没在跑时给一句明确提示，不静默");
  }

  /* ═════════════ [8] 文档 / 技能 / i18n / 图标 ═════════════ */
  console.log("\n[8] 文档与技能：中英指南 + 索引 + 修复技能 + i18n + 图标");
  for (const f of [
    "guides/nodes/breeze_gen.md",
    "guides/nodes/en/breeze_gen.md",
    "guides/nodes/img/breeze_gen.svg",
    "skills/breeze-tts-local-install/SKILL.md",
    "plugins/icons/breeze-tts-local.png",
  ])
    ok(exists(f), "文档 / 资产存在：" + f);
  const nodeIdx = JSON.parse(read("guides/nodes/index.json"));
  ok(nodeIdx.ids.indexOf("breeze_gen") >= 0, "breeze_gen 已进节点指南索引");
  eqStr(
    nodeIdx.ids[nodeIdx.ids.indexOf("tts_gen") + 1],
    "breeze_gen",
    "索引里 breeze_gen 紧跟 tts_gen（音频生成四类相邻）",
  );
  const guideZh = read("guides/nodes/breeze_gen.md");
  const guideEn = read("guides/nodes/en/breeze_gen.md");
  for (const kw of ["音频生成", "端口 4 = 控制输入", "Breeze", "非商用", "breeze-tts-local-install"])
    has(guideZh, kw, "中文指南写明「" + kw + "」");
  for (const kw of ["Breeze", "non-commercial", "breeze-tts-local-install"])
    has(guideEn, kw.toLowerCase() === kw ? kw : kw, "英文指南写明「" + kw + "」");
  has(guideZh, "成对", "中文指南写明参考音频与文稿必须成对");
  has(guideZh, "输入文本（需要念的）", "中文指南写明第一个文本框 = 输入文本（需要念的）");
  has(guideZh, "参考文本（参考音频对应的文字）", "中文指南写明第二个文本框 = 参考文本");
  has(guideZh, "只读", "中文指南写明端子有输入时只读");
  has(guideZh, "不做转录", "中文指南写明本节点不做转录");
  has(guideEn, "Input text", "英文指南写明第一个文本框 = input text");
  has(guideEn, "Reference text", "英文指南写明第二个文本框 = reference text");
  has(guideEn, "does no transcription", "英文指南写明本节点不做转录");
  has(guideZh, "ffmpeg", "中文指南写明 mp3 需要 ffmpeg");
  has(guideZh, "全局音视频互斥锁", "中文指南写明持全局锁");
  const svg = read("guides/nodes/img/breeze_gen.svg");
  has(svg, "<svg", "指南图是 SVG");
  has(svg, 'marker id="arr"', "指南图带箭头 marker（与范本同骨架）");
  has(svg, "breeze_gen", "指南图底部标注节点类型");
  const skill = read("skills/breeze-tts-local-install/SKILL.md");
  has(skill, "name: breeze-tts-local-install", "技能 frontmatter 名 = breeze-tts-local-install");
  has(skill, "【自我修复】", "技能含【自我修复】模式（真源）");
  has(skill, "已知故障", "技能含已知故障 → 处置表");
  has(skill, "非商用", "技能写明许可（非商用）");
  has(skill, ".install-ok", "技能写明安装完成判据文件");
  has(skill, "8772", "技能写明管理服务端口");
  ok(Buffer.from(skill, "utf8").length > 4000, "技能正文非空壳（>4000 字节）");
  /* i18n：节点关键中文 key 都要有英文词条 */
  const i18nObj = require("../renderer/i18n.js");
  const dict = i18nObj.dict || i18nObj.TRANSLATIONS || null;
  const zhDict = dict && (dict.zh || dict);
  const enDict = dict && (dict.en || null);
  if (enDict) {
    const keys = [
      "Breeze 语音",
      "Breeze 语音节点",
      "Breeze 语音生成（文本转语音 · Breeze TTS 2）",
      "参考音频",
      "参考文稿",
      "指令",
      "音色克隆",
      "音色设计",
      "音色导演",
      "自动判定",
    ];
    for (const k of keys) ok(!!enDict[k], "i18n 有英文词条：" + k);
  } else {
    /* 两语表可能不是这个导出形状：退一步按源码文本核对 */
    for (const k of ["Breeze 语音节点", "音色导演", "参考音频", "参考文稿"])
      ok(i18nSrc.indexOf('"' + k + '"') > 0, "i18n.js 含词条 key：" + k);
  }
  has(read("renderer/app-nodehelp.js"), "breeze_gen:", "节点帮助文案含 breeze_gen");
  /* ═════════════ [8] 安装自愈链（宿主前置兜底 / 冒烟闸门 / 引擎与合成上报） ═════════════ */
  console.log("\n[8] 安装自愈：宿主标识符兜底 + 前置阶段统一收口 + 冒烟闸门 + 引擎 / 合成上报");
  /* 事故锚点（2026-10-07）：bundledPackRoot 用的 app 掉出 require 列表 → ReferenceError 抛在保底链内部
     → breeze:install IPC 裸 reject、报错总线一条事件都没有 → 用户只看到「装完用不了」。下面两条钉住它。 */
  has(
    hostSrc,
    'const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron")',
    "宿主从 electron 取 app",
  );
  has(
    hostSrc,
    'typeof app !== "undefined" && app && app.isPackaged',
    "bundledPackRoot 对 app 做 typeof 兜底（防 ReferenceError 回归）",
  );
  has(hostSrc, "function hostError(", "宿主有 hostError：自身错误统一写 console + 上报总线");
  has(hostSrc, 'reportErr("host_error"', "宿主自身错误以 host_error 进总线");
  has(hostSrc, "async function startBackendInner(", "启用入口拆出 startBackendInner（外层可兜底）");
  ok(
    /async function startBackend\(\)[\s\S]{0,400}startBackendInner\(\)/.test(hostSrc),
    "startBackend 真的转调 startBackendInner",
  );
  ok(
    /catch \(e\) \{\n\s+emitProgress\(\{ phase: "start"[\s\S]{0,220}hostError\("start", e\)/.test(hostSrc),
    "启用兜底 → hostError('start')（不再裸 reject IPC）",
  );
  has(hostSrc, 'hostError("agent-install-pre", e)', "Agent 保底链的前置阶段也收口");
  has(hostSrc, 'hostError("install-fallback", e2)', "Agent 保底调用本身也兜底");
  has(hostSrc, "async function installProjectInner(", "安装入口也拆出 inner（外层可兜底）");
  has(hostSrc, 'hostError("install", e)', "安装入口的护栏 / mk 目录抛错 → hostError('install')");
  has(hostSrc, "async function agentInstallByAgentInner(", "Agent 保底链也拆出 inner");
  has(hostSrc, 'hostError("agent-install", e)', "Agent 保底链取网关 / mk 目录抛错 → hostError('agent-install')");
  has(hostSrc, "function readInstallVerdict(", "有失败裁决读取（脚本 → 宿主同口径）");
  has(hostSrc, "pluginErrors.judgeRepairability(", "「修不了」的判定复用总线真源，不在宿主里另抄一份");
  has(hostSrc, "agentRecoverable: false", "不可修裁决的回执里标明不进 Agent 修复");
  has(hostSrc, "function engineControl(", "引擎加载 / 卸载失败进总线");
  has(
    hostSrc,
    'ipcMain.handle("breeze:engineStart", async () => engineControl("start"))',
    "engineStart 走 engineControl",
  );
  has(hostSrc, "function reportGenerateFail(", "合成失败有上报包装");
  ok(
    count(hostSrc, /reportGenerateFail\(\{/g) >= 4,
    "合成的每个后端失败出口都上报（" + count(hostSrc, /reportGenerateFail\(\{/g) + " 处）",
  );
  has(hostSrc, "GEN_NO_REPORT", "纯输入类错误（缺文本 / 缺参考文稿…）不进总线，免得弹无意义的修复窗");
  /* 冒烟闸门：与 tts / llama 的 throw、sensenova 的 ok=false 同口径 */
  has(installPs1, "冒烟不过就不算装好", "安装脚本写明冒烟闸门口径");
  has(installPs1, "$smokeRc = $LASTEXITCODE", "安装脚本记下冒烟退出码");
  has(installPs1, 'Write-Verdict "false" "smoke_failed"', "import 失败 → 写裁决 smoke_failed（交 Agent 修）");
  has(installPs1, 'Write-Verdict "false" "no_cuda"', "CUDA 不可用 → 写裁决 no_cuda（只指路，不烧 AI 修复）");
  has(installPs1, "Remove-Item -Force $installOk", "旧 .install-ok 先撤（失败的重装不能冒充装好）");
  ok(
    /if \(\$smokeRc -ne 0\)[\s\S]{0,240}exit 1/.test(installPs1),
    "冒烟失败以非 0 退出（宿主的 Agent 保底链才会被触发）",
  );
  has(installPs1, "BREEZE_SKIP_CUDA_CHECK", "无卡机器留了显式逃生阀（默认闸门关着）");
  hasnt(
    installPs1,
    'if ($LASTEXITCODE -ne 0) { Say "冒烟 import 失败',
    "老的「只打印一行仍写 .install-ok」已删除",
  );
  /* 控制台手动修复入口：把 preload 里那座死桥接上 */
  has(read("breeze/ui/index.html"), 'id="btnSelfRepair"', "Breeze 控制台有「自我修复」按钮");
  const uiJs = read("breeze/ui/app.js");
  has(uiJs, "api.agentRecoverInstall({})", "按钮接 preload 已暴露的 agentRecoverInstall");
  has(uiJs, '"btnSelfRepair").disabled', "按钮在没有安装目录 / 安装中时禁用");
  has(uiJs, "自我修复会把最近的 console 日志交给 Agent", "点之前有确认（与 music3 / h3 同口径）");
  /* 文档：宿主清单补上 breeze（原文只列了 7 个宿主） */
  has(read("docs/plugin-auto-repair.md"), "breeze", "自动修复文档的宿主清单含 breeze");
  /* ═════════════ [9] 行为验证：宿主兜底真跑 + 闸门脚本真跑 + 不修判定真跑 ═════════════ */
  console.log("\n[9] 安装自愈 · 行为验证：宿主兜底真跑 / 闸门脚本真跑 / 不修判定真跑");
  {
    /* 9.1 bundledPackRoot：在「app 未声明」这个原事故条件下真跑一次 —— 不许再抛 */
    const code = fnBody(hostSrc, "bundledPackRoot");
    const ctx = {
      path,
      join: path.join,
      fs: { existsSync: () => false },
      process: { resourcesPath: "C:/nope" },
      __dirname: "C:/app/breeze",
      appRoot: "C:/app",
      console,
    };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    let got = "";
    let threw = "";
    try {
      got = vm.runInContext("bundledPackRoot()", ctx);
    } catch (e) {
      threw = String((e && e.message) || e);
    }
    eqStr(threw, "", "app 未声明时 bundledPackRoot 不再抛（原事故条件复现）");
    eqStr(got, path.join("C:/app", "breeze-pack"), "退回 appRoot 解析脚手架目录");
    let oldThrew = "";
    try {
      vm.runInContext("app && app.isPackaged", ctx);
    } catch (e) {
      oldThrew = e.name;
    }
    eqStr(oldThrew, "ReferenceError", "同一条件下老写法（直接读 app）确实抛 ReferenceError");
  }
  {
    /* 9.2 hostError：自身错误必须变成一次总线事件，而不是冒泡成 IPC reject */
    const calls = [];
    const ctx = {
      console,
      appendConsole: (l) => calls.push(["log", String(l)]),
      reportErr: (c, m, x) => calls.push(["bus", c, m, x && x.phase]),
      consoleTail: () => ({ ok: true, text: "TAIL" }),
    };
    vm.createContext(ctx);
    vm.runInContext(fnBody(hostSrc, "hostError"), ctx);
    const ret = vm.runInContext('hostError("install", new Error("boom"))', ctx);
    eqStr(ret, "host_error:boom", "hostError 回执带 host_error 前缀");
    const ev = calls.filter((c) => c[0] === "bus")[0];
    ok(!!ev && ev[1] === "host_error" && ev[3] === "install", "hostError 以 host_error + phase 上报总线");
    ok(
      calls.some((c) => c[0] === "log" && c[1].indexOf("[host-error] stage=install") === 0),
      "console 留下 [host-error] 现场行",
    );
  }
  {
    /* 9.3 startBackend 外层兜底：inner 抛错时给失败回执（不再 reject IPC） */
    const events = [];
    const ctx = {
      console,
      emitProgress: (e) => events.push(e),
      hostError: (stage, e) => "host_error:" + String((e && e.message) || e) + "@" + stage,
      startBackendInner: () => {
        throw new Error("app is not defined");
      },
    };
    vm.createContext(ctx);
    vm.runInContext(fnBody(hostSrc, "startBackend"), ctx);
    const r = await vm.runInContext("startBackend()", ctx);
    eqStr(String(r && r.ok), "false", "inner 抛错时 startBackend 回失败回执");
    eqStr(r && r.error, "host_error:app is not defined@start", "回执里带 host_error + 阶段");
    ok(!!events[0] && events[0].phase === "start" && events[0].error === true, "同时推一条 error 进度事件");
  }  {
    /* 9.3b installProject 外层兜底：连 mk(installDir) 这类前置动作抛错也不许裸 reject */
    const events2 = [];
    const ctx2 = {
      console,
      emitProgress: (e) => events2.push(e),
      hostError: (stage, e) => "host_error:" + String((e && e.message) || e) + "@" + stage,
      installing: true,
      installProjectInner: () => {
        throw new Error("EEXIST: file already exists, mkdir");
      },
    };
    vm.createContext(ctx2);
    vm.runInContext(fnBody(hostSrc, "installProject"), ctx2);
    const r2 = await vm.runInContext("installProject({})", ctx2);
    eqStr(String(r2 && r2.ok), "false", "inner 抛错时 installProject 回失败回执（不再 reject）");
    eqStr(r2 && r2.error, "host_error:EEXIST: file already exists, mkdir@install", "回执里带 host_error + 安装阶段");
    eqStr(String(vm.runInContext("installing", ctx2)), "false", "失败后把安装忙标志复位");
    ok(!!events2[0] && events2[0].phase === "install" && events2[0].error === true, "同时推一条 error 进度事件");
  }
  {
    /* 9.4 readInstallVerdict：真读脚本裁决（三种写法） */
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-verdict-"));
    const ctx = { fs, join: path.join, console, RegExp };
    vm.createContext(ctx);
    vm.runInContext(fnBody(hostSrc, "readInstallVerdict"), ctx);
    const writeV = (s) => fs.writeFileSync(path.join(dir, ".breeze-agent-result"), s, "utf8");
    const readV = () => vm.runInContext("readInstallVerdict(" + JSON.stringify(dir) + ")", ctx);
    writeV("ok=false\nreason=no_cuda\nvia=script\n");
    eqStr(readV() && readV().reason, "no_cuda", "裁决 no_cuda 读得出");
    writeV("ok=false\nreason=smoke_failed\nvia=script\n");
    eqStr(readV() && readV().reason, "smoke_failed", "裁决 smoke_failed 读得出");
    writeV("ok=true\nreason=\nvia=script\n");
    eqStr(readV(), null, "成功裁决（ok=true）不算失败裁决");
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    /* 9.5 不修判定：真跑总线模块（唯一真源），确认「谁该被 AI 修」分得清 */
    const bus = require("../plugin-error-repair.js");
    const fakeHost = {
      id: "breeze-tts-local",
      getInstallDir: () => "E:/mtnode-plugins/breeze",
      tailConsole: () => ({ ok: true, text: "x" }),
    };
    ok(bus.judgeRepairability(fakeHost, "no_cuda", "").repairable === false, "no_cuda 判为不可修 → 只给指路");
    ok(bus.judgeRepairability(fakeHost, "smoke_failed", "").repairable === true, "smoke_failed 判为可修 → 交 Agent");
    ok(bus.judgeRepairability(fakeHost, "host_error", "").repairable === true, "host_error 判为可修 → 弹窗建修复会话");
  }
  if (process.platform === "win32") {
    /* 9.6 闸门真跑：把安装脚本的闸门段原样抽出来，配一个假 .venv python 跑三种结局 */
    const os = require("os");
    const cp = require("child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-gate-"));
    const installDir = path.join(tmp, "install");
    fs.mkdirSync(path.join(installDir, "scripts"), { recursive: true });
    const stub = path.join(tmp, "stub-python.cmd");
    fs.writeFileSync(
      stub,
      [
        "@echo off",
        "echo(stub python: %*",
        'echo %* | findstr /C:"torch.cuda.is_available" >nul',
        "if not errorlevel 1 exit /b %BREEZE_TEST_CUDA%",
        "exit /b %BREEZE_TEST_SMOKE%",
      ].join("\r\n") + "\r\n",
      "utf8",
    );
    const at = installPs1.indexOf("# —— 6. 冒烟 & 落标记".replace("——", "──"));
    ok(at > 0, "能在安装脚本里定位闸门段");
    const harness = path.join(tmp, "gate.ps1");
    fs.writeFileSync(
      harness,
      [
        '$ErrorActionPreference = "Stop"',
        '$InstallDir = "' + installDir + '"',
        "New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null",
        '$VENV_PY = "' + stub + '"',
        'function Say([string]$m) { Write-Host ("[say] " + $m) }',
        "function Step([string]$m, [double]$p) { Say $m }",
        "function Progress([double]$p) { }",
        installPs1.slice(at),
      ].join("\r\n"),
      "utf8",
    );
    const runGate = (smokeRc, cudaRc) => {
      const r = cp.spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness],
        {
          env: Object.assign({}, process.env, {
            BREEZE_TEST_SMOKE: String(smokeRc),
            BREEZE_TEST_CUDA: String(cudaRc),
          }),
          encoding: "utf8",
        },
      );
      const vp = path.join(installDir, ".breeze-agent-result");
      return {
        code: r.status,
        verdict: fs.existsSync(vp) ? fs.readFileSync(vp, "utf8") : "",
        marked: fs.existsSync(path.join(installDir, ".install-ok")),
      };
    };
    const a = runGate(1, 0);
    eqNum(a.code, 1, "冒烟 import 失败 → 非 0 退出（宿主保底链才会被触发）");
    has(a.verdict, "reason=smoke_failed", "冒烟失败写裁决 smoke_failed");
    ok(!a.marked, "冒烟失败不写 .install-ok（不再假成功）");
    const b = runGate(0, 3);
    eqNum(b.code, 1, "CUDA 不可用 → 非 0 退出");
    has(b.verdict, "reason=no_cuda", "CUDA 不可用写裁决 no_cuda（只指路，不烧 AI 修复）");
    ok(!b.marked, "CUDA 不可用不写 .install-ok");
    const c = runGate(0, 0);
    eqNum(c.code, 0, "冒烟 + CUDA 都过 → 0 退出");
    has(c.verdict, "ok=true", "通过时裁决 ok=true");
    ok(c.marked, "通过时才写 .install-ok");
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log("  skip  windows-only：闸门真跑（安装脚本是 PowerShell）");
  }

  /* ═════════════ [10] 引擎按需拉起（后端在跑但引擎未加载 → 首次合成自动拉起） ═════════════ */
  console.log("\n[10] 引擎按需拉起：合成入口自动拉起 / 徽章文案 / 引擎日志 / 错误码细分进总线");
  /* 事故锚点（2026-10-08）：后端管理服务在跑、venv / 引擎 / 权重都齐，但引擎从没被拉起来 ——
     控制台徽章「引擎未加载」，第一次合成吃 engine_down，用户以为装坏了。下面几条钉住它。 */
  const packServerSrc = read("breeze-pack/app/server.py");
  has(packServerSrc, "def ensure_engine(", "pack 管理服务有 ensure_engine：合成前按需拉起引擎");
  has(packServerSrc, "_pull_job", "并发请求共用同一次拉起（不把 7.7GB 权重重复载进显存）");
  has(packServerSrc, "BREEZE_ENGINE_WAIT_S", "等待上限可调（默认 900s）");
  ok(
    count(packServerSrc, /ensure_engine_http\(\)/g) >= 2,
    "合成与试听两条入口都先拉起引擎（" + count(packServerSrc, /ensure_engine_http\(\)/g) + " 处）",
  );
  has(
    packServerSrc,
    "await run_in_threadpool(_speech_body, params)",
    "合成主体进工作线程：加载期间 /api/status 仍回得了（徽章才刷得出「引擎加载中…」）",
  );
  has(packServerSrc, "await run_in_threadpool(_preview_body, params)", "控制台试听同样不堵事件循环");
  has(packServerSrc, "ENGINE_ERR_STATUS.get(exc.code, 500)", "拉起失败按错误码分派 HTTP 状态（4xx 指路 / 5xx 交 Agent）");
  has(packServerSrc, "JSONResponse(ensure_engine_http())", "「加载模型」按钮与合成走同一条拉起路径");
  hasnt(
    packServerSrc,
    "raise _err(exc.code, exc.message, 400 if exc.code in",
    "老 start 端点里的内联状态映射已收敛到 ENGINE_ERR_STATUS",
  );
  /* 宿主：错误码细分进总线 + 引擎日志通道 */
  has(hostSrc, "function engineBusCode(", "引擎错误码换算到总线口径");
  has(hostSrc, 'const ENGINE_BUS_CODE = { cuda_unavailable: "no_cuda" }', "cuda_unavailable → no_cuda（总线的不修清单只认 no_cuda）");
  ok(
    count(hostSrc, /reportErr\(engineBusCode\(f\.code\)/g) >= 2,
    "引擎与合成两条失败出口都换算后再上报（" + count(hostSrc, /reportErr\(engineBusCode\(f\.code\)/g) + " 处）",
  );
  has(hostSrc, 'ipcMain.handle("breeze:engineLog"', "宿主暴露引擎日志 tail");
  has(
    read("breeze/preload-breeze.js"),
    'engineLog: (n) => ipcRenderer.invoke("breeze:engineLog", n)',
    "preload 白名单把引擎日志桥出来",
  );
  has(read("breeze/ui/index.html"), 'id="btnEngLog"', "控制台有「引擎日志」按钮");
  has(uiJs, "收起引擎日志", "引擎日志按钮可展开 / 收起");
  has(uiJs, "引擎未加载 · 用时自动加载", "徽章写明「未加载 · 用时自动加载」（不再让人以为装坏了）");
  has(uiJs, "正在拉起并加载约 7.7GB 权重", "合成时给出「正在加载模型…」的提示");
  has(uiJs, "未加载（首次合成自动拉起）", "推理引擎那一行也说明按需加载");
  has(uiJs, "再合成一次会自动重新拉起", "engine_down 的指路从「请先点加载模型」改成「会自动重新拉起」");
  hasnt(uiJs, '引擎未加载";', "老的裸「引擎未加载」徽章文案已换掉");
  {
    /* 行为：真跑 backendFailure（四种真实错误体）+ engineBusCode */
    const ctx = { console, JSON, RegExp, String };
    vm.createContext(ctx);
    vm.runInContext(fnBody(hostSrc, "ENGINE_BUS_CODE"), ctx);
    vm.runInContext(fnBody(hostSrc, "backendFailure"), ctx);
    vm.runInContext(fnBody(hostSrc, "engineBusCode"), ctx);
    const bf = (o) => vm.runInContext("backendFailure(" + JSON.stringify(o) + ")", ctx);
    const f1 = bf({ status: 400, json: { detail: { code: "no_weights", message: "未找到 Breeze TTS 2 权重：E:/x" } } });
    eqStr(f1.code, "no_weights", "FastAPI 的 detail 对象 → 解出 no_weights（以前塌成 backend_http_400）");
    has(f1.message, "权重", "错误正文原样带下去");
    const f2 = bf({ status: 500, error: '{"detail":{"code":"engine_exited","message":"引擎进程启动后退出"}}' });
    eqStr(f2.code, "engine_exited", "直写出口的 JSON 文本也解得出 code（进程退出细分）");
    const f3 = bf({ status: 400, error: "engine_start_timeout" });
    eqStr(f3.code, "engine_start_timeout", "纯错误码正文照旧（超时细分）");
    const f4 = bf({ status: 502, raw: "<html>bad gateway</html>" });
    eqStr(f4.code, "backend_http_502", "认不出的正文仍回落成 backend_http_<status>");
    eqStr(vm.runInContext('engineBusCode("cuda_unavailable")', ctx), "no_cuda", "engineBusCode 把 cuda_unavailable 改名成 no_cuda");
    eqStr(vm.runInContext('engineBusCode("engine_exited")', ctx), "engine_exited", "其它引擎码原样透传（细分保留）");
  }

  console.log(
    "\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks",
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

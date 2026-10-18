"use strict";
/* 素材库条目行的「行内预览 + 悬停浮层」行为回归（真源码切片 + 最小 DOM 桩）：
     node test/smoke-assets.js

 背景（本轮需求）：素材库 / 素材设置里的内容条目行只有「端子名 + 文件名 + 体积」，
 图像与文本要逐条点右侧「预览」按钮才看得见。本轮给条目行加了就地一眼：
   行内 = 图像 40px 缩略图（惰性加载）· 文本 正文首行摘要（>32KB 只给提示）· 音频 小播放键
   悬停 = 放大图 / 全文（只读）/ 完整波形试听 ＋ 「打开原文件 / 在文件夹中显示」两键
 与用户确认过的口径：鼠标移开即收（鼠标进浮层内保持）· Esc 也收 · 行尾「预览」按钮与
 文件名按钮的行为一律不变 · 全程只读，不写库。

 覆盖（都断言行为，不看正则；桩的语义对齐真 DOM 的那几处）：
   [1] 行内小样按类型挂：文本→摘要 · 图像→缩略图 · 音频→播放键 · 视频→不挂（不认识的类型不乱挂）
   [2] 行内小样：图像悬停前不取字节（惰性）、进视口才给 src；文本摘要只读开头（>32KB 直接给提示）
   [3] 悬停浮层：150ms 出场、带标题 / 全文 / 两键；鼠标移开即收（进浮层内则保持）
   [4] 收层出口：Esc 只收这一层（capture）、滚动 / 缩放让行离开原位即收、重画 / 关框不留下声源
   [5] 音频：行内播放键开浮层并起播同一只 .n-wave（不另起第二只），播放态回贴到行内按钮
   [6] 缓存：同一份列表不重复读摘要；换列表（另一个 holder）即清缓存重读
   [8] 重画回归：「看过一次，再回来就没了」—— 同一份列表重画后的新行照样拿到缩略图；
       正文改写后摘要缓存当场作废（不贴改写前那一句）
   [7] 静态接线与词条：行渲染挂载点、CSS 类、i18n 中英齐全、行尾「预览」按钮与文件名行为未动 */
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
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const show = (v) => JSON.stringify(v);
const REAL_SET_TIMEOUT = setTimeout.bind(globalThis);

/* ───────────────── 最小 DOM（语义对齐真 DOM 的那几处，抄 test/smoke-store-thumb-lazy.js） ───────────────── */
const DOC_LISTENERS = {};
const WIN_LISTENERS = {};
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    parentNode: null,
    isConnected: false,
    dataset: {},
    style: {},
    hidden: false,
    src: "",
    alt: "",
    title: "",
    value: "",
    readOnly: false,
    spellcheck: true,
    type: "",
    disabled: false,
    rows: 0,
    decoding: "",
    loading: "",
    _cls: "",
    /* 真 DOM 里 className 与 classList 是同一份数据：桩也必须一致
       （脚本常常直接写 className，再靠 classList.contains 读） */
    get className() {
      return el._cls;
    },
    set className(v) {
      el._cls = String(v == null ? "" : v);
      el.classList._set = new Set(el._cls.split(/\s+/).filter(Boolean));
    },
    attrs: {},
    listeners: {},
    classList: {
      _set: new Set(),
      add(...cs) {
        for (const c of cs) this._set.add(c);
        el.className = [...this._set].join(" ");
      },
      remove(...cs) {
        for (const c of cs) this._set.delete(c);
        el.className = [...this._set].join(" ");
      },
      toggle(c, on) {
        if (on === undefined) on = !this._set.has(c);
        if (on) this._set.add(c);
        else this._set.delete(c);
        el.className = [...this._set].join(" ");
      },
      contains: (c) => el.classList._set.has(c),
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
      if (k === "id") el.id = String(v);
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[camel] = String(v);
      }
    },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = el.listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type, ev) {
      for (const fn of (el.listeners[type] || []).slice())
        fn(Object.assign({ type: type, target: el, preventDefault() {}, stopPropagation() {} }, ev || {}));
    },
    appendChild(c) {
      c.parentNode = el;
      el.children.push(c);
      markConnected(c);
      return c;
    },
    append(...cs) {
      for (const c of cs) el.appendChild(c);
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c.parentNode = null;
      markConnected(c);
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    set innerHTML(v) {
      if (String(v) !== "") throw new Error('桩 DOM 只支持 innerHTML = ""');
      for (const c of el.children.slice()) {
        c.parentNode = null;
        markConnected(c);
      }
      el.children.length = 0;
    },
    get innerHTML() {
      return "";
    },
    textContent: "",
    querySelector(sel) {
      return findEl(el, sel);
    },
    closest(sel) {
      const bits = String(sel).split(".").filter(Boolean);
      let e = el;
      while (e) {
        if (bits.every((b) => e.classList.contains(b))) return e;
        e = e.parentNode;
      }
      return null;
    },
    matches(sel) {
      const s = String(sel).trim();
      if (s === ":hover") return el._hover === true;
      return el.classList.contains(s.replace(/^\./, "").split(":")[0]);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 40, height: 40, bottom: 40, right: 60 };
    },
    blur() {},
    focus() {},
  };
  return el;
}
/* 桩 DOM 的查询：脚本里两种写法都有（".cls" 与 "cls"），一律按类名逐层找后代
   —— 测试用得到的选择器只有「单类名 / 双类名 / #id」这几种形状。 */
function findEl(root, sel) {
  if (!root) return null;
  let s = String(sel).trim();
  if (!s) return null;
  if (s.charAt(0) === "#")
    return (root.children || []).filter((c) => c.id === s.slice(1))[0] || null;
  const bits = s.split(".").filter(Boolean);
  if (!bits.length) return null;
  const cls = bits[0];
  const extra = bits.slice(1);
  const stack = (root.children || []).slice();
  while (stack.length) {
    const e = stack.shift();
    if (e.classList.contains(cls) && extra.every((x) => e.classList.contains(x))) return e;
    stack.push(...(e.children || []));
  }
  return null;
}
/* 真 DOM 里 className 与 classList 是同一份数据：桩也必须一致（脚本常直接写 className） */
function markConnected(el) {
  const on = !!el.parentNode && (el.parentNode.isConnected || el.parentNode === ROOT_EL);
  el.isConnected = on;
  for (const c of el.children) markConnected(c);
}
const ROOT_EL = makeEl("body");
ROOT_EL.isConnected = true;

/* 可控的视口观察器 + 帧 / 定时器队列：测试自己决定谁进视口、什么时候到点 */
const OBS = { targets: new Set(), cb: null };
class FakeIO {
  constructor(cb) {
    this.cb = cb;
    OBS.cb = cb;
  }
  observe(el) {
    OBS.targets.add(el);
  }
  unobserve(el) {
    OBS.targets.delete(el);
  }
  disconnect() {
    OBS.targets.clear();
  }
}
const TIMERS = { now: 0, seq: 0, map: new Map() };
function fakeSetTimeout(fn, ms) {
  const id = ++TIMERS.seq;
  TIMERS.map.set(id, { at: TIMERS.now + (Number(ms) || 0), fn: fn });
  return id;
}
function fakeClearTimeout(id) {
  TIMERS.map.delete(id);
}
function advance(ms) {
  TIMERS.now += Number(ms) || 0;
  for (const [id, t] of [...TIMERS.map].sort((a, b) => a[1].at - b[1].at)) {
    if (t.at > TIMERS.now) continue;
    TIMERS.map.delete(id);
    t.fn();
  }
}
const FRAMES = [];
function fakeRaf(fn) {
  FRAMES.push(fn);
  return FRAMES.length;
}
function flushFrames() {
  const list = FRAMES.splice(0, FRAMES.length);
  for (const fn of list) fn();
}
class FakeMO {
  constructor(cb) {
    this.cb = cb;
    MO_LIST.push(this);
  }
  observe(target) {
    this.target = target;
  }
  disconnect() {}
  fire() {
    this.cb([{ target: this.target }]);
  }
}
const MO_LIST = [];

/* ───────────────── 沙箱：app-assets.js 里与预览有关的那一段真实源码 ───────────────── */
const SRC = read("renderer/app-assets.js");
/* 抄 test/smoke-asset-refs.js 的抠取器（仓库里已在用的那一份）：按大括号配平取出整段。
   与它唯一的差别：这里再判一次「常量后面挂着对象字面量」（多行 const 也得整段取走）。 */
function topDecl(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\n(?:const|let|var) " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到顶层声明：" + name);
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (!isFn) {
    const declLine = src.slice(at, src.indexOf("\n", at));
    if (!/[{[]\s*$/.test(declLine)) return src.slice(at, src.indexOf("\n", at) + 1);
  }
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
const FN_NAMES = [
  "assetEl",
  "assetPvSrc",
  "assetPvFrame",
  "assetPvThumb",
  "assetPvHeadText",
  "assetPvForgetHead",
  "assetPvLine",
  "assetPvTextCell",
  "assetPvItemSame",
  "assetPvAudioCell",
  "_assetPv",
  "assetPvShowFor",
  "assetPvShowNow",
  "assetPvCancel",
  "assetPvClose",
  "assetPvDropHost",
  "assetPvStopAudio",
  "assetPvBody",
  "assetPvOpen",
  "assetPvCancelAndClose",
  "assetPvWireRow",
  "assetSetRows",
  "assetSetRow",
];
/* 顶层 const / let 在 vm 里不会挂到 global：把本段用到的那些顶层常量声明一并切片，
   并把声明头改成 var（只动行首关键字），函数与函数体里一个字都不改。
   常量名单不手抄 —— 从源码里扫出来（免得源码加一个预览常量、测试还停在旧名单上）。 */
const TOP_CONSTS = [];
for (const line of SRC.split("\n")) {
  const m = line.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/);
  if (m && (m[1].indexOf("ASSET_PV") === 0 || m[1].indexOf("_assetPv") === 0))
    TOP_CONSTS.push(m[1]);
}
const CODE = TOP_CONSTS.concat(FN_NAMES)
  .map((n) => topDecl(SRC, n))
  .map((t) => t.replace(/^(const|let)\s/, "var "))
  .join("\n");

/* 素材库替身：条目摘要 + 读正文（真源码只问这几处） */
const ROOT_DIR = "E:/assetlib/ast1";
const ITEMS = [
  { id: "i1", title: "人物设定", type: "text", file: "items/人物设定.txt", absPath: ROOT_DIR + "/items/人物设定.txt", bytes: 40, missing: false },
  { id: "i2", title: "立绘", type: "image", file: "items/立绘.png", absPath: ROOT_DIR + "/items/立绘.png", bytes: 10240, missing: false },
  { id: "i3", title: "主题曲", type: "audio", file: "items/主题曲.mp3", absPath: ROOT_DIR + "/items/主题曲.mp3", bytes: 2048, missing: false },
  { id: "i4", title: "片段", type: "video", file: "items/片段.mp4", absPath: ROOT_DIR + "/items/片段.mp4", bytes: 4096, missing: false },
  { id: "i5", title: "大文件", type: "text", file: "items/大文件.txt", absPath: ROOT_DIR + "/items/大文件.txt", bytes: 40000, missing: false },
];
const ASSET = { id: "ast1", displayName: "测试素材", rel: "分类/测试素材", items: ITEMS };
const TXT = "第一行正文摘要\n第二行不应出现在行内摘要里\n";
const BIG = "字".repeat(40000);
const CALLS = { stat: [], readText: [], itemRead: [] };

function makeSandbox() {
  const window = {
    api: {
      toFileUrl: (p) => "file:///" + String(p).replace(/\\/g, "/"),
      fileStat: (p) => {
        CALLS.stat.push(p);
        const it = ITEMS.filter((x) => x.absPath === p)[0];
        return Promise.resolve({ ok: true, size: it ? it.bytes : 0 });
      },
      fileReadText: (p) => {
        CALLS.readText.push(p);
        if (/大文件/.test(p)) return Promise.resolve({ ok: true, content: BIG });
        return Promise.resolve({ ok: true, content: TXT });
      },
      assetsItemRead: (id, itemId) => {
        CALLS.itemRead.push(id + "/" + itemId);
        if (itemId === "i5") return Promise.resolve({ ok: true, text: BIG });
        return Promise.resolve({ ok: true, text: TXT });
      },
      shellOpenPath: () => Promise.resolve(true),
      shellShowItem: () => Promise.resolve(true),
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (t, fn) => (WIN_LISTENERS[t] = WIN_LISTENERS[t] || []).push(fn),
    removeEventListener: (t, fn) => {
      const arr = WIN_LISTENERS[t] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch: (t, ev) => {
      for (const fn of (WIN_LISTENERS[t] || []).slice()) fn(Object.assign({ type: t }, ev || {}));
    },
  };
  const document = {
    body: ROOT_EL,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => findEl(ROOT_EL, id),
    addEventListener: (t, fn) => (DOC_LISTENERS[t] = DOC_LISTENERS[t] || []).push(fn),
    removeEventListener: (t, fn) => {
      const arr = DOC_LISTENERS[t] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch: (t, ev) => {
      for (const fn of (DOC_LISTENERS[t] || []).slice()) fn(Object.assign({ type: t }, ev || {}));
    },
  };
  const sandbox = {
    window: window,
    document: document,
    IntersectionObserver: FakeIO,
    MutationObserver: FakeMO,
    requestAnimationFrame: fakeRaf,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    console: console,
    Math: Math,
    JSON: JSON,
    Map: Map,
    Set: Set,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    RegExp: RegExp,
    Error: Error,
    Promise: Promise,
    /* 与本测试无关的既有依赖：只给最小替身（口径与真源码一致） */
    I18n: { t: (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m)) },
    humanBytes: (n) => {
      const b = Number(n) || 0;
      if (b < 1024) return b + " B";
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
      return (b / 1024 / 1024).toFixed(1) + " MB";
    },
    fileName: (p) => String(p || "").replace(/\\/g, "/").split("/").pop(),
    assetItemTypeLabel: (t) => ({ text: "文本", image: "图像", audio: "音频", video: "视频" }[t] || "文本"),
    assetItems: (a) => {
      const seen = new Set();
      const out = [];
      for (const it of (a && a.items) || []) {
        if (!it || !it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        out.push({ id: String(it.id), title: String(it.title || ""), type: it.type === "image" || it.type === "audio" || it.type === "video" ? it.type : "text" });
      }
      return out;
    },
    assetBtn: (label, cls, title) => {
      const b = makeEl("button");
      b.className = "mini" + (cls ? " " + cls : "");
      b.textContent = label;
      if (title) b.title = title;
      return b;
    },
    ASSET_SET: { dragFrom: -1 },
    assetWireRowDrag: () => makeEl("span"),
    assetSetSetTitle: () => {},
    assetSetEditText: () => {},
    assetSetRemoveItem: () => {},
    assetItemReplaceFile: () => {},
    assetEditAssetId: (a) => (a && a.id) || "",
    assetPreviewItem: () => {},
    wavePreviewCreate: (id) => {
      const wrap = makeEl("div");
      wrap.className = "n-wave";
      if (id) wrap.id = id;
      const wb = makeEl("button");
      wb.className = "n-wave-btn";
      wb.click = () => {
        wb.classList.toggle("on");
        for (const mo of MO_LIST) if (mo.target === wb) mo.fire();
      };
      wrap.appendChild(wb);
      return wrap;
    },
    wavePreviewSetSource: (el, p) => {
      el.dataset.path = String(p);
    },
    wavePreviewStopAll: () => {
      CALLS.stopAll = (CALLS.stopAll || 0) + 1;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: "app-assets.slice.js" });
  /* 上面那段代码里用的是 I18n / window / document 等自由变量：把沙箱里的名字接回去 */
  return sandbox;
}
let SB = null;
try {
  SB = makeSandbox();
} catch (e) {
  console.log("  !! 切片执行失败：" + (e && e.message ? e.message : e));
  console.log(String((e && e.stack) || "").split("\n").slice(0, 6).join("\n"));
}

/* 摘要 / 全文是异步读回来的：整段断言包在 async 里，读到内容再断言 */
let SB_WIN = null;
async function main() {
  const SB_WIN = SB.window;
  /* 摘要 / 全文是 Promise 链异步读回来的：等几个真实的宏任务，读到内容再断言。
     注意：沙箱里用的是本测试的假 setTimeout，这里必须用宿主真实的那个，否则永远等不到。 */
  const tick = () => new Promise((r) => REAL_SET_TIMEOUT(r, 0));
  const settle = async (n) => {
    for (let i = 0; i < (n || 6); i++) await tick();
  };
  /* ═════════ [1] 行内小样按类型挂 ═════════ */
  const holderA = { name: "lib" };
  let rowText = null;
  let rowImg = null;
  let rowAudio = null;
  let rowVideo = null;
  try {
    rowText = SB.assetSetRow(SB.assetSetRows(ASSET)[0], 0, 5, { asset: ASSET, holder: holderA, repaint: () => {} });
    rowImg = SB.assetSetRow(SB.assetSetRows(ASSET)[1], 1, 5, { asset: ASSET, holder: holderA, repaint: () => {} });
    rowAudio = SB.assetSetRow(SB.assetSetRows(ASSET)[2], 2, 5, { asset: ASSET, holder: holderA, repaint: () => {} });
    rowVideo = SB.assetSetRow(SB.assetSetRows(ASSET)[3], 3, 5, { asset: ASSET, holder: holderA, repaint: () => {} });
    ROOT_EL.appendChild(rowText);
    ROOT_EL.appendChild(rowImg);
    ROOT_EL.appendChild(rowAudio);
    ROOT_EL.appendChild(rowVideo);
  } catch (e) {
    console.log("  !! 建行失败：" + (e && e.message ? e.message : e));
  }
  const cellOf = (row, cls) =>
    row ? (row.children || []).filter((c) => c.classList.contains(cls))[0] || null : null;
  const textOf = (cell) => {
    if (!cell) return "<null>";
    const sp = findEl(cell, "asset-pv-line");
    return (sp ? sp.textContent : cell.textContent) || "";
  };
  ok(!!cellOf(rowText, "asset-pv-text"), "[1] 文本条目行挂行内摘要单元格（.asset-pv-text）");
  ok(!!cellOf(rowImg, "asset-pv-thumb"), "[1] 图像条目行挂缩略图单元格（.asset-pv-thumb）");
  ok(!!cellOf(rowAudio, "asset-pv-audio"), "[1] 音频条目行挂小播放键单元格（.asset-pv-audio）");
  ok(!cellOf(rowVideo, "asset-pv-thumb") && !cellOf(rowVideo, "asset-pv-text") && !cellOf(rowVideo, "asset-pv-audio"),
    "[1] 视频条目行不挂行内小样（不在共识范围内，不乱挂）");
  ok(rowText.dataset.iid === "i1" && rowImg.dataset.iid === "i2",
    "[1] 行上记着条目 id（悬停时据此取同一条数据，不靠行号）");
  ok(cellOf(rowAudio, "asset-pv-audio").children[0].textContent === "▶",
    "[1] 音频播放键初始是 ▶");
  ok((cellOf(rowText, "asset-pv-text").listeners.mouseenter || []).length === 1
    && (cellOf(rowText, "asset-pv-text").listeners.mouseleave || []).length === 1,
    "[1] 行内小样上挂了「停一会儿出场 / 移开即收」两个监听");
  ok(!(rowText.listeners.mouseenter || []).length && !(rowText.listeners.mouseleave || []).length,
    "[1] 整行不再挂悬停浮层（停在名称输入框 / 类型 / 按钮上不弹，免得浮层压住编辑）");

  /* ═════════ [2] 行内小样：惰性取图 · 摘要只读开头 ═════════ */
  const imgCell = cellOf(rowImg, "asset-pv-thumb");
  const img = findEl(imgCell, "asset-pv-img");
  ok(!!img && !img.src, "[2] 图像缩略图先不取字节（悬停前 src 为空 = 惰性）");
  ok(OBS.targets.has(imgCell), "[2] 缩略图交给视口观察器（进视口才取）");
  OBS.cb([{ target: imgCell, isIntersecting: true }]);
  ok(img.src === "file:///" + ROOT_DIR + "/items/立绘.png", "[2] 进视口才换上 file:/// 地址");
  ok(!OBS.targets.has(imgCell), "[2] 取过之后不再被观察（同一个文件不重复解码）");

  flushFrames();
  advance(1);
  await settle();
  ok(CALLS.readText.indexOf(ROOT_DIR + "/items/人物设定.txt") >= 0,
    "[2] 文本摘要按需读一次该条目的实体文件");
  ok(textOf(cellOf(rowText, "asset-pv-text")).indexOf("第一行正文摘要") === 0,
    "[2] 行内摘要＝正文首行（得到 " + show(textOf(cellOf(rowText, "asset-pv-text"))) + "）");
  ok(textOf(cellOf(rowText, "asset-pv-text")).indexOf("第二行") > 0,
    "[2] 行内摘要单行化：换行 / 制表收成一个空格（不会撑出第二行）");
  const bigRow = SB.assetSetRow(SB.assetSetRows(ASSET)[4], 4, 5, { asset: ASSET, holder: holderA, repaint: () => {} });
  ROOT_EL.appendChild(bigRow); // 行要真的在列表里（与真 DOM 一样：不在树上就不贴内容）
  flushFrames();
  await settle();
  ok(textOf(findEl(bigRow, "asset-pv-text")).indexOf("39.1 KB") >= 0,
    "[2] >32KB 的文本不读内容，只给「大文件（体积）：悬停看全文」（得到 " + show(textOf(findEl(bigRow, "asset-pv-text"))) + "）");
  ok(CALLS.readText.indexOf(ROOT_DIR + "/items/大文件.txt") < 0,
    "[2] 大文件不进摘要读取（fileStat 先判体积）");

  /* ═════════ [3] 悬停浮层：出场 / 内容 / 收层 ═════════ */
  cellOf(rowText, "asset-pv-text").dispatch("mouseenter");
  ok(!findEl(ROOT_EL, "asset-pv-pop"), "[3] 刚悬停不出场（150ms 之前列表里没有浮层）");
  advance(150);
  const pop = findEl(ROOT_EL, "asset-pv-pop");
  ok(!!pop, "[3] 停留 150ms 后浮层出场");
  ok(!!pop && (findEl(pop, "asset-pv-title").textContent || "").indexOf("人物设定") >= 0,
    "[3] 浮层标题＝条目标题");
  flushFrames();
  await settle();
  const fullTa = pop ? findEl(pop, "asset-pv-text-full") : null;
  ok(!!fullTa && fullTa.value.indexOf("第二行") > 0, "[3] 浮层里给的是全文（只读展示）");
  ok(!!fullTa && fullTa.readOnly === true, "[3] 全文框只读（不写库）");
  const footTxt = pop ? findEl(pop, "asset-pv-foot").children.map((b) => b.textContent).join("|") : "";
  ok(footTxt.indexOf("打开原文件") >= 0 && footTxt.indexOf("在文件夹中显示") >= 0,
    "[3] 浮层脚上两键：打开原文件 / 在文件夹中显示（得到 " + show(footTxt) + "）");
  ok((DOC_LISTENERS.keydown || []).length === 1, "[3] 浮层出场时挂了一个 Esc 监听（只收这一层）");

  /* 鼠标进浮层内保持：行上先报移开、浮层随即进入（真 DOM 的顺序即如此） */
  pop._hover = true;
  cellOf(rowText, "asset-pv-text").dispatch("mouseleave");
  advance(200);
  ok(!!findEl(ROOT_EL, "asset-pv-pop"), "[3] 鼠标在浮层内 → 不因小样上的移开而收层");
  pop._hover = false;
  pop.dispatch("mouseleave");
  advance(200);
  ok(!findEl(ROOT_EL, "asset-pv-pop"), "[3] 鼠标离开浮层 → 自动收层（不用点关闭）");
  ok((DOC_LISTENERS.keydown || []).length === 0, "[3] 收层时把 Esc 监听一并摘掉");

  /* Esc 只收这一层 */
  cellOf(rowText, "asset-pv-text").dispatch("mouseenter");
  advance(150);
  ok(!!findEl(ROOT_EL, "asset-pv-pop"), "[3] 再次悬停能重新出场");
  let escStopped = false;
  DOC_LISTENERS.keydown.slice().forEach((fn) =>
    fn({ key: "Escape", preventDefault() {}, stopPropagation() { escStopped = true; } }),
  );
  ok(!findEl(ROOT_EL, "asset-pv-pop"), "[4] Esc 收掉浮层");
  ok(escStopped, "[4] Esc 被本层吃掉（capture + stopPropagation：不惊动底下的素材库 / 设置框）");

  /* ═════════ [4] 其余收层出口 ═════════ */
  cellOf(rowText, "asset-pv-text").dispatch("mouseenter");
  advance(150);
  ok(!!findEl(ROOT_EL, "asset-pv-pop"), "[4] 浮层再次出场");
  SB_WIN.dispatch("scroll");
  ok(!findEl(ROOT_EL, "asset-pv-pop"), "[4] 滚动让行离开原位即收层（不会飘在别处）");
  cellOf(rowImg, "asset-pv-thumb").dispatch("mouseenter");
  advance(150);
  ok(!!findEl(ROOT_EL, "asset-pv-pop"), "[4] 图像行也能出场");
  const bigImg = findEl(findEl(ROOT_EL, "asset-pv-pop"), "asset-pv-imgbig");
  ok(!!bigImg && bigImg.src === "file:///" + ROOT_DIR + "/items/立绘.png",
    "[4] 浮层里给的是放大图（同一个实体文件，只读）");
  SB.assetPvDropHost();
  ok(!findEl(ROOT_EL, "asset-pv-pop"), "[4] 重画 / 关框（assetPvDropHost）会把浮层一并收掉");

  /* ═════════ [5] 音频：行内播放键 → 浮层里同一只波形播放器 ═════════ */
  MO_LIST.length = 0;
  const audioCell = cellOf(rowAudio, "asset-pv-audio");
  const playBtn = audioCell.children[0];
  playBtn.dispatch("click");
  const pop2 = findEl(ROOT_EL, "asset-pv-pop");
  ok(!!pop2, "[5] 点行内播放键直接把浮层摆出来（不必先悬停）");
  const wave = pop2 ? findEl(pop2, "n-wave") || findEl(pop2, "asset-pv-wave") : null;
  ok(!!wave, "[5] 浮层里是那只 .n-wave 播放器（复用现有实现，不新写播放器）");
  ok(!!wave && wave.dataset.path === ROOT_DIR + "/items/主题曲.mp3",
    "[5] 播放器的声源就是这条音频的实体文件");
  ok(!!wave && findEl(wave, "n-wave-btn").classList.contains("on"),
    "[5] 点一下即起播（.n-wave-btn.on = 正在放）");
  flushFrames();
  advance(50);
  ok(playBtn.classList.contains("on") && playBtn.textContent === "⏸",
    "[5] 播放态回贴到行内小键（变成 ⏸）");
  SB.assetPvStopAudio();
  const beforeStop = CALLS.stopAll || 0;
  ok(beforeStop >= 1, "[5] 收层前先停掉这一只（不留看不见声源的声音）");
  advance(200);

  /* ═════════ [6] 缓存：同一份列表不重复读，换列表即清 ═════════ */
  const n1 = CALLS.stat.length;
  const againA = SB.assetSetRow(SB.assetSetRows(ASSET)[0], 0, 5, { asset: ASSET, holder: holderA, repaint: () => {} });
  ROOT_EL.appendChild(againA);
  flushFrames();
  await settle();
  ok(CALLS.stat.length === n1, "[6] 同一份列表重画：摘要不重复读（走缓存）");
  ok(textOf(cellOf(againA, "asset-pv-text")).indexOf("第一行正文摘要") === 0,
    "[6] 重画后的行立刻拿得到缓存里的摘要（不闪空）");
  const holderB = { name: "set" };
  const rowB = SB.assetSetRow(SB.assetSetRows(ASSET)[0], 0, 5, { asset: ASSET, holder: holderB, repaint: () => {} });
  ROOT_EL.appendChild(rowB);
  flushFrames();
  await settle();
  ok(CALLS.stat.length > n1, "[6] 换列表（另一个 holder）即清缓存并重读（缓存不跨列表长挂）");

  /* ═════════ [8] 重画回归：看过一次的小样，重画后照样在 ═════════
     真实现场：素材库点开一个素材看到缩略图 → 点另一个素材 → 再点回来（行全部重建），
     缩略图就一片空白（「预览看过一次后再返回就失效了」）。根因是把「这个文件取过没有」
     当成设 src 的闸：重建出来的新 <img> 从来没拿到过 src。同一份列表里的重画（切素材
     回来 / 排序 / 改名 / 拖拽复位）都走这条道，所以这一条必须钉住。 */
  const imgRow1 = SB.assetSetRow(SB.assetSetRows(ASSET)[1], 1, 5, { asset: ASSET, holder: holderB, repaint: () => {} });
  ROOT_EL.appendChild(imgRow1);
  flushFrames();
  const cell1 = cellOf(imgRow1, "asset-pv-thumb");
  OBS.cb([{ target: cell1, isIntersecting: true }]);
  ok(!!findEl(cell1, "asset-pv-img") && findEl(cell1, "asset-pv-img").src === "file:///" + ROOT_DIR + "/items/立绘.png",
    "[8] 第一次画出的图像行拿到缩略图");
  const imgRow2 = SB.assetSetRow(SB.assetSetRows(ASSET)[1], 1, 5, { asset: ASSET, holder: holderB, repaint: () => {} });
  ROOT_EL.appendChild(imgRow2);
  flushFrames();
  const cell2 = cellOf(imgRow2, "asset-pv-thumb");
  OBS.cb([{ target: cell2, isIntersecting: true }]);
  ok(!!findEl(cell2, "asset-pv-img") && findEl(cell2, "asset-pv-img").src === "file:///" + ROOT_DIR + "/items/立绘.png",
    "[8] 同一份列表重画后，新行的缩略图照样拿到 src（「看过一次再回来就没了」已修）");
  /* 正文改写（编辑文本 / 上传覆盖）是就地写回同一个 .txt：摘要缓存必须当场作废，
     否则重画回列表贴的还是改写前那一句 */
  SB.assetPvForgetHead(ROOT_DIR + "/items/人物设定.txt");
  const n3 = CALLS.stat.length;
  const txtRow2 = SB.assetSetRow(SB.assetSetRows(ASSET)[0], 0, 5, { asset: ASSET, holder: holderB, repaint: () => {} });
  ROOT_EL.appendChild(txtRow2);
  flushFrames();
  await settle();
  ok(CALLS.stat.length > n3, "[8] 正文改写后摘要缓存作废（重画回列表重新读，不贴改写前那一句）");
  SB.assetPvDropHost();

  /* ═════════ [7] 静态接线与词条 ═════════ */
  ok(SRC.indexOf("assetPvTextCell(ctx.holder || ASSET_SET, r)") > 0 &&
    SRC.indexOf("assetPvThumb(ctx.holder || ASSET_SET, r)") > 0 &&
    SRC.indexOf("assetPvAudioCell(ctx.holder || ASSET_SET, r)") > 0,
    "[7] 三种类型的行内小样都接进了 assetSetRow（素材库右栏与素材设置框同一份渲染）");
  ok(/function paintAssetDetail[\s\S]{0,200}assetPvDropHost\(\)/.test(SRC) &&
    /function paintAssetSetBody[\s\S]{0,200}assetPvDropHost\(\)/.test(SRC) &&
    /function closeAssetLib[\s\S]{0,200}assetPvDropHost\(\)/.test(SRC) &&
    /function closeAssetSettings[\s\S]{0,200}assetPvDropHost\(\)/.test(SRC),
    "[7] 四处重画 / 关框路径都先收浮层（不留孤儿浮层与孤儿声源）");
  const css = read("renderer/css/components.css");
  ok(css.indexOf(".asset-pv-thumb") > 0 && css.indexOf(".asset-pv-text {") > 0 &&
    css.indexOf(".asset-pv-play") > 0 && css.indexOf(".asset-pv-pop {") > 0,
    "[7] CSS 齐备：行内缩略图 / 摘要 / 播放键 + 悬停浮层");
  ok(/\.asset-pv-pop \{[\s\S]{0,200}z-index: 2380/.test(css),
    "[7] 浮层层级 2380：压在素材库框（2350）与设置框（2370）之上、条目只读预览框（2400）之下");
  const i18n = read("renderer/i18n.js");
  const need = [
    "内容预览",
    "大文件（{size}）：悬停看全文",
    "文件缺失",
    "正文过长，这里只显示前 20 万字符",
    "音频预览器不可用",
    "这一类内容没有内嵌预览：用「打开原文件」看",
    "打开原文件",
    "用本机默认程序打开这条内容的实体文件",
    "在资源管理器中定位这条内容的实体文件",
    "展开波形试听这条音频（鼠标停在这个播放键上即出现浮层）",
  ];
  const missing = need.filter((k) => {
    const m = i18n.match(new RegExp('"' + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '":\\s*"'));
    if (!m) return true;
    const at = m.index + m[0].length;
    const end = i18n.indexOf('"', at);
    return !(end > at); // 有中文键但英文串为空也算缺
  });
  ok(!missing.length, "[7] i18n 中英词条齐备（缺：" + show(missing) + "）");
  ok(SRC.indexOf("assetBtn(\n      I18n.t(\"预览\")") > 0 || SRC.indexOf('I18n.t("预览"),') > 0,
    "[7] 行尾「预览」按钮保留（大图 / 全文的既有入口不动）");
  ok(SRC.indexOf("window.api.shellShowItem(r.absPath)") > 0,
    "[7] 文件名按钮仍是「在资源管理器中定位原文件」（未被预览顶替）");
  ok(SRC.indexOf("assetShowPreviewBox") > 0 && /function assetShowPreviewBox\(/.test(SRC),
    "[7] 条目只读预览框仍在（本轮只加不改）");
  ok(SRC.indexOf("assetsSaveMeta") > 0 && CODE.indexOf("assetsSaveMeta") < 0,
    "[7] 预览链路里没有任何写库调用（assetsSaveMeta 只出现在行内编辑动作中）");
  ok(SRC.indexOf("_assetPvRevealed") < 0,
    "[8] 缩略图不再拿「这个文件取过没有」当闸（重画必须能重新填 src）");
  ok(/assetItemViewInvalidate\(aid, itemId\);[\s\S]{0,300}assetPvForgetHead\(/.test(SRC),
    "[8] 写库收口（assetWriteItem）里作废行内摘要缓存 —— 正文改写后摘要不陈旧");

  console.log("");
  console.log(fails ? "FAILED  " + fails + " / " + checks : "PASS  " + checks + " 项");
  process.exit(fails ? 1 : 0);

}
main();

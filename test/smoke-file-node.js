"use strict";
/* test/smoke-file-node.js — 泛用「文件节点」+ 文本导入两道警告 回归
 * ============================================================================
 * 运行：node test/smoke-file-node.js
 *
 * 钉住的需求：
 *   [1] 文本节点导入本机文件：什么类型都能选，但 ① 体积 > 1 MB ② 读出来解析不成文本
 *       （二进制 / 编码不对）都要先警告用户；用户在闸里取消 = 正文一个字都不写，
 *       坚持「仍要导入」= 照样写进去。
 *   [2] 右键菜单：输入节点那一组只剩一颗「文件节点」（input_any），文本 / 图像 / 音频 /
 *       视频四种不再各占一条 —— 但四类 kind 本体一律保留（兼容老画布）。
 *   [3] 文件节点上传任意文件 → 就地转成对应输入节点，并把内容装进去；同 id、原位置、
 *       一步撤销；没上传前可以右键手动指定类型；转换后没有任何「退回文件节点」的入口。
 *       解析不出来的文件（压缩包 / Office / 无扩展名二进制…）**不转成文字**：只在节点上
 *       保留那条本机路径（node.anyFile），下游接线 / @引用 拿到的就是这段路径。
 *   [4] 泛用形态没有端子（没有内容就不该被连线 / 被当成数据源）；
 *       只保留路径的形态留 1 个输出端子（值 = 那段路径）。
 *   [5] 接线与文案：body 只有一颗上传按钮 · 帮助说明 · 中英指南 · i18n 英文词条齐。
 *   [6] 载入图像**按原尺寸落盘**：文件节点上传图片走 copyImageFromPath({ native:true })
 *       → 主进程 asset:copy 原样复制（不缩到 1080、不重编码）；参考图那条路仍走 1080 上限。
 *
 * 真跑的函数（从 renderer/app.js 按名字抠源码进 vm，不改源文件）：
 *   readTextForNodeImport / applyTextFileToNode / importFileToText /
 *   textImportLooksBinary / classifyDropFile / convertAnyNodeTo / uploadIntoAnyNode /
 *   convertAnyNodeKind / anyNodeTitleAfterUpload / inputCount / outputCount
 * 只读断言：不改任何文件。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
/* 换行归一：多行断言用 \n 拼针，检出目录若是 CRLF（Windows autocrlf）也要钉得住 */
const read = (rel) =>
  fs
    .readFileSync(path.join(ROOT, ...rel.split("/")), "utf8")
    .replace(/\r\n/g, "\n");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqStr = (a, b, msg) =>
  ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
const eqArr = (a, b, msg) =>
  ok(JSON.stringify(a) === JSON.stringify(b), msg + "（得到 " + JSON.stringify(a) + "）");
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
};
/* i18n 取词：对象键有时带引号、中文裸标识量不带，两种写法都认 */
const hasI18nKey = (key, msg) => {
  const c = new RegExp(
    '"?' + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"?\\s*:',
  ).test(I18N);
  ok(c, msg + (c ? "" : "（i18n 没有词条：" + key + "）"));
};

const APP = read("renderer/app.js");
const CANVAS = read("renderer/app-canvas.js");
const HELP = read("renderer/app-nodehelp.js");
const I18N = read("renderer/i18n.js");
const CSS = read("renderer/css/canvas.css");
const GUIDES = read("guides/nodes/index.json");
const MAIN = read("main.js");
const PRELOAD = read("preload.js");

/* ---------- 从源码里按名字抠出顶层函数 / 常量（与 smoke-media-gen-menu 同一口径） ---------- */
function slice(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到源码：" + name);
  const head = src.slice(at, at + 16);
  if (/^(async\s+)?function/.test(head)) {
    const i = src.indexOf("{", at);
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
        j = src.indexOf("\n", j);
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j + 2) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数体不闭合：" + name);
  }
  /* 常量：对象 / 数组字面量按配对扫到结尾；标量取到第一个分号 */
  const eq = src.indexOf("=", at);
  const lit = src.slice(eq + 1, eq + 30).search(/[{[]/);
  const litCh = src.slice(eq + 1).trim()[0];
  if (lit >= 0 && (litCh === "{" || litCh === "[")) {
    const open = eq + 1 + src.slice(eq + 1).search(/[{[]/);
    const close = litCh === "{" ? "\n};" : "\n];";
    const e = src.indexOf(close, open);
    if (e < 0) throw new Error("常量结尾找不到：" + name);
    return src.slice(at, e + close.length);
  }
  const semi = src.indexOf(";", eq + 1);
  if (semi < 0) throw new Error("常量结尾找不到：" + name);
  return src.slice(at, semi + 1);
}

/* ---------- 沙箱：真实逻辑 + 最小替身 ---------- */
const MB = 1024 * 1024;
let dlg = { calls: [], answer: true }; /* confirmDialog 替身：记录问了几次 */
let toasts = [];
let api = { size: 10, content: "hello" }; /* fileStat / fileReadText 替身 */
let copied = { path: "E:/wf/assets/pic.png", sourceName: "pic" };
const imageCopies = []; /* copyImageFromPath 替身：记录每次调用实参（钉 native 口径） */
const pdfCalls = [];

const sandbox = {
  console,
  Math,
  JSON,
  Blob: class {
    constructor(a) {
      this.size = String(a && a[0] ? a[0] : "").length;
    }
  },
  Promise,
  RegExp,
  Set,
  I18n: { t: (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : "")) },
  toast: (m, k) => toasts.push({ msg: String(m), kind: k || "" }),
  confirmDialog: async (message, opts) => {
    dlg.calls.push({ message: String(message), title: (opts && opts.title) || "" });
    return dlg.answer;
  },
  pushHistory: () => {},
  clearDownstream: () => {},
  scheduleSave: () => {},
  renderCanvas: () => {},
  renderStatus: () => {},
  fileName: (p) => String(p).split(/[\\/]/).pop(),
  imageStem: (p) => String(p).split(/[\\/]/).pop().replace(/\.[^.]+$/, ""),
  humanBytes: (n) => Math.round(Number(n) || 0) + " B",
  uniqueNodeTitle: (t) => String(t),
  copyImageFromPath: async function () {
    imageCopies.push(Array.prototype.slice.call(arguments));
    return copied;
  },
  pdfIsPdfPath: (p) => /\.pdf$/i.test(String(p || "")),
  openPdfParse: async (p, o) => {
    pdfCalls.push(p);
    o.node.text = "# PDF 正文";
    return true;
  },
  /* 端子判定要用的邻居替身（本用例只关心 input_any / 输入族的短路分支） */
  isSaveNode: () => false,
  isExecEnd: () => false,
  isExecStart: () => false,
  isToolNode: () => false,
  isFnToolNode: () => false,
  isVideoPostKind: () => false,
  assetItems: () => [],
  allWiresTo: () => [],
  wiresTo: () => [],
  nodeById: () => null,
  /* makeNode：与真身同构（NODE_DEFAULTS 出默认字段 · w/h 单列） */
  makeNode: (kind, x, y) => {
    const d = sandbox.NODE_DEFAULTS[kind];
    if (!d) return null;
    const n = { id: "n_any", kind, x, y, w: d.w, h: d.h };
    for (const [k, v] of Object.entries(d)) {
      if (k === "w" || k === "h") continue;
      n[k] = JSON.parse(JSON.stringify(v));
    }
    return n;
  },
  NODE_DEFAULTS: {
    input_any: { w: 240, h: 130, title: "文件", anyFile: "" },
    input_text: { w: 240, h: 130, title: "文本", text: "", batch: false, entries: [] },
    input_image: { w: 220, h: 170, title: "图像", imageAsset: "", sourceName: "", batch: false, entries: [] },
    input_audio: { w: 300, h: 220, title: "音频", mediaAsset: "", sourceName: "" },
    input_video: { w: 300, h: 220, title: "视频", mediaAsset: "", sourceName: "" },
  },
  S: { wf: { nodes: [] } },
  window: {
    api: {
      fileStat: async (p) => ({ ok: true, size: api.size }),
      fileReadText: async (p) => ({ ok: true, exists: true, content: api.content }),
      fileOpenDialog: async () => ({ path: api.pickPath || "" }),
    },
  },
};
vm.createContext(sandbox);
for (const name of [
  "TEXT_IMPORT_WARN_BYTES",
  "IMAGE_FILE_EXTS",
  "AUDIO_FILE_EXTS",
  "VIDEO_FILE_EXTS",
  "TEXT_FILE_EXTS",
  "fileExtNoDot",
  "mediaKindOfPath",
  "classifyDropFile",
  "dropNodeTitle",
  "setNodeMedia",
  "textImportLooksBinary",
  "readTextForNodeImport",
  "applyTextFileToNode",
  "importFileToText",
  "INPUT_ANY_TARGETS",
  "inputAnyTargetByType",
  "inputAnyTargetByKind",
  "convertAnyNodeTo",
  "anyNodeTitleAfterUpload",
  "setInputAnyFilePath",
  "uploadIntoAnyNode",
  "convertAnyNodeKind",
  "outputCount",
  "inputCount",
]) {
  vm.runInContext(slice(APP, name), sandbox, { filename: "extract:" + name });
}
const G = (name) => vm.runInContext(name, sandbox);

/* ---------- 小工具：往沙箱里放一颗泛用文件节点 ---------- */
function freshAnyNode(title) {
  const n = G("makeNode")("input_any", 120, 80);
  n.id = "n_any";
  n.title = title || "文件节点";
  sandbox.S.wf.nodes = [n];
  return n;
}
const reset = () => {
  dlg = { calls: [], answer: true };
  toasts = [];
  pdfCalls.length = 0;
  imageCopies.length = 0;
};

(async function main() {
  /* ============ [1] 文本节点导入：两道警告闸 ============ */
  console.log("\n[1] 文本节点导入本机文件：>1MB 与解析不出来都要警告");
  {
    /* ① 小文件 + 正常文本：一声不响地导入（老行为零回退） */
    reset();
    api = { size: 2048, content: "普通正文" };
    const node = { id: "n1", kind: "input_text", text: "" };
    await G("applyTextFileToNode")(node, "E:/docs/a.md");
    eqStr(node.text, "普通正文", "小文件正常文本直接导入");
    eqNum(dlg.calls.length, 0, "正常导入不打扰用户（不弹任何警告）");

    /* ② 体积 > 1 MB：警告 + 用户取消 → 正文一个字都不写 */
    reset();
    api = { size: 3 * MB, content: "很长的正文" };
    dlg.answer = false;
    const n2 = { id: "n2", kind: "input_text", text: "原来的正文" };
    const r2 = await G("applyTextFileToNode")(n2, "E:/docs/big.txt");
    eqNum(dlg.calls.length, 1, "超过 1 MB 弹一次警告");
    has(dlg.calls[0].title, "文件大于", "警告标题写明是体积问题");
    has(dlg.calls[0].message, "3145728 B", "警告里给出实际体积（让用户知道超了多少）");
    eqStr(r2, false, "用户取消 = 没有导入");
    eqStr(n2.text, "原来的正文", "取消后节点正文原样不动");

    /* ③ 体积 > 1 MB：用户坚持「仍要导入」→ 照样写进去 */
    reset();
    api = { size: 3 * MB, content: "很长的正文" };
    dlg.answer = true;
    const n3 = { id: "n3", kind: "input_text", text: "" };
    await G("applyTextFileToNode")(n3, "E:/docs/big.txt");
    eqStr(n3.text, "很长的正文", "点「仍要导入」后正文照样写入（警告不硬拦）");

    /* ④ 解析不出来（二进制噪声）：警告 + 取消 → 不写 */
    reset();
    api = { size: 4096, content: "\u0000\u0000PK\u0003\u0004" + "\u0001\u0002\u0003\u0004".repeat(6) };
    dlg.answer = false;
    const n4 = { id: "n4", kind: "input_text", text: "旧" };
    await G("applyTextFileToNode")(n4, "E:/docs/pkg.zip");
    eqNum(dlg.calls.length, 1, "解析不成文本时弹一次警告");
    has(dlg.calls[0].title, "无法解析", "警告标题写明是解析问题");
    has(dlg.calls[0].message, "pkg.zip", "警告里点名是哪个文件");
    eqStr(n4.text, "旧", "取消后不把乱码写进正文");

    /* ⑤ 编码不对（utf-8 解码失败留下成片替换符）也算解析不出来 */
    ok(
      G("textImportLooksBinary")("\ufffd".repeat(20) + "abc"),
      "成片替换符（编码不是 UTF-8）判定为解析不出来",
    );
    ok(!G("textImportLooksBinary")("# 标题\n中文 + emoji 🙂\n"), "正常 Markdown / 中文不误判");
    ok(!G("textImportLooksBinary")("col1,col2\n1,2\n"), "CSV 不误判");
    ok(!G("textImportLooksBinary")(""), "空正文不算二进制（有别的提示）");

    /* ⑥ PDF 例外：走解析编排，不经这两道闸（它的正文是解析出来的 Markdown） */
    reset();
    api = { size: 9 * MB, content: "%PDF-1.7\u0000\u0001\u0002" };
    const n6 = { id: "n6", kind: "input_text", text: "" };
    await G("applyTextFileToNode")(n6, "E:/docs/deck.pdf");
    eqNum(dlg.calls.length, 0, "PDF 不弹体积警告（交给解析编排）");
    eqArr(pdfCalls, ["E:/docs/deck.pdf"], "PDF 交给 openPdfParse 解析");
    eqStr(n6.text, "# PDF 正文", "PDF 解析结果落进正文");

    /* ⑦ 读不到文件 = 直接报错，不弹窗、不写正文 */
    reset();
    sandbox.window.api.fileReadText = async () => ({ ok: true, exists: false, content: "" });
    const n7 = { id: "n7", kind: "input_text", text: "旧" };
    eqStr(await G("applyTextFileToNode")(n7, "E:/gone.txt"), false, "读不到 = 不导入");
    has(toasts[0].msg, "无法读取", "读不到文件给一句错误提示");
    eqStr(n7.text, "旧", "读不到时正文不动");
    sandbox.window.api.fileReadText = async (p) => ({ ok: true, exists: true, content: api.content });

    /* ⑧ 节点头部 📄「文件参考」那条路（不带 pathOverride → 自己开文件框）同样过闸 */
    reset();
    api = { pickPath: "E:/docs/picked.bin", size: 2 * MB, content: "\u0000\u0001\u0002".repeat(20) };
    dlg.answer = false;
    const n8 = { id: "n8", kind: "input_text", text: "保持不动" };
    await G("importFileToText")(n8);
    eqStr(dlg.calls[0].title, "文件大于 1 MB", "📄 自己开文件框也先过体积闸");
    eqStr(n8.text, "保持不动", "体积闸里取消 = 什么都不写");
    /* 两道警告都点「仍要导入」→ 照样写（用户说了算，不硬拦） */
    reset();
    dlg.answer = true;
    await G("importFileToText")(n8);
    eqNum(dlg.calls.length, 2, "体积 + 可解析性两道警告各问一次");
    eqStr(dlg.calls[1].title, "无法解析该文件", "第二次问的是解析不出来");
    ok(n8.text.length > 0, "坚持导入时乱码也照写（不替用户做主）");
  }

  /* ============ [2] 右键菜单：四条输入项收成一条「文件节点」 ============ */
  console.log("\n[2] 画布右键：输入节点收成一颗「文件节点」（四类本体保留）");
  {
    const at = APP.indexOf("function canvasCreateMenuGroups(pt) {");
    ok(at > 0, "canvasCreateMenuGroups 存在");
    const seg = APP.slice(at, APP.indexOf("\n}\n", at));
    eqNum(
      seg.split('addNode("input_any"').length - 1,
      1,
      "「文件节点」在右键菜单里只出现一次（建的就是 input_any）",
    );
    for (const k of ["input_text", "input_image", "input_audio", "input_video"])
      hasnt(seg, 'ctxKindItem("' + k, k + " 不再作为右键菜单项（改由文件节点转换）");
    has(seg, "I18n.t(\"文件节点（上传任意文件 · 自动转为对应节点）\")", "菜单文案写明「上传任意文件 · 自动转为对应节点」");
    /* 兼容性：四类 kind 一个都没从应用里消失 */
    const ndAt = APP.indexOf("const NODE_DEFAULTS = {");
    const nd = APP.slice(ndAt, APP.indexOf("\n};", ndAt));
    for (const k of ["input_any", "input_text", "input_image", "input_audio", "input_video", "input_file"])
      has(nd, k + ": {", "NODE_DEFAULTS 里有 " + k + "（老画布与新建都还要用）");
    has(nd, 'title: "文件"', "input_any 默认标题是「文件」→ 建出来叫「文件节点」");
    /* 拖文件进画布空白处仍按类型直建四类节点（右键菜单收成一条不等于砍掉这条路径） */
    has(APP, 'makeNode("input_text", x, y)', "拖入文本文件仍直建文本节点");
    has(APP, 'makeNode("input_image", x, y)', "拖入图像仍直建图像节点");
    has(APP, 'it.kind === "video" ? "input_video" : "input_audio"', "拖入音视频仍直建对应节点");
    /* 数据库那套「文件节点」（kind input_file）不受影响 */
    has(APP, 'ctxKindItem("input_file"', "数据库壳内的文件节点入口保留");
  }

  /* ============ [3] 上传 → 就地转成对应输入节点 ============ */
  console.log("\n[3] 文件节点：上传什么类型就变成哪种节点");
  {
    eqArr(
      G("INPUT_ANY_TARGETS").map((t) => t.kind),
      ["input_text", "input_image", "input_audio", "input_video"],
      "四个目标节点就是原来的四种输入节点（没有新造一套）",
    );
    /* 分类走的是既有真源：与拖文件进画布同一套判定 */
    eqStr(G("classifyDropFile")("E:/a/b.png"), "image", ".png → 图像");
    eqStr(G("classifyDropFile")("E:/a/b.md"), "text", ".md → 文本");
    eqStr(G("classifyDropFile")("E:/a/b.mp3"), "audio", ".mp3 → 音频");
    eqStr(G("classifyDropFile")("E:/a/b.mp4"), "video", ".mp4 → 视频");

    /* 文件框默认类型 = 全部文件（*.*）：第一档就是它，排在文本 / 图像…之前 */
    {
      const upAt = APP.indexOf("async function uploadIntoAnyNode(node, pathOverride) {");
      ok(upAt > 0, "uploadIntoAnyNode 在源码里");
      const upSeg = APP.slice(upAt, upAt + 1600);
      const allAt = upSeg.indexOf('{ name: I18n.t("全部文件"), extensions: ["*"] }');
      const txtAt = upSeg.indexOf('{ name: I18n.t("文本"), extensions: TEXT_FILE_EXTS }');
      ok(allAt > 0, "文件框有一档「全部文件 (*.*)」");
      ok(txtAt > 0, "后面才是「文本」等分类档");
      ok(allAt > 0 && txtAt > 0 && allAt < txtAt, "「全部文件」排第一 = 默认类型是所有类型");
    }

    /* ① 图像：复制进资产 + 转成图像节点 */
    reset();
    api = { pickPath: "E:/pics/hero.png" };
    copied = { path: "E:/wf/assets/hero.png", sourceName: "hero" };
    let n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    n = sandbox.S.wf.nodes[0];
    eqStr(n.kind, "input_image", "上传 .png → 图像节点");
    eqStr(n.imageAsset, "E:/wf/assets/hero.png", "图像走资产复制那条路（与图像节点一致）");
    eqStr(n.sourceName, "hero", "记住源文件主名");
    eqStr(n.id, "n_any", "同一个 id（撤销 / 选中 / @引用都不受影响）");
    eqStr(n.x, 120, "位置不变");
    eqStr(n.title, "hero", "标题跟着文件走（与拖文件进画布同一口径）");
    has(toasts[toasts.length - 1].msg, "已转为", "转换后明确告诉用户转成了什么");
    /* 载入图像按**原尺寸**落盘：copyImageFromPath 第三参带 native:true */
    eqNum(imageCopies.length, 1, "上传图像走了一次 copyImageFromPath");
    eqStr(imageCopies[0][0], "E:/pics/hero.png", "复制的是用户选的那个文件");
    eqStr(imageCopies[0][1], "hero", "nameHint 仍是源文件主名（标题口径不动）");
    eqStr(
      JSON.stringify(imageCopies[0][2]),
      JSON.stringify({ native: true }),
      "第三参 native:true = 原样落盘（保留原图像素尺寸）",
    );

    /* ② 文本：读正文（含两道警告闸） */
    reset();
    api = { pickPath: "E:/docs/notes.txt", size: 2048, content: "第一条笔记" };
    n = freshAnyNode("我的输入");
    await G("uploadIntoAnyNode")(n);
    n = sandbox.S.wf.nodes[0];
    eqStr(n.kind, "input_text", "上传 .txt → 文本节点");
    eqStr(n.text, "第一条笔记", "正文装进节点");
    eqStr(n.title, "我的输入", "用户自己改过的标题不被文件 names 冲掉");

    /* ③ 音频 / 视频：只引用本机绝对路径，不复制进资产 */
    reset();
    api = { pickPath: "E:/media/voice.wav", size: 9 * MB };
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    eqStr(sandbox.S.wf.nodes[0].kind, "input_audio", "上传 .wav → 音频节点");
    eqStr(sandbox.S.wf.nodes[0].mediaAsset, "E:/media/voice.wav", "音视频引用原路径（不复制）");
    reset();
    api = { pickPath: "E:/media/clip.mp4", size: 20 * MB };
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    eqStr(sandbox.S.wf.nodes[0].kind, "input_video", "上传 .mp4 → 视频节点");
    eqNum(dlg.calls.length, 0, "音视频大文件不吃文本那道体积闸");

    /* ④ PDF：转成文本节点后交给解析编排 */
    reset();
    api = { pickPath: "E:/docs/deck.pdf", size: 9 * MB };
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    eqStr(sandbox.S.wf.nodes[0].kind, "input_text", "上传 PDF → 文本节点");
    eqArr(pdfCalls, ["E:/docs/deck.pdf"], "PDF 正文由解析编排产出");

    /* ⑤ 认不出类型 + 二进制（zip）：不转成文字、也不弹「仍要导入」—— 只保留路径 */
    reset();
    api = { pickPath: "E:/tmp/pkg.zip", size: 4096, content: "\u0000\u0000PK\u0003\u0004" + "\u0001\u0002\u0003".repeat(8) };
    dlg.answer = false;
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    n = sandbox.S.wf.nodes[0];
    eqStr(n.kind, "input_any", "解析不出来 → 仍是文件节点（不转成文本节点）");
    eqStr(n.anyFile, "E:/tmp/pkg.zip", "只保留那条本机文件路径");
    eqNum(dlg.calls.length, 0, "不弹「仍要导入」（这段流程不会把二进制当文本收下）");
    has(toasts[toasts.length - 1].msg, "只保留文件路径", "给一句「只保留文件路径」");
    eqStr(n.title, "pkg", "标题跟着文件走（与拖文件进画布同一口径）");

    /* ⑤b 认不出类型 + 大文件（>1 MB）：整份不读、不弹体积闸，直接只保留路径 */
    reset();
    api = { pickPath: "E:/tmp/disk.bin", size: 40 * MB, content: "x".repeat(10) };
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    n = sandbox.S.wf.nodes[0];
    eqStr(n.anyFile, "E:/tmp/disk.bin", "认不出类型的大文件也只保留路径");
    eqNum(dlg.calls.length, 0, "不再为它弹「仍要整个导入吗」");

    /* ⑤c 文本后缀但内容其实是二进制（后缀骗人）：同样只保留路径，不装乱码 */
    reset();
    api = { pickPath: "E:/tmp/notes.txt", size: 8192, content: "\u0000\u0001\u0002".repeat(20) };
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    n = sandbox.S.wf.nodes[0];
    eqStr(n.kind, "input_any", "后缀是 .txt 但解析不出来 → 也是文件节点");
    eqStr(n.anyFile, "E:/tmp/notes.txt", "保留路径而不是把乱码写进正文");

    /* ⑥ 无扩展名但确实是文本 → 按文本节点收下（这条老行为保留） */
    reset();
    api = { pickPath: "E:/repo/LICENSE", size: 1024, content: "MIT License ..." };
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    eqStr(sandbox.S.wf.nodes[0].kind, "input_text", "无扩展名的纯文本按文本节点收下");
    eqStr(sandbox.S.wf.nodes[0].text, "MIT License ...", "正文照样装进去");

    /* ⑦ 取消 = 什么都没发生（不留下一颗已转好却是空的节点） */
    reset();
    api = { pickPath: "E:/docs/big.txt", size: 3 * MB, content: "x", content2: null };
    dlg.answer = false;
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    eqStr(sandbox.S.wf.nodes[0].kind, "input_any", "体积警告里点取消 → 不转换、不留空节点");
    eqStr(sandbox.S.wf.nodes[0].anyFile, "", "取消时也不留下路径");
    /* ⑧ 文本后缀 + 大文件 + 点「仍要导入」→ 照旧装进正文（文本节点那条口径不动） */
    reset();
    api = { pickPath: "E:/docs/big.txt", size: 3 * MB, content: "很长的正文" };
    dlg.answer = true;
    n = freshAnyNode();
    await G("uploadIntoAnyNode")(n);
    eqStr(sandbox.S.wf.nodes[0].kind, "input_text", "大文本文件仍可转成文本节点");
    eqStr(sandbox.S.wf.nodes[0].text, "很长的正文", "正文照旧写入");
  }

  /* ============ [4] 未上传前手动转换 · 且不给退回入口 ============ */
  console.log("\n[4] 手动转换（未上传前）与「不许退回」");
  {
    reset();
    let n = freshAnyNode();
    G("convertAnyNodeKind")(n, "input_image");
    n = sandbox.S.wf.nodes[0];
    eqStr(n.kind, "input_image", "右键「转换为」→ 图像节点");
    eqStr(n.id, "n_any", "手动转换同样保持 id（一步 Ctrl+Z 可撤销）");
    eqStr(n.imageAsset, "", "没上传就是空的，等用户自己选文件");
    /* 已经是具体输入节点后，手动转换入口一律不生效（这就是「不允许回退」的兜底） */
    G("convertAnyNodeKind")(n, "input_any");
    eqStr(sandbox.S.wf.nodes[0].kind, "input_image", "转完之后再也转不回文件节点");
    hasnt(APP, 'convertAnyNodeTo(node, "input_any"', "源码里没有退回泛用文件节点的调用");
    eqNum(
      APP.split('addNode("input_any"').length - 1,
      1,
      "全应用只有一处会新建文件节点（就是右键那一条）",
    );
    /* 右键菜单里也没有「转回文件节点」的项：本节点的二级菜单只列四种输入节点。
       锚点用菜单块的注释原文 —— 头部那排「手动更改类型」按钮也是 input_any 分支，
       只按条件行取切片会切到头部去（同一条件在文件里出现两次）。 */
    const anyAt = CANVAS.indexOf(
      "泛用文件节点：还没上传文件之前，允许手动指定要变成哪一种输入节点",
    );
    const assetAt = CANVAS.indexOf('if (node.kind === "asset") {', anyAt);
    ok(anyAt > 0 && assetAt > anyAt, "文件节点的右键菜单块在 asset 块之前（切片取得到）");
    const anyCtx = CANVAS.slice(anyAt, assetAt);
    has(anyCtx, "转换为输入节点", "文件节点右键有「转换为输入节点」");
    hasnt(CANVAS, 'convertAnyNodeKind(node, "input_any")', "右键「转换为」里没有转回文件节点的那一条");
    eqNum(
      anyCtx.split("ctxKindItem(").length - 1,
      1,
      "二级成员由 INPUT_ANY_TARGETS 映射而来（一处建项 · 四条目标）",
    );
    has(anyCtx, "INPUT_ANY_TARGETS", "「转换为」二级成员就是那四种输入节点那张表");
  }

  /* ============ [4b] 菜单栏（上方小按钮）四类手动转换 ============ */
  console.log("\n[4b] 文件节点菜单栏：四类手动更改类型小按钮");
  {
    /* 头部那排小按钮：一串 .n-any-conv-btn，成员来自 INPUT_ANY_TARGETS，
       点一下就地调用 convertAnyNodeKind（与右键子菜单同一逻辑真源）。 */
    const barAt = CANVAS.indexOf("function inputAnyConvertBar(node) {");
    ok(barAt > 0, "app-canvas.js 有 inputAnyConvertBar（菜单栏四连按钮）");
    const bar = CANVAS.slice(barAt, CANVAS.indexOf("\n}", barAt) + 2);
    has(bar, '"n-any-conv"', "四连按钮有一个容器（.n-any-conv）");
    has(bar, '"n-play n-any-conv-btn"', "每枚按钮是 .n-any-conv-btn");
    has(bar, "INPUT_ANY_TARGETS", "成员取自 INPUT_ANY_TARGETS（与右键同一张表 · 同样是四条）");
    has(bar, "KIND_ICON_SVG[t.kind]", "按钮只画图标（KIND_ICON_SVG · 与节点标题栏同源）");
    hasnt(bar, "textContent", "按钮里不放文字（短名只留在 title / aria-label 提示里）");
    has(CSS, ".n-any-conv-btn svg", "canvas.css 给图标定了尺寸");
    has(bar, "convertAnyNodeKind(node, t.kind)", "点击就地换 kind（app.js 的 convertAnyNodeKind）");
    hasnt(bar, 'convertAnyNodeKind(node, "input_any")', "四连按钮里没有「转回文件节点」的那一条");
    /* 挂在节点头部（.n-head）那排按钮上：只有 input_any 有，且就在输入族分支之前 */
    has(
      CANVAS,
      'if (node.kind === "input_any") {\n    head.appendChild(inputAnyConvertBar(node));',
      "菜单栏四连按钮只挂在文件节点头部的按钮排上",
    );
    has(CSS, ".n-any-conv-btn", "canvas.css 有四连按钮样式");
    has(CSS, ".n-any-conv", "canvas.css 有四连按钮组容器样式");
  }

  /* ============ [5] 泛用形态没有端子 · 只保留路径时有一个 ============ */
  console.log("\n[5] 泛用形态没有内容也就不给端子（留了路径才出端子）");
  {
    reset();
    const n = freshAnyNode();
    eqNum(G("outputCount")(n), 0, "文件节点没有输出端子（还没内容可给）");
    eqNum(G("inputCount")(n), 0, "文件节点没有输入端子（不是数据接收方）");
    /* 只保留路径：唯一的输出端子值 = 那段本机文件路径（下游据此触发工具） */
    ok(G("setInputAnyFilePath")(n, "E:/tmp/pkg.zip"), "路径可以登记进文件节点");
    eqStr(n.anyFile, "E:/tmp/pkg.zip", "node.anyFile 记的是绝对路径");
    eqNum(G("outputCount")(n), 1, "只保留路径的文件节点有 1 个输出端子");
    eqNum(G("inputCount")(n), 0, "它仍不接受输入（路径来源，不是数据接收方）");
    ok(!G("setInputAnyFilePath")(n, "   "), "空路径不登记");
    n.kind = "input_text";
    eqNum(G("outputCount")(n), 1, "转成文本节点后有一个输出端子");
    n.kind = "input_audio";
    eqNum(G("outputCount")(n), 1, "音频输入仍有 1 个输出端子（回归护栏）");
  }

  /* ============ [5b] 只保留路径 = 下游只拿到路径 ============ */
  console.log("\n[5b] 仅保留路径：下游接线 / @引用 拿到的就是这段路径");
  {
    /* 真身是 app.js 的 isTextSource / valueForInput / allTextItems 的 input_any 分支 ——
       这几处依赖太多邻居，本用例按源码切片钉住「分支在 · 口径对」。 */
    const valAt = APP.indexOf("泛用文件节点「仅保留路径」形态：静态源");
    ok(valAt > 0, "valueForInput 有 input_any 分支");
    const valSeg = APP.slice(valAt, valAt + 420);
    has(valSeg, 'src.kind === "input_any"', "按 kind 命中文件节点");
    has(valSeg, 'kind: "text", text: p', "端子值就是那段路径（纯文本，不是 file:/// URL）");
    const allAt = APP.indexOf("泛用文件节点「仅保留路径」形态：全文就是那段本机文件路径");
    ok(allAt > 0, "allTextItems 有 input_any 分支");
    has(APP.slice(allAt, allAt + 320), "src.anyFile", "取的是 node.anyFile");
    has(
      APP,
      '(n.kind === "input_any" && !!String(n.anyFile || "").trim())',
      "isTextSource：只有留了路径的文件节点才算文本来源",
    );
    has(
      APP,
      'if (n.kind === "input_any")\n    return String(n.anyFile || "").trim() ? 1 : 0;',
      "outputCount：留了路径才给 1 个输出端子",
    );
    /* body：路径那一行真的画在节点上 */
    const bb = CANVAS.slice(
      CANVAS.indexOf("function buildInputAnyBody(node, body) {"),
      CANVAS.indexOf("function buildBody(node, body) {"),
    );
    has(bb, '"n-any-path"', "body 里有路径展示块");
    has(bb, "node.anyFile", "展示的就是 node.anyFile");
    has(bb, "仅保留文件路径", "文案说清「只保留文件路径」");
    has(CSS, ".n-any-path", "canvas.css 有路径展示样式");
  }

  /* ============ [6] 接线 · 文案 · 指南 ============ */
  console.log("\n[6] 接线与文案：body 一颗上传按钮 · 说明 · 指南 · 英文词条");
  {
    /* 只取 buildInputAnyBody 本体（按大括号配对切，别一路切到 buildBody —— 中间还夹着
       ltout / ltart 的构建器，按函数边界更稳也更准） */
    const bb = slice(CANVAS, "buildInputAnyBody");
    has(bb, 'I18n.t("上传文件")', "body 里有「上传文件」按钮");
    eqNum(bb.split("createElement(\"button\")").length - 1, 1, "body 里只有一颗按钮（类型由文件决定，不铺四种按钮）");
    has(bb, "uploadIntoAnyNode(node)", "按钮接的是上传转换逻辑");
    has(
      CANVAS.slice(CANVAS.indexOf("function buildBody(node, body) {")),
      "buildInputAnyBody(node, body);",
      "buildBody 分流到文件节点渲染器",
    );
    /* 没上传前的手动转换提示要留在 body 里（否则用户找不到入口） */
    has(bb, "手动指定要转成", "body 里提示可以手动指定类型（上方按钮 / 右键）");
    /* 头部那颗 📄 文件参考仍然只给文本节点（文件节点用不着它） */
    has(
      CANVAS,
      'if (node.kind === "input_text" && !node.ro && !inputInherited(node) && !node.batch)',
      "📄 文件参考仍只挂在文本节点上",
    );
    /* 说明文案 */
    const helpAt = HELP.indexOf("input_any:");
    ok(helpAt > 0, "app-nodehelp.js 里有 input_any 的最简说明");
    const helpTxt = (HELP.slice(helpAt).match(/"([^"]+)"/) || [])[1] || "";
    ok(helpTxt.length >= 8 && helpTxt.length <= 80, "说明文案够短也说清（" + helpTxt.length + " 字）");
    /* 指南（中英 + 索引）· 新增节点类型必须补指南 */
    ok(fs.existsSync(path.join(ROOT, "guides/nodes/input_any.md")), "guides/nodes/input_any.md 存在");
    ok(fs.existsSync(path.join(ROOT, "guides/nodes/en/input_any.md")), "guides/nodes/en/input_any.md 存在");
    has(GUIDES, '"input_any"', "input_any 已进节点指南索引");
    /* 样式 */
    has(CSS, ".n-any-upload", "canvas.css 有上传按钮样式");
    /* 英文词条：新用到的界面取词全部登记 */
    for (const k of [
      "文件节点（上传任意文件 · 自动转为对应节点）",
      "上传文件（任意类型 · 自动转为对应节点）",
      "转换为输入节点",
      "音频节点",
      "视频节点",
      "文件大于 1 MB",
      "仍要导入",
      "无法解析该文件",
      "已转为「{t}」：{name}",
      "无法识别「{name}」的类型，未做转换",
      "「{name}」解析不出文本，只保留文件路径（下游可引用该路径触发工具）",
      "解析不出文本 · 仅保留文件路径，下游引用到的就是这段路径",
      "重新选择文件",
      "也可点上方按钮或右键本节点 · 手动指定要转成哪种输入节点",
      "手动更改类型：点击直接转换成对应的输入节点",
      "转换为",
      "上传文件",
    ])
      hasI18nKey(k, "i18n 有英文词条：" + k.slice(0, 18) + "…");
    /* 手册口径与代码一致（旧说法「超过 500KB 拒绝导入」已不存在） */
    hasnt(I18N, "500KB 拒绝导入", "手册里旧的「超过 500KB 拒绝导入」说法已删");
    has(I18N, "文件大于 1 MB", "手册与代码同一口径（1 MB 警告线）");
  }

  /* ============ [7] 载入图像 = 原图尺寸保留（不缩到 1080） ============ */
  console.log("\n[7] 文件节点载入图像：原样落盘，保留原图像素尺寸");
  {
    /* 主进程 asset:copy：缺省按资产落盘上限缩到长边 1280（REF_IMAGE_MAX_DIM 与它同源，
       出站 API 的参考图另走 API_REF_IMAGE_MAX_DIM=1080）；native=true 整份字节原样复制 */
    const cAt = MAIN.indexOf('ipcMain.handle("asset:copy"');
    ok(cAt > 0, "main.js 有 asset:copy 处理器");
    const cSeg = MAIN.slice(cAt, MAIN.indexOf('ipcMain.handle("asset:writeBase64"', cAt));
    has(cSeg, "native", "asset:copy 认 native 开关");
    has(
      cSeg,
      "shrinkImageBuffer(raw, srcExt, ASSET_IMAGE_MAX_DIM)",
      "缺省走资产落盘上限（长边 1280，与 REF_IMAGE_MAX_DIM 同源；其它调用零回退）",
    );
    ok(
      /const REF_IMAGE_MAX_DIM = ASSET_IMAGE_MAX_DIM;/.test(MAIN) &&
        /const API_REF_IMAGE_MAX_DIM = 1080;/.test(MAIN),
      "1080 只留给出站 API 那条（资产 / 参考图落盘统一 1280）",
    );
    ok(
      /native\s*\n\s*\?\s*\{\s*buf:\s*raw,\s*ext:\s*srcExt\s*\}/.test(cSeg),
      "native 分支原样落盘（buf: raw = 不改尺寸 / 不重编码 / 不换后缀）",
    );
    /* preload 桥：第四个入参透传 native（缺省 false，其它调用一字不改） */
    ok(
      /assetCopy:\s*\(srcPath, wfId, name, native\)/.test(PRELOAD),
      "preload.js assetCopy 多了 native 入参",
    );
    has(PRELOAD, "native: !!native", "桥把 native 透传进主进程");
    /* 渲染层：copyImageFromPath 第三参 opts.native → assetCopy 第四参 */
    const cpSeg = slice(APP, "copyImageFromPath");
    has(cpSeg, "opts", "copyImageFromPath 收了第三个参数");
    has(cpSeg, "!!(opts && opts.native)", "只有显式 native 才走原样落盘");
    has(cpSeg, "opts.native", "把 native 交给 assetCopy（真源只有这一处）");
    /* 文件节点的图像分支显式要原尺寸；图像节点「选择图像」口径不动 */
    has(slice(APP, "uploadIntoAnyNode"), "{ native: true }", "文件节点载入图像时显式要原尺寸");
    hasnt(slice(APP, "pickImage"), "native", "图像节点「选择图像」未改口径（仍走 1080 上限）");
  }

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " 项失败（共 " + checks + "）" : "✓ 全部 " + checks + " 项通过") +
      "  (smoke-file-node)",
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("EXCEPTION", e);
  process.exit(2);
});

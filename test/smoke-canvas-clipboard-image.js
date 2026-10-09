"use strict";
/* test/smoke-canvas-clipboard-image.js — 画布 Ctrl+V 剪贴板图像询问窗 回归
 * ============================================================================
 * 运行：node test/smoke-canvas-clipboard-image.js
 *
 * 钉住的需求（本轮）：剪贴板里存在图像或截图时，在画布处粘贴（Ctrl+V）先弹一个 dialogue
 * 询问窗，问要不要用剪贴板图像创建图像节点，并在窗里显示图像内容。
 *
 * 共识口径（拷问四轮定稿，逐条钉住）：
 *   [1] 触发范围：只在画布（焦点不在输入框 / 正文框 / 富文本、且没有文字选区）发生 ——
 *       编辑区里的粘贴一律让位原生与既有内嵌图片逻辑（q2）。
 *   [2] 取材两态：被复制的图片文件（有本机路径）与位图截图（只有内存 base64）；
 *       多张一次问完、一次建完（r2q3）；两态都没有 = 剪贴板里没有图像（本功能不介入）。
 *   [3] 选项按情形裁剪，主按钮（回车）= 用剪贴板图像创建节点（r2q1）：
 *       恰好选中 1 个可接收图像的节点才多一项「载入选中节点」（q3 / r3q4）、
 *       有最近复制的节点才多一项「粘贴刚才复制的节点」（q1）。
 *   [4] 弹窗 = #mtDialog 的深色确认框宿主 + 缩略图（点击开大图灯箱）+ 「以后不再询问」（q4/r2q5）。
 *   [5] 取消 = 静默、什么都不做、**不写盘**（q5）。
 *   [6] 落盘走 native 口径：原样保存（不缩小不重编码）；>32MB 同一个窗里多一行提示、
 *       主按钮变「仍然创建」（q6 / r3q2 / r2q4）。
 *   [7] 「以后不再询问」= 应用级配置 S.config.askPasteClipImage，设置里新增小节「画布粘贴」
 *       可改回来（r2q2 / r3q1）；关掉后画布粘图像直接建节点，但并存节点粘贴板时仍优先粘节点（r4q1）。
 *   [8] 交付范围：代码 + 中英 i18n 词条 + 本冒烟（q7，本次不同步 guides 文档）。
 *
 * 口径：与 test/smoke-node-copy-key.js 同一套路 —— 用 vm 从 renderer/app.js 里按名字抠出
 * **真实函数** 到沙箱里跑，只桩外围（DOM / 弹窗宿主 / 资产通道 / 画布状态），不桩被测逻辑；
 * 其余为只读的接线断言（主进程 / preload / 设置 / i18n / 打包白名单）。
 * ============================================================================
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
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const has = (hay, needle, msg) =>
  ok(
    String(hay).indexOf(needle) >= 0,
    msg + (String(hay).indexOf(needle) >= 0 ? "" : "（缺 " + JSON.stringify(needle) + "）"),
  );
const hasnt = (hay, needle, msg) =>
  ok(
    String(hay).indexOf(needle) < 0,
    msg + (String(hay).indexOf(needle) < 0 ? "" : "（仍含 " + JSON.stringify(needle) + "）"),
  );

/* ---------- 从源码里抠出顶层函数体（含 async 声明；不改动源文件） ---------- */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
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
  throw new Error("函数体不完整：" + name);
}

const APP = read("renderer/app.js");
const SETTINGS = read("renderer/app-settings.js");
const MAIN = read("main.js");
const PRELOAD = read("preload.js");
const BASE_CSS = read("renderer/css/base.css");
const DSH_CSS = read("renderer/css/dsh.css");
const I18N = require(path.join(__dirname, "..", "renderer", "i18n.js"));

/* ════════════ [1] 接线与口径（只读断言） ════════════ */
console.log("\n[1] 接线与口径");
{
  const keyAt = APP.indexOf("function canvasClipboardKey");
  const keySeg = APP.slice(keyAt, APP.indexOf("\nfunction ", keyAt + 10));
  has(keySeg, "canvasPasteFromClipboard();", "画布 Ctrl+V 交给 canvasPasteFromClipboard");
  hasnt(
    keySeg,
    'toast(I18n.t("粘贴板为空，请先 Ctrl+C 复制节点"), "warn")',
    "「粘贴板为空」不再在 keydown 里同步抢答（挪进入口，先看剪贴板有没有图像）",
  );
  /* 输入框里的 Ctrl+V：刚复制过节点（nodeClipPasteWanted）就粘节点、且**不介入**剪贴板图像询问
     （询问窗只走画布非编辑区那条 canvasPasteFromClipboard）；其余场合一律归浏览器原生粘贴。
     口径见 test/smoke-node-copy-key.js [3]，两处同源。 */
  has(
    keySeg,
    "if (!inCanvasField || !nodeClipPasteWanted()) return false;",
    "输入框里只有「刚复制过节点」才粘节点（粘的是节点，不介入剪贴板图像询问）",
  );
  hasnt(keySeg, "if (inFieldHere) return false;", "旧的「输入框里一律让给编辑器」判据已去掉");
  hasnt(keySeg, "if (inField) {", "旧的「输入框里无条件按 Ctrl+V 粘节点」分支不再存在");

  has(APP, "function canvasPasteFromClipboard()", "入口函数存在");
  has(APP, "async function clipImageAskDialog(", "询问窗函数存在");
  has(APP, "async function createImageNodesFromClipboard(", "用图像建节点函数存在");
  has(APP, "async function loadClipboardImagesIntoNode(", "载入选中节点函数存在");
  has(APP, "function clipboardImageTargetNode(", "「可接收图像的选中节点」判据存在");
  has(APP, "async function clipboardImagesOfCanvas(", "剪贴板取材口存在");
  has(APP, "function clipImageAskEnabled(", "询问开关判据存在");
  has(APP, "function clipImageAskSet(", "开关写入口存在（窗里勾选与设置小节同源）");
  has(APP, "function canvasPasteModalOpen(", "弹窗开着时的挡板存在");
  has(APP, "const CLIP_IMAGE_ASK_BYTES = 32 * 1024 * 1024;", "32MB 提醒线是显式常量");

  /* 弹窗：复用 #mtDialog 深色确认框宿主 + 缩略图 + 以后不再询问 */
  const dlgSeg = APP.slice(
    APP.indexOf("async function clipImageAskDialog("),
    APP.indexOf("async function clipImagesToCanvasAssets("),
  );
  has(dlgSeg, "await mtDialogForm({", "询问窗复用 #mtDialog 的 mtDialogForm 宿主");
  has(dlgSeg, 'img.className = "mt-clipimg-pic";', "正文里有缩略图");
  has(
    dlgSeg,
    "openImageLightbox(pic.src, pic.title, { above: true })",
    "点击缩略图开大图灯箱（抬一层压过弹窗）",
  );
  has(dlgSeg, 'I18n.t("以后不再询问（可在 设置 · 画布粘贴 里改回来）")', "窗里有「以后不再询问」");
  has(dlgSeg, "primary: true", "主按钮显式标了 primary（回车默认落在它上面）");
  has(dlgSeg, 'I18n.t("仍然创建")', ">32MB 时主按钮变「仍然创建」");
  has(dlgSeg, "if (!res) return null;", "取消 / Esc → 静默返回 null");
  hasnt(dlgSeg, "=== host", "没有「点外部即关」的蒙层判定（对话框 persistent 口径）");

  /* 样式：缩略图与灯箱抬层 */
  has(BASE_CSS, ".mt-clipimg-pic {", "缩略图样式在 css/base.css");
  has(DSH_CSS, ".img-lightbox.img-lb-top {", "灯箱抬层样式在 css/dsh.css");

  /* 落盘口径：native 原样保存；取消不写盘 */
  const toAssetsSeg = APP.slice(
    APP.indexOf("async function clipImagesToCanvasAssets("),
    APP.indexOf("async function createImageNodesFromClipboard("),
  );
  has(toAssetsSeg, "{ native: true }", "复制的图片文件走 copyImageFromPath(native)");
  has(toAssetsSeg, '"png", true)', "位图截图走 assetWriteBase64(..., native=true)");
  const entrySeg = APP.slice(
    APP.indexOf("async function canvasPasteFromClipboard("),
    APP.indexOf("\nfunction syncGroupBtns"),
  );
  has(entrySeg, "if (canvasPasteModalOpen()) return;", "弹窗开着时不介入");
  has(entrySeg, "if (S.view !== ", "只在画布视图介入（会话 / 应用视图不介入）");
  has(entrySeg, "if (!clipImageAskEnabled()) {", "关掉询问时走免询问分支");
  has(
    entrySeg,
    "if (hasNodes) pasteNodesFromClipboard();\n    else await createImageNodesFromClipboard(imgs);",
    "免询问时仍优先粘节点、图像只兜底直接建（r4q1）",
  );
  has(entrySeg, "/* action === null（取消）：静默什么都不做、不写盘 */", "取消 = 静默、不写盘");
  /* 建节点：input_image + 落当前作用域 + 建好即选中 */
  const mkSeg = APP.slice(
    APP.indexOf("async function createImageNodesFromClipboard("),
    APP.indexOf("async function loadClipboardImagesIntoNode("),
  );
  has(mkSeg, 'makeNode("input_image"', "新节点是 input_image（与拖入图片同口径）");
  has(mkSeg, "node.imageAsset = s.path;", "引用落盘后的资产路径");
  has(mkSeg, "S.selSet = new Set(created);", "建好即全部选中");
  has(mkSeg, "scheduleSave(true);", "建好立即保存");
  has(mkSeg, "{ n: created.length }", "提示里带张数");

  /* preload 桥 */
  has(
    PRELOAD,
    "clipboardReadImages: () => ipcRenderer.invoke('clipboard:readImages')",
    "preload 有剪贴板图像取材口",
  );
  has(PRELOAD, "assetWriteBase64: (wfId, name, base64, ext, native)", "assetWriteBase64 多了 native 入参");
  has(PRELOAD, "native: !!native", "桥把 native 透传进主进程");

  /* 主进程 */
  has(MAIN, 'ipcMain.handle("clipboard:readImages"', "main.js 有 clipboard:readImages 处理器");
  has(MAIN, 'require("./clipboard-images.js")', "main.js 引了剪贴板文件列表解析模块");
  has(MAIN, "const ASSET_IMAGE_NATIVE_MAX_BYTES = 64 * 1024 * 1024;", "native 档有 64MB 防呆上限");
  ok(
    /const cap = native \? ASSET_IMAGE_NATIVE_MAX_BYTES : ASSET_IMAGE_MAX_BYTES;/.test(MAIN),
    "两条资产通道按 native 分别取上限（缺省 4MB 口径不变）",
  );
  ok(
    /asset:writeBase64", \(e, \{ wfId, name, base64, ext, native \}\)/.test(MAIN),
    "asset:writeBase64 认 native",
  );
  ok(
    MAIN.indexOf("out.bitmap = {") > 0 && MAIN.indexOf("base64: buf.toString(\"base64\")") > 0,
    "位图只在内存里回 base64（本题不落盘，落盘由渲染层确认后走 asset:writeBase64）",
  );

  /* 打包白名单：根目录新模块必须进 build.json files（AGENTS.md 硬规则） */
  has(read("build.json"), '"clipboard-images.js",', "clipboard-images.js 已写进 build.json files 白名单");
  /* 探针实测：read("FileNameW") 给的是原始 UTF-16 字节逐字节当字符（'C\\0:\\0\\\\0…'），
     可用的 Unicode 路径只能从 readBuffer 按 ucs2 解 —— 中文 / 空格路径全靠这一条，且必须是
     「无条件补上」而不是「前面一个都没解出来才跑」（ANSI 那份乱码同样能通过扩展名过滤）。 */
  has(
    MAIN,
    'const buf = clipboard.readBuffer("FileNameW");',
    "FileNameW 另走 readBuffer 解 ucs2（read() 形态解不出整条路径）",
  );
  hasnt(
    MAIN,
    "if (!clipImages.clipParseFileList(rawList).length) {",
    "ucs2 兜底是无条件补上的（乱码候选同样过扩展名过滤，不能靠「解析为空」当开关）",
  );

  /* 设置小节 */
  has(SETTINGS, 'secTitle.textContent = I18n.t("画布粘贴");', "设置里新增「画布粘贴」小节");
  has(SETTINGS, "S.config.askPasteClipImage = !!askCb.checked;", "小节里的开关写同一个配置键");
  has(SETTINGS, "settingsSaved(0);", "开关改动即时落盘");
  has(
    SETTINGS,
    "askCb.checked = !(S.config && S.config.askPasteClipImage === false);",
    "缺省 = 询问（只有显式 false 才免询问）",
  );

  /* i18n：本批新词条中英齐备 */
  I18N.setLocale("en");
  const keys = [
    "剪贴板图像",
    "画布粘贴",
    "仍然创建",
    "用这张图创建图像节点",
    "用这 {n} 张图创建节点",
    "载入「{t}」",
    "粘贴刚才复制的节点",
    "以后不再询问（可在 设置 · 画布粘贴 里改回来）",
    "粘贴剪贴板图像时先询问（取消勾选 = 以后不再询问）",
    "剪贴板里有图像或截图时，在画布上按 Ctrl+V 会先弹一个确认框（显示图像内容），问你要不要用它创建「图像输入」节点。",
  ];
  const missing = keys.filter((k) => I18N.t(k) === k);
  ok(missing.length === 0, "新词条都有英文译文（缺：" + JSON.stringify(missing) + "）");
  ok(
    I18N.t("用这 {n} 张图创建节点", { n: 3 }).indexOf("3") >= 0,
    "带参数的词条占位符替换正常",
  );
  I18N.setLocale("zh");
}

/* ════════════ [2] clipboard-images.js：剪贴板文件列表解析（纯函数） ════════════ */
console.log("\n[2] clipboard-images.js：被复制的图片文件列表解析");
{
  const mod = require(path.join(__dirname, "..", "clipboard-images.js"));
  const p = (t) => mod.clipParseFileList(t);
  ok(JSON.stringify(p("C:\\a\\b.png")) === JSON.stringify(["C:\\a\\b.png"]), "单个路径原样通过");
  ok(
    p("C:\\a\\b.png\u0000C:\\c\\d.JPG\u0000").length === 2,
    "NUL 分隔的多文件（CF_HDROP 原样形态）按序解析",
  );
  ok(p("C:\\a\\b.png\u0000c:\\A\\B.PNG").length === 1, "重复路径去重（大小写不敏感）");
  const onlyPng = p("C:\\a\\readme.txt\u0000C:\\a\\b.png");
  ok(
    onlyPng.length === 1 && onlyPng[0].indexOf("b.png") > 0,
    "非图片扩展名一律滤掉",
  );
  ok(p("# comment\r\nfile:///C:/a/b.png").length === 1, "uri-list 的注释行忽略、file:/// URI 认得");
  ok(p('"C:\\a\\b.png"').length === 1, "成对引号包着的路径照旧认出");
  ok(p("").length === 0 && p(null).length === 0, "空串 / null 回空数组，不抛异常");
  ok(
    mod.clipIsImagePath("x.webp") && mod.clipIsImagePath("x.JPEG") && !mod.clipIsImagePath("x.mp4"),
    "扩展名判据覆盖 webp / jpeg，且不误收视频",
  );
}

/* ════════════ [3] vm 真跑：入口分流 + 落盘 + 载入 ════════════ */
(async () => {
  console.log("\n[3] canvasPasteFromClipboard：真实函数在沙箱里跑");
  const rec = {
    toasts: [],
    pasted: 0,
    made: 0,
    dialogs: 0,
    dialogReply: null,
    dialogInfo: null,
    assetWrites: [],
    copies: [],
    invalidated: [],
    saved: 0,
    rendered: 0,
    history: 0,
    configSaves: 0,
    metaCalls: 0,
    batches: [],
  };
  function mkEl(tag) {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      className: "",
      type: "",
      value: "",
      checked: false,
      textContent: "",
      title: "",
      alt: "",
      style: {},
      children: [],
      isConnected: true,
      onclick: null,
      onchange: null,
      appendChild(c) {
        el.children.push(c);
        return c;
      },
      querySelector() {
        return null;
      },
    };
    return el;
  }
  let clipReply = { ok: true, files: [], bitmap: null };
  const sb = {
    console,
    I18n: {
      t: (k, vars) =>
        vars && typeof vars === "object"
          ? String(k).replace(/\{(\w+)\}/g, (_, n) => (vars[n] == null ? "" : String(vars[n])))
          : String(k),
    },
    S: { view: "workflow", config: {}, wf: { id: "wf1", nodes: [] }, cam: { x: 0, y: 0, z: 1 } },
    nodeClipboard: null,
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      api: {
        clipboardReadImages: async () => clipReply,
        configSave: async () => {
          rec.configSaves++;
          return true;
        },
        assetWriteBase64: async (wfId, name, base64, ext, native) => {
          rec.assetWrites.push({ wfId, name, base64, ext, native });
          return { ok: true, path: "ASSET/" + name + "." + ext, bytes: 12 };
        },
        assetMeta: async () => {
          rec.metaCalls++;
          return { ok: true, width: 800, height: 600, bytes: 1024 };
        },
      },
    },
    document: {
      createElement: (t) => mkEl(t),
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
      getElementById: (id) => sb.__modal[id] || null,
      querySelector: () => null,
    },
    __modal: {},
    $: (sel) => (sel === "#canvas" ? { clientWidth: 1200, clientHeight: 800 } : null),
    toast: (m, kind) => rec.toasts.push({ m: String(m), kind: String(kind || "") }),
    pushHistory: () => rec.history++,
    renderCanvas: () => rec.rendered++,
    scheduleSave: () => rec.saved++,
    renderStatus: () => {},
    clearSelection: () => {
      sb.S.sel = null;
      sb.S.selSet = new Set();
    },
    clearDownstream: () => {},
    ensureDefaultSavePath: () => {},
    inputInherited: (n) => !!(n && n.inherited),
    /* 选中集口径：与 app.js 的 currentSelection 同义（selSet 为空时回退 S.sel） */
    currentSelection: () =>
      sb.S.wf.nodes.filter((n) => sb.S.selSet && sb.S.selSet.has(n.id)).length
        ? sb.S.wf.nodes.filter((n) => sb.S.selSet.has(n.id))
        : sb.S.wf.nodes.filter((n) => n.id === sb.S.sel),
    uniqueNodeTitle: (t) => String(t || "节点"),
    makeNode: (kind, x, y) => ({
      id: "n" + (++rec.made),
      kind,
      x,
      y,
      w: 220,
      h: 160,
      title: "",
    }),
    copyImageFromPath: async (srcPath, hint, opts) => {
      rec.copies.push({ srcPath, hint, native: !!(opts && opts.native) });
      return { path: "ASSET/clip-" + rec.copies.length + ".png", sourceName: "stem" };
    },
    invalidateImageMeta: (p) => rec.invalidated.push(p),
    wiresTo: () => [],
    formatBytes: (n) => Math.round(Number(n) || 0) + " B",
    uid: (p) => (p || "n") + "x" + Math.random().toString(36).slice(2, 6),
    mediaFileUrlOf: (p) => "file:///" + String(p).replace(/\\/g, "/"),
    openImageLightbox: () => {},
    pasteNodesFromClipboard: () => rec.pasted++,
    clipImageAskDialog: async (imgs, info) => {
      rec.dialogs++;
      rec.dialogInfo = info;
      return rec.dialogReply;
    },
  };
  sb.document.body = mkEl("body");
  vm.createContext(sb);
  vm.runInContext(
    [
      "var CLIP_IMAGE_ASK_BYTES = 32 * 1024 * 1024;",
      "var DROP_FILE_STEP_X = 340;",
      "var DROP_FILE_STEP_Y = 250;",
    ].join("\n"),
    sb,
    { filename: "consts.js" },
  );
  let API3 = null;
  try {
    const names = [
      "fileName",
      "extOf",
      "imageStem",
      "humanBytes",
      "dropNodeTitle",
      "makeImageBatchEntry",
      "clipImageAskEnabled",
      "clipImageAskSet",
      "clipboardImageCount",
      "clipboardImagesBytes",
      "clipboardImagePreviewSrc",
      "clipboardImagePreviewOpen",
      "clipboardImageSizeText",
      "clipboardImagesOfCanvas",
      "clipboardImageTargetNode",
      "canvasPasteModalOpen",
      "clipImagesToCanvasAssets",
      "createImageNodesFromClipboard",
      "loadClipboardImagesIntoNode",
      "canvasPasteFromClipboard",
    ];
    vm.runInContext(
      names.map((n) => fnBody(APP, n)).join("\n") +
        "\nthis.__api = { count: clipboardImageCount, bytes: clipboardImagesBytes," +
        " target: clipboardImageTargetNode, enabled: clipImageAskEnabled, set: clipImageAskSet," +
        " src: clipboardImagePreviewSrc, sizeText: clipboardImageSizeText," +
        " paste: canvasPasteFromClipboard };\n",
      sb,
      { filename: "extracted.js" },
    );
    API3 = sb.__api;
    ok(!!API3 && !!API3.paste, "被测函数齐全（20 个真实函数搬进沙箱）");
  } catch (e) {
    ok(false, "被测函数齐全（" + ((e && e.message) || e) + "）");
  }

  const IMG_FILE = {
    ok: true,
    files: [{ path: "C:\\pics\\风景.png", name: "风景.png", size: 1024 }],
    bitmap: null,
  };
  const IMG_BITMAP = {
    ok: true,
    files: [],
    bitmap: { base64: "AAA", bytes: 2048, width: 800, height: 600 },
  };
  const IMG_BOTH = {
    ok: true,
    files: [
      { path: "C:\\pics\\a.png", name: "a.png", size: 1024 },
      { path: "C:\\pics\\b.jpg", name: "b.jpg", size: 2048 },
    ],
    bitmap: { base64: "AAA", bytes: 512, width: 40, height: 30 },
  };
  function resetRun() {
    rec.toasts = [];
    rec.pasted = 0;
    rec.made = 0;
    rec.dialogs = 0;
    rec.dialogReply = null;
    rec.dialogInfo = null;
    rec.assetWrites = [];
    rec.copies = [];
    rec.invalidated = [];
    rec.saved = 0;
    rec.rendered = 0;
    rec.history = 0;
    rec.configSaves = 0;
    rec.metaCalls = 0;
    sb.nodeClipboard = null;
    sb.S.view = "workflow";
    sb.S.config = {};
    sb.S.wf = { id: "wf1", nodes: [] };
    sb.S.sel = null;
    sb.S.selSet = new Set();
    sb.__modal = {};
    clipReply = { ok: true, files: [], bitmap: null };
  }
  const run = (expr) => vm.runInContext(expr, sb);

  if (API3) {
    /* ---- 无图像：回到原来的两条路 ---- */
    resetRun();
    sb.nodeClipboard = { nodes: [{ id: "n1" }], marks: [] };
    await run("canvasPasteFromClipboard()");
    ok(rec.pasted === 1 && rec.dialogs === 0, "剪贴板里没有图像 + 有节点粘贴板 → 照旧粘节点（不问）");

    resetRun();
    await run("canvasPasteFromClipboard()");
    ok(
      rec.pasted === 0 &&
        rec.toasts.length === 1 &&
        rec.toasts[0].m.indexOf("粘贴板为空") >= 0,
      "剪贴板里没有图像、也没有节点粘贴板 → 提示「粘贴板为空」",
    );

    /* ---- 关掉询问：直接建 / 仍优先粘节点 ---- */
    resetRun();
    sb.S.config = { askPasteClipImage: false };
    clipReply = IMG_BITMAP;
    sb.nodeClipboard = { nodes: [{ id: "n1" }], marks: [] };
    await run("canvasPasteFromClipboard()");
    ok(
      rec.pasted === 1 && rec.dialogs === 0 && rec.assetWrites.length === 0,
      "关掉询问 + 并存节点粘贴板 → 仍优先粘节点，图像只兜底（r4q1）",
    );

    resetRun();
    sb.S.config = { askPasteClipImage: false };
    clipReply = IMG_BITMAP;
    await run("canvasPasteFromClipboard()");
    ok(
      rec.dialogs === 0 &&
        rec.assetWrites.length === 1 &&
        rec.assetWrites[0].native === true &&
        sb.S.wf.nodes.length === 1 &&
        sb.S.wf.nodes[0].kind === "input_image",
      "关掉询问 + 只有图像 → 直接原样落盘并建 input_image 节点",
    );
    ok(
      rec.assetWrites[0].ext === "png" &&
        sb.S.wf.nodes[0].imageAsset === "ASSET/" + rec.assetWrites[0].name + ".png" &&
        sb.S.selSet.has(sb.S.wf.nodes[0].id),
      "位图按 PNG 原样写进画布资产，节点引用它并被选中",
    );

    /* ---- 开关判据本身 ---- */
    resetRun();
    ok(API3.enabled() === true, "字段没写过 = 默认询问");
    sb.S.config = { askPasteClipImage: false };
    ok(API3.enabled() === false, "显式 false = 免询问");
    API3.set(true);
    ok(
      sb.S.config.askPasteClipImage === true && rec.configSaves === 1,
      "开关写入 = 改配置 + 立即落盘（设置小节与窗里勾选同一处口径）",
    );

    /* ---- 默认询问：取消不写盘 ---- */
    resetRun();
    clipReply = IMG_FILE;
    rec.dialogReply = null;
    await run("canvasPasteFromClipboard()");
    ok(
      rec.dialogs === 1 &&
        rec.copies.length === 0 &&
        rec.assetWrites.length === 0 &&
        sb.S.wf.nodes.length === 0 &&
        rec.pasted === 0,
      "默认询问：弹窗返回 null（取消 / Esc）→ 不写盘、不建节点、不粘节点",
    );

    /* ---- 窗里选「用图像创建节点」 ---- */
    resetRun();
    clipReply = IMG_FILE;
    rec.dialogReply = "image";
    await run("canvasPasteFromClipboard()");
    ok(
      rec.copies.length === 1 &&
        rec.copies[0].native === true &&
        rec.copies[0].srcPath === "C:\\pics\\风景.png",
      "选「用图像创建节点」：文件原样复制进画布资产（native）",
    );
    ok(
      sb.S.wf.nodes.length === 1 &&
        sb.S.wf.nodes[0].kind === "input_image" &&
        sb.S.wf.nodes[0].sourceName === "风景" &&
        sb.S.wf.nodes[0].title === "风景",
      "节点是 input_image，标题与 sourceName 沿用源文件名（去扩展名，与拖入图片同口径）",
    );

    /* 多张（文件 + 位图）→ 一次建多个节点 */
    resetRun();
    clipReply = IMG_BOTH;
    rec.dialogReply = "image";
    await run("canvasPasteFromClipboard()");
    ok(
      rec.copies.length === 2 && rec.assetWrites.length === 1 && sb.S.wf.nodes.length === 3,
      "多张一次问完一次建完：2 个图片文件 + 1 张位图 → 3 个节点（r2q3）",
    );
    ok(
      rec.copies.every((c) => c.native === true) && rec.assetWrites[0].native === true,
      "多张也都走 native 原样口径",
    );
    ok(
      sb.S.wf.nodes.every((n) => n.kind === "input_image") &&
        rec.toasts.some((t) => t.m.indexOf("3") >= 0),
      "多张建出来的全是图像输入节点，提示里带张数",
    );

    /* ---- 窗里选「粘贴刚才复制的节点」 ---- */
    resetRun();
    clipReply = IMG_FILE;
    rec.dialogReply = "nodes";
    sb.nodeClipboard = { nodes: [{ id: "n1" }], marks: [] };
    await run("canvasPasteFromClipboard()");
    ok(
      rec.pasted === 1 && rec.copies.length === 0 && sb.S.wf.nodes.length === 0,
      "并存时选「粘贴节点」：只粘节点、不写盘（q1 的并存分流）",
    );

    /* ---- 窗里选「载入选中节点」 ---- */
    resetRun();
    clipReply = IMG_BOTH;
    rec.dialogReply = "load";
    const plainNode = { id: "img1", kind: "input_image", title: "图像输入", entries: [] };
    sb.S.wf.nodes = [plainNode];
    sb.S.selSet = new Set(["img1"]);
    sb.S.sel = "img1";
    await run("canvasPasteFromClipboard()");
    ok(
      rec.copies.length === 1 &&
        rec.assetWrites.length === 0 &&
        plainNode.imageAsset === "ASSET/clip-1.png",
      "载入普通图像节点：只写它真正用到的那一张（不留孤儿资产）",
    );

    resetRun();
    clipReply = IMG_BOTH;
    rec.dialogReply = "load";
    const batchNode = {
      id: "img2",
      kind: "input_image",
      title: "批量图像",
      batch: true,
      entries: [],
    };
    sb.S.wf.nodes = [batchNode];
    sb.S.selSet = new Set(["img2"]);
    sb.S.sel = "img2";
    await run("canvasPasteFromClipboard()");
    ok(
      batchNode.entries.length === 3 && rec.copies.length === 2 && rec.assetWrites.length === 1,
      "载入批量图像节点：全部收成 entries（含位图）",
    );

    /* ---- 载入的被挡情形（只读） ---- */
    resetRun();
    clipReply = IMG_FILE;
    rec.dialogReply = "load";
    const roNode = { id: "img3", kind: "input_image", title: "只读", ro: true };
    sb.S.wf.nodes = [roNode];
    sb.S.selSet = new Set(["img3"]);
    sb.S.sel = "img3";
    await run("canvasPasteFromClipboard()");
    ok(rec.copies.length === 0 && roNode.imageAsset === undefined, "只读图像节点被挡下（同一组提示）");

    /* ---- 目标节点判据：恰好 1 个才给这一项 ---- */
    resetRun();
    sb.S.wf.nodes = [
      { id: "a", kind: "input_image", title: "A" },
      { id: "b", kind: "input_text", title: "B" },
    ];
    sb.S.selSet = new Set(["a"]);
    ok(API3.target() && API3.target().id === "a", "恰好选中 1 个图像节点 → 提供「载入选中节点」");
    sb.S.selSet = new Set(["a", "b"]);
    ok(API3.target() === null, "选中多个 → 不猜目标，整项不出现（r3q4）");
    sb.S.selSet = new Set(["b"]);
    ok(API3.target() === null, "选中的不是可接收图像的节点 → 不出现");
    sb.S.selSet = new Set(["a"]);
    sb.S.wf.nodes[0].ro = true;
    ok(API3.target() === null, "只读图像节点不作为可载入目标");
    sb.S.wf.nodes[0].ro = false;
    sb.S.wf.nodes[0].inherited = true;
    ok(API3.target() === null, "已继承输入（只读）的图像节点同样不作为目标");

    /* ---- 弹窗开着时整条不介入 ---- */
    resetRun();
    clipReply = IMG_FILE;
    sb.__modal = { mtDialog: { classList: { contains: (c) => c === "on" } } };
    await run("canvasPasteFromClipboard()");
    ok(
      rec.dialogs === 0 && rec.copies.length === 0 && rec.pasted === 0,
      "已有弹窗（#mtDialog 开着）时按 Ctrl+V 不介入、不叠窗",
    );
    resetRun();
    sb.__modal = { overlay: { style: { display: "flex" } } };
    await run("canvasPasteFromClipboard()");
    ok(rec.dialogs === 0 && rec.copies.length === 0, "设置等 #overlay 弹窗开着时同样不介入");

    /* ---- 非画布视图（会话 / 应用）里整条不介入 ---- */
    resetRun();
    clipReply = IMG_FILE;
    sb.S.view = "agent";
    await run("canvasPasteFromClipboard()");
    ok(
      rec.dialogs === 0 && rec.copies.length === 0 && rec.pasted === 0,
      "非画布视图按 Ctrl+V：不弹询问窗、也不动画布（只在画布视图介入）",
    );

    /* ---- 尺寸 / 体积文案与预览源 ---- */
    resetRun();
    ok(API3.count(IMG_BOTH) === 3, "张数 = 图片文件数 + 位图（0/1）");
    ok(API3.bytes(IMG_BOTH) === 1024 + 2048 + 512, "体积 = 各文件 size + 位图 bytes");
    ok(
      API3.sizeText(IMG_BOTH).indexOf("共 3 张") >= 0,
      "多张时元信息里写明「共 3 张」（r3q3 预览第一张 + 张数）",
    );
    ok(
      API3.src(IMG_BITMAP).indexOf("data:image/png;base64,") === 0,
      "位图预览用内存 data URL（不确认落盘也能显示图像内容）",
    );
    ok(API3.src(IMG_FILE) === "file:///C:/pics/风景.png", "图片文件预览用 file:/// 真路径");
  }

  /* ════════════ [4] clipImageAskDialog：真跑（只桩 #mtDialog 宿主） ════════════ */
  console.log("\n[4] clipImageAskDialog：选项裁剪 / 缩略图 / 勾选写开关（真函数）");
  {
    const d = {
      opts: null,
      reply: null,
      manual: false,
      resolve: null,
      lightboxes: [],
      toasts: [],
      configSaves: 0,
      els: [],
    };
    function mkEl2(tag) {
      const el = {
        tagName: String(tag || "div").toUpperCase(),
        className: "",
        type: "",
        value: "",
        checked: false,
        textContent: "",
        title: "",
        alt: "",
        style: {},
        children: [],
        isConnected: true,
        onclick: null,
        onchange: null,
        appendChild(c) {
          el.children.push(c);
          return c;
        },
      };
      d.els.push(el);
      return el;
    }
    const sb2 = {
      console,
      I18n: sb.I18n,
      S: { config: {} },
      document: {
        createElement: (t) => mkEl2(t),
        createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
        getElementById: () => null,
      },
      window: {
        api: {
          configSave: async () => {
            d.configSaves++;
            return true;
          },
          assetMeta: async () => ({ ok: true, width: 800, height: 600, bytes: 1024 }),
        },
      },
      toast: (m) => d.toasts.push(String(m)),
      formatBytes: (n) => Math.round(Number(n) || 0) + " B",
      mediaFileUrlOf: (p) => "file:///" + String(p).replace(/\\/g, "/"),
      openImageLightbox: (src, title, opts) =>
        d.lightboxes.push({ src, title, above: !!(opts && opts.above) }),
      mtDialogForm: async (opts) => {
        d.opts = opts;
        d.els = [];
        if (typeof opts.custom === "function") opts.custom(mkEl2("div"));
        /* manual 模式：把「用户在窗里操作完点了按钮」这一刻交给测试（勾选 checkbox 等） */
        if (d.manual)
          return await new Promise((res) => {
            d.resolve = res;
          });
        return d.reply;
      },
    };
    vm.createContext(sb2);
    vm.runInContext("var CLIP_IMAGE_ASK_BYTES = 32 * 1024 * 1024;", sb2, { filename: "consts2.js" });
    let ask = null;
    try {
      vm.runInContext(
        [
          "fileName",
          "extOf",
          "humanBytes",
          "clipImageAskSet",
          "clipboardImageCount",
          "clipboardImagesBytes",
          "clipboardImagePreviewSrc",
          "clipboardImagePreviewOpen",
          "clipboardImageSizeText",
          "clipImageAskDialog",
        ]
          .map((n) => fnBody(APP, n))
          .join("\n") + "\nthis.__ask = clipImageAskDialog;\n",
        sb2,
        { filename: "extracted2.js" },
      );
      ask = sb2.__ask;
      ok(!!ask, "clipImageAskDialog 抠进沙箱（真函数）");
    } catch (e) {
      ok(false, "clipImageAskDialog 抠进沙箱（" + ((e && e.message) || e) + "）");
    }
    const labels = () => d.opts.actions.map((a) => a.label);
    const ids = () => d.opts.actions.map((a) => a.id);
    const cbOf = () => d.els.filter((e) => e.type === "checkbox")[0] || null;
    const imgOf = () => d.els.filter((e) => e.className === "mt-clipimg-pic")[0] || null;
    const metaOf = () => d.els.filter((e) => e.className === "mt-clipimg-meta")[0] || null;

    if (ask) {
      /* ① 只有图像、无节点粘贴板、无选中目标：两个按钮，主按钮 = 用图像建节点 */
      d.reply = null;
      d.opts = null;
      d.els = [];
      sb2.S.config = {};
      let r = await ask(IMG_FILE, { hasNodes: false, target: null });
      ok(
        r === null && JSON.stringify(ids()) === JSON.stringify(["cancel", "image"]),
        "只有图像时按钮 = 取消 + 用图像建节点（按情形裁剪，q1/r2q1）",
      );
      ok(
        d.opts.actions[1].primary === true && d.opts.actions[0].primary === undefined,
        "主按钮是「用图像建节点」（primary 唯一）",
      );
      ok(
        labels()[1] === "用这张图创建图像节点" && labels()[0] === "取消",
        "单张时主按钮文案 = 用这张图创建图像节点，取消在最前",
      );
      has(d.opts.title, "剪贴板图像", "窗标题 = 剪贴板图像");
      ok(
        d.opts.msg.indexOf("风景.png") >= 0,
        "正文写明来源文件名（" + d.opts.msg + "）",
      );
      ok(!!d.opts.hint && typeof d.opts.custom === "function", "有说明行与自定义正文（缩略图 + 勾选）");
      ok(
        !!(imgOf() && imgOf().src === "file:///C:/pics/风景.png"),
        "缩略图用真路径（file:///）显示图像内容",
      );
      imgOf().onclick();
      ok(
        d.lightboxes.length === 1 &&
          d.lightboxes[0].above === true &&
          d.lightboxes[0].src === "C:\\pics\\风景.png",
        "点缩略图开大图灯箱（above=true 抬层压过弹窗）",
      );
      ok(
        !!(cbOf() && cbOf().type === "checkbox"),
        "正文里有「以后不再询问」勾选框",
      );
      await new Promise((res) => setTimeout(res, 0));
      ok(
        metaOf() && metaOf().textContent.indexOf("800×600") >= 0,
        "文件尺寸真读一次补进元信息（" + (metaOf() && metaOf().textContent) + "）",
      );

      /* ② 有目标 + 有节点粘贴板：多两项，主按钮不变 */
      d.opts = null;
      d.els = [];
      d.reply = null;
      await ask(IMG_FILE, { hasNodes: true, target: { id: "a", title: "A 图像" } });
      ok(
        JSON.stringify(ids()) === JSON.stringify(["cancel", "load", "nodes", "image"]),
        "并存时同一个窗里列「载入选中节点」与「粘贴刚才复制的节点」（q1/q3）",
      );
      ok(
        labels()[1] === "载入「A 图像」" && labels()[2] === "粘贴刚才复制的节点",
        "两个附加选项文案带目标节点标题",
      );

      /* ③ 多张：主按钮带张数 */
      d.opts = null;
      d.els = [];
      d.reply = null;
      await ask(IMG_BOTH, { hasNodes: false, target: null });
      ok(labels()[1] === "用这 3 张图创建节点", "多张时主按钮写明张数（r3q3/q1）");

      /* ④ >32MB：同一个窗里多一行提示，主按钮变「仍然创建」 */
      d.opts = null;
      d.els = [];
      d.reply = null;
      await ask(
        { ok: true, files: [], bitmap: { base64: "AA", bytes: 40 * 1024 * 1024, width: 9, height: 9 } },
        { hasNodes: false, target: null },
      );
      ok(
        d.opts.warn.indexOf("32MB") >= 0 && labels()[1] === "仍然创建",
        "超过 32MB：同窗提示 + 主按钮变「仍然创建」（r2q4 / r3q2，不弹第二个窗）",
      );

      /* ⑤ 勾选 + 选「用图像创建节点」→ 写开关；勾了却没选图像 → 不写 */
      const tick = () => new Promise((res) => setTimeout(res, 0));
      d.opts = null;
      d.els = [];
      sb2.S.config = {};
      d.manual = true;
      let p = ask(IMG_FILE, { hasNodes: false, target: null });
      await tick();
      cbOf().checked = true;
      cbOf().onchange();
      d.configSaves = 0;
      d.toasts = [];
      d.resolve({ action: "image", text: "" });
      const r5 = await p;
      d.manual = false;
      ok(r5 === "image", "返回动作 id 给调用方（image）");
      ok(
        sb2.S.config.askPasteClipImage === false && d.configSaves === 1,
        "勾选「以后不再询问」+ 选图像 → 写配置并立即落盘",
      );
      ok(d.toasts.length === 1 && d.toasts[0].indexOf("不再询问") >= 0, "并提示一句已记住");

      d.opts = null;
      d.els = [];
      sb2.S.config = {};
      d.manual = true;
      p = ask(IMG_FILE, { hasNodes: true, target: null });
      await tick();
      cbOf().checked = true;
      cbOf().onchange();
      d.configSaves = 0;
      d.resolve({ action: "nodes", text: "" });
      const r6 = await p;
      d.manual = false;
      ok(
        r6 === "nodes" && sb2.S.config.askPasteClipImage === undefined && d.configSaves === 0,
        "选了「粘贴节点」时不写「不再询问」（勾了也不算数）",
      );

      d.opts = null;
      d.els = [];
      sb2.S.config = {};
      d.reply = null;
      await ask(IMG_FILE, { hasNodes: false, target: null });
      ok(sb2.S.config.askPasteClipImage === undefined, "取消（返回 null）不写任何配置");

      /* ⑥ 位图预览走 data URL（不落盘也能显示内容） */
      d.opts = null;
      d.els = [];
      d.reply = null;
      await ask(IMG_BITMAP, { hasNodes: false, target: null });
      ok(
        imgOf().src.indexOf("data:image/png;base64,") === 0,
        "位图预览是内存 data URL（确认前不落盘）",
      );
      ok(
        d.opts.msg.indexOf("截图") >= 0,
        "位图来源在正文里写清是截图（" + d.opts.msg + "）",
      );
    }
  }

  console.log("");
  if (fails) {
    console.log("✗ " + fails + " / " + checks + " 项失败");
    process.exit(1);
  }
  console.log("✓ 全部 " + checks + " 项通过");
})().catch((e) => {
  console.error("EXCEPTION", e);
  process.exit(2);
});

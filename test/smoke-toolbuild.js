"use strict";
/* 工具构建（不支持的文件 → AI 方案 → 二次确认 → 开发并用该文件实测 → 入工具库 → @ 引用）
 * —— 链路级冒烟测试（纯 Node）
 *   node test/smoke-toolbuild.js
 * 被测代码都是「真实源码切片 / 真实模块」，不是抄一份逻辑：
 *   renderer/app-toolbuild.js  上半（文件支持判定表 + node.toolBuild 登记）
 *                              中段（主进程读首段判型 / 方案 JSON 抽取 · 归一 · 摘要）
 *   renderer/app-nodes.js      wireActsAsText(input_file) / fileWireSupportError / connectError 调用点
 *   renderer/app.js            toolBuildGreenFilesOf · toolBuildFileRefText · allTextItems(input_file)
 *                              · refSourcesForWire / refCandidates / resolveRefs(input_file) 接线
 *   renderer/i18n.js           本功能全部中文文案的英文词条（英文界面不回落）
 *   renderer/index.html        脚本接线顺序（app-tools.js → app-toolbuild.js → app-boot.js）
 *   build.json                 renderer/** 已覆盖（无新主进程模块，白名单无需改）
 * 覆盖：
 *   [1] 扩展名 / 支持判定表逐条（含 pdf 走 pdf-markdown 链、未登记 kind 不设限）
 *   [2] 连线拦截：不支持文件给可识别错误（点扩展名 + 工具构建出口）；绿灯 / 工具节点放行
 *   [3] allTextItems 对 input_file：未绿灯为空 + 一次提示；绿灯输出「路径 + 工具调用」
 *   [4] @ 引用可达面与块内容 = 路径 + 指定工具调用
 *   [5] node.toolBuild 登记表读写 / 老键迁移 / 绿灯判据 / 方案解析
 *   [6] 源码契约：无点外部关闭 · i18n 齐备 · index.html 顺序 · build.json 无需新增主进程模块
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
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* 源码切片：从 startMark 起、到 endMark 止（真实源码，不重写） */
function between(src, startMark, endMark, label) {
  const i = src.indexOf(startMark);
  const j = i < 0 ? -1 : src.indexOf(endMark, i + startMark.length);
  const good = i >= 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}

/* 轻量 I18n（=== renderer/i18n.js 的英文词表由 [6] 单独验，这里只要变量替换口径） */
const I18N_STUB = {
  t: (k, vars) =>
    String(k).replace(/\{(\w+)\}/g, (_, n) =>
      vars && vars[n] != null ? String(vars[n]) : "",
    ),
};

const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const ATB = read("renderer/app-toolbuild.js");

/* ═══════════════════ vm：真实源码切片 + 外围桩（桩是环境，不是被测逻辑） ═══════════════════════ */
const WARNS = [];
const SB = vm.createContext({
  console: {
    log() {},
    warn(...a) {
      WARNS.push(a.map(String).join(" "));
    },
    error(...a) {
      WARNS.push(a.map(String).join(" "));
    },
  },
  I18n: I18N_STUB,
});
const PRELUDE = `
var S = { wf: { id: 'wf1', nodes: [], wires: [] } };
var PORT_VALUES = {};
function nodeById(id) { return (S.wf.nodes || []).find(function (n) { return n.id === id; }) || null; }
function valueForInput(src, idx) { if (!src) return null; var v = PORT_VALUES[src.id + ':' + Number(idx || 0)]; return v === undefined ? null : v; }
function nodeParentSuperId(n) { return (n && n.parentSuperId) || ''; }
function isTextSource(n) { return !!(n && (n.kind === 'input_text' || n.kind === 'proc_text')); }
function isImageSource(n) { return !!(n && (n.kind === 'input_image' || n.kind === 'proc_image')); }
function isRefableSource(n) { return isTextSource(n) || isImageSource(n); }
function isFnToolNode() { return false; }
function isAssetNode() { return false; }
function wireSourceMediaType() { return 'text'; }
function isSuperLikeNode() { return false; }
function isItemPortSource() { return false; }
function assetRefItems() { return []; }
function assetItems() { return []; }
function splitSelected() { return null; }
function mergeItems() { return []; }
function inputInherited() { return false; }
function inboundWire() { return null; }
function parseSimpleYaml() { return []; }
function selResult() { return null; }
function taskSummaryText() { return ''; }
function refTextFromValue(v) { if (!v) return null; if (v.kind === 'text') return v.text == null ? '' : String(v.text); return null; }
function superExternalInWires() { return []; }
function superInternalOutFeeds() { return []; }
function wiresTo() { return []; }
var window = {};
`;
vm.runInContext(PRELUDE, SB);

const ATB_TOP = between(
  ATB,
  "const TOOLBUILD_EXTS = {",
  "/* ═══════════════ 工具构建：AI 方案 + 二次确认（中段）",
  "app-toolbuild.js 上半（支持判定 + node.toolBuild 登记）",
);
const ATB_HEAD = between(
  ATB,
  "const TOOLBUILD_PLAN_RUNKEY = ",
  "/* ---------- 方案 JSON：prompt / 解析 / 归一 / 摘要 ----------",
  "app-toolbuild.js 中段（读首段判型 / 魔数 / 文本嗅探）",
);
const ATB_PLAN = between(
  ATB,
  "function toolBuildExtractJson(text) {",
  "/* ---------- ① / ② 阻塞式确认 ----------",
  "app-toolbuild.js 中段（方案 JSON 抽取 / 归一 / 摘要）",
);
const NODES_TEXTWIRE = between(
  NODES,
  "function wireActsAsText(from, fi) {",
  "/* 输入端子是否为「数组（批量）参数」端子",
  "app-nodes.js wireActsAsText",
);
const NODES_FILEWIRE = between(
  NODES,
  "const TOOLBUILD_FILE_SOURCE_KINDS",
  "function connectError(fromId, toId, toIndex, fromIndex) {",
  "app-nodes.js fileWireSupportError（连线拦截）",
);
const APP_REFCHUNK = between(
  APP,
  "const TOOLBUILD_REF_HINTED = new Set();",
  "/* 聚合模式：取某个源的全部条目",
  "app.js toolBuildFileRefText / toolBuildGreenFilesOf（文本流唯一出口）",
);
const APP_ALLTEXT = between(
  APP,
  "function allTextItems(src, consumer, portIdx) {",
  "function allImageItems(src, consumer, portIdx) {",
  "app.js allTextItems（含 input_file 分支）",
);
const APP_REFSRC = between(
  APP,
  "function refSourcesForWire(w, consumer) {",
  "function refLeafSourcesForWire(",
  "app.js refSourcesForWire（@ 可达面）",
);
vm.runInContext(
  [ATB_TOP, ATB_HEAD, ATB_PLAN, NODES_TEXTWIRE, NODES_FILEWIRE, APP_REFCHUNK, APP_ALLTEXT, APP_REFSRC].join("\n"),
  SB,
);

function exec(code) {
  try {
    vm.runInContext(code, SB);
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}
/* 同步表达式探针：true 才算过 */
function P(expr, msg) {
  let v;
  try {
    v = vm.runInContext("(" + expr + ")", SB);
  } catch (e) {
    v = "ERR:" + String((e && e.message) || e);
  }
  ok(v === true, msg);
}
/* 取值探针 */
function V(expr) {
  try {
    return vm.runInContext("(" + expr + ")", SB);
  } catch (e) {
    return "ERR:" + String((e && e.message) || e);
  }
}
/* 异步探针 */
async function A(body, msg, expect) {
  let v;
  try {
    v = await vm.runInContext("(async () => { " + body + " })()", SB);
  } catch (e) {
    v = "ERR:" + String((e && e.message) || e);
  }
  const pass = expect ? expect(v) : !!v;
  ok(pass, msg + (typeof v === "string" && v.indexOf("ERR:") === 0 ? "  [" + v + "]" : ""));
}

(async function main() {
  /* ═══════════════════ [1] 扩展名 / 支持判定表逐条 ═══════════════════ */
  console.log("\n[1] 扩展名 / 文件支持判定表（单一真源：app-toolbuild.js 上半）");
  ok(V('typeof window.ToolBuild === "object" && !!window.ToolBuild') === true, "app-toolbuild.js 挂出 window.ToolBuild 命名空间");
  P(
    'window.ToolBuild.fileExtOf === fileExtOf && window.ToolBuild.unsupportedFilesOf === unsupportedFilesOf && window.ToolBuild.ensureToolBuildState === ensureToolBuildState',
    "命名空间导出 = 上半全部纯函数（fileExtOf / unsupportedFilesOf / ensureToolBuildState …）",
  );
  /* —— fileExtOf —— */
  P('fileExtOf("C:\\\\a\\\\b.TXT") === "txt"', "fileExtOf：Win 反斜杠路径 + 大小写归一（.TXT → txt）");
  P('fileExtOf("a/b/c.tar.gz") === "gz"', "fileExtOf：多段后缀只取最后一段（.tar.gz → gz）");
  P('fileExtOf("x.csv?k=1#h") === "csv"', "fileExtOf：去掉查询串 / 井号尾巴");
  P('fileExtOf(".gitignore") === "" && fileExtOf("noext") === "" && fileExtOf("a.") === "" && fileExtOf(null) === ""', "fileExtOf：隐藏名 / 无后缀 / 结尾点 / null 一律返回空");
  /* —— fileTypeOf —— */
  P(
    'fileTypeOf("a.docx") === "other" && fileTypeOf("a.txt") === "text" && fileTypeOf("a.MD") === "text" && fileTypeOf("a.csv") === "text" && fileTypeOf("a.yaml") === "text"',
    "fileTypeOf：文本类后缀归 text，docx 等认不出 → other",
  );
  P(
    'fileTypeOf("a.png") === "image" && fileTypeOf("a.webp") === "image" && fileTypeOf("a.mp4") === "video" && fileTypeOf("a.wav") === "audio" && fileTypeOf("a.pdf") === "pdf"',
    "fileTypeOf：图像 / 视频 / 音频 / pdf 四类分型正确",
  );
  /* —— fileExtsOfType —— */
  P(
    'fileExtsOfType("text").indexOf("md") >= 0 && fileExtsOfType("image").indexOf("png") >= 0 && fileExtsOfType("nope").length === 0',
    "fileExtsOfType：按大类给后缀清单，未知大类给空",
  );
  exec('_list = fileExtsOfType("text"); _list.push("zzz");');
  P('fileExtsOfType("text").indexOf("zzz") < 0', "fileExtsOfType：返回副本，改它不污染真源表");
  /* —— fileConsumerAccept —— */
  P(
    'JSON.stringify(fileConsumerAccept("proc_text")) === JSON.stringify(["text"]) && JSON.stringify(fileConsumerAccept("proc_image")) === JSON.stringify(["image"])',
    "fileConsumerAccept：proc_text 只吃 text、proc_image 只吃 image（kind 字符串入参）",
  );
  P(
    'JSON.stringify(fileConsumerAccept({ kind: "video_gen" })) === JSON.stringify(["video", "image"]) && JSON.stringify(fileConsumerAccept({ kind: "tts_gen" })) === JSON.stringify(["audio"]) && JSON.stringify(fileConsumerAccept({ kind: "music_gen" })) === JSON.stringify(["audio", "text"])',
    "fileConsumerAccept：媒体生成节点吃各自媒体（video 参考帧/视频 · tts 音频 · music 音频+歌词）",
  );
  P('fileConsumerAccept({ kind: "super" }) === null && fileConsumerAccept({ kind: "proc_image" }) !== null', "fileConsumerAccept：未登记 kind（如工具节点 super）返回 null = 不设限");
  /* —— fileSupportDetail 逐条 —— */
  P(
    '(function () { var d = fileSupportDetail("proc_text", "a.txt"); return d.supported === true && d.handledElsewhere === false && d.ext === "txt" && d.type === "text"; })()',
    "fileSupportDetail：proc_text + .txt → 支持（非别处处理）",
  );
  P(
    '(function () { var d = fileSupportDetail("proc_text", "a.docx"); return d.supported === false && d.type === "other" && d.reason.indexOf(".docx") >= 0 && d.reason.indexOf("text") >= 0; })()',
    "fileSupportDetail：proc_text + .docx → 不支持，reason 点明扩展名与可接受大类",
  );
  P(
    '(function () { var d = fileSupportDetail("proc_text", "a.pdf"); return d.supported === true && d.handledElsewhere === true && d.type === "pdf"; })()',
    "fileSupportDetail：pdf → 支持且 handledElsewhere（走既有 pdf-markdown 链，不触发工具构建）",
  );
  P(
    '(function () { var d = fileSupportDetail({ kind: "super", tool: true }, "a.docx"); return d.supported === true && d.handledElsewhere === false; })()',
    "fileSupportDetail：未登记 kind（工具节点）→ supported true（不误卡）",
  );
  P(
    'fileSupportDetail("proc_image", "a.png").supported === true && fileSupportDetail("proc_image", "a.txt").supported === false',
    "fileSupportDetail：proc_image 收图拒文",
  );
  P(
    'fileSupportDetail("video_gen", "a.mp4").supported === true && fileSupportDetail("video_gen", "a.png").supported === true && fileSupportDetail("video_gen", "a.docx").supported === false',
    "fileSupportDetail：video_gen 收视频与图像参考帧，拒 docx",
  );
  P(
    'fileSupportDetail("tts_gen", "a.wav").supported === true && fileSupportDetail("tts_gen", "a.png").supported === false && fileSupportDetail("music_gen", "a.mp3").supported === true && fileSupportDetail("music_gen", "a.txt").supported === true',
    "fileSupportDetail：tts_gen 只吃音频；music_gen 吃音频与歌词文本",
  );
  /* —— fileKindSupported —— */
  P(
    'fileKindSupported("proc_text", []) === true && fileKindSupported("proc_text", "a.md") === true && fileKindSupported("proc_text", ["a.md", "b.docx"]) === false && fileKindSupported("proc_text", ["a.pdf", "b.docx"]) === false',
    "fileKindSupported：空清单 → true；全支持 → true；任一不支持 → false（pdf 不算不支持）",
  );
  /* —— unsupportedFilesOf / wireSourceFiles —— */
  P(
    '(function () { var r = unsupportedFilesOf({ toNode: { kind: "proc_text" }, srcFiles: ["C:/x/a.docx", "C:/x/b.txt"] }); return r.length === 1 && r[0].ext === "docx"; })()',
    "unsupportedFilesOf：只报真正不支持的文件（支持项不报）",
  );
  P(
    'unsupportedFilesOf({ toNode: { kind: "proc_text" }, srcFiles: ["a.pdf"] }).length === 0 && unsupportedFilesOf({ toNode: { kind: "super", tool: true }, srcFiles: ["a.docx"] }).length === 0',
    "unsupportedFilesOf：pdf（handledElsewhere）与未登记 kind 都不报不支持",
  );
  P(
    '(function () { var r = unsupportedFilesOf({ toNode: { kind: "proc_text" }, fromNode: { kind: "input_file", files: [{ path: "C:/x/a.xlsx" }] } }); return r.length === 1 && r[0].path === "C:/x/a.xlsx"; })()',
    "unsupportedFilesOf：没给 srcFiles 时从源节点现场推断（input_file.files）",
  );
  P(
    'wireSourceFiles({ fromNode: { kind: "input_file", imagePaths: ["C:/i/a.png"] } })[0] === "C:/i/a.png" && wireSourceFiles({ srcFiles: ["C:/e/b.docx"] })[0] === "C:/e/b.docx"',
    "wireSourceFiles：显式 srcFiles 优先，其次 imagePaths / files",
  );
  exec('SRC1 = { id: "sf1", kind: "input_file", files: [] }; S.wf.nodes = [SRC1]; PORT_VALUES["sf1:0"] = { kind: "text", text: "C:/via/port.docx" };');
  P('wireSourceFiles({ from: "sf1", fromIndex: 0 })[0] === "C:/via/port.docx"', "wireSourceFiles：节点无文件字段时退回 valueForInput 的路径口径");
  P('wireConsumerNode({ toNode: { kind: "proc_text" } }).kind === "proc_text" && wireConsumerNode({ to: "sf1" }).id === "sf1"', "wireConsumerNode：优先 toNode，其次按 to id 查画布");

  /* ═══════════════════ [2] 连线拦截：不支持文件给可识别错误 ═══════════════════ */
  console.log("\n[2] 连线拦截：不支持文件给可识别错误（点扩展名 + 工具构建出口）");
  P('TOOLBUILD_FILE_SOURCE_KINDS.indexOf("input_file") === 0', "拦截只认文件来源：TOOLBUILD_FILE_SOURCE_KINDS = [input_file]");
  P('TOOLBUILD_WIRE_SKIP_CONSUMERS.indexOf("db_table") === 0', "db_table 例外：按 app-db.js 设计吃任意文件，不吃「可接受表」");
  exec(`
    NFILE = { id: "nfile", kind: "input_file", title: "文件", files: [{ path: "C:/x/a.docx" }] };
    NPROC = { id: "nproc", kind: "proc_text", title: "文本处理" };
    NTOOL = { id: "ntool", kind: "super", tool: true, title: "工具" };
    NFUNC = { id: "nfunc", kind: "function", title: "函数" };
    NDB = { id: "ndb", kind: "db_table", title: "数据表" };
    NIMG = { id: "nimg", kind: "proc_image", title: "图像处理" };
    S.wf.nodes = [NFILE, NPROC, NTOOL, NFUNC, NDB, NIMG];
  `);
  P(
    '(function () { var e = fileWireSupportError(NFILE, 0, NPROC); return typeof e === "string" && e.indexOf(".docx") >= 0 && e.indexOf("工具构建") >= 0; })()',
    "fileWireSupportError：input_file(.docx) → proc_text 给出可识别错误（点扩展名 + 工具构建出口）",
  );
  exec('CFILE2 = { id: "cf2", kind: "input_file", title: "文件2", files: [{ path: "C:/x/a.docx" }, { path: "C:/x/b.xlsx" }] };');
  P(
    '(function () { var e = fileWireSupportError(CFILE2, 0, NPROC); return e.indexOf(".docx") >= 0 && e.indexOf(".xlsx") >= 0 && e.indexOf(".docx / .xlsx") >= 0; })()',
    "fileWireSupportError：多个不支持扩展名去重并列（.docx / .xlsx）",
  );
  P(
    'fileWireSupportError({ id: "p1", kind: "input_file", files: [{ path: "a.pdf" }] }, 0, NPROC) === null',
    "fileWireSupportError：pdf 走 pdf-markdown 链 → 不拦",
  );
  P(
    'fileWireSupportError({ id: "p2", kind: "input_file", files: [{ path: "a.txt" }] }, 0, NPROC) === null',
    'fileWireSupportError：.txt 本就在 proc_text 可接受表内 → 放行',
  );
  P(
    'fileWireSupportError(NFILE, 0, NDB) === null && fileWireSupportError(NFILE, 0, NTOOL) === null && fileWireSupportError(NFILE, 0, NFUNC) === null',
    "fileWireSupportError：db_table / 工具节点 / 函数节点一律放行（文件即入参）",
  );
  P(
    'fileWireSupportError(NFILE, 0, NIMG) !== null',
    "fileWireSupportError：docx 接 proc_image 同样被拦（图像节点吃不下文本类）",
  );
  P(
    'fileWireSupportError({ id: "t1", kind: "proc_text", files: [{ path: "a.docx" }] }, 0, NPROC) === null && fileWireSupportError(NFILE, 0, null) === null',
    "fileWireSupportError：来源不是 input_file / 目标缺失 → 不表态（既有流程不受影响）",
  );
  /* 绿灯后放行 */
  exec('toolBuildReady(NPROC, { filePath: "C:/x/a.docx", toolName: "DocxTool", toolLibId: "lib1", inputParam: "file" });');
  P('fileWireSupportError(NFILE, 0, NPROC) === null', "fileWireSupportError：该文件已在目标节点工具构建绿灯 → 放行");
  exec('toolBuildReset(NPROC);');
  P(
    '(function () { toolBuildReady(NPROC, { filePath: "C:/x/a.docx", toolName: "DocxTool", toolLibId: "lib1", inputParam: "file" }); var e = fileWireSupportError(CFILE2, 0, NPROC); toolBuildReset(NPROC); return e.indexOf(".docx") < 0 && e.indexOf(".xlsx") >= 0; })()',
    "fileWireSupportError：绿灯文件从待办里剔除，只剩未绿灯的 .xlsx",
  );
  P('wireActsAsText({ kind: "input_file" }, 0) === true', "wireActsAsText：input_file 对外是「那条线的文件绝对路径」，按文本口径（可进工具 / 函数文本参数端子）");
  P('wireActsAsText({ kind: "proc_text" }, 0) === true && wireActsAsText(null, 0) === false', "wireActsAsText：普通文本来源口径逐字不变");
  /* connectError 调用点（源码契约：不动既有判定顺序） */
  (function () {
    const ci = NODES.indexOf("function connectError(fromId, toId, toIndex, fromIndex) {");
    const occ = NODES.indexOf("该输入端子已被占用", ci);
    const guard = NODES.indexOf('if (!fromCtrl && typeof fileWireSupportError === "function") {', ci);
    const call = NODES.indexOf("const fileErr = fileWireSupportError(from, fi, to);", ci);
    const next = NODES.indexOf("function connectPortAdvice(", ci);
    ok(ci >= 0 && occ > ci && guard > occ, "connectError：文件拦截排在通用占用判定之后（既有错误优先，判定顺序未推翻）");
    ok(guard > 0 && call > guard, "connectError：文件拦截只对数据线生效（!fromCtrl）+ 真源缺失时按「不拦」回落（不抛 ReferenceError）");
    ok(next > call && call < next, "connectError：拦截调用在 connectError 体内（不越界到别的函数）");
  })();

  /* ═══════════════════ [3] allTextItems 对 input_file 的文本出口 ═══════════════════ */
  console.log("\n[3] allTextItems：未绿灯为空 + 一次提示；绿灯输出「路径 + 工具调用」");
  exec(`
    S.wf.nodes = [];
    SRC = { id: "src1", kind: "input_file", title: "资料文件", files: [{ path: "C:/x/a.docx" }] };
    CONS = { id: "cons1", kind: "proc_text", title: "文本处理" };
    SOTHR = { id: "other1", kind: "proc_text", title: "别的处理" };
    S.wf.nodes = [SRC, CONS, SOTHR];
  `);
  const warns0 = WARNS.length;
  P('allTextItems(SRC, CONS, 0).length === 0', "allTextItems(input_file)：未工具绿灯 → 输出空（文件正文绝不进文本流）");
  ok(WARNS.length === warns0 + 1 && /工具构建/.test(WARNS[WARNS.length - 1]), "未绿灯时提示一次「请启用工具构建」");
  (function () {
    const before = WARNS.length;
    vm.runInContext("allTextItems(SRC, CONS, 0);", SB);
    ok(WARNS.length === before, "同一对节点重复取值不再重复提示（TOOLBUILD_REF_HINTED 去重）");
  })();
  exec('toolBuildReady(CONS, { filePath: "C:/x/a.docx", toolName: "DocxTool", toolLibId: "lib1", inputParam: "file" });');
  P(
    '(function () { var it = allTextItems(SRC, CONS, 0); return it.length === 1 && it[0].text.indexOf("C:/x/a.docx") >= 0 && it[0].text.indexOf("DocxTool") >= 0; })()',
    "allTextItems(input_file)：绿灯后输出「文件路径 + 指定工具调用」一条",
  );
  P(
    '(function () { var it = allTextItems(SRC, CONS, 0); return it[0].text.indexOf("入参 file = C:/x/a.docx") >= 0; })()',
    "allTextItems：写明入参名 = file 与该文件绝对路径",
  );
  P('allTextItems(SRC, SOTHR, 0).length === 0', "allTextItems：绿灯只对「这个消费者节点」有效，别的处理节点仍拿不到");
  P(
    'allTextItems({ id: "e1", kind: "input_file", title: "空文件", files: [] }, CONS, 0).length === 0',
    "allTextItems：没有任何文件的文件节点 → 空且不提示",
  );
  P(
    'allTextItems({ id: "it1", kind: "input_text", title: "文本", text: "正文" }, CONS, 0)[0].text === "正文"',
    "allTextItems：普通文本节点口径逐字不变",
  );
  exec('toolBuildReset(CONS);');

  /* ═══════════════════ [4] @ 引用：可达面 + 块内容 ═══════════════════ */
  console.log("\n[4] @ 引用：绿灯文件节点可达，块内容 = 路径 + 指定工具调用");
  P(
    'toolBuildFileRefText({ toolBuild: { toolName: "DocxTool", inputParam: "file" } }, "C:/x/a.docx") === "文件：C:/x/a.docx\\n调用已注册工具「DocxTool」：入参 file = C:/x/a.docx"',
    "toolBuildFileRefText：块内容 = 文件绝对路径 + 「调用已注册工具 X：入参 file = 路径」",
  );
  P(
    'toolBuildFileRefText({ toolBuild: {} }, "C:/x/b.bin").indexOf("未命名工具") >= 0 && toolBuildFileRefText({ toolBuild: {} }, "C:/x/b.bin").indexOf("入参 file") >= 0',
    "toolBuildFileRefText：工具名 / 入参名缺失时给安全兜底（未命名工具 · file）",
  );
  P('toolBuildGreenFilesOf(SRC, CONS).length === 0 && toolBuildGreenFilesOf(null, CONS).length === 0', "toolBuildGreenFilesOf：未绿灯 / 源缺失 → 空");
  P('toolBuildGreenFilesOf({ id: "x2", kind: "proc_text" }, CONS).length === 0', "toolBuildGreenFilesOf：非 input_file 来源 → 空");
  exec('toolBuildReady(CONS, { filePath: "C:/x/a.docx", toolName: "DocxTool", toolLibId: "lib1", inputParam: "file" });');
  P('JSON.stringify(toolBuildGreenFilesOf(SRC, CONS)) === JSON.stringify(["C:/x/a.docx"])', "toolBuildGreenFilesOf：唯一真源（@ 可达面 / 取值 / allTextItems / 高亮共用）");
  /* refSourcesForWire：未绿灯不进 @ 可达面，绿灯才进 */
  exec('toolBuildReset(CONS); W1 = { from: "src1", to: "cons1", fromIndex: 0 };');
  P('refSourcesForWire(W1, CONS).length === 0', "refSourcesForWire：文件节点未绿灯 → 不可 @（不进可达面）");
  exec('toolBuildReady(CONS, { filePath: "C:/x/a.docx", toolName: "DocxTool", toolLibId: "lib1", inputParam: "file" });');
  P('refSourcesForWire(W1, CONS).length === 1 && refSourcesForWire(W1, CONS)[0].id === "src1"', "refSourcesForWire：绿灯后文件节点成为 @ 来源");
  P('refSourcesForWire(W1, SOTHR).length === 0', "refSourcesForWire：可达面按消费者节点的绿灯态算");
  exec('toolBuildReset(CONS);');
  /* 源码契约：refCandidates / resolveRefs 同源 */
  (function () {
    const rc = APP.indexOf("function refCandidates(node) {");
    const gate = APP.indexOf("typeof toolBuildGreenFilesOf === \"function\"", rc);
    const call = APP.indexOf("toolBuildGreenFilesOf(n, node)", rc);
    ok(rc >= 0 && gate > rc && call > gate, "refCandidates：与 refSourcesForWire 同一放行口径（file 节点绿灯才投放候选，真源缺失按无绿灯回落）");
    const rj = APP.indexOf('if (c.kind === "input_file") {', APP.indexOf("function resolveRefs("));
    const gf = APP.indexOf("toolBuildGreenFilesOf(c, node)", APP.indexOf("function resolveRefs("));
    const rt = APP.indexOf("toolBuildFileRefText(node, p)", APP.indexOf("function resolveRefs("));
    ok(rj > 0 && gf > rj && rt > gf, "resolveRefs：input_file 分支按同一真源取绿灯文件，块 = toolBuildFileRefText（路径 + 工具名）");
  })();

  /* ═══════════════════ [5] node.toolBuild 登记表 / 绿灯判据 / 方案解析 ═══════════════════ */
  console.log("\n[5] node.toolBuild 登记表读写 · 老键迁移 · 绿灯判据 · 方案解析");
  exec('TBN = { id: "n1", kind: "proc_text" };');
  P('toolBuildStateOf(TBN).status === "idle" && TBN.toolBuild === undefined', "toolBuildStateOf：未登记节点给空态副本，不写回节点");
  exec('ST1 = ensureToolBuildState(TBN); ST1B = ensureToolBuildState(TBN);');
  P('ST1 === ST1B && TBN.toolBuild === ST1 && ST1.ver === 1 && ST1.status === "idle" && Array.isArray(ST1.log) && ST1.log.length === 0', "ensureToolBuildState：幂等归一（同一对象、ver/status/log 就位）");
  /* 老键迁移 */
  exec(`
    OLDF = { id: "n2", kind: "proc_text", toolBuildFilePath: "C:/x/老.docx", toolBuildToolName: "老工具",
             toolBuildLibId: "lib9", toolBuildInputParam: "file", toolBuilt: true,
             toolBuildLog: ["老日志一", { at: "t0", level: "warn", text: "老日志二" }] };
    OST = ensureToolBuildState(OLDF);
  `);
  P('OST.status === "ready" && OST.filePath === "C:/x/老.docx" && OST.fileType === ""', "老键迁移：toolBuildFilePath + toolBuilt=true → {filePath, status:ready}（fileType 缺省为空，由下次构建补齐）");
  P(
    '(function () { var o = { toolBuildFilePath: "a.docx", toolBuildFileType: "other", toolBuildToolName: "t", toolBuildLibId: "l", toolBuilt: true }; var s = ensureToolBuildState(o); return toolBuildGreen(s) === true; })()',
    "老键迁移：老字段齐备时可直接折算成绿灯态（fileType 也在迁移表内）",
  );
  P('OST.toolName === "老工具" && OST.toolLibId === "lib9" && OST.inputParam === "file"', "老键迁移：工具名 / 库 id / 入参名折进新结构");
  P('OST.log.length === 2 && OST.log[0].text === "老日志一" && OST.log[1].level === "warn"', "老键迁移：老日志（字符串 / 对象混排）归一为 {at,level,text}");
  P('OLDF.toolBuildFilePath === undefined && OLDF.toolBuildToolName === undefined && OLDF.toolBuilt === undefined && OLDF.toolBuildLog === undefined', "老键迁移：折完删除老键，避免双份真源");
  P(
    '(function () { var o = { id: "n3", toolBuildState: { status: "building", filePath: "a.docx" }, toolBuildReady: true }; var s = ensureToolBuildState(o); return s.filePath === "a.docx"; })()',
    "老键迁移：toolBuildState 对象先折进，显式值优先于老布尔",
  );
  /* 状态流转 */
  exec('B1 = toolBuildBegin(TBN, "C:/x/a.docx", { approach: "P" }, "开始");');
  P('B1.status === "building" && B1.filePath === "C:/x/a.docx" && B1.fileType === "other" && B1.toolName === "" && B1.toolLibId === "" && B1.builtAt === ""', "toolBuildBegin：置 building、按路径判型、清掉上一轮成品登记");
  P('TBN.toolBuild.log.length === 1 && TBN.toolBuild.log[0].text === "开始"', "toolBuildBegin：开工日志进 log");
  exec('toolBuildLog(TBN, "步骤", "warn"); toolBuildLog(TBN, "步骤", "怪档");');
  P('TBN.toolBuild.log[1].level === "warn" && TBN.toolBuild.log[2].level === "info"', "toolBuildLog：level 白名单（怪档回落 info）");
  exec('for (var _i = 0; _i < 260; _i++) toolBuildLog(TBN, "刷屏 " + _i);');
  P('TBN.toolBuild.log.length === 200 && TBN.toolBuild.log[199].text === "刷屏 259"', "toolBuildLog：上限 200 条，裁掉最旧的");
  exec('R1 = toolBuildReady(TBN, { toolName: "DocxTool", toolLibId: "lib1", inputParam: "file", log: "建成" });');
  P('R1.status === "ready" && R1.fileType === "other" && !!R1.builtAt && R1.log[R1.log.length - 1].text === "建成"', "toolBuildReady：置 ready、补 fileType 与 builtAt、写建成日志");
  P('toolBuildGreen(TBN) === true && toolBuildGreen(TBN, "C:/x/a.docx") === true && toolBuildFileGreen(TBN, "c:\\\\x\\\\A.DOCX") === true', "绿灯判据：字段齐备 + Windows 路径口径（分隔符 / 大小写）一致");
  P('toolBuildGreen(TBN, "C:/x/b.docx") === false', "绿灯判据：文件路径不一致 → 不绿灯");
  P('toolBuildGreen({ toolBuild: { status: "ready", filePath: "a", fileType: "text", toolName: "t" } }) === false', "绿灯判据：缺 toolLibId → 不绿灯（未入工具库不算成品）");
  P('toolBuildGreen(R1) === true && toolBuildGreen({ status: "ready", filePath: "a", fileType: "text", toolName: "t", toolLibId: "l" }) === true', "绿灯判据：可直接给状态对象（UI / 下半共用入口）");
  exec('F1 = toolBuildFailed(TBN, "实测三轮未过", { toolName: "DocxTool" });');
  P('F1.status === "failed" && F1.builtAt === "" && F1.log[F1.log.length - 1].level === "error"', "toolBuildFailed：置 failed、清 builtAt、错误进日志");
  P('toolBuildGreen(TBN) === false', "失败态不绿灯");
  exec('Z1 = toolBuildReset(TBN);');
  P('Z1.status === "idle" && Z1.toolName === "" && Z1.toolLibId === "" && Z1.inputParam === "" && Z1.log.length === 200', "toolBuildReset：回 idle、清成品登记、日志保留");
  P('toolBuildSamePath("C:/X/A.docx", "c:\\\\x\\\\a.DOCX") === true && toolBuildSamePath("a", "b") === false', "toolBuildSamePath：统一分隔符 + 忽略大小写");
  P('toolBuildInputKind("image") === "image" && toolBuildInputKind("text") === "text" && toolBuildInputKind("other") === "text"', "toolBuildInputKind：图像类文件 → image 入参，其余 → text");
  /* 方案解析 */
  P(
    'JSON.stringify(toolBuildExtractJson("前置说明\\n```json\\n{\\"a\\":1}\\n```\\n后记")) === JSON.stringify({ a: 1 })',
    "toolBuildExtractJson：优先取 ```json 围栏内的对象",
  );
  P('JSON.stringify(toolBuildExtractJson("随便说说 {\\"b\\": 2} 收尾")) === JSON.stringify({ b: 2 })', "toolBuildExtractJson：其次取首尾花括号之间");
  P('toolBuildExtractJson("完全不是 JSON") === null && toolBuildExtractJson("") === null && toolBuildExtractJson("[1,2]") === null', "toolBuildExtractJson：非 JSON / 空 / 数组一律 null（上层整段当摘要展示）");
  exec(`
    PN1 = toolBuildNormalizePlan(
      { "文件类型": ".docx 文档", "方案要点": "用 docx 解析器抽正文", "拟建工具名": "Docx转文本",
        "输入参数表": ["path"], "输出参数表": [{ name: "out", kind: "image" }], "实测用例": "跑该文件", "失败风险": "公式丢失" },
      { type: "other" },
    );
  `);
  P('PN1.fileType === ".docx 文档" && PN1.approach === "用 docx 解析器抽正文" && PN1.toolName === "Docx转文本"', "toolBuildNormalizePlan：中英键名都认（fileType / 文件类型 …）");
  P('PN1.inputs.length === 2 && PN1.inputs[0].name === "file" && PN1.inputs[0].kind === "text" && PN1.inputs[1].name === "path"', "toolBuildNormalizePlan：强制补 file 文本入参（工具构建硬要求）");
  P('PN1.outputs.length === 1 && PN1.outputs[0].kind === "image"', "toolBuildNormalizePlan：输出参数表 kind 透传 image");
  exec('PN2 = toolBuildNormalizePlan({}, { type: "text" });');
  P('PN2.inputs[0].name === "file" && PN2.outputs.length === 1 && PN2.outputs[0].kind === "text"', "toolBuildNormalizePlan：空方案也补 file 入参与 text 出参兜底");
  P('toolBuildNormalizePlan(null) === null && toolBuildNormalizePlan([1]) === null', "toolBuildNormalizePlan：非对象 → null（走摘要容错分支）");
  P(
    'toolBuildPlanSummaryText(PN1).indexOf("文件类型：.docx 文档") >= 0 && toolBuildPlanSummaryText(PN1).indexOf("实测用例：跑该文件") >= 0',
    "toolBuildPlanSummaryText：结构化方案 → 可读摘要（确认窗与状态展示共用）",
  );
  P('toolBuildPlanSummaryText("整段回文") === "整段回文"', "toolBuildPlanSummaryText：非结构化回文原样展示");
  /* 魔数 / 读首段（主进程桥桩） */
  P(
    'toolBuildMagicType([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) === "image" && toolBuildMagicType([0x25, 0x50, 0x44, 0x46]) === "pdf" && toolBuildMagicType([0x1a, 0x45, 0xdf, 0xa3]) === "video"',
    "toolBuildMagicType：PNG / PDF / EBML(mkv·webm) 识别",
  );
  P(
    'toolBuildMagicType([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]) === "audio" && toolBuildMagicType([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]) === "video"',
    "toolBuildMagicType：RIFF 四字码分流（WAVE → audio · AVI → video）",
  );
  P(
    'toolBuildMagicType([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]) === "video" && toolBuildMagicType([0x49, 0x44, 0x33, 0x04]) === "audio" && toolBuildMagicType([1, 2, 3]) === ""',
    "toolBuildMagicType：ftyp(mp4·mov) · ID3(mp3) 识别，认不出 → 空",
  );
  P('toolBuildLooksText([0x68, 0x65, 0x6c, 0x6c, 0x6f]) === true && toolBuildLooksText([0x68, 0x00, 0x69]) === false', "toolBuildLooksText：无 NUL 可打印 → 文本；含 NUL → 非文本");
  exec('window.api = { fileReadAudio: async function () { return { ok: true, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }; } };');
  await A(
    'var d = await toolBuildDetectFileType("C:/x/怪文件.bin"); return d.type === "image" && d.source === "magic" && d.ext === "bin" && d.extType === "other";',
    "toolBuildDetectFileType：后缀认不出时用主进程读首段的魔数（.bin + PNG 头 → image / magic）",
  );
  exec('window.api = { fileReadAudio: async function () { return { ok: true, bytes: [0x68, 0x65, 0x6c, 0x6c, 0x6f] }; } };');
  await A(
    'var d = await toolBuildDetectFileType("C:/x/无后缀"); return d.type === "text" && d.source === "sniff";',
    "toolBuildDetectFileType：魔数认不出 → 文本嗅探兜底（source = sniff）",
  );
  exec('window.api = null;');
  await A(
    'var d = await toolBuildDetectFileType("C:/x/a.pdf"); return d.type === "pdf" && d.source === "ext" && d.headBytes === null;',
    "toolBuildDetectFileType：后缀优先（桥缺失也不报错，退回后缀判型）",
  );
  await A(
    'var d = await toolBuildDetectFileType("C:/x/a.docx"); return d.type === "other" && d.source === "none";',
    "toolBuildDetectFileType：后缀 + 魔数都认不出 → other / none（不抛）",
  );

  /* ═══════════════════ [6] 源码契约：无点外部关闭 · i18n · index.html · build.json ═══════════════════ */
  console.log("\n[6] 源码契约：对话框持久化 · i18n 齐备 · 脚本接线顺序 · 打包白名单");
  ok(
    ATB.indexOf("{ min: false, persistent: true }") >= 0,
    "方案 / 启动确认窗：openOverlay(…, { min:false, persistent:true })（阻塞式确认，不可最小化 · 点外部不关）",
  );
  ok(
    ATB.indexOf('ev.key === "Escape"') >= 0 &&
      ATB.indexOf('document.addEventListener("click"') < 0 &&
      ATB.indexOf('document.addEventListener("mousedown"') < 0 &&
      ATB.indexOf("ev.target === ") < 0,
    "确认窗关闭只走显式路径（按钮 / Esc），没有「点外部即关」的 outside 监听",
  );
  (function () {
    const i = read("renderer/app-canvas.js").indexOf("function openToolBuildDialog(node, opts) {");
    const seg = read("renderer/app-canvas.js").slice(i, i + 600);
    ok(i >= 0 && seg.indexOf("persistent: true") >= 0, "方案 / 进度对话框：openOverlay(…, { persistent:true })（有未提交输入，点外部不关）");
  })();
  /* i18n：本功能全部中文文案在英文界面都有译文 */
  (function () {
    const I18n = require("../renderer/i18n.js");
    I18n.setLocale("en");
    const re = /I18n\.t\(\s*(["'])((?:[^"'\\\n]|\\.)*?)\1/g;
    const collect = (src) => {
      const set = new Set();
      let m;
      while ((m = re.exec(src))) set.add(m[2]);
      return set;
    };
    const canvas = read("renderer/app-canvas.js");
    const seg = canvas.slice(
      canvas.indexOf("工具构建 · 节点入口与方案 / 进度对话框"),
      canvas.indexOf("function buildInputAnyBody(node, body) {"),
    );
    ok(seg.length > 2000, "抠到 app-canvas.js 工具构建 UI 段（" + seg.length + " 字符）");
    const keys = new Set([...collect(ATB), ...collect(seg)]);
    /* app-nodes.js / app.js 新增的 3 条（连线拦截 + 文本出口） */
    [
      "该节点不支持 {ext} 文件：是否进行「工具构建」？",
      "文件：{path}",
      "调用已注册工具「{name}」：入参 {p} = {path}",
      "「{n}」接入的文件还没有可用的构建工具：请在该处理节点上启用「工具构建」；工具绿灯后该文件才能被 @ 引用",
    ].forEach((k) => keys.add(k));
    const missing = [];
    for (const k of keys) {
      if (!/[\u4e00-\u9fa5]/.test(k)) continue; /* 纯括号等非词条键不查 */
      const v = I18n.t(k);
      if (k.indexOf("{") >= 0) {
        if (!/[A-Za-z]{2,}/.test(v)) missing.push(k);
      } else if (v === k || !/[A-Za-z]{2,}/.test(v)) missing.push(k);
    }
    ok(missing.length === 0, "全部 " + keys.size + " 条工具构建文案（app-toolbuild.js + app-canvas.js UI 段 + 拦截 / 出口）在英文界面都有译文" + (missing.length ? " 缺：" + missing.slice(0, 5).join(" | ") : ""));
    ok(
      I18n.t("该节点不支持 {ext} 文件：是否进行「工具构建」？", { ext: ".docx" }).indexOf(".docx") >= 0 &&
        I18n.t("调用已注册工具「{name}」：入参 {p} = {path}", { name: "T", p: "file", path: "C:/a" }).indexOf("C:/a") >= 0,
      "拦截 / 出口文案的变量替换在英文下同样正确",
    );
    I18n.setLocale("zh");
  })();
  /* index.html 脚本分层顺序 */
  (function () {
    const html = read("renderer/index.html");
    const tools = html.indexOf('<script src="app-tools.js"></script>');
    const tb = html.indexOf('<script src="app-toolbuild.js"></script>');
    const boot = html.indexOf('<script src="app-boot.js"></script>');
    ok(tools > 0 && tb > tools && boot > tb, "index.html：app-tools.js → app-toolbuild.js → app-boot.js 顺序接线");
    ok(html.indexOf("app-toolbuild.js") >= 0 && (html.match(/<script src="app-toolbuild\.js"><\/script>/g) || []).length === 1, "index.html：app-toolbuild.js 只注册一次（无重复加载）");
  })();
  /* 打包白名单：无新主进程模块 */
  (function () {
    const bj = read("build.json");
    ok(bj.indexOf('"renderer/**"') >= 0, 'build.json：files 白名单含 "renderer/**"（app-toolbuild.js 随包）');
    ok(
      ATB.indexOf("require(") < 0 && read("preload.js").indexOf("app-toolbuild") < 0 && read("main.js").indexOf("app-toolbuild") < 0,
      "无新主进程模块：app-toolbuild.js 是纯渲染层文件（无 require / 未被 main.js·preload.js 引用），build.json 白名单无需新增",
    );
    ok(
      read("main.js").indexOf("toolBuild") < 0 && read("preload.js").indexOf("toolBuild") < 0,
      "无新 IPC：判型复用既有 fileReadAudio / fileReadText 桥（主进程未新增工具构建 IPC）",
    );
  })();

  console.log(
    "\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"),
  );
  process.exit(fails ? 1 : 0);
})();

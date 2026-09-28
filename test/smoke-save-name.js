/* 冒烟：保存节点「文件名」直改 + 后缀按输入类型决定
 *
 *   [1] 默认文件名不带后缀（ensureDefaultSavePath）
 *   [2] 输入类型未定 → 不补后缀；定了（有数据线 / 类型化别名）→ 强制后缀
 *   [3] saveFilenameOf / saveFilenameSet：只换文件名、保留目录、去掉后缀
 *   [4] 节点卡上有「文件名」直改行（buildBody 调用 saveNameFieldRow）+ 样式 + i18n
 *   [5] 文本落盘这一刻才补后缀（saveTextOnce / saveTextAgg 走 forcePathExt）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");
const I18N_SRC = read("renderer/i18n.js");
const CSS = read("renderer/css/canvas.css");

let checks = 0, fails = 0;
function ok(c, msg) { checks++; if (!c) { fails++; console.log("  FAIL  " + msg); } else console.log("  ok    " + msg); }
function eq(a, b, msg) { ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）"); }
function has(s, n, msg) { ok(String(s).indexOf(n) >= 0, msg); }

function fnBody(src, name) {
  const m = src.match(new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0, inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j], p = src[j - 1];
    if (inStr) { if (c === inStr && p !== "\\") inStr = null; continue; }
    if (c === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j) - 1; continue; }
    if (c === "/" && src[j + 1] === "*") { j = src.indexOf("*/", j) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error("函数体不闭合：" + name);
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const S = { wf: { nodes: [], wires: [] } };
const sandbox = {
  S, console, Math, JSON, String, Number, Boolean, RegExp, Object, Array,
  function_nodeById: null,
  nodeById: (id) => S.wf.nodes.find((n) => n.id === id) || null,
  wiresTo: (id) => S.wf.wires.filter((w) => w.to === id),
  isControlKind: (n) => !!(n && n.kind === "control"),
  isMediaGenNode: (n) => !!(n && ["music_gen", "tts_gen", "video_gen", "remotion"].includes(n.kind)),
  wfWorkspace: () => "E:/proj",
  resolveSavePath: (p) => ({ ok: true, path: String(p || "") }),
  applySuperRelToPath: (n, p) => p,
  preferRelativeSavePath: (p) => String(p || "").replace(/\\/g, "/"),
  forcePathExt: (p, ext) => {
    const s = String(p || ""), e = String(ext || ".md");
    const m = /\.([^.\\/]+)$/.exec(s);
    return m ? s.slice(0, -m[0].length) + e : s + e;
  },
  saveExtForMedia: (m) => ({ text: ".md", image: ".png", audio: ".wav", video: ".mp4" }[m] || ".md"),
  saveImageExtFor: (n) => "." + (n.oopFormat && n.oopFormat !== "png" ? n.oopFormat : "png"),
  saveMediaKind: (n) => {
    if (!n) return "text";
    if (n.kind === "save_image") return "image";
    const p = String(n.savePath || "");
    if (/\.png$/i.test(p)) return "image";
    if (/\.(wav|flac|mp3)$/i.test(p)) return "audio";
    if (/\.mp4$/i.test(p)) return "video";
    if (n.__media) return n.__media;
    return "text";
  },
  stemOfFilename: (name) => String(name || "").replace(/\.(ya?ml|png|jpe?g|webp|gif|wav|flac|mp3|mp4|webm|mov|md)$/i, ""),
  fileName: (p) => String(p).split(/[\\/]/).pop() || p,
  dirOfPath: (p) => { const s = String(p || ""); const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")); return i >= 0 ? s.slice(0, i) : ""; },
  safeFile: (s) => String(s || "item").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, "_").replace(/^_+|_+$/g, "") || "item",
  mediaGenOfBoundSave: () => null,
};
vm.createContext(sandbox);
/* 非法字符表是真源里的顶层 const：连着它一起抠进沙箱（保证与源码同口径） */
const BAD_CHARS_DECL = (APP.match(/\nconst SAVE_NAME_BAD_CHARS = .*;/) || [""])[0];
if (!BAD_CHARS_DECL) throw new Error("找不到 SAVE_NAME_BAD_CHARS 常量");
vm.runInContext(BAD_CHARS_DECL, sandbox);
vm.runInContext(extract(APP, [
  "isSaveKind", "isSaveNode", "saveDataLinks", "saveMediaCertain",
  "saveFilenameOf", "saveFilenameExtOf", "saveFilenameSanitize", "saveFilenameSet",
  "savePathDisplay", "applySavePathExt", "ensureDefaultSavePath",
]), sandbox);
const G = (n) => vm.runInContext(n, sandbox);
const node = (extra) => Object.assign({ id: "s1", kind: "save", title: "保存", savePath: "", __media: "text" }, extra || {});
const wire = (from, to) => ({ from, to, fromIndex: 0, toIndex: 0, rel: false });

console.log("\n[1] 默认文件名不带后缀");
{
  const n = node({ title: "报告" });
  G("ensureDefaultSavePath").call(null, n);
  eq(n.savePath, "报告", "新保存节点默认路径＝节点标题（无后缀）");
  ok(!/\.[a-z0-9]+$/i.test(n.savePath), "默认路径确实不带扩展名");
}

console.log("\n[2] 后缀只在输入内容类型定下来时决定");
{
  const n = node({ savePath: "out/报告" });
  S.wf = { nodes: [n], wires: [] };
  eq(G("saveFilenameExtOf")(n), "", "没连输入 → 后缀未定（空串）");
  G("applySavePathExt")(n);
  eq(n.savePath, "out/报告", "未定时 applySavePathExt 不擅自补后缀");

  const src = { id: "t1", kind: "agent_task", title: "写手" };
  S.wf = { nodes: [n, src], wires: [wire("t1", "s1")] };
  eq(G("saveFilenameExtOf")(n), ".md", "接上文本来源 → 后缀定为 .md");
  G("applySavePathExt")(n);
  eq(n.savePath, "out/报告.md", "定型后 applySavePathExt 才补后缀");

  const img = node({ id: "s2", kind: "save", title: "图", savePath: "out/立绘", __media: "image" });
  S.wf = { nodes: [img, src], wires: [wire("t1", "s2")] };
  eq(G("saveFilenameExtOf")(img), ".png", "图像来源 → 后缀 .png");
  const legacy = node({ id: "s3", kind: "save_image", savePath: "out/a", __media: null });
  S.wf = { nodes: [legacy], wires: [] };
  eq(G("saveFilenameExtOf")(legacy), ".png", "旧类型化别名 save_image 视为已定型");

  const typed = node({ id: "s4", savePath: "out/a.png" });
  S.wf = { nodes: [typed], wires: [] };
  ok(G("saveMediaCertain")(typed), "路径上已写可辨认后缀 = 用户自己定的，视为已定型");
  eq(G("saveFilenameExtOf")(typed), ".png", "已定型后缀与路径一致（不出现「后缀待定」的矛盾）");
}

console.log("\n[3] 文件名读写：去后缀、只换名字、保留目录");
{
  const n = node({ savePath: "out/报告.md" });
  eq(G("saveFilenameOf")(n), "报告", "读：去掉 .md，只给主名");
  G("saveFilenameSet")(n, "新版 报告");
  eq(n.savePath, "out/新版 报告", "写：换名保留目录、保留空格、默认不补后缀");
  G("saveFilenameSet")(n, "坏/名:字");
  eq(n.savePath, "out/坏_名_字", "非法字符替换为下划线");
  eq(G("savePathDisplay")(n), "out/坏_名_字", "未定型 → 展示原样（不猜后缀）");
}

console.log("\n[4] 节点卡上的「文件名」直改行 + 样式 + i18n");
{
  const body = fnBody(CANVAS, "buildBody");
  has(body, "saveNameFieldRow(node)", "save 分支把「文件名」直改行挂进 body");
  const row = fnBody(CANVAS, "saveNameFieldRow");
  has(row, "input", "直改行是一个输入框（不是只读文本）");
  has(row, "saveFilenameSet(node", "失焦 / 回车把输入写回节点");
  has(row, "saveFilenameExtOf(node)", "旁边按已定型的后缀刷新只读小片");
  [".sv-name", ".sv-name-inp", ".sv-name-ext", ".sv-name-ext.pending"].forEach((s) => has(CSS, s, "canvas.css 有样式：" + s));
  ["文件名", "后缀待定", "直接在这里改输出文件名，不必打开 ⚙；文件名默认不带后缀，输入类型确定后自动补 .md / .png / .wav / .mp4。"].forEach(
    (k) => has(I18N_SRC, JSON.stringify(k).slice(1, -1), "i18n 有词条：" + k.slice(0, 16)),
  );
}

console.log("\n[5] 文本落盘这一刻才补后缀");
{
  const agg = fnBody(NODES, "saveTextAgg");
  has(agg, 'forcePathExt(destRaw, saveExtForMedia("text"))', "聚合保存落盘补文本后缀");
  const once = fnBody(NODES, "saveTextOnce");
  has(once, 'forcePathExt(destBase0, saveExtForMedia("text"))', "单条保存落盘补文本后缀");
  has(once, 'batchOutPath(destBase0, titles[idx], ".yaml")', "批量仍走 .yaml 系列命名");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);

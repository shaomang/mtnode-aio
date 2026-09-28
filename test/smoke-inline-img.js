"use strict";
/* 内嵌图像（框内嵌图）回归：入图方式 / 落盘口径 / 编号与「（图像输入）」注入 /
 * 会话轮不重复发图 / 历史回看缩略图 / 无引用回收 / 手动素材与节点引用不被误删
 *   node test/smoke-inline-img.js
 *
 * 被测真源（一个都不重写）：
 *   · renderer/app-inline-img.js —— 整份在 vm 里跑（只给假 window / I18n / FileReader / api 桥）；
 *   · renderer/app.js      —— 胶囊登记表与无引用回收（promptCapsule* / collectInlineImgRefs /
 *                             gcCanvasInlineImages / savePromptCapsuleImage / removePromptCapsule）；
 *   · renderer/app-assist.js —— dshRunImages 的下游渲染（dshUserBodyHtml / dshUserImgHtml）+ 触发点；
 *   · renderer/app-db.js   —— dshRunImages（本轮图像附件）；
 *   · main.js / preload.js —— 落盘阈值、两道删除白名单、删画布连带资产目录（静态口径核对）。
 * 替身只在「与内嵌图无关的下游」：dshRunTask / 画布重绘 / 链接化（linkifyEscapedText）。
 *
 * 覆盖：
 *   [0] 装配：模块出口齐备 · app.js 切片全部真源
 *   [1] 入图方式：粘贴图片文件 / 剪贴板截图 / 资源管理器拖入 → 光标处一行 ![名称](绝对路径)
 *   [2] 落盘位置与阈值：assets/<wfId>/ + pc_ 命名 + 台账登记 + main.js 1280px / 4MB / 幂等
 *   [3] 编号与「（图像输入）」注入：按正文框内出现顺序编号，路径并进参考图
 *   [4] 会话轮不重复发图：只发本轮正文里的图（续跑 / 历史消息都不重复下发）
 *   [5] 历史回看缩略图：整行图行就地渲染成 <img>，其余行照旧
 *   [6] 无引用回收：纯函数判据 + 真跑一轮 GC（删图 / 清空框 / 删节点 / 删会话的触发点）
 *   [7] 手动素材与节点引用不被误删：候选只认台账 / 登记表；节点引用（input_image /
 *       生成 / save）、用户自己的图片、手放素材一律保留
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
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const has = (s, sub, msg) => ok(String(s).indexOf(sub) >= 0, msg);

/* ---------- 从源码里按名字抠出顶层函数 / 常量 ---------- */
function braceSlice(src, at, name) {
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
/* const / let / var 声明：按括号深度扫到顶层的第一个分号 */
function stmtSlice(src, at, name) {
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
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
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return src.slice(at, j + 1);
  }
  throw new Error("语句不完整：" + name);
}
function grab(src, name) {
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
  if (at < 0) throw new Error("找不到：" + name);
  const head = src.slice(at, at + 24);
  return /^(?:async\s+)?function/.test(head)
    ? braceSlice(src, at, name)
    : stmtSlice(src, at, name);
}
const extract = (src, names) => names.map((n) => grab(src, n)).join("\n");
const have = (src, nm) =>
  new RegExp("\\n(?:async\\s+)?function " + nm + "\\s*\\(|\\n(?:const|let|var) " + nm + "\\s*=", "m").test(
    src,
  );

const appSrc = read("renderer/app.js");
const assistSrc = read("renderer/app-assist.js");
const dbSrc = read("renderer/app-db.js");
const devSrc = read("renderer/app-devnode.js");
const mainSrc = read("main.js");
const preloadSrc = read("preload.js");
const moduleSrc = read("renderer/app-inline-img.js");
const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));
I18n.setLocale("zh");

/* ═══════════ [0] 装配：共享模块（整份真跑）+ app.js 切片 ═══════════ */
async function main() {
console.log("\n[0] 装配与切片自检");

/* 假 FileReader：blobToPicked 只用到 onload + result（测试数据挂在 file.__dataUrl 上） */
class FakeFileReader {
  readAsDataURL(file) {
    this.result = String((file && file.__dataUrl) || "");
    if (this.onload) this.onload();
  }
}
const APP_CALLS = { assetCopy: [], assetWriteBase64: [], assetDeleteImages: [], chatInputDeleteImages: [] };
const TOASTS = [];
function fakeApi(over) {
  return Object.assign(
    {
      getPathForFile: (f) => String((f && f.__path) || ""),
      /* 与 preload.js 同口径：本机路径 → file:/// URL（缩略图 / 灯箱用） */
      toFileUrl: (p) => require("url").pathToFileURL(String(p)).href,
      clipboardReadImage: async () => ({ ok: false }),
      assetCopy: async (srcPath, wfId, name) => {
        APP_CALLS.assetCopy.push({ srcPath, wfId, name });
        return { ok: true, path: "C:/data/assets/" + wfId + "/" + name + ".png", bytes: 10, written: true };
      },
      assetWriteBase64: async (wfId, name, base64, ext) => {
        APP_CALLS.assetWriteBase64.push({ wfId, name, ext, bytes: String(base64).length });
        return { ok: true, path: "C:/data/assets/" + wfId + "/" + name + (ext || ".png") };
      },
      assetDeleteImages: async (paths) => {
        APP_CALLS.assetDeleteImages.push(paths.slice());
        return { ok: true, removed: paths.slice(), skipped: [], failed: [] };
      },
      chatInputDeleteImages: async (paths) => {
        APP_CALLS.chatInputDeleteImages.push(paths.slice());
        return { ok: true, removed: paths.slice(), skipped: [], failed: [] };
      },
    },
    over || {},
  );
}
const S = {
  wf: { id: "wf1", name: "测试画布", nodes: [], wires: [], inlineAssets: [] },
  agentSessions: [],
  chatRefs: [],
  agentTaskSent: {},
};
const sandbox = {
  console,
  I18n,
  S,
  FileReader: FakeFileReader,
  /* 浏览器全局：base64 → 字节那一步用它（Node 的 vm 沙箱不自动带） */
  atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
  setTimeout,
  clearTimeout,
  toast: (m) => TOASTS.push(String(m)),
  scheduleSave: () => {},
  nodeById: (id) => (S.wf.nodes || []).find((n) => n.id === id) || null,
  agentSessions: () => S.agentSessions,
  chatImgRefs: () => S.chatRefs.slice(),
  fileName: (p) => {
    const s = String(p || "").replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  },
  /* 与内嵌图无关的下游替身：会话正文里的链接化（测试只看图行渲染） */
  linkifyEscapedText: (s) => String(s || ""),
};
sandbox.escapeHtml = (t) =>
  String(t == null ? "" : t)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
sandbox.plainTextToLinkHtml = (t) => sandbox.linkifyEscapedText(t);
sandbox.window = sandbox; /* 浏览器里 window 就是全局：模块与 app.js 片段共用同一份 */
vm.createContext(sandbox);
sandbox.api = fakeApi();
try {
  vm.runInContext(moduleSrc, sandbox, { filename: "app-inline-img.js" });
} catch (e) {
  ok(false, "renderer/app-inline-img.js 真跑失败：" + e.message);
  console.log("\n✗ 模块加载失败，终止");
  process.exit(1);
}
const II = sandbox.MTInlineImg;

const APP_FNS = [
  "PROMPT_CAP_ID_LEN",
  "PROMPT_CAP_SRC_RE",
  "PROMPT_CAP_FIELDS",
  "promptCapsuleSupported",
  "promptCapsuleToken",
  "promptCapsuleList",
  "promptCapsuleMap",
  "promptCapsuleRegister",
  "promptCapsuleUnregister",
  "promptCapsuleNewId",
  "promptCapsuleTokens",
  "resolvePromptCapsules",
  "promptCapsulesToText",
  "inlineImgMod",
  "inlineImgPathKey",
  "wfInlineAssets",
  "wfInlineAssetRemember",
  "wfInlineAssetForget",
  "canvasCapsuleTextRefs",
  "collectInlineImgRefs",
  "canvasInlineImgCandidates",
  "gcCanvasInlineImages",
  "gcCanvasInlineImagesSoon",
  "canvasInlineImgPrefix",
  "savePromptCapsuleImage",
  "removePromptCapsule",
];
try {
  const code = APP_FNS.map((n) => {
    let piece = "";
    try {
      piece = grab(appSrc, n);
    } catch (e) {
      throw new Error("抽取 " + n + " 失败：" + e.message);
    }
    try {
      new vm.Script(piece);
    } catch (e) {
      throw new Error("切片 " + n + " 编译失败：" + e.message);
    }
    return piece;
  }).join("\n");
  vm.runInContext(code, sandbox, { filename: "app-inline-slices.js" });
  vm.runInContext(
    extract(dbSrc, ["dshRunImages"]),
    sandbox,
    { filename: "app-db-slice.js" },
  );
} catch (e) {
  ok(false, "从 app.js / app-db.js 抽取真源失败：" + e.message);
  console.log("\n✗ 抽取失败，终止（" + fails + " 项）");
  process.exit(1);
}
const F = new Proxy({}, { get: (_t, k) => sandbox[k] });

eqArr(
  vm
    .runInContext(
      "[" + APP_FNS.map((n) => "typeof " + n).join(",") + "]",
      sandbox,
    )
    .map((t, i) => (t === "undefined" ? APP_FNS[i] : null))
    .filter(Boolean),
  [],
  "app.js 的 " + APP_FNS.length + " 个真源全部抽到（无缺失 / 无替身遮蔽）",
);
ok(!!II && typeof II.orphanImages === "function", "共享模块出口 window.MTInlineImg 就绪");
eqArr(
  [
    "orphanImages",
    "imgRefsIn",
    "imgRefsOfText",
    "normImgPath",
    "isAbsImgPath",
    "isChatInputImage",
    "isCanvasInlineImage",
    "imgLines",
    "imgLineText",
    "absImgPaths",
    "localPathOfRef",
    "handlePasteLine",
    "handleDropLine",
    "insertFromClipboardLine",
    "bindTextarea",
  ].filter((k) => typeof II[k] !== "function"),
  [],
  "共享模块的粘贴 / 拖入 / 落盘 / 回收入口齐备",
);
ok(F.dshRunImages("") && typeof F.dshRunImages("") .length === "number", "app-db.js 的 dshRunImages 抽到真源");

/* ═══════════ [1] 入图方式 ═══════════ */
console.log("\n[1] 入图方式：粘贴 / 截图 / 拖入 → 光标处一行 ![名称](绝对路径)");
function fakeTa(value) {
  return {
    value: String(value || ""),
    selectionStart: 0,
    selectionEnd: 0,
    addEventListener() {},
    dispatchEvent() {},
    classList: { add() {} },
    focus() {},
    isConnected: true,
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    },
  };
}
function fakeEv(dt) {
  return {
    clipboardData: dt,
    dataTransfer: dt,
    prevented: false,
    stopPropagation() {},
    preventDefault() {
      this.prevented = true;
    },
  };
}
/* ① 粘贴图片文件（浏览器 / 资源管理器复制图片时是文件项，没有本机路径 → 走 saveBase64 落盘） */
{
  const ta = fakeTa("写个说明\n");
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  const written = [];
  let hookB64 = "";
  const opts = {
    target: () => ({
      kind: "path",
      saveBase64: async (picked) => {
        written.push(1);
        hookB64 = String((picked && picked.base64) || "");
        return { path: "C:/ws/.mtnode-input/paste-abc12.png", alt: "截图" };
      },
    }),
  };
  const ev = fakeEv({
    types: ["Files"],
    items: [{ kind: "file", type: "image/png", getAsFile: () => ({ name: "a.png", type: "image/png", __dataUrl: "data:image/png;base64,AAA" }) }],
    files: [],
  });
  II.handlePasteLine(ev, ta, opts);
  await new Promise((r) => setTimeout(r, 10));
  ok(ev.prevented, "粘贴图片文件被接住（preventDefault，不落成文本）");
  eqStr(ta.value, "写个说明\n![截图](C:/ws/.mtnode-input/paste-abc12.png)", "在光标处插一行 ![](绝对路径)");
  eqNum(written.length, 1, "没有本机路径的来源先经 saveBase64 落成真文件再引用");
  /* 回归：FileReader 出来的是整条 data URL，钩子必须拿到**裸 base64** ——
     直接 atob(data URL) 抛 InvalidCharacterError，表现就是「图片落盘失败，无法插入」。 */
  eqStr(hookB64, "AAA", "钩子拿到的是裸 base64（data URL 前缀已在共享模块剥掉）");
  eqStr(II.stripDataUrl("data:image/png;base64,QUJD"), "QUJD", "stripDataUrl 剥 data URL 前缀");
  eqStr(
    Array.from(II.base64Bytes("data:image/png;base64,QUJD")).join(","),
    Array.from(II.base64Bytes("QUJD")).join(","),
    "base64Bytes 对两种形态解出同一串字节（落盘不写坏字节）",
  );
  eqNum(II.imgLines(ta.value).length, 1, "imgLines 认出 1 行内嵌图（胶囊条据此渲染）");
}
/* ② 剪贴板截图：既没有文本也没有文件项 → 主进程 clipboardReadImage 取位图 */
{
  const ta = fakeTa("");
  sandbox.api = fakeApi({ clipboardReadImage: async () => ({ ok: true, base64: "QUJD" }) });
  const opts = {
    target: () => ({
      kind: "path",
      saveBase64: async (picked) => {
        ok(!!(picked && picked.base64), "截图（只有 base64、没有路径）走 saveBase64 钩子先落盘成真文件");
        return { path: "C:/ws/.mtnode-input/paste-shot.png", alt: "截图" };
      },
    }),
  };
  const ev = fakeEv({ types: ["image/png"], items: [], files: [] });
  II.handlePasteLine(ev, ta, opts);
  await new Promise((r) => setTimeout(r, 10));
  ok(ev.prevented, "截图粘贴被接住");
  eqStr(ta.value, "![截图](C:/ws/.mtnode-input/paste-shot.png)", "截图在光标处插成一行内嵌图");
  sandbox.api = fakeApi();
  sandbox.api.getPathForFile = fakeApi().getPathForFile;
}
/* ③ 资源管理器拖入：有本机路径 → 直接引用那个绝对路径（不复制文件、不落盘） */
{
  const ta = fakeTa("看这两张\n");
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  const before = APP_CALLS.assetCopy.length;
  const dt = {
    types: ["Files"],
    files: [
      { name: "甲.png", type: "image/png", __path: "D:\\照片\\甲.png" },
      { name: "乙.jpg", type: "image/jpeg", __path: "D:\\照片\\乙.jpg" },
    ],
  };
  const ev = fakeEv(dt);
  await II.handleDropLine(ev, ta, { target: () => ({ kind: "path" }) });
  ok(ev.prevented, "拖入图片文件被接住");
  eqStr(
    ta.value,
    "看这两张\n![甲.png](D:\\照片\\甲.png)\n![乙.jpg](D:\\照片\\乙.jpg)",
    "一次拖两张 → 光标处逐行插入（有本机路径就直接引用它）",
  );
  eqNum(APP_CALLS.assetCopy.length, before, "用户自己的文件不复制、不落盘（正文写原路径）");
  eqArr(
    II.absImgPaths(ta.value),
    ["D:\\照片\\甲.png", "D:\\照片\\乙.jpg"],
    "absImgPaths 给出本轮要下发的本机路径（按出现顺序）",
  );
}
/* ④ 纯文本粘贴 / 非图片拖入：一律不拦，行为与改动前一致 */
{
  const ta = fakeTa("原文");
  const ev = fakeEv({ types: ["text/plain"], items: [], files: [], getData: () => "hello" });
  II.handlePasteLine(ev, ta, { target: () => ({ kind: "path" }) });
  ok(!ev.prevented, "纯文本粘贴不拦截（不 preventDefault）");
  eqStr(ta.value, "原文", "纯文本粘贴不动正文");
  const ta2 = fakeTa("原文2");
  const ev2 = fakeEv({ types: ["Files"], files: [{ name: "a.txt", type: "text/plain", __path: "C:\\a.txt" }] });
  await II.handleDropLine(ev2, ta2, { target: () => ({ kind: "path" }) });
  ok(!ev2.prevented, "非图片拖入不拦截");
  eqStr(ta2.value, "原文2", "非图片拖入不动正文");
}

/* ═══════════ [2] 落盘位置与阈值 ═══════════ */
console.log("\n[2] 落盘位置与阈值：assets/<wfId>/ + pc_ 命名 + 台账 + 1280px / 4MB / 幂等");
{
  eqStr(F.canvasInlineImgPrefix(), "pc_", "画布内嵌图命名前缀 = pc_（与回收判据同源，真源在共享模块）");
  const before = APP_CALLS.assetCopy.length;
  const saved = await F.savePromptCapsuleImage({ srcPath: "C:\\pics\\甲.png", name: "甲.png" });
  const call = APP_CALLS.assetCopy[before];
  eqStr(call.wfId, "wf1", "assetCopy 落到当前画布的资产目录（wfId = 当前画布 id）");
  ok(/^pc_/.test(call.name), "落盘名以 pc_ 开头：" + call.name);
  ok(!/[^\w.-]/.test(call.name), "落盘名只留 [\\w.-]（主进程还会再过滤一次）");
  ok(/^C:\/data\/assets\/wf1\//.test(saved.path), "回的是 <数据目录>/assets/<wfId>/ 下的绝对路径：" + saved.path);
  eqNum(F.wfInlineAssets().length, 1, "落盘那一刻记进 wf.inlineAssets 台账（删节点后回收仍认得这张图）");
  F.wfInlineAssetRemember(saved.path);
  F.wfInlineAssetRemember(saved.path.toUpperCase());
  eqNum(F.wfInlineAssets().length, 1, "台账登记幂等（同一路径大小写不同也只记一条）");
  const before64 = APP_CALLS.assetWriteBase64.length;
  const s2 = await F.savePromptCapsuleImage({ base64: "QUJD", name: "screenshot", ext: ".png" });
  const c2 = APP_CALLS.assetWriteBase64[before64];
  eqStr(c2.wfId, "wf1", "截图（base64）走 assetWriteBase64，同样落当前画布资产目录");
  ok(/^pc_/.test(c2.name), "base64 落盘名同样以 pc_ 开头");
  ok(/^C:\/data\/assets\/wf1\//.test(s2.path), "base64 落盘回资产目录绝对路径");
  S.wf.inlineAssets = [];
}
/* main.js：阈值 / 幂等 / 目录白名单 / 删画布连带资产目录 */
has(mainSrc, "const ASSET_IMAGE_MAX_DIM = 1280;", "main.js 资产落盘长边上限 = 1280px");
has(mainSrc, "const ASSET_IMAGE_MAX_BYTES = 4 * 1024 * 1024;", "main.js 单张上限 = 4MB");
ok(
  /function shrinkImageBuffer\(raw, ext, maxDim\)/.test(mainSrc) &&
    /已达标时原样返回/.test(mainSrc),
  "shrinkImageBuffer 幂等：已达标不重编码",
);
ok(
  /const written = writeAssetBytes\(dest, buf\);/.test(mainSrc) &&
    /if \(old\.equals\(buf\)\) return false;/.test(mainSrc),
  "writeAssetBytes 幂等：目标字节一致就跳过写盘（不刷 mtime）",
);
ok(
  /assetTooLargeError\(buf\.length/.test(mainSrc) && /已拒绝落盘/.test(mainSrc),
  "单张超 4MB 一律拒绝并回明确错误（copy 与 writeBase64 两条都过口径）",
);
has(mainSrc, "join(\r\n    assetDir(wfId),", "asset:copy / writeBase64 落盘目录 = assetDir(wfId)");
ok(
  /const assetDirPath = \(wfId\) => join\(DATA\(\), "assets"/.test(mainSrc),
  "资产目录 = <数据目录>/assets/<wfId>（数据不落应用文件夹）",
);
ok(
  /path\.dirname\(path\.dirname\(f\)\) !== path\.resolve\(join\(DATA\(\), "assets"\)\)/.test(mainSrc),
  "asset:deleteImages 按「<数据目录>/assets/<wfId>/ 直属图像」白名单校验",
);
ok(
  /CHAT_IMG_DIR_NAMES.has\(path\.basename\(path\.dirname\(f\)\)\)/.test(mainSrc) &&
    /CHAT_IMG_NAME_RE\.test\(path\.basename\(f\)\)/.test(mainSrc),
  "chat-input:deleteImages 目录 + 命名双白名单（用户手放 / 本机别处的图一律 skipped）",
);
ok(
  /chatInputDeleteImages: \(paths\) => ipcRenderer\.invoke\('chat-input:deleteImages'/.test(preloadSrc),
  "preload 桥出 chatInputDeleteImages",
);
ok(
  /const srcAssets = path\.resolve\(assetDirPath\(id\)\)/.test(mainSrc) &&
    /trashMove\(srcAssets, join\(entry, "assets"\)\)/.test(mainSrc),
  "删画布：assets/<wfId>/ 整目录随画布一起进回收站（画布名下的内嵌图一份不剩）",
);

/* ═══════════ [3] 编号与「（图像输入）」注入 ═══════════ */
console.log("\n[3] 编号与「（图像输入）」注入：按正文框内出现顺序编号");
{
  const node = {
    id: "n1",
    kind: "proc_text",
    prompt: "先看 @img:aaaaaaa 再写第二张 @img:bbbbbbb\n末句",
    inlineImgs: [
      { id: "aaaaaaa", path: "C:/data/assets/wf1/pc_a.png", name: "甲.png", nodeId: "n1" },
      { id: "bbbbbbb", path: "C:/data/assets/wf1/pc_b.png", name: "乙.png", nodeId: "n1" },
    ],
  };
  const refImages = ["C:/other/wired.png"];
  const r = F.resolvePromptCapsules(node.prompt, node, refImages);
  has(r.prompt, "（图像输入）标题：甲.png\n图 1", "第 1 张就地写成「（图像输入）标题：甲.png + 图 1」");
  has(r.prompt, "（图像输入）标题：乙.png\n图 2", "第 2 张编号为图 2");
  ok(r.prompt.indexOf("@img:") < 0, "正文里的 token 已被替换干净（不留 @img:xxxxxxx 给模型看）");
  eqArr(
    refImages,
    ["C:/other/wired.png", "C:/data/assets/wf1/pc_a.png", "C:/data/assets/wf1/pc_b.png"],
    "两张内嵌图的路径并进 refImages（既有真多模态通路：proc_text 多模态 / agent_task spec.images）",
  );
  eqNum(r.blocks.length, 2, "逐图内容块 2 条（交 buildSpec 按位置写进正文）");
  eqArr(r.blocks.map((b) => b.index), [0, 1], "内容块 index 从 0 起（= 图 N-1）");
  eqArr(r.blocks.map((b) => b.path), ["C:/data/assets/wf1/pc_a.png", "C:/data/assets/wf1/pc_b.png"], "内容块带本机路径");
  /* 认不出的 token 原样保留（绝不动用户正文） */
  const r2 = F.resolvePromptCapsules("看 @img:zzzzzzz 写", node, []);
  eqStr(r2.prompt, "看 @img:zzzzzzz 写", "登记表里没有的 token 原样保留");
  eqNum(r2.blocks.length, 0, "认不出的 token 不产生内容块");
  /* 编号按「正文框内第几张」，与请求里参考图序号无关 */
  const r3 = F.resolvePromptCapsules("@img:bbbbbbb 单张", node, ["C:/a.png", "C:/b.png"]);
  has(r3.prompt, "图 1", "单独一张时也按正文框内顺序给「图 1」（不跟参考图序号跑）");
  /* judge 的判据是纯文本判读 */
  eqStr(
    F.promptCapsulesToText("判据 @img:aaaaaaa 成立", node),
    "判据 （内嵌图片：甲.png） 成立",
    "judge 判据里 token → 可读注记（不认图）",
  );
}

/* ═══════════ [4] 会话轮不重复发图 ═══════════ */
console.log("\n[4] 会话轮不重复发图：只发本轮正文里的图");
{
  const first = "第一轮\n![截图](C:/ws/.mtnode-input/paste-1.png)";
  const second = "第二轮追问（不提图）\n";
  eqArr(F.dshRunImages(first), ["C:/ws/.mtnode-input/paste-1.png"], "首轮：dshRunImages 只取本轮正文里的图");
  eqArr(F.dshRunImages(second), [], "追问轮：本轮正文里没有图 → 不下发（历史图不重复发送）");
  eqArr(
    F.dshRunImages("![a](file:///C:/x/a.png)\n![a2](C:\\x\\a.png)"),
    ["C:/x/a.png"],
    "file:/// 与本机路径归一后同一张只发一次",
  );
  ok(
    /const roundImages =\s*\n?\s*resumeRound \|\| typeof dshRunImages !== "function" \? \[\] : dshRunImages\(t\);/.test(
      assistSrc,
    ) || /resumeRound \|\| typeof dshRunImages !== "function" \? \[\] : dshRunImages\(t\)/.test(assistSrc),
    "agentSessionSend：images 的来源就是本轮正文 t（不是整段历史）",
  );
  has(assistSrc, "images: roundImages.length ? roundImages : undefined,", "只在本轮有图时才带 images（空轮不带）");
  ok(
    ((assistSrc.match(/dshRunImages\(/g) || []).length === 1),
    "全文件只有一处 dshRunImages(...) 调用（不会另有一处把历史消息也灌进去）",
  );
  ok(
    /resumeRound/.test(assistSrc) && /续跑轮（暂停后点「继续」）不下发/.test(assistSrc),
    "续跑轮（暂停后「继续」）明确不下发：那份会话里图已在上下文",
  );
  ok(
    have(read("renderer/app-nodes.js"), "imagesNotInBody"),
    "节点正文框侧同口径：imagesNotInBody 让正文里出现过的图不再作为连线 / 广播图重复下发",
  );
}

/* ═══════════ [5] 历史回看缩略图 ═══════════ */
console.log("\n[5] 历史回看缩略图：整行图行就地渲染成 <img>");
{
  const s2 = { console, I18n, window: {}, linkifyEscapedText: (s) => String(s || "") };
  s2.window = s2;
  s2.api = fakeApi();
  /* 转义 / 链接化是与内嵌图无关的下游（本切片冒烟只验图行渲染），给同口径替身；
     真源 dshEscHtml 见 assistSrc，dshUserImgHtml / dshUserBodyHtml 全部真跑 */
  s2.escapeHtml = (t) =>
    String(t == null ? "" : t)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  s2.dshEscHtml = (t) => s2.escapeHtml(t);
  s2.plainTextToLinkHtml = (t) => s2.linkifyEscapedText(s2.escapeHtml(t));
  vm.createContext(s2);
  vm.runInContext(moduleSrc, s2, { filename: "app-inline-img.js" });
  vm.runInContext(
    extract(assistSrc, ["dshUserImgHtml", "dshUserBodyHtml"]),
    s2,
    { filename: "assist-slices.js" },
  );
  ok(
    /function dshEscHtml\(s\) \{\s*if \(typeof escapeHtml === "function"\) return escapeHtml\(s\);/.test(
      assistSrc,
    ),
    "真源 dshEscHtml 与全局 escapeHtml 同口径（替身只是切片冒烟的边界）",
  );
  const A = new Proxy({}, { get: (_t, k) => s2[k] });
  const html = A.dshUserBodyHtml("看这张\n![甲](C:/x/甲.png)\n还有这句");
  has(html, '<img class="dsh-msg-img"', "图行就地渲染成缩略图 <img class=dsh-msg-img>");
  has(html, 'src="' + require("url").pathToFileURL("C:/x/甲.png").href + '"', "缩略图 src = file:/// 本机路径（回看历史消息时照旧显示）");
  has(html, 'data-dsh-img-path="C:/x/甲.png"', "缩略图带本机路径（点开灯箱看原图）");
  has(html, "看这张", "图行之外的行照旧展示");
  has(html, "还有这句", "图行前后两段都在");
  ok(html.indexOf("![甲]") < 0, "原文的图行不再原样漏出来");
  eqNum((html.match(/dsh-msg-img/g) || []).length, 1, "一行图行只渲染一张缩略图");
  const plain = A.dshUserBodyHtml("没有图的一段话");
  ok(plain.indexOf("dsh-msg-img") < 0, "没有图行的消息渲染与改动前一致（纯文本 + 链接）");
  has(assistSrc, 'class="dsh-msg-img"', "CSS 类与 css/dsh.css 的 .dsh-msg-body img.dsh-msg-img 对得上");
  has(read("renderer/css/dsh.css"), ".dsh-msg-body img.dsh-msg-img", "缩略图样式在 css/dsh.css 里");
}

/* ═══════════ [6] 无引用回收 ═══════════ */
console.log("\n[6] 无引用回收：候选 - 引用 = 孤儿（纯函数 + 真跑一轮）");
{
  /* 纯函数：归一化（file:/// · 反斜杠 · 大小写）、保序去重 */
  eqArr(
    II.orphanImages(
      ["C:\\A\\pc_1.png", "C:/a/pc_1.png", "C:/a/pc_2.png"],
      ["file:///c:/a/PC_1.PNG"],
    ),
    ["C:/a/pc_2.png"],
    "orphanImages：归一化比对（file:/// + 反斜杠 + 大小写），已引用的出局、候选保序去重",
  );
  eqArr(II.orphanImages([], ["C:/a.png"]), [], "没有候选 = 不回收");
  eqArr(II.orphanImages(["C:/a.png"], []), ["C:/a.png"], "一处引用都没有 = 孤儿");
  /* 引用抽取：整行图行 / 行内图行 / 裸路径 */
  eqArr(
    II.imgRefsOfText("![x](C:/a/一.png)\n正文 [图](D:\\b\\二.png) 夹在句中\n见 C:/c/三.png 与 file:///E:/d/四.PNG").sort(),
    ["C:/a/一.png", "D:\\b\\二.png", "C:/c/三.png", "E:/d/四.PNG"].sort(),
    "imgRefsOfText：整行图行 / 行内图行 / 裸绝对路径都算「在用」",
  );
  eqArr(
    II.imgRefsIn({ nodes: [{ inlineImgs: [{ path: "C:/a/登记.png" }], imagePath: "C:/a/节点.png" }] }, { skipKeys: ["inlineImgs"] }),
    ["C:/a/节点.png"],
    "imgRefsIn 跳过登记表（node.inlineImgs）：登记 ≠ 引用，否则删掉的图永远退不了休",
  );
  /* 真跑一轮 GC */
  const A1 = "C:/data/assets/wf1/pc_keep.png"; /* 正文里还有 token → 保留 */
  const A2 = "C:/data/assets/wf1/pc_orphan.png"; /* 登记还在、正文 token 没了 → 回收 */
  const A3 = "C:/data/assets/wf1/pc_node_gone.png"; /* 节点已删，台账还记得 → 回收 */
  const A4 = "C:/data/assets/wf1/pc_manual.png"; /* 手放进资产目录的素材：不在台账 / 登记表 → 永不进候选 */
  const A5 = "C:/data/assets/wf1/pc_by_node.png"; /* 台账里的图被 input_image 节点引用 → 保留 */
  S.wf.nodes = [
    {
      id: "n1",
      kind: "proc_text",
      prompt: "正文还引用 @img:keep001 这张",
      inlineImgs: [{ id: "keep001", path: A1, name: "keep.png", nodeId: "n1" }],
    },
    {
      id: "n2",
      kind: "proc_text",
      prompt: "这一框已经没有 token 了",
      inlineImgs: [{ id: "orph001", path: A2, name: "orphan.png", nodeId: "n2" }],
    },
    { id: "n3", kind: "input_image", title: "输入图", imagePath: A5 },
    { id: "n4", kind: "input_image", title: "手放素材", imagePath: A4 },
  ];
  S.wf.inlineAssets = [
    { path: A1, at: 1 },
    { path: A2, at: 2 },
    { path: A3, at: 3 },
    { path: A5, at: 5 },
  ];
  S.agentSessions = [
    { id: "as1", messages: [{ role: "user", content: "旧会话引用 " + A3.replace("pc_", "pc_") }] },
  ];
  /* 先验：会话引用了 A3 → A3 保留；A2（正文 token 没了）本轮就该回收 */
  APP_CALLS.assetDeleteImages.length = 0;
  const r0 = await F.gcCanvasInlineImages({ quiet: true });
  eqArr(r0.removed, [A2], "会话消息里还引用着 A3 → 它保留；正文已无 token 的 A2 回收");
  /* 会话删掉后：A3 也失去最后一处引用 */
  S.agentSessions = [];
  APP_CALLS.assetDeleteImages.length = 0;
  const r = await F.gcCanvasInlineImages({ quiet: true });
  eqArr(r.removed, [A3], "无引用回收：只删「登记 / 台账里有 ∧ 一处引用都没有」的图");
  eqArr(
    S.wf.inlineAssets.map((e) => e.path),
    [A1, A5],
    "台账随之清掉已删条目（保留在用的两条）",
  );
  eqNum(
    (S.wf.nodes.find((n) => n.id === "n2").inlineImgs || []).length,
    0,
    "被删图的登记表条目一并清掉（不留指向不存在文件的死条目）",
  );
  eqNum((S.wf.nodes.find((n) => n.id === "n1").inlineImgs || []).length, 1, "在用图的登记表条目保留");
  ok(
    !(APP_CALLS.assetDeleteImages[0] || []).some((p) => p === A4 || p === A5 || p === A1),
    "节点引用（input_image）与手放素材都不在删除清单里",
  );
  /* 删节点：登记表随节点没了，台账还记得 → 回收 */
  const A6 = "C:/data/assets/wf1/pc_delnode.png";
  S.wf.inlineAssets.push({ path: A6, at: 6 });
  S.wf.nodes = S.wf.nodes.filter((n) => n.id !== "n2" || true);
  APP_CALLS.assetDeleteImages.length = 0;
  const r2 = await F.gcCanvasInlineImages({ quiet: true });
  eqArr(r2.removed, [A6], "删节点后：登记表没了但台账还认得 → 那张图随回收删盘");
  /* 触发点静态核对（这些路径必须真接上回收，缺一即「删了还留盘」） */
  const cap = grab(appSrc, "removePromptCapsule");
  has(cap, "gcCanvasInlineImages({ quiet: true })", "✕ 删图 → removePromptCapsule 走统一回收");
  ok(!/assetDeleteImages/.test(cap), "✕ 删图不再自己直连 assetDeleteImages（判据只有一份）");
  const del = grab(appSrc, "deleteNodes");
  has(del, "gcCanvasInlineImagesSoon();", "删节点 → 排一轮画布资产回收");
  has(del, "chatImgGcForSessions(linkedSessions)", "删节点带走的智能会话 → 回收其输入框落盘的图");
  const mount = grab(appSrc, "mountPromptTextarea");
  has(mount, "if (!has && ta._mtPromptHadText) gcCanvasInlineImagesSoon();", "清空正文框（有 → 空那一跳）→ 排回收");
  const rmLine = grab(assistSrc, "chatImgLineRemove");
  has(rmLine, "chatImgGcSoon([now.ref])", "输入框 ✕ 删行 → 回收那张图");
  const core = grab(assistSrc, "deleteAgentSessionCore");
  has(core, "chatImgSessionCandidates(list[at])", "删会话：摘掉之前先取候选（消息 + 未发的草稿）");
  has(core, "chatImgGcSoon(imgCands)", "删会话 → 回收它的内嵌图（别处还引用就保留）");
  has(grab(assistSrc, "chatImgGc"), "m.orphanImages(cands, chatImgRefs())", "输入框侧回收与画布侧同一份判据（orphanImages）");
  has(grab(assistSrc, "chatInlineImgTick"), "if (lost.length && !now.length) chatImgGcSoon(lost)", "输入框清空（最后一张图也没了）→ 回收");
  has(grab(devSrc, "devEmbedLineRemove"), "devEmbedGcSoon([now.ref])", "开发草稿框 ✕ → 回收");
  has(grab(devSrc, "devEmbedUpgrade"), "if (lost.length) devEmbedGcSoon(lost)", "开发草稿「清空草稿」→ 回收");
}

/* ═══════════ [7] 手动素材与节点引用不被误删 ═══════════ */
console.log("\n[7] 候选只认「本功能创建」：手放素材 / 用户自己的图片 / 别处产物永不被删");
{
  /* 候选集 = 台账 ∪ 登记表，不做目录扫描 → 手放素材不可能混进来 */
  S.wf.nodes = [
    { id: "m1", kind: "proc_text", prompt: "", inlineImgs: [{ id: "reg0001", path: "C:/data/assets/wf1/pc_reg.png" }] },
  ];
  S.wf.inlineAssets = [{ path: "C:/data/assets/wf1/pc_led.png", at: 1 }];
  eqArr(
    F.canvasInlineImgCandidates(),
    ["C:/data/assets/wf1/pc_led.png", "C:/data/assets/wf1/pc_reg.png"],
    "候选 = wf.inlineAssets 台账 ∪ 节点登记表（没有「扫资产目录全删」那种候选来源）",
  );
  const cand = grab(appSrc, "canvasInlineImgCandidates");
  ok(
    !/fileListDir|readDir/.test(cand),
    "候选集不做目录枚举：用户手放进资产目录的素材（不在台账 / 登记表）永不被删",
  );
  /* 节点引用保护：input_image / 生成节点 / save 节点写的路径都算「在用」 */
  const gen = "C:/data/assets/wf1/pc_gen.png";
  const saved = "C:/data/assets/wf1/pc_save.png";
  S.wf.nodes = [
    { id: "g1", kind: "proc_image", prompt: "", outputPath: gen, res: { image: gen } },
    { id: "s1", kind: "save", savePath: saved },
    { id: "i1", kind: "input_image", imagePath: "C:/data/assets/wf1/pc_in.png" },
  ];
  S.wf.inlineAssets = [
    { path: gen, at: 1 },
    { path: saved, at: 2 },
    { path: "C:/data/assets/wf1/pc_in.png", at: 3 },
  ];
  const refs = F.collectInlineImgRefs();
  ok(refs.some((p) => II.normImgPath(p) === II.normImgPath(gen)), "生成节点的产物路径算引用（结果 / outputPath）");
  ok(refs.some((p) => II.normImgPath(p) === II.normImgPath(saved)), "save 节点的落盘路径算引用");
  ok(refs.some((p) => II.normImgPath(p) === II.normImgPath("C:/data/assets/wf1/pc_in.png")), "input_image 节点的图像路径算引用");
  APP_CALLS.assetDeleteImages.length = 0;
  const r = await F.gcCanvasInlineImages({ quiet: true });
  eqArr(r.removed, [], "三类节点引用着的图一张都不删");
  eqArr(APP_CALLS.assetDeleteImages[0] || [], [], "删除清单为空（连主进程都没叫）");
  /* 输入框侧：本功能自己落的临时图才可回收 */
  ok(II.isChatInputImage("C:\\ws\\.mtnode-input\\paste-abc12.png"), "本功能落的截图（.mtnode-input/paste-*.png）可回收");
  ok(II.isChatInputImage("C:/data/chat-input/paste-zz9.png"), "数据目录 chat-input/paste-*.png 可回收");
  ok(II.isChatInputImage("C:/data/devnode-input/paste-zz9.jpg"), "devnode-input/paste-*.jpg 可回收");
  ok(!II.isChatInputImage("D:\\照片\\我的图.png"), "用户自己的图片（目录不合规）不可回收");
  ok(
    !II.isChatInputImage("C:\\ws\\.mtnode-input\\我的图.png"),
    "用户手动放进 .mtnode-input/ 的图（命名不合规）不可回收",
  );
  ok(!II.isChatInputImage("C:/ws/.mtnode-input/paste-abc12.txt"), "非图像扩展名不可回收");
  ok(II.isCanvasInlineImage("C:/data/assets/wf1/pc_x.png"), "画布内嵌图命名判据 pc_ 前缀");
  ok(!II.isCanvasInlineImage("C:/data/assets/wf1/img_gen.png"), "生成节点的产物名不合 pc_ → 不是本功能命名");
  /* 输入框侧端到端：候选 → 引用比对 → 删盘（真跑 chatImgGc） */
  const s3 = { console, I18n, toast: () => {}, S: { wf: { nodes: [] }, agentSessions: [], chatRefs: [] }, window: {} };
  s3.window = s3;
  vm.createContext(s3);
  vm.runInContext(moduleSrc, s3, { filename: "app-inline-img.js" });
  s3.api = fakeApi();
  vm.runInContext(
    extract(assistSrc, [
      "chatImgSessionRefs",
      "chatImgSessionCandidates",
      "chatImgRefs",
      "chatImgGc",
      "chatImgGcSoon",
      "chatImgGcForSessions",
      "chatImgInput",
      "CHAT_IMG_SPECS",
      "chatImgModule",
    ]),
    s3,
    { filename: "assist-gc-slices.js" },
  );
  const C = new Proxy({}, { get: (_t, k) => s3[k] });
  const chatGc = async (paths, o) => {
    const opt = o || {};
    /* 两只输入框在切片里不存在（getElementById 回 null）→ 它们的正文由「当前正文」替身列表模拟；
       开发草稿框用 querySelectorAll 的替身模拟；会话与画布节点按需喂 */
    s3.document = {
      getElementById: () => null,
      querySelectorAll: () => (opt.drafts || []).map((v) => ({ value: v })),
    };
    s3.S.wf = { id: "wf1", nodes: opt.nodes || [] };
    s3.S.agentSessions = opt.sessions || [];
    const got = [];
    s3.api = fakeApi({
      chatInputDeleteImages: async (list) => {
        got.push(list.slice());
        return { ok: true, removed: list.slice(), skipped: [], failed: [] };
      },
    });
    const r = await C.chatImgGc(paths, { quiet: true });
    return { removed: r.removed, asked: got[0] || [] };
  };
  const P1 = "C:/ws/.mtnode-input/paste-a1.png";
  const P2 = "D:/照片/用户自己的图.png";
  const P3 = "C:/ws/.mtnode-input/我的图.png";
  let out = await chatGc([P1, P2, P3], {});
  eqArr(out.asked, [P1], "输入框侧只把「本功能落的临时图」交给主进程（用户图片 / 手放图不入列）");
  eqArr(out.removed, [P1], "没有任何引用 → 删盘");
  out = await chatGc([P1], { drafts: ["正文里还写着 " + P1 + " 这一行"] });
  eqArr(out.asked, [], "输入框 / 草稿框当前正文里还有这张图 → 连主进程都不叫（保留）");
  out = await chatGc([P1], {
    sessions: [{ id: "s1", messages: [{ role: "user", content: "消息正文引用 " + P1 }] }],
  });
  eqArr(out.asked, [], "会话消息正文引用同一张图 → 保留");
  out = await chatGc([P1], { nodes: [{ id: "i1", kind: "input_image", imagePath: P1 }] });
  eqArr(out.asked, [], "画布节点引用同一张图 → 保留（输入框侧也不误删）");
}

/* ═══════════ 汇总 ═══════════ */
console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"),
);
process.exit(fails ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
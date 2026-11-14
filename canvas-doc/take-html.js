/* canvas-doc/take-html.js —— 把一条 take 生成**回放页 HTML** + 一份**可复用的回放库**（Node 侧）
 * ============================================================================
 * 一句话：take 是机器读的 JSON（画布文档时间轴 + 相机 / UI / 指针 / 壳快照），人不好直接看；
 * 这里把它和播放器打成一个 .html —— 双击（或主进程 shell.openExternal）就能在浏览器里按帧重放，
 * 不需要起应用。
 *
 * 落盘布局（都在 takes 根目录之下，<数据目录>\takes\）：
 *   _take-lib\mtnode-take.css    ← 库：应用 CSS（base / layout / canvas / …）+ 页面自己的皮，~1.7MB
 *   _take-lib\mtnode-take.js     ← 库：内核 + 播放器（core / diff / kind-icons / render / take / player），~240KB
 *   _take-lib\manifest.json      ← 库指纹（LIB_VERSION + 生成器版本 + 源码尺寸/最后修改时间）
 *   <wfId>\<takeId>.html         ← 一条录制：首帧壳 + take JSON + 引导脚本，几 KB
 *   <wfId>\<takeId>.json         ← take 真源（机器读的那一份）
 *
 * 为什么把库拆出去：播放器与样式每条录制都要用，**内联进页面**就是每条多背 ~1.9MB，而且播放器
 * 改一次就得把历史录制全部重打一遍。拆出去之后每条录制只付自己的数据，页面用相对路径引用库
 * （缺省 ../_take-lib/），整个 takes 目录一起搬走、或整段挂到网站上都能直接用 —— 库只放一份。
 * **有则忽略**：manifest 里的指纹与当前一致就一个字节都不写；对不上（应用升级过播放器 / 样式）
 * 才重建库，下次打开旧页面时 upgradeAt 会顺手把页面也升到引用库的这一版。
 *
 * 一页里有什么：
 *   ① 库外链：<link> 样式表 + <script> 播放器（相对路径，没有网络请求，file:// 直接可用）。
 *   ② 首份壳快照（take.shellTrack[0].html）：页面一开始先静态画出来，播放器起来了再交给它。
 *      快照是 body 的 outerHTML，里头带着 renderer 的 <script src> / <link>，一律剔掉 ——
 *      留着会去 <数据目录> 下找 renderer 目录，404 一片。
 *   ③ take 本体（JSON，连 shellTrack 一起）：播放器按帧 docAt → camAt → uiAt → sceneOf 重绘。
 *
 * 硬约束：
 *   · **不设体积 / 时长上限**：take 多大就嵌多大，回执里只报生成后的字节数。
 *   · 生成失败**不影响 take 本身**：这里只往外抛 { ok:false, error }，调用方原样放进回执。
 *   · 不猜 take 里没有的东西：body 的皮肤 / 主题 / 视图类由壳快照自带，这里把它们**写到页面
 *     自己的 <body> 上**（pageBodyClass）—— 应用 CSS 里这些规则一律以 body.X 起头，只挂在
 *     壳那层 div 上一条都不命中，整窗就会退回旧皮肤。画布层之外一律不补画。
 *   · 库是**派生缓存**，不是真源：删掉它最多让页面丢一次皮，下次 write / upgradeAt 会重建。
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");
const MTCanvasTake = require("./canvas-take.js");

/* take-html/5：页面里的 take JSON 先剔二进制大件（节点封面 data: URL），老页面打开时按本版重写 */
const HTML_VERSION = "take-html/5";
/* 库的契约版本：库文件的**格式 / 引导口径**变了才动它；只改样式或播放器不用动 —— 指纹（libSig）接得住 */
const LIB_VERSION = "take-lib/1";
const LIB_DIR_NAME = "_take-lib";
const LIB_CSS_NAME = "mtnode-take.css";
const LIB_JS_NAME = "mtnode-take.js";
const LIB_MANIFEST_NAME = "manifest.json";
const RENDERER_DIR = path.join(__dirname, "..", "renderer");

/** 兜底清单：renderer/style.css 解析不出来时才用（正常路径见 cssFileList） */
const CSS_FILES = [
  "css/base.css",
  "css/layout.css",
  "css/canvas.css",
  "css/components.css",
  "css/dsh-tokens.css",
  "css/assist.css",
  "css/sidebar-files.css",
  "css/theme-daylight.css",
  "css/theme-endfield.css",
];

/** 内核源码（UMD，浏览器侧可用）：顺序即依赖顺序 */
const JS_FILES = [
  "canvas-doc-core.js",
  "canvas-doc-diff.js",
  /* 种类图标（节点标题栏那颗按钮）：canvas-doc-render 的 nodeTree 在加载期按它画图标 */
  "kind-icons.js",
  "canvas-doc-render.js",
  "canvas-take.js",
  "take-player.js",
];

/** 页面自己的皮：只铺播放器与静态壳的容器，不重定义任何应用组件。
 *  它跟着库走（同一条相对路径），所以回放页本身不再有 <style>。 */
const PAGE_CSS = [
  "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;}",
  "body.take-page{display:block;position:relative;}",
  /* 首帧静态壳：播放器起来之前的画面（body.tp-live 一挂就整块让位） */
  "#tpStatic{position:fixed;left:0;top:0;right:0;bottom:0;overflow:hidden;background:#0d1016;}",
  "body.tp-live #tpStatic{display:none;}",
  /* 库探针：只有库样式表到了才 display:none —— 引导脚本靠它判断「页面与库是不是分家了」 */
  "#tpLibProbe{display:none;}",
  "#tpErr{position:fixed;left:12px;right:12px;bottom:14px;z-index:99999;padding:8px 12px;",
  "border-radius:6px;background:rgba(122,32,32,.94);color:#ffdede;",
  "font:12px/1.6 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;",
  "white-space:pre-wrap;word-break:break-all;}",
  "#tpErr[hidden]{display:none;}",
].join("");

/* ── 小工具 ─────────────────────────────────────────────────────────────── */
function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (_) {
    return "";
  }
}

/** 内联 JS：源码里出现 </script 会把 <script> 提前截断（<\\/script 在 JS 里等价） */
function jsSafe(src) {
  return String(src == null ? "" : src).replace(/<\/(script)/gi, "<\\/$1");
}

/** 内联 JSON：把 < 全转成 \u003c（壳快照里带 </script> 也不会截断），并处理行分隔符 */
function jsonSafe(v) {
  try {
    return JSON.stringify(v)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  } catch (err) {
    throw new Error("take 不能 JSON 化：" + String((err && err.message) || err));
  }
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 临时文件 + rename（与 take 落盘同一原子口径） */
async function atomicWrite(p, text) {
  const tmp = p + ".tmp" + process.pid;
  await fs.promises.writeFile(tmp, text, "utf8");
  await fs.promises.rename(tmp, p);
}

/** 应用 CSS 的实际引用清单：**从 renderer/index.html 的 <link> 与 renderer/style.css 的
 *  @import 表里读**（单一真源，顺序即层叠顺序）。手抄一份清单必然会漏：漏掉 css/deepseek.css
 *  时，抽屉在回放页里退回文档流，壳里的画布面板被挤到三分之一宽 —— 画布层再怎么落位也对不上壳。 */
function cssFileList() {
  const files = [];
  const push = (rel) => {
    const p = String(rel || "")
      .trim()
      .replace(/^\.\//, "");
    if (!p || p.indexOf("..") >= 0) return;
    if (files.indexOf(p) >= 0) return;
    try {
      if (!fs.statSync(path.join(RENDERER_DIR, p)).isFile()) return;
    } catch (_) {
      return;
    }
    files.push(p);
  };
  const importsOf = (rel) => {
    const out = [];
    const re = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g;
    let m;
    const txt = readText(path.join(RENDERER_DIR, rel));
    while ((m = re.exec(txt))) {
      const sub = String(m[1] || "")
        .trim()
        .replace(/^\.\//, "");
      /* @import 的地址相对「引用它的那份样式表」所在的目录 */
      if (/^css\/|^\w[\w.-]*\.css$/.test(sub)) out.push(path.posix.join(path.posix.dirname(rel), sub));
    }
    return out;
  };
  const html = readText(path.join(RENDERER_DIR, "index.html"));
  const re = /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = String(m[1] || "").trim();
    if (!href || /^https?:/i.test(href)) continue;
    if (/\.css$/i.test(href) && href.indexOf("/") < 0) {
      /* 聚合入口：按它自己的 @import 展开在当前位置 */
      const subs = importsOf(href);
      if (subs.length) {
        for (const s of subs) push(s);
        continue;
      }
    }
    push(href);
  }
  /* 解析不到就退回手抄表（宁可少样式，也不能出一条没有样式表的页面） */
  return files.length >= 5 ? files : CSS_FILES.slice();
}

/** 静态壳：剥掉 <script> / <link>（它们指向 renderer 的相对路径，落在数据目录下必然 404） */
function shellSafe(html) {
  return String(html == null ? "" : html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
}

/** 首份壳快照：shellTrack 里第一条带 html 的（没有就空 —— 页面照样能放，只是没有壳背景） */
function firstShellOf(take) {
  const arr = (take && take.shellTrack) || [];
  for (const e of arr) {
    if (e && typeof e.html === "string" && e.html) return e.html;
  }
  return "";
}

/** 页面 <body> 的类：take-page（页面自己的皮）+ 壳快照记下的 body 钩子
 *  （ef-skin / theme-* / view-*）。钩子必须落在**真正的 body** 上 —— 应用 CSS 里它们一律以
 *  body.X 起头，挂在壳里那层 div 上一条都不命中，于是顶栏 / 侧栏 / 状态栏 / 面板全退回
 *  ef-skin 之前的旧样式（解析口径见 canvas-take.shellBodyClassOf）。
 *  ef-skin 无条件补齐：回放页只走新皮肤这一条路，**不再保留旧样式的退路** —— 缺了钩子的
 *  老 take / 没有壳的 take，也照样按新皮肤画，而不是画成旧界面。 */
function pageBodyClass(shellHtml) {
  const hooks = MTCanvasTake.shellBodyClassOf(shellHtml).slice();
  if (hooks.indexOf("ef-skin") < 0) hooks.unshift("ef-skin");
  return ["take-page"].concat(hooks).join(" ");
}

/* ── 库：内容 ─────────────────────────────────────────────────────────────── */

/** 库样式表正文：应用 CSS（按 style.css 的层叠顺序）+ 页面自己的皮 */
function libCssText() {
  const parts = cssFileList().map((rel) => {
    const txt = readText(path.join(RENDERER_DIR, rel));
    /* @charset 只能待在样式表首行，拼进同一份里就是非法声明 */
    return "/* " + rel + " */\n" + txt.replace(/^\s*@charset[^;]*;/i, "");
  });
  parts.push("/* take-page */\n" + PAGE_CSS);
  return parts.join("\n");
}

/** 库脚本正文：内核 + 播放器（顺序即依赖顺序） */
function libJsText() {
  return JS_FILES.map((rel) => {
    const txt = readText(path.join(__dirname, rel));
    if (!txt) throw new Error("读不到内核源码：" + rel);
    return "/* " + rel + " */\n" + jsSafe(txt);
  }).join("\n");
}

/** 库指纹：源码清单的「尺寸和 + 最后修改时间」。应用升级过样式 / 播放器就会变，
 *  用它判「有则忽略」—— 比手写版本号靠得住（改内核没人会记得去加版本号）。 */
function libSig() {
  const files = cssFileList()
    .map((rel) => path.join(RENDERER_DIR, rel))
    .concat(JS_FILES.map((rel) => path.join(__dirname, rel)));
  let size = 0;
  let mtime = 0;
  for (const p of files) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return "";
      size += st.size;
      mtime = Math.max(mtime, Math.round(st.mtimeMs));
    } catch (_) {
      return "";
    }
  }
  return files.length + "-" + size + "-" + mtime;
}

/** 库的现状：want = 现在这份应用该有的指纹；present = 盘上那份已经是它 */
function libStateOf(root) {
  const dir = path.join(String(root || ""), LIB_DIR_NAME);
  const cssPath = path.join(dir, LIB_CSS_NAME);
  const jsPath = path.join(dir, LIB_JS_NAME);
  const manPath = path.join(dir, LIB_MANIFEST_NAME);
  const want = { v: LIB_VERSION, html: HTML_VERSION, sig: libSig() };
  let man = null;
  try {
    man = JSON.parse(readText(manPath) || "null");
  } catch (_) {
    man = null;
  }
  const present = !!(
    man &&
    want.sig &&
    man.v === want.v &&
    man.html === want.html &&
    man.sig === want.sig &&
    fs.existsSync(cssPath) &&
    fs.existsSync(jsPath)
  );
  return { dir, cssPath, jsPath, manPath, want, present, manifest: man };
}

/* 同一进程内的库写入串成一条链：两条 take 同时收尾时写的是同一份内容，谁后写谁赢，
   但绝不许两条同时 rename（会撞临时文件名 / 互相读到半截） */
let libChain = Promise.resolve();

async function writeLibFiles(st, css, js, man) {
  try {
    await fs.promises.mkdir(st.dir, { recursive: true });
    await atomicWrite(st.cssPath, css);
    await atomicWrite(st.jsPath, js);
    /* manifest 最后写：它是「库已就绪」的凭据，先写它会让半截库被当成完整的 */
    await atomicWrite(st.manPath, JSON.stringify(man, null, 2) + "\n");
    return { ok: true, created: true, dir: st.dir, bytes: man.css + man.js, version: LIB_VERSION, sig: man.sig };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 保证 <root>/_take-lib 是当前这份应用该有的库：**没有就建，有（指纹一致）就一个字节都不写**。
 * @param {string} root takes 根目录
 * @param {object} [opts] { force:true 无视指纹重建 }
 * @returns {Promise<{ ok:boolean, created?:boolean, dir?:string, bytes?:number, version?:string, error?:string }>}
 */
async function ensureLib(root, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const r = String(root || "");
  if (!r) return { ok: false, error: "缺 takes 根目录" };
  const st = libStateOf(r);
  if (!st.want.sig) return { ok: false, error: "读不到内核源码 / 样式表（回放库建不起来）" };
  if (st.present && !o.force) {
    return { ok: true, created: false, dir: st.dir, bytes: 0, version: LIB_VERSION, sig: st.want.sig };
  }
  let css = "";
  let js = "";
  try {
    css = libCssText();
    js = libJsText();
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  const man = {
    v: st.want.v,
    html: st.want.html,
    sig: st.want.sig,
    css: Buffer.byteLength(css),
    js: Buffer.byteLength(js),
    at: new Date().toISOString(),
  };
  const job = libChain.then(
    () => writeLibFiles(st, css, js, man),
    () => writeLibFiles(st, css, js, man),
  );
  libChain = job.then(
    () => null,
    () => null,
  );
  return job;
}

/** 回放页 → 库 的相对地址（正斜杠；同目录时补 "./"，浏览器里当相对 URL 用） */
function libRelOf(htmlPath, root) {
  const rel = path
    .relative(path.dirname(String(htmlPath)), path.join(String(root), LIB_DIR_NAME))
    .split(path.sep)
    .join("/");
  if (!rel) return "./" + LIB_DIR_NAME;
  return /^\.{1,2}\//.test(rel) ? rel : "./" + rel;
}

/**
 * 纯函数：take → 整页 HTML（页面本身只带壳 + take JSON + 引导；播放器与样式在库里）。
 * @param {object} take
 * @param {object} [meta] { wfId, takeId, libRel, libSig } —— libRel = 页面到库的相对目录
 *   （缺省 ../_take-lib），libSig = 库指纹（缺省现算，只用于给库地址加防缓存查询串）
 * @returns {{ ok:boolean, html?:string, bytes?:number, error?:string, version?:string }}
 */
function buildHtml(take, meta) {
  try {
    if (!take || typeof take !== "object") return { ok: false, error: "缺 take 对象" };
    const m = meta && typeof meta === "object" ? meta : {};
    /* 播放器要求 docTrack 至少一份 keyframe：没有就让调用方知道（而不是生成一条空页） */
    if (!Array.isArray(take.docTrack) || !take.docTrack.length)
      return { ok: false, error: "take.docTrack 为空（至少要有一份 keyframe）" };

    const libRel = String(m.libRel == null ? "../" + LIB_DIR_NAME : m.libRel)
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    /* 库地址带指纹查询串：整段挂到网站上时，应用升级过播放器 / 样式后浏览器不会拿旧缓存凑数
       （file:// 打开同样认这个查询串） */
    const sig = String(m.libSig == null ? libSig() : m.libSig || "");
    const ver = sig ? "?v=" + encodeURIComponent(sig) : "";
    const cssHref = (libRel || ".") + "/" + LIB_CSS_NAME + ver;
    const jsHref = (libRel || ".") + "/" + LIB_JS_NAME + ver;

    /* 页面里的 take JSON 同样先剔二进制大件（canvas-take.stripBinary，与录制侧同一份口径）：
       节点封面这类 data: URL 播放器一个像素都不画，留着每条页面就多背 1.28MB 量级。 */
    const takeJson = jsonSafe(MTCanvasTake.stripBinary(take, 8));
    const shell = shellSafe(firstShellOf(take));
    const wfName = String(take.wfName || take.wfId || "");
    const title = "MTNode take · " + (wfName ? wfName + " · " : "") + String(take.id || "");

    /* 引导：库到了就播，没到就把「缺库」明说出来（静态壳还在，至少能看见画布长什么样） */
    const boot = [
      "/** boot：有播放器就播，没有就把错误摆出来（先判库样式表探针，再判播放器） */",
      "(function () {",
      "  var errEl = document.getElementById('tpErr');",
      "  function fail(msg) {",
      "    if (!errEl) return;",
      "    errEl.textContent = '这段录制没能播放：' + msg;",
      "    errEl.hidden = false;",
      "  }",
      "  var probe = document.getElementById('tpLibProbe');",
      "  if (probe && window.getComputedStyle && window.getComputedStyle(probe).display !== 'none') {",
      "    fail('缺回放库样式表（' + " + JSON.stringify(cssHref) + " + '）—— 回放页要与 " + LIB_DIR_NAME + " 目录一起搬');",
      "    return;",
      "  }",
      "  if (!window.MTCanvasTakePlayer) {",
      "    fail('缺播放器库（' + " + JSON.stringify(jsHref) + " + '）');",
      "    return;",
      "  }",
      "  try {",
      "    var take = JSON.parse(document.getElementById('tpTake').textContent || '{}');",
      "    var player = window.MTCanvasTakePlayer.create({",
      "      take: take,",
      "      host: document.body,",
      "      autoplay: true,",
      "      loop: false,",
      "      maxScale: 1",
      "    });",
      "    document.body.classList.add('tp-live');",
      "    window.MTTakePage = { take: take, player: player };",
      "  } catch (err) {",
      "    fail((err && err.message) || String(err));",
      "  }",
      "})();",
    ].join("\n");

    const html = [
      "<!DOCTYPE html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<meta name="generator" content="MTNode ' + HTML_VERSION + '">',
      '<meta name="mtnode-lib" content="' + escHtml(LIB_DIR_NAME + "/" + LIB_VERSION) + '">',
      "<title>" + escHtml(title) + "</title>",
      /* 库：应用样式 + 页面皮（与页面的相对位置见 libRel，页面本身没有 <style>） */
      '<link rel="stylesheet" id="mt-take-lib-css" href="' + escHtml(cssHref) + '">',
      "</head>",
      '<body class="' + escHtml(pageBodyClass(shell)) + '">',
      /* 首帧静态壳（播放器起来后由 body.tp-live 收起） */
      '<div id="tpStatic" class="tp-static-shell">',
      shell,
      "</div>",
      /* 库样式表到没到：只有库在它才 display:none（引导脚本拿它当探针） */
      '<div id="tpLibProbe" aria-hidden="true"></div>',
      '<div id="tpErr" role="alert" hidden></div>',
      '<script type="application/json" id="tpTake">',
      takeJson,
      "</script>",
      '<script id="mt-take-lib-js" src="' + escHtml(jsHref) + '"></script>',
      "<script>",
      boot,
      "</script>",
      "</body>",
      "</html>",
      "",
    ].join("\n");

    return { ok: true, html, bytes: Buffer.byteLength(html, "utf8"), version: HTML_VERSION };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** 路径段是否安全（wfId / takeId 来自渲染层，主进程那侧已经 safeId 过一道） */
function segOk(s) {
  const v = String(s == null ? "" : s);
  return !!v && v !== "." && v !== ".." && !/[\\/]/.test(v) && v.length <= 120;
}

/**
 * 生成并落盘：先保证库在（<root>\_take-lib，有则忽略），再写 <root>\<wfId>\<takeId>.html。
 * @param {object} take take 对象
 * @param {object} opts { root, wfId, takeId, force } —— root 必填（主进程传 takesRoot()）
 * @returns {Promise<{ ok:boolean, path?:string, bytes?:number, lib?:object, error?:string }>}
 */
async function write(take, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const root = String(o.root || "");
  const wfId = String(o.wfId || (take && take.wfId) || "");
  const takeId = String(o.takeId || (take && take.id) || "");
  if (!root) return { ok: false, error: "缺 takes 根目录" };
  if (!segOk(wfId) || !segOk(takeId)) return { ok: false, error: "非法 wfId / takeId" };
  const p = path.join(root, wfId, takeId + ".html");
  /* 库先在：页面只剩数据，缺库就是一只没皮没播放器的空壳（宁可不写，也不要一条打不开的页） */
  const lib = await ensureLib(root, o);
  if (!lib.ok) return { ok: false, error: "回放库写入失败：" + String(lib.error || "") };
  const built = buildHtml(take, { wfId, takeId, libRel: libRelOf(p, root), libSig: lib.sig });
  if (!built.ok) return built;
  try {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await atomicWrite(p, built.html);
    return {
      ok: true,
      path: p,
      bytes: built.bytes,
      lib: { dir: lib.dir, created: !!lib.created, bytes: lib.bytes || 0, version: lib.version || LIB_VERSION },
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 把一条**已经落盘**的回放页按当前生成器 / 当前库升级一次（打开前顺手跑）。
 * 什么时候需要：① 旧生成器（take-html/1..4）把样式与播放器内联进页面、或把节点封面这类
 * base64 大件整份塞进 take JSON —— 每条录制白背 1.9MB / 1.28MB 那一档，且老页面根本没引用库；② 库被删了、或应用升级过播放器 / 样式（指纹对不上）。
 * take 的 .json 才是真源、html 只是派生物，同目录同名 json 还在，就重写这一只即可，不必重录。
 * 失败**不影响打开**：调用方拿到 { ok:false, error } 记一行日志，旧页面照开。
 * @param {string} absPath 回放页绝对路径（<takes>\<wfId>\<takeId>.html）
 * @param {object} opts { root } —— root 必填（takesRoot()）
 * @returns {Promise<{ ok:boolean, upgraded:boolean, bytes?:number, lib?:object, error?:string }>}
 */
async function upgradeAt(absPath, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const abs = String(absPath || "");
  const root = String(o.root || "");
  if (!abs || !root) return { ok: false, upgraded: false, error: "缺 take html 路径或 takes 根目录" };
  try {
    /* 生成器标记在 <head> 最前面几行：读前 4KB 就够，不必把几十 MB 整只读进来。
       标记里没有版本号的老文件（"MTNode take-html"）一律当旧的算。 */
    let head = "";
    const fh = await fs.promises.open(abs, "r");
    try {
      const buf = Buffer.alloc(4096);
      const r = await fh.read(buf, 0, 4096, 0);
      head = buf.slice(0, r.bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
    const gen = (/<meta name="generator" content="MTNode (take-html\/\d+)">/.exec(head) || [])[1] || "";
    /* 页面引用的库也必须是当前这份：库被删 / 应用升级过 → 一起重建（ensureLib 在 write 里） */
    if (gen === HTML_VERSION && libStateOf(root).present) return { ok: true, upgraded: false };
    const jsonPath = abs.replace(/\.html$/i, ".json");
    const take = JSON.parse(await fs.promises.readFile(jsonPath, "utf8"));
    const w = await write(take, {
      root,
      wfId: path.basename(path.dirname(abs)),
      takeId: path.basename(abs).replace(/\.html$/i, ""),
    });
    if (w && w.ok) return { ok: true, upgraded: true, bytes: w.bytes || 0, lib: w.lib };
    return { ok: false, upgraded: false, error: (w && w.error) || "take html 重写失败" };
  } catch (err) {
    return { ok: false, upgraded: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  VERSION: HTML_VERSION,
  LIB_VERSION,
  LIB_DIR_NAME,
  LIB_CSS_NAME,
  LIB_JS_NAME,
  CSS_FILES,
  JS_FILES,
  buildHtml,
  ensureLib,
  libRelOf,
  libStateOf,
  write,
  upgradeAt,
};

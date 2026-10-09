"use strict";
/* 画布渲染的装载期安全（TDZ）回归冒烟测试 —— 纯 Node，不依赖 Electron
 *   node test/smoke-canvas-boot-tdz.js
 *
 * 真实事故（用户报「修复后所有画布都渲染不出节点」）：
 *   app-canvas.js 顶层执行到后半段才 `const NODE_BROWSE_KINDS = new Set([...])`，
 *   而第一条使用它的路径是文件更靠前的 nodeElement（nodeBrowseMode → nodeBrowseKind）。
 *   顶层执行一旦被打断（上一支脚本 app.js 在装载期触发了 renderCanvas、或本文件后面的
 *   顶层代码抛错 / 被调试器暂停），这条 const 就停在 TDZ（暂时性死区），此刻任何一次
 *   整屏重绘都会抛
 *     ReferenceError: Cannot access 'NODE_BROWSE_KINDS' before initialization
 *   从 autoSaveSaves → renderCanvas → mountNodeEl → nodeElement 一路冒到 window，结果就是
 *   **所有画布上所有节点都画不出来**（错误日志里 7 条同一堆栈）。
 *
 * 第二次事故（同一个坑、第二个受害者，用户截图报的就是它）：
 *   app-canvas.js 里 `registerNodeSettingsForm("breeze_gen", { summary: breezeGenParamSummaryText, ... })`
 *   在**顶层求值**时就取了字，而 breezeGenParamSummaryText 定义在 app-nodes.js（index.html 里
 *   排在 app-canvas.js **之后**）→ 装载期 `ReferenceError: breezeGenParamSummaryText is not defined`
 *   → 顶层执行在那一行整段中断 → 后面 7495 的 `const NODE_BROWSE_BODY = {}` 永久停在 TDZ →
 *   每次渲染都报 `Cannot access 'NODE_BROWSE_BODY' before initialization`（app-canvas.js:7499），
 *   画布上所有节点都画不出来；连带损失还有浏览态 body 全部注册（8066+）、`mtnode:file-saved`
 *   监听（10862 附近）、browseWheelRouterOn / FN_SCAFFOLD_ID_RE / _imageMetaCache 三条后置 const。
 *   证据：%APPDATA%\pipeline-console\pipeline-console\logs\error.log（2026-10-07T07:37 起，
 *   init(app-boot.js) → renderAll(app-settings.js) → renderCanvas → nodeElement → buildBody
 *   → buildBrowseBody@7499 的完整栈）。
 *
 * 要钉住的口径（一起满足才叫修好）：
 *   [1] 两条浏览态声明（NODE_BROWSE_KINDS / NODE_BROWSE_BODY）都在 app-canvas.js 的**最前面**
 *       （早于第一条使用它们的路径），且各自只声明一次；
 *   [2] nodeBrowseKind / buildBrowseBody 都带兜底 try/catch：装载期被调到也只会退回「编辑形态」，
 *       绝不把异常抛给调用方（画布渲染不再能被这一条炸掉）；
 *   [3] 行为级验证：把集合 / 登记表与两个判定函数切出来在 vm 里真跑一遍 —— 有表时按 kind 判定；
 *       把表抽掉（模拟 TDZ / 未初始化）时返回 false 而不抛；
 *   [4] 根因口径（第二次事故的病根）：app-canvas.js 的**顶层执行不得引用后加载文件里的绑定**。
 *       做法：在 vm 里真跑 app-canvas.js 的顶层（未定义标识符一律记名不抛），跑完再逐条读那些
 *       后置 const —— 顶层半途中断会当场表现为「const 读出来是 TDZ」；而顶层引用到的名字只要
 *       定义在 index.html 里排在 app-canvas.js 之后的脚本里，就直接判失败并点名是哪个文件。
 *   [5] 顺序依赖提醒：index.html 里 app.js 必须排在 app-canvas.js 之前（app.js 装载期的
 *       重绘会先撞上 app-canvas.js 的函数，这正是第一次事故的触发面）。
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

const jsCanvas = read("renderer/app-canvas.js");
const html = read("renderer/index.html");

/* 取 `const NODE_BROWSE_KINDS = new Set([...]);` 整句（含结尾分号） */
function browseSetSource(src) {
  const at = src.indexOf("const NODE_BROWSE_KINDS");
  if (at < 0) return "";
  const end = src.indexOf("]);", at);
  if (end < 0) return "";
  return src.slice(at, end + 3);
}
/* 取单行 const 声明原文（如 `const NODE_BROWSE_BODY = {};`） */
function constLine(src, name) {
  const m = src.match(new RegExp("^const " + name + " =.*$", "m"));
  return m ? m[0] : "";
}
/* 按函数签名取函数体（连同签名），花括号配平 */
function funcSource(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (!depth) return src.slice(at, i + 1);
    }
  }
  return "";
}
/* index.html 的脚本加载顺序（= 模块分层），以及 app-canvas.js 之后加载的那些文件 */
const SCRIPT_ORDER = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const AFTER_CANVAS = SCRIPT_ORDER.slice(SCRIPT_ORDER.indexOf("app-canvas.js") + 1).filter((f) =>
  f.endsWith(".js"),
);
/* 某文件里顶层声明的名字（function / const / let / var，行首 = 顶层） */
const _nameCache = new Map();
function globalNamesOf(file) {
  if (_nameCache.has(file)) return _nameCache.get(file);
  const set = new Set();
  let src = "";
  try {
    src = read("renderer/" + file);
  } catch (_) {
    src = "";
  }
  for (const m of src.matchAll(
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    set.add(m[1] || m[2]);
  }
  _nameCache.set(file, set);
  return set;
}

console.log("\n[1] kind 集合声明在本文件最前面（装载期安全）");
{
  const decl = jsCanvas.indexOf("const NODE_BROWSE_KINDS");
  const firstUse = jsCanvas.indexOf("NODE_BROWSE_KINDS.has");
  ok(decl > 0, "app-canvas.js 声明了 NODE_BROWSE_KINDS 集合");
  ok(
    (jsCanvas.match(/const NODE_BROWSE_KINDS/g) || []).length === 1,
    "只声明一次（重复声明会让同一全局词法环境里的旧绑定进 TDZ，正是本事故的形态）",
  );
  ok(firstUse > decl, "唯一的使用点排在声明之后");
  /* 声明必须在文件前 2%（≈ 前 280 行）：早于任何可能被打断的顶层代码，
     也早于 nodeElement（≈4800 行）等全部使用路径 */
  ok(decl < jsCanvas.length * 0.02, "声明落在文件最前面的 2% 以内（实测 offset " + decl + "）");
  ok(
    /NODE_BROWSE_KINDS[\s\S]{0,400}?test\/smoke-canvas-boot-tdz\.js/.test(jsCanvas),
    "声明处写明本回归脚本，改动者能顺着注释找到口径",
  );
}

console.log("\n[2] 浏览态 body 登记表同样声明在最前面（第二次事故的受害者）");
{
  const decl = jsCanvas.indexOf("const NODE_BROWSE_BODY");
  const firstRead = jsCanvas.indexOf("NODE_BROWSE_BODY[nodeBrowseKindKey(node)]");
  const firstAssign = jsCanvas.search(/^NODE_BROWSE_BODY\./m);
  ok(decl > 0, "app-canvas.js 声明了 NODE_BROWSE_BODY 登记表");
  ok(
    (jsCanvas.match(/^const NODE_BROWSE_BODY = /gm) || []).length === 1,
    "只声明一次（同一全局词法环境里重复声明会让旧绑定进 TDZ）",
  );
  ok(firstRead > decl, "buildBrowseBody 的取表点排在声明之后");
  ok(firstAssign > decl, "各 kind 的登记点（NODE_BROWSE_BODY.xxx = …）排在声明之后");
  ok(
    decl < jsCanvas.length * 0.02,
    "声明落在文件最前面的 2% 以内（实测 offset " + decl + "）",
  );
}

console.log("\n[3] nodeBrowseKind 兜底：装载期被调到也不抛");
{
  const body = funcSource(jsCanvas, "function nodeBrowseKind(n)");
  ok(!!body, "nodeBrowseKind 存在");
  ok(/try\s*\{/.test(body) && /catch/.test(body), "函数体带 try/catch 兜底");
  ok(
    /catch[\s\S]{0,80}?return false/.test(body),
    "兜底返回 false = 退回编辑形态（宁可少一层浏览态，也不能让画布画不出来）",
  );
}

console.log("\n[4] buildBrowseBody 兜底：取表异常 / 登记表缺位都不抛");
{
  const body = funcSource(jsCanvas, "function buildBrowseBody(node, body)");
  ok(!!body, "buildBrowseBody 存在");
  ok(
    /try\s*\{[\s\S]{0,120}?NODE_BROWSE_BODY\[[\s\S]{0,80}?catch[\s\S]{0,80}?return false/.test(body),
    "取表这一句带 try/catch，异常即 return false（回落编辑态）",
  );
}

console.log("\n[5] 行为级：表可用时按 kind 判定，表不可用（模拟 TDZ）时不抛");
{
  const setSrc = browseSetSource(jsCanvas);
  const bodySrc = constLine(jsCanvas, "NODE_BROWSE_BODY");
  const keyFn = funcSource(jsCanvas, "function nodeBrowseKindKey(n)");
  const kindFn = funcSource(jsCanvas, "function nodeBrowseKind(n)");
  const buildFn = funcSource(jsCanvas, "function buildBrowseBody(node, body)");
  ok(
    !!setSrc && !!bodySrc && !!keyFn && !!kindFn && !!buildFn,
    "五块源码都可切片（回归脚本与产品同源）",
  );

  const ctx = vm.createContext({ isSaveKind: (k) => k === "save_text" || k === "save" });
  /* 正常装载：集合存在 */
  vm.runInContext(setSrc + "\n" + keyFn + "\n" + kindFn, ctx);
  ok(vm.runInContext("nodeBrowseKind({ kind: 'proc_text' })", ctx) === true, "proc_text 参与浏览态");
  ok(vm.runInContext("nodeBrowseKind({ kind: 'super' })", ctx) === false, "super 不参与（恒编辑形态）");
  ok(vm.runInContext("nodeBrowseKind({ kind: 'save_text' })", ctx) === true, "旧别名 save_text 归一后参与");
  ok(vm.runInContext("nodeBrowseKind(null)", ctx) === false, "空节点不抛也不参与");

  /* 打断装载：集合这一句没执行到（TDZ / 未定义）→ 只准返回 false */
  const ctx2 = vm.createContext({ isSaveKind: (k) => k === "save_text" });
  vm.runInContext(keyFn + "\n" + kindFn, ctx2);
  let threw = "";
  let val = null;
  try {
    val = vm.runInContext("nodeBrowseKind({ kind: 'proc_text' })", ctx2);
  } catch (e) {
    threw = (e && e.message) || String(e);
  }
  ok(threw === "", "集合缺失时不抛：" + (threw || "无异常"));
  ok(val === false, "集合缺失时返回 false（退回编辑形态，画布照常渲染）");

  /* 登记表缺失（= 装载期中断、const 停在 TDZ 的等价形态）→ buildBrowseBody 必须静默回落 */
  const ctx3 = vm.createContext({
    isSaveKind: (k) => k === "save_text",
    bindNodeBrowseWheel: () => {},
  });
  vm.runInContext(keyFn + "\n" + buildFn, ctx3);
  let threw3 = "";
  let val3 = null;
  try {
    val3 = vm.runInContext("buildBrowseBody({ kind: 'proc_text' }, {})", ctx3);
  } catch (e) {
    threw3 = (e && e.message) || String(e);
  }
  ok(threw3 === "", "登记表缺失时 buildBrowseBody 不抛：" + (threw3 || "无异常"));
  ok(val3 === false, "登记表缺失时 buildBrowseBody 返回 false（回落编辑态渲染）");

  /* 登记表在、但该 kind 没登记 → 同样回落，且不去碰浏览态滚轮（此时 body 还是空的） */
  const ctx4 = vm.createContext({
    isSaveKind: (k) => k === "save_text",
    bindNodeBrowseWheel: () => {
      throw new Error("不该走到滚轮兜底");
    },
  });
  vm.runInContext(bodySrc + "\n" + keyFn + "\n" + buildFn, ctx4);
  let threw4 = "";
  let val4 = null;
  try {
    val4 = vm.runInContext("buildBrowseBody({ kind: 'proc_text' }, {})", ctx4);
  } catch (e) {
    threw4 = (e && e.message) || String(e);
  }
  ok(threw4 === "", "未登记 kind 不抛：" + (threw4 || "无异常"));
  ok(val4 === false, "未登记 kind 返回 false（回落编辑态渲染）");
}

console.log("\n[6] 装载期真跑：app-canvas.js 的顶层必须跑得完，且不引用后加载文件的绑定");
{
  /* 任何未定义的标识符都不让它抛 ReferenceError，而是记下名字并回一个「万能代理」——
     这样顶层一定能跑到底；真正的雷（名字定义在后面的脚本里）从记录里点名，
     而「顶层半途中断」则表现为下面逐条读后置 const 时读出 TDZ。 */
  function anything(name) {
    const f = function () {};
    return new Proxy(f, {
      get(t, p) {
        if (p === "then" || p === Symbol.iterator) return undefined;
        if (p === Symbol.toPrimitive || p === "toString") return () => "";
        return anything(name + "." + String(p));
      },
      apply() {
        return anything(name + "()");
      },
      construct() {
        return anything("new " + name);
      },
      set() {
        return true;
      },
      has() {
        return true;
      },
    });
  }
  const seen = new Map();
  const base = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    document: anything("document"),
    navigator: anything("navigator"),
    localStorage: anything("localStorage"),
    performance: anything("performance"),
    location: anything("location"),
    history: anything("history"),
  };
  const g = new Proxy(base, {
    has: () => true,
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === "string") seen.set(p, (seen.get(p) || 0) + 1);
      return anything(String(p));
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
  base.window = g;
  base.globalThis = g;
  const ctx = vm.createContext(g);

  let err = null;
  try {
    vm.runInContext(jsCanvas, ctx, { filename: "app-canvas.js" });
  } catch (e) {
    err = e;
  }
  ok(!err, "顶层跑到底无抛错" + (err ? "：" + ((err && err.message) || err) : ""));

  /* 顶层中断 ⇒ 这几条后置绑定会停在 TDZ，读它们直接抛「Cannot access … before initialization」 */
  const tail = [
    "NODE_BROWSE_BODY", // 7495 附近：第二次事故的受害者
    "browseWheelRouterOn", // 7603 附近
    "FN_SCAFFOLD_ID_RE", // 8708 附近
    "_imageMetaCache", // 13509 附近
  ];
  const tdz = [];
  for (const name of tail) {
    let t = "";
    try {
      t = vm.runInContext("typeof " + name, ctx);
    } catch (e) {
      t = "TDZ: " + ((e && e.message) || e);
    }
    if (/^(object|function|string|number|boolean|symbol|bigint|undefined)$/.test(t) === false) {
      tdz.push(name + " → " + t);
    }
  }
  ok(
    tdz.length === 0,
    "顶层中途没被中断：后置 const 都已初始化（NODE_BROWSE_BODY 等 " +
      tail.length +
      " 条）" +
      (tdz.length ? "：" + tdz.join("；") : ""),
  );
  ok(
    (() => {
      try {
        return vm.runInContext("typeof NODE_BROWSE_BODY", ctx) === "object";
      } catch (_) {
        return false;
      }
    })(),
    "NODE_BROWSE_BODY 装载后是对象（浏览态登记表就位）",
  );

  /* 顶层引用到的名字里，凡是「定义在 index.html 排在 app-canvas.js 之后的脚本」里的 → 点名失败 */
  const landmines = [];
  for (const name of seen.keys()) {
    const owner = AFTER_CANVAS.find((f) => globalNamesOf(f).has(name));
    if (owner) landmines.push(name + "（定义在后加载的 " + owner + "）");
  }
  ok(
    landmines.length === 0,
    "顶层不引用后加载文件的绑定" +
      (landmines.length ? "：" + landmines.join("；") : "（后加载文件共 " + AFTER_CANVAS.length + " 支）"),
  );

  /* 事故原型就此钉死：breeze_gen 的 summary 必须是调用期取（裸标识符 = 装载期取字 = 顶层中断） */
  ok(
    !/summary:\s*breezeGenParamSummaryText\s*,/.test(jsCanvas),
    "breeze_gen 的 summary 不再裸写标识符（那是装载期中断的原型）",
  );
}

console.log("\n[7] 触发面：index.html 脚本顺序");
{
  const iApp = html.indexOf('<script src="app.js"></script>');
  const iCanvas = html.indexOf('<script src="app-canvas.js"></script>');
  ok(iApp > 0 && iCanvas > 0, "两支脚本都在 index.html 里");
  ok(iApp < iCanvas, "app.js 排在 app-canvas.js 之前（app.js 装载期的重绘会先撞上画布函数）");
  ok(
    html.indexOf("app-nodeview.js") > 0 && html.indexOf("app-nodeview.js") < iCanvas,
    "app-nodeview.js 排在 app-canvas.js 之前（浏览态视图生成器）",
  );
  ok(
    /顶层执行[\s\S]{0,600}?smoke-canvas-boot-tdz\.js/.test(html.slice(Math.max(0, iCanvas - 900), iCanvas)),
    "app-canvas.js 的加载处写明「顶层不得引用后加载文件的绑定」并指向本回归脚本",
  );
}

console.log("");
if (fails) {
  console.log("✗ " + fails + " / " + checks + " 项失败  (smoke-canvas-boot-tdz)");
  process.exit(1);
}
console.log("✓ " + checks + " 项全部通过  (smoke-canvas-boot-tdz)");

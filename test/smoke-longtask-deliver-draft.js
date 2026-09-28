"use strict";
/**
 * test/smoke-longtask-deliver-draft.js —— 交付清单输入「写完移开焦点即被清空」回归（本轮需求本体）
 *   node test/smoke-longtask-deliver-draft.js
 *
 * 缺陷：长任务右栏交付卡里把一条内容写完（文本条目 / 文件名 / 说明），鼠标一移到别处
 * （点到画布上、点另一格、切一下画布），刚写的那段字当场没了 —— 恶性数据丢失。
 *
 * 根因不是「失焦丢焦点」，是**同一份交付清单在代码里有好几份拷贝**：
 *   ① 卡片渲染读的那一份 = run 快照 st.items（缺省回落图定义 node.cfg.items）；
 *   ② 画布侧同步链（app-longtask.js 的 ltDeliverSyncFromNode）的权威 = **画布上那颗交付节点
 *      的 ltItems** —— 「移开焦点」触发的画布联动、自动收线（ltAutoCollectSoon）、重开 / 切画布
 *      都会走一次，把节点上那份旧清单整份推回运行态与图定义；
 *   ③ 而卡片提交（change = 失焦那一刻，或 blur 后的回车）原本只写了 ①②，**从没写过节点那一份**。
 * 于是：用户写完 → 失焦 → 画布同步一次 → 旧清单盖回来 → 输入框照条目里的值重新长出来就是空的。
 *
 * 规则要保住的行为（本文件就是它的回归口径）：
 *   [1] 机制就位：ltItemDraftKey（环节路径 + 条目 id + 字段名）+ 每格 guard（ltDraftBind / ltScrollBind）
 *   [2] 提交即三份写同源、写同步：运行态 st.items / 图定义 node.cfg.items / 画布节点 ltItems，
 *       提交成功后才清本帧草稿
 *   [3] 真跑 ltChecklistEditor：打字 → change → 三份都拿到那段字；再模拟同步链推回旧清单
 *       → 新长出来的输入框里那段字仍在（验收口径）
 *   [4] 兜底那一路也真跑：写完**还没提交**就被重绘换掉 → 按草稿键还原（不靠提交链也不丢字）
 *   [5] 文件名 / 内容说明两格同样吃保护；老调用处（只传 7 个参数）行为一字不变
 *
 * 只读断言对源码 + vm 真跑；不起 Electron、不碰真实 %APPDATA%、不写任何文件。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

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
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
};
const eqStr = (a, b, msg) => ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

const LTV = read("renderer/app-longtask.js");
const LTU = read("renderer/app-longtask-ui.js");

/* 取一个函数的正文：从 `function 名(` 起到**下一个顶层 `function` 声明**（列 0 起）之前。
   不比括号 —— 函数体里带注释 / 模板串 / 正则，逐字符数括号容易提前收口（本文件踩过）。 */
function fnBody(src, name) {
  const at = src.indexOf("\nfunction " + name + "(");
  if (at < 0) throw new Error("找不到函数：" + name);
  const next = src.indexOf("\nfunction ", at + 1);
  return src.slice(at + 1, next < 0 ? src.length : next);
}

/* ── 迷你 DOM：够 ltChecklistEditor / ltItemInput 真跑（value / 事件 / 属性 / 尺寸） ── */
function mkEl(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    value: "",
    checked: false,
    disabled: false,
    rows: 0,
    placeholder: "",
    title: "",
    type: "",
    name: "",
    textContent: "",
    style: {},
    children: [],
    parentNode: null,
    attrs: {},
    handlers: {},
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] == null ? null : this.attrs[k];
    },
    addEventListener(t, f) {
      (this.handlers[t] = this.handlers[t] || []).push(f);
    },
    removeEventListener() {},
    appendChild(c) {
      this.children.push(c);
      if (c) c.parentNode = this;
      return c;
    },
    insertBefore(c) {
      this.children.push(c);
      if (c) c.parentNode = this;
      return c;
    },
    contains(t) {
      let p = t;
      while (p) {
        if (p === this) return true;
        p = p.parentNode;
      }
      return false;
    },
    focus() {},
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 300, height: 66, left: 0, top: 0, right: 300, bottom: 66 };
    },
    setPointerCapture() {},
    /* 真事件派发：既叫 addEventListener 的监听，也叫 onXxx 属性处理器（原生两条路都走）；
     ev.target 必须是自己（原生就是它，提交时按「哪一格触发的」认草稿要靠它） */
    emit(t, ev) {
      const e = Object.assign({ type: t, target: this }, ev || {});
      for (const f of (this.handlers[t] || []).slice()) f(e);
      const p = this["on" + t];
      if (typeof p === "function") p(e);
    },
  };
  el.classList = { contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0 };
  return el;
}
function makeSandbox() {
  const sandbox = {
    window: { api: {} },
    S: { wf: null, config: {} },
    I18n: { t: (s) => s },
    document: {
      readyState: "loading",
      addEventListener() {},
      removeEventListener() {},
      getElementById() {
        return null;
      },
      createElement: (tag) => mkEl(tag),
      activeElement: null,
      body: mkEl("body"),
      getSelection: () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null, focusNode: null }),
    },
    toast() {},
    scheduleSave() {},
    renderCanvas() {},
    focusNode() {},
    addNode() {
      return null;
    },
    console,
    setTimeout,
    clearTimeout,
    Map,
    Set,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    RegExp,
    isFinite,
    parseFloat,
    parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
  vm.runInContext(LTU, sandbox, { filename: "renderer/app-longtask-ui.js" });
  return sandbox;
}
function walk(el, fn) {
  if (!el || !el.children) return;
  for (const c of el.children) {
    fn(c);
    walk(c, fn);
  }
}
function findAll(root, tag) {
  const out = [];
  walk(root, (c) => {
    if (c.tagName === tag) out.push(c);
  });
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════ [1] 机制就位 ═══════════════ */
console.log("\n[1] 机制就位（renderer/app-longtask-ui.js）");
{
  has(LTU, "function ltItemDraftKey(path, it, field) {", "有条目草稿键 ltItemDraftKey（环节路径 + 条目 id + 字段名）");
  has(LTU, '":it:"', "草稿键带 it: 段：与检查器字段（goal / why / relnote）不串台");
  has(LTU, 'return ltDraftKey(String(path || "") + ":it:" + String((it && it.id) || ""), field);', "键口径写明：路径 + 条目 id + 字段名（同一条 run 逐帧稳定）");
  const guard = fnBody(LTU, "ltChecklistEditor");
  has(guard, "ltDraftBind(el, k);", "每格走 ltDraftBind（还原草稿 + 输入即写）");
  has(guard, "ltScrollBind(el, k);", "每格同时按同一个键记滚动位置（重绘后停在原处）");
  has(guard, "draftKeys.push(k);", "本帧的草稿键登记成一列（提交成功后清）");
  has(guard, "if (!el || !k) return el;", "guard 对空控件 / 认不出身份的格不动手（宁可这次不保，也不乱记）");
  has(guard, 'guard(title, it, "title")', "文件名 / 标题那一格挂草稿保护");
  has(guard, 'guard(desc, it, "desc")', "内容说明那一格挂草稿保护");
  has(guard, ", guard);", "调用点把 guard 传给 ltItemInput（第 8 个参数）");
  ok(
    /function ltItemInput\(parent, it, commit, path, uid, editing, isDeliver, guardIn\) \{/.test(LTU),
    "ltItemInput 的 guardIn 挂在末位（老调用处只传 7 个参数，行为一字不变）",
  );
  const itemInput = LTU.slice(LTU.indexOf("function ltItemInput("), LTU.indexOf("function ltNodeFilePaths("));
  has(itemInput, 'typeof guardIn === "function" ? (el, field) => guardIn(el, it, field) : () => {}', "没传 guard 时退化成空动作（不抛错）");
  has(itemInput, 'guard(ta, "value")', "文本条目在真渲染路径上也挂了保护");
  has(LTU, "ltTaHBind(note, key);", "交付说明框（放行确认窗）也按草稿键记高度（与审批理由框同源）");
}

/* ═══════════════ [2] 提交即三份写同源 ═══════════════ */
console.log("\n[2] 提交即三份写同源、写同步（缺一份就会被画布同步链拿旧的盖回来）");
{
  const body = fnBody(LTU, "ltChecklistEditor");
  has(body, "node.cfg.items = items;", "图定义 cfg.items 指回本帧同一份清单（对象不换新的）");
  has(body, "st.items = items;", "运行态快照 st.items 指回同一份（卡片渲染读它）");
  has(body, "const dn = ltDeliverNodeOf(node.cfg.uid);", "按交付 uid 找到画布上那颗交付节点");
  has(body, "if (dn) dn.ltItems = items;", "画布节点的 ltItems 指回同一份（同步链的权威那一份）");
  has(body, "for (const k of draftKeys) ltDraftClear(k);", "提交成功后清本帧草稿（旧字不会跟着下一条漂）");
  ok(
    body.indexOf("draftKeys") < body.indexOf("ltRenderStrip();"),
    "清草稿排在重绘之前（这一帧长出来的控件才不会带着旧草稿）",
  );
  /* 来源口径与画布侧同步链同源：对照 app-longtask.js 的权威顺序一眼看得出是哪一份 */
  has(LTV, "if (st) st.items = JSON.parse(JSON.stringify(items));", "画布侧同步链（ltDeliverSyncFromNode）读的就是节点上的 ltItems");
  has(LTV, "const items = JSON.parse(JSON.stringify(ltArr(node && node.ltItems)));", "同步链的权威那一份 = 节点 ltItems（所以它必须是最新的）");
}

/* ═══════════════ [3][4][5] 真跑 ltChecklistEditor ═══════════════ */
async function main() {
  console.log("\n[3] 真跑：打字 → change → 三份同源；画布同步推回旧清单后字仍在");
  const sandbox = makeSandbox();
  vm.runInContext(
    `
    window.__items = [
      { id: "i1", kind: "text", title: "风格说明", required: true, done: false, value: "" },
      { id: "i2", kind: "file", file: "分镜表.md", desc: "每镜头一行", required: true, done: false, paths: [] }
    ];
    window.__node = { id: "n_h", kind: "human", title: "交稿", cfg: { mode: "deliver", uid: "ltx-交稿", items: window.__items } };
    window.__rn = { path: "h", status: "waiting", uid: "ltx-交稿", items: window.__items, dir: "" };
    window.__runObj = { runId: "r1", ns: {}, graph: { nodes: [window.__node], edges: [] }, nodes: { h: window.__rn }, waits: [], status: "waiting" };
    window.__wf = { id: "wf1", longtask: { tasks: [{ uid: "t1", ver: 1, graph: { nodes: [window.__node], edges: [] } }], active: "t1" } };
    /* 画布上那颗交付节点：ltItems 是它自己那一份（真实里由 ltEnsureDeliverNode 从 cfg.items 拷来，之后各走各的） */
    window.__dn = { id: "n_dn", kind: "deliver", ltUid: "ltx-交稿", ltItems: JSON.parse(JSON.stringify(window.__items)), ltDir: "" };
    ltCurrentRun = () => window.__runObj;
    ltDeliverNodeOf = () => window.__dn;
    ltDeliverWrite = async () => "";
    ltSave = () => {};
    ltRenderStrip = () => { window.__renders = (window.__renders || 0) + 1; };
    window.__card = () => {
      const parent = document.createElement("div");
      return ltChecklistEditor(parent, window.__wf, { uid: "t1", ver: 1, graph: { nodes: [window.__node], edges: [] } }, window.__node, window.__node.cfg.items, false, "h");
    };
  `,
    sandbox,
    { filename: "lt-deliver-draft-probe" },
  );
  const inCtx = (code) => vm.runInContext(code, sandbox);
  const card = () => inCtx("window.__card()");

  const first = card();
  const ta = findAll(first, "TEXTAREA")[0];
  ok(!!ta, "交付卡渲染出文本条目的输入框");
  ok(typeof (ta && ta.oninput) === "function", "输入框挂上了草稿记录（oninput 写草稿，不靠 change / blur）");
  ta.value = "整体冷色调，夜戏为主";
  ta.emit("input", {});
  ta.emit("change", {});
  await sleep(25); /* change 的收尾里有 await（commit 会写交付目录） */

  const three = inCtx(
    `({ v: window.__items[0].value, rv: window.__rn.items[0].value, cv: window.__node.cfg.items[0].value, dv: window.__dn.ltItems[0].value, renders: window.__renders || 0 })`,
  );
  eqNum(three.renders, 1, "提交触发了一次条带重绘（ltRenderStrip 被叫到）");
  eqStr(three.v, "整体冷色调，夜戏为主", "条目自己那一份拿到用户写的字");
  eqStr(three.rv, "整体冷色调，夜戏为主", "运行态快照 st.items（卡片渲染读的那一份）拿到");
  eqStr(three.cv, "整体冷色调，夜戏为主", "图定义 cfg.items（下次启用 / 重跑读的那一份）拿到");
  eqStr(three.dv, "整体冷色调，夜戏为主", "**画布交付节点 ltItems 也拿到**（同步链的权威那一份不再是旧的）");

  /* 模拟画布侧同步链：以节点上的清单为准，整份推回运行态与图定义（老版本就是这一步把字顶掉） */
  inCtx(`
    (function () {
      const items = JSON.parse(JSON.stringify(window.__dn.ltItems));
      window.__rn.items = JSON.parse(JSON.stringify(items));
      window.__node.cfg.items = JSON.parse(JSON.stringify(items));
    })();
  `);
  const after = card();
  const ta2 = findAll(after, "TEXTAREA")[0];
  eqStr(ta2 && ta2.value, "整体冷色调，夜戏为主", "画布同步链走一轮之后，新长出来的输入框里那段字仍在（本次 bug 的验收口径）");

  console.log("\n[4] 兜底那一路也真跑：未提交就重绘 → 按草稿键还原");
  inCtx(`window.__items[0].value = ""; window.__rn.items[0].value = ""; window.__node.cfg.items[0].value = ""; window.__dn.ltItems[0].value = "";`);
  const d1 = card();
  const taD = findAll(d1, "TEXTAREA")[0];
  taD.value = "还没提交的一段字";
  taD.emit("input", {}); /* 只打字，不 change / 不失焦：真实里这就是「正在写」的那一段 */
  const d2 = card(); /* 长任务 ~90ms 一次的重绘（或画布同步）把这一帧的 DOM 换掉 */
  const taE = findAll(d2, "TEXTAREA")[0];
  eqStr(taE && taE.value, "还没提交的一段字", "未提交就重绘：新框按草稿键还原（不靠提交链也不丢字）");

  console.log("\n[5] 文件名 / 内容说明两格同样吃保护；提交过的草稿会清");
  const titleIn = findAll(d2, "INPUT").filter((i) => String(i.className).indexOf("lt-in-title") >= 0)[1];
  const descIn = findAll(d2, "INPUT").filter((i) => String(i.className).indexOf("lt-in-desc") >= 0)[0];
  ok(!!titleIn, "找到文件条目的文件名输入框");
  ok(!!descIn, "找到文件条目的内容说明输入框");
  ok(typeof (titleIn && titleIn.oninput) === "function", "文件名格也挂草稿记录");
  ok(typeof (descIn && descIn.oninput) === "function", "内容说明格也挂草稿记录");
  titleIn.value = "成片-竖屏.mp4";
  titleIn.emit("input", {});
  titleIn.emit("change", {});
  await sleep(25);
  const f = inCtx(`({ f: window.__rn.items[1].file, dv: window.__dn.ltItems[1].file, rv: window.__rn.items[1].file, cv: window.__node.cfg.items[1].file, renders: window.__renders || 0 })`);
  eqStr(f.f, "成片-竖屏.mp4", "文件名改动提交到条目上（与老行为一致）");
  eqStr(f.dv, "成片-竖屏.mp4", "文件名改动同样同步到画布交付节点（三份同源）");
  eqNum(f.renders, 2, "第二次提交又触发一次重绘");

  /* 提交成功 = 草稿清掉：下一次重绘不该再拿旧草稿把条目里的新值盖回去 */
  inCtx(`window.__items[1].file = "定稿-横屏.mp4"; window.__dn.ltItems[1].file = "定稿-横屏.mp4"; window.__rn.items[1].file = "定稿-横屏.mp4"; window.__node.cfg.items[1].file = "定稿-横屏.mp4";`);
  const g = card();
  const titleG = findAll(g, "INPUT").filter((i) => String(i.className).indexOf("lt-in-title") >= 0)[1];
  eqStr(titleG && titleG.value, "定稿-横屏.mp4", "提交过的草稿被清：条目改了名字，重绘跟着显示新名字（旧草稿不会把值顶回去）");

  /* 文本条目那一格：上一轮那条未提交的草稿还在（用户自己没提交）→ 仍按草稿还原，这是设计口径 */
  const taG = findAll(g, "TEXTAREA")[0];
  eqStr(taG && taG.value, "还没提交的一段字", "未提交的那格草稿照旧留着（只增不减，提交才清）");

  console.log(
    "\n" +
      (fails
        ? "✗ " + fails + " / " + checks + " 项失败  (smoke-longtask-deliver-draft)"
        : "✓ " + checks + " 项全部通过  (smoke-longtask-deliver-draft)"),
  );
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.log("测试异常：" + String((e && e.stack) || e));
  process.exit(1);
});
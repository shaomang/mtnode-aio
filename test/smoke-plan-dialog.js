"use strict";
/* 复杂任务计划确认弹窗 —— 冒烟测试（纯 Node + 迷你 DOM，不依赖 Electron）
 *   node test/smoke-plan-dialog.js
 * 覆盖（对应本次「弹窗可读性」改动：可拉伸 / 三列 / 多行输入 / 单按钮模型下拉 / 滚动浏览）：
 *   [1] 计划契约解析（标记 · 代码块 · 上限 · 脏数据）
 *   [2] 弹窗结构：一条任务 = 三列（标题 / 详情 / 执行模型）+ 行头（序号 · 并行组 · ↑↓✕）
 *   [3] 多行输入：textarea 而非单行 input，随内容长高，用户手拉后不再抢高度
 *   [4] 窗口可拉伸：右下角手柄跟手拖拽 · 最小/视口钳制 · 双击还原 · ⤢ 最大化 · 尺寸跨次打开保持
 *   [5] 第三列只有一个按钮：点击出下拉（按服务商分组 · 当前项打勾 · 未登记模型也列出）· 点外部 / Esc 收起
 *   [6] 滚动浏览（结构 + CSS：body 弹性盒 · 列表 overflow · 表头吸顶 · 下拉层级压过对话框）
 *   [7] 增删 / 排序 / 空校验 / Ctrl+Enter / 取消 与关闭后的现场清理
 *   [8] 接线：脚本引入 · 英文词条 · 旧单行 + <select> 零残留 · 执行器（串行 + 并行组）未回归
 *   [9] 计划归属与会话绑定：sessId / 游标 runId / 弹窗过期 / 终止即永久消失 / 水合不自动开跑
 *   [10] 串台修复回归：新会话零继承 / 作废计数水合 / drain 丢弃残留 / A、B 会话互不串 / 忙时不入队
 *   [11] 并行组运行过程可观测：子任务 live 轨迹（正文 / 工具 / token）· 可预测 runKey ·
 *        st._planPar 记账与队列通知 · 面板状态条与流式转写区 · 失败项 error 摘要 · 轨迹绝不落盘 */
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
const drain = () =>
  new Promise((res) => {
    let k = 16;
    const step = () => (k-- <= 0 ? res() : setImmediate(step));
    step();
  });

/* ============================ 迷你 DOM ============================ */
function matches(el, sel) {
  if (!el || !el.__el) return false;
  /* 支持 tag / .cls / #id / tag.c1.c2 */
  const m = /^([a-zA-Z]+)?((?:[.#][\w-]+)*)$/.exec(sel);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const p of (m[2] || "").match(/[.#][\w-]+/g) || []) {
    if (p[0] === ".") {
      if (!el.classList.contains(p.slice(1))) return false;
    } else if (el.id !== p.slice(1)) return false;
  }
  return true;
}
function walk(el, out) {
  for (const c of el.childNodes) {
    out.push(c);
    walk(c, out);
  }
  return out;
}
function evObj(type, ev) {
  return Object.assign(
    { type: type || "evt", preventDefault() {}, stopPropagation() {} },
    ev || {},
  );
}
function mkEl(tag) {
  const el = {
    __el: true,
    tagName: String(tag || "div").toUpperCase(),
    childNodes: [],
    parentNode: null,
    id: "",
    _cls: "",
    _text: "",
    value: "",
    hidden: false,
    type: "",
    rows: 0,
    placeholder: "",
    title: "",
    offsetWidth: 300,
    offsetHeight: 320,
    scrollHeight: 82,
    __boxW: 0,
    __boxH: 0,
    style: {},
    _l: {},
    focus() {
      this.__focused = true;
    },
    scrollIntoView() {
      this.__scrolled = true;
    },
    click() {
      if (typeof this.onclick === "function") this.onclick(evObj("click"));
    },
    appendChild(c) {
      if (c && c.__frag) {
        for (const x of c.childNodes.slice()) el.appendChild(x);
        c.childNodes.length = 0;
        return c;
      }
      c.parentNode = el;
      el.childNodes.push(c);
      return c;
    },
    removeChild(c) {
      const i = el.childNodes.indexOf(c);
      if (i >= 0) el.childNodes.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    },
    addEventListener(t, f) {
      (el._l[t] = el._l[t] || []).push(f);
    },
    removeEventListener(t, f) {
      const a = el._l[t] || [];
      const i = a.indexOf(f);
      if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) {
      const e = evObj(type, ev);
      for (const f of (el._l[type] || []).slice()) f(e);
      return e;
    },
    contains(other) {
      if (!other) return false;
      if (other === el) return true;
      return walk(el, []).indexOf(other) >= 0;
    },
    /* 自定义属性：live 转写区用 data-live-state 标状态（面板 CSS 靠它变色） */
    setAttribute(k, v) {
      (el._attrs || (el._attrs = {}))[String(k)] = String(v);
    },
    getAttribute(k) {
      const a = el._attrs || {};
      return Object.prototype.hasOwnProperty.call(a, String(k)) ? a[String(k)] : null;
    },
    removeAttribute(k) {
      if (el._attrs) delete el._attrs[String(k)];
    },
    getBoundingClientRect() {
      /* 内联宽高优先：拖拽后的 rect 要跟随真实设置 */
      const w = parseFloat(el.style.width) || el.__boxW || 100;
      const h = parseFloat(el.style.height) || el.__boxH || 20;
      return { left: 40, top: 30, width: w, height: h, right: 40 + w, bottom: 30 + h };
    },
    querySelector(sel) {
      for (const d of walk(el, [])) if (matches(d, sel)) return d;
      return null;
    },
    querySelectorAll(sel) {
      return walk(el, []).filter((d) => matches(d, sel));
    },
  };
  Object.defineProperty(el, "firstChild", { get: () => el.childNodes[0] || null });
  Object.defineProperty(el, "className", {
    get: () => el._cls,
    set: (v) => (el._cls = String(v == null ? "" : v)),
  });
  Object.defineProperty(el, "textContent", {
    get: () => el._text + el.childNodes.map((c) => c.textContent).join(""),
    set: (v) => {
      el.childNodes.length = 0;
      el._text = String(v == null ? "" : v);
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get: () => "",
    set: (v) => {
      if (String(v) === "") for (const c of el.childNodes.slice()) el.removeChild(c);
    },
  });
  el.classList = {
    contains: (c) => el._cls.split(/\s+/).indexOf(c) >= 0,
    add: (c) => {
      if (!el.classList.contains(c)) el._cls = (el._cls + " " + c).trim();
    },
    remove: (c) => {
      el._cls = el._cls.split(/\s+/).filter((x) => x && x !== c).join(" ");
    },
    toggle: (c, on) => {
      if (on === undefined) on = !el.classList.contains(c);
      if (on) el.classList.add(c);
      else el.classList.remove(c);
    },
  };
  return el;
}

/* ============================ 沙箱 ============================ */
const MODEL_GROUPS = [
  { id: "deepseek-official", name: "DeepSeek 官方", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { id: "mtnode_1", name: "MTNode 兼容", models: ["glm-4.6", "kimi-k2"] },
];
function makeSandbox() {
  return loadSandbox(["renderer/app-plan.js"]);
}
/* 同一套迷你 DOM 沙箱，按需再加载其他渲染层文件（app-assist.js / app.js 顶层只声明
   函数与常量，可整文件 vm 加载；被测代码依赖的全局在调用时按沙箱桩解析）。 */
function loadSandbox(files) {
  const doc = {
    activeElement: null,
    createElement: mkEl,
    createDocumentFragment: () => {
      const f = mkEl("#fragment");
      f.__frag = true;
      return f;
    },
    _l: {},
    addEventListener(t, f) {
      (doc._l[t] = doc._l[t] || []).push(f);
    },
    removeEventListener(t, f) {
      const a = doc._l[t] || [];
      const i = a.indexOf(f);
      if (i >= 0) a.splice(i, 1);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  doc.body = mkEl("body");
  doc.getElementById = function (id) {
    if (doc.body.id === id) return doc.body;
    return walk(doc.body, []).filter((d) => d.id === id)[0] || null;
  };
  const docFire = (type, ev) => {
    const e = evObj(type, ev);
    for (const f of (doc._l[type] || []).slice()) f(e);
    return e;
  };

  /* #mtDialog 宿主（照 app.js ensureMtDialog 的结构：head>b / body / foot） */
  const host = mkEl("div");
  host.id = "mtDialog";
  host.className = "mt-dialog";
  const box = mkEl("div");
  box.className = "mt-dialog-box";
  box.__boxW = 1080; /* CSS 默认（min(1080px,94vw) × min(86vh,820px)） */
  box.__boxH = 820;
  const head = mkEl("div");
  head.className = "mt-dialog-head";
  const title = mkEl("b");
  title.id = "mtDlgTitle";
  head.appendChild(title);
  const body = mkEl("div");
  body.id = "mtDlgBody";
  body.className = "mt-dialog-body";
  const foot = mkEl("div");
  foot.id = "mtDlgFoot";
  foot.className = "mt-dialog-foot";
  box.appendChild(head);
  box.appendChild(body);
  box.appendChild(foot);
  host.appendChild(box);
  doc.body.appendChild(host);

  const toasts = [];
  const sb = {
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    window: { innerWidth: 1600, innerHeight: 900 },
    document: doc,
    I18n: { t: (s) => String(s) },
    ensureMtDialog: () => host,
    closeMtDialog: () => host.classList.remove("on"),
    playIxSound: () => {},
    toast: (m, k) => toasts.push(String(m) + "|" + (k || "")),
    uid: (p) => p + Math.random().toString(36).slice(2, 7),
    devAgentModelGroups: () => MODEL_GROUPS,
    devRouteOfModel: (m) => {
      for (const g of MODEL_GROUPS) if (g.models.indexOf(m) >= 0) return g.id;
      return "";
    },
    devAgentRouteName: (r) => {
      for (const g of MODEL_GROUPS) if (g.id === r) return g.name;
      return r;
    },
    defaultAgentProviderRoute: () => "deepseek-official",
    /* 网关桩：真实 dshRunTask 会边跑边把 text / tool / tool-result / usage / error
       事件推给 opts.onEvent（并行组的 live 轨迹全靠它），桩照做之后再 resolve；
       同时把每次调用的 runKey 记进 __dshRuns，供「可预测键 · 可取消 · 可记账」断言。 */
    dshRunTask: async (input, opts) => {
      opts = opts || {};
      const runs = (sb.__dshRuns = sb.__dshRuns || []);
      const rec = {
        runKey: String(opts.runKey || ""),
        input: String(input || ""),
        hasOnEvent: typeof opts.onEvent === "function",
        events: [],
      };
      runs.push(rec);
      const emit = (type, data) => {
        rec.events.push(type);
        if (typeof opts.onEvent === "function") opts.onEvent(type, data);
      };
      const tag = rec.runKey.split(":").pop() || String(runs.length);
      emit("text", { text: "并行产出 " + tag + " 的第一段。" });
      emit("tool", { callId: "c1-" + tag, name: "read", args: '{"file_path":"a.txt"}' });
      emit("tool-result", { callId: "c1-" + tag, content: "文件内容 ok" });
      emit("usage", {
        inputTokens: 120,
        outputTokens: 34,
        cacheReadTokens: 8,
        reasoningTokens: 5,
      });
      return "done-" + tag;
    },
    agentSessionSend: async () => "done",
    persistAgentSession: async () => {},
    renderAgentSession: () => {},
    renderAgentSessionSidebar: () => {},
    recordDshMetrics: () => {},
    onDshNodeEvent: () => {},
    S: { agentActiveId: null },
    __toasts: toasts,
    __docFire: docFire,
    __doc: doc,
    __host: host,
    __box: box,
  };
  vm.createContext(sb);
  for (const f of files || [])
    vm.runInContext(read(f), sb, { filename: String(f).split("/").pop() });
  return sb;
}

const PLAN_TEXT =
  "前置说明\n<!--MTNODE-PLAN-->\n" +
  JSON.stringify({
    goal: "把计划弹窗改成可拉伸的三列清单",
    excludes: ["不改网关", "不动执行器契约"],
    tasks: [
      { title: "重写弹窗结构", detail: "renderer/app-plan.js：一条任务三列", model: "glm-4.6", parallel: "ui" },
      { title: "补样式", detail: "base.css：可拉伸 + 滚动浏览", model: "", parallel: "ui" },
      { title: "同步文档", detail: "CHANGELOG 一条", model: "no-such-model", parallel: "" },
    ],
  }) +
  "\n<!--/MTNODE-PLAN-->\n结尾";

const areaW = (el) => parseInt(el.style.width, 10);
const areaH = (el) => parseInt(el.style.height, 10);

async function main() {
  /* ===================== [1] 契约解析 ===================== */
  console.log("\n[1] 计划契约解析");
  const s0 = makeSandbox();
  const parsed = s0.planParseFromText(PLAN_TEXT);
  ok(!!parsed, "解析到计划对象");
  ok(parsed.goal === "把计划弹窗改成可拉伸的三列清单", "goal 正确");
  ok(parsed.excludes.length === 2, "excludes 两条");
  ok(parsed.tasks.length === 3, "tasks 三项（含 model / parallel）");
  ok(parsed.tasks[0].model === "glm-4.6", "保留建议模型");
  ok(parsed.tasks[2].parallel === "", "无并行组时为空串");
  ok(s0.planParseFromText("没有标记") === null, "无标记 → null");
  ok(s0.planParseFromText("<!--MTNODE-PLAN-->不合法<!--/MTNODE-PLAN-->") === null, "脏数据 → null");
  const fence = s0.planParseFromText(
    "<!--MTNODE-PLAN-->```json\n" +
      JSON.stringify({ goal: "g", tasks: [{ title: "t1" }, { title: "t2" }] }) +
      "\n```<!--/MTNODE-PLAN-->",
  );
  ok(!!fence && fence.tasks.length === 2, "代码块包裹也能解析");
  const many = s0.planParseFromText(
    "<!--MTNODE-PLAN-->" +
      JSON.stringify({ goal: "g", tasks: Array.from({ length: 12 }, (_, i) => ({ title: "t" + i })) }) +
      "<!--/MTNODE-PLAN-->",
  );
  ok(many.tasks.length === 8, "最多 8 项被钳制");

  /* ===================== [2] 弹窗结构：三列 ===================== */
  console.log("\n[2] 弹窗结构（一条任务 = 三列）");
  const sb = makeSandbox();
  let res = null;
  sb.planConfirmDialog(
    { id: "st1", agentSessionId: "st1", title: "弹窗改版" },
    s0.planParseFromText(PLAN_TEXT),
  ).then((r) => (res = r));
  await drain();
  const box = sb.__box;
  const body = sb.__doc.getElementById("mtDlgBody");
  ok(box.classList.contains("mt-plan-box"), "box 加 mt-plan-box（专用可拉伸样式）");
  ok(/计划确认/.test(sb.__doc.getElementById("mtDlgTitle").textContent), "标题「计划确认 · 目标」");
  ok(hostOn(sb.__host), "弹窗已显示（host.on）");
  const cards = body.querySelectorAll(".mt-plan-card");
  ok(cards.length === 3, "三条任务 → 三张卡片");
  const c0 = cards[0];
  const cols = c0.querySelector(".mt-plan-cols");
  ok(!!cols, "卡片内是三列容器 .mt-plan-cols");
  ok(cols.childNodes.length === 3, "恰好 3 列（标题 / 详情 / 模型）");
  const areas = cols.querySelectorAll("textarea.mt-plan-inp");
  ok(areas.length === 2, "前两列是多行 textarea（不再是单行 input）");
  ok(areas[0].value === "重写弹窗结构", "标题列回填任务标题");
  ok(areas[1].value === "renderer/app-plan.js：一条任务三列", "详情列回填详情");
  ok(areas[1].className.indexOf("detail") >= 0, "详情列有独立样式类（更宽）");
  ok(!cols.querySelector("input"), "三列里没有任何单行 input");
  ok(!cols.querySelector("select"), "三列里没有 <select>");
  const colM = cols.querySelector("div.mt-plan-col-model");
  ok(!!colM && colM.childNodes.length === 1, "第三列只有一个元素（一个按钮）");
  const mbtn = colM && colM.querySelector("button.mt-plan-model");
  ok(!!mbtn, "第三列是 button.mt-plan-model");
  ok(!body.querySelector("select"), "整个清单没有 select 控件");
  ok(!c0.querySelector(".mt-plan-colhead"), "列名表头在列表顶部，不在卡片里");
  const headRow = body.querySelector(".mt-plan-colhead");
  ok(!!headRow && headRow.querySelectorAll("span").length === 3, "列表顶部三列表头");
  ok(
    /任务标题/.test(headRow.textContent) && /执行模型/.test(headRow.textContent),
    "表头文字：任务标题 / 详情 / 执行模型",
  );
  const rowHead = c0.querySelector(".mt-plan-card-head");
  ok(rowHead.querySelector(".mt-plan-idx").textContent === "1", "行头有序号");
  const para = rowHead.querySelector("input.mt-plan-para");
  ok(!!para && para.value === "ui", "行头有「并行组」输入并回填（旧实现无处可改）");
  ok(
    rowHead.querySelectorAll("button").length === 3,
    "行头三个动作按钮（↑ ↓ ✕），不挤占三列宽度",
  );
  ok(/自动（跟随默认）/.test(cards[1].querySelector("button.mt-plan-model").textContent), "未指定模型 → 按钮显示「自动（跟随默认）」");
  ok(cards[1].querySelector("button.mt-plan-model").classList.contains("auto"), "未指定模型时按钮是 auto 虚线态");
  const mbtnPicked = cards[2].querySelector("button.mt-plan-model");
  ok(/no-such-model/.test(mbtnPicked.textContent), "有建议模型 → 按钮直接显示它");
  ok(mbtnPicked.classList.contains("picked"), "已指定模型的按钮是 picked 实线态");
  ok(!!body.querySelector("p.mt-form-hint"), "底部有使用说明");
  ok(/拖右下角可放大窗口/.test(body.querySelector("p.mt-form-hint").textContent), "说明里写了可拉伸");
  ok(/滚动浏览/.test(body.querySelector("p.mt-form-hint").textContent), "说明里写了滚动浏览");

  /* ---- 头部信息块：执行位置 + 目标合并成一块；不再有作废提示 / 「明确不做」栏 ---- */
  const notes = body.querySelectorAll("div.mt-form-note");
  ok(notes.length === 1, "头部只剩一个信息块（执行位置与目标已合并）");
  ok(
    /会话「弹窗改版」/.test(notes[0].querySelector("i").textContent),
    "信息块标题 = 执行位置（归属会话）",
  );
  ok(
    notes[0].querySelector("p").textContent === "把计划弹窗改成可拉伸的三列清单",
    "信息块内容 = 一句话目标",
  );
  ok(
    body.textContent.indexOf("执行位置") < 0,
    "不再单列「执行位置」这块（并入标题行）",
  );
  ok(body.textContent.indexOf("明确不做") < 0, "弹窗不再显示「明确不做」这一栏");
  ok(
    !/会话被删除或归档/.test(body.textContent),
    "归属作废提示已从弹窗移除",
  );
  ok(
    read("renderer/app-plan.js").indexOf("会话被删除或归档") < 0,
    "源码不再引用作废提示文案（i18n 词条同步清理）",
  );
  ok(
    /会话「弹窗改版」/.test(sb.__doc.getElementById("mtDlgTitle").textContent),
    "标题仍带归属标注（不丢信息）",
  );

  /* ===================== [3] 多行输入行为 ===================== */
  console.log("\n[3] 多行输入（随内容长高）");
  const de = areas[1];
  const h0 = areaH(de);
  ok(h0 >= 74, "详情框按内容撑高（不是一行高）");
  ok(/详情/.test(de.placeholder), "详情框占位说明保留");
  ok(de.rows >= 3, "详情框初始 rows ≥ 3");
  ok(!!sb.__doc.getElementById("mtDlgFoot").querySelector(".primary"), "底部有「确认执行」主按钮");
  ok(res === null, "弹窗仍在等待用户");
  const ti = areas[0];
  ti.fire("pointerup", { clientY: 400 });
  const hm = areaH(ti);
  ti.value = "改了标题";
  ti.fire("input");
  ok(areaH(ti) === hm, "用户手动拉过本框后不再自动改高（不打断手劲）");
  ti.fire("focus");
  ok(ti.__focused === true, "聚焦回调可用");
  const de2 = areas[1];
  de2.fire("pointerup", { clientY: 30 });
  de2.value = "y".repeat(50);
  de2.fire("input");
  ok(/y{50}/.test(de2.title), "title 同步全文（悬浮可读）");

  /* ===================== [4] 窗口可拉伸 ===================== */
  console.log("\n[4] 窗口可拉伸 / 最大化 / 还原");
  const grip = box.querySelector(".mt-plan-resize");
  const maxBtn = box.querySelector("button.mt-plan-max");
  ok(!!grip, "有右下角拉伸手柄");
  ok(!!maxBtn, "头部有 ⤢ 最大化按钮");
  ok(box.style.width === "", "首次打开不写内联宽高（用 CSS 默认大窗口）");
  ok(/拖拽/.test(grip.title) && /双击/.test(grip.title), "手柄提示：拖拽放大 + 双击还原");
  ok(/最大化/.test(maxBtn.title), "最大化按钮有提示");
  grip.fire("pointerdown", { clientX: 100, clientY: 100 });
  sb.__docFire("pointermove", { clientX: 130, clientY: 110 });
  ok(
    areaW(box) === 1080 + 60 && areaH(box) === 820 + 20,
    "居中弹窗：向右下拖 30/10px → 宽高各 +2×（手柄跟手）",
  );
  sb.__docFire("pointermove", { clientX: 130, clientY: 110 });
  ok(areaW(box) === 1140, "同一次拖拽内位置不变则尺寸稳定（不抖）");
  sb.__docFire("pointermove", { clientX: -4000, clientY: -4000 });
  ok(areaW(box) === 660 && areaH(box) === 400, "钳在最小值 660×400（不会缩到不可读）");
  sb.__docFire("pointermove", { clientX: 9000, clientY: 9000 });
  ok(
    areaW(box) === 1600 - 56 && areaH(box) === 900 - 56,
    "钳在视口内（宿主 24px 内边距 + 余量），拖不出屏幕",
  );
  sb.__docFire("pointerup", {});
  ok(!sb.__doc.body.classList.contains("plan-resizing"), "抬手后清掉拖拽光标态");
  sb.__docFire("pointermove", { clientX: 9999, clientY: 9999 });
  ok(areaW(box) === 1544, "抬手后的移动不再改尺寸（监听已摘除）");
  grip.fire("pointerdown", { clientX: 0, clientY: 0 });
  sb.__docFire("pointermove", { clientX: -40, clientY: -100 });
  sb.__docFire("pointerup", {});
  ok(areaW(box) === 1464 && areaH(box) === 644, "拖回中间尺寸（1544×844 基础上 −80 / −200）");
  maxBtn.click();
  ok(maxBtn.textContent === "⤡", "最大化后按钮切到「还原」⤡");
  ok(areaW(box) === 1544 && areaH(box) === 844, "⤢ 一键铺满可视区（不出屏幕）");
  maxBtn.click();
  ok(
    areaW(box) === 1464 && areaH(box) === 644 && maxBtn.textContent === "⤢",
    "还原回到拖出来的那个尺寸（不是默认值）",
  );
  grip.fire("dblclick", {});
  ok(box.style.width === "" && box.style.height === "", "双击手柄还原默认大小（清内联宽高）");
  grip.fire("pointerdown", { clientX: 0, clientY: 0 });
  sb.__docFire("pointermove", { clientX: -40, clientY: -100 });
  sb.__docFire("pointerup", {});
  ok(areaW(box) === 1000, "双击后再拖 → 新尺寸（从 CSS 默认起算）");
  sb.__doc.getElementById("mtDlgFoot").querySelector(".primary").click();
  await drain();
  ok(res && res.action === "go", "确认执行返回 go");
  ok(res.tasks.length === 3, "带出 3 项任务");
  ok(res.tasks[0].title === "改了标题", "标题编辑结果原样传出");
  ok(res.tasks[0].model === "glm-4.6", "没动过的建议模型保留");
  ok(res.tasks[0].parallel === "ui" && res.tasks[2].parallel === "", "并行组原样传出");
  ok(
    !res.excludes,
    "弹窗结果不带 excludes（「明确不做」不再出现在弹窗，数据仍由 plan 原样传给执行器）",
  );
  ok(
    /excludes: item\.plan && item\.plan\.excludes/.test(read("renderer/app-plan.js")),
    "启动执行仍把原 excludes 落进 st.plan（面板悬浮可回看）",
  );
  ok(!box.querySelector(".mt-plan-resize"), "关闭后拉伸手柄已摘除");
  ok(!box.querySelector("button.mt-plan-max"), "关闭后最大化按钮已摘除");
  ok(
    !box.classList.contains("mt-plan-box") && !box.classList.contains("mt-form-wide"),
    "关闭后弹窗类名复位（不污染下一个对话框）",
  );
  ok(box.style.width === "" && box.style.maxHeight === "", "关闭后清掉内联宽高");
  /* 同一会话内第二次打开：记住上次拖好的尺寸 */
  let resB = null;
  sb.planConfirmDialog({}, s0.planParseFromText(PLAN_TEXT)).then((r) => (resB = r));
  await drain();
  ok(areaW(box) === 1000 && areaH(box) === 620, "再次打开沿用上次拖出的尺寸（本次会话记住）");
  sb.__host.fire("keydown", { key: "Escape" });
  await drain();
  ok(resB && resB.action === "cancel", "Esc 取消第二次弹窗");

  /* ===================== [5] 第三列：单按钮 + 下拉菜单 ===================== */
  console.log("\n[5] 模型下拉（一个按钮 · 点击出菜单）");
  const sb2 = makeSandbox();
  let res2 = null;
  sb2.planConfirmDialog({ id: "st2" }, s0.planParseFromText(PLAN_TEXT)).then((r) => (res2 = r));
  await drain();
  const box2 = sb2.__box;
  ok(sb2.__doc.getElementById("planModelPop") === null, "未点击前不创建下拉层（按需建）");
  const btnA = box2.querySelector(".mt-plan-model");
  btnA.click();
  const pop = sb2.__doc.getElementById("planModelPop");
  ok(!!pop && pop.classList.contains("on"), "点按钮 → 弹出下拉菜单");
  ok(pop.parentNode === sb2.__doc.body, "下拉挂在 body 上（不被清单滚动容器裁切）");
  ok(/本任务的执行模型/.test(pop.querySelector(".mt-plan-model-head").textContent), "下拉有标题");
  let opts = pop.querySelectorAll(".mt-plan-model-opt");
  ok(opts.length === 4, "四个可选模型（服务商分组的并集）");
  ok(
    pop.querySelectorAll(".mt-plan-model-group").length === 2,
    "按服务商分组（DeepSeek 官方 / MTNode 兼容）",
  );
  ok(/glm-4\.6/.test(opts[2].textContent) && opts[2].classList.contains("on"), "当前模型项选中态");
  ok(opts[2].querySelector(".c").textContent === "✓", "当前项打勾");
  ok(!!pop.querySelector("button.mt-plan-model-reset"), "下拉里有「跟随默认（不指定）」");
  ok(parseInt(pop.style.left, 10) >= 0 && parseInt(pop.style.top, 10) > 0, "下拉按按钮位置定位");
  btnA.click();
  ok(!pop.classList.contains("on"), "再点按钮收起下拉");
  btnA.click();
  ok(pop.classList.contains("on"), "再点又展开（可反复改主意）");
  opts = pop.querySelectorAll(".mt-plan-model-opt");
  opts[2].click();
  ok(!pop.classList.contains("on"), "选定后自动收起");
  ok(/glm-4\.6/.test(btnA.textContent), "重复选同一模型也稳定");
  btnA.click();
  opts = pop.querySelectorAll(".mt-plan-model-opt");
  opts[0].click();
  ok(/deepseek-v4-flash/.test(btnA.textContent), "按钮文本 = 所选模型");
  ok(btnA.classList.contains("picked") && !btnA.classList.contains("auto"), "按钮切到 picked 实线态");
  ok(
    /deepseek-v4-flash/.test(btnA.title) && /DeepSeek 官方/.test(btnA.title),
    "按钮悬浮提示含模型与服务商",
  );
  btnA.click();
  sb2.__docFire("pointerdown", { target: mkEl("div") });
  ok(!pop.classList.contains("on"), "点下拉外部 → 收起");
  const btnC = box2.querySelectorAll(".mt-plan-model")[2];
  btnC.click();
  ok(/未登记/.test(pop.textContent) && /no-such-model/.test(pop.textContent), "未登记的建议模型也列出（不静默丢失）");
  ok(pop.querySelectorAll(".mt-plan-model-opt").length === 5, "该项多出「保留建议模型」一条选项");
  pop.querySelector("button.mt-plan-model-reset").click();
  ok(
    /自动（跟随默认）/.test(btnC.textContent) && !btnC.classList.contains("picked"),
    "「跟随默认（不指定）」清空该项模型",
  );
  btnA.click();
  sb2.__host.fire("keydown", { key: "Escape" });
  ok(!pop.classList.contains("on"), "Esc 先收下拉");
  ok(res2 === null, "Esc 收下拉时不取消整个弹窗");
  sb2.__host.fire("keydown", { key: "Escape" });
  await drain();
  ok(res2 && res2.action === "cancel", "下拉已关时 Esc 取消弹窗");
  ok(!pop.classList.contains("on"), "弹窗关闭后下拉不会残留打开态");

  /* ===================== [6] 滚动浏览（结构 + CSS） ===================== */
  console.log("\n[6] 计划多时可滚动浏览 · 样式接线");
  const cssB = read("renderer/css/base.css");
  const grab = (sel) => {
    const i = cssB.indexOf(sel);
    if (i < 0) return "";
    const a = cssB.indexOf("{", i);
    const b = cssB.indexOf("}", a);
    return cssB.slice(a, b);
  };
  const rowsCss = grab(".mt-plan-rows");
  ok(!!rowsCss, "base.css 里有 .mt-plan-rows 规则");
  ok(/overflow:\s*auto/.test(rowsCss), "清单容器可滚动（计划多时滚动浏览）");
  ok(/flex:\s*1/.test(rowsCss), "清单吃掉弹窗剩余高度（窗口拉大 = 看到更多任务）");
  ok(/min-height/.test(rowsCss), "清单有最小高度（窗口缩小时也不塌没）");
  const bodyCss = grab(".mt-dialog-box.mt-plan-box .mt-dialog-body");
  ok(/display:\s*flex/.test(bodyCss) && /min-height:\s*0/.test(bodyCss), "弹窗 body 是弹性盒（滚动区可收缩）");
  const planBoxCss = grab(".mt-dialog-box.mt-form-box.mt-form-wide.mt-plan-box");
  ok(/position:\s*relative/.test(planBoxCss), "plan-box 相对定位（手柄贴右下角）");
  ok(/max-height:\s*none/.test(planBoxCss), "plan-box 解除通用 max-height（否则拉不高）");
  ok(/width:\s*min\(1080px/.test(planBoxCss), "plan-box 默认宽度远大于旧对话框（三列放得下）");
  ok(/height:\s*min\(86vh/.test(planBoxCss), "plan-box 默认高度也抬高");
  ok(/position:\s*sticky/.test(grab(".mt-plan-colhead")), "列名表头吸顶（滚动时不消失）");
  ok(/grid-template-columns/.test(grab(".mt-plan-cols")), "三列用栅格定义");
  ok(
    /minmax\(150px,\s*1fr\)/.test(grab(".mt-plan-cols")) && /minmax\(240px,\s*1\.9fr\)/.test(grab(".mt-plan-cols")),
    "标题窄列 / 详情宽列（详情最占空间）",
  );
  ok(/resize:\s*vertical/.test(grab(".mt-plan-inp")), "textarea 允许用户自己继续拉高");
  ok(/overflow-y:\s*auto/.test(grab(".mt-plan-model-list")), "模型下拉自身可滚动（模型多也不撑爆）");
  ok(/position:\s*fixed/.test(grab(".mt-plan-model-pop")), "下拉 fixed 定位（不随清单滚动漂移）");
  const zPop = /z-index:\s*(\d+)/.exec(grab(".mt-plan-model-pop"));
  const zDlg = /z-index:\s*(\d+)/.exec(grab(".mt-dialog {"));
  ok(!!zPop && !!zDlg && +zPop[1] > +zDlg[1], "下拉层级压过对话框宿主");
  ok(/cursor:\s*nwse-resize/.test(grab(".mt-plan-resize")), "手柄光标 nwse-resize（一眼可拖）");
  ok(/\.mt-plan-resize::after/.test(cssB), "手柄有可视化斜角标记");
  ok(/plan-resizing/.test(cssB), "拖拽期间全局锁定光标与选中");
  ok(/grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(cssB), "窗口极窄时三列退化为纵向（不出横向滚动）");

  /* ===================== [7] 清单编辑与提交 ===================== */
  console.log("\n[7] 清单编辑与提交");
  const sb3 = makeSandbox();
  let res3 = null;
  sb3.planConfirmDialog({}, s0.planParseFromText(PLAN_TEXT)).then((r) => (res3 = r));
  await drain();
  const box3 = sb3.__box;
  const card3 = () => box3.querySelectorAll(".mt-plan-card");
  const btns = (i) => card3()[i].querySelector(".mt-plan-card-head").querySelectorAll("button");
  ok(card3().length === 3, "初始 3 项");
  btns(2)[0].click();
  await drain();
  ok(/同步文档/.test(card3()[1].querySelector("textarea").value), "↑ 上移生效");
  ok(card3().length === 3, "排序不改变项数");
  ok(card3()[1].querySelector("input.mt-plan-para").value === "", "排序后并行组跟着行走（不错位）");
  btns(1)[1].click();
  await drain();
  ok(/同步文档/.test(card3()[2].querySelector("textarea").value), "↓ 下移生效");
  btns(0)[2].click();
  await drain();
  ok(card3().length === 2, "✕ 删除一项");
  const addBtn = box3.querySelector("button.mt-plan-add");
  for (let i = 0; i < 10; i++) addBtn.click();
  await drain();
  ok(card3().length === 8, "＋ 添加任务钳在上限 8 项");
  ok(sb3.__toasts.some((t) => /最多/.test(t)), "超限给 toast 提示");
  const lastCard = card3()[7];
  const nti = lastCard.querySelector("textarea.mt-plan-inp.title");
  ok(nti.__focused === true, "新增任务后焦点直接落在新行标题");
  ok(lastCard.__scrolled === true, "新行自动滚进可视区（清单很长时也看得到）");
  const foot3 = sb3.__doc.getElementById("mtDlgFoot");
  const errP = box3.querySelector("p.mt-form-err");
  ok(errP.hidden === true, "校验提示初始隐藏");
  for (const c of card3()) {
    const a = c.querySelector("textarea.mt-plan-inp.title");
    a.value = "";
    a.fire("input");
  }
  foot3.querySelector(".primary").click();
  ok(errP.hidden === false, "没有有效任务时提示「至少保留一个任务」");
  ok(res3 === null, "校验不过 → 弹窗不关、不提交");
  nti.value = "只留这一项";
  nti.fire("input");
  ok(errP.hidden === true, "重新有标题后错误提示复位");
  sb3.__host.fire("keydown", { key: "Enter", ctrlKey: true });
  await drain();
  ok(res3 && res3.action === "go" && res3.tasks.length === 1, "Ctrl+Enter 提交（只带有效任务）");
  ok(res3.tasks[0].title === "只留这一项", "提交内容取自当前编辑结果");
  const steps = sb3.planBuildSteps([
    { title: "a", parallel: "g" },
    { title: "b", parallel: "g" },
    { title: "c", parallel: "" },
  ]);
  ok(
    steps.length === 2 && steps[0].kind === "par" && steps[1].kind === "seq",
    "执行器未回归：同组并行 · 其余串行",
  );
  ok(sb3.planRouteOfModel("kimi-k2") === "mtnode_1", "模型 → 路由反查可用（执行时按它选服务商）");
  ok(sb3.planRouteOfModel("") === "", "未指定模型 → 无路由（跟随默认）");
  ok(/拖右下角可放大窗口/.test(sb3.__doc.getElementById("mtDlgBody").textContent), "使用说明在弹窗 body 内");
  ok(/自动（跟随默认）/.test(sb3.planModelText({ model: "" })), "未选模型时按钮文案 = 自动（跟随默认）");
  ok(/点击为本任务单独选择/.test(sb3.planModelTip({ model: "" })), "未选模型时提示可点击单独选择");
  ok(/deepseek-v4-pro/.test(sb3.planModelTip({ model: "deepseek-v4-pro" })) && /DeepSeek 官方/.test(sb3.planModelTip({ model: "deepseek-v4-pro" })), "已选模型时提示含模型与服务商");

  /* ===================== [8] 接线 · 零残留 · 词条 ===================== */
  console.log("\n[8] 接线 · 旧实现零残留 · 英文词条");
  const planJs = read("renderer/app-plan.js");
  ok(/app-plan\.js/.test(read("renderer/index.html")), "index.html 引入 app-plan.js");
  ok(planJs.indexOf("mt-plan-sel") < 0, "JS 无旧 <select> 模型选择残留");
  ok(cssB.indexOf(".mt-plan-sel") < 0, "CSS 无 .mt-plan-sel 残留");
  ok(cssB.indexOf(".mt-plan-row {") < 0, "CSS 无旧的单行 .mt-plan-row 布局");
  ok(planJs.indexOf('createElement("select")') < 0, "JS 不再创建 select");
  ok(/createElement\("textarea"\)/.test(planJs), "标题 / 详情用 textarea");
  ok(/pg\.type = "text"/.test(planJs), "只有「并行组」仍是单行 input");
  ok(planJs.indexOf("placeholder=\"详情") < 0, "没有硬编码中文（都走 I18n.t）");
  const i18 = read("renderer/i18n.js");
  for (const k of [
    "拖右下角可放大窗口（双击还原 · ⤢ 最大化）",
    "详情 / 涉及文件 / 边界",
    "执行模型",
    "并行组",
    "本任务的执行模型",
    "模型：自动（跟随默认）· 点击为本任务单独选择",
    "拖拽放大 / 缩小窗口 · 双击还原默认大小",
    "最大化窗口（也可拖右下角自由放大）",
    "模型建议（未登记在模型服务）",
    "同组名的任务并发执行（留空 = 按顺序单独跑）",
  ])
    ok(i18.indexOf(k) >= 0, "英文词条登记：「" + k.slice(0, 16) + "…」");
  ok(i18.indexOf("确认后按清单逐项执行：每项单独一轮") < 0, "废弃旧提示文案已从词条表清掉");
  ok(planJs.indexOf("planFlowDirective") >= 0 && planJs.indexOf("planNodeOffer") >= 0, "对外入口未改动");
  ok(/devAgentModelGroups/.test(read("renderer/app-devnode.js")), "复用开发节点的模型分组函数仍在");
  ok(/planMaybeOffer/.test(read("renderer/app-assist.js")), "会话侧计划入口仍接线");
  ok(/planNodeOffer/.test(read("renderer/app-nodes.js")), "智能节点侧计划入口仍接线");
  ok(/planFlowDirective/.test(read("renderer/app-nodes.js")), "智能节点仍注入任务流程指令");
  const log = read("CHANGELOG-v1.1.md");
  ok(/计划弹窗|计划确认/.test(log), "更新文档记录了计划弹窗");
  ok(/可拉伸|拖.*放大/.test(log), "更新文档写明窗口可拉伸");
  ok(/三列/.test(log), "更新文档写明三列清单");

  /* ===================== [9] 归属绑定 · 弹窗过期 · 终止即永久消失 ===================== */
  console.log("\n[9] 计划归属与会话绑定 · 终止 / 清除即永久消失");
  const sbA = makeSandbox();
  const mkSt = (id) => ({
    id,
    title: "会话 " + id,
    workspace: "",
    preset: "standard",
    provider: "deepseek-official",
    model: "",
    effort: "high",
    messages: [],
    outbox: [],
    archived: false,
  });
  const LIST = [];
  sbA.agentSessions = () => LIST;
  sbA.agentSessionById = (id) => LIST.find((s) => s && s.id === id) || null;
  sbA.S = { agentActiveId: "asA" };
  const sent = [];
  sbA.agentSessionSend = (text, opts) => {
    sent.push({ text, opts });
    return Promise.resolve("ok");
  };
  let persisted = 0;
  sbA.persistAgentSession = () => {
    persisted++;
    return Promise.resolve();
  };
  const A = mkSt("asA");
  LIST.push(A);
  const B = mkSt("asB");
  LIST.push(B);
  const tasks2 = [
    { title: "改弹窗结构", detail: "renderer/app-plan.js", model: "glm-4.6", parallel: "" },
    { title: "同步文档", detail: "CHANGELOG", model: "", parallel: "" },
  ];
  ok(sbA.planStartExecution(A, tasks2, { goal: "治串台" }) === true, "确认后启动执行");
  ok(A.plan && A.plan.sessId === "asA", "计划落盘带归属会话 id");
  ok(A._planExec && A._planExec.sessionId === "asA", "运行时游标记住 owner 会话");
  ok(!!(A._planExec && A._planExec.runId), "游标带本轮 runId（收尾只认这一次执行）");
  ok(sent.length === 1 && sent[0].opts.sessionId === "asA", "任务严格发回 owner 会话（不是当前活动会话）");
  ok(sent[0].opts._planExec === true, "计划轮标记：不注入任务流程 · 不再弹计划框");
  ok(sent[0].opts.planRunId === A._planExec.runId, "计划轮带回 runId");
  ok(sent[0].opts.provider === "mtnode_1" && sent[0].opts.model === "glm-4.6", "该项模型 → 路由与模型按项覆盖");
  ok(A.plan.steps[0].status === "active", "第一项立刻标「执行中」");
  const n0 = sent.length;
  A._roundOutcome = "ok";
  sbA.planExecContinue(A);
  ok(sent.length === n0 + 1, "上一轮正常结束 → 自动续发下一项");
  ok(A.plan.steps[0].status === "done", "上一项结算为已完成");

  /* —— 串台防护：别人的游标 / 别人的计划想在这条会话里跑 —— */
  B.plan = { sessId: "asA", steps: [{ n: 1, title: "别人家的任务", status: "pending" }] };
  B._planExec = {
    sessionId: "asA",
    steps: [{ kind: "seq", task: B.plan.steps[0] }],
    idx: 0,
    done: 0,
    total: 1,
    cur: [],
  };
  const n1 = sent.length;
  sbA.planExecContinue(B);
  ok(sent.length === n1, "游标归属不符 → 一条都不发进这条会话");
  ok(!B._planExec, "串台游标就地丢弃");
  ok(sbA.planCursorOwned({ id: "x", _planExec: { sessionId: "x" } }) === true, "游标归属自己 → 认");
  ok(sbA.planCursorOwned({ id: "x", _planExec: { sessionId: "y" } }) === false, "游标指向别的会话 → 不认");
  ok(sbA.planOwnedHere({ id: "x", plan: { sessId: "x" } }) === true, "计划归属自己 → 认");
  ok(sbA.planOwnedHere({ id: "x", plan: { sessId: "y" } }) === false, "计划归属别人 → 不认");
  ok(sbA.planOwnedHere({ id: "x", plan: { steps: [] } }) === true, "旧存档没有 sessId → 不误伤");

  /* —— 重启载回（水合） —— */
  const C = mkSt("asC");
  LIST.push(C);
  C.plan = { sessId: "asA", steps: [{ n: 1, title: "从 A 复制来的", status: "pending" }] };
  sbA.planHydrateSession(C);
  ok(C.plan === null, "水合：归属不是自己的计划载回即作废");
  const D = mkSt("asD");
  LIST.push(D);
  D.plan = {
    sessId: "asD",
    steps: [
      { n: 1, title: "跑一半", status: "active" },
      { n: 2, title: "还没跑", status: "pending" },
    ],
  };
  D.planDelivered = true;
  D.messages = [{ role: "user", content: "x" }, { role: "assistant", content: "y" }];
  sbA.planHydrateSession(D);
  ok(D.plan && D.plan.steps[0].status === "pending", "水合：进程退出时「执行中」的那步退回待执行");
  ok(!D._planExec, "水合不自动生成游标（不点按钮绝不自己开跑）");
  ok(D._planDelivered === true && D.planDelivered === undefined, "落盘键搬进运行时字段后删掉原键");
  const D2 = mkSt("asD2");
  LIST.push(D2);
  D2.messages = [{ role: "assistant", content: "y" }, { role: "user", content: "用户后来又说了别的" }];
  D2.planDelivered = true;
  sbA.planHydrateSession(D2);
  ok(D2._planDelivered === false, "重启后「▶ 执行计划」不复活：最后一条已不是那份计划");

  /* —— 终止 / 清除 = 永久消失 —— */
  const E = mkSt("asE");
  LIST.push(E);
  E.plan = {
    sessId: "asE",
    steps: [
      { n: 1, title: "已完成", status: "done" },
      { n: 2, title: "在跑", status: "active" },
      { n: 3, title: "没轮到", status: "pending" },
    ],
  };
  E._planExec = { sessionId: "asE", runId: "pr1", steps: [], idx: 1, done: 1, total: 3, cur: [] };
  E.outbox = [
    { id: "o1", text: "【执行已确认计划 · 任务 3/3】没轮到" },
    { id: "o2", text: "用户自己的消息" },
  ];
  E._planDlgPending = true;
  E._planDlgWait = 1;
  E._planDelivered = true;
  const p0 = persisted;
  ok(sbA.planDrop(E, "cancelled") === true, "planDrop 报告这份计划确实存在过");
  ok(E.plan === null && !E._planExec, "终止后：计划数据与游标全清（面板不再挂着旧清单）");
  ok(!E._planDlgPending && E._planDelivered === false, "挂起标记与「▶ 执行计划」标记一起复位");
  ok(E.outbox.length === 1 && E.outbox[0].id === "o2", "队列里这份计划的残留任务被剔除 · 用户自己的消息保留");
  ok(persisted > p0, "清除即刻落盘（重启后不会再回来）");
  ok(sbA.planDrop(E, "cancelled") === false, "再终止一次 = 无操作");
  const F = mkSt("asF");
  LIST.push(F);
  F.plan = { sessId: "asF", steps: [{ n: 1, title: "在跑", status: "active" }] };
  ok(sbA.planInterruptRound(F) === true, "非终止的中断：仍可退回待执行 + 手动续跑");
  ok(F.plan && F.plan.steps[0].status === "pending", "非终止：那一项退回「待执行」");
  const F2 = mkSt("asF2");
  LIST.push(F2);
  F2.plan = { sessId: "asF2", steps: [{ n: 1, title: "在跑", status: "active" }] };
  F2._planExec = { sessionId: "asF2", runId: "pr2", steps: [], idx: 0, done: 0, total: 1, cur: [] };
  ok(sbA.planInterruptRound(F2, { mode: "drop" }) === true, "终止那一轮：mode=drop 直接作废整份计划");
  ok(F2.plan === null && !F2._planExec, "drop 模式不留 pending、不留续跑入口");

  /* —— 确认弹窗过期判定 —— */
  const G = mkSt("asG");
  LIST.push(G);
  const planG = { sessId: "asG", goal: "g", tasks: [{ title: "t1" }] };
  ok(sbA.planOfferStale({ kind: "session", st: G, plan: planG, gen: 0 }) === false, "全新弹窗不过期");
  ok(
    sbA.planOfferStale({ kind: "session", st: G, plan: { sessId: "asA" }, gen: 0 }) === true,
    "归属对不上 → 过期",
  );
  G._planDrops = 1;
  ok(sbA.planOfferStale({ kind: "session", st: G, plan: planG, gen: 0 }) === true, "期间被终止 / 清除过 → 过期");
  G._planDrops = 0;
  G._planExec = { sessionId: "asG" };
  ok(sbA.planOfferStale({ kind: "session", st: G, plan: planG, gen: 0 }) === true, "该会话正跑着另一份计划 → 旧弹窗过期");
  delete G._planExec;
  G.archived = true;
  ok(sbA.planOfferStale({ kind: "session", st: G, plan: planG, gen: 0 }) === true, "会话归档 → 弹窗过期");
  G.archived = false;
  ok(sbA.planOfferStale({ kind: "node", node: {} }) === false, "节点模式不受会话归属规则影响");
  ok(sbA.planIsExecText("【执行已确认计划 · 任务 2/3】x") === true, "识别中文计划抬头");
  ok(sbA.planIsExecText("[Execute confirmed plan · parallel task]x") === true, "识别英文计划抬头");
  ok(sbA.planIsExecText("帮我改个按钮") === false, "普通消息不会被误判成计划任务");

  /* —— 端到端：弹窗挂在屏幕上时用户改口 → 再点「确认执行」也不启动 —— */
  const H = mkSt("asH");
  const sbQ = makeSandbox();
  sbQ.agentSessions = () => [H];
  sbQ.agentSessionById = (id) => (id === "asH" ? H : null);
  sbQ.S = { agentActiveId: "asH" };
  const sentQ = [];
  sbQ.agentSessionSend = (text, opts) => {
    sentQ.push({ text, opts });
    return Promise.resolve("ok");
  };
  sbQ.persistAgentSession = () => Promise.resolve();
  let offerRes = null;
  void sbQ
    .planOfferPush({
      kind: "session",
      st: H,
      owner: H,
      plan: { goal: "g", excludes: [], tasks: [{ title: "一项任务", detail: "", model: "", parallel: "" }] },
    })
    .then((r) => (offerRes = r));
  await drain();
  ok(hostOn(sbQ.__host), "确认弹窗已弹出（排队队首）");
  sbQ.planStalePendingOffers(H, "userRound");
  sbQ.__doc.getElementById("mtDlgFoot").querySelector(".primary").click();
  await drain();
  ok(!H.plan && !H._planExec, "用户改口后点「确认执行」→ 不启动（不会突然跑旧计划）");
  ok(sentQ.length === 0, "过期弹窗提交后一条任务都没发");
  ok(sbQ.__toasts.some((x) => /已过期|会话已关闭/.test(x)), "过期后给用户明确提示");
  ok(offerRes === "cancel", "过期弹窗按取消收尾（挂起标记得以复位）");

  /* —— 端到端：正常确认 → 只开在归属会话上 —— */
  const K = mkSt("asK");
  const sbR = makeSandbox();
  sbR.agentSessions = () => [K];
  sbR.agentSessionById = (id) => (id === "asK" ? K : null);
  sbR.S = { agentActiveId: "asK" };
  const sentR = [];
  sbR.agentSessionSend = (text, opts) => {
    sentR.push({ text, opts });
    return Promise.resolve("ok");
  };
  sbR.persistAgentSession = () => Promise.resolve();
  void sbR.planOfferPush({
    kind: "session",
    st: K,
    owner: K,
    plan: { goal: "g", excludes: [], tasks: [{ title: "第一项", detail: "", model: "", parallel: "" }] },
  });
  await drain();
  sbR.__doc.getElementById("mtDlgFoot").querySelector(".primary").click();
  await drain();
  ok(K.plan && K.plan.sessId === "asK", "确认执行：计划落在它自己的会话上");
  ok(sentR.length === 1 && sentR[0].opts.sessionId === "asK", "首项任务发回归属会话");
  K._planHydrated = false;
  sbR.planHydrateSession(K);
  ok(K.plan && K.plan.steps[0].status === "pending", "重启载回：未完成项仍可「▶ 继续执行」（用户点才算数）");
  ok(!K._planExec, "载回不自动生成游标");

  /* —— 接线：会话侧收尾规则 —— */
  const assistJs = read("renderer/app-assist.js");
  ok(/planExecMsg &&[\s\S]{0,520}planExecContinue\(st\)/.test(assistJs), "只有计划执行器自己那一轮结束后才自动续跑");
  ok(/_planExec\.runId[\s\S]{0,80}opts\.planRunId/.test(assistJs), "续跑前核对 runId（旧轮次收尾不能驱动新执行）");
  ok(/planDrop\(st, "cancelled"\)/.test(assistJs), "终止那一路：计划即刻清除");
  ok(/planStalePendingOffers\(st, "userRound"\)/.test(assistJs), "用户另起一轮：作废排队中的计划弹窗与游标");
  ok(!/planInterruptRound\(st\);/.test(assistJs), "终止不再只是「退回待执行留个续跑按钮」");
  ok(/if \(!st \|\| !st\.plan\) return;/.test(read("renderer/app-plan.js")) === true, "无主计划各处早退（不给别的会话当输入）");
  const i18b = read("renderer/i18n.js");
  for (const k of [
    "已终止：本会话的计划清单已清除",
    "这份计划已过期或所属会话已关闭，未执行",
    "这份计划不属于当前会话，已清除",
  ])
    ok(i18b.indexOf(k) >= 0, "英文词条登记：「" + k.slice(0, 14) + "…」");

  /* ===================== [10] 串台修复回归验收 ===================== */
  console.log("\n[10] 串台修复回归 · 零继承 / 作废水合 / 残留丢弃 / 会话隔离");

  /* —— ① 新会话零继承：新建「开发 / 细化」会话不再复制旧计划，首轮无「沿用」指令 —— */
  {
    const sbZ = loadSandbox(["renderer/app.js"]);
    const oldZ = mkSt("asZ0");
    oldZ.plan = {
      sessId: "asZ0",
      steps: [{ n: 1, title: "上一份没跑完的计划", status: "pending" }],
    };
    oldZ._planDelivered = true;
    const devNode = {
      id: "dnZ",
      kind: "super",
      dev: true,
      devKind: "module",
      title: "计划修复模块",
      note: "测试零继承",
      devPath: "E:/dev/tools/pipeline-console",
      agentSessionId: null,
      devSessionIds: ["asZ0"],
    };
    const byIdZ = { dnZ: devNode };
    sbZ.agentSessions = () => [oldZ];
    sbZ.devAgentModelOf = () => null;
    sbZ.devKindOf = (n) => (n && n.devKind) || "module";
    sbZ.DEV_KIND_LABEL = {
      module: "模块",
      file: "文件",
      class: "类",
      interface: "接口",
      enum: "枚举",
    };
    sbZ.nodeById = (id) => byIdZ[id] || null;
    sbZ.devChildrenOf = () => [];
    /* devNoteParts 住在 app-devnode.js（本沙箱未加载）：按两段式规则给最小桩，否则 devNodeContractText 会崩 */
    sbZ.devNoteParts = (note) => {
      const s = String(note || "");
      const implM = s.match(/(?:^|\n)【实现】[:：]?\s*([\s\S]*)$/);
      const designM = s.match(/(?:^|\n)【功能】[:：]?\s*([\s\S]*?)(?=\n【实现】|$)/);
      return {
        design: (designM && designM[1].trim()) || (implM ? "" : s.trim()),
        impl: (implM && implM[1].trim()) || "",
      };
    };
    const zsess = sbZ.createDevSessionForNode(devNode, "dev");
    ok(!!zsess && !!zsess.id, "零继承：新建绑定会话正常创建");
    ok(!zsess.plan, "零继承：新会话不携带任何旧计划（空白起步）");
    ok(
      Array.isArray(zsess.messages) && zsess.messages.length === 1,
      "零继承：首轮只有一条消息",
    );
    ok(
      zsess.messages[0] && zsess.messages[0]._src === "dev-node",
      "零继承：首轮消息是 dev-node 开发任务书",
    );
    const ztxt = String((zsess.messages[0] && zsess.messages[0].content) || "");
    ok(ztxt.indexOf("沿用") < 0, "零继承：首轮无「沿用旧计划」指令注入");
    ok(
      oldZ.plan && oldZ.plan.sessId === "asZ0" && oldZ.plan.steps.length === 1,
      "零继承：旧会话那份计划原地未动（不搬走 · 不合并）",
    );
    ok(devNode.agentSessionId === zsess.id, "零继承：新会话正确挂到功能块名下");
    const appJsSrc = read("renderer/app.js");
    ok(
      appJsSrc.indexOf("planInheritFromSession") < 0 &&
        appJsSrc.indexOf("devPlanInheritSource") < 0 &&
        appJsSrc.indexOf("planInheritedBriefText") < 0,
      "接线：app.js 已无跨会话沿用代码（不留死代码防回归复活）",
    );
    const planJsSrc = read("renderer/app-plan.js");
    ok(
      planJsSrc.indexOf("function planInheritFromSession") < 0 &&
        planJsSrc.indexOf("function planInheritedBriefText") < 0,
      "接线：app-plan.js 已无跨会话沿用函数（不留死代码防回归复活）",
    );
  }

  /* —— ② 终止 / 清除 = 永久消失：作废计数随会话落盘，水合后 plan 为空且状态保留 —— */
  {
    const sbH = makeSandbox();
    const stH = mkSt("asH9");
    stH.plan = {
      sessId: "asH9",
      steps: [
        { n: 1, title: "在跑", status: "active" },
        { n: 2, title: "没轮到", status: "pending" },
      ],
    };
    stH._planExec = {
      sessionId: "asH9",
      runId: "prH9",
      steps: [],
      idx: 1,
      done: 1,
      total: 2,
      cur: [],
    };
    let hPersist = 0;
    sbH.persistAgentSession = () => {
      hPersist++;
      return Promise.resolve();
    };
    ok(sbH.planDrop(stH, "cancelled") === true, "作废：终止 / 清除统一收敛到 planDrop");
    ok(stH.plan === null && !stH._planExec, "作废：运行时计划与游标全清");
    ok(Number(stH._planDrops) >= 1, "作废：本会话作废计数 +1");
    ok(hPersist >= 1, "作废：计数随会话即刻落盘（重启可见）");
    const stH2 = mkSt("asH9");
    stH2.planDrops = Number(stH._planDrops) || 1; /* 落盘形态（persistAgentSession 写出的键） */
    stH2.plan = { sessId: "asH9", steps: [{ n: 1, title: "落盘失败窗口的残留", status: "pending" }] };
    stH2.planDelivered = true;
    stH2.messages = [{ role: "assistant", content: "y" }];
    sbH.planHydrateSession(stH2);
    ok(Number(stH2._planDrops) >= 1, "水合：作废计数从配置键载回运行时（作废状态保留）");
    ok(
      stH2.plan === null && !stH2._planExec,
      "水合：作废计数>0 的残留计划就地清除（重启 / 切会话 / 开新会话都再见不到）",
    );
    ok(stH2.planDrops === undefined, "水合：落盘键删除（防旧值回写）");
    const stH3 = mkSt("asH8");
    stH3.plan = { sessId: "asH8", steps: [{ n: 1, title: "剩一项", status: "pending" }] };
    stH3._planDrops = 1;
    sbH.planResumeSession(stH3);
    ok(stH3.plan && !stH3._planExec, "闸门：作废计数>0 时「继续执行」不生成游标、不发送");
    ok(
      sbH.__toasts.some((x) => String(x).indexOf("作废") >= 0),
      "闸门：提示「该计划已作废，无法继续执行」",
    );
  }

  /* —— ③ drain：runId 失效 / 计划已作废的排队残留整条丢弃，绝不当作普通消息发出 —— */
  {
    const sbQ3 = loadSandbox(["renderer/app-plan.js", "renderer/app-assist.js"]);
    const stQ3 = mkSt("asQ9");
    const LISTQ = [stQ3];
    sbQ3.agentSessions = () => LISTQ;
    sbQ3.agentSessionById = (id) => LISTQ.find((s) => s && s.id === id) || null;
    sbQ3.sessionIsRunning = () => false;
    sbQ3.persistAgentSession = () => Promise.resolve();
    sbQ3.toast = () => {};
    sbQ3.updateRunQueuePanel = () => {};
    sbQ3.renderAgentQueueBar = () => {};
    sbQ3.renderAgentSessionSidebar = () => {};
    const sentQ3 = [];
    sbQ3.agentSessionSend = (text, opts) => {
      sentQ3.push({ text, opts });
      return Promise.resolve("ok");
    };
    stQ3.plan = { sessId: "asQ9", steps: [{ n: 1, title: "排队有效计划", status: "pending" }] };
    stQ3._planExec = {
      sessionId: "asQ9",
      runId: "prLive",
      steps: [],
      idx: 0,
      done: 0,
      total: 1,
      cur: [],
    };
    stQ3.outbox = [];
    await sbQ3.agentEnqueueMessage(stQ3, "【执行已确认计划 · 任务 1/1】排队有效任务", {
      _planExec: true,
      planRunId: "prLive",
      sessionId: "asQ9",
    });
    stQ3.outbox.push(
      { id: "obDead", text: "【执行已确认计划 · 任务 2/2】已被终止的残留", _planExec: true, planRunId: "prDead", sessionId: "asQ9" },
      { id: "obOther", text: "【执行已确认计划 · 任务 3/3】另起一轮的残留", _planExec: true, planRunId: "prOther", sessionId: "asQ9" },
      { id: "obPlain", text: "用户自己的排队长按", sessionId: "asQ9" },
    );
    const nBefore = sentQ3.length;
    await sbQ3.agentDrainQueue(stQ3);
    ok(sentQ3.length === nBefore + 2, "排水：有效计划轮 + 普通消息各发出一次（共 2 条）");
    ok(
      sentQ3.some(
        (x) =>
          x.opts &&
          x.opts._planExec === true &&
          x.opts.planRunId === "prLive" &&
          x.opts.sessionId === "asQ9",
      ),
      "排水：有效计划条目原样恢复 opts（_planExec / planRunId / sessionId）",
    );
    ok(
      sentQ3.some(
        (x) =>
          x.opts &&
          x.opts._planExec === undefined &&
          x.opts.sessionId === "asQ9" &&
          String(x.text).indexOf("排队长按") >= 0,
      ),
      "排水：普通消息固定归属本会话正常发出",
    );
    ok(
      !sentQ3.some(
        (x) =>
          String(x.text).indexOf("已被终止") >= 0 ||
          String(x.text).indexOf("另起一轮") >= 0,
      ),
      "排水：runId 失效 / 计划已作废的残留整条丢弃，绝不发送",
    );
    ok(stQ3.outbox.length === 0, "排水：队列清空（丢弃项不残留）");
  }

  /* —— ④ 会话 A / B 各持一份计划互不串；交叉视图即就地作废 —— */
  {
    const sbAB = makeSandbox();
    const stA9 = mkSt("asA9");
    const stB9 = mkSt("asB9");
    stA9.plan = { sessId: "asA9", steps: [{ n: 1, title: "A 的专属任务", status: "pending" }] };
    stB9.plan = { sessId: "asB9", steps: [{ n: 1, title: "B 的专属任务", status: "pending" }] };
    ok(
      sbAB.planOwnedHere(stA9) === true && sbAB.planOwnedHere(stB9) === true,
      "A/B 各自持有自己的计划 → 各自认领通过",
    );
    ok(
      sbAB.planOwnedHere({ id: "asA9", plan: { sessId: "asB9", steps: [] } }) === false,
      "A 的会话拿着 B 的计划 → 不认领",
    );
    const panelAB = mkEl("div");
    panelAB.id = "agentPlan";
    sbAB.__doc.body.appendChild(panelAB);
    const stX9 = mkSt("asA9");
    stX9.plan = { sessId: "asB9", steps: [{ n: 1, title: "串进 A 会话的 B 计划", status: "pending" }] };
    sbAB.renderAgentPlanPanel(stX9);
    ok(stX9.plan === null, "交叉视图：归属不符的计划渲染即就地作废（planDrop foreign）");
    ok(panelAB.hidden === true, "交叉视图：面板隐藏，不冒出别人的清单");
    sbAB.renderAgentPlanPanel(stA9);
    ok(
      panelAB.hidden === false && String(panelAB.textContent).indexOf("A 的专属任务") >= 0,
      "A 的面板正常渲染自己的计划",
    );
    sbAB.renderAgentPlanPanel(stB9);
    ok(
      panelAB.hidden === false && String(panelAB.textContent).indexOf("B 的专属任务") >= 0,
      "B 的面板正常渲染自己的计划（互不干扰）",
    );
  }

  /* —— ⑤ planExecContinue：会话忙时不发送、不入队，就地收尾本轮 —— */
  {
    const sbE9 = makeSandbox();
    const stE9 = mkSt("asE9");
    stE9.plan = {
      sessId: "asE9",
      steps: [
        { n: 1, title: "正在跑", status: "active" },
        { n: 2, title: "排队等", status: "pending" },
      ],
    };
    stE9._planExec = {
      sessionId: "asE9",
      runId: "prE9",
      steps: [{ kind: "seq", task: stE9.plan.steps[1] }],
      idx: 1,
      done: 1,
      total: 2,
      cur: [],
    };
    stE9.outbox = [];
    sbE9.agentSessions = () => [stE9];
    sbE9.sessionIsRunning = () => true; /* 并行组收尾撞上用户又发了一轮 */
    const sentE9 = [];
    sbE9.agentSessionSend = (text, opts) => {
      sentE9.push({ text, opts });
      return Promise.resolve("ok");
    };
    sbE9.planExecContinue(stE9);
    ok(sentE9.length === 0, "忙时不发送：剩余任务的下一项绝不发出");
    ok(
      Array.isArray(stE9.outbox) && stE9.outbox.length === 0,
      "忙时不入队：下一项没有被压进发送队列",
    );
    ok(!stE9._planExec, "忙时收尾：执行游标就地摘除（不再有幽灵续跑）");
    ok(
      stE9.plan && stE9.plan.steps[0].status === "pending",
      "忙时收尾：在跑的那一项退回待执行",
    );
    ok(stE9.plan.steps[1].status === "pending", "忙时收尾：未跑项保持待执行（面板可 ▶ 手动续跑）");
    ok(
      sbE9.__toasts.some((x) => String(x).indexOf("未完成") >= 0),
      "忙时收尾：提示未完成项可在「计划」面板继续执行",
    );
  }

  /* ===================== [11] 并行组运行过程可观测（live 轨迹 / 记账 / 存档干净） ===================== */
  console.log("\n[11] 计划并行组看得见跑动过程 · runKey 可取消 · 轨迹不落盘");
  {
    const sbL = makeSandbox();
    const stL = mkSt("asL1");
    stL.workspace = "E:/dev/tools/pipeline-console";
    const panelL = mkEl("div");
    panelL.id = "agentPlan";
    sbL.__doc.body.appendChild(panelL);
    sbL.S = { agentActiveId: "asL1" };
    let rq = 0;
    sbL.updateRunQueuePanel = () => {
      rq++;
    };
    stL._planOpen = 0; /* 展开第一项：详情下方的流式转写区才渲染 */
    ok(
      sbL.planStartExecution(
        stL,
        [
          { title: "任务甲", detail: "改 A 文件", model: "", parallel: "ui" },
          { title: "任务乙", detail: "改 B 文件", model: "", parallel: "ui" },
        ],
        { goal: "并行组要看得见" },
      ) === true,
      "同组两项 → 确认执行即并发起跑",
    );
    /* —— 开跑的同步段：网关事件已经汇进各自的 t._live —— */
    const keysL = (sbL.__dshRuns || []).map((r) => r.runKey);
    ok(
      (sbL.__dshRuns || []).length === 2 &&
        keysL.every((k) => /^planpar:asL1:\d+$/.test(k)),
      "两个子任务的 runKey 形如 planpar:<会话>:<步骤>（可预测才谈得上取消）",
    );
    ok(new Set(keysL).size === 2, "两把 runKey 互不相同（逐个取消时不会停错、漏停）");
    ok(
      (sbL.__dshRuns || []).every((r) => r.hasOnEvent),
      "每个子任务都接上了 onEvent 事件通道（修复前压根没传 → 全程静默）",
    );
    const tA = stL.plan.steps[0];
    const tB = stL.plan.steps[1];
    ok(!!tA._live && !!tB._live && tA._live !== tB._live, "每个在跑的步骤各挂一份 live 轨迹（互不覆盖）");
    ok(
      /并行产出 1/.test(tA._live.text) && Number(tA._live.chars) > 0,
      "live 收正文：text 事件进尾部缓冲 + 输出字数累计",
    );
    ok(
      tA._live.tools.length === 1 &&
        tA._live.tools[0].name === "read" &&
        tA._live.tools[0].state === "done" &&
        /文件内容 ok/.test(tA._live.tools[0].result),
      "live 收工具：调用入队 → tool-result 回填状态与结果摘要",
    );
    ok(
      tA._live.usage.inputTokens === 120 && tA._live.usage.outputTokens === 34,
      "live 累计 token 用量（状态条 ↑输入 ↓输出 读它）",
    );
    ok(
      tA._live.toolCalls === 1 && tA._live.lastTool === "read" && tA._live.state === "running",
      "状态条读数齐活：工具次数 · 最近工具 · running",
    );
    const parL = stL._planPar;
    ok(
      !!parL && parL.group === "ui" && parL.total === 2 && parL.done === 0,
      "整组在 st._planPar 上记账（并行期间 st.running=false，队列只认这份账）",
    );
    ok(
      !!parL && (parL.runKeys || []).join() === keysL.join(),
      "记账里的 runKeys 与实际发起的一致（停止入口照它逐个取消）",
    );
    ok(rq >= 1, "开跑即刻通知运行队列刷新（左下角这才冒出「并行任务」那一行）");
    /* —— 展示口径（本 bug 根因）：并行期间 st.running 故意为 false，
       会话列表条目 / 开发块徽标只看 sessionIsRunning 就整段显示「空闲」。 —— */
    ok(!stL.running, "并行期间会话自己的 running 仍是 false（改口语义不许动）");
    ok(
      sbL.sessionBusyForUi(stL) === true,
      "sessionBusyForUi：并行组在跑 → 展示口径判为「运行中」",
    );
    ok(
      sbL.planParBusy(stL) === true && sbL.planParBusy({ id: "x" }) === false,
      "planParBusy 只认这一组的账（没有 _planPar → false）",
    );
    ok(
      sbL.sessionBusyForUi(null) === false &&
        sbL.sessionBusyForUi({ id: "x" }) === false,
      "没有会话 / 什么也没跑 → 展示口径不误报",
    );
    stL._planPar.done = stL._planPar.total;
    ok(
      sbL.sessionBusyForUi(stL) === false,
      "整组已全部了结（done>=total）→ 展示口径即刻回到空闲（不挂残灯）",
    );
    stL._planPar.done = 0;
    /* —— 观测面闭环：面板真的把这份数据画出来了 —— */
    sbL.renderAgentPlanPanel(stL);
    const statL = panelL.querySelector(".ap-stat");
    const liveL = panelL.querySelector(".ap-live");
    ok(
      !!statL && /🔧 read/.test(statL.textContent) && /字/.test(statL.textContent),
      "执行中的行内状态条有实时读数（最近工具 · 输出字数）",
    );
    ok(!!statL && /已用时/.test(statL.title), "状态条悬浮给完整读数（已用时等）");
    ok(
      !!liveL &&
        /read/.test(liveL.textContent) &&
        /并行产出 1/.test(liveL.textContent) &&
        liveL.getAttribute("data-live-state") === "running",
      "展开项下方渲染流式转写区：工具行 + 正文尾部 + 状态标记",
    );
    /* —— 整组了结：轨迹与记账全部摘除，结果照旧回填 —— */
    await drain();
    ok(!tA._live && !tB._live, "整组结束后 t._live 归 null（不留幽灵转圈）");
    ok(!stL._planPar, "st._planPar 已摘除（队列那行随之收掉）");
    ok(rq >= 2, "收尾再通知一次队列（组的账变了要立刻反映）");
    ok(
      sbL.sessionBusyForUi(stL) === false,
      "整组了结 → 展示口径不再判运行中（会话列表条目随之收起转圈）",
    );
    /* —— 接线：三个展示面读的必须是同一份展示口径 —— */
    const assistParSrc = read("renderer/app-assist.js");
    const devnParSrc = read("renderer/app-devnode.js");
    const appParSrc = read("renderer/app.js");
    ok(
      assistParSrc.indexOf("sessionBusyForUi(s)") >= 0,
      "会话列表条目（renderAgentSessionSidebar）改用展示口径",
    );
    ok(
      devnParSrc.indexOf("sessionBusyForUi(st)") >= 0,
      "开发块「绑定会话运行中」（devNodeRunningState）改用展示口径",
    );
    ok(
      appParSrc.indexOf("sessionBusyForUi(st)") >= 0 &&
        appParSrc.indexOf("sessionBusyForUi(s)") >= 0,
      "队列副标题与逐条停止 / 全部终止都认并行组在跑的会话",
    );
    ok(
      appParSrc.indexOf("planParBusy(st)") >= 0,
      "队列的并行组行复用同一份忙判定（三处口径不分叉）",
    );
    ok(
      /function planParNotify\(\)/.test(read("renderer/app-plan.js")) &&
        read("renderer/app-plan.js").indexOf("renderAgentSessionSidebar()") >= 0,
      "并行组开跑 / 收尾统一通知：队列 + 会话列表 + 画布徽标一起翻",
    );
    const i18Par = require("../renderer/i18n.js");
    i18Par.setLocale("en");
    ok(
      i18Par.t("计划并行任务运行中（不打断你继续发消息）") !==
        "计划并行任务运行中（不打断你继续发消息）",
      "会话条目并行运行中的悬浮文案有英文词条",
    );
    i18Par.setLocale("zh");
    ok(
      stL.plan.steps[0].status === "done" && stL.plan.steps[1].status === "done",
      "两项各自定格为「已完成」",
    );
    ok(!stL._planExec, "整份计划跑完 → 游标摘除");
    const lastMsgL = stL.messages[stL.messages.length - 1] || {};
    const lastL = String(lastMsgL.content || "");
    ok(
      /【并行任务完成】/.test(lastL) &&
        /【任务甲】done-1/.test(lastL) &&
        /【任务乙】done-2/.test(lastL) &&
        lastMsgL._src === "plan-exec",
      "结果仍按原契约回填成一条 plan-exec 消息（本次只加观测，不改收尾）",
    );
    ok(sbL.__toasts.some((x) => /已全部执行完成/.test(String(x))), "全部完成给明确 toast");
    /* —— 落盘安全：运行时字段绝不进存档 —— */
    ok(
      JSON.stringify(stL.plan).indexOf("_live") >= 0,
      "内存里那份 plan 确实带着运行时字段（下一条断言才不空转）",
    );
    const cleanL = JSON.stringify(sbL.planSanitize(stL.plan));
    ok(
      cleanL.indexOf("_live") < 0 && cleanL.indexOf("_planPar") < 0 && cleanL.indexOf("startedAt") < 0,
      "planSanitize 白名单重建：live 轨迹与并行记账一律不落盘",
    );
    const snapA = sbL.planLiveOf(tA);
    ok(
      !!snapA && snapA.state === "done" && /并行产出 1/.test(snapA.text),
      "渲染侧快照：了结后仍回看得知这一项跑过什么",
    );
  }

  /* —— 并行子任务出错：状态与 error 摘要看得见（失败行不再只是一个静态图标） —— */
  {
    const sbF = makeSandbox();
    const stF = mkSt("asF1");
    let callN = 0;
    sbF.dshRunTask = async (input, opts) => {
      opts = opts || {};
      const emit = (type, data) => {
        if (typeof opts.onEvent === "function") opts.onEvent(type, data);
      };
      callN++;
      emit("text", { text: "跑到一半" });
      emit("tool", { callId: "cx", name: "grep", args: "{}" });
      if (callN === 2) {
        emit("error", { message: "网关 500：模型服务无响应" });
        throw new Error("网关 500");
      }
      return "ok";
    };
    const panelF = mkEl("div");
    panelF.id = "agentPlan";
    sbF.__doc.body.appendChild(panelF);
    sbF.S = { agentActiveId: "asF1" };
    stF._planOpen = 1;
    ok(
      sbF.planStartExecution(
        stF,
        [
          { title: "甲", detail: "", model: "", parallel: "g" },
          { title: "乙", detail: "", model: "", parallel: "g" },
        ],
        { goal: "并行里一项失败" },
      ) === true,
      "同组两项并发起跑（其中第二项会失败）",
    );
    const fB = stF.plan.steps[1];
    ok(
      !!fB._live && fB._live.state === "error" && fB._live.errors.length >= 1,
      "error 事件即刻写进该子任务的轨迹（谁挂了 · 为什么挂）",
    );
    sbF.renderAgentPlanPanel(stF);
    const liveF = panelF.querySelector(".ap-live");
    ok(
      !!liveF && liveF.getAttribute("data-live-state") === "error",
      "转写区带 error 态标记（CSS 靠它把左边框涂红）",
    );
    await drain();
    ok(
      stF.plan.steps[1].status === "failed" && stF.plan.steps[0].status === "done",
      "一项失败不牵连另一项：各自定格",
    );
    ok(!fB._live && !stF._planPar, "失败收尾同样摘除轨迹与整组记账");
    const snapF = sbF.planLiveOf(stF.plan.steps[1]);
    ok(
      !!snapF && snapF.state === "error" && /网关 500/.test(sbF.planLiveErrText(snapF)),
      "失败行的 error 摘要来自轨迹快照（结束后仍然可读）",
    );
    const lastF = String((stF.messages[stF.messages.length - 1] || {}).content || "");
    ok(/【乙】/.test(lastF) && /失败：.*网关 500/.test(lastF), "失败结果按原契约写进汇总消息");
  }

  /* ── 会话「计划」清单高度：--ap-h = 最小高度，上限按当下 DOM 实测夹 ──
   * 回归「计划列表压住下方对话输入栏 / 收起后多半被下方遮挡」这条 bug 的**算法侧**：
   * 底栏每一项都必须进预算（含上一版整块漏掉的发送队列），兄弟项按「没被压缩时的自然高」
   * 算而不是按被砍过的 rect 算，面板装饰实测优先。
   * 真实的让位次序（消息区 → 计划清单 → 任务卡 / 队列 → 输入区钉死）由
   * test/layout-agent-plan.js 在真 Blink 里逐格量，迷你 DOM 不假装有布局引擎。 */
  {
    const sbHt = makeSandbox();
    const hostHt = mkEl("div");
    hostHt.className = "agent-body";
    hostHt.clientHeight = 600; /* .agent-body 此刻的可用高度 */
    const panelHt = mkEl("div");
    panelHt.id = "agentPlan";
    panelHt.className = "agent-todo agent-plan";
    /* 迷你 DOM 不维护 parentElement，而夹取要顺着宿主量高度，这里手工补上 */
    panelHt.parentElement = hostHt;
    hostHt.appendChild(panelHt);
    sbHt.__doc.body.appendChild(hostHt);
    panelHt.style.setProperty = function (k, v) {
      this[k] = v;
    };
    /* 落盘口：只有「松手 / 双击」这类终态才该调 configSave，条数即落盘次数 */
    const saves = [];
    sbHt.window.api = {
      configSave: async (c) => {
        saves.push(c.agentPlanH);
        return true;
      },
    };
    const clampMax = () => sbHt.clampAgentPlanH(9999);
    /* 沙箱里没有 getComputedStyle → 装饰一律走 app-plan.js 的兜底常量：
       600 −（消息区下限 72 + 输入区 132 + 头部 36 + 把手 7 + 面板外边距 2）= 351 */
    ok(sbHt.clampAgentPlanH(40) === 120, "再矮也守住最小高度 120（旧的封顶值 120 如今是最小值）");
    ok(sbHt.clampAgentPlanH(0) === 120, "非法高度回落到最小高度");
    ok(
      clampMax() === 351,
      "基线上限 351 = 600 −（消息区下限 72 + 输入区兜底 132 + 头部兜底 36 + 把手 7 + 面板外边距 2）",
    );
    ok(
      sbHt.agentPlanCurMaxH() === 351,
      "把手 tooltip 报的「当前最多」与夹取上限同一个口径（不是两套数）",
    );
    /* 用户诉求：维持最小高度的基础上还能继续加高 —— 底栏腾出的空间必须 1:1 给清单 */
    hostHt.clientHeight = 700;
    ok(clampMax() === 451, "底栏多出的 100px 原样让给清单（不做二次折损）");
    hostHt.clientHeight = 600;
    /* 面板自身装饰 = 实测优先（旧版写死 34+7+2，头部/把手一长高预算就虚高，清单越过下沿） */
    const headHt = mkEl("div");
    headHt.className = "at-head";
    headHt.__boxH = 40;
    panelHt.appendChild(headHt);
    ok(clampMax() === 347, "头部实测 40px（比兜底 36 高 4）→ 上限立刻降 4：装饰是量出来的");
    const gripHt = mkEl("div");
    gripHt.className = "ap-grip";
    gripHt.__boxH = 12;
    panelHt.appendChild(gripHt);
    ok(clampMax() === 342, "把手实测 12px（比兜底 7 高 5）→ 再降 5：展开态不能把把手算漏");

    /* 输入区（对话栏）变高 → 上限立刻跟着降。这正是「chips 一换行就压住输入栏」那一格 */
    const composerHt = mkEl("div");
    composerHt.className = "agent-composer";
    composerHt.__boxH = 200; /* 窄窗口下 chips 换成两行，输入区被撑高 */
    sbHt.__doc.querySelector = (sel) => (sel === ".agent-composer" ? composerHt : null);
    ok(clampMax() === 274, "输入区实测 200px（比兜底 132 高 68）→ 上限降到 274");
    ok(sbHt.clampAgentPlanH(300) === 274, "超过上限的设定被夹到实测上限，不会压住输入栏");

    /* 发送队列 #agentQueue：上一版**整块漏算**（实测凭空近百 px，正好压在输入栏那一截上）。
       它在契约④' 之后是可收缩兄弟项 → 必须按「没被压缩时的自然高」扣，不能量被砍过的 rect，
       否则「面板越扁 → 预算越空 → 上限越算越大」（测量台 D 组抓到 −74~−80px 的那条自反馈）。 */
    const queueHt = mkEl("div");
    queueHt.id = "agentQueue";
    queueHt.className = "agent-queue";
    queueHt.__boxH = 20; /* 被 flex 砍过之后的实测高：拿它算预算就是错的 */
    const qHead = mkEl("div");
    qHead.className = "aq-head";
    qHead.__boxH = 35;
    const qList = mkEl("div");
    qList.className = "aq-list";
    qList.scrollHeight = 60; /* 未压缩时内容要吃掉的 60px */
    queueHt.appendChild(qHead);
    queueHt.appendChild(qList);
    hostHt.appendChild(queueHt);
    ok(
      clampMax() === 179 && clampMax() !== 254,
      "队列在场 → 扣自然高 95（头部 35 + 清单 60），不是被砍过的 20：预算 274 → 179",
    );
    queueHt.hidden = true;
    ok(clampMax() === 274, "队列收起（hidden）后一分地都不占：空壳不得留在预算里");
    queueHt.hidden = false;

    /* 消息区（契约① 的唯一填充项）不参与预算求和 —— 真因就是它拿整段会话正文的高来抢地方 */
    const wrapHt = mkEl("div");
    wrapHt.className = "hist-scroll-wrap is-flex-fill";
    wrapHt.__boxH = 400;
    wrapHt.scrollHeight = 3000; /* 会话很长的实际情况 */
    hostHt.appendChild(wrapHt);
    ok(
      clampMax() === 179,
      "消息区内容 3000px 也不挤清单：只按 PLAN_LIST_MSG_MIN_H=72 预留（它先让位，见 layout smoke）",
    );

    /* 极端矮窗口：预算已经是负的 → 仍回落到最小高度，物理放不下时由 CSS 的 flex 收缩清单
       （绝不再溢出成重叠；真实收缩量由 test/layout-agent-plan.js 逐格判定） */
    hostHt.clientHeight = 260;
    ok(clampMax() === 120, "矮到装不下时仍返回最小高度 120，收缩交给 flex 布局兜底");
    hostHt.clientHeight = 600;

    /* —— 清回干净现场（只剩面板 → 基线 351），再验「设定值 / 临时夹取」两份数的语义 —— */
    hostHt.childNodes.length = 0;
    hostHt.appendChild(panelHt);
    panelHt.innerHTML = "";
    sbHt.__doc.querySelector = () => null;
    ok(clampMax() === 351, "现场复位回到基线 351（去掉全部兄弟项与实测装饰）");
    sbHt.S.config = { agentPlanH: 300 };
    ok(sbHt.clampAgentPlanH(300) === 300, "空间放得下 300 → 原样给 300：有地方就绝不额外摁住");
    sbHt.applyAgentPlanH(300, true);
    ok(
      sbHt.S.agentPlanH === 300 &&
        panelHt.style["--ap-h"] === "300px" &&
        sbHt.S.config.agentPlanH === 300 &&
        saves.length === 1,
      "设定值写成 #agentPlan 的 --ap-h（清单最小高度 = flex-basis）并落进 S.config",
    );
    hostHt.clientHeight = 300; /* 底栏突然被挤窄：拖分栏 / chips 换行 / 队列出现 */
    sbHt.applyAgentPlanH(null, false);
    ok(
      sbHt.S.agentPlanH === 120 &&
        sbHt.S.config.agentPlanH === 300 &&
        panelHt.style["--ap-h"] === "120px" &&
        saves.length === 1,
      "applyAgentPlanH(null) = 按设定值重夹：显示值临时夹到 120，设定值 300 保持原样且不落盘",
    );
    hostHt.clientHeight = 600;
    sbHt.applyAgentPlanH(null, false);
    ok(
      sbHt.S.agentPlanH === 300 && panelHt.style["--ap-h"] === "300px",
      "底栏恢复后清单长回设定值 300（不会停在被临时夹小的 120）—— ResizeObserver 重夹走的就是这条路径",
    );
    sbHt.applyAgentPlanH(40, false);
    ok(
      sbHt.S.agentPlanH === 120 && panelHt.style["--ap-h"] === "120px",
      "拖到最小以下仍停在 120px：清单至少有这么高，不会塌成一截",
    );

    /* —— 拖把手：过程中实时夹到「此刻最大值」且绝不落盘，松手才写设定值（任务 3 的口径） —— */
    panelHt.appendChild(headHt);
    panelHt.appendChild(gripHt);
    sbHt.S.agentPlanH = 300;
    sbHt.bindAgentPlanGrip(panelHt, gripHt);
    ok(
      sbHt.S.agentPlanH === 300 && saves.length === 1,
      "绑把手时顺带的 watchAgentPlanHost 在无 ResizeObserver 环境下静默降级（不改值、不落盘、不抛）",
    );
    gripHt.fire("pointerdown", { button: 0, clientY: 700 });
    sbHt.__docFire("pointermove", { clientY: 200 }); /* 向上拖 500px = 想要 800px */
    ok(
      sbHt.S.agentPlanH === 342 && saves.length === 1,
      "拖动过程中每一步都按实时剩余空间夹住（此刻上限 342 = 600−72−132−40−12−2），绝不中途落盘",
    );
    ok(
      /342px/.test(gripHt.title) && /当前最多/.test(gripHt.title),
      "把手 tooltip 实时报「现在多少 / 当前最多多少」：拖到顶了看得见，不会以为卡住",
    );
    sbHt.__docFire("pointermove", { clientY: 900 }); /* 反向拖回：startH 300 + (700−900) = 100 */
    ok(sbHt.S.agentPlanH === 120, "向下拖同样被最小高度接住（120），不会塌成一条缝");
    sbHt.__docFire("pointermove", { clientY: 200 });
    sbHt.__docFire("pointerup", {});
    ok(
      sbHt.S.agentPlanH === 342 && saves.length === 2 && saves[saves.length - 1] === 342,
      "松手才落盘：落的正是此刻放得下的最大值 342（用户设定的就是它）",
    );
    gripHt.fire("dblclick", {});
    ok(
      sbHt.S.agentPlanH === 120 && sbHt.S.config.agentPlanH === 120 && saves.length === 3,
      "双击把手 → 回到默认最小高度 120 并落盘",
    );

    /* 视口保险：宿主量不到（会话面板还没显示）时退回视口 70% —— 放在最后，它会摘掉 parentElement */
    sbHt.__doc.querySelector = () => null;
    panelHt.parentElement = null;
    ok(sbHt.clampAgentPlanH(9999) === 630, "量不到宿主时上限退回视口 70%（900×0.7）");
    /* —— 样式契约（base.css 里编号的 ①–⑤ 不变式）：这一组是**文本面**的护栏，防的是
       「有人把那条规则删了 / 改了，却没人记得让位次序」。真正判定「谁赢了特异度」的
       是 test/layout-agent-plan.js —— 它读真实引擎里生效的计算值，逐格量越界与裁切
       （上一轮就是栽在「同特异度靠加载顺序取胜」这个假设上，grep 判不了这个）。 —— */
    const cssBase = read("renderer/css/base.css");
    /* 规则体按行首 } 收尾：注释里也带 { }，用 indexOf("}") 会截在注释中间 */
    const cssRule = (sel) => {
      const at = cssBase.indexOf(sel);
      if (at < 0) return null;
      const end = cssBase.indexOf("\n}", at);
      return end < 0 ? null : cssBase.slice(at, end + 1);
    };
    const r1 = cssRule(".agent-body>.hist-scroll-wrap.is-flex-fill {");
    ok(
      !!r1 && /flex:\s*1 1 0px/.test(r1) && /min-height:\s*0/.test(r1),
      "契约① 消息区假想主尺寸归 0（真因：dsh.css 的 flex:1 1 auto 会拿整段会话正文的内容高来抢地方）",
    );
    ok(
      read("renderer/css/dsh.css").indexOf(".hist-scroll-wrap.is-flex-fill") >= 0,
      "契约① 的覆盖对象确实还在 dsh.css 里（选择器多带一层 .agent-body> 才压得住，别顺手删）",
    );
    const r2 = cssRule(".agent-todo.agent-plan {");
    ok(
      !!r2 &&
        /flex:\s*0 1 auto/.test(r2) &&
        /min-height:\s*3[89]px/.test(r2) &&
        /overflow:\s*hidden/.test(r2),
      "契约② 面板可收缩但下限 = 自身头部高，overflow:hidden 降为兜底（收起态头部不被裁 = 「被下方遮挡」那一格）",
    );
    const r2b = cssRule(".agent-todo.agent-plan:not(.collapsed) {");
    ok(
      !!r2b && /min-height:\s*45px/.test(r2b),
      "契约② 展开态下限再加把手（45 = 头部 38 + 把手 7）：把手被裁掉就等于再也拖不动了",
    );
    const r2h = cssRule(".agent-plan .at-head {");
    ok(
      !!r2h && /flex:\s*none/.test(r2h),
      "契约② 面板内部的缺口全落到清单上：.at-head 不参与收缩",
    );
    const r3 = cssRule(".agent-plan .at-list {");
    ok(
      !!r3 && /flex:\s*0 1 var\(--ap-h/.test(r3) && /min-height:\s*0/.test(r3),
      "契约③ 清单高度走 --ap-h 的 flex-basis = 最小高度（守住它，还能继续加高）",
    );
    ok(
      !!r3 && /max-height:\s*none/.test(r3),
      "契约③ 显式清掉 dsh.css 的 .at-list{max-height:190px} 死上限（否则又回到「名义最低、实为封顶」）",
    );
    const r4 = cssRule("#agentTodo {");
    const r4q = cssRule("#agentQueue {");
    ok(
      !!r4 && /flex:\s*0 1 auto/.test(r4) && /min-height:\s*38px/.test(r4),
      "契约④ 实时任务卡不再 flex:none 顶穿底栏：可收缩 + 头部下限",
    );
    ok(
      !!r4q && /flex:\s*0 1 auto/.test(r4q) && /min-height:\s*36px/.test(r4q),
      "契约④' 发送队列同口径（上一版夹取预算整块漏算的就是它，实测凭空近百 px）",
    );
    const r4h1 = cssRule("#agentTodo[hidden] {");
    const r4h2 = cssRule("#agentQueue[hidden] {");
    ok(
      !!r4h1 &&
        !!r4h2 &&
        /display:\s*none/.test(r4h1) &&
        /display:\s*none/.test(r4h2) &&
        /display:\s*none/.test(cssRule(".agent-todo.agent-plan[hidden] {") || ""),
      "契约④ 用 #id 特异度会盖过 dsh.css 的 .agent-todo[hidden] → 三处「收起来」都必须显式在，否则收起后留一屏空白",
    );
    const r5 = cssRule(".agent-body>.agent-composer {");
    ok(
      !!r5 && /flex:\s*none/.test(r5),
      "契约⑤ 输入区是底栏唯一的钉死项（让位次序的最后一项）：写进契约锁死，防以后被改回可收缩又重叠",
    );
    ok(
      cssBase.indexOf("--ap-maxh") < 0 && read("renderer/app-plan.js").indexOf("--ap-maxh") < 0,
      "全仓零残留：不再有 --ap-maxh 这个写死上限（重叠 bug 的源头）",
    );
    /* 把手文案：常量必须真的能在 i18n 里查到（改了常量忘改词条 → 英文界面漏出中文） */
    const planJs = read("renderer/app-plan.js");
    const i18Tip = /const PLAN_GRIP_TIP\s*=\s*"([^"]+)"/.exec(planJs);
    const i18All = read("renderer/i18n.js");
    ok(
      !!i18Tip &&
        i18All.indexOf('"' + i18Tip[1] + '"') >= 0 &&
        i18All.indexOf('"当前最多"') >= 0 &&
        planJs.indexOf('I18n.t("当前最多")') >= 0,
      "把手提示（含实时「当前最多 Npx」）已进 i18n 词条表，常量与词条不漂移",
    );
  }

  console.log(
    "\n———— " +
      (checks - fails) +
      "/" +
      checks +
      " 通过 ————" +
      "\n" +
      (fails ? "有 " + fails + " 项失败" : "全部通过"),
  );
  if (fails) process.exit(1);
}
function hostOn(host) {
  return host.classList.contains("on");
}

main().catch((e) => {
  console.error("测试异常：", e && e.stack ? e.stack : e);
  process.exit(1);
});

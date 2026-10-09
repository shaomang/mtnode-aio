"use strict";
/* test/smoke-session-touch.js — 「点一下会话不该改时间」回归冒烟
 *
 * 用户报的 bug：点左栏某条会话 → 它的时间立刻变成「刚刚」，整列跟着重新排序。
 * 根因（改动前，renderer/app-assist.js 的 mkRow 行身 onclick）：
 *     agentSelectSession(s.id);
 *     await agentFlushSessionSave();
 *     await persistAgentSession();   ← 无条件把**活动会话**盖成 Date.now() 并标脏
 * 而左栏排序基准是 sessionLastAt（updatedAt / 消息 / outbox 取最大，见
 * renderAgentSessionSidebar 的 byNewest）—— 于是「看一眼」等于「改了它」。
 *
 * 口径（本次修复）：只有**真改了内容**才走会盖时间戳的 persistAgentSession()；
 * 「只是切过去看一眼」走 agentFlushSessionSaveQuiet()（persistAgentSession({touch:false})）：
 * 仍把排队的改动推下去（切会话 / flush 点语义一字未改），但一个时间戳都不动。
 *
 * 本文件真跑产品代码：从 renderer/app-assist.js 抠出真函数体，注进迷你 DOM 沙箱，
 * 断言行为而不是抄一份副本。
 *   [1] 源码口径：quiet 入口存在 · 行身 onclick 不再无条件落盘 · 开发页同口径
 *   [2] 行为：point = quiet flush —— 排队的改动照旧推下去，updatedAt 一动不动
 *   [3] 行为：点一下会话行 → updatedAt / 行尾相对时长 / 左栏整列渲染结果三者都不变
 *   [4] 行为：真改动那条路（persistAgentSession()）仍然照旧盖时间戳 + 标脏
 *   [5] 行为：切会话按需读回正文（懒加载 sessionBody）也不动任何时间戳
 *
 * 运行：node test/smoke-session-touch.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  console.log((cond ? "  ok    " : "  FAIL  ") + msg);
  if (!cond) fails++;
}
const has = (src, needle, msg) => ok(String(src).indexOf(needle) >= 0, msg);
const no = (src, needle, msg) => ok(String(src).indexOf(needle) < 0, msg);

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");
const ASSIST = read("renderer/app-assist.js");
const APPS_DEV = read("renderer/app-apps-dev.js");

/* ── 源码切片：按大括号配平抠出真函数体（字符串 / 模板串 / 注释里的括号不算） ── */
function balanced(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl - 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return "";
}
function funcBody(src, header) {
  const at = src.indexOf(header);
  if (at < 0) throw new Error("切不出源码：" + header);
  /* header 自带结尾的 " {"：从它**之后**开始找开括号，否则配平会多数一层 */
  const head = header.replace(/\s*\{\s*$/, "");
  const open = src.indexOf("{", at + head.length);
  const body = balanced(src, open);
  if (!body || body.length < 20) throw new Error("切出的函数体异常：" + header);
  /* 保留原样的头部（含 async 前缀），只把配平出来的函数体接回去 */
  return src.slice(at, open) + body;
}

/* ── 迷你 DOM（够 renderAgentSessionSidebar / mkRow 真跑） ── */
const byId = new Map();
function el(tag) {
  const e = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attrs: {},
    cls: new Set(),
    textContent: "",
    title: "",
    type: "",
    hidden: false,
    innerHTML: "",
    value: "",
    get className() {
      return [...e.cls].join(" ");
    },
    set className(v) {
      e.cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
    },
    classList: {
      add: (...c) => c.forEach((x) => e.cls.add(x)),
      remove: (...c) => c.forEach((x) => e.cls.delete(x)),
      contains: (c) => e.cls.has(c),
      toggle: (c) => (e.cls.has(c) ? e.cls.delete(c) : e.cls.add(c)),
    },
    appendChild(c) {
      c.parentNode = e;
      e.children.push(c);
      return c;
    },
    insertBefore(c) {
      c.parentNode = e;
      e.children.unshift(c);
      return c;
    },
    replaceWith() {},
    remove() {},
    setAttribute(k, v) {
      e.attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(e.attrs, k) ? e.attrs[k] : null;
    },
    removeAttribute(k) {
      delete e.attrs[k];
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
    blur() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return e;
}
function findNode(root, pred) {
  if (pred(root)) return root;
  for (const c of root.children) {
    const hit = findNode(c, pred);
    if (hit) return hit;
  }
  return null;
}
const nodesOf = (root, pred, out) => {
  out = out || [];
  if (pred(root)) out.push(root);
  for (const c of root.children) nodesOf(c, pred, out);
  return out;
};
/* 行的顺序 = 容器里出现 .side-sess 的先后（用户眼睛里的左栏顺序） */
const rowOrder = (listEl) =>
  nodesOf(listEl, (n) => n.cls && n.cls.has("side-sess")).map((n) => n.dataset.sid);
const textOf = (listEl) => {
  const walk = (n) =>
    String(n.textContent || "") + n.children.map((c) => " " + walk(c)).join("");
  return walk(listEl);
};

const SLICE = [
  "function agentMarkSessionDirty(id) {",
  "function agentFlushSessionSave() {",
  "function agentFlushSessionSaveQuiet() {",
  "async function agentWriteAgentSessions() {",
  "function agentSessionMetaForDisk(s) {",
  "function agentSessionBodyForDisk(s) {",
  "async function persistAgentSession() {",
  "function agentTouchSession(owner) {",
  "async function agentEnsureSessionBody(st) {",
  "function agentSelectSession(id) {",
  "function sessionLastAt(s) {",
  "function formatRelTime(ts) {",
  "function wsGroupOf(ws) {",
  "function activeAgentId() {",
  "function agentSessions() {",
  "function agentTrimSessionMessages(st) {",
  "function renderAgentSessionSidebar() {",
];

function makeSandbox(sessions, opts) {
  opts = opts || {};
  const calls = [];
  const S = {
    wf: null,
    wfBag: {},
    agentSessions: sessions,
    agentActiveId: sessions[0] ? sessions[0].id : "",
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Error,
    RegExp,
    S,
    I18n: { t: (s) => s },
    document: {
      createElement: el,
      createTextNode: (t) => ({ textContent: String(t), children: [] }),
      getElementById: (id) => byId.get(id) || null,
      querySelector: () => null,
      addEventListener() {},
      body: el("body"),
      hidden: false,
    },
    /* 真壳里 $ = document.querySelector 的简写（左栏渲染里查 #agentSideList 等） */
    $: (sel) =>
      byId.get(String(sel || "").replace(/^#/, "")) || null,
    window: { api: {} },
    /* 真壳里这两个也来自 app-assist.js（会话列表入口的懒加载钩子）；本测试不碰正文 */
    agentEnsureViewSessionBody: () => false,
    planHydrateSession() {},
    devContractHydrateSession() {},
    agentViewOverrideOn: () => false,
    agentViewId: () => "",
    agentViewIs: () => false,
    sessionIsRunning: () => false,
    sessionBusyForUi: () => false,
    agentSessionById: (id) => sessions.find((s) => s.id === id) || null,
    /* 真壳里 = 「当前活动会话」（含开发页覆盖态 / 兜底新建）；本测试只给最小语义 */
    agentSessionState: () => sessions.find((s) => s.id === S.agentActiveId) || sessions[0] || null,
    /* 真壳里这些也来自 app-assist.js；本测试不碰它们，给最小桩 */
    sessionCanvasName: () => "",
    sessionIsDevBoundTitle: () => false,
    sessionWorkspaceShown: (s) => String((s && s.workspace) || ""),
    sessionWorkspaceTooltipLine: () => "",
    sessionCanvasTooltipLine: () => "",
    formatMsgStamp: (t) => "STAMP(" + t + ")",
    updateRunQueuePanel() {},
    /* 左栏行尾时间跳秒的定时器（真壳里 app-assist.js 自己的函数）：本测试不关心 */
    startAgentSideTimeTicker() {},
    /* 点行后会重画消息区（本测试只验左栏与时间戳）：给一个计数桩 */
    renderAgentSession() {},
    I18n_t: (s) => s,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);

  sandbox.window.api.sessionSave = async (payload) => {
    calls.push(payload);
    return { ok: true, wrote: (payload.sessions || []).length };
  };
  sandbox.window.api.sessionBody = async (ids) => ({
    sessions: ids
      .map((id) => (opts.bodyOf ? opts.bodyOf(id) : null))
      .filter(Boolean),
  });

  vm.runInContext(
    "S._sessionDirty = S._sessionDirty instanceof Set ? S._sessionDirty : new Set();\n" +
      "const AGENT_SAVE_MS = 500;\n" +
      "const AGENT_MSG_KEEP_MAX = 1920;\n" +
      "S._sessionBodyWait = S._sessionBodyWait instanceof Map ? S._sessionBodyWait : new Map();\n" +
      'const AGENT_PRESET_DEFAULT = "standard";\n' +
      SLICE.map((h) => funcBody(ASSIST, h)).join("\n") +
      "\nthis.__x = { renderAgentSessionSidebar, agentEnsureSessionBody, agentWriteAgentSessions," +
      " agentFlushSessionSaveQuiet, persistAgentSession, agentTouchSession, sessionLastAt, formatRelTime, agentSelectSession };",
    sandbox,
    { filename: "renderer/app-assist.js#session-touch" },
  );
  /* 每只沙箱只认自己那只列表容器：byId 在文件级共享，不换会把上一只的容器画脏 */  byId.clear();
  if (opts.listEl) byId.set("agentSideList", opts.listEl);
  return { sandbox, calls, X: sandbox.__x, S };
}

const HOUR = 3600000;

(async () => {
  console.log("\n[1] 源码口径：单一 touch 入口 · 只看不改的路径全部走 quiet");
  has(ASSIST, "function agentFlushSessionSaveQuiet(", "app-assist.js 有 agentFlushSessionSaveQuiet（只 flush 不盖时间戳）");
  has(ASSIST, "function agentTouchSession(owner)", "app-assist.js 有 agentTouchSession（全仓唯一会盖 updatedAt 的入口，可点名要盖哪条）");
  has(ASSIST, "async function persistAgentSession()", "persistAgentSession 不再收 opts（只落盘、不盖时间戳）");
  no(
    ASSIST.slice(
      ASSIST.indexOf("async function persistAgentSession()"),
      ASSIST.indexOf("/* 「这条会话真的有新内容了」"),
    ),
    "updatedAt",
    "persistAgentSession 自己一个时间戳都不盖（谁也别想靠它偷偷顶新）",
  );
  has(
    ASSIST,
    "return persistAgentSession().catch(() => {});",
    "quiet 入口仍走同一个落盘收口（不另造写盘路径）",
  );
  {
    const at = ASSIST.indexOf("row.onclick = async () => {");
    ok(at > 0, "找到会话行的行身 onclick");
    const seg = balanced(ASSIST, ASSIST.indexOf("{", at));
    ok(seg.indexOf("agentFlushSessionSaveQuiet()") > 0, "点行 = quiet flush（上一条排队的改动照旧推下去）");
    /* 注释里那句「原先是 await persistAgentSession()」是在讲历史，不算调用：先摘注释 */    const code = seg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    ok(!/(^|[^A-Za-z_$])(persistAgentSession|agentTouchSession)\s*\(/.test(code), "点行既不落盘也不盖时间戳（看一眼 = 一个像素都不变）");
    ok(seg.indexOf("renderAgentSessionSidebar()") > 0, "点行照旧重绘左栏（只读一眼，不排序）");
  }
  has(
    APPS_DEV,
    'if (typeof agentFlushSessionSaveQuiet === "function") await agentFlushSessionSaveQuiet();',
    "开发页自动选中一条会话（只是看）也走 quiet flush",
  );
  /* 只看不改的其余四条路（搜索跳转 / 队列跳转 / 卡片来源跳转 / 查看修复会话 /
     打开绑定开发会话）：源码口径上都不许出现 agentTouchSession。 */
  for (const [rel, fn, label] of [
    ["renderer/app-search.js", "async function gsGotoSession(g) {", "全局搜索跳到会话"],
    ["renderer/app.js", "async function jumpRunQueueItem(it) {", "运行队列点行"],
    ["renderer/app-db.js", "async function ixSrcJump(src) {", "卡片来源行跳转"],
    ["renderer/app-repair.js", "function pluginRepairGotoSession(info) {", "插件修复窗查看会话"],
    ["renderer/app.js", "async function openBoundDevSession(node) {", "打开功能块绑定会话"],
  ]) {
    const src = read(rel);
    const seg = funcBody(src, fn);
    ok(
      seg.indexOf("agentFlushSessionSaveQuiet") > 0 && seg.indexOf("agentTouchSession") < 0,
      label + " = quiet（不盖时间戳、不重排）",
    );
  }
  /* 节点侧的两个会话入口是**条件 touch**：只有这一次真往会话里补写了内容（去重没命中）
     才盖时间戳；已经看过一遍再点开（去重命中、什么都不写）必须退回 quiet ——
     否则「打开会话看一眼」又变成把该会话顶到左栏最前（本 bug 的同一类）。 */
  for (const [rel, fn, label] of [
    ["renderer/app.js", "async function openRemotionSession(node) {", "打开 Remotion 节点会话"],
    ["renderer/app.js", "async function expandAgentTaskToSession(node) {", "节点结果扩展为智能会话"],
  ]) {
    const seg = funcBody(read(rel), fn);
    ok(
      /let added = false;/.test(seg) &&
        /if \(added\) await agentTouchSession\(\);/.test(seg) &&
        seg.indexOf("else await agentFlushSessionSaveQuiet();") > 0,
      label + " = 只有真补写内容才 touch，否则 quiet（看一眼不重排）",
    );
  }
  /* 实质内容两条路（发送 / 整轮收尾）必须走 touch。 */
  {
    const sendSeg = funcBody(ASSIST, "async function agentSessionSend(text, opts) {");
    ok(sendSeg.indexOf("agentTouchSession") > 0, "发送 = touch（点发送就立刻提到最前）");
    /* 轮末那一段：先按它自己那句注释定位，再从那里往后找第一处 touch 调用 ——
       别的「本轮」注释（计划续跑那段）不会命中这句。 */
    const endAt = ASSIST.indexOf("本轮结束 = AI 这一轮真有产出");
    ok(endAt > 0, "找到会话整轮收尾那一段");
    const endCall = ASSIST.indexOf("await agentTouchSession();", endAt);
    const endSeg = ASSIST.slice(endAt, endCall < 0 ? endAt + 400 : endCall + 60);
    ok(
      endCall > 0 && endSeg.indexOf("updatedAt = Date.now()") < 0,
      "整轮收尾 = touch 一次（轮内工具事件不再各自顶新）",
    );
  }
  /* 实质内容的其余几条路（问答卡提交 / 清单写删 / 改名 / 归档 / 长任务环节收尾）
     必须照旧刷新时间 —— 「静默一条不漏」的另一半是「刷新一条不少」。
     两种写法都算数：点名会话走 agentTouchSession()，或直接在这条会话对象上
     `updatedAt = Date.now()` + agentMarkSessionDirty（归档 / 改名这两条）。 */
  for (const [rel, fn, label] of [
    ["renderer/app-db.js", "function ixRoundEndTrace(runKey, text) {", "AI 整轮产出（轮末痕迹）"],
    ["renderer/app-db.js", "function ixCommitAnswerToSession(it, answers) {", "会话内问答卡提交"],
    ["renderer/app-plan.js", "function planTouch(st) {", "AI 写 / 删任务清单"],
    ["renderer/app-plan.js", "function planDrop(st, reason) {", "清单作废（归档 / 手动清）"],
    ["renderer/app-assist.js", "function startSessionTitleEdit(s, nameEl) {", "会话改名"],
    ["renderer/app-assist.js", "async function archiveAgentSession(id, archived) {", "会话归档 / 恢复"],
    ["renderer/app-longtask.js", "function ltReleaseAgentSession(run, path, pn, st, text) {", "长任务环节收尾补写"],
  ]) {
    const seg = funcBody(read(rel), fn);
    const byTouch = seg.indexOf("agentTouchSession") > 0;
    const byStamp =
      /updatedAt = Date\.now\(\)/.test(seg) && seg.indexOf("agentMarkSessionDirty") > 0;
    ok(byTouch || byStamp, label + " = 照旧刷新时间（实质内容不算「看一眼」）");
  }

  console.log("\n[2] 行为：quiet flush 把排队的改动推下去，但一个时间戳都不动");
  {
    const now = Date.now();
    const mk = (id, title, ageMs) => ({
      id,
      title,
      messages: [{ role: "user", content: "hi " + id, at: now - ageMs }],
      updatedAt: now - ageMs,
      _lcLoaded: true,
      _lcDirty: false,
    });
    /* 被测会话（as1）是**非活动**那条：活动会话自己没改时 agentWriteAgentSessions 会
       走「没有任何改动、活动会话也没换 → 一次 IPC 都不发」的短路（原样口径），
       拿它测不出「排队的改动有没有被推下去」。 */
    const st = mk("as1", "A", 3 * HOUR);
    const other = mk("as2", "B", 1 * HOUR);
    const { X, S, calls } = makeSandbox([other, st]);
    S.agentActiveId = "as2";
    const before = st.updatedAt;
    S._sessionDirty.add(st.id); /* 排一条改动在里面：quiet flush 必须照旧推下去 */
    const flushed = await X.agentFlushSessionSaveQuiet();
    if (!calls.length)
      console.log(
        "      (debug) flush 回执 = " +
          JSON.stringify(flushed) +
          " · 脏表 = " +
          [...S._sessionDirty].join(","),
      );
    ok(st.updatedAt === before, "quiet flush 后 updatedAt 一个毫秒都没动（点一下 ≠ 改一下）");
    ok(
      calls.length >= 1 && (calls[0].sessions || []).some((s) => s.id === "as1"),
      "排队的改动仍然被推下去了（切会话 / flush 语义不变）",
    );
    ok(!S._sessionDirty.has("as1"), "脏标记清掉（不会越攒越多）");
    ok(X.sessionLastAt(st) === before, "左栏排序基准 sessionLastAt 也没动（不变 = 不重排）");
  }

  console.log("\n[3] 行为：点一下会话行 → 时间、行尾时长、整列渲染结果三者都不变");
  {
    const now = Date.now();
    const mk = (id, title, ageMs) => ({
      id,
      title,
      workspace: "E:\\proj\\alpha",
      messages: [{ role: "user", content: "hi " + id, at: now - ageMs }],
      updatedAt: now - ageMs,
      _lcLoaded: true,
      _lcDirty: false,
    });
    const sess = [mk("as1", "旧会话", 5 * HOUR), mk("as2", "新会话", 1 * HOUR), mk("as3", "中间会话", 3 * HOUR)];
    const listEl = el("div");
    const { X, S } = makeSandbox(sess, { listEl });
    /* 真壳里每次渲染前会把容器清空（innerHTML=""）；迷你 DOM 没有 innerHTML 语义，手动清 */
    const paint = () => {
      listEl.children.length = 0;
      X.renderAgentSessionSidebar();
    };
    paint();
    const orderBefore = rowOrder(listEl);
    const textBefore = textOf(listEl);
    const row = findNode(listEl, (n) => n.dataset && n.dataset.sid === "as3");
    ok(!!row, "左栏真画出了三行（按时间倒序）");
    ok(
      orderBefore.join(",") === "as2,as3,as1",
      "点之前：新会话 → 中间会话 → 旧会话（越新越靠上）",
    );
    const tmBefore = findNode(row, (n) => n.cls && n.cls.has("side-sess-time"));
    const tmTextBefore = tmBefore ? tmBefore.textContent : "";
    const stampBefore = sess.map((s) => s.updatedAt).join(",");

    await row.onclick(); /* 用户点「中间会话」：真调产品代码里那一段 */

    ok(S.agentActiveId === "as3", "点完选中项切到 as3（该看的还是切过去了）");
    ok(
      sess.map((s) => s.updatedAt).join(",") === stampBefore,
      "三条会话的 updatedAt 全都没动（点谁都不顶到最前）",
    );
    const tmAfter = findNode(listEl, (n) => n.cls && n.cls.has("side-sess-time") && n.dataset.sid === "as3");
    const tmTextAfter = tmAfter
      ? tmAfter.textContent
      : (findNode(listEl, (n) => n.dataset && n.dataset.sid === "as3") &&
          findNode(findNode(listEl, (n) => n.dataset && n.dataset.sid === "as3"), (n) => n.cls && n.cls.has("side-sess-time")) || {}
        ).textContent;
    ok(tmTextAfter === tmTextBefore, "行尾相对时长没变成「刚刚」（" + JSON.stringify(tmTextBefore) + "）");
    paint();
    ok(rowOrder(listEl).join(",") === "as2,as3,as1", "重绘后左栏顺序一字不变（不再重排）");
    /* 点一下只允许「选中态」变（行上加 active 类 = 用户选中的是 as3，本来就该变）：
       把类名剥掉再逐字比对整列（标题 / 分组 / 行尾时间 / 按钮文案一个字都不该变）。 */
    const strip = (s) => String(s).replace(/\b(active|side-sess-active)\b/g, "");
    ok(
      strip(textOf(listEl)) === strip(textBefore),
      "整列渲染结果逐字相同（时间行 / 标题 / 分组都没被点一下改掉）",
    );
    ok(textOf(listEl).indexOf("刚刚") < 0, "整列里没有任何一行变成「刚刚」");
  }

  console.log("\n[4] 行为：touch 是唯一会盖时间戳的入口，quiet / persist 都不盖");
  {
    const now = Date.now();
    const st = { id: "as1", title: "A", messages: [], updatedAt: now - 6 * HOUR, _lcLoaded: true };
    const { X, S, calls } = makeSandbox([st]);
    /* ① 只看不改那条路：一个时间戳都不动。索引条目的对账（正文已在内存的会话在每次
       保存里顺手对齐一次签名）照旧可能走一次 IPC —— 那一路在盘上不会重写会话文件
       （见下面 [5] 的逐字相同断言），本测试只钉「时间戳不动 / 排序不重排」。 */
    const beforeQuiet = st.updatedAt;
    S._agentActiveIdSynced = "as1";
    const callsBefore = calls.length;
    await X.agentFlushSessionSaveQuiet();
    ok(st.updatedAt === beforeQuiet, "quiet flush 后 updatedAt 一个毫秒都没动");
    ok(
      X.sessionLastAt(st) === beforeQuiet,
      "排序基准 sessionLastAt 也没动（看一眼 = 左栏不重排；quiet 期间最多一次索引对账写）",
    );
    /* ② 只落盘不收口：persistAgentSession() 也不再盖时间戳 */
    await X.persistAgentSession();
    ok(st.updatedAt === beforeQuiet, "persistAgentSession() 只落盘，不再顺手把 updatedAt 刷成现在");
    /* ③ 真改动那条路：agentTouchSession() 盖时间戳 + 落盘 */
    await X.agentTouchSession();
    ok(st.updatedAt > beforeQuiet, "agentTouchSession() 把 updatedAt 刷到刚刚（发送 / 轮末产出）");
    ok(calls.length > callsBefore, "touch 照旧落一次盘");
    const afterTouch = st.updatedAt;
    await X.agentFlushSessionSaveQuiet();
    ok(st.updatedAt === afterTouch, "touch 之后的 quiet flush 不会再盖一次");
  }

  console.log("\n[5] 主进程存储：与盘上那份逐字相同时一个字节都不重写（「看一眼」不留痕）");
  {
    const os = require("os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtn-sess-touch-"));
    const { createAgentSessionsStore } = require(path.join(ROOT, "agent-sessions-store.js"));
    let at = 1700000000000;
    const store = createAgentSessionsStore({
      dataDir: () => tmp,
      cfgFile: () => path.join(tmp, "config.json"),
      log: () => {},
    });
    const body = { id: "asFix1", title: "看一眼不算改", messages: [{ role: "user", content: "hi", at }], updatedAt: at };
    const first = store.saveSessions({ activeId: "asFix1", sessions: [{ id: "asFix1", title: "看一眼不算改", updatedAt: at, body }] });
    ok(first && first.wrote === 1, "第一次保存真的写了会话文件");
    const file = path.join(tmp, "agent-sessions", "asFix1.json");
    const mtime1 = fs.statSync(file).mtimeMs;
    /* 「看一眼」这条路：渲染层原样把同一份正文再送一次 —— 存储层必须认出来「逐字相同」 */
    const second = store.saveSessions({ activeId: "asFix1", sessions: [{ id: "asFix1", title: "看一眼不算改", updatedAt: at, body }] });
    ok(second && second.wrote === 0, "逐字相同的第二次保存一次磁盘写都不做");
    ok(fs.statSync(file).mtimeMs === mtime1, "会话文件 mtime 一动没动（盘上真的一点痕迹都没有）");
    ok(
      JSON.parse(fs.readFileSync(path.join(tmp, "agent-sessions", "index.json"), "utf8")).sessions[0].updatedAt === at,
      "索引里的时间戳照旧（看一眼不改时间）",
    );
    /* 真改内容：照旧写，并且索引跟着走 */
    body.messages.push({ role: "assistant", content: "round end", at: at + 1000 });
    body.updatedAt = at + 1000;
    const third = store.saveSessions({ activeId: "asFix1", sessions: [{ id: "asFix1", title: "看一眼不算改", updatedAt: at + 1000, body }] });
    ok(third && third.wrote === 1, "内容真变了才写盘");
    ok(
      JSON.parse(fs.readFileSync(path.join(tmp, "agent-sessions", "index.json"), "utf8")).sessions[0].updatedAt === at + 1000,
      "索引里的 updatedAt 跟着内容走",
    );
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log("\n[6] 行为：切会话按需读回正文（懒加载）也不动时间戳");
  {
    const now = Date.now();
    const st = {
      id: "as1",
      title: "A",
      messages: [],
      updatedAt: now - 8 * HOUR,
      _lcLoaded: false, /* 启动只读了索引：正文还没读回来 */
    };
    const body = {
      id: "as1",
      title: "A",
      messages: [{ role: "user", content: "body", at: now - 8 * HOUR }],
      updatedAt: now - 8 * HOUR,
    };
    const { X, S } = makeSandbox([st], { bodyOf: (id) => (id === "as1" ? body : null) });
    const before = st.updatedAt;
    const got = await X.agentEnsureSessionBody(st);
    ok(got === true && st._lcLoaded === true, "正文按需读了回来（切过去就能看见内容）");
    ok(st.updatedAt === before, "读回正文不刷 updatedAt");
    ok(!S._sessionDirty.has("as1"), "读回正文不标脏（盘上那份一个字节都不用重写）");
  }

  console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("冒烟自身抛错：", (e && e.stack) || e);
  process.exit(1);
});

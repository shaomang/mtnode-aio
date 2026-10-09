"use strict";
/* 开发页「＋ 新开发会话」回归冒烟 —— 纯 Node，不启动 Electron
 *   node test/smoke-apps-dev-new-session.js
 *
 * 保住的 bug（本轮需求）：应用开发里**建不出第二条开发会话** ——
 *   左栏应用行右端的「＋」与工具栏那颗「＋」都要在这个应用下开一条**新**会话，
 *   落点是「首轮态」（draft = true / sessionId = ""），等用户写下首轮需求再建会话。
 *   可是「点＋」与「切到这个应用看一眼」在界面上落到**同一个状态**，原先只靠
 *   「输入框里有没有字」（appsDevDraftPending）区分，而刚点完＋那一瞬框必然是空的：
 *   三处「落到该应用最近一条会话」的兜底会当场把这个首轮态顶掉 ——
 *     ① 1.2s 轮询 appsDevEnsureCurrentSession（点完＋ 一秒多就被顶掉）
 *     ② 切应用 appsDevSwitchAppRun 的 ③（点别的应用行的＋ 时必被顶掉）
 *     ③ 整页绘制 appsDevSyncAfterPaint 的落点
 *   结果：用户点了＋，右栏却回到那条老会话，写下的字进的是老会话的普通一轮，
 *   新会话永远建不出来。
 *
 * 修法（renderer/app-apps-dev.js）：给「点过＋」记一个显式意图位 DEVD.newRound ——
 *   点＋ 置位（且在切应用**之前**置位），首轮发出即兑现清除，
 *   用户自己挑了一条会话 / 点了别的应用行身 / 页面整个换了应用上下文也清除；
 *   三处兜底各自加一道闸：「点过＋ 就绝不自动落会话」。
 *
 * 覆盖：
 *   [1] 真行为（vm 沙箱跑渲染层真函数 + 假 DOM）：点＋ 之后那一瞬三处兜底都不许顶掉首轮态，
 *       首轮交出后老口径照旧恢复
 *   [2] 左栏「＋」（换应用那条路）：意图位先立、点行身即作废、作废后落回该应用最近一条
 *   [3] 源码锚点：三处兜底闸 + 兑现处清位都在（防以后只改一处）
 */
const fs = require("fs"),
  path = require("path"),
  vm = require("vm");

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

/* ── 源码锚点用：抠出一个顶层函数的整段（本仓顶层函数收在行首的 } 上）── */
function bodyOf(src, name) {
  const anchor = "function " + name + "(";
  const i = src.indexOf(anchor);
  if (i < 0) return "";
  const j = src.indexOf("\n}\n", i);
  return j < 0 ? src.slice(i) : src.slice(i, j + 2);
}

/* ============================ 迷你 DOM ============================ */
function mkEl(tag, cls, id) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    id: String(id || ""),
    parentNode: null,
    children: [],
    dataset: {},
    style: {},
    title: "",
    value: "",
    hidden: false,
    type: "",
    textContent: "",
    _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    contains: (c) => el._cls.has(c),
    toggle: (c, on) => {
      if (on === undefined ? !el._cls.has(c) : !!on) el._cls.add(c);
      else el._cls.delete(c);
    },
  };
  el.appendChild = (c) => {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    el.children.push(c);
    return c;
  };
  el.removeChild = (c) => {
    const i = el.children.indexOf(c);
    if (i >= 0) el.children.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  };
  el.remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.contains = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === el) return true;
    return false;
  };
  el.setAttribute = () => {};
  el.removeAttribute = () => {};
  el.getAttribute = () => null;
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
  el.addEventListener = () => {};
  el.closest = () => null;
  el.focus = () => {};
  el.setSelectionRange = () => {};
  el.scrollIntoView = () => {};
  el.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, top: 0 });
  Object.defineProperty(el, "innerHTML", {
    get: () => el.textContent || "",
    set: () => {
      for (const c of el.children.slice()) el.removeChild(c);
    },
  });
  Object.defineProperty(el, "className", {
    get: () => Array.from(el._cls).join(" "),
    set: (v) => {
      el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
    },
  });
  return el;
}
function docGetById(root, id) {
  const walk = (node) => {
    if (node.id === id) return node;
    for (const c of node.children || []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/* ============================ 沙箱 ============================ */
function build() {
  const root = mkEl("body", "", "");
  const sideList = root.appendChild(mkEl("div", "agent-side-list", "appsDevSideList"));
  const pane = root.appendChild(mkEl("div", "agent-pane", "agentPane"));
  const body = pane.appendChild(mkEl("div", "agent-body", ""));
  body.appendChild(mkEl("div", "agent-list", "agentList"));
  const composer = body.appendChild(mkEl("div", "agent-composer", ""));
  const input = composer.appendChild(mkEl("textarea", "chat-input", "agentInput"));
  const calls = { configSave: [] };
  const timers = new Map();
  let timerSeq = 0;
  /* 每个应用都有自己的目录（会话工作区对齐那条路会用到），会话按 appId 分组 */
  const APPS = [
    { id: "app-new", name: "新应用", dev: true, dir: "E:\\apps\\app-new" },
    { id: "app-mid", name: "中间应用", dev: true, dir: "E:\\apps\\app-mid" },
  ];
  const SESSIONS = [
    { id: "s1", title: "开发 · 新应用", appId: "app-new", messages: [], updatedAt: 3, _draft: "" },
    { id: "s2", title: "开发 · 中间应用", appId: "app-mid", messages: [], updatedAt: 2, _draft: "" },
  ];
  const S = { agentSessions: SESSIONS, agentActiveId: "s1", config: {} };
  const sandbox = {
    document: {
      getElementById: (id) => docGetById(root, String(id)),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (t) => mkEl(t),
      createTextNode: (x) => ({ nodeType: 3, textContent: String(x) }),
      body: root,
      contains: (n) => root.contains(n),
      addEventListener: () => {},
      removeEventListener: () => {},
      activeElement: null,
    },
    window: {
      api: {
        configSave: (cfg) => {
          calls.configSave.push(cfg);
          return Promise.resolve();
        },
        fileIsDir: () => Promise.resolve(true),
      },
      addEventListener: () => {},
    },
    console,
    I18n: { t: (x) => x, getLocale: () => "zh" },
    APPS_ST: { nav: "dev" },
    AGENT_PRESET_DEFAULT: "standard",
    AGENT_EFFORT_UI_ORDER: ["low", "medium", "high"],
    S,
    $: (sel) => {
      const s = String(sel || "");
      return s[0] === "#" ? docGetById(root, s.slice(1)) : null;
    },
    appsHubIsOpen: () => true,
    appsLocalList: () => APPS,
    appsLocalById: (id) => APPS.find((a) => a.id === id) || null,
    appSessionsOf: (id) => SESSIONS.filter((s) => s.appId === id),
    /* 重绘依赖：本轮不测渲染，全部换成空实现，只让「首轮态 / 自动落会话」这条链真跑 */
    liveNodeForSession: () => null,
    sessionIsRunning: () => false,
    markConvStick: () => {},
    captureConvStick: () => null,
    restoreConvStick: () => {},
    scheduleHistoryCollapse: () => {},
    rememberAgentThinkScroll: () => {},
    agentNotifyBrowserSession: () => {},
    paintAgentSendState: () => {},
    renderAgentComposer: () => {},
    renderAgentSessionSidebar: () => {},
    renderAgentQueueBar: () => {},
    renderAgentTodoPanel: () => {},
    renderSessionFooterStat: () => {},
    paintAgentToolsChip: () => {},
    paintAgentModeChip: () => {},
    persistAgentSession: () => Promise.resolve(),
    appsDevToast: () => {},
    toast: () => {},
    setTimeout: (fn) => {
      const id = ++timerSeq;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  vm.createContext(sandbox);
  for (const f of ["renderer/app-apps-dev.js", "renderer/app-assist.js"]) {
    vm.runInContext(read(f), sandbox, { filename: f });
  }
  const get = (expr) => vm.runInContext(expr, sandbox);
  /* 开发页「装起来」：宿主容器在文档里 + 选中一个应用（appsDevPageOpen 的判据） */
  const openDev = (appId) => {
    get("DEVD").listEl = sideList;
    get("DEVD").appId = appId || "app-new";
    get("DEVD").draft = true;
    get("DEVD").sessionId = "";
    get("DEVD").msgCount = 0;
    get("DEVD").newRound = false;
  };
  return { sandbox, get, calls, root, sideList, input, S, openDev };
}

/* ══════════════ [1] 点＋ 之后首轮态不许被自动落会话顶掉 ══════════════ */
console.log("\n[1] 点「＋」= 要开新会话：那一瞬（框还空着）三处兜底都不许动它");
{
  const s = build();
  s.openDev("app-new");
  s.get('agentViewOverrideSet("")');
  s.get("renderAgentSession()");
  ok(s.input.value === "", "前置：刚进页面 / 刚点＋ 时输入框是空的");
  ok(
    s.get("appsDevDraftPending()") === false,
    "前置：空框 = 没有未发送内容 —— 老口径那道闸此刻是**开**的（这正是 bug 的入口）",
  );
  /* 基线：只是进这个应用看一眼（没点＋）→ 照老口径落到最近一条会话 */
  const base = s.get("appsDevEnsureCurrentSession()");
  ok(
    base === true && s.get("DEVD").sessionId === "s1",
    "没点＋：自动落到该应用最近一条会话（老口径，不许回退）",
  );

  /* 点＋（工具栏那颗，当前应用）：要开这个应用的第二条会话 */
  s.openDev("app-new");
  s.get("appsDevNewRound()");
  ok(s.get("DEVD").newRound === true, "点＋：意图位立起来（DEVD.newRound）");
  ok(
    s.get("DEVD").draft === true && s.get("DEVD").sessionId === "",
    "点＋：回到首轮态（draft = true / sessionId 清空）—— 等用户写下首轮需求",
  );
  const picked = s.get("appsDevEnsureCurrentSession()");
  ok(
    picked === false,
    "点＋ 后那一瞬：1.2s 轮询的「自动落会话」不许动它（返回 false）",
  );
  ok(
    s.get("DEVD").draft === true && s.get("DEVD").sessionId === "",
    "本页仍停在首轮态（修复前这一步会变成 s1：＋ 点了个空，第二条会话建不出来）",
  );
  /* 开始写新需求：老那道闸（框里有字）也一起闭着 */
  s.input.value = "第二条会话的需求：把首页换成深色";
  s.get("agentDraftTick()");
  ok(s.get("appsDevDraftPending()") === true, "写下几个字：未发送内容被认出来");
  ok(
    s.get("appsDevEnsureCurrentSession()") === false && s.get("DEVD").sessionId === "",
    "写需求的过程中同样不动（两道闸一起闭）",
  );
  /* 首轮发出去 = 意图兑现（appsDevStartDevSession 那一刻做的两件事） */
  s.get("appsDevDraftClear('app-new')");
  s.get("appsDevNewRoundClear()");
  s.input.value = "";
  const after = s.get("appsDevEnsureCurrentSession()");
  ok(
    after === true && s.get("DEVD").sessionId === "s1",
    "首轮交出后意图作废：老口径照旧恢复（空框就落回最近一条，页面不会卡在首轮态）",
  );
}

/* ══════════════ [2] 左栏「＋」（换应用那条路）══════════════ */
console.log("\n[2] 左栏应用行右端的「＋」：切过去也不许被那个应用的已有会话顶掉");
{
  const s = build();
  s.openDev("app-new");
  s.get("appsDevNewSessionFor('app-mid')");
  ok(
    s.get("DEVD").appId === "app-mid" &&
      s.get("DEVD").newRound === true &&
      s.get("DEVD").draft === true &&
      s.get("DEVD").sessionId === "",
    "点 app-mid 行的＋：切到它 + 立起意图位 + 首轮态（意图位是在切应用之前立的）",
  );
  const picked = s.get("appsDevEnsureCurrentSession()");
  ok(
    picked === false && s.get("DEVD").sessionId === "",
    "app-mid 名下已有 s2，也不许抢先把首轮态顶掉",
  );
  /* 用户改主意：点 app-mid 行身 = 「看这个应用」→ 意图作废 → 落回它最近一条 */
  s.get("appsDevSidebarHost()").onAppSelect("app-mid");
  ok(s.get("DEVD").newRound === false, "点应用行身（不是＋）：点＋ 的意图随之作废");
  const picked2 = s.get("appsDevEnsureCurrentSession()");
  ok(
    picked2 === true && s.get("DEVD").sessionId === "s2",
    "作废之后照老口径落到 app-mid 最近一条会话",
  );
}

/* ══════════════ [3] 源码锚点：三处兜底闸 + 兑现处清位 ══════════════ */
console.log("\n[3] 源码锚点：闸要装在每一处「自动落会话」上，别只改一处");
{
  const DEV = read("renderer/app-apps-dev.js");
  ok(
    DEV.indexOf("newRound: false") >= 0 && DEV.indexOf("DEVD.newRound === true") >= 0,
    "DEVD 带意图位字段，appsDevNewRoundOn 按它判（只读一位）",
  );
  ok(
    /appsDevNewRoundOn\(\)/.test(bodyOf(DEV, "appsDevEnsureCurrentSession")),
    "闸① 1.2s 轮询的兜底（appsDevEnsureCurrentSession）带意图位",
  );
  ok(
    /!appsDevNewRoundOn\(\)/.test(bodyOf(DEV, "appsDevSwitchAppRun")),
    "闸② 切应用的落会话（appsDevSwitchAppRun）带意图位",
  );
  ok(
    /!appsDevNewRoundOn\(\)/.test(bodyOf(DEV, "appsDevSyncAfterPaint")),
    "闸③ 整页绘制的落会话（appsDevSyncAfterPaint）带意图位",
  );
  ok(
    /appsDevNewRoundClear\(\)/.test(bodyOf(DEV, "appsDevStartDevSession")),
    "首轮发出那一刻清掉意图位（appsDevStartDevSession）",
  );
  const nr = bodyOf(DEV, "appsDevNewRound");
  ok(
    nr.indexOf("appsDevNewRoundMark()") >= 0 &&
      nr.indexOf("appsDevNewRoundMark()") < nr.indexOf("appsDevSelectApp("),
    "＋ 在切应用**之前**置位（换应用那条路的落点要看它）",
  );
  const host = bodyOf(DEV, "appsDevSidebarHost");
  ok(
    /onAppSelect[\s\S]*appsDevNewRoundClear\(\)[\s\S]*appsDevSelectApp\(id\)/.test(host),
    "点应用行身（onAppSelect）= 看这个应用：先清意图位再切（与行右端那颗＋分得清）",
  );
  const paint = bodyOf(DEV, "appsDevPagePaint");
  ok(
    /switched[\s\S]*appsDevNewRoundClear\(\)/.test(paint),
    "页面自己换了应用上下文时意图位一并作废（不跟到下一个应用）",
  );
}

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-apps-dev-new-session)",
);
process.exit(fails ? 1 : 0);

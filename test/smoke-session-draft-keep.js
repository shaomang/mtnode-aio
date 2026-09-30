"use strict";
/* test/smoke-session-draft-keep.js — 消息栏草稿：未输入完毕发送的内容切窗口 / 切页不许丢
 *   node test/smoke-session-draft-keep.js
 *
 * 本轮需求（renderer/app-assist.js + renderer/app-apps-dev.js + renderer/app-boot.js）：
 *   「应用开发中，未输入完毕发送的消息框内容需保留，避免用户临时切换窗口后丢失」。
 *
 * 根因（真跑代码路径看到的两件事）：
 *   ① 草稿原来只在**切换会话那一刻**从 DOM 抄一次，而且只认会话表里的对象
 *      （renderAgentSession 里 `prev._draft = inp.value`）；
 *   ② 应用开发页首轮态显示的是**占位空会话**（agentViewBlankSt，不在会话表里），
 *      草稿抄不进任何对象 —— 而那只框里写的正是「下一次开发需求」，
 *      一次整页重绘 / 自动选会话（appsDevEnsureCurrentSession）/ 关页回收就整段丢掉。
 *
 * 这里真跑 renderer/app-apps-dev.js + renderer/app-assist.js（同一 vm + 迷你 DOM），
 * 钉住能在输入框 / config 上看见的行为：
 *   [1] 视图键：三种上下文（会话页 / 开发页那条会话 / 开发页首轮态）各归各的
 *   [2] 输入即记：agentDraftTick 把字写进对应的槽（会话 = _draft；首轮态 = config.appsDevDrafts）
 *   [3] 关页 / 重绘：首轮态那半截需求换个视图再回来原样还在（本轮需求本体）
 *   [4] 首轮态有没发的字时，右栏不许被自动选会话顶掉（1.2s 轮询那条路）
 *   [5] 切应用：A 的半截需求退回 A 名下，B 的框是干净的，回到 A 还在
 *   [6] 发出去 / 用户清空 = 草稿不留痕
 *   [7] 老口径不回退：会话之间仍然各留各的草稿
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
    toString: () => Array.from(el._cls).join(" "),
  };
  el.appendChild = (c) => {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    el.children.push(c);
    return c;
  };
  el.insertBefore = (c, before) => {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    const i = el.children.indexOf(before);
    if (i < 0) el.children.push(c);
    else el.children.splice(i, 0, c);
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
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
  el.addEventListener = () => {};
  el.closest = (sel) => {
    const s = String(sel || "");
    for (let n = el; n; n = n.parentNode) {
      if (s[0] === "." && n._cls && n._cls.has(s.slice(1))) return n;
      if (s[0] === "#" && n.id === s.slice(1)) return n;
    }
    return null;
  };
  Object.defineProperty(el, "firstChild", { get: () => el.children[0] || null });
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
const SESSIONS = [
  { id: "s1", title: "开发 · 新应用", appId: "app-new", messages: [], updatedAt: 3, _draft: "" },
  { id: "s2", title: "开发 · 中间应用", appId: "app-mid", messages: [], updatedAt: 2, _draft: "" },
];
const APPS = [
  { id: "app-new", name: "新应用", dev: true },
  { id: "app-mid", name: "中间应用", dev: true },
];

function build() {
  const root = mkEl("body", "", "");
  const sideList = root.appendChild(mkEl("div", "agent-side-list", "appsDevSideList"));
  const pane = root.appendChild(mkEl("div", "agent-pane", "agentPane"));
  const body = pane.appendChild(mkEl("div", "agent-body", ""));
  const list = body.appendChild(mkEl("div", "agent-list", "agentList"));
  const composer = body.appendChild(mkEl("div", "agent-composer", ""));
  const input = composer.appendChild(mkEl("textarea", "chat-input", "agentInput"));
  const calls = { configSave: [] };
  const timers = new Map();
  let timerSeq = 0;
  const S = {
    agentSessions: SESSIONS,
    agentActiveId: "s1",
    config: {},
  };
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
    /* 重绘依赖：本轮不测渲染，全部换成空实现，只让「草稿存取」这条链真跑 */
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
    /* 定时器：草稿落盘是防抖的，这里收着由测试自己兑现 */
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
  const flush = () => {
    for (const [id, fn] of Array.from(timers.entries())) {
      timers.delete(id);
      fn();
    }
  };
  /* 开发页「装起来」：宿主容器在文档里 + 选中一个应用（appsDevPageOpen 的判据） */
  const openDev = (appId) => {
    get("DEVD").listEl = sideList;
    get("DEVD").appId = appId || "app-new";
    get("DEVD").draft = true;
    get("DEVD").sessionId = "";
  };
  return { sandbox, get, calls, timers, flush, root, sideList, list, composer, input, S, openDev };
}

/* ============================ [1] 视图键 ============================ */
console.log("[1] 草稿的视图键（agentDraftKeyNow）：谁的字记在谁名下");
{
  const s = build();
  s.openDev("app-new");
  s.S.agentActiveId = "s1";
  ok(
    s.get("agentDraftKeyNow()") === "s1",
    "会话页（没有显示覆盖）= 当前会话 id：得到 " + s.get("agentDraftKeyNow()"),
  );
  s.get('agentViewOverrideSet("s2")');
  ok(
    s.get("agentDraftKeyNow()") === "s2",
    "开发页显示某条会话 = 那条会话 id（覆盖不改归属）",
  );
  s.get('agentViewOverrideSet("")');
  ok(
    s.get('agentDraftKeyNow()') === s.get('"\\u0000dev-first:" + "app-new"'),
    "开发页首轮态 = \"\\u0000dev-first:<appId>\"（草稿挂不到占位空会话上，按应用存）",
  );
  s.get("DEVD").appId = "app-mid";
  ok(
    s.get('agentDraftKeyNow()') === s.get('"\\u0000dev-first:" + "app-mid"'),
    "键跟着应用走（切应用 = 换一份草稿，A 的半截字不会跑到 B 名下）",
  );
  s.get("agentViewOverrideClear()");
  ok(s.get("agentDraftKeyNow()") === "s1", "撤掉覆盖回会话页：键回到当前会话");
}

/* ============================ [2] 输入即记 ============================ */
console.log("[2] 输入即记（agentDraftTick）：草稿不再只活在 DOM 里");
{
  const s = build();
  s.openDev("app-new");
  s.get('agentViewOverrideSet("")');
  s.input.value = "给这个应用加一个聊天栏";
  s.get("agentDraftTick()");
  ok(
    s.S.config.appsDevDrafts && s.S.config.appsDevDrafts["app-new"] === "给这个应用加一个聊天栏",
    "首轮态：敲进去的字立刻进 config.appsDevDrafts[appId]",
  );
  s.flush();
  ok(
    s.calls.configSave.length === 1 && s.calls.configSave[0] === s.S.config,
    "落盘走防抖的 window.api.configSave(S.config)（与 appsDevLastApp 同一口径）",
  );
  /* 会话侧：写的是会话自己的 _draft（老口径没变，随会话落盘） */
  s.get("agentViewOverrideClear()");
  s.S.agentActiveId = "s1";
  s.get("renderAgentSession()");
  s.input.value = "会话一的半截话";
  s.get("agentDraftTick()");
  ok(SESSIONS[0]._draft === "会话一的半截话", "会话页：输入即记进这条会话的 _draft");
  ok(
    !s.S.config.appsDevDrafts["s1"],
    "会话草稿不混进开发页草稿表（两张表各管各的）",
  );
}

/* ============================ [3] 切页 / 重绘不丢（本轮需求本体） ============================ */
console.log("[3] 开发页首轮态写一半 → 切走 → 回来，字还在");
{
  const s = build();
  s.openDev("app-new");
  s.S.agentActiveId = "s1";
  SESSIONS[0]._draft = "";
  /* 进开发页：显示覆盖 = 空（首轮态），输入框空 */
  s.get('agentViewOverrideSet("")');
  s.get("renderAgentSession()");
  ok(s.input.value === "", "首轮态刚画出来：输入框是空的（不凭空补字）");
  s.input.value = "把这个应用的首页改成深色";
  s.get("agentDraftTick()");
  ok(
    s.S.config.appsDevDrafts["app-new"] === "把这个应用的首页改成深色",
    "用户正在写的第一轮需求已按应用留底",
  );
  /* 关页 / 切页回收 = app-apps-dev.js appsDevViewClear 的两步：撤覆盖 + 按会话页重绘 */
  s.get("agentViewOverrideClear()");
  s.get("renderAgentSession()");
  ok(s.input.value === "", "切走后这只框换成会话页那条会话的草稿（首轮那半截不再占着它）");
  ok(
    s.S.config.appsDevDrafts["app-new"] === "把这个应用的首页改成深色",
    "人走了，草稿没走",
  );
  /* 回来：重新进开发页（还是首轮态） */
  s.get('agentViewOverrideSet("")');
  s.get("renderAgentSession()");
  ok(
    s.input.value === "把这个应用的首页改成深色",
    "回到开发页：那半截需求原样回到输入框（本轮需求：未输入完毕发送的内容不许丢）",
  );
  /* 再切走切回一次也不磨损 */
  s.get("agentViewOverrideClear()");
  s.get("renderAgentSession()");
  s.get('agentViewOverrideSet("")');
  s.get("renderAgentSession()");
  ok(s.input.value === "把这个应用的首页改成深色", "来回切两次仍然在（存取幂等）");
}

/* ============================ [4] 有没发的字 → 右栏不许被自动选会话顶掉 ============================ */
console.log("[4] 首轮态有未发送内容时，自动选会话那条闸必须闭着");
{
  const s = build();
  s.openDev("app-new");
  s.get('agentViewOverrideSet("")');
  s.get("renderAgentSession()");
  s.input.value = "写了一半的需求";
  const picked = s.get("appsDevEnsureCurrentSession()");
  ok(picked === false, "框里有字：appsDevEnsureCurrentSession 不动（返回 false）");
  ok(
    s.get("DEVD").draft === true && s.get("DEVD").sessionId === "",
    "本页仍停在首轮态（没被换成 app-new 下面那条会话）",
  );
  ok(
    s.get("appsDevDraftPending()") === true,
    "appsDevDraftPending：识别出「有还没发出去的字」",
  );
  /* 用户自己清空输入框：闸放开，老行为恢复（还有会话就必须显示一条） */
  s.input.value = "";
  s.get("agentDraftTick()");
  ok(s.get("appsDevDraftPending()") === false, "框清空 → 不再算 pending");
  const picked2 = s.get("appsDevEnsureCurrentSession()");
  ok(
    picked2 === true && s.get("DEVD").sessionId === "s1",
    "清空后照旧自动落到该应用最近一条会话（不会把开发页卡在首轮态）",
  );
}

/* ============================ [5] 切应用：各归各的 ============================ */
console.log("[5] 切应用：A 的半截需求退回 A 名下，B 拿到自己那份");
{
  const s = build();
  s.openDev("app-new");
  s.get('agentViewOverrideSet("")');
  s.get("renderAgentSession()");
  s.input.value = "A 应用的需求";
  s.get("agentDraftTick()");
  s.S.config.appsDevDrafts["app-mid"] = "B 应用早先写的";
  /* 点左栏另一个应用（app-apps-dev.js appsDevSelectApp 的落点：换 appId + 整页重绘） */
  s.get("DEVD").appId = "app-mid";
  s.get("renderAgentSession()");
  ok(
    s.S.config.appsDevDrafts["app-new"] === "A 应用的需求",
    "切走时 A 的字退回 A 名下（按视图键存，不跟到 B）",
  );
  ok(s.input.value === "B 应用早先写的", "B 的框显示 B 自己的那份草稿");
  s.get("DEVD").appId = "app-new";
  s.get("renderAgentSession()");
  ok(s.input.value === "A 应用的需求", "切回 A：A 的半截需求还在");
}

/* ============================ [6] 发出去 / 清空 = 不留痕 ============================ */
console.log("[6] 首轮需求交出去之后，草稿槽清干净");
{
  const s = build();
  s.openDev("app-new");
  s.get('agentViewOverrideSet("")');
  s.get("renderAgentSession()");
  s.input.value = "这条要发出去";
  s.get("agentDraftTick()");
  ok(s.get("appsDevDraftLoad('app-new')") === "这条要发出去", "前置：草稿在");
  s.get("appsDevDraftClear('app-new')"); /* = appsDevStartDevSession 在会话建好那一刻做的事 */
  ok(s.get("appsDevDraftLoad('app-new')") === "", "发出后：草稿槽清掉");
  ok(
    !s.S.config.appsDevDrafts || !("app-new" in s.S.config.appsDevDrafts),
    "config 里不留空串（下次点「＋」不会冒出上一轮的需求）",
  );
  s.flush();
  ok(
    s.calls.configSave.length === 1,
    "清草稿立刻落盘一次（防抖里那次被清掉，不会多写一遍）：得到 " + s.calls.configSave.length,
  );
  /* 空草稿不占位：写空 = 删条目 */
  s.get("appsDevDraftSave('app-mid', 'x')");
  s.get("appsDevDraftSave('app-mid', '')");
  ok(s.get("appsDevDraftLoad('app-mid')") === "", "写空 = 删条目（不留下 '' 这种占位）");
  /* 发出去之后的再次渲染：框是空的，不是旧字 */
  s.input.value = "";
  s.get("renderAgentSession()");
  ok(s.input.value === "", "发完再画：输入框空白（旧字不会漂回来）");
}

/* ============================ [7] 老口径不回退：会话之间各留各的 ============================ */
console.log("[7] 会话之间的草稿隔离仍然成立（老行为）");
{
  const s = build();
  s.S.agentActiveId = "s1";
  SESSIONS[0]._draft = "";
  SESSIONS[1]._draft = "";
  s.get("renderAgentSession()");
  ok(s.input.value === "", "s1 没有草稿 → 空框");
  s.input.value = "s1 写到一半";
  s.get("agentDraftTick()");
  s.S.agentActiveId = "s2";
  s.get("renderAgentSession()");
  ok(s.input.value === "", "切到 s2：s2 自己的草稿（空）");
  ok(SESSIONS[0]._draft === "s1 写到一半", "s1 那半截存进它自己的 _draft");
  s.input.value = "s2 写到一半";
  s.get("agentDraftTick()");
  s.S.agentActiveId = "s1";
  s.get("renderAgentSession()");
  ok(s.input.value === "s1 写到一半", "切回 s1：s1 的草稿回来");
  ok(SESSIONS[1]._draft === "s2 写到一半" && SESSIONS[0]._draft === "s1 写到一半", "两条会话互不串台");
  /* 老写法（只看会话 id、切那一刻抄一次）已退役：现在是按视图键 + 输入即记 */
  const assist = read("renderer/app-assist.js");
  ok(
    assist.indexOf("const prev = agentSessions().find((x) => x.id === prevId);") < 0,
    "旧的「切会话那一刻才抄一次」写法已去掉（改走 agentDraftKeyNow / agentDraftStash）",
  );
  ok(
    assist.indexOf("S._agentInputDraftKey") >= 0 &&
      assist.indexOf("agentDraftKeyNow()") >= 0,
    "renderAgentSession 按视图键存 / 取草稿（首轮态也在这一条路上）",
  );
  const boot = read("renderer/app-boot.js");
  ok(
    boot.indexOf("agentDraftTick()") >= 0,
    "app-boot.js 的 #agentInput input 监听里挂了 agentDraftTick（输入即记）",
  );
  const dev = read("renderer/app-apps-dev.js");
  ok(
    dev.indexOf("appsDevDraftClear(DEVD.appId);") >= 0,
    "开发会话建好那一刻清掉首轮草稿槽（appsDevStartDevSession）",
  );
}

console.log(
  (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-session-draft-keep)",
);
process.exit(fails ? 1 : 0);

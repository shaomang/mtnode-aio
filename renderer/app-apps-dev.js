"use strict";
/* renderer/app-apps-dev.js — 应用中心「开发」页：三栏 + 底部输入框
 * ============================================================================
 * 一页三栏（在 #appsHub 的开发者页里渲染，见 app-apps.js 的 appsPaintDevPage）：
 *   左 = 只属于该 appId 的会话列表   中 = iframe 实时预览该应用的静态页
 *   右 = 该会话正文（会话列表里的同一条会话）  下 = 输入框（同一个 composer）
 *
 * 复用既有件，不另造一份：
 *   · 左栏会话行 = app-assist.js 的 renderAgentSessionSidebar()。本文件给它一个「宿主」
 *     （appsDevSidebarHost）：宿主在时它只渲染该应用自己的会话（数据 = app-app-flow.js 的
 *     appSessionsOf），写进 #appsDevSideList；宿主不在时它逐字走原来的总会话视图。
 *   · 右栏正文 + 底部输入框 = 会话视图自己的 DOM（#agentList / #agentQueue / #agentPlan /
 *     #agentTodo / #agentPaused / .agent-composer）**原样搬过来**，关页 / 重绘时按原顺序还回
 *     .agent-body。搬运而不复制 ⇒ renderAgentSession() / renderAgentSession(),
 *     buildAgentModelMenu()（提供商 / 预设 / 模型 / 思考强度四项）、输入法、斜杠命令、
 *     ⚡插话 / ⏸暂停全部逐字复用，字段也与会话对象同源。
 *   · 右栏看哪条会话 = **本页自己的显示覆盖**（app-assist.js 的 agentViewOverrideSet）：
 *     「本页显示哪条会话 / 用户是不是正看着它」由 agentViewIs() 一处判定，会话页的选中项
 *     （S.agentActiveId）与它的正文 / 四块面板在整个进出过程中一字不动（离开开发页走
 *     appsDevViewClear 撤掉覆盖并重绘一次）。首轮态覆盖值 = 空 → 占位空会话，四块面板全空。
 *     历史 bug：以前靠直接写 S.agentActiveId「拨过去」，那条会话已不在 / 首轮态没清干净时
 *     右栏就按会话页的当前会话渲染 —— 别的会话的计划 / 任务清单 / 发送队列原样露在右栏。
 *   · 会话引擎 = 既有 agentSessionSend（→ dshRunTask），本文件不改运行链。
 *
 * 首轮输入 = 在该应用的开发节点上点「开发」并提交：
 *   app-boot.js 的 doSend 在「本会话空闲 + 输入框有字」那一刻问一次 appsDevComposerSend()；
 *   开发页开着且处于首轮态（本应用还没有开发会话，或用户点了「＋ 新开发会话」）时由本文件接管：
 *   解析该应用的画布与开发节点（wfOfCanvasIdForRun → appsDevNodeOfWf）→ createDevSessionForNode
 *   （devNodeContractText 任务书整份写进 sess._devContract）→ agentSessionSend("", {_devContract:true})。
 *   「先拷问需求」开关的真源是节点上的 node.devGrill（默认 true，界面切换即写回节点并落盘）。
 *
 * 预览刷新：每轮开发结束后比对应用目录的内容快照（apps:devPreview 的 files / bytes / mtimeMs），
 *   有变才重载 iframe；重载前把预览页的滚动与表单值存下来、加载后写回（协议注入的状态小助手，
 *   见主进程 apps-store.js 的 PREVIEW_AGENT），界面上的「维持状态」开关关掉就不存不写。
 *
 * 依赖全部在调用期按 typeof 取（APPS_ST / appSessionsOf / createDevSessionForNode / persistWf…），
 * 加载顺序只需在 app-apps.js 之后（index.html 生态层）。
 * ============================================================================ */

const DEVD = {
  appId: "", /* 当前开发的应用 id */
  listEl: null, /* 左栏会话列表容器（renderAgentSessionSidebar 的宿主） */
  convEl: null, /* 右栏（搬运来的会话正文落这里） */
  composerEl: null, /* 底部输入框行 */
  frame: null, /* 预览 iframe */
  frameWrap: null, /* 预览 iframe 的容器（兜底提示层挂它上面） */
  previewStatEl: null, /* 中栏兜底提示层（拿不到目录 / 入口页时盖在 iframe 上） */
  previewStatTxt: null, /* 提示正文 */
  previewStatBtn: null, /* 「重试」按钮 */
  statEl: null, /* 预览状态一行 */
  urlEl: null, /* 预览 URL 一行 */
  headEl: null, /* 顶部菜单条（只允许一行） */
  headSlots: [], /* 菜单条上可搬运进「更多」的项（按优先级排） */
  moreBtnEl: null, /* 「更多 ▾」按钮 */
  morePopEl: null, /* 「更多」面板 */
  moreOpen: false,
  moreOff: null, /* 面板开着时的全局监听摘除函数 */
  headRO: null, /* 菜单条宽度监听 */
  headW: 0, /* 上次排版的宽度（同宽不重排，防抖动） */
  turnEl: null, /* 右栏头部：当前轮次说明 */
  warnEl: null, /* 顶部警告条 */
  grillEl: null, /* 「先拷问需求」复选框 */
  filter: "", /* 左栏搜索词 */
  draft: true, /* 首轮态：下一次输入 = 「开发」提交 */
  sessionId: "", /* 非首轮时：右栏展示的会话 id */
  url: "", /* 预览 url（mtnode-preview://…） */
  snap: null, /* 最近一次内容快照 { files, bytes, mtimeMs } */
  keepState: true, /* 「维持状态」开关 */
  pendingState: null, /* 重载前抓到的页面状态 */
  mounted: null, /* { body, saved:[…] }：搬运记录 */
  timer: null,
  busy: false, /* 本应用的会话在跑（跑完的那个边沿用来看预览） */
  msgCount: 0,
  wf: null, /* 该应用的画布对象（wfOfCanvasIdForRun 解析） */
  node: null, /* 该应用的开发节点 */
  nodeFor: "", /* 上面两项是给哪个 appId 解析的 */
  seq: 0,
};

/* ── 小工具 ── */

function appsDevT(s) {
  return window.I18n && I18n.t ? I18n.t(s) : String(s == null ? "" : s);
}
function appsDevToast(msg, kind) {
  if (typeof toast === "function") toast(msg, kind || "ok");
}
function appsDevHubOpen() {
  try {
    if (typeof appsHubIsOpen === "function") return !!appsHubIsOpen();
  } catch (_) {}
  return false;
}
/* 开发页是否正开着（宿主接口与首轮接管都看它：页面隐藏 / 切页 / 容器没了都算没开） */
function appsDevPageOpen() {
  if (!DEVD.listEl || !DEVD.appId) return false;
  if (!document.contains(DEVD.listEl)) return false;
  if (!appsDevHubOpen()) return false;
  return String(APPS_ST && APPS_ST.nav) === "dev";
}
/* app-assist.js 的 renderAgentSessionSidebar 的宿主：在开发页里只渲染该应用的会话，
   写进开发页左栏；首轮态没有活跃行（active = ""）。宿主不在 → 它走原路。 */
function appsDevSidebarHost() {
  if (!appsDevPageOpen()) return null;
  return {
    listEl: DEVD.listEl,
    sessions: typeof appSessionsOf === "function" ? appSessionsOf(DEVD.appId) : [],
    filter: DEVD.filter,
    active: DEVD.draft ? "" : String(DEVD.sessionId || ""),
  };
}

/* ── 会话正文 / 输入框：搬运（不复制） ── */

const DEVD_MOVE_IDS = [
  "agentList",
  "agentPaused",
  "agentQueue",
  "agentPlan",
  "agentTodo",
];
function appsDevAgentBodyEl() {
  const pane = document.getElementById("agentPane");
  return pane ? pane.querySelector(".agent-body") : null;
}
function appsDevComposerEl() {
  return document.querySelector(".agent-composer");
}
/* 把会话视图的正文与输入区搬进开发页（右栏 + 底部）。记录原始子节点顺序，归还时照原样
   appendChild 回去 —— 顺序、对象、事件监听全不变。 */
function appsDevMount() {
  if (DEVD.mounted) return;
  const body = appsDevAgentBodyEl();
  const conv = DEVD.convEl;
  const composerRow = DEVD.composerEl;
  const composer = appsDevComposerEl();
  if (!body || !conv || !composerRow || !composer) return;
  const saved = Array.from(body.children);
  const move = new Set();
  for (const id of DEVD_MOVE_IDS) {
    const el = document.getElementById(id);
    if (el) move.add(el);
  }
  move.add(composer);
  for (const el of saved) {
    if (!move.has(el)) continue;
    if (el === composer) composerRow.appendChild(el);
    else conv.appendChild(el);
  }
  DEVD.mounted = { body: body, saved: saved };
}
/* 归还：按搬运时记下的顺序把节点放回 .agent-body（幂等，未搬运时什么都不做） */
function appsDevUnmount() {
  const m = DEVD.mounted;
  DEVD.mounted = null;
  if (!m || !m.body) return;
  for (const el of m.saved) {
    try {
      m.body.appendChild(el);
    } catch (_) {}
  }
}

/* ── 右栏看哪条会话：本页的显示覆盖（绝不写会话页的 S.agentActiveId） ── */

/* 把「本页显示的会话」绑到显示覆盖上（app-assist.js 的 agentViewOverrideSet）。
   本页还没有会话 / 那条会话已不在（被删、被截断、换了应用）→ 覆盖值 = 空串 = 空态，
   并把本页状态同步回落到首轮态：绝不留一个「非首轮态却画不出东西」的中间态，
   也绝不回落到会话页的当前会话（那正是右栏冒出他会话计划 / 清单的来源）。 */
function appsDevViewBind() {
  const st =
    !DEVD.draft && DEVD.sessionId && typeof agentSessionById === "function"
      ? agentSessionById(DEVD.sessionId)
      : null;
  if (!st) {
    DEVD.draft = true;
    DEVD.sessionId = "";
    DEVD.msgCount = 0;
  }
  try {
    if (typeof agentViewOverrideSet === "function")
      agentViewOverrideSet(st ? st.id : "");
  } catch (_) {}
  return st;
}
/* 撤掉显示覆盖（关页 / 切页 / 整页重绘前）：本页不再显示任何会话，会话视图（马上要还回
   .agent-body 的那份 DOM）按会话页自己的选中项重绘一次 —— 这段时间里会话页一字未动。 */
function appsDevViewClear() {
  if (typeof agentViewOverrideClear !== "function") return;
  try {
    agentViewOverrideClear();
  } catch (_) {}
  try {
    if (typeof renderAgentSession === "function") renderAgentSession();
  } catch (_) {}
  try {
    if (typeof renderAgentSessionSidebar === "function")
      renderAgentSessionSidebar();
  } catch (_) {}
}

/* ── 页面卸载（关页 / 切页 / 整页重绘前） ── */

function appsDevStopTimer() {
  if (DEVD.timer) {
    try {
      clearInterval(DEVD.timer);
    } catch (_) {}
    DEVD.timer = null;
  }
}
/* 借走的 DOM 先还回去，再清掉本页的容器引用（页面 DOM 即将被丢弃 / 已隐藏） */
function appsDevPageUnmount() {
  appsDevStopTimer();
  appsDevUnmount();
  /* 借走的 DOM 已还回，撤掉本页的显示覆盖 → 会话页按它自己的选中项重绘 */
  appsDevViewClear();
  appsDevHeadTeardown();
  DEVD.listEl = null;
  DEVD.convEl = null;
  DEVD.composerEl = null;
  DEVD.frame = null;
  DEVD.frameWrap = null;
  DEVD.previewStatEl = null;
  DEVD.previewStatTxt = null;
  DEVD.previewStatBtn = null;
  DEVD.statEl = null;
  DEVD.urlEl = null;
  DEVD.turnEl = null;
  DEVD.warnEl = null;
  DEVD.grillEl = null;
  DEVD.pendingState = null;
  DEVD.seq++;
}

/* ── 该应用的画布 / 开发节点 ── */

/* 解析该应用画布上的开发节点（画布不一定是前台那张：wfOfCanvasIdForRun 按 id 读盘并入袋）。
   节点上没写过 devGrill → 落 true（默认开启 grill-me；界面开关写回的也是这一位）。 */
async function appsDevEnsureNode(force) {
  const id = String(DEVD.appId || "");
  if (!id) return null;
  if (!force && DEVD.nodeFor === id) return DEVD.node;
  DEVD.nodeFor = id;
  DEVD.wf = null;
  DEVD.node = null;
  let wf = null;
  try {
    if (typeof wfOfCanvasIdForRun === "function") wf = await wfOfCanvasIdForRun(id);
  } catch (_) {
    wf = null;
  }
  if (!wf) return null;
  const node =
    typeof appsDevNodeOfWf === "function" ? appsDevNodeOfWf(wf) : null;
  DEVD.wf = wf;
  DEVD.node = node || null;
  if (node && typeof node.devGrill !== "boolean") {
    node.devGrill = true;
    try {
      if (typeof persistWf === "function") persistWf(wf);
    } catch (_) {}
  }
  return DEVD.node;
}
/* 节点上的「先拷问需求」：没写过 = 默认开 */
function appsDevGrillOn() {
  const n = DEVD.node;
  return !n || n.devGrill !== false;
}

/* ── 预览（iframe + 内容快照 + 维持状态） ── */

async function appsDevPreviewInfo() {
  const api = window.api || {};
  if (typeof api.appsDevPreview !== "function") return null;
  try {
    return await api.appsDevPreview(DEVD.appId);
  } catch (_) {
    return null;
  }
}
/* 只按 appId 就能拼出的兜底预览 url（入口页 = 应用默认 index.html）：
   拿不到 apps:devPreview 的 info 时也不让 iframe 停在 about:blank —— 协议层自己会把
   index.html 当默认入口页发出来（apps-store.js），改过入口名的应用协议层再按目录兜底。 */
function appsDevPreviewUrlFallback(appId) {
  const sid = String(appId || "").trim();
  if (!sid) return "";
  return "mtnode-preview://" + encodeURIComponent(sid) + "/index.html";
}
/* 首次同步（还没拿到 info）时挂上去的 url：应用 id 一有就不留空 iframe */
function appsDevUrlOf(appId) {
  return appsDevPreviewUrlFallback(appId);
}
/* 中栏兜底层：拿不到应用目录 / 入口页时盖在 iframe 上给可读提示 + 「重试」，
   不再只留白底。消息为空 = 收起（iframe 正常显示）。 */
function appsDevPreviewStatMsg(msg, retry) {
  const wrap = DEVD.frameWrap;
  if (!wrap) return;
  let el = DEVD.previewStatEl;
  if (!msg) {
    if (el) el.hidden = true;
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "apps-dev-framestat";
    el.hidden = true;
    const txt = document.createElement("div");
    txt.className = "apps-dev-framestat-txt";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini apps-dev-framestat-retry";
    btn.textContent = appsDevT("重试");
    btn.onclick = () => appsDevRetryPreview();
    el.appendChild(txt);
    el.appendChild(btn);
    wrap.appendChild(el);
    DEVD.previewStatEl = el;
    DEVD.previewStatTxt = txt;
    DEVD.previewStatBtn = btn;
  }
  el.hidden = false;
  if (DEVD.previewStatTxt) DEVD.previewStatTxt.textContent = String(msg);
  if (DEVD.previewStatBtn != null) DEVD.previewStatBtn.hidden = retry === false;
}
/* 「重试」：重取预览 info 并按结果重挂 / 重载 iframe（首帧挂 url 那条链整条重跑） */
async function appsDevRetryPreview() {
  if (!appsDevPageOpen()) return;
  const id = DEVD.appId;
  appsDevPreviewStatMsg(appsDevT("正在读取应用目录…"), false);
  const info = await appsDevPreviewInfo();
  if (!appsDevPageOpen() || String(DEVD.appId) !== String(id)) return;
  if (!info || info.ok === false) {
    DEVD.url = "";
    DEVD.snap = null;
    const fb = appsDevUrlOf(id);
    if (fb) {
      DEVD.url = fb;
      appsDevPaintUrl();
      if (DEVD.frame && DEVD.frame.getAttribute("src") !== fb)
        DEVD.frame.setAttribute("src", fb);
    }
    appsDevPaintPreviewStat("error");
    appsDevPreviewStatMsg(
      info && info.error
        ? appsDevT("预览不可用：") + String(info.error)
        : appsDevT("读不到该应用目录（可能在别处被删了）"),
    );
    return;
  }
  DEVD.url = String(info.url || "") || appsDevUrlOf(id);
  DEVD.snap = {
    files: info.files,
    bytes: info.bytes,
    mtimeMs: info.mtimeMs,
    entry: info.entry,
  };
  appsDevPaintPreviewStat("same");
  appsDevPaintUrl();
  appsDevPreviewStatMsg("");
  await appsDevReloadPreview();
}
/* 存预览页状态：往 iframe 发一条 save，等它把滚动 / 表单值发回来（超时回 null） */
function appsDevFrameStateSave(timeoutMs) {
  const frame = DEVD.frame;
  if (!frame || !frame.contentWindow) return Promise.resolve(null);
  return new Promise((resolve) => {
    const token =
      "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let settled = false;
    const onMsg = (ev) => {
      const d = ev.data || {};
      if (ev.source !== frame.contentWindow) return;
      if (d.__mtnodePreview !== 1 || d.op !== "state" || d.token !== token) return;
      settled = true;
      window.removeEventListener("message", onMsg);
      resolve(d.state || null);
    };
    window.addEventListener("message", onMsg);
    try {
      frame.contentWindow.postMessage(
        { __mtnodePreview: 1, op: "save", token: token },
        "*",
      );
    } catch (_) {}
    setTimeout(() => {
      if (settled) return;
      window.removeEventListener("message", onMsg);
      resolve(null);
    }, timeoutMs || 700);
  });
}
/* 重载预览：开着「维持状态」就先存页面状态，加载完成后由 load 监听写回 */
async function appsDevReloadPreview() {
  const frame = DEVD.frame;
  if (!frame) return;
  /* 还没拿到 info 的 url：用 appId 拼的兜底 url（协议层按目录兜底发默认入口页） */
  if (!DEVD.url) DEVD.url = appsDevUrlOf(DEVD.appId);
  if (!DEVD.url) return;
  DEVD.pendingState = null;
  if (DEVD.keepState && frame.getAttribute("src")) {
    DEVD.pendingState = await appsDevFrameStateSave(700);
  }
  const sep = DEVD.url.indexOf("?") >= 0 ? "&" : "?";
  frame.setAttribute("src", DEVD.url + sep + "_r=" + Date.now());
  appsDevPreviewStatMsg("");
}
function appsDevPaintPreviewStat(kind) {
  const el = DEVD.statEl;
  if (!el) return;
  const s = DEVD.snap || {};
  const bits = [];
  if (s.files != null) bits.push(s.files + appsDevT(" 个文件"));
  if (s.bytes != null && typeof appsBytes === "function")
    bits.push(appsBytes(s.bytes));
  if (s.mtimeMs && typeof appsTime === "function")
    bits.push(appsDevT("最近修改 ") + appsTime(s.mtimeMs));
  const head =
    kind === "changed"
      ? appsDevT("内容有改动 → 已重载预览")
      : kind === "reload"
        ? appsDevT("已重载预览")
        : kind === "error"
          ? appsDevT("预览不可用")
          : appsDevT("预览已是最新");
  el.textContent = head + (bits.length ? " · " + bits.join(" · ") : "");
}
function appsDevPaintUrl() {
  const el = DEVD.urlEl;
  if (!el) return;
  const info = DEVD.snap || {};
  el.textContent = String(DEVD.url || "");
  el.title =
    appsDevT("静态预览：应用目录里的入口页（相对资源同源加载；不注入 window.appHost）") +
    (info.entry ? "\n" + appsDevT("入口页：") + info.entry : "");
}
/* 内容快照比对：有变（或 force）才重载预览 */
async function appsDevCheckPreview(force) {
  if (!appsDevPageOpen()) return;
  const r = await appsDevPreviewInfo();
  if (!appsDevPageOpen() || !r) return;
  if (r.ok === false) {
    DEVD.snap = null;
    appsDevPaintPreviewStat("error");
    /* 轮询里发现预览不可用：中栏盖回可读提示（拿不到目录 / 入口页，别只留白底） */
    appsDevPreviewStatMsg(
      r.error
        ? appsDevT("预览不可用：") + String(r.error)
        : appsDevT("读不到该应用目录（可能在别处被删了）"),
    );
    return;
  }
  const prev = DEVD.snap;
  const changed =
    !prev ||
    prev.files !== r.files ||
    prev.bytes !== r.bytes ||
    prev.mtimeMs !== r.mtimeMs;
  DEVD.snap = {
    files: r.files,
    bytes: r.bytes,
    mtimeMs: r.mtimeMs,
    entry: r.entry,
  };
  appsDevPaintPreviewStat(changed || force ? "changed" : "same");
  if (changed || force) await appsDevReloadPreview();
}

/* ── 每轮结束检测（不挂钩子：看会话在跑 → 跑完的边沿 + 消息条数增长两路判定） ── */

function appsDevSessionRunning(s) {
  if (!s) return false;
  try {
    if (typeof sessionIsRunning === "function") return !!sessionIsRunning(s);
  } catch (_) {}
  return !!s.running;
}
function appsDevTick() {
  if (!appsDevPageOpen()) return;
  const list = typeof appSessionsOf === "function" ? appSessionsOf(DEVD.appId) : [];
  const running = list.some(appsDevSessionRunning);
  const st = DEVD.sessionId
    ? typeof agentSessionById === "function"
      ? agentSessionById(DEVD.sessionId)
      : null
    : null;
  const cnt = st && Array.isArray(st.messages) ? st.messages.length : 0;
  /* 消息条数长了 = 这一轮落定（快轮次也抓得到）；跑过的边沿 = 兜底 */
  const grew = !!st && DEVD.msgCount > 0 && cnt > DEVD.msgCount;
  DEVD.msgCount = cnt;
  if (running) {
    DEVD.busy = true;
    return;
  }
  if (DEVD.busy || grew) {
    DEVD.busy = false;
    appsDevCheckPreview(false).catch(() => {});
  }
}
function appsDevStartTimer() {
  appsDevStopTimer();
  DEVD.timer = setInterval(() => {
    try {
      appsDevTick();
    } catch (_) {}
  }, 1200);
}

/* 右栏 / 左栏重绘 ── */

/* 右栏头部与首轮态：只有它俩变了（选了别的会话 / 回到首轮）时单独调，不必整表重绘 */
function appsDevApplyTurn() {
  const conv = DEVD.convEl;
  if (conv) conv.classList.toggle("is-draft", !!DEVD.draft);
  if (!DEVD.turnEl) return;
  const st =
    !DEVD.draft && typeof agentSessionById === "function"
      ? agentSessionById(DEVD.sessionId)
      : null;
  /* 右栏标题条 = 这条开发会话的名字，与左「会话」、中「预览」同风格（三条标题条的高度
     由 CSS 的 --apps-dev-colhead-h 一处锁定）；那句「后续输入 = …」的长说明并进悬浮
     说明，不再把它挤在标题条里。首轮态还没有会话 → 显示「开发会话」这个中性名。 */
  const name = String((st && st.title) || "") || appsDevT("开发会话");
  DEVD.turnEl.textContent = name;
  DEVD.turnEl.title = st
    ? name + appsDevT(" · 后续输入 = 这个会话的普通一轮")
    : appsDevT(
        "首轮：写下本次开发需求 → 等同在该应用的开发节点上点「开发」并提交",
      );
}
function appsDevRenderConv() {
  /* 右栏这条会话 = 本页的显示会话（显示覆盖）；绑定不碰会话页的选中项 */
  appsDevViewBind();
  appsDevApplyTurn();
  /* 右栏的面板（计划 / 任务清单 / 发送队列 / 已暂停）必须跟**右栏这条会话**同源：
     ① 首轮态（还没有本应用的开发会话）覆盖值 = 空 → 会话视图按占位空会话渲染，四块
        面板一律为空；下面再显式清一次，双保险（清显示，不落盘、不动会话数据）；
     ② 非首轮态覆盖值 = 这条会话 → renderAgentSession() 与四块面板的同源刷新
        （app-assist.js / app-plan.js 的 agentViewIs 判据）全部按它自己重绘。 */
  if (DEVD.draft || !DEVD.sessionId) {
    appsDevClearConvPanels();
  }
  try {
    if (typeof renderAgentSession === "function") renderAgentSession();
  } catch (_) {}
  try {
    if (typeof renderAgentSessionSidebar === "function")
      renderAgentSessionSidebar();
  } catch (_) {}
  try {
    if (typeof paintAgentSendState === "function") paintAgentSendState();
  } catch (_) {}
}
/* 清掉会话视图搬进右栏的四块面板（首轮态 / 换应用 / 还没有本应用会话时调）：
   只隐藏并清空显示，不落盘、不动会话数据 —— 回看别的会话时它们照常按自己的数据重绘。 */
function appsDevClearConvPanels() {
  for (const id of ["agentPlan", "agentTodo", "agentQueue", "agentPaused"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = true;
    el.innerHTML = "";
  }
}

/* ── 首轮：等同在开发节点上点「开发」并提交 ── */

/* app-boot.js 的 doSend 在「空闲 + 有文本」时问一次：返回 true = 这一发由开发页接管。
   只在首轮态（还没有本应用的开发会话 / 用户点了「＋ 新开发会话」）接管。 */
function appsDevComposerSend(raw) {
  if (!appsDevPageOpen() || !DEVD.draft) return false;
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return false;
  appsDevStartDevSession(text).catch(() => {});
  return true;
}
async function appsDevStartDevSession(text) {
  const reqText = String(text == null ? "" : text).trim();
  if (!DEVD.appId || !reqText) return false;
  const node = await appsDevEnsureNode();
  if (!node) {
    appsDevToast(
      appsDevT(
        "该应用的画布上没有开发节点：先在画布上建一个功能块（项目文件夹指向应用目录）",
      ),
      "err",
    );
    appsDevPaintWarn(
      appsDevT("找不到该应用的开发节点（画布缺失或还没建功能块）"),
    );
    return true;
  }
  if (typeof createDevSessionForNode !== "function") return true;
  const sess = createDevSessionForNode(node, "dev", reqText);
  if (!sess) return true;
  if (node.devStatus !== "done") node.devStatus = "wip";
  /* 该应用的画布落盘：createDevSessionForNode 把会话 id 写进了节点
     （agentSessionId / devSessionIds），状态也刚转成进行中。这张画布未必是前台那张，
     所以走 persistWf（按它自己的 id 写），不用 scheduleSave（那只写前台画布）。 */
  if (DEVD.wf) {
    try {
      if (typeof persistWf === "function") persistWf(DEVD.wf);
    } catch (_) {}
  }
  /* 本页刚建好的这条开发会话 = 本页要显示的会话（走显示覆盖，不写会话页的选中项） */
  DEVD.draft = false;
  DEVD.sessionId = sess.id;
  DEVD.msgCount = 0;
  DEVD.busy = true;
  try {
    await persistAgentSession();
  } catch (_) {}
  appsDevRenderConv();
  appsDevToast(
    appsDevT("已创建开发会话「") +
      (sess.title || "") +
      appsDevT("」并开始运行（工作区 = 应用目录）"),
  );
  try {
    if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
  } catch (_) {}
  if (S.wf && DEVD.wf && String(S.wf.id) === String(DEVD.wf.id)) {
    try {
      if (typeof renderCanvas === "function") renderCanvas();
    } catch (_) {}
  }
  try {
    /* 任务书整份在会话契约 _devContract 里（发送时注入系统提示），首条消息只有用户
       关键输入；这一发即启动本轮（与画布上点「开发」的收尾逐字同一条链）。
       sessionId 显式点名这条新会话：不靠「当前活动会话」这种隐式状态。 */
    await agentSessionSend("", { _devContract: true, sessionId: sess.id });
  } catch (err) {
    appsDevToast(
      appsDevT("开发会话启动失败：") + ((err && err.message) || String(err)),
      "err",
    );
  }
  return true;
}
/* 「＋ 新开发会话」：回到首轮态（下一次输入新建一条绑定会话） */
function appsDevNewRound() {
  DEVD.draft = true;
  DEVD.sessionId = "";
  DEVD.msgCount = 0;
  appsDevRenderConv();
  const inp = document.getElementById("agentInput");
  if (inp) inp.focus();
}

/* ── 顶部：应用选择 / 开关 / 警告条 ── */

function appsDevPaintWarn(msg) {
  const el = DEVD.warnEl;
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}
async function appsDevRefreshHead() {
  const node = await appsDevEnsureNode();
  if (!appsDevPageOpen()) return;
  const grill = DEVD.grillEl;
  if (grill) grill.checked = appsDevGrillOn();
  if (!node) {
    appsDevPaintWarn(
      appsDevT(
        "该应用的画布上还没有开发节点：首轮输入会失败 —— 先在画布上建一个功能块并把「项目文件夹」指向应用目录",
      ),
    );
    return;
  }
  appsDevPaintWarn(
    String(node.devPath || "").trim()
      ? ""
      : appsDevT(
          "该开发节点还没设「项目文件夹」（devPath）：会话工作区会退回默认目录",
        ),
  );
}

/* ── 顶部菜单条：一行 + 按宽度搬运进「更多 ▾」 ── */

/* 状态文字至少要留这么宽，否则继续往「更多」里收（窄到放不下时优先牺牲项，不牺牲可读性） */
const DEVD_STAT_MIN = 96;

/* 应用根目录（这条工具栏里的紧凑版）：路径 + 更改…；点路径 = 在资源管理器中打开。
   与库页那行（app-apps.js 的 appsRootLineEl）共用同一份动作函数，不写第二份逻辑。 */
function appsDevRootItem() {
  const root = (typeof APPS_ST === "object" && APPS_ST && APPS_ST.root) || {};
  const box = document.createElement("span");
  box.className = "apps-dev-root";
  const path = String(root.path || "");
  const val = document.createElement("button");
  val.type = "button";
  val.className = "apps-dev-root-v";
  val.textContent = path || appsDevT("未设置");
  val.title = (path || appsDevT("未设置")) + "\n" + appsDevT("点击在资源管理器中打开");
  val.onclick = () => {
    if (typeof appsRootFolderNow === "function") appsRootFolderNow();
  };
  box.appendChild(val);
  if (!root.configured) {
    const warn = document.createElement("span");
    warn.className = "apps-badge apps-badge-bad";
    warn.textContent = appsDevT("未设置");
    warn.title = appsDevT("未设置：下载前会先让你选一个文件夹");
    box.appendChild(warn);
  }
  box.appendChild(
    appsMiniBtn(appsDevT("更改…"), () => {
      if (typeof appsRootPickNow === "function") appsRootPickNow();
    }),
  );
  return box;
}

/* 收掉这条工具栏上的监听 / 观察者（关页、切页、整页重绘前都要走） */
function appsDevHeadTeardown() {
  appsDevMoreToggle(false);
  if (DEVD.headRO) {
    try {
      DEVD.headRO.disconnect();
    } catch (_) {}
  }
  DEVD.headRO = null;
  DEVD.headEl = null;
  DEVD.headSlots = [];
  DEVD.moreBtnEl = null;
  DEVD.morePopEl = null;
  DEVD.headW = 0;
}

/* 菜单条宽度监听：同宽不重排（重排会改布局，防抖一次） */
function appsDevStartHeadWatch(head) {
  if (!head) return;
  if (DEVD.headRO) {
    try {
      DEVD.headRO.disconnect();
    } catch (_) {}
  }
  DEVD.headRO = null;
  if (typeof ResizeObserver !== "function") return;
  const ro = new ResizeObserver(() => {
    const w = DEVD.headEl ? DEVD.headEl.clientWidth : 0;
    if (w === DEVD.headW) return;
    DEVD.headW = w;
    appsDevFitHead();
  });
  try {
    ro.observe(head);
  } catch (_) {}
  DEVD.headRO = ro;
  DEVD.headW = head.clientWidth;
}

/* 开 / 关「更多 ▾」。它是瞬态菜单（没有待保存的输入），所以允许点外部即收；
   Esc 也收。关的时候一定摘干净全局监听。 */
function appsDevMoreToggle(open) {
  const pop = DEVD.morePopEl;
  const btn = DEVD.moreBtnEl;
  if (DEVD.moreOff) {
    try {
      DEVD.moreOff();
    } catch (_) {}
    DEVD.moreOff = null;
  }
  if (!pop || !btn) return;
  const next = !!open && !btn.hidden;
  DEVD.moreOpen = next;
  pop.hidden = !next;
  btn.classList.toggle("on", next);
  btn.setAttribute("aria-expanded", next ? "true" : "false");
  if (!next) return;
  const onDown = (ev) => {
    const t = ev.target;
    if (t && (pop.contains(t) || btn.contains(t))) return;
    appsDevMoreToggle(false);
  };
  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    /* 只收这块面板：别让一次 Esc 顺手把背后的对话框 / 浮层也关掉 */
    ev.stopPropagation();
    appsDevMoreToggle(false);
    const b = DEVD.moreBtnEl;
    if (b && typeof b.focus === "function") b.focus();
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  DEVD.moreOff = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

/* 排版：只允许一行。先把所有项放回主行量出**真实宽度**，再按优先级「前缀留主行、
   后缀收进更多」一次算清 —— 不靠反复读 scrollWidth 试（布局没落定时那会读晚一帧，
   结果是尾巴被 overflow:hidden 裁掉，而裁掉的恰好是最右的「更多」）。 */
function appsDevFitHead() {
  const head = DEVD.headEl;
  const pop = DEVD.morePopEl;
  const btn = DEVD.moreBtnEl;
  if (!head || !pop || !btn) return;
  const slots = DEVD.headSlots || [];
  appsDevMoreToggle(false);
  for (const s of slots) head.insertBefore(s, btn);
  if (!slots.length) {
    btn.hidden = true;
    return;
  }
  /* 量「更多」按钮宽度前它得先可见（hidden 的元素 offsetWidth = 0） */
  btn.hidden = false;
  const GAP = 8; /* .apps-dev-head 的 gap */
  const content = head.clientWidth - 20; /* 左右各 10px 内边距 */
  /* 状态文字是「剩下多少就吃多少」的弹性项（flex:0 1 auto，下限 96px），
     所以预算里只给它保底那 96px：其余项排得下就都留主行，排不下才往「更多」里收。 */
  let used = DEVD_STAT_MIN + GAP + btn.offsetWidth + GAP;
  const order = slots
    .slice()
    .sort((a, b) => Number(a.dataset.pri) - Number(b.dataset.pri));
  let keep = 0;
  for (const s of order) {
    const w = s.offsetWidth + GAP;
    if (used + w > content) break;
    used += w;
    keep++;
  }
  const moved = order.slice(keep);
  for (const s of moved) pop.appendChild(s);
  const names = moved.map((s) => String(s.dataset.label || s.textContent || "").trim());
  btn.hidden = names.length === 0;
  btn.title = names.length
    ? appsDevT("更多（放不下的项在这里）：") + names.join(" · ")
    : "";
  if (!names.length) appsDevMoreToggle(false);
}

/* ── 整页绘制（app-apps.js 的 appsPaintDevPage 调） ── */

function appsDevPagePaint(body, seq) {
  appsDevStartTimer();
  /* 整页重绘前先归还借走的会话 DOM（三栏容器马上要被重建；上一轮的容器可能已从
     DOM 上摘掉，所以这里不能只依赖 appsHubPaint 的卸载钩子） */
  appsDevUnmount();
  const apps = typeof appsLocalList === "function" ? appsLocalList() : [];
  const ids = apps.map((a) => String(a.id || ""));
  let cur = String(DEVD.appId || "");
  if (!ids.includes(cur)) cur = ids.length ? ids[0] : "";
  const switched = cur !== String(DEVD.appId || "");
  if (switched) {
    /* 换应用 = 新的一页上下文：会话归属 / 预览 / 快照全部重来 */
    DEVD.appId = cur;
    DEVD.draft = true;
    DEVD.sessionId = "";
    DEVD.msgCount = 0;
    DEVD.snap = null;
    DEVD.url = "";
    DEVD.wf = null;
    DEVD.node = null;
    DEVD.nodeFor = "";
  }
  DEVD.seq++;
  const mySeq = DEVD.seq;

  const wrap = document.createElement("div");
  wrap.className = "apps-dev";

  /* 顶部菜单条：**只允许一行**（.apps-dev-head 是 nowrap）。宽了主行多放，窄了自动把
     优先级最低的几项搬进「更多 ▾」——功能一个不少，只是位置随宽度变：
     应用选择 / ＋新开发会话 / 打开画布 / 刷新预览 / 应用根目录 / ＋新建应用 /
     先拷问需求 / 维持状态 / 预览状态 全在这一条上（appsDevFitHead 负责搬运）。 */
  const head = document.createElement("div");
  head.className = "apps-dev-head";
  DEVD.headEl = head;
  DEVD.headSlots = [];
  /* 建一个可搬运项：pri 越小越重要，宽度不够时从 pri 最大的开始收进「更多」。
     label 非空 = 面板里给它一行小标题（自带文案的按钮 / 开关就不必给）。 */
  const addSlot = (pri, el, label) => {
    const s = document.createElement("span");
    s.className = "apps-dev-slot";
    s.dataset.pri = String(pri);
    if (label) s.dataset.label = appsDevT(label);
    s.appendChild(el);
    DEVD.headSlots.push(s);
    return s;
  };
  const appsSelect = document.createElement("select");
  appsSelect.className = "apps-select apps-dev-app";
  for (const app of apps) {
    const o = document.createElement("option");
    o.value = String(app.id || "");
    o.textContent = String(app.name || app.id || "");
    appsSelect.appendChild(o);
  }
  appsSelect.value = cur;
  appsSelect.onchange = () => appsDevSelectApp(appsSelect.value);
  const appGrp = document.createElement("span");
  appGrp.className = "apps-dev-appgrp";
  const kApp = document.createElement("span");
  kApp.className = "apps-dev-head-k";
  kApp.textContent = appsDevT("应用");
  appGrp.appendChild(kApp);
  appGrp.appendChild(appsSelect);
  head.appendChild(addSlot(0, appGrp));
  head.appendChild(
    addSlot(
      1,
      appsMiniBtn(appsDevT("＋ 新开发会话"), () => appsDevNewRound(), true),
    ),
  );
  head.appendChild(
    addSlot(
      2,
      appsMiniBtn(appsDevT("打开画布"), () => {
        if (DEVD.appId && typeof openAppCanvas === "function")
          openAppCanvas(DEVD.appId);
      }),
    ),
  );
  head.appendChild(
    addSlot(
      3,
      appsMiniBtn(appsDevT("刷新预览"), () =>
        appsDevCheckPreview(true).catch(() => {}),
      ),
    ),
  );
  head.appendChild(addSlot(4, appsDevRootItem(), "应用根目录"));
  if (typeof appsCreateAppBtnEl === "function") head.appendChild(addSlot(5, appsCreateAppBtnEl()));
  const mkSwitch = (label, checked, onchange, title) => {
    const lab = document.createElement("label");
    lab.className = "apps-dev-sw";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    cb.onchange = () => onchange(cb.checked);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(appsDevT(label)));
    if (title) lab.title = appsDevT(title);
    return { lab: lab, cb: cb };
  };
  const grill = mkSwitch(
    "先拷问需求",
    appsDevGrillOn(),
    async (on) => {
      const node = await appsDevEnsureNode();
      if (!node) {
        appsDevToast(appsDevT("该应用还没有可写的开发节点"), "err");
        return;
      }
      node.devGrill = !!on;
      try {
        if (typeof persistWf === "function") persistWf(DEVD.wf);
      } catch (_) {}
      appsDevToast(
        on
          ? appsDevT("已开启：本次开发会话先按轮问清需求，确认后才动手")
          : appsDevT("已关闭：开发会话直接开工"),
      );
    },
    "开启 = 本次开发会话先用内置技能 mtnode-grill-me 按轮问清需求，达成共识后才动手（真源是开发节点上的 devGrill）",
  );
  DEVD.grillEl = grill.cb;
  head.appendChild(addSlot(6, grill.lab));
  const keep = mkSwitch(
    "维持状态",
    DEVD.keepState,
    (on) => {
      DEVD.keepState = !!on;
    },
    "重载预览前先存下预览页的滚动位置与表单内容，加载后写回",
  );
  head.appendChild(addSlot(7, keep.lab));
  const stat = document.createElement("span");
  stat.className = "apps-dev-stat";
  DEVD.statEl = stat;
  head.appendChild(stat);
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "mini apps-dev-morebtn";
  moreBtn.hidden = true;
  moreBtn.textContent = appsDevT("更多") + " ▾";
  moreBtn.setAttribute("aria-expanded", "false");
  moreBtn.onclick = (ev) => {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    appsDevMoreToggle(!DEVD.moreOpen);
  };
  DEVD.moreBtnEl = moreBtn;
  head.appendChild(moreBtn);
  const morePop = document.createElement("div");
  morePop.className = "apps-dev-more-pop";
  morePop.hidden = true;
  DEVD.morePopEl = morePop;
  /* 面板要能探出这条工具栏：工具栏自己 overflow:hidden（一行不折行靠它收尾），
     所以面板挂在外面这层 .apps-dev-topbar 上，不在 head 里被裁掉。 */
  const headWrap = document.createElement("div");
  headWrap.className = "apps-dev-topbar";
  headWrap.appendChild(head);
  headWrap.appendChild(morePop);
  wrap.appendChild(headWrap);
  /* 首帧排一次（此刻 head 还没进 DOM，等一帧再看宽度）；之后宽度一变就重排 */
  requestAnimationFrame(() => {
    appsDevStartHeadWatch(head);
    appsDevFitHead();
  });

  const warn = document.createElement("div");
  warn.className = "apps-dev-warn";
  warn.hidden = true;
  DEVD.warnEl = warn;
  wrap.appendChild(warn);

  /* 三栏 */
  const cols = document.createElement("div");
  cols.className = "apps-dev-cols";

  const side = document.createElement("section");
  side.className = "apps-dev-col apps-dev-side";
  const sideHead = document.createElement("div");
  sideHead.className = "apps-dev-colhead";
  const sideK = document.createElement("span");
  sideK.textContent = appsDevT("会话");
  const q = document.createElement("input");
  /* type=text：走 base.css 的全局输入样式（深色底 / 1px 边框 / 4px 6px 内边距）。
     以前是 type=search —— 全局输入样式表不含 search，它吃浏览器默认样式把整条标题条
     撑高，三栏标题条就再也等不了高（本页标题条高度统一见 css/apps.css 的
     --apps-dev-colhead-h）。 */
  q.type = "text";
  q.className = "apps-dev-q";
  q.placeholder = appsDevT("搜索会话…");
  q.value = DEVD.filter || "";
  q.oninput = () => {
    DEVD.filter = q.value;
    try {
      if (typeof renderAgentSessionSidebar === "function")
        renderAgentSessionSidebar();
    } catch (_) {}
  };
  sideHead.appendChild(sideK);
  sideHead.appendChild(q);
  side.appendChild(sideHead);
  const sideList = document.createElement("div");
  sideList.className = "agent-side-list";
  sideList.id = "appsDevSideList";
  side.appendChild(sideList);
  /* 行自己的 onclick（app-assist.js）会设活动会话并重绘：这里在捕获段先把宿主态对齐，
     （点行内按钮不算选会话） */
  sideList.addEventListener(
    "click",
    (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest(".side-sess-btns")) return;
      const row = t.closest(".side-sess");
      const sid = row && row.dataset ? row.dataset.sid : "";
      if (!sid) return;
      DEVD.draft = false;
      DEVD.sessionId = sid;
      if (typeof agentSessionById === "function") {
        const st = agentSessionById(sid);
        DEVD.msgCount =
          st && Array.isArray(st.messages) ? st.messages.length : 0;
      }
      /* 行自己的 onclick 只会重绘正文与左栏：这里把右栏首轮态与头部说明一起对齐
         （否则 is-draft 还挂着，正文会一直藏着）。走整段重绘（appsDevRenderConv）而不是
         只调 appsDevApplyTurn()：它同时把活动会话拨到刚点中的这条，右栏的计划 / 任务清单
         才跟着换过来，不会留着上一条会话的清单。 */
      appsDevRenderConv();
    },
    true,
  );
  cols.appendChild(side);

  const view = document.createElement("section");
  view.className = "apps-dev-col apps-dev-view";
  const viewHead = document.createElement("div");
  viewHead.className = "apps-dev-colhead";
  const viewK = document.createElement("span");
  viewK.textContent = appsDevT("预览");
  const urlEl = document.createElement("span");
  urlEl.className = "apps-dev-url";
  viewHead.appendChild(viewK);
  viewHead.appendChild(urlEl);
  view.appendChild(viewHead);
  DEVD.urlEl = urlEl;
  const frameWrap = document.createElement("div");
  frameWrap.className = "apps-dev-framewrap";
  DEVD.frameWrap = frameWrap;
  DEVD.previewStatEl = null;
  DEVD.previewStatTxt = null;
  DEVD.previewStatBtn = null;
  const frame = document.createElement("iframe");
  frame.id = "appsDevFrame";
  frame.className = "apps-dev-frame";
  frame.title = appsDevT("应用预览");
  /* 首帧就挂上兜底 url（appId + 默认入口 index.html）：中栏不再等异步 info 才有 src，
     拿不到目录 / 入口页时也不会只剩 about:blank —— 协议层按目录兜底发默认入口页。 */
  DEVD.url = appsDevUrlOf(cur);
  if (DEVD.url) frame.setAttribute("src", DEVD.url);
  DEVD.frame = frame;
  frame.addEventListener("load", () => {
    const pending = DEVD.pendingState;
    DEVD.pendingState = null;
    if (!pending || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(
        { __mtnodePreview: 1, op: "restore", state: pending },
        "*",
      );
    } catch (_) {}
  });
  frameWrap.appendChild(frame);
  view.appendChild(frameWrap);
  cols.appendChild(view);

  const conv = document.createElement("section");
  conv.className = "apps-dev-col apps-dev-conv";
  conv.id = "appsDevConv";
  const convHead = document.createElement("div");
  convHead.className = "apps-dev-colhead";
  const turnEl = document.createElement("span");
  turnEl.className = "apps-dev-turn";
  convHead.appendChild(turnEl);
  conv.appendChild(convHead);
  DEVD.turnEl = turnEl;
  const draftHint = document.createElement("div");
  draftHint.className = "apps-dev-draft";
  draftHint.textContent = appsDevT(
    "还没有这个应用的开发会话：在下面写本次开发需求并回车 —— 等同在该应用的开发节点上点「开发」并提交（新建绑定会话 · 工作区 = 应用目录 · 任务书整份随系统提示注入）。",
  );
  conv.appendChild(draftHint);
  cols.appendChild(conv);
  DEVD.convEl = conv;
  wrap.appendChild(cols);

  /* 底部输入框行：会话视图那只 composer 原样搬进来 */
  const composerRow = document.createElement("div");
  composerRow.className = "apps-dev-composer";
  composerRow.id = "appsDevComposer";
  wrap.appendChild(composerRow);
  DEVD.composerEl = composerRow;

  body.appendChild(wrap);
  DEVD.listEl = sideList;
  appsDevMount();
  /* 首帧就绑好显示覆盖、并按本页这条会话画一次：预览 info / 开发节点都是异步的，
     不先画一次的话，这段空窗期里右栏（刚搬过来的那几个面板）还留着上一个上下文的
     内容 —— 首帧残留（用户看到的「刚点开开发页，右栏里是别人的计划」）。 */
  appsDevRenderConv();

  if (!cur) {
    appsDevPaintPreviewStat("error");
    appsDevPreviewStatMsg(appsDevT("还没有可预览的应用：先新建或安装一个应用"));
    return;
  }
  appsDevSyncAfterPaint(mySeq, seq).catch(() => {});
}

/* 绘制之后的异步对齐：预览 info / 开发节点 / 选一条会话 */
async function appsDevSyncAfterPaint(mySeq, seq) {
  const alive = () =>
    DEVD.seq === mySeq && appsDevPageOpen() && seq === APPS_ST.seq;
  const info = await appsDevPreviewInfo();
  if (!alive()) return;
  if (!info || info.ok === false) {
    /* 拿不到目录 / info：url 退回按 appId 拼的兜底（协议层发默认入口页），
       确实读不到时中栏盖一层可读提示 + 「重试」，而不是只剩白底 */
    DEVD.url = appsDevUrlOf(DEVD.appId);
    appsDevPaintPreviewStat("error");
    appsDevPaintUrl();
    if (DEVD.url && DEVD.frame && DEVD.frame.getAttribute("src") !== DEVD.url)
      DEVD.frame.setAttribute("src", DEVD.url);
    appsDevPaintWarn(
      info && info.error
        ? appsDevT("预览不可用：") + String(info.error)
        : appsDevT("读不到该应用目录（可能在别处被删了）"),
    );
    appsDevPreviewStatMsg(
      info && info.error
        ? appsDevT("预览不可用：") + String(info.error)
        : appsDevT("读不到该应用目录（可能在别处被删了）"),
    );
  } else {
    DEVD.url = String(info.url || "") || appsDevUrlOf(DEVD.appId);
    DEVD.snap = {
      files: info.files,
      bytes: info.bytes,
      mtimeMs: info.mtimeMs,
      entry: info.entry,
    };
    appsDevPaintPreviewStat("same");
    appsDevPaintUrl();
    appsDevPreviewStatMsg("");
    if (DEVD.frame && DEVD.url && DEVD.frame.getAttribute("src") !== DEVD.url)
      DEVD.frame.setAttribute("src", DEVD.url);
    appsDevRefreshHead().catch(() => {});
  }
  /* 首次进入（或换了应用）：右栏落到该应用最近一条会话；没有就是首轮态 */
  if (DEVD.draft && !DEVD.sessionId) {
    const sess =
      typeof appSessionsOf === "function" ? appSessionsOf(DEVD.appId)[0] : null;
    if (sess) {
      DEVD.draft = false;
      DEVD.sessionId = sess.id;
      DEVD.msgCount = Array.isArray(sess.messages) ? sess.messages.length : 0;
      /* 右栏要显示这条 = 由 appsDevRenderConv 的显示覆盖绑定，不动会话页的选中项 */
      try {
        await persistAgentSession();
      } catch (_) {}
    }
  }
  if (!alive()) return;
  appsDevRenderConv();
}

/* 顶部下拉换应用：整页重绘（列 / 容器全部重建，会话归属与预览跟着换） */
function appsDevSelectApp(appId) {
  DEVD.appId = String(appId || "").trim();
  DEVD.draft = true;
  DEVD.sessionId = "";
  DEVD.msgCount = 0;
  DEVD.snap = null;
  DEVD.url = "";
  DEVD.filter = "";
  DEVD.wf = null;
  DEVD.node = null;
  DEVD.nodeFor = "";
  if (typeof appsHubPaint === "function") appsHubPaint();
}

/* 入口别名（app-apps.js 的 appsPaintDevPage 按 typeof 取） */
window.appsDevSidebarHost = appsDevSidebarHost;
window.appsDevComposerSend = appsDevComposerSend;
window.appsDevPagePaint = appsDevPagePaint;
window.appsDevPageUnmount = appsDevPageUnmount;
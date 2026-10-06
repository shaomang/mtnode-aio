"use strict";
/* renderer/app-apps-dev.js — 应用中心「开发」页：三栏 + 底部输入框
 * ============================================================================
 * 一页三栏（在 #appsHub 的开发者页里渲染，见 app-apps.js 的 appsPaintDevPage）：
 *   左 = 「开发中」应用列表（每应用一行：名字 + 作者 + 会话数 + 展开箭头，它的会话折叠在下面）
 *   中 = iframe 实时预览该应用的静态页
 *   右 = 该会话正文（会话列表里的同一条会话）  下 = 输入框（同一个 composer）
 *
 * 复用既有件，不另造一份：
 *   · 左栏 = app-assist.js 的 renderAgentSessionSidebar()。本文件给它一个「宿主」
 *     （appsDevSidebarHost）：宿主在时它按宿主给的**应用分组**渲染（应用行 + 该应用里
 *     未归档的会话行；应用数据 = appsLocalList() 里 dev:true 的那些，会话 = app-app-flow.js
 *     的 appSessionsOf），写进 #appsDevSideList；宿主不在时它逐字走原来的总会话视图。
 *     点应用行 = 选中它（appsDevSelectApp：**原地换**——三栏 DOM 不重建、预览复用同一只
 *     iframe 只换 src、右栏落到该应用最近一条会话；只有「页面还没画好 / 新应用还没进名单」
 *     才退回整页绘制），点箭头 = 展开收起。
 *   · 右栏正文 + 底部输入框 = 会话视图自己的 DOM（#agentList / #agentQueue / #agentPlan /
 *     #agentTodo / #agentPaused / .agent-composer）**原样搬过来**，关页 / 重绘时按原顺序还回
 *     .agent-body。#agentList 常被 ensureHistRail() 包在 .hist-scroll-wrap 里（轮次轨的壳），
 *     搬 / 还必须连壳一起走 —— 见 appsDevMoveTarget。
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
 *   开发页开着且处于首轮态（本应用还没有开发会话，或用户点了左栏应用行右端的「＋」）时由本文件接管：
 *   解析该应用的画布与开发节点（wfOfCanvasIdForRun → appsDevNodeOfWf）→ createDevSessionForNode
 *   （devNodeContractText 任务书整份写进 sess._devContract）→ agentSessionSend("", {_devContract:true})。
 *   「先拷问需求」开关的真源是节点上的 node.devGrill（默认 true，界面切换即写回节点并落盘）。
 *
 * 预览刷新：每轮开发结束后比对应用目录的内容快照（apps:devPreview 的 files / bytes / mtimeMs），
 *   有变才重载 iframe；重载前把预览页的滚动与表单值存下来、加载后写回（协议注入的状态小助手，
 *   见主进程 apps-store.js 的 PREVIEW_AGENT），界面上的「维持状态」开关关掉就不存不写。
 *   切应用（换 iframe 上下文）那一下也在预览区中央露一行「正在加载…」，新页 load 后收起；
 *   同一个应用的日常重载不出提示（用户已经看着旧页面刷）。
 *   跨应用还多记一份状态（DEVD.stateByApp：appId → 滚动 / 表单值，**只在内存**）：
 *   切走前向旧页要一次、切回来写回，所以 A→B→A 能回到 A 上次看的位置（仍受「维持状态」开关管）。
 *
 * 依赖全部在调用期按 typeof 取（APPS_ST / appSessionsOf / createDevSessionForNode / persistWf…），
 * 加载顺序只需在 app-apps.js 之后（index.html 生态层）。
 * ============================================================================ */

/* 中栏实时刷新的防抖门槛（毫秒）：快照比对仍是 1.2s 一拍（appsDevStartTimer），
   但「变了」之后要等改动停下来这么久才真重载 —— 见 appsDevCheckPreview 的注释。 */
const LIVE_SETTLE_MS = 400;
/* 「正在加载…」的兜底时限（毫秒）：切应用时露出的那行提示，新页 load 后即时收起；
   页面卡住 / 拿不到目录时靠它收，别让这行字永远挂着（旧黑幕的兜底是 2.5s）。 */
const APPS_DEV_LOADING_FALLBACK_MS = 4000;

const DEVD = {
  appId: "", /* 当前开发的应用 id */
  listEl: null, /* 左栏应用 / 会话列表容器（renderAgentSessionSidebar 的宿主） */
  expanded: null, /* 左栏应用行的展开态（会话级记忆：{ appId: boolean }；没记过 = 当前应用展开） */
  /* 跨应用的预览状态记忆（滚动位置 + 表单值，来自预览页里的状态小助手）：
     appId → 该应用上一次离开预览时的状态。**只在内存里**（重启 MTNode 不恢复），
     且跟随「维持状态」开关 —— 关掉就不存不写（与同应用内重载那条口径一致）。 */
  stateByApp: new Map(),
  /* 当前 iframe 里装的是哪个应用的页面：切走时只在「它装的确实是要切走的那个应用」时才
     向它要状态（连着切两次 A→B→C 时，第二次切走的那一帧还是 A 的页面，不该记到 B 名下）。 */
  frameApp: "",
  loadingEl: null, /* 预览区中央的「正在加载…」（只在切应用时出现） */
  loadingTimer: 0, /* 它的超时兜底（load 事件没来也得收起） */
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
  headRaf: 0, /* 待执行的菜单条重排（ResizeObserver 回调里只登记一帧，见 appsDevStartHeadWatch） */
  turnEl: null, /* 右栏头部：当前轮次说明 */
  colsEl: null, /* 三栏容器（.apps-dev-cols）：宽度变量与把手的宿主 */
  colsRaf: 0, /* 待执行的三栏重夹（窗口 resize 只登记一帧） */
  warnEl: null, /* 顶部警告条 */
  grillEl: null, /* 「先拷问需求」复选框 */
  filter: "", /* 左栏搜索词 */
  draft: true, /* 首轮态：下一次输入 = 「开发」提交 */
  sessionId: "", /* 非首轮时：右栏展示的会话 id */
  url: "", /* 预览 url（mtnode-preview://…） */
  /* ── 中栏预览「实时看到开发过程」（本轮需求）─────────────────────────────
     开发会话**跑着的时候**也持续比对应用目录的内容快照，改了就跟手刷新 —— 用户口径是
     「应当实时在该预览窗中看到开发过程」（旧口径只在会话跑完那个边沿刷一次，
     开发过程中中栏一动不动）。防抖：改动**停下来** LIVE_SETTLE_MS 才重载，
     免得把 Agent 正写一半的页画出来、也免得你正点着的时候反复刷。
     重载前抓 / 后写滚动与表单值那套（PREVIEW_AGENT）一字不动，只在重载时机前加了门槛。 */
  LIVE_RELOAD: true,
  liveChangedAt: 0, /* 最近一次快照「变了」的时刻（0 = 这一段时间没变过） */
  checkBusy: false, /* 一次快照比对 / 重载还在飞：tick 每 1.2s 一发，别叠着来 */
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
  /* 「自定义」风格那一步（见 appsDevAskStyle）：待问的 appId 与那句可直接发送的提问。
     新建应用时用户还停在「库」页（开发页没开、输入框不在），所以先把这一问**记在这里**，
     等开发页真的画出来（appsDevRenderConv）再落到输入框上 —— 不然这一问会无声丢掉。 */
  askStyleId: "",
  askStyleText: "",
  seq: 0,
};

/* ── 小工具 ── */

function appsDevT(s) {
  return window.I18n && I18n.t ? I18n.t(s) : String(s == null ? "" : s);
}
function appsDevToast(msg, kind) {
  if (typeof toast === "function") toast(msg, kind || "ok");
}
/* 「启动」= 等同在库中运行：给当前应用开独立窗口。
   走库页同一入口 appsOpenApp（→ 主进程 apps:openWindow → BrowserWindow + preload-app.js
   跑它自己的 index.html），成功静默、失败弹同一条「打开失败：」toast。 */
function appsDevStartApp() {
  const id = String(DEVD.appId || "").trim();
  if (!id) {
    appsDevToast(appsDevT("先新建或安装一个应用，再启动"), "warn");
    return;
  }
  if (typeof appsOpenApp === "function") appsOpenApp(id);
}
/* 该应用在本机的项目文件夹（开发页一切「项目文件夹」口径的唯一取数点）：
   appsLocalList 的那条记录里的 dir（apps-store 按类型解析好的绝对路径），取不到就回空串。
   为什么不自己拼：应用可能躺在下载根或项目根（两套根，见 apps-store.js 的 kindOfManifest），
   路径真源只有主进程，渲染层不猜。 */
function appsDevProjectDir(appId) {
  const id = String(appId || DEVD.appId || "").trim();
  if (!id) return "";
  try {
    const hit =
      typeof appsLocalById === "function" ? appsLocalById(id) : null;
    return String((hit && hit.dir) || "").trim();
  } catch (_) {
    return "";
  }
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
/* 「开发中」的应用（本机列表顺序 = 安装时间新→旧，左栏照原样用；只列 dev:true 的，
   与库页相反 —— 开发中的应用不从库页进，入口就是这一列 + 顶栏那条菜单）。 */
function appsDevApps() {
  const all = typeof appsLocalList === "function" ? appsLocalList() : [];
  return all.filter((a) => a && a.dev === true);
}
/* 左栏应用行的展开态：没记过 = 当前应用默认展开，其余收起（点箭头才写这张表，会话级记忆） */
function appsDevAppExpanded(appId) {
  const id = String(appId || "");
  if (!DEVD.expanded) DEVD.expanded = {};
  if (Object.prototype.hasOwnProperty.call(DEVD.expanded, id))
    return !!DEVD.expanded[id];
  return id === String(DEVD.appId || "");
}
function appsDevAppToggle(appId) {
  const id = String(appId || "");
  if (!id) return;
  if (!DEVD.expanded) DEVD.expanded = {};
  DEVD.expanded[id] = !appsDevAppExpanded(id);
  try {
    if (typeof renderAgentSessionSidebar === "function")
      renderAgentSessionSidebar();
  } catch (_) {}
}
/* app-assist.js 的 renderAgentSessionSidebar 的宿主：开发页开着时给它**应用分组**
   （只列「开发中」的应用，每个应用带它自己未归档的会话），写进开发页左栏；
   点应用行 = appsDevSelectApp，点箭头 = appsDevAppToggle，
   点行右端的「＋」= appsDevNewSessionFor（在该应用下开一条新开发会话）。
   宿主不在 → 它走原路，总会话视图一字不动。首轮态没有活跃会话行（active = ""）。 */
function appsDevSidebarHost() {
  if (!appsDevPageOpen()) return null;
  const cur = String(DEVD.appId || "");
  const apps = appsDevApps().map((a) => {
    const id = String(a.id || "");
    const sessions =
      typeof appSessionsOf === "function"
        ? appSessionsOf(id).filter((s) => s && !s.archived)
        : [];
    const author =
      typeof appsAuthorOf === "function"
        ? String(appsAuthorOf(a) || "").trim()
        : "";
    return {
      id: id,
      name: String(a.name || id || ""),
      author: author,
      sessions: sessions,
      count: sessions.length,
      current: id === cur,
      expanded: appsDevAppExpanded(id),
    };
  });
  return {
    listEl: DEVD.listEl,
    apps: apps,
    filter: DEVD.filter,
    active: DEVD.draft ? "" : String(DEVD.sessionId || ""),
    onAppSelect: (id) => appsDevSelectApp(id),
    onAppToggle: (id) => appsDevAppToggle(id),
    onAppNew: (id) => appsDevNewSessionFor(id),
  };
}

/* ── 会话正文 / 输入框：搬运（不复制） ── */

const DEVD_MOVE_IDS = [
  "agentRound",
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
/* 要搬的节点：正常就是 id 那个节点本身；但 #agentList 会被会话视图的 ensureHistRail()
   （app-assist.js：轮次轨的滚动壳）包进一只 .hist-scroll-wrap —— **那只壳才是 .agent-body
   的直接子节点**，#agentList 已经不是了。
   为什么必须上溯一层（用户报障「应用开发页右栏只有一份清单，没有会话内容」）：
   appsDevMount 的搬运循环只遍历「搬运前 .agent-body 的直接子节点」（saved，归还顺序也靠它），
   于是身在壳里的 #agentList 一个都没被搬进开发页右栏 —— 右栏只剩 #agentPlan / #agentTodo
   这几块清单面板（它们是直接子节点，正常搬走）；而只搬 #agentList、把空壳留在 .agent-body
   也不行：归还时按 saved 放回的是那只**空壳**，消息区就永远回不到会话视图（应用中心浮层只是
   hidden，那个节点从此谁也够不着，见 app-apps.js 的 appsHubClose）。
   搬壳 = 壳连同里面的 #agentList 与 .hist-rail 一起走，它天然在 saved 里，归还路径与其它
   节点一字不差（对象、事件监听、脚本加载顺序都不变）。 */
function appsDevMoveTarget(id, body) {
  const el = document.getElementById(id);
  if (!el) return null;
  const p = el.parentNode;
  if (
    p &&
    p !== body &&
    p.classList &&
    p.classList.contains("hist-scroll-wrap") &&
    p.parentNode === body
  )
    return p;
  return el;
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
    const el = appsDevMoveTarget(id, body);
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
  /* 兜底：消息区（#agentList）无论如何都要回到会话视图。它若因为「壳没在 saved 里」
     （页外被包 / 记档早于包装 / 别处搬动过它）没随上面那轮 appendChild 回来，就点名把它
     接回 .agent-body 里的那只壳（没有壳就直接接回 body）—— 消息区回不来就是「右侧框
     没有完整会话内容」，比顺序略有出入严重得多。 */
  try {
    const list = document.getElementById("agentList");
    if (list && !m.body.contains(list)) {
      const wrap = m.body.querySelector(".hist-scroll-wrap");
      (wrap || m.body).appendChild(list);
    }
  } catch (_) {}
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
/* 兜底：本页没有在显示的会话（首轮态 / 那条会话已被删或被截断 / 会话表重排）时，
   只要这个应用名下**还有会话**，就自动把右栏落到最新那条上 —— 开发页绝不停在「左右两栏
   都空着」的中间态。
   为什么必须有这一步：appsDevViewBind() 在「本页这条会话已不在」时会主动把本页清回首轮态
   （防右栏留下别条会话的计划 / 清单），而**只有 appsDevSyncAfterPaint（首次绘制那一次）**
   会再选一条回来。页面已经画好之后才发生的丢失（用户在会话页删掉这条 / 会话表被截断 /
   在别处把最近一条挪走）就没有第二次自动选中：左栏变「暂无会话」、右栏 `is-draft` 把正文
   藏起来只剩一句引导，看起来就是「右侧什么都不显示」。
   本函数把「还有会话就必须显示一条」这条不变式补上：只在「当前没有会话」这一个条件下动作，
   选中后自己重绘一次右栏（含标题条），不动会话页的选中项（仍走显示覆盖）。
   返回 true = 这次补上了一条。 */
function appsDevEnsureCurrentSession() {
  if (!appsDevPageOpen()) return false;
  /* 首轮态 + 框里还有没发出去的字 = 用户正在写本次开发需求：绝不把右栏换成别的会话。
     那一下会按新会话的草稿重写输入框（renderAgentSession 的草稿回填），用户写了一半的
     首轮需求当场从眼前消失 —— 本轮需求：未输入完毕发送的内容必须留住。
     这一条同时挡住那只 1.2s 的轮询（appsDevTick 每次都先调本函数）：点「＋」开始写第一轮
     时，应用下已有会话也不会被自动选走。框清空 / 发出去之后这条闸自动放开。 */
  if (DEVD.draft && appsDevDraftPending()) return false;
  if (!DEVD.draft && DEVD.sessionId) {
    /* 已经指着一条会话：它还在（agentSessionById）就什么都不做；已不在才往下补 */
    try {
      if (typeof agentSessionById === "function" && agentSessionById(DEVD.sessionId))
        return false;
    } catch (_) {
      return false;
    }
  }
  const list =
    typeof appSessionsOf === "function" ? appSessionsOf(DEVD.appId) : [];
  if (!list.length) return false; /* 这个应用真没有会话：保持首轮态（引导 + 空正文） */
  const sess = list[0];
  DEVD.draft = false;
  DEVD.sessionId = sess.id;
  DEVD.msgCount = Array.isArray(sess.messages) ? sess.messages.length : 0;
  try {
    if (typeof persistAgentSession === "function") persistAgentSession();
  } catch (_) {}
  appsDevRenderConv();
  return true;
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
  if (DEVD.colsRaf) {
    try {
      cancelAnimationFrame(DEVD.colsRaf);
    } catch (_) {}
  }
  DEVD.colsRaf = 0;
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
  DEVD.colsEl = null;
  DEVD.warnEl = null;
  DEVD.grillEl = null;
  DEVD.pendingState = null;
  /* 加载提示随容器一起被丢弃，引用必须清干净（否则下一次切应用会去操作一个已摘掉的节点） */
  if (DEVD.loadingTimer) {
    try {
      clearTimeout(DEVD.loadingTimer);
    } catch (_) {}
  }
  DEVD.loadingTimer = 0;
  DEVD.loadingEl = null;
  DEVD.frameApp = "";
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

/* ── 上次打开的应用（config.appsDevLastApp：回开发页时自动选它） ── */

/* 落盘口径与三栏宽度同源（app-apps.js 的 appsColsSave → window.api.configSave(S.config)）：
   只存一个应用 id，不新增文件、不写画布。 */
function appsDevLastAppSave(appId) {
  const id = String(appId || "").trim();
  if (!id) return;
  try {
    if (typeof S !== "object" || !S) return;
    if (!S.config) S.config = {};
    if (String(S.config.appsDevLastApp || "") === id) return;
    S.config.appsDevLastApp = id;
    window.api.configSave(S.config).catch(() => {});
  } catch (_) {}
}
/* 上次打开过、且**现在仍在本机开发中名单里**的那个应用；没有就空（调用方再退到第一个）。 */
function appsDevLastAppId() {
  try {
    const id = String((S.config && S.config.appsDevLastApp) || "").trim();
    if (!id) return "";
    return appsDevApps().some((a) => String(a.id || "") === id) ? id : "";
  } catch (_) {
    return "";
  }
}
/* 进开发页时选哪个应用（appsDevPagePaint 只调这一处）：
   本页当前选中的 > 上次打开过的（仍在本机开发中名单里才算）> 名单第一个。
   都不给 = 本机没有「开发中」的应用（页面走空态提示），**不会**出现「没选中应用」的空页。 */
function appsDevPickApp(apps) {
  const ids = (Array.isArray(apps) ? apps : []).map((a) => String((a && a.id) || ""));
  let cur = String(DEVD.appId || "");
  if (!ids.includes(cur)) cur = appsDevLastAppId();
  if (!ids.includes(cur)) cur = ids.length ? ids[0] : "";
  return cur;
}

/* ── 首轮态输入框的草稿（config.appsDevDrafts[appId]） ─────────────────────
   首轮态那只输入框装的是「下一次开发需求」，而它显示的占位空会话（app-assist.js 的
   agentViewBlankSt）不在会话表里、每次整页重绘都被换掉 —— 草稿挂不到任何会话对象上。
   本轮需求：未输入完毕发送的消息框内容必须留住，切窗口 / 切页 / 自动选会话都不许丢。
   所以按应用单独存一份（app-assist.js 的 agentDraftKeyNow 用 "\u0000dev-first:<appId>"
   当视图键，存 / 取都落到这里），落盘口径与 appsDevLastAppSave 同源
   （S.config + window.api.configSave：不新增文件、不写画布）。
   按应用存而不是一只共用的槽：切应用时框里的字要先退回**上一个**应用，回来还在。 */
/* 落盘防抖：输入即记每敲一键来一次，但整份 config 的写盘不便宜（历史包袱见 main.js 的
   config 缓存段），所以攒到停手 1.5s 再落一次 —— 内存里那一刻就已经是最新，重绘 /
   切窗口 / 切页读的都是内存那份，落盘只为「重启还在」。 */
const DEVD_DRAFT_SAVE_MS = 1500;
let devdDraftTimer = 0; /* 防抖：输入即记会每敲一键来一次，落盘攒到停顿后再做 */
function appsDevDraftAppId() {
  return String(DEVD.appId || "");
}
function appsDevDraftAll(create) {
  try {
    if (typeof S !== "object" || !S) return null;
    if (!S.config) {
      if (!create) return null;
      S.config = {};
    }
    const cur = S.config.appsDevDrafts;
    if (cur && typeof cur === "object") return cur;
    if (!create) return null;
    S.config.appsDevDrafts = {};
    return S.config.appsDevDrafts;
  } catch (_) {
    return null;
  }
}
function appsDevDraftLoad(appId) {
  const id = String(appId || "");
  if (!id) return "";
  const all = appsDevDraftAll(false);
  return all && typeof all[id] === "string" ? all[id] : "";
}
/* 存：内存里立刻改（重绘 / 切窗口那一下马上读得到），落盘防抖（敲键不写盘） */
function appsDevDraftSave(appId, text) {
  const id = String(appId || "");
  if (!id) return;
  const t = String(text == null ? "" : text);
  const all = appsDevDraftAll(false);
  const cur = all && typeof all[id] === "string" ? all[id] : "";
  if (cur === t) return; /* 没变（含「本来就没有 + 存空」）→ 不建表、不落盘 */
  const box = all || appsDevDraftAll(true);
  if (!box) return;
  if (t) box[id] = t;
  else delete box[id]; /* 发出去 / 用户自己清空 = 不留痕（下次点「＋」不该冒出旧字） */
  if (devdDraftTimer) return;
  devdDraftTimer = setTimeout(() => {
    devdDraftTimer = 0;
    try {
      if (window.api && typeof window.api.configSave === "function")
        window.api.configSave(S.config).catch(() => {});
    } catch (_) {}
  }, DEVD_DRAFT_SAVE_MS);
}
/* 清（立刻落盘）：首轮需求已经交出去，这条草稿就没有存在的理由了 */
function appsDevDraftClear(appId) {
  const id = String(appId || "");
  if (!id) return;
  const all = appsDevDraftAll(false);
  if (!all || typeof all[id] !== "string") return;
  delete all[id];
  if (devdDraftTimer) {
    try {
      clearTimeout(devdDraftTimer);
    } catch (_) {}
    devdDraftTimer = 0;
  }
  try {
    if (window.api && typeof window.api.configSave === "function")
      window.api.configSave(S.config).catch(() => {});
  } catch (_) {}
}
/* 首轮态此刻有没有「还没发出去的字」：输入框里的现值优先，其次看已存的草稿
   （页面刚画出来、输入框还没回填时的那一瞬也算有）。 */
function appsDevDraftPending() {
  try {
    const inp = document.getElementById("agentInput");
    if (inp && String(inp.value || "").trim()) return true;
  } catch (_) {}
  return !!String(appsDevDraftLoad(DEVD.appId) || "").trim();
}

/* ── 预览加载提示：只在「切应用」时出现 ──

   旧实现是整块黑幕（.apps-dev-curtain）：切应用时把中栏整块盖黑，新页 load 后淡出。
   用户口径（本轮）：不要那块黑 —— 换成预览区中央一行小字「正在加载…」，只在
   换应用（= 换 iframe 上下文）那一下露出，新页加载完就收起，另有超时兜底。
   同应用内的重载（开发改动跟手刷新 / 「刷新预览」）不出提示：那里用户已经看着旧页面刷。 */
function appsDevLoadingShow() {
  const wrap = DEVD.frameWrap;
  if (!wrap) return;
  appsDevLoadingHide();
  const el = document.createElement("div");
  el.className = "apps-dev-loading";
  el.textContent = appsDevT("正在加载…");
  el.setAttribute("aria-hidden", "true");
  wrap.appendChild(el);
  DEVD.loadingEl = el;
  /* 兜底：load 事件没来（拿不到目录 / 页面卡住）也得收起，否则这行字永远挂着 */
  DEVD.loadingTimer = setTimeout(() => appsDevLoadingHide(), APPS_DEV_LOADING_FALLBACK_MS);
}
/* 收起（幂等：没露着时什么都不做） */
function appsDevLoadingHide() {
  if (DEVD.loadingTimer) {
    try {
      clearTimeout(DEVD.loadingTimer);
    } catch (_) {}
    DEVD.loadingTimer = 0;
  }
  const el = DEVD.loadingEl;
  DEVD.loadingEl = null;
  if (!el) return;
  try {
    el.remove();
  } catch (_) {}
}

/* ── 跨应用的预览状态（滚动位置 + 表单值） ──

   切到 B 再切回 A 时，A 的预览页回到上次离开时的位置。存的是状态小助手
   （主进程 apps-store.js 的 PREVIEW_AGENT）给的那份：滚动位置 + 表单值。
   跟随「维持状态」开关：关掉就不存不写（与同应用内重载同一口径）。 */
function appsDevStateOf(appId) {
  const id = String(appId || "");
  return id && DEVD.keepState ? DEVD.stateByApp.get(id) || null : null;
}
function appsDevStateSave(appId, state) {
  const id = String(appId || "");
  if (!id || !DEVD.keepState || !state) return;
  DEVD.stateByApp.set(id, state);
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
  /* 缓存戳 = 时间 + 单调序号：同一毫秒里连刷两次（实时刷新 + 用户点「刷新预览」）
     也要能各刷一版 —— 只发同一个 url 的话浏览器把「src 没变」当无事发生，
     点了没反应（真机上是「刷新预览」这种密度才会碰到，但一样得挡住）。 */
  DEVD.reloadSeq = (Number(DEVD.reloadSeq) || 0) + 1;
  frame.setAttribute("src", DEVD.url + sep + "_r=" + Date.now() + "-" + DEVD.reloadSeq);
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
/* 内容快照比对：有变（或 force）才重载预览。
   force 有两条来路，语义不同（都是显式动作，不受防抖门槛限制）：
     · true  = 会话跑完那个边沿 / 工具栏「刷新预览」：**无条件**刷一次；
     · false = 开发会话跑着的时候的实时轮询（本轮需求）+ 收尾那一路。 */
async function appsDevCheckPreview(force) {
  if (!appsDevPageOpen()) return;
  /* 本页一个应用都没有（「＋新建应用」还没点 / 开发中的应用被全卸载了）：中栏那句提示由
     绘制阶段给出，这里不要再去问预览 —— 否则会把「读不到该应用目录」这种误导话盖上去。 */
  if (!String(DEVD.appId || "").trim()) return;
  /* 单飞：tick 每 1.2s 一发，而一次重载要等页面状态回信（最多 700ms）——
     不挡的话会叠成两次 setAttribute("src")，白白多刷一版。 */
  if (DEVD.checkBusy) return;
  DEVD.checkBusy = true;
  try {
    await appsDevCheckPreviewInner(force);
  } finally {
    DEVD.checkBusy = false;
  }
}
async function appsDevCheckPreviewInner(force) {
  const r = await appsDevPreviewInfo();
  if (!appsDevPageOpen() || !r) return;
  if (r.ok === false) {
    DEVD.snap = null;
    DEVD.liveChangedAt = 0;
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
  /* 没有基线（还没有 snap：刚进开发页 / 刚切过应用）不算「有改动」—— 这一拍只把快照收下，
     绝不因此触发一次重载。旧写法把「没基线」当 changed，于是进页面 / 切应用之后
     1.2s 那一拍会白白多刷一版预览（用户看到的就是切应用时多闪一下）。 */
  const changed =
    !!prev &&
    (prev.files !== r.files ||
      prev.bytes !== r.bytes ||
      prev.mtimeMs !== r.mtimeMs);
  DEVD.snap = {
    files: r.files,
    bytes: r.bytes,
    mtimeMs: r.mtimeMs,
    entry: r.entry,
  };
  appsDevPaintPreviewStat(changed || force ? "changed" : "same");
  /* force 是显式动作（跑完的边沿 / 工具栏「刷新预览」）：无条件刷，也不看防抖门槛。
     注意它必须排在 changed 判断**之前** —— 显式刷新时内容往往已经跟上一版一样了。 */
  if (force) {
    DEVD.liveChangedAt = 0;
    await appsDevReloadPreview();
    return;
  }
  if (!DEVD.LIVE_RELOAD) return;
  /* 防抖（本轮需求）：**从第一次看到改动那一刻起算** liveChangedAt，等这一版改动停下来
     （LIVE_SETTLE_MS 内再没有新改动）才重载。所以在写的一版会不断把计时推后，
     写完后的下一拍（没变 + 计时已过）才真刷 —— 既不会把写一半的页画出来，
     也不会在用户正点着的时候反复刷。比对仍是 1.2s 一拍（appsDevStartTimer）。 */
  if (changed) {
    if (!DEVD.liveChangedAt) DEVD.liveChangedAt = Date.now();
    return;
  }
  if (DEVD.liveChangedAt && Date.now() - DEVD.liveChangedAt >= LIVE_SETTLE_MS) {
    DEVD.liveChangedAt = 0;
    await appsDevReloadPreview();
    return;
  }
  DEVD.liveChangedAt = 0; /* 这一版没再动过（或计时还没到）：清掉计时等下一次改动 */
}

/* 窗口 resize 监听只绑一次（跨重绘 / 跨开关页都只一份）：回调里先判本页是否开着 */
let appsDevColsWinBound = false;

/* ── 三栏宽度：可拖拽（左会话栏 | 中预览 | 右正文），默认 = 左 240px + 中/右各半 ──
   需求：开发界面里会话的左 / 中 / 右三栏允许互相调整宽度，并设合理的最小 / 最大值。
   实现：把手绝对定位在栏边缘（左会话栏右缘一条、右正文栏左缘一条），
   与 #agentSideResize / #assistResize 同款 pointer 口径；拖动只改 CSS 变量不落盘，
   松手写回配置（S.config.appsDevSideW / appsDevConvW），双击把手复位默认。
   夹取口径不在本文件：每栏最小 240px、最大半屏、总宽不溢出 —— 见 app-apps.js 的
   clampAppsColsW（一处写死，只服务这三栏；整页左导航固定 176px、不可拖）。
   默认的「中 / 右各占一半」是**算出来的**：左栏按夹取后的值，中栏先按等分推算。 */

/* 按当前容器实测三栏宽度：{ side, view, conv }（view 只在拖拽里当基准，不落盘）
   总宽不溢出：side + view + conv + 2*gap <= cols.clientWidth。
   中栏（预览）先保 MIN，右栏吃剩下的；连 MIN 都不够时右栏归零，退化成「左 | 中」。 */
function appsDevColsW() {
  const cols = DEVD.colsEl;
  const total = Math.max(0, cols ? cols.clientWidth : 0);
  const GAP = 8; /* .apps-dev-cols 的 gap */
  const MIN = 240; /* 每栏最小宽（与 app-apps.js 的 APPS_DEV_COL_W_MIN 同一口径） */
  const side = Math.max(MIN, Number(S.appsDevSideW) > 0 ? S.appsDevSideW : MIN);
  const avail = total - side - GAP * 2;
  let conv = Number(S.appsDevConvW) > 0 ? S.appsDevConvW : 0;
  if (conv <= 0) conv = avail > 0 ? Math.floor(avail / 2) : MIN;
  /* 中栏先保 MIN，右栏吃剩下的；连 MIN 都不够时右栏归零（退化成「左 | 中」） */
  if (avail - conv < MIN) conv = avail - MIN;
  if (conv < 0) conv = 0;
  if (conv > avail) conv = Math.max(0, avail);
  const view = Math.max(0, avail - conv);
  return { side: side, view: view, conv: Math.max(0, conv) };
}
/* 容器窄到三栏排不下时按比例收（先削右栏、再削左栏，各留 0 下限）：
   只把这个结果写进 CSS 变量，不改 S.appsDevXxxW，所以窗口变宽后原值自动回来，
   也不会把「被挤过的窄值」落盘。 */
function appsDevClampPair(sideW, convW) {
  const cols = DEVD.colsEl;
  const total = Math.max(0, cols ? cols.clientWidth : 0);
  const GAP = 8;
  const MIN = 240;
  let side = Math.max(MIN, Number(sideW) > 0 ? Number(sideW) : MIN);
  let conv = Math.max(0, Number(convW) > 0 ? Number(convW) : 0);
  let over = side + MIN + conv + GAP * 2 - total;
  if (over > 0) {
    const cutConv = Math.min(over, conv);
    conv -= cutConv;
    over -= cutConv;
    if (over > 0) side = Math.max(0, side - over);
  }
  return { side: side, conv: conv };
}
/* 容器实测值 → 真正写进 CSS 变量的一对宽（side 先按半屏夹、再按总宽收一次） */
function appsDevSyncCols() {
  const w = appsDevColsW();
  const side = typeof clampAppsColsW === "function" ? clampAppsColsW("side", w.side) : w.side;
  const conv = typeof clampAppsColsW === "function" ? clampAppsColsW("conv", w.conv) : w.conv;
  return appsDevClampPair(side, conv);
}
/* 三栏宽度应用：本函数只负责「按容器等分推算出期望的一对宽」（0 = 还没定 → 中/右等分），
   真正的收尾（每栏 240 … 半容器、三栏都在容器内，写进 CSS 变量的也是那一对贴合值）
   在 app-apps.js 的 applyAppsDevCols → appsDevFitCols，一处写死两份 UI 共用 ——
   右栏正文被挤出容器就是这么修的，别再往 CSS 变量里写这里的中间值。 */
function appsDevApplyCols(persist) {
  /* 容器还没量到宽（首帧还没布局 / 页已隐藏）：什么都不写，留给布局定下来的那次 */
  if (!DEVD.colsEl || !DEVD.colsEl.clientWidth) return;
  const w = appsDevSyncCols();
  if (typeof applyAppsDevCols !== "function") return;
  applyAppsDevCols(w.side, w.conv, persist);
}

/* 一条竖分界线的 pointer 绑定（首次绑定落 _bound，重绘后把手是新节点、但同一 id 只绑一次）
   拖动语义：
   · 左分界线（kind = "side"，贴左会话栏右缘）：向右拖 = 左栏变宽（中栏吃剩下的）
   · 右分界线（kind = "conv"，贴右正文栏左缘）：向左拖 = 右栏变宽（中栏吃剩下的）
   · 中栏（预览）不落盘、宽度 = 容器宽 − 左右两栏 − gap，所以「拖两边 = 调中间」；
     每栏最小 240px、最大半屏、总宽不溢出，都在 app-apps.js 的 clampAppsColsW /
     appsDevColsW 里夹，本函数只管把指针增量换算成「想拖到多少」。
   · 起始值与增量分开记（startW + dx），拖动中夹取后仍能原路拖回，不会因为
     被夹到边界就把后续增量吃掉（「拖不动了」）。
   · 分界线整条可拖：命中区由 css/apps.css 的 .apps-dev-resize 铺满栏高（top/bottom 0），
     不再是中间那一小段加宽把手。 */
function appsDevBindColResize(handle, kind) {
  if (!handle || handle._bound) return;
  handle._bound = true;
  handle.title = appsDevT("拖拽调整栏宽（双击复位这一栏）");
  handle.setAttribute("data-i18n-title", "拖拽调整栏宽（双击复位这一栏）");
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  let dragging = false;
  let startX = 0;
  let startW = 0;
  let pid = null;
  const startOf = () => (kind === "side" ? S.appsDevSideW : S.appsDevConvW);
  const onMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    const dx = (Number(ev.clientX) || 0) - startX;
    /* 左分界线贴在左栏右缘 = 向右拖变宽；右分界线贴在右栏左缘 = 向左拖变宽 */
    const w = kind === "side" ? startW + dx : startW - dx;
    if (kind === "side") applyAppsDevCols(w, null, false);
    else applyAppsDevCols(null, w, false);
    handle.classList.add("dragging");
  };
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    try {
      if (pid != null && handle.hasPointerCapture && handle.hasPointerCapture(pid))
        handle.releasePointerCapture(pid);
    } catch (_) {}
    pid = null;
    /* 松手才写一次配置（拖动中只改 CSS 变量，不落盘） */
    applyAppsDevCols(S.appsDevSideW, S.appsDevConvW, true);
  };
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    startX = Number(ev.clientX) || 0;
    /* 拖之前先按下限起步：右栏「还没定过」（0 = 中/右等分）时首次拖动从 240px 起算 */
    startW = Math.max(240, Number(startOf()) > 0 ? Number(startOf()) : 240);
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    try {
      pid = ev.pointerId;
      handle.setPointerCapture(pid);
    } catch (_) {}
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
  /* 双击把手 = 回到默认（左 240px + 中 / 右各半） */
  handle.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (kind === "side") applyAppsDevCols(240, S.appsDevConvW, true);
    else applyAppsDevCols(S.appsDevSideW, 0, true);
  });
}
/* 窗口变窄 / 变宽：按新容器宽重夹一次（拖动中的值也收回界内），不落盘。
   重夹推到下一帧且一帧只做一次：resize 事件一串一串地来，同步重夹等于一边改布局
   一边量布局（也会喂出 ResizeObserver 的未派发通知）。 */
function appsDevBindColsWindow() {
  if (appsDevColsWinBound) return;
  appsDevColsWinBound = true;
  window.addEventListener("resize", () => {
    if (!appsDevPageOpen()) return;
    if (DEVD.colsRaf) return;
    DEVD.colsRaf = requestAnimationFrame(() => {
      DEVD.colsRaf = 0;
      if (!appsDevPageOpen()) return;
      appsDevApplyCols(false);
    });
  });
}
/* 绑定（幂等：每次整页重绘后都调一次，把手不在就就地补建） */
function appsDevBindCols() {
  if (!appsDevPageOpen()) return;
  const cols = document.querySelector(".apps-dev-cols");
  DEVD.colsEl = cols;
  if (!cols) return;
  appsDevBindColsWindow();
  const side = cols.querySelector(".apps-dev-side");
  const conv = cols.querySelector(".apps-dev-conv");
  if (side && !side.querySelector(".apps-dev-resize-side")) {
    const h = document.createElement("div");
    h.className = "apps-dev-resize apps-dev-resize-side";
    side.appendChild(h);
  }
  if (conv && !conv.querySelector(".apps-dev-resize-conv")) {
    const h = document.createElement("div");
    h.className = "apps-dev-resize apps-dev-resize-conv";
    conv.appendChild(h);
  }
  if (side) appsDevBindColResize(side.querySelector(".apps-dev-resize-side"), "side");
  if (conv) appsDevBindColResize(conv.querySelector(".apps-dev-resize-conv"), "conv");
  appsDevApplyCols(false);
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
  /* 先补一次「本页没有在显示的会话」：本页这条会话在页面活着的时候被删 / 被截断时，
     appsDevViewBind 会把本页清回首轮态，而首次绘制那次自动选中不会再重跑 —— 补上它，
     右栏才不会停在「仅有引导、正文全空」的状态（见 appsDevEnsureCurrentSession）。 */
  appsDevEnsureCurrentSession();
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
    /* 会话跑着的时候也**继续看预览**（本轮需求）：开发过程中改一版就该在中栏看到一版 ——
       旧口径在这里直接 return，所以「跑完才刷一次」，开发过程里中栏一动不动。
       真重载由 appsDevCheckPreview 的防抖门槛把关（改动停下来才刷）。 */
    if (DEVD.LIVE_RELOAD) appsDevCheckPreview(false).catch(() => {});
    return;
  }
  if (DEVD.busy || grew) {
    DEVD.busy = false;
    appsDevCheckPreview(true).catch(() => {});
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
  /* 正文 / 输入框刚画好：把排队中的「自定义风格」提问落下去（见 appsDevFlushStyleAsk）。
     不在这个文件里另开一处渲染路径，就挂在「每次画完正文」这一处 —— 新建应用时用户还停在
     库页（此刻输入框不在 DOM 里），等他走进开发页这一问自然落到输入框上。 */
  try {
    appsDevFlushStyleAsk();
  } catch (_) {}
}
/* 清掉会话视图搬进右栏的底栏件（首轮态 / 换应用 / 还没有本应用会话时调）：
   只隐藏并清空显示，不落盘、不动会话数据 —— 回看别的会话时它们照常按自己的数据重绘。
   #agentRound（轮次标签）同样按「只显示右栏这条会话的」处理：首轮态还没有本应用的会话，
   露一行「第 N 轮」就与「只留一句引导」相冲。 */
function appsDevClearConvPanels() {
  for (const id of [
    "agentRound",
    "agentPlan",
    "agentTodo",
    "agentQueue",
    "agentPaused",
  ]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = true;
    el.innerHTML = "";
  }
}

/* ── 首轮：等同在开发节点上点「开发」并提交 ── */

/* app-boot.js 的 doSend 在「空闲 + 有文本」时问一次：返回 true = 这一发由开发页接管。
   只在首轮态（还没有本应用的开发会话 / 用户点了左栏应用行右端的「＋」）接管。 */
function appsDevComposerSend(raw) {
  if (!appsDevPageOpen() || !DEVD.draft) return false;
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return false;
  appsDevStartDevSession(text).catch(() => {});
  return true;
}
/* ── 「自定义」风格：这一轮的开发需求里附一段风格约束 ──
 *
 * 只在**这个应用的风格还记着「自定义」**时生效（app.json 的 style，见 apps-store.js）：
 * 说明它还没有预设长相、这一轮必须先问清用户要什么风格再动代码，并把落点指清楚
 * （入口页 + 需要时沿用同一份模板的视觉变量），也允许 Agent 按应用用途先提几套方案
 * 让用户挑（题面进 ask_user_question 的 options，理由写 description）。
 *
 * 形态：**加进会话契约**（createDevSessionForNode 的第 4 个参数，随系统提示注入），
 * 不塞进用户消息 —— 会话里显示的仍旧只是用户自己写的那句话（与首轮口径一致）。
 * 不是自定义风格就回空串，调用方原样不追加（非自定义应用零变化）。 */
function devStyleAskContract(appId) {
  const id = String(appId || "").trim();
  const app =
    id && typeof appsLocalById === "function" ? appsLocalById(id) : null;
  const style = String((app && app.style) || "")
    .trim()
    .toLowerCase();
  if (style !== "custom") return "";
  return appsDevT(
    "【自定义风格 · 本轮先问清风格再动代码】这个应用的风格记着「自定义」：它还没有预设长相，所以这一轮**先把风格问清楚**——要么请用户直接说他的风格要求（气质 / 配色 / 字体 / 参考），要么你按这个应用的用途先提出 2–3 套**彼此明显不同**的具体方案让他挑（每套给一个名字 + 一句它长什么样 + 适合什么感觉）；用 ask_user_question 把方案放进 options（推荐项放第一位并在 label 末尾标「（推荐）」），不要只把方案列在正文里。用户选定或给出要求之前，不得改任何代码、也不得开始做页面；风格定下来后再按它改写应用目录里的入口页（index.html），页面结构沿用同一份模板，风格只动视觉。",
  );
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
  /* 工作区**强制指到这个应用的项目文件夹**（本次需求 · bug：应用下列没有会话时新会话落到默认目录）：
     createDevSessionForNode 取的是 node.devPath（没有就一路退到画布项目根 / 默认目录），
     开发页这条路的真源是「该应用在本机的那份目录」—— 所以显式把它当节点工作目录传下去
     （dshWorkspaceOf 的 manual 分支优先）。
     取不到应用目录（清单读不出来 / 目录被删）时**不静默降级**：说清楚并停手，
     绝不把会话的工作区悄悄落到默认目录里去。 */
  const appDir = appsDevProjectDir();
  if (!appDir) {
    appsDevToast(
      appsDevT("找不到这个应用的项目文件夹：先把它装回来（或修好 app.json），再发本轮需求"),
      "err",
    );
    appsDevPaintWarn(
      appsDevT("这个应用在本机的目录不见了：会话工作区无法确定，本轮不新建会话（避免文件落到默认目录）"),
    );
    return true;
  }
  const nodeForSession = Object.assign({}, node, { agentWorkspace: appDir });
  const sess = createDevSessionForNode(nodeForSession, "dev", reqText, devStyleAskContract(DEVD.appId));
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
  /* 这条首轮需求已经交出（写进会话并开跑）→ 草稿槽立刻清掉：留着它下次点「＋」
     会把上一轮的需求又摆回输入框（那是重复提交，不是保留草稿）。 */
  appsDevDraftClear(DEVD.appId);
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
/* 「新开发会话」：回到首轮态 —— 下一次输入就在本应用下新建一条绑定会话。
   两个入口都走这一处：左栏应用行右端的「＋」（本轮需求，每行一个）与工具栏那颗「＋」。
   给了 appId 且不是当前应用 → 先按正常的换应用路径切过去（原地换：预览与右栏一起换），
   否则会出现「左栏指着 A、右栏却在 A 下建会话」的分家状态。 */
function appsDevNewRound(appId) {
  const id = String(appId || "").trim();
  if (id && id !== String(DEVD.appId || "") && typeof appsDevSelectApp === "function") {
    appsDevSelectApp(id); /* 换应用：draft=true / 清 sessionId，随后原地切换（预览与右栏） */
    return;
  }
  DEVD.draft = true;
  DEVD.sessionId = "";
  DEVD.msgCount = 0;
  appsDevRenderConv();
  const inp = document.getElementById("agentInput");
  if (inp) inp.focus();
}
/* 左栏应用行右端「＋」的动作（宿主 appsDevSidebarHost 把它交给 app-assist.js 的行渲染）。
   与上面同一处实现，不写第二份分支。 */
function appsDevNewSessionFor(appId) {
  appsDevNewRound(appId);
}

/* ── 「自定义」风格那一步：把提问落到开发页的输入框上 ──
 *
 * 触发点有两处（见 app-app-flow.js 的 startCustomStyleAsk）：
 *   ① 新建应用时选了「自定义」→ 建完停在开发页，直接问风格；
 *   ② 开发页 ⋯「换风格…」选了「自定义」→ 记下选择后同样回到这里。
 * 这里只做「把问题摆到用户面前」：填一句可直接发送的提问 + 一条提示，**不自动发送**。
 * 用户点发送 = 正常走首轮开发会话（appsDevStartDevSession 会给它加上「先问清风格」的约束）。
 * 输入框里已有用户自己写的字时不覆盖，只给提示（那是他的草稿，不能被我们冲掉）。
 *
 * 时序：新建应用时用户多半还停在「库」页（开发页的输入框根本不在 DOM 里），所以这一问
 * 先记进 DEVD.askStyleId / askStyleText（排队），等本页画到输入框时由 appsDevRenderConv
 * 落下去（appsDevFlushStyleAsk）—— 不然这一问会无声丢掉。
 * 返回 true = 此刻已经落到输入框上；false = 排着队（开发页画出来时再落）。 */
function appsDevAskStyle(appId, promptText) {
  const want = String(appId || "").trim();
  const text = String(promptText || "").trim();
  if (!want || !text) return false;
  DEVD.askStyleId = want;
  DEVD.askStyleText = text;
  return appsDevFlushStyleAsk();
}
/* 把排队中的「自定义风格」提问落到输入框上（开发页每次画完正文时调一次）。
   已落过就把队清掉；用户已在写别的字时不覆盖，但同样清队 —— 别在他打字时反复弹提示。 */
function appsDevFlushStyleAsk() {
  const want = String(DEVD.askStyleId || "");
  if (!want) return false;
  if (!appsDevPageOpen() || String(DEVD.appId || "") !== want) return false;
  const inp = document.getElementById("agentInput");
  if (!inp) return false;
  const text = String(DEVD.askStyleText || "").trim();
  DEVD.askStyleId = "";
  DEVD.askStyleText = "";
  if (!text) return false;
  if (String(inp.value || "").trim()) {
    appsDevToast(appsDevT("选的是「自定义」风格：在下面说一句要什么风格（你已有的输入没被改动）"));
    return false;
  }
  inp.value = text;
  appsDevToast(
    appsDevT("选的是「自定义」风格：下面那句话可以直接发送，也可以改成你自己的风格要求"),
  );
  try {
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  } catch (_) {}
  return true;
}
window.appsDevAskStyle = appsDevAskStyle;
window.appsDevFlushStyleAsk = appsDevFlushStyleAsk;

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
  const appDir = appsDevProjectDir();
  appsDevPaintWarn(
    !appDir
      ? appsDevT("找不到这个应用在本机的项目文件夹：会话无法确定工作区（先把它装回来或修好 app.json）")
      : String(node.devPath || "").trim() && String(node.devPath).trim() !== appDir
        ? appsDevT("开发节点的「项目文件夹」与该应用当前目录不一致：新建会话一律以应用目录为准")
        : "",
  );
}

/* ── 顶部菜单条：一行 + 按宽度搬运进「更多 ▾」 ── */

/* 状态文字至少要留这么宽，否则继续往「更多」里收（窄到放不下时优先牺牲项，不牺牲可读性） */
const DEVD_STAT_MIN = 96;

/* 应用根目录（这条工具栏里的紧凑版）：路径 + 更改…；点路径 = 在资源管理器中打开。
   与库页那行（app-apps.js 的 appsRootLineEl）共用同一份动作函数，不写第二份逻辑。 */
/* 应用根目录（这条工具栏里的紧凑版）：**两套根各一枚**（下载根 / 项目根）——
   路径 + 更改…；点路径 = 在资源管理器中打开。
   与库页那两行（app-apps.js 的 appsRootRowEl）共用同一份动作函数，不写第二份逻辑。 */
function appsDevRootChip(kind) {
  const roots = (typeof APPS_ST === "object" && APPS_ST && APPS_ST.list && APPS_ST.list.roots) || {};
  const root = roots[kind] || (kind === "down" ? (APPS_ST && APPS_ST.root) || {} : {}) || {};
  const box = document.createElement("span");
  box.className = "apps-dev-root";
  box.dataset.rootKind = kind;
  const tag = document.createElement("span");
  tag.className = "apps-dev-root-k";
  tag.textContent = appsDevT(kind === "dev" ? "项目根" : "下载根");
  box.appendChild(tag);
  const path = String(root.path || "");
  const val = document.createElement("button");
  val.type = "button";
  val.className = "apps-dev-root-v";
  val.textContent = path || appsDevT("未设置");
  val.title =
    appsDevT(kind === "dev" ? "项目根目录（开发中的应用）" : "下载根目录（从应用中心下载的）") +
    "\n" +
    (path || appsDevT("未设置")) +
    "\n" +
    appsDevT("点击在资源管理器中打开");
  val.onclick = () => {
    if (typeof appsRootFolderNow === "function") appsRootFolderNow(kind);
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
      if (typeof appsRootPickNow === "function") appsRootPickNow(kind);
    }),
  );
  return box;
}
function appsDevRootItem() {
  const box = document.createElement("span");
  box.className = "apps-dev-roots";
  box.appendChild(appsDevRootChip("dev"));
  box.appendChild(appsDevRootChip("down"));
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
  if (DEVD.headRaf) {
    try {
      cancelAnimationFrame(DEVD.headRaf);
    } catch (_) {}
  }
  DEVD.headRaf = 0;
  DEVD.headEl = null;
  DEVD.headSlots = [];
  DEVD.moreBtnEl = null;
  DEVD.morePopEl = null;
  DEVD.headW = 0;
}

/* 菜单条宽度监听：同宽不重排（重排会改布局，防抖一次）。
   **重排一律推到下一帧**：appsDevFitHead 会搬 DOM（改布局），在 ResizeObserver 回调里
   同步搬 = 同一帧内又产生一次未派发的尺寸通知，浏览器就抛
   「ResizeObserver loop completed with undelivered notifications.」（index.html:0）。
   推到 rAF 之后重排，回调返回时布局已定，不再自激成环。 */
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
    if (DEVD.headRaf) return;
    DEVD.headRaf = requestAnimationFrame(() => {
      DEVD.headRaf = 0;
      /* 这一帧里页面可能已经切走 / 整页重绘过：对不上就丢 */
      if (!DEVD.headEl || !DEVD.headEl.isConnected) return;
      appsDevFitHead();
    });
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
   结果是尾巴被 overflow:hidden 裁掉，而裁掉的恰好是最右的「更多」）。
   失败一律吞掉：它由 ResizeObserver 回调（rAF 后）驱动，抛出去会被报成界面错误。 */
function appsDevFitHead() {
  try {
    appsDevFitHeadDo();
  } catch (_) {}
}
function appsDevFitHeadDo() {
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
  const apps = (typeof appsLocalList === "function" ? appsLocalList() : []).filter(
    (a) => a && a.dev === true,
  );
  /* 进开发页时选哪个应用：appsDevPickApp（本页当前选中的 > 上次打开过的 > 名单第一个）。
     这样从别处回开发页不会出现「没选中应用」的空页。 */
  let cur = appsDevPickApp(apps);
  const switched = cur !== String(DEVD.appId || "");
  if (switched) {
    /* 换应用 = 新的一页上下文：会话归属 / 预览 / 快照全部重来 */
    DEVD.appId = cur;
    DEVD.draft = true;
    DEVD.sessionId = "";
    DEVD.msgCount = 0;
    DEVD.snap = null;
    DEVD.liveChangedAt = 0;
    DEVD.url = "";
    DEVD.wf = null;
    DEVD.node = null;
    DEVD.nodeFor = "";
  }
  if (cur) {
    DEVD.appId = cur;
    appsDevLastAppSave(cur);
  }
  DEVD.seq++;
  const mySeq = DEVD.seq;

  const wrap = document.createElement("div");
  wrap.className = "apps-dev";

  /* 顶部菜单条：**只允许一行**（.apps-dev-head 是 nowrap）。宽了主行多放，窄了自动把
     优先级最低的几项搬进「更多 ▾」——功能一个不少，只是位置随宽度变：
     ＋新开发会话 / 启动 / 打开画布 / 卸载 / 刷新预览 / 应用根目录 / 数据目录 /
     换风格 / 先拷问需求 / 维持状态 / 预览状态 全在这一条上（appsDevFitHead 负责搬运）。
     本轮需求：「新开发会话」的主入口移到**左栏每个应用行右端的「＋」**（点哪一行就在
     哪个应用下新建会话）；这一条工具栏里那颗也改成同一枚「＋」图标 —— 当前应用的快捷
     入口，含义与左栏那枚一样（都走 appsDevNewRound），放不下时收进「更多 ▾」里带「新开发会话」小标题。
     本轮需求：原来的「应用 + 下拉 + 作者」整组已删 —— 选应用改到左栏（点应用行），
     作者也跟去左栏那条应用行；省下的横向空间由 appsDevFitHead 自动把其余项搬回主行。 */
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
  head.appendChild(
    addSlot(
      1,
      (() => {
        const b = appsMiniBtn(appsDevT("＋"), () => appsDevNewRound(), true);
        b.title = appsDevT("新开发会话：在本应用下开一条新会话（下一次输入即新建并开工）");
        b.setAttribute("aria-label", appsDevT("新开发会话"));
        return b;
      })(),
      "新开发会话",
    ),
  );
  /* 「启动」= 等同在库中运行：给当前应用开独立窗口（appsOpenApp → apps:openWindow）。
     丢掉应用的开发节点时会话仍可跑，但没有可启动的应用时这颗按钮不出现（需求：没有应用就不给点）。 */
  if (DEVD.appId && apps.some((a) => String(a.id || "") === DEVD.appId)) {
    head.appendChild(
      addSlot(
        2,
        appsRunBtnEl("dev", appsDevT("启动"), () => appsDevStartApp()),
      ),
    );
    /* 「上架」= 打开发布浮层（renderer/app-publish.js 的 window.openAppPublish）：
       pri 2.5 = 紧挨「启动」右边；一行放不下时从 pri 最大的开始往「更多 ▾」收，
       「启动」（pri 2）比它先留在主行。未加载该模块（旧版本）时点击给可读提示，
       不在按钮层面藏功能 —— 用户看得见这条路，才知道能上架。 */
    head.appendChild(
      addSlot(
        2.5,
        appsMiniBtn(appsDevT("上架"), () => {
          if (typeof window.openAppPublish !== "function") {
            appsDevToast(
              appsDevT("上架模块未就绪（renderer/app-publish.js 未加载）"),
              "err",
            );
            return;
          }
          window.openAppPublish(DEVD.appId);
        }),
      ),
    );
  }
  /* 「上架前体检」：只读查「这个应用打成包会丢哪些文件」+「入口页引用了但目录里没有的文件」。
     pri=2.6 = 紧挨「上架」（上架前的最后一道自查），一行放不下就收进「更多 ▾」。
     病根就出在这件事上：旧的打包实现只打 app.json + 入口页 + assets/**，根目录多文件的应用
     上架后下载者拿到的是空壳（见 apps-store.js 的 packAudit）。 */
  if (DEVD.appId && apps.some((a) => String(a.id || "") === DEVD.appId)) {
    const auditBtn = appsMiniBtn(appsDevT("上架前体检"), () => {
      if (typeof window.appsPackAuditDialog === "function") window.appsPackAuditDialog(DEVD.appId);
      else appsDevToast(appsDevT("体检模块未就绪（renderer/app-apps.js 未加载）"), "err");
    });
    auditBtn.title = appsDevT(
      "检查这个应用打成包会丢哪些文件（只读：不打包、不上传、不写盘）",
    );
    head.appendChild(addSlot(2.6, auditBtn));
  }
  head.appendChild(
    addSlot(
      3,
      appsMiniBtn(appsDevT("打开画布"), () => {
        if (DEVD.appId && typeof openAppCanvas === "function")
          openAppCanvas(DEVD.appId);
      }),
    ),
  );
  /* 「卸载」：开发中的应用不再列在「库」页，卸载入口在这里补齐（确认框由库页同一份实现给出：
     只删该应用自己的子文件夹，画布 / 会话 / 其它用户内容一概不动）。取的是**最新的**本机摘要，
     不用顶上那一份可能过期的列表。 */
  head.appendChild(
    addSlot(
      3.5,
      (() => {
        const un = appsMiniBtn(appsDevT("卸载"), () => {
          const app =
            typeof appsLocalById === "function" ? appsLocalById(DEVD.appId) : null;
          if (!app) {
            appsDevToast(appsDevT("这个应用不在本机了"), "warn");
            return;
          }
          if (typeof appsUninstallApp === "function") appsUninstallApp(app);
        });
        un.classList.add("danger");
        un.title = appsDevT("只删该应用自己的子文件夹；画布、会话与该应用的存储一概不动");
        if (!DEVD.appId || !apps.some((a) => String(a.id || "") === DEVD.appId))
          un.disabled = true;
        return un;
      })(),
      "卸载",
    ),
  );
  head.appendChild(
    addSlot(
      4,
      appsMiniBtn(appsDevT("刷新预览"), () =>
        appsDevCheckPreview(true).catch(() => {}),
      ),
    ),
  );
  head.appendChild(addSlot(5, appsDevRootItem(), "应用根目录"));
  /* 「数据目录」：打开**当前这个应用**的数据文件夹（默认 <数据目录>/apps-data/<id>/，
     用户改过数据文件夹则是他选的那个）—— 与库页每张卡片右侧那颗 📂 同一个动作
     （renderer/app-apps.js 的 appsDataOpenNow，路径只由主进程解析）。pri=5.5 = 紧挨
     应用根目录；没有选中的本机应用时不给点。 */
  if (DEVD.appId && apps.some((a) => String(a.id || "") === DEVD.appId)) {
    const dirBtn = appsMiniBtn(appsDevT("数据目录"), () => {
      if (typeof appsDataOpenNow === "function") appsDataOpenNow(DEVD.appId);
    });
    dirBtn.title = appsDevT("打开这个应用的数据目录（默认在 MTNode 数据目录下按应用 id 建）");
    head.appendChild(addSlot(5.5, dirBtn, "数据目录"));
  }
  /* 「＋ 新建应用」本轮从这条菜单条移到左栏列表底部（左栏现在以应用为主体，
     建应用就该在建应用的地方）。这里不再占菜单条的宽度。 */
  /* 「换风格…」：按所选设计风格重写这个应用的入口页（renderer/app-app-flow.js 的
     appStyleSwapDialog）。pri=9 = 比几个开关还不占主行，放不下就自然收进「更多 ▾」——
     需求口径就是把它放这一条菜单里，所以它不抢主行宽度。选中应用才有得换。 */
  if (DEVD.appId && apps.some((a) => String(a.id || "") === DEVD.appId)) {
    head.appendChild(
      addSlot(
        9,
        appsMiniBtn(appsDevT("换风格…"), () => {
          const app = typeof appsLocalById === "function" ? appsLocalById(DEVD.appId) : null;
          if (typeof appStyleSwapDialog === "function")
            appStyleSwapDialog(
              DEVD.appId,
              String((app && app.name) || DEVD.appId || ""),
              String((app && app.style) || ""),
            );
        }),
        "换风格",
      ),
    );
  }
  /* 「应用能力…」：改这个应用的能力位（文字输入 / 图像生成）—— 入口页会按新能力重生成，
     所以对话框里先弹一次确认（见 renderer/app-app-flow.js 的 appCapabilitiesDialog）。 */
  if (DEVD.appId && apps.some((a) => String(a.id || "") === DEVD.appId)) {
    head.appendChild(
      addSlot(
        9.5,
        appsMiniBtn(appsDevT("应用能力…"), () => {
          const app = typeof appsLocalById === "function" ? appsLocalById(DEVD.appId) : null;
          if (typeof appCapabilitiesDialog === "function")
            appCapabilitiesDialog(
              DEVD.appId,
              String((app && app.name) || DEVD.appId || ""),
            );
        }),
        "应用能力",
      ),
    );
  }
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
  head.appendChild(addSlot(7, grill.lab));
  const keep = mkSwitch(
    "维持状态",
    DEVD.keepState,
    (on) => {
      DEVD.keepState = !!on;
    },
    "重载预览前先存下预览页的滚动位置与表单内容，加载后写回",
  );
  head.appendChild(addSlot(8, keep.lab));
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
  DEVD.colsEl = cols;

  const side = document.createElement("section");
  side.className = "apps-dev-col apps-dev-side";
  const sideHead = document.createElement("div");
  sideHead.className = "apps-dev-colhead";
  const sideK = document.createElement("span");
  sideK.textContent = appsDevT("应用");
  const q = document.createElement("input");
  /* type=text：走 base.css 的全局输入样式（深色底 / 1px 边框 / 4px 6px 内边距）。
     以前是 type=search —— 全局输入样式表不含 search，它吃浏览器默认样式把整条标题条
     撑高，三栏标题条就再也等不了高（本页标题条高度统一见 css/apps.css 的
     --apps-dev-colhead-h）。 */
  q.type = "text";
  q.className = "apps-dev-q";
  /* 搜索：同时搜应用名与会话标题（app-assist.js 的应用分组渲染按这个口径过滤） */
  q.placeholder = appsDevT("搜索应用 / 会话…");
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
  /* 左栏底部：本机还没有「开发中」的应用时，这条列表就是唯一的入口 —— 把「＋ 新建应用」
     钉在列表底部（本轮需求：它从顶栏菜单条移到这里）。列表滚动区独立，这行不跟着滚。 */
  const sideFoot = document.createElement("div");
  sideFoot.className = "apps-dev-sidefoot";
  if (typeof appsCreateAppBtnEl === "function") sideFoot.appendChild(appsCreateAppBtnEl());
  if (sideFoot.childNodes.length) side.appendChild(sideFoot);
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
      /* 点的是**别的应用**下的会话（左栏现在把所有开发中应用的会话都折叠在自己的应用行下）：
         先切到那个应用（原地换：预览与右栏一起换），再把这条会话拨回来显示 ——
         否则中栏预览还停在上一个应用，右栏却已经是另一条会话的内容。 */
      const st0 =
        typeof agentSessionById === "function" ? agentSessionById(sid) : null;
      const sidApp = st0 ? String(st0.appId || "") : "";
      if (sidApp && sidApp !== String(DEVD.appId || "")) {
        if (typeof appsDevSelectApp === "function") appsDevSelectApp(sidApp);
        DEVD.draft = false;
        DEVD.sessionId = sid;
        DEVD.msgCount =
          st0 && Array.isArray(st0.messages) ? st0.messages.length : 0;
        appsDevRenderConv();
        appsDevEnsureCurrentSession();
        return;
      }
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
      /* 点中的这条若已不在（列表是上一帧画的、会话刚被删）：不能把本页留在
         「非首轮态却画不出东西」——立即补回本应用最新一条（没有才回落到首轮态） */
      appsDevEnsureCurrentSession();
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
  /* 这个应用上次离开预览时的状态（滚动 / 表单值）：挂在第一帧的 src 之前，
     load 监听会把它写回去。整页重绘也走这一处，所以从别处回到开发页同样能接上。 */
  DEVD.pendingState = appsDevStateOf(cur);
  if (DEVD.url) frame.setAttribute("src", DEVD.url);
  DEVD.frameApp = cur;
  DEVD.frame = frame;
  frame.addEventListener("load", () => {
    /* 新页加载完成 = 收起切应用时露出的「正在加载…」（没露时是幂等空操作） */
    appsDevLoadingHide();
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
  /* 三栏宽度 + 两条拖拽把手（默认左 240px + 中/右各半，宽度按全局偏好沿用） */
  appsDevBindCols();
  /* 首帧就绑好显示覆盖、并按本页这条会话画一次：预览 info / 开发节点都是异步的，
     不先画一次的话，这段空窗期里右栏（刚搬过来的那几个面板）还留着上一个上下文的
     内容 —— 首帧残留（用户看到的「刚点开开发页，右栏里是别人的计划」）。 */
  appsDevRenderConv();

  if (!cur) {
    /* 左栏：应用分组由宿主渲染，但一个「开发中」的应用都没有时宿主不生效（appId 为空），
       这一列会空着 —— 直接给一行空态，别让用户看着一条空列表猜。 */
    const e = document.createElement("div");
    e.className = "side-empty";
    e.textContent = appsDevT("本机还没有「开发中」的应用");
    sideList.appendChild(e);
    appsDevPaintPreviewStat("error");
    appsDevPreviewStatMsg(
      appsDevT("本机还没有「开发中」的应用：在「库」页点「二次开发」，或点左栏底部的「＋ 新建应用」。"),
    );
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
  /* 首次进入（或换了应用）：右栏落到该应用最近一条会话；没有就是首轮态。
     框里还有没发出去的首轮草稿时不自动选 —— 那是用户正在写的开发需求，
     换成会话就会把它从眼前顶掉（与 appsDevEnsureCurrentSession 同一道闸）。 */
  if (DEVD.draft && !DEVD.sessionId && !appsDevDraftPending()) {
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
  if (!alive()) {
    /* 这次绘制已被后来的绘制顶掉（会话表 / 预览都还在来）：右栏此刻可能还停在首轮态，
       但那次被顶掉的自动选中不会再跑 —— 补一次，别让右栏停在空白态。 */
    appsDevEnsureCurrentSession();
    return;
  }
  appsDevRenderConv();
  /* 首次进入时选的那条在这期间又没了（会话表同步晚到 / 被别处删）：再兜一次底 */
  appsDevEnsureCurrentSession();
}

/* 换应用（左栏点应用行 / 迁移成功后自动切过来）。
   **不再整页重绘**（用户口径：切换左栏应用时整个界面被刷新了，应当只有预览窗部分刷新）：
   三栏 DOM（左栏列表容器、中栏那**同一只** iframe、右栏会话）原样留着，只换「当前应用」
   相关的那几处 ——
     ① 左栏：原地重画一次列表（选中态 / 展开态变了，容器与搜索框不动）；
     ② 中栏：复用同一只 iframe，只把 src 换到新应用，并露出「正在加载…」；
     ③ 右栏：落到新应用最近一条会话（没有则首轮态）；
     ④ 切换前先把旧应用预览页的状态（滚动 / 表单值）存进内存，切回来时写回。
   页面还没画好（刚被别处重绘 / 还在开发页以外的页）时退回整页绘制 —— 它会重新拉一次
   应用名单，把工具栏与三栏画齐。 */
function appsDevSelectApp(appId) {
  const id = String(appId || "").trim();
  if (id) {
    if (!DEVD.expanded) DEVD.expanded = {};
    DEVD.expanded[id] = true;
  }
  const prev = String(DEVD.appId || "");
  /* 同一个应用：只保证左栏选中态是对的，预览与右栏都不动（旧实现会整页重绘一次） */
  if (id && id === prev) {
    try {
      if (typeof renderAgentSessionSidebar === "function")
        renderAgentSessionSidebar();
    } catch (_) {}
    return;
  }
  /* 上次打开的应用跟着切（与整页绘制那条路同源：回开发页时自动选它）。放在最前面 ——
     只有真换了一个应用才值得写盘，同值不重复落盘由 appsDevLastAppSave 自己挡。 */
  if (id) appsDevLastAppSave(id);
  DEVD.appId = id;
  DEVD.draft = true;
  DEVD.sessionId = "";
  DEVD.msgCount = 0;
  DEVD.snap = null;
  DEVD.liveChangedAt = 0;
  DEVD.url = "";
  DEVD.pendingState = null;
  DEVD.wf = null;
  DEVD.node = null;
  DEVD.nodeFor = "";
  /* 左栏搜索词跟着留着（不再清空）：整页重绘被撤掉之后，搜索框与它里面的字都不该被这次
     切换顺手抹掉。 */
  /* 新应用不在左栏名单里（刚迁移 / 刚新建、名单还没刷到）：退回整页绘制，
     它会重新拉一次名单再把工具栏与三栏画齐（左栏也得有这一行可点）。 */
  const known = appsDevApps().some((a) => String(a.id || "") === id);
  if (id && known && appsDevSwitchAppInPlace(prev)) return;
  if (typeof appsHubPaint === "function") appsHubPaint();
}

/* 预览 iframe 还在页面上吗：切应用复用的就是它；页面被别处重绘掉之后它已经脱离文档
   （此时只剩「整页绘制」那条路能救）。用 document.contains 而不是 isConnected ——
   本仓的渲染层冒烟用一只迷你 DOM 跑这些函数，那只 DOM 没有 isConnected。 */
function appsDevFrameLive() {
  const frame = DEVD.frame;
  if (!frame) return null;
  try {
    if (typeof document.contains === "function" && !document.contains(frame)) return null;
  } catch (_) {}
  return frame;
}

/* 轻量切换：只在「开发页已经画好」时接管（iframe 与右栏都在 DOM 上），返回 true = 已接管。
   返回 false 时调用方退回整页绘制。 */
function appsDevSwitchAppInPlace(prevId) {
  const frame = appsDevFrameLive();
  if (!appsDevPageOpen() || !frame || !DEVD.frameWrap) return false;
  const seq = DEVD.seq;
  const id = String(DEVD.appId || "");
  /* ① 左栏：立刻换选中态（原地重画这一列） */
  try {
    if (typeof renderAgentSessionSidebar === "function")
      renderAgentSessionSidebar();
  } catch (_) {}
  /* ② 中栏：立刻露出「正在加载…」——旧应用的画面马上就要被换掉 */
  appsDevLoadingShow();
  appsDevSwitchAppRun(prevId, id, seq).catch(() => {});
  return true;
}

/* 切换的异步段：先向旧预览页要一份状态（最多 700ms 兜底），再换右栏与 iframe 的 src。
   中途用户随时可能再切一次 / 关页，所以每一步之前都先验「还是这一轮那次切换」。 */
async function appsDevSwitchAppRun(prevId, id, seq) {
  /* 切走前问一次旧预览页的状态（最多 700ms 兜底）；「维持状态」关掉 / 那一帧装的不是它
     （连着切两次时）就不问。 */
  const state =
    DEVD.keepState && prevId && String(DEVD.frameApp || "") === String(prevId)
      ? await appsDevFrameStateSave(700)
      : null;
  appsDevStateSave(prevId, state);
  if (!appsDevSwitchAlive(id, seq)) return;
  /* ③ 右栏：落到新应用最近一条会话（没有则首轮态）。这一段不依赖预览 info，先做完，
     免得右栏在上一个应用的会话内容上多停一次 IPC 的工夫。 */
  if (DEVD.draft && !DEVD.sessionId && !appsDevDraftPending()) {
    const sess =
      typeof appSessionsOf === "function" ? appSessionsOf(DEVD.appId)[0] : null;
    if (sess) {
      DEVD.draft = false;
      DEVD.sessionId = sess.id;
      DEVD.msgCount = Array.isArray(sess.messages) ? sess.messages.length : 0;
      try {
        if (typeof persistAgentSession === "function") await persistAgentSession();
      } catch (_) {}
    }
  }
  if (!appsDevSwitchAlive(id, seq)) return;
  appsDevRenderConv();
  /* ④ 中栏：preview info（入口页 / 文件数 / 修改时间）→ 复用同一只 iframe 换 src */
  const info = await appsDevPreviewInfo();
  if (!appsDevSwitchAlive(id, seq)) return;
  if (!info || info.ok === false) {
    DEVD.snap = null;
    DEVD.url = appsDevUrlOf(id);
    appsDevPaintPreviewStat("error");
    appsDevPaintUrl();
    appsDevPreviewStatMsg(
      info && info.error
        ? appsDevT("预览不可用：") + String(info.error)
        : appsDevT("读不到该应用目录（可能在别处被删了）"),
    );
  } else {
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
  }
  const fr = appsDevFrameLive();
  if (!DEVD.url || !fr) return;
  /* 这个应用上次离开预览时的状态：挂在这一次 src 之前，load 监听会写回 */
  DEVD.pendingState = appsDevStateOf(id);
  const sep = DEVD.url.indexOf("?") >= 0 ? "&" : "?";
  DEVD.reloadSeq = (Number(DEVD.reloadSeq) || 0) + 1;
  fr.setAttribute("src", DEVD.url + sep + "_r=" + Date.now() + "-" + DEVD.reloadSeq);
  DEVD.frameApp = id;
  if (info && info.ok !== false) appsDevRefreshHead().catch(() => {});
  /* 切换期间这条会话若在别处没了：补回本应用最新一条，别把右栏留在空白态 */
  if (appsDevSwitchAlive(id, seq)) appsDevEnsureCurrentSession();
}

/* 还是这一轮那次切换吗：页面还开着、还是那个应用、没有被后来的绘制 / 再切一次顶掉 */
function appsDevSwitchAlive(id, seq) {
  return (
    appsDevPageOpen() &&
    DEVD.seq === seq &&
    String(DEVD.appId || "") === String(id || "")
  );
}

/* 入口别名（app-apps.js 的 appsPaintDevPage 按 typeof 取） */
window.appsDevSidebarHost = appsDevSidebarHost;
window.appsDevComposerSend = appsDevComposerSend;
window.appsDevPagePaint = appsDevPagePaint;
window.appsDevPageUnmount = appsDevPageUnmount;
/* 左栏应用行「＋」/ 工具栏「＋」两个入口共用（app-assist.js 经宿主 onAppNew 取） */
window.appsDevNewSessionFor = appsDevNewSessionFor;
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
  /* ── 预览态宿主桥（本轮需求：预览状态下也能连入 MTNode）───────────────
     bridge = 本页给中栏那一帧登记的预览租约（token → 主进程认「这一帧是哪个应用」）；
     bridgeWatch = 本页的订阅集合（流式帧 / 通知 / 语音状态 / 窗口开关）；
     bridgeWinMsg = 帧 → 本页那条 postMessage 监听（关页时摘掉）。 */
  bridge: { token: "", appId: "", readOnly: false, ready: false },
  bridgeWatch: null,
  bridgeWinMsg: null,
  bridgeCloseBtn: null, /* 预览列头那颗「关掉独立窗口」（只读时露出） */
  bridgeNoticeEl: null, /* 预览区那条短提示（被禁 / 被拒的动作） */
  bridgeNoticeTimer: 0,
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
  /* 「用户点过＋、要开一条**新**会话」的意图位（见 appsDevNewRoundOn / Mark / Clear）。
     与 draft 不是一回事：draft = 首轮态（也可能只是「切到这个应用顺手看一眼」），
     newRound = 这个首轮态是**点＋点出来的**，不许被「落回该应用最近一条会话」的兜底顶掉。 */
  newRound: false,
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

/* vars = 占位符替换表（I18n.t 第二参）：与 app-apps.js 的 appsT 同一纪律 ——
   少传这一位，带 {author} / {version} 的整句（合并会话标题、那条关键输入）就原样带着
   花括号显示给用户（用户报的「author 和 version 都并未正确填充」）。 */
function appsDevT(s, vars) {
  return window.I18n && typeof I18n.t === "function"
    ? I18n.t(s, vars)
    : String(s == null ? "" : s);
}
/** 带占位符的整句：填一遍 + **填不干净就当场报错**。
 *  判据两层：① 整句里点名的占位符，vars 必须给出非空值（I18n.t 会把缺失的键填成空串，
 *  只把整句变成「合并  v 的差异」，不报错 —— 静默少字，只有显式检查拦得住）；
 *  ② 填完还残留 {\w+} 也算漏（键名写错时是这种形态）。 */
function appsDevTpl(key, vars) {
  const v = vars && typeof vars === "object" ? vars : {};
  const need = [];
  String(key).replace(/\{(\w+)\}/g, (_, k) => {
    if (need.indexOf(k) < 0) need.push(k);
    return _;
  });
  const empty = need.filter((k) => String(v[k] == null ? "" : v[k]).trim() === "");
  const out = String(appsDevT(key, vars));
  const miss = out.match(/\{\w+\}/g) || [];
  if (empty.length || miss.length) {
    throw new Error(
      "appsDevTpl 少给占位符：" + key + (empty.length ? " → 空值：" + empty.join(",") : "") +
        (miss.length ? " → 未替换：" + miss.join(",") : ""),
    );
  }
  return out;
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
  if (typeof appsOpenApp === "function") appsOpenApp(id, "dev");
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
      typeof appsLocalById === "function" ? appsLocalById(id, "dev") : null;
    return String((hit && hit.dir) || "").trim();
  } catch (_) {
    return "";
  }
}
/* ── 该应用名下会话的工作区对齐（本轮需求 · 需求三）────────────────────────
 *
 * 口径（用户共识）：点左栏应用条目 / 切到该应用、打开开发页、每次开轮前，都按**同一判据**
 * 走一遍 ——
 *   · 会话没填过工作区（空）→ 写成该应用目录；
 *   · 填过、但那个目录已经不存在（迁移旧布局留下的旧路径）→ 也改写成该应用目录；
 *   · 填过且目录还在（用户自己选的地方）→ 一个字不动。
 * 写入的是会话的 workspace（「手填」语义，与「手填 > 画布项目根 > 默认」这条既有解析链一致，
 * 不新增第二种语义）；运行中的会话一律不动（开轮时锁定的工作区不能中途漂）。
 * 结果由 renderAgentComposer 回显成底部那颗「工作区」芯片（显示末段目录名，悬浮给全路径）。 */
async function appsDevAlignAppWorkspace(appId) {
  const id = String(appId || DEVD.appId || "").trim();
  if (!id) return 0;
  const dir = appsDevProjectDir(id);
  if (!dir) return 0;
  const list = typeof appSessionsOf === "function" ? appSessionsOf(id) : [];
  if (!list.length) return 0;
  const seen = DEVD.wsSeen || (DEVD.wsSeen = new Map()); /* sid -> 已核对过的那个（存在的）目录值 */
  let changed = 0;
  for (const st of list) {
    if (!st || appsDevSessionRunning(st)) continue;
    const cur = String(st.workspace || "").trim();
    if (cur && appsSamePath(cur, dir)) {
      seen.set(String(st.id), cur);
      continue;
    }
    if (cur) {
      /* 非空且不是应用目录：只在「那个目录已经不在盘上」时改写。同一版核对过一次就记下来，
         免得 1.2s 的轮询反复问主进程。 */
      if (seen.get(String(st.id)) === cur) continue;
      let isDir = false;
      try {
        isDir = !!(await window.api.fileIsDir(cur));
      } catch (_) {
        isDir = false;
      }
      seen.set(String(st.id), cur);
      if (isDir) continue;
    }
    st.workspace = dir;
    changed++;
  }
  if (changed) {
    try {
      if (typeof persistAgentSession === "function") await persistAgentSession();
    } catch (_) {}
    try {
      if (typeof renderAgentComposer === "function") renderAgentComposer();
    } catch (_) {}
  }
  return changed;
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
/* 「开发中」的应用（本机列表顺序 = 安装时间新→旧，左栏照原样用；**只列躺在项目根下的**，
   与库页相反 —— 开发中的应用不从库页进，入口就是这一列 + 顶栏那条菜单）。
   判据是「哪一套根」而不是 app.json 的 dev 标记：同一个 id 在下载根与项目根各有一份时
   （用户看对方那一版时装了一份同 id 的进下载根），两边共用同一份清单字段，只看 dev 标记
   会把下载那份也列进来 —— 见 renderer/app-apps.js 的 appsLocalRootKind、
   apps-store.js 的 listApps / appSummary（rootAuthority）。 */
function appsDevApps() {
  const all = typeof appsLocalList === "function" ? appsLocalList() : [];
  return all.filter(
    (a) =>
      a &&
      (typeof appsLocalRootKind === "function" ? appsLocalRootKind(a) === "dev" : a.dev === true),
  );
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
    onAppSelect: (id) => {
      /* 点应用行身 = 「进这个应用（看它最近一条会话）」：与点行右端的「＋」（新建一条会话）
         分得很清 —— 这里先把点＋ 立下的意图清掉，否则那个首轮态会一直挡着本页
         自动落回该应用最近一条会话（见 DEVD.newRound 的说明）。 */
      appsDevNewRoundClear();
      appsDevSelectApp(id);
    },
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
  appsDevBridgeWatch();
}
/* ── 预览态宿主桥（本轮需求）：本页的订阅与拆除 ──
 * 一处订阅就够：主进程把预览的流式帧（apps:hostStream）、被禁 / 被拒的通知与语音状态帧
 * （dsh:event）都发到主窗口，本页按 appId 转给中栏那一帧。 */
function appsDevBridgeWatch() {
  if (DEVD.bridgeWatch) return;
  const api = window.api || {};
  const offs = [];
  const keep = (off) => {
    if (typeof off === "function") offs.push(off);
  };
  if (
    typeof window !== "undefined" &&
    !DEVD.bridgeWinMsg &&
    typeof window.addEventListener === "function"
  ) {
    /* 帧 → 本页（postMessage）：只认中栏那一帧的来源 */
    DEVD.bridgeWinMsg = (ev) => {
      const frame = DEVD.frame;
      if (!frame || ev.source !== frame.contentWindow) {
        /* 不是中栏那一帧发来的（别的 iframe / 灯箱）→ 交给别的监听器 */
        return;
      }
      appsDevBridgeOnFrameMsg(ev);
    };
    window.addEventListener("message", DEVD.bridgeWinMsg);
  }
  if (typeof api.onAppsHostStream === "function")
    keep(api.onAppsHostStream((msg) => appsDevBridgeEvent(msg)));
  if (typeof api.onSpeechState === "function")
    keep(
      api.onSpeechState((data) =>
        appsDevBridgeEvent({ type: "speech-state", data: data || {} }),
      ),
    );
  if (typeof api.dshOnEventAny === "function")
    keep(api.dshOnEventAny((msg) => appsDevBridgeNoticeFromMain(msg)));
  if (typeof api.onAppsWindowChanged === "function")
    keep(api.onAppsWindowChanged(() => {
      appsDevBridgeSyncWindow().catch(() => {});
    }));
  DEVD.bridgeWatch = { offs: offs };
}
function appsDevBridgeUnwatch() {
  if (typeof window !== "undefined" && DEVD.bridgeWinMsg) {
    try {
      window.removeEventListener("message", DEVD.bridgeWinMsg);
    } catch (_) {}
  }
  DEVD.bridgeWinMsg = null;
  const w = DEVD.bridgeWatch;
  DEVD.bridgeWatch = null;
  if (w && Array.isArray(w.offs)) {
    for (const off of w.offs) {
      try {
        off();
      } catch (_) {}
    }
  }
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
     时，应用下已有会话也不会被自动选走。框清空 / 发出去之后这条闸自动放开。
     本轮补上另一半：**点过＋（DEVD.newRound）时框里必然还是空的**，只靠「框里有字」区分
     不出来 —— 那一瞬（点＋ 之后还没开始打字）也会被这条兜底换成该应用最近一条会话，
     表现就是「点了＋却建不出第二条会话」。所以意图位一起进这道闸。 */
  if (DEVD.draft && (appsDevNewRoundOn() || appsDevDraftPending())) return false;
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
      if (typeof agentFlushSessionSaveQuiet === "function") agentFlushSessionSaveQuiet();
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
  /* 预览态宿主桥：先撤租约（主进程据此不再认这一帧），再撤本页的订阅 */
  appsDevBridgeRelease();
  appsDevBridgeUnwatch();
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
  DEVD.bridgeCloseBtn = null;
  DEVD.bridgeNoticeEl = null;
  if (DEVD.bridgeNoticeTimer) {
    try {
      clearTimeout(DEVD.bridgeNoticeTimer);
    } catch (_) {}
  }
  DEVD.bridgeNoticeTimer = 0;
  DEVD.bridge = { token: "", appId: "", readOnly: false, ready: false };
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

/* ── 预览态宿主桥的中继（本轮需求：预览状态下也能连入 MTNode）────────────────────
 *
 * 预览页是 mtnode-preview:// 的一只 iframe，**没有 preload**，所以它自己拿不到 window.appHost。
 * 主进程注入的那段小助手（apps-store.js 的 PREVIEW_BRIDGE）在 iframe 里拼出一座同形状的薄壳，
 * 把每次调用 postMessage 给本页；本页按**来源帧**核对身份后，转调主窗口 preload 的
 * apps:previewHost* 通道（主进程按 appId + token 认预览租约），再把结果 / 流式帧送回那一帧。
 *
 * 纪律：
 *   · 只认「当前中栏那一帧」的来源（ev.source === frame.contentWindow）；
 *   · 中继只在本页开着时存在（关页 / 重绘即撤 → 预览页拿不到回信，它会自己超时/降级）；
 *   · 事件（文本 delta / 出图进度 / 语音状态）只转给 appId 相符的那一帧。 */
const DEVD_BRIDGE_K = "__mtnodePreview";
function appsDevBridgeToken() {
  const t = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  DEVD.bridge = { token: t, appId: "", readOnly: false, ready: false };
  return t;
}
/* 往中栏那一帧发一条协议消息（帧还没挂上就什么也不做） */
function appsDevFramePost(msg) {
  const frame = DEVD.frame;
  if (!frame || !frame.contentWindow) return false;
  try {
    frame.contentWindow.postMessage(msg, "*");
    return true;
  } catch (_) {
    return false;
  }
}
/* 登记这一帧的预览租约：主进程据此认「这一帧是哪个应用」——
   没有它，帧里的任何调用都会被回 not_preview（宁可不给，也不猜）。 */
async function appsDevBridgeRegister() {
  const api = window.api || {};
  if (typeof api.appsPreviewRegister !== "function") {
    appsDevPaintBridge("none");
    return null;
  }
  const id = String(DEVD.appId || "").trim();
  if (!id) {
    appsDevPaintBridge("none");
    return null;
  }
  const token = appsDevBridgeToken();
  let r = null;
  try {
    r = await api.appsPreviewRegister({ appId: id, token: token });
  } catch (_) {
    r = null;
  }
  if (!r || r.ok === false) {
    appsDevPaintBridge("none");
    return null;
  }
  DEVD.bridge = { token: token, appId: String(r.id || id), readOnly: !!r.readOnly, ready: false };
  appsDevPaintBridge("pending");
  /* 只读态先告诉帧：它据此把写类能力与 localStorage 一起收住（不必等第一次调用才发现） */
  appsDevFramePost({
    [DEVD_BRIDGE_K]: 1,
    op: "host-ready",
    appId: DEVD.bridge.appId,
    readOnly: DEVD.bridge.readOnly,
  });
  return r;
}
/* 撤销租约（切应用 / 关页 / 重绘前）：带 token，撤的只会是这一帧那一条 */
function appsDevBridgeRelease() {
  const api = window.api || {};
  const b = DEVD.bridge || {};
  DEVD.bridge = { token: "", appId: "", readOnly: false, ready: false };
  if (!b.token || typeof api.appsPreviewRelease !== "function") return;
  try {
    api.appsPreviewRelease({ token: b.token });
  } catch (_) {}
}
/* 中继一条调用：调主窗口 preload，再把回执送回那一帧（失败也回，别让帧白等） */
async function appsDevBridgeCall(frameWin, msg) {
  const api = window.api || {};
  const id = String((msg && msg.id) || "");
  const method = String((msg && msg.method) || "");
  const send = (ok, result) => {
    try {
      if (frameWin && !frameWin.closed)
        frameWin.postMessage(
          { [DEVD_BRIDGE_K]: 1, op: "host-result", id: id, ok: !!ok, result: result || {} },
          "*",
        );
    } catch (_) {}
  };
  if (typeof api.appsPreviewCall !== "function") {
    send(false, { ok: false, code: "no_bridge", error: appsDevT("宿主桥未就绪") });
    return;
  }
  let r = null;
  try {
    r = await api.appsPreviewCall({
      token: String((DEVD.bridge || {}).token || ""),
      method: method,
      arg: msg && msg.arg != null ? msg.arg : {},
    });
  } catch (e) {
    r = { ok: false, code: "bridge_failed", error: String((e && e.message) || e) };
  }
  send(r && r.ok !== false, r || { ok: false, code: "bridge_failed" });
}
/* 预览页发来的一条协议消息（只处理「当前中栏那一帧」发来的） */
function appsDevBridgeOnFrameMsg(ev) {
  const d = ev && ev.data;
  if (!d || typeof d !== "object" || d[DEVD_BRIDGE_K] !== 1) return false;
  const b = DEVD.bridge || {};
  if (d.op === "host-ping") {
    /* 帧里的桥已就位：把租约与只读态回给它（先登记再过桥，顺序不能反） */
    if (b.token) {
      appsDevFramePost({
        [DEVD_BRIDGE_K]: 1,
        op: "host-ready",
        appId: String(b.appId || ""),
        readOnly: !!b.readOnly,
      });
      DEVD.bridge.ready = true;
      appsDevPaintBridge("ready");
    }
    return true;
  }
  if (d.op === "host-call") {
    appsDevBridgeCall(ev.source, d).catch(() => {});
    return true;
  }
  if (d.op === "host-notice") {
    /* 预览里那些「被禁的动作」（close / quit）：在中栏浮一条短提示（与主进程那条通知同一口径） */
    const code = String((d.notice && d.notice.code) || "");
    if (code === "preview_no_window") appsDevBridgeNotice("preview_no_window");
    return true;
  }
  if (d.op === "state") return false; /* 维持状态那条链路（另一个监听器） */
  return false;
}
/* 预览区那条短提示（被禁 / 被拒的动作）：3 秒自动消失，不抢焦点 */
function appsDevBridgeNotice(code, text) {
  const wrap = DEVD.frameWrap;
  if (!wrap) return;
  let el = DEVD.bridgeNoticeEl;
  if (!el) {
    el = document.createElement("div");
    el.className = "apps-dev-bridgenote";
    el.hidden = true;
    wrap.appendChild(el);
    DEVD.bridgeNoticeEl = el;
  }
  el.textContent =
    text ||
    (code === "readonly_preview"
      ? appsDevT("该应用已在独立窗口运行，预览为只读")
      : appsDevT("预览里没有可关闭的独立窗口（预览是开发页中栏的一只 iframe）"));
  el.hidden = false;
  if (DEVD.bridgeNoticeTimer) clearTimeout(DEVD.bridgeNoticeTimer);
  DEVD.bridgeNoticeTimer = setTimeout(() => {
    if (el) el.hidden = true;
  }, 3000);
}
/* 状态行上的「预览已连入宿主 / 只读」+ 只读时那颗「关掉独立窗口」按钮 */
function appsDevPaintBridge(kind) {
  const b = DEVD.bridge || {};
  if (kind === "none") DEVD.bridge = { token: "", appId: "", readOnly: false, ready: false };
  appsDevStatRepaint();
  const el = DEVD.statEl;
  if (el)
    el.title = appsDevT(
      "预览里也能调用 MTNode 的宿主能力（模型 / 存储 / 账号 / 选图 / 语音）：应用不必退回浏览器本地存储",
    ) + (b.appId ? "\n" + appsDevT("预览的应用：") + b.appId : "");
  if (DEVD.bridgeCloseBtn) DEVD.bridgeCloseBtn.hidden = !DEVD.bridge.readOnly;
}
/* 独立窗口开了 / 关了：立刻改状态行，并把只读态发给预览页（不必等下一次重载） */
async function appsDevBridgeSyncWindow() {
  const api = window.api || {};
  const b = DEVD.bridge || {};
  if (!b.token || typeof api.appsPreviewState !== "function") return;
  let r = null;
  try {
    r = await api.appsPreviewState();
  } catch (_) {
    return;
  }
  if (!r || r.ok === false) return;
  if (String(r.id || "") && String(r.id) !== String(b.appId || "")) return; /* 租约已经不是这一帧的 */
  const ro = !!r.readOnly;
  if (ro === !!b.readOnly) {
    appsDevPaintBridge(b.ready ? "ready" : "pending");
    return;
  }
  DEVD.bridge.readOnly = ro;
  appsDevFramePost({ [DEVD_BRIDGE_K]: 1, op: "host-state", readOnly: ro });
  appsDevPaintBridge(b.ready ? "ready" : "pending");
}
/* 关掉这个应用的独立窗口（只读时那颗按钮）：走主进程按 id 关的那条通道
   （apps:closeAppWindow → closeAppWindow，同一条「先请应用收尾、再关」的链）；
   关完由主进程的窗口开关事件回来把只读态收掉。 */
function appsDevCloseOwnWindow() {
  const id = String(DEVD.appId || "").trim();
  const api = window.api || {};
  if (!id || typeof api.appsCloseApp !== "function") return;
  api.appsCloseApp(id).catch(() => {});
}
/* 主进程推来的事件 → 转给中栏那一帧（按 appId 分流；语音状态是全局的，照转） */
function appsDevBridgeEvent(msg) {
  if (!msg) return;
  const appId = String(msg.appId || "");
  if (appId && appId !== String(DEVD.appId || "")) return;
  appsDevFramePost({ [DEVD_BRIDGE_K]: 1, op: "host-event", event: msg });
}
function appsDevBridgeNoticeFromMain(msg) {
  if (!msg || msg.type !== "preview-notice") return;
  if (String(msg.appId || "") !== String(DEVD.appId || "")) return;
  appsDevBridgeNotice(String(msg.code || ""), String(msg.error || ""));
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
   index.html 当默认入口页发出来（apps-store.js），改过入口名的应用协议层再按目录兜底。
   带 _host=1：开发页中栏这一帧要**连入宿主**（协议层据此注入宿主桥小助手，
   见 apps-store.js 的 PREVIEW_BRIDGE）；别的入口直接开这个 url 时不带它 = 纯静态预览。 */
function appsDevPreviewUrlFallback(appId) {
  const sid = String(appId || "").trim();
  if (!sid) return "";
  return "mtnode-preview://" + encodeURIComponent(sid) + "/index.html?_host=1";
}
/* 首次同步（还没拿到 info）时挂上去的 url：应用 id 一有就不留空 iframe */
function appsDevUrlOf(appId) {
  return appsDevPreviewUrlFallback(appId);
}
/* ── 「应用文件夹」（本轮需求）：预览列头那一枚文件夹按钮 ─────────────────────────
 * 点它 = 在系统资源管理器里打开**当前这个应用的文件夹**（应用目录：index.html / app.json
 * 所在的那个，开发中在项目根 apps-dev/<id>、下载的在下载根 apps/<id>）。
 * 路径真源只有主进程，渲染层不拼：
 *   ① 先走 appsLocalList 那条摘要里的 dir（appsDevProjectDir，路径最权威）；
 *   ② 摘要还没回来（应用刚建 / 列表是上一帧的）时，回落到预览 info 的 dir（apps:devPreview
 *      同一个 previewDirOf 解析）；两条都拿不到 = 明确提示，绝不去猜路径。
 * 打开动作走 preload 早就白名单好的通用出口 window.api.shellOpenPath（主进程 shell:openPath
 * → shell.openPath），不新增 IPC；失败按中文可读话术弹 toast。 */
function appsDevFolderBtnEl() {
  const b = appsMiniBtn(appsDevT("📂 应用文件夹"), () => appsDevOpenAppFolder());
  b.classList.add("apps-dev-folderbtn");
  b.title = appsDevT("在资源管理器里打开这个应用的文件夹（入口页 index.html 所在的那个目录）");
  b.setAttribute("aria-label", appsDevT("打开应用文件夹"));
  return b;
}
async function appsDevOpenAppFolder() {
  const id = String(DEVD.appId || "").trim();
  if (!id) {
    appsDevToast(appsDevT("先在左栏选一个应用"), "warn");
    return;
  }
  const api = window.api || {};
  if (typeof api.shellOpenPath !== "function") {
    appsDevToast(appsDevT("无法打开文件夹：宿主桥未就绪"), "err");
    return;
  }
  let dir = appsDevProjectDir(id);
  if (!dir) {
    const info = await appsDevPreviewInfo();
    dir = String((info && info.dir) || "").trim();
  }
  if (!dir) {
    appsDevToast(appsDevT("读不到该应用文件夹（可能在别处被删了）"), "warn");
    return;
  }
  let r = null;
  try {
    r = await api.shellOpenPath(dir);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) {
    appsDevToast(appsDevT("无法打开文件夹：") + String((r && r.error) || ""), "err");
    return;
  }
  appsDevToast(appsDevT("已打开应用文件夹：") + dir, "ok");
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
     点了没反应（真机上是「刷新预览」这种密度才会碰到，但一样得挡住）。
     _host=1 = 这一帧要连入宿主（协议层据此注入宿主桥小助手；别的入口不带它 = 纯静态预览）。 */
  DEVD.reloadSeq = (Number(DEVD.reloadSeq) || 0) + 1;
  frame.setAttribute(
    "src",
    DEVD.url + sep + "_host=1&_r=" + Date.now() + "-" + DEVD.reloadSeq,
  );
  appsDevPreviewStatMsg("");
}
/* 快照那一段文字（文件数 / 体积 / 最近修改） */
function appsDevStatSnapText() {
  const s = DEVD.snap || {};
  const bits = [];
  if (s.files != null) bits.push(s.files + appsDevT(" 个文件"));
  if (s.bytes != null && typeof appsBytes === "function")
    bits.push(appsBytes(s.bytes));
  if (s.mtimeMs && typeof appsTime === "function")
    bits.push(appsDevT("最近修改 ") + appsTime(s.mtimeMs));
  return bits.join(" · ");
}
/* 宿主桥那一段文字（本轮需求：预览已连入宿主 / 只读） */
function appsDevStatBridgeText() {
  const b = DEVD.bridge || {};
  if (!b.token && !b.appId) return appsDevT("预览未连入宿主");
  if (b.readOnly) return appsDevT("预览已连入宿主 · 只读（该应用已在独立窗口运行）");
  return b.ready ? appsDevT("预览已连入宿主") : appsDevT("预览正在连入宿主…");
}
/* 快照那一句（预览已是最新 / 有改动 → 已重载 / 不可用） */
function appsDevStatHeadText(kind) {
  return kind === "changed"
    ? appsDevT("内容有改动 → 已重载预览")
    : kind === "reload"
      ? appsDevT("已重载预览")
      : kind === "error"
        ? appsDevT("预览不可用")
        : appsDevT("预览已是最新");
}
/* 状态行 = 「那一句」+ 桥那一段 + 快照那一段 —— 两处各自刷新，谁也不许整行覆盖另一处 */
function appsDevStatRepaint() {
  const el = DEVD.statEl;
  if (!el) return;
  const bits = [appsDevStatHeadText(DEVD.statKind), appsDevStatBridgeText()];
  const snap = appsDevStatSnapText();
  if (snap) bits.push(snap);
  el.textContent = bits.join(" · ");
}
function appsDevPaintPreviewStat(kind) {
  const el = DEVD.statEl;
  if (!el) return;
  DEVD.statKind = kind;
  appsDevStatRepaint();
}
function appsDevPaintUrl() {
  const el = DEVD.urlEl;
  if (!el) return;
  const info = DEVD.snap || {};
  el.textContent = String(DEVD.url || "");
  el.title =
    appsDevT("预览：应用目录里的入口页（相对资源同源加载；已注入宿主桥 → 预览里也能调用 MTNode 的能力）") +
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
  /* 预览桥的只读态跟着「独立窗口开没开」走：主进程的窗口开关事件到点就回来，
     这条 1.2s 的轮询是兜底（事件缺席 / 漏一拍时状态也不会长期不一致）。 */
  appsDevBridgeSyncWindow().catch(() => {});
  /* 先补一次「本页没有在显示的会话」：本页这条会话在页面活着的时候被删 / 被截断时，
     appsDevViewBind 会把本页清回首轮态，而首次绘制那次自动选中不会再重跑 —— 补上它，
     右栏才不会停在「仅有引导、正文全空」的状态（见 appsDevEnsureCurrentSession）。 */
  appsDevEnsureCurrentSession();
  /* 会话工作区对齐（需求三）：每轮 tick 都按同一判据核一遍 ——
     点应用条目 / 打开开发页那两处只是把结果提前，真正的兜底在这里（开轮前一定核过；
     判据与写入口径见 appsDevAlignAppWorkspace）。 */
  appsDevAlignAppWorkspace(DEVD.appId).catch(() => {});
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
    /* 首轮态（该应用还没有会话）：底部那颗「工作区」芯片也要指着本页这个应用的目录 ——
       用户接下来写的第一轮需求，文件落点就是它（见 appsDevStartDevSession）。 */
    try {
      if (typeof agentViewBlankWorkspaceSet === "function")
        agentViewBlankWorkspaceSet(appsDevProjectDir());
    } catch (_) {}
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
  if (!appsDevPageOpen() || !DEVD.draft) {
    /* 非首轮态（这一发是某条已有会话的普通一轮）：开轮前兜一道 —— 该会话没填过工作区就
       立刻写成该应用目录（同步、不读盘）；「填过但目录没了」那一路由 tick 异步核。 */
    try {
      const st = DEVD.sessionId ? agentSessionById(DEVD.sessionId) : null;
      const dir = appsDevProjectDir();
      if (st && dir && !String(st.workspace || "").trim()) {
        st.workspace = dir;
        if (typeof persistAgentSession === "function") persistAgentSession().catch(() => {});
      }
    } catch (_) {}
    return false;
  }
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
    id && typeof appsLocalById === "function" ? appsLocalById(id, "dev") : null;
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
  /* 这一发就是那条新会话的首轮：点＋ 的意图到此兑现，不再挡「落回最近一条会话」的兜底
     （失败那条路也不留悬着的意图 —— 框里的字仍由 appsDevDraftPending 这道闸护着）。 */
  appsDevNewRoundClear();
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
  await agentTouchSession();
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

/* ── 版本合并会话（本轮需求）：主进程拉好的那一版 → 新建一条会话交给 Agent ─────────────
 *
 * 入口在应用中心那两处（renderer/app-apps.js 的 appsMergeStart 调这里，拉取成功之后）：
 *   ① 该应用有画布开发节点 → 走 createDevSessionForNode（与「开发」会话同一套归属：
 *      左栏该应用分组、工作区 = 应用目录、任务书随系统提示注入）；
 *   ② 没有开发节点 → 退成一条普通契约会话（agentContractSession）：工作区仍是应用目录，
 *      只把 appId 标上，左栏照样归到那个应用下。
 * 契约正文 = appsMergeContractText(pull)：两边的绝对路径 + 文件级差异清单 + 硬规则
 * （先 grill-me 拷问、用户确认前不动任何文件、不改版本号、app.json 只经结束声明、
 *  不自动上架、不做额外改动）。差异清单最多列 APPS_MERGE_LIST_MAX 条，其余只说个数 ——
 * 免得几百个文件把系统提示撑爆（清单只是索引，真要核自己扫目录）。
 */
const APPS_MERGE_LIST_MAX = 200;

/** 合并会话契约正文（整份随系统提示注入；用户消息位只留那一句关键输入）。 */
function appsMergeContractText(pull, appDir) {
  const p = pull || {};
  const their = p.their || {};
  const counts = p.counts || {};
  const author = String(their.author || "").trim() || appsDevT("对方");
  const lines = [];
  lines.push(appsDevT("【版本合并 · 这个会话干什么】把对方那一版合进本机开发目录：先对比差异，再用拷问逐项问过我，然后按我的选择改文件。合并**不修改版本号**（每位作者各算各的），也**不会自动上架**。"));
  lines.push(appsDevT("· 本机开发目录（要改的就是它）：") + String(appDir || p.dir || ""));
  lines.push(appsDevT("· 对方那一版（只读，一个字都不要改它）：") + String(p.srcDir || p.staging || ""));
  lines.push(
    appsDevT("· 对方：") + author + " · v" + String(their.version || "") +
      (String(their.note || "").trim() ? appsDevT(" · 版本说明：") + String(their.note) : ""),
  );
  lines.push(appsDevT("· 本机版本号（**这次不会改它**）：") + String(p.myVersion || ""));
  if (String(p.backupDir || "")) {
    lines.push(appsDevT("· 合并前整目录备份（要回滚就把它拷回开发目录）：") + String(p.backupDir));
  }
  lines.push(
    appsDevT("· 文件级差异清单（主进程已比过；add = 对方新增，diff = 两边都有但内容不同，same = 一致，local = 只有我有）：") +
      " 共 " + String(counts.add || 0) + " add / " + String(counts.diff || 0) + " diff / " +
      String(counts.local || 0) + " local / " + String(counts.same || 0) + " same",
  );
  const rows = (Array.isArray(p.files) ? p.files : []).filter((f) => f.kind === "add" || f.kind === "diff");
  for (const f of rows.slice(0, APPS_MERGE_LIST_MAX)) {
    lines.push("  - " + String(f.kind) + " " + String(f.rel) + (f.binary ? appsDevT("（二进制）") : ""));
  }
  if (rows.length > APPS_MERGE_LIST_MAX) {
    lines.push("  " + appsDevT("（另有 ") + (rows.length - APPS_MERGE_LIST_MAX) + appsDevT(" 个要处理的文件没列在这里，自己扫两边目录补齐）"));
  }
  lines.push("");
  lines.push(appsDevT("【必须按这个顺序来】① 先用 skill 工具加载内置技能 mtnode-app-merge，并严格照它执行；② 再加载 mtnode-grill-me，用 ask_user_question 一次问满整个前沿：每个 add / diff 都要问到「怎么覆盖」，外加一问「我这一版要不要跟着动」（默认不动）；③ **用户确认之前，不许改任何文件**；④ 确认之后自己改开发目录（文本用文件工具改，二进制与新增文件用 shell 拷贝）。"));
  lines.push(appsDevT("【硬规则】只按拷问结果覆盖差异，不做任何额外改动；「只有我有」的文件一律保留、不用问；不动 storage/、data.json、*.mtnodes 与备份目录；**不许直接改 app.json、不许改版本号**。"));
  lines.push(
    appsDevT("【收尾】把这次采纳的清单写进这个文件：") +
      String(p.staging || "") + "/.merge-done.json" +
      appsDevT("（形如 {\"done\":true,\"files\":[\"index.html\"],\"version\":\"\"}）。主进程见到它就补一条合并留痕并清掉暂存目录。version 留空 = 版本号不动；只有我在拷问里明确要「跟着动」时才填我要的新版本号。"),
  );
  lines.push(appsDevT("【不许做的事】不自动上架、不改画布、不动备份目录、不改对方那一版；合并结束前不要删暂存目录。"));
  return lines.join("\n");
}

/** 把这条合并会话摆到用户眼前：切到开发页 + 选中那个应用 + 右栏显示这条会话。 */
function appsDevShowMergeSession(appId, sess) {
  const id = String(appId || "");
  if (!id || !sess) return;
  try {
    if (typeof APPS_ST === "object" && APPS_ST) APPS_ST.nav = "dev";
    if (typeof appsDevSelectApp === "function") appsDevSelectApp(id);
    appsDevNewRoundClear();
    DEVD.draft = false;
    DEVD.sessionId = String(sess.id || "");
    DEVD.msgCount = Array.isArray(sess.messages) ? sess.messages.length : 0;
    appsDevRenderConv();
  } catch (_) {}
}

/** 拉取好的那一版 → 新建一条合并会话并立刻起轮（返回会话对象；建不起来回 null）。 */
async function appsDevStartMergeSession(pull, label) {
  const p = pull || {};
  const appId = String(p.appId || "").trim();
  if (!appId) return null;
  const appDir =
    String(p.dir || "") ||
    (typeof appsDevProjectDir === "function" ? String(appsDevProjectDir(appId) || "") : "");
  if (!appDir) return null;
  const their = p.their || {};
  const author = String(their.author || "").trim() || appsDevT("对方");
  const ver = String(their.version || "");
  /* 标题与「关键输入」都用**拉取回执里对方那一版**的作者 / 版本号（不是目录条目上的猜测值）：
     契约正文、暂存目录、差异清单、这条输入四份必须同源 —— 用户按这条输入核对的就是「合的是谁的那一版」。 */
  const title = appsDevTpl("合并 {author} v{version} 的差异", { author: author, version: ver });
  const kick = appsDevTpl("把 {author} v{version} 的差异按我逐项确认的结果合进本机", {
    author: author,
    version: ver,
  });
  const contract = appsMergeContractText(p, appDir);
  /* 该应用的画布与开发节点：与 appsDevEnsureNode 同一条链，但**不动 DEVD 的选中态** ——
     合并能从应用中心直接发起，此刻用户可能根本没停在开发页。 */
  let wf = null;
  let node = null;
  try {
    if (typeof wfOfCanvasIdForRun === "function") wf = await wfOfCanvasIdForRun(appId);
    if (wf && typeof appsDevNodeOfWf === "function") node = appsDevNodeOfWf(wf);
  } catch (_) {
    wf = null;
    node = null;
  }
  let sess = null;
  if (node && typeof createDevSessionForNode === "function") {
    /* agentWorkspace = 应用目录（dshWorkspaceOf 的 manual 分支优先）；建完再显式钉一次
       workspace —— 合并会话的文件落点只认「该应用在本机的那份目录」。 */
    sess = createDevSessionForNode(
      Object.assign({}, node, { agentWorkspace: appDir }),
      "dev",
      kick,
      contract,
    );
    if (sess) {
      sess.workspace = appDir;
      sess.title = title;
      sess.titleLocked = true;
      sess.titleAuto = false;
      sess.appId = appId;
      /* 会话 id 写进了节点（devSessionIds）→ 该应用的画布落盘（未必是前台那张） */
      if (wf) {
        try {
          if (typeof persistWf === "function") persistWf(wf);
        } catch (_) {}
      }
    }
  }
  if (!sess && typeof agentContractSession === "function") {
    sess = agentContractSession({
      title: title,
      contract: contract,
      kick: kick,
      workspace: appDir,
      allowCanvas: false,
      canvasWfId: wf ? String(wf.id || "") : "",
    });
    if (sess) sess.appId = appId;
  }
  if (!sess) return null;
  appsDevShowMergeSession(appId, sess);
  try {
    if (typeof agentTouchSession === "function") await agentTouchSession();
  } catch (_) {}
  try {
    if (typeof agentContractRound === "function") await agentContractRound(sess);
  } catch (_) {}
  void label;
  return sess;
}

/* ── 「＋ 新开发会话」的意图位（DEVD.newRound）───────────────────────────────
 *
 * 为什么需要单独记一位：「点＋」与「切到这个应用看一眼」在界面上落到**同一个状态**
 * （draft = true / sessionId = ""），但意图相反 —— 前者要在这个应用下**开一条新会话**，
 * 后者只是想看它最近一条会话。原先只靠「框里有没有字」（appsDevDraftPending）来区分，
 * 而刚点完＋的那一瞬框必然还是空的：于是三处兜底（1.2s 轮询的 appsDevEnsureCurrentSession、
 * 切应用的 appsDevSwitchAppRun、整页绘制的落点）都会当场把这个首轮态换成最近一条会话 ——
 * 用户点了＋却写不进新需求，表现就是「建不出第二条会话」。
 *
 * 所以把意图显式记下来：点＋置位（appsDevNewRound），
 *   ① 用户发出首轮（appsDevStartDevSession）即兑现 → 清除；
 *   ② 用户自己挑了一条会话（左栏会话行）或点了别的应用行身 → 清除（那是「看」，不是「新建」）。
 * 只在内存里，不进 config：重启 MTNode 后没有悬着的意图。
 */
function appsDevNewRoundOn() {
  return DEVD.newRound === true;
}
function appsDevNewRoundMark() {
  DEVD.newRound = true;
}
function appsDevNewRoundClear() {
  DEVD.newRound = false;
}
/* 「新开发会话」：回到首轮态 —— 下一次输入就在本应用下新建一条绑定会话。
   两个入口都走这一处：左栏应用行右端的「＋」（本轮需求，每行一个）与工具栏那颗「＋」。
   给了 appId 且不是当前应用 → 先按正常的换应用路径切过去（原地换：预览与右栏一起换），
   否则会出现「左栏指着 A、右栏却在 A 下建会话」的分家状态。
   意图位必须**在切应用之前**立起来：换应用那条路的落点会看这一位，
   否则它按老口径把刚点出来的首轮态换成该应用已有的最近一条会话。 */
function appsDevNewRound(appId) {
  const id = String(appId || "").trim();
  appsDevNewRoundMark();
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
  /* 只在这一个条件下报警：本机找不到这个应用的项目文件夹（会话工作区无从确定）。
     开发节点的「项目文件夹」与该应用当前目录**不一致**不再提示（本轮需求：移除该提示）——
     这条路上的会话工作区强制取应用目录（createDevSessionForNode 传 agentWorkspace），
     所以 devPath 与之一致不一致都不影响本轮跑在哪，提示只会造成误导。 */
  const appDir = appsDevProjectDir();
  appsDevPaintWarn(
    !appDir
      ? appsDevT("找不到这个应用在本机的项目文件夹：会话无法确定工作区（先把它装回来或修好 app.json）")
      : "",
  );
}

/* ── 顶部菜单条：一行 + 按宽度搬运进「更多 ▾」 ── */

/* 状态文字至少要留这么宽，否则继续往「更多」里收（窄到放不下时优先牺牲项，不牺牲可读性） */
const DEVD_STAT_MIN = 96;

/* 应用根目录（这条工具栏里的紧凑版）：路径 + 更改…；点路径 = 在资源管理器中打开。
   与库页共用同一份动作函数（app-apps.js 的 appsRootPickNow / appsRootFolderNow），不写第二份逻辑。
   **只给「项目根」这一枚**（本轮需求：开发页不出现下载根 —— 下载根是「库」的事，
   库页的下载根改成了左上角那枚「应用目录」按钮 + 小菜单；开发页关心的是自己开发的应用落在哪）。 */
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
  /* 「未设置」红字 badge **已随本轮需求删除**：根目录默认就在画布所在的数据目录下
     （<数据目录>/apps-dev），主进程列应用时把默认路径固化下来，这里永远有一个可用路径 ——
     不再有「未设置：开发中的应用不会列出来」这个状态。 */
  box.appendChild(
    appsMiniBtn(appsDevT("更改…"), () => {
      if (typeof appsRootPickNow === "function") appsRootPickNow(kind);
    }),
  );
  return box;
}
/* 这一组里只有项目根（下载根在库页，见 appsDevRootChip 注释） */
function appsDevRootItem() {
  const box = document.createElement("span");
  box.className = "apps-dev-roots";
  box.appendChild(appsDevRootChip("dev"));
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
    (a) =>
      a &&
      (typeof appsLocalRootKind === "function" ? appsLocalRootKind(a) === "dev" : a.dev === true),
  );
  /* 进开发页时选哪个应用：appsDevPickApp（本页当前选中的 > 上次打开过的 > 名单第一个）。
     这样从别处回开发页不会出现「没选中应用」的空页。 */
  let cur = appsDevPickApp(apps);
  const switched = cur !== String(DEVD.appId || "");
  if (switched) {
    /* 换应用 = 新的一页上下文：会话归属 / 预览 / 快照全部重来 */
    DEVD.appId = cur;
    /* 点＋ 的意图只对「点它的那个应用」有效：这里是页面自己换了应用（当前选中不在名单里
       之类的路），意图一并作废，别让下一个应用也被挡在「落回它最近一条会话」之外。 */
    appsDevNewRoundClear();
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
    /* 打开开发页那一下也按同一判据对齐工作区（需求三）：三处触发点之一。 */
    appsDevAlignAppWorkspace(cur).catch(() => {});
  }
  DEVD.seq++;
  const mySeq = DEVD.seq;

  const wrap = document.createElement("div");
  wrap.className = "apps-dev";

  /* 顶部菜单条：**只允许一行**（.apps-dev-head 是 nowrap）。宽了主行多放，窄了自动把
     优先级最低的几项搬进「更多 ▾」——功能一个不少，只是位置随宽度变：
     ＋新开发会话 / 启动 / 打开画布 / 卸载 / 刷新预览 / 项目根 / 数据目录 /
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
       不在按钮层面藏功能 —— 用户看得见这条路，才知道能上架。
       本轮需求：**应用上架统一叫「上架」**，新上传（云端新建一条）与更新（往云端已有那条
       追加一版）都叫上架 —— 按钮不再按本机上架留痕切成「更新 / 上架」两套文案。
       新建还是追加由服务端按 id + 作者 uid 判定，结果在发布浮层里如实写清（「新建应用」/
       「追加版本」），按钮这一层不必替用户分辨。 */
    head.appendChild(
      addSlot(
        2.5,
        (() => {
          const b = appsMiniBtn(appsDevT("上架"), () => {
            if (typeof window.openAppPublish !== "function") {
              appsDevToast(
                appsDevT("上架模块未就绪（renderer/app-publish.js 未加载）"),
                "err",
              );
              return;
            }
            window.openAppPublish(DEVD.appId);
          });
          b.title = appsDevT("上架：把这个应用传到云端（已上架过就是给同一条追加一版）");
          b.setAttribute("aria-label", appsDevT("上架"));
          return b;
        })(),
      ),
    );
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
            typeof appsLocalById === "function" ? appsLocalById(DEVD.appId, "dev") : null;
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
  head.appendChild(addSlot(5, appsDevRootItem(), "项目根"));
  /* 「数据目录」：打开**当前这个应用**的数据文件夹（默认 <数据目录>/apps-data/<id>/，
     用户改过数据文件夹则是他选的那个）—— 与库页每张卡片右侧那颗 📂 同一个动作
     （renderer/app-apps.js 的 appsDataOpenNow，路径只由主进程解析）。pri=5.5 = 紧挨
     应用根目录；没有选中的本机应用时不给点。 */
  if (DEVD.appId && apps.some((a) => String(a.id || "") === DEVD.appId)) {
    const dirBtn = appsMiniBtn(appsDevT("数据目录"), () => {
      if (typeof appsDataOpenNow === "function") appsDataOpenNow(DEVD.appId, "dev");
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
          const app = typeof appsLocalById === "function" ? appsLocalById(DEVD.appId, "dev") : null;
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
          const app = typeof appsLocalById === "function" ? appsLocalById(DEVD.appId, "dev") : null;
          if (typeof appCapabilitiesDialog === "function")
            appCapabilitiesDialog(
              DEVD.appId,
              String((app && app.name) || DEVD.appId || ""),
              /* kind=dev：改的是**项目根那一份**的能力位（同 id 在下载根也有时别写错副本） */
              { kind: "dev" },
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
        /* 用户点名了一条会话（哪怕是别的应用下的）= 他要看这条，不是要新建：
           清掉点＋ 立下的意图位，别让它挡着本页落回这条会话。 */
        appsDevNewRoundClear();
        DEVD.draft = false;
        DEVD.sessionId = sid;
        DEVD.msgCount =
          st0 && Array.isArray(st0.messages) ? st0.messages.length : 0;
        appsDevRenderConv();
        appsDevEnsureCurrentSession();
        return;
      }
      appsDevNewRoundClear(); /* 同上：自己挑会话 = 不新建了 */
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
  /* 「关掉独立窗口」（本轮需求）：只在预览因该应用已在独立窗口运行而**只读**时露出 ——
     关掉它，预览立刻恢复可写（状态由主进程的窗口开关事件实时回来）。 */
  const bridgeCloseBtn = document.createElement("button");
  bridgeCloseBtn.type = "button";
  bridgeCloseBtn.className = "mini apps-dev-bridgeclose";
  bridgeCloseBtn.hidden = true;
  bridgeCloseBtn.textContent = appsDevT("关掉独立窗口");
  bridgeCloseBtn.title = appsDevT(
    "该应用已在独立窗口运行，预览为只读 —— 点这里关掉它，预览就恢复可写",
  );
  bridgeCloseBtn.onclick = (ev) => {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    appsDevCloseOwnWindow();
  };
  viewHead.appendChild(bridgeCloseBtn);
  DEVD.bridgeCloseBtn = bridgeCloseBtn;
  /* 文件夹按钮（本轮需求）：预览列头最右那一枚 —— 点它进这个应用的文件夹（应用目录）。
     常驻不藏（没选中应用时点了给一句提示），与「关掉独立窗口」同一处右端对齐。 */
  viewHead.appendChild(appsDevFolderBtnEl());
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
    /* 这一帧换页了：先给新页登记预览租约（旧帧那条随之作废），再写回状态。
       _host=1 由重载那条链带上；首帧挂的兜底 url 也带（见 appsDevPreviewUrlFallback）。 */
    appsDevBridgeRegister().catch(() => {});
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
    /* 「项目根丢了 → 一键恢复候选目录」那一行**已随本轮需求删除**：根目录默认就在画布所在的
       数据目录下（<数据目录>/apps-dev），主进程列应用时把默认路径固化下来，不存在「没配 =
       整列消失」这个状态；真有应用躺在别处，走上面「项目根 … 更改…」指过去。 */
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
     换成会话就会把它从眼前顶掉（与 appsDevEnsureCurrentSession 同一道闸）。
     点过＋（DEVD.newRound）时同样不落：那个首轮态正是用户要的新会话。 */
  if (DEVD.draft && !DEVD.sessionId && !appsDevNewRoundOn() && !appsDevDraftPending()) {
    const sess =
      typeof appSessionsOf === "function" ? appSessionsOf(DEVD.appId)[0] : null;
    if (sess) {
      DEVD.draft = false;
      DEVD.sessionId = sess.id;
      DEVD.msgCount = Array.isArray(sess.messages) ? sess.messages.length : 0;
      /* 右栏要显示这条 = 由 appsDevRenderConv 的显示覆盖绑定，不动会话页的选中项。
         这里只是「看」它一眼（没有改任何东西）→ 走 quiet flush：绝不盖 updatedAt，
         否则进一次开发页就把这条会话顶到左栏最前 + 行尾刷成「刚刚」。 */
      try {
        if (typeof agentFlushSessionSaveQuiet === "function") await agentFlushSessionSaveQuiet();
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
  /* 切到该应用那一下就把工作区对齐（需求三）：该应用名下工作区为空 / 已失效的会话，
     立刻改指该应用目录；目录还在的（用户自己选的）一个字不动。异步，不挡切换。 */
  appsDevAlignAppWorkspace(id).catch(() => {});
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
     免得右栏在上一个应用的会话内容上多停一次 IPC 的工夫。
     点过＋（DEVD.newRound）时不落 —— 那一趟是「去那个应用开一条新会话」，落到它已有的
     最近一条就把刚点出来的首轮态顶掉了（与 appsDevEnsureCurrentSession 同一道闸）。 */
  if (DEVD.draft && !DEVD.sessionId && !appsDevNewRoundOn() && !appsDevDraftPending()) {
    const sess =
      typeof appSessionsOf === "function" ? appSessionsOf(DEVD.appId)[0] : null;
    if (sess) {
      DEVD.draft = false;
      DEVD.sessionId = sess.id;
      DEVD.msgCount = Array.isArray(sess.messages) ? sess.messages.length : 0;
      try {
        if (typeof agentFlushSessionSaveQuiet === "function") await agentFlushSessionSaveQuiet();
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
/* 版本合并会话：应用中心那两处入口拉到对方那一版之后调它（见 appsDevStartMergeSession） */
window.appsDevStartMergeSession = appsDevStartMergeSession;
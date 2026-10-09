"use strict";
/* renderer/app-apps.js — 应用中心（顶栏「应用」）+ 本机应用库 + 开发者面板
 * ============================================================================
 * 一页三栏（Microsoft Store 式），全部落在**主窗口内的整屏浮层页**（#appsHub，
 * 挂在 document.body 上 · position:fixed inset:0 · **连顶栏一起盖住**），不是 #overlay 弹窗：
 *   · 应用：读云端目录（http://mt-agent.com/mtnode/apps/catalog.json，主进程 apps-store.js
 *     拉取并缓存到 <数据目录>/apps-cache/catalog.json → 离线也能看），列出云端应用
 *     （图标 / 标题 / 版本 / 描述），可看详情、可下载（zip + sha256 校验 + 解包到
 *     「应用根目录/<AppName>/」都由主进程做）；根目录**不再要求用户手选**（本轮需求）：
 *     默认就是画布所在的数据目录下的 apps（下载）/ apps-dev（开发），由主进程在列应用 / 下载 /
 *     新建时把默认路径固化进 config.json，所以下载前不会再有选目录框；
 *     同名目录已存在 → 三态（覆盖 / 改名 / 取消）。
 *   · 库：本机**还没在开发**的应用（图标 / 标题 / 作者 / 版本 / 大小），
 *     可打开（独立窗口启动）、更新（版本比较）、📂 打开它的数据目录、
 *     「二次开发」（登记为开发中 + 建同名画布与开发节点；该应用带 app.json 的 dev:true
 *     后就不再列在本页）、卸载（二次确认后**只删该应用子文件夹**）。
 *   · 开发：开发中的应用（带 dev:true 的：新建的 + 从库迁移来的）+ 三栏开发台与应用根目录
 *     （见 app-apps-dev.js）。**本轮移除**页脚那个「更多：导出应用包 / 变更探测 / 开发绑定」
 *     折叠块 —— 三栏开发台是这一页唯一的正文，工具区不再在页面上留入口。
 *
 * 名单与身份口径（本轮，docs/apps-market.md §八）：
 *   · 「开发中」真源 = app.json 的 dev:true：库页只列非开发中的，开发页只列开发中的，两边不重叠；
 *     存量应用由主进程一次性回填（没有 installed.json 安装账本 = 自己新建的 → dev:true）。
 *   · 作者：云端条目取 owner（上架账号），本机取 app.json.author，空则回落当前登录账号（未登录不显示）。
 *   · 应用身份 = 应用 id + 作者 uid（uid 只在内部判定用）；同源（forkOf）条目 = 同一应用的多个分支。
 *   · 上架留痕（app.json 的 cloud）：记住这个应用是从哪个云端 id / 哪个账号上架上去的 ——
 *     上架窗据此定「下次默认锁定的云端 id」与离线时的线上状态回落（见 appsPublishTraceOf）。
 *     应用上架统一叫「上架」（新上传与更新同一说法），留痕不再用来在两套按钮文案之间切。
 *   · 卡片按钮随状态：未装 = 下载；已装 = 启动；同作者有新版本 = 更新；
 *     同 id 有多个作者分支（§十）= 合并成一张卡 + 「看分支（N）」→ 详情里的分支树。
 *   · 校验值（sha256）与其余技术字段收进「ⓘ 校验」小按钮 + 默认折叠的「开发者信息 ▾」。
 *
 * 桥（preload.js 白名单，全部只转发给主进程 apps-store.js）：
 *   api.appsRootGet / appsRootSet / appsRootPick / appsList / appsCatalog /
 *   appsInstall(id, mode) / appsUninstall(id) /
 *   appsOpenWindow(id) / appsCloseWindow() / appsIsOpen(id) / appsSetMeta(id, patch) /
 *   appsDataOpen(id)（在资源管理器里打开该应用的数据目录，见下方「数据目录」一节）/
 *   onAppsProgress(cb) / onAppsWindowChanged(cb)
 * 渲染层不直连网络、不拼应用目录路径、不自己做 zip / sha256 —— 那些只留主进程。
 * （appsExportZip / appsProbeChanges 仍在 preload 白名单里，走它们的是上架流程
 *   renderer/app-publish.js 与主进程 apps-store.js；本页本轮不再有这两个入口。）
 *
 * 顶栏入口 #btnApps 对**所有已登录账号**露出（原白名单常量已去掉）：登录态唯一来源
 * = window.MTNodeAuth.state()（统一账户模块 app-auth.js）；本文件按调用期探测订阅，
 * 未就绪 / 未登录一律隐藏；登录态变化时同步显隐（退出登录时连页面一起收掉）。
 *
 * 对话框纪律（AGENTS.md「协作约定」）：本页 persistent —— **没有**「点外部 / 点蒙层自动收起」；
 * 关闭只走三处：正文顶部第 1 行最右的「返回 MTNode」、Esc、再点一次顶栏「应用」（同一开关）。开着它时点顶栏任何
 * 其它入口（画布 / 会话 / 专家团 / 设置 / 插件 / 工坊…）＝ 收掉本页（互斥回收），
 * 开页瞬间也会收掉节点级浮层与瞬态菜单（closeNodePopsExcept）。#overlay 的 z-index 比本页高，
 * 后开的对话框（设置 / 确认框）一定压在本页之上，本页不去顶掉它们。
 * ============================================================================
 */

/* ───────────────────────── 常量 ───────────────────────── */

/* 顶栏「应用」入口的可见口径：**所有已登录账号**都能看到应用中心与应用开发（原白名单
   常量 ["ms2308"] 已去掉）。未就绪 / 未登录一律隐藏；登录态变化时
   同步显隐（退出登录时连页面一起收掉）。上架不吃客户端门禁：服务端按当前登录账号绑 owner
   并强制账号配额（store-saas/server.mjs 的 appQuotaError）。 */

/* 左导航（顺序即显示顺序）：[id, 标题, 副标题] */
const APPS_NAV = [
  ["apps", "应用", "浏览云端目录 · 下载到本机后用独立窗口运行"],
  ["mine", "我的应用", "我上架到云端的应用：编辑信息 · 删除"],
  ["lib", "库", "本机已下载的应用：打开 · 更新 · 卸载"],
  ["dev", "开发", "应用根目录 · 三栏开发台 · 实时预览"],
];

/* 目录缓存新鲜期（毫秒）：这段时间内重开页面 / 切页不重复拉云端目录 */
const APPS_CAT_TTL = 5 * 60 * 1000;

/* 「云端答了、就是 0 条」原来在页头有一句实话（APPS_CAT_EMPTY_HINT）：
   随页头那条目录状态行一起**整条移除**（2026-10，用户口径：有目录就直接用，界面不再解释目录来源）。
   这件事现在只由空态说 —— 见 appsPaintAppsPage 里的 appsPaintEmpty("empty")：文案仍是
   「云端目前没有可上架的应用（目录为空，不是网络问题）」，只是不再在页头重复第二遍。 */

/* 搜索框防抖（毫秒）：输入框**不在**每次重绘的正文里（见 appsHubTopbar），所以打字
   「不丢焦点」与「不每敲一个字重排整页」是两件事——前者靠 DOM 不入正文，后者靠这个闸。
   180ms 够短（手感跟手），又足以把连续输入合并成一次重绘。 */
const APPS_SEARCH_DEBOUNCE = 180;

/* 标签条最多列几枚（多的只计数；选中过的标签一定保留在条上，否则一选就滚没了） */
const APPS_TAG_MAX = 16;

/* 打赏汇总（卡片金币 icon 的悬停文案）的新鲜期：这段时间内重绘不再重复问服务端。
   比目录 TTL（5 分钟）短得多 —— 刚打赏完的用户会立刻回来看这一页。 */
const APPS_TIPS_TTL = 45 * 1000;

const APPS_ST = {
  nav: "apps", /* apps | lib | dev */
  q: "", /* 应用页的搜索词 */
  tags: [], /* 标签筛选：选中的标签（OR 口径，空 = 不按标签筛） */
  cat: null, /* 云端目录响应（含 apps / source / sourceUrl / remoteError） */
  catAt: 0,
  list: null, /* 本机应用列表响应 */
  root: null, /* { path, configured, exists } */
  progress: Object.create(null), /* id -> { phase, percent, got, total, error } */
  busy: Object.create(null), /* id -> true：本机正在下载 / 安装 */
  conflictAsk: null, /* 同名冲突框的收尾函数（Esc 走它） */
  /* 作者视角的线上条目（§七）：公开静态目录不一定带上作者自己那一条，登录后另拉一次
     GET /api/apps?owner=<自己>，把 mine / 版本树合并进来（作者看自己那条只靠 owner 过滤） */
  mine: null, /* { ok, at, byId: { <id>: item } } */
  mineAt: 0,
  /* 「我的应用」页（第 4 页）的分页累积：**只装我自己那条分支**（接口 owner= 过滤）。
     与上面那份 byId 归并表同源（byId 由这里现算），所以卡片上的 mine 标记与这一页永远一致。 */
  minePage: null, /* { ok, at, page, pageSize, total, items: [] } */
  mineBusy: false,
  /* 打赏汇总（GET /api/tips/summary 的批量回执）：byId = { <应用id>: {count,totalYuan} }。
     为什么要另拉一次：卡片走的是**静态目录** catalog.json（老目录带 tips、老客户端拿不到），
     列表页用这一个接口一次问齐整页，悬停文案就不会再出现「线上有人打赏、卡片说没人打赏」。 */
  tips: null, /* { ok, at, byId, ids:Set, count } */
  tipsAt: 0,
  tipsBusy: false, /* 正在问服务端（悬停文案显示「正在读取打赏数据…」而不是谎报无人打赏） */
  tipsFailed: false, /* 上一次问失败（未登录 / 断网 / 5xx）：文案说「暂未取到」，金币 icon 照旧可点 */
  tipsAsked: "", /* 上一次问过的 id 集合签名（同一批不再重问，避免重绘 → 再问 → 再重绘） */
  tipsErr: "",
  seq: 0, /* 渲染序号：异步回来时对不上就丢弃（防切页后旧数据重绘） */
};

let APPS_HUB_OPEN = false;
let APPS_LANG = "";
let APPS_AUTH_OFF = null;
let APPS_PROG_OFF = null;
/* 搜索框防抖句柄（每次打开 / 关闭本页都清一次，见 openAppsHub / appsHubClose） */
let APPS_SEARCH_TIMER = 0;
/* 「刷新」（顶部那颗环形箭头按钮 / F5 / Ctrl+R）是否正在跑：防重入（见 appsHubReloadNow）——
   连点几下只打一次网络，且按钮在跑的时候是 disabled + .on（转圈） */
let APPS_RELOAD_BUSY = false;

/* ── 应用开发界面「三栏」栏宽：夹取 / 应用 / 绑定把手 ──
   需求口径：开发界面里会话的左 / 中 / 右三栏（左 = 会话列表 · 中 = 预览 · 右 = 会话正文）
   允许互相调整宽度，并设合理的最小 / 最大值。
   **左导航（.apps-hub-side）不参与** —— 它是整页的固定 176px 导航，不是「边栏之间」，
   拖它只会把导航栏与正文一起挤变形（本轮按用户反馈去掉）。
   把手 9px 宽、绝对定位在栏边缘（与 #agentSideResize / #assistResize 同观感，不占 grid 空间）。
   夹取口径一处写死：三栏每栏最小 240px、上限 = 容器宽的一半（容器 = .apps-dev-cols 实测宽，
   不是窗口宽 —— 左侧还有固定 176px 导航与 .apps-hub-body 的内边距，拿窗口宽当上限必然超出去）；
   另钉「三栏总宽不得溢出容器」：窄窗口下从右栏开始收，收不动再收左栏。
   **落盘值（S.appsDevSideW / S.appsDevConvW）与写进布局的值在这里分开**：
   落盘存「用户要的宽度」（夹在 240 … 半容器之间），布局写「按当前容器宽贴合后的宽度」
   （appsDevFitCols）。以前两个 CSS 变量直接写落盘原值，窗口比拖宽时小 / 首次打开时
   右栏会被挤出容器右缘 —— 会话列表在左栏好好的，右栏正文整块看不见（用户报的
   「左栏能选会话，右栏正文空白」）。 */
const APPS_DEV_COL_W_MIN = 240; /* 三栏每栏最小宽（左会话 / 中预览 / 右正文同一口径） */
const APPS_DEV_COL_GAP = 8; /* .apps-dev-cols 的 gap（与 app-apps-dev.js 同一口径） */

/* 三栏所在容器（开发页还没画过时按选择器找；找不到 = 0 = 这一步不写布局，留给布局定下来那次） */
function appsColsBoxW() {
  let el = null;
  try {
    if (typeof DEVD === "object" && DEVD && DEVD.colsEl && document.contains(DEVD.colsEl))
      el = DEVD.colsEl;
  } catch (_) {}
  if (!el) el = document.querySelector(".apps-dev-cols");
  return el ? Math.max(0, el.clientWidth) : 0;
}
/* 夹取用的容器宽：量得到就用实测的 .apps-dev-cols，量不到（还没画过 / 量不到宽）
   退回窗口宽 —— 与旧口径「上限 = 窗口宽 50%」等价，启动早期函数仍可用。 */
function appsColsBoxOrWinW() {
  const box = appsColsBoxW();
  if (box > 0) return box;
  const win = Number(window.innerWidth) || 0;
  return win > 0 ? win : 1200;
}
/* 每栏上限：容器宽的一半（窄到比最小宽还小时以最小宽为准；容器量不到时按窗口宽算） */
function appsColsHalfW(boxW) {
  const box = Number(boxW) > 0 ? Number(boxW) : appsColsBoxOrWinW();
  return Math.max(APPS_DEV_COL_W_MIN, Math.floor(box / 2));
}
function appsColsWDef(kind) {
  const k = String(kind || "");
  const n = Number(k === "conv" ? S.appsDevConvW : S.appsDevSideW);
  return n > 0 ? n : 0;
}
/* 只做夹取（不落盘）：kind = side（左会话栏）/ conv（右正文栏） */
function clampAppsColsW(kind, w) {
  const raw = w == null ? 0 : Number(w);
  const n = Math.round(raw > 0 ? raw : appsColsWDef(kind));
  if (!(n > 0)) return APPS_DEV_COL_W_MIN;
  return Math.max(
    APPS_DEV_COL_W_MIN,
    Math.min(appsColsHalfW(appsColsBoxW()), n),
  );
}
/* 容器宽贴合（不落盘）：期望的一对宽度 → 写进布局的一对宽度。
   ① 先按「每栏 240 … 半容器」夹一次；
   ② 再保三栏都在容器内：中栏（预览）保住 240px 后右栏吃剩下的，还不够才收左栏。
   返回恰好与 .apps-dev-cols 的 grid 同宽的 { side, view, conv }（view 只用于核对，不写变量）。 */
function appsDevFitCols(sideW, convW, boxW) {
  const box = Number(boxW) > 0 ? Number(boxW) : appsColsBoxW();
  const total = Math.max(0, box);
  const GAP = APPS_DEV_COL_GAP;
  const MIN = APPS_DEV_COL_W_MIN;
  const half = appsColsHalfW(box);
  const want = (v) => {
    const raw = Number(v);
    if (!(raw > 0)) return MIN; /* 0 / 空 =「还没定」→ 默认最小宽，交由调用方按等分先算好 */
    return Math.max(MIN, Math.min(half, Math.round(raw)));
  };
  let side = want(sideW);
  let conv = want(convW);
  /* 让左侧会话栏与它右边的两栏都留在容器内：先把 side 收到「容器 − 中栏 240 − 右栏 − 2*gap」 */
  const sideMax = total - MIN - conv - GAP * 2;
  if (sideMax < side) side = Math.max(MIN, sideMax);
  /* 右栏还超（容器太窄 / 旧落盘值过大）→ 从右栏收，收不动再看左栏 */
  let over = side + MIN + conv + GAP * 2 - total;
  if (over > 0) {
    const cut = Math.min(over, Math.max(0, conv - MIN));
    conv -= cut;
    over -= cut;
    if (over > 0) side = Math.max(MIN, side - over);
  }
  const view = Math.max(0, total - side - conv - GAP * 2);
  return { side: side, conv: Math.max(0, conv), view: view };
}
function appsColsSave() {
  if (!S.config) return;
  S.config.appsDevSideW = S.appsDevSideW;
  S.config.appsDevConvW = S.appsDevConvW;
  try {
    window.api.configSave(S.config).catch(() => {});
  } catch (_) {}
}
/* 开发页三栏宽度：写进 .apps-dev-cols 上的两个变量（中栏 = 1fr 自动吃剩余，
   appsDevFitCols 已把「三栏都在容器内」算清）。落盘仍按用户要的那对值。 */
function applyAppsDevCols(sideW, convW, persist) {
  S.appsDevSideW = clampAppsColsW("side", sideW == null ? S.appsDevSideW : sideW);
  S.appsDevConvW = clampAppsColsW("conv", convW == null ? S.appsDevConvW : convW);
  const boxW = appsColsBoxW();
  if (boxW > 0) {
    const fit = appsDevFitCols(S.appsDevSideW, S.appsDevConvW, boxW);
    const cols =
      typeof DEVD === "object" && DEVD && DEVD.colsEl && document.contains(DEVD.colsEl)
        ? DEVD.colsEl
        : document.querySelector(".apps-dev-cols");
    if (cols) {
      cols.style.setProperty("--apps-dev-side-w", fit.side + "px");
      cols.style.setProperty("--apps-dev-conv-w", fit.conv + "px");
    }
  }
  if (persist !== false) appsColsSave();
}
/* 左导航（.apps-hub-side）是整页导航、固定 176px，不在这里也不可拖宽（见 app-apps.js 顶部注释） */
window.clampAppsColsW = clampAppsColsW;

/* ───────────────────────── 小工具 ───────────────────────── */

function appsHubEl() {
  return document.getElementById("appsHub");
}
function appsHubIsOpen() {
  return !!APPS_HUB_OPEN;
}

/* 需求：「把画布的 footer 也放进应用界面」。#appsHub 是 position:fixed 的整屏浮层，
   以前 inset:0 连 footer.statusbar 一起盖住 —— 状态栏最左那枚全局语音话筒 🎤 因此在应用中心
   里既看不见也点不到。这里把浮层下沿抬到状态栏上沿（写 CSS 变量 --apps-hub-foot，规则在
   css/apps.css 的 .apps-hub），footer 原样露在下面：话筒、画布截图、缩放 / 保存态都照旧可用，
   全局语音识别出的文字仍写进当前 focus 的输入框（开发页的输入框也一样）。
   高度实测（字号 / 主题 / 状态栏内容变了都跟着走）；量不到就退回 0 = 盖满，等于改动前的行为。 */
let APPS_FOOT_GAP_HOOKED = false;
function appsHubFootGap() {
  const host = appsHubEl();
  if (!host) return 0;
  let px = 0;
  try {
    const sb = document.querySelector("footer.statusbar");
    const r = sb && sb.getBoundingClientRect ? sb.getBoundingClientRect() : null;
    /* 上取整：宁可多留 1px 缝，也不让浮层压掉状态栏最上一行像素 */
    if (r && r.height > 0) px = Math.ceil(r.height);
  } catch (_) {}
  if (px > 0) host.style.setProperty("--apps-hub-foot", px + "px");
  else host.style.removeProperty("--apps-hub-foot");
  return px;
}
/* 窗口尺寸 / 字号变了要重算：只在页开着的时候跑，页关着时什么都不做 */
function appsHubFootGapHook() {
  if (APPS_FOOT_GAP_HOOKED) return;
  APPS_FOOT_GAP_HOOKED = true;
  try {
    window.addEventListener("resize", () => {
      if (APPS_HUB_OPEN) appsHubFootGap();
    });
  } catch (_) {}
}
/* 与 I18n 未就绪时同一口径：拿不到模块就原样回显中文（不报错、不缺字） */
function appsT(s) {
  return window.I18n && window.I18n.t ? window.I18n.t(s) : String(s == null ? "" : s);
}
function appsEscape(s) {
  return typeof esc === "function" ? esc(s) : String(s == null ? "" : s);
}
function appsBytes(n) {
  if (typeof fmtBytes === "function") return fmtBytes(n);
  return n == null ? "" : String(n) + " B";
}
function appsTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return "";
  const en = window.I18n && I18n.getLocale && I18n.getLocale() === "en";
  try {
    return new Date(n).toLocaleString(en ? "en-US" : "zh-CN");
  } catch (_) {
    return "" + new Date(n);
  }
}
function appsMiniBtn(label, onclick, primary) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = primary ? "mini primary" : "mini";
  b.textContent = label;
  b.onclick = (ev) => {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    onclick();
  };
  return b;
}
function appsToast(msg, kind) {
  if (typeof toast === "function") toast(msg, kind || "ok");
}
/* 「运行」= 让主进程为这个应用开独立窗口（apps-store.js 的 openAppWindow：
   BrowserWindow + preload-app.js → loadFile 应用目录里的 index.html）。库页（本机 / 目录
   卡片）与开发页（选中的那个应用）共用这一个按钮口径：data-app-run 标记 + 稳定 title，
   库页的打开态回贴（appsPaintLibPage 的收尾循环）按它定位。 */
function appsRunBtnEl(id, label, onclick) {
  const b = appsMiniBtn(label, onclick, true);
  b.dataset.appRun = "1";
  b.id = "appsRunBtn-" + String(id || "");
  b.title = appsT("在独立窗口里运行这个应用");
  return b;
}

/* 「运行」的**图标**形态（封面卡右下角那一排用它）：
   同一个按钮对象（复用 appsRunBtnEl → 同一份 data-app-run / id / title / 点击出口），
   只把文字换成 play 图标 —— 库页的「窗口已开着」回贴与离屏重画都按 data-app-run 找得到它。
   窗口化渲染后卡片是滚动时才建的，所以打开态必须**画卡的时候就带上**（open=true），
   不能再靠画完之后逐张回贴。 */
function appsRunIcoBtnEl(id, open) {
  const b = appsRunBtnEl(id, "", () => appsOpenApp(id));
  b.textContent = "";
  b.classList.add("apps-ico-btn", "apps-ico-play");
  appsIcoInto(b, "play");
  b.setAttribute("aria-label", appsT("在独立窗口里运行这个应用"));
  if (open) {
    b.classList.add("on");
    b.title = appsT("这个应用已经开着独立窗口（再点一次把它调到前台）");
  }
  return b;
}

/* ─────────── 封面右下角那一排小图标按钮（本轮需求：卡上只留三枚小图标）───────────
 * 卡片的动作行收掉之后，卡上只剩这三枚：下载/更新、ⓘ 详细、金币打赏。
 * 图标一律取这里的 APPS_ICO_SVG（内联 SVG，stroke=currentColor 跟着主题走），与顶栏那批
 * 线性图标同一风格；**不带文案**，用途全在 title / aria-label 上。 */
const APPS_ICO_SVG = {
  download:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8"/><path d="M4.6 7.4 8 10.8l3.4-3.4"/><path d="M2.6 13.4h10.8"/></svg>',
  play:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 2.8v10.4l8.2-5.2z"/></svg>',
  /* 「我的应用」卡片上的编辑 / 删除两枚（本轮新增；下架·重新发布已随功能移除，图标仍在表里）。
     与上面两枚同一份口径：内联 SVG、stroke=currentColor、16 viewBox。 */
  edit:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.1 2.4 13.6 4.9 5.9 12.6 2.6 13.4l.8-3.3z"/><path d="M9.6 3.9l2.5 2.5"/></svg>',
  eyeoff:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l12 12"/><path d="M6.3 6.4A3 3 0 0 0 8 11c.8 0 1.6-.3 2.1-.9"/><path d="M4.2 4.4C2.9 5.4 2 6.7 1.6 8c1 2.6 3.6 4.3 6.4 4.3 1.2 0 2.3-.3 3.3-.8"/><path d="M12.6 10.6c.7-.7 1.3-1.6 1.6-2.6-1-2.6-3.6-4.3-6.4-4.3-.5 0-1 .1-1.5.2"/></svg>',
  eye:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 8c1-2.6 3.6-4.3 6.4-4.3S13.4 5.4 14.4 8c-1 2.6-3.6 4.3-6.4 4.3S2.6 10.6 1.6 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 4.4h10.4"/><path d="M6.4 4.4V2.8h3.2v1.6"/><path d="M4.2 4.4l.7 8.4h6.2l.7-8.4"/><path d="M6.8 6.8v4"/><path d="M9.2 6.8v4"/></svg>',
  /* 「刷新」（本轮新增）：环形箭头 + 缺口处的箭头尖 —— 应用中心顶部第 1 行那颗
     手动重拉入口（#appsHubReload）用，与上面几枚同一份口径（内联 SVG、16 viewBox、
     stroke=currentColor 跟着主题走）。 */
  refresh:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33"/><path d="M14 2v3.33h-3.33"/></svg>',
  /* 「应用目录」（本轮新增）：库页左上角紧挨刷新那一枚 —— 点它弹小菜单改下载根。
     箱盖 + 箱体两段路径，与上面几枚同一份口径（内联 SVG、16 viewBox、stroke=currentColor）。 */
  folder:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 12.6V3.9h4.1l1.5 1.7h6.8v7z"/><path d="M1.8 6.6h12.4"/></svg>',
};
/** 把图标 SVG 直接塞进按钮（不套一层 span）：按钮自身的 data-* / id / 点击监听才是唯一可点目标。 */
function appsIcoInto(btn, kind) {
  btn.innerHTML = APPS_ICO_SVG[kind] || "";
  return btn;
}
/** 封面上的图标按钮：同一套小方框（.apps-ico-btn），点了只做自己的事、不冒泡到「点卡开详情」。 */
function appsIcoBtnEl(kind, title, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini apps-ico-btn apps-ico-" + kind;
  appsIcoInto(b, kind);
  b.title = title || "";
  b.setAttribute("aria-label", title || "");
  b.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onclick();
  };
  return b;
}
/* 「详细」那一枚 ⓘ 图标按钮：**本轮已按用户口径摘掉**（应用中心与库页封面都不再有它）——
   理由：点卡片本身就是打开详情窗，两者用途完全一样，多一枚纯属重复。
   现在开详情的路只有一条：点卡片（整卡可点 + Enter / 空格）。这个函数留在原地不删，
   是为了让**上架窗 / 卡片路径之外**的调用方（第三方脚本按名字探测）不至于拿到 undefined。 */
function appsDetailBtnEl(id, label) {
  const text = label ? appsT(label) : "ⓘ";
  const b = appsMiniBtn(text, () => {
    if (typeof window.openAppsDetail === "function") window.openAppsDetail(id);
  });
  b.classList.add("apps-ico-btn", "apps-ico-info");
  b.dataset.appDetail = "1";
  b.title = appsT("单开一只对话窗看详情：说明 / 云端版本 / 本机版本（可回滚）/ 评论");
  b.setAttribute("aria-label", appsT("详情"));
  return b;
}

/* 卡片上的图标入口（下载更新 / 打赏）现在是封面右下角那一排，见 appsCoverActionsEl。 */
/* 悬停文案的数据来源：先问本轮拉到的公开汇总（GET /api/tips/summary，见 appsTipsLoad），
   退回目录条目自带的 tips（tips 有值时就是原地走 MtTips.tipSumTitle(tips)），
   再退回「还没有人打赏」—— 三种状态各有各的话：
   · 有数字（哪怕 0 次）→「累计打赏 N 币（M 次）」/「还没有人打赏」；
   · 还没问回来 →「正在读取打赏数据…」；
   · 问失败（未登录 / 断网 / 5xx）→「打赏数据暂未取到」——**绝不谎报成无人打赏**。 */
function appsTipsTitleEl(spec) {
  const T = window.MtTips;
  if (!T || typeof T.tipSumTitle !== "function") return appsT("打赏作者（鲸圆币）");
  const tips = appsSpecWithTips(spec).tips;
  if (tips) return T.tipSumTitle(tips);
  const id = appsBranchIdOf(spec);
  const known = !!(id && APPS_ST.tips && APPS_ST.tips.byId && APPS_ST.tips.byId[id]);
  if (known) return T.tipSumTitle(APPS_ST.tips.byId[id]);
  if (APPS_ST.tipsFailed) return appsT("打赏数据暂未取到");
  return appsT("正在读取打赏数据…");
}
/* 打赏成功后强制重拉一次（跳过新鲜期）：不重绘、只更新缓存，由调用方决定什么时候重绘。 */
function appsTipsRefreshNow() {
  const ids = appsTipsIdsOf(appsSpecPoolAll());
  if (!ids.length) return Promise.resolve(null);
  return appsTipsLoad(ids, true).catch(() => null);
}
function appsBridgeMissing() {
  appsToast(appsT("应用服务未就绪（主进程应用宿主尚未接入）"), "err");
}
/* 主进程侧失败 → 给用户看的一句话（与 app-plugins.js 的 pluginErrText 同一口径：
   先认失败码，认不出再用主进程给的归类 hint，最后才是原始串）。失败码的单一真源在
   主进程 apps-store.js 的 installFailHint / uninstallApp / openAppWindow。
   匹配按**前缀**（与 installFailHint 的 /^code/ 同源）：主进程会在码后补上下文
   （如 not_in_catalog_removed），整串精确比对会漏认，用户就会看到英文码本身。 */
function appsErrText(r) {
  const raw = String((r && r.error) || "").trim();
  const code = raw.split(":")[0].trim();
  const CODE_TEXT = {
    /* need_root 已随「不再要求手选应用根目录」下线（本轮需求）：主进程不再回这个码 */
    busy: "该应用已有安装任务在跑",
    bad_id: "应用 id 不合法",
    not_in_catalog: "云端目录里找不到这个应用",
    /* 云端目录里没有它（作者已删除）：与「没连上目录」分开说，用户才知道该去商店
       重新找一份，还是先查网络（见 apps-store.js 的 installCatalogMiss）。措辞对「本机装过」
       与「从没装过（别人分享的 id / 缓存旧卡片）」两种人都成立 —— 别说「本机这一份」，
       后一种人本机根本没有这一份。 */
    not_in_catalog_removed: "云端目录里已经找不到这个应用（作者已删除），没法再从云端下载",
    catalog_unreachable: "这次没能连上云端目录：检查网络后重试；离线时只有本机已有的版本能在本机切换",
    bad_zip_url: "云端目录里该应用的下载地址不合法",
    need_app_update: "该应用要求的 MTNode 版本高于当前版本",
    sha256_mismatch: "安装包校验失败（sha256 与云端目录声明不一致）",
    pack_missing_entry: "安装包解压后缺少入口页",
    timeout: "下载超时",
    too_large: "安装包超过允许体积上限",
    missing: "该应用不在本机",
    missing_entry: "应用入口页不存在",
  };
  /* 前缀匹配必须取**最长**的那个码：这一族里有互为前缀的成员（not_in_catalog 与
     not_in_catalog_removed），照对象字面量的键序 find 会先撞上短的那个 —— 用户看到的就又是
     「云端目录里找不到这个应用」这句泛泛的话，而现场要的正是把它与「没连上目录」分开说。 */
  const hit = Object.keys(CODE_TEXT)
    .filter((k) => code === k || code.indexOf(k + "_") === 0)
    .sort((x, y) => y.length - x.length)[0];
  if (hit) return appsT(CODE_TEXT[hit]);
  const hint = String((r && r.hint) || "").trim();
  if (hint) return hint + (raw ? "（" + raw + "）" : "");
  return raw || appsT("未知错误");
}

/* ───────────────── 登录态 → 顶栏入口显隐 ───────────────── */

/* 登录态快照：window.MTNodeAuth.state()（{ signedIn, user }）；模块未就绪 = 未登录。 */
function appsAuthUser() {
  const A = window.MTNodeAuth;
  if (!A || typeof A.state !== "function") return null;
  const st = A.state() || {};
  return st.signedIn && st.user ? st.user : null;
}
/* 可见判据 = 已登录且有用户名字段（与钱包侧口径一致：账号相关能力只按登录态判定，
   不再按用户名发白名单）。 */
function appsEntryAllowed() {
  const u = appsAuthUser();
  return !!String((u && u.username) || "").trim();
}
/* 同步顶栏入口显隐；退出登录（不再满足判据）时把页面一并收掉 */
function appsSyncEntryVisibility() {
  const btn = document.getElementById("btnApps");
  const ok = appsEntryAllowed();
  if (btn) {
    btn.hidden = !ok;
    btn.setAttribute("aria-hidden", ok ? "false" : "true");
  }
  if (!ok && APPS_HUB_OPEN) appsHubClose();
  return ok;
}
/* 订阅登录态（每次重订前先退订，避免叠加）；模块还没就绪 → false，调用方稍后再试 */
function appsBindAuthWatch() {
  const A = window.MTNodeAuth;
  if (!A || typeof A.onChange !== "function") return false;
  if (APPS_AUTH_OFF) {
    try {
      APPS_AUTH_OFF();
    } catch (_) {}
    APPS_AUTH_OFF = null;
  }
  APPS_AUTH_OFF = A.onChange(() => {
    try {
      appsSyncEntryVisibility();
    } catch (_) {}
    /* 换账号 / 退出登录：本机目录与打赏汇总都得当没读过（下一个人不该看到上一个人的缓存）。
       打赏汇总本身是公开数字，但换账号后仍重拉一次最省心。 */
    appsTipsReset();
  });
  return true;
}
/* 清空打赏汇总缓存（换账号、退出登录、强制刷新时调）。 */
function appsTipsReset() {
  APPS_ST.tips = null;
  APPS_ST.tipsAt = 0;
  APPS_ST.tipsAsked = "";
  APPS_ST.tipsBusy = false;
  APPS_ST.tipsFailed = false;
  APPS_ST.tipsErr = "";
}

/* ───────────────── 图标（云端目录声明 → 可显示的 URL） ───────────────── */

/* 目录地址去掉文件名 = feed 基址（catalog 响应带 sourceUrl，渲染层不硬编码域名）。
   目录可能来自静态文件（…/apps/catalog.json）或云端接口（…/store-api/api/apps/catalog）——
   主进程 apps-store.js 把来源记在响应 sourceBase / 每条 spec.source 上，这里按来源取基址。 */
function appsFeedBase(spec) {
  const own = String((spec && spec.sourceBase) || "").trim();
  if (own) return own;
  const st = String((APPS_ST.cat && APPS_ST.cat.sourceBase) || "").trim();
  if (st) return st;
  const src = String((APPS_ST.cat && APPS_ST.cat.sourceUrl) || "").trim();
  if (!src) return "";
  return src.replace(/\/[^/]*$/, "");
}
function appsIconUrl(spec) {
  /* 主进程已经把图标解析成按来源可用的 URL（静态 = FEED + 相对路径；接口 = …/api/apps/<id>/icon） */
  const resolved = String((spec && spec.urls && spec.urls.icon) || "").trim();
  if (resolved) return resolved;
  const raw = String((spec && spec.icon) || "").trim();
  if (!raw) return "";
  if (/^data:image\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = appsFeedBase(spec);
  if (!base) return "";
  if (raw.startsWith("/")) {
    try {
      return new URL(raw, base).href;
    } catch (_) {
      return "";
    }
  }
  return base + "/" + raw.replace(/^\.\//, "");
}
function appsLetterTile(name) {
  const t = document.createElement("div");
  t.className = "apps-tile-ph";
  const ch = String(name || "?").trim().charAt(0) || "?";
  t.textContent = ch.toUpperCase();
  /* 同一应用每次都给同一种底色（名称哈希 → 色相），列表扫一眼能分开 */
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  t.style.filter = "hue-rotate(" + h + "deg)";
  return t;
}
/* 图标元素：云端图拉不到（离线 / 404 / 无图标声明）→ 就地换成首字占位块，不留破图 */
function appsIconEl(spec, name, cls) {
  const url = appsIconUrl(spec);
  if (!url) return appsLetterTile(name);
  const img = document.createElement("img");
  img.className = cls || "apps-ico-img";
  img.alt = "";
  img.loading = "lazy";
  img.src = url;
  img.addEventListener("error", () => {
    if (img.parentNode) img.replaceWith(appsLetterTile(name));
  });
  return img;
}

/* ───────────────── 数据：云端目录 / 本机列表 / 根目录 ───────────────── */

async function appsCatalogLoad(force) {
  if (!force && APPS_ST.cat && Date.now() - APPS_ST.catAt < APPS_CAT_TTL) return APPS_ST.cat;
  const api = window.api || {};
  if (typeof api.appsCatalog !== "function") return APPS_ST.cat;
  let cat = null;
  try {
    cat = await api.appsCatalog();
  } catch (e) {
    cat = { ok: false, error: (e && e.message) || String(e) };
  }
  APPS_ST.cat = cat && cat.ok !== false ? cat : { ok: false, source: "error", apps: [], error: (cat && cat.error) || "" };
  APPS_ST.catAt = Date.now();
  return APPS_ST.cat;
}
async function appsListLoad(force) {
  if (!force && APPS_ST.list) return APPS_ST.list;
  const api = window.api || {};
  if (typeof api.appsList !== "function") return APPS_ST.list;
  let r = null;
  try {
    r = await api.appsList();
  } catch (e) {
    r = null;
  }
  APPS_ST.list = r && r.ok !== false ? r : null;
  if (APPS_ST.list) APPS_ST.root = { ok: true, path: APPS_ST.list.root, configured: !!APPS_ST.list.configured, exists: !!APPS_ST.list.exists };
  /* 两套根的真源在主进程（config.json 的 apps.installDir / apps.projectDir），渲染层这份
     S.config 是启动时读的**旧副本**：不同步的话，下一次 configSave(S.config) 会拿旧 apps 段
     把主进程刚写进去的键盖掉（真事故：projectDir 被抹掉 → 开发中的应用整列消失、预览报
     「该应用不在本机」，见 main.js 的 mergeConfigForSave）。这里顺手对齐内存副本。 */
  if (APPS_ST.list && APPS_ST.list.roots) appsRootsSyncConfig(APPS_ST.list.roots);
  return APPS_ST.list;
}
/* 把主进程回的 roots 同步进 S.config.apps（只写「已配置」的那一套键；未配置的键不动 ——
   绝不能拿默认路径把「没配」写成「配了」）。值没变就不落盘（configSave 自己也会比对字节）。 */
function appsRootsSyncConfig(roots) {
  try {
    if (!S || !S.config || !roots) return;
    const apps = Object.assign({}, S.config.apps || {});
    let changed = false;
    for (const k of ["down", "dev"]) {
      const r = (roots && roots[k]) || {};
      if (!r.configured) continue;
      const key = k === "dev" ? "projectDir" : "installDir";
      const p = String(r.path || "");
      if (!p || apps[key] === p) continue;
      apps[key] = p;
      changed = true;
    }
    if (!changed) return;
    S.config.apps = apps;
    if (window.api && typeof window.api.configSave === "function")
      window.api.configSave(S.config).catch(() => {});
  } catch (_) {}
}
window.appsRootsSyncConfig = appsRootsSyncConfig;
async function appsRootLoad() {
  const api = window.api || {};
  if (typeof api.appsRootGet !== "function") return APPS_ST.root;
  try {
    const r = await api.appsRootGet();
    if (r && r.ok !== false) APPS_ST.root = r;
  } catch (_) {}
  return APPS_ST.root;
}
function appsCatalogList() {
  return (APPS_ST.cat && Array.isArray(APPS_ST.cat.apps) ? APPS_ST.cat.apps : []).slice();
}
/* 本页能看到的全部条目（云端目录 + 作者自己的线上条目）——
   同 id 多分支**已合并成一条**（主干那条带上 branchSiblings / branchCount / branchSummary，
   见 appsMergeSameId），所以列表、标签条、搜索看到的都是「一个应用一张卡」。
   另挂上打赏汇总（appsSpecWithTips：接口那份优先、目录条目自带的 tips 兜底）——
   卡片金币 icon 的悬停文案与合并卡片的副标题都读它。 */
function appsSpecListAll() {
  return appsMergeSameId(appsSpecPoolAll()).map(appsSpecWithTips);
}
/* 合并前的原始条目池（要按分支取某一条时用它） */
function appsSpecPoolRaw() {
  return appsSpecPoolAll();
}
function appsLocalList() {
  return (APPS_ST.list && Array.isArray(APPS_ST.list.apps) ? APPS_ST.list.apps : []).slice();
}
function appsSpecById(id) {
  /* 同 id 多分支（§十）：缺省给主干那条（目录里同 id 的第一条 = 服务端的缺省口径）；
     要指名某条分支用 appsSpecOfBranch(id, ownerId)。
     **不许把这里写成 appsSpecOfBranch(id, "") 当唯一实现** —— 那一对是互相回落的：
     appsSpecOfBranch 在「同 id 一条候选都没有」时回落 appsSpecById，appsSpecById 又回落
     appsSpecOfBranch，两者对着递归，栈一满就是 `RangeError: Maximum call stack size exceeded`。
     用户报的「消息里点开就报错」正是这条链：点打赏通知（app-messages.js）→ openAppsDetail(id)
     → appsDetailSpecOf → appsSpecById → appsSpecOfBranch → appsSpecById → …（真堆栈见
     %APPDATA%\pipeline-console\logs\error.log，报错位置 app-apps.js:665 = appsSpecPoolAll）。
     所以这一支**自己查表**（与 appsSpecOfBranch 的「没指定作者」口径逐字同源），不绕回去。 */
  const list = appsSpecPoolAll().filter((s) => appsBranchIdOf(s) === String(id || ""));
  return list[0] || null;
}
function appsLocalById(id) {
  return appsLocalList().find((a) => a && a.id === id) || null;
}
/* 目录条目的本地化标题 / 副标题：云端可给 { zh, en } 两份（apps-store.js 的 loc()） */
function appsSpecTitle(spec) {
  const t = spec && spec.title;
  if (t && typeof t === "object") return (t[window.I18n && I18n.getLocale && I18n.getLocale() === "en" ? "en" : "zh"] || t.zh || t.en || spec.id || "").trim();
  return String((spec && (spec.name || spec.title)) || "").trim();
}
function appsSpecSub(spec) {
  const s = spec && spec.subtitle;
  if (s && typeof s === "object") return (s[window.I18n && I18n.getLocale && I18n.getLocale() === "en" ? "en" : "zh"] || s.zh || s.en || "").trim();
  return String((spec && spec.subtitle) || "").trim();
}
/* 供人读的描述：优先本地化副标题，落到 description（云端若把 description 写成
   { zh, en } 对象，主进程只会 String() 成 "[object Object]" —— 这种值一律当没有） */
function appsSpecDesc(spec) {
  const sub = appsSpecSub(spec);
  if (sub) return sub;
  const raw = String((spec && spec.description) || "").trim();
  return raw === "[object Object]" ? "" : raw;
}

/* ─────────── 作者 / 二次开发来源 / 校验值小按钮（docs/apps-market.md §八） ───────────
 * 作者显示口径（本轮共识，与 store-saas/server.mjs 的 accountDisplayNameOf **同源**）：
 *   · 显示名 = 账号昵称 —— 服务端按 uid **实时解析**（字段 `ownerName` / `uploaderName`），
 *     作者在账户菜单改一次昵称，应用市场处处同步；
 *   · 昵称为空才回落账号名，且**系统自动占位名**（微信 / 手机号自动建号时生成的 `u_xxxxxxxx`，
 *     不是作者取的）不算名字；
 *   · 两者都没有 → 空串（调用方显示「未知作者」）。
 * 云端条目的 `owner` 仍是账号名（可能正是那个占位名）：它只用于「同作者」判定与下载寻址
 * （见 appsSameAuthor / appsDownload），界面一律不直接显示它。
 * 本机条目：app.json 里的 author 优先（离线可读）；它也是占位名 / 为空时回落当前登录账号的昵称。
 * 应用身份 = 应用 id + 作者 uid：uid 只在内部判定（同不同作者、分支归组）用，界面一律显示昵称。 */

/* 系统自动占位账号名（account-store.mjs 的 newPlaceholderUsername：`u_` + 4 字节十六进制）。 */
const APPS_PLACEHOLDER_NAME_RE = /^u_[0-9a-f]{6,24}$/i;
function appsIsPlaceholderName(name) {
  return APPS_PLACEHOLDER_NAME_RE.test(String(name || "").trim());
}
/* 当前登录账号的显示名（昵称优先；占位账号名不算名字）。 */
function appsMeDisplayName() {
  const u = appsAuthUser() || {};
  const nick = String(u.nickname || "").trim();
  if (nick) return nick;
  const name = String(u.username || "").trim();
  return appsIsPlaceholderName(name) ? "" : name;
}
/* 作者显示名（卡片作者行、详情「作者」行、分支树、开发页应用列表都读它）。
   云端条目只认云端信息：老目录里 owner 是占位名又没有 ownerName → 空串（显示「未知作者」），
   **绝不再回落成「我自己」**。本机条目才走 app.json / 登录账号那一条链。 */
function appsAuthorOf(spec) {
  const s = spec || {};
  const cloudKey = String(s.ownerId || s.owner || "").trim();
  const cloudName = String(s.ownerName || "").trim();
  if (cloudName) return cloudName;
  const owner = String(s.owner || "").trim();
  if (cloudKey) return appsIsPlaceholderName(owner) ? "" : owner;
  const local = String(s.localAuthor || s.author || "").trim();
  if (local && !appsIsPlaceholderName(local)) return local;
  return appsMeDisplayName();
}
/* 版本行的「上传者」显示名：`uploaderName`（服务端按上传者 uid 实时解析）→ 非占位账号名 → 空串
   （空串 = 这一行不写「上传者 …」，绝不把占位名 / uid 摊出来）。 */
function appsUploaderOf(v) {
  const s = v || {};
  const nick = String(s.uploaderName || "").trim();
  if (nick) return nick;
  const up = String(s.uploader || "").trim();
  return appsIsPlaceholderName(up) ? "" : up;
}
/* 当前登录账号（作者回落的来源）：{ name, uid } —— 未登录两个都空。 */
function appsMeOf() {
  const u = appsAuthUser() || {};
  return { name: String(u.username || "").trim(), uid: String(u.id || "").trim() };
}
/* 二次开发来源归一（与主进程 apps-store.js 的 normForkOf 同一口径）：空 / 非法 = 没有声明。 */
function appsNormForkOf(v) {
  if (!v || typeof v !== "object") return null;
  const id = String(v.id || "").trim();
  if (!id) return null;
  return {
    id: id,
    ownerId: String(v.ownerId || "").trim(),
    owner: String(v.owner || "").trim(),
    /* 源作者显示名（服务端按 uid 实时解析；老目录 / 本机 app.json 里没有就是空串） */
    ownerName: String(v.ownerName || "").trim(),
  };
}
/* ─────────── 上架留痕（app.json 的 cloud）───────────────────────────
 * 留痕 = 上架成功时渲染层写进 app.json 的 cloud 字段（主进程 apps:setMeta 落盘）：
 *   { id（云端那条的 id）, ownerId（上架账号 uid）, owner（账号名，只作显示）, version, at }
 * 与主进程 apps-store.js 的 normCloudPub 同一口径：空 / 非法 = 没有留痕。
 *
 * 用途（**唯一真源**，上架窗 renderer/app-publish.js 读这一份）：
 *   · 开窗时定默认锁定 id：有留痕 = 留痕里的云端 id，没有 = 本机应用 id；
 *   · 线上状态读不回来（离线 / 未登录 / 接口异常）时，按留痕判这次是对着同一条提交
 *     （对照 renderer/app-publish.js 的 pubTraceUpdate）。
 * 账号比对一律用 ownerId（uid）：uid 是身份，owner 只作显示；留痕里没记账号（老数据）就认它。
 * 为什么把留痕写在 app.json：与 author / forkOf 同一先例（本机状态字段、随包走）；
 * 下载者拿到别人的包也不会被误判成「我上架的」—— 上面那条账号比对就是为它准备的。 */
function appsNormCloudOf(v) {
  if (!v || typeof v !== "object") return null;
  const id = String(v.id || "").trim().toLowerCase();
  if (!id) return null;
  return {
    id: id,
    ownerId: String(v.ownerId || "").trim(),
    owner: String(v.owner || "").trim(),
    version: String(v.version || "").trim(),
    at: Number(v.at) || 0,
  };
}
/* 这台机器上「谁上架过这个应用」的留痕（没有 = null） */
function appsPublishTraceOf(app) {
  return appsNormCloudOf(app && app.cloud);
}
/* ─────────── 同 id 多分支：分支树（docs/apps-market.md §十，本轮） ───────────
 * 口径（用户共识）：
 *   · 应用身份 = id + 作者 uid；**同一个 id 下的不同作者各占一条分支**，主干 = createdAt 最早那条；
 *   · 列表里同 id 的条目**合并成一张卡**（q21），树上主干在最左、每个作者分支向右延伸一级（q4/q5）；
 *   · 每行写「作者（账号名 / 昵称）· 最新版 · 本机已装哪一版」，并带自己的下载（q28/q29/q37）；
 *   · 另给「作者 ▾ / 版本 ▾」两个联动下拉（先选作者，版本只列该作者的版本，q13/q22）。
 * 旧那套「不同 id 的 forkOf 条目当分支」的字段与数据保留，但**不再作为归组键**（q14/q25/q31）：
 * 分支 = 同 id，跨 id 的 fork 只在上架窗的「二次开发来源」里体现。 */
function appsBranchIdOf(spec) {
  return String((spec && (spec.id || spec.appId)) || "").trim();
}
/* ─────────── 应用家族（本轮需求：分支树统一 · 打赏/评论按根应用统一） ───────────
 * 用户口径：
 *   · 「只要基于一个应用开发都应当是同一个 id」+「填同 id 就自动当分支」→ 服务端把同一个应用
 *     的所有分支归到**一个家族**（`familyRootId` = 家族根条目的 id）；
 *   · 分支树是**多层**的：谁基于谁开发就挂在谁下面（`parentOwnerId` = 父分支的作者 uid）；
 *   · 打赏与评论/评分**按根应用统一**（服务端已按家族汇总，客户端一律拿家族根 id 去问）。
 * 客户端据此把「同一个家族的条目」合并成一张卡、画一棵树、共用一个打赏口径。
 * 老目录（没下发 familyRootId）退回按 id 归组 —— 与老客户端行为一致，不会炸。 */
function appsFamilyKeyOf(spec) {
  const root = String((spec && spec.familyRootId) || "").trim();
  if (root) return root;
  return appsBranchIdOf(spec);
}
/** 家族里的一条分支挂在谁下面（空 = 根）；老数据用 ownerName/owner 兜一层，认不出就是根。 */
function appsBranchParentKeyOf(b, family) {
  const pid = String((b && b.parentOwnerId) || "").trim() || (appsNormForkOf(b && b.forkOf) || {}).ownerId || "";
  if (!pid) return "";
  const list = Array.isArray(family) ? family : [];
  for (const o of list) {
    if (String(o.ownerId || "") === pid && !(o === b)) return appsBranchKeyOfSpec(o);
  }
  /* 父条目已删（界面上看不到它）：仍尽量按作者挂到同作者那条上，挂不上就归到根。 */
  for (const o of list) {
    if (String((o && o.owner) || "") === pid && !(o === b)) return appsBranchKeyOfSpec(o);
  }
  return "";
}
/** 应用族的原始条目（**不带**合并结果：合并只多出 branchSiblings 这些展示字段，家族归组用不着它们）。
 *  刻意不调 appsSpecListAll —— 那条路会回调 appsMergeSameId，而合并本身要用家族键，会绕成环。 */
function appsFamilyPoolRaw() {
  return appsSpecPoolRaw();
}
/** 某条分支 / 某个 id 所属家族的**全部**条目（同 id 的各作者分支 + 跨 id 但 forkOf 指回本族的旧条目）。 */
function appsFamilyEntriesOf(spec) {
  const root = appsFamilyKeyOf(spec);
  if (!root) return [];
  const pool = appsFamilyPoolRaw();
  const out = pool.filter((s) => appsFamilyKeyOf(s) === root);
  if (out.length) return out;
  return appsBranchesById(root, pool);
}
/** 家族根条目（原作者那条）：trunk=true 优先，其次 parentOwnerId 为空，最后按 createdAt 最早。 */
function appsFamilyRootOf(spec) {
  const list = appsFamilyEntriesOf(spec);
  if (!list.length) return spec || null;
  const byTrunk = list.filter((s) => s && s.trunk === true);
  if (byTrunk.length) return byTrunk.reduce((best, x) => (appsCreatedAtOf(x) < appsCreatedAtOf(best) ? x : best));
  const roots = list.filter((s) => !String(s.parentOwnerId || "").trim());
  const pick = roots.length ? roots : list;
  return pick.reduce((best, x) => (appsCreatedAtOf(x) < appsCreatedAtOf(best) ? x : best));
}
function appsCreatedAtOf(spec) {
  const n = Number(spec && spec.createdAt);
  return isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
}
/** 打赏 / 评论的对象目标：**一律指向家族根条目的 id**（同一应用族共用一份累计）——
 *  用户口径「打赏全局统一，所有打赏归到同一个根下」，所以客户端不再拿分支自己的 id 去问。
 *  根条目在云端不存在（本机自建、还没上架）时返回 null —— 调用方不放入口，不弹空窗。
 *  函数体在文件后部（appsCloudTarget），这里只留家族口径说明。 */
/** 本机已装那一支的作者显示名（卡片作者行的第二段：本机装的是谁的版本）。 */
function appsInstalledAuthorOf(spec, app) {
  const ownerId = String((app && app.ownerId) || "").trim();
  if (!ownerId) return "";
  const list = appsFamilyEntriesOf(spec);
  const hit = list.find((b) => String((b && b.ownerId) || "") === ownerId);
  if (hit) return appsAuthorOf(hit) || "";
  const own = String((app && app.owner) || "").trim();
  return own && !appsIsPlaceholderName(own) ? own : "";
}
/* 云端条目 + 我自己那份线上条目合并成一份候选表（与 appsSpecListAll 同一口径） */
function appsSpecPoolAll() {
  const out = appsCatalogList().map(appsSpecWithMine);
  const have = Object.create(null);
  for (const s of out) have[String(s.id)] = 1;
  const mineAll = APPS_ST.mine && APPS_ST.mine.byId ? APPS_ST.mine.byId : null;
  if (mineAll) {
    for (const id of Object.keys(mineAll)) {
      if (have[id]) continue;
      const s = appsSpecFromMine(mineAll[id]);
      if (s) out.push(s);
    }
  }
  return out;
}
/* 同一个 id 下的全部分支（主干在前：createdAt 最早；缺 createdAt 时保持目录顺序）。 */
function appsBranchesById(id, pool) {
  const want = String(id || "");
  if (!want) return [];
  const list = (pool || appsSpecPoolAll()).filter((s) => appsBranchIdOf(s) === want);
  const byOwner = Object.create(null);
  const out = [];
  for (const s of list) {
    const key = appsBranchKeyOfSpec(s) || "idx" + out.length;
    if (byOwner[key]) continue; /* 同 id 同作者只算一条（服务端也是这个口径） */
    byOwner[key] = 1;
    out.push(s);
  }
  return out.sort((a, b) => {
    const d = (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
    if (d) return d;
    return String(a.ownerId || a.owner || "").localeCompare(String(b.ownerId || b.owner || ""));
  });
}
/* 一条分支的稳定键：uid > 账号名 > 序号（老静态目录只有 username） */
function appsBranchKeyOfSpec(spec) {
  const uid = String((spec && spec.ownerId) || "").trim();
  if (uid) return "u:" + uid;
  const name = String((spec && spec.owner) || "").trim();
  return name ? "n:" + name : "";
}
/* 一条分支的显示标签：显示名（昵称）；同一个应用下两条分支昵称相同时，后面补一段短 uid
   （ownerId 末 6 位，如「Tester # 539e484」）——只显示昵称之后，同名分支不然会长得一模一样。
   传 all（同一 id 的全部分支）才会判重名；不传 = 只给显示名（日志 / 单条场景）。 */
function appsBranchLabelOf(spec, all) {
  const base = appsAuthorOf(spec) || appsT("未知作者");
  const list = Array.isArray(all) ? all : null;
  if (!list || base === appsT("未知作者")) return base;
  const key = appsBranchKeyOfSpec(spec);
  const short = appsBranchShortOf(spec);
  if (!short) return base;
  const dup = list.some((o) => {
    if (!o || o === spec) return false;
    if (appsBranchKeyOfSpec(o) === key) return false;
    return (appsAuthorOf(o) || appsT("未知作者")) === base;
  });
  return dup ? base + " # " + short : base;
}
/* 重名时补的短 uid：ownerId 末 6 位；老目录只有账号名时退账号名末 6 位。 */
function appsBranchShortOf(spec) {
  const uid = String((spec && spec.ownerId) || "").trim();
  if (uid) return uid.slice(-6);
  const name = String((spec && spec.owner) || "").trim();
  return appsIsPlaceholderName(name) ? "" : name.slice(-6);
}
function appsBranchVersionOf(spec) {
  return String((spec && (spec.latestVersion || spec.version)) || "0.0.0");
}
/* 版本号比较：与主进程 apps-store.js 的 verCmp **同一口径**（按 . - + 切段、逐段取整比较、
   段缺位当 0）。这一份必须存在于此：本文件里排版本（合并卡的「最新 vX」、分支对比）
   用的是它 —— 早先直接写出 `verCmp(...)` 而渲染层根本没有这个函数，页面一渲染就
   `Uncaught ReferenceError: verCmp is not defined @ app-apps.js`（用户报的「打开应用时的报错」）。
   命名加 apps 前缀是为了不在渲染层抢一个通用名字（同名冲突一出现又是一次静默错指）。 */
function appsVerParts(s) {
  return String(s == null ? "" : s)
    .split(/[.\-+]/)
    .map((x) => parseInt(x, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}
function appsVerCmp(a, b) {
  const x = appsVerParts(a);
  const y = appsVerParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
function appsVersionsOfBranch(branch) {
  /* 版本表：分支条目自带 versions[]；老条目只有单版 → 合成一条 */
  const vs = Array.isArray(branch && branch.versions) ? branch.versions : [];
  if (vs.length) return vs;
  return [
    {
      version: String((branch && branch.version) || "0.0.0"),
      bytes: Number(branch && branch.bytes) || 0,
      uploader: String((branch && branch.owner) || ""),
      /* 显示名（昵称）：老条目没有 versions[] 时合成这一条，版本行照样显示昵称而不是占位账号名 */
      uploaderName: String((branch && (branch.ownerName || branch.nickname)) || ""),
      createdAt: Number(branch && branch.createdAt) || 0,
      note: "",
      parentVersion: "",
    },
  ];
}

/* 分支树本体（详情窗 / 上架窗共用）。
   opts.selectedOwnerId：初始展开（也是下拉默认）的那条分支；
   opts.mount(el)：塞进宿主（上架窗自己在它的左栏里再排一遍）。 */
/* 应用家族的多层分支树（本轮需求：分支树统一、与当前版本无关、选中后才出下载/覆盖）
 *
 * 形态（用户共识）：
 *   · 根 = 原作者（主干那条），谁基于谁开发就挂在谁下面 → 真正的多层，横向缩进一级一层；
 *   · 每个节点只写「作者名 · v最新版号」（树上不放版本列表），未选中时下方**什么都不出现**；
 *   · 点某个节点 = 选中它 → 下方才出现这一支的版本列表与下载 / 覆盖 / 启动（见 appsBranchTreeVerSelEl）；
 *   · 排序：原作者永远最左，其余按 createdAt 从早到晚（同刻按作者名稳定比较）；
 *   · 默认选中 = 原作者（主干）+ 其最新版（APPS_DETAIL.branchOwnerId 为空时即此口径）。
 * 与版本无关：树本身只由家族结构与作者决定，不随「当前选了哪一版」变化。
 */
function appsBranchChildrenMap(branches) {
  const list = Array.isArray(branches) ? branches.slice() : [];
  const map = new Map();
  for (const b of list) map.set(appsBranchKeyOfSpec(b), []);
  for (const b of list) {
    const pk = appsBranchParentKeyOf(b, list);
    if (pk && pk !== appsBranchKeyOfSpec(b) && map.has(pk)) map.get(pk).push(b);
  }
  const byTime = (a, b) => {
    const d = appsCreatedAtOf(a) - appsCreatedAtOf(b);
    if (d) return d;
    return String(appsBranchKeyOfSpec(a)).localeCompare(String(appsBranchKeyOfSpec(b)), "en");
  };
  for (const arr of map.values()) arr.sort(byTime);
  /* 根 = 家族根条目那一条（appsFamilyRootOf 的口径）；找不到就退回 createdAt 最早那条 */
  const trunk =
    list.find((b) => b && b.trunk === true) ||
    list.reduce((best, x) => (!best || appsCreatedAtOf(x) < appsCreatedAtOf(best) ? x : best), null);
  return { map: map, trunk: trunk, list: list };
}

/** 某一支一共有几个版本（树上「N 个版本」用它；老目录没有 versions[] 时按 1 算）。 */
function appsBranchVersionCountOf(b) {
  const vs = appsVersionsOfBranch(b);
  return vs && vs.length ? vs.length : 1;
}

function appsBranchTreeEl(id, opts) {
  const o = opts || {};
  const branches = (o.branches && o.branches.length ? o.branches : appsBranchesById(id, o.pool)).slice();
  if (!branches.length) return null;
  const me = appsMeOf();
  const local = appsLocalById(id);
  const localOwnerId = String((local && local.ownerId) || "").trim();
  const localAuthor = String((local && (local.owner || local.author)) || "").trim().toLowerCase();
  const tree = appsBranchChildrenMap(branches);
  /* 交互开关（withSel）：**只有应用详情**开它（点分支 → 下方才出现版本与下载/覆盖/启动）。
     上架窗那处复用不带这个开关 —— 那边只是看一眼分支，不该长出下载按钮（用户口径：
     「选择好分支后，下方才出现下载/覆盖等信息」说的是**应用详情**）。
     没开开关时不读 APPS_DETAIL（上架窗与详情窗共用同一份模块状态，读了会显示错分支的详情）。 */
  const withSel = !!o.withSel;
  const want = withSel
    ? String(o.selectedOwnerId || appsDetailSelKey() || "")
    : String(o.selectedOwnerId || "");
  const selOf = (b) =>
    String((b && b.ownerId) || "") === want || String((b && b.owner) || "") === want;
  let sel = want && withSel ? tree.list.find(selOf) || null : null;
  if (!sel) sel = tree.trunk || tree.list[0];
  const selKey = sel ? appsBranchKeyOfSpec(sel) : "";

  const box = document.createElement("div");
  box.className = "apps-brtree";
  const head = document.createElement("div");
  head.className = "apps-br-head";
  head.textContent =
    appsT("分支") +
    "（" + tree.list.length + appsT(" 条分支 · ") + appsBranchTotalVersions(tree.list) + appsT(" 个版本") + "）";
  box.appendChild(head);

  const rowsWrap = document.createElement("div");
  rowsWrap.className = "apps-br-rows";
  box.appendChild(rowsWrap);

  const rows = [];
  const walk = (b, depth, isLast, parentKey) => {
    const key = appsBranchKeyOfSpec(b);
    const kids = tree.map.get(key) || [];
    rows.push({ b: b, depth: depth, isLast: !!isLast, parentKey: parentKey || "", hasKids: kids.length > 0 });
    kids.forEach((k, i) => walk(k, depth + 1, i === kids.length - 1, key));
  };
  if (tree.trunk) walk(tree.trunk, 0, true, "");
  /* 脏数据（父键指不到任何条目，或存在环）不能让任何一条分支消失：剩下的按 createdAt 平铺在末尾 */
  const shown = new Set(rows.map((r) => appsBranchKeyOfSpec(r.b)));
  for (const b of tree.list) {
    if (shown.has(appsBranchKeyOfSpec(b))) continue;
    shown.add(appsBranchKeyOfSpec(b));
    walk(b, 0, true, "");
  }

  for (const r of rows) {
    const b = r.b;
    const key = appsBranchKeyOfSpec(b);
    const on = key === selKey;
    const isTrunk = !!(tree.trunk && key === appsBranchKeyOfSpec(tree.trunk));
    const isLocal = appsBranchSameAsLocal(b, local, localOwnerId, localAuthor);
    const isMine = !!me.uid && String(b.ownerId || "") === me.uid;

    const row = document.createElement("div");
    row.className =
      "apps-br-branch" +
      (isTrunk ? " is-trunk" : "") +
      (isLocal ? " is-local" : "") +
      (on ? " on" : "");
    row.dataset.depth = String(r.depth);
    row.dataset.branchKey = key;
    row.style.setProperty("--br-depth", String(r.depth));

    const line = document.createElement("div");
    line.className = "apps-br-line";
    /* 折线树的枝线：depth 0 画竖干线，其余画 ├─ / └─ 折线（见 css/apps.css 的 .apps-br-elbow） */
    const elbow = document.createElement("i");
    elbow.className = "apps-br-elbow" + (r.isLast ? " is-last" : "");
    elbow.setAttribute("aria-hidden", "true");
    line.appendChild(elbow);

    const name = document.createElement("span");
    name.className = "apps-br-who";
    /* 多层树里同名作者会有多条，紧挨着看容易混 —— 一律「作者名 · v最新版号」，主干再带一枚「原作者」 */
    name.textContent =
      appsBranchLabelOf(b, tree.list) + " · v" + appsBranchVersionOf(b);
    name.title = name.textContent;
    line.appendChild(name);
    if (isTrunk) {
      const tag = document.createElement("span");
      tag.className = "apps-badge apps-badge-on";
      tag.textContent = appsT("原作者");
      line.appendChild(tag);
    }
    if (isLocal) {
      const tag = document.createElement("span");
      tag.className = "apps-badge";
      tag.textContent = appsT("本机已装");
      line.appendChild(tag);
    }
    if (isMine) {
      const tag = document.createElement("span");
      tag.className = "apps-badge";
      tag.textContent = appsT("我的分支");
      line.appendChild(tag);
    }
    /* 「已下架」徽标已按本轮共识整体移除（客户端不再有下架态、服务端的 unpublish 路由也删了） */

    const info = document.createElement("span");
    info.className = "apps-br-info";
    const bits = [];
    bits.push(appsBranchVersionCountOf(b) + appsT(" 个版本"));
    /* 版本号不在树上写第二遍（上面刚写过），这里只补「几个版本 + 时间」这类附加信息 */
    if (b.createdAt) bits.push(appsTime(b.createdAt));
    info.textContent = bits.join(" · ");
    line.appendChild(info);

    /* 点整行 = 选中这一支（与点作者名同效）；选中后下方才出现版本与下载/覆盖/启动 —— 用户口径。
       没开 withSel 的调用方（上架窗）点了不做事：那边不是「选择分支去下载」的场景。 */
    if (withSel) {
      line.addEventListener("click", (ev) => {
        if (ev && ev.target && ev.target.closest && ev.target.closest("button")) return;
        appsBranchTreeSelect(id, b, o.onSelect);
      });
      line.title = appsT("点这一支：下方出现它的版本与下载 / 覆盖入口");
    }
    row.appendChild(line);
    rowsWrap.appendChild(row);
  }

  /* 「已选哪一支 + 这一支的版本与动作」——**只有开了 withSel 的调用方**（应用详情）才有。
     没开开关时不画提示、不画版本列表、不画任何下载按钮（上架窗那处只看结构）。 */
  if (withSel && sel) {
    const hint = document.createElement("div");
    hint.className = "apps-br-hint";
    hint.textContent =
      appsT("已选：") + appsBranchLabelOf(sel, tree.list) + appsT("（下方是这一支的版本与下载）");
    box.appendChild(hint);
    /* opts.noVers：「分支 / 版本」跳窗（openAppsVersionDlg）用它 —— 树下面那半截（这一支的
       版本列表 + 下载 / 覆盖按钮）由跳窗自己按「点行选中、底部一颗主按钮」的画法排
       （见 appsVersionPickListEl），这里不画第二份。 */
    if (!o.noVers) box.appendChild(appsBranchTreeVerSelEl(id, sel, o));
  }

  if (typeof o.debug === "function") {
    o.debug(
      "树：" + tree.list.length + " 条分支；根 = " + appsBranchLabelOf(tree.trunk || tree.list[0], tree.list) +
        "（原作者，最左）→ 谁基于谁开发向下逐级缩进" +
        (withSel ? "；选中 = " + appsBranchLabelOf(sel, tree.list) : "；只看结构（无可下载入口）"),
    );
  }
  return box;
}

/** 树上选中某条分支（点击整行 / 作者名时走它）：记进 APPS_DETAIL 并重绘详情窗（保持滚动位置）。
 *  只有应用详情会走到这里（上架窗那处不带 withSel，行上没有点击监听）。 */
function appsBranchTreeSelect(id, b, onSelect) {
  const key = String((b && b.ownerId) || "");
  if (typeof onSelect === "function") {
    appsDetailSetSelKey(key);
    onSelect(b);
    return;
  }
  appsDetailSetSelKey(key);
  /* 保持滚动位置：窗滚 .apps-detail-scroll，面板滚它自己的 .apps-panel-scroll ——
     两种宿主都从「当前目标」里量（见 appsDetailScrollEl）。 */
  const sc = appsDetailScrollEl();
  const top = sc ? sc.scrollTop : 0;
  appsDetailRepaintCtx();
  const sc2 = appsDetailScrollEl();
  if (sc2) sc2.scrollTop = top;
}
/** 当前目标的滚动容器（窗 = .apps-detail-scroll，面板 = 它自己的 .apps-panel-scroll） */
function appsDetailScrollEl() {
  const c = appsDetailCtx();
  if (c && c.panel && c.panel.holder && c.panel.holder.closest) {
    return c.panel.holder.closest(".apps-panel-scroll");
  }
  return APPS_DETAIL && APPS_DETAIL.dom ? APPS_DETAIL.dom.scroll : null;
}

/** 选中分支的「版本列表 + 动作」块：这是用户口径里「选择好分支后才出现」的那一半。
 *  **当前没有调用方**（2026-10）：唯一会开 `withSel` 的调用方是「分支 / 版本」跳窗
 *  （openAppsVersionDlg），而它传 `noVers: true` —— 版本 UI 统一到跳窗的选中式列表
 *  （appsVersionPickListEl）。保留本函数是因为 `appsBranchTreeEl` 的 withSel 分支仍认它
 *  （上架窗那条不带 withSel；卡片路径当前也不画版本块），将来若要有第二个
 *  「选中分支就出下载按钮」的宿主，直接从树上拿这一块即可。
 *  动作按状态给一颗主按钮：
 *    · 本机没装 → 「下载」（装这一支的这一版）
 *    · 本机已装这一支的同一版 → 「启动」
 *    · 本机装的是别的分支 / 别的版本 → 「覆盖安装」（会替换本机这一份载荷，数据保留）
 *    · 同一支有更新 → 「更新到 vX」
 *  另附本机已装那一支的说明与「打开数据文件夹」入口。 */
function appsBranchTreeVerSelEl(id, branch, opts) {
  const o = opts || {};
  const spec = branch || {};
  const list = appsFamilyEntriesOf(spec).length ? appsFamilyEntriesOf(spec) : [spec];
  const box = document.createElement("div");
  box.className = "apps-br-sel";
  const ownerId = String(spec.ownerId || "");
  const local = appsLocalById(id);
  const vs = appsVersionsOfBranch(spec);
  const latest = appsBranchVersionOf(spec);
  const localOwnerId = String((local && local.ownerId) || "").trim();
  const sameBranch = !!local && !!localOwnerId && localOwnerId === ownerId;
  const localVer = String((local && local.version) || "");
  const specObj = spec;

  /* 版本列表：这一支的全部版本，逐版可下（点某一版 = 装那一版） */
  const versBox = document.createElement("div");
  versBox.className = "apps-br-vers";
  const vhead = document.createElement("div");
  vhead.className = "apps-vers-head";
  vhead.textContent =
    appsT("这一支的版本") + "（" + vs.length + appsT(" 个") + (latest ? appsT(" · 最新 v") + latest : "") + "）";
  versBox.appendChild(vhead);
  if (!vs.length) {
    const none = document.createElement("div");
    none.className = "apps-detail-vers-none";
    none.textContent = appsT("这一支还没有可下载的版本。");
    versBox.appendChild(none);
  }
  for (const v of vs) {
    const ver = String(v.version || "");
    const row = document.createElement("div");
    row.className = "apps-vers-row" + (ver === latest ? " is-cur" : "");
    const no = document.createElement("span");
    no.className = "apps-vers-ver";
    no.textContent = "v" + ver;
    row.appendChild(no);
    const bits = [];
    if (v.createdAt) bits.push(appsTime(v.createdAt));
    if (v.bytes) bits.push(appsBytes(v.bytes));
    const upWho = appsUploaderOf(v);
    if (upWho) bits.push(appsT("上传者 ") + upWho);
    if (bits.length) {
      const meta = document.createElement("span");
      meta.className = "apps-vers-meta";
      meta.textContent = bits.join(" · ");
      row.appendChild(meta);
    }
    if (v.note) {
      const nt = document.createElement("span");
      nt.className = "apps-vers-note";
      nt.textContent = String(v.note);
      nt.title = String(v.note);
      row.appendChild(nt);
    }
    const onLocal = sameBranch && localVer === ver;
    if (onLocal) {
      const tag = document.createElement("span");
      tag.className = "apps-badge apps-badge-on";
      tag.textContent = appsT("本机当前");
      row.appendChild(tag);
    }
    const dl = appsMiniBtn(appsT("下载这一版"), () => {
      appsDownload(id, local ? "update" : "", ver, ownerId);
    });
    dl.className += " apps-vers-dl";
    dl.disabled = !!APPS_ST.busy[id] || specObj.compatible === false;
    dl.title = onLocal ? appsT("重新下载并覆盖本机这一版") : appsT("装这一版到本机（会替换本机现有的那一份载荷）");
    row.appendChild(dl);
    versBox.appendChild(row);
  }
  box.appendChild(versBox);

  /* 动作区：主按钮一颗 + 本机状态说明 */
  const acts = document.createElement("div");
  acts.className = "apps-br-acts";
  const busy = !!APPS_ST.busy[id];
  if (!local) {
    const dl = appsMiniBtn(busy ? appsT("下载中…") : appsT("下载这一支并装到本机"), () => {
      appsDownload(id, "", latest, ownerId);
    });
    dl.className += " apps-br-main";
    dl.disabled = busy || specObj.compatible === false;
    acts.appendChild(dl);
  } else if (sameBranch && localVer === latest) {
    const run = appsRunBtnEl(id, appsT("启动"), () => appsOpenApp(id));
    run.className += " apps-br-main";
    acts.appendChild(run);
  } else if (sameBranch) {
    const up = appsMiniBtn(appsT("更新到 v") + latest, () => {
      appsDownload(id, "update", latest, ownerId);
    });
    up.className += " apps-br-main";
    up.disabled = busy;
    acts.appendChild(up);
  } else {
    const ov = appsMiniBtn(appsT("覆盖安装 v") + latest, () => {
      appsDownload(id, "overwrite", latest, ownerId);
    });
    ov.className += " apps-br-main";
    ov.disabled = busy;
    ov.title = appsT("本机现在装的是别一支：会替换本机的应用文件（storage / 数据文件夹 / 画布不受影响）");
    acts.appendChild(ov);
  }
  const note = document.createElement("div");
  note.className = "apps-br-note";
  const localWho = appsInstalledAuthorOf(spec, local) || appsT("未知作者");
  note.textContent = local
    ? appsT("本机已装：") + localWho + " · v" + localVer +
      (sameBranch ? "" : appsT("（换到别的分支会覆盖本机的应用文件；storage / 数据文件夹 / 画布保留）"))
    : appsT("本机还没装这个应用。");
  acts.appendChild(note);
  box.appendChild(acts);
  return box;
}
function appsBranchTotalVersions(branches) {
  let n = 0;
  for (const b of branches || []) n += appsVersionsOfBranch(b).length;
  return n;
}
/* 树上这一行 = 本机装的那一条分支？（uid 都记过按 uid 判；只有账号名时按名字判） */
function appsBranchSameAsLocal(branch, local, localOwnerId, localAuthor) {
  if (!local) return false;
  const bid = String((branch && branch.ownerId) || "").trim();
  const bname = String((branch && branch.owner) || "").trim().toLowerCase();
  if (localOwnerId || bid) return !!localOwnerId && !!bid && localOwnerId === bid;
  if (localAuthor) return !!bname && localAuthor === bname;
  return false;
}
function appsBranchIsLocalDiff(branch, local, localOwnerId, localAuthor) {
  if (!appsBranchSameAsLocal(branch, local, localOwnerId, localAuthor)) return false;
  return String((local && local.version) || "") !== appsBranchVersionOf(branch);
}
/* 一行「N 个分支 · M 个版本 · 最新 vX」：合并卡片的副标题（q32） */
function appsBranchSummaryLine(branches) {
  if (!branches || branches.length < 2) return "";
  const top = branches[branches.length - 1];
  let latest = "";
  for (const b of branches) {
    const v = appsBranchVersionOf(b);
    if (!latest || appsVerCmp(v, latest) > 0) latest = v;
  }
  return (
    branches.length +
    appsT(" 个分支 · ") +
    appsBranchTotalVersions(branches) +
    appsT(" 个版本 · 最新 v") +
    (latest || appsBranchVersionOf(top))
  );
}
/* 同一个**应用族**的多条合并成一张卡（本轮需求）：主条目 = 家族根（原作者那条），
   其余挂到 spec.branchSiblings。家族键优先用服务端下发的 familyRootId（跨 id 的 fork 也能归到一起），
   老目录没有这个字段时退回应用 id —— 与老客户端行为一致。
   搜索命中任一分支都显示这一条卡（命中哪支就在卡上标出来，供标签 / 作者搜索）。 */
function appsMergeSameId(list) {
  const out = [];
  const at = Object.create(null);
  for (const s of list) {
    if (!s || !appsBranchIdOf(s)) continue;
    const key = appsFamilyKeyOf(s);
    if (at[key] == null) {
      const fam = appsFamilyEntriesOf(s);
      const root = appsFamilyRootOf(s) || s;
      const base = Object.assign({}, root, {
        /* 本机安装状态、我的条目、打赏汇总这些是**按 id** 挂在具体条目上的：
           家族合并后主条目取的是根那条，所以把当前这一条的这几个字段并回来（谁有值用谁）。 */
        installed: root.installed || s.installed,
        installedVersion: root.installedVersion || s.installedVersion,
        localDev: root.localDev || s.localDev,
        mine: root.mine || s.mine,
        tips: root.tips || s.tips,
        branchSiblings: fam,
        branchCount: fam.length,
        branchSummary: appsBranchSummaryLine(fam),
        branchLatest: fam.reduce(
          (best, b) => (!best || appsVerCmp(appsBranchVersionOf(b), best) > 0 ? appsBranchVersionOf(b) : best),
          "",
        ),
      });
      at[key] = out.length;
      out.push(base);
      continue;
    }
    const cur = out[at[key]];
    if (!cur) continue;
    if (!cur.hitBranch && appsBranchKeyOfSpec(s) !== appsBranchKeyOfSpec(cur)) {
      cur.hitBranch = appsBranchLabelOf(s, cur.branchSiblings);
    }
  }
  return out;
}
/* 按分支键找一条目录条目（同 id 多分支：下载 / 详情要指名哪一条）。
   候选表为空时**只回落 null，不许再回调 appsSpecById**（那条回落与 appsSpecById 互为递归，
   见 appsSpecById 上方注释：同 id 一条都没有时就栈溢出）。 */
function appsSpecOfBranch(id, ownerId) {
  const want = String(ownerId || "").trim();
  const list = appsSpecPoolAll().filter((s) => appsBranchIdOf(s) === String(id || ""));
  if (!want) return list[0] || null;
  return (
    list.find((s) => String(s.ownerId || "") === want) ||
    list.find((s) => String(s.owner || "") === want) ||
    null
  );
}
/* 「同作者」：云端条目与本机那一份的作者是否同一个人（更新按钮只在同作者时出现）。
   判定顺序：uid（都记过才判）→ username（账本）→ app.json 的作者名 → 两边都没信息按同作者。 */
function appsSameAuthor(spec) {
  const s = spec || {};
  const cloudId = String(s.ownerId || "").trim();
  const cloudName = String(s.owner || "").trim().toLowerCase();
  const localId = String(s.localOwnerId || "").trim();
  const localName = String(s.localOwner || "").trim().toLowerCase();
  if (localId || cloudId) return !!localId && !!cloudId && localId === cloudId;
  if (localName) return !!cloudName && localName === cloudName;
  const author = String(s.localAuthor || "").trim().toLowerCase();
  if (author) return !!cloudName && author === cloudName;
  return true;
}
/* 复制一段文本到系统剪贴板（校验值直接用，不再为它开小窗）。
   复用设置页那条三级链路（settingsClipboardWrite：navigator → preload 桥 → execCommand，
   定义在 app-settings.js，本文件先加载，所以调用期探测 typeof）；链路不在时自己走
   preload 桥 / execCommand 兜底，绝不假装复制成功。返回 Promise<boolean>。 */
function appsCopyText(txt) {
  const s = String(txt == null ? "" : txt);
  if (!s) return Promise.resolve(false);
  if (typeof settingsClipboardWrite === "function")
    return Promise.resolve(settingsClipboardWrite(s))
      .then((r) => !!(r && r.ok === true))
      .catch(() => false);
  const viaBridge = () => {
    try {
      if (window && window.api && typeof window.api.clipboardWriteText === "function")
        return Promise.resolve(window.api.clipboardWriteText(s)).then((r) => !!(r && r.ok === true));
    } catch (_) {}
    return Promise.resolve(false);
  };
  const viaExec = () => {
    try {
      if (!document.body || !document.execCommand) return false;
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const done = document.execCommand("copy");
      document.body.removeChild(ta);
      return !!done;
    } catch (_) {
      return false;
    }
  };
  let first = null;
  try {
    const nb = navigator && navigator.clipboard;
    if (nb && typeof nb.writeText === "function") first = Promise.resolve(nb.writeText(s));
  } catch (_) {
    first = null;
  }
  if (first)
    return first.then(
      () => true,
      () => viaBridge().then((ok) => ok || viaExec()),
    );
  return viaBridge().then((ok) => ok || viaExec());
}
/* 「ⓘ 复制校验值」小按钮：界面上只摊算法名 + 前 8 位（长哈希不该摊在界面上），
   **点一下直接把完整校验值复制进剪贴板**（本轮需求：不再开「点开看全文」的小窗），
   复制成功 / 失败各给一句 toast，仍走 persistent 口径 —— 全程没有任何浮层。 */
function appsHashBtnEl(label, value) {
  const v = String(value || "").trim();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mini apps-hashbtn";
  const short = v ? v.slice(0, 8) : "";
  btn.textContent = "ⓘ " + appsT(label == null ? "" : label) + (short ? " · " + short : "");
  btn.title = appsT("点一下复制完整校验值");
  btn.disabled = !v;
  btn.onclick = () => {
    appsCopyText(v).then((ok) =>
      appsToast(ok ? appsT("已复制校验值") : appsT("复制失败：请手动复制"), ok ? "ok" : "warn"),
    );
  };
  return btn;
}
/* 开发者信息折叠区（详情里那一块技术字段）：默认收起，校验小按钮也放在这一区 ——
   普通用户看到的是标题 / 版本 / 作者 / 说明，要看细节的人展开就看得到。 */
function appsDevMetaEl(rows, hash) {
  const d = document.createElement("details");
  d.className = "apps-devmeta";
  const sum = document.createElement("summary");
  sum.textContent = appsT("开发者信息");
  d.appendChild(sum);
  const table = document.createElement("div");
  table.className = "apps-detail-rows";
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "apps-detail-row";
    const kk = document.createElement("span");
    kk.className = "apps-detail-k";
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.className = "apps-detail-v";
    vv.textContent = v;
    vv.title = v;
    row.appendChild(kk);
    row.appendChild(vv);
    table.appendChild(row);
  }
  if (hash && String(hash.value || "").trim()) {
    const row = document.createElement("div");
    row.className = "apps-detail-row";
    const kk = document.createElement("span");
    kk.className = "apps-detail-k";
    kk.textContent = appsT("安装包校验");
    const vv = document.createElement("span");
    vv.className = "apps-detail-v";
    vv.appendChild(appsHashBtnEl(hash.label || "复制校验值", hash.value));
    row.appendChild(kk);
    row.appendChild(vv);
    table.appendChild(row);
  }
  d.appendChild(table);
  return d;
}

/* ─────────── 作者视角的线上条目：mine / 版本树（docs/apps-market.md §七） ───────────
 * 公开目录（静态 catalog.json）不一定带上作者自己那一条，作者也看不出哪条是自己的。
 * 所以登录后额外拉一次接口（owner = 自己），成功就把结果缓存起来；
 * 拉不到（没登录 / 断网 / 服务端没这个参数）就**静静跳过** —— 公开目录照常显示，绝不因此报错。
 *
 * ⚠ owner 必须是**账号标识串**（uid 优先、退账号名），走 appsMineOwnerKey() 那一个口径 ——
 *   绝不把 appsAuthUser() 的**用户对象**塞进 URL！encodeURIComponent({…}) 得到的是
 *   "%5Bobject%20Object%5D"，服务端按它过滤 owner 一条都匹配不上 → 回 { items: [] }，
 *   这里就把「我的线上条目」当成「我一条都没有」缓存下来。
 *   线上现场（2026-10，云端确有一条作者自己的应用 sudoku）：
 *   应用页 = 公开目录（空）+ 我的线上条目（被这句写坏的 owner 拉空）→ 首屏「无内容」；
 *   而「我的应用」页走 appsMineOwnerKey() 发的是 uid → 有内容，切过去 / 重开（沿用上次那页）
 *   就「有了」—— 用户报的「第一次进入应用商店无法获取内容，关闭后再开或切换就有了」正是这一条。 */
async function appsMineLoad(force) {
  if (!force && APPS_ST.mine && Date.now() - APPS_ST.mineAt < APPS_CAT_TTL) return APPS_ST.mine;
  const api = window.api || {};
  const me = appsMineOwnerKey();
  if (!me || typeof api.storeRequest !== "function") {
    APPS_ST.mine = null;
    return null;
  }
  let r = null;
  try {
    r = await api.storeRequest({
      method: "GET",
      path: "/api/apps?owner=" + encodeURIComponent(me) + "&pageSize=50",
    });
  } catch (_) {
    r = null;
  }
  const items = r && r.ok !== false && r.data && Array.isArray(r.data.items) ? r.data.items : null;
  if (!items) {
    APPS_ST.mine = null;
    return null;
  }
  const byId = Object.create(null);
  for (const it of items) if (it && it.id) byId[String(it.id)] = it;
  APPS_ST.mine = { ok: true, at: Date.now(), byId: byId };
  APPS_ST.mineAt = Date.now();
  return APPS_ST.mine;
}
/* 目录条目 × 我的线上条目：mine / 版本树以接口那份为准（更新更全） */
function appsMineOf(id) {
  const m = APPS_ST.mine;
  return (m && m.byId && m.byId[String(id || "")]) || null;
}

/* ─────────── 打赏汇总（卡片金币 icon 的悬停数据来源） ───────────
 * 需求口径：**已打赏的应用从外部 hover 要显示真实的累计（N 币 · M 次）**，不能写「无人打赏」。
 * 数据来源三条，优先级从高到低：
 *   ① GET /api/tips/summary?kind=app&ids=…（本轮新增，免登录、批量、只回公开数字）；
 *   ② 静态目录条目自带的 tips（服务端 appCatalogDoc 写进 catalog.json 的那一份）；
 *   ③ 都没有 → 「打赏数据暂未取到」/「还没有人打赏」由 appsTipsTitleOf 分辨（绝不谎报）。
 * 触发时机：应用列表**载入 / 刷新时**问一次（打开页、切回来、手动刷新、打赏成功后），
 * 不是悬停那一刻才问 —— 悬停是最频繁的动作，不能让它等网络。 */

/** 一次问的 id 集合签名：排序 + 拼接，用来判断「这批 id 已经问过了」。 */
function appsTipsSigOf(ids) {
  return (Array.isArray(ids) ? ids : [])
    .map((x) => String(x || ""))
    .filter(Boolean)
    .sort()
    .join(",");
}
/** 现在这一页需要打赏汇总的全部应用 id（同 id 多分支只需问一次）。 */
function appsTipsIdsOf(list) {
  const out = [];
  const seen = Object.create(null);
  for (const s of list || []) {
    const id = appsBranchIdOf(s);
    if (!id || seen[id]) continue;
    seen[id] = 1;
    out.push(id);
  }
  return out;
}
/** 单个应用的打赏汇总：接口那一份优先，缺失时用目录条目自带的 tips（老目录 / 接口没答上也聊胜于无）。
 *  · 接口那份（APPS_ST.tips.byId，GET /api/tips/summary 的批量回执）**只要问回来过就以它为准，
 *    哪怕它是 0** —— 它比目录条目新（目录自带的可能是老目录 / 上一版的旧数字）；
 *  · 没问回来过才退回目录条目自带的 tips；两份都没有时回 null（**不是** {count:0}）——
 *    调用方据此说「打赏数据暂未取到」，绝不谎报成「还没有人打赏」（用户报的错报就是这个）。
 *  **本函数是「打赏累计」的唯一取数口径**：列表卡片（appsSpecWithTips）与详情窗
 *  （appsDetailBodyEl 那行「打赏记录 N 币」）都走它 —— 两边不会再出现「一个说有、一个说没有」。 */
function appsTipsOf(spec) {
  const id = appsBranchIdOf(spec);
  const cached = id && APPS_ST.tips && APPS_ST.tips.byId ? APPS_ST.tips.byId[id] : null;
  if (!cached) {
    const t = spec && spec.tips;
    if (t && (Number(t.count) || Number(t.totalYuan))) {
      return { count: Number(t.count) || 0, totalYuan: Number(t.totalYuan) || 0 };
    }
    return null;
  }
  /* 缓存里有这个 id 就以它为准（口径见上面的注释） */
  return { count: Number(cached.count) || 0, totalYuan: Number(cached.totalYuan) || 0 };
}
/** 把汇总合并进条目（不改原对象：目录缓存要留着原样） */
function appsSpecWithTips(spec) {
  const t = appsTipsOf(spec);
  if (!t) return spec;
  return Object.assign({}, spec, { tips: t });
}

/**
 * 拉一次打赏汇总（force = 跳过新鲜期）。
 * 失败也**不抛**：记一个 tipsFailed，界面据此说「打赏数据暂未取到」，金币 icon 照旧可点。
 * @param {string[]} ids 要问的应用 id
 * @param {boolean} force 跳过新鲜期（手动刷新 / 打赏成功后）
 */
async function appsTipsLoad(ids, force) {
  const api = window.api || {};
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x || "")).filter(Boolean);
  const sig = appsTipsSigOf(list);
  if (!list.length || typeof api.storeRequest !== "function") return APPS_ST.tips;
  if (!force && sig === APPS_ST.tipsAsked && Date.now() - APPS_ST.tipsAt < APPS_TIPS_TTL) return APPS_ST.tips;
  APPS_ST.tipsAsked = sig;
  APPS_ST.tipsBusy = true;
  let r = null;
  try {
    r = await api.storeRequest({
      method: "GET",
      path: "/api/tips/summary?kind=app&ids=" + encodeURIComponent(list.slice(0, 100).join(",")),
    });
  } catch (err) {
    r = { ok: false, error: (err && err.message) || String(err) };
  }
  APPS_ST.tipsBusy = false;
  const items = r && r.ok !== false && r.data && Array.isArray(r.data.items) ? r.data.items : null;
  if (!items) {
    /* 取不到：**保留上一次的数字**（有旧值也比突然说「没人打赏」强），只标记失败 */
    APPS_ST.tipsFailed = true;
    APPS_ST.tipsErr = String((r && (r.error || (r.data && r.data.error))) || "");
    return APPS_ST.tips;
  }
  const byId = Object.create(null);
  if (APPS_ST.tips && APPS_ST.tips.byId) {
    for (const k of Object.keys(APPS_ST.tips.byId)) byId[k] = APPS_ST.tips.byId[k];
  }
  for (const it of items) {
    const id = String((it && it.id) || "");
    if (!id) continue;
    byId[id] = { count: Number(it.count) || 0, totalYuan: Number(it.totalYuan) || 0 };
  }
  APPS_ST.tips = { ok: true, at: Date.now(), byId: byId, count: items.length };
  APPS_ST.tipsAt = Date.now();
  APPS_ST.tipsFailed = false;
  APPS_ST.tipsErr = "";
  return APPS_ST.tips;
}

/**
 * 列表载入 / 刷新时调它：把当前这一页要问的 id 交给 appsTipsLoad，问到就把页面重绘一次
 * （重绘后才带得上悬停文案）。**同一批 id 只问一次**（APPS_ST.tipsAsked 记着）：
 * 失败也不重问 —— 否则「重绘 → 再问 → 再重绘」会自己转圈。
 */
function appsTipsEnsure(list, force) {
  const ids = appsTipsIdsOf(list);
  if (!ids.length) return;
  const sig = appsTipsSigOf(ids);
  if (!force && sig === APPS_ST.tipsAsked && Date.now() - APPS_ST.tipsAt < APPS_TIPS_TTL) return;
  appsTipsLoad(ids, force).then(() => {
    if (!APPS_HUB_OPEN) return;
    if (appsTipsSigOf(appsTipsIdsOf(appsSpecPoolAll())) !== APPS_ST.tipsAsked) return;
    appsHubPaint();
  }).catch(() => {});
}
function appsSpecWithMine(spec) {
  const mine = appsMineOf(spec && spec.id);
  if (!mine) return spec;
  const versions =
    Array.isArray(mine.versions) && mine.versions.length ? mine.versions : spec.versions;
  const out = Object.assign({}, spec, {
    mine: true,
    latestVersion: String(mine.latestVersion || spec.latestVersion || spec.version || ""),
    version: String(mine.version || spec.version || ""),
    versions: versions,
    owner: String(mine.owner || spec.owner || ""),
    /* 作者显示名（昵称）：接口那份（mine）优先，缺了就用目录那份 —— 界面只读它 */
    ownerName: String(mine.ownerName || spec.ownerName || ""),
    ownerId: String(
      mine.ownerId || (mine.ownerUser && mine.ownerUser.id) || spec.ownerId || "",
    ),
    forkOf: appsNormForkOf(mine.forkOf) || appsNormForkOf(spec.forkOf),
  });
  return appsSpecPatchStoreUrls(out);
}
/* 云端**接口**目录（含接口回执拼出来的条目）：icon / zipUrl 都是「相对接口」的写法，
   渲染层不推导，一律换成接口 URL（主进程安装时同样按 /api/apps/<id>/file?format=raw 下载）。
   只补还缺的（urls.icon），不覆盖主进程已经解析好的值。 */
function appsSpecPatchStoreUrls(spec) {
  const st = APPS_ST.cat || {};
  const storeBase = String(st.sourceBase || "").trim();
  const isStore = st.source === "api" || st.source === "cache";
  if (!storeBase || !isStore || !spec) return spec;
  /* 条目自己声明了静态来源时不要替换（静态与接口两个 host 一般相同，这只是保守起见） */
  if (String(spec.source || "") === "static") return spec;
  const id = String(spec.id || "");
  if (!id) return spec;
  const urls = Object.assign({}, spec.urls || {});
  if (!urls.icon) {
    const rel = String(spec.icon || "").trim().replace(/^\.\//, "");
    if (rel && !/^https?:\/\//i.test(rel) && !/^data:image\//i.test(rel) && (rel.indexOf("/") <= 0 || rel.startsWith("icons/"))) {
      urls.icon = storeBase + "/api/apps/" + encodeURIComponent(id) + "/icon";
    }
  }
  /* 封面缩略图（卡片 16:9 背景图）同源补一次：接口这条路由是懒生成 + 落盘缓存
     （store-saas/server.mjs；**源 = 上架截图第 1 张**，没有截图才是图标）。
     地址口径与 icon 同一条：服务端下发的 thumb 是**静态目录的相对写法**
     （icons/<主干>[__shot].png），接口侧没有 icons/ 这条静态路由 —— 直拼就是线上 404
     （封面先白跑两次请求、再一路退到原图 / 图标，卡片上等于拿不到封面），接口来源必须换成
     /api/apps/<id>/thumb（那条路由自己知道封面源）。
     判「基址是不是接口」看 source 与 sourceUrl 两处（**不能只看 source === "cache"**：
     缓存可能是从静态目录写下的，那时 base 就是静态基址，相对路径直拼才对）。
     没有 thumb 字段（老服务端）时仍按 icon 推一条 /thumb，行为与改动前一致。 */
  const apiBase =
    st.source === "api" || /\/api\/apps\/catalog(\?|$)/.test(String(st.sourceUrl || ""));
  if (!urls.thumb) {
    const rel = String(spec.thumb || "").trim().replace(/^\.\//, "");
    if (rel && /^https?:\/\//i.test(rel)) urls.thumb = rel;
    else if (rel && apiBase) {
      urls.thumb = storeBase.replace(/\/+$/, "") + "/api/apps/" + encodeURIComponent(id) + "/thumb";
    } else if (rel) {
      urls.thumb = storeBase.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
    } else if (urls.icon && !/^data:image\//i.test(urls.icon)) {
      urls.thumb = storeBase.replace(/\/+$/, "") + "/api/apps/" + encodeURIComponent(id) + "/thumb";
    }
  }
  return Object.assign({}, spec, { urls: urls });
}
/* 作者自己的线上条目：从接口回执拼一份与目录条目同形的 spec，
   这样作者在应用页也能看到自己那一支（公开目录里不一定有它）。 */
function appsSpecFromMine(item) {
  const id = String((item && item.id) || "");
  if (!id) return null;
  const local = appsLocalById(id);
  const title = String((item && item.title) || id);
  /* 自有条目只存在于接口回执里：字段照目录条目同形拼，再按接口口径把图标补成接口 URL */
  return appsSpecPatchStoreUrls({
    id: id,
    title: title,
    name: title,
    subtitle: "",
    description: String((item && (item.description || item.desc)) || ""),
    author: "",
    tags: Array.isArray(item && item.tags) ? item.tags : [],
    version: String((item && item.version) || ""),
    latestVersion: String((item && (item.latestVersion || item.version)) || ""),
    minAppVersion: "",
    compatible: true,
    entry: String((item && item.entry) || "index.html"),
    zipUrl: String((item && item.zipUrl) || ""),
    sha256: String((item && item.sha256) || ""),
    icon: String((item && item.icon) || ""),
    window: {},
    owner: String((item && item.owner) || ""),
    /* 作者显示名（昵称）：接口条目自带；自有条目也照目录条目同形带上 */
    ownerName: String((item && item.ownerName) || ""),
    ownerId: String((item && item.ownerId) || (item && item.ownerUser && item.ownerUser.id) || ""),
    forkOf: appsNormForkOf(item && item.forkOf),
    versions: Array.isArray(item && item.versions) ? item.versions : [],
    /* 「我的应用」页要用的三样（编辑框画现有截图、删除框数派生分支、列表按更新时间排序）：
       都是接口回执里本来就有的字段，原样带过来，不在这里重新推导。 */
    shots: Array.isArray(item && item.shots) ? item.shots.slice() : [],
    thumb: String((item && item.thumb) || ""),
    updatedAt: Number((item && item.updatedAt) || 0) || 0,
    /* 同 id 的其他作者分支（publicApp 的 branches[]）：删除确认框里数「另有 N 位作者」用它 */
    branches: Array.isArray(item && item.branches) ? item.branches.slice() : [],
    mine: true,
    installed: !!local,
    installedVersion: local ? String(local.version || "") : "",
    installedAt: local ? Number(local.installedAt) || 0 : 0,
    dir: local ? String(local.dir || "") : "",
    localDev: !!local && local.dev === true,
    localAuthor: local ? String(local.author || "") : "",
    localOwner: local ? String(local.owner || "") : "",
    localOwnerId: local ? String(local.ownerId || "") : "",
    localForkOf: (local && local.forkOf) || null,
    updateAvailable: false,
  });
}

/* ─────────── 版本树（§七）：一个应用收纳多个版本 ───────────
 * versions[] 按 parentVersion 串成缩进树。作者删掉某一版时接口**不留灰行**（包与记录一起下掉），
 * 于是孩子会悬空 —— 这里给那一层补一行「根版本（已删）」占位、孩子仍挂在它下面：
 * 版本从界面上消失是最不能接受的（用户会以为自己的包丢了）。环形 / 自指的脏数据平铺在末尾，
 * 一个版本都不可丢。 */
function appsVersionRows(spec) {
  const raw =
    Array.isArray(spec && spec.versions) && spec.versions.length
      ? spec.versions
      : [
          {
            version: String((spec && spec.version) || "0.0.0"),
            parentVersion: "",
            zipUrl: (spec && spec.zipUrl) || "",
            sha256: (spec && spec.sha256) || "",
            bytes: (spec && spec.bytes) || 0,
            uploader: (spec && spec.owner) || "",
            uploaderName: String((spec && spec.ownerName) || ""),
            note: "",
            createdAt: 0,
          },
        ];
  const nodes = Object.create(null);
  const order = [];
  for (const v of raw) {
    const ver = String((v && v.version) || "").trim();
    if (!ver || nodes[ver]) continue;
    nodes[ver] = { key: ver, item: v, missing: false, children: [], parent: "", at: Number(v && v.createdAt) || 0 };
    order.push(ver);
  }
  for (const ver of order) {
    const p = String(nodes[ver].item.parentVersion || "").trim();
    if (!p || p === ver) continue;
    nodes[ver].parent = p;
    if (!nodes[p]) nodes[p] = { key: p, item: null, missing: true, children: [], parent: "", at: 0 };
    nodes[p].children.push(ver);
  }
  const cmp = (a, b) => {
    const x = nodes[a];
    const y = nodes[b];
    if (x.at !== y.at) return x.at - y.at;
    return String(a).localeCompare(String(b), "en", { numeric: true });
  };
  for (const k of Object.keys(nodes)) nodes[k].children.sort(cmp);
  const roots = Object.keys(nodes)
    .filter((k) => !nodes[k].parent || !nodes[nodes[k].parent])
    .sort(cmp);
  const cur = String((spec && (spec.latestVersion || spec.version)) || "");
  const rows = [];
  const seen = Object.create(null);
  const walk = (key, depth) => {
    if (seen[key]) return;
    seen[key] = 1;
    const n = nodes[key];
    rows.push({
      version: key,
      item: n.item,
      depth: depth,
      missing: n.missing,
      current: !n.missing && key === cur,
    });
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const k of Object.keys(nodes).filter((k) => !seen[k]).sort(cmp)) walk(k, 0);
  return rows;
}

/* 版本树那一块：每行 = 版本号 · 时间 · 大小 · 上传者 · 版本说明 · 状态（最新 / 本机已装）+ 下载这一版。
   只有一版时不画（详情里那行「版本」已经说清了，多一块只是噪音）。 */
function appsVersionTreeEl(spec) {
  const rows = appsVersionRows(spec);
  if (rows.length <= 1) return null;
  const box = document.createElement("div");
  box.className = "apps-vers";
  const real = rows.filter((r) => !r.missing).length;
  const head = document.createElement("div");
  head.className = "apps-vers-head";
  head.textContent =
    appsT("版本") + "（" + real + appsT(" 版") + (spec.latestVersion ? appsT(" · 最新 v") + spec.latestVersion : "") + "）";
  box.appendChild(head);
  const local = appsLocalById(spec.id);
  const busy = !!APPS_ST.busy[spec.id];
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "apps-vers-row" + (r.missing ? " is-gone" : "") + (r.current ? " is-cur" : "");
    row.style.paddingLeft = String(10 + r.depth * 18) + "px";
    if (r.depth) {
      const br = document.createElement("span");
      br.className = "apps-vers-branch";
      br.textContent = "└";
      row.appendChild(br);
    }
    const ver = document.createElement("span");
    ver.className = "apps-vers-ver";
    ver.textContent = r.missing ? appsT("根版本（已删）") : "v" + r.version;
    row.appendChild(ver);
    if (!r.missing) {
      const bits = [];
      if (r.item.createdAt) bits.push(appsTime(r.item.createdAt));
      if (r.item.bytes) bits.push(appsBytes(r.item.bytes));
      const upWho = appsUploaderOf(r.item);
      if (upWho) bits.push(appsT("上传者 ") + upWho);
      if (bits.length) {
        const meta = document.createElement("span");
        meta.className = "apps-vers-meta";
        meta.textContent = bits.join(" · ");
        row.appendChild(meta);
      }
      if (r.item.note) {
        const nt = document.createElement("span");
        nt.className = "apps-vers-note";
        nt.textContent = r.item.note;
        nt.title = r.item.note;
        row.appendChild(nt);
      }
      const tags = document.createElement("span");
      tags.className = "apps-vers-tags";
      if (r.current) {
        const b = document.createElement("span");
        b.className = "apps-badge apps-badge-on";
        b.textContent = appsT("最新");
        tags.appendChild(b);
      }
      if (local && String(local.version || "") === r.version) {
        const b = document.createElement("span");
        b.className = "apps-badge";
        b.textContent = appsT("本机已装");
        tags.appendChild(b);
      }
      row.appendChild(tags);
      const dl = appsMiniBtn(appsT("下载这一版"), () =>
        appsDownload(spec.id, spec.installed ? "update" : "", r.version, String(spec.ownerId || "")),
      );
      dl.className += " apps-vers-dl";
      dl.disabled = busy || spec.compatible === false;
      row.appendChild(dl);
    }
    box.appendChild(row);
  }
  return box;
}

/* 下架 / 重新发布**已整体移除**（本轮共识）：作者侧不再有「下架」，控制台也不再有
 * 「重新发布」—— 要撤下应用就走删除（不可恢复），删除入口在「编辑应用」窗的底部。
 * 服务端的 POST /api/apps/:id/(unpublish|publish) 路由与相关冒烟断言一并删除。
 * 这条注释留在原地，是为了让下一个读到这里的人一眼看出「这里原来有什么、为什么没有」。 */

/* ───────────────── 独立窗口状态（打开 / 关闭按钮面跟随） ───────────────── */

async function appsIsWindowOpen(id) {
  const api = window.api || {};
  if (typeof api.appsIsOpen !== "function") return false;
  try {
    const r = await api.appsIsOpen(id);
    return !!(r && r.ok !== false && r.open);
  } catch (_) {
    return false;
  }
}

/* 一次问齐「这些应用里哪些开着独立窗口」：返回 { id: true }。
   为什么批量问（本轮 1000 条场景）：库页原来对每个已装应用各发一次 IPC，装了几百个就是几百次
   往返；更要紧的是卡片改成窗口化渲染后，离屏卡不在 DOM 里，原来那种逐张回贴贴不到。 */
async function appsOpenIdsOf(list) {
  const api = window.api || {};
  const out = {};
  const arr = Array.isArray(list) ? list : [];
  if (typeof api.appsIsOpen !== "function") return out;
  await Promise.all(
    arr.map(async (app) => {
      const id = String((app && app.id) || "");
      if (!id) return;
      if (await appsIsWindowOpen(id)) out[id] = true;
    }),
  );
  return out;
}

/* ───────────────── 开发绑定状态（当前画布 × 应用目录） ───────────────── */

/* 一个应用目录被哪些**自己带 devPath 的**开发节点块当作项目根：这就是「开发绑定」。
   子块走 devPathOf 就近继承，不算一处独立绑定，所以这里只认节点自身的 devPath。 */
function appsDevBlocksOf(dir) {
  const out = [];
  const wf = typeof S !== "undefined" && S ? S.wf : null;
  if (!wf || !Array.isArray(wf.nodes)) return out;
  const norm = (p) =>
    String(p || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  const target = norm(dir);
  if (!target) return out;
  for (const n of wf.nodes) {
    if (!n) continue;
    if (typeof devIsDevBlock === "function" && !devIsDevBlock(n)) continue;
    if (norm(n.devPath) !== target) continue;
    out.push(n);
  }
  return out;
}
function appsDevBindingOf(app) {
  const blocks = appsDevBlocksOf(app && app.dir);
  return {
    bound: blocks.length > 0,
    blocks: blocks,
    titles: blocks.map((n) => String(n.title || "")).filter(Boolean).slice(0, 3),
  };
}

/* ───────────────── 浮层页宿主（#appsHub） ───────────────── */

function appsHubEnsure() {
  let host = appsHubEl();
  if (host) return host;
  host = document.createElement("div");
  host.id = "appsHub";
  host.className = "apps-hub";
  host.hidden = true;
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  /* 没有标题栏：左侧第一行只留「应用」品牌；正文顶部第 1 行（.apps-hub-topbar 里的
     .apps-hub-toprow）＝搜索框 + 最右的「返回 MTNode」——出口放在**右上角**（用户按窗口
     右上角找出口的习惯），按钮写全名而不是一个 ✕；页名与副标题不再各占一行重复一遍。 */
  host.innerHTML =
    '<aside class="apps-hub-side">' +
    '<div class="apps-hub-sidehead">' +
    '<div class="apps-hub-brand"></div>' +
    "</div>" +
    '<nav class="apps-hub-nav" role="tablist"></nav>' +
    '<div class="apps-hub-sidefoot"></div>' +
    "</aside>" +
    '<section class="apps-hub-main">' +
    '<div class="apps-hub-topbar"></div>' +
    '<div class="apps-hub-body"></div>' +
    "</section>";
  /* 挂 document.body：position:fixed inset:0 → 连顶栏（菜单栏）也一起盖住（顶栏与应用开发
     无关，进来就整屏交给应用开发），#overlay（z-index 100）仍然压在本页之上。 */
  document.body.appendChild(host);

  appsHubTopbar(host);
  host.querySelector(".apps-hub-close").onclick = () => appsHubClose();
  host.querySelector(".apps-hub-nav").addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest("[data-nav]") : null;
    if (!btn) return;
    appsHubNav(btn.dataset.nav);
  });
  return host;
}

function appsHubPaintNav(host) {
  const nav = host.querySelector(".apps-hub-nav");
  nav.innerHTML = "";
  for (const [id, label] of APPS_NAV) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "apps-hub-navbtn" + (APPS_ST.nav === id ? " on" : "");
    b.dataset.nav = id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", APPS_ST.nav === id ? "true" : "false");
    b.textContent = appsT(label);
    nav.appendChild(b);
  }
  const brand = host.querySelector(".apps-hub-brand");
  if (brand) brand.textContent = appsT("应用");
  const foot = host.querySelector(".apps-hub-sidefoot");
  if (foot) {
    /* 页脚只留项目根这一行（下载根那一行与条数行都下线：根路径在「库」页各有自己的一行，
       这里再抄一遍纯属冗余）。 */
    const roots = (APPS_ST.list && APPS_ST.list.roots) || {};
    const dev = String(((roots.dev || {}) || {}).path || "");
    foot.innerHTML =
      '<div class="apps-hub-footline" title="' + appsEscape(dev) + '">' +
      appsEscape(appsT("项目根目录（开发中的应用）")) +
      "：" +
      (dev ? appsEscape(dev) : appsEscape(appsT("未设置"))) +
      "</div>";
  }
}

/* ───────────────── 正文顶部：第 1 行＝搜索框（带防抖）+ 右上角「返回 MTNode」，第 2 行＝标签筛选 ─────────────────
 *
 * 分两行（本次修「出口单占一行」）：出口与搜索框同在第 1 行（.apps-hub-toprow，nowrap），
 * 由弹性占位推到最右 —— 以前「搜索 → 标签条 → 占位 → 返回钮」的 DOM 顺序会让标签条
 * （flex:1 1 100%）先折到第 2 行，把返回钮顶到**第 3 行单独占一行**（顶区 3 行、第 1 行右侧
 * 一片空白）。现在顺序改成「第 1 行：[搜索][占位][返回] → 第 2 行：标签条」，顶区 2 行。
 * 第 1 行 nowrap：窗口再窄按钮也不落到下一行，只压搜索框（200px → 下限 120px）。
 *
 * 位置不变（正文顶部、左导航右侧），但**DOM 不再挂在 .apps-hub-body 里**：正文本页每次
 * 重绘都整块换掉（body.innerHTML = ""），搜索框跟着一起被拆掉 —— 这就是「输入一个字就
 * 失焦」的根因（重建的输入框拿不到焦点，中文输入法连组合态一起断）。现在这一行是
 * #appsHub 的固定壳（.apps-hub-topbar），只建一次、活到本页关闭，重绘只换它下面的正文。
 *
 * 防抖：打字时**只**更新 APPS_ST.q，180ms 静默后才重绘一次（见 APPS_SEARCH_DEBOUNCE）。
 * 「点标签」「清除筛选」这类显式动作不等防抖（appsSearchFlush 先把待办落地再画），
 * 否则用户会看到「点了标签但列表还是上一秒的样子」。
 *
 * 标签筛选：条上的标签从当前能看到的条目里收集（云端目录 + 本机已有），选中的取 OR
 * （多选即「任选其一」，不越选越空）；与搜索词同时生效时取交集。 */

/* 标签去重用的键：大小写 / 前后空白不敏感，值保留第一次见到的原样 */
function appsTagKey(s) {
  return String(s == null ? "" : s).trim().toLowerCase();
}
function appsTagsOf(spec) {
  return Array.isArray(spec && spec.tags) ? spec.tags : [];
}

/* 输入防抖：只改状态，静默满 APPS_SEARCH_DEBOUNCE 才重绘一次 */
function appsSearchSchedule() {
  if (APPS_SEARCH_TIMER) clearTimeout(APPS_SEARCH_TIMER);
  APPS_SEARCH_TIMER = setTimeout(() => {
    APPS_SEARCH_TIMER = 0;
    if (!APPS_HUB_OPEN) return;
    appsHubPaint();
  }, APPS_SEARCH_DEBOUNCE);
}
/* 显式动作（点标签 / 清除筛选 / 切页）要立刻见效：把待办的那次重绘先落地 */
function appsSearchFlush() {
  if (!APPS_SEARCH_TIMER) return;
  clearTimeout(APPS_SEARCH_TIMER);
  APPS_SEARCH_TIMER = 0;
}

/* 当前可选的标签：来自**未经过滤**的条目（搜索词不该把标签条本身越缩越短 ——
   否则打错一个字连想选的标签都消失了），按出现次数降序、同次数按拼音序。 */
function appsTagCatalog() {
  const map = new Map();
  const add = (spec) => {
    for (const raw of appsTagsOf(spec)) {
      const key = appsTagKey(raw);
      if (!key) continue;
      const hit = map.get(key);
      if (hit) hit.n++;
      else map.set(key, { key: key, label: String(raw).trim(), n: 1 });
    }
  };
  for (const s of appsSpecListAll()) add(s);
  return [...map.values()].sort(
    (a, b) => b.n - a.n || a.label.localeCompare(b.label, "zh"),
  );
}
/* 条上要显示哪些标签：选中过的一律保留（哪怕这次一条命中都没有 —— 选了就得能取消），
   其余按热度补，最多 APPS_TAG_MAX 枚。传入的 cat 已按热度排序。 */
function appsTagShown(cat) {
  const out = [];
  const seen = new Set();
  for (const k of APPS_ST.tags) {
    const hit = cat.find((t) => t.key === k);
    out.push(hit || { key: k, label: k, n: 0 });
    seen.add(k);
  }
  for (const t of cat) {
    if (out.length >= APPS_TAG_MAX) break;
    if (seen.has(t.key)) continue;
    out.push(t);
    seen.add(t.key);
  }
  return out;
}
/* 标签条文案里显示的名字（用原始标签，不用小写化的 key）：cat 为 appsTagCatalog() 的结果 */
function appsTagLabel(cat, key) {
  const k = appsTagKey(key);
  const hit = (cat || []).find((t) => t.key === k);
  return hit ? hit.label : k;
}
function appsTagSelIndex(key) {
  const k = appsTagKey(key);
  return APPS_ST.tags.indexOf(k);
}
function appsTagToggle(key) {
  const k = appsTagKey(key);
  if (!k) return;
  const i = appsTagSelIndex(k);
  if (i >= 0) APPS_ST.tags.splice(i, 1);
  else APPS_ST.tags.push(k);
  appsSearchFlush();
  appsHubPaint();
}
function appsTagsClear() {
  if (!APPS_ST.tags.length) return;
  APPS_ST.tags = [];
  appsSearchFlush();
  appsHubPaint();
}

/* 搜索词（小写 / 去空白）+ 标签筛选：两件事各一个判据，命中为空时给出可读的原因 */
/* 同 id 多分支（§十）：合并成一条之后就是「一条结果」（命中任一分支都显示这一条卡，
   卡上标出命中分支的作者，q36）。标签筛选同理。 */
function appsFilterSpecs(list) {
  const q = String(APPS_ST.q || "").trim().toLowerCase();
  const tags = APPS_ST.tags;
  const merged = appsMergeSameId(list);
  let out = merged;
  if (tags.length) {
    out = out.filter((s) =>
      appsTagsOf(s).some((t) => tags.indexOf(appsTagKey(t)) >= 0),
    );
  }
  if (q) {
    out = out.filter((s) => {
      const branches = Array.isArray(s.branchSiblings) ? s.branchSiblings : [];
      const hay = (
        appsSpecTitle(s) +
        " " +
        appsSpecSub(s) +
        " " +
        String(s.description || "") +
        " " +
        String(s.id || "") +
        " " +
        appsTagsOf(s).join(" ") +
        " " +
        /* 同 id 的其他分支也要能搜到（作者名、标题） */
        branches.map((b) => appsBranchLabelOf(b, branches) + " " + appsSpecTitle(b)).join(" ")
      ).toLowerCase();
      if (hay.indexOf(q) >= 0) return true;
      /* 支持「按作者找这一条」：搜索词命中某一分支作者时，卡上标出是哪一支 */
      const hit = branches.find((b) => appsBranchLabelOf(b, branches).toLowerCase().indexOf(q) >= 0);
      if (hit) {
        s.hitBranch = appsBranchLabelOf(hit, branches);
        return true;
      }
      return false;
    });
  }
  return out;
}
/* 一行「当前筛选」摘要（有筛选时才出现；用户一眼看出列表为什么短了） */
function appsFilterLineEl(total, shown) {
  const q = String(APPS_ST.q || "").trim();
  const tags = APPS_ST.tags;
  if (!q && !tags.length) return null;
  const bits = [];
  const cat = appsTagCatalog();
  if (q) bits.push(appsT("关键词「") + q + appsT("」"));
  if (tags.length) bits.push(appsT("标签：") + tags.map((k) => appsTagLabel(cat, k)).join(" · "));
  const el = document.createElement("div");
  el.className = "apps-filterline";
  el.textContent =
    appsT("筛选：") + bits.join(appsT(" · ")) + appsT(" —— 命中 ") + shown + " / " + total + appsT(" 个应用");
  const clear = appsMiniBtn(appsT("清除筛选"), () => {
    APPS_ST.q = "";
    const inp = appsHubEl() ? appsHubEl().querySelector(".apps-hub-search") : null;
    if (inp) inp.value = "";
    APPS_ST.tags = [];
    appsSearchFlush();
    appsHubPaint();
  });
  clear.className = "mini apps-filterline-clear";
  el.appendChild(clear);
  return el;
}

/* 搜索框本体：只建一次（壳的一部分），页名切换时改 placeholder 不用重建 */
function appsHubSearchRow() {
  const row = document.createElement("div");
  row.className = "apps-hub-headacts";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "apps-hub-search";
  search.setAttribute("autocomplete", "off");
  search.setAttribute("spellcheck", "false");
  search.placeholder = appsT("搜索应用…");
  if (search.value !== APPS_ST.q) search.value = APPS_ST.q;
  /* 打字只改 APPS_ST.q；重绘等防抖（不重绘 = 输入框与焦点都不动，中文候选框也不被打断）。
     输入框本身不在重绘范围内，所以哪怕防抖到期重绘，焦点与光标也仍在用户手里。 */
  search.addEventListener("input", () => {
    APPS_ST.q = search.value;
    appsSearchSchedule();
  });
  row.appendChild(search);
  /* 搜索框之后 = 手动刷新入口（本轮需求）：「从云端重新拉取应用目录」。
     它建在**壳**的第 1 行里（.apps-hub-topbar 的 .apps-hub-headacts），与搜索框同一份待遇 ——
     正文每次重绘（body.innerHTML = ""）够不着它，所以它不随正文重绘被拆掉。
     图标 / 方框尺寸 / title 都走文件内既有的 appsIcoBtnEl + APPS_ICO_SVG 口径；
     点击只走 appsHubReloadNow（防重入 → appsHubRefresh({force:true})），不在这里另写一条拉取路径。
     其余三页（我的应用 / 库 / 开发）也看得见它：那几页的刷新由 appsHubReloadNow 额外作废
     本机列表与「我的应用」缓存（见那里的注释）。 */
  const reload = appsIcoBtnEl("refresh", appsT("刷新云端应用目录"), () => appsHubReloadNow());
  reload.id = "appsHubReload";
  reload.classList.add("apps-hub-reload");
  reload.setAttribute("aria-label", appsT("重新从云端拉取应用目录"));
  row.appendChild(reload);
  /* 「应用目录」（本轮需求：库页左上角、紧挨刷新的右边）：点它弹小菜单 ——
     更改下载根 / 在资源管理器中打开。菜单与按钮都在**壳**里（正文重绘拆不到它们），
     库页那一行「下载根目录 …」文案已按用户口径整条撤掉，路径改由这枚按钮的菜单显示。 */
  const rootBtn = appsIcoBtnEl("folder", appsT("应用目录：更改下载根 / 在资源管理器中打开"), () =>
    appsRootMenuToggle(),
  );
  rootBtn.id = "appsHubRootBtn";
  rootBtn.classList.add("apps-hub-rootbtn");
  rootBtn.setAttribute("aria-label", appsT("应用目录（下载到本机的应用都装在这里）"));
  row.appendChild(rootBtn);
  /* 列表 / 网格视图切换（本轮需求：应用 · 库 · 我的应用 三页可选列表模式，类似 Steam）：
     图标与 title 随**当前页当前模式**给「下一步动作」；状态按页写本机 localStorage。 */
  const viewBtn = document.createElement("button");
  viewBtn.type = "button";
  viewBtn.className = "mini apps-hub-viewbtn apps-ico-btn";
  viewBtn.id = "appsViewToggle";
  viewBtn.onclick = (ev) => {
    if (ev) ev.preventDefault();
    const nowList = appsViewToggleNow(APPS_ST.nav);
    appsToast(appsT(nowList ? "已切换成列表视图" : "已切换成卡片视图"), "ok");
    appsHubPaint();
  };
  row.appendChild(viewBtn);
  appsViewBtnSync();
  return row;
}

/* ── 列表 / 网格视图（本轮需求） ─────────────────────────────────────────
 * 状态与落盘都在 renderer/app-apps-list.js（window.AppsList，按页分别记住）；
 * 这里只负责三件事：壳上那枚切换按钮的图标 / 文案、开发页不出现、正文按模式分流。
 * 兜底：AppsList 没加载（老包 / 局部测试）时恒为网格模式 —— 一行都不会走到列表分支。 */
function appsViewIsList(nav) {
  const n = nav || APPS_ST.nav;
  try {
    return !!(window.AppsList && AppsList.isListMode && AppsList.isListMode(n));
  } catch (_) {
    return false;
  }
}
function appsViewToggleNow(nav) {
  const n = nav || APPS_ST.nav;
  try {
    return !!(window.AppsList && AppsList.toggleView && AppsList.toggleView(n));
  } catch (_) {
    return false;
  }
}
/** 切换按钮的外观（页名 / 模式都可能变，所以每次更新顶栏都调它） */
function appsViewBtnSync() {
  const btn = document.getElementById("appsViewToggle");
  if (!btn) return;
  const nav = APPS_ST.nav;
  const has = nav === "apps" || nav === "lib" || nav === "mine";
  btn.hidden = !has;
  if (!has) return;
  const list = appsViewIsList(nav);
  const svg = window.AppsList && AppsList.ICON ? (list ? AppsList.ICON.grids : AppsList.ICON.rows) : "";
  if (svg) btn.innerHTML = svg;
  btn.dataset.appsView = list ? "list" : "grid";
  btn.setAttribute("aria-pressed", list ? "true" : "false");
  btn.title = appsT(list ? "切回卡片网格视图" : "切换成列表视图（左列表 + 右详情）");
  btn.setAttribute("aria-label", btn.title);
}

/* 应用目录（下载根）小菜单：挂着就收、没挂就开（见 app-apps-list.js 的 rootMenuEl） */
function appsRootMenuToggle() {
  const open = document.querySelector(".apps-rootmenu");
  if (open) {
    if (typeof open.__appsClose === "function") open.__appsClose();
    else if (open.parentNode) open.parentNode.removeChild(open);
    return;
  }
  if (!window.AppsList || typeof AppsList.rootMenuEl !== "function") return;
  const anchor = document.getElementById("appsHubRootBtn");
  const bar = document.querySelector(".apps-hub-topbar .apps-hub-headacts");
  const made = AppsList.rootMenuEl(anchor);
  if (!made || !made.el) return;
  (bar || document.body).appendChild(made.el);
  if (typeof made.bind === "function") made.bind();
}
/* 切页 / 重绘时收掉还开着的根目录菜单（它挂在壳上，不随正文重绘消失） */
function appsRootMenuClose() {
  try {
    if (window.AppsList && AppsList.closeRootMenu) AppsList.closeRootMenu();
  } catch (_) {}
}

/* 标签筛选条：一行胶囊，点一下选中 / 再点一下取消；「清除标签」只在有选中时出现 */
function appsHubTagRow() {
  const row = document.createElement("div");
  row.className = "apps-hub-tags";
  const all = appsTagCatalog();
  const cat = appsTagShown(all);
  const sel = APPS_ST.tags;
  if (!cat.length) return row;
  const lead = document.createElement("span");
  lead.className = "apps-hub-tags-lead";
  lead.textContent = appsT("标签");
  row.appendChild(lead);
  for (const t of cat) {
    const on = appsTagSelIndex(t.key) >= 0;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "apps-tagchip" + (on ? " on" : "");
    chip.textContent = t.label + (t.n ? " " + t.n : "");
    chip.setAttribute("aria-pressed", on ? "true" : "false");
    chip.title = on
      ? appsT("取消这个标签的筛选：") + t.label
      : appsT("只看带这个标签的应用：") + t.label;
    chip.onclick = () => appsTagToggle(t.key);
    row.appendChild(chip);
  }
  /* 条上被截掉的标签：给一句实话，别让用户以为就这么多 */
  const more = all.length - cat.length;
  if (more > 0) {
    const tip = document.createElement("span");
    tip.className = "apps-hub-tags-more";
    tip.textContent = appsT("另有 ") + more + appsT(" 个标签（搜索或直接浏览找它）");
    row.appendChild(tip);
  }
  if (sel.length) {
    const clr = document.createElement("button");
    clr.type = "button";
    clr.className = "apps-tagchip apps-tagchip-clear";
    clr.textContent = appsT("清除标签");
    clr.title = appsT("取消全部标签筛选（搜索词保留）");
    clr.onclick = () => appsTagsClear();
    row.appendChild(clr);
  }
  return row;
}

/* 标签筛选条的显隐（唯一判定处）：**开发页与「我的应用」页不显示标签**（前者整屏交给三栏
   开发台、后者是作者自管页，筛选只有那一只搜索框），其余页照旧
   —— 仍有标签可筛才露脸（appsTagCatalog 为空时条上什么都没有，留着只是白占一行），
   已选中的标签一定还在条上（appsTagShown 的规矩），所以「有选中但目录空」也照样显示。
   重绘（appsHubTopbar）与换页（appsHubNav）都调它：切走立刻收起，切回来立刻还原。 */
function appsHubTagsHidden() {
  const bar = document.querySelector(".apps-hub-topbar");
  const row = bar ? bar.querySelector(".apps-hub-tags") : null;
  if (!row) return;
  row.hidden = APPS_ST.nav === "dev" || APPS_ST.nav === "mine" || !appsTagCatalog().length;
}

/* 正文顶部（幂等）：第 1 行 = 搜索框 + 右上角「返回 MTNode」，第 2 行 = 标签条。
   第 1 行（.apps-hub-toprow）是 **nowrap** 的：出口永远钉在这一行的最右，窗口再窄也不折到
   下一行去单占一行；空间不够只压搜索框（200px → 下限 120px，见 apps.css）。
   任何一次重绘都调它 —— 已就位就只更新页名 / 隐藏态，不重建节点。 */
function appsHubTopbar(host) {
  const hub = host || appsHubEl();
  if (!hub) return null;
  const bar = hub.querySelector(".apps-hub-topbar");
  if (!bar) return null;
  const name = APPS_NAV.some((n) => n[0] === APPS_ST.nav) ? APPS_ST.nav : "apps";
  if (!bar.dataset.built) {
    bar.dataset.built = "1";
    /* 第 1 行：搜索框 → 弹性占位 → 返回钮（同一行，nowrap；出口贴右上角、不单占一行） */
    const top = document.createElement("div");
    top.className = "apps-hub-toprow";
    top.appendChild(appsHubSearchRow());
    const spacer = document.createElement("div");
    spacer.className = "apps-hub-topspace";
    top.appendChild(spacer);
    const back = document.createElement("button");
    back.type = "button";
    back.className = "mini apps-hub-close";
    back.textContent = appsT("返回 MTNode");
    back.title = appsT("返回 MTNode 界面");
    back.onclick = () => appsHubClose();
    top.appendChild(back);
    bar.appendChild(top);
    /* 第 2 行：标签条整行（flex:1 1 100% 自己折行，永远在第 1 行之下） */
    bar.appendChild(appsHubTagRow());
  } else {
    /* 标签条整行重算（条目集变了）；万一它不在（不该发生），补回去（末尾 = 第 2 行）
       而不是把壳画崩 */
    const old = bar.querySelector(".apps-hub-tags");
    const next = appsHubTagRow();
    if (old) bar.replaceChild(next, old);
    else bar.appendChild(next);
  }
  const search = bar.querySelector(".apps-hub-search");
  if (search) {
    /* 搜索框只在「应用」与「我的应用」两页露脸（后者的搜索是**本地**过滤已拉回的自有条目：
       条目本来就不多，一页最多 50 条，不值得为它多打一次网络）。 */
    const searchable = name === "apps" || name === "mine";
    search.placeholder = appsT(name === "mine" ? "搜索我的应用（标题 / 描述 / 标签）…" : "搜索应用…");
    search.hidden = !searchable;
    if (document.activeElement !== search && search.value !== APPS_ST.q) search.value = APPS_ST.q;
  }
  /* 标签筛选条只在「应用」/「库」两页出现：**开发页不显示标签**（本轮需求）——
     那一页整屏交给三栏开发视图（左应用 / 中预览 / 右会话），标签筛选对它没有意义，
     挂着只会白占一行。判定只有 appsHubTagsHidden() 一处：切走再切回来时
     条上的标签照旧（选中态与热度排序都不动，只有 hidden 在变）。 */
  appsHubTagsHidden();
  /* 列表 / 网格切换钮的显隐与外观（页名一换就得跟着换） */
  appsViewBtnSync();
  const back = bar.querySelector(".apps-hub-close");
  if (back) {
    back.title = appsT("返回 MTNode 界面");
    back.textContent = appsT("返回 MTNode");
  }
  return bar;
}

/* 整页重绘：先画壳（左导航 / 按钮），再交给当前页填正文 */
function appsHubPaint() {
  const host = appsHubEl();
  if (!host) return;
  APPS_ST.host = host; /* 正文重绘要用它判断「上一次画的那一屏还在不在」（见 appsPaintSkippable） */
  APPS_LANG = window.I18n && I18n.getLocale ? I18n.getLocale() : "";
  const seq = ++APPS_ST.seq;
  /* 「应用目录」小菜单挂在**壳**上（不在正文里），所以重绘不会顺手把它拆掉 ——
     切页 / 刷新 / 装完应用这些路径都得显式收一次，免得它飘在一个已经换掉的页面上。 */
  appsRootMenuClose();
  appsHubPaintNav(host);
  /* 整页重绘前把登记中的封面图当场落定（本轮需求：重绘不留下半张半张的卡）——
     卡片网格是窗口化渲染的，重绘会把当前窗口那几张整批换掉，图必须先到位。 */
  appsImgFlush();
  /* 开发页三栏宽度与把手由 appsDevPagePaint / appsDevBindCols 负责（本页重绘只换正文，
     左导航是固定 176px、没有把手） */
  /* 正文顶部两行（第 1 行搜索框 / 右上角「返回 MTNode」、第 2 行标签条）是壳的一部分：
     每次重绘只更新页名与标签条，**不重建搜索框** —— 它就是「输入一个字就失焦」的解法本身。 */
  appsHubTopbar(host);
  const body = host.querySelector(".apps-hub-body");
  /* 开发页（renderer/app-apps-dev.js）借用了会话视图的正文与输入框 DOM：整页重绘前先
     让它把借走的节点按原顺序还回 .agent-body，否则旧容器被丢弃后它们就成了孤儿。 */
  if (typeof appsDevPageUnmount === "function") appsDevPageUnmount();
  /* 卡片网格是窗口化的（只渲染可视区几张）：重绘前必须先把上一个实例的 scroll / resize
     监听拆掉，否则每切一次页都留一份监听并指向已经被拆掉的节点。 */
  appsVirtualGridDispose();
  body.innerHTML = "";
  if (APPS_ST.nav === "apps") appsPaintAppsPage(body, seq);
  else if (APPS_ST.nav === "mine") appsPaintMinePage(body, seq);
  else if (APPS_ST.nav === "lib") appsPaintLibPage(body, seq);
  else appsPaintDevPage(body, seq);
}

/* 强制重拉（force）= 用户明确要求「给我最新的」：目录与打赏汇总一并作废重拉。
   quiet = 调用方自己说话（手动「刷新」按钮要按结果给更贴切的一句，见 appsHubReloadNow），
   这时本函数不弹自带的那句 toast —— 一次刷新只留一句，不叠两条。
   返回是否真拿到云端目录（remote / api）：调用方据此决定说什么，**绝不谎报「已更新」**。 */
async function appsHubRefresh(opts) {
  const o = opts || {};
  APPS_ST.cat = o.force ? null : APPS_ST.cat;
  APPS_ST.list = null;
  if (o.force) appsTipsReset();
  await Promise.all([appsCatalogLoad(!!o.force), appsListLoad(true), appsRootLoad()]);
  const src = APPS_ST.cat && APPS_ST.cat.source;
  const cloud = src === "remote" || src === "api";
  /* 页面顶部那条目录状态文字整条不再出现（用户口径，2026-10）：**成功不弹 toast**
     ——有目录就直接用，界面不再解释目录从哪儿来、什么时候拉的；真拉不到才提一句。 */
  if (o.force && !o.quiet && !cloud) appsToast(appsT("刷新失败：拉不到云端目录"), "warn");
  appsHubPaint();
  return cloud;
}

/* ── 手动刷新（本轮需求）：顶部第 1 行那颗环形箭头按钮 + F5 / Ctrl+R ──
   与「自动重拉」（开页 / 每次下载结束）的唯一区别就是 force：新鲜期（APPS_CAT_TTL /
   APPS_TIPS_TTL）一律不作数，问的就是最新一份目录。
   纪律：
   · 防重入：跑着的时候按钮 disabled + .on（转圈），再点 / 再按快捷键直接返回，
     连点几下也只打一次网络；
   · 先落定筛选待办（appsSearchFlush）再拉：不落定的话，防抖到期那次重绘会把
     上一秒的旧列表画回来；
   · 当前页是「应用」时，appsHubRefresh({force:true}) 一条路走到底（目录云端重拉 +
     打赏缓存作废 + 按当前 nav 重绘）；**其余页**（我的应用 / 库 / 开发）额外把本机列表
     与「我的应用」那份缓存一并作废 —— 否则刷完还是旧的自有条目（那两页不走目录缓存）；
   · 拉不到就明说还在看本机缓存（下面按 appsHubRefresh 回的 cloud 说），绝不谎报「已更新」；
   · 无论成功 / 失败 / 抛错，按钮都在 finally 里回位。 */
async function appsHubReloadNow() {
  if (APPS_RELOAD_BUSY) return false;
  APPS_RELOAD_BUSY = true;
  const btn = document.getElementById("appsHubReload");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("on");
    btn.title = appsT("正在从云端刷新应用目录…");
  }
  try {
    appsSearchFlush();
    if (APPS_ST.nav !== "apps") {
      APPS_ST.list = null;
      APPS_ST.mine = null;
      APPS_ST.mineAt = 0;
      /* 「我的应用」那份分页列表：只把新鲜期作废（at = 0）而**不清空** ——
         清空会让 appsMinePageLoad 的 wantPages 退回第 1 页，用户已经翻出来的几页
         会被缩回 50 条（见 appsMinePageLoad 的注释：那正是要避免的）。 */
      if (APPS_ST.minePage) APPS_ST.minePage.at = 0;
    }
    const cloud = await appsHubRefresh({ force: true, quiet: true });
    /* 反馈只剩**需要用户知道**的两种情况（成功一律安静，按钮转圈即反馈）：
       · 云端**答了**、只是 0 条 → 如实说「云端目前没有应用」（连接没毛病，没有缓存可回退）；
       · 真连不上（静态 + 接口都没成、本机也没有缓存）→ 说一句「拉不到云端目录」。
       顶部那条常驻状态文字（含「显示的是本机缓存（时间）」）已按用户口径整条移除。 */
    const answeredEmpty = appsCatalogAnsweredEmpty();
    if (!cloud) {
      appsToast(
        answeredEmpty
          ? appsT("云端目前没有可上架的应用（目录为空，不是网络问题）")
          : appsT("刷新失败：拉不到云端目录"),
        answeredEmpty ? "ok" : "warn",
      );
    }
    return cloud || answeredEmpty;
  } catch (e) {
    appsToast(appsT("刷新失败：拉不到云端目录"), "warn");
    return false;
  } finally {
    APPS_RELOAD_BUSY = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("on");
      btn.title = appsT("刷新云端应用目录");
    }
  }
}

/* F5 / Ctrl+R 的按键闸（唯一判定处）：只在**应用中心开着**、且焦点不在输入框 / 可编辑域里生效。
   为什么要这道闸：这几个键在别处是「重新加载界面」的意思，落在搜索框 / 编辑器里时更不该被本页抢走 ——
   抢了就等于用户打字打到一半整页刷新。 */
function appsReloadKeyHit(ev) {
  if (!APPS_HUB_OPEN || !ev) return false;
  const k = String(ev.key || "");
  const hit = k === "F5" || ((ev.ctrlKey || ev.metaKey) && (k === "r" || k === "R"));
  if (!hit) return false;
  const el =
    ev.target && ev.target.nodeType === 1
      ? ev.target
      : document.activeElement && document.activeElement.nodeType === 1
        ? document.activeElement
        : null;
  if (el) {
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return false;
    if (el.isContentEditable) return false;
    if (
      el.closest &&
      el.closest('[contenteditable="true"],[contenteditable=""],[role="textbox"]')
    )
      return false;
  }
  return true;
}
/* 走的是与按钮**同一个出口**（appsHubReloadNow），不重载 Electron 页面（那会把本页与画布一起掀掉）。
   捕获段执行：先于别处的按键处理吃掉这两个键（preventDefault），免得同时触发别的语义。
   上层对话框（#overlay / 确认框）开着时本页不抢 —— 那时的 Ctrl+R 不是本页的事。 */
document.addEventListener(
  "keydown",
  (ev) => {
    if (!appsReloadKeyHit(ev)) return;
    const ov = document.getElementById("overlay");
    if (ov && ov.style.display === "flex") return;
    const dlg = document.getElementById("mtDialog");
    if (dlg && dlg.classList.contains("on")) return;
    ev.preventDefault();
    ev.stopPropagation();
    appsHubReloadNow();
  },
  true,
);

function appsHubNav(id) {
  const next = APPS_NAV.some((n) => n[0] === id) ? id : "apps";
  if (next === APPS_ST.nav) {
    /* 同一页再点一次：把开着的那只详情对话窗收掉（不切页） */
    closeAppsDetail();
    appsHubPaint();
    return;
  }
  APPS_ST.nav = next;
  /* 切页 = 上下文整块换掉：详情窗跟着收（它讲的是上一页那个应用），
     「应用目录」小菜单也收掉（它挂在壳上，不随正文重绘消失）。 */
  closeAppsDetail();
  appsRootMenuClose();
  /* 换页立刻同步标签条显隐（开发页不显示标签；它挂在壳上、不在被重绘的正文里）
     与视图切换钮的显隐（开发页没有列表模式） */
  appsHubTagsHidden();
  appsViewBtnSync();
  appsHubPaint();
}

/* ───────────────── 打开 / 关闭（互斥回收 · persistent） ───────────────── */

/* 打开前的互斥清理：节点级浮层与瞬态菜单属于画布，本页盖住画布就该收掉；
   #overlay（设置 / 插件 / 工坊等）**不动** —— 它的 z-index 更高，后开的对话框压在本页之上。 */
function appsHubPreOpenCleanup() {
  if (typeof closeNodePopsExcept === "function") {
    try {
      closeNodePopsExcept("");
    } catch (_) {}
  }
  if (typeof hideCtx === "function") {
    try {
      hideCtx();
    } catch (_) {}
  }
  if (typeof window.hideNodeHelpTip === "function") {
    try {
      window.hideNodeHelpTip();
    } catch (_) {}
  }
}

function appsHubProgressWatch(on) {
  const api = window.api || {};
  if (on) {
    if (APPS_PROG_OFF) return;
    if (typeof api.onAppsProgress !== "function") return;
    APPS_PROG_OFF = api.onAppsProgress((p) => {
      if (!p || !p.id) return;
      APPS_ST.progress[p.id] = p;
      appsPaintProgress(p.id);
      if (p.phase === "done" || p.phase === "error") {
        const id = p.id;
        setTimeout(() => {
          delete APPS_ST.progress[id];
          appsHubRefresh({});
        }, 900);
      }
    });
    return;
  }
  if (APPS_PROG_OFF) {
    try {
      APPS_PROG_OFF();
    } catch (_) {}
    APPS_PROG_OFF = null;
  }
}

/* 全局 openAppsHub：nav 省略 = 沿用上次那一页（首次进入「应用」页） */
function openAppsHub(nav) {
  if (!appsEntryAllowed()) {
    appsSyncEntryVisibility();
    return null;
  }
  if (nav && APPS_NAV.some((n) => n[0] === nav)) APPS_ST.nav = nav;
  const host = appsHubEnsure();
  appsHubPreOpenCleanup();
  APPS_HUB_OPEN = true;
  appsSearchFlush();
  host.hidden = false;
  /* footer.statusbar 露出来（需求：画布那条 footer 也要在应用界面里）——必须在 hidden=false
     之后量，元素是隐藏的时侯量出来是 0 */
  appsHubFootGapHook();
  appsHubFootGap();
  const btn = document.getElementById("btnApps");
  if (btn) btn.classList.add("on");
  appsHubProgressWatch(true);
  appsHubPaint();
  /* 首次打开：先把数据拉齐再画一次（先画壳，用户立刻看到反馈） */
  Promise.all([appsCatalogLoad(false), appsListLoad(false), appsRootLoad()]).then(() => {
    if (APPS_HUB_OPEN) appsHubPaint();
  });
  return host;
}

function appsHubClose() {
  const host = appsHubEl();
  APPS_HUB_OPEN = false;
  /* 收页时把待办的搜索重绘一并取消：本页已关，迟到的那次重绘只会白跑一遍 */
  appsSearchFlush();
  if (host) host.hidden = true;
  /* 开发页关掉 = 这一次开发上下文结束：把借走的会话正文 / 输入框还回会话视图，
     并停掉预览轮询（页面 DOM 留在浮层里，下次进来自会重建） */
  if (typeof appsDevPageUnmount === "function") appsDevPageUnmount();
  const btn = document.getElementById("btnApps");
  if (btn) btn.classList.remove("on");
  appsHubProgressWatch(false);
  if (APPS_ST.conflictAsk) {
    const done = APPS_ST.conflictAsk;
    APPS_ST.conflictAsk = null;
    try {
      done("cancel");
    } catch (_) {}
  }
}

/* Esc / 顶栏切走 = 收掉本页（页面级互斥回收） */
document.addEventListener(
  "keydown",
  (ev) => {
    if (!APPS_HUB_OPEN || ev.key !== "Escape") return;
    /* 上层对话框（#overlay / 确认框）自己处理 Esc，本页不抢 */
    const ov = document.getElementById("overlay");
    if (ov && ov.style.display === "flex") return;
    const dlg = document.getElementById("mtDialog");
    if (dlg && dlg.classList.contains("on")) return;
    if (APPS_ST.conflictAsk) {
      ev.preventDefault();
      ev.stopPropagation();
      const done = APPS_ST.conflictAsk;
      APPS_ST.conflictAsk = null;
      done("cancel");
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    appsHubClose();
  },
  true,
);

/* 点顶栏任何别的入口 = 离开本页（同一开关 #btnApps 由它自己的 onclick 处理）。
   捕获段执行，保证先收起页面再让那次点击生效；本页自身的点击不在 .topbar 里，不受影响。 */
document.addEventListener(
  "click",
  (ev) => {
    if (!APPS_HUB_OPEN) return;
    const el = ev.target;
    if (!el || !el.closest) return;
    /* 语言切换后回到本页时重画一次（I18n 没有变更订阅，这里按需对齐） */
    if (el.closest("#appsHub")) {
      const loc = window.I18n && I18n.getLocale ? I18n.getLocale() : "";
      if (loc !== APPS_LANG) appsHubPaint();
      return;
    }
    if (!el.closest(".topbar")) return;
    const btn = el.closest("button");
    if (!btn || btn.id === "btnApps") return;
    appsHubClose();
  },
  true,
);

/* ───────────────── 同名目录冲突：覆盖 / 改名 / 取消（三态） ───────────────── */

function appsConflictAsk(res) {
  return new Promise((resolve) => {
    const host = appsHubEl();
    if (!host) {
      resolve("cancel");
      return;
    }
    const ex = (res && res.existing) || {};
    const inc = (res && res.incoming) || {};
    const modal = document.createElement("div");
    modal.className = "apps-modal";
    const box = document.createElement("div");
    box.className = "apps-modal-box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const head = document.createElement("div");
    head.className = "apps-modal-head";
    head.innerHTML = "<b>" + appsEscape(appsT("同名应用已存在")) + "</b>";
    const body = document.createElement("div");
    body.className = "apps-modal-body";
    const l1 = document.createElement("p");
    l1.textContent =
      appsT("应用根目录里已经有一个同名目录「") +
      String(ex.name || (res && res.id) || "") +
      (ex.version ? " v" + ex.version : "") +
      appsT("」，这次要装的是「") +
      String(inc.name || (res && res.id) || "") +
      (inc.version ? " v" + inc.version : "") +
      appsT("」。");
    const l2 = document.createElement("p");
    l2.textContent = appsT(
      "覆盖 = 只替换上次装进去的应用文件（app.json / 入口页 / assets 与脚本样式）；不会被覆盖：该应用的 storage/ 、数据文件夹（data.json 与你自己选过的目录）、它自己的画布。改名 = 装成另一个目录，两份并存；取消 = 什么都不做。",
    );
    body.appendChild(l1);
    body.appendChild(l2);
    const foot = document.createElement("div");
    foot.className = "apps-modal-foot";
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      APPS_ST.conflictAsk = null;
      if (modal.parentNode) modal.remove();
      resolve(v);
    };
    APPS_ST.conflictAsk = finish;
    foot.appendChild(appsMiniBtn(appsT("覆盖"), () => finish("overwrite"), true));
    foot.appendChild(appsMiniBtn(appsT("改名"), () => finish("rename")));
    foot.appendChild(appsMiniBtn(appsT("取消"), () => finish("cancel")));
    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(foot);
    modal.appendChild(box);
    host.appendChild(modal);
  });
}

/* ───────────────── 下载 / 更新（含冲突三态） ───────────────── */

/* 「下载前必须先选一个应用根目录」这套引导**已整体删除**（本轮需求：不再要求手动指定文件夹）：
 * 根目录默认就在画布所在的数据目录下（<数据目录>/apps，主进程 defaultRoot），由主进程在
 * 「列应用 / 下载 / 新建」时把默认路径固化进 config.json（apps-store.js 的 ensureRootPersisted），
 * 所以渲染层这里不再有 appsEnsureRoot 这一前置、也不弹系统选目录框。
 * 想改装到别的盘仍可以：库页左上角「应用目录」按钮的小菜单（appsRootPickNow("down")）与
 * 开发页「项目根 … 更改…」那一行（appsRootPickNow("dev")）。 */

/* version 非空 = 只下那一版（版本树里点「下载这一版」；目录里没有那一版时主进程如实报错） */
/* 下载 / 更新某一条分支的某一版（同 id 多分支，§十）：
   ownerId 非空 = 只下那个作者的分支（不传 = 主干，与旧行为一致）；version 非空 = 只下那一版。 */
async function appsDownload(id, mode, version, ownerId) {
  const api = window.api || {};
  if (typeof api.appsInstall !== "function") {
    appsBridgeMissing();
    return;
  }
  if (APPS_ST.busy[id]) return;
  APPS_ST.busy[id] = true;
  APPS_ST.progress[id] = { id: id, phase: "start", percent: 0 };
  appsPaintProgress(id);
  appsPaintCardState(id);
  const own = String(ownerId || "");
  let r = null;
  try {
    r = await api.appsInstall(id, mode || "", version || "", own);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (r && r.ok === false && r.conflict) {
    const choice = await appsConflictAsk(r);
    if (choice === "cancel") {
      APPS_ST.busy[id] = false;
      delete APPS_ST.progress[id];
      appsPaintCardState(id);
      return;
    }
    try {
      r = await api.appsInstall(id, choice, version || "", own);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
  }
  APPS_ST.busy[id] = false;
  delete APPS_ST.progress[id];
  if (r && r.ok) {
    const verb = r.updated ? "已更新：" : "已下载：";
    appsToast(
      appsT(verb) +
        String(r.name || id) +
        (r.version ? " v" + r.version : "") +
        (r.renamed ? appsT("（同名目录已存在，已改名安装）") : ""),
      "ok",
    );
    APPS_ST.list = null;
    await appsListLoad(true);
    /* 装完这一版 = 详情窗里的「本机版本」块也变了（开关窗都刷）：窗开着就只重画窗，
       窗关着才整页重绘（重绘会顺带把列表徽标刷新） */
    if (!appsDetailRefresh()) appsHubPaint();
  } else {
    appsToast(appsT("下载失败：") + appsErrText(r), "err");
    appsPaintCardState(id);
  }
}

/* 打开（独立窗口运行）/ 更新 / 卸载 */
async function appsOpenApp(id) {
  const api = window.api || {};
  if (typeof api.appsOpenWindow !== "function") {
    appsBridgeMissing();
    return;
  }
  let r = null;
  try {
    r = await api.appsOpenWindow(id);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) appsToast(appsT("打开失败：") + appsErrText(r), "err");
  else appsPaintCardState(id);
}

async function appsUninstallApp(app) {
  const id = String((app && app.id) || "");
  if (!id) return;
  if (APPS_ST.busy[id]) return;
  const name = String((app && app.name) || id);
  const binding = appsDevBindingOf(app);
  /* **按类型两种语义**（用户口径：删一个绝不误删另一个）：
     · 开发的（dev）→ 只「移除登记」，磁盘上的项目文件夹一个字节都不动（源码不能被我们删）；
     · 下载的（down）→ 真删自己在下载根下的子文件夹 + 它自己那一棵数据（主进程按类型收口）。 */
  const isDev = !!(app && (app.dev === true || app.kind === "dev"));
  const ok = await new Promise((resolve) => {
    if (typeof confirmDialog !== "function") {
      resolve(true);
      return;
    }
    confirmDialog(
      isDev
        ? appsT("确定移除「") +
            name +
            appsT("」的登记？项目文件夹与里面的文件一个都不会删（要删文件请自己在资源管理器里删）。")
        : appsT(
            "删除该应用？只删它在下载根下的子文件夹与它自己那一棵数据（apps-data/downloaded/），项目根与开发数据一概不动。",
          ) + "\n" + String(app.dir || ""),
      {
        title: isDev ? appsT("移除登记") : appsT("卸载应用"),
        okText: isDev ? appsT("移除登记") : appsT("卸载"),
        danger: !isDev,
      },
    ).then(resolve);
  });
  if (!ok) return;
  const api = window.api || {};
  if (typeof api.appsUninstall !== "function") {
    appsBridgeMissing();
    return;
  }
  let r = null;
  try {
    r = await api.appsUninstall(id, isDev ? "dev_remove" : "");
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) {
    appsToast(appsT(isDev ? "移除登记失败：" : "卸载失败：") + appsErrText(r), "err");
    return;
  }
  if (r.mode === "unregister" || isDev) {
    appsToast(
      appsT("只移除了登记：") + name + appsT("（项目文件夹与文件都还在）") + (binding.bound ? appsT("｜注意：它当前绑定着开发节点") : ""),
      "ok",
    );
  } else {
    appsToast(
      appsT("已卸载：") + name + (r.trashed ? appsT("（已放进回收站）") : ""),
      "ok",
    );
  }
  APPS_ST.list = null;
  await appsListLoad(true);
  appsHubPaint();
}

/* ───────────────── 进度条（就地更新，不重绘整页） ───────────────── */

function appsProgressText(p) {
  if (!p) return "";
  const pct = Number(p.percent) || 0;
  if (p.phase === "start") return appsT("准备下载…");
  if (p.phase === "download")
    return appsT("下载中 ") + pct + "%" + (p.got && p.total ? " · " + appsBytes(p.got) + " / " + appsBytes(p.total) : "");
  if (p.phase === "extract") return appsT("校验并解包…");
  if (p.phase === "conflict") return appsT("同名应用已存在：请选择覆盖 / 改名 / 取消");
  if (p.phase === "done") return appsT("完成");
  if (p.phase === "error") return appsT("失败：") + String(p.error || "");
  return appsT("处理中…");
}
function appsPaintProgress(id) {
  const host = appsHubEl();
  if (!host) return;
  /* 详情对话窗开着同一个应用时，进度也在窗里显示（装 / 回滚都看得见） */
  if (APPS_DETAIL.id === id) appsDetailPaintProg();
  const p = APPS_ST.progress[id];
  const cards = host.querySelectorAll('[data-app-id="' + id + '"]');
  cards.forEach((card) => {
    const wrap = card.querySelector(".apps-prog");
    const bar = card.querySelector(".apps-prog > i");
    const txt = card.querySelector(".apps-prog-txt");
    if (!wrap || !txt) return;
    if (!p) {
      wrap.hidden = true;
      txt.hidden = true;
      bar.style.width = "0%";
      txt.textContent = "";
      return;
    }
    const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
    wrap.hidden = false;
    txt.hidden = false;
    bar.style.width = (p.phase === "error" ? 100 : pct) + "%";
    wrap.classList.toggle("err", p.phase === "error");
    txt.textContent = appsProgressText(p);
  });
}
/* 悬停 / 进度态：只重画那一张卡右下角那一排图标（保住滚动位置与已输入的搜索词）。
   与应用页 / 库页首次渲染**同一个出口**（appsCoverActionsEl），不另写一套按钮。 */
function appsPaintCardState(id) {
  const host = appsHubEl();
  if (!host) return;
  host.querySelectorAll('[data-app-id="' + id + '"]').forEach((card) => {
    const isLocal = !!card.dataset.local;
    if (isLocal) {
      const app = appsLocalById(id);
      appsPaintTileActions(card, appsLocalSpecOf(app || { id: id }), true);
    } else {
      const spec = appsSpecById(id);
      appsPaintTileActions(card, spec || { id: id }, false);
    }
    appsPaintProgress(id);
  });
}

/* ───────────────── 应用页（云端目录） ───────────────── */

/* 卡片动作行（本轮需求重排）：
 *   未装   → 「下载」：**直接开「分支 / 版本」跳窗**（默认原作者 + 其最新版），在窗里下载；
 *   已装   → 「启动」（本机已装的那一支）→（有更新时）「更新」→（还有没装的时）「其他版本」；
 *   更新   → 指向**本机已装那一支的作者**的最新版；
 *   其他版本 → 本机还有没装的其它分支 / 其它版本时才出现，点了开详情并定位到分支树。
 * 「看分支」按用户口径**移除**（分支树是详情里的正文，卡片上不再放第二入口）。 */
function appsFillCatalogActions(acts, spec) {
  const id = spec.id;
  const busy = !!APPS_ST.busy[id];
  if (!spec.installed) {
    const dl = appsMiniBtn(busy ? appsT("下载中…") : appsT("下载"), () => appsOpenDetailForPick(id));
    dl.disabled = busy || spec.compatible === false;
    dl.title = spec.compatible === false
      ? appsT("该应用要求的 MTNode 版本高于当前版本")
      : appsT("打开「分支 / 版本」窗口（默认原作者最新版），选好后在窗里下载");
    acts.appendChild(dl);
  } else {
    /* 已装 = 启动（与库页 / 开发页同一个入口：appsOpenApp → 独立窗口） */
    acts.appendChild(appsRunBtnEl(id, appsT("启动"), () => appsOpenApp(id)));
    const up = appsCardUpdateTargetOf(spec);
    if (up) {
      const btn = appsMiniBtn(
        appsUpdateBtnLabel(up),
        () => appsCatalogUpdate(spec, up.ownerId, up.version),
      );
      btn.disabled = busy;
      btn.title =
        up.reason === "same-version"
          ? appsT("作者就地重传了同一版（v") + up.version + appsT("）：云端那份包内容已变，覆盖安装把新的换到本机（数据保留）")
          : appsT("更新到本机已装那一支的作者最新版");
      acts.appendChild(btn);
    }
    if (appsHasOtherVersions(spec)) {
      const btn = appsMiniBtn(appsT("其他版本"), () => appsOpenDetailForPick(id));
      btn.disabled = busy;
      btn.title = appsT("打开详情：可选别的作者分支或别的版本（本机已装的那一支会被替换，数据保留）");
      acts.appendChild(btn);
    }
  }
  /* 本轮口径（用户共识）：
     · 「详细」不再占动作行 —— 而且卡片封面那枚 ⓘ 也摘掉了（点卡片本身就开详情窗）；
     · 卡片上也不再放「评论」入口：评论改为**详情窗下方那一片**（tabs 已移除），
       单独再弹一只评论窗与它内容重复。
     所以这里到函数末尾一个动作都不再追加；打赏入口仍在封面右下角那枚金币 icon 上。 */
}

/** 「更新」按钮的目标：**本机已装那一支的作者**的最新版（本机没装 → null）。
 *  用户口径：更新按钮指向本机已装那一支的作者最新版，不跟着「谁版本号最高」乱跑。
 *
 *  **版本号相同也可以有更新**（本轮用户需求「应用更新时，同版本允许更新覆盖」）：
 *  作者改完 bug 原地重传同一个版本号时，版本号不新，但**包内容变了** —— 判据比内容：
 *  云端目录为每一版下发 sha256（store-saas/server.mjs 的 appCatalogVersions），
 *  本机记账在安装台账里（apps-store.js 的 installed.json，appSummary 的 sha256）。
 *  两者都在、且不相等 = 本机这份不是云端那份 → 该给「覆盖安装」。
 *  拿不到 sha256（老服务端 / 老台账）时退回原来的版本号判据，绝不凭猜给入口。
 *  @returns {?{ownerId:string, version:string, reason:"newer"|"same-version", same:boolean}} */
function appsCardUpdateTargetOf(spec) {
  const id = String((spec && spec.id) || "");
  const local = appsLocalById(id);
  if (!local) return null;
  const localOwnerId = String(local.ownerId || "").trim();
  const fam = appsFamilyEntriesOf(spec);
  let mine = localOwnerId ? fam.find((b) => String((b && b.ownerId) || "") === localOwnerId) || null : null;
  if (!mine) mine = appsFamilyRootOf(spec) || spec;
  if (!mine) return null;
  const latest = appsBranchVersionOf(mine);
  const cur = String(local.version || "");
  if (!latest || !cur) return null;
  const ownerId = String(mine.ownerId || "");
  if (appsVerCmp(latest, cur) > 0) return { ownerId: ownerId, version: latest, reason: "newer", same: false };
  /* 版本号一样 / 本机这份更「新」（多半是作者回滚过）：只有内容对不上才算有更新 */
  if (appsVerCmp(latest, cur) === 0 && appsVersionContentDiffers(mine, cur, local)) {
    return { ownerId: ownerId, version: latest, reason: "same-version", same: true };
  }
  return null;
}

/** 本机装的那一版与云端那一版的**包内容**对不上吗（同号覆盖的判据）。
 *  比 sha256：云端那一版的（目录 versions[] 里的 sha256，缺了就退回分支条目顶层那条）+ 本机台账的。
 *  任一侧拿不到 → false（不猜「有更新」，宁可少给一个入口也不给假入口）。 */
function appsVersionContentDiffers(branch, version, local) {
  const want = String(version || "");
  const mineSha = String((local && (local.sha256 || local.zipSha256)) || "").trim().toLowerCase();
  if (!want || !mineSha) return false;
  const vs = appsVersionsOfBranch(branch);
  const hit = vs.find((v) => String(v && v.version) === want) || null;
  const cloudSha = String((hit && hit.sha256) || (branch && branch.sha256) || "")
    .trim()
    .toLowerCase();
  if (!cloudSha) return false;
  return cloudSha !== mineSha;
}

/** 这颗「更新 / 覆盖安装」按钮怎么说（目录卡与详情窗共用同一份文案）：
 *  版本号更新 = 「更新到 vX」；同号但内容变了 = 「覆盖安装 vX」（author 就地重传了同一版）。 */
function appsUpdateBtnLabel(up) {
  if (!up) return "";
  return up.reason === "same-version"
    ? appsT("覆盖安装 v") + up.version
    : appsT("更新到 v") + up.version;
}

/** 卡片要不要显示「其他版本」：只要本机还有**没装的**分支或版本就显示（用户口径）。
 *  判据：① 家族里存在「本机没装的那条分支」；② 本机装的那一支有比本机更新的版本；
 *        ③ 本机装的那一支还有别的（更高 / 更低）版本可选。 */
function appsHasOtherVersions(spec) {
  const id = String((spec && spec.id) || "");
  const local = appsLocalById(id);
  const fam = appsFamilyEntriesOf(spec);
  if (fam.length > 1) {
    const localOwnerId = String((local && local.ownerId) || "").trim();
    const localAuthor = String((local && (local.owner || local.author)) || "").trim().toLowerCase();
    const other = fam.some((b) => !appsBranchSameAsLocal(b, local, localOwnerId, localAuthor));
    if (other) return true;
  }
  if (!local) return false;
  const root = appsFamilyRootOf(spec) || spec;
  const vs = appsVersionsOfBranch(root);
  const localVer = String(local.version || "");
  return vs.some((v) => String(v.version || "") !== localVer);
}

/** 「下载 / 其他版本」的落点（本轮需求 4 改口径）：**直接打开「分支 / 版本」跳窗** ——
 *  分支树、这一支的版本、本机回滚都在那一只窗里，选好后窗内底部那颗主按钮才下载
 *  （默认选中仍是原作者 + 其最新版，与历史口径一致）。 */
function appsOpenDetailForPick(id) {
  const sid = String(id || "");
  if (!sid) return;
  APPS_DETAIL.branchOwnerId = "";
  openAppsVersionDlg(sid, { from: "card" });
}
/* 已装且有新版本时的更新入口：开发中的应用（本机正在改的）要先把风险说清楚 —— 更新会用包里的
   应用文件整目录替换这一份（包里有 app.json / 入口页 / assets 与任意脚本样式；本机存储
   storage/ 与该应用自己的画布不动），一次误点就可能冲掉开发成果。 */
async function appsCatalogUpdate(spec, ownerId, version) {
  const id = String((spec && spec.id) || "");
  if (!id) return;
  const want = String(version || (spec && (spec.latestVersion || spec.version)) || "");
  if (spec.localDev) {
    const body =
      appsSpecTitle(spec) +
      appsT(" 正在开发中（本机这一份带「开发中」标记）。更新到 v") +
      want +
      appsT(" 会用它包里那批应用文件整目录替换这一份（app.json / 入口页 / assets 与脚本、样式都在内）—— 你在这些文件上的改动会丢。") +
      appsT("不会被覆盖：storage/ 、该应用的数据文件夹（data.json 与你自己选过的目录）、它自己的画布。确定更新吗？");
    let ok = true;
    if (typeof confirmDialog === "function") {
      ok = await confirmDialog(body, {
        title: appsT("更新正在开发的应用"),
        okText: appsT("仍然更新"),
        danger: true,
      });
    }
    if (!ok) return;
  }
  await appsDownload(id, "update", want, ownerId);
}

/* 卡上「下载 / 更新」指向哪条分支：合并卡里版本最高的那条（同 id 多分支，§十） */
﻿

/* 卡片上的徽标：**本轮全部去掉**（用户口径：应用界面不显示「开发中」等 chips，也不显示分支与版本）。
 * 函数保留成空实现，是因为卡片与详情头部都按同一个出口取徽标 —— 一处清干净，
 * 将来要恢复某一枚时也只改这一处；`spec` 参数刻意留住（调用点不必改签名）。 */
function appsCatalogBadges(spec) {
  return [];
}

/* ─────────── 卡片封面（16:9 背景图 + 左下标题/作者 + 右下图标行）───────────
 * 需求口径（本轮，参考微软商店）：
 *   · 整张卡就是一块 16:9 圆角封面（背景图固定长宽比、居中裁切），标题与作者压在封面**左下角**，
 *     底部一条黑色渐变遮罩保证亮底截图上也看得清；悬停封面轻微提亮 + 描边加重。
 *   · 卡上只留三枚小图标（下载/更新、ⓘ 详细、金币打赏）排在封面**右下角**；其余动作全进详情窗。
 *   · 点封面空白处 = 打开应用详情窗（图标按钮各自 stopPropagation，不误触）。
 *   · 「已安装 / 可更新」不加徽标，靠那颗动作图标的形态与提示区分（用户口径）。 */

/* 封面的取图口径（**唯一**一处）：
 *   ① spec.urls.thumb（主进程按来源算好的缩略图；接口 = …/api/apps/<id>/thumb，静态 = FEED + thumb）
 *   ② spec.thumb（静态目录里服务端下发的相对写法 icons/<主干>[__shot].png，拼 sourceBase）
 *   ③ 退回按 icon 地址推导同主干 .png（老目录没有 thumb 字段时的那条老链路）
 * 服务端这一份 thumb 的**源就是上架截图第 1 张**（没有截图才退回图标，见 store-saas/server.mjs 的
 * appCoverSourceOf）—— 本轮修的正是「截图传上去了，卡片封面却还是图标」。
 * 静态目录没有 /thumb 路由（nginx 直发），所以地址得自己拼；接口目录走 /api/apps/<id>/thumb。 */
function appsThumbUrlOf(spec) {
  const direct = String((spec && spec.urls && spec.urls.thumb) || "").trim();
  if (direct) return direct;
  /* 静态目录下发的相对 thumb（icons/…__shot.png）：只认放在目录基址下的写法，
     绝不把外站地址拼进来（thumb 来自目录内容，同 zipUrl 的防投毒口径）。
     基址取 appsFeedBase；它空着（老条目没有 sourceBase）就退回「icon 地址里 icons/ 之前那一截」
     —— 两条都是同一份目录基址，推不出来就干脆返回空串（宁可退回原图，不拼坏地址）。 */
  const rel = String((spec && spec.thumb) || "").trim().replace(/^\.\//, "");
  if (rel && !/^data:image\//i.test(rel) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rel)) {
    let base = appsFeedBase(spec);
    if (!base) {
      const iconAbs = String((spec && spec.urls && spec.urls.icon) || "").trim();
      const at = iconAbs.indexOf("/icons/");
      if (at > 0) base = iconAbs.slice(0, at);
    }
    if (base) return base.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "");
  }
  const icon = appsIconUrl(spec);
  if (!icon || /^data:image\//i.test(icon)) return "";
  if (/\/api\/apps\/[^/]+\/icon(\?|$)/i.test(icon)) return icon.replace(/\/icon(\?|$)/i, "/thumb$1");
  try {
    const u = new URL(icon);
    const m = /\/([^/]+)\.[a-z0-9]+$/i.exec(u.pathname);
    if (m) {
      u.pathname = u.pathname.replace(/\/[^/]+$/, "/" + m[1] + ".png");
      return u.href;
    }
  } catch (_) {}
  return "";
}

/* 上架截图的可用地址（**唯一一处**，与图标同一套来源口径）：
 *   · 静态目录：条目里的 shots[] 是相对静态目录的写法（shots/<主干>/<n>.png）→ sourceBase + 它；
 *   · 接口目录：源站没有 /shots 静态路由时走 /api/apps/<id>/shots/<n>（见 store-saas/server.mjs）。
 * 一律带上限大小的图；拿不到就回空数组（详情窗不画画廊，绝不画一堆破图）。
 * `opts.size === "list"` = 要**列表小图**（服务端另出的长边 1280 那一档，见 shotsThumb[]）：
 *   列表页只下小图，详情才下原图 —— 这是「图片缓存」省服务器流量的另一半。
 *   shotsThumb 缺席 / 对应位置为空 / 老服务端没有这个字段 → 原样退回原图地址（绝不 404）。 */
function appsShotsUrlsOf(spec, opts) {
  const s = spec || {};
  const wantList = String((opts && opts.size) || "") === "list";
  const rels = Array.isArray(s.shots) ? s.shots.filter((x) => typeof x === "string" && x) : [];
  if (!rels.length) return [];
  const thumbs = Array.isArray(s.shotsThumb) ? s.shotsThumb : [];
  const st = APPS_ST.cat || {};
  const base = String(st.sourceBase || "").trim();
  const id = String(s.id || "");
  const isApi = st.source === "api" || st.source === "cache";
  const out = [];
  for (let i = 0; i < rels.length; i++) {
    const useList = wantList && typeof thumbs[i] === "string" && thumbs[i];
    const rel = String(useList ? thumbs[i] : rels[i]).replace(/^\.\//, "");
    if (/^https?:\/\//i.test(rel)) {
      out.push(rel);
      continue;
    }
    if (isApi && id) {
      out.push(
        base + "/api/apps/" + encodeURIComponent(id) + "/shots/" + (i + 1) + (useList ? "?size=list" : ""),
      );
      continue;
    }
    out.push(base ? base.replace(/\/+$/, "") + "/" + rel.replace(/^\/+/, "") : rel);
  }
  return out;
}

/* 封面地址的**缓存令牌**（本轮需求：换了图立刻看到新图，不再被 HTTP 缓存卡住）：
 *   服务端 /api/apps/<id>/icon|thumb 都回 Cache-Control（icon 1 小时 / thumb 7 天），而图标与
 *   截图文件本身是「每个分支只保留最新一份」—— 重新发布 / 换图后**文件名不变**，不补令牌就会
 *   一直看到老图。口径：
 *     · 首选服务端下发的 coverVer（封面源文件的 mtime 秒）：作者在「编辑」里只换截图**不产生
 *       新版本号**，版本号当令牌那种算法根本变不了，而目标图已经换了 —— 这正是本轮修的口子；
 *     · 老目录没有 coverVer，退回版本号（与改动前逐字一致）。
 *   静态目录那条链（urls.icon = icons/<主干>.png）文件名里已经带版本信息、没有查询串可加字段
 *   时不动它；data: 图直接跳过。 */
function appsCoverVerToken(spec) {
  const s = spec || {};
  return String(s.coverVer || s.latestVersion || s.version || "").trim();
}
function appsUrlWithToken(rawUrl, spec) {
  const url = String(rawUrl || "").trim();
  const ver = appsCoverVerToken(spec);
  if (!url || !ver || /^data:image\//i.test(url) || /[?&]v=/.test(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("v", ver);
    return u.href;
  } catch (_) {
    /* 相对地址（静态目录 / 老写法）：拼不上就不拼，别改成坏地址 */
    return url;
  }
}
/* 本机兜底封面：本机已装那份应用清单的 icon（apps-store.js 读成 data URL）才用 ——
   云端图拉不到（离线 / 404 / 已删除）时顶上，比纯色底好看，也不额外发网络请求。 */
function appsLocalCoverOf(spec) {
  const id = String((spec && spec.id) || "");
  if (!id) return "";
  const local = appsLocalById(id);
  return String((local && local.iconBase64) || "").trim();
}

/* ── 「界面先出、图像一次到位」（本轮需求：应用中心首屏慢 / 反复刷新闪）────────────
 * 封面图不再「建元素即带真地址」：先挂 1×1 透明占位（零请求、不破图），真地址交给
 * renderer/app-apps-img.js 按视口懒加载，并且**同一窗口周期内的图合成一批一起换上**。
 * 这里只放三个薄壳 —— 本模块不重复实现取图 / 分批 / 观察器那一套：
 *   appsImgDefer : 建延迟取图的 <img>（模块缺席时退回原来的「建元素即取图」）
 *   appsImgLoad  : 回退链要换一张图时用（同样先占位再取，看不出中间那一步）
 *   appsImgFlush : 整页重绘 / 切页 / 关闭前当场落定，不留半张半张的卡
 * 为什么详情头（o.big）与卡片走同一套：详情是用户点开才出现的，图晚一两帧无感；
 * 卡片是首屏，慢的正是它。 */
function appsImgDefer(cls, url, eager) {
  if (typeof appAppsImgDefer === "function") return appAppsImgDefer(cls, url, eager);
  const img = document.createElement("img");
  img.className = cls || "";
  img.alt = "";
  img.loading = eager ? "eager" : "lazy";
  img.decoding = "async";
  if (url) img.src = url;
  return img;
}
/* 回退链换地址（缩略图 → 原图 → 本机图）：交给同一套延迟取图口径换 —— 换到一半直接写
   img.src 会让这张卡比旁边那批早一帧露出来（就是「一张张蹦」）。
   本机那份是 data URL：登记后当场落定（没有网络这一步，不陪着一块等）。 */
function appsImgLoad(img, url) {
  const real = String(url || "");
  if (!real) return;
  if (typeof appAppsImgAdopt === "function" && img.dataset && "appsImg" in img.dataset) {
    appAppsImgAdopt(img, real);
    return;
  }
  img.src = real;
}
/* 整页重绘 / 切页 / 关闭前：把登记中的图当场落定（一次到位，不留半张卡） */
function appsImgFlush() {
  if (typeof appAppsImgFlush === "function") {
    try {
      appAppsImgFlush();
    } catch (_) {}
  }
}

/* 这个条目的封面源是不是上架截图第 1 张（服务端下发 coverSource，见 store-saas/server.mjs）：
 *   "shot" = 是，"icon" = 不是，"", 空 = 老目录（没这个字段，按原来的「图标即封面」走）。
 * 用途只有一个：缩略图取不到时，知道**退回到哪张原图** —— 封面源是截图就该退到那张截图，
 * 而不是把图标顶上去（那正是用户报的「截图传了却不当封面」）。 */
function appsCoverIsShot(spec) {
  return String((spec && spec.coverSource) || "").trim() === "shot";
}
/* 封面备选地址链（顺序即优先级，去重；**唯一一处**）：
 *   ① 封面缩略图（源 = 上架截图第 1 张；没有截图才是图标）—— 640×360，卡片就该用它
 *   ② 另一条缩略图（封面源是截图时补一条）：截图那张 404 还能退到图标那条 16:9 的图，
 *      而不是直接掉到「图标原图」（小方块铺满卡片 = 糊）
 *   ③ 封面源原图（截图第 1 张 / 图标）：缩略图都没有时的第二选择
 *   ④ 图标原图（最后一张：至少有图）
 * 拿不到就回空数组（调用方退回本机封面 / 兜底底色）。 */
function appsCoverCandidatesOf(spec) {
  const s = spec || {};
  const isShot = appsCoverIsShot(s);
  const thumb = appsThumbUrlOf(s);
  const icon = appsIconUrl(s);
  const st = APPS_ST.cat || {};
  const base = String(st.sourceBase || "").trim();
  const out = [];
  const push = (u) => {
    const v = String(u || "").trim();
    if (v && out.indexOf(v) < 0) out.push(v);
  };
  push(thumb);
  /* ② 另一条缩略图：静态目录的缩略图文件名里带封面源后缀（<主干>__shot.png = 截图那条，
     <主干>.png = 图标那条），把后缀换掉就是另一条。接口目录只有 /thumb 一条
     （服务端自己决定源，也给不出第二条），跳过。 */
  if (isShot && thumb && !/\/api\/apps\/[^/]+\/thumb/i.test(thumb)) {
    const rel = String(s.thumb || "");
    const m = /\/?([^/]+)\.png$/i.exec(rel) || /^([^/]+)\.png$/i.exec(rel);
    if (base && m) {
      const alt = base.replace(/\/+$/, "") + "/icons/" + m[1].replace(/__shot$/i, "") + ".png";
      push(alt);
    }
  }
  /* ③ 封面源原图（截图第 1 张 / 图标原图）→ ④ 图标原图兜底 */
  if (isShot) push(appsShotsUrlsOf(s)[0]);
  push(icon);
  return out;
}

/* 封面元素：一个 16:9 定位块 + 背景图（拉不到就按上面的备选链退，再不行就纯色底）。
   `withText` 时叠左下角标题/作者与底部渐变遮罩 —— 卡片用 withText:true，详情头部用 false。 */
function appsCoverEl(spec, name, opts) {
  const o = opts || {};
  const cover = document.createElement("div");
  cover.className = "apps-cover" + (o.big ? " apps-cover-big" : "");
  /* 详情头部（o.big）把「缓存令牌」拼上：同一个 spec 对象上补一次就行（幂等），
     让这张图绕开 max-age 缓存拿到最新上传的那张。 */
  if (o.big && spec && spec.urls) {
    const c = appsUrlWithToken(spec.urls.thumb, spec);
    const d = appsUrlWithToken(spec.urls.icon, spec);
    if (c && c !== spec.urls.thumb) spec.urls.thumb = c;
    if (d && d !== spec.urls.icon) spec.urls.icon = d;
  }
  /* 取图口径 = appsCoverCandidatesOf 那条链（封面缩略图 → 另一条缩略图 → 原图 → 图标 →
     本机已装那份 → 兜底底色），只是**不再一建元素就发请求**：地址交给 app-apps-img.js，
     进视口才取、同一批一起换上（见上方三个薄壳）。 */
  const chain = appsCoverCandidatesOf(spec);
  const first = chain[0] || "";
  const primary = appsCoverIsShot(spec) ? "shot" : "icon";
  if (first) {
    const img = appsImgDefer(
      "apps-cover-img",
      o.big ? appsUrlWithToken(first, spec) : first,
      o.eager,
    );
    img.dataset.coverSource = primary;
    img.dataset.coverStep = "0";
    img.addEventListener("error", () => {
      /* 第 n 张拉不到（404 / 断网）：退到链上的下一张，都退完了再退**本机已装**那份的封面图
         （o.big 才给，用户口径），最后才交给兜底底色。
         不做「首字块替换」是刻意的 —— 封面是整块背景图，替换会把标题盖掉。 */
      const step = (Number(img.dataset.coverStep) || 0) + 1;
      if (step < chain.length) {
        img.dataset.coverStep = String(step);
        img.dataset.fallback = "1";
        /* 退到第几张了（shot = 还是那张截图 / icon = 已经换成图标那条）——给回归与排查看 */
        img.dataset.coverSource = step === 1 && chain.length > 2 ? "icon" : primary;
        appsImgLoad(img, o.big ? appsUrlWithToken(chain[step], spec) : chain[step]);
        return;
      }
      const local = o.big && !img.dataset.localTried ? appsLocalCoverOf(spec) : "";
      if (local) {
        img.dataset.localTried = "1";
        appsImgLoad(img, local);
        return;
      }
      img.hidden = true;
      cover.classList.add("noimg");
    });
    cover.appendChild(img);
  } else {
    /* 云端一个地址都给不出（无图标声明 / 静态目录推导失败）：详情头部还能拿本机那张兜底 */
    const local = o.big ? appsLocalCoverOf(spec) : "";
    if (local) {
      /* 本机那张是主进程读成 data URL 给的：没有网络这一步，直接挂（少一次中转） */
      const img = appsImgDefer("apps-cover-img", "", o.eager);
      img.dataset.localTried = "1";
      img.src = local;
      img.addEventListener("error", () => {
        img.hidden = true;
        cover.classList.add("noimg");
      });
      cover.appendChild(img);
    } else {
      cover.classList.add("noimg");
    }
  }
  /* 没图 / 图拉不到时的兜底底色层（纯色底 + 左下标题，见上面注释） */
  const fb = document.createElement("div");
  fb.className = "apps-cover-fb";
  cover.appendChild(fb);
  if (o.withText !== false) {
    const shade = document.createElement("div");
    shade.className = "apps-cover-shade";
    cover.appendChild(shade);
    const cap = document.createElement("div");
    cap.className = "apps-cover-cap";
    const t = document.createElement("div");
    t.className = "apps-cover-name";
    t.textContent = name;
    t.title = name;
    cap.appendChild(t);
    const who = document.createElement("div");
    who.className = "apps-cover-author";
    const author = appsCoverAuthorOf(spec);
    who.textContent = author;
    who.hidden = !author;
    who.title = author;
    cap.appendChild(who);
    cover.appendChild(cap);
  }
  return cover;
}

/* 卡片作者口径（用户口径：只显示**原作者**；本机装的是别人的分支时补一句当前版本作者）：
   原作者 = 家族根条目的作者，本机已装那一支的作者挂在后面。 */
function appsCoverAuthorOf(spec) {
  const id = String((spec && spec.id) || "");
  const root = appsFamilyRootOf(spec) || spec;
  const author = appsAuthorOf(root) || appsAuthorOf(spec);
  const localApp = id ? appsLocalById(id) : null;
  const localAuthor = localApp ? appsInstalledAuthorOf(spec, localApp) : "";
  return author
    ? appsT("原作者 ") + author + (localAuthor && localAuthor !== author ? appsT(" · 当前版本作者 ") + localAuthor : "")
    : "";
}

/* 危险动作（删除）的图标按钮：同一套小方框，只多一个 .apps-ico-danger（红描边，只在悬停时亮）。
   与别的图标按钮一样不冒泡（点它不开详情窗）。 */
function appsDangerIcoBtnEl(kind, title, onclick) {
  const b = appsIcoBtnEl(kind, title, onclick);
  b.classList.add("apps-ico-danger");
  return b;
}

/* 封面右下角那一排图标按钮（同一套小方框 .apps-ico-btn）。返回 null = 这一张卡一个入口都没有。
 * 目录卡：下载（未装）/ 更新（已装且有新版本）/ ⓘ / 金币；
 * 库页卡：运行 / 更新（有新版才有）/ ⓘ / 金币 —— 卸载、数据目录、二次开发、其他版本全在详情窗里；
 * 「我的应用」卡（o.mine）：编辑（删除收进编辑窗）—— 这一页就是作者的自管页，
 *   卡片上直接摆编辑那一枚（点卡本身仍是开详情窗）。 */
function appsCoverActionsEl(spec, opts) {
  const o = opts || {};
  const row = document.createElement("div");
  row.className = "apps-cover-acts";
  let n = 0;
  const push = (el) => {
    if (el) {
      row.appendChild(el);
      n++;
    }
  };
  if (o.mine) {
    /* 「我的应用」卡（本轮共识）：**只留一枚「编辑」**。
       下架 / 重新发布整条移除（连服务端路由一起删）；
       删除也不再摆在外侧 —— 它搬进「编辑应用」窗底栏那颗危险按钮（文案：云端彻底删除，不可恢复）。 */
    push(
      appsIcoBtnEl("edit", appsT("编辑：改描述 / 标题 / 图标 / 标签 / 上架截图"), () =>
        openAppEdit(spec && spec.id),
      ),
    );
    return n ? row : null;
  }
  if (o.local) {
    push(appsRunIcoBtnEl(spec.id, !!spec.windowOpen));
    const upTarget = appsCardUpdateTargetOf(spec);
    if (upTarget) {
      push(
        appsIcoBtnEl(
          "download",
          appsT("更新到本机已装那一支的作者最新版（v") + upTarget.version + "）",
          () => appsCatalogUpdate(spec, upTarget.ownerId, upTarget.version),
        ),
      );
    }
  } else if (!spec.installed) {
    const dl = appsIcoBtnEl(
      "download",
      spec.compatible === false
        ? appsT("该应用要求的 MTNode 版本高于当前版本")
        : appsT("下载：先在详情里选分支与版本（默认原作者最新版），确认后再装到本机"),
      () => appsOpenDetailForPick(spec.id),
    );
    dl.disabled = !!APPS_ST.busy[spec.id] || spec.compatible === false;
    push(dl);
  } else {
    /* 已装：卡上不再放「启动」（点卡就进详情，详情里有运行入口），只在有新版本时给更新 */
    const up = appsCardUpdateTargetOf(spec);
    if (up) {
      const b = appsIcoBtnEl(
        "download",
        up.reason === "same-version"
          ? appsT("作者就地重传了同一版（v") + up.version + appsT("）：覆盖安装把云端那份新包换到本机")
          : appsT("更新到本机已装那一支的作者最新版（v") + up.version + "）",
        () => appsCatalogUpdate(spec, up.ownerId, up.version),
      );
      b.disabled = !!APPS_ST.busy[spec.id];
      push(b);
    }
  }
  /* ⓘ「详细」图标本轮已摘掉（点卡片本身就是开详情窗，两处用途重复）：
     卡片动作只剩「下载 / 更新」与「打赏」。 */
  const cloudTarget = appsCloudTarget(spec);
  if (cloudTarget && window.MtTips) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini apps-ico-btn apps-ico-coin";
    btn.dataset.appTip = "1";
    btn.appendChild(window.MtTips.coinIcon("sm"));
    btn.title = appsTipsTitleEl(spec);
    btn.setAttribute("aria-label", appsT("打赏作者（鲸圆币）"));
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      window.MtTips.open(cloudTarget, {
        tips: appsSpecWithTips(spec).tips,
        /* 打赏成功（或窗里刷新过）→ 立刻重拉这一页的汇总并重绘：刚打赏完回来看到的数字必须是新的 */
        onDone: () => {
          appsTipsRefreshNow();
          appsHubPaint();
        },
      });
    };
    push(btn);
  }
  return n ? row : null;
}

function appsTileEl(spec, opts) {
  const o = opts || {};
  const id = spec.id;
  const name = appsSpecTitle(spec) || id;
  const card = document.createElement("div");
  card.className = "apps-tile";
  card.dataset.appId = id;
  if (o.local) card.dataset.local = "1";
  if (o.mine) card.dataset.appMine = "1";
  card.appendChild(appsCoverEl(spec, name, { withText: true, eager: !!o.eager }));
  const acts = appsCoverActionsEl(spec, { local: !!o.local, mine: !!o.mine });
  if (acts) card.appendChild(acts);
  const prog = document.createElement("div");
  prog.className = "apps-prog";
  prog.hidden = true;
  prog.innerHTML = "<i></i>";
  const progTxt = document.createElement("div");
  progTxt.className = "apps-prog-txt";
  progTxt.hidden = true;
  card.appendChild(prog);
  card.appendChild(progTxt);
  /* 点封面空白处 = 打开应用详情窗（与微软商店一致）；图标按钮各自 stopPropagation，不误触。
     键盘也一样：卡片自己 tabindex=0，Enter / 空格即开。 */
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", name);
  card.addEventListener("click", () => {
    if (typeof window.openAppsDetail === "function") window.openAppsDetail(id);
  });
  card.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (typeof window.openAppsDetail === "function") window.openAppsDetail(id);
    }
  });
  appsPaintProgress(id);
  return card;
}


/* 打赏 / 评论的对象标识：只有**上架到云端**的应用才在服务端有记录（本机自建、还没上架的
   在云端不存在，打赏与评论都无处可挂 —— 那种情况下一律不显示这两个入口，不弹空窗）。
   判据用「有没有云端作者身份」（ownerId / owner），与 appsSpecFromMine / catalog 条目同源。 */
function appsCloudTarget(spec) {
  /* 本轮口径：打赏 / 评论的目标 = **家族根条目的 id**（同一应用族的各作者分支共用一份累计；
     服务端按家族根统计，见 store-saas/tips.mjs 的 idSetOf）。根条目在云端不存在（本机自建、
     还没上架）时返回 null —— 调用方不放入口，不弹空窗。 */
  const root = appsFamilyRootOf(spec) || spec || {};
  const id = String(root.id || (spec && spec.id) || "");
  if (!id) return null;
  const cloud = !!(root.ownerId || root.owner);
  return cloud ? { kind: "app", id: id } : null;
}

/* 「应用 / 评论」页签那一版详情（appsDetailEl）**本轮已整体删除**（用户口径：移除下方 tab，
   下方只保留评论）：详情窗下方只挂评论这一块（见 appsDetailBuildShell 的 .apps-detail-cmt
   与 appsDetailPaint 的挂载），全仓再无第二个调用方需要「应用 / 评论」两页。
   工坊条目（app-store.js）自己的 detailTabsEl 用法不受影响 —— 那是另一个页面。 */

/* 详情正文 = **右列**那一串块（本轮版式：应用的说明 / 分支 / 打赏 / 开发者信息都在右侧）。
 *   ★ 详情窗与列表模式的内嵌面板都读这一份（面板由 app-apps-list.js 追加在它自己的信息行之后），
 *     所以两边的内容永远不会走样 —— 加块只加在这里一处。
 * 顺序（本轮共识）：描述 → 分支树（含选中分支的版本与动作）→ 打赏记录 → 能力小标 →
 *   （作者自己的条目）上架状态提示 + 编辑 → 开发者信息▾。
 * head=true（详情窗那条路径）：作者 / 更新时间 / 版本 / 大小 / 标签 / 二次开发来源已经在
 *   appsDetailWhoEl 的信息行里，说明也由 appsDetailDescEl 排好，这里不再重复画一遍；
 * 其它调用方（卡片路径，历史沿用）行为一字不变：版本表 + 信息行 + 完整说明都在。 */
function appsDetailBodyEl(spec, extra) {
  const local = (extra && extra.app) || appsLocalById(spec.id);
  /* 云端版本表（多版本条目）默认画在这里；详情对话窗里由窗口自己排（本机版本块在前），
     所以那条路径传 noVers:true 免得同一份版本表画两遍 */
  const noVers = !!(extra && extra.noVers);
  const head = !!(extra && extra.head);
  const box = document.createElement("div");
  box.className = "apps-detail";
  /* 本机应用的管理动作（运行 / 数据目录 / 二次开发 / 卸载）本轮已搬到底栏左下角，
     只在**详情窗**那条路径出现（见 appsDetailFootActsPaint）——这里不再摆第二份。 */
  const rows = [];
  const push = (k, v) => {
    if (v == null || v === "") return;
    rows.push([k, String(v)]);
  };
  if (!head) {
    push(appsT("版本"), String(spec.version || "") + (local ? " · " + appsT("本机 ") + String(local.version || "") : ""));
    push(appsT("作者"), appsAuthorOf(spec));
    /* 二次开发来源（有声明才显示）：写清「基于谁的那一版改的」——ui 只显示作者名与源应用 id
       （作者名同「作者」行口径：显示名优先，占位名 / uid 不显示） */
    const fo = appsNormForkOf(spec.forkOf) || appsNormForkOf(spec.localForkOf);
    if (fo) {
      const foWho = String(fo.ownerName || "").trim() || (appsIsPlaceholderName(fo.owner) ? "" : String(fo.owner || "").trim());
      push(appsT("二次开发自"), fo.id + (foWho ? "（" + foWho + "）" : ""));
    }
    push(appsT("标签"), Array.isArray(spec.tags) && spec.tags.length ? spec.tags.join(" · ") : "");
    const full = document.createElement("div");
    full.className = "apps-detail-full";
    full.textContent = appsSpecDesc(spec) || appsT("（这个应用还没写描述）");
    box.appendChild(full);
  } else {
    /* 「当前选择的作者与版本」那一行动作条（本轮需求 4）：紧跟信息列的「版本」行下面 ——
       它显示的就是「分支 / 版本」跳窗里选定的那一支那一版，并能就地下载 / 启动 / 重新开窗选。 */
    const pickbar = appsPickBarEl(spec.id);
    if (pickbar) box.appendChild(pickbar);
    /* 说明（Markdown）——头部右列的第二块 */
    const desc = appsDetailDescEl(spec, local);
    if (desc) box.appendChild(desc);
  }
  /* ① 分支树（含选中分支的版本与下载 / 覆盖 / 启动）：云端条目才有分支可画。
     **详情窗 / 列表面板那条路径（head）不再画它** —— 分支与版本本轮整体搬进「分支 / 版本」
     跳窗（见 openAppsVersionDlg），外面只留上面那条 appsPickBarEl；卡片路径（非 head）照旧。 */
  if (spec && spec.id && !head) {
    const tree = appsBranchTreeEl(String(spec.id), {
      branches: appsDetailBranchListOf(String(spec.id)),
      selectedOwnerId: appsDetailSelKey(),
      withSel: true,
      debug: typeof window.__mtnodeAppsBranchDbg === "function" ? window.__mtnodeAppsBranchDbg : null,
    });
    if (tree) box.appendChild(tree);
  }
  /* 多版本（§七）：只有一版时不画（详情里那行「版本」已经够了）。
     对话窗里不在这里画（noVers）—— 窗把本机那一块排在分支动作之后，只画一次。 */
  if (!noVers) {
    const vers = appsVersionTreeEl(spec);
    if (vers) box.appendChild(vers);
  }
  const table = document.createElement("div");
  table.className = "apps-detail-rows";
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "apps-detail-row";
    const kk = document.createElement("span");
    kk.className = "apps-detail-k";
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.className = "apps-detail-v";
    vv.textContent = v;
    vv.title = v;
    row.appendChild(kk);
    row.appendChild(vv);
    table.appendChild(row);
  }
  if (rows.length) box.appendChild(table);
  /* ② 打赏记录一行（**历史口径：修「详细里打赏反复全套了两次」**）：
     原来这里塞了两块 —— `MtTips.metaEl` 的只读汇总 + `MtTips.buttonEl` 打赏按钮，
     而那颗按钮内部又原样印了一遍「N [币] · M 次」（app-tips.js 的 buttonEl），
     于是同一个窗口里同一份数字出现两遍、且两处都能点开打赏窗。
     现在只留**一行**：「打赏记录 N 币」（币数走鲸圆币图标）。整行**不可点**，
     鼠标悬停才出「累计打赏 N 币（M 次）」；一次都没被打赏过（N = 0 / 数据没取到）**整行不显示**。
     打赏入口只留在卡片右下角那枚金币图标上（见 appsCoverActionsEl）。 */
  const tipTarget = appsCloudTarget(spec);
  if (tipTarget && window.MtTips) {
    /* 详情窗是按 id 取条目的（appsDetailSpecOf 不走 appsSpecListAll 那条挂汇总的路），
       同一份汇总只有从这条口径拿才与卡片一致（appsTipsOf = 唯一取数口径）。 */
    const tips = appsTipsOf(spec);
    const bar = window.MtTips.detailRecordEl(tipTarget, tips);
    if (bar) box.appendChild(bar);
  }
  /* ③ 能力小标（app.json 的 capabilities，主进程已算好文案与 tooltip）：
     用一句话说清这个应用带不带语音 / 出图。 */
  if (local) {
    const caps = Array.isArray(local.capabilityBadges) ? local.capabilityBadges : [];
    if (caps.length) {
      const capRow = document.createElement("div");
      capRow.className = "apps-detail-caps";
      for (const label of caps) {
        const b = document.createElement("span");
        b.className = "apps-badge apps-badge-cap";
        b.textContent = String(label || "");
        b.title = appsT("这个应用声明的能力（在开发页「应用能力…」里改）");
        capRow.appendChild(b);
      }
      box.appendChild(capRow);
    }
  }
  /* ④ 作者自己的条目：只留「编辑…」。
     本轮口径：下架功能整体移除（卡片与详情都不再摆「下架 / 重新发布」）；
     删除也搬进编辑窗（那颗与保存 / 取消同排的危险按钮），这里不摆危险动作。
     「这个应用不在商店目录里…」那条上架状态提示（appsVisibilityNoticeOf）按用户口径**整条移除**
     —— 云端那条记录带着历史「已下架」标记时它会一直显示，作者要的只是重新上传一版。 */
  if (spec.mine === true) {
    const mineBar = document.createElement("div");
    mineBar.className = "apps-detail-mine";
    mineBar.appendChild(appsMiniBtn(appsT("编辑…"), () => openAppEdit(spec.id)));
    box.appendChild(mineBar);
  }
  /* ⑤ 开发者信息（默认折叠）：技术字段 + 校验值小按钮 —— 右列最末一块 */
  box.appendChild(appsDetailDevMetaEl(spec, local));
  return box;
}

/* 作者自己的应用**目录可见性**提示（appsVisibilityNoticeOf）按用户口径**整条移除**（2026-10）：
 *   原来它判「我这一支不在公开目录里」就给一句「这个应用不在商店目录里（云端确实没把它列出来）：
 *   包与版本还在，重新上传一次即可回到目录。」—— 线上唯一那条测试应用的现场是：云端记录带着
 *   历史「已下架」标记（GET /api/apps/pub 的 last.reason = 下架 sudoku（ms2308）），目录生成时被
 *   过滤掉，于是这句提示永远挂着。作者要的操作只有一个：重新上传一版（服务端追加版本会恢复可见），
 *   界面上不必再解释一遍。 */

/* 详情窗里「本机应用」的管理动作区（本轮需求：库页卡上收掉的那三个入口搬到这里）：
   运行 / 📂 数据目录 / 二次开发 / 卸载。只在本机装了时出现，且只在详情正文里出现一次
   —— 与卡片右下角那排图标不重复（打赏 / 详细 / 下载更新仍在卡上）。 */
function appsDetailLocalActionsEl(spec, local) {
  const id = String((spec && spec.id) || (local && local.id) || "");
  if (!id) return null;
  const wrap = document.createElement("div");
  wrap.className = "apps-detail-local";
  const head = document.createElement("div");
  head.className = "apps-detail-local-k";
  head.textContent = appsT("本机应用");
  wrap.appendChild(head);
  const row = document.createElement("div");
  row.className = "apps-detail-local-row";
  row.appendChild(appsMiniBtn(appsT("运行"), () => appsOpenApp(id), true));
  /* 数据目录（用 app id 管理，默认 <数据目录>/apps-data/<id>/）：路径只由主进程解析 */
  const dirBtn = appsMiniBtn("📂 " + appsT("数据目录"), () => appsDataOpenNow(id));
  dirBtn.title = appsT("打开这个应用的数据目录（默认在 MTNode 数据目录下按应用 id 建）");
  row.appendChild(dirBtn);
  /* 「二次开发」：登记为开发中 + 建同名画布与开发节点 */
  row.appendChild(appsSecondaryDevBtnEl(local || { id: id }));
  const isDevApp = !!(local && (local.dev === true || local.kind === "dev"));
  const un = appsMiniBtn(
    appsT(isDevApp ? "移除登记" : "卸载"),
    () => appsUninstallApp(local || { id: id }),
  );
  if (!isDevApp) un.classList.add("danger");
  un.title = isDevApp
    ? appsT("只移除登记：项目文件夹与里面的文件一个都不会删（要删文件请自己在资源管理器里删）")
    : appsT("卸载只删它在下载根下的子文件夹与它自己那一棵数据，项目根与开发数据一概不动");
  row.appendChild(un);
  wrap.appendChild(row);
  return wrap;
}

/* 开发者信息块（默认折叠）：技术字段 + 校验值小按钮。单独成函数是为了让
   appsDetailBodyEl 只做「排版」，技术字段这堆值的来源一眼可查。 */
function appsDetailDevMetaEl(spec, local) {
  const devRows = [];
  const pushDev = (k, v) => {
    if (v == null || v === "") return;
    devRows.push([k, String(v)]);
  };
  pushDev(appsT("应用 id"), spec.id);
  pushDev(appsT("作者 uid"), spec.ownerId || spec.localOwnerId || "");
  pushDev(appsT("入口页"), spec.entry);
  pushDev(appsT("需要的 MTNode 版本"), spec.minAppVersion);
  pushDev(appsT("下载地址"), spec.zipUrl);
  pushDev(
    appsT("窗口尺寸"),
    spec.window && (spec.window.width || spec.window.height)
      ? String(spec.window.width || "") + "×" + String(spec.window.height || "")
      : "",
  );
  if (local) {
    pushDev(appsT("本机目录"), local.dir);
    pushDev(appsT("占用"), appsBytes(local.bytes) + " · " + local.files + appsT(" 个文件"));
    pushDev(appsT("安装时间"), appsTime(local.installedAt || local.mtimeMs));
    pushDev(appsT("来源作者"), local.owner || local.author || "");
  }
  return appsDevMetaEl(devRows, { label: "安装包 sha256", value: spec.sha256 || (local && local.sha256) || "" });
}

/* ── 同一次「内容不变」的重绘不再整屏重建（本轮需求：反复刷新导致闪烁）──────────────
 * 打开应用中心这一路上，正文会被重画好几次：开页那次（壳）、数据到齐那次、
 * 打赏汇总到齐那次、点搜索 / 切标签（180ms 防抖）各一次 —— 每一次都走 appsHubPaint：
 * body.innerHTML="" → 重建整个卡片网格（窗口化实例也重挂、滚动位置回零）。
 * 内容没变也重建 = 用户看到的「一直在刷新」：卡片位置跳、图重挂重播淡入。
 *
 * 收口：画之前先算一个**内容摘要**（页 / 搜索词 / 标签 / 展示条目 id 顺序 / 目录元信息），
 * 与「上一次画进 DOM 的那一份」比对 —— 一致就什么都不做（既不重建，也不动滚动位置），
 * 只把该补的（壳顶那两行由 appsHubTopbar 负责）留给上层。栅栏用一枚标记元素：
 * 它还在 .apps-hub-body 里 = 上一次画的这一屏**还在**，摘要才有可比性
 * （换页 / 关闭 / 别处重建都把它拆掉，那时一律照画）。
 * 数据真的变了（新版本 / 下载完 / 搜索词变）摘要自然不同 → 照旧整屏重画，功能不受影响。 */
function appsPaintKey(parts) {
  try {
    return JSON.stringify(parts);
  } catch (_) {
    return "";
  }
}
/* 上一次画进 DOM 的那一屏（宿主 / 页 / 内容摘要），见 appsPaintSkippable */
let APPS_LAST_PAINT = { host: null, nav: "", key: "" };

/* 标记元素：挂在正文末尾（不影响网格布局 —— 它 0 高度、不参与定位） */
function appsPaintMark(body) {
  const mark = document.createElement("div");
  mark.className = "apps-paint-mark";
  mark.setAttribute("aria-hidden", "true");
  body.appendChild(mark);
  return mark;
}
/* 该不该重画：返回 true = 这一屏还在 DOM 里且内容一字未变，调用方直接返回 */
function appsPaintSkippable(host, body, nav, key) {
  if (!APPS_LAST_PAINT || APPS_LAST_PAINT.host !== host || APPS_LAST_PAINT.nav !== nav) return false;
  if (APPS_LAST_PAINT.key !== key) return false;
  const mark = body.lastElementChild;
  if (!mark || !mark.classList || !mark.classList.contains("apps-paint-mark")) return false;
  return mark.isConnected !== false;
}

/* 应用页「目录拉不到」的**唯一**判定：true = 真连不上（该说一句话），false = 不算错误。
 *   · source "remote" / "api" / "cache"：拿到目录了（0 条也一样是拿到了），不是连接问题；
 *   · source "empty" + answered：云端**答了**、只是 0 条（静态空目录 / 接口空表都算答了）
 *     —— 0 条不是错误，更不是网络问题，这里什么都不说；
 *   · 其余（source "empty" 且 answered=false ／ source "error"，即静态与接口都没成、
 *     本机也没有缓存）：这才是真的连不上 → 只说一句「无法连接」。
 * 拆成纯函数是为了能真跑（test/smoke-apps.js [13b] 把它切进 vm 喂四种成因）。
 * 用户口径（2026-10-09）：不要成因解释、不要诊断信息 —— 真出错只报「无法连接」。 */
function appsCatalogDown(cat) {
  const c = cat || {};
  const src = String(c.source || "");
  if (src === "remote" || src === "api" || src === "cache") return false;
  if (src === "empty") return c.answered !== true;
  return true;
}

/* 「云端确实答上了」（拿到目录就算答了，0 条也是答了）：与 appsCatalogDown 互补的另一半。
   两件事必须分开说（用户口径 2026-10-09）：**连不上**说「无法连接」，**没内容**说「无内容」。
   拆成纯函数与 appsCatalogDown 同源；判定吃的是当前目录状态（APPS_ST.cat），不再另收一份入参
   （两份入参就是在问「谁说了算」，回归见 test/smoke-apps.js [13b]）。 */
function appsCatalogKind() {
  return appsCatalogDown(APPS_ST.cat) ? "down" : "content";
}

/* 「云端答上了、目录就是空的」（connection 没问题，只是线上还没有可上架的应用）。
   与 appsCatalogBlank 的区别：那个还要求「本页一条卡片都没画」；这一条只看目录本身，
   因此**刷新按钮的文案**能借它说实话 —— 云上就是 0 条时报「刷新失败：仍在显示本机缓存」
   是假话（根本没有缓存可显示，用户白查一遍网络，2026-10-09 报的就是这句）。 */
function appsCatalogAnsweredEmpty() {
  const c = APPS_ST.cat || {};
  return !appsCatalogDown(c) && String(c.source || "") === "empty" && c.answered === true;
}

/* 空态到底是「云端目录是空的」还是「筛没了」：判据 = 云端答上了 + 目录里一条都没有。
   注意与「筛选后 0 条」分开：那种走 appsNoMatchText()（搜索词 / 标签没命中，给的是退回去的办法）。
   （cat 参数只为与两个空态函数同一份调用形状：真实判据全部来自 APPS_ST，不另吃一份入参） */
function appsCatalogBlank() {
  return appsCatalogKind() === "content" && !appsCatalogList().length;
}

/* 空态的**唯一**渲染出口（三个空态都在这里，方便真跑，见 test/smoke-apps.js [13b]）：
 *   kind "down"    → 真连不上：只说一句「无法连接」+「重试」（不要成因解释 / 诊断信息）；
 *   kind "empty"   → 云端答了、只是 0 条：如实说「无内容」+「刷新」
 *                    （原来这里什么都不画，用户看到的是一片空白）；
 *   kind "nomatch" → 目录里有内容、只是被搜索词 / 标签筛掉了：appsNoMatchText() 说清怎么退回去。
 * 三支各挂一个 data 标记：调试与回归都认它（连不上 = 这一屏是错误，空目录 = 这一屏是实话）。
 * 回执 { kind, text, btn } 就是这一屏说了什么 —— 调用方不看，但真跑的口径（冒烟）靠它认字，
 * 不必去 DOM 里猜。
 * 调用方（appsPaintAppsPage）负责「要不要画空态」的判定（needEmpty）。 */
function appsPaintEmpty(body, kind) {
  const box = document.createElement("div");
  box.className = "apps-empty";
  if (kind === "nomatch") {
    box.textContent = appsNoMatchText();
    body.appendChild(box);
    return { kind: "nomatch", text: box.textContent, btn: "" };
  }
  const empty = kind === "empty";
  if (empty) box.dataset.appsCatEmpty = "1";
  else box.dataset.appsCatDown = "1";
  box.textContent = appsT(empty ? "无内容" : "无法连接");
  box.appendChild(document.createElement("br"));
  const btn = appsMiniBtn(appsT(empty ? "刷新" : "重试"), () => appsHubReloadNow(), true);
  box.appendChild(btn);
  body.appendChild(box);
  return { kind: empty ? "empty" : "down", text: box.textContent, btn: btn };
}

async function appsPaintAppsPage(body, seq) {
  /* 已有目录数据时不闪占位（搜索防抖到期后重绘这一页） */
  if (!APPS_ST.cat) {
    const loading = document.createElement("div");
    loading.className = "apps-empty";
    loading.textContent = appsT("正在拉取云端应用目录…");
    body.appendChild(loading);
  }
  await Promise.all([appsCatalogLoad(false), appsListLoad(false), appsRootLoad(), appsMineLoad(false)]);
  if (seq !== APPS_ST.seq || APPS_ST.nav !== "apps") return;
  /* 内容一字未变（打赏汇总 / 目录回调 / 同词防抖这类「无变化重绘」）→ 什么都不做：
     重建网格会让卡片跳位、封面图重挂重播淡入，正是用户说的「反复刷新」。
     摘要里带上展示条目与目录元信息：真的变了（新版本 / 下载完 / 搜索词变）照旧重画。 */
  const pageKey = appsPaintKey([
    "apps",
    APPS_ST.q,
    APPS_ST.tags || [],
    (APPS_ST.cat && APPS_ST.cat.fetchedAt) || 0,
    appsSpecListAll().map((s) => (s && s.id) || ""),
  ]);
  if (appsPaintSkippable(APPS_ST.host, body, "apps", pageKey)) {
    /* 壳顶那两行（搜索框状态 / 标签条）仍然按最新数据刷一次 —— 它们不在被重画的正文里 */
    appsHubTopbar();
    return;
  }
  APPS_LAST_PAINT = { host: APPS_ST.host, nav: "apps", key: pageKey };
  body.innerHTML = "";
  /* 搜索框与标签条不在正文里（壳的顶部一行，见 appsHubTopbar）：这里只更新它的页名与标签条 */
  appsHubTopbar();
  /* 目录条目 × 我的线上条目（mine / 更全的版本树） */
  const list = appsSpecListAll();
  const shown = appsFilterSpecs(list);
  /* 打赏汇总：列表**载入 / 刷新**就问一次（悬停时不问网络，见 appsTipsEnsure 的注释）。
     同一批 id 只问一次，回来重绘一次 —— 卡片的金币 icon 悬停文案随即带上真实数字。 */
  appsTipsEnsure(list, false);
  /* 顶部那条「目录状态」文字按用户口径**整条移除**（2026-10）：
     原来这里会写「云端目录已更新（时间）/ 云端接口目录（…）/ 云端目录暂时拉不到，显示的是本机缓存
     （时间）/ 云端目录为空或还没发布…」。用户点名要去掉的就是那句「本机缓存 + 时间戳」——
     有目录就直接用，界面不再解释目录是从哪儿来的、什么时候拉的。
     目录**真的拉不到**时的反馈只剩一处：点刷新按钮（appsHubReloadNow）失败时弹一下 toast；
     「有没有内容」由下面的空态说（appsPaintEmpty：无内容 / 无法连接）。 */

  /* 有筛选时给一行摘要（含「清除筛选」）：用户一眼看出列表为什么短了、怎么回到全量 */
  const fline = appsFilterLineEl(list.length, shown.length);
  if (fline) body.appendChild(fline);

  /* ── 空态：**只按「有没有拿到目录」分两句**（用户口径 2026-10-09） ─────────────────
     ① 目录到手、就是 0 条（source "remote"/"api"/"cache"，或 source "empty" + answered）
        → 如实说一句「无内容」（这里原来什么都不画，用户看到的就是**一片空白**：
        以为页面坏了 / 以为还在加载，正是「无内容时显示无内容」这条要求的由来）；
     ② 静态目录与云端接口都没成、本机也没有缓存 → 只说一句「无法连接」+ 一颗「重试」。
        用户明确不要成因解释、不要诊断信息、不要「请检查网络 + 重新进入本页」。
        「重试」走 appsHubReloadNow：force 绕开 5 分钟新鲜期（APPS_CAT_TTL）真重拉，
        比让用户「重新进入本页」管用（重进多少次都还是同一份新鲜期内的结果）。
     判定在 appsCatalogKind / appsCatalogBlank（纯函数），三支空态的渲染唯一出口是 appsPaintEmpty
     —— 都能真跑，见 test/smoke-apps.js [13b]。
     `needEmpty` = 正文一条卡片都没画（作者自己那些只在接口回执里的条目也算进去：
     他在这一屏看得见自己的应用就不用再说「无内容」）。
     筛选后 0 条不在这里 —— 那是 appsPaintEmpty("nomatch")「没有匹配…」，给的是退回去的办法。 */
  const needEmpty = !shown.length && !appsCatalogList().length;
  if (needEmpty && appsCatalogKind() === "down") {
    appsPaintEmpty(body, "down");
    appsPaintMark(body);
    return;
  }
  if (needEmpty && appsCatalogBlank()) {
    appsPaintEmpty(body, "empty");
    appsPaintMark(body);
    return;
  }
  if (!shown.length) {
    /* 两个空态都没命中（目录里确实有内容，只是被搜索词 / 标签筛掉了）→ 说清怎么退回去 */
    appsPaintEmpty(body, "nomatch");
    appsPaintMark(body);
    return;
  }
  /* 重绘栅栏标记（四个出口各一次：连不上 / 无内容 / 无命中 / 正常网格 —— 列表模式也走这里） */
  appsPaintMark(body);
  /* 视图分流（本轮共识）：列表模式 = 左列表 + 右内嵌详情面板（renderer/app-apps-list.js），
     网格模式 = 原来的卡片网格（窗口化渲染，一条都没动）。 */
  if (appsViewIsList("apps") && appsListModeMount(body, shown, { sort: "updated" })) {
    return;
  }
  /* 卡片网格走**窗口化渲染**（见 appsVirtualGrid）：目录 1000 条时只渲染看得见的那几行，
     首帧 DOM、首帧布局与内存都不再随目录条数线性增长；封面图本来已 loading=lazy。
     这里走一层 APPS_GRID_PAINT：验证台 test/apps-scale-1000.cjs 把它换成「一次性全建」，
     就能用同一份数据量出优化前后的对照 —— 不必在生产代码里留开关。 */
  APPS_GRID_PAINT(body, shown);
}

/* ── 列表模式的装配出口（应用 / 库 / 我的应用三页共用） ───────────────────────
 * 做两件事：① 按各页口径排序 ② 交给 renderer/app-apps-list.js 装配「左列表 + 右面板」。
 * AppsList 没加载（老包 / 局部测试）时如实回 false，调用方回落卡片网格。
 * opts.sort："updated"（默认，按云端更新时间）| "lastRun"（库页，按最后一次运行）。 */
function appsListModeMount(body, items, opts) {
  const o = opts || {};
  const L = window.AppsList;
  if (!L || typeof L.mountListMode !== "function") return false;
  const list = appsSortForList(items, o.sort);
  try {
    L.mountListMode(body, {
      items: list,
      sortKey: o.sort || "updated",
      rowEl: (spec) => L.rowEl(spec, { sort: o.sort }),
      /* 面板要的条目：本机那一份（appsLocalSpecOf）能补齐显示名 / 版本 / 封面来源，
         与卡片走的是同一个合并口径；没有本机副本时就用目录条目本身。 */
      panelSpec: (spec) => {
        const local = appsLocalById(String((spec && spec.id) || ""));
        return local ? appsLocalSpecOf(local) : spec;
      },
      emptyText: o.emptyText || appsT("无内容"),
    });
  } catch (_) {
    /* 面板装配炸了不能把整页带走：如实回落网格（用户至少还能用卡片路径） */
    return false;
  }
  return true;
}
/* 列表模式的排序（本轮共识）：
 *   应用中心 → 云端「更新时间」倒序（新的在上）；我的应用 → 更新时间倒序；
 *   库 → **最后一次运行时间**（lastRunAt）倒序，没跑过的按安装时间兜底排最后。
 * 时间相同用 id 兜底，保证顺序稳定（不然每次重绘列表会抖）。 */
function appsSortForList(items, sort) {
  const list = Array.isArray(items) ? items.slice() : [];
  const stampOf = (s) => {
    if (sort === "lastRun") {
      const local = appsLocalById(String((s && s.id) || ""));
      return Number((local && local.lastRunAt) || 0) || Number((local && local.installedAt) || 0);
    }
    return appsUpdatedAtOf(s);
  };
  list.sort((a, b) => {
    const d = stampOf(b) - stampOf(a);
    if (d) return d;
    return String((a && a.id) || "").localeCompare(String((b && b.id) || ""));
  });
  return list;
}

/* 网格渲染出口（默认 = 窗口化）。应用页与库页都走它：这是全模块**唯一**一处
   「列表怎么进 DOM」的出口，只读验证台替换的就是它（见上方注释）。 */
function APPS_GRID_PAINT(body, list, opts) {
  /* 只读验证台（test/apps-scale-1000.cjs）与冒烟可以在 window 上注入一份替身，用来量
     「换成一次性全建」的对照 —— 生产路径上 __mtnodeGridPaint 恒为空，一行也不会走到。 */
  const probe = typeof window !== "undefined" && window.__mtnodeGridPaint;
  if (typeof probe === "function") return probe(body, list, opts);
  return appsVirtualGridMount(body, list, opts);
}

/* ── 卡片网格窗口化渲染（renderer/app-apps.js · 应用页与库页共用） ──────────────
   为什么要它（本轮需求「1000 个应用」）：原来是把 shown 里每一条都 appendChild 进
   .apps-grid —— 1000 条目录就是 1000 张卡一次进 DOM：首帧要建一万多个节点、布局一次，
   内存与首次可交互时间一起线性上涨，弱机直接卡死。这里只渲染**可视区 + 上下各两行**，
   其余用小薄片撑出精确高度（滚动条长度与实际条数一致，不跳、不闪）。

   为什么自算几何（不用 CSS auto-fill 网格）：卡片是固定 16:9（.apps-cover 的 aspect-ratio），
   行高只由列宽决定。所以量一次 .apps-hub-body 的内容宽就能算出列数与行高，几何是确定的 ——
   绝对定位 + 小薄片比 IntersectionObserver 更可控（没有「滚太快露白」的窗口）。

   生命周期：宿主每次重绘都会 body.innerHTML = ""，所以这里在挂载前先收掉上一次的实例
   （dispose 拆 scroll / resize 监听）；appsHubPaint 里也再兜一层。 */
let APPS_VGRID = null;

function appsVirtualGridDispose() {
  /* 这一批登记中的封面图当场落定：卡片马上要被整批换掉，别让图换到已经作废的元素上
     （本轮「界面先出、图像一次到位」—— 重绘不留下半张半张的卡） */
  appsImgFlush();
  if (!APPS_VGRID) return;
  try {
    APPS_VGRID.dispose();
  } catch (_) {}
  APPS_VGRID = null;
}

/**
 * 渲染一屏卡片。list 是所有要展示的 spec（顺序 = 展示顺序），返回控制器。
 * 列表为空时不建容器（调用方已经在上面处理空态）。
 */
function appsVirtualGridMount(body, list, opts) {
  const o = opts || {};
  appsVirtualGridDispose();
  const items = Array.isArray(list) ? list.slice() : [];
  if (!body || !items.length) return null;
  /* 可视区优先用 .apps-hub-body（页面自己的滚动条）；库页/开发页同样在它里面。
     量不到（宿主还没挂载 / 面板宽度为 0）就退回窗口尺寸，至少不退化。 */
  const sc = o.scrollEl || (body.closest ? body.closest(".apps-hub-body") : null) || document.scrollingElement || document.documentElement;
  const wrap = document.createElement("div");
  wrap.className = "apps-vgrid";
  const grid = document.createElement("div");
  grid.className = "apps-grid apps-grid-abs";
  wrap.appendChild(grid);
  body.appendChild(wrap);
  /* 重绘后从顶部开始（与整块重建同观感）：先置 0 再算窗口，避免用上一次页面的滚动位置算错行 */
  try {
    sc.scrollTop = 0;
  } catch (_) {}

  let cols = 1;
  let colW = 248;
  let topInScroller = 0;
  let rowH = 152;
  const GAP = 12;
  const BUFFER_ROWS = 2;
  let cards = []; /* [{ el, idx }]，只含当前窗口内的卡 */
  const byIdx = new Map();
  let raf = 0;

  function measure() {
    /* 列宽从**滚动容器的内容宽**算（body 有 14px 左右内边距；grid 自己被 contain 包着，
       量它自己的宽度会把这层内边距算漏 → 列宽偏大、卡片被裁）。 */
    const g = getComputedStyle(grid);
    const gx = parseFloat(g.columnGap) || GAP;
    const gy = parseFloat(g.rowGap) || gx;
    let avail = 0;
    if (sc && sc.clientWidth) {
      const cg = getComputedStyle(sc);
      avail = sc.clientWidth - (parseFloat(cg.paddingLeft) || 0) - (parseFloat(cg.paddingRight) || 0);
    }
    if (!(avail > 40)) avail = Math.max(40, wrap.getBoundingClientRect().width || window.innerWidth || 800);
    cols = Math.max(1, Math.floor((avail + gx) / (248 + gx)));
    colW = (avail - gx * (cols - 1)) / cols;
    if (colW <= 0) colW = avail;
    /* 行高 = 封面 16:9 + 卡片上下边框（2px×2）；量不到就退回估算值，渲染后还会用真实值校正 */
    const probe = grid.querySelector(".apps-tile");
    rowH = (probe && probe.offsetHeight) || Math.round((colW * 9) / 16) + 4;
    /* grid 顶边在**滚动内容坐标系**里的位置：滚动容器有内边距，且它可能自己没滚动
       （窗口滚动的情况），所以用视口坐标差换算，再减掉当前 scrollTop。 */
    const b = wrap.getBoundingClientRect();
    const s = sc.getBoundingClientRect ? sc.getBoundingClientRect() : { top: 0 };
    topInScroller = Math.max(0, b.top - s.top - (sc.scrollTop || 0));
  }

  function cardAt(i) {
    let el = byIdx.get(i);
    if (el) return el;
    /* o.mine 必须一起传下去：「我的应用」那一页的卡片靠它画作者那一枚编辑入口。
       窗口化渲染上线时这里漏了它，整页的自管按钮
       当场消失、还多出一枚「下载」—— 库里已装的那份会被「更新」顶掉，用户看到的就是
       「我的应用显示不对」。**加选项时先看 appsTileEl 到底认哪几个键。** */
    el = appsTileEl(items[i], { local: !!o.local, mine: !!o.mine });
    el.style.position = "absolute";
    el.style.width = colW + "px";
    byIdx.set(i, el);
    return el;
  }

  function render() {
    const rows = Math.ceil(items.length / cols);
    grid.style.height = String(Math.max(0, rows * rowH + Math.max(0, rows - 1) * GAP)) + "px";
    const vh = sc.clientHeight || window.innerHeight || 800;
    const top = Math.max(0, (sc.scrollTop || 0) - topInScroller);
    const first = Math.max(0, Math.floor(top / (rowH + GAP)) - BUFFER_ROWS);
    const last = Math.min(rows - 1, Math.floor((top + vh) / (rowH + GAP)) + BUFFER_ROWS);
    const from = first * cols;
    const to = Math.min(items.length, (last + 1) * cols);
    const keep = new Set();
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) {
      keep.add(i);
      const el = cardAt(i);
      const r = Math.floor(i / cols);
      const c = i % cols;
      el.style.transform = "translate(" + (c * (colW + GAP)) + "px," + (r * (rowH + GAP)) + "px)";
      frag.appendChild(el);
    }
    for (const [i, el] of Array.from(byIdx)) {
      if (keep.has(i)) continue;
      byIdx.delete(i);
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    grid.appendChild(frag);
    cards = Array.from(keep).sort((a, b) => a - b).map((i) => ({ el: byIdx.get(i), idx: i }));
  }

  function schedule() {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }

  function relayout() {
    measure();
    grid.innerHTML = "";
    byIdx.clear();
    cards = [];
    render();
    /* 首帧量出来的行高可能和估算差 1~2px（边框 / 圆角）：渲染后再校正一次，薄片高度才精确 */
    const probe = grid.querySelector(".apps-tile");
    if (probe && probe.offsetHeight && Math.abs(probe.offsetHeight - rowH) > 1) {
      rowH = probe.offsetHeight;
      render();
    }
  }

  measure();
  render();
  sc.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  const ro = window.ResizeObserver ? new ResizeObserver(schedule) : null;
  if (ro) {
    try {
      ro.observe(wrap);
    } catch (_) {}
  }

  const ctl = {
    el: wrap,
    grid: grid,
    count: items.length,
    get cols() {
      return cols;
    },
    get rowH() {
      return rowH;
    },
    /** 只回报当前真的进了 DOM 的卡片数（冒烟断言「远小于总条数」就靠它） */
    rendered: () => byIdx.size,
    relayout: relayout,
    update: (next) => {
      const arr = Array.isArray(next) ? next : [];
      if (arr.length === items.length && arr.every((s, i) => s === items[i])) return;
      items.length = 0;
      Array.prototype.push.apply(items, arr);
      relayout();
    },
    dispose: () => {
      sc.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (ro) {
        try {
          ro.disconnect();
        } catch (_) {}
      }
      if (raf) {
        try {
          window.cancelAnimationFrame(raf);
        } catch (_) {}
      }
      raf = 0;
      byIdx.clear();
      cards = [];
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    },
  };
  APPS_VGRID = ctl;
  /* 只读诊断出口：验证台 / 冒烟要看「算出来的列数、行高、薄片高度」时用（见 test/apps-scale-1000.cjs） */
  try {
    window.__appsVGrid = ctl;
  } catch (_) {}
  return ctl;
}

/* 空结果的实话：分清「搜索词没命中」「标签没命中」「两个一起太窄」三种情况，
   并直接给一句怎么退回去（别让用户对着一句「没有匹配」猜）。 */
function appsNoMatchText() {
  const q = String(APPS_ST.q || "").trim();
  const tags = APPS_ST.tags;
  const cat = appsTagCatalog();
  const names = tags.map((k) => appsTagLabel(cat, k)).join(" · ");
  if (q && tags.length) {
    return appsT("没有同时满足「") + q + appsT("」与标签 ") + names + appsT(" 的应用：清掉一个条件再试。");
  }
  if (tags.length) {
    return appsT("没有带标签 ") + names + appsT(" 的应用：点一下标签取消它。");
  }
  return appsT("没有匹配「") + q + appsT("」的应用");
}

/* ───────────────── 库页（本机已下载） ───────────────── */

/* 卡片上那一排图标入口（**唯一的渲染出口**：卡片初次画、下载完 / 窗口开关后局部重画都走它，
   免得「重画时用另一套按钮」这种漂移）。两点说明：
   · 更新只在**同一支作者**时出现（与「应用」页同一口径）：更新按钮指向本机已装那一支的作者最新版，
     作者对不上说明这是别人的同 id 条目，更新会拿别人的包盖掉本机这一份 —— 那种情况该走详情里的「其他版本」。
   · 重画时**整排换掉**（不是往里塞按钮）：图标按钮带 disabled / 打开态，整排替换最省心。 */
function appsPaintTileActions(card, spec, local) {
  const row = card.querySelector(".apps-cover-acts");
  const fresh = appsCoverActionsEl(spec, { local: !!local });
  if (row) {
    if (fresh) {
      row.replaceWith(fresh);
    } else {
      row.remove();
    }
    return;
  }
  if (fresh) card.appendChild(fresh);
}

/* 库页卡片 = **与应用中心同一套 16:9 封面卡**（用户口径：库页一起统一）：本机这一份的作者 / 版本 /
   占用 / 路径 / 能力标全部收进详情窗（封面上只留标题 + 作者 +「本机 vX」），卡上只留两枚图标
   （运行、金币）；卸载 / 数据目录 / 二次开发三个入口在详情窗底栏左下角。
   本机条目 → 卡片 / 详情用得上的合并条目：显示名走本机 app.json 的 name（用户自己改过的那个），
   封面图 / 作者 / 打赏口径走云端目录条目（那条有 ownerId / ownerName / icon）。
   云端条目暂时拉不到（离线 / 还没上架）时退回本机 app.json 的作者，绝不因此不显示封面。 */
function appsLocalSpecOf(app) {
  const id = String((app && app.id) || "");
  const spec = appsSpecById(id);
  return Object.assign({}, spec || {}, {
    id: id,
    title: String((app && app.name) || (spec && appsSpecTitle(spec)) || id),
    ownerId: (spec && spec.ownerId) || (app && app.ownerId) || "",
    owner: (spec && spec.owner) || (app && app.owner) || "",
    ownerName: (spec && spec.ownerName) || "",
    /* 「这个应用的独立窗口开着吗」由 appsPaintLibPage 一次问齐后写进来（见 appsOpenIdsOf）：
       卡片窗口化渲染后，打开态只能在画卡那一刻带上。 */
    windowOpen: !!(spec && spec.windowOpen),
    /* 最后一次运行时间（本轮需求：库页列表模式按它倒序）—— 主进程写在安装账本里、
       appSummary 带上来。没有（本机自建 / 从没跑过）= 0，排序时排到末尾，不编造时间。 */
    lastRunAt: Number((app && app.lastRunAt) || 0) || 0,
  });
}

function appsLocalRowEl(app) {
  const id = String(app.id || "");
  const spec = appsSpecById(id);
  const card = appsTileEl(appsLocalSpecOf(app), { local: true });
  /* 卡片上不写版本号（用户口径：详情头部不写「云端 vX / 本机 vX」，卡片同样不写）——
     本机装的是哪一版在详情窗的「本机版本（可回滚）」块与本机信息里看。 */
  return card;
}

/* 根目录那一行 / 两行 + 「迁移旧布局…」入口**已整体移除**（本轮共识）：
 *   · 库页不再显示「项目根目录（开发中的应用）」那一行（开发中的应用在「开发」页管，
 *     库页只管下载根）；
 *   · 「迁移旧布局…」按钮与它的功能代码（appsMigrateLayoutNow + appsRewriteMovedAppPaths）
 *     一并删除 —— 用户口径是「移除按钮与功能」。
 *   · 下载根本身仍要能改：改成左上角那枚「应用目录」按钮（壳的第 1 行、刷新右边），
 *     点它弹小菜单（更改目录 / 在资源管理器中打开），见 appsRootMenuToggle 与
 *     renderer/app-apps-list.js 的 rootMenuEl。
 *   · 「二次开发」那条链路仍会调主进程的 apps:migrateLayout({id}) 把这一个应用归位到项目根
 *     （app-app-flow.js），那是**另一条**用户路径，与这里的按钮无关，不受影响。 */

/* ── 数据文件夹（每个应用一份：默认 <数据目录>/apps-data/<id>/，可让用户改成自己的文件夹）──
/* 选某一类应用的根目录（下载根 / 项目根；库页的工具条与开发页工具栏共用同一份动作） */
async function appsRootPickNow(kind) {
  const k = kind === "dev" ? "dev" : "down";
  const api = window.api || {};
  if (typeof api.appsRootPick !== "function") {
    appsBridgeMissing();
    return;
  }
  const r = await api.appsRootPick(k);
  if (!r || r.canceled || r.ok === false) {
    if (r && r.ok === false) appsToast(appsT("设置失败：") + appsErrText(r), "err");
    return;
  }
  if (r.roots) {
    if (APPS_ST.list) APPS_ST.list.roots = r.roots;
    APPS_ST.root = r.roots.down || APPS_ST.root;
    /* 内存副本跟着主进程走（见 appsRootsSyncConfig：不同步就会被下一次整份回写盖掉） */
    appsRootsSyncConfig(r.roots);
  } else {
    APPS_ST.root = { ok: true, path: r.path, configured: true, exists: !!r.exists };
  }
  APPS_ST.list = r.list && r.list.ok !== false ? r.list : null;
  appsToast(appsT(k === "dev" ? "项目根目录（开发中的应用）" : "下载根目录（从应用中心下载的）") + appsT("已设置：") + r.path, "ok");
  await appsListLoad(true);
  appsHubPaint();
}
/* 在资源管理器中打开某一类根目录 */
function appsRootFolderNow(kind) {
  const k = kind === "dev" ? "dev" : "down";
  const roots = (APPS_ST.list && APPS_ST.list.roots) || {};
  const p = String(((roots[k] || (k === "down" ? APPS_ST.root : null)) || {}).path || "");
  if (!p) {
    appsToast(appsT("还没设置应用根目录"), "warn");
    return;
  }
  if (typeof openWorkspaceFolder === "function") openWorkspaceFolder(p);
}

/* 路径比较（同一个目录的不同写法算同一个）：大小写不敏感（Windows 盘）、
   分隔符统一成 /（用户手填的目录可能写成 E:/apps/x）、去掉尾部斜杠。 */
function appsSamePath(a, b) {
  const norm = (v) =>
    String(v || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y;
}
/* ── 「📂 打开数据目录」与「二次开发」：库页每张卡片右侧、开发页菜单条共用同一份动作 ──
 *   数据目录用 app id 管理：默认 <数据目录>/apps-data/<id>/（用户改过数据文件夹则是他选的那个），
 *   路径只由主进程解析（apps:dataOpen），渲染层不拼路径、不写路径。
 *   这两个动作以前一个散在库页顶部的下拉行、一个散在「二次开发」独占行，现在都收进卡片右侧按钮。 */
async function appsDataOpenNow(id) {
  const appId = String(id || "").trim();
  if (!appId) {
    appsToast(appsT("先在列表里选一个应用"), "warn");
    return;
  }
  const api = window.api || {};
  if (typeof api.appsDataOpen !== "function") {
    appsBridgeMissing();
    return;
  }
  let r = null;
  try {
    r = await api.appsDataOpen(appId);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) {
    appsToast(appsT("打开数据目录失败：") + appsErrText(r), "err");
    return;
  }
  appsToast(appsT("已打开数据目录：") + String(r.dir || ""), "ok");
}
/* 「二次开发」= 把本机这个应用登记为「开发中」（库页不再列它）、建一张同名画布与开发节点，
   应用目录原地不动。执行体是被多处复用的 window.appsMigrateToDev（renderer/app-app-flow.js），
   这里只做「能不能点」的判断与一键收尾（切开发页 + 选中它）。 */
function appsSecondaryDevBtnEl(app) {
  const id = String((app && app.id) || "");
  const btn = appsMiniBtn(appsT("二次开发"), () => appsSecondaryDevRun(id));
  btn.dataset.appFork = "1";
  btn.title = appsT("把该应用登记为「开发中」（库页不再列它），并给它建一张同名画布与开发节点；应用目录不动");
  if (typeof window.appsMigrateToDev !== "function") {
    btn.disabled = true;
    btn.title = appsT("开发流程模块未就绪（renderer/app-app-flow.js 未加载）");
  }
  return btn;
}
async function appsSecondaryDevRun(id) {
  const appId = String(id || "").trim();
  if (!appId) return;
  if (typeof window.appsMigrateToDev !== "function") {
    appsToast(appsT("开发流程模块未就绪（renderer/app-app-flow.js 未加载）"), "err");
    return;
  }
  let r = null;
  try {
    r = await window.appsMigrateToDev(appId);
  } catch (e) {
    r = null;
    appsToast(appsT("二次开发失败：") + ((e && e.message) || String(e)), "err");
  }
  await appsListLoad(true);
  if (!r) {
    appsHubPaint();
    return;
  }
  /* 成功后按共识自动切到「开发」页并选中这个应用（与开发页「＋新建应用」收尾同一口径） */
  APPS_ST.nav = "dev";
  closeAppsDetail();
  if (typeof appsDevSelectApp === "function") appsDevSelectApp(r.id);
  else appsHubPaint();
  appsToast(appsT("已进入二次开发：") + (String(r.name || "") || r.id), "ok");
}

/* 库页可显示的应用：本机装了、还没带「开发中」标记的（已经开发中的不在库页，去开发页）。 */
function appsLibList() {
  return appsLocalList().filter((a) => !(a && a.dev === true));
}

async function appsPaintLibPage(body, seq) {
  const loading = document.createElement("div");
  loading.className = "apps-empty";
  loading.textContent = appsT("正在读取本机应用…");
  body.appendChild(loading);
  await Promise.all([appsListLoad(false), appsCatalogLoad(false), appsRootLoad()]);
  if (seq !== APPS_ST.seq || APPS_ST.nav !== "lib") return;
  body.innerHTML = "";
  /* 顶部一行在壳里（搜索框 / 标签条 / 右上角「返回 MTNode」），本页只更新它 */
  appsHubTopbar();
  /* 库页**不再显示根目录那两行**（本轮共识）：下载根改成左上角那枚「应用目录」按钮
     （壳的第 1 行、刷新右边，点它弹小菜单），项目根那一行整条撤掉（开发中的应用在「开发」页管）。
     旧的「迁移旧布局」入口与它的功能代码也一并删除 —— 见 appsRootPickNow 上面那段注释。
     「项目根丢了 → 一键恢复候选目录」那一行**也随本轮需求删除**：根目录默认就在数据目录下
     （<数据目录>/apps-dev），主进程列应用时顺手把默认路径固化下来，不存在「没配就整列消失」
     这个状态了；真有应用躺在别处，走开发页「项目根 … 更改…」指过去就行。 */
  /* 「＋ 新建应用」入口**只留在开发页**（本轮共识）：新建出来的应用一律算「开发中」，
     库页只列已下载、还没在开发的应用。 */
  const list = appsLibList();
  const devCount = appsLocalList().length - list.length;
  /* 「哪个应用已经开着独立窗口」要在画卡**之前**问齐：卡片改成窗口化渲染后，滚到下面的卡
     是滚动时才建的，原来那种「先画卡、再逐个回贴打开态」就贴不到了（离屏卡不在 DOM 里）。
     查询是一次 IPC 往返，几十上百个已装应用也就几十次，一次性问齐比逐个回贴更稳。 */
  const openIds = await appsOpenIdsOf(list);
  if (seq !== APPS_ST.seq || APPS_ST.nav !== "lib") return;
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "apps-empty";
    empty.textContent = devCount
      ? appsT("库里没有可显示的应用：本机这几个都带着「开发中」标记（在「开发」页）。")
      : appsT("还没有下载任何应用：到「应用」页挑一个下载，它会装进应用根目录；自己写的应用在「开发」页新建。");
    if (!devCount) {
      const go = appsMiniBtn(appsT("去「应用」页看看"), () => appsHubNav("apps"), true);
      empty.appendChild(document.createElement("br"));
      empty.appendChild(go);
    } else {
      const goDev = appsMiniBtn(appsT("去「开发」页"), () => appsHubNav("dev"), true);
      empty.appendChild(document.createElement("br"));
      empty.appendChild(goDev);
    }
    body.appendChild(empty);
    return;
  }
  /* 库页与应用中心同一套封面卡网格：同样走窗口化渲染（已装几百个应用的机器上，
     一次建上千张卡一样会卡）。打开态在卡片创建时就带上（见 appsLocalSpecOf 的 windowOpen）。
     列表模式（本轮共识）：走「左列表 + 右内嵌详情」，排序按**最后一次运行时间**倒序。 */
  const shown = list.map((app) => appsLocalSpecOf(app));
  for (const spec of shown) {
    if (openIds[String(spec.id || "")]) spec.windowOpen = true;
  }
  if (appsViewIsList("lib") && appsListModeMount(body, shown, { sort: "lastRun" })) return;
  APPS_GRID_PAINT(body, shown, { local: true });
}

/* ───────────────── 开发页（三栏开发 + 应用根目录） ───────────────── */

async function appsPaintDevPage(body, seq) {
  await Promise.all([appsListLoad(false), appsCatalogLoad(false), appsRootLoad()]);
  if (seq !== APPS_ST.seq || APPS_ST.nav !== "dev") return;
  body.innerHTML = "";
  /* 顶部一行按页更新（搜索框只在「应用」页露脸；标签条随当前条目集重算）。
     开发页正文由 appsDevPagePaint 追加，本行必须排在它前面。 */
  appsHubTopbar();
  /* 顶部菜单条只允许一行：应用根目录 / ＋新建应用 这两项不再各占一行，而是由开发页
     （renderer/app-apps-dev.js 的 appsDevPagePaint）并进它自己那条工具栏里，
     宽度不够时自动收进「更多 ▾」。库页（appsPaintLibPage）仍按原来的两行排。 */

  /* 三栏开发页（renderer/app-apps-dev.js）：左 = 只属于该 appId 的会话列表 ·
     中 = iframe 实时预览该应用的静态页 · 右 = 该会话正文 · 下 = 输入框（同一个 composer）。
     首轮输入 = 在该应用的开发节点上点「开发」并提交；每轮开发结束后按应用目录的内容快照
     决定要不要重载预览（「维持状态」开关控制重载前后存 / 写回页面状态）。 */
  if (typeof appsDevPagePaint === "function") appsDevPagePaint(body, seq);

  /* 页脚那个「更多：导出应用包 / 变更探测 / 开发绑定」折叠块本轮移除：
     三栏开发台是这一页唯一的正文（应用根目录 / ＋新建应用 在它自己那条工具栏里）。 */
}

/* ───────────────── 应用详情对话窗（单开一只浮层；不再内联进卡片） ─────────────────
 * 需求口径：应用的详情**单开一个 dialogue**，避免内容挤兑 —— 卡片列窄，版本表 / 详情行 /
 * 评论区塞进卡片里既挤又会被邻卡的展开挤歪，所以详情整体搬进一只可调宽高的浮层。
 * 形态：window.openAppsDetail(id)，宽身（apps-detail-box）+ 右下角手柄可拖调宽高；
 * persistent（点外部不关）+ ✕ / Esc 显式关（与 AGENTS.md 的弹窗纪律一致；最小化已整体下线）。
 * 内容（本轮版式）：左列图 + 右列（应用名 / 信息行 / 说明 / 分支 / 打赏 / 回滚 / 开发者信息▾）
 *   + 下方评论；底栏左边是下载·启动 / 二次开发 / 数据目录 / 卸载，右边是「关闭」。
 * 入口：点卡片（整卡可点）—— ⓘ 那一枚本轮已摘掉，库页与目录页共用同一个行为。
 * 注意：列表模式（类似 Steam）的右侧内嵌面板画的是**同一份内容**（见 renderer/app-apps-list.js
 *   与 appsDetailBodyEl 的注释），所以两边的块只会有一份实现，改一处两边同时生效。 */

const APPS_DETAIL = {
  id: "", /* 窗里讲的是哪个应用 */
  branchOwnerId: "", /* 同 id 多分支（§十）：窗里当前选中的那条分支（空 = 主干 / 跟着本机来源） */
  dom: Object.create(null),
  ver: null, /* apps:versions 的回执（本机台账：当前版 + 上一版） */
  verSeq: 0,
  tipsWarmId: "", /* 本窗已经为哪个应用补拉过打赏汇总（开窗时一次，见 appsDetailWarmTips） */
};

/* 当前窗框（#overlay 上那只） */
function appsDetailShellBox() {
  const ov = document.getElementById("overlay");
  return ov ? ov.querySelector(":scope > .overlay-box") : null;
}
/* 摘掉尺寸类（只摘当前窗上那一只，别的窗壳不受影响） */
function appsDetailBoxCleanup() {
  try {
    document
      .querySelectorAll("#overlay > .overlay-box.apps-detail-box, #overlay > .overlay-box.apps-verdlg-box")
      .forEach((b) => {
        b.classList.remove("apps-detail-box");
        b.classList.remove("apps-verdlg-box");
      });
  } catch (_) {}
  /* 跳窗给共享的 #ovFoot 挂的排布类也要摘（#ovFoot 与 .overlay-box 一样是全应用共用的一只节点，
     不摘就会让下一个弹窗的底栏也跟着横排 / 换行）。 */
  try {
    const f = document.getElementById("ovFoot");
    if (f) f.classList.remove("apps-verdlg-footwrap");
  } catch (_) {}
}
/* 关窗收尾：.overlay-box 是 **全应用共享** 的一只壳（见 AGENTS.md 与 app-publish.js 同一个坑），
   openOverlay / closeOverlay 只清内联样式、不摘未登记的类 —— 残留的宽身会让下一个弹窗
   （设置 / 插件 / 工坊…）继承近全屏尺寸，甚至顶到屏幕外关不掉。
   关窗路径不止 ✕：Esc、切画布、别的入口开新窗都会走 closeOverlay，所以这里不挂某一只按钮，
   而是盯 #overlay 的显隐：它一变成 display:none（只有 closeOverlay 会做这件事）就摘类并撤掉观察。 */
let APPS_DETAIL_OV_WATCH = null;
function appsDetailWatchOverlay() {
  appsDetailUnwatchOverlay();
  const ov = document.getElementById("overlay");
  if (!ov || typeof MutationObserver !== "function") return;
  APPS_DETAIL_OV_WATCH = new MutationObserver(() => {
    if (ov.style.display === "none") {
      appsDetailBoxCleanup();
      appsDetailUnwatchOverlay();
    }
  });
  APPS_DETAIL_OV_WATCH.observe(ov, { attributes: true, attributeFilter: ["style"] });
}
function appsDetailUnwatchOverlay() {
  if (!APPS_DETAIL_OV_WATCH) return;
  try {
    APPS_DETAIL_OV_WATCH.disconnect();
  } catch (_) {}
  APPS_DETAIL_OV_WATCH = null;
}
/* 右下角拖拽手柄：与上架窗同一套写法（改 .overlay-box 的内联宽高，关窗时随 cssText 清） */
function appsDetailResizeBind(handle) {
  handle.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const box = appsDetailShellBox();
    if (!box) return;
    const base = { w: box.offsetWidth, h: box.offsetHeight, x: ev.clientX, y: ev.clientY };
    const vw = Number(window.innerWidth) || 1200;
    const vh = Number(window.innerHeight) || 800;
    const minW = Math.max(360, Math.round(vw * 0.5)); /* 最小宽 ≥50%：版本表要摊得开 */
    const minH = 320;
    const onMove = (e) => {
      if (!APPS_DETAIL.dom.root || !document.contains(APPS_DETAIL.dom.root)) {
        onUp();
        return;
      }
      const w = Math.max(minW, Math.min(vw - 24, base.w + (e.clientX - base.x)));
      const h = Math.max(minH, Math.min(vh - 24, base.h + (e.clientY - base.y)));
      box.style.width = Math.round(w) + "px";
      box.style.height = Math.round(h) + "px";
      box.style.maxHeight = Math.round(h) + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "nwse-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/* 显式关闭（窗内「关闭」/ Esc / 切页 / 二次开发跳页） */
function closeAppsDetail() {
  APPS_DETAIL.id = "";
  APPS_DETAIL.branchOwnerId = "";
  APPS_DETAIL.ver = null;
  APPS_DETAIL.verSeq++;
  APPS_DETAIL.dom = Object.create(null);
  appsDetailUnwatchOverlay();
  appsDetailBoxCleanup();
  if (typeof closeOverlay === "function") closeOverlay();
}
/* 窗开着就只重画窗（保住滚动位置），回 true；窗关着回 false（调用方去重绘页面）。
   列表模式的右侧面板也算「详情开着」：它同样要跟着装 / 回滚 / 打赏汇总的结果刷新，
   否则用户在列表模式下会看到停在上一秒的右列。 */
function appsDetailRefresh() {
  const body = document.getElementById("ovBody");
  const root = APPS_DETAIL.dom.root;
  if (APPS_DETAIL.id && body && root && body.contains(root)) {
    appsDetailPaint();
    return true;
  }
  if (APPS_DETAIL.id) APPS_DETAIL.id = "";
  return appsPanelRepaint();
}
/* 列表模式的面板重画（由它自己那一格负责；没有面板回 false） */
function appsPanelRepaint() {
  try {
    const st = window.AppsList && AppsList.currentPanel ? AppsList.currentPanel() : null;
    if (st && typeof st.paint === "function") {
      st.paint();
      return true;
    }
  } catch (_) {}
  return false;
}

/* 目录条目（可能为空：本机自建、还没上架的应用在云端不存在）+ 本机那一份。
 * 家族口径（本轮）：详情讲的是**整个应用族**（同 id 的各作者分支 + 跨 id 但 forkOf 指回本族的旧条目），
 * 默认选中 = 原作者（主干）那条 —— 用户口径「永远默认原作者最新版」，与「本机装的是哪一支」无关。 */
function appsDetailBranchListOf(id) {
  const seed = appsSpecById(id) || appsLocalById(id) || { id: id };
  const fam = appsFamilyEntriesOf(seed);
  return fam.length ? fam : appsBranchesById(id, appsSpecPoolRaw());
}
function appsDetailBranchOf(id) {
  const list = appsDetailBranchListOf(id);
  const want = appsDetailSelKey();
  let hit = want
    ? list.find((b) => appsBranchKeyOfSpec(b) === want || String(b.ownerId || b.owner || "") === want)
    : null;
  if (!hit) hit = appsFamilyRootOf(list[0] || {}) || null;
  return hit || list[0] || null;
}
function appsDetailSpecOf(id) {
  const b = appsDetailBranchOf(id);
  if (b) return appsSpecWithMine(b) || b;
  return appsSpecWithMine(appsSpecById(id) || {}) || appsSpecById(id) || null;
}
function appsDetailLocalOf(id) {
  return appsLocalById(id) || null;
}
/* ── 详情的「当前绘制目标」（本轮新增） ──────────────────────────────────────
 * 详情窗之外，列表模式的右侧内嵌面板画的是**同一份内容**（本轮共识：面板 = 左图画廊 +
 * 右列 + 下方评论 + 底部按钮，同详情窗）。两者共用这一批绘制函数，靠这一个当前目标指针
 * 区分「选中哪条分支 / 台账在哪 / 回画哪一格」：
 *   · 窗里：app-apps.js 的 APPS_DETAIL（历史沿用，指针为空时一律回落到它）；
 *   · 面板：app-apps-list.js 的 panelEl 在自己的 paint 期间把指针挂成它那一格。
 * 指针只在**绘制期间**挂着（画完就还原），所以不会把窗的状态带脏。 */
function appsDetailCtx() {
  const c = window.APPS_DETAIL_CTX;
  return c && typeof c === "object" ? c : null;
}
function appsDetailCtxId(fallback) {
  const c = appsDetailCtx();
  return String((c && c.id) || fallback || (APPS_DETAIL && APPS_DETAIL.id) || "");
}
/** 选中分支的键（窗走 APPS_DETAIL，面板走它自己那一格） */
function appsDetailSelKey() {
  const c = appsDetailCtx();
  if (c) return String(c.branchOwnerId || (c.panel && c.panel.ownerId) || "");
  return String((APPS_DETAIL && APPS_DETAIL.branchOwnerId) || "");
}
/** 记下选中的分支（面板那边由它的 setBranch 收；窗那边照旧写 APPS_DETAIL） */
function appsDetailSetSelKey(key) {
  const c = appsDetailCtx();
  if (c) {
    if (typeof c.setBranch === "function") c.setBranch(key);
    return;
  }
  if (APPS_DETAIL) APPS_DETAIL.branchOwnerId = String(key || "");
}
/** 就地回画当前目标（窗 = 整窗重画；面板 = 只重画它那一格 / 回滚块） */
function appsDetailRepaintCtx() {
  const c = appsDetailCtx();
  if (c && typeof c.repaint === "function") {
    c.repaint();
    return;
  }
  appsDetailPaint();
}
function appsDetailTitleOf(id) {
  const spec = appsDetailSpecOf(id);
  const app = appsDetailLocalOf(id);
  return appsSpecTitle(spec) || String((app && app.name) || "") || id;
}

/* 窗壳：一只 #ovBody 里的 .apps-detail-root（右下角手柄挂在它里面 → 定位锚是窗框） */
function appsDetailBuildShell(body, foot) {
  body.innerHTML = "";
  foot.innerHTML = "";
  const root = document.createElement("div");
  root.className = "apps-detail-root";
  APPS_DETAIL.dom.root = root;

  /* 头部外面套一层 .apps-detail-top —— 它是**容器查询的容器**（container-type: inline-size）。
     容器查询只能被**后代**命中：把 container-type 挂在 .apps-detail-head 自己身上，
     「< 720px 时改成上下堆叠」那条规则永远匹配不到它本人（窄窗下量出来仍是 row）。
     套一层还顺带避开了 inline-size 容器的 layout containment 影响 —— 右下角手柄
     .apps-detail-resize 是绝对定位挂在 .overlay-box 上的，容器套在它外层会换掉它的包含块。 */
  const top = document.createElement("div");
  top.className = "apps-detail-top";
  root.appendChild(top);

  const head = document.createElement("div");
  head.className = "apps-detail-head";
  APPS_DETAIL.dom.head = head;
  top.appendChild(head);

  /* 头部右列（本轮版式：左列 = 图画廊，右列 = 信息 + 描述 + 分支 + 打赏 + 回滚 + 开发者信息）。
     它自己滚（.apps-detail-who-scroll 上了 overflow:auto）—— 左图始终看得见，右列再长也不跑掉。 */
  const right = document.createElement("div");
  right.className = "apps-detail-who apps-detail-who-scroll";
  APPS_DETAIL.dom.right = right;
  head.appendChild(right);

  /* 下方：只剩评论（本轮口径：tabs 移除，应用信息全在右列，评论独占下方滚动区）。 */
  const cmt = document.createElement("div");
  cmt.className = "apps-detail-cmt";
  APPS_DETAIL.dom.cmt = cmt;
  root.appendChild(cmt);

  const prog = document.createElement("div");
  prog.className = "apps-prog apps-detail-prog";
  prog.hidden = true;
  const bar = document.createElement("i");
  prog.appendChild(bar);
  const txt = document.createElement("div");
  txt.className = "apps-prog-txt";
  txt.hidden = true;
  root.appendChild(prog);
  root.appendChild(txt);
  APPS_DETAIL.dom.prog = prog;
  APPS_DETAIL.dom.progBar = bar;
  APPS_DETAIL.dom.progTxt = txt;

  const grip = document.createElement("div");
  grip.className = "apps-detail-resize";
  grip.setAttribute("aria-label", appsT("拖拽右下角调整窗口大小"));
  appsDetailResizeBind(grip);
  root.appendChild(grip);

  /* Esc = 窗内显式关闭路径（点外部照旧什么都不做） */
  root.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeAppsDetail();
    }
  });

  /* 壳建好了必须**挂进窗**：root 不 appendChild，body 就是空的 —— 详情窗整片空白，
     而且 appsDetailRefresh() 的 body.contains(root) 永远为假（窗再也刷不新），
     appsDetailLoadVersions() 还会在游离树上做替换。这一行不许省。 */
  body.appendChild(root);

  /* 底栏（本轮口径）：**左边** = 下载/启动 · 二次开发 · 数据目录 · 卸载（+ 回滚），
     **右边** = 关闭 —— 关窗按钮仍在右下角，操作类按钮统一排到左下角、同一行。 */
  const acts = document.createElement("div");
  acts.className = "apps-detail-footacts";
  APPS_DETAIL.dom.footActs = acts;
  foot.appendChild(acts);
  const closeBtn = appsMiniBtn(appsT("关闭"), closeAppsDetail);
  closeBtn.classList.add("apps-detail-close");
  foot.appendChild(closeBtn);
}

/* 详情窗头部（本轮需求重排：**左图 + 右信息**两栏；文字介绍另起一块排在它正下方，
 * 见 appsDetailDescEl）
 * 用户口径：
 *   · 头部**不再放 320px 小封面** —— 它与左列大图取的是同一张图（封面源就是上架截图第 1 张，
 *     见 appsCoverEl / appsShotsUrlsOf 的注释），留着会同一张图并排两遍；标题与全部信息进右列；
 *   · 左列 = 一张大图 + 正下方概览缩略图条：点缩略图切大图，点大图开全站图片灯箱看原图；
 *     一张截图都没有的条目（老目录常见）画占位（应用图标 + 一句话），不拿本机封面兜底；
 *   · 右列字段顺序 = 应用名 → 作者 → 更新时间 → 版本 → 大小 → 标签 → 二次开发来源，
 *     **缺哪个字段就不画哪一行**（未装的应用没有本机占用那一行，没有时间也不编造）；
 *   · 窄窗（内容宽 < 720px）改成上下堆叠 —— 见 css/apps.css 的 @container 段。
 * 其余技术字段（哈希 / 路径 / 文件数）仍在正文的「开发者信息 ▾」里，不受影响。 */
function appsDetailPaintHead() {
  const id = appsDetailCtxId() || APPS_DETAIL.id;
  const spec = appsDetailSpecOf(id);
  const app = appsDetailLocalOf(id);
  const head = APPS_DETAIL.dom.head;
  const right = APPS_DETAIL.dom.right;
  if (!head || !right) return;
  /* ★ 这里**不许**用 head.innerHTML = "" 清场：右列 `.apps-detail-who` 就是 head 的子节点，
     清空 head 会把它一起摘下来（right.parentNode 变成 null），之后 who / 说明 / 分支 /
     开发者信息全被 append 到**游离树**上 —— 界面表现就是用户报的「应用详情右侧信息全部丢失」
     （左图还在，因为左列媒体节点是每帧新建后重新 append 进 head 的）。
     正确做法：只摘上一帧的左列媒体节点，右列留在原地；右列自己只清内部内容。 */
  if (right.parentNode !== head) head.appendChild(right);
  for (const n of Array.from(head.children)) if (n !== right) n.remove();
  right.innerHTML = "";
  const name = appsDetailTitleOf(id);
  head.appendChild(appsDetailMediaEl(spec, app, name));
  /* 右列 = 应用名 + 信息行（appsDetailWhoEl 自带这两个）→ 说明 / 分支 / 打赏 / 编辑 /
     开发者信息（appsDetailBodyEl 的 head 路径，**与列表模式的面板是同一份实现**）→ 回滚槽。 */
  right.appendChild(appsDetailWhoEl(spec, app, name));
  const body = appsDetailBodyEl(spec, { app: app || undefined, noVers: true, head: true });
  if (body) right.appendChild(body);
  /* 本机版本回滚槽本轮**不再挂在这里**：本机当前 / 上一版回滚跟着版本一起搬进了
     「分支 / 版本」跳窗（用户口径：版本相关的内容都单独一只窗），右列不再留这条槽。 */
}

/* 右列一行（与正文那套 .apps-detail-row 同一份样式：窄标签 + 可换行的值） */
function appsDetailInfoRow(k, v, title) {
  const row = document.createElement("div");
  row.className = "apps-detail-row";
  const kk = document.createElement("span");
  kk.className = "apps-detail-k";
  kk.textContent = k;
  const vv = document.createElement("span");
  vv.className = "apps-detail-v";
  vv.textContent = String(v == null ? "" : v);
  if (title) vv.title = title;
  row.appendChild(kk);
  row.appendChild(vv);
  return row;
}

/* 目录里的时间戳归一（详情右列的「更新时间」用）：数字 / 数字串 / ISO 串都收，
   认不出来回 0 = 「没有这个值」（界面据此决定画不画那一行）。主进程已经归一过一遍
   （apps-store.js 的 normStamp），这里再兜一次是因为本机那份台账 / 老缓存可能直接给串。
   **2000-01-01 之前的值一律当没有**：目录里塞 0 / 1 / 2 这类占位值的条目（手写清单、
   夹具数据）真渲染出来就是「1970/1/1 08:00:00」这种假时间，宁可整行不画。 */
const APPS_STAMP_MIN = 946684800000;
function appsStampOf(v) {
  if (typeof v === "number") return isFinite(v) && v >= APPS_STAMP_MIN ? v : 0;
  const s = String(v == null ? "" : v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return isFinite(n) && n >= APPS_STAMP_MIN ? n : 0;
  }
  const t = Date.parse(s);
  return isFinite(t) && t >= APPS_STAMP_MIN ? t : 0;
}
/* 「更新时间」的取数链（用户口径：取云端条目的 updatedAt）：
 *   ① 条目 updatedAt（本轮起由 apps-store.js 的 normSpec 透传，服务端本来就下发）；
 *   ② 老静态目录没有这个字段 → 退**最新版本的上传时间**（versions[] 里最大的 createdAt）；
 *   ③ 都没有 → 0，右列整行不画（绝不编造时间、也不拿本机安装时间顶云端口径）。 */
function appsUpdatedAtOf(spec) {
  const direct = appsStampOf(spec && spec.updatedAt);
  if (direct) return direct;
  const vs = Array.isArray(spec && spec.versions) ? spec.versions : [];
  let best = 0;
  for (const v of vs) {
    const t = appsStampOf(v && v.createdAt);
    if (t > best) best = t;
  }
  return best;
}

/* 左列：大图 + 概览缩略图条；一张截图都没有时画占位。
 * 缩略图用**列表小图**（长边 1280 那一档，服务端懒生成）：图片放宽到 5MB 之后，
 * 打开详情不该先把 8 张 2560 原图全拉一遍 —— 大图只在切到某一张时才换 src。
 * 卡片封面用的也是这一组里的**第 1 张**（服务端 thumb 的封面源就是它，见 appsThumbUrlOf
 * 注释），所以这里换顺序 = 换封面，两处不打架。 */
function appsDetailMediaEl(spec, app, name) {
  const seed = spec || app || {};
  const media = document.createElement("div");
  media.className = "apps-detail-media";
  const shotUrls = appsShotsUrlsOf(seed);
  if (!shotUrls.length) {
    const ph = document.createElement("div");
    ph.className = "apps-detail-ph";
    ph.appendChild(appsIconEl(seed, name, "apps-detail-ph-ico"));
    const t = document.createElement("div");
    t.className = "apps-detail-ph-t";
    t.textContent = appsT("作者还没有上传截图");
    ph.appendChild(t);
    media.appendChild(ph);
    return media;
  }
  const shotThumbs = appsShotsUrlsOf(seed, { size: "list" });
  const gallery = document.createElement("div");
  gallery.className = "apps-gallery";
  const big = document.createElement("img");
  big.className = "apps-gallery-big img-previewable";
  big.loading = "lazy";
  big.alt = appsT("上架截图");
  big.title = appsT("点击查看大图");
  big.src = shotUrls[0];
  let cur = 0;
  /* 点大图 = 开全站图片灯箱看原图（滚轮缩放 / 1:1 / 适应窗口都在里面）；
     云端图是 http(s) 地址，灯箱本轮补了这条直通（renderer/app.js 的 openImageLightbox）。 */
  big.addEventListener("click", () => {
    if (typeof openImageLightbox !== "function") return;
    openImageLightbox(shotUrls[cur] || shotUrls[0], name + " · " + appsT("第 {n} 张", { n: cur + 1 }));
  });
  const strip = document.createElement("div");
  strip.className = "apps-gallery-strip";
  const pick = (k) => {
    cur = k;
    big.src = shotUrls[k];
    Array.prototype.forEach.call(strip.children, (el, idx) => {
      el.classList.toggle("on", idx === k);
    });
  };
  shotUrls.forEach((u, k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "apps-gallery-thumb" + (k === 0 ? " on" : "");
    b.title = appsT("第 {n} 张（点它看大图）", { n: k + 1 });
    const im = document.createElement("img");
    im.loading = "lazy";
    im.src = String(shotThumbs[k] || "") || u;
    im.alt = "";
    b.appendChild(im);
    b.onclick = (ev) => {
      ev.stopPropagation();
      pick(k);
    };
    strip.appendChild(b);
  });
  gallery.appendChild(big);
  gallery.appendChild(strip);
  media.appendChild(gallery);
  return media;
}

/* 右列：应用名 + 信息行（缺字段不画）。
 * 作者口径与卡片同一份 helper（原作者 = 家族根那条；当前选中分支是别人时补一句）。 */
function appsDetailWhoEl(spec, app, name) {
  const seed = spec || app || {};
  const who = document.createElement("div");
  who.className = "apps-detail-who";
  const h = document.createElement("div");
  h.className = "apps-detail-name";
  h.textContent = name;
  who.appendChild(h);
  const rows = document.createElement("div");
  rows.className = "apps-detail-info";
  /* 作者 */
  const fam = appsFamilyEntriesOf(seed);
  const root = appsFamilyRootOf(seed);
  const curAuthor = appsAuthorOf(seed) || appsT("未知作者");
  const rootAuthor = (root && appsAuthorOf(root)) || curAuthor;
  const authorText =
    appsT("原作者 ") + rootAuthor + (curAuthor && curAuthor !== rootAuthor ? appsT(" · 当前版本作者 ") + curAuthor : "");
  const authorTitle =
    fam.length > 1 ? appsT("这个应用共有 ") + fam.length + appsT(" 条分支（原作者在最左，其余向右逐级展开）") : "";
  rows.appendChild(appsDetailInfoRow(appsT("作者"), authorText, authorTitle));
  /* 更新时间（云端条目 updatedAt；兜底链见 appsUpdatedAtOf） */
  const at = appsUpdatedAtOf(seed);
  if (at) rows.appendChild(appsDetailInfoRow(appsT("更新时间"), appsTime(at)));
  /* 版本：云端最新版 · 本机已装版（未装 / 本机自建只画有的一半） */
  const cloudVer = String(seed.latestVersion || seed.version || "").trim();
  const localVer = app ? String(app.version || "").trim() : "";
  let verText = cloudVer ? appsT("云端 v") + cloudVer : "";
  if (localVer) verText += (verText ? appsT(" · 本机 v") : appsT("本机 v")) + localVer;
  if (verText) rows.appendChild(appsDetailInfoRow(appsT("版本"), verText));
  /* 大小与文件数：只对本机已装的那份有意义（用户口径：未装就不画这一行，
     不拿云端包体积顶） */
  if (app && (Number(app.bytes) || Number(app.files))) {
    rows.appendChild(
      appsDetailInfoRow(appsT("大小"), appsBytes(app.bytes) + " · " + Number(app.files || 0) + appsT(" 个文件")),
    );
  }
  /* 标签 */
  const tags = Array.isArray(seed.tags) && seed.tags.length ? seed.tags.join(" · ") : "";
  if (tags) rows.appendChild(appsDetailInfoRow(appsT("标签"), tags));
  /* 二次开发来源（有声明才显示）：写清「基于谁的那一版改的」——只显示作者名与源应用 id
     （作者名同「作者」行口径：显示名优先，占位名 / uid 不显示） */
  const fo = appsNormForkOf(seed.forkOf) || appsNormForkOf(seed.localForkOf);
  if (fo) {
    const foWho =
      String(fo.ownerName || "").trim() || (appsIsPlaceholderName(fo.owner) ? "" : String(fo.owner || "").trim());
    rows.appendChild(appsDetailInfoRow(appsT("二次开发自"), fo.id + (foWho ? "（" + foWho + "）" : "")));
  }
  who.appendChild(rows);
  return who;
}

/* 本机版本块（本机多版本，docs/apps-market.md §九）：
 *   载荷不落盘 —— 本机只有一份活动副本，能切换的只有「本机这一版」与「上一版」，
 *   上一版要点一次确认再**重新下载**（走 apps:rollback）。没有上一版就明说，不编造来源。 */
function appsDetailVerRow(v, cur) {
  const row = document.createElement("div");
  row.className = "apps-detail-ver" + (cur ? " is-cur" : "");
  const ver = document.createElement("span");
  ver.className = "apps-detail-ver-no";
  ver.textContent = "v" + String(v.version || "");
  row.appendChild(ver);
  const bits = [];
  if (v.uploadedAt) bits.push(appsTime(v.uploadedAt));
  if (v.bytes) bits.push(appsBytes(v.bytes));
  const meta = document.createElement("span");
  meta.className = "apps-detail-ver-meta";
  meta.textContent = bits.join(" · ");
  row.appendChild(meta);
  const tag = document.createElement("span");
  tag.className = "apps-detail-ver-tag";
  tag.textContent = cur ? appsT("本机当前") : appsT("上一版");
  row.appendChild(tag);
  if (!cur) {
    const go = appsMiniBtn(appsT("回到这一版"), () => appsSwitchVersion(APPS_DETAIL.id, String(v.version || "")));
    go.classList.add("apps-vers-dl");
    go.disabled = !!APPS_ST.busy[APPS_DETAIL.id];
    go.title = appsT("按台账里记的下载地址重新下载这一版并换成当前版本");
    row.appendChild(go);
  }
  return row;
}

/* 详情主体：已并入 appsDetailBodyEl（本轮版式：说明 / 分支 / 打赏 / 编辑 / 开发者信息都在
 * 右列，详情窗与列表模式的面板**共用同一份**）。这个函数只保留「本机自建（云端没有这一条）」
 * 的那条兜底路径 —— 那种条目只在卡片路径里出现，详情窗不再调用它。 */
function appsDetailBodyBox(id) {
  const spec = appsDetailSpecOf(id) || {};
  const app = appsDetailLocalOf(id);
  const box = document.createElement("div");
  box.className = "apps-detail apps-detail-in-dlg";

  if (spec.id) {
    const tree = appsBranchTreeEl(id, {
      branches: appsDetailBranchListOf(id),
      selectedOwnerId: APPS_DETAIL.branchOwnerId || String((appsDetailBranchOf(id) || {}).ownerId || ""),
      /* 详情才开交互：点分支 → 下方出现这一支的版本与下载 / 覆盖 / 启动 */
      withSel: true,
      debug: typeof window.__mtnodeAppsBranchDbg === "function" ? window.__mtnodeAppsBranchDbg : null,
    });
    if (tree) box.appendChild(tree);
  }

  if (spec.id) box.appendChild(appsDetailBodyEl(spec, { app: app || undefined, noVers: true, head: true }));
  else {
    /* 本机自建、云端没有这一条：详情就只有本机那一份（不编造云端字段）。
       说明已由 appsDetailDescEl 排在头部下方、版本 / 作者 / 大小在头部右列，
       这里只留「本机目录」这条别处没有的行（空则整块不画）。 */
    const rowsBox = document.createElement("div");
    rowsBox.className = "apps-detail-rows";
    const push = (k, val) => {
      if (val == null || val === "") return;
      const row = document.createElement("div");
      row.className = "apps-detail-row";
      const kk = document.createElement("span");
      kk.className = "apps-detail-k";
      kk.textContent = k;
      const vv = document.createElement("span");
      vv.className = "apps-detail-v";
      vv.textContent = String(val);
      vv.title = String(val);
      row.appendChild(kk);
      row.appendChild(vv);
      rowsBox.appendChild(row);
    };
    push(appsT("本机目录"), app && app.dir);
    if (rowsBox.children.length) box.appendChild(rowsBox);
  }
  /* 本机回滚入口：只在真能回滚时出现，且跟在选中分支的动作区后面（不再单开一块「本机版本」） */
  const roll = appsLocalRollbackEl(id);
  if (roll) box.appendChild(roll);
  return box;
}

/* ═════════ 「分支 / 版本」跳窗（本轮需求 4）+ 外面那一行动作条 ═════════
 *
 * 用户口径（本轮拷问确认）：
 *   · 版本相关的内容（分支树 / 这一支的版本列表 / 本机当前与上一版回滚）**单独一只跳窗**；
 *   · 窗里能切换分支：点分支行 = 选中它（高亮），下面列出这一支的版本；点版本行 = 选中那一版；
 *   · 窗内底部**一颗主按钮**才真的开始（「下载这一版」/「覆盖安装 vX」）—— 点行不会误触发下载；
 *   · 默认选中 = 原作者（家族根）+ 其最新版；
 *   · 关窗之后，外面（详情窗右列 / 列表模式右面板）显示**当前选择的作者与版本**，旁边一枚按情况
 *     变形的主按钮：没装 → 「下载这一版」；本机就是这一支这一版 → 「启动」；本机是同一支的别的
 *     版本 → 「更新到 vX」；本机装的是别的分支 → 「覆盖安装 vX」；再一颗「选择版本…」重新开窗。
 *   · 卡片上的「下载 / 其他版本」也直接落到这只窗（不再先开详情）。
 * 窗壳：复用 openOverlay（标题 + ✕ + Esc 显式关；**没有**「点外部即关」—— AGENTS.md 的弹窗纪律）。
 * 选择记忆：APPS_PICK 按应用 id 记在内存里（不落盘）—— 重进页面 / 换应用就回默认的原作者最新版。
 */
const APPS_PICK = Object.create(null); /* id → { key: 分支键（作者 uid）, ver: 版本号 } */
const APPS_VDLG = {
  id: "",
  key: "", /* 窗里当前选中的分支键（作者 uid） */
  ver: "", /* 窗里当前选中的版本号 */
  local: null, /* apps:versions 的回执（本机台账：当前版 + 上一版，本机回滚块要用） */
  dom: Object.create(null),
  seq: 0,
  from: "",
};

/** 默认分支 = 家族根（原作者那条）。家族表为空（云端没这条应用）回 null。 */
function appsPickDefaultBranchOf(id) {
  const list = appsDetailBranchListOf(String(id || ""));
  if (!list.length) return null;
  return appsFamilyRootOf(list[0]) || list[0];
}
/** 当前选择（分支 + 版本）：在跳窗里选过就用它（那一支 / 那一版已不在目录里就退回默认），
 *  否则 = 原作者 + 其最新版。外面的动作条与跳窗的默认选中都读这一份。 */
function appsPickOf(id) {
  const sid = String(id || "");
  const list = appsDetailBranchListOf(sid);
  if (!list.length) return { branch: null, key: "", ver: "", ownerId: "", label: "" };
  const p = APPS_PICK[sid] || null;
  let branch = p && p.key ? list.find((b) => appsBranchKeyOfSpec(b) === p.key) || null : null;
  if (!branch) branch = appsPickDefaultBranchOf(sid);
  const vers = appsVersionsOfBranch(branch);
  const onSame = !!(p && branch && p.key && appsBranchKeyOfSpec(branch) === p.key);
  let ver = String((onSame && p.ver) || "");
  if (!ver || (vers.length && !vers.some((v) => String((v && v.version) || "") === ver))) {
    ver = String(appsBranchVersionOf(branch) || "");
  }
  return {
    branch: branch,
    key: appsBranchKeyOfSpec(branch),
    ownerId: String((branch && branch.ownerId) || ""),
    ver: ver,
    label: appsBranchLabelOf(branch, list),
  };
}
/** 记下选择：只记「分支键 + 版本号」（分支条目本身会随目录刷新换对象，按 key 认才认得住）。 */
function appsPickSet(id, branch, ver) {
  const sid = String(id || "");
  if (!sid || !branch) return;
  APPS_PICK[sid] = {
    key: appsBranchKeyOfSpec(branch),
    ver: String(ver || appsBranchVersionOf(branch) || ""),
  };
}
/** 选中的这一支这一版该怎么动作（外面那行与跳窗底部**共用这一份判定**）：
 *    · 本机没装           → 下载这一版
 *    · 同一支同一版       → 启动
 *    · 同一支的别的版本   → 更新到 vX
 *    · 本机装的是别的分支 → 覆盖安装 vX
 *  文案与 mode 一起给：下载动作统一走 appsDownload(id, mode, ver, ownerId)。 */
function appsPickActionOf(id, pick) {
  const sid = String(id || "");
  const p = pick || appsPickOf(sid);
  const local = appsLocalById(sid);
  const ownerId = String(p.ownerId || "");
  const ver = String(p.ver || "");
  const busy = !!APPS_ST.busy[sid];
  const text = appsT("作者 ") + (p.label || appsT("未知作者")) + (ver ? " · v" + ver : "");
  const base = { text: text, ownerId: ownerId, ver: ver, branch: p.branch, mode: "" };
  if (!p.branch || !ver) {
    return Object.assign(base, { kind: "none", label: appsT("暂无可下载的版本"), disabled: true });
  }
  const localOwnerId = String((local && local.ownerId) || "").trim();
  const localVer = String((local && local.version) || "");
  const sameBranch = !!local && !!localOwnerId && localOwnerId === ownerId;
  if (!local) {
    return Object.assign(base, { kind: "install", label: busy ? appsT("下载中…") : appsT("下载这一版"), disabled: busy });
  }
  if (sameBranch && localVer === ver) {
    return Object.assign(base, { kind: "start", label: appsT("启动"), disabled: false });
  }
  if (sameBranch) {
    return Object.assign(base, {
      kind: "update",
      mode: "update",
      label: busy ? appsT("下载中…") : appsT("更新到 v") + ver,
      disabled: busy,
    });
  }
  return Object.assign(base, {
    kind: "overwrite",
    mode: "overwrite",
    label: busy ? appsT("下载中…") : appsT("覆盖安装 v") + ver,
    disabled: busy,
  });
}
/** 主按钮的点击出口（跳窗底部与外面那行动作条共用一条链） */
function appsPickRun(id, act) {
  const sid = String(id || "");
  if (!act || act.kind === "none" || act.disabled) return;
  if (act.kind === "start") {
    appsOpenApp(sid);
    return;
  }
  appsDownload(sid, act.mode || "", act.ver || "", act.ownerId || "");
}

/** 外面那行动作条（详情窗右列 / 列表面板头部，紧跟信息列的「版本」行）：
 *  一行「作者 X · vY」+ 一枚按情况变形的主按钮 + 「选择版本…」。 */
function appsPickBarEl(id) {
  const sid = String(id || "");
  const pick = appsPickOf(sid);
  if (!pick.branch) return null;
  const act = appsPickActionOf(sid, pick);
  const bar = document.createElement("div");
  bar.className = "apps-pickbar";
  const txt = document.createElement("div");
  txt.className = "apps-pickbar-t";
  txt.textContent = act.text;
  txt.title = act.text;
  bar.appendChild(txt);
  const go = appsMiniBtn(act.label, () => appsPickRun(sid, act), true);
  go.className += " apps-pickbar-go";
  go.disabled = !!act.disabled || act.kind === "none";
  go.title =
    act.kind === "start"
      ? appsT("在独立窗口里运行这个应用")
      : appsT("装这一版到本机（会替换本机现有的那一份载荷；storage / 数据文件夹 / 画布保留）");
  bar.appendChild(go);
  const more = appsMiniBtn(appsT("选择版本…"), () => openAppsVersionDlg(sid, { from: "detail" }));
  more.className += " apps-pickbar-more";
  more.title = appsT("打开「分支 / 版本」窗口：切作者分支、挑版本、本机回滚都在里面");
  bar.appendChild(more);
  return bar;
}

/** 跳窗里那一支的版本列表（**选中式**）：点行 = 选中（高亮），下载由窗底那颗主按钮开始。
 *  与 appsBranchTreeVerSelEl 的唯一差别就在这里 —— 那边每行自带一颗「下载这一版」。 */
function appsVersionPickListEl(id, branch, selVer, onPick) {
  const sid = String(id || "");
  const local = appsLocalById(sid);
  const localOwnerId = String((local && local.ownerId) || "").trim();
  const localVer = String((local && local.version) || "");
  const ownerId = String((branch && branch.ownerId) || "");
  const sameBranch = !!local && !!localOwnerId && localOwnerId === ownerId;
  const vs = appsVersionsOfBranch(branch);
  const latest = appsBranchVersionOf(branch);
  const box = document.createElement("div");
  box.className = "apps-br-vers apps-vers-pick";
  const head = document.createElement("div");
  head.className = "apps-vers-head";
  head.textContent =
    appsT("这一支的版本") + "（" + vs.length + appsT(" 个") + (latest ? appsT(" · 最新 v") + latest : "") + "）";
  box.appendChild(head);
  if (!vs.length) {
    const none = document.createElement("div");
    none.className = "apps-detail-vers-none";
    none.textContent = appsT("这一支还没有可下载的版本。");
    box.appendChild(none);
    return box;
  }
  for (const v of vs) {
    const ver = String((v && v.version) || "");
    const on = ver === String(selVer || "");
    const row = document.createElement("div");
    row.className = "apps-vers-row is-pick" + (ver === latest ? " is-cur" : "") + (on ? " is-sel" : "");
    row.dataset.ver = ver;
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", on ? "true" : "false");
    row.tabIndex = 0;
    const no = document.createElement("span");
    no.className = "apps-vers-ver";
    no.textContent = "v" + ver;
    row.appendChild(no);
    const bits = [];
    if (v.createdAt) bits.push(appsTime(v.createdAt));
    if (v.bytes) bits.push(appsBytes(v.bytes));
    const upWho = appsUploaderOf(v);
    if (upWho) bits.push(appsT("上传者 ") + upWho);
    if (bits.length) {
      const meta = document.createElement("span");
      meta.className = "apps-vers-meta";
      meta.textContent = bits.join(" · ");
      row.appendChild(meta);
    }
    if (v.note) {
      const nt = document.createElement("span");
      nt.className = "apps-vers-note";
      nt.textContent = String(v.note);
      nt.title = String(v.note);
      row.appendChild(nt);
    }
    if (sameBranch && localVer === ver) {
      const tag = document.createElement("span");
      tag.className = "apps-badge apps-badge-on";
      tag.textContent = appsT("本机当前");
      row.appendChild(tag);
    }
    const tick = document.createElement("span");
    tick.className = "apps-vers-tick";
    tick.textContent = on ? appsT("已选") : "";
    row.appendChild(tick);
    const pick = () => {
      if (typeof onPick === "function") onPick(ver);
    };
    row.addEventListener("click", pick);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        pick();
      }
    });
    box.appendChild(row);
  }
  return box;
}

/** 跳窗里换了分支：选中它（版本回这一支的最新版）→ 记进 APPS_PICK → 重画窗与外面的动作条 */
function appsVdlgSelectBranch(b) {
  const sid = APPS_VDLG.id;
  if (!sid || !b) return;
  APPS_VDLG.key = appsBranchKeyOfSpec(b);
  APPS_VDLG.ver = String(appsBranchVersionOf(b) || "");
  appsPickSet(sid, b, APPS_VDLG.ver);
  /* 详情正文也切到这一支（说明 / 作者行跟着变），并刷新外面的动作条 */
  APPS_DETAIL.branchOwnerId = String(b.ownerId || "");
  appsVdlgPaint();
  appsDetailRefresh();
}
/** 跳窗里换了版本：只换版本（分支不动） */
function appsVdlgSelectVer(ver) {
  const sid = APPS_VDLG.id;
  if (!sid) return;
  const list = appsDetailBranchListOf(sid);
  const branch = list.find((b) => appsBranchKeyOfSpec(b) === APPS_VDLG.key) || null;
  if (!branch) return;
  APPS_VDLG.ver = String(ver || "");
  appsPickSet(sid, branch, APPS_VDLG.ver);
  appsVdlgPaint();
  appsDetailRefresh();
}

/** 窗壳：一条纵向滚动区，里面自上而下 = 分支树 → 这一支的版本（选中式）→ 本机回滚 */
function appsVdlgBuild(body, foot) {
  body.innerHTML = "";
  foot.innerHTML = "";
  const root = document.createElement("div");
  root.className = "apps-verdlg";
  const scroll = document.createElement("div");
  scroll.className = "apps-verdlg-scroll";
  const branchBox = document.createElement("div");
  branchBox.className = "apps-verdlg-branch";
  const versBox = document.createElement("div");
  versBox.className = "apps-verdlg-vers";
  const rollBox = document.createElement("div");
  rollBox.className = "apps-verdlg-roll";
  scroll.appendChild(branchBox);
  scroll.appendChild(versBox);
  scroll.appendChild(rollBox);
  root.appendChild(scroll);
  body.appendChild(root);
  /* #ovFoot 默认是块级：主按钮那一列与「关闭」会各占一行。给它挂上横排类（关窗时由
     appsDetailBoxCleanup 摘掉，见那里的注释）。 */
  if (foot.classList) foot.classList.add("apps-verdlg-footwrap");
  APPS_VDLG.dom = { root: root, branch: branchBox, vers: versBox, roll: rollBox, foot: foot };
}

/** 底栏：左 = 主按钮 + 本机状态说明，右 = 「关闭」 */
function appsVdlgPaintFoot(branch, selVer) {
  const dom = APPS_VDLG.dom;
  if (!dom.foot) return;
  const sid = APPS_VDLG.id;
  dom.foot.innerHTML = "";
  const left = document.createElement("div");
  left.className = "apps-verdlg-foot";
  const list = appsDetailBranchListOf(sid);
  const act = appsPickActionOf(sid, {
    branch: branch,
    ownerId: String((branch && branch.ownerId) || ""),
    ver: String(selVer || ""),
    label: appsBranchLabelOf(branch, list),
  });
  const go = appsMiniBtn(act.label, () => {
    if (act.kind === "none" || act.disabled) return;
    /* 启动先把窗关掉（免得窗压着刚起来的应用）；下载 / 覆盖交回外面同一条链 */
    if (act.kind === "start") closeAppsVersionDlg();
    appsPickRun(sid, act);
  }, true);
  go.className += " apps-verdlg-go";
  go.disabled = !!act.disabled || act.kind === "none";
  left.appendChild(go);
  const note = document.createElement("div");
  note.className = "apps-verdlg-note";
  const local = appsLocalById(sid);
  const localWho = appsInstalledAuthorOf(branch, local) || appsT("未知作者");
  note.textContent = local
    ? appsT("本机已装：") +
      localWho +
      " · v" +
      String(local.version || "") +
      (String(local.ownerId || "") === String((branch && branch.ownerId) || "")
        ? ""
        : appsT("（换到别的分支会覆盖本机的应用文件；storage / 数据文件夹 / 画布保留）"))
    : appsT("本机还没装这个应用。");
  left.appendChild(note);
  dom.foot.appendChild(left);
  const closeBtn = appsMiniBtn(appsT("关闭"), closeAppsVersionDlg);
  closeBtn.className += " apps-verdlg-close";
  dom.foot.appendChild(closeBtn);
}

function appsVdlgPaint() {
  const sid = APPS_VDLG.id;
  const dom = APPS_VDLG.dom;
  if (!sid || !dom.branch || !dom.vers) return;
  const list = appsDetailBranchListOf(sid);
  const fallback = appsPickOf(sid);
  if (!APPS_VDLG.key) APPS_VDLG.key = fallback.key;
  const branch = list.find((b) => appsBranchKeyOfSpec(b) === APPS_VDLG.key) || fallback.branch || null;
  if (!branch) return;
  APPS_VDLG.key = appsBranchKeyOfSpec(branch);
  /* 版本号必须落在这一支里：换过分支之后旧的版本号一律作废，回这一支的最新版 */
  const vs = appsVersionsOfBranch(branch);
  if (!vs.some((v) => String((v && v.version) || "") === String(APPS_VDLG.ver || ""))) {
    APPS_VDLG.ver = String(appsBranchVersionOf(branch) || "");
  }
  const selVer = APPS_VDLG.ver;
  /* 绘制期间把「当前目标」指向这只窗：appsLocalRollbackEl / appsDetailCtxId 都读它
     （与列表模式的面板同一套做法，见 APPS_DETAIL_CTX 的注释）。 */
  const prev = window.APPS_DETAIL_CTX || null;
  window.APPS_DETAIL_CTX = {
    id: sid,
    ver: APPS_VDLG.local,
    setBranch: (k) => {
      APPS_VDLG.key = String(k || "");
    },
    repaint: () => appsVdlgPaint(),
  };
  try {
    dom.branch.innerHTML = "";
    const tree = appsBranchTreeEl(sid, {
      branches: list,
      /* 口径注意：appsBranchTreeEl 的 selectedOwnerId 吃的是**原始 ownerId / 账号名**
         （它内部按原值比较，不走 appsBranchKeyOfSpec），而 APPS_VDLG.key 是 "u:<uid>" 形态的
         稳定键 —— 这里必须换算回去，否则分支行的高亮永远停在主干那一条。 */
      selectedOwnerId: String((branch && (branch.ownerId || branch.owner)) || ""),
      withSel: true,
      noVers: true,
      onSelect: (b) => appsVdlgSelectBranch(b),
      debug: typeof window.__mtnodeAppsBranchDbg === "function" ? window.__mtnodeAppsBranchDbg : null,
    });
    if (tree) dom.branch.appendChild(tree);
    dom.vers.innerHTML = "";
    dom.vers.appendChild(appsVersionPickListEl(sid, branch, selVer, (ver) => appsVdlgSelectVer(ver)));
    dom.roll.innerHTML = "";
    const roll = appsLocalRollbackEl(sid);
    if (roll) dom.roll.appendChild(roll);
  } finally {
    window.APPS_DETAIL_CTX = prev || null;
  }
  appsVdlgPaintFoot(branch, selVer);
}

/** 本机台账（apps:versions）：本机当前 / 上一版回滚那一块要用 —— 窗先画出来，台账回来补那一块 */
async function appsVdlgLoadVersions(seq) {
  const sid = APPS_VDLG.id;
  const api = window.api || {};
  if (!sid || typeof api.appsVersions !== "function") return;
  let r = null;
  try {
    r = await api.appsVersions(sid);
  } catch (_) {
    return;
  }
  if (APPS_VDLG.id !== sid || APPS_VDLG.seq !== seq) return;
  APPS_VDLG.local = r && r.ok !== false ? r : null;
  appsVdlgPaint();
}

/** 打开「分支 / 版本」跳窗（卡片「下载 / 其他版本」与详情里那颗「选择版本…」都走它）。 */
function openAppsVersionDlg(id, opts) {
  const o = opts || {};
  const sid = String(id || "");
  if (!sid) return false;
  if (typeof openOverlay !== "function") {
    appsToast(appsT("窗口模块未就绪（openOverlay 不存在）"), "err");
    return false;
  }
  const want = appsPickOf(sid);
  if (!want.branch) {
    /* 云端没有这条应用的分支信息（本机自建 / 目录还没拉到）：开一只空窗没有意义，如实说一句 */
    appsToast(appsT("云端目录里没有这个应用的分支信息，暂时没有可选版本"), "warn");
    return false;
  }
  APPS_VDLG.id = sid;
  APPS_VDLG.key = String(o.key || want.key || "");
  APPS_VDLG.ver = String(o.ver || want.ver || "");
  APPS_VDLG.local = null;
  APPS_VDLG.seq++;
  APPS_VDLG.from = String(o.from || "");
  openOverlay(appsT("选择版本") + " · " + appsDetailTitleOf(sid), { persistent: true });
  appsDetailBoxCleanup();
  const box = appsDetailShellBox();
  if (box) box.classList.add("apps-verdlg-box");
  appsDetailWatchOverlay();
  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) {
    closeAppsVersionDlg();
    return false;
  }
  appsVdlgBuild(body, foot);
  appsVdlgPaint();
  appsVdlgLoadVersions(APPS_VDLG.seq);
  return true;
}
/** 关窗（✕ / Esc / 窗内「关闭」/ 启动前那一关）：状态与尺寸类都收干净 */
function closeAppsVersionDlg() {
  APPS_VDLG.id = "";
  APPS_VDLG.key = "";
  APPS_VDLG.ver = "";
  APPS_VDLG.local = null;
  APPS_VDLG.seq++;
  APPS_VDLG.dom = Object.create(null);
  appsDetailUnwatchOverlay();
  appsDetailBoxCleanup();
  if (typeof closeOverlay === "function") closeOverlay();
}

/* 本机回滚（原「本机版本（可回滚）」块的入口形态）：只留一句说明 + 一颗按钮，
 * 没有可回滚的上一版时**整块不出现**（不编造来源）。
 * 台账（apps:versions）有两份来源：详情窗读 APPS_DETAIL.ver，列表模式的面板读它自己那一格
 * （绘制期间挂在 APPS_DETAIL_CTX 上，见 appsDetailCtx）。*/
function appsLocalRollbackEl(id) {
  const ctx = appsDetailCtx();
  const v = ctx && "ver" in ctx ? ctx.ver : APPS_DETAIL.ver;
  if (!v || !v.installed) return null;
  const rows = Array.isArray(v.versions) ? v.versions : [];
  const prev = rows.find((r) => !r.current) || null;
  if (!prev || !v.canRollback) return null;
  const box = document.createElement("div");
  box.className = "apps-detail-vers";
  const head = document.createElement("div");
  head.className = "apps-vers-head";
  head.textContent = appsT("本机版本");
  box.appendChild(head);
  box.appendChild(appsDetailVerRow(prev, false));
  const note = document.createElement("div");
  note.className = "apps-detail-vers-none";
  note.textContent = appsT("本机只留当前与上一版两份记录（不存历史包）：回到上一版要按来源重新下载一次，离线或云端已删除时会如实报错。");
  box.appendChild(note);
  return box;
}
/* 文字介绍块（本轮需求：排在头部正下方通栏，Markdown 渲染）：
 *   · 空描述**整块不画**（用户口径 —— 不再显示「（这个应用还没写描述）」占位）；
 *   · 渲染走全站唯一入口 renderMarkdown（renderer/app.js：先转义再 marked 解析、拦掉
 *     非 http 链接、公式同源），容器带 .md 类 —— 全站链接点击（app.js 的
 *     bindOpenableContentClicks）靠 .md 认领：http 外链交给系统浏览器、file: 走应用内预览；
 *   · **CSP 不动**（用户口径）：描述里非 mt-agent.com 域的外链图显示不出来，这是刻意保留的边界。 */
function appsDetailDescEl(spec, app) {
  const md = String(appsSpecDesc(spec || app || {}) || "").trim();
  if (!md) return null;
  const box = document.createElement("div");
  box.className = "apps-detail-desc";
  const inner = document.createElement("div");
  inner.className = "apps-detail-md md";
  if (typeof renderMarkdown === "function") inner.innerHTML = renderMarkdown(md);
  else inner.textContent = md;
  box.appendChild(inner);
  return box;
}

function appsDetailPaint() {
  const id = APPS_DETAIL.id;
  if (!id) return;
  appsDetailPaintHead();
  const lower = APPS_DETAIL.dom.cmt;
  const spec = appsDetailSpecOf(id);
  /* 下方 = 评论（本轮口径：tabs 移除，评论独占下方滚动区）；
     有选中分支时的版本 / 下载动作与回滚块都在**右列**（见 appsDetailRightColEl 与下面的
     appsDetailRollSlotEl），这里不再重复第二份。 */
  if (lower) {
    lower.innerHTML = "";
    const cloud = spec ? appsCloudTarget(spec) : null;
    if (cloud) {
      const mount = () => {
        if (!window.MtComments) return;
        try {
          window.MtComments.mount(lower, cloud, { title: appsDetailTitleOf(id) });
        } catch (_) {}
      };
      /* 评论走网络：先画个壳再说一句实话，回来再挂（失败也不把窗卡住） */
      const wait = document.createElement("div");
      wait.className = "apps-empty";
      wait.textContent = appsT("正在读取评论…");
      lower.appendChild(wait);
      mount();
    }
  }
  /* 回滚块：台账（apps:versions）回来才画 —— 先摆好槽位，回来就地替换（保住右列滚动位置） */
  const footActs = APPS_DETAIL.dom.footActs;
  if (footActs) appsDetailFootActsPaint(id, footActs);
  appsDetailPaintProg();
}

/* 底栏左下角那一串操作按钮（本轮口径：下载 / 启动 · 二次开发 · 数据目录 · 卸载（+ 回滚），
   与右下角的「关闭」同一行）。只在本机装了这份时出现 —— 没装时底栏只有「关闭」，
   下载入口在右列的选中分支动作区里（那里才是「装哪一支哪一版」的地方）。 */
function appsDetailFootActsPaint(id, host) {
  host.innerHTML = "";
  const sid = String(id || "");
  const local = appsLocalById(sid);
  if (!local) return;
  host.appendChild(
    appsMiniBtn(local.dev === true ? appsT("打开") : appsT("启动"), () => appsOpenApp(sid), true),
  );
  const dirBtn = appsMiniBtn("📂 " + appsT("数据目录"), () => appsDataOpenNow(sid));
  dirBtn.title = appsT("打开这个应用的数据目录（默认在 MTNode 数据目录下按应用 id 建）");
  host.appendChild(dirBtn);
  host.appendChild(appsSecondaryDevBtnEl(local || { id: sid }));
  const isDevApp = !!(local.dev === true || local.kind === "dev");
  const un = appsMiniBtn(
    appsT(isDevApp ? "移除登记" : "卸载"),
    () => appsUninstallApp(local || { id: sid }),
  );
  if (!isDevApp) un.classList.add("danger");
  un.title = isDevApp
    ? appsT("只移除登记：项目文件夹与里面的文件一个都不会删（要删文件请自己在资源管理器里删）")
    : appsT("卸载只删它在下载根下的子文件夹与它自己那一棵数据，项目根与开发数据一概不动");
  host.appendChild(un);
}
/* 进度（装 / 回滚都在窗里可见）：与卡片共用 APPS_ST.progress 那一份状态 */
function appsDetailPaintProg() {
  const id = APPS_DETAIL.id;
  const dom = APPS_DETAIL.dom;
  if (!dom.prog) return;
  const p = APPS_ST.progress[id];
  if (!p) {
    dom.prog.hidden = true;
    dom.progTxt.hidden = true;
    dom.progBar.style.width = "0%";
    dom.progTxt.textContent = "";
    return;
  }
  const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
  dom.prog.hidden = false;
  dom.progTxt.hidden = false;
  dom.progBar.style.width = (p.phase === "error" ? 100 : pct) + "%";
  dom.prog.classList.toggle("err", p.phase === "error");
  dom.progTxt.textContent = appsProgressText(p);
}

/* 本机台账读取（apps:versions）：窗先画出来，台账回来再把「本机版本（可回滚）」那块补上。
 * 本轮它**跟在选中分支的动作区后面**（没有可回滚的上一版时整块不出现）。 */
async function appsDetailLoadVersions(seq) {
  const id = APPS_DETAIL.id;
  const api = window.api || {};
  if (!id || typeof api.appsVersions !== "function") return;
  let r = null;
  try {
    r = await api.appsVersions(id);
  } catch (_) {
    r = null;
  }
  if (seq !== APPS_DETAIL.verSeq || id !== APPS_DETAIL.id) return;
  APPS_DETAIL.ver = r && r.ok !== false ? r : null;
  const right = APPS_DETAIL.dom.right;
  if (!right) return;
  const old = right.querySelector(".apps-detail-rollslot");
  const fresh = appsLocalRollbackEl(id);
  if (old && old.parentNode && fresh) old.parentNode.replaceChild(fresh, old);
  else if (old && old.parentNode) old.parentNode.removeChild(old);
  else if (fresh) right.appendChild(fresh);
  appsDetailPaintProg();
}

/* 版本切换（本机多版本）：目标就是本机这一版 → 只提示；否则按台账**重新下载**那一版。
   本机带「开发中」标记时先确认一次（与「更新」同一套口径：整目录替换应用文件，
   storage/ 与该应用自己的画布不动）。失败一律如实报错、不静默降级。 */
async function appsSwitchVersion(id, version) {
  const sid = String(id || "");
  const want = String(version || "").trim();
  const api = window.api || {};
  if (!sid || !want) return;
  if (APPS_ST.busy[sid]) return;
  const cur =
    (APPS_DETAIL.id === sid && APPS_DETAIL.ver && APPS_DETAIL.ver.version) ||
    String((appsLocalById(sid) || {}).version || "");
  if (cur && cur === want) {
    appsToast(appsT("本机已经是这一版：v") + want, "warn");
    return;
  }
  const app = appsLocalById(sid) || {};
  if (app.dev === true) {
    const body =
      appsDetailTitleOf(sid) +
      appsT(
        " 正在开发中（本机这一份带「开发中」标记）。切换版本会按台账来源重新下载那一版，并用它整目录替换本机这一份（app.json / 入口页 / assets 与脚本、样式都在内）—— 你在这些文件上的改动会丢；本机存储与该应用自己的画布不动。确定切换到 v",
      ) +
      want +
      appsT(" 吗？");
    let ok = true;
    if (typeof confirmDialog === "function") {
      ok = await confirmDialog(body, {
        title: appsT("切换正在开发的应用的版本"),
        okText: appsT("切换并重新下载"),
      });
    }
    if (!ok) return;
  }
  if (typeof api.appsRollback !== "function") {
    appsBridgeMissing();
    return;
  }
  APPS_ST.busy[sid] = true;
  APPS_ST.progress[sid] = { id: sid, phase: "start", percent: 0, version: want };
  appsPaintCardState(sid);
  appsDetailPaintProg();
  let r = null;
  try {
    r = await api.appsRollback(sid, want);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  APPS_ST.busy[sid] = false;
  delete APPS_ST.progress[sid];
  if (r && r.ok) {
    appsToast(appsT("已切回 v") + String(r.version || want), "ok");
    APPS_ST.list = null;
    await appsListLoad(true);
    appsDetailRefresh();
    return;
  }
  appsToast(appsT("切换失败：") + appsErrText(r), "err");
  appsPaintCardState(sid);
  appsDetailRefresh();
}

/* 入口：window.openAppsDetail(id)。同一只窗已开着同一个应用 → 再点只把它抬起来（不重建）。 */
function openAppsDetail(id) {
  const sid = String(id || "");
  if (!sid) return false;
  if (typeof openOverlay !== "function") {
    appsToast(appsT("窗口模块未就绪（openOverlay 不存在）"), "err");
    return false;
  }
  const title = appsT("应用详情") + " · " + appsDetailTitleOf(sid);
  const ovNow = document.getElementById("overlay");
  if (APPS_DETAIL.id === sid && APPS_DETAIL.dom.root && document.contains(APPS_DETAIL.dom.root)) {
    if (ovNow && ovNow.style.display === "flex") return true;
  } else if (APPS_DETAIL.id) {
    /* 换一个应用：先把上一只详情窗收干净（它可能正停在状态栏页签里）——
       全应用只允许一只详情窗，免得留下点不开的页签 */
    closeAppsDetail();
  }
  APPS_DETAIL.id = sid;
  /* 详情正文跟着**当前选择**那一支走（在跳窗里切过分支就显示那一支的说明 / 作者）；
     没选过时 appsPickOf 回原作者 —— 与「永远默认原作者最新版」的口径一致。 */
  APPS_DETAIL.branchOwnerId = appsPickOf(sid).key || "";
  APPS_DETAIL.ver = null;
  APPS_DETAIL.verSeq++;
  APPS_DETAIL.tipsWarmId = ""; /* 换了应用：打赏汇总的重问标记一并作废（见 appsDetailWarmTips） */
  openOverlay(title, { persistent: true, min: true });
  /* 尺寸类：先摘残留，再挂自己的（宽身 + 最小宽 50vw，见 css/apps.css） */
  appsDetailBoxCleanup();
  const box = appsDetailShellBox();
  if (box) box.classList.add("apps-detail-box");
  appsDetailWatchOverlay();

  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) {
    closeAppsDetail();
    return false;
  }
  appsDetailBuildShell(body, foot);
  appsDetailPaint();
  appsDetailLoadVersions(APPS_DETAIL.verSeq);
  appsDetailWarmTips(sid);
  return true;
}

/**
 * 详情窗自己补拉一次这个应用的打赏汇总（需求口径：开窗顺手拉一次，跳过新鲜期）。
 * 为什么不能只靠应用页载入时那一问：详情窗可以**不经应用页**直接打开（消息里的打赏通知、
 * 搜索、外部调用 openAppsDetail），那时缓存可能还是空的 / 上一批 id 的 —— 界面就会先闪
 * 一下「还没有人打赏」。失败保留旧值（appsTipsLoad 只标记 tipsFailed），取到就重绘这一窗。
 * 这里**不**调 appsTipsEnsure：那只函数带着「重绘整页」的副作用，详情窗只要自己的那一格。
 */
function appsDetailWarmTips(id) {
  const sid = String(id || "");
  if (!sid) return;
  /* 一只窗里同一个应用只补拉一次（失败也不反复重问：重绘由别的路径触发时不会互相推着转圈）。 */
  if (APPS_DETAIL.tipsWarmId === sid) return;
  APPS_DETAIL.tipsWarmId = sid;
  const seq = APPS_DETAIL.verSeq;
  appsTipsLoad([sid], true)
    .then(() => {
      /* 窗已关 / 已换成别的应用：不再回写（与 appsDetailLoadVersions 同一口径） */
      if (APPS_DETAIL.id !== sid || APPS_DETAIL.verSeq !== seq) return;
      appsDetailRefresh();
    })
    .catch(() => {});
}

/* ═════════════ 「我的应用」（第 4 页）：我上架到云端的条目 —— 编辑 · 删除 ═════════════
 *
 * 数据源：GET /api/apps?owner=<登录账号 uid>&page=N&pageSize=50
 *   —— 服务端里「应用 = 应用 id + 作者 uid」各占一条，这个过滤回的就是**我自己那一条分支**
 *   （别人 fork 后上架的条目 owner 不是我，不在这一页，我也删不到它们）。
 *   owner 一律发 uid（拿不到才退账号名）：账号名 / 昵称可改，只有 uid 是身份。
 * 能力：搜索（本地过滤已拉回的条目）/ 分页「加载更多」/
 *   卡片上的编辑入口（删除在编辑窗底栏）。**不做**批量操作（逐个应用点，误删代价小）。
 *   工具条上只有「刷新」一颗，没有我的应用时只显示一句「无应用」。
 *
 * 编辑：标题 / 描述 / 标签 / 图标 / 上架截图（可增删单张 + 拖拽排序）→
 *   PATCH /api/apps/<id>?owner=<我>（服务端强制 acceptDeclaration，所以保存前必须勾声明）。
 *   截图整批提交：新图直接给 data URL，**保留的云端老图用 {keep:n} 指代**（n = 保存前那一套里的
 *   下标）—— 渲染层手里没有老图字节，只有这个指代能让「删一张 + 排个序」不必重传 8 张图。
 *   保存后拿回执里的 item.shots 校验收到的张数：老服务端不认识 shotsBase64 会静默忽略，
 *   那种情况必须明说「云端服务端需升级后生效」，绝不假装改成功了。
 *   保存成功后把标题 / 描述 / 标签同步写回**本机所有同 id 副本**（下载根 + 项目根，见
 *   apps-store.js 的 apps:syncCloudMeta）；图标不写本机文件（库页封面取的就是云端条目）。
 *
 * 删除：DELETE /api/apps/<id>?owner=<我> —— 只删我这一条分支（记录 / 包 / 图标 / 截图一起下掉，
 *   不可恢复），别人的分支与包一律不动（服务端这条路由本来就是这个口径）。确认框要求
 *   **手动输入应用标题**，并写明「另有 N 位作者的派生分支会保留」与「本机副本不会被删除」。
 * 两个对话框都是 persistent（点外部不关，见 AGENTS.md）：出口只有窗内按钮、✕、Esc。
 */

const APPS_MINE_PAGE_SIZE = 50;
const APPS_EDIT_MAX_SHOTS = 8;
const APPS_EDIT_IMG_TYPES = ["image/png", "image/jpeg", "image/webp"];
const APPS_EDIT_ICON_MAX = 500 * 1024; /* 与服务端 icons 口径 MAX_PREVIEW 对齐 */
const APPS_EDIT_TITLE_MAX = 80; /* 服务端 title slice(0,80) */
const APPS_EDIT_DESC_MAX = 2000; /* 服务端 description slice(0,2000) */
const APPS_EDIT_TAGS_MAX = 8; /* 服务端 parseTags 只收前 8 个 */
/* 声明正文：与上架窗（renderer/app-publish.js 的 PUB_DECLARATION）**逐字同一句** ——
   服务端 PATCH / POST 都要求 acceptDeclaration === true，两处文案不一致会让用户以为换了要求。 */
const APPS_EDIT_DECLARATION =
  "本人保证该应用符合中华人民共和国法律法规，不含违法有害内容，不侵犯他人知识产权；因该应用产生的全部责任由上传者承担。";

/* ── 取数：分页拉「我上架的条目」 ───────────────────────────────────────── */

/** 「我的应用」查云端条目时用的 owner 值：**登录账号 uid 优先**，拿不到 uid 才退回账号名。
 *  单一口径（appsMineFetchPage / appsMinePageLoad 共用），免得两处各写一遍、
 *  一处改成 uid 而另一处还发账号名。 */
function appsMineOwnerKey() {
  const u = appsAuthUser() || {};
  return String(u.id || "").trim() || String(u.username || "").trim();
}

/** 拉一页（page 从 1 起）。失败回 null（调用方保留旧列表，不空屏）。
 *  owner 过滤一律用**登录账号 uid**：uid 才是身份，账号名 / 昵称随时可改（服务端这条接口
 *  两个都认，见 store-saas/server.mjs 的 /api/apps）。以前只发账号名 —— 改过一次用户名
 *  或老条目里存着占位账号名（u_xxxxxxxx）时，这一页会一条都拉不到、显示成「没有应用」。
 *  拿不到 uid（老登录态快照）才退回账号名，绝不因此把这一页拉空。 */
async function appsMineFetchPage(page) {
  const api = window.api || {};
  const me = appsMineOwnerKey();
  if (!me || typeof api.storeRequest !== "function") return null;
  let r = null;
  try {
    r = await api.storeRequest({
      method: "GET",
      path:
        "/api/apps?owner=" +
        encodeURIComponent(me) +
        "&page=" +
        encodeURIComponent(String(page)) +
        "&pageSize=" +
        APPS_MINE_PAGE_SIZE,
    });
  } catch (_) {
    r = null;
  }
  const d = r && r.ok !== false ? r.data : null;
  const items = d && Array.isArray(d.items) ? d.items : null;
  if (!items) return null;
  return {
    items: items,
    total: Number(d.total) || items.length,
    page: Number(d.page) || page,
    pageSize: Number(d.pageSize) || APPS_MINE_PAGE_SIZE,
  };
}

/** byId 归并表（appsMineOf / 应用页卡片的 mine 标记都读它）从当前分页条目现算。 */
function appsMineRebuildById() {
  const items = (APPS_ST.minePage && APPS_ST.minePage.items) || [];
  const byId = Object.create(null);
  for (const it of items) if (it && it.id) byId[String(it.id)] = it;
  const at = (APPS_ST.minePage && APPS_ST.minePage.at) || Date.now();
  APPS_ST.mine = { ok: true, at: at, byId: byId };
  APPS_ST.mineAt = at;
}

/**
 * 第 1 页（force = 跳过新鲜期）。刷新时**按已加载的页数重拉**，别把用户「加载更多」翻出来的
 * 那些页吃掉（否则每 5 分钟一次重绘都会把列表缩回 50 条）。
 */
async function appsMinePageLoad(force) {
  const cur = APPS_ST.minePage;
  if (!force && cur && cur.ok && Date.now() - cur.at < APPS_CAT_TTL) return cur;
  if (APPS_ST.mineBusy) return cur;
  const me = appsMineOwnerKey();
  const api = window.api || {};
  if (!me || typeof api.storeRequest !== "function") {
    APPS_ST.minePage = { ok: false, at: Date.now(), page: 0, pageSize: APPS_MINE_PAGE_SIZE, total: 0, items: [] };
    return APPS_ST.minePage;
  }
  const wantPages = cur && cur.ok ? Math.max(1, Number(cur.page) || 1) : 1;
  APPS_ST.mineBusy = true;
  const items = [];
  let total = 0;
  let lastPage = 0;
  let got = false;
  for (let p = 1; p <= wantPages; p++) {
    const one = await appsMineFetchPage(p);
    if (!one) break;
    got = true;
    total = one.total;
    lastPage = one.page;
    for (const it of one.items) items.push(it);
    if (items.length >= total) break;
  }
  APPS_ST.mineBusy = false;
  if (!got) {
    /* 拉不到（断网 / 服务端异常 / 登录态过期）：**保留上一次的列表**，只把 ok 标假让页头说实话。 */
    APPS_ST.minePage = {
      ok: false,
      at: Date.now(),
      page: cur ? Number(cur.page) || 0 : 0,
      pageSize: APPS_MINE_PAGE_SIZE,
      total: cur ? Number(cur.total) || 0 : 0,
      items: (cur && cur.items) || [],
    };
    return APPS_ST.minePage;
  }
  APPS_ST.minePage = {
    ok: true,
    at: Date.now(),
    page: lastPage || 1,
    pageSize: APPS_MINE_PAGE_SIZE,
    total: total,
    items: items,
  };
  appsMineRebuildById();
  return APPS_ST.minePage;
}

/** 「加载更多」：下一页追加进累积列表（同 id 去重），完了重绘。 */
async function appsMinePageMore() {
  const cur = APPS_ST.minePage;
  if (!cur || !cur.ok || APPS_ST.mineBusy) return false;
  if (cur.items.length >= cur.total) return false;
  APPS_ST.mineBusy = true;
  const one = await appsMineFetchPage((Number(cur.page) || 1) + 1);
  APPS_ST.mineBusy = false;
  if (!one) {
    appsToast(appsT("这一页没拉到：检查网络后重试"), "err");
    return false;
  }
  const seen = Object.create(null);
  for (const it of cur.items) if (it && it.id) seen[String(it.id)] = 1;
  for (const it of one.items) {
    const id = String((it && it.id) || "");
    if (!id || seen[id]) continue;
    seen[id] = 1;
    cur.items.push(it);
  }
  cur.page = Number(one.page) || cur.page + 1;
  cur.total = Number(one.total) || cur.total;
  cur.at = Date.now();
  appsMineRebuildById();
  appsHubPaint();
  return true;
}

/** 我的条目 → 卡片 spec（appsSpecFromMine 已把接口字段拼成目录条目同形），默认最近更新在前。 */
function appsMineSpecs() {
  const items = (APPS_ST.minePage && APPS_ST.minePage.items) || [];
  const out = [];
  for (const it of items) {
    const s = appsSpecFromMine(it);
    if (s) out.push(s);
  }
  out.sort(
    (a, b) =>
      (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) ||
      appsSpecTitle(a).localeCompare(appsSpecTitle(b), "zh"),
  );
  return out;
}
/** 编辑 / 删除对话框要的那一条（找不到回 null：调用方给一句「先刷新一下」，不猜） */
function appsMineSpecOf(id) {
  const want = String(id || "");
  if (!want) return null;
  return appsMineSpecs().find((s) => String(s.id) === want) || null;
}
/** 本地筛选：只按搜索词过滤（标题 / 描述 / id / 标签）。
 *  以前这里还有一颗「只看已下架」开关 —— 已按用户口径整条移除（连同 APPS_ST.mineOfflineOnly），
 *  已下架的条目本来就在列表里带着自己的标记，不必再切一层视图。 */
function appsMineFiltered(specs) {
  const q = String(APPS_ST.q || "").trim().toLowerCase();
  let out = specs;
  if (q) {
    out = out.filter((s) =>
      (
        appsSpecTitle(s) +
        " " +
        String(s.description || "") +
        " " +
        String(s.id || "") +
        " " +
        appsTagsOf(s).join(" ")
      )
        .toLowerCase()
        .indexOf(q) >= 0,
    );
  }
  return out;
}

/* ── 页面 ─────────────────────────────────────────────────────────────── */

async function appsPaintMinePage(body, seq) {
  const loading = document.createElement("div");
  loading.className = "apps-empty";
  loading.textContent = appsT("正在读取你上架到云端的应用…");
  body.appendChild(loading);
  await appsMinePageLoad(false);
  if (seq !== APPS_ST.seq || APPS_ST.nav !== "mine") return;
  body.innerHTML = "";
  appsHubTopbar();
  const page = APPS_ST.minePage || { ok: false, items: [], total: 0 };
  const all = appsMineSpecs();
  const shown = appsMineFiltered(all);

  const hint = document.createElement("div");
  hint.className = "apps-hint";
  /* 本轮口径：「已下架」整条移除，页头不再有「其中已下架 N 个」那半句。 */
  hint.textContent = page.ok
    ? appsT("云端我上架的条目共 ") +
      page.total +
      appsT(" 个（已载入 ") +
      all.length +
      appsT(" 个）")
    : appsT("暂时拉不到你上架的条目：检查网络 / 登录状态后重进本页（先显示上一次的列表）");
  body.appendChild(hint);

  /* 工具条只剩「刷新」一颗（视图切换钮在壳的第 1 行，见 appsHubSearchRow）。 */
  const bar = document.createElement("div");
  bar.className = "apps-minebar";
  bar.appendChild(
    appsMiniBtn(appsT("刷新"), () => {
      appsMinePageLoad(true).then(() => appsHubPaint());
    }),
  );
  body.appendChild(bar);

  const q = String(APPS_ST.q || "").trim();
  if (q) {
    const line = document.createElement("div");
    line.className = "apps-filterline";
    line.textContent =
      appsT("筛选：") +
      appsT("关键词「") +
      q +
      appsT("」") +
      appsT(" —— 命中 ") +
      shown.length +
      " / " +
      all.length +
      appsT(" 个应用");
    line.appendChild(
      appsMiniBtn(appsT("清除筛选"), () => {
        APPS_ST.q = "";
        const host = appsHubEl();
        const inp = host ? host.querySelector(".apps-hub-search") : null;
        if (inp) inp.value = "";
        appsSearchFlush();
        appsHubPaint();
      }),
    );
    body.appendChild(line);
  }

  if (!all.length) {
    /* 空态只有一句话（用户口径「没有我的应用时只需显示无应用即可」）。拉不到与确实没有
       都归这一句 —— 上面页头那句实话已经分清了两种情形，这里不再重复第二遍说辞。 */
    const empty = document.createElement("div");
    empty.className = "apps-empty";
    empty.textContent = appsT("无应用");
    body.appendChild(empty);
    appsPaintMark(body);
    return;
  }
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "apps-empty";
    empty.textContent = appsT("没有匹配「") + q + appsT("」的应用");
    body.appendChild(empty);
    appsPaintMark(body);
    return;
  }
  /* 视图分流（本轮共识）：列表模式 = 左列表 + 右内嵌详情（按更新时间倒序）；否则卡片网格。
     「加载更多」两种模式都挂在正文末尾（单页最多 50 条，不加这一颗就永远看不全）。 */
  const listMode = appsViewIsList("mine") && appsListModeMount(body, shown, { sort: "updated" });
  if (!listMode) APPS_GRID_PAINT(body, shown, { mine: true });
  if (all.length < Number(page.total || 0)) {
    const moreRow = document.createElement("div");
    moreRow.className = "apps-minebar apps-minebar-more";
    moreRow.appendChild(
      appsMiniBtn(
        appsT("加载更多（已 ") + all.length + " / " + page.total + appsT("）"),
        () => appsMinePageMore(),
        true,
      ),
    );
    body.appendChild(moreRow);
  }
  appsPaintMark(body);
}

/* 描述框的「预览」（本轮需求）：点一下在框下方**就地展开** renderMarkdown 的结果，
 * 再点收起 —— 作者能当场看见「这段说明在应用详情里长什么样」，不必先上架再看。
 * 两处入口共用这一个：应用中心的「编辑应用」窗（本文件）与上架窗（app-publish.js，
 * 按 typeof 探测调用，传自己的 tr / toast）。渲染与详情同源（全站 renderMarkdown：
 * 先转义再 marked 解析、拦掉非 http 链接、公式同源），所以预览所见 = 详情所得。
 * 入参 opts.text = 取当前描述文本的函数（**必须挂在对象上调用**：test/smoke-apps-tips.js 的
 * 「渲染层未定义全局」扫描按裸名 `名字(` 抓调用，裸参调用会被当成未定义全局报错）。 */
function appsDescPreviewEl(opts) {
  const o = Object.assign({ text: null, t: appsT, toast: appsToast }, opts || {});
  const tr = typeof o.t === "function" ? o.t : appsT;
  const say = typeof o.toast === "function" ? o.toast : appsToast;
  const wrap = document.createElement("div");
  wrap.className = "apps-desc-prevwrap";
  const bodyWrap = document.createElement("div");
  bodyWrap.className = "apps-desc-prevbody";
  bodyWrap.hidden = true;
  const btn = appsMiniBtn(tr("预览"), () => {
    if (!bodyWrap.hidden) {
      bodyWrap.hidden = true;
      bodyWrap.innerHTML = "";
      btn.textContent = tr("预览");
      return;
    }
    const md = String((o.text ? o.text() : "") || "").trim();
    if (!md) {
      say(tr("还没有写说明：先写几句再预览"), "warn");
      return;
    }
    bodyWrap.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "apps-desc-prevmd md";
    if (typeof renderMarkdown === "function") inner.innerHTML = renderMarkdown(md);
    else inner.textContent = md;
    bodyWrap.appendChild(inner);
    bodyWrap.hidden = false;
    btn.textContent = tr("收起预览");
  });
  btn.title = tr("按 Markdown 渲染这段说明（标题 / 列表 / 链接 / 代码都认）");
  wrap.appendChild(btn);
  wrap.appendChild(bodyWrap);
  return wrap;
}
window.appsDescPreviewEl = appsDescPreviewEl;

/* ── 编辑对话框（标题 / 描述 / 标签 / 图标 / 上架截图 + 声明） ───────────── */

const APPS_EDIT = {
  id: "",
  spec: null,
  form: null,
  dom: Object.create(null),
  seq: 0,
};

function appsEditShellBox() {
  const ov = document.getElementById("overlay");
  return ov ? ov.querySelector(":scope > .overlay-box") : null;
}
function appsEditBoxCleanup() {
  try {
    document.querySelectorAll("#overlay > .overlay-box.apps-edit-box").forEach((b) => {
      b.classList.remove("apps-edit-box");
    });
  } catch (_) {}
}
/* 与详情窗同一套收尾：.overlay-box 是**全应用共享**的一只壳，openOverlay / closeOverlay 只清
   内联样式、不摘未登记的类 —— 关窗路径不止 ✕（Esc / 切画布 / 别处开新窗都走 closeOverlay），
   所以盯 #overlay 的显隐来摘类，别只挂在某一颗按钮上。 */
let APPS_EDIT_OV_WATCH = null;
function appsEditWatchOverlay() {
  appsEditUnwatchOverlay();
  const ov = document.getElementById("overlay");
  if (!ov || typeof MutationObserver !== "function") return;
  APPS_EDIT_OV_WATCH = new MutationObserver(() => {
    if (ov.style.display === "none") {
      appsEditBoxCleanup();
      appsEditUnwatchOverlay();
    }
  });
  APPS_EDIT_OV_WATCH.observe(ov, { attributes: true, attributeFilter: ["style"] });
}
function appsEditUnwatchOverlay() {
  if (!APPS_EDIT_OV_WATCH) return;
  try {
    APPS_EDIT_OV_WATCH.disconnect();
  } catch (_) {}
  APPS_EDIT_OV_WATCH = null;
}
function closeAppEdit() {
  APPS_EDIT.id = "";
  APPS_EDIT.spec = null;
  APPS_EDIT.form = null;
  APPS_EDIT.dom = Object.create(null);
  APPS_EDIT.seq++;
  appsEditUnwatchOverlay();
  appsEditBoxCleanup();
  if (typeof closeOverlay === "function") closeOverlay();
}

/* 一行表单（label + 控件 + 提示）：三个对话框共用这一份排版 */
function appsEditRow(label, control, hint) {
  const row = document.createElement("label");
  row.className = "apps-edit-row";
  const k = document.createElement("span");
  k.className = "apps-edit-k";
  k.textContent = label;
  row.appendChild(k);
  const v = document.createElement("span");
  v.className = "apps-edit-v";
  v.appendChild(control);
  if (hint) {
    const h = document.createElement("span");
    h.className = "apps-edit-hint";
    h.textContent = hint;
    v.appendChild(h);
  }
  row.appendChild(v);
  return row;
}

/* 读本机图片文件（图标 / 截图共用）：<input type=file> + FileReader，不依赖任何桥
   （与上架窗 renderer/app-publish.js 同一口径），只收 png / jpeg / webp。
   o.onEach = 每读好一张调一次（回调挂在选项对象上，与别的模块同一写法）。 */
function appsEditReadImages(files, o) {
  const list = Array.prototype.slice.call(files || []);
  for (const file of list) {
    const type = String((file && file.type) || "").toLowerCase();
    if (APPS_EDIT_IMG_TYPES.indexOf(type) < 0) {
      appsToast(appsT("只支持 png / jpeg / webp 图片") + "：" + String((file && file.name) || ""), "warn");
      continue;
    }
    const fr = new FileReader();
    fr.onload = () => {
      if (!o || typeof o.onEach !== "function") return;
      o.onEach({
        dataUrl: String(fr.result || ""),
        bytes: Number(file.size) || 0,
        name: String(file.name || ""),
        type: type,
      });
    };
    fr.onerror = () => appsToast(appsT("读这个图片文件失败：") + String((file && file.name) || ""), "err");
    fr.readAsDataURL(file);
  }
}
/* 弹一次文件选择（多选）：每次现建一个 input，用完即弃（不留在对话框 DOM 里） */
function appsEditPickImages(multiple, o) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = APPS_EDIT_IMG_TYPES.join(",");
  inp.multiple = !!multiple;
  inp.style.display = "none";
  inp.addEventListener("change", () => {
    appsEditReadImages(inp.files, o);
    inp.remove();
  });
  document.body.appendChild(inp);
  inp.click();
}

/* 截图条：现画 form.shots（云端老图 = {kind:"cloud", keepIndex, url}；新加的 = {kind:"new", dataUrl}）。
   每张右上角一枚 ✕ 删除；整张可拖拽排序（落点取该张前半 / 后半 = 插到它前 / 后，与设置里
   模型行的拖拽同一口径）。 */
function appsEditPaintShots() {
  const host = APPS_EDIT.dom.shots;
  const f = APPS_EDIT.form;
  if (!host || !f) return;
  host.innerHTML = "";
  f.shots.forEach((s, i) => {
    const cell = document.createElement("div");
    cell.className = "apps-shot";
    cell.dataset.shotKey = s.key;
    cell.draggable = true;
    cell.title = appsT("拖动能调整顺序（第 1 张同时用作商店封面）");
    const img = document.createElement("img");
    img.alt = "";
    img.src = s.kind === "cloud" ? appsUrlWithToken(String(s.url || ""), APPS_EDIT.spec) : String(s.dataUrl || "");
    cell.appendChild(img);
    const idx = document.createElement("span");
    idx.className = "apps-shot-no";
    idx.textContent = String(i + 1);
    cell.appendChild(idx);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "apps-shot-del";
    del.textContent = "✕";
    del.title = appsT("删掉这张截图（保存后云端不再有它）");
    del.setAttribute("aria-label", appsT("删除这张截图"));
    del.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      f.shots.splice(i, 1);
      f.shotsTouched = true;
      appsEditPaintShots();
    };
    cell.appendChild(del);
    cell.addEventListener("dragstart", (ev) => {
      cell.classList.add("dragging");
      try {
        ev.dataTransfer.setData("text/plain", s.key);
        ev.dataTransfer.effectAllowed = "move";
      } catch (_) {}
    });
    cell.addEventListener("dragend", () => cell.classList.remove("dragging"));
    cell.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      const r = cell.getBoundingClientRect();
      const after = ev.clientX > r.left + r.width / 2;
      cell.classList.toggle("drop-after", after);
      cell.classList.toggle("drop-before", !after);
    });
    cell.addEventListener("dragleave", () => cell.classList.remove("drop-before", "drop-after"));
    cell.addEventListener("drop", (ev) => {
      ev.preventDefault();
      cell.classList.remove("drop-before", "drop-after");
      const key = (() => {
        try {
          return ev.dataTransfer.getData("text/plain");
        } catch (_) {
          return "";
        }
      })();
      const from = f.shots.findIndex((x) => x.key === key);
      if (from < 0 || from === i) return;
      const r = cell.getBoundingClientRect();
      const after = ev.clientX > r.left + r.width / 2;
      const moved = f.shots.splice(from, 1)[0];
      const to = f.shots.findIndex((x) => x.key === s.key);
      f.shots.splice(after ? to + 1 : to, 0, moved);
      f.shotsTouched = true;
      appsEditPaintShots();
    });
    host.appendChild(cell);
  });
  const tip = APPS_EDIT.dom.shotsTip;
  if (tip) {
    tip.textContent =
      appsT("上架截图 ") + f.shots.length + " / " + APPS_EDIT_MAX_SHOTS + appsT(" 张 · 拖动能调整顺序 · 第 1 张同时用作商店封面");
  }
}

/** 打开编辑对话框（id = 应用 id）。找不到那一条（列表过期）就如实提示，不猜字段。 */
function openAppEdit(id) {
  const sid = String(id || "");
  if (!sid) return false;
  if (typeof openOverlay !== "function") {
    appsToast(appsT("窗口模块未就绪（openOverlay 不存在）"), "err");
    return false;
  }
  const spec = appsMineSpecOf(sid);
  if (!spec) {
    appsToast(appsT("这条应用不在「我的应用」列表里：先刷新一下再编辑"), "err");
    return false;
  }
  const cloudShots = appsShotsUrlsOf(spec);
  /* 编辑窗里的缩略图用**列表小图**（长边 1280）：图片放宽到 5MB 之后，打开编辑不该先把
     8 张 2560 原图全拉一遍 —— 保存用的是 {keep:i} / {sha}，与这里显示哪一档无关。 */
  const cloudShotThumbs = appsShotsUrlsOf(spec, { size: "list" });
  const rels = Array.isArray(spec.shots) ? spec.shots : [];
  APPS_EDIT.id = sid;
  APPS_EDIT.spec = spec;
  APPS_EDIT.seq++;
  APPS_EDIT.shotsRetry = null;
  APPS_EDIT.form = {
    title: appsSpecTitle(spec),
    description: String(spec.description || ""),
    tags: appsTagsOf(spec).join("，"),
    icon: null, /* 选了新图标才有：{ dataUrl, bytes, name } */
    iconCleared: false, /* 点过「清除图标」：保存时发 iconBase64:"" */
    shots: rels.map((rel, i) => ({
      key: "c" + i,
      kind: "cloud",
      keepIndex: i,
      /* 现有截图的展示地址：接口 / 静态目录给的绝对是首选；拿不到（目录还没拉全）就用
         图标顶一下，绝不在编辑框里挂一串相对地址变成破图。保存用的是 {keep:i}，不看这个地址。 */
      url: (function () {
        const list = String(cloudShotThumbs[i] || "");
        const full = String(cloudShots[i] || "");
        if (/^(https?:|data:image\/)/i.test(list)) return list;
        if (/^(https?:|data:image\/)/i.test(full)) return full;
        return appsIconUrl(spec) || full;
      })(),
    })),
    shotsTouched: false,
    declaration: false,
  };

  openOverlay(appsT("编辑应用") + " · " + appsSpecTitle(spec), { persistent: true, min: true });
  appsEditBoxCleanup();
  const box = appsEditShellBox();
  if (box) box.classList.add("apps-edit-box");
  appsEditWatchOverlay();

  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) {
    closeAppEdit();
    return false;
  }
  const f = APPS_EDIT.form;
  const dom = APPS_EDIT.dom;

  const wrap = document.createElement("div");
  wrap.className = "apps-edit-root";

  const sec1 = document.createElement("div");
  sec1.className = "apps-edit-sec";
  const t1 = document.createElement("h4");
  t1.className = "apps-edit-t";
  t1.textContent = appsT("① 基本信息（改完立刻对全站生效）");
  sec1.appendChild(t1);
  const titleIn = document.createElement("input");
  titleIn.type = "text";
  titleIn.maxLength = APPS_EDIT_TITLE_MAX;
  titleIn.className = "apps-edit-input";
  titleIn.value = f.title;
  titleIn.addEventListener("input", () => {
    f.title = titleIn.value;
    appsEditPaintFoot();
  });
  dom.title = titleIn;
  sec1.appendChild(appsEditRow(appsT("标题"), titleIn, appsT("最多 ") + APPS_EDIT_TITLE_MAX + appsT(" 字：应用卡片 / 详情窗显示它")));
  const descIn = document.createElement("textarea");
  descIn.className = "apps-edit-textarea";
  descIn.maxLength = APPS_EDIT_DESC_MAX;
  descIn.rows = 6;
  descIn.value = f.description;
  descIn.addEventListener("input", () => {
    f.description = descIn.value;
  });
  sec1.appendChild(
    appsEditRow(appsT("描述"), descIn, appsT("最多 ") + APPS_EDIT_DESC_MAX + appsT(" 字：用户在应用页看到的说明")),
  );
  /* 描述框下的「预览」（本轮需求）：就地展开 Markdown 渲染结果，再点收起 */
  sec1.appendChild(appsDescPreviewEl({ text: () => f.description }));
  wrap.appendChild(sec1);

  const sec2 = document.createElement("div");
  sec2.className = "apps-edit-sec";
  const t2 = document.createElement("h4");
  t2.className = "apps-edit-t";
  t2.textContent = appsT("② 标签（逗号分隔，最多 ") + APPS_EDIT_TAGS_MAX + appsT(" 个）");
  sec2.appendChild(t2);
  const tagsIn = document.createElement("input");
  tagsIn.type = "text";
  tagsIn.className = "apps-edit-input";
  tagsIn.value = f.tags;
  tagsIn.addEventListener("input", () => {
    f.tags = tagsIn.value;
  });
  dom.tags = tagsIn;
  sec2.appendChild(appsEditRow(appsT("标签"), tagsIn, appsT("空着 = 不写标签（老标签会保留，不会被清掉）")));
  wrap.appendChild(sec2);

  const sec3 = document.createElement("div");
  sec3.className = "apps-edit-sec";
  const t3 = document.createElement("h4");
  t3.className = "apps-edit-t";
  t3.textContent = appsT("③ 封面图标（png / jpeg / webp，≤500KB）");
  sec3.appendChild(t3);
  const iconRow = document.createElement("span");
  iconRow.className = "apps-edit-iconrow";
  const iconPrev = document.createElement("img");
  iconPrev.className = "apps-edit-iconprev";
  iconPrev.alt = "";
  dom.iconPrev = iconPrev;
  iconRow.appendChild(iconPrev);
  const iconBtns = document.createElement("span");
  iconBtns.className = "apps-edit-iconbtns";
  iconBtns.appendChild(
    appsMiniBtn(appsT("选择图片…"), () => {
      appsEditPickImages(false, {
        onEach: (one) => {
          if (one.bytes > APPS_EDIT_ICON_MAX) {
            appsToast(appsT("图标超过 500KB：") + one.name + appsT("（换一张更小的，或把它当截图）"), "warn");
          }
          f.icon = one;
          f.iconCleared = false;
          appsEditPaintIcon();
        },
      });
    }),
  );
  iconBtns.appendChild(
    appsMiniBtn(appsT("清除图标"), () => {
      f.icon = null;
      f.iconCleared = true;
      appsEditPaintIcon();
    }),
  );
  iconRow.appendChild(iconBtns);
  dom.iconInfo = document.createElement("span");
  dom.iconInfo.className = "apps-edit-hint";
  iconRow.appendChild(dom.iconInfo);
  sec3.appendChild(appsEditRow(appsT("图标"), iconRow));
  wrap.appendChild(sec3);

  const sec4 = document.createElement("div");
  sec4.className = "apps-edit-sec";
  const t4 = document.createElement("h4");
  t4.className = "apps-edit-t";
  t4.textContent = appsT("④ 上架截图（最多 ") + APPS_EDIT_MAX_SHOTS + appsT(" 张，可拖动排序）");
  sec4.appendChild(t4);
  const shotsBox = document.createElement("div");
  shotsBox.className = "apps-shots";
  dom.shots = shotsBox;
  sec4.appendChild(shotsBox);
  dom.shotsTip = document.createElement("div");
  dom.shotsTip.className = "apps-edit-hint";
  sec4.appendChild(dom.shotsTip);
  sec4.appendChild(
    appsMiniBtn(appsT("添加图片…"), () => {
      appsEditPickImages(true, {
        onEach: (one) => {
          if (f.shots.length >= APPS_EDIT_MAX_SHOTS) {
            appsToast(appsT("截图最多 ") + APPS_EDIT_MAX_SHOTS + appsT(" 张：先删掉一张再加"), "warn");
            return;
          }
          f.shots.push({
            key: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            kind: "new",
            dataUrl: one.dataUrl,
          });
          f.shotsTouched = true;
          appsEditPaintShots();
        },
      });
    }),
  );
  wrap.appendChild(sec4);

  const sec5 = document.createElement("div");
  sec5.className = "apps-edit-sec";
  const t5 = document.createElement("h4");
  t5.className = "apps-edit-t";
  t5.textContent = appsT("⑤ 声明（必须勾选才能保存）");
  sec5.appendChild(t5);
  const declText = document.createElement("p");
  declText.className = "apps-edit-decl";
  declText.textContent = appsT(APPS_EDIT_DECLARATION);
  sec5.appendChild(declText);
  const declLabel = document.createElement("label");
  declLabel.className = "apps-edit-check";
  const declBox = document.createElement("input");
  declBox.type = "checkbox";
  declBox.checked = false;
  declBox.addEventListener("change", () => {
    f.declaration = !!declBox.checked;
    appsEditPaintFoot();
  });
  dom.decl = declBox;
  declLabel.appendChild(declBox);
  const declSpan = document.createElement("span");
  declSpan.textContent = appsT("我已阅读并同意，责任由我承担");
  declLabel.appendChild(declSpan);
  sec5.appendChild(declLabel);
  sec5.appendChild(
    appsEditRow(
      appsT("编辑后同步本机"),
      (() => {
        const s = document.createElement("span");
        s.className = "apps-edit-hint";
        s.textContent = appsT("保存成功后，标题 / 描述 / 标签会写回本机同 id 的副本（下载根 + 项目根）；图标不写本机文件。");
        return s;
      })(),
    ),
  );
  wrap.appendChild(sec5);
  body.appendChild(wrap);

  /* 底栏（本轮共识）：「删除应用（云端彻底删除，不可恢复）」在这只编辑窗里，与保存 / 取消同排、危险色。
     它是**不可恢复**的云端彻底删除（删除是唯一的撤下方式 —— 没有「先撤下、以后还能恢复」那条退路），
     点下去走原来那只强确认框（必须一字不差输入应用标题）。 */
  dom.del = appsMiniBtn(appsT("删除应用（云端彻底删除，不可恢复）"), () => openAppDelete(sid));
  dom.del.classList.add("apps-del-btn", "apps-edit-del");
  dom.del.title = appsT("云端彻底删除：这条分支的记录 / 版本包 / 图标 / 上架截图一起删掉，不可恢复");
  foot.appendChild(dom.del);
  dom.save = appsMiniBtn(appsT("保存"), () => appsEditSave(), true);
  dom.save.classList.add("apps-edit-save");
  foot.appendChild(appsMiniBtn(appsT("取消"), () => closeAppEdit()));
  foot.appendChild(dom.save);

  appsEditPaintIcon();
  appsEditPaintShots();
  appsEditPaintFoot();
  if (titleIn.focus) {
    try {
      titleIn.focus();
    } catch (_) {}
  }
  return true;
}

function appsEditPaintIcon() {
  const f = APPS_EDIT.form;
  const dom = APPS_EDIT.dom;
  if (!f || !dom.iconPrev) return;
  if (f.icon && f.icon.dataUrl) {
    dom.iconPrev.src = f.icon.dataUrl;
    dom.iconPrev.hidden = false;
    if (dom.iconInfo) dom.iconInfo.textContent = (f.icon.name || appsT("新图标")) + " · " + appsBytes(f.icon.bytes);
    return;
  }
  if (f.iconCleared) {
    dom.iconPrev.removeAttribute("src");
    dom.iconPrev.hidden = true;
    if (dom.iconInfo) dom.iconInfo.textContent = appsT("已标记清除：保存后这条应用没有图标（退回底色卡）");
    return;
  }
  /* 这里预览的是**图标本身**（这张表单改的就是图标），不是商店封面 ——
     封面取自「上架截图」第 1 张，换图标不会换封面，所以不能拿封面来冒充「当前图标」。 */
  const url = appsIconUrl(APPS_EDIT.spec);
  if (url) {
    dom.iconPrev.src = url;
    dom.iconPrev.hidden = false;
  } else {
    dom.iconPrev.removeAttribute("src");
    dom.iconPrev.hidden = true;
  }
  if (dom.iconInfo) dom.iconInfo.textContent = appsT("当前图标（不动它就保持不变；商店封面取自「上架截图」第 1 张）");
}

/* 保存按钮的可用态：标题非空 + 勾了声明（与上架窗同一口径，服务端也这样校验） */
function appsEditPaintFoot() {
  const f = APPS_EDIT.form;
  const dom = APPS_EDIT.dom;
  if (!f || !dom.save) return;
  const ok = !!String(f.title || "").trim() && f.declaration === true;
  dom.save.disabled = !ok;
  dom.save.title = ok
    ? appsT("保存：改元数据（不发新版本，版本号不动）")
    : !String(f.title || "").trim()
      ? appsT("标题不能为空")
      : appsT("请先勾选「我已阅读并同意，责任由我承担」");
}

/* 标签输入 → 数组（逗号 / 中文逗号分隔，去重，最多 8 个；空串 = 不写这个字段） */
function appsEditTagsOf(raw) {
  const parts = String(raw || "").split(/[,，]/);
  const out = [];
  const seen = Object.create(null);
  for (const p of parts) {
    const t = String(p || "").trim();
    if (!t || seen[t]) continue;
    seen[t] = 1;
    out.push(t);
    if (out.length >= APPS_EDIT_TAGS_MAX) break;
  }
  return out;
}

/* data URL → 裸 base64（上架窗 app-publish.js 的 pubStripDataUrl 同口径；这里自带一份，
   避免跨模块依赖 —— 只有几行，比多一条耦合划算）。 */
function pubStripDataUrlSafe(u) {
  const s = String(u || "");
  const i = s.indexOf(",");
  return i >= 0 ? s.slice(i + 1) : s;
}
/* 体积格式化（编辑窗提示用；与 app-publish.js 的 pubBytes 同一档读数） */
function appsFmtBytes(n) {
  if (typeof fmtBytes === "function") return fmtBytes(n);
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1024 / 1024).toFixed(2) + " MB";
}
/* 这个内容指纹云端是不是已经有了？两处来源（任一命中即可）：
   · 本窗见过 / 上传成功过的那些（app-publish.js 的会话级表）；
   · 云端条目下发的 shotsSha[]（正在编辑的这条应用当前那一套截图）。
   判错也不会丢图：服务端对「引用不存在」回 OBJ_NOT_FOUND，调用方会整批发字节重试一次。 */
function appsShotShaSeenHas(sha) {
  const h = String(sha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return false;
  const IMG = window.MTNodePublishImg;
  const spec = APPS_EDIT.spec || {};
  const list = Array.isArray(spec.shotsSha) ? spec.shotsSha : [];
  for (const x of list) {
    if (String(x || "").trim().toLowerCase() === h) return true;
  }
  return !!(IMG && typeof IMG.seenHas === "function" && IMG.seenHas(h));
}

/** 保存：PATCH 元数据（不发 zip → 服务端不动版本号），再同步本机副本。 */
async function appsEditSave() {  const api = window.api || {};
  const spec = APPS_EDIT.spec;
  const f = APPS_EDIT.form;
  if (!spec || !f) return false;
  const title = String(f.title || "").trim();
  if (!title) {
    appsToast(appsT("标题不能为空"), "warn");
    return false;
  }
  if (f.declaration !== true) {
    appsToast(appsT("请先勾选声明「我已阅读并同意，责任由我承担」——未勾选不能保存"), "warn");
    return false;
  }
  if (typeof api.storeRequest !== "function") {
    appsBridgeMissing();
    return false;
  }
  const body = {
    title: title,
    description: String(f.description || ""),
    tags: appsEditTagsOf(f.tags),
    acceptDeclaration: true,
  };
  if (f.icon && f.icon.dataUrl) body.iconBase64 = f.icon.dataUrl;
  else if (f.iconCleared) body.iconBase64 = "";
  /* 截图整批提交：新图给 data URL（或 {sha} 引用），保留的云端老图给 {keep:n}（n = 保存前那一套里的下标）。
     用户没动过截图（增 / 删 / 排序）就**不带这个字段** —— 服务端按「不传 = 不动」处理。
     新图这一路**与上架窗同一套压缩 + 内容指纹口径**：
       · 客户端先压（长边 2560 / ≤5MB，见 app-publish.js 的 pubPrepareShot）；
       · 算 sha256，若这个指纹已经在云端（服务端条目下发过 shotsSha）→ 只发 { sha } 引用，
         **不再重传字节**；服务端发现引用不存在会回 OBJ_NOT_FOUND，这时整批发字节重试一次。 */
  let shotsSent = null;
  if (f.shotsTouched) {
    const IMG = window.MTNodePublishImg;
    const prep = [];
    for (let i = 0; i < f.shots.length; i++) {
      const s = f.shots[i];
      if (s.kind === "cloud") {
        prep.push({ send: { keep: Number(s.keepIndex) || 0 }, sha: "" });
        continue;
      }
      const dataUrl = String(s.dataUrl || "");
      if (!IMG || typeof IMG.prepare !== "function") {
        prep.push({ send: dataUrl, sha: "", raw: dataUrl });
        continue;
      }
      const one = await IMG.prepare(dataUrl, { kind: "shot", srcBytes: Number(s.bytes) || 0 });
      if (!one || !one.dataUrl) {
        appsToast(appsT("截图 ") + (i + 1) + appsT(" 读不出来：删掉它或重新选一张再保存"), "warn");
        appsEditPaintFoot();
        return false;
      }
      if (one.tooLarge) {
        appsToast(
          appsT("截图 ") + (i + 1) + appsT(" 压到长边 ") + IMG.maxEdge + appsT(" 后仍有 ") +
            appsFmtBytes(one.bytes) + appsT("，超过单张 5MB 上限：请先裁切或转小。"),
          "warn",
        );
        appsEditPaintFoot();
        return false;
      }
      const sha = typeof IMG.sha256Of === "function" ? await IMG.sha256Of(one.dataUrl) : "";
      const cached = !!sha && appsShotShaSeenHas(sha);
      prep.push({ send: cached ? { sha: sha } : pubStripDataUrlSafe(one.dataUrl), sha: sha, raw: one.dataUrl, cached: cached });
    }
    shotsSent = prep.map((x) => x.send);
    body.shotsBase64 = shotsSent;
    if (prep.some((x) => x.cached)) {
      appsToast(appsT("截图 ") + prep.filter((x) => x.cached).length + appsT(" 张云端已有：只发内容指纹，不再重传图片"), "ok");
    }
    /* 引用式提交失败（云端其实没有那份对象）时就地退回字节重试一次 */
    APPS_EDIT.shotsRetry = prep;
  }
  const ownerId = String(spec.ownerId || "");
  const path =
    "/api/apps/" + encodeURIComponent(String(spec.id || "")) + (ownerId ? "?owner=" + encodeURIComponent(ownerId) : "");
  const dom = APPS_EDIT.dom;
  if (dom.save) dom.save.disabled = true;
  let r = null;
  try {
    r = await api.storeRequest({ method: "PATCH", path: path, body: body });
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  /* 服务端说「这个内容引用云端没有」（OBJ_NOT_FOUND：本机记住了、云端其实清过）：
     把引用式的那几张就地换成字节，整批重发一次（只重试一次，避免死循环）。 */
  const sentCode = String((r && r.data && r.data.code) || "");
  if (r && r.ok === false && sentCode === "OBJ_NOT_FOUND" && Array.isArray(APPS_EDIT.shotsRetry)) {
    let replaced = 0;
    APPS_EDIT.shotsRetry.forEach((x, i) => {
      if (!x || !x.sha) return;
      const IMG = window.MTNodePublishImg;
      if (IMG && typeof IMG.forget === "function") IMG.forget(x.sha);
      if (x.raw) {
        body.shotsBase64[i] = pubStripDataUrlSafe(x.raw);
        replaced++;
      }
    });
    if (replaced) {
      appsToast(appsT("云端没有那份缓存的图片：把 ") + replaced + appsT(" 张图一起重传一遍…"), "ok");
      try {
        r = await api.storeRequest({ method: "PATCH", path: path, body: body });
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
    }
  }
  if (!r || r.ok === false) {
    appsToast(appsT("保存失败：") + appsErrText(r), "err");
    appsEditPaintFoot();
    return false;
  }
  /* 上传成功的指纹记进本窗（下一张重复的图只发引用） */
  if (Array.isArray(APPS_EDIT.shotsRetry)) {
    const IMG = window.MTNodePublishImg;
    for (const x of APPS_EDIT.shotsRetry) {
      if (x && x.sha && IMG && typeof IMG.addSeen === "function") IMG.addSeen([x.sha]);
    }
  }
  /* 截图有没有真的生效：老服务端不认识 shotsBase64 会**静默忽略**，回执里的 item.shots
     还是老张数 —— 那种情况必须明说，不能让用户以为改成功了。 */
  const item = (r.data && r.data.item) || null;
  const shotsFailed =
    !!shotsSent && !!item && (Array.isArray(item.shots) ? item.shots.length : -1) !== shotsSent.length;
  const tags = body.tags;
  closeAppEdit();
  await appsMinePageLoad(true);
  await appsCatalogLoad(true);
  appsHubPaint();
  appsToast(appsT("已保存：") + title + appsT("（版本号不变，用户立刻看到新信息）"), "ok");
  if (shotsFailed) {
    appsToast(appsT("截图没生效：云端服务端需要升级后才支持编辑截图（其余修改已保存）"), "warn");
  }
  /* 本机副本同步：标题 / 描述 / 标签（图标不写本机文件 —— 库页封面取的就是云端条目） */
  appsEditSyncLocal(spec.id, { title: title, description: String(body.description || ""), tags: tags });
  return true;
}

/**
 * 云端保存成功后把元数据写回本机同 id 的**所有**副本（下载根 + 项目根，主进程扫两套根）。
 * 失败**不**把云端那次判成失败：云端那份已经改好了，这里只如实补一句本机那边怎么了。
 */
async function appsEditSyncLocal(id, meta) {
  const api = window.api || {};
  if (typeof api.appsSyncCloudMeta !== "function") return null; /* 老主进程：不阻塞云端已保存的结果 */
  let r = null;
  try {
    r = await api.appsSyncCloudMeta(id, meta);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) {
    appsToast(appsT("本机副本没同步上：") + appsErrText(r), "warn");
    return r;
  }
  if (r.missing) {
    appsToast(appsT("本机没有这个应用，未同步（只改了云端）"), "ok");
    return r;
  }
  if (Number(r.synced) > 0) {
    appsToast(appsT("本机副本已同步：") + Number(r.synced) + appsT(" 处 app.json"), "ok");
    return r;
  }
  const fails = (Array.isArray(r.results) ? r.results : []).filter((x) => x && x.ok === false);
  appsToast(
    appsT("本机副本没同步上（") +
      fails.length +
      appsT(" 处写入失败）：") +
      String((fails[0] && fails[0].error) || ""),
    "warn",
  );
  return r;
}

/* ── 删除对话框（输入标题确认） ─────────────────────────────────────────── */

const APPS_DEL = { id: "", spec: null, dom: Object.create(null) };

function closeAppDelete() {
  APPS_DEL.id = "";
  APPS_DEL.spec = null;
  APPS_DEL.dom = Object.create(null);
  appsEditUnwatchOverlay();
  appsEditBoxCleanup();
  if (typeof closeOverlay === "function") closeOverlay();
}

/** 这条应用在云端**其他作者**的分支（删除只会动我自己那一条，所以要如实报数）。 */
function appsOtherBranchesOf(spec) {
  const mine = String((spec && spec.ownerId) || "");
  const list = Array.isArray(spec && spec.branches) ? spec.branches : [];
  const seen = Object.create(null);
  const out = [];
  for (const b of list) {
    const oid = String((b && b.ownerId) || "");
    if (!oid || oid === mine || seen[oid]) continue;
    seen[oid] = 1;
    out.push(b);
  }
  return out;
}

function openAppDelete(id) {
  const sid = String(id || "");
  if (!sid) return false;
  if (typeof openOverlay !== "function") {
    appsToast(appsT("窗口模块未就绪（openOverlay 不存在）"), "err");
    return false;
  }
  const spec = appsMineSpecOf(sid);
  if (!spec) {
    appsToast(appsT("这条应用不在「我的应用」列表里：先刷新一下再删除"), "err");
    return false;
  }
  APPS_DEL.id = sid;
  APPS_DEL.spec = spec;
  APPS_DEL.dom = Object.create(null);
  const others = appsOtherBranchesOf(spec);
  const local = appsLocalById(sid);
  const title = appsSpecTitle(spec);

  openOverlay(appsT("删除应用（云端彻底删除，不可恢复）") + " · " + title, { persistent: true, min: true });
  appsEditBoxCleanup();
  const box = appsEditShellBox();
  if (box) box.classList.add("apps-edit-box");
  appsEditWatchOverlay();

  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) {
    closeAppDelete();
    return false;
  }
  const wrap = document.createElement("div");
  wrap.className = "apps-edit-root apps-del-root";
  const head = document.createElement("p");
  head.className = "apps-del-warn";
  /* 本轮口径：文案整段重写成一句（下架那条退路已随功能一起移除，界面上不再出现对它的指引）。 */
  head.textContent = appsT("云端彻底删除，不可恢复。");
  wrap.appendChild(head);
  const ul = document.createElement("ul");
  ul.className = "apps-del-list";
  const li = (txt) => {
    const e = document.createElement("li");
    e.textContent = txt;
    ul.appendChild(e);
  };
  li(
    others.length
      ? appsT("另有 ") + others.length + appsT(" 位作者的派生分支会保留，不受影响（别人的版本包一个都不会动）。")
      : appsT("这个应用在云端只有你这一条分支：删除后它就是彻底消失了。"),
  );
  li(
    local
      ? appsT("本机已下载的副本不会被删除（要删去「库」页卸载）。")
      : appsT("本机没有下载过这个应用，删除只影响云端。"),
  );
  wrap.appendChild(ul);
  if (others.length) {
    const who = document.createElement("div");
    who.className = "apps-edit-hint";
    who.textContent =
      appsT("保留的派生分支作者：") +
      others
        .map((b) => String((b && (b.ownerName || b.owner)) || appsT("未知作者")))
        .join(" · ");
    wrap.appendChild(who);
  }
  const input = document.createElement("input");
  input.type = "text";
  input.className = "apps-edit-input";
  input.setAttribute("autocomplete", "off");
  input.placeholder = title;
  input.addEventListener("input", () => appsDelPaintFoot());
  APPS_DEL.dom.input = input;
  wrap.appendChild(
    appsEditRow(appsT("输入应用标题确认"), input, appsT("必须一字不差地输入「") + title + appsT("」才能点删除")),
  );
  body.appendChild(wrap);

  APPS_DEL.dom.del = appsMiniBtn(appsT("删除应用（云端彻底删除，不可恢复）"), () => appsDoDelete(), true);
  APPS_DEL.dom.del.classList.add("apps-del-btn");
  foot.appendChild(appsMiniBtn(appsT("取消"), () => closeAppDelete()));
  foot.appendChild(APPS_DEL.dom.del);
  appsDelPaintFoot();
  return true;
}

function appsDelPaintFoot() {
  const spec = APPS_DEL.spec;
  const dom = APPS_DEL.dom;
  if (!spec || !dom.del) return;
  const want = appsSpecTitle(spec);
  const got = String((dom.input && dom.input.value) || "").trim();
  const ok = got === String(want).trim();
  dom.del.disabled = !ok;
  dom.del.title = ok
    ? appsT("云端彻底删除我这一条分支（不可恢复）")
    : appsT("请先输入应用标题（一字不差）再删除");
}

async function appsDoDelete() {
  const api = window.api || {};
  const spec = APPS_DEL.spec;
  if (!spec) return false;
  const want = appsSpecTitle(spec);
  const got = String((APPS_DEL.dom.input && APPS_DEL.dom.input.value) || "").trim();
  if (got !== String(want).trim()) {
    appsToast(appsT("标题不一致：请一字不差地输入应用标题"), "warn");
    return false;
  }
  if (typeof api.storeRequest !== "function") {
    appsBridgeMissing();
    return false;
  }
  const ownerId = String(spec.ownerId || "");
  const path =
    "/api/apps/" + encodeURIComponent(String(spec.id || "")) + (ownerId ? "?owner=" + encodeURIComponent(ownerId) : "");
  if (APPS_DEL.dom.del) APPS_DEL.dom.del.disabled = true;
  let r = null;
  try {
    r = await api.storeRequest({ method: "DELETE", path: path });
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) {
    appsToast(appsT("删除失败：") + appsErrText(r), "err");
    appsDelPaintFoot();
    return false;
  }
  closeAppDelete();
  await appsMinePageLoad(true);
  await appsCatalogLoad(true);
  appsHubPaint();
  appsToast(appsT("已删除：") + want + appsT("（只删了你这一条分支；本机副本没动）"), "ok");
  return true;
}

/* ───────────────── 入口接线 ───────────────── */

function appsEntryInit() {
  const btn = document.getElementById("btnApps");
  if (btn) {
    btn.onclick = () => {
      if (APPS_HUB_OPEN) appsHubClose();
      else openAppsHub();
    };
    /* 右键顶栏入口 = 直接落在「库」页（给常用者一个短路；不占单键） */
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (!appsEntryAllowed()) return;
      openAppsHub("lib");
    });
  }
  appsSyncEntryVisibility();
  if (!appsBindAuthWatch()) {
    /* app-auth.js 排在本文件之后加载：文档解析完再订一次，仍未就绪就再等一拍 */
    document.addEventListener("DOMContentLoaded", () => {
      if (!appsBindAuthWatch()) setTimeout(() => appsBindAuthWatch(), 500);
    });
  }
}

appsEntryInit();

/* 全局别名（页面级入口；与 app-search.js 等模块同口径：只挂入口，不挂内部状态） */
window.openAppsHub = openAppsHub;
window.appsHubClose = appsHubClose;
/* 应用详情对话窗（单开浮层）：卡片上的「详情」按钮走它 */
window.openAppsDetail = openAppsDetail;
window.closeAppsDetail = closeAppsDetail;
/* 「分支 / 版本」跳窗（本轮需求 4）：卡片「下载 / 其他版本」与详情里那颗「选择版本…」走它。
   外露到 window 是为了让只读视觉验证台 / 冒烟能直接开这只窗（与 openAppsDetail 同一口径）。 */
window.openAppsVersionDlg = openAppsVersionDlg;
window.closeAppsVersionDlg = closeAppsVersionDlg;
/* 「我的应用」页：编辑 / 删除两只对话框（卡片按钮走它们；冒烟与验证台也按 window 调） */
window.openAppEdit = openAppEdit;
window.closeAppEdit = closeAppEdit;
window.openAppDelete = openAppDelete;
window.appsMinePageLoad = appsMinePageLoad;
window.appsMineSpecs = appsMineSpecs;
window.appsHubRefresh = appsHubRefresh;
window.appsHubIsOpen = appsHubIsOpen;
/* 卡片渲染出口与「单张卡」构造：只给只读验证台（test/apps-scale-1000.cjs）与冒烟用，
   应用自身没有任何一处按 window 调它们（内部一律直接调函数名）。 */
window.appsTileEl = appsTileEl;
window.appsVirtualGridMount = appsVirtualGridMount;
window.appsGridPaintOf = () => APPS_GRID_PAINT;

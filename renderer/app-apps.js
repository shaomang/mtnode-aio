"use strict";
/* renderer/app-apps.js — 应用中心（顶栏「应用」）+ 本机应用库 + 开发者面板
 * ============================================================================
 * 一页三栏（Microsoft Store 式），全部落在**主窗口内的整屏浮层页**（#appsHub，
 * 挂在 document.body 上 · position:fixed inset:0 · **连顶栏一起盖住**），不是 #overlay 弹窗：
 *   · 应用：读云端目录（http://mt-agent.com/mtnode/apps/catalog.json，主进程 apps-store.js
 *     拉取并缓存到 <数据目录>/apps-cache/catalog.json → 离线也能看），列出云端应用
 *     （图标 / 标题 / 版本 / 描述），可看详情、可下载（zip + sha256 校验 + 解包到
 *     「应用根目录/<AppName>/」都由主进程做）；首次下载前没设根目录 → 弹系统选目录框并持久化；
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
  ["lib", "库", "本机已下载的应用：打开 · 更新 · 卸载"],
  ["dev", "开发", "应用根目录 · 三栏开发台 · 实时预览"],
];

/* 目录缓存新鲜期（毫秒）：这段时间内重开页面 / 切页不重复拉云端目录 */
const APPS_CAT_TTL = 5 * 60 * 1000;

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
  /* 作者视角的线上条目（§七）：公开静态目录看不到「已下架」的自有条目，登录后另拉一次
     GET /api/apps?owner=<自己>&includeUnpublished=1，把 mine / unpublished / 版本树合并进来 */
  mine: null, /* { ok, at, byId: { <id>: item } } */
  mineAt: 0,
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
/* 「详细」= 单开一只对话窗（应用中心目录卡片右上角那一枚 ⓘ；库页卡片仍用它，但文案由调用方给）。
   本轮需求：目录卡片上的「详细」不再是一颗带文案的按钮，改成**一枚 info icon**（ⓘ）——
   卡片第一行右端与金币 icon 并排，同一套小方框样式（.apps-ico-btn）。
   按钮仍是同一个元件（data-app-detail / title / 点击开窗都不变），只是不再显示文案。 */
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

/* 卡片第一行右端的两枚图标按钮（需求口径）：
 *   · 金币 icon = 打赏入口（只上架到云端的应用才有，见 appsCloudTarget）；汇总（`N 币 · M 次`）
 *     不再占卡片正文，收到它的悬停 tooltip 里（没人打赏过就写「还没有人打赏」）。
 *   · ⓘ = 原来的「详细」，见 appsDetailBtnEl。
 * 两枚都走同一套小方框样式（.apps-ico-btn）：与卡片上其它按钮一样不做纯文字裸链。 */
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
function appsAppsIconRow(spec) {
  const cloudTarget = appsCloudTarget(spec);
  const row = document.createElement("span");
  row.className = "apps-tile-icoacts";
  if (cloudTarget && window.MtTips) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini apps-ico-btn apps-ico-coin";
    btn.dataset.appTip = "1";
    const tips = appsSpecWithTips(spec).tips;
    btn.appendChild(window.MtTips.coinIcon("sm"));
    btn.title = appsTipsTitleEl(spec);
    btn.setAttribute("aria-label", appsT("打赏作者（鲸圆币）"));
    btn.onclick = (ev) => {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      window.MtTips.open(cloudTarget, {
        tips: tips,
        /* 打赏成功（或窗里刷新过）→ 立刻重拉这一页的汇总并重绘：刚打赏完回来看到的数字必须是新的 */
        onDone: () => {
          appsTipsRefreshNow();
          appsHubPaint();
        },
      });
    };
    row.appendChild(btn);
  }
  row.appendChild(appsDetailBtnEl(spec && spec.id));
  return row;
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
   主进程 apps-store.js 的 installFailHint / uninstallApp / openAppWindow。 */
function appsErrText(r) {
  const raw = String((r && r.error) || "").trim();
  const code = raw.split(":")[0].trim();
  const CODE_TEXT = {
    need_root: "尚未指定应用安装根目录",
    busy: "该应用已有安装任务在跑",
    bad_id: "应用 id 不合法",
    not_in_catalog: "云端目录里找不到这个应用",
    bad_zip_url: "云端目录里该应用的下载地址不合法",
    need_app_update: "该应用要求的 MTNode 版本高于当前版本",
    sha256_mismatch: "安装包校验失败（sha256 与云端目录声明不一致）",
    pack_missing_entry: "安装包解压后缺少入口页",
    timeout: "下载超时",
    too_large: "安装包超过允许体积上限",
    missing: "该应用不在本机",
    missing_entry: "应用入口页不存在",
  };
  if (CODE_TEXT[code]) return appsT(CODE_TEXT[code]);
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
  return APPS_ST.list;
}
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
  /* 父条目已下架 / 已删（界面上看不到它）：仍尽量按作者挂到同作者那条上，挂不上就归到根。 */
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
/* 云端条目 + 我自己（含已下架）的线上条目合并成一份候选表（与 appsSpecListAll 同一口径） */
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
    ? String(o.selectedOwnerId || (APPS_DETAIL && APPS_DETAIL.branchOwnerId) || "")
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
    if (b.unpublished) {
      const tag = document.createElement("span");
      tag.className = "apps-badge apps-badge-warn";
      tag.textContent = appsT("已下架");
      line.appendChild(tag);
    }

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
    box.appendChild(appsBranchTreeVerSelEl(id, sel, o));
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
  if (APPS_DETAIL) APPS_DETAIL.branchOwnerId = key;
  if (typeof onSelect === "function") {
    onSelect(b);
    return;
  }
  const sc = APPS_DETAIL && APPS_DETAIL.dom ? APPS_DETAIL.dom.scroll : null;
  const top = sc ? sc.scrollTop : 0;
  appsDetailPaint();
  const sc2 = APPS_DETAIL && APPS_DETAIL.dom ? APPS_DETAIL.dom.scroll : null;
  if (sc2) sc2.scrollTop = top;
}

/** 选中分支的「版本列表 + 动作」块：这是用户口径里「选择好分支后才出现」的那一半。
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
        unpublished: root.unpublished || s.unpublished,
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
/* 「ⓘ 校验」小按钮：默认只显示算法名 + 前 8 位，点开小窗看全文并可复制（长哈希不该摊在界面上）。 */
function appsHashBtnEl(label, value) {
  const v = String(value || "").trim();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mini apps-hashbtn";
  const short = v ? v.slice(0, 8) : "";
  btn.textContent = "ⓘ " + appsT(label) + (short ? " · " + short : "");
  btn.title = appsT("点开看完整校验值并可复制");
  btn.disabled = !v;
  btn.onclick = () => appsHashPopOpen(appsT(label), v);
  return btn;
}
/* 校验值小窗：全文 + 复制 + 关闭。persistent（不点外部关，只有「关闭」与 Esc）——
   它有要复制的内容，属于「有未提交输入」的浮层口径。 */
function appsHashPopOpen(title, value) {
  /* 宿主的优先级：应用中心 → document.body（上架窗等别处复用同一个实现）；
     两边都没有才退回 toast（绝不把用户挡在门外）。 */
  const host = appsHubEl() || document.body;
  if (!host) {
    appsToast(String(value || ""), "warn");
    return;
  }
  const old = host.querySelector(".apps-hashpop");
  if (old) old.remove();
  const box = document.createElement("div");
  box.className = "apps-modal apps-hashpop";
  const inner = document.createElement("div");
  inner.className = "apps-modal-box apps-hashpop-box";
  const h = document.createElement("div");
  h.className = "apps-hashpop-t";
  h.textContent = String(title || "");
  const ta = document.createElement("textarea");
  ta.className = "apps-hashpop-v";
  ta.readOnly = true;
  ta.rows = 3;
  ta.value = String(value || "");
  const foot = document.createElement("div");
  foot.className = "apps-modal-foot";
  const copy = appsMiniBtn(appsT("复制"), () => {
    try {
      ta.select();
      const ok = document.execCommand("copy");
      appsToast(ok ? appsT("已复制校验值") : appsT("复制失败：请手动选中复制"), ok ? "ok" : "warn");
    } catch (_) {
      appsToast(appsT("复制失败：请手动选中复制"), "warn");
    }
  }, true);
  const close = appsMiniBtn(appsT("关闭"), () => box.remove());
  foot.appendChild(copy);
  foot.appendChild(close);
  inner.appendChild(h);
  inner.appendChild(ta);
  inner.appendChild(foot);
  box.appendChild(inner);
  box.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      box.remove();
    }
  });
  host.appendChild(box);
  try {
    ta.focus();
    ta.select();
  } catch (_) {}
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
    vv.appendChild(appsHashBtnEl(hash.label || "校验 sha256", hash.value));
    row.appendChild(kk);
    row.appendChild(vv);
    table.appendChild(row);
  }
  d.appendChild(table);
  return d;
}

/* ─────────── 作者视角的线上条目：mine / unpublished / 版本树（docs/apps-market.md §七） ───────────
 * 公开目录（静态 catalog.json）只带已发布的条目，作者也看不出哪条是自己的、哪条被自己下架了。
 * 所以登录后额外拉一次接口（owner = 自己 + includeUnpublished=1），成功就把结果缓存起来；
 * 拉不到（没登录 / 断网 / 服务端没这个参数）就**静静跳过** —— 公开目录照常显示，绝不因此报错。 */
async function appsMineLoad(force) {
  if (!force && APPS_ST.mine && Date.now() - APPS_ST.mineAt < APPS_CAT_TTL) return APPS_ST.mine;
  const api = window.api || {};
  const me = appsAuthUser();
  if (!me || typeof api.storeRequest !== "function") {
    APPS_ST.mine = null;
    return null;
  }
  let r = null;
  try {
    r = await api.storeRequest({
      method: "GET",
      path: "/api/apps?owner=" + encodeURIComponent(me) + "&includeUnpublished=1&pageSize=50",
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
/* 目录条目 × 我的线上条目：mine / unpublished / 版本树以接口那份为准（更新更全） */
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
/** 单个应用的打赏汇总：接口那一份优先，缺失时用目录条目自带的 tips（老目录 / 接口没答上也聊胜于无）。 */
function appsTipsOf(spec) {
  const id = appsBranchIdOf(spec);
  const cached = id && APPS_ST.tips && APPS_ST.tips.byId ? APPS_ST.tips.byId[id] : null;
  if (cached) return cached;
  const t = spec && spec.tips;
  if (t && (Number(t.count) || Number(t.totalYuan))) return { count: Number(t.count) || 0, totalYuan: Number(t.totalYuan) || 0 };
  return null;
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
    unpublished: mine.unpublished === true,
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
  return Object.assign({}, spec, { urls: urls });
}
/* 只在我这儿存在、公开目录看不到的条目（已下架）：从接口回执拼一份与目录条目同形的 spec，
   这样作者仍能在应用页看到它、把它重新发布 —— 否则一下架就彻底失联。 */
function appsSpecFromMine(item) {
  const id = String((item && item.id) || "");
  if (!id) return null;
  const local = appsLocalById(id);
  const title = String((item && item.title) || id);
  /* 下架条目只存在于接口回执里：字段照目录条目同形拼，再按接口口径把图标补成接口 URL */
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
    /* 作者显示名（昵称）：接口条目自带；下架条目也照目录条目同形带上 */
    ownerName: String((item && item.ownerName) || ""),
    ownerId: String((item && item.ownerId) || (item && item.ownerUser && item.ownerUser.id) || ""),
    forkOf: appsNormForkOf(item && item.forkOf),
    versions: Array.isArray(item && item.versions) ? item.versions : [],
    mine: true,
    unpublished: (item && item.unpublished) === true,
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

/* 下架 / 重新发布（§七，仅作者）：服务端保留记录与所有版本的包，只是不进公开目录 ——
   下架后作者仍能在应用页看到自己的条目（appsSpecFromMine），点「重新发布」回来。 */
async function appsSetPublished(spec, publish) {
  const api = window.api || {};
  const id = String((spec && spec.id) || "");
  if (!id || typeof api.storeRequest !== "function") return;
  if (APPS_ST.busy[id]) return;
  APPS_ST.busy[id] = true;
  appsPaintCardState(id);
  let r = null;
  try {
    r = await api.storeRequest({ method: "POST", path: "/api/apps/" + encodeURIComponent(id) + (publish ? "/publish" : "/unpublish") });
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  APPS_ST.busy[id] = false;
  if (!r || r.ok === false) {
    appsToast((publish ? appsT("重新发布失败：") : appsT("下架失败：")) + appsErrText(r), "err");
    appsPaintCardState(id);
    return;
  }
  appsToast(publish ? appsT("已重新发布，其他用户可再次看到这个应用") : appsT("已下架：目录里不再显示，包与版本仍在云端"), "ok");
  await appsMineLoad(true);
  await appsCatalogLoad(true);
  appsHubPaint();
}

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
    const root = APPS_ST.root || {};
    const path = String(root.path || "");
    foot.innerHTML =
      '<div class="apps-hub-footline" title="' + appsEscape(path) + '">' +
      appsEscape(appsT("应用根目录")) +
      "：" +
      (path ? appsEscape(path) : appsEscape(appsT("未设置"))) +
      "</div>" +
      '<div class="apps-hub-footline apps-hub-footdim">' +
      appsEscape(appsT("已下载 ") + appsLocalList().length + appsT(" 个应用")) +
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
  return row;
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

/* 标签筛选条的显隐（唯一判定处）：**开发页不显示标签**（本轮需求），其余页照旧
   —— 仍有标签可筛才露脸（appsTagCatalog 为空时条上什么都没有，留着只是白占一行），
   已选中的标签一定还在条上（appsTagShown 的规矩），所以「有选中但目录空」也照样显示。
   重绘（appsHubTopbar）与换页（appsHubNav）都调它：切到开发页立刻收起，切回来立刻还原。 */
function appsHubTagsHidden() {
  const bar = document.querySelector(".apps-hub-topbar");
  const row = bar ? bar.querySelector(".apps-hub-tags") : null;
  if (!row) return;
  row.hidden = APPS_ST.nav === "dev" || !appsTagCatalog().length;
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
    back.title = appsT("返回 MTNode 界面（Esc 同效）");
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
    search.placeholder = appsT(name === "apps" ? "搜索应用…" : "搜索…");
    search.hidden = name !== "apps";
    if (document.activeElement !== search && search.value !== APPS_ST.q) search.value = APPS_ST.q;
  }
  /* 标签筛选条只在「应用」/「库」两页出现：**开发页不显示标签**（本轮需求）——
     那一页整屏交给三栏开发视图（左应用 / 中预览 / 右会话），标签筛选对它没有意义，
     挂着只会白占一行。判定只有 appsHubTagsHidden() 一处：切走再切回来时
     条上的标签照旧（选中态与热度排序都不动，只有 hidden 在变）。 */
  appsHubTagsHidden();
  const back = bar.querySelector(".apps-hub-close");
  if (back) {
    back.title = appsT("返回 MTNode 界面（Esc 同效）");
    back.textContent = appsT("返回 MTNode");
  }
  return bar;
}

/* 整页重绘：先画壳（左导航 / 按钮），再交给当前页填正文 */
function appsHubPaint() {
  const host = appsHubEl();
  if (!host) return;
  APPS_LANG = window.I18n && I18n.getLocale ? I18n.getLocale() : "";
  const seq = ++APPS_ST.seq;
  appsHubPaintNav(host);
  /* 开发页三栏宽度与把手由 appsDevPagePaint / appsDevBindCols 负责（本页重绘只换正文，
     左导航是固定 176px、没有把手） */
  /* 正文顶部两行（第 1 行搜索框 / 右上角「返回 MTNode」、第 2 行标签条）是壳的一部分：
     每次重绘只更新页名与标签条，**不重建搜索框** —— 它就是「输入一个字就失焦」的解法本身。 */
  appsHubTopbar(host);
  const body = host.querySelector(".apps-hub-body");
  /* 开发页（renderer/app-apps-dev.js）借用了会话视图的正文与输入框 DOM：整页重绘前先
     让它把借走的节点按原顺序还回 .agent-body，否则旧容器被丢弃后它们就成了孤儿。 */
  if (typeof appsDevPageUnmount === "function") appsDevPageUnmount();
  body.innerHTML = "";
  if (APPS_ST.nav === "apps") appsPaintAppsPage(body, seq);
  else if (APPS_ST.nav === "lib") appsPaintLibPage(body, seq);
  else appsPaintDevPage(body, seq);
}

async function appsHubRefresh(opts) {
  const o = opts || {};
  APPS_ST.cat = o.force ? null : APPS_ST.cat;
  APPS_ST.list = null;
  /* 手动刷新（force）= 用户明确要求「给我最新的」：打赏汇总也一并作废重拉，
     否则刚打赏完的数字会被新鲜期挡住（见 APPS_TIPS_TTL）。 */
  if (o.force) appsTipsReset();
  await Promise.all([appsCatalogLoad(!!o.force), appsListLoad(true), appsRootLoad()]);
  if (o.force) {
    const src = APPS_ST.cat && APPS_ST.cat.source;
    appsToast(
      src === "remote" || src === "api"
        ? appsT("目录已更新")
        : appsT("云端目录暂时拉不到：显示的是本机缓存"),
      src === "remote" || src === "api" ? "ok" : "warn",
    );
  }
  appsHubPaint();
}

function appsHubNav(id) {
  const next = APPS_NAV.some((n) => n[0] === id) ? id : "apps";
  if (next === APPS_ST.nav) {
    /* 同一页再点一次：把开着的那只详情对话窗收掉（不切页） */
    closeAppsDetail();
    appsHubPaint();
    return;
  }
  APPS_ST.nav = next;
  /* 切页 = 上下文整块换掉：详情窗跟着收（它讲的是上一页那个应用） */
  closeAppsDetail();
  /* 换页立刻同步标签条显隐（开发页不显示标签；它挂在壳上、不在被重绘的正文里） */
  appsHubTagsHidden();
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

/* ───────────────── 下载 / 更新（含根目录引导与冲突三态） ───────────────── */

/* 下载前先确保有应用根目录：没设过就弹系统选目录框并持久化（config.json 的 apps.installDir） */
async function appsEnsureRoot() {
  const api = window.api || {};
  if (typeof api.appsInstall !== "function") {
    appsBridgeMissing();
    return false;
  }
  const cur = await appsRootLoad();
  if (cur && cur.configured) return true;
  if (typeof api.appsRootPick !== "function") {
    appsToast(appsT("请先在设置里指定应用根目录"), "warn");
    return false;
  }
  let picked = null;
  try {
    picked = await api.appsRootPick();
  } catch (e) {
    appsToast(appsT("选择应用根目录失败：") + ((e && e.message) || e), "err");
    return false;
  }
  if (!picked || picked.canceled || picked.ok === false) {
    appsToast(appsT("还没指定应用根目录：下载前要先选一个文件夹"), "warn");
    return false;
  }
  APPS_ST.root = { ok: true, path: picked.path, configured: true, exists: !!picked.exists };
  appsToast(appsT("应用根目录已设置：") + picked.path, "ok");
  return true;
}

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
  if (!(await appsEnsureRoot())) return;
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
  const ok = await new Promise((resolve) => {
    if (typeof confirmDialog !== "function") {
      resolve(true);
      return;
    }
    confirmDialog(
      appsT("确定卸载「") +
        name +
        appsT("」？只删除它的应用子文件夹（") +
        String(app.dir || "") +
        appsT("）；画布、会话、该应用的存储与其它用户内容一概不动。"),
      { title: appsT("卸载应用"), okText: appsT("卸载"), danger: true },
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
    r = await api.appsUninstall(id);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) {
    appsToast(appsT("卸载失败：") + appsErrText(r), "err");
    return;
  }
  appsToast(
    appsT("已卸载：") + name + (r.trashed ? appsT("（已放进回收站）") : "") + (binding.bound ? appsT("｜注意：它当前绑定着开发节点") : ""),
    "ok",
  );
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
/* 悬停 / 进度态：只重画那一张卡的动作区（保住滚动位置与已输入的搜索词） */
function appsPaintCardState(id) {
  const host = appsHubEl();
  if (!host) return;
  host.querySelectorAll('[data-app-id="' + id + '"]').forEach((card) => {
    const acts = card.querySelector(".apps-tile-acts");
    if (!acts) return;
    const isLocal = !!card.dataset.local;
    acts.innerHTML = "";
    if (isLocal) {
      const app = appsLocalById(id);
      appsFillLocalActions(acts, app || { id: id });
    } else {
      const spec = appsSpecById(id);
      appsFillCatalogActions(acts, spec || { id: id });
    }
    appsPaintProgress(id);
  });
}

/* ───────────────── 应用页（云端目录） ───────────────── */

/* 卡片动作行（本轮需求重排）：
 *   未装   → 「下载」：**先开详情界面**（分支树默认选中原作者 + 其最新版），在详情里下载；
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
      : appsT("先在详情里选分支与版本（默认原作者最新版），确认后再装到本机");
    acts.appendChild(dl);
  } else {
    /* 已装 = 启动（与库页 / 开发页同一个入口：appsOpenApp → 独立窗口） */
    acts.appendChild(appsRunBtnEl(id, appsT("启动"), () => appsOpenApp(id)));
    const up = appsCardUpdateTargetOf(spec);
    if (up) {
      const btn = appsMiniBtn(
        appsT("更新到 v") + up.version,
        () => appsCatalogUpdate(spec, up.ownerId, up.version),
      );
      btn.disabled = busy;
      btn.title = appsT("更新到本机已装那一支的作者最新版");
      acts.appendChild(btn);
    }
    if (appsHasOtherVersions(spec)) {
      const btn = appsMiniBtn(appsT("其他版本"), () => appsOpenDetailForPick(id));
      btn.disabled = busy;
      btn.title = appsT("打开详情：可选别的作者分支或别的版本（本机已装的那一支会被替换，数据保留）");
      acts.appendChild(btn);
    }
  }
  /* 「详细」不再占动作行（它已换成卡片第一行右端的 ⓘ，见 appsAppsIconRow + appsDetailBtnEl）。
     打赏 + 评论（仅上架到云端的应用，见 appsCloudTarget）：与工坊条目同一形态 ——
     打赏窗（含名单）/ 评论窗由 app-tips.js 与 app-comments.js 提供，本模块只放入口；
     打赏入口已移到卡片第一行右端（金币 icon），动作行里只留「评论」。 */
  if (spec.installed && window.MtComments) {
    const cloudTarget = appsCloudTarget(spec);
    if (cloudTarget) {
      acts.appendChild(
        appsMiniBtn(appsT("评论"), () => window.MtComments.open(cloudTarget, { title: appsSpecTitle(spec) })),
      );
    }
  }
  /* 作者自己的条目（§七）：下架 / 重新发布。看不懂「作者」这两个字的人不会被这条按钮影响 ——
     只有登录且 owner 是自己时才出现。 */
  if (spec.mine) {
    const pub = appsMiniBtn(spec.unpublished ? appsT("重新发布") : appsT("下架"), () =>
      appsSetPublished(spec, !!spec.unpublished),
    );
    pub.disabled = busy;
    pub.title = spec.unpublished
      ? appsT("重新发布：其他用户又能看到并下载这个应用")
      : appsT("下架：目录里不再显示，包与版本仍留在云端（可随时重新发布）");
    acts.appendChild(pub);
  }
}

/** 「更新」按钮的目标：**本机已装那一支的作者**的最新版（本机没装 / 已是最新 → null）。
 *  用户口径：更新按钮指向本机已装那一支的作者最新版，不跟着「谁版本号最高」乱跑。 */
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
  if (!latest || !cur || appsVerCmp(latest, cur) <= 0) return null;
  return { ownerId: String(mine.ownerId || ""), version: latest };
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

/** 「下载 / 其他版本」的落点：打开详情界面并把分支树定位到**原作者 + 其最新版**（用户口径）。
 *  详情里的分支树本身就是「选好分支后再出现下载 / 覆盖」的那个界面，所以这里只负责开窗与默认选中。 */
function appsOpenDetailForPick(id) {
  const sid = String(id || "");
  if (!sid) return;
  APPS_DETAIL.branchOwnerId = "";
  if (typeof window.openAppsDetail === "function") window.openAppsDetail(sid);
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

function appsTileEl(spec) {
  const id = spec.id;
  const name = appsSpecTitle(spec) || id;
  const card = document.createElement("div");
  card.className = "apps-tile";
  card.dataset.appId = id;

  const cover = document.createElement("div");
  cover.className = "apps-tile-cover";
  cover.appendChild(appsIconEl(spec, name));

  const info = document.createElement("div");
  info.className = "apps-tile-info";
  const h = document.createElement("div");
  h.className = "apps-tile-title";
  /* 标题单独一层 span：第一行是 flex（标题 + 右端两枚图标按钮），标题要自己截断 ——
     文字节点直接挂在 flex 容器里不会出省略号（见 css/apps.css 的 .apps-tile-name）。 */
  const hTxt = document.createElement("span");
  hTxt.className = "apps-tile-name";
  hTxt.textContent = name;
  hTxt.title = name;
  h.appendChild(hTxt);
  /* 作者（本轮口径）：**原作者**（家族根条目那条的作者）+ 本机已装的那一版是谁做的。
     不再写版本号、不再写「命中分支」（用户口径：只显示原作者与当前版本作者；
     版本与分支数都交给详情里的分支树）。 */
  const fam = appsFamilyEntriesOf(spec);
  const rootSpec = appsFamilyRootOf(spec) || spec;
  const author = appsAuthorOf(rootSpec) || appsAuthorOf(spec);
  const localApp = appsLocalById(id) || null;
  const localAuthor = localApp ? appsInstalledAuthorOf(spec, localApp) : "";
  const who = document.createElement("div");
  who.className = "apps-tile-author";
  who.textContent = author
    ? appsT("原作者 ") + author + (localAuthor && localAuthor !== author ? appsT(" · 当前版本作者 ") + localAuthor : "")
    : "";
  who.hidden = !who.textContent;
  const desc = document.createElement("div");
  desc.className = "apps-tile-desc";
  desc.textContent = appsSpecDesc(spec) || appsT("（这个应用还没写描述）");
  info.appendChild(h);
  info.appendChild(who);
  info.appendChild(desc);
  const badges = document.createElement("div");
  badges.className = "apps-tile-badges";
  for (const [label, kind] of appsCatalogBadges(spec)) {
    const b = document.createElement("span");
    b.className = "apps-badge apps-badge-" + kind;
    b.textContent = label;
    badges.appendChild(b);
  }
  info.appendChild(badges);
  /* 卡片第一行右端的两枚图标按钮（需求口径：打赏只留一枚金币 icon 放右上方，「详细」换成 ⓘ）：
     挂进 .apps-tile-info 的标题行（与图标 / 标题同一视觉行），不再占下面的动作行。
     金币与 ⓘ 同一套小方框样式（.apps-ico-btn），悬停才展开汇总文案与用途 —— 见 appsAppsIconRow。 */
  const iconRow = appsAppsIconRow(spec);
  if (iconRow) h.appendChild(iconRow);

  const acts = document.createElement("div");
  acts.className = "apps-tile-acts";
  appsFillCatalogActions(acts, spec);

  const prog = document.createElement("div");
  prog.className = "apps-prog";
  prog.hidden = true;
  prog.innerHTML = "<i></i>";
  const progTxt = document.createElement("div");
  progTxt.className = "apps-prog-txt";
  progTxt.hidden = true;

  card.appendChild(cover);
  card.appendChild(info);
  card.appendChild(acts);
  card.appendChild(prog);
  card.appendChild(progTxt);

  /* 详情不再内联进卡片：走「详情」按钮单开对话窗（window.openAppsDetail） */
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

/* 详情块：把目录条目里能给人看的字段摊开（没有的字段不占位、不编造）。
   分两层：给用户看的（说明 / 版本树 / 作者 / 标签）+ 默认折叠的「开发者信息」
   （应用 id、来源作者 uid、入口页、需要版本、下载地址、窗口尺寸、本机目录、校验值小按钮）——
   校验值这类长哈希对普通用户没有意义，只留一个「ⓘ」小按钮，点开才看全文、可复制。
   云端条目另有「评论」页签（共用 app-comments.js 的评论区）。 */
function appsDetailEl(spec, extra) {
  if (!window.MtComments) return appsDetailBodyEl(spec, extra);
  const cloud = appsCloudTarget(spec);
  if (!cloud) return appsDetailBodyEl(spec, extra);
  const tabs = detailTabsEl([appsT("应用"), appsT("评论")], (i) => {
    if (i === 1) mountComments();
  });
  tabs.panes[0].appendChild(appsDetailBodyEl(spec, extra));
  let mounted = false;
  function mountComments() {
    if (mounted) return;
    mounted = true;
    window.MtComments.mount(tabs.panes[1], cloud, { title: appsSpecTitle(spec) || "" });
  }
  return tabs.box;
}

function appsDetailBodyEl(spec, extra) {
  const local = (extra && extra.app) || appsLocalById(spec.id);
  /* 云端版本表（多版本条目）默认画在这里；详情对话窗里由窗口自己排（本机版本块在前），
     所以那条路径传 noVers:true 免得同一份版本表画两遍 */
  const noVers = !!(extra && extra.noVers);
  const box = document.createElement("div");
  box.className = "apps-detail";
  const rows = [];
  const push = (k, v) => {
    if (v == null || v === "") return;
    rows.push([k, String(v)]);
  };
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
  /* 多版本（§七）：只有一版时不画（详情里那行「版本」已经够了）。
     对话窗里不在这里画（noVers）—— 窗把「本机版本」块排在前、云端版本表排在后，只画一次。 */
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
  box.appendChild(table);
  /* 打赏入口 + 公开累计总额（**人人可见**）：排在正文**下方**（需求口径：放在下方而不是左上角），
     入口是橙色 outlined、中间透明；打赏人名单仍仅作者本人与管理员可见（见 app-tips.js）。
     没人打赏过时保留一句可点的引导（alwaysShow），不让这一块凭空消失。 */
  const tipTarget = appsCloudTarget(spec);
  if (tipTarget && window.MtTips) {
    const bar = document.createElement("div");
    bar.className = "apps-detail-tipbar";
    const meta = window.MtTips.metaEl(tipTarget, spec.tips, {
      alwaysShow: true,
      clickable: true,
      onDone: () => appsDetailRefresh(),
    });
    if (meta) bar.appendChild(meta);
    bar.appendChild(
      window.MtTips.buttonEl(tipTarget, spec.tips, { outline: true, onDone: () => appsDetailRefresh() }),
    );
    box.appendChild(bar);
  }
  /* 开发者信息（默认折叠）：技术字段 + 校验值小按钮 */
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
  box.appendChild(
    appsDevMetaEl(devRows, { label: "安装包 sha256", value: spec.sha256 || (local && local.sha256) || "" }),
  );
  return box;
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
  body.innerHTML = "";
  /* 搜索框与标签条不在正文里（壳的顶部一行，见 appsHubTopbar）：这里只更新它的页名与标签条 */
  appsHubTopbar();
  const cat = APPS_ST.cat || {};
  /* 目录条目 × 我的线上条目（mine / unpublished / 更全的版本树） */
  const list = appsSpecListAll();
  const shown = appsFilterSpecs(list);
  /* 打赏汇总：列表**载入 / 刷新**就问一次（悬停时不问网络，见 appsTipsEnsure 的注释）。
     同一批 id 只问一次，回来重绘一次 —— 卡片的金币 icon 悬停文案随即带上真实数字。 */
  appsTipsEnsure(list, false);
  const hint = document.createElement("div");
  hint.className = "apps-hint";
  hint.textContent =
    cat.source === "remote"
      ? appsT("云端目录已更新（") + appsTime(cat.fetchedAt) + "）"
      : cat.source === "api"
        ? appsT("云端接口目录（静态目录暂时不可用，已自动切换；") + appsTime(cat.fetchedAt) + "）"
        : cat.source === "cache"
          ? appsT("云端目录暂时拉不到，显示的是本机缓存（") + appsTime(cat.fetchedAt) + "）"
          : appsT("云端目录为空或还没发布：可以先看看「库」里已下载的应用");
  if (cat.remoteError) hint.title = appsT("云端返回：") + String(cat.remoteError);
  body.appendChild(hint);
  /* 有筛选时给一行摘要（含「清除筛选」）：用户一眼看出列表为什么短了、怎么回到全量 */
  const fline = appsFilterLineEl(list.length, shown.length);
  if (fline) body.appendChild(fline);

  /* 目录全空也一样要往下走：作者自己那些「已下架」的条目是唯一还在这个列表里的东西，
     在这里 return 会让他看不到自己的应用、也就无从重新发布 */
  if (!appsCatalogList().length && !shown.length) {
    const empty = document.createElement("div");
    empty.className = "apps-empty";
    empty.textContent =
      cat.source === "empty"
        ? appsT("云端目录里还没有应用：稍后重新进入本页会自动再拉一次。")
        : appsT("拿不到应用目录：请检查网络，稍后重新进入本页再试。");
    body.appendChild(empty);
    return;
  }
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "apps-empty";
    empty.textContent = appsNoMatchText();
    body.appendChild(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "apps-grid";
  for (const spec of shown) grid.appendChild(appsTileEl(spec));
  body.appendChild(grid);
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

function appsFillLocalActions(acts, app) {
  const id = String(app.id || "");
  const busy = !!APPS_ST.busy[id];
  /* 同 id 多分支（§十）：库页这一份装的是哪一支，就拿那一支的条目比版本 / 更新 */
  const spec =
    appsSpecOfBranch(id, String((app && (app.ownerId || app.owner)) || "")) || appsSpecById(id);
  acts.appendChild(appsRunBtnEl(id, appsT("运行"), () => appsOpenApp(id)));
  acts.appendChild(appsDetailBtnEl(id));
  /* 更新只在**同一支作者**时出现（与「应用」页同一口径）：更新按钮指向本机已装那一支的作者最新版，
     作者对不上说明这是别人的同 id 条目，更新会拿别人的包盖掉本机这一份 —— 那种情况该走「其他版本」。 */
  const upTarget = spec ? appsCardUpdateTargetOf(spec) : null;
  if (upTarget) {
    const up = appsMiniBtn(
      appsT("更新到 v") + upTarget.version,
      () => appsDownload(id, "update", upTarget.version, upTarget.ownerId),
    );
    up.disabled = busy;
    acts.appendChild(up);
  }
  /* 数据目录（用 app id 管理，默认 <数据目录>/apps-data/<id>/）：不在库里单占一行，
     每张卡片右侧一颗 📂 就地打开；路径只由主进程解析。 */
  const dirBtn = appsMiniBtn("📂", () => appsDataOpenNow(id));
  dirBtn.title = appsT("打开这个应用的数据目录（默认在 MTNode 数据目录下按应用 id 建）");
  dirBtn.disabled = busy;
  acts.appendChild(dirBtn);
  /* 「二次开发」：登记为开发中 + 建同名画布与开发节点（原「二次开发」，动作不变、入口移到卡片右侧） */
  acts.appendChild(appsSecondaryDevBtnEl(app));
  const un = appsMiniBtn(appsT("卸载"), () => appsUninstallApp(appsLocalById(id) || app));
  un.classList.add("danger");
  un.disabled = busy;
  un.title = appsT("卸载只删该应用自己的子文件夹，画布 / 会话 / 其它用户内容不动");
  acts.appendChild(un);
}

function appsLocalRowEl(app) {
  const id = String(app.id || "");
  const spec = appsSpecById(id);
  const name = String(app.name || id);
  const row = document.createElement("div");
  row.className = "apps-row";
  row.dataset.appId = id;
  row.dataset.local = "1";

  const cover = document.createElement("div");
  cover.className = "apps-row-cover";
  cover.appendChild(appsIconEl(spec || {}, name));

  const info = document.createElement("div");
  info.className = "apps-row-info";
  const h = document.createElement("div");
  h.className = "apps-row-title";
  h.textContent = name;
  const meta = document.createElement("div");
  meta.className = "apps-row-meta";
  /* 作者放最前（连标题一起读）：来源作者（安装账本）→ app.json 的作者 → 当前登录账号 */
  const rowAuthor = appsAuthorOf(app);
  meta.textContent =
    (rowAuthor ? appsT("作者 ") + rowAuthor + " · " : "") +
    appsT("版本 ") +
    String(app.version || "0.0.0") +
    " · " +
    appsBytes(app.bytes) +
    " · " +
    String(app.files || 0) +
    appsT(" 个文件") +
    (app.installedAt || app.mtimeMs ? " · " + appsTime(app.installedAt || app.mtimeMs) : "");
  const path = document.createElement("div");
  path.className = "apps-row-path";
  path.textContent = String(app.dir || "");
  path.title = String(app.dir || "");

  /* 数据目录不再占库页一行（本轮需求）：入口是卡片右侧那颗 📂（appsFillLocalActions）。
     「开发绑定」徽标已去掉：开发中的应用不再列在库页，这枚徽标在这里只剩常态「未绑定」；
     绑定情况改在开发页顶栏显示（见 renderer/app-apps-dev.js）。 */
  const badges = document.createElement("div");
  badges.className = "apps-row-badges";
  /* 能力小标（app.json 的 capabilities）：库页一眼看得出这个应用带不带语音 / 出图 */
  for (const label of Array.isArray(app.capabilityBadges) ? app.capabilityBadges : []) {
    const bCap = document.createElement("span");
    bCap.className = "apps-badge apps-badge-cap";
    bCap.textContent = String(label || "");
    bCap.title = appsT("这个应用声明的能力（在开发页「应用能力…」里改）");
    badges.appendChild(bCap);
  }
  if (app.canvasExists) {
    const bCanvas = document.createElement("span");
    bCanvas.className = "apps-badge apps-badge-off";
    bCanvas.textContent = appsT("有专属画布");
    bCanvas.title = appsT("这个应用目录里存着自己的一张画布（") + String(app.canvas || "") + appsT("）；卸载不会动它");
    badges.appendChild(bCanvas);
  }
  if (spec && spec.updateAvailable) {
    const bUp = document.createElement("span");
    bUp.className = "apps-badge apps-badge-upd";
    bUp.textContent = appsT("可更新：云端 v") + String(spec.version || "");
    badges.appendChild(bUp);
  }
  if (app.broken) {
    const bBad = document.createElement("span");
    bBad.className = "apps-badge apps-badge-bad";
    bBad.textContent = appsT("清单损坏");
    bBad.title = appsT("这个目录里没有可读的 app.json（可能是手改坏了）：删掉重装即可恢复");
    badges.appendChild(bBad);
  }
  info.appendChild(h);
  info.appendChild(meta);
  info.appendChild(path);
  info.appendChild(badges);

  const acts = document.createElement("div");
  acts.className = "apps-row-acts apps-tile-acts";
  appsFillLocalActions(acts, app);

  const prog = document.createElement("div");
  prog.className = "apps-prog";
  prog.hidden = true;
  prog.innerHTML = "<i></i>";
  const progTxt = document.createElement("div");
  progTxt.className = "apps-prog-txt";
  progTxt.hidden = true;

  row.appendChild(cover);
  row.appendChild(info);
  row.appendChild(acts);
  row.appendChild(prog);
  row.appendChild(progTxt);
  return row;
}

/* 根目录一行（库页 / 开发页共用）：路径 + 更改… + 在资源管理器中打开 */
function appsRootLineEl() {
  const root = APPS_ST.root || {};
  const wrap = document.createElement("div");
  wrap.className = "apps-rootline";
  const label = document.createElement("span");
  label.className = "apps-rootline-k";
  label.textContent = appsT("应用根目录");
  const val = document.createElement("span");
  val.className = "apps-rootline-v";
  val.textContent = String(root.path || "") || appsT("未设置");
  val.title = String(root.path || "");
  wrap.appendChild(label);
  wrap.appendChild(val);
  if (!root.configured) {
    const warn = document.createElement("span");
    warn.className = "apps-badge apps-badge-bad";
    warn.textContent = appsT("未设置：下载前会先让你选一个文件夹");
    wrap.appendChild(warn);
  }
  wrap.appendChild(appsMiniBtn(appsT("更改…"), appsRootPickNow));
  wrap.appendChild(appsMiniBtn("📂", appsRootFolderNow));
  return wrap;
}
/* ── 数据文件夹（每个应用一份：默认 <数据目录>/apps-data/<id>/，可让用户改成自己的文件夹）──
/* 选应用根目录（库页那行与开发页工具栏共用同一份动作，别写两遍） */
async function appsRootPickNow() {
  const api = window.api || {};
  if (typeof api.appsRootPick !== "function") {
    appsBridgeMissing();
    return;
  }
  const r = await api.appsRootPick();
  if (!r || r.canceled || r.ok === false) {
    if (r && r.ok === false) appsToast(appsT("设置失败：") + appsErrText(r), "err");
    return;
  }
  APPS_ST.root = { ok: true, path: r.path, configured: true, exists: !!r.exists };
  APPS_ST.list = r.list && r.list.ok !== false ? r.list : null;
  appsToast(appsT("应用根目录已设置：") + r.path, "ok");
  await appsListLoad(true);
  appsHubPaint();
}
/* 在资源管理器中打开应用根目录 */
function appsRootFolderNow() {
  const p = String((APPS_ST.root && APPS_ST.root.path) || "");
  if (!p) {
    appsToast(appsT("还没设置应用根目录"), "warn");
    return;
  }
  if (typeof openWorkspaceFolder === "function") openWorkspaceFolder(p);
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
  body.appendChild(appsRootLineEl());
  /* 「＋ 新建应用」入口**只留在开发页**（本轮共识）：新建出来的应用一律算「开发中」，
     库页只列已下载、还没在开发的应用。 */
  const list = appsLibList();
  const devCount = appsLocalList().length - list.length;
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
  const wrap = document.createElement("div");
  wrap.className = "apps-rows";
  for (const app of list) wrap.appendChild(appsLocalRowEl(app));
  body.appendChild(wrap);
  /* 库页不再单列「应用数据文件夹」那一条（本轮需求）：数据目录按 app id 管理，入口收进每张
     卡片右侧的 📂 按钮（appsFillLocalActions → appsDataOpenNow），点一下打开该应用的数据目录。
     改数据文件夹位置仍在应用窗口里（appHost.dataDir*），不在这里另开一条路径。 */
  /* 打开状态贴到按钮上（不阻塞首帧：先画行，再逐个对齐） */
  for (const app of list) {
    const id = String(app.id || "");
    const open = await appsIsWindowOpen(id);
    if (seq !== APPS_ST.seq || APPS_ST.nav !== "lib") return;
    const row = body.querySelector('.apps-row[data-app-id="' + id + '"]');
    if (!row) continue;
    const btn = row.querySelector(".apps-row-acts button[data-app-run]");
    if (btn && open) {
      btn.classList.add("on");
      btn.title = appsT("这个应用已经开着独立窗口（再点一次把它调到前台）");
    }
  }
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

/* ───────────────── 上架前体检（开发页工具栏那枚按钮） ───────────────── *
 * 查的是「这个应用打成包会不会缺文件」—— 线上确实发生过：打包实现只打 app.json + 入口页 +
 * assets/**，根目录里放 game.js / style.css 的应用上架后，别的账号下载到的是一个跑不起来的
 * 空壳（wordless 1.0.0 就是这样）。体检在主进程真读目录 + 真跑上架口径的打包实现
 * （apps-store.js 的 packAudit），渲染层只展示回执：不打包、不上传、不写盘。
 * 默认看当前应用，窗内可切到「全部应用」。 */
const APPS_AUDIT_T = {
  unknown: "打包实现漏了这个文件（必须修）",
  generated: "本机生成物，本来就不随包（画布 / 旧包 / 安装账本）",
  storage: "应用自己的本机存档：上架包不带它（本地导出会保留）",
  missing_entry: "应用缺少入口页（index.html）：打包会失败",
  pack_failed: "打包这一步失败了",
};
function appsAuditReasonT(r) {
  const key = String(r || "");
  return appsT(APPS_AUDIT_T[key] || "打包实现漏了这个文件（必须修）");
}
/* 体检文件清单（标题 + 条目；最多列 60 条，多的由调用方在标题里说明省略了多少） */
function appsAuditFileList(title, items) {
  const box = document.createElement("div");
  box.className = "apps-audit-files";
  const t = document.createElement("div");
  t.className = "apps-audit-files-t";
  t.textContent = title;
  box.appendChild(t);
  const ul = document.createElement("ul");
  for (const it of (items || []).slice(0, 60)) {
    const li = document.createElement("li");
    li.textContent = String(it);
    ul.appendChild(li);
  }
  box.appendChild(ul);
  return box;
}
async function appsPackAuditDialog(appId) {
  const api = window.api || {};
  if (typeof api.appsPackAudit !== "function") {
    appsBridgeMissing();
    return;
  }
  const curId = String(appId || "");
  let mode = curId ? "cur" : "all";
  openOverlay(appsT("上架前体检"), { persistent: true });
  const body = $("#ovBody");
  const lead = document.createElement("div");
  lead.className = "settings-hint apps-audit-lead";
  lead.textContent = appsT(
    "体检按上架口径真跑一遍打包：列出「目录里有、包里没有」的文件，并检查入口页引用的文件在不在（只读：不打包、不上传、不写盘）。",
  );
  body.appendChild(lead);
  const tabs = document.createElement("div");
  tabs.className = "apps-audit-tabs";
  const stat = document.createElement("div");
  stat.className = "apps-audit-stat";
  const list = document.createElement("div");
  list.className = "apps-audit-list";
  const mkTab = (key, label) => {
    const b = appsMiniBtn(label, () => {
      if (mode === key) return;
      mode = key;
      paintTabs();
      run();
    });
    b.dataset.auditTab = key;
    return b;
  };
  const tabCur = mkTab("cur", appsT("当前应用"));
  const tabAll = mkTab("all", appsT("全部应用"));
  const paintTabs = () => {
    tabCur.classList.toggle("on", mode === "cur");
    tabAll.classList.toggle("on", mode === "all");
    tabCur.disabled = !curId;
    if (!curId) tabCur.title = appsT("没有选中应用：从开发页当前应用点进来才有");
  };
  tabs.appendChild(tabCur);
  tabs.appendChild(tabAll);
  body.appendChild(tabs);
  body.appendChild(stat);
  body.appendChild(list);
  const foot = $("#ovFoot");
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = appsT("关闭");
  close.onclick = closeOverlay;
  foot.appendChild(close);
  const run = async () => {
    list.innerHTML = "";
    stat.textContent = appsT("正在体检…");
    let r = null;
    try {
      r = await api.appsPackAudit(mode === "cur" ? curId : "");
    } catch (err) {
      r = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!list.isConnected) return; /* 窗已经关了（换页 / 切画布会收掉弹窗）：结果丢掉 */
    list.innerHTML = "";
    if (!r || r.ok === false) {
      stat.textContent = appsT("体检失败：") + ((r && (r.error || r.reason)) || appsT("未知错误"));
      return;
    }
    const rows = Array.isArray(r.apps) ? r.apps : [];
    if (!rows.length) {
      stat.textContent = appsT("没有可体检的应用");
      return;
    }
    let bad = 0;
    for (const row of rows) {
      /* 只把「打包实现漏了它（unknown）」与「入口页引用了不存在的文件」算不通过；
         生成物（画布 / 旧包 / 安装账本）与本机存档（上架包本来就不带）如实列出但不判失败。
         droppedUnknown 由主进程给（它就是 ok 的判据），认不出这一位时按清单自己算一遍。 */
      const dropped = Array.isArray(row.dropped) ? row.dropped : [];
      const unknown = dropped.filter((d) => d.reason === "unknown" || !d.reason);
      const unknownCount = Number.isFinite(row.droppedUnknown) ? row.droppedUnknown : unknown.length;
      const known = dropped.filter((d) => d.reason && d.reason !== "unknown");
      const refsMissing = Array.isArray(row.refsMissing) ? row.refsMissing : [];
      const okRow = !row.missing && !row.error && unknownCount === 0 && refsMissing.length === 0;
      if (!okRow) bad++;
      const box = document.createElement("div");
      box.className = "apps-audit-row" + (okRow ? "" : " bad");
      const head = document.createElement("div");
      head.className = "apps-audit-rowhead";
      const nm = document.createElement("b");
      nm.textContent = String(row.name || row.id || "");
      const ver = document.createElement("span");
      ver.className = "apps-audit-ver";
      ver.textContent = "v" + String(row.version || "?");
      const st = document.createElement("span");
      st.className = "apps-audit-state " + (okRow ? "ok" : "bad");
      st.textContent = okRow
        ? appsT("通过：包是完整的")
        : row.missing
          ? appsT("这个应用不在本机了")
          : row.error
            ? appsT("体检失败：") + row.error
            : appsT("缺文件") + " " + unknownCount +
              (refsMissing.length ? appsT(" · 入口页缺引用") + " " + refsMissing.length : "");
      head.appendChild(nm);
      head.appendChild(ver);
      head.appendChild(st);
      box.appendChild(head);
      const cnt = document.createElement("div");
      cnt.className = "apps-audit-count";
      cnt.textContent =
        appsT("目录文件") + " " + String(row.files || 0) + " · " + appsT("包内") + " " + String(row.packed || 0);
      box.appendChild(cnt);
      if (unknown.length) {
        box.appendChild(appsAuditFileList(appsT("会随包丢掉的文件"), unknown.map((d) => d.rel)));
      }
      if (known.length) {
        const moreTxt = row.more ? appsT("（另有 ") + row.more + appsT(" 个同类文件已省略）") : "";
        box.appendChild(
          appsAuditFileList(
            appsT("本来就不随包的文件") + moreTxt,
            known.map((d) => String(d.rel || "") + "  —— " + appsAuditReasonT(d.reason)),
          ),
        );
      }
      if (refsMissing.length) {
        box.appendChild(
          appsAuditFileList(
            appsT("入口页引用了但目录里没有"),
            refsMissing.map((x) => String(x.rel || "") + appsT("（入口页写的是：") + String(x.ref || "") + appsT("）")),
          ),
        );
      }
      list.appendChild(box);
    }
    stat.textContent = bad
      ? appsT("体检完成：") + bad + appsT(" 个应用有问题（下面标红的几条）")
      : appsT("体检完成：") + rows.length + appsT(" 个应用都能打出完整的包");
  };
  paintTabs();
  run();
}
window.appsPackAuditDialog = appsPackAuditDialog;

/* ───────────────── 应用详情对话窗（单开一只浮层；不再内联进卡片） ─────────────────
 * 需求口径：应用的详情**单开一个 dialogue**，避免内容挤兑 —— 卡片列窄，版本表 / 详情行 /
 * 评论区塞进卡片里既挤又会被邻卡的展开挤歪，所以详情整体搬进一只可调宽高的浮层。
 * 形态：window.openAppsDetail(id)，宽身（apps-detail-box）+ 右下角手柄可拖调宽高；
 * persistent（点外部不关）+ 可最小化到状态栏 + ✕ / Esc 显式关（与 AGENTS.md 的弹窗纪律一致）。
 * 内容：说明 / 本机版本（可回滚）/ 云端版本表（全宽）/ 评论页签 / 折叠的开发者信息。
 * 入口：应用中心卡片与库页卡片共用 appsDetailBtnEl 那一颗「详情」；开发页不挂（它有自己的正文）。 */

const APPS_DETAIL = {
  id: "", /* 窗里讲的是哪个应用 */
  branchOwnerId: "", /* 同 id 多分支（§十）：窗里当前选中的那条分支（空 = 主干 / 跟着本机来源） */
  dom: Object.create(null),
  ver: null, /* apps:versions 的回执（本机台账：当前版 + 上一版） */
  verSeq: 0,
};

/* 当前窗框（#overlay 上那只；被最小化搬走后为 null） */
function appsDetailShellBox() {
  const ov = document.getElementById("overlay");
  return ov ? ov.querySelector(":scope > .overlay-box") : null;
}
/* 摘掉尺寸类（当前窗上那一只；停在 #ovPark 里的最小化窗保留原样 —— 它还要原样搬回来） */
function appsDetailBoxCleanup() {
  try {
    document.querySelectorAll("#overlay > .overlay-box.apps-detail-box").forEach((b) => {
      b.classList.remove("apps-detail-box");
    });
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
/* 窗开着就只重画窗（保住滚动位置），回 true；窗关着回 false（调用方去重绘页面） */
function appsDetailRefresh() {
  if (!APPS_DETAIL.id) return false;
  const body = document.getElementById("ovBody");
  const root = APPS_DETAIL.dom.root;
  if (!body || !root || !body.contains(root)) {
    APPS_DETAIL.id = "";
    return false;
  }
  appsDetailPaint();
  return true;
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
  const want = String((APPS_DETAIL && APPS_DETAIL.branchOwnerId) || "");
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

  const head = document.createElement("div");
  head.className = "apps-detail-head";
  APPS_DETAIL.dom.head = head;
  root.appendChild(head);

  const sc = document.createElement("div");
  sc.className = "apps-detail-scroll";
  APPS_DETAIL.dom.scroll = sc;
  root.appendChild(sc);

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
  grip.title = appsT("拖拽右下角调整窗口大小");
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

  const closeBtn = appsMiniBtn(appsT("关闭"), closeAppsDetail);
  foot.appendChild(closeBtn);
}

/* 头部：图标 + 标题 + 作者/版本/标签/二次开发来源一行（详情主体里不再重复这些） */
/* 详情窗头部（本轮需求：不显示分支 / 版本，只显示原作者 + 当前版本作者）
 * 用户口径：
 *   · 头部不再写「云端 vX / 本机 vX」，也不再挂任何 chip 徽标（开发中 / 已下载 / 可更新 /
 *     需要更新的 MTNode / 多个分支 / 我上架的 / 已下架 全部去掉）；
 *   · 只留两行作者信息：原作者（家族根那条的作者）+ 当前选中分支的作者。
 * 其余技术字段（哈希 / 路径 / 文件数）仍在正文的「开发者信息 ▾」里，不受影响。 */
function appsDetailPaintHead() {
  const id = APPS_DETAIL.id;
  const spec = appsDetailSpecOf(id);
  const app = appsDetailLocalOf(id);
  const head = APPS_DETAIL.dom.head;
  if (!head) return;
  head.innerHTML = "";
  const name = appsDetailTitleOf(id);
  const icon = document.createElement("div");
  icon.className = "apps-detail-ico";
  icon.appendChild(appsIconEl(spec || app || {}, name));
  head.appendChild(icon);

  const who = document.createElement("div");
  who.className = "apps-detail-who";
  const h = document.createElement("div");
  h.className = "apps-detail-name";
  h.textContent = name;
  who.appendChild(h);

  const fam = appsFamilyEntriesOf(spec || app || {});
  const root = appsFamilyRootOf(spec || app || {});
  const curAuthor = appsAuthorOf(spec || app || {}) || appsT("未知作者");
  const rootAuthor = (root && appsAuthorOf(root)) || curAuthor;
  const meta = document.createElement("div");
  meta.className = "apps-detail-meta";
  meta.textContent =
    appsT("原作者 ") + rootAuthor +
    (curAuthor && curAuthor !== rootAuthor ? appsT(" · 当前版本作者 ") + curAuthor : appsT(" · 当前版本作者 ") + curAuthor);
  if (fam.length > 1) {
    meta.title = appsT("这个应用共有 ") + fam.length + appsT(" 条分支（原作者在最左，其余向右逐级展开）");
  }
  who.appendChild(meta);
  head.appendChild(who);
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

/* 详情主体（本轮需求重排）：
 *   ① 分支树（家族统一、多层、根 = 原作者）—— 选择哪一支
 *   ② 选中分支之后**才**出现：这一支的版本列表 + 下载 / 覆盖 / 启动（由 appsBranchTreeEl 自己带出）
 *   ③ 说明 + 详情行（作者 / 二次开发来源 / 标签 → 收在「开发者信息 ▾」里的那些技术字段不动）
 *   ④ 打赏 / 评论（目标 = **家族根条目**，见 appsCloudTarget）
 * 去掉的旧块：「在几支之间切换」那一行（分支树已表达）、单独的云端版本表（并入选中分支区）、
 * 单独的「本机版本（可回滚）」块（回滚入口跟着选中分支走）。 */
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

  if (spec.id) box.appendChild(appsDetailBodyEl(spec, { app: app || undefined, noVers: true }));
  else {
    /* 本机自建、云端没有这一条：详情就只有本机那一份（不编造云端字段） */
    const full = document.createElement("div");
    full.className = "apps-detail-full";
    full.textContent = String((app && app.description) || "") || appsT("（这个应用还没写描述）");
    box.appendChild(full);
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
    push(appsT("版本"), app && app.version);
    push(appsT("作者"), appsAuthorOf(app || {}));
    push(appsT("本机目录"), app && app.dir);
    push(appsT("占用"), app ? appsBytes(app.bytes) + " · " + app.files + appsT(" 个文件") : "");
    box.appendChild(rowsBox);
  }
  /* 本机回滚入口：只在真能回滚时出现，且跟在选中分支的动作区后面（不再单开一块「本机版本」） */
  const roll = appsLocalRollbackEl(id);
  if (roll) box.appendChild(roll);
  return box;
}

/* 本机回滚（原「本机版本（可回滚）」块的入口形态）：只留一句说明 + 一颗按钮，
 * 没有可回滚的上一版时**整块不出现**（不编造来源）。 */
function appsLocalRollbackEl(id) {
  const v = APPS_DETAIL.ver;
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
  note.textContent = appsT("本机只留当前与上一版两份记录（不存历史包）：回到上一版要按来源重新下载一次，离线或云端已下架时会如实报错。");
  box.appendChild(note);
  return box;
}
function appsDetailPaint() {
  const id = APPS_DETAIL.id;
  if (!id) return;
  appsDetailPaintHead();
  const sc = APPS_DETAIL.dom.scroll;
  if (!sc) return;
  sc.innerHTML = "";
  const body = appsDetailBodyBox(id);
  const spec = appsDetailSpecOf(id);
  const cloud = spec ? appsCloudTarget(spec) : null;
  if (!cloud || typeof detailTabsEl !== "function") {
    sc.appendChild(body);
    return;
  }
  /* 评论页签（与工坊条目同一份组件）：详情里就能看评价，不必先关掉再点「评论」 */
  const tabs = detailTabsEl([appsT("应用"), appsT("评论")], (i) => {
    if (i === 1) mountComments();
  });
  tabs.panes[0].appendChild(body);
  let mounted = false;
  function mountComments() {
    if (mounted || !window.MtComments) return;
    mounted = true;
    window.MtComments.mount(tabs.panes[1], cloud, { title: appsDetailTitleOf(id) });
  }
  sc.appendChild(tabs.box);
  appsDetailPaintProg();
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
  const sc = APPS_DETAIL.dom.scroll;
  if (!sc) return;
  const old = sc.querySelector(".apps-detail-vers");
  const fresh = appsLocalRollbackEl(id);
  if (old && old.parentNode && fresh) old.parentNode.replaceChild(fresh, old);
  else if (old && old.parentNode) old.parentNode.removeChild(old);
  else if (fresh) sc.appendChild(fresh);
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
  APPS_DETAIL.branchOwnerId = "";
  APPS_DETAIL.ver = null;
  APPS_DETAIL.verSeq++;
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
window.appsHubRefresh = appsHubRefresh;
window.appsHubIsOpen = appsHubIsOpen;

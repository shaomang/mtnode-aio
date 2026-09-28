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
 *   · 库：本机已下载的应用（图标 / 标题 / 版本 / 大小 / 开发绑定状态），
 *     可打开（独立窗口运行）、更新（版本比较）、卸载（二次确认后**只删该应用子文件夹**）。
 *   · 开发：应用根目录、导出应用包（不含画布）、变更探测。
 *
 * 桥（preload.js 白名单，全部只转发给主进程 apps-store.js）：
 *   api.appsRootGet / appsRootSet / appsRootPick / appsList / appsCatalog /
 *   appsInstall(id, mode) / appsUninstall(id) / appsExportZip(id) / appsProbeChanges /
 *   appsOpenWindow(id) / appsCloseWindow() / appsIsOpen(id) /
 *   onAppsProgress(cb) / onAppsWindowChanged(cb)
 * 渲染层不直连网络、不拼应用目录路径、不自己做 zip / sha256 —— 那些只留主进程。
 *
 * 顶栏入口 #btnApps 只对白名单账号露出（APPS_USER_WHITELIST，可改常量）：登录态唯一来源
 * = window.MTNodeAuth.state()（统一账户模块 app-auth.js）；本文件按调用期探测订阅，
 * 未就绪 / 未登录 / 不在白名单一律隐藏；登录态变化时同步显隐（不在白名单时连页面一起收掉）。
 *
 * 对话框纪律（AGENTS.md「协作约定」）：本页 persistent —— **没有**「点外部 / 点蒙层自动收起」；
 * 关闭只走三处：侧栏第一行「返回 MTNode」、Esc、再点一次顶栏「应用」（同一开关）。开着它时点顶栏任何
 * 其它入口（画布 / 会话 / 专家团 / 设置 / 插件 / 工坊…）＝ 收掉本页（互斥回收），
 * 开页瞬间也会收掉节点级浮层与瞬态菜单（closeNodePopsExcept）。#overlay 的 z-index 比本页高，
 * 后开的对话框（设置 / 确认框）一定压在本页之上，本页不去顶掉它们。
 * ============================================================================
 */

/* ───────────────────────── 常量 ───────────────────────── */

/* 顶栏「应用」入口的用户名白名单（可改常量，小写比较）：登录用户名在这里才露出入口。
   加账号只改这一个数组；留空数组 = 谁都不露出。 */
const APPS_USER_WHITELIST = ["ms2308"];

/* 左导航（顺序即显示顺序）：[id, 标题, 副标题] */
const APPS_NAV = [
  ["apps", "应用", "浏览云端目录 · 下载到本机后用独立窗口运行"],
  ["lib", "库", "本机已下载的应用：打开 · 更新 · 卸载"],
  ["dev", "开发", "应用根目录 · 导出应用包 · 变更探测"],
];

/* 目录缓存新鲜期（毫秒）：这段时间内重开页面 / 切页不重复拉云端目录 */
const APPS_CAT_TTL = 5 * 60 * 1000;

const APPS_ST = {
  nav: "apps", /* apps | lib | dev */
  q: "", /* 应用页的搜索词 */
  cat: null, /* 云端目录响应（含 apps / source / sourceUrl / remoteError） */
  catAt: 0,
  list: null, /* 本机应用列表响应 */
  root: null, /* { path, configured, exists } */
  detailId: "", /* 应用页展开详情的应用 id */
  progress: Object.create(null), /* id -> { phase, percent, got, total, error } */
  busy: Object.create(null), /* id -> true：本机正在下载 / 安装 */
  devProbe: null, /* 开发页：最近一次变更探测结果 */
  devExport: null, /* 开发页：最近一次导出结果 */
  conflictAsk: null, /* 同名冲突框的收尾函数（Esc 走它） */
  seq: 0, /* 渲染序号：异步回来时对不上就丢弃（防切页后旧数据重绘） */
};

let APPS_HUB_OPEN = false;
let APPS_LANG = "";
let APPS_AUTH_OFF = null;
let APPS_PROG_OFF = null;

/* ───────────────────────── 小工具 ───────────────────────── */

function appsHubEl() {
  return document.getElementById("appsHub");
}
function appsHubIsOpen() {
  return !!APPS_HUB_OPEN;
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

/* ───────────────── 登录态白名单 → 顶栏入口显隐 ───────────────── */

/* 登录态快照：window.MTNodeAuth.state()（{ signedIn, user }）；模块未就绪 = 未登录。 */
function appsAuthUser() {
  const A = window.MTNodeAuth;
  if (!A || typeof A.state !== "function") return null;
  const st = A.state() || {};
  return st.signedIn && st.user ? st.user : null;
}
function appsEntryAllowed() {
  const u = appsAuthUser();
  const name = String((u && u.username) || "").trim().toLowerCase();
  return !!name && APPS_USER_WHITELIST.indexOf(name) >= 0;
}
/* 同步顶栏入口显隐；掉出白名单（退出登录 / 换账号）时把页面一并收掉 */
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
  });
  return true;
}

/* ───────────────── 图标（云端目录声明 → 可显示的 URL） ───────────────── */

/* 目录地址去掉文件名 = feed 基址（catalog 响应带 sourceUrl，渲染层不硬编码域名） */
function appsFeedBase() {
  const src = String((APPS_ST.cat && APPS_ST.cat.sourceUrl) || "").trim();
  if (!src) return "";
  return src.replace(/\/[^/]*$/, "");
}
function appsIconUrl(spec) {
  const raw = String((spec && spec.icon) || "").trim();
  if (!raw) return "";
  if (/^data:image\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = appsFeedBase();
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
function appsLocalList() {
  return (APPS_ST.list && Array.isArray(APPS_ST.list.apps) ? APPS_ST.list.apps : []).slice();
}
function appsSpecById(id) {
  return appsCatalogList().find((a) => a && a.id === id) || null;
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
  /* 没有标题栏：左侧导航第一行就是「应用」品牌 + 「返回 MTNode」（顶部只保留这一个
     回到 MTNode 界面的出口，按钮写全名而不是一个 ✕），页名与副标题不再各占一行重复一遍。 */
  host.innerHTML =
    '<aside class="apps-hub-side">' +
    '<div class="apps-hub-sidehead">' +
    '<div class="apps-hub-brand"></div>' +
    '<button type="button" class="mini apps-hub-close">' +
    appsEscape(appsT("返回 MTNode")) +
    "</button>" +
    "</div>" +
    '<nav class="apps-hub-nav" role="tablist"></nav>' +
    '<div class="apps-hub-sidefoot"></div>' +
    "</aside>" +
    '<section class="apps-hub-main">' +
    '<div class="apps-hub-body"></div>' +
    "</section>";
  /* 挂 document.body：position:fixed inset:0 → 连顶栏（菜单栏）也一起盖住（顶栏与应用开发
     无关，进来就整屏交给应用开发），#overlay（z-index 100）仍然压在本页之上。 */
  document.body.appendChild(host);

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

/* 搜索框原先在标题栏上，标题栏去掉后改由这里插进正文顶部（只有应用页需要搜索）。
   「刷新」按钮已去掉：目录在本页打开与每次下载结束时都会自动重拉，手动刷新没必要，
   这条也就只剩搜索一个零件、不再独占一行。 */
function appsHubSearchRow() {
  const row = document.createElement("div");
  row.className = "apps-hub-headacts";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "apps-hub-search";
  search.hidden = APPS_ST.nav !== "apps";
  search.placeholder = appsT("搜索应用…");
  if (search.value !== APPS_ST.q) search.value = APPS_ST.q;
  search.addEventListener("input", () => {
    APPS_ST.q = search.value;
    appsHubPaint();
  });
  row.appendChild(search);
  return row;
}

/* 整页重绘：先画壳（左导航 / 按钮），再交给当前页填正文 */
function appsHubPaint() {
  const host = appsHubEl();
  if (!host) return;
  APPS_LANG = window.I18n && I18n.getLocale ? I18n.getLocale() : "";
  const seq = ++APPS_ST.seq;
  appsHubPaintNav(host);
  const cl = host.querySelector(".apps-hub-close");
  cl.title = appsT("返回 MTNode 界面（Esc 同效）");
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
  await Promise.all([appsCatalogLoad(!!o.force), appsListLoad(true), appsRootLoad()]);
  if (o.force) {
    const src = APPS_ST.cat && APPS_ST.cat.source;
    appsToast(src === "remote" ? appsT("目录已更新") : appsT("云端目录暂时拉不到：显示的是本机缓存"), src === "remote" ? "ok" : "warn");
  }
  appsHubPaint();
}

function appsHubNav(id) {
  const next = APPS_NAV.some((n) => n[0] === id) ? id : "apps";
  if (next === APPS_ST.nav) {
    /* 同一页再点一次：只把展开的详情收回去（不切页） */
    APPS_ST.detailId = "";
    appsHubPaint();
    return;
  }
  APPS_ST.nav = next;
  APPS_ST.detailId = "";
  APPS_ST.devExport = null;
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
  host.hidden = false;
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
    l2.textContent = appsT("覆盖 = 只替换上次装进去的应用文件（该应用自己的存储与画布保留）；改名 = 装成另一个目录，两份并存；取消 = 什么都不做。");
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

async function appsDownload(id, mode) {
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
  let r = null;
  try {
    r = await api.appsInstall(id, mode || "");
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
      r = await api.appsInstall(id, choice);
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
    APPS_ST.detailId = "";
    appsHubPaint();
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

function appsFillCatalogActions(acts, spec) {
  const id = spec.id;
  const busy = !!APPS_ST.busy[id];
  const dl = appsMiniBtn(busy ? appsT("下载中…") : appsT("下载"), () => appsDownload(id, ""), !spec.installed);
  dl.disabled = busy || spec.compatible === false;
  if (spec.compatible === false) dl.title = appsT("该应用要求的 MTNode 版本高于当前版本");
  acts.appendChild(dl);
  acts.appendChild(
    appsMiniBtn(APPS_ST.detailId === id ? appsT("收起详情") : appsT("查看详情"), () => {
      APPS_ST.detailId = APPS_ST.detailId === id ? "" : id;
      appsHubPaint();
    }),
  );
  if (spec.updateAvailable && spec.installed) {
    const up = appsMiniBtn(appsT("更新到 v") + spec.version, () => appsDownload(id, "update"));
    up.disabled = busy;
    acts.appendChild(up);
  }
  if (spec.installed) {
    acts.appendChild(
      appsRunBtnEl(id, appsT("运行"), () => appsOpenApp(id)),
    );
  }
}

function appsCatalogBadges(spec) {
  const out = [];
  if (spec.installed) out.push([appsT("已下载"), "on"]);
  if (spec.updateAvailable) out.push([appsT("可更新"), "upd"]);
  if (spec.compatible === false) out.push([appsT("需要更新的 MTNode"), "bad"]);
  return out;
}

function appsTileEl(spec) {
  const id = spec.id;
  const name = appsSpecTitle(spec) || id;
  const card = document.createElement("div");
  card.className = "apps-tile" + (APPS_ST.detailId === id ? " open" : "");
  card.dataset.appId = id;

  const cover = document.createElement("div");
  cover.className = "apps-tile-cover";
  cover.appendChild(appsIconEl(spec, name));

  const info = document.createElement("div");
  info.className = "apps-tile-info";
  const h = document.createElement("div");
  h.className = "apps-tile-title";
  h.textContent = name;
  const ver = document.createElement("div");
  ver.className = "apps-tile-ver";
  ver.textContent =
    appsT("版本 ") +
    String(spec.version || "0.0.0") +
    (spec.installed && spec.installedVersion && spec.installedVersion !== spec.version
      ? " · " + appsT("本机 ") + spec.installedVersion
      : "");
  const desc = document.createElement("div");
  desc.className = "apps-tile-desc";
  desc.textContent = appsSpecDesc(spec) || appsT("（这个应用还没写描述）");
  const badges = document.createElement("div");
  badges.className = "apps-tile-badges";
  for (const [label, kind] of appsCatalogBadges(spec)) {
    const b = document.createElement("span");
    b.className = "apps-badge apps-badge-" + kind;
    b.textContent = label;
    badges.appendChild(b);
  }
  info.appendChild(h);
  info.appendChild(ver);
  info.appendChild(desc);
  info.appendChild(badges);

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

  if (APPS_ST.detailId === id) card.appendChild(appsDetailEl(spec, { spec: spec }));
  appsPaintProgress(id);
  return card;
}

/* 详情块：把目录条目里能给人看的字段全摊开（没有的字段不占位、不编造） */
function appsDetailEl(spec, extra) {
  const local = (extra && extra.app) || appsLocalById(spec.id);
  const box = document.createElement("div");
  box.className = "apps-detail";
  const rows = [];
  const push = (k, v) => {
    if (v == null || v === "") return;
    rows.push([k, String(v)]);
  };
  push(appsT("应用 id"), spec.id);
  push(appsT("版本"), String(spec.version || "") + (local ? " · " + appsT("本机 ") + String(local.version || "") : ""));
  push(appsT("作者"), spec.author);
  push(appsT("标签"), Array.isArray(spec.tags) && spec.tags.length ? spec.tags.join(" · ") : "");
  push(appsT("入口页"), spec.entry);
  push(appsT("需要的 MTNode 版本"), spec.minAppVersion);
  push(appsT("下载地址"), spec.zipUrl);
  push(appsT("校验 sha256"), spec.sha256);
  push(
    appsT("窗口尺寸"),
    spec.window && (spec.window.width || spec.window.height)
      ? String(spec.window.width || "") + "×" + String(spec.window.height || "")
      : "",
  );
  if (local) {
    push(appsT("本机目录"), local.dir);
    push(appsT("占用"), appsBytes(local.bytes) + " · " + local.files + appsT(" 个文件"));
    push(appsT("安装时间"), appsTime(local.installedAt || local.mtimeMs));
  }
  const full = document.createElement("div");
  full.className = "apps-detail-full";
  full.textContent = appsSpecDesc(spec) || appsT("（这个应用还没写描述）");
  box.appendChild(full);
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
  return box;
}

async function appsPaintAppsPage(body, seq) {
  /* 已有目录数据时不闪占位（搜索框每敲一个字都会重绘这一页） */
  if (!APPS_ST.cat) {
    const loading = document.createElement("div");
    loading.className = "apps-empty";
    loading.textContent = appsT("正在拉取云端应用目录…");
    body.appendChild(loading);
  }
  await Promise.all([appsCatalogLoad(false), appsListLoad(false), appsRootLoad()]);
  if (seq !== APPS_ST.seq || APPS_ST.nav !== "apps") return;
  body.innerHTML = "";
  body.appendChild(appsHubSearchRow());
  const cat = APPS_ST.cat || {};
  const q = String(APPS_ST.q || "").trim().toLowerCase();
  let list = appsCatalogList();
  if (q) {
    list = list.filter((s) => {
      const hay = (appsSpecTitle(s) + " " + appsSpecSub(s) + " " + String(s.description || "") + " " + String(s.id || "") + " " + (Array.isArray(s.tags) ? s.tags.join(" ") : "")).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  const hint = document.createElement("div");
  hint.className = "apps-hint";
  hint.textContent =
    cat.source === "remote"
      ? appsT("云端目录已更新（") + appsTime(cat.fetchedAt) + "）"
      : cat.source === "cache"
        ? appsT("云端目录暂时拉不到，显示的是本机缓存（") + appsTime(cat.fetchedAt) + "）"
        : appsT("云端目录为空或还没发布：可以先看看「库」里已下载的应用");
  if (cat.remoteError) hint.title = appsT("云端返回：") + String(cat.remoteError);
  body.appendChild(hint);

  if (!appsCatalogList().length) {
    const empty = document.createElement("div");
    empty.className = "apps-empty";
    empty.textContent =
      cat.source === "empty"
        ? appsT("云端目录里还没有应用：稍后重新进入本页会自动再拉一次。")
        : appsT("拿不到应用目录：请检查网络，稍后重新进入本页再试。");
    body.appendChild(empty);
    return;
  }
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "apps-empty";
    empty.textContent = appsT("没有匹配「") + String(APPS_ST.q) + appsT("」的应用");
    body.appendChild(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "apps-grid";
  for (const spec of list) grid.appendChild(appsTileEl(spec));
  body.appendChild(grid);
}

/* ───────────────── 库页（本机已下载） ───────────────── */

function appsFillLocalActions(acts, app) {
  const id = String(app.id || "");
  const busy = !!APPS_ST.busy[id];
  acts.appendChild(appsRunBtnEl(id, appsT("运行"), () => appsOpenApp(id)));
  const spec = appsSpecById(id);
  if (spec && spec.updateAvailable) {
    const up = appsMiniBtn(appsT("更新到 v") + spec.version, () => appsDownload(id, "update"));
    up.disabled = busy;
    acts.appendChild(up);
  }
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
  meta.textContent =
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

  /* 数据文件夹那一行：不进每张卡片（会吵），只有「用户改过」时在徽标里说一句；
     完整的路径 + 打开 / 更改 / 恢复默认在库页顶部那一行（appsDataLineEl）。 */
  const bind = appsDevBindingOf(app);
  const badges = document.createElement("div");
  badges.className = "apps-row-badges";
  const bBind = document.createElement("span");
  bBind.className = "apps-badge " + (bind.bound ? "apps-badge-on" : "apps-badge-off");
  bBind.textContent = bind.bound ? appsT("开发绑定：已绑定") : appsT("开发绑定：未绑定");
  bBind.title = bind.bound
    ? appsT("当前画布上的开发节点把该应用目录作为项目根（devPath）：") + bind.titles.join(" · ")
    : appsT("当前画布上没有开发节点把这个应用目录设为项目根（在顶层开发块「项目文件夹」里指向它即可绑定）");
  badges.appendChild(bBind);
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
 *  库页给一行：应用数据文件夹（路径 + 已自定义徽标 + 打开 / 更改… / 恢复默认）；
 *  应用窗口里也有一条同样的路（preload-app.js 的 appHost.dataDir*）。
 *  「更改」走主进程弹系统目录框 —— 路径只能来自用户亲自选的那一次，界面不传路径、不写路径。 */
function appsDataLineEl(kind, labelText) {
  const line = document.createElement("div");
  line.className = "apps-rootline";
  const label = document.createElement("span");
  label.className = "apps-rootline-k";
  label.textContent = appsT(labelText);
  const val = document.createElement("span");
  val.className = "apps-rootline-v";
  val.textContent = appsT("读取中…");
  line.appendChild(label);
  line.appendChild(val);
  const acts = document.createElement("span");
  acts.className = "apps-rootline-acts";
  line.appendChild(acts);
  appsDataLineFill(kind, val, acts);
  return line;
}
async function appsDataLineFill(kind, val, acts) {
  const api = window.api || {};
  const id = String(kind.id || "");
  acts.textContent = "";
  if (!id || typeof api.appsDataInfo !== "function") {
    val.textContent = appsT("应用服务未就绪（主进程应用宿主尚未接入）");
    return;
  }
  let r = null;
  try {
    r = await api.appsDataInfo(id);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) {
    val.textContent = appsT("读不到数据文件夹：") + appsErrText(r);
    return;
  }
  kind.info = r;
  val.textContent = String(r.dir || "") || appsT("未设置");
  val.title = String(r.dir || "");
  if (!r.def) {
    const b = document.createElement("span");
    b.className = "apps-badge apps-badge-on";
    b.textContent = appsT("自定义位置");
    b.title = appsT("这个应用的数据文件夹由用户改过；默认位置是 ") + String(r.root || "");
    acts.appendChild(b);
  }
  if (!r.exists) {
    const b = document.createElement("span");
    b.className = "apps-badge apps-badge-off";
    b.textContent = appsT("还没写过数据");
    acts.appendChild(b);
  }
  acts.appendChild(
    appsMiniBtn("📂", () => {
      const dir = String((kind.info && kind.info.dir) || "");
      if (!dir) {
        appsToast(appsT("还没设置数据文件夹"), "warn");
        return;
      }
      if (typeof openWorkspaceFolder === "function") openWorkspaceFolder(dir);
    }),
  );
  acts.appendChild(appsMiniBtn(appsT("更改…"), () => appsDataDirPickNow(kind, val, acts)));
  if (!r.def) acts.appendChild(appsMiniBtn(appsT("恢复默认"), () => appsDataDirResetNow(kind, val, acts)));
}
/* 选某个应用的数据文件夹：弹系统目录框，选完主进程写指针（当场生效，不搬旧数据） */
async function appsDataDirPickNow(kind, val, acts) {
  const api = window.api || {};
  const id = String(kind.id || "");
  if (typeof api.appsDataDirPick !== "function") {
    appsBridgeMissing();
    return;
  }
  let r = null;
  try {
    r = await api.appsDataDirPick(id);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.canceled) return;
  if (r.ok === false) {
    appsToast(appsT("设置失败：") + appsErrText(r), "err");
    return;
  }
  appsToast(appsT("数据文件夹已改为：") + String(r.dir || ""), "ok");
  await appsDataLineFill(kind, val, acts);
}
/* 恢复默认数据文件夹：只删指针，原目录里的数据原样留着 */
async function appsDataDirResetNow(kind, val, acts) {
  const api = window.api || {};
  const id = String(kind.id || "");
  if (typeof api.appsDataDirReset !== "function") {
    appsBridgeMissing();
    return;
  }
  let r = null;
  try {
    r = await api.appsDataDirReset(id);
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!r || r.ok === false) {
    appsToast(appsT("恢复默认失败：") + appsErrText(r), "err");
    return;
  }
  appsToast(appsT("已恢复默认数据文件夹（原目录数据留在原处）：") + String(r.dir || ""), "ok");
  await appsDataLineFill(kind, val, acts);
}

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

async function appsPaintLibPage(body, seq) {
  const loading = document.createElement("div");
  loading.className = "apps-empty";
  loading.textContent = appsT("正在读取本机应用…");
  body.appendChild(loading);
  await Promise.all([appsListLoad(false), appsCatalogLoad(false), appsRootLoad()]);
  if (seq !== APPS_ST.seq || APPS_ST.nav !== "lib") return;
  body.innerHTML = "";
  body.appendChild(appsHubSearchRow());
  body.appendChild(appsRootLineEl());
  /* 「新建应用」入口（renderer/app-app-flow.js）：建目录 + app.json → 同名画布走既有
     workflow:save → 画布上建一个开发节点（devPath 指向该应用目录）→ 打开并居中 */
  if (typeof appsCreateButtonEl === "function") body.appendChild(appsCreateButtonEl());
  const list = appsLocalList();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "apps-empty";
    empty.textContent = appsT("还没有下载任何应用：到「应用」页挑一个下载，它会装进应用根目录。");
    const go = appsMiniBtn(appsT("去「应用」页看看"), () => appsHubNav("apps"), true);
    empty.appendChild(document.createElement("br"));
    empty.appendChild(go);
    body.appendChild(empty);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "apps-rows";
  for (const app of list) wrap.appendChild(appsLocalRowEl(app));
  body.appendChild(wrap);
  /* 数据文件夹那一条（每应用一份，默认 <数据目录>/apps-data/<id>/）：挑一个应用 → 看 / 打开 / 更改 /
     恢复默认。应用窗口里也有同一条路（appHost.dataDir*），两边改的是同一个指针。 */
  const kind = { id: String((list[0] && list[0].id) || ""), info: null };
  if (kind.id) {
    const selRow = document.createElement("div");
    selRow.className = "apps-rootline";
    const selK = document.createElement("span");
    selK.className = "apps-rootline-k";
    selK.textContent = appsT("应用数据文件夹");
    const sel = document.createElement("select");
    sel.className = "apps-select";
    for (const app of list) {
      const o = document.createElement("option");
      o.value = String(app.id || "");
      o.textContent = String(app.name || app.id || "");
      sel.appendChild(o);
    }
    const val = document.createElement("span");
    val.className = "apps-rootline-v";
    val.textContent = appsT("读取中…");
    const acts = document.createElement("span");
    acts.className = "apps-rootline-acts";
    sel.addEventListener("change", () => {
      kind.id = String(sel.value || "");
      appsDataLineFill(kind, val, acts);
    });
    selRow.appendChild(selK);
    selRow.appendChild(sel);
    selRow.appendChild(val);
    selRow.appendChild(acts);
    body.insertBefore(selRow, wrap);
    appsDataLineFill(kind, val, acts);
  }
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

/* ───────────────── 开发页（三栏开发 + 根目录 / 导出包 / 变更探测） ───────────────── */

async function appsPaintDevPage(body, seq) {
  await Promise.all([appsListLoad(false), appsCatalogLoad(false), appsRootLoad()]);
  if (seq !== APPS_ST.seq || APPS_ST.nav !== "dev") return;
  body.innerHTML = "";
  /* 搜索框按页插在正文顶部（标题栏已去掉，刷新按钮也已去掉）；开发页正文由
     appsDevPagePaint 追加，本行必须排在它前面。 */
  body.appendChild(appsHubSearchRow());
  /* 顶部菜单条只允许一行：应用根目录 / ＋新建应用 这两项不再各占一行，而是由开发页
     （renderer/app-apps-dev.js 的 appsDevPagePaint）并进它自己那条工具栏里，
     宽度不够时自动收进「更多 ▾」。库页（appsPaintLibPage）仍按原来的两行排。 */

  /* ① 三栏开发页（renderer/app-apps-dev.js）：左 = 只属于该 appId 的会话列表 ·
     中 = iframe 实时预览该应用的静态页 · 右 = 该会话正文 · 下 = 输入框（同一个 composer）。
     首轮输入 = 在该应用的开发节点上点「开发」并提交；每轮开发结束后按应用目录的内容快照
     决定要不要重载预览（「维持状态」开关控制重载前后存 / 写回页面状态）。 */
  if (typeof appsDevPagePaint === "function") appsDevPagePaint(body, seq);

  /* ② 原有的工具区（导出应用包 / 变更探测 / 开发绑定）收进折叠块，默认收起：
     三栏是这一页的主内容，这些工具一个都不少，只是不占位。 */
  const more = document.createElement("details");
  more.className = "apps-sec-more";
  const moreSum = document.createElement("summary");
  moreSum.textContent = appsT("更多：导出应用包 / 变更探测 / 开发绑定");
  more.appendChild(moreSum);
  body.appendChild(more);

  /* ③ 导出应用包（不含画布：主进程 apps-store.js 的 exportZip 只打 app.json + 入口页 + assets） */
  const sec1 = document.createElement("section");
  sec1.className = "apps-sec";
  const h1 = document.createElement("h3");
  h1.textContent = appsT("导出应用包");
  const p1 = document.createElement("p");
  p1.className = "apps-sec-hint";
  p1.textContent = appsT("把某个已下载应用打成 zip（只含 app.json / 入口页 / assets，不含画布与该应用的存储），可用于搬家或上架云端目录。");
  sec1.appendChild(h1);
  sec1.appendChild(p1);
  const list = appsLocalList();
  if (!list.length) {
    const none = document.createElement("div");
    none.className = "apps-empty-sm";
    none.textContent = appsT("本机还没有已下载的应用");
    sec1.appendChild(none);
  } else {
    const sel = document.createElement("select");
    sel.className = "apps-select";
    for (const app of list) {
      const o = document.createElement("option");
      o.value = String(app.id || "");
      o.textContent = String(app.name || app.id || "") + " v" + String(app.version || "");
      sel.appendChild(o);
    }
    sec1.appendChild(sel);
    const pRun = document.createElement("p");
    pRun.className = "apps-sec-hint";
    pRun.textContent = appsT("为一个应用开独立窗口（位置与「库」页的「运行」相同；应用本体不依赖宿主桥也能跑）");
    sec1.appendChild(pRun);
    /* 「运行」：给选中的那个应用开独立窗口（与库页同一口径：appsOpenApp → 主进程
       apps:openWindow → BrowserWindow + preload-app.js 跑它自己的 index.html） */
    sec1.appendChild(
      appsRunBtnEl("dev", appsT("运行"), () => {
        const id = String(sel.value || "");
        if (id) appsOpenApp(id);
      }),
    );
    sec1.appendChild(
      appsMiniBtn(appsT("导出 zip"), async () => {
        const api = window.api || {};
        if (typeof api.appsExportZip !== "function") {
          appsBridgeMissing();
          return;
        }
        const r = await api.appsExportZip(sel.value);
        if (!r || r.ok === false) {
          appsToast(appsT("导出失败：") + appsErrText(r), "err");
          return;
        }
        APPS_ST.devExport = r;
        appsToast(appsT("已导出：") + r.path, "ok");
        if (APPS_ST.nav === "dev") appsHubPaint();
      }),
    );
  }
  if (APPS_ST.devExport) {
    const box = document.createElement("div");
    box.className = "apps-detail apps-detail-inline";
    const rows = [
      [appsT("文件"), String(APPS_ST.devExport.path || "")],
      [appsT("大小"), appsBytes(APPS_ST.devExport.bytes) + " · " + String(APPS_ST.devExport.files || 0) + appsT(" 个文件")],
      [appsT("校验 sha256"), String(APPS_ST.devExport.sha256 || "")],
    ];
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
      box.appendChild(row);
    }
    sec1.appendChild(box);
  }
  more.appendChild(sec1);

  /* ② 变更探测：按应用算「文件数 / 字节 / 最新 mtime」快照并与上一份比对 */
  const sec2 = document.createElement("section");
  sec2.className = "apps-sec";
  const h2 = document.createElement("h3");
  h2.textContent = appsT("变更探测");
  const p2 = document.createElement("p");
  p2.className = "apps-sec-hint";
  p2.textContent = appsT("对应用根目录下的每个应用算一份快照（文件数 / 字节 / 最新修改时间）并与上一份比对，看出哪些应用被改过（首次运行只落基线）。");
  sec2.appendChild(h2);
  sec2.appendChild(p2);
  sec2.appendChild(
    appsMiniBtn(appsT("探测变更"), async () => {
      const api = window.api || {};
      if (typeof api.appsProbeChanges !== "function") {
        appsBridgeMissing();
        return;
      }
      const r = await api.appsProbeChanges();
      if (!r || r.ok === false) {
        appsToast(appsT("探测失败：") + appsErrText(r), "err");
        return;
      }
      APPS_ST.devProbe = r;
      if (APPS_ST.nav === "dev") appsHubPaint();
    }),
  );
  const probe = APPS_ST.devProbe;
  if (probe) {
    const sum = document.createElement("div");
    sum.className = "apps-sec-hint";
    sum.textContent = probe.baseline
      ? appsT("已落基线：本次记下 ") + String((probe.added || []).length) + appsT(" 个应用，下次探测才有对照。")
      : appsT("新增 ") +
        String((probe.added || []).length) +
        appsT(" · 变更 ") +
        String((probe.changed || []).length) +
        appsT(" · 移除 ") +
        String((probe.removed || []).length) +
        appsT(" · 未变 ") +
        String(probe.unchanged || 0);
    sec2.appendChild(sum);
    const items = [];
    for (const id of probe.added || []) items.push([appsT("新增"), String(id)]);
    for (const c of probe.changed || []) items.push([appsT("变更"), String(c.id)]);
    for (const id of probe.removed || []) items.push([appsT("移除"), String(id)]);
    if (items.length) {
      const box = document.createElement("div");
      box.className = "apps-detail apps-detail-inline";
      for (const [k, v] of items) {
        const row = document.createElement("div");
        row.className = "apps-detail-row";
        const kk = document.createElement("span");
        kk.className = "apps-detail-k";
        kk.textContent = k;
        const vv = document.createElement("span");
        vv.className = "apps-detail-v";
        vv.textContent = v;
        row.appendChild(kk);
        row.appendChild(vv);
        box.appendChild(row);
      }
      sec2.appendChild(box);
    }
  }
  more.appendChild(sec2);

  /* ③ 开发绑定：当前画布项目根 ⇄ 应用目录 */
  const sec3 = document.createElement("section");
  sec3.className = "apps-sec";
  const h3 = document.createElement("h3");
  h3.textContent = appsT("开发绑定");
  const p3 = document.createElement("p");
  p3.className = "apps-sec-hint";
  p3.textContent = appsT("把某个应用目录设为当前画布顶层开发节点的「项目文件夹」（devPath），该应用就与开发节点绑定：库页那一行会显示「开发绑定：已绑定」，开发 / 细化会话的工作区也跟着它走。");
  sec3.appendChild(h3);
  sec3.appendChild(p3);
  const cur = typeof devProjectRootOf === "function" ? String(devProjectRootOf() || "") : "";
  const rootRow = document.createElement("div");
  rootRow.className = "apps-sec-hint";
  rootRow.textContent = cur ? appsT("当前画布项目根：") + cur : appsT("当前画布还没有项目根（在顶层开发块里设置「项目文件夹」）");
  sec3.appendChild(rootRow);
  const bound = appsLocalList().filter((a) => appsDevBindingOf(a).bound);
  const boundRow = document.createElement("div");
  boundRow.className = "apps-sec-hint";
  boundRow.textContent = bound.length
    ? appsT("已绑定开发的应用：") + bound.map((a) => String(a.name || a.id)).join(" · ")
    : appsT("本机还没有应用与当前画布的开发节点绑定");
  sec3.appendChild(boundRow);
  more.appendChild(sec3);
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
window.appsHubRefresh = appsHubRefresh;
window.appsHubIsOpen = appsHubIsOpen;
"use strict";
/* renderer/app-publish.js — 「上架应用」浮层（开发页一键上架：AI 生成元信息 → 核对编辑 →
 * 截图 → 勾选声明 → 上传到 store-saas）
 * ============================================================================
 * 【这个模块干什么】
 *   开发页顶部菜单条「启动」右边的「上架」按钮 → window.openAppPublish(appId) 开一只 #overlay
 *   浮层（persistent，可最小化到状态栏），面向非技术用户的一条流水线：
 *     ① 开窗即拉：本机应用（appsList）、线上状态（该 id 的详情 / 版本树）、账号配额；
 *     ② 可选「AI 生成」：素材 = 应用 app.json（fileReadText）+ 入口页可见文本 + 目录文件清单，
 *        提示词只让模型回一段 JSON，剥 ``` 围栏 + 容错解析；解析不出 / 没有服务商就留空让用户手填，
 *        **绝不伪造元信息**；
 *     ③ 用户核对 / 编辑：标题（必填）、应用 id（按英文标题自动 slug，可手改；本地校验 2-64 位
 *        [a-z0-9._-]、不以符号开头、非 Windows 保留名）、说明、版本号、版本说明、标签、图标；
 *     ④ 截图：拍应用自己的窗口（主进程 appsShotWindow；窗口没开就提示先点「启动」）或从本机选图
 *        （<input type=file> + FileReader，不依赖桥）；最多 8 张，可删 / 可上下排序，首张 = 封面；
 *        上传时**只取第 1 张**当 iconBase64（图标字段已填则用图标字段），绝不把 8 张都塞进请求体；
 *     ⑤ 声明：契约 §7.3 的声明正文逐字展示 + 「我已阅读并同意，责任由我承担」勾选，
 *        未勾选时上传按钮禁用并在页脚说明原因；
 *     ⑥ 上传：appsExportZip（现打一份包，不含画布）→ appsReadZipBase64（同一份包读回 base64，
 *        sha256 与上一步对不上就报错、不提交）→ POST /api/apps（新建）或
 *        POST /api/apps/<id>/versions（线上已有同 id 应用 = 追加版本，带 parentVersion）。
 *        进度只用按钮状态文字与禁用态表达（storeRequest 没有真进度，不做假进度条）。
 *   上传成功后**不自动关窗**：回显线上条目（标题 / 版本 / 官网目录条目）+ 「再传一版」按钮。
 *
 * 【依赖哪些桥（全部 window.api.*；本文件不碰文件系统、不直连网络）】
 *   appsList / appsExportZip / appsReadZipBase64 / appsShotWindow / appsOpenApp / appsDevPreview /
 *   appsCatalog / fileReadText（读 app.json 与入口页，拿不到就跳过）/ fileListDir（目录清单，可缺）/
 *   assetReadDataUrl（截图 → base64）/ storeRequest（主进程自动带 Bearer token；上传 timeoutMs 600000）。
 *   模型调用：apiCallTextStream（renderer/app-nodes.js），provider 取自 S.config.providers，
 *   与 renderer/app-review.js 的 reviewResolveProv 同一口径（type === "text_openai" 且有 apiKey）。
 *
 * 【与 docs/apps-market.md 的关系】
 *   接口契约的唯一真源 = 该文档「## 七、上架与多版本」：7.1 多版本两种行为、7.2 记录扩展字段、
 *   7.3 声明留痕（PUB_DECLARATION 逐字照抄该节正文）、7.4 接口（POST /api/apps ·
 *   POST /api/apps/<id>/versions · DELETE /api/apps/<id>/versions/<v> · GET /api/apps/<id>/versions）、
 *   7.5 配额（QUOTA_BYTES / QUOTA_APPS 的中文误差原样显示 + 提示先删旧版）、7.6 目录条目扩展。
 *   接口要改先改那份 md，再改这里；这里不再抄第二份字段表。
 *
 * 【对话框纪律（AGENTS.md「协作约定」）】
 *   本窗 persistent：**没有**任何「点外部 / 点蒙层自动关闭」的监听。关闭只有显式路径：
 *   窗内「取消」、标题栏 ✕ / 最小化（app.js 的 ovMinimizeActive）、窗内 Esc、再点一次「上架」。
 *   尺寸 = .overlay-box 上的 .app-publish-box 类（css/app-publish.css）+ 右下角手柄拖拽写内联宽高；
 *   openOverlay / closeOverlay 只清内联样式、不清未登记的类，所以类的清理由本文件自己负责
 *   （pubBoxClassOff：开窗时把落在 #overlay 上的残留类摘掉，停在 #ovPark 里的最小化窗保留原样）。
 * ==========================================================================*/

/* ───────────────────────── 常量 ───────────────────────── */

/* 声明正文（**逐字**照 docs/apps-market.md §7.3，服务端 acceptDeclaration === true 才落盘） */
const PUB_DECLARATION =
  "本人保证该应用符合中华人民共和国法律法规，不含违法有害内容，不侵犯他人知识产权；因该应用产生的全部责任由上传者承担。";

const PUB_MAX_SHOTS = 8; /* 截图最多 8 张 */
const PUB_ICON_MAX_BYTES = 500 * 1024; /* 图标上限（契约 §一：png/jpeg/webp ≤500KB） */
const PUB_TITLE_MAX = 80;
const PUB_DESC_MAX = 2000;
const PUB_NOTE_MAX = 200;
const PUB_TAGS_MAX = 200;
const PUB_QUOTA_BYTES = 50 * 1024 * 1024; /* 契约 §7.5：MAX_ACCOUNT_APP_BYTES */
const PUB_QUOTA_APPS = 5; /* 契约 §7.5：MAX_ACCOUNT_APPS */
const PUB_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/; /* 2-64 位、不以符号开头 */
const PUB_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/; /* 服务端 normalizeVersion 同口径 */
const PUB_ICON_TYPES = ["image/png", "image/jpeg", "image/webp"];
const PUB_RESERVED_IDS = [
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/* 窗内状态（每次开窗重置；浮层最小化到状态栏再搬回来时 DOM 不重建，所以它必须够用） */
const PUB = {
  appId: "",
  app: null, /* 本机应用摘要（api.appsList 的那条） */
  seq: 0, /* 异步回来时对不上的就丢弃 */
  loggedIn: false,
  user: null,
  bridgeMiss: "", /* 关键桥缺失时的说明（storeRequest / appsExportZip …） */
  online: null, /* {known, exists, mine, id, latestVersion, unpublished, versions:[], item} */
  quota: null, /* {apps, bytes, at, error} */
  shots: [], /* [{key, path, dataUrl, name, bytes, w, h, from}] */
  form: {
    title: "",
    id: "",
    description: "",
    version: "",
    note: "",
    tags: "",
    icon: { dataUrl: "", bytes: 0, name: "" },
  },
  idTouched: false, /* 用户手改过 id → 标题变化不再自动改写 */
  idLocked: false, /* 线上已有同 id 应用 → id 锁定 */
  verTouched: false, /* 用户手改过版本号 → 不再套用默认值 */
  aiBusy: false,
  aiDone: false,
  busy: false,
  note: "", /* 页脚状态文字（上传进度 / 成功提示） */
  showNote: false, /* true = 页脚钉住上面那条结果（上传成功），直到用户改动表单或点「再传一版」 */
  dom: Object.create(null),
};

/* ───────────────────────── 小工具 ───────────────────────── */

function pubT(s) {
  return window.I18n && I18n.t ? I18n.t(s) : String(s == null ? "" : s);
}
function pubStr(v) {
  return String(v == null ? "" : v).trim();
}
function pubEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = String(text);
  return el;
}
function pubBtn(label, onclick, cls) {
  const b = pubEl("button", cls || "mini", label);
  b.type = "button";
  b.onclick = (ev) => {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    onclick();
  };
  return b;
}
function pubToast(msg, kind) {
  if (typeof toast === "function") toast(msg, kind || "ok");
}
function pubBytes(n) {
  if (typeof fmtBytes === "function") return fmtBytes(n);
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1024 / 1024).toFixed(2) + " MB";
}
/* 时间：与 app-apps.js 的 appsTime 同口径（中文环境 zh-CN，英文环境 en-US） */
function pubTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return "";
  const en = window.I18n && I18n.getLocale && I18n.getLocale() === "en";
  try {
    return new Date(n).toLocaleString(en ? "en-US" : "zh-CN");
  } catch (_) {
    return "" + new Date(n);
  }
}
function pubTrim(s, n) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) + "…" : t;
}
/* 登录态快照：与 app-apps.js 的 appsAuthUser 同一口径（唯一来源 = window.MTNodeAuth.state()） */
function pubAuthUser() {
  const A = window.MTNodeAuth;
  if (!A || typeof A.state !== "function") return null;
  const st = A.state() || {};
  return st.signedIn && st.user ? st.user : null;
}
/* 「去登录」入口：优先用统一账户模块自己的打开函数（app-auth.js 的 MTNodeAuth.open，
   它就是顶栏 #btnAccount 那颗按钮点开的同一个对话框）；模块没就绪才退回点那颗按钮。 */
function pubGoLogin() {
  const A = window.MTNodeAuth;
  try {
    if (A && typeof A.open === "function") {
      A.open();
      return true;
    }
  } catch (_) {}
  const btn = document.getElementById("btnAccount");
  if (btn) {
    try {
      btn.click();
      return true;
    } catch (_) {}
  }
  return false;
}
/* 本机路径 / file:/// URL → 可显示的 file:/// URL（复用画布层的统一口径，缺桥时自己拼） */
function pubFileUrl(p) {
  const s = pubStr(p);
  if (!s) return "";
  if (/^file:\/\//i.test(s) || /^data:/i.test(s)) return s;
  try {
    if (typeof mediaFileUrlOf === "function") {
      const u = mediaFileUrlOf(s);
      if (u) return u;
    }
  } catch (_) {}
  try {
    if (window.api && typeof window.api.toFileUrl === "function") {
      const u = String(window.api.toFileUrl(s) || "");
      if (u) return u;
    }
  } catch (_) {}
  const body = s.replace(/\\/g, "/");
  return (
    "file:///" +
    (body.replace(/^\/+/, "") || "")
      .split("/")
      .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
      .join("/")
  );
}
/* data URL → 原始字节数（用于「图标 ≤500KB」的本地预检；不算精确解码，够用即可） */
function pubDataUrlBytes(u) {
  const s = String(u || "");
  const i = s.indexOf(",");
  if (i < 0) return 0;
  const b64 = s.slice(i + 1).replace(/\s+/g, "");
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}
function pubStripDataUrl(u) {
  const s = String(u || "");
  const i = s.indexOf(",");
  return i >= 0 ? s.slice(i + 1) : s;
}

/* ───────────────── 共享 #overlay 窗壳：尺寸类 + 手柄 ───────────────── */

function pubShellBox() {
  const ov = document.getElementById("overlay");
  return ov ? ov.querySelector(":scope > .overlay-box") : null;
}
/* 摘掉落在「当前窗」上的尺寸类（停在 #ovPark 里的最小化窗保留原样 —— 它还要原样搬回来）。
   openOverlay / closeOverlay 只清内联样式，未登记的类得自己收，否则 ✕ 关窗后下一个弹窗会继承
   近全屏尺寸（AGENTS.md 记着这个坑：残留尺寸让「关不掉的窗」）。 */
function pubBoxClassOff() {
  let list = [];
  try {
    list = Array.prototype.slice.call(
      document.querySelectorAll("#overlay > .overlay-box.app-publish-box"),
    );
  } catch (_) {
    list = [];
  }
  for (const b of list) b.classList.remove("app-publish-box");
}
function pubBoxCleanup() {
  const box = pubShellBox();
  /* 拖拽手柄住在 #ovBody 里（定位锚是窗框），关窗时一并摘掉 —— closeOverlay 不清 #ovBody，
     留着虽然看不见（整只窗 display:none），但下一次开窗前的空窗期里它还在文档里。 */
  try {
    const grips = document.querySelectorAll("#ovBody .pub-resize");
    for (const g of grips) g.remove();
  } catch (_) {}
  if (!box) return;
  box.classList.remove("app-publish-box");
  box.style.cssText = "";
}
/* 标题栏 ✕ 是 app.js 的显式出口（closeOverlay），本文件不改它，只在它跑完之后补一件事：
   若刚才关掉的正是上架窗，就把尺寸类摘掉 —— 共享的 .overlay-box 会被下一个弹窗复用，
   残留的近全屏尺寸会跟着过去（AGENTS.md 记着这个坑）。挂的是 ✕ 自己的 click（不是全局
   点击监听，更不是「点外部关闭」）；同一只按钮只挂一次，窗壳被最小化 / 复用时 DOM 不重建。 */
function pubHygieneOnCloseClick() {
  const ov = document.getElementById("overlay");
  if (ov && ov.style.display !== "none") return; /* ✕ 关的不是正在显示的这只窗（极小概率）→ 不动 */
  const root = PUB.dom.root;
  const body = document.getElementById("ovBody");
  if (!root || !body || !body.contains(root)) return; /* 已经换过窗：当前窗不是上架窗 */
  pubBoxCleanup();
}
function pubBindCloseHygiene(box) {
  if (!box) return;
  const btn = box.querySelector(".ov-close-btn");
  if (!btn || btn.dataset.pubClean === "1") return;
  btn.dataset.pubClean = "1";
  btn.addEventListener("click", pubHygieneOnCloseClick);
}
/* 右下角拖拽手柄：鼠标事件改 .overlay-box 的内联宽高（关闭时随 cssText 一起清掉）。
   手柄挂在 #ovBody 里的 .pub-root 上（无 position 祖先 → 定位锚是 .overlay-box 的
   position:relative），所以它贴在窗框右下角、且关窗时随 #ovBody 一起消失，不留残件。 */
function pubResizeBind(handle) {
  handle.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const box = pubShellBox();
    if (!box) return;
    const base = {
      w: box.offsetWidth,
      h: box.offsetHeight,
      x: ev.clientX,
      y: ev.clientY,
    };
    const vw = Number(window.innerWidth) || 1200;
    const vh = Number(window.innerHeight) || 800;
    const minW = Math.max(360, Math.round(vw * 0.5)); /* 最小宽 ≥50%（需求口径） */
    const minH = 360;
    const onMove = (e) => {
      /* 本窗已不是当前窗（被别的弹窗顶掉 / 已关）→ 立即收手 */
      if (!PUB.dom.root || !document.contains(PUB.dom.root)) {
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

/* ───────────────── 纯计算：slug / 版本 / 地址 ───────────────── */

/* 标题 → 小写 slug（只留 [a-z0-9._-]，空白转 -）。中文标题一般得空串 → 调用方保留原 id。 */
function pubSlug(title) {
  const s = String(title == null ? "" : title).toLowerCase();
  let out = "";
  for (const ch of s) {
    if (/[a-z0-9._-]/.test(ch)) out += ch;
    else if (/\s/.test(ch) || ch === "\u3000") out += "-";
  }
  out = out.replace(/[._-]{2,}/g, "-").replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  return out.slice(0, 64);
}
/* 版本号小版本 +1：1.2.0 → 1.2.1（非 x.y.z 形态 → 原样返回，交给用户手改） */
function pubBumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pubStr(v));
  if (!m) return "";
  return m[1] + "." + m[2] + "." + (Number(m[3]) + 1);
}
/* 关键桥是否齐：缺了要如实说，不许装作能传 */
function pubCheckBridges() {
  const api = window.api || {};
  const need = [
    ["storeRequest", "上传接口"],
    ["appsExportZip", "应用打包"],
    ["appsReadZipBase64", "应用包读回 base64"],
  ];
  const miss = need.filter(([k]) => typeof api[k] !== "function").map(([, label]) => label);
  PUB.bridgeMiss = miss.length ? miss.join(" / ") : "";
  return !miss.length;
}

/* ───────────────── 打开 / 关闭 ───────────────── */

/* 入口（开发页「上架」按钮 → 全局 window.openAppPublish） */
async function openAppPublish(appId) {
  const id = pubStr(appId);
  if (!id) {
    pubToast(pubT("当前没有选中的应用：先在开发页选一个本机应用"), "warn");
    return false;
  }
  const user = pubAuthUser();
  if (!user) {
    pubToast(pubT("上架需要先登录：点这里去登录"), "warn");
    pubGoLogin();
    return false;
  }
  if (typeof openOverlay !== "function") {
    pubToast(pubT("窗口模块未就绪（openOverlay 不存在）"), "err");
    return false;
  }
  const api = window.api || {};
  if (typeof api.appsList !== "function") {
    pubToast(pubT("应用服务未就绪（主进程应用宿主尚未接入）"), "err");
    return false;
  }
  /* 本机应用摘要（权威来源是主进程 appsList，不信缓存） */
  let app = null;
  try {
    const r = await api.appsList();
    const list = r && Array.isArray(r.apps) ? r.apps : [];
    app = list.find((a) => a && String(a.id || "") === id) || null;
  } catch (_) {}
  if (!app && typeof appsLocalById === "function") {
    try {
      app = appsLocalById(id);
    } catch (_) {}
  }
  if (!app) {
    pubToast(pubT("该应用不在本机：先在应用中心下载或新建它"), "err");
    return false;
  }

  PUB.seq++;
  PUB.appId = id;
  PUB.app = app;
  PUB.user = user;
  PUB.loggedIn = true;
  PUB.online = null;
  PUB.quota = null;
  PUB.shots = [];
  PUB.idTouched = false;
  PUB.idLocked = false;
  PUB.verTouched = false;
  PUB.aiBusy = false;
  PUB.aiDone = false;
  PUB.busy = false;
  PUB.note = "";
  PUB.dom = Object.create(null);
  PUB.form = {
    title: pubStr(app.title || app.name || id),
    id: id,
    description: pubStr(app.description || ""),
    version: "1.0.0",
    note: "",
    tags: "",
    icon: { dataUrl: "", bytes: 0, name: "" },
    /* 二次开发来源（fork，可选；契约见 docs/apps-market.md §八）：自动带出 + 可改 + 可清空 */
    forkOf: pubForkInit(app),
  };
  /* 关键桥探测（缺 storeRequest / appsExportZip / appsReadZipBase64 时页脚直接说清楚，别等点了才炸） */
  pubCheckBridges();

  openOverlay(pubT("上架应用") + " · " + pubStr(app.name || id), { persistent: true, min: true });
  /* 尺寸类：先把当前窗上的残留摘掉，再挂自己的（近全屏 / 最小宽 50% 见 css/app-publish.css） */
  pubBoxClassOff();
  const box = pubShellBox();
  if (box) box.classList.add("app-publish-box");
  pubBindCloseHygiene(box);

  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) {
    pubBoxCleanup();
    return false;
  }
  pubBuildShell(body, foot);
  pubPaintHead();
  pubPaintShots();
  pubPaintOnline();
  pubPaintQuota();
  pubPaintFoot();

  /* 异步：登录态（/api/me）→ 线上状态 + 版本树 → 配额（按顺序，后一步要知道账号名） */
  pubLoadAll(pubSeqNow()).catch(() => {});
  return true;
}

/* 开窗后的读取顺序：先确认登录态，再读线上状态，最后统计配额（同一份 PUB.seq 守卫） */
async function pubLoadAll(seq) {
  await pubLoadAuth(seq).catch(() => {});
  if (!pubAlive(seq)) return;
  await pubLoadOnline().catch(() => {});
  if (!pubAlive(seq)) return;
  await pubLoadQuota().catch(() => {});
}

/* 当前窗的世代号（名字不用 mySeq：app-apps-dev.js 里有个同名的局部 const，别互相遮） */
function pubSeqNow() {
  return PUB.seq;
}
function pubAlive(seq) {
  return seq === PUB.seq && !!PUB.dom.root && document.contains(PUB.dom.root);
}
/* 显式关闭：窗内「取消」/ Esc。内联尺寸随 closeOverlay 的 cssText="" 一起清，类在这里清。 */
function pubClose() {
  pubBoxCleanup();
  PUB.seq++;
  if (typeof closeOverlay === "function") closeOverlay();
}

/* ───────────────── 绘制：窗壳骨架 ───────────────── */

function pubBuildShell(body, foot) {
  body.innerHTML = "";
  foot.innerHTML = "";
  const root = pubEl("div", "pub-root");
  PUB.dom.root = root;

  /* 顶部：应用名 + 本机版本 + 线上状态 */
  const head = pubEl("div", "pub-head");
  const who = pubEl("div", "pub-head-who");
  who.appendChild(pubEl("span", "pub-app-name", pubStr(PUB.app.name || PUB.appId)));
  who.appendChild(pubEl("span", "pub-chip", pubT("本机版本") + " v" + pubStr(PUB.app.version || "0.0.0")));
  who.appendChild(pubEl("span", "pub-chip", pubStr(PUB.app.entry || "index.html")));
  head.appendChild(who);
  const chip = pubEl("span", "pub-chip pub-chip-online", pubT("正在读取线上状态…"));
  PUB.dom.onlineChip = chip;
  head.appendChild(chip);
  root.appendChild(head);

  /* 结果块（上传成功后显示；不自动关窗，所以它一直留着） */
  const result = pubEl("div", "pub-result");
  result.hidden = true;
  PUB.dom.result = result;
  root.appendChild(result);

  const grid = pubEl("div", "pub-grid");
  const main = pubEl("section", "pub-col pub-col-main");
  const side = pubEl("section", "pub-col pub-col-side");
  grid.appendChild(main);
  grid.appendChild(side);
  root.appendChild(grid);
  PUB.dom.grid = grid;

  pubBuildAiSec(main);
  pubBuildFormSec(main);
  pubBuildDeclSec(main);
  pubBuildShotSec(side);
  pubBuildOnlineSec(side);
  pubBuildQuotaSec(side);

  /* 右下角拖拽手柄（挂在 root 里 → 定位锚 = .overlay-box 的 position:relative） */
  const grip = pubEl("div", "pub-resize");
  grip.title = pubT("拖拽右下角调整窗口大小");
  grip.setAttribute("aria-label", pubT("拖拽右下角调整窗口大小"));
  pubResizeBind(grip);
  root.appendChild(grip);

  /* Esc = 窗内显式关闭路径（焦点在窗内时生效；点外部照旧什么都不做） */
  root.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      pubClose();
    }
  });

  body.appendChild(root);

  /* 页脚：状态 / 禁用原因 + 取消 + 上传 */
  const note = pubEl("div", "pub-foot-note", "");
  PUB.dom.footNote = note;
  foot.appendChild(note);
  foot.appendChild(pubBtn(pubT("取消"), () => pubClose(), "mini"));
  const up = pubBtn(pubT("上传上架"), () => pubUpload(), "mini primary");
  PUB.dom.upBtn = up;
  foot.appendChild(up);
}

/* ── ① AI 生成 ── */
function pubBuildAiSec(host) {
  const sec = pubEl("section", "pub-sec");
  const head = pubEl("div", "pub-sec-head");
  head.appendChild(pubEl("h4", "pub-sec-t", pubT("① 元信息（可用 AI 起草，随后自己核对）")));
  const gen = pubBtn(pubT("AI 生成"), () => pubAiGenerate(), "mini");
  PUB.dom.aiBtn = gen;
  head.appendChild(gen);
  sec.appendChild(head);
  const st = pubEl("div", "pub-hint pub-ai-status", pubT("素材 = 该应用的 app.json + 入口页可见文本 + 目录文件清单。没有配置文本服务商时不会生成，请直接手填下面的字段。"));
  PUB.dom.aiStatus = st;
  sec.appendChild(st);
  host.appendChild(sec);
}
function pubAiStatus(msg, kind) {
  const el = PUB.dom.aiStatus;
  if (!el) return;
  el.textContent = pubStr(msg);
  el.className = "pub-hint pub-ai-status" + (kind ? " pub-" + kind : "");
}

/* ── ② 表单 ── */
function pubFieldSec(host, title) {
  const sec = pubEl("section", "pub-sec");
  sec.appendChild(pubEl("h4", "pub-sec-t", title));
  host.appendChild(sec);
  return sec;
}
function pubBuildFormSec(host) {
  const sec = pubFieldSec(host, pubT("② 上架信息"));

  /* 标题（必填） */
  const titleIn = pubEl("input", "pub-in");
  titleIn.type = "text";
  titleIn.id = "pubTitle";
  titleIn.maxLength = PUB_TITLE_MAX;
  titleIn.placeholder = pubT("给用户看的名字，例如：批量重命名小工具");
  titleIn.value = PUB.form.title;
  PUB.dom.titleIn = titleIn;
  const titleCount = pubEl("span", "pub-count", titleIn.value.length + "/" + PUB_TITLE_MAX);
  sec.appendChild(pubField(pubT("标题（必填）"), titleIn, titleCount, pubT("≤80 字")));
  titleIn.addEventListener("input", () => {
    PUB.form.title = titleIn.value;
    titleCount.textContent = titleIn.value.length + "/" + PUB_TITLE_MAX;
    if (!PUB.idTouched && !PUB.idLocked) {
      const s = pubSlug(titleIn.value);
      if (s.length >= 2) {
        PUB.form.id = s;
        if (PUB.dom.idIn) PUB.dom.idIn.value = s;
      }
    }
    pubEdit();
  });

  /* 应用 id */
  const idIn = pubEl("input", "pub-in");
  idIn.type = "text";
  idIn.id = "pubId";
  idIn.maxLength = 64;
  idIn.placeholder = "my-app";
  idIn.value = PUB.form.id;
  PUB.dom.idIn = idIn;
  const idHint = pubEl("span", "pub-count", "");
  PUB.dom.idHint = idHint;
  sec.appendChild(pubField(pubT("应用 id（安装目录名）"), idIn, idHint, pubT("2-64 位小写字母 / 数字 / . _ -，以字母或数字开头；不能是 con / nul / com1 这类 Windows 保留名。标题是英文时会自动填，中文标题保留本机 id。")));
  idIn.addEventListener("input", () => {
    PUB.idTouched = true;
    idIn.value = idIn.value.toLowerCase();
    PUB.form.id = idIn.value;
    pubEdit();
  });
  idIn.addEventListener("blur", () => {
    idIn.value = pubStr(idIn.value).toLowerCase();
    PUB.form.id = idIn.value;
    /* id 改过 = 线上状态是照旧 id 读的：重读一次，别把「追加版本」打到别人的应用上 */
    if (PUB.online && pubStr(PUB.online.id) && pubStr(PUB.online.id) !== idIn.value) {
      pubLoadOnline().catch(() => {});
    }
    pubEdit();
  });

  /* 二次开发来源（可选，见 pubForkField）：放在「应用 id」之后 —— 两者一起构成应用的身份 */
  sec.appendChild(pubForkField());

  /* 说明 */
  const descIn = pubEl("textarea", "pub-in pub-ta");
  descIn.id = "pubDesc";
  descIn.rows = 6;
  descIn.maxLength = PUB_DESC_MAX;
  descIn.placeholder = pubT("先说这个应用做什么，再说怎么用（3-6 句）。");
  descIn.value = PUB.form.description;
  PUB.dom.descIn = descIn;
  const descCount = pubEl("span", "pub-count", descIn.value.length + "/" + PUB_DESC_MAX);
  sec.appendChild(pubField(pubT("说明"), descIn, descCount, pubT("≤2000 字")));
  descIn.addEventListener("input", () => {
    PUB.form.description = descIn.value;
    descCount.textContent = descIn.value.length + "/" + PUB_DESC_MAX;
    pubEdit();
  });

  /* 行：版本号 + 版本说明 */
  const row = pubEl("div", "pub-row");
  const verIn = pubEl("input", "pub-in");
  verIn.type = "text";
  verIn.id = "pubVer";
  verIn.maxLength = 32;
  verIn.placeholder = "1.0.0";
  verIn.value = PUB.form.version;
  PUB.dom.verIn = verIn;
  const verHint = pubEl("div", "pub-hint", "");
  PUB.dom.verHint = verHint;
  const verField = pubEl("div", "pub-field");
  const verLab = pubEl("label", "pub-lab", pubT("版本号"));
  verLab.htmlFor = "pubVer";
  verField.appendChild(verLab);
  verField.appendChild(verIn);
  verField.appendChild(verHint);
  row.appendChild(verField);
  verIn.addEventListener("input", () => {
    PUB.verTouched = true;
    PUB.form.version = verIn.value;
    pubEdit();
  });

  const noteIn = pubEl("input", "pub-in");
  noteIn.type = "text";
  noteIn.id = "pubNote";
  noteIn.maxLength = PUB_NOTE_MAX;
  noteIn.placeholder = pubT("这一版改了什么，例如：修了导出按钮");
  noteIn.value = PUB.form.note;
  PUB.dom.noteIn = noteIn;
  const noteCount = pubEl("span", "pub-count", noteIn.value.length + "/" + PUB_NOTE_MAX);
  row.appendChild(pubField(pubT("版本说明"), noteIn, noteCount, pubT("≤200 字，会显示在版本树里")));
  noteIn.addEventListener("input", () => {
    PUB.form.note = noteIn.value;
    noteCount.textContent = noteIn.value.length + "/" + PUB_NOTE_MAX;
    pubEdit();
  });
  sec.appendChild(row);

  /* 标签 */
  const tagsIn = pubEl("input", "pub-in");
  tagsIn.type = "text";
  tagsIn.id = "pubTags";
  tagsIn.maxLength = PUB_TAGS_MAX;
  tagsIn.placeholder = pubT("工具,效率");
  tagsIn.value = PUB.form.tags;
  PUB.dom.tagsIn = tagsIn;
  sec.appendChild(pubField(pubT("标签"), tagsIn, null, pubT("英文逗号分隔，2-5 个短标签")));
  tagsIn.addEventListener("input", () => {
    PUB.form.tags = tagsIn.value;
    pubEdit();
  });

  /* 图标（可选） */
  const iconWrap = pubEl("div", "pub-icon");
  const iconPrev = pubEl("img", "pub-icon-prev");
  iconPrev.alt = pubT("图标预览");
  iconPrev.hidden = true;
  PUB.dom.iconPrev = iconPrev;
  iconWrap.appendChild(iconPrev);
  const iconBtns = pubEl("div", "pub-icon-btns");
  iconBtns.appendChild(pubBtn(pubT("选择图片…"), () => pubPickIcon(), "mini"));
  iconBtns.appendChild(pubBtn(pubT("清除"), () => pubClearIcon(), "mini"));
  const iconInfo = pubEl("div", "pub-hint", "");
  PUB.dom.iconInfo = iconInfo;
  iconBtns.appendChild(iconInfo);
  iconWrap.appendChild(iconBtns);
  const iconField = pubEl("div", "pub-field");
  iconField.appendChild(pubEl("label", "pub-lab", pubT("图标（可选）")));
  iconField.appendChild(iconWrap);
  iconField.appendChild(pubEl("div", "pub-hint", pubT("png / jpeg / webp，≤500KB。不填就用第一张截图当图标。")));
  sec.appendChild(iconField);

  const iconFile = pubEl("input", "pub-hide-file");
  iconFile.type = "file";
  iconFile.accept = "image/png,image/jpeg,image/webp";
  iconFile.addEventListener("change", () => {
    const f = iconFile.files && iconFile.files[0];
    iconFile.value = "";
    if (f) pubReadImageFile(f, "icon");
  });
  PUB.dom.iconFile = iconFile;
  sec.appendChild(iconFile);
}
/* 一行字段：标签 + 控件 + 右侧计数 / 下方提示 */
function pubField(labelText, ctrl, countEl, hintText) {
  const f = pubEl("div", "pub-field");
  const lab = pubEl("label", "pub-lab", labelText);
  if (ctrl.id) lab.htmlFor = ctrl.id;
  const line = pubEl("div", "pub-labline");
  line.appendChild(lab);
  if (countEl) line.appendChild(countEl);
  f.appendChild(line);
  f.appendChild(ctrl);
  if (hintText) f.appendChild(pubEl("div", "pub-hint", hintText));
  return f;
}

/* ── 二次开发来源（fork，可选）──────────────────────────────────────────────
 * 口径（本轮共识，docs/apps-market.md §八）：应用身份 = 应用 id + 作者 uid（uid 为准，界面显示账号名）。
 * 同一应用被不同作者二次开发后各自上架成**不同 id** 的条目，条目上用 forkOf = { id, ownerId }
 * 指回源应用；客户端按它把同源条目归成「同一应用的不同分支」。
 *
 * 「自动带出 + 可改 + 可清空」三件事都在这里：
 *   ① 本机 app.json 里已声明过的 forkOf（对别人的应用二次开发时保留下来）→ 默认填它；
 *   ② 否则本机这一份是从云端某条目装下来的（安装账本记了来源作者）→ 带出「那个条目」；
 *   ③ 都没有 = 原创，留空（不影响上架）。 */
function pubForkInit(app) {
  const own = app && app.forkOf && typeof app.forkOf === "object" ? app.forkOf : null;
  if (own && pubStr(own.id))
    return { id: pubStr(own.id), ownerId: pubStr(own.ownerId), owner: pubStr(own.owner) };
  const owner = pubStr(app && app.owner);
  const ownerId = pubStr(app && app.ownerId);
  if (owner || ownerId) return { id: pubStr(app && app.id), ownerId: ownerId, owner: owner };
  return { id: "", ownerId: "", owner: "" };
}
/* 云端目录里可以当 fork 源挑的条目（应用中心已经拉过目录就直接用它，不再多打一次网络） */
function pubForkChoices() {
  const out = [];
  try {
    const list = typeof appsCatalogList === "function" ? appsCatalogList() : [];
    for (const s of Array.isArray(list) ? list : []) {
      const id = pubStr(s && s.id);
      if (!id) continue;
      out.push({
        id: id,
        ownerId: pubStr(s.ownerId),
        owner: pubStr(s.owner),
        title: pubStr((s && s.title && (s.title.zh || s.title.en)) || (s && s.name) || id),
        version: pubStr(s && s.version),
      });
    }
  } catch (_) {}
  return out;
}
function pubForkField() {
  const wrap = pubEl("div", "pub-field");
  const lab = pubEl("label", "pub-lab", pubT("基于哪个应用二次开发（可选）"));
  lab.htmlFor = "pubFork";
  const line = pubEl("div", "pub-labline");
  line.appendChild(lab);
  wrap.appendChild(line);

  const sel = pubEl("select", "pub-in");
  sel.id = "pubFork";
  PUB.dom.forkSel = sel;
  const cur = PUB.form.forkOf || { id: "", ownerId: "", owner: "" };
  const keyOf = (x) => pubStr(x.id) + "\u0000" + pubStr(x.ownerId) + "\u0000" + pubStr(x.owner);
  const opt = (value, text) => {
    const o = pubEl("option");
    o.value = value;
    o.textContent = text;
    return o;
  };
  sel.appendChild(opt("", pubT("（原创：不声明来源）")));
  const choices = pubForkChoices();
  let matched = false;
  for (const c of choices) {
    if (cur.id && keyOf(cur) === keyOf(c)) matched = true;
    sel.appendChild(
      opt(
        keyOf(c),
        "v" + (c.version || "0.0.0") + " · " + c.title + " · " + c.id + " · " + pubT("作者 ") + (c.owner || pubT("未知")),
      ),
    );
  }
  /* 带出来的那一条不在目录里（源已下架 / 目录没拉到）：补一项，别让用户的声明被悄悄丢掉 */
  if (cur.id && !matched) {
    sel.appendChild(
      opt(keyOf(cur), pubT("（已声明）") + cur.id + (cur.owner ? " · " + pubT("作者 ") + cur.owner : "")),
    );
  }
  sel.value = cur.id ? keyOf(cur) : "";
  sel.addEventListener("change", () => {
    const v = pubStr(sel.value);
    if (!v) {
      PUB.form.forkOf = { id: "", ownerId: "", owner: "" };
    } else {
      const parts = v.split("\u0000");
      PUB.form.forkOf = { id: pubStr(parts[0]), ownerId: pubStr(parts[1]), owner: pubStr(parts[2]) };
    }
    pubEdit();
  });
  wrap.appendChild(sel);
  wrap.appendChild(
    pubEl(
      "div",
      "pub-hint",
      pubT("声明后云端条目会记下「二次开发自」这个应用（源 id + 原作者 uid），别人的客户端就能在你的版本与它之间「切换分支」。选「原创」= 不声明，不影响上架；声明也会写进本机 app.json（随包走），以后再上架会自动带回。"),
    ),
  );
  return wrap;
}

/* ── ③ 声明 ── */
function pubBuildDeclSec(host) {
  const sec = pubEl("section", "pub-sec pub-decl");
  sec.appendChild(pubEl("h4", "pub-sec-t", pubT("③ 声明（必须勾选才能上传）")));
  sec.appendChild(pubEl("p", "pub-decl-text", pubT(PUB_DECLARATION)));
  const lab = pubEl("label", "pub-decl-ok");
  const cb = pubEl("input");
  cb.type = "checkbox";
  cb.id = "pubDecl";
  PUB.dom.declCb = cb;
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(pubT("我已阅读并同意，责任由我承担")));
  cb.addEventListener("change", () => pubEdit());
  sec.appendChild(lab);
  host.appendChild(sec);
}

/* ── ④ 截图 ── */
function pubBuildShotSec(host) {
  const sec = pubEl("section", "pub-sec");
  const head = pubEl("div", "pub-sec-head");
  head.appendChild(pubEl("h4", "pub-sec-t", pubT("④ 截图")));
  const cnt = pubEl("span", "pub-count", "");
  PUB.dom.shotCount = cnt;
  head.appendChild(cnt);
  sec.appendChild(head);

  const bar = pubEl("div", "pub-shot-bar");
  bar.appendChild(pubBtn(pubT("拍应用窗口"), () => pubShotWindow(), "mini"));
  bar.appendChild(pubBtn(pubT("从本机选图…"), () => pubPickShots(), "mini"));
  sec.appendChild(bar);
  const st = pubEl("div", "pub-hint", pubT("最多 8 张，第一张当封面（不上传整组图，只用第 1 张当图标）。拍窗口前请先在开发页点「启动」。"));
  PUB.dom.shotStatus = st;
  sec.appendChild(st);
  const wrap = pubEl("div", "pub-shots");
  PUB.dom.shotsWrap = wrap;
  sec.appendChild(wrap);

  const file = pubEl("input", "pub-hide-file");
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/webp";
  file.multiple = true;
  file.addEventListener("change", () => {
    const files = Array.prototype.slice.call(file.files || []);
    file.value = "";
    for (const f of files) pubReadImageFile(f, "shot");
  });
  PUB.dom.shotFile = file;
  sec.appendChild(file);
  host.appendChild(sec);
}
function pubShotStatus(msg, kind) {
  const el = PUB.dom.shotStatus;
  if (!el) return;
  el.textContent = pubStr(msg);
  el.className = "pub-hint" + (kind ? " pub-" + kind : "");
}

/* ── ⑤ 线上版本 ── */
function pubBuildOnlineSec(host) {
  const sec = pubEl("section", "pub-sec");
  const head = pubEl("div", "pub-sec-head");
  head.appendChild(pubEl("h4", "pub-sec-t", pubT("⑤ 线上版本")));
  const re = pubBtn(pubT("重新读取"), () => {
    pubLoadOnline().catch(() => {});
  }, "mini");
  PUB.dom.onlineReload = re;
  head.appendChild(re);
  sec.appendChild(head);
  const list = pubEl("div", "pub-vers");
  PUB.dom.versWrap = list;
  sec.appendChild(list);
  const bar = pubEl("div", "pub-vers-bar");
  const del = pubBtn(pubT("删除选中版本"), () => pubDeleteVersions(), "mini danger");
  del.disabled = true;
  PUB.dom.delVerBtn = del;
  bar.appendChild(del);
  bar.appendChild(pubEl("div", "pub-hint", pubT("删旧版会同时下掉它的包与版本记录，配额当场释放（不能撤销）。")));
  sec.appendChild(bar);
  host.appendChild(sec);
}

/* ── ⑥ 配额 ── */
function pubBuildQuotaSec(host) {
  const sec = pubEl("section", "pub-sec");
  sec.appendChild(pubEl("h4", "pub-sec-t", pubT("⑥ 账号配额")));
  const wrap = pubEl("div", "pub-quota");
  PUB.dom.quotaWrap = wrap;
  sec.appendChild(wrap);
  host.appendChild(sec);
}

/* ───────────────── 绘制：刷新各块 ───────────────── */

function pubPaintHead() {
  const chip = PUB.dom.onlineChip;
  if (!chip) return;
  const o = PUB.online;
  let text = "";
  if (!o) text = pubT("正在读取线上状态…");
  else if (o.known === false) text = pubT("线上状态未知（接口不可达）；上传时以服务端判断为准");
  else if (!o.exists) text = pubT("首次上架（线上还没有这个 id）");
  else if (o.mine) text = pubT("已有线上应用") + " v" + pubStr(o.latestVersion || "") + pubT("（本次为追加版本）");
  else text = pubT("该 id 已被账号 ") + pubStr(o.owner || "") + pubT(" 占用，不能上架");
  chip.textContent = text;
  chip.className =
    "pub-chip pub-chip-online" +
    (!o ? "" : o.known === false ? " pub-warn" : !o.exists ? " pub-new" : o.mine ? "" : " pub-err");
}

function pubPaintShots() {
  const wrap = PUB.dom.shotsWrap;
  if (!wrap) return;
  wrap.innerHTML = "";
  const list = PUB.shots;
  if (PUB.dom.shotCount) PUB.dom.shotCount.textContent = list.length + "/" + PUB_MAX_SHOTS;
  if (!list.length) {
    wrap.appendChild(pubEl("div", "pub-hint", pubT("还没有截图。")));
  }
  list.forEach((s, i) => {
    const card = pubEl("div", "pub-shot");
    const img = pubEl("img", "pub-shot-img");
    img.alt = s.name || pubT("截图");
    const src = s.dataUrl ? s.dataUrl : pubFileUrl(s.path);
    if (src) img.src = src;
    card.appendChild(img);
    if (i === 0) card.appendChild(pubEl("span", "pub-shot-cover", pubT("封面")));
    const meta = pubEl("div", "pub-shot-meta");
    meta.appendChild(pubEl("div", "pub-shot-name", pubTrim(s.name || pubT("截图"), 18)));
    meta.appendChild(
      pubEl(
        "div",
        "pub-shot-sub",
        pubBytes(s.bytes) + (s.w && s.h ? " · " + s.w + "×" + s.h : ""),
      ),
    );
    card.appendChild(meta);
    const acts = pubEl("div", "pub-shot-acts");
    const up = pubBtn("↑", () => pubMoveShot(i, -1), "mini");
    up.disabled = i === 0;
    up.title = pubT("前移");
    const dn = pubBtn("↓", () => pubMoveShot(i, 1), "mini");
    dn.disabled = i === list.length - 1;
    dn.title = pubT("后移");
    const rm = pubBtn("✕", () => pubRemoveShot(i), "mini");
    rm.title = pubT("删除这张");
    acts.appendChild(up);
    acts.appendChild(dn);
    acts.appendChild(rm);
    card.appendChild(acts);
    wrap.appendChild(card);
  });
  pubEdit();
}
function pubMoveShot(i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || i >= PUB.shots.length || j >= PUB.shots.length) return;
  const a = PUB.shots[i];
  PUB.shots[i] = PUB.shots[j];
  PUB.shots[j] = a;
  pubPaintShots();
}
function pubRemoveShot(i) {
  if (i < 0 || i >= PUB.shots.length) return;
  PUB.shots.splice(i, 1);
  pubPaintShots();
}
function pubAddShot(item) {
  if (PUB.shots.length >= PUB_MAX_SHOTS) {
    pubToast(pubT("截图最多 8 张：先删掉一张再加"), "warn");
    return false;
  }
  PUB.shots.push(item);
  pubPaintShots();
  return true;
}

/* 线上版本列表（可勾选删除） */
function pubPaintOnline() {
  const wrap = PUB.dom.versWrap;
  if (!wrap) return;
  wrap.innerHTML = "";
  if (PUB.dom.delVerBtn) PUB.dom.delVerBtn.disabled = true;
  const o = PUB.online;
  if (!o) {
    wrap.appendChild(pubEl("div", "pub-hint", pubT("正在读取线上版本…")));
    return;
  }
  if (o.known === false) {
    wrap.appendChild(
      pubEl("div", "pub-hint pub-err", pubT("读不到线上状态：") + pubStr(o.error || "") + pubT("。可以上传，服务端会按实际情况接受或拒绝。")),
    );
    return;
  }
  if (!o.exists) {
    wrap.appendChild(pubEl("div", "pub-hint", pubT("线上还没有这个 id 的应用：本次是新建（POST /api/apps）。")));
    return;
  }
  const vs = Array.isArray(o.versions) ? o.versions : [];
  if (!o.mine) {
    wrap.appendChild(
      pubEl("div", "pub-hint pub-err", pubT("这个 id 在线上不属于当前账号：不能追加版本，也不能删它的版本。请改一个 id 再上传。")),
    );
  }
  if (!vs.length) {
    wrap.appendChild(
      pubEl("div", "pub-hint", pubT("线上已有这个应用（单版记录，没有版本树数据）：本次按追加版本处理。")),
    );
    return;
  }
  for (const v of vs) {
    const row = pubEl("label", "pub-ver");
    const cb = pubEl("input");
    cb.type = "checkbox";
    cb.dataset.ver = pubStr(v.version);
    cb.addEventListener("change", () => pubSyncDelBtn());
    row.appendChild(cb);
    const main = pubEl("div", "pub-ver-main");
    main.appendChild(pubEl("span", "pub-ver-no", "v" + pubStr(v.version)));
    /* 「最新」标记：版本树接口给 current；退回 item.versions 时按 latestVersion 认 */
    const isCur = v.current != null ? !!v.current : pubStr(v.version) === pubStr(o.latestVersion);
    if (isCur) main.appendChild(pubEl("span", "pub-ver-tag", pubT("最新")));
    if (v.parentVersion) main.appendChild(pubEl("span", "pub-ver-tag", pubT("父版 ") + pubStr(v.parentVersion)));
    main.appendChild(
      pubEl(
        "span",
        "pub-ver-sub",
        [pubTime(v.createdAt), pubBytes(v.bytes), pubStr(v.uploader)].filter(Boolean).join(" · "),
      ),
    );
    if (pubStr(v.note)) main.appendChild(pubEl("span", "pub-ver-note", pubStr(v.note)));
    row.appendChild(main);
    wrap.appendChild(row);
  }
  pubSyncDelBtn();
}
function pubSyncDelBtn() {
  const btn = PUB.dom.delVerBtn;
  if (!btn) return;
  const n = pubPickedVersions().length;
  btn.disabled = !n;
  btn.textContent = n ? pubT("删除选中版本") + "（" + n + "）" : pubT("删除选中版本");
}
function pubPickedVersions() {
  const wrap = PUB.dom.versWrap;
  if (!wrap) return [];
  return Array.prototype.slice
    .call(wrap.querySelectorAll('input[type="checkbox"]'))
    .filter((cb) => cb.checked)
    .map((cb) => pubStr(cb.dataset.ver))
    .filter(Boolean);
}

function pubPaintQuota() {
  const wrap = PUB.dom.quotaWrap;
  if (!wrap) return;
  wrap.innerHTML = "";
  const q = PUB.quota;
  if (!q) {
    wrap.appendChild(pubEl("div", "pub-hint", pubT("正在读取配额…")));
    return;
  }
  if (q.error) {
    wrap.appendChild(pubEl("div", "pub-hint pub-warn", pubT("读不到配额：") + pubStr(q.error)));
  }
  const used = Number(q.bytes) || 0;
  const n = Number(q.apps) || 0;
  const overB = used > PUB_QUOTA_BYTES;
  const overA = n >= PUB_QUOTA_APPS;
  const line = pubEl("div", "pub-quota-line");
  line.appendChild(
    pubEl(
      "span",
      "pub-quota-k",
      pubT("云端已用") + " " + pubBytes(used) + " / " + pubBytes(PUB_QUOTA_BYTES),
    ),
  );
  line.appendChild(
    pubEl("span", "pub-quota-k", pubT("应用") + " " + n + " / " + PUB_QUOTA_APPS),
  );
  wrap.appendChild(line);
  if (overB) {
    wrap.appendChild(
      pubEl("div", "pub-hint pub-err", pubT("云端包总量已超上限：服务端会以 QUOTA_BYTES 拒绝，先在上面删掉旧版。")),
    );
  }
  if (overA) {
    wrap.appendChild(
      pubEl("div", "pub-hint pub-err", pubT("应用数量已达上限（追加版本不计入）：服务端会以 QUOTA_APPS 拒绝，先删掉不用的应用。")),
    );
  }
}

function pubEdit() {
  PUB.showNote = false;
  pubPaintFoot();
}
/* 页脚状态 + 上传按钮的可用性（唯一的禁用判据入口，改这里就够） */
function pubPaintFoot() {
  const note = PUB.dom.footNote;
  const btn = PUB.dom.upBtn;
  if (!btn) return;
  const set = (msg, kind, enabled, label) => {
    if (note) {
      note.textContent = pubStr(msg);
      note.className = "pub-foot-note" + (kind ? " pub-" + kind : "");
    }
    btn.disabled = !enabled;
    btn.textContent = label || pubT("上传上架");
  };
  if (PUB.busy) {
    set(PUB.note || pubT("上传中…"), "", false, pubT("上传中…"));
    return;
  }
  /* 上传成功那一刻的结论钉在页脚（此时再算一遍「将新建 / 将追加」会把它盖掉）；
     用户动一下表单、或点「再传一版」就回到常规提示。 */
  if (PUB.showNote && PUB.note) {
    set(PUB.note, "ok", false, pubT("已上传"));
    return;
  }
  if (PUB.bridgeMiss) {
    set(pubT("宿主桥未就绪（") + PUB.bridgeMiss + pubT("）：当前版本还不能上架"), "err", false);
    return;
  }
  if (!PUB.loggedIn) {
    set(pubT("未登录：先登录再上传"), "err", false);
    return;
  }
  const v = pubValidate();
  if (v.errors.length) {
    set(v.errors[0], "warn", false);
    return;
  }
  if (PUB.dom.declCb && !PUB.dom.declCb.checked) {
    set(pubT("请先阅读并勾选下面的声明「我已阅读并同意，责任由我承担」——未勾选不能上传"), "warn", false);
    return;
  }
  const plan = pubIconPlan();
  if (plan.bytes > PUB_ICON_MAX_BYTES) {
    set(
      pubT("图标 ") + pubBytes(plan.bytes) + pubT(" 超过 500KB 上限：请用「图标」选一张更小的图（png/jpeg/webp），或换用「从本机选图」加一张小图当封面"),
      "warn",
      false,
    );
    return;
  }
  const append = !!(PUB.online && PUB.online.exists && PUB.online.mine);
  set(
    (append
      ? pubT("将追加版本 v") + pubStr(PUB.form.version) + pubT("（parentVersion = ") + pubStr(PUB.online.latestVersion || "") + "）"
      : pubT("将新建应用 v") + pubStr(PUB.form.version)) +
      (plan.kind === "shot" ? pubT("；接口没有图标时会用第 1 张截图当图标") : ""),
    "ok",
    true,
  );
}

/* ───────────────── 校验 ───────────────── */

/* 图标来源计划：显式图标 > 第 1 张截图 > 无。bytes 用于「≤500KB」的本地预检 */
function pubIconPlan() {
  const ic = PUB.form.icon;
  if (ic && ic.dataUrl) return { kind: "icon", bytes: Number(ic.bytes) || pubDataUrlBytes(ic.dataUrl) };
  const s = PUB.shots[0];
  if (s) return { kind: "shot", bytes: Number(s.bytes) || pubDataUrlBytes(s.dataUrl || "") };
  return { kind: "none", bytes: 0 };
}
/* 本地校验（服务端仍会再校验一遍；这里只把能提前看出来的错说清楚） */
function pubValidate() {
  const errors = [];
  const f = PUB.form;
  const title = pubStr(f.title);
  if (!title) errors.push(pubT("标题必填"));
  else if (title.length > PUB_TITLE_MAX) errors.push(pubT("标题超过 ") + PUB_TITLE_MAX + pubT(" 字"));
  const id = pubStr(f.id).toLowerCase();
  if (!PUB_ID_RE.test(id)) {
    errors.push(pubT("应用 id 需 2-64 位小写字母 / 数字 / . _ -，且以字母或数字开头"));
  } else if (PUB_RESERVED_IDS.indexOf(id.split(".")[0]) >= 0) {
    errors.push(pubT("应用 id 不能是 Windows 保留名（con / nul / com1 …）"));
  }
  if (pubStr(f.description).length > PUB_DESC_MAX) {
    errors.push(pubT("说明超过 ") + PUB_DESC_MAX + pubT(" 字"));
  }
  const ver = pubStr(f.version);
  if (!PUB_VERSION_RE.test(ver)) errors.push(pubT("版本号不合法（示例 1.0.0）"));
  if (pubStr(f.note).length > PUB_NOTE_MAX) {
    errors.push(pubT("版本说明超过 ") + PUB_NOTE_MAX + pubT(" 字"));
  }
  const o = PUB.online;
  if (o && o.known !== false && o.exists && !o.mine) {
    errors.push(pubT("该 id 在线上属于账号 ") + pubStr(o.owner || "") + pubT("：请改一个 id，或先在线上处理它"));
  }
  if (o && o.known !== false && o.exists && o.mine && Array.isArray(o.versions)) {
    const dup = o.versions.some((x) => pubStr(x.version) === ver);
    if (dup) errors.push(pubT("线上已有版本 v") + ver + pubT("：请换一个版本号"));
  }
  return {
    errors,
    payload: {
      id,
      title,
      description: pubStr(f.description),
      version: ver,
      versionNote: pubStr(f.note),
      tags: pubTagsOf(f.tags),
      entry: pubStr(PUB.app && PUB.app.entry) || "index.html",
    },
  };
}
function pubTagsOf(raw) {
  return String(raw == null ? "" : raw)
    .split(/[,，]/)
    .map((s) => pubStr(s))
    .filter(Boolean)
    .slice(0, 10);
}

/* ───────────────── 读取：登录态 / 线上状态 / 配额 ───────────────── */

async function pubLoadAuth(seq) {
  const api = window.api || {};
  const user = pubAuthUser();
  if (user) {
    PUB.user = user;
    PUB.loggedIn = true;
  }
  if (typeof api.storeRequest !== "function") return;
  try {
    const r = await api.storeRequest({ method: "GET", path: "/api/me" });
    if (!pubAlive(seq)) return;
    const ok = !!(r && r.ok && r.data && r.data.user);
    PUB.loggedIn = ok;
    if (ok) PUB.user = r.data.user;
  } catch (_) {
    if (!pubAlive(seq)) return;
    /* 拿不到就当未登录（口径：失败即未登录），但不清掉上面的本地快照 */
  }
  pubPaintFoot();
}

/* 线上状态：GET /api/apps/<id>（免登录，含 mine / latestVersion / versions）+
   版本树 GET /api/apps/<id>/versions（契约 §7.4）。任何一个成功都算 known。 */
async function pubLoadOnline() {
  const seq = PUB.seq;
  const api = window.api || {};
  const id = pubStr(PUB.form.id) || PUB.appId;
  const mine = { known: false, exists: false, mine: false, id, latestVersion: "", versions: [], owner: "", error: "" };
  PUB.online = mine;
  pubPaintHead();
  pubPaintOnline();
  pubPaintFoot();
  if (typeof api.storeRequest !== "function" || !id) return;
  let known = false;
  try {
    const r = await api.storeRequest({ method: "GET", path: "/api/apps/" + encodeURIComponent(id) });
    if (!pubAlive(seq)) return;
    if (r && r.ok && r.data && r.data.item) {
      const it = r.data.item;
      known = true;
      mine.exists = true;
      mine.mine = !!it.mine || String(it.owner || "").toLowerCase() === pubUsername();
      mine.owner = pubStr(it.owner);
      mine.latestVersion = pubStr(it.latestVersion || it.version);
      mine.unpublished = !!it.unpublished;
      mine.item = it;
      if (Array.isArray(it.versions)) mine.versions = it.versions.slice();
    } else if (r && Number(r.status) === 404) {
      known = true; /* 明确不存在 = 首次上架 */
    }
  } catch (_) {}
  /* 版本树（契约 §7.4：免登录；老服务端没有这个路由 → 404 就退回 item.versions） */
  try {
    const r2 = await api.storeRequest({ method: "GET", path: "/api/apps/" + encodeURIComponent(id) + "/versions" });
    if (!pubAlive(seq)) return;
    if (r2 && r2.ok && r2.data) {
      const d = r2.data;
      known = true;
      mine.exists = true;
      if (pubStr(d.latestVersion)) mine.latestVersion = pubStr(d.latestVersion);
      if (d.unpublished != null) mine.unpublished = !!d.unpublished;
      if (Array.isArray(d.versions)) mine.versions = d.versions.slice();
    }
  } catch (_) {}
  mine.known = known;
  if (!known) mine.error = pubT("接口不可达或返回异常");
  if (!pubAlive(seq)) return;
  /* id / 版本默认值：线上已有（且是我的）→ id 锁定 + 版本号默认 = 最新版小版本 +1 */
  PUB.idLocked = !!(mine.exists && mine.mine);
  if (PUB.dom.idIn) {
    PUB.dom.idIn.readOnly = PUB.idLocked;
    PUB.dom.idIn.title = PUB.idLocked
      ? pubT("线上已存在这个应用 id：本次是追加版本，id 不能改")
      : "";
  }
  if (PUB.idLocked) {
    PUB.form.id = id;
    if (PUB.dom.idIn) PUB.dom.idIn.value = id;
  }
  if (mine.exists && mine.mine && !PUB.verTouched) {
    const next = pubBumpPatch(mine.latestVersion);
    if (next) {
      PUB.form.version = next;
      if (PUB.dom.verIn) PUB.dom.verIn.value = next;
    }
  }
  if (PUB.dom.verHint) {
    PUB.dom.verHint.textContent = mine.exists && mine.mine
      ? pubT("线上最新版是 v") + pubStr(mine.latestVersion) + pubT("：这次会作为新版本追加（parentVersion = ") + pubStr(mine.latestVersion) + "）"
      : pubT("首次上架默认 1.0.0；线上已有同 id 时会自动取「最新版小版本 +1」。");
  }
  if (PUB.dom.idHint) {
    PUB.dom.idHint.textContent = PUB.idLocked
      ? pubT("已锁定为线上 id")
      : pubStr(PUB.form.id).length + "/64";
  }
  pubPaintHead();
  pubPaintOnline();
  pubPaintFoot();
}
function pubUsername() {
  return pubStr((PUB.user && (PUB.user.username || PUB.user.nickname)) || "").toLowerCase();
}

/* 配额：GET /api/apps?owner=<我>&includeUnpublished=1（契约 §7.5 的用量口径） */
async function pubLoadQuota() {
  const seq = PUB.seq;
  const api = window.api || {};
  const me = pubUsername();
  if (typeof api.storeRequest !== "function" || !me) {
    PUB.quota = { apps: 0, bytes: 0, error: me ? "" : pubT("拿不到账号名，无法统计") };
    pubPaintQuota();
    return;
  }
  let out = { apps: 0, bytes: 0, error: "" };
  try {
    const r = await api.storeRequest({
      method: "GET",
      path: "/api/apps?owner=" + encodeURIComponent(me) + "&includeUnpublished=1&pageSize=50",
    });
    if (!pubAlive(seq)) return;
    if (r && r.ok && r.data) {
      const items = Array.isArray(r.data.items) ? r.data.items : Array.isArray(r.data.apps) ? r.data.apps : [];
      out.apps = items.length;
      for (const it of items) {
        const vs = Array.isArray(it && it.versions) ? it.versions : null;
        if (vs && vs.length) {
          for (const v of vs) out.bytes += Number(v && v.bytes) || 0;
        } else {
          out.bytes += Number((it && it.bytes) || 0);
        }
      }
    } else {
      out.error = pubStr((r && r.data && r.data.error) || (r && r.error) || pubT("接口不可达"));
    }
  } catch (err) {
    out.error = pubStr((err && err.message) || err);
  }
  if (!pubAlive(seq)) return;
  PUB.quota = out;
  pubPaintQuota();
}

/* ───────────────── 截图 ───────────────── */

/* 读一张本机图片文件（图标 / 截图共用）：<input type=file> + FileReader，不依赖任何桥 */
function pubReadImageFile(file, kind) {
  if (!file) return;
  const type = String(file.type || "").toLowerCase();
  if (PUB_ICON_TYPES.indexOf(type) < 0) {
    pubToast(pubT("只支持 png / jpeg / webp 图片"), "warn");
    return;
  }
  const fr = new FileReader();
  fr.onload = () => {
    const dataUrl = String(fr.result || "");
    const bytes = Number(file.size) || pubDataUrlBytes(dataUrl);
    if (kind === "icon") {
      PUB.form.icon = { dataUrl, bytes, name: pubStr(file.name) };
      pubPaintIcon();
      pubEdit();
      return;
    }
    pubAddShot({
      key: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      path: "",
      dataUrl,
      name: pubStr(file.name) || pubT("本机图片"),
      bytes,
      from: "file",
    });
  };
  fr.onerror = () => pubToast(pubT("读这个图片文件失败：") + pubStr(file.name), "err");
  fr.readAsDataURL(file);
}
function pubPickShots() {
  if (PUB.dom.shotFile) PUB.dom.shotFile.click();
}
function pubPickIcon() {
  if (PUB.dom.iconFile) PUB.dom.iconFile.click();
}
function pubClearIcon() {
  PUB.form.icon = { dataUrl: "", bytes: 0, name: "" };
  pubPaintIcon();
  pubEdit();
}
function pubPaintIcon() {
  const ic = PUB.form.icon;
  const img = PUB.dom.iconPrev;
  const info = PUB.dom.iconInfo;
  if (img) {
    if (ic && ic.dataUrl) {
      img.src = ic.dataUrl;
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }
  if (info) {
    info.textContent = ic && ic.dataUrl
      ? pubTrim(ic.name || pubT("图标"), 20) + " · " + pubBytes(ic.bytes)
      : pubT("未选图标：将用第 1 张截图当图标");
  }
}
/* 拍该应用自己的窗口（主进程 appsShotWindow） */
async function pubShotWindow() {
  const api = window.api || {};
  const id = PUB.appId;
  if (typeof api.appsShotWindow !== "function") {
    pubShotStatus(pubT("宿主桥未就绪（appsShotWindow）：当前版本还不能拍应用窗口，请改用「从本机选图」。"), "err");
    return;
  }
  pubShotStatus(pubT("正在拍应用窗口…"));
  let r = null;
  try {
    r = await api.appsShotWindow(id);
  } catch (err) {
    pubShotStatus(pubT("拍应用窗口失败：") + pubStr((err && err.message) || err), "err");
    return;
  }
  if (!r || r.ok === false) {
    const msg = pubStr((r && r.error) || pubT("拍应用窗口失败"));
    pubShotStatus(pubT("拍应用窗口失败：") + msg, "err");
    /* 窗口没开 / 最小化 → 给一条「启动」的路（不替用户动他的窗口，只给按钮） */
    const bar = PUB.dom.shotStatus;
    if (bar && /启动|最小化|窗口/.test(msg) && typeof appsOpenApp === "function") {
      bar.appendChild(document.createTextNode(" "));
      bar.appendChild(
        pubBtn(pubT("启动这个应用"), () => {
          try {
            appsOpenApp(id);
          } catch (_) {}
        }, "mini"),
      );
    }
    return;
  }
  const ok = pubAddShot({
    key: "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    path: pubStr(r.path),
    dataUrl: "",
    name: pubT("应用窗口"),
    bytes: Number(r.bytes) || 0,
    w: Number(r.width) || 0,
    h: Number(r.height) || 0,
    from: "window",
  });
  if (ok) pubShotStatus(pubT("已加入第 ") + PUB.shots.length + pubT(" 张（第 1 张是封面）。"));
}
/* 截图 → base64：本机选图直接用 data URL；拍窗口的图走 assetReadDataUrl 读回 */
async function pubShotBase64(shot) {
  if (!shot) return "";
  if (shot.dataUrl) return pubStripDataUrl(shot.dataUrl);
  const api = window.api || {};
  if (shot.path && typeof api.assetReadDataUrl === "function") {
    try {
      const r = await api.assetReadDataUrl(shot.path);
      const u = String((r && r.dataUrl) || "");
      if (u) return pubStripDataUrl(u);
    } catch (_) {}
  }
  return "";
}

/* ───────────────── AI 生成元信息 ───────────────── */

function pubResolveProv() {
  const list = (typeof S !== "undefined" && S && Array.isArray(S.config && S.config.providers) ? S.config.providers : []) || [];
  return list.find((p) => p && p.type === "text_openai" && pubStr(p.apiKey)) || null;
}
/* 素材：app.json + 入口页可见文本 + 目录文件清单（能读就读，读不到就少给，不编） */
async function pubCollectMaterial() {
  const api = window.api || {};
  const app = PUB.app || {};
  const dir = pubStr(app.dir);
  const out = {
    app: {
      id: pubStr(app.id),
      name: pubStr(app.name),
      title: pubStr(app.title),
      version: pubStr(app.version),
      description: pubStr(app.description),
      style: pubStr(app.style),
      entry: pubStr(app.entry),
      files: Number(app.files) || 0,
      bytes: Number(app.bytes) || 0,
    },
    jsonRaw: "",
    pageText: "",
    files: [],
  };
  if (!dir) return out;
  if (typeof api.fileReadText === "function") {
    const man = await pubReadText(dir + "/app.json");
    if (man) out.jsonRaw = pubTrim(man, 4000);
    const html = await pubReadText(dir + "/" + (pubStr(app.entry) || "index.html"));
    if (html) out.pageText = pubTrim(pubHtmlText(html), 1500);
  }
  if (typeof api.fileListDir === "function") {
    try {
      const r = await api.fileListDir(dir);
      if (r && r.ok && Array.isArray(r.list)) {
        out.files = r.list
          .map((x) => pubStr(x && x.rel))
          .filter(Boolean)
          .slice(0, 30);
      }
    } catch (_) {}
  }
  return out;
}
async function pubReadText(p) {
  const api = window.api || {};
  if (typeof api.fileReadText !== "function") return "";
  try {
    const r = await api.fileReadText(p);
    if (!r || r.exists === false) return "";
    return String(r.content || "");
  } catch (_) {
    return "";
  }
}
/* 入口页 HTML → 可见文本（去 script / style / 标签；只给模型当素材，不当展示） */
function pubHtmlText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}
function pubGenPrompt(m) {
  const lines = [
    "你在为 MTNode 的「应用市场」写一份上架元信息。根据下面这份本机应用素材，写出可直接展示的中文元信息。",
    "",
    "只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块、不要多余字段，格式固定为：",
    '{"title":"应用标题","description":"应用说明","version":"1.0.0","tags":["标签1","标签2"]}',
    "",
    "写作要求：",
    "1. title：中文，≤80 字，具体到能一眼看懂这个应用做什么；不要用「应用」「工具」「小助手」这类空词。",
    "2. description：中文，≤2000 字，先说做什么、再说怎么用（3-6 句），只写素材里能看出来的功能，禁止编造。",
    "3. version：形如 1.0.0。",
    "4. tags：2-5 个中文短标签。",
    "",
    "素材（app.json 原文，可能为空）：",
    pubTrim(m.jsonRaw || "（读不到 app.json）", 4000),
    "",
    "入口页可见文本（可能为空）：",
    pubTrim(m.pageText || "（读不到入口页文本）", 1500),
    "",
    "应用目录里的文件：" + (m.files.length ? m.files.join(" · ") : "（读不到目录清单）"),
    "",
    "本机应用信息：" + JSON.stringify(m.app),
  ];
  return lines.join("\n");
}
/* 剥 ``` 围栏 + 取第一个 {…} + 容错解析（尾随逗号 / 单引号不强求） */
function pubParseMetaJson(raw) {
  let s = String(raw == null ? "" : raw).trim();
  const fence = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(s);
  if (fence && fence[1]) s = fence[1].trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  const body = s.slice(a, b + 1);
  const tries = [body, body.replace(/,\s*([}\]])/g, "$1")];
  for (const t of tries) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch (_) {}
  }
  return null;
}
async function pubAiGenerate() {
  if (PUB.aiBusy) return;
  const prov = pubResolveProv();
  if (!prov) {
    pubAiStatus(
      pubT("未配置文本服务商：请到「设置 → 模型服务」添加一个带 API Key 的文本服务商，或直接手填下面的字段（不会自动生成任何内容）。"),
      "warn",
    );
    return;
  }
  if (typeof apiCallTextStream !== "function") {
    pubAiStatus(pubT("调用模块未就绪（apiCallTextStream 不存在），请手填。"), "err");
    return;
  }
  PUB.aiBusy = true;
  if (PUB.dom.aiBtn) {
    PUB.dom.aiBtn.disabled = true;
    PUB.dom.aiBtn.textContent = pubT("生成中…");
  }
  pubAiStatus(pubT("正在读素材并生成…"));
  try {
    const m = await pubCollectMaterial();
    const prompt = pubGenPrompt(m);
    const spec = {
      provider: prov,
      kind: "text",
      model: (prov.models && prov.models[0]) || "",
      temperature: 0.4,
      size: "",
      prompt: prompt,
      texts: [],
      images: [],
      refImage: "",
    };
    const r = await apiCallTextStream(spec, null, null);
    const raw = String((r && r.text) || "");
    const obj = pubParseMetaJson(raw);
    if (!obj) {
      pubAiStatus(pubT("模型没有回可解析的 JSON：已保留原有内容，请手动填写（模型原文没有写进任何字段）。"), "warn");
      return;
    }
    pubApplyMeta(obj);
    pubAiStatus(pubT("已生成并填入：请逐项核对，尤其是功能描述是否属实。"), "ok");
  } catch (err) {
    pubAiStatus(pubT("生成失败：") + pubStr((err && err.message) || err) + pubT("——请手动填写。"), "err");
  } finally {
    PUB.aiBusy = false;
    if (PUB.dom.aiBtn) {
      PUB.dom.aiBtn.disabled = false;
      PUB.dom.aiBtn.textContent = PUB.aiDone ? pubT("重新生成") : pubT("AI 生成");
    }
    pubPaintFoot();
  }
}
/* 把模型给的 JSON 填进表单（只填合法 / 非空的项；模型输出一律走 textContent / value，不拼 HTML） */
function pubApplyMeta(o) {
  const g = (k1, k2) => pubStr(o[k1] != null ? o[k1] : k2 != null ? o[k2] : "");
  const title = g("title").slice(0, PUB_TITLE_MAX);
  const desc = g("description", "desc").slice(0, PUB_DESC_MAX);
  const tags = Array.isArray(o.tags)
    ? o.tags.map((t) => pubStr(t)).filter(Boolean).join(",")
    : g("tags");
  if (title) {
    PUB.form.title = title;
    if (PUB.dom.titleIn) PUB.dom.titleIn.value = title;
    if (!PUB.idTouched && !PUB.idLocked) {
      const s = pubSlug(title);
      if (s.length >= 2) {
        PUB.form.id = s;
        if (PUB.dom.idIn) PUB.dom.idIn.value = s;
      }
    }
  }
  if (desc) {
    PUB.form.description = desc;
    if (PUB.dom.descIn) PUB.dom.descIn.value = desc;
  }
  if (tags) {
    PUB.form.tags = tags.slice(0, PUB_TAGS_MAX);
    if (PUB.dom.tagsIn) PUB.dom.tagsIn.value = PUB.form.tags;
  }
  /* 版本号：用户手改过 / 线上已有同 id（版本按线上最新版 +1）时不套用模型给的版本 */
  const ver = g("version");
  const onlineAppend = !!(PUB.online && PUB.online.exists && PUB.online.mine);
  if (ver && !PUB.verTouched && !onlineAppend && PUB_VERSION_RE.test(ver)) {
    PUB.form.version = ver;
    if (PUB.dom.verIn) PUB.dom.verIn.value = ver;
  }
  PUB.aiDone = true;
  if (PUB.dom.aiBtn) PUB.dom.aiBtn.textContent = pubT("重新生成");
  pubEdit();
}

/* ───────────────── 上传 ───────────────── */

/* 服务端失败 → 给用户看的中文（契约 §7.5：QUOTA_* 的原样中文 + 提示先删旧版） */
function pubErrText(r) {
  const d = (r && r.data) || {};
  const code = pubStr(d.code);
  const msg = pubStr(d.error || (r && r.error));
  const status = Number((r && r.status) || 0);
  if (code === "QUOTA_BYTES" || code === "QUOTA_APPS") {
    /* 契约 §7.5：服务端中文误差原样显示，再补「先删旧版」的出路 */
    const used = d.used != null ? "（" + pubT("当前用量") + "：" + pubBytes(d.used) + "）" : "";
    const lim =
      d.limit != null
        ? "（" + pubT("上限") + "：" + (code === "QUOTA_BYTES" ? pubBytes(d.limit) : d.limit) + "）"
        : "";
    return (msg || pubT("云端配额已满")) + used + lim + "。" + pubT("请先在上面「线上版本」里删掉旧版再试。");
  }
  const CODE_TEXT = {
    UNAUTHORIZED: "未登录或登录已过期：请重新登录后再上传",
    DECLARATION_REQUIRED: "服务端要求勾选声明：请勾上「我已阅读并同意，责任由我承担」再上传",
    APP_EXISTS: "线上已存在这个 id：如果确实是你的应用，请改用「追加版本」（重新打开本窗会自动判断），否则换一个 id",
    APP_TOO_LARGE: "应用包超过云端上限",
  };
  if (code && CODE_TEXT[code]) return CODE_TEXT[code] + (msg ? "（" + msg + "）" : "");
  if (msg) return msg;
  if (status) return pubT("上传失败（HTTP ") + status + "）";
  return pubT("上传失败：") + pubStr((r && r.error) || pubT("未知错误"));
}
function pubSetNote(msg) {
  PUB.note = pubStr(msg);
  pubPaintFoot();
}
async function pubUpload() {
  if (PUB.busy) return;
  const seq = PUB.seq;
  const api = window.api || {};
  /* ① 表单里的 id 与线上状态快照不一致（用户改过 id）→ 先按新 id 重读线上状态，
        再决定走 POST /api/apps 还是 /api/apps/<id>/versions（绝不照旧快照乱打） */
  if (
    PUB.online &&
    pubStr(PUB.online.id) &&
    pubStr(PUB.online.id) !== pubStr(PUB.form.id).toLowerCase()
  ) {
    PUB.busy = true; /* 先占住按钮：这一步也在「上传中」这一串里，别让用户重复点 */
    pubSetNote(pubT("上传中…（⓪ 正在按新的应用 id 重读线上状态）"));
    await pubLoadOnline().catch(() => {});
    PUB.busy = false;
    if (!pubAlive(seq)) return;
  }
  let v = pubValidate();
  if (v.errors.length) {
    pubToast(v.errors[0], "warn");
    pubSetNote(v.errors[0]);
    return;
  }
  if (!(PUB.dom.declCb && PUB.dom.declCb.checked)) {
    pubToast(pubT("请先勾选「我已阅读并同意，责任由我承担」"), "warn");
    return;
  }
  /* 桥再探一次（用户可能刚升级 / 重启过主进程），缺了就如实说，不硬调 undefined */
  pubCheckBridges();
  if (PUB.bridgeMiss) {
    pubToast(pubT("宿主桥未就绪（") + PUB.bridgeMiss + pubT("）：当前版本还不能上架"), "err");
    pubSetNote(pubT("宿主桥未就绪（") + PUB.bridgeMiss + pubT("）：当前版本还不能上架"));
    return;
  }
  const plan = pubIconPlan();
  if (plan.bytes > PUB_ICON_MAX_BYTES) {
    pubToast(pubT("图标超过 500KB 上限"), "warn");
    return;
  }
  PUB.busy = true;
  pubSetNote(pubT("上传中…（① 正在打包应用）"));
  let pack = null;
  try {
    pack = await api.appsExportZip(PUB.appId);
  } catch (err) {
    pack = { ok: false, error: pubStr((err && err.message) || err) };
  }
  if (!pack || pack.ok === false) {
    PUB.busy = false;
    const code = pubStr(pack && pack.error).split(":")[0].trim();
    const EXTRA = {
      missing: "该应用不在本机（可能在别处被删了）",
      missing_entry: "应用缺少入口页：这个应用目录里没有 app.json 声明的入口页",
      need_root: "尚未指定应用安装根目录",
      bad_id: "应用 id 不合法",
    };
    const why = EXTRA[code] || pubStr((pack && pack.error) || pubT("未知错误"));
    pubSetNote(pubT("打包失败：") + why);
    pubToast(pubT("打包失败：") + why, "err");
    return;
  }
  pubSetNote(pubT("上传中…（② 正在读回应用包）"));
  let read = null;
  try {
    read = await api.appsReadZipBase64(PUB.appId);
  } catch (err) {
    read = { ok: false, error: pubStr((err && err.message) || err) };
  }
  if (!read || read.ok === false || !read.base64) {
    PUB.busy = false;
    pubSetNote(pubT("读回应用包失败：") + pubStr((read && read.error) || pubT("未知错误")));
    return;
  }
  if (pack.sha256 && read.sha256 && pubStr(pack.sha256) !== pubStr(read.sha256)) {
    PUB.busy = false;
    pubSetNote(pubT("校验失败：打包与读回的应用包 sha256 不一致，已停止上传（请重试一次）"));
    pubToast(pubT("应用包校验失败：sha256 不一致，未提交"), "err");
    return;
  }
  /* 图标：显式图标优先，否则第 1 张截图（只发这一张，绝不发整组） */
  let iconBase64 = "";
  if (plan.kind === "icon") {
    iconBase64 = pubStripDataUrl(PUB.form.icon.dataUrl);
  } else if (plan.kind === "shot") {
    iconBase64 = await pubShotBase64(PUB.shots[0]);
    if (!iconBase64) {
      pubSetNote(pubT("读取第 1 张截图失败：请改用「图标」选一张本机图片，或重新拍一次窗口"));
      PUB.busy = false;
      return;
    }
  }
  const append = !!(PUB.online && PUB.online.exists && PUB.online.mine);
  const body = {
    acceptDeclaration: true,
    zipBase64: String(read.base64),
    version: v.payload.version,
    entry: v.payload.entry,
    title: v.payload.title,
    description: v.payload.description,
    tags: v.payload.tags,
  };
  if (iconBase64) body.iconBase64 = iconBase64;
  /* 二次开发来源（可选）：只在真声明了才发，绝不发空对象（服务端按「缺字段 = 原创」处理） */
  const fork = PUB.form.forkOf || {};
  if (pubStr(fork.id))
    body.forkOf = {
      id: pubStr(fork.id),
      ownerId: pubStr(fork.ownerId),
      owner: pubStr(fork.owner),
    };
  let path = "/api/apps";
  if (append) {
    path = "/api/apps/" + encodeURIComponent(v.payload.id) + "/versions";
    body.parentVersion = pubStr(PUB.online.latestVersion);
    body.versionNote = v.payload.versionNote;
  } else {
    body.id = v.payload.id;
  }
  pubSetNote(pubT("上传中…（③ 正在上传到云端，请勿关闭窗口）"));
  let r = null;
  try {
    r = await api.storeRequest({ method: "POST", path: path, json: body, timeoutMs: 600000 });
  } catch (err) {
    r = { ok: false, error: pubStr((err && err.message) || err) };
  }
  PUB.busy = false;
  if (!r || r.ok === false) {
    const msg = pubErrText(r);
    pubSetNote(pubT("上传失败：") + msg);
    pubToast(pubT("上传失败：") + msg, "err");
    return;
  }
  const data = r.data || {};
  PUB.showNote = true;
  pubSetNote(pubT("上传成功：") + pubStr((data.item && (data.item.latestVersion || data.item.version)) || v.payload.version));
  pubShowResult(data, append ? "version" : "create");
  pubToast(pubT("上架成功"), "ok");
  /* 本机也记一份（契约 §八）：author = 当前登录账号（云端条目只用 owner 显示作者，本机写
     app.json.author）；forkOf = 本次声明的二次开发来源（随包走 + 本机留档，下次上架自动带回）。 */
  pubWriteLocalMeta().catch(() => {});
  /* 刷新线上状态与配额（版本树 / 用量都要跟着动） */
  pubLoadOnline().catch(() => {});
  pubLoadQuota().catch(() => {});
  try {
    if (typeof window.api.appsCatalog === "function") window.api.appsCatalog(true).catch(() => {});
  } catch (_) {}
}
/* 上架成功后把作者与二次开发来源写回本机 app.json（主进程 apps:setMeta，渲染层不碰文件）。
   写失败不影响上架结果 —— 下次上架时表单照旧会带出来自目录的那一份。 */
async function pubWriteLocalMeta() {
  const api = window.api || {};
  if (typeof api.appsSetMeta !== "function") return;
  const id = pubStr(PUB.appId);
  if (!id) return;
  const patch = {};
  const name = pubStr(PUB.user && PUB.user.username);
  if (name) patch.author = name;
  const fork = PUB.form.forkOf || {};
  patch.forkOf = pubStr(fork.id)
    ? { id: pubStr(fork.id), ownerId: pubStr(fork.ownerId), owner: pubStr(fork.owner) }
    : null;
  try {
    await api.appsSetMeta(id, patch);
  } catch (_) {}
  try {
    if (typeof appsListLoad === "function") await appsListLoad(true);
  } catch (_) {}
}
/* 成功回显（不自动关窗；给「再传一版」） */function pubShowResult(data, mode) {
  const wrap = PUB.dom.result;
  if (!wrap) return;
  wrap.innerHTML = "";
  wrap.hidden = false;
  const item = (data && data.item) || {};
  const cat = (data && data.catalog) || {};
  const head = pubEl("div", "pub-res-head");
  head.appendChild(
    pubEl("span", "pub-res-t", pubT("✓ 上架成功") + (mode === "version" ? pubT("（追加版本）") : pubT("（新建应用）"))),
  );
  head.appendChild(
    pubBtn(pubT("再传一版"), () => pubPrepareNext(), "mini primary"),
  );
  wrap.appendChild(head);
  const rows = [
    [pubT("线上标题"), pubStr(item.title)],
    [pubT("线上版本"), pubStr(item.latestVersion || item.version)],
    [pubT("官网目录条目"), pubStr(cat.zipUrl || cat.url || "")],
    [pubT("包大小"), cat.bytes != null ? pubBytes(cat.bytes) : pubBytes(item.bytes)],
  ];
  for (const [k, v] of rows) {
    const row = pubEl("div", "pub-res-row");
    row.appendChild(pubEl("span", "pub-res-k", k));
    row.appendChild(pubEl("span", "pub-res-v", v || "—"));
    wrap.appendChild(row);
  }
  /* 校验值收进「ⓘ 校验」小按钮（本轮需求：长哈希对普通用户没有意义） */
  const shaVal = pubStr(cat.sha256 || item.sha256);
  if (shaVal) {
    const row = pubEl("div", "pub-res-row");
    row.appendChild(pubEl("span", "pub-res-k", pubT("安装包校验")));
    const vv = pubEl("span", "pub-res-v");
    if (typeof appsHashBtnEl === "function") vv.appendChild(appsHashBtnEl("校验 sha256", shaVal));
    else vv.textContent = pubTrim(shaVal, 20);
    row.appendChild(vv);
    wrap.appendChild(row);
  }
  wrap.appendChild(
    pubEl(
      "div",
      "pub-hint",
      pubT("线上静态目录（catalog.json）由服务端发布流程刷新：客户端目录可能稍后才看到这一版，这不影响上传结果。"),
    ),
  );
}
/* 「再传一版」：清结果块、按新的线上最新版重算默认版本号，其余表单内容留着 */
function pubPrepareNext() {
  if (PUB.dom.result) {
    PUB.dom.result.hidden = true;
    PUB.dom.result.innerHTML = "";
  }
  PUB.verTouched = false;
  const latest = pubStr(PUB.online && PUB.online.latestVersion);
  const next = pubBumpPatch(latest);
  if (next) {
    PUB.form.version = next;
    if (PUB.dom.verIn) PUB.dom.verIn.value = next;
  }
  PUB.form.note = "";
  if (PUB.dom.noteIn) PUB.dom.noteIn.value = "";
  PUB.note = "";
  PUB.showNote = false;
  pubPaintFoot();
  try {
    if (PUB.dom.root && PUB.dom.root.scrollIntoView) PUB.dom.root.scrollIntoView({ block: "start" });
  } catch (_) {}
}

/* ───────────────── 删除旧版本（契约 §7.4 DELETE /api/apps/<id>/versions/<v>） ───────────────── */

async function pubDeleteVersions() {
  const api = window.api || {};
  const id = pubStr(PUB.form.id) || PUB.appId;
  const picked = pubPickedVersions();
  if (!picked.length) return;
  if (typeof api.storeRequest !== "function") {
    pubToast(pubT("上传接口未就绪，无法删除版本"), "err");
    return;
  }
  const ask = pubT("确定删除线上版本 ") + picked.map((v) => "v" + v).join(" / ") + pubT(" 吗？包与版本记录会一起下掉，配额当场释放，不能撤销。");
  let go = false;
  if (typeof confirmDialog === "function") {
    try {
      go = await confirmDialog(ask, { title: pubT("删除线上版本"), okText: pubT("删除"), cancelText: pubT("取消"), danger: true });
    } catch (_) {
      go = false;
    }
  } else {
    go = true; /* 没有确认框模块时不让流程卡住（勾选 + 点按钮本身就是显式动作） */
  }
  if (!go) return;
  const fails = [];
  for (const v of picked) {
    try {
      const r = await api.storeRequest({
        method: "DELETE",
        path: "/api/apps/" + encodeURIComponent(id) + "/versions/" + encodeURIComponent(v),
      });
      if (!r || r.ok === false) fails.push("v" + v + "：" + pubErrText(r));
    } catch (err) {
      fails.push("v" + v + "：" + pubStr((err && err.message) || err));
    }
  }
  if (fails.length) pubToast(pubT("部分版本没删掉：") + fails.join("；"), "err");
  else pubToast(pubT("已删除选中的线上版本"), "ok");
  await pubLoadOnline().catch(() => {});
  await pubLoadQuota().catch(() => {});
}

/* ───────────────── 入口别名 ───────────────── */

window.openAppPublish = openAppPublish;
window.closeAppPublish = pubClose;

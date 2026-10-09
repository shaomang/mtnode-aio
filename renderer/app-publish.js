"use strict";
/* renderer/app-publish.js — 「上架应用」浮层（开发页一键上架：AI 生成元信息 → 核对编辑 →
 * 截图 → 勾选声明 → 上传到 store-saas）
 * ============================================================================
 * 【这个模块干什么】
 *   开发页顶部菜单条「启动」右边的「上架」按钮 → window.openAppPublish(appId) 开一只 #overlay
 *   浮层（persistent；最小化已下线，只有 ✕ / 窗内按钮 / Esc 能关），面向非技术用户的一条流水线：
 *     ① 开窗即拉：本机应用（appsList）、线上状态（该 id 的详情 / 版本树）、账号配额；
 *     ② 可选「AI 生成」：素材 = 应用 app.json（fileReadText）+ 入口页可见文本 + 目录文件清单，
 *        提示词只让模型回一段 JSON，剥 ``` 围栏 + 容错解析；解析不出 / 没有服务商就留空让用户手填，
 *        **绝不伪造元信息**；
 *     ③ 用户核对 / 编辑：标题（必填）、应用 id（**默认锁定**：本机应用 id，或有上架留痕时 =
 *        留痕里的云端 id；要改必须点「修改 id」再过一道二次确认 —— 改 id = 云端会新建一个应用，
 *        不再追加版本，见 pubIdEnsure / pubIdUnlock）、说明、版本号、版本说明、标签、图标；
 *     ④ 截图：**只在点「拍应用窗口」时才启动 / 才拍**（用户口径，本轮改的正是这条）——
 *        开窗不再自动启动应用、不再自动拍第 1 张；点「拍应用窗口」时窗口没开 / 最小化会先
 *        自动启动再拍（pubShotCapture / pubShotWindow），不必回开发页点一次「启动」；
 *        也可以「从本机选图」
 *        （<input type=file> + FileReader，不依赖桥）；最多 8 张，可删 / 可上下排序，**首张 = 封面**；
 *        **8 张全部上传**（body.shotsBase64[]，每项是 base64 字符串或 { sha } 内容引用；
 *        客户端先压一道：长边 2560 / 单张 ≤5MB，超 1MB 转 WebP(0.9)、不行退 JPEG(88)；
 *        服务端再统一收边到长边 2560 并整批落进**内容寻址对象库**（同一张图全站一份），
 *        另出长边 1280 的列表小图；第 1 张同时当 iconBase64（没有显式图标时它就顶图标位，
 *        并按图标口径压到 512 长边 / ≤500KB）；服务端把
 *        **第 1 张当商店封面**（卡片缩略图 icons/<主干>__shot.png，见 appCatalogEntry 的 thumb），
 *        所以「截图传了却不当封面」不再出现；旧口径「只发第 1 张」已废弃，
 *        客户端与服务端同时升级、不做兼容 —— 见 store-saas/server.mjs 的 decodeAppShots。
 *        服务端体检：GET /api/apps/<id>/shots-diag（收了没有 / 落了几个文件 / 静态目录同步没有）。
 *     ⑤ 声明：契约 §7.3 的声明正文逐字展示 + 「我已阅读并同意，责任由我承担」勾选，
 *        未勾选时上传按钮禁用并在页脚说明原因；
 *     ⑥ 上传：appsExportZip（现打一份包，不含画布）→ appsReadZipBase64（同一份包读回 base64，
 *        sha256 与上一步对不上就报错、不提交）→ POST /api/apps（新建）或
 *        POST /api/apps/<id>/versions（线上已有同 id 应用 = 追加版本，带 parentVersion）。
 *        进度只用按钮状态文字与禁用态表达（storeRequest 没有真进度，不做假进度条）。
 *   上传成功后**不自动关窗**：回显线上条目（标题 / 版本 / 官网目录条目）+ 「再传一版」按钮；
 *   同时把「云端 id / 上架账号 / 时间 / 版本」写进本机 app.json 的 cloud 字段（apps:setMeta）——
 *   那是下次默认锁定 id 与离线状态下线上回落判定的唯一依据（见 renderer/app-apps.js 的 appsPublishTraceOf）。
 *   文案口径（本轮需求）：**应用上架统一叫「上架」** —— 新上传（云端新建一条）与更新（往云端已有那条
 *   追加一版）都叫上架；窗标题、状态条、主按钮与成功提示一律写「上架」，只有结果里如实标出这一版
 *   是「新建应用」还是「追加版本」（pubUpdateMode 仍用来分辨这两件事，但不再切成两套叫法）。
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
 *   窗内「取消」、标题栏 ✕、窗内 Esc、再点一次「上架」（最小化已整体下线，标题栏只有 ✕）。
 *   尺寸 = .overlay-box 上的 .app-publish-box 类（css/app-publish.css）+ 右下角手柄拖拽写内联宽高；
 *   openOverlay / closeOverlay 只清内联样式、不清未登记的类，所以类的清理由本文件自己负责
 *   （pubBoxClassOff：开窗时把落在 #overlay 上的残留类摘掉）。
 * ==========================================================================*/

/* ───────────────────────── 常量 ───────────────────────── */

/* 声明正文（**逐字**照 docs/apps-market.md §7.3，服务端 acceptDeclaration === true 才落盘） */
const PUB_DECLARATION =
  "本人保证该应用符合中华人民共和国法律法规，不含违法有害内容，不侵犯他人知识产权；因该应用产生的全部责任由上传者承担。";

const PUB_MAX_SHOTS = 8; /* 截图最多 8 张 */
const PUB_ICON_MAX_BYTES = 500 * 1024; /* 图标上限（契约 §一：png/jpeg/webp ≤500KB） */
/* 截图（大图）口径 —— 与服务端 MAX_APP_SHOT_BYTES / APP_SHOT_MAX_EDGE / APP_SHOT_LIST_EDGE 同源：
   · 单张 ≤5MB（原来是 500KB）：允许超过 1MB 的高清界面图；
   · 提交前客户端先压一道（长边 2560；**超 1MB 转 WebP(0.9)**，转不了退 JPEG(88)）；
   · 压完仍超 5MB → 再压一档（长边 1920 / 质量各降一档），仍超才拒（并直说「请先裁切/转小」）；
   · 服务端另出长边 1280 的列表小图（懒生成），列表只下小图、详情才下 2560 原图。 */
const PUB_SHOT_MAX_BYTES = 5 * 1024 * 1024;
const PUB_SHOT_MAX_EDGE = 2560;
const PUB_SHOT_RETRY_EDGE = 1920;
const PUB_SHOT_WEBP_MIN_BYTES = 1024 * 1024; /* 超过这个体积的图才转 WebP（小图原样传，不白掉画质） */
const PUB_ICON_EDGE = 512; /* 拿截图当图标时收到这个长边（服务端图标上限仍是 500KB） */
const PUB_TITLE_MAX = 80;
const PUB_DESC_MAX = 2000;
const PUB_NOTE_MAX = 200;
const PUB_TAGS_MAX = 200;
/* 上架链路「一次请求最多能带多少字节」的兜底值（真源在服务端：storage.uploadLimitBytes，
   见 server.mjs 的 MAX_BODY_APP_UPLOAD=96MB）。客户端只用它做**上传前预检** ——
   超了就在本地停下并说清，不让用户盯着「上传中」等网关拒掉。 */
const PUB_UPLOAD_LIMIT_FALLBACK = 96 * 1024 * 1024;
const PUB_QUOTA_BYTES = 50 * 1024 * 1024; /* 契约 §7.5：MAX_ACCOUNT_APP_BYTES */
const PUB_QUOTA_APPS = 5; /* 契约 §7.5：MAX_ACCOUNT_APPS */
const PUB_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/; /* 2-64 位、不以符号开头 */
/* 自动拍窗口截图的重试（本轮需求：不必再回开发页点「启动」）：
   主进程 apps:openWindow 是 show 之后才画的（ready-to-show 才 show），刚开就拍会拿到空图 /
   一张白页 —— 所以启动后按 PUB_SHOT_WAIT_MS 的间隔重拍，PUB_SHOT_TRIES 次都拿不到才认失败。 */
const PUB_SHOT_TRIES = 8;
const PUB_SHOT_WAIT_MS = 700;
const PUB_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/; /* 服务端 normalizeVersion 同口径 */
const PUB_ICON_TYPES = ["image/png", "image/jpeg", "image/webp"];
const PUB_RESERVED_IDS = [
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/* 窗内状态（每次开窗重置；浮层只开一只、开新窗就是原地换窗，所以它必须够用） */
const PUB = {
  appId: "",
  app: null, /* 本机应用摘要（api.appsList 的那条） */
  seq: 0, /* 异步回来时对不上的就丢弃 */
  loggedIn: false,
  user: null,
  /* 登录态探测的两条尾巴（页脚据此说清「为什么传不了」）：
     authChecked=主进程验过一次（false = 还没验完，页脚不急着下结论）；
     authError=这次探测的坏消息（网络不通 / 服务端报错），有本机会话时只提示、不当「未登录」 */
  authChecked: false,
  authError: "",
  /* 开窗后那串异步读取（登录态 → 线上状态 → 配额）的完成信号：
     渲染层平时不需要它，但没有它就只能靠 setTimeout 猜「读完没有」——
     测试与将来的「上架前自查」都从这里等（见 window.__mtnodeAppPublish）。 */
  load: null,
  bridgeMiss: "", /* 关键桥缺失时的说明（storeRequest / appsExportZip …） */
  online: null, /* {known, exists, mine, id, latestVersion, versions:[], item} */
  quota: null, /* {apps, bytes, at, error, limitBytes, appsLimit, usedBytes} —— 上限取服务端回执，拿不到用默认 */
  /* 这次见到过的「云端已有这张图」内容指纹（sha256 → 1）：同一张图第二次提交只发 { sha } 引用。
     三处来源合并，判断错也有服务端的 OBJ_NOT_FOUND 兜住（那一轮自动改成发字节）：
       · 服务端目录条目下发的 shotsSha（只覆盖「我的应用」）；
       · 本机指纹索引 <数据目录>/store-imgfp.json（主进程按云端主机分桶 —— 跨会话复用）；
       · 本次开窗时向服务端批量问过的（POST /api/apps/objects/exist —— 别人传过的同一张图也命中）。 */
  shaSeen: null,
  shaSeenPersist: null, /* 本机那份指纹集合（主进程读回来的，开窗时装载） */
  shaSeenHost: "", /* 本机指纹按这个键分桶（云端主机，见 pubStoreHost） */
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
  idUnlocked: false, /* 本窗内已过二次确认、id 允许编辑（改回锁定值会自动恢复锁定） */
  lockedId: "", /* 锁定的那个 id：有上架留痕 = 留痕里的云端 id，否则 = 本机应用 id */
  localId: "", /* 本机应用的 id（安装目录名）—— 与 lockId 不同时界面明说，避免用户以为改错了 */
  trace: null, /* 本机上架留痕（app.json 的 cloud，见 renderer/app-apps.js 的 appsPublishTraceOf） */
  verTouched: false, /* 用户手改过版本号 → 不再套用默认值 */
  tagsTouched: false, /* 用户手改过标签 → 线上状态回来时不再覆盖（见 pubHydrateTags） */
  aiBusy: false,
  aiDone: false,
  busy: false,
  /* 上传这一轮的临时缓存（只活在本窗内，关窗即丢；本轮需求：失败重试不必重来）：
     packRetry     = 已打好的 zip + 读回的 base64（打包要读全目录并逐文件 deflate，大应用几十秒）；
     shotPrepRetry = 每张截图压缩后的结果与内容指纹（压 8 张 2560 长边 + 逐张 sha256 是最慢的一段）；
     roundId       = 这一轮的编号：变了就整体重来，绝不跨轮串味；
     retryReady    = 上一轮失败过 → 页脚给「重试上传」（不重打包、不重压图）。 */
  packRetry: null,
  shotPrepRetry: null,
  roundId: 0,
  retryReady: false,
  shotsLocal: null, /* 最近一次本机截图缓存的写入回执（{saved,total,bytes}，仅供自查） */
  note: "", /* 页脚状态文字（上传进度 / 成功提示） */
  showNote: false, /* true = 页脚钉住上面那条结果（上传成功），直到用户改动表单或点「再传一版」 */
  shotBusy: false, /* 正在拍（避免连点叠着拍） */
  dom: Object.create(null),
};

/* ───────────────────────── 小工具 ───────────────────────── */

function pubT(s, vars) {
  return window.I18n && I18n.t ? I18n.t(s, vars) : String(s == null ? "" : s);
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

/* ── 图片压缩 + 内容指纹（本轮需求的客户端一半）────────────────────────────────
 * 两件事：
 *   ① **压**：单张放宽到 5MB 之后，客户端先自己收一道 —— 长边 2560；超 1MB 转 WebP(0.9)
 *      （转不了退 JPEG(88)）；压完仍超 5MB 再压一档（长边 1920 + 质量降档），仍超才拒。
 *      「原图本来就不大」时**原样返回、不重编码**（不白掉画质、也不白烧 CPU）。
 *   ② **指纹**：算 sha256 = 服务端内容寻址图片库的对象名。同一张图第二次提交时只发
 *      { sha } 引用、不发字节 —— 这就是「会缓存、避免反复占用云服务器流量」在客户端这一半。
 * 全部走浏览器自带能力（Image + canvas + crypto.subtle），不引任何依赖，也不碰文件系统。
 * ─────────────────────────────────────────────────────────────────────────── */

/* data URL / file:// URL → Image（浏览器原生解码；能解 webp / png / jpeg） */
function pubLoadImage(src) {
  return new Promise((resolve) => {
    const url = pubStr(src);
    if (!url) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
/* 画到 canvas 并按指定格式编码：返回 {ok, dataUrl, bytes}；格式不被支持时 ok:false（调用方退一档） */
function pubCanvasEncode(img, w, h, mime, quality) {
  try {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    const ctx = cv.getContext("2d");
    if (!ctx) return { ok: false };
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const dataUrl = cv.toDataURL(mime, typeof quality === "number" ? quality : undefined);
    /* 浏览器不认这个格式时会**静默回 PNG**：这时 bytes 会明显大于原图，靠字节数判定不靠谱，
       所以再用前缀核对一次 —— 对不上就当这一档不可用，交给调用方退 JPEG。 */
    if (dataUrl.indexOf("data:" + mime) !== 0) return { ok: false };
    return { ok: true, dataUrl: dataUrl, bytes: pubDataUrlBytes(dataUrl), w: cv.width, h: cv.height };
  } catch (_) {
    return { ok: false };
  }
}
/* 逐档收边：先长边 2560（WebP 0.9 → JPEG 88），还超 5MB 再 1920（WebP 0.85 → JPEG 80）。 */
function pubEncodeShotFit(img, dataUrl, maxBytes, maxEdge, qualityDrop) {
  const sw = Number(img.naturalWidth || img.width) || 0;
  const sh = Number(img.naturalHeight || img.height) || 0;
  const long = Math.max(sw, sh) || 0;
  const scale = long > maxEdge ? maxEdge / long : 1;
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const webpQ = Math.max(0.5, 0.9 - qualityDrop);
  const jpgQ = Math.max(0.5, 0.88 - qualityDrop);
  const tries = [
    { mime: "image/webp", q: webpQ },
    { mime: "image/jpeg", q: jpgQ },
  ];
  let best = null;
  for (const t of tries) {
    const one = pubCanvasEncode(img, w, h, t.mime, t.q);
    if (!one.ok) continue;
    if (!best || one.bytes < best.bytes) best = one;
    if (one.bytes <= maxBytes) return one;
  }
  return best;
}
/* 一张截图 → 提交用的一版：{ dataUrl, bytes, w, h, changed, srcBytes, reason }。
 * 返回 null 表示这张图连不上（读不出来）；压不下去时返回 { tooLarge:true, ... } 让调用方指名报错。 */
async function pubPrepareShot(src, opts) {
  const maxBytes = Number((opts && opts.maxBytes) || PUB_SHOT_MAX_BYTES);
  const kind = pubStr(opts && opts.kind) || "shot";
  const srcUrl = pubStr(src);
  if (!srcUrl) return null;
  const srcBytes = pubDataUrlBytes(srcUrl) || Number((opts && opts.srcBytes) || 0) || 0;
  const img = await pubLoadImage(srcUrl);
  if (!img) return null;
  const sw = Number(img.naturalWidth || img.width) || 0;
  const sh = Number(img.naturalHeight || img.height) || 0;
  /* 图标（封面小图）：一律收到 512 长边内且 ≤500KB —— 与服务端图标口径一致。
     为什么不能直接拿截图当图标：截图放宽到 5MB 之后，第一张图动辄几百 KB～几 MB，
     直接顶图标位会被服务端按「图标 ≤500KB」拒掉（那正是原来「自动缩放」要解决的问题）。 */
  if (kind === "icon") {
    const scale = Math.min(1, PUB_ICON_EDGE / (Math.max(sw, sh) || 1));
    const iw = Math.max(1, Math.round(sw * scale));
    const ih = Math.max(1, Math.round(sh * scale));
    let best = null;
    for (const t of [{ mime: "image/webp", q: 0.9 }, { mime: "image/jpeg", q: 0.88 }]) {
      const one = pubCanvasEncode(img, iw, ih, t.mime, t.q);
      if (!one.ok) continue;
      if (!best || one.bytes < best.bytes) best = one;
      if (one.bytes <= maxBytes) return { dataUrl: one.dataUrl, bytes: one.bytes, w: one.w, h: one.h, changed: true, srcBytes: srcBytes, tooLarge: false };
    }
    if (!best) return { tooLarge: true, dataUrl: "", bytes: srcBytes, w: sw, h: sh, srcBytes: srcBytes };
    return { dataUrl: best.dataUrl, bytes: best.bytes, w: best.w, h: best.h, changed: true, srcBytes: srcBytes, tooLarge: best.bytes > maxBytes };
  }
  /* 截图：本来就在档内（≤1MB 且长边 ≤2560）→ 原样传，不重编码 */
  const long = Math.max(sw, sh) || 0;
  if (srcBytes && srcBytes <= PUB_SHOT_WEBP_MIN_BYTES && long <= PUB_SHOT_MAX_EDGE) {
    return { dataUrl: srcUrl, bytes: srcBytes, w: sw, h: sh, changed: false, srcBytes: srcBytes, tooLarge: srcBytes > maxBytes };
  }
  let best = pubEncodeShotFit(img, srcUrl, maxBytes, PUB_SHOT_MAX_EDGE, 0);
  if ((!best || best.bytes > maxBytes)) {
    const again = pubEncodeShotFit(img, srcUrl, maxBytes, PUB_SHOT_RETRY_EDGE, 0.05);
    if (again && (!best || again.bytes < best.bytes)) best = again;
  }
  /* 编码反而更大（例如原图已是高压缩 JPEG）→ 用小的那一份 */
  if (best && best.bytes >= srcBytes && srcBytes <= maxBytes) {
    return { dataUrl: srcUrl, bytes: srcBytes, w: sw, h: sh, changed: false, srcBytes: srcBytes, tooLarge: false };
  }
  if (!best) return { dataUrl: srcUrl, bytes: srcBytes, w: sw, h: sh, changed: false, srcBytes: srcBytes, tooLarge: srcBytes > maxBytes };
  return {
    dataUrl: best.dataUrl,
    bytes: best.bytes,
    w: best.w,
    h: best.h,
    changed: true,
    srcBytes: srcBytes,
    tooLarge: best.bytes > maxBytes,
  };
}
/* data URL → sha256（十六进制）。crypto.subtle 不可用（极老内核 / 非安全上下文）时回 ""，
   调用方据此退回「每次都传字节」的老行为 —— 只是不省流量，绝不因此报错。 */
async function pubSha256Of(dataUrl) {
  try {
    const b64 = pubStripDataUrl(dataUrl);
    if (!b64) return "";
    const bin = atob(b64.replace(/\s+/g, ""));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const sub = window.crypto && window.crypto.subtle;
    if (!sub || typeof sub.digest !== "function") return "";
    const d = await sub.digest("SHA-256", buf);
    return Array.prototype.map.call(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch (_) {
    return "";
  }
}
/* 本窗这次见到过的「云端已有这张图」指纹（会话级即可）：值 = 1。
   来源三处：服务端回执里的 catalog.shotsSha / item.shotsSha、本次上传成功的那些，
   以及主进程按云端主机存下来的本机指纹索引（跨会话复用，见 pubImgFpLoad）。 */
function pubShaSeenOf() {
  if (!PUB.shaSeen) PUB.shaSeen = Object.create(null);
  return PUB.shaSeen;
}
/* 云端主机的短名（本机指纹索引按它分桶）：先问主进程（storeHost = 真实的 store 基址），
   桥不可用就退回 default —— 分桶只是为了「换站不互相污染」，退回一个桶不影响功能。
   结果缓存进 PUB.shaSeenHost（只为界面文字 / 调试可读，取主机的部分）。 */
async function pubImgFpHost() {
  if (PUB.shaSeenHost) return PUB.shaSeenHost;
  let host = "";
  try {
    const api = window.api || {};
    if (typeof api.storeHost === "function") {
      const r = await api.storeHost();
      const base = r && r.ok ? pubStr(r.host) : "";
      if (base) host = String(new URL(base).host || base);
    }
  } catch (_) {}
  PUB.shaSeenHost = host || "default";
  return PUB.shaSeenHost;
}
/* 开窗时把本机那份指纹读回来（主进程按 host 分桶）。桥不可用 / 老主进程就安静跳过：
   退化成纯会话级缓存，功能不受影响，只是下次开窗会多问一次服务端。 */
async function pubImgFpLoad() {
  const api = window.api || {};
  PUB.shaSeenPersist = PUB.shaSeenPersist || Object.create(null);
  if (typeof api.storeImgFpLoad !== "function") return 0;
  const host = await pubImgFpHost();
  try {
    const r = await api.storeImgFpLoad({ host: host });
    const list = r && r.ok && Array.isArray(r.shas) ? r.shas : [];
    for (const h of list) {
      const k = pubStr(h).toLowerCase();
      if (/^[0-9a-f]{64}$/.test(k)) PUB.shaSeenPersist[k] = 1;
    }
  } catch (_) {}
  return Object.keys(PUB.shaSeenPersist).length;
}
/* 本机指纹写回（只追加、由主进程封顶 500 条）：失败不影响上架，只是下次还得多问一遍。 */
function pubImgFpPut(list) {
  const api = window.api || {};
  const shas = (Array.isArray(list) ? list : [])
    .map((h) => pubStr(h).toLowerCase())
    .filter((k) => /^[0-9a-f]{64}$/.test(k));
  if (!shas.length || typeof api.storeImgFpPut !== "function") return;
  PUB.shaSeenPersist = PUB.shaSeenPersist || Object.create(null);
  for (const k of shas) PUB.shaSeenPersist[k] = 1;
  try {
    Promise.resolve(
      pubImgFpHost().then((host) => api.storeImgFpPut({ host: host, shas: shas })),
    ).catch(() => {});
  } catch (_) {}
}
function pubShaSeenAdd(list) {
  const seen = pubShaSeenOf();
  for (const h of Array.isArray(list) ? list : []) {
    const k = pubStr(h).toLowerCase();
    if (/^[0-9a-f]{64}$/.test(k)) seen[k] = 1;
  }
}
/* 「云端已有」判定：会话表 + 本机索引（同步读，调用点在提交循环里） */
function pubShaSeenHas(h) {
  const k = pubStr(h).toLowerCase();
  if (!k) return false;
  if (pubShaSeenOf()[k]) return true;
  return !!(PUB.shaSeenPersist && PUB.shaSeenPersist[k]);
}
/* 把某个指纹从「云端已有」表里摘掉（服务端回了 OBJ_NOT_FOUND，说明它其实没有）。
   本机那份只在本窗内先摘掉：主进程那份保留写入权限，删它得再开一条桥，不值得为这种罕见情况加通道。 */
function pubShaSeenForget(h) {
  const k = pubStr(h).toLowerCase();
  if (!k) return;
  delete pubShaSeenOf()[k];
  if (PUB.shaSeenPersist) delete PUB.shaSeenPersist[k];
}
/* 提交前**一次**批量问服务端「这几张云端有没有」（POST /api/apps/objects/exist）：
   命中的并进「云端已有」表 —— 别人传过的同一张图也能只发引用、不推字节。
   这是省流量的**加速**手段：接口不存在（老服务端）/ 网络抖动都安静跳过，照旧发字节。 */
async function pubServerHasShots(allShas) {
  const api = window.api || {};
  if (typeof api.storeRequest !== "function") return 0;
  const want = [];
  const seen = new Set();
  for (const h of Array.isArray(allShas) ? allShas : []) {
    const k = pubStr(h).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(k) || seen.has(k) || pubShaSeenHas(k)) continue;
    seen.add(k);
    want.push(k);
    if (want.length >= 64) break;
  }
  if (!want.length) return 0;
  let r = null;
  try {
    r = await api.storeRequest({ method: "POST", path: "/api/apps/objects/exist", json: { shas: want }, timeoutMs: 20000 });
  } catch (_) {
    return 0;
  }
  const have = r && r.ok && r.data && Array.isArray(r.data.have) ? r.data.have : [];
  const ok = have.map((h) => pubStr(h).toLowerCase()).filter((k) => /^[0-9a-f]{64}$/.test(k));
  pubShaSeenAdd(ok);
  return ok.length;
}
/* ── 上架体积预检（本轮需求：不再「上传中卡住半天才失败」）─────────────────────────
 * 上架请求是一条 JSON：zipBase64 + iconBase64 + shotsBase64[]，base64 后约是原始体积的 1.34 倍。
 * 服务端给出的那条上架链路上限（storage.uploadLimitBytes，默认 96MB）是**真源** ——
 * 客户端拿它当闸门，超了就在本地停下并说清「包多大 / 上限多少 / 怎么办」，
 * 绝不再让用户盯着「上传中」等网关把我们拒掉。
 * 估算里对包宽放一档（已知体积 24MB 上限的旧服务端也走同一条路）：拿不到精确 zip 体积时
 * 用 max(已知本机应用体积, 上一次打包体积) 兜。返回 { tooBig, text, estimate, limit }。 */
function pubUploadLimitBytes() {
  const n = Number(PUB.online && PUB.online.uploadLimitBytes);
  return Number.isFinite(n) && n >= 1024 * 1024 ? n : PUB_UPLOAD_LIMIT_FALLBACK;
}
function pubPreflightSize(shotBytes, iconBytes) {
  const est = (Number(shotBytes) || 0) + (Number(iconBytes) || 0);
  if (!est) return { tooBig: false, estimate: 0, limit: pubUploadLimitBytes() };
  const limit = pubUploadLimitBytes();
  const projected = Math.round(est * 1.34) + Math.round(((Number(PUB.app && PUB.app.bytes) || 0) * 1.34));
  /* 只对「明显超限」的情况拦（留 10% 余量）：不因为估算误差把本来能传的包挡回去 */
  const tooBig = projected > limit * 0.9;
  return {
    tooBig: tooBig,
    estimate: projected,
    limit: limit,
    text: tooBig
      ? pubT("这一轮要传的内容约 ") + pubBytes(projected) + pubT("，超过上架链路的上限 ") + pubBytes(limit) +
        pubT("：请先删掉几张截图、或把素材（图片 / 音频）压小后再上传。")
      : "",
  };
}

/* 给同窗其它模块用（renderer/app-apps.js 的「编辑」窗提交截图时走同一套压缩 + 指纹口径）：
   它是 window 上的一颗只读入口，不改变本模块的任何状态。 */
window.MTNodePublishImg = {
  prepare: pubPrepareShot,
  sha256Of: pubSha256Of,
  addSeen: pubShaSeenAdd,
  seenHas: pubShaSeenHas,
  forget: pubShaSeenForget,
  maxShotBytes: PUB_SHOT_MAX_BYTES,
  maxEdge: PUB_SHOT_MAX_EDGE,
  iconEdge: PUB_ICON_EDGE,
  webpMinBytes: PUB_SHOT_WEBP_MIN_BYTES,
};

/* ───────────────── 共享 #overlay 窗壳：尺寸类 + 手柄 ───────────────── */

function pubShellBox() {
  const ov = document.getElementById("overlay");
  return ov ? ov.querySelector(":scope > .overlay-box") : null;
}
/* 摘掉落在「当前窗」上的尺寸类（最小化已下线，只可能是本窗自己的残留）。
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

/* ───────────────── 纯计算：版本 / 地址 ───────────────── */

/* 标题 → 应用 id 的 slug（pubSlug）本轮**已删**：用户口径是「任何状态下 id 都不再被标题改写」，
   那两处调用（标题输入框、AI 生成回填）都去掉了，函数留着只会让人以为还有这条隐式联动。
   「新建应用」对话框那条 slug（renderer/app-app-flow.js 的 appSlugFromTitle）是另一件事：
   那里是在决定本机应用目录名，不属于上架窗，未动。 */

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

/* ───────────── 应用 id：默认锁定 + 「修改 id」二次确认（本轮需求）─────────────
 * 用户口径（本轮共识）：
 *   · id 就是云端那条应用的身份，也是别人本机的安装目录名 —— 默认一律锁定：
 *     有上架留痕（app.json 的 cloud）就锁到**留痕里的云端 id**，没有就锁到**本机应用 id**；
 *     首次上架同样锁（以前会由英文标题自动改写 id，那条联动本轮**彻底去掉**）。
 *   · 要改只能点「修改 id」，先过一道二次确认（明说「会新建一个应用、以后就算两条了」），
 *     确认后本窗内解锁可编辑；改回锁定值自动恢复锁定。
 *   · id 真改了 = 另一个应用：版本号回 1.0.0、二次开发来源重算、线上状态按新 id 重新读
 *     （pubIdCommit）。**本机应用目录名不动** —— 上架只是把包传到那个 id 下。 */

/* 上架留痕：本机这一份是从哪个云端 id / 哪个账号上架上去的。唯一真源在 renderer/app-apps.js
   （appsPublishTraceOf）；那里缺了（测试 / 老渲染层）就地按同一口径归一，绝不因此掀窗。 */
function pubTrace(app) {
  try {
    if (typeof appsPublishTraceOf === "function") return appsPublishTraceOf(app) || null;
  } catch (_) {}
  const c = app && app.cloud;
  if (!c || typeof c !== "object") return null;
  const id = pubStr(c.id).toLowerCase();
  if (!id) return null;
  return {
    id: id,
    ownerId: pubStr(c.ownerId),
    owner: pubStr(c.owner),
    version: pubStr(c.version),
    at: Number(c.at) || 0,
  };
}
/* 这次提交是「云端新建一条」还是「往已有那条追加版本」—— 结果文案里标出（新建应用 / 追加版本）
   的唯一判据；**不再用它切「上架 / 更新」两套叫法**（用户口径：都叫上架）：
   · 线上读到结果：我名下已有这个 id → 追加版本；线上没有这个 id → 新建一条；
   · 线上读不到（离线 / 未登录 / 接口异常）→ 退回本机留痕（pubTraceUpdate）。 */
function pubUpdateMode() {
  const o = PUB.online;
  if (o && o.known !== false) return !!(o.exists && o.mine);
  return pubTraceUpdate();
}
/* 线上读不到时的回落：留痕的云端 id = 本次 id，且账号对得上（**未登录不比账号** ——
   用户口径：未登录也乐观认这条留痕，点下去先要求登录，进窗拿到账号后再收口）。 */
function pubTraceUpdate() {
  const t = PUB.trace;
  if (!t) return false;
  if (pubStr(PUB.form.id).toLowerCase() !== t.id) return false;
  const u = PUB.user || {};
  const myUid = pubStr(u.id);
  const myName = pubStr(u.username || u.nickname).toLowerCase();
  if (!PUB.loggedIn || (!myUid && !myName)) return true;
  if (myUid && t.ownerId) return myUid === t.ownerId;
  if (myName && t.owner) return myName === t.owner.toLowerCase();
  return true; /* 留痕里没记账号（老数据）→ 认它 */
}
/* 开窗时定这一窗的 id 基线与锁定值（openAppPublish 调一次；appsList 的摘要是权威来源） */
function pubIdEnsure(appId, app) {
  PUB.localId = pubStr(appId).toLowerCase();
  PUB.trace = pubTrace(app);
  PUB.lockedId = PUB.trace && PUB.trace.id ? PUB.trace.id : PUB.localId;
  PUB.form.id = PUB.lockedId;
  PUB.idCommitted = PUB.lockedId;
  PUB.idUnlocked = false;
}
/* 已经解锁、但用户把 id 改回了锁定值（或有留痕时的云端 id）→ 本次仍是更新，自动恢复锁定 */
function pubIdRelockIfSame() {
  if (!PUB.idUnlocked) return;
  if (pubStr(PUB.form.id).toLowerCase() !== pubStr(PUB.lockedId).toLowerCase()) return;
  PUB.idUnlocked = false;
  PUB.form.id = PUB.lockedId;
  if (PUB.dom.idIn) PUB.dom.idIn.value = PUB.lockedId;
  pubPaintId();
}
/* 「修改 id」：二次确认（改 id = 云端新建一个应用，不再追加版本）→ 本窗内解锁 */
async function pubIdUnlock() {
  if (PUB.idUnlocked) return;
  const ask =
    pubT("改应用 id 会在云端新建一个应用：这次不再追加到「") +
    pubStr(PUB.lockedId) +
    pubT("」名下，以后它就是另一条应用（也算新的一条配额）。确认要改 id 吗？");
  let go = true;
  if (typeof confirmDialog === "function") {
    try {
      go = await confirmDialog(ask, {
        title: pubT("修改应用 id"),
        okText: pubT("修改 id"),
        cancelText: pubT("取消"),
      });
    } catch (_) {
      go = false;
    }
  }
  if (!go || !PUB.dom.idIn || !document.contains(PUB.dom.idIn)) return;
  PUB.idUnlocked = true;
  pubPaintId();
  try {
    PUB.dom.idIn.focus();
    PUB.dom.idIn.select();
  } catch (_) {}
}
/* id 真的改了：按新 id 重算这一窗里一切「跟着 id 走」的东西（版本号 / 来源 / 线上状态）。
   版本号回 1.0.0 是硬口径：新应用的第一版不该继承旧应用攒到 1.2.3 的号。 */
function pubIdCommit() {
  PUB.idCommitted = pubStr(PUB.form.id).toLowerCase();
  PUB.verTouched = false;
  PUB.form.version = "1.0.0";
  if (PUB.dom.verIn) PUB.dom.verIn.value = "1.0.0";
  PUB.online = null; /* 线上状态是照旧 id 读的：先清掉，免得旧结论被当成新 id 的 */
  pubForkFill(); /* 二次开发来源按新 id 重算（同 id 已有条目 → 自动指向主干作者） */
  pubPaintId();
  pubPaintHead();
  pubPaintFoot();
  pubEdit();
  pubLoadOnline().catch(() => {});
}
/* id 那一行的状态（锁定 / 已解锁 / 本机目录名提示）：任何改动 id 的路径都要重画它 */
function pubPaintId() {
  const idIn = PUB.dom.idIn;
  const btn = PUB.dom.idBtn;
  const hint = PUB.dom.idHint;
  const lk = pubStr(PUB.lockedId);
  const local = pubStr(PUB.localId);
  const same = pubStr(PUB.form.id).toLowerCase() === lk.toLowerCase();
  if (idIn) {
    idIn.readOnly = !PUB.idUnlocked;
    idIn.title = PUB.idUnlocked
      ? pubT("已解锁：改完就是另一个应用（云端会新建一条，不再追加版本）")
      : pubT("id 默认锁定：要改先点右边「修改 id」（会二次确认）");
  }
  if (btn) {
    btn.disabled = !!PUB.idUnlocked;
    btn.title = btn.disabled
      ? pubT("已经解锁：直接改上面的 id（改回原值会自动恢复锁定）")
      : pubT("改 id = 在云端新建一个应用（点它先二次确认）");
  }
  if (!hint) return;
  if (PUB.idUnlocked && !same) hint.textContent = pubT("已改 id：本次会在云端新建一个应用");
  else if (PUB.idUnlocked) hint.textContent = pubT("已解锁：改回 ") + lk + pubT(" 会自动恢复锁定");
  else if (local && local !== lk) hint.textContent = pubT("已锁定（上架留痕）：本机目录名 ") + local;
  else hint.textContent = pubT("已锁定");
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
  /* 本机凭据快照在手 → 先按已登录画（openAppPublish 已验过 pubAuthUser()）；
     快照为空（凭据读不回来 / 账户模块未就绪）→ 标成「还没核完」，等 pubLoadAuth 的服务器回执下结论，
     别在用户面前先闪一句「未登录」。 */
  const snap = pubLocalUser();
  PUB.authChecked = !!snap;
  PUB.authError = snap
    ? ""
    : pubT("本机没读到登录凭据：正在向账户服务确认这个账号…");
  PUB.online = null;
  PUB.quota = null;
  PUB.shots = [];
  PUB.verTouched = false;
  PUB.tagsTouched = false;
  PUB.aiBusy = false;
  PUB.aiDone = false;
  PUB.busy = false;
  PUB.note = "";
  PUB.shotBusy = false;
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
  /* 应用 id：默认锁定，锁定值 = 留痕里的云端 id（有上架留痕时）否则本机应用 id；
     本机目录名另存一份，两者不同时界面明说（见 pubIdEnsure / pubPaintId）。 */
  pubIdEnsure(id, app);
  /* 关键桥探测（缺 storeRequest / appsExportZip / appsReadZipBase64 时页脚直接说清楚，别等点了才炸） */
  pubCheckBridges();

  /* 标题口径（本轮需求）：上架统一叫「上架」—— 窗标题固定写「上架应用」，
     是新建一条还是给已有那条追加一版，由窗内状态条与结果回显如实说明。 */
  openOverlay(
    pubT("上架应用") + " · " + pubStr(app.name || id),
    { persistent: true, min: true },
  );
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
  pubPaintId();
  pubPaintShots();
  pubPaintOnline();
  pubPaintQuota();
  pubPaintFoot();

  /* 异步：登录态（主进程账户契约）→ 线上状态 + 版本树 → 配额（按顺序，后一步要知道账号名）。
     这一串挂到 PUB.load 上：调用方（开发页按钮）照旧不等它，测试 / 自查可以 await 它。 */
  PUB.load = pubLoadAll(pubSeqNow()).catch(() => false);
  /* 截图**不**在开窗时动手（本轮需求改口径：开窗不启动应用、不拍照）——
     只有用户点「拍应用窗口」才走 pubShotWindow → pubShotCapture（窗口没开或最小化时它才自动启动）。 */
  return true;
}

/* 开窗后的读取顺序：先确认登录态，再读线上状态，最后统计配额（同一份 PUB.seq 守卫）。
   登录态没核到（未登录 / 服务器不认这个会话）时后面两步没有意义：线上状态与配额都要账号名，
   读出来只会是「接口不可达」之类的次生错误，把真正的病根（登录态）盖掉。
   末尾顺带把本机那份「云端已有这张图」的指纹索引读回来（与网络无关，失败也不影响上面三步）。 */
async function pubLoadAll(seq) {
  const ok = await pubLoadAuth(seq).catch(() => false);
  if (!pubAlive(seq) || !ok) return;
  await pubLoadOnline().catch(() => {});
  if (!pubAlive(seq)) return;
  await pubLoadQuota().catch(() => {});
  await pubImgFpLoad().catch(() => 0);
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

  /* 顶部：应用名 + 本机版本 + 登录账号 + 线上状态 */
  const head = pubEl("div", "pub-head");
  const who = pubEl("div", "pub-head-who");
  who.appendChild(pubEl("span", "pub-app-name", pubStr(PUB.app.name || PUB.appId)));
  who.appendChild(pubEl("span", "pub-chip", pubT("本机版本") + " v" + pubStr(PUB.app.version || "0.0.0")));
  who.appendChild(pubEl("span", "pub-chip", pubStr(PUB.app.entry || "index.html")));
  /* 登录账号就摆在窗内（上架是「以哪个账号上传」的事，用户不该去顶栏找答案） */
  const sess = pubEl("span", "pub-chip pub-chip-auth");
  PUB.dom.authChip = sess;
  who.appendChild(sess);
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

  /* 标题（必填）—— 本轮起**标题不再改写应用 id**（见 pubApplyMeta 与 pubIdEnsure 的说明） */
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
    pubEdit();
  });

  /* 应用 id：默认锁定（本机应用 id / 上架留痕里的云端 id），要改必须点「修改 id」并过二次确认。
     为什么锁：id 就是云端那条应用的身份（也是别人本机的安装目录名）—— 一次静默改名 = 云端多出
     一个应用、以后每次「更新」都对不上，所以默认不给改，改了就得先确认自己知道后果。 */
  const idIn = pubEl("input", "pub-in");
  idIn.type = "text";
  idIn.id = "pubId";
  idIn.maxLength = 64;
  idIn.placeholder = "my-app";
  idIn.value = PUB.form.id;
  PUB.dom.idIn = idIn;
  const idHint = pubEl("span", "pub-count", "");
  PUB.dom.idHint = idHint;
  const idBtn = pubBtn(pubT("修改 id"), () => pubIdUnlock(), "mini");
  PUB.dom.idBtn = idBtn;
  const idField = pubEl("div", "pub-field");
  const idLab = pubEl("label", "pub-lab", pubT("应用 id（安装目录名）"));
  idLab.htmlFor = "pubId";
  const idLine = pubEl("div", "pub-labline");
  idLine.appendChild(idLab);
  idLine.appendChild(idHint);
  idField.appendChild(idLine);
  const idRow = pubEl("div", "pub-id-row");
  idRow.appendChild(idIn);
  idRow.appendChild(idBtn);
  idField.appendChild(idRow);
  idField.appendChild(
    pubEl(
      "div",
      "pub-hint",
      pubT("2-64 位小写字母 / 数字 / . _ -，以字母或数字开头；不能是 con / nul / com1 这类 Windows 保留名。默认锁定为本机应用 id：点「修改 id」可以改，但改 id = 在云端新建一个应用（会先让你确认一次）。"),
    ),
  );
  sec.appendChild(idField);
  idIn.addEventListener("input", () => {
    /* 锁定态下的双保险：readOnly 本该挡住输入，真被输入进来了就退回锁定值，绝不接受静默改名 */
    if (!PUB.idUnlocked) {
      idIn.value = pubStr(PUB.lockedId);
      PUB.form.id = idIn.value;
      pubPaintId();
      pubEdit();
      return;
    }
    idIn.value = idIn.value.toLowerCase();
    PUB.form.id = idIn.value;
    pubIdRelockIfSame();
    pubEdit();
  });
  idIn.addEventListener("blur", () => {
    if (!PUB.idUnlocked) {
      idIn.value = pubStr(PUB.lockedId);
      PUB.form.id = idIn.value;
      pubPaintId();
      pubEdit();
      return;
    }
    idIn.value = pubStr(idIn.value).toLowerCase();
    PUB.form.id = idIn.value;
    pubIdRelockIfSame();
    /* id 真变了 = 这是另一个应用了：版本号 / 来源 / 线上状态一律按新 id 重算（见 pubIdCommit） */
    if (pubStr(PUB.form.id) !== pubStr(PUB.idCommitted)) pubIdCommit();
    else {
      pubPaintId();
      pubEdit();
    }
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
  /* 说明框下的「预览」（本轮需求）：与「编辑应用」窗同一颗按钮、同一份 renderMarkdown，
     点一下就地展开渲染结果、再点收起（helper 在 app-apps.js，按 typeof 探测调用）。 */
  if (typeof appsDescPreviewEl === "function") {
    sec.appendChild(appsDescPreviewEl({ text: () => PUB.form.description, t: pubT, toast: pubToast }));
  }
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
    /* 用户自己动过标签 → 线上状态回来时不再用线上那份覆盖他填的内容（见 pubHydrateTags） */
    PUB.tagsTouched = true;
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
  wrap.appendChild(sel);
  const hint = pubEl("div", "pub-hint", "");
  PUB.dom.forkHint = hint;
  wrap.appendChild(hint);
  pubForkFill();
  return wrap;
}

/* 填充「基于哪个应用二次开发」下拉（同 id 多分支，§十）：
 *   · 线上这个 id 已经有条目（含别人先占的）→ 自动指向**主干作者**（createdAt 最早那条）
 *     并**锁定不可改**（q8：id 一致时自动二次开发），提示里写清「改 id 就取消」；
 *   · 线上没有这个 id → 回到本机已有声明（app.json.forkOf / 安装账本）或原创，可自由改。 */
function pubForkFill() {
  const sel = PUB.dom.forkSel;
  if (!sel) return;
  const cur = PUB.form.forkOf || { id: "", ownerId: "", owner: "" };
  const auto = pubAutoForkOf();
  const keyOf = (x) => pubStr(x.id) + "\u0000" + pubStr(x.ownerId) + "\u0000" + pubStr(x.owner);
  const opt = (value, text) => {
    const o = pubEl("option");
    o.value = value;
    o.textContent = text;
    return o;
  };
  sel.innerHTML = "";
  if (!auto) sel.appendChild(opt("", pubT("（原创：不声明来源）")));
  const choices = pubForkChoices();
  let matched = false;
  for (const c of choices) {
    if (auto && keyOf(auto) === keyOf(c)) matched = true;
    sel.appendChild(
      opt(
        keyOf(c),
        "v" + (c.version || "0.0.0") + " · " + c.title + " · " + c.id + " · " + pubT("作者 ") + (pubAuthorNameOf(c) || pubT("未知")),
      ),
    );
  }
  /* 自动指向 / 带出来的那一条不在目录里（源已下架 / 目录没拉到）：补一项，别让用户的声明被悄悄丢掉 */
  if ((auto || cur.id) && !matched) {
    const one = auto || cur;
    sel.appendChild(
      opt(keyOf(one), pubT("（已声明）") + one.id + (pubAuthorNameOf(one) ? " · " + pubT("作者 ") + pubAuthorNameOf(one) : "")),
    );
  }
  sel.value = auto ? keyOf(auto) : cur.id ? keyOf(cur) : "";
  if (auto) {
    PUB.form.forkOf = { id: pubStr(auto.id), ownerId: pubStr(auto.ownerId), owner: pubStr(auto.owner) };
    PUB.form.forkLocked = true;
  } else {
    PUB.form.forkLocked = false;
  }
  sel.disabled = !!auto;
  sel.title = auto
    ? pubT("这个应用 id 线上已经有条目：本次上架自动声明为它的二次开发分支（同一个 id 下建你自己的分支）。想改来源就换一个应用 id。")
    : pubT("声明后云端条目会记下「二次开发自」这个应用（源 id + 原作者 uid），客户端就能在同一条分支树上看到它。");
  sel.onchange = () => {
    /* 锁定（自动声明）时下拉是 disabled，change 根本不会来；这里只管开放态 */
    const v = pubStr(sel.value);
    if (!v) PUB.form.forkOf = { id: "", ownerId: "", owner: "" };
    else {
      const parts = v.split("\u0000");
      PUB.form.forkOf = { id: pubStr(parts[0]), ownerId: pubStr(parts[1]), owner: pubStr(parts[2]) };
    }
    pubEdit();
  };
  if (PUB.dom.forkHint) {
    PUB.dom.forkHint.textContent = auto
      ? pubT("同一个 id 在线上已经有条目：本次会自动声明为「基于它的二次开发」，并新建**你自己的一条分支**（主干在最左、你的分支向右延伸）。唯一取消方式 = 把上面的应用 id 改成别的。")
      : pubT("声明后云端条目会记下「二次开发自」这个应用（源 id + 原作者 uid），别人的客户端就能在你的版本与它之间「切换分支」。选「原创」= 不声明，不影响上架；声明也会写进本机 app.json（随包走），以后再上架会自动带回。");
  }
}
/* 线上这个 id 的主干作者（自动声明目标）：同 id 条目里 createdAt 最早那条；
   目录没拉到就退回已经读到的线上条目本身。 */
function pubAutoForkOf() {
  const o = PUB.online;
  if (!o || o.known === false || !o.exists) return null;
  const list = Array.isArray(o.branches) && o.branches.length
    ? o.branches
    : [{ id: o.id, ownerId: o.ownerId, owner: o.owner, createdAt: o.createdAt }];
  const sorted = list
    .filter((b) => b && pubStr(b.id))
    .slice()
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  const trunk = sorted[0];
  if (!trunk) return null;
  const id = pubStr(trunk.id) || pubStr(PUB.form.id);
  const ownerId = pubStr(trunk.ownerId);
  if (!id || !ownerId) return null;
  return { id: id, ownerId: ownerId, owner: pubStr(trunk.owner) };
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
  /* 常驻说明单独一行：pubShotStatus 会覆盖掉 PUB.dom.shotStatus 里的文字（状态行），
     而「第 1 张就是商店封面」这条口径不该被状态消息顶掉 —— 它是本轮修的那个 bug 的唯一提示。 */
  sec.appendChild(
    pubEl("div", "pub-hint", pubT("最多 8 张，第 1 张同时当商店封面（卡片与详情头部都用它）与图标（没单独选图标时）。开窗不会自动启动这个应用、也不会自动拍：点「拍应用窗口」才启动它并拍（窗口没开或最小化时会自动帮你启动）；一张都不加就上传的话，商店卡片会没有封面。")),
  );
  const st = pubEl("div", "pub-hint", pubT("加一张截图：第 1 张就是商店里这张卡的封面。"));
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
  /* 常驻结果行（本轮需求：删除结果不再只靠一闪而过的 toast）：
     成功说清删了什么，失败留服务端原话 + 「重试」，重画版本区也不会把它冲掉。 */
  const res = pubEl("div", "pub-hint pub-ver-result", "");
  res.hidden = true;
  PUB.dom.verResult = res;
  sec.appendChild(res);
  host.appendChild(sec);
}
/* 版本区结果行：msg 为空 = 收起。retry 给了就补一颗「重试」按钮（失败时用）。 */
function pubVerResult(msg, kind, retry) {
  const el = PUB.dom.verResult;
  const text = pubStr(msg);
  if (!el) {
    if (text) pubToast(text, kind);
    return;
  }
  el.innerHTML = "";
  el.hidden = !text;
  el.className = "pub-hint pub-ver-result" + (kind ? " pub-" + kind : "");
  el.textContent = text;
  if (text && typeof retry === "function") {
    el.appendChild(document.createTextNode(" "));
    el.appendChild(pubBtn(pubT("重试"), retry, "mini"));
  }
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
  const auth = PUB.dom.authChip;
  if (auth) {
    const u = PUB.user || {};
    /* 自己这一格也守同一条口径：昵称优先，占位账号名 / uid 不显示（都没有就只写「已登录」） */
    const name = pubAuthorNameOf({ ownerName: u.nickname, owner: u.username });
    auth.textContent = PUB.loggedIn
      ? pubT("已登录") + (name ? "：" + name : "")
      : PUB.authChecked
        ? pubT("未登录")
        : pubT("正在读取登录态…");
    auth.className =
      "pub-chip pub-chip-auth" + (PUB.loggedIn ? "" : PUB.authChecked ? " pub-err" : "");
  }
  const chip = PUB.dom.onlineChip;
  if (!chip) return;
  const o = PUB.online;
  let text = "";
  if (!o) text = pubT("正在读取线上状态…");
  else if (o.known === false) text = pubT("线上状态未知（接口不可达）；上传时以服务端判断为准");
  else if (!o.exists) text = pubT("首次上架（线上还没有这个 id）");
  else if (o.mine) text = pubT("上架：当前线上 v") + pubStr(o.latestVersion || "");
  else if (o.myBranch) text = pubT("同 id 已有 ") + (Number(o.branches && o.branches.length) || 1) + pubT(" 条作者分支（本次为你的新版本）");
  else
    text =
      pubT("同 id 已有 ") + (Number(o.branches && o.branches.length) || 1) + pubT(" 条作者分支，主干作者：") +
      pubStr(o.branches && o.branches[0] ? pubBranchLabel(o.branches[0], o.branches) : o.ownerName || "") +
      pubT("（本次会在同 id 下新建你的分支）");
  chip.textContent = text;
  chip.className =
    "pub-chip pub-chip-online" +
    (!o ? "" : o.known === false ? " pub-warn" : !o.exists ? " pub-new" : o.mine ? "" : " pub-warn");
  pubPaintTitle();
}
/* 窗标题（本轮需求：统一叫「上架」）：openOverlay 开的那一只 #ovTitle 恒写「上架应用」。
   线上状态读回来时照旧重画一次 —— 标题里的应用名可能刚跟着表单刷新。 */
function pubPaintTitle() {
  const el = document.getElementById("ovTitle");
  const root = PUB.dom.root;
  if (!el || !root || !document.contains(root)) return;
  el.textContent =
    pubT("上架应用") + " · " + pubStr(PUB.app && (PUB.app.name || PUB.app.id) || PUB.appId);
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
    /* 云端带出来的那张（from: "cloud"）地址是服务端下发的 shots/<主干>/<n>，没有 dataUrl 也没有
       本机路径 —— 预览直接用它（主机白名单见 index.html 的 CSP img-src）；拉不到就收起来，
       别在列表里留一张破图（它照样会被带进上传体）。 */
    const src = s.dataUrl ? s.dataUrl : s.url ? s.url : pubFileUrl(s.path);
    if (src) {
      img.src = src;
      img.addEventListener("error", () => {
        img.hidden = true;
      });
    }
    card.appendChild(img);
    if (i === 0) card.appendChild(pubEl("span", "pub-shot-cover", pubT("封面")));
    const meta = pubEl("div", "pub-shot-meta");
    meta.appendChild(
      pubEl("div", "pub-shot-name", pubTrim(s.name || pubT("截图"), 18) + (s.from === "cloud" ? pubT("（云端已有）") : "")),
    );
    const prep = s.prepared || null;
    const showBytes = prep && prep.bytes ? prep.bytes : s.bytes;
    meta.appendChild(
      pubEl(
        "div",
        "pub-shot-sub",
        showBytes ? pubBytes(showBytes) + (s.w && s.h ? " · " + s.w + "×" + s.h : "") : pubT("云端已有：只发内容指纹"),
      ),
    );
    /* 这一轮实际会上传多少（压过 / 云端已有只发引用）：作者一眼看得出缓存有没有生效 */
    if (prep) {
      meta.appendChild(
        pubEl(
          "div",
          "pub-shot-sub",
          prep.reused
            ? pubT("云端已有：只发内容指纹")
            : prep.changed
              ? pubT("已压缩 ") + pubBytes(Number(prep.srcBytes) || 0) + pubT(" → ") + pubBytes(prep.bytes || 0)
              : pubT("原样上传（已在档内）"),
        ),
      );
    }
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
/* 云端已有截图 → 上架窗截图条目（**纯函数**：不碰 DOM、不碰 PUB）——口径的唯一一处。
 * 入参：服务端条目 item（带 shots[] 与 shotsSha[]）+ 已经加过的那些图 stay（保持原位）。
 * 出参：[{key,path,dataUrl,url,sha,name,bytes,from:"cloud"}]，超过 8 张的部分直接截掉。
 * 为什么单独一个纯函数：这段「哪几张、什么顺序、带不带指纹」的判定是回归最该钉住的地方
 * （test/smoke-app-publish.js [4.4] 把它与 app-apps.js 的 appsShotsUrlsOf 一起真跑），
 * 也是本轮的 bug 本体（截图带不出来 = 每次更新都像丢了）。 */
function pubCloudShotsOf(item, stay, local) {
  const it = item || {};
  const rels = Array.isArray(it.shots) ? it.shots.filter((x) => typeof x === "string" && x) : [];
  if (!rels.length) return [];
  const urls =
    typeof appsShotsUrlsOf === "function" ? appsShotsUrlsOf(it) : [];
  const shas = Array.isArray(it.shotsSha) ? it.shotsSha : [];
  const keep = Array.isArray(stay) ? stay : [];
  const loc = local && typeof local === "object" ? local : Object.create(null);
  const room = Math.max(0, PUB_MAX_SHOTS - keep.length);
  const out = [];
  for (let i = 0; i < rels.length && out.length < room; i++) {
    const url = pubStr(urls[i]);
    if (!url) continue;
    const sha = pubStr(shas[i]).toLowerCase();
    /* 本机缓存里有同一张图（按内容指纹认）→ **带上本机字节**（本轮需求：截图本地保存）：
       好处有三条 —— ① 云端对象被别人清掉、或作者删掉旧图想重传时，本机有字节能真重传；
       ② 提交时按 sha 认出「云端已有」→ 只发 { sha } 引用，一个字节都不用推；
       ③ 本机存的就是「压缩后上传的那一份」，重算 sha 还是它，不会因为再压一道而变内容。 */
    const hit = sha && loc[sha];
    if (hit) {
      out.push({
        key: "l" + i + "-" + sha.slice(0, 8),
        path: "",
        dataUrl: pubStr(hit.dataUrl),
        url: url,
        sha: sha,
        name: pubT("本机已存 ") + (i + 1),
        bytes: Number(hit.bytes) || 0,
        from: "local",
      });
      continue;
    }
    out.push({
      key: "c" + i + "-" + sha.slice(0, 8),
      path: "",
      dataUrl: "",
      url: url,
      sha: sha,
      name: pubT("云端已有 ") + (i + 1),
      bytes: 0,
      from: "cloud",
    });
  }
  return out;
}

/* 本机那份截图缓存（主进程 <数据目录>/shots-cache/ + store-shots.json 索引）：
   读回 { sha: {dataUrl, bytes, ext, apps} }。桥不可用 / 读失败一律回空表 —— 这只是便利，
   缺了照样能上架（退回老路：从云端 URL 把图带出来），绝不让它挡住主流程。 */
async function pubShotsLocalLoad() {
  const api = window.api || {};
  if (typeof api.storeShotsList !== "function") return Object.create(null);
  try {
    const r = await api.storeShotsList({ withData: true });
    const items = r && r.ok && Array.isArray(r.items) ? r.items : [];
    const map = Object.create(null);
    for (const it of items) {
      const sha = pubStr(it && it.sha).toLowerCase();
      if (!sha || !pubStr(it && it.dataUrl)) continue;
      map[sha] = it;
    }
    return map;
  } catch (_) {
    return Object.create(null);
  }
}

/* 上传成功后把这一批截图（**压缩后的字节**）存进本机缓存（本轮需求：截图本地保存）。
   appId 用云端 id：彻底删除这个应用时按它回收只属于它的那些图（共用的留着）。 */
async function pubShotsLocalSave(appId, list) {
  const api = window.api || {};
  if (typeof api.storeShotsPut !== "function") return null;
  const items = (Array.isArray(list) ? list : [])
    .filter((x) => x && x.sha && x.dataUrl)
    .map((x) => ({ sha: x.sha, dataUrl: x.dataUrl, ext: x.ext || "", bytes: Number(x.bytes) || 0 }));
  if (!items.length) return null;
  try {
    return await api.storeShotsPut({ appId: pubStr(appId), items: items });
  } catch (_) {
    return null;
  }
}

/* 这个应用在云端被彻底删掉之后：回收它**只属于自己**的本地截图缓存
   （被别的应用共用的那些留着 —— 与云端内容寻址对象库同一口径）。 */
async function pubShotsLocalDropApp(appId) {
  const api = window.api || {};
  if (typeof api.storeShotsClear !== "function") return null;
  try {
    return await api.storeShotsClear({ appId: pubStr(appId) });
  } catch (_) {
    return null;
  }
}
/* ── 更新时带出云端已有截图（本轮需求：上传应用要保留截图，每次更新都带着它）─────────────
 * 为什么必须做：上架窗的截图列表**只从本机新加**（拍窗口 / 选本机图），云端已上架那一套根本
 * 不在列表里。于是每次更新都会走到「还没有截图」那道确认框 —— 作者看着像是「截图没了」，
 * 而上传体里也确实一张都不带（老服务端 / 只认 shots 的路径下那批图就真丢）。
 * 口径（三条）：
 *   ① **只在服务端说这条应用是我自己的**（mine.mine）时带出 —— 别人的分支轮不到我们改；
 *   ② 带出来的每张都记下服务端下发的内容指纹 sha256（目录条目的 shotsSha[]）：提交时只发
 *      { sha } 引用，**不重传字节**（与「新加的图云端已有只发引用」同一条口径）；
 *   ③ **已经加过的图不动**（用户开窗后立刻加的图在前面保持原位），云端那批接在后面；
 *      一张都没有时也不报错，只是照旧走「还没有截图」那道确认。
 * 地址一律走 app-apps.js 的 appsShotsUrlsOf（静态目录 / 接口两条来源的**唯一**一处口径）——
 * 它读 APPS_ST.cat 的来源基址，而开发页开窗时目录可能还没读过，所以先按需拉一次目录
 * （appsCatalogLoad 自带 TTL 缓存，读过就是零成本）。失败一律静默跳过：带不出截图是缺便利，
 * 不该让上架窗报错。 */
async function pubShotsPrefillCloud(mine, seq) {
  try {
    const item = mine && mine.item;
    if (!item || !mine.mine || !mine.exists) return 0;
    if (typeof appsShotsUrlsOf !== "function" || typeof appsCatalogLoad !== "function") return 0;
    try {
      await appsCatalogLoad(false);
    } catch (_) {}
    if (!pubAlive(seq)) return 0;
    const stay = PUB.shots.filter((s) => s && s.from !== "cloud" && s.from !== "local");
    /* 本机缓存（可能没有）：有它就把「本机字节」一起带出来 —— 见 pubCloudShotsOf 的注释 */
    const local = await pubShotsLocalLoad();
    if (!pubAlive(seq)) return 0;
    const list = pubCloudShotsOf(item, stay, local);
    if (!list.length) return 0;
    PUB.shots = stay.concat(list);
    pubPaintShots(); /* 内部会重画页脚（pubEdit），卡片与「N/8」都跟着更新 */
    pubShotStatus(
      pubT("云端已有截图 ") + list.length + pubT(" 张（会带着上传，顺序照作者排的；删掉哪张就不再传哪张）。"),
    );
    return list.length;
  } catch (_) {
    return 0;
  }
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

/* 线上版本列表（同 id 多分支，§十）：
   · **我的分支**：勾选框 + 删除按钮（全功能，只能删自己分支的版本）；
   · **其他作者的分支**：只读展示（版本 / 作者 / 时间 / 说明），**不渲染勾选框、不渲染删除按钮**（q7/q23），
     并补一句「这些版本属于账号 x，只能查看」。
   分支树本身复用应用中心的 appsBranchTreeEl（同一个 id 一条分支一行、主干最左）。 */
function pubPaintOnline() {
  const wrap = PUB.dom.versWrap;
  if (!wrap) return;
  wrap.innerHTML = "";
  if (PUB.dom.delVerBtn) {
    PUB.dom.delVerBtn.disabled = true;
    PUB.dom.delVerBtn.hidden = false;
  }
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
    wrap.appendChild(pubEl("div", "pub-hint", pubT("线上还没有这个 id 的应用：本次是新建（POST /api/apps），你这一条就是主干。")));
    return;
  }
  const branches = pubNormBranches(o.branches);
  const myBranch = o.myBranch || pubMyBranchOf(o);
  const others = branches.filter((b) => b !== myBranch);
  /* 分支树（多于一条分支才画）：主干最左、其余向右延伸，每行带作者与本机已装情况 */
  if (branches.length > 1 && typeof appsBranchTreeEl === "function") {
    const tree = appsBranchTreeEl(o.id, {
      branches: branches.map((b) => Object.assign({}, b, { id: o.id })),
      selectedOwnerId: pubStr(myBranch && (myBranch.ownerId || myBranch.owner)),
    });
    if (tree) wrap.appendChild(tree);
  }
  if (!myBranch) {
    /* 这个 id 是别人先占的：本次上传 = 在同 id 下新建**我自己**的分支（q3，自动二次开发） */
    wrap.appendChild(
      pubEl(
        "div",
        "pub-hint pub-warn",
        pubT("线上这个 id 已有 ") + branches.length + pubT(" 条作者分支（主干作者：") +
          pubBranchLabel(branches[0], branches) +
          pubT("）：本次上传会在同一个 id 下新建**你自己的分支**，别人的版本只读。"),
      ),
    );
  }
  /* 我的分支：勾选 + 删除（只列我自己的版本 —— 接口也只允许删自己分支的） */
  const mineVs = myBranch ? pubVersionsOfBranch(myBranch) : [];
  if (myBranch && mineVs.length) {
    const head = pubEl("div", "pub-vers-head", pubT("我的分支") + "（" + pubBranchLabel(myBranch, branches) + "）");
    wrap.appendChild(head);
    for (const v of mineVs) {
      const row = pubEl("label", "pub-ver");
      const cb = pubEl("input");
      cb.type = "checkbox";
      cb.dataset.ver = pubStr(v.version);
      cb.addEventListener("change", () => pubSyncDelBtn());
      row.appendChild(cb);
      const main = pubEl("div", "pub-ver-main");
      main.appendChild(pubEl("span", "pub-ver-no", "v" + pubStr(v.version)));
      /* 「最新」标记：版本树接口给 current；退回 item.versions 时按这一分支的 latestVersion 认 */
      const isCur =
        v.current != null ? !!v.current : pubStr(v.version) === pubStr(pubBranchLatest(myBranch));
      if (isCur) main.appendChild(pubEl("span", "pub-ver-tag", pubT("最新")));
      if (v.parentVersion) main.appendChild(pubEl("span", "pub-ver-tag", pubT("父版 ") + pubStr(v.parentVersion)));
      main.appendChild(
        pubEl(
          "span",
          "pub-ver-sub",
          [pubTime(v.createdAt), pubBytes(v.bytes), pubUploaderOf(v)].filter(Boolean).join(" · "),
        ),
      );
      if (pubStr(v.note)) main.appendChild(pubEl("span", "pub-ver-note", pubStr(v.note)));
      row.appendChild(main);
      wrap.appendChild(row);
    }
  } else if (myBranch) {
    /* 我的分支一版都没有（版本树被删光，或这本来就是一条还没发过版的分支）：
       老服务端没有版本树字段时照旧按「单版记录」说话。 */
    wrap.appendChild(
      pubEl(
        "div",
        "pub-hint",
        pubT("你的分支下还没有版本（或版本已被删光）：本次上传会是它的第一版。"),
      ),
    );
  }
  /* 其他作者的分支：只读，**不渲染勾选框、不渲染删除按钮**（q7） */
  for (const b of others) {
    const isMine = !!b.mine || pubStr(b.ownerId) === pubStr(PUB.user && PUB.user.id);
    const box = pubEl("div", "pub-ver-other" + (isMine ? " is-mine" : ""));
    const head = pubEl("div", "pub-vers-head", pubT("作者 ") + pubBranchLabel(b, branches) + (b.trunk ? " · " + pubT("主干") : ""));
    box.appendChild(head);
    box.appendChild(
      pubEl(
        "div",
        "pub-hint",
        pubT("这些版本属于账号 ") + pubBranchLabel(b, branches) + pubT("：只能查看（切分支下载走「应用详情 → 分支」），不能在这里删除。"),
      ),
    );
    for (const v of pubVersionsOfBranch(b)) {
      const row = pubEl("div", "pub-ver pub-ver-readonly");
      const main = pubEl("div", "pub-ver-main");
      main.appendChild(pubEl("span", "pub-ver-no", "v" + pubStr(v.version)));
      if (pubStr(v.version) === pubStr(pubBranchLatest(b))) {
        main.appendChild(pubEl("span", "pub-ver-tag", pubT("最新")));
      }
      if (v.parentVersion) main.appendChild(pubEl("span", "pub-ver-tag", pubT("父版 ") + pubStr(v.parentVersion)));
      main.appendChild(
        pubEl(
          "span",
          "pub-ver-sub",
          [pubTime(v.createdAt), pubBytes(v.bytes)].filter(Boolean).join(" · "),
        ),
      );
      if (pubStr(v.note)) main.appendChild(pubEl("span", "pub-ver-note", pubStr(v.note)));
      row.appendChild(main);
      box.appendChild(row);
    }
    wrap.appendChild(box);
  }
  /* 这一格原来还有一句「线上已有这个应用（单版记录，没有版本树数据）：本次按追加版本处理。」
     —— 它与上面 `else if (myBranch)` 那一支完全同条件（我的分支一版都没有且没有别人的分支），
     现在按「已下架 / 还没有版本」说得更准，故撤掉，避免两行提示叠在一起。 */
  /* 删除按钮：只有「我的分支有版本」时才显示（别人的分支一律不出现删除入口，q7） */
  if (PUB.dom.delVerBtn && !(myBranch && mineVs.length)) PUB.dom.delVerBtn.hidden = true;
  pubSyncDelBtn();
}

/* ── 同 id 多分支的小工具（都在本文件内，接口回执 / 老回执都能吃） ── */
function pubNormBranches(raw) {
  const out = [];
  for (const b of Array.isArray(raw) ? raw : []) {
    if (!b || typeof b !== "object") continue;
    const ownerId = pubStr(b.ownerId || (b.ownerUser && b.ownerUser.id));
    out.push({
      id: pubStr(b.id),
      ownerId: ownerId,
      owner: pubStr(b.owner),
      nickname: pubStr(b.nickname),
      /* 作者显示名（服务端按 uid 实时解析的昵称；老服务端 / 静态目录没有就是空串） */
      ownerName: pubStr(b.ownerName),
      trunk: !!b.trunk,
      mine: !!b.mine,
      createdAt: Number(b.createdAt) || 0,
      /* latestVersion / versions 都要留住「字段有没有」这一信息（空串 / 空数组 ≠ 没字段）：
         · latestVersion 存在（哪怕空串）= 服务端说这一分支没有当前版了；
         · versions 存在（哪怕空数组）= 版本树被删光。
         老服务端没有这两个字段时，pubVersionsOfBranch / pubBranchLatest 才按单版字段合成。 */
      latestVersion: b.latestVersion != null ? pubStr(b.latestVersion) : pubStr(b.version),
      versions: Array.isArray(b.versions) ? b.versions.slice() : undefined,
    });
  }
  return out.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
}
/* ── 作者显示名（与 renderer/app-apps.js 的 appsAuthorOf **同一口径**，这里自带一份实现：
   本文件会被 test/smoke-app-publish-auth.js 单独装进迷你 VM 跑，不能指望 app-apps.js 已就位） ──
   显示名 = 服务端按 uid **实时解析**的昵称（ownerName / uploaderName）→ 非占位账号名 → 空串
   （空串由调用方显示「未知作者」）。系统自动占位名（微信 / 手机号自动建号生成的 u_xxxxxxxx）
   不算名字，绝不再摊到界面上。 */
const PUB_PLACEHOLDER_NAME_RE = /^u_[0-9a-f]{6,24}$/i;
function pubIsPlaceholderName(name) {
  return PUB_PLACEHOLDER_NAME_RE.test(pubStr(name));
}
function pubAuthorNameOf(b) {
  const s = b || {};
  const nick = pubStr(s.ownerName || s.nickname);
  if (nick) return nick;
  const name = pubStr(s.owner || s.author);
  return pubIsPlaceholderName(name) ? "" : name;
}
/* 版本行的「上传者」显示名：uploaderName 优先；占位名 / uid 一律不显示（返回空串） */
function pubUploaderOf(v) {
  const nick = pubStr(v && v.uploaderName);
  if (nick) return nick;
  const up = pubStr(v && v.uploader);
  return pubIsPlaceholderName(up) ? "" : up;
}
/* 分支标签：显示名；同一个 id 下两条分支昵称相同时补「#<ownerId 末 6 位>」区分
   （传 all = 同 id 的全部分支才会判重名，见 app-apps.js 的 appsBranchLabelOf） */
function pubBranchLabel(b, all) {
  const base = pubAuthorNameOf(b) || pubT("未知作者");
  const list = Array.isArray(all) ? all : null;
  if (!list || base === pubT("未知作者")) return base;
  const key = pubStr(b && (b.ownerId || b.owner));
  const short = pubBranchShortOf(b);
  if (!short) return base;
  const dup = list.some(
    (o) => o && o !== b && pubStr(o.ownerId || o.owner) !== key && (pubAuthorNameOf(o) || pubT("未知作者")) === base,
  );
  return dup ? base + " # " + short : base;
}
function pubBranchShortOf(b) {
  const uid = pubStr(b && b.ownerId);
  if (uid) return uid.slice(-6);
  const name = pubStr(b && b.owner);
  return pubIsPlaceholderName(name) ? "" : name.slice(-6);
}
/* 这一分支的「最新版」：服务端下发了 latestVersion 字段（哪怕空串）就以它为准 ——
   空串 = 这一分支的版本**真被删光了**，绝不再退回 version 字段合成一行
   （线上踩过：删版本成功、界面上那一版还在。服务端那边的同一条口径见 appCurrentVersionOf）。 */
function pubBranchLatest(b) {
  if (!b) return "";
  if (b.latestVersion != null) return pubStr(b.latestVersion);
  return pubStr(b.version || "");
}
/* 这一分支的版本行：**显式空数组**（服务端 versions 字段存在但已空）就是真的没有版本，
   不合成幻行；只有老服务端压根没有 versions 字段时才按单版字段合成一行。 */
function pubVersionsOfBranch(b) {
  const hasField = Array.isArray(b && b.versions);
  const vs = hasField ? b.versions : [];
  if (vs.length) return vs;
  if (hasField) return [];
  const one = pubBranchLatest(b);
  return one ? [{ version: one, createdAt: 0, bytes: 0, note: "" }] : [];
}
/* 我名下那条分支（同 id 同作者只有一条）：先按 uid 认，其次按账号名 */
function pubMyBranchOf(o) {
  const uid = pubStr(PUB.user && PUB.user.id);
  const name = pubUsername();
  for (const b of pubNormBranches(o && o.branches)) {
    if (b.mine) return b;
    if (uid && pubStr(b.ownerId) === uid) return b;
    if (name && pubStr(b.owner).toLowerCase() === name) return b;
  }
  return null;
}
/* 我那条分支已有的最高版本（默认版本号按它 +1，q10：只按我自己分支算） */
function pubMyBranchLatestVersion() {
  const o = PUB.online;
  if (!o || !o.exists) return "";
  const b = o.myBranch || pubMyBranchOf(o);
  if (!b) return "";
  const vs = pubVersionsOfBranch(b);
  let best = pubBranchLatest(b);
  for (const v of vs) {
    const x = pubStr(v.version);
    if (x && (!best || pubVerCmp(x, best) > 0)) best = x;
  }
  return best;
}
/* 这一版号在我自己的分支上**已经存在**吗（版本行里有它，或它就是分支最新版）——
   存在 = 本次上传会「就地覆盖」那一版（版本号不变），见 pubVersionLine 与 pubUpload。 */
function pubVersionExistsOnline(ver) {
  const o = PUB.online;
  const want = pubStr(ver);
  if (!o || !o.exists || o.known === false || !want) return false;
  const b = o.myBranch || pubMyBranchOf(o);
  if (!b) return false;
  const vs = pubVersionsOfBranch(b);
  if (vs.some((x) => pubStr(x.version) === want)) return true;
  return pubStr(pubBranchLatest(b)) === want;
}
/* 版本行那一句提示（上架窗页脚上方）：同一版已在线上时**明说会覆盖**，不再拦人 ——
   用户口径「应用更新时，同版本允许更新覆盖」；服务端就地换包并回 replaced=true。 */
function pubVersionLine(append) {
  const ver = pubStr(PUB.form.version);
  if (append && pubVersionExistsOnline(ver)) {
    return (
      pubT("将覆盖线上已有的 v") +
      ver +
      pubT("：这一版就地换成新包，版本号不变（原先那一版会被替换掉）")
    );
  }
  return append
    ? pubT("将追加版本 v") + ver + pubT("（parentVersion = ") + pubStr(pubMyBranchLatestVersion()) + "）"
    : pubT("将新建应用 v") + ver;
}
/* 版本号比较（与主进程 apps-store.js 的 verCmp 同一口径的精简版：够排 x.y.z 与后缀） */
function pubVerCmp(x, y) {
  const a = pubStr(x).split(/[.+-]/);
  const b = pubStr(y).split(/[.+-]/);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const sa = a[i] == null ? "" : a[i];
    const sb = b[i] == null ? "" : b[i];
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? Number(sa) : null;
    const nb = /^\d+$/.test(sb) ? Number(sb) : null;
    if (na != null && nb != null) return na < nb ? -1 : 1;
    if (na != null) return 1;
    if (nb != null) return -1;
    return sa < sb ? -1 : 1;
  }
  return 0;
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
  /* 上限：服务端回执里的那一份优先（管理员可以在后台给单个用户调，客户端不能拿默认值硬顶），
     拿不到（老服务端 / 还没上传过）才退回契约里的默认值。null = 服务端说不限。 */
  const limB = q.limitBytes === null && q.limitBytes !== undefined ? -1 : Number(q.limitBytes) > 0 ? Number(q.limitBytes) : PUB_QUOTA_BYTES;
  const limA = q.appsLimit === null && q.appsLimit !== undefined ? -1 : Number(q.appsLimit) > 0 ? Number(q.appsLimit) : PUB_QUOTA_APPS;
  const overB = limB >= 0 && used > limB;
  const overA = limA >= 0 && n >= limA;
  const line = pubEl("div", "pub-quota-line");
  line.appendChild(
    pubEl(
      "span",
      "pub-quota-k",
      pubT("云端已用") + " " + pubBytes(used) + " / " + (limB < 0 ? pubT("不限") : pubBytes(limB)),
    ),
  );
  line.appendChild(
    pubEl("span", "pub-quota-k", pubT("应用") + " " + n + " / " + (limA < 0 ? pubT("不限") : String(limA))),
  );
  wrap.appendChild(line);
  if (overB) {
    wrap.appendChild(
      pubEl("div", "pub-hint pub-err", pubT("云端存储已超上限：服务端会以 QUOTA_BYTES 拒绝，先在上面删掉旧版或多余的截图（已存的内容不会被删，只是不能再新增）。")),
    );
  }
  if (overA) {
    wrap.appendChild(
      pubEl("div", "pub-hint pub-err", pubT("应用数量已达上限（追加版本不计入）：服务端会以 QUOTA_APPS 拒绝，先删掉不用的应用。")),
    );
  }
  /* 这次带上来的图里有多少张是「云端已有、只发引用」—— 说清楚，作者才知道缓存真的在省流量 */
  const cached = (PUB.shots || []).filter((s) => s && s.prepared && s.prepared.reused).length;
  if (cached) {
    wrap.appendChild(
      pubEl("div", "pub-hint", pubT("其中 ") + cached + pubT(" 张截图云端已有：这次只发内容指纹，不再重传图片。")),
    );
  }
}

/* 作者动过表单（标题 / 版本 / 标签 / 勾选 / 截图列表…）→ 上一次失败留下的那套缓存作废：
   包的字节与压缩结果都对应「改动之前」那份内容，继续拿它重试就会把旧内容传上去。
   调用点：所有会改变提交体的输入与截图增删排序、以及「再传一版」。
   为什么放在 pubEdit 里：它就是本模块统一的「表单变了」收口（各输入处理都调它）。 */
function pubDropRetryCaches() {
  PUB.retryReady = false;
  PUB.packRetry = null;
  PUB.shotPrepRetry = null;
}
function pubEdit() {
  PUB.showNote = false;
  pubDropRetryCaches();
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
      /* 状态行是复用的一行：上一条状态留下的动作按钮（去登录 / 重试）随文字一起清掉 */
      note.className = "pub-foot-note" + (kind ? " pub-" + kind : "");
    }
    btn.disabled = !enabled;
    /* 主按钮的默认文案（本轮需求：统一叫「上架」）：新上传与追加版本都写「上传上架」 */
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
  /* 上一轮上传失败、缓存还在（包与压缩结果都留着）→ 主按钮换成「重试上传」：
     这一下**不重打包、不重压图**，直接把同一份东西再发一次（本轮需求：卡住/失败后能就地重试）。
     失败原因写在页脚常驻行里；作者改一下表单（截图 / 标题…）就会走 listDirty 清掉缓存回到常态。 */
  if (PUB.retryReady) {
    set(
      PUB.note || pubT("上次上传失败：已保留这一轮打好的包与压缩结果，可直接重试。"),
      "warn",
      true,
      pubT("重试上传"),
    );
    return;
  }
  if (PUB.bridgeMiss) {
    set(pubT("宿主桥未就绪（") + PUB.bridgeMiss + pubT("）：当前版本还不能上架"), "err", false);
    return;
  }
  /* 登录态三条尾巴（这次修的病根）：① 还没核完 → 先别下「未登录」的结论；
     ② 本机会话在、只是这次没核到（网络 / 服务端错）→ 如实说「没核到」并给「重试」，
        绝不说成「未登录：先登录再上传」（那会把已登录的用户指去重新登录，而顶栏还是已登录态）；
     ③ 服务器明确不认这个会话（authMe 已清掉本机凭据）→ 按未登录处理，页脚给「去登录」。 */
  if (!PUB.authChecked) {
    set(pubT("正在读取登录态…"), "", false);
    return;
  }
  if (PUB.loggedIn && PUB.authError) {
    set(PUB.authError, "warn", false);
    pubAuthAction();
    return;
  }
  if (!PUB.loggedIn) {
    /* PUB.authError 存的就是**已经本地化好的文案**：这里不能再套一次 pubT ——
       带 {code} 的模板二次翻译时 vars 已经丢了，页脚会原样印出「HTTP {code}」。 */
    set(PUB.authError || pubT("未登录：先登录再上传"), "err", false);
    pubAuthAction();
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
  const append = !!(PUB.online && PUB.online.exists && PUB.online.myBranch);
  const newBranch = !!(PUB.online && PUB.online.exists && !append);
  set(
    (append
      ? pubVersionLine(true) /* 同号已在线 → 那句「将覆盖线上已有的 vX」 */
      : newBranch
        ? pubT("将在同一个 id 下新建你的分支 v") + pubStr(PUB.form.version)
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
  /* 同 id 多分支（§十）：线上这个 id 被别人占着**不再是错** —— 本次上传会在同 id 下
     新建我自己的一条分支（服务端按 forkOf 声明接受，见附录 §十）。
     **版本号与线上撞车同样不再是错**（用户口径「应用更新时，同版本允许更新覆盖」）：
     同号 = 就地把那一版换成新包、版本号不变，服务端照原样接受并回 replaced=true
     （见 store-saas/server.mjs 的 POST /versions / PATCH 注释）。原来这里回一句
     「你这条分支线上已有版本 vX：请换一个版本号」，等于叫作者放弃他要的那次更新 ——
     界面上改为由 pubVersionLine() 明说「将覆盖 vX」并照常上传。 */
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

/**
 * 上传新版本时**继承原版标签**（客户端这一半）：线上状态读回来之后，把线上条目的 tags
 * 填进表单。
 *
 * 现场：开窗时标签框是空的（PUB.form.tags 只从本机 app.json 带出，标签在云端），
 * 用户不手填就等于把空标签发给服务端 —— 作者一追加版本就把整组标签抹掉。
 * 判据（两层保护里的一层，服务端那份见 store-saas/server.mjs 的 appTagsNext）：
 *   · 用户自己动过这个框（tagsTouched）→ 一个字都不覆盖；
 *   · 表单里已经有内容（本机 app.json 带出来的）→ 不覆盖；
 *   · 线上也没有标签 → 什么都不做。
 * @param {object} item 线上条目（GET /api/apps/<id> 的 item）
 */
function pubHydrateTags(item) {
  if (PUB.tagsTouched) return false;
  if (pubStr(PUB.form.tags)) return false;
  const next = pubTagsOf((item && item.tags) || []);
  if (!next.length) return false;
  PUB.form.tags = next.join(",");
  if (PUB.dom.tagsIn) PUB.dom.tagsIn.value = PUB.form.tags;
  return true;
}

/* ───────────────── 读取：登录态 / 线上状态 / 配额 ───────────────── */

/* 本机登录态快照（app-auth.js 的 window.MTNodeAuth.state()）。
   注意口径：**空快照不等于未登录** —— 主进程的凭据文件读不回来（readIssue）/ 账户模块还没刷新完
   时它同样是空。所以它只用来兜底与显示，真结论一律由 pubLoadAuth 的服务器回执给出。 */
function pubLocalUser() {
  return pubAuthUser();
}
/* 服务器回执 → 登录态与页脚文案（唯一判据入口）。
   · 服务器认这个会话（ok）→ 已登录，顺带把账号名换新；
   · 服务器报别的错（5xx / 403 / 网络不通，status=0）→ **本机会话还在就只提示、不当未登录**，
     页脚说清「登录态没核到」并给「重试」，用户还能照常试一次上传（真实拒绝会由上传自己报出来）；
     本机也没有会话，才按未登录处理。
   · 401（服务器明确不认这个会话）→ 按未登录收口，由 pubLoadAuth 补上失效文案。 */
function pubApplyAuth(r) {
  const status = Number((r && r.status) || 0);
  const code = pubStr(((r && r.data) || {}).code || (r && r.code));
  const local = pubLocalUser();
  if (r && r.ok) {
    PUB.loggedIn = true;
    PUB.user = (r.data && r.data.user) || PUB.user || local;
    PUB.authChecked = true;
    PUB.authError = "";
    return;
  }
  /* 服务器明确不认这个会话（401）：此刻本机会话快照还是旧值，不能因为它「在」就当作已登录 ——
     否则又回到「界面说已登录、上架窗说没核到」。按未登录收口（失效文案由 pubLoadAuth 补上）。 */
  if (status === 401 || code === "UNAUTHORIZED") {
    PUB.loggedIn = false;
    PUB.authChecked = true;
    PUB.authError = "";
    return;
  }
  if (!local) {
    PUB.loggedIn = false;
    PUB.authChecked = true;
    PUB.authError = "";
    return;
  }
  PUB.loggedIn = true;
  PUB.user = PUB.user || local;
  PUB.authChecked = true;
  PUB.authError = status
    ? pubT("登录态没核到（服务端 HTTP {code}）", { code: status })
    : pubT("登录态没核到（连不上账户服务）");
}
/* 服务器回的坏消息（只取中文文案；英文原文 / 未知都退回「账户服务暂时不可用」） */
function pubErrOf(r) {
  const d = (r && r.data) || {};
  const code = pubStr(d.code || (r && r.code));
  if (code === "UNAUTHORIZED") return pubT("登录已失效：请重新登录");
  const msg = pubStr(d.error || (r && r.error));
  if (/[\u4e00-\u9fff]/.test(msg)) return msg;
  const status = Number((r && r.status) || 0);
  return status
    ? pubT("账户服务报错（HTTP {code}）", { code: status })
    : pubT("连不上账户服务，请检查网络");
}
/* 页脚那颗动作按钮：未登录 → 去登录；登录态没核到 → 重试。挂在 state() 已经填好的
   状态行末尾（文字走同一条 set 路径，页面语言 / 颜色都跟状态行一致）。 */
function pubAuthAction() {
  const note = PUB.dom.footNote;
  if (!note) return;
  note.classList.add("pub-note-act");
  const btn = pubEl("button", "mini pub-act", PUB.loggedIn ? pubT("重试读取登录态") : pubT("去登录"));
  btn.type = "button";
  btn.onclick = (ev) => {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (PUB.loggedIn) pubRetryAuth();
    else pubGoLogin();
  };
  note.appendChild(btn);
}
/* 让用户能自己把「服务器认不认这个会话」再验一次（同一次飞行也记进 PUB.load，等它的人一起等） */
function pubRetryAuth() {
  PUB.authChecked = false;
  PUB.authError = "";
  pubPaintFoot();
  PUB.load = pubLoadAuth(pubSeqNow()).catch(() => false);
  return PUB.load;
}

/* 上传被服务端按「未登录」拒绝（401 / UNAUTHORIZED）时的收口：
   本机那份凭据已经死了，别只把错误往页脚一贴 —— 走主进程的账户契约（api.authMe）
   把它清掉并广播，界面各处（顶栏 / 应用库 / 本窗）一起收敛成未登录 + 「去登录」。
   回真 = 已经按这条路径处理（调用方别再重复贴「上传失败：…」）。 */
function pubSessionLost(r, msg) {
  const d = (r && r.data) || {};
  const code = pubStr(d.code || (r && r.code));
  if (Number((r && r.status) || 0) !== 401 && code !== "UNAUTHORIZED") return false;
  PUB.loggedIn = false;
  PUB.user = null;
  PUB.authChecked = true;
  PUB.authError = pubT("登录已失效：请重新登录");
  PUB.showNote = false;
  pubPaintHead();
  pubSetNote(msg || PUB.authError);
  pubToast(PUB.authError, "err");
  const api = window.api || {};
  if (typeof api.authMe === "function") {
    /* 只为副作用调用：主进程在 401 时清本机凭据 + 广播 auth:changed（返回值本身不用） */
    try {
      Promise.resolve(api.authMe()).catch(() => {});
    } catch (_) {}
  }
  if (window.MTNodeAuth && typeof window.MTNodeAuth.refresh === "function") {
    try {
      Promise.resolve(window.MTNodeAuth.refresh()).catch(() => {});
    } catch (_) {}
  }
  return true;
}

/* 登录态：以**主进程的账户契约**为准（window.api.authMe = IPC auth:me）。为什么不用
   storeRequest 裸打 /api/me：auth:me 走的是同一条链路，但它在 401 时会清掉本机那份已失效的
   凭据并广播登录态变化 —— 这是「已登录却显示未登录」这类分叉的唯一收敛点。
   裸打的话，本机凭据文件还留着旧 token、顶栏照旧显示已登录、上架窗说未登录，用户点「去登录」
   又被顶栏当成已登录、找不到重新登录的入口，只能自己想到先退出登录。

   返回 true = 登录态可用（调用方可以继续读线上状态 / 配额）；false = 未登录或登录态没核到。 */
async function pubLoadAuth(seq) {
  const api = window.api || {};
  if (typeof api.authMe !== "function" && typeof api.storeRequest !== "function") {
    PUB.loggedIn = !!pubLocalUser();
    PUB.authChecked = false;
    PUB.authError = pubT("本机账户桥未就绪");
    pubPaintHead();
    pubPaintFoot();
    return PUB.loggedIn;
  }
  let r = null;
  if (typeof api.authMe === "function") {
    try {
      r = await api.authMe();
    } catch (err) {
      r = { ok: false, status: 0, error: pubStr((err && err.message) || err) };
    }
  } else {
    try {
      r = await api.storeRequest({ method: "GET", path: "/api/me" });
    } catch (err) {
      r = { ok: false, status: 0, error: pubStr((err && err.message) || err) };
    }
  }
  if (!pubAlive(seq)) return false;
  const hadLocal = !!pubLocalUser();
  pubApplyAuth(r);
  if (!PUB.loggedIn && hadLocal) {
    /* 走到这儿说明服务器明确不认这个会话（authMe 已把本机凭据清掉）：
       立刻按「未登录」收口 —— 顶栏 / 应用库 / 商店会随 auth:changed 一起收敛，
       省下的是「界面说已登录、上架说未登录」那段分叉。 */
    PUB.authError = pubErrOf(r);
    PUB.user = null;
  }
  pubPaintHead();
  pubPaintFoot();
  return PUB.loggedIn;
}

/* 线上状态：GET /api/apps/<id>（免登录，含 mine / latestVersion / versions）+
   版本树 GET /api/apps/<id>/versions（契约 §7.4）。任何一个成功都算 known。 */
async function pubLoadOnline() {
  const seq = PUB.seq;
  const api = window.api || {};
  const id = pubStr(PUB.form.id) || PUB.appId;
  const mine = {
    known: false,
    exists: false,
    mine: false,
    id,
    ownerId: "",
    latestVersion: "",
    versions: [],
    branches: [],
    owner: "",
    error: "",
  };
  PUB.online = mine;
  pubPaintHead();
  pubPaintOnline();
  pubPaintFoot();
  if (typeof api.storeRequest !== "function" || !id) return;
  let known = false;
  let lost = false; /* 服务端说这个会话不认了（见下面 pubSessionLost） */
  try {
    const r = await api.storeRequest({ method: "GET", path: "/api/apps/" + encodeURIComponent(id) });
    if (!pubAlive(seq)) return;
    if (r && r.ok && r.data && r.data.item) {
      const it = r.data.item;
      known = true;
      mine.exists = true;
      mine.mine = !!it.mine || String(it.owner || "").toLowerCase() === pubUsername();
      mine.owner = pubStr(it.owner);
      /* 显示名（昵称，服务端按 uid 实时解析）——「我这条分支」的标题读它 */
      mine.ownerName = pubStr(it.ownerName);
      mine.ownerId = pubStr(it.ownerId || (it.ownerUser && it.ownerUser.id) || "");
      /* 字段存在就以它为准（空串 = 版本被删光），没有字段才退回单版字段 —— 与 pubBranchLatest 同口径 */
      mine.latestVersion = pubStr(it.latestVersion != null ? it.latestVersion : it.version);
      mine.item = it;
      /* 继承原版标签（本轮需求）：线上有标签、而用户还没动过这个框 → 填回来（见 pubHydrateTags） */
      pubHydrateTags(it);
      if (Array.isArray(it.versions)) mine.versions = it.versions.slice();
      mine.branches = pubNormBranches(r.data.branches || it.branches);
      if (!mine.ownerId) mine.ownerId = pubStr(mine.branches[0] && mine.branches[0].ownerId);
    } else if (r && Number(r.status) === 404) {
      known = true; /* 明确不存在 = 首次上架 */
    } else if (pubSessionLost(r, pubT("线上状态读不到：登录已失效，请重新登录"))) {
      lost = true;
    }
  } catch (_) {}
  /* 版本树（契约 §7.4：免登录；老服务端没有这个路由 → 404 就退回 item.versions） */
  if (!lost) {
    try {
      const r2 = await api.storeRequest({ method: "GET", path: "/api/apps/" + encodeURIComponent(id) + "/versions" });
      if (!pubAlive(seq)) return;
      if (r2 && r2.ok && r2.data) {
        const d = r2.data;
        known = true;
        mine.exists = true;
        if (pubStr(d.ownerId)) mine.ownerId = pubStr(d.ownerId);
        /* 显示名（昵称）：条目接口没读到时用版本树接口那一份，别让「我的分支」退成「未知作者」 */
        if (!mine.ownerName && pubStr(d.ownerName)) mine.ownerName = pubStr(d.ownerName);
        if (pubStr(d.latestVersion)) mine.latestVersion = pubStr(d.latestVersion);
        if (Array.isArray(d.versions)) mine.versions = d.versions.slice();
        const bs = pubNormBranches(d.branches);
        if (bs.length) mine.branches = bs;
      }
    } catch (_) {}
  }
  /* 目录条目里没有 branches（老服务端 / 静态目录）：用已知信息合成「主干一条」，界面照旧只有一条分支 */
  if (mine.exists && !mine.branches.length) {
    mine.branches = [
      {
        id: id,
        ownerId: mine.ownerId,
        owner: mine.owner,
        ownerName: mine.ownerName,
        latestVersion: mine.latestVersion,
        /* 版本树那份读到了（item.versions，可能是空数组）才原样带过来；
           一条都没读到就留 undefined —— 让 pubVersionsOfBranch 按单版字段合成，别把老服务端的
           单版应用画成「没有版本」（那是「字段存在但为空」才该有的样子）。 */
        versions: mine.versions.length ? mine.versions.slice() : undefined,
        trunk: true,
        mine: mine.mine,
      },
    ];
  }
  /* 我的那条分支（同 id 同作者只有一条）：优先按 uid 认，其次按账号名 */
  mine.myBranch = pubMyBranchOf(mine);
  mine.known = known;
  if (!known && !lost) mine.error = pubT("接口不可达或返回异常");
  if (!pubAlive(seq)) return;
  /* id / 版本默认值（同 id 多分支，§十）：
     · id 的锁定**不再由线上状态决定**（本轮需求：任何情况下都默认锁定，锁定值在 pubIdEnsure
       里定好了）—— 这里只在「用户没解锁」时把框里与表单里的值钉回锁定值，防止别的路径改写它；
     · 版本号默认 = **我自己那条分支**的最新版小版本 +1（q10）；我还没有分支时用 1.0.0 / 模型给的版本。 */
  if (!PUB.idUnlocked) {
    PUB.form.id = pubStr(PUB.lockedId);
    if (PUB.dom.idIn) PUB.dom.idIn.value = pubStr(PUB.lockedId);
  }
  const myLatest = pubMyBranchLatestVersion();
  if (mine.exists && !PUB.verTouched) {
    const next = pubBumpPatch(myLatest);
    if (next) {
      PUB.form.version = next;
      if (PUB.dom.verIn) PUB.dom.verIn.value = next;
    }
  }
  if (PUB.dom.verHint) {
    /* 同号已在线：这句提示与页脚那句（pubVersionLine）同一口径 —— 明说会就地覆盖，
       不再叫用户换号（个人口径见 pubValidate 上方注释）。 */
    PUB.dom.verHint.textContent =
      mine.exists && mine.mine && pubVersionExistsOnline(pubStr(PUB.form.version))
        ? pubT("线上已有 v") +
          pubStr(PUB.form.version) +
          pubT("：这一版会就地换成新包（版本号不变）；要留一份旧版请先改成别的版本号再传。")
        : mine.exists && mine.mine
          ? pubT("你这条分支的最新版是 v") + pubStr(myLatest) + pubT("：这次会作为它的新版本追加（parentVersion = ") + pubStr(myLatest) + "）"
          : mine.exists
            ? pubT("这个 id 已有 ") + (Number(mine.branches.length) || 1) + pubT(" 条作者分支：本次会在同一个 id 下新建**你的分支**（版本号从 1.0.0 起算，各分支各算各的）。")
            : pubT("首次上架默认 1.0.0；线上已有你自己这个 id 的分支时会自动取「你那条分支的最新版小版本 +1」。");
  }
  pubPaintId();
  /* 自动二次开发声明跟着 id 重算（q8/q35）：同 id 已有条目 → 指向主干作者并锁定 */
  pubForkFill();
  /* 云端已有那一套截图**带出来**（本轮需求；口径见 pubShotsPrefillCloud）。
     放在线上状态读完、即将收口处：带出来之后 pubPaintShots（含页脚）与版本区都按新的状态重画。 */
  await pubShotsPrefillCloud(mine, seq);
  pubPaintHead();
  pubPaintOnline();
  pubPaintFoot();
}
function pubUsername() {
  return pubStr((PUB.user && (PUB.user.username || PUB.user.nickname)) || "").toLowerCase();
}

/* 配额：GET /api/apps/storage（本轮需求：服务端回**用量 + 该用户的上限**，管理员在后台调过就按调过的走）
   + GET /api/apps?owner=<我>（拿我名下条目里的版本字节，作为老服务端 / 接口缺失时的兜底口径）。 */
async function pubLoadQuota() {
  const seq = PUB.seq;
  const api = window.api || {};
  const me = pubUsername();
  if (typeof api.storeRequest !== "function" || !me) {
    PUB.quota = { apps: 0, bytes: 0, error: me ? "" : pubT("拿不到账号名，无法统计") };
    pubPaintQuota();
    return;
  }
  let out = { apps: 0, bytes: 0, error: "", limitBytes: null, appsLimit: null, uploadLimitBytes: 0, appZipLimitBytes: 0 };
  let gotServer = false;
  try {
    const r0 = await api.storeRequest({ method: "GET", path: "/api/apps/storage" });
    if (!pubAlive(seq)) return;
    const st = r0 && r0.ok && r0.data ? r0.data.storage : null;
    if (st && typeof st === "object") {
      gotServer = true;
      out.bytes = Number(st.usedBytes) || 0;
      out.apps = Number(st.apps) || 0;
      out.limitBytes = st.limitBytes == null ? null : Number(st.limitBytes);
      out.appsLimit = st.appsLimit == null ? null : Number(st.appsLimit);
      out.defaultBytes = Number(st.defaultBytes) || 0;
      out.defaultApps = Number(st.defaultApps) || 0;
      /* 上架链路的两个上限（真源在服务端，客户端据此做上传前预检 —— 见 pubPreflightSize）：
         uploadLimitBytes = 一次请求最多能带多少字节；appZipLimitBytes = 单个应用包上限。 */
      out.uploadLimitBytes = Number(st.uploadLimitBytes) || 0;
      out.appZipLimitBytes = Number(st.appZipLimitBytes) || 0;
      PUB.online = PUB.online || {};
      if (out.uploadLimitBytes) PUB.online.uploadLimitBytes = out.uploadLimitBytes;
      if (out.appZipLimitBytes) PUB.online.appZipLimitBytes = out.appZipLimitBytes;
    }
  } catch (_) {}
  if (!gotServer) {
    /* 老服务端（没有 /api/apps/storage）：退回按我的条目自己加一遍（口径 = 各版本字节之和） */
    try {
      const r = await api.storeRequest({
        method: "GET",
        path: "/api/apps?owner=" + encodeURIComponent(me) + "&pageSize=50",
      });
      if (!pubAlive(seq)) return;
      if (r && r.ok && r.data) {
        const items = Array.isArray(r.data.items) ? r.data.items : Array.isArray(r.data.apps) ? r.data.apps : [];
        out.apps = items.length;
        out.bytes = 0;
        for (const it of items) {
          const vs = Array.isArray(it && it.versions) ? it.versions : null;
          if (vs && vs.length) {
            for (const v of vs) out.bytes += Number(v && v.bytes) || 0;
          } else {
            out.bytes += Number((it && it.bytes) || 0);
          }
        }
      } else if (pubSessionLost(r, pubT("配额读不到：登录已失效，请重新登录"))) {
        /* 会话在服务端已不认：这里只负责让界面收口，配额留空（别把 401 说成「接口不可达」） */
        pubPaintQuota();
        return;
      } else {
        out.error = pubStr((r && r.data && r.data.error) || (r && r.error) || pubT("接口不可达"));
      }
    } catch (err) {
      out.error = pubStr((err && err.message) || err);
    }
  }
  if (!pubAlive(seq)) return;
  PUB.quota = out;
  pubPaintQuota();
}
/* 上传回执里带回来的用量与上限：就地更新配额行（不必再打一次接口）。 */
function pubQuotaFromReply(storage) {
  const st = storage && typeof storage === "object" ? storage : null;
  if (!st) return;
  const q = PUB.quota && typeof PUB.quota === "object" ? PUB.quota : { apps: 0, bytes: 0, error: "" };
  q.bytes = Number(st.usedBytes) || 0;
  q.apps = Number(st.apps) || 0;
  q.limitBytes = st.limitBytes == null ? null : Number(st.limitBytes);
  q.appsLimit = st.appsLimit == null ? null : Number(st.appsLimit);
  q.defaultBytes = Number(st.defaultBytes) || 0;
  q.defaultApps = Number(st.defaultApps) || 0;
  q.uploadLimitBytes = Number(st.uploadLimitBytes) || Number(q.uploadLimitBytes) || 0;
  q.appZipLimitBytes = Number(st.appZipLimitBytes) || Number(q.appZipLimitBytes) || 0;
  q.error = "";
  PUB.quota = q;
  if (q.uploadLimitBytes) {
    PUB.online = PUB.online || {};
    PUB.online.uploadLimitBytes = q.uploadLimitBytes;
    PUB.online.appZipLimitBytes = q.appZipLimitBytes;
  }
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
/* 窗口没开 / 最小化 / 还没画好 —— 这三类的共同点：**再启动一次就能拍**（本轮需求）。
   apps:openWindow 对已存在的窗口走 show() + focus()，最小化也会被它还原；
   对没开的窗口走 ready-to-show 之后 show()，所以调用方要等一拍再重拍（见 pubShotCapture）。 */
function pubShotNeedsBoot(r) {
  const code = pubStr(r && r.code);
  if (code === "not_open" || code === "minimized" || code === "empty_shot") return true;
  return /启动|最小化|窗口|还没画|为空|空图/.test(pubStr(r && r.error));
}
function pubWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
/* 拍一张应用窗口截图：窗口没开 / 最小化就先**自动启动这个应用**（不再要求用户回开发页点「启动」），
   等窗口画出来再拍；最多 PUB_SHOT_TRIES 次。别的错（id 不合法 / 写盘失败）原样往回抛，不重试。 */
async function pubShotCapture() {
  const api = window.api || {};
  const id = PUB.appId;
  let booted = false;
  let last = null;
  for (let i = 0; i < PUB_SHOT_TRIES; i++) {
    let r = null;
    try {
      r = await api.appsShotWindow(id);
    } catch (err) {
      r = { ok: false, error: pubStr((err && err.message) || err) };
    }
    if (r && r.ok !== false) return r;
    last = r;
    if (!pubShotNeedsBoot(r)) return r;
    if (!booted) {
      booted = true;
      pubShotStatus(pubT("正在启动这个应用（窗口没开或已最小化）…"));
      try {
        if (typeof appsOpenApp === "function") await appsOpenApp(id);
      } catch (_) {}
    }
    await pubWait(PUB_SHOT_WAIT_MS); /* 窗口是 show 之后才画的：等一拍再拍，别拍成空白页 */
  }
  return last || { ok: false, error: pubT("拍应用窗口失败") };
}
/* 拍该应用自己的窗口（主进程 appsShotWindow）：只由「拍应用窗口」按钮触发
   （本轮需求：开窗时不再自动启动 / 不再自动拍）。 */
async function pubShotWindow() {
  const api = window.api || {};
  const id = PUB.appId;
  if (typeof api.appsShotWindow !== "function") {
    pubShotStatus(pubT("宿主桥未就绪（appsShotWindow）：当前版本还不能拍应用窗口，请改用「从本机选图」。"), "err");
    return false;
  }
  if (PUB.shotBusy) {
    /* 正在拍：给一行状态，别让点击看起来没反应 */
    pubShotStatus(pubT("正在拍应用窗口…"));
    return false;
  }
  PUB.shotBusy = true;
  const seq = PUB.seq;
  pubShotStatus(pubT("正在拍应用窗口…"));
  let r = null;
  try {
    r = await pubShotCapture();
  } finally {
    PUB.shotBusy = false;
  }
  if (seq !== PUB.seq || !PUB.dom.root || !document.contains(PUB.dom.root)) return false;
  if (!r || r.ok === false) {
    const msg = pubStr((r && r.error) || pubT("拍应用窗口失败"));
    pubShotStatus(pubT("拍应用窗口失败：") + msg, "err");
    /* 仍然没拍成（例如桥不通 / 应用目录出问题）→ 给一条手动重试的路，不替用户反复试 */
    const bar = PUB.dom.shotStatus;
    if (bar && typeof appsOpenApp === "function") {
      bar.appendChild(document.createTextNode(" "));
      bar.appendChild(pubBtn(pubT("启动这个应用"), () => {
        try {
          appsOpenApp(id);
        } catch (_) {}
      }, "mini"));
      bar.appendChild(document.createTextNode(" "));
      bar.appendChild(pubBtn(pubT("重试"), () => pubShotWindow().catch(() => {}), "mini"));
    }
    return false;
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
  if (ok) {
    pubShotStatus(
      pubT("已加入第 ") + PUB.shots.length + pubT(" 张（第 1 张是封面）。"),
    );
  }
  return ok;
}
/* 「开窗自动启动 + 自动拍第 1 张」（pubAutoShot / PUB.autoShotDone）本轮已按用户口径**整条撤掉**：
   开窗不再启动应用、不再拍照；只有点「拍应用窗口」才启动（窗口没开或最小化时）并拍。 */
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
    /* 本轮起**不再**由标题改写应用 id（用户口径：任何状态下 id 都不再被标题改写）——
       模型给的中文标题照样不会把 id 换成别的名字，要改 id 只能点「修改 id」+ 二次确认。 */
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
    /* 同 id 多分支（§十）：这个 id 已被别人占用时，服务端要求声明来源才会新建你的分支 */
    APP_EXISTS:
      "这个应用 id 已被其他账号占用：本次应自动声明为「基于该应用的二次开发」再上传（同一个 id 下建你自己的分支）。若来源下拉被清空了，请把应用 id 改回原 id 后重试。",
    BRANCH_EXISTS: "你名下已经有这个 id 的应用：请直接追加版本（重新打开本窗会自动判断），不要新建分支。",
    /* 老服务端才会回这个码（本轮起同版本号 = 就地把那一版换成新包，见 store-saas/server.mjs
       的 POST /versions 注释）：原文案是「请换一个版本号再上传」——那等于叫作者放弃他要的更新。
       这里如实说明这一发没上去的**原因**（服务端版本旧），并给出唯一的出路（换号先传）。 */
    VERSION_EXISTS:
      "云端服务端是旧版本（还不支持同版本号覆盖更新）：这一版没传上去。请把服务端升级到最新，或先换一个版本号上传。",
    BRANCH_REQUIRED: "这个 id 下有多条作者分支：删版本请指明分支（本窗会自动带上你自己那条）。",
    APP_TOO_LARGE: "应用包超过云端上限",
    /* 删版本这条链的失败码（本轮需求：失败的**原因**要看得懂，不再只回一句「没删掉」） */
    VERSION_NOT_FOUND: "服务端说这一版不存在（可能已被删过，或界面上这一版不是服务端的真版本记录）：点「重新读取」刷一遍版本区",
    APP_VERSIONS_DISABLED: "服务端未启用应用多版本（单版模式）：这一版删不掉，要彻底删掉这个应用请在「我的应用」里删除它",
    BRANCH_NOT_FOUND: "这个 id 下没有你这个账号的分支：删版本只作用于自己的分支",
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
  /* 这一轮是「失败后的重试」还是「用户重新点的一次上传」？
     判据：上一轮失败过且还留着缓存（retryReady）→ 沿用这一轮的包与压缩结果（同 roundId）；
     否则开新的一轮（roundId+1），旧缓存整体作废。
     为什么用 roundId 而不是直接复用对象：截图列表可能被作者改过（删掉一张 / 换个顺序），
     同一轮重试的前提是「列表一个字都没动」—— 改动会走 pubPaintShots → pubFormChanged 清掉缓存。 */
  if (!PUB.retryReady) {
    PUB.roundId++;
    PUB.packRetry = null;
    PUB.shotPrepRetry = null;
  }
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
  /* 一张截图都没有就上传（本轮需求：撤掉「开窗自动拍第 1 张」之后，这条路会真的走到）：
     商店卡片与详情头部都会没有封面（没单独选图标时，图标本来也取自第 1 张截图）。
     不静默放过、也不硬拦 —— 说清后果，用户确认了才传。
     本轮补一句口径：**已经上架过**（云端有我这条分支）时，这一轮本来就不带截图字段，
     云端那一套原样留着（见下面 shotsBase64 的注释），既不会丢也不会被清空。 */
  if (!PUB.shots.length) {
    PUB.busy = true; /* 先占住按钮：确认框开着时别让第二次点击又走一遍 */
    const hasCloud = !!(PUB.online && PUB.online.exists && PUB.online.mine);
    let go = true;
    if (typeof confirmDialog === "function") {
      try {
        go = await confirmDialog(
          pubT("还没有截图：商店卡片与详情头部会没有封面（没有单独选图标时，图标也取自第 1 张截图）。确定现在上传吗？") +
            (hasCloud ? pubT("这条应用云端已有截图：它们不会被删，也不会换封面。") : ""),
          { title: pubT("还没有截图"), okText: pubT("仍然上传"), cancelText: pubT("回去加一张") },
        );
      } catch (_) {
        go = false;
      }
    }
    PUB.busy = false;
    if (!pubAlive(seq)) return;
    if (!go) {
      pubSetNote(pubT("已停在「还没有截图」这一步：点「拍应用窗口」或「从本机选图…」加一张，再上传。"));
      pubToast(pubT("已取消上传：先加一张截图"), "warn");
      return;
    }
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
  /* 上传体积预检（本轮需求）：先把「这一轮要传的东西」摆上台面 ——
     应用包 + 图标 + 截图（截图与包都按 base64 后约 1.34 倍算），
     超过服务端那条上架链路的请求体上限时**在这里就停下并说清楚**，
     不要等打包、压缩、算指纹全跑完再让服务端/网关把我们拒掉（用户看到的是「上传中卡住」）。
     上限真源在服务端（回执里下发的 storage.uploadLimitBytes）；没读到就用兜底常量。 */
  const shotEstimate = PUB.shots.reduce((n, x) => n + (Number(x && x.bytes) || 0), 0);
  const pre = pubPreflightSize(shotEstimate, Number(plan.bytes) || 0);
  if (pre && pre.tooBig) {
    PUB.busy = false;
    pubSetNote(pre.text);
    pubToast(pubT("应用包太大，先减小素材再上传"), "warn");
    return;
  }
  const zipSig = PUB.user && PUB.user.id ? pubStr(PUB.appId) : pubStr(PUB.appId);
  pubSetNote(pubT("上传中…（① 正在打包应用）"));
  let pack = null;
  /* 这一轮已经打好包、上次只是没传上去（超时 / 网络断）→ **直接复用那份 zip**，
     不再重打一遍（打包要读全目录并逐文件 deflate，大应用上是几秒到几十秒的等待）。 */
  if (PUB.packRetry && PUB.packRetry.sig === zipSig && PUB.packRetry.pack && PUB.packRetry.read) {
    pack = PUB.packRetry.pack;
    pubSetNote(pubT("上传中…（① 打包：沿用上一次已打好的包）"));
  } else {
    try {
      pack = await api.appsExportZip(PUB.appId);
    } catch (err) {
      pack = { ok: false, error: pubStr((err && err.message) || err) };
    }
  }
  if (!pack || pack.ok === false) {
    PUB.busy = false;
    const code = pubStr(pack && pack.error).split(":")[0].trim();
    const EXTRA = {
      missing: "该应用不在本机（可能在别处被删了）",
      missing_entry: "应用缺少入口页：这个应用目录里没有 app.json 声明的入口页",
      /* need_root 已随「不再要求手选应用根目录」（本轮需求）下线：主进程不再回这个码 */
      bad_id: "应用 id 不合法",
    };
    const why = EXTRA[code] || pubStr((pack && pack.error) || pubT("未知错误"));
    pubSetNote(pubT("打包失败：") + why);
    pubToast(pubT("打包失败：") + why, "err");
    return;
  }
  pubSetNote(pubT("上传中…（② 正在读回应用包）"));
  let read = null;
  if (PUB.packRetry && PUB.packRetry.sig === zipSig && PUB.packRetry.pack === pack && PUB.packRetry.read) {
    read = PUB.packRetry.read;
  } else {
    try {
      read = await api.appsReadZipBase64(PUB.appId);
    } catch (err) {
      read = { ok: false, error: pubStr((err && err.message) || err) };
    }
  }
  if (!read || read.ok === false || !read.base64) {
    PUB.busy = false;
    pubSetNote(pubT("读回应用包失败：") + pubStr((read && read.error) || pubT("未知错误")));
    return;
  }
  /* 记下这一轮打好的包与读回的 base64：万一后面上传失败（超时 / 断网 / 服务端 5xx），
     用户点「重试」时直接用它们重发，不再重打包、不再重读 —— 见 pubUploadRetryLast。 */
  PUB.packRetry = { sig: zipSig, appId: pubStr(PUB.appId), pack: pack, read: read, at: Date.now() };
  if (pack.sha256 && read.sha256 && pubStr(pack.sha256) !== pubStr(read.sha256)) {
    PUB.busy = false;
    pubSetNote(pubT("校验失败：打包与读回的应用包 sha256 不一致，已停止上传（请重试一次）"));
    pubToast(pubT("应用包校验失败：sha256 不一致，未提交"), "err");
    return;
  }
  /* 图标（封面，一张）：显式图标优先，否则第 1 张截图（**压到 512 长边 + ≤500KB**）。 */
  let iconBase64 = "";
  if (plan.kind === "icon") {
    iconBase64 = pubStripDataUrl(PUB.form.icon.dataUrl);
  } else if (plan.kind === "shot") {
    const rawIcon = await pubShotBase64(PUB.shots[0]);
    if (!rawIcon) {
      pubSetNote(pubT("读取第 1 张截图失败：请改用「图标」选一张本机图片，或重新拍一次窗口"));
      PUB.busy = false;
      return;
    }
    const iconShot = await pubPrepareShot("data:image/*;base64," + rawIcon, { kind: "icon", maxBytes: PUB_ICON_MAX_BYTES });
    if (!iconShot || iconShot.tooLarge || !iconShot.dataUrl) {
      pubSetNote(pubT("第 1 张截图当图标压不到 500KB：请用「图标」单独选一张小图，或换一张更简单的封面截图。"));
      PUB.busy = false;
      return;
    }
    iconBase64 = pubStripDataUrl(iconShot.dataUrl);
  }
  /* 上架截图（8 张全部上传）：逐张**先压一道**（长边 2560 / 单张 ≤5MB，见 pubPrepareShot），
     算出内容指纹（sha256）后判断「云端是不是已经有这张图」：
       · 已经有 → 只发 { sha } 引用，**不发字节**（省云服务器流量，就是这次要做的事）；
       · 没算出来（crypto 不可用）→ 老实发字节。
     压缩与算指纹这一趟**一张都不能少**（sha256 是压缩后字节的哈希，跳过压缩就算不出指纹），
     但省下的是**上传字节**：8 张 5MB 的图若云端已有，这一轮推上去的就只有引用。
     判定两趟：先用本机索引 / 服务端目录下发的指纹（同步，免一次网络往返），
     再把剩下没认出来的**一次**批量问服务端（别人传过的同一张图也命中）。
     任何一张读不出来 / 压不下去都整批停下并指名第几张 —— 绝不静默少传。
     唯一的例外是**云端带出来、服务端又没给指纹**的老条目（from:"cloud" && 没有 sha）：
     它本来就在云端、这一轮一个字节都不用发，**直接不带进 body**（带了也只能是空引用，
     两个路由对空引用的处理还不一样：追加路会当成「读不出来」整批拒；不带反而语义正确
     —— 服务端的追加式写入本来就保留旧图、不重排）。它照旧显示在列表里。 */
  const shotsBase64 = [];
  const shotShaByIndex = [];
  const shotPrepByIndex = [];
  /* 每一项对应 PUB.shots 里的第几个（云端没指纹那些会被跳掉 → 下标不再一一对应）：
     回填 prepared / 重试要按它找回「这张图是哪一张」，否则会标错卡片。 */
  const shotSrcIndex = [];
  PUB.showNote = false;
  for (let i = 0; i < PUB.shots.length; i++) {
    /* 只有「云端带出来、本机又没字节」的那些直接发引用（见上面的例外说明）；
       本机缓存带出来的（from:"local"，有 dataUrl）照常走压缩 + 指纹那一趟 ——
       它的字节就是当初上传的那一份，算出来的 sha 与云端一致，于是同样只发引用。 */
    if (PUB.shots[i] && PUB.shots[i].from === "cloud" && !pubStr(PUB.shots[i].dataUrl)) {
      const csha = pubStr(PUB.shots[i].sha).toLowerCase();
      if (!csha) continue; /* 老条目没指纹：不带（见上）；服务端那条路本来就不动它 */
      shotShaByIndex.push(csha);
      shotPrepByIndex.push({ bytes: 0, w: 0, h: 0, changed: false, reused: true });
      shotSrcIndex.push(i);
      shotsBase64.push({ sha: csha });
      continue;
    }
    /* 这一轮已经压好 / 算好指纹的那一份（失败重试时直接复用）：
       压 8 张 2560 长边的图 + 逐张算 sha256 是这条链路上最慢的一段，
       上次只是没传上去（超时 / 断网）时不该让用户再等一遍 —— 见 PUB.shotPrepRetry。 */
    const cachedPrep = PUB.shotPrepRetry && PUB.shotPrepRetry.round === PUB.roundId ? PUB.shotPrepRetry.byIndex[i] : null;
    if (cachedPrep && cachedPrep.prep && cachedPrep.sha) {
      shotShaByIndex.push(cachedPrep.sha);
      shotPrepByIndex.push(cachedPrep.prep);
      shotSrcIndex.push(i);
      shotsBase64.push(pubStripDataUrl(cachedPrep.prep.dataUrl));
      continue;
    }
    const raw = await pubShotBase64(PUB.shots[i]);
    if (!raw) {
      pubSetNote(pubT("第 ") + (i + 1) + pubT(" 张截图读不出来（文件可能已被移走）：删掉它或重新拍一张再上传"));
      PUB.busy = false;
      return;
    }
    const prep = await pubPrepareShot("data:image/*;base64," + raw, { kind: "shot", srcBytes: Number(PUB.shots[i].bytes) || 0 });
    if (!prep || !prep.dataUrl) {
      pubSetNote(pubT("第 ") + (i + 1) + pubT(" 张截图读不出来（文件可能已被移走）：删掉它或重新拍一张再上传"));
      PUB.busy = false;
      return;
    }
    if (prep.tooLarge) {
      pubSetNote(
        pubT("截图 ") + (i + 1) + pubT(" 压到长边 ") + PUB_SHOT_RETRY_EDGE +
          pubT(" 后仍有 ") + pubBytes(prep.bytes) + pubT("，超过单张 5MB 上限：请先裁切或转小再上传。"),
      );
      pubToast(pubT("截图 ") + (i + 1) + pubT(" 太大（超过 5MB）"), "warn");
      PUB.busy = false;
      return;
    }
    const sha = await pubSha256Of(prep.dataUrl);
    shotShaByIndex.push(sha);
    shotPrepByIndex.push(prep);
    shotSrcIndex.push(i);
    shotsBase64.push(pubStripDataUrl(prep.dataUrl));
    /* 记下这一张的结果（重试复用）；round 一变就整体重来，绝不跨轮串味 */
    if (!PUB.shotPrepRetry || PUB.shotPrepRetry.round !== PUB.roundId) PUB.shotPrepRetry = { round: PUB.roundId, byIndex: {} };
    PUB.shotPrepRetry.byIndex[i] = { prep: prep, sha: sha };
  }
  /* 批量查存（一次请求）：命中的改成 { sha } 引用 —— 只影响省不省流量，失败照旧发字节。 */
  try {
    await pubServerHasShots(shotShaByIndex);
  } catch (_) {}
  for (let i = 0; i < shotsBase64.length; i++) {
    const sha = pubStr(shotShaByIndex[i]).toLowerCase();
    const skipUpload = !!sha && pubShaSeenHas(sha);
    const prep = shotPrepByIndex[i] || {};
    /* 已经有 { sha } 的（云端带出来那一项）保持引用；新图算出指纹且云端已有 → 也换成引用。 */
    if (!(shotsBase64[i] && typeof shotsBase64[i] === "object") && skipUpload) shotsBase64[i] = { sha: sha };
    /* 卡片上如实标一句这张图这一轮压了多少（作者能自己判断画质够不够）——
       下标走 shotSrcIndex（云端没指纹那些没进 body，不能按 i 直接对 PUB.shots 取）。 */
    const src = shotSrcIndex[i];
    if (PUB.shots[src]) {
      PUB.shots[src].prepared = {
        bytes: Number(prep.bytes) || 0,
        w: Number(prep.w) || 0,
        h: Number(prep.h) || 0,
        changed: !!prep.changed,
        sha: sha,
        reused: !!sha && (skipUpload || (PUB.shots[src] && PUB.shots[src].from === "cloud")),
      };
    }
  }
  pubPaintShots();
  /* 追加还是新建（同 id 多分支，§十）：
     · 我名下已有这个 id 的分支 → 追加到**我那条**（parentVersion = 我那条的最新版）；
     · 这个 id 只在别人名下 → 走 POST /api/apps 新建**我自己**的分支（body 里带 forkOf 声明）；
     · 线上没有 → 首次上架（POST，就是主干）。 */
  const online = PUB.online || {};
  const myBranch = online.myBranch || pubMyBranchOf(online);
  const append = !!(online.exists && myBranch);
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
  /* 截图整组（含第 1 张）：服务端按 shots[] 落盘并下发目录（空数组 = 作者清空了截图） */
  if (shotsBase64.length) body.shotsBase64 = shotsBase64;
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
    body.parentVersion = pubStr(pubMyBranchLatestVersion() || online.latestVersion);
    body.versionNote = v.payload.versionNote;
    /* 同 id 多作者时点明分支（服务端只允许往自己的分支追加；不传也回落到我自己那条） */
    if (pubStr(myBranch.ownerId)) body.ownerId = pubStr(myBranch.ownerId);
  } else {
    body.id = v.payload.id;
  }
  const sentBytes = shotsBase64.filter((x) => typeof x === "string").length;
  const refBytes = shotsBase64.length - sentBytes;
  pubSetNote(
    pubT("上传中…（③ 正在上传到云端，请勿关闭窗口）") +
      (shotsBase64.length
        ? pubT("· 截图 ") + shotsBase64.length + pubT(" 张") +
          (refBytes ? pubT("（其中 ") + refBytes + pubT(" 张云端已有，只发引用）") : "")
        : ""),
  );
  let r = null;
  try {
    r = await api.storeRequest({ method: "POST", path: path, json: body, timeoutMs: 600000 });
  } catch (err) {
    r = { ok: false, error: pubStr((err && err.message) || err) };
  }
  /* 服务端说「这个引用云端没有」（OBJ_NOT_FOUND：本机记住了、云端其实清过）：
     **把这一批发成字节重试一次**（只重试一次，避免死循环），并直接告诉用户发生了什么。 */
  if (r && r.ok === false && pubStr(r.data && r.data.code) === "OBJ_NOT_FOUND" && refBytes) {
    for (let i = 0; i < shotsBase64.length; i++) {
      const sha = pubStr(shotShaByIndex[i]).toLowerCase();
      if (sha) delete pubShaSeenOf()[sha];
      const shot = PUB.shots[shotSrcIndex[i]];
      /* 云端带出来那种没有本机字节（dataUrl / path 都没有）→ 重传不了，只能让它那边回错误 */
      const raw = await pubShotBase64(shot);
      if (!raw) continue;
      const prep = await pubPrepareShot("data:image/*;base64," + raw, { kind: "shot" });
      if (prep && prep.dataUrl) shotsBase64[i] = pubStripDataUrl(prep.dataUrl);
    }
    body.shotsBase64 = shotsBase64;
    pubSetNote(pubT("云端没有那份缓存的图片：这次把图片一起重传一遍…"));
    try {
      r = await api.storeRequest({ method: "POST", path: path, json: body, timeoutMs: 600000 });
    } catch (err) {
      r = { ok: false, error: pubStr((err && err.message) || err) };
    }
  }
  PUB.busy = false;
  if (!r || r.ok === false) {
    const msg = pubErrText(r);
    /* 服务端说会话不认（401）：本机那份凭据也失效了 —— 让主进程的账户契约去收口
       （auth:me 会清掉本机凭据并广播登录态变化），本窗与顶栏一起变成「未登录」，
       页脚立刻给「去登录」，不再留着「明明已登录」的假象。 */
    if (!pubSessionLost(r, msg)) {
      /* 失败时**保留**这一轮已经打好的包与压好的截图：用户点「重试」直接重发，
         不再重打包（读全目录 + 逐文件 deflate）、不再重压 8 张图并逐张算 sha256。
         这两件事正是「卡在上传中」时用户白等的那部分。缓存只活在本窗内，关窗即丢。 */
      PUB.retryReady = true;
      const code = pubStr(r && r.data && r.data.code);
      const hint = code === "BODY_TOO_LARGE"
        ? pubT("（内容超过云端一次请求的上限：删掉几张截图或压小素材后再试）")
        : code === "OBJ_NOT_FOUND"
          ? pubT("（云端没有那份图片缓存，且本机也没有这张图的字节能重传：请重新加一遍那几张截图）")
          : pubT("");
      pubSetNote(pubT("上传失败：") + msg + hint + pubT("　已保留这一轮打好的包与压缩结果，点「重试上传」即可直接重发，不必重来。"));
      pubToast(pubT("上传失败：") + msg, "err");
      pubPaintFoot();
    }
    return;
  }
  /* 成功了：这一轮的临时缓存（包 / 压缩结果 / 重试标记）立刻作废，别让下一轮用上旧的 */
  PUB.packRetry = null;
  PUB.shotPrepRetry = null;
  PUB.retryReady = false;
  const data = r.data || {};
  pubShaSeenAdd(shotShaByIndex);
  pubShaSeenAdd(data.item && data.item.shotsSha ? data.item.shotsSha : null);
  pubShaSeenAdd(data.catalog && data.catalog.shotsSha ? data.catalog.shotsSha : null);
  /* 截图**本地保存**（本轮需求：上传过的截图下次更新自动带上、且只发引用）：
     存的就是这一轮真正传上去的那份压缩字节（按 sha 内容寻址，同图跨应用只存一份）。
     失败不报错、不影响上架结果 —— 缓存只是便利，下次开窗没有它照样能从云端 URL 带出截图。 */
  try {
    const localItems = [];
    for (let i = 0; i < shotsBase64.length; i++) {
      const sha = pubStr(shotShaByIndex[i]).toLowerCase();
      if (!sha) continue;
      const prep = shotPrepByIndex[i] || {};
      const src = PUB.shots[shotSrcIndex[i]];
      let dataUrl = pubStr(prep.dataUrl);
      if (!dataUrl) {
        /* 没有 prep（云端带出来的那一项）→ 用本机字节（若这一项本身就是本机缓存来的） */
        dataUrl = pubStr(src && src.dataUrl);
      }
      if (!dataUrl) continue;
      const extM = /^data:image\/([a-z0-9.+-]+);/i.exec(dataUrl);
      localItems.push({ sha: sha, dataUrl: dataUrl, ext: extM ? extM[1] : "", bytes: Number(prep.bytes) || 0 });
    }
    const saved = await pubShotsLocalSave(pubStr(data.item && data.item.id) || pubStr(v.payload.id), localItems);
    if (saved && saved.ok) PUB.shotsLocal = saved;
  } catch (_) {}
  /* 本机指纹落一份（主进程按云端主机分桶）：下次开窗就知道这几张云端已经有的，连问服务端都省了 */
  pubImgFpPut(shotShaByIndex);
  pubImgFpPut(data.item && data.item.shotsSha ? data.item.shotsSha : null);
  /* 截图张数按**服务端回执**说话（它才知道有没有去重）：服务端从本轮起回 shots:{added,total}
     —— 追加一版时截图是「保留旧图 + 去重后追加」，本地那个 shotsBase64.length 只是本次带了几张。
     老服务端没有这个字段就退回本地张数（不假装知道）。 */
  const shotsReply = data.shots && typeof data.shots === "object" ? data.shots : null;
  const shotsText = shotsReply
    ? (Number(shotsReply.added) || 0) > 0
      ? pubT("· 新增截图 ") + (Number(shotsReply.added) || 0) + pubT(" 张（云端共 ") + (Number(shotsReply.total) || 0) + pubT(" 张）")
      : shotsBase64.length
        ? pubT("· 截图已在云端（") + (Number(shotsReply.total) || 0) + pubT(" 张，无重复落盘）")
        : ""
    : shotsBase64.length
      ? pubT("· 含截图 ") + shotsBase64.length + pubT(" 张")
      : "";
  PUB.showNote = true;
  pubSetNote(
    pubT("上传成功：") +
      pubStr((data.item && (data.item.latestVersion || data.item.version)) || v.payload.version) +
      shotsText,
  );
  pubShowResult(data, append ? "version" : "create");
  /* 覆盖了同号版本（服务端 replaced === true，用户口径「同版本允许覆盖」）：
     必须说出来 —— 作者以为传的是「新的一版」，实际是把 vX 换掉了，版本树上看不到新版号。 */
  const replaced = data.replaced === true;
  /* unchanged:true = 这次带的包与线上那一版**内容一模一样**（sha256 相同）：
     照旧算成功（同号重传一律接受），但如实说一句，别让人以为换了新包。 */
  const unchanged = replaced && data.unchanged === true;
  if (replaced) {
    pubSetNote(
      pubT("上传成功（已覆盖 v") +
        pubStr(v.payload.version) +
        pubT(unchanged
          ? "：这一版与线上那份内容一样，版本号不变）"
          : "：这一版就地换成了新包，版本号不变）") +
        shotsText,
    );
  }
  /* 本轮口径：上传成功的提示就是「上传成功 + 版本号」那一句（见上面 pubSetNote）——
     服务端不再有目录可见性开关（应用只有两态：在线上 / 已被彻底删除），
     也就没有「重新上架」这回执位要额外说一句（data.republished 已随之删除）。 */
  pubToast(
    pubT("上架成功") +
      (replaced ? pubT(" · 已覆盖同号版本") : "") +
      (unchanged ? pubT(" · 内容未变") : ""),
    "ok",
  );
  /* 本机也记一份（契约 §八）：author = 当前登录账号（云端条目只用 owner 显示作者，本机写
     app.json.author）；forkOf = 本次声明的二次开发来源；cloud = 上架留痕（本轮需求：
     云端 id / 账号 / 时间 / 版本 —— 下次开窗的默认锁定 id 与离线回落判据都读它）。
     三者都随包走 + 本机留档，下次上架自动带回。 */
  pubWriteLocalMeta(v.payload.id, v.payload.version).catch(() => {});
  /* 刷新线上状态与配额（版本树 / 用量都要跟着动）。回执里带了 storage 就先用它把配额行
     刷成服务端的真实数字（少一次往返），再照旧拉一遍兜底。 */
  pubQuotaFromReply(data.storage);
  pubLoadOnline().catch(() => {});
  pubLoadQuota().catch(() => {});
  try {
    if (typeof window.api.appsCatalog === "function") window.api.appsCatalog(true).catch(() => {});
  } catch (_) {}
}
/* 上架成功后把作者 / 二次开发来源 / 上架留痕写回本机 app.json（主进程 apps:setMeta，
   渲染层不碰文件）。写失败不影响上架结果 —— 下次上架时表单照旧会带出来自目录的那一份，
   只是这次上架的云端 id 没落盘（下次开窗的默认锁定 id 会退回本机应用 id）。
   publishedId / publishedVersion 省略时取表单里那一份（服务端已按它落库）。 */
async function pubWriteLocalMeta(publishedId, publishedVersion) {
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
  /* 上架留痕（本轮需求）：云端 id + 上架账号（uid 为准、账号名只作显示）+ 版本 + 时间。
     下次开窗的默认锁定 id 与离线时的线上回落都读它（见 pubIdEnsure / pubTraceUpdate）。
     写 null 的场景不存在（上传成功必然有 id）；真拿不到 id 就不写这一项，绝不落半条脏数据。 */
  const cloudId = pubStr(publishedId) || pubStr(PUB.form.id);
  const u = PUB.user || {};
  if (cloudId) {
    patch.cloud = {
      id: cloudId,
      ownerId: pubStr(u.id),
      owner: pubStr(u.username),
      version: pubStr(publishedVersion) || pubStr(PUB.form.version),
      at: Date.now(),
    };
  }
  try {
    await api.appsSetMeta(id, patch);
  } catch (_) {}
  /* 本机留痕也跟着更新（同一窗内接着传下一版 / 改 id 时判据要跟手，不等下一次开窗）：
     这一发成功后，云端那个 id 就是这个应用的身份了 —— 锁定值换成它，并**恢复锁定**
     （用户口径：改 id 只是这一次的显式动作，传完就该回到「默认锁定」的常态）。 */
  if (patch.cloud) {
    PUB.trace = pubTrace({ cloud: patch.cloud });
    PUB.lockedId = patch.cloud.id;
    PUB.idCommitted = patch.cloud.id;
    PUB.idUnlocked = false;
    if (PUB.dom.idIn) PUB.dom.idIn.value = pubStr(PUB.form.id);
    pubPaintId();
    pubPaintTitle();
    pubPaintFoot();
  }
  try {
    if (typeof appsListLoad === "function") await appsListLoad(true);
  } catch (_) {}
}
/* 成功回显（不自动关窗；给「再传一版」）。mode = "version"（追加到已有那条）| "create"（新建一条）：
   本轮起两种都写「✓ 上架成功」，只用括号里那一句如实标出这次是新建还是追加。 */
function pubShowResult(data, mode) {
  const wrap = PUB.dom.result;
  if (!wrap) return;
  wrap.innerHTML = "";
  wrap.hidden = false;
  const item = (data && data.item) || {};
  const cat = (data && data.catalog) || {};
  const head = pubEl("div", "pub-res-head");
  head.appendChild(
    pubEl(
      "span",
      "pub-res-t",
      pubT("✓ 上架成功") + (mode === "version" ? pubT("（追加版本）") : pubT("（新建应用）")),
    ),
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
  /* 校验值收进「ⓘ 复制校验值」小按钮（长哈希对普通用户没有意义；本轮：点一下直接进剪贴板，不再开小窗） */
  const shaVal = pubStr(cat.sha256 || item.sha256);
  if (shaVal) {
    const row = pubEl("div", "pub-res-row");
    row.appendChild(pubEl("span", "pub-res-k", pubT("安装包校验")));
    const vv = pubEl("span", "pub-res-v");
    if (typeof appsHashBtnEl === "function") vv.appendChild(appsHashBtnEl("复制校验值", shaVal));
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
  /* 默认版本号按**我自己那条分支**的最新版 +1（q10：分支各自计数） */
  const next = pubBumpPatch(pubMyBranchLatestVersion());
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

/* pickedOverride：重试时用上一次那份勾选（重画版本区会把勾选框清掉，而重试按钮要能原样再来一遍）。 */
async function pubDeleteVersions(pickedOverride) {
  const api = window.api || {};
  const id = pubStr(PUB.form.id) || PUB.appId;
  const picked = Array.isArray(pickedOverride) && pickedOverride.length ? pickedOverride.slice() : pubPickedVersions();
  if (!picked.length) return;
  if (typeof api.storeRequest !== "function") {
    pubToast(pubT("上传接口未就绪，无法删除版本"), "err");
    return;
  }
  /* 删的是不是最后一版：是就把后果写进确认框（删完云端就彻底没有这个应用了）。 */
  const online = PUB.online || {};
  const myBranch = online.myBranch || pubMyBranchOf(online);
  const myVs = myBranch ? pubVersionsOfBranch(myBranch) : [];
  const allGone = myVs.length > 0 && myVs.every((v) => picked.indexOf(pubStr(v.version)) >= 0);
  const ask =
    pubT("确定删除线上版本 ") + picked.map((v) => "v" + v).join(" / ") + pubT(" 吗？包与版本记录会一起下掉，配额当场释放，不能撤销。") +
    (allGone
      ? pubT(" 这是最后一版：删完这个应用就在云端彻底不存在了（记录 / 包 / 图标 / 截图一并清掉，不可恢复）。")
      : "");
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
  if (PUB.dom.delVerBtn) PUB.dom.delVerBtn.disabled = true;
  const fails = [];
  let done = 0;
  /* 服务端回 deleted:true = 这一版是最后一版，整条分支（记录 + 文件）已经没了 */
  let branchDeleted = false;
  /* 同 id 多分支（§十）：删版本必须点明分支（?owner=），只删我自己那条（服务端也只允许自己的） */
  const myOwner = pubStr((PUB.online && PUB.online.myBranch && PUB.online.myBranch.ownerId) || (PUB.user && PUB.user.id) || "");
  for (const v of picked) {
    try {
      const r = await api.storeRequest({
        method: "DELETE",
        path:
          "/api/apps/" + encodeURIComponent(id) + "/versions/" + encodeURIComponent(v) +
          (myOwner ? "?owner=" + encodeURIComponent(myOwner) : ""),
      });
      if (!r || r.ok === false) fails.push("v" + v + "：" + pubErrText(r));
      else {
        done++;
        if (r.data && r.data.deleted === true) branchDeleted = true;
      }
    } catch (err) {
      fails.push("v" + v + "：" + pubStr((err && err.message) || err));
    }
  }
  /* 成败都写进常驻结果行（本轮需求：不再只靠 toast），失败再留服务端原话 + 重试。 */
  if (fails.length) {
    pubVerResult(
      (done ? pubT("已删除 ") + done + pubT(" 个版本；还有没删掉的：") : pubT("版本没删掉：")) + fails.join("；"),
      "err",
      () => pubDeleteVersions(picked).catch(() => {}),
    );
    pubToast(pubT("部分版本没删掉"), "err");
  } else if (branchDeleted) {
    /* 删光最后一个版本 = **云端彻底删除**（服务端回 deleted:true）：如实说出后果，
       并把手头这些「现在指向空气」的本机痕迹一起收掉 —— 本机上架留痕（app.json 的 cloud）
       与这个应用的本地截图缓存。留着它们，下次开窗会以为「还能更新这个应用」。 */
    pubVerResult(
      pubT("已删除 ") + picked.map((v) => "v" + v).join(" / ") +
        pubT("：那是最后一个版本，这个应用已在云端**彻底删除**（记录 / 包 / 图标 / 截图都没了，不可恢复）。"),
      "ok",
    );
    pubToast(pubT("已彻底删除：云端不再有这个应用"), "ok");
    try {
      await pubClearLocalTrace();
    } catch (_) {}
  } else {
    pubVerResult(pubT("已删除 ") + picked.map((v) => "v" + v).join(" / ") + pubT("，配额已释放；线上版本区已按服务端重读刷新。"), "ok");
    pubToast(pubT("已删除选中的线上版本"), "ok");
  }
  await pubLoadOnline().catch(() => {});
  await pubLoadQuota().catch(() => {});
}

/* ───────────────── 云端应用被彻底删除后的本机收尾 ───────────────── */
/* 作者在云端把这个应用删干净之后，本机这两样东西就成了「指向空气的痕迹」：
   ① app.json 的 cloud（上架留痕）—— 留着它，下次开窗会把「线上没有这个应用」说成
      「更新一个已不存在的应用」，默认 id 也锁在那个已经不存在的云端 id 上；
   ② 本地截图缓存里只属于这个应用的那些图 —— 留着白占磁盘，而且下次上架别的应用也用不上。
   两件都只动本机数据（write null / 按 appId 回收），云端不再发任何请求。 */
async function pubClearLocalTrace() {
  const api = window.api || {};
  const appId = pubStr(PUB.appId) || pubStr(PUB.form.id) || pubStr(PUB.lockedId);
  /* ① 清上架留痕（apps:setMeta 的 patch.cloud = null 就是「清掉这一项」，见 app-apps.js 的口径） */
  if (typeof api.appsSetMeta === "function" && appId) {
    try {
      await api.appsSetMeta(appId, { cloud: null });
      PUB.trace = null;
      /* 立即回落到常态：锁定值换回本机 id（上架文案统一，不再需要跟着切按钮文案） */
      PUB.lockedId = pubStr(PUB.localId) || appId;
      pubPaintId();
      pubPaintTitle();
    } catch (_) {}
  }
  /* ② 本地截图缓存：只回收「只属于这个应用」的那些（被别的应用共用的留着） */
  const cloudId = pubStr((PUB.online && PUB.online.id) || appId);
  await pubShotsLocalDropApp(cloudId);
  if (cloudId !== appId) await pubShotsLocalDropApp(appId);
}

/* ───────────────── 入口别名 ───────────────── */

window.openAppPublish = openAppPublish;
window.closeAppPublish = pubClose;
/* 测试钩子（只读观测，不给产品路径用）：test/smoke-app-publish-auth.js 等 PUB.load
   与 authChecked / loggedIn 判登录态收口。渲染层别依赖它 —— 它没有版本承诺。 */
window.__mtnodeAppPublish = PUB;

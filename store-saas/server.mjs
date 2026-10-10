"use strict";
/**
 * MTNode 创意工坊 — 零依赖 Node 18 HTTP 服务。
 * 数据：JSON 库 + files/ skills/ previews/ forum-images/
 * 环境：PORT（默认 8787）、HOST（默认 127.0.0.1）、DATA_DIR
 * 管理员（官方 Skill 标记）：MTNODE_STORE_ADMINS（默认 ms2308）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sendSmsCode, smsProviderStatus, SMS_CODE_TTL_MS } from "./sms-provider.mjs";
import { createAccountStore } from "./account-store.mjs";
import {
  alipayStatus,
  alipayPrecreate,
  alipayPagePayUrl,
  alipayQuery,
  alipayClose,
  alipayRefund,
  parseNotifyForm,
  normalizeNotify,
} from "./alipay-provider.mjs";
import { qrDataUrl } from "./qr-encode.mjs";
import { createRelay } from "./relay.mjs";
import { makeAppThumb, makeAppShot, decodeImage, THUMB_W, THUMB_H } from "./thumb.mjs";
import { createTips, TIP_TARGET_KINDS } from "./tips.mjs";
import { createComments } from "./comments.mjs";
import { createNotifications } from "./notifications.mjs";
import {
  createWallet,
  makeOrderId,
  validateAmount,
  totalCentsOf,
  yuanOfCents,
  centsOfYuan,
  RECHARGE_MIN_CENTS,
  RECHARGE_MAX_CENTS,
  rechargeTiersYuan,
} from "./wallet.mjs";
import { hotStoreInit, hotAppendRows, hotDirty, hotClearDirty, hotFlushAll, hotStats, hotDbForDisk } from "./hot-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const FILE_DIR = path.join(DATA_DIR, "files");
const SKILL_DIR = path.join(DATA_DIR, "skills");
const PREV_DIR = path.join(DATA_DIR, "previews");
const FORUM_IMG_DIR = path.join(DATA_DIR, "forum-images");
// 应用市场（用户 / 云端分发的本机小应用）：zip 落 APP_DIR，图标落 APP_ICON_DIR，
// 记录进 db.json 的 apps[]（与 templates / skills 同一套存储口径）。
const APP_DIR = path.join(DATA_DIR, "apps");
const APP_ICON_DIR = path.join(DATA_DIR, "app-icons");
// 应用封面缩略图缓存（640×360 PNG，首次请求时由 thumb.mjs 现生成，见 appThumbOf）
const APP_THUMB_DIR = path.join(DATA_DIR, "app-thumbs");
/* 上架截图（多图落盘）+ **内容寻址图片缓存**（本轮需求：图片放宽到单张 5MB，但同一张图
   绝不在云端存第二份、也绝不反复重传占带宽）：
   · 对象库：<DATA_DIR>/images/objects/<sha256>.<ext> —— 全站同一张图只落一份，
     跨版本 / 跨分支 / 跨用户复用（内容寻址，文件名即内容哈希）。
   · 引用：<DATA_DIR>/images/refs/<sha256>.<ext> —— 指向对象的硬链接（跨卷 / 权限不允许时
     退回复制），每个被引用的内容一份，用来「按内容认领」（客户端说这张图传过了）。
   · 截图本体：<DATA_DIR>/app-shots/<主干>/<序号>.<ext>（主干 = <id>__<作者uid>）——
     也是指向同一对象的硬链接。人可读、可排序，静态目录与既有读取链一个字都不用改。
     为什么要平铺而不是塞进一个子目录：实测本机（Windows + 沙箱过滤器）**父目录的 readdir
     看不到子目录里的条目**，fs.readdirSync / cmd dir / opendir 三条路都看不到（Get-ChildItem
     -Recurse 才看得到）。平铺就没有这个坑，代价只是多一层 images/refs。
   · 上限：每个分支最多 8 张、单张 ≤ 5MB；落盘前把长边收到 APP_SHOT_MAX_EDGE（2560，只缩不放，
     与客户端的压缩口径一致），列表用的小图另出 APP_SHOT_LIST_EDGE（1280，懒生成 + 落盘缓存）。
   · 下发：目录条目带 shots[]（原图，详情用）/ shotsThumb[]（列表小图）/ shotsSha[]（内容指纹）。 */
const APP_SHOT_DIR = path.join(DATA_DIR, "app-shots");
const IMG_OBJ_DIR = path.join(DATA_DIR, "images", "objects");
const IMG_REF_DIR = path.join(DATA_DIR, "images", "refs");
const MAX_APP_SHOTS = 8;
const MAX_APP_SHOT_BYTES = 5 * 1024 * 1024;
const APP_SHOT_MAX_EDGE = 2560;
const APP_SHOT_LIST_EDGE = 1280;
/* 列表用小图的后缀：`<sha256>` → `<sha256>.l1280`（拼在扩展名之前：`<sha256>.l1280.webp`）。 */
const SHOT_LIST_SUFFIX = ".l" + APP_SHOT_LIST_EDGE;
/* 上传请求体上限：上架接口要一次收下「最多 8 张 5MB 图 + 24MB 包」（base64 后约 77MB），
   所以 **只给上架链路的写接口**放宽到 96MB；其它接口仍守 MAX_BODY（40MB）。
   同步口径：nginx 的 client_max_body_size（store-saas/patch-nginx.py 里那两行）。 */
const MAX_BODY_APP_UPLOAD = 96 * 1024 * 1024;
// 应用市场静态目录（客户端唯一入口：<MTNODE_APPS_URL>/catalog.json）：
// 线上 = nginx 直发的 /var/www/mtnode/apps，本机开发 = DATA_DIR/apps-web。
// 接口一有应用变更就把 appCatalogDoc() 与 zip / 图标按静态布局落这里（单一真源，见 publishStaticApps）。
const APPS_WEB_DIR = path.resolve(process.env.MTNODE_APPS_WEB_DIR || "/var/www/mtnode/apps");
const APPS_WEB_MANIFEST = ".mtnode-apps-static.json";
const APPS_WEB_ICONS_DIR = "icons";
const DB_PATH = path.join(DATA_DIR, "db.json");
// 账户存储抽象层：users / sessions / identities 三个键经 account-store 读写
// （默认 json 后端仍落 DATA_DIR/db.json，或由 MTNODE_ACCOUNT_STORE 切到 aliyun-tablestore）。
const accountStore = createAccountStore({ dataDir: DATA_DIR, dbPath: DB_PATH });
// 论坛（长期保留，无 30 天过期；话题/回复分开限流）
const FORUM_STATUSES = new Set(["general", "help", "suggest", "bug", "solved"]);
const MAX_FORUM_TITLE = 120;
const MAX_FORUM_CONTENT = 20000;
const MAX_FORUM_REPLY = 8000;
const MAX_FORUM_IMAGES = 6;
const MAX_FORUM_IMAGE = 3 * 1024 * 1024;
const MAX_FORUM_IMAGE_EDGE = 1080;
const FORUM_RATE_TOPIC_MAX = 3;
const FORUM_RATE_REPLY_MAX = 10;
const FORUM_RATE_IMAGE_MAX = 30;
const FORUM_RATE_WIN_MS = 60 * 1000;
const FORUM_PAGE_SIZE_MAX = 100;
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 40 * 1024 * 1024;
const MAX_TEMPLATE = 10 * 1024 * 1024;
const MAX_SKILL = 200 * 1024;
const MAX_SKILL_FILE = 200 * 1024;
const MAX_SKILL_EXTRA_FILES = 32;
const MAX_PREVIEW = 500 * 1024;
// 应用包（zip）：24MB 原始体积 —— base64 后约 32MB，仍在 MAX_BODY（40MB）与
// nginx client_max_body_size 40m 之内；图标沿用预览图口径（png/jpeg/webp，≤500KB）。
const MAX_APP_ZIP = 24 * 1024 * 1024;
// —— 上架与多版本（契约 = docs/apps-market.md §七）——
// 总开关：**默认开**（2026-10 起；此前是默认关，线上因此一直回 409 APP_VERSIONS_DISABLED）。
// 打开时每版一包落 <id>/<version>.zip，并把最新版同时刷成 <id>.zip 供老客户端 / 静态目录；
// 只有**显式**写成 0 / false / no / off 才退回旧口径（<id>.zip 一版一份 + PATCH 覆盖 + apps[].version）。
const APP_VERSIONS_ENV = String(process.env.MTNODE_APP_VERSIONS || "").trim().toLowerCase();
/** 关闭档的取值（判据集中在 appVersionsOn，别在别处再读一次环境变量）。 */
const APP_VERSIONS_OFF = new Set(["0", "false", "no", "off"]);
// 账号配额（服务端强制，落盘之前校验）：云端已存包总量 = 名下所有应用所有版本 bytes 之和；
// 应用条数上限只算「新建」，给已有应用追加版本不计入。
const MAX_ACCOUNT_APP_BYTES = Math.max(1024 * 1024, Number(process.env.MTNODE_MAX_ACCOUNT_APP_BYTES || 50 * 1024 * 1024) || 50 * 1024 * 1024);
/* 每账号应用条数上限：默认 5（线上口径不变）；隔离沙箱要用 env 抬高它来造 1000 条目录
   （见 scripts/scale-1000-sandbox.mjs）。只影响「新上架」这一条校验，其它口径一字未动。 */
const MAX_ACCOUNT_APPS = Math.max(1, Number(process.env.MTNODE_MAX_ACCOUNT_APPS || 5) || 5);
const MAX_VERSION_NOTE = 200;
/* 打赏概述（GET /api/tips/summary）一次最多问多少个对象：列表页一页的量级（应用条目
   同 id 多分支也各占一条），够整页一次问齐，又挡住「一条超长 ids」把服务端拖住。 */
const TIP_SUMMARY_MAX_IDS = 100;
// 应用 id = 客户端安装目录名（apps-store.js 的 safeAppId 同一口径）：
// 2-64 位字母/数字/._-，统一小写入库；Windows 保留名不可用。
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const WIN_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const SESSION_MS = 30 * 24 * 3600 * 1000;
/* 中转站独立 Key（= 客户端「MTNode 中转服务」那张卡真正的凭据）的有效期：
   与登录会话**解耦** —— 客户端登录态可能因换机、密码变更、会话清理而失效，
   中转 Key 不该跟着一起死。
   **3650 天（≈10 年）**：口径是「分发一次后不应当失效」—— 只要账号有余额就能一直用，
   到期日只作为理论兜底；真正保命的是每次使用的滑动续期（见 touchSession 的 kind 分支）
   与客户端到期前的提前换新（续期提前量 = 有效期 / 6，见 relayKeyView.renewBeforeMs）。 */
const RELAY_KEY_MS = 3650 * 24 * 3600 * 1000;
const RELAY_KEY_KIND = "relay";// 短信频控口径见 docs/auth-design.md 第 8 节（服务端内存态，重启清零）。
const SMS_COOLDOWN_MS = 60 * 1000; // 单号 60 秒冷却
const SMS_DAILY_MAX = 10; // 单号每日上限
const SMS_IP_HOURLY_MAX = 30; // 单 IP 每小时上限
const SMS_MAX_ATTEMPTS = 5; // 验证码失败累计锁定
const SMS_LOCK_MS = 15 * 60 * 1000; // 锁定后冷却时长
const SMS_LOGIN_IP_HOURLY_MAX = 30; // 登录接口单 IP 每小时上限
const MAGIC = Buffer.from("MTNODES", "ascii");
const ADMIN_USERS = new Set(
  String(process.env.MTNODE_STORE_ADMINS || "ms2308")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
// 微信开放平台「网站应用」扫码登录凭据（未配置时相关接口统一返回 WECHAT_UNAVAILABLE）。
const WECHAT_APPID = String(process.env.MTNODE_WECHAT_APPID || "").trim();
const WECHAT_SECRET = String(process.env.MTNODE_WECHAT_SECRET || "").trim();
const WECHAT_REDIRECT = String(process.env.MTNODE_WECHAT_REDIRECT || "").trim();
const WECHAT_DEVICE_MS = 5 * 60 * 1000; // device_code 有效期 5 分钟
const WECHAT_TICKET_MS = 5 * 60 * 1000; // 一次性 ticket 有效期 5 分钟
const WECHAT_POLL_INTERVAL = 2; // 客户端轮询间隔（秒）

// —— 充值（支付宝当面付）与独立管理平台（口径见 docs/recharge-design.md）——
// 充值**对所有已注册账号开放**（不再按名单放行）：任何有效账号都能看钱包 / 下单。
//
// 口径演进（踩过的坑）：历史上这里读 MTNODE_RECHARGE_USERS（名单非空 = 只放名单 + 管理员），
// 线上 /etc/mtnode-store.env 里留下的那份旧名单会**继续拦掉"其他账号"**，
// 症状就是非名单账号下单 / 看余额一律 403 RECHARGE_NOT_OPEN（用户读到「充值功能尚未对该账号开放」）。
// 现在名单这条路整个作废：本常量恒为空集（只为管理台回显保留形状），
// 剩下的唯一闸门是一个**显式的全局关闭**开关 MTNODE_RECHARGE_CLOSED —— 默认全开，
// 要兜住"钱通道出问题先停充值"的运维场景时才置 1。这样遗留名单不再能拦人。
const RECHARGE_USERS = new Set();
/** 全局关闭充值（缺省全开）：MTNODE_RECHARGE_CLOSED = 1/true/yes/on 时所有账号一律 403。 */
function rechargeGloballyClosed() {
  return /^(1|true|yes|on)$/i.test(String(process.env.MTNODE_RECHARGE_CLOSED || "").trim());
}
/** 中转站对外 Base URL（下发给客户端「提供商」的 Base URL，末尾不带斜杠）。 */
const RELAY_PUBLIC_BASE = String(process.env.MTNODE_RELAY_PUBLIC_BASE || "https://www.mt-agent.com/mtnode/store-api/relay/v1").replace(/\/+$/, "");
// 管理平台管理员判据（三条任一命中即可）：
//   ① isAdmin(u)（= MTNODE_STORE_ADMINS，默认 ms2308）
//   ② username ∈ MTNODE_ADMIN_USERS（默认 ms2308）
//   ③ 该账号绑定的微信 unionid ∈ MTNODE_ADMIN_WECHAT_UNIONIDS（可选 env 兜底）
const ADMIN_EXTRA_USERS = splitSet(process.env.MTNODE_ADMIN_USERS, "ms2308");
const ADMIN_WECHAT_UNIONIDS = splitSet(process.env.MTNODE_ADMIN_WECHAT_UNIONIDS, "");
// 管理平台会话：独立短会话（8 小时、只对 /api/admin/* 生效、与客户端 Bearer 分开存 db.json）。
const ADMIN_SESSION_MS = 8 * 3600 * 1000;
// 频控（沿用短信那套「单 IP 每小时」口径）：登录发起 30 / 轮询 600 / 下单 60 / 查单刷新 120。
const ADMIN_LOGIN_IP_HOURLY_MAX = 30;
const ADMIN_POLL_IP_HOURLY_MAX = 600;
const RECHARGE_CREATE_IP_HOURLY_MAX = 60;
const WALLET_REFRESH_IP_HOURLY_MAX = 120;
// 图片内容指纹批量查存（客户端上传前问「这几张云端有没有」）：只读、免登录，但会被上架链路反复调用，
// 所以按单 IP 每小时封顶 600 次（一次能问最多 64 张，正常上架远不到这个数）。
const OBJ_EXIST_IP_HOURLY_MAX = 600;
const OBJ_EXIST_MAX = 64;
// 微信归属映射：`unionid:username` 或 `unionid:userId`，多条用逗号 / 分号 / 空白分隔。
// 用途：未登录扫码且该 unionid 无人占用时，命中映射就直接绑到旧账号并登录它，
// 不再新建一个只有微信身份的临时 uid（「同一个人两个账号」的根因）。
const WECHAT_OWNER_MAP = parseOwnerMap(process.env.MTNODE_WECHAT_OWNER_MAP);
// 管理平台静态页目录（本机联调用；线上由 nginx 从 /var/www/mtnode/admin/ 直发）。
const ADMIN_WEB_DIR = path.join(ROOT, process.env.MTNODE_ADMIN_WEB_DIR || "admin");

function splitSet(raw, dflt) {
  return new Set(
    String(raw == null || raw === "" ? dflt : raw)
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseOwnerMap(raw) {
  const m = new Map();
  for (const part of String(raw || "").split(/[,;\s]+/)) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(":");
    if (i <= 0 || i === s.length - 1) {
      console.warn("[store] MTNODE_WECHAT_OWNER_MAP 条目格式应为 unionid:username，已跳过：" + s);
      continue;
    }
    m.set(s.slice(0, i).trim(), s.slice(i + 1).trim());
  }
  return m;
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}
mkdirp(FILE_DIR);
mkdirp(SKILL_DIR);
mkdirp(PREV_DIR);
mkdirp(FORUM_IMG_DIR);
mkdirp(APP_DIR);
mkdirp(APP_ICON_DIR);
mkdirp(APP_SHOT_DIR);

function emptyDb() {
  return {
    users: [],
    sessions: [],
    identities: [],
    templates: [],
    skills: [],
    // 应用市场：用户自建 / 云端分发的小应用（zip 落 DATA_DIR/apps）
    apps: [],
    // 上架声明留痕（契约 §7.3）：每次新建 / 追加版本 / 更新的勾选记录，供事后追溯
    appDeclarations: [],
    likes: [],
    skillLikes: [],
    forumTopics: [],
    forumReplies: [],
    // 打赏记录（鲸圆币打赏，见 tips.mjs 与 docs/tips-comments-design.md 第五节）
    tips: [],
    // 评论（含五星评分与软删除留档，见 comments.mjs）
    comments: [],
    // 消息 / 通知（打赏 / 评论 / 回复三条主流程写入，见 notifications.mjs 与契约第三节）
    notifications: [],
    // 充值账本：订单与流水（余额在账户行的 balanceCents，见 wallet.mjs）
    rechargeOrders: [],
    rechargeLedger: [],
    // 管理平台独立短会话（与账户 sessions 分开，不进 Tablestore）
    adminSessions: [],
    // 中转站用量明细（自查接口与排查用；对账以 rechargeLedger 的 relay 流水为准）
    relayUsage: [],
    // 中转站可热改配置（管理台「中转服务」页保存的那一份；不存在时 relay.mjs 用默认 + env 缺省）
    relayConfig: null,
    // 中转配置改动留痕（谁 / 何时 / 改了哪一项）
    relayAudit: [],
    // 内容管理改动留痕（管理台编辑 / 删除 / 删版本 / 重发目录 应用·模板·技能，谁 / 何时 / 对哪条做了什么）
    contentAudit: [],
    // 已删除留痕（本轮需求）：彻底删除一条应用分支、且同一 id 下还有别的作者分支时，
    // 留一条最小元信息（见 appDeletedLedgerPush）—— 别的分支的「分支来源」指着它
    appDeletedLedger: [],
  };
}

// 旧结构（forumMessages 按房间分桶 + 30 天 TTL）不再兼容：
// 首次读到遗留字段即清空该字段与 forum-images 目录，随后照常保存新结构。
let legacyForumSeen = false;

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const d = JSON.parse(raw);
    if (!Array.isArray(d.users)) d.users = [];
    if (!Array.isArray(d.sessions)) d.sessions = [];
    if (!Array.isArray(d.identities)) d.identities = [];
    if (!Array.isArray(d.templates)) d.templates = [];
    if (!Array.isArray(d.skills)) d.skills = [];
    if (!Array.isArray(d.apps)) d.apps = [];
    if (!Array.isArray(d.appDeclarations)) d.appDeclarations = [];
    if (!Array.isArray(d.likes)) d.likes = [];
    if (!Array.isArray(d.skillLikes)) d.skillLikes = [];
    if ("forumMessages" in d) {
      legacyForumSeen = true;
      delete d.forumMessages;
    }
    if (!Array.isArray(d.forumTopics)) d.forumTopics = [];
    if (!Array.isArray(d.forumReplies)) d.forumReplies = [];
    if (!Array.isArray(d.tips)) d.tips = [];
    if (!Array.isArray(d.comments)) d.comments = [];
    if (!Array.isArray(d.notifications)) d.notifications = [];
    if (!Array.isArray(d.rechargeOrders)) d.rechargeOrders = [];
    if (!Array.isArray(d.rechargeLedger)) d.rechargeLedger = [];
    if (!Array.isArray(d.adminSessions)) d.adminSessions = [];
    if (!Array.isArray(d.relayUsage)) d.relayUsage = [];
    if (!Array.isArray(d.relayAudit)) d.relayAudit = [];
    if (!Array.isArray(d.contentAudit)) d.contentAudit = [];
    if (!Array.isArray(d.appDeletedLedger)) d.appDeletedLedger = [];
    if (!d.relayConfig || typeof d.relayConfig !== "object") d.relayConfig = null;
    return d;
  } catch {
    return emptyDb();
  }
}

let db = loadDb();
let saving = Promise.resolve();

/* 目录文档进程内记忆的两个状态位：**声明必须早于 saveDb**（口径与失效判据见 appCatalogDoc 上方注释）。
   踩过一次真坑（2026-10-09 上线当场）：saveDb() → bumpAppCatalog() 会读 appCatalogBump，而本模块中段
   有一处 top-level await（bootstrapAccountStore，Tablestore 冷启 ~20s），模块求值在那里挂起时事件循环
   照跑 —— 启动迁移那条 setImmediate 就会在 `let appCatalogBump` 求值之前调进 saveDb，撞 TDZ
   「Cannot access 'appCatalogBump' before initialization」：db.json 剪除失败，每次启动把 2000+ 条热表
   重迁一遍。声明位置在这件事上就是语义的一部分，别把它搬回中段。 */
let appCatalogBump = 0;
let _catalogMemo = { at: 0, bump: -1, doc: null };

/* 盘上那份 db.json 里是否还背着热表（**必须在 hotStoreInit 合并追加文件之前看**）。
   剪除闸不能只看「本轮迁入了几条」：迁移成功一次之后，后续每次启动 migrated 恒为 0
   （行已经在追加文件里、按 id 去重后没有新行可迁），只看 migrated 就永远不剪 ——
   db.json 会一直带着那两张表（实测 1.36MB / 3300+ 条）不缩，与 §热表拆分的设计口径相反。
   现场（2026-10-09）：第一次迁移撞 TDZ、剪除失败，第二次启动 migrated=0 → 剪除被整段跳过。 */
const DB_HAD_HOT_ROWS =
  (Array.isArray(db.relayUsage) && db.relayUsage.length > 0) ||
  (Array.isArray(db.rechargeLedger) && db.rechargeLedger.length > 0);

function saveDb() {
  bumpAppCatalog();
  /* 只改了热表（中转用量 / 钱包流水）时**不写 db.json**：那两张表的内容已经在各自的追加文件里
     落盘了，再全量重写一次 1MB+ 的库纯属白烧 —— 这正是本轮要拆掉的瓶颈（条目越多越慢、
     还把事件循环按住）。真正的库改动（应用 / 用户 / 评论 / 配置…）照旧全量原子落盘。 */
  if (hotDirty() && !saving.__hotOnly) {
    /* 这里刻意**保守**：只要还有别的改动要写库，就照旧全量写（不因为热表脏就跳过），
       避免「某个调用方忘了标脏就把改动吞掉」。热表自己已经落过盘，多写一次只是慢一点。 */
  }
  saving = saving.then(() => {
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(hotDbForDisk(db)));
    fs.renameSync(tmp, DB_PATH);
  }).catch((e) => {
    console.error("[store] save failed", e);
  });
  hotClearDirty();
  return saving;
}

/* 两张只增不减的热表（relayUsage / rechargeLedger）搬出 db.json，各落一个追加文件
   （每条 fsync）。为什么与口径见 store-saas/hot-store.mjs 顶部注释与
   docs/reports/scale-1000-verification.md。启动时把 db.json 里残留的旧记录迁进新文件并剪除，
   之后 db.json 不再随用量 / 流水条数膨胀；内存里那两张表照旧全量可读（读路径一行没改）。 */
const HOT_DIR = process.env.MTNODE_HOT_DIR || DATA_DIR;
const HOT_LOAD = hotStoreInit(db, HOT_DIR);
console.log(
  "[mtnode-store] hot tables: relayUsage=加载 " + HOT_LOAD.loaded.relayUsage.loaded + " 条（迁入 " +
    HOT_LOAD.loaded.relayUsage.migrated + "） · rechargeLedger=加载 " + HOT_LOAD.loaded.rechargeLedger.loaded +
    " 条（迁入 " + HOT_LOAD.loaded.rechargeLedger.migrated + "） · 目录 " + HOT_DIR,
);

/* 只要「盘上还带着热表」或「本轮真迁入了行」就把剪除落到 db.json：否则盘上仍背着那两张表，
   与热表拆分的设计口径相反（判据与现场见 DB_HAD_HOT_ROWS 上方注释）。
   setImmediate —— 此刻 saveDb / publishStaticApps 还没定义，等这一圈事件循环跑完再调。 */
if (
  HOT_LOAD.loaded.relayUsage.migrated ||
  HOT_LOAD.loaded.rechargeLedger.migrated ||
  DB_HAD_HOT_ROWS
) {
  setImmediate(() => {
    try {
      saveDb().then(() => console.log("[mtnode-store] hot tables: db.json 已剪除这两张表（盘上只留空数组占位）")).catch(() => {});
    } catch (e) {
      console.warn("[mtnode-store] hot tables: db.json 剪除失败（盘上仍背着热表，下次启动会再试一次）：" + ((e && e.message) || e));
    }
  });
}

// 首次读到旧结构：清空遗留字段（loadDb 已删）与 forum-images 目录里的旧图，并立即落盘。
function purgeLegacyForum() {
  if (!legacyForumSeen) return;
  legacyForumSeen = false;
  if (!(db.forumTopics || []).length) {
    try {
      for (const f of fs.readdirSync(FORUM_IMG_DIR)) {
        try { fs.unlinkSync(path.join(FORUM_IMG_DIR, f)); } catch {}
      }
    } catch {}
  }
  saveDb();
}
purgeLegacyForum();

/* 关停 / 异常退出前把热表的追加等完（每条本来就 fsync 过，这里只是等队列排空）。 */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    hotFlushAll()
      .catch(() => {})
      .then(() => process.exit(0));
  });
}

// 启动即从账户存储把 users / sessions / identities 载入内存缓存（见 bootstrapAccountStore）。
await bootstrapAccountStore();

function uid(prefix) {
  return prefix + crypto.randomBytes(8).toString("hex");
}

function hashPass(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function now() {
  return Date.now();
}

function isAdmin(u) {
  return !!(u && ADMIN_USERS.has(String(u.username || "").toLowerCase()));
}

/* ---------- 统一账户层：手机号规范化 / 掩码 / 身份唯一索引 ---------- */

// 手机号规范化：去掉空格、连字符、括号与 +86 / 0086 / 86 前缀，统一存 "+86" + 11 位。
// 非法号码返回 ""。
function normalizePhone(raw) {
  let s = String(raw || "").replace(/[\s\-()]/g, "");
  if (!s) return "";
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("0086")) s = s.slice(4);
  else if (s.startsWith("86") && s.length > 11) s = s.slice(2);
  if (!/^1[3-9]\d{9}$/.test(s)) return "";
  return "+86" + s;
}

function maskPhone(p) {
  const m = /^\+86(\d{11})$/.exec(String(p || ""));
  if (!m) return "";
  return "+86 " + m[1].slice(0, 3) + "****" + m[1].slice(7);
}

function identityKey(kind, value) {
  return String(kind || "") + ":" + String(value || "");
}

function identityEntry(kind, value) {
  const k = identityKey(kind, value);
  return (db.identities || []).find((x) => identityKey(x.kind, x.value) === k) || null;
}

// 按身份取用户（kind: username / phone / wechat_unionid）
function identityGet(kind, value) {
  const e = identityEntry(kind, value);
  if (!e) return null;
  return db.users.find((u) => u.id === e.userId) || null;
}

// 认领一个身份；已被他人占用返回 false，本人重复认领视为成功。
async function identityClaim(kind, value, userId) {
  const v = String(value || "");
  if (!v) return false;
  const ok = await accountStore.claimIdentity(kind, v, userId);
  if (!ok) return false;
  const k = identityKey(kind, v);
  if (!db.identities.some((x) => identityKey(x.kind, x.value) === k)) {
    db.identities.push({ kind, value: v, userId, createdAt: now() });
  }
  return true;
}

async function identityRelease(kind, value, userId) {
  await accountStore.releaseIdentity(kind, value, userId);
  const k = identityKey(kind, value);
  db.identities = (db.identities || []).filter(
    (x) => !(identityKey(x.kind, x.value) === k && (!userId || x.userId === userId)),
  );
}

// 从 users 重建身份唯一索引（老库升级 / 索引缺失时调用）。
function rebuildIdentities() {
  const seen = new Set();
  const out = [];
  const push = (kind, value, userId, at) => {
    const v = String(value || "");
    if (!v) return;
    const k = identityKey(kind, v);
    if (seen.has(k)) {
      console.warn("[store] duplicate identity skipped:", k);
      return;
    }
    seen.add(k);
    out.push({ kind, value: v, userId, createdAt: at || now() });
  };
  for (const u of db.users) {
    push("username", String(u.username || "").toLowerCase(), u.id, u.createdAt);
    push("phone", u.phone, u.id, u.phoneVerifiedAt);
    push("wechat_unionid", u.wechatUnionId, u.id, u.wechatBoundAt);
  }
  return out;
}

async function ensureIdentityIndex() {
  const next = rebuildIdentities();
  const cur = Array.isArray(db.identities) ? db.identities : [];
  const same =
    cur.length === next.length &&
    next.every((e, i) => {
      const c = cur[i];
      return c && c.kind === e.kind && c.value === e.value && c.userId === e.userId;
    });
  if (!same) {
    await accountStore.replaceIdentities(next);
    db.identities = next;
  }
}

// 启动时把账户三件套载入内存缓存：之后读走缓存（登录校验等热路径不打云库），
// 写走 account-store 落库成功后再同步缓存（见 applyUserPatch / issueSession / identity*）。
async function bootstrapAccountStore() {
  await accountStore.ready();
  db.users = await accountStore.listUsers();
  db.sessions = await accountStore.listSessions();
  db.identities = await accountStore.listIdentities();
  await ensureIdentityIndex();
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    avatar: u.avatar || "",
    phone: u.phone ? maskPhone(u.phone) : "",
    phoneVerified: !!u.phoneVerifiedAt,
    hasPassword: !!u.pass,
    bindings: {
      phone: !!u.phone,
      wechat: !!u.wechatUnionId,
      password: !!u.pass,
    },
    downloadsReceived: u.downloadsReceived || 0,
    likesReceived: u.likesReceived || 0,
    // 余额（元，4 位小数）：客户端只对充值白名单账号展示，但字段一律随本人快照下发，
    // 避免「服务端有余额、客户端要再打一次接口」。他人摘要走 publicTemplate/publicSkill，不含此字段。
    // 内部存储仍是整数分（balanceCents），只在出接口时换算 —— 对外不出现「分」。
    balanceYuan: yuanOfCents(Number(u.balanceCents) || 0),
    createdAt: u.createdAt,
    isAdmin: isAdmin(u),
  };
}

/* ---------- 公开投影的「打赏 / 评分 / 评论数」三块（契约第三节） ---------- *
 * 一律**实时算**（不在对象上存快照字段）。列表接口是分页的，绝不能在循环里逐个对象算：
 *   先收本页 ids → tipEnrich / ratingEnrich 批量取 → 逐条投影时传进来。
 * 单个对象（详情 / 新建返回）不传 enrich，函数自己算一次（O(表) 而已，不会 N²）。
 * ------------------------------------------------------------------ */

function tipEnrich(kind, ids) {
  return plans.enricher(kind, ids);
}
function commentEnrich(kind, list) {
  return comments.enricher(kind, list);
}
/** 打赏 + 评论一次收齐（列表接口两个 Map 都建好了再逐行投影）。
 *  `list` 里可以是 id（模板 / 技能），也可以是 `{ id, ownerId }`（**应用按分支**，本轮需求 4）——
 *  取用时按 (id, ownerId) 取；打赏那边只吃 id（打赏仍按家族根统一，不跟着分支走）。 */
function enrichOf(kind, list) {
  const ids = (Array.isArray(list) ? list : []).map((x) =>
    x && typeof x === "object" ? String(x.id || "") : String(x || ""),
  );
  const tipsFn = tipEnrich(kind, ids);
  const cmtFn = commentEnrich(kind, list);
  return (id, ownerId) => {
    const c = cmtFn(id, ownerId);
    return { tips: tipsFn(id), rating: c.rating, comments: c.comments };
  };
}
/** 单条对象的三块（详情 / 新建返回用）。app 传 ownerId = 那一条分支的作者（本轮需求 4）。 */
function enrichOne(kind, id, ownerId) {
  return {
    tips: plans.summaryOf(kind, id),
    rating: comments.ratingOf(kind, id, ownerId),
    comments: comments.countOf(kind, id, ownerId),
  };
}
/** 把三块并进投影（site 与缺省口径都在这里，别在各处重复拼字段名）。 */
function withEnrich(obj, kind, id, en, ownerId) {
  const e = en || enrichOne(kind, id, ownerId);
  return Object.assign(obj, { tips: e.tips, rating: e.rating, comments: e.comments });
}
function publicTemplate(t, viewer, en) {
  const viewerId = viewer && viewer.id;
  const owner = db.users.find((u) => u.id === t.userId);
  return withEnrich({
    id: t.id,
    title: t.title,
    description: t.description || "",
    tags: t.tags || [],
    downloads: t.downloads || 0,
    likes: t.likes || 0,
    bytes: t.bytes || 0,
    hasPreview: !!t.hasPreview,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    owner: owner
      ? { id: owner.id, username: owner.username, nickname: owner.nickname }
      : { id: t.userId, username: "", nickname: "" },
    liked: viewerId ? db.likes.some((l) => l.userId === viewerId && l.templateId === t.id) : false,
    mine: !!(viewerId && viewerId === t.userId),
    canDelete: !!(viewerId && (viewerId === t.userId || isAdmin(viewer))),
  }, "template", t.id, en);
}

function publicSkill(s, viewer, en) {
  const viewerId = viewer && viewer.id;
  const owner = db.users.find((u) => u.id === s.userId);
  return withEnrich({
    id: s.id,
    skillName: s.skillName,
    title: s.title,
    description: s.description || "",
    version: s.version || "1.0.0",
    official: !!s.official,
    tags: s.tags || [],
    downloads: s.downloads || 0,
    likes: s.likes || 0,
    bytes: s.bytes || 0,
    files: Array.isArray(s.files) ? s.files : [],
    hasPreview: !!s.hasPreview,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    owner: owner
      ? { id: owner.id, username: owner.username, nickname: owner.nickname }
      : { id: s.userId, username: "", nickname: "" },
    liked: viewerId
      ? db.skillLikes.some((l) => l.userId === viewerId && l.skillId === s.id)
      : false,
    mine: !!(viewerId && viewerId === s.userId),
    canDelete: !!(viewerId && (viewerId === s.userId || isAdmin(viewer))),
  }, "skill", s.id, en);
}

function tagCounts(kind) {
  const list = kind === "skills" ? db.skills : db.templates;
  const map = new Map();
  for (const t of list) {
    for (const tag of t.tags || []) {
      map.set(tag, (map.get(tag) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
}

function normalizeTag(s) {
  let t = String(s || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (/^[A-Za-z0-9._-]+$/.test(t)) t = t.toLowerCase();
  if (t.length > 24) t = t.slice(0, 24);
  return t;
}

function parseTags(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || "")
        .split(/[,，]/);
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const t = normalizeTag(x);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

function findUserByName(name) {
  const n = String(name || "").toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === n);
}

async function issueSession(u) {
  const token = crypto.randomBytes(24).toString("hex");
  const t = now();
  /* 登录这里**不动中转票**：票是按账号幂发的（明文存在该账号记录里，见 ensureRelayKey），
     同一账号重登一百次拿到的还是同一张（用户口径：分发一次后不应当失效）。
     「换账号」的轮换不在这里做 —— 登录那一刻还不知道这台机器上原来是谁的票
     （客户端往往还没同步中转清单），判据落在**领票**那一步：换个登录会话/换个账号来领票时轮换。 */
  if (db.sessions.some((s) => s.expiresAt <= t)) await accountStore.pruneSessions(t);
  // 多端并存：登录不再删除同一用户的其它会话（旧设备保持在线），登出只删当前 token。
  const session = await accountStore.createSession({
    tokenHash: hashToken(token),
    userId: u.id,
    expiresAt: t + SESSION_MS,
  });
  db.sessions = db.sessions.filter((s) => s.expiresAt > t);
  db.sessions.push(session);
  return token;
}

/**
 * 管理台「会话测试」用的临时 Key（mtr_test_ 前缀 / 30 分钟 / 只对该管理员）。
 * 挂在 adminSessions 里（与账户会话表分开，随 db.json 落盘），authUser 只对 /relay/v1/* 认它。
 */
async function issueRelayTestKey(u, opt) {
  const o = opt || {};
  const ttl = Math.max(60000, Math.floor(Number(o.ttlMs) || 30 * 60 * 1000));
  const token = String(o.prefix || "mtr_test_") + crypto.randomBytes(18).toString("hex");
  const t = now();
  pruneAdminSessions(t);
  db.adminSessions.push({
    tokenHash: hashToken(token),
    userId: u.id,
    expiresAt: t + ttl,
    createdAt: t,
    relayTest: true,
  });
  await saveDb();
  return { token: token, expiresAt: t + ttl };
}

/** 中转 Key → 用户：只认 mtr_test_ 前缀的测试票，且只对 /relay/v1/* 生效。 */
function relayTestUser(req, isRelayPath) {
  if (!isRelayPath) return null;
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(mtr_test_\S+)$/i.exec(h);
  if (!m) return null;
  const th = hashToken(m[1]);
  const t = now();
  const sess = adminSessions().find((s) => s.tokenHash === th && s.relayTest === true && s.expiresAt > t);
  if (!sess) return null;
  return db.users.find((u) => u.id === sess.userId) || null;
}

// 滑动续期：任一鉴权请求命中会话就把有效期推到 now + SESSION_MS，实现「登录后持续有效，
// 除非主动登出」。仅当剩余不足一半才写库，避免每个请求都打一次云库；写库失败只记日志，
// 内存已续期（本次请求照常放行），下次请求会重试写穿。
async function touchSession(sess, t) {
  /* 中转 Key 与登录会话同一张表，但 TTL 不同：各自用各自的窗口续期（见 RELAY_KEY_MS）。
     判据取记录上的 kind（老记录没有 kind = 登录会话）。 */
  const relay = String(sess.kind || "") === RELAY_KEY_KIND;
  const ttl = relay ? RELAY_KEY_MS : SESSION_MS;
  if (sess.expiresAt - t >= ttl / 2) return;
  const next = t + ttl;
  sess.expiresAt = next;
  try {
    await accountStore.updateSession({
      tokenHash: sess.tokenHash,
      userId: sess.userId,
      expiresAt: next,
      kind: sess.kind,
    });
  } catch (e) {
    console.warn("[mtnode-store] session renew failed: " + ((e && e.message) || e));
  }
}

/* ── 中转站独立 Key（3650 天 · 滑动续期）────────────────────────────────────
   为什么要独立：以前「中转 Key = 账号登录 token」，客户端一换机 / 密码一变 /
   会话被清，中转卡就跟着 401（症状 = 「缺少或已失效的中转 Key」，用户以为要自己填 Key）。
   现在登录照旧发登录会话，中转另发一张 3650 天的独立票；客户端把它存进本机加密凭据，
   主进程每次请求现取现用（明文不出主进程，也不落 config.json）。
   **常规不再轮换**：同一账号现役票只有一张，且这张的明文落在用户记录里（relayKeyPlain）——
   /api/relay/me 已有有效票就**原样返回同一张**（幂发，见 ensureRelayKey），
   多开客户端 / 多台机器 / 重登多少次都不会互相顶掉（老口径「每次重发 + 作废旧票」
   正是「登录了还是恒 401、界面让人重登」的根因）。
   作废只剩两条显式路径：**主动退出登录**与**删号**（见 revokeRelayKeys）。
   已知边界（本轮据此把口径写在注释里，不改行为）：客户端在同一台机器上换账号时，
   上一账号那张票会一直留在服务端有效（客户端手上那份已随换账号丢弃）；
   要立刻收回它就**主动退出登录**一次 —— 退出登录带中转票也能打通（见 /api/logout）。 */
/* 明文票的落库字段（用户记录上一个字段，见 ensureRelayKey 的注释）。
   形状：{ key, expiresAt, issuedAt, holderSession, device }；没票 = 字段不存在 / 空对象。 */
const RELAY_KEY_FIELD = "relayKeyPlain";
/** 读用户记录里那份明文票（坏形状一律当没有）。 */
function relayPlainOf(u) {
  const v = u && u[RELAY_KEY_FIELD];
  if (!v || typeof v !== "object") return null;
  const key = String(v.key || "").trim();
  if (!key) return null;
  return {
    key: key,
    expiresAt: Number(v.expiresAt || 0) || 0,
    issuedAt: Number(v.issuedAt || 0) || 0,
    /* 领走这张票的**登录会话**（只存 tokenHash，不存明文）：留作排查与将来判据用。 */
    holderSession: String(v.holderSession || ""),
    /* 领走这张票的**本机设备标识**（客户端在 X-MTNode-Device 头里带，随机串）：
       只作留档 / 排查（哪台机器领的这张票），**不参与轮换判定** ——
       同一账号多开客户端、多台设备共用同一张票正是本轮要的幂发口径。 */
    device: String(v.device || ""),
  };
}
/** 清掉明文票字段（**只清明文**：hash 记录由调用方按需删）。 */
async function clearRelayKeyPlain(u) {
  if (!u || !u.id) return false;
  if (!relayPlainOf(u)) return false;
  const next = await applyUserPatch(u.id, { [RELAY_KEY_FIELD]: null });
  if (!next) return false;
  Object.assign(u, { [RELAY_KEY_FIELD]: null });
  return true;
}
/** 作废该账号现役的中转票：删 kind=relay 的 hash 记录 + 清明文（换账号 / 退出登录用）。 */
async function revokeRelayKeys(u) {
  if (!u) return 0;
  const gone = (db.sessions || []).filter(
    (s) => String(s.userId || "") === String(u.id || "") && String(s.kind || "") === RELAY_KEY_KIND,
  );
  for (const s of gone) {
    try {
      await accountStore.deleteSession(s.tokenHash);
    } catch (e) {
      console.warn("[mtnode-store] relay key revoke failed: " + ((e && e.message) || e));
    }
  }
  if (gone.length) {
    const set = new Set(gone.map((s) => s.tokenHash));
    db.sessions = db.sessions.filter((s) => !set.has(s.tokenHash));
  }
  /* 内存缓存里的这份用户对象也要改（它可能与库里那份不是同一个引用） */
  const cached = (db.users || []).find((x) => x.id === u.id);
  await clearRelayKeyPlain(cached || u);
  return gone.length;
}

async function issueRelayKey(u, t, holderSession, device) {
  const token = crypto.randomBytes(24).toString("hex");
  const nowTs = Number(t) || now();
  const tokenHash = hashToken(token);
  /* 先作废该账号手里的旧票（含已过期的），再发新的：库里只留这一张，
     否则「重发」会变成「多张同时有效」，被顶掉的老客户端还能一直用。 */
  const old = (db.sessions || []).filter(
    (s) => String(s.userId || "") === String(u.id || "") && String(s.kind || "") === RELAY_KEY_KIND,
  );
  for (const s of old) {
    try {
      await accountStore.deleteSession(s.tokenHash);
    } catch (e) {
      console.warn("[mtnode-store] relay key revoke failed: " + ((e && e.message) || e));
    }
  }
  if (old.length) {
    const gone = new Set(old.map((s) => s.tokenHash));
    db.sessions = db.sessions.filter((s) => !gone.has(s.tokenHash));
  }
  await accountStore.createSession({
    tokenHash,
    userId: u.id,
    expiresAt: nowTs + RELAY_KEY_MS,
    kind: RELAY_KEY_KIND,
    createdAt: nowTs,
  });
  db.sessions = (db.sessions || []).filter((s) => s.tokenHash !== tokenHash);
  db.sessions.push({ tokenHash, userId: u.id, expiresAt: nowTs + RELAY_KEY_MS, kind: RELAY_KEY_KIND, createdAt: nowTs });
  /* 明文存进用户记录：**这是「分发一次后不失效」的关键一步** —— 库里只有 hash 时
     服务端拿不回现役票，只能每次来领都重发一张并作废旧的（多开客户端 / 多台机器
     互相顶掉 ⇒ 恒 401 ⇒ 界面弹「请重新登录」，本 bug 的现场）。
     存明文之后 /api/relay/me 可以「已有有效票就原样返回同一张」，同一个账号无论
     多少台机器、重登多少次拿到的都是同一张票，谁也不会把谁顶掉。
     安全口径：明文只落服务端用户记录、只经 /api/relay/me 回给客户端主进程；
     publicUser 是白名单投影，不会外泄；hash 记录仍是鉴权真源（authUser 只认它）。 */
  const plain = {
    key: token,
    expiresAt: nowTs + RELAY_KEY_MS,
    issuedAt: nowTs,
    /* 领走这张票的登录会话与设备标识（都只存摘要，见 relayPlainOf 的注释）。 */
    holderSession: String(holderSession || ""),
    device: String(device || ""),
  };
  try {
    const patched = await accountStore.updateUser(u.id, { [RELAY_KEY_FIELD]: plain });
    if (patched) {
      const cached = (db.users || []).find((x) => x.id === u.id);
      if (cached) Object.assign(cached, { [RELAY_KEY_FIELD]: plain });
      Object.assign(u, { [RELAY_KEY_FIELD]: plain });
    } else {
      console.warn("[mtnode-store] relay key plain persist returned null: " + u.id);
    }
  } catch (e) {
    /* 明文没落住不影响这次发出去的票（hash 已落，票照样能用）；
       只影响「下次能不能原样返回同一张」—— 那种情况退回老口径（重发一张并作废旧票）。 */
    console.warn("[mtnode-store] relay key plain persist failed: " + ((e && e.message) || e));
  }
  return { token, expiresAt: nowTs + RELAY_KEY_MS, ttlMs: RELAY_KEY_MS };
}

/** 复用窗口：剩余寿命还有**有效期一半**以上就原样返回现役票，不再轮换。
 *  （客户端在「剩余不足有效期 1/6」时才主动来续期，所以正常拿到的永远是同一张；
 *   只剩不到一半寿命时换一张新的，给客户端留足换票余量。） */
const RELAY_KEY_REUSE_MS = Math.floor(RELAY_KEY_MS / 2);

/* ── 手动轮换中转 Key（客户端「设置 · 提供商」中转卡上的「更换 Key」）──────────
   幂发口径下「再领一次」只会拿回同一张票，所以换 Key 需要一个**显式**入口：
   POST /api/relay/me { rotate: true } —— 跳过复用窗口、发新票并作废旧票。
   为什么限频：一张票就是该账号的中转身份，随手换会让正在用旧 Key 的机器
   （Codex / 桌宠 / 另一台电脑）当场 401；每日上限把误点与刷票挡住。
   计数口径：按账号 + **服务器本地时区**的自然日，落在用户记录 relayKeyRotations
   （形状 { day: "YYYY-MM-DD", count: n }）—— 跟库走，重启不清零。
   旧票口径：换 Key 后**旧票立即失效**（issueRelayKey 本来就会作废旧 hash 记录），
   不设宽限窗口 —— 免得两台机器长期各持一张有效票。 */
const RELAY_ROTATE_LIMIT = 5;
const RELAY_ROTATE_FIELD = "relayKeyRotations";
/** 服务器本地时区的自然日键（"YYYY-MM-DD"）。 */
function relayDayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
/** 该账号今天的轮换用量（只读，不变更任何东西）。 */
function relayRotateStateOf(u, t) {
  const rec = (u && u[RELAY_ROTATE_FIELD]) || null;
  const day = relayDayKey(t);
  const used =
    rec && String(rec.day || "") === day ? Math.max(0, Number(rec.count || 0) || 0) : 0;
  return {
    day: day,
    used: used,
    limit: RELAY_ROTATE_LIMIT,
    left: Math.max(0, RELAY_ROTATE_LIMIT - used),
  };
}
/** 记一次轮换（超限返回 ok:false，调用方据此回 429）。 */
async function consumeRelayRotate(u, t) {
  const st = relayRotateStateOf(u, t);
  if (st.left <= 0) return { ok: false, state: st };
  const next = { day: st.day, count: st.used + 1 };
  try {
    const patched = await applyUserPatch(u.id, { [RELAY_ROTATE_FIELD]: next });
    if (!patched) console.warn("[mtnode-store] relay rotate count persist returned null: " + u.id);
  } catch (e) {
    /* 计数没落住不影响这次换票（票已发），只影响「今天还能换几次」的准确性。 */
    console.warn("[mtnode-store] relay rotate count persist failed: " + ((e && e.message) || e));
  }
  Object.assign(u, { [RELAY_ROTATE_FIELD]: next });
  return {
    ok: true,
    state: {
      day: st.day,
      used: next.count,
      limit: RELAY_ROTATE_LIMIT,
      left: Math.max(0, RELAY_ROTATE_LIMIT - next.count),
    },
  };
}
/** 换票后的统一视图（GET 与 POST rotate 两条路共用一份字段口径）。 */
function relayRotateView(u, t) {
  const st = relayRotateStateOf(u, t);
  return {
    relayKeyRotateLimit: st.limit,
    relayKeyRotateUsed: st.used,
    relayKeyRotateLeft: st.left,
    relayKeyRotateDay: st.day,
  };
}

/** 该账号的中转 Key（**幂发**）：/api/relay/me 用它把票交给客户端。
 *
 *  口径（本 bug 的正解）：**已有现役票就原样返回同一张，不再每次重发**。
 *  客户端登录 / 启动 / 打开设置都会打这个入口（见 renderer/app-relay.js 的 syncIfStale），
 *  老写法每次调用都 issueRelayKey() —— 发新票 + 作废该账号旧票，于是多开客户端 /
 *  多台机器同步时互相顶掉：A 刚领到票，B 一次同步就把它作废 ⇒ A 恒 401 ⇒
 *  界面弹「中转 Key 已失效，请重新登录」，而用户重登后 B 又把它顶掉（现场截图就是这么来的）。
 *
 *  实现：明文票落在用户记录 relayKeyPlain（见 issueRelayKey 的注释），所以这里能
 *  「看得到现役票」并原样返回；hash 记录仍是鉴权真源，这里顺手确认它还在（被清过 / 过期
 *  就重发一张）。作废只剩两条显式路径：**主动退出登录**与**删号**（都走 revokeRelayKeys）。
 *
 *  device = 客户端报的本机标识（X-MTNode-Device）：只记进明文票里留作排查与将来判据，
 *  本身不参与轮换判定 —— 同一账号多开客户端 / 多台设备共用同一张票是本轮的需求口径。
 *
 *  返回的 token 一定非空：客户端据此把票存进本机加密凭据（明文只经这一条路径回主进程）。 */
async function ensureRelayKey(u, requesterSession, device, opts) {
  const o = opts || {};
  const t = now();
  const cur = relayPlainOf(u);
  /* rotate = 客户端显式要求换一张（卡上「更换 Key」按钮）：跳过复用窗口，
     直接走下面的重发（发新票 + 作废旧 hash 记录），限频由调用方先扣。 */
  if (!o.rotate && cur && cur.expiresAt - t >= RELAY_KEY_REUSE_MS) {
    let alive = null;
    try {
      alive = await accountStore.getSession(hashToken(cur.key));
    } catch (e) {
      alive = null;
    }
    const okSession = !!(alive && String(alive.kind || "") === RELAY_KEY_KIND && Number(alive.expiresAt || 0) >= t);
    if (okSession) {
      return { expiresAt: Number(alive.expiresAt || cur.expiresAt), ttlMs: RELAY_KEY_MS, token: cur.key };
    }
    /* 明文在、hash 记录没了（被手工清过 / 过期 / 退出登录清过）：走下面重发一张，
       别把一张废票发给客户端。 */
    console.warn("[mtnode-store] relay key plain 在但会话已失效，重发一张：" + String(u && u.id));
  }
  const made = await issueRelayKey(u, t, requesterSession, device);
  return { expiresAt: made.expiresAt, ttlMs: RELAY_KEY_MS, token: made.token };
}

/** 给客户端的中转 Key 视图：明文在这个入口下发（客户端存本机加密凭据）。
 *  同一账号反复来领拿到的是**同一张**（见 ensureRelayKey），换账号 / 退出登录 / 过期才换新。 */
async function relayKeyView(u, requesterSession, device, opts) {
  const r = await ensureRelayKey(u, requesterSession, device, opts);
  return {
    expiresAt: r.expiresAt,
    ttlMs: r.ttlMs,
    renewBeforeMs: Math.floor(RELAY_KEY_MS / 6),
    issued: !!r.token,
    relayKey: r.token || "",
  };
}

function validPassword(password) {
  const s = String(password || "");
  return s.length >= 6 && s.length <= 72;
}

// 昵称规范：去控制字符 + 去首尾空白，长度 1-32 才合法（否则返回空串，由调用方决定报错或回退）。
function normalizeNickname(raw) {
  const s = String(raw == null ? "" : raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return s.length >= 1 && s.length <= 32 ? s : "";
}

// 新建账号：短信/微信登录自动建号共用。username 为内部占位名（不可作为登录方式）。
async function createUser(fields) {
  const u = await accountStore.createUser(fields);
  db.users.push(u);
  return u;
}

// 用户字段写穿：先落 account-store，成功后同步内存缓存；返回落库后的用户（失败为 null）。
async function applyUserPatch(id, patch) {
  const next = await accountStore.updateUser(id, patch);
  if (next) {
    const i = db.users.findIndex((x) => x.id === id);
    if (i >= 0) db.users[i] = next;
    else db.users.push(next);
  }
  return next;
}

/* ========================================================================== *
 * 充值账本（订单 / 流水 / 余额）—— 逻辑全在 wallet.mjs，这里只做接线与鉴权
 * ========================================================================== */

const wallet = createWallet({ db, saveDb, applyUserPatch });

/* ========================================================================== *
 * 打赏 + 评论 + 消息（编排逻辑分别在 tips.mjs / comments.mjs / notifications.mjs，
 * 这里只做接线与鉴权）
 *   · tips          —— 打赏只能经 wallet.adjustBalance 动钱（铁律①），本层不自己写余额；
 *   · comments      —— 评论 / 五星评分 / 软删除，实时算平均星与评论数；
 *                      **应用的评论与评分按「应用 id + 分支作者」分池**（本轮需求 4：
 *                      评论跟着作者走），打赏仍按家族根统一 —— 两者刻意分开；
 *   · notifications —— 消息（打赏 / 评论 / 回复），只落 db.notifications，**绝不碰钱包**。
 * 消息实例先建（tips / comments 都把它当可选依赖注入，只用于旁路记消息），
 * 实例化顺序：wallet → notifications → tips / comments。
 * ========================================================================== */

const alerts = createNotifications({
  db,
  saveDb,
  users: () => db.users,
  now,
});

const plans = createTips({
  db,
  saveDb,
  wallet,
  applyUserPatch,
  users: () => db.users,
  now,
  notifications: alerts,
  ledger: () => db.rechargeLedger,
  /* 应用家族口径（分支树统一；**打赏**按根应用统一）：
     groupIdOf = 家族归组 id（根条目的 id）；entriesOf = 族里全部记录。
     传下去让 tips 的统计、分账作者名单与分支树都走同一份口径。
     ⚠ 评论 / 评分**本轮起按分支分开**（见下面 comments 的 branch 注入）：comments 只用 tips
     的 idSetOf 拿「同族 id 集合」，池的归属由「应用 id + 分支作者」决定。 */
  family: {
    groupIdOf: (id, ownerId) => appFamilyGroupId(id, ownerId),
    entriesOf: (id, ownerId) => appFamilyEntries(id, ownerId),
  },
});

const comments = createComments({
  db,
  saveDb,
  isAdmin,
  users: () => db.users,
  now,
  notifications: alerts,
  tips: plans,
  /* 应用分支口径（本轮需求 4：**应用的评论跟着作者走**）：
     ownerOf      = 把 ?owner=<uid|账号名> 解析成**那一条分支**的作者 uid
                    （那条分支必须真存在，认不出回 "" —— server 侧不静默落到主干）；
     trunkOwnerOf = 这个 id 的主干（原作者那条）作者 uid：没有分支标记的老评论都归它。 */
  branch: {
    ownerOf: (id, hint) => {
      const key = String(appResolveOwnerId(hint) || hint || "").trim();
      if (!key) return "";
      const hit = appBranchesOf(String(id || "")).find(
        (a) => String((a && a.userId) || "") === key || String((a && a.userId) || "") === String(hint || "").trim(),
      );
      return hit ? String(hit.userId || "") : "";
    },
    trunkOwnerOf: (id) => String(appFamilyRootOwnerId(String(id || ""), "") || ""),
  },
});
/* ========================================================================== *
 * 中转站（内部测试用）：DeepSeek 文本/识图 + gpt-image-2.5 图像，鉴权 = 账号登录 token，
 * 门禁 = 可用余额 > 0，计费 = 按用量扣（亚分精度，见 relay.mjs 文件头）。逻辑全在 relay.mjs，
 * 这里只把 /relay/v1/* 转给它，并注入 db / 落盘 / 钱包 / 原样读体（multipart 要原包转发）。
 * ========================================================================== */

const relay = createRelay({
  db,
  saveDb,
  wallet,
  readBody,
  issueSession: issueRelayTestKey,
  publicBase: RELAY_PUBLIC_BASE,
});

/** 谁能用钱包 / 下单：**所有已注册（已登录）账号**。
 *  唯一的闸门是显式全局关闭 MTNODE_RECHARGE_CLOSED（见上）；名单口径已作废。 */
function rechargeAllowed(u) {
  if (!u) return false;
  return !rechargeGloballyClosed();
}

/* ========================================================================== *
 * 管理平台会话（独立 8 小时短会话，只对 /api/admin/* 生效）
 *   与客户端 Bearer 完全分开：管理页 token 泄露也打不了客户端账号，且能单独失效。
 *   存 db.json（不进 Tablestore —— 它是「一次登录一张票」，不是账户数据）。
 * ========================================================================== */

/** 管理员判据：isAdmin ∪ MTNODE_ADMIN_USERS ∪ 微信 unionid 白名单（三条任一命中）。 */
function adminEligible(u) {
  if (!u) return false;
  if (isAdmin(u)) return true;
  if (ADMIN_EXTRA_USERS.has(String(u.username || "").toLowerCase())) return true;
  const uin = String(u.wechatUnionId || "").trim();
  return !!(uin && ADMIN_WECHAT_UNIONIDS.has(uin.toLowerCase()));
}

function adminSessions() {
  if (!Array.isArray(db.adminSessions)) db.adminSessions = [];
  return db.adminSessions;
}

function pruneAdminSessions(t) {
  const arr = adminSessions();
  const keep = arr.filter((s) => s.expiresAt > t);
  if (keep.length !== arr.length) db.adminSessions = keep;
  return keep;
}

async function issueAdminSession(u) {
  const token = "adm_" + crypto.randomBytes(24).toString("hex");
  const t = now();
  pruneAdminSessions(t);
  db.adminSessions.push({
    tokenHash: hashToken(token),
    userId: u.id,
    createdAt: t,
    expiresAt: t + ADMIN_SESSION_MS,
  });
  await saveDb();
  return token;
}

async function revokeAdminSession(token) {
  const th = hashToken(String(token || ""));
  const before = adminSessions().length;
  db.adminSessions = adminSessions().filter((s) => s.tokenHash !== th);
  if (db.adminSessions.length !== before) await saveDb();
  return db.adminSessions.length !== before;
}

/** 解析管理会话；顺带复核管理员资格（名单被改后旧票立刻失效）。 */
function authAdmin(req) {
  const m = /^Bearer\s+(adm_\S+)$/i.exec(String(req.headers.authorization || ""));
  if (!m) return null;
  const th = hashToken(m[1]);
  const t = now();
  const sess = pruneAdminSessions(t).find((s) => s.tokenHash === th);
  if (!sess) return null;
  const u = db.users.find((x) => x.id === sess.userId) || null;
  if (!u || !adminEligible(u)) return null;
  return { user: u, session: sess, token: m[1] };
}

/* ---------- 单 IP 每小时频控（管理页登录 / 充值下单 / 查单刷新共用一套桶） ---------- */

const ipBuckets = new Map(); // key|ip -> [ts]

function ipGate(key, ip, max) {
  const k = key + "|" + ip;
  const t = now();
  const arr = (ipBuckets.get(k) || []).filter((x) => t - x < 3600 * 1000);
  if (arr.length >= max) {
    ipBuckets.set(k, arr);
    return { ok: false, retryAfter: Math.ceil((arr[0] + 3600 * 1000 - t) / 1000) };
  }
  return { ok: true, key: k, arr };
}

function ipCommit(gate) {
  if (!gate || !gate.ok) return;
  gate.arr.push(now());
  ipBuckets.set(gate.key, gate.arr);
  if (ipBuckets.size > 2000) {
    const t = now();
    for (const [k, arr] of ipBuckets) {
      const keep = arr.filter((x) => t - x < 3600 * 1000);
      if (keep.length) ipBuckets.set(k, keep);
      else ipBuckets.delete(k);
    }
  }
}

function rateLimited(res, gate) {
  return send(res, 429, {
    ok: false,
    code: "RATE_LIMITED",
    error: "请求过于频繁，请稍后再试",
    retryAfter: gate.retryAfter,
  });
}

/* ---------- 统一账户层：登录 / 二次验证 / 绑定 ---------- */

// 密码登录：仅对已设置密码的老账号有效（新注册已停用）。
function accountLoginPassword(username, password) {
  const u = findUserByName(username);
  if (!u || !u.pass) return null;
  if (hashPass(password, u.salt) !== u.pass) return null;
  return u;
}

// 二次验证：优先账号密码；无密码或未带密码时用短信验证码（手机号场景）。
function checkSecondFactor(user, b) {
  const password = String((b && b.password) || "");
  if (password) {
    if (user.pass && hashPass(password, user.salt) === user.pass) return { ok: true };
    return { ok: false, status: 403, code: "SECOND_FACTOR_FAILED", error: "二次验证失败" };
  }
  const code = String((b && b.code) || "");
  if (code && user.phone) {
    const r = verifySmsCode(user.phone, code, "verify");
    if (r.ok) return { ok: true };
    return { ok: false, status: r.status || 400, code: r.code, error: r.error };
  }
  return {
    ok: false,
    status: 400,
    code: "SECOND_FACTOR_REQUIRED",
    error: "需要二次验证（账号密码或短信验证码）",
  };
}

// 绑定场景的二次验证：账号已设密码时必须再验密码（绑定手机号/微信时目标身份归属另由 code/ticket 证明）。
function requirePasswordIfSet(user, b) {
  if (!user.pass) return { ok: true };
  const password = String((b && b.password) || "");
  if (!password) {
    return { ok: false, status: 400, code: "SECOND_FACTOR_REQUIRED", error: "需要账号密码二次验证" };
  }
  if (hashPass(password, user.salt) !== user.pass) {
    return { ok: false, status: 403, code: "SECOND_FACTOR_FAILED", error: "二次验证失败" };
  }
  return { ok: true };
}

/* ---------- 短信验证码（发送频控 + 存储 + 校验即焚） ---------- */

// 内存态：单进程、零依赖，重启清零（与频控口径一致）。
const smsCodes = new Map(); // phone -> { salt, hash, expiresAt, attempts, scene, sentAt }
const smsPhoneSends = new Map(); // phone -> [ts]（冷却 / 日上限）
const smsIpSends = new Map(); // ip -> [ts]（每小时上限）
const smsLocks = new Map(); // phone -> 锁定截止时间戳
const smsLoginIp = new Map(); // ip -> [ts]（登录接口频控）
// 每进程随机密钥：验证码只以 HMAC-SHA256 形式驻留内存，不落明文、不写库。
const SMS_HASH_KEY = crypto.randomBytes(32);

function hashSmsCode(salt, code) {
  return crypto.createHmac("sha256", SMS_HASH_KEY).update(String(salt) + ":" + String(code)).digest();
}

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "");
  const first = xf.split(",")[0].trim();
  if (first) return first;
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pruneSmsMap(map, winMs, t) {
  if (map.size < 500) return;
  for (const [k, arr] of map) {
    const keep = arr.filter((x) => t - x < winMs);
    if (keep.length) map.set(k, keep);
    else map.delete(k);
  }
}

// 发送前置频控：单号冷却 → 单号日上限 → 单 IP 每小时上限。
function smsSendGate(phone, ip) {
  const t = now();
  const lock = smsLocks.get(phone) || 0;
  if (lock > t) return { ok: false, retryAfter: Math.max(1, Math.ceil((lock - t) / 1000)) };

  const phoneArr = (smsPhoneSends.get(phone) || []).filter((x) => t - x < 24 * 3600 * 1000);
  const last = phoneArr.length ? phoneArr[phoneArr.length - 1] : 0;
  if (last && t - last < SMS_COOLDOWN_MS) {
    return { ok: false, retryAfter: Math.ceil((SMS_COOLDOWN_MS - (t - last)) / 1000) };
  }
  const dayStart = startOfDay(t);
  if (phoneArr.filter((x) => x >= dayStart).length >= SMS_DAILY_MAX) {
    return { ok: false, retryAfter: Math.ceil((dayStart + 24 * 3600 * 1000 - t) / 1000) };
  }
  const ipArr = (smsIpSends.get(ip) || []).filter((x) => t - x < 3600 * 1000);
  if (ipArr.length >= SMS_IP_HOURLY_MAX) {
    return { ok: false, retryAfter: Math.ceil((ipArr[0] + 3600 * 1000 - t) / 1000) };
  }
  return { ok: true, phoneArr, ipArr };
}

function smsSendCommit(phone, ip, phoneArr, ipArr) {
  const t = now();
  phoneArr.push(t);
  ipArr.push(t);
  smsPhoneSends.set(phone, phoneArr);
  smsIpSends.set(ip, ipArr);
  pruneSmsMap(smsPhoneSends, 24 * 3600 * 1000, t);
  pruneSmsMap(smsIpSends, 3600 * 1000, t);
}

// 登录接口单 IP 频控（防撞码）。
function smsLoginGate(ip) {
  const t = now();
  const arr = (smsLoginIp.get(ip) || []).filter((x) => t - x < 3600 * 1000);
  if (arr.length >= SMS_LOGIN_IP_HOURLY_MAX) {
    return { ok: false, retryAfter: Math.ceil((arr[0] + 3600 * 1000 - t) / 1000) };
  }
  return { ok: true, arr };
}

function smsLoginCommit(ip, arr) {
  const t = now();
  arr.push(t);
  smsLoginIp.set(ip, arr);
  pruneSmsMap(smsLoginIp, 3600 * 1000, t);
}

// 验证码校验：常量时间比较、一次有效、校验即焚、失败累计 5 次锁定。
// scene 仅用于发送时选模板，验证只认号码（同一号码的验证码证明的是号码归属）。
function verifySmsCode(phone, code, _scene) {
  const t = now();
  const lock = smsLocks.get(phone) || 0;
  if (lock > t) {
    return { ok: false, status: 429, code: "RATE_LIMITED", error: "验证码校验失败次数过多，请稍后再试" };
  }
  const e = smsCodes.get(phone);
  if (!e || e.expiresAt <= t) {
    smsCodes.delete(phone);
    return { ok: false, status: 400, code: "CODE_EXPIRED", error: "验证码已过期，请重新获取" };
  }
  const s = String(code || "").trim();
  const h = hashSmsCode(e.salt, s);
  const same = /^\d{6}$/.test(s) && h.length === e.hash.length && crypto.timingSafeEqual(h, e.hash);
  if (!same) {
    e.attempts += 1;
    if (e.attempts >= SMS_MAX_ATTEMPTS) {
      smsCodes.delete(phone);
      smsLocks.set(phone, t + SMS_LOCK_MS);
      return { ok: false, status: 429, code: "RATE_LIMITED", error: "验证码校验失败次数过多，请稍后再试" };
    }
    return { ok: false, status: 400, code: "CODE_INVALID", error: "验证码错误" };
  }
  smsCodes.delete(phone); // 校验即焚，不复用
  smsLocks.delete(phone);
  return { ok: true };
}

/* ---------- 微信扫码登录（设备码轮询） ---------- */

// 内存态：单进程、零依赖，重启清零（与频控口径一致）。
const wechatDevices = new Map(); // deviceCode -> { state, createdAt, expiresAt, ticket, bindUserId }
const wechatStates = new Map(); // state -> deviceCode（一次性，防 CSRF）
const wechatTickets = new Map(); // ticket -> { unionid, openid, nickname, userId, bindUserId, createdAt, expiresAt, used }

function wechatConfigured() {
  return !!(WECHAT_APPID && WECHAT_SECRET && WECHAT_REDIRECT);
}

function pruneWechat() {
  const t = now();
  for (const [k, v] of wechatDevices) {
    if (v.expiresAt <= t) {
      if (v.state) wechatStates.delete(v.state);
      wechatDevices.delete(k);
    }
  }
  for (const [k, v] of wechatTickets) {
    if (v.expiresAt <= t) wechatTickets.delete(k);
  }
  for (const [s, dc] of wechatStates) {
    if (!wechatDevices.has(dc)) wechatStates.delete(s);
  }
}

function consumeWechatTicket(ticket) {
  const k = String(ticket || "").trim();
  if (!k) return null;
  const t = wechatTickets.get(k);
  if (!t || t.used || t.expiresAt <= now()) return null;
  t.used = true;
  return t;
}

function peekWechatTicket(ticket) {
  const k = String(ticket || "").trim();
  if (!k) return null;
  const t = wechatTickets.get(k);
  if (!t || t.used || t.expiresAt <= now()) return null;
  return t;
}

// 微信一次性 ticket 校验：供 /api/auth/bind（kind=wechat）消费，一次性、5 分钟过期。
function verifyWechatTicket(ticket) {
  if (!wechatConfigured()) {
    return { ok: false, status: 503, code: "WECHAT_UNAVAILABLE", error: "微信登录未配置" };
  }
  pruneWechat();
  const t = consumeWechatTicket(ticket);
  if (!t) {
    return { ok: false, status: 400, code: "WECHAT_INVALID", error: "微信凭据无效或已过期" };
  }
  return { ok: true, unionid: t.unionid, openid: t.openid, nickname: t.nickname };
}

// 按 unionid 定位账号；不存在则建号并认领身份（unionid 为账号合并唯一键）。
async function ensureWechatUser(unionid, openid, nickname) {
  let u = identityGet("wechat_unionid", unionid);
  if (u) {
    if (openid && u.wechatOpenId !== openid) {
      u = await applyUserPatch(u.id, { wechatOpenId: openid });
    }
    return { user: u, created: false };
  }
  // 默认昵称：微信昵称优先，否则「微信用户」+4 位随机；统一收敛到 1-32 位合法值。
  const nick = normalizeNickname(String(nickname || "").slice(0, 32));
  u = await createUser({
    nickname: nick || "微信用户" + crypto.randomBytes(2).toString("hex"),
    wechatOpenId: openid || "",
    wechatUnionId: unionid,
    wechatBoundAt: now(),
  });
  await identityClaim("wechat_unionid", unionid, u.id);
  return { user: u, created: true };
}

// 把微信身份认领到既有账号（扫码即绑定，免二次验证）。返回落库后的用户；失败为 null。
async function bindWechatToUser(userId, unionid, openid, nickname) {
  const local = db.users.find((x) => x.id === userId) || null;
  if (!local) return null;
  if (local.wechatUnionId && local.wechatUnionId !== unionid) {
    // 该账号已绑另一个微信：先释放旧身份，维持「一账号一微信」索引一致。
    await identityRelease("wechat_unionid", local.wechatUnionId, local.id);
  }
  if (!(await identityClaim("wechat_unionid", unionid, local.id))) return null;
  const patch = { wechatUnionId: unionid, wechatBoundAt: now() };
  if (openid) patch.wechatOpenId = openid;
  const nick = normalizeNickname(String(nickname || "").slice(0, 32));
  if (nick && !local.nickname) patch.nickname = nick;
  return (await applyUserPatch(local.id, patch)) || local;
}

// 冲突时对外暴露的账号信息（不泄漏完整手机号 / 密码哈希）。
function wechatOwnerPublic(owner) {
  return {
    nickname: owner && owner.nickname ? owner.nickname : "",
    maskedPhone: owner && owner.phone ? maskPhone(owner.phone) : "",
    hasPhone: !!(owner && owner.phone),
    hasPassword: !!(owner && owner.pass),
  };
}

// 「可合并的临时账号」判定：微信扫码自动建号产生的一次性账号——
// 无手机号、无密码，且除本次 unionid 外没有真实登录身份。
// username 只是内部占位名（无密码即无用户名登录能力），不视为真实身份；
// 其它 kind 的身份（例如已绑的另一个微信）一律视为真实身份，不可合并。
function isMergeableWechatTempUser(owner, unionid) {
  if (!owner) return false;
  if (owner.phone || owner.pass) return false;
  const placeholder = String(owner.username || "").toLowerCase();
  const uin = String(unionid || "");
  for (const e of db.identities || []) {
    if (e.userId !== owner.id) continue;
    const kind = String(e.kind || "");
    if (kind === "wechat_unionid") {
      if (String(e.value || "") !== uin) return false;
      continue;
    }
    if (kind === "phone") return false;
    if (kind === "username") {
      if (String(e.value || "").toLowerCase() !== placeholder) return false;
      continue;
    }
    return false;
  }
  return true;
}

// 微信归属统一解析：把 unionid 归到当前账号 userId，必要时合并「可合并的临时账号」。
// 返回 {ok:true, merged, mergedFrom?, user} 或 {ok:false, conflict:true, owner:{…}}；
// 正常账号已占用该微信时绝不静默换号（一律 conflict）。
async function resolveWechatOwner({ userId, unionid, openid, nickname }) {
  const targetId = String(userId || "").trim();
  const uin = String(unionid || "").trim();
  if (!targetId || !uin) {
    return { ok: false, conflict: false, code: "WECHAT_INVALID", error: "微信凭据无效" };
  }
  const me = db.users.find((u) => u.id === targetId) || null;
  if (!me) {
    return { ok: false, conflict: false, code: "ACCOUNT_NOT_FOUND", error: "账号不存在" };
  }

  // 落库：把微信身份写进当前账号（unionid + openid + 绑定时间；空昵称时补微信昵称）。
  const stampUser = async () => {
    const patch = { wechatUnionId: uin, wechatBoundAt: now() };
    if (openid) patch.wechatOpenId = String(openid);
    const nick = normalizeNickname(String(nickname || "").slice(0, 32));
    if (nick && !me.nickname) patch.nickname = nick;
    return (await applyUserPatch(me.id, patch)) || me;
  };

  // 该账号此前绑了另一个微信：先释放旧身份，维持「一账号一微信」索引一致。
  if (me.wechatUnionId && me.wechatUnionId !== uin) {
    await identityRelease("wechat_unionid", me.wechatUnionId, me.id);
  }

  const owner = identityGet("wechat_unionid", uin);

  // ① 无人占用：直接认领给当前账号。
  if (!owner) {
    if (!(await identityClaim("wechat_unionid", uin, me.id))) {
      const again = identityGet("wechat_unionid", uin);
      if (again && again.id !== me.id) {
        return { ok: false, conflict: true, owner: wechatOwnerPublic(again) };
      }
      if (!again) return { ok: false, conflict: false, code: "WECHAT_BIND_FAILED", error: "微信绑定失败" };
    }
    const user = await stampUser();
    return { ok: true, merged: false, user };
  }

  // ② 已属于当前账号：直接成功。
  if (owner.id === me.id) {
    const user = await stampUser();
    return { ok: true, merged: false, user };
  }

  // ③ 属于可合并的临时账号：事务式合并（身份转移 → 素材改挂 → 清会话 → 删临时号）。
  if (isMergeableWechatTempUser(owner, uin)) {
    const mergedFrom = { id: owner.id, nickname: owner.nickname || "" };
    await identityRelease("wechat_unionid", uin, owner.id);
    if (!(await identityClaim("wechat_unionid", uin, me.id))) {
      await identityClaim("wechat_unionid", uin, owner.id); // 回滚：身份还给临时账号
      return { ok: false, conflict: true, owner: wechatOwnerPublic(owner) };
    }
    try {
      for (const t of db.templates || []) {
        if (t.userId === owner.id) t.userId = me.id;
      }
      await accountStore.deleteSessionsByUser(owner.id);
      db.sessions = (db.sessions || []).filter((s) => s.userId !== owner.id);
      await accountStore.deleteUser(owner.id);
      db.users = (db.users || []).filter((u) => u.id !== owner.id);
      // 清掉临时账号残留的身份索引（占位 username 等）：删号不会自动清身份，
      // 不清就会永久占着那个占位名（悬挂条目指向已不存在的 userId）。
      await ensureIdentityIndex();
    } catch (e) {
      // 改写失败：回滚身份归属，避免微信落在半合并状态。
      await identityRelease("wechat_unionid", uin, me.id);
      await identityClaim("wechat_unionid", uin, owner.id);
      throw e;
    }
    const user = await stampUser();
    return { ok: true, merged: true, mergedFrom, user };
  }

  // ④ 属于正常账号：冲突，绝不静默换号。
  return { ok: false, conflict: true, owner: wechatOwnerPublic(owner) };
}

/**
 * 微信归属映射（MTNODE_WECHAT_OWNER_MAP=`unionid:username` 或 `unionid:userId`，可多条）。
 *
 * 为什么需要它：未登录直接扫码时，服务端**无法**从微信侧得知这个 unionid 属于哪个老账号
 * （微信不返回手机号），原逻辑只能新建一个「只有微信身份」的临时 uid —— 于是同一个人
 * 有了 ms2308 与临时号两个账号。配了映射就明确归位：命中即把微信绑到旧账号并登录它。
 *
 * 安全边界：
 *   · 只在 unionid **无人占用**、或占用者是「可合并的微信临时账号」时才动手；
 *     已绑在别的正常账号上时一律返回 null，交现有冲突流程（409 WECHAT_OWNED_BY_OTHER）处理，
 *     绝不静默换号。
 *   · 映射目标账号不存在时只告警、按普通流程走（不新建、不猜测）。
 * @returns {Promise<null|{user:object, merged:boolean, mergedFrom:object|null}>}
 */
async function loginWithOwnerMap({ unionid, openid, nickname, current }) {
  const uin = String(unionid || "").trim();
  const want = uin ? WECHAT_OWNER_MAP.get(uin) : "";
  if (!want) return null;
  const target = findUserByName(want) || db.users.find((u) => u.id === want) || null;
  if (!target) {
    console.warn("[store] MTNODE_WECHAT_OWNER_MAP 指向的账号不存在，按普通流程处理：" + want);
    return null;
  }
  if (current && current.id === target.id) return null; // 已经归位，无需动作
  if (current && !isMergeableWechatTempUser(current, uin)) return null; // 别人正常账号的微信：不碰
  const r = await resolveWechatOwner({ userId: target.id, unionid: uin, openid, nickname });
  if (!r.ok) {
    console.warn("[store] 微信归属映射落库失败（" + want + "）：" + (r.error || r.code || "conflict"));
    return null;
  }
  console.log(
    "[store] 微信已按归属映射归到账号 " + target.username + "（" + target.id + "）" +
      (r.merged ? "，并合并了临时账号 " + ((r.mergedFrom && r.mergedFrom.id) || "") : ""),
  );
  return { user: r.user, merged: !!r.merged, mergedFrom: r.mergedFrom || null };
}

async function wechatFetchJson(target, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(target, { signal: ctl.signal });
    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: r.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

// 用授权 code 换 access_token / openid / unionid，并尽力取昵称。
async function wechatExchangeCode(code) {
  const u = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
  u.searchParams.set("appid", WECHAT_APPID);
  u.searchParams.set("secret", WECHAT_SECRET);
  u.searchParams.set("code", code);
  u.searchParams.set("grant_type", "authorization_code");
  const r = await wechatFetchJson(u.toString());
  const d = (r.data && typeof r.data === "object") ? r.data : {};
  if (!d.access_token || !d.openid) {
    return { ok: false, error: d.errmsg || "微信授权失败" };
  }
  let nickname = "";
  try {
    const iu = new URL("https://api.weixin.qq.com/sns/userinfo");
    iu.searchParams.set("access_token", d.access_token);
    iu.searchParams.set("openid", d.openid);
    iu.searchParams.set("lang", "zh_CN");
    const ir = await wechatFetchJson(iu.toString());
    const info = (ir.data && typeof ir.data === "object") ? ir.data : {};
    if (info.nickname) nickname = String(info.nickname).slice(0, 32);
    if (!d.unionid && info.unionid) d.unionid = info.unionid;
  } catch {
    // 昵称/unionid 为可选补充，失败不阻断
  }
  return { ok: true, openid: String(d.openid), unionid: String(d.unionid || ""), nickname };
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// 回调由微信服务器/手机浏览器打开，返回可读 HTML 而非 JSON。
function sendWechatHtml(res, status, message) {
  const body =
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>MTNode 微信登录</title></head>" +
    "<body style=\"margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;" +
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f1115;color:#e6e8ee\">" +
    "<div style=\"text-align:center;padding:24px\">" +
    "<h2 style=\"font-size:18px;font-weight:600;margin:0 0 8px\">" + escapeHtml(message) + "</h2>" +
    "<p style=\"margin:0;color:#8b93a7;font-size:13px\">可关闭本页，返回 MTNode 应用继续操作。</p>" +
    "</div></body></html>";
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// 已登录账号可移除的凭据数量（用于「至少保留一种登录方式」校验）。
function credentialCount(u) {
  return [!!u.pass, !!u.phone, !!u.wechatUnionId].filter(Boolean).length;
}

/* 鉴权唯一入口。
   · bootRelayKey = 这次请求允许用**登录会话**去换中转 Key（只有 /api/relay/me 这个入口，
     客户端登录后/老客户端首次同步时走它领取独立票）；
   · 中转数据面（/relay/v1/*）只认 kind="relay" 的独立票 —— 老客户端拿着登录 token 打过来
     必须被拒，让它走一次重登（否则「中转 Key 独立」就名存实亡）。 */
async function authUser(req, isRelayPath, opts) {
  const boot = !!(opts && opts.bootRelayKey);
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)/i.exec(h);
  if (!m) return null;
  // 中转站测试票（mtr_test_，管理台会话测试用）：只对 /relay/v1/* 认，普通接口一律不认。
  const testUser = relayTestUser(req, isRelayPath);
  if (testUser) return testUser;
  const th = hashToken(m[1]);
  const t = now();
  const sess = db.sessions.find((s) => s.tokenHash === th && s.expiresAt > t);
  if (!sess) return null;
  const isRelayKey = String(sess.kind || "") === RELAY_KEY_KIND;
  if (isRelayPath && !isRelayKey && !boot) return null;
  await touchSession(sess, t);
  const u = db.users.find((x) => x.id === sess.userId) || null;
  /* 这次请求是**哪个会话**打的（只挂 tokenHash，不含明文）：
     /api/relay/me 靠它判「换账号」（同一账号里换了另一个登录会话来领票，见 ensureRelayKey）。 */
  if (u) Object.defineProperty(u, "__sessionHash", { value: th, configurable: true, enumerable: false });
  return u;
}

function send(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    },
    extraHeaders || {},
  );
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * 目录类 JSON 的响应出口（本轮需求：1000 条目录下「上线不故障」）：
 *   · gzip：catalog.json 在 1000 条时约 1.5MB，gzip 后约 1/4；gzip 结果按内容哈希缓存，
 *     同一份目录只压一次（不是每个请求压一次 —— 那是把 CPU 换成带宽的最差换法）；
 *   · ETag：内容哈希做校验和，客户端（apps-store.js 的本机缓存）带 If-None-Match 时回 304；
 *   · Cache-Control: public, max-age=60 + stale-while-revalidate：发布后 1 分钟内可见，
 *     期间重复进入应用中心不再全量传目录。
 * 只给「目录类」用；写接口 / 鉴权回执仍然走 send（不缓存）。
 */
const JSON_GZIP_CACHE = new Map(); // hash -> gzip Buffer（只留最近 8 份）
/* 目录文档的「已编码」附属信息：WeakMap<doc, {body, hash, etag, gz}>。
   doc 在 250ms 记忆窗口内是同一个对象，所以同一份目录只 stringify / sha1 / gzip 一次。 */
const JSON_ENC = new WeakMap();
function encodeJsonDoc(obj) {
  const hit = JSON_ENC.get(obj);
  if (hit) return hit;
  const body = Buffer.from(JSON.stringify(obj));
  const hash = crypto.createHash("sha1").update(body).digest("hex");
  const rec = { body: body, hash: hash, etag: '"' + hash.slice(0, 32) + '"', gz: null };
  JSON_ENC.set(obj, rec);
  return rec;
}
const JSON_CACHE_MAX = 8;
function sendCatalogJson(req, res, obj, opts) {
  const o = opts || {};
  const enc = encodeJsonDoc(obj);
  const body = enc.body;
  const hash = enc.hash;
  const etag = enc.etag;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    ETag: etag,
    "Cache-Control": o.cache || "public, max-age=60, stale-while-revalidate=300",
    Vary: "Accept-Encoding",
  };
  const inm = String((req && req.headers && req.headers["if-none-match"]) || "");
  if (inm && inm.split(",").some((t) => t.trim() === etag)) {
    res.writeHead(304, Object.assign({}, headers, { "Content-Length": 0 }));
    res.end();
    return;
  }
  const acceptsGzip = /gzip/i.test(String((req && req.headers && req.headers["accept-encoding"]) || ""));
  let out = body;
  if (acceptsGzip && body.length >= 1024) {
    let gz = enc.gz || JSON_GZIP_CACHE.get(hash);
    if (!gz) {
      try {
        gz = zlib.gzipSync(body, { level: o.level || 6 });
      } catch (_) {
        gz = null;
      }
      if (gz) {
        enc.gz = gz; // 挂在这份文档上：同一份目录后续请求不再压
        JSON_GZIP_CACHE.set(hash, gz);
        while (JSON_GZIP_CACHE.size > JSON_CACHE_MAX) JSON_GZIP_CACHE.delete(JSON_GZIP_CACHE.keys().next().value);
      }
    }
    if (gz) {
      out = gz;
      headers["Content-Encoding"] = "gzip";
    }
  }
  headers["Content-Length"] = out.length;
  res.writeHead(200, headers);
  res.end(out);
}

/**
 * 目录体积体检（只读）：给 GET /api/apps/pub、上线自检与本次「1000 条验证」用。
 * 报的是**盘上真实字节**（catalog.json / catalog.json.gz），不现场压缩。
 */
function gzipStatus() {
  const out = { dir: APPS_WEB_DIR, files: {} };
  for (const name of ["catalog.json", "catalog.json.gz"]) {
    const f = path.join(APPS_WEB_DIR, name);
    try {
      const st = fs.statSync(f);
      out.files[name] = { bytes: st.size, mtime: st.mtime.toISOString() };
    } catch (_) {
      out.files[name] = null;
    }
  }
  const raw = out.files["catalog.json"] ? out.files["catalog.json"].bytes : 0;
  const gz = out.files["catalog.json.gz"] ? out.files["catalog.json.gz"].bytes : 0;
  out.catalogBytes = raw;
  out.catalogGzBytes = gz;
  out.ratio = raw && gz ? +(gz / raw).toFixed(3) : null;
  out.staticGzipReady = !!(raw && gz);
  out.apiGzip = true; // /api/apps/catalog 走 sendCatalogJson（按 Accept-Encoding 现场压，结果有缓存）
  return out;
}

function sendBin(res, status, buf, contentType, extraHeaders) {
  res.writeHead(status, Object.assign({
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
  }, extraHeaders || {}));
  res.end(buf);
}

/* ── 慢请求体检（只读诊断，默认阈 400ms；MTNODE_SLOW_MS=0 关掉） ──
   1000 条目录下排查「哪条路由慢」用它：超过阈值的请求打一行日志（方法 + 路径 + 服务端毫秒）。
   记的是**服务端处理耗时**，不含网络 —— 与压测报告里的客户端耗时对照就能分清是服务慢还是链路慢。
   ───────────────────────────────────────────────────────────────────── */
const SLOW_MS = Number(process.env.MTNODE_SLOW_MS == null ? 400 : process.env.MTNODE_SLOW_MS);
const _slowTop = new Map(); // "METHOD path" -> {n, max, last}
function slowNote(method, p2, ms) {
  if (!SLOW_MS || ms < SLOW_MS) return;
  const key = method + " " + String(p2 || "");
  const cur = _slowTop.get(key) || { n: 0, max: 0, last: 0 };
  cur.n++;
  cur.max = Math.max(cur.max, ms);
  cur.last = Math.round(ms);
  _slowTop.set(key, cur);
  if (cur.n <= 20 || cur.n % 50 === 0) {
    console.warn("[slow] " + key + " " + Math.round(ms) + "ms（第 " + cur.n + " 次，最大 " + Math.round(cur.max) + "ms）");
  }
}
function slowReport() {
  return Array.from(_slowTop.entries())
    .map(([k, v]) => ({ route: k, count: v.n, maxMs: Math.round(v.max), lastMs: v.last }))
    .sort((a, b) => b.maxMs - a.maxMs);
}

/* 上架链路的写接口（POST /api/apps、POST/PATCH /api/apps/:id[/versions]）走放宽档：
   它们要一次收下「最多 8 张 5MB 截图 + 图标 + 24MB 包」，base64 后能到 77MB 量级。
   判据集中在 appUploadRoute()，**别在别处再写一遍路径前缀**。 */
function appUploadRoute(p, method) {
  if (method !== "POST" && method !== "PATCH") return false;
  return /^\/api\/apps(\/[^/]+(\/versions)?)?$/.test(String(p || ""));
}

/* 读请求体（带上限）。**超限必须回一条明确错误，绝不静默断连**：
 * 原来超限就 `reject + req.destroy()` —— 连接被掐，客户端拿不到任何状态码，只能等自己的
 * 超时，用户看到的就是「上传中卡住很久然后失败」（本轮用户报的那条 bug）。
 * 现在的口径：
 *   · 不再累积超过上限的字节（内存有界）；
 *   · 等客户端把这批 unpipe 完（`req.resume()`）再回 **413 + JSON 报文**，
 *     报文里写清「上限多少 / 收到多少 / 怎么办」——作者据此减素材或换小一点的包。
 * 为什么不立刻回 413：请求体还在路上，此刻写响应再 destroy 会变成连接重置，
 * 客户端照样只看得到「网络错误」；把报文发全比省那几秒重要。 */
function readBody(req, maxBytes) {
  const cap = Math.max(1024, Number(maxBytes) || MAX_BODY);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let overflow = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > cap) {
        if (!overflow) {
          overflow = n;
          req.resume(); /* 丢弃但不掐连接：等它传完，好把 413 发出去 */
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overflow) {
        const err = new Error(
          "请求体超过上限 " + Math.round(cap / 1024 / 1024) + "MB（已收到 " + Math.round(overflow / 1024 / 1024) + "MB）：" +
            "请减小应用包或截图数量后再传",
        );
        err.status = 413;
        err.code = "BODY_TOO_LARGE";
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function decodeMtNodes(b64) {
  const s = String(b64 || "").trim().replace(/\s+/g, "");
  if (!s) throw new Error("empty");
  const buf = Buffer.from(s, "base64");
  if (buf.length < 8) throw new Error("too small");
  if (!buf.slice(0, 7).equals(MAGIC)) throw new Error("not mtnodes");
  if (buf[7] !== 1) throw new Error("unsupported version");
  return buf;
}

function decodeUtf8Base64(b64) {
  const s = String(b64 || "").trim().replace(/\s+/g, "");
  if (!s) throw new Error("empty");
  const buf = Buffer.from(s, "base64");
  if (!buf.length) throw new Error("empty");
  return buf;
}

function parseSkillMarkdown(buf) {
  const text = buf.toString("utf8");
  if (!text.trim()) throw new Error("empty skill");
  const meta = { name: "", title: "", description: "", version: "" };
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const body = fm ? fm[2] || "" : text;
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const km = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!km) continue;
      const k = km[1];
      const v = String(km[2] || "").replace(/^['"]|['"]$/g, "").trim();
      if (k === "name") meta.name = v;
      if (k === "title") meta.title = v;
      if (k === "description") meta.description = v;
      if (k === "version") meta.version = v;
    }
  }
  if (!meta.title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) meta.title = String(h1[1] || "").trim();
  }
  let skillName = String(meta.name || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillName)) {
    throw new Error("frontmatter name 需为 kebab-case（小写字母/数字/短横线）");
  }
  return {
    text,
    skillName,
    title: String(meta.title || skillName).trim().slice(0, 80),
    description: String(meta.description || "").trim().slice(0, 2000),
    version: String(meta.version || "").trim(),
  };
}

function normalizeVersion(v, fallback) {
  let s = String(v || "").trim();
  if (!s) s = String(fallback || "1.0.0");
  if (s.length > 32) s = s.slice(0, 32);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(s)) {
    throw new Error("版本号格式无效");
  }
  return s;
}

function skillLegacyMdPath(id) {
  return path.join(SKILL_DIR, id + ".md");
}

function skillBundleDir(id) {
  return path.join(SKILL_DIR, id);
}

function skillMdPath(id) {
  const dirMd = path.join(skillBundleDir(id), "SKILL.md");
  if (fs.existsSync(dirMd)) return dirMd;
  const legacy = skillLegacyMdPath(id);
  if (fs.existsSync(legacy)) return legacy;
  return dirMd;
}

function normalizeSkillRelPath(raw) {
  let p = String(raw || "").trim().replace(/\\/g, "/");
  if (!p) throw new Error("空文件路径");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new Error("禁止绝对路径：" + p);
  p = p.replace(/^\.\//, "");
  const parts = p.split("/").filter(Boolean);
  if (!parts.length || parts.length > 4) throw new Error("路径过深或不合法：" + p);
  for (const part of parts) {
    if (part === "." || part === "..") throw new Error("非法路径：" + p);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part)) {
      throw new Error("文件名不合法：" + p);
    }
  }
  const out = parts.join("/");
  if (out.toLowerCase() === "skill.md") {
    throw new Error("附加文件不要使用 SKILL.md（正文请用 fileBase64）");
  }
  return out;
}

function decodeSkillExtraFiles(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) throw new Error("files 须为数组");
  if (input.length > MAX_SKILL_EXTRA_FILES) {
    throw new Error("附加文件不能超过 " + MAX_SKILL_EXTRA_FILES + " 个");
  }
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const rel = normalizeSkillRelPath(item && (item.path || item.name));
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new Error("重复文件：" + rel);
    seen.add(key);
    let buf;
    try {
      buf = decodeUtf8Base64(item.base64 != null ? item.base64 : item.fileBase64);
    } catch (e) {
      // allow binary extras (schemas may be utf8; images rare) — fall back raw base64
      try {
        const s = String((item && item.base64) || "").trim().replace(/\s+/g, "");
        buf = Buffer.from(s, "base64");
        if (!buf.length) throw new Error("empty");
      } catch (e2) {
        throw new Error("文件 " + rel + " 无效：" + (e.message || e));
      }
    }
    if (buf.length > MAX_SKILL_FILE) {
      throw new Error("文件 " + rel + " 超过 200KB");
    }
    out.push({ path: rel, buf });
  }
  return out;
}

function ensureSkillBundle(id) {
  const dir = skillBundleDir(id);
  mkdirp(dir);
  const legacy = skillLegacyMdPath(id);
  const dest = path.join(dir, "SKILL.md");
  if (fs.existsSync(legacy) && !fs.existsSync(dest)) {
    fs.renameSync(legacy, dest);
  }
  return dir;
}

function writeSkillBundle(id, mdBuf, extras) {
  const dir = ensureSkillBundle(id);
  fs.writeFileSync(path.join(dir, "SKILL.md"), mdBuf);
  // replace extras: remove previous non-md files when extras provided
  if (extras) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "SKILL.md") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      } else {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
    for (const f of extras) {
      const dest = path.join(dir, f.path);
      mkdirp(path.dirname(dest));
      fs.writeFileSync(dest, f.buf);
    }
  }
  return listSkillBundleFiles(id);
}

function listSkillBundleFiles(id) {
  const dir = skillBundleDir(id);
  const legacy = skillLegacyMdPath(id);
  const files = [];
  let total = 0;
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const walk = (base, prefix) => {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        const rel = prefix ? prefix + "/" + ent.name : ent.name;
        const full = path.join(base, ent.name);
        if (ent.isDirectory()) walk(full, rel);
        else {
          const st = fs.statSync(full);
          files.push({ path: rel.replace(/\\/g, "/"), bytes: st.size });
          total += st.size;
        }
      }
    };
    walk(dir, "");
  } else if (fs.existsSync(legacy)) {
    const st = fs.statSync(legacy);
    files.push({ path: "SKILL.md", bytes: st.size });
    total = st.size;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, bytes: total };
}

function readSkillBundle(id) {
  const mdPath = skillMdPath(id);
  if (!fs.existsSync(mdPath)) return null;
  const mdBuf = fs.readFileSync(mdPath);
  const extras = [];
  const dir = skillBundleDir(id);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const walk = (base, prefix) => {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        const rel = prefix ? prefix + "/" + ent.name : ent.name;
        const full = path.join(base, ent.name);
        if (ent.isDirectory()) walk(full, rel);
        else if (rel.replace(/\\/g, "/") !== "SKILL.md") {
          const buf = fs.readFileSync(full);
          extras.push({
            path: rel.replace(/\\/g, "/"),
            bytes: buf.length,
            base64: buf.toString("base64"),
          });
        }
      }
    };
    walk(dir, "");
  }
  extras.sort((a, b) => a.path.localeCompare(b.path));
  return { mdBuf, extras };
}

function clearSkillFile(id) {
  try {
    fs.unlinkSync(skillLegacyMdPath(id));
  } catch {}
  try {
    fs.rmSync(skillBundleDir(id), { recursive: true, force: true });
  } catch {}
}

function decodePreview(b64) {
  if (b64 == null || b64 === "") return null;
  let s = String(b64).trim();
  const m = /^data:image\/(png|jpe?g|webp);base64,/i.exec(s);
  if (m) s = s.slice(m[0].length);
  const buf = Buffer.from(s.replace(/\s+/g, ""), "base64");
  if (!buf.length) return null;
  if (buf.length > MAX_PREVIEW) throw new Error("preview too large");
  const png = buf[0] === 0x89 && buf[1] === 0x50;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const webp = buf[0] === 0x52 && buf[8] === 0x57;
  if (!png && !jpg && !webp) throw new Error("preview must be png/jpeg/webp");
  return { buf, ext: png ? "png" : webp ? "webp" : "jpg" };
}

/** 上架截图（大图）那一档的解码：与 decodePreview 同一套识别口径，只是**不吃 500KB 的图标上限**
 *  —— 单张上限是 MAX_APP_SHOT_BYTES（5MB）。图标仍走 decodePreview（MAX_PREVIEW 仍是 500KB）。 */
function decodePreviewAny(b64) {
  if (b64 == null || b64 === "") return null;
  let s = String(b64).trim();
  const m = /^data:image\/(png|jpe?g|webp);base64,/i.exec(s);
  if (m) s = s.slice(m[0].length);
  const buf = Buffer.from(s.replace(/\s+/g, ""), "base64");
  if (!buf.length) return null;
  if (buf.length > MAX_APP_SHOT_BYTES) throw new Error("shot too large");
  const png = buf[0] === 0x89 && buf[1] === 0x50;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const webp = buf[0] === 0x52 && buf[8] === 0x57;
  if (!png && !jpg && !webp) throw new Error("preview must be png/jpeg/webp");
  return { buf, ext: png ? "png" : webp ? "webp" : "jpg" };
}

function writePreview(id, prev, thumb) {
  const dest = path.join(PREV_DIR, id + "." + prev.ext);
  for (const ext of ["png", "jpg", "webp"]) {
    const p = path.join(PREV_DIR, id + "." + ext);
    if (p !== dest) try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(path.join(PREV_DIR, id + ".thumb." + ext)); } catch {}
  }
  fs.writeFileSync(dest, prev.buf);
  if (thumb && thumb.buf) {
    fs.writeFileSync(path.join(PREV_DIR, id + ".thumb." + thumb.ext), thumb.buf);
  }
}

function previewPath(id, size) {
  const wantThumb = size === "thumb" || size === "sm" || size === "small";
  if (wantThumb) {
    for (const ext of ["jpg", "png", "webp"]) {
      const p = path.join(PREV_DIR, id + ".thumb." + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  for (const ext of ["jpg", "png", "webp"]) {
    const p = path.join(PREV_DIR, id + "." + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function clearPreviews(id) {
  for (const ext of ["png", "jpg", "webp"]) {
    try { fs.unlinkSync(path.join(PREV_DIR, id + "." + ext)); } catch {}
    try { fs.unlinkSync(path.join(PREV_DIR, id + ".thumb." + ext)); } catch {}
  }
}

function previewMime(p) {
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function requireFields(obj, keys) {
  for (const k of keys) {
    if (obj[k] == null || String(obj[k]).trim() === "") {
      const err = new Error("missing " + k);
      err.status = 400;
      throw err;
    }
  }
}

// 只读图片头拿宽高（png / jpeg / webp），拿不到就返回 null（放行，交给 3MB 体积上限兜底）。
function imageEdge(buf, kind) {
  try {
    if (kind === "png") return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (kind === "webp") {
      const fourcc = buf.toString("ascii", 12, 16);
      if (fourcc === "VP8X") return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
      if (fourcc === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
      }
      if (fourcc === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
      return null;
    }
    if (kind === "jpg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        }
        i += 2 + len;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

// 论坛图片校验：png/jpeg/webp、≤3MB、最大边 ≤1080（沿用原前台压缩口径）。
function decodeForumImage(b64) {
  if (b64 == null || b64 === "") return null;
  let s = String(b64).trim();
  const m = /^data:image\/(png|jpe?g|webp);base64,/i.exec(s);
  if (m) s = s.slice(m[0].length);
  const buf = Buffer.from(s.replace(/\s+/g, ""), "base64");
  if (!buf.length) return null;
  if (buf.length > MAX_FORUM_IMAGE) throw new Error("image too large");
  const png = buf[0] === 0x89 && buf[1] === 0x50;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const webp = buf[0] === 0x52 && buf[8] === 0x57;
  if (!png && !jpg && !webp) throw new Error("image must be png/jpeg/webp");
  const edge = imageEdge(buf, png ? "png" : webp ? "webp" : "jpg");
  if (edge && Math.max(edge[0], edge[1]) > MAX_FORUM_IMAGE_EDGE) {
    throw new Error("image edge too large");
  }
  return { buf, ext: png ? "png" : webp ? "webp" : "jpg" };
}

// 把请求里的 imageBase64[] 落盘，返回图片 id 数组（单话题/单回复最多 6 张）。
function collectForumImages(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (list.length > MAX_FORUM_IMAGES) throw new Error("图片最多 " + MAX_FORUM_IMAGES + " 张");
  const ids = [];
  for (const one of list) {
    const img = decodeForumImage(one);
    if (img) ids.push(writeForumImage(uid("img_"), img));
  }
  return ids;
}

function forumImagePath(id) {
  const sid = String(id || "").replace(/[^\w.-]/g, "");
  if (!sid) return null;
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const p = path.join(FORUM_IMG_DIR, sid + "." + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function writeForumImage(id, img) {
  const dest = path.join(FORUM_IMG_DIR, id + "." + img.ext);
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const p = path.join(FORUM_IMG_DIR, id + "." + ext);
    if (p !== dest) try { fs.unlinkSync(p); } catch {}
  }
  fs.writeFileSync(dest, img.buf);
  return id;
}

function forumAuthor(userId) {
  const u = db.users.find((x) => x.id === userId);
  return {
    id: userId,
    username: (u && u.username) || "",
    nickname: (u && u.nickname) || "",
  };
}

// 列表投影：只有标题与元数据，绝不带正文（懒加载关键）。
function publicForumTopicSummary(t, en) {
  return withEnrich({
    id: t.id,
    title: t.title || "",
    status: t.status,
    imageIds: Array.isArray(t.imageIds) ? t.imageIds : [],
    replyCount: t.replyCount || 0,
    userId: t.userId,
    author: forumAuthor(t.userId),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastReplyAt: t.lastReplyAt || t.createdAt,
  }, "forum_topic", t.id, en);
}

function publicForumTopic(t, viewer, en) {
  return Object.assign(publicForumTopicSummary(t, en), {
    content: t.content || "",
    mine: !!(viewer && viewer.id === t.userId),
  });
}

function publicForumReply(r, en) {
  return withEnrich({
    id: r.id,
    topicId: r.topicId,
    content: r.content || "",
    imageIds: Array.isArray(r.imageIds) ? r.imageIds : [],
    userId: r.userId,
    author: forumAuthor(r.userId),
    createdAt: r.createdAt,
  }, "forum_reply", r.id, en);
}

function forumPageArgs(url, pageKey, sizeKey) {
  const pageSizeRaw = Number(url.searchParams.get(sizeKey) || 20) || 20;
  const pageRaw = Number(url.searchParams.get(pageKey) || 1) || 1;
  const pageSize = Math.min(FORUM_PAGE_SIZE_MAX, Math.max(1, Math.floor(pageSizeRaw)));
  const page = Math.max(1, Math.floor(pageRaw));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

// 发帖 / 回复分开计数（同一账号，各自窗口内独立上限）。
const forumRateBuckets = { topic: new Map(), reply: new Map(), image: new Map() };
function forumRateOk(kind, userId) {
  const bucket = forumRateBuckets[kind] || forumRateBuckets.reply;
  const max =
    kind === "topic" ? FORUM_RATE_TOPIC_MAX : kind === "image" ? FORUM_RATE_IMAGE_MAX : FORUM_RATE_REPLY_MAX;
  const t = now();
  const arr = (bucket.get(userId) || []).filter((x) => t - x < FORUM_RATE_WIN_MS);
  if (arr.length >= max) {
    bucket.set(userId, arr);
    return false;
  }
  arr.push(t);
  bucket.set(userId, arr);
  return true;
}

function imageMimeFromPath(p) {
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

/* ========================================================================== *
 * 充值 / 管理平台助手
 * ========================================================================== */

/** 纯文本响应（支付宝异步通知只认 `success` / `failure` 文本）。 */
function sendText(res, status, text) {
  const body = String(text == null ? "" : text);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** 支付宝时间（东八区 `yyyy-MM-dd HH:mm:ss`）→ 毫秒时间戳；解析失败返回 0。 */
function parseAlipayTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(text || "").trim());
  if (!m) return 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
  return Number.isFinite(t) ? t : 0;
}

/** 管理页静态资源的 MIME（本机联调用；线上由 nginx 直发 /var/www/mtnode/admin/）。 */
function adminWebMime(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

/** 关单（尽力而为）：支付宝侧关掉未付款交易，避免用户在过期订单上付款。失败只记日志。 */
async function closeOrderBestEffort(order) {
  if (!alipayStatus().configured) return;
  try {
    const r = await alipayClose(order.id);
    if (r.ok || r.notExist) wallet.markClosed(order.id, r.tradeNo || "");
    else console.warn("[recharge] 关单未成功 " + order.id + "：" + (r.subCode || r.code || "") + " " + (r.error || ""));
  } catch (e) {
    console.warn("[recharge] 关单异常 " + order.id + "：" + ((e && e.message) || e));
  }
}

/**
 * 主动向支付宝核对一笔订单（轮询兜底 / 手动补单共用）：
 * TRADE_SUCCESS|TRADE_FINISHED → 入账（幂等）；TRADE_CLOSED → 标关闭；其余 → 仍未支付。
 */
async function syncOrderFromAlipay(order, source) {
  if (!order) return { ok: false, code: "ORDER_NOT_FOUND", error: "订单不存在" };
  const st = alipayStatus();
  if (!st.configured) {
    return { ok: false, code: "ALIPAY_UNAVAILABLE", error: "支付宝支付通道未配置（缺少 " + st.missing.join(" / ") + "）" };
  }
  if (order.status !== "pending" && order.status !== "expired" && order.status !== "closed") {
    return { ok: true, unchanged: true, order };
  }
  const q = await alipayQuery(order.id);
  if (!q.ok) {
    // 交易还不存在 + 本地已过期 → 顺手关单，保持两边一致
    if (q.notExist && order.status === "pending" && order.expiresAt <= now()) {
      wallet.expireDue();
      await closeOrderBestEffort(order);
      await saveDb();
    }
    return { ok: false, code: q.code, error: q.error, subCode: q.subCode };
  }
  const status = q.tradeStatus;
  if (status === "TRADE_SUCCESS" || status === "TRADE_FINISHED") {
    const r = await wallet.creditPaid({
      order,
      tradeNo: q.tradeNo,
      amountCents: q.amountCents,
      buyerId: q.buyerId,
      paidAt: parseAlipayTime(q.paidAt) || now(),
      source: String(source || "query"),
    });
    return r.ok ? { ok: true, paid: true, order: r.order, code: r.code || "" } : r;
  }
  if (status === "TRADE_CLOSED") {
    wallet.expireDue();
    wallet.markClosed(order.id, q.tradeNo);
    await saveDb();
    return { ok: true, closed: true, order };
  }
  return { ok: true, pending: true, tradeStatus: status, order };
}

/** 管理平台鉴权闸：无票 / 失效 → 401（重新扫码）；票还有效但名单已改 → 403（无权）。 */
function requireAdmin(req, res) {
  const m = /^Bearer\s+(adm_\S+)$/i.exec(String(req.headers.authorization || ""));
  if (!m) {
    send(res, 401, { ok: false, code: "ADMIN_UNAUTHORIZED", error: "管理平台未登录" });
    return null;
  }
  const a = authAdmin(req);
  if (!a) {
    /* authAdmin 对「票不存在 / 已过期」和「票在但资格被撤」都回 null，这里分开：
       前者是认证失败（401，客户端据此清票回登录页），后者是授权失败（403，票本身没坏）。
       混成一个 403 会让「会话过期」在语义上变成「你没权限」，也不符合 HTTP 口径。 */
    const th = hashToken(m[1]);
    const alive = adminSessions().some((s) => s.tokenHash === th && Number(s.expiresAt) > now());
    if (alive) {
      send(res, 403, { ok: false, code: "ADMIN_FORBIDDEN", error: "该账号已不在管理平台名单内" });
    } else {
      send(res, 401, { ok: false, code: "ADMIN_UNAUTHORIZED", error: "管理会话无效或已过期，请重新扫码登录" });
    }
    return null;
  }
  return a;
}

/* ========================================================================== *
 * 应用市场（用户 / 云端分发的本机小应用）
 *   · 存储沿用既有口径：记录进 db.json 的 apps[]，zip 落 DATA_DIR/apps/<id>.zip，
 *     图标落 DATA_DIR/app-icons/<id>.<ext>（与 templates / skills 同源）。
 *   · 静态目录 http://mt-agent.com/mtnode/apps/catalog.json 与 /api/apps* 共用同一份
 *     条目字段（appCatalogEntry）：手写清单（store-saas/apps/catalog.json）与接口不会漂移。
 *   · 详见 docs/apps-market.md。
 * ========================================================================== */

/** 应用 id（= 客户端安装目录名）合法化：统一小写，非法返回 ""。 */
function normalizeAppId(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!APP_ID_RE.test(s)) return "";
  if (s.endsWith(".") || WIN_RESERVED.has(s)) return "";
  return s;
}

/**
 * 只读 zip 中央目录拿条目名（不引第三方依赖）。
 * 坏包 / 路径越界一律抛错 —— 上传阶段就拦住，别让客户端在解包时才炸。
 */
function zipEntryNames(buf) {
  const floor = Math.max(0, buf.length - 66000);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip（找不到中央目录）");
  const count = buf.readUInt16LE(eocd + 10);
  const offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  let o = offset;
  for (let i = 0; i < count; i++) {
    if (o + 46 > buf.length || buf.readUInt32LE(o) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const nameLen = buf.readUInt16LE(o + 28);
    const extraLen = buf.readUInt16LE(o + 30);
    const cmtLen = buf.readUInt16LE(o + 32);
    const raw = buf.toString("utf8", o + 46, o + 46 + nameLen);
    o += 46 + nameLen + extraLen + cmtLen;
    const norm = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!norm || norm.endsWith("/")) continue;
    if (norm.includes("..") || norm.includes(":")) throw new Error("zip 内含非法路径：" + norm);
    names.push(norm);
  }
  if (!names.length) throw new Error("zip 里没有文件");
  return names;
}

function decodeAppZip(b64) {
  const buf = decodeUtf8Base64(b64);
  if (buf.length > MAX_APP_ZIP) throw new Error("应用包不能超过 " + Math.floor(MAX_APP_ZIP / 1024 / 1024) + "MB");
  const pk = buf[0] === 0x50 && buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
  if (!pk) throw new Error("不是 zip（缺少 PK 头）");
  return buf;
}

/** 包内入口页：优先清单声明的 entry，其次顶层 index.html，再其次唯一的顶层 html。 */
function detectAppEntry(rawEntry, names) {
  const declared = String(rawEntry == null ? "" : rawEntry).replace(/\\/g, "/").replace(/^\/+/, "");
  if (declared) {
    if (declared.includes("..") || declared.includes(":") || !/\.html?$/i.test(declared)) return "";
    if (!names.includes(declared)) throw new Error("包内找不到清单声明的入口页：" + declared);
    return declared;
  }
  if (names.includes("index.html")) return "index.html";
  const top = names.filter((n) => /\.html?$/i.test(n) && !n.includes("/"));
  return top.length === 1 ? top[0] : "";
}

/* ── 目录索引（本轮 1000 条场景的 CPU 主因）────────────────────────────────────
 * appIconPath / appThumbOf / appBranchZipRelOf 都是「按文件名问在不在」，**每个目录条目**都要问
 * 4~12 次；1000+ 条目录时就是上万次 existsSync（每次一个 syscall），实测组一次目录要 3 秒。
 * 这里把目录内容按**短 TTL 缓存**成文件名集合：一次 readdir 顶一万次 existsSync。
 * 写路径（写图标 / 缩略图 / 包）会调 dirIndexDrop() 主动作废，所以不会读到过期的「不在」。
 * 100ms 的 TTL 只兜底「别的进程 / 手工放进来的文件」，正常读写路径都是即时的。
 * ───────────────────────────────────────────────────────────────────────── */
const DIR_INDEX_TTL_MS = 100;
const _dirIndex = new Map(); // dir -> { at, files:Set, mtimes:Map }
function dirIndex(dir) {
  const key = String(dir);
  const hit = _dirIndex.get(key);
  const t = now();
  if (hit && t - hit.at < DIR_INDEX_TTL_MS) return hit;
  let files = new Set();
  let mtimes = new Map();
  try {
    const names = fs.readdirSync(key);
    files = new Set(names);
    for (const name of names) {
      try {
        mtimes.set(name, fs.statSync(path.join(key, name)).mtimeMs);
      } catch (_) {}
    }
  } catch (_) {}
  const rec = { at: t, files: files, mtimes: mtimes };
  _dirIndex.set(key, rec);
  return rec;
}
function dirHasFile(dir, name) {
  return dirIndex(dir).files.has(String(name));
}
function dirFileMtime(dir, name) {
  const v = dirIndex(dir).mtimes.get(String(name));
  return Number.isFinite(v) ? v : 0;
}
/** 目录内容变过（写了新文件 / 删了文件）时主动作废 —— 写路径调用。 */
function dirIndexDrop(dir) {
  if (dir) _dirIndex.delete(String(dir));
  else _dirIndex.clear();
}

function appIconPath(id, ownerId) {
  const names = [];
  const own = String(ownerId || "");
  if (own) names.push(id + "__" + own);
  names.push(id);
  for (const base of names) {
    for (const ext of ["png", "jpg", "webp"]) {
      const name = base + "." + ext;
      if (dirHasFile(APP_ICON_DIR, name)) return path.join(APP_ICON_DIR, name);
    }
  }
  return null;
}

/** 图标在静态目录里的相对地址（icons/<id>__<作者uid>.<ext>；老文件 icons/<id>.<ext> 仍在）：
 *  客户端把它解析到 /mtnode/apps/ 下，与 zipUrl 同一套「相对目录」口径。 */
function appIconRel(id, ownerId) {
  const p = appIconPath(id, ownerId);
  if (!p) return "";
  return "icons/" + path.basename(p);
}

function writeAppIcon(id, ownerId, icon) {
  dirIndexDrop(APP_ICON_DIR);
  clearAppIcon(id, ownerId);
  clearAppThumb(id, ownerId); /* 图标换了：缓存的封面缩略图必须一起作废（否则卡片一直是老图） */
  fs.writeFileSync(path.join(APP_ICON_DIR, appFileStem(id, ownerId) + "." + icon.ext), icon.buf);
}

/* ---------- 应用封面缩略图（卡片背景图）：懒生成 + 落盘缓存 ----------
 * 客户端卡片是 16:9 背景图，直接铺 1280 或 1805×1230 / 400KB 的原图会把一页卡片拖成几 MB。
 * 所以这里在**第一次请求时**把封面源图下采样成固定 640×360 的缩略图，落到 APP_THUMB_DIR 缓存；
 * 存量与将来新上传的都不用迁移脚本。
 *
 * 封面源图 = **上架截图第 1 张**（本轮需求：商店里的封面就该是作者上传的那张截图），
 * 没有截图才退回图标（老应用 / 只传了图标）。为什么不是「图标」：图标只是小方块徽标，
 * 作者换成截图之前，卡片一直顶着它 —— 用户报的正是这个「截图传了却不当封面」。
 * 源图换了必须让缓存换一个**文件名**（截图那条带 __shot 后缀、图标那条不带）：否则新旧缩略图同名，
 * 客户端与 nginx 会一直拿旧图（图标文件当初就是靠改名 + mtime 令牌绕开这件事的）。
 *
 * 图片解码 / 缩放 / 编码全在 store-saas/thumb.mjs（零依赖纯 JS，见那里的说明）。
 * 任何一步失败都**回原图**（200），绝不 5xx —— 一张解不开的图不该让卡片墙塌掉。 */
/** 这条分支有没有封面源是截图：有就把封面交给它（shots 目录里第 1 张）。 */
function appCoverShotOf(id, ownerId) {
  const files = appShotFiles(id, ownerId);
  return files.length ? files[0] : "";
}
/** 这条分支的封面源（截图第 1 张 → 图标 → 没有）：{ file, kind, stem }。 */
function appCoverSourceOf(id, ownerId) {
  const shot = appCoverShotOf(id, ownerId);
  if (shot) return { file: shot, kind: "shot", stem: appFileStem(id, ownerId) + "__shot" };
  const icon = appIconPath(id, ownerId) || appIconPath(id);
  if (icon) return { file: icon, kind: "icon", stem: appFileStem(id, ownerId) };
  return null;
}
/** 封面缩略图文件名（按源不同后缀）：icons/<主干>__shot.png / icons/<主干>.png。 */
function appThumbFile(id, ownerId, src) {
  const s = src || appCoverSourceOf(id, ownerId);
  if (!s) return "";
  return path.join(APP_THUMB_DIR, s.stem + ".png");
}
/** 图标 / 截图变了、应用删了：把这一分支的封面缩略图缓存清掉（别的分支的绝不动）。 */
function clearAppThumb(id, ownerId) {
  dirIndexDrop();
  const own = String(ownerId || "").trim();
  if (!own) {
    /* 没给作者（老调用）：与 clearAppIcon 同口径，清这个 id 的所有缩略图 */
    let names = [];
    try {
      names = fs.readdirSync(APP_THUMB_DIR);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === id + ".png" || n.startsWith(id + "__")) {
        try { fs.unlinkSync(path.join(APP_THUMB_DIR, n)); } catch {}
      }
    }
    return;
  }
  /* 两种源自的缩略图都清（换图那次可能把封面从图标换成截图，反之亦然） */
  try { fs.unlinkSync(path.join(APP_THUMB_DIR, appFileStem(id, own) + ".png")); } catch {}
  try { fs.unlinkSync(path.join(APP_THUMB_DIR, appFileStem(id, own) + "__shot.png")); } catch {}
}
/** 拿这个分支的封面缩略图（没有就现生成）；做不了回 null，调用方回原图。
 *  「拿得到」的判据是**这份文件真的在盘上**（fs.existsSync），不能只看目录索引里的 mtime ——
 *  索引是进程内的缓存，缓存被运维清掉 / 换个进程 / 被删之后索引还记着旧条目，
 *  于是这里会把一个不存在的路径当命中返回，调用方的 readFileSync 当场 ENOENT → 接口 500
 *  （客户端封面链路看到的是「封面一直拉不到」，2026-10 thumb-route-smoke ⑥⑦ 抓到的就是这个）。 */
function appThumbOf(a, src) {
  const s = src || appCoverSourceOf(a.id, a.userId);
  if (!s) return null;
  const destName = s.stem + ".png";
  const dest = path.join(APP_THUMB_DIR, destName);
  try {
    const srcName = path.basename(s.file);
    const srcDir = path.dirname(s.file);
    const dstAt = dirHasFile(APP_THUMB_DIR, destName) ? dirFileMtime(APP_THUMB_DIR, destName) : 0;
    /* 先用目录索引里的 mtime 判「缩略图比源图新」，命中就不必再 statSync 源图（每个条目省一次 syscall） */
    const srcAt = dirHasFile(srcDir, srcName) ? dirFileMtime(srcDir, srcName) : 0;
    if (dstAt && srcAt && dstAt >= srcAt && fs.existsSync(dest)) return dest;
    if (dstAt && srcAt && dstAt >= srcAt) {
      /* 索引说命中、文件却不在：把索引扔掉，下面按真实 mtime 重算（绝不返回不存在的路径） */
      dirIndexDrop(APP_THUMB_DIR);
    }
    const st = srcAt ? { mtimeMs: srcAt } : fs.statSync(s.file);
    if (dstAt && dstAt >= st.mtimeMs && fs.existsSync(dest)) return dest;
    const made = makeAppThumb(fs.readFileSync(s.file), { width: THUMB_W, height: THUMB_H });
    if (!made || !made.length) return null;
    mkdirp(APP_THUMB_DIR);
    fs.writeFileSync(dest, made);
    /* 写完自查一次：盘上真的多出这份文件才认（写失败 / 别的东西删了它 → 回 null 让调用方回原图） */
    return fs.existsSync(dest) ? dest : null;
  } catch {
    return null;
  }
}
/** 封面源的 mtime（秒）当缓存令牌：截图 / 图标换了就换令牌，客户端与 nginx 都不拿旧图。
 *  为什么不能用版本号：作者在「编辑」里换截图不产生新版本（版本号不动），令牌必须挂在文件上。 */
function appCoverVer(a, src) {
  const s = src || appCoverSourceOf(a.id, a.userId);
  if (!s) return "";
  try {
    return String(Math.floor(fs.statSync(s.file).mtimeMs / 1000));
  } catch {
    return "";
  }
}
/** 封面缩略图在静态目录里的相对地址（icons/<主干>[__shot].png）：与 icon 同一个 icons/ 目录。 */
function appCoverThumbRelOf(a) {
  const src = appCoverSourceOf(a.id, a.userId);
  if (!src || !appThumbOf(a, src)) return "";
  return "icons/" + path.basename(appThumbFile(a.id, a.userId, src));
}

/* 只清这一分支自己的图标（新命名 + 它可能占着的老命名）——别的分支的图标绝不动。 */
function clearAppIcon(id, ownerId) {
  dirIndexDrop();
  const stems = [];
  const own = String(ownerId || "");
  if (own) stems.push(id + "__" + own);
  else {
    /* 没给作者（老调用）：退化成「清这个 id 的所有图标」，与老行为一致 */
    for (const ext of ["png", "jpg", "webp"]) {
      try { fs.unlinkSync(path.join(APP_ICON_DIR, id + "." + ext)); } catch {}
      /* 截图目录（shots/<主干>/）：删应用时一并清掉（只清这一分支那一个目录） */
      try { fs.rmSync(appShotDirOf(id, ""), { recursive: true, force: true }); } catch {}
    }
    return;
  }
  for (const stem of stems) {
    for (const ext of ["png", "jpg", "webp"]) {
      try { fs.unlinkSync(path.join(APP_ICON_DIR, stem + "." + ext)); } catch {}
    }
  }
}

/* ---------- 上架与多版本：开关 / 路径 / 版本记录 / 配额 / 声明（契约 §七） ---------- */

/**
 * 多版本总开关：**默认开**，只有显式 `MTNODE_APP_VERSIONS=0|false|no|off` 才关。
 * 判据集中在这里：路由与目录口径都只问它，别在别处再读一次环境变量。
 * 关档留给「PATCH 覆盖式更新」这类旧口径场景（老客户端 / 不想留版本史的自建站）。
 */
function appVersionsOn() {
  return !APP_VERSIONS_OFF.has(APP_VERSIONS_ENV);
}

/** 多版本包目录 `<APP_DIR>/<id>`（开关打开时一版一包；关时不用）。
 *  同 id 多分支后里面还会按作者分一层子目录：`<id>/<作者uid>/<版本>.zip`。 */
function appVersionDir(id) {
  return path.join(APP_DIR, id);
}

/** 一条分支的文件名主干：`<id>__<作者uid>`（同 id 多分支时区分彼此）。 */
/* ── 上架截图（多图）：落盘 / 列表 / 清理 ──────────────────────────────
 * 为什么单独一个目录：图标（icon）只留一张、语义是「封面」；截图是一组、语义是「界面实拍」。
 * 两者都会同步到静态目录（icons/ 与 shots/），客户端详情窗按 shots[] 画大图 + 缩略图条。 */
function appShotDirOf(id, ownerId) {
  return path.join(APP_SHOT_DIR, appFileStem(id, ownerId));
}
/* 该分支现有的截图文件（按序号升序）：返回绝对路径数组。
   点开头的是内部目录（`.obj` 别名目录），正则天然跳过；配合上面的 startsWith 兜一层。 */
function appShotFiles(id, ownerId) {
  const dir = appShotDirOf(id, ownerId);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith(".") && /^\d+\.(png|jpg|jpeg|webp)$/i.test(n))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((n) => path.join(dir, n));
}

/* ── 内容寻址图片缓存（对象库 + 别名）─────────────────────────────────────────────
 * 本轮需求的实现核心：**同一张图在云端只存一份**，且「已经传过的图」客户端不必重发字节。
 * 落点与指针（三个概念别混）：
 *   · 对象   <DATA_DIR>/images/objects/<sha256>.<ext>      内容本体，全站唯一一份
 *   · 别名   <DATA_DIR>/app-shots/<主干>/<序号>.<ext>       指向对象的硬链接（人可读 / 可排序 / 进静态目录）
 *   · 小图   <DATA_DIR>/images/objects/<sha256>.l1280.<ext> 列表用的导数（懒生成，也是对象）
 * 为什么用硬链接而不是符号链接：linux 线上与 Windows 开发机同一份代码，硬链接两边都不需要额外权限，
 * 且对既有读取链（fs.readFileSync / statSync / 静态目录拷贝）完全透明 —— 它就是那个文件。
 * 跨卷 / 文件系统不支持时退回复制：功能不受影响，只是那一份不再共享磁盘。
 * ───────────────────────────────────────────────────────────────────────────── */

/** 图片字节的内容哈希（十六进制 sha256）—— 对象名就是它。 */
function imgHashOf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 对象文件名：`<sha256>.<ext>`；变体（列表小图）把标记拼在扩展名前：`<sha256>.l1280.<ext>`。 */
function imgObjBase(hash, ext, suffix) {
  return String(hash) + String(suffix || "") + "." + String(ext || "png");
}

/** 对象绝对路径（不校验存在性）。 */
function imgObjPath(hash, ext, suffix) {
  return path.join(IMG_OBJ_DIR, imgObjBase(hash, ext, suffix));
}

/** 对象在不在（含大小，供配额与体检用）：{ path, bytes } 或 null。 */
function imgObjHold(hash, ext, suffix) {
  const p = imgObjPath(hash, ext, suffix);
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return { path: p, bytes: st.size };
  } catch (_) {}
  return null;
}

/** 写入一个对象（已存在就什么都不做 —— 同内容重复上传绝不重写盘）。 */
function imgObjPut(buf, ext, suffix) {
  const hash = imgHashOf(buf);
  const dest = imgObjPath(hash, ext, suffix);
  const hold = imgObjHold(hash, ext, suffix);
  if (!hold) {
    mkdirp(IMG_OBJ_DIR);
    const tmp = dest + ".tmp-" + process.pid + "-" + Date.now().toString(36);
    fs.writeFileSync(tmp, buf);
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
    dirIndexDrop(IMG_OBJ_DIR);
  }
  return { hash: hash, path: dest, bytes: buf.length, created: !hold };
}

/** 引用链接（硬链接 / 复制）指向对象；同路径已存在就先删掉（内容可能换了）。
 *  `dir` 递归建 —— 调用方的目录可能刚被整目录清过，不递归建就是 ENOENT。
 *  链接失败一律退回复制：功能不受影响，只是那一份不再共享磁盘（跨卷 / 文件系统不支持时）。 */
function imgAliasPut(dir, name, target) {
  mkdirp(dir);
  const dest = path.join(dir, name);
  try {
    fs.unlinkSync(dest);
  } catch (_) {}
  try {
    fs.linkSync(target, dest);
  } catch (_) {
    fs.copyFileSync(target, dest);
  }
  dirIndexDrop(dir);
  return dest;
}

/** 内容指纹的引用落点：images/refs/<sha256>.<ext>（每个被引用的内容一份）。
 *  用途：客户端说「这张图云端已经有了」时按内容认领；以及配额按内容去重算占用。 */
function imgRefPath(hash, ext) {
  return path.join(IMG_REF_DIR, imgObjBase(hash, ext, ""));
}
function imgRefHold(hash, ext) {
  const p = imgRefPath(hash, ext);
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return { path: p, bytes: st.size };
  } catch (_) {}
  return null;
}
/** 某个内容（sha256）在云端有没有：只要对象库里有它就算有（引用那一层只是加速查询）。 */
function imgObjHoldAnyExt(hash) {
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const hold = imgObjHold(hash, ext, "");
    if (hold) return { hold: hold, ext: ext };
  }
  return null;
}
/** 为一份内容建引用（幂等）：对象库那一份 + images/refs 里的硬链接。
 *  hash 缺失 / 非法一律**什么都不做**（对象在不在只认对象库，引用只是加速层）——
 *  绝不拿一个 undefined 去拼路径，那会在对象目录里留下一个名叫 "undefined.png" 的垃圾文件。 */
function imgRefPut(hash, ext) {
  if (!/^[0-9a-f]{64}$/i.test(String(hash || ""))) return null;

  const hold = imgObjHold(hash, ext, "");
  if (!hold) return null;
  if (!imgRefHold(hash, ext)) imgAliasPut(IMG_REF_DIR, imgObjBase(hash, ext, ""), hold.path);
  return hold;
}

/** 别名指向的真实对象路径（找不到回别名自己，调用方不必分叉）。 */
function shotObjectOf(aliasPath) {
  try {
    return fs.realpathSync(aliasPath);
  } catch (_) {
    return aliasPath;
  }
}

/** 认出「这个路径指向的对象库文件」：必须在 IMG_OBJ_DIR 里且名字是 <sha256>[.lN].<ext>。
 *  对硬链接而言 realpath 只做规范化（不解析到源），所以这条判据对截图那层同样成立。 */
function imgObjPartsOf(objPath) {
  const dir = path.dirname(String(objPath || ""));
  if (path.resolve(dir) !== path.resolve(IMG_OBJ_DIR)) return null;
  const m = /^([0-9a-f]{64})(\.l\d+)?\.(png|jpg|jpeg|webp)$/i.exec(path.basename(objPath));
  if (!m) return null;
  return { hash: m[1].toLowerCase(), suffix: m[2] || "", ext: m[3].toLowerCase(), path: objPath };
}

/** 一张已落盘截图对应的内容指纹（sha256）：先看它是不是对象库那一份（硬链接会直接落在
 *  对象库目录里时命中），否则**按内容现算一次** —— Windows 上 fs.realpathSync 不解析硬链接，
 *  所以「路径里读不出来」是常态，现算是这条路的兜底（只对老数据 / 少量文件发生）。 */
function appShotShaOf(aliasPath) {
  const parts = imgObjPartsOf(shotObjectOf(aliasPath));
  if (parts) return parts.hash;
  try {
    return imgHashOf(fs.readFileSync(aliasPath));
  } catch (_) {
    return "";
  }
}

/** 这条分支的截图与列表小图在**云端占的字节**（按对象去重：同一张图只算一次）。
 *  用途：每用户存储配额（截图 + 图标 + 应用包，见 accountStorageBytes）。 */
function appShotObjectBytesOf(a) {
  const id = typeof a === "string" ? a : (a && a.id) || "";
  const ownerId = typeof a === "string" ? arguments[1] : (a && a.userId) || "";
  const files = appShotFiles(id, ownerId);
  const dedup = new Set();
  let n = 0;
  /* 有 shots.shas 就直接按内容累加（去重最准）；没有（老记录）就按文件来。 */
  const shas = a && a.shots && Array.isArray(a.shots.shas) ? a.shots.shas : [];
  if (shas.length && shas.length === files.length) {
    for (const h of shas) {
      const key = String(h || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(key) || dedup.has(key)) continue;
      dedup.add(key);
      const got = imgObjHoldAnyExt(key);
      if (!got) continue;
      const small = imgObjHold(key, got.ext, SHOT_LIST_SUFFIX);
      n += (small ? small.bytes : 0) + got.hold.bytes;
    }
    return n;
  }
  for (const f of files) {
    const parts = imgObjPartsOf(shotObjectOf(f));
    let key = "";
    let bytes = 0;
    if (parts) {
      key = parts.hash;
      const small = imgObjHold(parts.hash, parts.ext, SHOT_LIST_SUFFIX);
      bytes = (small ? small.bytes : 0) + (() => {
        try { return fs.statSync(parts.path).size || 0; } catch (_) { return 0; }
      })();
    } else {
      try { bytes = fs.statSync(f).size || 0; } catch (_) {}
      key = "f:" + f;
    }
    if (dedup.has(key)) continue;
    dedup.add(key);
    n += bytes;
  }
  return n;
}

/** 图标文件的字节数（配额口径用；图标仍是单张 ≤500KB，不进对象库）。 */
function appIconBytesOf(id, ownerId) {
  const p = appIconPath(id, ownerId);
  if (!p) return 0;
  try { return fs.statSync(p).size || 0; } catch (_) { return 0; }
}

/** 列表用的小图（长边 APP_SHOT_LIST_EDGE）：没有就现生成一份对象（同内容全站共用）。
 *  返回相对静态目录的 shots/<主干>/<n>.list.<ext> 地址；做不了回 ""（客户端退回原图，绝不 404）。
 *  说明：**这张图不在分支目录里**（Windows 上 fs.realpathSync 不解析硬链接），所以内容指纹
 *  必须由调用方直接给出（hash / ext），不要在这里从路径反推。 */
function appShotListRelOf(dir, hash, ext, n) {
  try {
    if (!hash || !ext) return "";
    const hold = imgObjHold(hash, ext, SHOT_LIST_SUFFIX);
    let made = hold ? hold.path : "";
    if (!made) {
      const src = imgObjPath(hash, ext, "");
      const full = fs.statSync(src);
      const dec = makeAppShot(fs.readFileSync(src), { maxEdge: APP_SHOT_LIST_EDGE });
      if (!dec || !dec.buf || !dec.changed) return ""; /* 只缩不放：原图本来就小 → 用它自己 */
      const put = imgObjPut(dec.buf, ext, SHOT_LIST_SUFFIX);
      try { fs.utimesSync(put.path, full.atime, full.mtime); } catch (_) {}
      made = put.path;
    }
    const name = String(n) + ".list." + ext;
    imgAliasPut(dir, name, made);
    return "shots/" + path.basename(dir) + "/" + name;
  } catch (_) {
    return "";
  }
}

/** 这条分支的列表小图地址数组（与 shots[] 一一对应，取不到的位置给 ""）：
 *  按 `a.shots.shas`（内容指纹）逐张出小图，在分支目录里落 `<n>.list.<ext>` 硬链接。
 *  顺序必须与 shots[] 一致：所以先清掉上一次留下的 list 文件，再按同一次遍历写下去。
 *  客户端列表只下这些小图，详情才下原图 —— 这是「图片缓存」省流量的另一半。 */
function appShotListRelsOf(a) {
  const id = a && a.id;
  const ownerId = a && a.userId;
  const dir = appShotDirOf(id, ownerId);
  const files = appShotFiles(id, ownerId);
  /* 先清 list 文件（整批重写：顺序以本次为准，避免上一次的残留顶替） */
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    names = [];
  }
  for (const n of names) {
    if (/\.list\.(png|jpg|jpeg|webp)$/i.test(n)) {
      try { fs.unlinkSync(path.join(dir, n)); } catch (_) {}
    }
  }
  dirIndexDrop(dir);
  const shas = a && a.shots && Array.isArray(a.shots.shas) ? a.shots.shas : [];
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const hash = String(shas[i] || "").toLowerCase();
    const ext = ((files[i].match(/\.(\w+)$/) || [])[1] || "png").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      out.push("");
      continue;
    }
    out.push(appShotListRelOf(dir, hash, ext, i + 1));
  }
  return out;
}

/** 整批重排这一分支的截图落点（**内容先落对象库、再写平铺的序号文件**，绝不边读边删）：
 *   · 先为每份内容建 images/refs/<sha>.<ext> 引用（客户端「这张图传过了」按它认领）；
 *   · 再清掉这一分支目录里现有的截图与列表小图（别的分支的目录绝不动）；
 *   · 最后按输入顺序写 1..N 的硬链接（第 1 张仍是封面，顺序 = 作者排的顺序）。
 *  返回落盘张数。 */
function writeShotAliases(id, ownerId, imgs) {
  const dir = appShotDirOf(id, ownerId);
  const list = [];
  for (const im of Array.isArray(imgs) ? imgs : []) {
    if (!im || !im.objPath) continue;
    /* 内容指纹的字段名以 `hash` 为准（storeShots / appendAppShots 的产出），
       同时接受 `sha`（resolveAppShotsEdit 的产出）—— 两条路都写别名。
       这里只收「认得出来源」的项：objPath 缺失或指纹缺失的项一律跳过，
       否则 imgAliasPut 会拿 undefined 当源路径，抛错就在**清目录之后**，
       整批截图会连带目录一起没掉（2026-10 修：就是这么丢的）。 */
    const hash = String((im.hash || im.sha) || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    imgRefPut(hash, im.ext || "png");
    list.push({ hash: hash, ext: im.ext || "png", objPath: im.objPath });
  }
  /* 别名重排前先把要写的东西全部核过：只要有项不合格就**先别清目录**（宁可整批失败，
     也不制造「回执说成功、图却没了」）。 */
  if (Array.isArray(imgs) && imgs.length && list.length !== imgs.length) {
    const err = new Error("截图别名重排被中止：有 " + (imgs.length - list.length) + " 项缺少内容来源（不删旧图）");
    err.shotsIncomplete = true;
    throw err;
  }
  dirIndexDrop(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  if (!list.length) return 0;
  mkdirp(dir);
  let n = 0;
  for (const im of list) {
    n++;
    imgAliasPut(dir, String(n) + "." + String(im.ext || "png"), im.objPath);
  }
  return n;
}

/** 把一批截图排好落点（**同一张图只落一份**）。两种入参都收（两条路都走它）：
 *   · `{ buf, ext }` = decodeAppShots / decodeAppShots 的解码结果 → 先落对象库再排别名（上架、追加版本）；
 *   · `{ hash, ext, objPath }` = resolveAppShotsEdit 的产出（内容已经在对象库里了）→ 直接排别名。
 *  2026-10 修：原先只认 `{buf}`，编辑窗「整批替换」那条路传的是已解析对象 → 被全部跳过，
 *  结果**清空了截图目录还回执成功**（图就这么没了）。两条形状现在都归到同一处。 */
function storeShots(id, ownerId, shots) {
  const imgs = [];
  for (const s of Array.isArray(shots) ? shots : []) {
    if (!s) continue;
    const ext = s.ext || "png";
    if (s.buf) {
      const put = imgObjPut(s.buf, ext, "");
      imgs.push({ hash: put.hash, ext: ext, objPath: put.path });
      continue;
    }
    const hash = String((s.hash || s.sha) || "").toLowerCase();
    if (!s.objPath || !/^[0-9a-f]{64}$/.test(hash)) continue;
    imgs.push({ hash: hash, ext: ext, objPath: s.objPath });
  }
  const n = writeShotAliases(id, ownerId, imgs);
  return { count: n, shas: imgs.map((x) => x.hash) };
}

/** 这条分支现有的截图（含内容指纹）：追加 / 编辑两条路共用。
 *  优先用记录里那份 `shots.shas`（顺序与文件一致）；数量对不上（老数据 / 外部改动）就现算。 */
function appShotEntriesOf(id, ownerId, a) {
  const files = appShotFiles(id, ownerId);
  const shas = a && a.shots && Array.isArray(a.shots.shas) ? a.shots.shas : [];
  const aligned = shas.length === files.length;
  return files.map((p, i) => {
    const parts = imgObjPartsOf(shotObjectOf(p));
    const ext = (parts && parts.ext) || ((p.match(/\.(\w+)$/) || [])[1] || "png").toLowerCase();
    const sha = (aligned && /^[0-9a-f]{64}$/i.test(String(shas[i] || "")) ? String(shas[i]).toLowerCase() : "") || appShotShaOf(p);
    return { sha: sha, ext: ext, objPath: (parts && parts.path) || p, n: i + 1 };
  });
}

/** 对象库里**没有任何应用引用**的对象（管理员「清理无主图片」用）。
 *  判据 = 反向索引：扫全部应用记录的截图别名指向，没被任何一条指到的对象即无主。 */
function imgObjectsList() {
  let names = [];
  try {
    names = fs.readdirSync(IMG_OBJ_DIR);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => /^[0-9a-f]{64}(\.l\d+)?\.(png|jpg|jpeg|webp)$/i.test(n))
    .map((n) => {
      const p = path.join(IMG_OBJ_DIR, n);
      let bytes = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(p);
        bytes = st.size;
        mtimeMs = st.mtimeMs;
      } catch (_) {}
      return { name: n, path: p, bytes: bytes, mtimeMs: mtimeMs };
    });
}

/** 清理无主图片对象：删掉没有任何应用记录引用的对象（正在用的一个都不动）。
 *  判据：原图（`<sha>.<ext>`）看有没有分支引用它；
 *        列表小图（`<sha>.l1280.<ext>`）看它的**原图**是不是还被引用着 —— 原图还在用就留着，
 *        原图已经没人要了就一起清掉（否则「换过一批截图」会永久留下用不到的派生物）。
 *  返回 { scanned, orphans, removed, freedBytes, kept, bytesUsed }。 */
function imgObjectsGc() {
  const referenced = new Set();
  for (const a of db.apps || []) {
    if (!a) continue;
    let n = 0;
    for (const h of Array.isArray(a.shots && a.shots.shas) ? a.shots.shas : []) {
      const k = String(h || "").toLowerCase();
      if (/^[0-9a-f]{64}$/.test(k)) {
        referenced.add(k);
        n++;
      }
    }
    /* 老记录（没有 shots.shas）：现算这一分支落盘文件的指纹，别把在用的图当无主删掉 */
    if (!n) {
      for (const e of appShotEntriesOf(a.id, a.userId, a)) {
        if (e.sha) referenced.add(e.sha);
      }
    }
  }
  const all = imgObjectsList();
  let removed = 0;
  let freedBytes = 0;
  for (const o of all) {
    const m = /^([0-9a-f]{64})/i.exec(o.name);
    const hash = m ? m[1].toLowerCase() : "";
    if (hash && referenced.has(hash)) continue;
    try {
      fs.unlinkSync(o.path);
      removed++;
      freedBytes += o.bytes;
    } catch (_) {}
  }
  dirIndexDrop(IMG_OBJ_DIR);
  return {
    scanned: all.length,
    orphans: removed,
    removed: removed,
    freedBytes: freedBytes,
    kept: all.length - removed,
    bytesUsed: all.reduce((n, o) => n + o.bytes, 0) - freedBytes,
  };
}

/* ── 已删除留痕（本轮需求：彻底删除时把被删分支的最小元信息留下来）──────────────────
 * 记录与文件都清掉之后，同一 id 下**还有别的作者分支**时留一条最小元信息：
 *   · 别的分支的 forkOf 还指着它（界面上的「分支来源」），家族树 / 目录生成要能回答
 *     「它去哪了」—— 记录一旦从 db.apps 里 splice 掉，这些字段就再也算不出来了；
 *   · 字段就这几个（id / ownerId / ownerName / title / 版本列表 / latestVersion / 删除时间），
 *     包 / 图标 / 截图 / 字节一个都不留 —— 「彻底删除」的口径不变。
 * 同一 id 下**一条分支都不剩**时不写：那是真的「云端不留痕迹」，没有别人需要这份元信息。
 * 容量与 contentAudit 同口径（最近 N 条，超出丢最旧的）。 */
const APP_DELETED_LEDGER_MAX = 200;

/** 一条分支彻底删除**之前**的元信息快照 { versions, latestVersion }。
 *  ⚠ 必须在改 `a.versions` / `a.latestVersion` 之前取：删到零版本那条路径会先把版本记录
 *  清空再调 deleteAppBranch，晚一步取到的就是空列表（留痕里的版本列表恒为空）。 */
function appBranchDeleteMeta(a) {
  return {
    versions: appVersionRecords(a).map((v) => String((v && v.version) || "")).filter(Boolean),
    latestVersion: appLatestVersion(a) || appCurrentVersionOf(a) || "",
  };
}

function appDeletedLedgerPush(id, ownerId, title, meta) {
  if (!Array.isArray(db.appDeletedLedger)) db.appDeletedLedger = [];
  db.appDeletedLedger.unshift({
    id: String(id || ""),
    ownerId: String(ownerId || ""),
    ownerName: accountDisplayNameOf(ownerId),
    title: String(title || id || ""),
    versions: (meta && Array.isArray(meta.versions) ? meta.versions : []).slice(),
    latestVersion: String((meta && meta.latestVersion) || ""),
    deletedAt: now(),
  });
  if (db.appDeletedLedger.length > APP_DELETED_LEDGER_MAX) db.appDeletedLedger.length = APP_DELETED_LEDGER_MAX;
}

/* ── 彻底删除一条应用分支（本轮需求：删掉最后一个版本 = 云端不留痕迹）────────────────
 * 这是**唯一**的删除实现：应用中心的「删除」、作者「删掉最后一个版本」与管理台的两条删除
 * 都走它（原来几处各写一遍，删光版本那条只置可见性位，于是记录 / 包 / 图标 / 截图 / 目录都留着）。
 * 顺序（错一步就会留下残件或删到别人）：
 *   ① 先把「这条记录自己的」文件清单算出来（记录一旦 splice 掉，就再也算不出来了）；
 *   ② 再处理下载量计数；
 *   ③ 清包 / 图标 / 截图 / 封面缩略图 / 版本子目录（数据目录）；
 *   ④ 清静态目录的散件、`<id>/` 子目录、`shots/<主干>/`，并收掉空目录；
 *   ⑤ 清本分支的镜像 `<id>__<uid>.zip`，**老共用镜像 `<id>.zip` 只在没有别的分支还在用
 *      这个 id 时才删**（否则会把别人的包删掉）；
 *   ⑥ 调 imgObjectsGc：删掉「没有任何应用记录认领」的图片对象（连同它的列表小图）。
 *   ⑦ 同一 id 下还有别的作者分支时写一条已删除留痕（meta = 删除前的版本快照）。
 * 返回 { ok, id, ownerId, title, removed: {…}, imgGc }（供日志与回归断言）。 */
async function deleteAppBranch(a, meta) {
  if (!a) return { ok: false, error: "no branch" };
  const idx = (db.apps || []).indexOf(a);
  if (idx < 0) return { ok: false, error: "not in db" };
  const id = a.id;
  const ownerId = String(a.userId || "");
  const title = a.title || id;
  const versions = appVersionRecords(a).map((v) => v.version);
  const owner = db.users.find((u) => u.id === ownerId) || null;
  const branchBytes = Number(a.bytes) || 0;
  const branchDownloads = Number(a.downloads) || 0;
  /* ② 下载量计数：只回退这一条自己贡献的那部分（别的分支不动） */
  try {
    await applyUserPatch(ownerId, {
      downloadsReceived: Math.max(0, Number((owner && owner.downloadsReceived) || 0) - branchDownloads),
    });
  } catch (_) {}
  /* ③ 数据目录：自己的镜像 + 自己的版本包（别人的一个都不动） */
  try { fs.unlinkSync(appOwnerZipPath(id, ownerId)); } catch {}
  db.apps.splice(idx, 1);
  /* 记录已经没了 —— 从现在起「还有没有别的分支用这个 id」的判据才是准的 */
  const rest = appBranchesOf(id);
  /* ⑦ 已删除留痕：还有别的分支才留（判据用 splice 之后的 rest，见函数上方注释） */
  if (rest.length) appDeletedLedgerPush(id, ownerId, title, meta);
  for (const v of versions) {
    try { fs.unlinkSync(appBranchVersionZipPath(id, ownerId, v)); } catch {}
    const sharedUsed = rest.some((x) => appVersionRecords(x).some((r) => r.version === v));
    if (!sharedUsed) {
      try { fs.unlinkSync(appVersionZipPath(id, v)); } catch {}
    }
  }
  try { fs.rmdirSync(path.join(appVersionDir(id), ownerId)); } catch {}
  if (!rest.length) {
    /* 这个 id 一条分支都不剩了 → 老共用镜像也删（留着一个没有记录认领的 zip 就是痕迹） */
    try { fs.unlinkSync(appZipPath(id)); } catch {}
  }
  /* ④ 图标 / 封面缩略图 / 截图别名（数据目录）+ 静态目录整棵 */
  clearAppIcon(id, ownerId);
  clearAppThumb(id, ownerId);
  clearAppShots(id, ownerId);
  const dataDirs = clearAppBranchDataDir(id, ownerId);
  const stat = cleanAppBranchStatic(id, ownerId);
  /* ⑤ 图片对象垃圾回收：只删「没有任何应用记录引用」的对象（原图 + 它的列表小图） */
  let imgGc = null;
  try {
    imgGc = imgObjectsGc();
  } catch (_) {}
  return {
    ok: true,
    id: id,
    ownerId: ownerId,
    title: title,
    versions: versions,
    bytes: branchBytes,
    downloads: branchDownloads,
    owner: owner,
    removed: { staticFiles: stat.removed, staticDirs: stat.dirs, dataDirs: dataDirs },
    imgGc: imgGc,
  };
}

/* 截图在静态目录里的相对地址（shots/<主干>/<n>.png）——与 zipUrl / icon 同一套「相对目录」口径 */
function appShotRelsOf(id, ownerId) {
  const dir = appShotDirOf(id, ownerId);
  return appShotFiles(id, ownerId).map((p) => "shots/" + path.basename(dir) + "/" + path.basename(p));
}
/* 覆盖式写入这一批截图（整批重排：内容先落对象库，再做别名 —— 绝不边写边删）。
 * 入参可以是 decodeAppShots 的结果，也可以是「现成对象」{sha,ext} 数组；
 * 返回落盘张数（老签名兼容：调用方只关心张数时照旧拿数字）。 */
function writeAppShots(id, ownerId, shots) {
  return storeShots(id, ownerId, shots).count;
}
/* 删除这一批截图（应用被删 / 作者清空时用）：别名整目录下掉，**对象库那一份留着**
   （别的分支 / 别的用户可能还在引用同一张图；无主对象由管理员的「清理无主图片」回收）。 */
function clearAppShots(id, ownerId) {
  dirIndexDrop();
  try {
    fs.rmSync(appShotDirOf(id, ownerId), { recursive: true, force: true });
  } catch {}
}
/** 取对象库里已有的那张图（客户端说「这张我已经传过了」时走它）：
 *  命中回 { buf, ext, bytes, w, h, changed:false, reused:true }，没命中的位置回 null。
 *  找不到（没传过 / 对象被清过）时**返回 null 让调用方如实报错**，绝不静默丢图。 */
function shotFromSha(sha) {
  const h = String(sha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const hold = imgObjHold(h, ext, "");
    if (!hold) continue;
    let buf = null;
    try {
      buf = fs.readFileSync(hold.path);
    } catch (_) {
      return null;
    }
    let w = 0;
    let hh = 0;
    try {
      const dec = decodeImage(buf);
      if (dec) {
        w = dec.w;
        hh = dec.h;
      }
    } catch (_) {}
    return { buf: buf, ext: ext, bytes: buf.length, w: w, h: hh, changed: false, reused: true };
  }
  return null;
}
/* 单张新图：解密 → 按单张上限校验 → 长边收到 APP_SHOT_MAX_EDGE（只缩不放）→ 仍超限即拒。
 * 画质与体积的取舍写在注释里：客户端已压过一道（超 1MB 转 WebP / JPEG），服务端只兜口径。 */
function decodeAppShotOne(raw, i) {
  let one = null;
  try {
    one = decodePreviewAny(raw);
  } catch (e) {
    return { ok: false, error: "第 " + (i + 1) + " 张截图无效：" + ((e && e.message) || e) };
  }
  if (!one) {
    return { ok: false, error: "第 " + (i + 1) + " 张截图为空或格式不被支持（png / jpeg / webp）" };
  }
  if (one.buf.length > MAX_APP_SHOT_BYTES) {
    return {
      ok: false,
      error:
        "第 " + (i + 1) + " 张截图 " + fmtBytes(one.buf.length) + " 超过单张上限 " + fmtBytes(MAX_APP_SHOT_BYTES) +
        "（请先裁切 / 压缩后再传）",
    };
  }
  let buf = one.buf;
  let ext = one.ext;
  let w = 0;
  let h = 0;
  let changed = false;
  const small = makeAppShot(one.buf, { maxEdge: APP_SHOT_MAX_EDGE });
  if (small && small.buf && small.buf.length) {
    buf = small.buf;
    ext = small.changed ? "png" : one.ext;
    w = small.w;
    h = small.h;
    changed = !!small.changed;
  }
  if (buf.length > MAX_APP_SHOT_BYTES) {
    return {
      ok: false,
      error: "第 " + (i + 1) + " 张截图压缩后仍超过 " + fmtBytes(MAX_APP_SHOT_BYTES) + "（请换小一点的图）",
    };
  }
  return { ok: true, shot: { buf: buf, ext: ext, bytes: buf.length, w: w, h: h, changed: changed, reused: false } };
}
/* 解码客户端发来的截图数组：**逐张**校验 + 服务端统一收边（长边→APP_SHOT_MAX_EDGE）。
 * 契约（本轮需求：单张上限抬到 5MB，并支持「这张已经在云端」的引用形态）：
 *   body.shotsBase64 = [ "<base64 或 data:image/...;base64,...>" | { sha: "<sha256>" }, ... ]，最多 8 张。
 *   { sha } = 客户端按内容指纹认出「云端已经有这张图」→ **不重发字节**，服务端按对象库直接复用；
 *   对象库没有它（没传过 / 被清过）→ 整批拒绝并指名第几张，绝不静默少图。
 * 回 { ok, shots:[{buf,ext,bytes,w,h,changed,reused}], total, errors:[] }；任何一张不合格整批拒绝
 * （宁可让作者看到明确报错，也不落一半截图 —— 半批最难查）。 */
function decodeAppShots(list) {
  const arr = Array.isArray(list) ? list : [];
  const errors = [];
  if (arr.length > MAX_APP_SHOTS) {
    return { ok: false, errors: ["截图最多 " + MAX_APP_SHOTS + " 张（收到 " + arr.length + " 张）"], shots: [] };
  }
  const shots = [];
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    const shaRef = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.sha : "";
    if (shaRef) {
      const got = shotFromSha(shaRef);
      if (!got) {
        return {
          ok: false,
          errors: [
            "第 " + (i + 1) + " 张截图引用（sha " + String(shaRef).slice(0, 12) + "…）在云端没有这份图片：" +
              "请把这张图重新上传一次（客户端会按内容指纹重传）",
          ],
          shots: [],
        };
      }
      total += got.bytes;
      shots.push(got);
      continue;
    }
    const one = decodeAppShotOne(raw, i);
    if (!one.ok) return { ok: false, errors: [one.error], shots: [] };
    total += one.shot.bytes;
    shots.push(one.shot);
  }
  return { ok: true, shots: shots, total: total, errors: errors };
}

/* 编辑已上架截图：把「新图 + 沿用旧图」的混合数组解析成最终要落盘的一批**对象**。
 * 契约（客户端编辑窗只握有新图的数据）：
 *   list 元素三种形态混合 ——
 *     · 字符串 / data:image/...;base64,... = 新图，走 decodeAppShots 校验 + 收边；
 *     · { sha } = 客户端按内容指纹认出「云端已有这张图」→ 直接复用对象库那一份（不重发字节）；
 *     · { keep: n }（n 为 0 起的整数）= 沿用**保存前**这一分支的第 n 张（oldFiles 按序号升序）。
 * 语义：整批替换 —— 最终一套 = 按 list 顺序逐项解析；旧图里没被 keep 引用的全部下掉（含第 9 张），不残留。
 * 关键实现纪律：**先把被引用的旧图解析成对象，再让调用方重排别名** —— 别名重排会先清目录，
 *   边读边写会把还没读的旧图毁掉（第 3 个坑：本轮改成「先落对象（内容寻址，重复不重写）→ 再写别名」，
 *   对象那一份与别名目录无关，所以这条坑从根上消失了）。
 * 回 { ok, imgs:[{sha,ext,objPath}], errors:[] }；任何一项不合格整批拒绝（不落一半）。
 * 空数组 [] = 清空（合法，回 imgs 为空数组）。 */
function resolveAppShotsEdit(list, oldFiles, oldShas) {
  if (!Array.isArray(list)) {
    return { ok: false, errors: ["截图必须是数组（新图 base64 字符串、{\"sha\":\"…\"}，或 {\"keep\": n} 沿用旧图）"], imgs: [] };
  }
  const old = Array.isArray(oldFiles) ? oldFiles : [];
  /* 上限按**最终张数**算（keep / sha / 新图 混着数）：否则 5 张 keep + 5 张新图能绕过 8 张上限 */
  if (list.length > MAX_APP_SHOTS) {
    return { ok: false, errors: ["截图最多 " + MAX_APP_SHOTS + " 张（收到 " + list.length + " 张）"], imgs: [] };
  }
  const newItems = [];
  const keeps = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const isShaRef = raw && typeof raw === "object" && !Buffer.isBuffer(raw) && raw.sha && raw.keep == null;
    if (isShaRef) {
      /* 与「新图」同一条解码/校验路径（decodeAppShots 认得 { sha }）—— 不要在这里另写一套解析 */
      newItems.push({ i: i, raw: raw });
      continue;
    }
    if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) {
      const n = raw.keep;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        return {
          ok: false,
          errors: ["第 " + (i + 1) + " 张截图无效：keep 必须是从 0 起的整数（收到 " + JSON.stringify(n) + "）"],
          imgs: [],
        };
      }
      if (n >= old.length) {
        return {
          ok: false,
          errors: [
            "第 " + (i + 1) + " 张截图无效：keep=" + n + " 越界（这条分支保存前只有 " + old.length + " 张，可用 0.." +
              (old.length - 1) + "）",
          ],
          imgs: [],
        };
      }
      keeps.push({ i: i, n: n, file: old[n], sha: (oldShas && oldShas[n]) || "" });
    } else {
      newItems.push({ i: i, raw: raw });
    }
  }
  /* 新图 / sha 引用整批校验（同一套口径：任何一张不合格整批拒绝）。
     decodeAppShots 只认得「串 / {sha}」，keep 项不喂给它，所以要把下标换回客户端看到的第几项。 */
  let decoded = { ok: true, shots: [] };
  if (newItems.length) {
    decoded = decodeAppShots(newItems.map((x) => x.raw));
    if (!decoded.ok) {
      const errors = (decoded.errors || []).map((msg) =>
        String(msg).replace(/^第 (\d+) 张/, (all, k) => {
          const at = newItems[Number(k) - 1];
          return "第 " + ((at ? at.i : Number(k) - 1) + 1) + " 张";
        }),
      );
      return { ok: false, errors: errors.length ? errors : ["截图无效"], imgs: [] };
    }
  }
  /* 按 list 原始顺序拼最终一套（这就是拖拽排序的结果）：新图/引用 → 落对象；keep → 直接指回原对象 */
  const newAt = new Map();
  newItems.forEach((x, k) => newAt.set(x.i, decoded.shots[k]));
  const keepAt = new Map(keeps.map((x) => [x.i, x]));
  const imgs = [];
  for (let i = 0; i < list.length; i++) {
    if (newAt.has(i)) {
      const s = newAt.get(i);
      if (!s || !s.buf) return { ok: false, errors: ["第 " + (i + 1) + " 张截图不可用"], imgs: [] };
      const put = imgObjPut(s.buf, s.ext || "png", "");
      imgs.push({ hash: put.hash, ext: s.ext || "png", objPath: put.path });
      continue;
    }
    const k = keepAt.get(i);
    if (!k) return { ok: false, errors: ["第 " + (i + 1) + " 张截图不可用"], imgs: [] };
    /* 沿用旧图：优先指回对象库里那一份（平铺布局下 k.file 就是分支目录里的文件本身，
       而别名重排会先清目录 —— 指回它自己会变成「复制到它自己」）。
       老数据（没进过对象库）现场读一份进对象库，之后就走统一口径了。 */
    const have = imgObjHoldAnyExt(k.sha);
    if (have) {
      imgs.push({ hash: k.sha, ext: have.ext, objPath: have.hold.path });
      continue;
    }
    let buf = null;
    try {
      buf = fs.readFileSync(k.file);
    } catch (e) {
      return { ok: false, errors: ["第 " + (k.i + 1) + " 张截图读取失败（旧图 " + path.basename(k.file) + "）：" + ((e && e.message) || e)], imgs: [] };
    }
    const ext = (path.extname(k.file).slice(1) || "png").toLowerCase();
    const put = imgObjPut(buf, ext === "jpeg" ? "jpg" : ext, "");
    imgs.push({ hash: put.hash, ext: ext === "jpeg" ? "jpg" : ext, objPath: put.path });
  }
  return { ok: true, imgs: imgs, errors: [] };
}

/* 追加式写入截图（**保留旧图**）：收下这一批新图，按内容去重后接在现有图之后。
 *
 * 为什么需要它（用户报障：上传截图后再更新，截图上那张就没了）：
 *   版本追加（POST /versions 与「PATCH + zip」）原来走 writeAppShots = **整批替换** ——
 *   作者上传新版本时只带本次新加的图（客户端手里没有旧图字节），旧的整套就被删掉了。
 *   版本追加的语义是「同一件事的新一版」，截图属于应用本身，没被显式删掉就该留着。
 *   **编辑窗（只改元信息、不带 zip 的 PATCH）不改口径**：那条路带 {keep:n} 指代，是作者
 *   显式增删 + 排序的结果，仍走 resolveAppShotsEdit 的整批替换（否则作者删不掉截图）。
 *
 * 去重按**内容**（sha256 = 对象库的名字）：同一张图重复上传不会变成两张，也不会重复落盘；
 * 幂等——同一批图传两次，第二次一个字节都不落。返回 { ok, added, files, total, errors }：
 *   · added = 本次真正新增的张数（0 = 全已存在）；
 *   · files = 追加后的落盘文件名（供回执 / 体检核对）。
 * 校验先做完再落盘：任何一张不合格 → ok:false，一个字节都不动（与整批替换同一纪律）。
 * 上限以**追加后的总数**算（MAX_APP_SHOTS）：满了就如实报错，绝不静默丢图。 */
function appendAppShots(id, ownerId, shots, a) {
  const entries = appShotEntriesOf(id, ownerId, a);
  const have = new Set(entries.map((e) => e.sha).filter(Boolean));
  const add = [];
  for (const s of Array.isArray(shots) ? shots : []) {
    if (!s || !s.buf) continue;
    const h = imgHashOf(s.buf);
    if (have.has(h)) continue; // 这张已经在云端了（同一张图重复上传 → 不落第二份）
    have.add(h);
    add.push({ buf: s.buf, ext: s.ext || "png", sha: h });
  }
  if (entries.length + add.length > MAX_APP_SHOTS) {
    return {
      ok: false,
      added: 0,
      files: entries.map((e) => String(e.n)),
      total: entries.length,
      errors: [
        "截图最多 " + MAX_APP_SHOTS + " 张：这条分支已有 " + entries.length + " 张，本次还要加 " + add.length +
          " 张。请先在「编辑」里删掉不需要的，再上传",
      ],
    };
  }
  /* 现有 + 新增一起重排落点（顺序一个字都不动：第 1 张仍是封面）。
     现有那几张的 objPath 可能**就指向分支目录里那个文件自身**（平铺布局：分支目录里的
     <n>.<ext> 已经是硬链接，Windows 上 realpath 不解析回对象库）——而重排第一步就清目录，
     所以要先把它们解析回对象库里的那一份（按内容指纹取），否则会「复制到它自己」。 */
  const imgs = [];
  for (const e of entries) {
    const parts = imgObjHoldAnyExt(e.sha);
    let objPath = parts ? parts.hold.path : "";
    const ext = parts ? parts.ext : e.ext;
    if (!objPath) {
      /* 老数据 / 对象被清过：把这一张现读一份进对象库（内容不变，指纹也不变） */
      try {
        const put = imgObjPut(fs.readFileSync(e.objPath), ext || "png", "");
        objPath = put.path;
      } catch (_) {
        return {
          ok: false,
          added: 0,
          files: [],
          total: entries.length,
          errors: ["已有截图 " + e.n + " 的内容不在对象库里（且读不回来）：请重新上传这一张"],
        };
      }
    }
    imgs.push({ hash: e.sha, ext: ext, objPath: objPath });
  }
  for (const s of add) {
    const put = imgObjPut(s.buf, s.ext, "");
    imgs.push({ hash: put.hash, ext: s.ext, objPath: put.path });
  }
  if (!add.length) {
    return { ok: true, added: 0, files: entries.map((e) => String(e.n)), total: entries.length, errors: [] };
  }
  const n = writeShotAliases(id, ownerId, imgs);
  return { ok: true, added: add.length, files: appShotFiles(id, ownerId).map((p) => path.basename(p)), total: n, errors: [] };
}

/* 上架链路的**全链路诊断**（本轮需求：截图没落盘这件事下次要一眼看出断在哪）：
 * 逐环节给出可核对的数字 —— 收没收到、解码过没过、压了多少、落盘几个文件、静态目录同步过没有。 */
function appShotsDiag(a) {
  const dir = appShotDirOf(a.id, a.userId);
  const files = appShotFiles(a.id, a.userId);
  const rels = appShotRelsOf(a.id, a.userId);
  const isListName = (n) => /\.list\.(png|jpg|jpeg|webp)$/i.test(String(n || ""));
  const webDir = path.join(APPS_WEB_DIR, "shots", path.basename(dir));
  const webAll = (() => {
    try {
      return fs.readdirSync(webDir);
    } catch {
      return [];
    }
  })();
  /* 小图（<n>.list.<ext>）不参与「源 / 静态」张数对账：它是派生物，条数天然不一致 */
  const webFiles = webAll.filter((n) => !isListName(n));
  const listFiles = files
    .map((p) => String(path.basename(p)).replace(/\.(\w+)$/, ".list.$1"))
    .filter((n) => webAll.indexOf(n) >= 0);
  return {
    id: a.id,
    ownerId: a.userId,
    dir: dir,
    dirExists: fs.existsSync(dir),
    files: files.map((p) => ({ name: path.basename(p), bytes: fs.statSync(p).size })),
    rels: rels,
    totalBytes: files.reduce((n, p) => n + (fs.statSync(p).size || 0), 0),
    /* 内容寻址（本轮需求）：这些截图的指纹，以及它们在对象库里是不是同一份 */
    shas: appShotEntriesOf(a.id, a.userId, a).map((e) => e.sha),
    objectCount: (() => {
      try {
        return fs.readdirSync(IMG_OBJ_DIR).length;
      } catch (_) {
        return 0;
      }
    })(),
    listRels: appShotListRelsOf(a),
    listStaticFiles: webAll.filter(isListName),
    staticDir: webDir,
    staticFiles: webFiles,
    staticInSync: webFiles.length === files.length && listFiles.length === webAll.filter(isListName).length,
    icon: appIconRelOf(a.id, a.userId),
    iconExists: !!appIconPath(a.id, a.userId),
  };
}

function appFileStem(id, ownerId) {
  const own = String(ownerId || "").trim();
  return own ? id + "__" + own : String(id || "");
}

/** 单版包路径 `<APP_DIR>/<id>.zip`：老口径的唯一落点，也是多版本 / 多分支下「最新版」的镜像。 */
function appZipPath(id) {
  return path.join(APP_DIR, id + ".zip");
}

/** 某一分支当前版的包路径（**只对这一分支自己那版有效**，见 appZipPathOfBranchVia）。 */
function appOwnerZipPath(id, ownerId) {
  return path.join(APP_DIR, appFileStem(id, ownerId) + ".zip");
}

/** 某一版的包路径（老落点：`<id>/<版本>.zip`）。版本号已过 normalizeVersion（无 `/` 与 `..`），拼路径安全。 */
function appVersionZipPath(id, version) {
  return path.join(appVersionDir(id), version + ".zip");
}

/** 某一版**分支私有**的包路径：`<id>/<作者uid>/<版本>.zip`（同 id 不同作者同号版本不会互撞）。 */
function appBranchVersionZipPath(id, ownerId, version) {
  return path.join(appVersionDir(id), String(ownerId || ""), version + ".zip");
}

/** 分支的静态包名（相对 /mtnode/apps/）：`<id>__<作者uid>.zip`。 */
function appZipRel(id, ownerId) {
  return appFileStem(id, ownerId) + ".zip";
}

/** 分支某一版的静态包相对路径：`<id>/<作者uid>/<版本>.zip`。 */
function appVersionZipRel(id, ownerId, version) {
  return id + "/" + String(ownerId || "") + "/" + version + ".zip";
}

/** 这一版该写哪儿：分支私有目录优先；已经存在（老落点被她占着）就退老落点 —— 内容都是同一份包。 */
function writeAppVersionZipPath(id, ownerId, version) {
  dirIndexDrop();
  const own = appBranchVersionZipPath(id, ownerId, version);
  const shared = appVersionZipPath(id, version);
  if (!fs.existsSync(shared)) return own;
  if (!fs.existsSync(own)) return shared;
  return own;
}

/**
 * 落盘：开关打开时写「这一版自己的包」（有作者 = `<id>/<作者uid>/<版本>.zip`，
 * 老落点 `<id>/<版本>.zip` 已被占就与它共用），**并且**把这一版同时刷成
 * `<id>__<作者uid>.zip`（这一分支的当前版镜像）；关开关（老单版口径）只写老镜像 `<id>.zip`。
 */
function writeAppZipFiles(id, version, buf, ownerId) {
  dirIndexDrop();
  if (appVersionsOn() && version) {
    const target = writeAppVersionZipPath(id, ownerId, version);
    mkdirp(path.dirname(target));
    fs.writeFileSync(target, buf);
  }
  const own = String(ownerId || "");
  if (own) {
    fs.writeFileSync(appOwnerZipPath(id, own), buf);
    return;
  }
  fs.writeFileSync(appZipPath(id), buf);
}

/**
 * 一条分支的「当前版」包在哪：
 *   ① 分支私有包 `<id>/<作者uid>/<版本>.zip`
 *   ② 自己那份镜像 `<id>__<作者uid>.zip`
 *   ③ 老落点 `<id>/<版本>.zip`（老落点被她占着的分支仍读得到）
 *   ④ **全局**镜像 `<id>.zip` —— 只有「她的版本 = 这个 id 跨分支的最高版」时才认，
 *      否则就是别的分支的包，绝不能拿错。
 */
function appZipPathOfBranchVia(a) {
  const id = String((a && a.id) || "");
  const own = String((a && a.userId) || "");
  if (!id) return { path: "", via: "" };
  for (const v of [appLatestVersion(a), String((a && a.version) || "")]) {
    if (!v) continue;
    const p = appBranchVersionZipPath(id, own, v);
    if (fs.existsSync(p)) return { path: p, via: "branch" };
  }
  const mirror = appOwnerZipPath(id, own);
  if (fs.existsSync(mirror)) return { path: mirror, via: "mirror" };
  const latest = appLatestVersion(a);
  if (latest && appGlobalLatest(id) === latest) {
    for (const p of [appVersionZipPath(id, latest), appZipPath(id)]) {
      if (fs.existsSync(p)) return { path: p, via: p === appZipPath(id) ? "legacy-mirror" : "shared" };
    }
  }
  return { path: "", via: "" };
}

/** 分支当前版的落点（给老客户端 / 静态目录兜底用）：没有就回空串。 */
function appZipPathOfBranch(a) {
  return appZipPathOfBranchVia(a).path;
}

/** 版本记录数组：老记录（开关关时建的）没有这个字段 → 空数组。 */
function appVersionRecords(a) {
  return Array.isArray(a && a.versions) ? a.versions : [];
}

/** 这条记录到底有没有 `versions` 字段：空数组（版本全被删）≠ 没有字段（老单版记录）。 */
function appHasVersionField(a) {
  return !!(a && Array.isArray(a.versions));
}

/** 最新版版本号：开关打开时以 latestVersion 为准（可为 "" = 版本全被删），老记录退回 version。 */
function appLatestVersion(a) {
  if (!a) return "1.0.0";
  if (typeof a.latestVersion === "string") return a.latestVersion;
  return String(a.version || "1.0.0");
}

/** 对外下发的「当前版本号」（存量自愈的唯一判据）：
 *  `versions` 字段存在但已空 = 这一分支的版本**真被删光了** → **空串**，
 *  绝不用残留的 `version` 字段充数。老口径下删光只清了 latestVersion / bytes，
 *  `version` 会留在记录里，客户端按「latestVersion || version」就会把删掉的版本又画回来
 *  （线上踩过：删版本成功、界面上那一版还在）。 */
function appCurrentVersionOf(a) {
  if (!a) return "";
  if (appHasVersionField(a) && !appVersionRecords(a).length) return "";
  return String(a.version || "");
}

/** 一条应用占用的云端字节：多版本 = 各版之和，老记录 = 单包 bytes。 */
function appStoredBytes(a) {
  const vs = appVersionRecords(a);
  if (!vs.length) return Number(a && a.bytes) || 0;
  return vs.reduce((n, v) => n + (Number(v && v.bytes) || 0), 0);
}

/* 可见性开关整组（appHasDistributablePackage / appRestoreVisibility / republished 回执）
   已随本轮两态收敛一并删除：库里留下的应用就是在线上，目录按整库现算，
   不再有「有包却不可见」这种需要复位的状态（不留死代码）。 */

/** 名下所有应用的云端已存包总量（**包口径**：所有版本 bytes 之和；不含图片）。 */
function accountAppBytes(userId) {
  return (db.apps || [])
    .filter((a) => a.userId === userId)
    .reduce((n, a) => n + appStoredBytes(a), 0);
}

/* ── 每用户存储上限（本轮需求：后台可逐个用户调整）────────────────────────────────
 * 口径（与用户确认过的共识）：**按账号**算 —— 名下所有应用、所有分支与版本的应用包
 *   + 截图 / 图标占的云端字节（截图按内容寻址去重后**只算一份**：同一张图在多个版本、
 *     多条分支、甚至不同用户之间复用，就只占一份存储，这与「服务端只落一份」一致）。
 * 默认值 = 原来的全局默认（MTNODE_MAX_ACCOUNT_APP_BYTES / MTNODE_MAX_ACCOUNT_APPS）；
 * 单个用户可由管理员在管理平台单独改，且可设为**不限**（存 -1）。
 * 存量不追责：管理员把上限调小后，用户已存的东西不会被删，只是「不能再新增」。 */
function userQuotaLimitOf(user, key, dflt) {
  const q = user && user.quota && typeof user.quota === "object" ? user.quota : null;
  if (!q) return dflt;
  const v = Number(q[key]);
  if (!Number.isFinite(v) || v === 0) return dflt; /* 0 / 缺省 = 没单独设置 → 跟随全局默认 */
  if (v < 0) return -1; /* 显式 -1 = 不限 */
  return Math.max(1, Math.round(v));
}

/** 该用户当前的上限（对象形状直接下发给客户端 / 管理台）。 */
function appLimitsOf(user) {
  return {
    bytes: userQuotaLimitOf(user, "bytes", MAX_ACCOUNT_APP_BYTES),
    apps: userQuotaLimitOf(user, "apps", MAX_ACCOUNT_APPS),
    defaultBytes: MAX_ACCOUNT_APP_BYTES,
    defaultApps: MAX_ACCOUNT_APPS,
  };
}

/** 名下**全部**应用占的云端存储（包 + 截图 + 图标，截图按对象去重）。 */
function accountStorageBytes(userId) {
  let n = 0;
  for (const a of db.apps || []) {
    if (!a || a.userId !== userId) continue;
    n += appStoredBytes(a) + appShotObjectBytesOf(a) + appIconBytesOf(a.id, a.userId);
  }
  return n;
}

/** 客户端 / 管理台回显用的用量与上限：
 *  usedBytes / limitBytes（null = 不限）/ usedApps / appsLimit（null = 不限）。 */
function appStorageViewOf(user) {
  const lim = appLimitsOf(user);
  return {
    usedBytes: accountStorageBytes(user.id),
    limitBytes: lim.bytes < 0 ? null : lim.bytes,
    defaultBytes: lim.defaultBytes,
    apps: (db.apps || []).filter((a) => a && a.userId === user.id).length,
    appsLimit: lim.apps < 0 ? null : lim.apps,
    defaultApps: lim.defaultApps,
    /* 上架链路的两个**硬上限真源**（本轮需求：客户端上传前就能预检，不再「上传中卡住」）：
       uploadLimitBytes  = 一次上架请求最多能带多少字节（= MAX_BODY_APP_UPLOAD，与 nginx 同口径）；
       appZipLimitBytes  = 单个应用包（zip）上限（= MAX_APP_ZIP）。
       客户端拿它做本地预检；服务端与 nginx 的漂移由启动自检 nginxLimitAudit 单独告警。 */
    uploadLimitBytes: MAX_BODY_APP_UPLOAD,
    appZipLimitBytes: MAX_APP_ZIP,
  };
}

function fmtBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return v + "B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + "KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + "MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

/** 「不限」在文案里的说法（上限为 -1 / null 时统一走它）。 */
const QUOTA_UNLIMITED_TEXT = "不限";

/** 版本号比较：能拆成数字段的按数字比（1.10.0 > 1.9.0），否则退回字符串比较。 */
function compareVersions(x, y) {
  const a = String(x == null ? "" : x).split(/[.+-]/);
  const b = String(y == null ? "" : y).split(/[.+-]/);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const sa = a[i] == null ? "" : a[i];
    const sb = b[i] == null ? "" : b[i];
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? Number(sa) : null;
    const nb = /^\d+$/.test(sb) ? Number(sb) : null;
    if (na != null && nb != null) return na < nb ? -1 : 1;
    if (na != null) return 1; // 纯数字段优先于非数字段（1.0.1 > 1.0.0-beta）
    if (nb != null) return -1;
    return sa < sb ? -1 : 1;
  }
  return 0;
}

/**
 * 账号配额（服务端强制，**全部校验通过之后、落盘之前**调用；契约 §7.5）：
 *   · 云端存储总量（应用包 + 截图 + 图标，截图按内容去重）≤ 该用户的上限
 *     （缺省 = 全局默认 MAX_ACCOUNT_APP_BYTES；管理员可在管理平台给单个用户改，-1 = 不限）
 *   · 名下应用条数 ≤ 该用户的条数上限（同上，给已有应用追加版本不计入）
 * addBytes = 本次新增的字节（包 + 新图片）；replaceBytes = 本次会被覆盖掉的旧字节（追加版本传 0）；
 * newApp = 是否新建一条应用记录。返回 null 表示通过，否则返回要发的 {status, body}。
 * 上限为「不限」（-1 / null）时对应那条直接放行。
 */
function appQuotaError(userId, addBytes, replaceBytes, newApp) {
  const user = (db.users || []).find((u) => u.id === userId) || null;
  const lim = appLimitsOf(user || {});
  const add = Math.max(0, Math.round(Number(addBytes) || 0));
  const replace = Math.max(0, Math.round(Number(replaceBytes) || 0));
  if (newApp) {
    const used = (db.apps || []).filter((a) => a.userId === userId).length;
    if (lim.apps >= 0 && used >= lim.apps) {
      return {
        status: 413,
        body: {
          ok: false,
          code: "QUOTA_APPS",
          used: used,
          limit: lim.apps,
          error:
            "应用数量已达上限：" + used + " / " + lim.apps +
            " 个。请先删除不再上架的应用（给已有应用追加版本不计入上限）。",
        },
      };
    }
  }
  const used = accountStorageBytes(userId);
  if (lim.bytes >= 0 && used - replace + add > lim.bytes) {
    return {
      status: 413,
      body: {
        ok: false,
        code: "QUOTA_BYTES",
        used: used,
        limit: lim.bytes,
        error:
          "云端存储配额已满：已用 " + fmtBytes(used) + " / 上限 " + fmtBytes(lim.bytes) +
          "（本次还需 " + fmtBytes(add) + "）。请先删除旧版本、旧应用或多余的截图再上传。",
      },
    };
  }
  return null;
}

/** 声明没勾：400 DECLARATION_REQUIRED（三条写路径共用，落盘之前拦住，不留半成品）。 */
function declarationRequired(res) {
  return send(res, 400, {
    ok: false,
    code: "DECLARATION_REQUIRED",
    error:
      "上架 / 更新应用前必须勾选并接受声明（acceptDeclaration:true）：本人保证该应用符合中华人民共和国法律法规，" +
      "不含违法有害内容，不侵犯他人知识产权；因该应用产生的全部责任由上传者承担。",
  });
}

/** 声明留痕：往 db.appDeclarations[] 追加一条（数组不存在时初始化；ip 取 clientIp(req)）。 */
function recordAppDeclaration(req, user, id, version, action) {
  if (!Array.isArray(db.appDeclarations)) db.appDeclarations = [];
  db.appDeclarations.push({
    at: now(),
    userId: user.id,
    username: user.username || "",
    ip: clientIp(req),
    id,
    version: version || "",
    action,
  });
}

/** 一条版本记录（契约 §7.2）：落 apps[].versions[]，也是目录 versions[] 的来源。 */
function makeAppVersion(o) {
  return {
    version: o.version,
    parentVersion: o.parentVersion || "",
    bytes: o.buf.length,
    sha256: o.sha256,
    entry: o.entry || "index.html",
    note: String(o.note == null ? "" : o.note).trim().slice(0, MAX_VERSION_NOTE),
    uploader: o.user.username || "",
    uploaderId: o.user.id,
    createdAt: now(),
    declarationAt: now(),
  };
}

/** 包内入口页字段的兜底（目录条目 / 下载响应共用）。 */
function appEntryOf(a) {
  return (a && a.entry) || "index.html";
}

/**
 * 目录里的 `versions[]`（契约 §7.6）——**始终**给一份，客户端只有一条读路径：
 *   · 开关打开（记录里有 versions）→ 每版 `<id>/<version>.zip`（deploy.sh 把该目录装进静态目录）
 *   · 开关关闭 / 老记录 → 用单版字段合成一项，zipUrl 沿用老口径 `<id>.zip`
 *   · 版本被全删光（versions 存在但为空）→ 空数组（应用此刻没有可分发的包）
 */
function appCatalogVersions(a) {
  const owner = userById(a.userId);
  const fallbackUploader = owner ? owner.username || owner.id : a.userId;
  const fallbackUploaderName = accountDisplayNameOf(a.userId);
  const recs = appVersionRecords(a);
  if (!recs.length) {
    if (appHasVersionField(a)) return [];
    return [
      {
        version: a.version || "1.0.0",
        /* 老单版记录的包：优先这一分支的命名（发布时会把老镜像复制过去），没有就仍是 <id>.zip */
        zipUrl: appZipRel(a.id, a.userId),
        sha256: a.sha256 || "",
        bytes: Number(a.bytes) || 0,
        parentVersion: "",
        uploader: fallbackUploader,
        /* 上传者显示名（昵称，按 uid 实时解析）：老单版记录也能显示作者现在的昵称 */
        uploaderName: fallbackUploaderName,
        ownerId: a.userId,
        createdAt: a.createdAt,
        note: "",
      },
    ];
  }
  return recs.map((v) => ({
    version: v.version,
    zipUrl: appVersionZipRel(a.id, a.userId, v.version),
    sha256: v.sha256 || "",
    bytes: Number(v.bytes) || 0,
    parentVersion: v.parentVersion || "",
    uploader: v.uploader || fallbackUploader,
    /* 显示名按这一版的上传者 uid 实时解析（uploader 那份快照可能还是占位账号名） */
    uploaderName: accountDisplayNameOf(v.uploaderId || a.userId) || fallbackUploaderName,
    ownerId: a.userId,
    createdAt: v.createdAt,
    note: v.note || "",
    entry: v.entry || appEntryOf(a),
  }));
}

/** `GET /api/apps/:id/versions` 的版本项（契约 §7.4）：含 `current` = 是不是最新版。 */
function appVersionsPublic(a) {
  const owner = db.users.find((u) => u.id === a.userId);
  const fallbackUploader = owner ? owner.username || owner.id : a.userId;
  const fallbackUploaderName = accountDisplayNameOf(a.userId);
  const recs = appVersionRecords(a);
  if (!recs.length) {
    if (appHasVersionField(a)) return [];
    return [
      {
        version: a.version || "1.0.0",
        bytes: Number(a.bytes) || 0,
        sha256: a.sha256 || "",
        parentVersion: "",
        uploader: fallbackUploader,
        uploaderName: fallbackUploaderName,
        ownerId: a.userId,
        createdAt: a.createdAt,
        note: "",
        current: true,
      },
    ];
  }
  const latest = appLatestVersion(a);
  return recs.map((v) => ({
    version: v.version,
    bytes: Number(v.bytes) || 0,
    sha256: v.sha256 || "",
    parentVersion: v.parentVersion || "",
    uploader: v.uploader || fallbackUploader,
    uploaderName: accountDisplayNameOf(v.uploaderId || a.userId) || fallbackUploaderName,
    ownerId: a.userId,
    createdAt: v.createdAt,
    note: v.note || "",
    current: v.version === latest,
  }));
}

/** 某一版的包在盘上真正在哪：分支私有 → 老落点 `<id>/<版本>.zip`（同一 id 内共用，先到先得）。 */
function appVersionZipPathVia(id, ownerId, version) {
  const own = appBranchVersionZipPath(id, ownerId, version);
  if (fs.existsSync(own)) return own;
  const shared = appVersionZipPath(id, version);
  if (fs.existsSync(shared)) return shared;
  return "";
}

/** 找「某个版本」的包：先在这个 id 的各分支里找（owner hint 优先、主干其次），再兜镜像。
 *  返回 { path, version, sha256, bytes, entry, ownerId, fromVersionDir } 或 null。 */
function locateVersionZip(id, wantVersion, ownerHint) {
  const want = String(wantVersion || "").trim();
  const branches = appBranchesOf(id);
  const requested = appResolveOwnerId(ownerHint);
  const ordered = branches.slice().sort((x, y) => {
    const xs = requested && x.userId === requested ? 0 : 1;
    const ys = requested && y.userId === requested ? 0 : 1;
    if (xs !== ys) return xs - ys;
    return appBranchCmp(x, y);
  });
  for (const a of ordered) {
    /* 点名了分支（?owner=）：只在那一条分支里找，找不到就如实 404 ——
       绝不跨分支回退（那会把别人的包当成这条分支的这一版下发）。 */
    if (requested && a.userId !== requested) continue;
    const rec = appVersionRecords(a).find((v) => v.version === want) || null;
    const version = rec ? rec.version : appHasVersionField(a) ? "" : String(a.version || "");
    if (version !== want) continue;
    const p = appVersionZipPathVia(id, a.userId, want);
    if (p) {
      return {
        path: p,
        version: want,
        sha256: rec ? rec.sha256 || "" : a.sha256 || "",
        bytes: rec ? Number(rec.bytes) || 0 : Number(a.bytes) || 0,
        entry: (rec && rec.entry) || appEntryOf(a),
        ownerId: a.userId,
        fromVersionDir: true,
      };
    }
  }
  /* 该版本自己的包不在盘上：只有「这一版就是**指定的那条分支**的当前版」时才回退
     **这一分支自己的镜像**（`<id>__<作者uid>.zip`）—— 绝不用 appZipPathOfBranchVia 的
     全局镜像兜底（那是跨分支最高版，会静默把别人的包当成这一版下发）。 */
  const only = requested ? branches.filter((x) => x.userId === requested) : branches;
  for (const a of only) {
    if (appLatestVersion(a) !== want) continue;
    const own = appOwnerZipPath(id, a.userId);
    if (!fs.existsSync(own)) continue;
    const rec = appVersionRecords(a).find((v) => v.version === want) || null;
    return {
      path: own,
      version: want,
      sha256: rec ? rec.sha256 || "" : a.sha256 || "",
      bytes: rec ? Number(rec.bytes) || 0 : Number(a.bytes) || 0,
      entry: (rec && rec.entry) || appEntryOf(a),
      ownerId: a.userId,
      fromVersionDir: false,
    };
  }
  return null;
}

function locateAppZip(a, wantVersion) {
  const want = String(wantVersion == null ? "" : wantVersion).trim();
  if (want) return locateVersionZip(a.id, want, a.userId);
  /* 「这一支的当前版」：**先认这一支自己的包**（分支私有包 → 自己的镜像），找不到才退回老路径。
     不能反过来 —— 老路径把跨分支共享的 `<id>.zip` 顶在最前面，同号版本时会下发别人的包。 */
  const via = appZipPathOfBranchVia(a);
  if (via.path && via.via !== "legacy-mirror") {
    const latest = appLatestVersion(a);
    const rec = appVersionRecords(a).find((v) => v.version === latest) || null;
    return {
      path: via.path,
      version: latest || String(a.version || ""),
      sha256: rec ? rec.sha256 || "" : a.sha256 || "",
      bytes: rec ? Number(rec.bytes) || 0 : Number(a.bytes) || 0,
      entry: (rec && rec.entry) || appEntryOf(a),
      ownerId: a.userId,
      fromVersionDir: via.via === "branch" || via.via === "shared",
    };
  }
  return locateAppZipLegacy(a, want);
}

function locateAppZipLegacy(a, wantVersion) {
  const want = String(wantVersion == null ? "" : wantVersion).trim();
  const recs = appVersionRecords(a);
  const target = want || appLatestVersion(a);
  const rec = recs.find((v) => v.version === target) || null;
  /* 兜底（默认打开多版本后的必要退路）：**没有这一版自己的包时绝不 404 掉老包** ——
     包在盘上丢了（手工清目录 / 老单版记录升上来的那一版）而 <id>.zip 镜像还在，
     且要的就是它自己那版（want 为空 = 最新版，或 want === 记录的 version）时，
     退回镜像下发，与「合成 versions[] 声明 zipUrl = <id>.zip」的口径一致；
     要的是**别的**版本时仍走下面的 404 分支，不拿镜像冒充。 */
  if (appVersionsOn() && rec) {
    const vp = appVersionZipPath(a.id, rec.version);
    if (fs.existsSync(vp)) {
      return {
        path: vp,
        version: rec.version,
        sha256: rec.sha256 || "",
        bytes: Number(rec.bytes) || 0,
        entry: rec.entry || appEntryOf(a),
        fromVersionDir: true,
      };
    }
    const ownMirror = appZipPath(a.id);
    if ((!want || want === rec.version) && fs.existsSync(ownMirror)) {
      return {
        path: ownMirror,
        version: rec.version,
        sha256: rec.sha256 || "",
        bytes: Number(rec.bytes) || 0,
        entry: rec.entry || appEntryOf(a),
        fromVersionDir: false,
      };
    }
    if (want) return null;
  }
  // 指定了版本却拿不到「那一版自己的包」：只有「老单版记录（没有 versions）+ 要的就是它自己那版」
  // 允许退回镜像（契约的合成 versions[] 就是这么声明的），其余一律 404 —— 绝不拿别的版本充数。
  if (want && appVersionsOn() && (recs.length > 0 || want !== String(a.version || ""))) return null;
  const mirror = appZipPath(a.id);
  if (!fs.existsSync(mirror)) return null;
  return {
    path: mirror,
    version: a.version || target,
    sha256: a.sha256 || "",
    bytes: Number(a.bytes) || 0,
    entry: appEntryOf(a),
    fromVersionDir: false,
  };
}

/** 把静态目录里这个 id 的「老口径镜像」刷成**跨分支最高版**：老客户端 / 老链接要的 <id>.zip 仍下得动。
 *  只剩一个分支时它就是那个分支的最新版（与旧行为逐字一致）。 */
function syncAppZipMirrorGlobal(id) {
  const branches = appBranchesOf(id).filter((a) => appLatestVersion(a));
  if (!branches.length) return;
  const top = branches.reduce((best, a) =>
    compareVersions(appLatestVersion(a), appLatestVersion(best)) > 0 ? a : best,
  );
  const src = appZipPathOfBranchVia(top).path;
  if (!src) return;
  try {
    fs.copyFileSync(src, appZipPath(id));
  } catch {}
}

/** 刷这一分支自己的镜像 `<id>__<作者uid>.zip`（删版本后也走它）；这一分支没版本了就清掉它。
 *  同时把**老口径** `<id>.zip` 刷成跨分支最高版（旧链 / 老客户端仍要它）。 */
function syncAppZipMirror(a) {
  if (!a) return;
  if (appHasVersionField(a) && !appVersionRecords(a).length) {
    try { fs.unlinkSync(appOwnerZipPath(a.id, a.userId)); } catch {}
    syncAppZipMirrorGlobal(a.id);
    return;
  }
  /* 先把「这一版自己那份包」按分支口径补齐（老库里的包只有老落点 `<id>/<版本>.zip`），
     再刷镜像 —— 否则老库走一次删版本会把镜像刷成不存在。 */
  const cur = appLatestVersion(a);
  if (cur && !fs.existsSync(appBranchVersionZipPath(a.id, a.userId, cur))) {
    const from = appVersionZipPathVia(a.id, a.userId, cur);
    if (from) {
      try {
        mkdirp(path.join(appVersionDir(a.id), a.userId));
        fs.writeFileSync(appBranchVersionZipPath(a.id, a.userId, cur), fs.readFileSync(from));
      } catch {}
    }
  }
  const src = appZipPathOfBranchVia(a).path;
  if (src) {
    try {
      fs.writeFileSync(appOwnerZipPath(a.id, a.userId), fs.readFileSync(src));
    } catch {}
    /* 老口径镜像：我这条分支是跨分支最高版时才拿它刷（否则会盖掉更高版那一条） */
    if (appGlobalLatest(a.id) === cur) {
      try {
        fs.writeFileSync(appZipPath(a.id), fs.readFileSync(src));
      } catch {}
    }
  }
  syncAppZipMirrorGlobal(a.id);
}

/**
 * 应用条目统一字段口径 —— /api/apps* 与 /mtnode/apps/catalog.json **共用这一份**：
 * id / title / version / desc / icon / zipUrl / sha256 / owner 为主字段，
 * 另给 description / url 两个同义字段与 entry / tags / bytes / downloads / 时间戳，
 * 便于静态清单与客户端目录（apps-store.js parseCatalogDoc）两侧直接消费。
 * zipUrl 与 icon 都用**相对本目录**的写法（`<id>.zip` / `icons/<id>.<ext>`），客户端把它们
 * 解析到 http://mt-agent.com/mtnode/apps/ 下（apps-store.js 的 resolveZipUrl / appsIconUrl）。
 */
/**
 * 二次开发来源（fork，契约 §八 + §十）：应用身份 = **应用 id + 作者 uid**。
 * 两条形态都认：
 *   · 跨 id 的旧形态（源条目是另一个 id）；
 *   · **同 id 多分支**（本轮新增，q3）：forkOf.id === 自己的 id、ownerId = 主干作者 ——
 *     这正是「同 id 下上架我自己那条分支」的声明方式，**不再当自指丢弃**。
 * 写入口径（服务端唯一实现）：
 *   · 只认 { id, ownerId } 两个字段，id 走 normalizeAppId、ownerId 非空；
 *   · **不校验源条目是否还在**：作者删了自己的应用不该让别人后续版本永远传不上去 ——
 *     客户端在源不可见时显示「分支来源已不可见」即可；
 *   · 自指（forkOf.id === 自己的 id 且 ownerId === 自己）= 没意义，当没声明。
 */
function normalizeForkOf(raw, selfId, selfOwnerId) {
  if (!raw || typeof raw !== "object") return null;
  const id = normalizeAppId(raw.id);
  const ownerId = String(raw.ownerId || "").trim().slice(0, 64);
  if (!id || !ownerId) return null;
  if (selfId && id === selfId && (!selfOwnerId || ownerId === selfOwnerId)) return null;
  return { id, ownerId };
}

/* ─────────────────── 同 id 多分支（本轮契约，docs/apps-market.md §十） ───────────────────
 * 应用身份 = **应用 id + 作者 uid**（q1）：同一个 id 下允许不同作者各占**一条分支**
 * （同 id 同作者只有一条，q15），主干 = createdAt 最早的那条（q20，只作展示与声明锚点，
 * 主干删光版本不影响其他分支，q27）。
 * 旧模型（不同 id 各自一条 + forkOf 指回源）**数据与字段一律保留**：forkOf 的
 * 写入口径、appForkOfPublic 的展示口径都一个字不变，上一轮上架的旧记录照旧能读能传。
 * ------------------------------------------------------------------------- */

/** 上传者账号名（找不到用户时用 uid 本身）——目录 / 版本项的 `owner` / `uploader` 口径。
 *  ⚠ 这是**账号名**（可能还是自动占位名），只作内部比对与 ?owner= 寻址用；
 *  界面要显示给用户的名字一律取 `ownerName` / `uploaderName`（见 accountDisplayNameOf）。 */
function appOwnerNameOf(userId) {
  const u = db.users.find((x) => x.id === userId);
  return u ? String(u.username || u.id) : String(userId || "");
}

/* ---------- 作者显示名（用户共识：界面显示昵称，不再显示 uid / 占位账号名） ---------- *
 * 现场：微信 / 手机号扫码自动建号时，account-store 会给一个 `u_xxxxxxxx` 的占位账号名，
 * 作者显示名于是变成 uid 样的字符串（例：sudoku 第二条分支 owner=`u_f2bea279`，真昵称是
 * 「Tester」）——「版本选择」里看到 uid 就是这个原因。
 *
 * 口径：
 *   · 显示名 = 账号昵称，**按 uid 实时解析**：作者改一次昵称，目录 / 接口 / 历史版本行处处同步；
 *   · 昵称为空才回落账号名，且**系统自动占位名**（`u_` + 十六进制、且没有密码）不算名字；
 *   · 两者都没有 → 空串（客户端显示「未知作者」）。
 *
 * 字段：**新增** `ownerName` / `uploaderName` 承载显示名；`owner` / `uploader` 保持账号名语义不变
 * （客户端 appsSameAuthor 的「同作者」判定与 ?owner= 下载寻址都按它比对，改成会变的昵称会让
 * 老安装账本把同一个作者判成两个人）。管理台 `adminContentRowOf` 里那个 `ownerName` 是**另一份**
 * 序列化（账号名，给管理台用），与本节的显示名不是一回事。
 * ------------------------------------------------------------------------------------ */

/** 系统自动占位账号名（account-store.mjs 的 newPlaceholderUsername：`u_` + 4 字节十六进制）。 */
const PLACEHOLDER_USERNAME_RE = /^u_[0-9a-f]{6,24}$/i;
function isPlaceholderUsername(u) {
  if (!u) return true;
  const name = String(u.username || "");
  if (!name) return true;
  if (u.pass) return false; // 有密码 = 用户自己注册的账号名，永远算真名
  return PLACEHOLDER_USERNAME_RE.test(name);
}

/** 账号显示名：uid → 昵称 → 非占位账号名 → 空串。 */
/** userId → user 的短 TTL 索引（原来每个目录条目都 db.users.find 扫一遍：1200 条 = 1200×24 次比较）。 */
const _userIndex = { at: 0, map: null };
function userById(userId) {
  const t = now();
  if (!_userIndex.map || t - _userIndex.at > 1000) {
    const map = new Map();
    for (const u of db.users || []) map.set(String(u.id || ""), u);
    _userIndex.map = map;
    _userIndex.at = t;
  }
  return _userIndex.map.get(String(userId || "")) || null;
}

function accountDisplayNameOf(userId) {
  const u = userById(userId);
  if (!u) return "";
  const nick = String(u.nickname || "").trim();
  if (nick) return nick;
  return isPlaceholderUsername(u) ? "" : String(u.username || "").trim();
}

/** 分支排序（主干判定与展示顺序）：createdAt 早的在前；同刻按 id 串稳定比较。 */
function appBranchCmp(x, y) {
  const d = (Number(x && x.createdAt) || 0) - (Number(y && y.createdAt) || 0);
  if (d) return d;
  return String((x && x.userId) || "") < String((y && y.userId) || "") ? -1 : 1;
}

/** 某个 id 下的全部分支（按 createdAt 早的在前；调用方按需要自己滤）。 */
function appBranchesOf(id) {
  const want = String(id || "");
  if (!want) return [];
  return (db.apps || []).filter((a) => a && a.id === want).sort(appBranchCmp);
}

/** 主干（最早创建的那条）：库里留下的每条分支都在线上，所以直接在全部里取第一条。 */
function appTrunkOf(id) {
  const list = appBranchesOf(id);
  return list.length ? list[0] : null;
}

/** 某个作者在这个 id 下的分支（同 id 同作者只有一条）。 */
function appBranchOfOwner(id, ownerId) {
  const want = String(ownerId || "");
  if (!want) return null;
  return (db.apps || []).find((a) => a && a.id === String(id || "") && a.userId === want) || null;
}

/* ─────────────────── 应用家族（打赏 · 评论 · 分支树的统一归组口径） ───────────────────
 * 用户口径（本轮共识）：
 *   · 「只要基于一个应用开发都应当是同一个 id」+「允许作者自己填 id，填同 id 就自动当分支」；
 *   · 分支树是**多层**的：谁基于谁开发就挂在谁下面（forkOf = { id, ownerId } 只认这两个字段）；
 *   · 打赏与评论/评分**按根应用统一**：一个应用族里的所有分支共用一个累计口径；
 *   · 存量里「另一个 id + forkOf 指回源」的旧条目，也算同一个家族（迁移脚本会把它们改成同 id）。
 *
 * 家族 = 从某一条应用记录出发，沿 `forkOf { id, ownerId }` 双向闭包（父往子、子往父）得到的一批记录。
 * 根（主干）= 沿父链走不到「同族内更早的条目」的那一条；它的 id 就是家族的归组 id。
 * 这里同时兼容两种写法，保证旧数据也能正确归组：
 *   · 老形态：`forkOf = { id: <源 id>, ownerId: <源作者 uid> }`（跨 id 或同 id 都认）；
 *   · 新形态：同 id 多分支（`forkOf.id === 自己的 id`、`ownerId` = 基于哪条分支的作者）。
 * ------------------------------------------------------------------------------------ */

/** 一条应用记录能被谁指到（自己的 id / id+作者 / 家族归组 id 等）。 */
function appAliases(a) {
  if (!a || !a.id) return [];
  const out = [String(a.id)];
  if (a.userId) out.push(a.id + "\u0000" + String(a.userId));
  const f = normalizeForkOf(a.forkOf, a.id, a.userId);
  if (f) {
    out.push(String(f.id));
    out.push(String(f.id) + "\u0000" + String(f.ownerId));
  }
  return out;
}

/** 家族闭包：跨 id 的旧条目也收进来（沿 forkOf 双向可达）。 */
/* 家族 alias 索引的缓存（本轮 1000 条场景的性能主因）：
   原来 appFamily() 每次调用都重扫全量 apps、给每条算一遍 appAliases 建 Map ——
   一次目录组装里被调 3×1200 次，等于 O(N²)（1200 条实测 4.5 秒）。
   现在按「集合签名」缓存：条数 + 最新 updatedAt/createdAt 没变就直接复用。
   签名变了（新增 / 改 / 删了应用）才重建 —— 判定成本 O(N) 且没有字符串拼装。 */
let _aliasIdx = { sig: "", idx: new Map(), apps: [] };
function appsSig() {
  const arr = db.apps || [];
  let n = 0;
  let maxT = 0;
  for (const a of arr) {
    if (!a || !a.id) continue;
    n++;
    const t = Number(a.updatedAt || a.createdAt || 0) || 0;
    if (t > maxT) maxT = t;
  }
  return n + ":" + maxT;
}
function appAliasIndex() {
  const sig = appsSig();
  if (_aliasIdx.sig === sig) return _aliasIdx;
  const apps = (db.apps || []).filter((a) => a && a.id);
  const idx = new Map();
  for (const a of apps) {
    for (const alias of appAliases(a)) {
      if (!idx.has(alias)) idx.set(alias, []);
      idx.get(alias).push(a);
    }
  }
  _aliasIdx = { sig: sig, idx: idx, apps: apps };
  return _aliasIdx;
}

function appFamily(id, ownerId) {
  const cache = appAliasIndex();
  const apps = cache.apps;
  const wantId = String(id || "");
  const wantOwner = String(ownerId || "");
  if (!wantId) return [];
  let seed = null;
  if (wantOwner) seed = apps.find((a) => a.id === wantId && String(a.userId || "") === wantOwner) || null;
  if (!seed) seed = apps.find((a) => a.id === wantId) || null;
  if (!seed) return [];
  const idx = cache.idx;
  const seen = new Set([seed]);
  const out = [seed];
  const queue = [seed];
  while (queue.length) {
    const cur = queue.shift();
    const next = [];
    for (const alias of appAliases(cur)) {
      for (const a of idx.get(alias) || []) next.push(a);
    }
    for (const a of next) {
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(a);
      queue.push(a);
    }
  }
  return out;
}

/** 家族内每条记录的父：`forkOf` 指到的那条（同 id 多作者时取最早创建的那一条；自指 / 指不到 = 无父）。 */
function appParentOf(a) {
  const f = normalizeForkOf(a && a.forkOf, String((a && a.id) || ""), String((a && a.userId) || ""));
  if (!f) return null;
  const cands = (db.apps || []).filter(
    (x) => x && String(x.id) === f.id && String(x.userId || "") === f.ownerId,
  );
  if (!cands.length) return null;
  return cands.reduce((best, x) => (appBranchCmp(x, best) < 0 ? x : best), cands[0]);
}

/** 家族根条目（原作者那条；null = 找不到）。
 *  两条判据按序取：
 *    ① **单父优先** —— 「没有任何条目声明基于它」的那几条才是根候选（原创）；
 *    ② 候选多于一条时取 createdAt 最早的那条（同刻再按 uid 稳定比较）。
 *  为什么不能只看 createdAt：同一秒内连续上架时时间戳可能撞在一起，那样会把某条分支
 *  误判成根（真出现过：A、B、C 同刻上架时根算到了 B 头上）。
 *  脏数据（互相声明基于对方成环）由访问集合兜底：退回起点，绝不空转。 */
function appFamilyRootOf(id, ownerId) {
  const fam = appFamily(id, ownerId);
  if (!fam.length) return null;
  const inFam = new Set(fam);
  const parents = new Map();
  for (const a of fam) {
    const p = appParentOf(a);
    parents.set(a, p && inFam.has(p) && p !== a ? p : null);
  }
  const rootOf = (a) => {
    const seen = new Set([a]);
    let cur = a;
    for (let i = 0; i < fam.length + 1; i++) {
      const p = parents.get(cur);
      if (!p || seen.has(p)) return cur;
      seen.add(p);
      cur = p;
    }
    return cur;
  };
  const roots = Array.from(new Set(fam.map(rootOf)));
  const referenced = new Set();
  for (const a of fam) {
    const p = parents.get(a);
    if (p) referenced.add(p);
  }
  const singles = roots.filter((r) => !referenced.has(r));
  return (singles.length ? singles : roots).reduce((best, x) =>
    appBranchCmp(x, best) < 0 ? x : best,
  );
}

/** 家族根条目的 ownerId（**主干判定的真口径**：同 id 多分支时所有条目 id 相同，
 *  只有作者 uid 能区分谁是根，所以 trunk 判据必须是 uid 而不是 id）。 */
function appFamilyRootOwnerId(id, ownerId) {
  const root = appFamilyRootOf(id, ownerId);
  return root ? String(root.userId || "") : "";
}

/** 家族的归组 id（根条目的 id）。
 *  同 id 多分支下所有条目 id 相同，所以这个值对全族是同一个 —— 客户端按它合并卡片、
 *  打赏 / 评论按它统计。根条目的**作者**见 appFamilyRootOwnerId。 */
function appFamilyGroupId(id, ownerId) {
  const fam = appFamily(id, ownerId);
  if (!fam.length) return "";
  const rootOwner = appFamilyRootOwnerId(id, ownerId);
  const hit = fam.find((a) => String(a.userId || "") === rootOwner);
  return String((hit && hit.id) || fam[0].id || "");
}

/** 家族里的全部分支（**同一应用族**：同 id 的分支 + 跨 id 但 forkOf 指回本族的旧条目）。 */
function appFamilyEntries(id, ownerId) {
  return appFamily(id, ownerId).slice().sort(appBranchCmp);
}

/** 一条记录的父分支作者 uid（客户端画多层树用）：父找不到时回空串。 */
function appParentOwnerOf(a) {
  const f = normalizeForkOf(a && a.forkOf, String((a && a.id) || ""), String((a && a.userId) || ""));
  if (!f) return "";
  const p = appParentOf(a);
  if (p) return String(p.userId || "");
  /* 父条目已删而看不到：仍如实回报声明的 ownerId（客户端显示「分支来源已不可见」）。 */
  return String(f.ownerId || "");
}

/** 某 id 下跨分支的最高版本号（老口径 `<id>.zip` 镜像指向它；空 = 没有任何版本）。 */
function appGlobalLatest(id) {
  let best = "";
  for (const a of appBranchesOf(id)) {
    const v = appLatestVersion(a);
    if (v && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/** owner 参数（uid 或账号名）→ uid；认不出来回空串。 */
function appResolveOwnerId(raw) {
  const want = String(raw == null ? "" : raw).trim();
  if (!want) return "";
  const u = db.users.find((x) => x.id === want || String(x.username || "") === want);
  return u ? u.id : want;
}

/**
 * 解析「这个 id 的哪一条分支」——所有 /api/apps/<id>* 路由的**唯一**解析口。
 * ownerHint：?owner=<uid|账号名>、body.ownerId，或 file/icon 想指定的分支作者。
 * 规则：认得出就用它（该分支存在才认）；认不出 / 没传 → 主干。
 * 返回 { app, trunk, branches, ownerId, requested }；找不到任何一条时 app = null。
 */
function appResolveBranch(id, ownerHint) {
  const branches = appBranchesOf(id);
  const trunk = branches.length ? branches[0] : null;
  const requested = appResolveOwnerId(ownerHint);
  let app = null;
  if (requested) app = branches.find((a) => a.userId === requested) || null;
  if (!app) app = trunk;
  return { app: app, trunk: trunk, branches: branches, ownerId: app ? app.userId : "", requested: requested };
}

/** 对外形态（目录条目 / 接口条目共用）：补上源作者的 username 供界面显示。 */
function appForkOfPublic(a) {
  const f = a && a.forkOf;
  if (!f || typeof f !== "object") return null;
  const id = String(f.id || "").trim().toLowerCase();
  const ownerId = String(f.ownerId || "").trim();
  if (!id || !ownerId) return null;
  const u = db.users.find((x) => x.id === ownerId);
  return { id, ownerId, owner: u ? String(u.username || "") : "", ownerName: accountDisplayNameOf(ownerId) };
}
/** 某分支某一版的静态包名，**优先新命名、文件不在盘上就回退它实际占着的老命名**。
 *  两处都查：静态目录（发布落点）与数据目录（接口直下用的落点）—— 客户端对外看到的
 *  `e.versions[].zipUrl` / `e.zipUrl` 必须指到真能下到的那个文件（q12：老文件保留不迁）。 */
function appZipRelOf(id, ownerId, version) {
  const rel = version ? appVersionZipRel(id, ownerId, version) : appZipRel(id, ownerId);
  const inWeb = (r) => fs.existsSync(path.join(APPS_WEB_DIR, ...r.split("/")));
  if (inWeb(rel)) return rel;
  const inData = (r) => fs.existsSync(path.join(APP_DIR, ...r.split("/")));
  if (inData(rel)) return rel;
  if (version) {
    const legacyRel = id + "/" + version + ".zip";
    if (inWeb(legacyRel) || inData(legacyRel)) return legacyRel;
  }
  const legacyZip = id + ".zip";
  if (inWeb(legacyZip) || inData(legacyZip)) return legacyZip;
  return rel;
}

/** 一条分支的「当前版包名」：新命名 `<id>__<作者uid>.zip` 优先；老库只有 <id>.zip 时回退它。 */
function appBranchZipRelOf(id, ownerId) {
  const rel = appZipRel(id, ownerId);
  /* 用目录索引判「在不在」（见 dirIndex 的注释）：这里每个条目都要问 2~4 次，
     1000 条目录就是几千次 existsSync。静态目录与数据目录都用 basename 直接查。 */
  const inWeb = (r) => dirHasFile(APPS_WEB_DIR, path.basename(r));
  const inData = (r) => dirHasFile(APP_DIR, path.basename(r));
  if (inWeb(rel) || inData(rel)) return rel;
  const legacy = id + ".zip";
  if (inWeb(legacy) || inData(legacy)) return legacy;
  return rel;
}

/** 图标静态相对地址：新命名优先、老命名兜底（同 appZipRelOf 的口径）。 */
function appIconRelOf(id, ownerId) {
  return appIconRel(id, ownerId) || appIconRel(id);
}

/** 静态目录条目筛选后的排序：**id 升序 + 同 id 内主干在前**（客户端按 id 合并成一张卡，q21）。 */
function appCatalogSort(list) {
  return list
    .slice()
    .sort((x, y) => {
      const dx = String(x.id || "").localeCompare(String(y.id || ""), "en");
      if (dx) return dx;
      return appBranchCmp(x, y);
    });
}

/** 一条分支对外形态（`branches[]` 用，契约 §十 + 本轮多层树）：作者 / 版本 / 父分支 / 这一分支的包。 */
function appBranchEntry(a) {
  const owner = db.users.find((u) => u.id === a.userId);
  const rootId = appFamilyGroupId(a.id, a.userId) || a.id;
  const rootOwner = appFamilyRootOwnerId(a.id, a.userId) || String(a.userId || "");
  return {
    id: a.id,
    ownerId: a.userId,
    owner: owner ? String(owner.username || owner.id) : String(a.userId || ""),
    nickname: owner ? String(owner.nickname || "") : "",
    /* 分支作者显示名（= 昵称；上面 owner / nickname 保持原义，客户端显示统一读它） */
    ownerName: accountDisplayNameOf(a.userId),
    title: a.title || a.id,
    /* 版本树已空（版本被删光）→ 空串，不留残留 version（见 appCurrentVersionOf） */
    version: appCurrentVersionOf(a),
    latestVersion: appLatestVersion(a),
    versions: appCatalogVersions(a),
    bytes: a.bytes || 0,
    zipUrl: appBranchZipRelOf(a.id, a.userId),
    icon: appIconRelOf(a.id, a.userId),
    sha256: a.sha256 || "",
    /* trunk = 家族根条目（原作者那条）；parentOwnerId = 它基于哪条分支开发（多层树的父节点）。
       两者都由家族口径算出来，客户端直接按 parentOwnerId 挂树，不必自己猜。
       判据用**作者 uid**：同 id 多分支下所有条目的 id 相同，只有 uid 能区分谁是根。 */
    trunk: rootOwner === String(a.userId || ""),
    familyRootId: rootId,
    familyRootOwnerId: rootOwner,
    parentOwnerId: appParentOwnerOf(a),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** 把一个应用族串成树（`branches[]`）：**整个家族**（同 id 的各作者分支 + 跨 id 但 forkOf
 *  指回本族的条目都在内），每条带 trunk / parentOwnerId —— 客户端按它画多层分支树。
 *  根条目自己 parentOwnerId 为空。 */
function appBranchViewOf(id, viewer) {
  const branches = appFamilyEntries(id, "");
  return branches.map((a) =>
    Object.assign(appBranchEntry(a), {
      mine: !!(viewer && viewer.id === a.userId),
      canDelete: !!(viewer && (viewer.id === a.userId || isAdmin(viewer))),
      forkOf: appForkOfPublic(a),
    }),
  );
}

/** 分支的 forkOf 公开形态：`branches[]` 直接出**声明过的**那一份（见 appForkOfPublic）。
 *  ⚠️ 旧版这里叫 appForkOfTrunkOf（把每条分支的 forkOf 都指向主干）—— 本轮改成
 *  「谁基于谁就指谁」，多层树的父子关系才连得起来；那个函数已随本轮删除，不留死代码。 */

/**
 * 上传新版本时的标签继承（用户口径：**上传新版本继承原版标签**）。
 *
 * 现场：上架窗打开时标签输入框是空的，用户不手填就等于把空标签发给服务端 ——
 * 改前 `tags: []` 会把线上标签**清空**（`a.tags = []`），作者一追加版本就丢掉整组标签。
 * 规则（服务端兜底，客户端还会开窗带回原标签，两层一起保）：
 *   · 解析后**非空** → 用这一份（用户真填了新标签）；
 *   · 解析后**为空 / 没带这个字段** → 保留应用原有标签，一个都不动。
 * 代价是没有任何路径能把标签改成空（只能换成别的标签）——这是与用户确认过的取舍：
 * 宁可「清不掉」，也不要「一追加版本就悄悄清掉」。
 *
 * @param {*} input 请求体里的 tags（数组或逗号分隔字符串；null/undefined 也算没填）
 * @param {string[]} cur 应用当前标签
 * @returns {string[]} 要写回应用的标签
 */
function appTagsNext(input, cur) {
  const next = parseTags(input);
  if (next.length) return next;
  return Array.isArray(cur) ? cur.slice() : [];
}

function appCatalogEntry(a) {
  const owner = userById(a.userId);
  const zipUrl = appBranchZipRelOf(a.id, a.userId);
  const rootId = appFamilyGroupId(a.id, a.userId) || a.id;
  /* 家族根那条的作者：**trunk 判据只能用 uid** —— 同 id 的多条分支 id 全相同，
     拿 id 比会把每一条都判成根（真踩过：三作者三条分支同时被标成 trunk）。 */
  const rootOwner = appFamilyRootOwnerId(a.id, a.userId) || String(a.userId || "");
  return {
    id: a.id,
    /* 同 id 多分支（契约 §十）：条目自带作者 uid，客户端按 id 归组、按 ownerId 指定分支下载 */
    ownerId: a.userId,
    /* 应用家族（本轮需求：分支树统一、打赏/评论按根应用统一）：
       familyRootId = 家族归组 id（= 根条目的 id，客户端卡片按它合并）；trunk=true 表示这条是根。 */
    familyRootId: rootId,
    trunk: rootOwner === String(a.userId || ""),
    familyRootOwnerId: rootOwner,
    parentOwnerId: appParentOwnerOf(a),
    title: a.title,
    /* 版本树已空（版本被删光）→ 空串，不留残留 version（见 appCurrentVersionOf） */
    version: appCurrentVersionOf(a),
    // 多版本字段（契约 §7.6）：**始终**给 latestVersion / versions[]，
    // 开关关闭时 versions[] 是单版合成项（zipUrl 仍为 <id>.zip），客户端只有一条读路径。
    latestVersion: appLatestVersion(a),
    versions: appCatalogVersions(a),
    desc: a.description || "",
    description: a.description || "",
    icon: appIconRelOf(a.id, a.userId),
    /* 封面缩略图（卡片 16:9 背景图）在静态目录里的相对地址：与 icon 同一个 icons/ 目录，
       **源 = 上架截图第 1 张**（没有截图才退回图标）：icons/<主干>__shot.png / icons/<主干>.png。
       **能生成才给**（appThumbOf 现生成 / 命中缓存），给不出就留空让客户端退回 icon ——
       不下发一个会 404 的地址。 */
    thumb: appCoverThumbRelOf(a),
    /* 封面来源（客户端据此推导 / 兜底）："shot" = 上架截图第 1 张，"icon" = 图标。
       与 coverVer（源文件 mtime 秒）一起下发：换截图 / 换图标立刻换地址，绕开 HTTP 缓存。 */
    coverSource: appCoverShotOf(a.id, a.userId) ? "shot" : appIconPath(a.id, a.userId) ? "icon" : "",
    coverVer: appCoverVer(a),
    /* 上架截图（多图）：相对静态目录的 shots/<主干>/<n>.<ext> 数组，顺序 = 作者排的顺序，
       第 1 张同时是封面来源（客户端卡片仍用 thumb 兜 icon）。空数组 = 没有截图。
       shotsThumb[] 是**同一批图的小图**（长边 1280，懒生成）：列表只下它，详情才下 shots[] ——
       这是「图片缓存」省服务器流量的另一半（列表页不再逐张拉 2560 原图）。
       小图生成不了 / 原图本来就小 → 对应位置给 ""，客户端退回用 shots[i]，绝不 404。 */
    shots: appShotRelsOf(a.id, a.userId),
    shotsThumb: appShotListRelsOf(a),
    /* 这一批截图的内容哈希（内容寻址图片库的名字）：客户端拿它做「这张图云端已经有了」的
       判定，下次上架同一张图只发一个 {sha} 引用、不发字节。旧数据可能为空数组。 */
    shotsSha: appShotEntriesOf(a.id, a.userId, a).map((e) => e.sha),
    zipUrl: zipUrl,
    url: zipUrl,
    sha256: a.sha256 || "",
    owner: owner ? (owner.username || owner.id) : a.userId,
    /* 作者显示名（昵称，按 uid 实时解析）——界面一律用它；没有名字时为空串（客户端显示「未知作者」） */
    ownerName: accountDisplayNameOf(a.userId),
    /* 二次开发来源（可选；原创不出现这个字段）：{ id, ownerId, owner } —— 契约 §八 */
    forkOf: appForkOfPublic(a),
    entry: a.entry || "index.html",
    tags: Array.isArray(a.tags) ? a.tags : [],
    bytes: a.bytes || 0,
    downloads: a.downloads || 0,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** 接口回给客户端 / 管理侧的完整条目 = 统一字段 + 归属与权限标记。 */
function publicApp(a, viewer, en) {
  const viewerId = viewer && viewer.id;
  const owner = db.users.find((u) => u.id === a.userId);
  return withEnrich(Object.assign({}, appCatalogEntry(a), {
    ownerUser: owner
      ? { id: owner.id, username: owner.username, nickname: owner.nickname }
      : { id: a.userId, username: "", nickname: "" },
    hasIcon: !!appIconPath(a.id, a.userId),
    mine: !!(viewerId && viewerId === a.userId),
    canDelete: !!(viewerId && (viewerId === a.userId || isAdmin(viewer))),
    // 同 id 的其他作者分支（含主干）：客户端据此画分支树与「作者 ▾」下拉（契约 §十）
    branches: appBranchViewOf(a.id, viewer),
  }), "app", a.id, en, a.userId);
}

/** 静态目录文档：把这份 JSON 原样写到 /var/www/mtnode/apps/catalog.json 即是线上目录。
 *  同 id 的多个作者分支**各占一条**（id 升序、同 id 内主干在前），客户端按 id 合并成一张卡。
 *
 *  条目另带**公开打赏汇总** `tips:{count,totalYuan}`：目录是客户端列表的主来源（静态文件），
 *  接口那份（publicApp）本来就有 tips，目录少了它就出现「线上明明有人打赏、卡片悬停却说
 *  还没有人打赏」的错报。整份目录一次遍历 db.tips 算齐（batchSummaryOf，不是逐个对象查表）。 */
/* 打赏汇总的短 TTL 缓存：plans.enricher 会为每个 id 现算 {count,totalYuan}（1000+ 条时
   每次组目录都要算一遍，是「一次应用变更 P95」里除文件拷贝外的主要 CPU）。
   300ms 内复用同一份 —— 窗口内多次组目录（一次发布里会组两三次：目录 + 静态计划 + 落盘）
   只算一次；打赏本身会触发 publishStaticApps，回执里的数字仍是当场算的（不会读到旧值）。
   口径：TTL 只影响「同一毫秒级窗口内重复计算」，不影响任何一次真实变更后的可见结果。 */
const _tipCache = { at: 0, ids: "", map: null };
function appCatalogTips(ids) {
  const key = ids.join(",");
  const t = now();
  if (_tipCache.map && _tipCache.ids === key && t - _tipCache.at < 300) return _tipCache.map;
  const fn = plans.enricher("app", ids);
  const map = new Map();
  for (const id of ids) map.set(id, fn(id));
  _tipCache.at = t;
  _tipCache.ids = key;
  _tipCache.map = map;
  return map;
}

/* 目录文档的进程内记忆（本轮 1000 条场景：一次组装 = 遍历全部条目 + tips 汇总 + 序列化，
   1200 条实测 200~500ms）。它被「每次目录请求」与「每次静态目录发布」调用，重复组装纯属白烧 CPU。
   失效判据两条，任一满足就重算：
     · appCatalogBump 变了（任何写库路径都会 bump，见 saveDb）；
     · 距上次组装 > 2000ms（兜底：万一有写路径没经过 saveDb，最多旧 2 秒 —— 客户端本身还有 60s 缓存，
       且唯一会读目录的接口就是 /api/apps/catalog；留这个窗口是为了让「连续请求」始终命中同一份文档，
       从而复用它的序列化 / gzip 结果，见 encodeJsonDoc）。
   注意：这不是「缓存回执」，返回的仍是当场按库算出来的对象，只是同一窗口内不重复算。 */
/* appCatalogBump / _catalogMemo 的**声明在 saveDb 上方**（那里有 TDZ 现场说明）：
   启动期的 saveDb() 就会碰它们，声明必须早于任何可能写库的代码。 */
function bumpAppCatalog() {
  appCatalogBump++;
}

function appCatalogDoc() {
  const _t = now();
  if (_catalogMemo.doc && _catalogMemo.bump === appCatalogBump && _t - _catalogMemo.at < 2000) return _catalogMemo.doc;
  const doc = appCatalogDocUncached();
  _catalogMemo = { at: _t, bump: appCatalogBump, doc: doc };
  return doc;
}

function appCatalogDocUncached() {
  /* 两态口径（本轮）：库里的应用就是在线上 —— 目录按整库现算，没有任何可见性过滤 */
  const rows = appCatalogSort(db.apps || []);
  const tipMap = appCatalogTips(rows.map((a) => a.id));
  const apps = rows.map((a) => Object.assign(appCatalogEntry(a), { tips: tipMap.get(a.id) || { count: 0, totalYuan: 0 } }));
  /* updatedAt 必须**只随内容变**（它是 ETag 的来源）：取目录里最新的那条 updatedAt，
     绝不用 now() —— 后者会让同一份目录每次调用都算出不同字节，条件请求（304）永远命中不了。 */
  let stamp = 0;
  for (const r of rows) {
    const t = Number(r.updatedAt || r.createdAt || 0) || 0;
    if (t > stamp) stamp = t;
  }
  return {
    version: 1,
    updatedAt: new Date(stamp || now()).toISOString(),
    feed: "http://mt-agent.com/mtnode/apps",
    apps: apps,
  };
}

/* ---------- 静态目录发布（单一真源：接口变更 → 立即落盘） ---------- *
 * 客户端（apps-store.js）读的是**静态文件** <MTNODE_APPS_URL>/catalog.json，
 * 而接口（POST / PATCH / 版本 / 删除）只改 db.json 与 DATA_DIR。
 * 两份各自手写必然漂移 —— 曾经就把线上目录刷成 120 字节的 apps:[] 空清单，
 * 客户端表现为「应用库未连入云端」。所以这里把落盘收成一条路径：
 *   appCatalogDoc() 原子写 catalog.json（tmp + rename），
 *   每个条目的 zip 与图标按静态布局（<id>.zip / <id>/<version>.zip / icons/<id>.<ext>）同步，
 *   上一次发布写下、这一次不再需要的文件按清单清掉（只删清单里记着的，绝不动别人的文件）。
 * 任何一步失败都只记日志 + 返回错误，绝不回滚业务数据（库与接口仍然可用），
 * 但会自动把静态目录切到「接口目录」以保证客户端仍能列出应用（见 publishStaticApps）。
 * ------------------------------------------------------------------ */

/**
 * 静态目录布局：按当前 db 算出要写的每个文件（相对静态目录）。
 * 返回值 { doc, entries:[{id,rel,src,bytes}], managed:[相对路径], missing:[{id,reason}] }。
 * 纯只读计算，不落盘 —— 供发布与自检共用（自检可以只算不写）。
 */
function appStaticPlan() {
  const _t0 = Date.now();
  const doc = appCatalogDoc();
  const _tDoc = Date.now();
  const entries = [];
  const managed = [APPS_WEB_MANIFEST, "catalog.json"];
  const missing = [];
  const seen = new Set(); /* 同 id 多分支：一个静态路径只登记一次（同号版本共用老落点时会出现） */
  const push = (id, rel, src) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    entries.push({ id: id, rel: rel, src: src, bytes: fs.statSync(src).size });
    managed.push(rel);
  };
  for (const e of doc.apps) {
    /* doc.apps 里同 id 可能有多条（每个作者分支一条），这里按 ownerId 找到**那一条** */
    const a = (db.apps || []).find((x) => x.id === e.id && x.userId === e.ownerId);
    if (!a) continue;
    // 这一分支当前版的镜像：<id>__<作者uid>.zip（新命名）
    const ownMirror = appOwnerZipPath(a.id, a.userId);
    if (fs.existsSync(ownMirror)) push(a.id, appZipRel(a.id, a.userId), ownMirror);
    // 老口径镜像 <id>.zip：老客户端 / 老链接仍要它（内容 = 跨分支最高版）
    const mirror = appZipPath(a.id);
    if (fs.existsSync(mirror)) push(a.id, a.id + ".zip", mirror);
    // 多版本：每一版写自己那一份（新命名 <id>/<作者uid>/<版本>.zip；与老落点共用时不重复写）
    for (const v of appVersionRecords(a)) {
      const wantRel = appVersionZipRel(a.id, a.userId, v.version);
      const src = appVersionZipPathVia(a.id, a.userId, v.version);
      if (src) {
        const legacyRel = a.id + "/" + v.version + ".zip";
        const rel = src === appVersionZipPath(a.id, v.version) ? legacyRel : wantRel;
        push(a.id, rel, src);
        /* 同一版的老落点也留一份（catalog 里回退命名时会指到它），只有它已经就是 src 时才不重复 */
        if (rel !== wantRel && fs.existsSync(appVersionZipPath(a.id, v.version))) {
          push(a.id, legacyRel, appVersionZipPath(a.id, v.version));
        }
      } else {
        missing.push({ id: a.id, reason: "缺少版本包 " + wantRel });
      }
    }
    // 老单版记录（没有 versions 字段）：<id>.zip 就是它的包，已在上面登记过
    // 图标：相对静态目录 icons/<id>__<作者uid>.<ext>（appCatalogEntry().icon 的写法）
    const iconPath = appIconPath(a.id, a.userId);
    if (iconPath) push(a.id, "icons/" + path.basename(iconPath), iconPath);
    /* 上架截图（多图）：与图标同一套发布口径 —— 相对静态目录 shots/<主干>/<n>.<ext>。
       这里顺手把**列表小图**（长边 1280，懒生成）一起发出去：列表页只下它，详情才下原图。 */
    const shotDir = appShotDirOf(a.id, a.userId);
    const shotBase = path.basename(shotDir);
    const shots = appShotFiles(a.id, a.userId);
    for (const sp of shots) {
      push(a.id, "shots/" + shotBase + "/" + path.basename(sp), sp);
    }
    /* 列表小图（长边 1280）：每次发布按当前顺序重生成一次并一起发到静态目录
       （客户端列表只下它，详情才下原图 —— 图片放宽到 5MB 之后这条最省带宽）。 */
    const thumbsRel = appShotListRelsOf(a);
    for (const rel of thumbsRel) {
      if (!rel) continue;
      const lp = path.join(shotDir, path.basename(rel));
      if (fs.existsSync(lp)) push(a.id, rel, lp);
    }
    /* 封面缩略图（卡片 16:9 背景图）：同一批发布顺手生成 + 一起发到静态目录，
       省掉「第一张卡片要等接口现生成」那一下。源 = 上架截图第 1 张（没有才用图标），
       落点 icons/<主干>__shot.png / icons/<主干>.png（appCatalogEntry().thumb 的写法）。
       生成不了（认不出的格式 / 源图太小）就不登记，客户端的 /thumb 会回封面源原图。 */
    const thumbPath = appThumbOf(a);
    if (thumbPath) push(a.id, "icons/" + path.basename(thumbPath), thumbPath);
    if (appHasVersionField(a) && !appVersionRecords(a).length) {
      missing.push({ id: a.id, reason: "版本被删光，当前没有可分发的包" });
    }
  }
  return { doc: doc, entries: entries, managed: managed, missing: missing, msDoc: _tDoc - _t0, msPlanTotal: Date.now() - _t0 };
}

/* ── 彻底删除：静态目录 / 数据目录里「这条分支的一切痕迹」────────────────────────────
 * 本轮需求（用户口径）：**删掉最后一个版本 = 云端不留痕迹**，而不是留一条看不见的记录。
 * 下面三个清理函数是这件事的收尾层：先把静态目录里属于这一条分支的文件（包 / 图标 /
 * 截图 / 列表小图 / 封面缩略图）删掉并顺手收掉空目录，再把数据目录里的别名与无主对象回收。
 * 纪律：**只删「没有任何应用记录认领」的东西** —— 别的分支 / 别的作者用着的文件一个都不动，
 * 判据永远从 db.apps 现算，不靠调用方传进来的假设。
 * ─────────────────────────────────────────────────────────────────────────── */

/** 删这条分支在静态目录里的文件与空目录。
 *  三种文件名形态都要认（只按名字判、不按路径）：
 *    · 主干主干名 `<id>__<作者uid>` 开头的（新命名版本的包、图标、封面缩略图都带它）；
 *    · 老的共用名（`<id>.zip` / `<id>.png` / `<id>.webp` …）—— **必须确认没有别的分支
 *      还在用这个 id** 才删，否则会把别人的封面 / 包一起删掉；
 *    · `<id>/` 子目录整棵（`<版本>.zip` 与 `<作者uid>/<版本>.zip` 两代落点都在这儿）。
 *  返回 { removed: [...相对路径], dirs: [...相对目录] }（供日志与回归断言）。 */
function cleanAppBranchStatic(id, ownerId) {
  const sid = String(id || "");
  const own = String(ownerId || "").trim();
  const stem = own ? appFileStem(sid, own) : "";
  const stillUsed = (db.apps || []).some((x) => x && x.id === sid);
  const removed = [];
  const dirs = [];
  const drop = (p, rel) => {
    try {
      if (!fs.existsSync(p)) return;
      fs.unlinkSync(p);
      removed.push(rel);
    } catch (_) {}
  };
  /* ① 静态目录根下的散件（包 / 图标 / 封面缩略图） */
  let rootNames = [];
  try {
    rootNames = fs.readdirSync(APPS_WEB_DIR);
  } catch (_) {}
  for (const n of rootNames) {
    const hitStem = !!stem && (n === stem || n.startsWith(stem + ".") || n.startsWith(stem + "__"));
    const hitBare = !stillUsed && (n === sid || n.startsWith(sid + "."));
    if (!hitStem && !hitBare) continue;
    drop(path.join(APPS_WEB_DIR, n), n);
  }
  /* ② icons/ 与 shots/ 下的散件（图标、封面缩略图、截图原图与列表小图） */
  for (const sub of [APPS_WEB_ICONS_DIR, "shots"]) {
    const dir = path.join(APPS_WEB_DIR, sub);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const n of names) {
      const hitStem = !!stem && (n === stem || n.startsWith(stem + ".") || n.startsWith(stem + "__"));
      const hitBare = !stillUsed && (n === sid || n.startsWith(sid + "."));
      if (!hitStem && !hitBare) continue;
      drop(path.join(dir, n), sub + "/" + n);
      rmDirQuiet(dir); /* icons/<主干>/ 这种一层子目录顺手收掉（非空就停手） */
    }
    /* shots/<主干>/ 是一个目录（不是散件）：整棵删 */
    if (stem) {
      const sd = path.join(dir, stem);
      try {
        if (fs.existsSync(sd)) {
          fs.rmSync(sd, { recursive: true, force: true });
          dirs.push(sub + "/" + stem);
        }
      } catch (_) {}
    }
  }
  /* ③ `<id>/` 整棵子目录（版本包两代落点都在里头） */
  const idDir = path.join(APPS_WEB_DIR, sid);
  try {
    if (fs.existsSync(idDir)) {
      fs.rmSync(idDir, { recursive: true, force: true });
      dirs.push(sid);
    }
  } catch (_) {}
  dirIndexDrop(APPS_WEB_DIR);
  staticAppsStatusInvalidate();
  return { removed: removed, dirs: dirs };
}

/** 删掉落盘分支在数据目录里的别名与版本子目录（对象库那一份由 imgObjectsGc 按引用回收）。 */
function clearAppBranchDataDir(id, ownerId) {
  const dropped = [];
  const shotDir = appShotDirOf(id, ownerId);
  try {
    if (fs.existsSync(shotDir)) {
      fs.rmSync(shotDir, { recursive: true, force: true });
      dropped.push(shotDir);
    }
  } catch (_) {}
  try { fs.rmdirSync(path.join(appVersionDir(id), String(ownerId || ""))); } catch (_) {}
  dirIndexDrop();
  return dropped;
}

/** 原子写一个文件（同目录 tmp + rename）：读者要么看到旧内容、要么看到新内容，不会读到半截 JSON。 */
function writeFileAtomicSync(target, data) {
  mkdirp(path.dirname(target));
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now().toString(36);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

function readJsonFileQuiet(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** 删空目录（只删静态目录里那些应用专属的子目录；非空就停手）。 */
function rmDirQuiet(p) {
  try { fs.rmdirSync(p); } catch {}
}

/**
 * 把接口目录写到静态目录（nginx 直发的那个文件夹）。返回 {ok, dir, apps, files, removed, missing, errors}。
 * 失败不清库、不回滚业务：调用方据此降级到「客户端走接口目录」。
 */
function writeStaticApps() {
  const t0 = Date.now();
  const tPlan = Date.now();
  const plan = appStaticPlan();
  const msPlan = Date.now() - tPlan;
  mkdirp(APPS_WEB_DIR);
  mkdirp(path.join(APPS_WEB_DIR, APPS_WEB_ICONS_DIR));
  for (const e of plan.entries) {
    if (!e.rel.endsWith(".zip") || e.rel.indexOf("/") < 0) continue;
    mkdirp(path.join(APPS_WEB_DIR, e.id));
  }
  // 1) 内容先落齐：包 / 图标
  /* 为什么加「跳过没变的文件」（本轮 1000 条场景）：一次全量发布要把每个应用的 zip / 图标都
     重拷一遍（1200 条目录 = 5600 个文件 ≈ 320MB，实测 8.4 秒）。而绝大多数文件这次根本没变
     （只是目录里的别的条目动了）。所以逐个比对「目标已存在 + 大小相同 + 目标不比源旧」就跳过 ——
     这不是缓存（内容仍以源为准），只是不做无意义的重写。
     manifest 的清理逻辑保证「上次发布留下的托管文件」仍会被照看到，不会因跳过而漏删。 */
  const errors = [];
  let copied = 0;
  let skippedSame = 0;
  let copiedBytes = 0;
  for (const e of plan.entries) {
    const dst = path.join(APPS_WEB_DIR, ...e.rel.split("/"));
    try {
      const srcSt = fs.statSync(e.src);
      let same = false;
      try {
        const dstSt = fs.statSync(dst);
        same = dstSt.size === srcSt.size && dstSt.mtimeMs >= srcSt.mtimeMs - 2000;
      } catch (_) {}
      if (same) {
        skippedSame++;
        continue;
      }
      writeFileAtomicSync(dst, fs.readFileSync(e.src));
      copied++;
      copiedBytes += srcSt.size;
    } catch (err) {
      errors.push(e.rel + "：" + ((err && err.message) || String(err)));
    }
  }
  // 2) 目录清单最后写：清单里出现的条目，包与图标都已经在盘上
  try {
    /* 目录 JSON 不再做「漂亮打印」：1000+ 条时缩进会白烧几百毫秒 CPU，而客户端一律 JSON.parse、
       人眼要看的是 /api/apps/:id 之类的单条响应。落盘仍是同一份数据（字节更小）。 */
    const tJ = Date.now();
    const _enc = encodeJsonDoc(plan.doc);
    const catalogBody = Buffer.concat([_enc.body, Buffer.from("\n")]);
    const msJson = Date.now() - tJ;
    writeFileAtomicSync(path.join(APPS_WEB_DIR, "catalog.json"), catalogBody);
    /* 顺带落一份 .gz：nginx 开 gzip_static 时**直接发它**（省掉每次请求现场压缩）。
       只能 gzip 这一种（brotli 需要额外模块），写失败不算发布失败。 */
    try {
      const _gz = encodeJsonDoc(plan.doc).gz || zlib.gzipSync(catalogBody, { level: 6 });
      writeFileAtomicSync(path.join(APPS_WEB_DIR, "catalog.json.gz"), _gz);
    } catch (err) {
      console.warn("[mtnode-store] catalog.json.gz 写失败（不影响直发）：" + ((err && err.message) || String(err)));
    }
  } catch (err) {
    errors.push("catalog.json：" + ((err && err.message) || String(err)));
  }
  // 3) 清理：上次发布留下的托管文件里，这次不再需要的
  const want = new Set(plan.managed);
  const prev = readJsonFileQuiet(path.join(APPS_WEB_DIR, APPS_WEB_MANIFEST));
  const prevList = prev && Array.isArray(prev.files) ? prev.files : [];
  const removed = [];
  for (const rel of prevList) {
    const r = String(rel || "").replace(/\\/g, "/");
    if (!r || want.has(r) || r === "catalog.json" || r.indexOf("..") >= 0) continue;
    const p = path.join(APPS_WEB_DIR, ...r.split("/"));
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(r);
        if (r.indexOf("/") > 0) rmDirQuiet(path.dirname(p));
      }
    } catch (err) {
      errors.push("清理 " + r + "：" + ((err && err.message) || String(err)));
    }
  }
  try {
    writeFileAtomicSync(
      path.join(APPS_WEB_DIR, APPS_WEB_MANIFEST),
      JSON.stringify({ updatedAt: new Date(now()).toISOString(), apps: plan.doc.apps.length, files: plan.managed }, null, 2) + "\n",
    );
  } catch (err) {
    errors.push(APPS_WEB_MANIFEST + "：" + ((err && err.message) || String(err)));
  }
  dirIndexDrop(APPS_WEB_DIR);
  staticAppsStatusInvalidate();
  let catalogBytes = 0;
  try {
    catalogBytes = fs.statSync(path.join(APPS_WEB_DIR, "catalog.json")).size;
  } catch (_) {}
  const ok = errors.length === 0;
  /* 阈值告警（只记日志，不改行为）：这三个数字是「上线后不故障」的早期信号 ——
     发布耗时随目录条数线性上涨、目录体积突破客户端耐心、或每次都要全量重拷。 */
  const _ms = Date.now() - t0;
  const _pubLimit = Number(process.env.MTNODE_APPS_PUBLISH_WARN_MS || 3000) || 3000;
  const _bytesLimit = Number(process.env.MTNODE_APPS_CATALOG_WARN_BYTES || 8 * 1024 * 1024) || 8 * 1024 * 1024;
  if (_ms > _pubLimit) {
    console.warn("[mtnode-store][warn] 静态目录发布耗时 " + _ms + "ms 超过阈值 " + _pubLimit + "ms（目录 " + plan.doc.apps.length + " 条 / " + plan.managed.length + " 文件）—— 查 docs/reports/scale-1000-verification.md 的排查顺序");
  }
  if (catalogBytes > _bytesLimit) {
    console.warn("[mtnode-store][warn] 目录 JSON " + Math.round(catalogBytes / 1024) + "KB 超过阈值 " + Math.round(_bytesLimit / 1024) + "KB —— 考虑按需拉 versions[] / shots[]（见验证报告「已知边界」）");
  }
  if (copied > 200 && copied > skippedSame) {
    console.warn("[mtnode-store][warn] 本次发布重拷了 " + copied + " 个文件（跳过 " + skippedSame + " 个）—— 源文件时间戳大面积变新？检查是否有外部脚本重写包目录");
  }
  return {
    ok: ok,
    dir: APPS_WEB_DIR,
    apps: plan.doc.apps.length,
    files: plan.managed.length,
    copied: copied,
    skippedSame: skippedSame,
    copiedBytes: copiedBytes,
    msPlan: msPlan,
    msDoc: plan.msDoc,
    msPlanTotal: plan.msPlanTotal,
    msJson: typeof msJson === "number" ? msJson : 0,
    removed: removed,
    missing: plan.missing,
    errors: errors,
    ms: Date.now() - t0,
  };
}

/** 静态目录发布闸（进程内串行）：返回同上加上 skipped / error。 */
let staticPublishBusy = false;
let staticPublishPending = false;
let staticPublishLast = null;
let staticPublishFallback = false; // 静态目录写不进去 → 客户端改走接口目录（见 handle 的 /api/apps/catalog）
/* 发布模式：默认「每次变更立刻发」。设 MTNODE_APPS_PUBLISH=manual 改成「攒着」——
   只给隔离沙箱批量造数用：否则造 1000 条 × 每条 3 版 ≈ 4000 次全量重发（O(N²)），要跑几小时。
   攒到最后由 POST /api/admin/content/republish 一次发完，发布耗时本身照旧被量到
   （那正是「单次应用变更 P95」要看的数字）。线上不设这个环境变量 = 每次变更立刻发，口径不变。 */
const APPS_PUBLISH_MANUAL = String(process.env.MTNODE_APPS_PUBLISH || "").toLowerCase() === "manual";
let staticPublishDeferred = 0;
let staticPublishTimer = null;
let staticPublishPendingReason = "";
const DEBOUNCE_MS = Math.max(0, Number(process.env.MTNODE_APPS_PUBLISH_DEBOUNCE || 800) || 0);

function publishStaticApps(reason, opts) {
  /* opts.force = 管理台 / 自检主动「重发静态目录」：即使处在 manual（攒着）模式也要真发一次。 */
  if (APPS_PUBLISH_MANUAL && !(opts && opts.force)) {
    staticPublishDeferred++;
    staticPublishLast = { ok: true, deferred: staticPublishDeferred, reason: reason, dir: APPS_WEB_DIR, apps: (db.apps || []).length, files: 0, removed: [], missing: [], errors: [], ms: 0 };
    return staticPublishLast;
  }
  if (staticPublishBusy) {
    // 前一次还没写完（同一进程内的连续变更）：这次跳过，前一次写的是**这次之前**的库，
    // 可能漏掉最新一条 —— 标记 pending，写完再看一次。
    staticPublishPending = true;
    staticPublishPendingReason = reason;
    return { ok: false, skipped: true, reason: reason };
  }
  staticPublishPendingReason = reason;
  staticPublishBusy = true;
  let out;
  try {
    out = writeStaticApps();
  } catch (err) {
    out = { ok: false, dir: APPS_WEB_DIR, apps: 0, files: 0, errors: ["发布抛出异常：" + ((err && err.message) || String(err))], missing: [], removed: [] };
  }
  staticPublishBusy = false;
  staticPublishLast = Object.assign({ reason: reason }, out);
  /* 发布合并（防抖）：一次发布是 O(目录条数 + 托管文件数)（1200 条实测 8.4 秒），
     而真实使用里「连着改几个应用 / 连续追加几版」很常见 —— 把窗口内的多次变更并成**最后一次**，
     省掉中间那些注定被下一次覆盖的全量重发。窗口内最后一次的 reason 保留在 staticPublishPendingReason。
     MTNODE_APPS_PUBLISH_DEBOUNCE=0 可关掉它（回到「每次变更立刻发」）。 */
  /* ⚠️ 合并重发自己**不能再排一次防抖**（opts.noDebounce 就是它的出口）：否则
     「发一次 → 排一个 800ms 定时器 → 定时器里再发一次 → 再排一个」自续成每秒一次的死循环
     （2026-10-09 上线当场：staticPublishLast.reason 里「（合并）」无限增长、catalog.json 每秒被重写）。
     定时器只由**真实变更**排（每次变更调用本函数一次），合并那一发是终点。 */
  if (DEBOUNCE_MS > 0 && !staticPublishTimer && !(opts && opts.noDebounce)) {
    staticPublishTimer = setTimeout(() => {
      staticPublishTimer = null;
      const why = staticPublishPendingReason || "合并发布";
      staticPublishPendingReason = "";
      if (staticPublishFallback) {
        /* 上一次直发失败过：这次合并重发就是把静态目录修回来的机会，照常发。 */
      }
      publishStaticApps(why + "（合并）", { force: true, noDebounce: true });
    }, DEBOUNCE_MS);
    if (staticPublishTimer.unref) staticPublishTimer.unref();
  }
  if (out.ok) {
    if (staticPublishFallback) {
      staticPublishFallback = false;
      console.log("[mtnode-store] apps static dir: 恢复直发（" + out.dir + "）");
    }
    console.log(
      "[mtnode-store] apps static dir: 已发布 " + out.apps + " 个应用 / " + out.files + " 个文件" +
        (out.removed && out.removed.length ? " · 清理 " + out.removed.length + " 个旧文件" : "") +
        (out.missing && out.missing.length ? " · 缺 " + out.missing.length + " 项（" + out.missing.map((m) => m.id).join(",") + "）" : "") +
        " · " + out.ms + "ms · 触发=" + reason,
    );
  } else {
    staticPublishFallback = true;
    // 日志必须写清「缺权限 / 路径」这类可执行信息，别只留一句失败。
    console.warn(
      "[mtnode-store] apps static dir: 发布失败（" + out.dir + "）→ 客户端改走接口目录 /api/apps/catalog。" +
        "排查：目录是否存在且本服务可写（chown / chmod），或设 MTNODE_APPS_WEB_DIR 指到可写目录。原因：" +
        (out.errors || []).join("；"),
    );
  }
  if (staticPublishPending) {
    staticPublishPending = false;
    return publishStaticApps(reason + "+补发");
  }
  return out;
}

/** 静态目录体检（供 GET /api/apps/pub 与上线自检）：只看文件在不在、条数对不对，不改任何东西。 */
/* 静态目录体检：**带 1 秒 TTL 缓存**。原来每调一次就 appStaticPlan() + 对每个托管文件
   existsSync + statSync（1200 条目录 = 5600 个文件 = 约 1.1 万次 syscall，单次实测 1000ms）。
   它挂在免登录的 GET /api/apps/pub 上（上线自检与压测都会打），不缓存就变成一台单机上的
   自我 DDoS。缓存 1 秒：真实变更（发布成功后）会调 staticAppsStatusInvalidate() 立刻作废。
   checks 明细只留前 200 条（原样返回全量时，这个免登录接口的响应会到几百 KB）。 */
const STATUS_CACHE_MS = 1000;
let _statusCache = { at: 0, val: null };
function staticAppsStatusInvalidate() {
  _statusCache = { at: 0, val: null };
}
function staticAppsStatus() {
  const t = now();
  if (_statusCache.val && t - _statusCache.at < STATUS_CACHE_MS) return _statusCache.val;
  const val = staticAppsStatusFull();
  _statusCache = { at: t, val: val };
  return val;
}
function staticAppsStatusFull() {
  const plan = appStaticPlan();
  const checks = [];
  let checked = 0;
  let missing = 0;
  for (const rel of plan.managed) {
    if (rel === APPS_WEB_MANIFEST) continue;
    const p = path.join(APPS_WEB_DIR, ...rel.split("/"));
    let exists = false;
    try {
      exists = fs.existsSync(p);
    } catch (_) {}
    if (!exists) missing++;
    if (checked < 200) checks.push({ rel: rel, exists: exists, bytes: 0 });
    checked++;
  }
  let diskApps = -1;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(APPS_WEB_DIR, "catalog.json"), "utf8"));
    diskApps = Array.isArray(d.apps) ? d.apps.length : -1;
  } catch {}
  return {
    ok: missing === 0 && diskApps === plan.doc.apps.length,
    dir: APPS_WEB_DIR,
    dbApps: plan.doc.apps.length,
    diskApps: diskApps,
    fallback: staticPublishFallback,
    last: staticPublishLast,
    checkedFiles: checked,
    missingCount: missing,
    missingOnDisk: checks.filter((c) => !c.exists).map((c) => c.rel),
    checks: checks,
    checksTruncated: checked > checks.length,
  };
}

/** 更新时版本 +1：x.y.z → x.y.(z+1)；其它形态退回「追加 .1」再走 normalizeVersion 校验。 */
function bumpAppVersion(v) {
  const s = String(v || "").trim() || "1.0.0";
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? m[1] + "." + m[2] + "." + (Number(m[3]) + 1) : s + ".1";
}

/* ==========================================================================
 * 管理台 · 系统资源监控（只读口径）
 *   · **只在管理台主动拉取时**采样一次（GET /api/admin/sysinfo，切页签 / 点刷新各一次）：
 *     服务端没有后台采样、没有定时器、也不留历史 —— 需求口径就是「不自动刷」。
 *   · CPU 使用率 = 两次 os.cpus() 快照的差值（间隔 SYSINFO_SAMPLE_MS）；拿不到差值退回 1 分钟负载。
 *   · 磁盘看的是**数据目录所在盘**（db.json / 应用 zip / 技能包都落在这里）。
 *   · Swap 只有 Linux 有（读 /proc/meminfo）；读不到就 supported:false，界面显示「本机不支持」。
 *   · 全程只读：不重启服务、不清缓存、不写任何文件。
 * ========================================================================== */

const SYSINFO_SAMPLE_MS = 200;

function sysinfoPct(used, total) {
  const t = Number(total) || 0;
  if (!(t > 0)) return 0;
  return Math.round((Math.max(0, Number(used) || 0) / t) * 1000) / 10;
}

/** 一次全机 CPU 时间快照（jiffies 口径，与 os.cpus() 的 times 字段同源）。 */
function sysinfoCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times || {};
    const busy = (Number(t.user) || 0) + (Number(t.nice) || 0) + (Number(t.sys) || 0) + (Number(t.irq) || 0);
    const id = Number(t.idle) || 0;
    idle += id;
    total += busy + id;
  }
  return { idle, total };
}

function sysinfoSwap() {
  const none = { supported: false, totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPct: 0 };
  let txt = "";
  try {
    txt = fs.readFileSync("/proc/meminfo", "utf8");
  } catch {
    return none;
  }
  const pick = (key) => {
    const m = new RegExp("^" + key + ":\\s+(\\d+)\\s+kB", "m").exec(txt);
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = pick("SwapTotal");
  if (!(total > 0)) return none;
  const free = pick("SwapFree");
  const used = Math.max(0, total - free);
  return { supported: true, totalBytes: total, usedBytes: used, freeBytes: free, usedPct: sysinfoPct(used, total) };
}

async function sysinfoSnapshot() {
  const at = now();
  const cpuA = sysinfoCpuTimes();
  const t0 = process.hrtime.bigint();
  await new Promise((r) => setTimeout(r, SYSINFO_SAMPLE_MS));
  const cpuB = sysinfoCpuTimes();
  const sampleMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const dIdle = cpuB.idle - cpuA.idle;
  const dTotal = cpuB.total - cpuA.total;
  const cpus = os.cpus();
  const load = os.loadavg();

  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = Math.max(0, memTotal - memFree);

  let disk = { supported: false, path: DATA_DIR, totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPct: 0 };
  try {
    const st = fs.statfsSync(DATA_DIR);
    const bsize = Number(st.bsize) || 0;
    const total = Number(st.blocks) * bsize;
    const free = Number(st.bavail) * bsize;
    const used = Math.max(0, total - Number(st.bfree) * bsize);
    if (total > 0) {
      disk = { supported: true, path: DATA_DIR, totalBytes: total, usedBytes: used, freeBytes: free, usedPct: sysinfoPct(used, total) };
    }
  } catch {
    /* 不支持 statfs 的平台（或目录不在）就留 supported:false，界面显示「取不到」 */
  }

  const cpuUsage = process.cpuUsage();
  const uptimeSec = Math.round(process.uptime());
  const mem = process.memoryUsage();

  return {
    ok: true,
    at: at,
    sampleMs: sampleMs,
    cpu: {
      usagePct: dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 1000) / 10 : 0,
      cores: cpus.length,
      model: (cpus[0] && cpus[0].model) || "",
      load: [Number(load[0]) || 0, Number(load[1]) || 0, Number(load[2]) || 0],
    },
    mem: {
      totalBytes: memTotal,
      usedBytes: memUsed,
      freeBytes: memFree,
      usedPct: sysinfoPct(memUsed, memTotal),
    },
    swap: sysinfoSwap(),
    disk: disk,
    proc: {
      pid: process.pid,
      rssBytes: Number(mem.rss) || 0,
      heapUsedBytes: Number(mem.heapUsed) || 0,
      cpuTimeMs: Math.round(((Number(cpuUsage.user) || 0) + (Number(cpuUsage.system) || 0)) / 1000),
      uptimeSec: uptimeSec,
      startedAt: at - uptimeSec * 1000,
      node: process.version,
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptimeSec: Math.round(os.uptime()),
    },
  };
}

/* ==========================================================================
 * 管理台 · 内容管理（管理员对 应用 / 模板 / 技能 的操作）
 *   · 管理台的票是 adm_（不是客户端 Bearer），走不到 /api/apps|templates|skills 的 owner 判定，
 *     所以单开一组 /api/admin/content/*：管理员可操作**任何作者**的内容（对齐 isAdmin 的既有口径）。
 *   · 编辑只到元信息：应用 = 标题/简介/标签/图标；模板 = 标题/简介/标签；技能 = 标题/简介/标签/版本号/官方标记。
 *     文件正文与 zip 一律不在管理台换（谁上传谁改）；应用的 version 由版本记录掌管，也不手改。
 *   · 模板 / 技能服务端本来就没有多版本链，这层差异照现状适配，不新增字段。
 *   · 删除类操作在界面上二次确认，服务端逐条写 contentAudit（谁 / 何时 / 对哪条做了什么）。
 * ========================================================================== */

const CONTENT_AUDIT_MAX = 200;
const CONTENT_KINDS = ["app", "template", "skill"];

function contentAuditList() {
  if (!Array.isArray(db.contentAudit)) db.contentAudit = [];
  return db.contentAudit;
}

async function contentAuditPush(admin, action, kind, row, detail) {
  const list = contentAuditList();
  list.unshift({
    id: "ca_" + crypto.randomBytes(6).toString("hex"),
    at: now(),
    userId: admin.id,
    username: admin.username || admin.id,
    action: action,
    kind: kind,
    targetId: row.id,
    targetOwnerId: row.ownerId || "",
    targetTitle: row.title || row.skillName || row.id,
    detail: detail || "",
  });
  if (list.length > CONTENT_AUDIT_MAX) list.length = CONTENT_AUDIT_MAX;
  await saveDb();
}

function adminContentFind(kind, id, ownerId) {
  const want = String(id || "").trim();
  if (kind === "template") {
    const t = db.templates.find((x) => x.id === want);
    return t ? { row: t, ownerId: t.userId } : null;
  }
  if (kind === "skill") {
    const s = db.skills.find((x) => x.id === want);
    return s ? { row: s, ownerId: s.userId } : null;
  }
  const branches = appBranchesOf(want);
  if (!branches.length) return null;
  const asked = appResolveOwnerId(ownerId);
  const a = asked ? appBranchOfOwner(want, asked) : branches.length === 1 ? branches[0] : null;
  return a ? { row: a, ownerId: a.userId, branchRequired: false } : { row: null, ownerId: "", branches: branches.length, branchRequired: true };
}

function adminAppRow(a) {
  const recs = appVersionRecords(a);
  const owner = db.users.find((u) => u.id === a.userId);
  return {
    kind: "app",
    id: a.id,
    ownerId: a.userId,
    ownerName: owner ? String(owner.username || owner.id) : String(a.userId || ""),
    title: a.title || a.id,
    desc: a.description || a.desc || "",
    tags: Array.isArray(a.tags) ? a.tags : [],
    version: appLatestVersion(a) || appCurrentVersionOf(a),
    versionCount: recs.length,
    bytes: Number(a.bytes) || 0,
    downloads: Number(a.downloads) || 0,
    likes: Number(a.likes) || 0,
    entry: a.entry || "",
    sha256: a.sha256 || "",
    hasIcon: !!appIconPath(a.id, a.userId),
    branchCount: appFamilyEntries(a.id, "").length,
    createdAt: Number(a.createdAt) || 0,
    updatedAt: Number(a.updatedAt) || 0,
  };
}

function adminTemplateRow(t) {
  const owner = db.users.find((u) => u.id === t.userId);
  return {
    kind: "template",
    id: t.id,
    ownerId: t.userId,
    ownerName: owner ? String(owner.username || owner.id) : String(t.userId || ""),
    title: t.title || t.id,
    desc: t.description || "",
    tags: Array.isArray(t.tags) ? t.tags : [],
    bytes: Number(t.bytes) || 0,
    downloads: Number(t.downloads) || 0,
    likes: Number(t.likes) || 0,
    hasPreview: !!t.hasPreview,
    createdAt: Number(t.createdAt) || 0,
    updatedAt: Number(t.updatedAt) || 0,
  };
}

function adminSkillRow(s) {
  const owner = db.users.find((u) => u.id === s.userId);
  const files = Array.isArray(s.files) ? s.files : [];
  return {
    kind: "skill",
    id: s.id,
    ownerId: s.userId,
    ownerName: owner ? String(owner.username || owner.id) : String(s.userId || ""),
    title: s.title || s.id,
    skillName: s.skillName || "",
    desc: s.description || "",
    tags: Array.isArray(s.tags) ? s.tags : [],
    version: s.version || "1.0.0",
    official: !!s.official,
    fileCount: files.length,
    fileList: files.map((f) => f.path),
    bytes: Number(s.bytes) || 0,
    downloads: Number(s.downloads) || 0,
    likes: Number(s.likes) || 0,
    hasPreview: !!s.hasPreview,
    createdAt: Number(s.createdAt) || 0,
    updatedAt: Number(s.updatedAt) || 0,
  };
}

/** 一处匹配：关键词打 id / 标题 / 简介 / 标签 / skillName / 作者账号。 */
function adminContentHit(row, q) {
  if (!q) return true;
  const hay = [row.id, row.title, row.desc, row.skillName, row.ownerName, row.ownerId, (row.tags || []).join(" ")]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

function adminContentCounts() {
  const apps = db.apps || [];
  return {
    app: apps.length,
    template: (db.templates || []).length,
    skill: (db.skills || []).length,
    skillOfficial: (db.skills || []).filter((s) => s && s.official).length,
  };
}

function adminContentPage(rows, url, defSize) {
  const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get("pageSize")) || defSize || 20));
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  rows.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  return { page, pageSize, total: rows.length, items: rows.slice((page - 1) * pageSize, page * pageSize) };
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "http://local");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method || "GET";
  /* bootRelayKey：/api/relay/me 允许用登录会话换独立的中转 Key（见 authUser 注释）。 */
  const isRelayDataPath = p === "/relay/v1" || p.startsWith("/relay/v1/");
  const user = await authUser(req, isRelayDataPath, { bootRelayKey: p === "/api/relay/me" });

  // 中转站：/relay/v1/* 全权交给 relay.mjs（它自己读请求体 —— multipart 要原包转发）。
  // 鉴权沿用它上面的账号 token（同一套 Bearer 会话），不另立一套 Key。
  if (p === "/relay/v1" || p.startsWith("/relay/v1/")) {
    return relay.handle({ req, res, p, method, user, url, clientIp: clientIp(req) });
  }

  const jsonBody = async () => {
    /* 上架链路的写接口放宽到 MAX_BODY_APP_UPLOAD（见 appUploadRoute 的注释），
       其它接口一字不动地守 MAX_BODY。 */
    const raw = await readBody(req, appUploadRoute(p, method) ? MAX_BODY_APP_UPLOAD : MAX_BODY);
    if (!raw.length) return {};
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      const err = new Error("invalid json");
      err.status = 400;
      throw err;
    }
  };

  if (method === "GET" && p === "/api/health") {
    const pay = alipayStatus();
    return send(res, 200, {
      ok: true,
      service: "mtnode-store",
      templates: db.templates.length,
      skills: db.skills.length,
      apps: (db.apps || []).length,
      // 应用多版本开关（读部署排查用）：关 = 旧口径 <id>.zip 一版一份。
      appVersions: appVersionsOn(),
      // 充值链路自检：部署后 curl 一眼看出凭据是否就位（不含任何密钥材料）
      recharge: {
        orders: (db.rechargeOrders || []).length,
        ledger: (db.rechargeLedger || []).length,
        // 打赏 / 评论 / 消息自检：部署后 curl /api/health 一眼看出新集合有没有载入（0 也算正常）
        tips: (db.tips || []).length,
        comments: (db.comments || []).length,
        notifications: (db.notifications || []).length,
        payConfigured: pay.configured,
        payMissing: pay.configured ? [] : pay.missing,
        notifyConfigured: pay.hasNotifyUrl,
        adminWeb: fs.existsSync(path.join(ADMIN_WEB_DIR, "index.html")),
        /* 充值闸门是否对所有已注册账号开放（见 rechargeAllowed）：部署自检直接看这一行，
           不必再猜线上有没有残留名单 —— false 只可能是 MTNODE_RECHARGE_CLOSED 被显式置上了。 */
        open: !rechargeGloballyClosed(),
      },
      // 中转站自检：只回「上游凭据就位与否 + 白名单模型数」，不含任何 Key 材料
      relay: (() => {
        const d = relay.describe();
        const kinds = { text: false, image: false };
        for (const u of d.upstreams) if (u.configured && kinds[u.kind] === false) kinds[u.kind] = true;
        return {
          textUpstream: kinds.text,
          imageUpstream: kinds.image,
          upstreams: d.upstreams.map((u) => ({ id: u.id, kind: u.kind, configured: u.configured, keyFrom: u.keyFrom })),
          models: d.models.length,
          configSource: d.configSource,
          usageRecords: d.usageRecords,
          auditRecords: d.auditRecords,
          publicBase: RELAY_PUBLIC_BASE,
        };
      })(),
    });
  }

  if (method === "POST" && p === "/api/register") {
    // 旧式用户名/密码注册已停用：新账号一律走手机验证码或微信登录（见 docs/auth-design.md）。
    // 老账号仍可用 /api/login 登录，登录后通过 /api/auth/bind 补齐手机号/微信。
    return send(res, 410, {
      ok: false,
      code: "REGISTER_DISABLED",
      error: "用户名密码注册已停用，请使用手机验证码或微信登录",
    });
  }

  if (method === "POST" && p === "/api/login") {
    const b = await jsonBody();
    const u = accountLoginPassword(b.username, b.password);
    if (!u) {
      return send(res, 401, { ok: false, code: "BAD_CREDENTIALS", error: "用户名或密码错误" });
    }
    const token = await issueSession(u);
    await saveDb();
    return send(res, 200, { ok: true, token, user: publicUser(u) });
  }

  if (method === "POST" && p === "/api/change-password") {
    const b = await jsonBody();
    const oldPassword = String(b.oldPassword || b.password || "");
    const newPassword = String(b.newPassword || "");
    const u = findUserByName(b.username);
    if (!u || hashPass(oldPassword, u.salt) !== u.pass) {
      return send(res, 401, { ok: false, error: "用户名或旧密码错误" });
    }
    if (!validPassword(newPassword)) {
      return send(res, 400, { ok: false, error: "密码长度为 6-72 位" });
    }
    if (oldPassword === newPassword) {
      return send(res, 400, { ok: false, error: "新密码不能与旧密码相同" });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const updated = await applyUserPatch(u.id, {
      salt,
      pass: hashPass(newPassword, salt),
      passwordChangedAt: now(),
    });
    const token = await issueSession(updated || u);
    await saveDb();
    return send(res, 200, { ok: true, token, user: publicUser(updated || u) });
  }

  if (method === "POST" && p === "/api/logout") {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+(\S+)/i.exec(h);
    if (m) {
      const th = hashToken(m[1]);
      /* 带的是**中转票**（不是登录会话）也算退出登录：客户端退出时手上可能只剩这张票
         （本机存着票、登录会话已被清），这时必须能把票收回来 ——
         十年票的口径是「分发一次后不失效」，不该变成「连登出都收不回来」。
         两种票都算：把该账号的中转票与明文一并作废（见 revokeRelayKeys）。 */
      const rec = (db.sessions || []).find((s) => s.tokenHash === th) || null;
      const isRelayKey = rec && String(rec.kind || "") === RELAY_KEY_KIND;
      await accountStore.deleteSession(th);
      db.sessions = db.sessions.filter((s) => s.tokenHash !== th);
      const who = user || (isRelayKey ? (db.users || []).find((x) => x.id === rec.userId) || null : null);
      if (who) await revokeRelayKeys(who);
      await saveDb();
    }
    return send(res, 200, { ok: true, code: "OK" });
  }

  if (method === "GET" && p === "/api/me") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    return send(res, 200, { ok: true, user: publicUser(user) });
  }

  /**
   * 客户端同步入口：这个账号在中转站能用哪些模型 + 该填的 Base URL。
   * 客户端「登录成功 / 充值成功 / 提供商页刷新 / 快照过期」各拉一次（见 docs/relay-admin.md）。
   * 未充值（可用余额 ≤ 0）一律回空清单 —— 与中转站门禁口径一致，不诱导用户白跑。
   *
   * everRecharged：**有没有充过值**（账本里存在 recharge 支付入账，或正向 adjust 人工调账）。
   * 客户端靠它决定「设置 · 提供商」里那张只读的「MTNode 中转服务」卡到底要不要出现：
   * 充过值就永久显示（余额花光也只置灰、不消失），从没充过就连卡都不建。
   * 注意与 balanceYuan 的区别：余额可以花光归零，充值史不会。
   */
  if (method === "GET" && p === "/api/relay/me") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const models = relay.admin.userModels(user);
    const totalYuan = yuanOfCents(totalCentsOf(user));
    const everRecharged = (db.rechargeLedger || []).some(
      (e) =>
        e &&
        /* 只认**这个账号自己**的流水：整账本里有别人的充值不算你有充值 */
        String(e.userId || "") === String(user.id || "") &&
        (e.type === "recharge" ||
          (e.type === "adjust" && Number(e.deltaCents) > 0)),
    );
    /* 中转 Key（3650 天独立票）：这个入口同时是**发放口** —— 客户端登录后 / 老客户端首次
       同步时来这里领票，明文只在下发的这一次回给主进程（客户端存本机加密凭据）。 */
    const keyView = await relayKeyView(
      user,
      user && user.__sessionHash,
      String(req.headers["x-mtnode-device"] || "").trim().slice(0, 64),
    );
    return send(res, 200, {
      ok: true,
      baseUrl: RELAY_PUBLIC_BASE,
      providerName: "MTNode 中转服务",
      enabled: models.length > 0,
      everRecharged,
      /* 余额一律按「元」（4 位小数）下发；内部仍是整数分 + 亚分零头，客户端不接触分。 */
      balanceYuan: totalYuan,
      totalYuan: totalYuan,
      models: models,
      /* 中转计费的两半（客户端本地「中转按币」计价要与云端同源，见 relay.mjs 的
         textCostYuan / isPeak）：models[].price = 逐模型真实价目；peaks = 豁免高峰的
         节假日日期；coinYuan = 鲸圆币汇率（1 币 = ¥0.02）。三个字段都只读、不含凭据。 */
      peaks: relay.admin.peaks(),
      coinYuan: relay.admin.coinYuan(),
      reason: models.length ? "" : "账号在中转站的可用余额为 0：充值后即可使用",
      updatedAt: Date.now(),
      /* 凭据状态：relayKey 非空 = 这次新发的（客户端立刻存下）；为空 = 沿用现役那张。 */
      relayKey: keyView.relayKey,
      relayKeyExpiresAt: keyView.expiresAt,
      relayKeyTtlMs: keyView.ttlMs,
      relayKeyRenewBeforeMs: keyView.renewBeforeMs,
      /* 手动轮换的当日余量（卡上「更换 Key」按钮据此置灰并显示 n/5）。 */
      ...relayRotateView(user, Date.now()),
    });
  }

  /**
   * 手动更换中转 Key（客户端卡上的「更换 Key」按钮）：
   * POST /api/relay/me { rotate: true } —— 幂发口径下 GET 只会拿回同一张票，
   * 想换一张必须走这个显式入口。限频：**每账号自然日 5 次**（服务器本地时区），
   * 超限回 429 RELAY_ROTATE_LIMIT；换 Key 后旧票立即失效（见 ensureRelayKey 的注释）。
   * 只动中转票，**不动登录会话**（换 Key 不该把人踢下线）。
   */
  if (method === "POST" && p === "/api/relay/me") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    if (!b || b.rotate !== true) {
      return send(res, 400, {
        ok: false,
        code: "BAD_REQUEST",
        error: "该入口只支持 { rotate: true }（同步中转清单请用 GET）",
      });
    }
    const t = Date.now();
    const before = relayRotateStateOf(user, t);
    if (before.left <= 0) {
      return send(res, 429, {
        ok: false,
        code: "RELAY_ROTATE_LIMIT",
        error: "今日更换次数已用完（" + before.limit + "/" + before.limit + "）",
        ...relayRotateView(user, t),
      });
    }
    const used = await consumeRelayRotate(user, t);
    const keyView = await relayKeyView(
      user,
      user && user.__sessionHash,
      String(req.headers["x-mtnode-device"] || "").trim().slice(0, 64),
      { rotate: true },
    );
    await saveDb();
    console.log(
      "[mtnode-store] relay key rotated: user=" +
        String(user.id) +
        " 今日第 " +
        String(used.state.used) +
        "/" +
        String(used.state.limit) +
        " 次",
    );
    return send(res, 200, {
      ok: true,
      rotatedAt: Date.now(),
      relayKey: keyView.relayKey,
      relayKeyExpiresAt: keyView.expiresAt,
      relayKeyTtlMs: keyView.ttlMs,
      relayKeyRenewBeforeMs: keyView.renewBeforeMs,
      ...relayRotateView(user, Date.now()),
    });
  }

  // 修改昵称（登录态）：去控制字符 + 首尾空白，1-32 位（见 docs/auth-design.md）。
  if (method === "PATCH" && p === "/api/me") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    const nickname = normalizeNickname(b.nickname);
    if (!nickname) {
      return send(res, 400, { ok: false, code: "INVALID_NICKNAME", error: "昵称长度需 1-32 位" });
    }
    const updated = await applyUserPatch(user.id, { nickname });
    if (!updated) {
      return send(res, 500, { ok: false, code: "UPDATE_FAILED", error: "昵称更新失败" });
    }
    await saveDb();
    /* 昵称就是应用市场里的作者显示名（用户共识：改一次处处生效）。静态目录是快照，
       不重刷的话别人（以及作者自己）在市场里看到的还是旧名字 —— 所以这里顺带重发一次。
       只在该账号名下真有应用时才写盘，避免每次改昵称都刷一遍静态目录。 */
    if ((db.apps || []).some((a) => a && a.userId === user.id)) {
      try {
        publishStaticApps("nickname:" + user.id);
      } catch (err) {
        // 目录刷不动不影响昵称本身（接口目录那份是现算的，客户端兜底也能拿到新名字）
        console.warn("[store] 改昵称后重发应用目录失败：" + ((err && err.message) || String(err)));
      }
    }
    return send(res, 200, { ok: true, user: publicUser(updated) });
  }

  // —— 短信验证码（见 docs/auth-design.md 5.7 / 5.8 / 8）——
  if (method === "POST" && p === "/api/auth/sms/send") {
    const b = await jsonBody();
    const phone = normalizePhone(b.phone);
    if (!phone) {
      return send(res, 400, { ok: false, code: "INVALID_PHONE", error: "手机号格式无效" });
    }
    const scene = String(b.scene || "login").trim().toLowerCase() === "bind" ? "bind" : "login";
    const st = smsProviderStatus();
    if (!st.configured) {
      return send(res, 503, { ok: false, code: "SMS_UNAVAILABLE", error: "短信服务未配置" });
    }
    const ip = clientIp(req);
    const gate = smsSendGate(phone, ip);
    if (!gate.ok) {
      return send(res, 429, {
        ok: false,
        code: "RATE_LIMITED",
        error: "请求过于频繁，请稍后再试",
        retryAfter: gate.retryAfter,
      });
    }
    // 先占频控额度再发：发送失败也计入（防刷）。
    smsSendCommit(phone, ip, gate.phoneArr, gate.ipArr);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const salt = crypto.randomBytes(8).toString("hex");
    smsCodes.set(phone, {
      salt,
      hash: hashSmsCode(salt, code),
      expiresAt: now() + SMS_CODE_TTL_MS,
      attempts: 0,
      scene,
      sentAt: now(),
    });
    smsLocks.delete(phone);
    const r = await sendSmsCode({ phone, code, scene });
    if (!r.ok) {
      smsCodes.delete(phone); // 未送达即作废，避免留下无人知晓的验证码
      return send(res, r.status || 503, {
        ok: false,
        code: r.code || "SMS_UNAVAILABLE",
        error: r.error || "短信发送失败，请稍后重试",
      });
    }
    return send(res, 200, {
      ok: true,
      expiresIn: Math.round(SMS_CODE_TTL_MS / 1000),
      cooldown: Math.round(SMS_COOLDOWN_MS / 1000),
    });
  }

  if (method === "POST" && p === "/api/auth/sms/login") {
    const b = await jsonBody();
    const phone = normalizePhone(b.phone);
    if (!phone) {
      return send(res, 400, { ok: false, code: "INVALID_PHONE", error: "手机号格式无效" });
    }
    const ip = clientIp(req);
    const gate = smsLoginGate(ip);
    if (!gate.ok) {
      return send(res, 429, {
        ok: false,
        code: "RATE_LIMITED",
        error: "请求过于频繁，请稍后再试",
        retryAfter: gate.retryAfter,
      });
    }
    smsLoginCommit(ip, gate.arr);
    const v = verifySmsCode(phone, b.code, "login");
    if (!v.ok) return send(res, v.status || 400, { ok: false, code: v.code, error: v.error });

    // 号码未注册则自动建号；已注册直接登录（同一账号同一时刻仅一个有效 token）。
    let u = identityGet("phone", phone);
    let created = false;
    if (!u) {
      u = await createUser({
        nickname: "手机用户" + phone.slice(-4),
        phone,
        phoneVerifiedAt: now(),
      });
      created = true;
      if (!(await identityClaim("phone", phone, u.id))) {
        // 极端并发：号码已被其它账号认领，回退为登录既有账号。
        await accountStore.deleteUser(u.id);
        db.users = db.users.filter((x) => x.id !== u.id);
        u = identityGet("phone", phone);
        created = false;
      }
    }
    if (!u) {
      return send(res, 500, { ok: false, code: "SERVER_ERROR", error: "账号创建失败，请稍后重试" });
    }
    const token = await issueSession(u);
    await saveDb();
    return send(res, 200, { ok: true, token, user: publicUser(u), created });
  }

  // —— 微信扫码登录（设备码轮询，见 docs/auth-design.md 5.9）——
  if (method === "POST" && p === "/api/auth/wechat/start") {
    if (!wechatConfigured()) {
      return send(res, 503, { ok: false, code: "WECHAT_UNAVAILABLE", error: "微信登录未配置" });
    }
    pruneWechat();
    const deviceCode = crypto.randomBytes(16).toString("hex");
    const state = crypto.randomBytes(16).toString("hex");
    wechatDevices.set(deviceCode, {
      state,
      createdAt: now(),
      expiresAt: now() + WECHAT_DEVICE_MS,
      ticket: "",
      bindUserId: user ? user.id : "",
    });
    wechatStates.set(state, deviceCode);
    const authUrl =
      "https://open.weixin.qq.com/connect/qrconnect?appid=" + encodeURIComponent(WECHAT_APPID) +
      "&redirect_uri=" + encodeURIComponent(WECHAT_REDIRECT) +
      "&response_type=code&scope=snsapi_login" +
      "&state=" + encodeURIComponent(state) +
      "#wechat_redirect";
    return send(res, 200, {
      ok: true,
      deviceCode,
      device_code: deviceCode,
      authUrl,
      expiresIn: Math.floor(WECHAT_DEVICE_MS / 1000),
      interval: WECHAT_POLL_INTERVAL,
    });
  }

  if (method === "GET" && p === "/api/auth/wechat/callback") {
    if (!wechatConfigured()) {
      return sendWechatHtml(res, 503, "微信登录未配置");
    }
    pruneWechat();
    const state = String(url.searchParams.get("state") || "");
    const code = String(url.searchParams.get("code") || "");
    const deviceCode = state ? wechatStates.get(state) : "";
    const dev = deviceCode ? wechatDevices.get(deviceCode) : null;
    if (!dev || dev.expiresAt <= now()) {
      return sendWechatHtml(res, 400, "登录已过期，请重新扫码");
    }
    // state 一次性：无论后续成败都作废，防重放 / CSRF。
    wechatStates.delete(state);
    if (!code) {
      return sendWechatHtml(res, 400, "已取消授权");
    }
    let ex;
    try {
      ex = await wechatExchangeCode(code);
    } catch (e) {
      return sendWechatHtml(res, 502, "微信服务暂时不可用：" + (e && e.message ? e.message : e));
    }
    if (!ex.ok) {
      return sendWechatHtml(res, 400, "微信授权失败：" + ex.error);
    }
    if (!ex.unionid) {
      return sendWechatHtml(res, 400, "微信未返回 unionid，无法登录（请在开放平台绑定应用）");
    }
    // 扫码成功只换一次性 ticket；账号归属与 token 一律由 /poll 统一处理
    // （已绑微信 → 登录该账号；本机已登录 → 绑定到本机账号；否则新建账号），全程免二次验证。
    const ticket = crypto.randomBytes(24).toString("hex");
    wechatTickets.set(ticket, {
      unionid: ex.unionid,
      openid: ex.openid,
      nickname: ex.nickname || "",
      bindUserId: dev.bindUserId || "",
      createdAt: now(),
      expiresAt: now() + WECHAT_TICKET_MS,
      used: false,
    });
    dev.ticket = ticket;
    dev.state = "";
    return sendWechatHtml(res, 200, "扫码成功，请返回 MTNode 完成登录");
  }

  if (method === "POST" && p === "/api/auth/wechat/poll") {
    if (!wechatConfigured()) {
      return send(res, 503, { ok: false, code: "WECHAT_UNAVAILABLE", error: "微信登录未配置" });
    }
    pruneWechat();
    const b = await jsonBody();
    const deviceCode = String(b.deviceCode || b.device_code || "").trim();
    if (!deviceCode) {
      return send(res, 400, { ok: false, code: "CODE_EXPIRED", error: "缺少 deviceCode" });
    }
    const dev = wechatDevices.get(deviceCode);
    if (!dev || dev.expiresAt <= now()) {
      wechatDevices.delete(deviceCode);
      return send(res, 400, { ok: false, code: "CODE_EXPIRED", error: "二维码已过期，请重新扫码" });
    }
    if (!dev.ticket) {
      return send(res, 200, { ok: true, status: "pending" });
    }
    const t = peekWechatTicket(dev.ticket);
    if (!t) {
      wechatDevices.delete(deviceCode);
      return send(res, 400, { ok: false, code: "CODE_EXPIRED", error: "二维码已过期，请重新扫码" });
    }
    // 扫码即登录并绑定：无论本机是否已登录，一律在此解析账号并签发同一套 Bearer token（免二次验证）。
    // 绑定意图（发起扫码时本机已登录，dev.bindUserId 存在）：走统一归属解析，
    //   —— 无人占用 / 已是本账号 → 绑定到本账号；可合并临时账号 → 合并；正常账号已占用 → 409。
    // 登录意图（无 bindUserId）：① 该微信已绑某账号 → 登录该账号；② 否则新建账号（默认昵称）。
    consumeWechatTicket(dev.ticket);
    wechatDevices.delete(deviceCode);
    let created = false;
    let bound = false;
    let mappedOwner = null;
    if (t.bindUserId) {
      const r = await resolveWechatOwner({
        userId: t.bindUserId,
        unionid: t.unionid,
        openid: t.openid,
        nickname: t.nickname,
      });
      if (!r.ok) {
        if (r.conflict) {
          return send(res, 409, {
            ok: false,
            code: "WECHAT_OWNED_BY_OTHER",
            error: "该微信已绑定到其它账号",
            owner: r.owner,
          });
        }
        return send(res, r.status || 400, {
          ok: false,
          code: r.code || "WECHAT_BIND_FAILED",
          error: r.error || "微信绑定失败",
        });
      }
      const token = await issueSession(r.user);
      await saveDb();
      return send(res, 200, {
        ok: true,
        status: "done",
        token,
        user: publicUser(r.user),
        bound: true,
        merged: !!r.merged,
        mergedFrom: r.mergedFrom || null,
      });
    }
    let u = identityGet("wechat_unionid", t.unionid);
    // 归属映射（MTNODE_WECHAT_OWNER_MAP）：把该微信归到配置的旧账号，不再新建临时 uid。
    // 命中不了（未配置 / 目标账号不存在 / 该微信已绑在别的正常账号上）就按原流程走。
    const mapped = await loginWithOwnerMap({
      unionid: t.unionid,
      openid: t.openid,
      nickname: t.nickname,
      current: u,
    });
    if (mapped) {
      u = mapped.user;
      bound = !!mapped.merged; // 复用 merged 语义：告知客户端「临时账号已合并进来」
      mappedOwner = mapped.mergedFrom || null;
    } else if (!u) {
      const r = await ensureWechatUser(t.unionid, t.openid, t.nickname);
      u = r.user;
      created = r.created;
    } else if (t.openid && u.wechatOpenId !== t.openid) {
      u = (await applyUserPatch(u.id, { wechatOpenId: t.openid })) || u;
    }
    const token = await issueSession(u);
    await saveDb();
    return send(res, 200, {
      ok: true,
      status: "done",
      token,
      user: publicUser(u),
      created,
      bound,
      mapped: !!mapped,
      merged: !!(mapped && mapped.merged),
      mergedFrom: mappedOwner,
    });
  }

  if (method === "POST" && p === "/api/auth/bind") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    const kind = String(b.kind || "").trim().toLowerCase();

    if (kind === "phone") {
      const phone = normalizePhone(b.phone);
      if (!phone) {
        return send(res, 400, { ok: false, code: "INVALID_PHONE", error: "手机号格式无效" });
      }
      if (user.phone === phone) {
        return send(res, 200, { ok: true, user: publicUser(user) });
      }
      if (user.phone) {
        return send(res, 409, {
          ok: false,
          code: "PHONE_ALREADY_BOUND",
          error: "已绑定其它手机号，请先解绑",
        });
      }
      const owner = identityGet("phone", phone);
      if (owner && owner.id !== user.id) {
        return send(res, 409, { ok: false, code: "PHONE_IN_USE", error: "该手机号已被其它账号绑定" });
      }
      const v = verifySmsCode(phone, b.code, "bind");
      if (!v.ok) return send(res, v.status || 400, { ok: false, code: v.code, error: v.error });
      const sf = requirePasswordIfSet(user, b);
      if (!sf.ok) return send(res, sf.status, { ok: false, code: sf.code, error: sf.error });
      if (!(await identityClaim("phone", phone, user.id))) {
        return send(res, 409, { ok: false, code: "PHONE_IN_USE", error: "该手机号已被其它账号绑定" });
      }
      const updated = await applyUserPatch(user.id, { phone, phoneVerifiedAt: now() });
      await saveDb();
      return send(res, 200, { ok: true, user: publicUser(updated || user) });
    }

    if (kind === "wechat") {
      if (user.wechatUnionId) {
        return send(res, 409, {
          ok: false,
          code: "WECHAT_ALREADY_BOUND",
          error: "已绑定微信，请先解绑",
        });
      }
      const v = verifyWechatTicket(b.ticket);
      if (!v.ok) return send(res, v.status || 400, { ok: false, code: v.code, error: v.error });
      const unionid = String(v.unionid || "").trim();
      const openid = String(v.openid || "").trim();
      if (!unionid) {
        return send(res, 400, { ok: false, code: "WECHAT_INVALID", error: "微信凭据无效" });
      }
      // 扫码即绑定，免账号密码二次验证（ticket 已由微信授权证明身份归属）；
      // 归属解析与 /poll 绑定意图复用同一函数（兼容旧客户端）：可合并临时账号即合并，
      // 正常账号已占用则 409 WECHAT_OWNED_BY_OTHER，绝不静默换号。
      const r = await resolveWechatOwner({
        userId: user.id,
        unionid,
        openid,
        nickname: v.nickname,
      });
      if (!r.ok) {
        if (r.conflict) {
          return send(res, 409, {
            ok: false,
            code: "WECHAT_OWNED_BY_OTHER",
            error: "该微信已绑定到其它账号",
            owner: r.owner,
          });
        }
        return send(res, r.status || 400, {
          ok: false,
          code: r.code || "WECHAT_BIND_FAILED",
          error: r.error || "微信绑定失败",
        });
      }
      await saveDb();
      return send(res, 200, {
        ok: true,
        user: publicUser(r.user),
        merged: !!r.merged,
        mergedFrom: r.mergedFrom || null,
      });
    }

    if (kind === "password") {
      if (user.pass) {
        return send(res, 409, {
          ok: false,
          code: "PASSWORD_ALREADY_SET",
          error: "已设置密码，请使用修改密码",
        });
      }
      const newPassword = String(b.newPassword || "");
      if (!validPassword(newPassword)) {
        return send(res, 400, { ok: false, code: "INVALID_PASSWORD", error: "密码长度为 6-72 位" });
      }
      const sf = checkSecondFactor(user, b);
      if (!sf.ok) return send(res, sf.status, { ok: false, code: sf.code, error: sf.error });
      const salt = crypto.randomBytes(16).toString("hex");
      const updated = await applyUserPatch(user.id, {
        salt,
        pass: hashPass(newPassword, salt),
        passwordChangedAt: now(),
      });
      await saveDb();
      return send(res, 200, { ok: true, user: publicUser(updated || user) });
    }

    return send(res, 400, { ok: false, code: "UNKNOWN_KIND", error: "不支持的绑定类型" });
  }

  if (method === "POST" && p === "/api/auth/unbind") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    const kind = String(b.kind || "").trim().toLowerCase();
    if (!["phone", "wechat", "password"].includes(kind)) {
      return send(res, 400, { ok: false, code: "UNKNOWN_KIND", error: "不支持的解绑类型" });
    }
    const sf = checkSecondFactor(user, b);
    if (!sf.ok) return send(res, sf.status, { ok: false, code: sf.code, error: sf.error });
    if (credentialCount(user) <= 1) {
      return send(res, 409, {
        ok: false,
        code: "LAST_CREDENTIAL",
        error: "至少需保留一种登录方式",
      });
    }
    let updated = user;
    if (kind === "phone") {
      if (!user.phone) return send(res, 409, { ok: false, code: "NOT_BOUND", error: "未绑定手机号" });
      await identityRelease("phone", user.phone, user.id);
      updated = await applyUserPatch(user.id, { phone: "", phoneVerifiedAt: 0 });
    } else if (kind === "wechat") {
      if (!user.wechatUnionId) {
        return send(res, 409, { ok: false, code: "NOT_BOUND", error: "未绑定微信" });
      }
      await identityRelease("wechat_unionid", user.wechatUnionId, user.id);
      updated = await applyUserPatch(user.id, { wechatUnionId: "", wechatOpenId: "", wechatBoundAt: 0 });
    } else {
      if (!user.pass) return send(res, 409, { ok: false, code: "NOT_BOUND", error: "未设置密码" });
      updated = await applyUserPatch(user.id, { pass: "", salt: "", passwordChangedAt: 0 });
    }
    await saveDb();
    return send(res, 200, { ok: true, user: publicUser(updated || user) });
  }

  if (method === "GET" && p === "/api/me/templates") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    const mine = db.templates
      .filter((t) => t.userId === user.id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    // 打赏 / 评分 / 评论数：先收本页 ids 批量算，别在循环里逐个算（N²）
    const en = enrichOf("template", mine.map((t) => t.id));
    const items = mine.map((t) => publicTemplate(t, user, en(t.id)));
    return send(res, 200, { ok: true, items, user: publicUser(user) });
  }

  if (method === "GET" && p === "/api/tags") {
    const kind = String(url.searchParams.get("kind") || "templates").toLowerCase();
    return send(res, 200, {
      ok: true,
      tags: tagCounts(kind === "skills" ? "skills" : "templates"),
    });
  }

  if (method === "GET" && p === "/api/templates") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const tag = normalizeTag(url.searchParams.get("tag") || "");
    const sort = String(url.searchParams.get("sort") || "new");
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));
    let list = db.templates.slice();
    if (tag) list = list.filter((t) => (t.tags || []).includes(tag));
    if (q) {
      list = list.filter((t) => {
        const owner = db.users.find((u) => u.id === t.userId);
        const blob = [
          t.title,
          t.description,
          (t.tags || []).join(" "),
          owner && owner.nickname,
          owner && owner.username,
        ]
          .join(" ")
          .toLowerCase();
        return blob.includes(q);
      });
    }
    if (sort === "downloads") list.sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || b.createdAt - a.createdAt);
    else if (sort === "likes") list.sort((a, b) => (b.likes || 0) - (a.likes || 0) || b.createdAt - a.createdAt);
    /* 「打赏热度」：累计打赏额高的在前（同额比次数、再比时间）—— 需求口径
       「打赏总额与次数对所有人在条目上可见，并计入按热度排序」。
       额度用 batchSummaryOf 一次遍历整张打赏表算出来（不在比较函数里逐项查库 → 不是 N²）。 */
    else if (sort === "tips") {
      const tm = plans.batchSummaryOf("template", list.map((t) => t.id));
      const cellOf = (id) => tm.get(String(id || "")) || { count: 0, totalYuan: 0 };
      list.sort((a, b) => {
        const x = cellOf(a.id);
        const y = cellOf(b.id);
        return y.totalYuan - x.totalYuan || y.count - x.count || b.createdAt - a.createdAt;
      });
    } else list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const pageItems = list.slice((page - 1) * pageSize, page * pageSize);
    const en = enrichOf("template", pageItems.map((t) => t.id));
    const items = pageItems.map((t) => publicTemplate(t, user, en(t.id)));
    return send(res, 200, { ok: true, items, total, page, pageSize, tags: tagCounts("templates") });
  }

  const one = /^\/api\/templates\/([^/]+)$/.exec(p);
  const fileR = /^\/api\/templates\/([^/]+)\/file$/.exec(p);
  const prevR = /^\/api\/templates\/([^/]+)\/preview$/.exec(p);
  const likeR = /^\/api\/templates\/([^/]+)\/like$/.exec(p);

  if (fileR && method === "GET") {
    const t = db.templates.find((x) => x.id === fileR[1]);
    if (!t) return send(res, 404, { ok: false, error: "模板不存在" });
    const fp = path.join(FILE_DIR, t.id + ".mtnodes");
    if (!fs.existsSync(fp)) return send(res, 404, { ok: false, error: "文件缺失" });
    t.downloads = (t.downloads || 0) + 1;
    const owner = db.users.find((u) => u.id === t.userId);
    if (owner) await applyUserPatch(owner.id, { downloadsReceived: (owner.downloadsReceived || 0) + 1 });
    await saveDb();
    const buf = fs.readFileSync(fp);
    if (url.searchParams.get("format") === "raw") {
      return sendBin(res, 200, buf, "application/octet-stream");
    }
    return send(res, 200, {
      ok: true,
      id: t.id,
      title: t.title,
      bytes: buf.length,
      base64: buf.toString("base64"),
    });
  }

  if (prevR && method === "GET") {
    const t = db.templates.find((x) => x.id === prevR[1]);
    if (!t || !t.hasPreview) return send(res, 404, { ok: false, error: "无预览图" });
    const size = String(url.searchParams.get("size") || "thumb").toLowerCase();
    const fp = previewPath(t.id, size === "full" || size === "large" ? "full" : "thumb");
    if (!fp) return send(res, 404, { ok: false, error: "无预览图" });
    const headers = {
      "Cache-Control": size === "full" || size === "large" ? "public, max-age=3600" : "public, max-age=86400",
    };
    return sendBin(res, 200, fs.readFileSync(fp), previewMime(fp), headers);
  }

  if (one && method === "GET") {
    const t = db.templates.find((x) => x.id === one[1]);
    if (!t) return send(res, 404, { ok: false, error: "模板不存在" });
    return send(res, 200, { ok: true, item: publicTemplate(t, user) });
  }

  if (method === "POST" && p === "/api/templates") {
    if (!user) return send(res, 401, { ok: false, error: "上传需要登录" });
    const b = await jsonBody();
    requireFields(b, ["title", "fileBase64"]);
    const title = String(b.title).trim().slice(0, 80);
    const description = String(b.description || "").trim().slice(0, 2000);
    const tags = parseTags(b.tags);
    let buf;
    try {
      buf = decodeMtNodes(b.fileBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "不是有效的 .mtnodes 模板：" + e.message });
    }
    if (buf.length > MAX_TEMPLATE) {
      return send(res, 413, { ok: false, error: "模板文件不能超过 10MB" });
    }
    let prev = null;
    let thumb = null;
    try {
      prev = decodePreview(b.previewBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "预览图无效：" + e.message });
    }
    try {
      thumb = decodePreview(b.previewThumbBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "缩略图无效：" + e.message });
    }
    const id = uid("t_");
    fs.writeFileSync(path.join(FILE_DIR, id + ".mtnodes"), buf);
    if (prev) writePreview(id, prev, thumb);
    const t = {
      id,
      userId: user.id,
      title,
      description,
      tags,
      downloads: 0,
      likes: 0,
      bytes: buf.length,
      hasPreview: !!prev,
      createdAt: now(),
      updatedAt: now(),
    };
    db.templates.push(t);
    await saveDb();
    return send(res, 200, { ok: true, item: publicTemplate(t, user) });
  }

  if (one && method === "PATCH") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    const t = db.templates.find((x) => x.id === one[1]);
    if (!t) return send(res, 404, { ok: false, error: "模板不存在" });
    if (t.userId !== user.id) return send(res, 403, { ok: false, error: "只能编辑自己的模板" });
    const b = await jsonBody();
    if (b.title != null) {
      const title = String(b.title).trim().slice(0, 80);
      if (!title) return send(res, 400, { ok: false, error: "标题不能为空" });
      t.title = title;
    }
    if (b.description != null) t.description = String(b.description).trim().slice(0, 2000);
    if (b.tags != null) t.tags = parseTags(b.tags);
    if (b.fileBase64) {
      let buf;
      try {
        buf = decodeMtNodes(b.fileBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "不是有效的 .mtnodes 模板：" + e.message });
      }
      if (buf.length > MAX_TEMPLATE) {
        return send(res, 413, { ok: false, error: "模板文件不能超过 10MB" });
      }
      fs.writeFileSync(path.join(FILE_DIR, t.id + ".mtnodes"), buf);
      t.bytes = buf.length;
    }
    if (b.previewBase64 === "") {
      clearPreviews(t.id);
      t.hasPreview = false;
    } else if (b.previewBase64) {
      let prev;
      let thumb = null;
      try {
        prev = decodePreview(b.previewBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "预览图无效：" + e.message });
      }
      try {
        thumb = decodePreview(b.previewThumbBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "缩略图无效：" + e.message });
      }
      if (prev) {
        writePreview(t.id, prev, thumb);
        t.hasPreview = true;
      }
    }
    t.updatedAt = now();
    await saveDb();
    return send(res, 200, { ok: true, item: publicTemplate(t, user) });
  }

  if (one && method === "DELETE") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    const idx = db.templates.findIndex((x) => x.id === one[1]);
    if (idx < 0) return send(res, 404, { ok: false, error: "模板不存在" });
    const t = db.templates[idx];
    if (t.userId !== user.id && !isAdmin(user)) {
      return send(res, 403, { ok: false, error: "只能删除自己的模板" });
    }
    const owner = db.users.find((u) => u.id === t.userId) || user;
    await applyUserPatch(owner.id, {
      downloadsReceived: Math.max(0, (owner.downloadsReceived || 0) - (t.downloads || 0)),
      likesReceived: Math.max(0, (owner.likesReceived || 0) - (t.likes || 0)),
    });
    db.likes = db.likes.filter((l) => l.templateId !== t.id);
    db.templates.splice(idx, 1);
    try { fs.unlinkSync(path.join(FILE_DIR, t.id + ".mtnodes")); } catch {}
    clearPreviews(t.id);
    await saveDb();
    return send(res, 200, { ok: true });
  }

  if (likeR && method === "POST") {
    if (!user) return send(res, 401, { ok: false, error: "点赞需要登录" });
    const t = db.templates.find((x) => x.id === likeR[1]);
    if (!t) return send(res, 404, { ok: false, error: "模板不存在" });
    const hit = db.likes.find((l) => l.userId === user.id && l.templateId === t.id);
    const owner = db.users.find((u) => u.id === t.userId);
    if (hit) {
      db.likes = db.likes.filter((l) => !(l.userId === user.id && l.templateId === t.id));
      t.likes = Math.max(0, (t.likes || 0) - 1);
      if (owner) await applyUserPatch(owner.id, { likesReceived: Math.max(0, (owner.likesReceived || 0) - 1) });
    } else {
      db.likes.push({ userId: user.id, templateId: t.id, at: now() });
      t.likes = (t.likes || 0) + 1;
      if (owner) await applyUserPatch(owner.id, { likesReceived: (owner.likesReceived || 0) + 1 });
    }
    await saveDb();
    return send(res, 200, { ok: true, item: publicTemplate(t, user) });
  }

  if (method === "GET" && p === "/api/me/skills") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    const mine = db.skills
      .filter((t) => t.userId === user.id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const en = enrichOf("skill", mine.map((t) => t.id));
    const items = mine.map((t) => publicSkill(t, user, en(t.id)));
    return send(res, 200, { ok: true, items, user: publicUser(user) });
  }

  if (method === "GET" && p === "/api/skills") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const tag = normalizeTag(url.searchParams.get("tag") || "");
    const sort = String(url.searchParams.get("sort") || "new");
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));
    let list = db.skills.slice();
    if (tag) list = list.filter((t) => (t.tags || []).includes(tag));
    if (q) {
      list = list.filter((t) => {
        const owner = db.users.find((u) => u.id === t.userId);
        const blob = [
          t.title,
          t.skillName,
          t.description,
          t.version,
          (t.tags || []).join(" "),
          owner && owner.nickname,
          owner && owner.username,
          t.official ? "official 官方" : "",
        ]
          .join(" ")
          .toLowerCase();
        return blob.includes(q);
      });
    }
    if (sort === "downloads") list.sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || b.createdAt - a.createdAt);
    else if (sort === "likes") list.sort((a, b) => (b.likes || 0) - (a.likes || 0) || b.createdAt - a.createdAt);
    else if (sort === "official") {
      list.sort(
        (a, b) =>
          Number(!!b.official) - Number(!!a.official) || b.createdAt - a.createdAt,
      );
    } else if (sort === "tips") {
      /* 打赏热度（与模板同一口径）：累计打赏额 → 次数 → 时间；一次批量算，不逐项查库 */
      const tm = plans.batchSummaryOf("skill", list.map((t) => t.id));
      const cellOf = (id) => tm.get(String(id || "")) || { count: 0, totalYuan: 0 };
      list.sort((a, b) => {
        const x = cellOf(a.id);
        const y = cellOf(b.id);
        return y.totalYuan - x.totalYuan || y.count - x.count || b.createdAt - a.createdAt;
      });
    } else list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const pageItems = list.slice((page - 1) * pageSize, page * pageSize);
    const en = enrichOf("skill", pageItems.map((t) => t.id));
    const items = pageItems.map((t) => publicSkill(t, user, en(t.id)));
    return send(res, 200, { ok: true, items, total, page, pageSize, tags: tagCounts("skills") });
  }

  const skillOne = /^\/api\/skills\/([^/]+)$/.exec(p);
  const skillFileR = /^\/api\/skills\/([^/]+)\/file$/.exec(p);
  const skillPrevR = /^\/api\/skills\/([^/]+)\/preview$/.exec(p);
  const skillLikeR = /^\/api\/skills\/([^/]+)\/like$/.exec(p);

  if (skillFileR && method === "GET") {
    const t = db.skills.find((x) => x.id === skillFileR[1]);
    if (!t) return send(res, 404, { ok: false, error: "技能不存在" });
    const pack = readSkillBundle(t.id);
    if (!pack) return send(res, 404, { ok: false, error: "文件缺失" });
    t.downloads = (t.downloads || 0) + 1;
    const owner = db.users.find((u) => u.id === t.userId);
    if (owner) await applyUserPatch(owner.id, { downloadsReceived: (owner.downloadsReceived || 0) + 1 });
    const listed = listSkillBundleFiles(t.id);
    t.files = listed.files;
    t.bytes = listed.bytes;
    await saveDb();
    if (url.searchParams.get("format") === "raw") {
      return sendBin(res, 200, pack.mdBuf, "text/markdown; charset=utf-8");
    }
    return send(res, 200, {
      ok: true,
      id: t.id,
      skillName: t.skillName,
      title: t.title,
      version: t.version || "1.0.0",
      official: !!t.official,
      bytes: listed.bytes,
      files: listed.files,
      text: pack.mdBuf.toString("utf8"),
      base64: pack.mdBuf.toString("base64"),
      extras: pack.extras,
    });
  }

  if (skillPrevR && method === "GET") {
    const t = db.skills.find((x) => x.id === skillPrevR[1]);
    if (!t || !t.hasPreview) return send(res, 404, { ok: false, error: "无预览图" });
    const size = String(url.searchParams.get("size") || "thumb").toLowerCase();
    const fp = previewPath(t.id, size === "full" || size === "large" ? "full" : "thumb");
    if (!fp) return send(res, 404, { ok: false, error: "无预览图" });
    const headers = {
      "Cache-Control": size === "full" || size === "large" ? "public, max-age=3600" : "public, max-age=86400",
    };
    return sendBin(res, 200, fs.readFileSync(fp), previewMime(fp), headers);
  }

  if (skillOne && method === "GET") {
    const t = db.skills.find((x) => x.id === skillOne[1]);
    if (!t) return send(res, 404, { ok: false, error: "技能不存在" });
    return send(res, 200, { ok: true, item: publicSkill(t, user) });
  }

  if (method === "POST" && p === "/api/skills") {
    if (!user) return send(res, 401, { ok: false, error: "上传需要登录" });
    const b = await jsonBody();
    requireFields(b, ["fileBase64"]);
    let buf;
    try {
      buf = decodeUtf8Base64(b.fileBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "不是有效的 SKILL.md：" + e.message });
    }
    if (buf.length > MAX_SKILL_FILE) {
      return send(res, 413, { ok: false, error: "每个文件不能超过 200KB" });
    }
    let parsed;
    try {
      parsed = parseSkillMarkdown(buf);
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    let extras;
    try {
      extras = decodeSkillExtraFiles(b.files != null ? b.files : b.extras);
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    if (extras == null) extras = [];
    const title = String(b.title != null ? b.title : parsed.title).trim().slice(0, 80);
    if (!title) return send(res, 400, { ok: false, error: "标题不能为空" });
    const description = String(
      b.description != null ? b.description : parsed.description,
    )
      .trim()
      .slice(0, 2000);
    let version;
    try {
      version = normalizeVersion(b.version != null ? b.version : parsed.version, "1.0.0");
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    const tags = parseTags(b.tags);
    const wantOfficial = !!b.official;
    if (wantOfficial && !isAdmin(user)) {
      return send(res, 403, { ok: false, error: "仅官方账号可标记官方 Skill" });
    }
    const dup = db.skills.find(
      (x) => String(x.skillName).toLowerCase() === parsed.skillName && !!x.official,
    );
    if (wantOfficial && dup) {
      return send(res, 409, { ok: false, error: "已存在同名官方 Skill，请先编辑或删除" });
    }
    let prev = null;
    let thumb = null;
    try {
      prev = decodePreview(b.previewBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "预览图无效：" + e.message });
    }
    try {
      thumb = decodePreview(b.previewThumbBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "缩略图无效：" + e.message });
    }
    const id = uid("s_");
    const listed = writeSkillBundle(id, buf, extras);
    if (prev) writePreview(id, prev, thumb);
    const t = {
      id,
      userId: user.id,
      skillName: parsed.skillName,
      title,
      description,
      version,
      official: wantOfficial,
      tags,
      downloads: 0,
      likes: 0,
      bytes: listed.bytes,
      files: listed.files,
      hasPreview: !!prev,
      createdAt: now(),
      updatedAt: now(),
    };
    db.skills.push(t);
    await saveDb();
    return send(res, 200, { ok: true, item: publicSkill(t, user) });
  }

  if (skillOne && method === "PATCH") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    const t = db.skills.find((x) => x.id === skillOne[1]);
    if (!t) return send(res, 404, { ok: false, error: "技能不存在" });
    if (t.userId !== user.id) return send(res, 403, { ok: false, error: "只能编辑自己的技能" });
    const b = await jsonBody();
    if (b.title != null) {
      const title = String(b.title).trim().slice(0, 80);
      if (!title) return send(res, 400, { ok: false, error: "标题不能为空" });
      t.title = title;
    }
    if (b.description != null) t.description = String(b.description).trim().slice(0, 2000);
    if (b.tags != null) t.tags = parseTags(b.tags);
    if (b.version != null) {
      try {
        t.version = normalizeVersion(b.version, t.version || "1.0.0");
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message || String(e) });
      }
    }
    if (b.official != null) {
      if (!isAdmin(user)) {
        return send(res, 403, { ok: false, error: "仅官方账号可标记官方 Skill" });
      }
      t.official = !!b.official;
    }
    let extras = undefined;
    if (b.files != null || b.extras != null) {
      try {
        extras = decodeSkillExtraFiles(b.files != null ? b.files : b.extras);
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message || String(e) });
      }
    }
    if (b.fileBase64) {
      let buf;
      try {
        buf = decodeUtf8Base64(b.fileBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "不是有效的 SKILL.md：" + e.message });
      }
      if (buf.length > MAX_SKILL_FILE) {
        return send(res, 413, { ok: false, error: "每个文件不能超过 200KB" });
      }
      let parsed;
      try {
        parsed = parseSkillMarkdown(buf);
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message || String(e) });
      }
      if (parsed.skillName !== t.skillName) {
        return send(res, 400, {
          ok: false,
          error: "不可更改 skill name（当前为 " + t.skillName + "）",
        });
      }
      const listed = writeSkillBundle(
        t.id,
        buf,
        extras != null ? extras : undefined,
      );
      // if extras omitted, still refresh list after md write
      const listed2 = extras != null ? listed : listSkillBundleFiles(t.id);
      t.bytes = listed2.bytes;
      t.files = listed2.files;
      if (b.version == null && parsed.version) {
        try {
          t.version = normalizeVersion(parsed.version, t.version || "1.0.0");
        } catch (e) {
          return send(res, 400, { ok: false, error: e.message || String(e) });
        }
      } else if (b.version == null) {
        return send(res, 400, { ok: false, error: "更新技能正文时请填写新版本号" });
      }
    } else if (extras != null) {
      const pack = readSkillBundle(t.id);
      if (!pack) return send(res, 404, { ok: false, error: "文件缺失" });
      const listed = writeSkillBundle(t.id, pack.mdBuf, extras);
      t.bytes = listed.bytes;
      t.files = listed.files;
      if (b.version == null) {
        return send(res, 400, { ok: false, error: "更新技能附件时请填写新版本号" });
      }
    }
    if (b.previewBase64 === "") {
      clearPreviews(t.id);
      t.hasPreview = false;
    } else if (b.previewBase64) {
      let prev;
      let thumb = null;
      try {
        prev = decodePreview(b.previewBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "预览图无效：" + e.message });
      }
      try {
        thumb = decodePreview(b.previewThumbBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "缩略图无效：" + e.message });
      }
      if (prev) {
        writePreview(t.id, prev, thumb);
        t.hasPreview = true;
      }
    }
    t.updatedAt = now();
    await saveDb();
    return send(res, 200, { ok: true, item: publicSkill(t, user) });
  }

  if (skillOne && method === "DELETE") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    const idx = db.skills.findIndex((x) => x.id === skillOne[1]);
    if (idx < 0) return send(res, 404, { ok: false, error: "技能不存在" });
    const t = db.skills[idx];
    if (t.userId !== user.id && !isAdmin(user)) {
      return send(res, 403, { ok: false, error: "只能删除自己的技能" });
    }
    const owner = db.users.find((u) => u.id === t.userId) || user;
    await applyUserPatch(owner.id, {
      downloadsReceived: Math.max(0, (owner.downloadsReceived || 0) - (t.downloads || 0)),
      likesReceived: Math.max(0, (owner.likesReceived || 0) - (t.likes || 0)),
    });
    db.skillLikes = db.skillLikes.filter((l) => l.skillId !== t.id);
    db.skills.splice(idx, 1);
    clearSkillFile(t.id);
    clearPreviews(t.id);
    await saveDb();
    return send(res, 200, { ok: true });
  }

  if (skillLikeR && method === "POST") {
    if (!user) return send(res, 401, { ok: false, error: "点赞需要登录" });
    const t = db.skills.find((x) => x.id === skillLikeR[1]);
    if (!t) return send(res, 404, { ok: false, error: "技能不存在" });
    const hit = db.skillLikes.find((l) => l.userId === user.id && l.skillId === t.id);
    const owner = db.users.find((u) => u.id === t.userId);
    if (hit) {
      db.skillLikes = db.skillLikes.filter((l) => !(l.userId === user.id && l.skillId === t.id));
      t.likes = Math.max(0, (t.likes || 0) - 1);
      if (owner) await applyUserPatch(owner.id, { likesReceived: Math.max(0, (owner.likesReceived || 0) - 1) });
    } else {
      db.skillLikes.push({ userId: user.id, skillId: t.id, at: now() });
      t.likes = (t.likes || 0) + 1;
      if (owner) await applyUserPatch(owner.id, { likesReceived: (owner.likesReceived || 0) + 1 });
    }
    await saveDb();
    return send(res, 200, { ok: true, item: publicSkill(t, user) });
  }

  /* ====================================================================== *
   * 应用市场（列表 / 详情 / 下载 / 上传 / 更新 / 删除 / 静态目录口径）
   * 口径见 docs/apps-market.md：owner 一律由服务端按登录态绑定，改 / 删仅 owner。
   * ====================================================================== */

  if (method === "GET" && p === "/api/apps") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const owner = String(url.searchParams.get("owner") || "").trim().toLowerCase();
    const sort = String(url.searchParams.get("sort") || "new").trim().toLowerCase();
    /* 两态口径（本轮）：列表就是整个库 —— 没有可见性开关，也没有「把隐藏条目一起带上」
       这种逃生参数（库里的应用一律在线上，被彻底删除的已不在 db.apps 里，自然列不出来）。 */
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));
    let list = (db.apps || []).slice();
    // 按 owner 过滤：username 或 userId 都认（上传脚本用 ?owner=<自己> 找自己的应用）
    if (owner) {
      list = list.filter((a) => {
        const u = db.users.find((x) => x.id === a.userId);
        const name = u ? String(u.username || "").toLowerCase() : "";
        return name === owner || String(a.userId).toLowerCase() === owner;
      });
    }
    if (q) {
      list = list.filter((a) => {
        const e = appCatalogEntry(a);
        /* 搜索也认作者显示名（改了昵称之后按昵称也能搜到；owner 那份可能只是占位账号名） */
        return [e.id, e.title, e.desc, e.owner, e.ownerName, (e.tags || []).join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
    }
    if (sort === "downloads") {
      list.sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || (b.createdAt || 0) - (a.createdAt || 0));
    } else if (sort === "title") {
      list.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh"));
    } else {
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    const total = list.length;
    const pageItems = list.slice((page - 1) * pageSize, page * pageSize);
    /* 评论 / 评分**按分支**（本轮需求 4）：请求表带 { id, ownerId }，同一个 id 下每个作者各算各的；
       打赏仍按家族根统一（enrichOf 内部只把 id 交给 tips）。 */
    const en = enrichOf("app", pageItems.map((a) => ({ id: a.id, ownerId: a.userId })));
    const items = pageItems.map((a) => publicApp(a, user, en(a.id, a.userId)));
    return send(res, 200, { ok: true, items, total, page, pageSize });
  }

  // 静态目录口径（与手写清单 store-saas/apps/catalog.json 同一份字段）：
  // 把它原样落成 /var/www/mtnode/apps/catalog.json，即为客户端读的那个线上目录。
  // 静态目录写不进去时（缺权限 / 路径不存在，见 publishStaticApps 的告警），
  // 客户端会回退到这里 —— 所以本接口必须始终可用，返回的就是同一份 appCatalogDoc()。
  if (method === "GET" && (p === "/api/apps/catalog" || p === "/api/apps/catalog.json")) {
    /* 目录类：gzip + ETag + max-age=60（见 sendCatalogJson 的注释）。1000 条时这份响应最大，
       客户端每次进应用中心都读它，所以它是本轮最值得省的一条。 */
    return sendCatalogJson(req, res, appCatalogDoc());
  }

  // 静态目录体检（免登录、只读）：给上线自检与排查用 —— 条数对不对、文件在不在、有没有降级。
  if (method === "GET" && p === "/api/apps/pub") {
    return send(res, 200, Object.assign({ ok: true }, staticAppsStatus(), { gzip: gzipStatus(), hot: hotStats(), slow: slowReport() }));
  }

  /* 上架截图链路体检（只读、免登录）：**全链路可观测**的入口 —— 截图没落盘时先打这一条，
     一眼看出断在哪一环（有没有收下 / 解码过没过 / 压了多少 / 落盘几个文件 / 静态目录同步没有）。
     口径与 appShotsDiag 同一处实现（管理台与部署自检也读它）。 */
  const appShotsDiagR = /^\/api\/apps\/([^/]+)\/shots-diag$/.exec(p);
  if (appShotsDiagR && method === "GET") {
    const rb = appResolveBranch(appShotsDiagR[1], url.searchParams.get("owner"));
    const a = rb.app;
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    return send(res, 200, Object.assign({ ok: true }, appShotsDiag(a), {
      /* 客户端上一次上传声明的张数（没有记录就是 null：这次上架还没带 shots[]） */
      maxShots: MAX_APP_SHOTS,
      maxShotBytes: MAX_APP_SHOT_BYTES,
      maxEdge: APP_SHOT_MAX_EDGE,
      catalogShots: appCatalogEntry(a).shots || [],
    }));
  }

  /* 内容寻址图片库（本轮需求）：客户端按内容指纹问「这张图云端有没有」——
      · GET  /api/apps/object/<sha256>      → 有：200 {ok,sha,bytes,ext,tw,th}；没有：404 OBJ_NOT_FOUND
      · POST /api/apps/objects/exist        → 批量版（最多 OBJ_EXIST_MAX 个，见下面那条路由）
      · GET  /api/apps/objfile/<sha256>     → 直出图片字节（?size=list 出长边 1280 的小图）
     免登录、只读：客户端据此把「已经传过的图」改成只发引用，不再重推字节（省服务器流量）。 */
  const appObjR = /^\/api\/apps\/object\/([0-9a-fA-F]{64})$/.exec(p);
  if (appObjR && method === "GET") {
    const sha = appObjR[1].toLowerCase();
    let hold = null;
    let ext = "";
    for (const e of ["png", "jpg", "jpeg", "webp"]) {
      hold = imgObjHold(sha, e, "");
      if (hold) {
        ext = e;
        break;
      }
    }
    if (!hold) return send(res, 404, { ok: false, code: "OBJ_NOT_FOUND", error: "云端没有这份图片（请重传一次）" });
    let tw = 0;
    let th = 0;
    try {
      const dec = decodeImage(fs.readFileSync(hold.path));
      if (dec) {
        tw = dec.w;
        th = dec.h;
      }
    } catch (_) {}
    return send(res, 200, { ok: true, sha, bytes: hold.bytes, ext, tw, th, size: APP_SHOT_LIST_EDGE, maxEdge: APP_SHOT_MAX_EDGE });
  }
  const appObjFileR = /^\/api\/apps\/objfile\/([0-9a-fA-F]{64})$/.exec(p);
  if (appObjFileR && method === "GET") {
    const sha = appObjFileR[1].toLowerCase();
    const wantList = String(url.searchParams.get("size") || "").toLowerCase() === "list";
    let hold = null;
    let ext = "";
    for (const e of ["png", "jpg", "jpeg", "webp"]) {
      hold = imgObjHold(sha, e, "");
      if (hold) {
        ext = e;
        break;
      }
    }
    if (!hold) return send(res, 404, { ok: false, code: "OBJ_NOT_FOUND", error: "云端没有这份图片" });
    let file = hold.path;
    if (wantList) {
      const small = imgObjHold(sha, ext, SHOT_LIST_SUFFIX);
      if (small) {
        file = small.path;
      } else {
        try {
          const dec = makeAppShot(fs.readFileSync(hold.path), { maxEdge: APP_SHOT_LIST_EDGE });
          if (dec && dec.buf && dec.changed) {
            const put = imgObjPut(dec.buf, ext, SHOT_LIST_SUFFIX);
            try { fs.utimesSync(put.path, fs.statSync(hold.path).atime, fs.statSync(hold.path).mtime); } catch (_) {}
            file = put.path;
          }
        } catch (_) {}
      }
    }
    return sendBin(res, 200, fs.readFileSync(file), previewMime(file), { "Cache-Control": "public, max-age=86400" });
  }

  /* 图片内容指纹**批量**查存（本轮需求）：客户端上架窗在提交前把这一批截图的内容指纹一次问完，
     命中就只发 { sha } 引用、**不再把字节推上云**（省云服务器流量；别人传过的同一张图也命中）。
       · POST /api/apps/objects/exist  body { shas: ["<sha256>", …] }（最多 OBJ_EXIST_MAX 个）
       · 回执 { ok, items:[{sha, exists, bytes, ext}], have:[sha…], missing:[sha…] }
     免登录、只读 —— 与单张 GET /api/apps/object/<sha> 同口径（那条仍保留，老客户端不受影响）。
     只回字节数与扩展名（不回 tw/th：批量路径上**不做图片解码**，那会让一次查存变贵）。 */
  if (method === "POST" && p === "/api/apps/objects/exist") {
    const gate = ipGate("obj-exist", clientIp(req), OBJ_EXIST_IP_HOURLY_MAX);
    if (!gate.ok) return rateLimited(res, gate);
    let body = {};
    try {
      body = await jsonBody();
    } catch (err) {
      return send(res, err && err.status ? err.status : 400, { ok: false, error: "请求体不是合法 JSON" });
    }
    ipCommit(gate);
    const raw = Array.isArray(body && body.shas) ? body.shas : [];
    if (!raw.length) return send(res, 200, { ok: true, items: [], have: [], missing: [], checked: 0 });
    if (raw.length > OBJ_EXIST_MAX) {
      return send(res, 400, {
        ok: false,
        code: "TOO_MANY_SHAS",
        error: "一次最多查 " + OBJ_EXIST_MAX + " 个指纹（本次 " + raw.length + " 个）",
      });
    }
    const seen = new Set();
    const items = [];
    const have = [];
    const missing = [];
    for (const x of raw) {
      const sha = String(x == null ? "" : x).trim().toLowerCase();
      /* 非法 / 重复的指纹不报错（客户端那一侧只要知道「有没有」）：非法一律并进 missing，
         重复只算一次（客户端本来就会在本地去重，这里再兜一层）。 */
      if (!/^[0-9a-f]{64}$/.test(sha)) continue;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const hit = imgObjHoldAnyExt(sha);
      items.push(hit ? { sha: sha, exists: true, bytes: hit.hold.bytes, ext: hit.ext } : { sha: sha, exists: false, bytes: 0, ext: "" });
      (hit ? have : missing).push(sha);
    }
    return send(res, 200, { ok: true, items: items, have: have, missing: missing, checked: items.length });
  }

  /* 我的应用存储用量与上限（本轮需求：客户端上架窗据此显示「已用 / 上限」，
     管理员在后台给单个用户调过的值也走它）。必须登录；只是只读查询，不触发任何发布。
     路由放在 /api/apps/:id 之前（否则会被那条当成 id="storage"）。 */
  if (method === "GET" && p === "/api/apps/storage") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "查询存储用量需要登录" });
    return send(res, 200, { ok: true, storage: appStorageViewOf(user) });
  }

  const appOne = /^\/api\/apps\/([^/]+)$/.exec(p);
  const appFileR = /^\/api\/apps\/([^/]+)\/file$/.exec(p);
  const appIconR = /^\/api\/apps\/([^/]+)\/icon$/.exec(p);
  /* 上架截图单张：/api/apps/<id>/shots/<n>（n 从 1 起，顺序 = 作者排的顺序） */
  const appShotR = /^\/api\/apps\/([^/]+)\/shots\/(\d+)$/.exec(p);
  const appThumbR = /^\/api\/apps\/([^/]+)\/thumb$/.exec(p);
  const appVersionsR = /^\/api\/apps\/([^/]+)\/versions$/.exec(p);
  const appVersionOneR = /^\/api\/apps\/([^/]+)\/versions\/([^/]+)$/.exec(p);

  // 版本树数据（免登录，公开信息）：客户端详情区的「版本」块按它渲染。
  // 开关关闭时也用单版字段合成一项，客户端只有一条读路径。
  if (appVersionsR && method === "GET") {
    const rb = appResolveBranch(appVersionsR[1], url.searchParams.get("owner"));
    const a = rb.app;
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    return send(res, 200, {
      ok: true,
      id: a.id,
      ownerId: a.userId,
      owner: appOwnerNameOf(a.userId),
      ownerName: accountDisplayNameOf(a.userId),
      trunkOwnerId: rb.trunk ? rb.trunk.userId : "",
      branches: appBranchViewOf(a.id, user),
      latestVersion: appLatestVersion(a),
      versions: appVersionsPublic(a),
    });
  }

  // 追加版本（仅 owner，必须 acceptDeclaration）：一版一包落 <id>/<version>.zip，
  // 同时把最新版刷成 <id>.zip 镜像（老客户端 / 静态目录口径不变）。
  // 同 id 多分支（契约 §十）：body.ownerId 指定往哪条分支追加（缺省 = 我自己那条；不是我的 → 403）。
  if (appVersionsR && method === "POST") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "追加版本需要登录" });
    const id = String(appVersionsR[1] || "");
    const b = await jsonBody();
    const askedOwner = appResolveOwnerId(b.ownerId != null ? b.ownerId : b.owner);
    const a = appBranchOfOwner(id, askedOwner || user.id) || appBranchOfOwner(id, user.id);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    if (a.userId !== user.id) return send(res, 403, { ok: false, error: "只能给自己的分支追加版本" });
    if (!appVersionsOn()) {
      // 单版模式下追加版本无处安放（<id>.zip 只有一份）：明确报错，不静默覆盖旧包。
      return send(res, 409, {
        ok: false,
        code: "APP_VERSIONS_DISABLED",
        error:
          "服务端未启用应用多版本（MTNODE_APP_VERSIONS 被显式设成了 " + APP_VERSIONS_ENV +
          "，去掉该项或设 1 即打开）；单版模式请用 PATCH /api/apps/" +
          a.id + " 覆盖更新",
      });
    }
    // 声明（契约 §7.3）：没勾选就不落任何盘。
    if (b.acceptDeclaration !== true) return declarationRequired(res);
    requireFields(b, ["version"]);
    let version;
    try {
      version = normalizeVersion(b.version, a.latestVersion || a.version || "1.0.0");
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    /* 同版本号 = **覆盖这一版**，不再 409（用户口径：更新时应当允许同版本更新）。
       为什么改：作者改完 bug 想「还叫 1.0.1」，原来只回一句「请换一个版本号」——他要的更新做不成，
       只能被迫编个新号（或在版本列表里先删旧版再传，中间那段时间线上没有可分发的包）。
       现在：这一版就地换成新包（版本位置 / 父版关系 / 其它版本记录都不动），回执带 replaced=true
       让客户端明说「覆盖了已存在的 vX」。 */
    const dupIdx = appVersionRecords(a).findIndex((v) => v.version === version);
    const replacing = dupIdx >= 0;
    let nextTitle = null;
    if (b.title != null) {
      nextTitle = String(b.title).trim().slice(0, 80);
      if (!nextTitle) return send(res, 400, { ok: false, error: "标题不能为空" });
    }
    const nextDesc =
      b.description != null || b.desc != null
        ? String(b.description != null ? b.description : b.desc).trim().slice(0, 2000)
        : null;
    const nextTags = b.tags != null ? parseTags(b.tags) : null;
    let buf;
    try {
      buf = decodeAppZip(b.zipBase64 != null ? b.zipBase64 : b.fileBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "不是有效的小应用 zip：" + (e.message || e) });
    }
    let entry = "";
    try {
      entry = detectAppEntry(b.entry, zipEntryNames(buf));
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    if (!entry) {
      return send(res, 400, { ok: false, error: "包内找不到入口页（顶层需有 index.html，或显式传 entry）" });
    }
    let iconBuf = null;
    let clearIcon = false;
    if (b.iconBase64 === "") {
      clearIcon = true;
    } else if (b.iconBase64) {
      try {
        iconBuf = decodePreview(b.iconBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "图标无效：" + (e.message || e) });
      }
    }
    /* 上架截图（本轮需求：多图落盘）：带了这个键就整批替换；没带就原样留着（别的调用方不受影响） */
    const shotsGiven = b.shotsBase64 != null;
    const shotsIn = shotsGiven ? decodeAppShots(b.shotsBase64) : null;
    if (shotsIn && !shotsIn.ok) return send(res, 400, { ok: false, error: shotsIn.errors[0] || "截图无效" });
    // 父版本：显式传入优先，否则 = 当前 latestVersion（第一版传空串）。
    let parentVersion = appLatestVersion(a);
    if (b.parentVersion != null) {
      const pv = String(b.parentVersion).trim();
      if (!pv) {
        parentVersion = "";
      } else {
        try {
          parentVersion = normalizeVersion(pv, "");
        } catch (e) {
          return send(res, 400, { ok: false, error: "parentVersion 无效：" + (e.message || e) });
        }
      }
    }
    /* 配额：全部校验通过之后、落盘之前（契约 §7.5）。口径 = 该用户的存储上限
       （包 + 截图 + 图标；本次要加的**新图片**也算进去，重复的图不重复计）。 */
    const newShotBytes = (shotsIn && shotsIn.ok ? shotsIn.shots : []).reduce(
      (n, s) => n + (s && s.reused ? 0 : Number(s && s.bytes) || 0),
      0,
    );
    const q = appQuotaError(user.id, buf.length + newShotBytes, 0, false);
    if (q) return send(res, q.status, q.body);

    writeAppZipFiles(a.id, version, buf, a.userId);
    if (clearIcon) clearAppIcon(a.id, a.userId);
    else if (iconBuf) writeAppIcon(a.id, a.userId, iconBuf);
    /* 截图：**追加 + 按内容去重**（保留这条分支已有的图）—— 原来这里是整批替换，
       作者上传一版新包只带本次新加的图，旧图整套被删（用户报的「更新后截图消失」）。 */
    let shotsDiag = null;
    if (shotsIn && shotsIn.ok) {
      shotsDiag = appendAppShots(a.id, a.userId, shotsIn.shots, a);
      if (!shotsDiag.ok) {
        return send(res, 400, { ok: false, code: "TOO_MANY_SHOTS", error: shotsDiag.errors[0] || "截图过多" });
      }
      /* 封面源就是截图第 1 张：图变了必须作废缩略图缓存（否则卡片还是老图） */
      if (shotsDiag.added) clearAppThumb(a.id, a.userId);
    }
    /* 「这张图云端已经有了」的哈希名单：客户端据此在**下一次**上架时只发引用、不发字节。 */
    const shotShas = appShotEntriesOf(a.id, a.userId, a).map((e) => e.sha);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    /* 这次的包与线上**当前那一版**内容一模一样吗（同号同内容的重传）：只用来回执
       `unchanged:true` 与「其实一个字节都没变」的如实提示 —— 同号重传一律接受，绝不回错误。 */
    const unchanged = !!sha && sha === String(a.sha256 || "");
    const rec = makeAppVersion({
      version,
      parentVersion,
      buf,
      sha256: sha,
      entry,
      note: b.versionNote != null ? b.versionNote : b.note,
      user,
    });
    /* 覆盖同版本：**就地换掉那一条记录**（位置不动 = 版本树顺序不变），其余版本照旧。
       追加：照旧接在末尾。 */
    const recs = appVersionRecords(a).slice();
    if (replacing) recs[dupIdx] = rec;
    else recs.push(rec);
    a.versions = recs;
    a.latestVersion = version;
    a.version = version; // 老字段 = 最新版版本号（语义不变）
    /* 本轮两态收敛后这里**什么都不用复位**：库里有这一条 = 它就在线上（追加 / 同号覆盖
       走的都是同一条路），再没有「有包却看不见」那种需要复位的状态（见上方可见性开关那条注释）。 */
    a.bytes = buf.length;
    a.sha256 = sha;
    a.entry = entry;
    if (nextTitle != null) a.title = nextTitle;
    if (nextDesc != null) a.description = nextDesc;
    /* 标签继承：空值不清空（见 appTagsNext 注释）——追加 / 覆盖一版是「同一件事的新一版」，
       标签属于应用本身，作者没重填就该原样留着。 */
    if (nextTags != null) a.tags = appTagsNext(nextTags, a.tags);
    /* 二次开发来源：本次带了这个键就按它改（null / 空对象 = 清掉声明，回到原创）；
       没带键 = 保持原样（追加一版不该悄悄抹掉上一版声明的来源）。 */
    if (b.forkOf !== undefined) {
      const fo = normalizeForkOf(b.forkOf, a.id, a.userId);
      if (fo) a.forkOf = fo;
      else delete a.forkOf;
    }
    a.updatedAt = now();
    a.shots = { shas: shotShas };
    recordAppDeclaration(req, user, a.id, version, "version");
    await saveDb();
    syncAppZipMirror(a);
    publishStaticApps("追加版本 " + a.id + "@" + version + "（" + appOwnerNameOf(a.userId) + "）");
    return send(res, 200, {
      ok: true,
      version,
      ownerId: a.userId,
      replaced: replacing, // true = 覆盖了这一分支已存在的同号版本（客户端据此提示「已覆盖 vX」）
      /* 这次带的包与线上那一版内容一模一样（sha256 相同）：照旧算成功，只是如实说一句 */
      unchanged: replacing && unchanged,
      shots: shotsDiag ? { added: shotsDiag.added, total: shotsDiag.total } : null,
      /* 每用户存储上限的当期用量（客户端上架窗据此显示「已用 / 上限」，不用另开接口） */
      storage: appStorageViewOf(user),
      branches: appBranchViewOf(a.id, user),
      item: publicApp(a, user),
      catalog: appCatalogEntry(a),
    });
  }

  // 删某一版（仅 owner）：包与版本记录一起下掉（不留灰行），配额当场释放。
  // 同 id 多分支（契约 §十）：?owner= 指定分支；多条分支时不传 owner 直接拒绝（q30）。
  if (appVersionOneR && method === "DELETE") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "删除版本需要登录" });
    const id = String(appVersionOneR[1] || "");
    const all = appBranchesOf(id);
    if (!all.length) return send(res, 404, { ok: false, error: "应用不存在" });
    const askedDel = appResolveOwnerId(url.searchParams.get("owner"));
    if (!askedDel && all.length > 1) {
      return send(res, 400, {
        ok: false,
        code: "BRANCH_REQUIRED",
        error:
          "这个 id 下有 " + all.length + " 个作者分支：删除版本请用 ?owner=<作者 uid 或账号名> 指明分支" +
          "（自己的分支就是你的账号）",
      });
    }
    const a = appBranchOfOwner(id, askedDel || user.id);
    if (!a) {
      return send(res, 404, { ok: false, code: "BRANCH_NOT_FOUND", error: "这个 id 下没有该作者的分支" });
    }
    if (a.userId !== user.id) return send(res, 403, { ok: false, error: "只能删除自己分支的版本" });
    if (!appVersionsOn()) {
      return send(res, 409, {
        ok: false,
        code: "APP_VERSIONS_DISABLED",
        error: "服务端未启用应用多版本（MTNODE_APP_VERSIONS 被显式设成了 " + APP_VERSIONS_ENV +
          "）：单版模式没有可分删的版本记录",
      });
    }
    let want = appVersionOneR[2];
    try { want = decodeURIComponent(want); } catch {}
    const recs = appVersionRecords(a).slice();
    const vi = recs.findIndex((v) => v.version === want);
    /* 老单版记录（**没有 versions 字段**，开关关闭时建的）：界面上那一版是接口按单版字段
       合成的（见 appVersionsPublic / appCatalogVersions），删它 = 真的把这一版删掉 ——
       不再回 VERSION_NOT_FOUND（那会让界面上一版永远删不掉，正是用户报的那条）。 */
    const legacyOnly = vi < 0 && !appHasVersionField(a) && want === String(a.version || "");
    if (vi < 0 && !legacyOnly) {
      return send(res, 404, { ok: false, code: "VERSION_NOT_FOUND", error: "该版本不存在：v" + want });
    }
    /* 删除前的元信息快照：这一版可能正好是**最后一版**（下面要走彻底删除 + 已删除留痕），
       版本记录一旦被清空就再也算不出来了（见 appBranchDeleteMeta）。 */
    const delMeta = appBranchDeleteMeta(a);
    if (vi >= 0) recs.splice(vi, 1);
    a.versions = recs;
    /* 只删这一分支自己那份包：分支私有落点先删；老落点是同 id 共用的 —— 只有没有别的分支
       还在用这个版本号时才删它（否则会把别人的包一起删掉）。 */
    try { fs.unlinkSync(appBranchVersionZipPath(a.id, a.userId, want)); } catch {}
    if (!(db.apps || []).some((x) => x !== a && x.id === a.id && appVersionRecords(x).some((v) => v.version === want))) {
      try { fs.unlinkSync(appVersionZipPath(a.id, want)); } catch {}
    }
    if (!recs.length) {
      /* 全删光 = **这一分支彻底不存在**（本轮需求，用户口径：删掉最后一个版本后云端不留痕迹，
         而不是留一条看不见的记录）。为什么必须是真删：只置一个可见性位的话，记录 / 包 / 图标 /
         截图 / 静态目录条目全留着，作者以为删干净了，云端却还占着配额与目录。
         走 deleteAppBranch（与应用中心「删除」、管理台两条删除同一份实现，口径永远一致）：
         记录 + 包 + 图标 + 截图 + 封面缩略图 + 静态目录（含空目录）+ 无主对象一次清完。
         同一 id 下还有别的作者分支时，deleteAppBranch 会顺手留一条最小元信息
         （contentAudit / 已删除留痕，见 appDeletedLedgerPush）。 */
      const del = await deleteAppBranch(a, delMeta);
      await saveDb();
      publishStaticApps("删最后一版 = 彻底删除 " + a.id + "（" + appOwnerNameOf(a.userId) + "）");
      console.log(
        "[mtnode-store] 删最后一版 → 彻底删除分支 " + a.id + "/" + a.userId +
          "：静态文件 " + ((del.removed && del.removed.staticFiles) || []).length +
          " 个 / 空目录 " + ((del.removed && del.removed.staticDirs) || []).length +
          " 个 / 回收无主图片 " + ((del.imgGc && del.imgGc.removed) || 0) + " 个",
      );
      return send(res, 200, {
        ok: true,
        id: a.id,
        ownerId: a.userId,
        /* deleted:true = 这一版是最后一版，整条分支已被彻底删除（客户端据此说「云端已无这个应用」） */
        deleted: true,
        latestVersion: "",
        versions: [],
        branches: appBranchViewOf(a.id, user),
      });
    }
    /* 还有剩余版本：删的是最新版 → latestVersion 指向剩余最高版，并把镜像刷成它。 */
    const top = recs.reduce((best, v) => (compareVersions(v.version, best.version) > 0 ? v : best), recs[0]);
    a.latestVersion = top.version;
    a.version = top.version;
    a.bytes = Number(top.bytes) || 0;
    a.sha256 = top.sha256 || "";
    if (top.entry) a.entry = top.entry;
    syncAppZipMirror(a);
    a.updatedAt = now();
    await saveDb();
    publishStaticApps("删版本 " + a.id + "@" + want);
    return send(res, 200, { ok: true, id: a.id, latestVersion: a.latestVersion || "", versions: appVersionsPublic(a) });
  }

  // 作者侧可见性开关（POST /api/apps/:id/(unpublish|publish)）**已整体移除**：
  // 本轮产品口径收敛为「在线上 / 完全被删除」两态 —— 没有第三条可见性位，要撤下就删除（不可恢复）。
  // 旧路径如实回 404 +「该接口已下线」，绝不静默成功（老客户端还摆着那颗按钮时会收到明确答复）；
  // 管理台当年的内容可见性开关走的是另一条路由，同样已下线（见 /api/admin/content/publish 那条）。
  if (/^\/api\/apps\/([^/]+)\/(unpublish|publish)$/.test(p)) {
    return send(res, 404, { ok: false, code: "NOT_FOUND", error: "该接口已下线" });
  }

  if (appFileR && method === "GET") {
    // 同 id 多分支：?owner=<uid|账号名> 指定分支（缺省 = 主干）——下载寻址的唯一入口（q2）
    const rb = appResolveBranch(appFileR[1], url.searchParams.get("owner"));
    const a = rb.app;
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    // 多版本：?version=x.y.z 回指定版本、缺省回 latestVersion；关开关时该参数一律忽略（旧口径不变）。
    const wantVersion = appVersionsOn() ? String(url.searchParams.get("version") || "").trim() : "";
    const loc = locateAppZip(a, wantVersion);
    if (!loc) {
      return send(res, 404, {
        ok: false,
        code: wantVersion ? "VERSION_NOT_FOUND" : "FILE_MISSING",
        error: wantVersion ? "该版本不存在：v" + wantVersion : "文件缺失",
      });
    }
    const buf = fs.readFileSync(loc.path);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    a.downloads = (a.downloads || 0) + 1;
    const owner = db.users.find((u) => u.id === a.userId);
    if (owner) await applyUserPatch(owner.id, { downloadsReceived: (owner.downloadsReceived || 0) + 1 });
    await saveDb();
    if (url.searchParams.get("format") === "raw") {
      return sendBin(res, 200, buf, "application/zip", {
        "X-Content-SHA256": sha,
        "X-App-Owner": loc.ownerId || a.userId,
        "Content-Disposition": 'attachment; filename="' + appFileStem(a.id, loc.ownerId || a.userId) + '.zip"',
      });
    }
    return send(res, 200, {
      ok: true,
      id: a.id,
      ownerId: a.userId,
      title: a.title,
      version: loc.version,
      entry: loc.entry,
      bytes: buf.length,
      sha256: sha,
      zipUrl: appZipRelOf(a.id, a.userId, loc.version),
      base64: buf.toString("base64"),
    });
  }

  if (appIconR && method === "GET") {
    const rb = appResolveBranch(appIconR[1], url.searchParams.get("owner"));
    const a = rb.app;
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    const fp = appIconPath(a.id, a.userId) || appIconPath(a.id);
    if (!fp) return send(res, 404, { ok: false, error: "无图标" });
    return sendBin(res, 200, fs.readFileSync(fp), previewMime(fp), { "Cache-Control": "public, max-age=3600" });
  }

  // 封面缩略图（应用卡片的 16:9 背景图）：懒生成固定 640×360，落盘缓存（见 appThumbOf）。
  // 源 = 上架截图第 1 张（没有截图才退回图标）；生成不了（认不出的格式 / 源图比目标还小）
  // 就**回原图**（截图第 1 张 → 图标）：卡片照样有图，不报错、不 5xx。
  if (appThumbR && method === "GET") {
    const rb = appResolveBranch(appThumbR[1], url.searchParams.get("owner"));
    const a = rb.app;
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    const cache = { "Cache-Control": "public, max-age=604800" };
    const src = appCoverSourceOf(a.id, a.userId);
    const tp = appThumbOf(a, src);
    /* 读缩略图这一步也兜一层：文件在 appThumbOf 之后被清掉（并发清缓存）不该变成 5xx，
       读不到就当「没生成出来」，往下走「回原图」那条路。 */
    if (tp) {
      try {
        return sendBin(res, 200, fs.readFileSync(tp), "image/png", cache);
      } catch (err) {
        log("GET /api/apps/" + appThumbR[1] + "/thumb 读缩略图失败（回原图）：" + ((err && err.message) || err));
      }
    }
    /* 缩略图生成不了：原样回封面源（先是那张截图，再是图标）—— 卡片不能因为
       「源图比 640×360 还小 / 格式认不出」就没有封面。截图是 png，mime 按图标同法探测。 */
    const fp = (src && src.file) || appIconPath(a.id, a.userId) || appIconPath(a.id);
    if (!fp) return send(res, 404, { ok: false, error: "无封面图（既没有上架截图也没有图标）" });
    /* 源图刚被换掉 / 被清掉也不 5xx：读不到就如实 404（客户端按备选链退到下一张） */
    try {
      return sendBin(res, 200, fs.readFileSync(fp), previewMime(fp), cache);
    } catch (err) {
      log("GET /api/apps/" + appThumbR[1] + "/thumb 回原图失败：" + ((err && err.message) || err));
      return send(res, 404, { ok: false, error: "封面源读不到" });
    }
  }

  /* 上架截图单张（静态目录没有 shots/ 这条静态路由时客户端走这里，见 appsShotsUrlsOf）：
     免登录、只读；序号越界一律 404（不悄悄回第 1 张 —— 那会让画廊出现重复图）。
     ?size=list 出长边 1280 的列表小图（列表页用；生成不了就原样回原图，绝不 404）。 */
  if (appShotR && method === "GET") {
    const rb = appResolveBranch(appShotR[1], url.searchParams.get("owner"));
    const a = rb.app;
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    const n = Math.max(1, parseInt(appShotR[2], 10) || 1);
    const files = appShotFiles(a.id, a.userId);
    const fp = files[n - 1];
    if (!fp) return send(res, 404, { ok: false, error: "无这张截图" });
    const wantList = String(url.searchParams.get("size") || "").toLowerCase() === "list";
    if (wantList) {
      try {
        const parts = imgObjPartsOf(shotObjectOf(fp));
        if (parts) {
          let small = imgObjHold(parts.hash, parts.ext, SHOT_LIST_SUFFIX);
          if (!small) {
            const dec = makeAppShot(fs.readFileSync(parts.path), { maxEdge: APP_SHOT_LIST_EDGE });
            if (dec && dec.buf && dec.changed) small = imgObjPut(dec.buf, parts.ext, SHOT_LIST_SUFFIX);
          }
          if (small) return sendBin(res, 200, fs.readFileSync(small.path), previewMime(small.path), { "Cache-Control": "public, max-age=86400" });
        }
      } catch (_) {}
    }
    return sendBin(res, 200, fs.readFileSync(fp), previewMime(fp), { "Cache-Control": "public, max-age=3600" });
  }

  if (appOne && method === "GET") {
    // 同 id 多分支：?owner= 指定看哪条分支（缺省 = 主干），item 里附 branches[] 全量（q11）
    const rb = appResolveBranch(appOne[1], url.searchParams.get("owner"));
    const a = rb.app;
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    return send(res, 200, {
      ok: true,
      item: publicApp(a, user),
      ownerId: a.userId,
      trunkOwnerId: rb.trunk ? rb.trunk.userId : "",
      branches: appBranchViewOf(a.id, user),
    });
  }

  // 上传：必须登录，owner 由服务端绑定当前登录用户（客户端传的 userId 一律忽略）。
  if (method === "POST" && p === "/api/apps") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "上传应用需要登录" });
    const b = await jsonBody();
    // 声明（契约 §7.3）：新建必须 acceptDeclaration === true，否则不落任何盘。
    if (b.acceptDeclaration !== true) return declarationRequired(res);
    requireFields(b, ["id", "title"]);
    const id = normalizeAppId(b.id);
    if (!id) {
      return send(res, 400, {
        ok: false,
        error: "应用 id 不合法（2-64 位字母 / 数字 / . _ -，不能是 Windows 保留名；统一小写）",
      });
    }
    if ((db.apps || []).some((x) => x.id === id && x.userId === user.id)) {
      /* 同 id 多分支（契约 §十，q9）：我名下已经有这个 id → 这次上传就是给它追加版本，
         把请求原样交给追加路由（同一个 service 内递归调用自己会更绕，这里直接转语义）。 */
      return send(res, 409, {
        ok: false,
        code: "BRANCH_EXISTS",
        error:
          "你名下已经有 id「" + id + "」的应用：请用 POST /api/apps/" + id +
          "/versions 追加版本（同一个 id 同一位作者只保留一条分支）",
      });
    }
    /* 同 id 多分支（契约 §十 + 本轮需求「填同 id 就自动当分支，不再报已被占用」）：
       id 已被别人占用时**不再 409**，而是自动落一条来源声明（forkOf = { id 同 id, ownerId 父作者 }）：
         · 客户端显式指名了父分支（b.forkOf.ownerId 且那条分支存在）→ 就用它当父；
         · 否则父 = 主干（createdAt 最早那条）。
       用户口径：填别人的 id 就是在那个应用下开我自己的分支；想真正无关就换一个 id。 */
    const others = appBranchesOf(id);
    const declaredFork = normalizeForkOf(b.forkOf, "", "");
    if (others.length) {
      const trunk = appTrunkOf(id) || others[0];
      const wantParentId = declaredFork && String(declaredFork.id) === id ? String(declaredFork.ownerId) : "";
      const parent = (wantParentId && appBranchOfOwner(id, wantParentId)) || trunk;
      b.forkOf = { id: id, ownerId: String(parent.userId || "") };
    }
    const title = String(b.title).trim().slice(0, 80);
    if (!title) return send(res, 400, { ok: false, error: "标题不能为空" });
    const description = String(b.description != null ? b.description : b.desc || "").trim().slice(0, 2000);
    let version;
    try {
      version = normalizeVersion(b.version, "1.0.0");
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    let buf;
    try {
      buf = decodeAppZip(b.zipBase64 != null ? b.zipBase64 : b.fileBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "不是有效的小应用 zip：" + (e.message || e) });
    }
    let entry = "";
    try {
      entry = detectAppEntry(b.entry, zipEntryNames(buf));
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    if (!entry) {
      return send(res, 400, { ok: false, error: "包内找不到入口页（顶层需有 index.html，或显式传 entry）" });
    }
    let icon = null;
    try {
      icon = decodePreview(b.iconBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "图标无效：" + (e.message || e) });
    }
    /* 上架截图（多图落盘；**只认 shots[]**，客户端与服务端同时升级）。
       逐张校验 + 服务端统一收边（长边→APP_SHOT_MAX_EDGE），任何一张不合格整批拒绝；
       数组元素可以是 { sha }（客户端按内容指纹认出云端已有这张图 → 不重发字节）。 */
    const shotsIn = decodeAppShots(b.shotsBase64);
    if (!shotsIn.ok) return send(res, 400, { ok: false, error: shotsIn.errors[0] || "截图无效" });
    /* 配额：全部校验通过之后、落盘之前（契约 §7.5；超限时磁盘与内存都不留半成品）。
       口径 = 包 + **本次新图片**（{sha} 复用的那部分不重复计，它本来就在云端）。 */
    const newShotBytes = shotsIn.shots.reduce((n, s) => n + (s && s.reused ? 0 : Number(s && s.bytes) || 0), 0);
    const quota = appQuotaError(user.id, buf.length + newShotBytes, 0, true);
    if (quota) return send(res, quota.status, quota.body);

    // 二次开发来源（可选，契约 §八）：声明了就记，没声明 = 原创
    const forkOf = normalizeForkOf(b.forkOf, id, user.id);

    // 开关打开时一版一包 + 最新版镜像；关闭时只写 <id>.zip（旧口径逐字不变）。
    writeAppZipFiles(id, version, buf, user.id);
    if (icon) writeAppIcon(id, user.id, icon);
    /* 截图落盘（空数组 = 作者没传：把旧的那批清掉，避免「换了一版还在展示老图」）。
       内容寻址：同一张图全站只落一份，别名指过去。 */
    const stored = storeShots(id, user.id, shotsIn.shots);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const a = {
      id,
      userId: user.id,
      title,
      description,
      icon: String(b.icon || "").trim().slice(0, 300),
      version,
      tags: parseTags(b.tags),
      entry,
      bytes: buf.length,
      sha256: sha,
      /* 这一批截图的内容哈希（内容寻址图片库的对象名）：客户端拿它做「云端已有这张图」的判定 */
      shots: { shas: stored.shas },
      downloads: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    if (forkOf) a.forkOf = forkOf;
    if (appVersionsOn()) {
      // 契约 §7.2：开关打开时才写 versions / latestVersion（可见性位本轮已整体移除）
      a.versions = [
        makeAppVersion({
          version,
          parentVersion: "",
          buf,
          sha256: sha,
          entry,
          note: b.versionNote != null ? b.versionNote : b.note,
          user,
        }),
      ];
      a.latestVersion = version;
    }
    db.apps.push(a);
    recordAppDeclaration(req, user, id, version, "create");
    await saveDb();
    /* 镜像：这一分支自己的 <id>__<作者uid>.zip + 老口径 <id>.zip（跨分支最高版，旧链不 404） */
    syncAppZipMirror(a);
    publishStaticApps("新建应用 " + id + "@" + version);
    return send(res, 200, {
      ok: true,
      /* 每用户存储上限的当期用量（客户端上架窗显示「已用 / 上限」，不另开接口） */
      storage: appStorageViewOf(user),
      item: publicApp(a, user),
      catalog: appCatalogEntry(a),
    });
  }

  // 更新：仅 owner 可改；覆盖文件（zip / 图标）并让版本 +1（显式传 version 时以传入为准）。
  // 同 id 多分支（契约 §十）：只改**我自己那条分支**（?owner= 只能指到自己的分支，否则 403）。
  if (appOne && method === "PATCH") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const askOwnerPatch = appResolveOwnerId(url.searchParams.get("owner"));
    const a = appBranchOfOwner(appOne[1], askOwnerPatch || user.id);
    if (!a) {
      if (!appBranchesOf(appOne[1]).length) return send(res, 404, { ok: false, error: "应用不存在" });
      return send(res, 403, { ok: false, error: "只能更新自己的分支" });
    }
    if (a.userId !== user.id) return send(res, 403, { ok: false, error: "只能更新自己的应用" });
    const b = await jsonBody();
    // 声明（契约 §7.3）：更新同样必须 acceptDeclaration === true，没勾选就不落任何盘。
    if (b.acceptDeclaration !== true) return declarationRequired(res);
    // 先全部校验、再落盘 / 改内存：中途报错时库与磁盘都不留半成品（失败绝不改内存记录）。
    let nextTitle = null;
    if (b.title != null) {
      nextTitle = String(b.title).trim().slice(0, 80);
      if (!nextTitle) return send(res, 400, { ok: false, error: "标题不能为空" });
    }
    const nextDesc =
      b.description != null || b.desc != null
        ? String(b.description != null ? b.description : b.desc).trim().slice(0, 2000)
        : null;
    const nextTags = b.tags != null ? parseTags(b.tags) : null;
    const nextIcon = b.icon != null ? String(b.icon).trim().slice(0, 300) : null;
    let iconBuf = null;
    let clearIcon = false;
    if (b.iconBase64 === "") {
      clearIcon = true;
    } else if (b.iconBase64) {
      try {
        iconBuf = decodePreview(b.iconBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "图标无效：" + (e.message || e) });
      }
    }
    /* 上架截图（多图编辑）：三态语义 ——
       · 键没传（undefined / null）= 截图完全不动；
       · [] = 清空这一分支的全部截图（clearAppShots）；
       · 非空数组 = 逐项解析后**整批替换**（顺序 = 数组顺序，客户端拖拽排序靠它）。
       数组元素允许混合三种形态（客户端手里只有新图的数据，拿不到旧图字节再重传）：
       · 字符串 = 新图（base64 或 data:image/...;base64,...），走 decodeAppShots 那条口径；
       · { sha } = 云端已有这张图（内容指纹命中）→ 直接复用对象库那一份，**不重发字节**；
       · { keep: n }（n 为 0 起的整数）= 沿用保存前这一分支的第 n 张（按保存前顺序）。
       旧图里没有被 keep / sha 引用的**全部下掉**（含多余的第 9 张）：内容先落对象库、再重排别名，
       绝不边读边覆盖（别名重排会清目录，对象那一份与它无关，见 resolveAppShotsEdit 的注释）。
       校验阶段绝不落盘也不改内存：与标题 / 图标 / zip 同一条「先全部校验、再落盘」的纪律。 */
    const shotsGiven = b.shotsBase64 != null;
    let shotsNext = null; /* null = 键没传（不动）；[] = 清空；非空 = 这一批的最终对象 */
    if (shotsGiven) {
      const edit = resolveAppShotsEdit(b.shotsBase64, appShotFiles(a.id, a.userId), (a.shots && a.shots.shas) || []);
      if (!edit.ok) return send(res, 400, { ok: false, error: edit.errors[0] || "截图无效", errors: edit.errors });
      shotsNext = edit.imgs;
    }
    const rawZip = b.zipBase64 != null ? b.zipBase64 : b.fileBase64;
    let zipBuf = null;
    let nextEntry = null;
    if (rawZip) {
      try {
        zipBuf = decodeAppZip(rawZip);
      } catch (e) {
        return send(res, 400, { ok: false, error: "不是有效的小应用 zip：" + (e.message || e) });
      }
      try {
        nextEntry = detectAppEntry(b.entry, zipEntryNames(zipBuf));
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message || String(e) });
      }
      if (!nextEntry) {
        return send(res, 400, { ok: false, error: "包内找不到入口页（顶层需有 index.html，或显式传 entry）" });
      }
    } else if (b.entry != null) {
      const fp = appZipPathOfBranchVia(a).path;
      if (!fs.existsSync(fp)) return send(res, 400, { ok: false, error: "应用包缺失，请重新上传 zip" });
      try {
        nextEntry = detectAppEntry(b.entry, zipEntryNames(fs.readFileSync(fp)));
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message || String(e) });
      }
      if (!nextEntry) return send(res, 400, { ok: false, error: "入口页不合法" });
    }
    // 多版本模式下「带 zip 的 PATCH」= 追加一条版本记录（父版 = 追加前的 latestVersion）；
    // 不带 zip 就只改元信息；关开关时完全是旧口径（覆盖 <id>.zip + 版本字段 +1）。
    const appendVersion = appVersionsOn() && !!zipBuf;
    const prevLatest = appLatestVersion(a);
    // 多版本模式下的「只改元信息」不动版本号：版本由版本记录掌管，若照旧 +1 会让
    // catalog 里的 version（老字段）与 latestVersion 脱节（例：version=1.0.1 却没有这一版的包）。
    const bumped = b.version == null && (!appVersionsOn() || !!zipBuf);
    let nextVersion;
    try {
      if (appVersionsOn() && !zipBuf) {
        nextVersion = normalizeVersion(a.latestVersion || a.version, a.version || "1.0.0");
      } else {
        const bumpBase = appVersionsOn() ? a.latestVersion || a.version || "1.0.0" : a.version;
        nextVersion = normalizeVersion(bumped ? bumpAppVersion(bumpBase) : b.version, a.version || "1.0.0");
      }
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    /* 同版本号：**就地覆盖这一版**（与 POST /versions 同口径，见那边的注释）——
       作者改完 bug 想「还叫 1.0.1」时不再被 409 挡回来。 */
    const dupIdx = appendVersion ? appVersionRecords(a).findIndex((v) => v.version === nextVersion) : -1;
    const replacing = dupIdx >= 0;
    // 父版本：显式传入优先，否则 = 追加前的 latestVersion（契约 §7.4）。
    let appendParent = prevLatest;
    if (appendVersion && b.parentVersion != null) {
      const pv = String(b.parentVersion).trim();
      if (!pv) {
        appendParent = "";
      } else {
        try {
          appendParent = normalizeVersion(pv, "");
        } catch (e) {
          return send(res, 400, { ok: false, error: "parentVersion 无效：" + (e.message || e) });
        }
      }
    }
    /* 配额：追加版本是净增（镜像不算第二份），覆盖旧包则先释放被覆盖的那一份（契约 §7.5）。
       本轮口径：**图片也进配额** —— 整批替换时旧图那一套的占用当场释放、新图按实际字节加上
       （{sha} 复用的那部分不重复计：它本来就在云端占着，只是换个引用）。
       只改元信息 + 换图的 PATCH（不带 zip）同样要过这一关，否则「改个标题顺手塞 8 张 5MB 图」
       就绕开了上限。 */
    const shotOldBytes = shotsGiven ? appShotObjectBytesOf(a) : 0;
    const shotNewBytes = shotsGiven
      ? shotsNext.reduce((n, im) => {
          const hold = imgObjHold(im.sha, im.ext, "");
          return n + (hold ? hold.bytes : 0);
        }, 0)
      : 0;
    if (zipBuf || shotsGiven) {
      const addBytes = (zipBuf ? zipBuf.length : 0) + shotNewBytes;
      const replaceBytes = (zipBuf && !appendVersion ? Number(a.bytes) || 0 : 0) + shotOldBytes;
      const quota = appQuotaError(user.id, addBytes, replaceBytes, false);
      if (quota) return send(res, quota.status, quota.body);
    }

    const zipSha = zipBuf ? crypto.createHash("sha256").update(zipBuf).digest("hex") : "";
    /* 这次携带的包与线上那一版**内容一样**吗（同号同内容的重传）：只用来给回执
       `unchanged:true` 与「其实一个字节都没变」的如实提示，不改变任何落盘行为 ——
       同号重传一律按「就地覆盖」接受，绝不因为「内容没变」回错误。 */
    const zipUnchanged = !!(zipBuf && appendVersion && zipSha && zipSha === String(a.sha256 || ""));
    let appendRec = null;
    if (zipBuf) {
      if (appendVersion) {
        writeAppZipFiles(a.id, nextVersion, zipBuf, a.userId);
        appendRec = makeAppVersion({
          version: nextVersion,
          parentVersion: appendParent,
          buf: zipBuf,
          sha256: zipSha,
          entry: nextEntry != null ? nextEntry : appEntryOf(a),
          note: b.versionNote != null ? b.versionNote : b.note,
          user,
        });
      } else {
        fs.writeFileSync(appOwnerZipPath(a.id, a.userId), zipBuf);
      }
      a.bytes = zipBuf.length;
      a.sha256 = zipSha;
    }
    if (appendRec) {
      const recs = appVersionRecords(a).slice();
      if (replacing) recs[dupIdx] = appendRec;
      else recs.push(appendRec);
      a.versions = recs;
      a.latestVersion = nextVersion;
    }
    /* 本轮两态收敛后这里**什么都不用复位**：带包的这次上传（追加一版 / 同号覆盖）之后，
       库里有这条记录 = 它就在线上（目录按整库现算，见可见性开关那条注释）。 */
    if (clearIcon) clearAppIcon(a.id, a.userId);
    else if (iconBuf) writeAppIcon(a.id, a.userId, iconBuf);
    /* 截图落盘：与图标同一阶段（全部校验通过之后）。
       · 追加一版（带 zip）：**追加 + 去重**，保留这条分支已有的图 —— 与 POST /versions 同口径；
         客户端带的是本次新加的图（旧图没有字节可重传），整批替换会把旧图删光（用户报的那条）。
       · 只改元信息（编辑窗，带 {keep:n} / {sha} 指代 / [] 清空）：仍走整批替换 ——
         那是作者显式增删排序。
       缺键时一个字节都不碰（作者只改标题不该把截图弄丢）。
       写完顺手作废封面缩略图缓存：封面源就是截图第 1 张，换图不换新缩略图 = 卡片还是老图。 */
    if (shotsGiven) {
      if (appendVersion) {
        if (shotsNext.length) {
          const dec = decodeAppShots(b.shotsBase64);
          if (!dec.ok) return send(res, 400, { ok: false, error: dec.errors[0] || "截图无效" });
          const ap = appendAppShots(a.id, a.userId, dec.shots, a);
          if (!ap.ok) return send(res, 400, { ok: false, code: "TOO_MANY_SHOTS", error: ap.errors[0] || "截图过多" });
        }
      } else if (shotsNext.length) {
        /* 整批替换：这里是**唯一**会清空截图目录再重排的地方，所以「项不合格」必须在这里收住 ——
           别名重排一旦开始清目录，任何一项写失败都会连带整批图一起没掉（2026-10 修的那次就是这样丢的：
           resolveAppShotsEdit 用 `sha` 报指纹、writeShotAliases 读 `hash`，整批被跳过 → 目录清空 + 回执说成功）。 */
        try {
          storeShots(a.id, a.userId, shotsNext);
        } catch (e) {
          if (e && e.shotsIncomplete) {
            return send(res, 500, { ok: false, code: "SHOTS_SOURCE_MISSING", error: (e && e.message) || "截图来源缺失（旧图未被改动）" });
          }
          throw e;
        }
      } else {
        clearAppShots(a.id, a.userId);
      }
      clearAppThumb(a.id, a.userId);
    }
    /* 这一批截图的内容哈希名单（含「只改元信息没动图」的情况：原样重算一遍，永不写坏） */
    a.shots = { shas: appShotEntriesOf(a.id, a.userId, a).map((e) => e.sha) };

    if (nextTitle != null) a.title = nextTitle;
    if (nextDesc != null) a.description = nextDesc;
    /* 标签继承：空值不清空（见 appTagsNext 注释）——追加 / 覆盖一版是「同一件事的新一版」，
       标签属于应用本身，作者没重填就该原样留着。 */
    if (nextTags != null) a.tags = appTagsNext(nextTags, a.tags);
    if (nextIcon != null) a.icon = nextIcon;
    if (nextEntry != null) a.entry = nextEntry;
    /* 二次开发来源（契约 §八）：带了这个键才动它（null = 清回原创），不带就保持原样 */
    if (b.forkOf !== undefined) {
      const fo = normalizeForkOf(b.forkOf, a.id, a.userId);
      if (fo) a.forkOf = fo;
      else delete a.forkOf;
    }
    a.version = nextVersion;
    a.updatedAt = now();
    recordAppDeclaration(req, user, a.id, nextVersion, appendRec ? "version" : "update");
    await saveDb();
    syncAppZipMirror(a);
    publishStaticApps((appendRec ? "追加版本 " : "更新应用 ") + a.id + "@" + nextVersion);
    return send(res, 200, {
      ok: true,
      bumped,
      ownerId: a.userId,
      replaced: replacing, // true = 覆盖了这一分支已存在的同号版本（客户端据此提示「已覆盖 vX」）
      /* 同号覆盖时这次的包与线上那一版**内容一模一样**（sha256 相同）：如实回一个标记，
         客户端可以说清「其实一个字节都没变」，绝不因此回错误 —— 同号重传一律接受。 */
      unchanged: zipUnchanged,
      branches: appBranchViewOf(a.id, user),
      item: publicApp(a, user),
      catalog: appCatalogEntry(a),
    });
  }

  // 删整条应用（仅 owner / 管理员）：同 id 多分支下**只删我这一条分支**，别人的分支照旧（q34）。
  // ?owner=<uid|账号名> 指定删哪条（管理员可删别人的；缺省 = 我自己那条）。
  if (appOne && method === "DELETE") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const askOwner = appResolveOwnerId(url.searchParams.get("owner"));
    const a =
      (askOwner ? appBranchOfOwner(appOne[1], askOwner) : null) ||
      appBranchOfOwner(appOne[1], user.id);
    if (!a) {
      if (!appBranchesOf(appOne[1]).length) return send(res, 404, { ok: false, error: "应用不存在" });
      return send(res, 403, { ok: false, error: "只能删除自己的分支" });
    }
    if (a.userId !== user.id && !isAdmin(user)) {
      return send(res, 403, { ok: false, error: "只能删除自己的应用" });
    }
    /* 与「删掉最后一个版本 = 彻底删除」共用同一份实现（deleteAppBranch）：
       记录 + 包 + 图标 + 截图 + 封面缩略图 + 静态目录（含空目录）+ 无主图片对象一次清完。
       原来这里与「删光版本」各写一份，两份一漂移就会出现「记录没了、文件还在」。
       元信息快照（版本列表 / 删除时最高版）在记录还活着的时候取，供已删除留痕用。 */
    const del = await deleteAppBranch(a, appBranchDeleteMeta(a));
    await saveDb();
    syncAppZipMirrorGlobal(a.id);
    publishStaticApps("删除分支 " + a.id + "（" + appOwnerNameOf(a.userId) + "）");
    console.log(
      "[mtnode-store] 删除分支 " + a.id + "/" + a.userId + "：静态文件 " +
        ((del.removed && del.removed.staticFiles) || []).length + " 个 / 空目录 " +
        ((del.removed && del.removed.staticDirs) || []).length + " 个 / 回收无主图片 " +
        ((del.imgGc && del.imgGc.removed) || 0) + " 个",
    );
    return send(res, 200, { ok: true, id: a.id, ownerId: a.userId, deleted: true, branches: appBranchViewOf(a.id, user) });
  }

  // —— 论坛（长期保留）——
  // 列表：免登录，只回标题与元数据（不含正文），支持 q/status/sort/page/pageSize。
  if (method === "GET" && p === "/api/forum/topics") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const status = String(url.searchParams.get("status") || "").trim().toLowerCase();
    if (status && !FORUM_STATUSES.has(status)) {
      return send(res, 400, { ok: false, error: "未知状态" });
    }
    const sort = String(url.searchParams.get("sort") || "new").trim().toLowerCase() === "active" ? "active" : "new";
    const { page, pageSize, skip } = forumPageArgs(url, "page", "pageSize");
    const list = (db.forumTopics || []).filter((t) => {
      if (!t) return false;
      if (status && t.status !== status) return false;
      if (q) {
        const hit = String(t.title || "").toLowerCase().includes(q) || String(t.content || "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
    list.sort(
      sort === "active"
        ? (a, b) => (b.lastReplyAt || b.createdAt || 0) - (a.lastReplyAt || a.createdAt || 0)
        : (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    );
    const pageItems = list.slice(skip, skip + pageSize);
    const en = enrichOf("forum_topic", pageItems.map((t) => t.id));
    const items = pageItems.map((t) => publicForumTopicSummary(t, en(t.id)));
    return send(res, 200, { ok: true, sort, page, pageSize, total: list.length, items });
  }

  // 详情：免登录，正文 + 回复分页（replyPage / replyPageSize）。
  if (method === "GET" && p === "/api/forum/topic") {
    const id = String(url.searchParams.get("id") || "").trim();
    const t = (db.forumTopics || []).find((x) => x.id === id);
    if (!t) return send(res, 404, { ok: false, error: "话题不存在" });
    const { page, pageSize, skip } = forumPageArgs(url, "replyPage", "replyPageSize");
    const all = (db.forumReplies || [])
      .filter((r) => r && r.topicId === t.id)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const replies = all.slice(skip, skip + pageSize).map(publicForumReply);
    return send(res, 200, {
      ok: true,
      topic: publicForumTopic(t, user),
      replies: { page, pageSize, total: all.length, items: replies },
    });
  }

  // 发帖：需登录。
  if (method === "POST" && p === "/api/forum/topics") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    if (!forumRateOk("topic", user.id)) {
      return send(res, 429, { ok: false, code: "RATE_LIMITED", error: "发帖过于频繁，请稍后再试" });
    }
    const b = await jsonBody();
    const title = String(b.title || "").trim();
    const content = String(b.content || "").trim();
    if (!title) return send(res, 400, { ok: false, error: "请填写标题" });
    if (title.length > MAX_FORUM_TITLE) {
      return send(res, 400, { ok: false, error: "标题不能超过 " + MAX_FORUM_TITLE + " 字" });
    }
    if (!content) return send(res, 400, { ok: false, error: "请填写正文" });
    if (content.length > MAX_FORUM_CONTENT) {
      return send(res, 400, { ok: false, error: "正文不能超过 " + MAX_FORUM_CONTENT + " 字符" });
    }
    const status = String(b.status || "general").trim().toLowerCase();
    if (!FORUM_STATUSES.has(status)) return send(res, 400, { ok: false, error: "未知状态" });
    let imageIds;
    try {
      imageIds = collectForumImages(b.imageBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "图片无效：" + e.message });
    }
    const at = now();
    const topic = {
      id: uid("ft_"),
      title,
      content,
      status,
      imageIds,
      userId: user.id,
      createdAt: at,
      updatedAt: at,
      replyCount: 0,
      lastReplyAt: 0,
    };
    db.forumTopics.push(topic);
    await saveDb();
    return send(res, 200, { ok: true, item: publicForumTopic(topic, user) });
  }

  // 回复：需登录，写回话题的 replyCount / lastReplyAt。
  if (method === "POST" && p === "/api/forum/replies") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    if (!forumRateOk("reply", user.id)) {
      return send(res, 429, { ok: false, code: "RATE_LIMITED", error: "回复过于频繁，请稍后再试" });
    }
    const b = await jsonBody();
    const topicId = String(b.topicId || "").trim();
    const t = (db.forumTopics || []).find((x) => x.id === topicId);
    if (!t) return send(res, 404, { ok: false, error: "话题不存在" });
    const content = String(b.content || "").trim();
    if (!content) return send(res, 400, { ok: false, error: "请填写回复内容" });
    if (content.length > MAX_FORUM_REPLY) {
      return send(res, 400, { ok: false, error: "回复不能超过 " + MAX_FORUM_REPLY + " 字符" });
    }
    let imageIds;
    try {
      imageIds = collectForumImages(b.imageBase64);
    } catch (e) {
      return send(res, 400, { ok: false, error: "图片无效：" + e.message });
    }
    const at = now();
    const reply = { id: uid("fr_"), topicId, content, imageIds, userId: user.id, createdAt: at };
    db.forumReplies.push(reply);
    t.replyCount = (t.replyCount || 0) + 1;
    t.lastReplyAt = at;
    t.updatedAt = at;
    await saveDb();
    return send(res, 200, { ok: true, item: publicForumReply(reply) });
  }

  // 改状态：需登录，仅话题作者可改（含标记「已解决」）。
  if (method === "PATCH" && p === "/api/forum/topic") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    const id = String(b.id || "").trim();
    const t = (db.forumTopics || []).find((x) => x.id === id);
    if (!t) return send(res, 404, { ok: false, error: "话题不存在" });
    if (t.userId !== user.id) {
      return send(res, 403, { ok: false, error: "只能修改自己的话题" });
    }
    const status = String(b.status || "").trim().toLowerCase();
    if (!FORUM_STATUSES.has(status)) return send(res, 400, { ok: false, error: "未知状态" });
    t.status = status;
    t.updatedAt = now();
    await saveDb();
    return send(res, 200, { ok: true, item: publicForumTopic(t, user) });
  }

  // 图片上传：需登录（编辑期先传图拿 imageId，正文再写 ![](forum:<imageId>)）。
  if (method === "POST" && p === "/api/forum/images") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    if (!forumRateOk("image", user.id)) {
      return send(res, 429, { ok: false, code: "RATE_LIMITED", error: "上传过于频繁，请稍后再试" });
    }
    const b = await jsonBody();
    const raw = b.base64 != null ? b.base64 : b.imageBase64 != null ? b.imageBase64 : b.data;
    let img;
    try {
      img = decodeForumImage(raw);
    } catch (e) {
      return send(res, 400, { ok: false, error: "图片无效：" + e.message });
    }
    if (!img) return send(res, 400, { ok: false, error: "图片为空" });
    const imageId = writeForumImage(uid("img_"), img);
    return send(res, 200, { ok: true, imageId });
  }

  // 论坛图片：免登录（否则未登录看不到图）。
  const forumImgR = /^\/api\/forum\/images\/([^/]+)$/.exec(p);
  if (forumImgR && method === "GET") {
    const fp = forumImagePath(forumImgR[1]);
    if (!fp) return send(res, 404, { ok: false, error: "图片不存在" });
    const buf = fs.readFileSync(fp);
    return sendBin(res, 200, buf, imageMimeFromPath(fp));
  }

  /* ====================================================================== *
   * 打赏（鲸圆币）+ 评论（含五星评分）
   *   编排逻辑分别在 tips.mjs / comments.mjs，这里只做路由、鉴权与错误码映射。
   *   契约真源：docs/tips-comments-design.md 第一 / 二 / 三节。
   * ====================================================================== */

  // 打赏配置：档位 / 单笔上限 / 月度额度 / 本人余额与今日已打赏对象（免登录可读静态口径）。
  if (method === "GET" && p === "/api/tips/config") {
    return send(res, 200, Object.assign({ ok: true }, plans.config(user)));
  }

  /* 打赏概述（**免登录 · 批量 · 只回公开数字**）：一次问一组对象的 `{count,totalYuan}`。
     为什么单开一个接口：应用中心列表条目来自**静态目录** catalog.json（不带 tips），
     卡片上的金币 icon 悬停要显示「累计 N 币 · M 次」，逐个对象打 /api/tips/authors 会变成
     N 次请求 —— 这里一次遍历 db.tips 出整页（tips.mjs 的 summariesOf）。
     口径：打赏人名单**永不出现在这里**（人数与金额是公开投影，名字仍只给作者本人，
     见 /api/tips/list 的 scope 分流）；没被打赏过的对象照样回一条零值，客户端不必自己补零。
     错误码：TIP_INVALID_TARGET（kind 不认识 / ids 为空）。 */
  if (method === "GET" && p === "/api/tips/summary") {
    const kind = String(url.searchParams.get("kind") || "").trim();
    const ids = String(url.searchParams.get("ids") || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, TIP_SUMMARY_MAX_IDS);
    if (TIP_TARGET_KINDS.indexOf(kind) < 0 || !ids.length) {
      return send(res, 400, {
        ok: false,
        code: "TIP_INVALID_TARGET",
        error:
          "参数不合法：kind 需为 " + TIP_TARGET_KINDS.join(" / ") + " 之一，ids 为逗号分隔的对象 id（至少一个）",
      });
    }
    /* 列表页会随筛选反复问同一批 id，给一个 5 秒的公共缓存：既压住重复请求，
        又不至于让刚打赏完的数字长时间不动（客户端每次打开打赏窗后也会重新拉一次）。 */
    res.setHeader("Cache-Control", "public, max-age=5");
    return send(res, 200, {
      ok: true,
      kind: kind,
      items: plans.summariesOf(kind, ids),
    });
  }

  /* 打赏记录：**作者本人**看全部名单；**其他登录用户只回自己打赏出去的那几笔**（scope:"mine"，
     名单里不再有第三人）；未登录 401。管理员不再是一条特权路径（见 tips.mjs 的 listTips 注释）。 */
  if (method === "GET" && p === "/api/tips/list") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const r = plans.listTips(user, {
      targetKind: url.searchParams.get("targetKind") || "",
      targetId: url.searchParams.get("targetId") || "",
      limit: Number(url.searchParams.get("limit")) || 50,
    });
    if (!r.ok) {
      const code = r.code === "TIP_TARGET_NOT_FOUND" ? 404 : 400;
      return send(res, code, { ok: false, code: r.code, error: r.error });
    }
    return send(res, 200, r);
  }

  /* 待分账作者列表（按作者拆分打赏用）：**免登录可读**（未登录时 isSelf 全 false）。
     作者来源 = 应用条目的同源分支（forkOf.id，含源条目自己）逐个取 uid 去重；
     另带一个**公开**汇总 tips:{count,totalYuan}（口径 = summaryOf("app", id)，人人可见）——
     打赏窗对非作者不再提示权限，只展示这个公开总额。 */
  if (method === "GET" && p === "/api/tips/authors") {
    const r = plans.listAuthors(user, {
      targetKind: url.searchParams.get("targetKind") || "",
      targetId: url.searchParams.get("targetId") || "",
    });
    if (!r.ok) {
      const code = r.code === "TIP_TARGET_NOT_FOUND" ? 404 : 400;
      return send(res, code, { ok: false, code: r.code, error: r.error });
    }
    return send(res, 200, r);
  }

  // 打赏：需登录；一次打赏 = 一条 tip_out（打赏者负数总额）+ 每位实收作者一条 tip_in（正数），
  // 失败按已成功的部分逐条补偿。splits 缺省 = 单作者单笔（旧口径，向后兼容）。
  if (method === "POST" && p === "/api/tips") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    /* splits 只在**显式给了数组**时才传下去（undefined = 旧口径；null / 非数组也当没给，
       由 tips.mjs 的 `Array.isArray(splits)` 判据统一决定走哪条路径，server 层不重抄校验）。 */
    const r = await plans.tip(user, {
      targetKind: b.targetKind,
      targetId: b.targetId,
      amountYuan: b.amountYuan,
      splits: Array.isArray(b.splits) ? b.splits : undefined,
    });
    if (!r.ok) {
      // 目标不存在 → 404；其余（金额 / 分账 / 自打赏 / 频次 / 额度 / 余额不足）都是可纠正的 400，
      // 余额不足额外带上当前余额（客户端据此决定是否拉起充值窗）。
      const code = r.code === "TIP_TARGET_NOT_FOUND" ? 404 : 400;
      const payload = { ok: false, code: r.code, error: r.error };
      if (r.code === "BALANCE_INSUFFICIENT") payload.balanceYuan = yuanOfCents(Number(user.balanceCents) || 0);
      return send(res, code, payload);
    }
    /* 打的是应用：静态目录条目里也带着公开打赏汇总（见 appCatalogDoc），这一次变更必须跟着落盘，
       否则线上目录里的「打赏 0 次」会留到下一次应用变更 / 服务重启才自愈。
       只在 app 目标上发（模板 / 技能的目录不带 tips，没必要为它们重写整份应用目录）。 */
    if (String(b.targetKind || "") === "app") {
      publishStaticApps("打赏 " + String(b.targetId || "") + "（" + appOwnerNameOf(user.id) + "）");
    }
    return send(res, 200, {
      ok: true,
      tip: r.tip,
      // 按作者拆分时附上这一笔的全部记录（单作者单笔时 splitCount=1，客户端可忽略）
      records: r.records.map((rec) => plans.publicTip(rec)),
      splitGroupId: r.splitGroupId || "",
      splitCount: r.splitCount || 1,
      balanceYuan: r.balanceYuan,
      quota: plans.config(user).quota,
      target: r.target,
    });
  }

  // 评论列表：免登录可看（平铺 + parentId 引用，口径见 comments.mjs 文件头）。
  // app 的 ?owner=<uid|账号名> = 列哪一条作者分支的评论（本轮需求 4）；不传 / 认不出 = 主干。
  if (method === "GET" && p === "/api/comments") {
    const r = comments.list({
      targetKind: url.searchParams.get("targetKind") || "",
      targetId: url.searchParams.get("targetId") || "",
      /* 应用分支（本轮需求 4）：?owner=<uid|账号名> = 列哪一条作者分支的评论；不传 = 主干 */
      owner: url.searchParams.get("owner") || url.searchParams.get("ownerId") || "",
      page: Number(url.searchParams.get("page")) || 1,
      pageSize: Number(url.searchParams.get("pageSize")) || 20,
      parentId: url.searchParams.get("parentId"),
      viewer: user,
    });
    if (!r.ok) {
      const code = r.code === "COMMENT_TARGET_NOT_FOUND" ? 404 : 400;
      return send(res, code, { ok: false, code: r.code, error: r.error });
    }
    return send(res, 200, r);
  }

  // 发评论 / 回复：需登录；限频 1 条/分钟 + 50 条/天；条目评论可带五星。
  // app 的 body.owner = 这条评论写给哪一条作者分支（本轮需求 4：评论跟着作者走）；不传 = 主干。
  if (method === "POST" && p === "/api/comments") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    const r = await comments.create(user, {
      targetKind: b.targetKind,
      targetId: b.targetId,
      /* 应用分支（本轮需求 4）：body.owner = 这条评论写给哪一条作者分支；不传 = 主干 */
      owner: b.owner != null ? b.owner : b.ownerId,
      content: b.content,
      rating: b.rating,
      parentId: b.parentId,
    });
    if (!r.ok) {
      const code =
        r.code === "COMMENT_TARGET_NOT_FOUND" || r.code === "COMMENT_NOT_FOUND"
          ? 404
          : r.code === "RATE_LIMITED"
            ? 429
            : 400;
      return send(res, code, { ok: false, code: r.code, error: r.error });
    }
    return send(res, 200, { ok: true, item: r.item, rating: r.rating, comments: r.comments });
  }

  // 改星（只本人、只条目评论）：契约里 PATCH /api/comments 就是「只改星」这一个动作。
  if (method === "PATCH" && p === "/api/comments") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    const r = await comments.setRating(user, { id: b.id, rating: b.rating });
    if (!r.ok) {
      const code =
        r.code === "COMMENT_NOT_FOUND"
          ? 404
          : r.code === "COMMENT_FORBIDDEN"
            ? 403
            : 400;
      return send(res, code, { ok: false, code: r.code, error: r.error });
    }
    return send(res, 200, { ok: true, item: r.item, rating: r.rating, comments: r.comments });
  }

  // 删除评论：软删除（作者 / 对象作者 / 管理员），记录留档。
  if (method === "DELETE" && p === "/api/comments") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    const r = await comments.remove(user, { id: b.id });
    if (!r.ok) {
      const code = r.code === "COMMENT_NOT_FOUND" ? 404 : r.code === "COMMENT_FORBIDDEN" ? 403 : 400;
      return send(res, code, { ok: false, code: r.code, error: r.error });
    }
    return send(res, 200, { ok: true, rating: r.rating, comments: r.comments });
  }

  /* ====================================================================== *
   * 消息（通知）—— 编排逻辑全在 notifications.mjs，这里只做路由与鉴权。
   *   四个接口都要登录（未登录 401），且只操作**自己的**记录。
   *   契约真源：docs/tips-comments-design.md 第三节（消息 / 通知）。
   * ====================================================================== */

  // 列表（新 → 旧分页，cursor = 上一页最后一条的 at）。
  if (method === "GET" && p === "/api/notifications") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const r = alerts.list(user, {
      limit: Number(url.searchParams.get("limit")) || undefined,
      cursor: Number(url.searchParams.get("cursor")) || 0,
    });
    if (!r.ok) return send(res, 401, { ok: false, code: r.code, error: r.error });
    return send(res, 200, { ok: true, unread: r.unread, items: r.items, cursor: r.cursor });
  }

  // 未读数（角标轮询专用：轻量，不拉列表）。
  if (method === "GET" && p === "/api/notifications/unread") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const r = alerts.unreadCount(user);
    return send(res, 200, { ok: true, unread: r.unread });
  }

  // 标记已读：ids 为空数组 / 不传 = 全部标记已读。
  if (method === "POST" && p === "/api/notifications/read") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const b = await jsonBody();
    const r = alerts.markRead(user, { ids: b.ids });
    return send(res, 200, { ok: true, unread: r.unread });
  }

  // 清空自己的消息。
  if (method === "POST" && p === "/api/notifications/clear") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const r = alerts.clear(user);
    return send(res, 200, { ok: true, unread: r.unread });
  }

  /* ====================================================================== *
   * 充值（支付宝当面付）—— 测试期仅白名单账号（默认 ms2308）可用
   * ====================================================================== */

  // 客户端拉配置：档位 / 上下限 / 支付宝是否配好 / 本账号是否开放充值。
  if (method === "GET" && p === "/api/wallet/config") {
    const st = alipayStatus();
    return send(res, 200, {
      ok: true,
      // alipay_page = 电脑网站支付（浏览器收银台）· alipay_f2f = 当面付（窗内二维码）。
      // 由 MTNODE_ALIPAY_CHANNEL 决定，客户端据此决定「显示二维码」还是「显示去支付按钮」。
      channel: st.channel === "precreate" ? "alipay_f2f" : "alipay_page",
      tiersYuan: rechargeTiersYuan(),
      minYuan: yuanOfCents(RECHARGE_MIN_CENTS),
      maxYuan: yuanOfCents(RECHARGE_MAX_CENTS),
      orderTtlMs: 15 * 60 * 1000,
      payConfigured: st.configured,
      sandbox: st.sandbox,
      missing: st.missing,
      opened: rechargeAllowed(user),
    });
  }

  // 钱包摘要：余额 + 最近订单 + 最近流水（含退款负项）。
  if (method === "GET" && p === "/api/wallet/summary") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    if (!rechargeAllowed(user)) {
      return send(res, 403, { ok: false, code: "RECHARGE_NOT_OPEN", error: "充值功能尚未对该账号开放" });
    }
    const limit = Math.min(100, Number(url.searchParams.get("limit")) || 20);
    return send(res, 200, { ok: true, user: publicUser(user), wallet: wallet.summarize(user, limit) });
  }

  // 下单：先向支付宝预下单成功、再建本地订单（避免「本地有单、支付宝没有」的孤儿单）。
  if (method === "POST" && p === "/api/wallet/recharge/create") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    if (!rechargeAllowed(user)) {
      return send(res, 403, { ok: false, code: "RECHARGE_NOT_OPEN", error: "充值功能尚未对该账号开放" });
    }
    const st = alipayStatus();
    if (!st.configured) {
      return send(res, 503, {
        ok: false,
        code: "ALIPAY_UNAVAILABLE",
        error: "支付宝支付通道未配置（缺少 " + st.missing.join(" / ") + "）",
        missing: st.missing,
      });
    }
    const b = await jsonBody();
    /* 入参一律「元」（金额以元为单位提交，如 10 / 0.01）；内部换算成整数分记账。
       兼容老客户端残留的 amountCents（值仍是分），但不对外再提「分」。 */
    const amountCents = b.amountYuan != null ? Math.round(centsOfYuan(Number(b.amountYuan))) : Math.round(Number(b.amountCents));
    const verr = validateAmount(amountCents);
    if (verr) {
      return send(res, 400, {
        ok: false,
        code: "INVALID_AMOUNT",
        error: verr,
        minYuan: yuanOfCents(RECHARGE_MIN_CENTS),
        maxYuan: yuanOfCents(RECHARGE_MAX_CENTS),
      });
    }
    const ip = clientIp(req);
    const gate = ipGate("recharge-create", ip, RECHARGE_CREATE_IP_HOURLY_MAX);
    if (!gate.ok) return rateLimited(res, gate);

    // 顺手把本地过期单结掉（并去支付宝关单），再限同账号未支付单数量，防堆积。
    const due = wallet.expireDue();
    for (const o of due) await closeOrderBestEffort(o);
    const pendingMine = wallet.listOrders({ userId: user.id, status: "pending", pageSize: 50 }).items;
    if (pendingMine.length >= 10) {
      if (due.length) await saveDb();
      return send(res, 429, { ok: false, code: "TOO_MANY_PENDING", error: "未支付订单过多，请先完成支付或等其过期" });
    }
    ipCommit(gate);

    const outTradeNo = makeOrderId();
    const subject = "MTNode 账户充值";
    const bodyText = "账号 " + (user.username || user.id) + " 充值 " + yuanOfCents(amountCents) + " 元";
    /* 通道二选一（MTNODE_ALIPAY_CHANNEL，默认 page）：
       · page      电脑网站支付：只生成签名跳转 URL，不调接口 → 客户端用系统浏览器打开收银台。
                   线上实测该 APPID 已签约这个产品，而当面付回 ACQ.ACCESS_FORBIDDEN（未签约）。
       · precreate 当面付：POST 拿 qr_code，服务端自绘二维码，客户端窗内扫码。
       两条通道的入账口径完全一样：异步 notify（验签 + 幂等）为主，trade.query 轮询兜底。 */
    const usePage = st.channel !== "precreate";
    let pay = null;
    if (usePage) {
      pay = alipayPagePayUrl({ outTradeNo, totalAmountCents: amountCents, subject, body: bodyText, timeoutExpress: "15m" });
    } else {
      pay = await alipayPrecreate({ outTradeNo, totalAmountCents: amountCents, subject, body: bodyText, timeoutExpress: "15m" });
    }
    if (!pay.ok) {
      if (due.length) await saveDb();
      return send(res, 502, {
        ok: false,
        code: pay.code || "ALIPAY_ERROR",
        error: pay.error || (usePage ? "生成支付宝收银台链接失败" : "支付宝预下单失败"),
        subCode: pay.subCode || "",
        subMsg: pay.subMsg || "",
      });
    }
    const order = wallet.createOrder({
      user,
      amountCents,
      clientIp: ip,
      id: outTradeNo,
      channel: usePage ? "alipay_page" : "alipay_f2f",
    });
    wallet.attachQr(order.id, usePage
      ? { payUrl: pay.url }
      : { qrCode: pay.qrCode, qrDataUrl: qrDataUrl(pay.qrCode, { title: "支付宝付款码" }) });
    await saveDb();
    console.log("[recharge] 下单 " + order.id + " " + yuanOfCents(amountCents) + " 元 · " + (usePage ? "page.pay" : "当面付") + " · " + (user.username || user.id));
    return send(res, 200, {
      ok: true,
      order: wallet.publicOrder(order),
      expiresIn: Math.max(0, Math.ceil((order.expiresAt - now()) / 1000)),
    });
  }

  // 订单状态（客户端 2 秒轮询）：只回自己的单；顺带做惰性过期。
  if (method === "GET" && p === "/api/wallet/recharge/order") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    if (!rechargeAllowed(user)) {
      return send(res, 403, { ok: false, code: "RECHARGE_NOT_OPEN", error: "充值功能尚未对该账号开放" });
    }
    const id = String(url.searchParams.get("id") || "");
    const order = wallet.getOrder(id);
    if (!order || order.userId !== user.id) {
      return send(res, 404, { ok: false, code: "ORDER_NOT_FOUND", error: "订单不存在" });
    }
    if (order.status === "pending" && order.expiresAt <= now()) {
      wallet.expireDue();
      await closeOrderBestEffort(order);
      await saveDb();
    }
    return send(res, 200, {
      ok: true,
      order: wallet.publicOrder(order),
      serverTime: now(),
      expiresIn: Math.max(0, Math.ceil((order.expiresAt - now()) / 1000)),
    });
  }

  // 「我已完成支付」：主动向支付宝查单并入账（notify 丢失时的兜底）。
  if (method === "POST" && p === "/api/wallet/recharge/refresh") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    if (!rechargeAllowed(user)) {
      return send(res, 403, { ok: false, code: "RECHARGE_NOT_OPEN", error: "充值功能尚未对该账号开放" });
    }
    const b = await jsonBody();
    const id = String(b.id || b.orderId || "");
    const order = wallet.getOrder(id);
    if (!order || order.userId !== user.id) {
      return send(res, 404, { ok: false, code: "ORDER_NOT_FOUND", error: "订单不存在" });
    }
    const gate = ipGate("wallet-refresh", clientIp(req), WALLET_REFRESH_IP_HOURLY_MAX);
    if (!gate.ok) return rateLimited(res, gate);
    ipCommit(gate);
    const r = await syncOrderFromAlipay(order, "query");
    if (!r.ok) {
      return send(res, 502, {
        ok: false,
        code: r.code || "ALIPAY_ERROR",
        error: r.error || "查询支付宝交易失败",
        order: wallet.publicOrder(order),
      });
    }
    return send(res, 200, {
      ok: true,
      paid: !!r.paid,
      closed: !!r.closed,
      tradeStatus: r.tradeStatus || "",
      code: r.code || "",
      order: wallet.publicOrder(order),
      balanceYuan: yuanOfCents(wallet.balanceOf(user)),
    });
  }

  // 支付宝异步通知：验签为准，成功必须回纯文本 `success`，否则支付宝会重试。
  if (method === "POST" && p === "/api/pay/alipay/notify") {
    const raw = (await readBody(req)).toString("utf8");
    const params = parseNotifyForm(raw);
    const n = normalizeNotify(params);
    if (!n.ok) {
      console.warn("[recharge] 通知被拒（" + n.reason + "）out_trade_no=" + (params.out_trade_no || "无"));
      return sendText(res, 400, "failure");
    }
    // 非成功状态（WAIT_BUYER_PAY / TRADE_CLOSED）：已收到，回 success 止住重试。
    if (!n.accepted) return sendText(res, 200, "success");
    const order = wallet.getOrder(n.outTradeNo);
    if (!order) {
      console.warn("[recharge] 通知对应订单不存在：" + n.outTradeNo);
      return sendText(res, 200, "success");
    }
    try {
      const r = await wallet.creditPaid({
        order,
        tradeNo: n.tradeNo,
        amountCents: n.amountCents,
        buyerId: n.buyerId,
        paidAt: parseAlipayTime(n.paidAt) || now(),
        source: "notify",
      });
      console.log(
        "[recharge] 通知入账 " + order.id + " → " + order.status +
          (r.duplicated ? "（重复通知，已幂等）" : "") +
          (r.code === "AMOUNT_MISMATCH" ? "（金额不符，待人工处理）" : "") +
          (r.latePaid ? "（过期后到账）" : ""),
      );
      return sendText(res, 200, "success");
    } catch (e) {
      console.error("[recharge] 入账失败，等支付宝重试：" + ((e && e.message) || e));
      return sendText(res, 500, "failure");
    }
  }

  // 支付通道自检（不含任何密钥材料）：部署后一眼看出缺哪个 env。
  if (method === "GET" && p === "/api/pay/alipay/status") {
    return send(res, 200, { ok: true, alipay: alipayStatus() });
  }

  /* ====================================================================== *
   * 管理平台（独立界面 · 仅 ms2308 微信扫码 · 网站不设入口）
   * ====================================================================== */

  // 扫码登录第 1 步：拿 device_code 与 qrconnect 地址（管理页用 iframe 内嵌）。
  if (method === "POST" && p === "/api/admin/login/wechat/start") {
    if (!wechatConfigured()) {
      return send(res, 503, { ok: false, code: "WECHAT_UNAVAILABLE", error: "微信登录未配置" });
    }
    const gate = ipGate("admin-login", clientIp(req), ADMIN_LOGIN_IP_HOURLY_MAX);
    if (!gate.ok) return rateLimited(res, gate);
    ipCommit(gate);
    pruneWechat();
    const deviceCode = crypto.randomBytes(16).toString("hex");
    const state = crypto.randomBytes(16).toString("hex");
    wechatDevices.set(deviceCode, {
      state,
      createdAt: now(),
      expiresAt: now() + WECHAT_DEVICE_MS,
      ticket: "",
      bindUserId: "", // 管理页永远不是「绑定」意图
      admin: true,
    });
    wechatStates.set(state, deviceCode);
    const authUrl =
      "https://open.weixin.qq.com/connect/qrconnect?appid=" + encodeURIComponent(WECHAT_APPID) +
      "&redirect_uri=" + encodeURIComponent(WECHAT_REDIRECT) +
      "&response_type=code&scope=snsapi_login" +
      "&state=" + encodeURIComponent(state) +
      "#wechat_redirect";
    return send(res, 200, {
      ok: true,
      deviceCode,
      device_code: deviceCode,
      authUrl,
      expiresIn: Math.floor(WECHAT_DEVICE_MS / 1000),
      interval: WECHAT_POLL_INTERVAL,
    });
  }

  // 扫码登录第 2 步：轮询 → 校验管理员资格 → 发 8 小时独立会话。**绝不新建账号**。
  if (method === "POST" && p === "/api/admin/login/wechat/poll") {
    if (!wechatConfigured()) {
      return send(res, 503, { ok: false, code: "WECHAT_UNAVAILABLE", error: "微信登录未配置" });
    }
    const gate = ipGate("admin-poll", clientIp(req), ADMIN_POLL_IP_HOURLY_MAX);
    if (!gate.ok) return rateLimited(res, gate);
    ipCommit(gate);
    pruneWechat();
    const b = await jsonBody();
    const deviceCode = String(b.deviceCode || b.device_code || "").trim();
    if (!deviceCode) return send(res, 400, { ok: false, code: "CODE_EXPIRED", error: "缺少 deviceCode" });
    const dev = wechatDevices.get(deviceCode);
    if (!dev || dev.expiresAt <= now()) {
      wechatDevices.delete(deviceCode);
      return send(res, 400, { ok: false, code: "CODE_EXPIRED", error: "二维码已过期，请重新扫码" });
    }
    if (!dev.ticket) return send(res, 200, { ok: true, status: "pending" });
    const t = peekWechatTicket(dev.ticket);
    if (!t) {
      wechatDevices.delete(deviceCode);
      return send(res, 400, { ok: false, code: "CODE_EXPIRED", error: "二维码已过期，请重新扫码" });
    }
    consumeWechatTicket(dev.ticket);
    wechatDevices.delete(deviceCode);

    let u = identityGet("wechat_unionid", t.unionid);
    const mapped = await loginWithOwnerMap({
      unionid: t.unionid,
      openid: t.openid,
      nickname: t.nickname,
      current: u,
    });
    if (mapped) u = mapped.user;
    if (!u) {
      return send(res, 403, {
        ok: false,
        code: "ADMIN_REQUIRED",
        error: "该微信未绑定任何账号；请先在 MTNode 客户端用管理员账号登录并绑定微信",
      });
    }
    if (!adminEligible(u)) {
      return send(res, 403, { ok: false, code: "ADMIN_FORBIDDEN", error: "该账号不是管理平台管理员" });
    }
    if (t.openid && u.wechatOpenId !== t.openid) u = (await applyUserPatch(u.id, { wechatOpenId: t.openid })) || u;
    const token = await issueAdminSession(u);
    await saveDb();
    console.log("[admin] 管理员登录成功：" + (u.username || u.id));
    return send(res, 200, {
      ok: true,
      status: "done",
      token,
      user: publicUser(u),
      expiresIn: Math.floor(ADMIN_SESSION_MS / 1000),
    });
  }

  if (method === "POST" && p === "/api/admin/logout") {
    const m = /^Bearer\s+(adm_\S+)$/i.exec(String(req.headers.authorization || ""));
    if (m) await revokeAdminSession(m[1]);
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && p === "/api/admin/overview") {
    const a = requireAdmin(req, res);
    if (!a) return;
    return send(res, 200, {
      ok: true,
      admin: publicUser(a.user),
      sessionExpiresAt: a.session.expiresAt,
      // stats 里附打赏汇总（count 未撤销笔数 / totalYuan 未撤销总额），管理台概览卡片直接用
      stats: Object.assign(wallet.stats(), { tips: plans.adminStats() }),
      alipay: alipayStatus(),
      wechat: { configured: wechatConfigured(), ownerMapEntries: WECHAT_OWNER_MAP.size },
      config: {
        tiersYuan: rechargeTiersYuan(),
        minYuan: yuanOfCents(RECHARGE_MIN_CENTS),
        maxYuan: yuanOfCents(RECHARGE_MAX_CENTS),
        /* 充值闸门：现在只有「全局关闭」一个开关（见 rechargeAllowed）。名单口径已作废，
           rechargeUsers 恒为空数组 —— 管理台据此显示「对所有账号开放」。 */
        rechargeUsers: Array.from(RECHARGE_USERS),
        rechargeClosed: rechargeGloballyClosed(),
      },
    });
  }

  if (method === "GET" && p === "/api/admin/orders") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const r = wallet.listOrders({
      userId: url.searchParams.get("userId") || "",
      status: url.searchParams.get("status") || "",
      q: url.searchParams.get("q") || "",
      page: Number(url.searchParams.get("page")) || 1,
      pageSize: Number(url.searchParams.get("pageSize")) || 20,
    });
    return send(res, 200, {
      ok: true,
      total: r.total,
      page: r.page,
      pageSize: r.pageSize,
      items: r.items.map((o) => wallet.adminOrder(o)),
    });
  }

  const adminOrderR = /^\/api\/admin\/orders\/([^/]+)$/.exec(p);
  if (adminOrderR && method === "GET") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const order = wallet.getOrder(decodeURIComponent(adminOrderR[1]));
    if (!order) return send(res, 404, { ok: false, code: "ORDER_NOT_FOUND", error: "订单不存在" });
    const entries = wallet
      .listLedger({ limit: 200 })
      .filter((e) => e.orderId === order.id)
      .map((e) => wallet.adminLedger(e));
    return send(res, 200, { ok: true, order: wallet.adminOrder(order), ledger: entries });
  }

  // 手动补单：主动查支付宝交易状态并入账（notify 丢失 / 用户提前关窗时用）。
  const adminRecheckR = /^\/api\/admin\/orders\/([^/]+)\/recheck$/.exec(p);
  if (adminRecheckR && method === "POST") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const order = wallet.getOrder(decodeURIComponent(adminRecheckR[1]));
    if (!order) return send(res, 404, { ok: false, code: "ORDER_NOT_FOUND", error: "订单不存在" });
    const r = await syncOrderFromAlipay(order, "admin_recheck");
    if (!r.ok) {
      return send(res, 502, {
        ok: false,
        code: r.code || "ALIPAY_ERROR",
        error: r.error || "查询支付宝交易失败",
        order: wallet.adminOrder(order),
      });
    }
    console.log("[admin] 补单 " + order.id + " → " + order.status + " by " + (a.user.username || a.user.id));
    return send(res, 200, {
      ok: true,
      paid: !!r.paid,
      closed: !!r.closed,
      unchanged: !!r.unchanged,
      tradeStatus: r.tradeStatus || "",
      code: r.code || "",
      order: wallet.adminOrder(order),
    });
  }

  // 退款：先本地预检（余额够不够）→ 调支付宝 → 成功才记账。
  const adminRefundR = /^\/api\/admin\/orders\/([^/]+)\/refund$/.exec(p);
  if (adminRefundR && method === "POST") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const orderId = decodeURIComponent(adminRefundR[1]);
    const b = await jsonBody();
    /* 入参一律「元」（如 0.2130）：内部换算成整数分再走退款链路 */
    const amountCents = Math.round(centsOfYuan(Number(b.amountYuan)));
    const note = String(b.note || "").trim();
    const pre = wallet.canRefund({ orderId, amountCents, user: null });
    // 订单/账号不存在 → 404；余额不足、超可退额、金额非法 → 400（管理页据此分别提示）
    if (!pre.ok) {
      return send(res, pre.code === "ORDER_NOT_FOUND" || pre.code === "USER_NOT_FOUND" ? 404 : 400, {
        ok: false,
        code: pre.code,
        error: pre.error,
      });
    }
    if (!note) return send(res, 400, { ok: false, code: "NOTE_REQUIRED", error: "退款必须填写原因" });
    const st = alipayStatus();
    if (!st.configured) {
      return send(res, 503, {
        ok: false,
        code: "ALIPAY_UNAVAILABLE",
        error: "支付宝支付通道未配置（缺少 " + st.missing.join(" / ") + "）",
      });
    }
    const outRequestNo = String(b.outRequestNo || "").trim() ||
      orderId + "_r" + ((pre.order.refunds || []).length + 1) + "_" + crypto.randomBytes(2).toString("hex");
    const ar = await alipayRefund({
      outTradeNo: orderId,
      refundAmountCents: amountCents,
      outRequestNo,
      refundReason: note,
    });
    if (!ar.ok) {
      return send(res, 502, {
        ok: false,
        code: ar.code || "ALIPAY_ERROR",
        error: ar.error || "支付宝退款失败",
        subCode: ar.subCode || "",
        subMsg: ar.subMsg || "",
      });
    }
    const r = await wallet.refundOrder({
      orderId,
      amountCents,
      outRequestNo,
      tradeNo: ar.tradeNo,
      note,
      operator: a.user.username || a.user.id,
      fundChange: ar.fundChange,
    });
    if (!r.ok) return send(res, 400, { ok: false, code: r.code, error: r.error });
    console.log(
      "[admin] 退款 " + orderId + " " + yuanOfCents(amountCents) + " 元 by " + (a.user.username || a.user.id) +
        (ar.fundChange === "N" ? "（支付宝返回 fund_change=N，可能是重复请求）" : ""),
    );
    return send(res, 200, {
      ok: true,
      order: wallet.adminOrder(r.order),
      ledger: wallet.adminLedger(r.ledger),
      fundChange: ar.fundChange,
      balanceYuan: yuanOfCents(wallet.balanceOf(db.users.find((u) => u.id === r.order.userId) || {})),
    });
  }

  if (method === "GET" && p === "/api/admin/users") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize")) || 50));
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    let arr = (db.users || []).slice();
    if (q) {
      arr = arr.filter(
        (u) =>
          String(u.username || "").toLowerCase().includes(q) ||
          String(u.nickname || "").toLowerCase().includes(q) ||
          String(u.id || "").toLowerCase().includes(q) ||
          String(u.phone || "").includes(q),
      );
    }
    arr.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const total = arr.length;
    const start = (page - 1) * pageSize;
    return send(res, 200, {
      ok: true,
      total,
      page,
      pageSize,
      items: arr.slice(start, start + pageSize).map((u) => ({
        id: u.id,
        username: u.username,
        nickname: u.nickname,
        phone: u.phone ? maskPhone(u.phone) : "",
        wechatBound: !!u.wechatUnionId,
        hasPassword: !!u.pass,
        balanceYuan: yuanOfCents(wallet.balanceOf(u)),
        isAdmin: isAdmin(u),
        adminEligible: adminEligible(u),
        createdAt: u.createdAt,
        /* 每用户应用存储上限（本轮需求：后台逐个用户可调）：
           已用 = 应用包 + 截图 + 图标（截图按内容去重）；limit 为 null = 不限；
           quota 里只回**管理员单独设过**的值（null = 跟随全局默认，界面据此显示「默认 50MB」）。 */
        storage: appStorageViewOf(u),
        quota: {
          bytes: userQuotaLimitOf(u, "bytes", null),
          apps: userQuotaLimitOf(u, "apps", null),
        },
      })),
    });
  }

  /* 改某个用户的应用存储上限（本轮需求：后台允许逐个用户调整）。
   * body：{ bytesLimit, appsLimit }，取值三种 ——
   *   · 数字 = 上限（bytesLimit 是字节、appsLimit 是条数）
   *   · "unlimited" = 不限（内部存 -1）
   *   · null / 缺省 / 0 / "" = 清掉单独设置（回到全局默认）
   * 只改这两个字段，不动余额 / 身份 / 其它任何用户字段。 */
  const adminQuotaR = /^\/api\/admin\/users\/([^/]+)\/quota$/.exec(p);
  if (adminQuotaR && method === "POST") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const key = decodeURIComponent(adminQuotaR[1]);
    const target = (db.users || []).find((u) => u.id === key) || findUserByName(key);
    if (!target) return send(res, 404, { ok: false, code: "USER_NOT_FOUND", error: "账号不存在" });
    const b = await jsonBody();
    if (b.bytesLimit === undefined && b.appsLimit === undefined) {
      return send(res, 400, { ok: false, error: "至少要带一个字段：bytesLimit（存储上限，字节）或 appsLimit（应用条数上限）" });
    }
    /* 归一化：数字 → 取整（bytes 至少 1MB、条数至少 1）；"unlimited" → -1；其它（null/""/0）→ 清掉 */
    const norm = (v, min, label) => {
      if (v == null || v === "" || v === 0 || v === "0") return { ok: true, value: 0 };
      if (String(v).toLowerCase() === "unlimited" || v === -1) return { ok: true, value: -1 };
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: label + "必须是正数、\"unlimited\"，或留空（回到默认）" };
      return { ok: true, value: Math.max(min, Math.round(n)) };
    };
    const next = { bytes: null, apps: null };
    if (b.bytesLimit !== undefined) {
      const r = norm(b.bytesLimit, 1024 * 1024, "存储上限");
      if (!r.ok) return send(res, 400, { ok: false, error: r.error });
      next.bytes = r.value;
    }
    if (b.appsLimit !== undefined) {
      const r = norm(b.appsLimit, 1, "应用条数上限");
      if (!r.ok) return send(res, 400, { ok: false, error: r.error });
      next.apps = r.value;
    }
    const quota = Object.assign({}, target.quota && typeof target.quota === "object" ? target.quota : {});
    const changed = { bytes: false, apps: false };
    for (const k of ["bytes", "apps"]) {
      if (next[k] === null) continue;
      if (next[k] === 0) {
        if (quota[k] != null) {
          delete quota[k];
          changed[k] = true;
        }
        continue;
      }
      if (Number(quota[k]) !== next[k]) {
        quota[k] = next[k];
        changed[k] = true;
      }
    }
    if (Object.keys(quota).length) target.quota = quota;
    else delete target.quota;
    await saveDb();
    console.log(
      "[admin] 应用存储上限 " + (target.username || target.id) + " by " + (admin.user.username || admin.user.id) +
        "：存储 " + (next.bytes === null ? "不变" : next.bytes < 0 ? "不限" : fmtBytes(next.bytes)) +
        " · 条数 " + (next.apps === null ? "不变" : next.apps < 0 ? "不限" : next.apps + " 个"),
    );
    return send(res, 200, {
      ok: true,
      changed: changed,
      quota: {
        bytes: userQuotaLimitOf(target, "bytes", null),
        apps: userQuotaLimitOf(target, "apps", null),
      },
      item: {
        id: target.id,
        username: target.username,
        nickname: target.nickname,
        storage: appStorageViewOf(target),
        quota: {
          bytes: userQuotaLimitOf(target, "bytes", null),
          apps: userQuotaLimitOf(target, "apps", null),
        },
      },
    });
  }

  /* 清理无主图片对象（本轮需求：内容寻址图片库的回收入口；**不自动 GC**，只在这个按钮里做）。
   * 语义：删掉「没有任何应用记录引用」的图片对象 —— 正在被引用的一个都不动。 */
  if (method === "POST" && p === "/api/admin/app-objects/gc") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const r = imgObjectsGc();
    console.log(
      "[admin] 清理无主图片 by " + (admin.user.username || admin.user.id) +
        "：扫描 " + r.scanned + " · 清理 " + r.removed + " · 释放 " + fmtBytes(r.freedBytes),
    );
    return send(res, 200, Object.assign({ ok: true, note: "只删没有任何应用引用的图片对象，正在用的一个都没动" }, r));
  }

  // 人工调账（赠送 / 扣减）：备注必填，全部进流水。
  const adminAdjustR = /^\/api\/admin\/users\/([^/]+)\/adjust$/.exec(p);
  if (adminAdjustR && method === "POST") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const key = decodeURIComponent(adminAdjustR[1]);
    const target = (db.users || []).find((u) => u.id === key) || findUserByName(key);
    if (!target) return send(res, 404, { ok: false, code: "USER_NOT_FOUND", error: "账号不存在" });
    const b = await jsonBody();
    const r = await wallet.adjustBalance({
      user: target,
      /* 入参一律「元」（可负）：内部换算成整数分记账 */
      deltaCents: Math.round(centsOfYuan(Number(b.deltaYuan))),
      note: String(b.note || ""),
      operator: a.user.username || a.user.id,
    });
    if (!r.ok) return send(res, 400, { ok: false, code: r.code, error: r.error });
    console.log(
      "[admin] 调账 " + (target.username || target.id) + " " + yuanOfCents(r.ledger.deltaCents) + " 元 by " +
        (a.user.username || a.user.id) + "：" + r.ledger.note,
    );
    const out = { ok: true, balanceYuan: yuanOfCents(r.balanceCents), ledger: wallet.adminLedger(r.ledger) };
    // 调的是自己 → 顺带回最新账号摘要，客户端 / 管理页立即同步
    if (target.id === a.user.id) out.user = publicUser(target);
    return send(res, 200, out);
  }

  if (method === "GET" && p === "/api/admin/ledger") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const items = wallet
      .listLedger({
        userId: url.searchParams.get("userId") || "",
        type: url.searchParams.get("type") || "",
        limit: Number(url.searchParams.get("limit")) || 50,
      })
      .map((e) => wallet.adminLedger(e));
    return send(res, 200, { ok: true, items });
  }

  /* ==========================================================================
   * 管理台 · 中转服务（配置上游 / 模型 / 价目 + 会话测试 + 改动留痕）
   *   逻辑全在 relay.mjs（adminApi），这里只做管理台会话鉴权与 JSON 收发。
   *   接口一律不回传任何 Key 明文：只给 keyFrom（db / env）+ keyTail（后四位）。
   * ========================================================================== */

  if (method === "GET" && p === "/api/admin/relay") {
    const a = requireAdmin(req, res);
    if (!a) return;
    return send(res, 200, {
      ok: true,
      config: relay.admin.describe(),
      audit: relay.admin.audit(Number(url.searchParams.get("audit")) || 100),
      usage: relay.admin.usage(Number(url.searchParams.get("usage")) || 100),
    });
  }

  /* 管理台 · 调用流水的筛选 + 统计（只读）：窗口 / 时间 / 类型 / 模型 / 账号 / 条数，
     一次回「明细 + 本次筛选合计 + 今日・近 7 天・近 30 天全站合计」（口径在 relay.mjs 的 usageQuery）。 */
  if (method === "GET" && p === "/api/admin/relay/usage") {
    const a = requireAdmin(req, res);
    if (!a) return;
    return send(res, 200, relay.admin.usageQuery({
      window: url.searchParams.get("window") || "",
      from: url.searchParams.get("from") || "",
      to: url.searchParams.get("to") || "",
      model: url.searchParams.get("model") || "",
      userId: url.searchParams.get("userId") || "",
      kind: url.searchParams.get("kind") || "",
      limit: url.searchParams.get("limit") || "",
    }));
  }

  if (method === "POST" && p === "/api/admin/relay/config") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const b = await jsonBody();
    const r = await relay.admin.save(b && b.config ? b.config : b, a.user);
    if (!r.ok) return send(res, 400, { ok: false, code: "RELAY_CONFIG_INVALID", error: (r.errs || []).join("；"), errs: r.errs || [] });
    console.log("[admin] 保存中转配置 by " + (a.user.username || a.user.id) + "：changed=" + r.changed);
    return send(res, 200, { ok: true, changed: r.changed, config: r.config });
  }

  // 从上游 /models 拉候选（只读元信息，不消耗 Token）：填了 Key 就能勾选导入
  if (method === "POST" && p === "/api/admin/relay/upstream-models") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const b = await jsonBody();
    const r = await relay.admin.listUpstreamModels(b || {});
    return send(res, r.ok ? 200 : 400, r);
  }

  // 会话测试的临时 Key（mtr_test_ / 30 分钟 / 只对该管理员 / 只对 /relay/v1/* 生效）
  if (method === "POST" && p === "/api/admin/relay/test-key") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const r = await relay.admin.issueTestKey(a.user);
    if (!r.ok) return send(res, 500, { ok: false, error: r.error || "发 Key 失败" });
    console.log("[admin] 发中转测试 Key by " + (a.user.username || a.user.id) + "（" + r.expiresInSec + "s）");
    return send(res, 200, {
      ok: true,
      token: r.token,
      expiresAt: r.expiresAt,
      expiresInSec: r.expiresInSec,
      baseUrl: RELAY_PUBLIC_BASE,
      balanceYuan: yuanOfCents(totalCentsOf(a.user)),
      totalYuan: yuanOfCents(totalCentsOf(a.user)),
    });
  }

  if (method === "GET" && p === "/api/admin/relay/audit") {
    const a = requireAdmin(req, res);
    if (!a) return;
    return send(res, 200, { ok: true, items: relay.admin.audit(Number(url.searchParams.get("limit")) || 100) });
  }

  /* ---------- 管理台 · 打赏 ---------- */

  // 打赏列表：对象类型 / 账号 / 关键词筛选 + 分页 + 汇总卡片（汇总恒为全站口径）。
  if (method === "GET" && p === "/api/admin/tips") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const r = plans.adminList({
      targetKind: url.searchParams.get("targetKind") || "",
      userId: url.searchParams.get("userId") || "",
      q: url.searchParams.get("q") || "",
      page: Number(url.searchParams.get("page")) || 1,
      pageSize: Number(url.searchParams.get("pageSize")) || 20,
    });
    return send(res, 200, { ok: true, total: r.total, page: r.page, pageSize: r.pageSize, items: r.items, stats: r.stats });
  }

  /* 撤销打赏：**已停用**（需求口径：前后端都不再提供撤销）。路由保留只为给老客户端 / 直连调用
     一个稳定的拒绝回执 —— 一律 403 TIP_REVOKE_DISABLED，不写任何反向流水、不改任何记录。
     历史已撤销的数据与 CSV 里的撤销列一律保留（tip_revoke_* 流水照旧可查）。 */
  if (method === "POST" && p === "/api/admin/tips/revoke") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const b = await jsonBody();
    const r = await plans.adminRevoke({ id: b.id, reason: b.reason });
    return send(res, 403, { ok: false, code: r.code, error: r.error });
  }

  // CSV 导出（UTF-8 BOM，Excel 双击不乱码）：orders / ledger / tips 三种。
  if (method === "GET" && p === "/api/admin/export.csv") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const raw = String(url.searchParams.get("kind") || "orders");
    const kind = raw === "ledger" || raw === "tips" ? raw : "orders";
    // tips 走 tips.mjs 自己的 CSV 出口（列含打赏对象 / 撤销理由），其余仍由 wallet 出。
    const buf = Buffer.from(kind === "tips" ? plans.csvTips() : wallet.csv(kind), "utf8");
    const name = "mtnode-" + kind + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    return sendBin(res, 200, buf, "text/csv; charset=utf-8", {
      "Content-Disposition": 'attachment; filename="' + name + '"',
      "Cache-Control": "no-store",
    });
  }

  /* ---------- 管理台 · 系统资源监控（只读） ---------- */

  // 只在管理台**主动拉取**时采样一次（切到该页签 / 点「刷新」各一次）。
  // 服务端没有后台采样、没有定时器、不留历史 —— 需求口径就是「不自动刷」。
  if (method === "GET" && p === "/api/admin/sysinfo") {
    const a = requireAdmin(req, res);
    if (!a) return;
    return send(res, 200, await sysinfoSnapshot());
  }

  /* ---------- 管理台 · 内容管理（应用 / 模板 / 技能） ---------- */

  /** 列表取数的公共解释：类型 + 关键词 + 状态 + 作者 + 分页；counts 恒为全量（页签角标用）。 */
  function adminContentQuery(kind) {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const author = String(url.searchParams.get("author") || "").trim().toLowerCase();
    const status = String(url.searchParams.get("status") || "").trim().toLowerCase();
    let rows = [];
    if (kind === "app") rows = (db.apps || []).map(adminAppRow);
    else if (kind === "template") rows = (db.templates || []).map(adminTemplateRow);
    else rows = (db.skills || []).map(adminSkillRow);
    rows = rows.filter((r) => adminContentHit(r, q));
    if (author) {
      rows = rows.filter(
        (r) =>
          String(r.ownerName || "").toLowerCase().includes(author) ||
          String(r.ownerId || "").toLowerCase().includes(author),
      );
    }
    /* 应用没有第二个「状态」可筛（本轮两态收敛：列表里的每一条都在线上，被删的已不在库里），
       所以 status 对应用不再过滤；模板 / 技能的状态位照旧往下走。 */
    if (kind === "skill" && (status === "official" || status === "unofficial")) {
      rows = rows.filter((r) => (status === "official" ? r.official : !r.official));
    }
    return { q, author, status, page: adminContentPage(rows, url, 20) };
  }

  // 列表：三类内容各一张表（管理台「内容管理」页内二级页签）。
  if (method === "GET" && p === "/api/admin/content") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const kind = String(url.searchParams.get("kind") || "app").trim().toLowerCase();
    if (!CONTENT_KINDS.includes(kind)) return send(res, 400, { ok: false, error: "未知内容类型：" + kind });
    const r = adminContentQuery(kind);
    return send(res, 200, {
      ok: true,
      kind: kind,
      q: r.q,
      author: r.author,
      status: r.status,
      page: r.page.page,
      pageSize: r.page.pageSize,
      total: r.page.total,
      items: r.page.items,
      counts: adminContentCounts(),
    });
  }

  // 应用的版本历史（管理员视角：任何作者、任何分支；?owner= 指分支）。
  if (method === "GET" && p === "/api/admin/content/versions") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const found = adminContentFind("app", url.searchParams.get("id"), url.searchParams.get("owner"));
    if (!found || !found.row) {
      return send(res, found && found.branchRequired ? 400 : 404, {
        ok: false,
        code: found && found.branchRequired ? "BRANCH_REQUIRED" : "APP_NOT_FOUND",
        error:
          found && found.branchRequired
            ? "这个 id 下有 " + found.branches + " 个作者分支：请用 ?owner=<作者 uid 或账号名> 指定分支"
            : "应用不存在",
      });
    }
    const app = found.row;
    const latest = appLatestVersion(app);
    const items = appVersionRecords(app)
      .slice()
      .sort((x, y) => compareVersions(y.version, x.version))
      .map((v) => {
        let hasFile = false;
        try {
          hasFile = !!locateAppZip(app, v.version);
        } catch {
          hasFile = false;
        }
        return {
          version: v.version,
          parentVersion: v.parentVersion || "",
          bytes: Number(v.bytes) || 0,
          sha256: v.sha256 || "",
          entry: v.entry || "",
          createdAt: Number(v.createdAt) || 0,
          current: v.version === latest,
          hasFile: hasFile,
        };
      });
    return send(res, 200, {
      ok: true,
      id: app.id,
      ownerId: app.userId,
      ownerName: appOwnerNameOf(app.userId),
      title: app.title || app.id,
      latestVersion: latest,
      versionsOn: appVersionsOn(),
      items: items,
    });
  }

  // 改动留痕（最近 N 条，默认 100）。
  if (method === "GET" && p === "/api/admin/content/audit") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const limit = Math.min(CONTENT_AUDIT_MAX, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    return send(res, 200, { ok: true, items: contentAuditList().slice(0, limit) });
  }

  // 下载（管理员排查用）：应用 zip / 模板 .mtnodes / 技能包内单个文件。
  // **不计下载量**（这不是用户下载，别把作者的统计刷上去）。
  if (method === "GET" && p === "/api/admin/content/download") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const kind = String(url.searchParams.get("kind") || "").trim().toLowerCase();
    const id = String(url.searchParams.get("id") || "").trim();
    const raw = url.searchParams.get("format") === "raw";
    if (kind === "app") {
      const found = adminContentFind("app", id, url.searchParams.get("owner"));
      if (!found || !found.row) return send(res, 404, { ok: false, error: "应用不存在" });
      const app = found.row;
      const wantVersion = String(url.searchParams.get("version") || "").trim();
      const loc = locateAppZip(app, wantVersion);
      if (!loc) {
        return send(res, 404, {
          ok: false,
          code: wantVersion ? "VERSION_NOT_FOUND" : "FILE_MISSING",
          error: wantVersion ? "该版本不存在：v" + wantVersion : "应用包缺失",
        });
      }
      const buf = fs.readFileSync(loc.path);
      const name = appFileStem(app.id, loc.ownerId || app.userId) + (wantVersion ? "-v" + wantVersion : "") + ".zip";
      if (!raw) return send(res, 200, { ok: true, kind: kind, id: app.id, version: wantVersion || appLatestVersion(app), bytes: buf.length, name: name });
      return sendBin(res, 200, buf, "application/zip", {
        "Content-Disposition": 'attachment; filename="' + name + '"',
        "Cache-Control": "no-store",
      });
    }
    if (kind === "template") {
      const t = (db.templates || []).find((x) => x.id === id);
      if (!t) return send(res, 404, { ok: false, error: "模板不存在" });
      const fp = path.join(FILE_DIR, t.id + ".mtnodes");
      if (!fs.existsSync(fp)) return send(res, 404, { ok: false, error: "文件缺失" });
      const buf = fs.readFileSync(fp);
      const name = t.id + ".mtnodes";
      if (!raw) return send(res, 200, { ok: true, kind: kind, id: t.id, bytes: buf.length, name: name });
      return sendBin(res, 200, buf, "application/octet-stream", {
        "Content-Disposition": 'attachment; filename="' + name + '"',
        "Cache-Control": "no-store",
      });
    }
    if (kind === "skill") {
      const s = (db.skills || []).find((x) => x.id === id);
      if (!s) return send(res, 404, { ok: false, error: "技能不存在" });
      const want = String(url.searchParams.get("file") || "SKILL.md").replace(/\\/g, "/");
      if (want.includes("..") || want.startsWith("/") || want.includes("\0")) {
        return send(res, 400, { ok: false, error: "非法文件名" });
      }
      const listed = listSkillBundleFiles(s.id);
      const hit = (listed.files || []).find((f) => f.path === want);
      if (!hit) return send(res, 404, { ok: false, code: "FILE_MISSING", error: "技能包里没有这个文件：" + want });
      const base = skillBundleDir(s.id);
      const fp = path.resolve(base, ...want.split("/"));
      if (fp !== path.resolve(base) && !fp.startsWith(path.resolve(base) + path.sep)) {
        return send(res, 403, { ok: false, error: "非法路径" });
      }
      if (!fs.existsSync(fp)) return send(res, 404, { ok: false, code: "FILE_MISSING", error: "文件缺失" });
      const buf = fs.readFileSync(fp);
      const name = (s.skillName || s.id) + "-" + path.basename(want);
      if (!raw) return send(res, 200, { ok: true, kind: kind, id: s.id, file: want, bytes: buf.length, name: name });
      return sendBin(res, 200, buf, "application/octet-stream", {
        "Content-Disposition": 'attachment; filename="' + name.replace(/[^\w.\-]/g, "_") + '"',
        "Cache-Control": "no-store",
      });
    }
    return send(res, 400, { ok: false, error: "未知内容类型：" + kind });
  }

  // 预览图 / 图标（模板与技能各一张预览图；应用看图标）。只读。
  if (method === "GET" && p === "/api/admin/content/preview") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const kind = String(url.searchParams.get("kind") || "").trim().toLowerCase();
    const id = String(url.searchParams.get("id") || "").trim();
    const size = String(url.searchParams.get("size") || "thumb").toLowerCase() === "full" ? "full" : "thumb";
    if (kind === "app") {
      const found = adminContentFind("app", id, url.searchParams.get("owner"));
      if (!found || !found.row) return send(res, 404, { ok: false, error: "应用不存在" });
      const fp = appIconPath(found.row.id, found.row.userId);
      if (!fp) return send(res, 404, { ok: false, error: "无图标" });
      return sendBin(res, 200, fs.readFileSync(fp), previewMime(fp), { "Cache-Control": "no-store" });
    }
    let has = false;
    if (kind === "template") {
      const t = (db.templates || []).find((x) => x.id === id);
      has = !!(t && t.hasPreview);
    } else if (kind === "skill") {
      const s = (db.skills || []).find((x) => x.id === id);
      has = !!(s && s.hasPreview);
    } else {
      return send(res, 400, { ok: false, error: "未知内容类型：" + kind });
    }
    const fp = has ? previewPath(id, size) : null;
    if (!fp) return send(res, 404, { ok: false, error: "无预览图" });
    return sendBin(res, 200, fs.readFileSync(fp), previewMime(fp), { "Cache-Control": "no-store" });
  }

  /* 管理台内容可见性开关（POST /api/admin/content/publish）**已整体移除**：
     本轮产品口径收敛为「在线上 / 完全被删除」两态，没有第三条可见性位 ——
     应用要不要留在线上由「作者是否删除」唯一决定，管理台不再有单独的上下架动作。
     旧路径照作者侧那条同一写法如实回 404 +「该接口已下线」（老管理台页面还摆着按钮时
     会收到明确答复，绝不静默成功）；鉴权口径不动，仍先过 requireAdmin。 */
  if (method === "POST" && p === "/api/admin/content/publish") {
    const a = requireAdmin(req, res);
    if (!a) return;
    return send(res, 404, { ok: false, code: "NOT_FOUND", error: "该接口已下线" });
  }

  // 编辑元信息（标题 / 简介 / 标签 / 图标 / 技能版本号与官方标记）。
  // 文件正文与 zip 一律不在这里换；应用的 version 由版本记录掌管，也不手改。
  if (method === "POST" && p === "/api/admin/content/update") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const b = await jsonBody();
    const kind = String(b.kind || "").trim().toLowerCase();
    if (!CONTENT_KINDS.includes(kind)) return send(res, 400, { ok: false, error: "未知内容类型：" + kind });
    const found = adminContentFind(kind, b.id, b.ownerId || b.owner);
    if (!found || !found.row) {
      return send(res, found && found.branchRequired ? 400 : 404, {
        ok: false,
        code: found && found.branchRequired ? "BRANCH_REQUIRED" : "NOT_FOUND",
        error: found && found.branchRequired ? "这个 id 下有 " + found.branches + " 个作者分支：请指明 ownerId（应用身份 = id + 作者 uid，管理台不会替你挑一条）" : "内容不存在",
      });
    }
    const row = found.row;
    const before = kind === "app" ? adminAppRow(row) : kind === "template" ? adminTemplateRow(row) : adminSkillRow(row);
    const changed = [];
    if (b.title !== undefined) {
      const title = String(b.title == null ? "" : b.title).trim().slice(0, 80);
      if (!title) return send(res, 400, { ok: false, error: "标题不能为空" });
      row.title = title;
      changed.push("标题");
    }
    if (b.description !== undefined || b.desc !== undefined) {
      const desc = String(b.description !== undefined ? b.description : b.desc).trim().slice(0, 2000);
      row.description = desc;
      changed.push("简介");
    }
    if (b.tags !== undefined) {
      row.tags = parseTags(b.tags);
      changed.push("标签");
    }
    if (kind === "skill" && b.version !== undefined) {
      try {
        row.version = normalizeVersion(b.version, row.version || "1.0.0");
      } catch (e) {
        return send(res, 400, { ok: false, error: (e && e.message) || String(e) });
      }
      changed.push("版本号");
    }
    if (kind === "skill" && b.official !== undefined) {
      row.official = !!b.official;
      changed.push(row.official ? "官方标记（已设为官方）" : "官方标记（已取消官方）");
    }
    // 图标：应用专属（模板 / 技能的预览图由作者上传，管理台只读）。
    if (kind === "app" && (b.iconBase64 || b.iconClear)) {
      if (b.iconClear) {
        clearAppIcon(row.id, row.userId);
        changed.push("清除图标");
      } else {
        let icon = null;
        try {
          icon = decodePreview(b.iconBase64);
        } catch (e) {
          return send(res, 400, { ok: false, error: "图标无效：" + ((e && e.message) || e) });
        }
        if (!icon) return send(res, 400, { ok: false, error: "图标无效" });
        writeAppIcon(row.id, row.userId, icon);
        changed.push("图标");
      }
    }
    if (!changed.length) return send(res, 400, { ok: false, error: "没有要改的字段" });
    row.updatedAt = now();
    const after = kind === "app" ? adminAppRow(row) : kind === "template" ? adminTemplateRow(row) : adminSkillRow(row);
    await contentAuditPush(a.user, "update", kind, after, "改了" + changed.join(" / "));
    if (kind === "app") publishStaticApps("管理台更新应用 " + row.id);
    return send(res, 200, { ok: true, item: after, before: before, changed: changed, counts: adminContentCounts() });
  }

  // 删除单条：应用 = 删这一条作者分支（含各版本 zip 与图标），模板 / 技能 = 删记录与文件。
  if (method === "POST" && p === "/api/admin/content/delete") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const b = await jsonBody();
    const kind = String(b.kind || "").trim().toLowerCase();
    if (!CONTENT_KINDS.includes(kind)) return send(res, 400, { ok: false, error: "未知内容类型：" + kind });
    const found = adminContentFind(kind, b.id, b.ownerId || b.owner);
    if (!found || !found.row) {
      return send(res, found && found.branchRequired ? 400 : 404, {
        ok: false,
        code: found && found.branchRequired ? "BRANCH_REQUIRED" : "NOT_FOUND",
        error: found && found.branchRequired ? "这个 id 下有 " + found.branches + " 个作者分支：请指明 ownerId（应用身份 = id + 作者 uid，管理台不会替你挑一条）" : "内容不存在",
      });
    }
    if (kind === "app") {
      const app = found.row;
      const row = adminAppRow(app);
      /* 删除前的元信息快照（版本列表 / 删除时最高版）：审计与已删除留痕都要它，
         记录一旦删掉就再也算不出来了（见 appBranchDeleteMeta）。 */
      const meta = appBranchDeleteMeta(app);
      /* 与作者侧「删除」「删掉最后一个版本」共用同一份实现（deleteAppBranch）：
         记录 + 包 + 图标 + 截图 + 封面缩略图 + 静态目录（含空目录）+ 无主图片对象一次清完。
         管理台原来也是各写一份 —— 几份一漂移就会出现「记录没了、文件还在」这种痕迹。 */
      const del = await deleteAppBranch(app, meta);
      await contentAuditPush(
        a.user,
        "delete",
        "app",
        row,
        "删整条分支（版本 " + (meta.versions.join(" / ") || "—") + " · 删除时最高版 " + (meta.latestVersion || "—") + "）",
      );
      syncAppZipMirrorGlobal(app.id);
      publishStaticApps("管理台删除分支 " + app.id + "（" + appOwnerNameOf(app.userId) + "）");
      console.log(
        "[mtnode-store] 管理台删除分支 " + app.id + "/" + app.userId + "：静态文件 " +
          ((del.removed && del.removed.staticFiles) || []).length + " 个 / 空目录 " +
          ((del.removed && del.removed.staticDirs) || []).length + " 个 / 回收无主图片 " +
          ((del.imgGc && del.imgGc.removed) || 0) + " 个",
      );
      return send(res, 200, { ok: true, kind: kind, id: app.id, ownerId: app.userId, deleted: true, counts: adminContentCounts() });
    }
    if (kind === "template") {
      const t = found.row;
      const row = adminTemplateRow(t);
      const idx = db.templates.findIndex((x) => x.id === t.id);
      const owner = db.users.find((u) => u.id === t.userId);
      if (owner) {
        await applyUserPatch(owner.id, {
          downloadsReceived: Math.max(0, (owner.downloadsReceived || 0) - (t.downloads || 0)),
          likesReceived: Math.max(0, (owner.likesReceived || 0) - (t.likes || 0)),
        });
      }
      db.likes = db.likes.filter((l) => l.templateId !== t.id);
      db.templates.splice(idx, 1);
      try { fs.unlinkSync(path.join(FILE_DIR, t.id + ".mtnodes")); } catch {}
      clearPreviews(t.id);
      await contentAuditPush(a.user, "delete", "template", row, "删模板与其文件");
      return send(res, 200, { ok: true, kind: kind, id: t.id, counts: adminContentCounts() });
    }
    const s = found.row;
    const srow = adminSkillRow(s);
    const idx = db.skills.findIndex((x) => x.id === s.id);
    const owner = db.users.find((u) => u.id === s.userId);
    if (owner) {
      await applyUserPatch(owner.id, {
        downloadsReceived: Math.max(0, (owner.downloadsReceived || 0) - (s.downloads || 0)),
        likesReceived: Math.max(0, (owner.likesReceived || 0) - (s.likes || 0)),
      });
    }
    db.skillLikes = db.skillLikes.filter((l) => l.skillId !== s.id);
    db.skills.splice(idx, 1);
    clearSkillFile(s.id);
    clearPreviews(s.id);
    await contentAuditPush(a.user, "delete", "skill", srow, "删技能与其文件包");
    return send(res, 200, { ok: true, kind: kind, id: s.id, counts: adminContentCounts() });
  }

  /* 删应用的某一个版本（管理员视角；两态口径与本轮作者侧一致）：
     · 还剩版本 → 这条分支照旧**在线上**，最高版指向剩余最高版（包与静态目录照常刷新）；
     · 删到零版本 → 走 deleteAppBranch **彻底删除**整条分支，回 deleted:true
       （与作者侧「删掉最后一个版本」、管理台「删除」同一份实现，口径永远一致）。 */
  if (method === "POST" && p === "/api/admin/content/delete-version") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const b = await jsonBody();
    const found = adminContentFind("app", b.id, b.ownerId || b.owner);
    if (!found || !found.row) {
      return send(res, found && found.branchRequired ? 400 : 404, {
        ok: false,
        code: found && found.branchRequired ? "BRANCH_REQUIRED" : "APP_NOT_FOUND",
        error: found && found.branchRequired ? "这个 id 下有 " + found.branches + " 个作者分支：请指明 ownerId（应用身份 = id + 作者 uid，管理台不会替你挑一条）" : "应用不存在",
      });
    }
    const app = found.row;
    const want = String(b.version || "").trim();
    const recs = appVersionRecords(app).slice();
    const vi = recs.findIndex((v) => v.version === want);
    if (vi < 0) return send(res, 404, { ok: false, code: "VERSION_NOT_FOUND", error: "该版本不存在：v" + want });
    /* 删除前的快照：这一版可能正好是**最后一版**（下面要走彻底删除 + 留痕），
       记录与版本列表一旦改过就再也算不出来了（见 appBranchDeleteMeta）。 */
    const rowBefore = adminAppRow(app);
    const metaBefore = appBranchDeleteMeta(app);
    recs.splice(vi, 1);
    app.versions = recs;
    try { fs.unlinkSync(appBranchVersionZipPath(app.id, app.userId, want)); } catch {}
    if (!(db.apps || []).some((x) => x !== app && x.id === app.id && appVersionRecords(x).some((v) => v.version === want))) {
      try { fs.unlinkSync(appVersionZipPath(app.id, want)); } catch {}
    }
    if (!recs.length) {
      /* 全删光 = **这一分支彻底不存在**（管理台原来只置一个可见性位，界面上还留着「已下架」——
         管理员以为删干净了，云端却还占着配额与目录；本轮收敛为两态的直接原因就是这个）。
         留痕：审计行带删除前的元信息（含版本列表与删除时最高版）；同一 id 下还有别的
         作者分支时 deleteAppBranch 另写一条已删除留痕（见 appDeletedLedgerPush）。 */
      const del = await deleteAppBranch(app, metaBefore);
      syncAppZipMirrorGlobal(app.id);
      await contentAuditPush(
        a.user,
        "delete-version",
        "app",
        rowBefore,
        "删最后一版 = 彻底删除整条分支（版本 " + (metaBefore.versions.join(" / ") || "—") +
          " · 删除时最高版 " + (metaBefore.latestVersion || "—") + "）",
      );
      publishStaticApps("管理台删最后一版 = 彻底删除 " + app.id + "（" + appOwnerNameOf(app.userId) + "）");
      console.log(
        "[mtnode-store] 管理台删最后一版 → 彻底删除分支 " + app.id + "/" + app.userId +
          "：静态文件 " + ((del.removed && del.removed.staticFiles) || []).length +
          " 个 / 空目录 " + ((del.removed && del.removed.staticDirs) || []).length +
          " 个 / 回收无主图片 " + ((del.imgGc && del.imgGc.removed) || 0) + " 个",
      );
      return send(res, 200, {
        ok: true,
        id: app.id,
        ownerId: app.userId,
        /* deleted:true = 这一版是最后一版，整条分支已被彻底删除（老管理台据此说「云端已无这个应用」） */
        deleted: true,
        latestVersion: "",
        remaining: 0,
        counts: adminContentCounts(),
      });
    }
    /* 还有剩余版本：删的是最新版 → latestVersion 指向剩余最高版，并把镜像刷成它。 */
    const top = recs.reduce((best, v) => (compareVersions(v.version, best.version) > 0 ? v : best), recs[0]);
    app.latestVersion = top.version;
    app.version = top.version;
    app.bytes = Number(top.bytes) || 0;
    app.sha256 = top.sha256 || "";
    if (top.entry) app.entry = top.entry;
    syncAppZipMirror(app);
    app.updatedAt = now();
    await contentAuditPush(a.user, "delete-version", "app", adminAppRow(app), "删版本 v" + want);
    publishStaticApps("管理台删版本 " + app.id + "@" + want);
    return send(res, 200, {
      ok: true,
      id: app.id,
      ownerId: app.userId,
      deleted: false,
      latestVersion: app.latestVersion || "",
      remaining: appVersionRecords(app).length,
      counts: adminContentCounts(),
    });
  }

  // 手动重发静态目录（客户端读的那份 /mtnode/apps/catalog.json）：目录刷坏时的修复按钮。
  if (method === "POST" && p === "/api/admin/content/republish") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const out = publishStaticApps("管理台手动重发（" + (a.user.username || a.user.id) + "）", { force: true });
    const status = staticAppsStatus();
    await contentAuditPush(a.user, "republish", "app", { id: "-", title: "静态目录" }, "手动重发静态目录");
    return send(res, 200, {
      ok: true,
      result: out || null,
      health: {
        ok: !!status.ok,
        dir: status.dir,
        dbApps: status.dbApps,
        diskApps: status.diskApps,
        fallback: !!status.fallback,
        missingOnDisk: status.missingOnDisk || [],
        last: status.last || null,
      },
    });
  }

  // /admin（无尾斜杠）→ /admin/：否则页内相对资源（admin.css / admin.js）会解析到根路径而 404
  if (method === "GET" && url.pathname === "/admin") {
    res.writeHead(302, { Location: "/admin/", "Cache-Control": "no-store" });
    return res.end();
  }

  // 管理平台静态页（本机联调；线上由 nginx 从 /var/www/mtnode/admin/ 直发，网站不设入口）。
  const adminWebR = method === "GET" ? /^\/admin(?:\/(.*))?$/.exec(p) : null;
  if (adminWebR) {
    const rootDir = path.resolve(ADMIN_WEB_DIR);
    const rel = String(adminWebR[1] || "").replace(/^\/+/, "") || "index.html";
    if (rel.includes("\0")) return send(res, 400, { ok: false, error: "非法路径" });
    const fp = path.resolve(rootDir, rel);
    if (fp !== rootDir && !fp.startsWith(rootDir + path.sep)) {
      return send(res, 403, { ok: false, error: "非法路径" });
    }
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      return send(res, 404, { ok: false, error: "not found" });
    }
    return sendBin(res, 200, fs.readFileSync(fp), adminWebMime(fp), { "Cache-Control": "no-store" });
  }

  send(res, 404, { ok: false, error: "not found" });
}

/* ---------- 充值订单过期清扫：每分钟把到期未支付单标 expired，并去支付宝关单 ---------- */
const ORDER_SWEEP_MS = 60 * 1000;
setInterval(async () => {
  let dirty = false;
  try {
    const before = adminSessions().length;
    pruneAdminSessions(now());
    dirty = adminSessions().length !== before;
    const due = wallet.expireDue();
    if (due.length) {
      dirty = true;
      for (const o of due) await closeOrderBestEffort(o);
      console.log("[recharge] 过期清扫：" + due.length + " 单已标记 expired");
    }
    if (dirty) await saveDb();
  } catch (e) {
    console.error("[recharge] 过期清扫失败：" + ((e && e.message) || e));
  }
}, ORDER_SWEEP_MS);

/* ── 启动自愈：清掉盘上存量的「已下架」可见性位（本轮两态收敛的一次性迁移）────────────
 * 本轮起应用只有两态：**在线上 / 完全被删除** —— 旧可见性位（下面这两个字段名）已从库、
 * 接口与界面里整体移除。盘上还可能留着当年下架过的历史条目，它们的记录里带着这一位：
 *   · 字段已经没人读，但不清掉就是一条半态记录（体检 / 留痕里全是噪音）；
 *   · 更实在的一点：这一位是「不进目录」的判据，历史条目会被目录漏掉 ——
 *     线上 sudoku 这类被管理台下架过的条目正是这么消失的，清掉即自然回到目录。
 * 口径：
 *   · 只删这两个字段，别的字段一个不碰；
 *   · 记日志 + 逐条写 contentAudit（谁 / 何时 / 对哪条做了什么，管理台留痕页查得到）；
 *   · **必须在首次 publishStaticApps 之前跑**（见 server.listen 里的调用顺序）：
 *     启动那一发就是把线上目录刷成库里的真实状态，先愈合再发，目录一次就正确。
 * 返回清掉的条数（供日志与回归断言）。 */
const LEGACY_HIDDEN_KEYS = ["unpublished", "unpublishedAt"];

async function appLegacyVisibilityHealOnce() {
  const hit = (db.apps || []).filter((a) => a && LEGACY_HIDDEN_KEYS.some((k) => k in a));
  if (!hit.length) return 0;
  const list = contentAuditList();
  for (const a of hit) {
    for (const k of LEGACY_HIDDEN_KEYS) delete a[k];
    list.unshift({
      id: "ca_" + crypto.randomBytes(6).toString("hex"),
      at: now(),
      userId: "system",
      username: "系统（启动自愈）",
      action: "update",
      kind: "app",
      targetId: String(a.id || ""),
      targetOwnerId: String(a.userId || ""),
      targetTitle: String(a.title || a.id || ""),
      detail: "清掉存量「已下架」可见性位（应用状态已收敛为在线上 / 完全删除两态）",
    });
  }
  if (list.length > CONTENT_AUDIT_MAX) list.length = CONTENT_AUDIT_MAX;
  console.log(
    "[mtnode-store] 启动自愈：清掉存量「已下架」可见性位 " + hit.length + " 条（" +
      hit.map((a) => a.id + "/" + a.userId).join("、") + "）",
  );
  await saveDb();
  return hit.length;
}

const server = http.createServer((req, res) => {
  const _t0 = process.hrtime.bigint();
  const _path = String(req.url || "").split("?")[0];
  res.on("finish", () => {
    try {
      slowNote(req.method || "GET", _path, Number(process.hrtime.bigint() - _t0) / 1e6);
    } catch (_) {}
  });
  handle(req, res).catch((e) => {
    const status = e.status || (String(e.message).includes("too large") ? 413 : 500);
    /* 5xx 一律留一条带栈的日志：以前只回客户端、服务器侧不留痕，线上排查全靠猜。 */
    if (status >= 500) {
      console.error("[mtnode-store] " + (req.method || "GET") + " " + _path + " 失败：" + ((e && e.stack) || e));
    }
    if (!res.headersSent) send(res, status, { ok: false, error: e.message || String(e) });
  });
});

server.listen(PORT, HOST, () => {
  console.log("[mtnode-store] http://" + HOST + ":" + PORT);
  /* 存量自愈必须排在**首次发布之前**（顺序是语义的一部分，见 appLegacyVisibilityHealOnce）：
     它只改内存里的记录（同步完成），紧接着那一发「启动」发布就是正确的线上目录；
     写库 / 写留痕的那一步异步进行，失败只记日志、不拦启动。 */
  appLegacyVisibilityHealOnce().catch((e) => {
    console.error("[mtnode-store] 启动自愈失败（存量可见性位仍留在盘上，下次启动会再试）：" + ((e && e.message) || e));
  });
  // 启动即发一次静态目录：紧接着的每次应用变更也会发（publishStaticApps），
  // 这条只负责「部署后把线上目录刷成库里的真实状态」——正好补上以前要靠人工跑第②步的缺口。
  publishStaticApps("启动");
  const acct = accountStore.describe();
  console.log(
    "[mtnode-store] account store: " +
      acct.backend +
      (acct.backend === "json" ? " (" + acct.dbPath + ")" : " (" + acct.endpoint + ")") +
      " · users=" + db.users.length + " sessions=" + db.sessions.length + " identities=" + db.identities.length,
  );
  const sms = smsProviderStatus();
  console.log(
    "[mtnode-store] sms provider: " +
      sms.id +
      (sms.dev ? "（开发模式：验证码只打日志，生产必须配置 MTNODE_SMS_PROVIDER 与 MTNODE_SMS_* 凭据）" : "") +
      (sms.configured ? "" : " [未配置，缺少 " + (sms.missing || []).join(" / ") + "，短信接口返回 503 SMS_UNAVAILABLE]"),
  );
  const pay = alipayStatus();
  console.log(
    "[mtnode-store] alipay pay: " +
      (pay.configured
        ? "已配置 appid=" + pay.appId + " · 通道=" + (pay.channel === "precreate" ? "当面付（窗内扫码）" : "电脑网站支付（浏览器收银台）") +
          (pay.sandbox ? "（沙箱网关）" : "") + (pay.hasNotifyUrl ? " · notify 已配" : " · notify 未配（只靠轮询/补单）") +
          (pay.channel === "precreate" ? "" : (pay.hasReturnUrl ? " · return 已配" : " · return 未配（付完停在支付宝成功页）"))
        : "[未配置，缺少 " + (pay.missing || []).join(" / ") + "，下单返回 503 ALIPAY_UNAVAILABLE · " +
          "生成密钥：node alipay-keygen.mjs（见 docs/recharge-design.md §凭据）]") +
      (pay.keyError ? " · " + pay.keyError : ""),
  );
  // notify 地址填错（apex 被 301 / 本机地址 / 非 https）＝「支付成功但收不到异步通知」，
  // 只在日志与健康检查里提醒，不拦启动：轮询兜底仍能把单查回来。
  if (pay.notifyWarning) console.warn("[mtnode-store] alipay notify 体检：" + pay.notifyWarning);
  // 网关写错（/router/rest）不会报错，而是所有接口 302 到登录页 —— 启动就把体检结论打出来。
  if (pay.gatewayWarning) console.warn("[mtnode-store] alipay 网关体检：" + pay.gatewayWarning);
  if (pay.returnWarning) console.warn("[mtnode-store] alipay return_url 体检：" + pay.returnWarning);
  console.log(
    "[mtnode-store] recharge: 闸门=" +
      (rechargeGloballyClosed() ? "已全局关闭（MTNODE_RECHARGE_CLOSED）" : "对所有注册账号开放") +
      " · 订单=" + (db.rechargeOrders || []).length + " 流水=" + (db.rechargeLedger || []).length +
      " · 管理会话=" + (db.adminSessions || []).length,
  );
  console.log(
    "[mtnode-store] admin platform: 判据=isAdmin ∪ MTNODE_ADMIN_USERS(" +
      (Array.from(ADMIN_EXTRA_USERS).join(",") || "空") + ") ∪ unionid 白名单(" + ADMIN_WECHAT_UNIONIDS.size +
      " 条) · 微信归属映射 " + WECHAT_OWNER_MAP.size + " 条 · 静态页 " +
      (fs.existsSync(path.join(ADMIN_WEB_DIR, "index.html")) ? ADMIN_WEB_DIR : "（未找到，本机 /admin 返回 404）"),
  );
  console.log(
    "[mtnode-store] apps market: 应用=" + (db.apps || []).length + " · zip=" + APP_DIR +
      " · 图标=" + APP_ICON_DIR +
      "（静态目录 /mtnode/apps/catalog.json 与 GET /api/apps/catalog 同一份字段；" +
      "zipUrl / icon 相对该目录）",
  );
  console.log(
    "[mtnode-store] apps static dir: " + APPS_WEB_DIR +
      "（每次应用变更自动落盘 catalog.json + <id>.zip / <id>/<version>.zip / icons/<id>.<ext>；" +
      "写不进去时客户端回退接口目录 /api/apps/catalog，体检 GET /api/apps/pub）",
  );
  console.log(
    "[mtnode-store] apps versions: " +
      (appVersionsOn()
        ? "开（默认：每版一包 <id>/<version>.zip，最新版镜像 <id>.zip；配额 " +
          fmtBytes(MAX_ACCOUNT_APP_BYTES) + " / " + MAX_ACCOUNT_APPS + " 个应用）"
        : "关（MTNODE_APP_VERSIONS=" + APP_VERSIONS_ENV + "：<id>.zip 一版一份 + PATCH 覆盖；" +
          "去掉该项或设 1 即打开多版本）") +
      " · 声明留痕=" + (db.appDeclarations || []).length + " 条",
  );
  const rd = relay.describe();
  const upText = rd.upstreams.map((u) =>
    u.kind + " 上游 " + u.label + "(" + u.base + ")" +
    (u.configured ? " ✓" + (u.keyFrom ? "[" + u.keyFrom + "]" : "") : " ✗ 缺 Key" + (u.keyEnv ? " / " + u.keyEnv : "")),
  );
  console.log(
    "[mtnode-store] relay 中转站: " +
      upText.join(" · ") +
      " · 模型 " + rd.models.length + " 个[" + rd.models.join(",") + "]" +
      " · 限流 账号 " + rd.quota.accountPerMin + "/分 · 图像 " + rd.quota.imagePerMin + "/分 · IP " + rd.quota.ipPerMin + "/分" +
      " · 计费单位 元（文本 元/百万 token · 图像 元/张）" +
      " · 配置来源 " + rd.configSource + (rd.configSource === "db" ? "（管理台可改，保存即热生效）" : "（默认 + env 缺省）") +
      " · 改动留痕 " + rd.auditRecords + " 条 · 用量明细 " + rd.usageRecords + " 条" +
      " · 热表文件 " + (function () { try { const h = hotStats(); return h ? (h.relayUsage.rows + " 条用量/" + Math.round(h.relayUsage.bytes / 1024) + "KB + " + h.rechargeLedger.rows + " 条流水/" + Math.round(h.rechargeLedger.bytes / 1024) + "KB" + (h.relayUsage.parseErrors || h.rechargeLedger.parseErrors ? "（半截行 " + (h.relayUsage.parseErrors + h.rechargeLedger.parseErrors) + " 已跳过）" : "")) : "-"; } catch (_) { return "-"; } })() +
      (rd.configFile ? " · 兼容配置文件 " + rd.configFile : ""),
  );
  console.log("[mtnode-store] relay 对外 Base URL（下发客户端）: " + RELAY_PUBLIC_BASE);
  if (rd.upstreams.some((u) => !u.configured)) {
    console.warn("[mtnode-store] relay 有上游未配 Key：对应模型的 /relay/v1 调用一律回 503 relay_not_configured（不静默假成功）—— 可在管理台「中转服务」里补齐");
  }
  nginxLimitAudit();
});

/* ── nginx 限位对账自检（本轮新增的防再犯卡口）────────────────────────────────────
 * 为什么需要它：2026-10-09 那次「应用上传卡在上传中」的根因就是**两个数字漂移**——
 * 服务端早已把上架链路的体量上限放宽到 MAX_BODY_APP_UPLOAD(96MB)，线上 nginx 的
 * `/mtnode/store-api/` 却还留着 `client_max_body_size 40m`，于是稍大的包在入口就被掐；
 * 同时 `proxy_read_timeout 120s` 比客户端自己的 600s 短，慢网下必被提前断开。
 * 两边谁都没发现，直到用户报障。所以启动时把 nginx 里那三个数字读出来与服务端常量对账，
 * 不一致就**大声告警**（只读、只记日志，不改任何配置 —— 改 nginx 永远走人工/补丁脚本）。
 * 读不到配置文件（开发态 / 非 root / 自建站没有这个文件）时静默跳过，不打扰本地开发。 */
function nginxLimitAudit() {
  const files = [
    process.env.MTNODE_NGINX_CONF || "",
    "/etc/nginx/sites-available/mt-ai-router.conf",
  ].filter(Boolean);
  let text = "";
  let used = "";
  for (const f of files) {
    try {
      text = fs.readFileSync(f, "utf8");
      used = f;
      break;
    } catch (_) {}
  }
  if (!text) return null;
  const at = text.indexOf("location ^~ /mtnode/store-api/ {");
  if (at < 0) return null;
  /* 只取 store-api 这一段（到下一个 location 或文件末尾），免得把 relay 那段的长超时读进来 */
  const rest = text.slice(at);
  const nextLoc = rest.indexOf("\n    location ", 10);
  const blockText = nextLoc > 0 ? rest.slice(0, nextLoc) : rest;
  const num = (re) => {
    const m = re.exec(blockText);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (!Number.isFinite(v)) return null;
    return /m$/i.test(m[1]) || /m$/i.test(m[0]) ? v * 1024 * 1024 : v;
  };
  const got = {
    bodyCap: num(/client_max_body_size\s+(\d+[km]?)/i),
    readTimeout: num(/proxy_read_timeout\s+(\d+)s?/i),
    sendTimeout: num(/proxy_send_timeout\s+(\d+)s?/i),
  };
  const want = { bodyCap: MAX_BODY_APP_UPLOAD, readTimeout: 600, sendTimeout: 600 };
  const bad = [];
  if (got.bodyCap == null) bad.push("缺 client_max_body_size");
  else if (got.bodyCap < want.bodyCap) bad.push("client_max_body_size=" + Math.round(got.bodyCap / 1024 / 1024) + "m < 服务端 " + Math.round(want.bodyCap / 1024 / 1024) + "m");
  if (got.readTimeout == null) bad.push("缺 proxy_read_timeout");
  else if (got.readTimeout < want.readTimeout) bad.push("proxy_read_timeout=" + got.readTimeout + "s < " + want.readTimeout + "s");
  if (got.sendTimeout == null) bad.push("缺 proxy_send_timeout");
  else if (got.sendTimeout < want.sendTimeout) bad.push("proxy_send_timeout=" + got.sendTimeout + "s < " + want.sendTimeout + "s");
  if (bad.length) {
    console.warn(
      "[mtnode-store][warn] nginx 限位与服务端不一致（" + used + " 的 /mtnode/store-api/）：" + bad.join(" / ") +
        "。后果：稍大的应用包或截图会在 nginx 入口被掐，客户端表现是「上传中卡住」。" +
        "修法：python store-saas/patch-nginx.py && nginx -t && systemctl reload nginx（补丁脚本会就地改这段）",
    );
  } else {
    console.log(
      "[mtnode-store] nginx 限位对账 ✓（" + used + "：client_max_body_size " +
        Math.round(got.bodyCap / 1024 / 1024) + "m · 读写超时 " + got.readTimeout + "s / " + got.sendTimeout + "s）",
    );
  }
  return { file: used, got: got, want: want, ok: !bad.length, problems: bad };
}

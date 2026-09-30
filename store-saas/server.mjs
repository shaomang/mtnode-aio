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
import {
  createWallet,
  makeOrderId,
  validateAmount,
  totalCentsOf,
  yuanOfCents,
  centsOfYuan,
  RECHARGE_TIERS_CENTS,
  RECHARGE_MIN_CENTS,
  RECHARGE_MAX_CENTS,
} from "./wallet.mjs";

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
// 总开关：默认关。关时旧口径逐字不变（<id>.zip 一版一份 + PATCH 覆盖 + apps[].version），
// 打开时每版一包落 <id>/<version>.zip，并把最新版同时刷成 <id>.zip 供老客户端 / 静态目录。
const APP_VERSIONS_ENV = String(process.env.MTNODE_APP_VERSIONS || "").trim().toLowerCase();
// 账号配额（服务端强制，落盘之前校验）：云端已存包总量 = 名下所有应用所有版本 bytes 之和；
// 应用条数上限只算「新建」，给已有应用追加版本不计入。
const MAX_ACCOUNT_APP_BYTES = 50 * 1024 * 1024;
const MAX_ACCOUNT_APPS = 5;
const MAX_VERSION_NOTE = 200;
// 应用 id = 客户端安装目录名（apps-store.js 的 safeAppId 同一口径）：
// 2-64 位字母/数字/._-，统一小写入库；Windows 保留名不可用。
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const WIN_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const SESSION_MS = 30 * 24 * 3600 * 1000;
// 短信频控口径见 docs/auth-design.md 第 8 节（服务端内存态，重启清零）。
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
// 充值白名单：测试期只有名单内账号能下单 / 看钱包（客户端「充值」入口同样只对 ms2308 显示）。
const RECHARGE_USERS = splitSet(process.env.MTNODE_RECHARGE_USERS, "ms2308");
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
    if (!Array.isArray(d.rechargeOrders)) d.rechargeOrders = [];
    if (!Array.isArray(d.rechargeLedger)) d.rechargeLedger = [];
    if (!Array.isArray(d.adminSessions)) d.adminSessions = [];
    if (!Array.isArray(d.relayUsage)) d.relayUsage = [];
    if (!Array.isArray(d.relayAudit)) d.relayAudit = [];
    if (!d.relayConfig || typeof d.relayConfig !== "object") d.relayConfig = null;
    return d;
  } catch {
    return emptyDb();
  }
}

let db = loadDb();
let saving = Promise.resolve();

function saveDb() {
  saving = saving.then(() => {
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_PATH);
  }).catch((e) => {
    console.error("[store] save failed", e);
  });
  return saving;
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

function publicTemplate(t, viewer) {
  const viewerId = viewer && viewer.id;
  const owner = db.users.find((u) => u.id === t.userId);
  return {
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
  };
}

function publicSkill(s, viewer) {
  const viewerId = viewer && viewer.id;
  const owner = db.users.find((u) => u.id === s.userId);
  return {
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
  };
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
  if (sess.expiresAt - t >= SESSION_MS / 2) return;
  const next = t + SESSION_MS;
  sess.expiresAt = next;
  try {
    await accountStore.updateSession({
      tokenHash: sess.tokenHash,
      userId: sess.userId,
      expiresAt: next,
    });
  } catch (e) {
    console.warn("[mtnode-store] session renew failed: " + ((e && e.message) || e));
  }
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

/** 充值白名单（测试期只放 ms2308）：客户端入口同样只对白名单账号显示。 */
function rechargeAllowed(u) {
  return !!u && (RECHARGE_USERS.has(String(u.username || "").toLowerCase()) || isAdmin(u));
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

async function authUser(req, isRelayPath) {
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
  await touchSession(sess, t);
  return db.users.find((u) => u.id === sess.userId) || null;
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

function sendBin(res, status, buf, contentType, extraHeaders) {
  res.writeHead(status, Object.assign({
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
  }, extraHeaders || {}));
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
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
function publicForumTopicSummary(t) {
  return {
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
  };
}

function publicForumTopic(t, viewer) {
  return Object.assign(publicForumTopicSummary(t), {
    content: t.content || "",
    mine: !!(viewer && viewer.id === t.userId),
  });
}

function publicForumReply(r) {
  return {
    id: r.id,
    topicId: r.topicId,
    content: r.content || "",
    imageIds: Array.isArray(r.imageIds) ? r.imageIds : [],
    userId: r.userId,
    author: forumAuthor(r.userId),
    createdAt: r.createdAt,
  };
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

function appIconPath(id) {
  for (const ext of ["png", "jpg", "webp"]) {
    const p = path.join(APP_ICON_DIR, id + "." + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 图标在静态目录里的相对地址（icons/<id>.<ext>）：客户端把它解析到 /mtnode/apps/ 下，
 *  与 zipUrl 的 `<id>.zip` 同一套「相对目录」口径（deploy.sh 会把图标装进该目录）。 */
function appIconRel(id) {
  const p = appIconPath(id);
  return p ? "icons/" + id + "." + path.extname(p).slice(1).toLowerCase() : "";
}

function writeAppIcon(id, icon) {
  clearAppIcon(id);
  fs.writeFileSync(path.join(APP_ICON_DIR, id + "." + icon.ext), icon.buf);
}

function clearAppIcon(id) {
  for (const ext of ["png", "jpg", "webp"]) {
    try { fs.unlinkSync(path.join(APP_ICON_DIR, id + "." + ext)); } catch {}
  }
}

/* ---------- 上架与多版本：开关 / 路径 / 版本记录 / 配额 / 声明（契约 §七） ---------- */

/**
 * 多版本总开关（`MTNODE_APP_VERSIONS=1|true|yes|on` 打开，默认关）。
 * 判据集中在这里：路由与目录口径都只问它，别在别处再读一次环境变量。
 */
function appVersionsOn() {
  return (
    APP_VERSIONS_ENV === "1" ||
    APP_VERSIONS_ENV === "true" ||
    APP_VERSIONS_ENV === "yes" ||
    APP_VERSIONS_ENV === "on"
  );
}

/** 多版本包目录 `<APP_DIR>/<id>`（开关打开时一版一包；关时不用）。 */
function appVersionDir(id) {
  return path.join(APP_DIR, id);
}

/** 单版包路径 `<APP_DIR>/<id>.zip`：老口径的唯一落点，也是多版本模式下「最新版」的镜像。 */
function appZipPath(id) {
  return path.join(APP_DIR, id + ".zip");
}

/** 某一版的包路径。版本号已过 normalizeVersion（无 `/` 与 `..`），拼路径是安全的。 */
function appVersionZipPath(id, version) {
  return path.join(appVersionDir(id), version + ".zip");
}

/**
 * 落盘：开关打开时写 `<id>/<version>.zip`，**并且**把这一版同时刷成 `<id>.zip` 镜像，
 * 让老客户端与静态目录（`zipUrl = <id>.zip`）的口径一个字都不用改；关时只写镜像。
 */
function writeAppZipFiles(id, version, buf) {
  if (appVersionsOn() && version) {
    mkdirp(appVersionDir(id));
    fs.writeFileSync(appVersionZipPath(id, version), buf);
  }
  fs.writeFileSync(appZipPath(id), buf);
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

/** 一条应用占用的云端字节：多版本 = 各版之和，老记录 = 单包 bytes。 */
function appStoredBytes(a) {
  const vs = appVersionRecords(a);
  if (!vs.length) return Number(a && a.bytes) || 0;
  return vs.reduce((n, v) => n + (Number(v && v.bytes) || 0), 0);
}

/** 名下所有应用的云端已存包总量（配额口径 = 所有版本 bytes 之和）。 */
function accountAppBytes(userId) {
  return (db.apps || [])
    .filter((a) => a.userId === userId)
    .reduce((n, a) => n + appStoredBytes(a), 0);
}

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

function fmtBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + "KB";
  return (v / 1024 / 1024).toFixed(2) + "MB";
}

/**
 * 账号配额（服务端强制，**全部校验通过之后、落盘之前**调用；契约 §7.5）：
 *   · 云端已存包总量（名下所有应用所有版本 bytes 之和）≤ MAX_ACCOUNT_APP_BYTES
 *   · 名下应用条数 ≤ MAX_ACCOUNT_APPS（给已有应用追加版本不计入）
 * addBytes = 本次新增的包字节；replaceBytes = 本次会被覆盖掉的旧包字节（追加版本传 0）；
 * newApp = 是否新建一条应用记录。返回 null 表示通过，否则返回要发的 {status, body}。
 */
function appQuotaError(userId, addBytes, replaceBytes, newApp) {
  const add = Math.max(0, Math.round(Number(addBytes) || 0));
  const replace = Math.max(0, Math.round(Number(replaceBytes) || 0));
  if (newApp) {
    const used = (db.apps || []).filter((a) => a.userId === userId).length;
    if (used >= MAX_ACCOUNT_APPS) {
      return {
        status: 413,
        body: {
          ok: false,
          code: "QUOTA_APPS",
          used: used,
          limit: MAX_ACCOUNT_APPS,
          error:
            "应用数量已达上限：" + used + " / " + MAX_ACCOUNT_APPS +
            " 个。请先删除不再上架的应用（给已有应用追加版本不计入上限）。",
        },
      };
    }
  }
  const used = accountAppBytes(userId);
  if (used - replace + add > MAX_ACCOUNT_APP_BYTES) {
    return {
      status: 413,
      body: {
        ok: false,
        code: "QUOTA_BYTES",
        used: used,
        limit: MAX_ACCOUNT_APP_BYTES,
        error:
          "云端应用包配额已满：已用 " + fmtBytes(used) + " / 上限 " + fmtBytes(MAX_ACCOUNT_APP_BYTES) +
          "（本次还需 " + fmtBytes(add) + "）。请先删除旧版本或旧应用再上传。",
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
  const owner = db.users.find((u) => u.id === a.userId);
  const fallbackUploader = owner ? owner.username || owner.id : a.userId;
  const recs = appVersionRecords(a);
  if (!recs.length) {
    if (appHasVersionField(a)) return [];
    return [
      {
        version: a.version || "1.0.0",
        zipUrl: a.id + ".zip",
        sha256: a.sha256 || "",
        bytes: Number(a.bytes) || 0,
        parentVersion: "",
        uploader: fallbackUploader,
        createdAt: a.createdAt,
        note: "",
      },
    ];
  }
  return recs.map((v) => ({
    version: v.version,
    zipUrl: a.id + "/" + v.version + ".zip",
    sha256: v.sha256 || "",
    bytes: Number(v.bytes) || 0,
    parentVersion: v.parentVersion || "",
    uploader: v.uploader || fallbackUploader,
    createdAt: v.createdAt,
    note: v.note || "",
    entry: v.entry || appEntryOf(a),
  }));
}

/** `GET /api/apps/:id/versions` 的版本项（契约 §7.4）：含 `current` = 是不是最新版。 */
function appVersionsPublic(a) {
  const owner = db.users.find((u) => u.id === a.userId);
  const fallbackUploader = owner ? owner.username || owner.id : a.userId;
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
    createdAt: v.createdAt,
    note: v.note || "",
    current: v.version === latest,
  }));
}

/**
 * 定位要下发的包：多版本模式命中版本记录时取 `<id>/<version>.zip`（缺省最新版），
 * 其余情况退回 `<id>.zip` 镜像（关开关的老口径 / 老单版记录）。
 * wantVersion 为空 = 最新版；指定的版本拿不到「那一版自己的包」时返回 null（调用方回 404）——
 * 绝不拿别的版本充数，否则会静默下错版本。
 */
function locateAppZip(a, wantVersion) {
  const want = String(wantVersion == null ? "" : wantVersion).trim();
  const recs = appVersionRecords(a);
  const target = want || appLatestVersion(a);
  const rec = recs.find((v) => v.version === target) || null;
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

/** 把 `<id>.zip` 镜像刷成当前最新版（删版本后调用）；没有剩余版本就删掉镜像。 */
function syncAppZipMirror(a) {
  const recs = appVersionRecords(a);
  if (!recs.length) {
    try { fs.unlinkSync(appZipPath(a.id)); } catch {}
    return;
  }
  const rec = recs.find((v) => v.version === appLatestVersion(a)) || null;
  if (!rec) return;
  const src = appVersionZipPath(a.id, rec.version);
  if (!fs.existsSync(src)) return;
  fs.copyFileSync(src, appZipPath(a.id));
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
 * 二次开发来源（fork，契约 §八）：应用身份 = **应用 id + 作者 uid**。
 * 同一应用被不同作者二次开发后各自上架成**不同 id** 的条目（id 全局唯一不变），条目上用
 * forkOf = { id, ownerId } 指回源应用（id = 源应用 id，ownerId = 源作者 uid，uid 为准；
 * owner = 源作者 username，只为显示）。
 *
 * 写入口径（服务端唯一实现）：
 *   · 只认 { id, ownerId } 两个字段，id 走 normalizeAppId、ownerId 非空；
 *   · **不校验源条目是否还在**：作者删了自己的应用不该让别人后续版本永远传不上去 ——
 *     客户端在源不可见时显示「分支来源已不可见」即可；
 *   · 自指（id 与被上传的同一个应用）一律当没声明 —— 那没有意义，只会在目录里绕圈。
 */
function normalizeForkOf(raw, selfId) {
  if (!raw || typeof raw !== "object") return null;
  const id = normalizeAppId(raw.id);
  const ownerId = String(raw.ownerId || "").trim().slice(0, 64);
  if (!id || !ownerId) return null;
  if (selfId && id === selfId) return null;
  return { id, ownerId };
}
/** 对外形态（目录条目 / 接口条目共用）：补上源作者的 username 供界面显示。 */
function appForkOfPublic(a) {
  const f = a && a.forkOf;
  if (!f || typeof f !== "object") return null;
  const id = String(f.id || "").trim().toLowerCase();
  const ownerId = String(f.ownerId || "").trim();
  if (!id || !ownerId) return null;
  const u = db.users.find((x) => x.id === ownerId);
  return { id, ownerId, owner: u ? String(u.username || "") : "" };
}
function appCatalogEntry(a) {
  const owner = db.users.find((u) => u.id === a.userId);
  const zipUrl = a.id + ".zip";
  return {
    id: a.id,
    title: a.title,
    version: a.version || "1.0.0",
    // 多版本字段（契约 §7.6）：**始终**给 latestVersion / versions[]，
    // 开关关闭时 versions[] 是单版合成项（zipUrl 仍为 <id>.zip），客户端只有一条读路径。
    latestVersion: appLatestVersion(a),
    versions: appCatalogVersions(a),
    desc: a.description || "",
    description: a.description || "",
    icon: appIconRel(a.id) || String(a.icon || ""),
    zipUrl: zipUrl,
    url: zipUrl,
    sha256: a.sha256 || "",
    owner: owner ? (owner.username || owner.id) : a.userId,
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
function publicApp(a, viewer) {
  const viewerId = viewer && viewer.id;
  const owner = db.users.find((u) => u.id === a.userId);
  return Object.assign({}, appCatalogEntry(a), {
    ownerUser: owner
      ? { id: owner.id, username: owner.username, nickname: owner.nickname }
      : { id: a.userId, username: "", nickname: "" },
    hasIcon: !!appIconPath(a.id),
    mine: !!(viewerId && viewerId === a.userId),
    canDelete: !!(viewerId && (viewerId === a.userId || isAdmin(viewer))),
    // 下架状态只在详情 / 自己列表里露面（公开目录根本不列出这类条目）。
    unpublished: !!a.unpublished,
    unpublishedAt: Number(a.unpublishedAt) || 0,
  });
}

/** 静态目录文档：把这份 JSON 原样写到 /var/www/mtnode/apps/catalog.json 即是线上目录。 */
function appCatalogDoc() {
  const apps = (db.apps || [])
    .filter((a) => !a.unpublished) // 已下架的应用不进目录（契约 §7.6）
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(appCatalogEntry);
  return {
    version: 1,
    updatedAt: new Date(now()).toISOString(),
    feed: "http://mt-agent.com/mtnode/apps",
    apps: apps,
  };
}

/* ---------- 静态目录发布（单一真源：接口变更 → 立即落盘） ---------- *
 * 客户端（apps-store.js）读的是**静态文件** <MTNODE_APPS_URL>/catalog.json，
 * 而接口（POST / PATCH / 版本 / 下架 / 删除）只改 db.json 与 DATA_DIR。
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
  const doc = appCatalogDoc();
  const entries = [];
  const managed = [APPS_WEB_MANIFEST, "catalog.json"];
  const missing = [];
  for (const e of doc.apps) {
    const a = (db.apps || []).find((x) => x.id === e.id);
    if (!a) continue;
    // 最新版镜像：老客户端 / 单版布局只认 <id>.zip
    const mirror = appZipPath(a.id);
    if (fs.existsSync(mirror)) {
      entries.push({ id: a.id, rel: a.id + ".zip", src: mirror, bytes: fs.statSync(mirror).size });
      managed.push(a.id + ".zip");
    }
    // 多版本：每一版 <id>/<version>.zip（catalog 的 versions[].zipUrl 就是它）
    for (const v of appVersionRecords(a)) {
      const rel = a.id + "/" + v.version + ".zip";
      const src = appVersionZipPath(a.id, v.version);
      if (fs.existsSync(src)) {
        entries.push({ id: a.id, rel: rel, src: src, bytes: fs.statSync(src).size });
        managed.push(rel);
      } else {
        missing.push({ id: a.id, reason: "缺少版本包 " + rel });
      }
    }
    // 图标：相对静态目录 icons/<id>.<ext>（appCatalogEntry().icon 的写法）
    const iconPath = appIconPath(a.id);
    if (iconPath) {
      const rel = "icons/" + a.id + "." + path.extname(iconPath).slice(1).toLowerCase();
      entries.push({ id: a.id, rel: rel, src: iconPath, bytes: fs.statSync(iconPath).size });
      managed.push(rel);
    }
    if (appHasVersionField(a) && !appVersionRecords(a).length) {
      missing.push({ id: a.id, reason: "版本被删光，当前没有可分发的包" });
    }
  }
  return { doc: doc, entries: entries, managed: managed, missing: missing };
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
  const plan = appStaticPlan();
  mkdirp(APPS_WEB_DIR);
  mkdirp(path.join(APPS_WEB_DIR, APPS_WEB_ICONS_DIR));
  for (const e of plan.entries) {
    if (!e.rel.endsWith(".zip") || e.rel.indexOf("/") < 0) continue;
    mkdirp(path.join(APPS_WEB_DIR, e.id));
  }
  // 1) 内容先落齐：包 / 图标
  const errors = [];
  for (const e of plan.entries) {
    const dst = path.join(APPS_WEB_DIR, ...e.rel.split("/"));
    try {
      writeFileAtomicSync(dst, fs.readFileSync(e.src));
    } catch (err) {
      errors.push(e.rel + "：" + ((err && err.message) || String(err)));
    }
  }
  // 2) 目录清单最后写：清单里出现的条目，包与图标都已经在盘上
  try {
    writeFileAtomicSync(path.join(APPS_WEB_DIR, "catalog.json"), JSON.stringify(plan.doc, null, 2) + "\n");
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
  const ok = errors.length === 0;
  return {
    ok: ok,
    dir: APPS_WEB_DIR,
    apps: plan.doc.apps.length,
    files: plan.managed.length,
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
function publishStaticApps(reason) {
  if (staticPublishBusy) {
    // 前一次还没写完（同一进程内的连续变更）：这次跳过，前一次写的是**这次之前**的库，
    // 可能漏掉最新一条 —— 标记 pending，写完再看一次。
    staticPublishPending = true;
    return { ok: false, skipped: true, reason: reason };
  }
  staticPublishBusy = true;
  let out;
  try {
    out = writeStaticApps();
  } catch (err) {
    out = { ok: false, dir: APPS_WEB_DIR, apps: 0, files: 0, errors: ["发布抛出异常：" + ((err && err.message) || String(err))], missing: [], removed: [] };
  }
  staticPublishBusy = false;
  staticPublishLast = Object.assign({ reason: reason }, out);
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
function staticAppsStatus() {
  const plan = appStaticPlan();
  const checks = [];
  for (const rel of plan.managed) {
    if (rel === APPS_WEB_MANIFEST) continue;
    const p = path.join(APPS_WEB_DIR, ...rel.split("/"));
    checks.push({ rel: rel, exists: fs.existsSync(p), bytes: fs.existsSync(p) ? fs.statSync(p).size : 0 });
  }
  let diskApps = -1;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(APPS_WEB_DIR, "catalog.json"), "utf8"));
    diskApps = Array.isArray(d.apps) ? d.apps.length : -1;
  } catch {}
  return {
    ok: !checks.some((c) => !c.exists) && diskApps === plan.doc.apps.length,
    dir: APPS_WEB_DIR,
    dbApps: plan.doc.apps.length,
    diskApps: diskApps,
    fallback: staticPublishFallback,
    last: staticPublishLast,
    missingOnDisk: checks.filter((c) => !c.exists).map((c) => c.rel),
    checks: checks,
  };
}

/** 更新时版本 +1：x.y.z → x.y.(z+1)；其它形态退回「追加 .1」再走 normalizeVersion 校验。 */
function bumpAppVersion(v) {
  const s = String(v || "").trim() || "1.0.0";
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? m[1] + "." + m[2] + "." + (Number(m[3]) + 1) : s + ".1";
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
  const user = await authUser(req, p === "/relay/v1" || p.startsWith("/relay/v1/"));

  // 中转站：/relay/v1/* 全权交给 relay.mjs（它自己读请求体 —— multipart 要原包转发）。
  // 鉴权沿用它上面的账号 token（同一套 Bearer 会话），不另立一套 Key。
  if (p === "/relay/v1" || p.startsWith("/relay/v1/")) {
    return relay.handle({ req, res, p, method, user, url, clientIp: clientIp(req) });
  }

  const jsonBody = async () => {
    const raw = await readBody(req);
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
        payConfigured: pay.configured,
        payMissing: pay.configured ? [] : pay.missing,
        notifyConfigured: pay.hasNotifyUrl,
        adminWeb: fs.existsSync(path.join(ADMIN_WEB_DIR, "index.html")),
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
      await accountStore.deleteSession(th);
      db.sessions = db.sessions.filter((s) => s.tokenHash !== th);
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
      reason: models.length ? "" : "账号在中转站的可用余额为 0：充值后即可使用",
      updatedAt: Date.now(),
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
    const items = db.templates
      .filter((t) => t.userId === user.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => publicTemplate(t, user));
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
    else list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const items = list.slice((page - 1) * pageSize, page * pageSize).map((t) => publicTemplate(t, user));
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
    const items = db.skills
      .filter((t) => t.userId === user.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => publicSkill(t, user));
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
    } else list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const items = list.slice((page - 1) * pageSize, page * pageSize).map((t) => publicSkill(t, user));
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
    // 已下架的应用不进公开列表；只有「按 owner 查自己 + includeUnpublished=1」才看得到（契约 §7.6）。
    const includeUnpublished = /^(1|true|yes|on)$/i.test(
      String(url.searchParams.get("includeUnpublished") || "").trim(),
    );
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));
    let list = (db.apps || []).slice();
    if (!(owner && includeUnpublished)) list = list.filter((a) => !a.unpublished);
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
        return [e.id, e.title, e.desc, e.owner, (e.tags || []).join(" ")]
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
    const items = list.slice((page - 1) * pageSize, page * pageSize).map((a) => publicApp(a, user));
    return send(res, 200, { ok: true, items, total, page, pageSize });
  }

  // 静态目录口径（与手写清单 store-saas/apps/catalog.json 同一份字段）：
  // 把它原样落成 /var/www/mtnode/apps/catalog.json，即为客户端读的那个线上目录。
  // 静态目录写不进去时（缺权限 / 路径不存在，见 publishStaticApps 的告警），
  // 客户端会回退到这里 —— 所以本接口必须始终可用，返回的就是同一份 appCatalogDoc()。
  if (method === "GET" && (p === "/api/apps/catalog" || p === "/api/apps/catalog.json")) {
    return send(res, 200, appCatalogDoc());
  }

  // 静态目录体检（免登录、只读）：给上线自检与排查用 —— 条数对不对、文件在不在、有没有降级。
  if (method === "GET" && p === "/api/apps/pub") {
    return send(res, 200, Object.assign({ ok: true }, staticAppsStatus()));
  }

  const appOne = /^\/api\/apps\/([^/]+)$/.exec(p);
  const appFileR = /^\/api\/apps\/([^/]+)\/file$/.exec(p);
  const appIconR = /^\/api\/apps\/([^/]+)\/icon$/.exec(p);
  const appVersionsR = /^\/api\/apps\/([^/]+)\/versions$/.exec(p);
  const appVersionOneR = /^\/api\/apps\/([^/]+)\/versions\/([^/]+)$/.exec(p);
  const appPublishR = /^\/api\/apps\/([^/]+)\/(unpublish|publish)$/.exec(p);

  // 版本树数据（免登录，公开信息）：客户端详情区的「版本」块按它渲染。
  // 开关关闭时也用单版字段合成一项，客户端只有一条读路径。
  if (appVersionsR && method === "GET") {
    const a = (db.apps || []).find((x) => x.id === appVersionsR[1]);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    return send(res, 200, {
      ok: true,
      id: a.id,
      latestVersion: appLatestVersion(a),
      unpublished: !!a.unpublished,
      versions: appVersionsPublic(a),
    });
  }

  // 追加版本（仅 owner，必须 acceptDeclaration）：一版一包落 <id>/<version>.zip，
  // 同时把最新版刷成 <id>.zip 镜像（老客户端 / 静态目录口径不变）。
  if (appVersionsR && method === "POST") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "追加版本需要登录" });
    const a = (db.apps || []).find((x) => x.id === appVersionsR[1]);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    if (a.userId !== user.id) return send(res, 403, { ok: false, error: "只能给自己的应用追加版本" });
    if (!appVersionsOn()) {
      // 单版模式下追加版本无处安放（<id>.zip 只有一份）：明确报错，不静默覆盖旧包。
      return send(res, 409, {
        ok: false,
        code: "APP_VERSIONS_DISABLED",
        error:
          "服务端未启用应用多版本（需设环境变量 MTNODE_APP_VERSIONS=1）；单版模式请用 PATCH /api/apps/" +
          a.id + " 覆盖更新",
      });
    }
    const b = await jsonBody();
    // 声明（契约 §7.3）：没勾选就不落任何盘。
    if (b.acceptDeclaration !== true) return declarationRequired(res);
    requireFields(b, ["version"]);
    let version;
    try {
      version = normalizeVersion(b.version, a.latestVersion || a.version || "1.0.0");
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
    if (appVersionRecords(a).some((v) => v.version === version)) {
      return send(res, 409, {
        ok: false,
        code: "VERSION_EXISTS",
        error:
          "该版本号已存在（v" + version + "）：请换一个版本号，或先用 DELETE /api/apps/" + a.id +
          "/versions/" + version + " 把旧的那一版下掉",
      });
    }
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
    // 配额：全部校验通过之后、落盘之前（契约 §7.5）。
    const q = appQuotaError(user.id, buf.length, 0, false);
    if (q) return send(res, q.status, q.body);

    writeAppZipFiles(a.id, version, buf);
    if (clearIcon) clearAppIcon(a.id);
    else if (iconBuf) writeAppIcon(a.id, iconBuf);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    a.versions = appVersionRecords(a).concat([
      makeAppVersion({
        version,
        parentVersion,
        buf,
        sha256: sha,
        entry,
        note: b.versionNote != null ? b.versionNote : b.note,
        user,
      }),
    ]);
    a.latestVersion = version;
    a.version = version; // 老字段 = 最新版版本号（语义不变）
    a.bytes = buf.length;
    a.sha256 = sha;
    a.entry = entry;
    if (nextTitle != null) a.title = nextTitle;
    if (nextDesc != null) a.description = nextDesc;
    if (nextTags != null) a.tags = nextTags;
    /* 二次开发来源：本次带了这个键就按它改（null / 空对象 = 清掉声明，回到原创）；
       没带键 = 保持原样（追加一版不该悄悄抹掉上一版声明的来源）。 */
    if (b.forkOf !== undefined) {
      const fo = normalizeForkOf(b.forkOf, a.id);
      if (fo) a.forkOf = fo;
      else delete a.forkOf;
    }
    a.updatedAt = now();
    recordAppDeclaration(req, user, a.id, version, "version");
    await saveDb();
    publishStaticApps("追加版本 " + a.id + "@" + version);
    return send(res, 200, { ok: true, version, item: publicApp(a, user), catalog: appCatalogEntry(a) });
  }

  // 删某一版（仅 owner）：包与版本记录一起下掉（不留灰行），配额当场释放。
  if (appVersionOneR && method === "DELETE") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "删除版本需要登录" });
    const a = (db.apps || []).find((x) => x.id === appVersionOneR[1]);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    if (a.userId !== user.id) return send(res, 403, { ok: false, error: "只能删除自己应用的版本" });
    if (!appVersionsOn()) {
      return send(res, 409, {
        ok: false,
        code: "APP_VERSIONS_DISABLED",
        error: "服务端未启用应用多版本（需设环境变量 MTNODE_APP_VERSIONS=1）：单版模式没有可分删的版本记录",
      });
    }
    let want = appVersionOneR[2];
    try { want = decodeURIComponent(want); } catch {}
    const recs = appVersionRecords(a).slice();
    const vi = recs.findIndex((v) => v.version === want);
    if (vi < 0) {
      return send(res, 404, { ok: false, code: "VERSION_NOT_FOUND", error: "该版本不存在或已下架：v" + want });
    }
    recs.splice(vi, 1);
    a.versions = recs;
    try { fs.unlinkSync(appVersionZipPath(a.id, want)); } catch {}
    if (!recs.length) {
      // 全删光：应用没有可分发的包了 → 随之下架，镜像也删掉（记录仍在，可重新上架新版本）。
      a.latestVersion = "";
      a.unpublished = true;
      a.unpublishedAt = now();
      a.bytes = 0;
      a.sha256 = "";
      try { fs.unlinkSync(appZipPath(a.id)); } catch {}
    } else {
      // 删的是最新版 → latestVersion 指向剩余最高版，并把镜像刷成它。
      const top = recs.reduce((best, v) => (compareVersions(v.version, best.version) > 0 ? v : best), recs[0]);
      a.latestVersion = top.version;
      a.version = top.version;
      a.bytes = Number(top.bytes) || 0;
      a.sha256 = top.sha256 || "";
      if (top.entry) a.entry = top.entry;
      syncAppZipMirror(a);
    }
    a.updatedAt = now();
    await saveDb();
    publishStaticApps("删版本 " + a.id + "@" + want);
    return send(res, 200, { ok: true, id: a.id, latestVersion: a.latestVersion || "", versions: appVersionsPublic(a) });
  }

  // 下架 / 重新发布（仅 owner）：记录与所有版本的包都保留，只改目录可见性。
  if (appPublishR && method === "POST") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "下架 / 重新发布需要登录" });
    const a = (db.apps || []).find((x) => x.id === appPublishR[1]);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    if (a.userId !== user.id) return send(res, 403, { ok: false, error: "只能下架 / 重新发布自己的应用" });
    const unpublish = appPublishR[2] === "unpublish";
    a.unpublished = unpublish;
    a.unpublishedAt = unpublish ? now() : 0;
    await saveDb();
    publishStaticApps((unpublish ? "下架 " : "重新发布 ") + a.id);
    return send(res, 200, { ok: true, id: a.id, unpublished: !!a.unpublished, item: publicApp(a, user) });
  }

  if (appFileR && method === "GET") {
    const a = (db.apps || []).find((x) => x.id === appFileR[1]);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    // 多版本：?version=x.y.z 回指定版本、缺省回 latestVersion；关开关时该参数一律忽略（旧口径不变）。
    const wantVersion = appVersionsOn() ? String(url.searchParams.get("version") || "").trim() : "";
    const loc = locateAppZip(a, wantVersion);
    if (!loc) {
      return send(res, 404, {
        ok: false,
        code: wantVersion ? "VERSION_NOT_FOUND" : "FILE_MISSING",
        error: wantVersion ? "该版本不存在或已下架：v" + wantVersion : "文件缺失",
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
        "Content-Disposition": 'attachment; filename="' + a.id + '.zip"',
      });
    }
    return send(res, 200, {
      ok: true,
      id: a.id,
      title: a.title,
      version: loc.version,
      entry: loc.entry,
      bytes: buf.length,
      sha256: sha,
      zipUrl: loc.fromVersionDir ? a.id + "/" + loc.version + ".zip" : a.id + ".zip",
      base64: buf.toString("base64"),
    });
  }

  if (appIconR && method === "GET") {
    const a = (db.apps || []).find((x) => x.id === appIconR[1]);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    const fp = appIconPath(a.id);
    if (!fp) return send(res, 404, { ok: false, error: "无图标" });
    return sendBin(res, 200, fs.readFileSync(fp), previewMime(fp), { "Cache-Control": "public, max-age=3600" });
  }

  if (appOne && method === "GET") {
    const a = (db.apps || []).find((x) => x.id === appOne[1]);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
    return send(res, 200, { ok: true, item: publicApp(a, user) });
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
    if ((db.apps || []).some((x) => x.id === id)) {
      return send(res, 409, {
        ok: false,
        code: "APP_EXISTS",
        error: "该应用 id 已存在；更新请用 PATCH /api/apps/" + id + "（仅 id 的所有者可改）",
      });
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
    // 配额：全部校验通过之后、落盘之前（契约 §7.5；超限时磁盘与内存都不留半成品）。
    const quota = appQuotaError(user.id, buf.length, 0, true);
    if (quota) return send(res, quota.status, quota.body);

    // 二次开发来源（可选，契约 §八）：声明了就记，没声明 = 原创
    const forkOf = normalizeForkOf(b.forkOf, id);

    // 开关打开时一版一包 + 最新版镜像；关闭时只写 <id>.zip（旧口径逐字不变）。
    writeAppZipFiles(id, version, buf);
    if (icon) writeAppIcon(id, icon);
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
      downloads: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    if (forkOf) a.forkOf = forkOf;
    if (appVersionsOn()) {
      // 契约 §7.2：开关打开时才写 versions / latestVersion / unpublished（+ 下架时间）。
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
      a.unpublished = false;
      a.unpublishedAt = 0;
    }
    db.apps.push(a);
    recordAppDeclaration(req, user, id, version, "create");
    await saveDb();
    publishStaticApps("新建应用 " + id + "@" + version);
    return send(res, 200, { ok: true, item: publicApp(a, user), catalog: appCatalogEntry(a) });
  }

  // 更新：仅 owner 可改；覆盖文件（zip / 图标）并让版本 +1（显式传 version 时以传入为准）。
  if (appOne && method === "PATCH") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const a = (db.apps || []).find((x) => x.id === appOne[1]);
    if (!a) return send(res, 404, { ok: false, error: "应用不存在" });
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
      const fp = appZipPath(a.id);
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
    if (appendVersion && appVersionRecords(a).some((v) => v.version === nextVersion)) {
      return send(res, 409, {
        ok: false,
        code: "VERSION_EXISTS",
        error:
          "该版本号已存在（v" + nextVersion + "）：不传 version 时服务端按 +1 递增，或显式传一个新版本号",
      });
    }
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
    // 配额：追加版本是净增（镜像不算第二份），覆盖旧包则先释放被覆盖的那一份（契约 §7.5）。
    if (zipBuf) {
      const quota = appQuotaError(user.id, zipBuf.length, appendVersion ? 0 : Number(a.bytes) || 0, false);
      if (quota) return send(res, quota.status, quota.body);
    }

    const zipSha = zipBuf ? crypto.createHash("sha256").update(zipBuf).digest("hex") : "";
    let appendRec = null;
    if (zipBuf) {
      if (appendVersion) {
        writeAppZipFiles(a.id, nextVersion, zipBuf);
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
        fs.writeFileSync(appZipPath(a.id), zipBuf);
      }
      a.bytes = zipBuf.length;
      a.sha256 = zipSha;
    }
    if (appendRec) {
      a.versions = appVersionRecords(a).concat([appendRec]);
      a.latestVersion = nextVersion;
    }
    if (clearIcon) clearAppIcon(a.id);
    else if (iconBuf) writeAppIcon(a.id, iconBuf);

    if (nextTitle != null) a.title = nextTitle;
    if (nextDesc != null) a.description = nextDesc;
    if (nextTags != null) a.tags = nextTags;
    if (nextIcon != null) a.icon = nextIcon;
    if (nextEntry != null) a.entry = nextEntry;
    /* 二次开发来源（契约 §八）：带了这个键才动它（null = 清回原创），不带就保持原样 */
    if (b.forkOf !== undefined) {
      const fo = normalizeForkOf(b.forkOf, a.id);
      if (fo) a.forkOf = fo;
      else delete a.forkOf;
    }
    a.version = nextVersion;
    a.updatedAt = now();
    recordAppDeclaration(req, user, a.id, nextVersion, appendRec ? "version" : "update");
    await saveDb();
    publishStaticApps((appendRec ? "追加版本 " : "更新应用 ") + a.id + "@" + nextVersion);
    return send(res, 200, {
      ok: true,
      bumped,
      item: publicApp(a, user),
      catalog: appCatalogEntry(a),
    });
  }

  if (appOne && method === "DELETE") {
    if (!user) return send(res, 401, { ok: false, code: "UNAUTHORIZED", error: "未登录" });
    const idx = (db.apps || []).findIndex((x) => x.id === appOne[1]);
    if (idx < 0) return send(res, 404, { ok: false, error: "应用不存在" });
    const a = db.apps[idx];
    if (a.userId !== user.id && !isAdmin(user)) {
      return send(res, 403, { ok: false, error: "只能删除自己的应用" });
    }
    const owner = db.users.find((u) => u.id === a.userId) || user;
    await applyUserPatch(owner.id, {
      downloadsReceived: Math.max(0, (owner.downloadsReceived || 0) - (a.downloads || 0)),
    });
    db.apps.splice(idx, 1);
    try { fs.unlinkSync(appZipPath(a.id)); } catch {}
    // 多版本：整条应用删掉时把它那一整个版本目录也带走（不留孤儿包）。
    try { fs.rmSync(appVersionDir(a.id), { recursive: true, force: true }); } catch {}
    clearAppIcon(a.id);
    await saveDb();
    publishStaticApps("删除应用 " + a.id);
    return send(res, 200, { ok: true });
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
    const items = list.slice(skip, skip + pageSize).map(publicForumTopicSummary);
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
      tiersYuan: RECHARGE_TIERS_CENTS.map(yuanOfCents),
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
      stats: wallet.stats(),
      alipay: alipayStatus(),
      wechat: { configured: wechatConfigured(), ownerMapEntries: WECHAT_OWNER_MAP.size },
      config: {
        tiersYuan: RECHARGE_TIERS_CENTS.map(yuanOfCents),
        minYuan: yuanOfCents(RECHARGE_MIN_CENTS),
        maxYuan: yuanOfCents(RECHARGE_MAX_CENTS),
        rechargeUsers: Array.from(RECHARGE_USERS),
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
      })),
    });
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

  // CSV 导出（UTF-8 BOM，Excel 双击不乱码）。
  if (method === "GET" && p === "/api/admin/export.csv") {
    const a = requireAdmin(req, res);
    if (!a) return;
    const kind = String(url.searchParams.get("kind") || "orders") === "ledger" ? "ledger" : "orders";
    const buf = Buffer.from(wallet.csv(kind), "utf8");
    const name = "mtnode-" + kind + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    return sendBin(res, 200, buf, "text/csv; charset=utf-8", {
      "Content-Disposition": 'attachment; filename="' + name + '"',
      "Cache-Control": "no-store",
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

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e.status || (String(e.message).includes("too large") ? 413 : 500);
    if (!res.headersSent) send(res, status, { ok: false, error: e.message || String(e) });
  });
});

server.listen(PORT, HOST, () => {
  console.log("[mtnode-store] http://" + HOST + ":" + PORT);
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
    "[mtnode-store] recharge: 白名单=" + (Array.from(RECHARGE_USERS).join(",") || "（空）") +
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
        ? "开（每版一包 <id>/<version>.zip，最新版镜像 <id>.zip；配额 " +
          fmtBytes(MAX_ACCOUNT_APP_BYTES) + " / " + MAX_ACCOUNT_APPS + " 个应用）"
        : "关（默认：<id>.zip 一版一份 + PATCH 覆盖；设 MTNODE_APP_VERSIONS=1 打开多版本）") +
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
      (rd.configFile ? " · 兼容配置文件 " + rd.configFile : ""),
  );
  console.log("[mtnode-store] relay 对外 Base URL（下发客户端）: " + RELAY_PUBLIC_BASE);
  if (rd.upstreams.some((u) => !u.configured)) {
    console.warn("[mtnode-store] relay 有上游未配 Key：对应模型的 /relay/v1 调用一律回 503 relay_not_configured（不静默假成功）—— 可在管理台「中转服务」里补齐");
  }
});

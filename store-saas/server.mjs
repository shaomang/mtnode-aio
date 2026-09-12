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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const FILE_DIR = path.join(DATA_DIR, "files");
const SKILL_DIR = path.join(DATA_DIR, "skills");
const PREV_DIR = path.join(DATA_DIR, "previews");
const FORUM_IMG_DIR = path.join(DATA_DIR, "forum-images");
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

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}
mkdirp(FILE_DIR);
mkdirp(SKILL_DIR);
mkdirp(PREV_DIR);
mkdirp(FORUM_IMG_DIR);

function emptyDb() {
  return {
    users: [],
    sessions: [],
    identities: [],
    templates: [],
    skills: [],
    likes: [],
    skillLikes: [],
    forumTopics: [],
    forumReplies: [],
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
    if (!Array.isArray(d.likes)) d.likes = [];
    if (!Array.isArray(d.skillLikes)) d.skillLikes = [];
    if ("forumMessages" in d) {
      legacyForumSeen = true;
      delete d.forumMessages;
    }
    if (!Array.isArray(d.forumTopics)) d.forumTopics = [];
    if (!Array.isArray(d.forumReplies)) d.forumReplies = [];
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

async function authUser(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)/i.exec(h);
  if (!m) return null;
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
  const user = await authUser(req);

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
    return send(res, 200, {
      ok: true,
      service: "mtnode-store",
      templates: db.templates.length,
      skills: db.skills.length,
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
    if (!u) {
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

  send(res, 404, { ok: false, error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e.status || (String(e.message).includes("too large") ? 413 : 500);
    if (!res.headersSent) send(res, status, { ok: false, error: e.message || String(e) });
  });
});

server.listen(PORT, HOST, () => {
  console.log("[mtnode-store] http://" + HOST + ":" + PORT);
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
});

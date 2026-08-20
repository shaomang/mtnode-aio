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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const FILE_DIR = path.join(DATA_DIR, "files");
const SKILL_DIR = path.join(DATA_DIR, "skills");
const PREV_DIR = path.join(DATA_DIR, "previews");
const FORUM_IMG_DIR = path.join(DATA_DIR, "forum-images");
const DB_PATH = path.join(DATA_DIR, "db.json");
const FORUM_TTL_MS = 30 * 24 * 3600 * 1000;
const FORUM_ROOMS = new Set(["general", "bug", "improve"]);
const MAX_FORUM_TEXT = 2000;
const MAX_FORUM_IMAGE = 3 * 1024 * 1024;
const FORUM_RATE_MAX = 12;
const FORUM_RATE_WIN_MS = 60 * 1000;
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 40 * 1024 * 1024;
const MAX_TEMPLATE = 10 * 1024 * 1024;
const MAX_SKILL = 1 * 1024 * 1024;
const MAX_PREVIEW = 500 * 1024;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAGIC = Buffer.from("MTNODES", "ascii");
const ADMIN_USERS = new Set(
  String(process.env.MTNODE_STORE_ADMINS || "ms2308")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

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
    templates: [],
    skills: [],
    likes: [],
    skillLikes: [],
    forumMessages: [],
  };
}

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const d = JSON.parse(raw);
    if (!Array.isArray(d.users)) d.users = [];
    if (!Array.isArray(d.sessions)) d.sessions = [];
    if (!Array.isArray(d.templates)) d.templates = [];
    if (!Array.isArray(d.skills)) d.skills = [];
    if (!Array.isArray(d.likes)) d.likes = [];
    if (!Array.isArray(d.skillLikes)) d.skillLikes = [];
    if (!Array.isArray(d.forumMessages)) d.forumMessages = [];
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

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
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

function issueSession(u) {
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions = db.sessions.filter((s) => s.expiresAt > now() && s.userId !== u.id);
  db.sessions.push({ tokenHash: hashToken(token), userId: u.id, expiresAt: now() + SESSION_MS });
  return token;
}

function validPassword(password) {
  const s = String(password || "");
  return s.length >= 6 && s.length <= 72;
}

function authUser(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)/i.exec(h);
  if (!m) return null;
  const th = hashToken(m[1]);
  const sess = db.sessions.find((s) => s.tokenHash === th && s.expiresAt > now());
  if (!sess) return null;
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

function skillFilePath(id) {
  return path.join(SKILL_DIR, id + ".md");
}

function clearSkillFile(id) {
  try {
    fs.unlinkSync(skillFilePath(id));
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
  return { buf, ext: png ? "png" : webp ? "webp" : "jpg" };
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
}

function unlinkForumImage(id) {
  if (!id) return;
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    try { fs.unlinkSync(path.join(FORUM_IMG_DIR, id + "." + ext)); } catch {}
  }
}

function pruneForum() {
  const cut = now() - FORUM_TTL_MS;
  const src = Array.isArray(db.forumMessages) ? db.forumMessages : [];
  const keep = [];
  let dropped = 0;
  for (const m of src) {
    if (m && m.createdAt >= cut) keep.push(m);
    else {
      dropped += 1;
      if (m && m.imageId) unlinkForumImage(m.imageId);
    }
  }
  if (dropped) {
    db.forumMessages = keep;
    saveDb();
  } else {
    db.forumMessages = src;
  }
}

function forumDayKey(ts, tzOffsetMin) {
  const localMs = Number(ts || 0) - Number(tzOffsetMin || 0) * 60 * 1000;
  const d = new Date(localMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function forumDaysBefore(room, before, tzOffsetMin, cut) {
  const map = new Map();
  const beforeTs = Number(before) || 0;
  const cutTs = Number(cut) || 0;
  for (const m of db.forumMessages || []) {
    if (!m || m.room !== room) continue;
    if (m.createdAt < cutTs || m.createdAt >= beforeTs) continue;
    const day = forumDayKey(m.createdAt, tzOffsetMin);
    const cur = map.get(day) || { day, count: 0, from: m.createdAt, to: m.createdAt };
    cur.count += 1;
    if (m.createdAt < cur.from) cur.from = m.createdAt;
    if (m.createdAt > cur.to) cur.to = m.createdAt;
    map.set(day, cur);
  }
  return [...map.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

function publicForumMsg(m) {
  const u = db.users.find((x) => x.id === m.userId);
  return {
    id: m.id,
    room: m.room,
    text: m.text || "",
    imageId: m.imageId || "",
    createdAt: m.createdAt,
    user: {
      id: m.userId,
      username: (u && u.username) || "",
      nickname: (u && u.nickname) || "",
    },
  };
}

const forumPostTimes = new Map();
function forumRateOk(userId) {
  const t = now();
  const arr = (forumPostTimes.get(userId) || []).filter((x) => t - x < FORUM_RATE_WIN_MS);
  if (arr.length >= FORUM_RATE_MAX) {
    forumPostTimes.set(userId, arr);
    return false;
  }
  arr.push(t);
  forumPostTimes.set(userId, arr);
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
  const user = authUser(req);

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
    const b = await jsonBody();
    const username = String(b.username || "").trim();
    const password = String(b.password || "");
    const nickname = String(b.nickname || "").trim();
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      return send(res, 400, { ok: false, error: "用户名为 3-24 位字母、数字或下划线" });
    }
    if (password.length < 6 || password.length > 72) {
      return send(res, 400, { ok: false, error: "密码长度为 6-72 位" });
    }
    if (!nickname || nickname.length > 32) {
      return send(res, 400, { ok: false, error: "昵称长度为 1-32 位" });
    }
    if (findUserByName(username)) {
      return send(res, 409, { ok: false, error: "用户名已被占用" });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const u = {
      id: uid("u_"),
      username,
      nickname,
      salt,
      pass: hashPass(password, salt),
      createdAt: now(),
      downloadsReceived: 0,
      likesReceived: 0,
    };
    db.users.push(u);
    const token = issueSession(u);
    await saveDb();
    return send(res, 200, { ok: true, token, user: publicUser(u) });
  }

  if (method === "POST" && p === "/api/login") {
    const b = await jsonBody();
    const u = findUserByName(b.username);
    if (!u || hashPass(b.password, u.salt) !== u.pass) {
      return send(res, 401, { ok: false, error: "用户名或密码错误" });
    }
    const token = issueSession(u);
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
    u.salt = crypto.randomBytes(16).toString("hex");
    u.pass = hashPass(newPassword, u.salt);
    u.passwordChangedAt = now();
    const token = issueSession(u);
    await saveDb();
    return send(res, 200, { ok: true, token, user: publicUser(u) });
  }

  if (method === "POST" && p === "/api/logout") {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+(\S+)/i.exec(h);
    if (m) {
      const th = hashToken(m[1]);
      db.sessions = db.sessions.filter((s) => s.tokenHash !== th);
      await saveDb();
    }
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && p === "/api/me") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    return send(res, 200, { ok: true, user: publicUser(user) });
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
    if (owner) owner.downloadsReceived = (owner.downloadsReceived || 0) + 1;
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
    owner.downloadsReceived = Math.max(0, (owner.downloadsReceived || 0) - (t.downloads || 0));
    owner.likesReceived = Math.max(0, (owner.likesReceived || 0) - (t.likes || 0));
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
      if (owner) owner.likesReceived = Math.max(0, (owner.likesReceived || 0) - 1);
    } else {
      db.likes.push({ userId: user.id, templateId: t.id, at: now() });
      t.likes = (t.likes || 0) + 1;
      if (owner) owner.likesReceived = (owner.likesReceived || 0) + 1;
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
    const fp = skillFilePath(t.id);
    if (!fs.existsSync(fp)) return send(res, 404, { ok: false, error: "文件缺失" });
    t.downloads = (t.downloads || 0) + 1;
    const owner = db.users.find((u) => u.id === t.userId);
    if (owner) owner.downloadsReceived = (owner.downloadsReceived || 0) + 1;
    await saveDb();
    const buf = fs.readFileSync(fp);
    if (url.searchParams.get("format") === "raw") {
      return sendBin(res, 200, buf, "text/markdown; charset=utf-8");
    }
    return send(res, 200, {
      ok: true,
      id: t.id,
      skillName: t.skillName,
      title: t.title,
      version: t.version || "1.0.0",
      official: !!t.official,
      bytes: buf.length,
      text: buf.toString("utf8"),
      base64: buf.toString("base64"),
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
    if (buf.length > MAX_SKILL) {
      return send(res, 413, { ok: false, error: "技能文件不能超过 1MB" });
    }
    let parsed;
    try {
      parsed = parseSkillMarkdown(buf);
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message || String(e) });
    }
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
    fs.writeFileSync(skillFilePath(id), buf);
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
      bytes: buf.length,
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
    if (b.fileBase64) {
      let buf;
      try {
        buf = decodeUtf8Base64(b.fileBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "不是有效的 SKILL.md：" + e.message });
      }
      if (buf.length > MAX_SKILL) {
        return send(res, 413, { ok: false, error: "技能文件不能超过 1MB" });
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
      fs.writeFileSync(skillFilePath(t.id), buf);
      t.bytes = buf.length;
      if (b.version == null && parsed.version) {
        try {
          t.version = normalizeVersion(parsed.version, t.version || "1.0.0");
        } catch (e) {
          return send(res, 400, { ok: false, error: e.message || String(e) });
        }
      } else if (b.version == null) {
        return send(res, 400, { ok: false, error: "更新技能正文时请填写新版本号" });
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
    owner.downloadsReceived = Math.max(0, (owner.downloadsReceived || 0) - (t.downloads || 0));
    owner.likesReceived = Math.max(0, (owner.likesReceived || 0) - (t.likes || 0));
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
      if (owner) owner.likesReceived = Math.max(0, (owner.likesReceived || 0) - 1);
    } else {
      db.skillLikes.push({ userId: user.id, skillId: t.id, at: now() });
      t.likes = (t.likes || 0) + 1;
      if (owner) owner.likesReceived = (owner.likesReceived || 0) + 1;
    }
    await saveDb();
    return send(res, 200, { ok: true, item: publicSkill(t, user) });
  }

  if (method === "GET" && p === "/api/forum/messages") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    pruneForum();
    const room = String(url.searchParams.get("room") || "general");
    if (!FORUM_ROOMS.has(room)) {
      return send(res, 400, { ok: false, error: "未知讨论区" });
    }
    const cut = now() - FORUM_TTL_MS;
    const since = Number(url.searchParams.get("since") || 0) || 0;
    const fromRaw = Number(url.searchParams.get("from") || 0) || 0;
    const toRaw = Number(url.searchParams.get("to") || 0) || 0;
    const from = Math.max(cut, fromRaw || cut);
    const to = toRaw > 0 ? toRaw : now() + 1000;
    const includeDays = String(url.searchParams.get("includeDays") || "") === "1";
    const tzOffset = Number(url.searchParams.get("tzOffset") || 0) || 0;
    const items = (db.forumMessages || [])
      .filter(
        (m) =>
          m.room === room &&
          m.createdAt >= cut &&
          m.createdAt >= from &&
          m.createdAt <= to &&
          m.createdAt > since,
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicForumMsg);
    const payload = { ok: true, room, items, from, to, since: cut, ttlMs: FORUM_TTL_MS };
    if (includeDays) {
      payload.days = forumDaysBefore(room, from, tzOffset, cut);
    }
    return send(res, 200, payload);
  }

  if (method === "GET" && p === "/api/forum/days") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    pruneForum();
    const room = String(url.searchParams.get("room") || "general");
    if (!FORUM_ROOMS.has(room)) {
      return send(res, 400, { ok: false, error: "未知讨论区" });
    }
    const cut = now() - FORUM_TTL_MS;
    const beforeRaw = Number(url.searchParams.get("before") || 0) || 0;
    const before = beforeRaw > 0 ? beforeRaw : now();
    const tzOffset = Number(url.searchParams.get("tzOffset") || 0) || 0;
    const days = forumDaysBefore(room, before, tzOffset, cut);
    return send(res, 200, { ok: true, room, before, days, ttlMs: FORUM_TTL_MS });
  }

  if (method === "POST" && p === "/api/forum/messages") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
    if (!forumRateOk(user.id)) {
      return send(res, 429, { ok: false, error: "发送过于频繁，请稍后再试" });
    }
    pruneForum();
    const b = await jsonBody();
    const room = String(b.room || "").trim();
    if (!FORUM_ROOMS.has(room)) {
      return send(res, 400, { ok: false, error: "未知讨论区" });
    }
    const text = String(b.text || "").trim();
    if (text.length > MAX_FORUM_TEXT) {
      return send(res, 400, { ok: false, error: "消息不能超过 2000 字" });
    }
    let imageId = "";
    if (b.imageBase64) {
      let img;
      try {
        img = decodeForumImage(b.imageBase64);
      } catch (e) {
        return send(res, 400, { ok: false, error: "图片无效：" + e.message });
      }
      if (img) {
        imageId = uid("img_");
        writeForumImage(imageId, img);
      }
    }
    if (!text && !imageId) {
      return send(res, 400, { ok: false, error: "请填写文字或选择图片" });
    }
    const msg = {
      id: uid("fm_"),
      room,
      userId: user.id,
      text,
      imageId,
      createdAt: now(),
    };
    db.forumMessages.push(msg);
    await saveDb();
    return send(res, 200, { ok: true, item: publicForumMsg(msg) });
  }

  const forumImgR = /^\/api\/forum\/images\/([^/]+)$/.exec(p);
  if (forumImgR && method === "GET") {
    if (!user) return send(res, 401, { ok: false, error: "未登录" });
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
});

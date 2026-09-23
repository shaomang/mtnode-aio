"use strict";
/**
 * MTNode 创意工坊 — 账户存储抽象层（零依赖，仅 node:fs / node:path / node:crypto / node:https）。
 *
 * 目的：把 `server.mjs` 里对 `db.users / db.sessions / db.identities` 的直接读写收敛成一层
 * 可替换的存储接口，使「本地 JSON 库」与「阿里云表格存储（Tablestore）」两种后端在调用方
 * 看来完全一致。**本文件不改 `server.mjs`**，只提供接口与实现；后续任务按本契约替换调用点。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 后端选择
 *   MTNODE_ACCOUNT_STORE   json（默认）| aliyun-tablestore（别名 tablestore / ots）
 *   - json（默认）：行为与今天完全一致，落 `DATA_DIR/db.json`（DATA_DIR 默认 store-saas/data），
 *     只接管 users / sessions / identities 三个键，其它键（templates / skills / likes /
 *     forumMessages…）原样保留，写入沿用「临时文件 + rename」原子写。
 *   - aliyun-tablestore：零依赖直连表格存储 HTTP API（见下）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 统一接口契约（两后端方法签名 / 返回一致，全部 async）
 *
 *   store.backend                       "json" | "aliyun-tablestore"
 *   store.describe()                    不含凭据的配置摘要（供启动日志 / 健康检查）
 *   await store.ready()                 载入 / 校验配置；配置不合法时 reject（构造时已先抛一次）
 *
 *   —— 账号（users）—— 记录字段与 `docs/auth-design.md` 2.1 完全一致
 *   await store.getUser(id)                       -> user | null
 *   await store.getUserByUsername(username)       -> user | null（username 大小写不敏感）
 *   await store.listUsers()                       -> user[]
 *   await store.createUser(fields)                -> user（自动生成 id / 占位 username，默认字段同 server.mjs）
 *   await store.updateUser(id, patch)             -> user | null（浅合并后落库）
 *   await store.deleteUser(id)                    -> boolean
 *
 *   —— 会话（sessions）—— 记录形如 { tokenHash, userId, expiresAt }
 *   await store.getSession(tokenHash)             -> session | null（是否过期由调用方判断）
 *   await store.listSessions()                    -> session[]
 *   await store.createSession(session)            -> session
 *   await store.updateSession(session)            -> session | null（按 tokenHash 就地更新，用于滑动续期）
 *   await store.deleteSession(tokenHash)          -> boolean
 *   await store.deleteSessionsByUser(userId)      -> number（删除条数）
 *   await store.pruneSessions(nowTs)              -> number（删除 expiresAt <= nowTs 的条数）
 *
 *   —— 身份索引（identities）—— 记录形如 { kind, value, userId, createdAt }
 *   await store.getIdentity(kind, value)          -> identity | null
 *   await store.getUserByIdentity(kind, value)    -> user | null
 *   await store.listIdentities()                  -> identity[]
 *   await store.claimIdentity(kind, value, userId)-> boolean（被他人占用返回 false；本人重复认领成功）
 *   await store.releaseIdentity(kind, value, userId) -> boolean（无匹配 / 归属不符返回 false）
 *   await store.replaceIdentities(list)           -> number（整体替换，用于 ensureIdentityIndex 重建）
 *
 * 语义说明：
 *   - 返回的 user / session / identity 为普通对象，字段与现有内存对象一致，可直接交给
 *     `publicUser()` 等既有函数。
 *   - json 后端返回的是进程内内存引用（同 server.mjs 今天的行为）；tablestore 后端返回的是
 *     每次从远端解析出的快照副本。**任何修改都必须经 updateUser / createSession 等写方法落库**，
 *     不要依赖「改返回对象就自动保存」——那是 json 后端的历史副作用，不是契约。
 *   - 写操作失败一律 reject（绝不吞错导致「登录成功但没落库」）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 阿里云表格存储（Tablestore）后端
 *
 * 环境变量（缺任一项启动即抛错，不做静默降级）：
 *   MTNODE_OTS_ENDPOINT          服务地址，如 https://myinst.cn-hangzhou.ots.aliyuncs.com
 *   MTNODE_OTS_INSTANCE          实例名（签名头 x-ots-instancename）
 *   MTNODE_OTS_ACCESS_KEY_ID     阿里云 AccessKeyId
 *   MTNODE_OTS_ACCESS_KEY_SECRET 阿里云 AccessKeySecret（HMAC-SHA1 密钥）
 *   MTNODE_OTS_TABLE_PREFIX      表名前缀，默认 "mtnode_"（即默认三张表 mtnode_users /
 *                                mtnode_sessions / mtnode_identities）
 *   MTNODE_OTS_REGION            可选：未配置 MTNODE_OTS_ENDPOINT 时用
 *                                https://<instance>.<region>.ots.aliyuncs.com 拼出
 *
 * 表结构（主键均为字符串 `id`；非主键列存 JSON 文本 + 少量检索列）：
 *   <prefix>users      id=userId          | data(JSON) 
 *   <prefix>sessions   id=tokenHash       | data(JSON), userId, expiresAt
 *   <prefix>identities id=kind:value      | data(JSON), provider(=kind), uid(=userId)
 *
 * 协议（零依赖直连，签名按官方 SignV2 规范拼接）：
 *   - 请求 POST https://<endpoint>/<Operation>（GetRow / PutRow / DeleteRow / GetRange）。
 *   - 请求体为 protobuf 消息，行数据为 PlainBuffer 编码（本文件手写编解码，不引 npm 依赖）。
 *   - 请求头：x-ots-apiversion / x-ots-instancename / x-ots-contentmd5 / x-ots-date /
 *     x-ots-accesskeyid，签名头 x-ots-signature = Base64(HMAC-SHA1(AccessKeySecret, StringToSign))。
 *   - StringToSign = "/<Operation>" + "\n" + "POST" + "\n" + "\n"
 *                    + 排序后的 "x-ots-*:value" 行（换行分隔，签名头自身不参与） + "\n"。
 *     （注意：这与阿里云 RPC 风格短信接口 sms-provider.mjs 的 percentEncode 签名不同——
 *      OTS 用规范化头签名，因此这里不需要 percentEncode；HTTP / HMAC 写法沿用其风格。）
 *   - 读操作 GetRange 以 limit 分批拉取，用 next_start_primary_key 续读。
 *   - 写操作（PutRow / DeleteRow）带有限重试（默认 3 次，仅网络错误 / 429 / 5xx 重试，
 *     指数退避），最终失败原样上抛。
 *
 * 注意：本模块不负责建表；请预先在表格存储控制台按上表创建三张表（主键 id 为 STRING）。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(MODULE_DIR, "data");
const SESSION_MS = 30 * 24 * 3600 * 1000;

/** 支持的后端标识。 */
export const ACCOUNT_STORE_BACKENDS = Object.freeze(["json", "aliyun-tablestore"]);

/* ========================================================================== *
 * 通用小工具
 * ========================================================================== */

function now() {
  return Date.now();
}

function newUserId() {
  return "u_" + crypto.randomBytes(8).toString("hex");
}

function newPlaceholderUsername() {
  return "u_" + crypto.randomBytes(4).toString("hex");
}

function identityKey(kind, value) {
  return String(kind || "") + ":" + String(value || "");
}

/** 与 server.mjs createUser 默认字段保持一致。 */
function makeUserRecord(fields) {
  const u = {
    id: "",
    username: "",
    nickname: "",
    avatar: "",
    salt: "",
    pass: "",
    phone: "",
    phoneVerifiedAt: 0,
    wechatOpenId: "",
    wechatUnionId: "",
    wechatBoundAt: 0,
    passwordChangedAt: 0,
    createdAt: now(),
    downloadsReceived: 0,
    likesReceived: 0,
  };
  if (fields) Object.assign(u, fields);
  return u;
}

/**
 * 解析后端标识：未设置 = json；未知值直接抛错（避免把账户写进错地方）。
 * @param {string} [raw]
 * @returns {"json"|"aliyun-tablestore"}
 */
export function resolveAccountStoreBackend(raw) {
  const s = String(raw === undefined ? process.env.MTNODE_ACCOUNT_STORE || "" : raw)
    .trim()
    .toLowerCase();
  if (!s || s === "json" || s === "file" || s === "local") return "json";
  if (s === "aliyun-tablestore" || s === "tablestore" || s === "ots" || s === "aliyun-ots") {
    return "aliyun-tablestore";
  }
  throw new Error(
    "未知的 MTNODE_ACCOUNT_STORE=" + s + "（支持 json / aliyun-tablestore）",
  );
}

/* ========================================================================== *
 * JSON 后端（默认，行为与今天一致）
 * ========================================================================== */

function normalizeDbObject(d) {
  const o = d && typeof d === "object" ? d : {};
  if (!Array.isArray(o.users)) o.users = [];
  if (!Array.isArray(o.sessions)) o.sessions = [];
  if (!Array.isArray(o.identities)) o.identities = [];
  return o;
}

function createJsonAccountStore(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || DEFAULT_DATA_DIR;
  const dbPath = options.dbPath || path.join(dataDir, "db.json");

  let state = null;
  let saveChain = Promise.resolve();

  function load() {
    if (state) return state;
    try {
      state = normalizeDbObject(JSON.parse(fs.readFileSync(dbPath, "utf8")));
    } catch {
      state = normalizeDbObject({});
    }
    return state;
  }

  function persist() {
    const run = () => {
      const tmp = dbPath + ".tmp";
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, dbPath);
    };
    // 串行化写，但保留「失败可继续」的链；本次调用的 promise 仍会在失败时 reject。
    const next = saveChain.then(run, run);
    saveChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  const store = {
    backend: "json",
    dbPath,
    dataDir,

    describe() {
      return { backend: "json", dbPath, dataDir };
    },

    async ready() {
      load();
      return true;
    },

    /* ---- users ---- */

    async getUser(id) {
      const db = load();
      return db.users.find((u) => u.id === id) || null;
    },

    async getUserByUsername(username) {
      const db = load();
      const n = String(username || "").toLowerCase();
      return db.users.find((u) => String(u.username || "").toLowerCase() === n) || null;
    },

    async listUsers() {
      return load().users.slice();
    },

    async createUser(fields) {
      const db = load();
      let username;
      do {
        username = newPlaceholderUsername();
      } while (db.users.some((u) => u.username === username));
      const u = makeUserRecord(Object.assign({ id: newUserId(), username }, fields || {}));
      if (!u.username) u.username = username;
      db.users.push(u);
      await persist();
      return u;
    },

    async updateUser(id, patch) {
      const db = load();
      const u = db.users.find((x) => x.id === id);
      if (!u) return null;
      if (patch) Object.assign(u, patch, { id: u.id });
      await persist();
      return u;
    },

    async deleteUser(id) {
      const db = load();
      const before = db.users.length;
      db.users = db.users.filter((u) => u.id !== id);
      if (db.users.length === before) return false;
      await persist();
      return true;
    },

    /* ---- sessions ---- */

    async getSession(tokenHash) {
      const db = load();
      return db.sessions.find((s) => s.tokenHash === tokenHash) || null;
    },

    async listSessions() {
      return load().sessions.slice();
    },

    async createSession(session) {
      const db = load();
      const s = Object.assign({}, session);
      db.sessions.push(s);
      await persist();
      return s;
    },

    async updateSession(session) {
      const db = load();
      const i = db.sessions.findIndex((s) => s.tokenHash === session.tokenHash);
      if (i < 0) return null;
      const next = Object.assign({}, db.sessions[i], session, { tokenHash: db.sessions[i].tokenHash });
      db.sessions[i] = next;
      await persist();
      return next;
    },

    async deleteSession(tokenHash) {
      const db = load();
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash);
      if (db.sessions.length === before) return false;
      await persist();
      return true;
    },

    async deleteSessionsByUser(userId) {
      const db = load();
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((s) => s.userId !== userId);
      const removed = before - db.sessions.length;
      if (removed) await persist();
      return removed;
    },

    async pruneSessions(nowTs) {
      const db = load();
      const t = Number(nowTs) || now();
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((s) => Number(s.expiresAt || 0) > t);
      const removed = before - db.sessions.length;
      if (removed) await persist();
      return removed;
    },

    /* ---- identities ---- */

    async getIdentity(kind, value) {
      const db = load();
      const k = identityKey(kind, value);
      return db.identities.find((x) => identityKey(x.kind, x.value) === k) || null;
    },

    async getUserByIdentity(kind, value) {
      const e = await store.getIdentity(kind, value);
      if (!e) return null;
      return store.getUser(e.userId);
    },

    async listIdentities() {
      return load().identities.slice();
    },

    async claimIdentity(kind, value, userId) {
      const v = String(value || "");
      if (!v) return false;
      const db = load();
      const k = identityKey(kind, v);
      const hit = db.identities.find((x) => identityKey(x.kind, x.value) === k);
      if (hit && hit.userId !== userId) return false;
      if (!hit) {
        db.identities.push({ kind, value: v, userId, createdAt: now() });
        await persist();
      }
      return true;
    },

    async releaseIdentity(kind, value, userId) {
      const db = load();
      const k = identityKey(kind, value);
      const before = db.identities.length;
      db.identities = db.identities.filter(
        (x) => !(identityKey(x.kind, x.value) === k && (!userId || x.userId === userId)),
      );
      const removed = before - db.identities.length;
      if (removed) await persist();
      return removed > 0;
    },

    async replaceIdentities(list) {
      const db = load();
      db.identities = (Array.isArray(list) ? list : []).map((e) => ({
        kind: e.kind,
        value: e.value,
        userId: e.userId,
        createdAt: e.createdAt || now(),
      }));
      await persist();
      return db.identities.length;
    },
  };

  return store;
}

/* ========================================================================== *
 * PlainBuffer（行数据编解码）—— 表格存储数据 API 的行编码格式
 * ========================================================================== */

const PB = Object.freeze({
  HEADER: 0x75,
  TAG_ROW_PK: 0x1,
  TAG_ROW_DATA: 0x2,
  TAG_CELL: 0x3,
  TAG_CELL_NAME: 0x4,
  TAG_CELL_VALUE: 0x5,
  TAG_CELL_TYPE: 0x6,
  TAG_CELL_TIMESTAMP: 0x7,
  TAG_DELETE_ROW_MARKER: 0x8,
  TAG_ROW_CHECKSUM: 0x9,
  TAG_CELL_CHECKSUM: 0x0a,
  VT_INTEGER: 0x0,
  VT_DOUBLE: 0x1,
  VT_BOOLEAN: 0x2,
  VT_STRING: 0x3,
  VT_BLOB: 0x7,
  VT_INF_MIN: 0x9,
  VT_INF_MAX: 0x0a,
});

/** INF_MIN / INF_MAX 哨兵值（GetRange 边界）。 */
export const INF_MIN = Symbol("OTS_INF_MIN");
export const INF_MAX = Symbol("OTS_INF_MAX");

const CRC8_TABLE = [
  0x00, 0x07, 0x0e, 0x09, 0x1c, 0x1b, 0x12, 0x15, 0x38, 0x3f, 0x36, 0x31, 0x24, 0x23, 0x2a, 0x2d,
  0x70, 0x77, 0x7e, 0x79, 0x6c, 0x6b, 0x62, 0x65, 0x48, 0x4f, 0x46, 0x41, 0x54, 0x53, 0x5a, 0x5d,
  0xe0, 0xe7, 0xee, 0xe9, 0xfc, 0xfb, 0xf2, 0xf5, 0xd8, 0xdf, 0xd6, 0xd1, 0xc4, 0xc3, 0xca, 0xcd,
  0x90, 0x97, 0x9e, 0x99, 0x8c, 0x8b, 0x82, 0x85, 0xa8, 0xaf, 0xa6, 0xa1, 0xb4, 0xb3, 0xba, 0xbd,
  0xc7, 0xc0, 0xc9, 0xce, 0xdb, 0xdc, 0xd5, 0xd2, 0xff, 0xf8, 0xf1, 0xf6, 0xe3, 0xe4, 0xed, 0xea,
  0xb7, 0xb0, 0xb9, 0xbe, 0xab, 0xac, 0xa5, 0xa2, 0x8f, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9d, 0x9a,
  0x27, 0x20, 0x29, 0x2e, 0x3b, 0x3c, 0x35, 0x32, 0x1f, 0x18, 0x11, 0x16, 0x03, 0x04, 0x0d, 0x0a,
  0x57, 0x50, 0x59, 0x5e, 0x4b, 0x4c, 0x45, 0x42, 0x6f, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7d, 0x7a,
  0x89, 0x8e, 0x87, 0x80, 0x95, 0x92, 0x9b, 0x9c, 0xb1, 0xb6, 0xbf, 0xb8, 0xad, 0xaa, 0xa3, 0xa4,
  0xf9, 0xfe, 0xf7, 0xf0, 0xe5, 0xe2, 0xeb, 0xec, 0xc1, 0xc6, 0xcf, 0xc8, 0xdd, 0xda, 0xd3, 0xd4,
  0x69, 0x6e, 0x67, 0x60, 0x75, 0x72, 0x7b, 0x7c, 0x51, 0x56, 0x5f, 0x58, 0x4d, 0x4a, 0x43, 0x44,
  0x19, 0x1e, 0x17, 0x10, 0x05, 0x02, 0x0b, 0x0c, 0x21, 0x26, 0x2f, 0x28, 0x3d, 0x3a, 0x33, 0x34,
  0x4e, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5c, 0x5b, 0x76, 0x71, 0x78, 0x7f, 0x6a, 0x6d, 0x64, 0x63,
  0x3e, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2c, 0x2b, 0x06, 0x01, 0x08, 0x0f, 0x1a, 0x1d, 0x14, 0x13,
  0xae, 0xa9, 0xa0, 0xa7, 0xb2, 0xb5, 0xbc, 0xbb, 0x96, 0x91, 0x98, 0x9f, 0x8a, 0x8d, 0x84, 0x83,
  0xde, 0xd9, 0xd0, 0xd7, 0xc2, 0xc5, 0xcc, 0xcb, 0xe6, 0xe1, 0xe8, 0xef, 0xfa, 0xfd, 0xf4, 0xf3,
];

function crc8(crc, byte) {
  return CRC8_TABLE[(crc & 0xff) ^ (byte & 0xff)];
}
function crc8Buf(crc, buf) {
  for (let i = 0; i < buf.length; i++) crc = crc8(crc, buf[i]);
  return crc;
}
function crc8Int32(crc, n) {
  for (let i = 0; i < 4; i++) crc = crc8(crc, (n >> (i * 8)) & 0xff);
  return crc;
}

/** 把值编码为 PlainBuffer 的 variant 载荷（VT 字节 + 内容），并同步 CRC。 */
function encodeVariant(value, crc) {
  if (value === INF_MIN) {
    return { vt: PB.VT_INF_MIN, payload: Buffer.alloc(0), crc: crc8(crc, PB.VT_INF_MIN) };
  }
  if (value === INF_MAX) {
    return { vt: PB.VT_INF_MAX, payload: Buffer.alloc(0), crc: crc8(crc, PB.VT_INF_MAX) };
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    crc = crc8(crc, PB.VT_STRING);
    crc = crc8Int32(crc, bytes.length);
    crc = crc8Buf(crc, bytes);
    return { vt: PB.VT_STRING, payload: Buffer.concat([len, bytes]), crc };
  }
  if (typeof value === "boolean") {
    const b = Buffer.from([value ? 1 : 0]);
    crc = crc8(crc, PB.VT_BOOLEAN);
    crc = crc8(crc, value ? 1 : 0);
    return { vt: PB.VT_BOOLEAN, payload: b, crc };
  }
  if (typeof value === "number") {
    const b = Buffer.alloc(8);
    const isInt = Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER;
    if (isInt) {
      b.writeBigInt64LE(BigInt(value), 0);
      crc = crc8(crc, PB.VT_INTEGER);
    } else {
      b.writeDoubleLE(value, 0);
      crc = crc8(crc, PB.VT_DOUBLE);
    }
    crc = crc8Buf(crc, b);
    return { vt: isInt ? PB.VT_INTEGER : PB.VT_DOUBLE, payload: b, crc };
  }
  if (Buffer.isBuffer(value)) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(value.length, 0);
    crc = crc8(crc, PB.VT_BLOB);
    crc = crc8Int32(crc, value.length);
    crc = crc8Buf(crc, value);
    return { vt: PB.VT_BLOB, payload: Buffer.concat([len, value]), crc };
  }
  throw new Error("不支持写入表格存储的列类型：" + typeof value);
}

/** 写一个 cell 的「值」段（TAG_CELL_VALUE + LE32 长度 + VT + 载荷）。 */
function writeCellValue(out, value, crc) {
  const enc = encodeVariant(value, crc);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(enc.payload.length + 1, 0);
  out.push(Buffer.from([PB.TAG_CELL_VALUE]));
  out.push(size);
  out.push(Buffer.from([enc.vt]));
  if (enc.payload.length) out.push(enc.payload);
  return enc.crc;
}

/** 写一个 cell 的「列名」段（TAG_CELL_NAME + LE32 长度 + 名字）。 */
function writeCellName(out, name, crc) {
  const bytes = Buffer.from(String(name), "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length, 0);
  out.push(Buffer.from([PB.TAG_CELL_NAME]));
  out.push(size);
  out.push(bytes);
  return crc8Buf(crc, bytes);
}

/**
 * 编码一行（PutRow 用）：主键 + 普通列 + 行校验和。
 * @param {string} pkName 主键列名
 * @param {string|symbol} pkValue 主键值（字符串，或 INF_MIN / INF_MAX）
 * @param {Object<string, string|number|boolean|Buffer>} [columns] 普通列
 */
function encodePlainBufferRow(pkName, pkValue, columns) {
  const out = [];
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    out.push(b);
  };

  u32(PB.HEADER);
  out.push(Buffer.from([PB.TAG_ROW_PK]));

  let rowCrc = 0;
  // 主键 cell
  let cellCrc = 0;
  out.push(Buffer.from([PB.TAG_CELL]));
  cellCrc = writeCellName(out, pkName, cellCrc);
  cellCrc = writeCellValue(out, pkValue, cellCrc);
  out.push(Buffer.from([PB.TAG_CELL_CHECKSUM, cellCrc & 0xff]));
  rowCrc = crc8(rowCrc, cellCrc);

  // 普通列
  if (columns && typeof columns === "object") {
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (entries.length) {
      out.push(Buffer.from([PB.TAG_ROW_DATA]));
      for (const [name, value] of entries) {
        cellCrc = 0;
        out.push(Buffer.from([PB.TAG_CELL]));
        cellCrc = writeCellName(out, name, cellCrc);
        cellCrc = writeCellValue(out, value, cellCrc);
        out.push(Buffer.from([PB.TAG_CELL_CHECKSUM, cellCrc & 0xff]));
        rowCrc = crc8(rowCrc, cellCrc);
      }
    }
  }

  rowCrc = crc8(rowCrc, 0);
  out.push(Buffer.from([PB.TAG_ROW_CHECKSUM, rowCrc & 0xff]));
  return Buffer.concat(out);
}

/**
 * 编码一行（DeleteRow 用）：主键 + 删除行标记 + 行校验和。
 * 官方 PlainBuffer 的删除行必须带 `TAG_DELETE_ROW_MARKER`，且行校验和以值 1 递推；
 * 缺这个标记时服务端返回 400 OTSParameterInvalid "Delete marker is missing while deleting row."。
 */
function encodePlainBufferDeleteRow(pkName, pkValue) {
  const out = [];
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    out.push(b);
  };

  u32(PB.HEADER);
  out.push(Buffer.from([PB.TAG_ROW_PK]));

  let rowCrc = 0;
  let cellCrc = 0;
  out.push(Buffer.from([PB.TAG_CELL]));
  cellCrc = writeCellName(out, pkName, cellCrc);
  cellCrc = writeCellValue(out, pkValue, cellCrc);
  out.push(Buffer.from([PB.TAG_CELL_CHECKSUM, cellCrc & 0xff]));
  rowCrc = crc8(rowCrc, cellCrc);

  out.push(Buffer.from([PB.TAG_DELETE_ROW_MARKER]));
  rowCrc = crc8(rowCrc, 1);
  out.push(Buffer.from([PB.TAG_ROW_CHECKSUM, rowCrc & 0xff]));
  return Buffer.concat(out);
}

/** 读一个 variant 值，返回 { value, pos }。 */
function readVariant(buf, pos) {
  const size = buf.readInt32LE(pos);
  pos += 4;
  const end = pos + size;
  const vt = buf[pos++];
  let value;
  if (vt === PB.VT_STRING) {
    const n = buf.readInt32LE(pos);
    pos += 4;
    value = buf.toString("utf8", pos, pos + n);
    pos += n;
  } else if (vt === PB.VT_INTEGER) {
    value = Number(buf.readBigInt64LE(pos));
    pos += 8;
  } else if (vt === PB.VT_DOUBLE) {
    value = buf.readDoubleLE(pos);
    pos += 8;
  } else if (vt === PB.VT_BOOLEAN) {
    value = buf[pos++] !== 0;
  } else if (vt === PB.VT_BLOB) {
    const n = buf.readInt32LE(pos);
    pos += 4;
    value = Buffer.from(buf.subarray(pos, pos + n));
    pos += n;
  } else if (vt === PB.VT_INF_MIN) {
    value = INF_MIN;
  } else if (vt === PB.VT_INF_MAX) {
    value = INF_MAX;
  } else {
    throw new Error("未知的 PlainBuffer variant 类型：" + vt);
  }
  return { value, pos: Math.max(pos, end) };
}

/**
 * 读一行（不含 header 的循环体）。返回 { pk, attrs, pos, tag }。
 * tag 为读到下一行/结束时的当前标签。
 */
function readRowWithoutHeader(buf, pos, tag) {
  const pk = [];
  const attrs = [];

  if (tag === PB.TAG_ROW_PK) {
    tag = buf[pos++];
    while (tag === PB.TAG_CELL) {
      tag = buf[pos++]; // TAG_CELL_NAME
      const nameLen = buf.readInt32LE(pos);
      pos += 4;
      const name = buf.toString("utf8", pos, pos + nameLen);
      pos += nameLen;
      tag = buf[pos++]; // TAG_CELL_VALUE
      const v = readVariant(buf, pos);
      pos = v.pos;
      pk.push({ name, value: v.value });
      tag = buf[pos++]; // TAG_CELL_CHECKSUM
      pos += 1; // checksum byte
      tag = buf[pos++];
    }
  }

  if (tag === PB.TAG_ROW_DATA) {
    tag = buf[pos++];
    while (tag === PB.TAG_CELL) {
      tag = buf[pos++]; // TAG_CELL_NAME
      const nameLen = buf.readInt32LE(pos);
      pos += 4;
      const name = buf.toString("utf8", pos, pos + nameLen);
      pos += nameLen;
      tag = buf[pos++]; // TAG_CELL_VALUE
      const v = readVariant(buf, pos);
      pos = v.pos;
      tag = buf[pos++];
      if (tag === PB.TAG_CELL_TYPE) {
        pos += 1;
        tag = buf[pos++];
      }
      if (tag === PB.TAG_CELL_TIMESTAMP) {
        pos += 8;
        tag = buf[pos++];
      }
      if (tag !== PB.TAG_CELL_CHECKSUM) {
        throw new Error("PlainBuffer 列缺少 TAG_CELL_CHECKSUM");
      }
      pos += 1;
      tag = buf[pos++];
      attrs.push({ name, value: v.value });
    }
  }

  if (tag === PB.TAG_DELETE_ROW_MARKER) {
    tag = buf[pos++];
  }
  if (tag === PB.TAG_ROW_CHECKSUM) {
    pos += 1;
    tag = buf[pos++];
  } else if (pos < buf.length) {
    throw new Error("PlainBuffer 行缺少 TAG_ROW_CHECKSUM");
  }
  return { pk, attrs, pos, tag };
}

function rowToObject(row) {
  const o = {};
  for (const c of row.pk) o[c.name] = c.value;
  for (const c of row.attrs) o[c.name] = c.value;
  return o;
}

/** 解析单行 PlainBuffer（GetRow 响应）。空 buffer 返回 null。 */
function decodePlainBufferRow(buf) {
  if (!buf || buf.length < 4) return null;
  let pos = 0;
  if (buf.readUInt32LE(pos) !== PB.HEADER) throw new Error("PlainBuffer header 非法");
  pos += 4;
  const tag = buf[pos];
  pos += 1;
  const row = readRowWithoutHeader(buf, pos, tag);
  return rowToObject(row);
}

/** 解析多行 PlainBuffer（GetRange 响应）。 */
function decodePlainBufferRows(buf) {
  if (!buf || buf.length < 4) return [];
  let pos = 0;
  if (buf.readUInt32LE(pos) !== PB.HEADER) throw new Error("PlainBuffer header 非法");
  pos += 4;
  let tag = buf[pos++];
  const out = [];
  while (pos < buf.length) {
    const row = readRowWithoutHeader(buf, pos, tag);
    out.push(rowToObject(row));
    pos = row.pos;
    tag = row.tag;
  }
  return out;
}

/** 取一行里第一个主键值（用于 GetRange 的 next_start_primary_key）。 */
function firstPkValue(buf) {
  if (!buf || buf.length < 4) return null;
  let pos = 0;
  if (buf.readUInt32LE(pos) !== PB.HEADER) return null;
  pos += 4;
  const tag = buf[pos];
  pos += 1;
  const row = readRowWithoutHeader(buf, pos, tag);
  return row.pk.length ? row.pk[0].value : null;
}

/* ========================================================================== *
 * protobuf（请求 / 响应信封）—— 手写最小实现
 * ========================================================================== */

function pbVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function pbTag(field, wire) {
  return pbVarint((field << 3) | wire);
}

function pbVarintField(field, n) {
  return Buffer.concat([pbTag(field, 0), pbVarint(n)]);
}

function pbBytesField(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Buffer.concat([pbTag(field, 2), pbVarint(b.length), b]);
}

function pbStringField(field, s) {
  return pbBytesField(field, Buffer.from(String(s), "utf8"));
}

function pbMessageField(field, inner) {
  return pbBytesField(field, inner);
}

/** 解析 protobuf，返回 [{ field, wire, varint?, bytes? }]。 */
function pbParse(buf) {
  const out = [];
  let pos = 0;
  const readVarint = () => {
    let shift = 0n;
    let result = 0n;
    while (true) {
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return result;
  };
  while (pos < buf.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      out.push({ field, wire, varint: readVarint() });
    } else if (wire === 1) {
      out.push({ field, wire, bytes: Buffer.from(buf.subarray(pos, pos + 8)) });
      pos += 8;
    } else if (wire === 2) {
      const len = Number(readVarint());
      out.push({ field, wire, bytes: Buffer.from(buf.subarray(pos, pos + len)) });
      pos += len;
    } else if (wire === 5) {
      out.push({ field, wire, bytes: Buffer.from(buf.subarray(pos, pos + 4)) });
      pos += 4;
    } else {
      throw new Error("不支持的 protobuf wire type：" + wire);
    }
  }
  return out;
}

function pbFieldBytes(fields, field) {
  const hit = fields.find((f) => f.field === field && f.wire === 2);
  return hit ? hit.bytes : null;
}

// Condition 的 **消息体**（不是整条消息）：row_existence = IGNORE(0)。
// 注意：这里不能再套一层 pbMessageField(1, …)，否则会编码成 field3{field1{field1:0}}，
// 多出一层嵌套，服务端直接 400 OTSParameterInvalid "Failed to parse the ProtoBuf message"。
const OTS_CONDITION_IGNORE = pbVarintField(1, 0);

function encodeGetRowRequest(table, pkBuf) {
  return Buffer.concat([
    pbStringField(1, table),
    pbBytesField(2, pkBuf),
    pbVarintField(5, 1), // max_versions：官方 proto 字段 5，缺省会被服务端判为 “No version condition is specified.”
  ]);
}

function encodePutRowRequest(table, rowBuf) {
  return Buffer.concat([pbStringField(1, table), pbBytesField(2, rowBuf), pbMessageField(3, OTS_CONDITION_IGNORE)]);
}

function encodeDeleteRowRequest(table, pkBuf) {
  return Buffer.concat([pbStringField(1, table), pbBytesField(2, pkBuf), pbMessageField(3, OTS_CONDITION_IGNORE)]);
}

function encodeGetRangeRequest(table, startBuf, endBuf, limit) {
  return Buffer.concat([
    pbStringField(1, table),
    pbVarintField(2, 0), // Direction.FORWARD
    pbVarintField(5, 1), // max_versions：官方 proto 字段 5（见 GetRow 同项说明）
    pbVarintField(6, limit),
    pbBytesField(7, startBuf),
    pbBytesField(8, endBuf),
    pbVarintField(16, 1), // return_entire_primary_keys
  ]);
}

/* ========================================================================== *
 * 表格存储 HTTP 客户端（零依赖，SignV2 签名）
 * ========================================================================== */

class OtsError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "OtsError";
    this.code = opts.code || "";
    this.status = opts.status || 0;
    this.requestId = opts.requestId || "";
    this.retryable = !!opts.retryable;
  }
}

function httpsPost(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: (u.pathname || "/") + (u.search || ""),
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("表格存储请求超时（" + timeoutMs + "ms）")));
    req.on("error", reject);
    req.end(body);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseOtsErrorXml(text) {
  const code = /<Code>([^<]*)<\/Code>/.exec(text);
  const msg = /<Message>([^<]*)<\/Message>/.exec(text);
  return { code: code ? code[1] : "", message: msg ? msg[1] : "" };
}

/**
 * 读取表格存储配置。缺项直接抛错（不静默降级）。
 * @returns {{endpoint:string, instance:string, accessKeyId:string, accessKeySecret:string, tablePrefix:string}}
 */
export function resolveOtsConfig(env = process.env) {
  const pickFrom = (...names) => {
    for (const n of names) {
      const v = env[n];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  const instance = pickFrom("MTNODE_OTS_INSTANCE");
  const region = pickFrom("MTNODE_OTS_REGION", "MTNODE_OTS_REGION_ID");
  let endpoint = pickFrom("MTNODE_OTS_ENDPOINT", "MTNODE_OTS_URL");
  if (!endpoint && instance && region) {
    endpoint = "https://" + instance + "." + region + ".ots.aliyuncs.com";
  }
  const accessKeyId = pickFrom("MTNODE_OTS_ACCESS_KEY_ID", "MTNODE_OTS_KEY_ID");
  const accessKeySecret = pickFrom("MTNODE_OTS_ACCESS_KEY_SECRET", "MTNODE_OTS_KEY_SECRET");
  const tablePrefix = pickFrom("MTNODE_OTS_TABLE_PREFIX") || "mtnode_";

  const missing = [];
  if (!endpoint) missing.push("MTNODE_OTS_ENDPOINT（或 MTNODE_OTS_INSTANCE + MTNODE_OTS_REGION）");
  if (!instance) missing.push("MTNODE_OTS_INSTANCE");
  if (!accessKeyId) missing.push("MTNODE_OTS_ACCESS_KEY_ID");
  if (!accessKeySecret) missing.push("MTNODE_OTS_ACCESS_KEY_SECRET");
  if (missing.length) {
    throw new Error(
      "MTNODE_ACCOUNT_STORE=aliyun-tablestore 但缺少配置：" +
        missing.join(" / ") +
        "（账户存储不会静默降级，请补齐后再启动）",
    );
  }
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error("MTNODE_OTS_ENDPOINT 必须以 http(s):// 开头，当前：" + endpoint);
  }
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    instance,
    accessKeyId,
    accessKeySecret,
    tablePrefix,
  };
}

/* ========================================================================== *
 * 表格存储后端
 * ========================================================================== */

function createTablestoreAccountStore(options = {}) {
  const cfg = options.config || resolveOtsConfig();
  const tableNames = {
    users: cfg.tablePrefix + "users",
    sessions: cfg.tablePrefix + "sessions",
    identities: cfg.tablePrefix + "identities",
  };
  const PK_NAME = "id";
  const timeoutMs = Number(options.timeoutMs) || 10_000;
  const maxRetries = Number.isFinite(options.retries) ? options.retries : 3;
  const scanLimit = Number(options.scanLimit) || 500;

  /**
   * 发一次 OTS 请求。写操作默认带有限重试（网络错误 / 429 / 5xx），最终失败原样上抛。
   * @param {string} operation GetRow | PutRow | DeleteRow | GetRange
   * @param {Buffer} body protobuf 请求体
   * @param {{retries?:number}} [opts]
   */
  async function call(operation, body, opts = {}) {
    const retries = Number.isFinite(opts.retries) ? opts.retries : maxRetries;
    const url = cfg.endpoint + "/" + operation;
    const contentMd5 = crypto.createHash("md5").update(body).digest("base64");

    let attempt = 0;
    let lastErr = null;
    while (attempt <= retries) {
      if (attempt > 0) await sleep(150 * Math.pow(3, attempt - 1));
      const date = new Date().toISOString();
      const headers = {
        "x-ots-apiversion": "2015-12-31",
        "x-ots-instancename": cfg.instance,
        "x-ots-contentmd5": contentMd5,
        "x-ots-date": date,
        "x-ots-accesskeyid": cfg.accessKeyId,
        "Content-Length": body.length,
      };
      // 规范化 x-ots-* 头（签名头自身不参与），按小写名升序、换行分隔。
      const canonical = Object.keys(headers)
        .filter((k) => k.toLowerCase().startsWith("x-ots-"))
        .map((k) => k.toLowerCase())
        .sort()
        .map((k) => k + ":" + headers[Object.keys(headers).find((h) => h.toLowerCase() === k)])
        .join("\n");
      const stringToSign = "/" + operation + "\nPOST\n\n" + canonical + "\n";
      headers["x-ots-signature"] = crypto
        .createHmac("sha1", cfg.accessKeySecret)
        .update(stringToSign)
        .digest("base64");

      let res;
      try {
        res = await httpsPost(url, headers, body, timeoutMs);
      } catch (e) {
        lastErr = new OtsError("表格存储网络错误：" + ((e && e.message) || e), { retryable: true });
        attempt++;
        continue;
      }

      if (res.status === 200) return res.body;

      const text = res.body.toString("utf8");
      const parsed = parseOtsErrorXml(text);
      const requestId = res.headers["x-ots-request-id"] || res.headers["x-ots-requestid"] || "";
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new OtsError(
        "表格存储 " +
          operation +
          " 失败（HTTP " +
          res.status +
          (parsed.code ? " " + parsed.code : "") +
          (parsed.message ? "：" + parsed.message : text ? "：" + text.slice(0, 200) : "") +
          "）",
        { code: parsed.code, status: res.status, requestId, retryable },
      );
      if (!retryable) throw lastErr;
      attempt++;
    }
    throw lastErr || new OtsError("表格存储 " + operation + " 失败");
  }

  async function getRow(table, id) {
    const body = encodeGetRowRequest(table, encodePlainBufferRow(PK_NAME, String(id)));
    const resp = await call("GetRow", body);
    const fields = pbParse(resp);
    return decodePlainBufferRow(pbFieldBytes(fields, 2));
  }

  async function putRow(table, id, columns) {
    const row = encodePlainBufferRow(PK_NAME, String(id), columns);
    await call("PutRow", encodePutRowRequest(table, row));
  }

  async function deleteRow(table, id) {
    const pk = encodePlainBufferDeleteRow(PK_NAME, String(id));
    await call("DeleteRow", encodeDeleteRowRequest(table, pk));
  }

  function boundBuffer(value) {
    return encodePlainBufferRow(PK_NAME, value === null || value === undefined ? INF_MIN : value);
  }

  async function scan(table, limit) {
    const out = [];
    let start = INF_MIN;
    for (let page = 0; page < 1000; page++) {
      const body = encodeGetRangeRequest(table, boundBuffer(start), boundBuffer(INF_MAX), limit || scanLimit);
      const resp = await call("GetRange", body);
      const fields = pbParse(resp);
      const rowsBuf = pbFieldBytes(fields, 2);
      const rows = rowsBuf ? decodePlainBufferRows(rowsBuf) : [];
      for (const r of rows) out.push(r);
      const nextBuf = pbFieldBytes(fields, 3);
      const next = nextBuf ? firstPkValue(nextBuf) : null;
      if (!next || !rows.length) break;
      start = next;
    }
    return out;
  }

  function parseData(row, table) {
    if (!row || typeof row.data !== "string" || !row.data) return null;
    try {
      return JSON.parse(row.data);
    } catch (e) {
      throw new OtsError(
        "表格存储行 data 不是合法 JSON（" + (table || "account store") + "，id=" + row[PK_NAME] + "）：" + e.message,
      );
    }
  }

  const store = {
    backend: "aliyun-tablestore",
    tableNames,
    endpoint: cfg.endpoint,
    instance: cfg.instance,

    describe() {
      return {
        backend: "aliyun-tablestore",
        endpoint: cfg.endpoint,
        instance: cfg.instance,
        tablePrefix: cfg.tablePrefix,
        tables: Object.assign({}, tableNames),
      };
    },

    async ready() {
      return true;
    },

    /* ---- users ---- */

    async getUser(id) {
      const row = await getRow(tableNames.users, String(id));
      return parseData(row, tableNames.users);
    },

    async getUserByUsername(username) {
      const n = String(username || "").toLowerCase();
      const rows = await scan(tableNames.users);
      for (const row of rows) {
        const u = parseData(row, tableNames.users);
        if (u && String(u.username || "").toLowerCase() === n) return u;
      }
      return null;
    },

    async listUsers() {
      const rows = await scan(tableNames.users);
      return rows.map((r) => parseData(r, tableNames.users)).filter(Boolean);
    },

    async createUser(fields) {
      const existing = new Set((await this.listUsers()).map((u) => u.username));
      let username;
      do {
        username = newPlaceholderUsername();
      } while (existing.has(username));
      const u = makeUserRecord(Object.assign({ id: newUserId(), username }, fields || {}));
      if (!u.username) u.username = username;
      await putRow(tableNames.users, String(u.id), { data: JSON.stringify(u) });
      return u;
    },

    async updateUser(id, patch) {
      const cur = await this.getUser(id);
      if (!cur) return null;
      const next = Object.assign({}, cur, patch || {}, { id: cur.id });
      await putRow(tableNames.users, String(cur.id), { data: JSON.stringify(next) });
      return next;
    },

    async deleteUser(id) {
      const cur = await this.getUser(id);
      if (!cur) return false;
      await deleteRow(tableNames.users, String(id));
      return true;
    },

    /* ---- sessions ---- */

    async getSession(tokenHash) {
      const row = await getRow(tableNames.sessions, String(tokenHash));
      return parseData(row, tableNames.sessions);
    },

    async listSessions() {
      const rows = await scan(tableNames.sessions);
      return rows.map((r) => parseData(r, tableNames.sessions)).filter(Boolean);
    },

    async createSession(session) {
      const s = Object.assign({}, session);
      await putRow(tableNames.sessions, String(s.tokenHash), {
        data: JSON.stringify(s),
        userId: String(s.userId || ""),
        expiresAt: String(s.expiresAt || 0),
      });
      return s;
    },

    async updateSession(session) {
      const key = String(session.tokenHash);
      const cur = await getRow(tableNames.sessions, key);
      if (!cur) return null;
      const next = Object.assign({}, parseData(cur, tableNames.sessions) || {}, session, { tokenHash: key });
      await putRow(tableNames.sessions, key, {
        data: JSON.stringify(next),
        userId: String(next.userId || ""),
        expiresAt: String(next.expiresAt || 0),
      });
      return next;
    },

    async deleteSession(tokenHash) {
      const cur = await getRow(tableNames.sessions, String(tokenHash));
      if (!cur) return false;
      await deleteRow(tableNames.sessions, String(tokenHash));
      return true;
    },

    async deleteSessionsByUser(userId) {
      const rows = await scan(tableNames.sessions);
      let removed = 0;
      for (const row of rows) {
        if (String(row.userId || "") !== String(userId)) continue;
        await deleteRow(tableNames.sessions, String(row[PK_NAME]));
        removed++;
      }
      return removed;
    },

    async pruneSessions(nowTs) {
      const t = Number(nowTs) || now();
      const rows = await scan(tableNames.sessions);
      let removed = 0;
      for (const row of rows) {
        if (Number(row.expiresAt || 0) > t) continue;
        await deleteRow(tableNames.sessions, String(row[PK_NAME]));
        removed++;
      }
      return removed;
    },

    /* ---- identities ---- */

    async getIdentity(kind, value) {
      const row = await getRow(tableNames.identities, identityKey(kind, value));
      return parseData(row, tableNames.identities);
    },

    async getUserByIdentity(kind, value) {
      const e = await this.getIdentity(kind, value);
      if (!e) return null;
      return this.getUser(e.userId);
    },

    async listIdentities() {
      const rows = await scan(tableNames.identities);
      return rows.map((r) => parseData(r, tableNames.identities)).filter(Boolean);
    },

    async claimIdentity(kind, value, userId) {
      const v = String(value || "");
      if (!v) return false;
      const key = identityKey(kind, v);
      const cur = await this.getIdentity(kind, v);
      if (cur) return cur.userId === userId;
      const entry = { kind, value: v, userId, createdAt: now() };
      await putRow(tableNames.identities, key, {
        data: JSON.stringify(entry),
        provider: String(kind),
        uid: String(userId),
      });
      return true;
    },

    async releaseIdentity(kind, value, userId) {
      const key = identityKey(kind, value);
      const cur = await this.getIdentity(kind, value);
      if (!cur) return false;
      if (userId && cur.userId !== userId) return false;
      await deleteRow(tableNames.identities, key);
      return true;
    },

    async replaceIdentities(list) {
      const want = new Map();
      for (const e of Array.isArray(list) ? list : []) {
        want.set(identityKey(e.kind, e.value), {
          kind: e.kind,
          value: e.value,
          userId: e.userId,
          createdAt: e.createdAt || now(),
        });
      }
      const rows = await scan(tableNames.identities);
      for (const row of rows) {
        const id = String(row[PK_NAME]);
        if (!want.has(id)) await deleteRow(tableNames.identities, id);
      }
      for (const [key, entry] of want) {
        await putRow(tableNames.identities, key, {
          data: JSON.stringify(entry),
          provider: String(entry.kind),
          uid: String(entry.userId),
        });
      }
      return want.size;
    },
  };

  return store;
}

/* ========================================================================== *
 * 工厂
 * ========================================================================== */

/**
 * 创建账户存储实例。
 * @param {{backend?:string, dataDir?:string, dbPath?:string, config?:object,
 *          timeoutMs?:number, retries?:number, scanLimit?:number}} [options]
 */
export function createAccountStore(options = {}) {
  const backend = resolveAccountStoreBackend(options.backend);
  if (backend === "json") return createJsonAccountStore(options);
  return createTablestoreAccountStore(options);
}

export default createAccountStore;

/** 会话有效期（毫秒），与 server.mjs 一致，方便调用方构造 session。 */
export { SESSION_MS };

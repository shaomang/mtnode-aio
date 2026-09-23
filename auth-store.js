"use strict";
/* 账户凭据本机存储（见 docs/auth-design.md 第 7 节「客户端约束」）。
 *
 * - 只存 token 与账号摘要（PublicUser 白名单字段），不存密码、不存明文手机号。
 * - 优先用 Electron safeStorage 加密（DPAPI / Keychain / libsecret），
 *   加密后原子写入 %APPDATA%\pipeline-console\auth-store.json。
 * - safeStorage 不可用时降级为明文文件并给出告警（只在该机器可用，换机不通用）。
 * - 明文 token 只留在主进程内存与磁盘，**绝不回传渲染层**（不落 DOM / localStorage）。
 */

const fs = require("fs");
const path = require("path");

const FILE_NAME = "auth-store.json";
const SCHEMA = 1;
const WARN_PLAIN = "safeStorage_unavailable";

/* 允许持久化的账号摘要字段（与 docs/auth-design.md PublicUser 对齐）。 */
const USER_FIELDS = [
  "id",
  "username",
  "nickname",
  "avatar",
  "phone",
  "phoneVerified",
  "hasPassword",
  "bindings",
  "downloadsReceived",
  "likesReceived",
  "createdAt",
  "isAdmin",
];

function sanitizeUser(user) {
  if (!user || typeof user !== "object") return null;
  const out = {};
  for (const k of USER_FIELDS) {
    if (user[k] !== undefined) out[k] = user[k];
  }
  return out;
}

/* 原子写：先写同目录临时文件再 rename，避免半截 JSON。 */
function atomicWrite(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function createAuthStore(opts) {
  opts = opts || {};
  const safeStorage = opts.safeStorage || null;
  const warn = typeof opts.onWarn === "function" ? opts.onWarn : () => {};
  const dataDir =
    typeof opts.dataDir === "function"
      ? opts.dataDir
      : () => String(opts.dataDir || "");
  let plainWarned = false;

  function filePath() {
    return path.join(String(dataDir() || "."), FILE_NAME);
  }

  function encryptionAvailable() {
    try {
      return !!(
        safeStorage &&
        typeof safeStorage.isEncryptionAvailable === "function" &&
        safeStorage.isEncryptionAvailable()
      );
    } catch {
      return false;
    }
  }

  function warnPlainOnce() {
    if (plainWarned) return;
    plainWarned = true;
    warn(
      "系统加密不可用（Electron safeStorage），账户凭据将以明文保存在 " +
        filePath() +
        "，请勿在共享电脑上登录。",
    );
  }

  function readRaw() {
    try {
      return JSON.parse(fs.readFileSync(filePath(), "utf8"));
    } catch {
      return null;
    }
  }

  function decode(raw) {
    if (!raw || typeof raw !== "object") return null;
    const payload = String(raw.payload || "");
    if (!payload) return null;
    try {
      if (raw.enc === "safeStorage") {
        if (!encryptionAvailable()) return null; // 换机 / 换用户后无法解密
        const plain = safeStorage.decryptString(Buffer.from(payload, "base64"));
        return JSON.parse(plain);
      }
      if (raw.enc === "plain") {
        /* 降级模式：payload 就是明文 JSON（不假装成加密，方便用户识别风险） */
        return JSON.parse(payload);
      }
    } catch (err) {
      warn("账户凭据读取失败：" + String((err && err.message) || err));
    }
    return null;
  }

  function encode(payload) {
    const json = JSON.stringify(payload);
    if (encryptionAvailable()) {
      return {
        v: SCHEMA,
        enc: "safeStorage",
        payload: safeStorage.encryptString(json).toString("base64"),
        savedAt: Date.now(),
      };
    }
    warnPlainOnce();
    return {
      v: SCHEMA,
      enc: "plain",
      payload: json,
      savedAt: Date.now(),
      warning: WARN_PLAIN,
    };
  }

  /** 读回凭据：{ token, user, savedAt, encryption }；无有效凭据返回 null。 */
  function load() {
    const raw = readRaw();
    const data = decode(raw);
    if (!data || typeof data !== "object") return null;
    const token = typeof data.token === "string" ? data.token : "";
    if (!token) return null;
    return {
      token,
      user: sanitizeUser(data.user),
      savedAt: Number(data.savedAt || (raw && raw.savedAt) || 0) || 0,
      encryption: raw.enc === "safeStorage" ? "safeStorage" : "plain",
    };
  }

  /** 写入 token + 账号摘要（覆盖式，同一账号只保留最新会话）。 */
  function save(entry) {
    const token = String((entry && entry.token) || "");
    if (!token) return { ok: false, error: "missing_token" };
    try {
      atomicWrite(
        filePath(),
        JSON.stringify(
          encode({
            token,
            user: sanitizeUser(entry && entry.user),
            savedAt: Date.now(),
          }),
          null,
          2,
        ),
        "utf8",
      );
      return {
        ok: true,
        encryption: encryptionAvailable() ? "safeStorage" : "plain",
        warning: encryptionAvailable() ? "" : WARN_PLAIN,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /** 只更新账号摘要（token 不变），用于 /api/me、bind、unbind 回写。 */
  function updateUser(user) {
    const cur = load();
    if (!cur) return { ok: false, error: "not_logged_in" };
    return save({ token: cur.token, user });
  }

  function clear() {
    try {
      if (fs.existsSync(filePath())) fs.unlinkSync(filePath());
    } catch {}
    return { ok: true };
  }

  /** 给渲染层的状态：不含 token。 */
  function state() {
    const cur = load();
    const encryption = encryptionAvailable() ? "safeStorage" : "plain";
    if (encryption === "plain") warnPlainOnce();
    return {
      ok: true,
      loggedIn: !!cur,
      user: cur ? cur.user : null,
      savedAt: cur ? cur.savedAt : 0,
      encryption,
      warning: encryption === "plain" ? WARN_PLAIN : "",
    };
  }

  return {
    filePath,
    encryptionAvailable,
    load,
    save,
    updateUser,
    clear,
    state,
    sanitizeUser,
  };
}

module.exports = { createAuthStore, FILE_NAME, WARN_PLAIN, sanitizeUser };

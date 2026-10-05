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
const crypto = require("crypto");

const FILE_NAME = "auth-store.json";
const SCHEMA = 1;
const WARN_PLAIN = "safeStorage_unavailable";
/* 兜底加密（safeStorage 写出去却读不回来时启用）：
   机器本地随机密钥 + AES-256-GCM，密文与密钥都只在本机数据目录、权限收紧。
   为什么需要它：safeStorage 偶尔会「写得出去、读不回来」（漫游配置 / 换了加密密钥 /
   安全软件改过 DPAPI 上下文，现场见 error.log 里成片的 decryptString 失败）——
   那种机器上反复重新登录永远领不到可用凭据（写下去就解不开），必须有一条**能读回来**的路。
   代价：安全性低于系统密钥环（换机能带走），所以只在系统加密不可用时才用，并在界面提示。 */
const KEY_FILE_NAME = "auth-store.key";
const WARN_FALLBACK = "safeStorage_write_unverified";
/* 同一个「读不出来」不刷屏：同种原因最多每 10 分钟记一条日志。 */
const WARN_GAP_MS = 10 * 60 * 1000;
/* 中转 Key（独立票）的有效期与续期提前量。**有效期真源在服务端**
   （store-saas/server.mjs 的 RELAY_KEY_MS = 3650 天），这里同口径只为算「该续期了」：
   客户端没有独立票就找发放口现领一张（main.js 的 ensureRelayCredential），
   服务端另有「每次使用滑动续期」兜底。3650 天 / 6 ≈ 608 天。 */
const RELAY_KEY_MS = 3650 * 24 * 3600 * 1000;
const RELAY_RENEW_BEFORE_MS = Math.floor(RELAY_KEY_MS / 6);

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
  "balanceYuan",
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
  /* 「写下去却读不回来」这件事只说一次（同一进程里再遇到按 WARN_GAP_MS 节流） */
  let fallbackWarned = false;
  let lastWarnAt = {};
  function warnThrottled(kind, msg) {
    const now = Date.now();
    if (now - (lastWarnAt[kind] || 0) < WARN_GAP_MS) return;
    lastWarnAt[kind] = now;
    warn(msg);
  }
  /* 最近一次「读凭据失败」的原因（**只给界面显示用**，不含任何凭据内容）：
     null = 没失败过（或刚刚读成功）。界面上要能区分「没登录」与「凭据在、但这台机器
     解不开」（换 Windows 账号 / 换机器 / 加密密钥变了都会这样，见 readIssue()）。
     每次 load() 重算，不缓存历史。 */
  let lastReadIssue = null;
  /* 最近一次 save() 的结果摘要（"write_unverified" / ""）：写下去的凭据读不回来时，
     界面得说清「不是你没登录，是本机存不住凭据」——只靠 readIssue 看不出来（那时文件已隔离）。 */
  let lastWriteIssue = "";
  /* safeStorage **已被证明在本机不可靠**（写出去了、读不回来）：此后一律直接用本机密钥的
     AES-GCM 存，不再拿登录去赌系统加密。
     为什么必须有它：safeStorage 是「同一台机器上也可能写了读不回来」（漫游配置 / DPAPI
     上下文变动 / 多进程抢同一份凭据）。只靠每次 save() 的写后回读校验的话，用户每重启一次
     就要白丢一次登录（写入-隔离循环），现场表现就是「登录了还是让重新登录」。 */
  let forceAes = false;

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

  function warnFallbackOnce() {
    if (fallbackWarned) return;
    fallbackWarned = true;
    warn(
      "系统加密（Electron safeStorage）在本机写得出、读不回来（漫游配置 / 加密密钥变动 / " +
        "系统加密上下文被改过），账户凭据改用本机密钥加密保存在 " +
        filePath() +
        "（同目录的 " +
        KEY_FILE_NAME +
        "，换机需重新登录）。",
    );
  }

  /* ── 兜底加密（AES-256-GCM + 本机随机密钥）────────────────────────────
     keyPath 与凭据同目录；密钥文件只在首次需要时生成，权限尽量收紧。
     读取顺序：enc="aesgcm" 的密文用这份密钥解；密钥不在 / 被删即解不开（=需要重登）。 */
  function keyPath() {
    return path.join(String(dataDir() || "."), KEY_FILE_NAME);
  }

  function loadKey() {
    try {
      const b = Buffer.from(fs.readFileSync(keyPath(), "utf8").trim(), "base64");
      return b.length === 32 ? b : null;
    } catch {
      return null;
    }
  }

  function ensureKey() {
    const cur = loadKey();
    if (cur) return cur;
    const key = crypto.randomBytes(32);
    atomicWrite(keyPath(), key.toString("base64"), "utf8");
    try {
      fs.chmodSync(keyPath(), 0o600);
    } catch {}
    return key;
  }

  function aesEncode(json, key) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([c.update(json, "utf8"), c.final()]);
    return {
      v: SCHEMA,
      enc: "aesgcm",
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      payload: body.toString("base64"),
      savedAt: Date.now(),
      warning: WARN_FALLBACK,
    };
  }

  function aesDecode(raw) {
    const key = loadKey();
    if (!key) {
      lastReadIssue = "key_missing";
      return null;
    }
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(raw.iv || ""), "base64"));
    d.setAuthTag(Buffer.from(String(raw.tag || ""), "base64"));
    const plain = Buffer.concat([d.update(Buffer.from(String(raw.payload), "base64")), d.final()]);
    return JSON.parse(plain.toString("utf8"));
  }

  function readRaw() {
    try {
      return JSON.parse(fs.readFileSync(filePath(), "utf8"));
    } catch {
      return null;
    }
  }

  /* 解不开的凭据文件**搬走留档**（不删：出问题时用户还能把文件发回来查），
     然后当作「没登录」处理 —— 否则 load() 永远 null、界面永远让人重登（死循环：
     写下去仍然解不开，重登多少遍都没用）。搬走后重新登录会写一份新的、能读回来的凭据。 */
  function quarantine(reason) {
    const f = filePath();
    try {
      if (!fs.existsSync(f)) return "";
      const to = f + ".broken-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "") + "-" + reason;
      fs.renameSync(f, to);
      return to;
    } catch {
      return "";
    }
  }

  function decode(raw) {
    if (!raw || typeof raw !== "object") return null;
    const payload = String(raw.payload || "");
    if (!payload) return null;
    try {
      if (raw.enc === "safeStorage") {
        if (!encryptionAvailable()) {
          /* 换机 / 换用户后无法解密：这是「凭据还在、只是解不开」，与「没登录」不同 */
          lastReadIssue = "encryption_unavailable";
          return null;
        }
        const plain = safeStorage.decryptString(Buffer.from(payload, "base64"));
        return JSON.parse(plain);
      }
      if (raw.enc === "aesgcm") {
        return aesDecode(raw);
      }
      if (raw.enc === "plain") {
        /* 降级模式：payload 就是明文 JSON（不假装成加密，方便用户识别风险） */
        return JSON.parse(payload);
      }
    } catch (err) {
      /* 解不开（DPAPI 密钥变了 / 文件被别处改过）：界面据此提示「重新登录一次」。
         同时记下「本机 safeStorage 不可靠」——下次写入直接用本机密钥，别再写一份读不回来的。 */
      lastReadIssue = "decrypt_failed";
      if (raw.enc === "safeStorage") forceAes = true;
      /* 同一原因不刷屏（现场曾 2 秒一条刷了 130 条，把 error.log 完全埋掉） */
      warnThrottled("decrypt_failed", "账户凭据读取失败：" + String((err && err.message) || err));
    }
    return null;
  }

  /* 编码一份**能读回来**的凭据：
     首选系统加密（safeStorage）；写出去自检读不回来时，退回本机密钥的 AES-GCM。
     forceAes = 本机已经被证明「safeStorage 写了读不回来」，不再浪费一次登录去试。 */
  function encode(payload, opt) {
    const o = opt || {};
    const json = JSON.stringify(payload);
    /* 回退顺序（fallback = true）：本机密钥 → 系统加密 → 明文。 */
    if (o.fallback) {
      if (encryptionAvailable()) {
        try {
          const buf = safeStorage.encryptString(json);
          if (safeStorage.decryptString(buf) === json) {
            return {
              v: SCHEMA,
              enc: "safeStorage",
              payload: buf.toString("base64"),
              savedAt: Date.now(),
            };
          }
        } catch {}
      }
      return aesEncode(json, ensureKey());
    }
    if (encryptionAvailable() && !forceAes) {
      try {
        const buf = safeStorage.encryptString(json);
        if (safeStorage.decryptString(buf) === json) {
          return {
            v: SCHEMA,
            enc: "safeStorage",
            payload: buf.toString("base64"),
            savedAt: Date.now(),
          };
        }
        /* 自检不通过：这份密文写下去就是死的（本机 safeStorage 上下文有问题） */
        forceAes = true;
        warnFallbackOnce();
      } catch (err) {
        forceAes = true;
        warnFallbackOnce();
        warnThrottled(
          "safeStorage_roundtrip",
          "系统加密自检异常，改用本机密钥保存账户凭据：" + String((err && err.message) || err),
        );
      }
    } else if (!encryptionAvailable()) {
      warnPlainOnce();
    }
    return aesEncode(json, ensureKey());
  }

  /** 读回凭据：{ token, user, savedAt, encryption }；无有效凭据返回 null。
   *
   *  「凭据文件在、但解不开」这一态**必须自愈**：搬走那份死文件（留档），
   *  此后按「没登录」处理 —— 否则 load() 永远 null，界面就一直挂「重新登录一次即可领取」，
   *  而用户重登写下的新凭据同样读不回来（写后回读校验会拦住并换可读方案），
   *  用户看到的是一条永远出不去的死循环（本 bug 的现象）。 */
  function load() {
    lastReadIssue = null;
    const raw = readRaw();
    const data = decode(raw);
    if (!data || typeof data !== "object") {
      /* 文件在、内容也不是空的，却解不开：先留档再清场（readIssue 已由 decode 记下，
         供界面说清原因）。文件本身损坏 / 空的时候什么都不做。 */
      if (raw && typeof raw === "object" && String(raw.payload || "")) {
        const moved = quarantine(String(lastReadIssue || "broken"));
        if (moved) {
          warnThrottled(
            "quarantine",
            "账户凭据解不开，已移到 " +
              moved +
              " 留档（这条只进日志：界面不再给出任何凭据相关提示 ——" +
              "用户口径是这类把责任推给他的文案永久移除，凭据存不住时由本模块自己改用本机密钥重存）。",
          );
        }
      }
      return null;
    }
    const token = typeof data.token === "string" ? data.token : "";
    if (!token) return null;
    return {
      token,
      /* 中转 Key：**独立于登录 token** 的那张 180 天票（见 store-saas/server.mjs 的
         issueRelayKey）。老凭据没有它 → 回空串，由 main.js 的 providerAuthKey 退回登录
         token 兜底，下一次登录 / 打开设置时自动补上。 */
      relayKey: typeof data.relayKey === "string" ? data.relayKey : "",
      relayKeyExpiresAt: Number(data.relayKeyExpiresAt || 0) || 0,
      user: sanitizeUser(data.user),
      savedAt: Number(data.savedAt || (raw && raw.savedAt) || 0) || 0,
      encryption: raw && raw.enc === "safeStorage" ? "safeStorage" : String((raw && raw.enc) || "plain"),
    };
  }

  /** 写入 token + 账号摘要（覆盖式，同一账号只保留最新会话）。 */
  function save(entry) {
    /* 需要沿用上一份中转 Key（只改账号摘要 / 只换登录 token 时）：
       先读出来，避免覆盖式写入把独立票弄丢（弄丢的代价 = 中转请求 401）。 */
    const prev = entry && entry.relayKey === undefined ? load() : null;
    const e = Object.assign({}, entry);
    if (prev) {
      e.relayKey = prev.relayKey;
      e.relayKeyExpiresAt = prev.relayKeyExpiresAt;
    }
    entry = e;
    const token = String((entry && entry.token) || "");
    if (!token) return { ok: false, error: "missing_token" };
    try {
      const rec = encode({
        token,
        relayKey: String((entry && entry.relayKey) || ""),
        relayKeyExpiresAt: Number((entry && entry.relayKeyExpiresAt) || 0) || 0,
        user: sanitizeUser(entry && entry.user),
        savedAt: Date.now(),
      });
      atomicWrite(filePath(), JSON.stringify(rec, null, 2), "utf8");
      try {
        fs.chmodSync(filePath(), 0o600);
      } catch {}
      /* 写后回读校验：写下去的凭据**必须能读回来**，否则这次登录等于白登 ——
         界面会一直说「重新登录一次即可领取」，用户按提示重登多少遍都还是没凭据
         （现场 130 条 decryptString 失败 + 一直挂着「本机还没有中转服务凭据」就是这条）。
         读不回来就改用本机密钥的 AES-GCM 再写一次（真正治本的一步：**这一轮登录就此生效**），
         仍不通过才隔离这份死文件并如实报错。 */
      let back = decode(JSON.parse(fs.readFileSync(filePath(), "utf8")));
      let recOut = rec;
      let retried = false;
      if (!back || String(back.token || "") !== token) {
        forceAes = true;
        warnFallbackOnce();
        recOut = encode(
          {
            token,
            relayKey: String((entry && entry.relayKey) || ""),
            relayKeyExpiresAt: Number((entry && entry.relayKeyExpiresAt) || 0) || 0,
            user: sanitizeUser(entry && entry.user),
            savedAt: Date.now(),
          },
          { fallback: true },
        );
        atomicWrite(filePath(), JSON.stringify(recOut, null, 2), "utf8");
        try {
          fs.chmodSync(filePath(), 0o600);
        } catch {}
        back = decode(JSON.parse(fs.readFileSync(filePath(), "utf8")));
        retried = true;
      }
      if (!back || String(back.token || "") !== token) {
        const moved = quarantine("roundtrip");
        lastReadIssue = "write_unverified";
        lastWriteIssue = "write_unverified";
        warnThrottled(
          "write_unverified",
          "账户凭据写下去读不回来（系统加密与本机密钥都没成），已隔离留档 " + (moved || "-"),
        );
        return {
          ok: false,
          error: "write_unverified",
          encryption: recOut.enc,
          warning: WARN_FALLBACK,
          quarantined: moved || "",
          retried,
        };
      }
      lastWriteIssue = back.savedAt && recOut.enc === "safeStorage" ? "" : "save_fallback";
      return {
        ok: true,
        encryption: recOut.enc === "safeStorage" ? "safeStorage" : recOut.enc,
        warning: recOut.enc === "safeStorage" ? "" : WARN_FALLBACK,
        retried,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /** 只更新账号摘要（token 与中转 Key 都不动），用于 /api/me、bind、unbind 回写。 */
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

  /** 只丢掉那张中转 Key（账号登录会话原样留着）。
   *
   *  为什么需要它：中转数据面 401 说明**这张票**作废了（被顶掉 / 过期 / 换过账号），
   *  而账号登录会话往往还好好的 —— 发放口 /api/relay/me 认登录会话、每次都给新票。
   *  老写法在 401 时调 clear() 把整份凭据（含登录 token）一起删掉，于是「补领新票」这条
   *  路被自己掐断：用户必须重新登录一次才能再领，登录后若领票再失败就是死循环
   *  （上报症状 =「登录了还是恒 401」）。这里只清票、保住登录态，main.js 的
   *  ensureRelayCredential 就能立刻补一张新的并重试这一次请求。 */
  function clearRelayKey() {
    const cur = load();
    if (!cur) return { ok: false, error: "not_logged_in" };
    return save({
      token: cur.token,
      user: cur.user,
      relayKey: "",
      relayKeyExpiresAt: 0,
    });
  }

  /** 给渲染层的状态：不含 token。 */
  function state() {
    const cur = load();
    /* encryption 报**这份凭据实际用的方案**（"plain" / "safeStorage" / "aesgcm"）：
       本机系统加密写得出读不回来时，凭据走本机密钥的 aesgcm，界面据此给出对应提示。 */
    const encryption = cur
      ? String(cur.encryption || "")
      : encryptionAvailable()
        ? "safeStorage"
        : "plain";
    if (encryption === "plain" || encryption === "aesgcm") warnPlainOnce();
    return {
      ok: true,
      loggedIn: !!cur,
      user: cur ? cur.user : null,
      savedAt: cur ? cur.savedAt : 0,
      encryption,
      warning:
        encryption === "plain" ? WARN_PLAIN : encryption === "aesgcm" ? WARN_FALLBACK : "",
      /* 中转 Key（3650 天独立票）的状态：只给界面与续期判断用，**绝不含明文**。
         hasRelayKey = 本机有独立票；relayKeyExpiresAt = 到期时间戳；
         relayKeyRenewDue = 到了该续期的时候（剩余不足 RELAY_RENEW_BEFORE_MS）。 */
      hasRelayKey: !!(cur && cur.relayKey),
      relayKeyExpiresAt: cur ? Number(cur.relayKeyExpiresAt || 0) || 0 : 0,
      relayKeyRenewDue: !!(
        cur &&
        cur.relayKey &&
        Number(cur.relayKeyExpiresAt || 0) > 0 &&
        Number(cur.relayKeyExpiresAt) - Date.now() <= RELAY_RENEW_BEFORE_MS
      ),
      /* 凭据解不开的原因（"decrypt_failed" / "encryption_unavailable"；没失败就是 null）：
         界面据此把「没登录」和「凭据在手却解不开」分开说。不含任何凭据内容。 */
      readIssue: lastReadIssue,
      /* 最近一次写入的坏消息（"write_unverified" = 写下去读不回来，已隔离再存；
         "save_fallback" = 退回本机密钥加密存下了，能读回来）。 */
      writeIssue: lastWriteIssue,
    };
  }

  return {
    filePath,
    encryptionAvailable,
    load,
    save,
    updateUser,
    clear,
    clearRelayKey,
    state,
    sanitizeUser,
    /* 中转 Key 的两个专用入口（main.js 的 providerAuthKey / relay:keyInfo / relay:me 用）：
       真值只经主进程内存过一手，绝不回渲染层。 */
    relayKey: () => {
      const cur = load();
      return cur ? String(cur.relayKey || "") : "";
    },
    setRelayKey: (relayKey, expiresAt) => {
      const cur = load();
      if (!cur) return { ok: false, error: "not_logged_in" };
      return save({
        token: cur.token,
        user: cur.user,
        relayKey: String(relayKey || ""),
        relayKeyExpiresAt: Number(expiresAt) || 0,
      });
    },
    /* 中转 Key 续期窗口（毫秒）：main.js 的 relay:keyInfo / relay:me 判「该续期了」用它，
       与 setRelayKey 落在同一份常量上（少一处手抄就会两边口径不一致）。 */
    relayRenewBeforeMs: () => RELAY_RENEW_BEFORE_MS,
    /* 最近一次 load() 的失败原因（不含凭据内容）：给「设置 · 提供商」的中转卡说清
       「为什么没有可用凭据」用 —— 与 state().readIssue 同一口径 */
    readIssue: () => lastReadIssue,
    /* 最近一次 save() 的坏消息（"write_unverified" / "save_fallback" / ""）：登录后
       凭据其实没落住时，界面要说清是哪一步坏了（见 main.js 的 relay:keyInfo）。 */
    writeIssue: () => lastWriteIssue,
  };
}

module.exports = { createAuthStore, FILE_NAME, KEY_FILE_NAME, WARN_PLAIN, WARN_FALLBACK, sanitizeUser };

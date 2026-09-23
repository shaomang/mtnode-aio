"use strict";
/**
 * MTNode 创意工坊 — 短信验证码发送适配层（零依赖，仅 node:https / node:crypto）。
 *
 * 契约见 docs/auth-design.md 第 5.7 / 8 / 9 节。本文件只负责「把验证码交给服务商」，
 * 频控、验证码存储与校验即焚由 server.mjs 负责。
 *
 * 环境变量（凭据只进服务器环境变量，一律不入库、不提交）：
 *   MTNODE_SMS_PROVIDER   aliyun | tencent | console（未设置 = console 开发模式）
 *   —— 阿里云（阿里云短信 SendSms，RPC 签名 HMAC-SHA1）——
 *   MTNODE_SMS_ACCESS_KEY_ID / MTNODE_SMS_ACCESS_KEY_SECRET
 *   MTNODE_SMS_SIGN_NAME
 *   MTNODE_SMS_TEMPLATE_CODE            （通用模板，场景变量 ${code}）
 *   MTNODE_SMS_TEMPLATE_CODE_BIND       （可选，scene=bind 专用模板）
 *   MTNODE_SMS_REGION_ID                （可选，默认 cn-hangzhou）
 *   —— 腾讯云（SMS SendSms，TC3-HMAC-SHA256 签名）——
 *   MTNODE_SMS_SECRET_ID / MTNODE_SMS_SECRET_KEY
 *   MTNODE_SMS_SDK_APP_ID / MTNODE_SMS_SIGN_NAME
 *   MTNODE_SMS_TEMPLATE_ID              （通用模板，参数列表第 1 位为验证码）
 *   MTNODE_SMS_TEMPLATE_ID_BIND         （可选，scene=bind 专用模板）
 *   MTNODE_SMS_REGION                   （可选，默认 ap-guangzhou）
 *
 * 未配置服务商凭据时 `smsProviderStatus().configured === false`，服务端据此返回
 * `503 SMS_UNAVAILABLE`；只有 console 模式会把验证码打到服务端日志（仅供本机开发）。
 */
import crypto from "node:crypto";
import https from "node:https";

const HTTP_TIMEOUT_MS = 10_000;
const SMS_CODE_TTL_MS = 5 * 60 * 1000;

/** 验证码有效期（毫秒），与 docs/auth-design.md「5 分钟有效」一致。 */
export { SMS_CODE_TTL_MS };

function pick(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function maskPhone(phone) {
  const m = /^\+86(\d{11})$/.exec(String(phone || ""));
  if (!m) return "***";
  return "+86 " + m[1].slice(0, 3) + "****" + m[1].slice(7);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

// 阿里云 RPC 规范的 percentEncode（官方 Node 示例口径）。
function percentEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

function httpsJson({ host, path: reqPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path: reqPath || "/", method: method || "POST", headers: headers || {}, timeout: HTTP_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("短信服务请求超时")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 日志脱敏：11 位手机号打码（凭据本身从不进日志）。 */
function redact(text) {
  return String(text == null ? "" : text).replace(/1[3-9]\d{9}/g, (m) => m.slice(0, 3) + "****" + m.slice(7));
}

/** 服务商 HTTP 非 200 时，响应体可能是 XML（如 `<Code>NoPermission</Code>`），从中取错误码。 */
function xmlCode(text) {
  const m = /<Code>([^<]+)<\/Code>/i.exec(String(text || ""));
  return m ? m[1] : "";
}

/**
 * 把服务商错误码归一到 MTNode 可诊断 code（口径见 docs/auth-aliyun-guide.md §5.2 / §8）。
 * 仅用于服务端日志与失败响应体，不改变成功响应结构。
 */
function classifyProviderError(providerCode, httpStatus) {
  const low = String(providerCode || "").trim().toLowerCase();
  if (httpStatus === 403 || /nopermission|forbidden|permissiondenied|ram_permission_deny|invalidaccesskeyid|signaturedoesnotmatch|isp\.ram/.test(low)) {
    return "SMS_PROVIDER_DENIED";
  }
  if (/signature|sign_not_exist|sign_illegal/.test(low)) return "SMS_SIGNATURE_ILLEGAL";
  if (/template|invalid_json_param|content_illegal/.test(low)) return "SMS_TEMPLATE_MISMATCH";
  if (/amount_not_enough|out_of_service|account_abnormal|product_unsubscribe|arrearage|insufficientbalance/.test(low)) {
    return "SMS_ACCOUNT_UNAVAILABLE";
  }
  if (/limit|frequen/.test(low)) return "SMS_RATE_LIMITED";
  if (/number_illegal|phone/.test(low)) return "SMS_PHONE_ILLEGAL";
  return "SMS_PROVIDER_ERROR";
}

/**
 * 发送失败：日志打印服务商返回的 Code/Message（脱敏），并回传可诊断 code。
 * @param {string} reason 服务商原始错误（可能含 Code/Message）
 * @param {{ providerCode?: string, httpStatus?: number, code?: string }} [extra]
 */
function fail(reason, extra) {
  const providerCode = (extra && extra.providerCode) || "";
  const httpStatus = (extra && extra.httpStatus) || 0;
  const code = (extra && extra.code) || classifyProviderError(providerCode, httpStatus);
  console.error("[sms] send failed: " + redact(reason) + " [code=" + code + "]");
  return { ok: false, status: 503, code, error: "短信发送失败，请稍后重试" };
}

/* ---------- 服务商解析 ---------- */

function resolveProvider() {
  const raw = pick("MTNODE_SMS_PROVIDER").toLowerCase();

  if (!raw || raw === "console") {
    return { id: "console", dev: true, configured: true, missing: [] };
  }

  if (raw === "aliyun") {
    const keyId = pick("MTNODE_SMS_ACCESS_KEY_ID", "MTNODE_SMS_KEY_ID", "MTNODE_SMS_KEY");
    const keySecret = pick("MTNODE_SMS_ACCESS_KEY_SECRET", "MTNODE_SMS_KEY_SECRET", "MTNODE_SMS_SECRET");
    const signName = pick("MTNODE_SMS_SIGN_NAME", "MTNODE_SMS_SIGN");
    const tplLogin = pick("MTNODE_SMS_TEMPLATE_CODE_LOGIN", "MTNODE_SMS_TEMPLATE_CODE");
    const tplBind = pick("MTNODE_SMS_TEMPLATE_CODE_BIND", "MTNODE_SMS_TEMPLATE_CODE_LOGIN", "MTNODE_SMS_TEMPLATE_CODE");
    const missing = [];
    if (!keyId) missing.push("MTNODE_SMS_ACCESS_KEY_ID");
    if (!keySecret) missing.push("MTNODE_SMS_ACCESS_KEY_SECRET");
    if (!signName) missing.push("MTNODE_SMS_SIGN_NAME");
    if (!tplLogin) missing.push("MTNODE_SMS_TEMPLATE_CODE");
    return {
      id: "aliyun",
      dev: false,
      configured: missing.length === 0,
      missing,
      error: missing.length ? "短信服务未配置（缺少 " + missing.join(" / ") + "）" : "",
      keyId,
      keySecret,
      signName,
      tplLogin,
      tplBind: tplBind || tplLogin,
    };
  }

  if (raw === "tencent") {
    const secretId = pick("MTNODE_SMS_SECRET_ID", "MTNODE_SMS_ACCESS_KEY_ID", "MTNODE_SMS_KEY_ID");
    const secretKey = pick("MTNODE_SMS_SECRET_KEY", "MTNODE_SMS_ACCESS_KEY_SECRET", "MTNODE_SMS_SECRET");
    const sdkAppId = pick("MTNODE_SMS_SDK_APP_ID", "MTNODE_SMS_APP_ID");
    const signName = pick("MTNODE_SMS_SIGN_NAME", "MTNODE_SMS_SIGN");
    const tplLogin = pick("MTNODE_SMS_TEMPLATE_ID_LOGIN", "MTNODE_SMS_TEMPLATE_ID");
    const tplBind = pick("MTNODE_SMS_TEMPLATE_ID_BIND", "MTNODE_SMS_TEMPLATE_ID_LOGIN", "MTNODE_SMS_TEMPLATE_ID");
    const missing = [];
    if (!secretId) missing.push("MTNODE_SMS_SECRET_ID");
    if (!secretKey) missing.push("MTNODE_SMS_SECRET_KEY");
    if (!sdkAppId) missing.push("MTNODE_SMS_SDK_APP_ID");
    if (!signName) missing.push("MTNODE_SMS_SIGN_NAME");
    if (!tplLogin) missing.push("MTNODE_SMS_TEMPLATE_ID");
    return {
      id: "tencent",
      dev: false,
      configured: missing.length === 0,
      missing,
      error: missing.length ? "短信服务未配置（缺少 " + missing.join(" / ") + "）" : "",
      secretId,
      secretKey,
      sdkAppId,
      signName,
      tplLogin,
      tplBind: tplBind || tplLogin,
    };
  }

  return {
    id: raw,
    dev: false,
    configured: false,
    missing: [],
    error: "未知的短信服务商：" + raw,
  };
}

/** 供启动日志 / 健康检查使用，绝不返回凭据。 */
export function smsProviderStatus() {
  const p = resolveProvider();
  return { id: p.id, configured: p.configured, dev: p.dev, missing: p.missing.slice() };
}

/* ---------- 阿里云 ---------- */

async function sendAliyun(p, { phone, code, scene }) {
  const params = {
    AccessKeyId: p.keyId,
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: phone.replace(/^\+86/, ""),
    RegionId: pick("MTNODE_SMS_REGION_ID") || "cn-hangzhou",
    SignName: p.signName,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    TemplateCode: scene === "bind" ? p.tplBind : p.tplLogin,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-05-25",
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => percentEncode(k) + "=" + percentEncode(params[k]))
    .join("&");
  const stringToSign = "POST&" + percentEncode("/") + "&" + percentEncode(query);
  const signature = crypto.createHmac("sha1", p.keySecret + "&").update(stringToSign).digest("base64");
  const body = "Signature=" + percentEncode(signature) + "&" + query;

  const r = await httpsJson({
    host: "dysmsapi.aliyuncs.com",
    path: "/",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
  const j = r.json || {};
  const pcode = j.Code || xmlCode(r.text);
  if (r.status !== 200) {
    return fail(
      "aliyun HTTP " + r.status + " " + (pcode || "") + " " + (j.Message || r.text.slice(0, 200)),
      { providerCode: pcode, httpStatus: r.status },
    );
  }
  if (String(pcode || "").toUpperCase() !== "OK") {
    return fail("aliyun " + (pcode || "") + " " + (j.Message || r.text.slice(0, 200)), {
      providerCode: pcode,
      httpStatus: r.status,
    });
  }
  return { ok: true, provider: "aliyun", requestId: j.RequestId || "" };
}

/* ---------- 腾讯云 ---------- */

async function sendTencent(p, { phone, code, scene }) {
  const host = "sms.tencentcloudapi.com";
  const service = "sms";
  const action = "SendSms";
  const version = "2021-01-11";
  const region = pick("MTNODE_SMS_REGION") || "ap-guangzhou";
  const payload = JSON.stringify({
    PhoneNumberSet: [phone],
    SmsSdkAppId: p.sdkAppId,
    SignName: p.signName,
    TemplateId: scene === "bind" ? p.tplBind : p.tplLogin,
    TemplateParamSet: [String(code)],
  });

  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalHeaders =
    "content-type:" + contentType + "\n" + "host:" + host + "\n" + "x-tc-action:" + action.toLowerCase() + "\n";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join("\n");
  const credentialScope = date + "/" + service + "/tc3_request";
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(ts),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac("TC3" + p.secretKey, date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, "tc3_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization =
    "TC3-HMAC-SHA256 Credential=" +
    p.secretId +
    "/" +
    credentialScope +
    ", SignedHeaders=" +
    signedHeaders +
    ", Signature=" +
    signature;

  const r = await httpsJson({
    host,
    path: "/",
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      Host: host,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(ts),
      "X-TC-Version": version,
      "X-TC-Region": region,
      "Content-Length": Buffer.byteLength(payload),
    },
    body: payload,
  });
  const resp = (r.json && r.json.Response) || {};
  if (resp.Error) {
    return fail("tencent " + (resp.Error.Code || "") + " " + (resp.Error.Message || ""), {
      providerCode: resp.Error.Code,
      httpStatus: r.status,
    });
  }
  const first = (resp.SendStatusSet || [])[0] || {};
  if (r.status !== 200 || String(first.Code || "") !== "Ok") {
    return fail(
      "tencent " + (first.Code || "HTTP " + r.status) + " " + (first.Message || r.text.slice(0, 200)),
      { providerCode: first.Code || "HTTP " + r.status, httpStatus: r.status },
    );
  }
  return { ok: true, provider: "tencent", requestId: resp.RequestId || "" };
}

/* ---------- 对外入口 ---------- */

/**
 * 发送验证码。
 * @param {{ phone: string, code: string, scene?: "login" | "bind" }} input
 *   phone 为规范化后的 `+86` + 11 位手机号（明文只在服务端内部与本函数内出现）。
 * @returns {Promise<{ ok: boolean, provider?: string, requestId?: string, status?: number, code?: string, error?: string }>}
 *   失败时 `status` / `code` / `error` 可直接回给客户端（见 docs/auth-design.md 错误码表）。
 */
export async function sendSmsCode({ phone, code, scene }) {
  const p = resolveProvider();
  if (!p.configured) {
    return { ok: false, status: 503, code: "SMS_UNAVAILABLE", error: p.error || "短信服务未配置" };
  }
  const sc = scene === "bind" ? "bind" : "login";
  try {
    if (p.id === "console") {
      console.log(
        "[sms:console] 开发模式验证码 " +
          maskPhone(phone) +
          " -> " +
          code +
          "（scene=" +
          sc +
          "，仅本机开发；生产必须配置 MTNODE_SMS_PROVIDER 与 MTNODE_SMS_* 凭据）",
      );
      return { ok: true, provider: "console" };
    }
    if (p.id === "aliyun") return await sendAliyun(p, { phone, code, scene: sc });
    if (p.id === "tencent") return await sendTencent(p, { phone, code, scene: sc });
    return { ok: false, status: 503, code: "SMS_UNAVAILABLE", error: "未知的短信服务商：" + p.id };
  } catch (e) {
    return fail((e && e.message) || String(e));
  }
}

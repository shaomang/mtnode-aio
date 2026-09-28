"use strict";
/**
 * MTNode 创意工坊 — 支付宝「当面付」适配层（零依赖，仅 node:crypto / node:https）。
 *
 * 口径与 sms-provider.mjs 一致：本文件只负责「和支付宝说话」，订单 / 余额 / 流水账本
 * 由 wallet.mjs 负责，路由与鉴权由 server.mjs 负责。凭据只从环境变量读，
 * **绝不入库、不提交、不进日志**（日志里 appid 只留前 4 后 4）。
 *
 * 环境变量（写在服务器 /etc/mtnode-store.env，600 权限）：
 *   MTNODE_ALIPAY_APPID            开放平台应用 appid（需签约对应支付产品，见 alipay-probe.mjs）
 *   MTNODE_ALIPAY_PRIVATE_KEY      应用私钥：PKCS8 / PKCS1 的 base64（可带 PEM 头尾与换行）
 *   MTNODE_ALIPAY_PRIVATE_KEY_PATH 可选：私钥文件绝对路径（与上一项二选一，文件优先）
 *   MTNODE_ALIPAY_PUBLIC_KEY       支付宝公钥（验接口响应与异步通知签名）
 *   MTNODE_ALIPAY_PUBLIC_KEY_PATH  可选：支付宝公钥文件绝对路径
 *   MTNODE_ALIPAY_CHANNEL          可选，支付通道：page（默认，电脑网站支付 = 浏览器收银台）
 *                                  / precreate（当面付 = 服务端出 qr_code，窗内自绘二维码）。
 *                                  线上实测该 APPID 只签约了网站支付，当面付回 ACQ.ACCESS_FORBIDDEN，
 *                                  所以默认 page；哪天签约了当面付，改这个键重启即可，代码不用动。
 *   MTNODE_ALIPAY_GATEWAY          可选，默认 https://openapi.alipay.com/gateway.do
 *                                  （沙箱：https://openapi-sandbox.dl.alipaydev.com/gateway.do）
 *                                  ⚠ 生产网关只有 /gateway.do 这一个；/router/rest 是网页端地址，
 *                                  POST 过去会被 302 到 auth.alipay.com 登录页（已实测踩过）。
 *   MTNODE_ALIPAY_NOTIFY_URL       可选，异步通知地址（公网可达、必须 www 域名），如
 *                                  https://www.mt-agent.com/mtnode/store-api/api/pay/alipay/notify
 *   MTNODE_ALIPAY_RETURN_URL       可选，page 通道的同步跳回地址（浏览器跳转，会跟随 301），如
 *                                  https://www.mt-agent.com/mtnode/pay-done/
 *   MTNODE_ALIPAY_TIMEOUT          可选，HTTP 超时毫秒，默认 10000
 *
 * 未配齐 appid / 私钥 / 支付宝公钥时 `alipayStatus().configured === false`，
 * 服务端据此返回 `503 ALIPAY_UNAVAILABLE`（不留任何 mock / 假支付后门）。
 *
 * 用到的接口：
 *   alipay.trade.page.pay   电脑网站支付 → 不调接口，只生成签好名的收银台跳转 URL（alipayPagePayUrl）
 *   alipay.trade.precreate  当面付预下单 → 返回 qr_code（付款串，需自行画成二维码，见 qr-encode.mjs）
 *   alipay.trade.query      查交易（轮询兜底 / 手动补单）—— 两个通道共用
 *   alipay.trade.close      关单（订单超时）
 *   alipay.trade.refund     退款（支持按 out_request_no 逐笔部分退）
 *
 * 交易状态 trade_status：
 *   WAIT_BUYER_PAY  等待买家付款（视为未支付）
 *   TRADE_SUCCESS   支付成功（可入账）
 *   TRADE_FINISHED  交易完结（不可退，仍视为已支付）
 *   TRADE_CLOSED    未付款超时关闭 / 全额退款后关闭
 */
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";

const DEFAULT_GATEWAY = "https://openapi.alipay.com/gateway.do";
const DEFAULT_TIMEOUT_MS = 10_000;
const SIGN_TYPE = "RSA2"; // 固定 RSA2（SHA256withRSA），支付宝当面付唯一推荐
const API_VERSION = "1.0";
const CHARSET = "utf-8";

/* ---------- 环境变量读取（凭据只进内存） ---------- */

function pick(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 读文件型凭据：路径存在才读，读失败按未配置处理（不抛，交给 status().missing 报告）。 */
function pickFile(envPath, envInline) {
  const p = pick(envPath);
  if (p) {
    try {
      const text = fs.readFileSync(p, "utf8").trim();
      if (text) return text;
    } catch (e) {
      console.error("[alipay] 读取凭据文件失败 " + p + "：" + ((e && e.message) || e));
      return "";
    }
  }
  return pick(envInline);
}

/** 把裸 base64 补成 PEM；已是 PEM 就原样返回（同时把 CRLF / 空格归一）。 */
function toPem(raw, kind) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("-----BEGIN")) return s.replace(/\r\n/g, "\n");
  const body = s.replace(/[\r\n\s]+/g, "");
  const lines = body.match(/.{1,64}/g) || [];
  return "-----BEGIN " + kind + "-----\n" + lines.join("\n") + "\n-----END " + kind + "-----\n";
}

function resolveConfig() {
  const privateRaw = pickFile("MTNODE_ALIPAY_PRIVATE_KEY_PATH", "MTNODE_ALIPAY_PRIVATE_KEY");
  const publicRaw = pickFile("MTNODE_ALIPAY_PUBLIC_KEY_PATH", "MTNODE_ALIPAY_PUBLIC_KEY");
  const appId = pick("MTNODE_ALIPAY_APPID", "MTNODE_ALIPAY_APP_ID");
  const missing = [];
  if (!appId) missing.push("MTNODE_ALIPAY_APPID");
  if (!privateRaw) missing.push("MTNODE_ALIPAY_PRIVATE_KEY");
  if (!publicRaw) missing.push("MTNODE_ALIPAY_PUBLIC_KEY");

  let privateKey = null;
  let publicKey = null;
  let keyError = "";
  if (privateRaw) {
    try {
      // 支付宝导出的一般是 PKCS8（BEGIN PRIVATE KEY）；老格式 PKCS1 也能被自动识别。
      const pem = toPem(privateRaw, "PRIVATE KEY");
      privateKey = crypto.createPrivateKey(pem);
    } catch (e) {
      keyError = "应用私钥解析失败：" + ((e && e.message) || e);
    }
  }
  if (publicRaw) {
    try {
      const pem = toPem(publicRaw, "PUBLIC KEY");
      publicKey = crypto.createPublicKey(pem);
    } catch (e) {
      keyError = (keyError ? keyError + "；" : "") + "支付宝公钥解析失败：" + ((e && e.message) || e);
    }
  }
  return {
    appId,
    privateKey,
    publicKey,
    keyError,
    gateway: pick("MTNODE_ALIPAY_GATEWAY") || DEFAULT_GATEWAY,
    notifyUrl: pick("MTNODE_ALIPAY_NOTIFY_URL"),
    returnUrl: pick("MTNODE_ALIPAY_RETURN_URL"),
    channel: normalizeChannel(pick("MTNODE_ALIPAY_CHANNEL")),
    timeoutMs: Number(pick("MTNODE_ALIPAY_TIMEOUT")) || DEFAULT_TIMEOUT_MS,
    missing,
  };
}

/**
 * 支付通道：`page`（电脑网站支付 alipay.trade.page.pay，浏览器收银台）
 * 或 `precreate`（当面付扫码，服务端自绘二维码）。默认 `page`。
 *
 * 为什么默认不是扫码：线上实测该 APPID 已签约「电脑网站支付 / 手机网站支付」，
 * 但**没有签约「当面付」**，`alipay.trade.precreate` 一律回 `40004 ACQ.ACCESS_FORBIDDEN`
 * （见 docs/recharge-design.md §9.3 的产品签约实测表）。哪天签约了，把
 * `MTNODE_ALIPAY_CHANNEL=precreate` 写进 /etc/mtnode-store.env 重启即可换回窗内扫码，代码不用动。
 */
export function normalizeChannel(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "precreate" || s === "f2f" || s === "qr") return "precreate";
  if (s === "page" || s === "wap" || s === "") return "page";
  return "page";
}

/**
 * 同步跳回地址（return_url）体检：这是**浏览器**跳转，会跟随 301，所以 apex 域名不算致命
 * （与 notify_url 的口径不同 —— 那个是支付宝服务端直连 POST，不跟随重定向会丢通知）。
 * 这里只拦真正会出问题的：非 https、本机地址、指回应用内不存在的页面。
 * 返回空串 = 没问题。
 */
export function returnWarning(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (!/^https:\/\//i.test(u)) return "同步跳回地址必须是公网 https（浏览器要从支付宝跳回来）：" + u;
  if (/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(u) || /\.local\//i.test(u)) {
    return "同步跳回地址是本机地址，用户的浏览器跳不回来（付款仍会由 notify/轮询入账）：" + u;
  }
  return "";
}

/**
 * 异步通知地址体检：支付宝的 notify 是**服务端直连 POST，且不跟随 301/302**，
 * 填错域名（例如 apex 被 nginx 301 到 www）会「支付成功但收不到通知」，只能靠轮询兜底。
 * 返回空串 = 没问题；否则是一句能直接照改的中文提示（不含凭据，可进健康检查）。
 */
export function notifyWarning(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (!/^https:\/\//i.test(u)) return "异步通知地址必须是公网 https（支付宝不走 http）：" + u;
  if (/^https:\/\/mt-agent\.com\//i.test(u)) {
    return "apex 域名被 nginx 301 到 www，支付宝不跟随重定向会丢通知 → 改用 " +
      "https://www.mt-agent.com/mtnode/store-api/api/pay/alipay/notify";
  }
  if (/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(u) || /\.local\//i.test(u)) {
    return "异步通知地址是本机地址，支付宝回调不到（只能靠轮询兜底）：" + u;
  }
  if (!/\/api\/pay\/alipay\/notify\/?$/i.test(u)) return "异步通知地址路径不像本服务的 notify 端点（应以 /api/pay/alipay/notify 结尾）：" + u;
  return "";
}

/**
 * 网关地址体检：支付宝开放平台的生产网关只有 `https://openapi.alipay.com/gateway.do`。
 * 写成 `/router/rest`（那是网页端地址）不会报错，而是被 302 到 auth.alipay.com 登录页，
 * 表现为「所有接口都 HTTP 302、空响应体」——极难猜，所以在配置摘要里直接点名。
 * 返回空串 = 没问题；否则是一句能直接照改的中文提示。
 */
export function gatewayWarning(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  let p;
  try { p = new URL(u); } catch { return "网关地址不是合法 URL：" + u; }
  if (p.protocol !== "https:") return "网关必须走 https：" + u;
  if (!/(^|\.)alipay\.com$|(^|\.)alipaydev\.com$/i.test(p.hostname)) {
    return "网关域名不像支付宝官方（应为 openapi.alipay.com，沙箱 openapi-sandbox.dl.alipaydev.com）：" + p.hostname;
  }
  if (!/^\/gateway\.do\/?$/i.test(p.pathname)) {
    return "支付宝网关路径应是 /gateway.do（当前 " + p.pathname + " 会被 302 到登录页）→ " +
      (/alipaydev/i.test(p.hostname)
        ? "https://openapi-sandbox.dl.alipaydev.com/gateway.do"
        : "https://openapi.alipay.com/gateway.do");
  }
  return "";
}

/** 配置摘要（不含任何密钥材料）：供启动日志与健康检查。 */
export function alipayStatus() {
  const c = resolveConfig();
  const configured = !c.missing.length && !!c.privateKey && !!c.publicKey;
  return {
    configured,
    missing: configured ? [] : c.missing.concat(c.keyError ? ["KEY_PARSE_ERROR"] : []),
    appId: maskAppId(c.appId),
    gateway: c.gateway,
    gatewayWarning: gatewayWarning(c.gateway),
    sandbox: /sandbox|alipaydev/i.test(c.gateway),
    channel: c.channel,
    hasNotifyUrl: !!c.notifyUrl,
    notifyWarning: notifyWarning(c.notifyUrl),
    hasReturnUrl: !!c.returnUrl,
    returnWarning: returnWarning(c.returnUrl),
    keyError: c.keyError,
    signType: SIGN_TYPE,
  };
}

function maskAppId(id) {
  const s = String(id || "");
  if (s.length <= 8) return s ? "****" : "";
  return s.slice(0, 4) + "****" + s.slice(-4);
}

/* ---------- 签名与验签 ---------- */

/** 待签串：按 key 的 ASCII 升序拼 k=v，跳过空值与 sign 本身（支付宝官方口径）。 */
export function buildSignContent(params) {
  return Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => k + "=" + params[k])
    .join("&");
}

function rsaSign(content, privateKey) {
  return crypto.createSign("RSA-SHA256").update(content, "utf8").sign(privateKey, "base64");
}

function rsaVerify(content, signB64, publicKey) {
  try {
    return crypto.createVerify("RSA-SHA256").update(content, "utf8").verify(publicKey, String(signB64), "base64");
  } catch (e) {
    console.error("[alipay] 验签异常：" + ((e && e.message) || e));
    return false;
  }
}

/**
 * 异步通知验签：params 为 form 解析后的键值对象；剔除 sign / sign_type 后按同一规则拼串验签。
 * 通知里的 gmt_* 时间戳等字段原样参与签名，绝不能先解码再重编码。
 */
export function alipayVerifyNotify(params, publicKeyOverride) {
  const c = publicKeyOverride ? { publicKey: publicKeyOverride } : resolveConfig();
  if (!c.publicKey) return false;
  const p = Object.assign({}, params);
  const sign = String(p.sign || "");
  delete p.sign;
  delete p.sign_type;
  if (!sign) return false;
  return rsaVerify(buildSignContent(p), sign, c.publicKey);
}

/**
 * 从响应原文里切出被签名的那段 JSON（`"<respKey>":{…}` 的值部分），再验 sign。
 * 支付宝签的是**原文子串**，不能重新 JSON.stringify（键顺序 / 空格会变），
 * 所以这里用括号配对扫描，字符串内的花括号与转义都跳过。
 */
export function verifyResponseSign(text, respKey, publicKey) {
  const raw = String(text || "");
  const anchor = '"' + respKey + '"';
  const ai = raw.indexOf(anchor);
  if (ai < 0) return { ok: false, reason: "响应缺少 " + anchor };
  let i = raw.indexOf("{", ai + anchor.length);
  if (i < 0) return { ok: false, reason: "响应体不是 JSON 对象" };
  const start = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const content = raw.slice(start, i);
  const sm = /"sign"\s*:\s*"([^"]*)"/.exec(raw.slice(i));
  if (!sm) return { ok: false, reason: "响应缺少 sign 字段", content };
  const ok = rsaVerify(content, sm[1], publicKey);
  return { ok, reason: ok ? "" : "响应签名校验失败", content };
}

/* ---------- HTTP ---------- */

/** 支付宝时间戳必须是东八区 `yyyy-MM-dd HH:mm:ss`；服务器 TZ 无关（手动偏移）。 */
export function alipayTimestamp(d) {
  const t = d ? new Date(d) : new Date();
  return new Date(t.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function postForm(target, formText, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(target);
    } catch (e) {
      reject(new Error("网关地址无效"));
      return;
    }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: (u.pathname || "/") + (u.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=" + CHARSET,
          "Content-Length": Buffer.byteLength(formText),
          Accept: "application/json",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("支付宝接口请求超时")));
    req.on("error", reject);
    req.write(formText);
    req.end();
  });
}

/** 金额：分 → "1.00" 字符串（支付宝要求两位小数的元）。 */
export function centsToYuan(cents) {
  const n = Math.round(Number(cents) || 0);
  return (Math.floor(Math.abs(n) / 100) * (n < 0 ? -1 : 1)).toString() + "." + String(Math.abs(n) % 100).padStart(2, "0");
}

/** 金额："1.00" 元 → 分（非法输入返回 NaN）。 */
export function yuanToCents(text) {
  const m = /^-?(\d+)(?:\.(\d{1,2}))?$/.exec(String(text == null ? "" : text).trim());
  if (!m) return NaN;
  const neg = String(text).trim().startsWith("-");
  const frac = String(m[2] || "").padEnd(2, "0").slice(0, 2);
  const v = Number(m[1]) * 100 + Number(frac);
  return neg ? -v : v;
}

/* ---------- 接口调用 ---------- */

/**
 * 统一调用入口：拼公共参数 → 签名 → POST → 验签 → 取 `<method 下划线形式>_response`。
 * @returns {Promise<{ok:boolean, code?:string, subCode?:string, subMsg?:string, msg?:string, data?:object, raw?:string, error?:string}>}
 */
/**
 * 拼公共参数并签名（POST 型接口与 GET 跳转型接口共用同一份口径，别各写一遍）。
 * @param {{appId:string,privateKey:object,notifyUrl:string,returnUrl:string}} c resolveConfig() 结果
 * @param {string} method 接口名
 * @param {object} bizContent 业务参数
 * @param {{notify?:boolean, returnUrl?:boolean}} [o] notify=false 不带异步通知地址（退款就是）
 */
export function signedParams(c, method, bizContent, o) {
  const opt = o || {};
  const params = {
    app_id: c.appId,
    method,
    format: "JSON",
    charset: CHARSET,
    sign_type: SIGN_TYPE,
    timestamp: alipayTimestamp(),
    version: API_VERSION,
    biz_content: JSON.stringify(bizContent || {}),
  };
  if (c.notifyUrl && opt.notify !== false) params.notify_url = c.notifyUrl;
  // return_url 只对「页面跳转类」接口有意义（page.pay / wap.pay），POST 型接口带了会被忽略。
  if (c.returnUrl && opt.returnUrl) params.return_url = c.returnUrl;
  params.sign = rsaSign(buildSignContent(params), c.privateKey);
  return params;
}

/** 参数对象 → application/x-www-form-urlencoded 串（POST 体与 GET query 同一份编码）。 */
export function toFormText(params) {
  return Object.keys(params)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");
}

async function callAlipay(method, bizContent, opts) {
  const c = resolveConfig();
  const o = opts || {};
  if (!c.appId || !c.privateKey || !c.publicKey) {
    return { ok: false, code: "ALIPAY_UNAVAILABLE", error: "支付宝未配置或密钥无效" + (c.keyError ? "：" + c.keyError : "") };
  }
  const params = signedParams(c, method, bizContent, o);
  const formText = toFormText(params);

  let res;
  try {
    res = await postForm(c.gateway, formText, c.timeoutMs);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.error("[alipay] " + method + " 网络失败：" + msg);
    return { ok: false, code: "ALIPAY_NETWORK", error: "支付宝接口网络失败：" + msg };
  }
  if (o.rawText) return { ok: true, raw: res.text, status: res.status };
  if (res.status !== 200) {
    // 3xx = 打到的不是 API 网关（实测 /router/rest 会 302 到 auth.alipay.com 登录页，响应体为空）。
    const hint = res.status >= 300 && res.status < 400
      ? "（网关地址不对：支付宝生产网关是 https://openapi.alipay.com/gateway.do，见 gatewayWarning）"
      : "";
    console.error("[alipay] " + method + " HTTP " + res.status + hint + "：" + res.text.slice(0, 300));
    return { ok: false, code: "ALIPAY_HTTP_" + res.status, error: "支付宝接口返回 HTTP " + res.status + hint };
  }

  const respKey = method.replace(/\./g, "_") + "_response";
  const v = verifyResponseSign(res.text, respKey, c.publicKey);
  let data = null;
  try {
    const parsed = JSON.parse(res.text);
    data = parsed && parsed[respKey] ? parsed[respKey] : null;
  } catch {
    data = null;
  }
  if (!v.ok) {
    // 验签失败一律不可信：即使业务码是成功也不入账（防伪造响应）。
    console.error("[alipay] " + method + " " + v.reason);
    return { ok: false, code: "ALIPAY_SIGN_INVALID", error: "支付宝响应验签失败（" + v.reason + "）", raw: res.text.slice(0, 500) };
  }
  if (!data) {
    return { ok: false, code: "ALIPAY_BAD_RESPONSE", error: "支付宝响应格式异常", raw: res.text.slice(0, 500) };
  }
  const code = String(data.code || "");
  const out = {
    ok: code === "10000",
    code,
    msg: String(data.msg || ""),
    subCode: String(data.sub_code || ""),
    subMsg: String(data.sub_msg || ""),
    data,
    raw: res.text.slice(0, 2000),
  };
  if (!out.ok) console.error("[alipay] " + method + " 失败 code=" + code + " sub=" + out.subCode + " " + out.subMsg);
  return out;
}

/**
 * 支付宝业务错误码 → 一句可照做的中文提示（只收录实测/官方明确的那些，不猜）。
 * 返回空串 = 没有额外提示，调用方照常用 sub_msg。
 * 这段提示会一路带到客户端充值窗与管理台，所以必须说「去哪儿改」而不是只报错码。
 */
export function alipaySubCodeHint(subCode) {
  switch (String(subCode || "")) {
    case "ACQ.ACCESS_FORBIDDEN":
      return "无权限调用该接口：请到开放平台 → 本应用 → 产品绑定，签约「当面付」并确认应用状态为「已上线」" +
        "（个人主体通常无法签约当面付，需企业/个体工商户）";
    case "isv.invalid-app-id":
      return "APPID 无效或不属于当前授权账号：核对 MTNODE_ALIPAY_APPID";
    case "isv.invalid-signature":
    case "isv.missing-signature":
      return "签名不被接受：控制台的「应用公钥」与本机应用私钥不是一对，或加签方式不是 RSA2（公钥模式）";
    case "ACQ.TRADE_HAS_FINISHED":
      return "交易已完结不可退（超过退款期限）";
    case "ACQ.SELLER_BALANCE_NOT_ENOUGH":
      return "商户支付宝账户余额不足，无法退款：先往收款账户充值或改用调账";
    case "ACQ.TRADE_STATUS_ERROR":
      return "交易状态不允许该操作（例如未支付却发起退款）";
    default:
      return "";
  }
}

/**
 * 电脑网站支付（alipay.trade.page.pay）：不调接口，只**生成一个签好名的跳转 URL**，
 * 由客户端用系统浏览器打开 → 支付宝收银台（页面上自带二维码，可用手机支付宝扫码付）。
 *
 * 与当面付（precreate）的差别：
 *   · precreate 是 POST 调接口拿 qr_code，二维码由我们自己画（qr-encode.mjs）；需要签约「当面付」。
 *   · page.pay 是浏览器 GET 跳转，收银台页面由支付宝渲染；需要签约「电脑网站支付」。
 * 入账口径两者完全一样：异步 notify（验签 + 幂等）为主，`alipay.trade.query` 轮询兜底。
 *
 * @param {{outTradeNo:string,totalAmountCents:number,subject:string,body?:string,timeoutExpress?:string,qrPayMode?:string}} p
 * @returns {{ok:boolean,url?:string,outTradeNo?:string,code?:string,error?:string}}
 */
export function alipayPagePayUrl(p) {
  const c = resolveConfig();
  if (!c.appId || !c.privateKey) {
    return { ok: false, code: "ALIPAY_UNAVAILABLE", error: "支付宝未配置或密钥无效" + (c.keyError ? "：" + c.keyError : "") };
  }
  const biz = {
    out_trade_no: String(p.outTradeNo || ""),
    total_amount: centsToYuan(p.totalAmountCents),
    subject: String(p.subject || "MTNode 账户充值").slice(0, 256),
    product_code: "FAST_INSTANT_TRADE_PAY",
  };
  if (p.body) biz.body = String(p.body).slice(0, 128);
  biz.timeout_express = String(p.timeoutExpress || "15m");
  const params = signedParams(c, "alipay.trade.page.pay", biz, { returnUrl: true });
  return { ok: true, url: c.gateway + "?" + toFormText(params), outTradeNo: biz.out_trade_no };
}

/**
 * 预下单（当面付）：拿到付款串 qr_code，由调用方画成二维码给用户扫。
 * @param {{outTradeNo:string,totalAmountCents:number,subject:string,body?:string,timeoutExpress?:string,storeId?:string}} p
 * @returns {Promise<{ok:boolean,qrCode?:string,outTradeNo?:string,code?:string,error?:string,subCode?:string,subMsg?:string}>}
 */
export async function alipayPrecreate(p) {
  const biz = {
    out_trade_no: String(p.outTradeNo || ""),
    total_amount: centsToYuan(p.totalAmountCents),
    subject: String(p.subject || "MTNode 账户充值").slice(0, 256),
  };
  if (p.body) biz.body = String(p.body).slice(0, 128);
  // 关单口径：交给支付宝按 timeout_express 自动关，服务端另有 15 分钟惰性过期 + 主动 close。
  biz.timeout_express = String(p.timeoutExpress || "15m");
  if (p.storeId) biz.store_id = String(p.storeId).slice(0, 32);
  const r = await callAlipay("alipay.trade.precreate", biz);
  if (!r.ok) {
    const base = r.error || r.subMsg || r.msg || "预下单失败";
    const hint = alipaySubCodeHint(r.subCode);
    return {
      ok: false,
      code: r.code === "10000" ? "ALIPAY_ERROR" : r.code || "ALIPAY_ERROR",
      error: hint && !base.includes(hint) ? base + "｜" + hint : base,
      subCode: r.subCode,
      subMsg: r.subMsg,
    };
  }
  const qrCode = String((r.data && r.data.qr_code) || "");
  if (!qrCode) return { ok: false, code: "ALIPAY_NO_QR", error: "支付宝未返回二维码串" };
  return { ok: true, qrCode, outTradeNo: String((r.data && r.data.out_trade_no) || biz.out_trade_no) };
}

/** 查交易：用于轮询兜底与手动补单。TRADE_NOT_EXIST 视为「还没付/订单不存在」而非错误。 */
export async function alipayQuery(outTradeNo) {
  const r = await callAlipay("alipay.trade.query", { out_trade_no: String(outTradeNo || "") });
  if (!r.ok) {
    const notExist = r.subCode === "ACQ.TRADE_NOT_EXIST" || r.code === "40004";
    return {
      ok: false,
      notExist,
      code: notExist ? "TRADE_NOT_EXIST" : r.code || "ALIPAY_ERROR",
      error: r.error || r.subMsg || r.msg || "查询失败",
      subCode: r.subCode,
      subMsg: r.subMsg,
    };
  }
  const d = r.data || {};
  return {
    ok: true,
    tradeStatus: String(d.trade_status || ""),
    tradeNo: String(d.trade_no || ""),
    outTradeNo: String(d.out_trade_no || outTradeNo || ""),
    amountCents: yuanToCents(d.total_amount != null ? d.total_amount : d.buyer_pay_amount),
    buyerPayCents: yuanToCents(d.buyer_pay_amount),
    buyerId: String(d.buyer_user_id || d.buyer_open_id || ""),
    paidAt: String(d.send_pay_date || ""),
    raw: r.raw,
  };
}

/** 关单：订单超时后调用，避免用户在过期订单上付款。未支付订单关单会返回成功或 TRADE_NOT_EXIST。 */
export async function alipayClose(outTradeNo) {
  const r = await callAlipay("alipay.trade.close", { out_trade_no: String(outTradeNo || "") });
  if (!r.ok) {
    return {
      ok: false,
      notExist: r.subCode === "ACQ.TRADE_NOT_EXIST",
      code: r.code || "ALIPAY_ERROR",
      error: r.error || r.subMsg || r.msg || "关单失败",
      subCode: r.subCode,
      subMsg: r.subMsg,
    };
  }
  return { ok: true, tradeNo: String((r.data && r.data.trade_no) || "") };
}

/**
 * 退款：支持部分退（同一 out_trade_no 多次退，每次给不同 out_request_no）。
 * fund_change === "Y" 表示本次真的退了钱；"N" 表示重复请求（幂等，已成功过）。
 */
export async function alipayRefund(p) {
  const biz = {
    out_trade_no: String(p.outTradeNo || ""),
    refund_amount: centsToYuan(p.refundAmountCents),
  };
  if (p.outRequestNo) biz.out_request_no = String(p.outRequestNo);
  if (p.refundReason) biz.refund_reason = String(p.refundReason).slice(0, 256);
  const r = await callAlipay("alipay.trade.refund", biz, { notify: false });
  if (!r.ok) {
    const base = r.error || r.subMsg || r.msg || "退款失败";
    const hint = alipaySubCodeHint(r.subCode);
    return {
      ok: false,
      code: r.code || "ALIPAY_ERROR",
      error: hint && !base.includes(hint) ? base + "｜" + hint : base,
      subCode: r.subCode,
      subMsg: r.subMsg,
    };
  }
  const d = r.data || {};
  return {
    ok: true,
    fundChange: String(d.fund_change || ""),
    refundFeeCents: yuanToCents(d.refund_fee),
    tradeNo: String(d.trade_no || ""),
    outTradeNo: String(d.out_trade_no || p.outTradeNo || ""),
    buyerId: String(d.buyer_user_id || d.buyer_open_id || ""),
    gmtRefundPay: String(d.gmt_refund_pay || ""),
    raw: r.raw,
  };
}

/**
 * 解析异步通知的 form body（application/x-www-form-urlencoded）。
 * 通知值必须**保持原始未解码状态**参与验签？—— 不是：支付宝要求先按 urldecode 还原成
 * 原值，再按 ASCII 排序拼串验签（官方 SDK 口径），因此这里用 decodeURIComponent。
 */
export function parseNotifyForm(text) {
  const out = {};
  for (const pair of String(text || "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 通知语义归一：验签 + 只认 TRADE_SUCCESS / TRADE_FINISHED。
 * @returns {{ok:boolean, accepted:boolean, outTradeNo?:string, tradeNo?:string, amountCents?:number,
 *            tradeStatus?:string, buyerId?:string, paidAt?:string, reason?:string, params?:object}}
 */
export function normalizeNotify(params) {
  const p = params || {};
  if (!alipayVerifyNotify(p)) {
    return { ok: false, accepted: false, reason: "SIGN_INVALID", params: redactNotify(p) };
  }
  const appId = String(p.app_id || "");
  const cfgAppId = resolveConfig().appId;
  if (cfgAppId && appId && appId !== cfgAppId) {
    return { ok: false, accepted: false, reason: "APP_ID_MISMATCH", params: redactNotify(p) };
  }
  const status = String(p.trade_status || "");
  const accepted = status === "TRADE_SUCCESS" || status === "TRADE_FINISHED";
  return {
    ok: true,
    accepted,
    tradeStatus: status,
    outTradeNo: String(p.out_trade_no || ""),
    tradeNo: String(p.trade_no || ""),
    amountCents: yuanToCents(p.total_amount),
    buyerId: String(p.buyer_id || p.buyer_open_id || ""),
    paidAt: String(p.gmt_payment || ""),
    reason: accepted ? "" : "STATUS_" + (status || "EMPTY"),
    params: redactNotify(p),
  };
}

/** 通知落库前脱敏：买家 id 只留前后各 4 位（其余字段是订单要素，需要原文对账）。 */
function redactNotify(p) {
  const out = Object.assign({}, p);
  for (const k of ["buyer_id", "buyer_open_id", "buyer_logon_id"]) {
    const s = String(out[k] || "");
    if (s.length > 8) out[k] = s.slice(0, 4) + "****" + s.slice(-4);
  }
  delete out.sign;
  return out;
}

export default {
  alipayStatus,
  alipayPrecreate,
  alipayPagePayUrl,
  alipayQuery,
  alipayClose,
  alipayRefund,
  alipayVerifyNotify,
  parseNotifyForm,
  normalizeNotify,
  verifyResponseSign,
  buildSignContent,
  signedParams,
  toFormText,
  alipayTimestamp,
  centsToYuan,
  yuanToCents,
  notifyWarning,
  gatewayWarning,
  returnWarning,
  normalizeChannel,
  alipaySubCodeHint,
};

"use strict";
/**
 * MTNode 充值通道 · 线上只读探针（零依赖，人工在服务器上跑）。
 *
 * 为什么需要它：支付宝控制台**看不到「某个接口有没有权限」**，而 `configured: true` 只代表
 * 密钥齐全 —— 真下单时才会撞上 `ACQ.ACCESS_FORBIDDEN`（未签约该产品）。这个脚本用服务端的
 * 真实应用私钥签一次名去问网关，把「哪些支付产品已签约」直接列出来。
 *
 * 副作用口径（重要）：
 *   · page.pay / wap.pay 的 POST 只返回一个**自动提交表单页**，不提交就不会产生交易；
 *     脚本还会在探测后查一次这笔探测单，确认 `TRADE_NOT_EXIST`（证明探针零副作用）。
 *   · precreate（当面付）一旦成功**就是真建了一笔待支付订单**，所以默认不打，
 *     要打得显式加 `--precreate`，成功后立刻 `trade.close` 关掉。
 *   · 全程不改配置、不写库、不动余额；只打印状态码与提示，不打印任何密钥材料。
 *
 * 用法（服务器上，先把环境文件读进来）：
 *   cd /opt/mtnode-store && set -a && . /etc/mtnode-store.env && set +a
 *   node alipay-probe.mjs                 # 只读探针（page.pay / wap.pay / query）
 *   node alipay-probe.mjs --precreate     # 额外真建一笔 ¥0.01 当面付单并立刻关单
 *   node alipay-probe.mjs --query rc_xxx  # 顺带查一笔真实订单的状态
 *
 * 退出码：0 = 至少一个支付产品可用；1 = 一个都不可用（或凭据未配齐）；2 = 用法错误。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import {
  alipayStatus,
  alipayQuery,
  alipayPrecreate,
  alipayClose,
  alipaySubCodeHint,
  buildSignContent,
} from "./alipay-provider.mjs";

const ARGS = process.argv.slice(2);
const flag = (n) => ARGS.includes(n);
const opt = (n) => {
  const i = ARGS.indexOf(n);
  return i >= 0 ? String(ARGS[i + 1] || "") : "";
};
if (ARGS.some((a) => a.startsWith("--") && !["--precreate", "--query", "--json", "--help"].includes(a))) {
  console.error("未知参数。用法：node alipay-probe.mjs [--precreate] [--query <商户订单号>] [--json]");
  process.exit(2);
}
if (flag("--help")) {
  console.log("用法：set -a && . /etc/mtnode-store.env && set +a && node alipay-probe.mjs [--precreate] [--query <no>] [--json]");
  process.exit(0);
}

const GATEWAY = process.env.MTNODE_ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do";

function fail(msg) {
  console.error("[probe] " + msg);
  process.exit(1);
}

/** 支付宝请求时间戳：东八区 yyyy-MM-dd HH:mm:ss（与 provider 同口径）。 */
function ts() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** 用服务端真实应用私钥签名并 POST 网关，返回 HTTP 状态 + 原文（判定签约状态用）。 */
async function signedPost(method, biz) {
  const priv = crypto.createPrivateKey(fs.readFileSync(process.env.MTNODE_ALIPAY_PRIVATE_KEY_PATH, "utf8"));
  const p = {
    app_id: process.env.MTNODE_ALIPAY_APPID,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: ts(),
    version: "1.0",
    biz_content: JSON.stringify(biz),
  };
  if (process.env.MTNODE_ALIPAY_NOTIFY_URL && method !== "alipay.trade.refund") p.notify_url = process.env.MTNODE_ALIPAY_NOTIFY_URL;
  p.sign = crypto.createSign("RSA-SHA256").update(buildSignContent(p), "utf8").sign(priv, "base64");
  const body = Object.keys(p).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(p[k])).join("&");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, text: await res.text() };
}

/** 判定：HTML 收银台页 = 已签约；ACCESS_FORBIDDEN / no-permission = 没签约；JSON 业务错 = 已签约但参数/状态问题。 */
function verdictOf(status, text) {
  const low = text.toLowerCase();
  if (status >= 300 && status < 400) return { ok: false, verdict: "HTTP " + status + "（网关地址不对？见 gatewayWarning）" };
  if (status !== 200) return { ok: false, verdict: "HTTP " + status };
  if (low.includes("access_forbidden") || low.includes("no-permission") || low.includes("no_permission")) {
    return { ok: false, verdict: "无权限 → 未签约该产品", hint: alipaySubCodeHint("ACQ.ACCESS_FORBIDDEN") };
  }
  if (low.includes("<!doctype") || low.includes("<html")) return { ok: true, verdict: "已签约（返回收银台表单页）" };
  if (low.includes("invalid-signature") || low.includes("invalid_signature")) {
    return { ok: false, verdict: "签名不被接受", hint: alipaySubCodeHint("isv.invalid-signature") };
  }
  if (low.includes("invalid-app-id")) return { ok: false, verdict: "APPID 无效", hint: alipaySubCodeHint("isv.invalid-app-id") };
  return { ok: true, verdict: "已签约（返回 JSON 业务响应）", detail: text.slice(0, 160).replace(/\s+/g, " ") };
}

const st = alipayStatus();
const out = { gateway: GATEWAY, status: st, products: [], sideEffectFree: null };

if (!st.configured) fail("支付宝凭据未配齐：missing=" + JSON.stringify(st.missing) + (st.keyError ? " keyError=" + st.keyError : ""));
if (st.gatewayWarning) console.error("[probe] 网关体检告警：" + st.gatewayWarning);
if (st.notifyWarning) console.error("[probe] 通知地址告警：" + st.notifyWarning);

const stamp = Date.now();

/* ① 网站支付两兄弟：只返回表单页，不建交易（下面会复查确认） */
for (const [method, productCode] of [
  ["alipay.trade.page.pay", "FAST_INSTANT_TRADE_PAY"],
  ["alipay.trade.wap.pay", "QUICK_WAP_WAY"],
]) {
  const no = "MTNODEPROBE" + stamp + (method.includes("page") ? "P" : "W");
  const r = await signedPost(method, { out_trade_no: no, total_amount: "0.01", subject: "MTNode 通道自检", product_code: productCode });
  const v = verdictOf(r.status, r.text);
  out.products.push({ method, product: method.includes("page") ? "电脑网站支付" : "手机网站支付", http: r.status, ...v });
}

/* ② 当面付（扫码）：真建单，默认跳过 */
if (flag("--precreate")) {
  const no = "MTNODEPROBE" + stamp + "C";
  const p = await alipayPrecreate({ outTradeNo: no, totalAmountCents: 1, subject: "MTNode 通道自检", timeoutExpress: "5m" });
  const item = {
    method: "alipay.trade.precreate",
    product: "当面付（扫码）",
    ok: !!p.ok,
    verdict: p.ok ? "已签约（拿到付款串，随即关单）" : "无权限 → 未签约该产品",
    subCode: p.subCode || "",
    error: p.error || "",
  };
  if (p.ok) {
    const c = await alipayClose(no);
    item.closed = !!c.ok;
    item.closeDetail = c.ok ? "" : (c.error || c.subCode || "");
  } else if (p.subCode && p.subCode !== "ACQ.ACCESS_FORBIDDEN") {
    item.verdict = "已签约但业务失败：" + (p.subMsg || p.error || "");
    item.ok = true;
  }
  if (p.subCode) item.hint = alipaySubCodeHint(p.subCode);
  out.products.push(item);
} else {
  out.products.push({ method: "alipay.trade.precreate", product: "当面付（扫码）", ok: null, verdict: "未探测（会真建一笔待支付单，需 --precreate 显式打开）" });
}

/* ③ 查单能力（轮询兜底 / 手动补单靠它）：拿探测单号查，应回 TRADE_NOT_EXIST */
const q = await alipayQuery("MTNODEPROBE" + stamp + "P");
out.query = { ok: q.ok, code: q.code, notExist: !!q.notExist, subMsg: q.subMsg || "", verdict: q.notExist ? "可用（签名与验签都通过）" : "异常：" + (q.error || q.code) };

/* ④ 零副作用复核：探测单不该被建出来 */
out.sideEffectFree = q.notExist ? true : "探测单号竟查到了交易（page.pay 的 POST 建了单？请核对）";

/* ⑤ 可选：查一笔真实订单 */
const realNo = opt("--query");
if (realNo) {
  const rq = await alipayQuery(realNo);
  out.realOrder = rq.ok
    ? { outTradeNo: rq.outTradeNo, tradeStatus: rq.tradeStatus, amountCents: rq.amountCents, paidAt: rq.paidAt }
    : { outTradeNo: realNo, code: rq.code, error: rq.error };
}

const usable = out.products.filter((p) => p.ok === true);
out.usable = usable.map((p) => p.method);
out.conclusion = usable.length
  ? "可用支付产品：" + usable.map((p) => p.product).join(" / ")
  : "没有任何可用的支付产品（先在开放平台签约，见上面的 hint）";

if (flag("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log("网关      : " + out.gateway + (st.sandbox ? "（沙箱）" : ""));
  console.log("APPID     : " + st.appId + "  签名: " + st.signType + "  configured: " + st.configured);
  console.log("通知地址  : " + (st.hasNotifyUrl ? "已配 " + (st.notifyWarning ? "⚠ " + st.notifyWarning : "体检通过") : "未配（只能靠轮询兜底）"));
  console.log("网关体检  : " + (st.gatewayWarning || "通过"));
  console.log("");
  for (const p of out.products) {
    const mark = p.ok === true ? "✅" : p.ok === false ? "❌" : "⏸";
    console.log(mark + " " + p.method.padEnd(24) + " " + String(p.product).padEnd(14) + " " + p.verdict);
    if (p.hint) console.log("   ↳ " + p.hint);
    if (p.detail) console.log("   ↳ " + p.detail);
    if (p.error) console.log("   ↳ " + p.error);
  }
  console.log("");
  console.log("查单接口  : " + out.query.verdict);
  console.log("零副作用  : " + (out.sideEffectFree === true ? "确认（探测单 TRADE_NOT_EXIST，没建出交易）" : out.sideEffectFree));
  if (out.realOrder) console.log("指定订单  : " + JSON.stringify(out.realOrder));
  console.log("结论      : " + out.conclusion);
}

process.exit(usable.length ? 0 : 1);

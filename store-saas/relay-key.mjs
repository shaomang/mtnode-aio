#!/usr/bin/env node
"use strict";
/**
 * 中转站 Key 发放（人工跑 · 服务器上执行）—— MTNode 中转站的 Key 就是账号登录 token，
 * 而客户端为了安全从不把明文 token 交给界面，所以测试账号的 Key 由管理员在这里发一张。
 *
 * 用法（在服务器上，与 mtnode-store 同一个账户后端 / 同一个 DATA_DIR）：
 *   node relay-key.mjs --list                     列出账号与可用余额（挑有余额的账号发）
 *   node relay-key.mjs --user ms2308              为该账号新签一张 30 天票（明文只打印这一次）
 *   node relay-key.mjs --user ms2308 --days 7     自定义有效期
 *   node relay-key.mjs --user ms2308 --json       机器可读输出（只给 token 与账号摘要）
 *
 * 口径与 relay.mjs / wallet.mjs 一致：
 *   · 票走 account-store 的 sessions（与客户端登录同一套），所以**登录能用的账号这里也能发**；
 *   · 中转站只放行「可用余额 > 0」的账号（余额一律按元显示），余额为 0 的账号发了票也会 402；
 *   · 管理台 / 客户端其余能力不受影响：这张票只多出「调中转站」这条路。
 *
 * 环境变量与 server.mjs 完全一致：MTNODE_ACCOUNT_STORE / DATA_DIR / MTNODE_OTS_*。
 */
import crypto from "node:crypto";
import { createAccountStore, SESSION_MS } from "./account-store.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v == null || v.startsWith("--") ? dflt : v;
}
function has(name) {
  return process.argv.indexOf("--" + name) >= 0;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** 分 → 元（4 位小数）：CLI 只按元显示，不出现「分」。 */
function money(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(4) + " 元";
}

/** 分（可含亚分零头）→ 元（4 位小数）。 */
function yuanOf(cents) {
  return Math.round((Number(cents) || 0) / 100 * 1e4) / 1e4;
}

function subCentsOf(u) {
  const n = Number(u && u.relaySubCents);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e4) / 1e4 : 0;
}

const store = createAccountStore({
  dataDir: process.env.DATA_DIR || undefined,
  dbPath: process.env.DB_PATH || undefined,
});
await store.ready();

const json = has("json");
const asJson = (obj) => {
  process.stdout.write(JSON.stringify(obj, null, json ? 0 : 2) + "\n");
};

const users = await store.listUsers();

if (has("list") || !arg("user", "")) {
  const rows = users
    .map((u) => ({
      id: u.id,
      username: u.username || "",
      nickname: u.nickname || "",
      balanceYuan: yuanOf(Math.round(Number(u.balanceCents) || 0) + subCentsOf(u)),
      hasPassword: !!u.pass,
      phone: u.phone ? "已绑" : "",
      wechat: u.wechatUnionId ? "已绑" : "",
      createdAt: u.createdAt || 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (json) {
    asJson({ ok: true, accounts: rows });
  } else {
    console.log("账号共 " + rows.length + " 个（可用余额一律按元，只有 > 0 的账号能调中转站）：");
    for (const r of rows) {
      const usable = r.balanceYuan;
      console.log(
        "  " + (r.username || r.id) +
          "  余额 " + Number(r.balanceYuan).toFixed(4) + " 元" +
          "  " + r.id +
          "  登录方式 " + (["密码", r.phone, r.wechat].filter(Boolean).join(" / ") || "（无）") +
          (usable > 0 ? "" : "  ← 余额 0，发了票也会 402"),
      );
    }
    console.log("\n发 Key：node relay-key.mjs --user <用户名>");
    if (store.describe) console.log("账户后端：" + JSON.stringify(store.describe()));
  }
  process.exit(0);
}

const want = String(arg("user", "")).trim();
if (!want) {
  console.error("用法：node relay-key.mjs --user <用户名|账号ID> [--days 30] [--json]   /   --list");
  process.exit(2);
}
const days = Number(arg("days", "0"));
/* 缺省 180 天（与服务端 RELAY_KEY_MS 同口径）；--days 可覆盖。 */
const RELAY_KEY_MS = 180 * 24 * 3600 * 1000;
const ttl = Number.isFinite(days) && days > 0 ? Math.floor(days) * 24 * 3600 * 1000 : RELAY_KEY_MS;

const low = want.toLowerCase();
const user = users.find((u) => String(u.username || "").toLowerCase() === low) || users.find((u) => u.id === want);
if (!user) {
  console.error("找不到账号：" + want + "（用 --list 看全部账号）");
  process.exit(1);
}

const token = crypto.randomBytes(24).toString("hex");
const t = Date.now();
/* kind="relay" 是这个 Key 的**身份**：service 侧只认它（/relay/v1/* 不收登录会话 token），
   客户端也按独立票存进本机加密凭据（180 天滑动续期，见 server.mjs 的 issueRelayKey）。
   默认有效期跟服务端的 RELAY_KEY_MS 同口径（180 天），--days 可覆盖。 */
await store.createSession({
  tokenHash: hashToken(token),
  userId: user.id,
  expiresAt: t + ttl,
  kind: "relay",
  createdAt: t,
});

const total = Math.round((Math.round(Number(user.balanceCents) || 0) + subCentsOf(user)) * 1e4) / 1e4;
const out = {
  ok: true,
  user: { id: user.id, username: user.username || "", nickname: user.nickname || "" },
  balanceYuan: Math.round((total / 100) * 1e4) / 1e4,
  usableYuan: Math.round((total / 100) * 1e4) / 1e4,
  expiresAt: t + ttl,
  key: token,
};

if (json) {
  asJson(out);
} else {
  console.log("已为账号 " + (out.user.username || out.user.id) + " 签发中转 Key（有效期至 " + new Date(out.expiresAt).toISOString() + "）：\n");
  console.log("  " + token + "\n");
  console.log("明文只打印这一次（服务端只存哈希，丢了就再发一张；旧票不会因此失效）。");
  console.log("填法：MTNode 应用 → 设置 → 提供商 → 新增/编辑，类型选「文本 · OpenAI 兼容」，");
  console.log("      Base URL = https://www.mt-agent.com/mtnode/store-api/relay/v1");
  console.log("      Key = 上面那串；模型填中转站白名单里的名字（如 deepseek-flash / deepseek-v4-pro）。");
  console.log("      图像（gpt-image-2.5-vip）另建一个「图像 · OpenAI 兼容」提供商，地址与 Key 同上。");
  if (total <= 0) {
    console.warn("\n⚠ 该账号可用余额为 0：中转站会回 402 insufficient_quota，先去充值或人工调账再发。");
  }
}
process.exit(0);
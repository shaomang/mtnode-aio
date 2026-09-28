#!/usr/bin/env node
/**
 * 支付宝「应用公私钥」生成器（零依赖 · 只写密钥文件 · 不进仓库不落应用目录）
 *
 * 为什么要有它：开放平台「开发设置 → 接口加签方式 → 自定义密钥」要求先有一对
 * RSA2(SHA256WithRSA) 2048 位密钥（官方口径见 https://opendocs.alipay.com/common/055l5k）。
 * 官方密钥工具只有 Windows GUI / Java 版，服务器上没法用；本脚本用 node:crypto 出同一份东西，
 * 并且**当场用 alipay-provider.mjs 的真实解析与验签路径自检**，避免「生成了但服务端读不进」。
 *
 * 产出（--out 目录下）：
 *   app_private_key.pem        应用私钥（PKCS8，0600）——只留在服务器，绝不外传、不入库、不打印
 *   app_private_key_pkcs1.pem  同一把私钥的 PKCS1 版（--format both / pkcs1 时才出，给老 SDK 用）
 *   app_public_key.pem         应用公钥（X.509 SubjectPublicKeyInfo）
 *   app_public_key.txt         应用公钥的**裸 base64 单行**——这份才是粘进开放平台控制台的内容
 *
 * 拿到支付宝公钥（控制台粘完应用公钥后由支付宝返回）后，另存为同目录
 *   alipay_public_key.pem      支付宝公钥（验接口响应与异步通知用）
 * 再把下面这段写进 /etc/mtnode-store.env（--print env 会原样打出来）：
 *   MTNODE_ALIPAY_APPID=…
 *   MTNODE_ALIPAY_PRIVATE_KEY_PATH=/etc/mtnode-store/alipay/app_private_key.pem
 *   MTNODE_ALIPAY_PUBLIC_KEY_PATH=/etc/mtnode-store/alipay/alipay_public_key.pem
 *   MTNODE_ALIPAY_NOTIFY_URL=https://www.mt-agent.com/mtnode/store-api/api/pay/alipay/notify
 *
 * 用法：
 *   node alipay-keygen.mjs [--out DIR] [--appid ID] [--format pkcs8|pkcs1|both]
 *                          [--print public|env|private|none] [--force] [--csr]
 *   node alipay-keygen.mjs --check [--out DIR]     # 只自检已有密钥，不生成
 *
 * --out 默认：POSIX /etc/mtnode-store/alipay · Windows %APPDATA%\pipeline-console\alipay
 * 支持「公钥模式」。若应用选了「公钥证书模式」（要上传 CSR、拿三份证书），
 * 本脚本只给 CSR 生成命令（--csr），签名侧尚未实现 app_cert_sn / alipay_root_cert_sn。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { alipayStatus, buildSignContent, alipayVerifyNotify } from "./alipay-provider.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULUS_BITS = 2048; // RSA2 官方要求 2048 位
const PRIV_NAME = "app_private_key.pem";
const PRIV_PKCS1_NAME = "app_private_key_pkcs1.pem";
const PUB_NAME = "app_public_key.pem";
const PUB_TXT_NAME = "app_public_key.txt";
const ALIPAY_PUB_NAME = "alipay_public_key.pem";
const NOTIFY_URL_DEFAULT = "https://www.mt-agent.com/mtnode/store-api/api/pay/alipay/notify";

function fail(msg) {
  console.error("[alipay-keygen] " + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { out: "", appid: "", format: "pkcs8", print: "public", force: false, csr: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i] || "";
    if (t === "--out") a.out = next();
    else if (t === "--appid") a.appid = next();
    else if (t === "--format") a.format = next();
    else if (t === "--print") a.print = next();
    else if (t === "--force") a.force = true;
    else if (t === "--csr") a.csr = true;
    else if (t === "--check") a.check = true;
    else if (t === "--help" || t === "-h") a.help = true;
    else fail("未知参数：" + t + "（--help 看用法）");
  }
  if (!["pkcs8", "pkcs1", "both"].includes(a.format)) fail("--format 只能是 pkcs8 / pkcs1 / both");
  if (!["public", "env", "private", "none"].includes(a.print)) fail("--print 只能是 public / env / private / none");
  return a;
}

function defaultOut() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "pipeline-console", "alipay");
  }
  return "/etc/mtnode-store/alipay";
}

/**
 * 密钥不落仓库、不落应用目录（AGENTS.md：数据只进 %APPDATA% 或服务器配置目录）。
 * 判据：从 out 目录逐级向上，撞到 .git / build.json+package.json 同目录（= 本仓库根）就拒绝。
 */
function assertOutsideRepo(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) {
      fail("拒绝把密钥写进 git 仓库：" + cur + "\n  改用 --out /etc/mtnode-store/alipay（服务器）" +
        " 或 --out " + defaultOut() + "（本机）");
    }
    if (fs.existsSync(path.join(cur, "build.json")) && fs.existsSync(path.join(cur, "package.json"))) {
      fail("拒绝把密钥写进应用目录：" + cur + "（升级 / 卸载会被带走）");
    }
    const up = path.dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}

function chmod600(p) {
  if (process.platform === "win32") return;
  try { fs.chmodSync(p, 0o600); } catch { /* 非 POSIX 忽略 */ }
}

function b64OneLine(der) {
  return der.toString("base64").replace(/\s+/g, "");
}

/** 裸 base64 → PEM（与 alipay-provider.toPem 同口径，独立实现以便自检互相印证）。 */
function wrapPem(b64, kind) {
  const lines = String(b64).replace(/[\r\n\s]+/g, "").match(/.{1,64}/g) || [];
  return "-----BEGIN " + kind + "-----\n" + lines.join("\n") + "\n-----END " + kind + "-----\n";
}

/* ---------------- 自检 ---------------- */

/**
 * 用生成的密钥走一遍服务端的真实读法：
 *  ① env（_PATH 指向文件）→ alipayStatus().configured 必须为 true 且 keyError 空
 *  ② 裸 base64 单行公钥（= 控制台粘贴口径）也能被解析
 *  ③ 应用私钥签名 → 用同一把公钥按 alipayVerifyNotify 验签通过；篡改后必须失败
 * 返回问题清单（空数组 = 全绿）。
 */
export function selfCheck({ outDir, appId, privatePem, publicB64OneLine }) {
  const problems = [];
  const saved = {};
  const keys = [
    "MTNODE_ALIPAY_APPID", "MTNODE_ALIPAY_PRIVATE_KEY_PATH", "MTNODE_ALIPAY_PUBLIC_KEY_PATH",
    "MTNODE_ALIPAY_PRIVATE_KEY", "MTNODE_ALIPAY_PUBLIC_KEY",
  ];
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const privPath = outDir ? path.join(outDir, PRIV_NAME) : "";
    const pubPath = outDir ? path.join(outDir, ALIPAY_PUB_NAME) : "";
    process.env.MTNODE_ALIPAY_APPID = appId || "2021000000000000";
    if (privatePem) {
      // 没有落盘时用内联值（--check 之外的自测路径）
      process.env.MTNODE_ALIPAY_PRIVATE_KEY = privatePem;
      process.env.MTNODE_ALIPAY_PUBLIC_KEY = wrapPem(publicB64OneLine, "PUBLIC KEY");
    } else {
      process.env.MTNODE_ALIPAY_PRIVATE_KEY_PATH = privPath;
      process.env.MTNODE_ALIPAY_PUBLIC_KEY_PATH = fs.existsSync(pubPath) ? pubPath : path.join(outDir, PUB_NAME);
    }
    const st = alipayStatus();
    if (!st.configured) problems.push("alipayStatus 未 configured：" + JSON.stringify(st.missing) + " " + st.keyError);
    if (st.keyError) problems.push("keyError：" + st.keyError);
    if (st.signType !== "RSA2") problems.push("signType 不是 RSA2：" + st.signType);

    // ②③ 用服务端同一把解析结果做签名 / 验签往返
    const priv = crypto.createPrivateKey(privatePem || fs.readFileSync(process.env.MTNODE_ALIPAY_PRIVATE_KEY_PATH, "utf8"));
    const pub = crypto.createPublicKey(wrapPem(publicB64OneLine, "PUBLIC KEY"));
    if (priv.asymmetricKeyType !== "rsa") problems.push("私钥不是 RSA：" + priv.asymmetricKeyType);
    if (priv.asymmetricKeyDetails?.modulusLength !== MODULUS_BITS) {
      problems.push("模长不是 " + MODULUS_BITS + " 位（RSA2 要求）：" + priv.asymmetricKeyDetails?.modulusLength);
    }
    // 请求串（含 sign_type）与异步通知串（**不含** sign / sign_type）是两套口径，分开验：
    // 混用会「签名正确却验不过」，上一轮真踩过（见 docs/recharge-design.md §验签）。
    const base = {
      app_id: process.env.MTNODE_ALIPAY_APPID, charset: "utf-8", timestamp: "2026-01-01 00:00:00",
      version: "1.0", biz_content: JSON.stringify({ out_trade_no: "T1", total_amount: "1.00", subject: "自检" }),
    };
    const signOf = (p) => crypto.createSign("RSA-SHA256").update(buildSignContent(p), "utf8").sign(priv, "base64");

    const req = Object.assign({}, base, { method: "alipay.trade.precreate", sign_type: "RSA2" });
    const reqSign = signOf(req);
    if (!crypto.createVerify("RSA-SHA256").update(buildSignContent(req), "utf8").verify(pub, reqSign, "base64")) {
      problems.push("请求串（含 sign_type）签名验不过 —— 这把私钥没法调支付宝接口");
    }

    const notify = Object.assign({}, base, {
      trade_no: "2026010122001400000000000001", out_trade_no: "T1", trade_status: "TRADE_SUCCESS", total_amount: "1.00",
    });
    if (!alipayVerifyNotify(Object.assign({}, notify, { sign: signOf(notify), sign_type: "RSA2" }), pub)) {
      problems.push("异步通知验签验不过（alipayVerifyNotify 口径）—— 线上会收不到入账");
    }
    if (alipayVerifyNotify(Object.assign({}, notify, { total_amount: "9.99", sign: signOf(notify), sign_type: "RSA2" }), pub)) {
      problems.push("金额被篡改后仍然验签通过 = 验签形同虚设");
    }
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return problems;
}

/* ---------------- 生成 ---------------- */

export function generateKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: MODULUS_BITS,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function envBlock(outDir, appId) {
  const p = (n) => (process.platform === "win32" ? path.join(outDir, n).replace(/\\/g, "/") : path.join(outDir, n));
  return [
    "# ---- 支付宝当面付（alipay-keygen.mjs 生成，密钥文件 0600 只留本机）----",
    "MTNODE_ALIPAY_APPID=" + (appId || "<开放平台应用 APPID>"),
    "MTNODE_ALIPAY_PRIVATE_KEY_PATH=" + p(PRIV_NAME),
    "MTNODE_ALIPAY_PUBLIC_KEY_PATH=" + p(ALIPAY_PUB_NAME) + "   # 控制台粘完应用公钥后返回的「支付宝公钥」",
    "MTNODE_ALIPAY_NOTIFY_URL=" + NOTIFY_URL_DEFAULT,
    "# MTNODE_ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do  # 沙箱另填",
  ].join("\n");
}

function csrHelp(outDir) {
  return [
    "「公钥证书模式」需要上传 CSR（本脚本不签发证书，用服务器自带 openssl 生成）：",
    "  openssl req -new -sha256 -key " + path.join(outDir, PRIV_NAME) + " \\",
    '    -subj "/C=CN/O=MTNode/CN=mt-agent.com" -out ' + path.join(outDir, "app.csr"),
    "上传后支付宝给三份证书（appCertPublicKey / alipayCertPublicKey / alipayRootCert）。",
    "注意：当前 alipay-provider.mjs 只实现「公钥模式」，证书模式还需补 app_cert_sn /",
    "alipay_root_cert_sn 才能下单——要用证书模式先说一声，别只换控制台设置。",
  ].join("\n");
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*/, ""));
    return;
  }
  const outDir = path.resolve(a.out || defaultOut());
  assertOutsideRepo(outDir);

  if (a.csr) { console.log(csrHelp(outDir)); return; }

  const privPath = path.join(outDir, PRIV_NAME);
  const pubPath = path.join(outDir, PUB_NAME);
  const pubTxtPath = path.join(outDir, PUB_TXT_NAME);

  if (a.check) {
    if (!fs.existsSync(privPath)) fail("没有找到 " + privPath + "（先生成：node alipay-keygen.mjs --out " + outDir + "）");
    const privPem = fs.readFileSync(privPath, "utf8");
    const pubSrc = fs.existsSync(pubTxtPath) ? fs.readFileSync(pubTxtPath, "utf8") : fs.readFileSync(pubPath, "utf8");
    const oneLine = pubSrc.includes("-----BEGIN")
      ? b64OneLine(crypto.createPublicKey(pubSrc).export({ type: "spki", format: "der" }))
      : pubSrc.trim();
    const problems = selfCheck({ outDir, appId: a.appid || process.env.MTNODE_ALIPAY_APPID, privatePem: privPem, publicB64OneLine: oneLine });
    const alipayPub = fs.existsSync(path.join(outDir, ALIPAY_PUB_NAME));
    console.log("[alipay-keygen] 自检 " + (problems.length ? "FAILED" : "OK") + " · 目录 " + outDir +
      " · 支付宝公钥 " + (alipayPub ? "已就位(" + ALIPAY_PUB_NAME + ")" : "缺失（控制台粘完应用公钥后写入）"));
    problems.forEach((p) => console.error("  ✗ " + p));
    process.exit(problems.length ? 1 : 0);
  }

  if (fs.existsSync(privPath) && !a.force) {
    fail("已存在 " + privPath + "，拒绝覆盖（覆盖 = 线上正在用的密钥作废）。\n" +
      "  换目录：--out <新目录>；确认要换密钥：--force（旧密钥先自己备份）；只想自检：--check");
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const { privateKey, publicKey } = generateKeyPair();
  const pubDer = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
  const pubOneLine = b64OneLine(pubDer);

  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  chmod600(privPath);
  fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });
  fs.writeFileSync(pubTxtPath, pubOneLine + "\n", { mode: 0o644 });
  if (a.format === "pkcs1" || a.format === "both") {
    const pkcs1 = crypto.createPrivateKey(privateKey).export({ type: "pkcs1", format: "pem" });
    const name = a.format === "pkcs1" ? PRIV_NAME : PRIV_PKCS1_NAME;
    fs.writeFileSync(path.join(outDir, name), pkcs1, { mode: 0o600 });
    chmod600(path.join(outDir, name));
  }
  // 私钥文件写完立刻收紧权限（Windows 无 POSIX 位，靠目录 ACL；密钥内容从不进日志）
  if (process.platform !== "win32") { try { fs.chmodSync(outDir, 0o700); } catch { /* ignore */ } }

  const problems = selfCheck({ outDir, appId: a.appid, privatePem: privateKey, publicB64OneLine: pubOneLine });
  console.log("[alipay-keygen] 已生成 RSA2/" + MODULUS_BITS + " 密钥对 → " + outDir);
  console.log("  · " + PRIV_NAME + "（应用私钥，0600，绝不外传）");
  console.log("  · " + PUB_NAME + " / " + PUB_TXT_NAME + "（应用公钥，后者是粘进控制台的裸 base64 单行）");
  console.log("  · 自检：" + (problems.length ? "FAILED" : "OK（走 alipay-provider 的解析 + RSA2 签名/验签/篡改拦截）"));
  problems.forEach((p) => console.error("    ✗ " + p));

  if (a.print === "public" || a.print === "env" || a.print === "private") {
    if (a.print === "env") console.log("\n" + envBlock(outDir, a.appid));
    if (a.print === "private") {
      console.error("\n[alipay-keygen] 警告：下面这段是应用私钥，别贴进聊天 / 工单 / 截图，只能进 600 权限的服务器文件");
      console.log("\n" + privateKey.trim());
    }
    console.log("\n应用公钥（粘到 开放平台 → 应用 → 开发设置 → 接口加签方式 → 自定义密钥/公钥）：\n" + pubOneLine);
    console.log("\n下一步：控制台保存后会显示「支付宝公钥」，把它整段存成 " + path.join(outDir, ALIPAY_PUB_NAME) +
      "（PEM 或裸 base64 都行），再 " + (a.print === "env" ? "把上面这段 env" : "按 --print env 打出的 env") +
      " 写进 /etc/mtnode-store.env → systemctl restart mtnode-store → GET /api/pay/alipay/status 应转 configured。");
  }
  if (problems.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

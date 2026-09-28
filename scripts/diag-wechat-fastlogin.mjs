#!/usr/bin/env node
/**
 * diag-wechat-fastlogin.mjs —— 微信「快捷登录」本机桥通道诊断（只读 · 零依赖 · 手动跑）
 *
 * 为什么需要它：微信 PC 客户端在回环地址起的 HTTPS 桥是**自签证书**且只认
 * localhost.weixin.qq.com 的 SNI，不同 TLS 栈的握手结果不一样——
 * 应用里 curl.exe（Schannel）能握手、Electron 自带的 TLS 未必。
 * 这个脚本把「谁在哪、谁握手得动」一次性摊开，避免在 UI 上瞎猜。
 *
 * 它做什么（全部只读，不发任何业务请求、不落盘、不改配置）：
 *   ① 枚举 Weixin / WeChat 进程正在监听的端口（Get-NetTCPConnection，失败回退 netstat）；
 *   ② 逐端口打印 curl / Node / Electron 三种通道的握手结果（HTTP 状态 + 耗时 + 错误原文）；
 *   ③ 对握手成功的通道，打印 /api/check-login 的 errcode / errmsg 原文；
 *   ④ 末行给结论：0=可用 / 10057=微信侧仅支持扫一扫 / 全不可达=微信未运行。
 *
 * 用法：
 *   node scripts/diag-wechat-fastlogin.mjs
 *   node scripts/diag-wechat-fastlogin.mjs --auth-url "https://open.weixin.qq.com/connect/qrconnect?appid=...&redirect_uri=..."
 *   node scripts/diag-wechat-fastlogin.mjs --port 14016 --port 14019
 *   node scripts/diag-wechat-fastlogin.mjs --json          # 额外输出一份机器可读 JSON
 *   node scripts/diag-wechat-fastlogin.mjs --help
 *
 * 不传 --auth-url 时用占位 appid 探测（握手结论依然有效，errcode 可能因 appid 不同而变）。
 * 退出码：0=可用 · 2=仅支持扫一扫(10057) · 3=全不可达 · 1=其它（可达但不可用 / 参数错）。
 *
 * 环境变量：MTNODE_ELECTRON_BIN 指定 electron 可执行文件（默认取本仓 node_modules/electron/dist/electron.exe）。
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const bridge = require(path.join(ROOT, "wechat-fastlogin.js"));

const BRIDGE_HOST = bridge.BRIDGE_HOST || "localhost.weixin.qq.com";
const BRIDGE_ADDR = bridge.BRIDGE_ADDR || "127.0.0.1";
const TIMEOUT_MS = 1500;
const CHECK_PATH = "/api/check-login";

/* ── 参数 ─────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { ports: [], authUrl: "", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--auth-url") out.authUrl = String(argv[++i] || "");
    else if (a.startsWith("--auth-url=")) out.authUrl = a.slice(11);
    else if (a === "--port") out.ports.push(Number(argv[++i]));
    else if (a.startsWith("--port=")) out.ports.push(Number(a.slice(7)));
  }
  out.ports = out.ports.filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
  process.exit(0);
}

/* check-login 请求体：优先从 --auth-url 取真实 appid / redirect_uri，否则占位 */
function buildCtx() {
  const parsed = ARGS.authUrl ? bridge.parseAuthUrl(ARGS.authUrl) : null;
  if (parsed) return { ...parsed, real: true };
  return {
    appid: "diag",
    redirectUri: "https://localhost/diag",
    scope: "snsapi_login",
    state: "",
    real: false,
  };
}

const CTX = buildCtx();
const CHECK_BODY = {
  apiname: "qrconnectchecklogin",
  jsdata: {
    appid: CTX.appid,
    scope: CTX.scope,
    redirect_uri: CTX.redirectUri,
    state: CTX.state,
  },
};
const BODY_BUF = Buffer.from(JSON.stringify(CHECK_BODY), "utf8");
const BODY_B64 = BODY_BUF.toString("base64");

/* ── 小工具 ───────────────────────────────────────────────────────── */

function ms(t0) {
  return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
}

function short(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > (n || 120) ? t.slice(0, (n || 120) - 1) + "…" : t;
}

function run(file, args, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: o.env || process.env });
    } catch (e) {
      return resolve({ code: -1, stdout: "", stderr: String((e && e.message) || e) });
    }
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String((e && e.message) || e) }));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
    }, o.timeoutMs || TIMEOUT_MS + 2500);
    if (timer.unref) timer.unref();
    if (o.input) {
      try {
        child.stdin.end(o.input);
      } catch (_) {}
    } else {
      try {
        child.stdin.end();
      } catch (_) {}
    }
  });
}

function execFileP(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs || 8000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (e, stdout, stderr) => resolve({ err: e, stdout: String(stdout || ""), stderr: String(stderr || "") }),
    );
  });
}

/* ── ① 枚举微信监听端口 ───────────────────────────────────────────── */

const PS_ENUM_PORTS = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$ids = @(Get-Process -Name Weixin,WeChat,WeixinApp,WeChatAppEx | Select-Object -ExpandProperty Id)",
  "if ($ids.Count -eq 0) { Write-Output 'MTNODE_PS_NO_PROC'; exit 0 }",
  "$rows = @()",
  "foreach ($cn in @(Get-NetTCPConnection -State Listen)) { if ($ids -contains $cn.OwningProcess) { $rows += ('{0}|{1}|{2}' -f $cn.OwningProcess, $cn.LocalAddress, $cn.LocalPort) } }",
  "if ($rows.Count -eq 0) {",
  "  foreach ($line in @(netstat -ano -p tcp)) {",
  "    if ($line -match '^\\s*TCP\\s+(\\S+):(\\d+)\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$') {",
  "      $procId = [int]$Matches[3]",
  "      if ($ids -contains $procId) { $rows += ('{0}|{1}|{2}' -f $procId, $Matches[1], $Matches[2]) }",
  "    }",
  "  }",
  "}",
  "$rows | Sort-Object -Unique",
  "Write-Output 'MTNODE_PS_PORTS_END'",
].join("\r\n");

async function enumerateWeixinPorts() {
  const r = await execFileP(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_ENUM_PORTS],
    12000,
  );
  const text = r.stdout || "";
  if (text.includes("MTNODE_PS_NO_PROC")) return { running: false, rows: [] };
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\|(\S+)\|(\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), addr: m[2], port: Number(m[3]) });
  }
  return { running: rows.length > 0, rows };
}

/* ── ② 三种通道的握手探测 ─────────────────────────────────────────── */

const CURL_BIN = bridge.CURL_BIN;
const CURL_MARKER = "\n__MTNODE_HTTP_STATUS__:";

async function probeCurl(port) {
  const t0 = process.hrtime.bigint();
  if (!fs.existsSync(CURL_BIN)) return { channel: "curl", ok: false, error: "未找到 " + CURL_BIN };
  const secs = (TIMEOUT_MS / 1000).toFixed(2);
  const r = await run(
    CURL_BIN,
    [
      "-sS", "-k", "--http1.1",
      "-m", secs, "--connect-timeout", secs,
      "--resolve", BRIDGE_HOST + ":" + port + ":" + BRIDGE_ADDR,
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "--data-binary", "@-",
      "-w", CURL_MARKER + "%{http_code}",
      "https://" + BRIDGE_HOST + ":" + port + CHECK_PATH,
    ],
    { input: BODY_BUF, timeoutMs: TIMEOUT_MS + 2500 },
  );
  const elapsed = ms(t0);
  if (r.code !== 0) return { channel: "curl", ok: false, ms: elapsed, error: short(r.stderr) || "curl 退出码 " + r.code };
  const i = r.stdout.lastIndexOf(CURL_MARKER);
  if (i < 0) return { channel: "curl", ok: false, ms: elapsed, error: "输出缺少状态码" };
  return {
    channel: "curl",
    ok: true,
    ms: elapsed,
    status: Number(r.stdout.slice(i + CURL_MARKER.length).trim()) || 0,
    text: r.stdout.slice(0, i),
  };
}

/* Node 通道：本进程的 node:https（脚本自己用的 TLS 栈） */
function probeNode(port) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve({ channel: "node", ms: ms(t0), ...v });
    };
    let req;
    try {
      req = https.request(
        {
          host: BRIDGE_ADDR,
          family: 4,
          port,
          path: CHECK_PATH,
          method: "POST",
          servername: BRIDGE_HOST,
          ecdhCurve: "P-256",
          rejectUnauthorized: false,
          headers: {
            Host: BRIDGE_HOST + ":" + port,
            "Content-Type": "application/json",
            "Content-Length": BODY_BUF.length,
          },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            done({ ok: true, status: Number(res.statusCode) || 0, text: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", (e) => done({ ok: false, error: short(e && e.message) }));
        },
      );
    } catch (e) {
      return done({ ok: false, error: short(e && e.message) });
    }
    req.on("timeout", () => {
      try {
        req.destroy(new Error("timeout"));
      } catch (_) {}
    });
    req.on("error", (e) => done({ ok: false, error: short(e && e.message) }));
    req.write(BODY_BUF);
    req.end();
  });
}

/* Electron 通道：用应用自带的 electron 以 ELECTRON_RUN_AS_NODE=1 跑同一段 node:https 请求 */
function electronBin() {
  if (process.env.MTNODE_ELECTRON_BIN) return process.env.MTNODE_ELECTRON_BIN;
  const p = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  return fs.existsSync(p) ? p : "";
}

const ELECTRON_SNIPPET = [
  "const https=require('node:https');",
  "const port=Number(process.argv[1]);",
  "const body=Buffer.from(process.argv[2],'base64');",
  "const host='localhost.weixin.qq.com';",
  "const req=https.request({host:'127.0.0.1',family:4,port,path:'/api/check-login',method:'POST',servername:host,ecdhCurve:'P-256',rejectUnauthorized:false,headers:{Host:host+':'+port,'Content-Type':'application/json','Content-Length':body.length},timeout:1500},r=>{const c=[];r.on('data',d=>c.push(d));r.on('end',()=>console.log('MTNODE_ELECTRON:'+JSON.stringify({ok:true,status:r.statusCode,text:Buffer.concat(c).toString('utf8')})))});",
  "req.on('timeout',()=>{try{req.destroy(new Error('timeout'))}catch(e){}});",
  "req.on('error',e=>console.log('MTNODE_ELECTRON:'+JSON.stringify({ok:false,error:String((e&&e.message)||e)})));",
  "req.write(body);req.end();",
].join("");

async function probeElectron(port) {
  const t0 = process.hrtime.bigint();
  const bin = electronBin();
  if (!bin) return { channel: "electron", ok: false, error: "未找到 electron（可用 MTNODE_ELECTRON_BIN 指定）" };
  const r = await run(bin, ["-e", ELECTRON_SNIPPET, String(port), BODY_B64], {
    timeoutMs: TIMEOUT_MS + 6000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const elapsed = ms(t0);
  const i = (r.stdout || "").lastIndexOf("MTNODE_ELECTRON:");
  if (i < 0) {
    return {
      channel: "electron",
      ok: false,
      ms: elapsed,
      error: short(r.stderr) || "electron 无输出（退出码 " + r.code + "）",
    };
  }
  let j = null;
  try {
    j = JSON.parse(r.stdout.slice(i + "MTNODE_ELECTRON:".length).trim());
  } catch (_) {}
  if (!j) return { channel: "electron", ok: false, ms: elapsed, error: "输出不可解析" };
  if (!j.ok) return { channel: "electron", ok: false, ms: elapsed, error: short(j.error) };
  return { channel: "electron", ok: true, ms: elapsed, status: Number(j.status) || 0, text: String(j.text || "") };
}

/* ── ③ 解析 check-login 的 errcode / errmsg ───────────────────────── */

function parseCheck(text) {
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return { json: null, errcode: null, errmsg: "响应不是 JSON", nickname: "" };
  }
  let jd = json && json.jsdata;
  if (typeof jd === "string") {
    try {
      jd = JSON.parse(jd);
    } catch (_) {
      jd = null;
    }
  }
  jd = jd && typeof jd === "object" ? jd : {};
  const errcode = Number.isFinite(Number(json.errcode)) ? Number(json.errcode) : null;
  return {
    json,
    errcode,
    errmsg: String(json.errmsg || "").trim(),
    nickname: String(jd.nickname || json.nickname || "").trim(),
    authorizeUuid: String(jd.authorize_uuid || json.authorize_uuid || "").trim(),
  };
}

/* ── 主流程 ───────────────────────────────────────────────────────── */

const RULE = "─".repeat(72);

async function main() {
  const probe = await enumerateWeixinPorts();
  const all = [];
  const discovered = [...new Set(probe.rows.map((r) => r.port))].sort((a, b) => a - b);

  let ports;
  if (ARGS.ports.length) {
    ports = ARGS.ports;
    console.log("[端口] 使用 --port 指定：" + ports.join(", "));
  } else if (discovered.length) {
    ports = discovered;
    console.log("[端口] 枚举到 Weixin 监听端口：" + ports.join(", "));
  } else {
    ports = bridge.QRCONNECT_PORTS.slice();
    console.log("[端口] 未枚举到 Weixin 监听端口，改探 qrconnect 标准端口表（" + ports.length + " 个）");
  }
  for (const row of probe.rows) {
    console.log("        pid " + row.pid + "  " + row.addr + ":" + row.port);
  }
  if (!probe.running) console.log("[端口] 未发现 Weixin / WeChat 进程在监听");
  console.log(
    "[请求] appid=" +
      CTX.appid +
      "  redirect_uri=" +
      CTX.redirectUri +
      (CTX.real ? "" : "  （占位参数：未传 --auth-url，errcode 可能因 appid 不同而变）"),
  );
  console.log("");

  for (const port of ports) {
    console.log(RULE);
    console.log("端口 " + port);
    const results = await Promise.all([probeCurl(port), probeNode(port), probeElectron(port)]);
    const entry = { port, channels: {} };
    let portErrcode = null;
    let portErrmsg = "";
    let portNickname = "";

    for (const r of results) {
      const tag = r.channel.padEnd(8);
      if (!r.ok) {
        console.log("  " + tag + " 握手失败  " + (r.ms != null ? r.ms + "ms  " : "") + r.error);
        entry.channels[r.channel] = { ok: false, error: r.error, ms: r.ms };
        continue;
      }
      const parsed = parseCheck(r.text);
      entry.channels[r.channel] = {
        ok: true,
        status: r.status,
        ms: r.ms,
        errcode: parsed.errcode,
        errmsg: parsed.errmsg,
      };
      const tail =
        parsed.errcode == null
          ? "  " + parsed.errmsg
          : "  errcode=" + parsed.errcode + (parsed.errmsg ? "  errmsg=" + parsed.errmsg : "");
      console.log("  " + tag + "握手成功  HTTP " + r.status + "  " + r.ms + "ms" + tail);
      if (parsed.errcode != null && portErrcode === null) {
        portErrcode = parsed.errcode;
        portErrmsg = parsed.errmsg;
        portNickname = parsed.nickname;
      }
    }
    entry.errcode = portErrcode;
    entry.errmsg = portErrmsg;
    all.push(entry);
  }

  console.log(RULE);

  /* 归因：10057 优先，其次任意非 0 errcode，最后按可达性 */
  const withCode = all.filter((e) => e.errcode !== null && e.errcode !== undefined);
  const hit10057 = withCode.find((e) => e.errcode === 10057);
  const hit0 = withCode.find((e) => e.errcode === 0);
  const anyChannelOk = all.some((e) => Object.values(e.channels).some((c) => c.ok));

  let conclusion;
  let exitCode;
  if (hit0) {
    conclusion = "errcode=0  本机桥可用（快捷登录可用）";
    exitCode = 0;
  } else if (hit10057) {
    conclusion = "errcode=10057  微信侧仅支持扫一扫（端口 " + hit10057.port + "：" + (hit10057.errmsg || "无 errmsg") + "）";
    exitCode = 2;
  } else if (!anyChannelOk) {
    conclusion = probe.running
      ? "全不可达：微信在运行，但所探端口均无应答（握手失败）"
      : "全不可达：微信未运行（或非 PC 版 / 端口表无应答）";
    exitCode = 3;
  } else {
    const e = withCode[0];
    conclusion = "本机桥可达但不可用（端口 " + (e ? e.port : "?") + "  errcode=" + (e ? e.errcode : "?") + "  " + ((e && e.errmsg) || "无 errmsg") + "）";
    exitCode = 1;
  }
  console.log("结论: " + conclusion);

  if (ARGS.json) {
    console.log("");
    console.log(
      JSON.stringify(
        {
          weixinRunning: probe.running,
          processes: probe.rows,
          ctx: { appid: CTX.appid, redirectUri: CTX.redirectUri, real: CTX.real },
          ports: all,
          conclusion,
          exitCode,
        },
        null,
        2,
      ),
    );
  }
  process.exitCode = exitCode;
}

main().catch((e) => {
  console.error("诊断失败：" + String((e && e.stack) || e));
  process.exitCode = 1;
});

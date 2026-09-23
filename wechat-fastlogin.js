"use strict";
/* 微信 PC 客户端「快捷登录」（fast login）本机桥调用 —— 纯主进程、零新依赖。
 *
 * 背景：微信 PC 客户端在已登录状态下，会在本机回环地址起一个 HTTPS 服务
 * （https://localhost.weixin.qq.com:<port>/api/...）。开放平台 qrconnect 页面
 * 先 POST /api/check-login 探测端口与登录态，拿到 authorize_uuid 后 POST
 * /api/authorize（apiname=qrconnectfastauthorize）完成「一键授权」，其返回的
 * jsdata.redirect_url 即带 code 的回调地址。
 *
 * 传输层（bridgeTransport）：本机桥是微信自签证书，且只认 localhost.weixin.qq.com 的
 * SNI / Host；Node 自带 TLS 对它握手不稳（实测 BoringSSL 握手失败）。因此按可用性
 * 选择通道，同一个通道承接全部桥请求：
 *   ① %SystemRoot%\System32\curl.exe —— Schannel，实测可握手。spawn 传
 *      --data-binary @- 走 stdin（不落盘）、-k、-m 超时、
 *      --resolve localhost.weixin.qq.com:<port>:127.0.0.1，解析 stdout JSON；
 *   ② PowerShell 5.1 + System.Net.Http.HttpClient —— Schannel + Tls12，
 *      ServerCertificateCustomValidationCallback 放行本机自签证书。
 *      实测口径：部分 Weixin 版本的本机桥会拒绝 .NET Framework 的 ClientHello
 *      （「由于远程方已关闭传输流，身份验证失败」），故此路只是「curl 不存在时」的
 *      尽力回退；能否握手由 scripts/diag-wechat-fastlogin.mjs 现场判定。
 *   ③ node:https —— 仅对标准证书端点有效（我们自己的服务端回调走这条路，见 requestCallback）。
 *   排查时可设 MTNODE_WECHAT_BRIDGE_TRANSPORT=curl|powershell|node 钉死单个通道。
 *
 * 本模块把这段流程搬到主进程，渲染层只拿结构化结果：
 *   run({ authUrl }) -> { ok, status, errcode, errmsg, nickname, port, error? }
 *   status: confirmed   已授权，回调已请求（服务端换 code 并写 dev.ticket，客户端轮询照旧）
 *           unsupported 本机桥可达，但快捷登录不可用（未登录 / 版本不支持 / 已拒绝）
 *           unreachable 端口表里没有任何端口响应（微信未运行或非 PC 版）
 *           error       参数或流程出错（authUrl 无效 / 回调跨域等）
 *   port / errcode / errmsg 是**归因结果**：端口并发探测后按优先级挑最终原因——
 *   errcode 10057（微信侧仅支持扫一扫）优先，不被其它端口的噪声错误码
 *   （如 14016 的 -11028 invalid apiname）覆盖；errmsg 原样带出供渲染层如实展示。
 *
 * 安全口径（刻意不做的事）：
 *   - 只连回环地址 127.0.0.1 与 https，Host / SNI 固定 localhost.weixin.qq.com；
 *   - 回调只允许与 authUrl 里 redirect_uri 同主机，不跟随跨域跳转、不跟随 3xx；
 *   - 不落盘任何微信数据，不缓存 authorize_uuid / code。
 */

const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");
const { spawn, execFile } = require("node:child_process");
const https = require("node:https");
const http = require("node:http");

const BRIDGE_HOST = "localhost.weixin.qq.com"; // 仅用于 Host / SNI，连接一律走 127.0.0.1
const BRIDGE_ADDR = "127.0.0.1";

/* qrconnect 页的端口表：微信 PC 客户端按此顺序尝试监听（端口被占用则顺延）。
 * 并发探测全部端口，第一个 confirmed 者即「实际监听端口」。 */
const QRCONNECT_PORTS = [
  13013,
  14013, 14014, 14015, 14016, 14017, 14018, 14019, 14020,
  14021, 14022, 14023, 14024, 14025, 14026, 14027, 14028,
  14029, 14030,
];

const PORT_TIMEOUT = 1200; // 1.2s / 端口（并发探测，无需干等 3s）
const CALLBACK_TIMEOUT = 8000;
const MAX_BODY = 1024 * 1024;

const CURL_BIN = path.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32",
  "curl.exe",
);
const CURL_MARKER = "\n__MTNODE_HTTP_STATUS__:";
const PS_MARKER = "MTNODE_PS_JSON:";

/* ── 小工具 ───────────────────────────────────────────────────────── */

function msg(e) {
  return String((e && e.message) || e || "");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/* 本机桥的 jsdata 有时是对象、有时是 JSON 字符串，统一成对象 */
function pickJsdata(obj) {
  if (!obj || typeof obj !== "object") return {};
  let d = obj.jsdata;
  if (typeof d === "string") d = parseJson(d);
  return d && typeof d === "object" ? d : {};
}

function toInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/* 从 qrconnect 授权地址里取 appid / scope / redirect_uri / state */
function parseAuthUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ""));
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const appid = String(u.searchParams.get("appid") || "").trim();
  const redirectUri = String(u.searchParams.get("redirect_uri") || "").trim();
  if (!appid || !redirectUri) return null;
  return {
    appid,
    redirectUri,
    scope: String(u.searchParams.get("scope") || "").trim() || "snsapi_login",
    state: String(u.searchParams.get("state") || "").trim(),
  };
}

/* ── 通道 ①：curl.exe（Schannel） ─────────────────────────────────── */

function curlAvailable() {
  try {
    return fs.statSync(CURL_BIN).isFile();
  } catch (_) {
    return false;
  }
}

function curlPost(port, pathname, body, timeoutMs) {
  return new Promise((resolve) => {
    const secs = (Math.max(200, timeoutMs) / 1000).toFixed(2);
    const url = "https://" + BRIDGE_HOST + ":" + port + pathname;
    const args = [
      "-sS",
      "-k",
      "--http1.1",
      "-m", secs,
      "--connect-timeout", secs,
      "--resolve", BRIDGE_HOST + ":" + port + ":" + BRIDGE_ADDR,
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "--data-binary", "@-",
      "-w", CURL_MARKER + "%{http_code}",
      url,
    ];
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(CURL_BIN, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return done({ ok: false, error: "curl 启动失败：" + msg(e) });
    }
    const out = [];
    const err = [];
    let size = 0;
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY + 4096) out.push(c);
    });
    child.stderr.on("data", (c) => {
      if (err.length < 64) err.push(c);
    });
    child.on("error", (e) => done({ ok: false, error: "curl 不可用：" + msg(e) }));
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code !== 0) {
        return done({ ok: false, error: stderr || ("curl 退出码 " + code) });
      }
      const i = stdout.lastIndexOf(CURL_MARKER);
      if (i < 0) return done({ ok: false, error: "curl 输出缺少状态码" });
      done({
        ok: true,
        status: toInt(stdout.slice(i + CURL_MARKER.length).trim(), 0),
        text: stdout.slice(0, i),
      });
    });
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
    }, timeoutMs + 800);
    if (killTimer.unref) killTimer.unref();
    try {
      child.stdin.end(Buffer.from(JSON.stringify(body || {}), "utf8"));
    } catch (_) {}
  });
}

/* ── 通道 ②：PowerShell 5.1 + HttpClient（Schannel + Tls12） ──────── */

/* 本机桥域名由微信 DNS 解析到 127.0.0.1；若本机解析不到回环地址就跳过该通道，
 * 避免把请求发去外部 IP（守「只连回环地址」口径）。解析带 1.5s 上限：
 * 某些环境 DNS 要 40s+ 才超时，不能为了这道守卫把主流程拖住
 * （curl 通道不解析 DNS，走 --resolve，所以只在 curl 缺席时才会走到这里）。 */
let psAllowedCache = null;
function psAllowed() {
  if (psAllowedCache !== null) return Promise.resolve(psAllowedCache);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v, cache) => {
      if (settled) return;
      settled = true;
      if (cache) psAllowedCache = v;
      resolve(v);
    };
    const timer = setTimeout(() => finish(false, false), 1500);
    if (timer.unref) timer.unref();
    dns.lookup(BRIDGE_HOST, { family: 4 }, (err, addr) => {
      clearTimeout(timer);
      finish(!err && String(addr) === BRIDGE_ADDR, true);
    });
  });
}

function psPost(port, pathname, body, timeoutMs) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(JSON.stringify(body || {}), "utf8").toString("base64");
    const url = "https://" + BRIDGE_HOST + ":" + port + pathname;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$out = $null",
      "try {",
      "  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
      "  Add-Type -AssemblyName System.Net.Http",
      "  $body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
      "  $h = New-Object System.Net.Http.HttpClientHandler",
      "  $h.AllowAutoRedirect = $false",
      "  $h.UseProxy = $false",
      "  $h.ServerCertificateCustomValidationCallback = { param($m, $c, $ch, $e) return $true }",
      "  $c = New-Object System.Net.Http.HttpClient($h)",
      "  $c.Timeout = [TimeSpan]::FromMilliseconds(" + Math.round(timeoutMs) + ")",
      "  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, '" + url + "')",
      "  $req.Content = New-Object System.Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json')",
      "  $r = $c.SendAsync($req).GetAwaiter().GetResult()",
      "  $t = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()",
      "  $out = @{ ok = $true; status = [int]$r.StatusCode; text = $t }",
      "} catch {",
      "  $out = @{ ok = $false; status = 0; text = ''; error = $_.Exception.Message }",
      "}",
      "$json = $out | ConvertTo-Json -Compress -Depth 4",
      "Write-Output ('" + PS_MARKER + "' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
    ].join("\r\n");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: timeoutMs + 3000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (e, stdout, stderr) => {
        const text = String(stdout || "");
        const i = text.lastIndexOf(PS_MARKER);
        if (i < 0) {
          return resolve({
            ok: false,
            error: "PowerShell 不可用：" + (String(stderr || "").trim() || msg(e) || "无输出"),
          });
        }
        let j = null;
        try {
          j = parseJson(Buffer.from(text.slice(i + PS_MARKER.length).trim(), "base64").toString("utf8"));
        } catch (_) {}
        if (!j) return resolve({ ok: false, error: "PowerShell 返回不可解析" });
        if (!j.ok) return resolve({ ok: false, error: String(j.error || "PowerShell 请求失败") });
        resolve({ ok: true, status: toInt(j.status, 0), text: String(j.text || "") });
      },
    );
  });
}

/* ── 通道 ③：node:https（仅标准证书端点有效） ─────────────────────── */

function nodePost(port, pathname, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body || {}), "utf8");
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let req;
    try {
      req = https.request(
        {
          host: BRIDGE_ADDR, // 只连回环地址，不解析外部 DNS
          family: 4,
          port,
          path: pathname,
          method: "POST",
          servername: BRIDGE_HOST, // 关键：桥只认 localhost.weixin.qq.com
          ecdhCurve: "P-256", // 关键：桥只认 P-256；Node 默认 ClientHello 也含 P-256 故可握手
          rejectUnauthorized: false, // 本机桥是微信自签证书，仅回环地址、非外部信任链
          headers: {
            Host: BRIDGE_HOST + ":" + port,
            "Content-Type": "application/json",
            "Content-Length": payload.length,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (c) => {
            size += c.length;
            if (size <= MAX_BODY) chunks.push(c);
          });
          res.on("end", () =>
            done({
              ok: true,
              status: toInt(res.statusCode, 0),
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", (e) => done({ ok: false, error: msg(e) }));
        },
      );
    } catch (e) {
      return done({ ok: false, error: msg(e) });
    }
    req.on("timeout", () => {
      try {
        req.destroy(new Error("timeout"));
      } catch (_) {}
    });
    req.on("error", (e) => done({ ok: false, error: msg(e) }));
    req.write(payload);
    req.end();
  });
}

/* ── bridgeTransport：按可用性挑通道（curl > PowerShell > node） ────── */

let transportsPromise = null;

/* 排查用：MTNODE_WECHAT_BRIDGE_TRANSPORT=curl|powershell|node 钉死单个通道，默认自动回退 */
function pinnedTransport() {
  return String(process.env.MTNODE_WECHAT_BRIDGE_TRANSPORT || "").trim().toLowerCase();
}

/* 通道表：curl（Schannel）> PowerShell（Schannel）> node:https（仅标准端点） */
const TRANSPORTS = {
  curl: { name: "curl", post: curlPost },
  powershell: { name: "powershell", post: psPost },
  node: { name: "node", post: nodePost },
};

async function buildTransports() {
  const pin = pinnedTransport();
  if (pin && TRANSPORTS[pin]) return [TRANSPORTS[pin]]; // 排查模式：钉死单个通道
  /* 按「可用性」选通道（不是按失败回退）：curl 在就用 curl；curl 缺席才起 PowerShell；
   * 两者都不在才用 node:https —— 桥不是标准证书端点，node 通道对它本就无效。 */
  if (curlAvailable()) return [TRANSPORTS.curl];
  if (await psAllowed()) return [TRANSPORTS.powershell];
  return [TRANSPORTS.node];
}

function getTransports() {
  if (!transportsPromise) transportsPromise = buildTransports();
  return transportsPromise;
}

async function bridgePost(port, pathname, body, timeoutMs) {
  const to = toInt(timeoutMs, PORT_TIMEOUT) || PORT_TIMEOUT;
  const list = await getTransports();
  let lastError = "";
  for (const t of list) {
    const r = await t.post(port, pathname, body, to);
    if (r && r.ok) return r;
    lastError = (r && r.error) || t.name + " 通道失败";
  }
  return { ok: false, error: lastError };
}

/* ── 回调：GET 微信返回的 redirect_url（同主机才允许；保留 node:https） ─ */

function requestCallback(redirectUrl, expectedRedirectUri) {
  return new Promise((resolve) => {
    let target;
    let expect;
    try {
      target = new URL(String(redirectUrl || ""));
      expect = new URL(String(expectedRedirectUri || ""));
    } catch (_) {
      return resolve({ ok: false, error: "redirect_url 无效" });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return resolve({ ok: false, error: "回调仅支持 http(s)" });
    }
    if (target.hostname.toLowerCase() !== expect.hostname.toLowerCase()) {
      return resolve({ ok: false, error: "拒绝跨域跳转：" + target.hostname });
    }
    const mod = target.protocol === "https:" ? https : http;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let req;
    try {
      req = mod.request(
        {
          host: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: target.pathname + target.search,
          method: "GET",
          timeout: CALLBACK_TIMEOUT,
          headers: { "User-Agent": "MTNode" },
        },
        (res) => {
          res.resume(); // 丢弃响应体（服务端在回调里换 code / 写 ticket）
          res.on("end", () => done({ ok: true, status: toInt(res.statusCode, 0) }));
          res.on("error", (e) => done({ ok: false, error: msg(e) }));
        },
      );
    } catch (e) {
      return done({ ok: false, error: msg(e) });
    }
    req.on("timeout", () => {
      try {
        req.destroy(new Error("timeout"));
      } catch (_) {}
    });
    req.on("error", (e) => done({ ok: false, error: msg(e) }));
    req.end();
  });
}

/* ── 单端口探测 + 授权（每个端口都回 { port, reachable, errcode, errmsg }） ─ */

async function probePort(port, ctx) {
  const check = await bridgePost(port, "/api/check-login", {
    apiname: "qrconnectchecklogin",
    jsdata: {
      appid: ctx.appid,
      scope: ctx.scope,
      redirect_uri: ctx.redirectUri,
      state: ctx.state,
    },
  });
  if (!check.ok) {
    return { port, reachable: false, errcode: null, errmsg: check.error || "", nickname: "" };
  }

  const json = parseJson(check.text);
  if (!json) {
    return { port, reachable: true, status: "unsupported", errcode: -1, errmsg: "本机桥返回非 JSON", nickname: "" };
  }

  const jd = pickJsdata(json);
  const errcode = toInt(json.errcode, -1);
  const errmsg = String(json.errmsg || "").trim();
  const nickname = String(jd.nickname || json.nickname || "").trim();
  const uuid = String(jd.authorize_uuid || json.authorize_uuid || "").trim();
  if (errcode !== 0 || !uuid) {
    return { port, reachable: true, status: "unsupported", errcode, errmsg, nickname };
  }

  const auth = await bridgePost(port, "/api/authorize", {
    apiname: "qrconnectfastauthorize",
    jsdata: {
      data: JSON.stringify({ x: 0, y: 0 }),
      appid: ctx.appid,
      scope: ctx.scope,
      redirect_uri: ctx.redirectUri,
      state: ctx.state,
      authorize_uuid: uuid,
    },
  });
  if (!auth.ok) {
    return { port, reachable: true, status: "error", errcode: -1, errmsg: auth.error || "", nickname };
  }
  const ajson = parseJson(auth.text);
  if (!ajson) {
    return { port, reachable: true, status: "error", errcode: -1, errmsg: "授权返回非 JSON", nickname };
  }
  const ajd = pickJsdata(ajson);
  const aerr = toInt(ajson.errcode, -1);
  const aerrmsg = String(ajson.errmsg || "").trim();
  const redirectUrl = String(ajd.redirect_url || ajd.redirectUrl || ajson.redirect_url || "").trim();
  if (aerr !== 0 || !redirectUrl) {
    return {
      port,
      reachable: true,
      status: "unsupported",
      errcode: aerr,
      errmsg: aerrmsg,
      nickname: String(ajd.nickname || nickname || "").trim(),
    };
  }

  const cb = await requestCallback(redirectUrl, ctx.redirectUri);
  if (!cb.ok) {
    return { port, reachable: true, status: "error", errcode: -1, errmsg: cb.error || "", nickname };
  }
  return { port, reachable: true, status: "confirmed", errcode: 0, errmsg: "", nickname };
}

/* 归因优先级：10057（微信侧仅支持扫一扫）最高；-11028 invalid apiname 只是噪声，压低 */
function causeRank(r) {
  const c = toInt(r && r.errcode, -1);
  if (c === 10057) return 4;
  if (c === -11028) return 2;
  if (c === -1 || c === 0) return 1;
  return 3;
}

function pickFinalCause(records) {
  let best = null;
  for (const r of records) {
    if (!best || causeRank(r) > causeRank(best)) best = r;
  }
  return best || null;
}

/* ── 对外入口 ────────────────────────────────────────────────────── */

async function run(opts) {
  const ctx = parseAuthUrl(opts && opts.authUrl);
  if (!ctx) {
    return {
      ok: false,
      status: "error",
      errcode: -1,
      errmsg: "",
      nickname: "",
      port: 0,
      error: "authUrl 无效或缺少 appid / redirect_uri",
    };
  }

  /* 端口并发探测：单端口 1.2s 超时，不再逐个干等 3s */
  const results = await Promise.all(QRCONNECT_PORTS.map((port) => probePort(port, ctx)));
  const reachable = results.filter((r) => r && r.reachable);
  const nicknameOf = (rs) => {
    for (const r of rs) if (r && r.nickname) return r.nickname;
    return "";
  };

  const confirmed = reachable.find((r) => r.status === "confirmed");
  if (confirmed) {
    return {
      ok: true,
      status: "confirmed",
      errcode: 0,
      errmsg: "",
      nickname: confirmed.nickname || nicknameOf(reachable),
      port: confirmed.port,
    };
  }

  if (!reachable.length) {
    return { ok: false, status: "unreachable", errcode: -1, errmsg: "", nickname: "", port: 0, error: "" };
  }

  const cause = pickFinalCause(reachable) || reachable[0];
  return {
    ok: false,
    status: "unsupported",
    errcode: toInt(cause.errcode, -1),
    errmsg: cause.errmsg || "",
    nickname: cause.nickname || nicknameOf(reachable),
    port: cause.port,
    error: cause.errmsg || "",
  };
}

module.exports = {
  run,
  // 仅供主进程内部排查 / 诊断脚本使用
  QRCONNECT_PORTS,
  parseAuthUrl,
  bridgePost,
  PORT_TIMEOUT,
  BRIDGE_HOST,
  BRIDGE_ADDR,
  CURL_BIN,
};

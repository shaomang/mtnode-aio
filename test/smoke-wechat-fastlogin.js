/* test/smoke-wechat-fastlogin.js — 本机微信「免扫码登录」桥调用回归
 * ============================================================================
 * 运行：node test/smoke-wechat-fastlogin.js
 *
 * 背景：微信 PC 客户端在本机回环地址起一个 HTTPS 桥（localhost.weixin.qq.com），
 * 其 TLS 只接受 P-256（secp256r1）密钥交换，且只认该 SNI/Host。Electron/BoringSSL
 * 的 ClientHello 以 X25519 开头 → 实测全部握手失败，因此 wechat-fastlogin.js 必须
 * 走系统 Schannel（curl.exe）通道。本测试用本地自签 P-256 假桥复刻现场：
 *   · 假桥（https.createServer，ecdhCurve:'P-256'）实现 /api/check-login 与 /api/authorize
 *   · 假回调服务接收 GET（微信 authorize 返回的 redirect_url 指向它）
 * 断言：
 *   [1] 静态：导出 run，且桥调用走 curl 通道
 *   [2] 正常：curl 通道握手 → check-login 拿到 authorize_uuid → 调 authorize → GET 回调命中
 *   [3] 10057：status=unsupported + errcode=10057 + 不发 authorize，且不被其它端口 -11028 覆盖
 *   [4] P-256 约束：X25519-only 客户端被假桥拒绝（钉住桥只认 P-256）
 * ============================================================================
 */
"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

/* 先钉死 curl 通道（Schannel），避免机器上 curl 缺失时静默走 node:https 导致断言无意义 */
process.env.MTNODE_WECHAT_BRIDGE_TRANSPORT = "curl";

const ROOT = path.join(__dirname, "..");
const fastlogin = require(path.join(ROOT, "wechat-fastlogin.js"));
const { QRCONNECT_PORTS, CURL_BIN } = fastlogin;

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

/* ── 自签 P-256 测试证书（仅本测试用，随文件内联，不落盘、不入库） ─────────── */
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsgFx+77ZeCAHajV1
Lo7MkKkFzvh37gxF1jlq+crw0pGhRANCAARNIwx82MSeqatGWj5w2UQH/jXsk1Jh
TU7XOe4iiPCXpCdrULuzsD4Y2WamoIcDAEnODDmqcravXF/sRJCmRYhG
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUeFejR8Fd+x3N4wPvvrakcCEy4cMwCgYIKoZIzj0EAwIw
IjEgMB4GA1UEAwwXbG9jYWxob3N0LndlaXhpbi5xcS5jb20wHhcNMjYwOTA5MTIw
MjM2WhcNMzYwOTA2MTIwMjM2WjAiMSAwHgYDVQQDDBdsb2NhbGhvc3Qud2VpeGlu
LnFxLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABE0jDHzYxJ6pq0ZaPnDZ
RAf+NeyTUmFNTtc57iKI8JekJ2tQu7OwPhjZZqaghwMASc4MOapytq9cX+xEkKZF
iEajUzBRMB0GA1UdDgQWBBTIdGZiGq2vVopujJjBIxJj6Ylm4jAfBgNVHSMEGDAW
gBTIdGZiGq2vVopujJjBIxJj6Ylm4jAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIEziSESilV+WbmQPbwj1Htc/CW8qOZ4XsMVxhohfHdB7AiEAjDG4
Ir1u15/IdZkjrJKahlZsOnglSiNJFmrvgZIbuVQ=
-----END CERTIFICATE-----`;

/* ── 小工具 ───────────────────────────────────────────────────────── */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
}

/* 在 qrconnect 端口表里找一个空闲端口起 https 假桥（真实微信占用的端口会被跳过） */
function startFakeBridge(handler) {
  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { key: TEST_KEY, cert: TEST_CERT, ecdhCurve: "P-256" },
      handler,
    );
    let i = 0;
    const tryNext = () => {
      if (i >= QRCONNECT_PORTS.length) return reject(new Error("qrconnect 端口表全部被占用"));
      const port = QRCONNECT_PORTS[i++];
      server.once("error", tryNext);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", tryNext);
        resolve({ server, port });
      });
    };
    tryNext();
  });
}

function listenHttp(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    try {
      if (server.closeAllConnections) server.closeAllConnections();
    } catch {}
    server.close(() => resolve());
  });
}

/* ── 主流程 ───────────────────────────────────────────────────────── */

(async function main() {
  console.log("[1] 静态断言：wechat-fastlogin.js 走 curl（Schannel）通道");
  const src = fs.readFileSync(path.join(ROOT, "wechat-fastlogin.js"), "utf8");
  ok(typeof fastlogin.run === "function", "导出 run()");
  ok(/function curlPost/.test(src) && /spawn\(CURL_BIN, args/.test(src), "桥调用实现 curl 通道");
  ok(
    /"--resolve",\s*BRIDGE_HOST \+ ":" \+ port \+ ":" \+ BRIDGE_ADDR/.test(src),
    "curl 用 --resolve 把 localhost.weixin.qq.com 钉到 127.0.0.1（只连回环）",
  );
  ok(/Promise\.all\(QRCONNECT_PORTS\.map/.test(src), "端口并发探测");
  ok(
    fs.existsSync(CURL_BIN),
    "本机存在 curl.exe（" + CURL_BIN + "，Win10 1803+ 系统自带）",
  );

  /* ── [2] 正常流程 ─────────────────────────────────────────────── */
  console.log("\n[2] 正常流程：P-256 自签假桥 → authorize_uuid → authorize → 回调命中");

  const cbHits = [];
  const cbServer = http.createServer((req, res) => {
    cbHits.push(req.url);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  const cbPort = await listenHttp(cbServer);
  const cbUrl = "http://127.0.0.1:" + cbPort + "/api/auth/wechat/callback";

  const seen = { check: 0, authorize: 0, authorizeBody: "" };
  const bridge2 = await startFakeBridge(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/check-login") {
      seen.check++;
      return sendJson(res, 200, {
        errcode: 0,
        errmsg: "",
        jsdata: { nickname: "测试用户", authorize_uuid: "uuid-abc-123" },
      });
    }
    if (req.url === "/api/authorize") {
      seen.authorize++;
      seen.authorizeBody = body;
      return sendJson(res, 200, {
        errcode: 0,
        errmsg: "",
        jsdata: { redirect_url: cbUrl + "?code=CODE123&state=st123" },
      });
    }
    return sendJson(res, 404, { errcode: -1, errmsg: "not found" });
  });

  const authUrl =
    "https://open.weixin.qq.com/connect/qrconnect?appid=wxtest123&redirect_uri=" +
    encodeURIComponent(cbUrl) +
    "&response_type=code&scope=snsapi_login&state=st123";

  const r2 = await fastlogin.run({ authUrl });
  ok(r2.ok === true && r2.status === "confirmed", "status=confirmed（curl 通道握手成功并完成授权）");
  ok(r2.port === bridge2.port, "归因端口＝假桥端口 " + bridge2.port + "（实测 " + r2.port + "）");
  ok(r2.nickname === "测试用户", "带出 nickname：" + r2.nickname);
  ok(seen.check >= 1, "假桥收到 /api/check-login");
  ok(seen.authorize >= 1, "假桥收到 /api/authorize（拿到 authorize_uuid 后才发）");
  ok(/uuid-abc-123/.test(seen.authorizeBody), "authorize 请求带 authorize_uuid");
  ok(
    cbHits.length >= 1 && /code=CODE123/.test(cbHits.join(" ")),
    "回调服务收到 GET（redirect_url 命中：" + (cbHits[0] || "") + "）",
  );

  await close(bridge2.server);
  await close(cbServer);

  /* ── [3] 10057 归因 ──────────────────────────────────────────── */
  console.log("\n[3] 10057：status=unsupported + errcode=10057，不发 authorize，且不被 -11028 覆盖");

  const seen3 = { authorize: 0 };
  const bridge10057 = await startFakeBridge(async (req, res) => {
    await readBody(req);
    if (req.url === "/api/check-login") {
      return sendJson(res, 200, { errcode: 10057, errmsg: "系统错误，错误码:10057" });
    }
    if (req.url === "/api/authorize") {
      seen3.authorize++;
      return sendJson(res, 200, { errcode: 0, jsdata: { redirect_url: cbUrl } });
    }
    return sendJson(res, 404, { errcode: -1, errmsg: "not found" });
  });
  /* 第二个假桥端口只回 -11028 invalid apiname（噪声）：最终原因仍须是 10057 */
  const bridgeNoise = await startFakeBridge(async (req, res) => {
    await readBody(req);
    return sendJson(res, 200, { errcode: -11028, errmsg: "invalid apiname" });
  });

  const r3 = await fastlogin.run({ authUrl });
  ok(r3.ok === false && r3.status === "unsupported", "status=unsupported");
  ok(r3.errcode === 10057, "errcode=10057（未被其它端口的 -11028 覆盖，实测 " + r3.errcode + "）");
  ok(/10057/.test(String(r3.errmsg)), "errmsg 原样带出：" + r3.errmsg);
  ok(seen3.authorize === 0, "errcode≠0 时不发 /api/authorize（不做无谓授权）");

  await close(bridge10057.server);
  await close(bridgeNoise.server);

  /* ── [4] P-256 约束 ──────────────────────────────────────────── */
  console.log("\n[4] 假桥只认 P-256：X25519-only 客户端被拒（钉住桥的曲线约束）");

  const bridge4 = await startFakeBridge(async (req, res) => {
    await readBody(req);
    return sendJson(res, 200, { errcode: 0, jsdata: { authorize_uuid: "u" } });
  });

  const x25519Result = await new Promise((resolve) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: bridge4.port,
        path: "/api/check-login",
        method: "POST",
        servername: "localhost.weixin.qq.com",
        ecdhCurve: "X25519", // 只提供 X25519
        rejectUnauthorized: false,
        timeout: 3000,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ ok: true }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    req.end();
  });
  ok(x25519Result.ok === false, "X25519-only 客户端握手被拒（" + (x25519Result.error || "?") + "）");

  const p256Result = await new Promise((resolve) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: bridge4.port,
        path: "/api/check-login",
        method: "POST",
        servername: "localhost.weixin.qq.com",
        ecdhCurve: "P-256", // 与 wechat-fastlogin.js 一致
        rejectUnauthorized: false,
        timeout: 3000,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ ok: true, status: res.statusCode }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    req.end();
  });
  ok(p256Result.ok === true, "P-256 客户端握手成功（对照组）");

  await close(bridge4.server);

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-wechat-fastlogin)"
      : "\n✓ " + checks + " 项全部通过  (smoke-wechat-fastlogin)",
  );
  process.exitCode = fails ? 1 : 0;
})().catch((e) => {
  console.log("FAIL  运行异常：" + ((e && e.stack) || e));
  process.exitCode = 1;
});

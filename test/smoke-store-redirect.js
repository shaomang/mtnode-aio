/* test/smoke-store-redirect.js — storeRequest 重定向语义回归
 * ============================================================================
 * 运行：node test/smoke-store-redirect.js
 *
 * 背景（真实故障）：nginx 上线 SSL 后对 http://mt-agent.com 做 301 → https://www.mt-agent.com，
 * 而主进程 storeRequest 用全局 fetch（undici 默认跟随重定向会把 POST 降级成 GET），
 * 服务端只剩 GET 路由缺失 → 404 {"ok":false,"error":"not found"}，界面显示 not found
 * （微信二维码 / 短信 / 密码登录、auth:bind/unbind、论坛发帖等所有 POST 全受影响）。
 *
 * 本测试不 require main.js（它 require electron），而是从 main.js 里抽出真实
 * `storeRequest` 函数源码，注入 fetch / STORE_BASE / I18n / authStore 后执行，
 * 起两个本地 http 服务复刻现场：
 *   · 目标服务只接受 POST /echo（GET 一律 404 not found）
 *   · 跳转服务按 /301 /302 /303 /307 /308 发对应状态码到目标；/rel301 发相对 Location；
 *     /loop 自我循环（验证跳数上限）
 * 断言：所有跳转后仍以 POST + 原 body + 原 Content-Type 到达目标（未降级）。
 * ============================================================================
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

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

function listen(server) {
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

/* 从 main.js 抽出 storeRequest 源码并注入依赖（main.js 无法在纯 node 下 require） */
function loadStoreRequest(storeBase) {
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const start = mainSrc.indexOf("async function storeRequest");
  const end = mainSrc.indexOf('ipcMain.handle("store:request"', start);
  if (start < 0 || end <= start) return null;
  const src = mainSrc.slice(start, end);
  const factory = new Function("fetch", "STORE_BASE", "I18n", "authStore", src + "\nreturn storeRequest;");
  return {
    src,
    fn: factory(globalThis.fetch, storeBase, { t: (s) => s }, { load: () => null }),
  };
}

(async function main() {
  console.log("[1] 本地起「只接受 POST」目标服务 + 301/302/303/307/308 跳转服务");

  /* 目标服务：POST /echo 回显 method / body / content-type；GET 一律 404 not found */
  const target = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method !== "POST" || req.url !== "/echo") {
      return sendJson(res, 404, { ok: false, error: "not found" });
    }
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    sendJson(res, 200, {
      ok: true,
      method: req.method,
      body: parsed,
      raw: body,
      ct: String(req.headers["content-type"] || ""),
    });
  });
  const tPort = await listen(target);

  /* 跳转服务 */
  const redir = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const p = req.url;
    const m = /^\/(301|302|303|307|308)$/.exec(p);
    if (m) {
      res.writeHead(Number(m[1]), { Location: "http://127.0.0.1:" + tPort + "/echo" });
      return res.end();
    }
    if (p === "/rel301") {
      res.writeHead(301, { Location: "/echo" });
      return res.end();
    }
    if (p === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      return res.end();
    }
    if (p === "/echo") {
      if (req.method !== "POST") return sendJson(res, 404, { ok: false, error: "not found" });
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      return sendJson(res, 200, { ok: true, method: req.method, body: parsed });
    }
    return sendJson(res, 404, { ok: false, error: "not found" });
  });
  const rPort = await listen(redir);

  const loaded = loadStoreRequest("http://127.0.0.1:" + rPort);
  ok(!!loaded, "已从 main.js 抽出 storeRequest 源码");
  if (!loaded) {
    await close(target);
    await close(redir);
    process.exit(1);
  }
  const { fn: storeRequest, src } = loaded;

  console.log("\n[2] 静态断言：storeRequest 手动跟随且不降级");
  ok(/redirect:\s*"manual"/.test(src), 'storeRequest 使用 redirect:"manual"（不让 undici 自动跟随）');
  ok(
    /method,\s*headers,\s*body,\s*redirect:\s*"manual"/.test(src),
    "每次跳转都原样透传 method / headers / body",
  );
  ok(!/method\s*=\s*"GET"/.test(src), "不存在把重定向后的 method 改成 GET 的分支");
  ok(
    /for \(let hop = 0; hop <= 3; hop\+\+\)/.test(src) && /new URL\(loc, url\)/.test(src),
    "跳数上限 + 相对 Location 解析（new URL(loc, url)）",
  );

  console.log("\n[3] 功能断言：301/302/303/307/308 全部保留 POST + 原 body");
  for (const st of [301, 302, 303, 307, 308]) {
    const r = await storeRequest({ method: "POST", path: "/" + st, json: { a: st }, anon: true });
    ok(
      r.ok === true && r.data && r.data.method === "POST" && r.data.body && r.data.body.a === st,
      st + " 跳转后仍以 POST + 原 body 到达目标（未降级为 GET）",
    );
  }
  {
    const r = await storeRequest({ method: "POST", path: "/301", json: { a: 1 }, anon: true });
    ok(
      r.ok === true && r.data && /application\/json/.test(r.data.ct),
      "重定向后保留 Content-Type: application/json 头",
    );
  }
  {
    const r = await storeRequest({ method: "POST", path: "/rel301", json: { a: 7 }, anon: true });
    ok(r.ok === true && r.data && r.data.method === "POST", "相对 Location 正确解析并保留 POST");
  }
  {
    const r = await storeRequest({ method: "POST", path: "/echo", json: { a: 8 }, anon: true });
    ok(r.ok === true && r.data && r.data.method === "POST", "无跳转时正常 POST 直连");
  }
  {
    const r = await storeRequest({ method: "POST", path: "/loop", json: { a: 1 }, anon: true });
    ok(r.ok === false && /重定向/.test(String(r.error)), "跳转次数超限返回错误而不是无限循环");
  }
  {
    /* 对照：同一服务端 GET 即 404 not found —— 证明降级成 GET 就会得到用户看到的 not found */
    const r = await storeRequest({ method: "GET", path: "/echo", anon: true });
    ok(
      r.ok === false && r.status === 404 && String(r.data && r.data.error) === "not found",
      "对照：POST 被降级为 GET 时服务端返回 404 not found（本测试即防此回归）",
    );
  }

  await close(target);
  await close(redir);

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-store-redirect)"
      : "\n✓ " + checks + " 项全部通过  (smoke-store-redirect)",
  );
  /* 用 exitCode 自然退出：fetch(undici) 的 keep-alive 套接字若在关闭中调用 process.exit()
     会触发 libuv "handle->flags & UV_HANDLE_CLOSING" 断言（误报非零退出码）。 */
  process.exitCode = fails ? 1 : 0;
})().catch((e) => {
  console.log("FAIL  运行异常：" + ((e && e.stack) || e));
  process.exitCode = 1;
});

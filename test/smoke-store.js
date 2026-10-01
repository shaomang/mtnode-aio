/* test/smoke-store.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-store.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-store-apps-static.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-store-apps-static.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const crypto = require("crypto");
  const { spawn } = require("child_process");

  let fails = 0;
  let checks = 0;
  function ok(cond, msg) {
    checks++;
    if (cond) console.log("  ok    " + msg);
    else {
      fails++;
      console.log("FAIL  " + msg);
    }
  }
  const ROOT = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 现打一个合法 zip（store 方法 0），不引第三方依赖 ---------- */
  const CRC = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  function crc32(b) {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function makeZip(files) {
    const locals = [];
    const central = [];
    let off = 0;
    for (const f of files) {
      const name = Buffer.from(f.name, "utf8");
      const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
      const crc = crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(data.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, data);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(data.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      central.push(ch, name);
      off += lh.length + name.length + data.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    return Buffer.concat([Buffer.concat(locals), cd, eocd]);
  }
  const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

  /* ---------- [B] 部署链：静态断言（deploy.sh 的部署口径） ---------- */
  function deployShChecks() {
    console.log("[B] deploy.sh：不再用空模板覆盖线上目录 + 收尾落盘自检");
    const sh = read("store-saas/deploy.sh");
    ok(
      !/if \[ -f "\$SRC\/apps\/catalog\.json" \]; then\s*\n\s*install -m 644 "\$SRC\/apps\/catalog\.json" \/var\/www\/mtnode\/apps\/catalog\.json/.test(sh),
      "不再无条件把仓库模板 install 成线上目录（事故成因 A 已除）",
    );
    ok(
      /if \[ -f \/var\/www\/mtnode\/apps\/catalog\.json \]; then/.test(sh),
      "线上已有目录时原样保留（优先保留服务端落盘的真实目录）",
    );
    ok(
      /curl -sS http:\/\/127\.0\.0\.1:8787\/api\/apps\/catalog -o \/tmp\/deploy-apps-catalog\.json/.test(sh),
      "部署收尾从本机接口拉真实清单（不再依赖人工第二步）",
    );
    ok(/apps-static-write:/.test(sh), "收尾有落盘结果输出（含失败原因，不静默）");
    ok(/apps-pub:/.test(sh) && /api\/apps\/pub/.test(sh), "自检走 GET /api/apps/pub 体检静态目录");
    ok(/apps-static: BAD/.test(sh) && /apps-file: BAD/.test(sh), "目录坏 JSON / 包 404 都会判 BAD（不只看状态码）");
    const srv = read("store-saas/server.mjs");
    ok(/MTNODE_APPS_WEB_DIR/.test(srv) && /function publishStaticApps/.test(srv), "server.mjs 有静态目录发布入口");
    ok(/function appCatalogDoc/.test(srv) && /JSON\.stringify\(plan\.doc/.test(srv), "落盘的就是 appCatalogDoc()（单一真源）");
  }

  /* ---------- [A] 服务端真跑 ---------- */
  async function serverChecks() {
    console.log("[A] store-saas/server.mjs：启动发布 + 每个变更都落盘 + 清理孤儿");
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-store-smoke-"));
    const DATA = path.join(TMP, "data");
    const WEB = path.join(TMP, "www");
    fs.mkdirSync(path.join(DATA, "apps"), { recursive: true });
    fs.mkdirSync(path.join(DATA, "app-icons"), { recursive: true });
    fs.mkdirSync(WEB, { recursive: true });
    fs.writeFileSync(
      path.join(DATA, "db.json"),
      JSON.stringify({
        users: [], sessions: [], identities: [], templates: [], skills: [], appDeclarations: [],
        likes: [], skillLikes: [], forumTopics: [], forumReplies: [],
        rechargeOrders: [], rechargeLedger: [], adminSessions: [], relayUsage: [], apps: [],
      }),
      "utf8",
    );

    const PORT = 18789;
    const zip1 = makeZip([{ name: "index.html", data: "<html>v1</html>" }]);
    const zip2 = makeZip([{ name: "index.html", data: "<html>v2</html>" }]);
    const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const child = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
      env: Object.assign({}, process.env, {
        DATA_DIR: DATA,
        MTNODE_APPS_WEB_DIR: WEB,
        MTNODE_APP_VERSIONS: "1",
        MTNODE_SMS_PROVIDER: "console",
        PORT: String(PORT),
        HOST: "127.0.0.1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (c) => (log += c));
    child.stderr.on("data", (c) => (log += c));
    const API = "http://127.0.0.1:" + PORT;
    const catPath = path.join(WEB, "catalog.json");
    const catDoc = () => JSON.parse(fs.readFileSync(catPath, "utf8"));
    async function req(method, p, body, token) {
      const r = await fetch(API + p, {
        method,
        headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let d = null;
      try { d = await r.json(); } catch {}
      return { status: r.status, data: d };
    }

    try {
      let up = false;
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(API + "/api/health");
          if (r.ok) { up = true; break; }
        } catch {}
        await sleep(500);
      }
      ok(up, "服务能起来（临时 DATA_DIR）");
      if (!up) return;
      await sleep(400);
      ok(fs.existsSync(catPath), "空库启动也落盘 catalog.json（0 条，不是 404）");
      ok(catDoc().apps.length === 0, "空库目录 apps 为空数组");

      // 真登录：console 短信提供方把验证码打进日志，测试自己读回来（不碰真实短信）
      const phone = "13800001111";
      ok((await req("POST", "/api/auth/sms/send", { phone, scene: "login" })).status === 200, "短信验证码已发出");
      await sleep(300);
      const m = /->\s*(\d{4,8})/.exec(log);
      const lg = await req("POST", "/api/auth/sms/login", { phone, code: m ? m[1] : "" });
      const token = lg.data && lg.data.token;
      ok(!!token, "登录拿到 token（后续变更走真接口）");

      // 新建：静态目录立刻出现目录 + 包 + 图标
      const created = await req("POST", "/api/apps", {
        acceptDeclaration: true, id: "smoke-app", title: "冒烟应用", description: "自检",
        version: "1.0.0", entry: "index.html", zipBase64: zip1.toString("base64"),
        iconBase64: icon.toString("base64"), tags: ["自检"],
      }, token);
      ok(created.status === 200 && created.data.ok === true, "新建应用成功");
      await sleep(400);
      ok(catDoc().apps.length === 1 && catDoc().apps[0].id === "smoke-app", "静态目录立刻列出这条应用");
      ok(fs.existsSync(path.join(WEB, "smoke-app.zip")), "静态目录立刻有 <id>.zip");
      ok(fs.existsSync(path.join(WEB, "smoke-app", "1.0.0.zip")), "静态目录立刻有 <id>/<version>.zip");
      ok(fs.existsSync(path.join(WEB, "icons", "smoke-app.png")), "静态目录立刻有 icons/<id>.png");
      ok(sha256(fs.readFileSync(path.join(WEB, "smoke-app.zip"))) === sha256(zip1), "落盘的包 sha256 与上传一致");
      ok(fs.existsSync(path.join(WEB, ".mtnode-apps-static.json")), "写了托管清单（供下次清理比对）");

      // 追加版本
      const add = await req("POST", "/api/apps/smoke-app/versions", {
        acceptDeclaration: true, version: "2.0.0", zipBase64: zip2.toString("base64"), entry: "index.html",
      }, token);
      ok(add.status === 200 && add.data.ok === true, "追加版本 2.0.0 成功");
      await sleep(400);
      ok(catDoc().apps[0].latestVersion === "2.0.0", "静态目录 latestVersion 跟着刷成 2.0.0");
      ok(fs.existsSync(path.join(WEB, "smoke-app", "2.0.0.zip")), "静态目录补上 <id>/2.0.0.zip");
      ok(sha256(fs.readFileSync(path.join(WEB, "smoke-app.zip"))) === sha256(zip2), "镜像 <id>.zip 刷成最新版");
      ok(fs.existsSync(path.join(WEB, "smoke-app", "1.0.0.zip")), "旧版仍在（只清不再需要的）");

      // 删旧版 → 孤儿包被清掉
      const del = await req("DELETE", "/api/apps/smoke-app/versions/1.0.0", undefined, token);
      ok(del.status === 200 && del.data.ok === true, "删除 1.0.0 版成功");
      await sleep(400);
      ok(!fs.existsSync(path.join(WEB, "smoke-app", "1.0.0.zip")), "静态目录里 1.0.0 的包被清掉（不留孤儿文件）");
      ok(fs.existsSync(path.join(WEB, "smoke-app", "2.0.0.zip")), "2.0.0 仍在");

      // 下架 / 重新发布
      ok((await req("POST", "/api/apps/smoke-app/unpublish", {}, token)).status === 200, "下架成功");
      await sleep(400);
      ok(catDoc().apps.length === 0, "下架后静态目录不再列它");
      ok((await req("POST", "/api/apps/smoke-app/publish", {}, token)).status === 200, "重新发布成功");
      await sleep(400);
      ok(catDoc().apps.length === 1, "重新发布后静态目录又列出来");

      const pub = await (await fetch(API + "/api/apps/pub")).json();
      ok(pub.ok === true && pub.dbApps === 1 && pub.diskApps === 1, "体检 ok（库条数 = 盘条数，无缺文件）");
      ok(Array.isArray(pub.missingOnDisk) && pub.missingOnDisk.length === 0, "体检 missingOnDisk 为空");

      // 删除整个应用 → 包、版本目录、图标全清
      const del2 = await req("DELETE", "/api/apps/smoke-app", undefined, token);
      ok(del2.status === 200, "删除应用成功");
      await sleep(400);
      ok(!fs.existsSync(path.join(WEB, "smoke-app.zip")), "静态目录里 <id>.zip 被清掉");
      ok(!fs.existsSync(path.join(WEB, "smoke-app")), "静态目录里 <id>/ 目录被清掉");
      ok(!fs.existsSync(path.join(WEB, "icons", "smoke-app.png")), "静态目录里图标被清掉");
      ok(catDoc().apps.length === 0, "静态目录条数跟着库回到 0");

      // 客户端兜底用的接口目录：与静态目录同源同字段
      const apiCat = await (await fetch(API + "/api/apps/catalog")).json();
      ok(apiCat.apps.length === catDoc().apps.length, "GET /api/apps/catalog 与静态目录同一份字段（条数一致）");
    } catch (e) {
      fails++;
      console.log("FAIL  服务端自检异常：" + ((e && e.stack) || e));
    } finally {
      try { child.kill(); } catch {}
      await sleep(300);
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    }
  }

  async function main() {
    console.log("smoke-store-apps-static：应用库静态目录单一真源\n");
    deployShChecks();
    await serverChecks();
    console.log("\n" + (fails ? "FAILED" : "PASS") + "：" + (checks - fails) + "/" + checks + " 项通过");
    if (fails ? 1 : 0) MERGED_FAILED = true;
  }

  main().catch((e) => {
    console.error("smoke-store-apps-static 崩了：" + ((e && e.stack) || e));
    if (1) MERGED_FAILED = true;
  });

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-store-apps-static.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-store-apps-static.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-store-redirect.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-store-redirect.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  })().catch((e) => {
    console.log("FAIL  运行异常：" + ((e && e.stack) || e));
  });

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-store-redirect.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-store-redirect.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

#!/usr/bin/env node
/* test/smoke-store-apps-static.js — 云端应用库「静态目录单一真源」的回归（零依赖 · 本机起服务 · 不出网）
 * ============================================================================
 * 事故背景：客户端只读 <MTNODE_APPS_URL>/catalog.json 这份**静态文件**，而应用接口只写库与
 * DATA_DIR —— 两份各自手写必漂移，线上曾被部署链刷成 120 字节 `apps: []`，
 * 表现就是「应用库未连入云端」。本脚本真起 store-saas/server.mjs（临时 DATA_DIR + 临时静态目录），
 * 钉住修好后的口径：
 *
 *   [A] 服务端：启动即发布 + 每次应用变更（新建 / 追加版本 / 删版本 / 下架 / 重新发布 / 删除）
 *       都把 appCatalogDoc() 原子落盘，并把 <id>.zip、<id>/<version>.zip、icons/<id>.<ext> 同步过去；
 *       上一次留下、这一次不再需要的文件按托管清单清掉；GET /api/apps/pub 能体检出条数与缺文件。
 *   [B] 部署链：deploy.sh **不再用仓库里的空模板覆盖线上目录**，且收尾会从本机接口拉真实清单落盘，
 *       并自检「条数 + 每个 zipUrl / icon 的 HTTP 码」。
 *
 * 跑法：node test/smoke-store-apps-static.js   （npm test 会自动带上）
 * 现场全在 os.tmpdir()，不碰线上、不碰仓库文件、不联网（只连 127.0.0.1）。
 * ========================================================================== */

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
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke-store-apps-static 崩了：" + ((e && e.stack) || e));
  process.exit(1);
});

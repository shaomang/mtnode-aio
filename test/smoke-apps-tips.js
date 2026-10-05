"use strict";
/* 应用打赏概述 + 上传新版本继承标签 + 渲染层未定义全局扫描 —— 链路级冒烟（纯 Node，不起 Electron）
 *   node test/smoke-apps-tips.js
 *
 * 本轮需求（用户报的四件事，见交付说明文档）：
 *   ① 打开应用时的报错 `verCmp is not defined @ app-apps.js:950` —— 渲染层补版本比较函数，
 *      并扫一遍渲染层有没有别的同型「调用未定义全局」；
 *   ② 上传新版本时**继承原版标签**（客户端开窗带回 + 服务端空值不清空）；
 *   ③ 新增**服务端接口** `GET /api/tips/summary?kind=app&ids=…`（免登录 · 批量 · 只回公开数字），
 *      静态目录 catalog.json 的条目也带上 tips；
 *   ④ 应用中心卡片据它填悬停文案（已打赏的应用不再显示「还没有人打赏」）。
 *
 * 覆盖：
 *   [1] tips.mjs 的 summariesOf：批量 / 去重 / 未打赏补零 / 已撤销不计 / 一次遍历
 *   [2] 真起 server.mjs（临时 DATA_DIR + 临时静态目录）走真 HTTP：
 *       免登录可读 / 参数非法 400 / 未上架与未打赏都回零 / 真打赏后 count 与金额跟着变 /
 *       目录条目带 tips / 打赏后静态目录被重发 / 打赏记录名单不外泄
 *   [3] 上传新版本继承标签（源码断言 + 用真源码切片跑 pubTagsOf / pubHydrateTags 的判据）
 *   [4] 渲染层未定义全局扫描（app-apps.js / app-publish.js：新写一个没定义的函数调用即失败）
 *
 * 数据只落临时目录（os.tmpdir），绝不碰 store-saas/data。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

console.log("smoke-apps-tips：打赏概述接口 + 版本标签继承 + 渲染层未定义全局\n");

/* ═══════════════════════ 第一段：tips.mjs 的 summariesOf ═══════════════════════ */

(async () => {
  console.log("[1] store-saas/tips.mjs 的 summariesOf（批量公开汇总）");
  const T = await import(pathToFileURL(path.join(ROOT, "store-saas", "tips.mjs")).href);
  const db = { users: [], tips: [], apps: [], templates: [], skills: [], rechargeLedger: [] };
  let clock = 1760000000000;
  const wallet = { adjustBalance: async () => ({ ok: true }) };
  const tips = T.createTips({
    db,
    saveDb: async () => {},
    wallet,
    users: () => db.users,
    now: () => clock,
  });
  db.tips = [
    { id: "tp1", targetKind: "app", targetId: "appA", amountCents: 2000, at: clock, dayKey: T.dayKeyOf(clock), monthKey: T.monthKeyOf(clock) },
    { id: "tp2", targetKind: "app", targetId: "appA", amountCents: 1000, at: clock, dayKey: T.dayKeyOf(clock), monthKey: T.monthKeyOf(clock) },
    { id: "tp3", targetKind: "app", targetId: "appB", amountCents: 500, at: clock, revoked: true, dayKey: T.dayKeyOf(clock), monthKey: T.monthKeyOf(clock) },
    { id: "tp4", targetKind: "template", targetId: "appA", amountCents: 9000, at: clock, dayKey: T.dayKeyOf(clock), monthKey: T.monthKeyOf(clock) },
  ];
  const sum = tips.summariesOf("app", ["appA", "appB", "appC", "appA", "  ", "appB"]);
  ok(JSON.stringify(sum) === JSON.stringify([
    { id: "appA", count: 2, totalYuan: 30 },
    { id: "appB", count: 0, totalYuan: 0 },
    { id: "appC", count: 0, totalYuan: 0 },
  ]), "summariesOf：去重 + 保持入参顺序 + 未打赏补零 + 已撤销不计（同 kind 才计）· 实得 " + JSON.stringify(sum));
  ok(tips.summariesOf("app", []).length === 0 && tips.summariesOf("app", null).length === 0,
    "空 / 非数组 ids → 空数组（路由层的 400 判据靠它）");
  ok(tips.summariesOf("app", ["appA"])[0].totalYuan === 30 && tips.summariesOf("template", ["appA"])[0].totalYuan === 90,
    "同名不同 kind 分开算（appA 在 app 上是 ¥30、在 template 上是 ¥90）");
  ok(typeof tips.enricher === "function" && typeof tips.summaryOf === "function",
    "旧的 summaryOf / enricher 仍在（列表接口与打赏窗的既有口径没被动）");
  ok(T.TIP_TARGET_KINDS.indexOf("app") >= 0 && T.TIP_TARGET_KINDS.length === 5,
    "TIP_TARGET_KINDS 仍导出（路由层用它验 kind）");

  /* ═══════════════════ 第二段：真起 server.mjs 走真 HTTP ═══════════════════ */

  console.log("\n[2] 真起 server.mjs（临时 DATA_DIR + 临时静态目录）打 /api/tips/summary");
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-appstips-smoke-"));
  const DATA = path.join(TMP, "data");
  const WEB = path.join(TMP, "apps-web");
  for (const d of [DATA, WEB, path.join(DATA, "apps"), path.join(DATA, "app-icons"), path.join(WEB, "icons")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const AUTHOR = {
    id: "u_author_seed",
    username: "authorseed",
    nickname: "种子作者",
    balanceCents: 0,
    createdAt: 1,
  };
  const TIPPER = {
    id: "u_tipper_seed",
    username: "tipperseed",
    nickname: "打赏人",
    balanceCents: 100000, /* ¥1000：够打几笔 */
    createdAt: 1,
  };
  const TIPPER_TOKEN = "seedtoken" + "a".repeat(40);
  const AUTHOR_TOKEN = "seedtoken" + "b".repeat(40);
  const nowTs = Date.now();
  const app = (id, title, tags, extra) => Object.assign({
    id: id,
    userId: AUTHOR.id,
    title: title,
    description: title + " 的说明",
    tags: tags,
    version: "1.0.0",
    latestVersion: "1.0.0",
    versions: [{
      version: "1.0.0",
      parentVersion: "",
      zipUrl: id + ".zip",
      sha256: "0".repeat(64),
      bytes: 100,
      entry: "index.html",
      uploader: AUTHOR.username,
      note: "",
      createdAt: 1,
    }],
    entry: "index.html",
    sha256: "0".repeat(64),
    bytes: 100,
    downloads: 0,
    createdAt: 1,
    updatedAt: 1,
  }, extra || {});
  fs.writeFileSync(path.join(DATA, "db.json"), JSON.stringify({
    users: [AUTHOR, TIPPER],
    sessions: [
      { tokenHash: sha256(TIPPER_TOKEN), userId: TIPPER.id, createdAt: nowTs, expiresAt: nowTs + 3600 * 1000 },
      { tokenHash: sha256(AUTHOR_TOKEN), userId: AUTHOR.id, createdAt: nowTs, expiresAt: nowTs + 3600 * 1000 },
    ],
    identities: [{ kind: "username", value: AUTHOR.username, userId: AUTHOR.id, createdAt: 1 }],
    templates: [], skills: [],
    apps: [app("app_alpha", "阿尔法", ["工具", "效率"]), app("app_beta", "贝塔", [])],
    appDeclarations: [], likes: [], skillLikes: [],
    forumTopics: [], forumReplies: [], comments: [],
    /* 预置两笔真打赏：app_alpha 被打赏 ¥30（两笔），app_beta 一笔已撤销（不该计数） */
    tips: [
      { id: "tp_seed_1", targetKind: "app", targetId: "app_alpha", targetLabel: "阿尔法", amountCents: 2000, at: 2, fromUserId: TIPPER.id, toUserId: AUTHOR.id, dayKey: "2026-01-01", monthKey: "2026-01", splitGroupId: "", splitCount: 1 },
      { id: "tp_seed_2", targetKind: "app", targetId: "app_alpha", targetLabel: "阿尔法", amountCents: 1000, at: 3, fromUserId: TIPPER.id, toUserId: AUTHOR.id, dayKey: "2026-01-02", monthKey: "2026-01", splitGroupId: "", splitCount: 1 },
      { id: "tp_seed_3", targetKind: "app", targetId: "app_beta", targetLabel: "贝塔", amountCents: 500, at: 4, fromUserId: TIPPER.id, toUserId: AUTHOR.id, dayKey: "2026-01-03", monthKey: "2026-01", revoked: true, revokedAt: 5, splitGroupId: "", splitCount: 1 },
    ],
    notifications: [],
    rechargeOrders: [], rechargeLedger: [],
    adminSessions: [], relayUsage: [], relayConfig: null, relayAudit: [],
  }), "utf8");

  const PORT = 18900 + Math.floor(Math.random() * 90);
  const API = "http://127.0.0.1:" + PORT;
  let child = null;
  let log = "";
  let childExit = null;
  let gen = 0;
  function killPortHolder() {
    try {
      spawnSync("powershell", ["-NoProfile", "-Command",
        "(Get-NetTCPConnection -LocalPort " + PORT + " -State Listen -ErrorAction SilentlyContinue).OwningProcess | " +
        "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"],
        { encoding: "utf8", timeout: 15000 });
    } catch {}
  }
  function cleanup() {
    try { if (child && !child.killed) child.kill(); } catch {}
    killPortHolder();
  }
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  function spawnServer() {
    log = "";
    childExit = null;
    const g = ++gen;
    const p = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
      env: Object.assign({}, process.env, {
        DATA_DIR: DATA,
        MTNODE_APPS_WEB_DIR: WEB,
        PORT: String(PORT),
        HOST: "127.0.0.1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (c) => (log += c));
    p.stderr.on("data", (c) => (log += c));
    p.on("exit", (code) => { if (g === gen) childExit = { code, log }; });
    child = p;
    return p;
  }
  async function waitUp() {
    for (let i = 0; i < 60; i++) {
      if (childExit) {
        console.log("      （服务端提前退出 code=" + childExit.code + " · 日志尾 " + JSON.stringify(childExit.log.slice(-400)) + "）");
        return false;
      }
      try { if ((await fetch(API + "/api/health")).ok) return true; } catch {}
      await sleep(500);
    }
    return false;
  }
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
    killPortHolder();
    spawnServer();
    const up = await waitUp();
    ok(up, "服务起来了（临时 DATA_DIR，端口 " + PORT + "）");
    if (!up) throw new Error("服务没起来");

    /* —— 免登录批量汇总 —— */
    const s1 = await req("GET", "/api/tips/summary?kind=app&ids=app_alpha,app_beta");
    ok(s1.status === 200 && s1.data.ok === true && s1.data.kind === "app",
      "GET /api/tips/summary 免登录可读（不 404 / 不 401）：HTTP " + s1.status);
    ok(JSON.stringify(s1.data.items) === JSON.stringify([
      { id: "app_alpha", count: 2, totalYuan: 30 },
      { id: "app_beta", count: 0, totalYuan: 0 },
    ]), "批量汇总按入参顺序回：app_alpha = 2 次 ¥30；app_beta 那笔已撤销 → 0 次（实得 " + JSON.stringify(s1.data.items) + "）");
    ok(!/username|nickname|fromUserId|打赏人/.test(JSON.stringify(s1.data)),
      "回执里没有任何打赏人字段（只有 count / totalYuan —— 名单仍只给作者本人）");
    ok(String(s1.data.items.map((x) => x.id).join(",")) === "app_alpha,app_beta",
      "回执逐条带 id（客户端按 id 落表，不必自己配顺序）");

    /* —— 未上架 / 没打赏过 —— */
    const s2 = await req("GET", "/api/tips/summary?kind=app&ids=app_not_exist");
    ok(s2.status === 200 && JSON.stringify(s2.data.items) === JSON.stringify([{ id: "app_not_exist", count: 0, totalYuan: 0 }]),
      "云端没有的 id 也回零值（列表页不必为「本机自建、还没上架」特判）");

    /* —— 参数非法 —— */
    const bad1 = await req("GET", "/api/tips/summary?kind=nope&ids=app_alpha");
    ok(bad1.status === 400 && bad1.data.code === "TIP_INVALID_TARGET", "kind 不认识 → 400 TIP_INVALID_TARGET");
    const bad2 = await req("GET", "/api/tips/summary?kind=app");
    ok(bad2.status === 400 && bad2.data.code === "TIP_INVALID_TARGET", "ids 为空 → 400 TIP_INVALID_TARGET");
    const s3 = await req("GET", "/api/tips/summary?kind=template&ids=t_x");
    ok(s3.status === 200 && s3.data.items.length === 1 && s3.data.items[0].count === 0,
      "kind=template 也认（同一个接口服务四类对象，不是只给应用开的后门）");

    /* —— 打赏一笔，数字必须跟着变 —— */
    const tipRes = await req("POST", "/api/tips", { targetKind: "app", targetId: "app_beta", amountYuan: 2, splits: [{ authorId: AUTHOR.id, cents: 200 }] }, TIPPER_TOKEN);
    ok(tipRes.status === 200 && tipRes.data.ok === true,
      "真打赏一笔到 app_beta（登录态 + 真钱包）：HTTP " + tipRes.status + " " + JSON.stringify(tipRes.data || {}).slice(0, 120));
    const s4 = await req("GET", "/api/tips/summary?kind=app&ids=app_beta");
    ok(s4.data.items[0].count === 1 && s4.data.items[0].totalYuan === 2,
      "打赏后汇总立刻变（0 → 1 次 ¥2）：" + JSON.stringify(s4.data.items));
    const listRes = await req("GET", "/api/tips/list?targetKind=app&targetId=app_beta");
    ok(listRes.status === 401, "GET /api/tips/list 仍要登录（公开的只是汇总，名单没跟着开口）");

    /* —— 静态目录：条目带 tips，且打赏后自动重发 —— */
    const cat = JSON.parse(fs.readFileSync(path.join(WEB, "catalog.json"), "utf8"));
    const alpha = (cat.apps || []).find((a) => a.id === "app_alpha");
    const beta = (cat.apps || []).find((a) => a.id === "app_beta");
    ok(alpha && alpha.tips && alpha.tips.count === 2 && alpha.tips.totalYuan === 30,
      "静态目录 catalog.json 的条目带公开 tips（app_alpha 2 次 ¥30）：" + JSON.stringify(alpha && alpha.tips));
    ok(beta && beta.tips && beta.tips.count === 1 && beta.tips.totalYuan === 2,
      "刚打赏的那一笔已随打赏重发进目录（app_beta 1 次 ¥2）：" + JSON.stringify(beta && beta.tips));
    ok((cat.apps || []).every((a) => a.tips && typeof a.tips.count === "number"),
      "目录里每条都有 tips（客户端不必判字段在不在）");

    /* —— /api/apps 列表项本来就有 tips，别被这次改动弄丢 —— */
    const appsList = await req("GET", "/api/apps?pageSize=50");
    const itA = (appsList.data.items || []).find((x) => x.id === "app_alpha");
    ok(appsList.status === 200 && itA && itA.tips && itA.tips.count === 2,
      "GET /api/apps 列表项照旧带 tips（旧口径没动）：" + JSON.stringify(itA && itA.tips));

    /* —— 标签继承：服务端空值不清空 —— */
    const zip = makeZip().toString("base64");
    const bodyA = {
      acceptDeclaration: true,
      version: "1.1.0",
      zipBase64: zip,
      entry: "index.html",
      title: "阿尔法",
      description: "阿尔法 的说明",
      tags: [], /* ← 上架窗不手填时就是这个：改前会把线上标签清空 */
      ownerId: AUTHOR.id,
    };
    const verOther = await req("POST", "/api/apps/app_alpha/versions", bodyA, TIPPER_TOKEN);
    ok(verOther.status === 403, "别人的分支不能追加版本 → 403（HTTP " + verOther.status + "）");
    const ver2 = await req("POST", "/api/apps/app_alpha/versions", bodyA, AUTHOR_TOKEN);
    ok(ver2.status === 200 && ver2.data.ok === true,
      "作者追加 v1.1.0 成功（HTTP " + ver2.status + " " + JSON.stringify(ver2.data || {}).slice(0, 160) + "）");
    ok(JSON.stringify((ver2.data.item || {}).tags) === JSON.stringify(["工具", "效率"]),
      "空 tags 追加版本后**标签仍在**（服务端兜底：空值不清空）实得 " + JSON.stringify((ver2.data.item || {}).tags));
    const ver3 = await req("POST", "/api/apps/app_alpha/versions", Object.assign({}, bodyA, { version: "1.2.0", tags: ["新标签"] }), AUTHOR_TOKEN);
    ok(ver3.status === 200 && JSON.stringify((ver3.data.item || {}).tags) === JSON.stringify(["新标签"]),
      "填了标签就换成新的（实得 " + JSON.stringify((ver3.data.item || {}).tags) + "）");
    const body4 = Object.assign({}, bodyA, { version: "1.3.0" });
    delete body4.tags;
    const ver4 = await req("POST", "/api/apps/app_alpha/versions", body4, AUTHOR_TOKEN);
    ok(ver4.status === 200 && JSON.stringify((ver4.data.item || {}).tags) === JSON.stringify(["新标签"]),
      "连 tags 字段都不带也一样保留原标签（实得 " + JSON.stringify((ver4.data.item || {}).tags) + "）");
    const cat2 = JSON.parse(fs.readFileSync(path.join(WEB, "catalog.json"), "utf8"));
    const alpha2 = (cat2.apps || []).find((a) => a.id === "app_alpha");
    ok(String(alpha2 && alpha2.latestVersion) === "1.3.0" && alpha2.tips.count === 2,
      "追加版本后目录仍是同一份（版本刷到 1.3.0、tips 不受影响）：v" + String(alpha2 && alpha2.latestVersion) + " · tips " + JSON.stringify(alpha2 && alpha2.tips));
  } catch (e) {
    fails++;
    console.log("FAIL  [2] 段异常：" + ((e && e.stack) || e));
  } finally {
    cleanup();
  }

  /* ═══════════════════ 第三段：渲染层（源码断言 + 真跑切片） ═══════════════════ */

  console.log("\n[3] 渲染层：版本比较 / 标签继承 / 打赏悬停文案");
  const APPS_RAW = read("renderer/app-apps.js");
  const PUB_RAW = read("renderer/app-publish.js");
  const I18N = read("renderer/i18n.js");
  /* 断言与扫描都走「去注释」版：`verCmp(...)` 这类字样在注释里提过（本轮修复说明就写在旁边），
     拿原始文本判「还有没有裸调用」会把说明文字误判成代码。 */
  const APPS = stripComments(APPS_RAW);
  const PUB = stripComments(PUB_RAW);

  /* ① 报错：verCmp 未定义 → 本地补一个，且**不再有裸 verCmp 调用** */
  const bareCalls = APPS.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /(^|[^.\w$])verCmp\s*\(/.test(line));
  ok(APPS.indexOf("function appsVerCmp(") >= 0 && APPS.indexOf("function appsVerParts(") >= 0,
    "app-apps.js 补了 appsVerParts / appsVerCmp（本模块自己的版本比较）");
  ok(bareCalls.length === 0,
    "app-apps.js 代码里不再有裸 verCmp( 调用" + (bareCalls.length ? "（实得行：" + bareCalls.map(([n]) => n).join(",") + "）" : ""));

  /* 真跑切片：appsVerParts / appsVerCmp 的排序口径与主进程一致 */
  const vSrc = sliceFn(APPS, "appsVerParts") + "\n" + sliceFn(APPS, "appsVerCmp") + "\n;({parts: appsVerParts, cmp: appsVerCmp});";
  const vEnv = vm.runInNewContext(vSrc, {});
  ok(vEnv.cmp("1.10.0", "1.9.0") > 0 && vEnv.cmp("2.0.0", "10.0.0") < 0 && vEnv.cmp("1.0.0", "1.0.0") === 0,
    "appsVerCmp 逐段数值比较（1.10.0 > 1.9.0、2.0.0 < 10.0.0）");
  ok(vEnv.cmp("1.0.0+build", "1.0.0") === 0 && vEnv.cmp("1.0.1", "1.0.0+build") > 0,
    "带后缀的版本号按主进程口径切段比较、不抛异常");

  /* ② 标签继承：开窗带回 + 用户改过不覆盖 */
  ok(PUB.indexOf("function pubHydrateTags(") >= 0 && PUB.indexOf("pubHydrateTags(it)") >= 0,
    "app-publish.js：线上状态读回来时把原标签带回表单（pubHydrateTags）");
  ok(PUB.indexOf("PUB.tagsTouched = true") >= 0 && PUB.indexOf("if (PUB.tagsTouched) return false;") >= 0,
    "用户手改过标签就不再覆盖（tagsTouched 判据）");
  const SRV_RAW = read("store-saas/server.mjs");
  const srvHits = SRV_RAW.split("\n").filter((l) => /^\s*if \((?:b|nextTags) != null\) a\.tags = appTagsNext\(/.test(l));
  ok(SRV_RAW.indexOf("function appTagsNext(") >= 0 && srvHits.length === 2,
    "store-saas/server.mjs：追加 / 覆盖版本时空标签不清空（appTagsNext 两处兜底，实得 " + srvHits.length + " 处）");

  const pubEnv = vm.runInNewContext(
    "const PUB = { form: { tags: \"\" }, tagsTouched: false, dom: {} };\n" +
    "function pubStr(v){ return String(v == null ? \"\" : v).trim(); }\n" +
    sliceFn(PUB_RAW, "pubTagsOf") + "\n" + sliceFn(PUB_RAW, "pubHydrateTags") + "\n" +
    ";({ PUB: PUB, hydrate: pubHydrateTags, tagsOf: pubTagsOf });",
    {},
  );
  ok(JSON.stringify(pubEnv.tagsOf("工具, 效率 ,, 工具")) === JSON.stringify(["工具", "效率", "工具"]),
    "pubTagsOf：中英文逗号都切、去空白、丢空项（去重交给服务端 parseTags）");
  ok(JSON.stringify(pubEnv.tagsOf(["a", "b"])) === JSON.stringify(["a", "b"]),
    "pubTagsOf 对数组输入不炸（String([\"a\",\"b\"]) = \"a,b\" 照样切成两个）");
  const h1 = pubEnv.hydrate({ tags: ["工具", "效率"] });
  ok(h1 === true && pubEnv.PUB.form.tags === "工具,效率" && pubEnv.PUB.dom.tagsIn === undefined,
    "线上有标签 → 填进表单（实得 " + JSON.stringify(pubEnv.PUB.form.tags) + "）");
  pubEnv.PUB.form.tags = "我自己写的";
  pubEnv.PUB.tagsTouched = true;
  const h2 = pubEnv.hydrate({ tags: ["工具", "效率"] });
  ok(h2 === false && pubEnv.PUB.form.tags === "我自己写的", "用户手填过 → 线上那份不覆盖");

  /* ③ 打赏悬停文案三态 */
  ok(APPS.indexOf("appsTipsTitleEl") >= 0 && APPS.indexOf("appsTipsLoad") >= 0 &&
    APPS.indexOf("appsTipsEnsure") >= 0 && APPS.indexOf("appsTipsRefreshNow") >= 0,
    "app-apps.js：打赏汇总的取数 / 触发 / 悬停文案三件套齐备");
  ok(APPS.indexOf('"/api/tips/summary?kind=app&ids="') >= 0,
    "渲染层问的就是本轮新增的 GET /api/tips/summary（kind=app 批量）");
  ok(APPS.indexOf("appsTipsEnsure(list, false)") >= 0 && APPS.indexOf("return appsMergeSameId(appsSpecPoolAll()).map(appsSpecWithTips);") >= 0,
    "列表载入 / 刷新时问一次（不是悬停那刻才问），条目上也挂了 tips");
  const tipEnv = vm.runInNewContext(
    "const APPS_ST = { tips: null, tipsFailed: false, tipsBusy: false };\n" +
    "function appsBranchIdOf(s){ return String((s && (s.id || s.appId)) || \"\"); }\n" +
    "function appsT(s){ return s; }\n" +
    "const window = { MtTips: { tipSumTitle: function (t) { return \"SUM:\" + t.count + \":\" + t.totalYuan; } } };\n" +
    sliceFn(APPS_RAW, "appsTipsOf") + "\n" + sliceFn(APPS_RAW, "appsSpecWithTips") + "\n" + sliceFn(APPS_RAW, "appsTipsTitleEl") + "\n" +
    ";({ set: function (o) { if (o.tips !== undefined) APPS_ST.tips = o.tips; if (o.failed !== undefined) APPS_ST.tipsFailed = o.failed; }, title: appsTipsTitleEl });",
    {},
  );
  tipEnv.set({ tips: null, failed: false });
  ok(tipEnv.title({ id: "app_x" }) === "正在读取打赏数据…", "还没问回来 → 「正在读取打赏数据…」（不说没人打赏）");
  tipEnv.set({ tips: null, failed: true });
  ok(tipEnv.title({ id: "app_x" }) === "打赏数据暂未取到", "问失败（未登录 / 断网 / 5xx）→ 「打赏数据暂未取到」");
  tipEnv.set({ tips: { byId: { app_x: { count: 3, totalYuan: 30 } } }, failed: false });
  ok(tipEnv.title({ id: "app_x" }) === "SUM:3:30", "有数字 → 走 MtTips.tipSumTitle（累计 N 币（M 次））");
  tipEnv.set({ tips: { byId: { app_x: { count: 0, totalYuan: 0 } } }, failed: false });
  ok(tipEnv.title({ id: "app_x" }) === "SUM:0:0", "真 0 次 → 也走 tipSumTitle（它会说「还没有人打赏」，这才是该说的时候）");
  tipEnv.set({ tips: null, failed: true });
  ok(tipEnv.title({ id: "app_y", tips: { count: 2, totalYuan: 20 } }) === "SUM:2:20",
    "接口取不到但目录条目自带 tips → 用目录那一份（老目录 / 断网兜底）");
  ok(I18N.indexOf('"打赏数据暂未取到"') >= 0 && I18N.indexOf('"正在读取打赏数据…"') >= 0,
    "i18n 中英词条补齐（两条新文案都在字典里）");

  /* ═══════════════════ 第四段：渲染层未定义全局扫描 ═══════════════════ */

  console.log("\n[4] 渲染层「调用未定义全局」扫描（本轮报错的同类隐患）");
  const RENDERER_DIR = path.join(ROOT, "renderer");
  const rFiles = fs.readdirSync(RENDERER_DIR).filter((f) => f.endsWith(".js") && f !== "i18n.js");
  const declared = new Set();
  const declRes = [
    /function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    /^\s*window\.([A-Za-z_$][\w$]*)\s*=/gm,
    /^\s*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/gm,
  ];
  for (const f of rFiles) {
    const src = fs.readFileSync(path.join(RENDERER_DIR, f), "utf8");
    for (const re of declRes) {
      let m;
      while ((m = re.exec(src))) declared.add(m[1]);
    }
  }
  const KW = new Set([
    "if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "do", "else",
    "super", "this", "case", "delete", "void", "in", "of", "yield", "await", "with", "throw",
    "try", "finally", "var", "let", "const", "class", "extends", "instanceof", "async",
  ]);
  /* 扫描口径：`名字(` 且**前面不是 . 或 $**（排除方法调用），名字既不在渲染层任何定义里、
     也不是语言内建；剩下的就是「调用了一个没人定义过的全局函数」——verCmp 那类事故。
     白名单是**存量事实**（下面每条都指了出处），新写一个没定义的函数调用就必然掉出来。 */
  const ALLOW = new Set([
    /* 字符串 / 注释里的词（扫描不剥字符串与注释，这里如实列出） */
    "onclick", "onchange", "onDrop", "onEvent", "onReasoning", "onDelta", "onDone", "onInserted",
    "onChanged", "onLevelChange", "onEnd", "onTab", "onMention", "onSpeechState", "onClick",
    "onError", "onSaved", "onPress", "onCommit", "onPick", "onPickFile", "onSelect", "onToggle",
    "onProgress", "onLog", "onStatus", "onReady", "onClose", "onOpen", "onRun", "onAsk", "onReply",
    /* web api / 内建构造器（不是全局函数，扫描按 `名字(` 抓进来） */
    "Date", "Map", "MutationObserver", "Number", "Promise", "Set", "String", "URL", "FileReader",
    "ImageData", "AudioContext", "MediaRecorder", "Intl", "Array", "Object", "Boolean", "Math",
    "JSON", "RegExp", "Error", "TypeError", "RangeError", "WeakMap", "Symbol", "BigInt", "Proxy",
    "Reflect", "Uint8Array", "Int32Array", "Uint8ClampedArray", "Float32Array", "ArrayBuffer",
    "DataView", "TextEncoder", "TextDecoder", "Blob", "File", "FormData", "Headers", "Request",
    "Response", "AbortController", "Image", "Audio", "Event", "CustomEvent", "IntersectionObserver",
    "ResizeObserver", "DOMParser", "XMLSerializer", "OffscreenCanvas", "SpeechSynthesisUtterance",
    "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
    "encodeURI", "decodeURI", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame", "structuredClone", "queueMicrotask",
    "alert", "confirm", "prompt", "btoa", "atob", "fetch", "postMessage", "reportError",
  ]);
  function candidatesIn(src) {
    const out = Object.create(null);
    for (const mm of src.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = mm[1];
      const before = src.slice(0, mm.index);
      const last = before.slice(-1);
      if (/[.$\w]/.test(last)) continue; /* 方法调用 / 属性名 / 已经是更长标识符的一部分 */
      /* 对象字面量里的简写方法（`{ appsInstall(...) { … } }`）：不是全局函数调用。
         判据只看该名字所在那一行、名字左侧：行首（可含缩进）之后没有 `{` 才是真调用；
         有 `{` 说明这个名字是对象成员（简写方法），跳过。 */
      const left = before.slice(before.lastIndexOf("\n") + 1);
      if (left.indexOf("{") >= 0) continue;
      if (KW.has(name) || declared.has(name) || ALLOW.has(name)) continue;
      out[name] = (out[name] || 0) + 1;
    }
    return out;
  }
  for (const f of ["app-apps.js", "app-publish.js"]) {
    const names = Object.keys(candidatesIn(stripComments(read("renderer/" + f)))).sort();
    ok(names.length === 0, f + "：没有「调用了渲染层没定义的全局函数」" + (names.length ? "（实得： " + names.join(", ") + "）" : ""));
  }
  /* 反向自检：扫描真抓得住本轮那个 bug —— 往 app-apps.js 里塞一个没人定义的调用，
     它必须被列出来（`verCmp` 当初就是这么漏过去的）。 */
  const probeSrc = stripComments(read("renderer/app-apps.js")) + "\nfunction smokeProbe() {\n  return verCmpDefinitelyUndefined(1, 2);\n}\n";
  const probe = Object.keys(candidatesIn(probeSrc));
  ok(probe.indexOf("verCmpDefinitelyUndefined") >= 0,
    "反向自检：插一个没人定义的函数调用立刻被列出（扫描不是空转）· 实得 " + JSON.stringify(probe));

  /* ═══════════════════════════ 收尾 ═══════════════════════════ */
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})();

/* ─────────────── 小工具 ─────────────── */

/**
 * 去注释（保留字符串与换行）：只用于**源码断言与扫描**，不改任何被测源码。
 * 为什么必须去：本轮修复说明就写在现场旁边，`verCmp(...)` 这种字样会在注释里出现，
 * 拿原始文本判「还有没有裸调用」会把说明文字误判成代码。
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        out += src[i];
        if (src[i] === "\\") {
          i++;
          if (i < n) out += src[i];
          i++;
          continue;
        }
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 从源码里按「function 名(」到该函数收尾的 `}` 切一段出来（够本用例的真跑）。 */
function sliceFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("源码里找不到 function " + name);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  throw new Error("切片没找到收尾：" + name);
}

/** 一个最小可用的应用 zip（服务端只校验「有效 zip + 顶层有 index.html」）。
 *  自己按 ZIP 结构拼一份 stored（不压缩）单文件包：不引第三方依赖、也不依赖本机 zip 工具。 */
function makeZip() {
  const name = Buffer.from("index.html", "utf8");
  const data = Buffer.from("<!doctype html><title>smoke</title>", "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); /* version needed */
  local.writeUInt16LE(0x0800, 6); /* UTF-8 名字 */
  local.writeUInt16LE(0, 8); /* stored */
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); /* 本地头偏移 = 0 */
  const cdOffset = local.length + name.length + data.length;
  const cdSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

/** CRC-32（ZIP 用）：手写一张表，避免引依赖。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

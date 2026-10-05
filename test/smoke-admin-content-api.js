"use strict";
/* 管理台两个新页签的**服务端接口**回归 —— 零依赖，`node test/smoke-admin-content-api.js`
 *
 * 为什么单独一只：界面那只（smoke-admin-sysinfo-ui.js / smoke-admin-content-ui.js）钉的是「点得不炸」，
 * 统计 / 落库 / 文件与静态目录的真算术得由**真起服务**来钉（与 test/smoke-relay.js 同一套手法：
 * spawn store-saas/server.mjs，PORT / DATA_DIR / MTNODE_APPS_WEB_DIR 全指临时目录）。
 *
 * 钉住的事：
 *   [1] 鉴权：两个新页签的接口一律要 adm_ 管理票（客户端 Bearer 打不进来）
 *   [2] GET /api/admin/sysinfo：CPU / 内存 / Swap / 磁盘 / 进程 / 主机字段齐，且**真采了两次快照**；
 *       只读 —— 不留历史、不写任何东西（contentAudit 不增）
 *   [3] 内容管理列表：三类内容（应用 / 模板 / 技能）+ 关键词 / 状态 / 作者筛选 + 分页 + 全量 counts
 *   [4] 应用：编辑元信息 → 落库 + 静态目录跟着变；上架 / 下架 → 公开列表可见性跟着变
 *   [5] 版本：版本历史 / 删单版本（删完自动指向剩余最高版）
 *   [6] 下载：应用 zip / 模板 .mtnodes / 技能包内文件都能取到，且**不计作者下载量**
 *   [7] 技能：官方标记可改（管理员专属）
 *   [8] 删除：模板 / 技能 / 应用三条路都真删（记录 + 文件），应用删后静态目录同步
 *   [9] 同 id 多作者分支：不指 ownerId 一律 400 BRANCH_REQUIRED（免得误删别人的分支）
 *   [10] 改动留痕：每次操作都写 contentAudit（谁 / 何时 / 对哪条做了什么）
 *   [11] 重发静态目录：库与盘条数一致，体检回执字段齐
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

/* ---------- 极简 stored 模式 zip（零依赖：服务端只读目录项名与入口页，这里给一份真 zip） ---------- */
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
function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);

    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}
function appZip(title) {
  return zipStore([
    { name: "index.html", data: "<!doctype html><title>" + title + "</title>" },
    { name: "app.js", data: "console.log('" + title + "');" },
  ]);
}

/* ---------- 夹具：临时数据目录 + 三个账号（管理员 / 两个作者） ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-admin-content-"));
const DATA = path.join(TMP, "data");
const APPS_WEB = path.join(TMP, "apps-web");
fs.mkdirSync(path.join(DATA, "files"), { recursive: true });
fs.mkdirSync(path.join(DATA, "skills", "sk_1", "extra"), { recursive: true });
fs.mkdirSync(APPS_WEB, { recursive: true });

const T0 = Date.now();
const ADMIN_TOKEN = "adm_" + crypto.randomBytes(24).toString("hex");
const AUTHOR_TOKEN = crypto.randomBytes(24).toString("hex");
const OTHER_TOKEN = crypto.randomBytes(24).toString("hex");
const ADMIN_USER = "u_admin";
const AUTHOR = "u_author";
const OTHER = "u_other";
/* 模板与技能的文件（服务端按文件名约定读 DATA 目录，夹具直接落盘） */
fs.writeFileSync(path.join(DATA, "files", "tpl_1.mtnodes"), Buffer.from("MTNODES-FIXTURE", "utf8"));
fs.writeFileSync(path.join(DATA, "skills", "sk_1", "SKILL.md"), "---\nname: demo-skill\n---\n夹具技能正文\n", "utf8");
fs.writeFileSync(path.join(DATA, "skills", "sk_1", "extra", "notes.md"), "附件\n", "utf8");

const db0 = {
  users: [
    { id: ADMIN_USER, username: "ms2308", nickname: "管理员", createdAt: T0 },
    { id: AUTHOR, username: "authora", nickname: "作者A", createdAt: T0 },
    { id: OTHER, username: "authorb", nickname: "作者B", createdAt: T0 },
  ],
  sessions: [
    { tokenHash: hashToken(AUTHOR_TOKEN), userId: AUTHOR, expiresAt: T0 + 86400e3 },
    { tokenHash: hashToken(OTHER_TOKEN), userId: OTHER, expiresAt: T0 + 86400e3 },
  ],
  /* 管理台票（adm_ 前缀）就是一行 adminSessions：与登录口发的完全同一形状（见 authAdmin） */
  adminSessions: [{ tokenHash: hashToken(ADMIN_TOKEN), userId: ADMIN_USER, createdAt: T0, expiresAt: T0 + 3600e3 }],
  identities: [],
  templates: [{
    id: "tpl_1", userId: OTHER, title: "示例模板", description: "夹具模板", tags: ["小说"],
    bytes: 15, downloads: 4, likes: 1, hasPreview: false, createdAt: T0, updatedAt: T0,
  }],
  skills: [{
    id: "sk_1", userId: OTHER, skillName: "demo-skill", title: "示例技能", description: "夹具技能", tags: [],
    version: "1.0.0", official: false, bytes: 40, downloads: 2, likes: 0, hasPreview: false,
    files: [{ path: "SKILL.md", bytes: 40 }, { path: "extra/notes.md", bytes: 7 }], createdAt: T0, updatedAt: T0,
  }],
  apps: [],
  appDeclarations: [],
  likes: [], skillLikes: [], forumTopics: [], forumReplies: [], tips: [], comments: [], notifications: [],
  rechargeOrders: [], rechargeLedger: [], relayUsage: [], relayAudit: [], contentAudit: [], relayConfig: null,
};
fs.writeFileSync(path.join(DATA, "db.json"), JSON.stringify(db0, null, 2), "utf8");

const readDb = () => JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
const catalogOnDisk = () => JSON.parse(fs.readFileSync(path.join(APPS_WEB, "catalog.json"), "utf8"));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = require("net").createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

(async () => {
  console.log("[1] 静态：两个新接口组与留痕字段在位");
  const src = read("store-saas/server.mjs");
  ok(src.includes('p === "/api/admin/sysinfo"') && /function sysinfoSnapshot/.test(src) && /import os from "node:os"/.test(src),
    "server.mjs 引入 node:os 并实现 GET /api/admin/sysinfo（sysinfoSnapshot）");
  ["/api/admin/content", "/api/admin/content/versions", "/api/admin/content/audit", "/api/admin/content/download",
    "/api/admin/content/preview", "/api/admin/content/publish", "/api/admin/content/update", "/api/admin/content/delete",
    "/api/admin/content/delete-version", "/api/admin/content/republish"].forEach((p) => {
    ok(src.includes('p === "' + p + '"'), "接了 " + p);
  });
  ok(/const CONTENT_AUDIT_MAX = 200/.test(src) && /contentAudit: \[\]/.test(src) && /if \(!Array\.isArray\(d\.contentAudit\)\) d\.contentAudit = \[\]/.test(src),
    "留痕存 db.contentAudit（上限 200，旧库读入时补默认值）");

  const port = await freePort();
  const logPath = path.join(TMP, "server.log");
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
    cwd: path.join(ROOT, "store-saas"),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: DATA,
      MTNODE_ACCOUNT_STORE: "json",
      MTNODE_APPS_WEB_DIR: APPS_WEB,
    }),
    stdio: ["ignore", logFd, logFd],
  });
  const BASE = "http://127.0.0.1:" + port;
  async function api(p, opt) {
    const o = opt || {};
    const headers = Object.assign({}, o.headers || {});
    if (o.token) headers.Authorization = "Bearer " + o.token;
    let body;
    if (o.json) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    }
    const res = await fetch(BASE + p, { method: o.method || "GET", headers, body });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString("utf8")); } catch {}
    return { status: res.status, json, buf, headers: res.headers };
  }
  const adm = (p, o) => api(p, Object.assign({ token: ADMIN_TOKEN }, o || {}));
  const admPost = (p, json) => adm(p, { method: "POST", json: json });

  let healthy = false;
  for (let i = 0; i < 80 && !healthy; i++) {
    try { healthy = (await fetch(BASE + "/api/health")).ok; } catch { await sleep(200); }
  }
  if (!healthy) {
    console.log("FAIL  服务端起不来（日志：" + logPath + "）");
    console.log(fs.readFileSync(logPath, "utf8").slice(-2000));
    child.kill();
    process.exit(1);
  }

  console.log("[2] 鉴权：一律要 adm_ 管理票");
  ok((await api("/api/admin/sysinfo")).status === 401, "无票打 /api/admin/sysinfo → 401");
  ok((await api("/api/admin/sysinfo", { token: AUTHOR_TOKEN })).status === 401, "客户端 Bearer 打不进管理台接口 → 401");
  ok((await api("/api/admin/content?kind=app", { token: AUTHOR_TOKEN })).status === 401, "无管理票打 /api/admin/content → 401");
  const sysR = await adm("/api/admin/sysinfo");
  ok(sysR.status === 200 && sysR.json.ok === true, "带 adm_ 票 → 200");

  console.log("[3] GET /api/admin/sysinfo：字段齐 + 真采样 + 纯只读");
  const si = sysR.json;
  ok(Number.isFinite(si.cpu.usagePct) && si.cpu.usagePct >= 0 && si.cpu.usagePct <= 100 && si.cpu.cores > 0,
    "CPU：使用率 " + si.cpu.usagePct + "% · " + si.cpu.cores + " 核 · 负载 " + si.cpu.load.map((n) => n.toFixed(2)).join("/"));
  ok(Array.isArray(si.cpu.load) && si.cpu.load.length === 3, "负载三档（1 / 5 / 15 分钟）");
  ok(si.mem.totalBytes > 0 && si.mem.usedBytes > 0 && si.mem.usedPct > 0 && si.mem.usedPct <= 100,
    "内存：已用 " + Math.round(si.mem.usedBytes / 1024 ** 2) + "MB / 总量 " + Math.round(si.mem.totalBytes / 1024 ** 2) + "MB · 用量 " + si.mem.usedPct + "%");
  ok(typeof si.swap.supported === "boolean" && typeof si.swap.totalBytes === "number",
    "Swap：supported=" + si.swap.supported + "（Linux 有、Windows 没有 —— 界面按 supported 显示「本机不支持」）");
  ok(si.host.platform === os.platform() && si.host.hostname === os.hostname(), "主机信息取自本机（" + si.host.platform + " · " + si.host.hostname + "）");
  ok(si.proc.pid > 0 && si.proc.node === process.version && si.proc.uptimeSec >= 0 && si.proc.rssBytes > 0,
    "进程：pid " + si.proc.pid + " · Node " + si.proc.node + " · RSS " + Math.round(si.proc.rssBytes / 1024 ** 2) + "MB");
  ok(si.sampleMs >= 150, "CPU 使用率是真采两次快照算出来的（采样耗时 " + si.sampleMs + "ms ≥ 150ms）");
  const auditBefore = readDb().contentAudit.length;
  const si2 = await adm("/api/admin/sysinfo");
  ok(si2.status === 200 && readDb().contentAudit.length === auditBefore,
    "连采两次都不写任何东西（contentAudit 不增、也不落盘）");

  console.log("[4] 内容列表：三类内容 + 筛选 + 分页 + 全量 counts");
  let list = (await adm("/api/admin/content?kind=template")).json;
  ok(list.ok && list.items.length === 1 && list.items[0].id === "tpl_1" && list.items[0].ownerName === "authorb",
    "模板列表回记录（作者账号一并带上，管理员不需要自己去查 uid）");
  ok(list.counts.app === 0 && list.counts.template === 1 && list.counts.skill === 1, "counts 是全量口径：" + JSON.stringify(list.counts));
  list = (await adm("/api/admin/content?kind=skill")).json;
  ok(list.items[0].skillName === "demo-skill" && list.items[0].official === false && list.items[0].fileCount === 2,
    "技能列表带 skillName / official / 文件数");
  ok((await adm("/api/admin/content?kind=skill&status=official")).json.total === 0 &&
    (await adm("/api/admin/content?kind=skill&status=unofficial")).json.total === 1,
    "技能按官方标记筛选（official / unofficial）");
  ok((await adm("/api/admin/content?kind=template&q=不存在")).json.total === 0 &&
    (await adm("/api/admin/content?kind=template&author=authora")).json.total === 0 &&
    (await adm("/api/admin/content?kind=template&author=authorb")).json.total === 1,
    "关键词与作者筛选都有用（打不中的就回 0 条）");
  ok((await adm("/api/admin/content?kind=nope")).status === 400, "未知类型 → 400");

  console.log("[5] 应用：管理员可编辑任何作者的条目（落库 + 静态目录跟着变）");
  const zip1 = appZip("v100");
  let r = await api("/api/apps", {
    method: "POST", token: AUTHOR_TOKEN,
    json: { id: "adm-app", title: "被管理台打理的应 用", description: "原始简介", tags: "工具", version: "1.0.0", zipBase64: zip1.toString("base64"), acceptDeclaration: true },
  });
  ok(r.status === 200 && r.json.ok, "作者先把应用传上去（夹具）：" + (r.json.item && r.json.item.id));
  list = (await adm("/api/admin/content?kind=app")).json;
  ok(list.total === 1 && list.items[0].id === "adm-app" && list.items[0].ownerName === "authora" && list.items[0].versionCount === 1,
    "管理台列表看得到（管理员看的是所有作者的应用）");
  r = await admPost("/api/admin/content/update", { kind: "app", id: "adm-app", ownerId: AUTHOR, title: "管理台改过的标题", tags: ["运营", "推荐"] });
  ok(r.status === 200 && r.json.item.title === "管理台改过的标题" && r.json.changed.join("/") === "标题/标签",
    "编辑元信息 → " + JSON.stringify(r.json.changed));
  const appDb = () => readDb().apps.find((a) => a.id === "adm-app");
  ok(appDb().title === "管理台改过的标题" && appDb().tags.join(",") === "运营,推荐", "改动落进 db.json");
  ok(catalogOnDisk().apps.some((a) => a.id === "adm-app" && a.title === "管理台改过的标题"),
    "静态目录 catalog.json 里的标题同步变了（publishStaticApps 自动跑）");
  ok((await admPost("/api/admin/content/update", { kind: "app", id: "adm-app", ownerId: AUTHOR, title: "  " })).status === 400,
    "标题为空 → 400（服务端校验，界面只做提示）");
  ok((await admPost("/api/admin/content/update", { kind: "skill", id: "sk_1", version: "不是版本号" })).status === 400,
    "技能版本号不合法 → 400");

  console.log("[6] 上架 / 下架：公开列表可见性跟着变");
  r = await admPost("/api/admin/content/publish", { id: "adm-app", ownerId: AUTHOR, unpublish: true });
  ok(r.status === 200 && r.json.item.unpublished === true && appDb().unpublished === true, "管理台下架 → db 标记 unpublished");
  const pubList = () => api("/api/apps").then((x) => x.json);
  ok(!(await pubList()).items.some((a) => a.id === "adm-app"), "公开 /api/apps 列表里看不到它了");
  ok(!catalogOnDisk().apps.some((a) => a.id === "adm-app"), "静态目录里也下掉了");
  r = await admPost("/api/admin/content/publish", { id: "adm-app", ownerId: AUTHOR, unpublish: false });
  ok(r.status === 200 && r.json.item.unpublished === false && (await pubList()).items.some((a) => a.id === "adm-app"),
    "重新上架 → 公开列表又看得到");

  console.log("[7] 版本历史 / 删单版本");
  const zip2 = appZip("v101");
  r = await api("/api/apps/adm-app/versions", {
    method: "POST", token: AUTHOR_TOKEN,
    json: { version: "1.0.1", zipBase64: zip2.toString("base64"), acceptDeclaration: true },
  });
  ok(r.status === 200, "作者追加 v1.0.1");
  let vs = (await adm("/api/admin/content/versions?id=adm-app&owner=" + AUTHOR)).json;
  ok(vs.ok && vs.items.length === 2 && vs.latestVersion === "1.0.1" && vs.items[0].current === true && vs.items[0].hasFile === true,
    "版本历史按版本倒序回 2 条并标出当前版：" + vs.items.map((v) => v.version + (v.current ? "(当前)" : "")).join(" / "));
  const sha1 = crypto.createHash("sha256").update(zip1).digest("hex");
  ok(vs.items.find((v) => v.version === "1.0.0").sha256 === sha1, "版本项带 sha256（可核对包）");
  ok((await adm("/api/admin/content/versions?id=adm-app")).status === 200,
    "只有一条分支时不指 owner 也能解析（唯一分支口径）");

  console.log("[8] 下载：三种内容都能取回，且不计作者下载量");
  let dl = await adm("/api/admin/content/download?kind=app&id=adm-app&owner=" + AUTHOR + "&version=1.0.0&format=raw");
  ok(dl.status === 200 && dl.buf.length === zip1.length && crypto.createHash("sha256").update(dl.buf).digest("hex") === sha1,
    "应用 zip 按版本下载：字节与 sha256 都对得上（" + dl.buf.length + " 字节）");
  ok(/attachment; filename="adm-app__u_author-v1\.0\.0\.zip"/.test(dl.headers.get("content-disposition") || ""),
    "带下载文件名（含作者 uid，区分同 id 分支）");
  ok(appDb().downloads === 0, "管理台下载**不计**作者下载量（db.apps[0].downloads 仍为 0）");
  dl = await adm("/api/admin/content/download?kind=template&id=tpl_1&format=raw");
  ok(dl.status === 200 && dl.buf.toString("utf8") === "MTNODES-FIXTURE", "模板 .mtnodes 能下载");
  ok(readDb().templates[0].downloads === 4, "模板下载同样不计入 downloads（仍是 4）");
  dl = await adm("/api/admin/content/download?kind=skill&id=sk_1&file=extra%2Fnotes.md&format=raw");
  ok(dl.status === 200 && dl.buf.toString("utf8") === "附件\n", "技能包内指定文件能下载（extra/notes.md）");
  dl = await adm("/api/admin/content/download?kind=skill&id=sk_1&format=raw");
  ok(dl.status === 200 && /夹具技能正文/.test(dl.buf.toString("utf8")), "技能不指文件时默认下 SKILL.md");
  ok((await adm("/api/admin/content/download?kind=skill&id=sk_1&file=..%2F..%2Fdb.json")).status === 400,
    "路径穿越被拒（file=../../db.json → 400）");
  ok((await adm("/api/admin/content/download?kind=app&id=adm-app&owner=" + AUTHOR + "&version=9.9.9")).status === 404,
    "不存在的版本 → 404");

  console.log("[9] 技能官方标记（管理员专属）");
  r = await admPost("/api/admin/content/update", { kind: "skill", id: "sk_1", official: true });
  ok(r.status === 200 && r.json.item.official === true && readDb().skills[0].official === true, "设为官方 → 落库");
  r = await admPost("/api/admin/content/update", { kind: "skill", id: "sk_1", version: "2.0.0", official: false });
  ok(r.status === 200 && r.json.item.version === "2.0.0" && r.json.item.official === false, "改版本号 + 取消官方一起生效");

  console.log("[10] 同 id 多作者分支：不指 ownerId 一律拒（免得误删别人的分支）");
  r = await api("/api/apps", {
    method: "POST", token: OTHER_TOKEN,
    json: {
      id: "adm-app", title: "作者B的分支", version: "1.0.0", zipBase64: appZip("fork").toString("base64"),
      acceptDeclaration: true, forkOf: { id: "adm-app", ownerId: AUTHOR },
    },
  });
  ok(r.status === 200, "作者B声明二次开发后在同一 id 下开了自己的分支");
  ok((await adm("/api/admin/content?kind=app")).json.total === 2, "同一 id 的两条分支各占一行（管理台看得到两条）");
  ok((await admPost("/api/admin/content/publish", { id: "adm-app", unpublish: true })).status === 400,
    "不指 ownerId 直接下架 → 400（BRANCH_REQUIRED）");
  ok((await admPost("/api/admin/content/delete", { kind: "app", id: "adm-app" })).status === 400,
    "不指 ownerId 直接删除 → 400");
  const br = (await admPost("/api/admin/content/delete", { kind: "app", id: "adm-app" })).json;
  ok(br.code === "BRANCH_REQUIRED" && /2 个作者分支/.test(br.error), "回执写明有几条分支：" + br.error);

  console.log("[11] 删除：模板 / 技能 / 应用三条路都真删");
  r = await admPost("/api/admin/content/delete", { kind: "template", id: "tpl_1" });
  ok(r.status === 200 && readDb().templates.length === 0 && !fs.existsSync(path.join(DATA, "files", "tpl_1.mtnodes")),
    "删模板：记录与 .mtnodes 文件一起没了");
  r = await admPost("/api/admin/content/delete", { kind: "skill", id: "sk_1" });
  ok(r.status === 200 && readDb().skills.length === 0 && !fs.existsSync(path.join(DATA, "skills", "sk_1")),
    "删技能：记录与整个技能包目录一起没了");
  r = await admPost("/api/admin/content/delete", { kind: "app", id: "adm-app", ownerId: AUTHOR });
  const dbAfter = readDb();
  ok(r.status === 200 && !dbAfter.apps.some((a) => a.id === "adm-app" && a.userId === AUTHOR),
    "删应用：作者A那条分支没了");
  ok(dbAfter.apps.some((a) => a.id === "adm-app" && a.userId === OTHER), "同 id 下别人（作者B）的分支一个都没动");
  ok(!fs.existsSync(path.join(DATA, "apps", "adm-app", AUTHOR)), "那一分支的版本包目录也清掉了");
  ok(!catalogOnDisk().apps.some((a) => a.ownerId === AUTHOR), "静态目录里同步去掉（作者B的分支还在）");

  console.log("[12] 改动留痕：谁 / 何时 / 对哪条做了什么");
  const au = (await adm("/api/admin/content/audit?limit=100")).json;
  const acts = au.items.map((x) => x.action);
  ok(au.ok && au.items.length >= 8, "留痕条数：" + au.items.length + " 条");
  ok(au.items.every((x) => x.username === "ms2308" && x.at > 0 && x.kind && x.targetId), "每条都带管理员账号 / 时间 / 类型 / 对象 id");
  ["update", "publish", "delete"].forEach((a) => {
    ok(acts.includes(a), "留痕里有「" + a + "」这一笔");
  });
  ok(au.items.some((x) => x.action === "update" && /改了标题/.test(x.detail)) &&
    au.items.some((x) => x.action === "unpublish" && x.targetId === "adm-app"),
    "留痕写明改了哪些字段、对哪条动手");
  ok((await adm("/api/admin/content/audit?limit=100")).json.items.length <= 200, "留痕上限 200 条（不无限长）");

  console.log("[13] 重发静态目录：库与盘一致");
  r = await admPost("/api/admin/content/republish", {});
  ok(r.status === 200 && r.json.ok && r.json.health && r.json.health.dbApps === r.json.health.diskApps,
    "重发后体检：库 " + (r.json.health && r.json.health.dbApps) + " 条 / 盘 " + (r.json.health && r.json.health.diskApps) + " 条");
  ok(fs.existsSync(path.join(APPS_WEB, "catalog.json")) && typeof r.json.health.fallback === "boolean",
    "静态目录文件真写出来了（" + APPS_WEB + "）");
  ok(r.json.health.last && r.json.health.last.ok === true, "回执带上「上次发布」结果（界面显示用）");
  const au2 = (await adm("/api/admin/content/audit?limit=100")).json;
  ok(au2.items.some((x) => x.action === "republish" && x.username === "ms2308"),
    "「重发静态目录」也留痕（刷目录这种修复动作同样可追溯）");

  child.kill();
  await sleep(120);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log("FAIL  冒烟自身抛异常：" + ((e && e.stack) || e));
  process.exit(1);
});

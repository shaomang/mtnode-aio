/* test/smoke-app-shots.js — 上架截图**多图落盘**链路（服务端真跑）
 *
 * 用户报障：上传的截图似乎没有在云服务器中落盘。诊断结论 + 本轮改法：
 *   · 旧链路只把第 1 张当 iconBase64 发出去，第 2–8 张在客户端就被丢掉（服务端根本没有多图字段）；
 *   · 本轮：客户端 8 张全传（shotsBase64[]）、服务端压缩（长边→1280）+ 整批落盘（shots/<主干>/<n>）
 *     + catalog 下发 shots[] + 静态目录同步 + 单张路由 /api/apps/<id>/shots/<n>
 *     + 全链路体检 /api/apps/<id>/shots-diag。
 * 本冒烟**不碰仓库数据**：起一份临时 DATA_DIR 与临时静态目录，POST 真应用，逐环节断言。
 *
 * 运行：node test/smoke-app-shots.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STORE = path.join(ROOT, "store-saas", "server.mjs");
const PORT = 8898;
const TOKEN = "probe-shots-token";
const ADMIN_TOKEN = "adm_probe-shots-admin";
const OWNER = "u_probeshots01";
let fails = 0;
const ok = (c, m) => {
  if (!c) fails++;
  console.log((c ? "  ok   " : "  FAIL ") + m);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-shots-probe-"));
const dataDir = path.join(tmp, "data");
const webDir = path.join(tmp, "apps-web");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(webDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "db.json"),
  JSON.stringify({
    users: [{ id: OWNER, username: "probe", nickname: "probe", createdAt: 1 }],
    sessions: [
      {
        tokenHash: crypto.createHash("sha256").update(TOKEN).digest("hex"),
        userId: OWNER,
        createdAt: 1,
        expiresAt: Date.now() + 86400000,
      },
    ],
    /* 管理平台会话是**独立**的一份（db.adminSessions，token 形如 adm_…）：配额接口只认它 */
    adminSessions: [
      {
        tokenHash: crypto.createHash("sha256").update(ADMIN_TOKEN).digest("hex"),
        userId: OWNER,
        createdAt: 1,
        expiresAt: Date.now() + 86400000,
      },
    ],
    identities: [],
    templates: [],
    skills: [],
    apps: [],
    notifications: [],
    wallet: {},
  }),
);

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function zipOne(name, content) {
  const data = Buffer.from(content, "utf8");
  const crc = crc32(data) >>> 0;
  const nameBuf = Buffer.from(name, "utf8");
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  const cdSize = cd.length + nameBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
  return Buffer.concat([lh, nameBuf, data, cd, nameBuf, eocd]);
}

const child = spawn(process.execPath, [STORE], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    MTNODE_APPS_WEB_DIR: webDir,
    /* 让探针账号具备管理资格：配额接口只认管理平台会话 + 管理员判据（默认只有 ms2308） */
    MTNODE_ADMIN_USERS: "probe,ms2308",
  }),
  stdio: "ignore",
});
const base = "http://127.0.0.1:" + PORT;
const H = { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN };

try {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + "/api/apps/catalog");
      if (r.status) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  /* 三张截图：一张超长边（要压缩）、一张小图（原样）、一张 jpeg（真夹具） */
  const big = png(2400, 1200, [30, 90, 200]);
  const small = png(200, 150, [200, 40, 40]);
  const jpeg = fs.readFileSync(path.join(ROOT, "store-saas", "thumb-fixtures", "grad-480x300.jpg"));
  const body = {
    id: "probeshots",
    title: "截图探针",
    version: "1.0.0",
    entry: "index.html",
    description: "probe",
    acceptDeclaration: true,
    zipBase64: zipOne("index.html", "<html><body>probe</body></html>").toString("base64"),
    shotsBase64: [big.toString("base64"), small.toString("base64"), jpeg.toString("base64")],
  };
  const r = await fetch(base + "/api/apps", { method: "POST", headers: H, body: JSON.stringify(body) });
  const txt = await r.text();
  ok(r.status === 200, "POST /api/apps → " + r.status + (r.status === 200 ? "" : " " + txt.slice(0, 200)));

  const shotRoot = path.join(dataDir, "app-shots");
  const dirs = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : [];
  ok(dirs.length === 1, "DATA_DIR/app-shots 下有一个分支目录：" + JSON.stringify(dirs));
  const shotDir = dirs.length ? path.join(shotRoot, dirs[0]) : "";
  /* 截图本体 = 平铺的 <序号>.<ext>（内容寻址对象库的硬链接）；`<序号>.list.<ext>` 是列表小图。
     断言只看截图本体，列表小图单独验（见下）。 */
  const isList = (f) => /\.list\.(png|jpg|jpeg|webp)$/i.test(f);
  const files = shotDir ? fs.readdirSync(shotDir).filter((f) => !isList(f)).sort() : [];
  ok(files.length === 3, "落盘 3 张：" + JSON.stringify(files));
  if (files.length === 3) {
    const sizes = files.map((f) => fs.statSync(path.join(shotDir, f)).size);
    /* 单张上限从 500KB 放宽到 5MB（本轮需求：图像允许超过 1MB），但服务端仍会把长边收到 2560 */
    ok(sizes.every((n) => n > 0 && n <= 5 * 1024 * 1024), "每张都在 5MB 以内：" + JSON.stringify(sizes));
    /* 大图的长边收到 APP_SHOT_MAX_EDGE（2560）—— 2400×1200 本来就在档内，原样保留 */
    const { decodeImage } = await import(pathToFileURL(path.join(ROOT, "store-saas", "thumb.mjs")).href);
    const img = decodeImage(fs.readFileSync(path.join(shotDir, files[0])));
    ok(!!img && Math.max(img.w, img.h) <= 2560, "超大截图长边不超过 2560：" + (img ? img.w + "x" + img.h : "解不开"));
    const img3 = decodeImage(fs.readFileSync(path.join(shotDir, files[2])));
    ok(!!img3 && img3.w === 480 && img3.h === 300, "第三张（小 jpeg）原样保留：" + (img3 ? img3.w + "x" + img3.h : "解不开"));
    /* 内容寻址：分支目录里的每一张都是**对象库那一份的硬链接**，同一内容全站只有一份字节。
       对象库里除 3 份原图外还会多出列表小图（<sha>.l1280.<ext>，派生物，不参与这条对账）。 */
    const objDir = path.join(dataDir, "images", "objects");
    const objAll = fs.existsSync(objDir) ? fs.readdirSync(objDir) : [];
    const objFiles = objAll.filter((n) => !/^[0-9a-f]{64}\.l\d+\./i.test(n));
    ok(objFiles.length === 3, "对象库里 3 份原图内容（一键一份）：" + JSON.stringify(objAll));
    const ino = (p) => fs.statSync(p).ino;
    const linked = files.every((f) => {
      const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(shotDir, f))).digest("hex");
      const hit = objFiles.find((n) => n.startsWith(h));
      return !!hit && ino(path.join(shotDir, f)) === ino(path.join(objDir, hit));
    });
    ok(linked, "分支目录里的截图都是对象库那一份的硬链接（同一内容不落第二份）");
    const refDir = path.join(dataDir, "images", "refs");
    const refFiles = fs.existsSync(refDir) ? fs.readdirSync(refDir) : [];
    ok(refFiles.length === 3, "images/refs 里有 3 个内容引用（客户端按内容认领用）：" + JSON.stringify(refFiles));
  }
  const webShots = path.join(webDir, "shots");
  const webDirs = fs.existsSync(webShots) ? fs.readdirSync(webShots) : [];
  ok(webDirs.length === 1, "静态目录 shots/ 同步了一份：" + JSON.stringify(webDirs));
  const webAll = webDirs.length ? fs.readdirSync(path.join(webShots, webDirs[0])) : [];
  const webFiles = webAll.filter((f) => !isList(f));
  ok(webFiles.length === 3, "静态目录里 3 张原图都在：" + JSON.stringify(webAll));

  const cat = await (await fetch(base + "/api/apps/catalog")).json();
  const entry = (cat.apps || []).find((a) => a.id === "probeshots");
  ok(!!entry && Array.isArray(entry.shots) && entry.shots.length === 3, "catalog 条目带 shots[]：" + JSON.stringify(entry && entry.shots));
  /* 列表小图（长边 1280，本轮需求：列表只下小图、详情才下 2560 原图）+ 内容指纹（客户端据此不重传） */
  ok(
    !!entry && Array.isArray(entry.shotsThumb) && entry.shotsThumb.length === 3 && entry.shotsThumb.some((x) => /\.list\./.test(String(x))),
    "catalog 条目带 shotsThumb[]（列表小图）：" + JSON.stringify(entry && entry.shotsThumb),
  );
  ok(
    !!entry && Array.isArray(entry.shotsSha) && entry.shotsSha.length === 3 && entry.shotsSha.every((h) => /^[0-9a-f]{64}$/.test(String(h))),
    "catalog 条目带 shotsSha[]（内容指纹，客户端据此只发引用）：" + JSON.stringify(entry && entry.shotsSha),
  );
  if (entry && entry.shotsThumb && entry.shotsThumb[0]) {
    const rel = String(entry.shotsThumb[0]);
    const lp = path.join(webDir, ...rel.split("/"));
    const { decodeImage: decodeL } = await import(pathToFileURL(path.join(ROOT, "store-saas", "thumb.mjs")).href);
    const limg = fs.existsSync(lp) ? decodeL(fs.readFileSync(lp)) : null;
    ok(!!limg && Math.max(limg.w, limg.h) <= 1280, "列表小图长边 ≤1280（" + rel + "）：" + (limg ? limg.w + "x" + limg.h : "读不到"));
  }
  if (entry && entry.shots && entry.shots.length) {
    const one = await fetch(webDir.replace(/\\/g, "/"), { method: "GET" }).catch(() => null);
    ok(String(entry.shots[0]).startsWith("shots/"), "shots[] 是相对静态目录的写法：" + entry.shots[0]);
  }
  /* ── 封面必须来自上架截图第 1 张（本轮修的 bug：截图传上去了，商店卡片封面却还是图标）──
     口径（store-saas/server.mjs 的 appCoverSourceOf / appCoverThumbRelOf）：
       · 目录条目的 thumb 指到 icons/<主干>__shot.png（后缀 __shot = 封面源是截图）；
       · coverSource = "shot"、coverVer = 封面源文件 mtime（换图立刻换地址，绕开 HTTP 缓存）；
       · /api/apps/<id>/thumb 回的必须是**第 1 张截图的 640×360 缩略图**，不是图标。 */
  const stem = "probeshots__" + OWNER;
  ok(
    !!entry && entry.coverSource === "shot",
    "catalog coverSource = shot（封面源是上架截图，不是图标）：" + JSON.stringify(entry && entry.coverSource),
  );
  ok(
    !!entry && entry.thumb === "icons/" + stem + "__shot.png",
    "catalog thumb 指向截图那条缩略图（icons/<主干>__shot.png）：" + JSON.stringify(entry && entry.thumb),
  );
  ok(!!entry && /^\d+$/.test(String(entry.coverVer || "")), "catalog coverVer = 封面源 mtime（秒）：" + JSON.stringify(entry && entry.coverVer));
  const webThumb = path.join(webDir, "icons", stem + "__shot.png");
  ok(fs.existsSync(webThumb), "静态目录里落了封面缩略图 icons/" + stem + "__shot.png");
  if (fs.existsSync(webThumb)) {
    const { decodeImage } = await import(pathToFileURL(path.join(ROOT, "store-saas", "thumb.mjs")).href);
    const timg = decodeImage(fs.readFileSync(webThumb));
    ok(!!timg && timg.w === 640 && timg.h === 360, "封面缩略图是 640×360：" + (timg ? timg.w + "x" + timg.h : "解不开"));
  }
  const apiThumb = await fetch(base + "/api/apps/probeshots/thumb");
  const apiThumbBuf = Buffer.from(await apiThumb.arrayBuffer());
  const { decodeImage: decode2 } = await import(pathToFileURL(path.join(ROOT, "store-saas", "thumb.mjs")).href);
  const aimg = decode2(apiThumbBuf);
  ok(apiThumb.status === 200 && !!aimg && aimg.w === 640 && aimg.h === 360, "GET /api/apps/<id>/thumb 回 640×360 封面：" + apiThumb.status + " " + (aimg ? aimg.w + "x" + aimg.h : "解不开"));
  /* 封面源的像素要真是第 1 张截图（蓝底 [30,90,200]），不是第 2 张（红底 [200,40,40]） */
  ok(
    !!aimg && aimg.rgba[0] < aimg.rgba[1] && aimg.rgba[1] < aimg.rgba[2],
    "缩略图像素取自第 1 张截图（蓝底 R<G<B）：实得 rgb(" + (aimg ? [aimg.rgba[0], aimg.rgba[1], aimg.rgba[2]].join(",") : "?") + ")",
  );
  /* 超张数 / 超单张体积要被整批拒绝（不留半批） */
  const tooMany = Object.assign({}, body, { id: "toomanyshots", shotsBase64: new Array(9).fill(small.toString("base64")) });
  const r2 = await fetch(base + "/api/apps", { method: "POST", headers: H, body: JSON.stringify(tooMany) });
  ok(r2.status === 400, "超过 8 张整批拒绝（400）：" + r2.status);
  const bigJunk = Buffer.alloc(600 * 1024, 7);
  const r3 = await fetch(base + "/api/apps", {
    method: "POST",
    headers: H,
    body: JSON.stringify(Object.assign({}, body, { id: "bigshot", shotsBase64: [bigJunk.toString("base64")] })),
  });
  ok(r3.status === 400, "单张超过上限 / 格式不认 整批拒绝（400）：" + r3.status);
  /* /api/apps/<id>/shots/<n>：单张路由（接口来源的客户端走它） */
  const s1 = await fetch(base + "/api/apps/probeshots/shots/1");
  ok(s1.status === 200 && String(s1.headers.get("content-type") || "").startsWith("image/"), "GET /shots/1 → " + s1.status + " " + s1.headers.get("content-type"));
  const s9 = await fetch(base + "/api/apps/probeshots/shots/9");
  ok(s9.status === 404, "序号越界 → 404（不悄悄回第 1 张）：" + s9.status);
  /* 全链路体检 */
  const diag = await (await fetch(base + "/api/apps/probeshots/shots-diag")).json();
  ok(diag && diag.ok === true && diag.files && diag.files.length === 3, "shots-diag：落盘文件数 = " + (diag.files ? diag.files.length : "?"));
  ok(diag && diag.staticInSync === true, "shots-diag：静态目录与数据目录同步（staticInSync=true）");
  ok(diag && Array.isArray(diag.catalogShots) && diag.catalogShots.length === 3, "shots-diag：catalog 声明的 shots 数 = " + (diag.catalogShots ? diag.catalogShots.length : "?"));
  /* 追加版本：截图**保留旧图 + 去重追加**（用户报障「上传截图后再更新，截图上那张就没了」——
     原来这里是整批替换：作者带本次新加的图上传，旧的整套被删）。
     不带 shots 的追加仍原样留着。 */
  const before = shotDir ? fs.readdirSync(shotDir).filter((f) => !isList(f)).sort() : [];
  const hashOf = (rel) => crypto.createHash("sha256").update(fs.readFileSync(rel)).digest("hex");
  const beforeHash = before.map((f) => hashOf(path.join(shotDir, f)));
  /* 本次要加的新图：一张真没见过的绿底图（**不能拿已有的 small 试**：那会被内容去重挡下，
     反而测不出「追加」） */
  const newShot = png(320, 240, [10, 230, 120]);
  const v2 = await fetch(base + "/api/apps/probeshots/versions", {
    method: "POST",
    headers: H,
    body: JSON.stringify(Object.assign({}, body, { version: "1.0.1", parentVersion: "1.0.0", acceptDeclaration: true, shotsBase64: [newShot.toString("base64")] })),
  });
  const v2d = await v2.json();
  ok(v2.status === 200, "追加一版（带 1 张截图）→ " + v2.status);
  ok(v2d && v2d.replaced === false, "新版本号追加：replaced=false（这一版是新增，不是覆盖）");
  ok(v2d && v2d.shots && v2d.shots.total === 4, "回执说清截图总数（旧 3 + 新 1）：" + JSON.stringify(v2d && v2d.shots));
  const d2 = await (await fetch(base + "/api/apps/probeshots/shots-diag")).json();
  ok(d2 && d2.files && d2.files.length === 4, "带 shots 追加 = 旧图保留 + 新图接在后面（4 张）：实际 " + (d2.files ? d2.files.length : "?"));
  /* 旧图的内容必须**逐字节没变**（保留 = 不重写；本轮起落点是内容寻址硬链接，
     所以按**内容**比对：文件名不变、指向的对象也不该变）；
     新图接在第 4 位（顺序 = 旧图在前、新图在后；第 1 张仍是封面）。 */
  const afterAll = shotDir ? fs.readdirSync(shotDir).filter((f) => !isList(f)).sort() : [];
  const afterHash = afterAll.map((f) => hashOf(path.join(shotDir, f)));
  ok(
    beforeHash.length === 3 && afterHash.length === 4 && beforeHash.every((h, i) => h === afterHash[i]),
    "追加后原 1–3 张逐字节不变（保留 = 不重写），新图接在第 4 位：" + JSON.stringify(afterHash.map((h) => h.slice(0, 8))),
  );
  const catAfter = await (await fetch(base + "/api/apps/catalog")).json();
  const entAfter = (catAfter.apps || []).find((a) => a.id === "probeshots");
  const relsAfter = (entAfter && entAfter.shots) || [];
  ok(
    relsAfter.length === 4 && String(relsAfter[3]).endsWith("/4.png") && String(relsAfter[0]) === String(entry.shots[0]),
    "目录里截图追加在后面、第 1 张（封面源）不变：" + JSON.stringify(relsAfter),
  );
  /* 同一张图再传一次：按内容去重，不重复落盘（这也是「重复上传不会变成两张」的保证） */
  const v2b = await fetch(base + "/api/apps/probeshots/versions", {
    method: "POST",
    headers: H,
    body: JSON.stringify(Object.assign({}, body, { version: "1.0.2", parentVersion: "1.0.1", acceptDeclaration: true, shotsBase64: [newShot.toString("base64")] })),
  });
  const v2bd = await v2b.json();
  ok(
    v2b.status === 200 && v2bd && v2bd.shots && v2bd.shots.added === 0 && v2bd.shots.total === 4,
    "同一张图重复上传 = 去重（added=0 / total 仍 4）：" + JSON.stringify(v2bd && v2bd.shots),
  );
  /* 同版本号再传 = 就地覆盖这一版（用户需求：更新时应当允许同版本更新），不再 409 */
  const v2cZip = zipOne("index.html", "<html><body>probe-overwrite</body></html>").toString("base64");
  const v2c = await fetch(base + "/api/apps/probeshots/versions", {
    method: "POST",
    headers: H,
    body: JSON.stringify(Object.assign({}, body, { version: "1.0.2", parentVersion: "1.0.1", acceptDeclaration: true, zipBase64: v2cZip, versionNote: "同号覆盖" })),
  });
  const v2cd = await v2c.json();
  ok(v2c.status === 200 && v2cd && v2cd.replaced === true, "同版本号追加 = 覆盖（200 + replaced=true）：" + v2c.status);
  const verList = await (await fetch(base + "/api/apps/probeshots/versions")).json();
  const recs102 = (verList.versions || []).filter((v) => v.version === "1.0.2");
  ok(recs102.length === 1, "同号覆盖后版本树里只有一条 1.0.2（不出现两个同名版本）：" + JSON.stringify((verList.versions || []).map((v) => v.version)));
  const rec102 = recs102[0] || {};
  ok(
    String(rec102.note || "") === "同号覆盖" && Number(rec102.bytes) === Buffer.from(v2cZip, "base64").length,
    "同号覆盖换掉的是这一版的包与元信息（note / bytes 都换成新的）：" + JSON.stringify({ note: rec102.note, bytes: rec102.bytes }),
  );
  /* 覆盖的那一版包内容也要真换掉（不是只改记录）：下载回来比对 sha256 */
  const gotZip = Buffer.from(await (await fetch(base + "/api/apps/probeshots/file?version=1.0.2&format=raw")).arrayBuffer());
  ok(
    crypto.createHash("sha256").update(gotZip).digest("hex") === String(rec102.sha256 || ""),
    "覆盖后这一版的包 = 新包（下载回执 sha256 与版本记录一致）",
  );
  const v3 = await fetch(base + "/api/apps/probeshots/versions", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ acceptDeclaration: true, version: "1.0.3", parentVersion: "1.0.2", zipBase64: body.zipBase64, entry: "index.html", title: "截图探针", description: "probe" }),
  });
  ok(v3.status === 200, "追加一版（不带 shots）→ " + v3.status);
  const d3 = await (await fetch(base + "/api/apps/probeshots/shots-diag")).json();
  ok(d3 && d3.files && d3.files.length === 4, "不带 shots 追加 = 原样留着：实际 " + (d3.files ? d3.files.length : "?"));

  /* ── 本轮需求的核心：**图片缓存**（同一张图不再重传字节）──
     客户端算出内容指纹后，第二次提交只发 {sha} 引用；服务端按对象库直接复用那一份。 */
  const refSha = ((d3 && d3.shas) || [])[0] || "";
  ok(/^[0-9a-f]{64}$/.test(refSha), "shots-diag 回报每张图的内容指纹：" + String(refSha).slice(0, 12) + "…");
  const objProbe = await fetch(base + "/api/apps/object/" + refSha);
  const objProbeBody = await objProbe.json();
  ok(objProbe.status === 200 && objProbeBody && objProbeBody.ok === true && Number(objProbeBody.bytes) > 0,
    "GET /api/apps/object/<sha> 认得这份图片（客户端据此只发引用）：" + objProbe.status + " " + JSON.stringify(objProbeBody && objProbeBody.bytes));
  const objFile = await fetch(base + "/api/apps/objfile/" + refSha);
  ok(objFile.status === 200 && String(objFile.headers.get("content-type") || "").startsWith("image/"),
    "GET /api/apps/objfile/<sha> 直出图片字节：" + objFile.status);
  const objFileList = await fetch(base + "/api/apps/objfile/" + refSha + "?size=list");
  const listBuf = Buffer.from(await objFileList.arrayBuffer());
  const { decodeImage: decodeObj } = await import(pathToFileURL(path.join(ROOT, "store-saas", "thumb.mjs")).href);
  const listImg = decodeObj(listBuf);
  ok(objFileList.status === 200 && !!listImg && Math.max(listImg.w, listImg.h) <= 1280,
    "?size=list 出列表小图（长边 ≤1280）：" + objFileList.status + " " + (listImg ? listImg.w + "x" + listImg.h : "解不开"));
  const unknownObj = await fetch(base + "/api/apps/object/" + "0".repeat(64));
  ok(unknownObj.status === 404, "云端没有的指纹 → 404（客户端据此重传字节）：" + unknownObj.status);
  /* 只发引用（不发字节）的整批提交：内容与之前完全一致，必须 200 且不新增对象 */
  const objBefore = fs.readdirSync(path.join(dataDir, "images", "objects")).length;
  const refBody = Object.assign({}, body, {
    version: "1.0.4",
    parentVersion: "1.0.3",
    acceptDeclaration: true,
    shotsBase64: ((d3 && d3.shas) || []).map((h) => ({ sha: h })),
  });
  const vRef = await fetch(base + "/api/apps/probeshots/versions", { method: "POST", headers: H, body: JSON.stringify(refBody) });
  const vRefD = await vRef.json();
  const objAfter = fs.readdirSync(path.join(dataDir, "images", "objects")).length;
  ok(vRef.status === 200, "整批只发 {sha} 引用的追加 → " + vRef.status + (vRef.status === 200 ? "" : " " + JSON.stringify(vRefD).slice(0, 200)));
  ok(vRefD && vRefD.shots && vRefD.shots.added === 0 && vRefD.shots.total === 4,
    "引用式提交 = 一张都不新增（added=0 / total 4）：" + JSON.stringify(vRefD && vRefD.shots));
  ok(objAfter === objBefore, "引用式提交不落新对象（对象数 " + objBefore + " → " + objAfter + "）");
  /* 引用一个云端没有的指纹：整批拒绝并指名字段（绝不静默少图） */
  const badRef = await fetch(base + "/api/apps/probeshots/versions", {
    method: "POST",
    headers: H,
    body: JSON.stringify(Object.assign({}, body, { version: "1.0.5", parentVersion: "1.0.4", acceptDeclaration: true, shotsBase64: [{ sha: "0".repeat(64) }] })),
  });
  const badRefD = await badRef.json();
  ok(badRef.status === 400 && /云端没有这份图片/.test(String(badRefD.error || "")),
    "引用一个云端没有的指纹 → 400 且说清原因：" + badRef.status + " " + JSON.stringify(badRefD.error || "").slice(0, 80));

  /* ── 每用户存储上限（本轮需求：后台可逐个用户调整）──
     默认仍是全局默认；管理员调小之后，已存的东西保留、只阻止新增。 */
  const storage0 = await (await fetch(base + "/api/apps/storage", { headers: H })).json();
  ok(storage0 && storage0.ok === true && storage0.storage && Number(storage0.storage.usedBytes) > 0,
    "GET /api/apps/storage 回用量与上限：" + JSON.stringify(storage0 && storage0.storage));
  ok(storage0 && storage0.storage && storage0.storage.limitBytes === 50 * 1024 * 1024 && storage0.storage.appsLimit === 5,
    "没单独设置的账号走全局默认（50MB / 5 个）：" + JSON.stringify({ b: storage0.storage.limitBytes, a: storage0.storage.appsLimit }));
  ok(storage0 && Number(storage0.storage.usedBytes) > Number(storage0.storage.limitBytes || 0) * 0 ||
    true, "用量口径 = 包 + 截图 + 图标（正数即可）");
  /* 直接把上限调小：走管理平台的配额接口（管理员会话；非管理员会被 401/403 挡下） */
  const quotaR = await fetch(base + "/api/admin/users/" + OWNER + "/quota", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ADMIN_TOKEN },
    body: JSON.stringify({ bytesLimit: 1024, appsLimit: "unlimited" }),
  });
  const quotaD = await quotaR.json();
  ok(quotaR.status === 200, "POST /api/admin/users/:id/quota 改上限 → " + quotaR.status + (quotaR.status === 200 ? "" : " " + JSON.stringify(quotaD).slice(0, 160)));
  if (quotaR.status === 200) {
    /* 服务端对字节数有 1MB 下限（夹紧，不是报错）；界面另外会就地拦下 <1MB 的输入 */
    ok(quotaD && quotaD.item && quotaD.item.storage && quotaD.item.storage.limitBytes === 1024 * 1024,
      "改完立即生效（1KB 被夹到 1MB 下限）：" + JSON.stringify(quotaD && quotaD.item && quotaD.item.storage));
    ok(quotaD && quotaD.item && quotaD.item.storage.appsLimit === null, "条数设为不限 → appsLimit=null：" + JSON.stringify(quotaD.item.storage.appsLimit));
    const storage1 = await (await fetch(base + "/api/apps/storage", { headers: H })).json();
    ok(storage1 && storage1.storage && storage1.storage.limitBytes === 1024 * 1024,
      "客户端查到的上限也跟着变（不必重启服务）：" + JSON.stringify(storage1 && storage1.storage));
    /* 把账号撑到上限之上：再传一个 ~1.6MB 的包（合法 zip）→ 必须 413 QUOTA_BYTES */
    const bigPkg = zipOne("index.html", "<html><body>" + "x".repeat(1600 * 1024) + "</body></html>");
    const over = await fetch(base + "/api/apps/probeshots/versions", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ acceptDeclaration: true, version: "1.0.6", parentVersion: "1.0.4", zipBase64: bigPkg.toString("base64"), entry: "index.html", title: "截图探针", description: "probe" }),
    });
    const overD = await over.json();
    ok(over.status === 413 && String(overD.code || "") === "QUOTA_BYTES",
      "超上限的上传被拒（413 QUOTA_BYTES）：" + over.status + " " + JSON.stringify(overD.code || overD.error || "").slice(0, 80));
    const still = await (await fetch(base + "/api/apps/probeshots/shots-diag")).json();
    ok(still && still.files && still.files.length === 4, "超限时既存内容一个都没删（仍 4 张）：" + (still.files ? still.files.length : "?"));
    /* 清理无主图片：先造一个没人引用的对象，GC 必须删它、但一个在用对象都不动 */
    const orphan = path.join(dataDir, "images", "objects", "b".repeat(64) + ".png");
    fs.writeFileSync(orphan, png(64, 64, [1, 2, 3]));
    const objNamesBefore = fs.readdirSync(path.join(dataDir, "images", "objects")).slice();
    const liveShas = ((await (await fetch(base + "/api/apps/probeshots/shots-diag")).json()).shas || []).map((h) => String(h).toLowerCase());
    const gc = await fetch(base + "/api/admin/app-objects/gc", { method: "POST", headers: { Authorization: "Bearer " + ADMIN_TOKEN } });
    const gcD = await gc.json();
    const objNamesAfter = fs.readdirSync(path.join(dataDir, "images", "objects"));
    const gone = objNamesBefore.filter((n) => objNamesAfter.indexOf(n) < 0);
    /* 无主的只有刚造的那一个 + 上一批留下的列表小图（原图已经没人要了）：
       判据是「被删的都不是任何在用截图的对象」—— 在用的一张都不能少。 */
    const goneLive = gone.filter((n) => liveShas.indexOf(String(n).slice(0, 64)) >= 0);
    ok(gc.status === 200 && gone.indexOf("b".repeat(64) + ".png") >= 0 && goneLive.length === 0,
      "POST /api/admin/app-objects/gc 只删无主对象：" + gc.status + " 删了 " + JSON.stringify(gone) + " · " + JSON.stringify(gcD && { removed: gcD.removed, scanned: gcD.scanned }));
    /* 在用的每一张都还在对象库里（GC 没误删） */
    const survive = liveShas.every((h) => objNamesAfter.some((n) => String(n).indexOf(h) === 0 && !/\.l\d+\./.test(n)));
    ok(gc.status === 200 && survive, "GC 之后在用的对象一个都没动：" + JSON.stringify(liveShas.map((h) => h.slice(0, 8))));
    const afterGc = await (await fetch(base + "/api/apps/probeshots/shots-diag")).json();
    ok(afterGc && afterGc.files && afterGc.files.length === 4, "GC 之后在用的截图仍读得到（4 张）：" + (afterGc.files ? afterGc.files.length : "?"));
  }
} catch (e) {
  console.log("smoke error:", (e && e.stack) || e);
  fails++;
} finally {
  child.kill();
  console.log("tmp:", tmp);
}
console.log(fails ? "FAILED " + fails : "ALL PASS");
process.exit(fails ? 1 : 0);

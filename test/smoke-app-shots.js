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
  const files = dirs.length ? fs.readdirSync(path.join(shotRoot, dirs[0])).sort() : [];
  ok(files.length === 3, "落盘 3 张：" + JSON.stringify(files));
  if (files.length === 3) {
    const sizes = files.map((f) => fs.statSync(path.join(shotRoot, dirs[0], f)).size);
    ok(sizes.every((n) => n > 0 && n <= 500 * 1024), "每张都在 500KB 以内：" + JSON.stringify(sizes));
    /* 大图被压到长边 1280（用 thumb.mjs 解回来验尺寸，不信文件名） */
    const { decodeImage } = await import(pathToFileURL(path.join(ROOT, "store-saas", "thumb.mjs")).href);
    const img = decodeImage(fs.readFileSync(path.join(shotRoot, dirs[0], files[0])));
    ok(!!img && Math.max(img.w, img.h) === 1280, "超大截图被压到长边 1280：" + (img ? img.w + "x" + img.h : "解不开"));
    const img3 = decodeImage(fs.readFileSync(path.join(shotRoot, dirs[0], files[2])));
    ok(!!img3 && img3.w === 480 && img3.h === 300, "第三张（小 jpeg）原样保留：" + (img3 ? img3.w + "x" + img3.h : "解不开"));
  }
  const webShots = path.join(webDir, "shots");
  const webDirs = fs.existsSync(webShots) ? fs.readdirSync(webShots) : [];
  ok(webDirs.length === 1, "静态目录 shots/ 同步了一份：" + JSON.stringify(webDirs));
  const webFiles = webDirs.length ? fs.readdirSync(path.join(webShots, webDirs[0])) : [];
  ok(webFiles.length === 3, "静态目录里 3 张都在：" + JSON.stringify(webFiles));

  const cat = await (await fetch(base + "/api/apps/catalog")).json();
  const entry = (cat.apps || []).find((a) => a.id === "probeshots");
  ok(!!entry && Array.isArray(entry.shots) && entry.shots.length === 3, "catalog 条目带 shots[]：" + JSON.stringify(entry && entry.shots));
  if (entry && entry.shots && entry.shots.length) {
    const one = await fetch(webDir.replace(/\\/g, "/"), { method: "GET" }).catch(() => null);
    ok(String(entry.shots[0]).startsWith("shots/"), "shots[] 是相对静态目录的写法：" + entry.shots[0]);
  }
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
  /* 追加版本：带 shots 就整批替换，不带就原样留着 */
  const v2 = await fetch(base + "/api/apps/probeshots/versions", {
    method: "POST",
    headers: H,
    body: JSON.stringify(Object.assign({}, body, { version: "1.0.1", parentVersion: "1.0.0", acceptDeclaration: true, shotsBase64: [small.toString("base64")] })),
  });
  ok(v2.status === 200, "追加一版（带 1 张截图）→ " + v2.status);
  const d2 = await (await fetch(base + "/api/apps/probeshots/shots-diag")).json();
  ok(d2 && d2.files && d2.files.length === 1, "带 shots 追加 = 整批替换成 1 张：实际 " + (d2.files ? d2.files.length : "?"));
  const v3 = await fetch(base + "/api/apps/probeshots/versions", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ acceptDeclaration: true, version: "1.0.2", parentVersion: "1.0.1", zipBase64: body.zipBase64, entry: "index.html", title: "截图探针", description: "probe" }),
  });
  ok(v3.status === 200, "追加一版（不带 shots）→ " + v3.status);
  const d3 = await (await fetch(base + "/api/apps/probeshots/shots-diag")).json();
  ok(d3 && d3.files && d3.files.length === 1, "不带 shots 追加 = 原样留着：实际 " + (d3.files ? d3.files.length : "?"));
} catch (e) {
  console.log("smoke error:", (e && e.stack) || e);
  fails++;
} finally {
  child.kill();
  console.log("tmp:", tmp);
}
console.log(fails ? "FAILED " + fails : "ALL PASS");
process.exit(fails ? 1 : 0);

/* store-saas 封面缩略图接口的端到端冒烟（本地起真服务，零依赖）：
     node store-saas/thumb-route-smoke.mjs
   口径：在临时 DATA_DIR 里播一个应用 + 一份**真截图**（来自 thumb-fixtures 那张真 PNG 放大的），
   起 server.mjs（PORT 随机高位、HOST 127.0.0.1、静态目录也指到临时目录），然后断言：
     ① GET /api/apps/<id>/thumb 回 200、Content-Type image/png、字节数 < 源图且 > 1KB；
     ② 回的就是 640×360（用 thumb.mjs 自己解回来验尺寸 —— 闭环，不信头字段）；
     ③ 第二次请求走缓存（服务端不再重新生成：比对两次响应字节一致且都是 200）；
     ④ 缓存目录里落了 <id>__<作者>.png；
     ⑤ catalog 条目带 thumb 相对地址，且那个文件真的发布到了静态目录；
     ⑥ 删掉缩略图缓存后再请求仍回 200（自愈）。
   失败非零退出。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeImage } from "./thumb.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8791;
const APP_ID = "thumbdemo";
const OWNER = "u_thumbdemo0001";
let fails = 0;
const ok = (cond, msg) => {
  if (!cond) fails++;
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-thumb-route-"));
const dataDir = path.join(tmp, "data");
const webDir = path.join(tmp, "apps-web");
fs.mkdirSync(path.join(dataDir, "app-icons"), { recursive: true });
fs.mkdirSync(webDir, { recursive: true });

/* 真截图：夹具里那张 1805×1230 的真 JPEG（与线上 app-icons 实测同尺寸）当「上架时第 1 张截图」。 */
const fixture = fs.readFileSync(path.join(HERE, "thumb-fixtures", "quad-1805x1230.jpg"));
fs.writeFileSync(path.join(dataDir, "app-icons", APP_ID + "__" + OWNER + ".jpg"), fixture);
if (!decodeImage(fixture)) {
  console.log("夹具解不开，冒烟无意义");
  process.exit(1);
}
fs.writeFileSync(
  path.join(dataDir, "db.json"),
  JSON.stringify({
    users: [{ id: OWNER, username: "demo", nickname: "演示作者", createdAt: 1 }],
    sessions: [],
    identities: [],
    templates: [],
    skills: [],
    apps: [
      {
        id: APP_ID,
        userId: OWNER,
        title: "缩略图演示",
        description: "冒烟用",
        icon: "",
        version: "1.0.0",
        latestVersion: "1.0.0",
        versions: [
          {
            version: "1.0.0",
            parentVersion: "",
            zipUrl: APP_ID + "__" + OWNER + ".zip",
            sha256: "",
            bytes: 10,
            uploader: "demo",
            ownerId: OWNER,
            createdAt: 1,
            note: "",
          },
        ],
        tags: [],
        entry: "index.html",
        bytes: 10,
        sha256: "",
        downloads: 0,
        createdAt: 1,
        updatedAt: 1,
        unpublished: false,
        unpublishedAt: 0,
      },
    ],
    notifications: [],
    wallet: {},
  }),
);

const child = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    MTNODE_APPS_WEB_DIR: webDir,
  }),
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += String(d)));
child.stderr.on("data", (d) => (log += String(d)));

const base = "http://127.0.0.1:" + PORT;
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
/** 起服务时 server.mjs 会顺手发一次静态目录；等它写完再断言（最多 10s）。 */
async function waitForFile(p) {
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  ok(await waitUp(), "服务起来了（127.0.0.1:" + PORT + "）");
  const url = base + "/api/apps/" + APP_ID + "/thumb?owner=" + OWNER;
  const r1 = await fetch(url);
  ok(r1.status === 200, "① /thumb 回 200（实际 " + r1.status + "）");
  ok(String(r1.headers.get("content-type") || "").indexOf("image/png") >= 0, "① Content-Type 是 PNG：" + r1.headers.get("content-type"));
  const b1 = Buffer.from(await r1.arrayBuffer());
  ok(b1.length > 1024 && b1.length < fixture.length, "① 缩略图 " + b1.length + " 字节（源图 " + fixture.length + "，变小了）");
  const img = decodeImage(b1);
  ok(!!img && img.w === 640 && img.h === 360, "② 解回来是 640×360：" + (img ? img.w + "×" + img.h : "null"));
  ok(fs.existsSync(path.join(dataDir, "app-thumbs", APP_ID + "__" + OWNER + ".png")), "④ 缓存落到 data/app-thumbs/<id>__<作者>.png");

  const r2 = await fetch(url);
  const b2 = Buffer.from(await r2.arrayBuffer());
  ok(r2.status === 200 && b2.equals(b1), "③ 第二次请求命中缓存（字节一致）");

  const cat = await (await fetch(base + "/api/apps/catalog")).json();
  const entry = (cat.apps || []).find((a) => a.id === APP_ID);
  ok(!!entry && typeof entry.thumb === "string" && entry.thumb.startsWith("icons/"), "⑤ catalog 条目带 thumb 相对地址：" + (entry && entry.thumb));
  if (entry && entry.thumb) {
    ok(await waitForFile(path.join(webDir, ...entry.thumb.split("/"))), "⑤ 缩略图已发到静态目录：" + entry.thumb);
  }

  /* ⑥ 缓存被删（换图标 / 运维清缓存）：下一次请求自己再生成一份 */
  fs.unlinkSync(path.join(dataDir, "app-thumbs", APP_ID + "__" + OWNER + ".png"));
  const r3 = await fetch(url);
  const b3 = Buffer.from(await r3.arrayBuffer());
  ok(r3.status === 200 && b3.equals(b1), "⑥ 缓存删掉后自愈（重新生成同一张）");

  /* ⑦ 源图解不开（WebP / 坏字节）→ 接口回**原图**而不是 4xx/5xx */
  fs.writeFileSync(path.join(dataDir, "app-icons", APP_ID + "__" + OWNER + ".webp"), Buffer.from("RIFFxxxxWEBPVP8 "));
  fs.unlinkSync(path.join(dataDir, "app-icons", APP_ID + "__" + OWNER + ".jpg"));
  fs.rmSync(path.join(dataDir, "app-thumbs"), { recursive: true, force: true });
  const r4 = await fetch(url);
  ok(r4.status === 200, "⑦ 认不出的图仍回 200（回原图，不 5xx）：" + r4.status);

  /* ⑧ 不存在的应用 → 404（照旧口径） */
  const r5 = await fetch(base + "/api/apps/nosuch/thumb");
  ok(r5.status === 404, "⑧ 不存在的应用回 404：" + r5.status);
} catch (err) {
  fails++;
  console.log("  FAIL 冒烟异常：" + ((err && err.stack) || err));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
if (fails) {
  console.log("\n服务日志尾部：\n" + log.split("\n").slice(-25).join("\n"));
}
console.log(fails ? "\n[" + fails + " 项失败]" : "\n全部通过");
process.exit(fails ? 1 : 0);

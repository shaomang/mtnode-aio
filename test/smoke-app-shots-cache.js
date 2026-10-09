"use strict";
/* 上架截图**本机缓存**的冒烟（本轮需求：截图上传后本地保存，下次更新自动带上）
 *   node test/smoke-app-shots-cache.js
 *
 * 真跑根目录 shots-cache.js 的实例（临时目录），不起 Electron：
 *   [1] 存：压缩后的字节按内容寻址落盘（文件名 = sha256），索引记归属应用
 *   [2] 同图重复上传 / 跨应用复用：只存一份、不重写盘
 *   [3] 读回：list(withData) 给出 dataUrl 与真实字节（上架窗拿它当提交字节）
 *   [4] 回收：删一个应用只删「只属于它」的图，被别的应用共用的留着；清空 = 全删
 *   [5] 淘汰：超过条数 / 字节上限时按最久未用先丢
 *   [6] 健壮：索引里有条目但文件被外力删了 → 那一项视为不存在（不返回假路径）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const { createShotsCache, fileNameOf } = require(path.join(ROOT, "shots-cache.js"));

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
function section(t) {
  console.log("\n" + t);
}
/* 造一张「图」：内容确定的 PNG 头 + 随机尾巴，体积可控（只要字节稳定，sha 就稳定） */
function fakePng(seed, bytes) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const tail = Buffer.alloc(Math.max(0, bytes - head.length), seed);
  const buf = Buffer.concat([head, tail]);
  return { buf: buf, sha: crypto.createHash("sha256").update(buf).digest("hex") };
}
function dataUrlOf(buf, ext) {
  return "data:image/" + (ext || "png") + ";base64," + buf.toString("base64");
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-shots-cache-"));
const cache = createShotsCache({ dataDir: TMP });
const dir = cache.dir();

console.log("临时数据目录：" + TMP);

/* ───────── [1] 存 ───────── */
section("[1] 存：内容寻址落盘 + 索引记归属");
const imgA = fakePng(0x11, 4096);
const imgB = fakePng(0x22, 8192);
{
  const r = cache.put("app-one", [
    { sha: imgA.sha, dataUrl: dataUrlOf(imgA.buf), ext: "png", bytes: imgA.buf.length },
    { sha: imgB.sha, dataUrl: dataUrlOf(imgB.buf), ext: "png", bytes: imgB.buf.length },
  ]);
  ok(r.ok && r.saved === 2 && r.total === 2, "两张都存下（saved=2 / total=2）");
  ok(fs.existsSync(path.join(dir, imgA.sha + ".png")), "文件按 sha256 命名落盘（" + imgA.sha.slice(0, 12) + "….png）");
  ok(fs.existsSync(path.join(TMP, "store-shots.json")), "索引 store-shots.json 落在数据目录根");
  const idx = JSON.parse(fs.readFileSync(path.join(TMP, "store-shots.json"), "utf8"));
  ok(idx.items[imgA.sha] && idx.items[imgA.sha].apps.indexOf("app-one") >= 0, "索引记下归属应用 app-one");
  const bad = cache.put("app-one", [{ sha: "not-a-sha", dataUrl: dataUrlOf(imgA.buf) }]);
  ok(bad.skipped === 1 && bad.saved === 0, "sha 不合法的项被跳过（绝不拿坏 sha 拼文件名）");
  const noBytes = cache.put("app-one", [{ sha: fakePng(0x33, 512).sha }]);
  ok(noBytes.skipped === 1, "没有字节、本机也没有这一份 → 不写索引（不留指向不存在文件的条目）");
}

/* ───────── [2] 同图只存一份 ───────── */
section("[2] 同图重复上传 / 跨应用复用：只存一份、不重写盘");
{
  const before = fs.statSync(path.join(dir, imgA.sha + ".png"));
  const beforeIdx = JSON.parse(fs.readFileSync(path.join(TMP, "store-shots.json"), "utf8"));
  const r = cache.put("app-two", [
    { sha: imgA.sha, dataUrl: dataUrlOf(imgA.buf), ext: "png", bytes: imgA.buf.length },
  ]);
  const after = fs.statSync(path.join(dir, imgA.sha + ".png"));
  const afterIdx = JSON.parse(fs.readFileSync(path.join(TMP, "store-shots.json"), "utf8"));
  ok(after.mtimeMs === before.mtimeMs, "同一张图再次上传：文件一个字节都没重写（mtime 不变）");
  ok(r.total === 2, "总数仍是 2（同一张图没有变成两份）");
  ok(
    afterIdx.items[imgA.sha].apps.length === 2 &&
      afterIdx.items[imgA.sha].apps.indexOf("app-two") >= 0 &&
      beforeIdx.items[imgA.sha].apps.length === 1,
    "归属应用累加成 [app-one, app-two]（跨应用共用同一份字节）",
  );
  const files = fs.readdirSync(dir).filter((n) => /\.(png|jpg|jpeg|webp)$/i.test(n));
  ok(files.length === 2, "缓存目录里只有 2 个文件（同图真的只落一份）");
}

/* ───────── [3] 读回 ───────── */
section("[3] 读回：list(withData) 给出 dataUrl 与真实字节");
{
  const r = cache.list(true);
  ok(r.ok && r.total === 2, "list 回两条");
  ok(r.bytes === imgA.buf.length + imgB.buf.length, "总字节 = 两张之和（" + r.bytes + "）");
  const one = r.items.find((x) => x.sha === imgA.sha);
  ok(!!one && one.dataUrl.indexOf("data:image/png;base64,") === 0, "带 withData 时给出 dataUrl（上架窗拿它当提交字节）");
  const back = Buffer.from(String(one.dataUrl).split(",")[1], "base64");
  ok(back.length === imgA.buf.length && crypto.createHash("sha256").update(back).digest("hex") === imgA.sha,
    "读回的字节 sha 与落盘内容一致（重传时能命中云端对象库）");
  ok(!cache.list(false).items[0].dataUrl, "不带 withData 时不读盘（只做清单，省一次 IO）");
}

/* ───────── [4] 回收 ───────── */
section("[4] 回收：按应用引用回收，共用的留着");
{
  const r = cache.clear("app-one");
  ok(r.ok && r.removed === 1 && r.total === 1, "删 app-one：只回收「只属于它」的那张（imgB），共用的 imgA 留着");
  ok(fs.existsSync(path.join(dir, imgA.sha + ".png")) && !fs.existsSync(path.join(dir, imgB.sha + ".png")),
    "磁盘上也是这个结果：imgA 在、imgB 没了");
  const idx = JSON.parse(fs.readFileSync(path.join(TMP, "store-shots.json"), "utf8"));
  ok(!idx.items[imgB.sha] && idx.items[imgA.sha].apps.join(",") === "app-two", "索引里 imgB 条目已删、imgA 的归属收回成 app-two");
  const all = cache.clear("");
  ok(all.removed === 1 && all.total === 0, "清空：把剩下的也删干净");
  const left = fs.readdirSync(dir).filter((n) => /\.(png|jpg|jpeg|webp)$/i.test(n));
  ok(left.length === 0, "缓存目录里没有图片文件残留");
}

/* ───────── [5] 淘汰 ───────── */
section("[5] 淘汰：超限按最久未用先丢");
{
  const small = createShotsCache({ dataDir: path.join(TMP, "small"), maxItems: 2 });
  const imgs = [fakePng(0xa1, 256), fakePng(0xa2, 256), fakePng(0xa3, 256)];
  small.put("app-x", [{ sha: imgs[0].sha, dataUrl: dataUrlOf(imgs[0].buf) }]);
  small.put("app-x", [{ sha: imgs[1].sha, dataUrl: dataUrlOf(imgs[1].buf) }]);
  /* 让前两张的 lastUsedAt 明确更旧（同一毫秒内排序不稳），再存第三张 */
  const idxPath = path.join(TMP, "small", "store-shots.json");
  const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
  idx.items[imgs[0].sha].lastUsedAt = 1000;
  idx.items[imgs[1].sha].lastUsedAt = 2000;
  fs.writeFileSync(idxPath, JSON.stringify(idx));
  const fresh = createShotsCache({ dataDir: path.join(TMP, "small"), maxItems: 2 });
  fresh.put("app-x", [{ sha: imgs[2].sha, dataUrl: dataUrlOf(imgs[2].buf) }]);
  const now = fresh.list(false);
  ok(now.total === 2, "条数上限 2：存第三张后仍是 2 条（实得 " + now.total + "）");
  ok(!now.items.some((x) => x.sha === imgs[0].sha), "最久未用的那张被淘汰（lastUsedAt 最小）");
  ok(now.items.some((x) => x.sha === imgs[2].sha), "刚存的那张在（不会被误淘汰）");
  ok(!fs.existsSync(path.join(fresh.dir(), imgs[0].sha + ".png")), "被淘汰条目的文件也真删了（不留孤儿文件）");
}

/* ───────── [6] 健壮性 ───────── */
section("[6] 健壮：外部删文件 / 索引损坏都不炸");
{
  const t = createShotsCache({ dataDir: path.join(TMP, "robust") });
  const img = fakePng(0xb1, 512);
  t.put("app-r", [{ sha: img.sha, dataUrl: dataUrlOf(img.buf) }]);
  fs.unlinkSync(path.join(t.dir(), img.sha + ".png"));
  const r = t.list(true);
  ok(r.ok && r.total === 0, "索引里有条目、文件却被外力删了 → 那一项视为不存在（不回假路径 / 假 dataUrl）");
  fs.writeFileSync(path.join(TMP, "robust", "store-shots.json"), "{ 这不是 JSON");
  const t2 = createShotsCache({ dataDir: path.join(TMP, "robust") });
  ok(t2.list(false).total === 0, "索引损坏 → 当空处理，不抛（缓存只是便利，绝不挡住上架）");
  ok(fileNameOf("a".repeat(64), "PHP") === "a".repeat(64) + ".png", "认不出的扩展名一律回退 png（不拿用户给的字符串拼路径）");
}

console.log("\n" + (fails ? "FAIL " + fails + " / " + checks + " 项断言" : "✓ 全部通过（通过 " + checks + " / 失败 0）"));
process.exit(fails ? 1 : 0);

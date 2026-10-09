/* test/smoke-apps-sync-meta.js — 云端条目元数据 → 本机所有同 id 副本（apps:syncCloudMeta）
 *
 * 契约（与 apps:setMeta 是**两条独立通道**，语义不重叠）：
 *   · 可写白名单只有三个键：title（同一个值同时进 app.json 的 title 与 name）/ description / tags；
 *   · icon / dev / forkOf / capabilities / style / entry / version / createdAt / updatedAt 一律不写；
 *   · **两套根都扫**（同一个 id 可能在下载根与项目根各有一份），两套根配成同一个目录时只写一次；
 *   · 单条写不动不抛（记进该条 error 后继续写别的副本），全失败仍 ok:true；
 *   · 本机没有该 id 不是错误：{ ok:true, synced:0, missing:true, results:[] }。
 *
 * 本冒烟**不启动 electron**：把 require("electron") 打桩（ipcMain 顺手抓 handler，钉住通道名）后
 * 直接真跑 apps-store.js —— 元数据同步是真文件读写，所以现场用临时目录 + 真 app.json。
 *
 * 运行：node test/smoke-apps-sync-meta.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- electron 打桩（apps-store 只在调用期用它的少数 API） ---------- */
const handlers = new Map();
const electronStub = {
  app: {
    getAppPath: () => ROOT,
    getPath: () => "C:\\\\mtnode-fake-exe\\app.exe",
    isPackaged: false,
  },
  BrowserWindow: class {},
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  dialog: {},
  shell: {},
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  session: {},
  nativeImage: {},
};
const load = Module._load;
Module._load = function (req) {
  if (req === "electron") return electronStub;
  return load.apply(this, arguments);
};
const store = require(path.join(ROOT, "apps-store.js"));

/* ---------- 临时现场：数据目录 + 两套根，全部落在临时目录里 ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-sync-meta-"));
const DATA = path.join(TMP, "data");
const DL = path.join(TMP, "apps-download");
const DEV = path.join(TMP, "apps-project");
for (const d of [DATA, DL, DEV]) fs.mkdirSync(d, { recursive: true });
store.registerAppsIpc({ getDataDir: () => DATA, t: (s) => String(s == null ? "" : s) });

const cfgPath = path.join(DATA, "config.json");
const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2), "utf8");
writeCfg({ apps: { installDir: DL, projectDir: DEV } });

/* 与 syncCloudMetaToLocal 同口径：两套根都扫、同一目录只算一次（同 id 两边各一份时 dirs.length = 2） */
function localDirsOf(id) {
  const roots = store.rootsInfo();
  const out = [];
  const seen = new Set();
  for (const k of ["down", "dev"]) {
    const dir = store.appDirOf(String((roots[k] || {}).path || ""), id);
    if (!dir || seen.has(path.resolve(dir))) continue;
    seen.add(path.resolve(dir));
    if (fs.existsSync(dir)) out.push({ root: roots[k].path, dir: dir });
  }
  return out;
}
const sync = (arg) => store.syncCloudMetaToLocal(arg);
const manOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8"));
const writeApp = (root, id, manifest) => {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify(manifest), "utf8");
  return dir;
};

/* 一份「字段齐全」的清单：用来证明白名单**只**动那三个键（其余字段逐键比对） */
const RICH = (id, extra) =>
  Object.assign(
    {
      schema: 1,
      id: id,
      name: id,
      title: "老标题",
      version: "1.2.3",
      entry: "index.html",
      description: "老简介",
      icon: "icon.png",
      author: "老作者",
      dev: true,
      forkOf: { id: "srcapp", ownerId: "u9", owner: "老王" },
      style: "minimal",
      tags: ["旧标签"],
      capabilities: { textInput: true, imageGen: false },
      createdAt: 111111,
      updatedAt: 222222,
    },
    extra || {},
  );

/* ---------- [1] 契约：preload 白名单 + IPC 通道名 + 登记方式 ---------- */
console.log("\n[1] 桥与通道契约（preload.js 白名单 / apps:syncCloudMeta）");
{
  const PRE = read("preload.js");
  ok(PRE.indexOf("appsSyncCloudMeta:") > 0, "preload.js 白名单里有 appsSyncCloudMeta");
  ok(/appsSyncCloudMeta:\s*\(id,\s*meta\)\s*=>\s*ipcRenderer\.invoke\('apps:syncCloudMeta'/.test(PRE),
    "它转发到 IPC 通道 apps:syncCloudMeta（签名 (id, meta)）");
  ok(/Object\.assign\(\{\s*id\s*\},\s*meta\s*\|\|\s*\{\}\)/.test(PRE), "args = { id, ...meta }（缺省 meta = {}）");
  ok(PRE.indexOf("appsSetMeta:") > 0, "既有 appsSetMeta（apps:setMeta）语义没被改动，两条桥并存");
  ok(typeof store.syncCloudMetaToLocal === "function", "apps-store.js 导出 syncCloudMetaToLocal");
  ok(handlers.has("apps:syncCloudMeta"), "registerAppsIpc 注册了 apps:syncCloudMeta 通道");
  ok(handlers.has("apps:setMeta"), "apps:setMeta 通道照旧注册（既有语义不动）");
  const byIpc = handlers.get("apps:syncCloudMeta")({}, { id: "nosuchappzz", tags: ["x"] });
  ok(byIpc && byIpc.ok === true && byIpc.missing === true && byIpc.synced === 0,
    "guard 包装的 handler 真能跑（本机无此 id：ok:true + missing:true）");
  ok(byIpc === undefined || !("error" in byIpc), "missing 不是错误（回执里没有 error 字段）");
}

/* ---------- [2] 字段白名单：title → name + title、description、tags；其余一个都不动 ---------- */
console.log("\n[2] 字段白名单（该写谁、绝不写谁）");
{
  const ID = "syncapp";
  /* 现场（关键）：同一个 id 在**下载根与项目根各一份** —— 这正是本能力要覆盖的形态 */
  const dir = writeApp(DL, ID, RICH(ID, { dev: false }));
  writeApp(DEV, ID, RICH(ID, { dev: true, title: "项目根老标题" }));
  const before = manOf(dir);
  const keys = Object.keys(before).sort();
  ok(keys.length >= 16, "现场清单字段齐全（" + keys.length + " 个键）");

  /* 2.1 全量推送：title / description / tags 三键都写 */
  const p1 = { title: "  新标题  ", description: "云端简介\n第二行", tags: [" 甲 ", "乙", "甲", "", "  ", null] };
  const r1 = sync(Object.assign({ id: ID }, p1));
  ok(r1.ok === true && r1.synced === 2 && r1.missing === false,
    "两套根各一份同 id → synced=2（实得 " + r1.synced + "）");
  ok(r1.results.length === 2 && r1.results.every((x) => x.ok === true), "results 两条都 ok");
  ok(r1.results.every((x) => x.dir && (x.kind === "down" || x.kind === "dev")),
    "results 每条带 dir + kind（kind = app.json 的 dev 标记，实得 " + r1.results.map((x) => x.kind).join("/") + "）");
  ok(r1.results.some((x) => path.resolve(x.dir) === path.resolve(path.join(DL, ID))) &&
    r1.results.some((x) => path.resolve(x.dir) === path.resolve(path.join(DEV, ID))),
    "两套根都写到了（下载根 + 项目根）");

  const m1 = manOf(path.join(DL, ID));
  ok(m1.title === "新标题" && m1.name === "新标题", "title 同一个值同时进 app.json 的 title 与 name");
  ok(m1.description === "云端简介\n第二行", "description 原样写（含换行，不被 trim 吃掉）");
  ok(same(m1.tags, ["甲", "乙"]), "tags 去空白 / 丢空项 / 去重且保持顺序（实得 " + JSON.stringify(m1.tags) + "）");
  ok(same(manOf(path.join(DEV, ID)).tags, ["甲", "乙"]), "项目根那份的 tags 也写了");

  const after = manOf(path.join(DL, ID));
  const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])).sort();
  ok(same(changed, ["description", "name", "tags", "title"]),
    "只有这 4 个键变了（实得 " + JSON.stringify(changed) + "）");
  const NOT_WRITTEN = ["icon", "dev", "forkOf", "capabilities", "style", "entry", "version", "createdAt", "updatedAt"];
  const kept = NOT_WRITTEN.filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  ok(kept.length === 0, "icon/dev/forkOf/capabilities/style/entry/version/createdAt/updatedAt 一个都没动" +
    (kept.length ? "（被动的：" + kept.join(",") + "）" : ""));
  ok(same(Object.keys(after).sort(), keys), "没有凭空多出键（键集与推送前一致）");
  ok(fs.readdirSync(dir).filter((f) => f.indexOf(".tmp") >= 0).length === 0, "没有留下 .tmp 临时文件");

  /* 2.2 只传哪几个键就写哪几个键：缺省的键一律不动 */
  const r2 = sync({ id: ID, description: "只改简介" });
  const m2 = manOf(path.join(DL, ID));
  ok(r2.ok === true && r2.synced === 2, "只传 description 也同步两份");
  ok(m2.description === "只改简介", "description 写进去了");
  ok(m2.title === "新标题" && m2.name === "新标题", "没传的 title / name 原样（不被清空 / 不被改写）");
  ok(same(m2.tags, ["甲", "乙"]), "没传的 tags 原样");
  ok(same(r2.patched, ["description"]), "回执 patched 只列真正写的键（实得 " + JSON.stringify(r2.patched) + "）");

  /* 2.3 传空数组 = 显式清空 tags（数组语义与「没传」必须区分开） */
  sync({ id: ID, tags: [] });
  ok(same(manOf(path.join(DL, ID)).tags, []), "tags:[] = 显式清空（与「没传」区分）");

  /* 2.4 白名单外的字段交上来也不写（桥只传白名单，主进程同样不认别的键） */
  const before3 = manOf(path.join(DL, ID));
  const r3 = sync({ id: ID, icon: "evil.png", dev: false, version: "9.9.9", capabilities: { imageGen: true }, dir: "D:/etc" });
  ok(r3.ok === false && r3.reason === "no_fields",
    "只给白名单外的字段 → no_fields（实得 " + r3.reason + "）");
  ok(same(manOf(path.join(DL, ID)), before3), "no_fields 时一个字节都没写");
}

/* ---------- [3] 校验：没有要写的字段 / 空标题 / 非法 id ---------- */
console.log("\n[3] 校验（no_fields / empty_title / bad_id）");
{
  const ID = "syncapp";
  const before = JSON.stringify(manOf(path.join(DL, ID)));
  const r0 = sync({ id: ID });
  ok(r0.ok === false && r0.reason === "no_fields" && r0.code === "no_fields",
    "三个字段都缺 → bad(no_fields)");
  ok(String(r0.error || "").length > 0, "no_fields 带给人看的一句话（error）");
  const rE = sync({ id: ID, title: "   " });
  ok(rE.ok === false && rE.reason === "empty_title", "title 传了但为空 → bad（实得 " + rE.reason + "）");
  const rBad = sync({ id: "../etc", title: "x" });
  ok(rBad.ok === false && rBad.reason === "bad_id", "id 走 safeAppId：非法 id → bad_id");
  ok(JSON.stringify(manOf(path.join(DL, ID))) === before, "三次被拒都没落盘");
}

/* ---------- [4] 本机没有该 id：missing:true 且不报错 ---------- */
console.log("\n[4] 本机没有该应用（不是错误）");
{
  const r = sync({ id: "ghostapp", title: "鬼应用" });
  ok(r.ok === true, "ok:true（本机没有 ≠ 失败）");
  ok(r.synced === 0, "synced = 0");
  ok(r.missing === true, "missing = true");
  ok(Array.isArray(r.results) && r.results.length === 0, "results = []");
  ok(!("error" in r), "回执里没有 error（渲染层据此与真失败区分）");
}

/* ---------- [5] 只在项目根有一份：也扫得到、写得进（别只写 dirOfApp 那一处） ---------- */
console.log("\n[5] 同 id 只在项目根一份");
{
  const ID = "devonlyapp";
  writeApp(DEV, ID, RICH(ID, { dev: true, title: "项目根老标题" }));
  const r = sync({ id: ID, title: "项目根新标题" });
  const dirs = localDirsOf(ID);
  ok(dirs.length === 1 && dirs[0].root === DEV, "现场只有项目根那一份（dirs=" + dirs.length + "）");
  ok(r.ok === true && r.synced === 1 && r.results.length === 1 && r.results[0].kind === "dev",
    "写到项目根那份，kind=dev（实得 " + JSON.stringify(r.results.map((x) => x.kind)) + "）");
  ok(r.kind === "dev", "顶层 kind 按本机实际所在那一边（diskKindOf = dev，实得 " + r.kind + "）");
  ok(manOf(path.join(DEV, ID)).name === "项目根新标题" && manOf(path.join(DEV, ID)).title === "项目根新标题",
    "项目根那份的 name + title 都换了");
}

/* ---------- [6] 两套根配成同一个目录：只扫一次，绝不重复写 ---------- */
console.log("\n[6] 两套根同一个目录（只扫一次）");
{
  writeCfg({ apps: { installDir: DL, projectDir: DL } });
  const ID = "syncapp"; /* 两份（DL + DEV）已在上面的用例里同步过 */
  const beforeDl = manOf(path.join(DL, ID));
  ok(localDirsOf(ID).length === 1, "两套根同目录时本机只算一份（去重生效）");
  const r = sync({ id: ID, description: "同根只写一次" });
  ok(r.ok === true && r.synced === 1 && r.results.length === 1,
    "synced=1（不是 2，实得 " + r.synced + "）");
  ok(manOf(path.join(DL, ID)).description === "同根只写一次", "同一个 app.json 写成功");
  ok(manOf(path.join(DL, ID)).title === beforeDl.title, "这一轮没碰 title");
  const r2 = sync({ id: ID, title: "同根二次写" });
  ok(r2.synced === 1 && manOf(path.join(DL, ID)).name === "同根二次写", "再写一次仍是 1 条（幂等，不重复计）");
  writeCfg({ apps: { installDir: DL, projectDir: DEV } });
}

/* ---------- [7] 清单损坏：该条记 error 并继续写其余副本（全失败仍 ok:true） ---------- */
console.log("\n[7] 清单损坏的一条不拖累另一条");
{
  const ID = "brokensyncapp";
  const dlDir = writeApp(DL, ID, RICH(ID));
  const devDir = writeApp(DEV, ID, RICH(ID, { dev: true }));
  fs.writeFileSync(path.join(devDir, "app.json"), "{ 这不是 JSON", "utf8");
  const r = sync({ id: ID, title: "云端新标题" });
  ok(r.ok === true, "有坏档时仍 ok:true（不抛）");
  ok(r.synced === 1, "好的那份照写（synced=1，实得 " + r.synced + "）");
  const bad = r.results.find((x) => x.ok === false);
  const good = r.results.find((x) => x.ok === true);
  ok(!!bad && String(bad.error || "").length > 0, "坏的那条如实带 error（" + (bad ? bad.error : "缺") + "）");
  ok(!!bad && path.resolve(bad.dir) === path.resolve(devDir), "error 挂在坏档那一条（dir 指得到）");
  ok(!!good && path.resolve(good.dir) === path.resolve(dlDir), "ok 那一条是好的那份");
  ok(manOf(dlDir).name === "云端新标题", "好档真写进去了");
  ok(fs.readFileSync(path.join(devDir, "app.json"), "utf8") === "{ 这不是 JSON", "坏档一个字节没改（不覆盖坏文件）");

  /* 全失败：仍然 ok:true，但如实带 error（由渲染层单独提示）。
     现场：两套根下都**存在**这个 id 的目录，但两份 app.json 都读不出。 */
  writeApp(DL, "allbrokenapp", {});
  fs.writeFileSync(path.join(DL, "allbrokenapp", "app.json"), "[[[", "utf8");
  writeApp(DEV, "allbrokenapp", {});
  fs.writeFileSync(path.join(DEV, "allbrokenapp", "app.json"), "]]]", "utf8");
  const r3 = sync({ id: "allbrokenapp", title: "全坏" });
  ok(r3.ok === true, "全都写不动时 ok **仍然**是 true（不抛错）");
  ok(r3.synced === 0 && r3.missing === false, "synced=0 但 missing=false（副本在，只是都坏了）");
  ok(r3.results.length === 2 && r3.results.every((x) => x.ok === false && x.error),
    "两条都如实带 error（渲染层据此提示）");
}

/* ---------- [8] 坏档 vs 目录根本不存在：两种情形不许混 ---------- */
console.log("\n[8] 「有目录但读不出」与「这一边没有」是两回事");
{
  const ID = "halfcopyapp";
  writeApp(DL, ID, RICH(ID)); /* 下载根有；项目根连目录都没有 */
  const r = sync({ id: ID, tags: ["只有一个副本"] });
  ok(r.ok === true && r.synced === 1 && r.missing === false,
    "只在一边有 → synced=1 / missing=false（不是错误）");
  ok(r.results.length === 1, "没有副本的那一边不进 results（不编造 dir）");
  ok(same(manOf(path.join(DL, ID)).tags, ["只有一个副本"]), "有副本那份写进去了");
}

/* ---------- [9] 单条**写**失败：记进该条 error、其余副本照写、不抛 ---------- */
console.log("\n[9] 单条写入失败不拖累其余副本（writeJson 真抛错的那一路）");
{
  const ID = "writefailapp";
  const dlDir = writeApp(DL, ID, RICH(ID));
  /* 项目根那份把 app.json 换成一个**同名目录**：readManifest 读不出（→ 走 error 那条路，
     且 writeJson 也必然写不动）——不依赖平台权限，结果确定 */
  const devDir = path.join(DEV, ID);
  fs.mkdirSync(path.join(devDir, "app.json"), { recursive: true });
  const r = sync({ id: ID, title: "写失败用例" });
  ok(r.ok === true && r.synced === 1, "好的那份照写（synced=1，实得 " + r.synced + "）");
  const bad = r.results.find((x) => x.ok === false);
  ok(!!bad && String(bad.error || "").length > 0, "写不动/读不出的那条带 error（" + (bad ? bad.error : "缺") + "）");
  ok(manOf(dlDir).name === "写失败用例", "坏档之外的副本真写进去了");
  ok(fs.statSync(path.join(devDir, "app.json")).isDirectory(), "被占的那个路径没被动过");
}

/* ---------- [10] 收尾 ---------- */
console.log("\n[10] 收尾");

console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " 项"));
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}
process.exit(fails ? 1 : 0);

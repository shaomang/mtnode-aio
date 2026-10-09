/* test/smoke-apps-roots.js — 「下载的应用 / 开发的应用」严格分开（两套根 · 两棵数据 · 删除范围）
 *
 * 背景（用户口径）：下载的与开发的要严格分开，包括数据，避免删一个导致另一个误删。
 * 本冒烟**不启动 electron**：把 require("electron") 打桩后直接真跑 apps-store.js 的纯逻辑
 * （根解析 / 分类 / 数据目录 / 删除范围 / 显式迁移），全部落在临时目录里，不碰本机数据。
 *
 * 运行：node test/smoke-apps-roots.js
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

/* ---------- electron 打桩（apps-store 只在调用期用它的少数 API） ---------- */
const electronStub = {
  app: {
    getAppPath: () => ROOT,
    getPath: () => "C:\\\\mtnode-fake-exe\\app.exe",
    isPackaged: false,
  },
  BrowserWindow: class {},
  ipcMain: { handle() {} },
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

/* ---------- 临时现场 ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-roots-"));
const DATA = path.join(TMP, "data");
const DL = path.join(TMP, "apps-download");
const DEV = path.join(TMP, "apps-project");
for (const d of [DATA, DL, DEV]) fs.mkdirSync(d, { recursive: true });
store.registerAppsIpc({ getDataDir: () => DATA, t: (s) => String(s == null ? "" : s) });

const cfgPath = path.join(DATA, "config.json");
const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2), "utf8");
const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"));
writeCfg({ apps: { installDir: DL, projectDir: DEV } });

/* ---------- 造两个应用：一个下载的（dev:false + 安装账本），一个开发的（dev:true） ---------- */
function makeApp(root, id, manifest, withLedger) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<html><body>" + id + "</body></html>",
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify(manifest), "utf8");
  if (withLedger) {
    fs.writeFileSync(
      path.join(dir, "installed.json"),
      JSON.stringify({ schema: 1, id, version: manifest.version, source: "https://x/y.zip", files: ["index.html", "app.json"] }),
      "utf8",
    );
  }
  return dir;
}
const DL_ID = "downloadedapp";
const DEV_ID = "devapp";
const dlDir = makeApp(DL, DL_ID, { id: DL_ID, name: "下载的应用", version: "1.0.0", entry: "index.html", dev: false }, true);
const devDir = makeApp(DEV, DEV_ID, { id: DEV_ID, name: "开发的应用", version: "0.1.0", entry: "index.html", dev: true }, false);

/* ---------- [1] 根解析：两套根各就各位 ---------- */
console.log("\n[1] 两套根（rootsInfo / listApps 的 root）");
{
  const roots = store.rootsInfo();
  ok(roots.down.path === DL && roots.down.configured === true, "下载根 = 配置里的 apps.installDir（老键名沿用）");
  ok(roots.dev.path === DEV && roots.dev.configured === true, "项目根 = 配置里的 apps.projectDir");
  const list = store.listApps();
  ok(list.root === DL, "老字段 root 仍 = 下载根（老调用点不回归）");
  ok(list.roots && list.roots.dev && list.roots.dev.path === DEV, "新字段 roots 带两套根");
  const a = list.apps.find((x) => x.id === DL_ID);
  const b = list.apps.find((x) => x.id === DEV_ID);
  ok(!!a && a.kind === "down" && a.dev === false && a.listKind === "down", "下载的应用 kind=down / dev=false");
  ok(!!b && b.kind === "dev" && b.dev === true && b.listKind === "dev", "开发的应用 kind=dev / dev=true");
  ok(!!b && b.kindMismatch === false, "分类与所在根一致：kindMismatch=false");
}

/* ---------- [2] 两棵数据根：不再共用一个目录 ---------- */
console.log("\n[2] 数据目录按类型分两棵（appDataRootPath）");
{
  const d1 = store.appDataRootPath(DL_ID, "down");
  const d2 = store.appDataRootPath(DEV_ID, "dev");
  ok(d1 === path.join(DATA, "apps-data", "downloaded", DL_ID), "下载应用数据 = apps-data/downloaded/<id>");
  ok(d2 === path.join(DATA, "apps-data", "dev", DEV_ID), "开发应用数据 = apps-data/dev/<id>");
  ok(store.appDataRootPath(DL_ID) === d1 && store.appDataRootPath(DEV_ID) === d2, "不给类型时按本机实际所在的那一边取");
  ok(!d1.startsWith(path.join(DATA, "apps-data", "dev")), "两棵互不重叠（下载那棵不在 dev 下）");
}

/* ---------- [3] 删除范围：下载的真删、开发的只移除登记 ---------- */
async function section3() {
console.log("\n[3] 删除范围（uninstallApp / unregisterApp）");
{
  /* 3.1 开发的应用：不给标记一律拒绝，绝不删目录 */
  const r0 = await store.uninstallApp(DEV_ID, {});
  ok(r0.ok === false && r0.reason === "dev_keep_files", "开发的应用直接卸载被拒（dev_keep_files）");
  ok(fs.existsSync(devDir), "被拒后项目文件夹原样在");
  /* 3.2 开发的应用：移除登记 = 只改 app.json，文件全留 */
  const r1 = await store.uninstallApp(DEV_ID, { force: "dev_remove" });
  ok(r1.ok === true && r1.mode === "unregister" && r1.filesKept === true, "带 force 走「移除登记」");
  ok(fs.existsSync(path.join(devDir, "index.html")) && fs.existsSync(devDir), "源码目录一个文件都没删");
  const man = JSON.parse(fs.readFileSync(path.join(devDir, "app.json"), "utf8"));
  ok(man.dev === false && man.removed === true, "app.json 记 dev:false + removed:true（登记已摘）");
  ok(store.listApps().apps.every((x) => x.id !== DEV_ID), "移除登记后不再列进本机应用列表");
  /* 3.3 下载的应用：真删自己那一棵 */
  const dlData = store.appDataRootPath(DL_ID, "down");
  fs.mkdirSync(dlData, { recursive: true });
  fs.writeFileSync(path.join(dlData, "data.json"), '{"n":1}', "utf8");
  const devDataKeep = path.join(DATA, "apps-data", "dev", "another-dev");
  fs.mkdirSync(devDataKeep, { recursive: true });
  fs.writeFileSync(path.join(devDataKeep, "data.json"), '{"keep":1}', "utf8");
  const r2 = await store.uninstallApp(DL_ID, {});
  ok(r2.ok === true && r2.mode === "uninstall", "下载的应用走真删（mode=uninstall）");
  ok(!fs.existsSync(dlDir), "下载的应用目录已被删除");
  ok(!fs.existsSync(dlData), "它自己那一棵数据（downloaded）跟着删掉");
  ok(fs.existsSync(devDataKeep), "开发那一棵（apps-data/dev/**）一根毛都没动");
  ok(store.listApps().roots.dev.path === DEV, "删完之后项目根配置原样");
}

/* ---------- [4] 分配：新建落项目根、安装落下载根 ---------- */
console.log("\n[4] 写入范围（新建 → 项目根 / 安装 → 下载根）");
{
  const made = store.createApp({ name: "冒烟新应用", id: "madenewapp" });
  ok(made.ok === true, "createApp 成功");
  ok(
    fs.existsSync(path.join(DEV, "madenewapp", "app.json")),
    "新建的应用落在**项目根**（dev）",
  );
  ok(!fs.existsSync(path.join(DL, "madenewapp")), "新建的应用没有落进下载根");
  const list = store.listApps();
  const one = list.apps.find((x) => x.id === "madenewapp");
  ok(!!one && one.kind === "dev", "新建的应用 kind=dev");
}

/* ---------- [5] 显式迁移入口（dry-run 不落盘 / 真搬按类型归位） ---------- */
console.log("\n[5] 旧布局显式迁移（migrateAppsLayout）");
{
  /* 现场：两套根暂时都指向下载根（= 还没分开的老布局），里面躺着一个开发的应用 */
  writeCfg({ apps: { installDir: DL, projectDir: DL } });
  const legacyDev = makeApp(DL, "legacydevapp", { id: "legacydevapp", name: "老布局里的开发应用", version: "0.0.1", entry: "index.html", dev: true }, false);
  /* 老数据目录：apps-data/<id>/（升级前的样子） */
  const legacyData = path.join(DATA, "apps-data", "legacydevapp");
  fs.mkdirSync(legacyData, { recursive: true });
  fs.writeFileSync(path.join(legacyData, "data.json"), '{"old":1}', "utf8");

  const dry = store.migrateAppsLayout({ dryRun: true });
  ok(dry.ok === true && dry.dryRun === true, "dry-run 回执ok");
  ok(dry.sameRoot === true && dry.moves.filter((m) => m.kind === "app").length === 0, "两套根同一个目录：应用目录无需搬（只提示）");
  ok(fs.existsSync(legacyDev), "dry-run 之后一个文件都没动");

  /* 把两套根真正分开，再迁移：apps/legacydevapp → 项目根；数据 → apps-data/dev/<id> */
  writeCfg({ apps: { installDir: DL, projectDir: DEV } });
  const dry2 = store.migrateAppsLayout({ dryRun: true });
  const appMove = dry2.moves.find((m) => m.kind === "app" && m.id === "legacydevapp");
  const dataMove = dry2.moves.find((m) => m.kind === "data" && m.id === "legacydevapp");
  ok(!!appMove && path.resolve(appMove.to) === path.resolve(path.join(DEV, "legacydevapp")), "dry-run 列出：开发应用 → 项目根");
  ok(!!dataMove && path.resolve(dataMove.to) === path.resolve(path.join(DATA, "apps-data", "dev", "legacydevapp")), "dry-run 列出：数据 → apps-data/dev/<id>");
  ok(fs.existsSync(legacyDev), "dry-run 仍未动文件");

  const run = store.migrateAppsLayout({ dryRun: false });
  ok(run.ok === true && run.moved >= 2, "真搬完成（moved=" + run.moved + "）");
  ok(fs.existsSync(path.join(DEV, "legacydevapp", "app.json")), "开发应用已搬进项目根");
  ok(!fs.existsSync(legacyDev), "下载根里那份已搬走");
  ok(fs.existsSync(path.join(DATA, "apps-data", "dev", "legacydevapp", "data.json")), "数据已搬进 apps-data/dev/<id>");
  ok(!fs.existsSync(legacyData), "老数据目录已搬走");
}

/* ---------- [6] 冲突不覆盖（目标已存在 → 跳过并如实报出） ---------- */
console.log("\n[6] 迁移冲突不覆盖");
{
  makeApp(DL, "clashapp", { id: "clashapp", name: "老布局里的开发应用", version: "0.0.1", entry: "index.html", dev: true }, false);
  makeApp(DEV, "clashapp", { id: "clashapp", name: "项目根里已有一份", version: "9.9.9", entry: "index.html", dev: true }, false);
  const dry = store.migrateAppsLayout({ dryRun: true });
  const c = dry.conflicts.find((x) => x.id === "clashapp");
  ok(!!c && c.kind === "app", "目标已存在 → 记进 conflicts（不覆盖）");
  const run = store.migrateAppsLayout({ dryRun: false });
  const kept = JSON.parse(fs.readFileSync(path.join(DEV, "clashapp", "app.json"), "utf8"));
  ok(kept.version === "9.9.9", "项目根里那份 9.9.9 没被覆盖");
  ok(fs.existsSync(path.join(DL, "clashapp")), "源目录原样留着（不静默删）");
  ok(run.skipped.length === 0 && run.conflicts.length >= 1, "回执如实带 conflicts");
}

/* ---------- [7] 默认根固化：不再要求手选（本轮需求） ---------- */
console.log("\n[7] 默认根固化（不要求手选 / 不覆盖已选 / 列应用即固化）");
{
  /* 现场：只配了下载根，项目根一个字都没有 —— 旧实现会拦人「先选一个文件夹」（下载 / 新建前
     弹系统选目录框）并给开发页打「未设置」红字。本轮口径：直接用默认根（**画布所在的数据目录**
     下的 apps-dev），由主进程在「列应用 / 下载 / 新建」时把默认路径固化进 config.json。 */
  writeCfg({ apps: { installDir: DL } });
  const roots = store.rootsInfo();
  ok(roots.dev.configured === false, "固化之前：项目根 configured=false（只读快照不改配置）");
  ok(
    path.resolve(roots.dev.path) === path.resolve(path.join(DATA, "apps-dev")),
    "未配置 = 默认 apps-dev（数据目录下，不再回退下载根）",
  );
  ok(path.resolve(roots.dev.path) !== path.resolve(DL), "解析结果不等于下载根（静默回退已删）");
  ok(roots.dev.fallback !== true, "回执里不再有 fallback 这一说");

  /* 「首次真正要用到它时」才写盘 —— ensureRootPersisted 就是那一刻 */
  const ready = store.ensureRootPersisted("dev");
  ok(
    path.resolve(ready.root) === path.resolve(path.join(DATA, "apps-dev")) &&
      ready.persisted === true &&
      ready.configured === true,
    "ensureRootPersisted：没配过就用默认根并真写进 config.json",
  );
  ok(
    path.resolve(readCfg().apps.projectDir) === path.resolve(path.join(DATA, "apps-dev")),
    "config.json 里落成 apps.projectDir = 默认根",
  );
  ok(fs.existsSync(path.join(DATA, "apps-dev")), "默认根目录被自动建出来（需要时创建）");
  ok(store.ensureRootPersisted("dev").persisted === false, "固化过之后第二次不再写盘（幂等）");

  /* 已手选过的根一律保留（老机器行为一个字都不变） */
  store.setRoot(DEV, "dev");
  ok(
    path.resolve(store.ensureRootPersisted("dev").root) === path.resolve(DEV) &&
      path.resolve(readCfg().apps.projectDir) === path.resolve(DEV),
    "已手选过的项目根不被默认值覆盖",
  );

  /* 列应用 = 「真正要用到根」的第一处：一次把两套根都固化下来（库页 / 开发页一打开就有明确路径） */
  writeCfg({ apps: {} });
  const list7 = store.listApps();
  const cfg7 = readCfg().apps || {};
  ok(
    path.resolve(cfg7.installDir) === path.resolve(path.join(DATA, "apps")) &&
      path.resolve(cfg7.projectDir) === path.resolve(path.join(DATA, "apps-dev")),
    "listApps 把两套根都固化到数据目录下的 apps / apps-dev",
  );
  ok(
    path.resolve(list7.roots.down.path) === path.resolve(path.join(DATA, "apps")) &&
      path.resolve(list7.roots.dev.path) === path.resolve(path.join(DATA, "apps-dev")),
    "列表回执里的两套根 = 刚固化的默认根",
  );
  ok(
    !list7.apps.some((x) => x.id === "clashapp"),
    "原来配在别处的应用不会被错认到默认根里（文件仍在原处）",
  );

  /* 下载根的老键名仍认：那是**同一个根的旧键名**，不是跨目录回落（删了才会让老配置丢下载根） */
  writeCfg({ appsInstallDir: DL });
  ok(
    path.resolve(store.rootsInfo().down.path) === path.resolve(DL),
    "下载根老键名 appsInstallDir 仍然认",
  );
  ok(store.ensureRootPersisted("down").persisted === false, "老键名也算「已配过」：不覆盖");
  writeCfg({ apps: { installDir: DL } });

  /* 已选的根所在盘 / 目录不存在了（换盘、手动删了目录）：**继续用它并自动重建**，
     绝不静默回落到默认根（换根会让原来那个盘上的应用整列消失，比报错更难解释）。 */
  const GONE_ROOT = path.join(TMP, "盘上还没有的应用根");
  store.setRoot(GONE_ROOT, "dev");
  fs.rmSync(GONE_ROOT, { recursive: true, force: true }); /* 盘上那份没了（换盘 / 用户手动删） */
  ok(!fs.existsSync(GONE_ROOT), "现场：手选的项目根目录当前不在盘上");
  const recreated = store.createApp({ name: "重建验证", id: "recreateapp" });
  ok(
    recreated.ok === true && fs.existsSync(path.join(GONE_ROOT, "recreateapp", "app.json")),
    "根目录不在盘上也自动重建，新建照样成功",
  );
  ok(
    path.resolve(readCfg().apps.projectDir) === path.resolve(GONE_ROOT),
    "没有静默换根：config.json 里还是用户选的那个路径",
  );

  /* 真建不出来（父级是个文件）：如实报错，同样不换根 */
  const BLOCKER = path.join(TMP, "not-a-folder");
  fs.writeFileSync(BLOCKER, "x", "utf8");
  const BROKEN_ROOT = path.join(BLOCKER, "sub");
  writeCfg({ apps: { installDir: DL, projectDir: BROKEN_ROOT } });
  const broken = store.createApp({ name: "建不出来的根", id: "brokenrootapp" });
  ok(broken.ok === false && !!String(broken.error || ""), "根目录建不出来时如实报错（不假装成功）");
  ok(
    path.resolve(readCfg().apps.projectDir) === path.resolve(BROKEN_ROOT),
    "报错之后也没有偷偷换根（用户选的路径原样留着）",
  );
  writeCfg({ apps: { installDir: DL, projectDir: DEV } });
}
}

section3()
  .catch((err) => {
    fails++;
    console.log("FAIL  用例抛错：" + ((err && err.stack) || err));
  })
  .then(() => {
    console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " 项"));
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
    process.exit(fails ? 1 : 0);
  });

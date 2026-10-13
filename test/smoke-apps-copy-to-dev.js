/* test/smoke-apps-copy-to-dev.js — 「二次开发 = 复制到开发目录」（apps:copyToDev / copyAppToDev）
 *
 * 契约（routes：renderer/app-apps.js 的 appsSecondaryDevRun → renderer/app-app-flow.js 的
 * appsCopyToDevRun → preload 的 appsCopyToDev → 主进程 apps:copyToDev = apps-store.js 的 copyAppToDev）：
 *   · 源 = 下载根 <apps.installDir>/<id>（不在 → code:"not_in_library"）；
 *     目标 = 项目根 <apps.projectDir>/<id>；两套根是同一个目录 → code:"same_root"。
 *   · 目标已存在且没传 mode:"overwrite" → { ok:false, code:"exists", exists:true, dir }，
 *     **一个字节都不改**（由界面问「覆盖 / 交给 AI 合并」）。
 *   · 只复制应用本体：storage/ · node_modules · .git · app.json · installed.json · *.mtnodes ·
 *     merge.json · .merge-done.json · <清单 name>.zip · .mtnode-merge-backup* 一律跳过（copySkipOf）。
 *   · 副本 app.json：dev:true、**保留源那份的 author / version**、写 forkOf:{id,ownerId,owner}
 *     （来源取源那份 installed.json 的 ownerId/owner，退回清单 author；都没有 = null）、
 *     删掉 cloud 与 removed/removedAt。
 *   · mode:"overwrite" 且目标存在：先把旧那份整目录备份到 <数据目录>/merge-backups/<id>-<时间戳>/app
 *     （备份失败 → code:"backup_failed" 且不动任何东西），再整份接替；源目录**不动**（库里那份还在）。
 *
 * 口径：零依赖、不启动 electron（require("electron") 打桩，与 smoke-apps-sync-meta.js /
 * smoke-apps-host-kind.js 同一套注入方式：registerAppsIpc({ getDataDir })），
 * 所有真跑都落在临时目录里，不碰真实 %APPDATA%。
 *
 * 运行：node test/smoke-apps-copy-to-dev.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};

/* ---------- electron 打桩（apps-store.js 只在调用期用它的少数 API） ---------- */
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

/* ---------- 临时现场：数据目录 + 两套根（下载根 / 项目根是两个不同的目录） ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-copy-to-dev-"));
const DATA = path.join(TMP, "data");
const DL = path.join(TMP, "apps-download");
const DEV = path.join(TMP, "apps-project");
for (const d of [DATA, DL, DEV]) fs.mkdirSync(d, { recursive: true });
store.registerAppsIpc({ getDataDir: () => DATA, t: (s) => String(s == null ? "" : s) });
const cfgPath = path.join(DATA, "config.json");
const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2), "utf8");
writeCfg({ apps: { installDir: DL, projectDir: DEV } });

const write = (abs, text) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
};
const manOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8"));
const ex = (p) => fs.existsSync(p);

/* 目录的字节级快照（相对路径 → 内容；目录记 "<dir>"）——「一个字节都没变」用它证明 */
function snapDir(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const r = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) {
        out[r + "/"] = "<dir>";
        walk(abs, r);
      } else out[r] = fs.readFileSync(abs).toString("base64");
    }
  };
  if (ex(dir)) walk(dir, "");
  return out;
}
const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- [1] 契约：preload 桥 + IPC 通道名 + 导出 + 文档口径 ---------- */
console.log("[1] 桥与通道契约（preload.js / apps:copyToDev / 导出 / 在册）");
{
  const PRE = read("preload.js");
  ok(PRE.indexOf("appsCopyToDev:") >= 0, "preload.js 白名单里有 appsCopyToDev");
  ok(
    /appsCopyToDev:\s*\(id,\s*opts\)\s*=>\s*\n?\s*ipcRenderer\.invoke\('apps:copyToDev',\s*Object\.assign\(\{ id \},\s*opts \|\| \{\}\)\)/.test(PRE),
    "它转发到 IPC 通道 apps:copyToDev，签名 (id, opts)：正文 = Object.assign({ id }, opts)（mode:\"overwrite\" 就这样传下去）",
  );
  const STORE = read("apps-store.js");
  ok(
    /ipcMain\.handle\("apps:copyToDev",\s*guard\(\(e,\s*arg\)\s*=>\s*copyAppToDev\(arg\)\)\)/.test(STORE),
    "主进程注册了 apps:copyToDev（handler 就是 copyAppToDev，中间只过一层 guard）",
  );
  ok(
    typeof store.copyAppToDev === "function" && typeof store.copySkipOf === "function",
    "apps-store.js 导出 copyAppToDev / copySkipOf（本冒烟直接真跑它们，不抄一份逻辑）",
  );
  const BUILD = read("build.json");
  ok(BUILD.indexOf('"apps-store.js"') >= 0, "apps-store.js 仍在打包白名单里（这条链打包后不会 Cannot find module）");
  const FLOW = read("renderer/app-app-flow.js");
  ok(
    FLOW.indexOf('await api.appsCopyToDev(id, o.mode === "overwrite" ? { mode: "overwrite" } : {})') >= 0,
    "渲染层执行体 appsCopyToDevRun 走的就是这个桥（不是 appsMigrateLayout）",
  );
}

/* ---------- [2] copySkipOf：哪些文件不许跟着复制（纯函数逐条判） ---------- */
console.log("\n[2] 复制过滤判据（copySkipOf）");
{
  const man = { name: "演示应用" };
  const skip = (rel) => store.copySkipOf(rel, man) === true;
  const keep = (rel) => store.copySkipOf(rel, man) === false;
  ok(skip("") && skip("/"), "空路径一律当「不复制」（不给空 rel 造出目录项）");
  ok(skip("storage") && skip("storage/store.json"), "storage/（应用存档）整棵不复制");
  ok(skip("node_modules/a/index.js") && skip(".git/config"), "node_modules / .git 不复制（依赖与版本库不是应用本体）");
  ok(skip("app.json") && skip("sub/app.json") && skip("installed.json"), "app.json 与 installed.json 不复制（清单改写、账本是「从云端下来的」凭据）");
  ok(skip("demo.mtnodes") && skip("assets/x.mtnodes"), "*.mtnodes 画布快照不复制（开发副本自己那张画布由画布链管）");
  ok(skip("merge.json") && skip(".merge-done.json"), "合并链的暂存元信息不复制");
  ok(skip("演示应用.zip") && !store.copySkipOf("别的.zip", man), "<清单 name>.zip（源包 / 上架包）按清单名字判，别的 zip 不误伤");
  ok(skip(".mtnode-merge-backup-abc/x.txt"), ".mtnode-merge-backup* 备份目录不复制");
  ok(keep("index.html") && keep("app.js") && keep("assets/logo.png"), "应用本体（入口页 / 脚本 / 资源）照常复制");
  ok(keep("storage2/x") === true, "只按整段判 storage（storage2 这种同前缀目录不误伤）");
}

/* ---------- [3] 正常复制：目标出现、dev:true、作者与版本保留、forkOf 指向源 owner、cloud 清掉 ---------- */
console.log("\n[3] 正常复制（copy）：目标成一份开发副本，库那份原地不动");
const ID = "copydemo";
{
  const src = path.join(DL, ID);
  write(path.join(src, "app.json"), JSON.stringify({
    schema: 1,
    id: ID,
    name: "演示应用",
    title: "演示标题",
    version: "2.5.1",
    author: "原作者",
    entry: "index.html",
    capabilities: { textInput: true, showDictate: false, imageGen: true },
    cloud: { id: ID, ownerId: "u_me", version: "2.5.1", at: 111 },
    removed: false,
    removedAt: 222,
  }));
  write(path.join(src, "installed.json"), JSON.stringify({ id: ID, ownerId: "u_src", owner: "源作者", version: "2.5.1" }));
  write(path.join(src, "index.html"), "<html>demo</html>");
  const srcSnapBefore = snapDir(src);

  const r = store.copyAppToDev({ id: ID });
  const dst = path.join(DEV, ID);
  ok(r && r.ok === true, "回 ok:true（" + JSON.stringify({ code: r && r.code, error: r && r.error }) + "）");
  ok(r.mode === "copy" && r.backupDir === "" && r.previous === null, "mode=\"copy\"、没有备份目录、previous=null（目标原本不存在）");
  ok(path.resolve(r.from) === path.resolve(src) && path.resolve(r.dir) === path.resolve(dst), "回执如实给出 from=下载根那份 / dir=项目根那份");
  ok(ex(dst) && ex(path.join(dst, "index.html")), "项目根出现了这一份开发副本");

  const man = manOf(dst);
  ok(man.dev === true, "副本 app.json 写 dev:true（= 本机开发中，开发页据此收它）");
  ok(man.author === "原作者" && man.version === "2.5.1", "**保留源那份的 author 与 version**（便于上架时选分支点），不改成当前登录账号");
  ok(r.kept && r.kept.author === "原作者" && r.kept.version === "2.5.1", "回执 kept 也如实带作者与版本");
  ok(
    man.forkOf && man.forkOf.id === ID && man.forkOf.ownerId === "u_src" && man.forkOf.owner === "源作者",
    "副本写了内部来源记录 forkOf = { id, ownerId: 源 ownerId, owner: 源 owner }（来源取 installed.json）：" + JSON.stringify(man.forkOf),
  );
  ok(man.cloud === undefined && man.removed === undefined && man.removedAt === undefined, "上架留痕 cloud 与下架留痕 removed / removedAt 都清掉了");
  ok(man.title === "演示标题" && man.capabilities && man.capabilities.imageGen === true, "清单其余字段原样带过来（title / capabilities 一个字不改）");
  ok(man.id === ID && man.name === "演示应用", "id / name 保持（副本就是同一个应用 id 的开发副本）");
  ok(sameSnap(snapDir(src), srcSnapBefore), "★ 库目录里那一份一个字节都没变（复制 = 不搬走）");
}

/* ---------- [4] 过滤：不该跟着走的文件一个都没进目标 ---------- */
console.log("\n[4] 过滤：storage / 账本 / 画布 / 源包 / 合并元信息都不进开发副本");
{
  const src = path.join(DL, ID);
  const dst = path.join(DEV, ID);
  write(path.join(src, "app.js"), "console.log(1)");
  write(path.join(src, "assets", "logo.png"), "PNG");
  write(path.join(src, "storage", "store.json"), '{"keep":true}');
  write(path.join(src, "demo.mtnodes"), "canvas");
  write(path.join(src, "merge.json"), "{}");
  write(path.join(src, ".merge-done.json"), "{}");
  write(path.join(src, "演示应用.zip"), "PK");
  write(path.join(src, "别的.zip"), "PK2");
  write(path.join(src, "node_modules", "pkg", "index.js"), "module");
  write(path.join(src, ".git", "config"), "[core]");
  write(path.join(src, ".mtnode-merge-backup-abc", "x.txt"), "old");
  const r = store.copyAppToDev({ id: ID, mode: "overwrite" }); /* 已存在 → 走覆盖，顺便证明覆盖也走同一套过滤 */
  ok(r.ok === true, "第二次调用（覆盖）成功");
  ok(
    ex(path.join(dst, "app.js")) && ex(path.join(dst, "assets", "logo.png")) && ex(path.join(dst, "index.html")),
    "应用本体进目标：index.html / app.js / assets/logo.png",
  );
  ok(ex(path.join(dst, "别的.zip")), "清单名字之外的 zip 照样复制（判据按 <清单 name>.zip 认，不是「见 zip 就跳」）");
  ok(
    !ex(path.join(dst, "storage")) && !ex(path.join(dst, "installed.json")) && !ex(path.join(dst, "demo.mtnodes")) &&
      !ex(path.join(dst, "merge.json")) && !ex(path.join(dst, ".merge-done.json")) &&
      !ex(path.join(dst, "演示应用.zip")) && !ex(path.join(dst, "node_modules")) && !ex(path.join(dst, ".git")) &&
      !ex(path.join(dst, ".mtnode-merge-backup-abc")),
    "★ 一个都不许进目标：storage/ · installed.json · *.mtnodes · merge.json · .merge-done.json · <清单 name>.zip · node_modules · .git · 备份目录",
  );
  ok(
    r.files === 4,
    "回执 files = 真复制过去的文件数（index.html / app.js / assets/logo.png / 别的.zip = 4，实得 " + r.files + "）",
  );
  ok(ex(path.join(dst, "app.json")) && manOf(dst).dev === true, "app.json 不复制但会被**改写**成开发副本那一份");
}

/* ---------- [5] 冲突：目标已存在且没传 mode → exists，且目标一个字节都没变 ---------- */
console.log("\n[5] 冲突（exists）：不问不覆盖，一个字节都不动");
{
  const TID = "conflictapp";
  const src = path.join(DL, TID);
  const dst = path.join(DEV, TID);
  write(path.join(src, "app.json"), JSON.stringify({ schema: 1, id: TID, name: TID, version: "3.0.0", author: "源作者B" }));
  write(path.join(src, "index.html"), "SRC-V2");
  write(path.join(dst, "app.json"), JSON.stringify({ schema: 1, id: TID, name: TID, version: "1.0.0", author: "本机旧作者", dev: true }));
  write(path.join(dst, "index.html"), "OLD-LOCAL");
  write(path.join(dst, "keep.txt"), "sentinel");
  const dstBefore = snapDir(dst);
  const srcBefore = snapDir(src);

  const r = store.copyAppToDev({ id: TID });
  ok(r.ok === false && r.code === "exists", "回 ok:false / code:\"exists\"（不是抛错、也不是悄悄覆盖）");
  ok(r.exists === true && path.resolve(r.dir) === path.resolve(dst), "回执带 exists:true 与目标目录（界面据此问「覆盖 / 交给 AI 合并」）");
  ok(sameSnap(snapDir(dst), dstBefore), "★ 目标**一个字节都没变**（用户还没选走哪条路）");
  ok(sameSnap(snapDir(src), srcBefore), "源那份也没动");

  /* previous / kept 只在真覆盖时才有意义；exists 这一趟不许泄漏半份回执 */
  ok(r.backupDir === undefined || r.backupDir === "", "exists 时不建备份目录");
}

/* ---------- [6] 覆盖：先备份旧那份再整份接替；旧文件能找回、库那份仍在 ---------- */
console.log("\n[6] 覆盖（overwrite）：旧那份进 merge-backups，源目录仍在");
{
  const TID = "conflictapp";
  const src = path.join(DL, TID);
  const dst = path.join(DEV, TID);
  const r = store.copyAppToDev({ id: TID, mode: "overwrite" });
  ok(r.ok === true && r.mode === "overwrite", "回 ok:true / mode:\"overwrite\"");
  ok(
    !!r.backupDir && ex(r.backupDir) && String(r.backupDir).indexOf(path.join(DATA, "merge-backups")) === 0,
    "备份目录真建在 <数据目录>/merge-backups 下：" + String(r.backupDir).replace(DATA, "<数据目录>"),
  );
  const bakApp = path.join(r.backupDir, "app");
  ok(
    ex(path.join(bakApp, "keep.txt")) &&
      fs.readFileSync(path.join(bakApp, "keep.txt"), "utf8") === "sentinel" &&
      fs.readFileSync(path.join(bakApp, "index.html"), "utf8") === "OLD-LOCAL",
    "★ 旧那份整目录备份可找回（app/keep.txt 与 app/index.html 都是覆盖前的旧内容）",
  );
  ok(fs.readFileSync(path.join(dst, "index.html"), "utf8") === "SRC-V2", "目标换成了源内容");
  ok(!ex(path.join(dst, "keep.txt")), "旧的本地文件随整份接替消失（备份里那一份就是退路）");
  const man = manOf(dst);
  ok(man.version === "3.0.0" && man.author === "源作者B" && man.dev === true, "覆盖后的清单 = 源那份的作者 / 版本 + dev:true");
  ok(
    r.previous && r.previous.author === "本机旧作者" && r.previous.version === "1.0.0",
    "回执 previous 如实说明「这次接替掉的是谁的那一版」：" + JSON.stringify(r.previous),
  );
  ok(
    ex(path.join(src, "index.html")) && fs.readFileSync(path.join(src, "index.html"), "utf8") === "SRC-V2",
    "★ 库目录里那一份仍在（覆盖 = 从源复制，不搬走源）",
  );

  /* 再覆盖一次：两次备份目录不许互相踩（名字带时间戳 —— 等 1 毫秒跨过去，别让同一毫秒的两次调用同名） */
  const t0 = Date.now();
  while (Date.now() === t0) {}
  const r2 = store.copyAppToDev({ id: TID, mode: "overwrite" });
  ok(r2.ok === true && r2.backupDir !== r.backupDir && ex(r2.backupDir), "第二次覆盖另起一个备份目录（时间戳区分，旧退路不被踩掉）");
}

/* ---------- [7] 来源记录的两层回落：没有账本退清单 author；都没有 = null ---------- */
console.log("\n[7] forkOf 的取数回落（账本 → 清单 author → 不放该字段）");
{
  const A = "forkbyauthor";
  write(path.join(DL, A, "app.json"), JSON.stringify({ schema: 1, id: A, name: A, version: "1.0.0", author: "清单里的作者" }));
  write(path.join(DL, A, "index.html"), "x");
  const ra = store.copyAppToDev({ id: A });
  const ma = manOf(path.join(DEV, A));
  ok(
    ra.ok === true && ma.forkOf && ma.forkOf.id === A && ma.forkOf.ownerId === "" && ma.forkOf.owner === "清单里的作者",
    "没有 installed.json → 来源退回清单 author（ownerId 空）：" + JSON.stringify(ma.forkOf),
  );

  const B = "forknone";
  write(path.join(DL, B, "app.json"), JSON.stringify({ schema: 1, id: B, name: B, version: "1.0.0" }));
  write(path.join(DL, B, "index.html"), "x");
  const rb = store.copyAppToDev({ id: B });
  const mb = manOf(path.join(DEV, B));
  ok(rb.ok === true && mb.forkOf === null && rb.kept.forkOf === null, "账本与清单作者都没有 → forkOf = null（原创，上架时不发该字段）");
}

/* ---------- [8] 两个错误码：not_in_library / same_root（都不许动任何东西） ---------- */
console.log("\n[8] 错误码：not_in_library（库里没有）/ same_root（两套根是同一个目录）");
{
  const GHOST = "ghostapp";
  const r = store.copyAppToDev({ id: GHOST });
  ok(r.ok === false && r.code === "not_in_library", "下载根里没有这个 id → code:\"not_in_library\"（不是乱建一个空目录）");
  ok(!ex(path.join(DEV, GHOST)) && !ex(path.join(DL, GHOST)), "失败时两边都没有留下东西");

  const SID = "samerootapp";
  write(path.join(DL, SID, "app.json"), JSON.stringify({ schema: 1, id: SID, name: SID, version: "1.0.0", author: "a" }));
  write(path.join(DL, SID, "index.html"), "x");
  const before = snapDir(path.join(DL, SID));
  writeCfg({ apps: { installDir: DL, projectDir: DL } }); /* 两套根配成同一个目录 */
  const r2 = store.copyAppToDev({ id: SID });
  ok(r2.ok === false && r2.code === "same_root", "两套根是同一个目录 → code:\"same_root\"（复制到自己身上没有意义）");
  ok(sameSnap(snapDir(path.join(DL, SID)), before), "same_root 时源一个字节都没变");
  writeCfg({ apps: { installDir: DL, projectDir: DEV } }); /* 复原，免得影响后面 */

  const bad = store.copyAppToDev({ id: "../evil" });
  ok(bad.ok === false && bad.code === "bad_id", "非法 id → code:\"bad_id\"（越界路径先在 id 合法化那一步拦下）");

  /* 目录不许落在两套根之外：目标永远 = <项目根>/<id> */
  write(path.join(DL, "plainapp", "app.json"), JSON.stringify({ schema: 1, id: "plainapp", name: "plainapp", version: "1.0.0" }));
  const rp = store.copyAppToDev({ id: "plainapp" });
  ok(rp.ok === true && rp.dir === path.join(DEV, "plainapp"), "目标恒为 <项目根>/<id>（不按清单 / 用户输入另算路径）");
}

/* ---------- [9] 收尾 ---------- */
console.log("\n[9] 收尾");
console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " 项"));
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}
process.exit(fails ? 1 : 0);

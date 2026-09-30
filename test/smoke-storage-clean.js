"use strict";
/* 设置 · 存储占用与清理（storage-clean.js）回归冒烟测试 —— 纯 Node，不启动 Electron
 *   node test/smoke-storage-clean.js
 *
 * 本功能：设置里统计数据目录各类冗余的占用，并清理「已经没被 MTNode 用着」的文件。
 * 钉住的口径（每条都是「错一点就会误删用户东西」的地方）：
 *   [1] 画布资产：只清**没有任何引用**的直属文件 ——
 *       ① 被现役存档 save/<wfId>.json 提到的保留；
 *       ② 被 save-backups/<wfId>/ 快照提到的保留（现役存档没提到时才去读备份）；
 *       ③ 回收站里的东西**不算引用**（回收站自己也是一类可清理项，不当判据来源）；
 *       ④ 正在运行的画布整个 assets/<wfId>/ 跳过（runningWfIds）；
 *       ⑤ 子目录整体计占用但不动它。
 *   [2] 保留策略：画布备份每画布留 72 份、配置备份留 30 份、会话目录留最近 N 天。
 *   [3] 缓存分类：store-cache / apps-cache / exports / forum / captures / browser-shots；
 *       浏览器配置只清缓存子目录，Cookie 与 Local Storage **必须留**。
 *   [4] 删除口径：非永久项搬进回收站（假体下回退数据目录 .storage-clean 暂存区），
 *       条目确实从原位消失；永久项（会话）直接删；暂存区自身永不被清。
 *   [5] 分类清理与「全部清理」回执：bytesFreed / removed / failed 与实际落盘一致；
 *       清理后重新统计，可清理量确实下降。
 *   [6] 静态接线：main.js 注册 IPC 并把 rollback-store 的 gc 传进来、preload 白名单桥、
 *       设置小节的自动扫描与二次确认、CSS、i18n 英译、build.json 打包白名单。
 *   [7] 引用读取失败时**放弃本轮清理**（宁可不清也不错删）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));

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
const section = (t) => console.log("\n[" + t + "]");
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const has = (hay, needle, msg) => ok(hay.indexOf(needle) >= 0, msg);

/* ═══════════════════ electron 假体：只为把 storage-clean.js load 起来 ═══════════════════ */
const handlers = {};
const electronStub = {
  ipcMain: {
    handle: (ch, fn) => {
      handlers[ch] = fn;
    },
  },
  /* 不给 shell.trashItem：逼 moveToTrash 走数据目录 .storage-clean 暂存区回退，
     这样断言能直接看磁盘上的结果（真机上有系统回收站时走 trashItem 那条路）。 */
  shell: {},
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-storage-clean-"));
const sc = require(path.join(__dirname, "..", "storage-clean.js"));
const DATA = path.join(ROOT, "data");
let gcCalls = 0;
sc.registerStorageIpc({
  getDataDir: () => DATA,
  t: (s) => I18n.t(s),
  rollbackGc: () => {
    gcCalls += 1;
    fs.rmSync(path.join(DATA, "rollback"), { recursive: true, force: true });
    return { ok: true, objectsRemoved: 1, roundsRemoved: 2 };
  },
});

/* ═══════════════════ 造现场 ═══════════════════ */
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const put = (p, body) => {
  mk(path.dirname(p));
  fs.writeFileSync(p, body);
};
const pad = (n) => "x".repeat(n);
const P = (...parts) => path.join(DATA, ...parts);
const call = (ch, arg) => handlers[ch](null, arg);
const scan = (arg) => call("storage:scan", arg || { sessionDays: 7 });
const clean = (arg) => call("storage:clean", arg);

mk(P("assets", "wf_aaaa1111"));
mk(P("assets", "wf_bbbb2222"));
mk(P("assets", "wf_running111"));
put(P("assets", "wf_aaaa1111", "keep-save.png"), pad(1000));
put(P("assets", "wf_aaaa1111", "keep-backup.png"), pad(2500));
put(P("assets", "wf_aaaa1111", "trash-only.png"), pad(1500));
put(P("assets", "wf_aaaa1111", "orphan-1.png"), pad(2000));
put(P("assets", "wf_aaaa1111", "orphan-2.jpg"), pad(3000));
put(P("assets", "wf_aaaa1111", "sub", "nested.png"), pad(4000));
put(P("assets", "wf_bbbb2222", "live-only.png"), pad(500));
put(P("assets", "wf_running111", "running-orphan.png"), pad(700));
put(
  P("save", "wf_aaaa1111.json"),
  JSON.stringify({ nodes: [{ image: "keep-save.png" }] }) + pad(200),
);
put(P("save", "wf_bbbb2222.json"), JSON.stringify({ nodes: [{ image: "live-only.png" }] }));
/* 回收站里那份存档提到 trash-only.png：回收站**不算引用** → 仍然算可清理 */
put(
  P("trash", "2026-01-01__wf_old", "wf_old.json"),
  JSON.stringify({ t: "trash-only.png" }),
);
/* 只被备份快照提到 keep-backup.png（现役存档里没有它 → 必须去读那一条画布的备份）；
   这份快照的 mtime 设成「最新」，于是它恒在保留的 72 份之内，可用来验证「备份提到就不算冗余」 */
put(
  P("save-backups", "wf_aaaa1111", "snap-000.json"),
  JSON.stringify({ t: "keep-backup.png" }),
);
fs.utimesSync(P("save-backups", "wf_aaaa1111", "snap-000.json"), Date.now() / 1000, Date.now() / 1000);
/* 再加 80 份旧快照：共 81 份，保留最新 72 → 可清 9 份 */
for (let i = 0; i < 80; i++) {
  const p = P("save-backups", "wf_aaaa1111", "s" + String(i).padStart(3, "0") + ".json");
  put(p, pad(100));
  const t = (Date.now() - (80 - i) * 60000) / 1000;
  fs.utimesSync(p, t, t);
}
/* 配置备份 35 份（保留 30 → 可清 5） */
for (let i = 0; i < 35; i++) {
  const p = P("config-backups", "config-" + String(i).padStart(3, "0") + ".json");
  put(p, pad(200));
  const t = (Date.now() - (35 - i) * 60000) / 1000;
  fs.utimesSync(p, t, t);
}
put(P("store-cache", "t_a.mtnodes"), pad(111));
put(P("apps-cache", "catalog.json"), pad(22));
put(P("captures", "shot.png"), pad(222));
put(P("browser-shots", "shot2.png"), pad(333));
mk(P(".storage-clean"));
put(P(".storage-clean", "already-here.bin"), pad(9999));
/* 浏览器配置：两个缓存子目录 + Cookie + Local Storage */
put(P("browser-profile", "Default", "Cache", "Cache_Data", "f_1"), pad(5000));
put(P("browser-profile", "Default", "Code Cache", "js", "f_2"), pad(3000));
put(P("browser-profile", "Default", "Cookies"), pad(777));
put(P("browser-profile", "Default", "Local Storage", "leveldb", "f_3"), pad(888));
/* 会话：3 个旧的 + 1 个新的 */
for (let i = 0; i < 3; i++) {
  const d = P("dsh-home", "sessions", "old-sess-" + i);
  const f = path.join(d, "session.jsonl");
  put(f, pad(3000));
  const t = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(f, t, t);
  fs.utimesSync(d, t, t);
}
put(P("dsh-home", "sessions", "new-sess", "session.jsonl"), pad(1500));
put(P("rollback", "objects", "abc.bin"), pad(6000));

const byId = (s) => {
  const out = {};
  for (const c of s.cats) out[c.id] = c;
  return out;
};

(async () => {
  /* ── [1][2][3] 统计 ─────────────────────────────────────────────── */
  section("统计：分类占用与可清理量");
  const s0 = await scan({ runningWfIds: ["wf_running111"], sessionDays: 7 });
  ok(s0.ok === true, "scan 返回 ok");
  ok(s0.root === DATA, "回执带数据目录：" + s0.root);
  const c0 = byId(s0);
  ok(
    ["wf_assets", "wf_backup", "cfg_backup", "caches", "trash", "browser", "rollback", "sessions"]
      .every((id) => c0[id]),
    "八个分类齐全",
  );

  has(c0.wf_assets.hint, "正在运行的画布整个跳过", "画布资产写明运行中画布保护口径");
  ok(
    c0.wf_assets.files === 8,
    "画布资产文件数 8（7 个直属 + 1 个子目录文件；得到 " + c0.wf_assets.files + "）",
  );
  ok(
    c0.wf_assets.bytes === 1000 + 2500 + 1500 + 2000 + 3000 + 4000 + 500 + 700,
    "画布资产总数含子目录（得到 " + c0.wf_assets.bytes + "）",
  );
  ok(
    c0.wf_assets.cleanFiles === 3,
    "只清 3 个没引用的（trash-only / orphan-1 / orphan-2；得到 " + c0.wf_assets.cleanFiles + "）",
  );
  ok(c0.wf_assets.cleanBytes === 6500, "可清 6500 字节（得到 " + c0.wf_assets.cleanBytes + "）");
  ok(c0.wf_assets.cleanable === true, "画布资产可清理");
  has(c0.wf_assets.detail, "已保护运行中的画布", "详情里回显保护了运行中的画布");

  ok(c0.wf_backup.cleanFiles === 9, "画布备份可清 9 份（得到 " + c0.wf_backup.cleanFiles + "）");
  ok(s0.wfBackupKeep === 72, "画布备份保留份数 = 72");
  ok(c0.cfg_backup.cleanFiles === 5, "配置备份可清 5 份（得到 " + c0.cfg_backup.cleanFiles + "）");
  ok(s0.cfgBackupKeep === 30, "配置备份保留份数 = 30");
  ok(c0.caches.cleanFiles === 4, "缓存计入 4 个文件（得到 " + c0.caches.cleanFiles + "）");
  ok(c0.trash.items === 1, "回收站 1 项（得到 " + c0.trash.items + "）");
  ok(
    c0.browser.cleanFiles === 2 && c0.browser.bytes === 5000 + 3000 + 777 + 888,
    "浏览器配置：只清 2 个缓存文件、总量含 Cookie（得到 " + c0.browser.cleanFiles + "/" + c0.browser.bytes + "）",
  );
  ok(c0.browser.permanent === false, "浏览器缓存走回收站，不是永久删除");
  ok(c0.sessions.items === 3, "会话可清 3 个（得到 " + c0.sessions.items + "）");
  ok(c0.sessions.permanent === true, "会话记录标为永久删除");
  ok(s0.totals.cleanBytes > 0 && s0.totals.files > 0, "总计给出可清理量与文件数");

  const s1 = await scan({ sessionDays: 60 });
  ok(
    byId(s1).sessions.cleanFiles === 0,
    "保留天数改成 60 天后没有超期会话（得到 " + byId(s1).sessions.cleanFiles + "）",
  );

  /* ── [7] 引用读取失败要放弃本轮清理 ─────────────────────────────── */
  section("引用读取失败：放弃清理（宁可不清也不错删）");
  {
    const bad = path.join(DATA, "save", "broken.json");
    fs.mkdirSync(bad, { recursive: true }); /* 存档目录里出现子目录：判定不可靠 */
    const sBad = await scan({});
    ok(byId(sBad).wf_assets.cleanable === false, "读不到引用集时该类不可清理");
    has(byId(sBad).wf_assets.detail, "为安全计本次不清理", "详情写明放弃原因");
    const rBad = await clean({ id: "wf_assets" });
    ok(
      rBad.results[0].ok === false && rBad.removed === 0,
      "清理请求被拒绝且什么都没删（得到 removed=" + rBad.removed + "）",
    );
    fs.rmSync(bad, { recursive: true, force: true });
  }

  /* ── [4] 清理：画布资产 ─────────────────────────────────────────── */
  section("清理画布资产：引用件全留、孤儿进暂存区");
  const r1 = await clean({ id: "wf_assets", runningWfIds: ["wf_running111"] });
  ok(
    r1.ok === true && r1.removed === 3 && r1.bytesFreed === 6500,
    "清掉 3 个 / 6500 字节（得到 " + r1.removed + "/" + r1.bytesFreed + "）",
  );
  ok(r1.failed === 0, "没有失败项（得到 " + r1.failed + "）");
  ok(fs.existsSync(P("assets", "wf_aaaa1111", "keep-save.png")), "现役存档提到的 keep-save.png 保留");
  ok(fs.existsSync(P("assets", "wf_aaaa1111", "keep-backup.png")), "备份快照提到的 keep-backup.png 保留");
  ok(fs.existsSync(P("assets", "wf_bbbb2222", "live-only.png")), "另一条画布存档提到的 live-only.png 保留");
  ok(fs.existsSync(P("assets", "wf_aaaa1111", "sub", "nested.png")), "子目录内容不动");
  ok(fs.existsSync(P("assets", "wf_running111", "running-orphan.png")), "运行中画布的资产不动");
  ok(!fs.existsSync(P("assets", "wf_aaaa1111", "orphan-1.png")), "orphan-1.png 已清");
  ok(!fs.existsSync(P("assets", "wf_aaaa1111", "orphan-2.jpg")), "orphan-2.jpg 已清");
  ok(!fs.existsSync(P("assets", "wf_aaaa1111", "trash-only.png")), "只被回收站提到的 trash-only.png 已清");
  const staged = fs.readdirSync(P(".storage-clean")).filter((n) => /orphan|trash-only/.test(n));
  ok(staged.length === 3, "三个孤儿进了 .storage-clean 暂存区（得到 " + staged.length + "）");
  ok(fs.existsSync(P(".storage-clean", "already-here.bin")), "暂存区原有文件不被清");

  /* ── [4][5] 清理：其余分类 ─────────────────────────────────────── */
  section("清理其余分类");
  const r2 = await clean({ id: "trash" });
  ok(r2.removed === 1, "回收站清掉 1 项（得到 " + r2.removed + "）");
  ok(!fs.existsSync(P("trash", "2026-01-01__wf_old")), "回收站条目已搬走");

  const r3 = await clean({ id: "browser" });
  ok(r3.removed === 2, "浏览器缓存清 2 项（得到 " + r3.removed + "）");
  ok(fs.existsSync(P("browser-profile", "Default", "Cookies")), "Cookie 保留");
  ok(fs.existsSync(P("browser-profile", "Default", "Local Storage", "leveldb", "f_3")), "Local Storage 保留");
  ok(!fs.existsSync(P("browser-profile", "Default", "Cache")), "Cache 子目录已清");
  ok(!fs.existsSync(P("browser-profile", "Default", "Code Cache")), "Code Cache 子目录已清");

  const r4 = await clean({ id: "sessions", sessionDays: 7 });
  ok(r4.removed === 3, "会话清 3 个（得到 " + r4.removed + "）");
  ok(fs.existsSync(P("dsh-home", "sessions", "new-sess", "session.jsonl")), "新会话保留");

  const r5 = await clean({ id: "rollback" });
  ok(gcCalls === 1, "回滚那类调了 rollback-store 的 gc（得到 " + gcCalls + " 次）");
  ok(!fs.existsSync(P("rollback", "objects", "abc.bin")), "回滚对象已删");

  const r6 = await clean({ id: "wf_backup" });
  ok(r6.removed === 9, "画布备份清 9 份（得到 " + r6.removed + "）");
  ok(fs.readdirSync(P("save-backups", "wf_aaaa1111")).length === 72, "画布备份剩 72 份");
  ok(fs.existsSync(P("save-backups", "wf_aaaa1111", "snap-000.json")), "最新那份快照仍在（里面提到的资产也不清）");

  const r7 = await clean({ id: "cfg_backup" });
  ok(r7.removed === 5, "配置备份清 5 份（得到 " + r7.removed + "）");
  ok(fs.readdirSync(P("config-backups")).length === 30, "配置备份剩 30 份");

  const r8 = await clean({ id: "caches" });
  ok(r8.removed === 4, "缓存清 4 项（得到 " + r8.removed + "）");

  /* ── [5] 清理后重新统计：可清理量下降 ─────────────────────────── */
  section("清理后复扫");
  const s2 = await scan({ runningWfIds: ["wf_running111"], sessionDays: 7 });
  const c2 = byId(s2);
  ok(c2.wf_assets.cleanFiles === 0, "画布资产已无可清项（得到 " + c2.wf_assets.cleanFiles + "）");
  ok(
    c2.wf_assets.files === 5,
    "剩余 5 个画布资产文件（3 引用件 + 1 子目录 + 运行中画布那 1 个；得到 " + c2.wf_assets.files + "）",
  );
  ok(c2.sessions.cleanFiles === 0 && c2.trash.items === 0, "会话与回收站已无可清项");
  ok(
    s2.totals.cleanBytes < s0.totals.cleanBytes,
    "总可清理量下降（" + s0.totals.cleanBytes + " → " + s2.totals.cleanBytes + "）",
  );

  /* ── [5] 全部清理：一次跑完全部分类 ──────────────────────────── */
  section("全部清理");
  put(P("assets", "wf_zzzz9999", "orphan-9.png"), pad(3333));
  put(P("save", "wf_zzzz9999.json"), JSON.stringify({ nodes: [] }));
  const rAll = await clean({ id: "all", runningWfIds: ["wf_running111"], sessionDays: 7 });
  ok(rAll.results.length === 8, "全部清理逐类回执 8 条（得到 " + rAll.results.length + "）");
  ok(
    rAll.removed >= 1 && rAll.bytesFreed >= 3333,
    "全部清理带走了新孤儿（得到 " + rAll.removed + "/" + rAll.bytesFreed + "）",
  );
  ok(!fs.existsSync(P("assets", "wf_zzzz9999", "orphan-9.png")), "新孤儿已清");
  ok(fs.existsSync(P("assets", "wf_running111", "running-orphan.png")), "全部清理也带着运行中画布的保护");
  ok(fs.existsSync(P(".storage-clean", "already-here.bin")), "暂存区自身仍未被清");

  /* ── [6] 静态接线 ─────────────────────────────────────────────── */
  section("静态接线：IPC / preload / 设置 / 样式 / 词条 / 打包白名单");
  const MAIN = read("main.js");
  const PRELOAD = read("preload.js");
  const SETTINGS = read("renderer/app-settings.js");
  const CSS = read("renderer/css/dsh.css");
  const BUILD = read("build.json");

  has(MAIN, 'require("./storage-clean.js")', "main.js require storage-clean.js");
  has(
    MAIN,
    "registerStorageIpc({ getDataDir: DATA, t: (s) => I18n.t(s), rollbackGc: rollbackGc })",
    "main.js 注册 IPC 并传入 rollbackGc",
  );
  has(
    MAIN,
    'const { registerRollbackIpc, gc: rollbackGc } = require("./rollback-store.js")',
    "rollbackGc 取自 rollback-store 的导出",
  );
  has(PRELOAD, "storageScan: (opts) => ipcRenderer.invoke('storage:scan', opts || {})", "preload 暴露 storageScan");
  has(PRELOAD, "storageClean: (opts) => ipcRenderer.invoke('storage:clean', opts || {})", "preload 暴露 storageClean");
  has(SETTINGS, 'I18n.t("存储占用与清理")', "设置里有同名小节");
  has(SETTINGS, "await window.api.storageScan({", "小节打开即自动扫描");
  has(SETTINGS, "await window.api.storageClean({", "小节调 storageClean");
  has(SETTINGS, "runningWfIds: protectedIds()", "清理时把运行中画布 id 传给主进程");
  has(SETTINGS, "const scPick = (rows) => {", "清理前有二次确认（scPick）");
  has(SETTINGS, 'I18n.t("全部清理")', "有「全部清理」入口");
  has(CSS, ".sc-row", "样式补齐分类行");
  has(CSS, ".sc-pick", "样式补齐确认清单");
  has(BUILD, '"storage-clean.js"', "build.json 白名单已加 storage-clean.js");
  I18n.setLocale("en");
  ok(
    I18n.t("存储占用与清理") === "Storage usage & cleanup",
    "i18n 英译存在（得到 " + I18n.t("存储占用与清理") + "）",
  );
  ok(I18n.t("全部清理") === "Clean all", "i18n 全部清理英译存在（得到 " + I18n.t("全部清理") + "）");
  I18n.setLocale("zh");

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log("\n" + (fails ? "FAILS=" + fails + " / " + checks : "ALL OK (" + checks + " checks)"));
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log("FAIL  测试自身抛错：" + ((err && err.stack) || err));
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});

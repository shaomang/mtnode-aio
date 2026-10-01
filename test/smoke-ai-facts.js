"use strict";
/* AI 事实库 · 主进程存储与迁移 —— 冒烟测试（纯 Node，无 Electron / 无真实 %APPDATA%）
 *   node test/smoke-ai-facts.js
 * 被测代码是「真实模块真跑」，不抄第二份逻辑：
 *   ai-facts-store.js     固定文件路径解析（画布文件夹 + 团队事实库/AI/ai-facts.json）·
 *                         落盘守卫（不得落在应用目录内）· 读写与坏档备份 · 旧长期记忆迁移
 *   longtask-store.js     exportMemAll / dropMemTable（迁移的两端，真跑 SQLite + FTS5）
 * 覆盖：
 *   [0] 装配：main.js 注册 · build.json 白名单 · preload 桥 · longtask-store 导出迁移接口
 *   [1] 固定路径与落盘守卫：合成路径唯一（调用方给不出第二个落点）·
 *       应用目录（app.getAppPath / exe 同目录）内一律拒绝且一个字节不落 ·
 *       相对路径 / 空 / 磁盘根各自拒绝
 *   [2] 新库落盘：不存在时载入不建文件（等首次写入）· 保存后 JSON 可解析 ·
 *       字段往返保住（含 src / hits / pinned）· 结构归一（脏条目丢掉、cap 夹紧、缺 entries 补空）
 *   [3] JSON 校验失败备份：坏档先原样备份成 ai-facts.json.bak 再当空库，文件本身不动；
 *       之后写入重写主档、备份仍在
 *   [4] 迁移：旧 SQLite 记忆（mem 表）按「标题 + 来源」去重后全量导入固定文件（导出按
 *       updated DESC，同名同来源前到先得；两条重复项的 updated 显式分开，不押 tie-break）·
 *       保留原 created / updated、hits / lastHit 初始化为 0 · 成功后删表（mem / mem_fts 全没）·
 *       memory.db 文件保留作备份 · 二次载入幂等 · 表被重建后重跑仍不重复（去重兜底）
 *   [5] 渲染层这一条链路（renderer/app-ai-facts.js 真跑在 vm 沙箱里）：
 *       模块存在 + window.MTNodeAIFacts 接口面（含大小写别名与 aiFacts* 全局别名）·
 *       固定路径 <画布文件夹>\团队事实库\AI\ai-facts.json（三段写在常量里，调用方给不出第二个落点）·
 *       schema 版本 version:1 · 坏档（非法 JSON / 非对象）先原样备份 .bak 再当空库、主档不动 ·
 *       Hit 计分公式 score = hit / (1 + 距上次命中天数)（读 +1 / 写 +0.5，线性衰减不设半衰期）·
 *       7 天保护期（零命中新条目 protectionUntil = createdAt + 7 天，期内不参与淘汰）·
 *       > cap 削最低分、pinned 永不淘汰、默认硬上限 100、cap 手打 1e9 夹到 1000 ·
 *       工具 mtnode_facts 的动作面 list/query/get/write/delete/pin 与 facts 帧 ·
 *       lt_memory 已彻底移除（网关不再注册 / 不在可裁名单 / cordis 不再挂载 / 桥帧只剩 lt_state /
 *       i18n 无词条；网关里剩的提及必须注明「已下线」）· 技能 mtnode-ai-facts 与索引 ·
 *       专家团左栏入口按钮（app-teamview.js 的 .team-side-ai-fact 行）
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

const Module = require("module");

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
function eq(a, b, msg) {
  ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
}
const ROOT_DIR = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT_DIR, ...rel.split("/")), "utf8");
const has = (s, mark, msg) => ok(String(s).indexOf(mark) >= 0, msg);

/* ═══════════ 现场：假应用目录 / 假数据目录 / 合法画布文件夹 ═══════════ */
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-smoke-ai-facts-"));
const APP_DIR = path.join(BASE, "app"); /* app.getAppPath() 与 exe 同目录都指这里 */
const DATA_DIR = path.join(BASE, "data"); /* longtask/memory.db 落在这儿 */
const CANVAS = path.join(BASE, "canvas");
fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CANVAS, { recursive: true });
const LIB_SEG = ["团队事实库", "AI", "ai-facts.json"];
const fixedOf = (canvasDir) => path.join(canvasDir, ...LIB_SEG);
const FIXED = fixedOf(CANVAS);

/* ═══════════ 假 electron + 真模块 ═══════════ */
const HANDLERS = new Map();
const electronStub = {
  ipcMain: {
    handle: (ch, fn) => HANDLERS.set(ch, fn),
    on() {},
    once() {},
    off() {},
    removeHandler() {},
    removeAllListeners() {},
  },
  ipcRenderer: {
    sendSync: () => undefined,
    send() {},
    on() {},
    invoke: () => Promise.resolve(),
    removeListener() {},
  },
  contextBridge: { exposeInMainWorld() {} },
  webUtils: { getPathForFile: () => "" },
  app: {
    getAppPath: () => APP_DIR,
    getPath: (n) => (n === "exe" ? path.join(APP_DIR, "MTNodeAIO.exe") : ""),
  },
  dialog: {},
  shell: {},
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};
const STORE_PATH = path.join(ROOT_DIR, "ai-facts-store.js");
const LT_PATH = path.join(ROOT_DIR, "longtask-store.js");
delete require.cache[require.resolve(STORE_PATH)];
delete require.cache[require.resolve(LT_PATH)];
const { registerAiFactsIpc } = require(STORE_PATH);
const { registerLongtaskIpc, exportMemAll, dropMemTable } = require(LT_PATH);
Module._load = origLoad;

registerLongtaskIpc({ getDataDir: () => DATA_DIR, t: (s) => String(s) });
registerAiFactsIpc({ t: (s) => String(s) });
const call = (ch, arg) => Promise.resolve(HANDLERS.get(ch)(null, arg));
const MEM_DB = path.join(DATA_DIR, "longtask", "memory.db");

/* ═══════════ [0] 装配 ═══════════ */
console.log("\n[0] 装配：main.js / build.json / preload / longtask-store 迁移出口");
has(read("main.js"), 'require("./ai-facts-store.js")', "main.js require 了 ai-facts-store.js");
has(read("main.js"), "registerAiFactsIpc({ t: (s) => I18n.t(s) })", "main.js 启动时注册 AI 事实库 IPC");
has(read("build.json"), '"ai-facts-store.js"', "build.json files 白名单收了这个根目录主进程模块（否则打包后 Cannot find module）");
for (const m of ["aiFactsPathOf", "aiFactsLoad", "aiFactsSave"]) {
  has(read("preload.js"), m + ":", "preload 白名单桥：" + m);
}
has(read("longtask-store.js"), "function exportMemAll()", "longtask-store 有一次性导出接口（读全表 mem）");
has(read("longtask-store.js"), "function dropMemTable()", "longtask-store 有迁移后的删表接口");
ok(typeof exportMemAll === "function" && typeof dropMemTable === "function", "两个迁移接口都从模块导出");
for (const ch of ["aifact:pathOf", "aifact:load", "aifact:save"]) {
  ok(HANDLERS.has(ch), "AI 事实库通道已挂：" + ch);
}

(async function main() {
  /* ═══════════ [1] 固定路径与落盘守卫 ═══════════ */
  console.log("\n[1] 固定文件路径解析 + 落盘守卫");
  {
    const r = await call("aifact:pathOf", { canvasDir: CANVAS });
    ok(r.ok === true, "合法画布文件夹解析成功");
    eq(r.dir, path.resolve(CANVAS), "dir = 画布文件夹绝对路径");
    eq(r.file, FIXED, "file = 画布文件夹 + 团队事实库/AI/ai-facts.json（固定三段，调用方给不出第二个落点）");

    const inApp = await call("aifact:pathOf", { canvasDir: path.join(APP_DIR, "some-canvas") });
    ok(inApp.ok === false && inApp.reason === "app", "应用目录（app.getAppPath）内的画布文件夹被拒绝（reason=app）");
    const inExe = await call("aifact:pathOf", { canvasDir: path.dirname(path.join(APP_DIR, "MTNodeAIO.exe")) });
    ok(inExe.ok === false && inExe.reason === "app", "exe 同目录内的画布文件夹被拒绝（reason=app）");
    eq(inApp.file, "", "被拒绝时不给文件路径（不泄漏可写落点）");

    const rel = await call("aifact:pathOf", { canvasDir: "relative" + path.sep + "dir" });
    ok(rel.ok === false && rel.reason === "relative", "相对路径被拒绝");
    const none = await call("aifact:pathOf", { canvasDir: "" });
    ok(none.ok === false && none.reason === "nodir", "没给画布文件夹时拒绝（不猜落点）");
    const root = await call("aifact:pathOf", { canvasDir: path.parse(process.cwd()).root });
    ok(root.ok === false && root.reason === "root", "磁盘根被拒绝");

    const badLoad = await call("aifact:load", { canvasDir: path.join(APP_DIR, "some-canvas") });
    ok(badLoad.ok === false && badLoad.reason === "app", "守卫命中时 load 拒绝");
    eq(badLoad.data.entries.length, 0, "拒绝时返回空库（不读盘）");
    const badSave = await call("aifact:save", { canvasDir: path.join(APP_DIR, "some-canvas"), data: { entries: [{ title: "x", text: "y" }] } });
    ok(badSave.ok === false && badSave.reason === "app", "守卫命中时 save 拒绝");
    ok(!fs.existsSync(path.join(APP_DIR, LIB_SEG[0])), "守卫命中后应用目录里一个字节都没落");
  }

  /* ═══════════ [2] 新库落盘 ═══════════ */
  console.log("\n[2] 新库落盘：只在首次写入时建文件 + 字段往返");
  {
    const first = await call("aifact:load", { canvasDir: CANVAS });
    ok(first.ok === true, "载入空库成功");
    eq(first.exists, false, "文件不存在 = 空库（exists:false）");
    eq(first.data.entries.length, 0, "空库没有条目");
    ok(!fs.existsSync(FIXED), "只读载入**不**创建文件（等首次写入才落地）");

    const data = {
      version: 1,
      cap: 5,
      entries: [
        {
          id: "af-keep",
          title: "端口口径",
          text: "proc_text 端口 0 = 提示词",
          src: "run-1",
          hits: 3,
          lastHit: 1700000000000,
          pinned: true,
          createdAt: 1600000000000,
          updatedAt: 1650000000000,
        },
      ],
    };
    const saved = await call("aifact:save", { canvasDir: CANVAS, data: data });
    ok(saved.ok === true, "保存成功");
    eq(saved.file, FIXED, "保存落到固定文件");
    ok(fs.existsSync(FIXED), "首次写入后文件真的在磁盘上");

    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(FIXED, "utf8"));
    } catch (e) {}
    ok(!!raw, "落盘的是可解析的 JSON");
    eq(raw && raw.version, 1, "version = 1");
    eq(raw && raw.cap, 5, "cap 原样保留");
    eq(raw && raw.entries.length, 1, "条目数 = 1");

    const again = await call("aifact:load", { canvasDir: CANVAS });
    ok(again.exists === true, "再载入读到文件（exists:true）");
    const e = again.data.entries[0];
    ok(!!e, "读回一条");
    eq(e.id, "af-keep", "id 往返");
    eq(e.src, "run-1", "来源 src 往返（迁移去重键的一半，不能被归一吃掉）");
    eq(e.hits, 3, "命中计数往返");
    eq(e.pinned, true, "pinned 往返");
    eq(e.createdAt, 1600000000000, "createdAt 往返");

    const norm = await call("aifact:save", {
      canvasDir: CANVAS,
      data: { cap: 99999, entries: [null, { title: "", text: "   " }, { title: "ok", text: "正文" }] },
    });
    eq(norm.data.cap, 1000, "cap 超上限夹到 1000");
    eq(norm.data.entries.length, 1, "空标题空正文的脏条目丢掉");
    const norm2 = await call("aifact:save", { canvasDir: CANVAS, data: { cap: 0 } });
    eq(norm2.data.cap, 100, "cap 非法回落默认 100");
    eq(norm2.data.entries.length, 0, "缺 entries 补空数组");
    ok(norm2.ok === true, "结构归一后照常落盘");
  }

  /* ═══════════ [3] JSON 校验失败备份 ═══════════ */
  console.log("\n[3] JSON 校验失败：先备份 .bak 再当空库");
  const CANVAS2 = path.join(BASE, "canvas2");
  const FIXED2 = fixedOf(CANVAS2);
  {
    fs.mkdirSync(path.join(CANVAS2, LIB_SEG[0], LIB_SEG[1]), { recursive: true });
    const junk = "{ 这不是 JSON，用户手改坏了 ";
    fs.writeFileSync(FIXED2, junk, "utf8");

    const r = await call("aifact:load", { canvasDir: CANVAS2 });
    ok(r.ok === true, "坏档不抛错（当空库继续）");
    eq(r.exists, false, "坏档 = 空库（exists:false）");
    eq(r.data.entries.length, 0, "坏档读不出条目");
    eq(r.backup, FIXED2 + ".bak", "备份路径 = ai-facts.json.bak");
    ok(fs.existsSync(FIXED2 + ".bak"), "备份文件真的写了");
    eq(fs.readFileSync(FIXED2 + ".bak", "utf8"), junk, "备份内容是原样字节");
    eq(fs.readFileSync(FIXED2, "utf8"), junk, "主档在只读载入时保持不动（不静默覆盖坏档）");

    const s = await call("aifact:save", { canvasDir: CANVAS2, data: { entries: [{ title: "重建", text: "写入即重写主档" }] } });
    ok(s.ok === true, "坏档之后写入成功");
    const back = JSON.parse(fs.readFileSync(FIXED2, "utf8"));
    eq(back.entries.length, 1, "主档被重写成新库");
    ok(fs.existsSync(FIXED2 + ".bak"), "重写后坏档备份仍在（没被清掉）");
  }

  /* ═══════════ [4] 迁移：旧 SQLite 长期记忆 → 固定文件 ═══════════ */
  console.log("\n[4] 迁移：mem 表全量导入 + 去重 + 删表 + 幂等");
  const CANVAS3 = path.join(BASE, "canvas3");
  const FIXED3 = fixedOf(CANVAS3);
  {
    /* 用真 longtask 通道建库（真 schema + FTS5 触发器），其中两条标题 + 来源相同 = 一批内重复 */
    await call("lt:memAdd", {
      items: [
        {
          id: "m1",
          scope: "workflow",
          ws: "",
          wf: "wf1",
          type: "fact",
          title: "端口口径",
          body: "proc_text 端口 0 = 提示词",
          src: "run-1",
          pinned: true,
          created: 1700000000000,
        },
        { id: "m2", scope: "workflow", wf: "wf1", title: "端口口径", body: "同名同来源的重复条目", src: "run-1" },
        { id: "m3", scope: "global", title: "命令入口", body: "npm run release", src: "manual" },
      ],
    });
    /* 再直插一条带显式 created / updated 的行：迁移必须原样保留这两个时间戳 */
    const Database = require("better-sqlite3");
    const db = new Database(MEM_DB);
    /* 同名同来源的两条谁留下，取决于导出顺序（longtask-store 的 exportMemAll 按 updated DESC
       给出，前到先得）——把两条重复项的 updated 显式分开，断言才不押在同一毫秒的 tie-break 上：
       m1 更新 → 它被留下，后插入的 m2 被跳过。 */
    db.prepare("UPDATE mem SET updated = 1800000000000 WHERE id = 'm1'").run();
    db.prepare("UPDATE mem SET updated = 1700000000000 WHERE id = 'm2'").run();
    db.prepare(
      `INSERT INTO mem(id,scope,ws,wf,type,title,body,tags,src,pinned,created,updated)
       VALUES(@id,@scope,'','',@type,@title,@body,'',@src,0,@created,@updated)`,
    ).run({
      id: "m4",
      scope: "global",
      type: "note",
      title: "已知坑",
      body: "WAL 下别并发写",
      src: "manual2",
      created: 1600000000000,
      updated: 1600000005000,
    });
    db.close();

    const r = await call("aifact:load", { canvasDir: CANVAS3 });
    ok(r.ok === true, "首次载入触发迁移并成功");
    ok(!!r.migration && r.migration.source === "sqlite", "回执说明数据来自旧 SQLite 记忆");
    eq(r.migration.imported, 3, "导入 3 条（同名同来源的重复条目去掉 1 条）");
    eq(r.migration.skipped, 1, "批内重复被跳过 1 条");
    eq(r.migration.dropped, true, "导入成功后删表");
    eq(r.exists, true, "迁移落盘后库已存在");
    eq(r.data.entries.length, 3, "固定文件里 3 条");

    const byTitle = (d, title) => d.entries.filter((x) => x.title === title);
    const a = byTitle(r.data, "端口口径")[0];
    ok(!!a, "标题 + 来源去重后「端口口径」只剩一条");
    eq(a.text, "proc_text 端口 0 = 提示词", "正文由 mem.body 映射到 text");
    eq(a.src, "run-1", "来源 src 保留");
    eq(a.pinned, true, "pinned 保留");
    eq(a.hits, 0, "命中计数初始化为 0");
    eq(a.lastHit, 0, "lastHit 初始化为 0");
    eq(a.createdAt, 1700000000000, "原 created 保留");
    const c = byTitle(r.data, "已知坑")[0];
    ok(!!c, "直插的那条也导入了");
    eq(c.createdAt, 1600000000000, "原 created 保留（直插行）");
    eq(c.updatedAt, 1600000005000, "原 updated 保留（直插行）");

    let onDisk = null;
    try {
      onDisk = JSON.parse(fs.readFileSync(FIXED3, "utf8"));
    } catch (e) {}
    eq(onDisk && onDisk.entries.length, 3, "迁移结果真的落到固定文件（磁盘现状）");

    ok(fs.existsSync(MEM_DB), "memory.db 文件保留作备份（没被删）");
    const chk = new Database(MEM_DB);
    const tables = chk
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mem','mem_fts')")
      .all()
      .map((x) => x.name);
    const trigs = chk.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mem_a%'").all();
    chk.close();
    eq(tables.length, 0, "mem / mem_fts 表都删掉了");
    eq(trigs.length, 0, "FTS 同步触发器也删掉了");
    const ex = exportMemAll();
    eq(ex.exists, false, "删表后导出接口如实回「没有旧数据」（迁移天然只跑一次）");

    const second = await call("aifact:load", { canvasDir: CANVAS3 });
    eq(second.migration.imported, 0, "二次载入不再导入");
    eq(second.migration.dropped, false, "二次载入无表可删");
    eq(second.data.entries.length, 3, "二次载入条目数不变（没有重复）");

    /* 幂等硬验：把同样的行重新写回 mem 表（模拟「删表没成功 / 用户回滚」），再载入一次 ——
       「标题 + 来源」去重必须兜住，一条都不能重复。 */
    await call("lt:memAdd", {
      items: [
        { id: "m1b", scope: "workflow", wf: "wf1", title: "端口口径", body: "同一条改了个说法", src: "run-1" },
        { id: "m3b", scope: "global", title: "命令入口", body: "npm run release", src: "manual" },
        { id: "m5", scope: "global", title: "新结论", body: "迁移之后新写的记忆", src: "manual3" },
      ],
    });
    const third = await call("aifact:load", { canvasDir: CANVAS3 });
    eq(third.migration.imported, 1, "重跑迁移：只有全新的那条进来");
    eq(third.migration.skipped, 2, "已存在的（标题 + 来源）跳过");
    eq(third.data.entries.length, 4, "总条数 4（无重复）");
    eq(byTitle(third.data, "端口口径").length, 1, "「端口口径」仍只有一条");
    eq(third.migration.dropped, true, "重跑后表再删一次");
  }

  /* ═══════════ [5] 渲染层链路：接口面 / 固定路径 / schema 与备份 / 计分与保护期 / 淘汰 / 工具·技能·入口 ═══════════ */
  console.log("\n[5] 渲染层（renderer/app-ai-facts.js 真跑）+ 工具·技能·入口");

  const DAY = 24 * 60 * 60 * 1000;
  const WS_R = "E:\\proj\\demo";
  const fileR = (ws) => ws + "\\团队事实库\\AI\\ai-facts.json";
  const SRC_R = read("renderer/app-ai-facts.js");
  const EX = (rel) => fs.existsSync(path.join(ROOT_DIR, ...rel.split("/")));

  /* 把渲染层模块原样搬进最小 vm 环境跑真行为（只依赖 window.api 文件桥、
     window.teamCanvasWorkspace 的画布文件夹口径、S.config.aiFacts 与 currentVisibleWf）。 */
  function factsEnv(opts) {
    const o = opts || {};
    const files = Object.assign({}, o.files || {});
    const log = [];
    const api = {
      pathJoin: function () {
        const parts = Array.prototype.slice
          .call(arguments)
          .map((x) => String(x == null ? "" : x).replace(/[\\/]+$/, ""))
          .filter((s) => s !== "");
        return parts.join("\\");
      },
      fileReadText: function (p) {
        log.push(["read", p]);
        return Promise.resolve(
          files[p] != null
            ? { ok: true, exists: true, content: files[p] }
            : { ok: true, exists: false, content: "" },
        );
      },
      fileWriteText: function (p, c) {
        log.push(["write", p]);
        files[p] = String(c);
        return Promise.resolve({ ok: true });
      },
      fileOpenDialog: function () {
        return Promise.resolve({ path: "" });
      },
      configSave: function () {
        return Promise.resolve({ ok: true });
      },
      appDirs: function () {
        return Promise.resolve({ ok: true, appPath: "", exeDir: "", dirs: [] });
      },
    };
    const S = { config: { aiFacts: { canvases: {} } }, wf: null };
    const ctx = {
      window: { api: api, teamCanvasWorkspace: (id) => (o.ws && o.ws[String(id)]) || "" },
      S: S,
      console: console,
      Date: Date,
      Math: Math,
      JSON: JSON,
      String: String,
      Number: Number,
      Array: Array,
      Object: Object,
      Promise: Promise,
      Error: Error,
      isFinite: isFinite,
      currentVisibleWf: () => S.wf,
    };
    vm.createContext(ctx);
    const API = vm.runInContext(SRC_R + "\n;window.MTNodeAIFacts;", ctx, {
      filename: "renderer/app-ai-facts.js",
    });
    return { API: API, ctx: ctx, files: files, log: log, S: S };
  }

  {
    const env = factsEnv({ ws: { c1: WS_R } });
    ok(EX("renderer/app-ai-facts.js"), "renderer/app-ai-facts.js 存在（左栏入口与工具共用的实现体）");
    ok(!!env.API && typeof env.API === "object", "顶层加载不抛错，模块已挂上 window");
    ok(env.ctx.window.MTNodeAIFacts === env.API, "window.MTNodeAIFacts 接口面已挂好");
    ok(env.ctx.window.MTNodeAiFacts === env.API, "window.MTNodeAiFacts 是同一只对象（大小写别名）");
    for (const k of [
      "pathOf",
      "load",
      "save",
      "op",
      "scoreOf",
      "countOf",
      "openDlg",
      "canvasId",
      "hit",
      "propose",
      "confirm",
      "export",
      "isProtected",
      "weightOf",
    ])
      ok(env.API && typeof env.API[k] === "function", "接口面有 " + k);
    for (const g of [
      "aiFactsPathOf",
      "aiFactsLoad",
      "aiFactsSave",
      "aiFactsOp",
      "aiFactsScoreOf",
      "aiFactsCountOf",
      "aiFactsOpenDlg",
      "aiFactsCanvasId",
    ])
      ok(typeof env.ctx.window[g] === "function", "全局别名 " + g + "（同层脚本按 typeof 取用）");

    const p = await env.API.pathOf("c1");
    eq(p && p.file, fileR(WS_R), "固定路径 = <画布文件夹>\\团队事实库\\AI\\ai-facts.json");
    eq(p && p.dir, WS_R, "落点只由画布文件夹推出（调用方给不出第二个落点）");
    has(SRC_R, 'var LIB_DIR = "团队事实库"', "固定三段写在常量里：LIB_DIR");
    has(SRC_R, 'var AI_DIR = "AI"', "固定三段写在常量里：AI_DIR");
    has(SRC_R, 'var FILE_NAME = "ai-facts.json"', "固定三段写在常量里：FILE_NAME");
    has(SRC_R, 'var BAK_SUFFIX = ".bak"', "坏档备份后缀 .bak");

    const w = await env.API.op(
      { action: "write", params: { record: { title: "端口口径", text: "proc_text 端口 0 = 提示词" } } },
      "c1",
    );
    ok(w.ok === true && w.count === 1, "写入新建一条");
    const onDisk = JSON.parse(env.files[fileR(WS_R)]);
    eq(onDisk.version, 1, "落盘 JSON 带 schema 版本字段 version:1");
    has(SRC_R, "d.version = 1", "载入归一化时把版本拉回当前 schema（1）");

    const bad = "{ 这不是 JSON，用户手改坏了 ";
    const envB = factsEnv({ ws: { c1: WS_R }, files: { [fileR(WS_R)]: bad } });
    const rb = await envB.API.load("c1");
    ok(rb.ok === true && rb.exists === false && rb.data.entries.length === 0, "坏档当空库（不抛、不阻塞）");
    eq(rb.backup, fileR(WS_R) + ".bak", "坏档备份路径 = ai-facts.json.bak");
    eq(envB.files[rb.backup], bad, "备份内容是原样字节");
    eq(envB.files[fileR(WS_R)], bad, "只读载入不改写主档（等首次写入才重写）");
    const envB2 = factsEnv({ ws: { c1: WS_R }, files: { [fileR(WS_R)]: "[1,2,3]" } });
    const rb2 = await envB2.API.load("c1");
    ok(
      rb2.exists === false && rb2.backup === fileR(WS_R) + ".bak",
      "JSON 合法但不是对象（数组）也算坏档 → 备份 + 空库",
    );
  }

  {
    const env = factsEnv({ ws: { c1: WS_R } });
    const now = Date.now();
    eq(env.API.scoreOf({ hits: 1, lastHit: now }), 1, "Hit 计分：读 1 次、刚命中 = 1.0");
    eq(env.API.scoreOf({ hits: 2, lastHit: now - DAY }), 1, "读 2 次、隔 1 天 = 2/2 = 1.0");
    eq(env.API.scoreOf({ hits: 1, lastHit: now - 7 * DAY }), 0.1, "读 1 次、隔 7 天 = 1/8 ≈ 0.1");
    eq(
      env.API.scoreOf({ hits: 4, lastHit: 0, updatedAt: 0, createdAt: 0 }),
      4,
      "没有时间基准按 0 天算（不编造时间）",
    );
    eq(env.API.weightOf({ hit: 0.5, hits: 0 }), 0.5, "写 +0.5 的计分权重记在 hit 上");
    has(SRC_R, "hit / (1 + 距上次命中天数)", "公式写在源码里：score = hit / (1 + 距上次命中天数)（线性衰减）");

    await env.API.op({ action: "write", params: { record: { title: "新条例", text: "x" } } }, "c1");
    const e = JSON.parse(env.files[fileR(WS_R)]).entries[0];
    eq(e.hits, 0, "新建条目 hits = 0（hits 只数「被查阅的次数」）");
    eq(e.hit, 0.5, "新建条目 hit = 0.5（写一次 +0.5）");
    eq(e.protectionUntil - e.createdAt, 7 * DAY, "7 天保护期：protectionUntil = createdAt + 7 天");
    ok(env.API.isProtected(e) === true, "零命中的新条目在保护期内不参与淘汰");
    ok(
      env.API.isProtected({ hits: 1, protectionUntil: Date.now() + DAY }) === false,
      "已被查阅过的条目不受保护期保护",
    );
    ok(env.API.isProtected({ hits: 0, protectionUntil: Date.now() - DAY }) === false, "保护期一过就不再豁免");
  }

  {
    /* 101 条既有 + 1 条新写 → 超出默认硬上限 100 → 淘汰分数最低的两条 */
    const now = Date.now();
    const seeded = { version: 1, cap: 100, entries: [] };
    for (let i = 0; i < 101; i++)
      seeded.entries.push({ id: "t" + i, title: "条 " + i, text: "x", hits: 1, hit: 1, lastHit: now - i * DAY });
    const env = factsEnv({ ws: { c1: WS_R }, files: { [fileR(WS_R)]: JSON.stringify(seeded) } });
    const w = await env.API.op({ action: "write", params: { record: { title: "新条", text: "y" } } }, "c1");
    eq(w.cap, 100, "默认硬上限 cap = 100（每张画布一份，写进文件）");
    eq(w.count, 100, "> 100 条 → 削回 100 条");
    eq(w.evicted.length, 2, "超额 2 条被淘汰（回执列出）");
    eq(w.evicted.map((x) => x.id).sort().join(","), "t100,t99", "淘汰的正是分数最低的两条（久未查的）");
    ok(
      w.evicted.every((x) => typeof x.score === "number"),
      "淘汰回执带分数（界面与模型看得到为什么轮到它）",
    );
    const kept = JSON.parse(env.files[fileR(WS_R)]).entries.map((x) => x.id);
    eq(kept.length, 100, "落盘也是 100 条");
    ok(kept.indexOf("t100") < 0 && kept.indexOf("t0") >= 0, "低分的走、最高分的留");

    /* pinned 永不淘汰：cap=2、一条 pin + 一条高分 + 一条低分，写一次触发淘汰 */
    const envP = factsEnv({
      ws: { c1: WS_R },
      files: {
        [fileR(WS_R)]: JSON.stringify({
          version: 1,
          cap: 2,
          entries: [
            { id: "pin", title: "固定", text: "x", hits: 0, pinned: true, lastHit: 0 },
            { id: "low", title: "久未查", text: "x", hits: 1, hit: 1, lastHit: now - 60 * DAY },
            { id: "high", title: "常查", text: "x", hits: 9, hit: 9, lastHit: now },
          ],
        }),
      },
    });
    const wp = await envP.API.op({ action: "write", params: { record: { title: "常查", text: "x2" } } }, "c1");
    eq(wp.count, 2, "upsert 后仍是 3 条 → 削到 cap 2");
    eq(wp.evicted.map((x) => x.id).join(","), "low", "淘汰分数最低的未 pin 条目");
    const keptP = JSON.parse(envP.files[fileR(WS_R)]).entries.map((x) => x.id);
    ok(
      keptP.indexOf("pin") >= 0 && keptP.indexOf("high") >= 0 && keptP.indexOf("low") < 0,
      "pinned 留下、常查的留下、久未查的走",
    );

    await envP.API.save("c1", { cap: 99999, entries: [] });
    eq(JSON.parse(envP.files[fileR(WS_R)]).cap, 1000, "cap 手打 1e9 → 夹到硬上限 1000（不让淘汰清空库）");
    await envP.API.save("c1", { cap: 0, entries: [] });
    eq(JSON.parse(envP.files[fileR(WS_R)]).cap, 100, "cap 非法 → 回落默认 100");
  }

  {
    /* ── 工具 mtnode_facts（接棒 lt_memory） ── */
    const PLUG = read("dsh/gateway/ai-facts-plugin.mjs");
    ok(/name:\s*'mtnode_facts'/.test(PLUG), "ai-facts-plugin.mjs 注册工具 mtnode_facts");
    const mm = PLUG.match(/enum:\s*\[([^\]]*)\]/);
    ok(!!mm, "工具参数表里有动作枚举");
    const acts = (mm ? mm[1] : "")
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    eq(acts.join("/"), "list/query/get/write/delete/pin", "动作面 = list/query/get/write/delete/pin");
    ok(/t:\s*'facts'/.test(PLUG) && PLUG.indexOf("facts-result") > 0, "插件走 t:'facts' → facts-result 帧");
    has(SRC_R, 'action === "query"', "宿主实现有 query 分支（工具动作真落到同一个 op）");
    has(SRC_R, "当前没有绑定画布", "无绑定画布的唯一错误文本（工具拒绝，会话不中断）");
    const DB = read("renderer/app-db.js");
    has(DB, 'msg.type === "facts"', "宿主分派 facts 帧");
    has(DB, "handleAiFactsToolEvent", "宿主 facts 处理器（按本轮绑定画布读写）");
    has(DB, 'kind: "facts"', "回执 kind:'facts'");
    ok(/m\.t !== 'facts'/.test(read("dsh/gateway/gateway.mjs")), "gateway 桥帧白名单收了 facts");

    /* ── lt_memory 已彻底移除：网关 / 桥帧 / 词条 ── */
    const TVv = read("dsh/gateway/tool-visibility.mjs");
    const hb = TVv.match(/HIDEABLE_TOOLS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
    ok(!!hb, "读到 HIDEABLE_TOOLS 可裁名单");
    ok(
      !!hb && hb[1].indexOf("'lt_memory'") < 0 && hb[1].indexOf('"lt_memory"') < 0,
      "HIDEABLE_TOOLS 不再列 lt_memory（工具已下线，名字整只摘掉）",
    );
    const gwFiles = fs.readdirSync(path.join(ROOT_DIR, "dsh", "gateway")).filter((n) => /\.mjs$/.test(n));
    ok(gwFiles.length >= 8, "网关目录可枚举（" + gwFiles.length + " 只 .mjs）");
    eq(
      gwFiles.filter((n) => /name:\s*['"]lt_memory['"]/.test(read("dsh/gateway/" + n))).length,
      0,
      "网关插件里没有任何一只还注册 lt_memory 工具",
    );
    const CORD = read("dsh/gateway/cordis.yml");
    ok(
      CORD.indexOf("lt-memory") < 0 && CORD.indexOf("lt_memory-plugin") < 0,
      "cordis.yml 不再挂载长期记忆插件（也没有相应的模块名）",
    );
    has(DB, 'msg.type === "lt"', "桥帧 lt 还在（lt_state 用）");
    ok(
      DB.indexOf("'lt_memory'") < 0 && DB.indexOf('"lt_memory"') < 0,
      "app-db.js 的工具名单 / 桥帧里没有 lt_memory 这个名字",
    );
    ok(
      read("renderer/app-longtask.js").indexOf("'lt_memory'") < 0 &&
        read("renderer/app-longtask.js").indexOf('"lt_memory"') < 0,
      "app-longtask.js 不再声明 lt_memory 工具",
    );
    ok(read("renderer/i18n.js").indexOf("lt_memory") < 0, "i18n 词条里没有 lt_memory（不再有可调用的词条）");
    const mentions = [];
    for (const n of gwFiles)
      read("dsh/gateway/" + n)
        .split(/\r?\n/)
        .forEach((L, i) => {
          if (L.indexOf("lt_memory") >= 0) mentions.push(n + ":" + (i + 1) + "  " + L.trim());
        });
    CORD.split(/\r?\n/).forEach((L, i) => {
      if (L.indexOf("lt_memory") >= 0) mentions.push("cordis.yml:" + (i + 1) + "  " + L.trim());
    });
    const stray = mentions.filter((L) => !/已下线|GONE|下线/.test(L));
    ok(
      stray.length === 0,
      "网关里剩下的 lt_memory 提及都是「已下线」说明" +
        (stray.length ? "（还有 " + stray.length + " 处现行口径：" + stray[0].slice(0, 70) + "）" : ""),
    );
    has(PLUG, "mtnode_facts", "长期记忆沉淀改走 mtnode_facts（AI 事实库）");

    /* ── 技能 mtnode-ai-facts 与索引 ── */
    ok(EX("mtnode-agent-skills/mtnode/ai-facts/SKILL.md"), "技能 mtnode-ai-facts 的 SKILL.md 存在");
    const SK = read("mtnode-agent-skills/mtnode/ai-facts/SKILL.md");
    ok(/^---[\s\S]*name:\s*mtnode-ai-facts/.test(SK), "SKILL.md frontmatter name: mtnode-ai-facts");
    ok(/Use when/i.test(SK), "frontmatter 有英文 Use when（模型按关键词命中）");
    let idx = null;
    try {
      idx = JSON.parse(read("mtnode-agent-skills/index.json"));
    } catch (e) {}
    ok(!!idx, "技能索引 index.json 可解析");
    const flat = JSON.stringify(idx || {});
    ok(
      flat.indexOf('"mtnode-ai-facts"') > 0 && flat.indexOf("mtnode/ai-facts/SKILL.md") > 0,
      "索引收录 mtnode-ai-facts → mtnode/ai-facts/SKILL.md",
    );
    has(read("mtnode-agent-skills/INDEX.md"), "mtnode-ai-facts", "INDEX.md 收录 mtnode-ai-facts");
    has(read("dsh/gateway/gateway.mjs"), "mtnode-ai-facts", "预设系统提示的技能名单含 mtnode-ai-facts");

    /* ── 入口按钮（专家团左栏那一行） ── */
    const HTML = read("renderer/index.html");
    has(HTML, '<script src="app-ai-facts.js"></script>', "index.html 引入 app-ai-facts.js");
    has(HTML, "css/ai-facts.css", "index.html 引入 ai-facts.css");
    ok(EX("renderer/css/ai-facts.css"), "css/ai-facts.css 存在");
    const TVIEW = read("renderer/app-teamview.js");
    has(TVIEW, "team-side-ai-fact", "专家团左栏有 AI 事实库入口行（.team-side-ai-fact）");
    has(TVIEW, "teamViewAiFactRow(canvasId)", "入口行渲染在其分组末尾");
    has(TVIEW, "aiFactsOpenDlg(", "点这一行开查阅弹窗");
    has(read("renderer/i18n.js"), '"AI 事实库":', "i18n 有「AI 事实库」入口文案（中英成对）");
  }

  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch (e) {}

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
})().catch((e) => {
  console.log("FAIL  未捕获异常：" + ((e && e.stack) || e));
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch (x) {}
});

/* ==================== 已并入：test/smoke-ai-facts-renderer.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-ai-facts-renderer.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) =>
    fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
  const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

  const SRC = read("renderer/app-ai-facts.js");
  const DAY = 24 * 60 * 60 * 1000;
  const WS = "E:\\proj\\demo";
  const fileOf = (ws) => ws + "\\团队事实库\\AI\\ai-facts.json";

  /* ═══════════ vm 沙箱：把渲染层模块原样搬进最小环境跑真行为 ═══════════
     app-ai-facts.js 只依赖 window.api（主进程白名单桥）、window.teamCanvasWorkspace
     （app-team.js factWorkspace 的画布文件夹口径）、S.config（配置命名空间）与
     currentVisibleWf（当前绑定画布）；弹窗相关函数在装载期一律不执行。 */
  function makeEnv(opts) {
    const o = opts || {};
    const files = Object.assign({}, o.files || {});
    const log = [];
    const api = {
      pathJoin: function () {
        const parts = Array.prototype.slice
          .call(arguments)
          .map((x) => String(x == null ? "" : x).replace(/[\\/]+$/, ""))
          .filter((s) => s !== "");
        return parts.join("\\");
      },
      fileReadText: function (p) {
        log.push(["read", p]);
        return Promise.resolve(
          files[p] != null
            ? { ok: true, exists: true, content: files[p] }
            : { ok: true, exists: false, content: "" },
        );
      },
      fileWriteText: function (p, c) {
        log.push(["write", p]);
        files[p] = String(c);
        return Promise.resolve({ ok: true });
      },
      fileOpenDialog: function () {
        log.push(["pick"]);
        return Promise.resolve({ path: o.pick || "" });
      },
      configSave: function () {
        log.push(["cfg"]);
        return Promise.resolve({ ok: true });
      },
      /* 应用目录：团队事实库的守卫就是拿它判「落点在应用内」——AI 库豁免，这里给出以便反证。 */
      appDirs: function () {
        return Promise.resolve({ ok: true, appPath: WS, exeDir: WS, dirs: [] });
      },
    };
    const S = {
      config: { aiFacts: { canvases: {} } },
      wf: o.wf === undefined ? null : o.wf,
    };
    const ctx = {
      window: {
        api: api,
        I18n: undefined,
        teamCanvasWorkspace: (id) => (o.ws && o.ws[String(id)]) || "",
      },
      S: S,
      console: console,
      Date: Date,
      Math: Math,
      JSON: JSON,
      String: String,
      Number: Number,
      Array: Array,
      Object: Object,
      Promise: Promise,
      Error: Error,
      isFinite: isFinite,
      currentVisibleWf: () => S.wf,
    };
    vm.createContext(ctx);
    const API = vm.runInContext(SRC + "\n;window.MTNodeAiFacts;", ctx, {
      filename: "renderer/app-ai-facts.js",
    });
    return { API: API, ctx: ctx, files: files, log: log, S: S };
  }

  async function main() {
    console.log("\n[1] 模块装载与导出（renderer/app-ai-facts.js）");
    const env = makeEnv({ ws: { c1: WS } });
    ok(!!env.API && typeof env.API === "object", "顶层加载不抛错，window.MTNodeAiFacts 已挂好");
    for (const k of ["pathOf", "load", "save", "op", "scoreOf", "countOf", "openDlg", "canvasId"])
      ok(env.API && typeof env.API[k] === "function", "导出接口 " + k);
    for (const g of [
      "aiFactsPathOf",
      "aiFactsLoad",
      "aiFactsSave",
      "aiFactsOp",
      "aiFactsScoreOf",
      "aiFactsCountOf",
      "aiFactsOpenDlg",
      "aiFactsCanvasId",
    ])
      ok(typeof env.ctx.window[g] === "function", "全局别名 " + g + "（同层脚本按 typeof 取用）");

    console.log("\n[2] 落点固定路径 + 推导成功即登记配置");
    const p1 = await env.API.pathOf("c1");
    ok(p1 && p1.file === fileOf(WS), "固定路径 = <画布文件夹>\\团队事实库\\AI\\ai-facts.json");
    ok(p1 && p1.dir === WS && p1.fromWorkspace === true, "画布文件夹取自 teamCanvasWorkspace（顶栏工作目录口径）");
    ok(
      env.S.config.aiFacts.canvases.c1 && env.S.config.aiFacts.canvases.c1.dir === WS,
      "推导成功即把画布文件夹登记进 S.config.aiFacts.canvases（重建识别的前提）",
    );
    const cfgLog = env.log.filter((x) => x[0] === "cfg").length;
    await env.API.pathOf("c1");
    ok(
      env.log.filter((x) => x[0] === "cfg").length === cfgLog,
      "配置值没变就不再写盘（切画布 / 反复载入不刷配置）",
    );

    console.log("\n[3] 落点豁免（AI 库不进团队事实库的落点守卫）");
    ok(
      !/\bisInAppDir\s*\(/.test(SRC) && !/\bmisplacedReason\s*\(/.test(SRC),
      "app-ai-facts.js 不调用 misplacedReason / isInAppDir（只在注释里点名它并说明豁免）",
    );
    const envApp = makeEnv({ ws: { c1: "E:\\dev\\tools\\pipeline-console" } });
    const pApp = await envApp.API.pathOf("c1");
    ok(
      pApp && pApp.file === fileOf("E:\\dev\\tools\\pipeline-console"),
      "画布文件夹在应用目录内时仍返回路径（豁免共识；appDirs 给出的就是它）",
    );
    ok(SRC.indexOf("落点豁免") > 0, "文件头写明豁免共识与理由");

    console.log("\n[4] 画布删除后在同一路径重建 → 立刻载入（无弹窗）");
    const seeded = {
      version: 1,
      cap: 100,
      entries: [
        {
          id: "af-old-1",
          title: "模块划分",
          text: "三块：外壳 / 渲染层 / dsh",
          hits: 3,
          lastHit: Date.now(),
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    const env4 = makeEnv({ ws: { cNEW: WS }, files: { [fileOf(WS)]: JSON.stringify(seeded) } });
    const r4 = await env4.API.load("cNEW");
    ok(r4.ok === true && r4.exists === true && r4.data.entries.length === 1, "新画布 id 命中固定路径即载入已有库");
    ok(r4.data.entries[0].title === "模块划分", "载入的是磁盘上那一份（不是空库）");
    ok(
      env4.S.config.aiFacts.canvases.cNEW && env4.S.config.aiFacts.canvases.cNEW.dir === WS,
      "重建载入时自动登记画布文件夹（用户什么都没点）",
    );
    ok(env4.log.filter((x) => x[0] === "pick").length === 0, "重建载入全程不弹目录选择");

    console.log("\n[5] 无绑定画布 / 无画布文件夹的兜底");
    const env5 = makeEnv({});
    let err5 = "";
    try {
      await env5.API.op({ action: "list" }, "");
    } catch (e) {
      err5 = String((e && e.message) || e);
    }
    ok(err5.indexOf("当前没有绑定画布") >= 0, "无绑定画布：工具侧拒绝并给出唯一错误文本");
    const l5 = await env5.API.load("");
    ok(l5.ok === false && !!l5.error && l5.data.entries.length === 0, "load 无画布：ok:false + 错误文本 + 空库");
    const ps5 = await env5.API.pathOf("c1", { silent: true });
    ok(ps5 === null, "没有画布文件夹且 silent：不弹目录选择，返回 null");
    ok(env5.log.filter((x) => x[0] === "pick").length === 0, "silent 路径解析绝不弹窗");
    const env5b = makeEnv({ pick: "E:\\picked" });
    const p5b = await env5b.API.pathOf("c1");
    ok(p5b && p5b.picked === true && p5b.dir === "E:\\picked", "没有画布文件夹：弹目录选择让用户为这张画布选一个");
    ok(env5b.S.config.aiFacts.canvases.c1.dir === "E:\\picked", "选定结果写进配置（此后跟着画布走）");
    const env5c = makeEnv({ pick: "" });
    ok((await env5c.API.pathOf("c1")) === null, "用户取消目录选择 → 库不可用（不猜落点、不回落全局库）");

    console.log("\n[6] 写入语义（新建 / 同标题 upsert / 脏项）");
    const env6 = makeEnv({ ws: { c1: WS } });
    const w1 = await env6.API.op(
      { action: "write", params: { records: [{ title: "关键路径", text: "主进程 main.js；渲染层 renderer/" }] } },
      "c1",
    );
    ok(w1.ok === true && w1.count === 1 && w1.written[0].updated === false, "write 新建一条");
    const parsed6 = JSON.parse(env6.files[fileOf(WS)]);
    ok(
      parsed6.version === 1 && parsed6.cap === 100 && parsed6.entries.length === 1,
      "落盘 JSON 形状：version / cap / entries",
    );
    ok(parsed6.entries[0].id.indexOf("af-") === 0, "新建条目的 id 形如 af-…");
    const w2 = await env6.API.op(
      { action: "write", params: { record: { title: "  关键路径 ", text: "主进程 main.js + preload.js" } } },
      "c1",
    );
    ok(w2.count === 1 && w2.written[0].updated === true, "同标题（trim / 折叠空白 / 小写归一化）＝更新原条，不新增");
    const l6 = await env6.API.op({ action: "list" }, "c1");
    ok(l6.entries.length === 1 && l6.entries[0].text.indexOf("preload.js") > 0, "更新换掉了正文");
    let err6 = "";
    try {
      await env6.API.op({ action: "write", params: { record: { title: "", text: "   " } } }, "c1");
    } catch (e) {
      err6 = String((e && e.message) || e);
    }
    ok(!!err6, "标题与正文都为空：直接报错（不产生脏条目）");
    let err6b = "";
    try {
      await env6.API.op({ action: "nope" }, "c1");
    } catch (e) {
      err6b = String((e && e.message) || e);
    }
    ok(err6b.indexOf("未知动作") >= 0, "未知动作报错");

    console.log("\n[7] 命中计数：只有 query / get 命中才算，list 不算");
    const q7 = await env6.API.op({ action: "query", params: { q: "主进程" } }, "c1");
    ok(q7.found === 1 && q7.count === 1 && q7.entries[0].hits === 1, "query 命中：hits + 1");
    ok(typeof q7.entries[0].score === "number", "query 回执带分数（常被索引的先给）");
    const l7 = await env6.API.op({ action: "list" }, "c1");
    ok(l7.entries[0].hits === 1, "list 列全部：不计数");
    const id7 = q7.entries[0].id;
    const g7 = await env6.API.op({ action: "get", params: { id: id7 } }, "c1");
    ok(g7.record.hits === 2 && typeof g7.record.createdAt === "number", "get 命中：hits + 1，回执带全字段");
    const l7b = await env6.API.op({ action: "list" }, "c1");
    ok(l7b.entries[0].hits === 2, "两次命中累计到磁盘");
    const q7b = await env6.API.op({ action: "query", params: { q: "根本没有的词" } }, "c1");
    ok(q7b.found === 0 && q7b.entries.length === 0, "查不到：found 0 + 空数组（调用方据此说「库里没有」）");
    let err7 = "";
    try {
      await env6.API.op({ action: "get", params: { id: "af-不存在" } }, "c1");
    } catch (e) {
      err7 = String((e && e.message) || e);
    }
    ok(err7.indexOf("没有该条例") >= 0, "get 不存在的 id 报错");

    console.log("\n[8] 分数（score = hit / (1 + 距上次命中天数)）与淘汰（pin 永不淘汰）");
    ok(env6.API.scoreOf({ hits: 1, lastHit: Date.now() }) === 1, "刚命中一次 = 1.0");
    ok(
      env6.API.scoreOf({ hits: 1, lastHit: Date.now() - 30 * DAY }) === 0,
      "30 天没查 = 1/31 ≈ 0（线性衰减，不设半衰期）",
    );
    ok(env6.API.scoreOf({ hits: 4, lastHit: 0, updatedAt: 0, createdAt: 0 }) === 4, "没有时间基准时按 0 天算（不编造时间）");
    const now8 = Date.now();
    const capFiles = {
      [fileOf(WS)]: JSON.stringify({
        version: 1,
        cap: 3,
        entries: [
          { id: "e1", title: "常查", text: "x", hits: 9, lastHit: now8, pinned: false },
          { id: "e2", title: "少查", text: "x", hits: 1, lastHit: now8, pinned: false },
          { id: "e3", title: "久未查", text: "x", hits: 1, lastHit: now8 - 90 * DAY, pinned: false },
          { id: "e4", title: "固定", text: "x", hits: 0, lastHit: 0, pinned: true },
        ],
      }),
    };
    const env8 = makeEnv({ ws: { c1: WS }, files: Object.assign({}, capFiles) });
    const w8 = await env8.API.op({ action: "write", params: { record: { title: "新条", text: "x" } } }, "c1");
    ok(w8.count === 3 && w8.cap === 3, "写入后超出上限 → 削到 cap");
    ok(w8.evicted.length === 2, "淘汰条数 = 超额数（回执列出被淘汰的）");
    const kept8 = JSON.parse(env8.files[fileOf(WS)]).entries.map((e) => e.id);
    ok(kept8.indexOf("e4") >= 0, "pinned 的永不淘汰");
    ok(kept8.indexOf("e1") >= 0, "分数最高的常查条目留下");
    ok(kept8.indexOf("e3") < 0, "分数最低（久未查）的先走");
    ok(w8.evicted.some((e) => e.id === "e3"), "淘汰回执点名了被淘汰的条目");
    const env8b = makeEnv({
      ws: { c1: WS },
      files: {
        [fileOf(WS)]: JSON.stringify({
          version: 1,
          cap: 1,
          entries: [
            { id: "p", title: "固定", text: "x", hits: 0, pinned: true },
            { id: "f", title: "自由", text: "x", hits: 5, lastHit: now8, pinned: false },
          ],
        }),
      },
    });
    const w8b = await env8b.API.op({ action: "write", params: { record: { title: "再来", text: "y" } } }, "c1");
    ok(w8b.overflow === true && w8b.evicted.length === 0 && w8b.count === 3, "pinned 已占满上限：保留超额、不再淘汰");
    ok(String(w8b.note).length > 0, "overflow 回执带一句说明（模型据此知道为什么还超）");
    const env8c = makeEnv({ ws: { c1: WS } });
    await env8c.API.op({ action: "write", params: { record: { title: "a", text: "a" } } }, "c1");
    const l8c = await env8c.API.op({ action: "list" }, "c1");
    const pid8 = l8c.entries[0].id;
    const pin8 = await env8c.API.op({ action: "pin", params: { ids: [pid8] } }, "c1");
    ok(pin8.ok === true && pin8.pinned === 1, "pin 动作（默认保护）");
    const l8d = await env8c.API.op({ action: "list" }, "c1");
    ok(l8d.entries[0].pinned === true, "pin 落盘");
    const pin8b = await env8c.API.op({ action: "pin", params: { id: pid8, on: false } }, "c1");
    const l8e = await env8c.API.op({ action: "list" }, "c1");
    ok(pin8b.ok === true && l8e.entries[0].pinned === false, "pin on:false 取消保护（单个 id 也认）");
    const del8 = await env8c.API.op({ action: "delete", params: { ids: [pid8] } }, "c1");
    ok(del8.deleted === 1 && del8.count === 0, "delete 按 id 删除");

    console.log("\n[9] 坏档保护：备份 .bak 再当空库");
    const badRaw = "{ 这不是 json";
    const env9 = makeEnv({ ws: { c1: WS }, files: { [fileOf(WS)]: badRaw } });
    const r9 = await env9.API.load("c1");
    ok(r9.ok === true && r9.exists === false && r9.data.entries.length === 0, "解析失败当空库（不抛、不阻塞）");
    ok(r9.backup === fileOf(WS) + ".bak" && env9.files[r9.backup] === badRaw, "坏档原样备份成 ai-facts.json.bak");
    ok(env9.files[fileOf(WS)] === badRaw, "坏档本身不被改写（等首次写入才重写）");

    console.log("\n[10] 帧路由与网关契约（工具 mtnode_facts）");
    const DB = read("renderer/app-db.js");
    ok(
      DB.indexOf('msg.type === "facts"') > 0 && DB.indexOf("handleAiFactsToolEvent(msg.data || {}, boundWf)") > 0,
      "app-db.js：facts 帧有独立分派（与 db / tool-run 同一口径）",
    );
    ok(
      DB.indexOf('kind: "facts"') > 0 && DB.indexOf("window.MTNodeAiFacts") > 0,
      "app-db.js：宿主按本轮绑定画布调 MTNodeAiFacts.op 并回 kind:'facts'",
    );
    ok(DB.indexOf("当前没有绑定画布") > 0, "app-db.js：无绑定画布回错误文本（会话不中断）");
    const GW = read("dsh/gateway/gateway.mjs");
    ok(/m\.t !== 'facts'/.test(GW), "gateway.mjs：桥接帧白名单收了 facts");
    ok(
      /p\.kind === 'facts'/.test(GW) && /t: 'facts-result'/.test(GW),
      "gateway.mjs：interact kind:'facts' → facts-result（与 db 同形状）",
    );
    const PLUG = read("dsh/gateway/ai-facts-plugin.mjs");
    ok(/name: 'mtnode_facts'/.test(PLUG), "ai-facts-plugin.mjs 注册工具 mtnode_facts");
    ok(
      /enum:\s*\[\s*'list',\s*'query',\s*'get',\s*'write',\s*'delete',\s*'pin'\s*\]/.test(PLUG),
      "动作枚举 list / query / get / write / delete / pin",
    );
    ok(/t: 'facts'/.test(PLUG) && /t === 'facts-result'/.test(PLUG), "插件走 t:'facts' → facts-result 帧");
    ok(PLUG.indexOf("MTNODE_BRIDGE_PORT") > 0 && PLUG.indexOf("exec.agent.id") > 0, "走同一条桥 + 归属盖章（sessionId）");
    ok(PLUG.length < 20000, "工具定义紧凑（每步都随固定前缀重发）");
    /* 共识是「所有会话默认可见」：名字若留在 HIDEABLE_TOOLS 里只是允许将来按运行裁剪，
       关键是宿主**没有任何 hide 名单点名它**（点了 = 某档运行里它整个不存在）。 */
    const dropLists = DB.match(/DSH_TOOLS_DROPPED_BY_[A-Z_]+\s*=\s*\[[^\]]*\]/g) || [];
    ok(dropLists.length > 0, "找到 app-db.js 的按运行裁剪名单（" + dropLists.length + " 份）");
    ok(
      dropLists.every((s) => s.indexOf("mtnode_facts") < 0),
      "app-db.js 的 hideTools 名单不点名 mtnode_facts（默认全程可见）",
    );
    ok(
      read("renderer/app-nodes.js").indexOf("mtnode_facts") < 0,
      "app-nodes.js 的工具许可映射不牵涉 mtnode_facts（不新增许可开关）",
    );
    const CORDIS = read("dsh/gateway/cordis.yml");
    ok(
      CORDIS.indexOf("mtnode-ai-facts") > 0 && CORDIS.indexOf("./ai-facts-plugin.mjs") > 0,
      "cordis.yml 挂载 mtnode-ai-facts（disabled 与相邻 MTNode 插件同表达式）",
    );
    const TV = read("dsh/gateway/tool-visibility.mjs");
    ok(
      /HIDEABLE_TOOLS[\s\S]*mtnode_facts/.test(TV) || TV.indexOf("mtnode_facts") < 0,
      "网关白名单里的名字都合法（mtnode_facts 若在可裁名单内也只是「允许裁」，不影响默认可见）",
    );
    ok(read("dsh/DESIGN.md").indexOf("'facts'") > 0, "dsh/DESIGN.md 本地协议表补了 facts 帧");

    console.log("\n[11] 技能 / 索引 / 预设同步");
    const SK = read("mtnode-agent-skills/mtnode/ai-facts/SKILL.md");
    ok(/^---[\s\S]*name:\s*mtnode-ai-facts/.test(SK), "SKILL.md frontmatter name: mtnode-ai-facts");
    ok(SK.indexOf("title:") > 0 && /Use when/i.test(SK), "frontmatter 有 title 与英文 Use when（模型按关键词命中）");
    ok(SK.length > 800, "正文写了完整规范（沉淀时机 / 先查再写 / 冲突口径 / 库不可用）");
    const IDX = read("mtnode-agent-skills/index.json");
    ok(IDX.indexOf("mtnode-ai-facts") > 0 && IDX.indexOf("mtnode/ai-facts/SKILL.md") > 0, "技能索引含 mtnode-ai-facts");
    ok(read("mtnode-agent-skills/INDEX.md").indexOf("mtnode-ai-facts") > 0, "INDEX.md 含 mtnode-ai-facts");
    ok(GW.indexOf("mtnode-ai-facts") > 0, "预设系统提示的技能名单补了 mtnode-ai-facts");
    for (const f of [
      "mtnode-agent-skills/mtnode/dev-architect/SKILL.md",
      "mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md",
    ])
      ok(read(f).indexOf("mtnode-ai-facts") > 0, f + " 有一句指向 mtnode-ai-facts（规范只写在技能一处）");
    ok(
      read("renderer/app-assist.js").indexOf("mtnode-ai-facts") > 0,
      "助手技能名单 / 分类表收录了 mtnode-ai-facts",
    );

    console.log("\n[12] 界面接入与 i18n 中英成对");
    const HTML = read("renderer/index.html");
    ok(HTML.indexOf('<script src="app-ai-facts.js"></script>') > 0, "index.html 引入 app-ai-facts.js");
    ok(
      HTML.indexOf("css/ai-facts.css") > 0 && exists("renderer/css/ai-facts.css"),
      "index.html 引入 css/ai-facts.css 且文件存在",
    );
    ok(
      HTML.indexOf('<script src="app-factlib.js">') < HTML.indexOf('<script src="app-ai-facts.js">'),
      "脚本分层：app-factlib.js 之后挂 app-ai-facts.js（同层相邻）",
    );
    const TVIEW = read("renderer/app-teamview.js");
    ok(TVIEW.indexOf("team-side-ai-fact") > 0, "专家团左栏事实库分组里有 AI 事实库行");
    ok(TVIEW.indexOf("teamViewAiFactRow(canvasId)") > 0, "入口行挂在分组末尾（一般库行 / 文档行顺序未动）");
    ok(TVIEW.indexOf("aiFactsOpenDlg(") > 0, "点这一行开查阅弹窗");
    ok(TVIEW.indexOf("typeof aiFactsCountOf") > 0, "按调用期 typeof 取用（不依赖脚本装载顺序）");
    ok(
      SRC.indexOf("openOverlay(") > 0 && SRC.indexOf("closeOverlay(") > 0,
      "查阅弹窗走 app.js 的 openOverlay（persistent、可最小化）",
    );
    ok(
      !/document\.addEventListener\(\s*["'](mousedown|click)["']/.test(SRC) &&
        !/window\.addEventListener\(\s*["'](mousedown|click)["']/.test(SRC),
      "弹窗不挂「点外部即关」式监听（带输入的浮层必须 persistent）",
    );
    /* i18n 成对：app-ai-facts.js 全部文案 + app-db.js 那两条 facts 文案（app-db.js 其余文案
       属于既有模块，本轮不动也不替它背 i18n 账） */
    const I18N = read("renderer/i18n.js");
    const ZH = [];
    const pushT = (src) => {
      const re = /\b(?:T|I18n\.t)\(\s*"((?:[^"\\]|\\.)*)"/g;
      let m;
      while ((m = re.exec(src))) if (ZH.indexOf(m[1]) < 0) ZH.push(m[1]);
    };
    pushT(SRC);
    ZH.push("当前没有绑定画布", "AI 事实库模块未就绪（app-ai-facts.js）");
    ok(ZH.length > 20, "从源码里刮出 " + ZH.length + " 条本模块用户可见中文串");
    const miss = ZH.filter((s) => I18N.indexOf('"' + s + '":') < 0);
    ok(miss.length === 0, "新词条中英成对" + (miss.length ? "（缺：" + miss.slice(0, 5).join(" / ") + "）" : ""));

    console.log(
      "\n" + (fails ? "FAILED " + fails + "/" + checks : "SMOKE-AI-FACTS-RENDERER OK（" + checks + " 项）"),
    );
  }

  main().catch((e) => {
    console.log("FAIL  测试自身异常：" + ((e && e.stack) || e));
  });
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-ai-facts-renderer.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-ai-facts-renderer.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

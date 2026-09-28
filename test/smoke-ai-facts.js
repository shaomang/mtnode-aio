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
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
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
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log("FAIL  未捕获异常：" + ((e && e.stack) || e));
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch (x) {}
  process.exit(1);
});

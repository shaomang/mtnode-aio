"use strict";
/* test/smoke-workspace-stale-session.js — 「失效的会话工作目录一直留在盘上」回归（本次需求）
 *
 * 现场（真机）：应用开发根从 E:\mtnode\apps\test 换成 E:\mtnode\apps\dev 之后，两条开发会话
 * 仍记着旧路径（会话文件顶层 workspace + index.json 的同一个键）。启动体检每次都弹
 * 「工作目录无效 … 已自动清空」，但下次启动照旧 —— 因为体检只改内存：
 *   · sanitizeInvalidWorkspaces 只调 scheduleSave()（画布）与 configSave()（config.json），
 *     从不撮会话落盘；
 *   · 会话落盘（agentWriteAgentSessions → saveSessions）只送「脏的或正文已读回的」会话，
 *     一条既没读回正文也没标脏的老会话会被**整条跳过** → 旧值永远留在盘上。
 *
 * 本用例钉住修复后的两条硬口径（真跑真代码，不是抄一份逻辑）：
 *   [1] 主进程字段级通道 patchSessionMeta：只改白名单键（workspace）、只改那一个键、
 *       原子写 + 同步刷索引；非白名单键 / 非法 id / 文件不在 都有明确回执且一个字节不动。
 *   [2] 启动体检（renderer/app.js 的 sanitizeInvalidWorkspaces 真源码）：
 *       · 静默（不再弹「工作目录无效」卡），只把每一条落进主进程日志；
 *       · 带有 appId 的失效会话按判据**归位**到该应用当前开发目录（限定在应用根家族下、
 *         末段目录名 == appId、且不等于当前目录），归位与清空都经统一入口
 *         agentSetSessionWorkspace（标脏 + session:patch 改会话文件本体）；
 *       · 用户手填的其它存在目录一个字不动。
 *
 * 运行：node test/smoke-workspace-stale-session.js
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { createAgentSessionsStore, PATCH_KEYS } = require("../agent-sessions-store.js");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
}
function section(t) {
  console.log("\n[" + t + "]");
}
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
/* 按标记切一段真实源码（首尾都含），切不到就报失败并回空串 */
function slice(src, fromMark, toMark, label) {
  const i = src.indexOf(fromMark);
  const j = i < 0 ? -1 : src.indexOf(toMark, i + fromMark.length);
  const good = i >= 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}

const APP = read("renderer/app.js");
const ASSIST = read("renderer/app-assist.js");
const APPS = read("renderer/app-apps.js");
const PRELOAD = read("preload.js");
const MAIN = read("main.js");

/* ═══════════ [1] 主进程存储：字段级补丁真写盘 ═══════════ */
section("1 主进程存储：patchSessionMeta（只白名单键 + 原子写 + 刷索引）");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-wsstale-")));
const DATA = path.join(TMP, "pipeline-console");
fs.mkdirSync(DATA, { recursive: true });
const CFG = path.join(DATA, "config.json");
fs.writeFileSync(CFG, JSON.stringify({ version: 1, locale: "zh" }), "utf8");

const logs = [];
const store = createAgentSessionsStore({
  dataDir: () => DATA,
  cfgFile: () => CFG,
  log: (m) => logs.push(String(m)),
});
const SESS_DIR = path.join(DATA, "agent-sessions");
const OLD_WS = "E:\\mtnode\\apps\\test\\ds-village";
const NEW_WS = "E:\\mtnode\\apps\\dev\\ds-village";
const SID = "asstale000001";

store.saveSessions({
  activeId: "",
  sessions: [
    {
      id: SID,
      title: "开发 · 一条老会话",
      workspace: OLD_WS,
      appId: "ds-village",
      preset: "standard",
      updatedAt: 1000,
      body: {
        id: SID,
        title: "开发 · 一条老会话",
        workspace: OLD_WS,
        appId: "ds-village",
        messages: [{ role: "user", content: "本次开发需求：改点东西", at: 1 }],
        updatedAt: 1000,
      },
    },
  ],
});
const sessFile = path.join(SESS_DIR, SID + ".json");
const idxFile = path.join(SESS_DIR, "index.json");
ok(fs.existsSync(sessFile), "会话文件已建：" + sessFile);
const before = JSON.parse(fs.readFileSync(sessFile, "utf8"));
ok(before.workspace === OLD_WS, "准备态：盘上那份记着旧路径 " + OLD_WS);

ok(PATCH_KEYS.join(",") === "workspace", "补丁白名单只有 workspace 一个键（写入面最小）");

/* 非白名单键：明确拒绝，且一个字节都不动 */
const rTitle = store.patchSessionMeta(SID, { title: "改个名" });
ok(rTitle.ok === false && rTitle.error === "no_patchable_key",
  "非白名单键被拒（回执 " + JSON.stringify(rTitle.error) + "）");
ok(JSON.parse(fs.readFileSync(sessFile, "utf8")).title === before.title,
  "被拒之后会话文件里 title 一个字没动");

/* 非法 id / 文件不在：都有明确回执，不抛错 */
const rBad = store.patchSessionMeta("../etc/passwd", { workspace: NEW_WS });
ok(rBad.ok === false && rBad.error === "bad_id", "非法会话 id 被拒（" + JSON.stringify(rBad.error) + "）");
const rMiss = store.patchSessionMeta("asnosuch0001", { workspace: NEW_WS });
ok(rMiss.ok === false && rMiss.error === "missing", "盘上没有这份会话 → 回 missing（不建空档）");

/* 真补丁 */
const r1 = store.patchSessionMeta(SID, { workspace: NEW_WS });
ok(r1.ok === true && r1.changed === 1 && r1.keys.join(",") === "workspace",
  "补丁成功且只改了 workspace（" + JSON.stringify(r1.keys) + "）");
const after = JSON.parse(fs.readFileSync(sessFile, "utf8"));
ok(after.workspace === NEW_WS, "会话文件本体的 workspace 真的改了：" + after.workspace);
ok(after.title === before.title && after.appId === before.appId,
  "其它顶层字段逐字未动（title / appId）");
ok(JSON.stringify(after.messages) === JSON.stringify(before.messages),
  "正文（messages）逐字未动 —— 补丁不读、不重写正文");
const idxAfter = JSON.parse(fs.readFileSync(idxFile, "utf8"));
const eAfter = (idxAfter.sessions || []).find((s) => s && s.id === SID);
ok(!!eAfter && eAfter.workspace === NEW_WS, "索引条目同步成新路径（界面读的是索引那份）");
const stAfter = fs.statSync(sessFile);
ok(
  !!eAfter.sig && eAfter.sig.size === stAfter.size &&
    Math.abs(eAfter.sig.mtimeMs - stAfter.mtimeMs) <= 1000,
  "索引里的签名与写后的文件对齐（下次启动不会白重读这一份）",
);
ok(logs.some((m) => m.indexOf("workspace 改写") >= 0 && m.indexOf(NEW_WS) >= 0),
  "改写这件事进了主进程日志（可复核）");

/* 读回来就是新值：渲染层 loadSessions / 正文读回吃到的也是它 */
const back = store.loadSessions([SID]);
ok(back.ok === true && back.sessions[0].workspace === NEW_WS,
  "session:body 读回来的正文里已经是新路径（旧值不再回渗）");
/* 幂等 + 不重复写盘 */
const mtime1 = fs.statSync(sessFile).mtimeMs;
const r2 = store.patchSessionMeta(SID, { workspace: NEW_WS });
ok(r2.ok === true && r2.changed === 0, "已经等于新值 → changed=0（幂等）");
ok(fs.statSync(sessFile).mtimeMs === mtime1, "幂等那一次一次磁盘写都没做");
/* 清空（另一条分支：只能清空时） */
const r3 = store.patchSessionMeta(SID, { workspace: "" });
ok(r3.ok === true && JSON.parse(fs.readFileSync(sessFile, "utf8")).workspace === "",
  "补丁也支持清空（workspace 改成空串，走兜底链）");
/* 对账不把旧值翻回来 */
const rec = store.reconcile("冒烟补丁后");
ok(rec.ok === true && store.readIndex().sessions.find((s) => s.id === SID).workspace === "",
  "对账后索引仍是补丁后的值（旧值不会被翻回来）");

/* 接线：IPC 通道 + preload 桥 + 白名单（改主进程 require 之外的另一个坑：桥没暴露） */
ok(/ipcMain\.handle\("session:patch"/.test(MAIN), "main.js 注册了 session:patch");
ok(/sessionPatch:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('session:patch'/.test(PRELOAD),
  "preload.js 暴露 sessionPatch 桥");
ok(/"agent-sessions-store\.js"/.test(read("build.json")),
  "agent-sessions-store.js 仍在打包白名单（新通道不会「源码有、asar 没有」）");

/* ═══════════ [2] 启动体检：静默 + 归位判据走统一入口 ═══════════ */
section("2 启动体检：静默化 + 会话侧走统一入口");
const SAN = slice(APP, "async function sanitizeInvalidWorkspaces(opts) {",
  "/* 失效的会话工作目录「该改写成哪里」", "app.js sanitizeInvalidWorkspaces");
const HEAL = slice(APP, "/* 失效的会话工作目录「该改写成哪里」",
  "/* ── 工作目录闸门", "app.js wsHealDirFor / wsHealFamilyRoots");
ok(SAN.indexOf("showInfoOverlay") < 0, "启动体检不再弹「工作目录无效」卡（静默）");
ok(/crashLogRenderer/.test(SAN) && /workspace-cleanup/.test(SAN),
  "每一条都落进主进程日志（kind=workspace-cleanup）");
ok(/agentSetSessionWorkspace\(sess, v\)/.test(SAN) && !/sess\.workspace = v/.test(SAN),
  "会话侧改经统一入口（标脏 + session:patch 改会话文件本体），不再直接改内存");
ok(/wsHealDirFor\(sess\)/.test(SAN), "清空之前先算一次「能不能归位」");
ok(/agentFlushSessionSave/.test(SAN), "收尾把会话那一次合并落盘窗口也推下去");
/* 手填输入框那张当场提示不受影响（另一张同名卡） */
ok(
  /该路径不存在或不是有效文件夹，已自动清空。请重新选择有效的工作目录。/.test(APP) &&
    /await showInfoOverlay\(/.test(APP.slice(APP.indexOf("const setWs = async (raw)"), APP.indexOf("inp.addEventListener(\"change\""))),
  "往输入框手填 / 粘贴无效路径的当场提示保留（只静默启动体检）",
);
ok(/appsRootGet/.test(HEAL) && /dirOfPath/.test(HEAL), "归位判据问主进程要两套应用根（惰性，只算一次）");
ok(/last !== appId\.toLowerCase\(\)/.test(HEAL), "末段目录名必须等于 appId 才归位");
ok(/wsUnderAnyDir\(cur, dirs\)/.test(HEAL), "必须落在应用根家族之下才归位（用户手填的别处一律不碰）");
ok(/appsSamePath\(cur, dir\)/.test(HEAL) && /same \? "" : dir/.test(HEAL),
  "已经等于当前应用目录 → 一个字节都不动");
ok(/agentSetSessionWorkspace\(sess, ""\)/.test(read("renderer/app.js")) &&
    /wipeMatchingWorkspaces/.test(APP),
  "导入他人模板那条（wipeMatchingWorkspaces）的会话侧也走统一入口");

/* 统一入口本体：标脏 + session:patch（真源码断言） */
const SETTER = slice(ASSIST, "S._wsFixed = S._wsFixed instanceof Map",
  "/* 视图会话 id：覆盖态", "app-assist.js agentSetSessionWorkspace");
ok(/agentMarkSessionDirty\(id\)/.test(SETTER), "统一入口会标脏（索引条目跟着走）");
ok(/window\.api\.sessionPatch/.test(SETTER), "统一入口走字段级通道改会话文件本体");
ok(/agentEnsureSessionBody\(st\)/.test(SETTER) && /agentFlushSessionSave\(\)/.test(SETTER),
  "老宿主（没有 session:patch 桥）退化为「读回正文 → 标脏 → 立即 flush 整份重写」");
ok(/S\._wsFixed\.set\(id, val\)/.test(SETTER), "修正值记进 _wsFixed（正文读回时按它重放）");
ok(/S\._wsFixed instanceof Map \? S\._wsFixed\.get\(String\(id\)\)/.test(ASSIST) &&
    /st\.workspace = String\(fixedWs\)/.test(ASSIST),
  "正文读回（agentEnsureSessionBody）时重放修正值 —— 盘上旧值盖不回来");
ok(/agentViewBlankWorkspaceSet/.test(ASSIST) && !/agentSetSessionWorkspace\(st, p\)/.test(ASSIST.slice(ASSIST.indexOf("function agentViewBlankWorkspaceSet"), ASSIST.indexOf("S._wsFixed = S._wsFixed"))),
  "占位空会话（非法 id）照旧直接赋值，不走统一入口（不会对着不存在的会话白写一次盘）");

/* ═══════════ [3] vm 真跑：启动体检的完整判断链（真代码 + 假桥） ═══════════ */
(async () => {
  section("3 vm 真跑：启动体检（真源码 + 假桥）");
  const DIR_OF_PATH = slice(APP, "function dirOfPath(p) {", "/* ── 媒体端子值", "app.js dirOfPath");
  const SAME_PATH = slice(APPS, "function appsSamePath(a, b) {", "/* ── 「📂 打开数据目录」", "app-apps.js appsSamePath");
  const PATH_IS_DIR = slice(APP, "async function pathIsExistingDir(p) {", "function showInfoOverlay(", "app.js pathIsExistingDir");

  const DOWN_ROOT = "E:\\mtnode\\apps\\app";
  const DEV_ROOT = "E:\\mtnode\\apps\\dev";
  const APP_DIR = DEV_ROOT + "\\ds-village";
  const OTHER = "E:\\work\\elsewhere";
  const EXIST = new Set([DEV_ROOT, DOWN_ROOT, DOWN_ROOT + "\\ds-village", APP_DIR, OTHER]);

  const SESSIONS = [
    { id: "as1", title: "test 根那条（旧布局）", appId: "ds-village", workspace: "E:\\mtnode\\apps\\test\\ds-village" },
    { id: "as2", title: "已经在正确目录", appId: "ds-village", workspace: APP_DIR },
    { id: "as3", title: "下载根里那一份", appId: "ds-village", workspace: DOWN_ROOT + "\\ds-village" },
    { id: "as4", title: "用户自己选的目录（还在）", appId: "ds-village", workspace: OTHER },
    { id: "as5", title: "别的应用、目录已不在", appId: "sudoku", workspace: "D:\\gone\\sudoku" },
    { id: "as6", title: "没有 appId 的老会话", appId: "", workspace: "E:\\mtnode\\apps\\test\\orphan" },
    { id: "as7", title: "应用已不在本机列表", appId: "ghost-app", workspace: "E:\\mtnode\\apps\\test\\ghost-app" },
    { id: "as8", title: "同名的别处目录（不在应用根下）", appId: "ds-village", workspace: "E:\\my\\own\\ds-village" },
  ];

  const patched = [];
  const logRows = [];
  const markDirty = [];
  const sb = {
    console,
    setTimeout,
    clearTimeout,
    Map,
    Promise,
    String,
    Number,
    S: { wf: { workspace: "", nodes: [] }, config: {}, _wsFixed: new Map() },
    I18n: { t: (k) => String(k) },
    agentSessions: () => SESSIONS,
    scheduleSave: () => {},
    agentFlushSessionSave: async () => {},
    agentMarkSessionDirty: (id) => markDirty.push(String(id)),
    agentEnsureSessionBody: async () => false,
    appsListLoad: async () => {},
    appsDevProjectDir: (id) => (String(id) === "ds-village" ? APP_DIR : ""),
    window: {
      api: {
        fileIsDir: async (p) => EXIST.has(String(p)),
        sessionPatch: async (payload) => {
          patched.push(payload);
          return { ok: true, changed: 1 };
        },
        appsRootGet: async () => ({ roots: { down: { path: DOWN_ROOT }, dev: { path: DEV_ROOT } } }),
        configSave: async () => ({ ok: true }),
        crashLogRenderer: async (payload) => {
          logRows.push(payload);
          return { ok: true };
        },
      },
    },
  };
  vm.createContext(sb);
  vm.runInContext(
    DIR_OF_PATH + "\n" + SAME_PATH + "\n" + PATH_IS_DIR + "\n" + SETTER + "\n" + SAN + "\n" + HEAL,
    sb,
    { filename: "app.js#workspace-sanitize" },
  );
  const n = await vm.runInContext("sanitizeInvalidWorkspaces", sb)({});
  const patchOf = (id) => patched.filter((p) => p.id === id);
  const wsOf = (id) => SESSIONS.find((s) => s.id === id).workspace;

  ok(wsOf("as1") === APP_DIR, "① 旧布局（apps\\test\\ds-village）→ 归位到当前应用目录：" + wsOf("as1"));
  ok(patchOf("as1").length === 1 && patchOf("as1")[0].patch.workspace === APP_DIR,
    "① 归位经 session:patch 落到会话文件本体（不是只改内存）");
  ok(wsOf("as2") === APP_DIR && patchOf("as2").length === 0,
    "② 已经在正确目录 → 一个字不动、一次补丁都不发");
  ok(wsOf("as3") === APP_DIR && patchOf("as3").length === 1,
    "③ 下载根里那一份（应用根家族下、末段同名）→ 归位，不留在库里那份上");
  ok(wsOf("as4") === OTHER && patchOf("as4").length === 0, "④ 用户自己选的目录（还在盘上）→ 一个字不动");
  ok(wsOf("as5") === "" && patchOf("as5")[0].patch.workspace === "",
    "⑤ 别的应用 + 目录已不在 → 清空（归位要拿得到当前应用目录，拿不到就不猜）");
  ok(wsOf("as6") === "" && patchOf("as6")[0].patch.workspace === "",
    "⑥ 没有 appId 的老会话 → 清空");
  ok(wsOf("as7") === "" && patchOf("as7")[0].patch.workspace === "",
    "⑦ 会话记着的应用已不在本机列表 → 清空（不编造目录）");
  ok(wsOf("as8") === "" && patchOf("as8")[0].patch.workspace === "",
    "⑧ 同名但不在应用根家族下 → 不归位（目录不在就按普通失效清空，不往应用目录上凑）");
  ok(markDirty.indexOf("as1") >= 0 && markDirty.indexOf("as5") >= 0,
    "改动过的会话都标了脏（改的与清的都算）");
  ok(n === 6, "体检回执 = 6 条（归位 2 + 清空 4），实得 " + n);
  ok(logRows.length === 6 && logRows.every((r) => r.kind === "workspace-cleanup"),
    "6 条全部落进主进程日志（kind=workspace-cleanup），实得 " + logRows.length);
  ok(logRows.filter((r) => /\[info\]/.test(r.message)).length === 2 &&
    logRows.filter((r) => /\[warn\]/.test(r.message)).length === 4,
    "日志分级：归位 info（2 条）/ 只能清空 warn（4 条）");
  ok(
    logRows.some(
      (r) =>
        r.message.indexOf("E:\\mtnode\\apps\\test\\ds-village") >= 0 &&
        r.message.indexOf(APP_DIR) >= 0,
    ),
    "归位那条日志写清了「旧 → 新」（可复核）",
  );
  /* 幂等：再跑一次，什么都不会再改 */
  const n2 = await vm.runInContext("sanitizeInvalidWorkspaces", sb)({});
  ok(n2 === 0 && patched.length === 6, "第二次启动体检：0 条要改（旧路径不再回来）");

  console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("冒烟自身抛错：", (e && e.stack) || e);
  process.exit(1);
});

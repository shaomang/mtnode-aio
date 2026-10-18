"use strict";
/* test/smoke-session-delete.js — 「删除会话后重启又回来」的端到端回归
 *
 * 现场（本机 bug）：左栏「删除」只把会话从渲染层内存数组里摘掉，从未告诉主进程
 * 「这条要删」。主进程 agent-sessions-store.js 的 saveSessions 只删 drop 名单里的会话
 * （文件 + 索引条目），于是 index.json 与 agent-sessions/as<id>.json 原样留在盘上，
 * 下次启动 app-boot.js 从 session:load 读索引 → 会话又回来了。
 *
 * 本冒烟不启动 Electron、不碰真实数据目录：
 *   · 真源 1 = renderer/app-assist.js 的删除链与落盘链（切片真跑在 vm 里）；
 *   · 真源 2 = agent-sessions-store.js（真读写一个临时数据目录）。
 * 断言的是磁盘上的字节与索引内容，不是源码字符串。
 *
 * 覆盖：
 *   [1] 起点：3 条会话真的落盘（文件 + 索引）
 *   [2] 删除一条（已加载正文）→ session:save 的 drop 带上它 → 文件被删 → 索引条目消失
 *   [3] 「重启」：新建一份存储实例重读索引 / 读正文 → 删掉的会话不再出现
 *   [4] 懒加载会话（正文没读回）删除同样生效
 *   [5] 写盘失败：待删名单保留 + 只提示一次 + 排了重试；恢复后重试成功，名单清空
 *   [6] 60 条截断仍走同一条 drop 通道（既有口径不回退）
 *
 * 运行：node test/smoke-session-delete.js
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { createAgentSessionsStore } = require("../agent-sessions-store.js");

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
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const has = (s, sub, msg) => ok(String(s).indexOf(sub) >= 0, msg);

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));
I18n.setLocale("zh");
const ASSIST = read(path.join("renderer", "app-assist.js"));

/* ---------- 从源码里按名字抠出顶层函数 / 常量（与 smoke-inline-img.js 同款） ---------- */
function braceSlice(src, at, name) {
  const i = src.indexOf("{", at);
  if (i < 0) throw new Error("找不到函数体：" + name);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体不完整：" + name);
}
function stmtSlice(src, at, name) {
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return src.slice(at, j + 1);
  }
  throw new Error("语句不完整：" + name);
}
function grab(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\n(?:const|let|var) " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到：" + name);
  const head = src.slice(at, at + 24);
  return /^(?:async\s+)?function/.test(head)
    ? braceSlice(src, at, name)
    : stmtSlice(src, at, name);
}

/* ---------- 临时数据目录 + 真存储 ---------- */
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-sessdel-")));
const DATA = path.join(TMP, "pipeline-console");
fs.mkdirSync(DATA, { recursive: true });
const CFG = path.join(DATA, "config.json");
const SESS_DIR = path.join(DATA, "agent-sessions");

function mkStore() {
  return createAgentSessionsStore({
    dataDir: () => DATA,
    cfgFile: () => CFG,
    log: () => {},
    backup: (fp) => {
      const dir = path.join(path.dirname(fp), "config-backups");
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(fp, path.join(dir, "config-" + Date.now() + ".json"));
    },
    mutateConfig: (fp, fn) => {
      const cfg = JSON.parse(fs.readFileSync(fp, "utf8"));
      fn(cfg);
      const tmp = fp + ".tmp" + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(cfg), "utf8");
      fs.renameSync(tmp, fp);
      return true;
    },
  });
}
const store = mkStore();

function mkSession(i) {
  return {
    id: "asdel" + String(i).padStart(4, "0"),
    title: "待删会话 " + i,
    workspace: TMP,
    preset: "minimal",
    provider: "deepseek-official",
    model: "",
    effort: "high",
    canvasWfId: "wf1",
    appId: "",
    archived: false,
    updatedAt: 1700000000000 + i,
    createdAt: 1700000000000,
    messages: [{ role: "user", content: "你好 " + i, at: 1700000000000 + i }],
  };
}

const SEED = [mkSession(1), mkSession(2), mkSession(3)];
const saveCalls = [];
let failNext = false;
const TOASTS = [];

/* 渲染层沙箱：只给与删除链无关的下游替身（界面重绘 / 内嵌图回收 / 计划水合） */
const S = {
  agentSessions: SEED.map((s) => Object.assign({}, s, { _lcLoaded: true, _lcDirty: false })),
  agentActiveId: SEED[0].id,
  wf: { id: "wf1", nodes: [], wires: [] },
  _sessionDirty: new Set(),
  _sessionDrop: new Set(),
};
const sandbox = {
  console,
  I18n,
  S,
  setTimeout,
  clearTimeout,
  AGENT_PRESET_DEFAULT: "minimal",
  toast: (m, kind) => TOASTS.push({ m: String(m), kind: String(kind || "") }),
  renderAgentSessionSidebar: () => {},
  renderAgentSession: () => {},
  agentEnsureViewSessionBody: () => {},
  scheduleSave: () => {},
  renderCanvas: () => {},
};
sandbox.window = sandbox;
sandbox.api = {
  sessionSave: async (payload) => {
    saveCalls.push(JSON.parse(JSON.stringify({ drop: payload.drop || [] })));
    if (failNext) {
      failNext = false;
      return { ok: false, error: "index_write" };
    }
    return store.saveSessions(payload);
  },
};
vm.createContext(sandbox);

const FNS = [
  "AGENT_SAVE_MS",
  "AGENT_DROP_RETRY_MS",
  "AGENT_DROP_RETRY_MAX",
  "agentSessions",
  "activeAgentId",
  "agentMarkSessionDirty",
  "agentMarkSessionDrop",
  "agentFlushSessionSave",
  "agentWriteAgentSessions",
  "agentSettleSessionDrop",
  "agentScheduleSessionDropRetry",
  "persistAgentSession",
  "agentSessionMetaForDisk",
  "agentSessionBodyForDisk",
  "sessionLastAt",
  "detachSessionsFromNodes",
  "agentSessionBusy",
  "stopSessionForDelete",
  "deleteAgentSessionCore",
  "deleteAgentSession",
];
for (const name of FNS) {
  const piece = grab(ASSIST, name);
  try {
    new vm.Script(piece);
  } catch (e) {
    ok(false, "切片 " + name + " 编译失败：" + e.message);
  }
  vm.runInContext(piece, sandbox, { filename: "app-assist-delete.js" });
}

const F = new Proxy({}, { get: (_t, k) => sandbox[k] });
const ids = () => store.readIndex().sessions.map((s) => s.id);
const fileOf = (id) => path.join(SESS_DIR, id + ".json");

async function main() {
  /* ═══════════ [1] 起点：3 条会话真的落盘 ═══════════ */
  section("1 起点：3 条会话真的落盘（文件 + 索引）");
  const seeded = store.saveSessions({
    activeId: SEED[0].id,
    sessions: SEED.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, body: s })),
  });
  ok(seeded && seeded.ok === true, "种子保存成功");
  eqNum(ids().length, 3, "索引里 3 条");
  ok(SEED.every((s) => fs.existsSync(fileOf(s.id))), "3 份会话文件都在盘上");
  eqNum(F.agentSessions().length, 3, "渲染层内存里也是 3 条");

  /* ═══════════ [2] 删除一条：drop 必须带上它，盘上一起删 ═══════════ */
  section("2 删除一条（已加载正文）：drop 带上它 → 文件被删 → 索引条目消失");
  const victim = SEED[1].id;
  saveCalls.length = 0;
  await F.deleteAgentSession(victim);
  ok(saveCalls.length >= 1, "删除真的走了一次 session:save");
  const lastDrop = saveCalls[saveCalls.length - 1].drop || [];
  ok(lastDrop.indexOf(victim) >= 0, "session:save 的 drop 里点名了被删的会话（根因修复点）");
  ok(!fs.existsSync(fileOf(victim)), "会话文件已从盘上删掉");
  ok(ids().indexOf(victim) < 0, "索引条目已移除（index.json 不再指向它）");
  eqNum(F.agentSessions().length, 2, "内存列表剩 2 条");
  ok(!(sandbox.S._sessionDrop instanceof Set) || sandbox.S._sessionDrop.size === 0, "成功后待删名单已清空");

  /* ═══════════ [3] 「重启」：重读索引不再出现 ═══════════ */
  section("3 「重启」：新建一份存储实例重读索引 / 读正文");
  const store2 = mkStore();
  const idx2 = store2.readIndex();
  ok(idx2.sessions.map((s) => s.id).indexOf(victim) < 0, "重启后索引里没有它（不会再出现在左栏）");
  const load2 = store2.loadSessions([victim]);
  ok(load2.sessions.length === 0, "重启后按 id 也读不回正文");
  ok((load2.gone || []).indexOf(victim) >= 0, "主进程明确回「该会话已不在盘上」（gone）");
  eqNum(idx2.sessions.length, 2, "重启后仍是 2 条（其余会话一条没少）");

  /* ═══════════ [4] 懒加载会话（正文没读回）删除同样生效 ═══════════ */
  section("4 懒加载会话（正文没读回）删除同样生效");
  const lazy = SEED[2].id;
  const inMem = F.agentSessions().find((s) => s.id === lazy);
  inMem._lcLoaded = false;
  inMem.messages = [];
  saveCalls.length = 0;
  await F.deleteAgentSessionCore(lazy);
  const lazyDrop = saveCalls[saveCalls.length - 1].drop || [];
  ok(lazyDrop.indexOf(lazy) >= 0, "只有索引、正文没读回的会话也被 drop 点名（不依赖正文）");
  ok(!fs.existsSync(fileOf(lazy)), "它的会话文件同样被删");
  ok(ids().indexOf(lazy) < 0, "索引条目同样消失");

  /* ═══════════ [5] 写盘失败：名单保留 + 提示一次 + 重试成功 ═══════════ */
  section("5 写盘失败：待删名单保留、只提示一次；恢复后重试成功");
  const again = await (async () => {
    const s = mkSession(9);
    store.saveSessions({
      activeId: SEED[0].id,
      sessions: [{ id: s.id, title: s.title, updatedAt: s.updatedAt, body: s }],
    });
    S.agentSessions.push(Object.assign({}, s, { _lcLoaded: true, _lcDirty: false }));
    return s.id;
  })();
  ok(fs.existsSync(fileOf(again)) && ids().indexOf(again) >= 0, "起点：这条会话盘上确实还在");
  TOASTS.length = 0;
  failNext = true;
  await F.deleteAgentSession(again);
  ok(fs.existsSync(fileOf(again)), "写盘失败时盘上文件确实还没删（用户会被「又回来」坑到的那种态）");
  ok(
    !!sandbox.S._sessionDrop && sandbox.S._sessionDrop.has(again),
    "失败后待删名单保留（下一次保存会继续带上）",
  );
  const errToasts = TOASTS.filter((t) => t.kind === "err");
  eqNum(errToasts.length, 1, "失败只提示一次");
  has(errToasts[0] && errToasts[0].m, "重启后可能又出现", "提示说清了后果（不是静默吞掉）");
  eqStr(errToasts[0] && errToasts[0].kind, "err", "提示用 err 档");
  ok(
    !TOASTS.some((t) => t.kind === "ok"),
    "失败时不再报「会话已删除」（不骗用户）",
  );
  ok(!!sandbox.S._sessionDropRetryTimer, "已排一次自动重试");
  if (sandbox.S._sessionDropRetryTimer) clearTimeout(sandbox.S._sessionDropRetryTimer);
  sandbox.S._sessionDropRetryTimer = null;
  saveCalls.length = 0;
  await F.agentFlushSessionSave();
  const retryDrop = saveCalls.length ? saveCalls[saveCalls.length - 1].drop || [] : [];
  ok(retryDrop.indexOf(again) >= 0, "下一次保存把待删名单又带上了（真的在重试）");
  ok(!fs.existsSync(fileOf(again)), "重试成功后文件被删");
  ok(ids().indexOf(again) < 0, "重试成功后索引条目也没了");
  eqNum(sandbox.S._sessionDrop.size, 0, "成功后待删名单清空");

  /* ═══════════ [6] 60 条截断仍走同一条 drop 通道（不回退） ═══════════ */
  section("6 60 条截断仍走同一条 drop 通道");
  const many = [];
  for (let i = 0; i < 62; i++)
    many.push(Object.assign(mkSession(100 + i), { updatedAt: 1700000000000 + i }));
  S.agentSessions = many.map((s) => Object.assign({}, s, { _lcLoaded: true, _lcDirty: false }));
  saveCalls.length = 0;
  await F.agentFlushSessionSave();
  const cutDrop = saveCalls.length ? saveCalls[saveCalls.length - 1].drop || [] : [];
  eqNum(cutDrop.length, 2, "截断掉的两条进了 drop");
  ok(
    cutDrop.indexOf(many[60].id) >= 0 && cutDrop.indexOf(many[61].id) >= 0,
    "截断走的是同一条 drop 通道（老口径没被改坏）",
  );
  ok(cutDrop.indexOf(many[0].id) < 0, "没被截掉的会话不会被误删");

  /* ── 静态口径：根因那一步必须一直在删除链里 ── */
  section("7 静态核对：删除链必须点名");
  has(grab(ASSIST, "deleteAgentSessionCore"), "agentMarkSessionDrop(id)", "删除内核把 id 记进待删名单");
  const writeSrc = grab(ASSIST, "agentWriteAgentSessions");
  has(writeSrc, "S._sessionDrop", "落盘链读待删名单");
  has(writeSrc, "drop: dropped", "待删名单随 session:save 下发");
  has(grab(ASSIST, "agentSettleSessionDrop"), "agentScheduleSessionDropRetry()", "写盘失败会排重试");
}

main()
  .catch((e) => {
    ok(false, "冒烟抛出异常：" + (e && e.stack ? e.stack : e));
  })
  .then(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
    console.log("\n" + (fails ? "✗ " + fails + " 项失败" : "✓ 全部通过") + "（" + checks + " 项）");
    process.exit(fails ? 1 : 0);
  });

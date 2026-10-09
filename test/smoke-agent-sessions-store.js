"use strict";
/* test/smoke-agent-sessions-store.js — 会话存储（agent-sessions-store.js）的独立冒烟
 *
 * 不启动 Electron、不碰真实数据目录：把存储的 dataDir 指到临时目录，真跑一遍
 * 迁移 → 懒加载读 → 保存（只写脏会话）→ 对账 → 坏档恢复 → 重建索引 的全链路，
 * 断言的是磁盘上的字节与索引内容，不是源码字符串。
 *
 * 钉住的硬口径（缺一条就会丢数据 / 拖慢启动）：
 *   [1] 迁移：config.json 的 agentSessions → agent-sessions/<id>.json + index.json，
 *       迁移前先备一份原始 config.json；迁移成功后旧键清空。
 *   [2] 懒加载：索引里**没有**正文（messages），正文只在 session:load 时读回。
 *   [3] loaded:false 的条目只更新索引，绝不覆盖磁盘上的正文（懒加载最容易踩的坑）。
 *   [4] 写序：先会话体后索引；两者都是紧凑 JSON（无缩进）。
 *   [5] 对账：索引与盘不一致（mtime 变了）就按盘重建索引条目；孤儿文件归 recent/。
 *   [6] 坏档：改名留痕（.bad）并尽量从最近快照恢复，绝不静默删。
 *   [7] 60 条截断 / 用户删除走 drop：会话文件真的被删。
 *
 * 运行：node test/smoke-agent-sessions-store.js
 */
const os = require("os");
const fs = require("fs");
const path = require("path");

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

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-sessstore-")));
const DATA = path.join(TMP, "pipeline-console");
fs.mkdirSync(DATA, { recursive: true });
const CFG = path.join(DATA, "config.json");

const logs = [];
function mkStore() {
  return createAgentSessionsStore({
    dataDir: () => DATA,
    cfgFile: () => CFG,
    log: (m) => logs.push(String(m)),
    /* 与 main.js 同款：备份 = 往 config-backups/ 拷一份带时间戳的副本 */
    backup: (fp) => {
      const dir = path.join(path.dirname(fp), "config-backups");
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(fp, path.join(dir, "config-" + Date.now() + ".json"));
    },
    /* 与 main.js 的 mutateConfigFile 同款：读 → 改 → 紧凑写回 */
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

function mkSession(i, bytes) {
  return {
    id: "as" + String(i).padStart(8, "0"),
    title: "会话 " + i,
    workspace: TMP,
    appId: i % 2 ? "app-x" : "",
    preset: "standard",
    provider: "deepseek-official",
    model: "deepseek-flash",
    effort: "high",
    grill: true,
    showThink: null,
    trajView: "",
    noCanvasRead: false,
    canvasFree: false,
    noPlanFlow: false,
    ltBound: null,
    draft: "",
    archived: false,
    updatedAt: 1000 + i,
    messages: [{ role: "user", content: "x".repeat(bytes), at: 1000 + i }],
    outbox: [],
    todos: [],
    todoHidden: [],
    plan: null,
    planDelivered: false,
    planCollapsed: false,
    planDrops: 0,
    tokenReport: null,
    devContract: "",
  };
}

/* ── 准备：一份「旧版」config.json（会话全在里面）── */
const OLD = [mkSession(1, 4000), mkSession(2, 2000), mkSession(3, 500)];
fs.writeFileSync(
  CFG,
  JSON.stringify(
    { version: 1, locale: "zh", providers: [{ id: "deepseek" }], agentActiveId: OLD[0].id, agentSessions: OLD },
    null,
    2,
  ),
  "utf8",
);
const cfgBytesBefore = fs.statSync(CFG).size;

const store = mkStore();

section("1 迁移：config.json 的会话 → agent-sessions/（先备份、后才删旧键）");
const r1 = store.migrateFromConfig();
ok(r1.migrated === true && r1.count === 3, "迁移成功且计数 = 3（" + JSON.stringify(r1) + "）");
const sessDir = path.join(DATA, "agent-sessions");
ok(fs.existsSync(path.join(sessDir, "index.json")), "索引已建：" + path.join(sessDir, "index.json"));
ok(
  fs.existsSync(path.join(sessDir, OLD[0].id + ".json")) &&
    fs.existsSync(path.join(sessDir, OLD[2].id + ".json")),
  "三个会话文件各一份",
);
const cfgAfter = JSON.parse(fs.readFileSync(CFG, "utf8"));
ok(!Array.isArray(cfgAfter.agentSessions) || cfgAfter.agentSessions.length === 0, "旧键已清空（空壳）");
ok(cfgAfter.locale === "zh" && Array.isArray(cfgAfter.providers), "其它设置一个字没动");
const bakDir = path.join(DATA, "config-backups");
ok(
  fs.existsSync(bakDir) && fs.readdirSync(bakDir).length === 1,
  "迁移前已备一份原始 config.json（config-backups/）",
);
const bak = JSON.parse(fs.readFileSync(path.join(bakDir, fs.readdirSync(bakDir)[0]), "utf8"));
ok(Array.isArray(bak.agentSessions) && bak.agentSessions.length === 3, "备份里仍是完整会话（可人工回滚）");
ok(
  fs.statSync(CFG).size < cfgBytesBefore / 2,
  "config.json 体积骤降：" + cfgBytesBefore + " → " + fs.statSync(CFG).size + " 字节",
);

section("2 索引：带齐左栏字段、但不含正文（懒加载）");
const idx1 = store.readIndex();
ok(idx1.sessions.length === 3, "索引 3 条");
ok(idx1.activeId === OLD[0].id, "activeId 随索引落盘");
const e0 = idx1.sessions.find((s) => s.id === OLD[0].id);
ok(!!e0 && e0.title === "会话 1" && e0.appId === "app-x" && e0.updatedAt === 1001, "左栏字段齐（title / appId / updatedAt）");
ok(idx1.sessions.every((s) => s.messages === undefined), "索引里没有 messages（正文没被带进来）");
ok(idx1.sessions.every((s) => s.sig && s.sig.size > 0), "每条索引都记了会话文件的 size/mtime 签名");
const idxBytes = fs.statSync(path.join(sessDir, "index.json")).size;
ok(idxBytes < 4000, "索引体积很小：" + idxBytes + " 字节（正文 " + OLD[0].messages[0].content.length + " 字在会话文件里）");
const idxText = fs.readFileSync(path.join(sessDir, "index.json"), "utf8");
ok(idxText.indexOf("\n") < 0, "索引是紧凑 JSON（无缩进换行）");

section("3 按需读正文");
const l1 = store.loadSessions([OLD[0].id]);
ok(l1.sessions.length === 1 && l1.sessions[0].messages[0].content.length === 4000, "读回 1 条完整正文");
ok(l1.sessions[0].id === OLD[0].id, "正文带 id（渲染层按 id 原地合并）");
const lBad = store.loadSessions(["../evil", "no"]);
ok(lBad.sessions.length === 0 && lBad.bad.length === 0 && lBad.gone.length === 0, "非法 id 直接忽略（不越目录）");
const goneRes = store.loadSessions(["aszzzzzz"]);
ok(goneRes.gone.length === 1, "不存在的会话报 gone（渲染层按空会话继续）");

section("4 保存：只写脏会话；loaded:false 的条目绝不碰正文");
const before2 = fs.statSync(path.join(sessDir, OLD[1].id + ".json")).mtimeMs;
const body1 = mkSession(1, 4000);
body1.title = "会话 1 改名";
body1.messages.push({ role: "assistant", content: "新回复", at: 2000 });
const sv1 = store.saveSessions({
  activeId: OLD[0].id,
  sessions: [
    { id: OLD[0].id, body: body1, ...Object.fromEntries(Object.entries(body1).filter(([k]) => k !== "messages")) },
    /* 只带元数据（**没有** body）= 懒加载下未读回的会话：只更新索引 */
    { id: OLD[1].id, loaded: false, title: "会话 2 改名（未加载）", updatedAt: 5000 },
  ],
});
ok(sv1.ok === true && sv1.wrote === 1, "只写了 1 份文件（脏会话）：" + JSON.stringify({ wrote: sv1.wrote, bytes: sv1.bytes }));
const after2 = fs.statSync(path.join(sessDir, OLD[1].id + ".json")).mtimeMs;
ok(after2 === before2, "未加载会话的文件一个字节都没碰（mtime 不变）");
const disk2 = JSON.parse(fs.readFileSync(path.join(sessDir, OLD[1].id + ".json"), "utf8"));
ok(disk2.messages[0].content.length === 2000, "未加载会话的正文完好（没被索引占位覆盖成空）");
const idx2 = store.readIndex();
const e1 = idx2.sessions.find((s) => s.id === OLD[1].id);
ok(!!e1 && e1.title === "会话 2 改名（未加载）" && e1.updatedAt === 5000, "索引里那条改名已生效（未加载会话走索引更新）");
const bodyText = fs.readFileSync(path.join(sessDir, OLD[0].id + ".json"), "utf8");
ok(bodyText.indexOf("\n") < 0, "会话文件也是紧凑 JSON");

section("5 幂等与重复保存");
const sv2 = store.saveSessions({
  activeId: OLD[0].id,
  sessions: [{ id: OLD[1].id, loaded: false, title: "会话 2 改名（未加载）", updatedAt: 5000 }],
});
ok(sv2.ok === true && sv2.wrote === 0, "索引内容逐字没变 → 一次磁盘都不碰（wrote=0）");

section("6 对账：盘上被外部改动 / 孤儿文件");
/* 模拟外部改动：绕开存储直接改会话文件（size 与 mtime 都会变） */
const p3 = path.join(sessDir, OLD[2].id + ".json");
const ext = mkSession(3, 500);
ext.title = "外部改过的标题";
fs.writeFileSync(p3, JSON.stringify(ext), "utf8");
const orphan = path.join(sessDir, "asorphan001.json");
fs.writeFileSync(orphan, JSON.stringify(mkSession(9, 100)), "utf8");
const rec = store.reconcile("冒烟");
ok(rec.ok === true && rec.rebuilt >= 1, "对账重建了被外部改动的会话：" + JSON.stringify(rec));
const idx3 = store.readIndex();
const e3 = idx3.sessions.find((s) => s.id === OLD[2].id);
ok(!!e3 && e3.title === "外部改过的标题", "索引条目按盘重建（磁盘为准）");
ok(!fs.existsSync(orphan), "孤儿文件已从会话目录挪走");
ok(
  fs.existsSync(path.join(sessDir, "recent", "asorphan001.json")),
  "孤儿文件归进 recent/ 留痕（不是删除）",
);
ok(store._internal.markFresh() === true, "对账后标记有效（下次启动不再重扫）");

section("7 坏档：改名留痕 + 从快照恢复索引条目");
/* 先逼出一份快照（快照是「按时间节流」的：这里用内部口径强制一次） */
store._internal.backupIndex(true);
const p2 = path.join(sessDir, OLD[1].id + ".json");
fs.writeFileSync(p2, "{ 这不是 JSON", "utf8");
const rec2 = store.reconcile("冒烟坏档");
ok(rec2.ok === true, "坏档对账没炸");
const badFiles = fs.readdirSync(sessDir).filter((f) => f.includes(".bad"));
ok(badFiles.length === 1, "坏档改名留痕（.bad）：" + badFiles[0]);
const idx4 = store.readIndex();
const eBad = idx4.sessions.find((s) => s.id === OLD[1].id);
ok(!!eBad && eBad.missing === true, "坏档会话仍在索引里（标 missing，界面按空会话显示而不是凭空消失）");
ok(
  logs.some((m) => m.indexOf("坏档改名留痕") >= 0),
  "坏档这件事进了日志（可复核）",
);

section("8 drop：60 条截断 / 用户删除");
const sv3 = store.saveSessions({ activeId: OLD[0].id, sessions: [], drop: [OLD[2].id] });
ok(sv3.ok === true, "带 drop 的保存成功");
ok(!fs.existsSync(p3), "被 drop 的会话文件已删");
ok(!store.readIndex().sessions.some((s) => s.id === OLD[2].id), "索引里也没有它了");

section("9 首装（没有 config.json 里的会话）");
const TMP2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-sessstore2-")));
const DATA2 = path.join(TMP2, "pipeline-console");
fs.mkdirSync(DATA2, { recursive: true });
const store2 = createAgentSessionsStore({
  dataDir: () => DATA2,
  cfgFile: () => path.join(DATA2, "config.json"),
  log: (m) => logs.push(String(m)),
});
const idx5 = store2.readIndex();
ok(idx5.ok === true && idx5.sessions.length === 0, "空数据目录：返回空索引，不报错");
ok(fs.existsSync(path.join(DATA2, "agent-sessions", "index.json")), "顺手建好目录与空索引");

console.log("\n冒烟结果：" + (checks - fails) + "/" + checks + " 通过" + (fails ? "，失败 " + fails : ""));
try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(TMP2, { recursive: true, force: true });
} catch {}
process.exit(fails ? 1 : 0);

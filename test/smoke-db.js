/* 数据库引擎冒烟测试：直接测 db-store.js（SQLite + FTS5 增量/查询/calc/日志） */
const store = require("../db-store.js");
const os = require("os");
const path = require("path");
const fs = require("fs");

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-db-test-"));
const dbFile = store.dbFilePath(tmp);
const db = store.openDb(dbFile);

/* 1. 增量编译：初建 → 变更 → 移除 */
const recs1 = [
  { id: "r1", source: "node:n1", kind: "fact", title: "客户甲", content: "客户甲 合同金额 1200 元", hash: "h1" },
  { id: "r2", source: "node:n2", kind: "fact", title: "客户乙", content: "客户乙 合同金额 800 元", hash: "h2" },
  { id: "r3", source: "file:price.yaml", kind: "file", title: "价格表", content: "单价 12 元 / 件", file: "price.yaml", hash: "h3" },
];
let ch = store.compileRecords(db, recs1);
ok(ch.added === 3 && ch.updated === 0 && ch.removed === 0 && ch.total === 3, "首次编译全量新增");

const recs2 = [
  { id: "r1", source: "node:n1", kind: "fact", title: "客户甲", content: "客户甲 合同金额 1500 元", hash: "h1b" },
  { id: "r3", source: "file:price.yaml", kind: "file", title: "价格表", content: "单价 12 元 / 件", file: "price.yaml", hash: "h3" },
  { id: "r4", source: "file:terms.md", kind: "file", title: "条款", content: "付款期限 30 天", file: "terms.md", hash: "h4" },
];
ch = store.compileRecords(db, recs2);
ok(ch.added === 1 && ch.updated === 1 && ch.removed === 1 && ch.total === 3, "增量：+1 新增 / ~1 更新 / −1 移除");

/* 2. 查询：关键词 + 字段过滤 + 排序 + 溯源 */
let hits = store.dbQuery(db, "客户甲");
ok(hits.length >= 1 && hits[0].id === "r1", "query 命中客户甲（首位）");
ok(hits[0].snippet.includes("1500"), "snippet 含更新后金额");
ok(hits[0].source === "node:n1", "结果带溯源 source");
hits = store.dbQuery(db, "title:价格表");
ok(hits.length === 1 && hits[0].id === "r3", "title: 字段过滤");
hits = store.dbQuery(db, "kind:file 付款");
ok(hits.length === 1 && hits[0].id === "r4", "kind: 过滤 + 关键词");
hits = store.dbQuery(db, "不存在的词xyzzy");
ok(hits.length === 0, "查不到返回空");

/* 3. list / get */
const list = store.dbList(db);
ok(list.length === 3, "dbList 返回全部记录");
const got = store.dbGet(db, "r4");
ok(got && got.content.includes("付款期限"), "dbGet 取全文");
ok(store.dbGet(db, "nope") === undefined, "dbGet 不存在的 id");

/* 4. calc：安全算术 */
ok(store.dbCalcExpr("2+3*4") === 14, "calc 优先级");
ok(store.dbCalcExpr("(2+3)*4") === 20, "calc 括号");
ok(store.dbCalcExpr("1/0") === null, "calc 除零拒绝");
ok(store.dbCalcExpr("alert(1)") === null, "calc 注入拒绝");
ok(store.dbCalcExpr("0.1+0.2") === 0.3, "calc 浮点修约");

/* 5. 查询日志（审计，FIFO 50） */
for (let i = 0; i < 55; i++) store.dbLogAppend(db, { node: "t", action: "query", q: "q" + i, hits: 1 });
const log = store.dbLogAppend(db, { node: "t", action: "query", q: "q-last", hits: 2 });
ok(log.length === 50, "日志 FIFO 上限 50");
ok(log[0].q === "q-last", "日志最新在前");

/* 6. 落盘重开（大库场景：持久化一致） */
db.close();
const db2 = store.openDb(dbFile);
const hits2 = store.dbQuery(db2, "客户");
ok(hits2.length === 1 && hits2[0].id === "r1", "重开后查询一致（客户乙已移除）");
db2.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fails ? "\nSMOKE-DB FAILED (" + fails + ")" : "\nSMOKE-DB OK");
process.exit(fails ? 1 : 0);

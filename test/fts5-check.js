const Database = require("better-sqlite3");
const db = new Database(":memory:");
db.exec(
  "CREATE VIRTUAL TABLE t USING fts5(title, content); INSERT INTO t VALUES('客户甲','合同金额 1200 元'),('客户乙','合同金额 800 元');",
);
const r = db.prepare("SELECT title, bm25(t) AS rank FROM t WHERE t MATCH ? ORDER BY rank").all("客户");
console.log("FTS5+BM25 OK:", JSON.stringify(r));
const s = db
  .prepare("SELECT snippet(t, 1, '<b>', '</b>', '…', 12) AS snip FROM t WHERE t MATCH ?")
  .all("金额");
console.log("snippet OK:", JSON.stringify(s));
db.close();

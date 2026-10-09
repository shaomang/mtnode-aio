/* 只读探针（非交付件 · 不改应用代码 · 不写用户数据）：
 * 用**本机真实 config.json 里的会话**造一份「迁移之后」的语料沙盒，供
 * session-save-cost.cjs --dir=… 量拆开后的存盘代价：
 *
 *   <沙盒>/pipeline-console/config.json                     = 真配置去掉 agentSessions（紧凑 JSON）
 *   <沙盒>/pipeline-console/agent-sessions/<id>.json        = 每个会话一份（与拆出后的落盘字节同构）
 *   <沙盒>/pipeline-console/agent-sessions/index.json       = 索引（左栏字段 + size/mtime 签名）
 *
 * 为什么要这一层：真实用户目录上的迁移只在应用启动时跑一次，探针不该替它跑
 * （改了别人的数据目录），所以拿一份「同体积、同条数」的沙盒来量 A / B 两条路径。
 *
 * 用法：node test/_perf-probe/migrated-corpus.cjs [沙盒根，默认 %TEMP%\mtnode-migrated-sandbox]
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = path.join(process.env.APPDATA || "", "pipeline-console", "pipeline-console", "config.json");
const root = path.resolve(
  process.argv[2] || path.join(os.tmpdir(), "mtnode-migrated-sandbox"),
);
const dst = path.join(root, "pipeline-console");
const sessDir = path.join(dst, "agent-sessions");

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(sessDir, { recursive: true });

const t0 = Date.now();
const cfg = JSON.parse(fs.readFileSync(src, "utf8"));
const list = Array.isArray(cfg.agentSessions) ? cfg.agentSessions : [];
const t1 = Date.now();

const rows = [];
for (const s of list) {
  const id = String(s.id || "");
  if (!id) continue;
  const f = path.join(sessDir, id + ".json");
  fs.writeFileSync(f, JSON.stringify(s), "utf8");
  const st = fs.statSync(f);
  const meta = Object.assign({}, s);
  delete meta.messages;
  meta.sig = { size: st.size, mtimeMs: st.mtimeMs };
  meta.loaded = true;
  rows.push(meta);
}
delete cfg.agentSessions;
fs.writeFileSync(path.join(sessDir, "index.json"), JSON.stringify({ ver: 1, activeId: String(cfg.agentActiveId || ""), sessions: rows }), "utf8");
fs.writeFileSync(path.join(dst, "config.json"), JSON.stringify(cfg), "utf8");
const t2 = Date.now();

let total = 0;
for (const f of fs.readdirSync(sessDir)) total += fs.statSync(path.join(sessDir, f)).size;
total += fs.statSync(path.join(dst, "config.json")).size;

console.log("源 config.json =", src);
console.log("沙盒 =", dst);
console.log("读 + parse 真实 config：" + (t1 - t0) + " ms；写 " + rows.length + " 份会话文件：" + (t2 - t1) + " ms");
console.log(
  "沙盒 config.json = " + (fs.statSync(path.join(dst, "config.json")).size / 1024).toFixed(1) + " KB" +
    "；index.json = " + (fs.statSync(path.join(sessDir, "index.json")).size / 1024).toFixed(1) + " KB" +
    "；会话 " + rows.length + " 份 / 合计 " + (total / 1048576).toFixed(1) + " MB",
);
console.log(
  "\n接着量：" +
    "\n  node test/_perf-probe/session-save-cost.cjs 5 --dir=" + JSON.stringify(dst),
);

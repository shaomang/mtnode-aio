#!/usr/bin/env node
/* 研究初始化队列的命令行薄壳 —— 解析与状态机仍旧只有一份实现（renderer/research-core.js）。
 *
 * 为什么要有它：队列是一份 JSON，agent 直接手改容易漏字段（status / doneAt / phase），
 * 一改坏界面就卡在「处理中」。这里只做五件事：看状态、取下一条、回写一条、追加入队、给折叠文件起骨架。
 *
 * 用法（在项目根目录跑，<research> = <画布工作目录>/research）：
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs status <research>
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs next   <research>
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs set    <research> <id> <pending|running|done|failed|skipped> [说明] [--summary]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs add    <research> '<json 或 json 数组>'
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs folds  <research> <key> [源 md 相对路径]
 *
 * `add` 的每一条形如 {"role":"ref","source":"url","url":"https://arxiv.org/abs/…","title":"…","note":"…","hitBy":"检索式"}；
 * source 也可以是 text（写 text 字段）或 query（写 query 字段）。非文件项会顺带把 md 骨架写到 mdRel。
 *
 * 只有 `set` / `add` 会写盘（且只写 init-queue.json 与新增项的 md 骨架）；`folds` 把骨架打到 stdout，
 * agent 填完再自己落盘。`--summary` 用于「只抓到元数据 + 摘要」：置 fetch=summary 与 verify=doubt。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CORE = require(path.join(ROOT, "renderer", "research-core.js"));

const argv = process.argv.slice(2);
const cmd = (argv[0] || "").toLowerCase();
const rest = argv.slice(1);
const asJson = rest.includes("--json");
const summary = rest.includes("--summary");
const args = rest.filter((a) => a !== "--json" && a !== "--summary");

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}
function need(root) {
  if (!root) die("缺少 <research> 目录参数");
  const p = path.join(root, "init-queue.json");
  if (!fs.existsSync(p)) die("没有找到 " + p + "（还没初始化研究？）");
  return p;
}
function readQueue(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    die("init-queue.json 解析失败：" + e.message);
  }
}
function writeQueue(p, q) {
  fs.writeFileSync(p, JSON.stringify(q, null, 2) + "\n", "utf8");
}
function short(it) {
  return [
    it.id,
    it.role === "core" ? "核心" : "参考",
    it.status,
    it.key,
    it.title,
    "md=" + it.mdRel,
    it.foldsRel ? "folds=" + it.foldsRel : "",
    it.error ? "err=" + it.error : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

if (cmd === "status") {
  const p = need(args[0]);
  const q = readQueue(p);
  const s = CORE.initQueueStats(q);
  if (asJson) {
    console.log(JSON.stringify({ phase: q.phase, topic: q.topic, stats: s, items: q.items }, null, 2));
    process.exit(0);
  }
  console.log(
    "phase=" + (q.phase || "-") + "  课题=" + (q.topic || "-") + "  " +
      s.finished + "/" + s.total + "（pending " + s.pending + " / running " + s.running +
      " / failed " + s.failed + " / skipped " + s.skipped + "）",
  );
  for (const it of q.items || []) console.log("- " + short(it));
  process.exit(0);
}

if (cmd === "next") {
  const p = need(args[0]);
  const q = readQueue(p);
  const it = CORE.queueNextPending(q);
  if (!it) {
    console.log(CORE.queueAllDone(q) ? "ALL-DONE" : "NO-PENDING");
    process.exit(0);
  }
  console.log(JSON.stringify(it, null, 2));
  process.exit(0);
}

if (cmd === "set") {
  const p = need(args[0]);
  const id = args[1];
  const status = (args[2] || "").toLowerCase();
  const msg = args[3] || "";
  if (!id || !status) die("用法：set <research> <id> <status> [说明]");
  if (CORE.INIT_STATUS.indexOf(status) < 0) die("status 只能是 " + CORE.INIT_STATUS.join(" / "));
  let q = readQueue(p);
  const hit = (q.items || []).find((x) => x.id === id);
  if (!hit) die("队列里没有 " + id);
  const now = Date.now();
  const patch = { status, error: status === "failed" ? msg || "失败" : "" };
  if (status === "running") {
    patch.startedAt = now;
    patch.attempts = (hit.attempts || 0) + 1;
    q.phase = "running";
  }
  if (status === "done" || status === "skipped") patch.doneAt = now;
  if (status === "done" && summary && hit.source !== "file") {
    patch.fetch = "summary";
    patch.verify = "doubt";
  }
  if (status === "running" && hit.source !== "file") patch.fetch = "pending";
  q = CORE.queueUpdate(q, id, patch);
  if (CORE.queueAllDone(q)) q.phase = "done";
  writeQueue(p, q);
  const s = CORE.initQueueStats(q);
  console.log("OK " + id + " → " + status + "  （" + s.finished + "/" + s.total + "）");
  process.exit(0);
}

if (cmd === "add") {
  const root = args[0];
  const raw = args[1];
  if (!root || !raw) die("用法：add <research> '<json 或 json 数组>'");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    die("第二个参数要是 JSON：" + e.message);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.length) die("没有要追加的条目");
  const queuePath = need(root);
  const prev = readQueue(queuePath);
  const haveRel = new Set((prev.items || []).map((x) => x.mdRel).filter(Boolean));
  /* 追加的条目也走同一份内核算 id / mdRel / key，别在脚本里另算一套 */
  const builtAll = CORE.buildInitQueue({ items: list }).items;
  const built = builtAll.filter((x) => !haveRel.has(x.mdRel));
  const skipped = builtAll.length - built.length;
  if (!built.length) {
    console.log("没有新增（这些条目已经在队列里）");
    process.exit(0);
  }
  for (const it of built) {
    if (!it.source || it.source === "file") continue;
    const abs = path.join(root, it.mdRel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, CORE.initFetchDoc(it), "utf8");
  }
  const q = CORE.initQueueAppend(prev, built);
  writeQueue(queuePath, q);
  const s = CORE.initQueueStats(q);
  const added = q.items.slice(Math.max(0, q.items.length - built.length));
  if (asJson) {
    console.log(JSON.stringify({ added: added.map((x) => x.id), skipped, stats: s, items: q.items }, null, 2));
    process.exit(0);
  }
  console.log(
    "OK 追加 " + added.length + " 条：" + added.map((x) => x.id + "(" + x.source + ")").join(", ") +
      (skipped ? "；跳过 " + skipped + " 条重复" : "") + "  （" + s.finished + "/" + s.total + "）",
  );
  process.exit(0);
}

if (cmd === "folds") {
  const root = args[0];
  const key = args[1];
  if (!root || !key) die("用法：folds <research> <key> [源 md 相对路径]");
  const rel = args[2] || "";
  let body = "";
  if (rel) {
    const f = path.join(root, rel);
    if (fs.existsSync(f)) body = fs.readFileSync(f, "utf8");
  }
  /* 段落骨架：按空行切段，每段一个 p000N，三层的槽位先摆好，agent 只填内容 */
  const paras = [];
  if (body) {
    const blocks = body
      .replace(/\r/g, "")
      .split(/\n{2,}/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const b of blocks) {
      if (/^#{1,2}\s/.test(b)) continue; /* 大标题不进段落层 */
      paras.push({ id: "p" + String(paras.length + 1).padStart(4, "0"), anchor: "", full: b, quote: "", topic: "" });
    }
  }
  const md = CORE.foldsToMarkdown({
    key,
    title: key,
    source: rel || key,
    map: [],
    paragraphs: paras,
  });
  process.stdout.write(md);
  process.exit(0);
}

die(
  "用法：\n" +
    "  research-queue.mjs status <research>\n" +
    "  research-queue.mjs next   <research>\n" +
    "  research-queue.mjs set    <research> <id> <status> [说明] [--summary]\n" +
    "  research-queue.mjs add    <research> '<json 或 json 数组>'\n" +
    "  research-queue.mjs folds  <research> <key> [源 md 相对路径]",
);

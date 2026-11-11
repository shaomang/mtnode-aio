#!/usr/bin/env node
/* 研究初始化队列的命令行薄壳 —— 解析与状态机仍旧只有一份实现（renderer/research-core.js）。
 *
 * 为什么要有它：队列是一份 JSON，agent 直接手改容易漏字段（status / doneAt / phase），
 * 一改坏界面就卡在「处理中」。这里只做六件事：看状态、取下一条、回写一条、追加入队、
 * 给折叠文件起骨架（可预填）、体检整轮还差什么。
 *
 * 用法（在项目根目录跑，<research> = <画布工作目录>/research）：
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs status <research>
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs next   <research>
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs set    <research> <id> <pending|running|done|failed|skipped> [说明] [--summary]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs add    <research> '<json 或 json 数组>'
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs folds  <research> <key> [源 md 相对路径] [--write]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs folds  check <research> [key]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs doctor <research>
 *
 * `add` 的每一条形如 {"role":"ref","source":"url","url":"https://arxiv.org/abs/…","title":"…","note":"…","hitBy":"检索式"}；
 * source 也可以是 text（写 text 字段）或 query（写 query 字段）。非文件项会顺带把 md 骨架写到 mdRel。
 *
 * 只有 `set` / `add` / `folds --write` 会写盘（只写 init-queue.json、新增项的 md 骨架、
 * 折叠文件、以及 done 时笔记 frontmatter 的 init 标记）。`--summary` 用于「只抓到元数据 + 摘要」：
 * 置 fetch=summary 与 verify=doubt。
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
const writeFlag = rest.includes("--write");
const args = rest.filter((a) => a !== "--json" && a !== "--summary" && a !== "--write");

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
    /* 带 BOM 的 JSON（PowerShell / 记事本存出来的）也认，不然整条队列看起来「坏了」 */
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
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

/* 取 JSON 载荷：内联 / '@文件' / '-'（从管道读）/ 直接给 .json 路径。
   PowerShell、cmd 会把内联 JSON 的双引号吃掉（真机踩过：`{ "a": 1 }` 传到 node 变成 `{ a: 1 }`），
   所以长载荷优先走 '-' 或 '@文件'，别再让 agent 为了绕引号去写临时脚本。 */
function readPayload(arg) {
  const s = String(arg || "");
  /* PowerShell 管道会带 UTF-8 BOM，JSON.parse 会被它噎住，先剥掉 */
  const clean = (t) => String(t || "").replace(/^\uFEFF/, "");
  if (s === "-" || s === "--stdin") return clean(fs.readFileSync(0, "utf8"));
  if (s.startsWith("@")) {
    const p = s.slice(1);
    if (!fs.existsSync(p)) die("文件不存在：" + p);
    return clean(fs.readFileSync(p, "utf8"));
  }
  if (/\.json$/i.test(s) && fs.existsSync(s)) return clean(fs.readFileSync(s, "utf8"));
  return clean(s);
}

/* ── 已处理标记：笔记 frontmatter 的 init: done / initAt ──
   队列项 status 与笔记标记是「已处理」的两条依据，界面靠这两个打 ✓ 徽标；
   以前处理完一项还得再手工 edit 一次笔记，漏写一条就少一个 ✓。 */
function markNoteInit(root, rel, at) {
  const r = String(rel || "").trim();
  if (!r) return "";
  const abs = path.join(root, r);
  if (!fs.existsSync(abs)) return "";
  const md = fs.readFileSync(abs, "utf8");
  if (CORE.noteProcessed(md)) return r;
  const fm = CORE.parseFrontmatter(md);
  const meta = Object.assign({}, fm.meta, { init: "done", initAt: at });
  fs.writeFileSync(abs, CORE.stringifyFrontmatter(meta, fm.body), "utf8");
  return r;
}

/* 段落首句（逐字截取、不改写；超长才在截断处留省略号，方便一眼看出被截过） */
function firstSentence(text, cap) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  /* 中文句末直接认；英文 . ! ? 只有后面是空白/结尾才算（否则 `[!note]` 会被当成句末） */
  const m =
    /^[\s\S]*?[。！？；]/.exec(s) ||
    /^[\s\S]*?[.!?](?=\s|$)/.exec(s);
  let q = (m ? m[0] : s).trim();
  const limit = cap || 160;
  if (q.length > limit) q = q.slice(0, limit).replace(/[\s，,、；;：:]+$/, "") + "…";
  return q;
}

/* 折叠文件体检：三层里哪层还是「—」、段落 id 有没有错位（界面靠 id 对齐，错位就串行） */
function foldsCheck(root, onlyKey) {
  const dir = path.join(root, "literature", "folds");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort()) {
    const key = name.replace(/\.md$/i, "");
    if (onlyKey && onlyKey !== key && onlyKey !== name) continue;
    const md = fs.readFileSync(path.join(dir, name), "utf8");
    const model = CORE.parseFolds(md);
    const ps = model.paragraphs || [];
    const blank = (v) => !String(v == null ? "" : v).trim() || String(v).trim() === "—";
    const badIds = [];
    ps.forEach((p, i) => {
      const bare = String(p.id || "").replace(/^.*#/, "");
      if (bare !== "p" + String(i + 1).padStart(4, "0")) badIds.push(p.id);
    });
    /* 节级三档（同一份折叠文件里的 `# 节级三档` 段）：0 节 = 老折叠，还没补过 */
    const secs = model.sections || [];
    out.push({
      key,
      file: "literature/folds/" + name,
      paragraphs: ps.length,
      missing: {
        full: ps.filter((p) => blank(p.full)).length,
        quote: ps.filter((p) => blank(p.quote)).length,
        topic: ps.filter((p) => blank(p.topic)).length,
      },
      badIds,
      sections: secs.length,
      sectionMissing: {
        one: secs.filter((s) => blank(s.one)).length,
        para: secs.filter((s) => blank(s.para)).length,
      },
      /* 骨架里的「还没有章节地图」是占位行，不算真的地图 */
      map: (model.map || []).filter((x) => !/还没有章节地图/.test(String(x.title || ""))).length,
    });
  }
  return out;
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
  /* 队列项与笔记标记是「已处理」的两条依据，界面两边都看；done 时顺手把笔记那条也写掉 */
  const marked = status === "done" ? markNoteInit(args[0], hit.noteRel, patch.doneAt || now) : "";
  const s = CORE.initQueueStats(q);
  console.log(
    "OK " + id + " → " + status + "  （" + s.finished + "/" + s.total + "）" +
      (marked ? "；已写 init 标记 " + marked : ""),
  );
  process.exit(0);
}

if (cmd === "add") {
  const root = args[0];
  if (!root || !args[1]) die("用法：add <research> '<json>' | add <research> - < payload.json | add <research> @payload.json");
  let parsed = null;
  try {
    parsed = JSON.parse(readPayload(args[1]));
  } catch (e) {
    die("第二个参数要是 JSON（或 '-'/'@文件'）：" + e.message);
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
  /* 体检：folds check <research> [key] —— 三层哪层还是「—」、段落 id 有没有错位 */
  if ((args[0] || "").toLowerCase() === "check") {
    const root = args[1];
    if (!root) die("用法：folds check <research> [key]");
    const list = foldsCheck(root, args[2] || "");
    if (asJson) {
      console.log(JSON.stringify(list, null, 2));
      process.exit(0);
    }
    if (!list.length) {
      console.log("没有折叠文件（literature/folds/ 是空的）");
      process.exit(0);
    }
    let bad = 0;
    for (const f of list) {
      const gaps = f.missing.full + f.missing.quote + f.missing.topic;
      const secGaps = f.sectionMissing.one + f.sectionMissing.para;
      bad += gaps + f.badIds.length + secGaps;
      console.log(
        "- " + f.key + "  段落 " + f.paragraphs +
          "  空槽 全文" + f.missing.full + " / 原句" + f.missing.quote + " / 主题" + f.missing.topic +
          (f.badIds.length
            ? "  段落 id 错位 " + f.badIds.slice(0, 3).join(",") + (f.badIds.length > 3 ? "…" : "")
            : "") +
          "  主题地图 " + f.map + " 节",
      );
      console.log(
        "    节级三档 " + f.sections + " 节" +
          (f.sections
            ? "  空槽 一句话" + f.sectionMissing.one + " / 一段话" + f.sectionMissing.para
            : "  （还没有 `# 节级三档`：老折叠，界面切不到「一句话 / 一段话」）"),
      );
    }
    console.log(bad ? "合计缺口 " + bad + " 处" : "三层全满，段落 id 对齐");
    process.exit(bad ? 1 : 0);
  }
  const root = args[0];
  const key = args[1];
  if (!root || !key) die("用法：folds <research> <key> [源 md 相对路径] [--write] | folds check <research> [key]");
  const rel = args[2] || "";
  let body = "";
  if (rel) {
    const f = path.join(root, rel);
    if (fs.existsSync(f)) body = fs.readFileSync(f, "utf8");
  }
  /* frontmatter 不是「原文段落」：剥掉再切段，否则 YAML 会占掉 p0001、还把整串键塞进关键原句 */
  if (body) body = CORE.parseFrontmatter(body).body || "";
  /* 段落骨架：按空行切段，每段一个 p000N，三层的槽位先摆好，agent 只填内容。
     「关键原句」按段首句**逐字**预填（不改写、截断处留 …），省掉逐段重写同一句话的 token；
     「主题」留空（那是判断，不是抄写，必须人/agent 定）。 */
  const paras = [];
  if (body) {
    const blocks = body
      .replace(/\r/g, "")
      .split(/\n{2,}/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const b of blocks) {
      if (/^#{1,2}\s/.test(b)) continue; /* 大标题不进段落层 */
      paras.push({
        id: "p" + String(paras.length + 1).padStart(4, "0"),
        anchor: "",
        full: b,
        quote: firstSentence(b),
        topic: "",
      });
    }
  }
  /* 节级三档：按原文 `##` 小节切，id 与锚点由内核统一算（界面按 s0001… 钉档，错位就串档） */
  const secs = [];
  if (body) {
    for (const s of CORE.sectionsFromDoc(body) || []) {
      secs.push({ id: s.id, anchor: s.anchor, one: "", para: "", full: s.full });
    }
  }
  const md = CORE.foldsToMarkdown({
    key,
    title: key,
    source: rel || key,
    map: [],
    paragraphs: paras,
    /* 节级三档的骨架（与三层折叠同一份文件、同一批原文）：按 `##` 小节切，一句话 / 一段话留空
       等 agent 填，原文照抄预填 —— 界面切「原文」档时读的就是这一份，所以必须真写进文件。 */
    secLevel: "para",
    sections: secs,
  });
  if (writeFlag) {
    /* 目标路径优先用队列项里已经约定好的 foldsRel（界面按它显示），没约定才按 key 惯例 */
    let outRel = "literature/folds/" + key + ".md";
    const qPath = path.join(root, "init-queue.json");
    if (fs.existsSync(qPath)) {
      try {
        const q = JSON.parse(fs.readFileSync(qPath, "utf8"));
        const hit = (q.items || []).find(
          (it) => it.key === key || it.foldsRel === outRel || String(it.foldsRel || "").replace(/\.md$/i, "") === outRel.replace(/\.md$/i, ""),
        );
        if (hit && hit.foldsRel) outRel = hit.foldsRel;
      } catch (_) {}
    }
    const abs = path.join(root, outRel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, md, "utf8");
    console.log(
      "OK " + paras.length + " 段 → " + outRel + "（关键原句已按首句预填，主题留空待填）",
    );
    if (secs.length) console.log("   节级三档 " + secs.length + " 节（原文已填，一句话 / 一段话留空待填）");
    process.exit(0);
  }
  process.stdout.write(md);
  process.exit(0);
}

/* 一轮跑完到底还差什么：队列状态、文件缺没缺、笔记 init 标记、折叠空槽、phase 是否对得上、
   文献库有没有缺 DOI/arXiv。以前这些得一项项肉眼查（本次就漏了 init 标记与 153 处空槽）。 */
if (cmd === "doctor") {
  const root = args[0];
  const q = readQueue(need(root));
  const s = CORE.initQueueStats(q);
  const rows = [];
  const existsRel = (r) => {
    try {
      return !!r && fs.existsSync(path.join(root, r));
    } catch (_) {
      return false;
    }
  };
  for (const it of q.items || []) {
    const tag = it.id + " " + (it.status || "?");
    if (it.status === "pending") rows.push("待处理    " + tag + "  " + (it.title || it.key || ""));
    else if (it.status === "running")
      rows.push("卡running " + tag + "  （忘了回写？再 set " + it.id + " done|failed）");
    else if (it.status === "failed") rows.push("失败      " + tag + "  err=" + (it.error || "-"));
    if (it.mdRel && !existsRel(it.mdRel)) rows.push("缺正文    " + tag + "  → " + it.mdRel);
    if (it.noteRel) {
      if (!existsRel(it.noteRel)) rows.push("缺笔记    " + tag + "  → " + it.noteRel);
      else if (!CORE.noteProcessed(fs.readFileSync(path.join(root, it.noteRel), "utf8")))
        rows.push("缺标记    " + tag + "  " + it.noteRel + " 没有 init: done");
    }
    if (it.foldsRel && !existsRel(it.foldsRel)) rows.push("缺折叠    " + tag + "  → " + it.foldsRel);
  }
  if (CORE.queueAllDone(q) && q.phase !== "done") rows.push("phase     " + q.phase + " 但全部已完成 → 应收尾置 done");
  if (!CORE.queueAllDone(q) && q.phase === "done") rows.push("phase     done 但还有未完成项");
  for (const f of foldsCheck(root, "")) {
    const gaps = f.missing.full + f.missing.quote + f.missing.topic;
    if (gaps || f.badIds.length)
      rows.push(
        "折叠空槽  " + f.key + "  全文" + f.missing.full + " 原句" + f.missing.quote +
          " 主题" + f.missing.topic + (f.badIds.length ? "  id 错位 " + f.badIds.length + " 段" : ""),
      );
    if (!f.sections) rows.push("缺节级" + "  " + f.key + "  " + f.file + " 没有 `# 节级三档`（界面切不到一句话 / 一段话）");
    else if (f.sectionMissing.one || f.sectionMissing.para)
      rows.push(
        "节级空槽  " + f.key + "  一句话" + f.sectionMissing.one + " 一段话" + f.sectionMissing.para +
          "（共 " + f.sections + " 节）",
      );
  }
  /* 术语页与 3-Pass 变体：初始化该产出、但老库没有的两块 */
  const termDir = path.join(root, "terms");
  const termCount = fs.existsSync(termDir)
    ? fs.readdirSync(termDir).filter((n) => /\.md$/i.test(n)).length
    : 0;
  const coreDir = path.join(root, "core");
  const coreMd = fs.existsSync(coreDir) ? fs.readdirSync(coreDir).filter((n) => /\.md$/i.test(n)) : [];
  if (!termCount) rows.push("缺术语    terms/ 里还没有术语页（初始化应归纳出第一层；老库可点「补跑一层」）");
  for (const n of coreMd) {
    if (/\.(zh|en|skim|concept|tech|summary|excerpt)\.md$/i.test(n)) continue;
    const stem = n.replace(/\.md$/i, "");
    const miss = ["skim", "concept", "tech"].filter((k) => !fs.existsSync(path.join(coreDir, stem + "." + k + ".md")));
    if (miss.length === 3) rows.push("缺变体    core/" + n + "  还没有 3-Pass 变体（" + miss.join(" / ") + "）");
  }
  const libPath = path.join(root, "literature", "library.json");
  if (fs.existsSync(libPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(libPath, "utf8"));
      const lib = Array.isArray(j) ? j : j.items || [];
      const noId = lib.filter((x) => !x.DOI && !x.arxiv && !/arxiv|doi/i.test(String(x.URL || "")));
      if (noId.length)
        rows.push("文献缺号  " + noId.length + " 条没有 DOI/arXiv（用 lib add 补：" + noId.slice(0, 3).map((x) => x.citeKey || x.title || "?").join(", ") + "）");
    } catch (e) {
      rows.push("文献库    library.json 解析失败：" + e.message);
    }
  }
  if (asJson) {
    console.log(JSON.stringify({ phase: q.phase, stats: s, issues: rows }, null, 2));
    process.exit(0);
  }
  console.log(
    "phase=" + (q.phase || "-") + "  " + s.finished + "/" + s.total +
      "（pending " + s.pending + " / running " + s.running + " / failed " + s.failed + " / skipped " + s.skipped + "）",
  );
  if (!rows.length) console.log("体检通过：没有待办");
  else for (const r of rows) console.log("- " + r);
  console.log(rows.length ? "待办 " + rows.length + " 条" : "待办 0 条");
  process.exit(0);
}

die(
  "用法：\n" +
    "  research-queue.mjs status  <research>\n" +
    "  research-queue.mjs next    <research>\n" +
    "  research-queue.mjs set     <research> <id> <status> [说明] [--summary]\n" +
    "  research-queue.mjs add     <research> '<json>' | -（管道）| @文件.json\n" +
    "  research-queue.mjs folds   <research> <key> [源 md 相对路径] [--write]\n" +
    "  research-queue.mjs folds   check <research> [key]\n" +
    "  research-queue.mjs doctor  <research>",
);

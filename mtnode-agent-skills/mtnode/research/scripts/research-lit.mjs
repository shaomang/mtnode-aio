#!/usr/bin/env node
/* 研究画布的文献 / 图谱命令行 —— 薄壳，真正干活的是 renderer/research-core.js。
 *
 * 为什么是薄壳：解析与图算法只有一份实现（UMD，渲染层与 Node 共用），
 * 这个脚本只做「读目录 / 抓网络 / 打印」，避免每次调研都重新写一套解析逻辑浪费 token。
 *
 * 用法（在项目根目录跑）：
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs graph  <research目录> [--json]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs note   <research目录> <笔记相对路径>
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs ls     <research目录> [--json]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs search <crossref|arxiv|s2> <关键词> [条数]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs doi    <DOI>
 *
 * 只读：本脚本**不写**任何文件（要入库请在研究视图里导入，或把输出贴给 agent 落盘）。
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
const rest = argv.slice(1).filter((a) => a !== "--json");
const asJson = argv.includes("--json");

function die(msg) {
  console.error("错误：" + msg);
  process.exit(2);
}

/* ── 读库 ── */
function walkMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMd(p));
    else if (ent.isFile() && /\.md$/i.test(ent.name)) out.push(p);
  }
  return out;
}

function loadVault(researchDir) {
  if (!researchDir) die("缺少 research 目录");
  const root = path.resolve(researchDir);
  if (!fs.existsSync(root)) die("目录不存在：" + root);
  const notesDir = path.join(root, "notes");
  const base = fs.existsSync(notesDir) ? notesDir : root;
  const files = walkMd(base);
  const docs = files.map((abs) => ({
    path: path.relative(base, abs).replace(/\\/g, "/"),
    md: fs.readFileSync(abs, "utf8"),
  }));
  const libPath = path.join(root, "literature", "library.json");
  let library = [];
  if (fs.existsSync(libPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(libPath, "utf8"));
      library = Array.isArray(j) ? j : Array.isArray(j.items) ? j.items : [];
    } catch (e) {
      console.error("警告：library.json 解析失败，按空库继续（" + e.message + "）");
    }
  }
  CORE.assignCiteKeys(library);
  const graph = CORE.buildGraph(docs, { library });
  return { root, base, docs, library, graph };
}

/* ── graph ── */
function cmdGraph(dir) {
  const { graph, library, base } = loadVault(dir);
  const st = CORE.stats(graph);
  const missing = graph.nodes.filter((n) => n.kind === "paper" && n.missingItem).map((n) => n.citeKey);
  const dangling = graph.nodes.filter((n) => n.kind === "concept" && n.missing).map((n) => n.label);
  const unverified = graph.nodes.filter((n) => n.kind === "claim" && n.verify === "unverified").length;
  const payload = {
    root: base,
    nodes: st.nodes,
    edges: st.edges,
    kinds: st.byKind,
    library: library.length,
    missingCiteKeys: [...new Set(missing)].sort(),
    danglingLinks: [...new Set(dangling)].sort(),
    unverifiedClaims: unverified,
    verify: graph.nodes
      .filter((n) => n.kind === "claim")
      .reduce((m, n) => ((m[n.verify] = (m[n.verify] || 0) + 1), m), {}),
  };
  if (asJson) return console.log(JSON.stringify(payload, null, 2));
  console.log("目录      " + payload.root);
  console.log("节点/边   " + payload.nodes + " / " + payload.edges);
  console.log("种类      " + Object.entries(payload.kinds).map(([k, v]) => k + "=" + v).join(" "));
  console.log("文献库    " + payload.library + " 条");
  console.log("论断验证  " + JSON.stringify(payload.verify) + (unverified ? "（未验证 " + unverified + " 条）" : ""));
  if (payload.missingCiteKeys.length)
    console.log("缺口1 引用键不在文献库：" + payload.missingCiteKeys.join(", "));
  if (payload.danglingLinks.length)
    console.log("缺口2 悬空 wikilink：" + payload.danglingLinks.join(", "));
  if (!payload.missingCiteKeys.length && !payload.danglingLinks.length) console.log("缺口      无");
}

/* ── note ── */
function cmdNote(dir, rel) {
  if (!rel) die("缺少笔记相对路径");
  const { base } = loadVault(dir);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(path.resolve(base))) die("路径越界：" + rel);
  if (!fs.existsSync(abs)) die("笔记不存在：" + abs);
  const r = CORE.parseNote({ path: rel.replace(/\\/g, "/"), md: fs.readFileSync(abs, "utf8") });
  if (asJson) return console.log(JSON.stringify(r, null, 2));
  console.log("笔记   " + r.note.label + "（" + r.note.kind + " · " + r.note.verify + "）");
  if (r.note.tags.length) console.log("标签   " + r.note.tags.join(", "));
  console.log("节点   " + r.nodes.length + " 个，边 " + r.edges.length + " 条");
  for (const n of r.nodes.slice(0, 40)) {
    const where = n.line ? " :" + n.line : "";
    console.log("  · [" + n.kind + "] " + (n.label || n.id) + where);
  }
  if (r.nodes.length > 40) console.log("  … 其余 " + (r.nodes.length - 40) + " 个");
}

/* ── ls ── */
function cmdLs(dir) {
  const { library } = loadVault(dir);
  if (asJson) return console.log(JSON.stringify(library, null, 2));
  if (!library.length) return console.log("文献库是空的（在画布「文献」页签粘贴 BibTeX / 按 DOI 取）");
  for (const it of library) {
    console.log(
      [
        CORE.citeKeyOf(it),
        CORE.yearOf(it) || "----",
        CORE.itemTitle(it) || "(无标题)",
        CORE.itemAuthorsShort(it) || "",
        it.DOI ? "doi:" + it.DOI : "",
      ]
        .filter(Boolean)
        .join("  |  "),
    );
  }
}

/* ── 网络检索 ── */
async function getJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "MTNodeAIO/1.1 (research-lit; mailto:noreply@mt-agent.com)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json();
}

async function searchCrossref(q, n) {
  const j = await getJson(
    "https://api.crossref.org/works?rows=" + n + "&query=" + encodeURIComponent(q),
  );
  return (j.message.items || []).map((m) => ({
    title: (m.title || [""])[0],
    author: (m.author || []).map((a) => [a.family, a.given].filter(Boolean).join(", ")),
    containerTitle: (m["container-title"] || [""])[0],
    issued: m.issued,
    DOI: m.DOI,
    URL: m.URL,
    type: m.type,
  }));
}

async function searchArxiv(q, n) {
  const r = await fetch(
    "http://export.arxiv.org/api/query?search_query=all:" +
      encodeURIComponent(q) +
      "&max_results=" +
      n,
    { headers: { "User-Agent": "MTNodeAIO/1.1" }, signal: AbortSignal.timeout(20000) },
  );
  if (!r.ok) throw new Error("HTTP " + r.status);
  const xml = await r.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  const tag = (src, t) => {
    const m = new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">").exec(src);
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  };
  return entries.map((e) => ({
    title: tag(e, "title"),
    author: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()),
    arxiv: (tag(e, "id").match(/abs\/([^/]+)$/) || [])[1] || "",
    issued: { "date-parts": [[Number((tag(e, "published") || "").slice(0, 4)) || 0]] },
    URL: tag(e, "id"),
    abstract: tag(e, "summary"),
    type: "article",
  }));
}

async function searchS2(q, n) {
  const j = await getJson(
    "https://api.semanticscholar.org/graph/v1/paper/search?limit=" +
      n +
      "&fields=title,authors,year,externalIds,url,abstract,venue&query=" +
      encodeURIComponent(q),
  );
  return (j.data || []).map((p) => ({
    title: p.title,
    author: (p.authors || []).map((a) => a.name),
    containerTitle: p.venue || "",
    issued: { "date-parts": [[p.year || 0]] },
    DOI: (p.externalIds || {}).DOI || "",
    arxiv: (p.externalIds || {}).ArXiv || "",
    URL: p.url,
    abstract: p.abstract || "",
    type: "article",
  }));
}

async function cmdSearch(src, q, n) {
  if (!q) die("缺少检索词");
  const rows = Math.max(1, Math.min(25, Number(n) || 5));
  const kind = (src || "crossref").toLowerCase();
  let items;
  try {
    items =
      kind === "arxiv"
        ? await searchArxiv(q, rows)
        : kind === "s2" || kind === "semantic"
          ? await searchS2(q, rows)
          : await searchCrossref(q, rows);
  } catch (e) {
    die("检索失败（网络不可达或接口限流）：" + e.message);
  }
  CORE.assignCiteKeys(items);
  if (asJson) return console.log(JSON.stringify(items, null, 2));
  for (const it of items) {
    console.log(
      [
        CORE.citeKeyOf(it),
        CORE.yearOf(it) || "----",
        CORE.itemTitle(it),
        CORE.itemAuthorsShort(it),
        it.DOI ? "doi:" + it.DOI : it.arxiv ? "arxiv:" + it.arxiv : "",
      ]
        .filter(Boolean)
        .join("  |  "),
    );
  }
  console.log("\n（以上为候选；确认后再入文献库，引用写 [@key]。加 --json 拿完整 CSL-JSON。）");
}

async function cmdDoi(doi) {
  if (!doi) die("缺少 DOI");
  const clean = String(doi).replace(/^https?:\/\/doi\.org\//i, "").trim();
  let item;
  try {
    const j = await getJson("https://api.crossref.org/works/" + encodeURIComponent(clean));
    const m = j.message || {};
    item = {
      title: (m.title || [""])[0],
      author: (m.author || []).map((a) => [a.family, a.given].filter(Boolean).join(", ")),
      containerTitle: (m["container-title"] || [""])[0],
      issued: m.issued,
      DOI: m.DOI || clean,
      URL: m.URL || "https://doi.org/" + clean,
      type: m.type,
      abstract: m.abstract || "",
    };
  } catch (e) {
    die("DOI 查询失败：" + e.message);
  }
  CORE.assignCiteKeys([item]);
  if (asJson) return console.log(JSON.stringify(item, null, 2));
  console.log(JSON.stringify(item, null, 2));
  console.log("\nBibTeX：\n" + CORE.cslToBibtex(item));
}

/* ── 分发 ── */
try {
  if (cmd === "graph") cmdGraph(rest[0]);
  else if (cmd === "note") cmdNote(rest[0], rest[1]);
  else if (cmd === "ls") cmdLs(rest[0]);
  else if (cmd === "search") await cmdSearch(rest[0], rest[1], rest[2]);
  else if (cmd === "doi") await cmdDoi(rest[0]);
  else {
    console.log(
      [
        "研究画布 · 文献与图谱工具",
        "",
        "  graph  <research目录> [--json]        整库体检：计数 / kind 分布 / 缺文献 / 悬空链接",
        "  note   <research目录> <笔记相对路径>  单篇解析：节点、边、验证状态",
        "  ls     <research目录> [--json]        文献库清单",
        "  search <crossref|arxiv|s2> <词> [n]   在线检索候选（不入库）",
        "  doi    <DOI>                          按 DOI 取准元数据 + BibTeX",
      ].join("\n"),
    );
    process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  die(String((e && e.stack) || e));
}

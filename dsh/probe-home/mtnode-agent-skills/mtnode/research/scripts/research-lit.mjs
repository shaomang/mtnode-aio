#!/usr/bin/env node
/* 研究画布的文献 / 图谱命令行 —— 薄壳，真正干活的是 renderer/research-core.js。
 *
 * 为什么是薄壳：解析与图算法只有一份实现（UMD，渲染层与 Node 共用），
 * 这个脚本只做「读目录 / 抓网络 / 打印」，避免每次调研都重新写一套解析逻辑浪费 token。
 *
 * 用法（在项目根目录跑）：
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs graph  <research目录> [--json] [--write]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs note   <research目录> <笔记相对路径>
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs ls     <research目录> [--json]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs search <crossref|arxiv|s2> <关键词> [条数]
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs doi    <DOI>
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs lib    <research目录> add '<CSL-JSON|数组>'
 *   node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs lib    <research目录> add --doi <DOI>
 *
 * 写盘只有两处：`graph --write` 落 graph.json（与界面「转为图谱」同一份 buildGraph + pruneGraph），
 * `lib add` 落 literature/library.json。其余命令只读 —— 别再自己写解析、也别手写 graph.json。
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
const rest = argv.slice(1).filter((a) => a !== "--json" && a !== "--write");
const asJson = argv.includes("--json");
const writeGraph = argv.includes("--write");

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

/* 笔记真源 = notes/（含一层子目录）+ core/，再按 frontmatter 的 parent / parents 递归补齐。
   这与渲染层 rsLoadNotes + buildFullGraph 是同一口径：只扫 notes/ 会把 core/ 里的主稿判成
   悬空 wikilink（真机踩过：主稿明明存在，体检却报「悬空」），也会漏掉 parents 指过去的子笔记。 */
function collectDocs(root) {
  const dirs = ["notes", "core"];
  try {
    for (const ent of fs.readdirSync(path.join(root, "notes"), { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const rel = "notes/" + ent.name;
      if (dirs.indexOf(rel) < 0) dirs.push(rel);
    }
  } catch (_) {}
  const docs = [];
  const seen = new Set();
  const push = (rel, md) => {
    const key = rel.replace(/\\/g, "/");
    if (seen.has(key)) return null;
    seen.add(key);
    const doc = { path: key, md };
    docs.push(doc);
    return doc;
  };
  for (const relDir of dirs) {
    for (const abs of walkMd(path.join(root, relDir))) {
      push(path.relative(root, abs).replace(/\\/g, "/"), fs.readFileSync(abs, "utf8"));
    }
  }
  /* parents 递归：候选顺序与 buildGraph 的 noteRefId 一致（裸名 / +md / notes/ / core/） */
  for (let i = 0; i < docs.length; i++) {
    const parsed = CORE.parseNote(docs[i]);
    for (const ref of (parsed.note && parsed.note.parents) || []) {
      const raw = String(ref || "").trim();
      if (!raw) continue;
      const cands = [CORE.normRel(raw)];
      if (!/\.md$/i.test(raw)) cands.push(CORE.normRel(raw + ".md"));
      for (const dir of ["notes/", "core/"]) {
        cands.push(CORE.normRel(dir + raw));
        if (!/\.md$/i.test(raw)) cands.push(CORE.normRel(dir + raw + ".md"));
      }
      for (const c of cands) {
        if (!c || seen.has(c)) continue;
        const abs = path.join(root, c);
        if (!fs.existsSync(abs) || !/\.md$/i.test(abs)) continue;
        push(c, fs.readFileSync(abs, "utf8"));
        break;
      }
    }
  }
  return docs;
}

function loadVault(researchDir) {
  if (!researchDir) die("缺少 research 目录");
  const root = path.resolve(researchDir);
  if (!fs.existsSync(root)) die("目录不存在：" + root);
  const docs = collectDocs(root);
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
  /* 与界面 rsRebuildGraph 同一条路：buildGraph → pruneGraph（裁掉指向已删文件的边） */
  const graph = CORE.pruneGraph(CORE.buildGraph(docs, { library }), docs.map((d) => d.path));
  return { root, docs, library, graph };
}

/* ── graph ── */
function cmdGraph(dir, write) {
  const { graph, library, root, docs } = loadVault(dir);
  const st = CORE.stats(graph);
  const missing = graph.nodes.filter((n) => n.kind === "paper" && n.missingItem).map((n) => n.citeKey);
  const dangling = graph.nodes.filter((n) => n.kind === "concept" && n.missing).map((n) => n.label);
  /* 悬空断言：claim 一条出边都没有 —— 技能要求「每条 claim 至少一条出边」，这里替人查 */
  const outdeg = new Map();
  for (const e of graph.edges || []) outdeg.set(e.from, (outdeg.get(e.from) || 0) + 1);
  const orphanClaims = graph.nodes
    .filter((n) => n.kind === "claim" && !(outdeg.get(n.id) || 0))
    .map((n) => n.label || n.id);
  const unverified = graph.nodes.filter((n) => n.kind === "claim" && n.verify === "unverified").length;
  const payload = {
    root,
    docs: docs.length,
    nodes: st.nodes,
    edges: st.edges,
    kinds: st.byKind,
    library: library.length,
    missingCiteKeys: [...new Set(missing)].sort(),
    danglingLinks: [...new Set(dangling)].sort(),
    orphanClaims: [...new Set(orphanClaims)].sort(),
    unverifiedClaims: unverified,
    verify: graph.nodes
      .filter((n) => n.kind === "claim")
      .reduce((m, n) => ((m[n.verify] = (m[n.verify] || 0) + 1), m), {}),
    written: "",
  };
  if (write) {
    /* 与界面 rsRebuildGraph 落盘同一份形状：{ver,builtAt,nodes,edges}（不含 Map 字段） */
    const target = path.join(root, "graph.json");
    fs.writeFileSync(
      target,
      JSON.stringify({ ver: graph.ver, builtAt: graph.builtAt, nodes: graph.nodes, edges: graph.edges }, null, 2) + "\n",
      "utf8",
    );
    payload.written = target;
  }
  if (asJson) return console.log(JSON.stringify(payload, null, 2));
  console.log("目录      " + payload.root);
  console.log("笔记      " + payload.docs + " 篇（notes/ + core/ + parents）");
  console.log("节点/边   " + payload.nodes + " / " + payload.edges);
  console.log("种类      " + Object.entries(payload.kinds).map(([k, v]) => k + "=" + v).join(" "));
  console.log("文献库    " + payload.library + " 条");
  console.log("论断验证  " + JSON.stringify(payload.verify) + (unverified ? "（未验证 " + unverified + " 条）" : ""));
  if (payload.missingCiteKeys.length)
    console.log("缺口1 引用键不在文献库：" + payload.missingCiteKeys.join(", "));
  if (payload.danglingLinks.length)
    console.log("缺口2 悬空 wikilink：" + payload.danglingLinks.join(", "));
  if (payload.orphanClaims.length) console.log("缺口3 只有入边/没有出边的论断：" + payload.orphanClaims.join(", "));
  if (!payload.missingCiteKeys.length && !payload.danglingLinks.length && !payload.orphanClaims.length)
    console.log("缺口      无");
  if (payload.written) console.log("已写盘    " + payload.written);
}

/* ── note ── */
function cmdNote(dir, rel) {
  if (!rel) die("缺少笔记相对路径");
  const { root } = loadVault(dir);
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base)) die("路径越界：" + rel);
  if (!fs.existsSync(abs)) die("笔记不存在：" + abs);
  const r = CORE.parseNote({ path: rel.replace(/\\/g, "/").replace(/^\.\//, ""), md: fs.readFileSync(abs, "utf8") });
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

/* 按 DOI 取准元数据（lib add 与 doi 命令共用这一份，别再各写一遍抓法） */
async function fetchDoi(rawDoi) {
  if (!rawDoi) die("缺少 DOI");
  const clean = String(rawDoi).replace(/^https?:\/\/doi\.org\//i, "").trim();
  try {
    const j = await getJson("https://api.crossref.org/works/" + encodeURIComponent(clean));
    const m = j.message || {};
    return {
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
}

async function cmdDoi(doi) {
  const item = await fetchDoi(doi);
  CORE.assignCiteKeys([item]);
  if (asJson) return console.log(JSON.stringify(item, null, 2));
  console.log(JSON.stringify(item, null, 2));
  console.log("\nBibTeX：\n" + CORE.cslToBibtex(item));
}

/* 取 JSON 载荷：内联 / '@文件' / '-'（管道）。PowerShell 与 cmd 会吃掉内联 JSON 的双引号，
   长载荷走 '-' 或 '@文件'，别为绕引号去写临时脚本。 */
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

/* ── lib：文献入库（library.json 的唯一命令行写入口） ──
   以前只能自己在研究视图里导入、或让 agent 手写 JSON —— 手写容易丢 issued / author 结构，
   还会和界面归并出的 citeKey 对不上。这里走 CORE.assignCiteKeys，重键按 Pandoc 口径补 b/c。 */
function readLibrary(root) {
  const p = path.join(root, "literature", "library.json");
  if (!fs.existsSync(p)) return { path: p, items: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { path: p, items: Array.isArray(j) ? j : Array.isArray(j.items) ? j.items : [] };
  } catch (e) {
    die("library.json 解析失败（先修它，别覆盖）：" + e.message);
  }
}

async function cmdLib(dir, sub, args) {
  if (!dir || (sub || "").toLowerCase() !== "add")
    die("用法：lib <research目录> add '<CSL-JSON|数组>'  |  lib <research目录> add --doi <DOI>");
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) die("目录不存在：" + root);
  let add = [];
  if (args[0] === "--doi" || args[0] === "-d") {
    add = [await fetchDoi(args[1])];
  } else {
    if (!args[0]) die("缺少 CSL-JSON（可用 '-' 从管道读，或 '@文件'）");
    let parsed;
    try {
      parsed = JSON.parse(readPayload(args[0]));
    } catch (e) {
      die("要传 JSON（或改用 --doi / '-' / '@文件'）：" + e.message);
    }
    add = Array.isArray(parsed) ? parsed : [parsed];
  }
  const { path: libPath, items } = readLibrary(root);
  CORE.assignCiteKeys(items);
  const norm = (s) => String(s || "").toLowerCase().replace(/^https?:\/\/doi\.org\//, "").trim();
  const report = { added: [], updated: [] };
  for (const it of add) {
    if (!it || !(it.title || it.DOI || it.URL)) die("条目至少要有一项 title / DOI / URL");
    const doi = norm(it.DOI);
    const hit = items.find(
      (x) => (doi && norm(x.DOI) === doi) || (it.citeKey && (x.citeKey || x.id) === it.citeKey),
    );
    if (hit) {
      Object.assign(hit, it);
      report.updated.push(hit.citeKey || CORE.citeKeyOf(hit));
      continue;
    }
    items.push(it);
    CORE.assignCiteKeys(items);
    report.added.push(it.citeKey);
  }
  CORE.assignCiteKeys(items);
  fs.mkdirSync(path.dirname(libPath), { recursive: true });
  fs.writeFileSync(libPath, JSON.stringify(items, null, 2) + "\n", "utf8");
  if (asJson) return console.log(JSON.stringify({ path: libPath, total: items.length, ...report }, null, 2));
  console.log(
    "OK 文献库 " + items.length + " 条" +
      (report.added.length ? "；新增 " + report.added.join(", ") : "") +
      (report.updated.length ? "；更新 " + report.updated.join(", ") : "") +
      "\n   写盘 " + libPath,
  );
}

/* ── 分发 ── */
try {
  if (cmd === "graph") cmdGraph(rest[0], writeGraph);
  else if (cmd === "note") cmdNote(rest[0], rest[1]);
  else if (cmd === "ls") cmdLs(rest[0]);
  else if (cmd === "search") await cmdSearch(rest[0], rest[1], rest[2]);
  else if (cmd === "doi") await cmdDoi(rest[0]);
  else if (cmd === "lib") await cmdLib(rest[0], rest[1], rest.slice(2));
  else {
    console.log(
      [
        "研究画布 · 文献与图谱工具",
        "",
        "  graph  <research目录> [--json] [--write]  整库体检（notes/ + core/ + parents）：计数 / kind / 缺口；--write 落 graph.json",
        "  note   <research目录> <笔记相对路径>      单篇解析：节点、边、验证状态",
        "  ls     <research目录> [--json]            文献库清单",
        "  search <crossref|arxiv|s2> <词> [n]       在线检索候选（不入库）",
        "  doi    <DOI>                              按 DOI 取准元数据 + BibTeX",
        "  lib    <research目录> add '<CSL-JSON>'     文献入库（重键自动补 b/c）",
        "  lib    <research目录> add --doi <DOI>      按 DOI 入库",
      ].join("\n"),
    );
    process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  die(String((e && e.stack) || e));
}

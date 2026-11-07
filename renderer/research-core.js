/* ===== 研究画布 · 内核（纯函数，零依赖，渲染层与 Node 脚本共用同一份）=====
 *
 * 为什么是 UMD：这份内核要同时被两处消费 ——
 *   ① 渲染层（renderer/app-research.js / app-research-graph.js）通过 <script> 拿到 window.MTResearchCore；
 *   ② 技能脚本（scripts/research-lit.mjs）用 require 拿到同一份实现。
 * 复制第二份实现是「每次重新做工具」的根源，故此处一次性收口（见 AGENTS「提示词单一真源」的同一口径）。
 *
 * 它只做纯计算，不碰 DOM、不碰网络、不碰文件：
 *   · Markdown ⇄ 结构：frontmatter、callout 块、[[wikilink]]、[@citekey]、公式、批注；
 *   · 笔记 → 知识图谱（节点 / 边 / 验证态 / 正文锚点）；
 *   · 图查询：邻域、最短路径、按 tag / 验证态筛选；
 *   · 三套布局（力导向 / 分层 / 径向）与时间线排序，全部确定性（同输入同输出）；
 *   · 文献：BibTeX ⇄ CSL-JSON、引用键、CiteProc 之外的最小字段归一。
 *
 * 一切文本内容的真源都是磁盘上的 .md 文件；图谱是它的投影，可随时从 md 重建。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MTResearchCore = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const VER = 1;
  const VERIFY_STATES = ["verified", "doubt", "unverified"];
  const VERIFY_LABEL = { verified: "已验证", doubt: "存疑", unverified: "未验证" };
  const NODE_KINDS = {
    topic: "课题",
    note: "笔记",
    concept: "概念",
    claim: "论断",
    formula: "公式",
    source: "来源",
    paper: "文献",
    question: "待解决问题",
    method: "方法 / 实验",
    annotation: "批注",
  };
  const EDGE_KINDS = {
    relates: "关联",
    asserts: "断言",
    cites: "引用",
    supports: "支持",
    refutes: "反驳",
    derives: "推导",
    depends: "依赖",
    mentions: "提及",
    annotates: "批注",
    asks: "待解决",
    defines: "解释",
    part_of: "属于",
  };
  /* 写在正文里但不需要重建图时读的临时字段（回跳锚点） */
  const CALLOUT_KINDS = new Set([
    "claim",
    "source",
    "note",
    "question",
    "formula",
    "method",
    "refute",
  ]);

  /* ── 小工具 ── */
  function str(v) {
    return v == null ? "" : String(v);
  }
  function hashString(s) {
    let h = 2166136261;
    const t = str(s);
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedOf(s) {
    let h = 2166136261;
    const t = str(s);
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function uniq(arr) {
    const out = [];
    const seen = new Set();
    for (const x of arr || []) {
      const k = str(x);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  }
  function slugify(s) {
    return str(s)
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, "-")
      .replace(/[^\w\u4e00-\u9fa5.-]+/g, "")
      .replace(/-+/g, "-")
      .slice(0, 80);
  }
  function clip(s, n) {
    const t = str(s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }
  /* 相对路径归一：统一正斜杠、去掉 ./ 前缀 */
  function normRel(p) {
    return str(p)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/");
  }
  function baseName(p) {
    const s = normRel(p);
    const i = s.lastIndexOf("/");
    return i < 0 ? s : s.slice(i + 1);
  }
  function stripExt(p) {
    return baseName(p).replace(/\.md$/i, "");
  }

  /* ── frontmatter ──
   * 只认最朴素的 YAML 子集：key: value / key: [a, b] / key: 多行（缩进行）。
   * 故意不引 YAML 库（零依赖），也不吃掉复杂结构 —— 解析不了的行留在正文，绝不丢内容。 */
  function parseScalar(raw) {
    let s = str(raw).trim();
    if (!s) return "";
    if (/^\[.*\]$/.test(s)) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return inner
        .split(",")
        .map((x) => parseScalar(x))
        .filter((x) => x !== "");
    }
    if (
      (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
      (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")
    )
      s = s.slice(1, -1);
    if (s === "true") return true;
    if (s === "false") return false;
    return s;
  }
  function parseFrontmatter(md) {
    const text = str(md).replace(/^\uFEFF/, "");
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
    if (!m) return { meta: {}, body: text, raw: "" };
    const meta = {};
    let lastKey = "";
    for (const line of m[1].split(/\r?\n/)) {
      if (!line.trim()) continue;
      const kv = /^([A-Za-z0-9_\u4e00-\u9fa5.-]+):[ \t]*(.*)$/.exec(line);
      if (kv) {
        lastKey = kv[1];
        meta[lastKey] = parseScalar(kv[2]);
      } else if (/^[ \t]+-\s+/.test(line) && lastKey) {
        const item = parseScalar(line.replace(/^[ \t]+-\s+/, ""));
        if (!Array.isArray(meta[lastKey])) meta[lastKey] = meta[lastKey] ? [meta[lastKey]] : [];
        meta[lastKey].push(item);
      }
    }
    return { meta, body: text.slice(m[0].length), raw: m[1] };
  }
  function fmValue(v) {
    if (Array.isArray(v)) return "[" + v.map((x) => fmValue(x)).join(", ") + "]";
    const s = str(v);
    if (!s) return "";
    if (/[:#[\]{}",]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
    return s;
  }
  function stringifyFrontmatter(meta, body) {
    const keys = Object.keys(meta || {});
    if (!keys.length) return str(body);
    const lines = ["---"];
    for (const k of keys) {
      const v = meta[k];
      if (v == null || v === "") continue;
      if (Array.isArray(v) && !v.length) continue;
      lines.push(k + ": " + fmValue(v));
    }
    lines.push("---");
    return lines.join("\n") + "\n" + str(body);
  }

  /* ── 引用键（Pandoc 口径：作者姓 + 年份 + 标题首词，冲突再补 a/b）── */
  function firstAuthorKey(item) {
    const a = (item && item.author) || [];
    if (!a.length) return "anon";
    const au = a[0] || {};
    const fam = str(au.family || au.literal || au.name || "anon").trim();
    if (fam) return fam.replace(/[^\w\u4e00-\u9fa5]/g, "");
    return "anon";
  }
  function yearOf(item) {
    const d = (item && (item.issued || item.published)) || null;
    const dp = d && d["date-parts"] && d["date-parts"][0];
    if (dp && dp[0]) return String(dp[0]);
    if (d && d.raw) {
      const m = /\d{4}/.exec(str(d.raw));
      if (m) return m[0];
    }
    return "nd";
  }
  function citeKeyOf(item) {
    if (!item) return "";
    if (item.citeKey) return str(item.citeKey);
    const titleWord = (Array.isArray(item.title) ? item.title[0] : str(item.title))
      .split(/[\s:，,。.]+/)
      .filter(Boolean)[0];
    const tail = titleWord ? slugify(titleWord).replace(/[^\w\u4e00-\u9fa5]/g, "").slice(0, 6) : "";
    const key = (firstAuthorKey(item) + yearOf(item) + tail).replace(/[^\w\u4e00-\u9fa5]/g, "");
    return key || "ref" + hashString(JSON.stringify(item.title || ""));
  }
  /* 同一库里的重键：首条留原名，第 2 条起补 b/c/d（Pandoc / Zotero 的口径） */
  function assignCiteKeys(items) {
    const used = new Map();
    for (const it of items || []) {
      const base = citeKeyOf(it);
      if (!used.has(base)) {
        used.set(base, 1);
        it.citeKey = base;
        continue;
      }
      let n = used.get(base) + 1;
      while (used.has(base + String.fromCharCode(96 + n))) n++;
      used.set(base, n);
      const key = base + String.fromCharCode(96 + n);
      used.set(key, 1);
      it.citeKey = key;
    }
    return items;
  }

  /* ── BibTeX → CSL-JSON（够用的子集：@类型{key, 字段 = {值}}；支持 {}", @string 展开）── */
  function splitBibEntries(text) {
    const src = str(text).replace(/\r\n/g, "\n");
    const out = [];
    let i = 0;
    while (i < src.length) {
      const at = src.indexOf("@", i);
      if (at < 0) break;
      const head = /^@([A-Za-z]+)\s*[{(]/.exec(src.slice(at));
      if (!head) {
        i = at + 1;
        continue;
      }
      const type = head[1].toLowerCase();
      let depth = 0;
      let j = at + head[0].length - 1;
      let end = -1;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end < 0) break;
      out.push({ type, body: src.slice(at + head[0].length, end) });
      i = end + 1;
    }
    return out;
  }
  function readBibFields(body) {
    const s = str(body);
    const comma = s.indexOf(",");
    const key = comma >= 0 ? s.slice(0, comma).trim() : s.trim();
    const rest = comma >= 0 ? s.slice(comma + 1) : "";
    const fields = {};
    const re = /([A-Za-z][\w-]*)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\n]+)/g;
    let m;
    while ((m = re.exec(rest))) {
      let v = m[2].trim();
      if (v.charAt(0) === "{" && v.charAt(v.length - 1) === "}") v = v.slice(1, -1);
      else if (v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
      fields[m[1].toLowerCase()] = v.replace(/\s+/g, " ").trim();
    }
    return { key, fields };
  }
  const BIB_TYPE_MAP = {
    article: "article-journal",
    inproceedings: "paper-conference",
    conference: "paper-conference",
    book: "book",
    phdthesis: "thesis",
    mastersthesis: "thesis",
    techreport: "report",
    misc: "article",
    online: "webpage",
    incollection: "chapter",
  };
  function splitNames(raw) {
    return str(raw)
      .split(/\s+and\s+/i)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => {
        if (n.indexOf(",") >= 0) {
          const [fam, giv] = n.split(",");
          return { family: fam.trim(), given: str(giv).trim() };
        }
        const parts = n.split(/\s+/);
        if (parts.length === 1) return { family: parts[0], given: "" };
        return { family: parts.pop(), given: parts.join(" ") };
      });
  }
  function bibEntryToCsl(type, fields, key) {
    if (type === "string" || type === "preamble" || type === "comment") return null;
    const item = { type: BIB_TYPE_MAP[type] || "article", id: key, citeKey: key };
    item.title = fields.title || "";
    item.author = splitNames(fields.author || "");
    item.containerTitle = fields.journal || fields.booktitle || "";
    const year = fields.year || (/\d{4}/.exec(str(fields.date)) || [])[0] || "";
    if (year) item.issued = { "date-parts": [[Number(year)]] };
    if (fields.doi) item.DOI = String(fields.doi).replace(/^https?:\/\/doi\.org\//i, "");
    if (fields.url) item.URL = fields.url;
    if (fields.volume) item.volume = fields.volume;
    if (fields.number) item.issue = fields.number;
    if (fields.pages) item.page = fields.pages.replace(/--/g, "-");
    if (fields.publisher) item.publisher = fields.publisher;
    if (fields.abstract) item.abstract = fields.abstract;
    if (fields.eprint || fields.arxiv) item.arxiv = fields.eprint || fields.arxiv;
    if (fields.keywords) item.keyword = fields.keywords;
    if (fields.note) item.note = fields.note;
    return item;
  }
  function parseBibtex(text) {
    const items = [];
    for (const e of splitBibEntries(text)) {
      const { key, fields } = readBibFields(e.body);
      const item = bibEntryToCsl(e.type, fields, key);
      if (item) items.push(item);
    }
    return items;
  }
  function cslToBibtex(item) {
    const t =
      item.type === "paper-conference"
        ? "inproceedings"
        : item.type === "book"
          ? "book"
          : item.type === "thesis"
            ? "phdthesis"
            : "article";
    const lines = ["@" + t + "{" + (item.citeKey || item.id || "ref") + ","];
    const add = (k, v) => {
      if (v != null && str(v).trim()) lines.push("  " + k + " = {" + str(v).trim() + "},");
    };
    add("title", Array.isArray(item.title) ? item.title.join(" ") : item.title);
    const au = (item.author || [])
      .map((a) => (a.family ? a.family + (a.given ? ", " + a.given : "") : a.literal || ""))
      .filter(Boolean);
    add("author", au.join(" and "));
    if (item.type === "paper-conference") add("booktitle", item.containerTitle);
    else add("journal", item.containerTitle);
    add("year", yearOf(item));
    add("volume", item.volume);
    add("number", item.issue);
    add("pages", item.page);
    add("publisher", item.publisher);
    add("doi", item.DOI);
    add("url", item.URL);
    return lines.join("\n") + "\n}";
  }

  /* ── 从文献库里取一条的简述 ── */
  function itemTitle(item) {
    const t = Array.isArray(item && item.title) ? item.title[0] : (item && item.title) || "";
    return str(t).replace(/[{}]/g, "");
  }
  function itemAuthorsShort(item) {
    const a = (item && item.author) || [];
    if (!a.length) return "";
    const fam = (x) => str(x.family || x.literal || x.name || "");
    if (a.length === 1) return fam(a[0]);
    if (a.length === 2) return fam(a[0]) + " & " + fam(a[1]);
    return fam(a[0]) + " 等";
  }
  function citeText(item) {
    const a = itemAuthorsShort(item);
    return (a ? a + " " : "") + yearOf(item);
  }

  /* ── 正文解析：callout / wikilink / 引用 / 公式 ── */
  const RE_WIKI = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const RE_CITE = /\[(-?)@([A-Za-z0-9_:.#/-]+)([^\]]*)\]/g;

  /* 把 body 切成块：callout 块（连续的 "> " 行）、标题行、段落行、代码块 */
  function scanBlocks(body, lineOffset) {
    const lines = str(body).split(/\r?\n/);
    const blocks = [];
    let i = 0;
    let fence = null;
    const lineOf = (idx) => idx + 1 + (lineOffset || 0);
    while (i < lines.length) {
      const line = lines[i];
      const fm = /^\s*```(.*)$/.exec(line);
      if (fm) {
        if (fence == null) {
          fence = fm[1].trim();
          const codeLines = [lines[i]];
          const start = i;
          i++;
          while (i < lines.length) {
            codeLines.push(lines[i]);
            if (/^\s*```/.test(lines[i])) {
              i++;
              break;
            }
            i++;
          }
          blocks.push({
            type: "code",
            lang: fence,
            text: codeLines.join("\n"),
            body: codeLines.slice(1, -1).join("\n"),
            line: lineOf(start),
          });
          fence = null;
          continue;
        }
      }
      const co = /^\s*>\s*\[!([^\]|]+)(?:\|([^\]]*))?\]([^\n]*)$/.exec(line);
      if (co) {
        const start = i;
        const buf = [line];
        i++;
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        const kind = co[1].toLowerCase();
        /* 修饰符写在类别后面：> [!claim|refute] → kind=claim、mod=refute
           （Obsidian 的 callout 折叠写 `[!note]-`，这里一并当 mod 收下，不当成标题）。 */
        const mod = str(co[2]).trim().toLowerCase();
        const title = co[3].replace(/^[ \t]+/, "").trim();
        const inner = buf.map((l) => l.replace(/^\s*>\s?/, ""));
        // 第一行去掉 "[!kind] 标题" 前缀
        inner[0] = inner[0].replace(/^\[![^\]]+\]\s*/, "");
        const text = inner.join("\n").trim();
        blocks.push({
          type: "callout",
          kind,
          mod,
          title,
          text,
          raw: buf.join("\n"),
          line: lineOf(start),
          endLine: lineOf(i - 1),
        });
        continue;
      }
      if (/^\s*#{1,6}\s+/.test(line)) {
        const hm = /^\s*(#{1,6})\s+(.*)$/.exec(line);
        blocks.push({ type: "heading", level: hm[1].length, text: hm[2].trim(), line: lineOf(i) });
        i++;
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const start = i;
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*#{1,6}\s+/.test(lines[i]) &&
        !/^\s*>\s*\[!/.test(lines[i]) &&
        !/^\s*```/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({
        type: "para",
        text: buf.join("\n").trim(),
        raw: buf.join("\n"),
        line: lineOf(start),
        endLine: lineOf(i - 1),
      });
    }
    return blocks;
  }

  function collectWiki(text) {
    const out = [];
    let m;
    RE_WIKI.lastIndex = 0;
    while ((m = RE_WIKI.exec(str(text)))) out.push({ target: m[1].trim(), alias: m[2] || "" });
    return out;
  }
  function collectCites(text) {
    const out = [];
    let m;
    RE_CITE.lastIndex = 0;
    while ((m = RE_CITE.exec(str(text)))) out.push({ key: m[2], locator: str(m[3]).trim() });
    return out;
  }
  /* 公式：$$...$$（可跨行）与 $...$（单行内） */
  function collectFormulas(text) {
    const s = str(text);
    const out = [];
    const disp = /\$\$([\s\S]+?)\$\$/g;
    let m;
    while ((m = disp.exec(s))) out.push({ tex: m[1].trim(), display: true });
    const inl = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;
    while ((m = inl.exec(s))) out.push({ tex: m[1].trim(), display: false });
    return out;
  }
  /* 验证态：callout / frontmatter 里写 verify: doubt；也认 "状态: 存疑" */
  function readVerify(text) {
    const m = /(?:^|\n)\s*(?:verify|验证|state|status)\s*[:：]\s*([A-Za-z\u4e00-\u9fa5]+)/i.exec(
      str(text),
    );
    if (!m) return "";
    const v = m[1].trim().toLowerCase();
    if (/verify|已验|verified|ok|真/.test(v)) return "verified";
    if (/doubt|存疑|怀疑|uncertain|maybe/.test(v)) return "doubt";
    if (/unver|未验|todo|待验/.test(v)) return "unverified";
    return "";
  }

  /* 单篇笔记 → 节点与边。id 稳定：以「文件相对路径 + 块序号」生成，重排正文只影响序号。 */
  function parseNote(input) {
    const path = normRel(input && input.path);
    const md = str(input && input.md);
    const { meta, body } = parseFrontmatter(md);
    /* 行号偏移 = frontmatter **整块**占掉的行数（含开头那行 `---`）。
       曾经只数闭合 `---` 附近的两个换行 → 偏移恒为 2，于是「插到选区所在块之后」
       把批注写进了 frontmatter 里（真机踩过）。 */
    const fmMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
    const lineOffset = fmMatch ? (fmMatch[0].match(/\n/g) || []).length : 0;
    const title = str(meta.title) || stripExt(path);
    const tags = (Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : []).map((t) =>
      str(t).replace(/^#/, "").trim(),
    ).filter(Boolean);
    const aliases = (Array.isArray(meta.aliases) ? meta.aliases : meta.aliases ? [meta.aliases] : []).map(
      str,
    ).filter(Boolean);
    const isCore = meta.core === true || meta.kind === "topic";
    const kindHint = str(meta.kind).trim();
    const noteKind = isCore
      ? "topic"
      : kindHint && NODE_KINDS[kindHint]
        ? kindHint
        : tags.includes("claim")
          ? "claim"
          : tags.includes("concept")
            ? "concept"
            : tags.includes("question")
              ? "question"
              : tags.includes("method")
                ? "method"
                : "note";
    const noteId = "note:" + path;
    const nodes = [];
    const edges = [];
    const noteNode = {
      id: noteId,
      kind: noteKind,
      label: title,
      path,
      line: 1,
      tags,
      aliases,
      verify: readVerify(meta.verify ? "verify: " + meta.verify : "") || "unverified",
      excerpt: clip(body.replace(/^#.*$/gm, ""), 120),
      core: !!isCore,
    };
    nodes.push(noteNode);
    const pushEdge = (from, to, kind, extra) => {
      if (!from || !to) return;
      edges.push(
        Object.assign(
          { id: "e:" + hashString(from + "|" + kind + "|" + to + "|" + (extra && extra.line)), from, to, kind },
          extra || {},
        ),
      );
    };

    /* 块级解析 */
    const blocks = scanBlocks(body, lineOffset);
    let seq = 0;
    for (const b of blocks) {
      if (b.type === "heading") {
        const t = b.text.trim();
        if (!t) continue;
        /* H1 就是笔记自己的标题时不要再造一个 concept：它会被下面的「按标题合并」
           改写成 note→note 再当自环丢掉，只剩一个没有任何边的孤立标题节点。 */
        if (b.level === 1 && (t === title || t === stripExt(path))) continue;
        const hk = "concept:" + slugify(t);
        nodes.push({
          id: hk,
          kind: "concept",
          label: t,
          path,
          line: b.line,
          section: true,
          tags,
        });
        pushEdge(noteId, hk, "defines", { line: b.line, path });
        continue;
      }
      if (b.type === "code") {
        /* Pele 代码块（```mermaid / ```pele）→ 可作为图谱里的方法/示意图节点 */
        if (/^(mermaid|pele)$/i.test(str(b.lang))) {
          seq++;
          nodes.push({
            id: "figure:" + path + "#" + seq,
            kind: "method",
            label: "图示 " + seq,
            path,
            line: b.line,
            figure: b.lang,
            code: b.body,
            tags,
          });
          pushEdge("figure:" + path + "#" + seq, noteId, "part_of", { line: b.line, path });
        }
        continue;
      }
      const text = b.text;
      const verify = readVerify(text) || noteNode.verify;

      if (b.type === "callout" && CALLOUT_KINDS.has(b.kind)) {
        seq++;
        const cid = b.kind + ":" + path + "#" + seq;
        const label = b.title || clip(text, 40);
        const isRefute = b.kind === "refute" || b.mod === "refute";
        if (b.kind === "claim" || b.kind === "refute" || b.kind === "question" || isRefute) {
          const kind = b.kind === "question" ? "question" : "claim";
          nodes.push({
            id: cid,
            kind,
            label,
            text,
            path,
            line: b.line,
            verify: kind === "claim" ? verify : "unverified",
            tags,
            refuted: isRefute,
            excerpt: clip(text, 160),
          });
          pushEdge(noteId, cid, "asserts", { line: b.line, path });
          if (b.kind === "question") pushEdge(cid, noteId, "asks", { line: b.line, path });
        } else if (b.kind === "note") {
          nodes.push({
            id: cid,
            kind: "annotation",
            label: label || "批注",
            text,
            path,
            line: b.line,
            excerpt: clip(text, 160),
            tags,
          });
          pushEdge(cid, noteId, "annotates", { line: b.line, path });
        } else if (b.kind === "formula") {
          nodes.push({
            id: cid,
            kind: "formula",
            label: clip(text || label, 40),
            tex: text,
            path,
            line: b.line,
            verify,
          });
          pushEdge(noteId, cid, "depends", { line: b.line, path });
        } else if (b.kind === "source") {
          const urlM = /https?:\/\/[^\s)）]+/.exec(text);
          const doiM = /10\.\d{4,9}\/[^\s)）]+/.exec(text);
          nodes.push({
            id: "source:" + hashString(text || label),
            kind: "source",
            label: label || clip(text, 40),
            text,
            url: urlM ? urlM[0] : "",
            doi: doiM ? doiM[0] : "",
            path,
            line: b.line,
            excerpt: clip(text, 160),
          });
          pushEdge(cid, "source:" + hashString(text || label), "cites", { line: b.line, path });
        } else if (b.kind === "method") {
          nodes.push({
            id: cid,
            kind: "method",
            label: label || "方法",
            text,
            path,
            line: b.line,
            excerpt: clip(text, 160),
          });
          pushEdge(noteId, cid, "part_of", { line: b.line, path });
        }
        /* callout 内部的 [[链接]]、[@引用]、公式照样成边 */
        for (const w of collectWiki(text)) {
          const tid = "concept:" + slugify(w.target);
          nodes.push({
            id: tid,
            kind: "concept",
            label: w.alias || w.target,
            missing: true,
          });
          pushEdge(cid, tid, "mentions", { line: b.line, path });
        }
        for (const c of collectCites(text)) {
          const pid = "paper:" + c.key;
          nodes.push({ id: pid, kind: "paper", label: c.key, citeKey: c.key });
          pushEdge(cid, pid, "cites", { line: b.line, path, locator: c.locator });
        }
        for (const f of collectFormulas(text)) {
          const fid = "fx:" + hashString(path + "|" + f.tex);
          nodes.push({ id: fid, kind: "formula", label: clip(f.tex, 32), tex: f.tex, path, line: b.line });
          pushEdge(cid, fid, "depends", { line: b.line, path });
        }
        continue;
      }

      /* 普通段落：[[链接]] / [@引用] / 公式 */
      for (const w of collectWiki(text)) {
        const tid = "concept:" + slugify(w.target);
        nodes.push({ id: tid, kind: "concept", label: w.alias || w.target, missing: true });
        pushEdge(noteId, tid, "relates", { line: b.line, path });
      }
      for (const c of collectCites(text)) {
        const pid = "paper:" + c.key;
        nodes.push({ id: pid, kind: "paper", label: c.key, citeKey: c.key });
        pushEdge(noteId, pid, "cites", { line: b.line, path, locator: c.locator });
      }
      for (const f of collectFormulas(text)) {
        const fid = "fx:" + hashString(path + "|" + f.tex);
        nodes.push({ id: fid, kind: "formula", label: clip(f.tex, 32), tex: f.tex, path, line: b.line });
        pushEdge(noteId, fid, "uses", { line: b.line, path });
      }
    }

    /* frontmatter 里的显式关系：refs / supports / refutes / relates */
    const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(str).filter(Boolean);
    for (const r of asList(meta.refs)) {
      pushEdge(noteId, "paper:" + r, "cites", { path, fromMeta: true });
      nodes.push({ id: "paper:" + r, kind: "paper", label: r, citeKey: r });
    }
    for (const r of asList(meta.supports)) pushEdge(noteId, "concept:" + slugify(r), "supports", { path });
    for (const r of asList(meta.refutes)) pushEdge(noteId, "concept:" + slugify(r), "refutes", { path });
    for (const r of asList(meta.derives)) pushEdge(noteId, "concept:" + slugify(r), "derives", { path });
    for (const r of asList(meta.relates)) {
      const tid = "concept:" + slugify(r);
      nodes.push({ id: tid, kind: "concept", label: r, missing: true });
      pushEdge(noteId, tid, "relates", { path, fromMeta: true, label: "frontmatter" });
    }
    if (meta.date || meta.updated || meta.created)
      noteNode.at = str(meta.date || meta.updated || meta.created);

    return { meta, body, note: noteNode, nodes, edges, blocks };
  }

  /* ── 文档集 → 整图 ──
   * 合并同 id 节点（后出现的只补空字段，不覆盖已有 label），链接节点按标题/别名回填到真笔记。 */
  function buildGraph(docs, opts) {
    const options = opts || {};
    const nodesById = new Map();
    const edges = [];
    const byTitle = new Map();
    const byAlias = new Map();

    const addNode = (n) => {
      if (!n || !n.id) return;
      const cur = nodesById.get(n.id);
      if (!cur) {
        nodesById.set(n.id, Object.assign({}, n));
        return;
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (v == null || v === "") continue;
        if (cur[k] == null || cur[k] === "" || cur[k] === false) cur[k] = v;
      }
      if (n.path) cur.path = cur.path || n.path;
      if (n.line && !cur.line) cur.line = n.line;
    };

    for (const d of docs || []) {
      const r = d.parsed || parseNote(d);
      addNode(r.note);
      byTitle.set(r.note.label, r.note.id);
      for (const a of r.note.aliases || []) byAlias.set(a, r.note.id);
      for (const n of r.nodes) addNode(n);
      for (const e of r.edges) edges.push(e);
    }

    for (const [id, n] of nodesById) {
      if (n.kind !== "paper") continue;
      if (!n.label || n.label === n.citeKey) {
        const item = (options.library || []).find((x) => (x.citeKey || x.id) === n.citeKey);
        if (item) {
          n.label = itemTitle(item) || n.citeKey;
          n.authors = itemAuthorsShort(item);
          n.year = yearOf(item);
          n.url = item.URL || (item.DOI ? "https://doi.org/" + item.DOI : "");
          n.doi = item.DOI || "";
          n.paper = true;
        } else {
          n.missingItem = true;
          n.label = n.citeKey;
        }
      }
    }
    /* [[wikilink]] 的 concept 若能对上笔记标题/别名，合并到那条笔记 */
    for (const [id, n] of nodesById) {
      if (!id.startsWith("concept:")) continue;
      const hit = byTitle.get(n.label) || byAlias.get(n.label);
      if (!hit || hit === id) continue;
      for (const e of edges) {
        if (e.from === id) e.from = hit;
        if (e.to === id) e.to = hit;
      }
      if (!n.section) nodesById.delete(id);
    }
    const finalNodes = [...nodesById.values()];

    /* 边去重 + 丢弃悬空 */
    const idSet = new Set(finalNodes.map((n) => n.id));
    const seen = new Set();
    const finalEdges = [];
    for (const e of edges) {
      if (!e.from || !e.to || e.from === e.to) continue;
      if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      finalEdges.push(e);
    }
    /* 邻接表 */
    const adj = new Map(finalNodes.map((n) => [n.id, []]));
    for (const e of finalEdges) {
      adj.get(e.from).push({ id: e.to, edge: e });
      adj.get(e.to).push({ id: e.from, edge: e });
    }
    const degrees = new Map();
    for (const [id, list] of adj) degrees.set(id, list.length);
    return {
      ver: VER,
      builtAt: Date.now(),
      nodes: finalNodes,
      edges: finalEdges,
      adj,
      degrees,
      docs: (docs || []).map((d) => d.path || (d.parsed && d.parsed.note.path)).filter(Boolean),
    };
  }

  /* ── 图查询 ── */
  function graphIndex(graph) {
    if (graph && graph._index) return graph._index;
    const byId = new Map();
    for (const n of (graph && graph.nodes) || []) byId.set(n.id, n);
    const adj = graph && graph.adj ? graph.adj : new Map();
    const idx = { byId, adj };
    if (graph) graph._index = idx;
    return idx;
  }
  function neighborhood(graph, startId, hops) {
    const { adj } = graphIndex(graph);
    const h = Math.max(1, Math.min(6, Number(hops) || 1));
    const dist = new Map([[startId, 0]]);
    let frontier = [startId];
    for (let d = 1; d <= h; d++) {
      const next = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) || []) {
          if (dist.has(nb.id)) continue;
          dist.set(nb.id, d);
          next.push(nb.id);
        }
      }
      frontier = next;
    }
    return dist;
  }
  function shortestPath(graph, a, b) {
    const { adj } = graphIndex(graph);
    if (!adj.has(a) || !adj.has(b)) return [];
    const prev = new Map([[a, null]]);
    const q = [a];
    while (q.length) {
      const cur = q.shift();
      if (cur === b) break;
      for (const nb of adj.get(cur) || []) {
        if (prev.has(nb.id)) continue;
        prev.set(nb.id, cur);
        q.push(nb.id);
      }
    }
    if (!prev.has(b)) return [];
    const out = [];
    let cur = b;
    while (cur != null) {
      out.unshift(cur);
      cur = prev.get(cur);
    }
    return out;
  }
  function filterGraph(graph, f) {
    const opt = f || {};
    const tags = (opt.tags || []).map((t) => str(t).toLowerCase());
    const keep = new Set();
    for (const n of graph.nodes) {
      if (opt.kinds && opt.kinds.length && !opt.kinds.includes(n.kind)) continue;
      if (opt.verify && opt.verify.length && n.kind === "claim" && !opt.verify.includes(n.verify))
        continue;
      if (tags.length) {
        const nt = (n.tags || []).map((t) => str(t).toLowerCase());
        if (!nt.some((t) => tags.includes(t))) continue;
      }
      keep.add(n.id);
    }
    const nodes = graph.nodes.filter((n) => keep.has(n.id));
    const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      adj.get(e.from).push({ id: e.to, edge: e });
      adj.get(e.to).push({ id: e.from, edge: e });
    }
    return { ver: graph.ver, nodes, edges, adj, degrees: graph.degrees, builtAt: graph.builtAt };
  }

  /* ── 布局：全部确定性（同输入同输出，避免每次重排都跳） ── */
  function graphBounds(nodes) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  /* 力导向：Fruchterman-Reingold 简化版，固定种子 + 固定迭代数
   * 迭代数是 O(n²) 的：节点上千时 260 轮会把渲染线程卡住十几秒到几分钟，用户看到的就是
   * 「点了图谱没反应」（真机现象）。按节点数降档 —— 小图仍是原来的 260 轮，输出不变。 */
  function layoutForce(graph, opts) {
    const o = opts || {};
    const nodes = (graph.nodes || []).slice();
    const edges = graph.edges || [];
    const W = o.width || 1600;
    const H = o.height || 1000;
    const n = nodes.length;
    const autoIter = n > 600 ? 60 : n > 300 ? 110 : n > 150 ? 180 : 260;
    const iterations = o.iterations || autoIter;
    const pos = new Map();
    const rand = mulberry32(seedOf(nodes.map((n) => n.id).join(",") || "g"));
    nodes.forEach((n, i) => {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const r = Math.min(W, H) * 0.36 * (0.35 + 0.65 * rand());
      pos.set(n.id, { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 });
    });
    const k = Math.sqrt((W * H) / Math.max(1, nodes.length)) * 0.62;
    const deg = graph.degrees || new Map();
    for (let it = 0; it < iterations; it++) {
      const t = (1 - it / iterations) * (k * 0.5) + 1;
      for (let i = 0; i < nodes.length; i++) {
        const a = pos.get(nodes[i].id);
        for (let j = i + 1; j < nodes.length; j++) {
          const b = pos.get(nodes[j].id);
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (rand() - 0.5) * 2;
            dy = (rand() - 0.5) * 2;
            d2 = 4;
          }
          const d = Math.sqrt(d2);
          const f = (k * k) / d;
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f;
          b.vy -= (dy / d) * f;
        }
      }
      for (const e of edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
        const f = (d * d) / k;
        a.vx -= (dx / d) * f;
        a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;
      }
      for (const n of nodes) {
        const p = pos.get(n.id);
        const anchor = n.kind === "topic" ? 4 : 1;
        p.vx += (W / 2 - p.x) * 0.02 * anchor;
        p.vy += (H / 2 - p.y) * 0.02 * anchor;
        const len = Math.max(0.01, Math.hypot(p.vx, p.vy));
        p.x += (p.vx / len) * Math.min(len, t);
        p.y += (p.vy / len) * Math.min(len, t);
        p.vx = 0;
        p.vy = 0;
        p.x = Math.max(40, Math.min(W - 40, p.x));
        p.y = Math.max(40, Math.min(H - 40, p.y));
      }
    }
    const out = new Map();
    for (const n of nodes) {
      const p = pos.get(n.id);
      out.set(n.id, { x: Math.round(p.x), y: Math.round(p.y) });
    }
    return out;
  }
  /* 分层：以课题为根做 BFS 分层，层内按度降序、垂直居中 */
  function layoutLayered(graph, opts) {
    const o = opts || {};
    const nodes = graph.nodes || [];
    const adj = graph.adj || new Map();
    const roots = nodes.filter((n) => n.core || n.kind === "topic").map((n) => n.id);
    const level = new Map();
    const q = [];
    for (const r of roots.length ? roots : [nodes[0] && nodes[0].id].filter(Boolean)) {
      level.set(r, 0);
      q.push(r);
    }
    while (q.length) {
      const cur = q.shift();
      for (const nb of adj.get(cur) || []) {
        if (level.has(nb.id)) continue;
        level.set(nb.id, level.get(cur) + 1);
        q.push(nb.id);
      }
    }
    for (const n of nodes) if (!level.has(n.id)) level.set(n.id, 1);
    const colW = o.colWidth || 320;
    const rowH = o.rowHeight || 96;
    const groups = new Map();
    for (const n of nodes) {
      const l = level.get(n.id);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(n);
    }
    const maxRows = Math.max(...[...groups.values()].map((g) => g.length), 1);
    const out = new Map();
    for (const [l, arr] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      arr.sort((a, b) => (graph.degrees.get(b.id) || 0) - (graph.degrees.get(a.id) || 0));
      const count = arr.length;
      const offset = (maxRows - count) / 2;
      arr.forEach((n, i) => {
        out.set(n.id, { x: 120 + l * colW, y: Math.round(120 + (offset + i) * rowH) });
      });
    }
    return out;
  }
  /* 径向：圆心=课题，按跳数分环，环内按角度均分 */
  function layoutRadial(graph, opts) {
    const o = opts || {};
    const nodes = graph.nodes || [];
    const adj = graph.adj || new Map();
    const roots = nodes.filter((n) => n.core || n.kind === "topic").map((n) => n.id);
    const root = roots[0] || (nodes[0] && nodes[0].id);
    const dist = new Map();
    if (root) {
      dist.set(root, 0);
      const q = [root];
      while (q.length) {
        const cur = q.shift();
        for (const nb of adj.get(cur) || []) {
          if (dist.has(nb.id)) continue;
          dist.set(nb.id, dist.get(cur) + 1);
          q.push(nb.id);
        }
      }
    }
    for (const n of nodes) if (!dist.has(n.id)) dist.set(n.id, 1);
    const rings = new Map();
    for (const n of nodes) {
      const d = dist.get(n.id);
      if (!rings.has(d)) rings.set(d, []);
      rings.get(d).push(n);
    }
    const radius = o.radius || 170;
    const cx = o.cx || 900;
    const cy = o.cy || 620;
    const out = new Map();
    for (const [d, arr] of rings) {
      arr.sort((a, b) => (graph.degrees.get(b.id) || 0) - (graph.degrees.get(a.id) || 0));
      arr.forEach((n, i) => {
        if (d === 0) {
          out.set(n.id, { x: cx, y: cy });
          return;
        }
        const a = (i / Math.max(1, arr.length)) * Math.PI * 2 - Math.PI / 2;
        out.set(n.id, {
          x: Math.round(cx + Math.cos(a) * radius * d),
          y: Math.round(cy + Math.sin(a) * radius * d),
        });
      });
    }
    return out;
  }
  function applyLayout(graph, kind, opts) {
    const map =
      kind === "layered"
        ? layoutLayered(graph, opts)
        : kind === "radial"
          ? layoutRadial(graph, opts)
          : layoutForce(graph, opts);
    const nodes = graph.nodes.map((n) => {
      if (n.fixed && n.x != null) return n;
      const p = map.get(n.id);
      return p ? Object.assign({}, n, { x: p.x, y: p.y }) : n;
    });
    return Object.assign({}, graph, { nodes, layout: kind || "force" });
  }
  /* 时间线排序：按 at（frontmatter date / updated / createdAt）再按 id */
  function timeline(graph) {
    const ts = (n) => {
      const raw = str(n.at || n.date || n.createdAt || "");
      const m = /(\d{4})-?(\d{2})?-?(\d{2})?/.exec(raw);
      if (!m) return NaN;
      const y = Number(m[1]);
      const mo = Number(m[2] || 1) - 1;
      const d = Number(m[3] || 1);
      return Date.UTC(y, mo, d);
    };
    return (graph.nodes || [])
      .map((n) => ({ node: n, t: ts(n) }))
      .sort((a, b) => {
        const an = isNaN(a.t);
        const bn = isNaN(b.t);
        if (an && bn) return 0;
        if (an) return 1;
        if (bn) return -1;
        return a.t - b.t;
      });
  }

  /* ── 统计（界面顶部的摘要条 / 验收口径共用）── */
  function stats(graph) {
    const byKind = {};
    const byVerify = { verified: 0, doubt: 0, unverified: 0 };
    for (const n of graph.nodes || []) {
      byKind[n.kind] = (byKind[n.kind] || 0) + 1;
      if (n.kind === "claim") byVerify[n.verify || "unverified"] =
        (byVerify[n.verify || "unverified"] || 0) + 1;
    }
    return {
      nodes: (graph.nodes || []).length,
      edges: (graph.edges || []).length,
      byKind,
      byVerify,
      missing: (graph.nodes || []).filter((n) => n.missing || n.missingItem).length,
    };
  }

  /* ══════════════ 研究初始化 · 三层折叠（全文 / 关键原句 / 主题） ══════════════
   *
   * 参考 TextFold 的「折叠而不是摘要」：它把一篇文献折成五层（全文 / 简述 / 关键句 / 要点 / 主题），
   * 每层都能展开回作者原话。这里按用户共识压到三层，砍掉的代价最小：
   *   1 全文     = 作者原文，一字不动（**唯一可编辑层**）
   *   2 关键原句 = 作者原句，一字不改（不给模型改写的机会，溯源才硬）
   *   3 主题     = 几个词 + 一张章节地图（整篇缩成一张卡）
   *
   * 折叠的最小单位是**段落**：同一段的三层共用段落 id（p0001…），所以缩到主题层还能
   * 点回原句、再看全文。整篇只存一份 Markdown，按 `## <id> · <锚点>` 分段，
   * 段内用 `**全文** / **关键原句** / **主题**` 三个固定标记切层 —— 纯文本、可 diff、
   * Obsidian 里直接能读，不需要第二套数据格式。 */
  const FOLD_LEVELS = [
    { n: 1, key: "full", label: "全文" },
    { n: 2, key: "quote", label: "关键原句" },
    { n: 3, key: "topic", label: "主题" },
  ];
  const FOLD_KEYS = ["full", "quote", "topic"];
  const FOLD_MARK = { full: "**全文**", quote: "**关键原句**", topic: "**主题**" };
  const FOLD_MARK_TO_KEY = { 全文: "full", 关键原句: "quote", 主题: "topic" };

  function foldText(s) {
    return String(s == null ? "" : s).replace(/\r\n/g, "\n");
  }
  function foldCleanBlock(s) {
    return String(s == null ? "" : s)
      .split("\n")
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  /* 解析折叠文件 → { meta, key, title, map:[{title,topics[]}], paragraphs:[{id,anchor,full,quote,topic}] }
     容错优先：缺哪层就留空串，绝不让一个手改过的文件把整篇读崩。 */
  function parseFolds(md) {
    const fm = parseFrontmatter(foldText(md));
    const out = {
      meta: fm.meta || {},
      key: str((fm.meta || {}).key),
      title: str((fm.meta || {}).title),
      source: str((fm.meta || {}).source),
      map: [],
      paragraphs: [],
    };
    const lines = String(fm.body || "").split("\n");
    let para = null;
    let bucket = "";
    let buf = [];
    let mapMode = false;
    const flush = () => {
      if (bucket && para && FOLD_KEYS.indexOf(bucket) >= 0) {
        const key = bucket;
        para[key] = foldCleanBlock((para[key] ? para[key] + "\n" : "") + buf.join("\n"));
      }
      buf = [];
    };
    for (const raw of lines) {
      const line = String(raw);
      const trimmed = line.trim();
      if (/^#\s/.test(trimmed) && /主题地图/.test(trimmed)) {
        flush();
        bucket = "";
        para = null;
        mapMode = true;
        continue;
      }
      const h = /^##\s+(\S+)(?:\s*·\s*(.*))?$/.exec(trimmed);
      if (h) {
        /* `## p0001 · §1 Introduction`；只有形如段落 id 的标题才当分段头，
           普通二级标题（手写的「## 讨论」）留在当前段正文里。 */
        if (/^p\d+$/i.test(h[1]) || /^[A-Za-z][\w-]*#p\d+$/i.test(h[1])) {
          flush();
          mapMode = false;
          para = { id: h[1], anchor: str(h[2]).trim(), full: "", quote: "", topic: "" };
          out.paragraphs.push(para);
          bucket = "";
          continue;
        }
      }
      const m = /^\*\*(全文|关键原句|主题)\*\*\s*[:：]?\s*$/.exec(trimmed);
      if (m) {
        flush();
        bucket = FOLD_MARK_TO_KEY[m[1]] || "";
        continue;
      }
      if (mapMode) {
        const li = /^\s*[-*]\s+(.+)$/.exec(line);
        if (li) {
          const body = str(li[1]).trim();
          const at = body.indexOf("→");
          const title = (at >= 0 ? body.slice(0, at) : body).trim();
          const topics = at >= 0
            ? body
                .slice(at + 1)
                .split(/[·,，;；]/)
                .map((x) => str(x).trim())
                .filter(Boolean)
            : [];
          out.map.push({ title, topics });
        }
        continue;
      }
      if (trimmed === "" && !bucket) continue;
      buf.push(line);
    }
    flush();
    return out;
  }
  /* 结构化模型 → 折叠文件正文（写盘 / 重生成共用这一份，保证往返一致） */
  function foldsToMarkdown(model) {
    const m = model || {};
    const key = str(m.key) || "doc";
    const title = str(m.title) || key;
    const head = stringifyFrontmatter(
      {
        title,
        key,
        kind: "folds",
        levels: 3,
        source: str(m.source),
        generatedAt: str(m.generatedAt) || new Date().toISOString().slice(0, 10),
      },
      "",
    );
    const lines = [head.replace(/\s+$/, ""), "", "# 主题地图", ""];
    const map = Array.isArray(m.map) ? m.map : [];
    if (map.length) {
      for (const it of map) {
        const topics = (it.topics || []).filter(Boolean).join(" · ");
        lines.push("- " + str(it.title) + (topics ? " → " + topics : ""));
      }
    } else {
      lines.push("- （还没有章节地图：整篇按段落折）");
    }
    for (const p of m.paragraphs || []) {
      lines.push("", "## " + str(p.id) + (p.anchor ? " · " + str(p.anchor) : ""), "");
      for (const k of FOLD_KEYS) {
        lines.push(FOLD_MARK[k], "", foldCleanBlock(p[k]) || "—", "");
      }
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  }
  function foldSkeleton(input) {
    const o = input || {};
    return foldsToMarkdown({
      key: str(o.key) || "doc",
      title: str(o.title) || str(o.key) || "doc",
      source: str(o.source),
      map: [],
      paragraphs: [],
    });
  }
  /* 某一层的显示正文：1 全文照抄、2 只留关键原句（引用块）、3 章节地图 + 段落主题。
     第 2 层没有关键原句时退到正文前两句 —— 宁可少，也不编。 */
  function foldFirstSentences(text, n) {
    const s = foldCleanBlock(text).replace(/\s+/g, " ");
    if (!s) return "";
    const parts = s.match(/[^。！？.!?]+[。！？.!?]?/g) || [s];
    return parts.slice(0, Math.max(1, n || 2)).join("").trim();
  }
  function foldView(md, level) {
    const model = typeof md === "string" ? parseFolds(md) : md || {};
    const n = Math.max(1, Math.min(3, Number(level) || 1));
    const out = [];
    if (n === 3) {
      out.push("# 主题地图", "");
      const map = model.map || [];
      if (map.length) {
        for (const it of map) {
          const topics = (it.topics || []).filter(Boolean).join(" · ");
          out.push("- " + str(it.title) + (topics ? " → " + topics : ""));
        }
      } else {
        out.push("- （还没有章节地图）");
      }
      const ps = model.paragraphs || [];
      if (ps.length) {
        out.push("", "## 段落主题", "");
        for (const p of ps) out.push("- " + p.id + (p.anchor ? " · " + p.anchor : "") + " → " + (p.topic || "—"));
      }
      return out.join("\n").trim() + "\n";
    }
    for (const p of model.paragraphs || []) {
      out.push("## " + p.id + (p.anchor ? " · " + p.anchor : ""), "");
      if (n === 1) {
        out.push(foldCleanBlock(p.full) || "—", "");
      } else {
        const q = foldCleanBlock(p.quote) || foldFirstSentences(p.full, 2);
        out.push(
          q
            ? q
                .split("\n")
                .filter((l) => l.trim())
                .map((l) => "> " + l)
                .join("\n")
            : "> （这一段还没有关键原句）",
          "",
        );
      }
    }
    return out.join("\n").trim() + "\n";
  }

  /* ══════════════ 研究初始化 · 队列（research/init-queue.json） ══════════════
   * 为什么要有队列文件而不是把清单塞在会话里：进度要能被界面**扫盘读到**，
   * 断了 / 重启 / 换 agent 都得接得上；agent 每完成一项回写一次状态即可。 */
  const INIT_QUEUE_VER = 1;
  const INIT_STATUS = ["pending", "running", "done", "failed", "skipped"];
  const INIT_DONE = new Set(["done", "skipped"]);
  /* 已处理标记：处理完的内容要能**脱离投料台窗口**被看见 —— 所以标记写进文件（队列项 processed/processedAt，
   * 笔记 frontmatter 的 init: done / initAt），关窗、重启、换会话后照样判读得到。
   * 老队列没有这两个字段：一律按「未处理」兼容，不补写、不改动既有字段语义。 */
  function processedKey(it) {
    const o = it || {};
    const rel = str(o.mdRel) || str(o.noteRel) || str(o.rel) || str(o.src);
    return normRel(rel) || str(o.key) || str(o.id);
  }
  /* 一条队列项是否已处理：显式 processed 优先，其次 status=done（skipped 是「跳过」，不算处理完） */
  function initItemMarked(it) {
    const o = it || {};
    if (o.processed === true) return true;
    return o.status === "done";
  }
  /* 打标记（纯函数，返回新队列）：只加 processed / processedAt 两个字段，其它字段一个都不动 */
  function markProcessed(q, id, at) {
    const next = JSON.parse(JSON.stringify(q || { items: [] }));
    const list = next.items || [];
    const want = str(id);
    for (const it of list) {
      if (it.id !== want && processedKey(it) !== normRel(want)) continue;
      it.processed = true;
      it.processedAt = at != null ? at : Date.now();
      break;
    }
    next.items = list;
    return next;
  }
  /* 已处理清单（按队列原有顺序，界面直接铺） */
  function processedList(q) {
    return ((q && q.items) || []).filter(initItemMarked);
  }
  /* 读一篇笔记自己带的标记：frontmatter 里 init: done / initAt 有值即算已处理 */
  function noteProcessed(md) {
    const { meta } = parseFrontmatter(md);
    const init = str(meta.init).trim().toLowerCase();
    if (init) return init === "done" || init === "true" || init === "processed";
    return str(meta.initAt).trim() !== "";
  }

  /* 源文件类型：决定「谁来转 md」（pdf 走应用内内核，其余交给 agent） */
  const SRC_KIND_EXT = {
    pdf: "pdf",
    doc: "doc", docx: "doc", odt: "doc", rtf: "doc", pages: "doc",
    ppt: "ppt", pptx: "ppt", odp: "ppt", key: "ppt",
    tex: "tex", latex: "tex", bib: "tex",
    md: "md", markdown: "md", mdx: "md",
    txt: "text", text: "text", log: "text", rst: "text",
    csv: "data", tsv: "data", xls: "data", xlsx: "data",
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
    html: "html", htm: "html", epub: "html",
  };
  function initSourceKind(name) {
    const s = String(name || "");
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 ? s.slice(dot + 1).toLowerCase() : "";
    return SRC_KIND_EXT[ext] || "other";
  }
  /* 同目录重名：`a.pdf` → `a-2.pdf`（不覆盖用户已有的东西） */
  function uniqueRel(rel, taken) {
    const set = taken instanceof Set ? taken : new Set(taken || []);
    const p = String(rel || "");
    if (!set.has(p)) return p;
    const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
    const name = slash >= 0 ? p.slice(slash + 1) : p;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let i = 2;
    let cand = dir + stem + "-" + i + ext;
    while (set.has(cand)) cand = dir + stem + "-" + ++i + ext;
    return cand;
  }
  function foldKeyOf(relOrName) {
    /* 去掉任意扩展名（pdf / docx / tex…），不只 .md：引用键与文件名都要干净 */
    const base = baseName(String(relOrName || ""));
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return slugify(stem).slice(0, 48) || "doc";
  }
  /* 投料来源：file（拖进来的文件）/ url（网页、arXiv、DOI）/ text（用户直接写的笔记）/ query（检索式） */
  const INIT_SOURCES = ["file", "url", "text", "query"];
  function initSourceOf(it) {
    const o = it || {};
    const s = str(o.source).toLowerCase();
    if (INIT_SOURCES.indexOf(s) >= 0) return s;
    if (str(o.src)) return "file";
    if (str(o.url)) return "url";
    if (str(o.query)) return "query";
    if (str(o.text)) return "text";
    return "file";
  }
  const RE_ARXIV_URL = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/i;
  const RE_ARXIV_ID = /^(?:arxiv[:\s]*)(\d{4}\.\d{4,5})(v\d+)?$/i;
  const RE_ARXIV_BARE = /^(\d{4}\.\d{4,5})(v\d+)?$/;
  const RE_DOI = /^(?:doi[:\s]*)?(10\.\d{4,9}\/\S+)$/i;
  /* 一串文字 → 一条投料：链接 / arXiv 编号 / DOI / 其余当笔记；force="query" 一律当检索式 */
  function initClassifyLine(line, force) {
    const s = str(line).trim();
    if (!s) return null;
    if (force === "query") return { source: "query", value: s.replace(/^(?:q|query|检索|检索式)[:：]\s*/i, "") };
    const qp = /^(?:q|query|检索|检索式)[:：]\s*(.+)$/i.exec(s);
    if (qp) return { source: "query", value: qp[1].trim() };
    if (/^https?:\/\//i.test(s)) return { source: "url", value: s };
    const a = RE_ARXIV_URL.exec(s);
    if (a) return { source: "url", value: "https://arxiv.org/abs/" + a[1] + (a[2] || "") };
    const bare = RE_ARXIV_BARE.exec(s);
    if (bare) return { source: "url", value: "https://arxiv.org/abs/" + bare[1] + (bare[2] || "") };
    const id = RE_ARXIV_ID.exec(s);
    if (id) return { source: "url", value: "https://arxiv.org/abs/" + id[1] + (id[2] || "") };
    const doi = RE_DOI.exec(s);
    if (doi) return { source: "url", value: "https://doi.org/" + doi[1] };
    if (/^doi\.org\//i.test(s)) return { source: "url", value: "https://" + s };
    return { source: "text", value: s };
  }
  /* 一条投料的默认标题（用户可改）：arXiv 编号 / DOI / 域名+尾段 / 首行 */
  function initEntryTitle(it) {
    const o = it || {};
    const source = initSourceOf(o);
    if (source === "query") return clip(str(o.query) || str(o.title) || str(o.src), 40);
    if (source === "text") return clip(str(o.text) || str(o.title) || str(o.src), 40);
    const u = str(o.url) || str(o.src);
    const a = RE_ARXIV_URL.exec(u);
    if (a) return "arXiv " + a[1] + (a[2] || "");
    const bare = RE_ARXIV_ID.exec(u) || RE_ARXIV_BARE.exec(u);
    if (bare) return "arXiv " + bare[1] + (bare[2] || "");
    const doi = /(10\.\d{4,9}\/[^\s?#]+)/.exec(u);
    if (doi && /doi\.org|^10\./i.test(u)) return "DOI " + doi[1];
    const tail = (s) => {
      const clean = s.split(/[?#]/)[0].replace(/\/+$/, "");
      const seg = clean.slice(clean.lastIndexOf("/") + 1);
      try {
        return decodeURIComponent(seg);
      } catch (_) {
        return seg;
      }
    };
    const host = (u.replace(/^https?:\/\//i, "").split("/")[0] || "").replace(/^www\./i, "");
    const seg = tail(u);
    const t = host && seg && seg !== host ? host + " · " + seg : host || seg;
    return clip(t.replace(/[-_]+/g, " "), 40) || "新资料";
  }
  function initEntryKey(it) {
    const source = initSourceOf(it);
    const u = str(it.url) || str(it.src);
    if (source === "url") {
      const a = RE_ARXIV_URL.exec(u);
      if (a) return "arxiv-" + a[1].replace(/\./g, "-") + (a[2] || "");
      const bare = RE_ARXIV_ID.exec(u) || RE_ARXIV_BARE.exec(u);
      if (bare) return "arxiv-" + bare[1].replace(/\./g, "-") + (bare[2] || "");
      const doi = /(10\.\d{4,9}\/[^\s?#]+)/.exec(u);
      if (doi && /doi\.org|^10\./i.test(u)) return clip(slugify("doi-" + doi[1]), 48) || "web";
      const host = (u.replace(/^https?:\/\//i, "").split("/")[0] || "").replace(/^www\./i, "");
      const clean = u.split(/[?#]/)[0].replace(/\/+$/, "");
      const seg = clean.slice(clean.lastIndexOf("/") + 1);
      return clip(slugify((host ? host + "-" : "") + seg), 48) || "web";
    }
    if (source === "query") return clip(slugify("query-" + (str(it.query) || str(it.title))), 48) || "query";
    if (source === "text") return clip(slugify(str(it.title) || clip(str(it.text), 40)), 48) || "note";
    return foldKeyOf(str(it.rel) || str(it.src));
  }
  /* input = { topic, question, items:[{role:"core"|"ref", source, src, rel, url, query, text, title, note, main, hitBy}] }
     返回可直接落盘的队列对象；每项都算好「转成哪个 md / 折叠写哪 / 笔记写哪 / 引用键」。
     非文件项（url / text / query）没有源文件：rel 留空，mdRel 就是它自己的正文位置。 */
  function buildInitQueue(input) {
    const o = input || {};
    const items = [];
    const takenRel = new Set();
    const takenMd = new Set();
    const takenFolds = new Set();
    const takenNote = new Set();
    const seenKey = new Set();
    let i = 0;
    for (const raw of o.items || []) {
      const it = raw || {};
      const role = it.role === "core" ? "core" : "ref";
      const source = initSourceOf(it);
      const isFile = source === "file";
      const src = isFile ? str(it.src) : "";
      const rel = isFile ? uniqueRel(str(it.rel) || baseName(src), takenRel) : "";
      if (isFile) takenRel.add(rel);
      const base = isFile ? stripExt(baseName(rel)) : "";
      let key = isFile ? foldKeyOf(rel) : initEntryKey(Object.assign({}, it, { source }));
      if (seenKey.has(key)) {
        let n = 2;
        while (seenKey.has(key + "-" + n)) n++;
        key = key + "-" + n;
      }
      seenKey.add(key);
      const mdRel = isFile
        ? role === "core"
          ? uniqueRel(rel.replace(/\.[^./\\]+$/, "") + ".md", takenMd)
          : uniqueRel("literature/sources/" + key + ".md", takenMd)
        : uniqueRel((role === "core" ? "core/" : "literature/sources/") + key + ".md", takenMd);
      takenMd.add(mdRel);
      const foldsRel = role === "ref" ? uniqueRel("literature/folds/" + key + ".md", takenFolds) : "";
      if (foldsRel) takenFolds.add(foldsRel);
      const noteRel = role === "ref" ? uniqueRel("notes/40-" + key + ".md", takenNote) : "";
      if (noteRel) takenNote.add(noteRel);
      i++;
      items.push({
        id: "it" + String(i).padStart(4, "0"),
        role,
        source,
        main: role === "core" ? !!it.main : false,
        src,
        rel,
        kind: isFile ? initSourceKind(rel || src) : source === "query" ? "query" : source === "url" ? "web" : "text",
        title: str(it.title) || (isFile ? base : initEntryTitle(Object.assign({}, it, { source }))),
        note: str(it.note),
        url: source === "url" ? str(it.url) || str(it.src) : "",
        query: source === "query" ? str(it.query) || str(it.src) : "",
        text: source === "text" ? str(it.text) || str(it.src) : "",
        hitBy: str(it.hitBy),
        key,
        mdRel,
        foldsRel,
        noteRel,
        fetch: isFile ? "" : "pending",
        verify: "unverified",
        status: "pending",
        processed: false,
        processedAt: 0,
        attempts: 0,
        error: "",
        startedAt: 0,
        doneAt: 0,
      });
    }
    return {
      ver: INIT_QUEUE_VER,
      createdAt: (o.createdAt != null ? o.createdAt : Date.now()),
      topic: str(o.topic),
      question: str(o.question),
      phase: "queued",
      items,
    };
  }
  /* 一条非文件项的正文骨架：标题 + 来源 + 用户交代 + 待抓取（agent 抓到内容后替换末节） */
  function initFetchDoc(it) {
    const o = it || {};
    const source = initSourceOf(o);
    const title = str(o.title) || initEntryTitle(o);
    const ref = source === "url" ? str(o.url) : source === "query" ? str(o.query) : "";
    const lines = [
      "---",
      "title: " + JSON.stringify(title),
      "kind: source",
      "source: " + JSON.stringify(source === "query" ? "query:" + ref : ref || "user-note"),
      "fetch: pending",
      "verify: unverified",
      "createdAt: " + JSON.stringify(new Date().toISOString()),
      "tags: [" + (o.role === "core" ? "core" : "reference") + "]",
      "---",
      "",
      "# " + title,
      "",
      "> [!note] 用户交代（交给 agent）",
      "> " + (str(o.note).trim() ? str(o.note).replace(/\n/g, "\n> ") : "（没有额外说明）"),
      "",
    ];
    if (ref) {
      lines.push(source === "query" ? "## 检索式" : "## 来源", "", "- " + ref, "");
    }
    if (source === "text") {
      lines.push("## 用户写的内容", "", str(o.text) || "（空）", "");
    }
    lines.push(
      source === "query"
        ? "## 待检索"
        : source === "text"
          ? "## 待整理"
          : "## 待抓取",
      "",
      source === "query"
        ? "（agent：按这条检索式检索，取前 5 篇作为 ref 项追加进队列，再逐项处理）"
        : source === "text"
          ? "（agent：把上面这段整理成正文，不需要抓取）"
          : "（agent：抓到正文后替换本节；抓不到全文就退 Crossref / arXiv 元数据 + 摘要，并把 verify 改成 doubt）",
      "",
    );
    return lines.join("\n");
  }
  /* 队列展示态：五态之外多认两个「抓取结果」（仅摘要 / 已转 md），界面靠它上色 */
  function initItemPhase(it) {
    const o = it || {};
    const st = INIT_STATUS.indexOf(o.status) >= 0 ? o.status : "pending";
    if (st === "failed") return "failed";
    if (st === "running") return "running";
    if (st === "skipped") return "skipped";
    if (st === "done") return o.fetch === "summary" || o.verify === "doubt" ? "summary" : "done";
    if (o.fetch === "failed") return "failed";
    return o.source && o.source !== "file" ? "fetch" : "pending";
  }
  /* 追加上一条 / 一批投料（id 往后排，旧项一个字段都不动） */
  function initQueueAppend(q, items) {
    const next = JSON.parse(JSON.stringify(q || { items: [] }));
    const list = next.items || [];
    const base = list.length;
    (items || []).forEach((raw, i) => {
      const it = Object.assign({}, raw || {});
      it.id = "it" + String(base + i + 1).padStart(4, "0");
      list.push(it);
    });
    next.items = list;
    if (list.some((x) => x.status === "pending")) next.phase = "queued";
    return next;
  }
  /* 剔除一项（只允许 pending；返回新队列与被剔除的那条，调用方自己写盘与留痕） */
  function initQueueDrop(q, id) {
    const next = JSON.parse(JSON.stringify(q || { items: [] }));
    const list = next.items || [];
    const i = list.findIndex((x) => x.id === id);
    const dropped = i >= 0 ? list.splice(i, 1)[0] : null;
    next.items = list;
    return { queue: next, dropped };
  }
  function initQueueStats(q) {
    const list = (q && q.items) || [];
    const out = { total: list.length, pending: 0, running: 0, done: 0, failed: 0, skipped: 0, processed: 0, pct: 0 };
    for (const it of list) {
      const st = INIT_STATUS.indexOf(it.status) >= 0 ? it.status : "pending";
      out[st] = (out[st] || 0) + 1;
      if (initItemMarked(it)) out.processed++;
    }
    out.finished = out.done + out.skipped;
    out.pct = out.total ? Math.round((out.finished / out.total) * 100) : 0;
    return out;
  }
  /* 只改一项的纯函数（返回新对象，调用方自己决定写不写盘） */
  function queueUpdate(q, id, patch) {
    const next = JSON.parse(JSON.stringify(q || {}));
    const list = next.items || [];
    for (const it of list) {
      if (it.id !== id) continue;
      for (const k of Object.keys(patch || {})) it[k] = patch[k];
      break;
    }
    next.items = list;
    return next;
  }
  function queueNextPending(q) {
    for (const it of (q && q.items) || []) if (it.status === "pending") return it;
    return null;
  }
  function queueFailed(q) {
    return ((q && q.items) || []).filter((it) => it.status === "failed");
  }
  function queueAllDone(q) {
    const list = (q && q.items) || [];
    return list.length > 0 && list.every((it) => INIT_DONE.has(it.status));
  }

  return {
    VER,
    VERIFY_STATES,
    VERIFY_LABEL,
    NODE_KINDS,
    EDGE_KINDS,
    hashString,
    seedOf,
    mulberry32,
    slugify,
    clip,
    normRel,
    baseName,
    stripExt,
    uniq,
    parseFrontmatter,
    stringifyFrontmatter,
    parseBibtex,
    cslToBibtex,
    citeKeyOf,
    assignCiteKeys,
    yearOf,
    itemTitle,
    itemAuthorsShort,
    citeText,
    scanBlocks,
    collectWiki,
    collectCites,
    collectFormulas,
    parseNote,
    buildGraph,
    graphIndex,
    neighborhood,
    shortestPath,
    filterGraph,
    graphBounds,
    layoutForce,
    layoutLayered,
    layoutRadial,
    applyLayout,
    timeline,
    stats,
    /* 初始化 · 三层折叠 */
    FOLD_LEVELS,
    FOLD_KEYS,
    parseFolds,
    foldsToMarkdown,
    foldSkeleton,
    foldView,
    foldKeyOf,
    /* 初始化 · 队列 */
    INIT_QUEUE_VER,
    INIT_STATUS,
    INIT_SOURCES,
    initSourceKind,
    initSourceOf,
    initClassifyLine,
    initEntryTitle,
    initEntryKey,
    initFetchDoc,
    initItemPhase,
    initQueueAppend,
    initQueueDrop,
    uniqueRel,
    buildInitQueue,
    initQueueStats,
    /* 初始化 · 已处理标记 */
    processedKey,
    initItemMarked,
    markProcessed,
    processedList,
    noteProcessed,
    queueUpdate,
    queueNextPending,
    queueFailed,
    queueAllDone,
  };
});

"use strict";
/* ============ 节点只读文本视图（Markdown / YAML / 纯文本 + @引用着色） ============
 * 纯渲染层：只做「文本 → 只读 DOM」，不改节点数据、不参与接线与执行。
 * 对外三个函数：
 *   detectViewLang(text)              保守打分判定 "yaml" | "md" | "plain"
 *   nodeTextViewEl(text, opts)         生成只读视图 DOM（浏览态提示词 / 正文用）
 *   highlightAtRefsHtml(html, node)   在已有 HTML 的标签间文本段上包 @标题 / @Tag 高亮
 * 依赖 app.js（先于本文件加载）：escapeHtml / highlightYamlLine / renderMarkdown /
 * refCandidates / refTagCandidates / findCandidateByTitle / tagByAtToken。
 */

/* ---------- 判定：行级识别原语（纯函数，便于单测） ---------- */

/* 结构行 `key: value`（也接受 `key:` 空值与带引号 key）；非结构行返回 null。
 * 刻意保守：URL 协议前缀、时间 `12:30`、`#` 注释、`- ` 列表项都不算（列表另判）。 */
function nodeViewYamlKeyLine(line) {
  const s = String(line == null ? "" : line).replace(/\t/g, "  ");
  if (!s.trim()) return null;
  if (/^\s*#/.test(s)) return null;
  if (/^\s*[-?]/.test(s)) return null;
  const m = s.match(/^(\s*)(?:"([^"]*)"|'([^']*)'|([^:]+?))\s*:(?:\s+(.*))?$/);
  if (!m) return null;
  const indent = m[1].length;
  const key = String(m[2] ?? m[3] ?? m[4] ?? "").trim();
  const value = String(m[5] == null ? "" : m[5]).trim();
  if (!key || key.length > 64) return null;
  if (/^[#\[|>*&!]/.test(key)) return null;
  if (/^https?$/i.test(key) || /^ftp$/i.test(key) || /^mailto$/i.test(key)) return null;
  if (/^\/\//.test(value) || /^[a-z]+:\/\/$/i.test(value)) return null;
  return { indent: indent, key: key, value: value, quoted: m[2] != null || m[3] != null };
}

/* 列表里的结构行：`- key: value` */
function nodeViewYamlListKeyLine(line) {
  const s = String(line == null ? "" : line).replace(/\t/g, "  ");
  const m = s.match(/^(\s*)-(\s+)(.*)$/);
  if (!m || !m[2]) return null;
  const inner = nodeViewYamlKeyLine(m[3]);
  if (!inner) return null;
  return { indent: m[1].length + 1, key: inner.key, value: inner.value };
}

/* 块标量：`key: |` / `key: >`（允许 |- >+2 等修饰与行尾注释） */
function nodeViewYamlBlockScalar(line) {
  const k = nodeViewYamlKeyLine(line);
  if (!k || !k.value) return false;
  return /^[|>][-+\d]*(\s+#.*)?$/.test(k.value);
}

/* 文档分隔符：独立一行 `---` */
function nodeViewYamlDocMarker(line) {
  return /^\s*---\s*$/.test(String(line == null ? "" : line));
}

/* ---------- 判定：整篇打分 ---------- */

/* 统计一篇文本的 YAML / Markdown 证据。返回分数与行数，供 detectViewLang 使用。 */
function analyzeTextView(text) {
  const raw = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  let nonEmpty = 0;
  let yamlKey = 0; // 结构行（key: value / 有缩进承接的 key:）
  let yamlStrong = 0; // 强信号：--- / - key: / key: | / key: >
  let yamlBody = 0; // 缩进 ≥2 的承接行（块标量正文 / 子层内容）
  let yamlAny = 0; // 结构行 + 强信号 + 承接行，用于占比
  let docMarkerFirst = false;
  const mdHits = { fence: 0, heading: 0, table: 0, link: 0, bold: 0, quote: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim()) nonEmpty++;

    if (nodeViewYamlDocMarker(line)) {
      if (!docMarkerFirst && nonEmpty <= 1) docMarkerFirst = true;
      yamlStrong++;
      yamlAny++;
      continue;
    }
    if (nodeViewYamlBlockScalar(line)) {
      yamlStrong++;
      yamlAny++;
      continue;
    }
    const lk = nodeViewYamlListKeyLine(line);
    if (lk) {
      yamlStrong++;
      yamlAny++;
      continue;
    }
    const k = nodeViewYamlKeyLine(line);
    if (k) {
      if (k.value) {
        yamlKey++;
        yamlAny++;
      } else {
        /* `key:` 空值：只有下一行确实缩进更深（或紧跟 `- ` 条目）才算结构行，
           否则多半只是散文里的冒号。 */
        const nxt = lines[i + 1] == null ? "" : String(lines[i + 1]).replace(/\t/g, "  ");
        const nxtIndent = nxt.trim() ? nxt.length - nxt.replace(/^\s+/, "").length : -1;
        if (nxtIndent > k.indent || /^\s*-\s/.test(nxt)) {
          yamlKey++;
          yamlAny++;
        }
      }
      continue;
    }
    /* 既非结构行也非列表项：明显缩进（≥2 空格）的正文行算 YAML 承接内容，
       这样 `key: |` + 缩进正文这种块标量也能被认出来。 */
    if (line.trim() && !/^\s*#/.test(line)) {
      const ind = line.length - line.replace(/^\s+/, "").length;
      if (ind >= 2) {
        yamlBody++;
        yamlAny++;
      }
    }
  }

  const body = raw;
  /* 强 YAML 信号很多时，行首 `#` 更可能是 YAML 注释而不是 Markdown 标题。 */
  const strongYaml =
    yamlStrong >= 2 ||
    yamlKey >= 2 ||
    (yamlStrong >= 1 && (yamlKey >= 1 || yamlBody >= 1));
  if (/^\s*(```|~~~)/m.test(body)) mdHits.fence++;
  if (!strongYaml && /^\s{0,3}#{1,6}\s+\S/m.test(body)) mdHits.heading++;
  if (/(^|\n)\s*\|?[\s:|-]*-{3,}[\s:|-]*\|/m.test(body)) mdHits.table++;
  if (/\[[^\]\n]{1,400}\]\([^)\n]{1,600}\)/.test(body)) mdHits.link++;
  if (/\*\*[^\s*][^\n]{0,400}?\*\*/.test(body)) mdHits.bold++;
  if (/^\s*>\s+\S/m.test(body)) mdHits.quote++;

  const md =
    mdHits.fence + mdHits.heading + mdHits.table + mdHits.link + mdHits.bold + mdHits.quote;
  return {
    nonEmpty: nonEmpty,
    lines: lines.length,
    yamlKey: yamlKey,
    yamlStrong: yamlStrong,
    yamlBody: yamlBody,
    yamlAny: yamlAny,
    yamlKeyRatio: nonEmpty ? yamlAny / nonEmpty : 0,
    docMarkerFirst: docMarkerFirst,
    strongYaml: strongYaml,
    md: md,
    mdHits: mdHits,
  };
}

/* 保守判定视图语言：yaml / md / plain。
 * 原则：有任何 Markdown 信号就先 md；YAML 必须「成规模」才算；拿不准一律 plain；
 * 单行 / 极短提示词永远不会被判成 yaml。 */
function detectViewLang(text) {
  const st = analyzeTextView(text);
  if (!st.nonEmpty) return "plain";
  if (st.md > 0) return "md";
  if (st.nonEmpty < 2) return "plain";
  if (st.yamlStrong >= 2) return "yaml";
  if (st.yamlStrong >= 1 && (st.yamlKey >= 1 || st.yamlBody >= 1)) return "yaml";
  if (st.yamlKey + st.yamlBody >= 2 && st.yamlKeyRatio >= 0.6) return "yaml";
  if (st.docMarkerFirst && st.yamlAny >= 2) return "yaml";
  return "plain";
}

/* ---------- @引用着色：只处理 HTML 标签之间的文本段 ---------- */

const AT_REF_RE = /@([^\s@，。；、！？：,!?;:]+)/g;
const HTML_CHUNK_RE = /(<[^>]*>)|([^<]+)/g;

function nodeViewWrapAtRef(cls, color, tokenHtml) {
  return (
    '<span class="' + cls + '" style="color:' + color + '">' + tokenHtml + "</span>"
  );
}

/* 在「已转义 / 已生成」的 HTML 上补 @标题（青）/ @Tag（紫）高亮。
 * 判定逻辑与 promptRefBackdropHtml 对齐，但输入已是 HTML：不再二次转义，
 * 且绝不改动标签与属性（链接 href 等）。 */
function highlightAtRefsHtml(html, node) {
  const src = String(html == null ? "" : html);
  if (!src || src.indexOf("@") < 0) return src;
  const cands =
    node && typeof refCandidates === "function" ? refCandidates(node) || [] : [];
  const tags =
    node && typeof refTagCandidates === "function"
      ? new Set(refTagCandidates(node) || [])
      : new Set();
  if (!cands.length && !tags.size) return src;
  const markToken = (tokenHtml) =>
    tokenHtml.replace(AT_REF_RE, (m, tok) => {
      if (typeof findCandidateByTitle === "function" && findCandidateByTitle(cands, tok))
        return nodeViewWrapAtRef("at-ref-node", "var(--cyan)", m);
      const tag = typeof tagByAtToken === "function" ? tagByAtToken(tok) : "";
      if (tag && tags.has(tag)) return nodeViewWrapAtRef("at-ref-tag", "#e0a0ff", m);
      return m;
    });
  return src.replace(HTML_CHUNK_RE, (whole, tag, text) =>
    tag ? tag : markToken(text),
  );
}

/* ---------- 只读视图 DOM ---------- */

function nodeViewIsEmpty(text) {
  return !String(text == null ? "" : text).trim();
}

function nodeViewEmptyEl() {
  const el = document.createElement("div");
  el.className = "ntv-empty";
  el.style.color = "var(--muted)";
  el.textContent =
    typeof I18n !== "undefined" ? I18n.t("（空）") : "（空）";
  return el;
}

/* opts: { lang?: "yaml"|"md"|"plain"（显式覆盖自动判定）, node?: 消费者节点（@引用判定用）,
          class?: 附加类名 } */
function nodeTextViewEl(text, opts) {
  const o = opts || {};
  const raw = String(text == null ? "" : text);
  const wrap = document.createElement("div");
  wrap.className = "node-text-view" + (o.class ? " " + o.class : "");

  if (nodeViewIsEmpty(raw)) {
    wrap.dataset.viewLang = "plain";
    wrap.appendChild(nodeViewEmptyEl());
    return wrap;
  }

  const lang =
    o.lang === "yaml" || o.lang === "md" || o.lang === "plain"
      ? o.lang
      : detectViewLang(raw);
  wrap.dataset.viewLang = lang;
  wrap.classList.add("ntv-" + lang);

  let html = "";
  if (lang === "yaml") {
    /* 复用 app.js 的 YAML 着色：去掉行号与大纲，只留纯文本行 + 颜色类。 */
    const pre = document.createElement("div");
    pre.className = "ntv-yaml";
    /* 只设功能性的空白保留，字体/字号交给 CSS（assist.css 的 .ntv-* / .yaml-* 类） */
    pre.style.whiteSpace = "pre-wrap";
    pre.style.overflowWrap = "anywhere";
    html = String(raw)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(function (line) {
        return typeof highlightYamlLine === "function"
          ? highlightYamlLine(line)
          : typeof escapeHtml === "function"
            ? escapeHtml(line)
            : line;
      })
      .join("\n");
    pre.innerHTML = highlightAtRefsHtml(html, o.node);
    wrap.appendChild(pre);
    return wrap;
  }

  if (lang === "md") {
    const body = document.createElement("div");
    body.className = "ntv-md";
    html =
      typeof renderMarkdown === "function"
        ? renderMarkdown(raw)
        : typeof escapeHtml === "function"
          ? "<pre>" + escapeHtml(raw) + "</pre>"
          : raw;
    body.innerHTML = highlightAtRefsHtml(html, o.node);
    wrap.appendChild(body);
    return wrap;
  }

  const body = document.createElement("div");
  body.className = "ntv-plain";
  body.style.whiteSpace = "pre-wrap";
  body.style.overflowWrap = "anywhere";
  html = typeof escapeHtml === "function" ? escapeHtml(raw) : raw;
  body.innerHTML = highlightAtRefsHtml(html, o.node);
  wrap.appendChild(body);
  return wrap;
}

/* ============================================================================
 * renderer/research-index.js — 研究视图「索引页」= 原文在前的紧凑仪表盘
 *   （window.MTResearchIndex · UMD，浏览器与 node 共用同一份）
 *
 * 研究库里 `research.json` 的 corePath（缺省 notes/00-课题.md）是这棵库的索引根。
 * 以前它和别的笔记一样按 Markdown 文档渲染：一篇长文，看不出库里到底有什么。现在的形态：
 *
 *   页头     「索引 · 原文在前」+ 一颗「原文」（切回这一篇的 Markdown 阅读态）
 *   课题头卡 课题标题 + 核心问题（取自索引那一篇的 frontmatter title / `> [!question] 核心问题`，
 *            读不到才退 research.json）：两处就地编辑，改完写回那一篇真源
 *   问题清单 就在课题头卡内部（和「核心问题」同一块，不再单占一区），
 *            全库 `> [!question]` 块 + kind: question 的笔记，一行一条：内容就地改、删除、
 *            状态（callout 里的 `> qstatus:` 行）、勾选与批量改状态、
 *            建议 / 方案（块里的 `> advice: [[…]]` / `> fix: [[…]]`，可多条、可续行；
 *            每行一颗入口：挂上了显示建议笔记标题、点开那一篇；没挂上就不摆这一颗）、
 *            新增（头行「＋ 新增问题」：就地一行输入标题 + 正文，交宿主 onQuestionNew 落盘）、
 *            状态字典（默认四档 + 自定义名称 / 颜色，存 research.json 的 questionStatus；
 *            入口是每行状态下拉最下面的「＋ 新状态」）
 *   标签页   原文 / 论断 / 概念 / 方法 / 问题 —— 就是原来那排数字，现在每颗都能点
 *            （button toggle）：默认「原文」，点一下下方卡片区跟着换成那一类
 *   卡片区   当前标签页那几篇：
 *            原文 = core/*.md 原件（衍生物并进同一张卡），**双列大卡**（正文至少露五行 + 路径，
 *            只有一张卡时占满整页）；
 *            论断 / 概念 / 方法 / 问题 = **纵向一列、一行一条**（标题 + 一行摘要，不再摆大卡预览），
 *            点行 = 在那一行下方弹**与阅读区同款**的浮空卡（卡里就这一篇一条，点开展开全文，
 *            行尾那颗「打开」才进笔记；问题行按 line 跳到那一块）。卡本体在
 *            renderer/research-reader.js 的 noteCardList 里，索引页只递 hits，不复制第二份
 *
 * 三条纪律（共识，改之前先看）：
 *   1. **Markdown 是真源**：本模块只读 RS.notes 的记录，**自己不写盘**
 *      （头卡的两处编辑只产出「改好的 Markdown 文本」，落盘是宿主 writeText + logChange 的事），
 *      也不重排正文；
 *   2. **衍生物必须并进原文**：versions 组（research-versions.js 的 buildGroups）里
 *      只有原件出一张卡，译稿 / 摘要 / 节选一律不单独成卡 —— 它们只在**那一篇页面内**
 *      用阅读区上方的平铺条切换（见 app-research.js 的 renderReadTools）；
 *      文献（library.json）与笔记（notes/ 里其余）只在标签页上计数；
 *   3. **视觉只吃主题变量**：颜色 / 字体 / 圆角全部沿用 css/research.css 的既有 token
 *      （--ink / --muted / --bd / --panel2 / --cyan…），不新造一套配色。
 *
 * 与 app-research.js 的分工：那边只做「视图状态 ⇄ 模块」的薄适配（renderEditor 里
 * rsIndexDash()），数据装配、归组、过滤、计数全在这里，node 侧测试直接 require 这一份。
 * 版本组不在这里算 —— 那是 research-versions.js 的唯一口径，由宿主传进来（groups）。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MTResearchIndex = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /* 标签页：原文 + 四类知识（文献 / 笔记不出卡，只在标签上计数） */
  const KIND_ORDER = ["claim", "concept", "method", "question"];
  const KIND_LABEL = { claim: "论断", concept: "概念", method: "方法", question: "问题" };
  /* 卡片正文至少露五行（共识）；从正文里多取一些交给 CSS 截，单篇占满时自然铺开 */
  const PREVIEW_LINES = 5;
  const PREVIEW_MAX = 40;

  const str = (v) => (v == null ? "" : String(v)).trim();

  function normRel(p) {
    return str(p)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
  }

  function noteTitle(note) {
    const parsed = (note && note.parsed) || {};
    return (
      str(note && note.title) ||
      str(parsed.note && parsed.note.label) ||
      normRel(note && note.path).split("/").pop().replace(/\.md$/i, "")
    );
  }

  /* 卡片正文 = 真 Markdown 的投影（不是第二份内容）：只削掉 frontmatter ——
     开头的大标题**留着**，卡片要从「# 标题」读起；callout / 列表 / 表格 / 公式 / 代码
     原样保留，交给渲染器出真结构。截断按非空行数算（空行不占五行，别拿五行空白充数），
     围栏代码块与跨行显示公式（`$$ … $$` / `\[ … \]`）整块留下 —— 切在中间会让渲染器
     把半截 LaTeX 当正文吐出来（卡片上露 `$$` / `\frac` 源码）；真截在围栏里就把围栏
     收口、真截在公式里就补上闭合符。
     返回 Markdown 文本（不在这里出 HTML：渲染器只有宿主有，见 previewHtml）。 */
  const DISPLAY_MAX_ROWS = 30; /* 跨行公式最多跟着收这么多行，防一个畸形块把卡撑爆 */
  function previewMarkdown(md, maxLines) {
    const limit = Number(maxLines) > 0 ? Number(maxLines) : PREVIEW_MAX;
    let body = String(md == null ? "" : md)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n");
    const fm = /^---\n[\s\S]*?\n---[ \t]*\n?/.exec(body);
    if (fm) body = body.slice(fm[0].length);
    const out = [];
    let fence = ""; /* 正在哪个围栏里（``` / ~~~），空 = 围栏外 */
    let display = ""; /* 正在跨行显示公式里（`$$` 的闭合符 / `\]`），空 = 不在里面 */
    let displayRows = 0; /* 跨行公式已收了多少行（见 DISPLAY_MAX_ROWS） */
    let used = 0; /* 已收的有效行（空行不计数） */
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        const mark = f[1].charAt(0);
        if (!fence) fence = mark;
        else if (fence === mark) fence = "";
        out.push(line);
        used++;
        continue;
      }
      /* 跨行显示公式：**整块收进来**，不按行数上限切断（只受 DISPLAY_MAX_ROWS 兜底）。 */
      if (display) {
        if (displayRows >= DISPLAY_MAX_ROWS) {
          out.push(display); /* 太长的畸形块：就地补闭合符收口 */
          display = "";
          break;
        }
        out.push(line);
        used++;
        displayRows++;
        if (line.indexOf(display) >= 0) display = "";
        continue;
      }
      if (!fence && !line.trim()) {
        if (used) out.push(""); /* 已有内容才留空行：卡片开头别空一片 */
        continue;
      }
      if (!fence && used >= limit) break;
      out.push(line);
      used++;
      /* 行首开了显示公式但这一行没闭合：记住闭合符，后面几行都算这一块 */
      if (!fence) {
        const trimmed = line.replace(/^\s*(?:>\s?)*/, "").replace(/^\s+/, "");
        const closer = trimmed.slice(0, 2) === "$$" ? "$$" : trimmed.slice(0, 2) === "\\[" ? "\\]" : "";
        if (closer && trimmed.slice(2).indexOf(closer) < 0) {
          display = closer;
          displayRows = 0;
        }
      }
    }
    let text = out.join("\n").replace(/\s+$/, "");
    if (fence) text += "\n" + fence.repeat(3);
    if (display) text += "\n" + display; /* 上限到了却没闭合：补上闭合符，别留半截 */
    return text;
  }

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ESC_MAP[c]);
  }

  /* 预览 Markdown → 卡片 HTML：渲染器由宿主注入（app-research.js 的 renderMarkdown，
     内部是 mdToRichHtml —— 先转义再解析，与阅读态同一份口径，链接 / 图片 / 公式一致）。
     本模块是 UMD 纯函数、node 里可 require：拿不到渲染器时退化成转义纯文本，
     绝不把未转义的正文塞进 innerHTML。 */
  function previewHtml(md, renderMd) {
    const src = str(md);
    if (!src) return "";
    let html = "";
    if (typeof renderMd === "function") {
      try {
        html = String(renderMd(src) || "");
      } catch (_) {
        html = "";
      }
    }
    if (!html) html = escHtml(src).replace(/\n/g, "<br>");
    return html;
  }

  /* 一篇笔记 → 卡片正文字段：{ md, html, headed }
     headed = 正文自己带了标题（# / ## …）：卡上就把它当 h1/h2 用，不再重复摆一行标题。 */
  function sourceBody(note, renderMd) {
    const md = previewMarkdown(note && note.md);
    return { md: md, html: previewHtml(md, renderMd), headed: /^\s*#{1,6}\s+\S/.test(md) };
  }

  /* ── 课题头卡：标题 + 核心问题 ──────────────────────────────────────────────
     两处都只是**那一篇笔记的投影**（Markdown 仍是真源，这里不存第二份内容）：
       标题     frontmatter 的 title → 正文首个 `# 行` → research.json 的 title
       核心问题 `> [!question] 核心问题` 的正文 → 第一条 question 块 → research.json 的 question
     读（topicModel）与改（setTopicTitle / setCoreQuestion / appendQuestion）都在这里，
     全是字符串手术的纯函数：node 里能 require 复核；落盘是宿主的事（writeText + logChange）。 */
  const CORE_Q = "核心问题";

  function linesOf(md) {
    return String(md == null ? "" : md)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
  }

  /* frontmatter 的起止行号（0 起；没有 frontmatter 就是 -1） */
  function fmRange(lines) {
    const list = lines || [];
    if (!list.length || !/^---[ \t]*$/.test(list[0])) return { open: -1, close: -1 };
    for (let i = 1; i < list.length; i++) if (/^---[ \t]*$/.test(list[i])) return { open: 0, close: i };
    return { open: -1, close: -1 };
  }
  function bodyStart(lines) {
    const fm = fmRange(lines);
    return fm.close >= 0 ? fm.close + 1 : 0;
  }

  /* ── 问题清单的状态 ────────────────────────────────────────────────────────
     状态写在 question 块的正文里，一行 `> qstatus: <id>`。
     键名刻意**不叫 status / verify**：research-core 的 readVerify 正则认 `state|status`，
     写 `status: solved` 会让那一块被读成「已验 / 存疑」，验证态与问题态两套语义就串了。

     字典（见下方 qStatusDict）：默认四档 id 稳定，标签在渲染时走 t()；
     自定义档存在 research.json 的 `questionStatus: [{ id, label, color }]`（由宿主 saveMetaPatch 写盘，
     保留 meta 的未知键）。**颜色只是数据**：渲染时内联成 CSS 变量 `--rs-qs`，
     css 里不新增裸色值；默认色一律取主题 token（--orange / --cyan / --muted / --green）。 */
  const Q_FALLBACK = "open";
  const Q_STATUS_DEFAULT = [
    { id: "open", label: "默认", color: "var(--orange)" },
    { id: "doing", label: "调研中", color: "var(--cyan)" },
    { id: "parked", label: "解决中", color: "var(--muted)" },
    { id: "solved", label: "已解决", color: "var(--green)" },
  ];
  /* 兼容旧名：默认四档（不带 meta 的场合，如没有 research.json 时的兜底） */
  const Q_STATUS = Q_STATUS_DEFAULT;
  const Q_STATUS_LABEL = Q_STATUS_DEFAULT.reduce((m, s) => {
    m[s.id] = s.label;
    return m;
  }, {});
  /* 面板里的色板：全是主题 token（用户要别的颜色就填自定义 hex） */
  const Q_PALETTE = [
    { label: "青", color: "var(--cyan)" },
    { label: "浅青", color: "var(--cyan2)" },
    { label: "绿", color: "var(--green)" },
    { label: "橙", color: "var(--orange)" },
    { label: "黄", color: "var(--yellow)" },
    { label: "蓝", color: "var(--blue)" },
    { label: "红", color: "var(--red)" },
    { label: "灰", color: "var(--muted)" },
  ];
  const RE_QSTATUS = /^\s*qstatus\s*[:：]\s*([A-Za-z0-9_-]+)\s*$/i;
  /* 带前缀的整行（callout 的 `> qstatus: x` 与 frontmatter 的 `qstatus: x` 都能改） */
  const RE_QSTATUS_LINE = /^(\s*>\s?)?(qstatus[ \t]*[:：][ \t]*)([A-Za-z0-9_-]+)([ \t]*)$/i;
  const qstatusLine = (id) => "> qstatus: " + str(id).toLowerCase();

  /* 状态 id：只留 ascii 安全字符（写进 Markdown 的那一行要能被同一套正则读回来） */
  function qStatusId(v) {
    return str(v)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  /* 颜色只认两种：主题 token（var(--x)）或 #rgb / #rrggbb；其它一律退回落点 */
  function qColor(v, fallback) {
    const s = str(v);
    if (/^var\(--[a-z0-9-]+\)$/i.test(s)) return s;
    if (/^#[0-9a-f]{3}$/i.test(s) || /^#[0-9a-f]{6}$/i.test(s)) return s;
    return str(fallback) || "var(--cyan)";
  }

  /* research.json → 状态字典：[{ id, label, color, custom }]
     默认四档打底（删不掉：它们是「回落到 默认」的落点），meta 里同 id 的项改标签 / 颜色，
     其余按顺序追加为自定义档。 */
  function qStatusDict(meta) {
    const list = [];
    const byId = new Map();
    for (const d of Q_STATUS_DEFAULT) {
      const it = { id: d.id, label: d.label, color: d.color, custom: false };
      list.push(it);
      byId.set(it.id, it);
    }
    const raw = meta && Array.isArray(meta.questionStatus) ? meta.questionStatus : [];
    for (const e of raw) {
      if (!e || typeof e !== "object") continue;
      const id = qStatusId(e.id);
      if (!id) continue;
      const hit = byId.get(id);
      const label = str(e.label);
      const color = qColor(e.color, hit ? hit.color : "var(--cyan)");
      if (hit) {
        if (label) hit.label = label;
        hit.color = color;
        continue;
      }
      const it = { id: id, label: label || id, color: color, custom: true };
      list.push(it);
      byId.set(it.id, it);
    }
    return list;
  }

  /* 一个 id → 字典里的那一项；字典里没有（刚被删掉 / 笔记里是旧 id）就退到 默认 */
  function qStatusOf(dict, id) {
    const list = Array.isArray(dict) && dict.length ? dict : Q_STATUS_DEFAULT;
    const want = qStatusId(id);
    return list.find((s) => s.id === want) || list.find((s) => s.id === Q_FALLBACK) || list[0] || null;
  }

  /* 字典 → 写回 research.json 的 questionStatus（默认档也一起写：标签 / 颜色改过才留得下） */
  function qStatusPatch(dict) {
    const out = [];
    const seen = new Set();
    for (const s of Array.isArray(dict) ? dict : []) {
      const id = qStatusId(s && s.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id: id, label: str(s.label) || id, color: qColor(s.color, "var(--cyan)") });
    }
    return out;
  }

  /* 新状态的 id：标签是 ascii 就取它，否则 st1 / st2…（撞了 id 就往后找） */
  function qStatusNewId(dict, label) {
    const taken = new Set((Array.isArray(dict) ? dict : []).map((s) => qStatusId(s && s.id)));
    const base = str(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20);
    if (base && !taken.has(base)) return base;
    let n = 1;
    while (taken.has("st" + n)) n++;
    return "st" + n;
  }

  /* 一篇 Markdown 里引用到的状态 id（callout 里的那一行 + frontmatter 的 qstatus:） */
  function qStatusRefs(md) {
    const out = [];
    for (const line of linesOf(md)) {
      const m = RE_QSTATUS_LINE.exec(line);
      if (m) out.push(str(m[3]).toLowerCase());
    }
    return out;
  }

  /* 删除 / 改名之后不留悬空 id：字典里已经没有的状态一律改写成 默认（只动那一行） */
  function normalizeQStatusRefs(md, dict) {
    const src = String(md == null ? "" : md);
    const ids = new Set((Array.isArray(dict) ? dict : []).map((s) => qStatusId(s && s.id)));
    ids.add(Q_FALLBACK);
    let changed = false;
    const lines = linesOf(src).map((line) => {
      const m = RE_QSTATUS_LINE.exec(line);
      if (!m) return line;
      if (ids.has(str(m[3]).toLowerCase())) return line;
      changed = true;
      return (m[1] || "") + m[2] + Q_FALLBACK + (m[4] || "");
    });
    return changed ? lines.join("\n") : src;
  }

  /* 一块正文里的状态 id（没有就空） */
  function readQStatus(text) {
    for (const line of String(text == null ? "" : text).split("\n")) {
      const m = RE_QSTATUS.exec(line);
      if (m) return str(m[1]).toLowerCase();
    }
    return "";
  }
  /* ── 建议 / 方案：挂在问题块里的两条链接字段 ────────────────────────────────
     与 `> qstatus:` 同层，都算「元数据行」，不进清单正文：
       `> advice: [[建议稿标题]]`（可多条）   `> fix: [[方案稿标题]]`
     续行 = 紧跟在 advice / fix 后面、缩进过并带 wikilink 的同层行（`>   [[另一条]]`），
     或整行只有 wikilink 的行 —— 手写时常常把链接直接折到下一行。
     值一律归一成 wikilink **标题**数组（`[[标题|别名]]` 取标题，重复的去掉）。 */
  const RE_QADVICE = /^\s*(advice|fix)\s*[:：]\s*(.*)$/i;
  const Q_LINK_FIELDS = ["advice", "fix"];

  /* "[[A]] [[B|别名]]" → ["A", "B"] */
  function qLinkList(v) {
    const s = String(v == null ? "" : v);
    const re = /\[\[([^\[\]]+)\]\]/g;
    const out = [];
    let m = null;
    while ((m = re.exec(s))) {
      const t = str(m[1]).replace(/\|.*$/, "").trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  /* 一串标题 → 归一后的 wikilink 标题数组（去空 / 去重；带不带 `[[ ]]` 都认） */
  function normLinkTitles(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : [list]) {
      const s = str(raw);
      if (!s) continue;
      for (const t of s.indexOf("[[") >= 0 ? qLinkList(s) : [s.trim()]) {
        if (t && out.indexOf(t) < 0) out.push(t);
      }
    }
    return out;
  }

  /* 一行（引号已经剥掉）的元数据：qstatus / advice / fix；不是元数据行就 null */
  function qMetaOf(line) {
    const s = str(line);
    const st = RE_QSTATUS.exec(s);
    if (st) return { key: "qstatus", value: str(st[1]).toLowerCase(), links: [] };
    const ad = RE_QADVICE.exec(s);
    if (!ad) return null;
    return { key: str(ad[1]).toLowerCase(), value: str(ad[2]).trim(), links: qLinkList(ad[2]) };
  }

  /* 续行判定（只对 advice / fix 有效） */
  function qLinkContinuation(line) {
    const s = str(line);
    const t = s.trim();
    if (!t || t.indexOf("[[") < 0) return false;
    if (/^(\[\[[^\[\]]+\]\][ \t]*)+$/.test(t)) return true;
    return /^\s/.test(s) && qLinkList(s).length > 0;
  }

  /* 内容 = 正文去掉三类元数据行（qstatus / advice / fix，含它们的续行） */
  function stripQMeta(text) {
    const out = [];
    let cont = false;
    for (const line of String(text == null ? "" : text).split("\n")) {
      const m = qMetaOf(line);
      if (m) {
        cont = Q_LINK_FIELDS.indexOf(m.key) >= 0;
        continue;
      }
      if (cont && qLinkContinuation(line)) continue;
      cont = false;
      out.push(line);
    }
    return out.join("\n").trim();
  }

  /* 一块正文里的 advice / fix 链接：{ advice: [标题…], fix: [标题…] } */
  function readQLinks(text) {
    const res = { advice: [], fix: [] };
    let cur = "";
    for (const line of String(text == null ? "" : text).split("\n")) {
      const m = qMetaOf(line);
      if (m) {
        cur = Q_LINK_FIELDS.indexOf(m.key) >= 0 ? m.key : "";
        if (cur) for (const t of m.links) if (res[cur].indexOf(t) < 0) res[cur].push(t);
        continue;
      }
      if (cur && qLinkContinuation(line)) {
        for (const t of qLinkList(line)) if (res[cur].indexOf(t) < 0) res[cur].push(t);
        continue;
      }
      cur = "";
    }
    return res;
  }

  const qLinkLine = (key, title) => "> " + key + ": [[" + str(title) + "]]";

  /* 块尾的元数据行（qstatus → advice… → fix…）：改正文时原样搬回去，链接不会丢 */
  function qMetaLines(b) {
    const out = [];
    if (b && b.status) out.push(qstatusLine(b.status));
    for (const key of Q_LINK_FIELDS) for (const t of (b && b[key]) || []) out.push(qLinkLine(key, t));
    return out;
  }

  /* 正文里的 question 块：{ start, end, title, text, body, status, advice, fix }（行号是整篇 md 的，end 不含）
     text = 内容（`> qstatus:` / `> advice:` / `> fix:` 这些元数据行剔掉：它们各是字段，不该混在正文里）
     body = 引号剥掉后的整块正文（含元数据行）；status = 读到的状态 id（读不到就是空）
     advice / fix = 建议 / 方案的笔记标题数组（wikilink，读不到就是空数组） */
  function questionBlocks(md) {
    const lines = linesOf(md);
    const out = [];
    let i = bodyStart(lines);
    while (i < lines.length) {
      const co = /^\s*>\s*\[!([^\]|]+)(?:\|([^\]]*))?\](.*)$/.exec(lines[i]);
      if (!co) {
        i++;
        continue;
      }
      let end = i + 1;
      while (end < lines.length && /^\s*>/.test(lines[end])) end++;
      /* `[!question]- 核心问题`（Obsidian 折叠写法）里那个 - 是修饰符，不是标题的一部分 */
      const title = str(co[3]).replace(/^[-+]?[ \t]*/, "").trim();
      const body = lines
        .slice(i + 1, end)
        .map((l) => l.replace(/^\s*>\s?/, ""))
        .join("\n")
        .trim();
      if (str(co[1]).toLowerCase() === "question") {
        const links = readQLinks(body);
        out.push({
          start: i,
          end: end,
          title: title,
          text: stripQMeta(body),
          body: body,
          status: readQStatus(body),
          advice: links.advice,
          fix: links.fix,
        });
      }
      i = end;
    }
    return out;
  }

  function firstHeadingText(md) {
    const lines = linesOf(md);
    for (let i = bodyStart(lines); i < lines.length; i++) {
      const m = /^\s*#\s+(\S.*)$/.exec(lines[i]);
      if (m) return m[1].trim();
    }
    return "";
  }

  /* 一篇笔记 + research.json → 头卡要的值（两条回退链只写在这一点） */
  function topicModel(note, meta) {
    const md = String((note && note.md) || "");
    const fmTitle = str(note && note.meta && note.meta.title);
    const headTitle = firstHeadingText(md);
    const blocks = questionBlocks(md);
    const pick = blocks.find((b) => str(b.title).indexOf(CORE_Q) >= 0) || blocks[0] || null;
    const qText = pick ? str(pick.text) : "";
    const metaQ = str(meta && meta.question);
    return {
      path: normRel(note && note.path),
      title: fmTitle || headTitle || str(meta && meta.title) || noteTitle(note || {}),
      question: qText || metaQ,
      /* 值当前来自哪一层（头卡据此提示「写在哪」） */
      titleFrom: fmTitle ? "frontmatter" : headTitle ? "heading" : "meta",
      questionFrom: qText ? "callout" : metaQ ? "meta" : "",
      questions: blocks.length,
      hasCore: !!blocks.find((b) => str(b.title).indexOf(CORE_Q) >= 0),
    };
  }

  /* YAML 标量（与 research-core 的 fmValue 同一口径：带特殊字符才加引号） */
  function yamlScalar(s) {
    const v = str(s);
    if (!v) return '""';
    if (/[:#[\]{}",]/.test(v) || /^\s|\s$/.test(v)) return JSON.stringify(v);
    return v;
  }

  /* 改标题：frontmatter 的 title 行 + 正文首个 `# 行` —— 两处都写，否则下次打开就自相矛盾 */
  function setTopicTitle(md, title) {
    const want = str(title);
    if (!want) return String(md == null ? "" : md);
    const lines = linesOf(md);
    const fm = fmRange(lines);
    const kv = "title: " + yamlScalar(want);
    if (fm.close >= 0) {
      let hit = -1;
      for (let i = fm.open + 1; i < fm.close; i++) {
        if (/^title[ \t]*:/.test(lines[i])) {
          hit = i;
          break;
        }
      }
      if (hit >= 0) lines[hit] = kv;
      else lines.splice(fm.close, 0, kv);
    } else {
      /* 这一篇还没有 frontmatter：补一段最小的，正文原样往下挪 */
      lines.unshift("---", kv, "---", "");
    }
    const fm2 = fmRange(lines);
    const from = fm2.close >= 0 ? fm2.close + 1 : 0;
    let h = -1;
    for (let i = from; i < lines.length; i++) {
      if (/^\s*#\s+\S/.test(lines[i])) {
        h = i;
        break;
      }
    }
    if (h >= 0) lines[h] = "# " + want;
    else {
      /* 正文里没有大标题：补在正文最前面（frontmatter 之后、空行之前） */
      let at = from;
      while (at < lines.length && !lines[at].trim()) at++;
      lines.splice(at, 0, "# " + want, "");
    }
    return lines.join("\n");
  }

  function quoteLines(text) {
    const s = str(text);
    if (!s) return [">"];
    return s.split("\n").map((l) => (l.trim() ? "> " + l.replace(/\s+$/, "") : ">"));
  }

  /* 改核心问题：换掉 `> [!question] 核心问题` 的正文，标题行原样留着；
     没有「核心问题」块就并进第一条 question，一条都没有就按模板追加。
     元数据行（`> qstatus:` / `> advice:` / `> fix:`）是另外的字段，改内容时原样留在块尾。 */
  function setCoreQuestion(md, question) {
    const q = str(question);
    if (!q) return String(md == null ? "" : md);
    const src = String(md == null ? "" : md);
    const lines = linesOf(src);
    const blocks = questionBlocks(src);
    const hit = blocks.find((b) => str(b.title).indexOf(CORE_Q) >= 0) || blocks[0] || null;
    if (!hit) return appendQuestion(src, CORE_Q, q);
    const next = quoteLines(q);
    next.push(...qMetaLines(hit));
    lines.splice(hit.start + 1, hit.end - hit.start - 1, ...next);
    return lines.join("\n");
  }

  /* 追加一条 question 块：标题按现有条数命名（没有就补「核心问题」，之后是「问题 2」…）。
     正文为空就只落标题行：不写 `>` 空行（干净的待填块，与「＋ 新增问题」的落点一致）。 */
  function appendQuestion(md, title, text) {
    const blocks = questionBlocks(md);
    const name = str(title) || (blocks.length ? "问题 " + (blocks.length + 1) : CORE_Q);
    const content = str(text);
    let body = String(md == null ? "" : md)
      .replace(/\r\n?/g, "\n")
      .replace(/\s+$/, "");
    body +=
      (body ? "\n\n" : "") +
      "> [!question] " +
      name +
      (content ? "\n" + quoteLines(content).join("\n") : "");
    return body + "\n";
  }

  /* ── 问题清单：全库待解问题 ────────────────────────────────────────────────
     聚合两处（都是 Markdown 真源，聚合本身不改盘）：
       · 任意笔记里的 `> [!question] 标题` 块 —— 行号锚点取 research-core 的
         parsed.nodes（kind: question，line = 块首行的 1 基行号，path = 那一篇）
       · frontmatter 写了 `kind: question`（或 tags 含 question）的笔记本身 —— 这种笔记
         自己没有 question 块时，清单里那一行代表整篇，内容就是它的标题
     每项 = { id, kind:"callout"|"note", path, line, endLine, note, title, text, status, advice, fix }
     （advice / fix = 建议 / 方案的笔记标题数组，界面据此判断「有没有建议 / 方案」）
     写回也在这里（纯字符串手术，落盘是宿主的事）：改内容只换那一块的正文行、
     改状态只写/换/删那一行 `> qstatus:`，改建议 / 方案只动 `> advice:` / `> fix:` 那几行，
     别的块一个字节都不动。 */

  /* 行号锚点 → 块：parsed.nodes 给的是块首行；文档动过就退到「包含这一行」的那一块 */
  function blockAt(md, line) {
    const want = Number(line) || 0;
    const blocks = questionBlocks(md);
    if (!blocks.length || !want) return null;
    const exact = blocks.find((b) => b.start + 1 === want);
    if (exact) return exact;
    return blocks.find((b) => want > b.start + 1 && want <= b.end) || null;
  }

  /* 改某一条问题的内容：换掉块里的正文行，元数据行（qstatus / advice / fix）原样留在块尾 */
  function setQuestionText(md, line, text) {
    const q = str(text);
    const src = String(md == null ? "" : md);
    const b = blockAt(src, line);
    if (!b || !q) return src;
    const lines = linesOf(src);
    const next = quoteLines(q);
    next.push(...qMetaLines(b));
    lines.splice(b.start + 1, b.end - b.start - 1, ...next);
    return lines.join("\n");
  }

  /* 改某一条问题的状态：在块里写一行 `> qstatus: <id>`（已有就换，空 = 删掉这一行） */
  function setQuestionStatus(md, line, statusId) {
    const src = String(md == null ? "" : md);
    const b = blockAt(src, line);
    if (!b) return src;
    const id = str(statusId).toLowerCase();
    const lines = linesOf(src);
    const body = lines.slice(b.start + 1, b.end);
    let hit = -1;
    for (let i = 0; i < body.length; i++) {
      if (RE_QSTATUS.test(body[i].replace(/^\s*>\s?/, ""))) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) {
      if (id) body[hit] = qstatusLine(id);
      else body.splice(hit, 1);
    } else if (id) body.push(qstatusLine(id));
    lines.splice(b.start + 1, b.end - b.start - 1, ...body);
    return lines.join("\n");
  }

  /* 写 / 换 / 删某一条问题的「建议 / 方案」链接：只动这两类元数据行，别的块一个字节都不动。
     opts = { advice: [标题…], fix: [标题…] }：
       · 键缺省（undefined / null）= 那一类原样保留；给空数组 = 删掉那一类的全部行
       · 标题带不带 `[[ ]]` 都认（`[[标题|别名]]` 只留标题）
     新行接在 `> qstatus:` 后面（没有就接在块尾）：advice 在前、fix 在后。 */
  function setQuestionAdvice(md, line, opts) {
    const src = String(md == null ? "" : md);
    const b = blockAt(src, line);
    if (!b) return src;
    const o = opts || {};
    const keep = (key) => o[key] === undefined || o[key] === null;
    const advice = keep("advice") ? (b.advice || []).slice() : normLinkTitles(o.advice);
    const fix = keep("fix") ? (b.fix || []).slice() : normLinkTitles(o.fix);
    const lines = linesOf(src);
    /* 先整块剔掉旧的 advice / fix 行（连它们缩进过的续行），再按新值插回去 */
    const body = [];
    let inLink = false;
    let after = -1; /* qstatus 行在 body 里的下标 */
    for (const raw of lines.slice(b.start + 1, b.end)) {
      const bare = raw.replace(/^\s*>\s?/, "");
      const m = qMetaOf(bare);
      if (m) {
        inLink = Q_LINK_FIELDS.indexOf(m.key) >= 0;
        if (m.key === "qstatus") after = body.length;
        if (!inLink) body.push(raw);
        continue;
      }
      if (inLink && qLinkContinuation(bare)) continue;
      inLink = false;
      body.push(raw);
    }
    const news = [];
    for (const t of advice) news.push(qLinkLine("advice", t));
    for (const t of fix) news.push(qLinkLine("fix", t));
    if (news.length) body.splice(after >= 0 ? after + 1 : body.length, 0, ...news);
    lines.splice(b.start + 1, b.end - b.start - 1, ...body);
    return lines.join("\n");
  }

  /* kind: question 的笔记（自己没有 question 块可挂）：状态写 frontmatter 的 `qstatus:` 行 */
  function setNoteStatus(md, statusId) {
    const src = String(md == null ? "" : md);
    const lines = linesOf(src);
    const fm = fmRange(lines);
    const id = str(statusId).toLowerCase();
    let hit = -1;
    if (fm.close >= 0) {
      for (let i = fm.open + 1; i < fm.close; i++) {
        if (/^qstatus[ \t]*:/.test(lines[i])) {
          hit = i;
          break;
        }
      }
    }
    if (hit >= 0) {
      if (id) lines[hit] = "qstatus: " + id;
      else lines.splice(hit, 1);
    } else if (id) {
      if (fm.close >= 0) lines.splice(fm.close, 0, "qstatus: " + id);
      else lines.unshift("---", "qstatus: " + id, "---", "");
    }
    return lines.join("\n");
  }

  /* 删掉某一条问题：整块 `> [!question]` 连它那一行收尾空行一起移除（别的块一个字节不动） */
  function removeQuestion(md, line) {
    const src = String(md == null ? "" : md);
    const b = blockAt(src, line);
    if (!b) return src;
    const lines = linesOf(src);
    let start = b.start;
    let end = b.end;
    if (end < lines.length && !str(lines[end])) end++;
    else if (start > 0 && !str(lines[start - 1])) start--;
    lines.splice(start, end - start);
    return lines.join("\n");
  }

  /* 一批编辑 → 新 Markdown（宿主一次写盘、一次 logChange）。
     同一篇里按行号**从下往上**改：上面的块增删行不会把下面那些行号挪位；
     整篇级的项（kind: note）只碰 frontmatter / 标题，放在最后。 */
  function applyQuestionEdits(md, edits) {
    let out = String(md == null ? "" : md);
    const list = (Array.isArray(edits) ? edits : []).filter(Boolean);
    const blocks = list
      .filter((e) => e.kind !== "note")
      .sort((a, b) => (Number(b.line) || 0) - (Number(a.line) || 0));
    for (const e of blocks) {
      const line = Number(e.line) || 0;
      out =
        e.field === "remove"
          ? removeQuestion(out, line)
          : e.field === "status"
            ? setQuestionStatus(out, line, e.value)
            : setQuestionText(out, line, e.value);
    }
    for (const e of list.filter((x) => x.kind === "note")) {
      out = e.field === "status" ? setNoteStatus(out, e.value) : setTopicTitle(out, e.value);
    }
    return out;
  }

  /* 初始化 / 引申自动写出来的占位问题（旧版本的术语页里是 `> [!question] 待展开`）不进清单：
     问题清单是用户自己填「要解决的问题」的地方，机器占位不是用户的问题。
     只认这一个标题 —— 用户自己写的块不会叫「待展开」。 */
  function isPlaceholderQuestion(title) {
    return /^待展开$/.test(str(title).trim());
  }

  function questionItems(input) {
    const o = input || {};
    const notes = (Array.isArray(o.notes) ? o.notes : []).filter(Boolean);
    const out = [];
    for (const n of notes) {
      const p = normRel(n.path);
      if (!p) continue;
      const md = String(n.md || "");
      const parsed = n.parsed || {};
      const label = noteTitle(n);
      /* research-core 的行号锚点：kind=question 的块节点（`note:` 前缀那个是整篇） */
      const anchors = (parsed.nodes || []).filter(
        (nd) => str(nd && nd.kind) === "question" && !/^note:/.test(str(nd && nd.id)),
      );
      const blocks = questionBlocks(md);
      blocks.forEach((b, i) => {
        if (isPlaceholderQuestion(b.title)) return;
        const at = b.start + 1;
        const nd = anchors.find((x) => Number(x && x.line) === at) || anchors[i] || null;
        out.push({
          id: nd ? str(nd.id) : "question:" + p + "#" + (i + 1),
          kind: "callout",
          path: p,
          line: at,
          endLine: b.end,
          note: label,
          title: b.title,
          text: b.text,
          status: b.status,
          advice: b.advice.slice(),
          fix: b.fix.slice(),
        });
      });
      /* 整篇就是一条问题（kind: question 且自己没有 question 块）：内容 = 笔记标题；
         这种项没有块可挂链接，advice / fix 读 frontmatter（`advice: [[x]]` 或列表），读不到就是空 */
      if (str(parsed.note && parsed.note.kind) === "question" && !blocks.length) {
        const meta = parsed.meta || {};
        out.push({
          id: "note:" + p,
          kind: "note",
          path: p,
          line: 1,
          endLine: 1,
          note: label,
          title: label,
          text: label,
          status: str(meta.qstatus).toLowerCase(),
          advice: normLinkTitles(meta.advice),
          fix: normLinkTitles(meta.fix),
        });
      }
    }
    out.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path, "zh-Hans-CN")));
    return out;
  }

  /* ── 数据 → 视图模型（纯函数：node 里可 require 复核，不碰 DOM） ──
   * input: { notes, groups, indexPath, keyword, renderMd, meta, questionStatus }
   *   notes   RS.notes：[{path,title,md,meta,parsed}]（parsed 来自 research-core.parseNote）
   *   groups  research-versions.buildGroups 的结果（原文 → 衍生物）；缺省 = 不合并
   *   renderMd Markdown → HTML（宿主注入的 renderMarkdown；缺省退化成转义纯文本）
   *   meta    research.json（头卡的标题 / 核心问题读不到时退到这里；questionStatus = 状态字典）
   *   questionStatus 宿主算好的状态字典（缺省按 meta.questionStatus 现算，见 qStatusDict）
   * 返回：{ topic, questions, status, numbers, sources, total, shown, filtered, empty }
   *   topic = 课题头卡 { path, title, question, titleFrom, questionFrom, questions }
   *   questions = 问题清单 [{ id, kind, path, line, endLine, note, title, text, status, advice, fix }]
   *   status = 状态字典 [{ id, label, color, custom }]（chip 的标签与颜色都按它出）
   *   每张原文卡带 { md, html, headed }：正文从 `# 标题` 起、按 Markdown 渲染 */
  function buildModel(input) {
    const o = input || {};
    const notes = (Array.isArray(o.notes) ? o.notes : []).filter(Boolean);
    const groups = Array.isArray(o.groups) ? o.groups : null;
    const indexPath = normRel(o.indexPath);
    const keyword = str(o.keyword).toLowerCase();
    const renderMd = typeof o.renderMd === "function" ? o.renderMd : null;
    const meta = o.meta || null;

    const noteByPath = new Map();
    for (const n of notes) noteByPath.set(normRel(n.path), n);

    /* 头卡：只从索引那一篇（corePath）读，读不到再退 research.json */
    const topic = topicModel(noteByPath.get(indexPath), meta);

    /* 问题清单：全库的 `> [!question]` 块 + kind: question 的笔记（行号锚点来自 research-core） */
    const questions = questionItems({ notes: notes });
    /* 状态字典：默认四档 + research.json 的 questionStatus（渲染时据此出 chip 的标签与颜色） */
    /* 状态字典：宿主已经算好就直用（opts.questionStatus / deps.questionStatus），
       没给才从 research.json 的 meta.questionStatus 现算 —— 两边同一份 qStatusDict 口径 */
    const status =
      Array.isArray(o.questionStatus) && o.questionStatus.length ? o.questionStatus : qStatusDict(meta);

    /* 版本组：路径 → 组。判后缀 / 归组的规则只有 research-versions.js 一份，这里只查表。 */
    const groupList = [];
    const memberOf = new Map();
    for (const g of groups || []) {
      if (!g || !g.key) continue;
      groupList.push(g);
      for (const m of g.members || []) {
        if (m && m.path) memberOf.set(normRel(m.path), g);
      }
    }
    const groupOfPath = (p) => memberOf.get(normRel(p)) || null;
    /* 衍生物 = 组里不是原件的那几份（译稿 / 摘要 / 节选…）：不单独成卡，也不重复计数 */
    const isVariant = (p) => {
      const g = groupOfPath(p);
      const orig = g ? normRel(g.original) : "";
      return !!(orig && normRel(p) !== orig);
    };

    /* ── 原文卡：core/*.md 的原件（与左栏「原文」段同一口径），一篇一组一张卡 ── */
    const sources = [];
    const taken = new Set();
    if (groupList.length) {
      for (const g of groupList) {
        const orig = normRel(g.original);
        if (!orig || !/^core\//i.test(orig) || taken.has(orig)) continue;
        taken.add(orig);
        const rec = noteByPath.get(orig) || null;
        const exist = (g.members || []).filter((m) => m && m.path && noteByPath.has(normRel(m.path)));
        /* 原件被挪走 / 还没落盘时，退到组里第一份还在的稿子（卡还是要能点开） */
        const openPath = rec ? orig : exist.length ? normRel(exist[0].path) : orig;
        sources.push(
          Object.assign(
            {
              path: openPath,
              group: str(g.key),
              title: noteTitle(rec || { path: orig }) || str(g.title),
              /* 卡上只报个数：那些稿子在哪看、怎么切，是页面内平铺条的事 */
              variants: exist.filter((m) => normRel(m.path) !== orig).length,
              exists: !!rec,
            },
            sourceBody(rec, renderMd),
          ),
        );
      }
    } else {
      /* 没拿到版本组（模块未加载）：不合并，每篇 core/ 各占一张卡 */
      for (const n of notes) {
        const p = normRel(n.path);
        if (!p || !/^core\//i.test(p) || (indexPath && p === indexPath) || taken.has(p)) continue;
        taken.add(p);
        sources.push(
          Object.assign(
            { path: p, group: p, title: noteTitle(n), variants: 0, exists: true },
            sourceBody(n, renderMd),
          ),
        );
      }
    }
    sources.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));

    /* 概念名的归一键：真源是 research-core 的 nameKey（图与索引同一套口径），宿主没注进来时
       用这里同一份规则兜底（只抹大小写 / 全半角 / 空格 / 标点，不做中英互译）。 */
    const keyOf = (s) => {
      let v = str(s).replace(/^\[\[|\]\]$/g, "");
      try {
        if (v.normalize) v = v.normalize("NFKC");
      } catch (_) {}
      v = v
        .toLowerCase()
        .replace(/[\s\u3000]+/g, "")
        .replace(/[（）()\[\]【】{}《》<>「」『』“”‘’'"`~!！?？,，.。;；:：、·・|/\\_\-—–+*#]/g, "");
      return typeof o.nameKey === "function" ? str(o.nameKey(s)) || v : v;
    };

    /* ── 论断 / 概念 / 方法：notes/ 里 frontmatter 写了对应 kind 的那一类笔记 ──
       同一个概念写成两篇（terms/ 与 notes/ 各一份，或只是大小写 / 全半角括号不同）时
       **只出一张卡**：正本优先 terms/ > notes/，其余并进同一张（`alsoPaths` 记着它们，
       卡片标题的悬停提示里能看到「同题还有哪几篇」）。计数与卡片同一套归并，数字与列表对得上。 */
    const kindNoteCards = (want) => {
      const byKey = new Map();
      const rank = (p) => (/^terms\//i.test(p) ? 0 : /^notes\//i.test(p) ? 1 : 2);
      for (const n of notes) {
        const p = normRel(n.path);
        if (!p || (indexPath && p === indexPath)) continue;
        if (/^core\//i.test(p) || isVariant(p)) continue;
        const parsed = n.parsed || {};
        if (str(parsed.note && parsed.note.kind) !== want) continue;
        const card = Object.assign({ path: p, title: noteTitle(n), variants: 0, exists: true }, sourceBody(n, renderMd));
        const k = keyOf(card.title) || p;
        const cur = byKey.get(k);
        if (!cur) {
          byKey.set(k, card);
          continue;
        }
        const keep = rank(card.path) < rank(cur.path) ? card : cur;
        const drop = keep === card ? cur : card;
        keep.alsoPaths = (keep.alsoPaths || []).concat(drop.path, drop.alsoPaths || []);
        byKey.set(k, keep);
      }
      const out = [...byKey.values()];
      out.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
      return out;
    };

    /* ── 数字行：计数永远按全库算，不随筛选变；论断 / 概念 / 方法用同一份归并后的卡片数 ── */
    const counts = { claim: kindNoteCards("claim").length, concept: kindNoteCards("concept").length, method: kindNoteCards("method").length, question: 0 };
    let asks = 0; /* `> [!question]` 块：与「kind: question 的笔记」一起算待解问题 */
    for (const n of notes) {
      const p = normRel(n.path);
      if (!p || (indexPath && p === indexPath)) continue;
      const parsed = n.parsed || {};
      if (!/^core\//i.test(p) && !isVariant(p) && str(parsed.note && parsed.note.kind) === "question") counts.question++;
      for (const nd of parsed.nodes || []) {
        if (str(nd && nd.kind) !== "question" || !/^question:/.test(str(nd && nd.id))) continue;
        /* 机器写的「待展开」占位不算待解问题（与 questionItems 的过滤同一口径，数字与清单对得上） */
        if (isPlaceholderQuestion(nd && nd.label)) continue;
        asks++;
      }
    }
    const numbers = [{ key: "sources", label: "原文", value: sources.length }];
    for (const k of KIND_ORDER) {
      numbers.push({ key: k, label: KIND_LABEL[k], value: k === "question" ? counts.question + asks : counts[k] });
    }

    /* ── 标签页：原来的数字行就是切换器（原文 / 论断 / 概念 / 方法 / 问题），默认「原文」 ──
       原文 = core/*.md 原件（衍生物并进那一张卡，不单列）；
       论断 / 概念 / 方法 = 上面 kindNoteCards 归并后的卡（同题只留一张）；
       问题 = 全库 `> [!question]` 一条一张卡（计数与问题清单同一口径），点开跳到那一块。 */
    const questionCards = questions.map((it) => {
      /* 整篇就是一条问题（kind: note）：正文用那一篇的预览；块级项：这一条问题的正文就是那句 */
      const rec = it.kind === "note" ? noteByPath.get(it.path) || null : null;
      let body = null;
      if (rec) body = sourceBody(rec, renderMd);
      else {
        const md = previewMarkdown(it.text || it.title, PREVIEW_LINES);
        body = { md: md, html: previewHtml(md, renderMd), headed: false };
      }
      return Object.assign(
        { path: it.path, line: it.line, title: it.title, variants: 0, exists: true, status: it.status },
        body,
      );
    });

    /* ── 筛选：关键词只打原文的标题与路径 ── */
    const shown = sources.filter(
      (c) => !keyword || c.title.toLowerCase().indexOf(keyword) >= 0 || c.path.toLowerCase().indexOf(keyword) >= 0,
    );

    /* 按标签页组织成「这一页摆哪几张卡」（关键词对每页同样生效） */
    const matchCard = (c) =>
      !keyword ||
      str(c.title).toLowerCase().indexOf(keyword) >= 0 ||
      str(c.path).toLowerCase().indexOf(keyword) >= 0 ||
      str(c.md).toLowerCase().indexOf(keyword) >= 0;
    const tabCards = {
      sources: shown,
      claim: kindNoteCards("claim").filter(matchCard),
      concept: kindNoteCards("concept").filter(matchCard),
      method: kindNoteCards("method").filter(matchCard),
      question: questionCards.filter(matchCard),
    };
    /* 「问题」那一颗的数字以**这一页会摆出来的条数**为准：问题清单连索引那一篇里的块
       一起收（上面的纯计数不算索引那一篇），两套口径摆在同一颗按钮上会自相矛盾。 */
    const qNum = numbers.find((s) => s.key === "question");
    if (qNum) qNum.value = questionCards.length;

    return {
      topic: topic,
      questions: questions,
      /* 状态字典（默认四档 + 自定义）：清单每行的 chip 与批量下拉都按它出 */
      status: status,
      numbers: numbers,
      /* 标签页的卡：键 = 标签 key（sources / claim / concept / method / question） */
      tabCards: tabCards,
      sources: shown,
      total: sources.length,
      shown: shown.length,
      filtered: !!keyword,
      keyword: str(o.keyword),
      empty: notes.length === 0,
      noSources: sources.length === 0,
    };
  }

  function create(deps) {
    const D = deps || {};
    const el =
      typeof D.el === "function"
        ? D.el
        : (tag, cls, txt) => {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            if (txt != null) n.textContent = txt;
            return n;
          };
    const t = typeof D.t === "function" ? D.t : (x) => x;

    /* 筛选值是**视图状态**：放在实例里，输入框打字只重画原文卡（不整页重渲染，
       否则光标会掉）；同时通过 D.onFilter 回写给 app-research 的 RS，换笔记再回来还在。
       dictOpen / newColor / newName = 状态字典面板的展开状态与「新状态」草稿：整页重画后仍留在原地；
       focusNew = 面板刚展开时把光标放进「新状态名称」（入口在每行状态下拉的最下面一项）。
       qAdd = 清单头行「＋ 新增问题」那一行输入的展开状态与草稿（标题 / 正文），重画后不丢；
       freshQ = 刚落盘的新问题 { path, title, text }：只在**下一趟重画**里高亮并滚进视野，
                消费掉就清空（不长期留高亮）。 */
    const state = {
      keyword: "",
      /* 当前标签页（原文 / 论断 / 概念 / 方法 / 问题）：默认「原文」，重画后仍停在原来那一页 */
      tab: "sources",
      model: null,
      sel: new Set(),
      dictOpen: false,
      newColor: "",
      newName: "",
      focusNew: false,
      qAdd: { open: false, title: "", text: "" },
      freshQ: null,
    };

    function emitFilter() {
      if (typeof D.onFilter === "function") {
        try {
          D.onFilter({ keyword: state.keyword });
        } catch (_) {}
      }
    }

    /* deps 里的数据项既可以是**函数**（每次现取）也可以是**值**（宿主建的快照）：
       两种都认，取不到才退默认 —— app-research.js 的 rsIndexOpts() 给的是值，node 侧测试给函数。 */
    const depOf = (v, dflt) => (typeof v === "function" ? v() : v == null ? dflt : v);

    function dataOf(opts) {
      const o = opts || {};
      return {
        notes: o.notes || depOf(D.notes, []),
        groups: o.groups || depOf(D.groups, null),
        indexPath: o.indexPath || depOf(D.indexPath, ""),
        /* 渲染器只有宿主有（app-research.js 的 renderMarkdown）；module 侧不引第二份 */
        renderMd: o.renderMd || (typeof D.renderMd === "function" ? D.renderMd : null),
        /* research.json：头卡的标题 / 核心问题在笔记里读不到时才退到这里 */
        meta: o.meta || depOf(D.meta, null),
        /* 状态字典（默认四档 + research.json 的 questionStatus）：宿主给一份就直用，省得再算 */
        questionStatus: o.questionStatus || depOf(D.questionStatus, null),
        /* 概念查重的归一键：真源在 research-core 的 nameKey（图与索引同一套口径），宿主注入 */
        nameKey: o.nameKey || (typeof D.nameKey === "function" ? D.nameKey : null),
      };
    }

    /* ── 页头：左「索引 · 原文在前」，右「原文」/「卡片」切换 ── */
    function renderHead(host, opts) {
      if (!host) return null;
      const o = opts || {};
      const mode = o.mode === "raw" ? "raw" : "dash";
      host.classList.add("rs-idx");
      host.innerHTML = "";
      const head = el("div", "rs-idx-head");
      const title = el("div", "rs-idx-title");
      title.appendChild(el("span", "rs-idx-name", t("索引")));
      title.appendChild(el("span", "rs-idx-sub", t("原文 · 全库自动聚合")));
      head.appendChild(title);
      const tools = el("div", "rs-idx-tools");
      const sw = el("button", "rs-btn rs-idx-mode", mode === "raw" ? t("卡片") : t("原文"));
      sw.title = mode === "raw" ? t("回到原文索引") : t("看这一篇的 Markdown 原文");
      sw.onclick = () => {
        if (typeof o.onMode === "function") o.onMode(mode === "raw" ? "dash" : "raw");
      };
      tools.appendChild(sw);
      head.appendChild(tools);
      host.appendChild(head);
      return head;
    }

    /* ── 课题头卡：标题 + 核心问题 + 问题清单 ──
       三块合成**同一张卡**（用户口径：问题清单就在索引标题内部、和「核心问题」是一块）：
       标题 / 核心问题两处就地编辑（contenteditable）：Esc 撤销这次输入、回车 / 失焦保存，
       保存交给宿主 D.onTopicSave（writeText + logChange + rsLoadNotes + renderEditor）；
       问题清单由 paintQuestions 画进这张卡（不再单占一区，「写在 xxx.md」那行提示也已去掉）。
       模块是 UMD 纯函数、不碰盘，node 侧照样能 require。 */
    function editBox(tag, cls, value, placeholder, onSave) {
      const box = el(tag, cls);
      const base = str(value);
      const read = () =>
        String(box.innerText || "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+$/gm, "")
          .trim();
      box.textContent = base;
      box.contentEditable = "true";
      box.spellcheck = false;
      if (placeholder) {
        box.dataset.ph = placeholder;
        box.setAttribute("aria-label", placeholder); /* 空字段的占位是伪元素，读屏要靠这一条 */
      }
      let before = base;
      box.onfocus = () => {
        before = read();
        box.classList.add("is-editing");
      };
      box.onkeydown = (ev) => {
        /* 这两处是「一行字」：别让快捷键（Ctrl+Z / 方向键翻页…）漏到阅读区与画布热键上 */
        ev.stopPropagation();
        if (ev.key === "Escape") {
          ev.preventDefault();
          box.textContent = before; /* Esc = 这次输入作废，盘上什么都不写 */
          box.blur();
          return;
        }
        if (ev.key === "Enter") {
          ev.preventDefault();
          box.blur(); /* 回车 = 保存（失焦那一条路径） */
        }
      };
      box.onpaste = (ev) => {
        /* 只收纯文本：带格式粘进来会在这个字段里留一堆 span / 样式 */
        try {
          ev.preventDefault();
          const cb = ev.clipboardData || window.clipboardData;
          const txt = String((cb && cb.getData("text")) || "");
          document.execCommand("insertText", false, txt);
        } catch (_) {}
      };
      box.onblur = () => {
        box.classList.remove("is-editing");
        const v = read();
        if (v === before) return;
        if (!v) {
          box.textContent = before; /* 清空不算改：标题 / 核心问题不许被删掉 */
          return;
        }
        onSave(v);
      };
      return box;
    }

    function paintTopic(host, topic, items, statusDict) {
      if (!host) return null;
      const card = el("section", "rs-idx-topic");
      if (topic) {
        const save = (field, value) => {
          if (typeof D.onTopicSave !== "function") return;
          try {
            D.onTopicSave({ field: field, value: value, path: topic.path });
          } catch (_) {}
        };
        const ttl = editBox("div", "rs-idx-topic-t", topic.title, t("课题标题"), (v) => save("title", v));
        ttl.title = t("点一下改标题（回车保存，Esc 取消）：写回这一篇的 frontmatter title 与首个 # 行");
        card.appendChild(ttl);
        const qRow = el("div", "rs-idx-topic-qrow");
        qRow.appendChild(el("span", "rs-idx-topic-ql", t("核心问题")));
        const qBox = editBox(
          "div",
          "rs-idx-topic-q",
          topic.question,
          t("点一下写下这个课题要回答的核心问题"),
          (v) => save("question", v),
        );
        qBox.title = t("点一下改核心问题（回车保存，Esc 取消）：写回这一篇 `> [!question] 核心问题` 的正文");
        qRow.appendChild(qBox);
        card.appendChild(qRow);
      }
      /* 问题清单：并进这张头卡（和「核心问题」同一块），不再单独占一区 */
      paintQuestions(card, items, statusDict);
      host.appendChild(card);
      return card;
    }

    /* ── 问题清单：一行一条 ──
       每行 = 勾选框 + 内容（contenteditable，写回那一块的正文行）+ 建议入口（挂上才有）
             + 状态 chip + 打开原文 + 删除；
       顶部 = 全选 / 共 N 项 / 批量状态下拉（下拉最下面一项是「＋ 新状态」）/「＋ 新增问题」
             （点了在头行下面开一行输入：标题 + 正文两格，确认交宿主 D.onQuestionNew 落盘）。
       勾选只活在视图里（state.sel，重画后还在），改内容 / 改状态 / 删除都交给宿主
       D.onQuestionSave / D.onQuestionBulk / D.onQuestionDelete 落盘；把某一篇建议笔记打开走
       D.openNote；字典的改动交 D.saveStatuses（saveMetaPatch 写 research.json 的 questionStatus）。 */
    function paintQuestions(host, items, statusDict) {
      if (!host) return null;
      const list = (Array.isArray(items) ? items : []).filter(Boolean);
      /* 状态字典：默认四档 + research.json 里的 questionStatus（颜色只是数据，渲染时成 --rs-qs） */
      const dict = Array.isArray(statusDict) && statusDict.length ? statusDict : qStatusDict(null);
      /* 选中项跟着模型走：被删掉的块不该继续留在勾选里 */
      const ids = new Set(list.map((x) => x.id));
      for (const k of [...state.sel]) if (!ids.has(k)) state.sel.delete(k);

      /* 建议 / 方案在块里存的是 wikilink **标题**：点开时按标题在笔记模型里找回那一篇的路径 */
      const notesNow = depOf(D.notes, []);
      const pathByTitle = new Map();
      for (const n of Array.isArray(notesNow) ? notesNow : []) {
        const p = normRel(n && n.path);
        const nt = noteTitle(n);
        if (p && nt && !pathByTitle.has(nt)) pathByTitle.set(nt, p);
      }

      const sec = el("section", "rs-idx-qs");
      const head = el("div", "rs-idx-qs-h");
      head.appendChild(el("span", "rs-idx-qs-name", t("问题清单")));

      const allWrap = el("label", "rs-idx-qs-allw");
      const all = el("input", "rs-idx-qs-all");
      all.type = "checkbox";
      all.disabled = !list.length;
      all.title = t("全选（勾上的项才能批量改状态）");
      allWrap.appendChild(all);
      allWrap.appendChild(el("span", "rs-idx-qs-allt", t("全选")));
      head.appendChild(allWrap);

      const cnt = el("span", "rs-idx-qs-n");
      head.appendChild(cnt);

      /* 状态字典（默认四档 id 稳定 + 自定义名称 / 颜色）的入口**不摆在头行外面**：
         它是每行状态下拉最下面的那一项「＋ 新状态」（选了就展开字典面板，新建完直接应用到这一条）。
         字典本身存在 research.json 的 questionStatus。 */
      let newFor = null; /* 从哪一行点的「＋ 新状态」：新状态建好后应用到那一条 */
      const openDict = (item) => {
        newFor = item || null;
        state.dictOpen = true;
        state.focusNew = true;
        paintDict();
        try {
          dictBox.scrollIntoView({ block: "nearest" });
        } catch (_) {}
      };

      const bulk = el("select", "rs-idx-qs-bulk");
      bulk.title = t("把勾选的问题改成这个状态（写在各自 `> [!question]` 块里的 `> qstatus:` 行）");
      const ph = el("option", "", t("批量状态…"));
      ph.value = "";
      ph.disabled = true;
      ph.selected = true;
      bulk.appendChild(ph);
      for (const s of dict) {
        const op = el("option", "", t(s.label));
        op.value = s.id;
        bulk.appendChild(op);
      }
      /* 下拉最下面一项：新建状态（批量这边只负责建，不自动套到勾选项上） */
      const bulkNew = el("option", "", "＋ " + t("新状态"));
      bulkNew.value = "__new__";
      bulk.appendChild(bulkNew);
      bulk.disabled = !list.length;
      head.appendChild(bulk);

      /* 「＋ 新增问题」：清单里自己就能加一条（不必回到课题头卡）。点了在头行下面开一行输入，
         落盘交宿主 D.onQuestionNew({ path, title, text })；persistent —— 不点外部关闭，
         只走 ✕ / Esc / 再点一次这颗开关 */
      const addBtn = el("button", "rs-btn rs-idx-qs-add", "＋ " + t("新增问题"));
      addBtn.type = "button";
      addBtn.title = t("在索引那一篇里新增一条 `> [!question]` 块：标题 + 正文");
      addBtn.onclick = (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        state.qAdd.open = !state.qAdd.open;
        paintAdd();
        if (state.qAdd.open) focusAddTitle();
      };
      head.appendChild(addBtn);
      sec.appendChild(head);

      /* 新增问题的就地输入：标题 + 正文两格（回车提交、Esc 收起；写过的字在重画后仍在） */
      const addBox = el("div", "rs-idx-qs-addbox");
      sec.appendChild(addBox);
      const addInputs = { title: null, text: null };

      function focusAddTitle() {
        if (!addInputs.title) return;
        try {
          addInputs.title.focus();
        } catch (_) {}
      }

      function closeAdd() {
        state.qAdd.open = false;
        paintAdd();
      }

      function commitAdd() {
        const title = str(state.qAdd.title);
        const text = str(state.qAdd.text);
        if (!title) {
          focusAddTitle();
          if (typeof D.toast === "function") D.toast(t("先写一下这条问题的标题"), "warn");
          return;
        }
        /* 新问题落在索引那一篇（全库问题清单的落点，与课题头卡的「＋ 新增问题」同一篇） */
        const rel = normRel(depOf(D.indexPath, ""));
        if (!rel) {
          if (typeof D.toast === "function") D.toast(t("还没有索引笔记：先建一篇再新增问题"), "warn");
          return;
        }
        if (typeof D.onQuestionNew !== "function") return;
        /* 落盘之后宿主会重画清单：记下这一条，重画那一趟高亮并滚进视野 */
        state.freshQ = { path: rel, title: title, text: text };
        state.qAdd = { open: false, title: "", text: "" };
        paintAdd();
        try {
          D.onQuestionNew({ path: rel, title: title, text: text });
        } catch (_) {
          state.freshQ = null;
        }
      }

      function paintAdd() {
        addBox.innerHTML = "";
        addInputs.title = null;
        addInputs.text = null;
        const open = !!state.qAdd.open;
        addBox.classList.toggle("is-open", open);
        addBtn.classList.toggle("is-on", open);
        if (!open) return;
        const field = (key, ph) => {
          const inp = el("input", "rs-idx-qs-addf");
          inp.type = "text";
          inp.spellcheck = false;
          inp.value = state.qAdd[key] || "";
          inp.placeholder = ph;
          inp.setAttribute("aria-label", ph);
          inp.oninput = () => {
            state.qAdd[key] = inp.value;
          };
          inp.onkeydown = (ev) => {
            /* 这两格是输入框：别让快捷键漏到阅读区与画布热键上 */
            ev.stopPropagation();
            if (ev.key === "Enter") {
              ev.preventDefault();
              commitAdd();
            } else if (ev.key === "Escape") {
              ev.preventDefault();
              closeAdd();
            }
          };
          addInputs[key] = inp;
          return inp;
        };
        addBox.appendChild(field("title", t("标题（必填）")));
        addBox.appendChild(field("text", t("正文（可不填）")));
        const ok = el("button", "rs-btn rs-idx-qs-addok", t("添加"));
        ok.type = "button";
        ok.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          commitAdd();
        };
        addBox.appendChild(ok);
        const x = el("button", "rs-btn rs-idx-qs-addx", "✕");
        x.type = "button";
        x.title = t("收起（写过的字保留）");
        x.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          closeAdd();
        };
        addBox.appendChild(x);
      }
      paintAdd();

      /* 面板挂在头行下面：persistent —— 不点外部关闭，只走面板自己的 ✕ */
      const dictBox = el("div", "rs-idx-qd-host");
      sec.appendChild(dictBox);

      /* ── 状态字典面板 ──
         改动整份交回宿主：saveStatuses（saveMetaPatch 写 research.json 的 questionStatus，
         顺带把引用已删状态的笔记回落成 默认）；onStatusSave 是同一个入口的旧名，留着兼容。 */
      const saveDict = (next, after) => {
        const fn = typeof D.saveStatuses === "function" ? D.saveStatuses : D.onStatusSave;
        if (typeof fn !== "function") return;
        let r;
        try {
          r = fn(qStatusPatch(next));
        } catch (_) {
          return;
        }
        if (typeof after !== "function") return;
        if (r && typeof r.then === "function") r.then(after, () => {});
        else after();
      };
      /* 色板：一行主题 token 的小圆点（当前色打勾环），颜色只作为 --rs-qs 内联 */
      const swatches = (cur, onPick) => {
        const wrap = el("div", "rs-idx-qd-sw");
        const now = qColor(cur, "");
        for (const p of Q_PALETTE) {
          const b = el("button", "rs-idx-qd-dot");
          b.type = "button";
          b.style.setProperty("--rs-qs", p.color);
          b.title = t(p.label) + " · " + p.color;
          b.setAttribute("aria-label", t(p.label) + " · " + p.color);
          if (now === p.color) b.classList.add("is-on");
          b.onclick = (ev) => {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            onPick(p.color);
          };
          wrap.appendChild(b);
        }
        return wrap;
      };
      /* 自定义颜色：hex 输入（#rgb / #rrggbb），回车 / 失焦落定，写错退回原色 */
      const hexIn = (cur, onPick) => {
        const inp = el("input", "rs-idx-qd-hex");
        inp.type = "text";
        inp.spellcheck = false;
        inp.placeholder = "#rrggbb";
        const base = /^#/.test(str(cur)) ? str(cur) : "";
        inp.value = base;
        inp.title = t("自定义颜色：填 #rgb 或 #rrggbb（回车保存）");
        inp.setAttribute("aria-label", t("自定义颜色"));
        const commit = () => {
          const v = str(inp.value).toLowerCase();
          if (!v || v === base) {
            inp.value = base;
            return;
          }
          if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) {
            inp.value = base;
            if (typeof D.toast === "function") D.toast(t("颜色要写成 #rgb 或 #rrggbb"), "warn");
            return;
          }
          onPick(v);
        };
        inp.onkeydown = (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") {
            ev.preventDefault();
            commit();
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            inp.value = base;
            inp.blur();
          }
        };
        inp.onblur = commit;
        return inp;
      };

      function paintDict() {
        dictBox.innerHTML = "";
        if (!state.dictOpen) return;
        const panel = el("div", "rs-idx-qd");
        const ph2 = el("div", "rs-idx-qd-h");
        ph2.appendChild(el("span", "rs-idx-qd-name", t("状态字典")));
        const x = el("button", "rs-btn rs-idx-qd-x", "✕");
        x.type = "button";
        x.title = t("收起状态面板");
        x.setAttribute("aria-label", t("收起状态面板"));
        x.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          state.dictOpen = false;
          paintDict();
        };
        ph2.appendChild(x);
        panel.appendChild(ph2);

        const rows = el("div", "rs-idx-qd-list");
        for (const s of dict) {
          const row = el("div", "rs-idx-qd-row");
          if (s.custom) row.classList.add("is-custom");
          row.style.setProperty("--rs-qs", s.color);

          const lab = el("input", "rs-idx-qd-label");
          lab.type = "text";
          lab.spellcheck = false;
          lab.value = s.label;
          lab.title = t("改标签（回车 / 失焦保存）：id 不变，笔记里那一行照旧认得它");
          lab.setAttribute("aria-label", t("状态名称"));
          const applyLabel = () => {
            const v = str(lab.value);
            if (!v || v === s.label) {
              lab.value = s.label;
              return;
            }
            saveDict(dict.map((it) => (it.id === s.id ? Object.assign({}, it, { label: v }) : it)));
          };
          lab.onkeydown = (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") {
              ev.preventDefault();
              lab.blur();
            } else if (ev.key === "Escape") {
              ev.preventDefault();
              lab.value = s.label;
              lab.blur();
            }
          };
          lab.onblur = applyLabel;
          row.appendChild(lab);
          /* id 摆出来：改标签不动 id（笔记里那一行认的是 id），一眼能看出它没变 */
          const idTag = el("span", "rs-idx-qd-id", s.id);
          idTag.title = t("笔记里写的就是这个 id：改标签不换它，所以引用不会悬空");
          row.appendChild(idTag);

          const setColor = (c) => saveDict(dict.map((it) => (it.id === s.id ? Object.assign({}, it, { color: c }) : it)));
          row.appendChild(swatches(s.color, setColor));
          row.appendChild(hexIn(s.color, setColor));

          const del = el("button", "rs-btn rs-idx-qd-del", t("删除"));
          del.type = "button";
          if (!s.custom) {
            /* 默认四档是「回落到 默认」的落点，删不掉（标签 / 颜色照样能改） */
            del.disabled = true;
            del.title = t("默认档删不掉：删掉的状态要有个地方回落");
          } else {
            del.title = t("删掉这个状态：引用它的问题回落到 默认（只改那一行 qstatus）");
            let armed = false;
            del.onclick = (ev) => {
              if (ev && ev.stopPropagation) ev.stopPropagation();
              if (!armed) {
                armed = true;
                del.textContent = t("确认删除");
                del.classList.add("is-danger");
                return;
              }
              saveDict(dict.filter((it) => it.id !== s.id));
            };
          }
          row.appendChild(del);
          rows.appendChild(row);
        }
        panel.appendChild(rows);

        /* 新增：名称 + 颜色（色板 / 自定义 hex），id 由名称派生（ascii）或 st1 / st2… */
        const add = el("div", "rs-idx-qd-new");
        const nl = el("input", "rs-idx-qd-nlabel");
        nl.type = "text";
        nl.spellcheck = false;
        nl.placeholder = t("新状态名称");
        nl.value = str(state.newName);
        nl.title = t("新状态的名称");
        nl.setAttribute("aria-label", t("新状态名称"));
        nl.oninput = () => {
          state.newName = nl.value;
        };
        nl.onkeydown = (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") {
            ev.preventDefault();
            nl.blur();
          }
        };
        add.appendChild(nl);

        const draft = qColor(state.newColor, "var(--cyan)");
        const pick = (c) => {
          state.newColor = c;
          paintDict();
        };
        add.appendChild(swatches(draft, pick));
        add.appendChild(hexIn(draft, pick));

        const go = el("button", "rs-btn primary rs-idx-qd-add", "＋ " + t("添加"));
        go.type = "button";
        go.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          const v = str(nl.value);
          if (!v) {
            if (typeof D.toast === "function") D.toast(t("先给新状态起个名字"), "warn");
            nl.focus();
            return;
          }
          const id = qStatusNewId(dict, v);
          const applyTo = newFor; /* 从哪一行下拉点的「＋ 新状态」：建好后顺手把那一行改成这个状态 */
          newFor = null;
          state.newName = "";
          state.newColor = "";
          saveDict(dict.concat([{ id: id, label: v, color: draft, custom: true }]), () => {
            if (!applyTo || typeof D.onQuestionSave !== "function") return;
            try {
              D.onQuestionSave({
                id: applyTo.id,
                kind: applyTo.kind,
                path: applyTo.path,
                line: applyTo.line,
                field: "status",
                value: id,
              });
            } catch (_) {}
          });
        };
        add.appendChild(go);
        panel.appendChild(add);

        panel.appendChild(
          el(
            "div",
            "rs-idx-qd-tip",
            t("默认四档删不掉；删掉的自定义状态，引用它的问题回落到 默认（笔记里只改那一行 qstatus）"),
          ),
        );
        dictBox.appendChild(panel);
        /* 从下拉里点的「＋ 新状态」：面板一出来就把光标放进名称框，少点一下 */
        if (state.focusNew) {
          state.focusNew = false;
          nl.focus();
          nl.select();
        }
      }

      const picked = () => list.filter((x) => state.sel.has(x.id));
      const syncHead = () => {
        const n = picked().length;
        all.checked = !!list.length && n === list.length;
        all.indeterminate = n > 0 && n < list.length;
        cnt.textContent = n
          ? t("已选 ") + n + t(" / 共 ") + list.length + t(" 项")
          : t("共 ") + list.length + t(" 项");
      };

      const saveItem = (it, field, value) => {
        if (typeof D.onQuestionSave !== "function") return;
        try {
          D.onQuestionSave({
            id: it.id,
            kind: it.kind,
            path: it.path,
            line: it.line,
            field: field,
            value: str(value),
          });
        } catch (_) {}
      };

      if (!list.length) {
        sec.appendChild(
          el(
            "div",
            "rs-idx-empty",
            t("用上面的 ＋ 新增问题，或在原文里写 `> [!question]`"),
          ),
        );
        host.appendChild(sec);
        syncHead();
        paintDict();
        return sec;
      }

      const body = el("div", "rs-idx-qs-list");
      const rows = [];
      for (const it of list) {
        const row = el("div", "rs-idx-qs-row");
        rows.push({ row: row, it: it });
        if (it.kind === "note") row.classList.add("is-note");
        row.dataset.path = it.path;
        row.dataset.line = String(it.line);

        const ck = el("input", "rs-idx-qs-ck");
        ck.type = "checkbox";
        ck.checked = state.sel.has(it.id);
        ck.setAttribute("aria-label", t("选中这一条问题"));
        ck.title = it.path;
        row.classList.toggle("is-picked", ck.checked);
        ck.onchange = () => {
          if (ck.checked) state.sel.add(it.id);
          else state.sel.delete(it.id);
          row.classList.toggle("is-picked", ck.checked);
          syncHead();
        };
        row.appendChild(ck);

        const main = el("div", "rs-idx-qs-main");
        /* 内容：点一下就地改（Esc 作废 / 回车·失焦保存），只收纯文本 */
        const box = editBox("div", "rs-idx-qs-t", it.text, t("这问题还没写清楚：点一下补上"), (v) =>
          saveItem(it, "text", v),
        );
        box.title =
          it.kind === "note"
            ? t("点一下改这篇问题笔记的标题（回车保存，Esc 取消）：写回 frontmatter title 与首个 # 行")
            : t("点一下改这条问题的正文（回车保存，Esc 取消）：写回 `> [!question]` 块里的正文行");
        main.appendChild(box);
        /* 建议 / 方案入口（就在这一条问题的正文下面）：
           挂上了 = 建议笔记的标题（点一下 D.openNote 打开那一篇，多篇时后面带 +N）。
           没挂上就**什么都不摆**：以前的「＋ 建议」占位已撤掉（用户口径：问题行只留问题本身），
           没挂建议的问题不显示第二颗按钮。
           标题来自块里的 `> advice:` / `> fix:` 行（questionItems 出的字符串数组），
           这里只按标题反查路径，不认别的口径。 */
        const titles = [];
        for (const x of [].concat(
          Array.isArray(it.advice) ? it.advice : [],
          Array.isArray(it.fix) ? it.fix : [],
        )) {
          const s = str(x);
          if (s && titles.indexOf(s) < 0) titles.push(s);
        }
        const adv = el("button", "rs-btn rs-idx-qs-adv", "");
        adv.type = "button";
        if (titles.length) {
          adv.classList.add("is-on");
          adv.textContent = titles[0] + (titles.length > 1 ? " +" + (titles.length - 1) : "");
          adv.title = t("建议 / 方案：") + titles.join(" · ") + "\n" + t("点一下打开这一篇");
          adv.onclick = (ev) => {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            const p = pathByTitle.get(titles[0]) || "";
            if (p && typeof D.openNote === "function") D.openNote(p, {});
            else if (typeof D.toast === "function")
              D.toast(t("这条建议指向的笔记还没进本库：") + titles[0], "warn");
          };
          main.appendChild(adv);
        }
        /* 这一条在哪一篇**不摆成副标题**（用户口径：清单只要问题本身）：
           路径仍在勾选框与「打开原文」的悬停提示里，需要时照样看得到 */
        row.appendChild(main);

        /* 状态 chip：原生下拉，跟主题一致；选中即写回那一行 `> qstatus:`
           颜色来自状态字典（内联成 --rs-qs）；笔记里是字典里没有的旧 id 时，显示退回到 默认 */
        const st = el("select", "rs-idx-qs-st");
        st.setAttribute("aria-label", t("状态"));
        st.title = t("改这一条问题的状态（写回它自己那一块的 `> qstatus:` 行）");
        const none = el("option", "", t("未标"));
        none.value = "";
        st.appendChild(none);
        for (const s of dict) {
          const op = el("option", "", t(s.label));
          op.value = s.id;
          st.appendChild(op);
        }
        /* 下拉最下面一项：新建状态（字典面板在这里展开，建好直接套到这一条上） */
        const stNew = el("option", "", "＋ " + t("新状态"));
        stNew.value = "__new__";
        st.appendChild(stNew);
        const known = !!str(it.status) && dict.some((s) => s.id === str(it.status));
        st.value = known ? str(it.status) : "";
        const tone = known ? qStatusOf(dict, it.status) : null;
        st.style.setProperty("--rs-qs", tone ? tone.color : "var(--bd2)");
        st.dataset.st = st.value || "none";
        if (str(it.status) && !known) st.title = t("这条问题写的状态已不在字典里，改一下就会回落到 默认");
        st.onchange = () => {
          if (st.value === "__new__") {
            /* 拿它当按钮用，不写回：先把值还原，再展开字典面板 */
            st.value = known ? str(it.status) : "";
            openDict(it);
            return;
          }
          st.dataset.st = st.value || "none";
          const cur = st.value ? qStatusOf(dict, st.value) : null;
          st.style.setProperty("--rs-qs", cur ? cur.color : "var(--bd2)");
          saveItem(it, "status", st.value);
        };
        row.appendChild(st);

        const open = el("button", "rs-btn rs-idx-qs-open", t("打开原文"));
        open.title = it.path;
        open.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          if (typeof D.openNote === "function") D.openNote(it.path, { line: it.line });
        };
        row.appendChild(open);

        /* 删除：再点一次确认（不弹窗，跟状态字典里的删除同一个手感） */
        const del = el("button", "rs-btn rs-idx-qs-del", t("删除"));
        del.type = "button";
        del.title =
          it.kind === "note"
            ? t("删掉这条问题：整篇笔记移到回收站")
            : t("删掉这条问题：从那一篇里移除这一块 `> [!question]`");
        let armed = false;
        del.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          if (!armed) {
            armed = true;
            del.textContent = t("确认删除");
            del.classList.add("is-danger");
            return;
          }
          if (typeof D.onQuestionDelete !== "function") return;
          try {
            D.onQuestionDelete({ id: it.id, kind: it.kind, path: it.path, line: it.line });
          } catch (_) {}
        };
        row.appendChild(del);

        body.appendChild(row);
      }
      /* 刚落盘的新问题：高亮一下并滚进视野（只在重画这一趟做，随后清空，不长期留标记） */
      if (state.freshQ) {
        const fq = state.freshQ;
        const hit = rows.find(
          (x) =>
            x.it.path === fq.path && str(x.it.title) === fq.title && str(x.it.text) === fq.text,
        );
        state.freshQ = null;
        if (hit) {
          hit.row.classList.add("is-fresh");
          try {
            hit.row.scrollIntoView({ block: "nearest" });
          } catch (_) {}
        }
      }

      sec.appendChild(body);
      host.appendChild(sec);

      all.onchange = () => {
        for (const it of list) {
          if (all.checked) state.sel.add(it.id);
          else state.sel.delete(it.id);
        }
        /* 逐行回填（顺手把每一行的勾选框与高亮一起对上） */
        [...body.querySelectorAll(".rs-idx-qs-row")].forEach((row, i) => {
          const it = list[i];
          if (!it) return;
          const on = state.sel.has(it.id);
          row.classList.toggle("is-picked", on);
          const ck = row.querySelector(".rs-idx-qs-ck");
          if (ck) ck.checked = on;
        });
        syncHead();
      };

      bulk.onchange = () => {
        const want = str(bulk.value);
        bulk.value = "";
        if (!want) return;
        if (want === "__new__") {
          openDict(null); /* 只建状态，不自动套到勾选项上 */
          return;
        }
        const sel = picked();
        /* 没勾就不动盘：批量改状态是写文件，先让用户圈定范围 */
        if (!sel.length) {
          if (typeof D.toast === "function") D.toast(t("先勾选要改状态的问题"), "warn");
          return;
        }
        if (typeof D.onQuestionBulk !== "function") return;
        try {
          D.onQuestionBulk({
            status: want,
            items: sel.map((x) => ({ id: x.id, kind: x.kind, path: x.path, line: x.line })),
          });
        } catch (_) {}
      };

      syncHead();
      paintDict();
      return sec;
    }

    /* ── 正文：标签页（原来的数字行）+ 卡片区（至少五行，单张占满） ── */
    function renderBody(host, opts) {
      if (!host) return null;
      const o = opts || {};
      state.keyword = str(o.keyword);
      const data = dataOf(o);

      const makeModel = () =>
        buildModel({
          notes: data.notes,
          groups: data.groups,
          indexPath: data.indexPath,
          renderMd: data.renderMd,
          meta: data.meta,
          questionStatus: data.questionStatus,
          nameKey: data.nameKey,
          keyword: state.keyword,
        });

      let model = makeModel();
      state.model = model;

      /* 课题头卡（标题 + 核心问题 + 问题清单）：清单已经并进这张卡，不再单独占一区 */
      const topicCard = paintTopic(host, model.topic, model.questions, model.status);
      if (!topicCard) {
        /* 没有索引那一篇（空库 / 还没建）：问题清单照样要能看到 */
        const only = el("section", "rs-idx-topic");
        paintQuestions(only, model.questions, model.status);
        host.appendChild(only);
      }

      /* 标签页：原来那排数字，现在每颗都能点（默认「原文」）。点一下只是换下方卡片区，
         不改笔记、不写盘 —— 与页头「原文 / 卡片」那颗只切阅读形态的开关互不相干。 */
      const tabs = el("div", "rs-idx-nums");
      host.appendChild(tabs);

      /* 卡片区：标题与计数跟着标签页走（不再固定叫「原文」） */
      const sec = el("section", "rs-idx-orig");
      const h = el("h3", "rs-idx-orig-h");
      const hName = el("span", "rs-idx-orig-name", "");
      const hN = el("span", "rs-idx-orig-n", "");
      h.appendChild(hName);
      h.appendChild(hN);
      sec.appendChild(h);
      const grid = el("div", "rs-idx-src-grid");
      sec.appendChild(grid);
      host.appendChild(sec);

      /* 每一页没事可摆时说一句「怎么才会有」（不写占位内容） */
      const TAB_EMPTY = {
        sources: "core/ 里还没有原文：在左栏「核心」页拖入文件投料，索引会把转出来的正文摆在这里",
        claim: "还没有论断：原文里写成一条论断，它会自动聚到这一页",
        concept: "还没有概念：原文里写成一条概念，它会自动聚到这一页",
        method: "还没有方法：原文里写成一条方法，它会自动聚到这一页",
        question: "还没有问题：在原文里写 `> [!question]` 块，或用上面的「＋ 新增问题」",
      };
      const tabOf = (key) =>
        model.numbers.find((s) => s.key === key) || model.numbers[0] || { key: "sources", label: "原文" };
      /* 当前页：state.tab 认不出（模型里没这一类）就退回「原文」 */
      const curKey = () =>
        state.tab && model.tabCards && state.tab in model.tabCards ? state.tab : "sources";

      /* ── 行式四页（论断 / 概念 / 方法 / 问题）用的几个小工具 ──────────────────
         卡的形状不在这一层决定：renderer/research-reader.js 的 noteCardList 是唯一真源
         （标题 + 一行摘要 + 点开展开 + 行尾「打开」），索引页只把「这一篇」包成一条 hit 递过去。 */
      const noteMap = new Map();
      for (const n of data.notes || []) noteMap.set(normRel(n && n.path), n);
      /* 问题那一页的卡多数是「某一篇里的某一块」：全文只在 questionItems 里（卡上只存五行预览），
         按 路径 + 行号 找回来，展开的才是那一块本身（不是整篇） */
      const qMap = new Map();
      for (const q of model.questions || []) {
        qMap.set(normRel(q && q.path) + ":" + (Number(q && q.line) || 0), q);
      }
      const FULL_ROWS = 999; /* 展开用的上限：只借 previewMarkdown 剥 frontmatter / 收围栏，等于不截断 */
      const blockOf = (c) => {
        const q = qMap.get(normRel(c.path) + ":" + (Number(c.line) || 0));
        return q && q.kind !== "note" ? q : null;
      };
      /* 这一篇（或这一块）的正文全文：卡展开时放的就是这一段，不是卡上那五行预览 */
      const bodyText = (c) => {
        const block = blockOf(c);
        if (block) return str(block.text);
        const n = noteMap.get(normRel(c.path));
        const md = n && n.md ? String(n.md) : "";
        if (!md) return str(c.md);
        /* 整篇：剥 frontmatter，再去掉标题行与引用 / callout 的 `>` 前缀 —— 卡上已经有标题，
           展开的正文里不该露 `# 标题` / `> [!claim]` 这些源码（行内 Markdown 照旧交给阅读器排） */
        return previewMarkdown(md, FULL_ROWS)
          .replace(/^[ \t]{0,3}#{1,6}[ \t]+.*$/gm, "")
          .replace(/^[ \t]{0,3}>[ \t]?(\[![^\]]+\][ \t]*)?/gm, "")
          .replace(/\n{2,}/g, "\n")
          .trim();
      };
      /* 卡上那一条的标题 = 方向（frontmatter 的 `方向:`，research-core 读成 note.angle），
         没写方向就退回这一页的种类名 —— 与阅读区浮空卡同一口径 */
      const dirOf = (c, key) => {
        const n = noteMap.get(normRel(c.path));
        const note = (n && n.parsed && n.parsed.note) || {};
        return str(note.angle) || t(tabOf(key).label);
      };
      /* 一行摘要：取法在阅读器那份 summary 里（正文第一句 + 剥掉行内标记），不在这里写第二份 */
      const summaryText = (text) => {
        const NC = D.noteCards;
        if (NC && typeof NC.summary === "function") return str(NC.summary(text));
        return str(text).replace(/\s+/g, " ");
      };
      /* 一条的去处：问题行带行号，直接跳到那一块（与「打开原文」同一条路径） */
      const openEntry = (c) => {
        if (typeof D.openNote !== "function") return;
        if (c.line) D.openNote(c.path, { line: c.line });
        else D.openNote(c.path);
      };

      /* ── 论断 / 概念 / 方法 / 问题：纵向一列、一行一条（标题 + 一行摘要）──
         以前这四页跟「原文」一样摆双列大卡（正文预览 + 路径 · 衍生 N 版 · 同题 N 篇 · 点击进入），
         一屏放不下几条。现在行内只留标题与一行摘要，那些元信息全并进行的悬停提示
         （同题其它篇的路径仍在提示里）；点行 = 在它下方弹**同一份**浮空卡（卡里就这一篇一条），
         进笔记只走展开后行尾那颗「打开」—— 点行本身不再跳转。 */
      const paintRows = (cards, key) => {
        for (const c of cards) {
          const row = el("div", "rs-idx-row");
          row.dataset.path = c.path;
          if (c.line) row.dataset.line = String(c.line);
          /* 同题归并（同一个概念写过两篇）：其余那几篇不单独成行，路径挂在悬停提示里 */
          const also = (c.alsoPaths || []).filter((p) => p && p !== c.path);
          row.title =
            c.path +
            (c.variants ? "\n" + t("衍生 ") + c.variants + t(" 版") : "") +
            (also.length ? "\n" + t("同题 ") + also.length + t(" 篇：") + "\n" + also.join("\n") : "");
          row.setAttribute("role", "button");
          row.tabIndex = 0;
          row.appendChild(el("span", "rs-idx-row-t", c.title));
          const body = bodyText(c);
          row.appendChild(el("span", "rs-idx-row-sum", summaryText(body)));
          const toggle = () => {
            const NC = D.noteCards;
            if (NC && typeof NC.show === "function") {
              /* hits 只有一条：卡里就这一篇；锚点 = 这一行，出界翻上方 / 点外面关 / 同一条再点一次收
                 全在阅读器那一套里（索引页不另写定位与关闭） */
              NC.show(row, {
                hits: [{ path: c.path, line: Number(c.line) || 0, dir: dirOf(c, key), text: body }],
                kind: "term",
                kindLabel: t(tabOf(key).label),
                title: c.title,
                keys: [c.title],
              });
              return;
            }
            /* 阅读器缺席（老页面 / 模块没加载）：退回「点行 = 打开笔记」，不让界面变死 */
            openEntry(c);
          };
          row.onclick = toggle;
          row.onkeydown = (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              toggle();
            }
          };
          grid.appendChild(row);
        }
      };

      const buttons = [];
      const paintTabs = () => {
        const key = curKey();
        for (const b of buttons) {
          const on = b.dataset.key === key;
          b.classList.toggle("is-on", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
      };

      for (const s of model.numbers) {
        const b = el("button", "rs-idx-num");
        b.type = "button";
        b.dataset.key = s.key;
        b.title = t("点一下只看") + t(s.label);
        b.appendChild(el("b", "rs-idx-num-v", String(s.value)));
        b.appendChild(el("i", "rs-idx-num-l", t(s.label)));
        b.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          if (curKey() === s.key) return;
          state.tab = s.key;
          paintTabs();
          paintCards();
        };
        buttons.push(b);
        tabs.appendChild(b);
      }

      const paintCards = () => {
        const key = curKey();
        /* 换标签页 / 改筛选都是重画：浮空卡先收起，展开态不记忆（阅读器那一份 hideCards） */
        if (D.noteCards && typeof D.noteCards.hide === "function") D.noteCards.hide();
        const cards = (model.tabCards && model.tabCards[key]) || [];
        /* 原文页保持双列大卡；论断 / 概念 / 方法 / 问题走行式（一列一行一条） */
        const rows = key !== "sources";
        hName.textContent = t(tabOf(key).label);
        hN.textContent = String(cards.length);
        grid.innerHTML = "";
        grid.classList.toggle("is-rows", rows);
        /* 只有一张卡时占满余量（原文一篇走这条；行式那四页是一列，不铺开） */
        sec.classList.toggle("is-solo", !rows && cards.length === 1);

        if (!data.notes.length) {
          /* 空库：给一条能走下去的路（投料台 / 新建笔记），不留一张空白面板 */
          const guide = el("div", "rs-idx-guide");
          guide.appendChild(el("div", "rs-idx-guide-t", t("这棵库还没有笔记")));
          guide.appendChild(
            el(
              "div",
              "rs-idx-guide-d",
              t("在左栏「核心」页拖入文件投料，或者先新建一篇笔记：索引会把它们自动收进来。"),
            ),
          );
          if (typeof D.onNew === "function") {
            const nb = el("button", "rs-btn primary rs-idx-new", "＋ " + t("新建笔记"));
            nb.onclick = () => D.onNew();
            guide.appendChild(nb);
          }
          grid.appendChild(guide);
          return;
        }
        if (!cards.length) {
          grid.appendChild(el("div", "rs-idx-empty", t(TAB_EMPTY[key] || TAB_EMPTY.sources)));
          return;
        }
        /* 论断 / 概念 / 方法 / 问题：一列一行一条，点行弹同款浮空卡（见 paintRows） */
        if (rows) {
          paintRows(cards, key);
          return;
        }
        for (const c of cards) {
          /* 卡片是 div 不是 button：正文要放 h1 / 列表 / 表格（button 里只能是行内内容），
             所以用 role=button + tabindex + Enter/Space 手动补上键盘可用性 */
          const card = el("div", "rs-idx-src");
          card.dataset.path = c.path;
          if (c.line) card.dataset.line = String(c.line);
          /* 同题归并（同一个概念写过两篇）：其余那几篇不单独成卡，路径挂在悬停提示里，
             点它们照旧能开（关系不丢，也不再多一张同名卡） */
          const also = (c.alsoPaths || []).filter((p) => p && p !== c.path);
          card.title = c.path + (also.length ? "\n" + t("同题还有：") + "\n" + also.join("\n") : "");
          card.setAttribute("role", "button");
          card.tabIndex = 0;
          /* 原文卡整张是一个入口：点开那一篇（进笔记只走这一处，与行式那四页不同） */
          const open = () => openEntry(c);
          /* 正文自己带标题（# / ##）：那张 h1 就是卡上的标题，不再重复摆一行 */
          if (!c.headed) card.appendChild(el("span", "rs-idx-src-t", c.title));
          const bodyBox = el("div", "rs-idx-src-body");
          if (c.html) {
            bodyBox.innerHTML = c.html;
            /* 卡整体是一个入口：正文里的链接既不给点也不给 Tab 停（回车会导航整只窗口） */
            for (const a of bodyBox.querySelectorAll("a")) {
              a.removeAttribute("href");
              a.removeAttribute("target");
              a.tabIndex = -1;
            }
          } else bodyBox.appendChild(el("span", "rs-idx-src-p", t("（这篇还没有正文）")));
          card.appendChild(bodyBox);
          card.appendChild(
            el(
              "span",
              "rs-idx-src-m",
              c.path + (c.variants ? " · " + t("衍生 ") + c.variants + t(" 版") : "") +
                (also.length ? " · " + t("同题 ") + also.length + t(" 篇") : "") +
                " · " + t("点击进入"),
            ),
          );
          card.onclick = open;
          card.onkeydown = (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              open();
            }
          };
          grid.appendChild(card);
        }
      };

      paintTabs();
      paintCards();
      return model;
    }

    function render(host, opts) {
      renderHead(host, opts);
      const o = opts || {};
      if (o.mode === "raw") return null;
      return renderBody(host, opts);
    }

    return {
      render: render,
      renderHead: renderHead,
      renderBody: renderBody,
      buildModel: buildModel,
      state: () => state,
      /* 测试与外部只想拿数字时用：不建 DOM */
      model: (opts) => {
        const data = dataOf(opts);
        return buildModel(
          Object.assign({}, data, {
            keyword: str(opts && opts.keyword != null ? opts.keyword : state.keyword),
          }),
        );
      },
    };
  }

  return {
    create: create,
    buildModel: buildModel,
    previewMarkdown: previewMarkdown,
    previewHtml: previewHtml,
    /* 课题头卡：读那一篇（topicModel / questionBlocks）与改那一篇（三个纯字符串手术） */
    topicModel: topicModel,
    questionBlocks: questionBlocks,
    setTopicTitle: setTopicTitle,
    setCoreQuestion: setCoreQuestion,
    appendQuestion: appendQuestion,
    /* 问题清单：聚合（questionItems）+ 五个纯字符串手术（宿主落盘） */
    questionItems: questionItems,
    applyQuestionEdits: applyQuestionEdits,
    setQuestionText: setQuestionText,
    setQuestionStatus: setQuestionStatus,
    setNoteStatus: setNoteStatus,
    setQuestionAdvice: setQuestionAdvice,
    removeQuestion: removeQuestion,
    readQStatus: readQStatus,
    /* 建议 / 方案的链接字段：读（stripQMeta / readQLinks / questionBlocks 的 advice+fix） */
    stripQMeta: stripQMeta,
    readQLinks: readQLinks,
    /* 状态字典：默认四档 + research.json 的 questionStatus（读 / 归一 / 写盘用的 patch /
      新 id / 引用了哪些 id / 删掉的状态回落） */
    qStatusDict: qStatusDict,
    qStatusOf: qStatusOf,
    qStatusPatch: qStatusPatch,
    qStatusNewId: qStatusNewId,
    qStatusRefs: qStatusRefs,
    normalizeQStatusRefs: normalizeQStatusRefs,
    Q_STATUS_DEFAULT: Q_STATUS_DEFAULT,
    Q_PALETTE: Q_PALETTE,
    Q_FALLBACK: Q_FALLBACK,
    Q_STATUS: Q_STATUS,
    Q_STATUS_LABEL: Q_STATUS_LABEL,
    KIND_ORDER: KIND_ORDER,
    KIND_LABEL: KIND_LABEL,
    PREVIEW_LINES: PREVIEW_LINES,
  };
});

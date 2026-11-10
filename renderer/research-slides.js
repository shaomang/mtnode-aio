/* ===== 研究视图「演示（PPT）」内核：核心原文 + 3-Pass 变体 → 页模型（deck）=====
 * renderer/research-slides.js · window.MTResearchSlides（UMD，纯算不碰盘，node 里可直接 require）
 *
 * 一句话：把「课题 + 核心原文 + 它的 3-Pass 变体」切成一摞可翻页的页（deck），
 * 每页都带 `src.path` + `src.line`，翻到任何一页都能回头指到磁盘上哪一份稿子的第几行。
 *
 * 为什么是一份「页模型」而不是直接画界面：
 *   · 放映（应用内）、导出单文件 HTML、专属编辑器三处都要同一摞页 —— 三处各切一次必然越切越歪；
 *     这里只算、只产出纯 JSON（JSON.parse/stringify 一圈不变），谁能画谁拿去画；
 *   · 手改必须能扛住「重新生成」：手改不进正文，另存 patch（overlay / order / hidden），
 *     重生成 = 内核重算 pages + applyPatch 把 overlay 盖回去 —— 用户改过的字不会因为上游更新而消失。
 *
 * 输入（与左栏树同源，宿主把 view 状态原样递进来）：
 *   {
 *     notes:  [{ path, title, md, meta }]        RS.notes（.md 真源；缺 meta 就现读 frontmatter）
 *     groups: [ {key, base, members:[{path, kind, role, label}]} ]   research-versions.buildGroups 的组
 *     meta:   research.json 的内容（title / corePath / question…）
 *     lib:    CSL-JSON 数组（文献库；用来给引用页补题名 / 年份）
 *     rules:  3-Pass 规则表（{id,label,suffix,derived,hint}；缺省 = 略读 / 关键概念 / 技术细节）
 *     title, slug, date, theme, transition, patch, now   可选覆盖
 *   }
 *
 * 产出（固定 schema；所有键恒在，缺内容就是空串 / 空数组，画的人不用层层判空）：
 *   {
 *     ver: 1,
 *     slug: "…",                      导出文件名 / slides/<slug>.json 用
 *     title: "…",                     课题标题（封面主标题）
 *     date: "YYYY-MM-DD",             封面日期
 *     core: "notes/xx.md",            主稿路径（没有主稿时为空串）
 *     theme: { preset, mode, accent, paper, ink, primary, font, radius, shadow, transition },
 *     transition: "fade" | "push",
 *     pages: [{
 *       id,                           稳定 id（overlay / order / hidden 的键）
 *       kind,                         cover | toc | section | pass3 | term | formula | cites | end
 *       title, kicker,               标题 / 眉题
 *       bullets: [],                 要点（原样取自正文，不重写）
 *       quote,                       引用块（去掉 > 与 [!kind] 标记）
 *       term: {name, def, path, line, uses} | null,
 *       formula: "TeX 原样" | "",
 *       note,                        讲者备注（生成时为空，供编辑器写）
 *       links: [{kind, title, target, page, hits:[{path,title,line,angle}], count}],
 *       layout: "body" | "two" | "image",
 *       media: [],                    叠加的图 / 视频（只有手改才有；{id,kind,src,x,y,w,h,fit,z}）
 *       boxes: null,                  文本框（lead / body 的 {x,y,w}；只有手改才有）
 *       part: 1,                     单节超长时的续页序号（1 = 首页，2、3… = 续页）
 *       hidden: false,               由 patch.hidden 决定，页仍然留在 pages 里（手改不丢）
 *       src: { path, line }          溯源：哪一份稿子、第几行
 *     }],
 *     themePresets: [ … 6 套 × 明 / 暗 … ],         ← **不含 motion**（带上它导出的 HTML 字节就变了）
 *     patch: { overlay: { 页 id: {标题 / 要点 / …} }, order: [页 id], hidden: [页 id],
 *              aspect: "16:9" | "4:3" | "9:16",
 *              chrome: { pgno, src, kind, date, kicker } },     ← 页面元素开关（缺省全开，全开不写）
 *     brief: { ver, mode, audience, occasion, durationSec, tone, focus, avoid, extra, lang, updatedAt },
 *                                              ← 额外指示（**全默认时不写这个键**：老存档与导出的 HTML 字节不变）
 *     builtAt: <ms>
 *   }
 *
 * 切页规则（顺序就是放映顺序，全部确定性，同输入同输出）：
 *   ① 封面     课题（meta.title）+ 主稿标题 + 日期
 *   ② 大纲     主稿的小节标题自动成条，每条链到那一页
 *   ③ 主稿     按 H2 切页；H3 另起一页（眉题 = 它的 H2）；单节超过 5 条要点按段落续页（最多 4 页）
 *   ④ 3-Pass   每一次精读（略读 / 关键概念 / 技术细节）各 1–2 页，要点原样取，不臆造
 *   ⑤ 术语     正文与双链命中的术语，按「被引次数」取前 6 个，一页一个
 *   ⑥ 公式     主稿正文里的 $$…$$ / $…$，TeX 原样进页，一页一条（最多 4 条；同一条式子只出一页）
 *   ⑦ 文献     主稿与变体里的 [@citekey]，一页列全（有文献库就补题名 / 年份）
 *   ⑧ 结语     只报计数（节 / 精读 / 术语 / 公式 / 文献），不写没出处的结论
 *
 * 与其它模块的分工（别在这里加第二份）：
 *   · 版本组（谁是原文、谁是变体、后缀叫什么）= research-versions.js 的唯一口径，本模块只读 groups；
 *   · 术语的唯一真源 = 正文里的 `> [!term] 名称` 块；公式 / 双链 / 引用的正则与 research-core.js
 *     的 RE_WIKI / RE_CITE / collectFormulas 同一份写法（此处按行号需求就地再写一遍，
 *     换正则时两边一起改）；
 *   · 画界面 = research-slides-view.js（放映 / 导出）与 app-research-slides.js（编辑器），
 *     本模块不建 DOM、不读盘、不联网。
 *
 * 风格与运动量的单一真源（静态版与视频版共用这一份）：
 *   · 颜色 / 字体档 / 圆角 / 阴影 = THEME_PRESETS 的 light / dark 两张表 → themeVars()（静态侧只读这个，字节不变）；
 *   · 动效 = 每套预设的 motion 表（缓动 / 入场 / 转场帧数 / 字速 / 节拍 / 背景）→ motionOf(theme)；
 *   · 一次取齐 = styleTokens(brief, theme, pages)（颜色 + 字体 + 圆角 + 运动量 + 节奏系数）。
 *   motion 不进 deck.themePresets，也不进导出的 HTML —— 视频侧取，静态侧看不见。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.MTResearchSlides = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const VER = 1;
  /* 演示的手改与导出都落在研究目录里（与 versions.json 同级，应用独占）：
       <research>/slides/<slug>.json      手改 patch（overlay / order / hidden）
       <research>/exports/<slug>/<slug>.html   导出的单文件（写盘在宿主，本模块只给路径） */
  const STORE_DIR = "slides";
  const EXPORT_DIR = "exports";

  const PAGE_KINDS = ["cover", "toc", "section", "pass3", "term", "formula", "cites", "end"];
  const KIND_LABEL = {
    cover: "封面",
    toc: "大纲",
    section: "正文",
    pass3: "精读",
    term: "术语",
    formula: "公式",
    cites: "文献",
    end: "结语",
  };
  /* 3D 场景（视频侧 three.js 用）：只这三套 —— 都是「一页能讲清一件事」的骨架，
     静态版看见的是一张静帧示意图，视频版看见它真的在转（见 research-slides-video.js 的 Scene3D.tsx）。 */
  const SCENES = ["", "orbit", "grid", "signal"];
  const SCENE_LABEL = { "": "无", orbit: "轨道（层级 / 系统）", grid: "网格（空间 / 结构）", signal: "信号（波 / 传播）" };
  /* 转场只两档：淡入 / 推进（不做编排系统） */
  const TRANSITIONS = ["fade", "push"];
  const TRANSITION_LABEL = { fade: "淡入", push: "推进" };
  /* 版式：正文一栏 / 两栏 / 图文（编辑器里可逐页改，缺省 body） */
  const LAYOUTS = ["body", "two", "image"];
  const MODES = ["light", "dark"];
  /* 页面比例：整份 deck 统一（编辑器里可换；坐标全是百分比，所以换比例只是换个画框） */
  const ASPECTS = ["16:9", "4:3", "9:16"];
  const ASPECT_AR = { "16:9": 16 / 9, "4:3": 4 / 3, "9:16": 9 / 16 };
  const ASPECT_LABEL = { "16:9": "宽屏 16:9", "4:3": "标准 4:3", "9:16": "竖屏 9:16" };
  /* 自由版面的对象：文本 / 图片 / 视频 / 形状（数组顺序 = 层序，越靠后越压在上面） */
  const OBJ_KINDS = ["text", "image", "video", "shape"];
  const OBJ_FITS = ["contain", "cover", "crop"];
  const SHAPES = ["rect", "round", "ellipse", "line", "arrow", "highlight"];
  const SHAPE_LABEL = {
    rect: "矩形",
    round: "圆角矩形",
    ellipse: "椭圆",
    line: "分割线",
    arrow: "箭头",
    highlight: "高亮块",
  };
  const TEXT_ALIGNS = ["left", "center", "right"];
  /* 颜色只认两种写法：主题色名（primary / accent / ink / muted / paper）与 #rrggbb ——
     主题色名在渲染时解析成 var(--rs-slide-*)，换主题就跟着换；hex 是用户的单件覆盖。 */
  const COLOR_NAMES = ["primary", "accent", "ink", "muted", "paper"];

  /* 一页最多几条要点；超了就按段落续页（上限见 MAX_PART_PAGES） */
  const MAX_BULLETS = 5;
  const MAX_PART_PAGES = 4;
  const MAX_BULLET_CHARS = 200;
  const TERM_MAX = 6;
  const FORMULA_MAX = 4;
  const LINK_MAX = 6;
  const HIT_MAX = 6;
  const DEF_MAX = 220;

  /* 3-Pass 规则表的缺省（与 research-versions.js 的 PASS3_RULES 同一套 id / 后缀；
     宿主把 rules 递进来时以宿主为准 —— 那边是唯一真源） */
  const PASS3_DEFAULT = [
    { id: "skim", label: "略读", derived: "skim", suffix: "skim" },
    { id: "concept", label: "关键概念", derived: "concept", suffix: "concept" },
    { id: "tech", label: "技术细节", derived: "tech", suffix: "tech" },
  ];

  /* ── 小工具 ───────────────────────────────────────────────────────────── */
  const str = (v) => (v == null ? "" : String(v));
  const normRel = (p) =>
    str(p)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
  const stripExt = (p) => normRel(p).replace(/\.[a-z0-9]+$/i, "");
  const baseName = (p) => normRel(p).split("/").pop() || "";
  const dirOf = (p) => {
    const s = normRel(p);
    const i = s.lastIndexOf("/");
    return i < 0 ? "" : s.slice(0, i + 1);
  };
  const clip = (s, n) => {
    const t = str(s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  /* 与 research-core.js 的 slugify 同一份口径（中文保留，空白转连字符，其它符号去掉） */
  function slugify(s) {
    return str(s)
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, "-")
      .replace(/[^\w\u4e00-\u9fa5.-]+/g, "")
      .replace(/-+/g, "-")
      .slice(0, 80);
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
  function isoDate(ms) {
    const n = Number(ms);
    const d = new Date(Number.isFinite(n) && n > 0 ? n : Date.now());
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  /* 标题里的行内 Markdown 收干净（标题栏要显示成字，不能露 ** / [[…]] / [文字](url) 源码） */
  function inlineText(s) {
    return str(s)
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
      .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
      .replace(/~~([\s\S]+?)~~/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      .trim();
  }
  /* 一张表 / 一次扫描都要的行号：字符下标 → 1 起始行号（body 内） */
  function lineAt(body, index) {
    let n = 1;
    for (let i = 0; i < index && i < body.length; i++) if (body.charCodeAt(i) === 10) n++;
    return n;
  }

  /* ── 一篇稿子：frontmatter + 正文 + 正文起始行号 ──────────────────────────
     offset = frontmatter 整块占掉的行数（含开头那行 ---）；正文第 1 行 = 文件第 offset+1 行。
     与 research-core.js 的 parseFrontmatter 同一口径（那边只给 body，这边还要行号偏移）。 */
  const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
  function parseDoc(md) {
    const text = str(md).replace(/\r\n?/g, "\n");
    const m = FM_RE.exec(text);
    const offset = m ? (m[0].match(/\n/g) || []).length : 0;
    return { meta: m ? parseFrontmatterBlock(m[1]) : {}, body: m ? text.slice(m[0].length) : text, offset: offset, md: text };
  }
  /* frontmatter 只取标题 / 方向这类短标量，不做完整 YAML（正文才是真源） */
  function parseFrontmatterBlock(raw) {
    const out = {};
    for (const line of str(raw).split("\n")) {
      const m = /^([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (!v) continue;
      if (/^\[.*\]$/.test(v)) {
        out[m[1]] = v
          .slice(1, -1)
          .split(",")
          .map((x) => x.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else out[m[1]] = v.replace(/^["']|["']$/g, "");
    }
    return out;
  }
  /* 归一化一份笔记（宿主传进来的可能只有 path + md） */
  function normalizeNote(n) {
    const path = normRel(n && n.path);
    if (!path) return null;
    const md = str(n && n.md);
    const fm = parseDoc(md).meta;
    const meta = Object.assign({}, fm, (n && n.meta) || {});
    const title =
      str(n && n.title) || str(meta.title) || baseName(path).replace(/\.[a-z0-9]+$/i, "");
    return { path: path, title: title, md: md, meta: meta };
  }
  /* 笔记自己声明的「方向」（定义 / 由来推导 / 相邻概念对照…）：三个键都认，读侧只当一段文字 */
  function angleOf(meta) {
    const m = meta || {};
    return str(m["方向"] || m.angle || m.direction || m.dir).trim();
  }

  /* ── 切节：H2 一节，H3 一节（眉题 = 它的 H2）；H4 以下当正文，不丢字 ────────── */
  function splitSections(md) {
    const doc = parseDoc(md);
    const lines = doc.body.split("\n");
    const out = [];
    let cur = null;
    let docTitle = "";
    const push = (level, heading, line) => {
      const s = { level: level, heading: heading, line: line, parent: "", lines: [] };
      if (level === 3) for (let i = out.length - 1; i >= 0; i--) if (out[i].level === 2) { s.parent = out[i].heading; break; }
      out.push(s);
      cur = s;
      return s;
    };
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      const lineNo = doc.offset + i + 1;
      const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(text);
      if (m) {
        const level = m[1].length;
        const heading = inlineText(m[2]);
        if (level === 1) {
          if (!docTitle) docTitle = heading;
          continue;
        }
        if (level === 2) { push(2, heading, lineNo); continue; }
        if (level === 3) { push(3, heading, lineNo); continue; }
        if (cur) cur.lines.push({ text: heading, line: lineNo });
        continue;
      }
      if (!cur) {
        /* 第一个 H2 之前的那段（摘要 / 引言）：按主稿标题成一页，不丢内容 */
        if (!text.trim()) continue;
        push(2, docTitle || "", lineNo);
      }
      cur.lines.push({ text: text, line: lineNo });
    }
    return { meta: doc.meta, offset: doc.offset, title: docTitle, sections: out };
  }

  /* ── 正文块：段落 / 列表项 / 引用 / 代码 / 表格 ────────────────────────────
     要点只从「段落」与「列表项」里取（代码与表格照原样进不了要点，硬塞会变形）。 */
  function blocksOf(lines) {
    const out = [];
    let buf = null;
    const flush = () => {
      if (buf && str(buf.text).trim()) out.push(buf);
      buf = null;
    };
    for (const ln of lines || []) {
      const text = str(ln && ln.text);
      const line = Number(ln && ln.line) || 0;
      if (!text.trim()) { flush(); continue; }
      if (/^\s*(?:```|~~~)/.test(text)) {
        flush();
        out.push({ kind: "code", text: text.replace(/^\s*(?:```|~~~)\s*/, ""), line: line });
        continue;
      }
      const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(text);
      if (li) {
        flush();
        out.push({ kind: "li", text: li[1], line: line });
        continue;
      }
      if (/^\s*>/.test(text)) {
        flush();
        out.push({ kind: "quote", text: text.replace(/^\s*>\s?/, ""), line: line });
        continue;
      }
      if (/^\s*\|/.test(text)) {
        flush();
        out.push({ kind: "table", text: text.trim(), line: line });
        continue;
      }
      if (!buf) buf = { kind: "p", text: "", line: line };
      buf.text = (buf.text ? buf.text + " " : "") + text.trim();
    }
    flush();
    return out;
  }
  /* 引用块：连着的 > 行拼一段；`[!claim]` 这类标记行不进正文 */
  function quoteOf(blocks) {
    const qs = (blocks || []).filter((b) => b.kind === "quote");
    if (!qs.length) return "";
    const lines = [];
    for (const b of qs) {
      const t = str(b.text).trim();
      if (!t) continue;
      if (/^\[![A-Za-z-]+/.test(t)) continue;
      if (/^(?:支撑|来源|出处|verify|状态|qstatus|advice|fix)\s*[:：]/i.test(t)) continue;
      lines.push(t);
      if (lines.length >= 4) break;
    }
    return clip(lines.join(" "), 400);
  }
  /* 要点：段落 / 列表项原样取（裁到一句的长度，不改写、不总结） */
  function bulletsOf(blocks, max) {
    const cap = Number(max) > 0 ? Number(max) : MAX_BULLETS;
    const out = [];
    for (const b of blocks || []) {
      if (b.kind !== "p" && b.kind !== "li") continue;
      const text = clip(inlineText(b.text), MAX_BULLET_CHARS);
      if (!text) continue;
      if (out.indexOf(text) >= 0) continue;
      out.push(text);
      if (out.length >= cap) break;
    }
    return out;
  }

  /* ── 抽取：双链 / 引用 / 公式 / 术语 ──────────────────────────────────────
     正则是 research-core.js 的同一份写法（RE_WIKI / RE_CITE / collectFormulas），
     此处多给一个行号，供每页的 src.line 与链接卡用。 */
  const RE_WIKI = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const RE_CITE = /\[(-?)@([A-Za-z0-9_:.#/-]+)([^\]]*)\]/g;
  function wikilinksOf(text) {
    const out = [];
    const s = str(text);
    RE_WIKI.lastIndex = 0;
    let m;
    while ((m = RE_WIKI.exec(s))) out.push({ target: str(m[1]).trim(), alias: str(m[2]).trim() });
    return out;
  }
  function citesOf(text) {
    const out = [];
    const s = str(text);
    RE_CITE.lastIndex = 0;
    let m;
    while ((m = RE_CITE.exec(s))) out.push({ key: str(m[2]).trim(), locator: str(m[3]).trim() });
    return out;
  }
  /* 公式：$$…$$（可跨行）与 $…$（单行内），TeX 原样带出来，行号 = 起始那行 */
  function formulaIndexOf(md) {
    const doc = parseDoc(md);
    const body = doc.body;
    const out = [];
    const disp = /\$\$([\s\S]+?)\$\$/g;
    let m;
    while ((m = disp.exec(body))) {
      const tex = str(m[1]).trim();
      if (!tex) continue;
      out.push({ tex: tex, display: true, line: doc.offset + lineAt(body, m.index) });
    }
    const inl = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;
    while ((m = inl.exec(body))) {
      const tex = str(m[1]).trim();
      if (!tex) continue;
      out.push({ tex: tex, display: false, line: doc.offset + lineAt(body, m.index) });
    }
    return out;
  }
  /* 引用：[@citekey] 逐条给行号（文献页的 src.line 就用第一条的位置）。
     `[@a; @b]` 是多篇同引，键逐个算 —— 与 citesOf / research-core 的 RE_CITE 同一份写法。 */
  function citeIndexOf(md) {
    const doc = parseDoc(md);
    const body = doc.body;
    const out = [];
    const re = /\[(-?)@([A-Za-z0-9_:.#/-]+)([^\]]*)\]/g;
    let m;
    while ((m = re.exec(body))) {
      const key = str(m[2]).trim();
      if (!key) continue;
      const line = doc.offset + lineAt(body, m.index);
      out.push({ key: key, locator: str(m[3]).trim(), line: line });
      /* 多篇同引：同一处方括号里的 `; @b` 也算，行号与首条一致 */
      const rest = str(m[3] || "");
      const re2 = /;\s*@([A-Za-z0-9_:.#/-]+)/g;
      let m2;
      while ((m2 = re2.exec(rest))) out.push({ key: str(m2[1]).trim(), locator: "", line: line });
    }
    return out;
  }
  /* 术语的唯一真源：正文里的 `> [!term] 名称` 块（块的正文就是定义，同名以先出现的为准） */
  function termIndexOf(notes) {
    const out = {};
    for (const n of notes || []) {
      const path = normRel(n && n.path);
      if (!path) continue;
      const doc = parseDoc(n && n.md);
      const lines = doc.body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*>\s*\[!term(?:\|[^\]]*)?\]\s*(.*)$/i.exec(lines[i]);
        if (!m) continue;
        const name = str(m[1]).trim();
        if (!name || out[name]) continue;
        const buf = [];
        for (let j = i + 1; j < lines.length; j++) {
          const ln = lines[j];
          if (/^\s*$/.test(ln) || !/^\s*>/.test(ln)) break;
          buf.push(ln.replace(/^\s*>\s?/, ""));
        }
        let def = buf.join("\n").trim();
        if (def.indexOf(name) === 0) def = def.slice(name.length).replace(/^[\s:：]*/, "");
        out[name] = {
          name: name,
          def: clip(def, DEF_MAX),
          path: path,
          line: doc.offset + i + 1,
          angle: angleOf(n.meta),
        };
      }
    }
    return out;
  }
  /* 一篇正文里出现某个词多少次（术语被引次数的口径：正文出现 + 双链指向 + 写过它的篇数） */
  function countIn(text, word) {
    const s = str(text);
    const w = str(word);
    if (!s || !w) return 0;
    let n = 0;
    let i = s.indexOf(w);
    while (i >= 0) {
      n++;
      i = s.indexOf(w, i + w.length);
    }
    return n;
  }
  /* 「库里哪些笔记写过它」：命中行取第一次出现那行，方向取笔记自己声明的 */
  function hitsOf(notes, kind, keys) {
    const list = (keys || []).map((k) => str(k)).filter(Boolean);
    if (!list.length) return [];
    const out = [];
    for (const n of notes || []) {
      const doc = parseDoc(n && n.md);
      const body = doc.body;
      let line = 0;
      let hits = 0;
      if (kind === "cite") {
        for (const k of list) {
          const re = new RegExp("\\[@\\s*" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[;\\],]", "g");
          let m = re.exec(body);
          while (m) {
            hits++;
            if (!line) line = doc.offset + lineAt(body, m.index);
            m = re.exec(body);
          }
        }
      } else {
        for (const k of list) {
          const re = new RegExp("\\[\\[\\s*" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(?:\\||\\]\\])", "g");
          let m = re.exec(body);
          while (m) {
            hits++;
            if (!line) line = doc.offset + lineAt(body, m.index);
            m = re.exec(body);
          }
          const plain = countIn(body, k);
          if (plain) {
            hits += plain;
            if (!line) {
              const at = body.indexOf(k);
              if (at >= 0) line = doc.offset + lineAt(body, at);
            }
          }
        }
      }
      if (!hits || !line) continue;
      out.push({
        path: normRel(n.path),
        title: str(n.title) || baseName(n.path),
        line: line,
        angle: angleOf(n.meta),
        count: hits,
      });
    }
    out.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    return out.slice(0, HIT_MAX);
  }

  /* ── 主题：6 套预设 × 明 / 暗（只出变量表，样式在 css/research-slides.css）──
     每套给五样东西：主色 / 强调色 / 纸色 / 字体档 / 圆角档 / 阴影档；
     字体档 → 字体族 + 基准字号，圆角档 → px，阴影档 → box-shadow，全在下面的三张表里。 */
  const FONTS = {
    sans: {
      label: "无衬线",
      family: '"Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
      fs: "23px",
    },
    serif: {
      label: "衬线",
      family: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, "Times New Roman", serif',
      fs: "24px",
    },
    kai: {
      label: "楷体",
      family: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif SC", serif',
      fs: "24px",
    },
  };
  const RADIUS = { sharp: "4px", soft: "12px", round: "22px" };
  const RADIUS_LABEL = { sharp: "直", soft: "柔", round: "圆" };
  const SHADOW = {
    none: "none",
    flat: "0 2px 8px rgba(0, 0, 0, 0.10)",
    deep: "0 24px 64px rgba(0, 0, 0, 0.32)",
  };
  const SHADOW_LABEL = { none: "无", flat: "浅", deep: "深" };

  /* ── 动效（motion）：静态版看不见，视频版按它排 ────────────────────────────
     每套预设一份（明暗不改变 motion：切个暗色不该让动效突然变快）。
     转场仍然只有 fade / push 两档（沿用 deck.transition），这里的 transitionFrames 只决定手感 —— 
     不新增枚举，否则会出现「视频有、静态没有」的分叉。 */
  const EASES = ["out", "inOut", "outBack"];
  const ENTERS = ["rise", "fade", "wipe", "scale"];
  const MOTION_BGS = ["none", "grain", "grid", "vignette"];
  const MOTION_DEFAULT = {
    ease: "out",
    enter: "rise",
    enterFrames: 18,
    staggerFrames: 5,
    transitionFrames: 12,
    cpsTitle: 6,
    cpsBullet: 4.5,
    bpm: 96,
    bg: "none",
  };
  /* 单页时长的上下限（视频侧夹在中间；封顶后不靠拉长解决，而是这一页本来就该拆） */
  const MIN_PAGE_SEC = 2.4;
  const MAX_PAGE_SEC = 18;
  /* 视频帧率：与 PDF 同一把尺子（144 dpi），帧数换算只认这一个值 */
  const FPS = 30;

  /* 六套预设：id / 名称 / 一句说明 / 明 / 暗 两张变量表 + 一份 motion 表 */
  const THEME_PRESETS = [
    {
      id: "paper",
      label: "纸张",
      desc: "米白纸 + 墨黑字，最像打印稿，长文本最耐看",
      light: { primary: "#2f5d8a", accent: "#b4531f", paper: "#fbf8f1", paper2: "#f3ede1", ink: "#221f1b", muted: "#6b6459", rule: "#e3dbcb", font: "serif", radius: "soft", shadow: "flat" },
      dark: { primary: "#8ab6e2", accent: "#e59a6a", paper: "#1b1a17", paper2: "#232220", ink: "#f1ece1", muted: "#a49c8e", rule: "#3a3733", font: "serif", radius: "soft", shadow: "flat" },
      motion: { ease: "out", enter: "rise", enterFrames: 20, staggerFrames: 6, transitionFrames: 14, cpsTitle: 5.8, cpsBullet: 4.4, bpm: 84, bg: "grain" },
    },
    {
      id: "ink",
      label: "墨白",
      desc: "纯黑白 + 一点赭红，最克制，投影仪上也干净",
      light: { primary: "#111827", accent: "#c2410c", paper: "#ffffff", paper2: "#f4f4f5", ink: "#101418", muted: "#6b7280", rule: "#e5e7eb", font: "sans", radius: "sharp", shadow: "none" },
      dark: { primary: "#9db4d0", accent: "#f59e0b", paper: "#0f1115", paper2: "#171a20", ink: "#e8eaed", muted: "#9aa1ab", rule: "#2a2f38", font: "sans", radius: "sharp", shadow: "none" },
      motion: { ease: "out", enter: "fade", enterFrames: 14, staggerFrames: 4, transitionFrames: 8, cpsTitle: 6.4, cpsBullet: 5.0, bpm: 108, bg: "none" },
    },
    {
      id: "azure",
      label: "海蓝",
      desc: "浅蓝纸 + 深蓝主色，技术类内容的默认配色",
      light: { primary: "#1d4ed8", accent: "#0891b2", paper: "#f4f8fc", paper2: "#e8f0fa", ink: "#16222e", muted: "#5b6b7c", rule: "#d5e2f0", font: "sans", radius: "round", shadow: "flat" },
      dark: { primary: "#7ab3ff", accent: "#22d3ee", paper: "#0b1622", paper2: "#122032", ink: "#e6eef7", muted: "#93a5b8", rule: "#22334a", font: "sans", radius: "round", shadow: "flat" },
      motion: { ease: "out", enter: "wipe", enterFrames: 16, staggerFrames: 5, transitionFrames: 12, cpsTitle: 6.0, cpsBullet: 4.6, bpm: 96, bg: "grid" },
    },
    {
      id: "sage",
      label: "苔绿",
      desc: "灰绿纸 + 橄榄主色，适合长会与读书会",
      light: { primary: "#3f6212", accent: "#b45309", paper: "#f6f8f2", paper2: "#ebf0e2", ink: "#1d221a", muted: "#5f6a53", rule: "#dde5d2", font: "serif", radius: "soft", shadow: "none" },
      dark: { primary: "#a3c86b", accent: "#f0b26b", paper: "#12160f", paper2: "#1a2016", ink: "#e8efdf", muted: "#9aa88b", rule: "#2c3526", font: "serif", radius: "soft", shadow: "none" },
      motion: { ease: "inOut", enter: "rise", enterFrames: 22, staggerFrames: 7, transitionFrames: 16, cpsTitle: 5.6, cpsBullet: 4.2, bpm: 76, bg: "none" },
    },
    {
      id: "clay",
      label: "陶土",
      desc: "暖陶色 + 青绿点色，人文 / 综述类偏好看",
      light: { primary: "#9a3412", accent: "#0f766e", paper: "#fdf6f2", paper2: "#f7e9e1", ink: "#241a16", muted: "#6b574e", rule: "#ecd8cd", font: "serif", radius: "round", shadow: "flat" },
      dark: { primary: "#f0a37a", accent: "#5eead4", paper: "#1a1210", paper2: "#241a16", ink: "#f6e8e2", muted: "#b39c92", rule: "#3a2721", font: "serif", radius: "round", shadow: "flat" },
      motion: { ease: "inOut", enter: "scale", enterFrames: 18, staggerFrames: 6, transitionFrames: 14, cpsTitle: 5.8, cpsBullet: 4.4, bpm: 88, bg: "grain" },
    },
    {
      id: "midnight",
      label: "午夜",
      desc: "靛紫 + 洋红点色，暗场演示最抓眼",
      light: { primary: "#4f46e5", accent: "#db2777", paper: "#f5f5f7", paper2: "#ebebf0", ink: "#14161a", muted: "#5f6470", rule: "#dcdce4", font: "sans", radius: "sharp", shadow: "flat" },
      dark: { primary: "#a5b4fc", accent: "#f472b6", paper: "#0b0b10", paper2: "#141420", ink: "#ececf1", muted: "#9b9baa", rule: "#272736", font: "sans", radius: "sharp", shadow: "deep" },
      motion: { ease: "outBack", enter: "scale", enterFrames: 16, staggerFrames: 4, transitionFrames: 10, cpsTitle: 6.2, cpsBullet: 4.8, bpm: 120, bg: "vignette" },
    },
  ];
  function presetOf(id) {
    const key = str(id).trim().toLowerCase();
    for (const p of THEME_PRESETS) if (p.id === key) return p;
    return THEME_PRESETS[0];
  }
  function modeOf(v) {
    const k = str(v).trim().toLowerCase();
    return k === "dark" ? "dark" : "light";
  }
  /* 主题归一：预设 + 明暗 + 单个覆盖（主色 / 强调色 / 纸色 / 字体档 / 圆角 / 阴影 / 转场） */
  function normalizeTheme(t) {
    const src = t && typeof t === "object" ? t : {};
    const preset = presetOf(src.preset || src.id);
    const mode = modeOf(src.mode);
    const base = preset[mode] || preset.light;
    const pick = (k) => {
      const v = src[k];
      return str(v).trim() ? str(v).trim() : base[k];
    };
    const font = FONTS[pick("font")] ? pick("font") : base.font;
    const radius = RADIUS[pick("radius")] ? pick("radius") : base.radius;
    const shadow = Object.prototype.hasOwnProperty.call(SHADOW, pick("shadow")) ? pick("shadow") : base.shadow;
    return {
      preset: preset.id,
      mode: mode,
      primary: pick("primary"),
      accent: pick("accent"),
      paper: pick("paper"),
      paper2: str(src.paper2).trim() || base.paper2,
      ink: str(src.ink).trim() || base.ink,
      muted: str(src.muted).trim() || base.muted,
      rule: str(src.rule).trim() || base.rule,
      font: font,
      radius: radius,
      shadow: shadow,
      transition: TRANSITIONS.indexOf(str(src.transition)) >= 0 ? str(src.transition) : "fade",
    };
  }
  /* 变量表：样式层只认这些 --rs-slide-*（视图 / 导出 HTML 都从这里取，不再各写一套颜色） */
  function themeVars(t) {
    const th = normalizeTheme(t);
    const f = FONTS[th.font] || FONTS.sans;
    return {
      "--rs-slide-scheme": th.mode,
      "--rs-slide-primary": th.primary,
      "--rs-slide-accent": th.accent,
      "--rs-slide-paper": th.paper,
      "--rs-slide-paper2": th.paper2,
      "--rs-slide-ink": th.ink,
      "--rs-slide-muted": th.muted,
      "--rs-slide-rule": th.rule,
      "--rs-slide-font": f.family,
      "--rs-slide-fs": f.fs,
      "--rs-slide-radius": RADIUS[th.radius] || RADIUS.soft,
      "--rs-slide-shadow": SHADOW[th.shadow] || SHADOW.flat,
    };
  }
  /* 变量表 → 内联样式串（导出 HTML 里直接写进 :root；应用内也用它铺一层） */
  function cssVars(t) {
    const vars = themeVars(t);
    return Object.keys(vars)
      .map((k) => k + ":" + vars[k])
      .join(";");
  }

  /* ── 运动量（motion）：与颜色同源，一页一份，视频侧只认这里 ──────────────────
     每套预设一份表；缺项按 MOTION_DEFAULT 补、数值夹进合理范围（手写 deck 也读得动）。 */
  function pickEnum(v, list, def) {
    const k = str(v).trim();
    return list.indexOf(k) >= 0 ? k : def;
  }
  function numIn(v, def, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(lo, Math.min(hi, n));
  }
  function round2(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
  }
  function normalizeMotion(m) {
    const s = m && typeof m === "object" && !Array.isArray(m) ? m : {};
    const d = MOTION_DEFAULT;
    return {
      ease: pickEnum(s.ease, EASES, d.ease),
      enter: pickEnum(s.enter, ENTERS, d.enter),
      enterFrames: Math.round(numIn(s.enterFrames, d.enterFrames, 4, 90)),
      staggerFrames: Math.round(numIn(s.staggerFrames, d.staggerFrames, 0, 60)),
      transitionFrames: Math.round(numIn(s.transitionFrames, d.transitionFrames, 0, 90)),
      cpsTitle: round2(numIn(s.cpsTitle, d.cpsTitle, 1, 40)),
      cpsBullet: round2(numIn(s.cpsBullet, d.cpsBullet, 0.5, 40)),
      minPageSec: round2(numIn(s.minPageSec, MIN_PAGE_SEC, 0.5, 120)),
      maxPageSec: round2(numIn(s.maxPageSec, MAX_PAGE_SEC, 1, 600)),
      bpm: Math.round(numIn(s.bpm, d.bpm, 40, 200)),
      bg: pickEnum(s.bg, MOTION_BGS, d.bg),
    };
  }
  /* 一份主题的 motion：只看预设（明暗不改变运动量；单键覆盖只管颜色 / 字体 / 圆角 / 阴影） */
  function motionOf(t) {
    const th = normalizeTheme(t);
    const p = presetOf(th.preset);
    return normalizeMotion(p.motion);
  }
  /* motion 参数既收主题也收 motion 表（宿主 / 自检两边都这么喂） */
  function motionArgOf(v) {
    const o = v && typeof v === "object" ? v : {};
    if (o.ease || o.cpsBullet || o.bpm || o.minPageSec || o.enterFrames) return normalizeMotion(o);
    return motionOf(o);
  }
  /* styleTokens(brief, theme, pages)：静态版与视频版共用的那一份「颜色 + 字体 + 圆角 + 运动量」。
     pages 可选（给了就把节奏系数 / 目标时长 / 页数区间一并算出来，见 planBrief）；
     颜色走 themeVars（静态侧同一个函数），运动量走预设 motion —— 两边不可能各说一套。 */
  function styleTokens(brief, theme, pages) {
    const th = normalizeTheme(theme);
    const f = FONTS[th.font] || FONTS.sans;
    const motion = motionOf(th);
    const plan = planBrief(brief, pages, th);
    motion.fps = FPS;
    motion.pace = plan.pace;
    motion.targetSec = plan.durationSec;
    motion.totalSec = plan.totalSec;
    return {
      theme: th,
      css: themeVars(th),
      font: f.family,
      fontSize: f.fs,
      radius: RADIUS[th.radius] || RADIUS.soft,
      shadow: SHADOW[th.shadow] || SHADOW.flat,
      transition: th.transition,
      motion: motion,
      plan: plan,
    };
  }

  /* ── patch：手改（overlay）/ 拖排（order）/ 隐藏（hidden） ─────────────────
     重新生成时内核从头算 pages，再把 patch 盖回去：
       overlay  按页 id 存「用户改过的字段」——只认下面这 8 个，别的字段永远是内核算的（改不歪）
       order    页 id 的先后（没列到的页按内核顺序排在后面）
       hidden   隐藏的页 id（页还在 pages 里，手改不丢，随时能再露出来） */
  const EDIT_KEYS = [
    "title",
    "kicker",
    "bullets",
    "quote",
    "note",
    "layout",
    "media",
    "boxes",
    "free",
    "objects",
  ];
  function emptyPatch() {
    /* aspect 只在「用户改过比例」时才出现在 patch 里（空 = 跟 deck 自带的那个）：
       这样老存档的形状不变，读回去也不会平白多一个键。 */
    return { overlay: {}, order: [], hidden: [] };
  }
  /* 页面比例归一：认 "16:9" / "4:3" / "9:16"（也认 16/9 这种写法），别的给缺省 16:9 */
  function normalizeAspect(v) {
    const s = str(v).trim().replace(/\s+/g, "").replace("/", ":");
    return ASPECTS.indexOf(s) >= 0 ? s : "16:9";
  }

  /* ── 页面元素开关（chrome）────────────────────────────────────────────────
     整份 deck 一份，存在 patch.chrome 里；五个开关都是「显示 = true」：
       pgno    页脚右端页序「n / N」
       src     页脚左端来源「文件名:行号」
       kind    页脚中间的类型标签（封面 / 大纲 / 术语…）
       date    封面标题下的日期
       kicker  标题上方的眉题
     缺省全 true —— 老存档（没有 chrome 这个键）读进来与之前一模一样；
     关掉哪一项才写哪个键，全部显式 true 时 normalizePatch 会把整个键丢掉（存档形状不变）。 */
  const CHROME_KEYS = ["pgno", "src", "kind", "date", "kicker"];
  const CHROME_LABEL = {
    pgno: "右下角页码",
    src: "左下来源（文件名:行号）",
    kind: "页脚类型标签",
    date: "封面日期",
    kicker: "眉题（标题上方小字）",
  };
  /* 「关」认 false / 0 / "0" / "false" / "off"（手写 deck 也关得掉），别的都算开 */
  function chromeOn(v) {
    return !(v === false || v === 0 || v === "0" || v === "false" || v === "off");
  }
  function normalizeChrome(v) {
    const src = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    const out = {};
    for (const k of CHROME_KEYS) out[k] = chromeOn(src[k]);
    return out;
  }
  /* 一份 deck 的页面元素开关（放映 / 预览 / 导出 / 编辑器都从这里取，不再各算一套） */
  function chromeOf(deck) {
    const d = deck && typeof deck === "object" ? deck : {};
    return normalizeChrome(d.patch && d.patch.chrome);
  }

  /* ── 叠加层：图片 / 视频（media）与文本框（boxes） ────────────────────────
     media 的 src 只认两种：research 根下的 slides/media/… 相对路径、data: URL
     （磁盘上别处的绝对路径与外链一律不收 —— 存档要能随研究目录整包搬走）。
     x / y / w / h 一律收敛成 0–100 的数字（clamp），缺省按序号依次错位落位。 */
  const MEDIA_KINDS = ["image", "video"];
  const MEDIA_FITS = ["contain", "cover"];
  const MEDIA_PREFIX = STORE_DIR + "/media/";
  const BOX_KEYS = ["lead", "body"];
  const BOX_FIELDS = ["x", "y", "w"];
  function num100(v) {
    if (v == null || (typeof v === "string" && !v.trim())) return null;
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }
  function mediaSrcOf(v) {
    const s = normRel(v).trim();
    if (!s) return "";
    if (/^data:(image|video)\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.charAt(0) === "/") return "";
    if (s.indexOf(MEDIA_PREFIX) !== 0) return "";
    if (s.split("/").indexOf("..") >= 0) return "";
    return s;
  }
  function normalizeMedia(list) {
    const src = Array.isArray(list) ? list : [];
    const out = [];
    const used = new Set();
    for (let i = 0; i < src.length; i++) {
      const one = src[i];
      if (!one || typeof one !== "object") continue;
      const s = mediaSrcOf(one.src);
      if (!s) continue;
      const rawKind = str(one.kind).trim();
      const kind = MEDIA_KINDS.indexOf(rawKind) >= 0 ? rawKind : /^data:video\//i.test(s) ? "video" : "image";
      let id = str(one.id).trim().replace(/[^\w.-]+/g, "-").slice(0, 48);
      if (!id) id = "m-" + hashString(kind + ":" + s).slice(0, 8);
      const rawFit = str(one.fit).trim();
      const step = (i % 4) * 6;
      const x = num100(one.x);
      const y = num100(one.y);
      const w = num100(one.w);
      const h = num100(one.h);
      const zn = Number(one.z);
      out.push({
        id: uid(used, id),
        kind: kind,
        src: s,
        x: x == null ? 6 + step : x,
        y: y == null ? 6 + step : y,
        w: w == null ? 40 : w,
        h: h == null ? 30 : h,
        fit: MEDIA_FITS.indexOf(rawFit) >= 0 ? rawFit : "contain",
        z: Number.isFinite(zn) ? Math.round(zn) : 1,
        /* note 只是编辑器里给自己看的备注（不上屏、不参与落位）：归一这一趟别把它丢掉，
           否则编辑器的「备注」一重画就空、重开存档也没了。 */
        note: str(one.note).trim().slice(0, 200),
      });
    }
    return out;
  }
  /* boxes：只留 lead / body 两个盒子，各取 x / y / w（0–100 clamp）；一个都没给就是 null */
  function normalizeBoxes(src) {
    if (!src || typeof src !== "object" || Array.isArray(src)) return null;
    const out = {};
    for (const k of BOX_KEYS) {
      const one = src[k];
      if (!one || typeof one !== "object") continue;
      const box = {};
      for (const f of BOX_FIELDS) {
        const n = num100(one[f]);
        if (n != null) box[f] = n;
      }
      if (Object.keys(box).length) out[k] = box;
    }
    return Object.keys(out).length ? out : null;
  }

  /* ── 自由版面的对象表（objects）─────────────────────────────────────────────
     Keynote 式的「自己排」：一页 = 一叠对象，**数组顺序就是层序**（越靠后越压在上面），
     没有 z 字段 —— 置前 / 置后 / 置顶 / 置底一律是挪数组，存档因此永远只有一种写法。
     坐标仍是**页面百分比**（0–100），与 media / boxes 同一把尺子：换比例、放映、导出、PDF 全一致。
     字号用 em（相对 --rs-slide-fs）：预览里缩一档、打印时放大都跟着走，不用换算像素。
     认不出的字段一律丢掉（手写 deck 也改不歪），缺的按对象种类给一个能看的默认位。 */
  function num(v, lo, hi, dflt) {
    if (v == null || (typeof v === "string" && !v.trim())) return dflt;
    const n = typeof v === "number" ? v : Number(str(v).trim());
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(n * 100) / 100));
  }
  function colorOf(v) {
    const s = str(v).trim().toLowerCase();
    if (!s) return "";
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    if (COLOR_NAMES.indexOf(s) >= 0) return s;
    return "";
  }
  const OBJ_BOX = {
    text: { x: 8, y: 12, w: 52, h: 16 },
    image: { x: 12, y: 12, w: 46, h: 34 },
    video: { x: 12, y: 12, w: 52, h: 32 },
    shape: { x: 20, y: 24, w: 30, h: 16 },
  };
  function normalizeObjects(list) {
    const src = Array.isArray(list) ? list : [];
    const out = [];
    const used = new Set();
    for (let i = 0; i < src.length; i++) {
      const one = src[i];
      if (!one || typeof one !== "object") continue;
      const kind = OBJ_KINDS.indexOf(str(one.kind).trim()) >= 0 ? str(one.kind).trim() : "";
      if (!kind) continue;
      const d = OBJ_BOX[kind];
      let id = str(one.id).trim().replace(/[^\w.-]+/g, "-").slice(0, 48);
      if (!id) id = kind.charAt(0) + "-" + hashString(kind + ":" + i + ":" + str(one.text || one.src)).slice(0, 8);
      const obj = {
        id: uid(used, id),
        kind: kind,
        x: num(one.x, 0, 100, d.x),
        y: num(one.y, 0, 100, d.y),
        w: num(one.w, 1, 100, d.w),
        h: num(one.h, 1, 100, d.h),
        locked: !!one.locked,
        hidden: !!one.hidden,
      };
      if (kind === "text") {
        obj.text = str(one.text).slice(0, 2000);
        obj.size = num(one.size, 0.4, 8, 1.1);
        obj.color = colorOf(one.color);
        obj.bold = !!one.bold;
        obj.italic = !!one.italic;
        obj.align = TEXT_ALIGNS.indexOf(str(one.align).trim()) >= 0 ? str(one.align).trim() : "left";
        obj.line = num(one.line, 0.9, 3, 1.4);
        obj.shrink = one.shrink !== false; /* 框内自动缩字（Keynote 的「缩小文字以适合」） */
      } else if (kind === "shape") {
        obj.shape = SHAPES.indexOf(str(one.shape).trim()) >= 0 ? str(one.shape).trim() : "rect";
        obj.fill = colorOf(one.fill);
        obj.opacity = num(one.opacity, 0, 100, 100);
        obj.bw = num(one.bw, 0, 20, 0);
        obj.bc = colorOf(one.bc);
        obj.radius = num(one.radius, 0, 50, obj.shape === "round" ? 12 : 0);
        obj.shadow = !!one.shadow;
      } else {
        const s = mediaSrcOf(one.src);
        if (!s) continue;
        obj.src = s;
        obj.fit = OBJ_FITS.indexOf(str(one.fit).trim()) >= 0 ? str(one.fit).trim() : "contain";
        const crop = one.crop && typeof one.crop === "object" ? one.crop : {};
        obj.crop = {
          x: num(crop.x, -100, 100, 0),
          y: num(crop.y, -100, 100, 0),
          zoom: num(crop.zoom, 1, 4, 1),
        };
        obj.radius = num(one.radius, 0, 50, 0);
        /* 图 / 视频也能调不透明度（0–100，与形状同单位）：做背景图、压暗垫底都用得上 */
        obj.opacity = num(one.opacity, 0, 100, 100);
      }
      out.push(obj);
    }
    return out;
  }
  /* 自动版式 → 自由版面：把这一页此刻的内容拆成对象（编辑器量好 boxes 再递给它）。
     只搬「这一页已经有的东西」：眉题 / 标题 / 要点 / 引用 / 链接 / 媒体 —— 不新增一句文案。
     链接胶囊在自由版面里降级成一列纯文字（不再可点），因为自由版面没有「页」这个概念了。 */
  function freeFromPage(pg, boxes) {
    const p = pg && typeof pg === "object" ? pg : {};
    const b = boxes && typeof boxes === "object" ? boxes : {};
    const lead = b.lead || { x: 6, y: 6, w: 88 };
    const body = b.body || { x: 6, y: 34, w: 88 };
    const out = [];
    let leadY = num(lead.y, 0, 100, 6);
    if (p.kicker) {
      out.push({
        kind: "text",
        text: str(p.kicker),
        x: lead.x,
        y: leadY,
        w: lead.w,
        h: 5,
        size: 0.62,
        color: "accent",
        bold: true,
        line: 1.3,
      });
      leadY = num(leadY + 5.5, 0, 100, 11.5);
    }
    out.push({
      kind: "text",
      text: str(p.title) || "标题",
      x: lead.x,
      y: leadY,
      w: lead.w,
      h: 12,
      size: str(p.kind) === "cover" ? 2.2 : 1.9,
      color: "primary",
      bold: true,
      line: 1.24,
    });
    const lines = (Array.isArray(p.bullets) ? p.bullets : []).map((x) => "• " + str(x));
    if (p.quote) lines.push("“" + str(p.quote) + "”");
    if (lines.length) {
      out.push({
        kind: "text",
        text: lines.join("\n"),
        x: body.x,
        y: body.y,
        w: body.w,
        h: 34,
        size: 0.9,
        line: 1.6,
      });
    }
    const chips = (Array.isArray(p.links) ? p.links : []).map((l) => "· " + str(l && l.title)).filter((x) => x !== "· ");
    if (chips.length) {
      out.push({ kind: "text", text: chips.join("\n"), x: body.x, y: 84, w: body.w, h: 10, size: 0.6, color: "muted" });
    }
    for (const m of normalizeMedia(p.media)) {
      out.push({ kind: m.kind, src: m.src, x: m.x, y: m.y, w: m.w, h: m.h, fit: m.fit });
    }
    return normalizeObjects(out);
  }
  function normalizePatch(p) {
    const out = emptyPatch();
    const src = p && typeof p === "object" ? p : {};
    const ov = src.overlay && typeof src.overlay === "object" ? src.overlay : {};
    for (const id of Object.keys(ov)) {
      const one = ov[id];
      if (!one || typeof one !== "object") continue;
      const keep = {};
      for (const k of EDIT_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(one, k)) continue;
        if (k === "bullets") {
          keep.bullets = (Array.isArray(one.bullets) ? one.bullets : [str(one.bullets)])
            .map((x) => str(x).trim())
            .filter(Boolean);
        } else if (k === "layout") {
          const l = str(one.layout).trim();
          if (LAYOUTS.indexOf(l) >= 0) keep.layout = l;
        } else if (k === "media") {
          if (Array.isArray(one.media)) keep.media = normalizeMedia(one.media);
        } else if (k === "boxes") {
          const b = normalizeBoxes(one.boxes);
          if (b) keep.boxes = b;
        } else if (k === "free") {
          keep.free = !!one.free;
        } else if (k === "objects") {
          if (Array.isArray(one.objects)) keep.objects = normalizeObjects(one.objects);
        } else keep[k] = str(one[k]);
      }
      if (Object.keys(keep).length) out.overlay[str(id)] = keep;
    }
    out.order = uniq((Array.isArray(src.order) ? src.order : []).map((x) => str(x).trim()));
    out.hidden = uniq((Array.isArray(src.hidden) ? src.hidden : []).map((x) => str(x).trim()));
    /* 比例：只有真的填了才写进 patch（空 / 缺省 = 跟 deck 自带的比例） */
    if (str(src.aspect).trim()) out.aspect = normalizeAspect(src.aspect);
    /* 页面元素开关：只有用户关过某几项才写进 patch（全开 = 不写，老存档形状不变） */
    if (src.chrome && typeof src.chrome === "object" && !Array.isArray(src.chrome)) {
      const ch = normalizeChrome(src.chrome);
      if (CHROME_KEYS.some((k) => !ch[k])) out.chrome = ch;
    }
    return out;
  }
  /* 把手改盖回一份 deck：返回**新** deck（不改入参，便于「重新生成」前后对比） */
  function applyPatch(deck, patch) {
    const d = deck && typeof deck === "object" ? deck : { pages: [] };
    const p = normalizePatch(patch || d.patch);
    const hidden = new Set(p.hidden);
    const pages = (Array.isArray(d.pages) ? d.pages : []).map((pg) => {
      const one = Object.assign({}, pg);
      const ov = p.overlay[one.id];
      if (ov) {
        for (const k of EDIT_KEYS) if (Object.prototype.hasOwnProperty.call(ov, k)) one[k] = ov[k];
      }
      one.hidden = hidden.has(one.id);
      return one;
    });
    if (p.order.length) {
      const rank = new Map();
      p.order.forEach((id, i) => rank.set(id, i));
      const orig = new Map();
      pages.forEach((pg, i) => orig.set(pg.id, i));
      pages.sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return (orig.get(a.id) || 0) - (orig.get(b.id) || 0);
      });
    }
    const next = Object.assign({}, d, {
      pages: pages,
      patch: p,
      /* 页面比例是整份 deck 的（patch.aspect 有值就以它为准，空 = 内核给的那个） */
      aspect: p.aspect ? p.aspect : normalizeAspect(d.aspect),
    });
    return next;
  }
  /* 放映 / 导出要用的页：去掉隐藏页（页 id → 第几页，1 起始） */
  function visiblePages(deck) {
    return ((deck && deck.pages) || []).filter((pg) => !pg.hidden);
  }
  function pageIndexOf(deck, id) {
    const list = visiblePages(deck);
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return i + 1;
    return 0;
  }
  function pageById(deck, id) {
    for (const pg of (deck && deck.pages) || []) if (pg.id === id) return pg;
    return null;
  }

  /* ── brief：初始化时用户给的「额外指示」────────────────────────────────────
     作用面（务必与派单提示词一致）：只影响**叙事重组与节奏**（谁先说 / 说几件 / 停留多久），
     **不许新增**数字、结论、引文与文献 —— 原文没说的，一个字都不加。
     存放：slides/<slug>.json 的顶层 brief（与 theme / patch 同级），**不进 patch**（patch 只装手改）；
     全默认时 build() 不写这个键，老存档读进来 / 导出的 HTML 字节都不变。 */
  const BRIEF_VER = 1;
  const BRIEF_MODES = ["slides", "video", "both"];
  const BRIEF_MODE_LABEL = { slides: "静态演示", video: "视频", both: "两者都要" };
  const BRIEF_LANGS = ["zh", "en"];
  const BRIEF_LISTS_MAX = 12;
  const BRIEF_TEXT_MAX = 200;
  const BRIEF_EXTRA_MAX = 4000;
  const BRIEF_MAX_SEC = 3600;
  /* 页数下限：封面 + 大纲 + 结语（再少就不成一份演示了） */
  const MIN_PAGES = 3;
  /* 压缩顺序（只为凑时长砍页时）：文献 → 公式 → 术语；正文页永远不砍 */
  const PAGE_TRIM_ORDER = ["cites", "formula", "term"];
  const PACE_MIN = 0.75;
  const PACE_MAX = 1.35;
  const PACE_TOL = 0.1;

  function defaultBrief() {
    return {
      ver: BRIEF_VER,
      mode: "slides",
      audience: "",
      occasion: "",
      durationSec: 0,
      tone: "",
      focus: [],
      avoid: [],
      extra: "",
      lang: "zh",
      updatedAt: 0,
    };
  }
  function briefList(v) {
    const src = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
    const out = [];
    const seen = new Set();
    for (const x of src) {
      const s = clip(x, BRIEF_TEXT_MAX);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= BRIEF_LISTS_MAX) break;
    }
    return out;
  }
  /* 归一：缺项补默认（mode=slides、durationSec=0 即「自动」、extra 空），脏数据一律夹回来 */
  function normalizeBrief(v) {
    const s = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    const out = defaultBrief();
    out.mode = pickEnum(s.mode, BRIEF_MODES, "slides");
    out.audience = clip(s.audience, BRIEF_TEXT_MAX);
    out.occasion = clip(s.occasion, BRIEF_TEXT_MAX);
    out.durationSec = Math.round(numIn(s.durationSec, 0, 0, BRIEF_MAX_SEC));
    out.tone = clip(s.tone, BRIEF_TEXT_MAX);
    out.focus = briefList(s.focus);
    out.avoid = briefList(s.avoid);
    out.extra = str(s.extra).replace(/\r\n?/g, "\n").trim().slice(0, BRIEF_EXTRA_MAX);
    out.lang = pickEnum(s.lang, BRIEF_LANGS, "zh");
    out.updatedAt = Math.max(0, Math.round(numIn(s.updatedAt, 0, 0, 9007199254740991)));
    return out;
  }
  /* 是不是「一个字都没填」（全默认）：是就不写进 deck / 存档，形状与今天一致 */
  function briefIsDefault(v) {
    return JSON.stringify(normalizeBrief(v)) === JSON.stringify(defaultBrief());
  }
  /* 一份 deck 的 brief：没有这个键（老存档 / 没初始化过）= 全默认；顺手认手写 deck 塞在 patch 里的那份 */
  function briefOf(deck) {
    const d = deck && typeof deck === "object" ? deck : {};
    const raw = d.brief != null ? d.brief : d.patch && typeof d.patch === "object" ? d.patch.brief : null;
    return normalizeBrief(raw);
  }

  /* ── 视频侧的时长与页选取（纯算，不改 deck）──────────────────────────────
     静态版永远是全量 pages；这里只回答两件事：一页要停多久、目标时长下该留哪几页。 */
  function charLen(s) {
    return Array.from(str(s)).length;
  }
  /* 单页秒数（口径见 docs/research-slides-video-spec.md §5.1）：
     读的时间由字速算，要点之间留半拍，最后夹进 [minPageSec, maxPageSec]。 */
  function pageSecOf(pg, motion) {
    const m = motionArgOf(motion);
    const p = pg && typeof pg === "object" ? pg : {};
    const gap = 0.5 * (60 / m.bpm);
    const titleSec = Math.max(1.2, charLen(p.title) / m.cpsTitle);
    const bullets = Array.isArray(p.bullets) ? p.bullets : [];
    const each = bullets.map((b) => Math.max(1, charLen(b) / m.cpsBullet));
    let sum = 0;
    for (const v of each) sum += v;
    const quoteSec = str(p.quote).trim() ? 1.2 + charLen(p.quote) / (m.cpsBullet * 1.1) : 0;
    let sec;
    if (p.kind === "cover") sec = 2.2 + titleSec + 0.6;
    else if (p.kind === "toc") sec = 1.6 + 0.45 * bullets.length + 0.9;
    else if (p.kind === "end") sec = 2 + Math.max(1.6, sum) + 1;
    else sec = 1.2 + titleSec + each.length * gap + sum + quoteSec + 0.9;
    const lo = m.minPageSec;
    const hi = Math.max(lo, m.maxPageSec);
    return round2(Math.max(lo, Math.min(hi, sec)));
  }
  /* focus 命中（关键词出现在标题 / 眉题 / 要点里）：命中的页不被压缩掉 */
  function focusHit(pg, focus) {
    const words = Array.isArray(focus) ? focus : [];
    if (!words.length) return false;
    const p = pg && typeof pg === "object" ? pg : {};
    const hay = [p.title, p.kicker].concat(Array.isArray(p.bullets) ? p.bullets : []).join(" ").toLowerCase();
    for (const w of words) {
      const k = str(w).trim().toLowerCase();
      if (k && hay.indexOf(k) >= 0) return true;
    }
    return false;
  }
  /* planBrief(brief, pages, theme) → 目标页数区间 + 该留哪几页 + 节奏系数
       · pages 收页数组或整份 deck（隐藏页不算）；
       · durationSec = 0（自动）→ 不裁页、pace = 1；
       · 有目标时长 → 目标页数区间 ±1，超上限按 cites → formula → term 砍页（focus 命中的保留），
         砍完再按「目标 / 实得」算 pace（夹在 0.75–1.35，只乘读的时间，不乘入场帧数）；
       · **一个页都不从 deck 里删**：HTML / PDF / PNG 仍是全量，这份计划只喂视频时间轴；
       · 凑不齐就如实写在 note 里（不编过渡页、不编结论、不删事实）。 */
  function planBrief(brief, pages, theme) {
    const b = normalizeBrief(brief);
    const m = motionArgOf(theme);
    const src = Array.isArray(pages) ? pages : pages && Array.isArray(pages.pages) ? pages.pages : [];
    const list = src.filter((pg) => pg && typeof pg === "object" && !pg.hidden);
    const items = list.map((pg) => ({
      id: str(pg.id),
      kind: str(pg.kind),
      sec: pageSecOf(pg, m),
      keep: true,
      focus: focusHit(pg, b.focus),
    }));
    const n = items.length;
    let autoSec = 0;
    for (const it of items) autoSec += it.sec;
    autoSec = round2(autoSec);
    const all = items.map((it) => it.id);
    if (!n) {
      return {
        durationSec: b.durationSec,
        autoSec: 0,
        pageCount: 0,
        pace: 1,
        totalSec: 0,
        targetMin: 0,
        targetMax: 0,
        keep: [],
        drop: [],
        items: [],
        fits: !(b.durationSec > 0),
        note: "没有可排的页（先有主稿才有演示）",
      };
    }
    if (!(b.durationSec > 0)) {
      return {
        durationSec: 0,
        autoSec: autoSec,
        pageCount: n,
        pace: 1,
        totalSec: autoSec,
        targetMin: 0,
        targetMax: 0,
        keep: all,
        drop: [],
        items: items,
        fits: true,
        note: "目标时长自动：按内容 " + autoSec + " 秒（" + n + " 页）",
      };
    }
    const meanSec = autoSec / n;
    const floor = Math.min(MIN_PAGES, n);
    const want = Math.max(floor, Math.min(n, Math.round(b.durationSec / meanSec)));
    const targetMin = Math.max(floor, Math.min(n, want - 1));
    const targetMax = Math.max(targetMin, Math.min(n, want + 1));
    const kept = items.slice();
    for (const kind of PAGE_TRIM_ORDER) {
      if (kept.length <= targetMax) break;
      for (let i = kept.length - 1; i >= 0 && kept.length > targetMax; i--) {
        const it = kept[i];
        if (it.kind !== kind || it.focus) continue;
        it.keep = false;
        kept.splice(i, 1);
      }
    }
    let keptSec = 0;
    for (const it of kept) keptSec += it.sec;
    keptSec = round2(keptSec);
    const pace = round2(Math.max(PACE_MIN, Math.min(PACE_MAX, keptSec > 0 ? b.durationSec / keptSec : 1)));
    const totalSec = round2(keptSec * pace);
    const drop = items.filter((it) => !it.keep).map((it) => it.id);
    const fits = Math.abs(totalSec - b.durationSec) / b.durationSec <= PACE_TOL;
    let note;
    if (fits) {
      note =
        "目标 " + b.durationSec + " 秒 ≈ " + kept.length + " 页 × 均 " +
        round2(keptSec / Math.max(1, kept.length)) + " 秒（节奏系数 " + pace + "）";
    } else if (totalSec > b.durationSec) {
      note =
        "按全部内容最短 " + totalSec + " 秒，比目标多 " + round2(totalSec - b.durationSec) +
        " 秒（只压缩页数，不编内容）";
    } else {
      note =
        "按现有内容只到 " + totalSec + " 秒，比目标少 " + round2(b.durationSec - totalSec) +
        " 秒（不补编内容）";
    }
    return {
      durationSec: b.durationSec,
      autoSec: autoSec,
      pageCount: n,
      pace: pace,
      totalSec: totalSec,
      targetMin: targetMin,
      targetMax: targetMax,
      keep: kept.map((it) => it.id),
      drop: drop,
      items: items,
      fits: fits,
      note: note,
    };
  }

  /* ── 页构造 ───────────────────────────────────────────────────────────── */
  function page(spec) {
    const s = spec || {};
    const out = {
      id: str(s.id),
      kind: PAGE_KINDS.indexOf(str(s.kind)) >= 0 ? str(s.kind) : "section",
      title: str(s.title),
      kicker: str(s.kicker),
      bullets: (Array.isArray(s.bullets) ? s.bullets : []).map((x) => str(x)).filter(Boolean),
      quote: str(s.quote),
      term: s.term && typeof s.term === "object" ? s.term : null,
      formula: str(s.formula),
      note: str(s.note),
      links: Array.isArray(s.links) ? s.links : [],
      layout: LAYOUTS.indexOf(str(s.layout)) >= 0 ? str(s.layout) : "body",
      media: normalizeMedia(s.media),
      boxes: normalizeBoxes(s.boxes),
      /* 自由版面：free = 这一页被「转为自由版面」过（对象全删光也还是自由页，是块空画布） */
      free: !!s.free,
      objects: normalizeObjects(s.objects),
      part: Number(s.part) > 0 ? Number(s.part) : 1,
      hidden: !!s.hidden,
      src: { path: normRel((s.src && s.src.path) || ""), line: Number((s.src && s.src.line) || 1) || 1 },
    };
    /* scene 只在真给了才出现：没有 3D 场景的页与老存档的页形状完全一致（导出字节不变） */
    const scene = SCENES.indexOf(str(s.scene)) > 0 ? str(s.scene) : "";
    if (scene) out.scene = scene;
    return out;
  }
  /* 页 id：kind + 来源（路径 / 行号 / 标题）→ 稳定、可读，overlay 才认得住 */
  function makeId(kind, seed) {
    const plain = str(seed).replace(/[\\/:|]+/g, "-").replace(/\s+/g, "-");
    const tail = slugify(plain) || hashString(plain);
    return kind + "-" + tail.slice(0, 48);
  }
  function uid(used, base) {
    let id = base;
    let i = 2;
    while (used.has(id)) {
      id = base + "-" + i;
      i++;
    }
    used.add(id);
    return id;
  }
  /* 链接项：页面内出现的一个可点记号（双链 / 术语 / 引用 / 公式 / deck 里的页） */
  function linkItem(spec) {
    const s = spec || {};
    return {
      kind: str(s.kind) || "link",
      title: str(s.title),
      target: str(s.target || s.title),
      page: str(s.page),
      count: Number(s.count) || 0,
      hits: Array.isArray(s.hits) ? s.hits.slice(0, HIT_MAX) : [],
    };
  }
  /* 命中合并：同一个文件只留一条（次数相加），顺序按次数降序 */
  function mergeHits(list) {
    const by = new Map();
    for (const h of list || []) {
      if (!h || !h.path) continue;
      const old = by.get(h.path);
      if (old) old.count = (old.count || 0) + (h.count || 0);
      else by.set(h.path, Object.assign({}, h));
    }
    const out = [...by.values()];
    out.sort((a, b) => (b.count || 0) - (a.count || 0) || a.path.localeCompare(b.path));
    return out.slice(0, HIT_MAX);
  }
  /* 同名笔记（双链点开后能直接进的那一页）：标题或文件名同名的笔记 */
  function noteByTitle(notes, name) {
    const want = str(name).trim();
    if (!want) return null;
    for (const n of notes || []) {
      const stem = baseName(n.path).replace(/\.[a-z0-9]+$/i, "");
      if (n.title === want || stem === want || stem === slugify(want)) return n;
    }
    return null;
  }
  /* 一页正文里的可点记号：双链 + 引用 + 命中的术语。
     page 只放「deck 里已收录的页 id」（术语页 / 文献页）；没有专页就留空，
     由视图按「库里 N 篇写过它」列出 hits —— 绝不拿笔记路径冒充页 id。 */
  function linksOfSections(text, opts) {
    const o = opts || {};
    const termPages = o.termPages || {};
    const out = [];
    const seen = new Set();
    const push = (item) => {
      const k = item.kind + "\u0000" + item.target;
      if (!item.title || seen.has(k)) return;
      seen.add(k);
      out.push(item);
    };
    for (const w of wikilinksOf(text)) {
      const name = w.target;
      if (!name) continue;
      const own = noteByTitle(o.notes, name);
      const ownHit = own
        ? [{ path: own.path, title: own.title, line: 1, angle: angleOf(own.meta), count: 1 }]
        : [];
      push(
        linkItem({
          kind: "link",
          title: w.alias || name,
          target: name,
          page: termPages[name] || "",
          hits: mergeHits(ownHit.concat(hitsOf(o.notes, "term", [name]))),
        }),
      );
      if (out.length >= LINK_MAX) return out;
    }
    for (const c of citesOf(text)) {
      if (!c.key) continue;
      push(
        linkItem({
          kind: "cite",
          title: "@" + c.key,
          target: c.key,
          page: o.citesPage || "",
          hits: hitsOf(o.notes, "cite", [c.key]),
        }),
      );
      if (out.length >= LINK_MAX) return out;
    }
    const terms = o.terms || {};
    for (const name of Object.keys(terms)) {
      if (countIn(text, name) <= 0) continue;
      push(
        linkItem({
          kind: "term",
          title: name,
          target: name,
          page: termPages[name] || "",
          count: Number(terms[name] && terms[name].uses) || 0,
          hits: hitsOf(o.notes, "term", [name]),
        }),
      );
      if (out.length >= LINK_MAX) return out;
    }
    return out;
  }

  /* ── 主入口：核心原文 + 3-Pass 变体 → deck ────────────────────────────────
     opts.patch 传上一份存档的 patch 就会把这些手改盖回去（结果里的 patch 也一并带回）。 */
  function build(input) {
    const o = input && typeof input === "object" ? input : {};
    const notes = (Array.isArray(o.notes) ? o.notes : []).map(normalizeNote).filter(Boolean);
    const meta = o.meta && typeof o.meta === "object" ? o.meta : {};
    const lib = Array.isArray(o.lib) ? o.lib : [];
    const corePath = normRel(o.corePath || meta.corePath || "notes/00-课题.md");
    const core = notes.filter((n) => n.path === corePath)[0] || notes.filter((n) => /^notes\//.test(n.path))[0] || null;
    const title = str(o.title) || str(meta.title) || (core && core.title) || "研究演示";
    const slug = str(o.slug) || slugify(title) || "slides";
    const date = str(o.date) || isoDate(o.now);
    const theme = normalizeTheme(Object.assign({ transition: o.transition }, o.theme || {}));
    /* brief：宿主从存档里读出来的那份（老存档没有就是全默认）；手写 deck 塞在 patch 里的也认 */
    const brief = normalizeBrief(o.brief != null ? o.brief : o.patch && typeof o.patch === "object" ? o.patch.brief : null);
    const used = new Set();
    const pages = [];

    /* 主稿的节 / 正文（没有主稿就只剩封面 + 结语，绝不假装有内容） */
    const docSplit = core ? splitSections(core.md) : { meta: {}, offset: 0, title: "", sections: [] };
    const coreText = core ? parseDoc(core.md).body : "";
    const terms = termIndexOf(notes);
    const formulas = core ? formulaIndexOf(core.md) : [];
    const citations = core ? citeIndexOf(core.md) : [];
    /* 术语页 / 文献页的 id 先排定：正文页的链接（「跳到第 N 页」）要在建页时就知道指向谁 */
    const termPlan = planTerms(terms, coreText);
    const termPages = {};
    for (const rec of termPlan.list) termPages[rec.name] = uid(used, makeId("term", rec.name));
    const citeKeys = uniq(citations.map((c) => c.key));
    const citesId = citeKeys.length ? uid(used, "p-cites") : "";

    /* ① 封面：课题 / 标题 / 日期 */
    pages.push(
      page({
        id: uid(used, "p-cover"),
        kind: "cover",
        title: (core && core.title) || str(meta.title) || title,
        kicker: str(meta.title) || title,
        note: "",
        src: { path: core ? core.path : corePath, line: 1 },
      }),
    );

    /* ② 主稿：H2 切页，H3 另起一页；单节超长按段落续页 */
    const sectionPages = [];
    for (const sec of docSplit.sections) {
      const blocks = blocksOf(sec.lines);
      const bullets = bulletsOf(blocks, 999);
      if (!bullets.length && !quoteOf(blocks)) continue;
      const chunks = [];
      for (let i = 0; i < bullets.length; i += MAX_BULLETS) chunks.push(bullets.slice(i, i + MAX_BULLETS));
      if (!chunks.length) chunks.push([]);
      const capped = chunks.slice(0, MAX_PART_PAGES);
      for (let pi = 0; pi < capped.length; pi++) {
        const seed = sec.level + ":" + sec.heading + ":" + (sec.heading ? sec.line : 1) + ":" + pi;
        const id = uid(used, makeId("sec", seed));
        const pg = page({
          id: id,
          kind: "section",
          title: sec.heading || (core && core.title) || title,
          kicker: sec.level === 3 ? sec.parent : pi > 0 ? "续 " + (pi + 1) + "/" + capped.length : "",
          bullets: capped[pi],
          quote: pi === 0 ? quoteOf(blocks) : "",
          part: pi + 1,
          links: [],
          src: { path: core.path, line: sec.line },
        });
        pg.links = linksOfSections(sec.lines.map((l) => l.text).join("\n"), {
          notes: notes,
          terms: terms,
          termPages: termPages,
          citesPage: citesId,
        });
        sectionPages.push(pg);
        pages.push(pg);
      }
    }

    /* ③ 大纲：主稿小节标题成条，每条链到那一页（续页不另占一条；这一页排第 2 位，最后再插进去） */
    const tocPages = sectionPages.filter((pg) => pg.part === 1);
    const tocPage = page({
      id: uid(used, "p-toc"),
      kind: "toc",
      title: "大纲",
      kicker: str(meta.title) || title,
      bullets: tocPages.map((pg) => (pg.kicker ? pg.kicker + " › " + pg.title : pg.title)),
      links: tocPages.map((pg) => linkItem({ kind: "page", title: pg.title, target: pg.id, page: pg.id })),
      src: { path: core ? core.path : corePath, line: 1 },
    });

    /* ④ 3-Pass 变体：略读 / 关键概念 / 技术细节 各 1–2 页（要点原样取，不总结） */
    const variants = variantDocsOf(o, notes, corePath);
    for (const v of variants) {
      const split = splitSections(v.doc.md);
      const parts = split.sections.filter((s) => s.lines.some((l) => str(l.text).trim()));
      const picked = parts.length ? parts.slice(0, 2) : [];
      if (!picked.length) {
        /* 没有任何小节标题的变体稿：整篇按段落取要点（不硬造标题） */
        const vdoc = parseDoc(v.doc.md);
        const vlines = vdoc.body.split("\n").map((text, i) => ({ text: text, line: vdoc.offset + i + 1 }));
        const blocks = blocksOf(vlines);
        const pg = page({
          id: uid(used, makeId("pass3", v.rule.id + ":" + v.doc.path)),
          kind: "pass3",
          title: v.rule.label,
          kicker: "3-Pass",
          bullets: bulletsOf(blocks, MAX_BULLETS),
          quote: quoteOf(blocks),
          links: [],
          src: { path: v.doc.path, line: 1 },
        });
        pages.push(pg);
        continue;
      }
      for (const sec of picked) {
        const blocks = blocksOf(sec.lines);
        const pg = page({
          id: uid(used, makeId("pass3", v.rule.id + ":" + v.doc.path + ":" + (sec.heading || "") + ":" + sec.line)),
          kind: "pass3",
          title: sec.heading || v.rule.label,
          kicker: "3-Pass · " + v.rule.label,
          bullets: bulletsOf(blocks, MAX_BULLETS),
          quote: quoteOf(blocks),
          links: linksOfSections(sec.lines.map((l) => l.text).join("\n"), {
            notes: notes,
            terms: terms,
            termPages: termPages,
            citesPage: citesId,
          }),
          src: { path: v.doc.path, line: sec.line },
        });
        pages.push(pg);
      }
    }

    /* ⑤ 术语页：正文与双链命中的术语，按被引次数取前 N（一页一个） */
    for (const rec of termPlan.list) {
      const defLines = str(rec.def)
        .split(/(?<=[。；;!?！？])\s*|\n+/)
        .map((x) => clip(inlineText(x), MAX_BULLET_CHARS))
        .filter(Boolean)
        .slice(0, 3);
      pages.push(
        page({
          id: termPages[rec.name],
          kind: "term",
          title: rec.name,
          kicker: "术语",
          bullets: defLines,
          note: rec.angle ? "方向：" + rec.angle : "",
          term: { name: rec.name, def: rec.def, path: rec.path, line: rec.line, uses: rec.uses },
          links: [
            linkItem({
              kind: "term",
              title: rec.name,
              target: rec.name,
              page: "",
              count: rec.uses,
              hits: hitsOf(notes, "term", [rec.name]),
            }),
          ],
          src: { path: rec.path, line: rec.line },
        }),
      );
    }

    /* ⑥ 公式页：主稿正文里的公式，TeX 原样进页（一页一条，先展示式后行内式；
       同一条式子只出一页，单字符的 $x$ 这类不进演示） */
    const seenTex = new Set();
    const formulaPicks = formulas
      .slice()
      .sort((a, b) => (b.display ? 1 : 0) - (a.display ? 1 : 0) || a.line - b.line)
      .filter((f) => {
        const tex = str(f.tex).trim();
        if (tex.length < 2 || seenTex.has(tex)) return false;
        seenTex.add(tex);
        return true;
      })
      .slice(0, FORMULA_MAX);
    formulaPicks.forEach((f, i) => {
      const context = formulaContextOf(core ? core.md : "", f.line);
      pages.push(
        page({
          id: uid(used, makeId("formula", f.tex.slice(0, 60) + ":" + f.line)),
          kind: "formula",
          title: "公式 " + (i + 1),
          kicker: f.display ? "展示公式" : "行内公式",
          formula: f.tex,
          bullets: context ? [context] : [],
          links: [],
          src: { path: core ? core.path : corePath, line: f.line },
        }),
      );
    });

    /* ⑦ 文献引用页：[@citekey] 一页列全（有文献库就补题名 / 年份） */
    if (citeKeys.length) {
      const bullets = citeKeys.slice(0, 12).map((k) => {
        const item = libItemOf(lib, k);
        const n = citations.filter((c) => c.key === k).length;
        const label = item ? str(item.title || item.name) : "";
        const year = item ? yearOfItem(item) : "";
        return "@" + k + (label ? " — " + label : "") + (year ? "（" + year + "）" : "") + (n > 1 ? " ×" + n : "");
      });
      pages.push(
        page({
          id: citesId,
          kind: "cites",
          title: "文献引用",
          kicker: citeKeys.length + " 个引用键",
          bullets: bullets,
          links: citeKeys.slice(0, LINK_MAX).map((k) =>
            linkItem({ kind: "cite", title: "@" + k, target: k, page: citesId, hits: hitsOf(notes, "cite", [k]) }),
          ),
          src: { path: core ? core.path : corePath, line: citations[0].line || 1 },
        }),
      );
    }
    /* ⑧ 结语：只报计数，不写没出处的结论 */
    const visible = pages.filter((pg) => pg.kind === "section").length;
    pages.push(
      page({
        id: uid(used, "p-end"),
        kind: "end",
        title: "结语",
        kicker: str(meta.title) || title,
        bullets: [
          "主稿 " +
            visible +
            " 页 · 精读 " +
            pages.filter((pg) => pg.kind === "pass3").length +
            " 页 · 术语 " +
            termPlan.list.length +
            " 个 · 公式 " +
            formulaPicks.length +
            " 条 · 文献 " +
            citeKeys.length +
            " 篇",
        ],
        src: { path: core ? core.path : corePath, line: 1 },
      }),
    );

    /* 封面 → 大纲 → 其余（顺序就是放映顺序） */
    const ordered = [pages[0], tocPage].concat(pages.slice(1));

    const deck = {
      ver: VER,
      slug: slug,
      title: title,
      date: date,
      core: core ? core.path : corePath,
      theme: theme,
      transition: theme.transition,
      aspect: normalizeAspect(o.aspect || (meta && meta.aspect)),
      pages: ordered,
      themePresets: presetsForDeck(),
      patch: normalizePatch(o.patch),
      builtAt: Number(o.now) || Date.now(),
    };
    /* brief 只在「真的填过」时才写进 deck：老存档读进来、导出的 HTML 字节都不变。
       页数与页序**不受 brief 影响**（裁剪是视频侧的计划，见 planBrief —— 静态版永远全量）。 */
    if (!briefIsDefault(brief)) deck.brief = brief;
    const out = applyPatch(deck, deck.patch);
    /* 档位与联网补料只在这两样**非缺省**时出现：缺省 = 今天的行为（确定性直出、不联网），
       老存档读进来 / 导出的 HTML 字节都不变。author = 页由演示稿（slides/<slug>.script.md）编来。
       online 的缺省是「开」（初始化卡默认勾上），所以**只有关掉时才写 online:false**。 */
    if (str(o.tier) === "author" || str(o.tier) === "direct") out.tier = str(o.tier);
    if (o.online === false) out.online = false;
    return out;
  }

  /* ── 演示稿（Markdown）→ 页：创作档的单一真源 ──────────────────────────────
     格式口径只写在 docs/research-slides-video-spec.md §9（本处注释只是摘要）：
       <!-- mtnode-slides-script v1 -->      可选首行标记（不认也行）
       # 演示标题                            可选：deck 标题（缺省取封面页标题）
       ## 01 页标题 {kind}                   每页一节；序号可有可无；{kind} 缺省按位置给
       > 眉题                                标题后第一个引用块 = 眉题（kicker）
       - 要点                                列表项 / 普通段落 = 要点（[@cite] / [[wiki]] 原样留）
       > 引用                                之后的引用块 = quote
       $$ E = mc^2 $$                        公式（也认单行 $…$）
       <!-- note: 旁白 -->                   旁白（也认「旁白：」开头的行）
       <!-- scene: orbit -->                 3D 场景（orbit / grid / signal）
     解析不出来（没有 `## ` 分页）就返回 pages: []，调用方回落确定性直切，绝不假装成功。 */
  const SCRIPT_HEAD = /^<!--\s*mtnode-slides-script\b[^>]*-->\s*$/i;
  const SCRIPT_PAGE = /^##[ \t]+(.+?)[ \t]*$/;
  const SCRIPT_KIND_TAG = /\{([a-z0-9_]+)\}\s*$/i;
  const SCRIPT_NO = /^(?:\d{1,3}[.)、:：][ \t]*|第[一二三四五六七八九十百零\d]+[页节][ \t]*)/;
  const SCRIPT_MAX_PAGES = 80;
  function scriptMetaLine(line, key) {
    const re = new RegExp("^<!--\\s*(?:" + key + ")\\s*[:：]\\s*([\\s\\S]*?)\\s*-->$", "i");
    const m = re.exec(str(line).trim());
    return m ? m[1].trim() : "";
  }
  function scriptKindOf(title, index, total) {
    const m = SCRIPT_KIND_TAG.exec(title);
    const raw = m ? m[1].toLowerCase() : "";
    if (m) return { title: title.slice(0, m.index).trim(), kind: raw, explicit: true };
    if (index === 0) return { title: title, kind: "cover", explicit: false };
    if (index === total - 1 && total >= 3) return { title: title, kind: "end", explicit: false };
    return { title: title, kind: "section", explicit: false };
  }
  /* 演示稿 → { title, pages:[{kind,title,kicker,bullets,quote,formula,note,scene,line}] }（纯数据，不建页） */
  function parseScript(md, opts) {
    const o = opts || {};
    const doc = parseDoc(str(md));
    const lines = doc.body.split("\n");
    const raw = [];
    let cur = null;
    let deckTitle = "";
    let quoteUsed = false;
    const pushCur = () => {
      if (!cur) return;
      raw.push(cur);
      cur = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      const lineNo = doc.offset + i + 1;
      const t = text.trim();
      if (!t) continue;
      if (SCRIPT_HEAD.test(t)) continue;
      /* H1：deck 标题（页内出现时当要点，不吞字） */
      if (/^#[ \t]+/.test(t) && !cur) {
        deckTitle = deckTitle || inlineText(t.replace(/^#[ \t]+/, ""));
        continue;
      }
      if (SCRIPT_PAGE.test(t)) {
        pushCur();
        cur = { title: "", kicker: "", bullets: [], quote: "", formula: "", note: "", scene: "", line: lineNo, raw: [] };
        cur.title = t.replace(/^##[ \t]+/, "");
        quoteUsed = false;
        continue;
      }
      if (!cur) continue; /* `## ` 之前的自由段落不进页（可能是说明文字） */
      const note = scriptMetaLine(t, "note|旁白");
      if (note) { cur.note = cur.note ? cur.note + " " + note : note; continue; }
      const scene = scriptMetaLine(t, "scene");
      if (scene) { if (SCENES.indexOf(scene.toLowerCase()) > 0) cur.scene = scene.toLowerCase(); continue; }
      if (/^<!--[\s\S]*-->$/.test(t)) continue; /* 其它注释：不进页 */
      /* 原文行留一份：links（双链 / 引用 / 术语）要从**未剥离标记**的文本里抽，
         要点本身走 inlineText（展示时不该露 [[ ]] 源码）。 */
      cur.raw.push(t);
      const noteInline = /^(?:旁白|note)\s*[:：]\s*(.+)$/.exec(t);
      if (noteInline) { cur.note = cur.note ? cur.note + " " + noteInline[1] : noteInline[1]; continue; }
      const display = /^\$\$([\s\S]+?)\$\$$/.exec(t);
      if (display) { cur.formula = cur.formula || display[1].trim(); continue; }
      const inline = /^\$([^$\n]+)\$$/.exec(t);
      if (inline) { cur.formula = cur.formula || inline[1].trim(); continue; }
      /* H3 及以下：当成该页的一条要点（不丢字，也不新造层级） */
      if (/^#{3,6}[ \t]+/.test(t)) {
        const sub = inlineText(t.replace(/^#{3,6}[ \t]+/, ""));
        if (sub) cur.bullets.push(sub);
        continue;
      }
      if (/^\s*[-*+][ \t]+/.test(text)) {
        const item = clip(inlineText(text.replace(/^\s*[-*+][ \t]+/, "")), MAX_BULLET_CHARS);
        if (item) cur.bullets.push(item);
        continue;
      }
      if (/^\s*\d+[.)][ \t]+/.test(text)) {
        const item = clip(inlineText(text.replace(/^\s*\d+[.)][ \t]+/, "")), MAX_BULLET_CHARS);
        if (item) cur.bullets.push(item);
        continue;
      }
      if (/^\s*>/.test(t)) {
        const q = clip(inlineText(t.replace(/^>\s?/, "")), MAX_BULLET_CHARS);
        if (!q) continue;
        if (!quoteUsed && !cur.bullets.length && !cur.formula && !cur.quote) { cur.kicker = q; quoteUsed = true; }
        else cur.quote = cur.quote ? cur.quote + " " + q : q;
        continue;
      }
      const para = clip(inlineText(t), MAX_BULLET_CHARS);
      if (para) cur.bullets.push(para);
    }
    pushCur();
    const total = raw.length;
    const pages = [];
    for (let i = 0; i < total && pages.length < SCRIPT_MAX_PAGES; i++) {
      const it = raw[i];
      const bare = SCRIPT_NO.test(it.title.trim()) ? { title: it.title.trim().replace(SCRIPT_NO, "") } : { title: it.title.trim() };
      const withKind = scriptKindOf(bare.title, i, total);
      if (PAGE_KINDS.indexOf(withKind.kind) < 0) withKind.kind = "section";
      const title = withKind.title || "第 " + (i + 1) + " 页";
      const pg = {
        kind: withKind.kind,
        title: title,
        kicker: str(it.kicker),
        bullets: (it.bullets || []).slice(0, MAX_BULLETS * 2),
        quote: str(it.quote),
        formula: str(it.formula),
        note: str(it.note),
        scene: str(it.scene),
        text: (it.raw || []).join("\n"),
        line: it.line,
      };
      pages.push(pg);
    }
    const headTitle = pages.filter((p) => p.kind === "cover")[0] || pages[0] || null;
    return {
      ok: pages.length > 0,
      title: deckTitle || (headTitle ? headTitle.title : ""),
      path: normRel(o.path || ""),
      pages: pages,
      pageCount: pages.length,
    };
  }
  /* 演示稿 → 整份 deck：主题 / 比例 / patch / brief 与直切档同一套（只换页的来源）。
     返回 null = 演示稿里一页都解析不出来（调用方回落 build()，不抛错）。 */
  function buildFromScript(input) {
    const o = input && typeof input === "object" ? input : {};
    const scriptPath = normRel(o.scriptPath || o.path || "");
    const parsed = parseScript(str(o.script != null ? o.script : o.md), { path: scriptPath });
    if (!parsed.pages.length) return null;
    const meta = o.meta && typeof o.meta === "object" ? o.meta : {};
    const notes = (Array.isArray(o.notes) ? o.notes : []).map(normalizeNote).filter(Boolean);
    const terms = termIndexOf(notes);
    /* 标题以脚本周第一行 `#` 为准；研究标题只是兜底 */
    const title = str(o.title) || parsed.title || str(meta.title) || "研究演示";
    const slug = str(o.slug) || slugify(title) || "slides";
    const theme = normalizeTheme(Object.assign({ transition: o.transition }, o.theme || {}));
    const brief = normalizeBrief(o.brief != null ? o.brief : null);
    const used = new Set();
    const pages = [];
    for (let i = 0; i < parsed.pages.length; i++) {
      const s = parsed.pages[i];
      const pg = page({
        id: uid(used, makeId("pg", String(i + 1).padStart(2, "0") + ":" + s.title)),
        kind: s.kind,
        title: s.title,
        kicker: s.kicker,
        bullets: s.bullets,
        quote: s.quote,
        formula: s.formula,
        note: s.note,
        scene: s.scene,
        links: linksOfSections(
          (str(s.text) || [s.title, s.kicker, s.quote].concat(s.bullets).join("\n")),
          { notes: notes, terms: terms, termPages: {}, citesPage: "" },
        ),
        src: { path: scriptPath || str(meta.corePath) || "", line: s.line },
      });
      pages.push(pg);
    }
    const deck = {
      ver: VER,
      slug: slug,
      title: title,
      date: str(o.date) || isoDate(o.now),
      core: str(o.corePath) || str(meta.corePath) || scriptPath,
      theme: theme,
      transition: theme.transition,
      aspect: normalizeAspect(o.aspect || (meta && meta.aspect)),
      pages: pages,
      themePresets: presetsForDeck(),
      patch: normalizePatch(o.patch),
      builtAt: Number(o.now) || Date.now(),
      tier: "author",
      script: { path: scriptPath, pages: pages.length, at: Number(o.now) || Date.now() },
    };
    if (!briefIsDefault(brief)) deck.brief = brief;
    if (o.online === false) deck.online = false;
    return applyPatch(deck, deck.patch);
  }
  /* deck 里带的那份预设表：**不含 motion**（motion 只给视频侧；带上它导出的 HTML 字节就变了） */
  function presetsForDeck() {
    return THEME_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      desc: p.desc,
      light: JSON.parse(JSON.stringify(p.light)),
      dark: JSON.parse(JSON.stringify(p.dark)),
    }));
  }

  /* 术语排序：正文出现次数 ×2 + 双链指向 ×3 + 写过它的篇数；取前 TERM_MAX 个 */
  function planTerms(terms, coreText) {
    const recs = Object.keys(terms || {}).map((name) => {
      const rec = terms[name];
      const inText = countIn(coreText, name);
      const wl = wikilinksOf(coreText).filter((w) => w.target === name).length;
      return Object.assign({}, rec, { inText: inText, wl: wl, uses: inText + wl });
    });
    recs.sort((a, b) => b.uses - a.uses || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));
    return { list: recs.filter((r) => r.uses > 0).slice(0, TERM_MAX), all: recs };
  }
  /* 同名笔记（双链点开后能直接进的那一页）：标题或文件名同名的笔记 */
  /* 公式所在那一段（作为公式页的一句上下文，原样取，不改写） */
  function formulaContextOf(md, line) {
    const doc = parseDoc(md);
    const lines = doc.body.split("\n");
    const idx = Math.max(0, Math.min(lines.length - 1, Number(line) - doc.offset - 1));
    let from = idx;
    let to = idx;
    while (from > 0 && str(lines[from - 1]).trim()) from--;
    while (to < lines.length - 1 && str(lines[to + 1]).trim()) to++;
    const text = lines
      .slice(from, to + 1)
      .map((l) => str(l).replace(/^\s*>\s?/, "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\$\$[\s\S]+?\$\$/g, "")
      .replace(/\$[^$\n]+?\$/g, "");
    return clip(inlineText(text), MAX_BULLET_CHARS);
  }
  function libItemOf(lib, key) {
    for (const it of lib || []) if (str(it && (it.citeKey || it.id)) === str(key)) return it;
    return null;
  }
  function yearOfItem(it) {
    const d = it && (it.issued && it.issued["date-parts"] ? it.issued["date-parts"][0] : null);
    if (Array.isArray(d) && d.length) return str(d[0]);
    return str(it && (it.year || it.date));
  }

  /* 3-Pass 变体文档：优先按 versions 组（唯一口径）取成员，没有组就按后缀同名文件找 */
  function variantDocsOf(o, notes, corePath) {
    const src = (Array.isArray(o.rules) && o.rules.length ? o.rules : PASS3_DEFAULT).map((r) => ({
      id: str(r.id || r.derived || r.suffix),
      label: str(r.label || r.id || r.derived),
      derived: str(r.derived || r.id),
      suffix: str(r.suffix || r.derived || r.id),
      hint: str(r.hint),
    }));
    const groups = Array.isArray(o.groups) ? o.groups : [];
    const key = stripExt(corePath);
    const group = groups.filter((g) => g && (normRel(g.key) === key || normRel(g.base) === normRel(corePath)))[0] || null;
    const out = [];
    for (const rule of src) {
      const want = key + "." + rule.suffix + ".md";
      let doc = null;
      if (group && Array.isArray(group.members)) {
        const mem = group.members.filter(
          (m) => m && (str(m.kind) === rule.id || str(m.path) === want),
        )[0];
        if (mem) doc = notes.filter((n) => n.path === normRel(mem.path))[0] || null;
      }
      if (!doc) doc = notes.filter((n) => n.path === want)[0] || null;
      if (!doc) continue;
      out.push({ rule: rule, doc: doc });
    }
    return out;
  }

  /* 存在的演示存档路径（宿主读 / 写都用这两个，别在别处拼字符串） */
  function fileOf(slug) {
    const s = str(slug) || "slides";
    return STORE_DIR + "/" + s + ".json";
  }
  function exportOf(slug) {
    const s = str(slug) || "slides";
    return EXPORT_DIR + "/" + s + "/" + s + ".html";
  }

  return {
    VER: VER,
    STORE_DIR: STORE_DIR,
    EXPORT_DIR: EXPORT_DIR,
    PAGE_KINDS: PAGE_KINDS,
    KIND_LABEL: KIND_LABEL,
    TRANSITIONS: TRANSITIONS,
    TRANSITION_LABEL: TRANSITION_LABEL,
    LAYOUTS: LAYOUTS,
    MODES: MODES,
    ASPECTS: ASPECTS,
    ASPECT_AR: ASPECT_AR,
    ASPECT_LABEL: ASPECT_LABEL,
    OBJ_KINDS: OBJ_KINDS,
    OBJ_FITS: OBJ_FITS,
    SHAPES: SHAPES,
    SHAPE_LABEL: SHAPE_LABEL,
    TEXT_ALIGNS: TEXT_ALIGNS,
    COLOR_NAMES: COLOR_NAMES,
    EDIT_KEYS: EDIT_KEYS,
    THEME_PRESETS: THEME_PRESETS,
    FONTS: FONTS,
    RADIUS: RADIUS,
    RADIUS_LABEL: RADIUS_LABEL,
    SHADOW: SHADOW,
    SHADOW_LABEL: SHADOW_LABEL,
    PASS3_DEFAULT: PASS3_DEFAULT,
    MAX_BULLETS: MAX_BULLETS,
    TERM_MAX: TERM_MAX,
    FORMULA_MAX: FORMULA_MAX,
    /* 主入口 */
    build: build,
    buildDeck: build,
    /* 创作档：演示稿（Markdown）→ 页 → deck（演示稿是单一真源，页由它编来） */
    parseScript: parseScript,
    buildFromScript: buildFromScript,
    SCRIPT_MAX_PAGES: SCRIPT_MAX_PAGES,
    /* 3D 场景（视频侧 three.js 渲染；静态版看静帧） */
    SCENES: SCENES,
    SCENE_LABEL: SCENE_LABEL,
    /* patch：手改 / 拖排 / 隐藏 */
    emptyPatch: emptyPatch,
    normalizePatch: normalizePatch,
    applyPatch: applyPatch,
    /* 页面元素开关（页脚三段 / 封面日期 / 眉题） */
    CHROME_KEYS: CHROME_KEYS,
    CHROME_LABEL: CHROME_LABEL,
    normalizeChrome: normalizeChrome,
    chromeOf: chromeOf,
    /* 自由版面（对象表） */
    normalizeAspect: normalizeAspect,
    normalizeObjects: normalizeObjects,
    freeFromPage: freeFromPage,
    visiblePages: visiblePages,
    pageIndexOf: pageIndexOf,
    pageById: pageById,
    /* 主题（只出变量表） */
    normalizeTheme: normalizeTheme,
    themeOf: normalizeTheme,
    themeVars: themeVars,
    cssVars: cssVars,
    presetOf: presetOf,
    /* 动效 / 统一风格 token（静态版与视频版共用这一份） */
    FPS: FPS,
    EASES: EASES,
    ENTERS: ENTERS,
    MOTION_BGS: MOTION_BGS,
    MOTION_DEFAULT: MOTION_DEFAULT,
    MIN_PAGE_SEC: MIN_PAGE_SEC,
    MAX_PAGE_SEC: MAX_PAGE_SEC,
    normalizeMotion: normalizeMotion,
    motionOf: motionOf,
    styleTokens: styleTokens,
    /* brief：初始化时的额外指示（只影响重组与节奏，不新增事实） */
    BRIEF_MODES: BRIEF_MODES,
    BRIEF_MODE_LABEL: BRIEF_MODE_LABEL,
    BRIEF_LISTS_MAX: BRIEF_LISTS_MAX,
    BRIEF_EXTRA_MAX: BRIEF_EXTRA_MAX,
    BRIEF_MAX_SEC: BRIEF_MAX_SEC,
    defaultBrief: defaultBrief,
    normalizeBrief: normalizeBrief,
    briefIsDefault: briefIsDefault,
    briefOf: briefOf,
    /* 视频侧：单页秒数与页选取计划（只算，不改 deck） */
    MIN_PAGES: MIN_PAGES,
    PAGE_TRIM_ORDER: PAGE_TRIM_ORDER,
    pageSecOf: pageSecOf,
    planBrief: planBrief,
    /* 纯函数（宿主 / 自检 / node 里人工复核都走这一份） */
    splitSections: splitSections,
    blocksOf: blocksOf,
    bulletsOf: bulletsOf,
    quoteOf: quoteOf,
    wikilinksOf: wikilinksOf,
    citesOf: citesOf,
    citeIndexOf: citeIndexOf,
    formulaIndexOf: formulaIndexOf,
    termIndexOf: termIndexOf,
    hitsOf: hitsOf,
    linksOfSections: linksOfSections,
    mergeHits: mergeHits,
    planTerms: planTerms,
    libItemOf: libItemOf,
    yearOfItem: yearOfItem,
    parseDoc: parseDoc,
    inlineText: inlineText,
    slugify: slugify,
    hashString: hashString,
    isoDate: isoDate,
    fileOf: fileOf,
    exportOf: exportOf,
  };
});

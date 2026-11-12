/* ===== 研究演示「叙事 lint」· renderer/research-slides-prose.js =====
 * window.MTResearchSlidesProse（UMD；纯函数、不碰盘、不调模型，node 里可直接 require 复核）
 *
 * 一句话：把 docs/research-slides-video-spec.md §15「叙事质量契约」翻成**可数的机判项** ——
 * 一份演示脚本（slides/<slug>.script.md 的原文）进来，回去的是
 * 「第几页 / 第几行 / 哪个字段 / 超了哪一条」的清单，外加每条怎么改。
 *
 * 为什么要有它：§15 是契约层，宿主**不拦**（§15.8 明确不设拒片闸）。但没有机判项，
 * 模型每一轮都会退回旧口径（基线审计：21 页里 18 页无页间承接、元话语占禁用句式的 2/3）。
 * 所以这里只做**数得出来**的那几条；人判项（承接接不接得上、标题能不能被否掉、末条能不能
 * 被下一页接手）留在 §15.8 的人判一栏，本模块不假装能判。
 *
 * 分工（三处同一口径，改一处必须三处对账：§15 / 提示词 / 这里）：
 *   · 提示词（app-research.js 的 RS_PROMPT_SCRIPT / RS_PROMPT_REWRITE）= 怎么写；
 *   · 本模块 = 写出来长什么样（只认脚本文本，不认 deck、不认 patch、不认 JSON）；
 *   · 返修通道 = app-research.js 的 rsSlidesWatchScript（编页**之前**调一次；命中就回同一条会话，
 *     与「格式错」共用 RS_SLIDES_REPAIR_MAX 的预算；预算用满仍命中 → 照样编页，只把命中项报出来）。
 *
 * 认的条目（编号就是 §15 的小节号）：
 *   §15.1 主张链 ①承接 ②判断标题 ③交出 —— 只有 ① 可机判（承接词在副题 / 首条要点里）
 *   §15.2 禁用句式 20 条 —— 这里只认模型最常犯的 8 条里正则判得准的那几条
 *   §15.3 锚点 每页 ≥1（六种）≤3 种
 *   §15.4 可念性 单句 ≤40 字 / 括号 ≤1 处且 ≤1 层 / 符号密度 / 公式 ≤1 条 ≤40 字符 / 旁白 ≤80 字 0 符号
 *   §14.3 版式预算 要点 3–4 条（>5 提醒）、单条 ≤40 字
 *
 * 两级：errors（能就地改、值得回它一句让它修的：超阈值 / 无锚点 / 无承接 / 禁用句式）
 *       warnings（要按受众与内容判的：符号密度、缩写裸奔、条数与锚点种类偏多）——
 *       warnings 进报告不进返修回话，免得把 2 次预算花在「风格偏好」上。
 *
 * 纯函数纪律：不读盘、不联网、不看时钟、不用随机 —— 同一份文本永远同一份结果（可重跑对比）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.MTResearchSlidesProse = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const VER = 1;

  /* 阈值：逐条对应 §15 的表（改这里必须回 §15 与提示词两处对账，别只改一处） */
  const T = {
    SENTENCE_MAX: 40, /* §15.4 单句 ≤40 字（与 §14.3「单条 ≤40 字」同一把尺） */
    BULLET_CHARS: 40, /* §14.3 单条要点 ≤40 字（有图那页 ≤34，这里只按宽的那一档提醒） */
    BULLETS_MIN: 3,
    BULLETS_MAX: 5, /* > 5 条就该拆页（3–4 条最稳） */
    PAREN_MAX: 1, /* §15.4 括号每页 ≤1 处 */
    PAREN_DEPTH: 1, /* §15.4 不套娃 */
    SYMBOL_PER_100: 3, /* §15.4 正文符号密度每 100 字 ≤3 个 */
    NOTE_MAX: 80, /* §15.4 旁白整段 ≤80 字 */
    NOTE_SYMBOLS: 0, /* §15.4 旁白零符号 */
    NOTE_SENTENCES: 2,
    FORMULA_MAX: 1, /* §15.4 公式一页 ≤1 条 */
    FORMULA_CHARS: 40, /* §15.4 公式 ≤40 字符 */
    ANCHOR_MIN: 1, /* §15.3 每页 ≥1 个锚点 */
    ANCHOR_MAX: 3, /* §15.3 每页 ≤3 种 */
  };

  /* 脚本格式：与 research-slides.js 的 parseScript 同一口径（这里只看得到文本，不建页） */
  const SCRIPT_HEAD = /^<!--\s*mtnode-slides-script\b[^>]*-->\s*$/i;
  const SCRIPT_PAGE = /^##[ \t]+(.+?)[ \t]*$/;
  const META_LINE = /^<!--\s*(note|旁白|scene|figure)\s*[:：]\s*([\s\S]*?)\s*-->$/i;
  const NOTE_INLINE = /^(?:旁白|note)\s*[:：]\s*(.+)$/i;
  const BULLET_LINE = /^\s*[-*+][ \t]+/;
  const ORDERED_LINE = /^\s*\d+[.)][ \t]+/;
  const H_SUB = /^#{3,6}[ \t]+/;

  /* §15.1 ① 承接词：第 2 页起的副题 / 首条要点里得有一个（把上一页交出的东西接住） */
  const CARRY_RE =
    /(上一页|上一节|上一步|前一条|前面|刚才|前文|回到|接上|接着|上面那|上一个|回到刚才)/;

  /* §15.2 禁用句式：取「模型最常犯 + 正则判得准」的那几条；fix = 回话里给它的换法 */
  const BANNED = [
    {
      id: "meta-talk",
      label: "元话语（接下来 / 这一页 / 不展开）",
      re: /(接下来(?:我们)?(?:来看|看|讲|说)|下面(?:我们)?(?:来看|看|讲|说|介绍)|这一页(?:我们)?(?:来看|看|讲|说)|本页(?:我们)?(?:来看|讲)|下一页(?:我们)?(?:来看|讲|看)|不再展开|不展开讲|由于篇幅|篇幅所限|本节(?:我们)?(?:来看|介绍|讨论|讲))/,
      fix: "把这句话删掉，改写成「上一页的什么成立到哪儿为止 + 这一页看什么」",
    },
    {
      id: "empty-close",
      label: "空转收束（综上所述 / 以上是本节）",
      re: /(综上所述|总而言之|总的来说|由此可见|一句话总结|总结一下|以上是本节|以上就是|大体如此)/,
      fix: "收尾落到一个可执行的选择：一个数 / 一个条件 / 一个反例 / 下一个待答问题",
    },
    {
      id: "adjective",
      label: "形容词抬升（显著 / 大幅 / 效果很好）",
      re: /(显著(?:提升|提高|改善|增强|下降|优于)|大幅(?:提升|提高|改善|降低|缩短)|极大(?:提升|改善|提高)|效果很好|性能优异|意义重大|效果不错)/,
      fix: "换成可核对的数字 + 基准（同机、同数据集、同口径）",
      needNoDigit: true, /* 同一字段里有数字就不算抬升（有数字的「显著」可以留） */
    },
    {
      id: "double-negative",
      label: "绕口双重否定（并非不能）",
      re: /(并非不|不是不|不得不|不可否认|未尝不|无不)/,
      fix: "还原成正说：先给结论，再给代价",
    },
    {
      id: "appeal",
      label: "无主语呼吁（需要进一步研究）",
      re: /(需要进一步(?:研究|探索|讨论|验证)|有待进一步|值得进一步(?:研究|探索|验证)|亟需)/,
      fix: "说清「缺哪一组数据 / 谁在什么条件下做」",
    },
  ];

  /* §15.3 六种锚点（别自己发明第七种）；命中任意一种即算这一页有锚点 */
  const ANCHOR_RULES = [
    ["数字", /[0-9]/],
    ["定义或条件", /[≤≥≪≫≈≍≠<>]/],
    [
      "出处",
      /\[@[^\]]+\]|(?:19|20)\d{2}\s*[)）]|（[^）]{0,24}(?:19|20)\d{2}[^）]{0,8}）|\([^)]{0,24}(?:19|20)\d{2}[^)]{0,8}\)/,
    ],
    ["同口径对照", /(?:从|由)[^，。；]{1,24}(?:到|至|降到|升到|涨到|掉到)|(?:vs\.?|对比|相比|对照组)/i],
    ["反例或边界", /(反例|边界|退化|极限|例外|反直觉|失效|不成立)/],
    ["图或公式", /<!--\s*figure:|(?:^|[^$])\$[^$\n]+\$|[^$]\$\$/],
  ];

  /* ── 基础工具（纯函数）────────────────────────────────────────────────── */

  function str(v) {
    return v == null ? "" : String(v);
  }
  function uniq(list) {
    const out = [];
    for (const x of list) if (out.indexOf(x) < 0) out.push(x);
    return out;
  }
  /* 去行内标记：只影响「字数与符号怎么数」，行号一律来自原始行 */
  function plain(s) {
    return str(s)
      .replace(/!?\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/&nbsp;/g, " ");
  }
  /* 字数：中文按字、数字串与拉丁词按 1 字（§15.4 的同一把尺），标点不计 */
  function charCount(s) {
    const t = plain(s);
    let n = 0;
    const re = /[\u3400-\u4dbf\u4e00-\u9fff]|[0-9]+(?:\.[0-9]+)?|[A-Za-z]+/g;
    while (re.exec(t)) n += 1;
    return n;
  }
  /* 切句：以 `。；：！？` 与省略号断（§15.4 的数法） */
  function splitSentences(s) {
    return str(s)
      .split(/[。；：！？!?…]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  /* 符号：单字符数学符 + LaTeX 命令 + 单个拉丁变量（`n` / `N` / `k` 这种） */
  function symTokens(s) {
    const t = plain(s);
    const out = [];
    let m;
    const re1 = /[∑∫∏√≤≥≪≫≈≍≠<>×÷→←↑↓⇒⇔∞∂∇±%°℃§¶]/g;
    while ((m = re1.exec(t))) out.push(m[0]);
    const re2 = /\\[A-Za-z]+|[A-Za-z]\s*\^\s*\{?[^}\s]{1,4}\}?/g;
    while ((m = re2.exec(t))) out.push(m[0].replace(/\s+/g, ""));
    /* 单个字母：两侧都不是字母才算（`softmax` 不算，`n 很大` 算） */
    const re3 = /(^|[^A-Za-z])[A-Za-z](?![A-Za-z])/g;
    while ((m = re3.exec(t))) out.push(m[0].replace(/[^A-Za-z]/g, ""));
    return out;
  }
  /* 归一化只用于「副题是否复述标题」：去页码、去标点、去空白 */
  function keyOf(s) {
    return plain(s)
      .replace(/^[\s\d.、:：)）]*/, "")
      .replace(/^第[一二三四五六七八九十百零\d]+[页节]/, "")
      .replace(/[\s，。；：、！？!?.,;:"'“”‘’（）()《》「」『』【】…—－-]/g, "");
  }
  function bigramOverlap(a, b) {
    const set = (s) => {
      const m = Object.create(null);
      for (let i = 0; i < s.length - 1; i++) m[s.slice(i, i + 2)] = 1;
      return m;
    };
    const A = set(a);
    const kb = Object.keys(set(b));
    if (!kb.length) return 0;
    let hit = 0;
    for (const k of kb) if (A[k]) hit += 1;
    return hit / kb.length;
  }
  function sameish(a, b) {
    const x = keyOf(a);
    const y = keyOf(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if ((x.indexOf(y) >= 0 || y.indexOf(x) >= 0) && Math.min(x.length, y.length) >= 6) return true;
    return bigramOverlap(x, y) >= 0.7;
  }
  /* 缩写裸奔（§15.2 #19）：本页里出现过、且从没紧跟括注展开过的全大写串 */
  function bareAcronyms(text) {
    const t = plain(text);
    const all = [];
    const re = /(^|[^A-Za-z])([A-Z]{2,6})(?![A-Za-z])/g;
    let m;
    while ((m = re.exec(t))) {
      const at = m.index + m[0].length;
      all.push({ w: m[2], expanded: /^[\s]*[（(]/.test(t.slice(at, at + 14)) });
    }
    const known = Object.create(null);
    for (const it of all) if (it.expanded) known[it.w] = 1;
    const out = [];
    for (const it of all) if (!known[it.w] && out.indexOf(it.w) < 0) out.push(it.w);
    return out;
  }

  /* ── 脚本文本 → 页（带行号；只取 lint 要看的字段）────────────────────── */

  function readPages(md) {
    const src = str(md).replace(/\r\n?/g, "\n");
    const lines = src.split("\n");
    /* frontmatter（`---` 包起来那几行）整段跳过，但行号照算 —— 回话里报的就是文件行号 */
    let start = 0;
    if (/^---\s*$/.test(str(lines[0]).trim())) {
      for (let i = 1; i < lines.length; i++) {
        if (/^---\s*$/.test(str(lines[i]).trim())) {
          start = i + 1;
          break;
        }
      }
    }
    const pages = [];
    let cur = null;
    const open = (lineNo, title) => {
      const full = plain(title);
      /* 页码前缀（`02 ` / `02. ` / `第 2 页 `）不是锚点也不是内容：判「有没有数字锚点」时必须先剥掉，
         否则每一页都自带一个数字，锚点这一条永远命中（等于没查）。 */
      const bare = full.replace(/^\s*(?:\d{1,3}[.)、:：]?|第[一二三四五六七八九十百零\d]+[页节])[ \t]*/, "");
      cur = {
        no: pages.length + 1,
        title: full,
        titleBare: bare || full,
        titleLine: lineNo,
        line: lineNo,
        kicker: "",
        kickerLine: 0,
        bullets: [],
        quote: "",
        quoteLine: 0,
        formulas: [],
        note: "",
        noteLine: 0,
        figure: "",
        scene: "",
      };
      pages.push(cur);
    };
    for (let i = start; i < lines.length; i++) {
      const lineNo = i + 1;
      const rawLine = str(lines[i]);
      const t = rawLine.trim();
      if (!t) continue;
      if (SCRIPT_HEAD.test(t)) continue;
      const pm = SCRIPT_PAGE.exec(t);
      if (pm) {
        open(lineNo, pm[1]);
        continue;
      }
      if (!cur) continue; /* `## ` 之前的说明段不进页（与内核 parseScript 一致） */
      if (/^#[ \t]+/.test(t)) continue; /* H1 = 整份标题 */
      const meta = META_LINE.exec(t);
      if (meta) {
        const key = str(meta[1]).toLowerCase();
        const val = str(meta[2]).trim();
        if (key === "scene") {
          cur.scene = val;
          continue;
        }
        if (key === "figure") {
          cur.figure = cur.figure || val;
          continue;
        }
        cur.note = cur.note ? cur.note + " " + val : val;
        cur.noteLine = cur.noteLine || lineNo;
        continue;
      }
      if (/^<!--[\s\S]*-->$/.test(t)) continue; /* 其它注释不进页 */
      const nl = NOTE_INLINE.exec(t);
      if (nl) {
        const val = str(nl[1]).trim();
        cur.note = cur.note ? cur.note + " " + val : val;
        cur.noteLine = cur.noteLine || lineNo;
        continue;
      }
      const dm = /^\$\$([\s\S]+?)\$\$$/.exec(t);
      if (dm) {
        cur.formulas.push({ tex: dm[1].trim(), line: lineNo });
        continue;
      }
      const im = /^\$([^$\n]+)\$$/.exec(t);
      if (im) {
        cur.formulas.push({ tex: im[1].trim(), line: lineNo });
        continue;
      }
      if (H_SUB.test(t)) {
        cur.bullets.push({ text: plain(t.replace(H_SUB, "")), line: lineNo });
        continue;
      }
      if (BULLET_LINE.test(rawLine)) {
        cur.bullets.push({ text: plain(rawLine.replace(BULLET_LINE, "")), line: lineNo });
        continue;
      }
      if (ORDERED_LINE.test(rawLine)) {
        cur.bullets.push({ text: plain(rawLine.replace(ORDERED_LINE, "")), line: lineNo });
        continue;
      }
      if (/^>/.test(t)) {
        const q = plain(t.replace(/^>\s?/, ""));
        if (!q) continue;
        if (!cur.kicker && !cur.bullets.length && !cur.formulas.length && !cur.quote) {
          cur.kicker = q;
          cur.kickerLine = lineNo;
        } else {
          cur.quote = cur.quote ? cur.quote + " " + q : q;
          cur.quoteLine = cur.quoteLine || lineNo;
        }
        continue;
      }
      cur.bullets.push({ text: plain(t), line: lineNo });
    }
    return pages;
  }

  /* ── 一页的机判项 ───────────────────────────────────────────────────── */

  function anchorTypesOf(pg) {
    const text = [
      pg.titleBare || pg.title,
      pg.kicker,
      pg.quote,
      pg.bullets.map((b) => b.text).join("\n"),
      pg.formulas.map((f) => f.tex).join("\n"),
      pg.figure,
    ].join("\n");
    const out = [];
    for (const it of ANCHOR_RULES) if (it[1].test(text)) out.push(it[0]);
    return out;
  }

  function lintPage(pg, idx) {
    const errors = [];
    const warnings = [];
    const add = (list, rule, line, field, why) =>
      list.push({
        rule: rule,
        page: pg.no,
        pageTitle: pg.title,
        line: line || pg.titleLine,
        field: field,
        why: why,
      });

    /* ① §15.4 单句 ≤40 字（标题 / 副题 / 每条要点 / 旁白，各报一次就够） */
    const tooLong = (text, line, field) => {
      for (const s of splitSentences(text)) {
        const n = charCount(s);
        if (n > T.SENTENCE_MAX) {
          add(
            errors,
            "sentence-long",
            line,
            field,
            "单句 " + n + " 字（≤" + T.SENTENCE_MAX + "）：拆两句，或先砍定语从句",
          );
          return;
        }
      }
    };
    tooLong(pg.titleBare || pg.title, pg.titleLine, "标题");
    if (pg.kicker) tooLong(pg.kicker, pg.kickerLine, "副题");
    pg.bullets.forEach((b, i) => tooLong(b.text, b.line, "要点 " + (i + 1)));
    if (pg.note) tooLong(pg.note, pg.noteLine, "旁白");

    /* ② §15.4 括号：每页 ≤1 处、深度 ≤1 */
    let parens = 0;
    let parenLine = 0;
    let parenField = "";
    let nestLine = 0;
    let nestField = "";
    let nestDepth = 0;
    const scanParen = (text, line, field) => {
      const t = plain(text);
      let depth = 0;
      for (const ch of t) {
        if (ch === "（" || ch === "(") {
          depth += 1;
          if (depth > 1 && !nestLine) {
            nestLine = line;
            nestField = field;
            nestDepth = depth;
          }
        } else if (ch === "）" || ch === ")") depth = Math.max(0, depth - 1);
      }
      const c = (t.match(/[（(]/g) || []).length;
      if (c) {
        parens += c;
        if (!parenLine) {
          parenLine = line;
          parenField = field;
        }
      }
    };
    if (pg.kicker) scanParen(pg.kicker, pg.kickerLine, "副题");
    pg.bullets.forEach((b, i) => scanParen(b.text, b.line, "要点 " + (i + 1)));
    if (parens > T.PAREN_MAX)
      add(
        errors,
        "paren-many",
        parenLine,
        parenField,
        "这一页括号 " + parens + " 处（≤" + T.PAREN_MAX + "）：括号里的补充升成一句要点，升不上去就删",
      );
    if (nestLine)
      add(
        errors,
        "paren-nested",
        nestLine,
        nestField,
        "括号套了 " + nestDepth + " 层（≤1）：括号里能独立成句，就升成一条要点",
      );

    /* ③ §15.4 正文符号密度（正文 = 副题 + 要点；公式与图注不算，旁白单独查） */
    const body = [pg.kicker].concat(pg.bullets.map((b) => b.text)).join("\n");
    const bodyChars = charCount(body);
    if (bodyChars >= 30) {
      const per100 = (symTokens(body).length * 100) / bodyChars;
      if (per100 > T.SYMBOL_PER_100)
        add(
          warnings,
          "symbol-density",
          pg.kickerLine || pg.titleLine,
          "本页正文",
          "符号密度 " + per100.toFixed(1) + " 个/100 字（≤" + T.SYMBOL_PER_100 + "）：换中文读法，变量第一次出现给一句白话",
        );
    }

    /* ④ §15.4 旁白：≤80 字、零符号、1–2 句 */
    if (pg.note) {
      const n = charCount(pg.note);
      if (n > T.NOTE_MAX)
        add(
          errors,
          "note-long",
          pg.noteLine,
          "旁白",
          "旁白 " + n + " 字（≤" + T.NOTE_MAX + "）：砍修饰，只留判断与「眼睛看哪儿」",
        );
      const syms = uniq(symTokens(pg.note));
      if (syms.length)
        add(
          errors,
          "note-symbol",
          pg.noteLine,
          "旁白",
          "旁白里有符号「" +
            syms.slice(0, 4).join(" ") +
            "」：换成中文读法（说「屏幕上那个三分之一次方」，别念公式）",
        );
      const ns = splitSentences(pg.note).length;
      if (ns > T.NOTE_SENTENCES)
        add(warnings, "note-sentences", pg.noteLine, "旁白", "旁白 " + ns + " 句（1–2 句）：只留一句判断 + 一句「看哪儿」");
    }

    /* ⑤ §15.4 公式：一页 ≤1 条、≤40 字符 */
    if (pg.formulas.length > T.FORMULA_MAX)
      add(
        errors,
        "formula-many",
        pg.formulas[T.FORMULA_MAX].line,
        "公式",
        "这一页 " + pg.formulas.length + " 条公式（≤" + T.FORMULA_MAX + "）：多出来的挪到下一页",
      );
    pg.formulas.forEach((f) => {
      const n = str(f.tex).length;
      if (n > T.FORMULA_CHARS)
        add(
          errors,
          "formula-long",
          f.line,
          "公式",
          "公式 " + n + " 字符（≤" + T.FORMULA_CHARS + "）：拆成人话，或挪到下一页",
        );
    });

    /* ⑥ §15.3 锚点：每页 ≥1 种；>3 种只提醒（多出来的正好当下一页的承接） */
    const types = anchorTypesOf(pg);
    if (!types.length)
      add(
        errors,
        "no-anchor",
        pg.titleLine,
        "本页",
        "这一页没有任何锚点：补一个数字（带单位）/ 定义或条件 / 出处 / 同口径对照 / 反例或边界 / 图或公式",
      );
    else if (types.length > T.ANCHOR_MAX)
      add(
        warnings,
        "anchor-many",
        pg.titleLine,
        "本页",
        "锚点 " + types.length + " 种（" + types.join(" · ") + "，≤" + T.ANCHOR_MAX + "）：多出来的留给下一页当承接",
      );

    /* ⑦ §15.1 ① 承接：第 2 页起，副题或第一条要点里要接住上一页 */
    if (idx > 0) {
      const head = pg.kicker || (pg.bullets[0] ? pg.bullets[0].text : "");
      const line = pg.kickerLine || (pg.bullets[0] ? pg.bullets[0].line : pg.titleLine);
      if (!CARRY_RE.test(head))
        add(
          errors,
          "no-carry",
          line,
          pg.kicker ? "副题" : "首条要点",
          "没接住上一页：把上一页交出的那个东西抄成半句，放在副题或第一条要点的前半句",
        );
    }

    /* ⑧ §15.2 禁用句式（正则判得准的那几条）+ 副题复述标题 */
    const scanBanned = (text, line, field) => {
      const t = plain(text);
      if (!t) return;
      for (const r of BANNED) {
        if (!r.re.test(t)) continue;
        if (r.needNoDigit && /[0-9]/.test(t)) continue;
        add(errors, r.id, line, field, "「" + r.label + "」：删掉或重写 —— " + r.fix);
      }
    };
    scanBanned(pg.title, pg.titleLine, "标题");
    if (pg.kicker) scanBanned(pg.kicker, pg.kickerLine, "副题");
    pg.bullets.forEach((b, i) => scanBanned(b.text, b.line, "要点 " + (i + 1)));
    if (pg.note) scanBanned(pg.note, pg.noteLine, "旁白");

    if (pg.kicker && sameish(pg.kicker, pg.title))
      add(
        errors,
        "kicker-echo",
        pg.kickerLine,
        "副题",
        "副题在复述标题：副题要接上一页交出的东西，不是把标题再说一遍",
      );

    /* 版式预算（§14.3）与术语裸奔（§15.2 #19）：只提醒 —— 要不要拆页 / 要不要展开取决于内容与受众 */
    if (pg.bullets.length > T.BULLETS_MAX)
      add(
        warnings,
        "bullets-many",
        pg.bullets[T.BULLETS_MAX].line,
        "本页",
        "要点 " + pg.bullets.length + " 条（≤" + T.BULLETS_MAX + "）：超过就拆两页，别压字号",
      );
    const bare = bareAcronyms(body);
    if (bare.length)
      add(
        warnings,
        "acronym-bare",
        pg.kickerLine || pg.titleLine,
        "本页正文",
        "缩写 " + bare.slice(0, 3).join(" / ") + " 没展开：第一次出现补一句白话括注",
      );

    return { errors: errors, warnings: warnings };
  }

  /* ── 整份脚本 ───────────────────────────────────────────────────────── */

  function lintScript(md, opts) {
    const o = opts || {};
    const pages = readPages(md);
    const errors = [];
    const warnings = [];
    let bulletCount = 0;
    let sentenceCount = 0;
    let chars = 0;
    pages.forEach((pg, i) => {
      const r = lintPage(pg, i);
      for (const e of r.errors) errors.push(e);
      for (const w of r.warnings) warnings.push(w);
      bulletCount += pg.bullets.length;
      const fields = [pg.titleBare || pg.title, pg.kicker, pg.quote, pg.note].concat(
        pg.bullets.map((b) => b.text),
      );
      for (const f of fields) {
        sentenceCount += splitSentences(f).length;
        chars += charCount(f);
      }
    });
    return {
      ver: VER,
      ok: pages.length > 0 && errors.length === 0,
      path: str(o.path || ""),
      pages: pages.length,
      errors: errors,
      warnings: warnings,
      stats: { pages: pages.length, bullets: bulletCount, sentences: sentenceCount, chars: chars },
      note: pages.length ? "" : "没有任何 `## ` 分节：先按脚本格式分页（格式错由宿主的 rsSlidesScriptWhy 报行号）",
    };
  }

  /* lint 结果 → 回话正文：第几页 / 第几行 / 哪个字段 / 超了哪一条。
     maxHits 只压**条数**，不压页数（同一个 Model 一轮改不完 21 页，先让它改前几处最要紧的）。 */
  function formatHits(res, opts) {
    const o = opts || {};
    const max = Number(o.maxHits) > 0 ? Number(o.maxHits) : 12;
    const errs = (res && res.errors) || [];
    if (!errs.length) return "";
    const out = [];
    let shown = 0;
    let lastPage = 0;
    for (const e of errs) {
      if (shown >= max) break;
      if (e.page !== lastPage) {
        out.push("第 " + e.page + " 页「" + e.pageTitle + "」");
        lastPage = e.page;
      }
      out.push("  · 第 " + e.line + " 行 " + e.field + "：" + e.why);
      shown += 1;
    }
    if (errs.length > shown) out.push("（还有 " + (errs.length - shown) + " 处同类问题，先改上面这些）");
    return out.join("\n");
  }

  return {
    VER: VER,
    THRESHOLDS: T,
    BANNED: BANNED,
    CARRY_RE: CARRY_RE,
    scanScript: readPages,
    lintPage: lintPage,
    lintScript: lintScript,
    formatHits: formatHits,
    charCount: charCount,
    splitSentences: splitSentences,
    symTokens: symTokens,
    anchorTypesOf: anchorTypesOf,
  };
});

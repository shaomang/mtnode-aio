"use strict";
/* ============ LaTeX 渲染器（KaTeX 离线内置优先 · 自研子集回退 · 回退路径纯 DOM + CSS） ====
 *
 * 公式 → HTML 这一步优先交给 KaTeX（`window.katex.renderToString(tex, {
 *   displayMode, throwOnError: false, strict: "ignore", trust: false })`）：
 *   · trust:false 屏蔽 \href / \htmlClass 这类可注入的命令；
 *   · throwOnError:false 让写错的公式渲染成红字，而不是把整篇预览炸掉；
 *   · KaTeX 缺失（无 KaTeX 的 Node 沙箱）或 renderToString 抛错时，回退到下面这套
 *     自研 LaTeX 子集渲染器，保证降级场景仍有输出。
 *
 * 目标：让审阅（app-review.js）与一切 Markdown 预览把 `$…$` / `$$…$$` / `\(…\)` / `\[…\]`
 * 公式渲染成排版结果，同时**绝不破坏 Markdown 源码**：
 *   · 渲染只发生在 HTML 视图层；根节点带 data-rv-tex（原始 LaTeX）、
 *     data-rv-display（0/1）与 data-rv-delim（原定界符），序列化回 Markdown 时由
 *     app-review.js 按它们还原成本来的写法，故「让 AI 依据批注修订」的取文 / 回写公式不丢。
 *   · 不做 md → html 的两次解析：先把 Markdown 里的公式抽成占位符（PUA 私用区
 *     字符，marked 会原样保留），再用调用方给的 parseFn 解析整篇，最后把占位符
 *     替换成渲染结果 —— 段落 / 列表 / 表格结构与公式位置都不受影响。
 *   · 跳过围栏代码块与行内代码里的 `$`，不把代码里的美元符号误判成公式。
 *
 * 回退渲染器（无 KaTeX 时启用）支持的 LaTeX 子集（够用为度，不认识的原样显示成 \cmd 而不是崩）：
 *   上下标 ^{} _{}  ^x _x（可连缀）· 分式 \frac \dfrac \tfrac \binom
 *   根号 \sqrt{} \sqrt[n]{} · 希腊字母 · 常用算子 / 关系符 / 箭头 / 大算符
 *   函数名 \sin \log \lim…（直立）· \operatorname{…} · \bmod \pmod
 *   \text \mathrm \mathbf \mathbb \mathcal…
 *   定界符 \left( \right] \left\{ · \big \Big \bigg \Bigg 放大的定界符
 *   矩阵 / 多行 matrix pmatrix bmatrix
 *   Bmatrix vmatrix Vmatrix cases aligned gathered array（& 分列，\\ 换行）
 *   重音 \hat \bar \vec \tilde \dot… · \overline \underline · \substack 多行限界
 *   \xrightarrow[下]{上} 带标注箭头 · \tag{4.1} 公式编号（右浮动小字）
 *   渐近 / 序关系 \asymp \lesssim \coloneqq…（数论 · 分析类文档高频）
 *   间距 \, \; \: \! \quad \qquad \hspace{} \  · 转义 \% \$ \& \# \_ \{ \} \|
 *
 * 出口（window.MTMathRender）：
 *   latexToHtml(tex, {display, delim}) -> 单个公式的 HTML（含 data-rv-* 根节点）
 *   mdToHtml(markdown, parseFn)        -> Markdown 全文 HTML（公式已渲染）
 *   splitMath(markdown)                -> { md, items:[{tex,display,delim}] } 占位符化
 *   texAttrsOf(el)                     -> { tex, display, delim } | null（序列化用）
 *   TOKEN_RE                           -> 占位符正则（需要自己替换时用）
 *
 * 定界符四件套都认（delim 记录原文用哪一种，回写时按原样还原，不擅自改写用户源码）：
 *   `$…$` 行内 · `$$…$$` 显示 · `\(…\)` 行内 · `\[…\]` 显示（含跨行显示式）。
 *   后两种是 AI 产出 / PDF 转 Markdown 的高频写法，此前只有前两种能渲染。
 */

(function (global) {
  /* ============================ 0. 基础工具 ============================ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, "&quot;");
  }
  function isSpace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  /* 占位符：PUA 私用区包围 + 序号；marked / 转义都不会动它 */
  const TOKEN_OPEN = "\uE000";
  const TOKEN_CLOSE = "\uE001";
  const TOKEN_RE = /\uE000(\d+)\uE001/g;
  function tokenOf(idx) {
    return TOKEN_OPEN + idx + TOKEN_CLOSE;
  }

  /* ============================ 1. 符号表 ============================ */

  const GREEK = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
    varepsilon: "ϵ", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
    iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
    omicron: "ο", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ",
    varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "ϕ",
    chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
    Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  };

  const OP_SYMBOLS = {
    pm: "±", mp: "∓", times: "×", div: "÷", cdot: "⋅", ast: "∗",
    star: "⋆", circ: "∘", bullet: "∙", oplus: "⊕", ominus: "⊖",
    otimes: "⊗", oslash: "⊘", odot: "⊙", boxplus: "⊞", boxtimes: "⊠",
    le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
    approx: "≈", simeq: "≃", cong: "≅", equiv: "≡", sim: "∼",
    nsim: "≁", propto: "∝", ll: "≪", gg: "≫", prec: "≺", succ: "≻",
    preceq: "⪯", succeq: "⪰", subset: "⊂", supset: "⊃",
    subseteq: "⊆", supseteq: "⊇", in: "∈", notin: "∉", ni: "∋",
    cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "⌀",
    forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬",
    land: "∧", lor: "∨", wedge: "∧", vee: "∨",
    to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒",
    Leftarrow: "⇐", leftrightarrow: "↔", Leftrightarrow: "⇔",
    mapsto: "↦", uparrow: "↑", downarrow: "↓", updownarrow: "↕",
    longrightarrow: "⟶", longleftarrow: "⟵",
    longmapsto: "⟼", hookrightarrow: "↪", hookleftarrow: "↩",
    infty: "∞", partial: "∂", nabla: "∇", angle: "∠", perp: "⊥",
    parallel: "∥", therefore: "∴", because: "∵", pr: "", mid: "|",
    cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱",
    prime: "′", backprime: "‵", square: "□", blacksquare: "■",
    triangle: "△", triangledown: "▽", diamond: "⋄",
    hbar: "ℏ", ell: "ℓ", wp: "℘", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
    langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉",
    lfloor: "⌊", rfloor: "⌋", vert: "|", Vert: "‖", lVert: "‖",
    rVert: "‖", backslash: "\\", checkmark: "✓", dagger: "†",
    ddagger: "‡", S: "§", P: "¶", copyright: "©", pounds: "£",
    colon: ":", ldots2: "…", degree: "°", circlet: "∘",
    /* 渐近 / 等价 / 序关系：数论 · 分析类文档的高频写法（数学画布三篇文献里
       `\asymp` 出现 55 次），此前不认识会被原样显示成 `\asymp` 这类源码，
       整条公式看着就像没渲染。 */
    asymp: "≍", coloneqq: "≔", eqqcolon: "≕", doteq: "≐",
    triangleq: "≜", approxeq: "≊", lesssim: "≲", gtrsim: "≳",
    lessgtr: "≶", gtrless: "≷", leqslant: "⩽", geqslant: "⩾",
    nless: "≮", ngtr: "≯", nleq: "≰", ngeq: "≱", nmid: "∤",
    nparallel: "∦", sqsubset: "⊏", sqsupset: "⊐", sqsubseteq: "⊑",
    sqsupseteq: "⊒", vdash: "⊢", dashv: "⊣", vDash: "⊨", models: "⊨",
    iff: "⟺", implies: "⟹", impliedby: "⟸", leadsto: "⇝",
    rightsquigarrow: "⇝", leftrightsquigarrow: "↭",
  };

  /* 大算符：渲染得大一号（∑ ∫ ∏ ⋃ ⋂ …） */
  const BIG_OP_SYMBOLS = {
    sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭",
    oint: "∮", oiint: "∯", bigcup: "⋃", bigcap: "⋂", bigvee: "⋁",
    bigwedge: "⋀", bigoplus: "⨁", bigotimes: "⨂", bigodot: "⨀",
    biguplus: "⨄", bigsqcup: "⨆",
  };

  /* 函数名（直立排版） */
  const FUNCS = {};
  [
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos",
    "arctan", "sinh", "cosh", "tanh", "coth", "log", "ln", "lg", "exp",
    "lim", "max", "min", "sup", "inf", "det", "dim", "ker", "deg",
    "gcd", "arg", "bmod", "pmod", "mod", "operatorname", "hom", "tr",
  ].forEach((f) => (FUNCS[f] = true));

  /* 间距命令 → em 宽度（负值为回退） */
  const SPACES = {
    ",": 0.17, ":": 0.22, ";": 0.28, "!": -0.17, " ": 0.33,
    quad: 1, qquad: 2, enspace: 0.5, thinspace: 0.17, negthinspace: -0.17,
    hspace: 0.5,
  };

  /* 无操作的花架子命令（吃掉参数 / 直接忽略） */
  const NOOP_CMDS = {
    limits: 1, nolimits: 1, displaystyle: 1, textstyle: 1,
    scriptstyle: 1, scriptscriptstyle: 1, mathstrut: 1, phantom: 1,
    vphantom: 1, hphantom: 1, strut: 1, relax: 1, allowbreak: 1,
    smallskip: 1, medskip: 1, bigskip: 1, noindent: 1, notag: 1,
    nonumber: 1,
  };

  /* 重音 / 装饰（\hat \bar \vec \tilde…）：符号压在被装饰内容上方，见 .rv-macc */
  const ACCENTS = {
    hat: "ˆ", widehat: "ˆ", tilde: "˜", widetilde: "˜", bar: "‾",
    vec: "→", dot: "˙", ddot: "¨", check: "ˇ", breve: "˘",
    acute: "´", grave: "`",
  };

  /* \big \Big \bigg \Bigg（可带 l / r / m 变体）：把紧跟的定界符放大一号 */
  const BIG_DELIM_CMDS = /^(?:big|Big|bigg|Bigg)[lrm]?$/;

  const DOUBLE_STRUCK = {
    A: "𝔸", B: "𝔹", C: "ℂ", D: "𝔻", E: "𝔼", F: "𝔽", G: "𝔾", H: "ℍ",
    I: "𝕀", J: "𝕁", K: "𝕂", L: "𝕃", M: "𝕄", N: "ℕ", O: "𝕆", P: "ℙ",
    Q: "ℚ", R: "ℝ", S: "𝕊", T: "𝕋", U: "𝕌", V: "𝕍", W: "𝕎", X: "𝕏",
    Y: "𝕐", Z: "ℤ",
  };

  const OP_CHARS = "+-*/=<>±×÷⋅≤≥≠≈≡∈∉⊂⊃⊆⊇∪∩→←↑↓⇒⇔∑∏∫√∞∂∇±∓∗∘∙⊕⊗∠⊥∥∴∵";
  const DELIM_CHARS = "()[]|{}⟨⟩⌈⌉⌊⌋‖";

  /* ============================ 2. 解析器（LaTeX → AST） ============================ */

  function skipWs(s, i) {
    while (i < s.length && isSpace(s[i])) i++;
    return i;
  }

  /* 读 {…} 原始内容（不解析） */
  function readRawGroup(s, i) {
    i = skipWs(s, i);
    if (s[i] !== "{") return { raw: s[i] || "", end: i + (s[i] ? 1 : 0) };
    let depth = 0;
    let j = i;
    let out = "";
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === "{") {
        depth++;
        if (depth === 1) continue;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      out += ch;
    }
    return { raw: out, end: j };
  }

  /* 读 {…} 并解析成 AST 节点数组 */
  function readNodesArg(s, i) {
    i = skipWs(s, i);
    if (s[i] === "{") {
      const g = readRawGroup(s, i);
      return { nodes: parseList(g.raw, 0).nodes, end: g.end };
    }
    if (s[i] === "\\") {
      const r = readCommand(s, i);
      return { nodes: r.node ? [r.node] : [], end: r.end };
    }
    if (i >= s.length) return { nodes: [], end: i };
    const ch = s[i];
    if (/[0-9]/.test(ch)) {
      let j = i;
      let num = "";
      while (j < s.length && /[0-9.]/.test(s[j])) {
        num += s[j];
        j++;
      }
      return { nodes: [{ t: "num", v: num }], end: j };
    }
    if (/[A-Za-z]/.test(ch)) return { nodes: [{ t: "id", v: ch }], end: i + 1 };
    return { nodes: [{ t: "op", v: ch }], end: i + 1 };
  }

  /* 上下标：挂在紧邻的前一个原子上（可连缀 ^{a}_{b}） */
  function attachScript(nodes, which, body) {
    if (!body || !body.length) return;
    const last = nodes[nodes.length - 1];
    if (last && last.t === "script") {
      last[which] = (last[which] || []).concat(body);
      return;
    }
    const base = last ? nodes.pop() : null;
    const node = { t: "script", base: base, sup: null, sub: null };
    node[which] = body;
    nodes.push(node);
  }

  function readCommand(s, i) {
    const rest = s.slice(i + 1);
    if (rest[0] === "\\") return { node: { t: "rowbreak" }, end: i + 2 };
    const m = /^[A-Za-z]+/.exec(rest);
    if (!m) {
      const c = rest[0] || "";
      if (Object.prototype.hasOwnProperty.call(SPACES, c))
        return { node: { t: "sp", w: SPACES[c] }, end: i + 2 };
      if ("%$&#_{}".indexOf(c) >= 0)
        return { node: { t: "ord", v: c }, end: i + 2 };
      /* \| 是 ‖（范数）；此前落到 end:i+1 把反斜杠留下、竖线被当成定界符 */
      if (c === "|") return { node: { t: "op", v: "‖" }, end: i + 2 };
      return { node: null, end: i + 1 };
    }
    const name = m[0];
    let j = i + 1 + name.length;

    if (Object.prototype.hasOwnProperty.call(NOOP_CMDS, name))
      return { node: null, end: j };

    /* 字母名间距命令（\quad \qquad \enspace \thinspace \negthinspace）：
       此前只在「\ 后跟非字母」那条分支里查 SPACES，\quad 这类名字被当成未知命令
       原样漏成 "\quad" —— 文档声明支持的间距在页面与 PDF 里都是字面量。 */
    if (Object.prototype.hasOwnProperty.call(SPACES, name)) {
      if (name === "hspace") {
        /* \hspace{1em}：按单位折成 em；认不出来就退回默认 0.5em */
        const g = readRawGroup(s, j);
        const raw = String(g.raw || "").trim();
        const mm = /^(-?[\d.]+)\s*(em|ex|pt|px|cm|mm|in)?$/.exec(raw);
        let w = 0.5;
        if (mm) {
          const v = Number(mm[1]);
          const u = mm[2] || "em";
          w =
            u === "em" ? v :
            u === "ex" ? v * 0.5 :
            u === "px" ? v / 16 :
            u === "pt" ? v / 10 :
            u === "cm" ? v * 2.83 :
            u === "mm" ? v * 0.283 :
            u === "in" ? v * 6 : v;
        }
        return { node: { t: "sp", w: w }, end: Math.max(g.end, j) };
      }
      return { node: { t: "sp", w: SPACES[name] }, end: j };
    }

    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const a = readNodesArg(s, j);
      const b = readNodesArg(s, a.end);
      return { node: { t: "frac", num: a.nodes, den: b.nodes }, end: b.end };
    }

    /* \binom{n}{k}：二项式系数（上下叠放包在圆括号里，中间不画分数线） */
    if (name === "binom" || name === "dbinom" || name === "tbinom") {
      const a = readNodesArg(s, j);
      const b = readNodesArg(s, a.end);
      return { node: { t: "binom", num: a.nodes, den: b.nodes }, end: b.end };
    }

    if (name === "sqrt") {
      let idx = null;
      j = skipWs(s, j);
      if (s[j] === "[") {
        const k = s.indexOf("]", j);
        if (k >= 0) {
          idx = parseList(s.slice(j + 1, k), 0).nodes;
          j = k + 1;
        }
      }
      const a = readNodesArg(s, j);
      return { node: { t: "sqrt", idx: idx, body: a.nodes }, end: a.end };
    }

    if (name === "text" || name === "textrm" || name === "textnormal" ||
      name === "mbox" || name === "textup" || name === "textmd") {
      const a = readRawGroup(s, j);
      return { node: { t: "text", body: a.raw }, end: a.end };
    }

    if (name === "mathbb" || name === "Bbb" || name === "bm") {
      const a = readNodesArg(s, j);
      return { node: { t: "bb", body: a.nodes }, end: a.end };
    }

    if (
      name === "mathrm" || name === "mathbf" || name === "mathit" ||
      name === "mathsf" || name === "mathtt" || name === "mathcal" ||
      name === "mathfrak" || name === "boldsymbol" || name === "textbf"
    ) {
      const a = readNodesArg(s, j);
      const cls =
        name === "mathbf" || name === "textbf" || name === "boldsymbol"
          ? "rv-mbf"
          : name === "mathsf" || name === "mathtt"
            ? "rv-mtt"
            : "rv-mrm";
      return { node: { t: "style", cls: cls, body: a.nodes }, end: a.end };
    }

    /* 重音 / 装饰：\hat \bar \vec \tilde…（符号压在被装饰内容上方，见 .rv-macc） */
    if (Object.prototype.hasOwnProperty.call(ACCENTS, name)) {
      const a = readNodesArg(s, j);
      return { node: { t: "acc", mark: ACCENTS[name], body: a.nodes }, end: a.end };
    }

    /* \overline / \underline：横线由 CSS 的 text-decoration 画（见 .rv-mover / .rv-munder） */
    if (name === "overline" || name === "underline") {
      const a = readNodesArg(s, j);
      return {
        node: { t: "deco", cls: name === "overline" ? "rv-mover" : "rv-munder", body: a.nodes },
        end: a.end,
      };
    }

    /* \xrightarrow[下]{上} / \xleftarrow[下]{上}：带标注的箭头（「依概率收敛」这类写法） */
    if (name === "xrightarrow" || name === "xleftarrow") {
      let k = skipWs(s, j);
      let below = null;
      if (s[k] === "[") {
        const e = s.indexOf("]", k);
        if (e >= 0) {
          below = parseList(s.slice(k + 1, e), 0).nodes;
          k = e + 1;
        }
      }
      const a = readNodesArg(s, k);
      return {
        node: {
          t: "xarrow",
          dir: name === "xleftarrow" ? "←" : "→",
          top: a.nodes,
          bot: below,
        },
        end: a.end,
      };
    }

    /* \substack{a\\b}：大算符下标里的多行限界（∑ 下方堆叠的那种），此前会漏成源码 */
    if (name === "substack") {
      const a = readRawGroup(s, j);
      const rows = splitTop(a.raw, "row").map((r) => parseList(r, 0).nodes);
      return { node: { t: "substack", rows: rows }, end: a.end };
    }

    /* \tag{4.1}：公式编号（右浮动小字）；\tag* 同；\nonumber 已在 NOOP_CMDS 里吃掉 */
    if (name === "tag") {
      let k = skipWs(s, j);
      if (s[k] === "*") k++;
      const a = readRawGroup(s, k);
      return { node: { t: "tag", v: a.raw }, end: a.end };
    }

    /* \big \Big \bigg \Bigg（含 l / r / m 变体）：放大紧跟的定界符 */
    if (BIG_DELIM_CMDS.test(name)) {
      const d = readDelim(s, j);
      if (!d.ch) return { node: null, end: d.end };
      return { node: { t: "delim", v: d.ch, big: true }, end: d.end };
    }

    /* \operatorname{...}（直立函数名）· \bmod \pmod（模号）：不是普通函数名，
       按已知口径渲染，免得把 "operatorname" 这串字面量印进公式 */
    if (name === "operatorname") {
      let k = skipWs(s, j);
      if (s[k] === "*") k++;
      const a = readRawGroup(s, k);
      return { node: { t: "text", body: a.raw }, end: a.end };
    }
    if (name === "bmod" || name === "mod") return { node: { t: "func", v: "mod" }, end: j };
    if (name === "pmod") {
      const a = readRawGroup(s, j);
      return { node: { t: "text", body: "(mod " + a.raw + ")" }, end: a.end };
    }

    if (name === "left" || name === "right" || name === "middle") {
      const d = readDelim(s, j);
      if (!d.ch) return { node: null, end: d.end };
      return { node: { t: "delim", v: d.ch }, end: d.end };
    }

    if (name === "begin") {
      const nm = readRawGroup(s, j);
      const envName = nm.raw.trim();
      if (!envName) return { node: null, end: nm.end };
      const endTag = "\\end{" + envName + "}";
      const idx = s.indexOf(endTag, nm.end);
      if (idx < 0) {
        return { node: { t: "env", name: envName, rows: splitEnvRows(s.slice(nm.end)) }, end: s.length };
      }
      return {
        node: {
          t: "env",
          name: envName,
          rows: splitEnvRows(s.slice(nm.end, idx)),
        },
        end: idx + endTag.length,
      };
    }

    if (name === "end") {
      const nm = readRawGroup(s, j);
      return { node: null, end: nm.end };
    }

    if (name === "stackrel" || name === "overset" || name === "underset") {
      const a = readNodesArg(s, j);
      const b = readNodesArg(s, a.end);
      return {
        node: { t: "script", base: b.nodes.length ? b.nodes[b.nodes.length - 1] : null, sup: a.nodes, sub: null },
        end: b.end,
      };
    }

    if (Object.prototype.hasOwnProperty.call(GREEK, name))
      return { node: { t: "id", v: GREEK[name] }, end: j };

    if (Object.prototype.hasOwnProperty.call(BIG_OP_SYMBOLS, name))
      return { node: { t: "big", v: BIG_OP_SYMBOLS[name] }, end: j };

    if (Object.prototype.hasOwnProperty.call(OP_SYMBOLS, name))
      return { node: { t: "op", v: OP_SYMBOLS[name] }, end: j };

    if (FUNCS[name.toLowerCase()])
      return { node: { t: "func", v: name }, end: j };

    /* 不认识：原样显示 \cmd，不丢信息也不崩 */
    return { node: { t: "cmd", v: "\\" + name }, end: j };
  }

  function readDelim(s, i) {
    i = skipWs(s, i);
    if (i >= s.length) return { ch: "", end: i };
    if (s[i] === "\\") {
      const m = /^[A-Za-z]+/.exec(s.slice(i + 1));
      const one = s[i + 1] || "";
      if (m) {
        const name = m[0];
        const alias = {
          lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩",
          lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
          vert: "|", Vert: "‖", lVert: "‖", rVert: "‖",
          lvert: "|", rvert: "|", lgroup: "(", rgroup: ")",
        };
        if (name === ".") return { ch: "", end: i + 1 + name.length };
        if (Object.prototype.hasOwnProperty.call(alias, name))
          return { ch: alias[name], end: i + 1 + name.length };
        return { ch: "", end: i + 1 + name.length };
      }
      if (one === ".") return { ch: "", end: i + 2 };
      return { ch: one, end: i + 2 };
    }
    const ch = s[i];
    return { ch: ch === "." ? "" : ch, end: i + 1 };
  }

  /* ---- 环境（矩阵 / 多行）：按 & 分列、\\ 换行（括号外的才算） ---- */

  function splitTop(str, sepChar) {
    const out = [];
    let depth = 0;
    let cur = "";
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth = depth > 0 ? depth - 1 : 0;
      else if (ch === "\\" && str[i + 1] === "\\" && depth === 0) {
        if (sepChar === "row") {
          out.push(cur);
          cur = "";
          i++;
          if (str[i + 1] === "[") {
            const k = str.indexOf("]", i + 1);
            if (k >= 0) i = k;
          }
          continue;
        }
      } else if (ch === sepChar && depth === 0 && sepChar !== "row") {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function splitEnvRows(body) {
    return splitTop(body, "row").map((row) =>
      splitTop(row, "&").map((cell) => parseList(cell, 0).nodes),
    );
  }

  /* ---- 主解析循环 ---- */

  function parseList(src, i, opts) {
    const o = opts || {};
    const s = String(src == null ? "" : src);
    const nodes = [];
    while (i < s.length) {
      const ch = s[i];
      if (ch === "}") {
        if (o.stopBrace) break;
        i++;
        continue;
      }
      if (isSpace(ch)) {
        i++;
        continue;
      }
      if (ch === "{") {
        const g = readRawGroup(s, i);
        nodes.push({ t: "group", body: parseList(g.raw, 0).nodes });
        i = g.end;
        continue;
      }
      if (ch === "^" || ch === "_") {
        const a = readNodesArg(s, i + 1);
        attachScript(nodes, ch === "^" ? "sup" : "sub", a.nodes);
        i = a.end;
        continue;
      }
      if (ch === "&") {
        nodes.push({ t: "align" });
        i++;
        continue;
      }
      if (ch === "\\") {
        const r = readCommand(s, i);
        if (r.node) nodes.push(r.node);
        i = r.end;
        continue;
      }
      if (ch === "~") {
        nodes.push({ t: "sp", w: 0.33 });
        i++;
        continue;
      }
      if (/[0-9.]/.test(ch)) {
        let j = i;
        let num = "";
        while (j < s.length && /[0-9.]/.test(s[j])) {
          num += s[j];
          j++;
        }
        nodes.push({ t: "num", v: num });
        i = j;
        continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        const m = /^[A-Za-z]{2,}/.exec(s.slice(i));
        if (m && FUNCS[m[0].toLowerCase()]) {
          nodes.push({ t: "func", v: m[0] });
          i += m[0].length;
          continue;
        }
        nodes.push({ t: "id", v: ch });
        i++;
        continue;
      }
      if ("+-*/=<>!,".indexOf(ch) >= 0) {
        nodes.push({ t: "op", v: ch });
        i++;
        continue;
      }
      if (DELIM_CHARS.indexOf(ch) >= 0) {
        nodes.push({ t: "delim", v: ch });
        i++;
        continue;
      }
      nodes.push({ t: "ord", v: ch });
      i++;
    }
    return { nodes: nodes, end: i };
  }

  /* ============================ 3. 渲染（AST → HTML） ============================ */

  function renderNodes(nodes) {
    let out = "";
    for (const n of nodes || []) out += renderNode(n);
    return out;
  }

  function renderNode(n) {
    if (!n) return "";
    switch (n.t) {
      case "id":
        return '<i class="rv-mi">' + esc(n.v) + "</i>";
      case "num":
        return '<span class="rv-mn">' + esc(n.v) + "</span>";
      case "op":
        return '<span class="rv-mo">' + esc(n.v) + "</span>";
      case "ord":
        return esc(n.v);
      case "cmd":
        return '<span class="rv-mcmd">' + esc(n.v) + "</span>";
      case "func":
        return '<span class="rv-mop">' + esc(n.v) + "</span>";
      case "big":
        return '<span class="rv-mbig">' + esc(n.v) + "</span>";
      case "sp":
        return '<span class="rv-msp" style="width:' + Number(n.w || 0.2) + 'em"></span>';
      case "group":
        return renderNodes(n.body);
      case "align":
        return '<span class="rv-mgap"></span>';
      case "rowbreak":
        return '<span class="rv-mbreak"></span>';
      case "delim":
        return (
          '<span class="rv-mdelim' + (n.big ? " rv-mdelim-big" : "") + '">' +
          esc(n.v) +
          "</span>"
        );
      /* 重音：标记压在被装饰内容上方（.rv-macc 是竖排 flex） */
      case "acc":
        return (
          '<span class="rv-macc"><span class="rv-macc-m">' +
          esc(n.mark) +
          '</span><span class="rv-macc-b">' +
          renderNodes(n.body) +
          "</span></span>"
        );
      /* \overline / \underline：横线交给 CSS，内容原样排 */
      case "deco":
        return '<span class="' + n.cls + '">' + renderNodes(n.body) + "</span>";
      /* 带标注箭头：上标注 / 箭头 / 下标注三层竖排 */
      case "xarrow":
        return (
          '<span class="rv-marrow">' +
          (n.top && n.top.length
            ? '<span class="rv-marrow-t">' + renderNodes(n.top) + "</span>"
            : "") +
          '<span class="rv-marrow-a">' + esc(n.dir) + "</span>" +
          (n.bot && n.bot.length
            ? '<span class="rv-marrow-t rv-marrow-b">' + renderNodes(n.bot) + "</span>"
            : "") +
          "</span>"
        );
      /* \substack 多行限界：每行一层，居中堆叠（大算符下标里那种） */
      case "substack":
        return (
          '<span class="rv-mstack">' +
          (n.rows || [])
            .map((r) => '<span class="rv-mstack-r">' + renderNodes(r) + "</span>")
            .join("") +
          "</span>"
        );
      /* 公式编号：右浮动小字，不混进公式主体 */
      case "tag":
        return '<span class="rv-mtag">(' + esc(n.v) + ")</span>";
      case "text":
        return '<span class="rv-mtext">' + esc(n.body) + "</span>";
      case "style":
        return '<span class="' + n.cls + '">' + renderNodes(n.body) + "</span>";
      case "bb": {
        let inner = "";
        for (const ch of renderNodes(n.body).replace(/<[^>]*>/g, "")) {
          inner += DOUBLE_STRUCK[ch] || '<span class="rv-mbb">' + esc(ch) + "</span>";
        }
        return '<span class="rv-mrm">' + inner + "</span>";
      }
      case "frac":
        return (
          '<span class="rv-mfrac"><span class="rv-mnum">' +
          renderNodes(n.num) +
          '</span><span class="rv-mden">' +
          renderNodes(n.den) +
          "</span></span>"
        );
      /* 二项式系数：借分式的叠放骨架，去掉中间那条分数线（.rv-mbinom-f） */
      case "binom":
        return (
          '<span class="rv-mbinom">' +
          '<span class="rv-mdelim rv-mdelim-big">(</span>' +
          '<span class="rv-mfrac rv-mbinom-f"><span class="rv-mnum">' +
          renderNodes(n.num) +
          '</span><span class="rv-mden">' +
          renderNodes(n.den) +
          "</span></span>" +
          '<span class="rv-mdelim rv-mdelim-big">)</span>' +
          "</span>"
        );
      case "sqrt": {
        const idx = n.idx && n.idx.length
          ? '<sup class="rv-msqrt-idx">' + renderNodes(n.idx) + "</sup>"
          : "";
        return (
          '<span class="rv-msqrt">' +
          idx +
          '<span class="rv-msqrt-sign">√</span>' +
          '<span class="rv-msqrt-body">' +
          renderNodes(n.body) +
          "</span></span>"
        );
      }
      case "script": {
        let scripts = "";
        if (n.sup && n.sup.length)
          scripts += '<span class="rv-msup">' + renderNodes(n.sup) + "</span>";
        if (n.sub && n.sub.length)
          scripts += '<span class="rv-msub">' + renderNodes(n.sub) + "</span>";
        if (!scripts) return n.base ? renderNode(n.base) : "";
        return (
          '<span class="rv-mscript"><span class="rv-mscript-b">' +
          (n.base ? renderNode(n.base) : "") +
          '</span><span class="rv-mscripts">' +
          scripts +
          "</span></span>"
        );
      }
      case "env":
        return renderEnv(n);
      default:
        return "";
    }
  }

  const ENV_DELIMS = {
    pmatrix: ["(", ")"],
    bmatrix: ["[", "]"],
    Bmatrix: ["{", "}"],
    vmatrix: ["|", "|"],
    Vmatrix: ["‖", "‖"],
    cases: ["{", ""],
    dcases: ["{", ""],
  };

  function renderEnv(n) {
    const d = ENV_DELIMS[n.name] || ["", ""];
    const cases = n.name === "cases" || n.name === "dcases";
    let rows = "";
    for (const row of n.rows || []) {
      let cells = "";
      row.forEach((cell, ci) => {
        const cls = cases && ci > 0 ? "rv-mcell rv-mcell-l" : "rv-mcell";
        cells += '<span class="' + cls + '">' + renderNodes(cell) + "</span>";
      });
      rows += '<span class="rv-mrow">' + cells + "</span>";
    }
    return (
      '<span class="rv-menv' + (cases ? " rv-mcases" : "") + '">' +
      (d[0] ? '<span class="rv-mdelim rv-mdelim-big">' + esc(d[0]) + "</span>" : "") +
      '<span class="rv-mtable">' + rows + "</span>" +
      (d[1] ? '<span class="rv-mdelim rv-mdelim-big">' + esc(d[1]) + "</span>" : "") +
      "</span>"
    );
  }

  /* ============================ 4. 对外入口 ============================ */

  /* ---- 公式主体渲染：KaTeX 优先，失败 / 缺失回退自研子集 ---- */

  /* KaTeX 路径：返回内部 HTML；katex 缺失或抛错时返回 null 交给回退渲染器。
     trust:false 防 \href / \htmlClass 注入；throwOnError:false 让错公式渲染成红字而非抛错。 */
  function katexInner(raw, display) {
    const katex = global.katex;
    if (!katex || typeof katex.renderToString !== "function") return null;
    try {
      const html = katex.renderToString(raw, {
        displayMode: display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
      });
      return html ? String(html) : null;
    } catch (_) {
      return null;
    }
  }

  /* 回退路径：自研子集渲染器（解析 / 排版全在本地，无外部依赖） */
  function subsetInner(raw) {
    try {
      return renderNodes(parseList(raw, 0).nodes);
    } catch (_) {
      return '<span class="rv-mcmd">' + esc(raw) + "</span>";
    }
  }

  function latexToHtml(tex, opt) {
    const o = opt || {};
    const display = !!o.display;
    /* 原文用哪种定界符（$ / $$ / \( / \[）贴在根节点上：审阅层回写 Markdown 时按它还原，
       用户源码是 `\[…\]` 就不会被改成 `$$…$$`。 */
    const delim = o.delim === "\\(" || o.delim === "\\[" || o.delim === "$$" || o.delim === "$"
      ? o.delim
      : display ? "$$" : "$";
    const raw = String(tex == null ? "" : tex).trim();
    if (!raw) return "";
    /* rv-legacy 只标在回退结果上：css/review.css 的 .rv-m* 自研字形规则都收在
       `.rv-math.rv-legacy` 之下，KaTeX 路径不再叠加（否则重复 margin / 字号 / 上下标位置）。 */
    const katexHtml = katexInner(raw, display);
    const inner = katexHtml || subsetInner(raw);
    return (
      '<span class="rv-math' + (katexHtml ? "" : " rv-legacy") + (display ? " rv-math-display" : "") +
      '" data-rv-tex="' + escAttr(raw) +
      '" data-rv-display="' + (display ? "1" : "0") +
      '" data-rv-delim="' + escAttr(delim) +
      '" contenteditable="false" role="math">' +
      inner +
      "</span>"
    );
  }

  /* ---- Markdown：抽出公式 → 占位符 → 交给 parseFn → 换回渲染结果 ---- */

  /* `$ … $`（内侧带空白）是否算公式：内侧留白时更保守，避免金额 / 中文片段被误判。
     判定 = 不含汉字与全角标点，且（有 LaTeX 命令或数学运算符，或整体是拉丁字母变量式）。
     「价格 $100 到 $200 元」里取到的 `100 到` 含汉字 → 判否、原样留着；
     `$ x^2 $` / `$ a+b $` 这类带空白的真公式照常渲染。 */
  function looksLikeMath(tex) {
    const t = String(tex == null ? "" : tex).trim();
    if (!t) return false;
    if (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(t)) return false;
    if (/[\\^_{}=<>]|[+\-*/|]/.test(t)) return true;
    return /^[A-Za-z][A-Za-z0-9'’,\s]*$/.test(t);
  }

  /* 登记一条公式并返回占位符；tex 为空或含换行（行内式）时返回 null（调用方原样回填） */
  function pushMath(items, tex, display, delim) {
    const t = String(tex == null ? "" : tex).trim();
    if (!t || /[\n]/.test(tex)) return null;
    const tok = tokenOf(items.length);
    items.push({ tex: t, display: !!display, delim: delim });
    return tok;
  }

  function scanInline(line, items) {
    let out = "";
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      /* 行内代码 `…` 原样保留（里面的 $ 不是公式） */
      if (ch === "`") {
        const m = /^`+/.exec(line.slice(i));
        const mark = m[0];
        const close = line.indexOf(mark, i + mark.length);
        if (close < 0) {
          out += line.slice(i);
          break;
        }
        out += line.slice(i, close + mark.length);
        i = close + mark.length;
        continue;
      }
      /* `\(…\)` / `\[…\]`：AI 产出与 PDF 转 Markdown 高频写法（前者行内、后者显示式） */
      if (ch === "\\" && (line[i + 1] === "(" || line[i + 1] === "[")) {
        const disp = line[i + 1] === "[";
        const closer = disp ? "\\]" : "\\)";
        const close = line.indexOf(closer, i + 2);
        if (close > i + 2) {
          const tok = pushMath(items, line.slice(i + 2, close), disp, disp ? "\\[" : "\\(");
          if (tok) {
            out += tok;
            i = close + 2;
            continue;
          }
        }
      }
      if (ch === "\\" && (line[i + 1] === "$" || line[i + 1] === "`" || line[i + 1] === "\\")) {
        out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "$") {
        const disp = line[i + 1] === "$";
        const open = disp ? 2 : 1;
        const close = line.indexOf(disp ? "$$" : "$", i + open);
        if (close > i + open) {
          const tex = line.slice(i + open, close);
          /* 行内 `$…$` 按通行口径要求紧贴内容（开 $ 后、闭 $ 前不得是空白）：
             「价格 $100 到 $200」这类金额不会被误判成公式；
             `$$…$$` 是显示公式，允许内侧留白。 */
          const hug = disp || (!/^\s/.test(tex) && !/\s$/.test(tex)) || looksLikeMath(tex);
          const tok = hug ? pushMath(items, tex, disp, disp ? "$$" : "$") : null;
          if (tok) {
            out += tok;
            i = close + open;
            continue;
          }
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  /**
   * 把 Markdown 里的公式抽成占位符。
   * 围栏代码块（``` / ~~~）与行内代码内的 $ 一律不动；
   * `$$…$$` 与 `\[…\]` 允许跨行（显示公式），未闭合就原样回填；
   * 每条 item 带 delim（"$" / "$$" / "\\(" / "\\["），回写时按原写法还原。
   */
  function splitMath(markdown) {
    const src = String(markdown == null ? "" : markdown);
    const items = [];
    const lines = src.split("\n");
    const out = [];
    let fence = "";
    let pending = null; /* 跨行显示公式：{ closer, delim, lines } */

    for (const line of lines) {
      if (pending) {
        const close = line.indexOf(pending.closer);
        if (close < 0) {
          pending.lines.push(line);
          continue;
        }
        pending.lines.push(line.slice(0, close));
        const tex = pending.lines.join("\n").trim();
        const tail = line.slice(close + pending.closer.length);
        const open = pending.delim === "\\[" ? "\\[" : "$$";
        const seg = tex
          ? tokenOf(items.length) + tail
          : open + pending.lines.join("\n") + pending.closer + tail;
        if (tex) items.push({ tex: tex, display: true, delim: pending.delim });
        pending = null;
        out.push(seg);
        continue;
      }
      if (fence) {
        out.push(line);
        if (new RegExp("^\\s*" + fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$").test(line))
          fence = "";
        continue;
      }
      const fm = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fm) {
        fence = fm[1];
        out.push(line);
        continue;
      }
      const trimmed = line.replace(/^\s+/, "");
      /* 行首开显示公式：`$$…$$` 与 `\[…\]`（同一行闭合就单行处理，否则开跨行累积） */
      const openTok =
        trimmed.slice(0, 2) === "$$" ? "$$" :
          trimmed.slice(0, 2) === "\\[" ? "\\[" : "";
      if (openTok) {
        const closer = openTok === "$$" ? "$$" : "\\]";
        const rest = trimmed.slice(openTok.length);
        const close = rest.indexOf(closer);
        if (close >= 0) {
          const tex = rest.slice(0, close).trim();
          out.push(tex
            ? tokenOf(items.length) + rest.slice(close + closer.length)
            : line);
          if (tex) items.push({ tex: tex, display: true, delim: openTok });
        } else {
          pending = { closer: closer, delim: openTok, lines: [rest] };
        }
        continue;
      }
      out.push(scanInline(line, items));
    }
    if (pending)
      out.push(
        (pending.delim === "\\[" ? "\\[" : "$$") + pending.lines.join("\n"),
      );
    return { md: out.join("\n"), items: items };
  }

  /**
   * Markdown 全文 → HTML（公式已渲染）。
   * parseFn 由调用方给（审查层给 marked.parse），无 parseFn / 失败时退化为转义段落。
   */
  function mdToHtml(markdown, parseFn) {
    const r = splitMath(markdown);
    let html = "";
    if (typeof parseFn === "function") {
      try {
        html = String(parseFn(r.md) || "");
      } catch (_) {
        html = "";
      }
    }
    if (!html) html = "<p>" + esc(r.md) + "</p>";
    if (!r.items.length) return html;
    return html.replace(TOKEN_RE, (m, idx) => {
      const it = r.items[Number(idx)];
      if (!it) return "";
      return latexToHtml(it.tex, { display: it.display, delim: it.delim });
    });
  }

  /* 序列化辅助：从渲染根节点读回原始 LaTeX / 是否显示式 / 原定界符 */
  function texAttrsOf(el) {
    if (!el || !el.getAttribute) return null;
    const tex = el.getAttribute("data-rv-tex");
    if (tex == null) return null;
    const display = el.getAttribute("data-rv-display") === "1";
    const d = el.getAttribute("data-rv-delim");
    const delim = d === "\\(" || d === "\\[" || d === "$$" || d === "$"
      ? d
      : display ? "$$" : "$";
    return { tex: String(tex), display: display, delim: delim };
  }

  const api = {
    latexToHtml: latexToHtml,
    mdToHtml: mdToHtml,
    splitMath: splitMath,
    texAttrsOf: texAttrsOf,
    TOKEN_RE: TOKEN_RE,
    GREEK: GREEK,
    OP_SYMBOLS: OP_SYMBOLS,
    BIG_OP_SYMBOLS: BIG_OP_SYMBOLS,
  };

  global.MTMathRender = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof window !== "undefined"
    ? window
    : typeof globalThis !== "undefined"
      ? globalThis
      : this,
);

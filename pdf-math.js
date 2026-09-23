'use strict';

/**
 * pdf-math.js — PDF 公式识别与 LaTeX 还原（零依赖，CommonJS）
 *
 * 被 pdf-doc.js 复用：把 PDF 抽出的文本 run 序列里的数学区间识别出来（按字体族
 * Cambria Math / CMMI / CMSY… + 字号变化 + 基线偏移），把 Unicode 数学符号按
 * 映射表还原成 LaTeX 命令，输出 `$…$`（行内）与 `$$…$$`（显示式）包围的 Markdown，
 * 让下游纯文本节点与 .md 保存拿到可直接渲染的公式源。
 *
 * run 契约（字段名做了别名兼容，pdf-doc.js 给其中一组即可）：
 *   {
 *     text  : string        // 必需，该 run 的文本
 *     font  : string        // 字体名；别名 fontName / name
 *     size  : number        // 字号（pt）；别名 fontSize / height
 *     x     : number        // 左端 x；别名 left / origin
 *     y     : number        // 基线 y；别名 baselineY / baseline / top
 *     w     : number        // 可选宽度；别名 width
 *     math  : boolean       // 可选：pdf-doc.js 自己已判定为数学区间
 *   }
 * 坐标方向：默认 baselineAxis='down'（y 向下增大，与 pdf.js viewport 一致，
 * 即屏幕坐标）；PDF 原始矩阵坐标（y 向上）传 'up'。
 *
 * 主入口：
 *   restoreMath(runsOrText[, options]) -> string
 */

/* ============================ 一、数学字体识别 ============================ */

// 强数学族：命中即判数学（含 Big Operator / 符号字体）
const MATH_FONT_RE = new RegExp(
  [
    'cambria\\s*math',
    'cmmi', 'cmsy', 'cmex', 'cmbsy', 'cmmib', 'cmbex',
    'msam', 'msbm',
    'mathematical',
    'stix',
    'latin\\s*modern\\s*math', 'latinmodern-math',
    'xits',
    'asana',
    'euclid',
    'euler',
    'mathjax',
    'symbol',
    'mt\\s*extra',
    '\\bmath\\b',
    'math\\s*italic',
    'letter\\s*gothic',
    'tex\\s*gyre\\s*math',
  ].join('|'),
  'i'
);

// 弱数学族：正文与公式都可能用的 TeX 文本字体，需配合符号密度或上下文
const WEAK_MATH_FONT_RE = /(^|[^a-z])(cmr|cmbx|cmti|cmss|cmtt|lmr|lmodern|latin\s*modern\s*roman)/i;

function isMathFont(fontName) {
  if (!fontName) return false;
  return MATH_FONT_RE.test(String(fontName));
}

/* ============================ 二、Unicode→LaTeX 映射表 ============================ */

const MATH_SYMBOL_MAP = {
  /* —— 希腊小写 —— */
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ',
  'ε': '\\epsilon ', 'ϵ': '\\epsilon ', 'ζ': '\\zeta ', 'η': '\\eta ',
  'θ': '\\theta ', 'ϑ': '\\vartheta ', 'ι': '\\iota ', 'κ': '\\kappa ',
  'λ': '\\lambda ', 'μ': '\\mu ', 'µ': '\\mu ', 'ν': '\\nu ', 'ξ': '\\xi ',
  'ο': 'o', 'π': '\\pi ', 'ϖ': '\\varpi ', 'ρ': '\\rho ', 'ϱ': '\\varrho ',
  'σ': '\\sigma ', 'ς': '\\varsigma ', 'τ': '\\tau ', 'υ': '\\upsilon ',
  'φ': '\\phi ', 'ϕ': '\\varphi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'ω': '\\omega ',
  /* —— 希腊大写 —— */
  'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ',
  'Ξ': '\\Xi ', 'Π': '\\Pi ', 'Σ': '\\Sigma ', 'Υ': '\\Upsilon ',
  'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega ',
  '∇': '\\nabla ',
  /* —— 运算与算符 —— */
  '±': '\\pm ', '∓': '\\mp ', '×': '\\times ', '÷': '\\div ', '∕': '/',
  '⋅': '\\cdot ', '·': '\\cdot ', '∗': '\\ast ', '⋆': '\\star ',
  '∘': '\\circ ', '∙': '\\bullet ', '⊕': '\\oplus ', '⊖': '\\ominus ',
  '⊗': '\\otimes ', '⊘': '\\oslash ', '⊙': '\\odot ', '⊛': '\\circledast ',
  '⊝': '\\circleddash ', '⊞': '\\boxplus ', '⊟': '\\boxminus ',
  '⊠': '\\boxtimes ', '⊡': '\\boxdot ', '⋄': '\\diamond ',
  '△': '\\triangle ', '▽': '\\triangledown ', '□': '\\square ',
  '■': '\\blacksquare ', '◇': '\\diamondsuit ', '♠': '\\spadesuit ',
  '♣': '\\clubsuit ', '♥': '\\heartsuit ', '†': '\\dagger ', '‡': '\\ddagger ',
  '−': '-', '－': '-',
  '∑': '\\sum ', '∏': '\\prod ', '∐': '\\coprod ', '∫': '\\int ',
  '∬': '\\iint ', '∭': '\\iiint ', '∮': '\\oint ', '∯': '\\oiint ',
  '⋁': '\\bigvee ', '⋀': '\\bigwedge ', '⋂': '\\bigcap ', '⋃': '\\bigcup ',
  '⨁': '\\bigoplus ', '⨂': '\\bigotimes ', '⨀': '\\bigodot ',
  '⨄': '\\biguplus ', '⨆': '\\bigsqcup ',
  '√': '\\sqrt{}', '∛': '\\sqrt[3]{}', '∜': '\\sqrt[4]{}',
  '∞': '\\infty ', '∂': '\\partial ',
  /* —— 关系符 —— */
  '≤': '\\le ', '≥': '\\ge ', '≠': '\\ne ', '≈': '\\approx ', '≃': '\\simeq ',
  '≅': '\\cong ', '≡': '\\equiv ', '∼': '\\sim ', '≁': '\\nsim ',
  '∝': '\\propto ', '≪': '\\ll ', '≫': '\\gg ', '≺': '\\prec ',
  '≻': '\\succ ', '⪯': '\\preceq ', '⪰': '\\succeq ', '⊂': '\\subset ',
  '⊃': '\\supset ', '⊆': '\\subseteq ', '⊇': '\\supseteq ',
  '⊄': '\\nsubset ', '⊈': '\\nsubseteq ', '∈': '\\in ', '∋': '\\ni ',
  '∉': '\\notin ', '∌': '\\notni ', '⊥': '\\perp ', '∥': '\\parallel ',
  '∦': '\\nparallel ', '≐': '\\doteq ', '≍': '\\asymp ', '⌣': '\\smile ',
  '⌢': '\\frown ', '⊨': '\\models ', '⊢': '\\vdash ', '⊣': '\\dashv ',
  '⊩': '\\Vdash ', '∴': '\\therefore ', '∵': '\\because ', '≜': '\\triangleq ',
  '≝': '\\stackrel{\\mathrm{def}}{=}',
  /* —— 箭头 —— */
  '→': '\\to ', '←': '\\leftarrow ', '↑': '\\uparrow ', '↓': '\\downarrow ',
  '↔': '\\leftrightarrow ', '↕': '\\updownarrow ', '⇀': '\\rightharpoonup ',
  '⇁': '\\rightharpoondown ', '⇒': '\\Rightarrow ', '⇐': '\\Leftarrow ',
  '⇑': '\\Uparrow ', '⇓': '\\Downarrow ', '⇔': '\\Leftrightarrow ',
  '⇕': '\\Updownarrow ', '↦': '\\mapsto ', '↩': '\\hookleftarrow ',
  '↪': '\\hookrightarrow ', '⇌': '\\rightleftharpoons ',
  '⟶': '\\longrightarrow ', '⟵': '\\longleftarrow ',
  '⟹': '\\Longrightarrow ', '⟸': '\\Longleftarrow ',
  '⟺': '\\Longleftrightarrow ', '⇝': '\\rightsquigarrow ', '↝': '\\leadsto ',
  /* —— 集合 / 逻辑 / 特殊 —— */
  '∀': '\\forall ', '∃': '\\exists ', '∄': '\\nexists ', '¬': '\\neg ',
  '∧': '\\wedge ', '∨': '\\vee ', '∅': '\\emptyset ', '⌀': '\\varnothing ',
  '℘': '\\wp ', 'ℓ': '\\ell ', 'ℏ': '\\hbar ', 'ℑ': '\\Im ', 'ℜ': '\\Re ',
  'ℵ': '\\aleph ', 'ℶ': '\\beth ', 'ℷ': '\\gimel ', 'ℸ': '\\daleth ',
  '∖': '\\setminus ', '⊔': '\\sqcup ', '⊓': '\\sqcap ',
  /* —— 括号 / 定界符 —— */
  '⟨': '\\langle ', '⟩': '\\rangle ', '⌈': '\\lceil ', '⌉': '\\rceil ',
  '⌊': '\\lfloor ', '⌋': '\\rfloor ', '‖': '\\| ',
  /* —— 常见分数符号 —— */
  '½': '\\frac{1}{2}', '⅓': '\\frac{1}{3}', '⅔': '\\frac{2}{3}',
  '¼': '\\frac{1}{4}', '¾': '\\frac{3}{4}', '⅕': '\\frac{1}{5}',
  '⅖': '\\frac{2}{5}', '⅗': '\\frac{3}{5}', '⅘': '\\frac{4}{5}',
  '⅙': '\\frac{1}{6}', '⅚': '\\frac{5}{6}', '⅛': '\\frac{1}{8}',
  '⅜': '\\frac{3}{8}', '⅝': '\\frac{5}{8}', '⅞': '\\frac{7}{8}',
  /* —— 花体 / 黑板体 —— */
  'ℝ': '\\mathbb{R}', 'ℂ': '\\mathbb{C}', 'ℕ': '\\mathbb{N}',
  'ℙ': '\\mathbb{P}', 'ℚ': '\\mathbb{Q}', 'ℤ': '\\mathbb{Z}',
  'ℍ': '\\mathbb{H}', '𝔽': '\\mathbb{F}', '𝔸': '\\mathbb{A}',
  '𝔹': '\\mathbb{B}', '𝔻': '\\mathbb{D}', '𝔼': '\\mathbb{E}',
  '𝔾': '\\mathbb{G}', '𝕀': '\\mathbb{I}', '𝕁': '\\mathbb{J}',
  '𝕂': '\\mathbb{K}', '𝕃': '\\mathbb{L}', '𝕄': '\\mathbb{M}',
  '𝕆': '\\mathbb{O}', '𝕊': '\\mathbb{S}', '𝕋': '\\mathbb{T}',
  '𝕌': '\\mathbb{U}', '𝕍': '\\mathbb{V}', '𝕎': '\\mathbb{W}',
  '𝕏': '\\mathbb{X}', '𝕐': '\\mathbb{Y}',
  /* —— 杂项 —— */
  '°': '^{\\circ}', '′': "'", '″': "''", '‴': "'''",
  '…': '\\dots ', '⋯': '\\cdots ', '⋮': '\\vdots ', '⋱': '\\ddots ',
  '⋰': '\\iddots ',
};

// 上标 Unicode
const SUP_MAP = {
  '⁰': '{0}', '¹': '{1}', '²': '{2}', '³': '{3}', '⁴': '{4}', '⁵': '{5}',
  '⁶': '{6}', '⁷': '{7}', '⁸': '{8}', '⁹': '{9}',
  '⁺': '{+}', '⁻': '{-}', '⁼': '{=}', '⁽': '{(}', '⁾': '{)}',
  'ⁿ': '{n}', 'ⁱ': '{i}', 'ᵀ': '{T}', 'ˢ': '{s}', 'ˣ': '{x}', 'ʸ': '{y}',
  'ᵃ': '{a}', 'ᵇ': '{b}', 'ᶜ': '{c}', 'ᵈ': '{d}', 'ᵉ': '{e}', 'ᶠ': '{f}',
  'ᵍ': '{g}', 'ʰ': '{h}', 'ʲ': '{j}', 'ᵏ': '{k}', 'ˡ': '{l}', 'ᵐ': '{m}',
  'ᵒ': '{o}', 'ᵖ': '{p}', 'ʳ': '{r}', 'ᵗ': '{t}', 'ᵘ': '{u}', 'ᵛ': '{v}',
  'ʷ': '{w}', 'ᶻ': '{z}',
};
for (const k of Object.keys(SUP_MAP)) MATH_SYMBOL_MAP[k] = '^' + SUP_MAP[k];

// 下标 Unicode
const SUB_MAP = {
  '₀': '{0}', '₁': '{1}', '₂': '{2}', '₃': '{3}', '₄': '{4}', '₅': '{5}',
  '₆': '{6}', '₇': '{7}', '₈': '{8}', '₉': '{9}',
  '₊': '{+}', '₋': '{-}', '₌': '{=}', '₍': '{(}', '₎': '{)}',
  'ₐ': '{a}', 'ₑ': '{e}', 'ₕ': '{h}', 'ᵢ': '{i}', 'ⱼ': '{j}', 'ₖ': '{k}',
  'ₗ': '{l}', 'ₘ': '{m}', 'ₙ': '{n}', 'ₒ': '{o}', 'ₚ': '{p}', 'ᵣ': '{r}',
  'ₛ': '{s}', 'ₜ': '{t}', 'ᵤ': '{u}', 'ᵥ': '{v}', 'ₓ': '{x}',
};
for (const k of Object.keys(SUB_MAP)) MATH_SYMBOL_MAP[k] = '_' + SUB_MAP[k];

// 常见函数名 → LaTeX 命令（整词命中时使用）
const FUNCTION_COMMANDS = {
  sin: '\\sin ', cos: '\\cos ', tan: '\\tan ', cot: '\\cot ',
  sec: '\\sec ', csc: '\\csc ', arcsin: '\\arcsin ', arccos: '\\arccos ',
  arctan: '\\arctan ', sinh: '\\sinh ', cosh: '\\cosh ', tanh: '\\tanh ',
  log: '\\log ', ln: '\\ln ', lg: '\\lg ', exp: '\\exp ',
  lim: '\\lim ', max: '\\max ', min: '\\min ', sup: '\\sup ', inf: '\\inf ',
  det: '\\det ', dim: '\\dim ', ker: '\\ker ', deg: '\\deg ',
  gcd: '\\gcd ', mod: '\\bmod ', arg: '\\arg ',
};

const SYMBOL_SET = new Set(Object.keys(MATH_SYMBOL_MAP));

/* ============================ 三、字符 → LaTeX ============================ */

function escapeChar(ch) {
  if (/[A-Za-z0-9]/.test(ch)) return ch;
  switch (ch) {
    case ' ': return ' ';
    case '#': return '\\#';
    case '$': return '\\$';
    case '%': return '\\%';
    case '&': return '\\&';
    case '{': return '\\{';
    case '}': return '\\}';
    case '\\': return '\\backslash ';
    case '~': return '\\,';
    default: return ch; // + - = ( ) [ ] , . : ; ! ? / * ' | < > 等数学模式合法
  }
}

/**
 * 把一段文本的 Unicode 数学符号映射成 LaTeX；`^` / `_` 视为上下标记号。
 */
function unicodeToLatex(input, opts) {
  const options = opts || {};
  if (input == null) return '';
  const s = String(input);
  if (options.mapUnicode === false) return s;
  const cps = Array.from(s);
  let out = '';
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    if (ch === '^' || ch === '_') {
      let arg = '';
      let j = i + 1;
      if (cps[j] === '{') {
        let depth = 1;
        j++;
        while (j < cps.length && depth > 0) {
          if (cps[j] === '{') depth++;
          else if (cps[j] === '}') depth--;
          if (depth > 0) arg += cps[j];
          j++;
        }
        arg = unicodeToLatex(arg, options);
      } else if (j < cps.length) {
        arg = unicodeToLatex(cps[j], options);
        j++;
      }
      out += (ch === '^' ? '^{' : '_{') + arg + '}';
      i = j - 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(MATH_SYMBOL_MAP, ch)) {
      out += MATH_SYMBOL_MAP[ch];
      continue;
    }
    out += escapeChar(ch);
  }
  return out;
}

/* ============================ 四、选项与工具 ============================ */

const DEFAULT_OPTIONS = {
  wrap: true, // 是否加 $ / $$ 包围
  displayMode: 'auto', // 'auto' | 'inline' | 'display'
  scriptRatio: 0.82, // 小于基准字号此比例 → 判为上下标
  baselineEpsilon: 0.12, // 基线偏移阈值（相对基准字号）
  baselineAxis: 'down', // 'down' = y 向下增大（pdf.js 视口）；'up' = PDF 原始矩阵
  detectFractions: true, // 还原分式
  detectRadicals: true, // 还原根号
  mapUnicode: true, // Unicode 符号映射
  blockGapRatio: 0.6, // 同一行内 math run 间距 ≤ 该比例×字号 视为连续公式
  mergeBigOperatorLimits: true, // ∑ ∫ ∏ 的上下限（独立成行）回并到大算符
};

function normRun(raw) {
  if (!raw || typeof raw !== 'object') {
    if (typeof raw === 'string') return { text: raw, font: '', size: 0, x: NaN, y: NaN, w: NaN, math: false };
    return null;
  }
  const text = raw.text != null ? String(raw.text)
    : raw.str != null ? String(raw.str)
      : raw.content != null ? String(raw.content) : '';
  const size = num(raw.size, num(raw.fontSize, num(raw.height, 0)));
  const x = num(raw.x, num(raw.left, num(raw.origin, NaN)));
  const y = num(raw.y, num(raw.baselineY, num(raw.baseline, num(raw.top, NaN))));
  const w = num(raw.w, num(raw.width, NaN));
  const font = String(raw.font || raw.fontName || raw.name || '');
  return { text, font, size, x, y, w, math: raw.math === true || raw.isMath === true, latex: raw.latex === true || raw.__latex === true, raw };
}

function num(a, b) {
  return Number.isFinite(a) ? Number(a) : b;
}

function symbolRatio(text) {
  let sym = 0;
  let tot = 0;
  for (const ch of Array.from(String(text || ''))) {
    if (/\s/.test(ch)) continue;
    tot++;
    if (SYMBOL_SET.has(ch)) sym++;
  }
  return tot ? sym / tot : 0;
}

function estWidth(run) {
  if (Number.isFinite(run.w)) return run.w;
  const size = run.size || 10;
  return Array.from(run.text || '').length * size * 0.5;
}

function bodySizeOf(runs) {
  const weight = new Map();
  for (const r of runs) {
    if (!r.size || !r.text) continue;
    const key = Math.round(r.size * 2) / 2;
    weight.set(key, (weight.get(key) || 0) + Array.from(r.text).length);
  }
  let best = 0;
  let bestW = -1;
  for (const [size, w] of weight) {
    if (w > bestW) { bestW = w; best = size; }
  }
  return best || 10;
}

function runIsMath(run, bodySize, opts) {
  if (run.math) return true;
  const font = run.font || '';
  if (MATH_FONT_RE.test(font)) return true;
  const text = run.text || '';
  if (!text.trim()) return false;
  const ratio = symbolRatio(text);
  if (ratio >= 0.34) return true;
  if (WEAK_MATH_FONT_RE.test(font) && ratio >= 0.12) return true;
  return false;
}

/* ============================ 五、分式（版面）识别 ============================ */

const FRAC_BAR_RE = /^[-–—_‒−\u2212\u2010-\u2015]{1,4}$/;

function detectLayoutFractions(runs, bodySize, opts) {
  if (!opts.detectFractions) return runs;
  const usable = runs.some((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
  if (!usable) return runs;

  const used = new Set();
  const synthetic = new Map(); // barIndex -> newRun
  const tolX = bodySize * 0.9;

  for (let i = 0; i < runs.length; i++) {
    const bar = runs[i];
    if (used.has(i)) continue;
    const t = (bar.text || '').trim();
    if (!FRAC_BAR_RE.test(t)) continue;
    if (!Number.isFinite(bar.x) || !Number.isFinite(bar.y)) continue;
    const barW = estWidth(bar);
    const barL = bar.x;
    const barR = bar.x + barW;
    const barC = (barL + barR) / 2;

    const pick = (dir) => {
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < runs.length; j++) {
        if (j === i || used.has(j)) continue;
        const r = runs[j];
        if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
        if (!r.text || !r.text.trim()) continue;
        const dy = r.y - bar.y;
        if (dir < 0 && (dy >= -bodySize * 0.15 || dy < -bodySize * 1.8)) continue;
        if (dir > 0 && (dy <= bodySize * 0.15 || dy > bodySize * 1.8)) continue;
        const rL = r.x;
        const rR = r.x + estWidth(r);
        const overlap = Math.min(barR, rR) - Math.max(barL, rL);
        if (overlap <= 0) continue;
        const rc = (rL + rR) / 2;
        if (Math.abs(rc - barC) > tolX) continue;
        const dist = Math.abs(dy);
        if (dist < bestDist) { bestDist = dist; best = j; }
      }
      return best;
    };

    const ni = pick(-1);
    const di = pick(1);
    if (ni < 0 || di < 0) continue;

    const num = runs[ni];
    const den = runs[di];
    used.add(ni);
    used.add(di);
    used.add(i);
    synthetic.set(i, {
      text: '\\frac{' + unicodeToLatex(num.text, opts) + '}{' + unicodeToLatex(den.text, opts) + '}',
      font: bar.font || 'math',
      size: Math.max(num.size || bodySize, den.size || bodySize, bar.size || 0) || bodySize,
      x: Math.min(num.x, den.x, bar.x),
      y: bar.y,
      w: Math.max(estWidth(num), estWidth(den), barW),
      math: true,
      latex: true,
    });
  }

  const out = [];
  for (let i = 0; i < runs.length; i++) {
    if (synthetic.has(i)) out.push(synthetic.get(i));
    else if (!used.has(i)) out.push(runs[i]);
  }
  return out;
}

/* ============================ 六、行分组与区间切分 ============================ */

function groupLines(runs, bodySize, opts) {
  const tol = bodySize * 0.5;
  const sorted = runs.slice().sort((a, b) => {
    const ay = Number.isFinite(a.y) ? a.y : 0;
    const by = Number.isFinite(b.y) ? b.y : 0;
    if (Math.abs(ay - by) > tol) return ay - by;
    return a.x - b.x;
  });
  const lines = [];
  for (const r of sorted) {
    const y = Number.isFinite(r.y) ? r.y : (lines.length ? lines[lines.length - 1].y : 0);
    const last = lines[lines.length - 1];
    if (last && Math.abs(y - last.y) <= tol) {
      last.runs.push(r);
      last.y = (last.y * (last.runs.length - 1) + y) / last.runs.length;
    } else {
      lines.push({ y, runs: [r] });
    }
  }
  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  if (opts.baselineAxis === 'up') lines.sort((a, b) => b.y - a.y);
  return lines;
}

const BIG_OPERATOR_RE = /[∑∏∐∫∬∭∮∯⋁⋀⋂⋃⨁⨂⨀⨄⨆]/;

// 以这些符号结尾的公式段需要后续操作数（其后紧邻文本段回并）
const OPERAND_END_RE = /[√∛∜=+\-−×÷±∓<>≤≥≈≠≡→←⇒⇔∈∉∋⊂⊃⊆⊇∪∩∖⋅∘⋅⊕⊗∑∏∐∫∮( [ { ⟨⌈⌊,;:|]$/;

function segEndsWithOperand(seg) {
  const runs = seg.runs || [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const t = (runs[i].text || '').replace(/\s+$/, '');
    if (!t) continue;
    return OPERAND_END_RE.test(t.slice(-1));
  }
  return false;
}

// ∑ / ∫ / ∏ 的上下限常单独占一行且与算符水平居中对齐：回并进算符所在行，
// 由 buildLatex 按基线偏移挂成 ^{} / _{}
function mergeBigOperatorLimits(lines, bodySize, opts) {
  if (!opts.mergeBigOperatorLimits) return lines;
  const removed = new Set();
  for (let k = 0; k < lines.length; k++) {
    if (removed.has(k)) continue;
    const line = lines[k];
    const opIdx = line.runs.findIndex((r) => BIG_OPERATOR_RE.test(r.text || ''));
    if (opIdx < 0) continue;
    const op = line.runs[opIdx];
    if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) continue;
    const opL = op.x;
    const opR = op.x + estWidth(op);
    const opC = (opL + opR) / 2;

    const inserts = [];
    for (let j = 0; j < lines.length; j++) {
      if (j === k || removed.has(j)) continue;
      const nb = lines[j];
      if (!Number.isFinite(nb.y)) continue;
      if (Math.abs(nb.y - line.y) > bodySize * 2.2) continue;
      if (!nb.runs.length) continue;
      if (!nb.runs.every((r) => runIsMath(r, bodySize, opts))) continue;
      const xs = nb.runs.filter((r) => Number.isFinite(r.x));
      if (!xs.length) continue;
      const nbL = Math.min(...xs.map((r) => r.x));
      const nbR = Math.max(...xs.map((r) => r.x + estWidth(r)));
      const overlap = Math.min(opR, nbR) - Math.max(opL, nbL);
      const nbW = nbR - nbL;
      const centered = Math.abs((nbL + nbR) / 2 - opC) <= bodySize * 1.2;
      if (overlap <= 0 && !centered) continue;
      if (overlap < Math.min(nbW, estWidth(op)) * 0.3 && !centered) continue;
      inserts.push(nb.runs.slice());
      removed.add(j);
    }
    if (inserts.length) {
      const flat = [];
      for (const ins of inserts) flat.push(...ins);
      line.runs.splice(opIdx + 1, 0, ...flat);
    }
  }
  return lines.filter((_, i) => !removed.has(i));
}

function lineSegments(line, bodySize, opts) {  const segs = [];
  let cur = null;
  for (const r of line.runs) {
    const isM = runIsMath(r, bodySize, opts);
    const type = isM ? 'math' : 'text';
    if (cur && cur.type === type) {
      const gap = r.x - (cur.runs[cur.runs.length - 1].x + estWidth(cur.runs[cur.runs.length - 1]));
      cur.runs.push(r);
      cur.gap = gap;
    } else {
      cur = { type, runs: [r], gap: 0 };
      segs.push(cur);
    }
  }
  // 两侧都是公式、且本身很短的文本段（如 "=" "+" 落在正文字体）并入公式；
  // 公式段若以「待接操作数」的符号（√ ∑ ∫ = …）结尾，其后紧邻的文本段也并入
  const merged = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.type === 'text') {
      const prev = merged[merged.length - 1];
      const next = segs[i + 1];
      const len = Array.from(s.runs.map((r) => r.text).join('')).length;
      const word = s.runs.map((r) => r.text).join('').trim().toLowerCase();
      // 正文字体里的函数名（sin / log / lim …）紧邻公式 → 并入公式
      const nearMath = (next && next.type === 'math')
        || (next && next.type === 'text' && segs[i + 2] && segs[i + 2].type === 'math'
          && Array.from(next.runs.map((r) => r.text).join('')).length <= 2);
      if (Object.prototype.hasOwnProperty.call(FUNCTION_COMMANDS, word) && nearMath) {
        s.type = 'math';
        merged.push(s);
        continue;
      }
      const prevNeedsOperand = prev && prev.type === 'math' && segEndsWithOperand(prev);
      if (prevNeedsOperand || (len <= 2 && prev && prev.type === 'math' && next && next.type === 'math')) {
        prev.runs.push(...s.runs);
        continue;
      }
    }
    merged.push(s);
  }
  // 相邻的公式段（因字体判定跳变而断开）合并为一个区间，保证同一公式只有一个 $…$
  const coalesced = [];
  for (const s of merged) {
    const prev = coalesced[coalesced.length - 1];
    if (s.type === 'math' && prev && prev.type === 'math') {
      prev.runs.push(...s.runs);
      continue;
    }
    coalesced.push(s);
  }
  return coalesced;
}

/* ============================ 七、LaTeX 组装 ============================ */

function takeAtom(s, i) {
  if (s[i] === '{') {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    return { text: s.slice(i + 1, j - 1), end: j };
  }
  if (s[i] === '(') {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    return { text: s.slice(i + 1, j - 1), end: j };
  }
  const m = /^\\[A-Za-z]+/.exec(s.slice(i));
  if (m) return { text: m[0], end: i + m[0].length };
  if (i < s.length) return { text: s[i], end: i + 1 };
  return { text: '', end: i };
}

function bindRadicals(str, opts) {
  if (!opts.detectRadicals) return str;
  let out = '';
  let i = 0;
  while (i < str.length) {
    const m = /^\\sqrt(\[[^\]]*\])?\{\}/.exec(str.slice(i));
    if (m) {
      const head = '\\sqrt' + (m[1] || '');
      i += m[0].length;
      const a = takeAtom(str, i);
      out += head + '{' + a.text + '}';
      i = a.end;
    } else {
      out += str[i];
      i++;
    }
  }
  return out;
}

const FRAC_ATOM = '(?:\\\\[A-Za-z]+(?:\\{[^{}]*\\})*|[A-Za-z0-9]|\\{[^{}]*\\})(?:[\\^_](?:\\{[^{}]*\\}|[A-Za-z0-9]))?';
const FRAC_RE = new RegExp('(' + FRAC_ATOM + ')\\s*\\/\\s*(' + FRAC_ATOM + ')', 'g');

function bindFractions(str, opts) {
  if (!opts.detectFractions) return str;
  let s = str;
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(FRAC_RE, '\\frac{$1}{$2}');
    if (s === before) break;
  }
  return s;
}

function buildLatex(runs, bodySize, opts) {
  const baseSize = runs.reduce((m, r) => Math.max(m, r.size || 0), 0) || bodySize;
  const eps = baseSize * opts.baselineEpsilon;
  const tokens = [];
  let cur = null;

  for (const r of runs) {
    const raw = (r.text || '').trim();
    if (!raw) continue;
    let mapped = r.latex ? r.text : unicodeToLatex(r.text, opts);
    const small = r.size && r.size < baseSize * opts.scriptRatio;
    const isScript = small && Number.isFinite(r.y) && cur && Number.isFinite(cur.y)
      && Math.abs(r.y - cur.y) > eps;

    if (!isScript) {
      // 整词函数名 → LaTeX 命令（sin / cos / lim …）
      const word = raw.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(FUNCTION_COMMANDS, word)) {
        mapped = FUNCTION_COMMANDS[word];
      }
      cur = { base: mapped, sub: '', sup: '', y: Number.isFinite(r.y) ? r.y : 0 };
      tokens.push(cur);
      continue;
    }

    const dy = r.y - cur.y;
    const isSup = opts.baselineAxis === 'up' ? dy > 0 : dy < 0;
    if (isSup) cur.sup += mapped;
    else cur.sub += mapped;
  }

  let body = tokens
    .map((t) => {
      let s = t.base || '';
      if (t.sub) s += '_{' + t.sub + '}';
      if (t.sup) s += '^{' + t.sup + '}';
      return s;
    })
    .join('');

  body = bindRadicals(body, opts);
  body = bindFractions(body, opts);

  const xs = runs.filter((r) => Number.isFinite(r.x));
  const ys = runs.filter((r) => Number.isFinite(r.y));
  const minX = xs.length ? Math.min(...xs.map((r) => r.x)) : 0;
  const maxX = xs.length ? Math.max(...xs.map((r) => r.x + estWidth(r))) : 0;
  const minY = ys.length ? Math.min(...ys.map((r) => r.y)) : 0;
  const maxY = ys.length ? Math.max(...ys.map((r) => r.y)) : 0;
  const width = maxX - minX;
  const height = maxY - minY;

  const hasBig = /\\(sum|prod|coprod|int|iint|iiint|oint|oiint|bigcup|bigcap|bigvee|bigwedge|bigoplus|bigotimes|bigodot|biguplus|bigsqcup|lim)\b/.test(body);
  const display = opts.displayMode === 'display'
    || (opts.displayMode === 'auto'
      && (hasBig || height > baseSize * 0.9 || width > baseSize * 22 || tokens.length >= 14));

  return { latex: body, display };
}

/* ============================ 八、对外主入口 ============================ */

/**
 * 从 run 序列还原公式（几何 + 字体 + 字号 + 基线）。
 */
function restoreFromRuns(runsInput, options) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
  let runs = (Array.isArray(runsInput) ? runsInput : []).map(normRun).filter((r) => r && r.text !== '');
  if (!runs.length) return '';

  const hasGeom = runs.some((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
  if (!hasGeom) return restoreFromText(runs.map((r) => r.text).join(''), opts);

  const bodySize = bodySizeOf(runs);
  // 正文字体里的函数名 → 若其后 1~2 个 run 是数学，则本 run 也判为数学
  for (let i = 0; i < runs.length; i++) {
    const w = (runs[i].text || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FUNCTION_COMMANDS, w)) continue;
    for (let j = i + 1; j < Math.min(i + 3, runs.length); j++) {
      if (runIsMath(runs[j], bodySize, opts)) { runs[i].math = true; break; }
    }
  }
  runs = detectLayoutFractions(runs, bodySize, opts);

  const lines = mergeBigOperatorLimits(groupLines(runs, bodySize, opts), bodySize, opts);
  const outLines = [];
  for (const line of lines) {
    const segs = lineSegments(line, bodySize, opts);
    let lineOut = '';
    for (const seg of segs) {
      if (seg.type === 'text') {
        lineOut += seg.runs.map((r) => r.text).join('');
      } else {
        const built = buildLatex(seg.runs, bodySize, opts);
        if (!built.latex) continue;
        if (!opts.wrap) lineOut += built.latex;
        else if (built.display) lineOut += '\n$$\n' + built.latex.trim() + '\n$$\n';
        else lineOut += '$' + built.latex.trim() + '$';
      }
    }
    outLines.push(lineOut);
  }
  return outLines.join('\n');
}

/**
 * 纯文本兜底：把含数学符号的片段用 $…$ 包起来。
 */
function restoreFromText(text, options) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
  const s = String(text == null ? '' : text);
  const parts = s.split(/(\s+)/);
  const isSymTok = (t) => Array.from(t).some((ch) => SYMBOL_SET.has(ch));
  const isOperand = (t) => /^[0-9]+(\.[0-9]+)?$/.test(t) || /^[A-Za-z]$/.test(t)
    || /^[+\-=<>()[\]{},.|*/^_]+$/.test(t) || isSymTok(t);
  const flag = parts.map((t) => (t.trim() ? isSymTok(t) : false));

  // 把相邻的可作运算对象的片段并入公式区间
  let i = 0;
  while (i < parts.length) {
    if (flag[i]) {
      let a = i;
      while (a - 1 >= 0 && !parts[a - 1].trim()) a--;
      while (a - 1 >= 0 && parts[a - 1].trim() && isOperand(parts[a - 1].trim())) { flag[a - 1] = true; a--; }
      let b = i;
      while (b + 1 < parts.length && !parts[b + 1].trim()) b++;
      while (b + 1 < parts.length && parts[b + 1].trim() && isOperand(parts[b + 1].trim())) { flag[b + 1] = true; b++; }
      i = b + 1;
    } else {
      i++;
    }
  }

  let out = '';
  let buf = '';
  let hasSym = false;
  const flush = () => {
    if (!buf) return;
    if (hasSym && opts.wrap) out += '$' + unicodeToLatex(buf, opts).trim() + '$';
    else if (hasSym) out += unicodeToLatex(buf, opts);
    else out += buf;
    buf = '';
    hasSym = false;
  };
  for (let k = 0; k < parts.length; k++) {
    if (flag[k]) {
      buf += parts[k];
      if (isSymTok(parts[k])) hasSym = true;
    } else {
      flush();
      out += parts[k];
    }
  }
  flush();
  return out;
}

/**
 * 主入口：runsOrText 为 run 数组走几何还原，为字符串走纯文本兜底。
 */
function restoreMath(runsOrText, options) {
  if (Array.isArray(runsOrText)) return restoreFromRuns(runsOrText, options);
  if (runsOrText == null) return '';
  return restoreFromText(runsOrText, options);
}

module.exports = {
  restoreMath,
  restoreFromRuns,
  restoreFromText,
  unicodeToLatex,
  isMathFont,
  MATH_SYMBOL_MAP,
  DEFAULT_OPTIONS,
  // 别名，方便调用方按语义取用
  toLatex: restoreMath,
  restore: restoreMath,
};

"use strict";
/* PDF 分类 · IPC 存在 · 公式 LaTeX 还原 · 公式渲染子集 · 审阅回归
 *   node test/smoke-pdf-math-review.js
 *
 * 钉住：
 *   [1] PDF 分类口径（%PDF- 文件头）与 pdf:probe / pdf:parse IPC（主进程 + preload）
 *       存在，pdf-doc.js 可加载且能把最小合法 PDF 分类出版本 / 页数 / 页面尺寸；
 *   [2] pdf-math.js 的公式还原：数学字体识别、Unicode→LaTeX、几何上下标、版面分式、
 *       纯文本兜底 $…$；
 *   [3] renderer/math-render.js 的 LaTeX 子集渲染（上下标 / 分式 / 根号 / 希腊字母 /
 *       算子 / 矩阵多行 / \text / 未知命令兜底），以及四种定界符 `$…$` / `$$…$$` /
 *       `\(…\)` / `\[…\]` 的抽取（代码块与行内码不动、带汉字段落里的金额不误判）
 *       与 data-rv-tex / data-rv-delim 原样保留；
 *   [4] 审阅回归：markedPreviewHtml / mdToRichHtml 同源走 MTMathRender，富文本序列化
 *       按 data-rv-tex + data-rv-delim 还原原写法（`$…$` / `$$…$$` / `\(…\)` / `\[…\]`），
 *       「让 AI 依据批注修订」的取文保持 Markdown 源码（公式不被破坏）；
 *       既有 smoke-review-revise 口径仍在；
 *   [5] 全站 Markdown 预览（renderer/app.js renderMarkdown，文件预览 / 节点输出 /
 *       会话正文 / 手册 / 搜索共用）也接 MTMathRender：四种定界符都渲染成
 *       .rv-math（含跨行 `\[…\]` 与内侧留白的 `$ x^2 $`），代码块与行内码里的 $ 不动，
 *       金额仍不误判，且仍保留「先转义再解析」口径。
 *   [6] KaTeX 离线内置（renderer/vendor/katex/）双口径：
 *       · 在 vm 沙箱里真加载 katex.min.js → latexToHtml 产出真正的 .katex 排版（行内 /
 *         显示式模式正确 · 无 rv-legacy 回退了子集的标记 · data-rv-tex/display/delim
 *         三属性仍在 · 错误公式不抛异常且出 .katex-error · mdToHtml 无 PUA 残留）；
 *       · 不加载 katex 的沙箱（[3] 段）仍走自研子集回退，结果照旧全绿 —— 双口径。
 *       真实语料回归：「数学」画布 wf_mtyfjw6m「综述」节点正文（12009 字，190 条公式）
 *       从本机数据目录只读读取（不落项目根），走完整 renderMarkdown + KaTeX，断言
 *       抽取出的公式全部渲染（无回退）、可见文本里 LaTeX 命令残留 0、无 .katex-error。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const has = (s, sub) => String(s).indexOf(sub) >= 0;

/* ═══════════ [1] PDF 分类与 IPC 存在 ═══════════ */

console.log("[1] PDF 分类与 IPC 存在");
{
  const main = read("main.js");
  ok(/ipcMain\.handle\(\s*["']pdf:probe["']/.test(main), "main.js 注册 pdf:probe IPC");
  ok(/ipcMain\.handle\(\s*["']pdf:parse["']/.test(main), "main.js 注册 pdf:parse IPC");
  ok(/%PDF-\\d\\\.\\d/.test(main), "main.js 以 %PDF-x.y 文件头做 PDF 分类");
  ok(
    /isPdf:\s*false/.test(main) && /code:\s*"not_pdf"/.test(main),
    "非 PDF 归类：probe=isPdf:false / parse=not_pdf",
  );

  const pre = read("preload.js");
  ok(
    /filePdfInfo:\s*\(arg\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]pdf:probe['"]/.test(pre),
    "preload 暴露 filePdfInfo → pdf:probe",
  );
  ok(
    /fileParsePdf:\s*\(arg\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]pdf:parse['"]/.test(pre),
    "preload 暴露 fileParsePdf → pdf:parse",
  );

  const app = read("renderer/app.js");
  ok(/avi\|pdf\)\$\/i/.test(app), "会话正文链接分类认得 .pdf 扩展名");

  let doc = null;
  try {
    doc = require(path.join(ROOT, "pdf-doc.js"));
  } catch (_) {
    doc = null;
  }
  ok(
    !!doc &&
      typeof doc.pdfToMarkdown === "function" &&
      typeof doc.extractPages === "function" &&
      typeof doc.parsePdfStructure === "function",
    "pdf-doc.js 可加载且导出 pdfToMarkdown / extractPages / parsePdfStructure",
  );

  /* 最小合法 PDF（无 xref，走全文件扫描兜底）→ 分类为 PDF 1.4 / 1 页 / 612×792 */
  const mini = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    "trailer << /Root 1 0 R /Size 4 >>",
    "%%EOF",
    "",
  ].join("\n");
  let st = null;
  try {
    st = doc ? doc.parsePdfStructure(Buffer.from(mini, "latin1")) : null;
  } catch (_) {
    st = null;
  }
  ok(!!st && st.version === "1.4", "最小 PDF 被分类为 PDF 1.4");
  ok(!!st && st.pages === 1, "页数识别为 1");
  ok(
    !!st &&
      st.pageSizes &&
      st.pageSizes[0] &&
      st.pageSizes[0].width === 612 &&
      st.pageSizes[0].height === 792,
    "页面尺寸识别为 612×792",
  );
}

/* ═══════════ [2] 公式 LaTeX 还原（pdf-math.js） ═══════════ */

console.log("\n[2] 公式 LaTeX 还原（pdf-math.js）");
{
  let pm = null;
  try {
    pm = require(path.join(ROOT, "pdf-math.js"));
  } catch (_) {
    pm = null;
  }
  ok(!!pm && typeof pm.restoreMath === "function", "pdf-math.js 可加载并导出 restoreMath");
  if (pm) {
    ok(pm.isMathFont("Cambria Math") === true, "数学字体识别：Cambria Math → 数学");
    ok(pm.isMathFont("Arial") === false, "正文字体识别：Arial → 非数学");

    const u = pm.unicodeToLatex("α+β≤γ");
    ok(
      has(u, "\\alpha") && has(u, "\\beta") && has(u, "\\le") && has(u, "\\gamma"),
      "Unicode 数学符号 → LaTeX 命令",
    );
    ok(has(pm.unicodeToLatex("x²"), "^{2}"), "上标 Unicode ² → ^{2}");

    const sup = pm.restoreMath([
      { text: "x", font: "Cambria Math", size: 12, x: 0, y: 0 },
      { text: "2", font: "Cambria Math", size: 8, x: 8, y: -5 },
    ]);
    ok(has(sup, "^{2}") && has(sup, "x"), "run 几何还原出上标 x^{2}");
    ok(/\$[^$]*x\^\{2\}/.test(sup), "上标公式被 $…$ 包起来");

    const frac = pm.restoreMath([
      { text: "1", font: "Cambria Math", size: 12, x: 0, y: 0 },
      { text: "−", font: "Cambria Math", size: 12, x: 2, y: 7 },
      { text: "2", font: "Cambria Math", size: 12, x: 2, y: 14 },
    ]);
    ok(has(frac, "\\frac{1}{2}"), "版面分式还原为 \\frac{1}{2}");

    const greek = pm.restoreMath([
      { text: "α", font: "Cambria Math", size: 12, x: 0, y: 0 },
      { text: "=", font: "Cambria Math", size: 12, x: 8, y: 0 },
      { text: "β", font: "Cambria Math", size: 12, x: 16, y: 0 },
    ]);
    ok(has(greek, "\\alpha") && has(greek, "\\beta"), "希腊字母 run 还原为 \\alpha / \\beta");

    const tx = pm.restoreMath("面积为 πr²");
    ok(
      /\$[^$]*\\pi r\^\{2\}\$/.test(tx),
      "纯文本兜底把 πr² 包成 $\\pi r^{2}$（不误吞中文）",
    );
    ok(has(tx, "面积为"), "公式区间外的正文原样保留");
  }
}

/* ═══════════ [3] 公式渲染子集（renderer/math-render.js） ═══════════ */

console.log("\n[3] 公式渲染子集（renderer/math-render.js）");
{
  let M = null;
  try {
    M = require(path.join(ROOT, "renderer", "math-render.js"));
  } catch (_) {
    M = null;
  }
  ok(!!M && typeof M.latexToHtml === "function", "math-render.js 可加载并导出 latexToHtml");
  ok(
    !!M && typeof M.mdToHtml === "function" && typeof M.splitMath === "function",
    "导出 mdToHtml / splitMath",
  );
  ok(
    !!M && has(fs.readFileSync(path.join(ROOT, "renderer", "math-render.js"), "utf8"), "MTMathRender"),
    "以 window.MTMathRender 暴露给渲染层",
  );

  if (M) {
    const html = (t, o) => M.latexToHtml(t, o);

    const sup = html("x^2");
    ok(has(sup, 'class="rv-msup"') && has(sup, ">2<"), "上标 x^2 → .rv-msup");
    ok(has(html("a_{i}"), 'class="rv-msub"'), "下标 a_{i} → .rv-msub");
    ok(has(html("x^2+y^2"), 'class="rv-msup"'), "连写公式多处上下标");

    const frac = html("\\frac{a}{b}");
    ok(has(frac, 'class="rv-mnum"') && has(frac, 'class="rv-mden"'), "分式 → 分子 / 分母");

    const sqrt = html("\\sqrt[3]{x+1}");
    ok(has(sqrt, 'class="rv-msqrt-body"') && has(sqrt, 'class="rv-msqrt-idx"'), "根号 \\sqrt[n]{}");

    const greek = html("\\alpha+\\beta");
    ok(has(greek, "α") && has(greek, "β"), "希腊字母 → 字符");

    const ops = html("a\\times b\\le c");
    ok(has(ops, "×") && has(ops, "≤"), "常用算子 / 关系符 → 符号");
    ok(has(html("\\sum_{i=1}^{n}"), "∑"), "大算符 \\sum → ∑");

    const mat = html("\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}");
    ok(has(mat, 'class="rv-mtable"'), "矩阵 → .rv-mtable");
    ok((mat.match(/rv-mrow/g) || []).length === 2, "矩阵 2 行");
    ok((mat.match(/rv-mcell/g) || []).length === 4, "矩阵 2×2 = 4 格");
    ok(has(mat, 'class="rv-mdelim rv-mdelim-big">('), "pmatrix 带圆括号定界符");

    const cases = html("\\begin{cases}x & x>0 \\\\ 0 & x\\le 0\\end{cases}");
    ok(has(cases, "rv-mcases"), "cases 环境");

    ok(has(html("\\text{速度}"), 'class="rv-mtext"'), "\\text{} 直立排版");
    ok(has(html("\\mathbb{R}"), "ℝ"), "\\mathbb{R} → ℝ");

    ok(has(html("\\foo{x}"), "\\foo"), "未知命令原样显示（不崩、不丢）");

    ok(has(sup, 'data-rv-tex="x^2"'), "原始 LaTeX 存在 data-rv-tex（序列化可还原）");
    ok(has(sup, 'data-rv-display="0"'), "行内公式标记 display=0");
    ok(has(html("\\frac{a}{b}", { display: true }), 'data-rv-display="1"'), "显示公式标记 display=1");
    ok(has(html("x", { display: true }), "rv-math-display"), "显示公式带 .rv-math-display");

    /* `$…$` 抽取：代码块 / 行内码里的 $ 不算公式 */
    const sp = M.splitMath(
      "公式 $x^2$ 与\n\n$$\\frac{1}{2}$$\n\n`$no$`\n\n```\n$no$\n```",
    );
    ok(sp.items.length === 2, "只抽出 2 个公式（代码块 / 行内码的 $ 不动）");
    ok(sp.items[0].tex === "x^2" && sp.items[0].display === false, "行内公式 tex 原样保留");
    ok(
      sp.items[1].tex === "\\frac{1}{2}" && sp.items[1].display === true,
      "显示公式（跨行 $$）tex 原样保留",
    );
    ok(has(sp.md, "`$no$`") && has(sp.md, "$no$"), "代码块与行内码原样保留");

    /* 金额不被误判：行内 $ 必须紧贴内容（通行口径），$100 … $200 保持原文 */
    const cur = M.splitMath("价格 $100 到 $200 元");
    ok(cur.items.length === 0, "金额 $100 … $200 不被误判成公式");
    ok(has(cur.md, "$100") && has(cur.md, "$200"), "金额原文原样保留");

    /* AI 产出 / PDF 转 Markdown 常用的 `\(…\)` `\[…\]` 同样抽出（此前只认 $ 两式） */
    const br = M.splitMath("行内 \\(x^2\\)\n\n\\[\n\\frac{a}{b}\n\\]");
    ok(br.items.length === 2, "`\\(…\\)` 与跨行 `\\[…\\]` 都抽出");
    ok(br.items[0].display === false && br.items[0].delim === "\\(", "行内 `\\(…\\)` 记 delim");
    ok(br.items[1].display === true && br.items[1].delim === "\\[", "显示式 `\\[…\\]` 记 delim");
    const brHtml = M.latexToHtml(br.items[1].tex, { display: true, delim: "\\[" });
    ok(has(brHtml, 'data-rv-delim="\\["'), "渲染根节点带原定界符（回写不改写用户源码）");
    ok(
      M.splitMath("`\\(x\\)`").items.length === 0,
      "行内码里的 `\\(…\\)` 不当公式",
    );

    /* 内侧留白的 `$ … $` 仍认公式（带汉字 / 纯金额的片段继续判否） */
    const pad = M.splitMath("$ x^2 $");
    ok(pad.items.length === 1 && pad.items[0].tex === "x^2", "$ x^2 $ 内侧留白仍渲染");
    ok(M.splitMath("$ a+b $").items.length === 1, "$ a+b $ 内侧留白仍渲染");
    ok(
      M.splitMath("价格 $100 到 $200 元").items.length === 0,
      "留白规则放宽后金额仍不误判（含汉字的片段判否）",
    );

    /* 数学画布「综述」等真实文档用到的写法：此前不认识 → 原样显示成 \asymp 这类源码，
       公式看着就像「没渲染」。这一组钉住它们都出排版结果、且没有 rv-mcmd 残留。 */
    const noCmd = (src) => !/rv-mcmd/.test(html(src));
    const asymp = html("\\asymp_q x^q");
    ok(has(asymp, "≍") && noCmd("\\asymp_q x^q"), "\\asymp → ≍（数论文档高频，此前漏成源码）");
    ok(has(html("a\\coloneqq b"), "≔"), "\\coloneqq → ≔");
    ok(has(html("a\\lesssim b"), "≲"), "\\lesssim → ≲");
    ok(
      has(html("\\overline{f(m)}"), "rv-mover") && noCmd("\\overline{f(m)}"),
      "\\overline{} 画上划线（此前漏成 \\overline 字面量）",
    );
    ok(has(html("\\underline{x}"), "rv-munder"), "\\underline{} 画下划线");
    ok(
      has(html("\\tilde{\\mathbb P}(A)"), "rv-macc") &&
        has(html("\\hat{x}"), "rv-macc") &&
        has(html("\\bar{a}"), "rv-macc") &&
        has(html("\\vec{v}"), "rv-macc"),
      "\\tilde / \\hat / \\bar / \\vec 走重音层（.rv-macc）",
    );
    ok(
      has(html("a\\xrightarrow{p}b"), "rv-marrow") && noCmd("a\\xrightarrow{p}b"),
      "\\xrightarrow{p} 带标注箭头（此前漏成源码）",
    );
    /* \substack 是大算符下标里的多行限界：整篇文档里出现上百次，必须真正堆叠 */
    const subst = html("\\sum_{\\substack{n=1\\\\P(n)\\leq x}}f(n)");
    ok(
      has(subst, "rv-mstack") && (subst.match(/rv-mstack-r/g) || []).length === 2 && noCmd("\\sum_{\\substack{n=1\\\\P(n)\\leq x}}f(n)"),
      "\\substack{a\\\\b} 两行堆叠（大算符下标）",
    );
    ok(has(html("x\\tag{4.1}"), "rv-mtag"), "\\tag{4.1} 公式编号右浮动，不混进公式主体");
    ok(
      has(html("\\Big|\\sum a_n\\Big|"), "rv-mdelim-big") &&
        has(html("\\big( x \\big)"), "rv-mdelim-big"),
      "\\big / \\Big 放大的定界符",
    );
    ok(
      has(html("\\operatorname{Li}(x)"), "rv-mtext") &&
        has(html("a\\bmod p"), ">mod<") &&
        has(html("a\\pmod{p}"), "(mod p)") &&
        noCmd("\\operatorname{Li}(x)"),
      "\\operatorname{} / \\bmod / \\pmod{} 直立排版（不印命令名）",
    );
    ok(has(html("\\|x\\|"), "‖"), "\\| 转义为 ‖（范数，此前反斜杠被吞、竖线当定界符）");
    ok(has(html("\\binom{n}{k}"), "rv-mbinom"), "\\binom{n}{k} 二项式系数");
    ok(
      noCmd("\\bigcup_{n}A_n") && noCmd("x\\dots y") && noCmd("\\sum\\limits_{i}"),
      "\\big 前缀不误伤 \\bigcup / \\dots / \\limits",
    );

    /* 逐条钉住整份「综述」原文里的 LaTeX 命令都被认识（真实语料回归：
       此前残留 \asymp ×10 / \overline / \xrightarrow / \substack，公式看着像没渲染） */
    const realCorpus = [
      "\\mathbb{E}\\left|\\sum_{n\\leq x}f(n)\\right|^{2q},\\qquad q\\geq 0,",
      "\\mathbb{E}f(n)\\overline{f(m)}=\\mathbf{1}_{n=m}|f(n)|^2.",
      "\\mathbb{E}\\left|\\sum_{n\\leq x}f(n)\\right|^{2q}\\asymp\\left(\\frac{x}{1+(1-q)\\sqrt{\\log\\log x}}\\right)^{q}.",
      "\\frac{\\sum_{n\\leq x}f(n)}{\\sqrt{\\mathbb{E}|\\sum_{n\\leq x}f(n)|^2}}\\xrightarrow{p}0.",
      "F(s)=\\prod_{p\\leq x}\\left(1-\\frac{f(p)}{p^s}\\right)^{-1}=\\sum_{\\substack{n=1\\\\P(n)\\leq x}}^{\\infty}\\frac{f(n)}{n^s}.",
      "\\mathbb{P}\\left(\\left|\\sum_{n\\leq x}f(n)\\right|\\geq \\lambda\\frac{\\sqrt{x}}{(\\log\\log x)^{1/4}}\\right)\\ll\\frac{\\min\\{\\log\\lambda,\\sqrt{\\log\\log x}\\}}{\\lambda^2}.",
      "e^{-q^2\\log q-q^2\\log\\log(2q)+O(q^2)}\\,x^q\\,\\log^{(q-1)^2}x.\\tag{4.1}",
      "\\tilde{\\mathbb P}(A):=\\frac{\\mathbb E\\mathbf 1_A\\prod_{p\\leq x^{1/e}}a_p}{\\log x}",
    ];
    let corpusBad = [];
    realCorpus.forEach((src) => {
      const outHtml = html(src);
      const ms = outHtml.match(/class="rv-mcmd">([^<]*)</g) || [];
      if (ms.length) corpusBad.push(src.slice(0, 40) + " → " + ms.join(","));
    });
    ok(corpusBad.length === 0, "「综述」真实公式逐条无未识别命令（残留：" + corpusBad.join(" | ") + "）");
    ok(
      M.splitMath(realCorpus.map((s) => "$" + s + "$").join("\n\n")).items.length ===
        realCorpus.length,
      "「综述」真实公式全部被抽成公式项（行内 / 显示式定界符都认出）",
    );

    /* mdToHtml：占位符替换 → 无残留，公式已渲染 */
    const stub = (md) => "<p>" + md + "</p>";
    const out = M.mdToHtml("公式 $\\alpha$ 结束", stub);
    ok(has(out, 'data-rv-tex="\\alpha"') && has(out, "α"), "mdToHtml 渲染行内公式");
    ok(!M.TOKEN_RE.test(out), "占位符已全部替换（无 PUA 残留）");
    M.TOKEN_RE.lastIndex = 0;

    let realMarked = null;
    try {
      const mk = require("marked");
      realMarked = (mk && mk.parse) || (mk && mk.marked && mk.marked.parse) || null;
    } catch (_) {}
    if (realMarked) {
      const real = M.mdToHtml(
        "公式 $\\alpha$ 与\n\n$$\\frac{1}{2}$$\n\n`$no$`",
        (md) => realMarked(md, { gfm: true, breaks: true }),
      );
      ok(has(real, 'data-rv-tex="\\alpha"') && has(real, "α"), "与真实 marked 串联：行内公式渲染");
      ok(has(real, 'data-rv-display="1"'), "与真实 marked 串联：显示公式渲染");
      ok(has(real, "$no$"), "与真实 marked 串联：行内码里的 $ 不动");
    }

    const attrs = M.texAttrsOf({
      getAttribute: (k) =>
        k === "data-rv-tex" ? "x^2" : k === "data-rv-display" ? "1" : null,
    });
    ok(
      !!attrs && attrs.tex === "x^2" && attrs.display === true,
      "texAttrsOf 读回原始 LaTeX / 显示式标记",
    );
  }
}

/* ═══════════ [4] 审阅回归（含公式往返） ═══════════ */

console.log("\n[4] 审阅回归（同源渲染 + 公式往返不破坏）");
{
  const src = read("renderer/app-review.js");
  const markedHits = src.match(/marked\.parse\s*\(/g) || [];
  ok(markedHits.length === 1, "Markdown 只在一处解析（marked.parse 调用唯一）");
  ok(
    /function markedPreviewHtml\(raw\)\s*\{[\s\S]{0,200}rvMarkdownHtml\(raw\)/.test(src),
    "markedPreviewHtml 与富文本同源（rvMarkdownHtml）",
  );
  ok(
    /function mdToRichHtml\(raw\)\s*\{[\s\S]{0,200}rvMarkdownHtml\(raw\)/.test(src),
    "mdToRichHtml 与只读预览同源（rvMarkdownHtml）",
  );
  ok(
    /MTMathRender[\s\S]{0,120}mdToHtml/.test(src),
    "rvMarkdownHtml 走 window.MTMathRender.mdToHtml",
  );
  ok(
    /data-rv-tex/.test(src) && /rvMathElOf/.test(src) && /pushMathMd/.test(src),
    "序列化按 data-rv-tex 还原 LaTeX（inlineToMd / walkBlocks）",
  );
  ok(
    /data-rv-delim/.test(src) && /rvMathMdOf/.test(src),
    "序列化按 data-rv-delim 还原原定界符（$ / $$ / \\( / \\[ 不被改写）",
  );
  ok(/buildRevisionPrompt\(v\.text/.test(src), "「让 AI 依据批注修订」取当前版 Markdown 源码");
  ok(
    /case "mathInline"[\s\S]*?case "mathDisplay"/.test(src) && /reviewMathDialog/.test(src),
    "工具栏 $ / $$ 录入入口与对话框存在",
  );

  /* 样式 + i18n + 加载顺序 */
  const css = read("renderer/css/review.css");
  ok(
    has(css, ".rv-math-display") && has(css, ".rv-mfrac") && has(css, ".rv-mtable"),
    "review.css 补了公式排版样式",
  );
  const i18n = read("renderer/i18n.js");
  const keys = ["行内公式", "显示公式", "插入行内公式", "插入显示公式", "公式（LaTeX）", "插入公式", "公式已插入"];
  let i18nOk = true;
  for (const k of keys) if (!has(i18n, '"' + k + '"')) i18nOk = false;
  ok(i18nOk, "i18n 中英词条齐备（$ / $$ 录入相关）");
  ok(
    /"插入显示公式":\s*"Insert display formula"/.test(i18n),
    "i18n 英文同步（示例：插入显示公式）",
  );
  const html = read("renderer/index.html");
  const atMath = html.indexOf('src="math-render.js"');
  const atReview = html.indexOf('src="app-review.js"');
  ok(atMath >= 0 && atReview >= 0 && atMath < atReview, "index.html 先加载 math-render.js 再 app-review.js");

  /* 既有审阅修订回归（skipCommit 口径）仍在 */
  const regPath = path.join(ROOT, "test", "smoke-review-revise.js");
  ok(fs.existsSync(regPath), "既有 smoke-review-revise.js 仍在");
  ok(has(read("test/smoke-review-revise.js"), "skipCommit"), "既有修订回归口径（skipCommit）未变");

  /* ── 真跑：app-review.js 在沙箱里序列化公式 / 组装修订提示词 ── */
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.document = {
    getElementById: () => null,
    createElement: () => ({
      style: {},
      appendChild() {},
      classList: { add() {}, remove() {}, toggle() {} },
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "app-review.js" });

  const mEl = (tag, attrs, children) => {
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      childNodes: children || [],
      getAttribute: (k) =>
        Object.prototype.hasOwnProperty.call(attrs || {}, k) ? attrs[k] : null,
    };
    return el;
  };
  const mText = (s) => ({ nodeType: 3, textContent: String(s) });
  const mMath = (tex, display) =>
    mEl("span", { "data-rv-tex": tex, "data-rv-display": display ? "1" : "0" });

  const root = { nodeType: 1, tagName: "DIV" };
  root.childNodes = [mEl("p", null, [mMath("\\frac{a}{b}", true)])];
  const blockMd = vm.runInContext("richToMarkdown", sandbox)(root);
  ok(blockMd === "$$\n\\frac{a}{b}\n$$\n", "显示公式序列化回独立 $$…$$ 块");

  const root2 = { nodeType: 1, tagName: "DIV" };
  root2.childNodes = [
    mEl("p", null, [mText("公式 "), mMath("x^2", false), mText(" 结束")]),
  ];
  const inlineMd = vm.runInContext("richToMarkdown", sandbox)(root2);
  ok(inlineMd === "公式 $x^2$ 结束\n", "行内公式序列化回 $…$（前后正文不串）");

  const prompt = vm.runInContext("buildRevisionPrompt", sandbox)(
    "正文 $x^2$ 与 $$\\frac{a}{b}$$ 结束",
    [{ kind: "full", body: "公式下标写错，改一下" }],
  );
  ok(
    has(prompt, "$x^2$") && has(prompt, "$$\\frac{a}{b}$$"),
    "修订提示词里的公式源码原样保留（AI 取文不破坏公式）",
  );
  ok(has(prompt, "公式下标写错，改一下"), "批注正文同时进提示词");
}

/* ═══════════ [5] 全站 Markdown 预览（app.js renderMarkdown）支持公式 ═══════════ */

console.log("\n[5] 全站 Markdown 预览支持公式（renderer/app.js renderMarkdown）");
{
  const appjs = read("renderer/app.js");
  const rmMatch = /function renderMarkdown\(text\)[\s\S]*?\r?\n}\r?\n/.exec(appjs);
  const rmSrc = rmMatch ? rmMatch[0] : "";
  ok(rmSrc.length > 0, "app.js 找到 renderMarkdown");
  ok(
    /window\.MTMathRender/.test(rmSrc) && /splitMath/.test(rmSrc) && /latexToHtml/.test(rmSrc),
    "renderMarkdown 接入 MTMathRender（splitMath 抽取 + latexToHtml 渲染）",
  );
  ok(
    /breaks: true/.test(rmSrc) && /escapeHtml\(text\)/.test(rmSrc),
    "仍保留「先转义再解析」与 breaks:true（聊天口径未被这次改动带偏）",
  );
  ok(
    /html\.replace\(\s*M\.TOKEN_RE/.test(rmSrc),
    "占位符替换回公式（无 PUA 残留）",
  );

  /* 真跑：把 renderMarkdown 原样放进沙箱，接真实的 marked + math-render.js */
  let M = null;
  try {
    M = require(path.join(ROOT, "renderer", "math-render.js"));
  } catch (_) {}
  let realMarked = null;
  try {
    const mk = require("marked");
    realMarked = (mk && mk.parse) || (mk && mk.marked && mk.marked.parse) || null;
  } catch (_) {}
  if (M && realMarked && rmSrc) {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.console = console;
    sandbox.marked = { parse: (md, o) => realMarked(md, o || { gfm: true, breaks: true }) };
    sandbox.window.marked = sandbox.marked;
    sandbox.window.MTMathRender = M;
    sandbox.escapeHtml = (s) =>
      String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    sandbox.linkifyHtml = (h) => String(h || "");
    sandbox.I18n = { t: (s) => String(s) };
    vm.createContext(sandbox);
    vm.runInContext(rmSrc, sandbox, { filename: "app-renderMarkdown.js" });
    const rm = sandbox.renderMarkdown;

    const inline = rm("能量 $E=mc^2$ 结束");
    ok(
      has(inline, 'data-rv-tex="E=mc^2"') && has(inline, "rv-math") && !has(inline, "$E=mc^2$"),
      "行内公式 $E=mc^2$ 渲染成 .rv-math（不再是原文）",
    );
    const display = rm("$$\n\\frac{a}{b}\n$$");
    ok(has(display, "rv-math-display") && has(display, "rv-mfrac"), "显示公式 $$…$$ 独占一行渲染");
    const code = rm("`$no$`\n\n```\n$no$\n```");
    ok(has(code, "$no$"), "代码块 / 行内码里的 $ 不动");
    const money = rm("价格 $100 到 $200 元");
    ok(has(money, "$100") && has(money, "$200") && !has(money, "rv-math"), "金额不被误判成公式");
    /* AI 产出 / PDF 转 Markdown 的高频写法：`\(…\)` 行内 与 `\[…\]` 显示式（含跨行） */
    const bracketInline = rm("结果是 \\(x^2\\) 的");
    ok(
      has(bracketInline, 'data-rv-tex="x^2"') && has(bracketInline, 'data-rv-delim="\\("'),
      "行内 \\(…\\) 渲染成 .rv-math（AI 产出高频写法）",
    );
    const bracketDisplay = rm("\\[\n\\frac{a}{b}\n\\]");
    ok(
      has(bracketDisplay, "rv-math-display") && has(bracketDisplay, "rv-mfrac"),
      "显示式 \\[…\\] 跨行渲染",
    );
    ok(has(rm("$ x^2 $"), "rv-math"), "$ x^2 $ 内侧留白仍渲染（不再被紧贴口径误伤）");
    ok(
      !has(rm("行内码 `\\(x\\)` 原样"), "rv-math"),
      "行内码里的 `\\(…\\)` 不动（与代码块口径一致）",
    );
    const injected = rm("<img src=x onerror=1> $x^2$");
    ok(
      has(injected, "&lt;img") && has(injected, "rv-math"),
      "原始 HTML 仍被转义（注入防护未破），同段公式照常渲染",
    );
    ok(!M.TOKEN_RE.test(inline), "输出无 PUA 占位符残留");
    M.TOKEN_RE.lastIndex = 0;
  }
}

/* ═══════════ [6] KaTeX 离线内置（renderer/vendor/katex/）+ 真实语料回归 ═══════════ */

console.log("\n[6] KaTeX 离线内置 + 真实语料回归（「数学」画布「综述」正文）");
{
  /* 资源与接线：vendor 落盘 + 两个页面都挂 CSS/JS */
  const kdir = path.join(ROOT, "renderer", "vendor", "katex");
  ok(fs.existsSync(path.join(kdir, "katex.min.js")), "renderer/vendor/katex/katex.min.js 已落盘");
  ok(fs.existsSync(path.join(kdir, "katex.min.css")), "renderer/vendor/katex/katex.min.css 已落盘");
  let fontCount = 0;
  try {
    fontCount = fs.readdirSync(path.join(kdir, "fonts")).filter((f) => /\.woff2$/.test(f)).length;
  } catch (_) {}
  ok(fontCount >= 20, "vendor 携带 KaTeX 字体（woff2 " + fontCount + " 个）");
  const cssText = read("renderer/vendor/katex/katex.min.css");
  ok(
    (cssText.match(/url\(fonts\/[^)]+\.woff2\)/g) || []).length >= 20,
    "katex.min.css 的 @font-face 走 fonts/*.woff2 相对路径（打包内可解析）",
  );
  ok(
    has(read("renderer/index.html"), "vendor/katex/katex.min.css") &&
      has(read("renderer/index.html"), "vendor/katex/katex.min.js"),
    "index.html 挂载 KaTeX CSS/JS",
  );
  ok(
    has(read("renderer/pdf-print.html"), "vendor/katex/katex.min.css") &&
      has(read("renderer/pdf-print.html"), "vendor/katex/katex.min.js"),
    "pdf-print.html 同步挂载 KaTeX CSS/JS（否则导出 PDF 公式尺寸错乱）",
  );
  ok(
    /katexInner/.test(read("renderer/math-render.js")) &&
      /renderToString/.test(read("renderer/math-render.js")),
    "math-render.js 后端切到 KaTeX（katexInner / renderToString）",
  );

  /* ── 真跑：在 vm 沙箱里真加载 vendor 的 katex.min.js，再接 math-render.js ── */
  const katexPath = path.join(kdir, "katex.min.js");
  const mathPath = path.join(ROOT, "renderer", "math-render.js");
  let sandbox = null;
  let KM = null;
  if (fs.existsSync(katexPath)) {
    sandbox = {};
    sandbox.window = sandbox;
    sandbox.console = console;
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    vm.createContext(sandbox);
    try {
      vm.runInContext(fs.readFileSync(katexPath, "utf8"), sandbox, { filename: "katex.min.js" });
      vm.runInContext(fs.readFileSync(mathPath, "utf8"), sandbox, { filename: "math-render.js" });
      KM = sandbox.MTMathRender;
    } catch (_) {
      KM = null;
    }
  }
  ok(!!(sandbox && sandbox.katex && typeof sandbox.katex.renderToString === "function"), "vm 沙箱里 KaTeX UMD 正常初始化（renderToString 可用）");
  ok(!!sandbox && /^\d+\.\d+\.\d+/.test(String((sandbox.katex || {}).version || "")), "KaTeX 版本号可读（" + (sandbox && sandbox.katex && sandbox.katex.version) + "）");
  ok(!!KM && typeof KM.latexToHtml === "function", "沙箱内 math-render.js 可就地取到 katex 并导出 latexToHtml");

  if (KM) {
    const inline = KM.latexToHtml("E=mc^2");
    ok(has(inline, 'class="katex"'), "行内公式交给 KaTeX 排版（产出 .katex）");
    ok(!has(inline, "katex-display"), "行内模式不加 .katex-display");
    ok(!has(inline, "rv-legacy"), "KaTeX 路径不带 rv-legacy（不叠加自研子集字形样式）");
    ok(
      !has(inline, "rv-msup") && !has(inline, "rv-mfrac"),
      "KaTeX 路径不再出自研 .rv-m* 字形节点",
    );

    const disp = KM.latexToHtml("\\frac{a}{b}", { display: true, delim: "\\[" });
    ok(has(disp, "katex-display"), "显示式公式走 KaTeX display 模式（.katex-display）");
    ok(has(disp, "rv-math-display"), "显示式仍带 .rv-math-display（包裹层契约不变）");

    /* 往返契约：data-rv-tex / data-rv-display / data-rv-delim 逐字保留 */
    ok(has(inline, 'data-rv-tex="E=mc^2"'), "data-rv-tex 原样保留");
    ok(has(inline, 'data-rv-display="0"') && has(disp, 'data-rv-display="1"'), "data-rv-display 行内 / 显示式正确");
    ok(has(inline, 'data-rv-delim="$"') && has(disp, 'data-rv-delim="\\["'), "data-rv-delim 保留原定界符（$ / \\[）");

    /* 错误公式：throwOnError:false → 不抛异常、出红字（.katex-error），仍包在 rv-math 里 */
    let err = null;
    try {
      err = KM.latexToHtml("\\frac{1}{");
    } catch (_) {
      err = null;
    }
    ok(typeof err === "string" && err.length > 0, "非法 LaTeX 不抛异常（throwOnError:false）");
    ok(has(err, "katex-error") && has(err, 'class="rv-math'), "非法 LaTeX 渲染成 .katex-error 且仍在 rv-math 包裹层内");

    /* 注入防护：trust:false 下 \href / \htmlClass 不被执行 */
    const href = KM.latexToHtml("\\href{javascript:alert(1)}{x}");
    ok(!/href="javascript:/.test(href), "trust:false 不被 \\href 注入（不产出 javascript: 链接）");

    const md = KM.mdToHtml("公式 $\\alpha$ 结束", (s) => "<p>" + s + "</p>");
    ok(has(md, 'class="katex"') && has(md, 'data-rv-tex="\\alpha"'), "mdToHtml 走 KaTeX 且保留 data-rv-tex");
    ok(!KM.TOKEN_RE.test(md), "KaTeX 路径无 PUA 占位符残留");
    KM.TOKEN_RE.lastIndex = 0;
  }

  /* ── 真实语料：「数学」画布 wf_mtyfjw6m「综述」节点正文 ──
     从本机数据目录只读读取（%APPDATA%\\pipeline-console 下的工作流存档），
     不落项目根、不改任何文件；找不到时打印一行说明并跳过（不误判失败）。 */
  const loadCorpus = () => {
    const bases = [];
    if (process.env.MTNODE_USERDATA) bases.push(process.env.MTNODE_USERDATA);
    if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, "pipeline-console"));
    const tries = [];
    for (const b of bases) {
      tries.push(path.join(b, "save", "wf_mtyfjw6m.json"));
      tries.push(path.join(b, "pipeline-console", "save", "wf_mtyfjw6m.json"));
    }
    const pick = (p) => {
      try {
        const wf = JSON.parse(fs.readFileSync(p, "utf8"));
        const nodes = (wf && wf.nodes) || [];
        const node = nodes.find((n) => n && n.title === "综述" && typeof n.text === "string");
        return node && node.text.length > 1000 ? node.text : null;
      } catch (_) {
        return null;
      }
    };
    for (const p of tries) {
      const t = pick(p);
      if (t) return t;
    }
    /* 存档改名也能找到：扫 save 目录里含「综述」节点的 wf 存档（上限 80 个，只读） */
    for (const b of bases) {
      for (const sub of [path.join(b, "save"), path.join(b, "pipeline-console", "save")]) {
        let files = [];
        try {
          files = fs.readdirSync(sub).filter((f) => /^wf_.*\.json$/.test(f)).slice(0, 80);
        } catch (_) {
          continue;
        }
        for (const f of files) {
          const t = pick(path.join(sub, f));
          if (t) return t;
        }
      }
    }
    return null;
  };

  const corpus = loadCorpus();
  if (!corpus) {
    console.log("  --    未在本机数据目录找到 wf_mtyfjw6m「综述」存档，跳过真实语料回归（渲染链路本身已由上条钉住）");
  } else {
    ok(corpus.length > 10000, "「综述」正文读到真实长度（" + corpus.length + " 字）");

    /* 用真 marked + 真 KaTeX 跑完整 renderMarkdown（与页面同一入口、同一口径） */
    const appjs = read("renderer/app.js");
    const rmSrc = (/function renderMarkdown\(text\)[\s\S]*?\r?\n}\r?\n/.exec(appjs) || [""])[0];
    let realMarked = null;
    try {
      const mk = require("marked");
      realMarked = (mk && mk.parse) || (mk && mk.marked && mk.marked.parse) || null;
    } catch (_) {}
    ok(rmSrc.length > 0 && !!realMarked && !!KM, "renderMarkdown + 真 marked + 真 KaTeX 三件套齐备");
    if (rmSrc && realMarked && KM) {
      const sb = {};
      sb.window = sb;
      sb.console = console;
      sb.setTimeout = setTimeout;
      sb.clearTimeout = clearTimeout;
      vm.createContext(sb);
      vm.runInContext(fs.readFileSync(katexPath, "utf8"), sb, { filename: "katex.min.js" });
      vm.runInContext(fs.readFileSync(mathPath, "utf8"), sb, { filename: "math-render.js" });
      sb.marked = { parse: (md, o) => realMarked(md, o || { gfm: true, breaks: true }) };
      sb.escapeHtml = (s) =>
        String(s == null ? "" : s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      sb.linkifyHtml = (h) => String(h || "");
      sb.I18n = { t: (s) => String(s) };
      vm.runInContext(rmSrc, sb, { filename: "app-renderMarkdown.js" });
      const html = sb.renderMarkdown(corpus);

      const expect = sb.MTMathRender.splitMath(corpus).items.length;
      const got = (html.match(/data-rv-tex=/g) || []).length;
      ok(expect > 150, "「综述」抽出公式数量符合预期（" + expect + " 条，>150）");
      ok(got === expect, "抽出的公式全部渲染（渲染 " + got + " / 抽出 " + expect + "）");

      /* 可见文本里的 LaTeX 命令 = 0：MathML 的 <annotation> 是隐藏的原文备份，
         统计前先摘掉，剩下才是用户真正看得见的字形（KaTeX 已排版 → 无 \asymp 这类源码） */
      const visible = html
        .replace(/<annotation[\s\S]*?<\/annotation>/g, "")
        .replace(/<[^>]*>/g, "");
      const residue = visible.match(/\\[a-zA-Z]+/g) || [];
      ok(
        residue.length === 0,
        "可见文本里 LaTeX 命令残留 0（实际 " + residue.length + "：" + [...new Set(residue)].slice(0, 8).join(",") + "）",
      );
      ok(
        (html.match(/katex-error/g) || []).length === 0,
        "无 .katex-error（没有任何公式被 KaTeX 判失败）",
      );
      ok(!/rv-legacy/.test(html), "整篇走 KaTeX 路径（未回退自研子集）");
      ok((html.match(/katex-display/g) || []).length > 0, "文中的显示式公式（\\[…\\]）渲染成 .katex-display");
      ok(!sb.MTMathRender.TOKEN_RE.test(html), "整篇输出无 PUA 占位符残留");
      sb.MTMathRender.TOKEN_RE.lastIndex = 0;
    }
  }
}

console.log(
  "\n" + (fails ? "FAIL" : "PASS") + " — " + checks + " 项，失败 " + fails + " 项",
);
process.exit(fails ? 1 : 0);

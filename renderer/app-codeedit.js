"use strict";
/* ============================================================
 * 函数节点的轻量 JS 代码编辑器（渲染层 · 纯自研，零第三方依赖）
 * ------------------------------------------------------------
 * 对外三件套（脚本顶层函数声明即全局，供 app-canvas.js 节点卡片与
 * app-tools.js 试跑台共用同一份实现，两边代码口径完全一致）：
 *   · jsTokenize(src)          词法扫描（注释 / 字符串 / 模板串含 ${} 嵌套 /
 *                              正则字面量 / 数字 / 标识符 / 标点），高亮与格式化同源复用
 *   · jsHighlightHtml(src)     逐段 escapeHtml 后包 <span class="jsl-*">，
 *                              转义口径与 app.js 的 escapePromptHl / highlightYamlLine 一致
 *   · formatJsCode(src)        2 空格缩进重排 + switch/case 额外层 + 连续空行折叠
 *                              + 行尾空格清除（末尾不留空行，二次格式化幂等）
 *   · createJsCodeEditor(opts) 行号槽 + 高亮镜像层 + 透明 textarea 的组件，
 *                              镜像同步沿用 .n-text-layered / .n-prompt-hl 那份已验证方案
 *
 * 为什么不引 Monaco / CodeMirror / highlight.js：函数节点的代码量级只有几十行，
 * 自研换来零包体、零额外 CSP 放通、样式完全跟随画布明暗主题，也不会把节点卡片
 * 的拖拽 / 缩放几何搅乱。自动补全 / 跳转 / Lint / 折叠等重功能一律不做。
 *
 * 样式在 css/canvas.css（.js-edit / .js-edit-gutter / .js-edit-hl /
 * .js-edit-input / .jsl-*）：字体度量必须与镜像层逐条钉死相同，否则两层错位。
 * 本文件除 createJsCodeEditor 外不碰 DOM，可被 test/ 下的冒烟脚本直接切片跑。
 * ============================================================ */

/* 高亮镜像层恒定追加的行尾占位（与 app.js PROMPT_HL_TAIL 同一思路：
   两层行位置始终一一对应，滚动位置也能直接照搬） */
const JSL_HL_TAIL = "\n";

const JSL_KEYWORDS = new Set([
  "var","let","const","function","return","if","else","for","while","do",
  "break","continue","switch","case","default","new","delete","typeof",
  "instanceof","in","of","this","super","class","extends","import","export",
  "from","as","async","await","yield","try","catch","finally","throw",
  "void","static","get","set","arguments",
]);

const JSL_LITERALS = new Set([
  "true","false","null","undefined","NaN","Infinity","globalThis","window","document",
]);

/* 函数节点执行契约专用词（js-exec.js：input = { 参数名: 值 }，return 的键 = 出参名） */
const JSL_CONTRACT_WORDS = new Set(["input","values"]);

/* 这些词后面出现 / 只可能是正则字面量，不可能是除法 */
const JSL_REGEX_WORDS = new Set([
  "return","typeof","instanceof","in","of","new","delete","void","case","do",
  "else","yield","await","throw","if","while","switch","finally","&&","||",
]);

/* 与 app.js escapePromptHl 完全同口径（只放 & < >，镜像层里不会出现标签注入） */
function codeEditEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function jslIsWs(c) {
  return (
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v"
  );
}
function jslIsWordStart(c) {
  return !!c && /[\p{L}\p{Nl}_$]/u.test(c);
}
function jslIsWordChar(c) {
  /* 标识符可以含数字（foo1 / $0），必须与数字分支的先后顺序配合好 */
  return !!c && /[\p{L}\p{Nl}\p{Nd}\p{M}_$\u200c\u200d]/u.test(c);
}
function jslIsCloser(c) {
  return c === ")" || c === "]" || c === "}";
}
function jslIsOpener(c) {
  return c === "(" || c === "[" || c === "{";
}

/* 正则字面量启发式：只有「前一个有效 token 不可能是操作数」时才算正则。
   判错只影响一行配色（正则误判最多吞到行尾），不会吞掉整段代码。 */
function jslRegexAllowed(prevChar, prevWord) {
  if (prevWord && JSL_REGEX_WORDS.has(prevWord)) return true;
  if (!prevChar) return true;
  /* 标识符 / 数字 / 小数点结尾 → 那是除号 */
  if (/[\p{L}\p{Nl}_$\d.]/u.test(prevChar)) return false;
  if (prevChar === ")" || prevChar === "]" || prevChar === "}") return false;
  if (prevChar === '"' || prevChar === "'" || prevChar === "`") return false;
  return true;
}

/* ============================================================
 * 词法扫描
 * tokens: { t: "ws"|"com"|"str"|"num"|"word"|"punc", s, e }
 * 模板字符串（含跨行正文与 ${…} 插值）、块注释（含未闭合）都会产出跨行 token，
 * 下游据此判断「某行行首是否落在字面量 / 注释内部」——那几行必须原样保留。
 * ============================================================ */
function jsTokenize(src) {
  const s = String(src == null ? "" : src);
  const n = s.length;
  const toks = [];
  /* 帧栈：code（可选 interp，即 ${…} 内部）与 tpl（模板正文）交替 */
  const frames = [{ k: "code", braces: 0, interp: false }];
  let i = 0;
  let prevChar = "";
  let prevWord = "";
  const push = (t, a, b) => {
    if (b > a) toks.push({ t: t, s: a, e: b });
  };

  while (i < n) {
    const fr = frames[frames.length - 1];

    /* --- 模板字符串正文（可跨行） --- */
    if (fr.k === "tpl") {
      let j = i;
      while (j < n) {
        const ch = s[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "`" || (ch === "$" && s[j + 1] === "{")) break;
        j++;
      }
      push("str", i, j);
      i = j;
      if (i < n && s[i] === "`") {
        push("str", i, i + 1);
        i += 1;
        frames.pop();
        prevChar = "`";
        prevWord = "";
      } else if (i < n) {
        push("str", i, i + 2); // "${" 按模板色，不参与括号深度
        i += 2;
        frames.push({ k: "code", braces: 0, interp: true });
        prevChar = "";
        prevWord = "";
      }
      continue;
    }

    const c = s[i];

    if (jslIsWs(c)) {
      let j = i + 1;
      while (j < n && jslIsWs(s[j])) j++;
      push("ws", i, j);
      i = j;
      continue;
    }

    /* --- 注释 --- */
    if (c === "/" && s[i + 1] === "/") {
      let j = i + 2;
      while (j < n && s[j] !== "\n") j++;
      push("com", i, j);
      i = j;
      prevChar = "/";
      prevWord = "";
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(s[j] === "*" && s[j + 1] === "/")) j++;
      const e = Math.min(n, j + 2);
      push("com", i, e); // 未闭合时吞到结尾（格式化会把后续行按原样保留）
      i = e;
      prevChar = "/";
      prevWord = "";
      continue;
    }

    /* --- 单 / 双引号字符串：裸换行即截断（反斜杠续行除外） --- */
    if (c === '"' || c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const ch = s[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "\n" || ch === "\r") break;
        if (ch === c) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      push("str", i, j);
      i = j;
      prevChar = closed ? c : "";
      prevWord = "";
      continue;
    }

    /* --- 模板字符串起始 --- */
    if (c === "`") {
      push("str", i, i + 1);
      i += 1;
      frames.push({ k: "tpl" });
      prevChar = "";
      prevWord = "";
      continue;
    }

    /* --- 正则字面量（启发式，见 jslRegexAllowed） --- */
    if (c === "/" && jslRegexAllowed(prevChar, prevWord)) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const ch = s[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "\n") break;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          ok = true;
          j++;
          break;
        }
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/i.test(s[j])) j++; // 标志位 gimsuy
        push("str", i, j);
        i = j;
        prevChar = "/";
        prevWord = "";
        continue;
      }
      /* 判定失败 → 回落到标点（当除号），i 未推进 */
    }

    /* --- 数字 --- */
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] || ""))) {
      let j = i;
      if (c === "0" && /[xXbBoO]/.test(s[i + 1] || "")) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(s[j])) j++;
      } else {
        while (j < n && /[\d_]/.test(s[j])) j++;
        if (s[j] === ".") {
          j++;
          while (j < n && /[\d_]/.test(s[j])) j++;
        }
        if (/[eE]/.test(s[j] || "")) {
          let k = j + 1;
          if (/[+-]/.test(s[k] || "")) k++;
          if (/\d/.test(s[k] || "")) {
            while (k < n && /\d/.test(s[k])) k++;
            j = k;
          }
        }
      }
      if (s[j] === "n") j++; // BigInt
      push("num", i, j);
      i = j;
      prevChar = "0";
      prevWord = "";
      continue;
    }

    /* --- 标识符 / 关键字 --- */
    if (jslIsWordStart(c)) {
      let j = i + 1;
      while (j < n && jslIsWordChar(s[j])) j++;
      push("word", i, j);
      prevWord = s.slice(i, j);
      prevChar = s[j - 1];
      i = j;
      continue;
    }

    /* --- ${…} 插值收尾：与 "${" 同色，不参与括号深度 --- */
    if (c === "}" && fr.interp && fr.braces === 0) {
      push("str", i, i + 1);
      i += 1;
      frames.pop();
      prevChar = "`";
      prevWord = "";
      continue;
    }

    /* --- 标点 / 运算符（逐字符出 token，渲染时同类合并） --- */
    if (c === "{") fr.braces++;
    else if (c === "}" && fr.braces > 0) fr.braces--;
    push("punc", i, i + 1);
    i += 1;
    prevChar = c;
    prevWord = "";
  }

  return toks;
}

/* ============================================================
 * 高亮：token → <span class="jsl-*">…</span>
 * ============================================================ */
function jsHighlightHtml(src) {
  const s = String(src == null ? "" : src);
  if (!s) return "";
  const toks = jsTokenize(s);
  const len = toks.length;
  /* 前后最近一个非空白 token，用于「函数调用名 / 属性名 / 对象键」判定 */
  const prevIdx = new Array(len);
  const nextIdx = new Array(len);
  let p = -1;
  for (let k = 0; k < len; k++) {
    prevIdx[k] = p;
    if (toks[k].t !== "ws") p = k;
  }
  p = -1;
  for (let k = len - 1; k >= 0; k--) {
    nextIdx[k] = p;
    if (toks[k].t !== "ws") p = k;
  }
  const textAt = (k) => (k >= 0 ? s.slice(toks[k].s, toks[k].e) : "");

  let out = "";
  let buf = "";
  let bufCls = "";
  const flush = () => {
    if (!buf) {
      bufCls = "";
      return;
    }
    out += bufCls
      ? '<span class="' + bufCls + '">' + codeEditEscape(buf) + "</span>"
      : codeEditEscape(buf);
    buf = "";
    bufCls = "";
  };
  const add = (cls, text) => {
    if (!text) return;
    if (buf && bufCls !== cls) flush();
    bufCls = cls;
    buf += text;
  };

  for (let k = 0; k < len; k++) {
    const t = toks[k];
    const text = s.slice(t.s, t.e);
    if (t.t === "ws") add("", text);
    else if (t.t === "com") add("jsl-com", text);
    else if (t.t === "str") add("jsl-str", text);
    else if (t.t === "num") add("jsl-num", text);
    else if (t.t === "punc") add("jsl-punc", text);
    else if (t.t === "word") {
      const prevT = prevIdx[k] >= 0 ? toks[prevIdx[k]] : null;
      const nextT = nextIdx[k] >= 0 ? toks[nextIdx[k]] : null;
      const prevText = prevT ? textAt(prevIdx[k]) : "";
      const nextText = nextT ? textAt(nextIdx[k]) : "";
      let cls = "";
      if (JSL_LITERALS.has(text)) cls = "jsl-bool";
      else if (JSL_KEYWORDS.has(text)) cls = "jsl-kw";
      else if (JSL_CONTRACT_WORDS.has(text) || /^\$\d+$/.test(text)) cls = "jsl-con";
      else if (nextT && nextT.t === "punc" && nextText === "(") cls = "jsl-fn";
      /* `foo.bar` / `foo?.bar`（?. 拆成两个标点 token，前一个非空白恰好是 "."）→ 属性名 */
      else if (prevT && prevT.t === "punc" && /\.$/.test(prevText)) cls = "jsl-prop";
      else if (
        nextT &&
        nextT.t === "punc" &&
        nextText === ":" &&
        prevT &&
        prevT.t === "punc" &&
        (prevText === "{" || prevText === ",")
      )
        cls = "jsl-prop";
      add(cls, text);
    } else add("", text);
  }
  flush();
  return out;
}

/* ============================================================
 * 格式化：逐行重排缩进（不做语法级重排版，不合并/拆分任何一行）
 *   · 2 空格一层，行首连续闭合括号回退对应层数
 *   · switch 的 case / default 体额外一层
 *   · 落在模板串 / 未闭合块注释内部的行原样保留（那里的前导空格是内容）
 *   · 连续空行折到 1 行、去行尾空格、末尾不留空行
 * ============================================================ */
function formatJsCode(src, opts) {
  const o = opts || {};
  const unit = typeof o.indent === "string" && o.indent ? o.indent : "  ";
  const text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
  if (!text.trim()) return "";
  const lines = text.split("\n");
  const nLines = lines.length;
  const lineStart = new Array(nLines);
  let acc = 0;
  for (let L = 0; L < nLines; L++) {
    lineStart[L] = acc;
    acc += lines[L].length + 1;
  }
  const toks = jsTokenize(text);

  /* 每行的括号净增量（只数 punc token，字符串 / 注释 / 模板内的括号天然被排除） */
  const opens = new Array(nLines).fill(0);
  const closes = new Array(nLines).fill(0);
  let ti = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== "punc") continue;
    const ch = text.charAt(t.s);
    let L = ti;
    while (L < nLines - 1 && lineStart[L + 1] <= t.s) L++;
    ti = L;
    if (jslIsOpener(ch)) opens[L]++;
    else if (jslIsCloser(ch)) closes[L]++;
  }

  /* 行首是否落在跨行字面量 / 注释 token 内部（是 → 整行原样） */
  const insideLiteralAt = (offset) => {
    let lo = 0;
    let hi = toks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = toks[mid];
      if (t.e <= offset) lo = mid + 1;
      else if (t.s >= offset) hi = mid - 1;
      else return t.t === "com" || t.t === "str" ? t.t : "";
    }
    return "";
  };

  const out = [];
  let depth = 0; // 真实括号深度
  let caseExtra = 0; // switch case 体的虚拟一层（0 / 1）
  let caseDepth = -1; // 该虚拟层所属的 switch 体深度

  for (let L = 0; L < nLines; L++) {
    const raw = lines[L];
    const trimmed = raw.trim();
    const lit = insideLiteralAt(lineStart[L]);

    if (lit) {
      /* JSDoc 风格的续行 ` * …` 对齐到当前层；模板串 / 其它注释正文一律原样 */
      if (lit === "com" && /^\*/.test(trimmed))
        out.push(unit.repeat(depth + caseExtra) + " " + trimmed);
      else out.push(raw);
      depth = Math.max(0, depth + opens[L] - closes[L]);
      continue;
    }

    if (!trimmed) {
      /* 连续空行折到 1 行；文件开头的空行直接丢掉 */
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }

    let cc = 0;
    for (let q = 0; q < trimmed.length; q++) {
      const ch = trimmed.charAt(q);
      if (ch === " " || ch === "\t") continue;
      if (jslIsCloser(ch)) cc++;
      else break;
    }
    const startsCloser = cc > 0;
    /* case / default 标签行：允许形如 `case 'a': {` 的写法（冒号后可再开一块） */
    const isCase =
      (/^case\b/.test(trimmed) && /:\s*[\{\(\[]?\s*$/.test(trimmed)) ||
      /^default\s*:?\s*[\{\(\[]?\s*$/.test(trimmed);
    /* 链式 / 三元续行：比基准层再多一层（不做语法级合并，只调缩进） */
    const isChain =
      trimmed.charAt(0) === "." ||
      trimmed.startsWith("?.") ||
      trimmed.startsWith("...") ||
      trimmed.startsWith("??") ||
      trimmed.startsWith("&&") ||
      trimmed.startsWith("||") ||
      trimmed.startsWith("=>") ||
      trimmed.charAt(0) === ":" ||
      (trimmed.charAt(0) === "?" &&
        trimmed.charAt(1) !== "." &&
        trimmed.charAt(1) !== "?");

    let level;
    if (isCase) {
      level = caseExtra && caseDepth === depth ? caseDepth : depth + caseExtra;
    } else if (startsCloser) {
      const after = Math.max(0, depth - cc);
      if (caseExtra && after < caseDepth) {
        caseExtra = 0;
        caseDepth = -1;
        level = after;
      } else level = after + caseExtra;
    } else if (isChain) {
      level = depth + caseExtra + 1;
    } else level = depth + caseExtra;
    level = Math.max(0, level);

    out.push((level > 0 ? unit.repeat(level) : "") + trimmed);

    if (isCase) {
      /* case 自带块（`case 'a': {`）时真实括号已经提供一层，不再叠加虚拟层 */
      if (opens[L] - closes[L] > 0) {
        caseExtra = 0;
        caseDepth = depth + (opens[L] - closes[L]);
      } else {
        caseExtra = 1;
        caseDepth = depth;
      }
    }
    /* 其余行（含普通闭合行）不动虚拟层，闭合行的清理由上面 after < caseDepth 分支负责 */

    depth = Math.max(0, depth + opens[L] - closes[L]);
    if (caseExtra && depth < caseDepth) {
      caseExtra = 0;
      caseDepth = -1;
    }
  }

  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/* ============================================================
 * 编辑器组件：行号槽 + 高亮镜像层 + 透明文字 textarea
 * createJsCodeEditor({ value, placeholder, rows, onChange, onCommit })
 *   → { el, ta, getValue, setValue, focus, format, getStats }
 * onChange(value) 每次输入都回调（节点卡片里只写内存字段）；
 * onCommit(value) 失焦 / 显式提交时回调（节点卡片里落盘 + pushHistory）。
 * ============================================================ */
function createJsCodeEditor(opts) {
  const o = opts || {};
  const unit = typeof o.indent === "string" && o.indent ? o.indent : "  ";
  const minRows = Math.max(3, Number(o.rows) || 8);

  const el = document.createElement("div");
  el.className = "js-edit";
  const gutter = document.createElement("div");
  gutter.className = "js-edit-gutter";
  gutter.setAttribute("aria-hidden", "true");
  const hl = document.createElement("div");
  hl.className = "js-edit-hl";
  hl.setAttribute("aria-hidden", "true");
  const ta = document.createElement("textarea");
  ta.className = "n-text js-edit-input";
  ta.spellcheck = false;
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("wrap", "off");
  ta.rows = minRows;
  if (o.placeholder) ta.placeholder = String(o.placeholder);
  ta.value = String(o.value == null ? "" : o.value);
  el.appendChild(gutter);
  el.appendChild(hl);
  el.appendChild(ta);

  const onChange = (v) => {
    if (typeof o.onChange === "function") {
      try {
        o.onChange(v);
      } catch (e) {
        /* 宿主回调出错不能打断输入 */
      }
    }
  };
  const onCommit = (v) => {
    if (typeof o.onCommit === "function") {
      try {
        o.onCommit(v);
      } catch (e) {}
    }
  };

  /* --- 行号槽 --- */
  const caretLine = () => {
    const upto = ta.value.slice(0, Math.max(0, ta.selectionStart || 0));
    let k = 0;
    for (let q = 0; q < upto.length; q++) if (upto.charAt(q) === "\n") k++;
    return k; // 0-based
  };
  let lastLines = -1;
  let lastCur = -1;
  const syncGutter = (force) => {
    const total = ta.value.split("\n").length;
    const cur = caretLine();
    if (!force && total === lastLines && cur === lastCur) {
      gutter.scrollTop = ta.scrollTop;
      return;
    }
    if (total !== lastLines) {
      let h = "";
      for (let k = 1; k <= total; k++)
        h += '<div class="js-ln">' + k + "</div>";
      gutter.innerHTML = h;
      lastLines = total;
      lastCur = -1; // 重建成就是纯文本，当前行标记必须重新落一次
    }
    if (cur !== lastCur) {
      const kids = gutter.children;
      if (lastCur >= 0 && kids[lastCur]) kids[lastCur].className = "js-ln";
      if (kids[cur]) kids[cur].className = "js-ln cur";
      lastCur = cur;
    }
    gutter.scrollTop = ta.scrollTop;
  };

  const syncHl = () => {
    hl.innerHTML = jsHighlightHtml(ta.value) + JSL_HL_TAIL;
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  };
  const syncAll = (force) => {
    syncHl();
    syncGutter(force);
  };

  /* --- 写入（优先 execCommand 以保住原生撤销栈，失败再退到 setRangeText） --- */
  const replace = (a, b, text, caret) => {
    let ok = false;
    try {
      ta.setSelectionRange(a, b);
      ok = document.execCommand("insertText", false, text);
    } catch (e) {
      ok = false;
    }
    if (!ok) ta.setRangeText(text, a, b, "end");
    if (caret != null) {
      const p = Math.max(a, Math.min(a + text.length, a + caret));
      try {
        ta.setSelectionRange(p, p);
      } catch (e) {}
    }
    syncAll();
    onChange(ta.value);
  };
  const insert = (text, caret) => replace(ta.selectionStart, ta.selectionEnd, text, caret);

  const lineBounds = (offset) => {
    const v = ta.value;
    const start = v.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
    let end = v.indexOf("\n", start);
    if (end < 0) end = v.length;
    return { start: start, end: end, text: v.slice(start, end) };
  };

  /* 整块缩进 / 反缩进（选区跨行时 Tab 就是这个语义） */
  const shiftBlock = (dir) => {
    const v = ta.value;
    let a = ta.selectionStart;
    let b = ta.selectionEnd;
    if (b < a) {
      const t = a;
      a = b;
      b = t;
    }
    const start = v.lastIndexOf("\n", Math.max(0, a - 1)) + 1;
    let end = v.indexOf("\n", Math.max(b, start));
    if (end < 0) end = v.length;
    const block = v.slice(start, end);
    const arr = block.split("\n");
    let next;
    if (dir > 0) next = arr.map((ln) => (ln.trim() ? unit + ln : ln)).join("\n");
    else
      next = arr
        .map((ln) => {
          if (!ln.trim()) return ln;
          if (ln.charAt(0) === "\t") return ln.slice(1);
          let cut = 0;
          while (cut < unit.length && ln.charAt(cut) === " ") cut++;
          return ln.slice(cut);
        })
        .join("\n");
    if (next === block) return;
    replace(start, end, next, null);
    try {
      ta.setSelectionRange(start, start + next.length);
    } catch (e) {}
    syncGutter(true);
  };

  /* Enter：继承缩进；行尾开括号补一层；光标夹在空的一对括号里则撑开一块 */
  const newline = () => {
    const v = ta.value;
    const a = ta.selectionStart;
    const lb = lineBounds(a);
    const before = v.slice(lb.start, a);
    const after = v.slice(a, lb.end);
    const base = (before.match(/^[ \t]*/) || [""])[0];
    const beforeTrim = before.replace(/[ \t]+$/, "");
    const endsOpen = /[\{\(\[]$/.test(beforeTrim);
    const afterTrim = after.replace(/^[ \t]+/, "");
    /* 光标后面只剩闭合符（可带 ; ,）→ 这是一对空括号，撑开一块并把光标停在内层 */
    const onlyClosers = /^[)\]\}][)\]\};,\s]*$/.test(afterTrim);
    if (endsOpen && onlyClosers) {
      const text = "\n" + base + unit + "\n" + base;
      insert(text, 1 + base.length + unit.length);
      return;
    }
    const caseLine =
      /^case\b[\s\S]*:\s*$/.test(beforeTrim) ||
      /^default\s*:?\s*$/.test(beforeTrim);
    insert("\n" + (endsOpen || caseLine ? base + unit : base), null);
  };

  ta.addEventListener("input", () => {
    syncAll(true);
    onChange(ta.value);
  });
  ta.addEventListener("scroll", () => {
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  });
  /* 除 input/scroll 外，这些时机 textarea 的实际值或滚动位置也可能已变：
     select / selectionchange（拖拽改选）、focus（浏览器把光标滚回可视区而不派发
     scroll）、compositionend（输入法上屏的最终值）。与 .n-prompt-hl 同口径补齐。 */
  for (const ev of ["select", "selectionchange", "focus", "compositionend"])
    ta.addEventListener(ev, () => syncAll());
  ta.addEventListener("keyup", () => syncGutter());
  ta.addEventListener("click", () => syncGutter());
  ta.addEventListener("blur", () => onCommit(ta.value));
  ta.addEventListener("change", () => {
    syncAll(true);
    onCommit(ta.value);
  });
  ta.addEventListener("keydown", (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    /* 输入法组字期间（中文输入回车选词）绝不能接管 Enter，否则上屏被打断 */
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Tab") {
      ev.preventDefault();
      ev.stopPropagation();
      const multi =
        ta.value.slice(ta.selectionStart, ta.selectionEnd).indexOf("\n") >= 0;
      if (multi || ev.shiftKey) shiftBlock(ev.shiftKey ? -1 : 1);
      else insert(unit, unit.length);
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      ev.stopPropagation();
      newline();
    }
  });

  syncAll(true);

  const api = {
    el: el,
    ta: ta,
    getValue: () => ta.value,
    setValue: (v) => {
      ta.value = String(v == null ? "" : v);
      syncAll(true);
    },
    focus: () => {
      try {
        ta.focus();
      } catch (e) {}
    },
    /* 就地格式化；返回是否真的改动（调用方据此决定要不要落历史） */
    format: () => {
      const next = formatJsCode(ta.value, { indent: unit });
      if (next === ta.value) return false;
      ta.value = next;
      try {
        ta.setSelectionRange(0, 0);
      } catch (e) {}
      syncAll(true);
      onChange(next);
      onCommit(next);
      return true;
    },
    /* 工具条提示用：行数 + 光标所在行（1-based） */
    getStats: () => ({
      lines: ta.value.split("\n").length,
      caretLine: caretLine() + 1,
    }),
  };
  return api;
}

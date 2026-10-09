"use strict";
/* ============================================================
 * 函数节点轻量 JS 代码编辑器（高亮 / 行号 / 格式化）+「开发」按钮
 * —— 链路级冒烟测试（纯 Node）
 *   node test/smoke-codeedit.js
 *
 * 被测代码全部是「真实源码 / 真函数」，不抄一份逻辑：
 *   renderer/app-codeedit.js  jsTokenize / jsHighlightHtml / formatJsCode（直接真跑）
 *                             createJsCodeEditor（假 DOM 桩真跑：行号槽 / 镜像层 / 按键）
 *   renderer/app-canvas.js    fnScaffoldCode（真跑生成脚手架 → 喂给 formatJsCode）
 *                             buildFnToolBodyMain / buildFnToolSettings（接线点源码断言）
 *   renderer/app-tools.js     openNodeTestDialog（接线点）+ fnDevContractText（真跑出契约正文）
 *   renderer/i18n.js          新增中文串在 en 口径下逐条命中英文映射
 * 只桩外围环境（document / 节点参数表访问器 / I18n 取值器），不桩被测逻辑。
 *
 * 覆盖：
 *   [1] formatJsCode 逐条钉住（嵌套缩进 / switch·case / 模板串里的花括号 / 正则里的花括号 /
 *       行注释里的引号与花括号 / 连续空行折叠 / 行尾空格 / CRLF / JSDoc 续行 /
 *       链式与三元续行 / 不配对括号兜底 / indent 选项 / 空白入参 / 二次幂等 / 不合并拆行）
 *   [2] jsHighlightHtml 转义安全（< > & 不产生注入 · 与 app.js escapePromptHl 同口径）
 *       + token class 命中（注释 / 字符串 / 模板插值 / 正则 / 数字 / 关键字 / 字面量 /
 *         契约词 input·values / $序号 / 函数调用名 / 属性名 / 标点）+ 词法切片无损
 *   [3] createJsCodeEditor 组件（假 DOM：三层结构与行号槽 · 镜像层与高亮函数同源 ·
 *       Tab / Shift+Tab 单行与块缩进 · Enter 继承缩进与撑开空括号对 ·
 *       format() 真改动才返回 true · onChange / onCommit 分工 · getStats）
 *   [4] 接线点源码断言（index.html 注册顺序 / 卡片 / 试跑台 /「开发」链路）
 *       + 函数开发契约正文真跑（只改本节点 · 改参数提醒复核连线）+ i18n 覆盖
 *   [5] CSS 层：组件吐出的每一个 class 在 canvas.css 里都真有规则 · 三层绝对叠放
 *       （textarea 在上且收事件 · 镜像层 pointer-events:none）· 两层字体度量同源
 *       （共用一条声明块）· 亮色主题补色 · style.css 真的 @import 了这两个文件
 *       —— 本轮 Bug 的根因就是这套样式整块缺失：三层按文档流竖排，用户看到的是
 *          不可点的镜像文字（"显示代码行"），可编辑的 textarea 被挤出板身（"点不动"）。
 * ============================================================ */
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
/* 切片用 LF 口径读入（仓库源码是 CRLF，多行标记必须可比） */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
function between(src, startMark, endMark, label) {
  const i = src.indexOf(startMark);
  const j = i < 0 ? -1 : src.indexOf(endMark, i + startMark.length);
  const good = i >= 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const EQS = (got, want, msg) =>
  ok(
    got === want,
    msg +
      (got === want
        ? ""
        : "\n        实际=" + JSON.stringify(got) + "\n        期望=" + JSON.stringify(want)),
  );
const count = (s, sub) => s.split(sub).length - 1;
/* 与 app.js escapePromptHl 同口径（只放 & < >）—— 用于「高亮层不吞内容」对拍 */
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/* 轻量 I18n 桩：zh 口径就是原样返回真源（i18n.js 的 zh 分支同此）；
   英文映射覆盖在 [4e] 用真实 i18n 模块逐条验证 */
const I18N_STUB = {
  t: (k, vars) =>
    String(k).replace(/\{(\w+)\}/g, (_, n) =>
      vars && vars[n] != null ? String(vars[n]) : "",
    ),
};

/* ══════════ 载入被测真源码 renderer/app-codeedit.js（含假 DOM 桩） ══════════ */
function fakeEl(tag) {
  const el = {
    tagName: tag,
    className: "",
    innerHTML: "",
    value: "",
    textContent: "",
    title: "",
    placeholder: "",
    rows: 0,
    spellcheck: true,
    scrollTop: 0,
    scrollLeft: 0,
    selectionStart: 0,
    selectionEnd: 0,
    children: [],
    style: {},
    __h: {},
    setAttribute(k, v) {
      el[k] = v;
    },
    getAttribute(k) {
      return el[k] === undefined ? null : el[k];
    },
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    append() {
      for (const c of arguments) el.children.push(c);
    },
    addEventListener(t, f) {
      (el.__h[t] = el.__h[t] || []).push(f);
    },
    removeEventListener() {},
    setSelectionRange(a, b) {
      el.selectionStart = a;
      el.selectionEnd = b;
    },
    /* textarea.setRangeText 的语义子集（execCommand 在桩里恒返回 false → 编辑器退到这里） */
    setRangeText(text, a, b) {
      el.value = el.value.slice(0, a) + text + el.value.slice(b);
      el.selectionStart = el.selectionEnd = a + text.length;
    },
    focus() {},
    blur() {},
    closest() {
      return null;
    },
    fire(type, ev) {
      const e = Object.assign(
        {
          type: type,
          target: el,
          preventDefault() {},
          stopPropagation() {},
          isComposing: false,
          keyCode: 0,
        },
        ev || {},
      );
      for (const f of el.__h[type] || []) f(e);
      return e;
    },
  };
  return el;
}
const DOC_STUB = { createElement: (t) => fakeEl(t), execCommand: () => false };
const CE = vm.createContext({ console, document: DOC_STUB, window: {} });
vm.runInContext(read("renderer/app-codeedit.js"), CE);
/* 在该上下文里按名字求值（脚本顶层函数声明即全局），不复制任何逻辑 */
const EV = (expr) => vm.runInContext("(" + expr + ")", CE);
const CALL1 = (fn, arg) => EV(fn + "(" + JSON.stringify(arg) + ")");
const fmt = (src, opts) =>
  EV("formatJsCode(" + JSON.stringify(src) + "," + JSON.stringify(opts || null) + ")");
const hl = (src) => CALL1("jsHighlightHtml", src);
const toksOf = (src) => CALL1("jsTokenize", src);

ok(
  EV("typeof jsTokenize") === "function" &&
    EV("typeof jsHighlightHtml") === "function" &&
    EV("typeof formatJsCode") === "function" &&
    EV("typeof createJsCodeEditor") === "function",
  "app-codeedit.js 挂出 jsTokenize / jsHighlightHtml / formatJsCode / createJsCodeEditor",
);

/* ═══════════════════════ [1] formatJsCode ═══════════════════════ */
console.log("\n[1] formatJsCode：逐行缩进重排逐条钉住（真源码执行）");
const FMT_CASES = [
  {
    name: "嵌套缩进：函数体 / 对象字面量 / if 块各多一层",
    src: "function a(x){\nconst y = {\nk:1,\nz:{\nn:2\n}\n}\nif(x){\nreturn y\n}\nreturn 0\n}",
    want:
      "function a(x){\n  const y = {\n    k:1,\n    z:{\n      n:2\n    }\n  }\n  if(x){\n    return y\n  }\n  return 0\n}",
  },
  {
    name: "switch / case：case 与 switch 同层，case 体再多一层",
    src: "switch (x) {\ncase 'a':\nfoo()\nbreak\ndefault:\nbaz()\n}",
    want: "switch (x) {\n  case 'a':\n    foo()\n    break\n  default:\n    baz()\n}",
  },
  {
    name: "case 'a': { 自带块不叠加虚拟层（最深只到 2 层）",
    src: "switch (x) {\ncase 'a': {\nfoo()\nbreak\n}\ndefault:\nbar()\n}",
    want:
      "switch (x) {\n  case 'a': {\n    foo()\n    break\n  }\n  default:\n    bar()\n}",
  },
  {
    name: "行首连续闭合括号按数回退（}} 一次退两层 · 但不拆行）",
    src: "function a() {\nconst o = {\nk: 1\n}}\nconst b = 2;",
    want: "function a() {\n  const o = {\n    k: 1\n}}\nconst b = 2;",
  },
  {
    name: "模板字符串里的花括号不误判 · 内部行原样保留",
    src: "const t = `a {b}\n   keep   this\n  }\nreal = 1;",
    want: "const t = `a {b}\n   keep   this\n  }\nreal = 1;",
  },
  {
    name: "正则字面量里的花括号不误判（/{2,3}/ 不算开括号）",
    src: "const re = /{2,3}/g\nconst b = {\nx:1\n}",
    want: "const re = /{2,3}/g\nconst b = {\n  x:1\n}",
  },
  {
    name: "行注释里的引号与花括号不误判（后续行仍正常缩进）",
    src: "const a = 1 // it's fine {\nconst s = 'x' // don't\n// closing } here\nconst b = {\nc:2\n}",
    want:
      "const a = 1 // it's fine {\nconst s = 'x' // don't\n// closing } here\nconst b = {\n  c:2\n}",
  },
  {
    name: "连续空行折到 1 行 · 行尾空格清除 · 首尾不留空行",
    src: "\n\nconst a = 1   \n\n\n\nconst b = 2\t\n\n\n",
    want: "const a = 1\n\nconst b = 2",
    keepLines: false,
  },
  {
    name: "CRLF 归一成 LF（末行换行不产生空行）",
    src: "const a = 1\r\nif (a) {\r\nreturn a\r\n}\r\n",
    want: "const a = 1\nif (a) {\n  return a\n}",
    keepLines: false,
  },
  {
    name: "JSDoc 续行 ` * …` 对齐当前层（含函数体内部的嵌套文档注释）",
    src: "/**\n* 说明 { 带花括号 }\n*/\nfunction f() {\n/**\n* 内层\n*/\nreturn 1\n}",
    want:
      "/**\n * 说明 { 带花括号 }\n */\nfunction f() {\n  /**\n   * 内层\n   */\n  return 1\n}",
  },
  {
    name: "链式调用 / 三元续行比基准层再多一层（只调缩进，不合并行）",
    src: "const r = obj\n.foo()\n.bar\n?.baz;\nconst q = a ? b\n: c;",
    want: "const r = obj\n  .foo()\n  .bar\n  ?.baz;\nconst q = a ? b\n  : c;",
  },
  {
    name: "括号不配对也不负缩进（代码被截断时兜底）",
    src: "function f() {\nreturn {\na:1\n",
    want: "function f() {\n  return {\n    a:1",
    keepLines: false,
  },
  {
    name: "未闭合块注释之后的行原样保留（保守不破坏）",
    src: "const a=1\n/* oops\n * never closed\nconst b=2",
    want: "const a=1\n/* oops\n * never closed\nconst b=2",
  },
  {
    name: "字符串里的 return 与花括号不误判（含转义引号）",
    src: "const s = \"he said \\\"return {\\\" \"\nif (s) {\nreturn s\n}",
    want: "const s = \"he said \\\"return {\\\" \"\nif (s) {\n  return s\n}",
  },
  {
    name: "中文标识符与 $序号端子键照常缩进",
    src: "const 结果 = {\n$0: 1,\n中文: {\nx: 2\n}\n}\nreturn 结果",
    want: "const 结果 = {\n  $0: 1,\n  中文: {\n    x: 2\n  }\n}\nreturn 结果",
  },
];
for (const c of FMT_CASES) {
  const got = fmt(c.src);
  EQS(got, c.want, "格式化：" + c.name);
  EQS(fmt(got), got, "二次格式化幂等：" + c.name);
  if (c.keepLines !== false)
    EQS(
      got.split("\n").length,
      c.src.split("\n").length,
      "不合并 / 不拆分任何一行：" + c.name,
    );
}
EQS(
  fmt("function f(){\nreturn 1\n}", { indent: "\t" }),
  "function f(){\n\treturn 1\n}",
  "indent 选项：可换成制表符",
);
EQS(
  fmt("function f(){\nreturn 1\n}", { indent: "" }),
  "function f(){\n  return 1\n}",
  "indent 传空串回落 2 空格（不会塌成 0 层）",
);
EQS(fmt(""), "", "空代码 → 空串");
EQS(fmt("   \n\t\n"), "", "只有空白 → 空串");
EQS(fmt(null), "", "null 入参不炸");
EQS(fmt("const a = 1"), "const a = 1", "单行代码原样");
EQS(
  fmt("function f(){\nif(1){\nreturn {\nx:1\n}\n}\n}"),
  "function f(){\n  if(1){\n    return {\n      x:1\n    }\n  }\n}",
  "多层缩进按 2 空格累加（1/2/3 层 = 2/4/6 空格）",
);
ok(
  fmt("\tfunction f() {\n\t\treturn 1\n\t}").indexOf("\t") < 0,
  "制表符缩进重排成空格（输出不含制表符）",
);
HAS(
  fmt("function f(){\nreturn 1\n}"),
  "function f(){",
  "行内空格不重排（只做缩进，不做语法级重排版）",
);

/* —— 真·脚手架样本：跑 app-canvas.js 的 fnScaffoldCode，再喂给 formatJsCode —— */
const CANVAS = read("renderer/app-canvas.js");
/* 段尾锚点＝「设置」面板那份注释的开头（面板改由跳窗承载后注释同步改过口径，
   锚点跟着走：脚手架源码段仍然是 FN_SCAFFOLD_ID_RE → 面板注释之间） */
const SCAFF_SRC = between(
  CANVAS,
  "const FN_SCAFFOLD_ID_RE = ",
  "/* 「设置」跳窗里的参数面板",
  "app-canvas.js fnScaffoldCode",
);
/* 数组参数的判定真源在 app-canvas.js · fnBrowseParamIsArray（连线放行 / 端子徽标 /
   脚手架注释三处共用一份），这里把它一起载入选型上下文：脚手架的「（图像数组）」
   标注必须与真源同判，绝不在测试里另抄一份判定。 */
const ARR_SRC = between(
  CANVAS,
  "function fnBrowseParamIsArray(p) {",
  "/* 某个输入端子当前挂了几条「数据线」",
  "app-canvas.js fnBrowseParamIsArray",
);
const SC = vm.createContext({ console, I18n: I18N_STUB, ensureFnToolNodeState() {} });
vm.runInContext(
  ARR_SRC +
    "\n" +
    SCAFF_SRC +
    "\nfunction fnToolParamList(n, d) { return (d === 'in' ? n.inputs : n.outputs) || []; }\n",
  SC,
);
const SCAFF = vm.runInContext(
  "fnScaffoldCode({ kind:'function', title:'清洗文本', fnName:'cleanText', description:'去空白并按标点分句'," +
    " inputs:[{name:'text',kind:'text'},{name:'参考图',kind:'image'}], outputs:[{name:'句子',kind:'text'},{name:'数量',kind:'text'}] })",
  SC,
);
ok(typeof SCAFF === "string" && SCAFF.length > 120, "fnScaffoldCode 真跑生成脚手架（含中文注释与出参对象）");
const SCAFF_F = fmt(SCAFF);
ok(SCAFF_F !== SCAFF, "脚手架过一遍格式化：末尾空行被收掉（与「格式化」按钮同一口径）");
EQS(fmt(SCAFF_F), SCAFF_F, "脚手架格式化后二次幂等");
HAS(SCAFF_F, 'const text = input["text"]', "脚手架取参行内容未被格式化改动");
EQS(
  SCAFF_F,
  SCAFF.replace(/\n+$/, ""),
  "脚手架模板与格式化器天然同口径（只差末尾空行 · 点「格式化」不会把脚手架搅乱）",
);
HAS(SCAFF_F, "\n  句子: undefined,", "脚手架出参对象的键体停在 2 空格一层");
HAS(SCAFF_F, "// 出参：句子（文本）、数量（文本）", "脚手架中文注释（含括号）原样保留");
EQS(
  SCAFF_F.split("\n").length,
  SCAFF.replace(/\n+$/, "").split("\n").length,
  "脚手架格式化不合并 / 不拆行（只丢末尾空行）",
);

/* —— 数组（批量）入参的脚手架标注：判定真源 = app-canvas.js fnBrowseParamIsArray —— */
const SCAFF_ARR = vm.runInContext(
  "fnScaffoldCode({ kind:'function', title:'图生图', fnName:'i2i', description:'多参考图'," +
    " inputs:[{name:'提示词',kind:'text'},{name:'参考图',kind:'image',list:true},{name:'tags',kind:'text',list:true}]," +
    " outputs:[{name:'出图',kind:'image'}] })",
  SC,
);
HAS(SCAFF_ARR, "参考图（图像数组）", "脚手架：数组图像入参标「（图像数组）」");
HAS(SCAFF_ARR, "tags（文本数组）", "脚手架：数组文本入参标「（文本数组）」");
HAS(
  SCAFF_ARR,
  '：数组，逐元素 { kind:"image", path }（一条线一个元素 · 没挂线时是 []）',
  "脚手架：数组图像入参注释写明「恒为数组 · 一条线一个元素」",
);
HAS(
  SCAFF_ARR,
  "：字符串数组（一条线一个元素 · 没挂线时是 []）",
  "脚手架：数组文本入参注释写明字符串数组",
);
HAS(
  SCAFF_ARR,
  "// 数组端子（标注「数组」的入参）：可接多条数据线",
  "脚手架：有数组入参时头部多一行数组端子说明",
);
HAS(
  SCAFF_ARR,
  "提示词（文本）：字符串（上游未输出时为 undefined）",
  "非数组入参的注释形状逐字不变（一号一值）",
);
ok(
  SCAFF_ARR.indexOf("提示词（文本数组）") < 0,
  "没勾数组的入参不会被误标成数组（list 位是唯一依据）",
);
const SCAFF_NOARR = vm.runInContext(
  "fnScaffoldCode({ kind:'function', title:'无数组', inputs:[{name:'a',kind:'text'}], outputs:[{name:'b',kind:'text'}] })",
  SC,
);
ok(SCAFF_NOARR.indexOf("// 数组端子") < 0, "全非数组入参时不输出数组端子说明行");
EQS(
  fmt(SCAFF_ARR),
  SCAFF_ARR.replace(/\n+$/, ""),
  "带数组注释的脚手架与格式化器天然同口径",
);

/* ═══════════════════════ [2] jsHighlightHtml ═══════════════════════ */
console.log("\n[2] jsHighlightHtml：转义安全 + token 配色命中（真源码执行）");
const INJECT = 'const html = "<b>x</b>" + a < b && c > d; // </script> & "q"';
const hInj = hl(INJECT);
ok(hInj.indexOf("</script>") < 0, "注入测试：代码里的 </script> 不会成为真标签");
HAS(hInj, "&lt;/script&gt;", "注入测试：< > 转义（与 escapePromptHl 同口径）");
HAS(hInj, "&amp;", "注入测试：& 转成 &amp;");
ok(
  hInj.indexOf("&quot;") < 0 && hInj.indexOf("&#") < 0,
  "注入测试：不额外转义引号（与 app.js escapePromptHl 一致 · 镜像层里引号无害）",
);
ok(
  hInj.replace(/<span class="jsl-[a-z]+">/g, "").replace(/<\/span>/g, "").indexOf("<") < 0,
  "注入测试：剥掉自有 span 后不含任何裸 <（输出只有文本与 span）",
);
EQS(
  hInj.replace(/<\/?span[^>]*>/g, ""),
  esc(INJECT),
  "高亮层不吞不增内容：剥掉 span 后逐字等于转义后的源码",
);
EQS(hl(""), "", "空代码 → 空高亮");
ok(hl("/* c */").indexOf('<span class="jsl-com">/* c */</span>') >= 0, "块注释整段一个 jsl-com span");
ok(
  count(hl("const a = 1"), "<span") === count(hl("const a = 1"), "</span>"),
  "span 开闭配对（镜像层结构完整）",
);

const RICH = [
  "// 头部注释",
  "const x = 42;",
  "let 布尔 = true, 空 = null;",
  "const s = '单引号' + \"双引号\" + `模板${input.名字}尾`;",
  "const re = /ab+c/gi;",
  "function calc(a) { return obj.method(a) + $1; }",
  "const out = { 键: values.甲, kind: \"image\" };",
].join("\n");
const hRich = hl(RICH);
[
  ["jsl-com", "行注释"],
  ["jsl-str", "字符串 / 模板串 / 正则"],
  ["jsl-num", "数字 42"],
  ["jsl-kw", "关键字 const / function / return"],
  ["jsl-bool", "字面量 true / null"],
  ["jsl-con", "契约词 input / values 与 $1 端子键"],
  ["jsl-fn", "函数调用名 method("],
  ["jsl-prop", "属性名 values.甲 与对象键 键:"],
  ["jsl-punc", "标点"],
].forEach(([cls, what]) =>
  ok(hRich.indexOf('class="' + cls + '"') >= 0, "token 命中 " + cls + "（" + what + "）"),
);
ok(
  hl("const ratio = total / count;").indexOf('class="jsl-str"') < 0,
  "除号不误判成正则：total / count 不产生字符串配色",
);
ok(
  hl("const t = `a${ b }c`;").indexOf('class="jsl-str"') >= 0,
  "模板插值 ${…} 按模板色",
);
EQS(
  hl("const t = `a${ b }c`;").replace(/<\/?span[^>]*>/g, ""),
  esc("const t = `a${ b }c`;"),
  "模板插值不丢字符",
);
ok(hl("input.x / 2").indexOf('class="jsl-con"') >= 0, "契约词 input 走专色 jsl-con");
ok(
  RICH.split("\n").every((ln) => !ln || hl(ln + "\n").length > 0),
  "逐行喂入不炸（单行片段也能着色）",
);
const TK = toksOf(RICH);
EQS(
  TK.map((t) => RICH.slice(t.s, t.e)).join(""),
  RICH,
  "jsTokenize 切片无损：所有 token 首尾相接 = 原文",
);
ok(
  TK.every((t) => /^(ws|com|str|num|word|punc)$/.test(t.t)),
  "jsTokenize token 类型在白名单内（ws/com/str/num/word/punc）",
);

/* ═══════════════════════ [3] createJsCodeEditor 组件（假 DOM 真跑） ═══════════════════════ */
console.log("\n[3] createJsCodeEditor：假 DOM 真跑（行号槽 / 镜像层 / 按键 / format / 回调）");
const ED = (opts) => {
  vm.runInContext("window.__chg = []; window.__sub = [];", CE);
  vm.runInContext(
    "window.__ed = createJsCodeEditor(Object.assign(" +
      JSON.stringify(opts || {}) +
      ", { onChange: function (v) { window.__chg.push(v); }," +
      " onCommit: function (v) { window.__sub.push(v); } }))",
    CE,
  );
};
const EDV = () => EV("window.__ed.getValue()");
const SETV = (v) => EV("window.__ed.setValue(" + JSON.stringify(v) + ")");
const CHG = () => EV("window.__chg.length");
const SUB = () => EV("window.__sub.length");
const kid = (i) => EV("window.__ed.el.children[" + i + "]");

ED({ value: "const a=1\nlet b=2", rows: 6, placeholder: "// 写点什么" });
const ta = EV("window.__ed.ta");
EQS(EV("window.__ed.el.className"), "js-edit", "组件外层 class = .js-edit");
EQS(
 [0, 1, 2].map((i) => kid(i).className).join("|"),
 "js-edit-gutter|js-edit-hl|n-text js-edit-input",
 "三层结构：行号槽 + 高亮镜像层 + 透明 textarea（叠放顺序与 CSS 一致）",
);
EQS(ta.children.length, 0, "行号槽与高亮层不在 textarea 内部（不干扰取值）");
EQS(EDV(), "const a=1\nlet b=2", "value 透传到 textarea");
EQS(ta.placeholder, "// 写点什么", "placeholder 透传（卡片与试跑台各自的提示文案）");
EQS(ta.rows, 6, "rows 透传");
EQS(ta.getAttribute("wrap"), "off", "wrap=off：不软换行（行号逐行对齐与横向滚动同步的前提）");
EQS(ta.spellcheck, false, "关闭拼写检查（代码里满屏红线）");
EQS(
  kid(0).innerHTML,
  '<div class="js-ln">1</div><div class="js-ln">2</div>',
  "行号槽按行数逐行生成",
);
EQS(
  kid(1).innerHTML,
  EV("jsHighlightHtml(window.__ed.getValue())") + "\n",
  "高亮镜像层与 jsHighlightHtml 同源，末尾恒定追加 JSL_HL_TAIL 占位",
);
EQS(EV("window.__ed.getStats().lines"), 2, "getStats().lines = 行数");
EQS(EV("window.__ed.getStats().caretLine"), 1, "getStats().caretLine = 1-based 光标行");

/* —— Tab / Shift+Tab —— */
ta.setSelectionRange(0, 0);
ta.fire("keydown", { key: "Tab" });
EQS(EDV(), "  const a=1\nlet b=2", "单行光标 Tab 插入 2 空格");
ta.fire("keydown", { key: "Tab", shiftKey: true });
EQS(EDV(), "const a=1\nlet b=2", "Shift+Tab 反缩进回原样");
ta.setSelectionRange(0, EDV().length);
ta.fire("keydown", { key: "Tab" });
EQS(EDV(), "  const a=1\n  let b=2", "跨行选区 Tab = 整块缩进");
ta.setSelectionRange(0, EDV().length);
ta.fire("keydown", { key: "Tab", shiftKey: true });
EQS(EDV(), "const a=1\nlet b=2", "跨行选区 Shift+Tab = 整块反缩进");
ok(CHG() > 0, "每次按键改写都回调 onChange（卡片只写内存字段的入口）");
const chgBefore = CHG();
ta.fire("keydown", { key: "Tab", ctrlKey: true });
EQS(CHG(), chgBefore, "Ctrl+Tab 不劫持（留给系统 / 浏览器切换标签）");

/* —— Enter —— */
SETV("function f() {");
ta.setSelectionRange(14, 14);
ta.fire("keydown", { key: "Enter" });
EQS(EDV(), "function f() {\n  ", "Enter 在行尾开括号后补一层");
SETV("function f() {}");
ta.setSelectionRange(14, 14);
ta.fire("keydown", { key: "Enter" });
EQS(EDV(), "function f() {\n  \n}", "Enter 在空括号对里撑开一块");
EQS(EV("window.__ed.ta.selectionStart"), 17, "撑开后光标停在内层那一行");
SETV("function f() {\n  x");
ta.setSelectionRange(18, 18);
ta.fire("keydown", { key: "Enter" });
EQS(EDV(), "function f() {\n  x\n  ", "Enter 继承当前行缩进");
ta.fire("keydown", { key: "Enter", isComposing: true });
EQS(EDV(), "function f() {\n  x\n  ", "输入法组字中的 Enter 不被劫持（上屏优先）");

/* —— format / 提交口径 —— */
SETV("if(x){\nreturn 1\n}");
EQS(EV("window.__ed.format()"), true, "format()：真有改动返回 true");
EQS(EDV(), "if(x){\n  return 1\n}", "format() 就地重排（同一 formatJsCode 实现）");
EQS(EV("window.__ed.format()"), false, "format()：值没变返回 false（不产生撤销点）");
EQS(SUB(), 1, "format() 提交后回调一次 onCommit（调用方据此压历史 + 落盘）");
SETV("");
EQS(EV("window.__ed.format()"), false, "空代码 format() 返回 false（不动历史）");
EQS(SUB(), 1, "空代码格式化不额外提交");
SETV("a\nb\nc");
EQS(EV("window.__ed.getValue()"), "a\nb\nc", "getValue / setValue 与 textarea 同源");
ta.setSelectionRange(0, 0);
ta.fire("blur");
EQS(EV("window.__sub[window.__sub.length - 1]"), "a\nb\nc", "失焦 blur → onCommit 带最新值");
EQS(SUB(), 2, "blur 再提交一次（卡片在 onCommit 里 scheduleSave）");
ta.fire("input");
EQS(EV("window.__chg[window.__chg.length - 1]"), "a\nb\nc", "input → onChange 带最新值");
EQS(
  kid(0).innerHTML,
  '<div class="js-ln">1</div><div class="js-ln">2</div><div class="js-ln">3</div>',
  "setValue / input 后行号槽跟着值重建",
);
ok(EV("typeof window.__ed.focus") === "function", "组件暴露 focus（对话框与卡片聚焦用）");

/* ═══════════════════════ [4] 接线点 + 契约 + i18n ═══════════════════════ */
console.log("\n[4] 接线点源码断言（index.html / 卡片 / 试跑台 /「开发」链路）+ 契约正文 + i18n");
/* —— [4a] 脚本表注册顺序：编辑器必须先于两个消费者 —— */
const HTML = read("renderer/index.html");
const iApp = HTML.indexOf('<script src="app.js"></script>');
const iCe = HTML.indexOf('<script src="app-codeedit.js"></script>');
const iCv = HTML.indexOf('<script src="app-canvas.js"></script>');
const iTl = HTML.indexOf('<script src="app-tools.js"></script>');
ok(iApp >= 0 && iCe > iApp, "index.html 在 app.js 之后注册 app-codeedit.js");
ok(iCe > 0 && iCv > iCe, "app-codeedit.js 先于 app-canvas.js（卡片要用 createJsCodeEditor）");
ok(iCe > 0 && iTl > iCe, "app-codeedit.js 先于 app-tools.js（试跑台用同一编辑器）");
HAS(HTML, '<script src="app-agent.js"></script>', "app-agent.js 行仍在（脚本表未被改坏）");

/* —— [4b] 函数节点卡片 —— */
const FN_BODY = between(
  CANVAS,
  "function buildFnToolBodyMain(node, body, isTool) {",
  "function buildBody(node, body) {",
  "app-canvas.js buildFnToolBodyMain",
);
EQS(count(FN_BODY, "createJsCodeEditor("), 1, "整函数卡片只有一处 createJsCodeEditor");
HAS(FN_BODY, "value: functionCodeOf(node)", "编辑器初值仍取 functionCodeOf(node)");
HAS(FN_BODY, "rows: 10", "卡片编辑器 rows 10");
HAS(FN_BODY, "node.jscode = v", "onChange / onCommit 都写回 node.jscode");
HAS(FN_BODY, "preEditSnap = snapshotState()", "撤销快照在首次写入 node.jscode 之前取");
HAS(FN_BODY, "pushHistory(preEditSnap)", "提交时压的是首改前的快照（undo 不失效）");
HAS(FN_BODY, "scheduleSave()", "提交才落盘（边写不落盘口径不变）");
HAS(FN_BODY, 'I18n.t("格式化")', "代码区上方工具条含「格式化」");
HAS(FN_BODY, "codeEd.format()", "「格式化」走编辑器同一实现（不自建第二份）");
HAS(FN_BODY, "codeEd.getStats()", "行 / 光标行提示走 getStats");
HAS(FN_BODY, 'bar.className = "fn-code-bar"', "工具条容器 class = .fn-code-bar");
HAS(FN_BODY, "codeEd.el.style.cssText", "编辑器容器高度仍由卡片 flex 供给");
HAS(FN_BODY, 'I18n.t("开发")', "函数节点下方「开发」按钮");
HAS(FN_BODY, "developFunctionNode(node)", "「开发」交给 app-tools.js developFunctionNode");
HAS(FN_BODY, "fnDevSessionsOf(node)", "按钮 title 的会话数只数活会话");
HAS(FN_BODY, '"n-dev-info"', "「开发」行复用开发节点既有样式（零新增 CSS）");
HAS(FN_BODY, "n-dev-btns", "「开发」按钮行走 .n-dev-btns");
HAS(FN_BODY, "n-dev-open", "「开发」按钮沿用 .n-dev-open 外观");
HAS(FN_BODY, "typeof developFunctionNode === \"function\"", "跨文件符号未就绪时 toast 兜底（不抛错）");
/* 工具节点同样支持「开发」：同一个按钮区，点击按 isTool 分发到 developToolNode /
   developFunctionNode；会话数也分别数（toolDevSessionsOf / fnDevSessionsOf）。 */
HAS(FN_BODY, "typeof toolDevSessionsOf === \"function\" && isTool", "工具节点的开发会话数走 toolDevSessionsOf（与函数互不串）");
HAS(FN_BODY, "typeof developToolNode === \"function\"", "工具节点「开发」交给 app-tools.js developToolNode");
ok(
  FN_BODY.indexOf("toolDevSessionsOf(node).length") > 0 &&
    FN_BODY.indexOf("fnDevSessionsOf(node).length") > 0,
  "「开发」按钮两类节点共用：会话数按工具 / 函数分别统计",
);
HAS(FN_BODY, '"button, input, textarea, select, a, .port, .fn-tool-settings"', "双击进子画布的交互控件排除选择器未被编辑器打坏");
const SET = between(
  CANVAS,
  "function buildFnToolSettings(node, isTool) {",
  "function buildFnToolBodyMain(node, body, isTool) {",
  "app-canvas.js buildFnToolSettings",
);
HAS(SET, 'I18n.t("生成脚手架")', "「生成脚手架」入口保留");
HAS(SET, "node.jscode = formatJsCode(tpl);", "脚手架写入同样过格式化（与「格式化」按钮同口径）");
ok(SET.indexOf("pushHistory();") < SET.indexOf("node.jscode = formatJsCode(tpl);"), "写脚手架前压撤销点");
/* —— [4b-2] 设置面板的宿主：从节点 body 换成「设置」跳窗（本轮迁移口径）——
   面板 DOM 仍只有这一份（buildFnToolSettings），但唯一的挂载点是 NODE_SETTINGS_FORMS
   登记的表单；卡片里只剩上面那两行只读摘要 + 头部「设置」入口。 */
ok(
  FN_BODY.indexOf("buildFnToolSettings") < 0,
  "函数卡片 body 不再内联挂设置面板（编辑器不被面板挤）",
);
HAS(FN_BODY, 'fnToolIoSummaryLine(node, "in")', "卡片 body 留「入参」只读摘要");
HAS(FN_BODY, 'fnToolIoSummaryLine(node, "out")', "卡片 body 留「出参」只读摘要");
HAS(CANVAS, 'registerNodeSettingsForm("function", {', "函数节点设置表单登记进跳窗登记表");
HAS(CANVAS, "function nsFnToolBuild(ctx) {", "跳窗表单复用 buildFnToolSettings 那份 DOM");
ok(
  count(CANVAS, "buildFnToolSettings(") === 2,
  "buildFnToolSettings 全文件仅两处引用：定义 + 跳窗表单挂载（body 挂载点已清零）",
);
ok(
  CANVAS.indexOf("S.uiOpenNode =") < 0 && CANVAS.indexOf("S.uiOpenNode ===") < 0,
  "app-canvas.js 不再靠 S.uiOpenNode 就地展开设置面板",
);

/* —— [4c] 试跑台 —— */
const TOOLS = read("renderer/app-tools.js");
const TD = between(
  TOOLS,
  "function openNodeTestDialog(node) {",
  "function fnDevNameOf(node) {",
  "app-tools.js openNodeTestDialog",
);
EQS(count(TD, "createJsCodeEditor("), 1, "试跑台「JS 代码」区用同一编辑器");
const CODE_REGION = between(
  TOOLS,
  "/* ── JS 代码区（仅函数节点",
  "  } else {\n    /* 工具节点没有代码区",
  "app-tools.js 试跑台代码区",
);
HAS(CODE_REGION, "value: functionCodeOf(node)", "试跑台初值与卡片同源");
HAS(CODE_REGION, "rows: 18", "试跑台编辑器更高（rows 18）");
HAS(CODE_REGION, "node.jscode = v", "试跑台 onChange / onCommit 写 node.jscode");
HAS(CODE_REGION, "scheduleSave();", "试跑台提交落盘");
HAS(CODE_REGION, "codeEd.format()", "试跑台格式化复用编辑器 format()");
HAS(CODE_REGION, 'I18n.t("格式化")', "试跑台也提供「格式化」按钮");
ok(
  CODE_REGION.indexOf('document.createElement("textarea")') < 0,
  "代码区已无裸 textarea（输入参数用的 textarea 不在本节内）",
);
EQS(count(TD, "node.jscode = codeEd.getValue()"), 2, "运行测试前与关闭时都从编辑器取回代码（同源一致）");

/* —— [4d] 「开发」链路 —— */
[
  "function fnDevNameOf(node) {",
  "function fnDevParamLine(list, startIdx, isIn) {",
  "function fnDevSessionsOf(node) {",
  "function fnDevContractText(node, req) {",
  "function createFnDevSessionForNode(node, req) {",
  "async function developFunctionNode(node) {",
].forEach((sig) => HAS(TOOLS, sig, "app-tools.js 存在 " + sig.replace(/ ?\(.*$/, "")));
const DEV = TOOLS.slice(TOOLS.indexOf("function fnDevNameOf(node) {"));
HAS(DEV, "node.fnDevSessionIds.unshift(sess.id);", "会话 id 追加到 node.fnDevSessionIds");
ok(DEV.indexOf("node.devSessionIds") < 0, "不写开发节点的 devSessionIds（两套会话字段互不污染）");
HAS(DEV, "while (node.fnDevSessionIds.length > 24)", "绑定会话上限 24 条");
HAS(DEV, 'I18n.t("开发 · ")', "会话标题「开发 · 函数名」");
HAS(DEV, "workspace: dshWorkspaceOf(node)", "会话工作区 = 节点所属画布目录");
HAS(DEV, "agentSessionById(S.agentActiveId)", "读当前活动会话的预设与模型（不顺手建空会话）");
ok(
  /model:\s*\(cur && cur\.model\) \|\| ""/.test(DEV),
  "模型跟随当前默认（不硬编模型）",
);
HAS(DEV, "sess._devContract = fnDevContractText(node, reqText)", "任务书写进会话契约");
ok(
  /_src:\s*"dev-node"/.test(DEV) && /_nid:\s*node\.id/.test(DEV),
  "首条消息标 _src dev-node + _nid（与开发节点同一取法）",
);
HAS(DEV, 'devDraftTextareaOpts(node, "fnDev"', "草稿复用 devDraftTextareaOpts（字段名 fnDev）");
HAS(DEV, 'devDraftSet(node, "fnDev", t)', "边写边留存：取消 / Esc / 被顶掉都不丢");
HAS(DEV, 'devDraftSet(node, "fnDev", "")', "提交后清草稿（不重复带上次内容）");
HAS(DEV, "agentSessions().unshift(sess)", "新会话进会话列表");
HAS(DEV, "await agentTouchSession()", "会话落盘（本轮口径：touch = 盖时间戳 + 落盘）");
HAS(DEV, "scheduleSave(true)", "节点上的 fnDevSessionIds 立即存盘");
HAS(DEV, "renderCanvas()", "重绘卡片（按钮 title 的会话数随之更新）");
HAS(DEV, "updateRunQueuePanel()", "运行队列面板按绑定会话口径重算");
HAS(DEV, 'agentSessionSend("", { _devContract: true })', "确认后空消息启动本轮（契约随系统提示注入）");
HAS(DEV, "mtDialogForm({", "「开发」走与开发节点同一套弹窗");
HAS(DEV, "requireText: true", "本次需求必填");
HAS(DEV, "fnDevLastRequestOf(node)", "弹窗回显最近一次要求");

/* —— 契约正文真跑：fnDevContractText 的输出逐条钉住边界 —— */
const FNV = between(
  TOOLS,
  "function fnDevNameOf(node) {",
  "/* 每次「开发」都新建会话运行",
  "app-tools.js fnDev* / fnDevContractText",
);
const FC = vm.createContext({
  console,
  I18n: I18N_STUB,
  ensureFnToolNodeState() {},
  functionCodeOf: (n) => String(n.jscode || ""),
  fnToolParamList: (n, d) => (d === "in" ? n.inputs : n.outputs) || [],
  agentSessions: () => [],
});
vm.runInContext(FNV, FC);
const CONTRACT = vm.runInContext(
  "fnDevContractText({ id:'f1', kind:'function', title:'清洗文本', fnName:'cleanText', description:'去空白'," +
    " inputs:[{name:'text',kind:'text'},{name:'图',kind:'image'},{name:'参考图',kind:'image',list:true}], outputs:[{name:'句子',kind:'text'}]," +
    " jscode:'const a = 1\\nreturn { 句子: a }' }, '把 text 去掉首尾空白')",
  FC,
);
ok(typeof CONTRACT === "string" && CONTRACT.length > 200, "fnDevContractText 真跑产出契约正文");
[
  ["cleanText", "现状含函数名"],
  ["标题：清洗文本", "现状含节点标题"],
  ["节点描述：去空白", "现状含描述"],
  ["入参端子（端子 0 = 控制入，1..N = 各入参，标注 ×N = 列表端子）：1:text(text)、2:图(image)、3:参考图(image,×N)", "入参端子表带端子号与 kind（参数即端子 · 列表入参标 ×N）"],
  ["出参端子（0..M-1 = 各出参，末位 = 控制出）：0:句子(text)", "出参端子表带端子号与 kind（出参侧没有 ×N）"],
  ["JS 代码：共 2 行", "现状含代码行数"],
  ["本次开发需求：把 text 去掉首尾空白", "本次需求进契约"],
  ["只负责这一个函数", "边界①：只改本节点"],
  ["不得新建、删除或改动画布上的任何其它节点，也不得增删连线", "边界②：不动其它节点与连线"],
  ["mtnode_canvas_get", "先读该节点现状"],
  ["mtnode_canvas_edit", "只用 canvas_edit 的 update 补丁"],
  ["jscode / inputs / outputs / description", "可改字段清单钉死"],
  ["复核该节点的连线", "边界③：改参数表必须提醒用户复核连线"],
  ["参数即端子", "「参数即端子」口径写进契约"],
  ["input = { 参数名: 值 }", "执行契约：input 取参"],
  ["return { 输出参数名: 值 }", "执行契约：return 按名分发"],
  ["标 ×N 的列表端子值恒为数组", "执行契约：列表入参端子值恒为数组（只连一条线也是数组）"],
  ["输出端子一律单值", "执行契约：输出侧没有数组端子（一端子一值）"],
  ["要返回多个值请返回数组给下游标 ×N 的列表入参端子", "执行契约：多值该往哪儿给点名到位"],
  ["先问用户再动手", "需求不明先问"],
  ["用一句话汇报改了什么", "收尾一句话汇报"],
  ["不要分两次会话输入重复提交", "需求一次性给出（防重复开工）"],
].forEach(([needle, what]) => HAS(CONTRACT, needle, "契约正文 · " + what));
ok(
  CONTRACT.indexOf("return { 句子: a }") < 0,
  "契约不把代码整份塞进去（只报行数 · 真实内容以 canvas_get 为准）",
);
const C0 = vm.runInContext(
  "fnDevContractText({ id:'f2', kind:'function', title:'', fnName:'', inputs:[], outputs:[], jscode:'' }, '')",
  FC,
);
HAS(C0, "入参端子（端子 0 = 控制入，1..N = 各入参，标注 ×N = 列表端子）：（无）", "无参函数契约回落「（无）」");
HAS(C0, "未命名函数", "没填函数名时回落「未命名函数」");
HAS(C0, "JS 代码：共 0 行", "无代码时行数记 0");
ok(C0.indexOf("本次开发需求：") < 0, "需求为空时不写空的「本次开发需求」行");

/* —— [4e] i18n：新增中文串 ——
 * 界面文案（用户在画布 / 对话框上看到的）必须逐条命中 en 映射，判据严格；
 * 契约正文句子（发给绑定会话的任务书）只要求在 i18n.js 里挂了键（中文为真源，
 * 不整句强求译文），单列判据 —— 否则会误伤其它改动往契约里加的句子。 */
const CONTRACT_FN = between(
  TOOLS,
  "function fnDevContractText(node, req) {",
  "/* 每次「开发」都新建会话运行",
  "app-tools.js fnDevContractText 函数体",
);
const extractKeys = (slice) => {
  const set = new Set();
  const re = /I18n\.t\(\s*(?:\/\*[\s\S]*?\*\/\s*)?"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(slice))) {
    try {
      set.add(JSON.parse('"' + m[1] + '"'));
    } catch (e) {}
  }
  return set;
};
const uiKeySources = {
  卡片代码区与工具条: between(CANVAS, "/* 代码工具条", "const sum = fnToolOutSummaryEl(node);", "卡片代码区切片"),
  卡片开发按钮: between(CANVAS, "const devInfo = document.createElement", "body.appendChild(devInfo);", "卡片「开发」按钮切片"),
  脚手架按钮: between(CANVAS, "scBtn.onclick = async () => {", "  wrap.appendChild(scBtn);", "脚手架按钮切片"),
  试跑台代码区: CODE_REGION,
  函数开发会话与弹窗: DEV.replace(CONTRACT_FN, ""),
};
const newKeys = new Set();
for (const [label, slice] of Object.entries(uiKeySources)) {
  ok(!!slice, "取到切片用于词条提取：" + label);
  for (const k of extractKeys(slice)) newKeys.add(k);
}
ok(newKeys.size >= 40, "界面新增中文串提取 " + newKeys.size + " 条（切片未失效）");
const I18N = require(path.join(__dirname, "..", "renderer", "i18n.js"));
I18N.setLocale("en");
const miss = [];
for (const k of newKeys) {
  const en = I18N.t(k);
  if (en === k || !String(en).trim()) miss.push(k);
}
ok(miss.length === 0, "i18n(en) 覆盖全部界面新增中文串（" + newKeys.size + " 条）");
miss.forEach((k) => console.log("  MISS  " + JSON.stringify(k.slice(0, 48))));
/* 契约正文句子：本计划写进任务书的这些句子必须在 i18n.js 挂了键
   （不整句强求译文，但漏挂键 = 双语侧彻底没有这条；也不用动态全集判定，
     避免其它改动往契约里新增的句子把这条链路测试拖红） */
const I18N_SRC = read("renderer/i18n.js");
const I18N_EN_SRC = I18N_SRC.slice(0, I18N_SRC.indexOf("var locale ="));
[
  "【函数开发任务书】",
  "本会话由该函数节点的「开发」按钮新建",
  "改动边界（必须严格遵守）",
  "复核该节点的连线",
  "执行契约：jscode 里 input = { 参数名: 值 }",
  "需求不明确时先问用户再动手",
  "本次开发需求已在任务书中一次性完整给出",
  "入参端子（端子 0 = 控制入，1..N = 各入参，标注 ×N = 列表端子）：",
  "出参端子（0..M-1 = 各出参，末位 = 控制出）：",
  "行（真实内容以 mtnode_canvas_get 读到的为准）",
  "本节点标题（mtnode_canvas_get 的 ids 与 update 的定位就用它）：",
].forEach((frag) =>
  HAS(I18N_EN_SRC, frag.replace(/"/g, '\\"'), "契约句子在 i18n 英文表里挂了键：" + frag.slice(0, 22) + "…"),
);
I18N.setLocale("zh");
EQS(I18N.t("格式化"), "格式化", "zh 口径原样返回中文真源（中文为真源）");

/* ═══════════ [5] CSS：三层叠放样式确实存在（「点不动」的根因回归） ═══════════ */
console.log(
  "\n[5] CSS：组件吐出的每个 class 都真有规则 · textarea 在上层收事件 · 两层度量同源",
);
{
  const CSS = read("renderer/css/canvas.css");
  const CSSL = read("renderer/css/theme-light.css");
  const ENTRY = read("renderer/style.css");
  const CE_SRC = read("renderer/app-codeedit.js");
  /* 按「选择器整串」取声明块：先去注释（注释里全是 .js-edit 这类字样，留着会把
     选择器整串污染成对不上），再逐条比对；.js-edit 不会误命中 .js-edit-hl。 */
  const norm = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*,\s*/g, ",")
      .trim();
  const rulesOf = (src) => {
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, "");
    const list = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) list.push([norm(m[1]), m[2]]);
    return list;
  };
  const ruleOf = (src, sel) => {
    const want = norm(sel).replace(/ \{$/, "").replace(/\{$/, "");
    const hit = rulesOf(src).find(([s]) => s === want);
    return hit ? hit[1] : null;
  };
  const has = (sel, re, msg) => {
    const b = ruleOf(CSS, sel);
    ok(!!b && re.test(b), msg + (b ? "" : "（canvas.css 里没有 " + sel + " 这条规则）"));
  };

  /* —— ① 组件真实吐出的每一个 class，CSS 里都必须有对应规则 ——
     这就是本轮 Bug 的堵口：以前 js-edit / jsl-* 在 renderer/css/*.css 里命中数为 0，
     三层按文档流竖排 → 看到的是不可点的行号 + 镜像文字，可编辑 textarea 被挤出板身。 */
  const emitted = new Set();
  const addCls = (s) =>
    String(s || "")
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => emitted.add(c));
  /* 结构层：外层容器 + 行号槽 + 镜像层 + 输入层（直接取 [3] 真跑出来的组件） */
  addCls(EV("window.__ed.el.className"));
  addCls(kid(0).className);
  addCls(kid(1).className);
  addCls(kid(2).className);
  /* 行号槽与高亮层都由 innerHTML 拼出来：把里面出现过的 class 也收进来（含 .js-ln） */
  for (const htmlSrc of [kid(0).innerHTML, kid(1).innerHTML]) {
    const m2 = /class="([^"]*)"/g;
    let g;
    while ((g = m2.exec(String(htmlSrc || "")))) addCls(g[1]);
  }
  /* 源码里写死的 class（「js-ln cur」当前行标记等在运行时才出现的，也从源码取一遍） */
  const clsFromSrc = /"((?:n-text\s+)?js-(?:edit|ln)\w*(?: \w+)*|jsl-[a-z]+)"/g;
  let g2;
  while ((g2 = clsFromSrc.exec(CE_SRC))) addCls(g2[1]);
  /* 高亮层的 token class：直接从真跑出来的富样本里取，保证与 jsHighlightHtml 同源 */
  addCls(
    [...hl(RICH).matchAll(/class="([^"]*)"/g)].map((x) => x[1]).join(" "),
  );
  const clsList = [...emitted].sort();
  ok(clsList.length >= 14, "收集到组件真实使用的 class 共 " + clsList.length + " 个");
  const noStyle = clsList.filter((c) => CSS.indexOf("." + c) < 0);
  ok(
    noStyle.length === 0,
    "每个 class 在 canvas.css 里都有规则（" + clsList.join(" ") + "）",
  );
  noStyle.forEach((c) => console.log("  MISS  ." + c));

  /* —— ② 三层叠放：输入层在最上且收事件，镜像层只负责显示 —— */
  has(".js-edit {", /position:\s*relative/, ".js-edit 是绝对定位的参照系（容器自己裁边）");
  has(".js-edit {", /overflow:\s*hidden/, ".js-edit overflow:hidden（溢出内容不外溢到板身外）");
  has(
    ".js-edit {",
    /--js-gw:/,
    ".js-edit 上声明度量真源变量（行号槽宽 / 字号 / 行高 / 内边距改一处即可）",
  );
  has(".js-edit-gutter {", /position:\s*absolute/, "行号槽绝对贴在容器左缘（不占文档流把两层挤下去）");
  has(".js-edit-gutter {", /width:\s*var\(--js-gw\)/, "行号槽宽 = --js-gw（代码两层按同一变量让位）");
  has(".js-edit-gutter {", /pointer-events:\s*none/, "行号槽不接事件（点行号也要落进代码区）");
  has(".js-edit-hl {", /pointer-events:\s*none/, "高亮镜像层不接事件（点击穿透到 textarea）");
  has(".js-edit-hl {", /overflow:\s*hidden/, "镜像层不自带滚动条（滚动位置由 JS 照搬 textarea）");
  has(".js-edit-input {", /z-index:\s*1/, "textarea 叠在镜像层之上 → 才是「点得动、能编辑」的那一层");
  has(".js-edit-input {", /color:\s*transparent/, "输入层文字透明（彩色字由镜像层画）");
  has(".js-edit-input {", /-webkit-text-fill-color:\s*transparent/, "Chromium 下文字色必须用 text-fill-color 才压得住");
  has(".js-edit-input {", /caret-color:/, "透明文字仍保留光标颜色");
  has(".js-ln {", /font-variant-numeric:\s*tabular-nums/, "行号用等宽数字（10 与 11 同宽，不会左右跳）");
  has(".js-ln.cur {", /color:/, "当前行行号有独立高亮色");
  has(".fn-code-bar {", /flex:\s*none/, "代码工具条 flex:none（编辑器容器高度才归卡片管）");

  /* —— ③ 两层字体度量必须同源：共用「同一条声明块」，逐条钉死相同 —— */
  const SHARED = ".js-edit-hl,.js-edit-input";
  const shared = ruleOf(CSS, SHARED);
  ok(!!shared, "镜像层与输入层共用一条声明块（.js-edit-hl, .js-edit-input）· 度量只写一次");
  [
    [/position:\s*absolute/, "两层都绝对定位"],
    [/inset:\s*0 0 0 var\(--js-gw\)/, "两层同一 inset（左缘让出同一个行号槽宽）"],
    [/box-sizing:\s*border-box/, "盒模型一致（padding / border 不再造成像素差）"],
    [/padding:\s*var\(--js-pad\)/, "内边距同一变量"],
    [/font-size:\s*var\(--js-fs\)/, "字号同一变量"],
    [/line-height:\s*var\(--js-lh\)/, "行高同一变量（逐行对齐的前提）"],
    [/font-family:\s*var\(--mono\)/, "同一字体族"],
    [/white-space:\s*pre/, "两层都不软换行（与 textarea 的 wrap=off 对齐 · 行号 1:1）"],
    [/tab-size:\s*4/, "制表符宽度一致"],
    [/letter-spacing:\s*normal/, "字距一致"],
    [/scrollbar-gutter:\s*stable/, "两侧恒定预留滚动条槽 → clientWidth 相同，scrollLeft 可直接照搬"],
    [/font-variant-ligatures:\s*none/, "关掉连字（镜像层把文字切成 span，连字会让两层宽度不等）"],
  ].forEach(([re, msg]) => ok(!!shared && re.test(shared), "共用度量块 · " + msg));
  for (const sel of [".js-edit-hl {", ".js-edit-input {"]) {
    const b = ruleOf(CSS, sel) || "";
    ok(
      !/font-size:|line-height:|padding:|tab-size:|white-space:/.test(b),
      sel + " 不重述度量（重述就等于给两层错开的机会 · 只写一次在共用块里）",
    );
  }
  /* .n-text 是 pre-wrap + break-word，会把 wrap="off" 顶掉 —— 共用块必须把它顶回来 */
  const NTEXT = ruleOf(CSS, ".n-prompt-hl, .n-text.n-text-layered") || "";
  ok(
    /white-space:\s*pre\b/.test(shared || "") || /white-space/.test(NTEXT),
    "分层方案的 white-space 口径由叠放层自己钉死（不被 .n-text 的 pre-wrap 带偏）",
  );

  /* —— ④ token 配色：jsHighlightHtml 吐出的每个 class 都真有颜色规则（暗色 + 亮色） —— */
  const TOKENS = [...new Set([...hl(RICH).matchAll(/class="(jsl-[a-z]+)"/g)].map((x) => x[1]))].sort();
  ok(TOKENS.length >= 8, "富样本里出现 " + TOKENS.length + " 种 token 配色：" + TOKENS.join(" "));
  for (const t of TOKENS) {
    ok(!!ruleOf(CSS, "." + t + " {"), "canvas.css 有 ." + t + " 的颜色规则");
    ok(!!ruleOf(CSSL, "body.theme-light ." + t + " {"), "theme-light.css 补了 ." + t + " 的浅色配色");
  }
  /* 契约词只靠颜色区分：镜像层加粗会让整行比 textarea 宽 → 光标错位 */
  const con = ruleOf(CSS, ".jsl-con {") || "";
  ok(
    /color:/.test(con) && !/font-weight:/.test(con),
    ".jsl-con 只用颜色、不加 font-weight（字重差异会让两层同一行文字宽度不等）",
  );

  /* —— ⑤ 亮色主题与样式装载链（写了没加载 = 同一个 Bug 的另一种死法） —— */
  ok(!!ruleOf(CSSL, "body.theme-light .js-edit-gutter {"), "theme-light.css 补了行号槽底色");
  ok(!!ruleOf(CSSL, "body.theme-light .js-ln {"), "theme-light.css 补了行号字色");
  ok(
    !!ruleOf(CSSL, "body.theme-light .js-edit-input::selection {"),
    "theme-light.css 换了浅色下可见的选区色（暗色那层半透明青字在白底几乎看不见）",
  );
  const lightOnlyColor = (CSSL.match(/body\.theme-light \.js(?:l-|-edit|-ln)[^{}]*\{[^{}]*\}/g) || []).every(
    (blk) => !/position:|font-size:|line-height:|padding:/.test(blk),
  );
  ok(lightOnlyColor, "亮色覆盖只改颜色、不碰度量（改了就会与暗色两层错位）");
  HAS(ENTRY, '@import url("./css/canvas.css");', "style.css 聚合入口真的 @import canvas.css");
  HAS(ENTRY, '@import url("./css/theme-light.css");', "style.css 聚合入口真的 @import theme-light.css");
  ok(
    ENTRY.indexOf('@import url("./css/canvas.css");') <
      ENTRY.indexOf('@import url("./css/theme-light.css");'),
    "canvas.css 先于 theme-light.css（亮色覆盖才压得住暗色基线）",
  );
  HAS(read("renderer/index.html"), '<link rel="stylesheet" href="style.css">', "index.html 装载 style.css（样式链完整）");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " : "PASS ") + checks + " 项检查");
process.exitCode = fails ? 1 : 0;

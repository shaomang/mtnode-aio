"use strict";
/* 输入框内查找（Ctrl+F · renderer/app-find.js）回归
 *   node test/smoke-field-find.js
 *
 * 需求：焦点在文本输入框里时，Ctrl+F 开一只查找框，用来在这**一个输入框内部**
 * 快速定位指定文字（高亮命中 + 自动滚到可视区，可循环上一个 / 下一个）。
 *
 * 分工（与 renderer/app-search.js 的全局搜索同占 Ctrl+F）：
 *   焦点在 input / textarea 里 → 本模块的框内查找条；
 *   焦点不在可编辑区 → 维持原状，仍由 app.js 呼出跨区域全局搜索浮层。
 *
 * 本测试分两层：
 *   [A] 源码口径：模块接线 / 键位与分工 / persistent 关闭路径 / i18n 词条
 *   [B] 真跑纯逻辑：vm 载入 renderer/app-find.js，跑匹配、循环取位、横向滚动量
 * ─────────────────────────────────────────────────────────────────── */
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
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");
const show = (v) => JSON.stringify(v);

const find = read("renderer/app-find.js");
const search = read("renderer/app-search.js");
const app = read("renderer/app.js");
const boot = read("renderer/app-boot.js");
const html = read("renderer/index.html");
const style = read("renderer/style.css");
const css = read("renderer/css/find.css");
const i18n = read("renderer/i18n.js");

console.log("\n[1] 模块接线：新文件被 index.html 与 style.css 收进来");
{
  ok(html.indexOf('<script src="app-find.js"></script>') > 0, "index.html 引入 app-find.js");
  ok(
    html.indexOf('src="app-search.js"') < html.indexOf('src="app-find.js"') &&
      html.indexOf('src="app-find.js"') < html.indexOf('src="app-boot.js"'),
    "加载顺序：app-search.js → app-find.js → app-boot.js（框内查找排在全局搜索之后）",
  );
  ok(style.indexOf('@import url("./css/find.css")') > 0, "style.css 聚合 css/find.css");
  ok(fs.existsSync(path.join(__dirname, "..", "renderer", "css", "find.css")), "css/find.css 存在");
  const z = Number((css.match(/\.fd-bar\s*\{[^}]*z-index:\s*(\d+)/) || [])[1] || 0);
  ok(z > 12000, "查找条层级高于全局搜索浮层（12000）：z-index=" + z);
  ok(
    boot.indexOf("fieldFindRepaint()") > 0,
    "app-boot.js 切语言时重绘查找条文案（与 globalSearchRepaint 同一口径）",
  );
  ok(
    html.indexOf("fdBar") < 0 && find.indexOf('document.createElement') > 0,
    "查找条 DOM 由模块自建（index.html 里不放静态结构）",
  );
  ok(
    find.indexOf("window.openFieldFind = openFieldFind") > 0 &&
      find.indexOf("window.closeFieldFind = closeFieldFind") > 0 &&
      find.indexOf("window.fieldFindIsOpen = fieldFindIsOpen") > 0 &&
      find.indexOf("window.fieldFindRepaint = fieldFindRepaint") > 0,
    "公开入口挂在 window（openFieldFind / closeFieldFind / fieldFindIsOpen / fieldFindRepaint）",
  );
}

console.log("\n[2] 键位与分工：Ctrl+F 在输入框里给框内查找，在别处仍是全局搜索");
{
  ok(
    app.indexOf("if (!inField && typeof openGlobalSearch") > 0,
    "app.js 照旧「焦点在可编辑区就不抢 Ctrl+F」（让位语义不变）",
  );
  ok(
    app.indexOf('if (mod && key === "f" && !ev.altKey && !ev.shiftKey)') > 0 &&
      app.indexOf("openGlobalSearch()") > 0,
    "焦点不在可编辑区时，Ctrl+F 仍呼出全局搜索浮层",
  );
  ok(
    find.indexOf('document.addEventListener(\n  "keydown",') > 0 &&
      find.indexOf(",\n  true,\n);") > 0,
    "框内查找的 keydown 挂在 document 捕获段（先于 app.js / app-keys.js 的冒泡监听）",
  );
  ok(
    find.indexOf('if (mod && key === "f" && !ev.altKey && !ev.shiftKey)') > 0 &&
      find.indexOf("fdFieldFromFocus()") > 0,
    "捕获段里先判「焦点是不是在输入框」：不在就 return，整只让给全局搜索",
  );
  ok(
    find.indexOf("ev.preventDefault()") > 0 && find.indexOf("ev.stopPropagation()") > 0,
    "接管时拦住默认行为并停传播（不让下游再处理一次）",
  );
  for (const [key, label] of [
    ["Enter", "Enter 下一个"],
    ["ArrowDown", "↓ 下一个"],
    ["ArrowUp", "↑ 上一个"],
    ["Escape", "Esc 关框"],
  ])
    ok(find.indexOf('ev.key === "' + key + '"') > 0, "键位齐备：" + label);
  ok(
    find.indexOf("ev.shiftKey ? 0 : 1") > 0 && find.indexOf("fdGoto(FD_BAR.cur - 1") > 0,
    "Shift+Enter / ↑ 反向（上一个命中）",
  );
  ok(find.indexOf("advance: true") > 0, "框已开着再按一次 Ctrl+F = 跳到下一个命中");
  ok(
    find.indexOf("FD_BAR.ui.input === document.activeElement") > 0,
    "焦点已在查找框自己身上时，Ctrl+F 仍指回那只被查找的输入框（不自查自己）",
  );
}

console.log("\n[3] 只看输入框、不越界：目标与查询口径");
{
  ok(
    find.indexOf('tag === "textarea"') > 0 && find.indexOf('tag === "input"') > 0,
    "只认 input / textarea 作为查找目标",
  );
  ok(
    find.indexOf("FD_INPUT_TEXT_TYPES = { text: 1") > 0 &&
      find.indexOf("FD_INPUT_TEXT_TYPES[type]") > 0,
    "单行 input 按 type 白名单（数字 / 颜色等没有可查文本的排除）",
  );
  ok(find.indexOf("setSelectionRange") > 0, "命中高亮走原生选区（输入框自带的高亮）");
  ok(
    find.indexOf("el.scrollLeft") > 0 && find.indexOf("fdScrollLeftFor") > 0,
    "输入框横向滚动自己算（超出可视宽度才滚）",
  );
  ok(
    find.indexOf("el.setRangeText") < 0 &&
      find.indexOf("el.value.replace") < 0 &&
      /el\.value\s*=[^=]/.test(find) === false,
    "只读不改：全程不写目标输入框的值（不打断宿主监听）",
  );
  ok(
    find.indexOf('"input", () =>') > 0 && find.indexOf("fdSearch(input.value") > 0,
    "查找框自己打字就实时重算命中",
  );
}

console.log("\n[4] persistent：只走 Esc / ✕ / 再按一次 Ctrl+F，不挂点外部即关");
{
  /* 代码段：从第一处 function 起（把模块头部注释整段排除，判定只看真代码） */
  const findCode = find.slice(find.indexOf("function fdFindMatches"));
  ok(
    findCode.indexOf('document.addEventListener("click"') < 0 &&
      findCode.indexOf('document.addEventListener("mousedown"') < 0 &&
      findCode.indexOf('window.addEventListener("click"') < 0 &&
      findCode.indexOf('window.addEventListener("mousedown"') < 0 &&
      findCode.indexOf("document.onclick") < 0 &&
      findCode.indexOf("document.onmousedown") < 0,
    "没有「点空白 / 点外部就关」的监听（document / window 级 click 一律不挂）",
  );
  ok(
    findCode.indexOf("addEventListener(") > 0 &&
      findCode.indexOf('"focusout"') > 0 &&
      findCode.indexOf("closeFieldFind();") > 0 &&
      findCode.indexOf("isConnected") > 0,
    "只有 focusout 做生命周期回收（isConnected=false 才关），没有「失焦就关」",
  );
  ok(
    findCode.split("addEventListener(").length - 1 >= 3 && findCode.indexOf('"keydown"') > 0,
    "监听面收敛：keydown + focusout + resize（外加控件自身）",
  );
  /* 所有无参 closeFieldFind() 只允许出现在「目标已被搬走（isConnected=false）」那条回收分支上 */
  const bare = [];
  const reBare = /closeFieldFind\(\)/g;
  let mBare;
  while ((mBare = reBare.exec(findCode))) {
    bare.push(findCode.slice(Math.max(0, mBare.index - 60), mBare.index).replace(/\s+/g, " "));
  }
  ok(
    bare.length === 1 && bare[0].indexOf("isConnected") > 0,
    "无参关框只出现在 isConnected 回收分支（手动关走 Esc /  显式路径）：" + show(bare),
  );
  ok(find.indexOf("closeFieldFind({ focus: true })") > 0, "Esc 与 ✕ 都是显式关闭路径");
  ok(
    find.indexOf("if (!FD_BAR.el.isConnected) closeFieldFind();") > 0,
    "目标输入框被重渲染搬走时才回收（focusout 只判 isConnected，不因失焦就关）",
  );
  ok(
    find.indexOf("const same = FD_BAR.open && FD_BAR.el === el") > 0,
    "同一输入框再开不清空查询；换目标才重置",
  );
  ok(
    find.indexOf("FD_BAR.matches = []") > 0 && find.indexOf("fd-hit") > 0,
    "关框清命中 + 收回命中描边类",
  );
}

console.log("\n[5] i18n：新词条齐备（中英双份）");
{
  for (const k of [
    "在本输入框内查找",
    "上一个命中",
    "下一个命中",
    "关闭查找框",
    "无匹配",
    "Enter 下一个 · Shift+Enter 上一个 · Esc 关闭",
  ])
    ok(i18n.indexOf('"' + k + '"') > 0, "词条（中文键）：" + k);
  ok(
    i18n.indexOf('"Find in this field"') > 0 && i18n.indexOf('"No match"') > 0,
    "英文译文齐备",
  );
  ok(
    i18n.indexOf('"在本输入框内查找": "Find in this field"') > 0,
    "键值成对（zh 原样回显、en 走译文）",
  );
  ok(
    search.indexOf("搜索画布、会话、专家团、素材、工具、技能与文档…") > 0,
    "全局搜索的文案与入口未被改动",
  );
}

console.log("\n[6] 真跑纯逻辑：匹配 / 循环取位 / 横向滚动（vm 载入真源码）");
{
  const sb = {
    console,
    document: { addEventListener: () => {}, getElementById: () => null },
    window: { addEventListener: () => {} },
    I18n: { t: (s) => String(s) },
  };
  vm.createContext(sb);
  vm.runInContext(find, sb);
  const call = (expr) => vm.runInContext(expr, sb);

  /* 匹配：大小写不敏感 + 允许重叠 */
  ok(
    call('JSON.stringify(fdFindMatches("abcABCabc","abc"))') ===
      show([
        { start: 0, end: 3 },
        { start: 3, end: 6 },
        { start: 6, end: 9 },
      ]),
    "大小写不敏感列出全部命中（3 处）",
  );
  ok(
    call('JSON.stringify(fdFindMatches("aaaa","aa"))') ===
      show([
        { start: 0, end: 2 },
        { start: 1, end: 3 },
        { start: 2, end: 4 },
      ]),
    "允许重叠：aaaa 里找 aa 得 3 个（与「上一个 / 下一个」的期望一致）",
  );
  ok(call('fdFindMatches("abc","")').length === 0, "空查询不产生命中");
  ok(call('fdFindMatches("","a").length') === 0, "空正文不产生命中（0 个）");
  ok(
    call('JSON.stringify(fdFindMatches("第一段\\n第二段 关键词","关键词")[0])') ===
      show({ start: 8, end: 11 }),
    "多行文本按字符下标定位（含换行）",
  );

  /* 循环取位 */
  ok(call("fdCycle(-1, 3, 1)") === 0, "首次进入取第一个");
  ok(call("fdCycle(2, 3, 1)") === 0, "最后一个再下一个 → 回到第一个（循环）");
  ok(call("fdCycle(0, 3, -1)") === 2, "第一个再上一个 → 绕到最后一个（循环）");
  ok(call("fdCycle(1, 3, 0)") === 1, "dir=0 取当前位");
  ok(call("fdCycle(7, 3, 1)") === 0 && call("fdCycle(7, 3, -1)") === 2, "越界夹回两端");
  ok(call("fdCycle(0, 0, 1)") === -1, "没有命中时返回 -1（不跳转）");

  /* 横向滚动量 */
  const far = call("fdScrollLeftFor({before:'x'.repeat(200), charW:8, boxW:200})");
  ok(far === 200 * 8 - 50, "命中在很右边时才滚（need - 四分之一可视宽）：" + far);
  ok(
    call("fdScrollLeftFor({before:'abc', charW:8, boxW:200})") === 0,
    "命中已在靠左区域：不乱滚",
  );
  ok(
    call("fdScrollLeftFor({before:'a\\n'.repeat(50) + 'abc', charW:8, boxW:200})") === 0,
    "多行输入框按最后一行算列数（换行前的长行不影响）",
  );
  ok(
    call("fdScrollLeftFor({before:'x'.repeat(50), charW:0, boxW:200})") === 0,
    "量不到字符宽时不滚（宁可不动也不乱跳）",
  );
  ok(
    call("fdScrollLeftFor({})") === 0 && call("fdScrollLeftFor(null)") === 0,
    "缺参数不抛异常",
  );

  /* 元素判定 */
  const mk = (tag, type) => ({
    nodeType: 1,
    tagName: tag,
    getAttribute: () => type || null,
  });
  ok(call("fdIsSearchableField({nodeType:1,tagName:'TEXTAREA',getAttribute:()=>null})") === true, "textarea 可查");
  ok(call("fdIsSearchableField({nodeType:1,tagName:'INPUT',getAttribute:()=>'text'})") === true, "text input 可查");
  ok(call("fdIsSearchableField({nodeType:1,tagName:'INPUT',getAttribute:()=>null})") === true, "缺 type 的 input 按 text 处理");
  ok(call("fdIsSearchableField({nodeType:1,tagName:'INPUT',getAttribute:()=>'checkbox'})") === false, "checkbox 不可查");
  ok(call("fdIsSearchableField({nodeType:1,tagName:'INPUT',getAttribute:()=>'number'})") === false, "number 不可查");
  ok(call("fdIsSearchableField({nodeType:1,tagName:'DIV',getAttribute:()=>null})") === false, "普通 div 不可查");
  ok(call("fdIsSearchableField(null)") === false, "null 不抛异常");
  void mk;
}

console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));
process.exit(fails ? 1 : 0);
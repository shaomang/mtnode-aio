"use strict";
/* 会话 / 助手对话里「复制 · 保存」动作条回归
 *   node test/smoke-msg-actions.js
 * 需求：对话（智能会话 · 全局助手 · 专家团单聊 · 节点内联会话 · 手册问答）里模型常回
 *   代码块或 Markdown 文档，渲染成富文本后没法直接拿去用 —— 消息最下方要有「复制」「保存」
 *   两枚按钮，且只在正文真的含代码 / Markdown 结构时出现。
 * 覆盖：
 *   [1] 源码口径：动作条只在必要时挂、挂的位置、与时间行小按钮不重复、保存走主进程对话框
 *   [2] 纯函数真源码行为（vm）：出现条件 / 取哪一份内容 / 文件名
 *   [3] 样式与词条接线
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
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");

const ASSIST = read("renderer/app-assist.js");
const APP = read("renderer/app.js");
const I18N = read("renderer/i18n.js");
const DSH_CSS = read("renderer/css/dsh.css");
const LIGHT_CSS = read("renderer/css/theme-light.css");

/* ==================== [1] 源码口径 ==================== */
console.log("\n[1] 动作条接线：只在正文含代码 / Markdown 时出现，且不与时间行小按钮重复");
ok(
  /function dshMsgNeedActions\(txt\) \{/.test(ASSIST),
  "新增 dshMsgNeedActions（出现条件：代码块 / 标题 / 引用 / 表格 / ≥2 行列表）",
);
ok(
  /function dshMsgActionBar\(text, role\) \{/.test(ASSIST) &&
    /bar\.className = "dsh-msg-actions";/.test(ASSIST),
  "新增 dshMsgActionBar（容器 .dsh-msg-actions）",
);
ok(
  /const hasActions = dshMsgNeedActions\(actText\);/.test(ASSIST) &&
    /if \(hasActions\) \{[\s\S]{0,200}row\.appendChild\(dshMsgActionBar\(actText, m\.role\)\);/.test(
      ASSIST,
    ),
  "dshMsgBlock 在正文之后挂动作条（取 m.content 原文，用户 / AI 消息同一口径）",
);
ok(
  ASSIST.indexOf('row.appendChild(dshMsgActionBar(actText, m.role));') <
    ASSIST.indexOf('tail.className = "dsh-msg-tail";'),
  "动作条在时间行（.dsh-msg-tail）之前 = 消息最下方",
);
ok(
  /if \(m\.role === "assistant" && !hasActions\)[\s\S]{0,80}tail\.appendChild\(dshCopyBtn\(m, "dsh-msg-tail-copy"\)\);/.test(
    ASSIST,
  ),
  "已有动作条的消息不再挂时间行那枚小「复制」（同一条消息不出现两枚「复制」）",
);
ok(
  /if \(m\.role === "user" && !hasActions\)[\s\S]{0,80}head\.appendChild\(dshCopyBtn\(m, "dsh-msg-copy"\)\);/.test(
    ASSIST,
  ),
  "用户消息头部的小「复制」同样让位（判定在头部拼接之前算好）",
);
ok(
  /try \{\s*row\.appendChild\(dshMsgActionBar\(actText, m\.role\)\);/.test(ASSIST) &&
    /console\.error\("消息动作条渲染失败", e\);/.test(ASSIST),
  "动作条渲染异常不拖垮整条消息（坏数据只跳过这一条）",
);
ok(
  /function dshMsgFileName\(txt, role, ext\) \{/.test(ASSIST),
  "新增 dshMsgFileName（首个标题当文件名，否则角色 + 时间戳）",
);
ok(
  /api\.fileSaveDialog\(\{[\s\S]{0,1200}api\.fileWriteText\(pick\.path, payload\.text\)/.test(
    ASSIST,
  ),
  "保存走主进程 file:saveDialog + file:writeText（位置用户选，不落应用目录）",
);
ok(
  /if \(!pick \|\| !pick\.path\) return;/.test(ASSIST),
  "用户取消保存对话框时静默返回（不报错、不写盘）",
);
ok(
  /typeof dshMsgNeedActions === "function"[\s\S]{0,300}bubble\.appendChild\(dshMsgActionBar\(msg\.content, "assistant"\)\);/.test(
    APP,
  ),
  "手册问答助手（app.js renderDocsAskList）复用同一动作条",
);
ok(
  ASSIST.indexOf('dshClipboardWrite(payload.text)') > 0,
  "复制走既有 dshClipboardWrite（navigator.clipboard → preload 桥回退）",
);

/* ==================== [2] 纯函数真源码行为 ==================== */
console.log("\n[2] 出现条件 / 取哪一份内容 / 文件名（跑真源码）");
const from = ASSIST.indexOf("const DSH_MSG_CODE_ONLY_RE =");
const to = ASSIST.indexOf("/* 保存：选位置");
ok(from > 0 && to > from, "摘到动作条纯函数段真源码");
const sb = {
  console,
  I18n: { t: (k) => String(k) },
  Date: Date,
};
vm.createContext(sb);
const api = vm.runInNewContext(
  ASSIST.slice(from, to) + "\n({ dshMsgPayload, dshMsgNeedActions, dshMsgFileName, DSH_CODE_EXT })",
  sb,
);
ok(typeof api.dshMsgPayload === "function" && typeof api.dshMsgNeedActions === "function", "两个纯函数取到");

/* 出现条件 */
ok(api.dshMsgNeedActions("```js\nconst a = 1;\n```"), "围栏代码块 → 出现");
ok(api.dshMsgNeedActions("开头一句\n```\n未完的流式围栏"), "未闭合围栏（流式中途）也出现");
ok(api.dshMsgNeedActions("## 小结\n正文"), "标题 → 出现");
ok(api.dshMsgNeedActions("> 引用一句话"), "引用 → 出现");
ok(api.dshMsgNeedActions("| a | b |\n| - | - |\n| 1 | 2 |"), "表格 → 出现");
ok(api.dshMsgNeedActions("步骤：\n1. 第一步\n2. 第二步"), "有序列表（≥2 行）→ 出现");
ok(api.dshMsgNeedActions("注意：\n- 甲\n- 乙"), "无序列表（≥2 行）→ 出现");
ok(!api.dshMsgNeedActions("只有一行：\n- 单项"), "单独一行列表不出现（噪声门槛）");
ok(!api.dshMsgNeedActions("好的，我这就去做，**重点**已用 `行内码` 标出。"), "纯段落（只加粗 / 行内码）不出现");
ok(!api.dshMsgNeedActions("   \n  "), "空白消息不出现");

/* 取哪一份内容 */
const codeOnly = api.dshMsgPayload("```python\nprint('hi')\nprint('yo')\n```");
ok(codeOnly.code === true && codeOnly.lang === "python", "纯代码消息认得语种（python）");
ok(codeOnly.text === "print('hi')\nprint('yo')", "纯代码消息取围栏内代码，围栏行不进剪贴板");
ok(
  api.dshMsgPayload("```js\nconst a = 1;\n```\n以上是示例。").code === false,
  "围栏外还有正文 → 不算纯代码消息（整体取原文，不丢解释）",
);
const mixed = "说明：\n```js\nconst a = 1;\n```\n就这样。";
ok(
  api.dshMsgPayload(mixed).text === mixed,
  "夹代码的消息保存整条正文原文（Markdown 源，一个字不丢）",
);
ok(api.dshMsgPayload("").text === "" && api.dshMsgPayload("").code === false, "空正文安全");

/* 文件名 */
ok(
  api.dshMsgFileName("## 部署说明\n步骤…", "assistant", "md") === "部署说明.md",
  "首个标题当文件名（去掉 # 与后缀扩展名由调用方给）",
);
ok(
  api.dshMsgFileName('# a/b:c*d?e"f<g>h|i\nj', "assistant", "md").indexOf("/") < 0 &&
    api.dshMsgFileName('# a/b:c*d?e"f<g>h|i\nj', "assistant", "md").indexOf(":") < 0,
  "Windows 非法文件名字符一律换成空格",
);
const noHead = api.dshMsgFileName("```js\nx\n```", "assistant", "js");
ok(
  /^AI 回复-\d{8}-\d{4}\.js$/.test(noHead),
  "没有标题就按角色 + 时间戳命名，扩展名跟语种走（" + noHead + "）",
);
ok(
  /^我的输入-\d{8}-\d{4}\.md$/.test(api.dshMsgFileName("随便写点", "user", "md")),
  "用户消息的兜底名字是「我的输入」",
);
ok(
  api.dshMsgFileName("# " + "长".repeat(200), "assistant", "md").length <= 64,
  "标题派生文件名夹在 60 字以内（不超长）",
);
ok(
  api.DSH_CODE_EXT.python === "py" && api.DSH_CODE_EXT.typescript === "ts" && !api.DSH_CODE_EXT.zzz,
  "语种 → 扩展名表认得常见几门（认不出由调用方回退 txt）",
);

/* ==================== [3] 样式与词条 ==================== */
console.log("\n[3] 样式与词条接线");
ok(
  /\.dsh-msg-actions \{[\s\S]{0,120}\.dsh-msg-actions \.dsh-msg-act \{/.test(DSH_CSS),
  "dsh.css 新增 .dsh-msg-actions / .dsh-msg-act 样式",
);
ok(
  /\.dsh-msg-actions \.dsh-msg-act\.ok \{/.test(DSH_CSS),
  "复制 / 保存成功态 .ok 有反馈样式",
);
ok(
  /body\.theme-light \.dsh-msg-actions \.dsh-msg-act \{/.test(LIGHT_CSS),
  "浅色主题有对应覆盖（深色半透明底换掉）",
);
for (const key of [
  "复制代码（围栏已去掉）到剪贴板",
  "复制本条正文原文（Markdown / 代码）到剪贴板",
  "把本条内容另存为文件",
  "保存消息内容",
  "代码文件",
  "Markdown 文件",
  "AI 回复",
  "我的输入",
  "当前环境不支持文件保存",
]) {
  ok(I18N.indexOf('"' + key + '"') >= 0, "i18n EN 词条齐备：" + key);
}

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-msg-actions)",
);
process.exit(fails ? 1 : 0);

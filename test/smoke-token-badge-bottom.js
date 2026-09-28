"use strict";
/* Token 报告挂在会话最底部（输入框下面）回归
 *   node test/smoke-token-badge-bottom.js
 * 现场（真源全在 renderer/ 里）：
 *   报告 Badge（app-agent.js 的 tokBadgeEl）早先挂在会话消息区的**末位子元素**上并
 *   sticky 吸附（用户报障：长会话里得一路拖到底，还和输入区挤在一起）。现在会话面板 /
 *   助手栏把它移出消息区，挂到**输入框下面**的尾部容器：
 *     · 会话面板 → .agent-body（输入区 .agent-composer 之后）
 *     · 助手栏   → #assistPane（输入行 .assist-input-row 之后）
 *   节点内会话（.agent-conv / .chat-list）例外：节点框高被 convH + inputH 钉死，名片下方
 *   没有余量，挂到节点输入框下面会被 .n-proc-row 的 overflow:hidden 裁掉，仍挂消息区末位
 *   sticky 贴住下沿。
 * 覆盖：
 *   [1] 样式：尾部容器规则齐备（.agent-body / .assist-pane），消息区吸附只剩节点内会话
 *   [2] 样式：展开态 Badge 正文封顶可滚（不再高过容器把上沿顶出去）
 *   [3] 接线：宿主判定走尾部容器（会话 / 助手）+ 三条渲染路径把报告挂出去
 */
const fs = require("fs");
const path = require("path");

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
const AGENT = read("renderer/app-agent.js");
const DSH_CSS = read("renderer/css/dsh.css");

/* ==================== [1] 尾部容器样式 ==================== */
console.log("\n[1] 会话最底部：报告挂到输入框下面的尾部容器");
const tailFrom = DSH_CSS.indexOf(".agent-body > .tok-badge,\n.assist-pane > .tok-badge {");
const tailSrc =
  tailFrom > 0 ? DSH_CSS.slice(tailFrom, DSH_CSS.indexOf("}", tailFrom) + 1) : "";
ok(tailFrom > 0, "dsh.css 有「.agent-body / .assist-pane > .tok-badge」尾部容器规则组");
ok(/flex: none;/.test(tailSrc), "尾部容器里的 Badge 仍是 flex:none（不抢消息区高度）");
const agentWFrom = DSH_CSS.indexOf(".agent-body > .tok-badge {");
const agentWSrc =
  agentWFrom > 0 ? DSH_CSS.slice(agentWFrom, DSH_CSS.indexOf("}", agentWFrom) + 1) : "";
ok(agentWFrom > 0, "摘到会话面板尾部容器的真样式");
ok(
  /width: calc\(100% - 36px\);/.test(agentWSrc) && /max-width: 784px;/.test(agentWSrc),
  "会话面板：与输入区同宽（输入区 820 上限 − 左右 18px 内边距）",
);
ok(/margin: 0 auto 14px/.test(agentWSrc), "会话面板：与输入区同轴居中，落在最底部");
/* 用 lastIndexOf：前面那条规则组的末行也是 `.assist-pane > .tok-badge {` */
const assistWFrom = DSH_CSS.lastIndexOf(".assist-pane > .tok-badge {");
const assistWSrc =
  assistWFrom > 0 ? DSH_CSS.slice(assistWFrom, DSH_CSS.indexOf("}", assistWFrom) + 1) : "";
ok(assistWFrom > 0, "摘到助手栏尾部容器的真样式");
ok(/margin: 0 10px 10px/.test(assistWSrc), "助手栏：与消息区 / 输入行同边距");

const stickyFrom = DSH_CSS.indexOf(".agent-conv > .tok-badge,");
const stickySrc =
  stickyFrom > 0 ? DSH_CSS.slice(stickyFrom, DSH_CSS.indexOf("}", stickyFrom) + 1) : "";
ok(stickyFrom > 0, "节点内会话的吸附规则组仍在（.agent-conv / .chat-list）");
ok(
  /\.agent-conv > \.tok-badge,/.test(stickySrc) && /\.chat-list > \.tok-badge \{/.test(stickySrc),
  "节点内会话进吸附选择器（节点框没余量，报告仍钉消息区下沿）",
);
ok(/position: sticky;/.test(stickySrc), "position: sticky（贴住滚动视口，不脱离文档流）");
ok(/bottom: 0;/.test(stickySrc), "bottom: 0（恒贴可视区下沿，向上翻历史也不消失）");
ok(/z-index: 6;/.test(stickySrc), "z-index 抬升（压在消息正文之上）");
ok(/margin-bottom: 0;/.test(stickySrc), "末位外边距清零（否则滚动内容从 Badge 底下的缝里露出来）");
ok(
  !/\.agent-list > \.tok-badge/.test(DSH_CSS) && !/\.assist-list > \.tok-badge/.test(DSH_CSS),
  "消息区吸附已从 .agent-list / .assist-list 撤掉（报告不再沉在消息流里）",
);
ok(
  !/\.agent-list \.tok-badge,/.test(DSH_CSS) && !/\.assist-list \.tok-badge \{/.test(DSH_CSS),
  "消息区里的旧边距规则（margin: 10px 8px 4px）一并清掉",
);
ok(
  /\.tok-badge \{[\s\S]{0,200}flex: none/.test(DSH_CSS),
  "Badge 基础样式仍是 flex:none（尾部容器里不改变它在列里的尺寸口径）",
);
ok(
  /badge\.style\.margin = "6px 6px 0";/.test(APP) &&
    /badge\.style\.margin = "6px 6px 0";/.test(AGENT),
  "节点内会话的行内边距同步清底（行内样式优先级高于 CSS，留缝同样会漏内容）",
);

/* ==================== [2] 展开态封顶 ==================== */
console.log("\n[2] 展开态封顶：报告不会高过容器把上沿顶出去");
const bodyFrom = DSH_CSS.indexOf(".tok-badge-body {");
const bodySrc =
  bodyFrom > 0 ? DSH_CSS.slice(bodyFrom, DSH_CSS.indexOf("}", bodyFrom) + 1) : "";
ok(bodyFrom > 0, "摘到 .tok-badge-body 真样式");
ok(/overflow: auto;/.test(bodySrc), "正文区纵横向都能滚（原 overflow-x 不够用）");
ok(/max-height: min\(42vh, 360px\)/.test(bodySrc), "正文区封顶（视口与绝对值取小）");

/* ==================== [3] 宿主判定 + 渲染路径 ==================== */
console.log("\n[3] 接线：宿主判定走「输入框下面」的尾部容器");
ok(
  /function tokAgentTailHost\(\)/.test(AGENT) &&
    /closest\("\.agent-composer"\)/.test(AGENT) &&
    /return document\.querySelector\("\.agent-body"\);/.test(AGENT),
  "会话面板尾部容器 = .agent-composer 的父级（拿不到退回 .agent-body）",
);
ok(
  /sid === "assist"[\s\S]{0,140}assistPane[\s\S]{0,140}assistList/.test(AGENT),
  "助手栏宿主 = #assistPane（退化 #assistList）",
);
ok(
  /S\.agentActiveId === sid[\s\S]{0,160}tokAgentTailHost\(\)/.test(AGENT),
  "当前会话宿主 = 尾部容器（不再是 #agentList 消息区）",
);
ok(
  /const conv = document\.querySelector\([\s\S]{0,140}\.agent-conv[\s\S]{0,80}if \(conv\) return conv;/.test(
    AGENT,
  ),
  "节点内会话宿主仍是 .agent-conv（节点框没余量，口径单独保留）",
);
ok(
  /existing\.parentElement/.test(AGENT) && /sid === "assist"[\s\S]{0,900}\.chat-list/.test(AGENT),
  "宿主判定顺序未动（先认已有父级 → 助手栏 → 当前会话 → 节点会话 → 绑定会话）",
);
ok(
  /function tokBadgeTailMount\(owner, list\)/.test(AGENT) &&
    /list\.querySelectorAll\("\.tok-badge"\)/.test(AGENT) &&
    /host\.appendChild\(badge\);/.test(AGENT),
  "tokBadgeTailMount：清掉消息区残留的旧 Badge，再把新的挂到尾部容器末尾",
);
ok(
  /const kids = host\.children \|\| \[\];[\s\S]{0,240}classList\.contains\("tok-badge"\)[\s\S]{0,60}\.remove\(\);/.test(
    AGENT,
  ),
  "尾部容器只留当前归属的一枚（换会话 / 换归属先清干净）",
);
ok(
  /if \(!found\.length\) \{[\s\S]{0,180}tokBadgeTailMount\(owner\);/.test(AGENT),
  "局部刷新（tokBadgeTouch）：无 Badge 时走同一口补挂",
);
ok(
  /const list = \$\("#agentList"\);/.test(ASSIST) &&
    /tokBadgeTailMount\(st, list\);/.test(ASSIST),
  "会话（#agentList）：渲染收尾挂到输入框下面的尾部容器",
);
ok(
  /const list = \$\("#assistList"\);/.test(ASSIST) &&
    /tokBadgeTailMount\(assistTokOwner\(\), list\);/.test(ASSIST),
  "助手栏（#assistList）：渲染收尾挂到输入行下面的尾部容器",
);
ok(
  !/const badge = tokBadgeEl\(st\);[\s\S]{0,140}list\.appendChild\(badge\);/.test(ASSIST) &&
    !/const badge = tokBadgeEl\(assistTokOwner\(\)\);[\s\S]{0,140}list\.appendChild\(badge\);/.test(
      ASSIST,
    ),
  "两条面板路径都不再把报告塞进消息区末尾",
);
ok(
  /const badge = owner && tokBadgeEl\(owner\);[\s\S]{0,220}conv\.appendChild\(badge\);/.test(APP),
  "节点内会话（.agent-conv）：渲染收尾仍 appendChild 到 conv 末尾（节点框没余量）",
);

console.log(
  "\n" +
    (fails ? " " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-token-badge-bottom)",
);
process.exit(fails ? 1 : 0);
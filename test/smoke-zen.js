/* 临时冒烟测试：验证 zen.js 纯函数（契约/映射解析、计划模板、剪枝锚点） */
"use strict";
global.window = { addEventListener: () => {} };
require("../renderer/zen.js");
const Z = window.ZenMode._internals;

let fails = 0;
const ok = (cond, msg) => {
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

/* 1. 契约解析：标准 JSON */
const c1 = Z.parseZenContract(
  '{"banner":"你想做什么？","display":"目标","options":[{"id":"o1","label":"开发软件","hint":"工具/应用"},{"id":"o2","label":"写文章","hint":""},{"id":"o3","label":"做视频"},{"id":"o4","label":"做游戏"},{"id":"o5","label":"其他"},{"id":"o6","label":"还没想好"},{"id":"o7","label":"第7个被裁掉"}],"multiSelect":false,"nextSkillHint":"zen-bootstrap","planReady":false,"planMarkdown":null}',
);
ok(c1 !== null, "parseZenContract 基本解析");
ok(c1.options.length === 6, "选项硬裁剪 ≤6（实际 " + c1.options.length + "）");
ok(c1.banner === "你想做什么？", "banner 字段");
ok(c1.display === "目标", "display 字段");

/* 2. 契约解析：代码块包裹 + 前后杂文 */
const c2 = Z.parseZenContract(
  '好的，以下是问题：\n```json\n{"banner":"b","display":"d","options":[{"id":"a","label":"x"}],"multiSelect":true,"planReady":true,"planMarkdown":null}\n```\n完毕',
);
ok(c2 !== null && c2.multiSelect && c2.planReady, "代码块+杂文容错");
ok(c2.planMarkdown === null, "planMarkdown null 保持");

/* 3. 契约解析：垃圾输入 */
ok(Z.parseZenContract("随便聊聊，没有 JSON") === null, "垃圾输入返回 null");
ok(Z.parseZenContract("") === null, "空输入返回 null");

/* 4. 映射表解析 */
const m1 = Z.parseZenMap('{"map":[{"taskNodeId":"n_abc","planAnchor":"zen:node:z1","title":"写脚本"}]}');
ok(m1 && m1.n_abc && m1.n_abc.planAnchor === "zen:node:z1", "parseZenMap 解析");
ok(Z.parseZenMap("no json") === null, "parseZenMap 垃圾输入");

/* 5. 本地计划模板（依赖 S/zenNode 内部状态 —— 仅验证不抛异常且含锚点） */
/* Z 内部 doc 为空时 hubNode() 返回 null → localPlanTemplate 应给出骨架 */
let tpl = "";
try {
  tpl = Z.localPlanTemplate();
  ok(true, "localPlanTemplate 可调用");
  ok(tpl.includes("zen:node:none"), "模板含兜底锚点");
} catch (e) {
  ok(false, "localPlanTemplate 抛异常: " + e.message);
}

/* 6. 锚点替换 */
const md = "- [ ] A <!-- zen:node:z1 -->\n- [ ] B <!-- zen:node:z2 -->\n";
const stripped = Z.stripZenPlanAnchors(md, new Set(["z1"]));
ok(stripped.includes("zen:node:pruned"), "剪枝锚点替换");
ok(stripped.includes("zen:node:z2"), "未剪枝锚点保留");

console.log(fails ? "\nSMOKE FAILED (" + fails + ")" : "\nSMOKE OK");
process.exit(fails ? 1 : 0);

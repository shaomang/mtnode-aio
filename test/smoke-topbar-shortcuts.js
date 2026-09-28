/* test/smoke-topbar-shortcuts.js — 顶栏入口全局快捷键回归（只读断言）
 * ============================================================================
 * 运行：node test/smoke-topbar-shortcuts.js
 *
 * 需求：
 *   · 画布 / 会话 / 专家团 = 1 / 2 / 3；居中 = Space；隐藏线 = D；
 *     插件 / 工具库 / 素材库 = J / K / L。
 *   · 任何文本输入或焦点在可编辑区时不得触发；全屏浮层开着时不得穿透。
 *   · 鼠标 hover 按钮时，提示里要同时给出快捷键。
 *
 * 钉住的实现口径：
 *   · 键位单一真源 = index.html 入口按钮上的 data-shortcut；
 *   · renderer/app-keys.js 只做「按键 → 点按钮」，动作走按钮自己的 onclick；
 *   · i18n.js 的 applyDom 把 data-shortcut 并进 [data-i18n-title] 生成的 hover 提示。
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const HTML = read("renderer/index.html");
const KEYS = read("renderer/app-keys.js");
const I18N = read("renderer/i18n.js");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

/* 取某入口按钮的开标签（到 > 为止） */
const openTagOf = (id) => {
  const at = HTML.indexOf('id="' + id + '"');
  if (at < 0) return "";
  const start = HTML.lastIndexOf("<button", at);
  const end = HTML.indexOf(">", at);
  return start >= 0 && end > start ? HTML.slice(start, end + 1) : "";
};

console.log("[1] 八个入口各自的 data-shortcut 键位");
{
  const want = {
    btnToolWf: "1",
    btnToolAgent: "2",
    btnTeam: "3",
    btnFit: "Space",
    btnHideWires: "D",
    btnPlugins: "J",
    btnTools: "K",
    btnAssets: "L",
  };
  Object.keys(want).forEach((id) => {
    const tag = openTagOf(id);
    ok(
      tag.indexOf('data-shortcut="' + want[id] + '"') >= 0,
      "#" + id + " 的 data-shortcut = " + want[id],
    );
    ok(
      tag.indexOf("data-i18n-title=") >= 0,
      "#" + id + " 保留 data-i18n-title（hover 提示的文案真源）",
    );
  });
}

console.log("\n[2] app-keys.js：接线 + 输入 / 浮层闸门");
{
  ok(
    fs.existsSync(path.join(ROOT, "renderer", "app-keys.js")),
    "新模块 renderer/app-keys.js 存在",
  );
  ok(
    /<script src="app-keys\.js"><\/script>/.test(HTML),
    "index.html 已加载 app-keys.js",
  );
  const bootAt = HTML.indexOf('<script src="app-boot.js"></script>');
  const keysAt = HTML.indexOf('<script src="app-keys.js"></script>');
  ok(bootAt >= 0 && keysAt > bootAt, "app-keys.js 排在 app-boot.js 之后（按钮 onclick 已接线）");
  ok(
    /querySelectorAll\("\.topbar \[data-shortcut\]"\)/.test(KEYS),
    "键位从 data-shortcut 读取（不在 JS 里另抄一份键位表）",
  );
  ok(/\.click\(\)/.test(KEYS), "触发方式 = 原样点按钮自己的 onclick");
  ok(
    /isContentEditable/.test(KEYS) && /tag === "textarea"/.test(KEYS),
    "输入框 / 文本域 / 富文本里不抢键",
  );
  ok(
    /role="textbox"/.test(KEYS),
    "role=textbox 的富文本宿主也不抢键",
  );
  ok(
    /getElementById\("overlay"\)/.test(KEYS) && /\.mt-dialog\.on/.test(KEYS),
    "全屏浮层（#overlay / .mt-dialog.on）开着时不穿透",
  );
  ok(
    /ev\.ctrlKey \|\| ev\.metaKey \|\| ev\.altKey \|\| ev\.shiftKey/.test(KEYS),
    "组合键一律不占（快捷键都是单键）",
  );
  ok(
    /key === " " && focusOnActivatable\(\)/.test(KEYS),
    "Space 让位给当前有焦点的可点控件（避免与原生按钮激活叠加）",
  );
  ok(
    /btn\.id === "btnFit" \|\| btn\.id === "btnHideWires"/.test(KEYS) &&
      /view-workflow/.test(KEYS),
    "居中 / 隐藏线只在画布视图响应",
  );
  ok(/ev\.repeat/.test(KEYS) && /isComposing/.test(KEYS), "长按自动重复与输入法组合态忽略");
}

console.log("\n[3] hover 提示同时显示快捷键");
{
  ok(
    /getAttribute\("data-shortcut"\)/.test(I18N),
    "i18n.applyDom 读取 data-shortcut",
  );
  ok(
    /t\("快捷键 \{k\}", \{ k: sc \}\)/.test(I18N),
    "把快捷键并进 [data-i18n-title] 生成的提示文案（切语言重算）",
  );
  ok(/"快捷键 \{k\}": "shortcut \{k\}"/.test(I18N), "有英文译文");
  /* 三颗视图按钮也走即时 data-tip 提示（不只是原生 title），快捷键才一眼可见 */
  ok(
    /el\.classList\.contains\("btn-ico"\) \|\| el\.classList\.contains\("tb-view"\)/.test(I18N),
    "视图按钮同样进 data-tip 即时提示分支",
  );
  const CSS = read("renderer/css/layout.css");
  ok(
    /\.topbar \.tb-view\[data-tip\]:hover::after/.test(CSS) &&
      /\.topbar \.tb-view\[data-tip\]::after/.test(CSS),
    "layout.css 为 .tb-view[data-tip] 补了提示气泡规则",
  );
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-topbar-shortcuts)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-topbar-shortcuts)\n",
);
process.exit(fails ? 1 : 0);

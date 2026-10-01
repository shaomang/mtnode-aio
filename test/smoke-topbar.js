/* test/smoke-topbar.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-topbar.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-topbar-buttons.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-topbar-buttons.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  "use strict";

  const fs = require("fs");
  const path = require("path");

  const ROOT = path.join(__dirname, "..");
  const HTML = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  const CSS = fs.readFileSync(path.join(ROOT, "renderer", "css", "layout.css"), "utf8");
  const I18N = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");

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

  /* 取某个按钮的开标签与内文（到 </button> 为止） */
  const btnOf = (id) => {
    const at = HTML.indexOf('id="' + id + '"');
    if (at < 0) return "";
    const start = HTML.lastIndexOf("<button", at);
    const end = HTML.indexOf("</button>", at);
    return start >= 0 && end > start ? HTML.slice(start, end + 9) : "";
  };
  /* 取一段 CSS 规则体（直到下一个 "}"） */
  const ruleOf = (selector) => {
    const at = CSS.indexOf(selector);
    if (at < 0) return "";
    const end = CSS.indexOf("}", at);
    return end > at ? CSS.slice(at, end + 1) : "";
  };

  console.log("[1] 右上角 文档 / 讨论 / 审批：尺寸统一到第二排图标按钮（36×32）");
  {
    const docs = btnOf("btnDocs");
    const forum = btnOf("btnForum");
    const appr = btnOf("btnApprovals");
    ok(
      !!docs && !!forum && !!appr &&
        docs.indexOf('class="btn-stack-ico"') >= 0 &&
        forum.indexOf('class="btn-stack-ico"') >= 0 &&
        appr.indexOf('class="btn-stack-ico"') >= 0,
      "三个按钮都带 .btn-stack-ico 线性图标",
    );
    const rule = ruleOf(".topbar .btn-docs,");
    ok(
      /\.topbar\s+\.btn-docs\s*,\s*\.topbar\s+\.btn-forum\s*,\s*\.topbar\s+\.btn-approvals\s*,\s*\.topbar\s+\.btn-apps\s*\{/.test(rule),
      "layout.css 有一条同时命中这四个按钮的尺寸规则",
    );
    ok(/min-width:\s*36px/.test(rule), "尺寸规则与第二排 .btn-ico 同口径：min-width:36px");
    ok(/padding:\s*2px\s+4px\s+1px/.test(rule), "尺寸规则与第二排 .btn-ico 同口径：padding:2px 4px 1px");
    ok(
      /\.topbar\s+\.btn-docs\s+\.btn-stack-ico[\s\S]{0,160}?width:\s*14px[\s\S]{0,40}?height:\s*14px/.test(CSS),
      "三个按钮的图标 14px（与第二排 .btn-ico svg 一致）",
    );
    /* 第二排的参照口径必须还在，否则「统一」的后半句失去意义 */
    const icoRule = ruleOf(".topbar .btn-ico {");
    ok(
      /min-width:\s*36px/.test(icoRule) && /min-height:\s*32px/.test(icoRule),
      "第二排 .btn-ico 仍是 36×32 的参照口径（min-width:36px / min-height:32px）",
    );
  }

  console.log("\n[2] 画布 / 会话 / 团队：各加图标，且不改按钮大小");
  {
    const views = { btnToolWf: "画布", btnToolAgent: "会话", btnTeam: "专家团" };
    Object.keys(views).forEach((id) => {
      const html = btnOf(id);
      ok(html.indexOf('class="tb-view-ico"') >= 0, "#" + id + "（" + views[id] + "）带 .tb-view-ico 图标");
      ok(
        html.indexOf('<span class="tb-view-txt" data-i18n="' + views[id] + '">') >= 0,
        "#" + id + " 文案留在 span.tb-view-txt[data-i18n] 上",
      );
      ok(
        !/<button[^>]*\bdata-i18n="/.test(html),
        "#" + id + " 的 button 自身不挂 data-i18n（否则切语言会抹掉图标）",
      );
    });
    ok(
      /el\.textContent\s*=\s*t\(key\)/.test(I18N),
      "i18n.js 的 [data-i18n] 仍走 textContent（本坑的前提成立，断言才有意义）",
    );
    const rule = ruleOf(".topbar .tb-view {");
    ok(/height:\s*32px/.test(rule), "画布 / 会话 / 团队 外框高度仍是 32px（未改大小）");
    ok(/padding:\s*0\s+10px/.test(rule), "画布 / 会话 / 团队 内边距仍是 0 10px（宽度不变）");
    ok(/flex-direction:\s*column/.test(rule), "改为图标在上、文字在下（与顶栏其它入口同风格）");
    ok(
      /\.topbar\s+\.tb-view\s+svg\s*\{[\s\S]{0,120}?width:\s*14px[\s\S]{0,40}?height:\s*14px/.test(CSS),
      "视图按钮图标 14px（窄于两字标题 → 不撑宽按钮）",
    );
    ok(/font-size:\s*11px/.test(rule), "画布 / 会话 / 团队 字号收到 11px（略减小，未动按钮大小）");
    ok(!/font-size:\s*12px/.test(rule), "不再残留 12px 的旧字号");
    const txtRule = ruleOf(".topbar .tb-view .tb-view-txt {");
    ok(
      /padding:\s*0\s+1px/.test(txtRule),
      "文案左右各补 1px 内边距，抵消 11px 少掉的 2px → 外框宽度不变",
    );
  }

  console.log("\n[3] 词条：三个视图按钮文案都有英文译文");
  {
    ["画布", "会话", "专家团"].forEach((k) => {
      ok(new RegExp('"' + k + '":\\s*"[A-Za-z]').test(I18N), "「" + k + "」有英文译文");
    });
  }

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-topbar-buttons)\n"
      : "\n✓ 全部 " + checks + " 项通过  (smoke-topbar-buttons)\n",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-topbar-buttons.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-topbar-buttons.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-topbar-shortcuts.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-topbar-shortcuts.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-topbar-shortcuts.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-topbar-shortcuts.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

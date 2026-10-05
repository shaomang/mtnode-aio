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

  console.log("[1] 五个入口各自的 data-shortcut 键位");
  {
    const want = {
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
    /* 已移除：切视图的 1 画布 / 2 会话 / 3 专家团 —— 打字或盲按会把整个视图切走 */
    ["btnToolWf", "btnToolAgent", "btnTeam"].forEach((id) => {
      const tag = openTagOf(id);
      ok(tag.length > 0, "#" + id + " 按钮仍在（只是不再占单键）");
      ok(
        tag.indexOf("data-shortcut") < 0,
        "#" + id + " 不再挂 data-shortcut（1 / 2 / 3 切视图已移除）",
      );
      ok(
        tag.indexOf("data-i18n-title=") >= 0,
        "#" + id + " 仍保留 data-i18n-title（hover 提示照旧，不含快捷键）",
      );
    });
    ok(
      !/data-shortcut="[123]"/.test(HTML),
      "index.html 里没有任何数字键位（1 / 2 / 3）残留",
    );
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
    /* 三颗视图按钮也走即时 data-tip 提示（不只是原生 title）：1 / 2 / 3 快捷键已移除，
       提示本身仍然即时可见，只是文案里不再有「 · 快捷键 X」 */
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

/* ==================== 顶栏「数据不落应用文件夹」红色警示 ==================== */
(function () {
  const fs = require("fs");
  const path = require("path");
  const ROOT = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  let fails = 0,
    checks = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok  " + msg);
    else {
      fails++;
      MERGED_FAILED = true;
      console.log("FAIL  " + msg);
    }
  };
  try {
    const HTML = read("renderer/index.html");
    const CSS = read("renderer/css/layout.css");
    const BASE = read("renderer/css/base.css");
    const BOOT = read("renderer/app-boot.js");
    const I18N = read("renderer/i18n.js");
    const MAIN = read("main.js");
    const PRELOAD = read("preload.js");
    const SET = read("renderer/app-settings.js");
    const ASSETS = read("renderer/app-assets.js");

    const at = HTML.indexOf('id="logoWarn"');
    const tagStart = at >= 0 ? HTML.lastIndexOf("<", at) : -1;
    const tagEnd = at >= 0 ? HTML.indexOf(">", at) : -1;
    const tag = at >= 0 ? HTML.slice(tagStart, tagEnd + 1) : "";
    const boxEnd = at >= 0 ? HTML.indexOf("</button>", at) : -1;
    const box = at >= 0 && boxEnd > at ? HTML.slice(at, boxEnd) : "";
    const logoEnd = HTML.indexOf("</div>", HTML.indexOf('<div class="logo">'));

    console.log(
      "\n[4] 顶栏警示：红字 + outline + 警告图标（默认 hidden，命中才显）",
    );
    ok(
      tagStart > logoEnd && at > logoEnd && at < HTML.indexOf('<div class="tb-end">'),
      "警示块紧跟 .logo 之后、在右端按钮群 .tb-end 之前（第一行中段）",
    );
    ok(
      /\bhidden\b/.test(tag) && /type="button"/.test(tag) && /class="logo-warn"/.test(tag),
      "是默认 hidden 的 button.logo-warn（静态骨架，命中才由 JS 摘掉 hidden）",
    );
    ok(/class="logo-warn-ico"/.test(box) && /viewBox="0 0 16 16"/.test(box), "带 16px 线性警告图标");
    ok(
      /class="logo-warn-txt" id="logoWarnTxt"/.test(box),
      "正文容器 #logoWarnTxt 就位（文案由 JS 现算，故不挂 data-i18n）",
    );
    ok(
      /logo-warn-ico[\s\S]{0,400}stroke="currentColor"/.test(box) &&
        /M8 2.6L14\.4 13\.4H1\.6L8 2\.6z/.test(box),
      "图标是内联描边三角（与顶栏其它线性图标同风格，无位图）",
    );

    const rule = (sel) => {
      const i = CSS.indexOf(sel);
      if (i < 0) return "";
      const e = CSS.indexOf("}", i);
      return e > i ? CSS.slice(i, e + 1) : "";
    };
    const R = rule(".logo-warn {");
    ok(
      !!R && /border:\s*1px solid var\(--red\)/.test(R) && /color:\s*var\(--red\)/.test(R),
      "outline + 红字：border 1px solid var(--red) 且 color / 图标取 var(--red)",
    );
    ok(/margin:\s*0 auto/.test(R), "两侧自动边距 = 居中于 Logo 与右端按钮之间的空档");
    ok(
      /display:\s*flex/.test(R) && /flex:\s*0 1 auto/.test(R) && /min-width:\s*0/.test(R),
      "可压缩的 flex 项（窄窗口先被压，不挤走右侧按钮）",
    );
    ok(
      /background:\s*color-mix\(in srgb, var\(--red\) 12%/.test(R),
      "红底淡填充（color-mix，亮 / 暗主题共用同一个 --red 变量）",
    );
    ok(
      /white-space:\s*nowrap/.test(rule(".logo-warn-txt {")) &&
        /text-overflow:\s*ellipsis/.test(rule(".logo-warn-txt {")) &&
        /overflow:\s*hidden/.test(rule(".logo-warn-txt {")),
      "单行不换行 + 省略号截断",
    );
    const TIP = rule(".topbar .logo-warn[data-tip]::after {");
    ok(
      /content:\s*attr\(data-tip\)/.test(TIP) &&
        /white-space:\s*pre-line/.test(TIP) &&
        /top:\s*calc\(100% \+ 6px\)/.test(TIP),
      "悬停完整说明走 data-tip 即时气泡（挂在元素下方、允许折行显示明细）",
    );
    ok(
      /\.topbar \.logo-warn\[data-tip\]:hover::after/.test(CSS),
      "气泡有 hover / focus-visible 显形规则",
    );
    ok(/--red:\s*#ff5f56/.test(BASE) && /--red:\s*#cf2a1e/.test(BASE), "暗 / 亮主题都有 --red");
    /* 回归（必须钉死在 .logo-warn 自身上）：本文件**没有**全局 [hidden] 兜底，基规则的
       display:flex 会盖掉浏览器默认的 [hidden]{display:none} —— 零命中时顶栏中段就会常驻
       一只空红框 + 警告三角。所以 .topbar .logo-warn[hidden] 必须自己压回 display:none。 */
    const HID = rule(".topbar .logo-warn[hidden] {");
    ok(
      /display:\s*none\s*!important/.test(HID),
      "没命中时完全不显示：.topbar .logo-warn[hidden]{display:none!important} 压住基规则的 display:flex",
    );
    ok(
      /display:\s*flex/.test(R) && !!HID && CSS.indexOf(".topbar .logo-warn[hidden] {") > CSS.indexOf(".logo-warn {"),
      "显隐两态齐备：基规则 flex（命中才显）· [hidden] none（零命中不占位、无空框残留）",
    );

    console.log("\n[5] 判定口径：主进程只读 IPC + 渲染层只在命中时显示");
    ok(
      /ipcMain\.handle\("app:dataAudit"/.test(MAIN) &&
        /appDirDataCandidates\(\)/.test(MAIN.slice(MAIN.indexOf('ipcMain.handle("app:dataAudit"'), MAIN.indexOf('ipcMain.handle("app:dataAudit"') + 700)) &&
        /isInsideAppDir/.test(MAIN.slice(MAIN.indexOf('ipcMain.handle("app:dataAudit"'), MAIN.indexOf('ipcMain.handle("app:dataAudit"') + 700)),
      "新增只读 IPC app:dataAudit，复用同一份候选清单 + isInsideAppDir",
    );
    const HANDLER = MAIN.slice(
      MAIN.indexOf('ipcMain.handle("app:dataAudit"'),
      MAIN.indexOf('ipcMain.handle("app:dataAudit"') + 700,
    );
    ok(
      !/dialog\.showMessageBox|appendFileSync/.test(HANDLER),
      "这个只读口不弹窗、不写日志（报警与 error.log 仍只由启动体检负责）",
    );
    ok(/appDataAudit:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:dataAudit'\)/.test(PRELOAD), "preload 白名单桥暴露 appDataAudit");
    ok(
      /async function refreshAppDirAudit\(\)/.test(BOOT) &&
        /function paintAppDirWarn\(\)/.test(BOOT) &&
        /async function checkAppDirWarn\(\)/.test(BOOT) &&
        /window\.checkAppDirWarn = checkAppDirWarn/.test(BOOT),
      "app-boot.js 有体检 / 绘制 / 对外重查三个口",
    );
    const PAINT = BOOT.slice(
      BOOT.indexOf("function paintAppDirWarn()"),
      BOOT.indexOf("function openDataDirSettings()"),
    );
    ok(
      /if \(!hits\.length\)[\s\S]{0,160}el\.hidden = true/.test(PAINT) &&
        /el\.hidden = false/.test(PAINT),
      "没命中（含拿不到结果）就 hidden，命中才显示 —— 绝不误报",
    );
    ok(
      /appDirHits = \[\];/.test(BOOT.slice(BOOT.indexOf("async function refreshAppDirAudit()"), BOOT.indexOf("function paintAppDirWarn()"))),
      "体检失败 / 桥未就绪一律回落空命中（静默，不弹错）",
    );
    ok(
      /bindAppDirWarnClick\(\);\s*\n\s*checkAppDirWarn\(\);/.test(BOOT) && /paintAppDirWarn\(\)/.test(BOOT),
      "启动时体检一次；切语言（applyLocale）时按新语言重画",
    );
    ok(
      /window\.checkAppDirWarn/.test(SET) && /openSettings\(\{ section: "data" \}\)/.test(BOOT),
      "点警示 = 打开设置并滚到「配置数据目录」；改数据目录成功后重查",
    );
    ok(
      (SET.match(/window\.checkAppDirWarn/g) || []).length >= 2 &&
        /id = "setDataRootSec"/.test(SET) &&
        /settingsFocusSection === "data"/.test(SET),
      "「更改目录…」与「恢复默认」两条路径都重查，落点小节有 id",
    );
    ok(
      (ASSETS.match(/window\.checkAppDirWarn/g) || []).length >= 2,
      "素材库根目录变更（首次指定 / 更换）后也重查",
    );

    console.log("\n[6] 中英词条齐备");
    ok(
      /"请勿将文件保存在应用文件夹内，升级或卸载会丢失":/.test(I18N) &&
        /"Do not save files inside the app folder/.test(I18N),
      "主文案有英文译文",
    );
    ok(
      (I18N.match(/数据落(在)?应用文件夹|当前检测到这些数据落在应用文件夹内/g) || []).length >= 1 &&
        /"These items were detected inside the app folder:"/.test(I18N),
      "悬停明细引导句有英文译文",
    );
    ok(
      /"点击此处打开设置 · 配置数据目录":/.test(I18N) &&
        /"Click to open Settings · Config data directory"/.test(I18N),
      "点击提示有英文译文",
    );
    ok(/"等 \{n\} 处":/.test(I18N), "命中超过 5 条时的「等 N 处」也有词条");

    console.log(
      fails
        ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-topbar-appdir-warn)\n"
        : "\n✓ 全部 " + checks + " 项通过  (smoke-topbar-appdir-warn)\n",
    );
    if (fails)
      console.log(
        "  ── 已并入块 appdir-warn：" + fails + " / " + checks + " 项失败",
      );
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] appdir-warn：" + (e && e.stack ? e.stack : e));
  }
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

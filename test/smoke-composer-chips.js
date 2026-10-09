"use strict";
/* ============================================================================
 * test/smoke-composer-chips.js — 会话输入区那排 chips 的布局/交互契约（真实渲染引擎量出来）
 *
 *   node test/smoke-composer-chips.js              断言模式（绿 = 退出码 0）
 *   node test/smoke-composer-chips.js --report     诊断模式：打印每格实测宽度
 *
 * 为什么要有它（本轮用户报障）：
 *   「模式」里的 toggle 点不中（hit box 太小）、toggle 开着时摘要被写进「模式」键面把右边几枚
 *   挤到出界。这两条靠读 CSS 静态推算是量不出来的 —— 键面宽度、flex 收缩、容器裁剪都发生在
 *   Blink 里。所以这里用仓库自带 Electron（show:false + offscreen，布局照算）把真实 DOM
 *   （renderer/index.html 的 <body>）与真实样式（renderer/style.css 的 @import 分片全量内联）
 *   摆起来，逐格量：
 *     · .agent-composer-chips 的内容宽必须落在自己的 clientWidth 之内（scrollWidth 不超）；
 *     · 每一枚「硬 chip」（技能 / 工具 / 模式 / 浏览器活动 / 执行计划）都必须完整落在排内、
 *       也必须完整落在 .agent-composer 之内 —— 这就是「不会出界」的可复核口径；
 *     · 这一排恒定一行（行高 < 2 行）；
 *     · 「模式」键面文字只有「模式」两字，摘要节点恒 hidden 且为空。
 *   交互侧断言打在产品代码上（不抄副本）：按名字从 renderer/app-assist.js 抠出
 *   agentModeToggleBtn / paintAgentModeToggleBtn 原文注进页面执行 —— 改名或改写法即变红。
 *     · 开关按钮 hit box ≥ 44×26（改前那枚字符按钮约 20px 高，用户点不中）；
 *     · 键面里没有任何文字节点（toggle 态不写内容）；
 *     · 打开开关后 chip 与这一排的实测宽度**不得变宽**（旧实现写摘要 → 变宽 → 挤兑）。
 *
 * 探针页不跑任何应用逻辑（丢掉 <script>、无 window.api），只量布局与那两个构件。
 * ========================================================================== */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const rel = (...p) => path.join(ROOT, ...p);

/* ---------- 纯 Node 时：用仓库自带的 Electron 重启自己（保持 `node test/...` 的跑法） ---------- */
if (!process.versions.electron) {
  const { spawn } = require("child_process");
  const bin = require("electron");
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(String(bin), [__filename].concat(process.argv.slice(2)), {
    stdio: "inherit",
    env,
  });
  child.on("exit", (code, sig) => process.exit(sig ? 1 : code == null ? 1 : code));
  child.on("error", (e) => {
    console.error("启动 Electron 失败：" + (e && e.message));
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error("[smoke-composer-chips] 失败：", (e && e.stack) || e);
    try {
      require("electron").app.exit(1);
    } catch (_) {}
  });
}

/* ==================== 从 renderer/app-assist.js 抠出「真正在跑」的构件 ====================
 * 断言必须打在产品代码上：按函数名把原文抠出来，包成 window.__modeImpl 注进页面执行。
 * 抠不到（改名 / 删了 / 换写法）→ 直接抛错让 smoke 变红，逼着两边同步。 */
const IMPL_FNS = [
  "agentModeEntryOf",
  "agentModeEntries",
  "agentModeEntryByKey",
  "agentAutoOnNow",
  "agentModeToggleBtn",
  "paintAgentModeToggleBtn",
];

function grabFn(src, name) {
  const re = new RegExp("^function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("renderer/app-assist.js 里找不到函数 " + name + "（改名了？断言要跟着改）");
  /* 从形参表末尾的第一个 { 起按大括号配对（产品函数体里有嵌套块，不能认「单独一行 }」） */
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) throw new Error("函数 " + name + " 找不到函数体起始 {");
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("函数 " + name + " 的收尾 } 没找到（括号不配对？）");
}

function implInjection() {
  const src = fs.readFileSync(rel("renderer", "app-assist.js"), "utf8");
  let code = "";
  for (const n of IMPL_FNS) code += grabFn(src, n) + "\n";
  code +=
    "return { agentModeEntryOf: agentModeEntryOf, agentModeToggleBtn: agentModeToggleBtn, " +
    "paintAgentModeToggleBtn: paintAgentModeToggleBtn };";
  try {
    new Function(
      "window",
      "document",
      "I18n",
      "agentSessionState",
      "persistAgentSession",
      "agentTouchSession",
      "renderAgentComposer",
      "updateRunQueuePanel",
      code,
    );
  } catch (e) {
    throw new Error("从 app-assist.js 抠出的构件编译不过（切割位置不对？）：" + (e && e.message));
  }
  return (
    "window.__modeImpl=(function(){\n" +
    "  function agentSessionState(){ return window.__probeSession; }\n" +
    /* 模式开关的落盘语义（本模块本轮）：agentTouchSession = 盖时间戳 + 落盘，
       quiet = 只把排队的改动推下去、不盖时间戳 —— 本测试只关心「开关真的开了」，
       两个入口都按 no-op 桩注入（缺一个页面里就 ReferenceError）。 */
    "  function persistAgentSession(){} function agentTouchSession(){}\n" +
    "  function agentFlushSessionSaveQuiet(){}\n" +
    "  function renderAgentComposer(){}\n" +
    "  function updateRunQueuePanel(){}\n" +
    code +
    "\n})();\n!!window.__modeImpl;"
  );
}

/* ============================ 页内探针（真实 Blink 里执行） ============================ */
const PROBE_SRC = String.raw`
window.__probe = (function () {
  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function R(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), hidden: !!el.hidden };
  }
  function textOf(el) { return el ? String(el.textContent || "").trim() : ""; }
  /* 元素里有没有「直接文字节点」（不看后代）—— 判「键面里写没写内容」 */
  function ownText(el) {
    if (!el) return "";
    var s = "";
    for (var i = 0; i < el.childNodes.length; i++)
      if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
    return s.trim();
  }

  /* 探针会话态：agentModeEntryOf 读的就是这几项（真源在 app-assist.js / app-longrun.js） */
  window.__probeSession = { id: "sid-probe", pure: false };
  /* 自动续跑的唯一真源是 app-longrun.js 的 LongRun.autoOn（缺省开） */
  window.LongRun = { on: true, autoOn: function () { return !!this.on; }, toggleAuto: function () { this.on = !this.on; } };
  window.I18n = { t: function (s) { return s == null ? "" : String(s); } };

  /* 场景：agent 视图 + 真实工作区/模型文本（这两枚是「软 chip」，宽度随内容变） */
  function stage(cfg) {
    document.body.classList.add("view-agent");
    document.body.classList.remove("view-workflow");
    var pane = document.getElementById("agentPane");
    pane.style.display = "";
    pane.style.setProperty("--agent-side-w", (cfg.sideW || 280) + "px");
    var wf = document.getElementById("wfWrap");
    if (wf) wf.style.display = "none";
    var layout = document.getElementById("layout");
    if (layout) layout.classList.remove("assist-open");
    var list = document.getElementById("agentList");
    if (list) list.innerHTML = "";
    var hist = document.getElementById("agentHistory");
    if (hist) hist.hidden = true;

    var ws = document.getElementById("agentWsTriggerVal");
    if (ws) ws.textContent = cfg.ws != null ? cfg.ws : "pipeline-console";
    var mv = document.getElementById("agentModelTriggerVal");
    if (mv) mv.textContent = cfg.model != null ? cfg.model : "标准模式 · deepseek-flash";
    /* 运行期真会浮现的「▶ 执行计划」（硬 chip，参与宽度预算） */
    var rp = document.getElementById("agentRunPlanBtn");
    if (rp) rp.hidden = !cfg.runPlan;
    /* 「兼容留位」的摘要节点：故意写进内容，验证它不会显示、也不会吃宽度 */
    var val = document.getElementById("agentModeTriggerVal");
    if (val) {
      val.textContent = cfg.forceSummary == null ? "" : cfg.forceSummary;
      if (cfg.forceSummary == null) val.hidden = true;
    }
    paintChip();
    void document.body.offsetHeight;
  }

  /* 真源：app-assist.js 的 paintAgentModeChip（这里只复刻它的调用序，构件是真的） */
  function paintChip() {
    var impl = window.__modeImpl;
    var chip = document.getElementById("agentModeTrigger");
    if (!impl || !chip) return;
    var on = impl.agentModeEntryOf("pure").on;
    chip.classList.toggle("on", !!on);
    var t = document.getElementById("agentModeTrigger");
    t.title = "模式：" + (on ? "纯净模式（开）" : "纯净模式（关）");
  }

  /* 建 #agentModeMenu 的两行（复刻 buildAgentModeMenu 的结构：row = meta + 开关） */
  function buildMenu() {
    var impl = window.__modeImpl;
    var menu = document.getElementById("agentModeMenu");
    if (!impl || !menu) return;
    menu.innerHTML = "";
    menu.hidden = false;
    var keys = ["pure", "auto"];
    for (var i = 0; i < keys.length; i++) {
      var entry = impl.agentModeEntryOf(keys[i]);
      var row = document.createElement("div");
      row.className = "agent-tools-row";
      var meta = document.createElement("div");
      meta.className = "agent-tools-meta";
      var lab = document.createElement("div");
      lab.className = "agent-tools-lab";
      lab.textContent = entry.label;
      var small = document.createElement("small");
      small.textContent = entry.hint;
      meta.appendChild(lab); meta.appendChild(small);
      row.appendChild(meta);
      var btn = impl.agentModeToggleBtn(entry);
      btn.onclick = (function (k) {
        return function () {
          window.__modeImpl.agentModeEntryOf(k).toggle();
          window.__modeImpl.paintAgentModeToggleBtn(window.__modeImpl.agentModeEntryOf(k));
        };
      })(keys[i]);
      row.appendChild(btn);
      menu.appendChild(row);
    }
    void document.body.offsetHeight;
  }

  function rowMetrics() {
    var row = q(".agent-composer-chips");
    var composer = q(".agent-composer");
    var rr = R(row), cr = R(composer);
    var kids = qa(".agent-chip", row).map(function (el) {
      return {
        id: el.id || null, text: textOf(el), disabled: !!el.disabled, rect: R(el),
        flexGrow: getComputedStyle(el).flexGrow, flexShrink: getComputedStyle(el).flexShrink,
        maxW: getComputedStyle(el).maxWidth, ow: el.offsetWidth, sw: el.scrollWidth,
        clippedSelf: el.scrollWidth > el.offsetWidth + 1,
      };
    });
    var hardIds = ["agentRunPlanBtn", "agentCmdTrigger", "agentToolsTrigger", "agentModeTrigger", "agentBrowserChip"];
    var hard = hardIds.map(function (id) {
      var el = document.getElementById(id);
      if (!el || el.hidden) return { id: id, present: false };
      var r = R(el);
      var insideRow = r.x >= rr.x - 0.5 && r.right <= rr.right + 0.5;
      var insideComposer = r.x >= cr.x - 0.5 && r.right <= cr.right + 0.5;
      return { id: id, present: true, rect: r, insideRow: insideRow, insideComposer: insideComposer };
    });
    return {
      row: rr, composer: cr,
      rowOverflowX: +(row.scrollWidth - row.clientWidth).toFixed(1),
      rowOverflowY: +(row.scrollHeight - row.clientHeight).toFixed(1),
      overflowX: getComputedStyle(row).overflowX,
      overflowY: getComputedStyle(row).overflowY,
      wrap: getComputedStyle(row).flexWrap,
      kids: kids, hard: hard,
      modeChipText: textOf(document.getElementById("agentModeTrigger")),
      modeSummary: (function () {
        var v = document.getElementById("agentModeTriggerVal");
        return v ? { text: v.textContent, hidden: !!v.hidden, rect: R(v) } : null;
      })(),
    };
  }

  function menuMetrics() {
    var menu = document.getElementById("agentModeMenu");
    var out = [];
    qa("[data-mode-key]", menu).forEach(function (b) {
      out.push({
        key: b.dataset.modeKey,
        cls: b.className,
        on: b.classList.contains("on"),
        ariaChecked: b.getAttribute("aria-checked"),
        ownText: ownText(b),
        textContent: textOf(b),
        rect: R(b),
        track: (function () { var t = q(".agent-mode-track", b); return t ? R(t) : null; })(),
      });
    });
    return out;
  }

  return {
    stage: stage, buildMenu: buildMenu, rowMetrics: rowMetrics, menuMetrics: menuMetrics, R: R,
    setPure: function (v) { window.__probeSession.pure = !!v; paintChip(); },
    setAuto: function (v) { window.LongRun.on = !!v; },
    clickToggle: function (key) {
      var b = q('[data-mode-key="' + key + '"]', document.getElementById("agentModeMenu"));
      if (!b) return false;
      b.click();
      return true;
    },
  };
})();
`;

/* ============================ 探针页 ============================ */
function probeHtml() {
  const html = fs.readFileSync(rel("renderer", "index.html"), "utf8");
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!m) throw new Error("renderer/index.html 里没有解析到 <body>");
  const body = m[1].replace(/<script[\s\S]*?<\/script>/gi, "");
  const styleEntry = fs.readFileSync(rel("renderer", "style.css"), "utf8");
  const names = [];
  const re = /@import\s+url\(["']?([^"')]+)["']?\)/g;
  let mm;
  while ((mm = re.exec(styleEntry))) names.push(mm[1]);
  if (!names.length) throw new Error("renderer/style.css 没有解析到 @import 分片");
  let css = "";
  for (const n of names) css += "\n/* ==== " + n + " ==== */\n" + fs.readFileSync(path.join(rel("renderer"), n.split("/").join(path.sep)), "utf8");
  const baseHref = "file:///" + rel("renderer").split(path.sep).join("/").replace(/\/$/, "") + "/";
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><base href="' + baseHref + '">' +
    "<style>" + css + "</style></head><body>" + body +
    "\n<script>" + PROBE_SRC + "</scr" + "ipt></body></html>"
  );
}

/* ============================ 用例矩阵 ============================ */
/* 工作区文本长度：这是「软 chip」里最长的那一枚，也是历史上把整排顶出界的那一位 */
const WS_TEXTS = [
  "pipeline-console",
  "E:\\dev\\tools\\pipeline-console",
  "E:\\dev\\tools\\pipeline-console\\renderer\\css\\components",
  "E:\\工作\\一个非常非常长的中文项目目录名\\子目录\\再一层\\更深一层\\项目根",
];
const WIDTHS = [1280, 1100, 960, 880];

async function main() {
  const { app, BrowserWindow } = require("electron");
  try {
    app.setPath("userData", path.join(os.tmpdir(), "mtnode-smoke-composer-chips-userdata"));
  } catch (_) {}
  app.commandLine.appendSwitch("disable-gpu");

  const report = process.argv.includes("--report");
  let checks = 0;
  let fails = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) {
      if (report) console.log("  ✓ " + msg);
    } else {
      fails++;
      console.log("  ✗ " + msg);
    }
  };

  await app.whenReady();

  const tmp = path.join(os.tmpdir(), "mtnode-smoke-composer-chips.html");
  fs.writeFileSync(tmp, probeHtml(), "utf8");

  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: WIDTHS[0],
    height: 800,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(tmp);
  win.webContents.setZoomFactor(1);
  const onConsole = (...args) => {
    const a = args[0];
    const isEventObj = !!a && typeof a === "object";
    const level = isEventObj ? a.level : args[1];
    const message = isEventObj ? a.message : args[2];
    const line = isEventObj ? a.lineNumber : args[3];
    const source = isEventObj ? a.sourceId : args[4];
    if ((Number(level) || 0) < 3) return;
    if (/Content-Security-Policy/.test(String(message))) return;
    console.error("[renderer] " + source + ":" + line + " " + message);
  };
  win.webContents.on("console-message", onConsole);

  const exitWith = (code) => {
    try { fs.unlinkSync(tmp); } catch (_) {}
    console.log(
      (code === 0 ? "✅" : "❌") + " smoke-composer-chips：" + checks + " 项检查，" +
        (checks - fails) + " 通过" + (fails ? " · " + fails + " 失败" : ""),
    );
    app.exit(code);
  };

  /* ---------- 现场自检：真实样式生效 + 隐藏窗口真的算了布局 ---------- */
  const sanity = await win.webContents.executeJavaScript(
    "(function(){var m=document.querySelector('.agent-main');var row=document.querySelector('.agent-composer-chips');" +
      "return {mainOvf:getComputedStyle(m).overflow, rowOvfX:getComputedStyle(row).overflowX," +
      " sheets:document.styleSheets.length, chips:document.querySelectorAll('.agent-chip').length," +
      " pane:getComputedStyle(document.getElementById('agentPane')).display, viewport:window.innerWidth+'x'+window.innerHeight};})()",
    true,
  );
  if (report) console.log("【现场自检】" + JSON.stringify(sanity));
  if (sanity.mainOvf !== "hidden" || sanity.sheets === 0 || sanity.chips < 5) {
    console.error("真实样式/DOM 没生效（overflow=" + sanity.mainOvf + " sheets=" + sanity.sheets + " chips=" + sanity.chips + "），测量不可信，直接退出。");
    return exitWith(2);
  }
  /* 改窗口尺寸是异步的：不把视口读回来确认，后面就会拿到「上一格宽度」下的布局数据
     （聚合入口里窗口一忙，这一格就会串成别格的宽度，报出假红） */
  const setW = async (w) => {
    for (let i = 0; i < 12; i++) {
      const cur = await win.webContents.executeJavaScript("window.innerWidth", true);
      if (Math.abs(cur - w) <= 1) return cur;
      win.setContentSize(w, 800);
      await new Promise((r) => setTimeout(r, 60));
    }
    return await win.webContents.executeJavaScript("window.innerWidth", true);
  };

  /* ---------- 把产品构件注进页面 ---------- */
  try {
    const injected = await win.webContents.executeJavaScript(implInjection(), true);
    if (injected !== true) throw new Error("注入后 window.__modeImpl 仍然不存在");
  } catch (e) {
    console.error("注入产品构件失败（app-assist.js 的函数名/写法变了？）：\n" + ((e && e.message) || e));
    return exitWith(2);
  }

  /* ---------- 组 0：反向自检（证明这套判据真的在量，而不是恒真） ----------
     临时注入「旧 CSS 的口径」（只进探针页，绝不写回产品文件）：
       · 每枚 chip 都 flex:none（不许收缩）+ 容器横向滚动 = 本轮修之前的写法；
       · 再加一条把「模式」键面的摘要节点放出来（旧版就是往里写「纯净模式 · 自动续跑」）。
     宽窗口下必须报出「内容超出排宽 / 硬 chip 出界」——这正是用户看到的「挤兑右侧按钮出界」。 */
  await setW(WIDTHS[0]);
  const LEGACY_BAD =
    ".agent-composer-chips{overflow-x:auto !important;overflow-y:hidden !important;}" +
    ".agent-composer-chips .agent-chip{flex:0 0 auto !important;max-width:340px !important;}" +
    ".agent-chip.agent-chip-mode .agent-tool-val{display:inline !important;}" +
    ".agent-chip.agent-chip-mode{max-width:none !important;flex:0 0 auto !important;}";
  await win.webContents.executeJavaScript(
    "(function(css){var o=document.getElementById('__whatif');if(o)o.remove();" +
      "var s=document.createElement('style');s.id='__whatif';s.textContent=css;document.head.appendChild(s);" +
      "window.__probe.stage({ws:'E:\\\\工作\\\\一个非常非常长的中文项目目录名\\\\子目录\\\\再一层\\\\更深一层\\\\项目根',runPlan:true,forceSummary:'纯净模式 · 自动续跑'});})(" +
      JSON.stringify(LEGACY_BAD) + ")",
    true,
  );
  const legacy = await win.webContents.executeJavaScript("window.__probe.rowMetrics()", true);
  const legacyHard = legacy.hard.filter((h) => h.present && (!h.insideRow || !h.insideComposer));
  const legacyMode = legacy.kids.filter((k) => k.id === "agentModeTrigger")[0];
  console.log(
    "【反向自检】旧 CSS 口径（chip 全钉死 + 摘要写进键面）在 " + WIDTHS[0] + "px 下：" +
      "内容超 " + legacy.rowOverflowX + "px · 模式键面 " + (legacyMode ? legacyMode.rect.w : "?") + "px · 出界硬 chip " +
      (legacyHard.length ? legacyHard.map((b) => b.id).join(",") : "无"),
  );
  ok(
    legacy.rowOverflowX > 0.5 || legacyHard.length > 0,
    "反向自检：旧口径在 " + WIDTHS[0] + "px 下必须被这套判据抓成「这排装不下自己」（否则等于没在量）",
  );
  await win.webContents.executeJavaScript(
    "(function(){var o=document.getElementById('__whatif');if(o)o.remove();})()",
    true,
  );

  /* ---------- 组 1：宽度矩阵 —— 这排必须装得下自己，硬 chip 一个都不许出界 ---------- */
  if (report) console.log("\n=== 组 1：多宽度 × 多工作区文本 ===");
  let cells = 0;
  let hardVisible = 0;
  for (const width of WIDTHS) {
    await setW(width);
    for (const ws of WS_TEXTS) {
      for (const runPlan of [false, true]) {
        await win.webContents.executeJavaScript(
          "window.__probe.stage(" + JSON.stringify({ ws, runPlan, model: "标准模式 · deepseek-flash" }) + ")",
          true,
        );
        const m = await win.webContents.executeJavaScript("window.__probe.rowMetrics()", true);
        cells++;
        if (report)
          console.log(
            "  " + width + "px · ws=" + ws.length + "字 · runPlan=" + runPlan +
              " → 排 " + m.row.w + "px / 容器 " + m.composer.w + "px · 内容超 " + m.rowOverflowX +
              "px · 行高 " + m.row.h + "px",
          );
        ok(
          m.rowOverflowX <= 0.5,
          "排内容不超宽（" + width + "px · 工作区 " + ws.length + " 字 · 执行计划" + (runPlan ? "在场" : "缺席") +
            "）：内容 " + (m.row.w + m.rowOverflowX).toFixed(1) + "px ≤ 排宽 " + m.row.w + "px",
        );
        ok(m.row.right <= m.composer.right + 0.5 && m.row.x >= m.composer.x - 0.5,
          "这一排整体落在输入区宽度内（" + width + "px）");
        ok(m.row.h < 44, "恒定一行（行高 " + m.row.h + "px < 两行阈值 44px）");
        const bad = m.hard.filter((h) => h.present && (!h.insideRow || !h.insideComposer));
        if (!bad.length) hardVisible++;
        ok(
          bad.length === 0,
          "硬 chip 全部完整可见、不出界（" + width + "px · 工作区 " + ws.length + " 字" +
            (bad.length ? " → 出界：" + bad.map((b) => b.id).join(",") : "）"),
        );
      }
    }
  }
  ok(cells >= 30, "宽度矩阵跑了 " + cells + " 格（≥30 才算真扫过）");
  ok(hardVisible === cells, "每一格都「硬 chip 一个不少地完整可见」：" + hardVisible + "/" + cells);

  /* 「模式」键面：只有「模式」两字，摘要节点不显示也不吃宽度 */
  await setW(WIDTHS[0]);
  await win.webContents.executeJavaScript("window.__probe.stage({ws:'E:\\\\dev\\\\tools\\\\pipeline-console',runPlan:true})", true);
  const chipInfo = await win.webContents.executeJavaScript("window.__probe.rowMetrics()", true);
  const modeKid = chipInfo.kids.filter((k) => k.id === "agentModeTrigger")[0];
  const toolKid = chipInfo.kids.filter((k) => k.id === "agentToolsTrigger")[0];
  console.log(
    "\n【模式键面】" + JSON.stringify({
      text: chipInfo.modeChipText,
      w: modeKid ? modeKid.w : null,
      summary: chipInfo.modeSummary,
      toolsW: toolKid ? toolKid.w : null,
    }),
  );
  ok(chipInfo.modeChipText === "模式", "「模式」键面文字只有「模式」两字（实测「" + chipInfo.modeChipText + "」）");
  ok(chipInfo.modeSummary && chipInfo.modeSummary.hidden && !chipInfo.modeSummary.text,
    "旧摘要节点恒 hidden 且为空文本（不再承载「纯净模式 · 自动续跑」）");
  ok(chipInfo.modeSummary && chipInfo.modeSummary.rect && chipInfo.modeSummary.rect.w === 0,
    "摘要节点占宽 0px（不挤兑右侧按钮）");

  /* 故意往摘要节点里写内容：也不许显示、不许改变这一排宽度（兼容留位的兜底口径） */
  {
    const before = await win.webContents.executeJavaScript("window.__probe.rowMetrics()", true);
    await win.webContents.executeJavaScript(
      "window.__probe.stage({ws:'E:\\\\dev\\\\tools\\\\pipeline-console',runPlan:true,forceSummary:'纯净模式 · 自动续跑'})",
      true,
    );
    const after = await win.webContents.executeJavaScript("window.__probe.rowMetrics()", true);
    const sum = after.modeSummary || {};
    ok(sum.hidden === true || (sum.rect && sum.rect.w === 0),
      "即使有内容被写进摘要节点，它仍不显示（hidden=" + sum.hidden + " · 宽 " + (sum.rect ? sum.rect.w : "?") + "px）");
    ok(Math.abs(after.row.w - before.row.w) <= 0.5,
      "往摘要节点写内容也不改变这一排宽度（" + before.row.w + "px → " + after.row.w + "px）");
    ok(after.rowOverflowX <= 0.5, "写内容后这排仍不超宽（超 " + after.rowOverflowX + "px）");
  }

  /* ---------- 组 2：toggle 构件（真源码）—— hit box 与「不写内容」 ---------- */
  if (report) console.log("\n=== 组 2：模式菜单开关 ===");
  await win.webContents.executeJavaScript("window.__probe.setPure(false); window.__probe.setAuto(true);", true);
  const built = await win.webContents.executeJavaScript("window.__probe.buildMenu(); JSON.stringify(window.__probe.menuMetrics())", true);
  const menu = JSON.parse(built);
  console.log("【开关实测】" + JSON.stringify(menu.map((b) => ({ key: b.key, on: b.on, aria: b.ariaChecked, w: b.rect.w, h: b.rect.h, ownText: b.ownText }))));
  ok(menu.length === 2, "「模式」菜单两行开关都建出来了（纯净模式 / 自动续跑）");
  for (const b of menu) {
    ok(b.rect.w >= 44 && b.rect.h >= 26,
      "开关 " + b.key + " 的 hit box " + b.rect.w + "×" + b.rect.h + " ≥ 44×26（用户点得中）");
    ok(b.ownText === "" && b.textContent === "",
      "开关 " + b.key + " 键面里没有任何文字（实测「" + b.ownText + "」）");
    ok(b.track && b.track.w >= 30 && b.track.h >= 16,
      "开关 " + b.key + " 的槽可见（" + (b.track ? b.track.w + "×" + b.track.h : "无") + "）");
    ok(b.ariaChecked === (b.on ? "true" : "false"),
      "开关 " + b.key + " 的 aria-checked 与开关态一致（" + b.ariaChecked + "）");
  }
  const pureBtn = menu.filter((b) => b.key === "pure")[0];
  const autoBtn = menu.filter((b) => b.key === "auto")[0];
  ok(pureBtn && pureBtn.on === false, "纯净模式默认关（chip 与菜单同一判据）");
  ok(autoBtn && autoBtn.on === true, "自动续跑默认开（真源 = LongRun.autoOn，缺省开）");

  /* 打开开关：键面不许变宽、不许凭空多出文字（旧实现写 ✓ / 摘要就是在这里出事） */
  {
    const before = await win.webContents.executeJavaScript("window.__probe.menuMetrics()", true);
    await win.webContents.executeJavaScript("window.__probe.clickToggle('pure'); JSON.stringify(window.__probe.menuMetrics())", true);
    const after = await win.webContents.executeJavaScript("window.__probe.menuMetrics()", true);
    const b0 = before.filter((b) => b.key === "pure")[0];
    const a0 = after.filter((b) => b.key === "pure")[0];
    ok(a0.on === true, "点一下开关真开了（纯净模式 on）");
    ok(Math.abs(a0.rect.w - b0.rect.w) <= 0.5 && Math.abs(a0.rect.h - b0.rect.h) <= 0.5,
      "开关态变化不改变 hit box 尺寸（" + b0.rect.w + "×" + b0.rect.h + " → " + a0.rect.w + "×" + a0.rect.h + "）");
    ok(a0.ownText === "" && a0.textContent === "",
      "开启后键面仍不写内容（实测「" + a0.ownText + "」）");
  }

  /* ---------- 组 3：开关打开 → 整排宽度不得增长（就是「挤兑右侧按钮」的量化版） ---------- */
  await setW(WIDTHS[0]);
  await win.webContents.executeJavaScript("window.__probe.setPure(false); window.__probe.setAuto(false); window.__probe.buildMenu(); window.__probe.stage({ws:'E:\\\\dev\\\\tools\\\\pipeline-console',runPlan:true});", true);
  const offM = await win.webContents.executeJavaScript("window.__probe.rowMetrics()", true);
  await win.webContents.executeJavaScript(
    "window.__probe.setPure(true); window.__probe.setAuto(true); window.__probe.buildMenu(); window.__probe.stage({ws:'E:\\\\dev\\\\tools\\\\pipeline-console',runPlan:true});",
    true,
  );
  const onM = await win.webContents.executeJavaScript("window.__probe.rowMetrics()", true);
  const offMode = offM.kids.filter((k) => k.id === "agentModeTrigger")[0];
  const onMode = onM.kids.filter((k) => k.id === "agentModeTrigger")[0];
  const offModeW = offMode ? offMode.rect.w : null;
  const onModeW = onMode ? onMode.rect.w : null;
  console.log(
    "【两态对比】全关 → 模式键面 " + offModeW + "px / 排 " + offM.row.w + "px；全开 → " + onModeW + "px / 排 " + onM.row.w + "px",
  );
  ok(
    offModeW != null && onModeW != null && Math.abs(onModeW - offModeW) <= 0.5,
    "开关全开后「模式」键面宽度不变（" + offModeW + "px → " + onModeW + "px）",
  );
  ok(Math.abs(onM.row.w - offM.row.w) <= 0.5, "开关全开后这一排总宽不变（" + offM.row.w + "px → " + onM.row.w + "px）");
  ok(onM.rowOverflowX <= 0.5, "开关全开后这一排仍不超宽（超 " + onM.rowOverflowX + "px）");
  const badOn = onM.hard.filter((h) => h.present && (!h.insideRow || !h.insideComposer));
  ok(badOn.length === 0, "开关全开后硬 chip 仍全部完整可见" + (badOn.length ? " → 出界：" + badOn.map((b) => b.id).join(",") : ""));

  return exitWith(fails ? 1 : 0);
}

"use strict";
/* MiniMax H3 插件管理窗（h3/ui）显示回归
 *   node test/smoke-h3-ui.js
 * 与 test/smoke-media-gen-menu.js 同一套路：用 vm 从源码里按名字抠出**真实函数**来跑，
 * 只有外部命令（nvidia-smi）与 DOM 用测试侧替身。
 *
 * 锁住的需求（都是真出过的显示错误）：
 *   1. h3/ui 里 HTML/JS 用到的每一个 class 都必须有样式规则 —— 加「自建工作流库」那次把
 *      .modal-bg / .modal 整段删了，结果「确认卸载」「粘贴工作流 JSON」两个弹窗不再隐藏，
 *      常驻显示在页面底部（.show 完全失效）。
 *   2. .wrap 必须可纵向滚动：卡片变多后 420×640 的窗口会把底部「后端 Console」裁掉且滚不到。
 *   3. nvidia-smi 取不到数值（[N/A] / ERR!）时绝不把 NaN 递给界面（原来显示 "NaN/NaN MiB (NaN%)"）；
 *      无数据统一回退 null / 「—」；多卡显示实际在跑的那张并标出卡号；卡名缺失不留孤立的「 · 」。
 *   4. 界面里出现的按钮名必须真有其名（原来提示「重新点『启用服务』」，但按钮叫「手动启动」）。
 *   5. 弹窗关不掉：#modal / #wfModal 必须带 hidden，JS 用内联 display 兜底 —— 只靠
 *      .modal-bg 样式类的话，那段 CSS 一旦被改坏，「确认卸载」框就常驻页面且摘不掉。
 *   6. 管理窗加载的是 %APPDATA%\…\h3\ui 的**副本**：改了源码必须让已开着的窗口 reload，
 *      否则修好的界面永远看不到（同样的症状：卸载框关不掉）。 */
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
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);

const html = read("h3/ui/index.html");
const uiJs = read("h3/ui/ui.js");
const mainJs = read("h3/main-h3.js");

/* ── [1] class ⇄ 样式覆盖 ───────────────────────────────────────── */
const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
const cssClasses = new Set(
  [...style.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
);
const usedClasses = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g))
  m[1].split(/\s+/).forEach((c) => c && usedClasses.add(c));
for (const m of uiJs.matchAll(/className\s*=\s*"([^"]+)"/g))
  m[1].split(/\s+/).forEach((c) => c && usedClasses.add(c));
for (const m of uiJs.matchAll(/classList\.(?:add|remove|toggle)\("([^"]+)"/g))
  usedClasses.add(m[1]);
for (const m of uiJs.matchAll(/className\s*=\s*"([^"]*)\s*"\s*\+/g))
  m[1].split(/\s+/).forEach((c) => c && usedClasses.add(c));

const orphan = [...usedClasses].filter((c) => !cssClasses.has(c)).sort();
ok(orphan.length === 0, "h3/ui 用到的 class 全都有样式（缺：" + show(orphan) + "）");
ok(/\.modal-bg\s*\{[^}]*display:\s*none/.test(style), ".modal-bg 默认隐藏（弹窗不再常驻页面）");
ok(/\.modal-bg\.show\s*\{\s*display:\s*flex/.test(style), ".modal-bg.show 以遮罩层显示");
ok(/\.modal\s*\{/.test(style), ".modal 有基础外观（背景/边框/宽度）");
ok(/\.modal\s+ul\s*\{/.test(style), ".modal ul 有样式（卸载清单不再裸奔）");
ok(/#wfModal\s+\.modal\s*\{/.test(style), "#wfModal .modal 宽度覆盖仍在");

/* ── [2] 窗口高度有限 → 内容必须可滚动 ─────────────────────────── */
const wrapRule = (style.match(/\.wrap\s*\{([^}]*)\}/) || [])[1] || "";
ok(/overflow-y:\s*auto/.test(wrapRule), ".wrap 纵向可滚动（新增工作流卡后底部 Console 不会被裁掉）");

/* ── [2b] 「卸载窗口关不掉」的兜底：hidden 属性 + 内联 display ─────
 * 只靠 CSS 类控制显隐太脆：.modal-bg 那段样式被误删后，「确认卸载」框常驻在页面底部，
 * 点「取消」只是摘掉一个没人认的 class —— 用户看到的就是一个关不掉的卸载窗口。
 * 现在 HTML 上两个弹窗都带 hidden，JS 再用内联 style.display 直接压住，双保险。 */
ok(/<div class="modal-bg" id="modal" hidden>/.test(html), "#modal 弹窗带 hidden（样式表坏了也默认隐藏）");
ok(/<div class="modal-bg" id="wfModal" hidden>/.test(html), "#wfModal 弹窗带 hidden");
ok(/\.modal-bg\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(style),
  ".modal-bg[hidden] 用 !important（不会被 .show 反压回来）");
const openFn = grab(uiJs, /function openModal\(el\) \{/, /\r?\n  \}\r?\n/, "openModal");
const closeFn = grab(uiJs, /function closeModal\(el\) \{/, /\r?\n  \}\r?\n/, "closeModal");
ok(/el\.hidden = false/.test(openFn) && /el\.style\.display = "flex"/.test(openFn),
  "openModal 同时清 hidden 并写内联 display（不再只加 class）");
ok(/el\.hidden = true/.test(closeFn) && /el\.style\.display = "none"/.test(closeFn),
  "closeModal 同时置 hidden 并写内联 display:none（样式再坏也关得掉）");
ok(!/modal\.classList\.(add|remove)\("show"\)/.test(uiJs),
  "没有裸用 classList.add/remove(\"show\") 的残留调用");
ok(/key\s*[!=]==\s*"Escape"/.test(uiJs), "Esc 能关掉开着的弹窗（多一条逃出通道）");
ok(/pointerdown/.test(uiJs) && /ev\.target === el/.test(uiJs),
  "点遮罩空白处能关掉弹窗（多一条逃出通道）");

/* ── [2c] 运行时 UI 副本：源码改了必须让已开着的窗口重载 ───────────
 * 管理窗加载的是 %APPDATA%\…\h3\ui 里的**副本**；旧实现只在开窗口时盲拷一次，
 * 窗口还开着就只 show() 不 reload —— 修好的界面永远看不到，症状同样是「弹窗关不掉」。 */
const ensureSrc = grab(mainJs, /function ensureUiRuntime\(\) \{/, /\r?\n\}\r?\n/, "ensureUiRuntime");
ok(/return \{ changed/.test(ensureSrc), "ensureUiRuntime 返回 changed（内容真的变了才写盘）");
ok(/a\.equals\(b\)/.test(ensureSrc), "ensureUiRuntime 按内容比较，而不是无脑 copyFileSync");
ok(/indexOf\(rel\) >= 0/.test(ensureSrc), "ensureUiRuntime 会清掉源码里已不存在的残留文件");
const openWinSrc = grab(mainJs, /function openConsoleWindow\(\) \{/, /\r?\n\}\r?\n/, "openConsoleWindow");
ok(/webContents\.reload\(\)/.test(openWinSrc), "openConsoleWindow 在 UI 变化时 reload 已开着的窗口");
ok(/loadedUiStamp/.test(mainJs), "记录已加载的 UI 指纹（副本被别处刷新过也能发现）");

/* ── [2d] ensureUiRuntime 真函数跑一遍：副本必须跟着源码走 ────────
 * 现场复现过：源码里的弹窗样式已经修好，但 %APPDATA%\…\h3\ui 里还是旧副本，
 * 管理窗加载的就是那份旧副本 —— 用户继续看到「关不掉的卸载窗口」。 */
const uiRuntimeSrc = grab(
  mainJs,
  /function listRelFiles\(dir\) \{/,
  /\r?\n  return \{ changed, files: rels\.length \};\r?\n\}\r?\n/,
  "ensureUiRuntime 三连",
);
(function exerciseUiRuntime() {
  const os = require("os");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "h3-ui-"));
  const src = path.join(base, "pkg", "ui");
  const root = path.join(base, "data", "h3");
  fs.mkdirSync(src, { recursive: true });
  const ctx = {
    fs,
    path,
    crypto: require("crypto"),
    join: (...a) => path.join(...a),
    mk: (p) => (fs.mkdirSync(p, { recursive: true }), p),
    __dirname: path.join(base, "pkg"),
    h3Root: () => root,
  };
  vm.runInNewContext(
    uiRuntimeSrc + "; ({ ensureUiRuntime, uiRuntimeStamp })",
    ctx,
  );
  const dest = path.join(root, "ui", "index.html");
  fs.writeFileSync(path.join(src, "index.html"), "<i>v1</i>");
  let r = ctx.ensureUiRuntime();
  ok(r.changed === true && fs.readFileSync(dest, "utf8") === "<i>v1</i>",
    "首次：副本从源码建出来（得到 " + show(r) + "）");
  r = ctx.ensureUiRuntime();
  ok(r.changed === false, "内容没变第二次不再写盘 → changed=false（不会每次开窗口都无脑重拷）");
  fs.writeFileSync(path.join(src, "index.html"), "<i>v2-fixed</i>");
  r = ctx.ensureUiRuntime();
  ok(r.changed === true && fs.readFileSync(dest, "utf8") === "<i>v2-fixed</i>",
    "源码改了 → changed=true 且副本同步（已开着的窗口据此 reload）");
  fs.writeFileSync(dest, "<i>stale</i>");
  r = ctx.ensureUiRuntime();
  ok(r.changed === true && fs.readFileSync(dest, "utf8") === "<i>v2-fixed</i>",
    "副本被写坏/过期 → 再次拉回源码内容（得到 " + show(r) + "）");
  fs.writeFileSync(path.join(root, "ui", "ghost.js"), "x");
  r = ctx.ensureUiRuntime();
  ok(r.changed === true && !fs.existsSync(path.join(root, "ui", "ghost.js")),
    "源码里已删掉的旧文件不会残留在副本里");
  const s1 = ctx.uiRuntimeStamp(path.join(root, "ui"));
  fs.writeFileSync(path.join(src, "ui.js"), "1");
  ctx.ensureUiRuntime();
  ok(/^[0-9a-f]{12}$/.test(s1) && ctx.uiRuntimeStamp(path.join(root, "ui")) !== s1,
    "UI 指纹随内容变化（reload 的判据）");
  fs.rmSync(base, { recursive: true, force: true });
})();


/* ── [3] GPU 读数：queryGpu 真函数 + applyGpu 真函数 ───────────── */
function grab(src, startRe, endRe, label) {
  const s = src.match(startRe);
  if (!s) throw new Error(label + "：没找到函数起点");
  const rest = src.slice(s.index);
  const e = rest.match(endRe);
  if (!e) throw new Error(label + "：没找到函数终点");
  return rest.slice(0, e.index + e[0].length);
}

const queryGpuSrc = grab(mainJs, /function queryGpu\(\) \{/, /\r?\n\}\r?\n/, "queryGpu");
function runQueryGpu(smiStdout) {
  const execFile = (_cmd, _args, _opts, cb) => cb(null, smiStdout);
  const fn = vm.runInNewContext(
    queryGpuSrc + "; queryGpu",
    { execFile, Number, Math, String, Array, JSON },
  );
  return fn();
}

const applyGpuSrc = grab(uiJs, /function applyGpu\(gpu\) \{/, /\r?\n  \}\r?\n/, "applyGpu");
function renderGpu(gpu) {
  let memTxt = "—";
  let utilTxt = "—";
  const bars = { mem: null, util: null };
  const txt = (which) => ({
    set textContent(v) {
      if (which === "mem") memTxt = v;
      else utilTxt = v;
    },
    get textContent() {
      return which === "mem" ? memTxt : utilTxt;
    },
  });
  const bar = (key) => ({ style: { set width(v) { bars[key] = v; }, get width() { return bars[key]; } } });
  const setBar = (el, pct) => { el.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%"; };
  vm.runInNewContext(
    applyGpuSrc + "; applyGpu",
    { gpuMemTxt: txt("mem"), gpuUtilTxt: txt("util"), gpuMemBar: bar("mem"), gpuUtilBar: bar("util"), setBar, Number, String, Math },
  )(gpu);
  return { mem: memTxt, util: utilTxt };
}

(async () => {
  /* 正常单卡 */
  let g = await runQueryGpu("NVIDIA GeForce RTX 4090, 12000, 24576, 85\r\n");
  ok(g && g.memUsed === 12000 && g.memTotal === 24576 && g.memPct === 48.8 && g.util === 85,
    "正常单卡读数正确（得到 " + show(g) + "）");
  let r = renderGpu(g);
  ok(r.mem === "12000/24576 MiB (48.8%) · NVIDIA GeForce RTX 4090" && r.util === "85%",
    "正常单卡文案：显存 + 百分比 + 卡名（得到 " + show(r) + "）");

  /* nvidia-smi 回 [N/A]：以前会显示 NaN/NaN MiB (NaN%) */
  g = await runQueryGpu("NVIDIA GeForce RTX 4090, [N/A], [N/A], [N/A]\r\n");
  ok(g === null, "全 [N/A] 视为无数据 → null（得到 " + show(g) + "）");
  g = await runQueryGpu("NVIDIA GeForce RTX 4090, 12000, ERR!, 90\r\n");
  ok(!!g && g.memTotal === null && g.memPct === null && g.memUsed === 12000 && g.util === 90,
    "部分取不到 → 该字段为 null，其它照显（得到 " + show(g) + "）");
  r = renderGpu(g);
  ok(r.mem === "12000/— MiB · NVIDIA GeForce RTX 4090" && r.util === "90%",
    "取不到的那一项显示「—」而不是 NaN（得到 " + show(r) + "）");
  ok(!/NaN/.test(show(g) + show(renderGpu(g))), "GPU 数据与文案里绝无 NaN");

  /* 无设备 / 空输出 */
  ok((await runQueryGpu("No devices were found\r\n")) === null, "No devices were found → null");
  ok((await runQueryGpu("")) === null, "nvidia-smi 空输出 → null");

  /* 多卡：取真正在用的那张并标卡号 */
  g = await runQueryGpu(
    "NVIDIA GeForce RTX 4060, 300, 8188, 10\r\nNVIDIA GeForce RTX 4090, 20000, 24576, 99\r\n",
  );
  ok(!!g && g.memUsed === 20000 && /GPU1/.test(g.name),
    "多卡时显示占用最高的那张并标出卡号（得到 " + show(g && g.name) + "）");

  /* 卡名缺失不留孤立的「 · 」 */
  r = renderGpu({ memUsed: 1, memTotal: 2, memPct: 50, util: 0, name: "" });
  ok(!/\s·\s*$/.test(r.mem) && r.util === "0%", "卡名为空时不留孤立的「 · 」，0% 不被吞（得到 " + show(r) + "）");

  /* ── [4] 提示文案里的按钮名必须真实存在 ───────────────────────── */
  const btnLabels = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1].trim());
  ok(!/启用服务/.test(uiJs), "不再有指向不存在按钮的「启用服务」提示");
  for (const m of uiJs.matchAll(/「([^」]{2,8})」/g)) {
    const t = m[1];
    const isBtnRef = /点|击/.test(uiJs.slice(Math.max(0, m.index - 12), m.index));
    if (isBtnRef) ok(btnLabels.some((b) => b.includes(t)), "提示里点「" + t + "」在界面上确有其按钮");
  }

  /* ── [5] Console 停靠面板（不再挤在底部）+ 右上角开关 ─────────────── */
  const paneHtml = (html.match(/<aside class="console-pane"[\s\S]*?<\/aside>/) || [])[0] || "";
  ok(!!paneHtml, "页面里有左侧 Console 面板节点");
  ok(/<aside class="console-pane" id="consolePane" hidden>/.test(html), "面板默认收起（hidden）");
  ok(html.indexOf('id="consolePane"') < html.indexOf('<div class="wrap">'),
    "面板排在主列之前 → 它钉在窗口左侧，不是底部");
  ok((paneHtml.match(/id="console"/g) || []).length === 1 &&
    (html.match(/id="console"/g) || []).length === 1,
    "全页只有一个 #console，且它在面板里（底部那张卡片已删）");
  ok(/id="btnClearLog"/.test(paneHtml), "清空视图跟着面板走（面板里唯一另一件事）");
  const paneRule = (style.match(/\.console-pane\s*\{([^}]*)\}/) || [])[1] || "";
  ok(/height:\s*100%/.test(paneRule), "面板与窗口等高（height:100%）");
  ok(/\.console-pane\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(style),
    ".console-pane[hidden] 用 !important（不会被 display:flex 反压回来）");
  ok(/<div class="wrap">[\s\S]{0,400}?<div class="topbtns">[\s\S]*?id="btnConsolePane"[\s\S]*?id="btnOpenComfy"[\s\S]*?<\/div>/.test(html),
    "主列最上方一行里就是按钮条：Console 开关 + ComfyUI 两个按钮");
  const topRule = (style.match(/\.topbtns\s*\{([^}]*)\}/) || [])[1] || "";
  ok(/position:\s*sticky/.test(topRule) && /top:\s*0/.test(topRule) && /justify-content:\s*flex-end/.test(topRule),
    ".topbtns 吸在主列滚动容器顶部右对齐（fixed 会盖住标题与提示条）");
  ok(/background:\s*var\(--bg\)/.test(topRule), "按钮条自带底色（滚动时内容不从它下面透出来）");

  /* 右上角两个按钮与面板的句柄必须在文件头一次取齐、且早于首个使用者 refresh()：
     const 有 TDZ —— comfyBtn 一度声明在 refresh() 之后几百行，刷新时机只要提前一次
     （新加个事件回调去调 refresh()）整窗就是 ReferenceError 白屏。 */
  const refreshAt = uiJs.search(/async function refresh\(\)/);
  for (const id of ["consolePane", "btnConsolePane", "cbadge", "btnOpenComfy"]) {
    const hits = uiJs.match(new RegExp('\\$\\("' + id + '"\\)', "g")) || [];
    ok(hits.length === 1, "#" + id + " 只取一次 DOM 存句柄（不会重复声明 const）");
    const declAt = uiJs.search(new RegExp('const \\w+ = \\$\\("' + id + '"\\)'));
    ok(declAt >= 0 && declAt < refreshAt, "#" + id + " 句柄声明早于 refresh()（避开 TDZ）");
  }

  /* 面板开合的渲染层真函数：状态只有一处，宽度从 DOM 量出来上报（不再各写一份常量） */
  const setPaneSrc = grab(uiJs, /async function setPaneOpen\(on\) \{/, /\r?\n  \}\r?\n/, "setPaneOpen");
  ok(/paneEl\.hidden = !want/.test(setPaneSrc) && /paneStore\(want\)/.test(setPaneSrc),
    "setPaneOpen 同时改 hidden 与本地记忆（reload / 重开窗口能恢复）");
  ok(/setConsolePane\(\{ open: want, width \}\)/.test(setPaneSrc) && /paneEl\.offsetWidth/.test(setPaneSrc),
    "宽度按面板实际像素量出来报给宿主（CSS 改了窗口跟着改，两边不会打架）");
  ok(/if \(paneOpen === want\) return;/.test(setPaneSrc), "状态没变就不动窗口（不抖）");
  const logSrc = grab(uiJs, /function logLine\(s\) \{/, /\r?\n  \}\r?\n/, "logLine");
  ok(/if \(paneOpen\)[\s\S]*consoleEl\.scrollTop[\s\S]*else[\s\S]*paneUnread/.test(logSrc),
    "只有面板开着才自动滚动；收起时改记未读数（内容不白丢）");
  const badgeSrc = grab(uiJs, /function renderBadge\(\) \{/, /\r?\n  \}\r?\n/, "renderBadge");
  ok(/!paneOpen && paneUnread > 0/.test(badgeSrc) && /cbadgeEl\.hidden =/.test(badgeSrc),
    "未读徽标只在面板收起且有新行时出现");
  const comfyHandlerSrc = grab(uiJs, /async function openComfyUi\(start\) \{/, /\r?\n  \}\r?\n/, "openComfyUi");
  ok(/backend_not_running/.test(comfyHandlerSrc) && /openComfyUi\(true\)/.test(comfyHandlerSrc),
    "后端没跑时先问一句再启动重开（不是一个死链接）");

  /* 主进程侧：窗口边界纯函数 —— 右边缘不动、往左撑、收回来回恒等、贴屏幕左边不越界 */
  const boundsSrc = grab(mainJs, /function paneShiftBounds\(b, wa, delta, minW\) \{/, /\r?\n\}\r?\n/, "paneShiftBounds");
  const shift = vm.runInNewContext(boundsSrc + "; paneShiftBounds", { Math, Number });
  const B = { x: 900, y: 40, width: 420, height: 640 };
  const WA = { x: 0, y: 0, width: 1920, height: 1040 };
  let r5 = shift(B, WA, 360, 420);
  ok(r5.x === 540 && r5.width === 780 && r5.x + r5.width === B.x + B.width,
    "开面板：往左撑 360，右边缘一格没动（得到 " + show(r5) + "）");
  ok(r5.height === 640 && r5.y === 40, "开面板不动上下 → 面板天然与窗口等高");
  let r5b = shift(r5, WA, -360, 420);
  ok(r5b.x === B.x && r5b.width === B.width, "收面板：回到原边界（往返恒等，得到 " + show(r5b) + "）");
  r5 = shift({ x: 0, y: 0, width: 420, height: 640 }, WA, 360, 420);
  ok(r5.x === 0 && r5.width === 780,
    "左边顶到屏幕边缘时 x 锁 0，改成往右长（主列不被压）（得到 " + show(r5) + "）");
  r5 = shift({ x: 0, y: 0, width: 420, height: 640 }, { x: 0, y: 0, width: 600, height: 1040 }, 360, 420);
  ok(r5.x === 0 && r5.width === 600,
    "整屏都放不下时才让主列让步，并停在工作区右缘（得到 " + show(r5) + "）");
  r5 = shift({ x: 10, y: 0, width: 500, height: 640 }, WA, -360, 420);
  ok(r5.width >= 420 && r5.x + r5.width === 510,
    "收得过窄时兜到最小宽并保持右边缘（得到 " + show(r5) + "）");
  r5 = shift(B, WA, 0, 420);
  ok(r5.x === B.x && r5.width === B.width, "delta=0 恒等（幂等基座）");

  /* setConsolePane：同一个状态连发两次必须只挪一次窗口 */
  const paneWinSrc =
    "let consoleWin = null; let consolePaneW = 0; let consolePaneApplied = 0;\n" +
    boundsSrc + "\n" +
    grab(mainJs, /function setConsolePane\(opts\) \{/, /\r?\n\}\r?\n/, "setConsolePane") +
    "; ({ setConsolePane, setWin: (w) => { consoleWin = w; }, paneW: () => consolePaneW })";
  function makeWin(b) {
    const calls = [];
    return {
      calls,
      isDestroyed: () => false,
      isMaximized: () => false,
      getBounds: () => Object.assign({}, b),
      setBounds: (n) => {
        calls.push(n);
        b = n;
      },
    };
  }
  const paneCtx = {
    Math, Number, String, Object,
    CONSOLE_PANE_W: 360, CONSOLE_PANE_MAX_W: 900, CONSOLE_WIN_MIN_W: 420,
    screen: { getDisplayMatching: () => ({ workArea: paneWa }) },
  };
  let paneWa = WA;
  const paneApi = vm.runInNewContext(paneWinSrc, paneCtx);
  const win5 = makeWin({ x: 900, y: 40, width: 420, height: 640 });
  paneApi.setWin(win5);
  paneApi.setConsolePane({ open: true, width: 360 });
  const againOpen = paneApi.setConsolePane({ open: true, width: 360 });
  ok(win5.calls.length === 1 && againOpen.ok === true && againOpen.paneWidth === 360,
    "重复下发同一个开状态 → 窗口只挪一次（得到 " + show(win5.calls) + "）");
  paneApi.setConsolePane({ open: false, width: 0 });
  ok(win5.calls.length === 2 && win5.calls[1].x === 900 && win5.calls[1].width === 420 && paneApi.paneW() === 0,
    "关面板：窗口回到原位（得到 " + show(win5.calls[1]) + "）");
  paneApi.setConsolePane({ open: false, width: 0 });
  ok(win5.calls.length === 2, "已经关了再关不产生第三次位移");
  /* 工作区很窄：撑不到 360 就撑多少算多少，收起时按「真撑开了多少」还回去 → 不会走偏 */
  const winN = makeWin({ x: 0, y: 0, width: 420, height: 640 });
  paneApi.setWin(winN);
  paneWa = { x: 0, y: 0, width: 600, height: 1040 };
  paneApi.setConsolePane({ open: true, width: 360 });
  ok(winN.calls[0].x === 0 && winN.calls[0].width === 600,
    "窄屏：往右长到工作区右缘为止（得到 " + show(winN.calls[0]) + "）");
  paneApi.setConsolePane({ open: false, width: 0 });
  ok(winN.calls[1].x === 180 && winN.calls[1].width === 420,
    "窄屏收回：按实际撑开的像素还原，宽度回到 420（得到 " + show(winN.calls[1]) + "）");
  paneWa = WA;
  ok(/consolePaneW = 0;/.test(mainJs) && (mainJs.match(/consolePaneW = 0/g) || []).length >= 2,
    "新窗口 / 关窗口时位移记账归零（否则下次撑开会偏）");
  ok(/ipcMain\.handle\("h3:setConsolePane"/.test(mainJs) && /ipcMain\.handle\("h3:openComfyUI"/.test(mainJs),
    "h3:setConsolePane / h3:openComfyUI 两个 IPC 已挂上");
  const preloadJs = read("h3/preload-h3.js");
  ok(/setConsolePane:/.test(preloadJs) && /openComfyUI:/.test(preloadJs),
    "preload 把两个能力桥给管理窗");

  /* ── [6] 一键打开 ComfyUI 编辑界面（真函数实跑）──────────────────── */
  const comfySrc =
    grab(mainJs, /function comfyUiUrl\(port\) \{/, /\r?\n\}\r?\n/, "comfyUiUrl") + "\n" +
    grab(mainJs, /async function openComfyUiInBrowser\(opts\) \{/, /\r?\n\}\r?\n/, "openComfyUiInBrowser");
  ok(/http:\/\/127\.0\.0\.1:\$\{/.test(comfySrc), "编辑界面地址走 127.0.0.1（后端只监听本机回环）");
  async function runComfy(ctxOverrides) {
    const lines = [];
    const opened = [];
    const ctx = Object.assign(
      {
        DEFAULT_PORT: 8188, Number, String, Math,
        loadConfig: () => ({ port: 8188 }),
        probeComfy: async () => true,
        startBackend: async () => ({ ok: true, port: 8188 }),
        appendConsole: (s) => lines.push(s),
        shell: { openExternal: async (u) => { opened.push(u); } },
      },
      ctxOverrides,
    );
    const fn = vm.runInNewContext(comfySrc + "; openComfyUiInBrowser", ctx);
    return { r: await fn(ctx.__opts || {}), lines, opened };
  }
  let c6 = await runComfy({});
  ok(c6.r.ok === true && c6.opened[0] === "http://127.0.0.1:8188/",
    "后端在跑 → 直接开浏览器（得到 " + show(c6.opened) + "）");
  c6 = await runComfy({ probeComfy: async () => false, __opts: {} });
  ok(c6.r.ok === false && c6.r.error === "backend_not_running" && !c6.opened.length,
    "后端没跑且没要 start → 报 backend_not_running，不开一个打不开的链接（得到 " + show(c6.r) + "）");
  ok(/http:\/\/127\.0\.0\.1:8188\/$/.test(c6.r.url || ""), "失败回执也带上 url，界面能告诉用户为什么");
  c6 = await runComfy({ probeComfy: async () => false, __opts: { start: true } });
  ok(c6.r.ok === true && c6.opened.length === 1,
    "点「启动并打开」→ 先拉起后端再开（得到 " + show(c6.r) + "）");
  c6 = await runComfy({
    probeComfy: async () => false,
    startBackend: async () => ({ ok: false, error: "no_venv" }),
    __opts: { start: true },
  });
  ok(c6.r.ok === false && c6.r.error === "start_failed" && c6.r.message === "no_venv" && !c6.opened.length,
    "后端起不来 → 把原因回给界面，且绝不开浏览器（得到 " + show(c6.r) + "）");

  /* ── [7] 内置默认链不得被当成自建工作流（「工作流不存在（id=wf_…）」根因）── */
  const nodesJs = read("renderer/app-nodes.js");
  const buildSrc = grab(nodesJs, /function buildVideoGenRunParams\(node, ctx\) \{/, /\r?\n\}\r?\n/, "buildVideoGenRunParams");
  const builtinAt = buildSrc.lastIndexOf("return {");
  const builtinBranch = builtinAt >= 0 ? buildSrc.slice(builtinAt) : "";
  ok(/customWorkflowId: ""/.test(builtinBranch) && /canvasWorkflowId:/.test(builtinBranch),
    "内置链下发的 customWorkflowId 恒为空，画布 id 另走 canvasWorkflowId");
  ok(!/workflowId: \(S\.wf && S\.wf\.id\)/.test(buildSrc),
    "buildVideoGenRunParams 里再没有把画布 id 塞进 workflowId 的写法");
  const resolveSrc = grab(mainJs, /function resolveCustomWorkflowId\(params\) \{/, /\r?\n\}\r?\n/, "resolveCustomWorkflowId");
  const rctx = vm.runInNewContext(resolveSrc + "; resolveCustomWorkflowId", {
    String,
    workflowStore: () => ({ get: (id) => (id === "wf_lib_real" ? { id } : null) }),
  });
  ok(rctx({ customWorkflowId: "", canvasWorkflowId: "wf_mtjt9bmr", workflowId: "wf_mtjt9bmr" }) === "",
    "老载荷把画布 id 放 workflowId 上 → 库里查不到就当没选，照走内置链");
  ok(rctx({ customWorkflowId: "wf_lib_real" }) === "wf_lib_real", "自建 id 正常识别");
  ok(rctx({ workflowId: "wf_lib_real" }) === "wf_lib_real", "老载荷里真在库里的 id 仍按自建走（不弄坏已有节点）");
  ok(/if \(customWfId\) \{[\s\S]*customWorkflowMissingMessage/.test(mainJs) &&
    /canvasWorkflowId/.test(mainJs),
    "库里真没有该条目时才报「自建工作流不存在」，并给出可选项");

  /* ── [8] Sage Attention：自检判据、选轮子规则、一键补装（真函数实跑）───
   * 现场：插件报 `sageattention missing → sageMode=disabled`，实测确实缺 —— 但缺的不止它：
   * sageattention 的 core 在 import 期就拉 Triton kernel，而 Windows 上 PyPI 没有 triton，
   * 所以「只装 sageattention」同样是坏包。旧判据只看 `import sageattention`，缺包时用户也只能
   * 自己翻 GitHub 挑 wheel。现在：探测同时看 triton + sage + 架构；管理窗多一个「Sage 加速」键
   * （先自检、确认可补才装、装完按同一口径复检）；「安装」这条主路也把加速包列进步骤。 */
  console.log("\n[8] Sage Attention 自检 / 一键补装（venv 与 pip 用替身，选轮子跑真函数）");
  const sageConsts = (
    mainJs.match(/const SAGE_PROBE_TTL_MS[\s\S]*?const SAGE_SMOKE_PY =[\s\S]*?;\r?\n/) || [""]
  )[0];
  ok(/const SAGE_WHEEL_RE =/.test(sageConsts) && /const TORCH_TRITON =/.test(sageConsts) && /const SAGE_PROBE_PY =/.test(sageConsts),
    "抓到 Sage 常量段（轮子文件名规则 + torch↔triton 配套表 + 探测脚本）");
  const sageFns = [
    "vparts", "vcmp", "pickSageWheel", "tritonWindowsSpec", "isSageDisabledMode",
    "sageMissingHint", "pipFailTail", "parseSageProbe", "sageProbeFresh", "runSageProbe",
    "ensureSageProbe", "readSageProbe", "invalidateSageProbe", "comfyVenvPython", "runVenvPy",
    "runVenvPip", "resolveSageModeForGenerate", "installSageAttention",
  ];
  const sageSrc = sageFns
    .map((n) => grab(mainJs, new RegExp("(async )?function " + n + "\\("), /\r?\n\}\r?\n/, n))
    .join("\n");
  function makeSageHost(o, reuse) {
    const st = Object.assign(
      { py: "3.10", torch: "2.9.1+cu130", cuda: "13.0", sm: "sm89", triton: "", sage: "", hasVenv: true, backendUp: false },
      o || {},
    );
    const calls = { pips: [], venvPy: [], fetch: [], wrote: [] };
    const probeJson = () => {
      const why = [];
      if (!st.triton) why.push("triton:ModuleNotFoundError");
      if (!st.sage) why.push("sage:ModuleNotFoundError");
      return JSON.stringify({
        py: st.py, torch: st.torch, cuda: st.cuda, sm: st.sm, triton: st.triton, sage: st.sage,
        archOk: true, why: why.join(","), ok: !why.length,
      });
    };
    const EE = require("events").EventEmitter;
    const spawn = (_cmd, args) => {
      const child = new EE();
      child.stdout = new EE();
      child.stderr = new EE();
      const code = args[0] === "-m" ? "" : String(args[1] || "");
      setImmediate(() => {
        if (args[0] === "-m") {
          const spec = args[args.length - 1];
          calls.pips.push(args.slice(3).join(" "));
          if (/triton/.test(spec)) st.triton = "3.5.1";
          if (/\.whl$/.test(spec)) st.sage = "2.2.0+cu130torch2.9.1";
          child.stdout.emit("data", Buffer.from("Successfully installed " + spec + "\n"));
          child.emit("close", 0);
        } else if (/sageattn\(q/.test(code)) {
          child.stdout.emit("data", Buffer.from(JSON.stringify(st.kernel || { ok: true, why: "" }) + "\n"));
          child.emit("close", 0);
        } else {
          calls.venvPy.push(code.slice(0, 24));
          child.stdout.emit("data", Buffer.from((st.brokenProbe ? "not json at all" : probeJson()) + "\n"));
          child.emit("close", st.brokenProbe ? 1 : 0);
        }
      });
      return child;
    };
    const RELEASES = [
      {
        tag_name: "v2.2.0-windows.post6",
        assets: [
          "sageattention-2.2.0+cu128torch2.9.1.post6-cp310-abi3-win_amd64.whl",
          "sageattention-2.2.0+cu130torch2.10.0andhigher.post6-cp310-abi3-win_amd64.whl",
          "sageattention-2.2.0+cu130torch2.9.1.post6-cp310-abi3-win_amd64.whl",
        ].map((name) => ({ name, browser_download_url: "https://gh.invalid/" + name })),
      },
    ];
    const fetchBuffer = async (url) => {
      calls.fetch.push(url);
      if (url.indexOf("api.github.com") >= 0) {
        if (st.noNetwork) throw new Error("getaddrinfo ENOTFOUND api.github.com");
        return Buffer.from(JSON.stringify(RELEASES));
      }
      if (st.noNetwork) throw new Error("ETIMEDOUT");
      return Buffer.from("FAKE-WHEEL-BYTES");
    };
    const sb = reuse || {
      Number, String, Math, Array, Object, JSON, RegExp, Promise, Error, Buffer, Date, setTimeout, setImmediate,
      process: { env: {} },
    };
    Object.assign(sb, {
      fs: { existsSync: () => st.hasVenv, writeFileSync: (p, b) => calls.wrote.push([p, b.length]) },
      join: (...a) => require("path").join(...a),
      mk: (p) => p,
      app: { getPath: () => require("os").tmpdir() },
      spawn,
      execFile: () => {},
      loadConfig: () => ({ installDir: "E:/mtnode-plugins/video" }),
      isSafeInstallDir: (d) => ({ ok: true, path: d }),
      backendRunning: () => st.backendUp,
      emitProgress: (ev) => (calls.progress = (calls.progress || []).concat(ev)),
      appendConsole: (s) => (calls.log = (calls.log || []).concat(String(s))),
      broadcast: (ch, p) => (calls.bc = (calls.bc || []).concat([[ch, p]])),
      fetchBuffer,
      comfyVenvPython: () => (st.hasVenv ? "E:/venv/Scripts/python.exe" : ""),
      /* 报错总线的宿主包装（本轮把各失败出口接进 plugin-error-repair.js）：
         抽出来的片段会调它，沙箱不给桩就是 ReferenceError */
      reportErr: (code, msg, extra) =>
        (calls.err = (calls.err || []).concat([[code, msg, extra]])),
    });
    const exposed = vm.runInNewContext(
      "let installing = false; let installCancel = false; let _sageProbe = null; let _sageProbeRun = null; let _sageProbeDir = \"\";\n" + sageConsts + "\n" + sageSrc +
        "\n; ({ installSageAttention, resolveSageModeForGenerate, readSageProbe, ensureSageProbe, invalidateSageProbe, pickSageWheel, tritonWindowsSpec, sageMissingHint, vparts })",
      sb,
      { filename: "h3-sage-extract" },
    );
    return Object.assign(sb, exposed, { st, calls, probeJson });
  }

  /* 选轮子规则：拿真实发布过的文件名当夹具逐条钉（这些文件名差一个字符就是装坏一台机器） */
  const REL_FIX = [
    {
      tag_name: "v2.2.0-windows.post6",
      assets: [
        "sageattention-2.2.0+cu128torch2.10.0andhigher.post6-cp310-abi3-win_amd64.whl",
        "sageattention-2.2.0+cu128torch2.9.1.post6-cp310-abi3-win_amd64.whl",
        "sageattention-2.2.0+cu130torch2.10.0andhigher.post6-cp310-abi3-win_amd64.whl",
        "sageattention-2.2.0+cu130torch2.9.1.post6-cp310-abi3-win_amd64.whl",
      ].map((name) => ({ name, browser_download_url: "https://gh.invalid/" + name })),
    },
    {
      tag_name: "v2.2.0-windows.post4",
      assets: ["sageattention-2.2.0+cu130torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl"].map((name) => ({
        name,
        browser_download_url: "https://gh.invalid/" + name,
      })),
    },
    {
      tag_name: "v2.1.1-windows",
      assets: [
        "sageattention-2.1.1+cu124torch2.5.1-cp310-cp310-win_amd64.whl",
        "sageattention-2.1.1+cu128torch2.8.0-cp313-cp313-win_amd64.whl",
      ].map((name) => ({ name, browser_download_url: "https://gh.invalid/" + name })),
    },
  ];
  const host0 = makeSageHost({});
  const pick = (w) => {
    const p = host0.pickSageWheel(REL_FIX, w);
    return p ? p.file : null;
  };
  /* 本机实测组合：Python 3.10.16 + torch 2.9.1+cu130 + RTX 4090（sm89） */
  ok(
    pick({ pyMinor: 10, torch: [2, 9, 1], cudaMajor: 13 }) ===
      "sageattention-2.2.0+cu130torch2.9.1.post6-cp310-abi3-win_amd64.whl",
    "本机组合 → 精确同 minor 的 cu130 轮子（得到 " + show(pick({ pyMinor: 10, torch: [2, 9, 1], cudaMajor: 13 })) + "）",
  );
  ok(
    pick({ pyMinor: 10, torch: [2, 9, 1], cudaMajor: 12 }) ===
      "sageattention-2.2.0+cu128torch2.9.1.post6-cp310-abi3-win_amd64.whl",
    "CUDA 大版本不通用：cu130 的机器绝不拿 cu128 轮子（反之亦然）",
  );
  ok(
    pick({ pyMinor: 13, torch: [2, 9, 1], cudaMajor: 13 }) ===
      "sageattention-2.2.0+cu130torch2.9.1.post6-cp310-abi3-win_amd64.whl",
    "abi3 是下限不是等号：Python 3.13 可以吃 cp310-abi3",
  );
  ok(
    pick({ pyMinor: 9, torch: [2, 9, 1], cudaMajor: 13 }) ===
      "sageattention-2.2.0+cu130torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl",
    "Python 3.9 只接受 cp39-abi3，不会拿 cp310-abi3（得到 " + show(pick({ pyMinor: 9, torch: [2, 9, 1], cudaMajor: 13 })) + "）",
  );
  ok(
    pick({ pyMinor: 10, torch: [2, 10, 0], cudaMajor: 13 }) ===
      "sageattention-2.2.0+cu130torch2.10.0andhigher.post6-cp310-abi3-win_amd64.whl",
    "andhigher 轮子在 torch ≥ 标注值时可用，且优先给精确同 minor 让路",
  );
  ok(
    pick({ pyMinor: 10, torch: [2, 8, 0], cudaMajor: 13 }) === null,
    "torch 比轮子标注更旧 → 宁可不装（拿 2.9 编的轮子装到 2.8 上必炸）",
  );
  ok(
    pick({ pyMinor: 12, torch: [2, 8, 0], cudaMajor: 12 }) === null,
    "老的非 abi3 轮子必须精确同 Python minor（py3.12 不接 cp310-cp310 / cp313-cp313）",
  );
  ok(host0.pickSageWheel([], { pyMinor: 10, torch: [2, 9, 1], cudaMajor: 13 }) === null,
    "release 列表为空 → null（上层据此给出兜底指引，不瞎装）");
  ok(host0.pickSageWheel([{ tag_name: "x", assets: null }], { pyMinor: 10 }) === null, "资产缺失不炸");

  /* 生成期口径：探测说不可用 → 一定 disabled；说可用 → 原样把模式交回去 */
  let h8 = makeSageHost({});
  h8.invalidateSageProbe();
  let m8 = await h8.resolveSageModeForGenerate("auto", "E:/x", true);
  ok(m8 === "disabled", "探测不可用 → sageMode 强制 disabled（不带 PathchSageAttentionKJ 去炸 /prompt 校验）");
  ok(/sageattention missing/.test(h8.calls.log.join("\n")), "缺包时 console 仍留同一句可 grep 的口径");
  ok(/缺 triton-windows \+ sageattention/.test(h8.calls.log.join("\n")) && /Sage 加速/.test(h8.calls.log.join("\n")),
    "缺包日志点名两个包并指向「Sage 加速」这一键（得到 " + show(h8.calls.log.join("\n").slice(0, 150)) + "）");
  h8 = makeSageHost({ triton: "3.5.1", sage: "2.2.0" });
  h8.invalidateSageProbe();
  ok((await h8.resolveSageModeForGenerate("auto", "E:/x", true)) === "auto", "已装齐 → 保持 auto，不打扰日志");
  ok((await makeSageHost({ hasVenv: false }).resolveSageModeForGenerate("auto", "E:/x", true)) === "disabled",
    "没有 venv → disabled（照旧）");
  ok((await makeSageHost({}).resolveSageModeForGenerate("disabled", "E:/x", true)) === "disabled",
    "用户本来关了 Sage → 连探测都省了");

  /* 一键补装真函数：缺包 → 装 triton → 挑轮子 → 装 wheel → 复检；已就绪 → 一次 pip 都不发 */
  h8 = makeSageHost({});
  let r8 = await h8.installSageAttention({});
  ok(r8.ok === true && /Sage 加速已装好/.test(r8.message || ""), "缺包 → 补装成功并回执版本号（得到 " + show(r8.message) + "）");
  ok(h8.calls.pips.length === 2, "只发两次 pip（triton + wheel），不重复写盘（得到 " + show(h8.calls.pips) + "）");
  ok(h8.calls.pips[0] === "--isolated triton-windows==3.5.*", "torch 2.9 → triton-windows==3.5.*（得到 " + show(h8.calls.pips[0]) + "）");
  ok(/--no-deps --force-reinstall .*sageattention-2\.2\.0\+cu130torch2\.9\.1\.post6-cp310-abi3-win_amd64\.whl$/.test(h8.calls.pips[1]),
    "本机组合挑中 cu130 + torch2.9.1 + cp310-abi3 那枚轮子（得到 " + show(h8.calls.pips[1]) + "）");
  ok(r8.sage && r8.sage.ok === true && r8.kernelOk === true, "装完按生成期同一口径复检通过（含小 kernel 试跑）");
  ok(h8.calls.wrote.length === 1 && /\.whl$/.test(h8.calls.wrote[0][0]), "轮子先落到临时目录再交给 pip（不落进 venv 旁边）");
  ok(/--force-reinstall/.test(h8.calls.pips[1]), "wheel 用 --force-reinstall：老的 1.0.6 之类残留一定被换掉");
  ok((h8.calls.bc || []).length >= 2 && (h8.calls.bc || []).every((c) => c[0] === "h3:sageChanged"),
    "自检每有结果就广播一次 h3:sageChanged（管理窗那一行不用等下一次轮询，共 " + (h8.calls.bc || []).length + " 次）");

  ok(/if \(installing\) return \{ ok: false, error: "busy"/.test(mainJs),
    "补装与「安装 / 自我修复」共用一把 installing 锁（同一时刻只有一条路在写 venv）");

  h8 = makeSageHost({ triton: "3.5.1", sage: "2.2.0" });
  r8 = await h8.installSageAttention({});
  ok(r8.ok === true && r8.already === true && h8.calls.pips.length === 0,
    "已就绪时再点一次只回执，不 pip 不动 venv（得到 " + show(r8.message) + "）");

  h8 = makeSageHost({ backendUp: true });
  r8 = await h8.installSageAttention({});
  ok(r8.ok === false && r8.error === "backend_running" && h8.calls.pips.length === 0,
    "后端在跑 → 拒绝往用着的 venv 里写包（得到 " + show(r8.error) + "）");

  h8 = makeSageHost({ hasVenv: false });
  r8 = await h8.installSageAttention({});
  ok(r8.ok === false && r8.error === "no_venv" && /安装/.test(r8.message), "没有 venv → 指回「安装」这条主路");

  h8 = makeSageHost({ noNetwork: true });
  r8 = await h8.installSageAttention({});
  ok(r8.ok === false && /自我修复/.test(r8.message || ""), "GitHub 不通 → 失败原因里给出「自我修复」兜底（得到 " + show(r8.message) + "）");
  ok(
    (h8.calls.err || []).some(([code, , extra]) => code === "sage_install_failed" && extra && extra.phase === "install"),
    "补装 Sage 失败也上报报错总线（跨窗可见：主窗口那份错误报告就是它弹的）",
  );

  h8 = makeSageHost({ torch: "2.8.0+cu130" });
  r8 = await h8.installSageAttention({});
  ok(r8.ok === false && /没找到匹配/.test(r8.message || ""),
    "没有配套轮子（torch 2.8 + cu130）→ 宁可不装也不塞错的轮子（得到 " + show(r8.message) + "）");

  h8 = makeSageHost({ py: "3.13" });
  r8 = await h8.installSageAttention({});
  ok(r8.ok === true, "Python 3.13 走 cp310-abi3 稳定 ABI 轮子（abi3 只表示下限）");

  h8 = makeSageHost({ kernel: { ok: false, why: "RuntimeError: no kernels" } });
  r8 = await h8.installSageAttention({});
  ok(r8.ok === true && r8.kernelOk === false && /kernel smoke warn/.test(h8.calls.log.join("\n")),
    "kernel 试跑警告不判失败，但一定写进 console（能 import ≠ 能算）");
  ok(h8.probeJson && /"ok":true/.test(h8.probeJson()), "补装后 venv 替身状态确实是装上了的");

  /* 探测缓存：状态刷新 4 秒一次，绝不能每次都去 import 一遍 torch */
  h8 = makeSageHost({ triton: "3.5.1", sage: "2.2.0" });
  await h8.ensureSageProbe("E:/dir-a");
  const nProbe = h8.calls.venvPy.length;
  await h8.ensureSageProbe("E:/dir-a");
  await h8.ensureSageProbe("E:/dir-a");
  ok(nProbe === 1 && h8.calls.venvPy.length === 1,
    "同目录 10 分钟内只真探一次（得到 " + h8.calls.venvPy.length + " 次 python 调用）");
  await h8.ensureSageProbe("E:/dir-b");
  ok(h8.calls.venvPy.length === 2,
    "换安装目录 = 换 venv → 旧目录「已装齐」的结论立刻作废，重探新目录（得到 " + h8.calls.venvPy.length + " 次）");
  h8.invalidateSageProbe();
  ok(h8.readSageProbe("E:/dir-b").probed === false, "readSageProbe 只读缓存：没探过就说在检测中，不阻塞状态刷新");

  /* 接线：宿主 IPC / 桥 / 界面控件 / 状态字段一个都不能少 */
  ok(/ipcMain\.handle\("h3:installSage"/.test(mainJs), "h3:installSage IPC 已挂");
  ok(/broadcast\("h3:sageChanged"/.test(mainJs), "探测结果变化会广播（管理窗立刻刷新那一行，不等 4 秒轮询）");
  ok(/sage: readSageProbe\(cfg\.installDir\)/.test(mainJs), "getStatus 带 sage（读缓存，绝不在状态刷新里等 python import）");
  const preloadJs2 = read("h3/preload-h3.js");
  ok(/installSage: \(opts\) => ipcRenderer\.invoke\("h3:installSage"/.test(preloadJs2), "preload 把补装能力桥给管理窗");
  ok(/onSage:/.test(preloadJs2) && /h3:sageChanged/.test(preloadJs2), "preload 有 onSage 订阅 h3:sageChanged");
  ok(/id="btnSage"/.test(html) && /Sage 加速<\/button>/.test(html), "管理窗有「Sage 加速」按钮（自检 + 缺则补装）");
  ok(/id="sageInfo"/.test(html), "有一行 Sage 状态文案位");
  ok(/renderSage\(st\)/.test(uiJs) && /function renderSage\(st\) \{/.test(uiJs), "refresh 每次都渲染 Sage 状态");
  ok(/api\.installSage\(\{\}\)/.test(uiJs) && /api\.onSage/.test(uiJs), "点了真调宿主补装，探完自动刷新");
  ok(/if \(backendRunning\(\)\)/.test(sageSrc) || /backendRunning\(\)/.test(mainJs), "补装前有 backendRunning 守卫");
  /* 「安装」这条主路必须也覆盖加速包（不然装完还是缺，等于没修）
     要件清单本轮重排过编号（补了南风包 / soundfile / latent 占位 / 后处理权重）→
     只钉「注意力加速在 requirements 里」与「装不上不判失败」，不再钉死编号。 */
  const REQ_BLOCK = (() => {
    const i = mainJs.indexOf("const requirements = [");
    return i < 0 ? "" : mainJs.slice(i, mainJs.indexOf("].join", i));
  })();
  ok(/注意力加速/.test(REQ_BLOCK), "Agent 安装 prompt 的交付要件覆盖 Sage（「安装」这条主路必须含加速包）");
  ok(/装不上不算失败|不判安装失败|不判安装成功与否/.test(mainJs), "同时写明装不上不判安装失败（缺包只慢不坏）");
  for (const rel of ["skills/minimax-h3-install/SKILL.md"]) {
    const sk = read(rel);
    ok(/可选依赖：Sage Attention/.test(sk) && /woct0rdho\/SageAttention\/releases/.test(sk) && /两个包必须成对/.test(sk),
      rel + " 写了 Sage 的成对安装口径与轮子来源");
  }
  ok(/SAGE_PROBE_PY[\s\S]{0,1800}import triton[\s\S]{0,900}import sageattention[\s\S]{0,500}archOk/.test(mainJs),
    "探测脚本一次看全 triton / sageattention / CUDA 架构（不再只 import sageattention）");

  console.log("\n" + (fails ? "✗ " + fails + "/" + checks + " 条失败" : "✓ " + checks + " 条全过"));
  process.exit(fails ? 1 : 0);
})();

"use strict";
/* ══════════════════════════════════════════════════════════════════════
 * 长周期任务 · 条带 UI（画布 tabs 与顶部菜单条之间的细线 handler）
 * ----------------------------------------------------------------------
 * 收起 = 一根 6px 细线（hover 高亮）；下拉 = tabs 与画布整体被推到下方，上方这块
 * 就是**状态机编辑器 + 实时可视化**（共识 q2 / q36）。细线挂在面板**下沿**，它就是
 * 长任务区与画布页签的分界线：往下拖，线跟着鼠标的 y 走，tabs 与画布一同下沉，一路可以
 * 拖到 tabs 贴住 .wf-wrap 下沿（画布被压成 0 高）为止；
 * 上限按此刻窗口实测（ltClampH / ltBodyMaxH），绝不把 tabs / 画布 / 底部状态栏顶出窗外
 * —— 拖出去就收不回来的坑见下面 ltSetOpen / ltBodyMaxH 的注释：
 *   · 图编辑（摆节点、连线、改条件、就地改参数）与运行态可视化在同一块区域，
 *     跑起来时节点按 8 态上色，running / waiting / blocked 走呼吸灯；
 *   · 画布没绑定长任务时，这块区域直接给「新建长任务」的引导（需求 4 末句）。
 * 视觉与 MTNode 节点同源：复用 .wf-node 的投影变量与 base.css 的 --panel2/--bd2/
 * --cyan/--orange/--green/--red/--yellow，呼吸灯沿用 devRunBreathe 那套写法。
 *
 * 本文件只做界面；状态机、记忆、交付目录的真源全在 app-longtask.js（window.LT）。
 * ══════════════════════════════════════════════════════════════════════ */

let LT_UI = null; /* { strip, grip, body, head, canvas, ... } */
let ltSel = { path: "", edge: "" }; /* 条带里选中的图节点 / 边（按当前下钻层） */
let ltDrill = []; /* 下钻栈：[{prefix, title}] */
let ltDrag = null; /* 图编辑器内的临时拖拽状态 */
let ltGripDrag = null; /* 细线拖拽中的唯一状态源（挂模块级：ResizeObserver 要判它有没有在拖） */
let ltWrapRO = null; /* 观察 .wf-wrap 尺寸：窗口一矮就把条带高度重夹回来 */

/* ── 未提交输入的草稿：整块重绘不能把用户写了一半的话抹掉 ──────────────
 * ltRenderStrip() 会走 ltRenderMain 重建右栏（整块重建那条路是 main.innerHTML = ""，焦点
 * 落在栏内输入里时改为只重建另一栏，见 ltFocusCol / ltRenderMain）：长任务在跑时每次
 * 环节状态变化（ltTouchGraph）都会重绘一次，而审批卡里的理由框只是 DOM 里的一段 value，
 * 重绘后就被新的一只空 textarea 换掉 —— 写了一半的驳回理由当场消失。
 * 口径：输入只增不减地记在草稿表里（key = 环节 path + 字段名），重绘按 key 还原；
 * 只有「已提交」（通过 / 驳回）才清掉，避免下一条待办卡误带上上一条的理由。
 * 切画布时整表清空（评审结论只对当前画布的这一条 run 有意义）。 */
const LT_DRAFTS = Object.create(null);
function ltDraftGet(key) {
  const v = LT_DRAFTS[key];
  return typeof v === "string" ? v : "";
}
function ltDraftSet(key, val) {
  if (key) LT_DRAFTS[key] = String(val == null ? "" : val);
}
function ltDraftClear(key) {
  if (key) delete LT_DRAFTS[key];
}
/* 草稿键：环路径 + 字段名（同一条 run 里两个待办环节的理由框互不串台）。
   为空 path 时给一个兜底键——宁可所有无路径卡片共用一格，也不写成 "undefined:why"。 */
function ltDraftKey(path, field) {
  return String(path || "-") + ":" + String(field || "");
}
/* 把草稿绑回一只输入控件：先还原（重绘后的新控件立刻带回用户写过的话），
   再持续把编辑结果写进草稿表（下次重绘才有的可还原）。 */
function ltDraftBind(el, key) {
  if (!el || !key) return el;
  const v = ltDraftGet(key);
  if (v) el.value = v;
  el.oninput = () => ltDraftSet(key, el.value);
  return el;
}

/* ── 用户手动拖高的多行框：高度也得像草稿一样活过重建 ──────────────────
 * 症状（本需求）：条带右栏「目标 / 说明」这类 textarea 上，用户拖右下角的原生缩放手柄
 * 把框拉高，一松手（或长任务一跑）又缩回原样 —— 因为 `resize: vertical` 把高度只写在
 * 元素的 inline style 上，而右栏在运行期会被 ltRenderStrip() 整块重建（焦点 / 框选 / 按住
 * 三条保护只管「这一帧不重建」，用户一点别处就放行），新长出来的 textarea 自然回到默认高度。
 * 口径与上面的草稿表同源：**只增不减**地按稳定 key 记高度，重建时按 key 还原；
 * key 取「环节 path + 字段名」（ltDraftKey 那套），同一条 run 的同一格永远命中同一条记录。
 * 默认高度落在 CSS 变量 --lt-ta-h 上（见 css/longtask.css 的 .lt-in）：只设 min-height，
 * 不设 height —— 拖高 / 拖矮照旧是原生行为，只是这一次的结果会被记住。 */
const LT_TA_H = Object.create(null); /* key → 手动高度（px） */
function ltTaH(key) {
  const h = key ? Number(LT_TA_H[key]) : 0;
  return h > 0 ? Math.round(h) : 0;
}
/* 此刻这只框的实际高度（量不到返回 0 = 不记，兼容迷你 DOM 的回归沙箱） */
function ltTaHNow(el) {
  try {
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const h = Math.round((r && r.height) || (el && el.offsetHeight) || 0);
    return h > 0 ? h : 0;
  } catch (_) {
    return 0;
  }
}
/* 记下这只框的高度（key 为空就按它自己的 data 标找） */
function ltTaHSet(el, key) {
  const k = String(key || (el && el.getAttribute && el.getAttribute("data-lt-hk")) || "");
  if (!k) return 0;
  const h = ltTaHNow(el);
  if (h > 0) LT_TA_H[k] = h;
  return h;
}
/* 把记下的高度贴回这只框（新建 / 重建时调一次） */
function ltTaHApply(el, key) {
  const h = ltTaH(key);
  if (!el || !h) return el;
  try {
    if (el.style) el.style.height = h + "px";
  } catch (_) {}
  return el;
}
/* 拖高捕获：只在「右下角那一小块 = 原生缩放手柄」上按下时才做得起来，
   并 setPointerCapture —— 指针拖出框外（缩放手柄自己也跟着走）时 pointerup 仍回到这只框，
   于是「松手即记账」不会漏。框内普通点按 / 框选一律不记，不打扰原生行为。 */
function ltTaHBind(el, key) {
  if (!el || !key) return el;
  try {
    if (el.setAttribute) el.setAttribute("data-lt-hk", String(key));
  } catch (_) {}
  let grip = false; /* 这一次按下是不是落在缩放角上 */
  el.addEventListener("pointerdown", (ev) => {
    grip = false;
    try {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || !r.width) return;
      const dx = Number(ev.clientX) - Number(r.right);
      const dy = Number(ev.clientY) - Number(r.bottom);
      if (dx < -18 || dy < -18) return; /* 不在右下角 → 不是拖高 */
      grip = true;
      if (el.setPointerCapture) el.setPointerCapture(ev.pointerId);
    } catch (_) {}
  });
  const done = () => {
    if (!grip) return;
    grip = false;
    ltTaHSet(el, key);
  };
  el.addEventListener("pointerup", done);
  el.addEventListener("pointercancel", done);
  /* 键盘路径（聚焦后按方向键的浏览器差异 / 无指针环境）：失焦时也记一次，
     高度没变也照记 —— 值就是用户当下定的那一份，重建后还原的仍是它。 */
  el.addEventListener("blur", () => ltTaHSet(el, key));
  return el;
}

/* ── 焦点保护：正在输入的那一栏，重绘时原样留下 ─────────────────────────
 * ltRenderStrip() → ltRenderMain() 原来一律 main.innerHTML = ""，把左右两栏一起重建。
 * 而长任务跑着的时候这条重绘非常密：Agent 每来一段流式正文（app-longtask.js 的 onEvent
 * 逐帧调 ltRenderStripSoon）、每步状态变化、每次自动收线都会叫一次，节流后仍是 ~90ms 一次。
 * 用户在右栏写审批理由 / 改环节参数时，每 ~90ms 就被换掉一只空控件 —— 表现为「打字打一半
 * 就失焦」；中文输入法更是连组合态一起被打断（LT_DRAFTS 只保得住已经落进 value 的字，
 * 保不住光标、选区与组合态）。而失焦之后紧接着敲下的 J / K / L / 空格 / 1 / 2 / 3 会被
 * 顶栏快捷键收走（app-keys.js 只在「焦点确实还在可编辑元素里」时让位），看上去就像
 * 「菜单快捷键把焦点抢走了」—— 快捷键只是症状，不是起因。
 * 口径：重绘按栏做 —— 焦点落在哪一栏的**文本输入**里，那一栏的 DOM 原地留在文档里（不摘出来，
 * 焦点 / 选区 / 输入法组合态都不动），只重建另一栏；焦点离开这一栏（focusout）再补一次完整
 * 重绘，运行态的更新一条都不丢。只认「正在打字」的控件（见 ltEditHost 的取舍说明）：
 * 下拉 / 复选框不是打字，它们的 change 就是一次提交，提交后必须当场重建。
 * 顺带保住第二件事：点栏内按钮时焦点会先落到按钮上（Windows 上 mousedown 就移焦点），
 * 若此刻把那一栏拆掉，button 收不到 mouseup/click —— 补重绘的判据因此用 ltFocusInside
 * （焦点还在栏内任何元素上就再等一等），不是在焦点变成非输入控件时立刻动手。
 * 「只认正在打字的控件」这条口径本轮又放宽了一步：**正在框选 / 鼠标正按在栏里**的那一栏
 * 同样不许重建（原因与两条新判据见下面「选区 / 按住保护」那一段）。 */
const LT_TEXT_INPUT_TYPES = ["", "text", "search", "url", "email", "password", "tel", "number"];
function ltEditHost(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = String(el.tagName || "").toLowerCase();
  /* textarea / 富文本：一律算「正在打字」 */
  if (tag === "textarea") return el;
  /* <input> 只认文本型：checkbox / radio / button 不是打字（它们 onchange 就是提交，
     提交后必须立刻重建，比如勾选「允许读取画布」要当场把下面的提示刷对）。 */
  if (tag === "input") {
    const t = String(el.type || "text").toLowerCase();
    return LT_TEXT_INPUT_TYPES.indexOf(t) >= 0 ? el : null;
  }
  if (el.isContentEditable) return el;
  try {
    return el.closest ? el.closest('[contenteditable="true"],[contenteditable=""],[role="textbox"]') : null;
  } catch (_) {
    return null;
  }
}
/* 取 main 下某一栏：走 children 一遍，不用 :scope 选择器（迷你 DOM 沙箱也认） */
function ltColOf(main, cls) {
  for (const c of Array.from((main && main.children) || [])) {
    if (c && c.classList && c.classList.contains(cls)) return c;
  }
  return null;
}
/* 焦点是否落在这一栏的「文本输入」里（拦重绘的判据，取舍见 ltEditHost） */
function ltFocusCol(col) {
  if (!col || !col.contains || typeof document === "undefined") return false;
  let ae = null;
  try {
    ae = document.activeElement;
  } catch (_) {
    return false;
  }
  if (!ae || ae === document.body || ae === document.documentElement) return false;
  return col.contains(ae) && !!ltEditHost(ae);
}
/* 焦点是否还留在这一栏里的**任何**元素上（含按钮）：补那一次重绘的判据用它 ——
   只要焦点还在栏内就再等一等，免得把用户正按着的栏内按钮在 mouseup 之前拆掉（click 会丢）。 */
function ltFocusInside(col) {
  if (!col || !col.contains || typeof document === "undefined") return false;
  let ae = null;
  try {
    ae = document.activeElement;
  } catch (_) {
    return false;
  }
  return !!(ae && ae !== document.body && ae !== document.documentElement && col.contains(ae));
}
/* ── 选区 / 按住保护（本次需求）：正在框选的那一栏，重绘同样不许动 ──────────
 * 前一版只拦住「焦点在文本输入里」（ltFocusCol）：打字与输入法组合态不被打断了，但
 * **框选**（按下鼠标拖过一段文字再松手）还有两条路会被 ~90ms 一次的重绘掐掉 ——
 * 表现正是「长任务画布频繁更新 → 右侧输入框框选后立刻 defocus，选区闪一下就没了」：
 *   ① 拖选一段**非控件**文字（右栏的检查器只读正文 / 待办卡提示 / 图说明 / 历史轮次…）：
 *      焦点根本不在可编辑元素里，ltFocusCol 判不出来；重绘走 main.innerHTML = ""，
 *      被选中的那些节点整体被换掉，浏览器只能把选区一起收掉；
 *   ② 拖动**刚起手**、选区还没成形时（mousedown → 第一次 mousemove 之间）来一次重绘：
 *      mousedown 的落点节点被换掉，浏览器这一次的拖拽选手势当场作废 —— 整段都选不出来。
 * 口径：除了「焦点在文本输入里」，再加两条判据（见 ltColHold）——
 *   ① 这一栏里有**活的选区**：未折叠的原生选区，锚点 / 焦点落在栏内（ltSelInCol）；
 *   ② 鼠标正**按在**这一栏的非控件内容上：从按下列松手之间不重建（ltHoldColEl；
 *      只对右栏生效 —— 左栏点节点要靠那次重绘换选中高亮，理由写在 ltHoldArm 里）。
 * 控件里只有「按一下就当场提交」的那几种不参与第 ② 条（原生 select / 按钮 / 链接 /
 * 勾选型 input）—— 它们的 change 就是一次提交，提交后必须当场重建（勾选「允许读取画布」
 * 要立刻把下面的提示刷对）；文本框 / 富文本照样吃这条保护：它们的内容提交走 change
 * （回车 / 失焦），不发生在这次按下里，推迟到松手再重绘不改变任何语义 ——
 * 换来的是「框选起手那一下也不会被换掉」（本需求报的正是框选被立刻打断）。
 * 松手 / 选区折叠 / 焦点离开后由 ltRenderWhenFocusLeaves 补一次完整重绘，运行态更新不丢。
 * 取舍：选区一直留着时右栏那一片就跟着冻住（头部状态 chip「等你处理 ×N」与细线颜色仍照常刷新，
 * 点一下别处 / Esc 立刻解冻）—— 宁可晚一点刷新，也不把用户刚框住、正要 Ctrl+C 的文字冲掉。 */
function ltSelInCol(col) {
  if (!col || !col.contains || typeof document === "undefined") return false;
  if (typeof document.getSelection !== "function") return false;
  let sel = null;
  try {
    sel = document.getSelection();
  } catch (_) {
    return false;
  }
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  const ends = [sel.anchorNode, sel.focusNode];
  for (const node of ends) {
    if (!node) continue;
    const host = node.nodeType === 1 ? node : node.parentNode;
    if (!host) continue;
    try {
      if (col.contains(host)) return true;
    } catch (_) {}
  }
  return false;
}
/* 鼠标此刻按在的那一栏（null = 没按在两栏里 / 按的是「提交即生效」的控件，取舍见本段说明）：
   文本框 / 富文本**照样记** —— 按下到松手之间不重建，框选的那一下起手（mousedown 落点、
   浏览器刚开始的拖拽选选手势）也不会被换掉；它们的内容提交走 change（回车 / 失焦），
   本来就不在这次按下里，推迟这几百毫秒的重绘不改变任何提交语义。
   真正不记的只有「按一下就当场提交」的控件：原生 select（选完即 change）、按钮 / 链接，
   以及勾选 / 滑块 / 文件型 input（勾选就是提交 —— 勾「允许读取画布」要当场把下面的提示刷对）。 */
let ltHoldColEl = null;
function ltHoldCtrlEl(el) {
  if (!el || el.nodeType !== 1) return null;
  try {
    return el.closest
      ? el.closest(
          'select,button,[role="button"],a[href],input[type="checkbox"],input[type="radio"],input[type="range"],input[type="file"],input[type="submit"],input[type="reset"],input[type="button"]',
        )
      : null;
  } catch (_) {
    return null;
  }
}
function ltHoldArm(target) {
  const main = LT_UI && LT_UI.main;
  ltHoldColEl = null;
  if (!main || !target || target.nodeType !== 1 || ltHoldCtrlEl(target)) return;
  /* 只记**右栏**（检查器 / 人工任务卡 / 图说明那片可选文字）。左栏是 SVG 状态机图：
     它里面没有可选文字（.lt-graph 是 user-select:none），而「点一下节点」的选中态与高亮
     本来就靠 pointerdown 里那次 ltRenderStrip() 落到当下这一帧 —— 按住期间不重绘会让
     选中高亮晚到松手；而节点拖动本身已按 document 级监听 + 每帧重解析活图设计
     （重绘换帧也安全降级，见 ltDragMove 的 domMiss），不吃这条保护也不会断手势。 */
  const right = ltColOf(main, "lt-right");
  if (right && right.contains && right.contains(target)) ltHoldColEl = right;
}
function ltHoldRelease() {
  if (!ltHoldColEl) return;
  ltHoldColEl = null;
  /* 松手 = 这次交互结束：此前被推迟的重绘立刻兑现（不然要等下一次焦点 / 选区变化） */
  ltRenderFlushDeferred();
}
let ltHoldBound = false;
function ltHoldBind() {
  if (ltHoldBound || typeof document === "undefined") return;
  ltHoldBound = true;
  document.addEventListener("pointerdown", (ev) => ltHoldArm(ev && ev.target), true);
  document.addEventListener("pointerup", () => ltHoldRelease(), true);
  document.addEventListener("pointercancel", () => ltHoldRelease(), true);
  /* 窗口失焦（切到别的程序 / 被原生下拉抢走）：按住态不许留成悬挂，否则这一栏再也不更新 */
  try {
    window.addEventListener("blur", () => ltHoldRelease());
  } catch (_) {}
}
/* 这一栏此刻可不可以原地留下（不许重建）：正在打字 / 正在框选 / 鼠标正按在栏里 */
function ltColHold(col) {
  if (!col) return false;
  if (ltFocusCol(col)) return true;
  if (ltSelInCol(col)) return true;
  return !!ltHoldColEl && ltHoldColEl === col;
}
/* 被推迟的那一次重绘：焦点 / 选区 / 按住三者都放开了才补上（只挂一轮监听，不重复挂） */
let ltRenderWait = false;
let ltRenderWaitOff = null; /* 这一轮监听的解绑函数（兑现 / 提前收工时调） */
function ltColHoldNow() {
  const main = LT_UI && LT_UI.main;
  if (!main) return false;
  const l = ltColOf(main, "lt-left");
  const r = ltColOf(main, "lt-right");
  if (ltFocusInside(l) || ltFocusInside(r)) return true;
  if (typeof ltColHold === "function" && (ltColHold(l) || ltColHold(r))) return true;
  return false;
}
function ltRenderFlushDeferred() {
  if (!ltRenderWait) return;
  const off = ltRenderWaitOff;
  ltRenderWaitOff = null;
  ltRenderWait = false;
  if (typeof off === "function") off();
  try {
    ltRenderStrip();
  } catch (_) {}
}
function ltRenderWhenFocusLeaves() {
  if (ltRenderWait || typeof document === "undefined") return;
  ltRenderWait = true;
  const onOut = () => {
    if (typeof ltColHoldNow === "function" && ltColHoldNow()) return;
    ltRenderFlushDeferred();
  };
  const off = () => {
    document.removeEventListener("focusout", onOut, true);
    document.removeEventListener("selectionchange", onOut, true);
    document.removeEventListener("pointerup", onOut, true);
    document.removeEventListener("keyup", onOut, true);
  };
  ltRenderWaitOff = off;
  document.addEventListener("focusout", onOut, true);
  /* 选区是框选保护的第二条命门：折叠（点别处 / Esc）那一刻才知道能重绘了 */
  document.addEventListener("selectionchange", onOut, true);
  /* 松手 / 敲键各补一次判据：只挂 focusout 时，选区收掉了也没人来兑现这次重绘 */
  document.addEventListener("pointerup", onOut, true);
  document.addEventListener("keyup", onOut, true);
}

/* ── 悬停保护（本次需求）：条带重建不许把「鼠标底下那一件」的 hover 弄丢 ──────
 * 症状：长任务一跑起来，条带（头部按钮 / 状态机图节点与端子 / 右栏按钮）里的按钮
 * 高频闪烁 —— 鼠标停在上面不动，它也在亮 / 灭之间跳。
 * 起因：ltRenderStrip() 每次重绘都把 head 与左栏 SVG 整块重建（main.innerHTML = ""、
 * head.innerHTML = ""、ltRenderGraph 重建整张 svg），而长任务运行期这条重绘非常密
 * （Agent 每段流式正文都叫一次 ltRenderStripSoon，节流后仍是 ~90ms 一次）。
 * 重建 = 鼠标底下那只 DOM 被换掉：老元素被移除、新元素在指针下重新生成，:hover
 * 命中态跟着丢一帧，逐帧重复就是「频繁闪烁」；鼠标按在按钮上时更糟 —— 新元素收不到
 * mouseup，这次 click 直接作废。
 * 已有一半的解法在 ltColHold（右栏打字 / 框选 / 按住时不重建那一栏），但：
 *   ① 它只认「焦点 / 选区 / 鼠标按在栏里」，**悬停**不算，右栏按钮照样被换；
 *   ② 左栏（SVG 状态机图）故意不吃那条保护（见 ltHoldArm 的说明），但用户悬停的
 *      恰恰多是左栏的节点卡片与端子；
 *   ③ 头部按钮没有任何保护。
 * 口径（不动重绘密度，也不改任何交互语义）：重建前后各走一步 ——
 *   · 重建前（ltRenderStrip 最开始）先把**指针此刻压着的那些条带元素**记下来
 *     （ltHoverCapture：elementFromPoint 只取一点，元素整块重建时指针下的仍是同一件，
 *     所以这一帧采到的就是这一帧要保住的东西）；
 *   · 重建后（ltRenderStrip 末尾）按同一份 key 把新长出来的对应件补上标
 *     （ltHoverApply），CSS 把 `:hover` 与这个标并排写上，于是悬停态在重建之间续上，
 *     不再闪；指针一移开，ltHoverBind 的 pointermove 就把标抹掉（不会粘住）。
 *   key 取「与形态无关的稳定标识」：状态机图的节点用 lt-id（节点 path）、端子取
 *   所属节点的 lt-id、缩放手柄同理；其余按可点件的类 + 文字取（按钮文案就是它的身份）。
 * 为什么不用「按住就不重建」那条路：那会牵动选中高亮与拖拽手势的时序（见 ltHoldArm
 * 的取舍），而这里要保的只是**视觉上的悬停态**，用标续上即可，重建照旧、运行态更新一条不丢。 */
/* 这一件是不是状态机图里的节点卡片 / 端子 / 缩放手柄：是就只给「节点 path + 哪一件」的 key。
   数据源只有一处 —— 卡片 g 上的 data-lt-id（ltRenderGraph 写，拖拽也按它现找当前帧），
   所以 key 与「这一帧长什么样」无关，重建后还认得出是同一件。
   端子（circle.lt-port）与缩放手柄（rect.lt-nd-resize）是卡片组里的独立子元素，
   命中时不一定压在卡片那一层上，所以要单独判一次、并上「是哪一件」的后缀。 */
function ltHoverNodeKey(el) {
  let e = el;
  let sub = "";
  for (let d = 0; d < 4 && e && e.nodeType === 1; d++, e = e.parentNode) {
    const cls = e.classList;
    if (!cls || !cls.contains) continue;
    /* 端子 / 缩放手柄只记下「是哪一件」，卡片那一层才收口 —— 这样两者的后缀都会带上
       所属节点的 path（不然指针从端子移到卡片、从手柄移到卡片会被当成同一件）。 */
    if (cls.contains("lt-port")) sub = "|port";
    else if (cls.contains("lt-nd-resize")) sub = "|resize";
    if (cls.contains("lt-nd")) {
      const id = (e.getAttribute && e.getAttribute("data-lt-id")) || "";
      return id ? sub + "@" + id : "";
    }
  }
  return "";
}
function ltHoverKey(el) {
  if (!el || el.nodeType !== 1) return "";
  try {
    const nk = ltHoverNodeKey(el);
    if (nk) return "lt-nd:" + nk;
  } catch (_) {}
  /* 普通可点件（头部按钮 / 右栏卡片里的按钮 / 下拉项 / 缩放回显 / 面包屑…）：
     按按钮的文案取身份 —— 文案极少变，够稳又不必给每颗按钮另编号。
     .lt-chip 先单独判一次：它自己就是可点件（等你处理 / 待确认记忆 / 图有问题），
     不能被上层某颗按钮把身份抢走。 */
  try {
    const own = el.classList;
    if (own && own.contains && own.contains("lt-chip")) return "lt-el:" + String(el.textContent || "").trim().slice(0, 80);
  } catch (_) {}
  try {
    if (el.closest) {
      const btn = el.closest("button,.lt-chip,.lt-crumb-i,.lt-more-i,.lt-sel-o,.lt-sel-tagx");
      if (btn) return "lt-el:" + String(btn.textContent || "").trim().slice(0, 80);
    }
  } catch (_) {}
  return "";
}
let ltHoverX = -1;
let ltHoverY = -1;
/* 重建前采一帧：指针此刻压在条带里的哪些元素（用 key 表达，只留非空的那几个）。
   命中测试优先用条带自己（target.elementFromPoint），量不到时回落 document —— 条带壳
   在测试 / 迷你 DOM 沙箱里可能没有这个方法，回落一层不改变真机行为。 */
function ltHoverCapture(target) {
  const t = target || null;
  let hit = null;
  if (t && typeof t.elementFromPoint === "function") {
    try {
      hit = t.elementFromPoint(ltHoverX, ltHoverY);
    } catch (_) {
      hit = null;
    }
  }
  if (!hit && typeof document !== "undefined" && document && typeof document.elementFromPoint === "function") {
    try {
      hit = document.elementFromPoint(ltHoverX, ltHoverY);
    } catch (_) {
      hit = null;
    }
  }
  if (!hit) return [];
  const keys = [];
  let e = hit;
  for (let d = 0; d < 6 && e && e.nodeType === 1; d++, e = e.parentNode) {
    let k = "";
    try {
      k = ltHoverKey(e);
    } catch (_) {}
    if (k && keys.indexOf(k) < 0) keys.push(k);
  }
  return keys;
}
/* 重建后按同一份 key 把标补上（递归 walked 整棵子树，含 SVG 命名空间元素）。
   data-hover 只落在真正匹配的那一件上，不传播：CSS 里给正常态与 hover 态各写一份
   颜色 / 底色（见 css/longtask.css 的 :hover, [data-hover]），子元素就不会跟着换色。 */
function ltHoverApply(root, keys) {
  if (!root || !keys || !keys.length || !root.children) return;
  for (const c of Array.from(root.children)) {
    if (!c || c.nodeType !== 1) continue;
    let k = "";
    try {
      k = ltHoverKey(c);
    } catch (_) {}
    if (k && keys.indexOf(k) >= 0) {
      try {
        if (c.setAttribute) c.setAttribute("data-hover", "1");
      } catch (_) {}
    }
    ltHoverApply(c, keys);
  }
}
let ltHoverBound = false;
function ltHoverBind() {
  if (ltHoverBound || typeof document === "undefined") return;
  ltHoverBound = true;
  /* 指针一走就把上一帧的标清掉：悬停态只由「此刻指针在哪」决定，标不会粘在重建后的新件上 */
  const clear = () => {
    try {
      const on = document.querySelectorAll ? document.querySelectorAll("[data-hover]") : [];
      for (const el of Array.from(on || [])) if (el.removeAttribute) el.removeAttribute("data-hover");
    } catch (_) {}
  };
  const move = (ev) => {
    if (ev && isFinite(ev.clientX) && isFinite(ev.clientY)) {
      ltHoverX = Number(ev.clientX);
      ltHoverY = Number(ev.clientY);
    }
    clear();
  };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerdown", move, true);
  /* 指针离开窗口 / 条带滚走：同样清掉，免得留下一枚假的悬停态 */
  document.addEventListener("pointerleave", clear, true);
  document.addEventListener("scroll", clear, true);
}

function ltEl(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = String(txt);
  return e;
}

/* ── 挂载：把条带插进 .wf-wrap 的 .fn-toolbar 之前 ───────────────── */
function ltMount() {
  const wrap = document.getElementById("wfWrap");
  if (!wrap || document.getElementById("ltStrip")) return;
  const strip = ltEl("div", "lt-strip");
  strip.id = "ltStrip";
  const grip = ltEl("div", "lt-grip");
  grip.id = "ltGrip";
  grip.title = ltT("向下拖拽展开长周期任务 · 双击切换");
  const body = ltEl("div", "lt-body");
  body.id = "ltBody";
  body.hidden = true;
  const head = ltEl("div", "lt-head");
  head.id = "ltHead";
  const main = ltEl("div", "lt-main");
  main.id = "ltMain";
  body.appendChild(head);
  body.appendChild(main);
  /* 细线挂在面板**下沿** = 它就是「长任务区 / 画布页签」那条分界线，往下拖时线本身
     跟着鼠标的 y 走（挂在面板上方时线是钉死的，拖起来只有面板在下沉，手感是「线不跟手」）。
     收起态 body 是 display:none，条带里只剩这根线，外观与旧版一致。 */
  strip.appendChild(body);
  strip.appendChild(grip);
  wrap.insertBefore(strip, wrap.firstChild);
  LT_UI = { strip, grip, body, head, main };
  ltBindGrip(grip, strip, body);
  /* 框选保护：document 捕获阶段记「鼠标按在两栏的哪一栏」（见 ltHoldArm），整个生命周期只挂一次 */
  ltHoldBind();
  /* 画布渲染时同步一次条带（切画布 / 改图 / 跑节点都会重绘） */
  const rc = window.renderCanvas;
  if (typeof rc === "function" && !rc.__ltHooked) {
    const wrapped = function () {
      const r = rc.apply(this, arguments);
      try {
        ltStripSync();
      } catch (_) {}
      return r;
    };
    wrapped.__ltHooked = 1;
    window.renderCanvas = wrapped;
  }
}
/* 画布与条带的唯一同步点：换画布就把下钻 / 选中清掉，套上**这张画布自己**记得的细线位置
   （开合 + 高度都是 per-画布：需求 1），并恢复该画布未跑完的 run */
let LT_LAST_WF = "";
let LT_LAST_WF_OBJ = null; /* 最近一次同步到的画布对象（细线落盘要用它取 id） */
function ltStripSync() {
  const wf = typeof S !== "undefined" ? S.wf : null;
  const id = wf && wf.id ? String(wf.id) : "";
  if (id !== LT_LAST_WF) {
    LT_LAST_WF = id;
    LT_LAST_WF_OBJ = wf || null;
    ltDrill = [];
    ltSel = { path: "", edge: "" };
    /* 换画布 = 换上下文：未提交的审批理由草稿只对刚离开那条 run 有意义，跟着清掉，
       否则切回来会看到上一张画布写下的话（比丢字更糟）。 */
    for (const k of Object.keys(LT_DRAFTS)) delete LT_DRAFTS[k];
    /* 换画布 = 换一份分割线位置：先按新画布的记忆摆好，再渲染（顺序不能反，
       否则会拿上一张画布的高度画第一帧）。 */
    if (wf && LT_UI) {
      ltSetOpen(ltOpenFor(wf));
      LT_UI.body.style.height = ltClampH(ltHFor(wf) || Number(ltCfg().h) || 320) + "px";
    }
    if (wf && window.api && window.api.ltRunList) {
      ltRestore(wf)
        .then((runs) => {
          if (runs && runs.length) {
            const waiting = runs.filter((x) => x.status === "blocked" || x.status === "waiting").length;
            if (waiting) toast(ltT("这个画布上有 ") + waiting + ltT(" 个长周期任务停在检查点：展开条带点「继续」才会重跑"), "warn");
          }
          ltRenderStrip();
        })
        .catch(() => {});
    }
  }
  ltRenderStrip();
}
/* ── 分割线位置：**按画布记**（需求 1）────────────────────────────
 * 记忆落在 S.wfViews[wfId]（app.js 的「画布视图记忆」那一份：相机 / 任务焦点同址），
 * 与「切 Tab 不弹回根画布」同一口径 —— 每张画布各自记住自己的细线高度，
 * 切回来仍是上次拖到的位置。S.wfViews 由 app.js 管理，这里只当挂载点用（缺就退回全局值）。 */
function ltViewMem(wfIn, create) {
  try {
    const wf = wfIn || (typeof S !== "undefined" && S ? S.wf : null);
    const id = wf && wf.id != null ? String(wf.id) : "";
    if (!id) return null;
    if (typeof S === "undefined" || !S) return null;
    if (!S.wfViews) {
      if (!create) return null;
      S.wfViews = {};
    }
    if (!S.wfViews[id]) {
      if (!create) return null;
      S.wfViews[id] = {};
    }
    return S.wfViews[id];
  } catch (_) {
    return null;
  }
}
function ltViewPatch(wfIn, patch) {
  const v = ltViewMem(wfIn, true);
  if (!v) return;
  try {
    Object.assign(v, patch || {});
  } catch (_) {}
}
/* 本画布记下的细线高度；没记过返回 0（调用方各自回退到全局值 / 下限）。 */
function ltHFor(wfIn) {
  const v = ltViewMem(wfIn, false);
  const h = v && Number(v.ltH);
  return h > 0 ? Math.round(h) : 0;
}
function ltOpenFor(wfIn) {
  const v = ltViewMem(wfIn, false);
  if (v && typeof v.ltOpen === "boolean") return v.ltOpen;
  return !!ltCfg().open;
}
function ltApplyOpen(open, wfIn) {
  if (!LT_UI) return;
  ltSetOpen(!!open);
  if (open) {
    const wf = wfIn || LT_LAST_WF;
    LT_UI.body.style.height = ltClampH(ltHFor(wf) || Number(ltCfg().h) || 320) + "px";
    ltRenderStrip();
  }
}
/* 展开 / 收起只有这一个写入口：body 显隐 + 条带 open + .wf-wrap 的 lt-open 三处一起切。
   wrap 的 lt-open 用来放开 .fn-canvas 的 360px min-height —— 展开时画布必须能被压成 0 高，
   否则它咬着下限不放、面板越长整块越低，tabs 与画布被一起顶出窗口（底部状态栏也盖住），
   细线往下拖出去之后就再也收不回来了。 */
function ltSetOpen(open) {
  if (!LT_UI) return;
  LT_UI.body.hidden = !open;
  LT_UI.strip.classList.toggle("open", !!open);
  try {
    const wrap = document.getElementById("wfWrap");
    if (wrap) wrap.classList.toggle("lt-open", !!open);
  } catch (_) {}
}

/* ── 条带高度：上限 = 此刻「画布 tabs 刚好贴住 .wf-wrap 下沿」（= 画布被压成 0 高）──
 * 旧版把高度写死在 180~900，跟窗口真实高度无关：窗口一矮，900 会把 tabs / 画布 /
 * 底部状态栏一起顶到窗外；再叠上 .fn-canvas 的 min-height:360，画布从头到尾不肯让位，
 * 于是「向下拖拽时画布不跟着往下、拖出去就收不回来」。这与 app-plan.js 的计划清单把手
 * 曾经踩过的坑同源，所以口径也照它来：预算全部实测、拖拽每一步都实时夹，
 * 上限就是此刻真实放得下的最大值（画布不吃预算，展开时由 .wf-wrap.lt-open 让它归零）。 */
const LT_BODY_MIN_H = 180; /* 面板下限：再矮就没法一眼看图 */
const LT_BODY_MAX_FALLBACK = 900; /* 量不到 .wf-wrap（还没挂载 / 迷你 DOM 沙箱）时的兜底 */
function ltCssPx(el, prop, dft) {
  try {
    if (!el || typeof getComputedStyle !== "function") return dft;
    const v = parseFloat(getComputedStyle(el)[prop]);
    return Number.isFinite(v) ? v : dft;
  } catch (_) {
    return dft;
  }
}
function ltBoxH(el, dft) {
  try {
    const r = el && el.getBoundingClientRect && el.getBoundingClientRect();
    const h = Math.round((r && r.height) || (el && el.offsetHeight) || 0);
    return h > 0 ? h : dft;
  } catch (_) {
    return dft;
  }
}
function ltBodyMaxH() {
  try {
    const wrap = document.getElementById("wfWrap");
    const body = document.getElementById("ltBody");
    const strip = document.getElementById("ltStrip");
    if (!wrap || !body) return LT_BODY_MAX_FALLBACK;
    /* 量不到布局（还没挂载 / 视图切换中 display:none）：退回视口保险值，宁可少给也不越界 */
    if (!wrap.clientHeight) return ltViewportMaxH();
    const gap = ltCssPx(wrap, "rowGap", 8);
    let used = ltCssPx(wrap, "paddingTop", 10) + ltCssPx(wrap, "paddingBottom", 10);
    used += ltCssPx(strip, "marginTop", -6); /* 条带上边距（负值：收窄细线与上方的空隙） */
    used += ltCssPx(document.getElementById("ltGrip"), "marginTop", 0); /* 细线自己的上边距 */
    used += ltBoxH(document.getElementById("ltGrip"), 6); /* 细线自身 */
    used += ltCssPx(strip, "marginBottom", -6); /* 条带下边距（负值：收窄细线与页签的空隙） */
    used += ltCssPx(body, "marginTop", 2); /* 细线与面板之间那 2px */
    used += gap * 2; /* 条带↔工具条 / 工具条↔画布 */
    used += ltBoxH(wrap.querySelector(".fn-toolbar"), 40); /* 画布 tabs 工具条 */
    return Math.max(LT_BODY_MIN_H, Math.round(wrap.clientHeight - used));
  } catch (_) {
    return ltViewportMaxH();
  }
}
function ltViewportMaxH() {
  const vh = Number((typeof window !== "undefined" && window.innerHeight) || 0);
  return vh > 0 ? Math.max(LT_BODY_MIN_H, Math.round(vh * 0.7)) : LT_BODY_MAX_FALLBACK;
}
function ltClampH(h) {
  return Math.max(LT_BODY_MIN_H, Math.min(ltBodyMaxH(), Math.round(Number(h) || LT_BODY_MIN_H)));
}
/* 窗口 / 画布区域一变（缩放窗口、拖左右分栏、切视图）就按实测重夹一次：
   矮下去时条带自己收缩，绝不把 tabs 与画布顶出下沿。只改 inline 高度，不落盘
   （落盘口径与 applyAgentSideWidth / agentPlanH 一致：拖到的值松手才写）。 */
function ltWatchWrap() {
  try {
    if (ltWrapRO || typeof ResizeObserver !== "function") return;
    const wrap = document.getElementById("wfWrap");
    if (!wrap) return;
    ltWrapRO = new ResizeObserver(() => {
      if (!LT_UI || LT_UI.body.hidden || ltGripDrag) return;
      LT_UI.body.style.height = ltClampH(ltHFor(LT_LAST_WF_OBJ) || Number(ltCfg().h) || 320) + "px";
    });
    ltWrapRO.observe(wrap);
  } catch (_) {}
}

function ltBindGrip(grip, strip, body) {
  /* 拖拽口径照 app-plan.js 的计划清单把手：拖到的值即当下高度，每一步都按「此刻实测的剩余空间」
     夹住，落盘只在松手时做一次，双击 = 在「展开 / 收起」之间切一下。
     细线在面板下沿，所以高度按增量算就等于「线跟着鼠标 y 走」（1:1，没有偏移）。 */
  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ltGripDrag) return;
    ltGripDrag = { y0: ev.clientY, open0: !body.hidden, h0: ltClampH(parseInt(body.style.height, 10) || ltHFor(LT_LAST_WF_OBJ) || Number(ltCfg().h) || 320), closed: false };
    grip.classList.add("dragging");
    try {
      grip.setPointerCapture(ev.pointerId);
    } catch (_) {}
  });
  grip.addEventListener("pointermove", (ev) => {
    if (!ltGripDrag) return;
    const dy = ev.clientY - ltGripDrag.y0;
    if (!ltGripDrag.open0) {
      if (dy < 8) return;
      /* 收起态往下拖过一点点就展开：h0 从 0 起算，线一露面就落在鼠标底下（旧值 40 会让
         线先跑到鼠标下方 40px 再开始跟手）。此后高度与指针 1:1 连续跟手。 */
      ltGripDrag.open0 = true;
      ltGripDrag.h0 = 0;
      ltSetOpen(true);
    }
    if (!ltGripDrag.closed && dy < -14 && ltGripDrag.h0 + dy <= 190) {
      ltGripDrag.closed = true;
      ltSetOpen(false);
      return;
    }
    if (ltGripDrag.closed) return;
    body.style.height = ltClampH(ltGripDrag.h0 + dy) + "px";
  });
  const end = () => {
    if (!ltGripDrag) return;
    const open = !body.hidden;
    const h = open ? ltClampH(parseInt(body.style.height, 10) || ltHFor(LT_LAST_WF_OBJ) || Number(ltCfg().h) || 320) : ltHFor(LT_LAST_WF_OBJ) || Number(ltCfg().h) || 320;
    grip.classList.remove("dragging");
    /* 落盘口径（需求 1）：**按当前画布**记高度与开合（S.wfViews[wfId]，与相机 / 任务焦点同址），
       全局值只当没记过时的兜底，不再被每张画布互相覆盖。 */
    ltViewPatch(LT_LAST_WF_OBJ, { ltH: h, ltOpen: open });
    ltCfgPatch({ open: open, h: h });
    ltGripDrag = null;
    ltRenderStrip();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", () => {
    const open = LT_UI.body.hidden;
    ltApplyOpen(open);
    ltViewPatch(LT_LAST_WF_OBJ, { ltOpen: open });
    ltCfgPatch({ open });
  });
  ltWatchWrap();
}

/* ── 条带重绘 ───────────────────────────────────────────────────── */
/* 重建后补悬停标（悬停保护的收尾步，见 ltHoverKey 段）：strip 那一层在 head / main 重建
   之后调它；main 内部那几条「只重建另一栏」的早退路也各调一次 —— 早退时头部与另一栏
   仍会被换掉，悬停态一条都不许丢。keys 由 ltRenderStrip 在任何 DOM 被换掉之前采好。
   typeof 兜一层与 ltColHold 同一口径：纯 Node 的迷你 DOM 回归（test/smoke-longtask-refocus.js）
   只搬得动其中几个函数，搬不到就当作「没有悬停标要补」，不影响重建本身。 */
function ltHoverHere() {
  try {
    if (typeof ltHoverApply !== "function") return;
    const keys = (LT_UI && LT_UI.hoverKeys) || null;
    if (keys && keys.length) ltHoverApply(LT_UI.body, keys);
  } catch (_) {}
}
function ltRenderStrip() {
  if (!LT_UI) return;
  /* 细线的运行态先同步：收起态只能看见这根线，它是「任务在不在跑」的唯一指示灯，
     所以不能跟着 body 一起被 hidden 挡在早退之后。 */
  ltGripSync();
  if (LT_UI.body.hidden) return;
  const wf = typeof S !== "undefined" ? S.wf : null;
  if (!wf) return;
  /* 悬停保护（本次需求）：重建前先采一帧「指针压着哪几件」（存进 LT_UI.hoverKeys，供
     各条重建路收尾时补标），重建后补标 —— 鼠标停在按钮 / 图节点上不动时，悬停态不再被
     ~90ms 一次的重绘打断（见 ltHoverKey 段）。 */
  try {
    if (typeof ltHoverBind === "function") ltHoverBind();
    LT_UI.hoverKeys = typeof ltHoverCapture === "function" ? ltHoverCapture(LT_UI.body) : [];
  } catch (_) {
    LT_UI.hoverKeys = [];
  }
  ltEnsure(wf);
  ltRenderHead(wf);
  ltRenderMain(wf);
  ltHoverHere();
}
/* 细线的状态色：'' | run | wait | fail | ok（与 ltStatusChip 的映射同源）。
   颜色只回答「跑得怎么样」，展开 / 拖拽一律不改色 —— 拖到下方时线保持原样。 */
function ltGripStatus(wf) {
  try {
    if (!wf) return "";
    const run = typeof ltCurrentRun === "function" ? ltCurrentRun(wf) : null;
    if (!run) return "";
    if (run.waits && run.waits.length) return "wait";
    const s = String(run.status || "");
    if (s === "running") return "run";
    if (s === "waiting") return "wait";
    if (s === "done") return "ok";
    if (s === "failed" || s === "blocked" || s === "stalled" || s === "interrupted") return "fail";
    return "";
  } catch (_) {
    return "";
  }
}
function ltGripSync() {
  const grip = LT_UI && LT_UI.grip;
  if (!grip || !grip.classList) return;
  const wf = typeof S !== "undefined" ? S.wf : null;
  const st = ltGripStatus(wf);
  for (const k of ["run", "wait", "fail", "ok"]) grip.classList.toggle("lt-grip-s-" + k, st === k);
}
function ltStatusChip(run) {
  const map = { running: "run", waiting: "wait", blocked: "block", done: "ok", failed: "fail", cancelled: "off", stalled: "block", interrupted: "block", idle: "off" };
  const s = (run && run.status) || "idle";
  return ltEl("span", "lt-chip lt-chip-" + (map[s] || "off"), ltT(s) + (run && run.steps ? " · " + run.steps + ltT(" 步") : ""));
}
/* ── 当前选型的只读回显（本轮需求）────────────────────────────────────
   条带头 chip、图内 agent 卡片摘要、环节检查器顶部那一行，三处表层共用这一份：
   cfg 写了用 cfg，留空取「用户当前选择」—— 真源是 app-longtask.js 的 ltAgentSelOf
   （与运行这一轮真正下发的伪节点同一口径）。本文件只读：不落任何新存储、不开第二套
   清单，也不改 cfg。 */
function ltAgentSelRead(n, AO) {
  try {
    if (typeof ltAgentSelOf === "function") return ltAgentSelOf(n);
  } catch (_) {}
  /* 真源函数没加载（老运行时 / 切片加载）：按 AO.defaults 兜一份同口径的只读值 */
  const cfg = (n && n.cfg) || {};
  const d = (AO && AO.defaults) || {};
  const route = String(cfg.provider || d.route || "").trim();
  let model = String(cfg.model || "").trim();
  if (!model && AO && typeof AO.modelForRoute === "function") model = String(AO.modelForRoute(route) || "").trim();
  if (!model) model = String(d.model || "").trim();
  return {
    provider: route,
    model: model,
    preset: String(cfg.preset || d.preset || "").trim(),
    effort: String(cfg.effort || d.effort || "").trim(),
  };
}
/* 选型四件套的**显示名**：路由走 AO.routeName（服务商名），预设 / 思考强度把值换成
   AO 清单里的 label；清单缺失时原样显示值 —— 只读回显绝不因拿不到清单而空成一片。 */
function ltAgentSelParts(sel, AO) {
  const s = sel || {};
  const route = String(s.provider || "").trim();
  const model = String(s.model || "").trim();
  const preset = String(s.preset || "").trim();
  const effort = String(s.effort || "").trim();
  const label = (list, v) => {
    const hit = ltArr(list).filter((o) => o && String(o.value) === v)[0];
    return hit ? String(hit.label || v) : "";
  };
  return {
    route: (AO && typeof AO.routeName === "function" ? AO.routeName(route) : route) || ltT("默认路由"),
    model: model || ltT("默认模型"),
    preset: label(AO && AO.presetOptions, preset) || preset || ltT("默认预设"),
    effort: label(AO && AO.effortOptions, effort) || effort || ltT("默认思考强度"),
  };
}
/* 一整句：「本轮模型：路由 · 模型 · 预设 · 思考强度」（条带头 chip 的 title 用它） */
function ltAgentSelText(sel, AO) {
  return ltT("本轮模型：{route} · {model} · {preset} · {effort}", ltAgentSelParts(sel, AO));
}
/* 环节检查器顶部那一行：同一句，但**留空的字段就地标出来源**（跟随默认）。
   留空 = 跑的是用户当前选择；不标出来，用户就分不清「自己写的」与「跟默认跑的」。 */
function ltAgentSelLine(n, AO) {
  const cfg = (n && n.cfg) || {};
  const p = ltAgentSelParts(ltAgentSelRead(n, AO), AO);
  const mark = (k) => (String(cfg[k] || "").trim() ? "" : ltT("（跟随默认）"));
  return ltT("本轮模型：{route} · {model} · {preset} · {effort}", {
    route: p.route + mark("provider"),
    model: p.model + mark("model"),
    preset: p.preset + mark("preset"),
    effort: p.effort + mark("effort"),
  });
}
/* 卡片摘要里的模型短名：id 取「/」末段（清单里偶有「服务商/模型」的长路径），
   按显示宽度截断 —— 与卡片其它文字同一把尺（ltBrk 的中文=2 格口径）。
   maxCols 由调用方按当帧可用列数给（卡片摘要最多占半行，别把目标 / 报错挤没）。 */
function ltAgentModelShort(m, maxCols) {
  const s = String(m || "").trim();
  if (!s) return "";
  return ltBrk(s.split("/").pop() || s, Math.max(6, Number(maxCols) || 18));
}
/* 这一帧的模型选型清单（只读；AGENTS 的单源约定：真源只在 app-longtask-ctl.js 的
   ltAgentOpts()，这里只取来把 id 换成显示名，不复制任何清单） */
function ltAgentOptsNow() {
  const C = ltCtl();
  return C && typeof C.agentOpts === "function" ? C.agentOpts() : null;
}
function ltRenderHead(wf) {
  const head = LT_UI.head;
  /* 头部整块重建：挂在头部按钮上的那只下拉要跟着搬家 —— 先记下它的锚点身份，
     建完再把锚点认到新按钮上（认不到才收掉，免得锚点 DOM 已不在却还飘着）。
     以前这里一律 ltMenuClose()：长任务跑着时头部 ~90ms 重建一次，用户点开「⋯ 更多」
     后下一次重绘就把菜单收掉（菜单都来不及点），也是「按钮闪烁」同一族的症状。 */
  const oldMenu = LT_MENU && LT_MENU.anchor && LT_MENU.anchor.getAttribute ? LT_MENU.anchor.getAttribute("data-lt-menu") : "";
  head.innerHTML = "";
  const task = ltActiveTask(wf) || ltEnabledTask(wf);
  const run = ltCurrentRun(wf);
  /* 头部左端不再有任务菜单按钮（按要求移除）：任务切换 / 新建 / 历史 run / 交付目录体检
     都收进右端那颗 ⚙ 的设置窗里，图 JSON 的导入 / 导出整条链路也已删掉。 */
  head.appendChild(ltStatusChip(run));
  const waits = run && run.waits ? run.waits.length : 0;
  if (waits) {
    const w = ltEl("span", "lt-chip lt-chip-wait lt-breath", ltT("等你处理") + " ×" + waits);
    w.onclick = () => {
      ltSel.path = (run.waits[0] || {}).path || "";
      ltRenderStrip();
    };
    head.appendChild(w);
  }
  if (ltMemPendingCount()) head.appendChild(Object.assign(ltEl("span", "lt-chip lt-chip-mem lt-breath", ltT("待确认记忆") + " ×" + ltMemPendingCount()), { onclick: () => ltMemPendingDlg() }));
  const errs = task ? ltValidate(task.graph).filter((x) => x.level === "err") : [];
  if (errs.length) head.appendChild(Object.assign(ltEl("span", "lt-chip lt-chip-fail", ltT("图有问题") + " ×" + errs.length), { title: errs[0].msg, onclick: () => ltProblemsDlg(task) }));
  /* 当前选型回显（本轮需求）：条带头常驻一枚模型 chip —— 长任务跑起来时这条带就是
     用户最常盯的地方，「这一轮到底用哪只模型 / 哪档预设 / 哪档思考强度」不该只藏在
     节点检查器里。数据源与图内卡片摘要、检查器那一行同一份（ltAgentSelRead +
     ltAgentOptsNow），只读、不落存储。chip 只放短名（窄窗里别一枚 chip 吃掉整条带），
     完整的「路由 · 模型 · 预设 · 思考强度」进 title，hover 即见。 */
  {
    const AOhead = ltAgentOptsNow();
    const selHead = ltAgentSelRead(null, AOhead);
    const p = ltAgentSelParts(selHead, AOhead);
    const chip = ltEl("span", "lt-chip lt-chip-model", ltT("模型") + " " + ltAgentModelShort(selHead.model) + " · " + p.preset + " · " + p.effort);
    chip.title = ltAgentSelText(selHead, AOhead);
    head.appendChild(chip);
  }
  const sp = ltEl("div", "lt-spacer");
  head.appendChild(sp);
  /* ── 按钮收纳（本次需求）────────────────────────────────────────────
     以前这里平铺七八颗按钮（启用 / 停止 / 重新启用 / 停用解绑 / 记忆 / 删除 / ⚙ / ✕），
     可绝大多数只在极少数场景用一次，把条带挤得满满当当。现在的口径：
       · 常驻只留「用得上的」：任务卡住时的「▶ 继续」「■ 停止」、「✎ 修改任务链」（本次新增的
         主入口）、「⚙ 设置」（任务切换 / 历史 run / 交付目录体检 / 图校验都在这只窗里）、
         「✕ 收起条带」；无任务时仍是「＋ 创建长任务」；
       · 其余（启用并绑定 / 重新启用 / 停用解绑 / 记忆 / 历史 run / 交付体检 / 图校验 /
         删除任务）一律收进「⋯ 更多」下拉（见 ltMoreBtn）。
     下拉是**瞬时菜单**（没有待提交的输入）：点外部 / Esc 即收，符合 AGENTS 的浮层分类。 */
  if (!task) {
    head.appendChild(ltBtn(ltT("＋ 创建长任务"), "lt-btn-pri", () => openLtCreateDlg(wf)));
  } else {
    if (run && (run.status === "blocked" || run.status === "failed" || run.status === "stalled" || run.status === "cancelled")) {
      head.appendChild(ltBtn(ltT("▶ 继续"), "lt-btn-pri", async () => {
        await ltResume(wf, run.runId);
        ltRenderStrip();
      }));
    }
    if (task.enabled && run && run.status !== "done")
      head.appendChild(ltBtn(ltT("■ 停止"), "lt-btn", () => { ltStop(wf); ltRenderStrip(); }));
    /* 任务链修改（本次需求的主入口）：与「＋ 创建长任务」同一只弹窗体量 —— 用户写一句修改
       要求，Agent 读完当前状态图 + 运行态后原地改 / 修图。入口常驻头部，不必翻任何菜单。 */
    head.appendChild(
      ltBtn(ltT("✎ 修改任务链"), "lt-btn lt-btn-edit", () => ltOpenEditDlg(wf, task.uid), ltT("用一句话说清要改什么，Agent 按当前任务状态图原地改 / 修复（有全部权限）")),
    );
    head.appendChild(ltBtn(ltT("⚙"), "lt-btn lt-btn-ico", () => ltSettingsDlg(), ltT("长任务设置：任务切换 / 历史 run / 交付目录体检 / 图校验")));
    head.appendChild(ltMoreBtn(wf, task));
    head.appendChild(ltBtn("✕", "lt-btn lt-btn-ico", () => { ltViewPatch(LT_LAST_WF_OBJ, { ltOpen: false }); ltCfgPatch({ open: false }); ltApplyOpen(false); }, ltT("收起长任务条带")));
  }
  if (oldMenu) ltMenuReadopt(oldMenu);
}
/* ── 面包屑根条目：当前长任务名 + 就地切换旧长任务（本次需求）────────
   以前这里写死一个「主图」标签 —— 一张画布上可以有好几张长任务（同一时刻只有一张
   启用中），可用户在图上却看不出自己正在看的是哪一张，要换一张还得翻 ⚙ 设置窗。
   现在根条目直接写**当前这张长任务的名字**，点它就是一份任务清单：换一张、或者新建一张，
   当前那张带 ✓ 且禁用（它就是此刻显示的这一张，选了等于没选）。任务名是用户自己起的
   （「主图」/「副图」/任何名字），所以文案只回显任务名，不另造词。 */
function ltCrumbTaskBtn(wf, curTask, depth) {
  const tasks = ltTasks(wf);
  const cur = curTask || ltActiveTask(wf) || ltEnabledTask(wf) || tasks[0] || null;
  const name = (cur && String(cur.name || "").trim()) || ltT("长任务");
  /* 名字后面自带宽窄不变的 ▾（写在正文里，不必靠伪元素）：这是「点得开」的提示，
      与中间那些纯路径条目区分开；下钻时带 .on 亮边（当前这一层）。 */
  const b = ltEl("button", "lt-crumb-i lt-crumb-root" + (depth === ltDrill.length ? " on" : ""), name + " ▾");
  b.type = "button";
  b.title = tasks.length > 1 ? ltT("当前长任务：") + name + ltT(" · 点这里切换到别的长任务") : ltT("点这里新建 / 切换长任务（目前这张画布只有这一张）");
  b.onclick = (ev) => {
    ev.stopPropagation();
    /* 展开锚在哪一帧的按钮上都要先收（重建后那枚按钮已经不在了，留着会飘在别处） */
    ltMenuClose();
    const items = [];
    for (const t of tasks) {
      const isCur = !!cur && t.uid === cur.uid;
      const bits = [ltArr(t.graph.nodes).length + ltT(" 节点"), "v" + (Number(t.ver) || 1)];
      if (t.enabled) bits.push(ltT("已绑定"));
      items.push({
        label: (isCur ? "✓ " : "") + String(t.name || ltT("长任务")),
        title: bits.join(" · ") + (isCur ? ltT("（就是当前显示的这张）") : ltT(" · 切到这张长任务")),
        cls: isCur ? "lt-crumb-cur" : "",
        on: () => {
          if (isCur) return;
          wf.longtask.active = t.uid; /* ⚙ 里那张「切到哪个任务」下拉的同一份真源 */
          if (typeof ltPersistWf === "function") ltPersistWf(wf);
          else if (typeof scheduleSave === "function") scheduleSave(true);
          /* 换了任务 = 换了一整棵图：下钻路径与选中的环节都作废（子图不是这张任务里的了） */
          ltDrill = [];
          ltSel.path = "";
          ltRenderStrip();
        },
      });
    }
    if (!tasks.length) items.push({ label: ltT("这张画布还没有长任务"), cls: "lt-crumb-none", on: () => {} });
    items.push({ sep: true }, { label: ltT("＋ 创建长任务"), title: ltT("新建一张长周期任务（手动模板或交给 Agent 建图）"), on: () => openLtCreateDlg(wf) });
    ltMenuOpen(b, items);
  };
  return b;
}

/* ── 「⋯ 更多」下拉（把几乎用不上的手动按钮收成一颗）──────────────────
   瞬时菜单：没有待提交的输入，点外部 / Esc / 窗口失焦 / 缩放即收（AGENTS 的浮层分类里
   它与右键菜单同一类，不适用「禁止点外部关闭」）。面板挂 document.body + position:fixed：
   .lt-head 是 overflow-x:auto 的滚动容器，挂在里面会被裁掉半边。 */
let LT_MENU = null; /* { el, anchor } 当前展开的那只下拉；右键菜单没有锚点，anchor = null */
function ltMenuClose() {
  const m = LT_MENU;
  LT_MENU = null;
  if (!m) return;
  if (m.anchor && m.anchor.classList) m.anchor.classList.remove("on");
  if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
  document.removeEventListener("pointerdown", ltMenuOutside, true);
  document.removeEventListener("keydown", ltMenuEsc, true);
  window.removeEventListener("blur", ltMenuClose);
  window.removeEventListener("resize", ltMenuClose);
}
function ltMenuIsOpen(anchor) {
  return !!(LT_MENU && anchor && LT_MENU.anchor === anchor);
}
function ltMenuEsc(ev) {
  if (ev.key === "Escape") ltMenuClose();
}
/* 点外部即收：锚点自己由它的 onclick 负责开合（这里跳过，免得刚开就被立刻收起） */
function ltMenuOutside(ev) {
  const m = LT_MENU;
  if (!m) return;
  if (m.el && m.el.contains(ev.target)) return;
  if (m.anchor && m.anchor.contains && m.anchor.contains(ev.target)) return;
  ltMenuClose();
}
/* 打开一只以 anchor 为锚的下拉；items = [{ label, cls, title, on }]，{ sep:true } 画分隔线。
   右键菜单（图内空白 / 节点 / 连线）不给锚点，改传 pt = { x, y } 的**鼠标屏幕坐标**：
   菜单落在光标右下方（右下溢出窗外就往回收），与主画布 #ctx 同一手感。 */
function ltMenuOpen(anchor, items, pt) {
  ltMenuClose();
  if (!anchor && !pt) return;
  if (anchor && !anchor.isConnected) return;
  const el = ltEl("div", "lt-more-pop");
  el.setAttribute("role", "menu");
  for (const it of items || []) {
    if (!it) continue;
    if (it.sep) {
      el.appendChild(ltEl("div", "lt-more-sep"));
      continue;
    }
    const b = ltEl("button", "lt-more-i " + (it.cls || ""), it.label);
    b.type = "button";
    if (it.title) b.title = it.title;
    b.onclick = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      ltMenuClose();
      try {
        it.on();
      } catch (_) {}
    };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  ltMenuPlace(el, anchor, pt);
  if (anchor && anchor.classList) anchor.classList.add("on");
  LT_MENU = { el, anchor: anchor || null };
  /* 捕获阶段监听：条带 / 画布上的 pointerdown 一律先被这里看到 */
  document.addEventListener("pointerdown", ltMenuOutside, true);
  document.addEventListener("keydown", ltMenuEsc, true);
  window.addEventListener("blur", ltMenuClose);
  window.addEventListener("resize", ltMenuClose);
}
/* 贴锚点右下角；右 / 下溢出窗外就往回收（窄窗里也不会飘到看不见的地方）。
   无锚点（右键菜单）时锚点就是光标那一点。开菜单与头部重建后重新贴锚点共用这一份。 */
function ltMenuPlace(el, anchor, pt) {
  const r = anchor ? anchor.getBoundingClientRect() : { right: Number((pt && pt.x) || 0), bottom: Number((pt && pt.y) || 0) };
  const w = el.offsetWidth || 200;
  const h = el.offsetHeight || 200;
  const x = Math.max(6, Math.min(Math.round(r.right - w), window.innerWidth - w - 6));
  const y = Math.max(6, Math.min(Math.round(r.bottom + 4), window.innerHeight - h - 6));
  el.style.left = x + "px";
  el.style.top = y + "px";
}
/* 头部整块重建后，把那只以头部按钮为锚的下拉认到新按钮上（见 ltRenderHead）：
   锚点身份写在按钮的 data-lt-menu 上，与形状无关，重建后仍找得到；找不到（这颗按钮
   这一帧不再存在，如「▶ 继续」随状态收起）就收掉菜单，绝不留一只锚点已失效的浮层。 */
function ltMenuReadopt(key) {
  const m = LT_MENU;
  if (!m || !m.anchor) return;
  let next = null;
  try {
    next = document.querySelector ? document.querySelector('[data-lt-menu="' + String(key).replace(/["\\]/g, "") + '"]') : null;
  } catch (_) {
    next = null;
  }
  if (!next) {
    ltMenuClose();
    return;
  }
  if (m.anchor && m.anchor.classList) m.anchor.classList.remove("on");
  m.anchor = next;
  try {
    if (next.classList) next.classList.add("on");
    ltMenuPlace(m.el, next, null);
  } catch (_) {}
}
function ltMoreBtn(wf, task) {
  const b = ltBtn(ltT("⋯ 更多"), "lt-btn lt-more", null, ltT("其余不常用的操作（启用 / 停用 / 记忆 / 删除任务 等）"));
  /* 锚点身份（头部重建后把下拉认回来，见 ltRenderHead / ltMenuReadopt）：与按钮形状无关 */
  try {
    b.setAttribute("data-lt-menu", "lt-more");
  } catch (_) {}
  /* 「重建壳」只在真需要时出现：这一轮的超级节点壳被你删过（墓碑落在 run 上），
     引擎按「删了不偷偷重长」的口径停手了 —— 这里给用户一次显式恢复的入口。 */
  const runNow = (() => {
    try {
      const id = String((task && task.activeRun) || "");
      return id && typeof ltRun === "function" ? ltRun(wf.id, id) : null;
    } catch (_) {
      return null;
    }
  })();
  const needShell = !!(runNow && (runNow.shellGone || runNow.shellWarned));
  const menu = [
      {
        label: ltT("▶ 启用并绑定"),
        title: ltT("按当前图定义拍一张快照开一个 run（图改过就用新版跑）"),
        on: async () => {
          const r = await ltEnable(wf, task.uid, {});
          if (!r.ok) toast(ltT("启用失败：") + (r.error || ""), "err");
          else toast(ltT("长周期任务已启用并绑定本画布"), "ok");
          ltRenderStrip();
        },
      },
      {
        label: ltT("重新启用（新 run）"),
        title: ltT("按当前图定义从起点重跑（正在跑的 run 会被替换）"),
        on: async () => {
          const r = await ltEnable(wf, task.uid, {});
          if (!r.ok) toast(ltT("启用失败：") + (r.error || ""), "err");
          ltRenderStrip();
        },
      },
      {
        label: ltT("停用解绑"),
        title: ltT("解绑本画布：图与历史记录都保留，随时可再启用"),
        on: () => {
          ltDisable(wf);
          if (typeof scheduleSave === "function") scheduleSave(true);
          ltRenderStrip();
        },
      },
      { sep: true },
      { label: ltT("记忆"), title: ltT("长任务记忆沉淀：查 / 记 / 导出到事实库"), on: () => ltMemoryDlg() },
      { label: ltT("历史 run"), title: ltT("看这张任务跑过的每一轮 run 与它们的图版本"), on: () => ltRunsDlg(wf) },
      { label: ltT("交付目录体检"), title: ltT("扫交付目录：报告缺项 / 孤儿，只报告不删"), on: () => ltOrphanDlg(wf) },
      { label: ltT("任务图校验"), title: ltT("按引擎规则校验当前这张图，列出 err / warn"), on: () => ltProblemsDlg(task) },
      { sep: true },
      { label: ltT("🗑 删除任务"), cls: "lt-btn-del", title: ltT("删除这张长任务（会先确认）"), on: () => ltConfirmDeleteTask(wf) },
  ];
  /* 壳被删过（墓碑落在本轮 run 上）时，才补一项显式恢复的入口 ——
     引擎按「删了不偷偷重长」的口径停手，恢复与否由用户决定。 */
  if (needShell) {
    menu.splice(menu.length - 2, 0, {
      label: ltT("重建壳"),
      title: ltT("超级节点壳被删过：点这里重建父壳（后续产出照常落进对应环节子壳）"),
      on: () => {
        const sh = window.LTSHELL;
        if (!sh || typeof sh.rebuild !== "function" || !sh.rebuild(runNow)) {
          toast(ltT("重建壳失败：长任务壳模块未就绪"), "warn");
          return;
        }
        if (typeof scheduleSave === "function") scheduleSave(true);
        ltRenderStrip();
      },
    });
  }
  b.onclick = (ev) => {
    ev.stopPropagation();
    if (ltMenuIsOpen(b)) {
      ltMenuClose();
      return;
    }
    ltMenuOpen(b, menu);
  };
  return b;
}
/* 头部那颗「✎ 修改任务链」的落点：弹窗模块（renderer/app-longtask-edit.js）挂的就是它。
   模块没加载（脚本分层 / 单测环境）时不静默失败，明确告诉用户去哪找。 */
function ltOpenEditDlg(wf, uid) {
  if (typeof window.ltOpenEditDlg === "function") {
    try {
      window.ltOpenEditDlg(wf, uid);
      return;
    } catch (_) {}
  }
  toast(ltT("任务链修改模块未就绪"), "warn");
}
/* 删除任务的确认框 + 执行体。按钮与设置窗里都可能调它，所以单独成函数。
   文案必须写清三件事：停 run / 收交付节点 / 删历史记录，以及**不动交付目录里的文件**。 */
async function ltConfirmDeleteTask(wf, uid) {
  const box = wf || (typeof S !== "undefined" ? S.wf : null);
  if (!box) return;
  ltEnsure(box);
  const key = String(uid || (box.longtask && box.longtask.active) || "");
  const task = ltArr(box.longtask && box.longtask.tasks).find((t) => t.uid === key);
  if (!task) {
    toast(ltT("这张画布没有可删除的长任务"), "warn");
    return;
  }
  const ok =
    typeof confirmDialog === "function"
      ? await confirmDialog(
          ltT("将删除长任务「") +
            String(task.name || "") +
            ltT("」：在跑的 run 会被停止，它在主画布上的交付节点会被收走，历史 run 记录一并删除。交付目录里的文件不会被删。确定删除？"),
          { title: ltT("删除长任务"), danger: true, okText: ltT("删除"), cancelText: ltT("取消") },
        )
      : false;
  if (!ok) return;
  const r = typeof ltDeleteTask === "function" ? await ltDeleteTask(box, task.uid) : { ok: false, error: ltT("长任务模块未就绪") };
  if (!r || !r.ok) {
    toast((r && r.error) || ltT("删除失败"), "err");
    return;
  }
  toast(ltT("已删除长任务：") + (r.name || ""), "ok");
  /* 设置窗里那张「切到哪个任务」下拉是按开窗那刻的任务表画的，删完就过期了；
     窗还开着才关（关掉重开是显式路径，不会把用户留在过期清单上）。
     ⚠ 只在长任务设置窗开着时关它 —— 没有「是否是最上层浮层」的通用查询口，
         若此刻压着的是别的窗（如确认框自己），这里就不动。 */
  try {
    const openTitle = document.getElementById("ovTitle");
    const ov = document.getElementById("overlay");
    if (ov && ov.classList.contains("on") && openTitle && openTitle.textContent === ltT("长周期任务 · 设置") && typeof closeOverlay === "function") closeOverlay();
  } catch (_) {}
  ltRenderStrip();
}
function ltBtn(text, cls, fn, title) {
  const b = ltEl("button", "lt-btn " + (cls || ""), text);
  b.type = "button";
  if (title) b.title = title;
  b.onclick = fn;
  return b;
}
/* 长任务这几只窗（设置 / 历史 run / 交付目录体检 / 图校验）只是看数据与改参数：窗壳标题栏
   的 ✕ 也关得掉（app.js 的通用关闭按钮），但这几只在 #ovFoot 另留一颗语义正确的
   「关闭 / 完成并关闭」，免得用户去标题栏找。关闭只走显式路径，见 AGENTS.md
   「协作约定」：点外部 / 点蒙层一律不算。 */
function ltFootClose(label, cls) {
  const foot = document.getElementById("ovFoot");
  if (!foot) return;
  foot.innerHTML = "";
  foot.appendChild(ltBtn(ltT(label || "关闭"), cls || "lt-btn", () => closeOverlay()));
}

/* ── 主区：左 = 状态机图（可编辑），右 = 检查器 / 人工任务卡 ─────── */
function ltRenderMain(wf) {
  const main = LT_UI.main;
  const task = ltActiveTask(wf) || ltEnabledTask(wf);
  if (!task) {
    /* 没任务可画 = 空态整块重建：用户正占着某一栏（打字 / 框选 / 鼠标按着）时先等一等，
       免得刚写下的字与刚框出来的选区被空态顶掉 —— 与下面「按栏保留」同一口径。 */
    if (typeof ltColHold === "function" && (ltColHold(ltColOf(main, "lt-right")) || ltColHold(ltColOf(main, "lt-left")))) {
      ltRenderWhenFocusLeaves();
      ltHoverHere();
      return;
    }
    main.innerHTML = "";
    main.appendChild(ltEmptyState(wf));
    ltHoverHere();
    return;
  }
  const run = ltCurrentRun(wf);
  const graph = run && run.graph ? run.graph : task.graph;
  /* 这一栏「正被占着」时按栏保留（见 ltColHold 的说明）：被保留的那一栏不摘出文档 ——
     焦点 / 选区（正在框选的那段文字）/ 输入法组合态原样活着，另一栏照常跟着运行态重绘。
     typeof 兜一层：纯 Node 的迷你 DOM 回归（test/smoke-longtask-refocus.js）只搬得动其中几个函数。 */
  const oldLeft = ltColOf(main, "lt-left");
  const oldRight = ltColOf(main, "lt-right");
  const holdRight = ltFocusCol(oldRight) || (typeof ltColHold === "function" && ltColHold(oldRight));
  if (holdRight) {
    for (const c of Array.from(main.children)) if (c !== oldRight) main.removeChild(c);
    const left = ltEl("div", "lt-left");
    main.insertBefore(left, oldRight);
    ltRenderGraph(left, wf, task, run, graph);
    ltRenderWhenFocusLeaves();
    ltHoverHere();
    return;
  }
  const holdLeft = ltFocusCol(oldLeft) || (typeof ltColHold === "function" && ltColHold(oldLeft));
  if (holdLeft) {
    for (const c of Array.from(main.children)) if (c !== oldLeft) main.removeChild(c);
    const right = ltEl("div", "lt-right");
    main.appendChild(right);
    ltRenderSide(right, wf, task, run);
    ltRenderWhenFocusLeaves();
    ltHoverHere();
    return;
  }
  main.innerHTML = "";
  const left = ltEl("div", "lt-left");
  const right = ltEl("div", "lt-right");
  main.appendChild(left);
  main.appendChild(right);
  ltRenderGraph(left, wf, task, run, graph);
  ltRenderSide(right, wf, task, run);
  ltHoverHere();
}
function ltEmptyState(wf) {
  const box = ltEl("div", "lt-empty");
  box.appendChild(ltEl("div", "lt-empty-ico", "⛓"));
  const h = ltEl("div", "lt-empty-h", ltT("这张画布还没有长周期任务"));
  box.appendChild(h);
  box.appendChild(
    ltEl(
      "div",
      "lt-empty-p",
      ltT("长周期任务把复杂工作拆成一张状态机图：Agent 任务自动跑、人工任务（审批 / 交付）停下来等你，子图与并行分支都在这一条带上实时可视。启用后会与当前画布绑定，需要时授权它读取画布。"),
    ),
  );
  const row = ltEl("div", "lt-empty-row");
  row.appendChild(ltBtn(ltT("＋ 创建长任务"), "lt-btn-pri", () => openLtCreateDlg(wf)));
  box.appendChild(row);
  return box;
}
/* 空白模板（start → agent → end_ok）。ctx 可选 = 「创建时的 Agent 选型」
   （新建对话框那一栏，见 app-longtask-create.js 的 window.ltCreateAgentCfg）：
   给了就按它把整张图的 Agent 环节选型一次填好，不给仍回落全局默认。 */
async function ltNewTask(wf, ctx) {
  ltEnsure(wf);
  const startId = "n_start";
  const endId = "n_end";
  const g = {
    ver: 1,
    nodes: [
      /* 坐标一律落在吸附网格上（网格 = app.js 的 grid()，缺省 24）：
         模板图也照主画布口径摆，用户第一次拖就不会「跳一格」。 */
      { id: startId, kind: "start", x: 48, y: 144, w: 120, h: 48, title: ltT("起点"), cfg: {} },
      { id: "n_a1", kind: "agent", x: 264, y: 120, w: 192, h: 96, title: ltT("第一个 Agent 任务"), cfg: { goal: "", outKeys: ["result"] } },
      { id: endId, kind: "end_ok", x: 528, y: 144, w: 120, h: 48, title: ltT("完成"), cfg: {} },
    ],
    edges: [
      { id: "e1", from: startId, to: "n_a1" },
      { id: "e2", from: "n_a1", to: endId },
    ],
  };
  const task = { uid: ltUid("ltask"), name: ltT("长周期任务 ") + (wf.longtask.tasks.length + 1), graph: ltInheritGraph(ltNormGraph(g), ctx), ver: 1, enabled: false, activeRun: "", createdAt: ltNow(), updatedAt: ltNow() };
  wf.longtask.tasks.push(task);
  wf.longtask.active = task.uid;
  if (typeof scheduleSave === "function") scheduleSave(true);
  /* 创建收尾（本轮需求）：与 create_longtask / 兜底落库同一条「创建即显示」入口 ——
     手动模板建的任务也不再要求先「启用并绑定」才看得见；同时把画布落点
     （壳 / 生成工作流 / 交付节点）预建好 —— 只建不跑（enabled 仍 false）。 */
  if (typeof ltLandingCreate === "function") ltLandingCreate(wf, task);
  if (typeof ltTaskReveal === "function") ltTaskReveal(wf, task);
  toast(ltT("已新建长周期任务：图已在条带上显示（要开跑点 ▶ 启用并绑定）"), "ok");
  return task;
}

/* ── 状态机图（自研迷你 SVG 编辑器，只复用主题样式）────────────────── */
function ltCurGraph(wf) {
  const task = ltActiveTask(wf) || ltEnabledTask(wf);
  if (!task) return null;
  /* 编辑器永远改「图定义」（task.graph）；当前 run 用的是启用那刻的快照，改定义不影响它
     （共识 q34），所以状态按节点 id 叠在定义上显示，版本对不上时给一行提示。 */
  const run = ltCurrentRun(wf);
  let cur = task.graph;
  for (const d of ltDrill) {
    const n = ltArr(cur.nodes).find((x) => x.id === d.id);
    if (!n || !n.cfg.graph) break;
    cur = n.cfg.graph;
  }
  return { graph: cur, task, run, depth: ltDrill.length };
}
/* 图内容包围盒（含边距）与「此刻画布视口」取大者 = viewBox，再叠上这一帧的缩放 / 平移。
   抽出来是因为拖动指针移动里也要按**同一份** viewBox 反算缩放（原来读 svg 上的旧
   viewBox 属性，拖动过程中会越来越偏）。 */
function ltGraphViewBox(g, holderW) {
  let maxX = 0;
  let maxY = 0;
  for (const n of ltArr(g.nodes)) {
    maxX = Math.max(maxX, Number(n.x) + Number(n.w) + 60);
    maxY = Math.max(maxY, Number(n.y) + (n._ltH || Math.max(Number(n.h), 60)) + 60);
  }
  const W = Math.max(maxX, holderW || 900);
  const H = Math.max(maxY, 240);
  const v = ltView();
  const z = v.z > 0 ? v.z : 1;
  if (z === 1 && !v.x && !v.y) return [0, 0, W, H];
  return [v.x, v.y, W / z, H / z];
}
/* ── 长任务画布的缩放 / 平移（需求 3：滚轮缩放）─────────────────────
 * 与主画布同口径：S.cam 存 { x, y, z }，屏幕点 p 对应的图坐标 = (p − 原点) / z。
 * 这里没有 transform 层，缩放全部落在 viewBox 上：viewBox = [x, y, W/z, H/z]，
 * 于是「屏幕 1px = 1/(z*s) 图单位」自动成立，拖动 / 连线读 svg 上的 viewBox 反算，
 * 不需要认识 z。每张画布各存一份（S.wfViews[wfId].ltView），切 Tab 各回各的视野。 */
const LT_ZOOM_MIN = 0.25;
const LT_ZOOM_MAX = 4;
const LT_ZOOM_STEP = 1.12;
/* 节点右下角缩放手柄边长：够手指 / 鼠标抓住，又不至于盖住卡片右下角的「⤵ 下钻」角标 */
const LT_ND_RESIZE = 14;
function ltView(wfIn) {
  const v = ltViewMem(wfIn, false);
  const raw = (v && v.ltView) || null;
  return {
    x: Number(raw && raw.x) || 0,
    y: Number(raw && raw.y) || 0,
    z: Math.max(LT_ZOOM_MIN, Math.min(LT_ZOOM_MAX, Number(raw && raw.z) > 0 ? Number(raw.z) : 1)),
  };
}
function ltViewSet(patch, wfIn) {
  const cur = ltView(wfIn);
  const next = Object.assign({}, cur, patch || {});
  next.z = Math.max(LT_ZOOM_MIN, Math.min(LT_ZOOM_MAX, Number(next.z) > 0 ? Number(next.z) : 1));
  ltClampView(next, wfIn);
  next.x = Math.round(Number(next.x) || 0);
  next.y = Math.round(Number(next.y) || 0);
  ltViewPatch(wfIn, { ltView: next });
  return next;
}
/* 平移边界：与主画布 clampCam()（app.js 11887）同一个 pad —— 视野原点最多把内容推出一个
   pad 的边距，再往外平就只剩空白、找不回来。 */
const LT_PAN_PAD = 640;
/* 当前编辑图的图坐标包围盒（节点卡片真正占的地方；几何口径与 ltGraphViewBox 一致）。 */
function ltGraphBounds(g) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of ltArr(g && g.nodes)) {
    const x = Number(n.x);
    const y = Number(n.y);
    const w = Math.max(Number(n.w) || 0, 0);
    const h = Math.max(Number(n._ltH || n.h) || 0, 0);
    if (![x, y, w, h].every(isFinite)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  if (!isFinite(minX) || !isFinite(minY)) return null;
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}
/* 把「下一档视野」夹回内容附近，避免平移到内容彻底不可见。换算成主画布 cam 的等价量来做：
   cam = 图坐标 (0,0) 的屏幕位置 = 留白 offX − 原点 x·s；s 与 z 成正比、offX / offY 与 z
   无关（限比项与 z 无关），于是主画布那两条式子（minCam = 盒宽 − pad − max·z、
   maxCam = pad − min·z）原样成立，再换算回 viewBox 原点即可。
   量不到盒子（未挂载 / 迷你 DOM 沙箱）或图里没有节点时一律不动：宁可不动也别乱跳。 */
function ltClampView(next, wfIn) {
  try {
    const host = document.querySelector ? document.querySelector(".lt-graph") : null;
    const svg = host && host.querySelector ? host.querySelector("svg.lt-svg") : null;
    if (!host || !svg || typeof svg.getBoundingClientRect !== "function") return;
    const sc = ltGraphScaleOf(ltGraphViewBoxOf(svg, host.clientWidth || 900), svg.getBoundingClientRect());
    if (!(sc.w > 0) || !(sc.h > 0) || !(sc.s > 0)) return;
    const zc = ltView(wfIn).z || 1;
    const zn = Number(next.z) > 0 ? Number(next.z) : zc;
    const s = sc.s * (zn / zc);
    if (!(s > 0)) return;
    const wf = wfIn || (typeof S !== "undefined" && S ? S.wf : null);
    const cur = typeof ltCurGraph === "function" ? ltCurGraph(wf) : null;
    const b = ltGraphBounds(cur && cur.graph);
    if (!b) return;
    const pad = LT_PAN_PAD;
    const m = { x: sc.offX - (Number(next.x) || 0) * s, y: sc.offY - (Number(next.y) || 0) * s };
    const lo = { x: sc.w - pad - b.maxX * s, y: sc.h - pad - b.maxY * s };
    const hi = { x: pad - b.minX * s, y: pad - b.minY * s };
    m.x = lo.x <= hi.x ? Math.max(lo.x, Math.min(hi.x, m.x)) : (lo.x + hi.x) / 2;
    m.y = lo.y <= hi.y ? Math.max(lo.y, Math.min(hi.y, m.y)) : (lo.y + hi.y) / 2;
    next.x = (sc.offX - m.x) / s;
    next.y = (sc.offY - m.y) / s;
  } catch (_) {}
}
/* 点阵网格：与主画布同口径 —— 间距 = 吸附网格（app.js 的 grid()，缺省 24）× **等比系数 s**
   （.lt-svg 是 width/height:100% + xMidYMid meet，限比项是宽高里受限的那一边，见
   ltGraphScaleOf；直接拿 holder.clientWidth / viewBox 宽只在宽度受限时才对），点径 / 颜色
   沿用 .fn-canvas 那份。viewBox 会把内容等比缩放，间距要乘回 s，点阵才与节点的网格坐标
   **真的对齐**（否则图一大点阵就被压缩，看着像没对齐）。
   平移之后原点也得跟着走：点阵偏移 = 图坐标 (0,0) 的屏幕位置对一个点距取模，等价主画布
   syncCanvasGrid() 的 --grid-x / --grid-y（app.js 5707–5709）。 */
function ltGraphGridSync(holder, svg, g) {
  if (!holder) return;
  const grid = typeof ltGrid === "function" ? ltGrid() : 24;
  const hasVb = !!(svg && svg.getAttribute && svg.getAttribute("viewBox"));
  const fallback = ltGraphViewBox(g, holder.clientWidth || 900) || [0, 0, 900, 240];
  const view = hasVb
    ? ltGraphViewBoxOf(svg, holder.clientWidth || 900)
    : { x: 0, y: 0, w: fallback[2] || 900, h: fallback[3] || 240 };
  const sc = ltGraphScaleOf(view, svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null);
  const k = sc.s;
  const cell = Math.max(6, Math.round(grid * k));
  holder.style.setProperty("--lt-grid", cell + "px");
  const ox = sc.offX - Number(view.x || 0) * k;
  const oy = sc.offY - Number(view.y || 0) * k;
  holder.style.setProperty("--lt-grid-x", Math.round(((ox % cell) + cell) % cell) + "px");
  holder.style.setProperty("--lt-grid-y", Math.round(((oy % cell) + cell) % cell) + "px");
}
function ltGraphViewBoxOf(svg, holderW) {
  const vb = (svg && svg.getAttribute("viewBox") ? svg.getAttribute("viewBox") : "0 0 1 1").split(" ").map(Number);
  return { x: vb[0] || 0, y: vb[1] || 0, w: vb[2] || holderW || 900, h: vb[3] || 240 };
}
/* viewBox → 屏幕的**等比**映射。.lt-svg 是 width/height:100%，preserveAspectRatio 走
   默认的 xMidYMid meet：内容按 min(盒宽/viewW, 盒高/viewH) 等比缩放后居中，宽高比不一致时
   长的那一边留白。所以屏幕 1px 对应的图坐标是 1/s（不是 viewBox/盒宽），绝对坐标还要减掉
   留白 offX / offY。原来的写法按 viewBox/盒宽 反着除，图一大（W > 盒宽）节点就只爬鼠标的
   1/s²，看着像「不跟手，落点还偏」。 */
function ltGraphScaleOf(view, rect) {
  const vw = Math.max(1, Number(view && view.w) || 1);
  const vh = Math.max(1, Number(view && view.h) || 1);
  const rw = Number(rect && (rect.width != null ? rect.width : rect.w)) || 0;
  const rh = Number(rect && (rect.height != null ? rect.height : rect.h)) || 0;
  /* 量不到盒子（还没挂载 / 迷你 DOM 沙箱）：退回 1:1，宁可不动也别乱飞 */
  if (!(rw > 0) || !(rh > 0)) return { s: 1, offX: 0, offY: 0, w: 0, h: 0 };
  const s = Math.max(1e-6, Math.min(rw / vw, rh / vh));
  return { s: s, offX: (rw - vw * s) / 2, offY: (rh - vh * s) / 2, w: rw, h: rh };
}
/* 取「此刻真实渲染的那只 svg」的映射：pointerdown 会整块重绘，不能缓存元素。 */
function ltGraphScaleLive(host, svg) {
  const el = svg && svg.getAttribute ? svg : host && host.querySelector ? host.querySelector("svg.lt-svg") : null;
  if (!el || typeof el.getBoundingClientRect !== "function") return { s: 1, offX: 0, offY: 0, w: 0, h: 0 };
  return ltGraphScaleOf(ltGraphViewBoxOf(el, (host && host.clientWidth) || 900), el.getBoundingClientRect());
}
/* 滚轮缩放（需求 3）：**锚定鼠标底下那一点**（与主画布 S.cam 的缩放口径同源：
   nz / z 的比例换原点，光标下的内容不动）。只改 svg 的 viewBox 不整块重绘 ——
   重绘会打断正在拖的指针 / 连线，缩放也会一顿一顿的。 */
function ltGraphWheel(ev, holder, svg, g) {
  if (!holder || !svg) return;
  /* 条带嵌在 .wf-wrap 里，滚轮默认会滚外层；缩放是这里的主语义，直接吃掉 */
  if (ev.preventDefault) ev.preventDefault();
  const cur = ltView();
  const dir = Number(ev.deltaY) < 0 ? 1 : -1;
  const nz = Math.max(LT_ZOOM_MIN, Math.min(LT_ZOOM_MAX, cur.z * (dir > 0 ? LT_ZOOM_STEP : 1 / LT_ZOOM_STEP)));
  const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const sc = ltGraphScaleOf(ltGraphViewBoxOf(svg, (holder && holder.clientWidth) || 900), rect);
  /* 屏幕点 → 图坐标（等比居中留白要先减掉，否则锚点会偏到卡片外） */
  const gx = (Number(ev.clientX) - Number(rect.left || 0) - sc.offX) / sc.s;
  const gy = (Number(ev.clientY) - Number(rect.top || 0) - sc.offY) / sc.s;
  const ratio = nz / (cur.z || 1);
  /* 锚点 = 光标底下那一点。注意 view.x 是 viewBox 的**原点**（不是主画布的 cam）：主画布
     的 cam 在这里的等价量是屏幕位移 m = offX − x·s，按主画布那式换比例
     m' = mx − (mx − m)·ratio，化简即 x' = x + gx·(1 − 1/ratio)
     （gx 已减掉 offX，是「相对视图原点」的图坐标偏移）。旧写法 x' = gx − (gx − x)·ratio
     把视图原点当 cam 用、比例还乘反了，平移（x≠0）之后缩放光标底下的内容会滑走。 */
  const kz = 1 - 1 / ratio;
  const next = ltViewSet({ x: cur.x + gx * kz, y: cur.y + gy * kz, z: nz });
  const box = holder.getBoundingClientRect ? holder.getBoundingClientRect() : { width: 0 };
  svg.setAttribute("viewBox", ltGraphViewBox(g, box.width || 900).join(" "));
  ltGraphGridSync(holder, svg, g);
  /* 百分数回显跟着走（只更新那枚按钮，不整块重绘） */
  const zBtn = holder.parentNode && holder.parentNode.querySelector ? holder.parentNode.querySelector(".lt-btn-zoom") : null;
  if (zBtn) zBtn.textContent = Math.round(next.z * 100) + "%";
}
/* ── 相机手势：平移（与主画布 canvas mousedown/wheel 段同口径）─────────────
 * ① 左键点在空白（ev.target 是 svg / holder，不是 .lt-nd / 端子 / 边）→ 拖动平移；
 * ② 中键（button===1）无论指针在节点还是空白都平移，且不改变当前选中、不触发节点拖动
 *    —— 监听挂在 holder 的**捕获阶段**先吃掉事件，节点自己的 pointerdown 收不到；
 * ③ 平移量用 ltViewSet({x,y}) 累积，拖动期间只改 svg 的 viewBox + 点阵偏移，
 *    绝不 ltRenderStrip（整块重绘会掐断正在进行的指针手势）；
 * ④ 图坐标增量 = 屏幕增量 / 等比系数 s（复用 ltGraphScaleOf 的 offX/offY 换算），
 *    viewBox 左移 = 内容跟着手走，与主画布 S.cam.x = px + dx 的手感一致。
 * 落点与吸附口径仍走 ltSnap，这里一个字都不改。 */
let ltPan = null;
let ltPanWinBound = false;
function ltPanBindWindow() {
  if (ltPanWinBound) return;
  ltPanWinBound = true;
  document.addEventListener("pointermove", ltPanMove, true);
  document.addEventListener("pointerup", ltPanEnd, true);
  document.addEventListener("pointercancel", ltPanEnd, true);
}
/* 同一时刻只允许一种画布手势（平移 / 移节点 / 连线；主画布也只有一个 S.drag）：
   后开始的手势先清掉前一个，否则两者并存时 pointermove 会一边平移画布一边拖节点。
   只清状态、绝不重绘 —— 这些都发生在 pointerdown 里，重绘会把接下来要用的
   holder / svg 换成死元素；被接管的那次平移按「静默收尾」，不当成点空白取消选中。 */
function ltGestureTake(kind) {
  if (kind !== "pan" && ltPan) ltPanEnd(null, true);
  if (kind === "pan" && ltDrag) ltDrag = null;
}
function ltGraphPanDown(ev, holder, svg, g) {
  if (!holder || !svg) return;
  const mid = Number(ev.button) === 1;
  if (!mid && Number(ev.button) !== 0) return;
  if (!mid && ev.target !== svg && ev.target !== holder) return; /* 节点 / 端子 / 边各有自己的 pointerdown */
  if (mid && ev.stopPropagation) ev.stopPropagation();
  if (ev.preventDefault) ev.preventDefault();
  /* 手势互斥：平移一接手，先把可能残留的拖动 / 连线状态清掉（只清状态、不重绘 ——
     holder / svg 马上要拿去平移，重绘会把它们换成死元素） */
  ltGestureTake("pan");
  const cur = ltView();
  const sc = ltGraphScaleLive(holder, svg);
  ltPan = { holder, svg, g, mid, sx: Number(ev.clientX) || 0, sy: Number(ev.clientY) || 0, px: cur.x, py: cur.y, s: sc.s > 0 ? sc.s : 1, moved: false };
  if (holder.classList) holder.classList.add("is-panning");
  ltPanBindWindow();
}
function ltPanMove(ev) {
  if (!ltPan) return;
  /* 鼠标已松开（鼠标移出后松开导致 up 丢失）：收工，别让陈旧状态继续吃事件 */
  if (ev.buttons !== undefined && (ev.buttons & (ltPan.mid ? 4 : 1)) === 0) {
    ltPanEnd();
    return;
  }
  const dx = (Number(ev.clientX) || 0) - ltPan.sx;
  const dy = (Number(ev.clientY) || 0) - ltPan.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) ltPan.moved = true;
  const s = ltPan.s > 0 ? ltPan.s : 1;
  ltViewSet({ x: ltPan.px - dx / s, y: ltPan.py - dy / s });
  const box = ltPan.holder.getBoundingClientRect ? ltPan.holder.getBoundingClientRect() : { width: 0 };
  ltPan.svg.setAttribute("viewBox", ltGraphViewBox(ltPan.g, box.width || 900).join(" "));
  ltGraphGridSync(ltPan.holder, ltPan.svg, ltPan.g);
}
function ltPanEnd(ev, silent) {
  if (!ltPan) return;
  const p = ltPan;
  ltPan = null;
  if (p.holder && p.holder.classList) p.holder.classList.remove("is-panning");
  /* 左键在空白按下、又没真的拖动过 = 点空白「取消选中」（与主画布 mouseup 的
     `!moved && !wasMid → clearSelection + renderCanvas` 同口径：清空 ltSel 再重绘一次）；
     中键平移不改选中，被别的手势接管（silent）时也不改。 */
  if (silent || p.moved || p.mid) return;
  ltSel.path = "";
  ltSel.edge = "";
  ltRenderStrip();
}
/* ── 图内拖动：监听挂 document（capture），不挂「那一帧」的 svg ──────────
   pointerdown 里要 ltRenderStrip() 换选中态与右侧检查器，而它是 main.innerHTML = ""
   整块重建 —— 连 svg 一起换掉。挂在旧 svg / 旧节点组上的 pointermove / pointerup 当场
   变成死监听：拖动过程一个事件都收不到，松手重绘后节点才「跳」到按错系数算出的落点，
   于是「拖动不跟鼠标、落点也错」。改挂 document 后不受重绘影响，鼠标拖出画布也照样跟手；
   被拖的节点组每帧按 data-lt-id 现找当前这一帧的元素。 */
let ltDragWinBound = false;
function ltDragBindWindow() {
  if (ltDragWinBound) return;
  ltDragWinBound = true;
  document.addEventListener("pointermove", ltDragMove, true);
  document.addEventListener("pointerup", ltDragEnd, true);
  document.addEventListener("pointercancel", ltDragEnd, true);
  document.addEventListener("keydown", ltDragKey, true);
}
/* ── 连线橡皮筋预览：只改 dom，不重绘 ─────────────────────────────────
   一条跟随鼠标的临时 path（class lt-edge-temp），挂在**当前这一帧**的 svg 末尾。
   拖动期间绝不 ltRenderStrip()（重绘会换掉 svg、掐断手势）；松手 / Esc / pointercancel
   一律先把它摘掉，不留残线。 */
function ltWireTempEnsure(host, svg) {
  const el = svg || (host && host.querySelector ? host.querySelector("svg.lt-svg") : null);
  if (!el || !el.appendChild) return null;
  const old = el.querySelector ? el.querySelector("path.lt-edge-temp") : null;
  if (old) return old;
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("class", "lt-edge lt-edge-temp");
  p.setAttribute("d", "");
  el.appendChild(p);
  return p;
}
function ltWireTempDrop(host, svg) {
  const roots = [];
  if (svg && svg.querySelectorAll) roots.push(svg);
  if (host && host.querySelectorAll) roots.push(host);
  for (const root of roots) {
    const els = root.querySelectorAll("path.lt-edge-temp");
    for (const el of els) if (el.parentNode) el.parentNode.removeChild(el);
  }
}
/* 屏幕点 → 图坐标（绝对坐标，全画布唯一一份绝对换算）：等比居中留白先减掉、再按 1/s 放大，
   **最后加上 viewBox 原点 view.x / view.y**。平移把 viewBox 原点写成非零（ltGraphViewBox 的
   [v.x, v.y, …]），漏掉这一项时整条换算就整体偏一个「平移量」：橡皮筋虚线末尾停在离鼠标
   (view.x·s, view.y·s) 像素的地方（平移越远偏得越多），落点命中也会跟着偏一个原点。
   拖动中的**增量**（ltDragMove / pointerdown 起点）两边都走同一个坐标系，原点自动抵消，
   所以那里不受影响。 */
function ltGraphPointOf(svg, clientX, clientY) {
  const r = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, top: 0 };
  const host = svg && typeof svg.closest === "function" ? svg.closest(".lt-graph") : null;
  const sc = ltGraphScaleLive(host, svg);
  const view = ltGraphViewBoxOf(svg, (host && host.clientWidth) || 900);
  return {
    x: (Number(clientX) - Number(r.left || 0) - sc.offX) / sc.s + (Number(view.x) || 0),
    y: (Number(clientY) - Number(r.top || 0) - sc.offY) / sc.s + (Number(view.y) || 0),
  };
}
function ltWirePoint(svg, ev) {
  return ltGraphPointOf(svg, ev && ev.clientX, ev && ev.clientY);
}
/* ── 拖动 / 连线期间「活的那份图」────────────────────────────────────
   ltRenderStrip() 每次都走 ltEnsure()，而 ltEnsure 会把 wf.longtask.tasks 整批换成
   ltNormGraph() 深拷贝出来的**新对象**（节点也是新对象）。节点 pointerdown 里那次
   ltRenderStrip()（换选中态 / 右侧检查器）一发生，pointerdown 之前抓到的 g 就成了孤儿：
   之后把节点坐标、新建的边写进去，全落在孤儿对象上；一松手整块重绘读的是活图，
   改动一起丢 —— 症状就是「节点拖了不生效、拖完弹回原位」「连线拖到节点上也不建边」。
   所以每帧都按 wf + 当前下钻层重新解析活图，绝不跨重绘复用 g。 */
function ltLiveGraph(wf, fallback) {
  try {
    const cur = typeof ltCurGraph === "function" ? ltCurGraph(wf) : null;
    if (cur && cur.graph && cur.graph !== fallback) return cur.graph;
    if (cur && cur.graph) return cur.graph;
  } catch (_) {}
  return fallback || null;
}
/* 右键菜单 / Delete 键**落笔那一刻**要写的对象：与拖动手势的 ltLiveGraph 同一口径。
   开菜单前 ltGraphCtxMenu() 会先 ltRenderStrip()，而它每次都走 ltEnsure() —— 那一步把
   wf.longtask.tasks 整批换成 ltNormGraph() 深拷贝出来的**新对象**（节点也是新对象）。
   于是事件闭包里抓到的 task / g 当场变成孤儿：节点写进孤儿 = 一重绘就没了，界面上
   一个字都不变 —— 症状正是「长任务画布右键创建无效」（删除选中同理，静默失效）。
   所以这里按 wf + 当前下钻层重新解析活任务 / 活图，只在解析不到时才回落到手头这两份。 */
function ltLiveTarget(task, g) {
  try {
    const wf = typeof S !== "undefined" ? S.wf : null;
    const cur = wf && typeof ltCurGraph === "function" ? ltCurGraph(wf) : null;
    if (cur && cur.graph) return { task: cur.task || task || null, graph: cur.graph };
  } catch (_) {}
  return { task: task || null, graph: g || null };
}
/* 边的几何（与渲染同源：右侧端子中点 → 左侧中点，三次贝塞尔控制点在正中）。
   抽出来是给拖动节点时就地改 d 用 —— 拖动期间不整块重绘，连线也要跟着节点走。 */
function ltEdgeGeo(a, b) {
  const x1 = Number(a.x) + Number(a.w);
  const y1 = Number(a.y) + (a._ltH || Math.max(Number(a.h), 56)) / 2;
  const x2 = Number(b.x);
  const y2 = Number(b.y) + (b._ltH || Math.max(Number(b.h), 56)) / 2;
  const mx = (x1 + x2) / 2;
  return { d: "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2, x1: x1, y1: y1, x2: x2, y2: y2, mx: mx };
}
/* 拖动节点时就地刷新与它相连的边（含边上的标签）：只改 dom，不重绘 —— 重绘会掐断
   正在进行的 Pointer 手势（旧版连线要等松手才动，看着就是「连线没跟随鼠标」）。 */
function ltDragEdgesSync(g, host, id) {
  const svg = host && host.querySelector ? host.querySelector("svg.lt-svg") : null;
  if (!svg || !svg.querySelectorAll) return;
  const nodes = ltArr(g && g.nodes);
  const paths = svg.querySelectorAll("path.lt-edge[data-lt-edge]");
  const labels = svg.querySelectorAll("text.lt-edge-label[data-lt-edge-label]");
  const geoOf = {};
  for (const e of ltArr(g && g.edges)) {
    if (!e || (e.from !== id && e.to !== id)) continue;
    const a = nodes.find((n) => n.id === e.from);
    const b = nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    geoOf[String(e.id)] = ltEdgeGeo(a, b);
  }
  for (const p of paths) {
    const geo = geoOf[p.getAttribute("data-lt-edge")];
    if (geo) p.setAttribute("d", geo.d);
  }
  for (const t of labels) {
    const geo = geoOf[t.getAttribute("data-lt-edge-label")];
    if (!geo) continue;
    t.setAttribute("x", geo.mx);
    t.setAttribute("y", (geo.y1 + geo.y2) / 2 - 6);
  }
}
function ltDragHost() {
  return document.querySelector ? document.querySelector(".lt-graph") : null;
}
function ltDragGroupOf(host, path) {
  if (!host || !host.querySelector) return null;
  try {
    return host.querySelector('g.lt-nd[data-lt-id="' + String(path).replace(/["\\]/g, "") + '"]');
  } catch (_) {
    return null;
  }
}
function ltDragMove(ev) {
  if (!ltDrag) return;
  /* 鼠标移出画布 / 窗口后松手（pointerup 丢在窗外）：buttons===0 说明键早就松开了，
     当场清掉悬空拖动状态，否则陈旧状态会继续吃后续 pointermove。连线只摘掉橡皮筋，
     绝不按当前位置补线。 */
  if (ev.buttons !== undefined && ev.buttons === 0) {
    if (ltDrag.mode === "wire") {
      const h0 = ltDragHost() || ltDrag.host;
      const s0 = (h0 && h0.querySelector ? h0.querySelector("svg.lt-svg") : null) || ltDrag.svg;
      ltWireTempDrop(h0, s0);
      if (h0 && h0.classList) h0.classList.remove("is-panning");
      ltDrag = null;
      ltRenderStrip();
      return;
    }
    ltDragEnd(ev);
    return;
  }
  if (ltDrag.mode === "wire") {
    /* 橡皮筋：起点固定在源节点右侧端子，终点跟鼠标；只更新这一条 path 的 d */
    const host = ltDragHost() || ltDrag.host;
    const svg = (host && host.querySelector ? host.querySelector("svg.lt-svg") : null) || ltDrag.svg;
    if (!svg) return;
    /* 落点命中要按**活图**判（重绘会把 task.graph 换成深拷贝） */
    const g = ltLiveGraph(ltDrag.wf, ltDrag.g);
    if (g) ltDrag.g = g;
    const p = ltWireTempEnsure(host, svg);
    if (!p) return;
    const to = ltWirePoint(svg, ev);
    const mx = (Number(ltDrag.wx) + to.x) / 2;
    p.setAttribute("d", "M" + ltDrag.wx + "," + ltDrag.wy + " C" + mx + "," + ltDrag.wy + " " + mx + "," + to.y + " " + to.x + "," + to.y);
    return;
  }
  if (ltDrag.mode === "ltresize") {
    /* 3px 阈值（与 move 同口径）：没真的移动过就不改尺寸 —— 纯点一下不算缩放 */
    const rdx = (Number(ev.clientX) || 0) - ltDrag.x0;
    const rdy = (Number(ev.clientY) || 0) - ltDrag.y0;
    if (!ltDrag.moved) {
      if (Math.abs(rdx) + Math.abs(rdy) <= 3) return;
      ltDrag.moved = true;
    }
    /* 每帧重新解析「活的那份图」（见 ltLiveGraph）：拖动手势期间任何一次重绘都会把
       task.graph 换成深拷贝，写到孤儿上的 w/h 一松手就丢（与 move 分支同一个坑）。 */
    const g = ltLiveGraph(ltDrag.wf, ltDrag.g) || ltDrag.g;
    ltDrag.g = g;
    const n = ltArr(g && g.nodes).find((x) => x.id === ltDrag.id);
    if (!n) return;
    const host = ltDragHost();
    const svg = host && host.querySelector ? host.querySelector("svg.lt-svg") : null;
    /* 增量按**当帧**映射换算（与 move 分支同源）：起点在 pointerdown 存成图坐标 gx0/gy0，
       这里再把鼠标当前点换算成图坐标，两者相减即为图增量；拖动中途缩放 / 平移也不跳。 */
    const sc = ltGraphScaleLive(host, svg);
    const s = sc && sc.s > 0 ? sc.s : 1;
    const rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    let dx;
    let dy;
    if (rect && ltDrag.gx0 != null && ltDrag.gy0 != null) {
      dx = (Number(ev.clientX) - Number(rect.left || 0) - sc.offX) / s - ltDrag.gx0;
      dy = (Number(ev.clientY) - Number(rect.top || 0) - sc.offY) / s - ltDrag.gy0;
    } else {
      dx = rdx / s;
      dy = rdy / s;
    }
    /* 宽度吸附网格（文字截断列数由宽度算出，不吸附会在拖动中来回跳），下限 140 保证标题 /
       摘要还排得下；高度不低于内容所需（子任务行决定，与 ltNodeRenderH 同源）。
       拉宽后显示更多说明文字是**松手整块重绘**时按新宽度重新截断的事，拖动中只改几何。 */
    const snapFn = typeof ltSnap === "function" ? ltSnap : (v) => Math.round(Number(v) || 0);
    const minH = ltNodeRenderH({ h: 0, _ltRows: n._ltRows });
    n.w = Math.max(140, snapFn(ltDrag.w0 + dx));
    n.h = Math.max(minH, snapFn(ltDrag.h0 + dy));
    n._ltH = ltNodeRenderH(n); /* 渲染高度现算现用：连线端点 / 裁剪层 / 下钻角标都读它 */
    /* 就地改当前这一帧的卡片：面板 rect、右下角手柄、右侧端子（连线端点跟着走）——
       绝不整块重绘，重绘会掐断正在进行的 Pointer 手势。找不到帧（重绘换了帧）安全降级：
       只跳过这一帧的 DOM 同步，w/h 照常落在活图上，松手整块重绘补回来。 */
    const el = ltDragGroupOf(host, ltDrag.path);
    if (el && el.setAttribute) {
      el.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
      const panel = el.querySelector ? el.querySelector("rect") : null; /* 组内第一个 rect = 卡片面板 */
      if (panel) {
        panel.setAttribute("width", n.w);
        panel.setAttribute("height", n._ltH);
      }
      const grip = el.querySelector ? el.querySelector("rect.lt-nd-resize") : null;
      if (grip) {
        grip.setAttribute("x", n.w - LT_ND_RESIZE);
        grip.setAttribute("y", n._ltH - LT_ND_RESIZE);
      }
      const pc = el.querySelector ? el.querySelector("circle.lt-port") : null;
      if (pc) {
        pc.setAttribute("cx", n.w);
        pc.setAttribute("cy", n._ltH / 2);
      }
    } else ltDrag.domMiss = true;
    /* 裁剪层的矩形也跟着改：否则缩小时文字仍按旧尺寸裁剪，会短暂探出新卡片外
       （松手整块重绘才归位）。clipPath 挂在 svg 上，按 id 找当帧那一枚。 */
    if (svg && svg.querySelector && ltDrag.clip) {
      const cp = svg.querySelector("#" + ltDrag.clip);
      const cpr = cp && cp.querySelector ? cp.querySelector("rect") : null;
      if (cpr) {
        cpr.setAttribute("width", n.w);
        cpr.setAttribute("height", n._ltH);
      }
    }
    /* 相连的边跟着走：就地改 d（不整块重绘，否则线要到松手才动） */
    ltDragEdgesSync(g, host, ltDrag.id);
    return;
  }
  if (ltDrag.mode !== "move") return;
  /* 3px 阈值（与主画布 S.drag 的 moved 同口径）：没真的移动过就不写坐标、也不算拖动 */
  const pdx = (Number(ev.clientX) || 0) - ltDrag.x0;
  const pdy = (Number(ev.clientY) || 0) - ltDrag.y0;
  if (!ltDrag.moved) {
    if (Math.abs(pdx) + Math.abs(pdy) <= 3) return;
    ltDrag.moved = true;
  }
  /* 每帧重新解析「活的那份图」（见 ltLiveGraph）：pointerdown 里的 ltRenderStrip() 会把
     task.graph 整份换成深拷贝，pointerdown 之前抓的 ltDrag.g 已是孤儿 —— 写到孤儿上的
     坐标一松手就丢（症状：节点拖了不动 / 拖完弹回原位）。 */
  const g = ltLiveGraph(ltDrag.wf, ltDrag.g) || ltDrag.g;
  ltDrag.g = g;
  const n = ltArr(g && g.nodes).find((x) => x.id === ltDrag.id);
  if (!n) return;
  const host = ltDragHost();
  const svg = host && host.querySelector ? host.querySelector("svg.lt-svg") : null;
  /* 拖动中给 holder 挂 is-panning（主画布 canvas.is-panning 同口径）：整棵子树显示抓取光标 */
  if (host && host.classList) host.classList.add("is-panning");
  const sc = ltGraphScaleLive(host, svg);
  const s = sc && sc.s > 0 ? sc.s : 1;
  /* 增量一律按**当帧**的映射换算（主画布 S.drag 用当帧 z 的同一口径）：
     起点在 pointerdown 那刻就存成图坐标（gx0/gy0），这里再把鼠标当前点按当帧 s 与
     居中留白换算成图坐标，两者相减即为图增量。拖动中途滚轮缩放 / 平移改了 s 与
     viewBox，落点也不会按旧基准「跳」。量不到盒子时才退回「屏幕增量 / 当前 s」。 */
  const rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
  let dx;
  let dy;
  if (rect && ltDrag.gx0 != null && ltDrag.gy0 != null) {
    dx = (Number(ev.clientX) - Number(rect.left || 0) - sc.offX) / s - ltDrag.gx0;
    dy = (Number(ev.clientY) - Number(rect.top || 0) - sc.offY) / s - ltDrag.gy0;
  } else {
    dx = pdx / s;
    dy = pdy / s;
  }
  /* 边拖边吸：落点一律是网格整数倍，松手后重绘也不跳 */
  const snapFn = typeof ltSnap === "function" ? ltSnap : (v) => Math.round(Number(v) || 0);
  const raw = { x: ltDrag.nx + dx, y: ltDrag.ny + dy };
  n.x = Math.max(0, snapFn(raw.x));
  n.y = Math.max(0, snapFn(raw.y));
  /* 按 data-lt-id 找当前这一帧的节点组：找不到（重绘换了帧 / 下钻路径变了）安全降级 ——
     只跳过这一帧的 DOM 同步（模型坐标照常落，收尾时整块重绘补回来），绝不抛错或空转 */
  const el = ltDragGroupOf(host, ltDrag.path);
  if (el && el.setAttribute) el.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
  else ltDrag.domMiss = true;
  /* 连线跟着节点走：就地改相连边的 d（不整块重绘，否则手势被掐断、线要到松手才动） */
  ltDragEdgesSync(g, host, ltDrag.id);
}
/* Esc：干净收尾 —— 摘掉临时线、ltDrag 置空，再重绘一次把视图拉回一致 */
function ltDragKey(ev) {
  if (!ltDrag) return;
  const key = ev && (ev.key || ev.keyCode);
  if (key !== "Escape" && key !== "Esc" && key !== 27) return;
  if (ev.preventDefault) ev.preventDefault();
  const host = ltDragHost() || ltDrag.host;
  const svg = (host && host.querySelector ? host.querySelector("svg.lt-svg") : null) || ltDrag.svg;
  ltWireTempDrop(host, svg);
  ltDrag = null;
  if (host && host.classList) host.classList.remove("is-panning");
  ltRenderStrip();
}
function ltDragEnd(ev) {
  if (!ltDrag) return;
  /* pointercancel（触控被系统接管 / 手势中断）：只收尾，不连线 */
  const cancelled = !!(ev && ev.type === "pointercancel");
  /* 这一次收尾到底要不要整块重绘：只在该重绘时才重绘，避免「点一下也重绘」的重复劳动 */
  let needRender = false;
  if (ltDrag.mode === "wire") {
    const host = ltDragHost() || ltDrag.host;
    const svg = (host && host.querySelector ? host.querySelector("svg.lt-svg") : null) || ltDrag.svg;
    ltWireTempDrop(host, svg); /* 先摘临时线：落空白 / 自身即「取消并还原」 */
    /* 建边必须写进**活图**：ltDrag.g 可能是 pointerdown 之前那一份深拷贝的孤儿，
       写进去的边一重绘就没了（症状：拖半天连不上）。 */
    const g = ltLiveGraph(ltDrag.wf, ltDrag.g) || ltDrag.g;
    ltDrag.g = g;
    const target = !cancelled && svg && ev ? ltHitNode(g, svg, ev) : "";
    if (target && target !== ltDrag.from) {
      g.edges.push({ id: "e_" + ltDrag.from + "_" + target + "_" + Date.now().toString(36), from: ltDrag.from, to: target, label: "", cond: "" });
      /* 连上就按上游声明自动预选 map / output 的目标键（空着才补） */
      ltPreselectAfterWire(g, ltDrag.from, target);
      if (typeof scheduleSave === "function") scheduleSave(true);
      needRender = true; /* 新边要按新坐标画出来，这次重绘有意义 */
    }
  } else if (ltDrag.mode === "ltresize") {
    /* 缩放：真的拖过（或中途 DOM 同步落空过）才重绘 —— 松手整块重绘后文字按**新宽度**
       重新截断，拉宽即显示更多说明文字；moved 时 w/h 已落在 task.graph 里，随画布存盘。 */
    needRender = !!(ltDrag.moved || ltDrag.domMiss);
    if (needRender && typeof scheduleSave === "function") scheduleSave(true);
  } else {
    /* 移动：只有真的拖动过（或中途 DOM 同步落空过）才需要重绘把连线归位；
       纯点选在 pointerdown 已经重绘过，这里再整块重绘纯属重复劳动 */
    needRender = !!(ltDrag.moved || ltDrag.domMiss);
    if (needRender && typeof scheduleSave === "function") scheduleSave(true);
  }
  ltDrag = null;
  const h1 = ltDragHost();
  if (h1 && h1.classList) h1.classList.remove("is-panning"); /* 收尾摘掉拖动中的抓取光标 */
  if (needRender) ltRenderStrip();
}
function ltRenderGraph(left, wf, task, run, graph) {
  void graph;
  const cur = ltCurGraph(wf) || { graph: task.graph, depth: 0 };
  const g = cur.graph;
  /* 面包屑 */
  const crumb = ltEl("div", "lt-crumb");
  const mk = (label, depth) => {
    const b = ltEl("button", "lt-crumb-i" + (depth === ltDrill.length ? " on" : ""), label);
    b.type = "button";
    b.onclick = () => {
      ltDrill = ltDrill.slice(0, depth);
      ltSel.path = "";
      ltRenderStrip();
    };
    crumb.appendChild(b);
  };
  /* 根条目 = 当前长任务名（不再是写死的「主图」），点它就是任务清单：换一张旧长任务 / 新建一张。
     `task` 是这一帧正在画的那张（ltRenderMain 传进来的 ltActiveTask || ltEnabledTask），
     所以「写名字的那张」与「图上画的那张」永远是同一张，不会图文不符。 */
  const rootBtn = ltCrumbTaskBtn(wf, task, 0);
  crumb.appendChild(rootBtn);
  ltDrill.forEach((d, i) => mk(d.title || ltT("子图"), i + 1));
  const rv = run && run.graph ? Number(run.graph.ver) || 1 : 0;
  if (run && rv && Number(task.ver) > rv) {
    const hint = ltEl("span", "lt-crumb-hint", ltT("图已改到 v") + task.ver + ltT("，当前 run 仍按启用那刻的 v") + rv + ltT(" 在跑（重新启用才生效）"));
    crumb.appendChild(hint);
  }
  /* 缩放回显 + 复位：滚轮就能缩放，但缩到哪了得看得见、回得来。
     它挂在**第一行**（面包屑这一行）的右端（margin-left:auto 顶到最右，见 CSS
     .lt-crumb .lt-btn-zoom）—— 以前它自己独占一条工具条（.lt-gbar），一枚 40px 的小件
     吃掉一整行高度，纯属浪费空间（本次需求：别独占一行）。加节点与「删除选中」更早
     就已搬进图内右键菜单（ltGraphCtxMenu，空白 / 节点 / 连线上都能叫出来），删除另按
     Delete 键（ltGraphKeyDown），所以那条带子整条撤掉，画布白赚一行高度。 */
  const view = ltView();
  const zBtn = ltBtn(Math.round(view.z * 100) + "%", "lt-btn lt-btn-zoom", () => {
    ltViewSet({ x: 0, y: 0, z: 1 });
    ltRenderStrip();
  });
  zBtn.title = ltT("滚轮缩放 · 点一下回到 100%");
  crumb.appendChild(zBtn);
  left.appendChild(crumb);
  /* 画布 */
  const holder = ltEl("div", "lt-graph");
  holder.tabIndex = 0;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "lt-svg");
  holder.appendChild(svg);
  holder.addEventListener("wheel", (ev) => ltGraphWheel(ev, holder, svg, g), { passive: false });
  /* 平移手势挂捕获阶段：中键要能在节点 / 端子上先被接管（它们自己的 pointerdown 会 stopPropagation） */
  holder.addEventListener("pointerdown", (ev) => ltGraphPanDown(ev, holder, svg, g), true);
  /* 右键菜单（本次需求：加节点 / 删除选中都收进这里）——空白、节点、连线上都能叫出来。
     非捕获阶段：节点 / 端子 / 边的 pointerdown 只处理左中键，会先 return 掉，不会抢走右键。 */
  holder.addEventListener("contextmenu", (ev) => ltGraphCtxMenu(ev, task, g, svg));
  /* Delete 键 = 删除选中的节点 / 连线（本次需求：删除不再需要点按钮）。
     挂在 holder 上而不是 document：左栏聊天框 / 设置窗里的 Backspace 绝不能被当成「删节点」。 */
  holder.addEventListener("keydown", (ev) => ltGraphKeyDown(ev, task, g));
  left.appendChild(holder);
  const box = holder.getBoundingClientRect();
  const prefix = ltDrill.map((d) => d.id).join("/");
  /* 先给每个节点算一份「这一帧的渲染几何」：子任务行（需求 2）决定卡片高度，
     连线的起终点与 viewBox 包围盒都读同一份 —— 否则线会连到卡片内部或浮在卡片外。 */
  for (const n of ltArr(g.nodes)) {
    const path = prefix ? prefix + "/" + n.id : n.id;
    const st = run && run.nodes ? run.nodes[path] : null;
    n._ltRows = ltTaskRows(run, path, n, st, Math.max(60, Number(n.w) - 20));
    n._ltH = ltNodeRenderH(n);
  }
  const vb = ltGraphViewBox(g, box.width || 900);
  svg.setAttribute("viewBox", vb.join(" "));
  ltGraphGridSync(holder, svg, g);
  /* 边 */
  for (const e of ltArr(g.edges)) {
    const a = ltArr(g.nodes).find((n) => n.id === e.from);
    const b = ltArr(g.nodes).find((n) => n.id === e.to);
    if (!a || !b) continue;
    const geo = ltEdgeGeo(a, b);
    const fired = run && run.fired && run.fired[e.id];
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", geo.d);
    /* 拖动节点时要按 id 找回这条边就地改 d（连线跟随鼠标，不整块重绘），
       所以 id 写在属性上 —— 渲染顺序 / 数量变化都不影响查找。 */
    p.setAttribute("data-lt-edge", String(e.id));
    p.setAttribute("class", "lt-edge" + (fired ? " fired" : "") + (String(e.cond || "").trim() ? " cond" : "") + (ltSel.edge === e.id ? " sel" : ""));
    p.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ltSel.edge = e.id;
      ltSel.path = "";
      ltRenderStrip();
    });
    svg.appendChild(p);
    if (e.label || e.cond) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", geo.mx);
      t.setAttribute("y", (geo.y1 + geo.y2) / 2 - 6);
      t.setAttribute("class", "lt-edge-label");
      t.setAttribute("data-lt-edge-label", String(e.id));
      t.textContent = String(e.label || (e.cond ? ltT("条件") : ""));
      svg.appendChild(t);
    }
  }
  /* 节点 */
  for (const n of ltArr(g.nodes)) {
    const path = prefix ? prefix + "/" + n.id : n.id;
    const st = run && run.nodes ? run.nodes[path] : null;
    const status = st ? st.status : "pending";
    const grp = document.createElementNS("http://www.w3.org/2000/svg", "g");
    grp.setAttribute("class", "lt-nd lt-k-" + n.kind + " lt-s-" + status + (LT_BREATH[status] ? " lt-breath" : "") + (ltSel.path === path ? " sel" : ""));
    grp.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("width", n.w);
    rect.setAttribute("height", n._ltH || Math.max(n.h, 56));
    rect.setAttribute("rx", 8);
    grp.appendChild(rect);
    /* 卡片内宽（文字左右各留 10px）与「这一帧真实渲染高度」：文字截断列数由内宽现算。 */
    const ltInnerW = Math.max(60, Number(n.w) - 20);
    const ltCardH = n._ltH || Math.max(Number(n.h) || 0, 56);
    /* 兜底裁剪：SVG <text> 不会被 rect 挡住，任何异常长串（无空格长词 / 未来新增文字）
       都会画到卡片外。给每个节点挂一枚按 path 生成唯一 id 的 <clipPath>（矩形同卡片尺寸），
       文字层单独包一层 g 受它裁剪 —— 端子 / 下钻角标在卡片外沿，不放进裁剪层。
       截断是「好看」，裁剪是「不可能漏出去」的兜底，两道一起上。 */
    const ltClip = ltClipId(path);
    const ltCp = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
    ltCp.setAttribute("id", ltClip);
    const ltCr = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    ltCr.setAttribute("width", n.w);
    ltCr.setAttribute("height", ltCardH);
    ltCr.setAttribute("rx", 8);
    ltCp.appendChild(ltCr);
    svg.appendChild(ltCp);
    const ltTexts = document.createElementNS("http://www.w3.org/2000/svg", "g");
    ltTexts.setAttribute("clip-path", "url(#" + ltClip + ")");
    grp.appendChild(ltTexts);
    const kind = document.createElementNS("http://www.w3.org/2000/svg", "text");
    kind.setAttribute("class", "lt-nd-kind");
    kind.setAttribute("x", 10);
    kind.setAttribute("y", 16);
    kind.textContent = ltKindLabel(n.kind);
    ltTexts.appendChild(kind);
    /* 版本轮次角标（每节点第几轮 · 可点开回看）：标题的列预算里先扣掉它，两者不再叠压 */
    const rounds = st && st.rounds ? st.rounds.length : 0;
    const roundTxt = rounds ? "R" + rounds : "";
    const roundW = roundTxt ? ltTextCols(roundTxt) * 9 * 0.6 + 8 : 0;
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("class", "lt-nd-title");
    t.setAttribute("x", 10);
    t.setAttribute("y", 34);
    t.textContent = ltBrk(n.title, ltColsOf(ltInnerW - roundW, 13));
    ltTexts.appendChild(t);
    const sub = document.createElementNS("http://www.w3.org/2000/svg", "text");
    sub.setAttribute("class", "lt-nd-sub");
    sub.setAttribute("x", 10);
    sub.setAttribute("y", 50);
    sub.textContent = ltNodeSummary(run, path, n, st, ltInnerW);
    ltTexts.appendChild(sub);
    /* 需求 2：状态节点在画布上列出这一环的子任务（🤖 AI 自动 / ✋ 需人工 / ⤵ 子图成员）。
       行从 y=64 起，行距 14（与 ltNodeRenderH 的 70+N*14 同一口径）；每行一条 text，
       「需人工」那几行挂 lt-nd-need 上色，跑起来一眼看出哪几条卡在人身上。 */
    const rows = n._ltRows || [];
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri];
      const rt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      rt.setAttribute("class", "lt-nd-task" + (r.human ? " lt-nd-need" : ""));
      rt.setAttribute("x", 10);
      rt.setAttribute("y", 64 + ri * 14);
      rt.setAttribute("data-lt-task", String(ri));
      rt.textContent = r.icon + " " + r.text;
      ltTexts.appendChild(rt);
    }
    /* 版本轮次角标（每节点第几轮 · 可点开回看）—— rounds 已在标题之上算过 */
    if (rounds) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "text");
      c.setAttribute("class", "lt-nd-round");
      c.setAttribute("x", Number(n.w) - 10);
      c.setAttribute("y", 16);
      c.setAttribute("text-anchor", "end");
      c.textContent = roundTxt;
      ltTexts.appendChild(c);
    }
    if (n.kind === "sub" || n.kind === "map") {
      const z = document.createElementNS("http://www.w3.org/2000/svg", "text");
      z.setAttribute("class", "lt-nd-drill");
      z.setAttribute("x", Number(n.w) - 10);
      z.setAttribute("y", ltCardH - 8);
      z.setAttribute("text-anchor", "end");
      z.textContent = "⤵ " + ltT("下钻");
      ltTexts.appendChild(z);
    }
    /* 端子：右侧拖出连线 */
    const port = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    port.setAttribute("class", "lt-port");
    port.setAttribute("cx", n.w);
    port.setAttribute("cy", (n._ltH || Math.max(n.h, 56)) / 2);
    port.setAttribute("r", 6);
    port.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ltGestureTake("drag"); /* 手势互斥：连线一接手，先清掉可能在跑的平移 */
      /* 起点 = 源节点右侧端子中心（与渲染同源：_ltH 撑高后的中点），橡皮筋从这儿起。
         wf 存下来：拖动期间要按它重新解析活图（ltRenderStrip 会把 task.graph 换成深拷贝）。 */
      ltDrag = { mode: "wire", from: n.id, wf: wf, g: g, host: holder, svg: svg, x: ev.clientX, y: ev.clientY, wx: Number(n.x) + Number(n.w), wy: Number(n.y) + (n._ltH || Math.max(Number(n.h), 56)) / 2 };
      ltDragBindWindow();
    });
    grp.appendChild(port);
    /* 右下角缩放手柄：拖它调卡片大小，拉宽后文字按新宽度重新截断（松手整块重绘时算），
       即「拖大看更多说明文字」。常态透明、hover 才显形（CSS .lt-nd-resize），光标
       nwse-resize 与主画布同口径；放在最后 = 覆盖在卡片角上，是这一角唯一的命中区。
       pointerdown 里 stopPropagation：别让 group 的「移动」分支同时接手（那会变成拖节点）。 */
    const rs = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rs.setAttribute("class", "lt-nd-resize");
    rs.setAttribute("x", Number(n.w) - LT_ND_RESIZE);
    rs.setAttribute("y", ltCardH - LT_ND_RESIZE);
    rs.setAttribute("width", LT_ND_RESIZE);
    rs.setAttribute("height", LT_ND_RESIZE);
    rs.setAttribute("rx", 3);
    rs.addEventListener("pointerdown", (ev) => {
      if (Number(ev.button) !== 0) return; /* 中键交给平移、右键留给上下文菜单 */
      ev.stopPropagation();
      ltGestureTake("drag"); /* 手势互斥：缩放一接手，先清掉可能在跑的平移 */
      /* 起点与 move 分支同口径：按**当帧**映射存成图坐标（gx0/gy0），拖动中途滚轮缩放 / 平移
         改了 s 与 viewBox，增量仍按当帧换算，卡片尺寸不会按旧基准跳。 */
      const rect0 = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
      const sc0 = ltGraphScaleLive(holder, svg);
      const s0 = sc0 && sc0.s > 0 ? sc0.s : 1;
      ltDrag = {
        mode: "ltresize",
        id: n.id,
        path: path,
        wf: wf,
        g,
        host: holder,
        svg,
        x0: Number(ev.clientX) || 0,
        y0: Number(ev.clientY) || 0,
        w0: Number(n.w) || 0,
        h0: Number(n.h) || 0,
        gx0: rect0 ? ((Number(ev.clientX) || 0) - Number(rect0.left || 0) - sc0.offX) / s0 : null,
        gy0: rect0 ? ((Number(ev.clientY) || 0) - Number(rect0.top || 0) - sc0.offY) / s0 : null,
        moved: false,
        clip: ltClip, /* 这帧的裁剪层 id：拖动中要跟着改矩形，见 ltDragMove 的 ltresize 分支 */
      };
      ltDragBindWindow();
    });
    grp.appendChild(rs);
    /* 拖动靠这个属性找回「当前这一帧」的节点组：pointerdown 会整块重绘，旧引用是死元素 */
    grp.setAttribute("data-lt-id", path);
    grp.addEventListener("pointerdown", (ev) => {
      if (ev.target === port) return;
      /* 按键过滤：只有左键起拖。中键交给 Pan（holder 捕获阶段先吃掉）、右键留给上下文菜单 */
      if (Number(ev.button) !== 0) return;
      ev.stopPropagation();
      ltGestureTake("drag"); /* 手势互斥：移节点一接手，先清掉可能在跑的平移 */
      ltSel.path = path;
      ltSel.edge = "";
      /* 先记拖拽快照、再重绘（右侧检查器要跟着换）：拖动状态里只留 id / path / 起点，
         元素每帧按 data-lt-id 现找，绝不能存这一帧的 grp。
         起点按**当帧**映射直接存成图坐标（gx0/gy0）—— 拖动中途滚轮缩放 / 平移改了 s 与
         viewBox 后，move 里仍以当帧映射换算鼠标图坐标、与这个起点相减，落点不会跳。 */
      const rect0 = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
      const sc0 = ltGraphScaleLive(holder, svg);
      const s0 = sc0 && sc0.s > 0 ? sc0.s : 1;
      ltDrag = {
        mode: "move",
        id: n.id,
        path: path,
        wf: wf,
        g,
        x0: Number(ev.clientX) || 0,
        y0: Number(ev.clientY) || 0,
        nx: Number(n.x) || 0,
        ny: Number(n.y) || 0,
        gx0: rect0 ? ((Number(ev.clientX) || 0) - Number(rect0.left || 0) - sc0.offX) / s0 : null,
        gy0: rect0 ? ((Number(ev.clientY) || 0) - Number(rect0.top || 0) - sc0.offY) / s0 : null,
        moved: false,
      };
      ltDragBindWindow();
      ltRenderStrip();
    });
    grp.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      if (n.kind === "sub" || n.kind === "map") {
        ltDrill.push({ id: n.id, title: n.title });
        ltSel.path = "";
        ltRenderStrip();
      }
    });
    svg.appendChild(grp);
  }
  /* 拖动 / 连线的事件监听在 ltDragBindWindow()（挂 document），不挂这里：
     这一帧的 svg 会被下一次 ltRenderStrip() 换掉，挂它 = 拖动断在半路。 */
}
/* 递归找节点（下钻后路径可能指向子图里的节点，检查器要按 id 找回它的定义） */
function ltFindNode(graph, id, depth) {
  if (!graph || (depth || 0) > 8) return null;
  for (const n of ltArr(graph.nodes)) {
    if (n.id === id) return n;
    const f = ltFindNode(n.cfg && n.cfg.graph, id, (depth || 0) + 1);
    if (f) return f;
  }
  return null;
}
function ltHitNode(g, svg, ev) {
  /* 命中测试是**绝对坐标**：与橡皮筋同走 ltGraphPointOf（等比居中留白 + 1/s + viewBox 原点
     —— 少加原点时平移后线就落不到鼠标底下的节点上）。 */
  const at = ltGraphPointOf(svg, ev && ev.clientX, ev && ev.clientY);
  const x = at.x;
  const y = at.y;
  for (const n of ltArr(g.nodes)) {
    /* 命中高度必须与**这一帧真实渲染的高度**同源：子任务行会撑高卡片（_ltH），
       只按 n.h 判会让卡片下半部分接不上线（看着就是「落点错」）。 */
    const h = n._ltH || Math.max(Number(n.h), 56);
    if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + h) return n.id;
  }
  return "";
}
function ltKindLabel(k) {  return { start: "START", end_ok: "END ✓", end_fail: "END ✗", agent: "AGENT", human: "HUMAN", join: "JOIN", fork: "FORK", map: "MAP", sub: "SUB", output: "SAVE" }[k] || String(k).toUpperCase();
}
/* 按显示宽度截断：中文 / 全角算 2 格，节点卡只有 ~180px 用 12px 字号，约 26 格。
   不用 ltStr 的字符数口径 —— 「Agent 任务」6 个字符与「写一版初稿请附带参考文献」14 个字符
   占据的宽度差一倍，按字符数截会一半撑破卡片、一半白白留白。 */
function ltBrk(v, cols) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  const max = Math.max(4, Number(cols) || 26);
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
    if (w + cw > max - 1) return out + "…";
    out += ch;
    w += cw;
  }
  return out;
}
/* 一个字符占几格：与 ltBrk 同口径（中文 / 全角 1 字 = 2 格），另把子任务行前那些图标
   （🤖 ✋ ☐ ☑ ⚠ ⇥ ⤵ …）也按 2 格算 —— 它们是整字宽的符号，按 1 格算会低估前缀宽度，
   正文跟着探出卡片，正是本 bug 的形态之一。 */
function ltCharCols(ch) {
  const cp = String(ch).codePointAt(0) || 0;
  if (
    /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ||
    /[\u2190-\u21ff\u2300-\u27bf\u2900-\u297f\u25a0-\u25ff\u2b00-\u2bff]/.test(ch) ||
    cp > 0x1f000
  )
    return 2;
  return 1;
}
/* 一段文本占几格（不截断，只量宽）：用于扣掉行首图标 / 右上角标的占位。 */
function ltTextCols(s) {
  let w = 0;
  for (const ch of String(s == null ? "" : s)) w += ltCharCols(ch);
  return w;
}
/* 按卡片可视宽度算列预算：一个 ASCII 格 ≈ 0.58em（沿用原「~180px 卡片约 26 格」的经验值，
   与 ltBrk 的中文=2 格口径配套），字号取该行 CSS 里的真实字号。
   字符数 ≠ 像素宽，所以截断列数必须由 n.w 现算，不能写死。 */
function ltColsOf(wpx, fontPx) {
  const unit = Math.max(4, (Number(fontPx) || 12) * 0.58);
  return Math.max(4, Math.floor((Number(wpx) || 0) / unit));
}
/* 节点裁剪层的唯一 id：同一帧里每节点一枚（clipPath 的 id 必须全局唯一，path 里可能带 / 等字符） */
let ltClipSeq = 0;
function ltClipId(path) {
  ltClipSeq += 1;
  return "ltClip-" + ltClipSeq + "-" + String(path == null ? "" : path).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
}
/* 任务目标拆成子任务行：用户与 Agent 写 goal 时常用换行 / 「1. 」列项列步骤，
   这类正文按行拆，一行 = 一条子任务；单行长文仍是一条（截断显示，全量看右侧检查器）。 */
function ltGoalSteps(text, max) {
  const out = [];
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (const raw of lines) {
    let s = String(raw).trim();
    if (!s) continue;
    s = s.replace(/^\s*(?:[-*•·]|\(?\d+[).、]|[一二三四五六七八九十]+[).、])\s*/, "").trim();
    if (!s) continue;
    out.push(s);
    if (out.length >= (max || 6)) break;
  }
  return out;
}
/* ── 状态节点上的子任务清单（需求 2）──────────────────────────────
 * 每个状态节点在画布上列清它这一环的子任务：agent = AI 自动跑的目标 / 步骤（🤖），
 * human = 等你的审批或交付清单（✋），sub / map = 内部子图的成员（⤵）。
 * 文本一律现算现画：卡片高度由 ltNodeRenderH 跟着行数走，不落任何新存储字段。
 * wpx：这一帧卡片的内宽（调用点传 n.w - 左右内边距）。文字按**显示宽度**截断（ltBrk 的
 * 中文=2 格口径 + ltColsOf 由内宽算列），行首图标先扣掉自己的占位 —— 中文长句不会再探出卡片；
 * 只截断不换行，行数固定 → 高度与连线端点都稳。 */
function ltTaskRows(run, path, n, st, wpx) {
  const rows = [];
  if (!n) return rows;
  /* 这一行正文能排多少格：卡片内宽换 9.5px 行的格数，再扣掉「图标 + 空格」自己的占位 */
  const cols = ltColsOf(wpx, 9.5);
  const fit = (icon, s) => ltBrk(s, cols - ltTextCols(String(icon == null ? "" : icon) + " "));
  if (st && st.err) rows.push({ icon: "⚠", text: fit("⚠", st.err), human: false });
  if (st && st.status === "running" && st.tail) rows.push({ icon: "▸", text: fit("▸", st.tail), human: false });
  if (n.kind === "agent") {
    if (n.cfg.goal) {
      for (const s of ltGoalSteps(n.cfg.goal, 6)) rows.push({ icon: "🤖", text: fit("🤖", s), human: false });
    } else rows.push({ icon: "🤖", text: ltT("（未填目标）"), human: false });
    if (st && st.status && st.status !== "pending" && st.status !== "running")
      rows.unshift({ icon: "•", text: ltT(st.status), human: false });
  } else if (n.kind === "human") {
    const mode = n.cfg.mode === "deliver" ? "deliver" : "approve";
    rows.push({ icon: "✋", text: (mode === "deliver" ? ltT("内容交付") : ltT("人工审批")) + (st && st.round ? " · R" + st.round : ""), human: true });
    if (mode === "deliver") {
      const items = st && st.items && st.items.length ? st.items : ltArr(n.cfg.items);
      for (const it of items.slice(0, 8)) {
        rows.push({
          icon: it.done ? "☑" : "☐",
          text: fit(it.done ? "☑" : "☐", it.title || ltT("（未命名条目）")),
          human: !it.done,
        });
      }
      if (items.length > 8) rows.push({ icon: "+", text: (items.length - 8) + ltT(" 条…"), human: false });
    } else if (n.cfg.goal) rows.push({ icon: "✋", text: fit("✋", n.cfg.goal), human: true });
  } else if (n.kind === "sub" || n.kind === "map") {
    const inner = ltArr(n.cfg.graph && n.cfg.graph.nodes);
    for (const m of inner.slice(0, 5)) rows.push({ icon: "⤵", text: fit("⤵", m.title), human: ltKindHuman(m.kind, m) });
    if (inner.length > 5) rows.push({ icon: "+", text: (inner.length - 5) + ltT(" 个…"), human: false });
    if (n.kind === "map") rows.unshift({ icon: "⇉", text: ltT("逐项：") + (n.cfg.overKey || "?"), human: false });
  } else if (n.kind === "output") {
    rows.push({ icon: "⇥", text: fit("⇥", n.cfg.path || ltT("（未填路径）")), human: false });
  }
  return rows.slice(0, 9);
}
/* 这一环要不要人来搭手：human 节点、以及 agent 里没配模型（要人配）的环。
   sub / map 的子成员按同一口径判一次（只判一层，足够标子任务里的「需人工」）。
   参数既收归一后的节点（{ kind, cfg }），也收图里那份原始节点（{ kind, model, … }）——
   下钻层直接拿图定义里的成员来标，不该逼调用方先生成一份归一副本。 */
function ltKindHuman(k, cfg) {
  if (k === "human") return true;
  if (k === "agent") {
    const c = cfg && cfg.cfg ? cfg.cfg : cfg || {};
    return !(c.model || c.provider);
  }
  return false;
}
/* 卡片渲染高度：随子任务行数长高（与 rect 用同一份，连线端点才不会跑偏）。 */
function ltNodeRenderH(n) {
  const base = Math.max(Number(n && n.h) || 0, 56);
  const rows = n && n._ltRows ? n._ltRows.length : 0;
  if (!rows) return base;
  return Math.max(base, 70 + rows * 14);
}
function ltNodeSummary(run, path, n, st, wpx) {
  /* 10px 摘要行：按卡片内宽算列，中英混排都不再探出卡片 */
  const cols = ltColsOf(wpx, 10);
  const fit = (s) => ltBrk(s, cols);
  /* 生效模型短名（本轮需求）：这一环跑的是哪只模型，卡片摘要上直接看得见 ——
     「检查器 / 会话里看着选的是 A、实际跑 B」这种误选观感，不该只有点开检查器
     才能核对。与条带头 chip、检查器那一行同一份只读数据源（ltAgentSelRead：
     cfg 写了用 cfg，留空取用户当前选择）。短名占的是**已有的这一行摘要**（前缀，
     跑起来的「最新进展」与报错也带上它），不新增行 —— ltNodeRenderH 的
     70 + N×14 口径因此不用动；短名最多占半行，正文（目标 / 报错 / 进展）仍有半行。 */
  const mTag = n.kind === "agent" ? ltAgentModelShort(ltAgentSelRead(n, null).model, Math.min(18, Math.floor(cols / 2))) : "";
  const mFit = (s) => fit(mTag ? mTag + " · " + s : s);
  if (st && st.err) return mFit(st.err);
  if (st && st.status === "running" && st.tail) return mFit(st.tail.replace(/\s+/g, " "));
  if (n.kind === "human") {
    if (n.cfg.mode === "deliver") {
      const pr = ltItemsProgress(st && st.items && st.items.length ? st.items : n.cfg.items);
      return ltT("交付") + " " + pr.done + "/" + pr.need;
    }
    return ltT("审批") + (st && st.round ? " R" + st.round : "");
  }
  if (n.kind === "agent") return mFit(n.cfg.goal || ltT("（未填目标）"));
  if (n.kind === "map") return ltT("逐项：") + (n.cfg.overKey || "?");
  if (n.kind === "sub") return ltT("子图 · ") + ltArr(n.cfg.graph.nodes).length + ltT(" 节点");
  if (n.kind === "output") return fit(n.cfg.path || ltT("（未填路径）"));
  return "";
}
/* ── 自动填入：能推导的不要让用户手填 ─────────────────────────────
   模型选型（provider / model / preset / effort）与会话 / 助手同源，创建时就继承下来；
   交付 uid 也在此预分配。铁律：**只填空字段** —— 用户或 Agent 已显式写入的值一律不动。
   ctx 可显式给一项（如引导会话自身的选择），缺项按序回落：
   会话当前默认 → 默认智能路由 → 该路由首个模型 / 全局默认预设与思考强度。 */
function ltInheritAgentDefaults(ctx) {
  ctx = ctx || {};
  const pick = (fn) => {
    try {
      return typeof fn === "function" ? String(fn() || "") : "";
    } catch (_) {
      return "";
    }
  };
  let route = String(ctx.provider || "");
  if (!route) route = pick(typeof preferredAgentProviderRoute !== "undefined" ? preferredAgentProviderRoute : null);
  if (!route) route = pick(typeof defaultAgentProviderRoute !== "undefined" ? defaultAgentProviderRoute : null);
  let model = String(ctx.model || "");
  if (!model && route)
    model = pick(
      typeof preferredAgentModelForRoute !== "undefined" ? () => preferredAgentModelForRoute(route) : null,
    );
  if (!model && route) {
    /* 真源没给默认模型时，取该路由清单里的第一个（与会话下拉的默认项一致） */
    try {
      const C = typeof window !== "undefined" && window.LT && window.LT.ui && window.LT.ui.ctl;
      if (C && typeof C.agentOpts === "function") model = String((C.agentOpts().modelsOf(route) || [])[0] || "");
    } catch (_) {}
  }
  if (model && !route) {
    try {
      if (typeof devRouteOfModel === "function") route = String(devRouteOfModel(model) || "") || route;
    } catch (_) {}
  }
  let preset = String(ctx.preset || "");
  if (!preset) {
    try {
      if (typeof S !== "undefined" && S) preset = String(S.assistPreset || "");
    } catch (_) {}
  }
  if (!preset && typeof AGENT_PRESET_DEFAULT !== "undefined") preset = String(AGENT_PRESET_DEFAULT);
  let effort = String(ctx.effort || "");
  if (!effort) {
    try {
      if (typeof S !== "undefined" && S) effort = String(S.assistEffort || "");
    } catch (_) {}
  }
  if (!effort) effort = "high";
  /* 引擎落盘白名单不含 off（ltNormCfg 会把 off 洗成空）：那种档位留空，不写一个存不下的值 */
  const ok =
    typeof AGENT_EFFORT_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_ORDER)
      ? AGENT_EFFORT_ORDER
      : ["low", "medium", "high", "xhigh", "max"];
  if (ok.indexOf(effort) < 0) effort = "";
  return { provider: route, model: model, preset: preset, effort: effort };
}
/* 把继承值填进整张图（含子图）的空字段；human(deliver) 顺带预分配交付 uid。
   返回同一张图，便于原地链式调用。 */
function ltInheritGraph(graph, ctx, depth) {
  const d = depth || 0;
  if (!graph || d > 8) return graph;
  const inh = ltInheritAgentDefaults(ctx);
  for (const n of ltArr(graph.nodes)) {
    if (!n) continue;
    const c = ltObj(n.cfg);
    if (!n.cfg) n.cfg = c;
    if (n.kind === "agent") {
      for (const k of ["provider", "model", "preset", "effort"]) {
        const cur = String(c[k] == null ? "" : c[k]).trim();
        if (!cur && inh[k]) c[k] = inh[k];
      }
    }
    if (n.kind === "human" && c.mode === "deliver" && !String(c.uid || "").trim()) {
      c.uid = typeof ltDeliverUid === "function" ? ltDeliverUid(n.title) : "";
    }
    if (c.graph) ltInheritGraph(c.graph, ctx, d + 1);
  }
  return graph;
}
/* 某节点（含其子图，递归）声明的输出键；arr 标记数组型（map 回写的一律是数组）。
   连线后自动预选 map / output 的目标键就用它 —— 上游声明即候选。 */
function ltDeclaredKeysOf(node, depth) {
  const d = depth || 0;
  const out = [];
  const seen = Object.create(null);
  const walk = (n, dep) => {
    if (!n || dep > 8) return;
    const c = ltObj(n.cfg);
    for (const k of ltArr(c.outKeys)) {
      const s = String(k == null ? "" : k).trim();
      if (!s || seen[s]) continue;
      seen[s] = 1;
      out.push({ value: s, arr: n.kind === "map" });
    }
    if (c.graph) walk(c.graph, dep + 1);
  };
  walk(node, d);
  return out;
}
/* 连线后按上游声明自动预选：map「展开哪个数组键」/ output「取哪个状态键」。
   只在目标字段空着时补，绝不覆盖已显式写入的值。 */
function ltPreselectAfterWire(g, fromId, toId) {
  const from = ltArr(g && g.nodes).find((n) => n.id === fromId);
  const to = ltArr(g && g.nodes).find((n) => n.id === toId);
  if (!from || !to) return;
  if (to.kind !== "map" && to.kind !== "output") return;
  const keys = ltDeclaredKeysOf(from, 0);
  if (!keys.length) return;
  if (!to.cfg) to.cfg = {};
  if (to.kind === "map") {
    if (String(to.cfg.overKey || "").trim()) return;
    const a = keys.filter((k) => k.arr)[0] || keys[0];
    if (a) to.cfg.overKey = a.value;
  } else {
    if (String(to.cfg.key || "").trim()) return;
    to.cfg.key = keys[0].value;
  }
}
function ltAddNode(task, g, kind) {
  /* 落笔前重新解析活任务 / 活图（见 ltLiveTarget）：传进来的 task / g 可能是开菜单前
     那次重绘之前的孤儿，写进去 = 右键创建无声无效。 */
  const live = ltLiveTarget(task, g);
  task = live.task;
  g = live.graph;
  if (!task || !g) return;
  let maxY = 0;
  for (const n of ltArr(g.nodes)) maxY = Math.max(maxY, Number(n.y) + Math.max(Number(n.h), 56));
  /* 落点与主画布同口径：x / y / 宽 / 高一律吸附网格（网格间距 = 用户设置的 snap）；
     列距对齐网格并按节点宽度（200）留出间隔，不会叠在一起。 */
  const snapV = typeof ltSnap === "function" ? ltSnap : (v) => Math.round(Number(v) || 0);
  const colStep = typeof ltGrid === "function" ? ltGrid() * 9 : 216;
  const node = {
    id: ltUid("n"),
    kind,
    x: snapV(60 + (ltArr(g.nodes).length % 4) * colStep),
    y: snapV(maxY + 30),
    w: snapV(200),
    h: snapV(80),
    title: ltKindTitle(kind),
    cfg: {},
  };
  if (kind === "agent") node.cfg = { goal: "", outKeys: ["result"] };
  if (kind === "human") node.cfg = { mode: "approve", backTo: "", maxRound: "" };
  if (kind === "map") node.cfg = { overKey: "", itemKey: "item", graph: { nodes: [], edges: [] }, outKeys: [] };
  if (kind === "sub") node.cfg = { graph: { nodes: [], edges: [] }, outKeys: [] };
  if (kind === "output") node.cfg = { key: "", path: "" };
  /* 能推导的当场填上：agent 继承模型选型，交付节点预分配 uid（关起来就是空字段） */
  ltInheritGraph({ nodes: [node] });
  g.nodes.push(node);
  task.ver = (Number(task.ver) || 1) + 1;
  if (task.graph) task.graph.ver = task.ver;
  if (typeof scheduleSave === "function") scheduleSave(true);
  ltRenderStrip();
}
function ltKindTitle(k) {
  return { start: ltT("起点"), end_ok: ltT("成功终点"), end_fail: ltT("失败终点"), agent: ltT("Agent 任务"), human: ltT("人工任务"), join: ltT("汇聚"), fork: ltT("选路"), map: ltT("逐项并行"), sub: ltT("子图"), output: ltT("写文件") }[k] || k;
}
/* ── 图内右键菜单（本次需求）─────────────────────────────────────────
   以前这两件事各占一排按钮：「＋ Agent 任务 / ＋ 人工任务 / ＋ 汇聚 / ＋ 选路 /
   ＋ 逐项并行 / ＋ 子图 / ＋ 写文件 / ＋ 起点 / ＋ 成功终点 / ＋ 失败终点」十颗加节点
   按钮 + 一颗「删除选中」。它们只在编辑图时用，却常驻把条带挤满 —— 现在整体搬进右键菜单：
   图内随处右键即出（空白 / 节点 / 连线都行），菜单落点是光标本身（ltMenuOpen 的 pt）。
   命中测试要点：命中节点时先把选中落到它身上（与左键点选同一口径），右键一处就能
   看清自己删的是哪个；只命中一条边就选边（边的 pointerdown 只认左键，右键不会自己选中）。
   选中态交给引擎校验「还选着吗」：被删掉 / 切了下钻层后不会留一条幽灵项。 */
function ltGraphCtxMenu(ev, task, g, svg) {
  if (!ev || !task || !g) return;
  if (ev.preventDefault) ev.preventDefault();
  if (ev.stopPropagation) ev.stopPropagation();
  const at = svg ? ltGraphPointOf(svg, ev.clientX, ev.clientY) : null;
  if (at) {
    const hit = ltHitNode(g, svg, ev);
    if (hit) {
      ltSel.path = (ltDrill.map((d) => d.id).join("/") + (ltDrill.length ? "/" : "") + hit);
      ltSel.edge = "";
    } else {
      const e = ltEdgeAt(g, at, svg);
      if (e) {
        ltSel.edge = e.id;
        ltSel.path = "";
      }
      /* 落空白：不清选中 —— 右键是「叫菜单」，与左键点空白的「取消选中」不是一回事 */
    }
  }
  const items = [];
  for (const [k, label] of [
    ["agent", ltT("Agent 任务")],
    ["human", ltT("人工任务")],
    ["join", ltT("汇聚")],
    ["fork", ltT("选路")],
    ["map", ltT("逐项并行")],
    ["sub", ltT("子图")],
    ["output", ltT("写文件")],
    ["start", ltT("起点")],
    ["end_ok", ltT("成功终点")],
    ["end_fail", ltT("失败终点")],
  ]) {
    items.push({ label: "＋ " + label, cls: "lt-btn-add", title: ltT("在图里加一个") + label + ltT("节点"), on: () => ltAddNode(task, g, k) });
  }
  /* 还选着节点 / 连线才给删除项（选的是节点就把它的标题写在菜单里，删谁一目了然） */
  const sel = ltCtxDelSel();
  const delTitle = ltT("删除选中的节点 / 连线（也可以直接按 Delete 键）");
  items.push({ sep: true });
  items.push({
    label: sel ? ltT("删除选中") + "（" + sel.label + "）" : ltT("删除选中"),
    cls: "lt-btn-del",
    title: delTitle,
    on: () => ltDeleteSel(task, g),
  });
  /* 先重绘把选中的节点 / 连线高亮出来（右侧检查器跟着换），再开菜单 ——
     顺序反过来的话 ltRenderStrip → ltRenderHead → ltMenuClose 会把刚开的菜单收掉。 */
  ltRenderStrip();
  ltMenuOpen(null, items, { x: Number(ev.clientX) || 0, y: Number(ev.clientY) || 0 });
}
/* 图内右键菜单与 Delete 键共用的「当前选中」解析：选着边给边，选着节点给节点标题；
   选中对象已不在图上（被删 / 换层）时按「没选」处理 —— 绝不留幽灵项、绝不误删别的。
   刻意不把 ltSel 传进来：这里是模块作用域变量，绕一层只为少一处手抄状态。 */
function ltCtxDelSel() {
  try {
    const cur = ltCurGraph(typeof S !== "undefined" ? S.wf : null);
    const g = cur && cur.graph ? cur.graph : null;
    if (!g) return null;
    if (ltSel.edge) return ltArr(g.edges).some((e) => e.id === ltSel.edge) ? { kind: "edge", label: ltT("连线") } : null;
    if (!ltSel.path) return null;
    /* 下钻层里的选中按**路径末段**找回节点（与 ltDeleteSel 同一口径：只删当前这一层的） */
    const id = String(ltSel.path).split("/").pop();
    const n = ltArr(g.nodes).find((x) => x.id === id);
    if (!n) return null;
    return { kind: "node", label: ltClipS(ltKindTitle(n.kind) + " · " + String(n.title || ""), 18) };
  } catch (_) {
    return null;
  }
}
/* 菜单项里的短标题：按字符数截断（右键菜单只有 ~190px 宽，节点名长了会撑破）。
   刻意不复用卡片的 ltBrk / ltClipId —— 那两个是「按显示宽度算格子 / 生成裁剪 id」的口径，
   给一行菜单文字用属于顺手牵羊；这里只要一个不会截出半个字的安全短串。 */
function ltClipS(v, max) {
  const s = String(v == null ? "" : v);
  const n = Math.max(4, Number(max) || 18);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
/* Delete / Backspace = 删除选中的节点 / 连线（本次需求）。挂在 .lt-graph 上（见
   ltRenderGraph），所以只有画布拿着焦点时才生效；输入框 / 文本域里一律让键给它们自己。 */
function ltGraphKeyDown(ev, task, g) {
  if (!ev || !task || !g) return;
  const key = String((ev && ev.key) || "");
  if (key !== "Delete" && key !== "Backspace" && key !== "Del") return;
  const el = document.activeElement;
  const tag = el && el.tagName ? String(el.tagName).toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el && el.isContentEditable)) return;
  const sel = ltCtxDelSel();
  if (!sel) {
    toast(ltT("先点选一个节点或一条连线"), "warn");
    return;
  }
  if (ev.preventDefault) ev.preventDefault();
  ltDeleteSel(task, g);
}
/* 边命中（右键 / 删除都要）：点到折线上就算命中这条边 —— 贝塞尔抽成 16 段折线求距离，
   带宽 = 8 图单位（随缩放视觉上变化，但缩得越小越好点，实际手感与主画布一致）。
   命中节点优先（上面先判）：线压在卡片底下时不抢节点的右键。 */
function ltEdgeAt(g, pt, svg) {
  const at = pt || (svg && ltGraphPointOf(svg, 0, 0));
  if (!at) return null;
  const tol = 8;
  const segDist = (x, y, x1, y1, x2, y2) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = dx * dx + dy * dy;
    let t = len > 0 ? ((x - x1) * dx + (y - y1) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    return Math.hypot(x - px, y - py);
  };
  for (const e of ltArr(g.edges)) {
    const a = ltArr(g.nodes).find((n) => n.id === e.from);
    const b = ltArr(g.nodes).find((n) => n.id === e.to);
    if (!a || !b) continue;
    const geo = ltEdgeGeo(a, b);
    /* 三次贝塞尔（控制点 = 横向中点，与渲染同源）→ 采样成折线判距离 */
    const y1 = geo.y1;
    const y2 = geo.y2;
    const cx = geo.mx;
    const P = (t) => {
      const mt = 1 - t;
      return {
        x: mt * mt * mt * geo.x1 + 3 * mt * mt * t * cx + 3 * mt * t * t * cx + t * t * t * geo.x2,
        y: mt * mt * mt * y1 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y2,
      };
    };
    let prev = P(0);
    for (let i = 1; i <= 16; i++) {
      const cur = P(i / 16);
      if (segDist(at.x, at.y, prev.x, prev.y, cur.x, cur.y) <= tol) return e;
      prev = cur;
    }
  }
  return null;
}
function ltDeleteSel(task, g) {
  /* 与 ltAddNode 同一口径：删也必须删活图里那一个，孤儿身上删掉 = 界面纹丝不动 */
  const live = ltLiveTarget(task, g);
  task = live.task;
  g = live.graph;
  if (!g) return;
  if (ltSel.edge) {
    g.edges = ltArr(g.edges).filter((e) => e.id !== ltSel.edge);
    ltSel.edge = "";
  } else if (ltSel.path) {
    const id = ltSel.path.split("/").pop();
    g.nodes = ltArr(g.nodes).filter((n) => n.id !== id);
    g.edges = ltArr(g.edges).filter((e) => e.from !== id && e.to !== id);
    ltSel.path = "";
  } else {
    toast(ltT("先点选一个节点或一条连线"), "warn");
    return;
  }
  if (task) task.ver = (Number(task.ver) || 1) + 1;
  g.ver = Math.max(1, Number(task && task.ver) || 0, Number(g.ver) || 0);
  if (typeof scheduleSave === "function") scheduleSave(true);
  ltRenderStrip();
}

/* ── 右栏：检查器 + 人工任务卡 ────────────────────────────────── */
function ltRenderSide(right, wf, task, run) {
  const waits = run && run.waits ? ltArr(run.waits) : [];
  if (waits.length) {
    right.appendChild(ltEl("div", "lt-side-h", ltT("等你处理")));
    for (const w of waits) right.appendChild(ltHumanCard(wf, run, w));
  }
  /* 卡住的环节（含用户「无视报错」放行过的那些 —— 放行只免它的阻拦，不抹掉「它出过错」这个事实，
   卡片上显式写着已放行，用户仍能一眼看出哪一环没按预期跑完）。 */
  const stuck =
    run &&
    Object.keys(run.nodes || {}).filter((p) => {
      const s = run.nodes[p].status;
      if (s !== "blocked" && s !== "failed" && s !== "skipped") return false;
      if (s === "skipped" && !run.nodes[p].skippedBy) return false;
      /* 被放行环节**内部**的子槽不再单独列卡：它们随所属环节一起作废（见 ltSettleRunStatus），
         一颗颗列出来只会再把右栏塞满已经处理过的报错。 */
      const pre = String(p).indexOf("/") >= 0 ? String(p).slice(0, String(p).lastIndexOf("/")) : "";
      const ws = pre && run.nodes[pre] ? run.nodes[pre] : null;
      return !(ws && ws.status === "skipped" && ws.skippedBy);
    });
  if (stuck.length) {
    right.appendChild(ltEl("div", "lt-side-h", ltT("卡住的环节")));
    for (const p of stuck) right.appendChild(ltBlockedCard(wf, run, p));
  }
  right.appendChild(ltEl("div", "lt-side-h", ltSel.path ? ltT("检查器") : ltT("图说明")));
  const insp = ltEl("div", "lt-insp");
  right.appendChild(insp);
  if (ltSel.edge && run && run.graph) ltEdgeInspector(insp, wf, task, ltSel.edge);
  else if (ltSel.path) ltNodeInspector(insp, wf, task, run, ltSel.path);
  else ltOverviewInspector(insp, wf, task, run);
  /* 运行日志不再在这里渲染：run.log 仍是运行档案（继续写、随 checkpoint 落盘），
     长任务 Agent 环节的过程与结果改由该环节绑定的会话展示。 */
}
function ltField(parent, label, el, hint) {
  const row = ltEl("div", "lt-f");
  row.appendChild(ltEl("label", "lt-fl", label));
  row.appendChild(el);
  if (hint) row.appendChild(ltEl("div", "lt-fh", hint));
  parent.appendChild(row);
  return el;
}
function ltInput(parent, label, val, on, type, hint) {
  const i = ltEl(type === "area" ? "textarea" : "input", "lt-in");
  if (type !== "area") i.type = type || "text";
  i.value = val == null ? "" : String(val);
  i.onchange = () => on(i);
  /* 多行框（type "area"）：hkey 给「手动拖高的持久 key」，重建时按它还原高度（见 LT_TA_H 段）。
     hint 之后跟 hkey（第 7 参）—— 老调用处只传 6 个参数，行为一字不变。 */
  if (type === "area") {
    const hkey = arguments.length > 6 ? String(arguments[6] || "") : "";
    if (hkey) {
      ltTaHApply(i, hkey);
      ltTaHBind(i, hkey);
    }
  }
  return ltField(parent, label, i, hint);
}
/* 长任务设置控件（可搜索下拉）——控件本体在 app-longtask-ctl.js（window.LT.ui.ctl）。
   取不到时返回 null，调用处回落成原来的文本框：老运行时也要能打开检查器。 */
function ltCtl() {
  return (window.LT && window.LT.ui && window.LT.ui.ctl) || null;
}
/* 图内「已知状态键」——状态键类设置（输入 / 输出状态键、取哪个状态键、展开哪个数组键、
   回写父图的键）的候选清单，来源两处，先运行态后声明：
     ① 当前 run 顶层 state 里已经存在的键（跑过就有事实）；
     ② 图（含子图）里所有节点声明的 outKeys（谁产出的写进 hint，便于认出同名键的出处）。
   arr 标记「数组型」：运行态实测是数组，或声明者本身是 map（map 回写的一律是数组）。
   声明里没出现、运行态也没有的键不在清单里 —— 想新造要走控件的 allowNew 显式新建项。 */
function ltKnownKeyItems(task, run) {
  const seen = new Map();
  const put = (k, hint, isArr) => {
    const s = String(k == null ? "" : k).trim();
    if (!s) return;
    const it = seen.get(s);
    if (it) {
      if (hint && it.hint.indexOf(hint) < 0) it.hint = it.hint ? it.hint + " · " + hint : hint;
      if (isArr) it.arr = true;
      return;
    }
    seen.set(s, { value: s, label: s, hint: hint || "", arr: !!isArr });
  };
  try {
    if (run) {
      const flat = ltStateFlat(run, "");
      for (const k of Object.keys(flat)) put(k, ltT("运行态"), Array.isArray(flat[k]));
    }
  } catch (_) {}
  const walk = (g, depth) => {
    for (const n of ltArr(g && g.nodes)) {
      const c = (n && n.cfg) || {};
      for (const k of ltArr(c.outKeys)) put(k, ltT("{title} 声明", { title: ltStr(n.title, 24) }), n.kind === "map");
      if (c.graph && depth < 6) walk(c.graph, depth + 1);
    }
  };
  try {
    walk(task && task.graph, 0);
  } catch (_) {}
  return [...seen.values()];
}
function ltKnownKeyOptions(task, run) {
  return ltKnownKeyItems(task, run).map((x) => ({ value: x.value, label: x.label, hint: x.hint }));
}
function ltArrayKeyOptions(task, run) {
  return ltKnownKeyItems(task, run)
    .filter((x) => x.arr)
    .map((x) => ({ value: x.value, label: x.label, hint: x.hint }));
}
/* 状态键类下拉的公共参数（提示 / 空清单兜底 / 搜索占位） */
function ltKeyOpt(extra) {
  return Object.assign(
    {
      searchPlaceholder: ltT("输入以搜索…"),
      hint: ltT("只能从图里已知的状态键里选；要新造键用「＋ 新建」项"),
      emptyText: ltT("图里还没有已知状态键：先给别的节点声明输出键，或上线跑一轮"),
    },
    extra || {},
  );
}
function ltCommit(task, fn) {
  try {
    fn();
  } catch (_) {}
  task.ver = (Number(task.ver) || 1) + 1;
  if (task.graph) task.graph.ver = task.ver;
  task.updatedAt = ltNow();
  if (typeof scheduleSave === "function") scheduleSave(true);
  ltRenderStrip();
}
function ltNodeInspector(box, wf, task, run, path) {
  const cur = ltCurGraph(wf);
  const g = cur ? cur.graph : task.graph;
  const id = String(path).split("/").pop().split("@")[0];
  const node = ltArr(g.nodes).find((n) => n.id === id) || ltFindNode(task.graph, id);
  if (!node) {
    box.appendChild(ltEl("div", "lt-fh", ltT("找不到该节点")));
    return;
  }
  const st = run && run.nodes ? run.nodes[path] : null;
  box.appendChild(ltEl("div", "lt-insp-h", ltKindLabel(node.kind) + " · " + node.title + (st ? " · " + ltT(st.status) : "")));
  /* 本轮模型（本轮需求）：检查器顶部一行只读回显 —— 「这一环用哪只模型 / 哪档预设 /
     思考强度」不必再靠四只下拉各自的留空状态去猜；留空的字段就地标「跟随默认」，
     写了的照实显示。数据源与条带头 chip、图内卡片摘要同一份（ltAgentSelRead：
     cfg 写了用 cfg，留空取用户当前选择），只读、不落任何新存储。
     清单只在这里取一次，下面四只下拉复用同一份（ltInspAO）。 */
  const ltInspAO = node.kind === "agent" ? ltAgentOptsNow() : null;
  if (ltInspAO) box.appendChild(ltEl("div", "lt-insp-model", ltAgentSelLine(node, ltInspAO)));
  if (st && st.uid) {
    const loc = ltBtn(ltT("⌖ 定位到交付节点"), "lt-btn", () => {
      const dn = ltDeliverNodeOf(st.uid);
      if (!dn) {
        toast(ltT("交付节点不在当前画布上"), "warn");
        return;
      }
      ltApplyOpen(false);
      if (typeof focusNode === "function") focusNode(dn.id);
    });
    box.appendChild(loc);
  }
  const save = (patchCfg) => ltCommit(task, () => Object.assign(node.cfg, patchCfg));
  /* 报错出路（本轮需求）：选中的这一环**正卡着**时，检查器顶上就把放行控件摊出来 ——
     用户点着那张「a_check · blocked」卡片进来，第一眼看到的不是一堆参数，而是出路。 */
  if (st && (st.status === "blocked" || st.status === "failed")) {
    ltErrEscapeBox(box, task, run, path, st.status === "failed" ? "err" : "skip");
  }
  ltInput(box, ltT("标题"), node.title, (i) => ltCommit(task, () => (node.title = ltStr(i.value, 60) || node.title)));
  /* 「目标 / 说明」是这一栏最常写长文的一格：手动拖出来的高度按 path + 字段名记住，
     条带重绘（运行期约 90ms 一次）后仍还原成用户拖到的那一份（见 LT_TA_H 段）。 */
  ltInput(box, ltT("目标 / 说明"), node.cfg.goal, (i) => save({ goal: i.value }), "area", null, ltDraftKey(path, "goal"));
  if (node.kind === "agent") {
    const C = ltCtl();
    const known = ltKnownKeyOptions(task, run);
    if (C) {
      C.ltMultiSelField(box, ltT("输入状态键"), ltArr(node.cfg.inKeys), known, (v) => save({ inKeys: v }),
        ltKeyOpt({ hint: ltT("留空 = 自动看全部状态"), emptyLabel: ltT("留空 = 全部状态") }));
      C.ltMultiSelField(box, ltT("输出状态键"), ltArr(node.cfg.outKeys), known, (v) => save({ outKeys: v }),
        ltKeyOpt({ hint: ltT("Agent 只被授权写这些键"), allowNew: true }));
    } else {
      ltInput(box, ltT("输入状态键"), (node.cfg.inKeys || []).join(", "), (i) => save({ inKeys: i.value.split(/[,，\s]+/).filter(Boolean) }), null, ltT("逗号分隔 · 留空 = 自动看全部状态"));
      ltInput(box, ltT("输出状态键"), (node.cfg.outKeys || []).join(", "), (i) => save({ outKeys: i.value.split(/[,，\s]+/).filter(Boolean) }), null, ltT("Agent 只被授权写这些键"));
    }
    /* 模型选型：与会话（助手栏供应商 / 模型下拉、智能节点面板）同一批真源 ——
       清单由 app-longtask-ctl.js 的 ltAgentOpts() 提供；输入框只用来搜索，
       选不到的值提交不进去，避免手打模型名 / 路由名拼错后静默不生效。
       写回口径不变：仍是 node.cfg.provider / model / preset / effort 四个字符串。 */
    const AO = ltInspAO; /* 顶部那一行已经取过同一份清单，四只下拉复用它 */
    if (AO) {
      /* 「跟随默认」提示 = 留空时**真正生效**的当前选择（路由 · 模型 · 预设 · 思考强度）。
         真源与会话栏 / 助手是同一份：路由与模型走 preferredAgentProviderRoute /
         preferredAgentModelForRoute（AO.defaults.route / AO.modelForRoute），预设与思考
         强度走 S.assistPreset / S.assistEffort（AO.defaults）。此前这里拿「该路由清单的
         首项」冒充默认模型 —— 用户当前选的不是首项时，提示说的与实际跑的就成了两回事
         （就是「误选」观感的来源之一）。 */
      const optLabel = (list, v) => {
        const s = String(v == null ? "" : v);
        const hit = ltArr(list).filter((o) => o && String(o.value) === s)[0];
        return hit ? String(hit.label || s) : "";
      };
      const defHintText = () => {
        const route = String(node.cfg.provider || AO.defaults.route || "");
        const fm =
          (typeof AO.modelForRoute === "function" ? AO.modelForRoute(route) : "") ||
          AO.defaults.model ||
          "";
        return ltT("跟随默认（当前 = {route} · {model} · {preset} · {effort}）", {
          route: AO.routeName(route),
          model: fm || ltT("默认模型"),
          preset: optLabel(AO.presetOptions, node.cfg.preset || AO.defaults.preset) || ltT("默认预设"),
          effort: optLabel(AO.effortOptions, node.cfg.effort || AO.defaults.effort) || ltT("默认思考强度"),
        });
      };
      const pickCfg = {
        allowEmpty: true,
        emptyLabel: ltT("跟随默认"),
        searchPlaceholder: ltT("输入以搜索…"),
      };
      /* 服务商 / 模型两格的提示行就是上面那条「跟随默认（当前 = …）」：
         四格任一改动后（含预设与思考强度）当场重算，别让提示停在旧值上 */
      const hints = [];
      const refreshHints = () => {
        for (const h of hints) if (h && typeof h.setHint === "function") h.setHint(defHintText());
      };
      /* 模型格的显示值 = 「路由|模型」成对编码（app-longtask-ctl.js 的 keyOf / splitKey）：
         跨服务商有同名模型时，裸模型 id 分辨不出归属，回显 / ✓ 必须按完整 key 命中，
         否则只会标在第一组、选第二家被静默拨到第一家路由（就是「误选」）。
         写回口径不变：仍是 node.cfg.provider / model 两个裸字符串。
         只存了模型没存路由（老数据 / 引擎自动填的）时按清单反查一次补成对。 */
      const ltNodeModelKey = (route, model) => {
        const m = String(model || "").trim();
        if (!m) return "";
        const k = AO.keyOf(route, m);
        if (k) return k;
        const r = AO.routeOfModel(m);
        return r ? AO.keyOf(r, m) : m;
      };
      let hModel = null;
      const hProv = C.ltSelField(
        box,
        ltT("服务商 / 路由"),
        node.cfg.provider,
        AO.providerOptions,
        (v) => {
          save({ provider: v });
          /* 换了服务商，原模型若不属于新路由就清空（留空 = 跟随该路由的默认模型），
             不留下「A 家的模型配 B 家路由」这种只在运行时才炸的组合；
             判据用该路由清单里的裸模型 id（成对 key 现拼，不再各自做反查） */
          const m = String(node.cfg.model || "");
          const keep = !(m && v && AO.modelsOf(v).indexOf(m) < 0);
          if (!keep) save({ model: "" });
          /* 成对回显：路由换了（或被清空）后模型格的值要跟着换成新的「路由|模型」 */
          if (hModel) hModel.setValue(keep ? ltNodeModelKey(v, m) : "", true);
          refreshHints();
        },
        Object.assign({ hint: defHintText(), emptyText: ltT("没有可用的服务商") }, pickCfg),
      );
      hints.push(hProv);
      hModel = C.ltSelField(
        box,
        ltT("模型"),
        ltNodeModelKey(node.cfg.provider, node.cfg.model),
        AO.modelGroups,
        (v) => {
          const key = String(v || "").trim();
          if (!key) {
            /* 清空 = 跟随默认模型（路由原样保留，不动用户已选的 provider） */
            save({ model: "" });
            refreshHints();
            return;
          }
          /* 成对编码：选中即把 provider 与 model 一起拨正（splitKey 拆出路由部分） */
          const sp = AO.splitKey(key);
          const patch = { model: sp.model };
          if (sp.provider && sp.provider !== String(node.cfg.provider || "")) patch.provider = sp.provider;
          save(patch);
          if (patch.provider) hProv.setValue(patch.provider, true);
          refreshHints();
        },
        Object.assign({ hint: defHintText(), emptyText: ltT("没有可用的模型") }, pickCfg),
      );
      hints.push(hModel);
      /* 预设 / 思考强度两格的提示本来就是真话（留空 = 用全局默认档），不进 hints
         —— 它们改完只需刷上面那两格「跟随默认（当前 = …）」 */
      C.ltSelField(box, ltT("预设"), node.cfg.preset, AO.presetOptions, (v) => {
        save({ preset: v });
        refreshHints();
      }, Object.assign({ hint: ltT("留空 = 用全局默认预设") }, pickCfg));
      /* 思考强度：引擎早已下发 cfg.effort（app-longtask.js 的 ltPseudoNode），此前只是没有 UI */
      C.ltSelField(box, ltT("思考强度"), node.cfg.effort, AO.effortOptions, (v) => {
        save({ effort: v });
        refreshHints();
      }, Object.assign({ hint: ltT("留空 = 用全局默认思考强度") }, pickCfg));
      /* 继承回显：服务商与模型都还是创建时继承来的默认值时，明说这是「继承」而不是留空让人猜 */
      const inh = ltInheritAgentDefaults();
      const same = (k) => String(node.cfg[k] || "") !== "" && String(node.cfg[k]) === String(inh[k] || "");
      if (same("provider") && same("model"))
        box.appendChild(
          ltEl(
            "div",
            "lt-fh",
            ltT("模型选型继承自创建时的默认（{route} · {model}）；改动任意一项即不再继承", {
              route: AO.routeName(inh.provider),
              model: inh.model || ltT("默认模型"),
            }),
          ),
        );
    } else {
      /* 回落：控件模块不可用时保持原来的文本框，检查器照常能改 */
      ltInput(box, ltT("模型"), node.cfg.model, (i) => save({ model: i.value.trim() }), null, ltT("留空 = 跟随默认路由"));
      ltInput(box, ltT("服务商 / 路由"), node.cfg.provider, (i) => save({ provider: i.value.trim() }));
      ltInput(box, ltT("预设"), node.cfg.preset, (i) => save({ preset: i.value.trim() }));
      ltInput(box, ltT("思考强度"), node.cfg.effort, (i) => save({ effort: i.value.trim() }), null, ltT("留空 = 用全局默认思考强度"));
    }
    /* 重试次数：0–5 档下拉，空 = 跟随全局默认（ltNormCfg 存字符串，口径未变） */
    const retryOpts = [];
    for (let i = 0; i <= 5; i++) retryOpts.push({ value: String(i), label: ltT("{n} 次", { n: i }) });
    if (C) {
      C.ltSelField(box, ltT("重试次数"), node.cfg.retries, retryOpts, (v) => save({ retries: v }), {
        allowEmpty: true,
        emptyLabel: ltT("跟随全局默认 {n}", { n: ltCfg().retry }),
        hint: ltT("留空 = 用全局默认 {n}", { n: ltCfg().retry }),
        searchPlaceholder: ltT("输入以搜索…"),
      });
    } else {
      ltInput(box, ltT("重试次数"), node.cfg.retries, (i) => save({ retries: i.value.trim() }), null, ltT("留空 = 用全局默认 {n}", { n: ltCfg().retry }));
    }
    const cb = ltEl("input", "lt-cb");
    cb.type = "checkbox";
    cb.checked = !!node.cfg.canvasRead;
    cb.onchange = () => save({ canvasRead: cb.checked });
    ltField(box, ltT("允许读取画布"), cb, ltT("勾选后本轮可用 mtnode_canvas_get 读本画布（只读；改图与应用工具不注册）"));
    if (st) {
      const det = ltEl("details", "lt-rounds");
      det.appendChild(ltEl("summary", null, ltT("历史轮次") + " ×" + ltArr(st.rounds).length));
      for (const r of ltArr(st.rounds).slice().reverse()) {
        det.appendChild(ltEl("div", "lt-round", "#" + r.seq + "  " + new Date(r.at).toLocaleString() + "\n" + ltStr(r.err === "reject" ? r.text : r.text, 1200)));
      }
      box.appendChild(det);
    }
  }
  if (node.kind === "human") {
    const sel = ltEl("select", "lt-in");
    for (const [v, l] of [["approve", ltT("审批")], ["deliver", ltT("内容交付")]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      if (node.cfg.mode === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      /* 切成交付就地预分配交付 uid（不再等「启用时自动分配」）：只在空时补 */
      const patch = { mode: sel.value };
      if (sel.value === "deliver" && !String(node.cfg.uid || "").trim() && typeof ltDeliverUid === "function")
        patch.uid = ltDeliverUid(node.title);
      save(patch);
    };
    ltField(box, ltT("人工任务类型"), sel);
    const backNodes = ltArr(g.nodes).filter((n2) => n2.id !== node.id && n2.kind !== "start" && n2.kind !== "end_ok" && n2.kind !== "end_fail");
    const HC = ltCtl();
    if (HC && backNodes.length > 10) {
      /* 节点多时选项表太长，换成可搜索下拉（少时保留原生 select，两下点完更快） */
      HC.ltSelField(box, ltT("驳回回跳到"), node.cfg.backTo, backNodes.map((n2) => ({ value: n2.id, label: n2.title, hint: n2.id })), (v) => save({ backTo: v }), {
        allowEmpty: true,
        emptyLabel: ltT("（不回跳）"),
        hint: ltT("超过上限即转「失败」"),
        searchPlaceholder: ltT("输入以搜索…"),
        emptyText: ltT("图里没有可回跳的节点"),
      });
    } else {
      const back = ltEl("select", "lt-in");
      const bo = document.createElement("option");
      bo.value = "";
      bo.textContent = ltT("（不回跳）");
      back.appendChild(bo);
      for (const n2 of backNodes) {
        const o = document.createElement("option");
        o.value = n2.id;
        o.textContent = n2.title;
        if (node.cfg.backTo === n2.id) o.selected = true;
        back.appendChild(o);
      }
      back.onchange = () => save({ backTo: back.value });
      ltField(box, ltT("驳回回跳到"), back, ltT("超过上限即转「失败」"));
    }
    /* 回跳上限：不限（默认）+ 1–9 档，空 = 跟随全局默认（ltNormCfg 存字符串，口径未变） */
    const roundOpts = [{ value: "0", label: ltT("不限") }];
    for (let i = 1; i <= 9; i++) roundOpts.push({ value: String(i), label: ltT("{n} 轮", { n: i }) });
    const gCap = ltCfg().maxRound;
    const gCapLabel = gCap > 0 ? ltT("{n} 轮", { n: gCap }) : ltT("不限");
    if (HC) {
      HC.ltSelField(box, ltT("回跳上限"), node.cfg.maxRound, roundOpts, (v) => save({ maxRound: v }), {
        allowEmpty: true,
        emptyLabel: ltT("跟随全局默认（{v}）", { v: gCapLabel }),
        hint: ltT("留空 = 全局默认 {n}；0 = 不限", { n: gCapLabel }),
        searchPlaceholder: ltT("输入以搜索…"),
      });
    } else {
      ltInput(box, ltT("回跳上限"), node.cfg.maxRound, (i) => save({ maxRound: i.value.trim() }), null, ltT("留空 = 全局默认 {n}；0 = 不限", { n: gCapLabel }));
    }
    if (node.cfg.mode === "deliver") {
      box.appendChild(ltEl("div", "lt-fh", ltT("交付 uid：") + (node.cfg.uid || ltT("启用时自动分配"))));
      if (node.cfg.dir) box.appendChild(ltEl("div", "lt-fh", ltT("目录：") + node.cfg.dir));
      ltChecklistEditor(box, wf, task, node, null, true, path);
    }
  }
  if (node.kind === "join") {
    const sel = ltEl("select", "lt-in");
    for (const [v, l] of [["all", ltT("全部到齐（AND）")], ["any", ltT("任一到达（OR）")]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      if (node.cfg.mode === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => save({ mode: sel.value });
    ltField(box, ltT("汇聚口径"), sel, ltT("与画布 gate / mutex 同一语义"));
  }
  if (node.kind === "output") {
    const OC = ltCtl();
    if (OC) {
      OC.ltSelField(box, ltT("取哪个状态键"), node.cfg.key, ltKnownKeyOptions(task, run), (v) => save({ key: v }),
        ltKeyOpt({ allowEmpty: true, allowNew: true, emptyLabel: ltT("留空 = 不取值") }));
    } else {
      ltInput(box, ltT("取哪个状态键"), node.cfg.key, (i) => save({ key: i.value.trim() }));
    }
    ltInput(box, ltT("写到哪个文件"), node.cfg.path, (i) => save({ path: i.value.trim() }), null, ltT("相对工作目录或绝对路径"));
  }
  if (node.kind === "sub" || node.kind === "map") {
    const MC = ltCtl();
    if (node.kind === "map") {
      if (MC) {
        MC.ltSelField(box, ltT("展开哪个数组键"), node.cfg.overKey, ltArrayKeyOptions(task, run), (v) => save({ overKey: v }),
          ltKeyOpt({ allowEmpty: true, allowNew: true, emptyLabel: ltT("（未选）"), emptyText: ltT("图里还没有数组型状态键：先让某个 map 节点声明回写键，或上线跑一轮") }));
      } else {
        ltInput(box, ltT("展开哪个数组键"), node.cfg.overKey, (i) => save({ overKey: i.value.trim() }));
      }
      ltInput(box, ltT("每项在子图里的键名"), node.cfg.itemKey, (i) => save({ itemKey: i.value.trim() }));
    }
    if (MC) {
      MC.ltMultiSelField(box, ltT("回写父图的键"), ltArr(node.cfg.outKeys), ltKnownKeyOptions(task, run), (v) => save({ outKeys: v }),
        ltKeyOpt({ hint: ltT("命名空间隔离：只这些键会提上去"), allowNew: true }));
    } else {
      ltInput(box, ltT("回写父图的键"), (node.cfg.outKeys || []).join(", "), (i) => save({ outKeys: i.value.split(/[,，\s]+/).filter(Boolean) }), null, ltT("命名空间隔离：只这些键会提上去"));
    }
    box.appendChild(ltBtn(ltT("⤵ 下钻编辑子图"), "lt-btn", () => {
      ltDrill.push({ id: node.id, title: node.title });
      ltSel.path = "";
      ltRenderStrip();
    }));
  }
  if (st && st.tail) box.appendChild(ltEl("div", "lt-tail", ltStr(st.tail, 1200)));
  /* ── 产出与生成（本轮需求）：这一环节的产出 / 产物落进它自己的超级节点子壳，
     涉及内容生成时在子壳里**预置好生成工作流但一律不运行**（由用户点 ▶ 执行）。
     所以这里只问两件事：要不要生成内容、用哪几种生成。
     判据与本模块的落位全在 app-longtask-shell.js（ltNormCfg 白名单里有这两个键）。 */
  if (node.kind !== "start" && node.kind !== "end_ok" && node.kind !== "end_fail" && node.kind !== "join" && node.kind !== "fork" && node.kind !== "output") {
    box.appendChild(ltEl("div", "lt-side-h2", ltT("产出与生成")));
    const genCb = ltEl("input", "lt-cb");
    genCb.type = "checkbox";
    /* 缺省勾上（未设过 = 勾上，与「新任务默认勾上」一致） */
    genCb.checked = !(node.cfg.needsGen === false || node.cfg.needsGen === "false");
    genCb.onchange = () => save({ needsGen: genCb.checked });
    ltField(
      box,
      ltT("需要生成内容"),
      genCb,
      ltT("勾选后本环节跑到时，会在它的超级节点子壳里预置生成节点与控制节点；一律不自动运行，由你点 ▶ 执行"),
    );
    const GC = ltCtl();
    const genOpts = [
      { value: "image", label: ltT("图像生成"), hint: "proc_image" },
      { value: "video", label: ltT("视频生成"), hint: "video_gen" },
      { value: "music", label: ltT("音乐生成"), hint: "music_gen" },
      { value: "tts", label: ltT("语音合成"), hint: "tts_gen" },
    ];
    const curTypes =
      window.LTSHELL && typeof window.LTSHELL.genTypesOf === "function"
        ? window.LTSHELL.genTypesOf(node.cfg)
        : Array.isArray(node.cfg.genTypes) && node.cfg.genTypes.length
          ? node.cfg.genTypes
          : ["image"];
    if (GC) {
      GC.ltMultiSelField(box, ltT("生成类型"), curTypes, genOpts, (v) => save({ genTypes: ltArr(v) }), {
        hint: ltT("要预置哪几种生成节点（平行摆在同一颗子壳里，各自带提示词与参数）"),
        searchPlaceholder: ltT("输入以搜索…"),
      });
    } else {
      ltInput(
        box,
        ltT("生成类型"),
        curTypes.join(", "),
        (i) => save({ genTypes: i.value.split(/[,，\s]+/).filter(Boolean) }),
        null,
        ltT("逗号分隔：image / video / music / tts"),
      );
    }
    box.appendChild(
      ltEl(
        "div",
        "lt-fh",
        ltT("本环节的产出 / 产物会落进它的超级节点子壳（没有则自动建）；生成节点只建不跑。"),
      ),
    );
  }
}
function ltEdgeInspector(box, wf, task, edgeId) {
  const cur = ltCurGraph(wf);
  const g = cur ? cur.graph : null;
  const e = g ? ltArr(g.edges).find((x) => x.id === edgeId) : null;
  if (!e) return;
  const a = ltArr(g.nodes).find((n) => n.id === e.from);
  const b = ltArr(g.nodes).find((n) => n.id === e.to);
  box.appendChild(ltEl("div", "lt-insp-h", (a ? a.title : e.from) + " → " + (b ? b.title : e.to)));
  const save = (patch) => ltCommit(task, () => Object.assign(e, patch));
  ltInput(box, ltT("标签"), e.label, (i) => save({ label: i.value }));
  ltInput(box, ltT("条件（受限 JS，可选）"), e.cond, (i) => save({ cond: i.value }), "area", ltT("拿得到 input.state（整份共享状态）；return 真值 = 放行。留空 = 无条件。抛错转「需人工」"));
  box.appendChild(ltBtn(ltT("删除这条连线"), "lt-btn lt-btn-del", () => {
    g.edges = ltArr(g.edges).filter((x) => x.id !== edgeId);
    ltSel.edge = "";
    ltCommit(task, () => {});
  }));
}
function ltOverviewInspector(box, wf, task, run) {
  const errs = ltValidate(task.graph);
  box.appendChild(ltEl("div", "lt-fh", ltT("点左侧节点改参数，点连线改条件；从节点右端拖出连线。双击子图 / map 节点下钻。")));
  if (!errs.length) box.appendChild(ltEl("div", "lt-ok", "✓ " + ltT("图校验通过")));
  for (const x of errs) {
    const row = ltEl("div", "lt-warn-row " + (x.level === "err" ? "lt-err" : "lt-warn"), (x.level === "err" ? "✗ " : "! ") + x.msg);
    if (x.nodeId) {
      row.onclick = () => {
        ltSel.path = (run ? ltDrill.map((d) => d.id).join("/") + "/" : "") + x.nodeId;
        ltRenderStrip();
      };
      row.style.cursor = "pointer";
    }
    box.appendChild(row);
  }
  if (run) {
    const keys = Object.keys(ltStateFlat(run, ""));
    if (keys.length) {
      box.appendChild(ltEl("div", "lt-side-h2", ltT("共享状态")));
      for (const k of keys.slice(0, 40)) {
        box.appendChild(ltEl("div", "lt-state-k", k + " = " + ltBrief(ltStateGet(run, "", k))));
      }
    }
  }
}
/* ── 报错出路控件（本轮需求本体）：无视报错，直接进下一环 ───────────────────
 * 长任务最伤的体验是「某一环报错就再也动不了」。这张控件是那条出路的唯一入口，
 * 卡住的环节卡片与环节检查器都用它（一份实现两处用，判据与文案不许各写一份）：
 *   · 下拉 = 无视这次报错后进哪一环（留空 = 走本环节自己的下游）；
 *   · 按钮 = 当场放行（引擎的 LT.manualResolve → applySkip：标记放行 + 点火，不重跑上游）；
 *   · 勾上「图定义」= 写回 node.cfg.onError / onErrorNext，以后这一环再报错就自动放行。
 * 两档出路：**跳过这一环**（记为 skipped）与**判失败也继续**（记为 failed，不再挂在这儿等人）。 */
function ltErrNodeItems(task, run, path) {
  const wf =
    (typeof ltRunCanvas === "function" ? ltRunCanvas(run) : null) ||
    (typeof S !== "undefined" && S ? S.wf : null);
  const cur = wf ? ltCurGraph(wf) : null;
  const graph = (cur && cur.graph) || (task && task.graph) || { nodes: [], edges: [] };
  const selfId = String(path || "").split("/").pop().split("@")[0];
  return ltArr(graph.nodes)
    .filter((n) => n && n.id !== selfId)
    .map((n) => ({ value: String(n.id), label: ltStr(n.title || n.id, 40), hint: String(n.id) }));
}
/* 这张 run 所属的画布（与 ltRunCanvas 同一口径；拿不到就退回用户此刻看着的那张） */
function wfOf(run) {
  try {
    const wf = typeof ltRunCanvas === "function" ? ltRunCanvas(run) : null;
    if (wf) return wf;
  } catch (_) {}
  return typeof S !== "undefined" && S ? S.wf : null;
}
function ltErrEscapeBox(host, task, run, path, kind) {
  const st = (run && run.nodes && run.nodes[path]) || null;
  const loc = run && typeof ltLocate === "function" ? ltLocate(run, path) : null;
  const node = loc && loc.node ? loc.node : null;
  if (!node || !node.cfg) return null;
  const wf = wfOf(run);
  const box = ltEl("div", "lt-errbox");
  box.appendChild(ltEl("div", "lt-errbox-h", ltT("无视这次报错，接着往下跑")));
  box.appendChild(
    ltEl(
      "div",
      "lt-fh",
      kind === "err"
        ? ltT("这一环照旧记为失败，但不再拦住流程：下游照常点火，缺的东西由下游自己说（判失败 ≠ 跳过）。")
        : ltT("这一环记为「已跳过」：它留下的东西下游照旧读得到，缺的东西下游自己会说。"),
    ),
  );
  const items = ltErrNodeItems(task, run, path);
  const C = ltCtl();
  let tgt = "";
  if (C) {
    C.ltSelField(box, ltT("跳到哪一环"), (node.cfg && node.cfg.onErrorNext) || "", items, (v) => (tgt = v), {
      allowEmpty: true,
      emptyLabel: ltT("（不填 = 走它自己的下游）"),
      emptyText: ltT("图里没有别的环节可跳"),
      searchPlaceholder: ltT("输入以搜索…"),
      hint: ltT("只列同一张图里的环节；留空 = 走它自己的下游"),
    });
  } else {
    ltInput(box, ltT("跳到哪一环"), (node.cfg && node.cfg.onErrorNext) || "", (i) => (tgt = i.value.trim()), null, ltT("留空 = 走它自己的下游"));
  }
  const chk = ltEl("input", "lt-errbox-cb");
  chk.type = "checkbox";
  chk.checked = ltErrorSkipOn(node);
  const lab = ltEl("label", "lt-errbox-lab");
  lab.appendChild(chk);
  lab.appendChild(ltEl("span", null, ltT("以后这一环报错都照此放行（写回图定义）")));
  box.appendChild(lab);
  chk.onchange = () => {
    if (task) ltCommit(task, () => Object.assign(node.cfg, { onError: chk.checked ? "skip" : "" }));
    else node.cfg.onError = chk.checked ? "skip" : "";
  };
  /* 当场放行：唯一落点是引擎的 LT.manualResolve（判据与施加动作都只在引擎里有一份）。
     引擎不在时**明确说出来**（toast），绝不静默什么都不发生。 */
  const doFix = (mode) => {
    const API = window.LT;
    if (!API || typeof API.manualResolve !== "function") {
      if (typeof toast === "function") toast(ltT("长任务引擎未就绪：先点「继续」再试"), "warn");
      return Promise.resolve(null);
    }
    return Promise.resolve(API.manualResolve(wf, path, { mode: mode, target: tgt, reason: chk.checked ? ltT("图定义自动放行") : "" })).then(
      (r) => {
        if (r && r.ok === false && typeof toast === "function") toast(r.error || ltT("这一环当前没有报错，放行不了"), "warn");
        if (typeof ltRenderStrip === "function") ltRenderStrip();
        return r;
      },
    );
  };
  const row = ltEl("div", "lt-card-row");
  if (kind === "err") row.appendChild(ltBtn(ltT("无视报错：判失败并继续"), "lt-btn lt-btn-pri", () => doFix("err")));
  else {
    row.appendChild(ltBtn(ltT("无视报错并继续"), "lt-btn lt-btn-pri", () => doFix("skip")));
    row.appendChild(
      ltBtn(ltT("判失败也继续"), "lt-btn", () => doFix("err"), ltT("这一环记为失败，但照常点火下游（不再挂在这儿等人）")),
    );
  }
  box.appendChild(row);
  if (st && st.skippedBy) box.appendChild(ltEl("div", "lt-fh", ltT("已放行：") + st.skippedBy));
  return box;
}

function ltBlockedCard(wf, run, path) {
  const st = run.nodes[path];
  const skipped = st.status === "skipped";
  const card = ltEl("div", "lt-card lt-card-fail" + (skipped ? " lt-card-skipped" : ""));
  card.appendChild(ltEl("div", "lt-card-h", ltStr(path.split("/").pop(), 40) + " · " + ltT(st.status)));
  card.appendChild(ltEl("div", "lt-card-p", st.err || (skipped ? st.skippedBy || ltT("已放行") : ltT("被阻断"))));
  const row = ltEl("div", "lt-card-row");
  /* 已放行的那一环只留「重跑这一环」：它的报错已经不计较了，再摆一次「无视报错」没意义。 */
  row.appendChild(ltBtn(ltT("重跑这一环"), "lt-btn" + (skipped ? " lt-btn-pri" : ""), () => ltRetryNode(wf, path)));
  card.appendChild(row);
  if (!skipped) ltErrEscapeBox(card, ltTaskOf(wf, run.taskId), run, path, st.status === "failed" ? "err" : "skip");
  return card;
}

/* 展开键输入控件取值：单选控件（ctl.selField）的 handle 没有 .value 字符串字段
   （值在 value() 里、裸字在 input.value 里），普通 ltInput 才是 .value —— 两种都收，
   否则「点了候选却读不到」这类脏读会直接落到引擎里。 */
function ltMapKeyVal(keyIn) {
  if (!keyIn) return "";
  if (typeof keyIn.value === "function") {
    const v = keyIn.value();
    if (v) return String(v).trim();
    return keyIn.input && keyIn.input.value != null ? String(keyIn.input.value).trim() : "";
  }
  return keyIn.value == null ? "" : String(keyIn.value).trim();
}
/* ── 「逐项」环节的展开源卡（本轮需求：状态机本身不再因为找不到数组而判失败）────────
 * 取不到数组时这一环转等人（waiting_human），本卡片就是它的唯一补救面：改展开键 /
 * 按候选一键换成能用的那个 / 粘贴 JSON 数组 / 让上游补写后重新查找并继续。
 * 说明文案与候选表都出自引擎（ltMapWaitInfo → ltMapWaitPlan），界面只渲染，不另判一遍。 */
function ltMapCard(wf, run, w) {
  const wpath = String((w && w.path) || "");
  const card = ltEl("div", "lt-card lt-card-human lt-card-map");
  const h = ltEl("div", "lt-card-h");
  h.appendChild(ltEl("span", "lt-card-tag", ltT("逐项展开源")));
  h.appendChild(ltEl("b", null, (w && w.title) || ltT("逐项")));
  if (w && w.round && w.round > 1) h.appendChild(ltEl("span", "lt-fh", "R" + w.round));
  card.appendChild(h);
  const info = window.LT && typeof window.LT.mapWaitInfo === "function" ? window.LT.mapWaitInfo(run, wpath) : null;
  card.appendChild(ltEl("div", "lt-card-p", info && info.text ? info.text : ltT("这一环要展开的数组还没着落：请指定展开键或补一个数组。")));
  const ctl = ltCtl();
  const opts = (Array.isArray(info && info.keys) ? info.keys : []).map((k) => ({ value: k, label: k }));
  const keyIn =
    ctl && typeof ctl.selField === "function"
      ? ctl.selField(card, ltT("展开哪个数组键"), (info && info.want) || "", opts, () => {}, { allowNew: true })
      : ltInput(card, ltT("展开哪个数组键"), (info && info.want) || "", () => {});
  const usable = ltArr(info && info.usable);
  if (usable.length) {
    const row = ltEl("div", "lt-card-row");
    for (const u of usable.slice(0, 5)) {
      row.appendChild(
        ltBtn(u.key + "（" + u.count + "）", "lt-btn", () => resolve(u.key, ""), ltT("改用这个键当展开源，并重新查找")),
      );
    }
    card.appendChild(row);
  }
  const paste = ltEl("textarea", "lt-in lt-in-why");
  paste.placeholder = ltT("也可以直接粘贴一份 JSON 数组当展开源（第一行以 [ 开头）");
  paste.rows = 3;
  card.appendChild(paste);
  function resolve(key, pasted) {
    const API = window.LT;
    if (!API || typeof API.mapRepairWait !== "function") {
      if (typeof toast === "function") toast(ltT("长任务引擎未就绪：先点「继续」再试"), "warn");
      return;
    }
    /* 补救口是**同步**返回结果对象（算不出来也照旧同步给 ok:false）：直接接回执，
       不要当 Promise 用 .then —— 那会把回执丢进异常里，卡片的重绘与 toast 都跟着没了。 */
    let r = null;
    try {
      r = API.mapRepairWait(wf, wpath, { overKey: key, pasted: pasted });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (r && r.ok) {
      if (typeof toast === "function") toast(ltT("展开源已就位（") + r.key + ltT(" · ") + r.count + ltT(" 项）：这一环接着往下跑"), "");
    } else if (typeof toast === "function") {
      toast((r && r.error) || ltT("还是没找到可用的数组"), "warn");
    }
    ltRenderStrip();
  }
  const row = ltEl("div", "lt-card-row");
  row.appendChild(
    ltBtn(ltT("重新查找并继续"), "lt-btn lt-btn-pri", () => resolve(ltMapKeyVal(keyIn), paste.value || "")),
  );
  card.appendChild(row);
  return card;
}

/* ── 人工任务卡：审批 / 交付清单（唯一操作面）─────────────────────── */
function ltHumanCard(wf, run, w) {
  if (w && w.kind === "mapfix") return ltMapCard(wf, run, w);
  const wpath = String(w && w.path ? w.path : "");
  const st = run.nodes[w.path] || {};
  const node = ltNodeAt(run, w.path);
  const card = ltEl("div", "lt-card lt-card-human" + (w.kind === "deliver" ? " lt-card-deliver" : ""));
  const h = ltEl("div", "lt-card-h");
  h.appendChild(ltEl("span", "lt-card-tag", w.kind === "deliver" ? ltT("内容交付") : ltT("审批")));
  h.appendChild(ltEl("b", null, w.title || ltT("人工任务")));
  if (st.uid) h.appendChild(ltBtn("⌖", "lt-btn lt-btn-ico", () => {
    const dn = ltDeliverNodeOf(st.uid);
    ltApplyOpen(false);
    if (dn && typeof focusNode === "function") focusNode(dn.id);
    else if (dn && typeof S !== "undefined") {
      S.sel = dn.id;
      renderCanvas();
    }
  }, ltT("定位到画布上的交付节点")));
  card.appendChild(h);
  if (String(node && node.cfg.goal ? node.cfg.goal : "").trim()) card.appendChild(ltEl("div", "lt-card-p", ltStr(node.cfg.goal, 900)));
  if (w.round && w.round > 1) card.appendChild(ltEl("div", "lt-fh", ltT("第 ") + w.round + ltT(" 轮")));
  if (w.kind === "deliver") {
    const items = st.items && st.items.length ? st.items : ltArr(node && node.cfg.items);
    card.appendChild(ltChecklistEditor(card, wf, { graph: run.graph }, node, items, false, w.path));
    const pr = ltItemsProgress(items);
    /* 还没交齐（必填未交 / 文件名待补）= 点「确认交付完成」会先弹确认窗：**提醒不阻止**。
       卡片上先把这件事说出来，用户点进去就知道要写什么（判据唯一真源在 LT 侧）。 */
    const miss =
      window.LT && typeof window.LT.releaseMissingItems === "function" ? ltArr(window.LT.releaseMissingItems(items)) : [];
    /* 本次需求：连在交付节点上、上游已经产出文件的那几件**自动**收下（引擎口径，与节点上
       收线同源）；**收齐只代表「文件都到齐了」，不代表往下走** —— 这一环是否放行仍然由用户
       在本卡片上点「确认交付完成」决定（只把「再去节点上收一遍线」这一步省掉）。
       卡片重绘时叫一次即可，节流 + 重入闸在 LT 侧（重复叫不重复干活）。 */
    if (window.LT && typeof window.LT.autoCollectSoon === "function") window.LT.autoCollectSoon();
    if (!miss.length)
      card.appendChild(
        ltEl(
          "div",
          "lt-fh",
          ltT("必填项已交齐：点「确认交付完成」往下走（连线交齐的件已在画布上自动记为已交付，不必再去收线）。"),
        ),
      );
    if (miss.length)
      card.appendChild(
        ltEl(
          "div",
          "lt-warn-row lt-warn",
          ltT("还有 ") + miss.length + ltT(" 项必填没交齐：仍可继续，但要先弹确认窗说清为什么、哪些需要额外交付（缺文件名的先补上文件名）"),
        ),
      );
    const rels = ltReleaseRecs(st.deliverReleases);
    if (rels.length) {
      const last = rels[rels.length - 1];
      card.appendChild(
        ltEl(
          "div",
          "lt-warn-row lt-warn",
          ltT("已在未交齐的情况下放行 ") +
            rels.length +
            ltT(" 轮：最近一轮（第 ") +
            (Number(last.round) || 1) +
            ltT(" 轮）") +
            ltStr(last.note || ltT("（未填说明）"), 200),
        ),
      );
    }
    const row = ltEl("div", "lt-card-row");
    /* 不再有「没交齐就置灰」：按钮永远可点 —— 点进去是确认窗（列未交项 + 写说明 + 继续/返回补齐） */
    const btn = ltBtn(ltT("确认交付完成") + "（" + pr.done + "/" + pr.need + "）", "lt-btn lt-btn-pri", () =>
      ltHumanReleaseDialog(wf, w, st, node, items, ltDraftGet(ltDraftKey(wpath, "relnote"))),
    );
    btn.title = miss.length ? ltT("还有必填项没交齐：点开写清原因后可继续，也可以回去补齐") : ltT("确认交付，任务继续往下跑");
    row.appendChild(btn);
    if (st.dir) row.appendChild(ltBtn(ltT("打开交付目录"), "lt-btn", () => window.api.shellOpenPath && window.api.shellOpenPath(st.dir)));
    card.appendChild(row);
  } else {
    const whyKey = ltDraftKey(wpath, "why");
    const why = ltDraftBind(ltEl("textarea", "lt-in lt-in-why"), whyKey);
    why.placeholder = ltT("意见 / 理由（驳回时必填，上游 Agent 会读到）");
    why.rows = 2;
    /* 这张卡在运行期会被反复重绘：手动拖出来的高度也按同一个草稿键记住（见 LT_TA_H 段），
       不然写到一半顺手拉高的框，下一次重绘又缩回两行。 */
    ltTaHBind(why, whyKey);
    card.appendChild(why);
    const row = ltEl("div", "lt-card-row");
    row.appendChild(ltBtn(ltT("✓ 通过"), "lt-btn lt-btn-pri", async () => {
      /* 提交即清草稿：这一条的理由已经用掉了，别让它跟着下一条待办卡继续漂 */
      ltDraftClear(ltDraftKey(wpath, "why"));
      await ltHumanResolve(wf, { path: w.path, decide: "approve", reason: why.value });
      ltRenderStrip();
    }));
    row.appendChild(ltBtn(ltT("✗ 驳回"), "lt-btn lt-btn-warn", async () => {
      if (!why.value.trim()) {
        toast(ltT("驳回请写理由，否则上游不知道怎么改"), "warn");
        why.focus();
        return;
      }
      ltDraftClear(ltDraftKey(wpath, "why"));
      const r = await ltHumanResolve(wf, { path: w.path, decide: "reject", reason: why.value });
      if (r && r.failed) toast(ltT("回跳次数已用完，这一环转「失败」"), "warn");
      else if (r && r.blocked) toast(ltT("这一环没有可回跳的目标，已转「需人工」"), "warn");
      ltRenderStrip();
    }));
    card.appendChild(row);
  }
  return card;
}
/* ── 交付放行确认窗（本轮需求本体）─────────────────────────────────────
 * 交付物没全交齐也能继续，但点「确认交付完成」会先落到这里：列出没交的项、给一格
 * 「交付说明」（为什么有些没交、哪些需要额外交付），两个出口 ——
 *   · 「继续任务」= 放行：说明与未交清单进状态键 deliver_note / deliver_missing、
 *     run 逐轮归档、交付目录 manifest.json 与《交付清单.md》；
 *   · 「返回补齐」= 什么都不提交，说明留在草稿里（下次点开还在），人回去继续交。
 * 提醒不阻止：一件都没交也允许继续（共识），所以这里没有任何 disabled 的出口。 */
function ltReleaseRecs(list) {
  return ltArr(list).filter((r) => r && r.at);
}
/* 一条放行记录的人读文本（条带窗与交付节点板身共用）：未交项 + 说明。 */
function ltReleaseRecText(rec) {
  const r = rec || {};
  const L = ltArr(r.missing).map(
    (m) => "· " + (m && m.name ? String(m.name) : ltT("（未命名）")) + " —— " + (m && m.reason === "no_name" ? ltT("没定下文件名（含后缀）") : ltT("没交")),
  );
  L.push(ltT("交付说明：") + ltStr(r.note || ltT("（未填说明）"), 600));
  return L.join("\n");
}
function ltHumanReleaseDialog(wf, w, st, node, items, noteIn) {
  if (typeof openOverlay !== "function") return;
  const wpath = String((w && w.path) || "");
  const key = ltDraftKey(wpath, "relnote");
  const missing = window.LT && typeof window.LT.releaseMissingItems === "function" ? ltArr(window.LT.releaseMissingItems(items)) : [];
  const recs = ltReleaseRecs(st && st.deliverReleases);
  openOverlay(ltT("确认交付完成"), { persistent: true, min: false });
  const body = document.getElementById("ovBody");
  if (!body) return;
  const wrap = ltEl("div", "lt-dlv-form lt-rel-form");
  if (missing.length) wrap.appendChild(ltEl("div", "lt-rel-h", ltT("还有 ") + missing.length + ltT(" 项必填没交齐：仍可继续，但这几项会被记成「未交付·已放行」")));
  else wrap.appendChild(ltEl("div", "lt-rel-h", ltT("必填项都交齐了：确认后任务继续往下跑")));
  if (missing.length) {
    const missList = ltEl("div", "lt-rel-miss");
    missing.forEach((m) => {
      const li = ltEl("div", "lt-rel-miss-i", "· " + (m && m.name ? String(m.name) : ltT("（未命名）")) + " —— ");
      li.appendChild(ltEl("span", "lt-rel-why", m && m.reason === "no_name" ? ltT("没定下文件名（含后缀）") : ltT("没交")));
      missList.appendChild(li);
    });
    wrap.appendChild(missList);
    wrap.appendChild(
      ltEl(
        "div",
        "lt-rel-warn",
        ltT("这一轮不交齐也放行：写清为什么没交、哪些需要额外交付 —— 下游 Agent 会读到这段说明（缺件影响后续时它该把本环节标为需人工）。说明可以留空，但空说明在交付目录里只会记成「（未填说明）」。"),
      ),
    );
  }
  const lab = ltEl("label", "lt-dlv-fl", ltT("交付说明（为什么有些未交付 / 哪些需要额外交付）"));
  const note = ltDraftBind(ltEl("textarea", "lt-in"), key);
  note.rows = 4;
  note.placeholder = ltT("例：第三份素材还没拿到原始文件，先用占位版推进；额外交付：成片的一版竖屏裁剪，下一轮补交");
  lab.appendChild(note);
  wrap.appendChild(lab);
  if (recs.length) {
    const hist = ltEl("div", "lt-rel-hist");
    hist.appendChild(ltEl("div", "lt-rel-hist-h", ltT("本环节已放行 ") + recs.length + ltT(" 轮（逐轮留痕，可在交付目录回看）")));
    for (const r of recs) {
      const h = ltEl("div", "lt-rel-hist-i", ltT("第 ") + (Number(r.round) || 1) + ltT(" 轮 · ") + new Date(r.at).toLocaleString() + "：");
      h.appendChild(ltEl("span", "lt-rel-hist-n", ltStr(r.note || ltT("（未填说明）"), 200)));
      hist.appendChild(h);
    }
    wrap.appendChild(hist);
  }
  body.appendChild(wrap);
  const foot = document.getElementById("ovFoot");
  if (!foot) return;
  foot.innerHTML = "";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "lt-btn";
  back.textContent = ltT("返回补齐");
  back.onclick = () => {
    /* 什么都不提交：说明留在草稿里（重绘后点开还在），人回去把条目交齐 */
    closeOverlay();
    toast(ltT("已返回：把没交的条目补齐后再点「确认交付完成」"), "warn");
    ltRenderStrip();
  };
  const go = document.createElement("button");
  go.type = "button";
  go.className = "lt-btn lt-btn-pri";
  go.textContent = ltT("继续任务");
  go.onclick = async () => {
    const v = String(note.value || "");
    go.disabled = true;
    const r = await ltHumanResolve(wf, { path: wpath, decide: "deliver", items: items, note: v });
    if (!r || !r.ok) {
      go.disabled = false;
      toast((r && r.error) || ltT("还不能交付"), "err");
      return;
    }
    ltDraftClear(key); /* 说明已经用进交付记录，别让它跟着下一轮继续漂 */
    closeOverlay();
    const n = Number(r.missing) || 0;
    if (n) toast(ltT("已在未交齐的情况下放行：") + n + ltT(" 项必填未交，说明已记入交付目录并会带给下游"), "warn");
    else toast(ltT("已交付，任务继续往下跑"), "ok");
    ltRenderStrip();
  };
  foot.appendChild(back);
  foot.appendChild(go);
}
/* 清单编辑器：图定义里（editing=true）与运行时卡片里共用一份渲染。
 * path = 运行态时该环节的路径（卡片改的是 run.nodes[path].items，不能借选中态猜）。 */
function ltChecklistEditor(parent, wf, task, node, itemsIn, editing, path) {
  const box = ltEl("div", "lt-list");
  const items = itemsIn || ltArr(node.cfg.items);
  node.cfg.items = items;
  /* 这一环的运行态（编辑器在运行时态渲染时用它读放行记录 · 勾选/上传的提交也写它） */
  const run = editing ? null : ltCurrentRun(wf);
  const runSt = editing ? null : ((run || {}).nodes || {})[path || ltSel.path] || null;
  /* 上一次放行记录（未交清单 + 说明）：编辑器提交清单时一起落盘，
     免得「放行后又补交一件」把交付目录里的《未交付说明》整段抹掉。 */
  const lastRec = runSt && ltReleaseRecs(runSt.deliverReleases).length ? ltReleaseRecs(runSt.deliverReleases).slice(-1)[0] : null;
  const commit = async () => {
    if (editing) {
      task.ver = (Number(task.ver) || 1) + 1;
      if (typeof scheduleSave === "function") scheduleSave(true);
    } else {
      node.cfg.items = JSON.parse(JSON.stringify(items));
      const st = runSt;
      if (st) {
        st.items = JSON.parse(JSON.stringify(items));
        if (!st.dir) st.dir = node.cfg.dir || "";
      }
      const dir = await ltDeliverWrite(node.cfg.uid, items, {
        note: lastRec ? lastRec.note : "",
        missing: lastRec ? lastRec.missing : [],
      });
      if (dir && st) st.dir = dir;
      ltSave2(run);
    }
    ltRenderStrip();
  };
  items.forEach((it, i) => {
    const itemBox = ltEl("div", "lt-item" + (it.done ? " done" : "") + (it.byAgent && !it.accepted ? " pending" : ""));
    const head = ltEl("div", "lt-item-h");
    const kind = ltEl("select", "lt-in lt-in-kind");
    for (const [v, l] of [["file", ltT("文件")], ["text", ltT("文本")], ["choice", ltT("选项确认")], ["media", ltT("媒体")]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      if (it.kind === v) o.selected = true;
      kind.appendChild(o);
    }
    kind.disabled = !editing;
    kind.onchange = async () => {
      it.kind = kind.value;
      await commit();
    };
    head.appendChild(kind);
    const title = ltEl("input", "lt-in lt-in-title");
    title.value = (it.kind === "file" || it.kind === "media") ? it.file || it.title || "" : it.title || "";
    title.disabled = !editing;
    /* 文件 / 媒体条目这一格是**交付物文件名**（file 字段 · 交付以文件为单位）：
       改动同时写回 title —— show 入口与旧档（只有 title）都按 title 兜底，两处同值才不会
       出现「字段里改了名字、节点上还是旧名」。文本 / 选项条目这一格仍是描述性标题。 */
    title.onchange = async () => {
      const v = ltStr(title.value, 200);
      it.title = v;
      if (it.kind === "file" || it.kind === "media") it.file = v;
      await commit();
    };
    head.appendChild(title);
    const req = ltEl("input", "lt-in-req");
    req.type = "checkbox";
    req.checked = it.required !== false;
    req.title = ltT("必填 / 选填");
    req.disabled = !editing;
    req.onchange = async () => {
      it.required = req.checked;
      await commit();
    };
    head.appendChild(req);
    /* 条目标签：已交付 / 未交付·已放行 / 文件名待补 / Agent 追加 —— 一列看清这一项的状态。
   「未交付·已放行」= 上一轮带着它继续过（放行记录按条目 id 对），与「待交付」分开，
   免得用户把「放行过的缺件」当成「从来没管过」。 */
    const heldRec = (() => {
      const rels = ltReleaseRecs(runSt && runSt.deliverReleases);
      if (!rels.length || it.done) return null;
      const miss = ltArr(rels[rels.length - 1].missing);
      return miss.find((m) => it.id != null && String(m.id || "") === String(it.id)) || null;
    })();
    head.appendChild(
      ltEl(
        "span",
        "lt-item-tag" + (heldRec ? " rel" : ""),
        it.done
          ? ltT("已交付") + (it.deliveredVia ? "·" + it.deliveredVia : "")
          : heldRec
            ? ltT("未交付·已放行") + (heldRec.reason === "no_name" ? "·" + ltT("文件名待补") : "")
            : ltDlvNeedsName(it)
              ? ltT("文件名待补")
              : it.byAgent
                ? ltT("Agent 追加")
                : "",
      ),
    );
    if (editing) {
      const x = ltBtn("✕", "lt-btn lt-btn-ico", async () => {
        items.splice(i, 1);
        await commit();
      });
      head.appendChild(x);
    }
    itemBox.appendChild(head);
    /* 文件名待补：这一项要交一件文件，却没有带后缀的文件名（缺失，或只是一句描述）。
       条带卡片与画布节点同一份判据（ltDlvNeedsName），编辑态显式红字标出，不再静默。 */
    if (editing && ltDlvNeedsName(it))
      itemBox.appendChild(
        ltEl("div", "lt-item-miss", ltT("文件名待补：交付以文件为单位，请在上面填一个带后缀的文件名（例：分镜表.md）")),
      );
    const desc = ltEl("input", "lt-in lt-in-desc");
    desc.value = it.desc || "";
    desc.placeholder = ltT("要什么、什么格式、给谁看");
    desc.disabled = !editing;
    desc.onchange = async () => {
      it.desc = ltStr(desc.value, 4000);
      await commit();
    };
    itemBox.appendChild(desc);
    if (editing && it.kind === "choice") {
      const ops = ltEl("input", "lt-in");
      ops.value = (it.options || []).join(" | ");
      ops.placeholder = ltT("候选项，用 | 分隔");
      ops.onchange = async () => {
        it.options = ops.value.split("|").map((s) => s.trim()).filter(Boolean);
        await commit();
      };
      itemBox.appendChild(ops);
      const mt = ltEl("input", "lt-cb");
      mt.type = "checkbox";
      mt.checked = !!it.multi;
      mt.onchange = async () => {
        it.multi = mt.checked;
        await commit();
      };
      const mrow = ltEl("label", "lt-mini");
      mrow.appendChild(mt);
      mrow.appendChild(ltEl("span", null, ltT("可多选")));
      itemBox.appendChild(mrow);
    }
    if (!editing) {
      /* 运行时：Agent 追加的条目要先接受才生效（共识 q27） */
      if (it.byAgent && !it.accepted) {
        const row2 = ltEl("div", "lt-item-act");
        row2.appendChild(ltBtn(ltT("接受这条要求"), "lt-btn lt-btn-pri", async () => {
          it.accepted = 1;
          await commit();
        }));
        row2.appendChild(ltBtn(ltT("驳回"), "lt-btn lt-btn-warn", async () => {
          /* 就地填理由（不用 prompt：抢走整块画布，也拿不到「不要这条」的上下文） */
          const why = ltEl("input", "lt-in");
          why.placeholder = ltT("为什么不要这条？（会回写给 Agent）");
          row2.appendChild(why);
          row2.appendChild(ltBtn(ltT("提交并删除"), "lt-btn lt-btn-warn", async () => {
            const run = ltCurrentRun(wf);
            if (run && path) ltStatePut(run, path, "deliver_reject", { item: it.title, reason: ltStr(why.value, 2000), at: ltNow() });
            items.splice(i, 1);
            await commit();
          }));
          why.focus();
        }));
        itemBox.appendChild(row2);
      } else {
        ltItemInput(itemBox, it, commit, path, node.cfg.uid, editing, !!(node && node.cfg && node.cfg.mode === "deliver"));
      }
    }
    box.appendChild(itemBox);
  });
  if (editing) {
    const add = ltBtn("＋ " + ltT("加一条"), "lt-btn", async () => {
      items.push(ltNormItem({ kind: "file", title: ltT("新条目") + " " + (items.length + 1), required: true }, items.length));
      await commit();
    });
    box.appendChild(add);
  }
  parent.appendChild(box);
  return box;
}
function ltSave2(run) {
  if (run) ltSave(run);
}
/* 交付录入：文件 / 媒体走目录复制，文本 / 选项就地填。
 * isDeliver = 所属人工节点是否「内容交付」模式（由 ltChecklistEditor 判定后传入）：
 * 本函数形参里没有 node（只有 uid），直接引用外层 node 会抛 ReferenceError（历史 bug）。 */
function ltItemInput(parent, it, commit, path, uid, editing, isDeliver) {
  const box = parent;
  const wrap = ltEl("div", "lt-item-in");
  if (it.kind === "text") {
    const ta = ltEl("textarea", "lt-in");
    ta.rows = 3;
    ta.value = it.value || "";
    ta.placeholder = ltT("直接在这里写");
    ta.onchange = async () => {
      it.value = ta.value;
      it.done = !!ta.value.trim();
      it.deliveredVia = ltT("手填");
      it.at = ltNow();
      await commit();
    };
    wrap.appendChild(ta);
  } else if (it.kind === "choice") {
    const opts = ltArr(it.options);
    if (!opts.length) wrap.appendChild(ltEl("div", "lt-fh", ltT("（没有候选项，回图里补）")));
    for (const o of opts) {
      const lab = ltEl("label", "lt-opt");
      const inp = document.createElement("input");
      inp.type = it.multi ? "checkbox" : "radio";
      inp.name = "ltc_" + it.id;
      inp.checked = (it.choice || []).indexOf(o) >= 0;
      inp.onchange = async () => {
        if (it.multi) {
          const cur = new Set(it.choice || []);
          if (inp.checked) cur.add(o);
          else cur.delete(o);
          it.choice = Array.from(cur);
        } else it.choice = [o];
        it.done = !!ltArr(it.choice).length;
        it.deliveredVia = ltT("勾选");
        it.at = ltNow();
        await commit();
      };
      lab.appendChild(inp);
      lab.appendChild(ltEl("span", null, o));
      wrap.appendChild(lab);
    }
  } else {
    const cur = ltArr(it.paths);
    if (cur.length) {
      for (const p of cur) wrap.appendChild(ltEl("div", "lt-path", "📄 " + ltStr(p.split(/[\\/]/).pop(), 80)));
    }
    const row = ltEl("div", "lt-item-act");
    row.appendChild(
      ltBtn("⬆ " + ltT("上传文件"), "lt-btn", async () => {
        const picked = await window.api.fileOpenDialog({ title: ltT("选择要交付的文件"), multi: true });
        const paths = ltArr(picked && picked.paths ? picked.paths : []);
        if (!paths.length) return;
        const run = ltCurrentRun(typeof S !== "undefined" ? S.wf : null);
        const st = run && run.nodes ? run.nodes[path] : null;
        const dir = (st && st.dir) || (run && run.deliverDirs ? run.deliverDirs[uid] : "") || "";
        const got = [];
        for (const p of paths) {
          let dest = String(p);
          if (dir) {
            const name = String(p).split(/[\\/]/).pop();
            dest = dir.replace(/[\\/]+$/, "") + "\\" + name;
            try {
              await window.api.fileCopy(p, dest);
            } catch (_) {
              dest = String(p);
            }
          }
          got.push(dest);
        }
        it.paths = Array.from(new Set(cur.concat(got)));
        it.done = !!it.paths.length;
        it.deliveredVia = ltT("上传");
        it.at = ltNow();
        it.rejected = false;
        await commit();
      }),
    );
    row.appendChild(
      ltBtn(ltT("从画布连线取"), "lt-btn", async () => {
        const got = await ltWiredFiles(path, uid);
        if (!got.length) {
          toast(ltT("上游没有连进来的文件"), "warn");
          return;
        }
        it.paths = Array.from(new Set(cur.concat(got)));
        it.done = !!it.paths.length;
        it.deliveredVia = ltT("连线");
        it.at = ltNow();
        it.rejected = false;
        await commit();
      }),
    );
    if (cur.length)
      row.appendChild(
        ltBtn(ltT("清空"), "lt-btn lt-btn-ico", async () => {
          it.paths = [];
          it.done = false;
          it.rejected = true; /* 显式清空：与磁盘对账时不再拿交付目录里那份把这一项认领回来 */
          await commit();
        }),
      );
    wrap.appendChild(row);
    /* 交付节点的「一个端子 = 一个文件」口径与逐端子上传入口就在这条人工任务的落点上：
       卡片只做汇总（多条一起传 / 从连线取），逐文件对齐在节点上，别让用户找不到。 */
    if (!editing && isDeliver)
      wrap.appendChild(
        ltEl(
          "div",
          "lt-fh",
          ltT("逐文件交付在画布上的交付节点里：每个待交付端子一个「⬆ 上传」（文件名要对得上），交掉后该端子消失。"),
        ),
      );
  }
  box.appendChild(wrap);
  return wrap;
}
/* 从一个上游节点的运行结果里收集「可当交付物」的文件路径。
 * **唯一真源已挪到 app-longtask.js 的 ltNodeFilePaths**（2026 交付节点端子改造：引擎在人工
 * 环节收连线文件时也要用它，连线取值与条带卡的「从画布连线取」必须同源）。这里保留同名壳，
 * 避免其它调用点全仓改名；真源缺席（脚本加载顺序异常）时返回空数组而不是崩。 */
function ltNodeFilePaths(src) {
  return typeof window !== "undefined" && window.LT && typeof window.LT.nodeFilePaths === "function"
    ? window.LT.nodeFilePaths(src)
    : [];
}
/* 从连到交付节点的上游节点里取文件（input_file / 图像 / 视频 / 音频 / 保存节点产物）。
 * 需求 2：交付物既可靠端子连进来（这里），也可以直接上传（上面那颗按钮）。 */
async function ltWiredFiles(path, uid) {
  const out = [];
  const wf = typeof S !== "undefined" ? S.wf : null;
  if (!wf) return out;
  const run = ltCurrentRun(wf);
  const p = String(path || (run && run.waits && run.waits[0] ? run.waits[0].path : ""));
  const st = run && run.nodes ? run.nodes[p] : null;
  const u = String(uid || (st && st.uid) || "");
  const dn = u ? ltDeliverNodeOf(u) : null;
  if (!dn) return out;
  const ins = ltArr(wf.wires).filter((w) => String(w.to) === String(dn.id));
  for (const w of ins) {
    const src = ltArr(wf.nodes).find((n) => n.id === w.from);
    if (!src) continue;
    for (const q of ltNodeFilePaths(src)) out.push(q);
  }
  return Array.from(new Set(out));
}

/* ── 设置 / 历史 run / 体检 / 记忆 ─────────────────────────────── */
async function ltRunsDlg(wf) {
  const r = await window.api.ltRunList(wf.id);
  const runs = ltArr(r && r.runs);
  const ov = openOverlay(ltT("长周期任务 · 历史运行"), { persistent: true });
  void ov;
  const body = document.getElementById("ovBody");
  if (!body) return;
  if (!runs.length) body.appendChild(ltEl("div", "lt-fh", ltT("还没有运行记录")));
  for (const it of runs) {
    const row = ltEl("div", "lt-run");
    row.appendChild(ltEl("b", null, it.name || it.runId));
    row.appendChild(ltEl("span", null, new Date(it.startedAt || 0).toLocaleString() + " · " + ltT(it.status) + " · " + it.steps + ltT(" 步")));
    row.appendChild(
      ltBtn(ltT("切到这个 run"), "lt-btn", async () => {
        const t = ltTaskOf(wf, it.taskId);
        if (t) {
          t.activeRun = it.runId;
          wf.longtask.active = t.uid;
        }
        await ltResume(wf, it.runId);
        closeOverlay();
        ltRenderStrip();
      }),
    );
    body.appendChild(row);
  }
  ltFootClose();
}
async function ltOrphanDlg(wf) {
  const uids = [];
  for (const t of ltTasks(wf)) for (const n of ltArr(t.graph.nodes)) if (n.kind === "human" && n.cfg.uid) uids.push(n.cfg.uid);
  const ws = typeof wfWorkspace === "function" ? String(wfWorkspace() || "") : "";
  const r = await window.api.ltDeliverOrphans({ uids, workspace: ws });
  const orphans = ltArr(r && r.orphans);
  toast(orphans.length ? ltT("发现 ") + orphans.length + ltT(" 个无主交付目录（只报告，不删）") : ltT("没有无主交付目录"), orphans.length ? "warn" : "ok");
  if (!orphans.length) return;
  const ov = openOverlay(ltT("交付目录体检（只报告，绝不自动删）"), { persistent: true });
  void ov;
  const body = document.getElementById("ovBody");
  if (!body) return;
  for (const o of orphans) {
    const row = ltEl("div", "lt-orphan");
    row.appendChild(ltEl("b", null, o.uid));
    row.appendChild(ltEl("span", null, o.dir));
    body.appendChild(row);
  }
  body.appendChild(ltEl("div", "lt-fh", ltT("确认没用了再自己去资源管理器删；系统永不动手删你的文件。")));
  ltFootClose();
}
function ltSettingsDlg() {
  const c = ltCfg();
  const wf = typeof S !== "undefined" ? S.wf : null;
  const ov = openOverlay(ltT("长周期任务 · 设置"), { persistent: true });
  void ov;
  const body = document.getElementById("ovBody");
  if (!body) return;
  /* 任务管理：原先挂在条带头部左端那颗任务菜单按钮（已按要求移除），
     任务切换 / 新建 / 历史 run / 交付目录体检 一并挪到这里，功能不丢。 */
  const tasks = wf ? ltTasks(wf) : [];
  if (wf && tasks.length) {
    const tb = ltEl("div", "lt-set");
    tb.appendChild(ltEl("div", "lt-side-h2", ltT("这张画布的长任务")));
    const sel = ltEl("select", "lt-in");
    for (const t of tasks) {
      const o = document.createElement("option");
      o.value = t.uid;
      o.textContent = t.name + (t.enabled ? " · " + ltT("已绑定") : "") + " · v" + (Number(t.ver) || 1) + " · " + ltArr(t.graph.nodes).length + ltT(" 节点");
      if (wf.longtask.active === t.uid) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      wf.longtask.active = sel.value;
      if (typeof ltPersistWf === "function") ltPersistWf(wf);
      else if (typeof scheduleSave === "function") scheduleSave(true);
      ltDrill = [];
      ltSel.path = "";
      ltRenderStrip();
    };
    ltField(tb, ltT("切到哪个任务"), sel);
    const trow = ltEl("div", "lt-card-row");
    trow.appendChild(ltBtn(ltT("＋ 创建长任务"), "lt-btn-pri", () => openLtCreateDlg(wf)));
    trow.appendChild(ltBtn(ltT("历史 run"), "lt-btn", () => ltRunsDlg(wf)));
    trow.appendChild(ltBtn(ltT("交付目录体检"), "lt-btn", () => ltOrphanDlg(wf)));
    /* 与条带右上角那颗 🗑 同一个落点：下拉里选中的那张就是被删的那张 */
    trow.appendChild(ltBtn(ltT("🗑 删除选中的任务"), "lt-btn lt-btn-del", () => ltConfirmDeleteTask(wf, sel.value)));
    tb.appendChild(trow);
    body.appendChild(tb);
  }
  const box = ltEl("div", "lt-set");
  body.appendChild(box);
  const num = (label, key, min, max, hint, labelOf) => {
    /* 四个图级设置都改成下拉：数字手打能越界 / 打错，下拉把合法取值直接列全，
       写回仍是同一个数字（ltCfgPatch → S.config.longtask[key]），归一口径未变。 */
    const C = ltCtl();
    const opts = [];
    for (let i = min; i <= max; i++) opts.push({ value: String(i), label: labelOf ? labelOf(i) : String(i) });
    const apply = (v) => {
      const n = Math.max(min, Math.min(max, Number(v) || min));
      ltCfgPatch({ [key]: n });
      toast(ltT("已保存"), "ok");
    };
    if (C) {
      C.ltSelField(box, label, String(c[key]), opts, apply, { hint: hint, searchPlaceholder: ltT("输入以搜索…") });
      return;
    }
    /* 控件模块不可用的回落：仍用原生下拉（不是数字输入框），口径与上面完全一致 */
    const s = ltEl("select", "lt-in");
    for (const o of opts) {
      const op = document.createElement("option");
      op.value = o.value;
      op.textContent = o.label;
      if (String(c[key]) === o.value) op.selected = true;
      s.appendChild(op);
    }
    s.onchange = () => apply(s.value);
    ltField(box, label, s, hint);
  };
  num(ltT("图级并行度"), "parallel", 1, 16, ltT("同时最多几个 Agent 环节在跑；超出排队"));
  num(ltT("Agent 失败重试"), "retry", 0, 5, ltT("每个环节失败后原样重发的次数"));
  num(ltT("驳回回跳上限"), "maxRound", 0, 9, ltT("0 = 不限（默认）；超过上限即转「失败」"), (i) => (i === 0 ? ltT("不限") : String(i)));
  num(ltT("记忆注入 TopK"), "topk", 0, 32, ltT("每个环节往提示词里塞几条记忆；0 = 不注入"));
  box.appendChild(ltEl("div", "lt-fh", ltT("条带展开高度用鼠标在细线上拖，位置与高度自动记住（跨画布统一）。")));
  ltFootClose("完成并关闭", "lt-btn lt-btn-pri");
}
/* 记忆管理：列表 + 检索 + 手动新增 + 删除 + 与事实库双向同步 */
function ltMemoryDlg() {
  const ov = openOverlay(ltT("长期记忆"), { persistent: true });
  void ov;
  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body) return;
  const wf = typeof S !== "undefined" ? S.wf : null;
  const wrap = ltEl("div", "lt-mem");
  body.appendChild(wrap);
  const q = ltEl("input", "lt-in");
  q.placeholder = ltT("检索（关键词；中文按子串包含匹配）…");
  q.onkeydown = (e) => {
    if (e.key === "Enter") load();
  };
  const bar = ltEl("div", "lt-mem-bar");
  bar.appendChild(q);
  bar.appendChild(ltBtn(ltT("检索"), "lt-btn", load));
  bar.appendChild(ltBtn(ltT("全部"), "lt-btn", () => {
    q.value = "";
    load();
  }));
  /* 主口径 = 本画布的专家团事实库（真源 window.MTNodeFactLib，锚在 S.config.team 上）；
     外部目录导入保留为第二入口（第三方 Markdown 库）。 */
  bar.appendChild(ltBtn(ltT("从专家团事实库导入"), "lt-btn", async () => {
    const r = await ltSyncFactLibToMemory();
    toast(r.ok ? ltT("已导入 ") + r.added + ltT(" 条（来自 ") + r.files + ltT(" 篇文档）") : r.error, r.ok ? "ok" : "err");
    load();
  }));
  bar.appendChild(ltBtn(ltT("从外部目录导入"), "lt-btn", async () => {
    const dir = await window.api.fileOpenDialog({ title: ltT("选择外部事实库目录（读其中的 Markdown / 文本作为事实）"), directory: true });
    const p = (dir && dir.path) || "";
    if (!p) return;
    const r = await ltSyncFactLibToMemory(p);
    toast(r.ok ? ltT("已导入 ") + r.added + ltT(" 条（来自 ") + r.files + ltT(" 篇文档）") : r.error, r.ok ? "ok" : "err");
    load();
  }));
  bar.appendChild(ltBtn(ltT("候选待确认 ×" + ltMemPendingCount()), "lt-btn lt-btn-warn", () => ltMemPendingDlg()));
  wrap.appendChild(bar);
  const list = ltEl("div", "lt-mem-list");
  wrap.appendChild(list);
  const add = ltEl("div", "lt-mem-add");
  const at = ltEl("input", "lt-in");
  at.placeholder = ltT("标题");
  const ab = ltEl("textarea", "lt-in");
  ab.placeholder = ltT("正文（一条一个主题）");
  ab.rows = 2;
  add.appendChild(at);
  add.appendChild(ab);
  add.appendChild(
    ltBtn(ltT("＋ 手动记一条"), "lt-btn lt-btn-pri", async () => {
      if (!at.value.trim() || !ab.value.trim()) {
        toast(ltT("标题和正文都要填"), "warn");
        return;
      }
      await ltMemAdd([Object.assign(ltMemScopeArgs(wf), { title: at.value, body: ab.value, type: "fact", src: "manual" })]);
      at.value = "";
      ab.value = "";
      load();
    }),
  );
  wrap.appendChild(add);
  if (foot) {
    foot.innerHTML = "";
    foot.appendChild(ltBtn(ltT("关闭"), "lt-btn", () => closeOverlay()));
  }
  async function load() {
    list.innerHTML = "";
    const items = q.value.trim() ? await ltMemRecall(q.value, wf, 40) : ltArr((await window.api.ltMemList(Object.assign(ltMemScopeArgs(wf), { limit: 80 }))).items);
    if (!items.length) list.appendChild(ltEl("div", "lt-fh", ltT("还没有记忆条目：跑长任务时让 Agent 提议，或上面手动记一条")));
    for (const it of items) {
      const row = ltEl("div", "lt-mem-i");
      row.appendChild(ltEl("b", null, it.title));
      row.appendChild(ltEl("span", "lt-mem-meta", it.scope + "/" + it.type + (it.layer ? "(" + it.layer + ")" : "") + " · " + new Date(it.updated || it.created).toLocaleDateString()));
      row.appendChild(ltEl("div", "lt-mem-body", ltStr(it.body, 600)));
      if (it.src) row.appendChild(ltEl("div", "lt-mem-src", ltStr(it.src, 200)));
      const acts = ltEl("div", "lt-item-act");
      /* 有本画布的专家团事实库就写进库里那篇固定文档（落盘即广播 factlib:saved，左栏即时刷新）；
         没有库就退到「选一个外部目录」，别让这一条记忆无处可去。 */
      const libDocCount = ltArr(ltFactLibApi() && wf ? ltFactLibApi().listDocs(wf.id) : []).length;
      acts.appendChild(ltBtn(libDocCount ? ltT("导出到专家团事实库") : ltT("导出到外部目录"), "lt-btn lt-btn-ico", async () => {
        if (libDocCount) {
          const r = await ltSyncMemoryToFactLib([it]);
          toast(r.ok ? ltT("已写出：") + r.path : r.error, r.ok ? "ok" : "err");
          return;
        }
        const dir = await window.api.fileOpenDialog({ title: ltT("选择要写出的外部事实库目录"), directory: true });
        const p = (dir && dir.path) || "";
        if (!p) return;
        const r = await ltSyncMemoryToFactLib([it], p);
        toast(r.ok ? ltT("已写出：") + r.path : r.error, r.ok ? "ok" : "err");
      }));
      acts.appendChild(ltBtn(ltT("删除"), "lt-btn lt-btn-ico", async () => {
        await window.api.ltMemDelete([it.id]);
        load();
      }));
      row.appendChild(acts);
      list.appendChild(row);
    }
  }
  load();
}
function ltMemPendingDlg() {
  if (!ltMemPending.length) {
    toast(ltT("没有待确认的记忆候选"), "ok");
    return;
  }
  const ov = openOverlay(ltT("待确认的候选记忆") + " ×" + ltMemPending.length, { persistent: true });
  void ov;
  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body) return;
  const render = () => {
    body.innerHTML = "";
    if (!ltMemPending.length) body.appendChild(ltEl("div", "lt-fh", ltT("都处理完了")));
    for (const p of ltMemPending.slice()) {
      const row = ltEl("div", "lt-mem-i");
      const ta = ltEl("textarea", "lt-in");
      ta.rows = 2;
      ta.value = p.body;
      const ti = ltEl("input", "lt-in");
      ti.value = p.title;
      row.appendChild(ti);
      row.appendChild(ta);
      /* 归属回显：这条候选是哪个 run（长任务）提出来的 —— 候选随该 run 的 checkpoint 落盘，
         用户确认前重启 / 切画布也还在（见 app-longtask.js 的 ltMemSyncPending）。 */
      row.appendChild(ltEl("div", "lt-mem-src", (p.src || "") + (p.ownerName ? " · " + ltT("来自：") + p.ownerName : "")));
      const acts = ltEl("div", "lt-item-act");
      acts.appendChild(ltBtn(ltT("接受"), "lt-btn lt-btn-pri", async () => {
        ltMemDropPending(p); /* 归属 run 的那份一起摘掉：续跑 / 重启不会把它合并回来 */
        await ltMemAdd([Object.assign(ltMemScopeArgs(typeof S !== "undefined" ? S.wf : null), { title: ti.value.trim() || p.title, body: ta.value.trim() || p.body, type: p.type, tags: p.tags, src: p.src })]);
        render();
        ltRenderStrip();
      }));
      acts.appendChild(ltBtn(ltT("驳回"), "lt-btn", () => {
        ltMemDropPending(p);
        render();
        ltRenderStrip();
      }));
      row.appendChild(acts);
      body.appendChild(row);
    }
  };
  render();
  if (foot) {
    foot.innerHTML = "";
    foot.appendChild(ltBtn(ltT("全部接受"), "lt-btn lt-btn-pri", () => {
      ltMemAcceptAll();
      render();
      ltRenderStrip();
    }));
    foot.appendChild(ltBtn(ltT("全部驳回"), "lt-btn", () => {
      ltMemRejectAll();
      render();
      ltRenderStrip();
    }));
    foot.appendChild(ltBtn(ltT("完成并关闭"), "lt-btn", () => closeOverlay()));
  }
}
function ltProblemsDlg(task) {
  const ov = openOverlay(ltT("图校验问题"), { persistent: true });
  void ov;
  const body = document.getElementById("ovBody");
  if (!body) return;
  for (const x of ltValidate(task.graph)) body.appendChild(ltEl("div", "lt-warn-row " + (x.level === "err" ? "lt-err" : "lt-warn"), (x.level === "err" ? "✗ " : "! ") + x.msg));
  ltFootClose();
}

/* ── 交付节点在主画布上的 body 渲染 ──────────────────────────────
 * 节点契约（本轮共识 q1~q16）：**一个还没交的文件项 = 一个仅输入端子**（端子标签 = 文件名），
 * 文件交掉后端子消失、其余端子按序重排；节点板身用一张 Markdown 表列出「每个端子 ↔ 该文件
 * 的内容是什么」，表下方才是端子行（每个端子一个上传钮，只能传与文件名对得上的那一份）。
 * 两种交付路都保留：端子连进来（上游自动给，收线在 app-longtask.js 的 ltDeliverCollectWired），
 * 或在端子行上传 / 在已交区撤回。节点内改清单 = 画布优先，统一走 ltDeliverSyncFromNode。 */
function ltDlvCell(s, max) {
  return ltStr(String(s == null ? "" : s).replace(/\s*\r?\n\s*/g, " ").replace(/\|/g, "\\|"), max || 60);
}
function ltDlvReqCell(it) {
  if (it.required === false) return ltT("选填");
  return it.byAgent && !it.accepted ? ltT("必填·Agent 已产出") : ltT("必填");
}
function ltDlvStateCell(it) {
  if (!it.done) return ltT("待交付");
  const via = String(it.deliveredVia || "");
  return ltT("已交付") + (via ? "（" + via + "）" : "");
}
/* 交付物文件名（唯一取名口径在 app-longtask.js 的 ltDeliverFileName）：
   本文件里端子标签 / md 表 / 上传对齐 / 「文件名待补」判据一律经这里取，
   不再有第二份拼名逻辑（缺失时由 LT 侧回退 title，并可由 ltDeliverNameOf 标出待补）。 */
function ltDlvName(it) {
  return window.LT && typeof window.LT.deliverFileName === "function" ? window.LT.deliverFileName(it) : String((it && it.title) || "");
}
/* 文件名待补：条目要交一件文件，却没有一个带后缀的文件名（缺失，或只是一句描述）。
   真源在 app-longtask.js 的 ltDeliverNeedsName；真源缺席（脚本加载顺序异常）时按「不缺」回落，
   宁可少标一处，也不能凭猜把好条目判成缺文件名。 */
function ltDlvNeedsName(it) {
  if (window.LT && typeof window.LT.deliverNeedsName === "function") return !!window.LT.deliverNeedsName(it);
  return false;
}
function ltDlvLabel(it, max) {
  if (window.LT && typeof window.LT.deliverNameOf === "function") return ltStr(window.LT.deliverNameOf(it), max || 60);
  return ltStr(ltDlvName(it) || (it && it.title), max || 60);
}
/* 取扩展名（含点，小写）；没有后缀返回 ""。
   与 app-longtask.js 的 ltExtOfName 同一式子（那边判「文件名像不像文件名」，
   这里判「对话框里填的写法能不能当文件名」）—— 两边必须同口径，否则会出现
   「对话框放行、节点标待补」的错位。 */
function ltDlvExtOf(name) {
  const s = String(name == null ? "" : name).trim();
  const base = s.split(/[\\/]/).pop() || "";
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return m ? "." + m[1].toLowerCase() : "";
}
/* 板身上那张表的**源码**：列 = 文件名 · 内容说明 · 必填/选填 · 格式或大小要求 · 交付状态。
   生成真 Markdown 表（表头 + 分隔行 + 行）；板身不再直接铺这份源码，由 ltDlvTableEl 渲染成
   真表格，Markdown 正文由同排「▤ 预览 Markdown」按钮交给应用内 Markdown 预览器打开。
   第一列是**文件名**（不是一句话描述）：没有文件名就显式写「待补」，不留空、不拿描述顶替。 */
function ltDeliverMarkdownTable(node) {
  const items = ltArr(node && node.ltItems);
  const rows = [
    ltT("| 文件名 | 内容说明 | 必填/选填 | 格式或大小要求 | 交付状态 |"),
    "| --- | --- | --- | --- | --- |",
  ];
  for (const it of items) {
    rows.push(
      "| " +
        ltDlvCell(ltDlvName(it) || "（" + ltT("文件名待补") + "）", 60) +
        " | " +
        ltDlvCell(it.desc, 80) +
        " | " +
        ltDlvCell(ltDlvReqCell(it), 20) +
        " | " +
        ltDlvCell(it.accept, 40) +
        " | " +
        ltDlvCell(ltDlvStateCell(it), 30) +
        " |",
    );
  }
  if (!items.length) rows.push("| " + ltT("（还没有文件项：点下面「＋ 添加文件」）") + " |  |  |  |  |");
  return rows.join("\n");
}
/* 板身那张表**渲染成真表格**（本轮需求：交付节点 body 里的 md 表要正确渲染）。
   与全站其它 Markdown 预览同源：走 app.js 的 renderMarkdown（唯一入口，含公式占位与链接防护），
   拿到真 <table> 而不是把 `| a | b |` 源码铺在板身上。
   渲染器缺席（脚本加载顺序异常 / 单测沙箱里只装了本文件）时回落成等宽源码 —— 宁可难看，
   也不能让板身空一块。 */
function ltDlvTableEl(node) {
  const src = ltDeliverMarkdownTable(node);
  const box = ltEl("div", "lt-dlv-md");
  box.title = ltT("这张表就是每个输入端子对应的文件内容；点「▤ 预览 Markdown」在预览器里看全文");
  let html = "";
  try {
    if (typeof renderMarkdown === "function") html = String(renderMarkdown(src) || "");
  } catch (_) {
    html = "";
  }
  if (html) box.innerHTML = html;
  else box.appendChild(ltEl("pre", "lt-dlv-md-src", src));
  return box;
}
/* 交付目录里那份「给人看的清单 Markdown」的路径：真源是 longtask-store.js 的 deliverMarkdown
   （<交付目录>\交付清单.md，与 manifest.json 同目录，随清单一起被应用重写）。
   交付目录还不知道（这一环还没建目录）就返回 "" —— 不猜路径、也不自己另拼一份。 */
function ltDlvMarkdownPath(node) {
  const dir = String((node && node.ltDir) || "").replace(/[\\/]+$/, "");
  return dir ? dir + "\\交付清单.md" : "";
}
/* 交付物清单的 Markdown 预览：直接开应用内 Markdown 预览器（app.js 的 openMdViewer），
   用户不必再把 Markdown 复制出去看。
   · 磁盘上已经有 <交付目录>\交付清单.md → 开**它**（完整人读文档：顶表 + 每件一节），
     并按只读开：那份镜像随清单每次变化都被应用重写，在预览器里改它只会白改；
   · 还没落盘（目录未知 / 文件被删 / 读不到）→ 就地拿板身这张表的 Markdown 开一份虚拟文档，
     板上有什么就预览什么，不弹「文件不存在」。
   两种形态落在同一个预览器里，它自带「复制全文」—— 要看全文、要取 Markdown 源码都是这一个入口。 */
async function ltDlvPreviewMarkdown(node) {
  if (typeof openMdViewer !== "function") {
    toast(ltT("Markdown 预览器未就绪"), "warn");
    return;
  }
  const file = ltDlvMarkdownPath(node);
  if (file) {
    let exists = false;
    try {
      const st = window.api && window.api.fileStat ? await window.api.fileStat(file) : null;
      exists = !!(st && st.ok);
    } catch (_) {}
    if (exists) {
      openMdViewer(file, { readOnly: true });
      return;
    }
  }
  openMdViewer("", {
    content: ltDeliverMarkdownTable(node),
    readOnly: true,
    title: ltT("交付物清单 Markdown"),
    subtitle: String((node && node.ltUid) || ""),
  });
}
/* 选定文件与文件项的对齐检查：**只提示不阻止**（共识 q10）。
 * accept 自由文本里识别两类可机读要求：后缀（.md / .csv …）与体积上限（≤ 20 MB）。
 * 认不出的写法一律不提示 —— 宁可不提示，也不能拿猜出来的规则误报。 */
function ltDlvAcceptCheck(it, filePath, sizeBytes) {
  const raw = String((it && it.accept) || "").trim();
  const name = String(filePath || "").split(/[\\/]/).pop() || "";
  if (!raw) return [];
  const warns = [];
  const exts = [];
  const re = /\.([A-Za-z0-9]{1,8})\b/g;
  let m;
  while ((m = re.exec(raw))) exts.push(m[1].toLowerCase());
  if (exts.length) {
    const mine = (name.split(".").pop() || "").toLowerCase();
    if (exts.indexOf(mine) < 0) warns.push(ltT("文件后缀与要求（.") + exts.join(" / .") + ltT("）不符：") + name);
  }
  const sz = /(≤|<=|不超过|最大|上限)\s*([0-9]+(?:\.[0-9]+)?)\s*(MB|M|GB|G|KB|K)/i.exec(raw);
  if (sz && Number(sizeBytes) > 0) {
    const unit = String(sz[3] || "").toUpperCase();
    const mul = unit === "GB" || unit === "G" ? 1024 * 1024 * 1024 : unit === "KB" || unit === "K" ? 1024 : 1024 * 1024;
    const cap = Number(sz[2]) * mul;
    if (Number(sizeBytes) > cap) warns.push(ltT("文件体积超过要求：") + Math.round(Number(sizeBytes) / 1024) + " KB > " + String(sz[0]).trim());
  }
  return warns;
}
/* 把一个文件项交掉：复制进该 uid 的交付目录 → 标记已交 → 其端子与连线一起消失（共识 q14）。
 * 被上传覆盖的连线在已交区留「曾有端子连入」的痕迹（it.wired）。 */
async function ltDlvItemUpload(node, item) {
  if (!node || !item || item.done) return 0;
  const picked = await window.api.fileOpenDialog({ title: ltT("选择要交付的文件"), multi: true });
  const paths = ltArr(picked && picked.paths ? picked.paths : []);
  if (!paths.length) return 0;
  const want = ltDlvName(item); /* 对齐用的是文件名（含后缀），不是条目描述 */
  const dir = String(node.ltDir || "");
  const got = [];
  const warns = [];
  let mismatch = "";
  for (const p of paths) {
    const name = String(p).split(/[\\/]/).pop() || "";
    if (want && name !== want) mismatch = mismatch || name;
    let sz = 0;
    try {
      const r = await window.api.fileStat(String(p));
      sz = Number((r && (r.size != null ? r.size : r)) || 0) || 0;
    } catch (_) {}
    for (const w of ltDlvAcceptCheck(item, p, sz)) warns.push(w);
    let dest = String(p);
    if (dir) {
      /* 落点固定是交付目录里的同名文件（交付以文件为单位）。file:copy 遇到「同名文件已存在」
         会明确回错 —— 那份就是这一件的成品（上次交的 / 应用外拖进去的），认它，不退回源路径，
         否则「这一件交在哪儿」会变得说不清。 */
      const to = dir.replace(/[\\/]+$/, "") + "\\" + name;
      try {
        await window.api.fileCopy(String(p), to);
        dest = to;
      } catch (_) {
        dest = String(p);
      }
    }
    got.push(dest);
  }
  if (!got.length) return 0;
  /* 该端子上原有的连线：随端子一起消失（用户已用上传覆盖线连进来的内容） */
  const hadWire =
    typeof S !== "undefined" && S.wf
      ? ltArr(S.wf.wires).some(
          (w) => !w.rel && String(w.to) === String(node.id) && String(w.ltItem || "") === String(item.id),
        )
      : false;
  if (hadWire && typeof S !== "undefined" && S.wf) {
    S.wf.wires = ltArr(S.wf.wires).filter(
      (w) => w.rel || !(String(w.to) === String(node.id) && String(w.ltItem || "") === String(item.id)),
    );
  }
  item.paths = Array.from(new Set(ltArr(item.paths).concat(got)));
  item.done = true;
  item.deliveredVia = ltT("上传");
  item.at = ltNow();
  item.rejected = false; /* 重新交了：与磁盘对账可以再认领这一项 */
  if (hadWire) item.wired = true;
  await ltDeliverSyncFromNode(node);
  if (typeof renderCanvas === "function") renderCanvas();
  for (const w of warns) toast(w, "warn");
  if (!want)
    toast(ltT("这一项还没定下文件名（含后缀）：已照样收下，请回节点补上文件名再确认交付"), "warn");
  else if (mismatch)
    toast(ltT("选的文件名和这个端子的文件名对不上（端子「") + want + ltT("」← ") + mismatch + ltT("）：已照样收下，可撤回重传"), "warn");
  else toast(ltT("已交付：") + want, "ok");
  return got.length;
}
/* 撤回：只把「已交」标记去掉、端子放回来，磁盘文件与交付目录一律不动（共识 q13 / q15）。
 * rejected = 用户显式撤回：交付目录里那份文件还在，但它属于上一轮 —— 与磁盘对账时
 * 不再拿它把这一项自动认领回来（重新上传时清掉该标记）。 */
async function ltDlvItemRevoke(node, item) {
  if (!node || !item || !item.done) return;
  item.done = false;
  item.paths = [];
  item.value = "";
  item.deliveredVia = "";
  item.at = 0;
  item.rejected = true;
  await ltDeliverSyncFromNode(node);
  toast(ltT("已撤回：") + ltDlvLabel(item) + ltT("（文件仍在交付目录里；要重新交就再点一次上传）"), "ok");
}
/* 与磁盘对账（真源在 app-longtask.js 的 ltDeliverReconcileDisk，这里只是 UI 口）：
 * 交付目录 / 条目声明路径上真的有文件 → 认成已交；标记说已交但两处都找不到 → 撤掉。
 * 对账后回写一次（manifest / 图定义 / 运行态同源），板身与条带卡的计数立刻一致。 */
async function ltDlvReconcile(node) {
  const items = ltArr(node && node.ltItems);
  const before = ltItemsProgress(items).done;
  const changed =
    window.LT && typeof window.LT.deliverReconcileDisk === "function"
      ? await window.LT.deliverReconcileDisk(node, node && node.ltDir, items)
      : 0;
  if (changed) await ltDeliverSyncFromNode(node);
  const pr = ltItemsProgress(ltArr(node && node.ltItems));
  if (typeof renderCanvas === "function") renderCanvas();
  if (typeof ltRenderStrip === "function") ltRenderStrip();
  return { changed: changed, done: pr.done, need: pr.need, before: before };
}
/* 「＋ 添加文件」：文件名（必填）/ 内容说明 / 必填选填 / 格式或大小要求。
 * 在画布节点上增删改 = 画布优先（共识 q12）：这里加的文件项同时写回图定义与 manifest。 */
function ltDlvAddFileDlg(node) {
  const ov = openOverlay(ltT("添加待交付文件"), { persistent: true, min: false });
  void ov;
  const body = document.getElementById("ovBody");
  if (!body) return;
  const wrap = ltEl("div", "lt-dlv-form");
  const mk = (label, tag, ph) => {
    const lab = ltEl("label", "lt-dlv-fl", label);
    const inp = document.createElement(tag === "textarea" ? "textarea" : "input");
    inp.className = "lt-in";
    if (tag === "textarea") inp.rows = 3;
    if (ph) inp.placeholder = ph;
    lab.appendChild(inp);
    wrap.appendChild(lab);
    return inp;
  };
  const nameIn = mk(ltT("文件名（端子标签就是它，上传时按它对齐）"), "input", ltT("例：分镜表.md"));
  /* 红灯行内提示（不弹窗、不关对话框）：缺文件名 / 缺后缀 / 重名都在这里说清楚，
     用户改一个字就能重试，不必重新打开表单。 */
  const nameErr = ltEl("div", "lt-dlv-miss");
  wrap.appendChild(nameErr);
  const descIn = mk(ltT("内容说明（这个文件要写什么）"), "textarea", ltT("例：每个镜头的景别 / 时长 / 台词 / 运镜"));
  const accIn = mk(ltT("格式或大小要求"), "input", ltT("例：仅 .md · ≤ 2 MB（只提示不拦）"));
  const reqLab = ltEl("label", "lt-dlv-fl lt-dlv-fc", ltT("必填（没交齐时点确认会先弹确认窗：说清原因就能继续）"));
  const reqIn = document.createElement("input");
  reqIn.type = "checkbox";
  reqIn.checked = true;
  reqLab.insertBefore(reqIn, reqLab.firstChild);
  wrap.appendChild(reqLab);
  body.appendChild(wrap);
  const foot = document.getElementById("ovFoot");
  if (foot) {
    foot.innerHTML = "";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "lt-btn";
    cancel.textContent = ltT("取消");
    cancel.onclick = () => closeOverlay();
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "lt-btn lt-btn-pri";
    ok.textContent = ltT("添加");
    ok.onclick = async () => {
      /* 只留文件名：端子标签就是文件名，带目录的写法（C:\x\分镜表.md）会让「端子标签」
         与上传对齐取的那一段不一致 —— 就地归一，并把归一后的名字回填输入框。 */
      const base = String(ltStr(nameIn.value, 200).trim()).split(/[\\/]/).pop() || "";
      const title = base.trim();
      if (title !== String(nameIn.value).trim()) nameIn.value = title;
      /* 文件名必填、且必须带后缀：交付以文件为单位，一个端子就是一个待交付文件 ——
         没有后缀的写法（「一批配图」）到下游只会变成一句描述，不是一件能交的文件。 */
      if (!title) {
        nameErr.textContent = ltT("文件名不能空：它就是这个端子的标签");
        toast(ltT("文件名不能空：它就是这个端子的标签"), "warn");
        nameIn.focus();
        return;
      }
      if (!ltDlvExtOf(title)) {
        nameErr.textContent = ltT("文件名必须带后缀（例：分镜表.md）：交付是一件一件文件");
        toast(ltT("文件名必须带后缀（例：分镜表.md）：交付是一件一件文件"), "warn");
        nameIn.focus();
        return;
      }
      const items = ltArr(node.ltItems);
      if (items.some((it) => ltDlvName(it) === title)) {
        nameErr.textContent = ltT("已经有一个同名文件项了：端子标签要唯一，换一个名字");
        toast(ltT("已经有一个同名文件项了：端子标签要唯一，换一个名字"), "warn");
        nameIn.focus();
        return;
      }
      nameErr.textContent = "";
      items.push({
        id: "it" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind: "file",
        title: title,
        file: title,
        desc: ltStr(descIn.value, 4000),
        accept: ltStr(accIn.value, 200),
        required: !!reqIn.checked,
        options: [],
        multi: false,
        byAgent: false,
        done: false,
        value: "",
        paths: [],
        choice: [],
        deliveredVia: "",
        at: 0,
      });
      node.ltItems = items;
      await ltDeliverSyncFromNode(node);
      closeOverlay();
      toast(ltT("已添加待交付文件：") + title, "ok");
      if (typeof renderCanvas === "function") renderCanvas();
    };
    foot.appendChild(cancel);
    foot.appendChild(ok);
  }
}
function ltDlvOpenRibbonCard() {
  ltApplyOpen(true);
  ltViewPatch(LT_LAST_WF_OBJ, { ltOpen: true });
  ltCfgPatch({ open: true });
  ltRenderStrip();
}
/* 节点板身：md 表（每个端子 ↔ 该文件的内容，渲染成真表格）+ 端子行（各带一个上传钮）+ 已交区（可撤回）。 */
function buildDeliverBody(node, body) {
  const items = ltArr(node.ltItems);
  const pending = (window.LT && window.LT.deliverPendingItems
    ? window.LT.deliverPendingItems(node)
    : items.filter((it) => (it.kind === "file" || it.kind === "media") && !it.done)) || [];
  const pr = ltItemsProgress(items);
  const info = ltEl("div", "lt-dlv");
  info.appendChild(ltEl("div", "lt-dlv-h", ltT("交付节点 · 由长周期任务创建")));
  info.appendChild(ltEl("div", "lt-dlv-uid", String(node.ltUid || "")));
  if (node.ltGoal) info.appendChild(ltEl("div", "lt-dlv-goal", ltStr(node.ltGoal, 200)));
  info.appendChild(
    ltEl(
      "div",
      "lt-dlv-bar" + (pr.ready ? " ok" : ""),
      ltT("已交付 ") + pr.done + "/" + pr.need + (pr.opt ? ltT("（选填 ") + pr.optDone + "/" + pr.opt + "）" : ""),
    ),
  );
  /* 放行横幅（本轮需求）：这一环是**带着没交齐的项**继续的 —— 板身上明说未交清单与
     人工写的说明（与状态键 deliver_missing / manifest.releases 同一个排版口径），
     免得画布上只看到「已交付 2/4」而不知道剩下两件是被放行掉的。 */
  if (Number(node.ltReleaseAt) > 0) {
    const miss = ltArr(node.ltReleaseMissing);
    const rb = ltEl("div", "lt-dlv-rel");
    rb.appendChild(ltEl("div", "lt-dlv-rel-h", "⚠ " + ltT("未交齐放行：还有 ") + miss.length + ltT(" 项必填未交，任务已继续")));
    rb.appendChild(ltEl("div", "lt-dlv-rel-b", ltReleaseRecText({ missing: miss, note: node.ltReleaseNote })));
    rb.appendChild(ltEl("div", "lt-dlv-rel-when", ltT("放行时间：") + new Date(Number(node.ltReleaseAt)).toLocaleString() + ltT("（逐轮记录在交付目录的《交付清单.md》「未交付说明」段）")));
    info.appendChild(rb);
  }
  /* ① md 表：每个端子对应文件的内容是什么（一个文件项 = 一个端子，端子标签就是文件名）。
     板身渲染成**真表格**（md 表正确渲染）；同排那颗按钮把清单 Markdown 交给
     Markdown 预览器打开 —— 看全文 / 取源码都进那个窗，不必再复制 Markdown。 */
  const mdh = ltEl("div", "lt-dlv-mdh");
  mdh.appendChild(
    ltBtn(
      ltT("▤ 预览 Markdown"),
      "lt-btn lt-btn-ico",
      () => ltDlvPreviewMarkdown(node),
      ltT("在 Markdown 预览器里打开这份交付清单（不必先复制 Markdown）"),
    ),
  );
  info.appendChild(mdh);
  info.appendChild(ltDlvTableEl(node));
  /* ② 端子行：每个端子一个上传钮（文件名要对得上；不符只标红警告，不拦） */
  info.appendChild(ltEl("div", "lt-dlv-sec", ltT("待交付端子 · ") + pending.length + ltT(" 个（连入即视为已交，上传后该端子消失）")));
  /* 还没定下文件名的项：在端子行上面先总说一句（交付以文件为单位，缺名就没法一件一件交） */
  const missNames = pending.filter(ltDlvNeedsName).length;
  if (missNames)
    info.appendChild(ltEl("div", "lt-dlv-miss", ltT("待交付端子里有文件还没有文件名（含后缀）：交付是一件一件文件，请先在节点上给它们定下文件名") + "（" + missNames + "）"));
  pending.forEach((it, i) => {
    const row = ltEl("div", "lt-dlv-t");
    /* 文件名待补：这一项要交一件文件，却没有带后缀的文件名（缺失，或只是一句描述）。
       显式标出来（不静默拿描述当文件名），用户才知道要先补名字再交。 */
    const miss = ltDlvNeedsName(it);
    row.appendChild(ltEl("span", "lt-dlv-tno", String(i + 1)));
    const nm = ltEl(
      "span",
      "lt-dlv-tname" + (it.required === false ? " opt" : "") + (miss ? " todo" : ""),
      ltStr(ltDlvName(it) || ltT("文件名待补"), 60),
    );
    nm.title =
      (miss ? ltT("文件名待补：交付以文件为单位，请先在节点上给这一项定一个带后缀的文件名（例：分镜表.md）") + "\n" : "") +
      (it.desc ? ltT("内容：") + String(it.desc) + "\n" : "") +
      (it.accept ? ltT("要求：") + String(it.accept) : "");
    row.appendChild(nm);
    row.appendChild(ltBtn("⬆ " + ltT("上传"), "lt-btn lt-btn-ico", () => ltDlvItemUpload(node, it), ltT("上传这个端子对应的文件（文件名要对得上）")));
    row.appendChild(
      ltBtn(ltT("删除"), "lt-btn lt-btn-ico", async () => {
        node.ltItems = ltArr(node.ltItems).filter((x) => x !== it);
        await ltDeliverSyncFromNode(node);
        toast(ltT("已从清单删掉：") + ltDlvLabel(it) + ltT("（磁盘文件不动）"), "ok");
        if (typeof renderCanvas === "function") renderCanvas();
      }),
    );
    info.appendChild(row);
  });
  if (!pending.length)
    info.appendChild(
      ltEl(
        "div",
        "lt-dlv-fh",
        items.length
          ? ltT("待交付端子都交齐了：在条带上点「确认交付完成」再往下跑（没交齐也能继续，只是会先弹确认窗要你说清原因）")
          : ltT("还没有文件项：点下面「＋ 添加文件」"),
      ),
    );
  /* ③ 已交区：保留痕迹 + 可撤回（撤回只把端子放回来，交付目录里的文件不删） */
  const done = items.filter((it) => it.done && (it.kind === "file" || it.kind === "media"));
  if (done.length) {
    info.appendChild(ltEl("div", "lt-dlv-sec", ltT("已交 · ") + done.length + ltT(" 件（撤回可把端子放回来，文件不删）")));
    for (const it of done) {
      const row = ltEl("div", "lt-dlv-t done");
      const nm = ltEl("span", "lt-dlv-tname", "☑ " + ltStr(ltDlvName(it) || it.title, 50));
      nm.title =
        (it.paths && it.paths.length ? it.paths.join("\n") : "") +
        (it.wired ? "\n" + ltT("曾有端子连入（本次交付由上传覆盖）") : "");
      row.appendChild(nm);
      row.appendChild(ltEl("span", "lt-dlv-via", String(it.deliveredVia || "")));
      row.appendChild(ltBtn(ltT("撤回"), "lt-btn lt-btn-ico", () => ltDlvItemRevoke(node, it), ltT("把该端子放回来重新交（交付目录里的文件不删）")));
      info.appendChild(row);
    }
  }
  /* ④ 动作：添加文件 / 与磁盘对账 / 到条带上处理这一环 */
  const row = ltEl("div", "lt-dlv-acts");
  row.appendChild(ltBtn("＋ " + ltT("添加文件"), "lt-btn", () => ltDlvAddFileDlg(node), ltT("在清单里加一个待交付文件项（它同时多出一个输入端子）")));
  /* 手工对账入口（修复的另一半）：完成状态只活在内存里，把小票丢了（重开应用 / 切画布 /
     在应用外改过交付目录）就会看起来「一件都没交」。这颗按钮把交付目录与条目声明路径
     重新扫一遍，文件在就算已交，并原地刷新条上的计数。 */
  row.appendChild(
    ltBtn(
      "⟳ " + ltT("与磁盘对账"),
      "lt-btn",
      async () => {
        const r = await ltDlvReconcile(node);
        toast(
          r.changed
            ? ltT("已按磁盘上的文件核对交付状态：更新 ") + r.changed + ltT(" 项）") + ltT("，已交 ") + r.done + "/" + r.need
            : ltT("已按磁盘上的文件核对交付状态：没有变化（") + r.done + "/" + r.need + ltT(" 已交）"),
          r.changed ? "ok" : "warn",
        );
      },
      ltT("按交付目录 / 条目声明路径重新核对哪些已经交过（重开应用或切画布后计数不对时点它）"),
    ),
  );
  row.appendChild(ltBtn(ltT("到条带上处理这个人工任务"), "lt-btn lt-btn-pri", () => ltDlvOpenRibbonCard()));
  info.appendChild(row);
  if (node.ltFiles && node.ltFiles.length) {
    for (const p of node.ltFiles.slice(0, 4)) info.appendChild(ltEl("div", "lt-dlv-i done", "📄 " + ltStr(String(p).split(/[\\/]/).pop(), 40)));
  }
  body.appendChild(info);
}
/* 在交付节点上直接上传：旧的「整体上传、按顺序填第一条没交的项」已由
 * ltDlvItemUpload（一个端子一个上传钮 · 文件名要对得上）取代，函数整体删除 ——
 * 留在这里只会成为第二个写入口，绕过端子重绑与文件名对齐。 */

/* ── 启动：挂载条带 + 恢复未结束的 run ───────────────────────── */
async function ltBoot() {
  ltMount();
  const wf0 = typeof S !== "undefined" ? S.wf : null;
  /* 启动就套上**当前这张画布**自己记得的分割线（需求 1）：没记过的画布回退全局开合。 */
  ltApplyOpen(wf0 ? ltOpenFor(wf0) : !!ltCfg().open, wf0);
  const wf = typeof S !== "undefined" ? S.wf : null;
  if (wf) {
    const runs = await ltRestore(wf);
    if (runs.length) toast(ltT("有 ") + runs.length + ltT(" 个长周期任务停在检查点：在条带上点「继续」才会重跑"), "warn");
  }
  ltRenderStrip();
}
window.LT = Object.assign(window.LT || {}, {
  inheritGraph: ltInheritGraph,
  inheritDefaults: ltInheritAgentDefaults,
  ui: {
    mount: ltMount,
    boot: ltBoot,
    render: ltRenderStrip,
    open: ltApplyOpen,
    deliverBody: buildDeliverBody,
    humanResolve: ltHumanResolve,
    enable: ltEnable,
    stop: ltStop,
    resume: ltResume,
    restore: ltRestore,
    memDlg: ltMemoryDlg,
  },
});
ltTouchGraph = function () {
  ltRenderStripSoon();
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => ltBoot());
else setTimeout(() => ltBoot(), 0);

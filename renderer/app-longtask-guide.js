"use strict";
/* ══════════════════════════════════════════════════════════════════════
 * 长周期任务 · 新建对话框里的「Agent 引导建图」（会话 + 契约 + 回执落地）
 * ----------------------------------------------------------------------
 * 对话框本体在 renderer/app-longtask-create.js（window.openLtCreateDlg）：
 * 近全屏持久化浮层，主区 #ltcMain 就是本文件的落点（本文件 wrap 该入口挂进去，
 * 不抢别人的窗壳 / 尺寸 / 关闭路径；手动模板那条出口原样保留）。
 *
 * 挂进去的东西 = 一条**专用会话** + 它的契约 + 回执落地：
 *   · 会话经 app-assist.js 的 agentContractSession 装配：标题锁死
 *     （titleLocked=true / titleAuto=false）、canvasWfId 绑本对话框所属画布、
 *     允许读画布（noCanvasRead=false / canvasFree=false）；
 *   · 契约（_devContract，每轮随系统提示注入）写明：先 skill 加载内置技能
 *     mtnode-grill-me 并严格遵守，每轮用 ask_user_question 一次问满整个「前沿」，
 *     共识后用 mtnode_app 的 create_longtask 落库；禁止把问题编成正文列表、
 *     禁止手改 wf.longtask、禁止用画布写工具去画状态机图。
 *   · 对话区复用 dshMsgBlock 渲染该会话消息流（思考 / 工具 chips 同会话视图口径），
 *     并挂窗口级重绘钩子（wrap renderAgentSession）+ 运行期轮询兜底，窗内实时；
 *     **会话消息的输入 / 发送整行在对话区下方**（左栏最后一格，绝不溜到右边去），
 *     上沿一条拖高的分隔条（往下拖 = 框变高）。
 *   · 拿到 create_longtask 回执（或回复里那份图 JSON）→ 图**创建那一刻**就在条带上显示
 *     （引擎的 ltTaskReveal 收尾：「创建即显示」，不要求先绑定），右栏给图摘要与
 *     「▶ 启用并绑定」（点它才开始跑）；「中断本轮 / 稍后」两个出口常驻。
 *   · 本入口的产物只有「长周期任务状态机图」这一种：这条会话置 noPlanFlow，
 *     宿主不再给它注入「任务流程 / 交计划块」指令，它回复里的计划块也不弹计划窗
 *     （否则用户看到的就是「建出来的不是状态机图，而是一份普通会话计划 + 任务清单」）；
 *     每轮收尾由 ltgSettle 兜底：有图就落库，没图就自动纠偏一次（见 ltgFixDirective）。
 *
 * 真源：状态机在 app-longtask.js（window.LT），会话机制在 app-assist.js，
 * 对话框骨架在 app-longtask-create.js。
 * ══════════════════════════════════════════════════════════════════════ */

/* 契约抬头：既是契约正文的第一行，也是「这条会话是不是引导会话」的认领标记
   （重启后 _devContract 随会话落盘，靠它把同一条会话接回来接着聊）。 */
const LTG_MARK = "【长周期任务建图 · 会话契约】";
const LTG_CONV_MAX = 80; /* 窗内只画最近 80 条：更早的翻会话视图 */
const LTG_POLL_MS = 1200;
/* 窗内没发出去的那段正文（「内容」的另一半是 app-longtask-create.js 的 Agent 选型）：
   关窗 / 最小化 / 重启都得原样回来 —— 创建窗是持久化浮层，不能让用户白写一遍。 */
const LTG_DRAFT_KEY = "ltCreateDraft";
/* 契约里写明「本窗不接回旧会话」，免得模型自己在回复里说「接着上次那条聊」。
   与 ltgMount 的行为配套：开窗一律 sid:""，每条引导会话都是全新的。 */
const LTG_FRESH_NOTE =
  "本窗每次打开都是一条全新会话（不继承上一条引导会话的上下文）：从零开始问，不要假设自己记得上一次的任务。";
function ltgDraftLoad() {
  try {
    return String(localStorage.getItem(LTG_DRAFT_KEY) || "");
  } catch (_) {
    return "";
  }
}
function ltgDraftSave(v) {
  try {
    localStorage.setItem(LTG_DRAFT_KEY, String(v == null ? "" : v));
  } catch (_) {}
}

/* 挂载态：{ wf, host, conv, tail, right, sum, status, ta, sid, sig, found, draft } */
let LTG = null;
let LTG_POLL = 0;

function ltgT(s) {
  if (typeof ltT === "function") return ltT(s);
  return typeof I18n !== "undefined" && I18n.t ? I18n.t(String(s)) : String(s);
}
function ltgEl(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = String(txt);
  return e;
}
function ltgBtn(text, cls, fn, title) {
  if (typeof ltBtn === "function") return ltBtn(text, cls, fn, title);
  const b = ltgEl("button", "lt-btn " + (cls || ""), text);
  b.type = "button";
  if (title) b.title = title;
  b.onclick = fn;
  return b;
}
function ltgClip(v, n) {
  const s = String(v == null ? "" : v);
  return n && s.length > n ? s.slice(0, n) + "…" : s;
}

/* ── 引导输入框的高度（本需求：发送框在场、能往下拉高）────────────────────
   发送框整行放在**底部**（对话区下面），是左栏的最后一格；对话越长，越是它跟
   消息流分地方。口径：拖的分隔条（.ltg-split）往下拖 = 输入框变高，上下限都夹死。
   上限除固定值外还按窗口高的一半现算：小窗口里把输入框拉成半屏是用户自己的选择，
   但绝不允许它把消息流整格吃掉（空间还不够时由 flex 让消息流先缩，见 .ltg-conv
   的 min-height:0，发送框自己绝不被顶出窗口）。 */
const LTG_TA_MIN = 72;
const LTG_TA_MAX = 520;
let LTG_INPUT_H = 108;
/* 高度夹取：夹在 [LTG_TA_MIN, min(LTG_TA_MAX, 半屏)]，再兜「量不出来 / 非法值」
   （NaN、字符串）回落到当下这份高度 —— 任何输入都不会把框压没，也不会写出 NaN px。 */
function ltgInputClamp(h) {
  const n = Math.round(Number(h));
  if (!isFinite(n)) return LTG_INPUT_H;
  let max = LTG_TA_MAX;
  if (typeof window !== "undefined" && window && Number(window.innerHeight) > 0)
    max = Math.max(LTG_TA_MIN, Math.min(max, Math.round(Number(window.innerHeight) / 2)));
  return Math.max(LTG_TA_MIN, Math.min(max, n));
}
/* 宽度必须由这里显式写死：宽度归 inline 表达，textarea 退回浏览器默认宽时右边留一大块空白。
   高度同样只由 inline 表达（原因见 ltgInputClamp 上面那段）。
   **flex 也必须是可收缩的**：发送行是「框 + 发送按钮」的 flex 行，若写成 flex:none，
   textarea 会以「默认内在宽（约 20 列）」为 flex 基准而压不下去 —— 框独占整行、
   发送按钮被挤出左栏压在右栏上（用户报障：会话消息发送跑到右边、出界）。
   flex:1 1 auto = 以这里写的 width 为基准、按 flex 规则收缩，框铺满除按钮外的全部宽度。 */
function ltgInputApply(ta) {
  if (!ta || !ta.style) return;
  ta.style.flex = "1 1 auto";
  ta.style.width = "100%";
  ta.style.height = LTG_INPUT_H + "px";
}
/* 分隔条拖拽：挂 pointercapture，指针划出窗格也照跟；松手落在同一只窗的指针上即可。
   方向：分隔条是输入框的**上沿**（发送框在底部，分隔条压在它顶上）—— 往下拖 =
   输入框变高，所以高度增量是「按下点到当下点的位移取反」（拖手自己会跟着输入框走，
   位移幅度略有出入，但方向与手感对；这是「发送框在底部」这套排布下的正确符号）。
   双击 = 回到默认高度（与「会话左栏宽度拖手」「长任务细线」同一口径）。 */
function ltgSplitBind(split, ta) {
  if (!split || !ta || split._ltgSplitBound) return;
  split._ltgSplitBound = true;
  let drag = null;
  split.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    drag = { y: ev.clientY, h: ta.offsetHeight || LTG_INPUT_H };
    split.classList.add("dragging");
    try {
      split.setPointerCapture(ev.pointerId);
    } catch (_) {}
    document.body.classList.add("ltg-split-drag");
  });
  split.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    ev.preventDefault();
    LTG_INPUT_H = ltgInputClamp(drag.h - (ev.clientY - drag.y));
    ltgInputApply(ta);
  });
  const end = (ev) => {
    if (!drag) return;
    drag = null;
    split.classList.remove("dragging");
    try {
      if (ev) split.releasePointerCapture(ev.pointerId);
    } catch (_) {}
    document.body.classList.remove("ltg-split-drag");
  };
  split.addEventListener("pointerup", end);
  split.addEventListener("pointercancel", end);
  split.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    LTG_INPUT_H = 108;
    ltgInputApply(ta);
  });
}
function ltgVisibleWf() {
  if (typeof currentVisibleWf === "function") {
    const w = currentVisibleWf();
    if (w) return w;
  }
  return typeof S !== "undefined" ? S.wf : null;
}
function ltgWf() {
  if (LTG && LTG.wf) return LTG.wf;
  return ltgVisibleWf();
}
/* 创建窗那套 Agent 选型（app-longtask-create.js 落盘 / 回显）：起会话与建图都读它 */
function ltgCreateCfg() {
  try {
    if (typeof window.ltCreateAgentCfg === "function") return window.ltCreateAgentCfg() || {};
  } catch (_) {}
  return {};
}

/* ── 契约正文 ─────────────────────────────────────────────────────────
   与 app.js 的开发任务书同一写法：契约是给模型看的固定口径，每轮注入系统提示。 */
function ltgContractText() {
  return (
    LTG_MARK +
    "\n本会话的唯一目标：把用户的模糊想法问清楚，产出一张**可直接启用**的「长周期任务图」（状态机 DAG），并用 mtnode_app 的 create_longtask 落库到当前画布。" +
    "\n" +
    LTG_FRESH_NOTE +
    "\n\n第一步（硬要求）：用 skill 工具加载内置技能 mtnode-grill-me，并严格照它的纪律执行。" +
    "\n每一轮提问都必须调用 ask_user_question 工具（MTNode 会弹出「🐋 模型等待你的回应」询问窗，用户在窗内点选项 / 填空作答）：" +
    "\n· 一轮 = 一次调用，把该轮整个「前沿」的全部问题放进 questions[]（一次问满，3–7 题为宜），禁止一题一题地弹；" +
    "\n· 候选里把推荐项放第一位、label 末尾标「（推荐）」，理由写进 description（一句话）；" +
    "\n· 禁止把问题编号列在回复正文里、让用户在输入框作答（那是错误做法，用户已明确反馈过）。" +
    "\n需要环境事实（画布现状 / 代码 / 文件）自己用只读工具去查（本会话允许读当前画布：mtnode_canvas_get / mtnode_app），绝不拿环境问题问用户。" +
    "\n\n达成共识之前（前沿为空 + 用户在询问窗里明确「确认无误」）：不改画布、不建图、不写文件、不出实施计划、不开工。" +
    "\n共识之后：按 mtnode-grill-me 的「产出契约」写出图定义 JSON（kind:\"mtnode-longtask-graph\"），" +
    "\n然后调用 mtnode_app（action:\"create_longtask\"，带 name 与 graph）把这张图落库到当前画布的长周期任务；" +
    "\n禁止手改画布 JSON 里的 wf.longtask，也禁止用 mtnode_canvas_edit 去画这张状态机图（条带上的图只由 create_longtask 落库）。" +
    "\n落库成功后：用中文给一份「节点 → 干什么 → 吃哪些键 / 产出哪些键」+ 连线清单的摘要，不要再问新的问题、不要再改图。" +
    "\n若 create_longtask 不可用（工具不存在 / 报错）：把完整图定义 JSON 原样放进回复正文的 ```json 围栏里，并明确说明「应用内落库入口不可用」，绝不假装已落库。" +
    "\n\n本入口的产物只有长周期任务图这一种（别把它当普通会话任务做）：" +
    "\n· 【禁止】输出 <!--MTNODE-PLAN--> … <!--/MTNODE-PLAN--> 计划块、禁止用 todo_write 登记任务清单 —— 那是普通会话的流程，本会话的宿主也不认（不弹计划窗、不执行）；" +
    "\n· 【禁止】把「让用户自己照着在条带上搭」当成交付；图只有两条出口：create_longtask 落库，或回复里那份 ```json 图定义（宿主会自动落库，不需要用户动手）；" +
    "\n· 若共识还没达成，用 ask_user_question 继续问，不要拿一份计划 / 任务清单代替提问，也不要提前交图。" +
    "\n\n回答简洁（交流语言见文末「语言口味」）；工具回执里没有的结果不要声称已完成。"
  );
}

/* ── 会话认领 / 取用 ─────────────────────────────────────────────── */
function ltgSession() {
  if (LTG && LTG.sid && typeof agentSessionById === "function") {
    const st = agentSessionById(LTG.sid);
    if (st) return st;
  }
  return null;
}
/* 找一条「长任务建图」契约会话（契约正文认领 + 同一张画布 + 未归档），取最后一条。
   本次需求之后本窗**不再调用它**（开窗一律全新会话）；留着是因为它同时是
   「这条会话算不算长任务世界的会话」的判据来源，接回以外的用途仍按它认。 */
function ltgFindSession(wf) {
  const id = wf && wf.id ? String(wf.id) : "";
  const list = typeof agentSessions === "function" ? agentSessions() : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s || s.archived) continue;
    if (String(s._devContract || s.devContract || "").indexOf(LTG_MARK) < 0) continue;
    if (id && s.canvasWfId && String(s.canvasWfId) !== id) continue;
    /* 认领到的这条就是「长任务世界」的会话：补上豁免位（本次改动之前建的会话没有它，
       不补的话接回来继续聊的那几轮又会被塞「交计划块」指令，交出来的就是普通会话计划）。 */
    s.noPlanFlow = true;
    return s;
  }
  return null;
}
/* 创建窗里改选型：引导会话已经开着就就地改（会话与后续建图都按它走）。
   空值 = 跟随默认：模型直接清空（回落该路由默认），服务商 / 预设 / 思考强度回到默认档。 */
function ltgApplyCfg(cfg) {
  const st = ltgSession();
  if (!st) return;
  const c = cfg || {};
  if (c.provider != null) st.provider = String(c.provider || st.provider || "deepseek-official");
  if (c.model != null) st.model = String(c.model || "");
  if (c.preset != null)
    st.preset = String(
      c.preset || (typeof AGENT_PRESET_DEFAULT !== "undefined" ? AGENT_PRESET_DEFAULT : st.preset || ""),
    );
  if (c.effort != null) st.effort = String(c.effort || "high");
  try {
    if (typeof persistAgentSession === "function") Promise.resolve(persistAgentSession()).catch(() => {});
  } catch (_) {}
}
window.ltGuideApplyCfg = ltgApplyCfg;

/* ── 挂载：wrap window.openLtCreateDlg，把引导区塞进 #ltcMain ───────
   对话框骨架（窗壳 / 尺寸 / 手动新建 / Esc）属于 app-longtask-create.js，
   这里只接管 #ltcMain 那块占位；wrap 手法与条带挂 renderCanvas 同款。 */
function ltgHookCreateDlg() {
  const orig = window.openLtCreateDlg;
  if (typeof orig !== "function" || orig.__ltGuideHooked) return;
  const wrapped = function (wf) {
    const r = orig.apply(this, arguments);
    try {
      ltgMount(wf || ltgVisibleWf());
    } catch (_) {}
    return r;
  };
  wrapped.__ltGuideHooked = 1;
  window.openLtCreateDlg = wrapped;
}
function ltgMount(wf) {
  const host = document.getElementById("ltcMain");
  if (!host) return;
  /* 幂等：同一只窗重复挂载只认第一次（宿主 #ltcMain 每次开窗都是新 DOM） */
  const live = host.querySelector(":scope > .ltg");
  if (live && LTG && LTG.host === host && host.contains(live)) return;
  host.innerHTML = "";
  host.classList.add("ltg-host");

  const box = ltgEl("div", "ltg");
  /* 左：对话区（消息流）+ 拖高分隔条 + **底部整行**输入 / 发送。
     本需求：会话消息的发送放在下方，不再占左栏第一格 —— 也不许溜到右边去（发送行
     是左栏内的整行：输入框 flex 收缩铺满，按钮贴着框的右下，绝不出栏、不压右栏）。
     顺序 = DOM 顺序：conv → split（压在发送框上沿，往下拖 = 框变高）→ row（最后一格）。 */
  const left = ltgEl("div", "ltg-left");
  const conv = ltgEl("div", "ltg-conv");
  left.appendChild(conv);
  /* 发送行上沿的分隔条：往下拖 = 输入框变高（上限 / 下限见 ltgInputClamp）。 */
  const split = ltgEl("div", "ltg-split");
  split.id = "ltgSplit";
  split.title = ltgT("按住往下拖：把输入框拉高（双击回到默认高度）");
  left.appendChild(split);
  const row = ltgEl("div", "ltg-row");
  const ta = document.createElement("textarea");
  ta.className = "ltg-ta";
  ta.placeholder = ltgT(
    "先一两句说清你想让长周期任务干什么（Ctrl+Enter 发送）；开始后这里可补充说明 / 直接作答，但关键作答请在「🐋 模型等待你的回应」卡片里点选。",
  );
  ta.addEventListener("input", () => {
    if (LTG) LTG.draft = ta.value;
    ltgDraftSave(ta.value);
  });
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      ltgSend();
    }
  });
  row.appendChild(ta);
  row.appendChild(ltgBtn(ltgT("发送"), "lt-btn-pri", () => ltgSend()));
  left.appendChild(row);
  box.appendChild(left);
  /* 右：状态 / 图摘要 / 出口 */
  const right = ltgEl("div", "ltg-right");
  const status = ltgEl("div", "ltg-status");
  right.appendChild(status);
  const sum = ltgEl("div", "ltg-sum");
  right.appendChild(sum);
  const acts = ltgEl("div", "ltg-acts");
  acts.appendChild(
    ltgBtn(ltgT("在会话视图里打开"), "lt-btn", () => ltgGotoSession(), {
      title: ltgT("切到智能会话视图看这条引导会话的完整历史"),
    }),
  );
  acts.appendChild(
    ltgBtn("■ " + ltgT("中断本轮"), "lt-btn lt-btn-del", () => ltgAbort(), {
      title: ltgT("停掉正在跑的这一轮（会话留着，随时可以接着说）"),
    }),
  );
  acts.appendChild(
    ltgBtn(ltgT("稍后"), "lt-btn", () => ltgLater(), {
      title: ltgT("先关窗：这条引导会话留在左侧栏只作历史；下次打开本窗是一条全新会话"),
    }),
  );
  right.appendChild(acts);
  right.appendChild(
    ltgEl(
      "div",
      "ltg-note",
      ltgT(
        "「稍后」只是关窗，会话不会丢：它就在左侧栏里，随时能自己点开看。想从空白模板起步，用右上角「＋ 手动新建」。",
      ),
    ),
  );
  right.appendChild(
    ltgEl(
      "div",
      "ltg-note",
      ltgT(
        "每次打开本窗都是全新会话（不继承上次的上下文）：上一次那条引导会话留在左侧栏只作历史；你写的正文与上面的 Agent 选型会原样回来。",
      ),
    ),
  );
  box.appendChild(right);
  host.appendChild(box);

  const draft = ltgDraftLoad();
  ta.value = draft;
  LTG = {
    wf: wf || ltgVisibleWf(),
    host,
    conv,
    status,
    sum,
    ta,
    /* 本次需求：开窗一律是**全新会话**（空对话、不接回上一条引导会话）。
       上一次的引导会话留在左侧栏只作历史，本窗不再认领它 —— 见下面那段注释。 */
    sid: "",
    sig: "",
    found: null,
    /* 兜底落库的记名（同一份图只建一次，见 ltgAutoBuildOnce） */
    autoBuilt: "",
    draft,
  };
  /* 本窗不再接回旧引导会话（本次需求：从零开始新建任务 = 清空会话）。
   旧会话（含上一轮没问完的那条）留在左侧栏，随时可以自己点开看 / 接着聊；
   本窗要的是干净上下文：不继承它的问题、不继承它那份图摘要，也不因为它「没交图」纠偏。
   选型仍以上面「Agent 选型」那一栏为准（用户这次显式选的；没选过就跟随默认）。 */
  ltgInputApply(ta);
  ltgSplitBind(split, ta);
  ltgHookRepaint();
  ltgPaint(null);
  ltgStartPoll();
}

/* ── 窗内实时：窗口级重绘钩子（wrap renderAgentSession）+ 轮询兜底 ──
   与条带 wrap renderCanvas 同一手法：会话流式重绘之后顺手把本窗刷一遍，
   只在指纹变了才真重画（流式事件很密，绝不能每个事件都重建 DOM）。 */
function ltgHookRepaint() {
  const rc = window.renderAgentSession;
  if (typeof rc !== "function" || rc.__ltGuideHooked) return;
  const wrapped = function () {
    const r = rc.apply(this, arguments);
    try {
      ltgOnAgentRepaint();
    } catch (_) {}
    return r;
  };
  wrapped.__ltGuideHooked = 1;
  window.renderAgentSession = wrapped;
}
/* 本窗是不是真的还活着：挂载点仍在文档里就算活着（最小化到 #ovPark 也算 ——
   窗没关，只是换了个停放处；重绘照做，恢复出来就是最新的）。 */
function ltgDialogLive() {
  return !!(LTG && LTG.host && LTG.host.isConnected);
}
function ltgOnAgentRepaint() {
  if (!ltgDialogLive() || !LTG.sid) return;
  const st = typeof agentSessionById === "function" ? agentSessionById(LTG.sid) : null;
  if (!st) return;
  if (ltgSig(st) === LTG.sig) return;
  ltgPaint(st);
}
function ltgStartPoll() {
  ltgStopPoll();
  LTG_POLL = setInterval(() => {
    try {
      /* 挂载点已从文档里消失 = 窗关了 / 被别的窗换掉 → 收工（下次开窗会重挂） */
      if (!LTG || !LTG.host || !LTG.host.isConnected) {
        ltgStopPoll();
        return;
      }
      ltgOnAgentRepaint();
    } catch (_) {}
  }, LTG_POLL_MS);
}
function ltgStopPoll() {
  if (LTG_POLL) {
    clearInterval(LTG_POLL);
    LTG_POLL = 0;
  }
}
/* 重绘指纹：消息数 / 运行态 / 流式正文长度 / 活工具数 / 末条正文长度 */
function ltgSig(st) {
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return [
    msgs.length,
    st.running ? 1 : 0,
    String(st._pending || "").length,
    Array.isArray(st._liveTools) ? st._liveTools.length : 0,
    last ? String(last.content || "").length : 0,
  ].join(":");
}

/* ── 重绘 ───────────────────────────────────────────────────────── */
function ltgPaint(stIn) {
  if (!LTG) return;
  const st = stIn || ltgSession();
  const conv = LTG.conv;
  if (!conv) return;
  conv.innerHTML = "";
  if (!st) {
    conv.appendChild(
      ltgEl(
        "div",
        "ltg-intro",
        ltgT(
          "把想法写进下面的输入框（越具体越好），点「发送」：Agent 会先用内置技能「拷问我」，每轮在「🐋 模型等待你的回应」卡片里一次问满，你在卡片里作答；共识后它把长周期任务图落库，右栏会给图摘要与「启用并绑定」。",
        ),
      ),
    );
    LTG.sig = "";
    ltgPaintStatus(null);
    ltgPaintSum();
    return;
  }
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  const from = Math.max(0, msgs.length - LTG_CONV_MAX);
  if (from > 0) conv.appendChild(ltgEl("div", "ltg-more", ltgT("（更早的内容在会话视图里）")));
  for (let i = from; i < msgs.length; i++) {
    try {
      conv.appendChild(dshMsgBlock(msgs[i], st.id, i, {}));
    } catch (_) {}
  }
  if (st.running) conv.appendChild(ltgLiveRow(st));
  try {
    if (typeof scrollElToBottomIfStuck === "function") scrollElToBottomIfStuck(conv);
    else conv.scrollTop = conv.scrollHeight;
  } catch (_) {}
  /* 回执解读：create_longtask 成功回执 → 右栏图摘要 + 「启用并绑定」 */
  const hit = ltgAdopt(st);
  const prev = LTG.found;
  if (hit) LTG.found = hit;
  /* 回执 = 图已落库到当前画布：立刻刷新并展开条带，让用户直接看见这张图
     （只在「刚拿到一条新回执」那一次做，不跟着每次重绘反复展开）。 */
  if (
    hit &&
    hit.source === "receipt" &&
    (!prev || prev.source !== "receipt" || String(prev.uid || "") !== String(hit.uid || ""))
  ) {
    try {
      if (window.LT && window.LT.ui) {
        window.LT.ui.render();
        window.LT.ui.open(true);
      }
    } catch (_) {}
  }
  LTG.sig = ltgSig(st);
  ltgPaintStatus(st);
  ltgPaintSum();
  /* 图没落地的轮次由这里补一道闸（窗开着时也走一遍；正在跑的轮次内部直接返回） */
  ltgSettle(st);
}
function ltgLiveRow(st) {
  const row = ltgEl("div", "dsh-msg dsh-ai ltg-live");
  const head = ltgEl("div", "dsh-msg-head");
  head.appendChild(ltgEl("span", "dsh-role", "AI"));
  row.appendChild(head);
  const tools = Array.isArray(st._liveTools) ? st._liveTools : [];
  if (tools.length && typeof dshToolDetailsEl === "function") {
    const chips = ltgEl("div", "dsh-tools");
    for (const t of tools) {
      try {
        chips.appendChild(dshToolDetailsEl(t, true, st.id));
      } catch (_) {}
    }
    row.appendChild(chips);
  }
  row.appendChild(ltgEl("div", "dsh-msg-body dsh-stream", String(st._pending || "")));
  return row;
}
function ltgPaintStatus(st) {
  if (!LTG || !LTG.status) return;
  const box = LTG.status;
  box.innerHTML = "";
  let text = ltgT("还没有开始：写完目标点「发送」");
  let cls = "idle";
  if (st) {
    const pendingAsk = ltgAskPending(st);
    if (st.running && pendingAsk) {
      text = ltgT("Agent 正在等你作答：去「🐋 模型等待你的回应」卡片里点选 / 填空");
      cls = "ask";
    } else if (st.running) {
      text = ltgT("正在跑本轮…");
      cls = "run";
    } else if (LTG.found) {
      text = ltgT("本轮结束：图已在条带上显示（要开跑点 ▶ 启用并绑定）");
      cls = "ok";
    } else {
      text = ltgT("本轮结束：可以继续补充 / 追问，或点「发送」接着说");
      cls = "idle";
    }
  }
  box.className = "ltg-status ltg-status-" + cls;
  box.appendChild(ltgEl("span", "ltg-status-dot", "●"));
  box.appendChild(ltgEl("span", "ltg-status-txt", text));
}
/* 本轮是不是挂在「等用户作答」上：活工具里最后一个是询问窗工具且没回执 */
function ltgAskPending(st) {
  const tools = Array.isArray(st._liveTools) ? st._liveTools : [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (!t) continue;
    if (t.result == null && !t.error) {
      if (/ask_user_question/i.test(String(t.name || ""))) return true;
      return false;
    }
    /* 只看最后一个还没回执的调用 */
  }
  return false;
}

/* ── 回执解读：从工具回执 / 助手回复里认出那张图 ─────────────────── */
function ltgToolText(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  const arr = Array.isArray(res) ? res : [res];
  const out = [];
  for (const x of arr) {
    if (x == null) continue;
    if (typeof x === "string") out.push(x);
    else if (typeof x.text === "string") out.push(x.text);
    else if (typeof x.content === "string") out.push(x.content);
    else {
      try {
        out.push(JSON.stringify(x));
      } catch (_) {}
    }
  }
  return out.join("\n");
}
/* 图 JSON 解析：接受 {kind:"mtnode-longtask-graph",name,graph} / {name,graph} / 裸 {nodes,edges} */
function ltgParseGraph(text) {
  const s = String(text || "");
  if (!s || s.indexOf("nodes") < 0) return null;
  const tryOne = (raw) => {
    let j = null;
    try {
      j = JSON.parse(String(raw).trim());
    } catch (_) {
      return null;
    }
    if (!j || typeof j !== "object") return null;
    const g = j.graph && j.graph.nodes ? j.graph : j.nodes ? j : null;
    if (!g || !Array.isArray(g.nodes) || !g.nodes.length) return null;
    return { name: ltgClip(String(j.name || "").trim(), 80), graph: g };
  };
  const blocks = s.match(/```json\s*([\s\S]*?)```/gi) || [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const r = tryOne(blocks[i].replace(/^```json\s*/i, "").replace(/```$/i, ""));
    if (r) return r;
  }
  const m = s.match(/\{[\s\S]*\}\s*$/);
  if (m) {
    const r = tryOne(m[0]);
    if (r) return r;
  }
  return null;
}
/* 落库回执里的任务 uid（拿不到就让「启用并绑定」用窗内这份图新建一个任务） */
function ltgParseUid(text) {
  const s = String(text || "");
  for (const k of ["taskUid", "task_id", "taskId", "uid"]) {
    const m = s.match(new RegExp('"' + k + '"\\s*:\\s*"([A-Za-z0-9_\\-]{4,})"', "i"));
    if (m) return m[1];
  }
  const m2 = s.match(/(?:task_?uid|task_id|uid)\s*["':：=\s]+([A-Za-z0-9_\-]{4,})/i);
  return m2 ? m2[1] : "";
}
function ltgScan(st) {
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  const calls = [];
  const collect = (tools) => {
    for (const t of tools || []) {
      if (!t) continue;
      const nm = String(t.name || "");
      const args = String(t.args || "");
      /* create_longtask 本体，或经 mtnode_app 的 action:"create_longtask" */
      const isCreate =
        /create_longtask/i.test(nm) || (/mtnode_app/i.test(nm) && /create_longtask/i.test(args));
      if (!isCreate) continue;
      calls.push({
        at: Number(t.at) || 0,
        ok: !t.error,
        text: t.error ? "" : ltgToolText(t.result),
        args,
      });
    }
  };
  for (const m of msgs) collect(m && m.tools);
  collect(st._liveTools);
  calls.sort((a, b) => b.at - a.at);
  const okCall = calls.find((c) => c.ok);
  if (okCall) {
    const hit = ltgParseGraph(okCall.text) || ltgParseGraph(okCall.args);
    if (hit)
      return {
        name: hit.name,
        graph: hit.graph,
        uid: ltgParseUid(okCall.text) || ltgParseUid(okCall.args),
        source: "receipt",
      };
  }
  /* 兜底一：回执里没解析出图（落库回执被截断 / 工具名变了），但任务其实已经落在本画布上 ——
     直接读画布的长任务列表认领最近一张。少这一条，图明明建成了，右栏却仍显示「还没有图」，
     用户以为没建成功（本轮 bug 的另一半）。 */
  const wfHit = ltgScanCanvasTask();
  if (wfHit && wfHit.graph) return wfHit;
  /* 兜底二：落库入口不可用 → 用助手最近一条回复里那份图 JSON */
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "assistant") continue;
    const hit = ltgParseGraph(String(m.content || ""));
    if (hit) return { name: hit.name, graph: hit.graph, uid: "", source: "reply" };
  }
  return null;
}
/* 读本对话框所属画布的长任务列表，认领「最近更新的一张」当图摘要来源。
   只在窗内需要回显时调用（每次重绘一次）：任务是随画布对象存的本机数据，不读盘。 */
function ltgScanCanvasTask() {
  const wf = ltgWf();
  const tasks = wf && wf.longtask && Array.isArray(wf.longtask.tasks) ? wf.longtask.tasks : [];
  if (!tasks.length) return null;
  let best = null;
  for (const t of tasks) {
    if (!t || !t.graph) continue;
    if (!best || Number(t.updatedAt || 0) >= Number(best.updatedAt || 0)) best = t;
  }
  if (!best) return null;
  return { name: String(best.name || ""), graph: best.graph, uid: String(best.uid || ""), source: "canvas" };
}

/* ── 右栏：图摘要 + 「启用并绑定」 ───────────────────────────────── */
function ltgGraphSummary(graph) {
  const g = graph || {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const n = (k) => nodes.filter((x) => x && x.kind === k).length;
  const human = nodes.filter((x) => x && x.kind === "human");
  const out = [];
  out.push(
    ltgT("节点 ") +
      nodes.length +
      "（" +
      [
        ltgT("Agent") + " " + n("agent"),
        ltgT("人工") + " " + n("human"),
        ltgT("汇聚") + " " + n("join"),
        ltgT("选路") + " " + n("fork"),
        ltgT("逐项并行") + " " + n("map"),
        ltgT("子图") + " " + n("sub"),
        ltgT("写文件") + " " + n("output"),
      ].join(" · ") +
      "）· " +
      ltgT("连线 ") +
      edges.length,
  );
  if (human.length)
    out.push(
      ltgT("人工环节：") +
        human
          .map(
            (h) =>
              ltgClip(String((h && h.title) || ""), 20) +
              "（" +
              ltgT(String((h.cfg && h.cfg.mode) || "approve") === "deliver" ? "交付" : "审批") +
              "）",
          )
          .join("・"),
    );
  return out;
}
function ltgPaintSum() {
  if (!LTG || !LTG.sum) return;
  const box = LTG.sum;
  box.innerHTML = "";
  const hit = LTG.found;
  box.appendChild(ltgEl("div", "ltg-sum-h", "🪄 " + ltgT("图摘要")));
  if (!hit || !hit.graph) {
    box.appendChild(
      ltgEl(
        "div",
        "ltg-sum-i",
        ltgT("还没有图：等 Agent 问清楚并落库后，这里会出现节点 / 连线摘要与「启用并绑定」。"),
      ),
    );
    return;
  }
  if (hit.name) box.appendChild(ltgEl("div", "ltg-sum-name", "「" + hit.name + "」"));
  for (const line of ltgGraphSummary(hit.graph))
    box.appendChild(ltgEl("div", "ltg-sum-i", line));
  box.appendChild(
    ltgEl(
      "div",
      "ltg-sum-src",
      hit.source === "receipt"
        ? hit.uid
          ? ltgT("来源：create_longtask 回执（已落库 · 任务 uid ") + hit.uid + "）"
          : ltgT("来源：create_longtask 回执（已落库）")
        : hit.source === "canvas"
          ? ltgT("来源：本画布的长任务列表（已落库；右栏这张就是条带上那张）")
          : ltgT("来源：助手回复里的图 JSON（尚未落库；点「启用并绑定」会按它新建一个任务）"),
    ),
  );
  const errs =
    window.LT && typeof window.LT.validate === "function"
      ? window.LT.validate(hit.graph).filter((x) => x.level === "err")
      : [];
  if (errs.length) box.appendChild(ltgEl("div", "ltg-sum-err", "⚠ " + ltgT("图校验有问题：") + errs[0].msg));
  const row = ltgEl("div", "ltg-sum-row");
  row.appendChild(
    ltgBtn("▶ " + ltgT("启用并绑定"), "lt-btn-pri", () => ltgEnable(), {
      title: ltgT("启用这张图并与本对话框所属画布绑定，从起点开始跑"),
    }),
  );
  row.appendChild(
    ltgBtn(ltgT("看条带"), "lt-btn", () => {
      try {
        if (window.LT && window.LT.ui) {
          window.LT.ui.open(true);
          window.LT.ui.render();
        }
      } catch (_) {}
    }),
  );
  box.appendChild(row);
  if (ltgSession() && ltgSession().running)
    box.appendChild(ltgEl("div", "ltg-sum-src", ltgT("（本轮还在跑，图可能还会被它修订）")));
}
/* 建图 / 启用共用的「Agent 选型继承上下文」：创建窗那一栏（用户这次明确选的）优先，
   否则用接回会话自己的选型；两处都空 = 全跟随默认（ltInheritGraph 内部再回落全局默认）。 */
function ltgInheritCtx() {
  const gs = ltgSession();
  const cCfg = ltgCreateCfg();
  if (cCfg.provider || cCfg.model || cCfg.preset || cCfg.effort)
    return { provider: cCfg.provider, model: cCfg.model, preset: cCfg.preset, effort: cCfg.effort };
  if (gs) return { provider: gs.provider, model: gs.model, preset: gs.preset, effort: gs.effort };
  return null;
}
/* 兜底建图：把回复正文里那份图按同一份归一路径落库到本画布（create_longtask 的等价体）。
   返回落库回执（含 uid / 归一后的 graph）；图不合法（校验 err）时把这枚 r 原样返回
   （r.ok === false + r.error），环境不具备（没有画布 / 长任务模块）才返回 null ——
   绝不假装落库成功。幂等：本画布上已有同名任务就直接认领它（图还会被 Agent 逐轮修订、
   页面也可能重载，少这一条就会在画布上叠出第二张同名长任务）。 */
function ltgAutoBuild(hit) {
  const wf = ltgWf();
  const LT = window.LT;
  if (!wf || !LT || typeof LT.createFromGraph !== "function") return null;
  const name = String(hit.name || "").trim();
  if (name && typeof LT.tasks === "function") {
    try {
      const dup = (LT.tasks(wf) || []).find((t) => t && String(t.name || "") === name);
      if (dup) return { ok: true, uid: dup.uid, name: dup.name, graph: dup.graph, ver: dup.ver, reused: true };
    } catch (_) {}
  }
  let graph = typeof LT.norm === "function" ? LT.norm(hit.graph) : hit.graph;
  if (typeof LT.inheritGraph === "function") {
    try {
      LT.inheritGraph(graph, ltgInheritCtx());
    } catch (_) {}
  }
  let r = null;
  try {
    r = LT.createFromGraph(name, graph, wf);
  } catch (_) {
    r = null;
  }
  return r || null;
}
/* 同一份图只兜底落库一次：按「任务名 + 节点数」记名（图还会被 Agent 逐轮修订，
   修订后是另一份定义，允许再落一次）。记名挂在**会话对象**上而不是窗内状态：
   窗关着 / 用户切去别的视图时（页面重载由 ltgAutoBuild 的同名认领再兜一层），
   这条会话的落库只做一次。没有会话对象时才回落到窗内那一份。 */
function ltgAutoBuildOnce(hit, st) {
  const key = String(hit.name || "") + "#" + (hit.graph && hit.graph.nodes ? hit.graph.nodes.length : 0);
  if (st) {
    if (st._ltgBuilt === key) return false;
    st._ltgBuilt = key;
    return true;
  }
  if (!LTG || LTG.autoBuilt === key) return false;
  LTG.autoBuilt = key;
  return true;
}
/* ── 认领一张图 + 兜底落库（窗开着 / 关着都走这一件）─────────────────
   从工具回执或回复正文里认出图；回复里那份（没能走 create_longtask）由宿主自己
   按同一份归一路径落库 —— 「用 Agent 生成状态机图」这条路的最后一步，不能只把图
   摊在右栏等用户点「启用并绑定」（那时用户已经以为建图失败了）。
   返回认领到的 hit（source:"receipt" 表示图已落库），没有图返回 null。 */
function ltgAdopt(st) {
  let hit = null;
  try {
    hit = ltgScan(st);
  } catch (_) {
    return null;
  }
  if (!hit || !hit.graph) return null;
  if (hit.source === "reply" && ltgAutoBuildOnce(hit, st)) {
    const built = ltgAutoBuild(hit);
    /* 落库成功 → 升级成「回执」来源（右栏「启用并绑定」直接认这条）；
       图不合法（校验 err）→ 留在 reply 来源并把 err 挂上，右栏的校验行会显示它。 */
    if (built && built.ok) hit = { name: built.name, graph: built.graph, uid: built.uid, source: "receipt" };
    else if (built && built.error) hit.err = String(built.error);
  }
  return hit;
}
/* ── 每轮收尾的「必须交图」闸（不依赖对话框开着）─────────────────────
   长任务创建入口的唯一合法产物是长周期任务状态机图。一轮跑完却两手空空——
   既没有图、也没有把 round 挂在「等用户作答」上（ask_user_question 是阻塞工具，
   等答案的轮次仍在 running，所以跑到这里的都不会是它）—— 判定为没交图，
   最多自动纠偏一次：回发一条指令，明令禁止普通会话计划 / 任务清单，要求按契约
   交出图（create_longtask 或回复里的 ```json 图定义）。上限按「用户轮」计，
   ltgSend 每次用户发话都清零，绝不来回拉扯。 */
const LTG_FIX_MAX = 1;
function ltgFixDirective() {
  return (
    "【图未生成 · 自动纠偏】本入口（长周期任务新建窗的 Agent 引导建图）的唯一产物是**长周期任务状态机图**，" +
    "而应用这一轮没有拿到图：你上一轮交出来的是一份普通会话计划 / 任务清单（或一段「请用户自己照着搭」的说明）。" +
    "\n本轮唯一要做的事：按系统提示里【长周期任务建图 · 会话契约】与技能 mtnode-grill-me 的「产出契约」把图交出来 ——" +
    "\n· 优选调用 mtnode_app（action:\"create_longtask\"，带 name 与 graph）落库到当前画布；" +
    "\n· 工具不可用（不存在 / 报错）时，把完整图定义 JSON（{\"kind\":\"mtnode-longtask-graph\",\"name\":\"…\",\"graph\":{\"nodes\":[…],\"edges\":[…]}}）原样放进回复正文的 ```json 围栏里 —— 宿主会自动把它落库，不需要用户在条带上手搭。" +
    "\n禁止：输出 <!--MTNODE-PLAN--> … <!--/MTNODE-PLAN--> 计划块、用 todo_write 登记任务清单、把「照着搭」当交付、再问新的问题。" +
    "若你判断这张图还不到交的时候（需求还没问清），就用 ask_user_question 把还缺的问题一次问满 —— 不要拿计划代替提问，也不要提前交图。"
  );
}
function ltgSettle(st) {
  if (!st || !st.id) return;
  const running = typeof sessionIsRunning === "function" ? sessionIsRunning(st) : !!st.running;
  if (running) return;
  const hit = ltgAdopt(st);
  if (hit && hit.graph) {
    if (LTG) LTG.found = hit;
    return;
  }
  /* 只在「本窗发起的这一轮真的跑过」时才纠偏：开窗时把一条历史会话接回来（一条新消息
     都没有）不算没交图，绝不因为打开窗口就替用户多发一轮。 */
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  if (msgs.length <= Number(st._ltgRoundFrom || 0)) return;
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  if (!last || last.role !== "assistant") return;
  const used = Number(st._ltgFixRounds) || 0;
  if (used >= LTG_FIX_MAX) return;
  st._ltgFixRounds = used + 1;
  try {
    toast(ltgT("本轮没有拿到长周期任务图：已让 Agent 按契约重出一份（不要普通会话计划）。"), "warn");
  } catch (_) {}
  try {
    const p = agentSessionSend(ltgFixDirective(), { sessionId: st.id });
    if (p && typeof p.then === "function")
      p
        .then(() => {
          /* 窗已关（「稍后」/ 最小化后又没还原）就不必重绘：会话与兜底落库照常走 */
          if (ltgDialogLive()) ltgPaint(ltgSession() || st);
        })
        .catch(() => {});
  } catch (_) {}
}
/* 「启用并绑定」：回执给了 uid 且任务已在画布上 → 直接启用那条；
   否则用窗内这份归一化后的图新建一个任务再启用（两条路最后都走 window.LT.ui.enable）。 */
async function ltgEnable() {
  const hit = LTG && LTG.found;
  if (!hit || !hit.graph) return;
  const wf = ltgWf();
  if (!wf) {
    toast(ltgT("当前没有打开的画布"), "err");
    return;
  }
  if (!window.LT || !window.LT.ui || typeof window.LT.ui.enable !== "function") {
    toast(ltgT("长周期任务模块还没就绪"), "err");
    return;
  }
  let task = null;
  const tasks = typeof window.LT.tasks === "function" ? window.LT.tasks(wf) || [] : [];
  if (hit.uid) task = tasks.find((t) => t && String(t.uid) === String(hit.uid)) || null;
  /* 同一份归一的继承入口 + 上下文 = 引导会话自身的选择（没有则回落全局默认
     智能路由 / 模型 / 预设 / 思考强度）；只填空字段，已显式写入的一律不动。 */
  const ich = (typeof window.LT !== "undefined" && window.LT && window.LT.inheritGraph) || null;
  const ichCtx = ltgInheritCtx();
  if (!task) {
    if (typeof window.LT.ensure === "function") window.LT.ensure(wf);
    /* 走同一份归一：Agent 写的空字段就地继承，交付节点同时预分配 uid —— 落库即完整。 */
    let graph = typeof window.LT.norm === "function" ? window.LT.norm(hit.graph) : hit.graph;
    if (typeof ich === "function") ich(graph, ichCtx);
    /* 建任务一律走引擎的 createFromGraph（归一 + 校验 + 落库 + 「创建即显示」收尾都在它里面）：
       少这一条，兜底支路就成了第二条建任务路径 —— 图建出来了，条带却不显示（本轮 bug）。 */
    const made =
      typeof window.LT.createFromGraph === "function" ? window.LT.createFromGraph(hit.name || "", graph, wf) : null;
    if (made && made.ok)
      task =
        (typeof window.LT.tasks === "function" ? window.LT.tasks(wf) || [] : []).find(
          (t) => t && String(t.uid) === String(made.uid),
        ) || null;
    if (!task) {
      toast(ltgT("启用失败：") + ((made && made.error) || ltgT("长周期任务模块还没就绪")), "err");
      return;
    }
  } else if (typeof ich === "function") {
    /* 回执那条已在落库（create_longtask 建好）：启用前也按同一份归一补齐空字段 */
    ich(task.graph, ichCtx);
    if (typeof ltPersistWf === "function") ltPersistWf(wf);
    else if (typeof scheduleSave === "function") scheduleSave(true);
  }
  const r = await window.LT.ui.enable(wf, task.uid, {});
  if (!r || !r.ok) toast(ltgT("启用失败：") + ((r && r.error) || ""), "err");
  else {
    toast(ltgT("长周期任务已启用并绑定本画布"), "ok");
    try {
      window.LT.ui.open(true);
    } catch (_) {}
  }
  /* 条带刷新：让用户直接看见刚落库 / 刚启用的这张图 */
  try {
    window.LT.ui.render();
  } catch (_) {}
  ltgPaint(ltgSession());
}

/* ── 发送 / 起轮 / 中断 / 关闭 ─────────────────────────────────── */
async function ltgSend() {
  if (!LTG) return;
  const txt = String(LTG.ta.value || "").trim();
  let st = ltgSession();
  if (!st) {
    if (!txt) {
      toast(ltgT("先用一两句说清你想让长周期任务干什么"), "warn");
      return;
    }
    /* 契约会话：标题锁死 + 绑本对话框所属画布 + 允许读画布 + 契约每轮注入。
       创建窗那套 Agent 选型一并落下 —— 会话自己用这套模型，随后建图时整张图的
       Agent 环节也按它继承（ltgEnable 的 ichCtx）。 */
    const cfg = ltgCreateCfg();
    st = agentContractSession({
      title: ltgT("长周期任务引导") + " · " + ltgClip(txt.replace(/\s+/g, " "), 16),
      contract: ltgContractText(),
      kick: txt,
      canvasWfId: ltgWf() && ltgWf().id ? String(ltgWf().id) : "",
      allowCanvas: true,
      provider: cfg.provider || "",
      model: cfg.model || "",
      effort: cfg.effort || "",
    });
    /* 预设：agentContractSession 目前只收 provider / model / effort，这里补上（缺省 = 全局默认） */
    if (cfg.preset) st.preset = String(cfg.preset);
    /* 本会话不走普通会话计划那条线：宿主既不给它注入「任务流程 / 交计划块」指令，
       它回复里的计划块也不弹计划窗（判据见 app-plan.js 的 planFlowExemptSession）。
       少这一位，引导会话就会交出一份普通会话计划 + Todo 清单，而状态机图始终没建。 */
    st.noPlanFlow = true;
    st._ltgFixRounds = 0;
    LTG.sid = st.id;
    LTG.ta.value = "";
    LTG.draft = "";
    ltgDraftSave("");
    LTG.found = null; /* 新一轮引导：上一轮的图摘要不带到这一轮 */
    LTG.autoBuilt = ""; /* 同上：兜底落库的记名也随新会话清零 */
    st._ltgRoundFrom = st.messages.length; /* 本轮从第几条消息起（ltgSettle 的判据） */
    ltgPaint(st);
    try {
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    await agentContractRound(st);
    /* 窗关着也照跑：这一轮跑完就地认领 / 兜底落库，没交图就自动纠偏一次 */
    ltgSettle(ltgSession() || st);
    ltgPaint(ltgSession() || st);
    return;
  }
  if (!txt) {
    toast(ltgT("先写一句要补充的说明再发送"), "warn");
    return;
  }
  /* 用户亲口发话 = 新的一轮：自动纠偏的额度跟着清零（一个用户轮最多纠偏一次） */
  st._ltgFixRounds = 0;
  st.noPlanFlow = true;
  st._ltgRoundFrom = (st.messages || []).length;
  LTG.ta.value = "";
  LTG.draft = "";
  ltgDraftSave("");
  /* 追问轮：契约照常随系统提示注入（agentSessionSend 每次都注入 _devContract），
     用户这句按普通用户消息进会话 —— 关键作答仍然在询问窗里。 */
  await agentSessionSend(txt, { sessionId: st.id });
  ltgSettle(st);
  ltgPaint(ltgSession() || st);
}
function ltgAbort() {
  const st = ltgSession();
  if (!st) return;
  const running = typeof sessionIsRunning === "function" ? sessionIsRunning(st) : !!st.running;
  if (!running) {
    toast(ltgT("这一轮已经结束了"), "ok");
    return;
  }
  try {
    if (typeof stopSessionRuns === "function") stopSessionRuns(st, true);
  } catch (_) {}
  toast(ltgT("已中断本轮：会话留着，随时可以接着说"), "warn");
  ltgPaint(st);
}
/* 「稍后」= 关窗不杀会话（会话是左侧栏里可再打开的一条普通会话）。 */
function ltgLater() {
  const st = ltgSession();
  try {
    closeOverlay();
  } catch (_) {}
  if (typeof persistAgentSession === "function")
    Promise.resolve(persistAgentSession()).catch(() => {});
  if (st) toast(ltgT("这条引导会话留在左侧栏只作历史；下次打开本窗是一条全新会话（不继承上下文）"), "ok");
}
function ltgGotoSession() {
  const st = ltgSession();
  if (!st) return;
  ltgLater();
  try {
    if (typeof setView === "function") setView("agent");
    S.agentActiveId = st.id;
    if (typeof renderAgentSession === "function") renderAgentSession();
    if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
  } catch (_) {}
}

ltgHookCreateDlg();
/* 脚本顺序上 app-longtask-create.js 已在前（window.openLtCreateDlg 应已就绪）；
   万一被别处延后定义 / 重载，再补两次机会，挂不上也不报错（下次开窗仍有 window.ltGuideMount 兜底）。 */
if (typeof window.openLtCreateDlg !== "function") {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", ltgHookCreateDlg);
  setTimeout(ltgHookCreateDlg, 0);
  setTimeout(ltgHookCreateDlg, 600);
}
window.ltGuideMount = ltgMount;
/* 可选出口：其它入口想直接开新建窗（本文件的引导区就在里面）时走它 */
window.LT = window.LT || {};
window.LT.ui = window.LT.ui || {};
window.LT.ui.guide = function () {
  try {
    if (typeof window.openLtCreateDlg === "function") window.openLtCreateDlg(ltgVisibleWf());
  } catch (_) {}
};

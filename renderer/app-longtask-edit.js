"use strict";
/* ══════════════════════════════════════════════════════════════════════
 * 长周期任务 · 任务链修改对话框（window.ltOpenEditDlg）
 * ----------------------------------------------------------------------
 * 条带头部那颗「✎ 修改任务链」（renderer/app-longtask-ui.js 的 ltOpenEditDlg）开这一只窗：
 *   · 与「新建长周期任务」（renderer/app-longtask-create.js）同款：持久化浮层（openOverlay
 *     persistent + 可最小化到状态栏）、近全屏、右下角可拖调大小、最小宽 ≥ 50% 视口，
 *     拖过的尺寸记在 localStorage（跨画布统一）；
 *   · 用户在顶部输入框写一句**修改要求**（「把审稿这一步拆成两轮」「卡住的环节补一条兜底
 *     分支」…），点「发送」起一轮；
 *   · **每次「发送」都重启：全新会话、不继承前面的上下文**（本次需求）—— 改任务链最怕旧
 *     上下文干扰新要求，故本窗既不接回上一次开窗的会话，也不在窗内续聊上一条：上一次那条
 *     留在左侧栏只作历史。开窗时顺带停掉遗留会话里可能还在跑的那一轮，免得白烧 token；
 *   · 左侧对话区复刻创建窗口径：dshMsgBlock 渲染这条会话的消息流（思考 / 工具 chips 同源），
 *     窗口级重绘钩子（wrap renderAgentSession）+ 运行期轮询兜底，窗内实时；
 *   · 右侧是「当前那张图」的现况（任务名 / 版本 / 运行态 / 节点清单）与出口
 *     （看条带 / 中断本轮 / 稍后），每轮结束刷新一次。
 *
 * 与创建流程的关系：创建 = 从零问清需求、产出一张新图并落库（mtnode_app 的 create_longtask）；
 * 修改 = 对着**已经存在**的那张图改（mtnode_app 的 update_longtask / get_longtask）。
 * 两者都走同一条契约会话装配（app-assist.js 的 agentContractSession + agentContractRound）：
 * 标题锁定、绑本对话框所属画布、允许读画布（noCanvasRead=false）→ 会话侧天然有
 * mtnode_canvas_get / mtnode_canvas_edit / mtnode_app 三件套，故「有全部权限」不需要额外开口子。
 * 契约与引导区（app-longtask-guide.js）同一写法：**契约是给模型看的固定口径，每轮注入系统提示**，
 * 只落一处；本文件不重复它的建图契约，也不与它共用状态。
 *
 * 每轮起轮前，宿主把「当前图 JSON + 运行态」直接写进这一轮的用户消息（首轮即关键输入）：
 * Agent 因此不必先猜现状；它仍可再用 get_longtask / mtnode_canvas_get 复核。
 * 收尾闸：本轮没拿到 update_longtask 成功回执就自动纠偏一次（对齐 ltgSettle 的口径），
 * 防止「聊了一轮却什么都没改」被当成成功。
 *
 * 真源：状态机与图数据在 app-longtask.js（window.LT）；会话机制在 app-assist.js；
 * 弹窗骨架与尺寸口径对齐 app-longtask-create.js。
 * ══════════════════════════════════════════════════════════════════════ */

const LTE_MARK = "【长周期任务修改 · 会话契约】";
const LTE_SIZE_KEY = "ltEditDlgSize";
const LTE_SESSION_KEY = "ltEditSession";
const LTE_MIN_H = 360;
const LTE_CONV_MAX = 80; /* 窗内只画最近 80 条：更早的翻会话视图（与引导区同口径） */
const LTE_POLL_MS = 1200;
const LTE_FIX_MAX = 1; /* 一个用户轮最多自动纠偏一次 */

/* 挂载态：{ wf, uid, host, conv, ta, right, status, sum, sid, sig, found, draft, base } */
let LTE = null;
let LTE_POLL = 0;
/* 上次改动记名（图 JSON 指纹）：同一份图不重复提示「已改到 vN」 */
let LTE_LAST_APPLIED = "";
/* 上一轮起轮的基线消息数（收尾闸判「本轮真的跑过」） */
const LTE_ROUND_FROM = new WeakMap();

function lteT(s) {
  if (typeof ltT === "function") return ltT(s);
  return typeof I18n !== "undefined" && I18n.t ? I18n.t(String(s)) : String(s);
}
function lteEl(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = String(txt);
  return e;
}
function lteBtn(text, cls, fn, title) {
  if (typeof ltBtn === "function") return ltBtn(text, cls, fn, title);
  const b = lteEl("button", "lt-btn " + (cls || ""), text);
  b.type = "button";
  if (title) b.title = title;
  b.onclick = fn;
  return b;
}
function lteClip(v, n) {
  const s = String(v == null ? "" : v);
  return n && s.length > n ? s.slice(0, n) + "…" : s;
}
function lteWf() {
  if (LTE && LTE.wf) return LTE.wf;
  return typeof S !== "undefined" ? S.wf : null;
}
/* 本窗正在改的那张任务（uid 失效时回落本画布的当前任务） */
function lteTask() {
  const wf = lteWf();
  const tasks = wf && wf.longtask && Array.isArray(wf.longtask.tasks) ? wf.longtask.tasks : [];
  const key = String((LTE && LTE.uid) || "");
  return tasks.find((t) => t && String(t.uid || "") === key) || tasks.find((t) => t && wf.longtask.active === t.uid) || null;
}
/* 现况快照（Agent 的 get_longtask 与右栏共用同一份口径：LT.graphOf） */
function lteSnap() {
  const wf = lteWf();
  if (!wf || !window.LT || typeof window.LT.graphOf !== "function") return null;
  try {
    return window.LT.graphOf(wf, String((LTE && LTE.uid) || ""));
  } catch (_) {
    return null;
  }
}
/* 尺寸：与创建窗 / 审阅窗同口径（最小宽 ≥ 50% 视口，拖过的尺寸记 localStorage） */
function lteClampSize(w, h) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minW = Math.round(vw * 0.5);
  const nw = Math.max(minW, Math.min(Math.round(Number(w) || 0), vw - 60));
  const nh = Math.max(LTE_MIN_H, Math.min(Math.round(Number(h) || 0), vh - 60));
  return { w: nw, h: nh };
}
function lteLoadSize() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  try {
    const j = JSON.parse(localStorage.getItem(LTE_SIZE_KEY) || "null");
    if (j && j.w && j.h) return lteClampSize(j.w, j.h);
  } catch (_) {}
  return lteClampSize(Math.min(1440, Math.round(vw * 0.94)), Math.round(vh * 0.86));
}
function lteSaveSize(sz) {
  try {
    localStorage.setItem(LTE_SIZE_KEY, JSON.stringify(sz));
  } catch (_) {}
}
/* 输入框里没发出去的那段要求：关窗 / 最小化 / 重启都得原样回来（持久化浮层的铁律）。
   key 里带上任务 uid：改了 A 任务的草稿不会串到 B 任务头上。 */
function lteDraftKey() {
  return "ltEditDraft:" + String((LTE && LTE.uid) || (lteTask() || {}).uid || "");
}
function lteDraftLoad() {
  try {
    return String(localStorage.getItem(lteDraftKey()) || "");
  } catch (_) {
    return "";
  }
}
function lteDraftSave(v) {
  try {
    localStorage.setItem(lteDraftKey(), String(v == null ? "" : v));
  } catch (_) {}
}
/* 每次打开「✎ 修改任务链」都是**全新的会话**：不接回上一次那条，前面的修改上下文一律不继承
   （改任务链这件事最怕旧上下文干扰新要求 —— 旧会话留在左侧栏，只作历史，不再被本窗认领）。 */
/* ① 清掉历史遗留的「接回记录」：免得旧版应用留下的 key 让下一次开窗又复活旧上下文。 */
function lteClearSessionRec() {
  try {
    localStorage.removeItem(LTE_SESSION_KEY);
  } catch (_) {}
}
/* ② 结束上一条修改会话里可能还在跑的那一轮（它不属于本次修改，留着只会白烧 token 与抢工具回执）。 */
function lteAbandonPrevSessions(wf, uid) {
  const wid = wf && wf.id ? String(wf.id) : "";
  const key = String(uid || "");
  const list = typeof agentSessions === "function" ? agentSessions() : [];
  for (const s of list) {
    if (!s || s.archived) continue;
    if (String(s._devContract || s.devContract || "").indexOf(LTE_MARK) < 0) continue;
    if (wid && s.canvasWfId && String(s.canvasWfId) !== wid) continue;
    if (key && String(s._ltEditUid || "") && String(s._ltEditUid) !== key) continue;
    const running = typeof sessionIsRunning === "function" ? sessionIsRunning(s) : !!s.running;
    if (running && typeof stopSessionRuns === "function") {
      try {
        stopSessionRuns(s, true);
      } catch (_) {}
    }
  }
}
function lteSession() {
  if (LTE && LTE.sid && typeof agentSessionById === "function") {
    const st = agentSessionById(LTE.sid);
    if (st) return st;
  }
  return null;
}

/* ─ 契约正文（每轮随系统提示注入；只此一处，别处不抄第二份）─────────── */
function lteContractText() {
  return (
    LTE_MARK +
    "\n本会话的唯一目标：按用户的要求**修改 / 修复一张已经存在的长周期任务图**（状态机 DAG），" +
    "并用 mtnode_app（action:\"update_longtask\"）把它**原地**写回这条任务。" +
    "\n\n每一步都按这个顺序做：" +
    "\n1) 先看清现状：mtnode_app（action:\"get_longtask\"）拿到本任务的图定义与运行态（哪个环节卡住 / 在等谁），" +
    "必要时用 mtnode_canvas_get 看画布上的交付节点与连线；**不许凭记忆猜图**。" +
    "\n2) 再改图：在拿到的那份图上做用户要求的修改（增删环节、改目标 / 输出键、改条件分支、拆解 / 合并子图、补兜底路径…），" +
    "保持图的完整与自洽（起点/终点、每个非起点节点都要有上游、agent 节点必须有 goal、map 必须有 overKey）。" +
    "\n3) 最后写回：调用 mtnode_app（action:\"update_longtask\"，带 uid 与**完整的新图** graph —— 不是增量补丁，是整张替换），" +
    "再给一段中文摘要：改了什么、影响哪些环节、有没有要用户重新启用才生效。" +
    "\n\n纪律（违反即白干）：" +
    "\n· 只改这一张任务：不要 create_longtask 新建任务，不要删任务，不要动别的画布；" +
    "\n· 禁止手改画布 JSON 里的 wf.longtask，也禁止用 mtnode_canvas_edit 去画这张状态机图（条带上的图只由 update_longtask 落库）；" +
    "\n· 若 update_longtask 报「校验未通过」，按回执里的 err 逐条修好再调一次，不要拿嘴解释；" +
    "\n· 若工具不可用（不存在 / 报错），把**完整的新图 JSON** 原样放进回复正文的 ```json 围栏里（{\"kind\":\"mtnode-longtask-graph\",\"name\":\"…\",\"graph\":{…}}），" +
    "宿主会自动写回，绝不假装已落库；" +
    "\n· 若用户的要求本身有歧义 / 缺关键信息：直接用 ask_user_question 一次问满（推荐项放第一位并标「（推荐）」），" +
    "不要拿一份普通会话计划代替提问，也不要先改了再问；" +
    "\n· 用户要求的信息不够时，回一句「需要你补一句：…」比乱改更值钱 —— 图是用户马上要按它跑的东西；" +
    "\n· 【禁止】输出 <!--MTNODE-PLAN--> 计划块、禁止用 todo_write 登记任务清单（本入口的产物只有这张图）。" +
    "\n\n改完之后：不要再问新问题、不要再改图；用户若继续提新要求，就当作下一轮照上面的顺序再走一遍。" +
    "\n回答简洁（交流语言见文末「语言口味」）；工具回执里没有的结果不要声称已完成。"
  );
}

/* ── 每轮的用户消息：把「当前图 + 运行态 + 用户要求」一次交清 ──────────
 * 为什么写进用户消息而不是只靠工具：Agent 一睁眼就要知道「改的是哪张图、现在长什么样」，
 * 让它自己去查会白烧一步；工具仍可用（get_longtask）复核，两条路不冲突。 */
function lteGraphText() {
  const snap = lteSnap();
  if (!snap) return "（读不到当前任务：可能已被删除）";
  let s = "";
  try {
    s = JSON.stringify({ uid: snap.uid, name: snap.name, ver: snap.ver, graph: snap.graph });
  } catch (_) {
    s = "";
  }
  return s.length > 20000 ? s.slice(0, 20000) + "…（过长已截断，完整定义请用 get_longtask 读）" : s;
}
function lteRunText() {
  const snap = lteSnap();
  if (!snap) return "（读不到运行态）";
  if (!snap.run) return "该任务当前没有在跑的 run（未启用，或上一轮已结束）。";
  const r = snap.run;
  const lines = [
    "run " + r.runId + " · 状态 " + (r.status || "") + " · 已走 " + r.steps + " 步 · 图版本 v" + r.graphVersion + " · 等人的环节 " + r.waits + " 个",
  ];
  for (const n of r.nodes || []) {
    lines.push("· " + n.path + " → " + (n.status || "") + (n.round ? "（第 " + n.round + " 轮）" : "") + (n.wait ? " ← 正等你处理" : ""));
  }
  return lines.join("\n");
}
function lteRoundInput(text) {
  return (
    "【任务链修改】\n用户的要求：\n" +
    String(text || "").trim() +
    "\n\n当前任务：" +
    ((lteSnap() || {}).name || "") +
    "（uid " +
    String((LTE && LTE.uid) || "") +
    "，图版本 v" +
    String((lteSnap() || {}).ver || "") +
    "）\n当前图定义 JSON（uid / name / ver / graph）：\n```json\n" +
    lteGraphText() +
    "\n```\n当前运行态：\n" +
    lteRunText() +
    "\n\n请按系统提示里的【长周期任务修改 · 会话契约】动手：先看清现状，再按上面的要求改图，" +
    "最后用 mtnode_app（action:\"update_longtask\"，uid=\"" +
    String((LTE && LTE.uid) || "") +
    "\"，graph=完整的新图）写回，并给一段中文摘要。"
  );
}

/* ── 弹窗 ───────────────────────────────────────────────────────── */
function ltOpenEditDlg(wf, uid) {
  const cap = wf || (typeof S !== "undefined" ? S.wf : null);
  if (!cap) {
    if (typeof toast === "function") toast(lteT("没有打开的画布"), "warn");
    return;
  }
  /* 目标任务：显式给的 uid 优先，否则本画布的当前任务；一个都没有就明确报错，不静默开窗 */
  const tasks = cap.longtask && Array.isArray(cap.longtask.tasks) ? cap.longtask.tasks : [];
  const task =
    tasks.find((t) => t && String(t.uid || "") === String(uid || "")) ||
    tasks.find((t) => t && cap.longtask.active === t.uid) ||
    null;
  if (!task) {
    if (typeof toast === "function") toast(lteT("这张画布没有可修改的长任务：先创建一张"), "warn");
    return;
  }
  /* 换目标前收干净：换任务 / 换画布时把上一只窗的轮询与挂载态停掉，
     否则一条会话的轮询会继续往已经不在文档里的 conv 里画（切场景时的静默泄漏）。
     同任务重复开窗（头部按钮再点一次）不算换目标，直接走下面重挂。 */
  if (LTE && String(LTE.uid || "") !== String(task.uid || "")) {
    lteStopPoll();
    LTE = null;
  }
  openOverlay(lteT("修改任务链"), { persistent: true, min: true });
  const box = (function () {
    const ov = document.getElementById("overlay");
    return ov ? ov.querySelector(":scope > .overlay-box") : null;
  })();
  const body = document.getElementById("ovBody");
  if (!box || !body) return;
  box.style.position = "relative";
  const sz = lteLoadSize();
  box.style.width = sz.w + "px";
  box.style.height = sz.h + "px";
  box.style.maxHeight = "calc(100vh - 60px)";

  const wrap = lteEl("div", "lte");
  /* ① 抬头：改的是哪张任务（只读回显，防「改错任务」） */
  const top = lteEl("div", "lte-top");
  top.appendChild(lteEl("div", "lte-task", "⛓ " + String(task.name || "")));
  const meta = lteEl("div", "lte-meta");
  top.appendChild(meta);
  wrap.appendChild(top);
  /* ② 输入区（最靠上，进窗就能写）：一句话说清要改什么 */
  const row = lteEl("div", "lte-row");
  const ta = document.createElement("textarea");
  ta.className = "lte-ta";
  ta.placeholder = lteT("写清要改什么（Ctrl+Enter 发送）：例如「把审稿拆成两轮：先初审再终审」「卡住的环节后面补一条兜底分支」「这个环节的目标太笼统，改成按分镜表逐条核对」");
  row.appendChild(ta);
  const send = lteBtn(lteT("发送"), "lt-btn-pri lte-send", () => lteSend(), {
    title: lteT("每次「发送」都开一条全新的修改会话（不继承前面的上下文，避免干扰）；上一次那条留在左侧栏只作历史"),
  });
  row.appendChild(send);
  wrap.appendChild(row);
  const hint = lteEl(
    "div",
    "lte-hint",
    lteT("Agent 会先读当前任务图与运行态，再按你的要求原地改 / 修复这张图（有全部权限：能改图、能读写文件、能查画布）；改完给一段摘要。每点一次「发送」都重启一条全新会话，不继承前面的上下文。"),
  );
  wrap.appendChild(hint);
  /* ③ 对话区（左）+ 现况与出口（右） */
  const main = lteEl("div", "lte-main");
  const conv = lteEl("div", "lte-conv");
  main.appendChild(conv);
  const right = lteEl("div", "lte-right");
  const status = lteEl("div", "lte-status");
  right.appendChild(status);
  const sum = lteEl("div", "lte-sum");
  right.appendChild(sum);
  const acts = lteEl("div", "lte-acts");
  acts.appendChild(
    lteBtn(lteT("看条带"), "lt-btn", () => {
      try {
        if (window.LT && window.LT.ui) {
          window.LT.ui.open(true);
          window.LT.ui.render();
        }
      } catch (_) {}
    }, lteT("收起本窗去看条带上的那张图（条带会随修改实时刷新）")),
  );
  acts.appendChild(lteBtn(lteT("在会话视图里打开"), "lt-btn", () => lteGotoSession(), { title: lteT("切到智能会话视图看这条会话的完整历史") }));
  acts.appendChild(lteBtn("■ " + lteT("中断本轮"), "lt-btn lt-btn-del", () => lteAbort(), { title: lteT("停掉正在跑的这一轮（会话留着，随时可以接着说）") }));
  acts.appendChild(lteBtn(lteT("稍后"), "lt-btn", () => lteLater(), { title: lteT("先关窗：这条会话留在左侧栏只作历史；下次打开本窗是一条全新会话") }));
  right.appendChild(acts);
  right.appendChild(
    lteEl("div", "lte-note", lteT("「稍后」只是关窗：写了一半的要求也会原样回来。每次「发送」都开一条全新的修改会话（不继承前面的上下文），上一次那条留在左侧栏只作历史，不会被本窗接回。")),
  );
  main.appendChild(right);
  wrap.appendChild(main);
  body.appendChild(wrap);

  /* 本窗的显式出口：窗内「稍后」+ 右下「关闭」（都走 lteLater：关窗前把这条修改会话落盘）。
     窗壳标题栏那颗通用 ✕ 也关得掉（本次需求：后续所有打开的 dialogue 都有 关闭 选项），
     但它不认识本窗的收口动作，所以这里补一颗语义正确的关闭按钮。 */
  const foot = document.getElementById("ovFoot");
  if (foot) {
    foot.appendChild(
      lteBtn(lteT("关闭"), "lt-btn", () => lteLater(), {
        title: lteT("关窗：写了一半的要求会原样回来；这条会话留在左侧栏只作历史"),
      }),
    );
  }

  /* 右下拖拽把手（同创建窗）：挂在 .overlay-body 内，随下一只窗一起收走 */
  const rz = lteEl("div", "lte-resize");
  rz.id = "lteResize";
  rz.title = lteT("拖拽调整大小");
  rz.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const base = { w: box.offsetWidth, h: box.offsetHeight };
    const move = (e) => {
      const n = lteClampSize(base.w + (e.clientX - sx), base.h + (e.clientY - sy));
      box.style.width = n.w + "px";
      box.style.height = n.h + "px";
      lteSaveSize(n);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  body.appendChild(rz);

  /* 每次开窗都是全新的会话（本次需求：改任务链时重启清空上下文，不继承前面的）。
     所以这里 **不认领** 上一次那条修改会话：清掉历史接回记录、停掉它可能还在跑的一轮，
     余下的交给 lteSend 起一条新的契约会话。旧会话仍留在左侧栏，只作历史可回看。 */
  lteClearSessionRec();
  lteAbandonPrevSessions(cap, task.uid);
  LTE = {
    wf: cap,
    uid: String(task.uid || ""),
    host: wrap,
    conv,
    ta,
    right,
    status,
    sum,
    meta,
    sid: "", /* 新会话由 lteSend 起（本窗不再认领旧会话） */
    sig: "",
    found: null,
    draft: "",
    /* 兜底写回的幂等位（同一份图只写一次）与它的失败文本（右栏要显示出来） */
    applied: "",
    replyErr: "",
  };
  ta.value = lteDraftLoad();
  LTE.draft = ta.value;
  ta.addEventListener("input", () => {
    if (LTE) LTE.draft = ta.value;
    lteDraftSave(ta.value);
  });
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      lteSend();
    }
  });
  lteHookRepaint();
  ltePaint(null);
  lteStartPoll();
}
window.ltOpenEditDlg = ltOpenEditDlg;

/* ── 窗内实时：窗口级重绘钩子 + 轮询兜底（与引导区同款手法）────────── */
function lteHookRepaint() {
  const rc = window.renderAgentSession;
  if (typeof rc !== "function" || rc.__ltEditHooked) return;
  const wrapped = function () {
    const r = rc.apply(this, arguments);
    try {
      lteOnRepaint();
    } catch (_) {}
    return r;
  };
  wrapped.__ltEditHooked = 1;
  window.renderAgentSession = wrapped;
}
function lteDialogLive() {
  return !!(LTE && LTE.host && LTE.host.isConnected);
}
function lteOnRepaint() {
  if (!lteDialogLive() || !LTE.sid) return;
  const st = typeof agentSessionById === "function" ? agentSessionById(LTE.sid) : null;
  if (!st) return;
  if (lteSig(st) === LTE.sig) return;
  ltePaint(st);
}
function lteStartPoll() {
  lteStopPoll();
  LTE_POLL = setInterval(() => {
    try {
      if (!LTE || !LTE.host || !LTE.host.isConnected) {
        lteStopPoll();
        return;
      }
      lteOnRepaint();
      ltePaintMeta(); /* 运行态 / 图版本会随条带变化：现况那几行也跟着刷 */
    } catch (_) {}
  }, LTE_POLL_MS);
}
function lteStopPoll() {
  if (LTE_POLL) {
    clearInterval(LTE_POLL);
    LTE_POLL = 0;
  }
}
function lteSig(st) {
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
function ltePaint(stIn) {
  if (!LTE) return;
  const st = stIn || lteSession();
  const conv = LTE.conv;
  if (!conv) return;
  conv.innerHTML = "";
  if (!st) {
    conv.appendChild(
      lteEl(
        "div",
        "lte-intro",
        lteT("在上面写清你要改什么，点「发送」：Agent 会先读当前这张任务图与运行态，再按你的要求原地改图并写回，改完给一段摘要。每次「发送」都开一条全新会话，不继承前面的上下文。"),
      ),
    );
    LTE.sig = "";
    ltePaintStatus(null);
    ltePaintSum();
    ltePaintMeta();
    return;
  }
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  const from = Math.max(0, msgs.length - LTE_CONV_MAX);
  if (from > 0) conv.appendChild(lteEl("div", "lte-more", lteT("（更早的内容在会话视图里）")));
  for (let i = from; i < msgs.length; i++) {
    try {
      conv.appendChild(dshMsgBlock(msgs[i], st.id, i, {}));
    } catch (_) {}
  }
  if (st.running) conv.appendChild(lteLiveRow(st));
  try {
    if (typeof scrollElToBottomIfStuck === "function") scrollElToBottomIfStuck(conv);
    else conv.scrollTop = conv.scrollHeight;
  } catch (_) {}
  const hit = lteAdopt(st);
  if (hit) LTE.found = hit;
  LTE.sig = lteSig(st);
  ltePaintStatus(st);
  ltePaintSum();
  ltePaintMeta();
  lteSettle(st);
}
function lteLiveRow(st) {
  const row = lteEl("div", "dsh-msg dsh-ai lte-live");
  const head = lteEl("div", "dsh-msg-head");
  head.appendChild(lteEl("span", "dsh-role", "AI"));
  row.appendChild(head);
  const tools = Array.isArray(st._liveTools) ? st._liveTools : [];
  if (tools.length && typeof dshToolDetailsEl === "function") {
    const chips = lteEl("div", "dsh-tools");
    for (const t of tools) {
      try {
        chips.appendChild(dshToolDetailsEl(t, true, st.id));
      } catch (_) {}
    }
    row.appendChild(chips);
  }
  row.appendChild(lteEl("div", "dsh-msg-body dsh-stream", String(st._pending || "")));
  return row;
}
function ltePaintStatus(st) {
  if (!LTE || !LTE.status) return;
  const box = LTE.status;
  box.innerHTML = "";
  let text = lteT("还没有开始：写完修改要求点「发送」");
  let cls = "idle";
  if (st) {
    const pendingAsk = lteAskPending(st);
    if (st.running && pendingAsk) {
      text = lteT("Agent 正在等你作答：去「🐋 模型等待你的回应」卡片里点选 / 填空");
      cls = "ask";
    } else if (st.running) {
      text = lteT("正在跑本轮…");
      cls = "run";
    } else if (LTE.found) {
      text = lteT("本轮结束：图已按你的要求写回");
      cls = "ok";
    } else {
      text = lteT("本轮结束：可以再点「发送」提新的修改（会另起一条全新会话）");
      cls = "idle";
    }
  }
  box.className = "lte-status lte-status-" + cls;
  box.appendChild(lteEl("span", "lte-status-dot", "●"));
  box.appendChild(lteEl("span", "lte-status-txt", text));
}
function lteAskPending(st) {
  const tools = Array.isArray(st._liveTools) ? st._liveTools : [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (!t) continue;
    if (t.result == null && !t.error) return /ask_user_question/i.test(String(t.name || ""));
  }
  return false;
}
/* 抬头那行：任务名 + 图版本 + 运行态 chip（每 1.2s 随条带刷新一次） */
function ltePaintMeta() {
  if (!LTE || !LTE.meta) return;
  const snap = lteSnap();
  const box = LTE.meta;
  box.innerHTML = "";
  if (!snap) {
    box.appendChild(lteEl("span", "lte-meta-i", lteT("读不到这张任务（可能已被删除）")));
    return;
  }
  box.appendChild(lteEl("span", "lte-meta-i", lteT("图版本 v") + snap.ver));
  box.appendChild(
    lteEl(
      "span",
      "lte-meta-i",
      snap.run
        ? lteT("运行中：") + (snap.run.status || "") + " · " + snap.run.steps + lteT(" 步")
        : lteT("没有在跑的 run"),
    ),
  );
  if (snap.run && snap.run.graphVersion && Number(snap.ver) > Number(snap.run.graphVersion))
    box.appendChild(
      lteEl("span", "lte-meta-i lte-meta-warn", lteT("当前 run 仍按启用那刻的 v") + snap.run.graphVersion + lteT(" 在跑：重新启用才用新图")),
    );
}
/* ── 回执解读：认出「图已经写回」这件事 ─────────────────────────────
   两条路：① update_longtask 成功回执（首选）；② 回复正文里那份完整图 JSON
   （工具不可用时的兜底 —— 宿主用 window.LT.updateFromGraph 按同一份归一路径写回）。
   认领口径与引导区（ltgScan）同源：工具名 + 回执文本里能解析出图（或至少 uid）。 */
function lteToolText(res) {
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
function lteScan(st) {
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  const calls = [];
  const collect = (tools) => {
    for (const t of tools || []) {
      if (!t) continue;
      const nm = String(t.name || "");
      const args = String(t.args || "");
      const isUpdate = /update_longtask/i.test(nm) || (/mtnode_app/i.test(nm) && /update_longtask/i.test(args));
      if (!isUpdate) continue;
      calls.push({ at: Number(t.at) || 0, ok: !t.error, text: t.error ? "" : lteToolText(t.result), args });
    }
  };
  for (const m of msgs) collect(m && m.tools);
  collect(st._liveTools);
  calls.sort((a, b) => b.at - a.at);
  const okCall = calls.find((c) => c.ok);
  if (okCall) {
    const g = typeof ltgParseGraph === "function" ? ltgParseGraph(okCall.text) : null;
    return { graph: (g && g.graph) || null, source: "receipt", at: okCall.at };
  }
  /* 兜底：回复正文里那份图 JSON（update_longtask 不可用 / 报错时的契约出口） */
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "assistant") continue;
    const g = typeof ltgParseGraph === "function" ? ltgParseGraph(String(m.content || "")) : null;
    if (g && g.graph) return { graph: g.graph, source: "reply", at: Number(m.at) || 0 };
  }
  return null;
}
/* 认领 + 兜底写回：回复里那份图由宿主按同一份归一路径写回（不让用户手动去条带上照抄）。
   幂等：同一份图（指纹相同）只写一次 —— 本轮重绘很多次，缺这一条会来回写同一份。 */
function lteGraphKey(graph) {
  try {
    return String(JSON.stringify({ n: (graph.nodes || []).length, e: (graph.edges || []).length, s: JSON.stringify(graph).length }));
  } catch (_) {
    return "";
  }
}
function lteAdopt(st) {
  let hit = null;
  try {
    hit = lteScan(st);
  } catch (_) {
    return null;
  }
  if (!hit) return null;
  if (hit.source === "reply" && hit.graph) {
    const key = "reply:" + lteGraphKey(hit.graph);
    /* 幂等：同一份图只写一次（一轮里 ltePaint 会被调很多次）。命中已写过的 key 就原样回放
       上次的结果，而不是把「写回失败」也变成「看起来没这回事」。 */
    if (LTE.applied === key) return LTE.replyErr ? { graph: hit.graph, source: "reply", err: LTE.replyErr } : { graph: hit.graph, source: "receipt", local: true };
    LTE.applied = key;
    const wf = lteWf();
    const r =
      wf && window.LT && typeof window.LT.updateFromGraph === "function"
        ? window.LT.updateFromGraph(wf, String((LTE && LTE.uid) || ""), hit.graph, "")
        : null;
    if (r && r.ok) {
      LTE.replyErr = "";
      try {
        if (window.LT && window.LT.ui) {
          window.LT.ui.render();
          window.LT.ui.open(true);
        }
      } catch (_) {}
      lteMarkApplied(r.ver);
      return { graph: r.graph, source: "receipt", ver: r.ver };
    }
    LTE.replyErr = (r && r.error) || "";
    return { graph: hit.graph, source: "reply", err: LTE.replyErr };
  }
  if (hit.source === "receipt" && hit.graph) lteMarkApplied((lteSnap() || {}).ver);
  return hit.graph ? hit : { graph: null, source: "receipt" };
}
/* 写回成功后的一次性提示（同一版本只提示一次） */
function lteMarkApplied(ver) {
  const key = String((LTE && LTE.uid) || "") + "#v" + String(ver || "");
  if (key === LTE_LAST_APPLIED) return;
  LTE_LAST_APPLIED = key;
  try {
    if (typeof toast === "function") toast(lteT("任务链已更新到 v") + String(ver || ""), "ok");
  } catch (_) {}
}
/* ── 收尾闸：本轮没写回就自动纠偏一次（对齐引导区的 ltgSettle 口径）──
   判据三件：本轮真的跑过（消息数超过起轮基线）、最后一条是 assistant（不是挂在等作答上）、
   没有认领到「图已写回」。上限按用户轮计（lteSend 每次清零），绝不来回拉扯。 */
function lteFixDirective() {
  return (
    "【图未写回 · 自动纠偏】本入口（长周期任务「修改任务链」窗）的唯一产物是**把改好的图原地写回这张任务**，" +
    "而应用这一轮没有拿到 update_longtask 的成功回执，也没在你回复里找到完整的新图 JSON。\n" +
    "本轮唯一要做的事（按系统提示里【长周期任务修改 · 会话契约】）：\n" +
    "· 先 mtnode_app（action:\"get_longtask\"）读回当前图与运行态（别凭记忆改）；\n" +
    "· 按用户的要求把图改好，再用 mtnode_app（action:\"update_longtask\"，uid=\"" +
    String((LTE && LTE.uid) || "") +
    "\"，graph=**完整的新图**）写回；报校验错就按 err 修好再调。\n" +
    "· 工具不可用时：把完整的新图 JSON（{\"kind\":\"mtnode-longtask-graph\",\"name\":\"…\",\"graph\":{…}}）原样放进回复正文的 ```json 围栏里，宿主会自动写回。\n" +
    "禁止：create_longtask 新建任务、输出计划块、用 todo_write 登记清单、把「照着改」当成交付。"
  );
}
function lteSettle(st) {
  if (!st || !st.id) return;
  const running = typeof sessionIsRunning === "function" ? sessionIsRunning(st) : !!st.running;
  if (running) return;
  const hit = lteAdopt(st);
  if (hit && (hit.graph || hit.source === "receipt")) {
    if (LTE) LTE.found = hit;
    return;
  }
  const msgs = Array.isArray(st.messages) ? st.messages : [];
  const base = Number(LTE_ROUND_FROM.get(st) || 0);
  if (msgs.length <= base) return; /* 只是开窗接回历史会话：不算「这一轮没写回」 */
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  if (!last || last.role !== "assistant") return;
  const used = Number(st._ltEditFixRounds) || 0;
  if (used >= LTE_FIX_MAX) return;
  st._ltEditFixRounds = used + 1;
  try {
    if (typeof toast === "function") toast(lteT("本轮没有把改好的图写回：已让 Agent 按契约重做一次。"), "warn");
  } catch (_) {}
  try {
    const p = agentSessionSend(lteFixDirective(), { sessionId: st.id });
    if (p && typeof p.then === "function")
      p
        .then(() => {
          if (lteDialogLive()) ltePaint(lteSession() || st);
        })
        .catch(() => {});
  } catch (_) {}
}
/* ─ 右栏：现况摘要（节点清单 + 改动回执）────────────────────────── */
function ltePaintSum() {
  if (!LTE || !LTE.sum) return;
  const box = LTE.sum;
  box.innerHTML = "";
  const snap = lteSnap();
  box.appendChild(lteEl("div", "lte-sum-h", "🪄 " + lteT("当前任务图")));
  if (!snap) {
    box.appendChild(lteEl("div", "lte-sum-i", lteT("读不到这张任务（可能已被删除）。")));
    return;
  }
  const nodes = (snap.graph && snap.graph.nodes) || [];
  const edges = (snap.graph && snap.graph.edges) || [];
  box.appendChild(lteEl("div", "lte-sum-i", lteT("节点 ") + nodes.length + " · " + lteT("连线 ") + edges.length));
  const kindTxt = (k) =>
    ({
      start: lteT("起点"),
      end_ok: lteT("成功终点"),
      end_fail: lteT("失败终点"),
      agent: lteT("Agent 任务"),
      human: lteT("人工任务"),
      join: lteT("汇聚"),
      fork: lteT("选路"),
      map: lteT("逐项并行"),
      sub: lteT("子图"),
      output: lteT("写文件"),
    })[k] || k;
  for (const n of nodes) {
    const keys = ((n.cfg || {}).outKeys || []).join(" / ");
    box.appendChild(
      lteEl("div", "lte-sum-n", "· " + kindTxt(n.kind) + "：" + lteClip(String(n.title || ""), 22) + (keys ? "（产出 " + keys + "）" : "")),
    );
  }
  const hit = LTE.found;
  if (hit && hit.source === "receipt") box.appendChild(lteEl("div", "lte-sum-ok", "✓ " + lteT("本轮已按你的要求写回（当前 ") + "v" + snap.ver + "）"));
  else if (hit && hit.source === "reply")
    box.appendChild(lteEl("div", "lte-sum-err", "⚠ " + lteT("回复里给了图但没能写回：") + String(hit.err || lteT("请让 Agent 用 update_longtask 再试一次"))));
  const errs = window.LT && typeof window.LT.validate === "function" ? window.LT.validate(snap.graph).filter((x) => x.level === "err") : [];
  if (errs.length) box.appendChild(lteEl("div", "lte-sum-err", "⚠ " + lteT("图校验有问题：") + errs[0].msg));
}

/* ── 发送 / 起轮 / 中断 / 关闭 ─────────────────────────────────── */
async function lteSend() {
  if (!LTE) return;
  const txt = String(LTE.ta.value || "").trim();
  if (!txt) {
    if (typeof toast === "function") toast(lteT("先用一句话写清要改什么"), "warn");
    return;
  }
  /* 上一次的修改会话还在跑就停掉：这一次的要求自成一轮，不叠在旧上下文上
     （本次需求：改任务链时重启清空会话，避免前面的上下文干扰）。 */
  const prev = lteSession();
  if (prev && (typeof sessionIsRunning === "function" ? sessionIsRunning(prev) : !!prev.running) && typeof stopSessionRuns === "function") {
    try {
      stopSessionRuns(prev, true);
    } catch (_) {}
  }
  /* 每次「发送」= 一条**全新的契约会话**（绝不接回上一条：旧会话留在左侧栏只作历史）。
     本窗内也不再续聊同一条 —— 改任务链最怕旧上下文干扰新要求，宁可多起一条也要干净。
     契约会话：标题锁定 + 绑本对话框所属画布 + 允许读画布（→ 三件套全在，满足「有全部权限」）
     + 契约每轮注入。模型选型沿用「创建长任务」窗那一栏（用户建图时选的那套），
     没选过就跟随会话默认 —— 修改与创建用同一套脑子。 */
  {
    const cfg = (function () {
      try {
        if (typeof window.ltCreateAgentCfg === "function") return window.ltCreateAgentCfg() || {};
      } catch (_) {}
      return {};
    })();
    const st = agentContractSession({
      title: lteT("任务链修改") + " · " + lteClip(String((lteTask() || {}).name || ""), 16),
      contract: lteContractText(),
      kick: lteRoundInput(txt),
      canvasWfId: (lteWf() || {}).id ? String(lteWf().id) : "",
      allowCanvas: true,
      provider: cfg.provider || "",
      model: cfg.model || "",
      effort: cfg.effort || "",
    });
    if (cfg.preset) st.preset = String(cfg.preset);
    /* 计划闸豁免：本会话的产物是「改好的图」，不是普通会话计划 / 任务清单 */
    st.noPlanFlow = true;
    st._ltEditFixRounds = 0;
    st._ltEditUid = String(LTE.uid || "");
    LTE.sid = st.id;
    LTE.found = null;
    lteClearDraft();
    LTE_ROUND_FROM.set(st, (st.messages || []).length);
    ltePaint(st);
    try {
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    await agentContractRound(st);
    lteSettle(lteSession() || st);
    ltePaint(lteSession() || st);
    return;
  }
}
function lteClearDraft() {
  if (LTE) {
    LTE.ta.value = "";
    LTE.draft = "";
  }
  lteDraftSave("");
}
function lteAbort() {
  const st = lteSession();
  if (!st) return;
  const running = typeof sessionIsRunning === "function" ? sessionIsRunning(st) : !!st.running;
  if (!running) {
    if (typeof toast === "function") toast(lteT("这一轮已经结束了"), "ok");
    return;
  }
  try {
    if (typeof stopSessionRuns === "function") stopSessionRuns(st, true);
  } catch (_) {}
  if (typeof toast === "function") toast(lteT("已中断本轮：会话留着，随时可以接着说"), "warn");
  ltePaint(st);
}
function lteLater() {
  const st = lteSession();
  try {
    closeOverlay();
  } catch (_) {}
  if (typeof persistAgentSession === "function") Promise.resolve(persistAgentSession()).catch(() => {});
  if (st && typeof toast === "function") toast(lteT("这条修改会话留在左侧栏只作历史；下次打开本窗是一条全新会话（不继承上下文）"), "ok");
}
function lteGotoSession() {
  const st = lteSession();
  if (!st) return;
  lteLater();
  try {
    if (typeof setView === "function") setView("agent");
    S.agentActiveId = st.id;
    if (typeof renderAgentSession === "function") renderAgentSession();
    if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
  } catch (_) {}
}
/* 条带收起 / 切画布时把窗内状态收干净（窗没关就不动，免得把用户的输入弄丢） */
window.LT = window.LT || {};
window.LT.edit = { open: ltOpenEditDlg, pollStop: lteStopPoll };
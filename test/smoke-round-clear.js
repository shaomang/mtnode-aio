"use strict";
/* 新一轮自动清空上一轮「已完成」的计划与任务清单 —— 冒烟测试（纯 Node，零依赖、无 Electron）
 *   node test/smoke-round-clear.js
 *
 * 本次需求（用户口径）：会话里开启新一轮对话或任务时，自动清空下方之前已完成的计划与
 * 步骤，避免用户误以为是本轮的。共识（20 题询问窗逐条确认）落成三条规矩：
 *   ① 时机 = 用户发出的消息**真正开跑**的那一瞬（上一轮还在跑时新消息先排队）；
 *   ② 判据 = 两块卡各自判、各自清：没有待执行 / 执行中项（只剩 done / skipped / failed /
 *      unknown）就整份清掉并落盘，否则整份保留并在计划面板头部标「上一轮遗留 N 项未完」；
 *   ③ 豁免 = 计划执行轮 / 清单同步轮 / 漏弹纠错轮 / 恢复轮不算新一轮；计划正在跑或会话
 *      暂停时跳过（不清、标签不动）。
 * 覆盖：
 *   [1] 计划清单判据与清理（真跑源码切片的 agentRoundPlanSettled / agentRoundClearPlan）
 *   [2] 任务清单判据与清理（agentRoundTodosSettled / agentRoundClearTodos + 记账进 todoHidden）
 *   [3] 新一轮入口 agentRoundMarkNew：清理 + 轮次推进 + 标签落文案 / 跳过规则
 *   [4] 轮次标签文案与 DOM（agentRoundLabel / agentRoundLabelApply）
 *   [5] 接线：index.html 元素 · 样式 · agentSessionSend 挂点 · 节点内运行 · 计划面板头部标记
 *   [6] 未完成时给模型注入的指令改为「新话优先」（planFlowCarryDirective 真跑）
 *   [7] i18n 词条（中英）
 */
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
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs
    .readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");

const ASSIST = read("renderer/app-assist.js");
const PLAN = read("renderer/app-plan.js");
const NODES = read("renderer/app-nodes.js");
const DEVD = read("renderer/app-apps-dev.js");
const HTML = read("renderer/index.html");
const CSS = read("renderer/css/dsh.css");
const APPS_CSS = read("renderer/css/apps.css");
const I18N = read("renderer/i18n.js");

/* ── 源码切片：从 app-assist.js 取「新一轮」那一整段（判据 / 清理 / 标签 / 入口） ──
   切片 = 真源码，不做任何复制粘贴 —— 源码改了而这里没跟上，测试就会失败。 */
function roundBlock() {
  const a = ASSIST.indexOf("/* 计划清单是否「全部了结」");
  const b = ASSIST.indexOf("/* 解析 todo_write 的入参", a);
  return a >= 0 && b > a ? ASSIST.slice(a, b) : "";
}
/* ── 迷你 DOM：够 agentRoundLabelApply 用（#agentRound > b + i） ── */
function el(tag) {
  const node = {
    tagName: tag,
    textContent: "",
    title: "",
    hidden: false,
    children: {},
    querySelector(sel) {
      return this.children[String(sel).replace(/^[.#]/, "")] || null;
    },
  };
  return node;
}
function mkDom() {
  const round = el("div");
  round.children.b = el("b");
  round.children.i = el("i");
  return round;
}
/* ── 沙箱：真跑切片（I18n.t 按参数插值，与 renderer/i18n.js 同口径） ── */
function load(opts) {
  opts = opts || {};
  const calls = { plan: 0, todo: 0, persisted: 0 };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = {
    t: (key, vars) => {
      let s = String(key == null ? "" : key);
      if (vars && typeof vars === "object")
        s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
      return s;
    },
  };
  const round = opts.dom === false ? null : mkDom();
  sandbox.document = {
    getElementById: (id) => (id === "agentRound" ? round : null),
  };
  sandbox.renderAgentPlanPanel = () => {
    calls.plan++;
  };
  sandbox.renderAgentTodoPanel = () => {
    calls.todo++;
  };
  /* 轮号真源（app-assist.js 的 agentRoundOfRun）的桩：第 N 轮 = 用户第几次发送。
     真源本体在 app-assist.js 的另一段（与轨迹共用），这里只按同一口径算号 ——
     顶部标签与轨迹同源这件事由 [5] 的源码断言钉住。 */
  sandbox.agentRoundOfRun = (s) => {
    const msgs = (s && Array.isArray(s.messages) && s.messages) || [];
    let n = 0;
    for (const m of msgs) if (m && m.role === "user") n++;
    return n || null;
  };
  vm.createContext(sandbox);
  const src = roundBlock();
  if (!src) throw new Error("切片失败：app-assist.js 的新一轮段没找到");
  vm.runInContext(src, sandbox, { filename: "app-assist.js#round" });
  return { sandbox, calls, round };
}
function sess(o) {
  return Object.assign({ id: "as1", messages: [], todos: [] }, o || {});
}
/* 造一段消息历史：n 条用户消息，最后一条的时间 = stamp */
function msgsOf(n, stamp) {
  const out = [];
  for (let i = 1; i <= n; i++)
    out.push({ role: "user", content: "u" + i, at: stamp - (n - i) * 1000 });
  out.push({ role: "assistant", content: "a" });
  return out;
}
const steps = (...stt) => stt.map((s, i) => ({ n: i + 1, title: "t" + (i + 1), status: s }));

(async () => {
  console.log("smoke-round-clear：新一轮自动清空上一轮的已了结清单\n");

  /* ═══════════ [1] 计划清单：判据与清理 ═══════════ */
  console.log("[1] 计划清单（#agentPlan）：全部了结才清，还有待执行就整份保留");
  {
    const { sandbox, calls } = load();
    const settled = (s) => sandbox.agentRoundPlanSettled({ steps: s });
    ok(settled(steps("done", "done")) === true, "done × N → 了结");
    ok(settled(steps("done", "skipped")) === true, "done / skipped → 了结");
    ok(settled(steps("done", "failed")) === true,
      "done / failed → 了结（失败是上一轮的账，一并清）");
    ok(settled([]) === true, "没有步骤 → 了结（不挡任何东西）");
    ok(settled(null) === true, "没有计划 → 了结");
    ok(settled(steps("done", "pending")) === false, "还有待执行 → 未了结");
    ok(settled(steps("done", "active")) === false, "还有执行中 → 未了结");

    const s1 = sess({ plan: { goal: "g", steps: steps("done", "done") }, _planOpen: 2, planCollapsed: true });
    ok(sandbox.agentRoundClearPlan(s1) === true, "清一份全完成的计划 → true");
    ok(s1.plan === null, "计划数据真删（不是藏起来）");
    ok(s1._planOpen === null && s1.planCollapsed === false && s1._planDelivered === false,
      "面板现场一并复位（展开项 / 折叠态 / 交付标记）");
    ok(calls.plan === 1, "清完就地重绘计划面板（面板随之收起）");

    const s2 = sess({
      plan: { goal: "g", steps: steps("done", "pending") },
      _planExec: { runId: "pr1", cur: [] },
    });
    ok(sandbox.agentRoundClearPlan(s2) === false, "还有待执行 → 不清");
    ok(!!s2.plan && !!s2._planExec, "计划数据与执行游标都原样留着");
    ok(calls.plan === 1, "不清就不重绘");
  }

  /* ═══════════ [2] 任务清单：判据与清理 ═══════════ */
  console.log("\n[2] 任务清单（#agentTodo）：条目清空 + 记账进 todoHidden（旧条目下一轮不复活）");
  {
    const { sandbox, calls } = load();
    const settled = (t) => sandbox.agentRoundTodosSettled(t);
    ok(settled([{ content: "a", status: "done" }]) === true, "done → 了结");
    ok(
      settled([{ content: "a", status: "done" }, { content: "b", status: "unknown" }]) === true,
      "done / unknown（上一轮没收口的「?」）→ 了结",
    );
    ok(
      settled([{ content: "a", status: "done" }, { content: "b", status: "failed" }]) === true,
      "done / failed → 了结",
    );
    ok(settled(null) === true && settled([]) === true, "没有清单 → 了结");
    ok(settled([{ content: "a", status: "pending" }]) === false, "还有待办 → 未了结");
    ok(settled([{ content: "a", status: "active" }]) === false, "还有进行中 → 未了结");

    const s1 = sess({ todos: [{ content: "做完的", status: "done" }, { content: "挂了", status: "unknown" }] });
    ok(sandbox.agentRoundClearTodos(s1) === true, "清一份已了结的清单 → true");
    ok(Array.isArray(s1.todos) && s1.todos.length === 0, "条目真清空");
    ok(
      s1.todoHidden.indexOf("做完的") >= 0 && s1.todoHidden.indexOf("挂了") >= 0,
      "两条都记账进 todoHidden（模型下一轮又写回同一批内容也不会复活）",
    );
    ok(calls.todo === 1, "清完就地重绘任务清单面板");

    const s2 = sess({ todos: [{ content: "做一半", status: "pending" }] });
    ok(sandbox.agentRoundClearTodos(s2) === false, "还有待办 → 不清");
    ok(s2.todos.length === 1, "条目原样留着");
    ok(calls.todo === 1, "不清就不重绘");
  }

  /* ═══════════ [3] 新一轮入口：清理 + 轮次推进 + 跳过规则 ═══════════ */
  console.log("\n[3] agentRoundMarkNew：清了才推进轮次；执行中 / 暂停 / 无事可清都不动");
  {
    const { sandbox } = load();
    const s = sess({
      plan: { goal: "g", steps: steps("done") },
      todos: [{ content: "a", status: "done" }],
    });
    const r = sandbox.agentRoundMarkNew(s);
    ok(r.cleared === true && r.plan === true && r.todos === true, "两块都了结 → 都清");

    const s2 = sess({});
    const r2 = sandbox.agentRoundMarkNew(s2);
    ok(r2.cleared === false, "无事可清（两块都空）→ 什么都不做");

    const s3 = sess({
      plan: { goal: "g", steps: steps("done") },
      _planExec: { runId: "pr1", cur: [] },
    });
    const r3 = sandbox.agentRoundMarkNew(s3);
    ok(r3.cleared === false && !!s3.plan, "计划正在跑 → 跳过清理（在跑的进度与续跑入口都不弄丢）");

    const s4 = sess({ plan: { goal: "g", steps: steps("done") }, paused: true });
    const r4 = sandbox.agentRoundMarkNew(s4);
    ok(r4.cleared === false && !!s4.plan, "会话暂停态 → 跳过清理");

    const s5 = sess({ plan: { goal: "g", steps: steps("done", "pending") }, todos: [{ content: "a", status: "done" }] });
    const r5 = sandbox.agentRoundMarkNew(s5);
    ok(r5.plan === false && r5.todos === true, "两块各自判：计划留（有未完项）、清单清（已了结）");
    ok(!!s5.plan && s5.todos.length === 0, "留 / 清各按自己那份判据落地");
  }

  /* ═══════════ [4] 轮次标签：文案 + DOM ═══════════ */
  console.log("\n[4] 轮次标签：文案与 DOM（#agentRound > b + i）");
  {
    const { sandbox, round } = load();
    ok(sandbox.agentRoundLabel(sess({})) === "",
      "还没有任何用户消息（空会话）→ 空文案（标签整行不占位）");
    const stamp = new Date(2026, 0, 2, 9, 7).getTime();
    ok(
      sandbox.agentRoundLabel(sess({ messages: msgsOf(2, stamp) })) === "第 2 轮 · 09:07",
      "有 2 条用户消息 → 「第 2 轮」+ 分隔 + 「09:07」（两位补零）",
    );
    ok(sandbox.agentRoundTime(stamp) === "09:07", "时间格式 HH:MM");
    ok(
      sandbox.agentRoundRoundAt(sess({ messages: msgsOf(3, stamp) })) === stamp,
      "开始时刻 = 最后一条用户消息的时间",
    );
    ok(
      sandbox.agentRoundRoundAt(sess({ messages: [{ role: "assistant", content: "x" }] })) === 0,
      "只有助手消息 → 没有时刻（不编一个）",
    );

    sandbox.agentRoundLabelApply(sess({ messages: msgsOf(5, stamp) }));
    ok(round.hidden === false, "有用户消息 → 标签显示");
    ok(round.children.b.textContent === "第 5 轮", "前半 = 第 5 轮（用户第几次发送）");
    ok(round.children.i.textContent === "09:07", "后半 = 本轮开始时间");
    sandbox.agentRoundLabelApply(sess({}));
    ok(round.hidden === true, "空会话 → 整行隐藏");
    ok(sandbox.agentRoundLabelApply({}) === undefined, "没有 DOM 也不报错（开发页 / 测试桩）");
  }

  /* ═══════════ [5] 接线：元素 · 样式 · 挂点 · 节点内 · 面板标记 ═══════════ */
  console.log("\n[5] 接线：元素 / 样式 / 会话挂点 / 节点内新一轮 / 计划面板头部标记");
  {
    ok(
      /id="agentRound"/.test(HTML) && /class="agent-round"/.test(HTML),
      "index.html 有轮次标签元素（#agentRound）",
    );
    ok(
      HTML.indexOf('id="agentRound"') < HTML.indexOf('id="agentList"'),
      "标签排在消息区之前（会话区顶部）",
    );
    ok(/\.agent-round\s*\{/.test(CSS) && /\.agent-round\[hidden\]/.test(CSS),
      "dsh.css 有 .agent-round 样式与 [hidden] 收起");
    ok(/flex:\s*none/.test(CSS.slice(CSS.indexOf(".agent-round {"))),
      "标签 flex:none（不与消息区抢高度，输入区预算不变）");
    ok(/\.ap-leftover\s*\{/.test(CSS), "dsh.css 有「上一轮遗留」标记样式（.ap-leftover）");

    const hook = ASSIST.slice(
      ASSIST.indexOf("如果 !planExecMsg") >= 0 ? ASSIST.indexOf("如果 !planExecMsg") : ASSIST.indexOf("!planExecMsg &&"),
      ASSIST.indexOf("if (!Array.isArray(st.todos)) st.todos = [];"),
    );
    ok(ASSIST.indexOf("if (\n      !planExecMsg &&") >= 0 || /if \(\s*!planExecMsg &&/.test(ASSIST),
      "agentSessionSend 里有新一轮挂点");
    ok(/!todoSyncMsg &&\s*!resumeRound &&\s*!opts\._autoContinue/.test(ASSIST),
      "挂点排除了清单同步轮 / 恢复轮 / 自动续跑轮（只有用户亲口那一轮才算新一轮）");
    ok(/const rr = agentRoundMarkNew\(st\);/.test(ASSIST),
      "挂点复用同一个入口 agentRoundMarkNew");
    ok(/if \(rr && rr\.cleared\) st\._planDrops = 0;/.test(ASSIST),
      "清理不打作废计数（_planDrops 复零，后续新计划与续跑入口照常点亮）");
    ok(!!hook || ASSIST.indexOf("agentRoundMarkNew(st)") >= 0, "挂点落在会话开跑处");
    ok(
      /typeof agentRoundLabelApply === "function"\) agentRoundLabelApply\(st\);/.test(ASSIST),
      "renderAgentSession 每次重绘都落一次标签（切会话 / 重启都在）",
    );
    /* 轮号的唯一真源：agentRoundOfRun（会话里用户第几次发送，与轨迹的「第 N 轮」同一份）。
       绝不自造第二个计数器 —— 两套计数分叉就会「顶部第 2 轮、轨迹第 3 轮」。 */
    ok(
      /function agentRoundLabel\(st\) \{\s*\n\s*const no = typeof agentRoundOfRun === "function" \? agentRoundOfRun\(st\) : null;/.test(
        ASSIST,
      ),
      "轮次标签的号取自 agentRoundOfRun（与轨迹同源，不自造计数器）",
    );
    ok(
      !/st\._round\b/.test(ASSIST) && !/s\._round\b/.test(ASSIST),
      "会话上不再有第二份轮次计数（st._round 已整体拆净）",
    );
    ok(
      /function agentRoundRoundAt\(st\) \{/.test(ASSIST) &&
        /for \(let i = msgs\.length - 1; i >= 0; i--\) \{/.test(ASSIST),
      "开始时刻从消息历史现推（最后一条用户消息的时间），不落盘",
    );
    /* 标签会占一行高度，所以它必须被计划面板的高度预算算进去：
       agentPlanMaxH 是「宿主高 − 消息区下限 − 全部可见兄弟项实测」，按 dom 遍历现量。 */
    ok(
      /for \(let i = 0; i < kids\.length; i\+\+\) \{/.test(PLAN) &&
        /const h = planTakesFlow\(c\) \? planSiblingH\(c\) : 0;/.test(PLAN) &&
        /if \(!c \|\| c === el \|\| !c\.classList \|\| c\.hidden\) continue;/.test(PLAN),
      "计划面板高度预算按可见兄弟项现量（轮次标签可见时自动被扣掉，不会挤压输入区）",
    );
    ok(
      /function planTakesFlow\(el\) \{/.test(PLAN) &&
        /return p !== "absolute" && p !== "fixed";/.test(PLAN),
      "标签是 static + flex:none → 计入占位（既不被当成装饰跳过、也不被当成填充项）",
    );
    /* 开发页右栏（应用开发页把会话正文搬过去）：标签跟着搬、首轮态跟着藏、跟随右栏那条会话 */
    ok(/"agentRound",\s*\n\s*"agentList",/.test(DEVD),
      "开发页搬运清单含轮次标签（不落在会话页里）");
    ok(
      /"agentRound",\s*\n\s*"agentPlan",/.test(DEVD),
      "开发页首轮态清面板时也清轮次标签（只留一句引导）",
    );
    ok(/\.apps-dev-conv\.is-draft > \.agent-round,/.test(APPS_CSS),
      "开发页首轮态 CSS 一并隐藏轮次标签");

    ok(
      /node\.kind === "agent_task" && node\.agentSessionId/.test(NODES) &&
        /const rr = agentRoundMarkNew\(sess\);/.test(NODES),
      "智能节点内开新一轮也清（与 agentSessionSend 同一个入口）",
    );
    ok(/persistAgentSession\(\)\.catch\(\(\) => \{\}\);/.test(NODES.slice(NODES.indexOf("agentRoundMarkNew(sess"))),
      "节点内清完落盘（数据真删，切会话 / 重启不复活）");

    ok(/ap-leftover/.test(PLAN) && /上一轮遗留 \{n\} 项未完/.test(PLAN),
      "计划面板头部有「上一轮遗留 N 项未完」标记");
    ok(
      /const roundNo =\s*\n\s*typeof agentRoundOfRun === "function" \? Number\(agentRoundOfRun\(st\)\) \|\| 0 : 0;/.test(PLAN) &&
        /if \(roundNo > 1 && openLeft > 0\) \{/.test(PLAN),
      "标记只在「用户确实开过一轮以上 + 确实还有遗留项」时出现（轮号同源）",
    );
  }

  /* ═══════════ [6] 未完项时给模型的指令：新话优先 ═══════════ */
  console.log("\n[6] planFlowCarryDirective：新话优先（真跑函数）");
  {
    const a = PLAN.indexOf("function planBriefLines(");
    const b = PLAN.indexOf("/* 跨会话计划沿用已整体移除");
    const src = PLAN.slice(a, b) + "\n";
    const sandbox = {};
    sandbox.I18n = { t: (k) => String(k) };
    sandbox.PLAN_STEP_ICON = { done: "✓", active: "◐", pending: "○", failed: "✕", skipped: "⊘" };
    sandbox.PLAN_MAX_TASKS = 8;
    sandbox.PLAN_GOAL_MAX = 300;
    sandbox.planStepStatus = (v) => (v === "done" || v === "pending" ? v : "pending");
    sandbox.PLAN_MARK_START = "<!--MTNODE-PLAN-->";
    sandbox.PLAN_MARK_END = "<!--/MTNODE-PLAN-->";
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "app-plan.js#carry" });
    const st = {
      plan: {
        goal: "把 A 做完",
        steps: [
          { n: 1, title: "第一步", detail: "已经做完的", status: "done" },
          { n: 2, title: "第二步", detail: "还没做的", status: "pending" },
        ],
      },
    };
    const txt = String(sandbox.planFlowCarryDirective(st));
    ok(/新话优先/.test(txt), "抬头写明「新话优先」");
    ok(/还没跑完/.test(txt) && /上一轮遗留项/.test(txt), "旧清单作参考列出（未完成 = 上一轮遗留项）");
    ok(/第一步/.test(txt) && /已完成（禁止重做）/.test(txt), "已完成项仍列出并禁止重做");
    ok(/以用户这一轮的话为准/.test(txt), "口径：以用户这一轮的话为准");
    ok(
      /若它说的是别的事（换了目标 \/ 换了方向 \/ 只是问一句），就按新话做/.test(txt),
      "显式写明「别的事就按新话做，旧清单搁置」",
    );
    ok(
      txt.indexOf("本轮以这份既有清单为准") < 0,
      "旧口径（本轮以既有清单为准）已不在（它会把用户新任务绑在旧计划上）",
    );
    ok(
      txt.indexOf("<!--MTNODE-PLAN-->") >= 0 && txt.indexOf("禁止】再输出一份新计划") >= 0,
      "仍然禁止再输出计划块（新旧计划不互相覆盖）",
    );
  }

  /* ═══════════ [7] i18n 词条 ═══════════ */
  console.log("\n[7] i18n：新词条中英齐备");
  {
    const pairs = [
      [" · ", " · "],
      ["上一轮遗留 {n} 项未完", "{n} item(s) left over from the previous turn"],
      [
        "这 {n} 项是上一轮遗留、不是本轮的任务（本轮开始时不清理未完成项）；要接着跑请点「继续执行」",
        "are left over from the previous turn and are not part of the current one",
      ],
    ];
    for (const [zh, enTxt] of pairs) {
      ok(I18N.indexOf('"' + zh + '"') >= 0, "中文词条在表里：" + zh.slice(0, 18) + "…");
      ok(I18N.indexOf(enTxt) >= 0, "英文词条在表里：" + enTxt.slice(0, 34) + "…");
    }
    ok(I18N.indexOf('"第 {n} 轮": "Turn {n}"') >= 0, "复用既有词条「第 {n} 轮」（不另造一份）");
    ok(ASSIST.indexOf('I18n.t("第 {n} 轮", { n: Number(no) })') >= 0,
      "轮次文案走参数化词条（可译）");
  }

  console.log(
    "\n" + (fails ? "FAILED " + fails + " / " + checks : "全部通过 " + checks + " 项"),
  );
  process.exit(fails ? 1 : 0);
})();

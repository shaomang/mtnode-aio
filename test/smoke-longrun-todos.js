"use strict";
/* 会话任务清单「?」与自动续跑 —— 回归（纯 Node，零依赖、无 Electron / 无真实 DOM）
 *   node test/smoke-longrun-todos.js
 *
 * 钉住的 bug（用户报）：会话里任务已经做完，清单列表却还是一串「?」。
 *   成因两层：
 *   ① app-longrun.js 的 todosOpen() 词表与落库状态不同源 —— agentApplyTodoWrite 把模型的
 *      in_progress 归一成 active、completed 归一成 done，判据却还在比 in_progress，于是
 *      「清单里明明有在做的条目」被算成 0（「清单已跑完」），自动续跑当场停住；
 *   ② 轮末 agentFinalizeTodos 把没跑完的条目标成 unknown（面板上的「?」），模型没在那轮里
 *      再写一次 todo_write 就永远挂着问号 —— 旧逻辑不但不补那一轮，还先把这份半截清单
 *      判成「已完成」并停跑。
 * 修法：todosOpen 只认终态（done / skipped），unknown 一律算未收口；出现未确认条目时补一轮
 *   「同步清单」指令（最多 TODO_SYNC_MAX 轮；同一批问号原样没变 = 模型已表态，停并告知）。
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
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const APP_LONGRUN = read("renderer/app-longrun.js");
const APP_ASSIST = read("renderer/app-assist.js");

/* ═══════════ 沙箱：真跑 app-longrun.js（发送 / 会话 / DOM 全部打桩） ═══════════ */
function load(opts) {
  opts = opts || {};
  const calls = { sends: [] };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.toast = () => {};
  sandbox.document = {
    readyState: "complete",
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
  };
  /* 宿主侧打桩：agentSessionSend 只记账（不进真会话） */
  sandbox.agentSessionSend = async (text, o) => {
    calls.sends.push({ text: String(text), opts: o || {} });
    return null;
  };
  const sess = opts.session || null;
  sandbox.agentSessionState = () => {
    if (!sess) return null;
    const view = opts.viewSid || sess.id;
    return view === sess.id ? sess : { id: view };
  };
  sandbox.agentSessionById = (id) => (sess && sess.id === id ? sess : null);
  sandbox.renderAgentSession = () => {};

  vm.createContext(sandbox);
  vm.runInContext(APP_LONGRUN, sandbox, { filename: "app-longrun.js" });
  /* 轮末钩子按宿主口径调用：afterRound(会话, 本轮结局) */
  sandbox.__round = (s, outcome) => sandbox.LongRun.afterRound(s, outcome);
  return { sandbox, calls, session: sess };
}
function sessWith(todos, text) {
  return {
    id: "as1",
    todos: todos || [],
    messages: text ? [{ role: "assistant", content: text }] : [],
  };
}
const sendCount = (c) => c.calls.sends.length;

(async () => {
  console.log("smoke-longrun-todos：清单「?」与自动续跑\n");

  /* ============ [1] 清单判据真跑（沙箱里直接调 todosOpen，不看源码） ============ */
  console.log("[1] 清单收口判据 todosOpen（状态词表与落库同源）");
  {
    const i = APP_LONGRUN.indexOf("function todosOpen(");
    const body = APP_LONGRUN.slice(i, APP_LONGRUN.indexOf("\n  }", i) + 4);
    const { sandbox } = load();
    vm.runInContext("var __todosOpen = " + body.replace("function todosOpen", "function"), sandbox);
    const open = (todos) => sandbox.__todosOpen({ todos });
    ok(open([]) === null, "没有清单 → null（这条判据不表态）");
    ok(open([{ content: "a", status: "done" }, { content: "b", status: "skipped" }]) === 0,
      "done / skipped 全收口 → 0");
    /* 这一条就是用户报的「?」：旧词表把 active / unknown 漏在门外 */
    ok(open([{ content: "a", status: "active" }]) === 1,
      "进行中（active，落库状态）算未收口 → 1（旧词表比 in_progress，这里恒回 0 = 自动续跑当场停）");
    ok(open([{ content: "a", status: "unknown" }]) === 1,
      "未确认（unknown = 面板上的「?」）算未收口 → 1");
    ok(open([{ content: "a", status: "pending" }, { content: "b", status: "failed" }]) === 2,
      "待办 / 失败都算未收口 → 2");
  }

  /* ============ [2] 清单已收口 → 不续跑 ============ */
  console.log("\n[2] 清单全部收口：停跑并写明原因");
  {
    const s = sessWith([{ content: "a", status: "done" }, { content: "b", status: "skipped" }], "继续做点别的");
    const c = load({ session: s });
    await c.sandbox.__round(s, "ok");
    ok(sendCount(c) === 0, "不发续跑指令（清单是真源：它说收口了才算收口）");
    ok(c.sandbox.LongRun.stop["as1"] === "清单已跑完", "停止原因 = 清单已跑完");
  }

  /* ============ [3] 未确认条目 + 答复看不出下一步 → 补一轮「同步清单」 ============ */
  console.log("\n[3] 清单里挂着「?」且答复没有收工信号：自动补一轮清单同步");
  {
    const s = sessWith(
      [{ content: "改 app-longrun.js", status: "unknown" }, { content: "写回归", status: "unknown" }],
      "还在核对这次改动的影响面。",
    );
    const c = load({ session: s, viewSid: "as1" });
    await c.sandbox.__round(s, "ok");
    ok(sendCount(c) === 1, "补了一轮（旧逻辑在这里发 0 条并判成「已跑完」）");
    const sent = c.calls.sends[0];
    ok(/同步任务清单/.test(sent.text) && /todo_write/.test(sent.text),
      "发的是「同步任务清单」指令（要求用 todo_write 把每条状态写对）");
    ok(/2 条没有确认状态/.test(sent.text), "指令里带着未确认条目的条数");
    ok(sent.opts.sessionId === "as1" && sent.opts._autoContinue === true && sent.opts._todoSync === true,
      "归属会话正确，且带上 _todoSync 标记（宿主据此不注入「任务流程」指令）");
    ok(s._todoSyncTries === 1 && Array.isArray(s._todoSyncUnknownSet) && s._todoSyncUnknownSet.length === 2,
      "记账：补了 1 轮 + 记下这批问号的内容（供下一轮判「有没有回应」）");
    ok(s._todoSyncPending === false, "旗子已摘（下一轮若又冒问号还能在配额内再补）");
    ok((s._todoSyncRounds || 0) === 1, "跨批总闸也记了一笔（_todoSyncRounds）");
    ok(/不要去重跑已经跑绿的测试/.test(sent.text), "指令明令不许重跑已跑绿的验证步骤（防原地空转烧钱）");
  }

  /* ============ [3b] 答复已明确收工 + 还剩「?」→ 当场停（本轮修复的现场） ============ */
  console.log("\n[3b] 答复已明确收工：不再追轮（旧逻辑在这里又追一轮，把冒烟测试重跑了一遍）");
  {
    const s = sessWith(
      [{ content: "改 app-longrun.js", status: "unknown" }, { content: "写回归", status: "unknown" }],
      "全部完成，交付如上。",
    );
    const c = load({ session: s, viewSid: "as1" });
    await c.sandbox.__round(s, "ok");
    ok(sendCount(c) === 0, "一条指令都不发（收工判停排在清单同步之前）");
    ok(c.sandbox.LongRun.stop["as1"] === "目标已达成", "停止原因 = 目标已达成");
    ok(c.sandbox.LongRun.stop["as1"] !== "清单已跑完", "不是把半截清单误判成「已跑完」");
  }

  /* ============ [3c] 收工判据真跑：模型日常的收工写法都要认 ============ */
  console.log("\n[3c] hasDoneSignal 真跑（老词表只认「全部完成 / 已交付」，漏掉现场里那几种写法）");
  {
    const i = APP_LONGRUN.indexOf("const DONE_RE =");
    const j = APP_LONGRUN.indexOf("const st = {");
    const body = APP_LONGRUN.slice(i, j);
    const { sandbox } = load();
    vm.runInContext(body + "\nvar __done = hasDoneSignal;", sandbox);
    const hit = (t) => sandbox.__done(t);
    for (const t of [
      "改完了，两件事都落地并留了回归。",
      "已修复，冒烟 309 项全绿。",
      "根因已定位并修完，全部相关冒烟跑绿。",
      "任务完成，交付清单如下。",
      "全部完成。",
    ])
      ok(hit(t) === true, "认收工：「" + t.slice(0, 14) + "…」");
    for (const t of [
      "还有待办：下一步要做 B。",
      "本轮卡住了，需要你确认目标口径。",
      "结论未验证，稍后继续。",
      "Nothing to do yet — I am still reading the code.",
    ])
      ok(hit(t) === false, "不认收工：「" + t.slice(0, 14) + "…」");
    ok(hit("") === false, "空答复不算收工");
  }

  /* ============ [3d] 收工判据只看本轮答复：连续收工也一律就地停 ============ */
  console.log("\n[3d] 连续收工：每一步都就地停（不存在「说了完成还接着追」的组合）");
  {
    const s = sessWith(
      [{ content: "做 A", status: "active" }, { content: "做 B", status: "pending" }],
      "全部完成，交付如上。",
    );
    s._lrDoneStreak = 1; /* 上一轮也收工过一次（清单一直没动） */
    const c = load({ session: s });
    await c.sandbox.__round(s, "ok");
    ok(sendCount(c) === 0, "到空转闸不再发轮");
    ok(c.sandbox.LongRun.stop["as1"] === "目标已达成", "停止原因就是收工判停（判据只看本轮答复）");
  }

  /* ============ [4] 同一批问号原样没变 → 不再追（防来回拉扯） ============ */
  console.log("\n[4] 同一批「?」原样没变：停跑并说明，不反复追轮");
  {
    const s = sessWith(
      [{ content: "写回归", status: "unknown" }, { content: "新发现的收尾", status: "unknown" }],
      "还有一处要补。",
    );
    s._todoSyncTries = 1;
    s._todoSyncUnknownSet = ["新发现的收尾", "写回归"]; /* 与当前问号内容集合一致 */
    const c = load({ session: s });
    await c.sandbox.__round(s, "ok");
    ok(sendCount(c) === 0, "补过一轮、这批问号一个没变 → 不再追（模型上一轮已经表过态）");
    ok(c.sandbox.LongRun.stop["as1"] === "清单未收口（模型未确认这 2 项）", "停止原因写明未确认的条数");
  }

  /* ============ [5] 还没补过 / 换了新条目 → 仍在配额内继续补 ============ */
  console.log("\n[5] 配额内继续补并且走的是正常续跑口径");
  {
    /* 5a：换了新条目（模型改过清单）→ 旧记账作废，本批从零开始，补一轮 */
    const s = sessWith(
      [{ content: "写回归", status: "unknown" }, { content: "新发现的收尾", status: "unknown" }],
      "还有一处要补。",
    );
    s._todoSyncTries = 1;
    s._todoSyncUnknownSet = ["改 app-longrun.js", "写回归"];
    const c = load({ session: s });
    await c.sandbox.__round(s, "ok");
    ok(sendCount(c) === 1 && /同步任务清单/.test(c.calls.sends[0].text),
      "换了新条目 → 不算「已回答」，在配额内再补一轮同步");
    ok(s._todoSyncTries === 2, "配额按批重算（这一批补了 2 轮，到顶）");
    /* 5b：模型这一轮真写过 todo_write（agentApplyTodoWrite 已清记账）→ 常规续跑指令 */
    const s2 = sessWith([{ content: "还有一处要补", status: "pending" }], "继续。");
    const c2 = load({ session: s2 });
    await c2.sandbox.__round(s2, "ok");
    ok(sendCount(c2) === 1 && /自检判停/.test(c2.calls.sends[0].text) &&
      !/同步任务清单/.test(c2.calls.sends[0].text),
      "清单里只剩正常待办（无问号）→ 发常规「自检 + 续跑」指令，不再追清单同步");
  }

  /* ============ [6] 配额：同一批最多补 TODO_SYNC_MAX 轮 ============ */
  console.log("\n[6] 配额到顶：停下并说明补了几轮");
  {
    const s = sessWith([{ content: "做 A", status: "unknown" }], "嗯。");
    s._todoSyncTries = 2; /* TODO_SYNC_MAX = 2 */
    s._todoSyncUnknownSet = ["别的条目"]; /* 内容不同 → 走配额闸而不是「已回答」闸 */
    const c = load({ session: s });
    await c.sandbox.__round(s, "ok");
    ok(sendCount(c) === 0, "到配额不再补轮");
    ok(c.sandbox.LongRun.stop["as1"] === "清单未收口（已补 2 轮）", "停止原因写明「已补 2 轮」");
  }

  /* ============ [7] 不该补的情形：用户关掉 / 本轮出错 ============ */
  console.log("\n[7] 不该补轮的情形一律静默");
  {
    const s = sessWith([{ content: "做 A", status: "unknown" }], "…");
    const c = load({ session: s });
    c.sandbox.LongRun.setAuto("as1", false);
    c.calls.sends.length = 0;
    await c.sandbox.__round(s, "ok");
    ok(sendCount(c) === 0, "用户关掉自动续跑 → 不补轮");
    c.sandbox.LongRun.setAuto("as1", true);
    await c.sandbox.__round(s, "error");
    ok(sendCount(c) === 0 && c.sandbox.LongRun.stop["as1"] === "本轮出错，等你处置",
      "本轮出错 → 不补轮（等用户处置）");
  }

  /* ============ [8] 接线口径（宿主侧两处钩子，源码级） ============ */
  console.log("\n[8] 宿主接线：清单重写清记账 + 同步轮不注入任务流程");
  {
    ok(/agentTodoSyncAck\(st\)/.test(APP_ASSIST) && /function agentTodoSyncAck\(/.test(APP_ASSIST),
      "agentApplyTodoWrite 收到 todo_write 即清「清单同步」记账（新条目出问号不被误判成没回应）");
    ok(/const todoSyncMsg = !!opts\._todoSync/.test(APP_ASSIST) && /resumeRound \|\| todoSyncMsg/.test(APP_ASSIST),
      "清单同步轮不注入「任务流程」指令（否则模型会去重新输出一份计划块）");
    ok(/TODO_SYNC_MAX = 2/.test(APP_LONGRUN), "补轮有硬配额（TODO_SYNC_MAX = 2）");
  }

  /* ============ [9] i18n：新词条成对（真跑 I18n 切英文） ============ */
  console.log("\n[9] i18n（新词条中英成对 + 真跑）");
  {
    try {
      const I = require(path.join(ROOT, "renderer", "i18n.js"));
      const keys = [
        "清单里有未确认条目：已自动补一轮，让模型标清任务状态",
        "清单未收口（已补 ",
        "清单未收口（模型未确认这 ",
      ];
      const inTable = keys.filter((k) => read("renderer/i18n.js").indexOf('"' + k + '"') < 0);
      ok(inTable.length === 0, "词条都在表里" + (inTable.length ? "（缺：" + inTable.join(",") + "）" : ""));
      I.setLocale("en");
      const miss = keys.filter((k) => {
        const en = I.t(k);
        return !en || en === k;
      });
      ok(miss.length === 0, "切英文后都回英文" + (miss.length ? "（缺：" + miss.join(",") + "）" : ""));
    } catch (e) {
      ok(false, "i18n 真跑失败：" + ((e && e.message) || e));
    }
  }

  console.log("\n" + (fails ? "FAIL" : "PASS") + " — " + checks + " 项，失败 " + fails + " 项");
  process.exit(fails ? 1 : 0);
})();

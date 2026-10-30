/* 子代理运行表（本次需求）· window.MTNodeSubagent
 *
 * 症状：画布助手一边说「子代理已在后台生成画布。我会等它回报完成回执」，
 *       一边界面上、会话里都没有任何「有子代理正在跑」的线索。
 *
 * 成因（查证过的三条）：
 *   ① 引擎的 `subagent` 工具**天生异步** —— 调用立刻回 `started subagent <id>`，
 *      子任务在后台跑完再发一条结算通知（dsh-tool-subagent/README.zh.md）。
 *   ② 上游把 subagent.started / subagent.finished 作为**顶层通知方法**发，
 *      网关过去只认 session.event，两条通知被静默丢弃（收尾台账的「子代理 N」
 *      也因此恒为 0 —— 那个计数分支永远走不到）。
 *   ③ 更要命的是时序：SDK 的一次 run 以父会话 status=idle 收尾，订阅当场关；
 *      而模型说完「我会等它回报」这一轮就 idle 了 —— 子代理往往比父那一轮活得久。
 *
 * 所以网关侧（dsh/gateway/gateway.mjs 的 watchSubagentLifecycle）给每台 runtime 挂了
 * 一条跨 run 的常驻长订阅，帧一律走**全局通道**（reqId 空，见 preload 的 dshOnSubagent）。
 * 本模块就是渲染侧那张唯一的运行表：四个入口共用它 ——
 *   · 会话消息流里那张 subagent 工具卡（app-assist.js 的 dshToolDetailsEl）
 *   · 左栏会话行的「子代理 N」小徽标（app-assist.js 的 mkRow）
 *   · 左下角运行队列的一行（app.js 的 collectRunQueueAll / updateRunQueuePanel）
 *   · 画布助手栏输入框上方的状态条（app-assist.js 的 paintAssistSubagentStrip）
 *
 * 口径（拷问共识，别自行改）：
 *   · 每个子代理**各占一行**，序号按启动顺序（子代理 1 / 子代理 2），各自走秒；
 *   · 只显示已运行时长，不显示任务摘要、不提供跳进子会话；
 *   · 收到 subagent.finished 就地转「已完成 / 已失败 · 用时 X」，**不新增消息**；
 *   · 只在本次运行期间显示 —— 不落盘，重启 / 重载后历史工具卡维持现状；
 *   · 所有 dsh 会话通吃（画布助手 / 智能节点 / 开发节点 / 长任务）。
 *
 * 与其它模块的关系：这里只管状态与文案，不建结构性 UI；调用方按 typeof 取本模块。
 */
(function () {
  "use strict";

  /* 无宿主（纯函数测试 / 老壳）时也能安全取词条 */
  const T = (key, vars) =>
    typeof I18n !== "undefined" && I18n.t ? I18n.t(key, vars) : key;

  /** childSessionId → row
   *  row = { childSessionId, parentSessionId, owner, seq, startedAt, endedAt,
   *          status, stopReason, callId } */
  const rows = new Map();
  /** owner(渲染层 runKey / 宿主会话 id) → 已发过的最大序号（序号按会话自增） */
  const seqOf = new Map();
  /** 工具调用 callId → childSessionId（卡片按它认领自己那一行） */
  const callOf = new Map();
  /** 已认领但还没建行的 childSessionId（工具结果先到、started 帧后到的竞态） */
  const pendingCall = new Map();
  let ticker = 0;
  let wired = false;

  /* ── 时间与文案 ─────────────────────────────────────────────────────── */

  /* 走秒文案：1m32s / 42s / 2h05m（与询问窗里写在选项上的口径一致） */
  function fmtDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    if (h > 0) return h + "h" + String(m).padStart(2, "0") + "m";
    if (m > 0) return m + "m" + String(s).padStart(2, "0") + "s";
    return total + "s";
  }

  function stateOf(row) {
    if (!row) return "ended";
    if (!row.endedAt) return "running";
    return String(row.status || "") === "error" ? "error" : "ok";
  }

  function elapsedOf(row, now) {
    if (!row) return 0;
    if (!row.startedAt) return 0;
    return Math.max(0, (row.endedAt || now || Date.now()) - row.startedAt);
  }

  /* 一行 / 一个提示的正文（会话卡片、队列行、状态条、徽标悬浮共用这一份口径） */
  function labelOf(row, now) {
    if (!row) return "";
    const seq = T("子代理 ") + String(row.seq || 1);
    const st = stateOf(row);
    if (st === "running") {
      return seq + " " + T("运行中") + " · " + fmtDuration(elapsedOf(row, now));
    }
    const spent = row.startedAt ? " · " + T("用时 ") + fmtDuration(elapsedOf(row, now)) : "";
    return seq + " " + (st === "error" ? T("已失败") : T("已完成")) + spent;
  }

  /* 悬浮全文：说清「它是什么、为什么这一轮已经收尾了它还在跑、点哪里能停」 */
  function titleOf(row) {
    if (!row) return "";
    const lines = [labelOf(row)];
    const st = stateOf(row);
    if (st === "running") {
      lines.push(
        T(
          "子代理在后台跑：它一调用就立刻返回了，父这一轮可能已经收尾。跑完会自动转成「已完成」，不用等它。",
        ),
      );
    } else if (st === "error") {
      lines.push(T("失败原因：") + (row.stopReason || T("未提供")));
    } else if (row.stopReason) {
      lines.push(T("结束原因：") + row.stopReason);
    }
    return lines.filter(Boolean).join("\n");
  }

  /* ── 归属 ───────────────────────────────────────────────────────────── */

  /* 帧里带 sessionTag（= 渲染层的 runKey，如 "agent:<会话 id>"）时按它归属；
     没有就退到宿主会话 id；再没有就归到画布助手那条（与 app-assist.js 的兜底同源）。 */
  function ownerOf(data) {
    const d = data || {};
    const tag = String(d.sessionTag || "").trim();
    if (tag) return tag;
    const host = String(d.hostSessionId || "").trim();
    if (host) return "agent:" + host;
    return "assist";
  }

  function ownerOfHostSession(sessionId) {
    const sid = String(sessionId || "").trim();
    return sid ? "agent:" + sid : "assist";
  }

  /* ── 状态变更 ───────────────────────────────────────────────────────── */

  function ensureRow(data) {
    const id = String((data && data.childSessionId) || "").trim();
    if (!id) return null;
    let row = rows.get(id);
    if (row) return row;
    const owner = ownerOf(data);
    const seq = (seqOf.get(owner) || 0) + 1;
    seqOf.set(owner, seq);
    row = {
      childSessionId: id,
      parentSessionId: String((data && data.parentSessionId) || ""),
      owner,
      seq,
      startedAt: Number((data && data.at) || 0) || Date.now(),
      endedAt: 0,
      status: "",
      stopReason: "",
      callId: "",
    };
    rows.set(id, row);
    /* 工具结果先到过（把 callId 先记住了）：现在补上认领关系 */
    const callId = pendingCall.get(id);
    if (callId) {
      pendingCall.delete(id);
      row.callId = callId;
      callOf.set(callId, id);
    }
    return row;
  }

  /* 收到一帧 subagent（start / end）。幂等：重复帧不会多出一行。 */
  function applyFrame(data) {
    const d = data || {};
    if (!d.childSessionId) return;
    const id = String(d.childSessionId);
    if (d.phase === "start") {
      if (rows.has(id)) return;
      ensureRow(d);
      startTicker();
      notify();
      return;
    }
    /* 收尾帧：正常有对应行；没有（界面刚起 / started 帧丢了）就补一行已结束的，
       宁可只显示一句「已完成」，也不要让界面上凭空多出一条永远在跑的幻觉。 */
    let row = rows.get(id);
    if (!row) {
      row = ensureRow({ ...d, at: 0 });
      /* 开始时刻留空：不知道就别编，文案里也就不写「用时 …」 */
      if (row) row.startedAt = 0;
    }
    if (!row) return;
    row.endedAt = Number(d.at) || Date.now();
    row.status = String(d.status || "");
    row.stopReason = String(d.stopReason || "");
    syncEls();
    if (!hasRunning()) stopTicker();
    notify();
  }

  function hasRunning() {
    for (const row of rows.values()) if (!row.endedAt) return true;
    return false;
  }

  /* ── 查询 ───────────────────────────────────────────────────────────── */

  function rowsOf(owner) {
    const key = String(owner || "");
    const out = [];
    for (const row of rows.values()) if (row.owner === key) out.push(row);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  function rowsOfSession(sessionId) {
    return rowsOf(ownerOfHostSession(sessionId));
  }

  function runningRowsOf(owner) {
    return rowsOf(owner).filter((row) => !row.endedAt);
  }

  function runningRowsOfSession(sessionId) {
    return runningRowsOf(ownerOfHostSession(sessionId));
  }

  function runningAll() {
    const out = [];
    for (const row of rows.values()) if (!row.endedAt) out.push(row);
    out.sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq);
    return out;
  }

  /* 卡片认领：工具调用 → 它启动的那只子代理。
     callId 是首选（工具结果里的 `started subagent <id>` 由调用方解析好传进来）；
     也接受直接传工具记录，由这里从结果文本里兜底解析一次。 */
  function linkCall(callId, childSessionId) {
    const cid = String(callId || "").trim();
    const sid = String(childSessionId || "").trim();
    if (!cid || !sid) return null;
    callOf.set(cid, sid);
    const row = rows.get(sid);
    if (row) {
      row.callId = cid;
      return row;
    }
    pendingCall.set(sid, cid);
    return null;
  }

  /* "started subagent <id>" 是引擎 subagent 工具的固定回执（见 dsh-tool-subagent 的
     模型体验一节）；同族的 subagent_fork 也走同一句。取不到就返回空串。 */
  const STARTED_RE = /started\s+subagent\s+([A-Za-z0-9._:\-]+)/i;
  function childIdOfResultText(text) {
    const m = STARTED_RE.exec(String(text || ""));
    return m ? m[1] : "";
  }

  function rowOfCall(callId) {
    const cid = String(callId || "");
    if (!cid) return null;
    const sid = callOf.get(cid);
    return sid ? rows.get(sid) || null : null;
  }

  /* 工具记录 → 它那一行（没有就 null）。用 resultText 由调用方给（各处的取文本口径不同）。 */
  function rowOfToolCall(t, resultText) {
    if (!t) return null;
    const key = String(t.callId || "") || (
      (t.name || "") + ":" + (t.at || "")
    );
    let row = rowOfCall(key);
    if (row) return row;
    const sid = childIdOfResultText(resultText);
    if (!sid) return null;
    return linkCall(key, sid);
  }

  /* ── 中断 ───────────────────────────────────────────────────────────── */

  function interrupt(childSessionId) {
    const id = String(childSessionId || "").trim();
    if (!id) return Promise.resolve({ ok: false, reason: "invalid_params" });
    const row = rows.get(id);
    const parentSessionId = row ? String(row.parentSessionId || "") : "";
    const api = typeof window !== "undefined" ? window.api : null;
    if (!api || typeof api.dshInterruptSubagent !== "function")
      return Promise.resolve({ ok: false, reason: "unsupported" });
    return Promise.resolve(
      api.dshInterruptSubagent({ parentSessionId, childSessionId: id }),
    ).catch((err) => ({ ok: false, reason: "error", error: (err && err.message) || String(err) }));
  }

  /* ── DOM 同步（走秒 + 原地转态）─────────────────────────────────────────
     各入口把自己那块的状态节点打上 data-sub-*，这里每秒只改文本与状态类，
     绝不重建结构：会话流式期间重建会打断滚动 / 展开态。 */

  function syncEls() {
    if (typeof document === "undefined" || !document.querySelectorAll) return;
    const now = Date.now();
    /* ① 状态文字（卡片 / 队列行 / 状态条共用一个 data 属性） */
    for (const el of document.querySelectorAll("[data-sub-state]")) {
      const row = rows.get(el.getAttribute("data-sub-state"));
      if (!row) continue;
      const st = stateOf(row);
      const text = labelOf(row, now);
      if (el.textContent !== text) el.textContent = text;
      el.title = titleOf(row);
      /* 只换状态类，不动别的类（运行队列那处同一个节点上还挂着 .rq-sub） */
      el.classList.add("dsh-sub-state");
      el.classList.remove("st-running", "st-ok", "st-error");
      el.classList.add("st-" + st);
    }
    /* ② 卡片壳与药丸（◌ = 还在跑 / 🔧 = 已收尾，与工具卡其它状态同一套符号） */
    for (const el of document.querySelectorAll("[data-sub-card]")) {
      const row = rows.get(el.getAttribute("data-sub-card"));
      const st = row ? stateOf(row) : "ok";
      el.dataset.state = st;
      el.classList.toggle("st-running", st === "running");
      el.classList.toggle("st-ok", st === "ok");
      el.classList.toggle("st-error", st === "error");
      const chip = el.querySelector("[data-sub-chip]");
      if (chip && chip.dataset.subLabel != null) {
        const prefix = st === "running" ? "◌ " : "🔧 ";
        const next = prefix + chip.dataset.subLabel;
        if (chip.textContent !== next) chip.textContent = next;
      }
    }
  }

  function startTicker() {
    if (ticker || typeof setInterval !== "function") return;
    /* 1s：走秒要跟得上「它真的在动」这条直觉；只在有子代理在跑时存在 */
    ticker = setInterval(() => {
      syncEls();
      if (!hasRunning()) stopTicker();
      else wake("tick");
    }, 1000);
  }

  function stopTicker() {
    if (!ticker) return;
    try {
      clearInterval(ticker);
    } catch (_) {}
    ticker = 0;
  }

  /* ── 结构变化 → 四个入口各自重画自己那一块 ─────────────────────────────
     用 typeof 取全局（都是 app-assist.js / app.js 里的顶层函数）：
     · 不走 renderAgentSession（整条会话重建会打断流式滚动与展开态）；
     · 卡片的状态文字由上面的 syncEls 就地改，这里只让「行数变了」的地方重画。
     wake('tick') 是给需要连续走秒的面板（运行队列本身有 2s 心跳）补一拍的机会。 */
  function wake(kind) {
    const fns =
      kind === "tick"
        ? ["paintAssistSubagentStrip"]
        : [
            "renderAgentSessionSidebar",
            "paintAssistSubagentStrip",
            "updateRunQueuePanel",
          ];
    for (const name of fns) {
      try {
        const fn = typeof window !== "undefined" ? window[name] : null;
        if (typeof fn === "function") fn();
      } catch (_) {}
    }
  }

  function notify() {
    syncEls();
    wake("structure");
  }

  /* ── 接线：全局帧订阅只装一次 ─────────────────────────────────────────── */

  function wire() {
    if (wired) return;
    wired = true;
    const api = typeof window !== "undefined" ? window.api : null;
    if (!api || typeof api.dshOnSubagent !== "function") return;
    try {
      api.dshOnSubagent((data) => applyFrame(data));
    } catch (_) {}
  }

  window.MTNodeSubagent = {
    /* 接线（app-boot / app.js 启动时调一次；重复调用安全） */
    wire,
    /* 帧入口（也供测试直接喂） */
    applyFrame,
    /* 查询 */
    rowsOfSession,
    runningRowsOfSession,
    runningRowsOf,
    runningAll,
    rowOfToolCall,
    linkCall,
    childIdOfResultText,
    /* 文案 */
    labelOf,
    titleOf,
    stateOf,
    fmtDuration,
    /* 动作 */
    interrupt,
    /* 测试 / 自检用：清空（应用里没有调用点） */
    _reset() {
      rows.clear();
      seqOf.clear();
      callOf.clear();
      pendingCall.clear();
      stopTicker();
    },
  };
})();

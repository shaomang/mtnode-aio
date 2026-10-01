/* 真窗口复核：会话「轨迹」视图与「思考」显示（连本机已开的应用的远程调试端口）
 *
 *   node test/_probe-trajectory-live.js            # 默认端口 9333
 *   node test/_probe-trajectory-live.js 9222       # 指定端口
 *
 * 前置：应用要带远程调试端口启动（开发态常用写法）
 *   electron . --remote-debugging-port=9333
 *
 * 为什么要有它：轨迹视图与思考块这两处 bug 都属于「界面不出东西但控制台不报错」的形态 ——
 * 静态冒烟只能钉接线，钉不住「真跑起来一帧都没画」。这支探针**只读**地在真渲染层里
 * 驱动两次同步并核对 DOM（不改任何用户数据；切视图只在内存里，退出前会还原原值）。
 *
 * 判据（两条都对应本次修的 bug）：
 *   [1] 轨迹视图：标签栏「对话 / 轨迹」出得来；切到轨迹后主区显形、对话列表让位，
 *       历史会话能画出记录表行（老 bug：模块取会话写 window.S → 永远 null → 标签恒 hidden）；
 *   [2] 思考显示：工具调用**不被任何收纳体折走** —— 历史消息里的思考块与工具卡都直接在
 *       消息正文里（本轮需求「不应当进行任何收纳」，原先那行「✓ 已完成」折叠条已撤），
 *       且每一项左侧都挂着自己的时刻栏（.dsh-seg-time）。
 *
 * 零依赖：Node ≥22 内置 fetch / WebSocket。
 */
"use strict";

const PORT = String(process.argv[2] || 9333);

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params) {
          const mid = ++id;
          return new Promise((res) => {
            pending.set(mid, res);
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error("WebSocket 连接失败：" + (e && e.message)));
    ws.onmessage = (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
  });
}

const EXPR = `(() => {
  const out = {};
  const st = typeof agentSessionById === "function"
    ? agentSessionById(S.agentActiveId)
    : (S.agentSessions || [])[0] || null;
  out.sid = st && st.id;
  out.tabs = !!document.getElementById("agentViewTabs");
  out.trajApi = typeof (window.MTNodeTrajectory && window.MTNodeTrajectory.sync);
  if (!st || !out.trajApi) return JSON.stringify(out);
  /* 原值记下来，跑完还原（探针不改用户数据） */
  out.wasTraj = st.trajView || "";
  /* [1] 切到轨迹视图 */
  st.trajView = "trace";
  window.MTNodeTrajectory.sync();
  const main = document.getElementById("agentTraceMain");
  out.traceHidden = main.hidden;
  out.rows = main.querySelectorAll(".dsh-trace-row").length;
  out.emptyState = !!main.querySelector(".dsh-trace-empty");
  out.reasonEmpty = out.rows ? "" : String((main.querySelector(".dsh-trace-empty") || {}).textContent || "");
  out.listDisplay = getComputedStyle(document.getElementById("agentList")).display;
  out.foot = String((main.querySelector(".dsh-trace-foot") || {}).textContent || "");
  /* [2] 思考块在默认档下必须留在折叠行之外 */
  out.think = null;
  const hist = (S.agentSessions || []).find(
    (s) => (s.messages || []).some((m) => m.role === "assistant" && Array.isArray(m.segments) && m.segments.some((x) => x.k === "think")),
  );
  if (hist) {
    const m = hist.messages.find((x) => x.role === "assistant" && Array.isArray(x.segments) && x.segments.some((y) => y.k === "think"));
    const el = dshMsgBlock(m, hist.id, 0, {});
    const thinks = Array.from(el.querySelectorAll(".dsh-seg-think"));
    const folds = el.querySelectorAll(".dsh-turn-process");
    out.think = {
      policy: dshPolicyOfView(dshTranscriptViewOfSessionId(hist.id)),
      count: thinks.length,
      /* 收纳体一个都不该有（本轮需求：工具调用不收纳） */
      folds: folds.length,
      /* 每一项左侧的时刻栏（思考 / 正文 / 工具 / 注入都算） */
      segTimes: el.querySelectorAll(".dsh-seg-time").length,
      segsWithTime: el.querySelectorAll(".dsh-seg-has-time").length,
      segs: el.querySelectorAll(".dsh-seg").length,
    };
  }
  st.trajView = out.wasTraj;
  window.MTNodeTrajectory.sync();
  /* [3] 本次需求 · 「显示思考」关掉时轨迹不许跟着空：
       会话侧那枚开关只做**会话视图的渲染隐藏**（思考段不建 DOM），轨迹是完整过程记录 ——
       关掉之后思考行照旧按行出现，工具调用行、行数一个都不少。
       探针按会话对象上的字段临时翻转（跑完还原），不改任何落盘数据。 */
  out.thinkOff = null;
  const off = (S.agentSessions || []).find((s) =>
    (s.messages || []).some((m) => m.role === "assistant" && Array.isArray(m.segments)),
  );
  if (off) {
    const wasShow = off.showThink;
    const hist = (off.messages || []).find(
      (m) => m.role === "assistant" && Array.isArray(m.segments),
    );
    /* 会话侧对照：**开** 的时候思考块建 DOM，关掉后同一段不建 DOM（只做渲染隐藏） */
    const convThink = () => {
      if (!hist || typeof dshMsgBlock !== "function") return null;
      try {
        return dshMsgBlock(hist, off.id, 0, {}).querySelectorAll(".dsh-seg-think").length;
      } catch {
        return null;
      }
    };
    if (wasShow === undefined) off.showThink = true;
    const convOn = convThink();
    off.showThink = false;
    st.trajView = "trace";
    window.MTNodeTrajectory.sync();
    const main2 = document.getElementById("agentTraceMain");
    const rows2 = main2 ? main2.querySelectorAll(".dsh-trace-row") : [];
    let thinkRows = 0;
    for (const r of rows2) if (r.className.indexOf("t-think") >= 0) thinkRows++;
    let totalThink = 0;
    for (const m of off.messages || [])
      for (const s of Array.isArray(m.segments) ? m.segments : [])
        if (s && s.k === "think" && String(s.text || "").trim()) totalThink++;
    out.thinkOff = {
      sid: off.id,
      rows: rows2.length,
      thinkRows,
      /* 会话该会话历史里的思考段总数（轨迹行数应当与它对齐，不是 0） */
      totalThink,
      emptyState: !!(main2 && main2.querySelector(".dsh-trace-empty")),
      convThinkDomOn: convOn,
      convThinkDomOff: convThink(),
    };
    /* 还原 */
    if (wasShow === undefined) delete off.showThink;
    else off.showThink = wasShow;
    st.trajView = out.wasTraj;
    window.MTNodeTrajectory.sync();
  }
  out.restored = true;
  return JSON.stringify(out);
})()`;

(async () => {
  let list;
  try {
    list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  } catch (e) {
    console.error("连不上远程调试端口 " + PORT + "（应用要用 --remote-debugging-port=" + PORT + " 启动）");
    process.exit(2);
  }
  const page = list.find((t) => t.type === "page" && /renderer\/index\.html/.test(t.url || ""));
  if (!page) {
    console.error("没找到渲染层页面（列表里只有：" + list.map((t) => t.url).join(", ") + "）");
    process.exit(2);
  }
  const c = await cdp(page.webSocketDebuggerUrl);
  const r = await c.send("Runtime.evaluate", {
    expression: EXPR,
    returnByValue: true,
    awaitPromise: true,
  });
  /* CDP 回帧包的形态随版本略有出入：result 可能就在顶层，也可能被再包一层 */
  const res = r && r.result && r.result.result ? r.result.result : (r && r.result) || r || {};
  c.close();
  if (res.exceptionDetails) {
    console.error("渲染层抛错：" + JSON.stringify(res.exceptionDetails).slice(0, 400));
    process.exit(1);
  }
  let data;
  try {
    /* 渲染层回的是 JSON 串；CDP 也可能直接给对象（取决于版本），两种都吃 */
    data = typeof res.value === "string" ? JSON.parse(res.value) : res.value;
  } catch (e) {
    console.error(
      "拿不到结构化结果（" + ((e && e.message) || e) + "）：" + JSON.stringify(res).slice(0, 2000),
    );
    process.exit(1);
  }
  if (!data || typeof data !== "object") {
    console.error("渲染层没回结果：" + JSON.stringify(res).slice(0, 2000));
    process.exit(1);
  }
  const lines = [];
  let fails = 0;
  const ok = (cond, label) => {
    lines.push((cond ? "  ok    " : "  FAIL  ") + label);
    if (!cond) fails++;
  };
  lines.push("会话 id = " + data.sid + "（探针只读；跑完已还原原视图）");
  ok(data.tabs, "[1] 会话头部的「对话 / 轨迹」标签栏在位");
  ok(data.trajApi, "[1] window.MTNodeTrajectory.sync 可用（模块装上了）");
  ok(data.traceHidden === false, "[1] 切到轨迹视图 → 主区显形（老 bug：恒 hidden）");
  ok(data.listDisplay === "none", "[1] 轨迹视图下对话列表让位");
  ok(
    data.rows > 0 || data.emptyState,
    "[1] 主区有内容（记录表 " + data.rows + " 行" + (data.emptyState ? " / 空态：" + data.reasonEmpty : "") + "）",
  );
  if (data.think) {
    ok(data.think.policy.showThink === true, "[2] 默认档（" + data.think.policy.view + "）显示思考块");
    ok(
      data.think.count === 0 || data.think.insideFold === 0,
      "[2] 思考块不在「已完成」折叠行里（共 " +
        data.think.count +
        " 段，被折进去 " +
        data.think.insideFold +
        " 段）",
    );
  } else {
    lines.push("  --    [2] 这台数据里没有带思考段的历史消息，跳过（换个有思考的会话再跑）");
  }
  /* [3] 本次需求：「显示思考」关掉 ≠ 轨迹跟着空 */
  if (data.thinkOff) {
    const t = data.thinkOff;
    ok(!t.emptyState, "[3] 会话「显示思考」关掉 → 轨迹不是空态（会话 " + t.sid + "）");
    ok(
      t.rows > 0,
      "[3] 关掉后轨迹照旧有记录行（共 " + t.rows + " 行，其中思考行 " + t.thinkRows + " 行）",
    );
    ok(
      t.totalThink === 0 || t.thinkRows >= t.totalThink,
      "[3] 会话存档里的思考段 " +
        t.totalThink +
        " 段全部成行（轨迹行 " +
        t.thinkRows +
        "，与开关无关）",
    );
    ok(
      t.convThinkDomOn === null || t.convThinkDomOn > 0,
      "[3] 开关打开时会话里思考块建 DOM（对照值 " + t.convThinkDomOn + "）",
    );
    ok(
      t.convThinkDomOff === 0,
      "[3] 同一条判据只在会话侧生效（关掉后对话里思考块 DOM 数 = " + t.convThinkDomOff + "）",
    );
  } else {
    lines.push("  --    [3] 这台数据里没有带段快照的会话，跳过（换个跑过一轮的会话再跑）");
  }
  console.log(lines.join("\n"));
  console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 真窗口复核通过");
  process.exit(fails ? 1 : 0);
})();

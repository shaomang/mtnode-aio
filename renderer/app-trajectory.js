/* 会话 · 运行轨迹视图（renderer/app-trajectory.js + css/dsh-tokens.css 的 .dsh-trace-*）
 *
 * 定位：会话右栏（#agentPane 的第三栏）里与「浏览器活动」并列的一个 View 标签。它把本轮
 * 会话已经攒下的**轨迹段**（renderer/app-agent.js 的 agentChatSegItems / agentTraceItems，
 * 段模型见 app-db.js 的 runTrace）铺成 dsh 桌面版那套「轨迹列表 + 工具调用可展开详情」，
 * 并提供轨迹 ↔ 对话双向定位（点一行 → 对话区那一行闪一下；对话区点轨迹段 → 本视图选中）。
 *
 * 数据来源全是**已有数据**，不新增会话接口、不新增落盘：
 *   · agentChatSegItems(st)  = 本条会话的段列表 [{seg, items}]（历史 + 本轮 live）
 *   · agentTraceItems(rk)    = "agent:<id>" 的实时轨迹段
 * 两者都只读，本模块不写任何状态回 S（除自己面板的显隐与滚动）。
 *
 * 显隐口径：右栏本身由浏览器活动面板（#baPanel）掌隐显；本面板 tuck 在它下面，只在
 * 「右栏可见 且 设置 · 开发者工具开着 且 本会话"有轨迹」时出现。设置项 developerTools
 * 默认开（见 app-boot.js 的 S.config.dsh.developerTools 与 app-settings.js 的开关）。
 *
 * 自包含：不引入框架，不碰 app-browser.js 内部；只有一个 window.MTNodeTrajectory 出口。
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);

  /** 开发者工具开着？（缺配置 = 默认开，与 app-boot.js 的缺省合并同口径） */
  function devOn() {
    try {
      const d = (window.S && S.config && S.config.dsh) || {};
      return d.developerTools !== false;
    } catch {
      return true;
    }
  }

  function activeSessionId() {
    try {
      const st =
        (window.S && S.agentSessions && S.agentActive != null && S.agentSessions[S.agentActive]) ||
        null;
      return st && st.id ? String(st.id) : "";
    } catch {
      return "";
    }
  }

  /* 段列表：优先本轮实时轨迹（agentTraceItems，平铺的 items 数组），没有（或为空）就回落到
     会话已渲染的段（agentChatSegItems，形状一致）。两者都归一成 [{k,text,step,callId}]。
     两种形状都收：平铺 items（{k,text,…}）与分组（{seg, items:[…]}）—— 上层换形状不影响这里。 */
  function collectSegments(sid) {
    const rk = "agent:" + sid;
    const norm = (rows) => {
      const out = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row) continue;
        const inner = Array.isArray(row.items) ? row.items : [row];
        for (const it of inner) {
          if (!it) continue;
          const k = String(it.k || it.kind || "");
          if (!k) continue;
          out.push({
            k,
            text: String(it.text == null ? "" : it.text),
            step: it.step,
            callId: it.callId == null ? "" : String(it.callId),
          });
        }
      }
      return out;
    };
    try {
      if (typeof agentTraceItems === "function") {
        const live = norm(agentTraceItems(rk));
        if (live.length) return live;
      }
    } catch {
      /* 运行时形态变了就回落 */
    }
    try {
      if (typeof agentChatSegItems === "function") return norm(agentChatSegItems({ id: sid, running: true }));
    } catch {
      /* 同上 */
    }
    return [];
  }

  const KIND_LABEL = { think: "思考", say: "正文", tool: "工具", err: "错误" };

  /* 工具卡：把 callId 对应的一次调用原样摊开（只读）。渲染层已有数据里，工具段文本就是
     那一步的摘要（工具名 / 参数摘要），这里展示它 + 调用序号；拿不到更细的字段就不编。 */
  function toolDetailText(seg, index) {
    const head = "#" + (index + 1) + (seg.callId ? "  callId=" + seg.callId : "");
    const body = seg.text ? "\n" + seg.text : "\n（该步没有可展示的明细）";
    return head + body;
  }

  let panel = null;
  let listEl = null;
  let footEl = null;
  let selected = -1;
  let lastSid = "";

  function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    const host = $("#agentPane");
    if (!host) return null;
    panel = document.createElement("aside");
    panel.className = "dsh-trace-col";
    panel.id = "trajPanel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "运行轨迹");

    const tabs = document.createElement("div");
    tabs.className = "dsh-view-tabs";
    const tabTrace = document.createElement("button");
    tabTrace.type = "button";
    tabTrace.className = "dsh-view-tab on";
    tabTrace.textContent = "轨迹";
    const tabBrowser = document.createElement("button");
    tabBrowser.type = "button";
    tabBrowser.className = "dsh-view-tab";
    tabBrowser.textContent = "浏览器活动";
    tabBrowser.onclick = () => {
      /* 「浏览器活动」标签：收起本视图，把第三栏还给浏览器活动面板。
         右栏本身还在（.agent-pane.ba-open 未变），只是这一格换回它。 */
      if (panel) panel.hidden = true;
      if (panel) panel.dataset.userPicked = "browser";
      const chip = $("#agentBrowserChip");
      /* 右栏整条收着时，本标签等于「打开第三栏」——借它那枚入口，不自己复制状态机。 */
      const pane = $("#agentPane");
      if (pane && !pane.classList.contains("ba-open") && chip && typeof chip.click === "function") chip.click();
    };
    tabs.appendChild(tabTrace);
    tabs.appendChild(tabBrowser);
    panel.appendChild(tabs);

    listEl = document.createElement("div");
    listEl.className = "dsh-trace-list";
    panel.appendChild(listEl);

    footEl = document.createElement("div");
    footEl.className = "dsh-trace-foot";
    panel.appendChild(footEl);

    /* 轨迹 → 对话：点一行定位到对话区对应那条消息（存在才跳；跳不到就只选中）。 */
    listEl.addEventListener("click", (ev) => {
      const row = ev.target && ev.target.closest ? ev.target.closest(".dsh-trace-row") : null;
      if (!row || !listEl.contains(row)) return;
      const idx = Number(row.dataset.idx);
      if (Number.isFinite(idx)) select(idx, true);
    });

    /* 对话 → 轨迹：对话区点某个轨迹段（.dsh-seg / [data-seg]），本视图跟着选中。
       捕获阶段挂一次，避免与对话区自己的点击处理抢；找不到对应行就静默。 */
    document.addEventListener(
      "click",
      (ev) => {
        if (!panel || panel.hidden) return;
        const seg = ev.target && ev.target.closest ? ev.target.closest("[data-seg-idx],[data-seg]") : null;
        if (!seg || !listEl || listEl.contains(seg)) return;
        const idx = Number(seg.dataset.segIdx != null ? seg.dataset.segIdx : seg.dataset.seg);
        if (Number.isFinite(idx)) select(idx, false);
      },
      true,
    );

    host.appendChild(panel);
    return panel;
  }

  /** 选中第 idx 步；jump=true 时同时滚动对话区到对应消息并闪一下。 */
  function select(idx, jump) {
    if (!listEl) return;
    selected = idx;
    for (const row of listEl.children) {
      const on = Number(row.dataset.idx) === idx;
      row.classList.toggle("on", on);
      if (on && jump) {
        try {
          row.scrollIntoView({ block: "nearest" });
        } catch {
          /* 老 Chromium 没有平滑参数也照样滚 */
        }
      }
    }
    if (!jump) return;
    /* 对话区里的段元素用自己的 dataset.segIdx 编号（app-assist.js 的段渲染），
       这里顺着它走，不另发一套编号。 */
    const seg =
      document.querySelector('[data-seg-idx="' + idx + '"]') ||
      document.querySelector('[data-seg="' + idx + '"]');
    if (!seg) return;
    try {
      seg.scrollIntoView({ block: "center" });
    } catch {
      /* ignore */
    }
    seg.classList.remove("dsh-flash");
    /* 重启动画：读一次 offsetWidth 触发回流 */
    void seg.offsetWidth;
    seg.classList.add("dsh-flash");
    setTimeout(() => seg.classList.remove("dsh-flash"), 1000);
  }

  function render(sid) {
    if (!listEl) return;
    listEl.textContent = "";
    const segs = collectSegments(sid);
    lastSid = sid;
    if (!segs.length) {
      const empty = document.createElement("div");
      empty.className = "dsh-trace-empty";
      empty.textContent = "这条会话还没有可看的轨迹（跑一轮之后再看）";
      listEl.appendChild(empty);
      if (footEl) footEl.textContent = "";
      return;
    }
    let tools = 0;
    segs.forEach((seg, i) => {
      const row = document.createElement("div");
      row.className = "dsh-trace-row t-" + (KIND_LABEL[seg.k] ? seg.k : "say");
      row.dataset.idx = String(i);
      if (seg.step != null) row.dataset.step = String(seg.step);

      const kind = document.createElement("span");
      kind.className = "dsh-trace-kind";
      kind.textContent = KIND_LABEL[seg.k] || seg.k;
      row.appendChild(kind);

      const body = document.createElement("div");
      body.className = "dsh-trace-body";
      if (seg.k === "tool") {
        tools++;
        /* 工具调用：收起时一行摘要，展开后是等宽明细（dsh 桌面版同款可展开详情）。 */
        const sum = document.createElement("div");
        sum.textContent = seg.text || "（工具调用）";
        body.appendChild(sum);
        const det = document.createElement("details");
        det.className = "dsh-trace-detail";
        const sm = document.createElement("summary");
        sm.textContent = "详情";
        det.appendChild(sm);
        const pre = document.createElement("pre");
        pre.textContent = toolDetailText(seg, i);
        det.appendChild(pre);
        body.appendChild(det);
      } else if (seg.k === "err") {
        const det = document.createElement("details");
        det.className = "dsh-trace-detail err";
        det.open = true;
        const sm = document.createElement("summary");
        sm.textContent = seg.text ? "错误" : "错误（无正文）";
        det.appendChild(sm);
        const pre = document.createElement("pre");
        pre.textContent = seg.text || "";
        det.appendChild(pre);
        body.appendChild(det);
      } else {
        body.textContent = seg.text || "（空段）";
      }
      row.appendChild(body);
      listEl.appendChild(row);
    });
    if (footEl) {
      footEl.textContent = segs.length + " 步 · 工具调用 " + tools + " 次";
    }
    if (selected >= 0 && selected < segs.length) select(selected, false);
  }

  /** 按当前状态刷新显隐与内容（幂等；外部只要调它）。 */
  function sync() {
    const sid = activeSessionId();
    const pane = $("#agentPane");
    const colOpen = !!(pane && pane.classList.contains("ba-open"));
    if (!devOn() || !sid || !colOpen || !collectSegments(sid).length) {
      if (panel && panel.isConnected) panel.hidden = true;
      return;
    }
    const p = ensurePanel();
    if (!p) return;
    /* 用户在这条栏里点过「浏览器活动」（本视图已收）→ 尊重它，别再抢回来；
       整条右栏关掉再开时重新按默认（轨迹）显示。 */
    if (p.hidden && p.dataset.userPicked === "browser") return;
    p.hidden = false;
    if (sid !== lastSid || !listEl.children.length) render(sid);
  }

  window.MTNodeTrajectory = { sync, render, devOn };

  /* 会话重画 / 切会话 / 运行推进都会走到这里：挂在 DOMContentLoaded 后低频轮询 +
     点击与键盘无关（轮询只在面板可见或需要判显隐时做极轻的判断）。 */
  function boot() {
    setInterval(sync, 1500);
    sync();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

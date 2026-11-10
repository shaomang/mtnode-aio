"use strict";
/* ============================================================
 * renderer/app-assist-isolation.js — 画布主窗一侧的「隔离通道」接线（任务 8/8）
 *
 * 它把三股流在三处**旧源**里发布进一份共享状态仓（renderer/app-assist-state.js），
 * 再由主进程转发给承载它们的那只独立渲染进程（assist-isolation.js）。
 *
 * 开关：config.json 的 assist.isolation = off|on|window（缺省 off）
 *   off    → 本文件除了问一次状态，什么都不做（一次 IPC，之后零成本）；
 *   on     → **接管档**：主进程把 WebContentsView 贴在会话区（#agentPane / #assistPane）上，
 *            主窗这一侧不再绘制这三股流（会话区 / 活动流 / 文件树）—— 绘制唯一出口是
 *            隔离页。状态更新（S / BA / SF）与落盘一字不动，只停「画」；
 *   window → 并存档：另起一只 BrowserWindow（同一份页面，最稳的排查档），主窗照旧自己画。
 *
 * 接管闸（本次需求 · 从「并存」改成「接管」）：
 *   · window.assistIsoHold() = 「on 档 + 宿主在位 + 页面已就绪 + 没崩」；
 *   · renderer/app-assist.js 的渲染入口自己问这一句（agentPaintHeld），on 档不画；
 *   · 活动流（app-browser.js 的 BA.render）与文件树（app-sidebar-files.js 的 sfRender）
 *     不归本文件所有，所以在那里就地包一层门（gateRender）：闸开着只跳过「画」，
 *     事件处理 / 状态更新 / 落库 / 发布一律照旧；
 *   · 闸是**可逆**的：切回 off（或隔离进程崩了、被关了）→ 摘掉门 + 立刻补画一帧，
 *     主窗马上回到原样；off 档这些门一个都不在（一次多余调用都不发生）。
 *
 * 隔离页的动作（切会话 / 清活动 / 开文件 / 刷新文件树）从主进程转回来，全部转调**今天
 * 就在用的那些函数**（agentSelectSession / openFilePeek / MTNodeSideFiles.refresh）：
 * 行为与用户在主窗里点同一处完全一样，不存在第二套语义。
 * ============================================================ */
(function () {
  const api = window.api || {};
  const state = window.MTAssistState;
  if (!api || typeof api.assistIsoStatus !== "function" || !state) return;

  const store = state.createStore();
  const iso = {
    mode: "off", /* off | on | window（真源 = config.json） */
    hosting: false,
    ready: false,
    hostDown: false,
    lastError: "",
  };

  /* ── 接管闸：on 档且宿主在位、页面已就绪 → 主窗不画这三股流 ────────────────
     为什么要四个条件：宿主没起来 / 页面还没加载完（或加载失败）/ 刚崩掉时隔离页是空的，
     这时候还停画主窗就等于「界面全空」；所以闸只认「on 档 + 宿主在位 + 已就绪 + 没崩」，
     任何一条不成立立刻恢复绘制。window 档是排查档（两只窗并存），主窗照旧自己画。 */
  function holdOn() {
    return iso.mode === "on" && iso.hosting && iso.ready && !iso.hostDown;
  }
  /* 给 renderer/app-assist.js 的渲染入口问的那一句（没有这个函数 = 照旧画）。 */
  window.assistIsoHold = holdOn;
  let heldLast = false;

  /* ── 发布（节流：会话列表 220ms、文件树 320ms、矩形按帧） ── */
  let sessionTimer = 0;
  let treeTimer = 0;
  let boundsRaf = 0;
  let snapshotSent = false;

  function send(patch) {
    if (!patch || iso.mode === "off" || iso.hostDown) return;
    if (typeof api.assistIsoState !== "function") return;
    try {
      void api.assistIsoState({ type: "patch", patch: patch }).catch(() => {});
    } catch {}
  }

  /* 会话列表：从 S.agentSessions 收成隔离页要画的那几格（正文不进来）。 */
  function sessionRows() {
    const list = typeof agentSessions === "function" ? agentSessions() : [];
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const s of list) {
      if (!s || !s.id) continue;
      let canvas = "";
      try {
        if (typeof sessionCanvasName === "function") canvas = String(sessionCanvasName(s) || "");
      } catch {}
      let running = !!s.running;
      try {
        if (typeof sessionBusyForUi === "function") running = !!sessionBusyForUi(s);
        else if (typeof sessionIsRunning === "function") running = !!sessionIsRunning(s);
      } catch {}
      let lastAt = Number(s.updatedAt) || 0;
      try {
        if (typeof sessionLastAt === "function") lastAt = Number(sessionLastAt(s)) || lastAt;
      } catch {}
      out.push({
        id: String(s.id),
        title: String(s.title || ""),
        canvas: canvas,
        assist: !!s.assist,
        running: running,
        archived: !!s.archived,
        lastAt: lastAt,
        msgCount: Array.isArray(s.msgs) ? s.msgs.length : 0,
      });
    }
    return out;
  }

  function publishSessions(force) {
    if (iso.mode === "off" || iso.hostDown) return;
    const active = typeof activeAgentId === "function" ? String(activeAgentId() || "") : "";
    const patch = store.setSessions(sessionRows(), active);
    if (patch || force) {
      if (force && !patch) send({ kind: "sessions", data: { rows: store.state.sessions.rows, currentId: active } });
      else send(patchToMsg(patch));
    }
  }
  function patchToMsg(patch) {
    const s = store.state;
    if (patch.kind === "sessions") return { kind: "sessions", rev: patch.rev, data: { rows: s.sessions.rows, currentId: s.sessions.currentId } };
    if (patch.kind === "tree") return { kind: "tree", rev: patch.rev, data: treeData() };
    if (patch.kind === "stream") {
      /* 会话流**只发增量**（尾巴段 + 变过的那一两段），绝不整表重发：
         整份 items 只在首次 / 换会话 / 重连对齐那一条（reset）里出现一次。
         自上次以来流没变（streamDelta 回 null）就一条都不发。 */
      const delta = store.streamDelta();
      if (!delta) return null;
      return { kind: "stream", rev: patch.rev, data: delta };
    }
    return { kind: patch.kind, rev: patch.rev, data: {} };
  }
  function treeData() {
    const t = store.state.tree;
    return {
      root: t.root,
      rootKind: t.rootKind,
      dirs: Object.keys(t.dirs).map((dir) => ({
        dir: dir,
        entries: t.dirs[dir].entries,
        error: t.dirs[dir].error,
        exists: t.dirs[dir].exists,
        at: t.dirs[dir].at,
      })),
      loading: Object.keys(t.loading),
    };
  }

  function publishSessionsSoon() {
    if (sessionTimer) return;
    sessionTimer = setTimeout(() => {
      sessionTimer = 0;
      try {
        publishSessions(false);
      } catch (e) {
        iso.lastError = String((e && e.message) || e);
      }
    }, 220);
  }

  /* 文件树根：SF.state.root（画布工作目录 / 用户另选目录）+ 它的工作区根公布给主进程。 */
  function publishTreeSoon() {
    if (treeTimer) return;
    treeTimer = setTimeout(() => {
      treeTimer = 0;
      try {
        publishTree();
      } catch (e) {
        iso.lastError = String((e && e.message) || e);
      }
    }, 320);
  }
  function publishTree() {
    if (iso.mode === "off" || iso.hostDown) return;
    const sf = window.MTNodeSideFiles && window.MTNodeSideFiles.state;
    const root = sf && typeof sf.root === "string" ? sf.root : "";
    const kind = sf && typeof sf.rootKind === "string" ? sf.rootKind : "";
    const patch = store.setTreeRoot(root, kind);
    if (patch) send(patchToMsg(patch));
    publishRoots();
  }
  function publishRoots() {
    if (typeof api.assistIsoRoots !== "function") return;
    const roots = new Set();
    const push = (v) => {
      const s = String(v || "").trim();
      if (s) roots.add(s);
    };
    try {
      if (typeof canvasWorkspaceDir === "function") push(canvasWorkspaceDir());
    } catch {}
    try {
      if (typeof assistDisplayWorkspace === "function") push(assistDisplayWorkspace());
    } catch {}
    const sf = window.MTNodeSideFiles && window.MTNodeSideFiles.state;
    if (sf && sf.root) push(sf.root);
    if (roots.size) {
      try {
        void api.assistIsoRoots(Array.from(roots)).catch(() => {});
      } catch {}
    }
  }

  /* 会话区矩形：优先 #agentPane（会话视图），它不显示时用 #assistPane（画布助手栏）。
     两个都不显示 = 报空矩形（宿主把视图缩成 0，等于收起）。 */
  function targetEl() {
    const agentPane = document.getElementById("agentPane");
    if (agentPane && agentPane.offsetWidth > 0 && agentPane.offsetHeight > 0) return agentPane;
    const assistPane = document.getElementById("assistPane");
    if (assistPane && assistPane.offsetWidth > 0 && assistPane.offsetHeight > 0) return assistPane;
    return null;
  }
  function publishBoundsSoon() {
    if (iso.mode === "off" || iso.hostDown) return;
    if (boundsRaf) return;
    boundsRaf = requestAnimationFrame(() => {
      boundsRaf = 0;
      publishBounds();
    });
  }
  function publishBounds() {
    if (typeof api.assistIsoBounds !== "function") return;
    const el = targetEl();
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    if (el) {
      const r = el.getBoundingClientRect();
      rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    try {
      void api.assistIsoBounds(rect).catch(() => {});
    } catch {}
    probeHost(); /* 宿主是主进程收到第一份矩形之后才起的：这里顺手问一次它在不在、好没好 */
  }

  /* ── 宿主探针（接管闸要的那两个事实：在不在位 / 页面好了没）───────────────
     主进程只在「收到矩形」时拉起宿主，页面的 did-finish-load 也只有它知道，
     所以由这里按需问一次（800ms 一次，问到了就停；崩掉 / off 档不问）。 */
  let hostProbeAt = 0;
  function probeHost() {
    if (iso.mode === "off" || iso.hostDown) return;
    if (iso.hosting && iso.ready) return;
    const now = Date.now();
    if (now - hostProbeAt < 800) return;
    hostProbeAt = now;
    void refreshHost();
  }
  async function refreshHost() {
    if (typeof api.assistIsoStatus !== "function") return;
    let st = null;
    try {
      st = await api.assistIsoStatus();
    } catch {
      return;
    }
    const r = st && typeof st === "object" ? st : {};
    const was = holdOn();
    if (r.hosting !== undefined) iso.hosting = !!r.hosting;
    if (r.ready !== undefined) iso.ready = !!r.ready;
    if (holdOn() !== was) holdSync();
  }
  /* 宿主起来的那几秒补问几次（页面 loadFile 完 → ready；问到了后面就靠矩形上报自愈） */
  function scheduleProbe() {
    for (const ms of [300, 900, 2000, 4000]) {
      setTimeout(() => {
        try {
          probeHost();
        } catch {}
      }, ms);
    }
  }

  /* ── 接管门的装卸（活动流 / 文件树：这两处不归本文件所有，只在外面包一层「画」）──
     gateRender(owner, key, onHold, canHold)：闸开着（且 canHold 允许）就跳过原函数，
     其余一律照旧；装过的门记在 gates 里，切回 off 时原样摘掉（连函数引用都还原）。 */
  const gates = []; /* [{ owner, key, orig }] */
  function gateRender(owner, key, onHold, canHold) {
    if (!owner) return;
    const fn = owner[key];
    if (typeof fn !== "function" || fn.__isoGated) return;
    const held = () => {
      if (!holdOn()) return false;
      try {
        return typeof canHold === "function" ? !!canHold() : true;
      } catch {
        return true;
      }
    };
    const wrapped = function () {
      if (held()) {
        /* on 档：不画。状态与发布不能断 —— onHold 里补那一步（文件树根 / 会话列表）。 */
        try {
          if (typeof onHold === "function") onHold();
        } catch {}
        return undefined;
      }
      return fn.apply(this, arguments);
    };
    wrapped.__isoGated = true;
    wrapped.__isoOrig = fn;
    try {
      owner[key] = wrapped;
      gates.push({ owner: owner, key: key, orig: fn });
    } catch {}
  }
  /* 文件树容器此刻在不在屏上：在屏上（用户正开着「文件」页签看它）就照旧由主窗画 ——
     隔离页那张「文件树」页签是同一份状态仓的另一出口，没必要把眼前这一份冻住；
     不在屏上（收起来了 / 在节点页签上）才是纯浪费，那才挂起。 */
  function treeOffscreen() {
    const box = document.getElementById("sideFilesTree");
    if (!box) return true;
    return box.offsetParent === null || box.clientHeight === 0;
  }
  function installGates() {
    /* 活动流：右栏 #baList 由隔离页的「活动流」页签画（app-browser.js 的 BA.render）。
       事件照旧进 BA.rows / 照旧落库（BA.onEvent 一字未动），这里只停那一次 DOM 重建。 */
    gateRender(window.BrowserAct, "render");
    /* 文件树：画布左侧栏的树（app-sidebar-files.js 的 sfRender）。
       注意包的是**全局函数**：模块内部（sfRefresh / sfEnterRoot / 展开目录 …）都是按标识符
       调它的，包 window 上那个属性即对全部入口生效。树根变了照旧发布给隔离页。 */
    gateRender(window, "sfRender", publishTreeSoon, treeOffscreen);
  }
  function dropGates() {
    while (gates.length) {
      const g = gates.pop();
      try {
        if (g.owner && g.owner[g.key] && g.owner[g.key].__isoGated) g.owner[g.key] = g.orig;
      } catch {}
    }
  }
  /* 补齐一帧：闸落下（切回 off / 宿主崩了 / 被关了）时把这三股流按当下的状态重画一次，
     界面立刻回到原样（原来停在冻结那一刻的 DOM 不会被留下）。 */
  function resumePaint() {
    const run = () => {
      try {
        if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
      } catch {}
      try {
        if (typeof renderAgentSession === "function") renderAgentSession();
      } catch {}
      try {
        const ba = window.BrowserAct;
        if (ba && typeof ba.render === "function") ba.render();
      } catch {}
      try {
        if (typeof window.sfRender === "function") window.sfRender();
      } catch {}
    };
    try {
      if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(() => setTimeout(run, 0));
      else setTimeout(run, 0);
    } catch {
      setTimeout(run, 0);
    }
  }
  /* 闸位变了才动：开闸（进 on 档）不再画；落闸立刻补一帧。 */
  function holdSync() {
    const on = holdOn();
    if (on === heldLast) return;
    heldLast = on;
    if (!on) resumePaint();
  }

  /* ── 挂到既有渲染点上（只包一层，不改它们的实现） ── */
  function wrapGlobal(name, after) {
    const orig = window[name];
    if (typeof orig !== "function" || orig.__isoWrapped) return;
    const wrapped = function () {
      const r = orig.apply(this, arguments);
      try {
        after();
      } catch {}
      return r;
    };
    wrapped.__isoWrapped = true;
    try {
      window[name] = wrapped;
    } catch {}
  }

  function bindHooks() {
    /* 会话列表每次重绘 → 发布一次（220ms 合批，长回答期间的重绘不会打穿 IPC） */
    wrapGlobal("renderAgentSessionSidebar", publishSessionsSoon);
    /* 文件树：切页 / 刷新 / 重绘 → 发布根目录（on 档接管时只发布，不画） */
    const sf = window.MTNodeSideFiles;
    if (sf && typeof sf === "object") {
      for (const k of ["refresh", "render", "setTab"]) {
        const fn = sf[k];
        if (typeof fn !== "function" || fn.__isoWrapped) continue;
        sf[k] = function () {
          /* on 档：render 这一处只更新状态、不落 DOM（refresh 清缓存、setTab 换页签照旧生效）；
             树在屏上时照旧由主窗画（见 treeOffscreen 的取舍） */
          const skip = k === "render" && holdOn() && treeOffscreen();
          const r = skip ? undefined : fn.apply(this, arguments);
          try {
            publishTreeSoon();
          } catch {}
          return r;
        };
        sf[k].__isoWrapped = true;
      }
    }
    /* 窗口尺寸 / 会话视图显隐变化 → 重报矩形 */
    window.addEventListener("resize", publishBoundsSoon, { passive: true });
    try {
      const mo = new MutationObserver(() => publishBoundsSoon());
      for (const id of ["agentPane", "assistPane"]) {
        const el = document.getElementById(id);
        if (el) mo.observe(el, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
      }
    } catch {}
  }

  /* ── 隔离页转回来的动作：全部转调今天就在用的函数 ── */
  function bindActions() {
    if (typeof api.onAssistIsoAction !== "function") return;
    api.onAssistIsoAction((msg) => {
      const m = msg && typeof msg === "object" ? msg : {};
      const type = String(m.type || "");
      const p = m.payload && typeof m.payload === "object" ? m.payload : {};
      try {
        if (type === "session-select") {
          const id = String(p.id || "");
          if (id && typeof agentSelectSession === "function") agentSelectSession(id);
        } else if (type === "open-file") {
          const path = String(p.path || "");
          if (path && typeof openFilePeek === "function") openFilePeek(path);
        } else if (type === "refresh-tree") {
          if (window.MTNodeSideFiles && typeof window.MTNodeSideFiles.refresh === "function")
            window.MTNodeSideFiles.refresh();
        } else if (type === "activity-clear") {
          const sid = String(p.sessionId || "");
          if (typeof api.activityClear === "function") {
            void api
              .activityClear(sid ? { sessionId: sid } : {})
              .then(() => {
                if (iso.mode !== "off" && !iso.hostDown)
                  send({ kind: "activity", data: { rows: [], onlyCurrent: true, filter: "" } });
              })
              .catch(() => {});
          }
        } else if (type === "fault" || type === "closed") {
          /* 宿主崩了 / 用户把它关了：不再发布（内嵌路径本来就是活的，界面不会空） */
          iso.hostDown = true;
          iso.hosting = false;
          iso.ready = false;
          holdSync(); /* 闸立刻落下：主窗接手补画一帧，界面不会停在冻结那一刻 */
        } else if (type === "mode") {
          iso.mode = String(p.config || "off");
          if (iso.mode === "off") iso.hostDown = false;
          if (p.hosting !== undefined) iso.hosting = !!p.hosting;
          if (p.ready !== undefined) iso.ready = !!p.ready;
          if (iso.mode === "off") {
            dropGates(); /* off 档一个门都不留（旧路径逐字恢复） */
          } else if (iso.mode === "on") {
            installGates(); /* 只有接管档才装门（window 档是并存排查档，主窗照旧自己画） */
          }
          holdSync();
        }
      } catch (e) {
        iso.lastError = String((e && e.message) || e);
      }
    });
  }

  /* ── 起：问一次档位，开着就把第一条快照发过去 ── */
  function publishAll() {
    publishSessions(true);
    publishTree();
    publishBounds();
    publishRoots();
  }
  /* 会话列表是懒加载的（刚启动那几秒 agentSessions() 还可能为空）：
     补两次，之后靠 renderAgentSessionSidebar 的包裹自愈 */
  function publishAllDeferred() {
    publishAll();
    for (const ms of [1500, 4000]) {
      setTimeout(() => {
        try {
          if (iso.mode !== "off" && !iso.hostDown) publishAll();
        } catch {}
      }, ms);
    }
  }

  async function boot() {
    let st = null;
    try {
      st = await api.assistIsoStatus();
    } catch {
      return;
    }
    const res = st && typeof st === "object" ? st : {};
    iso.mode = String(res.config || "off");
    if (iso.mode === "off") return;
    /* 宿主此刻在不在位（status 里就有）：on 档接管要据此决定主窗画不画 */
    iso.hosting = !!res.hosting;
    iso.ready = !!res.ready;
    bindHooks();
    bindActions();
    if (iso.mode === "on") installGates();
    scheduleProbe();
    holdSync();
    /* 先补一次现况（宿主可能还在 loadFile，主进程会攒着这些消息等它 ready） */
    publishAllDeferred();
    try {
      await api.assistIsoState({ type: "snapshot", state: store.snapshot() });
      snapshotSent = true;
    } catch {}
  }

  /* 给 devtools / 自验脚本用的窄口：切档 + 看一眼现况（不改任何渲染逻辑） */
  window.assistIsolation = {
    status: () => Object.assign({}, iso, { snapshotSent: snapshotSent, store: store }),
    set: async (mode) => {
      if (typeof api.assistIsoSet !== "function") return { ok: false };
      const r = await api.assistIsoSet(String(mode || "off")).catch((e) => ({ ok: false, error: String(e) }));
      iso.mode = String((r && r.config) || "off");
      if (r && r.hosting !== undefined) iso.hosting = !!r.hosting;
      if (r && r.ready !== undefined) iso.ready = !!r.ready;
      if (iso.mode === "off") {
        iso.hostDown = false;
        dropGates(); /* 切回 off：门全摘掉，旧路径逐字恢复 */
        holdSync(); /* 立刻补画一帧（原来冻结的界面马上回到原样） */
        return r;
      }
      bindHooks();
      bindActions();
      if (iso.mode === "on") installGates();
      scheduleProbe();
      holdSync();
      publishAllDeferred();
      try {
        await api.assistIsoState({ type: "snapshot", state: store.snapshot() });
        snapshotSent = true;
      } catch {}
      return r;
    },
    store: store,
  };

  boot().catch(() => {});
})();

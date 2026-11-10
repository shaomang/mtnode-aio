"use strict";
/* ============================================================
 * renderer/app-assist-isolated.js — 隔离渲染进程页（assist-isolated.html）的渲染器
 *
 * 它只做三件事：
 *   ① 把主进程转发来的东西灌进 MTAssistState（app-assist-state.js，两侧同一份）；
 *   ② 按状态画三块：会话流（当前会话这一轮）、活动流、文件树；
 *   ③ 用户动作原路打回主进程（切会话 / 清活动 / 开文件 / 收起），本页不直接改任何真源。
 *
 * 纪律（与派单的边界一致）：
 *   · 不读盘：文件树每层走 window.assistIso.readDir（主进程校验工作区根后列一层）；
 *   · 不碰 node / ipcRenderer：桥只有 window.assistIso 那五件事；
 *   · 重画按帧合批（一次 rAF 只画一遍），几千帧流式输出也不会把这一页拖垮；
 *   · 任何渲染异常只落在本页自己的日志里，绝不回抛给主进程。
 * ============================================================ */
(function () {
  const bridge = window.assistIso;
  const store = window.MTAssistState.createStore();

  const $ = (id) => document.getElementById(id);
  const el = {
    dot: $("isoDot"),
    meta: $("isoMeta"),
    tabs: $("isoTabs"),
    follow: $("isoFollow"),
    clear: $("isoClear"),
    paneStream: $("paneStream"),
    paneActivity: $("paneActivity"),
    paneTree: $("paneTree"),
    sessions: $("isoSessions"),
    stream: $("isoStream"),
    streamEmpty: $("isoStreamEmpty"),
    filter: $("isoFilter"),
    onlyCurrent: $("isoOnlyCurrent"),
    activity: $("isoActivity"),
    root: $("isoRoot"),
    treeRefresh: $("isoTreeRefresh"),
    tree: $("isoTree"),
  };

  const ui = {
    pane: "stream",
    follow: true,
    expanded: new Set(), /* 展开着的目录（渲染用；目录内容在 store.tree.dirs 里） */
    errors: new Set(), /* 读不出来的目录（显示提示，不再自动重试） */
  };

  /* ── 合批重画：一帧里来多少 patch 都只画一遍 ── */
  let rafId = 0;
  const dirty = { stream: false, sessions: false, activity: false, tree: false };
  function schedule(kind) {
    if (kind) dirty[kind] = true;
    else dirty.stream = dirty.sessions = dirty.activity = dirty.tree = true;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const d = Object.assign({}, dirty);
      dirty.stream = dirty.sessions = dirty.activity = dirty.tree = false;
      try {
        if (d.sessions) paintSessions();
        if (d.stream) paintStream();
        if (d.activity) paintActivity();
        if (d.tree) paintTree();
        paintMeta();
      } catch (e) {
        console.error("[assist-iso] 重画失败：", e);
      }
    });
  }

  function paintMeta() {
    const s = store.state;
    const cur = s.sessions.rows.find((r) => r.id === s.sessions.currentId);
    const parts = [];
    if (cur) parts.push(cur.title || "新会话");
    parts.push("会话 " + s.sessions.rows.length);
    parts.push("活动 " + s.activity.rows.length);
    if (s.stream.running) parts.push("运行中");
    el.meta.textContent = parts.join(" · ");
    el.dot.classList.toggle("off", !s.sessions.currentId);
  }

  /* ── 会话流 ── */
  function paintSessions() {
    const s = store.state.sessions;
    const frag = document.createDocumentFragment();
    if (!s.rows.length) {
      const d = document.createElement("div");
      d.className = "iso-msg";
      d.textContent = "还没有会话";
      frag.appendChild(d);
    }
    for (const r of s.rows) {
      const row = document.createElement("div");
      row.className = "iso-sess" + (r.id === s.currentId ? " on" : "") + (r.running ? " running" : "");
      const nm = document.createElement("span");
      nm.className = "iso-sess-name";
      nm.textContent = r.title || "新会话";
      row.appendChild(nm);
      const meta = document.createElement("span");
      meta.className = "iso-sess-meta";
      meta.textContent = (r.canvas ? "▣ " + r.canvas : r.assist ? "助手" : "") + (r.archived ? " · 已归档" : "");
      row.appendChild(meta);
      row.title = (r.title || "") + (r.canvas ? " · " + r.canvas : "");
      row.addEventListener("click", () => {
        if (!bridge) return;
        void bridge.act("session-select", { id: r.id });
      });
      frag.appendChild(row);
    }
    el.sessions.replaceChildren(frag);
  }

  function paintStream() {
    const s = store.state.stream;
    const frag = document.createDocumentFragment();
    for (const it of s.items) {
      frag.appendChild(streamItemEl(it));
    }
    el.streamEmpty.hidden = !!s.items.length;
    el.stream.replaceChildren(frag);
    el.stream.appendChild(el.streamEmpty);
    if (ui.follow) el.stream.scrollTop = el.stream.scrollHeight;
  }

  function streamItemEl(it) {
    const d = document.createElement("div");
    if (it.k === "say") {
      d.className = "iso-item";
      d.textContent = it.text || "";
    } else if (it.k === "think") {
      d.className = "iso-item think";
      d.textContent = it.text || "";
    } else if (it.k === "user") {
      d.className = "iso-item user";
      d.textContent = it.text || "";
    } else if (it.k === "tool") {
      d.className = "iso-item tool";
      const b = document.createElement("b");
      b.textContent = it.name || "工具";
      d.appendChild(b);
      const st = it.status === "done" ? " ✓" : it.status === "failed" ? " ✗" : it.status === "preparing" ? " 准备中" : " …";
      d.appendChild(document.createTextNode(st));
      if (it.text) {
        d.appendChild(document.createElement("br"));
        d.appendChild(document.createTextNode(it.text));
      }
      if (it.bytes) d.appendChild(document.createTextNode("（" + Math.ceil(it.bytes / 1024) + " KB 参数）"));
    } else if (it.k === "err") {
      d.className = "iso-item err";
      d.textContent = it.text || "出错了";
    } else {
      d.className = "iso-item note";
      d.textContent = it.text || "";
    }
    return d;
  }

  /* ── 活动流 ── */
  function visibleActivity() {
    const s = store.state.activity;
    const q = s.filter.trim().toLowerCase();
    const only = s.onlyCurrent ? store.state.sessions.currentId : "";
    const out = [];
    for (const r of s.rows) {
      if (only && r.sessionId && r.sessionId !== only) continue;
      if (q) {
        const hay = (r.kind + " " + r.text + " " + r.path).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(r);
    }
    return out;
  }

  function paintActivity() {
    const s = store.state.activity;
    if (el.onlyCurrent.checked !== !!s.onlyCurrent) el.onlyCurrent.checked = !!s.onlyCurrent;
    if (el.filter.value !== s.filter) el.filter.value = s.filter;
    const rows = visibleActivity();
    const frag = document.createDocumentFragment();
    if (!rows.length) {
      const d = document.createElement("div");
      d.className = "iso-msg";
      d.textContent = s.rows.length ? "没有符合条件的活动" : "还没有活动（浏览器动作 / 命令 / 文件读写会记在这里）";
      frag.appendChild(d);
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const row = document.createElement("div");
      row.className = "iso-act";
      const t = document.createElement("span");
      t.className = "iso-act-time";
      const dt = new Date(r.at || Date.now());
      t.textContent =
        String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0") + ":" +
        String(dt.getSeconds()).padStart(2, "0");
      row.appendChild(t);
      const k = document.createElement("span");
      k.className = "iso-act-kind";
      k.textContent = r.kind;
      row.appendChild(k);
      const tx = document.createElement("span");
      tx.className = "iso-act-text";
      tx.textContent = r.text || r.path || "";
      if (r.status) {
        const st = document.createElement("i");
        st.textContent = "  [" + r.status + "]";
        tx.appendChild(st);
      }
      row.appendChild(tx);
      frag.appendChild(row);
    }
    el.activity.replaceChildren(frag);
  }

  /* ── 文件树 ── */
  function joinPath(dir, name) {
    const sep = dir.indexOf("\\") >= 0 ? "\\" : "/";
    return dir.endsWith(sep) ? dir + name : dir + sep + name;
  }

  function paintTree() {
    const root = store.state.tree.root;
    if (el.root.value !== root) el.root.value = root || "";
    const frag = document.createDocumentFragment();
    if (!root) {
      const d = document.createElement("div");
      d.className = "iso-msg";
      d.textContent = "当前画布还没有工作目录";
      frag.appendChild(d);
      el.tree.replaceChildren(frag);
      return;
    }
    const drawDir = (dir, depth) => {
      const rec = store.state.tree.dirs[dir];
      if (store.state.tree.loading[dir] && !rec) {
        frag.appendChild(msgLine("读取中…", depth));
        return;
      }
      if (!rec) return;
      if (rec.error) frag.appendChild(msgLine(rec.error, depth, true));
      else if (!rec.entries.length) frag.appendChild(msgLine("（空目录）", depth));
      for (const e of rec.entries) {
        const path = joinPath(dir, e.name);
        const row = document.createElement("div");
        row.className = "iso-row " + (e.isDir ? "dir" : "file");
        row.style.paddingLeft = 2 + depth * 14 + "px";
        const ic = document.createElement("span");
        ic.className = "ic";
        ic.textContent = e.isDir ? (ui.expanded.has(path) ? "▾" : "▸") : "·";
        row.appendChild(ic);
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = e.name;
        row.appendChild(nm);
        if (!e.isDir && e.size) {
          const sz = document.createElement("span");
          sz.className = "sz";
          sz.textContent = humanSize(e.size);
          row.appendChild(sz);
        }
        row.title = path;
        row.addEventListener("click", () => {
          if (e.isDir) toggleDir(path);
          else if (bridge) void bridge.act("open-file", { path: path });
        });
        frag.appendChild(row);
        if (e.isDir && ui.expanded.has(path)) drawDir(path, depth + 1);
      }
    };
    drawDir(root, 0);
    el.tree.replaceChildren(frag);
  }

  function msgLine(textValue, depth, err) {
    const d = document.createElement("div");
    d.className = "iso-msg" + (err ? " err" : "");
    d.style.paddingLeft = 2 + depth * 14 + "px";
    d.textContent = textValue;
    return d;
  }

  function humanSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + " KB";
    return (v / 1024 / 1024).toFixed(1) + " MB";
  }

  /* 一层目录：走主进程（它校验路径必须落在已公布的工作区根下面） */
  async function loadDir(dir) {
    store.treeLoading(dir);
    schedule("tree");
    if (!bridge) return;
    const r = await bridge.readDir(dir).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
    const res = r && typeof r === "object" ? r : {};
    store.setTreeDir(dir, res.entries || [], { error: res.error || "", exists: res.exists !== false });
    schedule("tree");
  }

  function toggleDir(path) {
    if (ui.expanded.has(path)) {
      ui.expanded.delete(path);
      schedule("tree");
      return;
    }
    ui.expanded.add(path);
    if (store.state.tree.dirs[path]) schedule("tree");
    else void loadDir(path);
  }

  /* ── 页签 / 工具条 ── */
  function setPane(name) {
    ui.pane = name === "activity" || name === "tree" ? name : "stream";
    for (const b of el.tabs.querySelectorAll(".iso-tab"))
      b.classList.toggle("on", b.getAttribute("data-pane") === ui.pane);
    el.paneStream.hidden = ui.pane !== "stream";
    el.paneActivity.hidden = ui.pane !== "activity";
    el.paneTree.hidden = ui.pane !== "tree";
    schedule();
  }

  el.tabs.addEventListener("click", (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest(".iso-tab") : null;
    if (b) setPane(b.getAttribute("data-pane"));
  });
  el.follow.addEventListener("click", () => {
    ui.follow = !ui.follow;
    el.follow.classList.toggle("on", ui.follow);
    if (ui.follow) el.stream.scrollTop = el.stream.scrollHeight;
  });
  el.clear.addEventListener("click", () => {
    const sid = store.state.sessions.currentId || "";
    store.clearActivity(sid);
    schedule("activity");
    if (bridge) void bridge.act("activity-clear", { sessionId: sid });
  });
  el.filter.addEventListener("input", () => {
    store.setActivityPrefs({ filter: el.filter.value });
    schedule("activity");
  });
  el.onlyCurrent.addEventListener("change", () => {
    store.setActivityPrefs({ onlyCurrent: el.onlyCurrent.checked });
    schedule("activity");
  });
  el.treeRefresh.addEventListener("click", () => {
    const root = store.state.tree.root;
    ui.expanded.clear();
    if (root) void loadDir(root);
    else if (bridge) void bridge.act("refresh-tree", {});
  });

  el.follow.classList.add("on");

  /* ── 与主进程对接 ── */
  store.subscribe((patch) => {
    const kind = patch && patch.kind;
    schedule(kind === "sessions" ? "sessions" : kind === "activity" ? "activity" : kind === "tree" ? "tree" : "stream");
  });

  if (!bridge) {
    el.dot.classList.add("off");
    el.meta.textContent = "桥未就绪（不是由主进程拉起的页面）";
    schedule();
    return;
  }

  bridge.onSnapshot((snap) => {
    store.replace(snap || {});
    schedule();
    const root = store.state.tree.root;
    if (root && !store.state.tree.dirs[root]) void loadDir(root);
  });
  bridge.onPatch((patch) => {
    /* 文件树一节里主进程只发根与「正在读」的那几格；目录内容由本页自己读 */
    store.applyPatch(patch || {});
  });
  bridge.onEvent((ev) => {
    store.applyEvent(ev || {});
  });

  /* 页面挂好 → 要一次对齐快照（主进程可能已经攒了一堆 patch） */
  bridge
    .ready()
    .then((r) => {
      const res = r && typeof r === "object" ? r : {};
      if (res.snapshot) {
        store.replace(res.snapshot);
        schedule();
        const root = store.state.tree.root;
        if (root) void loadDir(root);
      }
      if (res.mode) el.meta.textContent = "模式：" + String(res.mode);
    })
    .catch(() => {
      el.dot.classList.add("off");
    });

  setPane("stream");
  schedule();
})();

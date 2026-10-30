"use strict";
/* renderer/app-appnode.js — 应用节点（kind appnode）
 * ============================================================================
 * 一颗节点 = 一个钉在画布上的应用：卡片上点一下，就在**画布区**里展开一块可关闭的
 * 全屏界面（#canvas 的矩形内、不盖顶栏），界面正文是 mtnode-preview:// 的一只 iframe
 * —— 也就是应用中心里那个应用的静态页（index.html + 相对路径资源原样照跑）。
 *
 * 与用户敲定的共识逐条对应（改之前先看这里，别自作主张）：
 *   ① 页面来源：绑应用中心里已有的应用，节点只存 appId（appTitle / appEntry 只作显示）；
 *   ② 全屏形态：主窗口内的画布区浮层 + iframe，不是独立窗口、也不盖顶栏；
 *   ③ 可绑范围：本机全部应用（开发根 + 下载根），清单由 apps-node-store.js 给；
 *   ④ 选择一次性：卡片上一个按钮，选完即不可改（只有应用不可用时才露出「重新绑定」）；
 *   ⑤ 打开方式：点卡片 body 进界面；应用不可用时打开的是提示页；
 *   ⑥ 桥：沿用 window.appHost，新增 canvas / agent / fs / tools / net 子命名空间；
 *   ⑦ 粒度：**逐类白名单**（见 APPNODE_METHODS），绝不代理整个 window.api；
 *   ⑧ 写画布：全量读写，每次写入先 pushHistory（并入撤销栈）；
 *   ⑨ agent：节点绑定左侧栏的一条会话（可切换），起会话 / 发消息 / 收流式都由会话链跑；
 *   ⑩ 文件：读写限定在画布工作目录内（主进程 apps-node-store.js 再守一道）；
 *   ⑪ 数据：<画布工作目录>/apps-data/<appId>/data.json（选应用确认后建目录）；
 *   ⑫ 节点角色：纯启动器 —— 无端子、不参与运行，执行引擎与连线规则一行不改；
 *   ⑬ 多开：界面同时只开一个；后台也同时只允许一个（开新的先停旧的）；
 *   ⑭ 存活：活到「节点被删 / 切换画布 / 退出 MTNode / 点「停止」」；关闭界面只是收起；
 *   ⑮ 关闭不拦、不二次确认，数据自动落盘；关闭（✕ / Esc）与「完全停止」是两颗不同的钮；
 *   ⑯ 跟随：界面矩形永远等于 #canvas 的矩形（左右边栏 / 右助手栏 / 窗口缩放都实时跟），
 *      离开画布视图（会话 / 团队）或切到别的画布就隐藏，回到这张画布再自动回来。
 *
 * 页面侧那座桥有两段：apps-store.js 的 PREVIEW_BRIDGE（appHost 原样）+ APPNODE_BRIDGE
 * （数据改道 + 新命名空间）。本文件是**父窗口中继**：只认当前那一帧的来源，
 * 把调用分派到画布 / 会话 / 主进程三处；别的帧发来的一律不理。
 * ========================================================================== */

const APPNODE_K = "__mtnodeAppNode";
const APPNODE_PK = "__mtnodePreview";
/* 逐类白名单：命名空间 → 允许的方法（页面里也只能调到这些） */
const APPNODE_METHODS = {
  canvas: [
    "graph",
    "nodes",
    "node",
    "addNode",
    "updateNode",
    "removeNode",
    "connect",
    "disconnect",
    "select",
    "view",
    "setView",
    "save",
  ],
  agent: ["sessions", "bind", "bound", "send", "cancel"],
  fs: ["root", "readText", "writeText", "list", "mkdir", "remove", "exists"],
  tools: ["list", "call"],
  net: ["fetch"],
  data: ["read", "write", "dir", "openDir", "storageGet", "storageSet", "storageAll", "storageRemove"],
};

const APPNODE = {
  host: null,
  frame: null,
  titleEl: null,
  subEl: null,
  noteEl: null,
  hintEl: null,
  nodeId: "",
  appId: "",
  wfId: "",
  workdir: "",
  token: "",
  leaseAt: 0,
  ready: false,
  data: {},
  dataLoaded: false,
  dataDir: "",
  dataFile: "",
  saveTimer: null,
  pending: null,
  watcher: null,
  picker: null,
  bound: "",
  userClosed: false,
  ro: null,
  mo: null,
};

/* ── 小工具 ───────────────────────────────────────────────────────────── */
function appNodeT(s) {
  try {
    return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
  } catch (_) {
    return s;
  }
}
function appNodeEl(tag, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}
function appNodeToast(msg, kind) {
  try {
    if (typeof toast === "function") toast(msg, kind || "info");
  } catch (_) {}
}
function appNodeApi() {
  return window.api || {};
}
function appNodeWorkdir() {
  try {
    return String((S && S.wf && S.wf.workspace) || "").trim();
  } catch (_) {
    return "";
  }
}
function appNodeById(id) {
  try {
    return (S.wf.nodes || []).find((n) => n && n.id === id) || null;
  } catch (_) {
    return null;
  }
}
/* 卡片上的状态文字（已打开 / 后台运行中）不在节点数据里，整幅重绘不会重建 body ——
   所以开关界面后按节点 id 单独重建这颗卡片的 body（没有该元素就退回整幅重绘）。 */
/* 卡片上那行状态文字：直接改，不走重建（重建 body 会碰焦点 / 预览回填，某些时刻会抛，
   结果就是「界面开了、字还是旧的」）。找不到元素就算了，下次重建会自己算对。 */
function appNodePaintState(nodeId, text) {
  if (!nodeId) return;
  try {
    const el = document.querySelector('.wf-node[data-nid="' + nodeId + '"] .appnode-state');
    if (el) el.textContent = String(text || "");
  } catch (_) {}
}
function appNodeRepaintCard(nodeId) {
  const n = appNodeById(nodeId || APPNODE.nodeId);
  if (n && typeof refreshNodeBody === "function") {
    try {
      if (refreshNodeBody(n)) return;
    } catch (_) {}
  }
  if (typeof renderCanvas === "function") renderCanvas();
}
function appNodeClone(v) {
  try {
    return JSON.parse(JSON.stringify(v == null ? null : v));
  } catch (_) {
    return null;
  }
}
function appNodeNodeId() {
  try {
    return String((S && S.wf && S.wf.id) || "");
  } catch (_) {
    return "";
  }
}
function appNodeNewId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ── 卡片正文（buildBody 分流到这里，见 app-canvas.js） ───────────────── */
function appNodeBuildBody(node, body) {
  if (!node || !body) return;
  if (typeof node.appId !== "string") node.appId = "";
  body.textContent = "";
  const card = appNodeEl("div", "appnode-card");
  if (!node.appId) {
    const btn = appNodeEl("button", "appnode-pick-btn");
    btn.type = "button";
    btn.textContent = appNodeT("选择应用");
    btn.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      appNodeOpenPicker(node);
    };
    card.appendChild(btn);
    const hint = appNodeEl("div", "appnode-hint");
    hint.textContent = appNodeT("选一次即固定：之后点卡片进入应用界面");
    card.appendChild(hint);
    body.appendChild(card);
    return;
  }
  const nameEl = appNodeEl("div", "appnode-name");
  nameEl.textContent = node.appTitle || node.appId;
  card.appendChild(nameEl);
  const stateEl = appNodeEl("div", "appnode-state");
  if (node.appMissing) {
    stateEl.textContent = appNodeT("应用不可用（目录已不在本机）");
    stateEl.classList.add("bad");
    const rebind = appNodeEl("button", "appnode-pick-btn");
    rebind.type = "button";
    rebind.textContent = appNodeT("重新绑定");
    rebind.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      appNodeToggleRebind(node);
    };
    card.appendChild(stateEl);
    card.appendChild(rebind);
    if (appNodeToggleRebind.armed === node.id || appNodeOpenPicker.armed === node.id) {
      const btn = appNodeEl("button", "appnode-pick-btn");
      btn.type = "button";
      btn.textContent = appNodeT("确实要重新选择");
      btn.onclick = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        appNodeOpenPicker.armed = "";
        appNodeOpenPicker(node, { rebind: true });
      };
      card.appendChild(btn);
    }
    body.appendChild(card);
    return;
  }
  const running = APPNODE.nodeId === node.id;
  const isOpen = running && APPNODE.host && !APPNODE.host.hidden;
  stateEl.textContent = isOpen
    ? appNodeT("界面已打开（右上角可收起或停止）")
    : running
      ? appNodeT("后台运行中 · 点这里回到界面")
      : appNodeT("点击进入应用界面");
  card.appendChild(stateEl);
  if (node.appDataDir) {
    const dirEl = appNodeEl("div", "appnode-dir");
    dirEl.textContent = node.appDataDir;
    dirEl.title = node.appDataDir;
    card.appendChild(dirEl);
  }
  /* 收起后（后台运行中）界面上没有工具条了，卡片上必须留一颗「完全停止」，
     否则只能先回到界面再停。点它只停止，不打开界面。 */
  if (running) {
    const stop = appNodeEl("button", "appnode-pick-btn appnode-stop-btn");
    stop.type = "button";
    stop.textContent = appNodeT("完全停止应用");
    stop.title = appNodeT("结束这个应用的运行（释放内存，数据已保存）；下次点卡片重新启动");
    stop.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      appNodeStop();
    };
    card.appendChild(stop);
  }
  /* 点卡片 = 打开（界面开着时卡片在浮层底下，本来就点不到）；
     关闭只走浮层右上角 ✕ / Esc —— 连点两下也只是重复打开，不会开了又关。 */
  card.onclick = (ev) => {
    ev.stopPropagation();
    appNodeOpen(node);
  };
  body.appendChild(card);
}
/* 「重新绑定」要按两下（第一下只是把第二个按钮亮出来）：绑错一次就回不去了，
   中间隔一拍比直接改掉安全。 */
function appNodeToggleRebind(node) {
  appNodeToggleRebind.armed = appNodeToggleRebind.armed === node.id ? "" : node.id;
  appNodeOpenPicker.armed = appNodeToggleRebind.armed;
  appNodeRepaintCard(node.id);
}

/* ── 选应用（一次性）：本机全部应用 ───────────────────────────────────── */
async function appNodeOpenPicker(node, opts) {
  const o = opts || {};
  if (node.appId && !node.appMissing && !o.rebind) {
    appNodeToast(appNodeT("应用已绑定，不能更换"), "warn");
    return;
  }
  if (APPNODE.picker) {
    APPNODE.picker.remove();
    APPNODE.picker = null;
    return;
  }
  const wrap = appNodeEl("div", "appnode-picker");
  const box = appNodeEl("div", "appnode-picker-box");
  const head = appNodeEl("div", "appnode-picker-head");
  const h = appNodeEl("div", "appnode-picker-title");
  h.textContent = appNodeT("选择应用（一次性）");
  const close = appNodeEl("button", "appnode-picker-x");
  close.type = "button";
  close.textContent = "✕";
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      appNodeClosePicker();
    }
  };
  close.onclick = () => appNodeClosePicker();
  head.appendChild(h);
  head.appendChild(close);
  box.appendChild(head);
  const list = appNodeEl("div", "appnode-picker-list");
  list.textContent = appNodeT("正在读取本机应用…");
  box.appendChild(list);
  wrap.appendChild(box);
  document.body.appendChild(wrap);
  APPNODE.picker = wrap;
  window.addEventListener("keydown", onKey, true);
  wrap._onKey = onKey;

  const api = appNodeApi();
  let r = null;
  try {
    r = typeof api.appNodeList === "function" ? await api.appNodeList() : null;
  } catch (_) {
    r = null;
  }
  const apps = (r && Array.isArray(r.apps) && r.apps) || [];
  list.textContent = "";
  if (!apps.length) {
    const empty = appNodeEl("div", "appnode-picker-empty");
    empty.textContent = appNodeT(
      "本机还没有应用：先去「应用」页新建或下载一个，再回来绑到画布上。",
    );
    list.appendChild(empty);
    return;
  }
  for (const a of apps) {
    const row = appNodeEl("button", "appnode-picker-row");
    row.type = "button";
    const t1 = appNodeEl("div", "appnode-picker-name");
    t1.textContent = a.title || a.id;
    const t2 = appNodeEl("div", "appnode-picker-sub");
    t2.textContent = String(a.id || "") + (a.dev ? " · " + appNodeT("开发中") : "");
    row.appendChild(t1);
    row.appendChild(t2);
    row.onclick = () => appNodeBind(node, a);
    list.appendChild(row);
  }
}
function appNodeClosePicker() {
  const w = APPNODE.picker;
  if (!w) return;
  if (w._onKey) window.removeEventListener("keydown", w._onKey, true);
  w.remove();
  APPNODE.picker = null;
}
/* 绑定 + 建数据目录（q8：选择确认后创建数据目录；q4：绑完不可改） */
async function appNodeBind(node, app) {
  const api = appNodeApi();
  const workdir = appNodeWorkdir();
  appNodeClosePicker();
  if (!workdir) {
    appNodeToast(appNodeT("这张画布还没有工作目录：先在顶栏选一个文件夹"), "warn");
    return;
  }
  let root = null;
  try {
    root =
      typeof api.appNodeDataRoot === "function"
        ? await api.appNodeDataRoot({ appId: app.id, workdir: workdir })
        : null;
  } catch (_) {
    root = null;
  }
  if (!root || root.ok === false) {
    appNodeToast((root && root.error) || appNodeT("建不出应用数据目录"), "err");
    return;
  }
  if (typeof pushHistory === "function") pushHistory();
  node.appId = String(app.id || "");
  node.appTitle = String(app.title || app.id || "");
  node.appEntry = String(app.entry || "index.html");
  node.appDir = String(app.dir || "");
  node.appMissing = false;
  node.appDataDir = String(root.dir || "");
  node.appDataFile = String(root.file || "");
  if (!node.title || /^应用节点|^App node/i.test(String(node.title))) {
    node.title = node.appTitle;
  }
  if (typeof renderCanvas === "function") renderCanvas();
  appNodeRepaintCard(node.id);
  if (typeof scheduleSave === "function") scheduleSave(true);
  appNodeToast(appNodeT("已绑定应用：") + node.appTitle, "ok");
}

/* ── 画布区浮层（单实例 · 关闭只收起 · 后台存活） ─────────────────────── */
/* 工具条图标一律用细线 SVG（与顶栏 / 画布工具条同一种视觉），不用 emoji：
   emoji 在深浅两套主题下颜色不受控，和旁边按钮也凑不到一起。 */
const APPNODE_ICONS = {
  reload:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.6 6.4A5 5 0 1 0 13 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13.2 2.8v3.3H9.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 4.6h4.1l1.2 1.5h6.3v6.3H2.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2.2 6.1h11.6" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".7"/></svg>',
  stop:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
function appNodeBarBtn(icon, text, title, cls) {
  const btn = appNodeEl("button", "appnode-bar-btn" + (cls ? " " + cls : ""));
  btn.type = "button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = icon;
  if (text) {
    const label = appNodeEl("span", "appnode-bar-btn-txt");
    label.textContent = text;
    btn.appendChild(label);
  }
  return btn;
}
function appNodeEnsureHost() {
  if (APPNODE.host && document.body.contains(APPNODE.host)) return APPNODE.host;
  const host = appNodeEl("div", "appnode-host");
  host.hidden = true;
  const bar = appNodeEl("div", "appnode-bar");
  const title = appNodeEl("div", "appnode-bar-title");
  const sub = appNodeEl("div", "appnode-bar-sub");
  const spacer = appNodeEl("div", "appnode-bar-spacer");
  const reload = appNodeBarBtn(
    APPNODE_ICONS.reload,
    "",
    appNodeT("重新载入应用页"),
    "appnode-bar-icon",
  );
  reload.onclick = () => appNodeReload();
  const openDir = appNodeBarBtn(
    APPNODE_ICONS.folder,
    "",
    appNodeT("打开这个应用的数据目录"),
    "appnode-bar-icon",
  );
  openDir.onclick = () => appNodeOpenDataDir();
  /* 两颗钮的分工必须一眼看得出：停止 = 结束运行；收起 = 只是回后台。 */
  const stop = appNodeBarBtn(
    APPNODE_ICONS.stop,
    appNodeT("停止"),
    appNodeT("完全停止应用（结束运行，释放内存；数据已保存）"),
    "appnode-bar-stop",
  );
  stop.onclick = () => appNodeStop();
  const close = appNodeBarBtn(
    APPNODE_ICONS.close,
    appNodeT("收起"),
    appNodeT("收起界面（应用继续在后台运行）"),
    "appnode-bar-close",
  );
  close.onclick = () => appNodeClose();
  bar.appendChild(title);
  bar.appendChild(sub);
  bar.appendChild(spacer);
  bar.appendChild(reload);
  bar.appendChild(openDir);
  bar.appendChild(stop);
  bar.appendChild(close);
  const bodyBox = appNodeEl("div", "appnode-body");
  const hint = appNodeEl("div", "appnode-note");
  hint.hidden = true;
  bodyBox.appendChild(hint);
  host.appendChild(bar);
  host.appendChild(bodyBox);
  document.body.appendChild(host);
  APPNODE.host = host;
  APPNODE.titleEl = title;
  APPNODE.subEl = sub;
  APPNODE.hintEl = hint;
  appNodeWatchLayout();
  return host;
}
function appNodePosition() {
  const host = APPNODE.host;
  if (!host) return false;
  const cv = document.getElementById("canvas") || document.getElementById("stage");
  if (!cv) return false;
  const r = cv.getBoundingClientRect();
  /* 画布被藏起来时 rect 是 0：这时不能把浮层缩成 320×240 贴在左上角，直接判不可见。 */
  if (!(r.width > 2 && r.height > 2)) {
    host.hidden = true;
    return false;
  }
  host.style.left = r.left + "px";
  host.style.top = r.top + "px";
  host.style.width = r.width + "px";
  host.style.height = r.height + "px";
  return true;
}
/* 当前是不是正看着这张画布：会话 / 团队视图都要把应用收起（后台照跑）。 */
function appNodeCanvasOn() {
  try {
    return !S || !S.view || S.view === "workflow";
  } catch (_) {
    return true;
  }
}
/* 显隐与矩形的唯一收口：RO / 视图切换 / 窗口缩放 / 定时看门狗都走这里。 */
function appNodeSync() {
  const host = APPNODE.host;
  if (!host || !APPNODE.nodeId) return false;
  if (!appNodeCanvasOn() || (APPNODE.wfId && appNodeNodeId() !== APPNODE.wfId)) {
    host.hidden = true;
    return false;
  }
  if (APPNODE.userClosed) {
    host.hidden = true;
    return false;
  }
  if (!appNodePosition()) return false;
  host.hidden = false;
  return true;
}
/* 画布宽度会因「左右边栏展开 / 助手栏 / 窗口缩放」而变：ResizeObserver 盯 #canvas，
   视图切换不改尺寸（display:none 除外），再补一个 body/layout class 观察。 */
function appNodeWatchLayout() {
  if (!APPNODE.ro && typeof ResizeObserver === "function") {
    const cv = document.getElementById("canvas");
    if (cv) {
      APPNODE.ro = new ResizeObserver(() => appNodeSync());
      APPNODE.ro.observe(cv);
    }
  }
  if (!APPNODE.mo && typeof MutationObserver === "function") {
    APPNODE.mo = new MutationObserver(() => appNodeSync());
    APPNODE.mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const layout = document.getElementById("layout");
    if (layout) APPNODE.mo.observe(layout, { attributes: true, attributeFilter: ["class", "style"] });
    const wrap = document.getElementById("wfWrap");
    if (wrap) APPNODE.mo.observe(wrap, { attributes: true, attributeFilter: ["style", "class"] });
    /* 切画布（点顶部标签）时先把浮层藏起来，不等 800ms 看门狗 —— 下一帧已经属于别的画布了。 */
    const tabs = document.getElementById("wfTabs");
    if (tabs) APPNODE.mo.observe(tabs, { attributes: true, attributeFilter: ["class"], subtree: true });
  }
}
/* 打开某个应用节点的界面：换节点 = 先停掉上一个（q20：同一时刻只允许一个） */
async function appNodeOpen(node) {
  if (!node || !node.appId) {
    if (node) appNodeOpenPicker(node);
    return;
  }
  if (node.appMissing) {
    appNodeShowMissing(node);
    return;
  }
  /* 应用在不在本机，以主进程的解析为准（目录被删 / 卸载 → 转提示页并把这个判定写回节点，
     卡片上随后就会出现「重新绑定」） */
  const api = appNodeApi();
  if (typeof api.appNodeResolve === "function") {
    let rr = null;
    try {
      rr = await api.appNodeResolve({ appId: String(node.appId) });
    } catch (_) {
      rr = null;
    }
    if (rr && rr.ok === false && rr.missing) {
      node.appMissing = true;
      if (typeof scheduleSave === "function") scheduleSave(true);
      appNodeShowMissing(node);
      return;
    }
  }
  const workdir = appNodeWorkdir();
  if (APPNODE.nodeId && APPNODE.nodeId !== node.id) appNodeDestroyFrame();
  appNodeEnsureHost();
  APPNODE.nodeId = node.id;
  APPNODE.appId = String(node.appId);
  APPNODE.wfId = appNodeNodeId();
  APPNODE.workdir = workdir;
  APPNODE.userClosed = false;
  apnodeBarPaint(node);
  if (APPNODE.hintEl) APPNODE.hintEl.hidden = true;
  appNodeSync();
  if (!APPNODE.frame) {
    const f = appNodeEl("iframe", "appnode-frame");
    f.setAttribute("allow", "clipboard-read; clipboard-write");
    f.setAttribute("spellcheck", "false");
    f.onload = () => {
      appNodePostReady();
    };
    APPNODE.host.querySelector(".appnode-body").appendChild(f);
    APPNODE.frame = f;
    appNodeLoadFrame(node);
    appNodeLoadData(node);
  } else {
    appNodePostReady();
  }
  appNodeStartWatcher();
  appNodePaintState(node.id, appNodeT("界面已打开（右上角 ✕ 收起）"));
  appNodeRepaintCard(node.id);
}
function apnodeBarPaint(node) {
  if (APPNODE.titleEl) APPNODE.titleEl.textContent = node.appTitle || node.appId || "";
  if (APPNODE.subEl) {
    const bits = [];
    if (APPNODE.workdir) bits.push(appNodeT("数据：") + String(node.appDataDir || ""));
    else bits.push(appNodeT("这张画布还没有工作目录：应用能开，但数据与文件接口不可用"));
    APPNODE.subEl.textContent = bits.join("  ");
  }
}
function appNodeLoadFrame(node) {
  const f = APPNODE.frame;
  if (!f) return;
  const entry = String(node.appEntry || "index.html").replace(/^\/+/, "");
  const url =
    "mtnode-preview://" +
    encodeURIComponent(String(node.appId)) +
    "/" +
    entry +
    "?_host=1&_anode=" +
    encodeURIComponent(String(node.appId)) +
    "&_t=" +
    Date.now().toString(36);
  f.src = url;
  APPNODE.ready = false;
  appNodeRegisterLease(node);
}
function appNodeReload() {
  const node = appNodeById(APPNODE.nodeId);
  if (!node) return;
  appNodeLoadFrame(node);
}
/* 预览租约（appHost 那一批能力靠它认「这一帧是哪个应用」）：
   与开发页预览共用同一条租约机制 —— 同一时刻只有一条，开新的就顶掉旧的。 */
async function appNodeRegisterLease(node) {
  const api = appNodeApi();
  if (typeof api.appsPreviewRegister !== "function") return;
  const token = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  APPNODE.token = token;
  try {
    await api.appsPreviewRegister({ appId: String(node.appId), token: token });
  } catch (_) {}
}
function appNodeReleaseLease() {
  const api = appNodeApi();
  if (APPNODE.token && typeof api.appsPreviewRelease === "function") {
    try {
      api.appsPreviewRelease({ token: APPNODE.token }).catch(() => {});
    } catch (_) {}
  }
  APPNODE.token = "";
}
function appNodePostReady() {
  const f = APPNODE.frame;
  if (!f || !f.contentWindow) return;
  const node = appNodeById(APPNODE.nodeId);
  const msg = {
    [APPNODE_K]: 1,
    op: "node-ready",
    appId: APPNODE.appId,
    nodeId: APPNODE.nodeId,
    workdir: APPNODE.workdir,
  };
  try {
    f.contentWindow.postMessage(msg, "*");
  } catch (_) {}
  if (node) {
    try {
      f.contentWindow.postMessage(
        { [APPNODE_PK]: 1, op: "host-ready", appId: APPNODE.appId, readOnly: false },
        "*",
      );
    } catch (_) {}
  }
  APPNODE.ready = true;
}
function appNodeClose() {
  const host = APPNODE.host;
  if (host) host.hidden = true;
  /* 关闭 = 回后台（不是停止）：下一帧仍活着，点卡片 / 回到这张画布都能继续。 */
  APPNODE.userClosed = true;
  appNodePaintState(APPNODE.nodeId, appNodeT("后台运行中 · 点这里回到界面"));
  appNodeRepaintCard();
}
/* 完全停止：撤租约 + 落盘 + 拆 iframe（与「关闭」不是一回事）。 */
function appNodeStop() {
  const nodeId = APPNODE.nodeId;
  appNodeDestroyFrame();
  APPNODE.userClosed = true;
  if (nodeId) {
    appNodePaintState(nodeId, appNodeT("已停止 · 点卡片重新启动"));
    appNodeRepaintCard(nodeId);
  }
  appNodeToast(appNodeT("应用已停止运行（数据已保存）"), "ok");
}
/* 真正停掉界面（节点被删 / 切画布 / 换节点 / 关应用前）：撤租约 + 拆 iframe */
function appNodeDestroyFrame() {
  appNodeReleaseLease();
  if (APPNODE.saveTimer) {
    clearTimeout(APPNODE.saveTimer);
    APPNODE.saveTimer = null;
  }
  /* 无论有没有待写的定时器，停止 / 销毁前都把内存里那份再落一次（写的是停止前的 appId）。 */
  appNodeFlushData();
  const f = APPNODE.frame;
  if (f) {
    try {
      f.src = "about:blank";
    } catch (_) {}
    f.remove();
  }
  APPNODE.frame = null;
  APPNODE.ready = false;
  APPNODE.nodeId = "";
  APPNODE.appId = "";
  APPNODE.wfId = "";
  APPNODE.data = {};
  APPNODE.dataLoaded = false;
  APPNODE.bound = "";
  if (APPNODE.host) APPNODE.host.hidden = true;
  if (APPNODE.watcher) {
    clearInterval(APPNODE.watcher);
    APPNODE.watcher = null;
  }
}
/* 应用不可用：界面里给一页提示（q9），不是白屏 */
function appNodeShowMissing(node) {
  if (APPNODE.frame) appNodeDestroyFrame();
  appNodeEnsureHost();
  APPNODE.nodeId = node.id;
  APPNODE.appId = String(node.appId || "");
  APPNODE.wfId = appNodeNodeId();
  APPNODE.userClosed = false;
  if (APPNODE.titleEl) APPNODE.titleEl.textContent = node.appTitle || node.appId || "";
  if (APPNODE.subEl) APPNODE.subEl.textContent = appNodeT("应用不可用");
  appNodeSync();
  let note = APPNODE.hintEl;
  if (note) {
    note.hidden = false;
    note.textContent =
      appNodeT("绑定的应用在本机找不到了（卸载 / 目录被删）。") +
      " " +
      appNodeT("在卡片上点「重新绑定」选一个应用，就会接着用新的那个。");
  }
  appNodeStartWatcher();
  appNodeRepaintCard(node.id);
}
/* 存活边界（q18/q19）：节点被删 / 切换到别的画布 / 节点改绑 → 收掉这一帧 */
function appNodeStartWatcher() {
  if (APPNODE.watcher) return;
  APPNODE.watcher = setInterval(() => {
    if (!APPNODE.nodeId) {
      appNodeDestroyFrame();
      return;
    }
    if (appNodeNodeId() !== APPNODE.wfId) {
      appNodeDestroyFrame();
      return;
    }
    const n = appNodeById(APPNODE.nodeId);
    if (!n || String(n.appId || "") !== APPNODE.appId) {
      appNodeDestroyFrame();
      return;
    }
    /* 看门狗兜底：RO / MutationObserver 都漏了的时刻（例如视图切换那一帧），
       800ms 内也一定把浮层藏掉；回到画布同一套判定会把它放回来。 */
    appNodeSync();
  }, 800);
}

/* ── 页面 → 父窗口：两条协议的分派 ───────────────────────────────────── */
window.addEventListener("message", (ev) => {
  const d = ev && ev.data;
  if (!d || typeof d !== "object") return;
  /* 只认当前这一帧（别处 / 已换掉的那一帧的调用一律不理） */
  if (!APPNODE.frame || ev.source !== APPNODE.frame.contentWindow) return;
  if (d[APPNODE_PK] === 1) {
    if (d.op === "host-ping") {
      appNodePostReady();
      return;
    }
    if (d.op === "host-call") {
      appNodeHostCall(d).catch(() => {});
      return;
    }
    if (d.op === "host-notice") return;
    return;
  }
  if (d[APPNODE_K] === 1) {
    if (d.op === "node-ping") {
      appNodePostReady();
      return;
    }
    if (d.op === "node-call") {
      appNodeNodeCall(d).catch(() => {});
    }
  }
});
function appNodePost(msg) {
  const f = APPNODE.frame;
  if (!f || !f.contentWindow) return;
  try {
    f.contentWindow.postMessage(msg, "*");
  } catch (_) {}
}
function appNodeEmit(name, data) {
  appNodePost({ [APPNODE_K]: 1, op: "node-event", name: String(name || ""), data: data || null });
}
/* appHost 那一批（模型 / 出图 / 转写 / 账号 / 选图）走既有预览租约通道，不重写一份 */
async function appNodeHostCall(d) {
  const api = appNodeApi();
  let r = null;
  try {
    r =
      typeof api.appsPreviewCall === "function"
        ? await api.appsPreviewCall({
            token: APPNODE.token,
            appId: APPNODE.appId,
            method: String(d.method || ""),
            arg: d.arg != null ? d.arg : {},
          })
        : { ok: false, code: "no_host", error: appNodeT("宿主桥不可用") };
  } catch (e) {
    r = { ok: false, code: "bridge_failed", error: String((e && e.message) || e) };
  }
  appNodePost({
    [APPNODE_PK]: 1,
    op: "host-result",
    id: d.id,
    ok: !(r && r.ok === false),
    result: r,
  });
}
async function appNodeNodeCall(d) {
  const ns = String(d.ns || "");
  const method = String(d.method || "");
  let out = null;
  const allow = APPNODE_METHODS[ns];
  if (!allow || allow.indexOf(method) < 0) {
    out = { ok: false, code: "not_allowed", error: appNodeT("这条能力没有开放给应用页面") };
  } else {
    try {
      const arg = d.arg != null ? d.arg : {};
      const fn = APPNODE_ROUTES[ns] && APPNODE_ROUTES[ns][method];
      out = fn ? await fn(arg) : { ok: false, code: "not_allowed", error: appNodeT("未知方法") };
    } catch (e) {
      out = { ok: false, code: "failed", error: String((e && e.message) || e) };
    }
  }
  appNodePost({ [APPNODE_K]: 1, op: "node-result", id: d.id, ok: !(out && out.ok === false), result: out });
}

/* ── 画布读写（全量，写操作入撤销栈） ─────────────────────────────────── */
function appNodeGraph() {
  const wf = (S && S.wf) || {};
  return {
    ok: true,
    wfId: String(wf.id || ""),
    workspace: String(wf.workspace || ""),
    nodes: appNodeClone(wf.nodes || []) || [],
    wires: appNodeClone(wf.wires || []) || [],
    groups: appNodeClone(wf.groups || []) || [],
    marks: appNodeClone(wf.marks || []) || [],
    selection: (S && S.sel) || null,
  };
}
function appNodeAfterWrite(extra) {
  if (typeof renderCanvas === "function") renderCanvas();
  if (typeof scheduleSave === "function") scheduleSave(true);
  appNodeEmit("canvas", { at: Date.now() });
  return Object.assign({ ok: true }, extra || {});
}
const APPNODE_ROUTES = {
  canvas: {
    graph: async () => appNodeGraph(),
    nodes: async () => ({ ok: true, nodes: appNodeClone((S.wf && S.wf.nodes) || []) || [] }),
    node: async (a) => {
      const n = appNodeById(String((a && a.id) || ""));
      return n ? { ok: true, node: appNodeClone(n) } : { ok: false, code: "missing", error: appNodeT("没有这个节点") };
    },
    addNode: async (a) => {
      const kind = String((a && a.kind) || "").trim();
      if (!kind) return { ok: false, code: "bad_arg", error: appNodeT("kind 必填") };
      if (typeof NODE_DEFAULTS === "object" && !NODE_DEFAULTS[kind])
        return { ok: false, code: "bad_kind", error: appNodeT("没有这种节点类型：") + kind };
      const extra = {};
      for (const k of Object.keys(a || {})) {
        if (k === "kind" || k === "x" || k === "y") continue;
        extra[k] = a[k];
      }
      const n = typeof addNode === "function" ? addNode(kind, Number(a.x) || 0, Number(a.y) || 0, extra) : null;
      if (!n) return { ok: false, code: "failed", error: appNodeT("建不出节点") };
      return appNodeAfterWrite({ id: n.id, node: appNodeClone(n) });
    },
    updateNode: async (a) => {
      const n = appNodeById(String((a && a.id) || ""));
      if (!n) return { ok: false, code: "missing", error: appNodeT("没有这个节点") };
      const patch = (a && a.patch) || {};
      if (typeof pushHistory === "function") pushHistory();
      for (const k of Object.keys(patch)) {
        if (k === "id" || k === "kind" || k === "__proto__" || k === "constructor") continue;
        n[k] = appNodeClone(patch[k]);
      }
      return appNodeAfterWrite({ node: appNodeClone(n) });
    },
    removeNode: async (a) => {
      const id = String((a && a.id) || "");
      const n = appNodeById(id);
      if (!n) return { ok: false, code: "missing", error: appNodeT("没有这个节点") };
      if (typeof pushHistory === "function") pushHistory();
      if (typeof deleteNode === "function") deleteNode(id);
      else {
        S.wf.nodes = (S.wf.nodes || []).filter((x) => x && x.id !== id);
        S.wf.wires = (S.wf.wires || []).filter((w) => w && w.from !== id && w.to !== id);
        S.sel = S.sel === id ? null : S.sel;
      }
      return appNodeAfterWrite({ id: id });
    },
    connect: async (a) => {
      const from = String((a && a.from) || "");
      const to = String((a && a.to) || "");
      if (!from || !to) return { ok: false, code: "bad_arg", error: appNodeT("from / to 必填") };
      if (!appNodeById(from) || !appNodeById(to))
        return { ok: false, code: "bad_arg", error: appNodeT("两端节点都要存在") };
      const w = {
        id: typeof uid === "function" ? uid("w") : appNodeNewId("w"),
        from: from,
        to: to,
        fromIndex: Number(a.fromIndex) || 0,
        toIndex: Number(a.toIndex) || 0,
      };
      if (typeof pushHistory === "function") pushHistory();
      S.wf.wires.push(w);
      return appNodeAfterWrite({ wire: appNodeClone(w) });
    },
    disconnect: async (a) => {
      const id = String((a && a.id) || "");
      if (!id) return { ok: false, code: "bad_arg", error: appNodeT("id 必填") };
      if (typeof pushHistory === "function") pushHistory();
      S.wf.wires = (S.wf.wires || []).filter((w) => w && w.id !== id);
      return appNodeAfterWrite({ id: id });
    },
    select: async (a) => {
      const ids = Array.isArray(a && a.ids) ? a.ids.map(String) : [];
      S.sel = ids[0] || null;
      S.selWire = null;
      if (typeof renderCanvas === "function") renderCanvas();
      return { ok: true, ids: ids };
    },
    view: async () => ({
      ok: true,
      x: Number((S.cam && S.cam.x) || 0),
      y: Number((S.cam && S.cam.y) || 0),
      z: Number((S.cam && S.cam.z) || 1),
    }),
    setView: async (a) => {
      if (!S.cam) S.cam = { x: 0, y: 0, z: 1 };
      if (Number.isFinite(Number(a.x))) S.cam.x = Number(a.x);
      if (Number.isFinite(Number(a.y))) S.cam.y = Number(a.y);
      if (Number.isFinite(Number(a.z))) S.cam.z = Math.max(0.2, Math.min(2.5, Number(a.z)));
      if (typeof renderCanvas === "function") renderCanvas();
      return { ok: true, x: S.cam.x, y: S.cam.y, z: S.cam.z };
    },
    save: async () => {
      if (typeof scheduleSave === "function") scheduleSave(true);
      return { ok: true };
    },
  },
  agent: {
    sessions: async () => {
      const list = typeof agentSessions === "function" ? agentSessions() || [] : [];
      return {
        ok: true,
        sessions: list.map((s) => ({
          id: String(s.id || ""),
          title: String(s.title || ""),
          busy: typeof agentSessionBusy === "function" ? !!agentSessionBusy(s) : !!s.running,
        })),
      };
    },
    bind: async (a) => {
      const sid = String((a && a.sessionId) || "").trim();
      const st = sid && typeof agentSessionById === "function" ? agentSessionById(sid) : null;
      if (!sid) return { ok: false, code: "bad_arg", error: appNodeT("sessionId 必填") };
      if (!st) return { ok: false, code: "missing", error: appNodeT("没有这条会话") };
      const n = appNodeById(APPNODE.nodeId);
      APPNODE.bound = sid;
      if (n) {
        if (typeof pushHistory === "function") pushHistory();
        n.appSessionId = sid;
        if (typeof scheduleSave === "function") scheduleSave(true);
      }
      return { ok: true, sessionId: sid, title: String(st.title || "") };
    },
    bound: async () => {
      const n = appNodeById(APPNODE.nodeId);
      const sid = String((n && n.appSessionId) || APPNODE.bound || "");
      const st = sid && typeof agentSessionById === "function" ? agentSessionById(sid) : null;
      return { ok: true, sessionId: sid, title: st ? String(st.title || "") : "" };
    },
    send: async (a) => {
      const text = String((a && a.text) || "").trim();
      if (!text) return { ok: false, code: "bad_arg", error: appNodeT("text 不能为空") };
      const n = appNodeById(APPNODE.nodeId);
      const sid = String((n && n.appSessionId) || APPNODE.bound || "");
      if (!sid) return { ok: false, code: "not_bound", error: appNodeT("先绑定一条会话：appHost.agent.bind(id)") };
      if (typeof agentSessionSend !== "function")
        return { ok: false, code: "no_agent", error: appNodeT("会话引擎不在这一版里") };
      appNodeEmit("agent", { phase: "start", sessionId: sid });
      let out = null;
      try {
        out = await agentSessionSend(text, { sessionId: sid });
      } catch (e) {
        appNodeEmit("agent", { phase: "error", sessionId: sid, error: String((e && e.message) || e) });
        return { ok: false, code: "failed", error: String((e && e.message) || e) };
      }
      appNodeEmit("agent", { phase: "done", sessionId: sid });
      const txt =
        typeof out === "string" ? out : out && typeof out.text === "string" ? out.text : "";
      return { ok: true, sessionId: sid, text: txt };
    },
    cancel: async () => {
      const n = appNodeById(APPNODE.nodeId);
      const sid = String((n && n.appSessionId) || APPNODE.bound || "");
      if (!sid) return { ok: false, code: "not_bound", error: appNodeT("还没有绑定会话") };
      if (typeof dshStopMark === "function") {
        try {
          dshStopMark("agent:" + sid, {});
        } catch (_) {}
      }
      return { ok: true, sessionId: sid };
    },
  },
  fs: {
    root: async () => ({ ok: true, root: appNodeWorkdir() }),
    readText: async (a) => appNodeFsCall("readText", a),
    writeText: async (a) => appNodeFsCall("writeText", a),
    list: async (a) => appNodeFsCall("list", a),
    mkdir: async (a) => appNodeFsCall("mkdir", a),
    remove: async (a) => appNodeFsCall("remove", a),
    exists: async (a) => appNodeFsCall("exists", a),
  },
  tools: {
    list: async () => {
      const api = appNodeApi();
      if (typeof api.backendRegistryList !== "function") return { ok: true, tools: [] };
      const r = await api.backendRegistryList();
      return { ok: true, tools: (r && r.items) || r || [] };
    },
    call: async (a) => {
      const api = appNodeApi();
      const id = String((a && a.id) || "");
      if (!id) return { ok: false, code: "bad_arg", error: appNodeT("id 必填") };
      if (typeof api.backendRegistryCall !== "function")
        return { ok: false, code: "no_host", error: appNodeT("工具通道不可用") };
      const r = await api.backendRegistryCall({ id: id, args: (a && a.args) || {} });
      return { ok: !(r && r.ok === false), result: r };
    },
  },
  net: {
    fetch: async (a) => {
      const api = appNodeApi();
      const url = String((a && a.url) || "");
      if (!/^https?:\/\//i.test(url)) return { ok: false, code: "bad_url", error: appNodeT("只支持 http(s)") };
      if (typeof api.netFetch !== "function") return { ok: false, code: "no_host", error: appNodeT("联网通道不可用") };
      const r = await api.netFetch(url);
      return { ok: !(r && r.ok === false), result: r };
    },
  },
  data: {
    read: async () => ({ ok: true, data: appNodeClone(APPNODE.data) || {}, dir: APPNODE.dataDir }),
    write: async (a) => {
      APPNODE.data = (a && a.data) || {};
      appNodeScheduleDataSave();
      return { ok: true };
    },
    dir: async () => ({ ok: true, dir: APPNODE.dataDir, file: APPNODE.dataFile }),
    openDir: async () => appNodeOpenDataDir(),
    storageGet: async (a) => {
      const k = String((a && a.key) || "");
      const v = APPNODE.data ? APPNODE.data[k] : undefined;
      return { ok: true, value: v === undefined ? null : v };
    },
    storageSet: async (a) => {
      if (!APPNODE.data || typeof APPNODE.data !== "object") APPNODE.data = {};
      APPNODE.data[String((a && a.key) || "")] = a && a.value != null ? a.value : null;
      appNodeScheduleDataSave();
      return { ok: true };
    },
    storageAll: async () => ({ ok: true, all: appNodeClone(APPNODE.data) || {} }),
    storageRemove: async (a) => {
      if (APPNODE.data && typeof APPNODE.data === "object") delete APPNODE.data[String((a && a.key) || "")];
      appNodeScheduleDataSave();
      return { ok: true };
    },
  },
};

async function appNodeFsCall(op, a) {
  const api = appNodeApi();
  const workdir = appNodeWorkdir();
  if (!workdir) return { ok: false, code: "no_workdir", error: appNodeT("这张画布还没有工作目录") };
  if (typeof api.appNodeFs !== "function") return { ok: false, code: "no_host", error: appNodeT("文件通道不可用") };
  const payload = { workdir: workdir, op: op, rel: String((a && a.rel) || "") };
  if (op === "writeText") payload.content = String((a && a.content) == null ? "" : a.content);
  return api.appNodeFs(payload);
}

/* ── 应用数据（工作目录里那一份）：读一次、改就排一次防抖写 ─────────────── */
async function appNodeLoadData(node) {
  const api = appNodeApi();
  APPNODE.dataLoaded = false;
  APPNODE.data = {};
  if (!node || !node.appId || !APPNODE.workdir) return;
  let r = null;
  try {
    r =
      typeof api.appNodeDataRead === "function"
        ? await api.appNodeDataRead({ appId: node.appId, workdir: APPNODE.workdir })
        : null;
  } catch (_) {
    r = null;
  }
  if (r && r.ok !== false) {
    APPNODE.data = r.data && typeof r.data === "object" ? r.data : {};
    APPNODE.dataDir = String(r.dir || "");
    APPNODE.dataFile = String(r.file || "");
    APPNODE.dataLoaded = true;
  }
}
function appNodeScheduleDataSave() {
  if (!APPNODE.dataLoaded) return;
  if (APPNODE.saveTimer) clearTimeout(APPNODE.saveTimer);
  APPNODE.saveTimer = setTimeout(() => {
    APPNODE.saveTimer = null;
    appNodeFlushData();
  }, 400);
}
async function appNodeFlushData() {
  const api = appNodeApi();
  if (!APPNODE.dataLoaded || !APPNODE.appId || !APPNODE.workdir) return;
  if (typeof api.appNodeDataWrite !== "function") return;
  try {
    await api.appNodeDataWrite({
      appId: APPNODE.appId,
      workdir: APPNODE.workdir,
      data: APPNODE.data || {},
    });
  } catch (_) {}
}
async function appNodeOpenDataDir() {
  const api = appNodeApi();
  const node = appNodeById(APPNODE.nodeId);
  const workdir = appNodeWorkdir();
  const appId = (node && node.appId) || APPNODE.appId;
  if (!appId) return { ok: false, code: "no_app", error: appNodeT("这个节点还没绑定应用") };
  if (!workdir) return { ok: false, code: "no_workdir", error: appNodeT("这张画布还没有工作目录") };
  if (typeof api.appNodeOpenDir !== "function") return { ok: false, code: "no_host", error: "" };
  return api.appNodeOpenDir({ appId: appId, workdir: workdir });
}

/* ── 外观 / 表补位（新类型的表格项） ─────────────────────────────────── */
function appNodeEnsureKindTables() {
  if (typeof NODE_DEFAULTS !== "object") return;
  if (!NODE_DEFAULTS.appnode) {
    NODE_DEFAULTS.appnode = {
      w: 340,
      h: 190,
      title: "应用",
      appId: "",
      appTitle: "",
      appEntry: "index.html",
      appDir: "",
      appDataDir: "",
      appDataFile: "",
      appMissing: false,
      appSessionId: "",
    };
  }
  if (typeof KIND_CLS === "object" && !KIND_CLS.appnode) KIND_CLS.appnode = "appnode";
  if (typeof KIND_TAGS === "object" && !KIND_TAGS.appnode) KIND_TAGS.appnode = "应用";
  if (typeof KIND_ICON_SVG === "object" && !KIND_ICON_SVG.appnode) {
    KIND_ICON_SVG.appnode =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3" width="11.6" height="9.6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M2.2 5.6h11.6" fill="none" stroke="currentColor" stroke-width="1" opacity=".65"/><circle cx="4" cy="4.3" r=".55" fill="currentColor"/><circle cx="5.7" cy="4.3" r=".55" fill="currentColor"/><path d="M6.1 8.2h3.9M6.1 10.4h2.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  }
}
appNodeEnsureKindTables();

/* Esc 收起界面（关闭只走 ✕ / Esc，点外面不关：持久浮层口径） */
window.addEventListener(
  "keydown",
  (ev) => {
    if (ev.key !== "Escape") return;
    const host = APPNODE.host;
    if (!host || host.hidden) return;
    if (APPNODE.picker) return;
    ev.preventDefault();
    appNodeClose();
  },
  true,
);
window.addEventListener("resize", () => appNodeSync());
/* 切画布 / 关窗口：这一帧立刻收（后台运行只在同一张画布内有效） */
window.addEventListener("beforeunload", () => appNodeDestroyFrame());
/* 视图切回画布时由 body class 的 MutationObserver 放回来；这里再兜一次启动期。 */
appNodeWatchLayout();

window.appNodeBuildBody = appNodeBuildBody;
window.appNodeOpen = appNodeOpen;
window.appNodeClose = appNodeClose;
window.appNodeStop = appNodeStop;
window.appNodeDestroyFrame = appNodeDestroyFrame;
window.appNodePick = appNodeOpenPicker;

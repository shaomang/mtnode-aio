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
    "form",
    "updateForm",
    "addNode",
    "updateNode",
    "removeNode",
    "connect",
    "disconnect",
    "select",
    "view",
    "setView",
    "save",
    /* 执行 / 取产物 / 终止（与主进程 app-host-bridge.js 的 NS_METHODS.canvas 同源） */
    "runNode",
    "nodeOutput",
    "cancelNode",
    /* 组（wf.groups）：应用把自己的链圈进一个组，免得节点散落。
       三条都只动组本身，不碰节点、不碰别人的组。 */
    "addGroup",
    "updateGroup",
    "removeGroup",
    /* 素材节点：显式调用才建（建立并绑定素材库里的一份素材） */
    "addAssetNode",
  ],
  agent: ["create", "sessions", "bind", "bound", "send", "cancel"],
  fs: ["root", "readText", "writeText", "list", "mkdir", "remove", "exists", "imageDataUrl"],
  audio: ["presets", "status", "synth", "cancel"],
  tools: ["list", "call"],
  net: ["fetch", "search", "download"],
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
/* 应用给的 outputPath → 画布工作目录里的绝对路径（**相对与绝对都收**，越界回空串）。
 * 为什么必须收绝对路径：应用常拿 fs.root() / 画布工作目录自己拼（如
 * `root + "/story2video-voice/trial-x.wav"`），那条路径本来就在工作目录里。以前这里一律拒绝对路径，
 * 于是桥回「只能写到画布工作目录里」，应用侧只看到「合成失败（宿主码 tts_failed）」，试听永远出不来。
 * 口径与 app-host-bridge.js 的 audio.synth 对齐：落在 wd 内就放行（Windows 不区分大小写），
 * 逃到 wd 外（`..` 越界 / 别的盘）才回 outside。渲染层没有 path 模块，这里按段归一化。 */
function appNodePathParts(p) {
  const s = String(p == null ? "" : p).replace(/\\/g, "/").trim();
  if (!s) return null;
  const out = [];
  const segs = s.split("/");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null; /* 已经在根上还要往上 = 越界，别静默拼出一个怪路径 */
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? out : null;
}
function appNodeResolveInWorkdir(wd, rel) {
  const base = appNodePathParts(wd);
  const raw = String(rel == null ? "" : rel).replace(/\\/g, "/");
  if (!base || !String(raw).trim()) return "";
  const absLike = /^[A-Za-z]:\//.test(raw) || raw.charAt(0) === "/";
  /* 相对路径挂在 wd 后面（保留 wd 的原始大小写）；绝对路径整体归一化，不做拼接 */
  const all = appNodePathParts(absLike ? raw : String(wd).replace(/\/+$/, "") + "/" + raw);
  if (!all || all.length < base.length) return "";
  for (let i = 0; i < base.length; i++)
    if (all[i].toLowerCase() !== base[i].toLowerCase()) return ""; /* 越过工作目录 = outside */
  return all.join("/");
}
function appNodeById(id) {
  try {
    return (S.wf.nodes || []).find((n) => n && n.id === id) || null;
  } catch (_) {
    return null;
  }
}
/* 组接口的 nodeIds 归一：去重、去空、只留字符串（组只存 id，不存节点对象） */
function appNodeGroupIds(v) {
  const out = [];
  (Array.isArray(v) ? v : []).forEach((x) => {
    const id = String(x == null ? "" : x).trim();
    if (id && out.indexOf(id) < 0) out.push(id);
  });
  return out;
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
  /* 绑定后整块卡片就是「进入应用」的按钮：加个类让 CSS 给出按钮底 + hover / 按下动效，
     用户一眼能看出这里可点（整块可点，不只是那行状态文字）。 */
  card.classList.add("appnode-card--cta");
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
/* 进应用界面前把画布上开着的浮层收掉：应用界面只盖画布区、z-index 820，
   而这些浮层都压在它上面（#refMenu 的 @ 引用候选 / 斜杠候选 = 998，节点浮层 = 900+），
   不收就会浮在应用界面之上（用户报的「进入应用界面，未隐藏画布中打开的引用」）。
   一律按调用期取函数：这些模块都比本文件早加载，取不到就跳过。 */
function appNodeHideCanvasPops() {
  try {
    if (typeof closeRefMenu === "function") closeRefMenu();
  } catch (_) {}
  try {
    if (typeof closeSlashMenu === "function") closeSlashMenu();
  } catch (_) {}
  try {
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");
  } catch (_) {}
  try {
    if (typeof hideCtx === "function") hideCtx();
  } catch (_) {}
  try {
    if (typeof window.hideNodeHelpTip === "function") window.hideNodeHelpTip();
  } catch (_) {}
}

/* 打开某个应用节点的界面：换节点 = 先停掉上一个（q20：同一时刻只允许一个） */
async function appNodeOpen(node) {
  if (!node || !node.appId) {
    if (node) appNodeOpenPicker(node);
    return;
  }
  appNodeHideCanvasPops();
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
/* 在应用中心里打开 / 点开**另一个**应用（独立窗口运行、详情窗）前，先把画布里开着的
   应用界面收掉 —— 口径与「收起」同一条：回后台继续跑（不撤租约、不拆 iframe、不二次确认）。
   同一个应用不动：那还是用户在看的那一页，收起来只会莫名其妙。
   调用期按 window 取（app-apps.js 比本文件早加载，直接引函数名会撞时序）。 */
function appNodeCollapseForOther(appId) {
  if (!APPNODE.nodeId) return false;
  if (!APPNODE.host || APPNODE.host.hidden) return false;
  if (appId && String(appId) === APPNODE.appId) return false;
  appNodeClose();
  return true;
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
  appNodeHideCanvasPops();
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
  /* 只在「用户正看着这张画布」时重绘：应用中心窗口可以后台改它绑定的那张画布
     （runAgainstWf 期间 S.wf 换手、_canvasEditVisible=false），此时重绘会把
     后台那张画进用户眼前（见 app-nodes.js 同一道守卫）。 */
  if (typeof renderCanvas === "function" && S._canvasEditVisible !== false) renderCanvas();
  if (typeof scheduleSave === "function") scheduleSave(true);
  appNodeEmit("canvas", { at: Date.now() });
  return Object.assign({ ok: true }, extra || {});
}
/* ── 表单节点（kind input_form）的读写口径 ─────────────────────────────────
 * 表单的值不是普通节点字段：它有自己的归一化（IF.normalize：补字段 / 媒体值形状 /
 * 默认值 / 计算列）与自己的落盘（<工作目录>/mtnode-forms/*.json，靠 mtime 判谁新）。
 * 应用直接改 node.values 而不走这一层时：① 画布板身不会重画（renderCanvas 走复用
 * 通道不重建 body）；② 磁盘还是旧文件，用户点节点头部「刷新」会按 mtime 把应用的
 * 写入整份盖回去。所以凡是应用写表单，都必须补这三步。 */
function appNodeFormIface() {
  try {
    return (typeof window !== "undefined" && window.IF) || null;
  } catch (_) {
    return null;
  }
}
function appNodeIsForm(n) {
  return !!(n && String(n.kind || "") === "input_form");
}
/* ── 合成表单：非 input_form 的节点（remotion / input_text / video_gen …）──────────────
 * 这些节点的「参数」不是表单值，而是节点自己的字段（duration / fps / size / providerId /
 * model / text …，真源 = NODE_DEFAULTS 与画布自己的设置窗）。应用侧此前一律走 canvas.form，
 * 于是一读就回 bad_kind「这个节点不是表单节点」（Remotion 工作台就是这么炸的：
 * 读一颗 kind:"remotion" 的节点永远拿到 bad_kind）。
 *
 * 这里按 npSchemaOf（= 参数端子那份「可覆写键表」，已滤掉结构 / 运行态字段）合成一张
 * **同形**表单：fields[{ key, label(= key), type, options }] / values / byLabel，
 * 并带 synthesized:true、formName = 节点 kind，调用方能分辨「真表单」与「合成视图」。
 *
 * 两条口径（用户共识）：
 *   ① label 就是节点键名（duration / fps / size …），中文名由调用方映射 —— 内核不维护
 *      第二张标签表，就不会跟设置窗漂；
 *   ② 字段给全量（schema 里能写的都给），界面只渲染它关心的几项；
 *      没有可写 schema 的节点（asset / super / input_image / deliver…）仍返回 null → 上游照旧回 bad_kind。
 * 数组 / 对象 / any 这三类键不给：单值控件写不回去，写坏了还不如不列。 */
const APP_NODE_PARAM_TYPES = { number: "number", boolean: "boolean", string: "string" };
/* 少数键在画布里有现成的选项表：给了它，界面还是下拉，不会手敲出非法尺寸。
   只登记这一张（remotion.size），别的键一律当自由文本。 */
function appNodeParamOptions(n, key) {
  if (!n || String(n.kind || "") !== "remotion" || key !== "size") return null;
  try {
    return typeof REMOTION_SIZES !== "undefined" && Array.isArray(REMOTION_SIZES) ? REMOTION_SIZES.slice() : null;
  } catch (_) {
    return null;
  }
}
/* 纯文本节点（input_text / proc_text / text）：设置窗里没有「参数」表单，npSchemaOf 回空表，
   而 `text` 又在全局禁写名单里（它是内容主体，不是配置）。但提示词的真源就是它的 text，
   应用必须能读写 —— 所以这三类固定给一个 text 字段（键名 / 标签都是 text）。 */
const APP_NODE_TEXT_KINDS = { input_text: 1, proc_text: 1, text: 1 };
/* 节点 → 合成表单（null = 这个节点没有可写的参数，调用方照旧报 bad_kind） */
function appNodeSynthesizeForm(n) {
  if (!n || typeof npSchemaOf !== "function") return null;
  let schema = [];
  try {
    schema = npSchemaOf(n) || [];
  } catch (_) {
    schema = [];
  }
  const fields = [];
  const values = {};
  const byLabel = {};
  for (const s of schema) {
    if (!s || !s.key) continue;
    const type = String(s.type || "");
    if (!APP_NODE_PARAM_TYPES[type]) continue;
    const cur = n[s.key] !== undefined ? n[s.key] : s.def;
    let v;
    if (cur === undefined || cur === null) v = type === "number" ? 0 : type === "boolean" ? false : "";
    else if (typeof cur === "object") continue;
    else v = cur;
    const key = String(s.key);
    fields.push({ id: key, key: key, label: key, type: type, options: appNodeParamOptions(n, key), value: v });
    values[key] = v;
    byLabel[key] = v;
  }
  /* 文本节点：正文不在白名单里，补在最前面（应用的提示词读写只认这一个字段） */
  if (APP_NODE_TEXT_KINDS[String(n.kind || "")] && !fields.some((f) => f.key === "text")) {
    const txt = n.text == null ? "" : String(n.text);
    fields.unshift({ id: "text", key: "text", label: "text", type: "string", options: null, value: txt });
    values.text = txt;
    byLabel.text = txt;
  }
  if (!fields.length) return null;
  return {
    form: String(n.kind || ""),
    fields: fields,
    values: values,
    byLabel: byLabel,
    refs: [],
    meta: { nodeId: String(n.id || ""), synthesized: true },
  };
}
/* 合成表单写回：值按 schema 类型转一次（number / boolean / string），转不动的进 ignored，
   绝不把 NaN / "[object Object]" 塞进节点字段。 */
function appNodeCoerceParam(field, v) {
  const t = String((field && field.type) || "");
  if (t === "number") {
    if (typeof v === "boolean" || v === "") return { ok: false };
    const num = Number(v);
    return isFinite(num) ? { ok: true, value: num } : { ok: false };
  }
  if (t === "boolean") {
    if (typeof v === "string") return { ok: true, value: v === "true" || v === "1" || v === "on" };
    return { ok: true, value: !!v };
  }
  if (v === undefined || v === null) return { ok: true, value: "" };
  if (typeof v === "object") return { ok: false };
  return { ok: true, value: String(v) };
}
/* 归一化 + 落盘 + 重画板身。返回 { normalized, saved }（saved 是 IF.writeFile 的回执） */
async function appNodeFinishFormWrite(n) {
  const IF = appNodeFormIface();
  let normalized = false;
  let saved = null;
  if (IF && typeof IF.normalize === "function") {
    try {
      IF.normalize(n);
      normalized = true;
    } catch (_) {}
  }
  n.formStamp = Date.now();
  if (IF && typeof IF.writeFile === "function") {
    try {
      saved = await IF.writeFile(n, { silent: true });
    } catch (e) {
      saved = { ok: false, error: String((e && e.message) || e) };
    }
  }
  /* 板身重画放在落盘之后：writeFile 会顺手刷新 formMtime / formFile，
     先重画再落盘时卡片上那行「已写入」状态会是旧的。 */
  if (typeof refreshNodeBody === "function") {
    try {
      refreshNodeBody(n);
    } catch (_) {}
  }
  return { normalized: normalized, saved: saved };
}
/* 表单值按「字段 id 或字段标签」认字段：应用多半只记得标签 */
function appNodeFieldOf(n, key) {
  const k = String(key == null ? "" : key);
  if (!k) return null;
  for (const f of (n && n.fields) || []) {
    if (f && (String(f.id) === k || String(f.label) === k)) return f;
  }
  return null;
}
/* ── 应用侧「工具」= 注册中心登记的工具 + 已安装的插件本机后端 ──────────────────
 * 插件后端（breeze / qwen-image / flux3-klein / h3 / music3 …）不进注册表（启停走插件界面），
 * 但应用要**看得见**它们、并且能按 id 调到真正能跑的那一段，否则应用永远只看到一张空清单
 * （截图里那句「没有匹配到 breeze 工具」就是这么来的）。
 *   · qwen-image-local / flux3-klein-local → 本机出图（window.api.*Generate，与画布节点同一条出口）
 *   · breeze-tts-local → 音色清单（window.api.breezePresets，Breeze 预设的真源）
 *   · 其余插件后端 → 如实回 not_callable（应用会改派 agent，不装成功） */
async function appNodeToolList() {
  const api = appNodeApi();
  if (typeof api.backendRegistryList !== "function") return [];
  let r = null;
  try {
    r = await api.backendRegistryList();
  } catch (_) {
    return [];
  }
  const out = Array.isArray(r && r.items) ? r.items.slice() : [];
  const plugins = Array.isArray(r && r.plugins) ? r.plugins : [];
  for (const p of plugins) {
    if (!p || !p.id || !p.installed) continue;
    const id = String(p.id);
    if (out.some((x) => String((x && x.id) || "") === id)) continue;
    out.push({
      id: id,
      name: String(p.name || id),
      title: String(p.name || id),
      kind: String(p.kind || "plugin"),
      desc: String(p.desc || ""),
      installDir: String(p.installDir || ""),
      managed: "plugin",
      installed: true,
    });
  }
  return out;
}
async function appNodeToolCall(id, args) {
  const api = appNodeApi();
  const tool = String(id || "");
  const a = args && typeof args === "object" ? args : {};
  if (tool === "qwen-image-local" || tool === "flux3-klein-local") {
    const fn = tool === "qwen-image-local" ? api.qwenimageGenerate : api.flux3kleinGenerate;
    if (typeof fn !== "function")
      return { ok: false, code: "no_host", error: appNodeT("这个本机出图后端不在这一版里") };
    let r = null;
    try {
      r = await fn(a);
    } catch (e) {
      return { ok: false, code: "failed", error: String((e && e.message) || e) };
    }
    if (!r || r.ok === false)
      return {
        ok: false,
        code: String((r && r.error) || "local_failed"),
        error: String((r && r.message) || (r && r.error) || appNodeT("本机出图失败")),
      };
    return { ok: true, result: r, path: String(r.path || ""), seconds: r.seconds };
  }
  if (tool === "breeze-tts-local") {
    if (typeof api.breezePresets !== "function")
      return { ok: false, code: "no_host", error: appNodeT("Breeze 本机后端不在这一版里") };
    let r = null;
    try {
      r = await api.breezePresets();
    } catch (e) {
      return { ok: false, code: "failed", error: String((e && e.message) || e) };
    }
    if (r && r.ok === false) return { ok: false, code: "failed", error: String(r.error || "presets_failed") };
    const presets = Array.isArray(r && r.presets) ? r.presets : [];
    return {
      ok: true,
      voices: presets.filter((x) => x && x.id).map((x) => ({ id: String(x.id), name: String(x.name || x.id) })),
      presets: presets,
    };
  }
  if (typeof api.backendRegistryCall !== "function")
    return { ok: false, code: "no_host", error: appNodeT("工具通道不可用") };
  let r = null;
  try {
    r = await api.backendRegistryCall({ id: tool, args: a });
  } catch (e) {
    return { ok: false, code: "failed", error: String((e && e.message) || e) };
  }
  return { ok: !(r && r.ok === false), result: r, error: r && r.error, code: r && r.code };
}

/* ── 节点执行 / 产物读取（appHost.canvas 的 runNode · nodeOutput · cancelNode）────
 * 现场：应用能在自己那张画布上建图像节点、连线、改表单，但**跑不了、也拿不到产物** ——
 * 应用侧原来只有一条 appHost.imageGen（单张、无画布节点），画布上的 proc_image /
 * qwenimage_gen / flux3klein_gen 与它们的参考图、比例、抽卡、后处理一条都用不上。
 * 这三条把「执行」那段补齐（用户共识，改之前先看）：
 *   ① runNode = 用户手点 ▶ 的**同一条路**（playNode）：上游未处理自动补齐、级联、运行态 /
 *      进度、产物落画布资产目录，全部同源。只多两件事 ——
 *        · **不弹工作目录窗**（用户不在这个窗口里等着）：缺目录直接回 no_workspace；
 *        · 本次出几张由调用决定（默认 1 张，不继承节点存着的多次尝试），跑完把原值还回去。
 *   ② nodeOutput = 读该节点**最近一次运行**的产物。三种真源（node.output /
 *      batchOutputs / attemptOutputs）统一成一份 artifacts + 元数据，应用不必自己扒字段。
 *   ③ cancelNode = 画布上的「终止」（stopNode）：这颗节点上在跑的都停（含用户手点那次）。
 * 任意 kind 都能跑（用户共识）：save 会真写盘、控制类会改画布状态，宿主如实回执、不设白名单。
 */
function appNodeArtifactList(n) {
  const list = [];
  const push = (o, extra) => {
    const src = o && typeof o === "object" ? o : null;
    if (!src) return;
    const kind = String(src.kind || "");
    const p = String(src.path || "");
    const text = String(src.text || "");
    if (!kind && !p && !text) return;
    list.push(Object.assign({ kind: kind, path: p, text: text }, extra || {}));
  };
  const batchOf = (arr, extra) => {
    (Array.isArray(arr) ? arr : []).forEach((b, i) =>
      push(
        b && b.output,
        Object.assign(
          {
            item: String((b && b.title) || ""),
            itemIndex: i + 1,
            ok: !!(b && b.ok),
            itemError: String((b && b.error) || ""),
          },
          extra || {},
        ),
      ),
    );
  };
  const attempts = Array.isArray(n.attemptOutputs) && n.attemptOutputs.length ? n.attemptOutputs : null;
  if (attempts) {
    attempts.forEach((a, t) => {
      if (!a) return;
      const base = { attempt: t + 1, error: String(a.error || "") };
      const batch = Array.isArray(a.batchOutputs) ? a.batchOutputs : [];
      if (batch.length) batchOf(batch, base);
      else push(a.output, base);
    });
    return list;
  }
  const batch = Array.isArray(n.batchOutputs) ? n.batchOutputs : [];
  if (batch.length) {
    batchOf(batch, { attempt: 1 });
    return list;
  }
  push(n.output, { attempt: 1 });
  /* 保存节点：「最近一次产物」就是它写出去的那些文件（savedPaths 才是真源） */
  const saved = Array.isArray(n.savedPaths) && n.savedPaths.length ? n.savedPaths : n.savedPath ? [n.savedPath] : [];
  for (const p of saved) push({ kind: "file", path: String(p || "") }, { attempt: 1, saved: true });
  return list;
}
/* 产物回执：artifacts（带 kind / path / text / attempt / item）+ images（纯图像绝对路径）
   + paths + meta（seed / size / model / provider / attempts）。路径一律是**本机绝对路径**。 */
function appNodeOutputPayload(n, extra) {
  const arts = appNodeArtifactList(n);
  const paths = arts.filter((a) => !!a.path).map((a) => a.path);
  return Object.assign(
    {
      nodeId: String(n.id || ""),
      title: String(n.title || ""),
      kind: String(n.kind || ""),
      running: !!n.running,
      error: String(n.error || ""),
      ranAt: Number(n.ranAt) || 0,
      artifacts: arts,
      images: arts.filter((a) => a.path && a.kind === "image").map((a) => a.path),
      paths: paths,
      meta: {
        model: String(n.model || ""),
        provider: String(n.providerId || ""),
        size: String(n.size || ""),
        seed: n.seed == null ? null : n.seed,
        attempts: Array.isArray(n.attemptOutputs) && n.attemptOutputs.length ? n.attemptOutputs.length : 1,
        /* 哪几轮没出成（只记错误，不混进 artifacts）：应用能区分「抽 3 张只成 2 张」 */
        attemptErrors: (Array.isArray(n.attemptOutputs) ? n.attemptOutputs : [])
          .map((a, t) => ({ attempt: t + 1, error: String((a && a.error) || "") }))
          .filter((x) => !!x.error),
        hasOutput: arts.length > 0,
      },
    },
    extra || {},
  );
}

const APPNODE_ROUTES = {
  canvas: {
    graph: async () => appNodeGraph(),
    nodes: async () => ({ ok: true, nodes: appNodeClone((S.wf && S.wf.nodes) || []) || [] }),
    node: async (a) => {
      const n = appNodeById(String((a && a.id) || ""));
      return n ? { ok: true, node: appNodeClone(n) } : { ok: false, code: "missing", error: appNodeT("没有这个节点") };
    },
    /* 读表单节点的内容：{ formName, fields, values, file, nodeId }（比 node() 少一大半：
       不带坐标 / 尺寸 / 运行态这些画布字段，应用不用自己扒 node.values） */
    form: async (a) => {
      const n = appNodeById(String((a && a.id) || ""));
      if (!n) return { ok: false, code: "missing", error: appNodeT("没有这个节点") };
      if (!appNodeIsForm(n)) {
        /* 非表单节点：有可写 schema 就合成一张同形表单（见 appNodeSynthesizeForm）。
           没有 schema 的（asset / super / save…）照旧回 bad_kind —— 不假装能改。 */
        const syn = appNodeSynthesizeForm(n);
        if (!syn)
          return { ok: false, code: "bad_kind", error: appNodeT("这个节点不是表单节点") };
        return {
          ok: true,
          nodeId: String(n.id || ""),
          formName: syn.form,
          fields: syn.fields,
          values: syn.values,
          refs: [],
          meta: syn.meta,
          file: "",
          byLabel: syn.byLabel,
          synthesized: true,
        };
      }
      const IF = appNodeFormIface();
      let form = null;
      if (IF && typeof IF.normalize === "function") {
        try {
          IF.normalize(n);
        } catch (_) {}
      }
      form =
        IF && typeof IF.payload === "function"
          ? appNodeClone(IF.payload(n))
          : {
              form: n.formName || "",
              fields: appNodeClone(n.fields || []) || [],
              values: appNodeClone(n.values || {}) || {},
              refs: appNodeClone(n.refs || []) || [],
              meta: { nodeId: n.id, updatedAt: n.formStamp || 0 },
            };
      const f = form || {};
      return {
        ok: true,
        nodeId: String(n.id || ""),
        formName: String(f.form || n.formName || ""),
        fields: f.fields || [],
        values: f.values || {},
        refs: f.refs || [],
        meta: f.meta || {},
        file: String(n.formFile || ""),
        /* 便捷索引：按字段标签取值（同名字段只留第一个），应用不必自己遍历 fields */
        byLabel: (function () {
          const out = {};
          for (const fd of f.fields || []) {
            if (fd && fd.label && !(String(fd.label) in out)) out[String(fd.label)] = (f.values || {})[fd.id];
          }
          return out;
        })(),
        synthesized: false,
      };
    },
    /* 写表单节点的值：values 只给要改的字段（键认字段 id 或字段标签），其余字段原样保留。
       写完按表单自己的口径归一化 + 落进 mtnode-forms/*.json + 重画板身（见 appNodeFinishFormWrite）。
       非表单节点（合成表单）：values 的键 = 节点字段名，按 schema 类型转一次再写进节点。 */
    updateForm: async (a) => {
      const n = appNodeById(String((a && a.id) || ""));
      if (!n) return { ok: false, code: "missing", error: appNodeT("没有这个节点") };
      if (!appNodeIsForm(n)) {
        const syn = appNodeSynthesizeForm(n);
        if (!syn)
          return { ok: false, code: "bad_kind", error: appNodeT("这个节点不是表单节点") };
        const v = (a && a.values) || null;
        if (!v || typeof v !== "object" || Array.isArray(v))
          return { ok: false, code: "bad_arg", error: appNodeT("values 必填（{ 字段id或标签: 值 }）") };
        const byKey = Object.create(null);
        for (const f of syn.fields) byKey[String(f.key)] = f;
        const writes = [];
        const ignored = [];
        for (const k of Object.keys(v)) {
          const f = byKey[String(k)];
          if (!f) {
            ignored.push(String(k));
            continue;
          }
          const c = appNodeCoerceParam(f, v[k]);
          if (!c.ok) {
            ignored.push(String(k));
            continue;
          }
          writes.push({ field: f, value: c.value });
        }
        if (!writes.length)
          return {
            ok: false,
            code: "no_field",
            error: appNodeT("这些键都不是这张表单的字段"),
            ignored: ignored,
            synthesized: true,
          };
        if (typeof pushHistory === "function") pushHistory();
        const written = [];
        for (const w of writes) {
          n[w.field.key] = w.value;
          written.push({ id: String(w.field.key), label: String(w.field.label), key: String(w.field.key) });
        }
        /* 板身上那几行（时长 / 分辨率）要跟着变：先就地重建 body，再走统一收尾（重绘 + 落盘） */
        if (typeof refreshNodeBody === "function") {
          try {
            refreshNodeBody(n);
          } catch (_) {}
        }
        const after = {};
        for (const f of syn.fields) after[f.key] = n[f.key] === undefined ? f.value : n[f.key];
        return appNodeAfterWrite({
          node: appNodeClone(n),
          values: after,
          byLabel: after,
          written: written,
          ignored: ignored,
          synthesized: true,
        });
      }
      const vals = a && a.values;
      if (!vals || typeof vals !== "object" || Array.isArray(vals))
        return { ok: false, code: "bad_arg", error: appNodeT("values 必填（{ 字段id或标签: 值 }）") };
      const IF = appNodeFormIface();
      if (IF && typeof IF.normalize === "function") {
        try {
          IF.normalize(n);
        } catch (_) {}
      }
      if (typeof pushHistory === "function") pushHistory();
      if (!n.values || typeof n.values !== "object") n.values = {};
      const written = [];
      const ignored = [];
      for (const k of Object.keys(vals)) {
        const f = appNodeFieldOf(n, k);
        if (!f) {
          ignored.push(String(k));
          continue;
        }
        n.values[f.id] = appNodeClone(vals[k]);
        written.push({ id: String(f.id), label: String(f.label || ""), key: String(k) });
      }
      if (!written.length)
        return {
          ok: false,
          code: "no_field",
          error: appNodeT("这些键都不是这张表单的字段"),
          ignored: ignored,
        };
      const fin = await appNodeFinishFormWrite(n);
      const out = appNodeAfterWrite({
        node: appNodeClone(n),
        values: appNodeClone(n.values) || {},
        written: written,
        ignored: ignored,
      });
      out.formSaved = !!(fin.saved && fin.saved.ok !== false);
      if (fin.saved && fin.saved.ok === false) {
        out.formSaveError = String(fin.saved.error || "");
        out.formSaveCode = String(fin.saved.error || "");
      }
      return out;
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
      /* 表单节点：values / fields 改了要按表单自己的口径补齐并落盘（否则板身不重画、
         磁盘旧文件还会在下次「刷新」把应用写进来的值盖回去） */
      let fin = null;
      if (appNodeIsForm(n) && ("values" in patch || "fields" in patch)) {
        fin = await appNodeFinishFormWrite(n);
      }
      const out = appNodeAfterWrite({ node: appNodeClone(n) });
      if (fin) {
        out.formSaved = !!(fin.saved && fin.saved.ok !== false);
        if (fin.saved && fin.saved.ok === false) out.formSaveError = String(fin.saved.error || "");
      }
      return out;
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
    /* ── 素材节点：应用显式调用才建一颗绑定素材库条目的节点（不自动往画布摆东西）
     *   addAssetNode({ id?（素材 id）, rel?（库内相对路径）, x?, y? }) → { ok, id, node }
     * id / rel 二选一；绑定走与界面「插入到画布」同一个口径（assetApplyBinding），
     * 撤销栈只压一次；落点缺省取当前视图里的常规位置。 */
    addAssetNode: async (a) => {
      const id = String((a && a.id) || "").trim();
      const rel = String((a && a.rel) || "").trim();
      if (!id && !rel)
        return { ok: false, code: "bad_arg", error: appNodeT("id 或 rel 必填（素材库里的素材 id / 相对路径）") };
      const scan = typeof assetScanCall === "function" ? await assetScanCall() : await window.api.assetsScan();
      if (!scan || scan.ok === false)
        return { ok: false, code: "no_library", error: String((scan && scan.error) || appNodeT("读取素材库失败")) };
      const list = (scan.scan && scan.scan.assets) || [];
      const norm = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
      let asset = id ? list.find((x) => String(x.id) === id) || null : null;
      if (!asset && rel)
        asset =
          list.find((x) => norm(x.rel) === norm(rel)) ||
          list.find((x) => norm(x.rel).endsWith("/" + norm(rel))) ||
          null;
      if (!asset)
        return { ok: false, code: "missing", error: appNodeT("素材库里没有这个素材：") + (id || rel) };
      if (typeof NODE_DEFAULTS === "undefined" || !NODE_DEFAULTS.asset)
        return { ok: false, code: "bad_kind", error: appNodeT("素材节点尚未就绪") };
      const hasPos =
        a && Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y));
      const p = hasPos
        ? { x: Number(a.x), y: Number(a.y) }
        : typeof assetSpawnPoint === "function"
          ? assetSpawnPoint()
          : { x: 0, y: 0 };
      if (typeof pushHistory === "function") pushHistory();
      const node =
        typeof addNode === "function"
          ? addNode("asset", p.x, p.y, { title: asset.displayName || asset.folder || appNodeT("素材") })
          : null;
      if (!node) return { ok: false, code: "failed", error: appNodeT("建不出素材节点") };
      if (typeof assetApplyBinding === "function")
        assetApplyBinding(node, asset, { history: false, quiet: true });
      else if (typeof assetBindNode === "function") assetBindNode(node, asset);
      else return { ok: false, code: "failed", error: appNodeT("素材绑定未就绪") };
      return appNodeAfterWrite({ id: node.id, node: appNodeClone(node), asset: { id: asset.id, rel: asset.rel } });
    },
    /* ── 组（wf.groups = { id, title, nodeIds, markIds }）─────────────────────
     * 应用在画布上建完自己的链要能圈起来（画布上「绘制」只剩文本，归类节点用组；
     * 见 app-canvas.js 顶部注释与「成组」快捷键 G）。
     *   · addGroup({ title, nodeIds })            → { ok, id, group }
     *   · updateGroup({ id, title?, nodeIds? })   → { ok, id, group }（成员是全量替换）
     *   · removeGroup({ id })                     → { ok, id, removed:true }（只删组，节点全留）
     * 纪律：只接受真实存在的节点 id；只动这一个组，节点与别人的组一概不碰；
     * 组空着不回收（回收是画布自己的 pruneEmptyGroups 在删节点时做的）。
     */
    addGroup: async (a) => {
      const title = String((a && (a.title || a.name)) || "").trim() || appNodeT("组");
      const ids = appNodeGroupIds(a && a.nodeIds);
      if (!ids.length) return { ok: false, code: "bad_arg", error: appNodeT("nodeIds 至少要有一个节点") };
      const missing = ids.filter((id) => !appNodeById(id));
      if (missing.length)
        return { ok: false, code: "bad_arg", error: appNodeT("这些节点不存在：") + missing.join(", ") };
      if (!Array.isArray(S.wf.groups)) S.wf.groups = [];
      const g = { id: appNodeNewId("g"), title: title, nodeIds: ids.slice(), markIds: [] };
      if (typeof pushHistory === "function") pushHistory();
      S.wf.groups.push(g);
      return appNodeAfterWrite({ id: g.id, group: appNodeClone(g) });
    },
    updateGroup: async (a) => {
      const id = String((a && a.id) || "");
      const g = (S.wf.groups || []).find((x) => x && x.id === id) || null;
      if (!g) return { ok: false, code: "missing", error: appNodeT("没有这个组") };
      const hasTitle = a && (a.title != null || a.name != null);
      const hasIds = a && a.nodeIds != null;
      if (!hasTitle && !hasIds) return { ok: false, code: "bad_arg", error: appNodeT("title / nodeIds 至少给一个") };
      let ids = [];
      if (hasIds) {
        ids = appNodeGroupIds(a.nodeIds);
        if (!ids.length) return { ok: false, code: "bad_arg", error: appNodeT("nodeIds 至少要有一个节点") };
        const missing = ids.filter((nid) => !appNodeById(nid));
        if (missing.length)
          return { ok: false, code: "bad_arg", error: appNodeT("这些节点不存在：") + missing.join(", ") };
      }
      if (typeof pushHistory === "function") pushHistory();
      if (hasTitle) g.title = String(a.title != null ? a.title : a.name).trim() || g.title || appNodeT("组");
      if (hasIds) {
        if (!Array.isArray(g.markIds)) g.markIds = [];
        g.nodeIds = ids.slice();
      }
      return appNodeAfterWrite({ id: g.id, group: appNodeClone(g) });
    },
    removeGroup: async (a) => {
      const id = String((a && a.id) || "");
      const groups = Array.isArray(S.wf.groups) ? S.wf.groups : [];
      const hit = groups.find((x) => x && x.id === id) || null;
      if (!hit) return { ok: false, code: "missing", error: appNodeT("没有这个组") };
      if (typeof pushHistory === "function") pushHistory();
      S.wf.groups = groups.filter((x) => !x || x.id !== id);
      /* 组线（从组拖出的线）一并摘掉：与画布上「解散组」同一口径，不留指向空组的线 */
      if (typeof removeGroupWires === "function") {
        try {
          removeGroupWires(id);
        } catch (_) {}
      }
      return appNodeAfterWrite({ id: id, removed: true });
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
    /* 真跑一颗节点：用户手点 ▶ 的同一条路（playNode）。约定：
       · 上游未处理的自动补齐、级联、运行态 / 进度、产物落画布资产目录 —— 全部同源；
       · opts.attempts = 本次出几张（1-10，默认 1，**不继承**节点存着的多次尝试）；
         跑完把节点原来的 attempts 还回去（应用这一次的临时口径不写回画布设置）；
       · 已在跑的那一次：playNode 自己 await 它，然后直接回那一轮的产物（不重复出图、不多花钱）；
       · 没有工作目录：回 no_workspace，**不弹窗**（用户不在这个窗口里，弹窗会挂死等待）；
       · 被 cancelNode（= 画布「终止」）打掉的：回 ok:false + code:"cancelled"，
         已落盘的产物仍在 nodeOutput 里取得到。 */
    runNode: async (a) => {
      const n = appNodeById(String((a && a.id) || ""));
      if (!n) return { ok: false, code: "missing", error: appNodeT("没有这个节点") };
      let ws = null;
      try {
        ws = typeof workspaceIssueOfNode === "function" ? await workspaceIssueOfNode(n) : null;
      } catch (_) {
        ws = null;
      }
      if (ws && !ws.ok) {
        return {
          ok: false,
          code: "no_workspace",
          error: ws.missing
            ? appNodeT("这个节点用的工作目录已经不存在：") + String(ws.raw || "")
            : appNodeT("这张画布还没有工作目录：先在 MTNode 顶栏给画布选一个文件夹，或让应用 canvas.pick() 换一张"),
          nodeId: String(n.id || ""),
        };
      }
      const want = Math.max(1, Math.min(10, Math.floor(Number(a && a.attempts) || 1)));
      /* 这颗节点上已经有运行在飞（用户手点 ▶ 或上一次 runNode）：那一轮已经按它自己的
         设置跑起来了，**不中途改它的 attempts**（改了会打乱正在抽的那一轮），
         只等它结束、直接回它那轮的产物。 */
      const busy =
        !!n.running ||
        !!(typeof isNodePending === "function" && isNodePending(n));
      const prevAttempts = n.attempts;
      const t0 = Date.now();
      let threw = "";
      try {
        if (!busy) {
          if (typeof pushHistory === "function") pushHistory();
          n.attempts = want;
        }
        if (typeof isSaveNode === "function" && isSaveNode(n)) {
          if (typeof saveNodeAction === "function") await saveNodeAction(n, { skipWsGate: true });
          else if (typeof playNode === "function") await playNode(n, false, {});
        } else if (typeof playNode === "function") {
          await playNode(n, false, {});
        } else {
          throw new Error(appNodeT("画布执行器未加载"));
        }
      } catch (e) {
        threw = String((e && e.message) || e);
      } finally {
        n.attempts = prevAttempts;
        /* 与手动执行一致：产物 / 运行态当场落盘（关掉画布再打开不丢） */
        if (typeof scheduleSave === "function") scheduleSave(true);
        if (typeof renderCanvas === "function" && S._canvasEditVisible !== false) renderCanvas();
      }
      const out = appNodeOutputPayload(n, { elapsedMs: Date.now() - t0 });
      if (n._aborted) return Object.assign(out, { ok: false, code: "cancelled", error: appNodeT("已终止（这个节点上在跑的那次被停了）") });
      if (threw) return Object.assign(out, { ok: false, code: "run_failed", error: threw });
      if (String(n.error || "")) return Object.assign(out, { ok: false, code: "run_failed", error: String(n.error) });
      if (!out.artifacts.length) return Object.assign(out, { ok: false, code: "no_output", error: appNodeT("节点跑完了但没有产物") });
      return Object.assign(out, { ok: true });
    },
    /* 读该节点**最近一次运行**的产物（与 runNode 的回执同一份形状）：
       不在跑也能读；从没跑过 → ok:true 但 artifacts 为空（hasOutput=false），不算错误。 */
    nodeOutput: async (a) => {
      const n = appNodeById(String((a && a.id) || ""));
      if (!n) return { ok: false, code: "missing", error: appNodeT("没有这个节点") };
      return Object.assign(appNodeOutputPayload(n), { ok: true });
    },
    /* 等同于画布上的「终止」：这颗节点上在跑的都停（含用户手点 ▶ 的那次 —— 用户共识）。 */
    cancelNode: async (a) => {
      const n = appNodeById(String((a && a.id) || ""));
      if (!n) return { ok: false, code: "missing", error: appNodeT("没有这个节点") };
      if (typeof stopNode !== "function")
        return { ok: false, code: "no_host", error: appNodeT("画布停止入口未加载") };
      const wasRunning = !!n.running;
      const wasPending = typeof isNodePending === "function" ? !!isNodePending(n) : false;
      await stopNode(n);
      if (typeof scheduleSave === "function") scheduleSave(true);
      return {
        ok: true,
        nodeId: String(n.id || ""),
        wasRunning: wasRunning,
        wasPending: wasPending,
        running: !!n.running,
      };
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
    /* 新建一条会话并绑定到这颗应用节点：与独立窗口 appHost.agent.create 同一条会话链
       （renderer/app-session-bridge.js 的 sessionCreate），起完即绑 —— 应用拿到的不只是
       「能列会话」，而是**真能起一条、往里发消息**的 agent 通道。 */
    create: async (a) => {
      const ses = window.MTNodeSession;
      if (!ses || typeof ses.handleFrame !== "function")
        return { ok: false, code: "no_agent", error: appNodeT("会话桥渲染层未加载") };
      let out = null;
      try {
        out = await ses.handleFrame({ op: "sessionCreate", params: { title: String((a && a.title) || "") } });
      } catch (e) {
        return { ok: false, code: "failed", error: String((e && e.message) || e) };
      }
      if (!out || out.ok !== true)
        return out || { ok: false, code: "failed", error: appNodeT("新建会话失败") };
      const sid = String(out.sessionId || (out.session && out.session.id) || out.id || "");
      if (!sid) return { ok: false, code: "failed", error: appNodeT("新建会话没有回 id") };
      const n = appNodeById(APPNODE.nodeId);
      APPNODE.bound = sid;
      if (n) {
        if (typeof pushHistory === "function") pushHistory();
        n.appSessionId = sid;
        if (typeof scheduleSave === "function") scheduleSave(true);
        if (typeof renderCanvas === "function") renderCanvas();
      }
      return { ok: true, sessionId: sid, title: String(out.title || "") };
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
    /* 读一张图回 dataURL（与主进程 app-host-bridge.js 的 fs.imageDataUrl 同一口径）：
       应用页面的 <img> 读不了 file://，画布节点那张图只有绝对路径，所以由父窗口经主进程的
       读图通道把字节转成 dataURL。只读、只认图片扩展名、上限 8MB。 */
    imageDataUrl: async (a) => {
      const api = appNodeApi();
      const p = String((a && (a.path || a.rel)) || "").trim();
      if (!p) return { ok: false, code: "no_path", error: appNodeT("缺图片路径") };
      if (!/^[a-zA-Z]:[\\/]/.test(p) && p.charAt(0) !== "/" && p.charAt(0) !== "\\")
        return { ok: false, code: "not_abs", error: appNodeT("要图片的绝对路径") };
      const MIME = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
      };
      const ext = (String(p).match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
      const mime = MIME[ext];
      if (!mime) return { ok: false, code: "bad_ext", error: appNodeT("只认图片（png / jpg / webp / gif / bmp）") };
      if (typeof api.assetReadDataUrl !== "function")
        return { ok: false, code: "no_host", error: appNodeT("读图通道不可用") };
      let r = null;
      try {
        r = await api.assetReadDataUrl(p);
      } catch (e) {
        return { ok: false, code: "no_file", error: appNodeT("这张图不在：") + p };
      }
      const dataUrl = String((r && r.dataUrl) || "");
      if (!r || r.ok === false || !dataUrl)
        return { ok: false, code: "no_file", error: appNodeT("这张图不在：") + p };
      const bytes = Math.max(0, Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75));
      if (bytes > 8 * 1024 * 1024) return { ok: false, code: "too_large", error: appNodeT("图片太大（上限 8MB）") };
      return { ok: true, path: p, bytes: bytes, mime: mime, dataUrl: dataUrl };
    },
  },
  tools: {
    /* 清单：注册中心登记的工具 + 已安装的插件本机后端（后者应用侧同样能直接 call） */
    list: async () => ({ ok: true, tools: await appNodeToolList() }),
    call: async (a) => {
      const id = String((a && a.id) || "");
      if (!id) return { ok: false, code: "bad_arg", error: appNodeT("id 必填") };
      return appNodeToolCall(id, (a && a.args) || {});
    },
  },
  /* 语音合成（Breeze TTS 2）：与 appHost 同形状 —— 产物写进**这张画布**的工作目录并回绝对路径。
     outputPath 必填，相对路径与绝对路径都收（只要落在工作目录内；越界才回 outside，
     与主窗口 app-host-bridge.js 同一口径）；忙判定与画布节点共用同一台后端。
     presets 只是角色清单，synth 才是出声口。 */
  audio: {
    presets: async () => {
      const api = appNodeApi();
      if (typeof api.breezePresets !== "function")
        return { ok: false, code: "no_host", error: appNodeT("Breeze 本机后端不在这一版里") };
      const r = await api.breezePresets();
      if (!r || r.ok === false)
        return { ok: false, code: "presets_failed", error: String((r && r.error) || "presets_failed") };
      return { ok: true, dir: String((r && r.dir) || ""), presets: Array.isArray(r && r.presets) ? r.presets : [] };
    },
    status: async () => {
      const api = appNodeApi();
      if (typeof api.breezeStatus !== "function")
        return { ok: false, code: "no_host", error: appNodeT("Breeze 本机后端不在这一版里") };
      const st = (await api.breezeStatus()) || {};
      return {
        ok: true,
        backend: "breeze",
        running: !!st.running,
        busy: !!(st.busy || (st.apiStatus && st.apiStatus.busy)),
      };
    },
    synth: async (a) => {
      const api = appNodeApi();
      const text = String((a && a.text) == null ? "" : a.text).trim();
      if (!text) return { ok: false, code: "no_text", error: appNodeT("缺少合成文本") };
      const rel = String((a && a.outputPath) == null ? "" : a.outputPath).replace(/\\/g, "/");
      if (!rel) return { ok: false, code: "no_path", error: appNodeT("必须给 outputPath（画布工作目录里的路径）") };
      const wd = appNodeWorkdir();
      if (!wd) return { ok: false, code: "no_workdir", error: appNodeT("这张画布还没有工作目录") };
      /* 相对路径与绝对路径都收（应用拿 fs.root() 拼出来的那种也是合法落点，见 appNodeResolveInWorkdir），
         只有真的落到工作目录外才回 outside。 */
      const abs = appNodeResolveInWorkdir(wd, rel);
      if (!abs) return { ok: false, code: "outside", error: appNodeT("只能写到画布工作目录里") };
      if (typeof api.breezeGenerate !== "function")
        return { ok: false, code: "no_host", error: appNodeT("Breeze 本机后端不在这一版里") };
      const r = await api.breezeGenerate({
        text: text,
        presetId: String((a && a.presetId) || ""),
        presetGroupId: String((a && a.presetGroupId) || ""),
        instruction: String((a && a.instruction) || ""),
        voice: String((a && a.voice) || ""),
        cfgScale: a && a.cfgScale,
        seed: a && a.seed,
        outputPath: abs,
        response_format: String((a && a.responseFormat) || "wav"),
        workflowId: appNodeNodeId(),
        nodeId: "appnode:" + String(APPNODE.nodeId || ""),
      });
      if (!r || r.ok === false)
        return {
          ok: false,
          code: String((r && (r.code || r.error)) || "tts_failed"),
          error: String((r && (r.message || r.error)) || appNodeT("语音合成失败")),
        };
      return { ok: true, path: String(r.path || abs), bytes: Number((r && r.bytes) || 0) };
    },
    cancel: async () => {
      const api = appNodeApi();
      if (typeof api.breezeCancelGenerate !== "function")
        return { ok: false, code: "no_host", error: appNodeT("Breeze 本机后端不在这一版里") };
      const r = await api.breezeCancelGenerate("appnode:" + String(APPNODE.nodeId || ""));
      return Object.assign({ ok: true }, r && typeof r === "object" ? r : {});
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
    /* 联网取素材（2026-12）：与独立窗口同一套签名 —— search(url, opts) / download(url, rel, opts)。
       请求由主进程代发（页面 CSP 是 connect-src 'none'）；下载只落这张画布的工作目录。 */
    search: async (a) => {
      const api = appNodeApi();
      const url = String((a && a.url) || "");
      if (!/^https?:\/\//i.test(url)) return { ok: false, code: "bad_url", error: appNodeT("只支持 http(s)") };
      if (typeof api.appNodeNet !== "function") return { ok: false, code: "no_host", error: appNodeT("联网通道不可用") };
      const o = (a && a.opts) || {};
      const r = await api.appNodeNet({ op: "search", url: url, headers: o.headers || {}, timeoutMs: o.timeoutMs });
      return r && typeof r === "object" ? r : { ok: false, code: "bad_reply", error: appNodeT("宿主回了个看不懂的回执") };
    },
    download: async (a) => {
      const api = appNodeApi();
      const wd = appNodeWorkdir();
      if (!wd) return { ok: false, code: "no_workdir", error: appNodeT("这张画布还没有工作目录") };
      if (typeof api.appNodeNet !== "function") return { ok: false, code: "no_host", error: appNodeT("联网通道不可用") };
      const o = (a && a.opts) || {};
      const r = await api.appNodeNet({
        op: "download",
        workdir: wd,
        url: String((a && a.url) || ""),
        rel: String((a && a.rel) || ""),
        headers: o.headers || {},
        maxBytes: o.maxBytes,
        timeoutMs: o.timeoutMs,
      });
      return r && typeof r === "object" ? r : { ok: false, code: "bad_reply", error: appNodeT("宿主回了个看不懂的回执") };
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
window.appNodeCollapseForOther = appNodeCollapseForOther;
window.appNodeStop = appNodeStop;
window.appNodeDestroyFrame = appNodeDestroyFrame;
window.appNodePick = appNodeOpenPicker;
/* 应用中心窗口的宿主桥（renderer/app-apphost-bridge.js）复用这一份画布执行体：
   只导出 canvas 那一段 —— agent 那一段把绑定写在画布节点上（appSessionId），
   那是应用节点私有的语义，独立窗口用的是会话自己的 canvasWfId。
   调用方负责用 runAgainstWf(目标画布) 把那张图换上手；本段只认 S.wf。 */
window.MTNodeAppCanvas = APPNODE_ROUTES.canvas;
/* 工具清单 / 调用（app-apphost-bridge.js 的 toolsList / toolsCall 复用它，
   应用窗口与画布应用节点因此看到**同一份**工具面） */
window.MTNodeAppTools = { list: appNodeToolList, call: appNodeToolCall };

/* ── 工作目录占用与清理（renderer/app-ws-temp.js）────────────────────────────
 *
 * 入口两处，打开的是**同一个面板**（一套 UI、一套实现）：
 *   ① 顶栏唯一那颗 ⚙ 的工作目录设置窗里（见 app.js 的 openWfWorkspaceDialog）；
 *   ② 设置 ·「存储占用与清理」小节里的一行入口。
 *
 * 统计与清理的真源全在主进程 workspace-temp.js：本文件只负责把结果画出来、
 * 收集勾选、把 key 交回去。渲染层永远不拼绝对路径、也不自己删文件。
 *
 * 面板形态：独立于 #overlay 的常驻浮层（persistent —— 点蒙层 / 点外部一律不关，
 * 出口只有 ✕ /「关闭」/ Esc），z-index 落在 #overlay 之上、深色确认框之下，
 * 所以从设置里打开时设置窗原样留在下面，关掉面板就回到设置。
 */

const WS_TEMP_CATEGORY_LABEL = {
  source: "工程源码",
  config: "渲染配置",
  assets: "素材副本",
  verify: "校验片",
  cache: "旧浏览器缓存",
  output: "成片",
  input: "粘贴图 / 截图",
  user: "用户产物",
  hidden: "其它隐藏目录",
  other: "其它",
  node: "渲染工程",
};

let wsTempHost = null;
const wsTempState = {
  data: null,
  checked: new Set(),
  expanded: new Set(),
  leaves: new Map(), /* key → item（叶子，含子孙） */
  groupItems: new Map(), /* 组 id → 该组的顶层 items（组勾选框按它算全选 / 半选） */
  busy: false,
  note: "",
  error: "",
  seq: 0,
};

function wsTempT(s, vars) {
  try {
    return I18n.t(s, vars);
  } catch {
    return s;
  }
}

function wsTempFmt(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function wsTempCurrentWfId() {
  try {
    return String((typeof S !== "undefined" && S && S.wf && S.wf.id) || "");
  } catch {
    return "";
  }
}

function wsTempWorkspace() {
  try {
    return String((typeof wfWorkspace === "function" ? wfWorkspace() : "") || "").trim();
  } catch {
    return "";
  }
}

/** 同一面板的按钮封装（顶栏已收进设置窗，这里保留给需要就地放一颗入口的地方） */
function workspaceTempButton() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini btn-sq ws-temp-open";
  b.title = wsTempT("工作目录占用与清理（.mtnode / .mtnode-input / recordings）");
  b.setAttribute("aria-label", b.title);
  /* 硬盘 + 扫帚的意思：一块盘，右下角一点火花 */
  b.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2.2 5.2c0-1.1 2.6-2 5.8-2s5.8.9 5.8 2v5.6c0 1.1-2.6 2-5.8 2-1 0-2-.1-2.8-.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '<path d="M13.8 5.2c0 1.1-2.6 2-5.8 2S2.2 6.3 2.2 5.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '<path d="M10.4 10.3v2.2M9.1 12.6l1.3-.9 1.3.9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";
  b.addEventListener("mousedown", (ev) => ev.stopPropagation());
  b.onclick = (ev) => {
    ev.stopPropagation();
    openWorkspaceTempPanel();
  };
  return b;
}

function ensureWsTempHost() {
  if (wsTempHost && document.body.contains(wsTempHost)) return wsTempHost;
  const mask = document.createElement("div");
  mask.id = "wsTempMask";
  mask.className = "ws-temp-mask";
  mask.hidden = true;
  mask.innerHTML =
    '<div class="ws-temp-box" role="dialog" aria-modal="true" aria-labelledby="wsTempTitle">' +
    '<div class="ws-temp-head">' +
    '<b id="wsTempTitle" class="ws-temp-title"></b>' +
    '<span class="ws-temp-ws"></span>' +
    '<button type="button" class="ws-temp-close" aria-label="关闭">✕</button>' +
    "</div>" +
    '<div class="ws-temp-sum"></div>' +
    '<div class="ws-temp-list"></div>' +
    '<div class="ws-temp-foot">' +
    '<span class="ws-temp-pick"></span>' +
    '<span class="ws-temp-gap"></span>' +
    '<button type="button" class="mini ws-temp-rescan">重新统计</button>' +
    '<button type="button" class="mini danger ws-temp-clean">清理选中</button>' +
    '<button type="button" class="mini ws-temp-done">关闭</button>' +
    "</div>" +
    "</div>";
  document.body.appendChild(mask);
  wsTempHost = mask;
  mask.querySelector(".ws-temp-close").onclick = closeWorkspaceTempPanel;
  mask.querySelector(".ws-temp-done").onclick = closeWorkspaceTempPanel;
  mask.querySelector(".ws-temp-rescan").onclick = () => wsTempRefresh();
  mask.querySelector(".ws-temp-clean").onclick = () => wsTempCleanSelected();
  /* 勾选走事件委托：整块列表每次刷新重建，逐个绑监听会漏 */
  mask.querySelector(".ws-temp-list").addEventListener("change", (ev) => {
    const inp = ev.target;
    if (!inp || inp.type !== "checkbox") return;
    const key = inp.dataset.key || "";
    if (inp.dataset.group) {
      /* 组 / 父项：一次选中或清空它名下所有叶子 */
      for (const leafKey of wsTempLeafKeysOf(inp.dataset.group)) {
        if (inp.checked) wsTempState.checked.add(leafKey);
        else wsTempState.checked.delete(leafKey);
      }
    } else if (key) {
      if (inp.checked) wsTempState.checked.add(key);
      else wsTempState.checked.delete(key);
    }
    /* 只按状态回写 DOM，不整块重建：重建会把滚动位置与展开状态一起抖掉 */
    wsTempApplyChecksToDom();
    wsTempSyncChecks();
  });
  mask.querySelector(".ws-temp-list").addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest(".ws-temp-expand") : null;
    if (!btn) return;
    ev.preventDefault();
    const key = btn.dataset.expand || "";
    if (!key) return;
    if (wsTempState.expanded.has(key)) wsTempState.expanded.delete(key);
    else wsTempState.expanded.add(key);
    wsTempRenderList();
  });
  /* 面板开着时 Esc 关它（不抢 #overlay 自己的 Esc：只在面板可见时处理） */
  document.addEventListener("keydown", (ev) => {
    if (!wsTempHost || wsTempHost.hidden) return;
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeWorkspaceTempPanel();
    }
  }, true);
  return mask;
}

function wsTempLeafKeysOf(key) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.childrenCheckable) {
      for (const c of node.children || []) if (c.checkable && !c.running && !c.locked) out.push(c.key);
      return;
    }
    if (node.checkable && !node.running && !node.locked) out.push(node.key);
  };
  const it = wsTempState.leaves.get(key);
  if (it) {
    walk(it);
    return out;
  }
  /* 组勾选框：按该组登记的顶层 items 逐个展开（key 前缀与组 id 不是一回事） */
  for (const item of wsTempState.groupItems.get(key) || []) walk(item);
  return out;
}

/** 按勾选状态回写列表里的叶子勾选框（组框由 wsTempSyncChecks 统一算三态） */
function wsTempApplyChecksToDom() {
  if (!wsTempHost) return;
  wsTempHost.querySelectorAll('input[type="checkbox"][data-key]').forEach((inp) => {
    if (inp.hidden) return;
    inp.checked = wsTempState.checked.has(inp.dataset.key);
  });
}

/** 组 / 父项三态：全选 / 半选 / 未选 */
function wsTempSyncChecks() {
  if (!wsTempHost) return;
  const list = wsTempHost.querySelector(".ws-temp-list");
  if (!list) return;
  list.querySelectorAll('input[type="checkbox"][data-group]').forEach((inp) => {
    const keys = wsTempLeafKeysOf(inp.dataset.group);
    let on = 0;
    for (const k of keys) if (wsTempState.checked.has(k)) on += 1;
    inp.checked = keys.length > 0 && on === keys.length;
    inp.indeterminate = on > 0 && on < keys.length;
    inp.disabled = keys.length === 0;
  });
  wsTempRenderPick();
}

function wsTempRenderPick() {
  if (!wsTempHost) return;
  const el = wsTempHost.querySelector(".ws-temp-pick");
  if (!el) return;
  let bytes = 0;
  let n = 0;
  for (const key of wsTempState.checked) {
    const it = wsTempState.leaves.get(key);
    if (!it) continue;
    n += 1;
    bytes += Number(it.bytes) || 0;
  }
  el.textContent = n
    ? wsTempT("已选 {n} 项 · {size}", { n, size: wsTempFmt(bytes) })
    : wsTempT("尚未勾选");
  const btn = wsTempHost.querySelector(".ws-temp-clean");
  if (btn) btn.disabled = wsTempState.busy || !n;
}

function wsTempRow(item, opts) {
  const o = opts || {};
  const row = document.createElement("div");
  row.className = "ws-temp-row" + (o.leaf ? " leaf" : "") + (o.child ? " child" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  if (o.group) cb.dataset.group = item.key;
  else cb.dataset.key = item.key;
  cb.checked = o.group
    ? false
    : wsTempState.checked.has(item.key);
  cb.disabled = !o.group && (item.running || item.locked || !item.checkable);
  /* 只统计不清理的父行（.mtnode/remotion/<节点>）不显示勾选框：勾选落在展开后的叶子上 */
  if (!o.group && !item.checkable) cb.hidden = true;
  if (o.group) cb.title = wsTempT("全选 / 全不选这一组");
  else if (item.running || item.locked) cb.title = wsTempT("正在渲染：不能清理");
  else cb.title = wsTempT("勾选后点「清理选中」移入系统回收站");
  row.appendChild(cb);

  const name = document.createElement("span");
  name.className = "ws-temp-name";
  name.textContent = item.name;
  if (item.category && WS_TEMP_CATEGORY_LABEL[item.category]) {
    const tag = document.createElement("i");
    tag.className = "ws-temp-tag";
    tag.textContent = wsTempT(WS_TEMP_CATEGORY_LABEL[item.category]);
    name.appendChild(tag);
  }
  row.appendChild(name);

  /* 提示在前、体积在后：体积列靠 margin-left:auto 固定贴右，有提示的行也不会把它挤偏 */
  if (item.note) {
    const note = document.createElement("span");
    note.className = "ws-temp-note";
    note.textContent = wsTempT(item.note);
    row.appendChild(note);
  }

  const meta = document.createElement("span");
  meta.className = "ws-temp-meta";
  meta.textContent =
    wsTempFmt(item.bytes) +
    (item.files ? " · " + wsTempT("{n} 个文件", { n: item.files }) : "");
  row.appendChild(meta);

  const kids = Array.isArray(item.children) ? item.children : [];
  if (kids.length) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-temp-expand";
    btn.dataset.expand = item.key;
    const open = wsTempState.expanded.has(item.key);
    btn.textContent = open ? "▾" : "▸";
    btn.title = wsTempT("展开 / 收起明细");
    row.appendChild(btn);
  }
  return row;
}

function wsTempRenderList() {
  if (!wsTempHost) return;
  const list = wsTempHost.querySelector(".ws-temp-list");
  if (!list) return;
  list.innerHTML = "";
  wsTempState.leaves = new Map();
  wsTempState.groupItems = new Map();
  const d = wsTempState.data;
  if (!d) return;
  if (wsTempState.busy) {
    const p = document.createElement("div");
    p.className = "ws-temp-empty";
    p.textContent = wsTempT("正在统计工作目录…");
    list.appendChild(p);
    return;
  }
  if (wsTempState.error) {
    const p = document.createElement("div");
    p.className = "ws-temp-empty err";
    p.textContent = wsTempState.error;
    list.appendChild(p);
    return;
  }
  const groups = Array.isArray(d.groups) ? d.groups : [];
  if (!groups.length) {
    const p = document.createElement("div");
    p.className = "ws-temp-empty";
    p.textContent = wsTempT(
      "这个工作目录里没有 .mtnode / .mtnode-input / recordings，也没有其它 . 开头的临时目录",
    );
    list.appendChild(p);
    return;
  }
  for (const g of groups) {
    wsTempState.groupItems.set(g.id, g.items || []);
    const box = document.createElement("div");
    box.className = "ws-temp-group";
    const head = wsTempRow(
      { key: g.id, name: g.label, bytes: g.bytes, files: g.files, checkable: true },
      { group: true },
    );
    head.classList.add("group-head");
    box.appendChild(head);
    const body = document.createElement("div");
    body.className = "ws-temp-items";
    for (const item of g.items || []) {
      if (item.childrenCheckable) {
        /* .mtnode/remotion/<节点>：父行只统计与展开，勾选落在叶子（源码 / 成片 …） */
        wsTempState.leaves.set(item.key, item);
        body.appendChild(wsTempRow(item, {}));
        for (const c of item.children || []) {
          wsTempState.leaves.set(c.key, c);
        }
        if (wsTempState.expanded.has(item.key)) {
          for (const c of item.children || []) body.appendChild(wsTempRow(c, { leaf: true, child: true }));
        }
      } else {
        wsTempState.leaves.set(item.key, item);
        for (const c of item.children || []) wsTempState.leaves.set(c.key, c);
        body.appendChild(wsTempRow(item, { leaf: true }));
        if (wsTempState.expanded.has(item.key)) {
          for (const c of item.children || []) {
            const row = wsTempRow(c, { leaf: true, child: true });
            const cb = row.querySelector('input[type="checkbox"]');
            if (cb) cb.hidden = true; /* 只读明细：这些子项不作为清理单元 */
            body.appendChild(row);
          }
        }
      }
    }
    box.appendChild(body);
    list.appendChild(box);
  }
  wsTempSyncChecks();
}

function wsTempRenderSummary() {
  if (!wsTempHost) return;
  const sum = wsTempHost.querySelector(".ws-temp-sum");
  const wsEl = wsTempHost.querySelector(".ws-temp-ws");
  const d = wsTempState.data;
  if (wsEl) {
    wsEl.textContent = (d && d.workspace) || wsTempWorkspace() || "";
    wsEl.title = wsEl.textContent;
  }
  if (!sum) return;
  if (wsTempState.busy) {
    sum.textContent = wsTempT("正在统计工作目录…");
    return;
  }
  if (wsTempState.error) {
    sum.textContent = wsTempState.error;
    sum.classList.add("err");
    return;
  }
  sum.classList.remove("err");
  if (!d || !d.ok) {
    sum.textContent = (d && d.error) || "";
    return;
  }
  const parts = [
    wsTempT("工作目录共 {size} · {n} 个文件", {
      size: wsTempFmt(d.totalBytes),
      n: d.totalFiles || 0,
    }),
  ];
  if (d.excluded && d.excluded.length) {
    parts.push(wsTempT("已排除：") + d.excluded.join(" / "));
  }
  parts.push(wsTempT("清理一律进系统回收站，可在资源管理器还原"));
  sum.textContent = parts.join(" · ");
  if (wsTempState.note) {
    const n = document.createElement("div");
    n.className = "ws-temp-note-line";
    n.textContent = wsTempState.note;
    sum.appendChild(n);
  }
}

function wsTempApplyDefaults() {
  wsTempState.checked = new Set();
  const d = wsTempState.data;
  if (!d || !Array.isArray(d.groups)) return;
  for (const g of d.groups) {
    for (const item of g.items || []) {
      const leaves = item.childrenCheckable ? item.children || [] : [item];
      for (const leaf of leaves) {
        if (!leaf || !leaf.checkable || leaf.running || leaf.locked) continue;
        if (leaf.defaultChecked) wsTempState.checked.add(leaf.key);
      }
    }
  }
}

async function wsTempRefresh(keepNote) {
  const mask = ensureWsTempHost();
  const ws = wsTempWorkspace();
  const seq = ++wsTempState.seq;
  wsTempState.busy = true;
  wsTempState.error = "";
  if (!keepNote) wsTempState.note = "";
  if (!ws) {
    wsTempState.busy = false;
    wsTempState.error = wsTempT("这张画布还没有工作目录：先在顶栏「工作目录」选一个文件夹");
    wsTempState.data = null;
    wsTempRenderSummary();
    wsTempRenderList();
    return;
  }
  wsTempRenderSummary();
  wsTempRenderList();
  let r = null;
  try {
    if (!window.api || !window.api.wsTempScan) {
      r = { ok: false, error: wsTempT("当前宿主没有提供统计接口") };
    } else {
      r = await window.api.wsTempScan({ workspace: ws, wfId: wsTempCurrentWfId() });
    }
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  if (seq !== wsTempState.seq) return; /* 期间又刷新过：旧结果作废 */
  wsTempState.busy = false;
  if (!r || r.ok === false) {
    wsTempState.data = null;
    wsTempState.error = (r && r.error) || wsTempT("统计失败");
  } else {
    wsTempState.data = r;
    wsTempState.error = "";
    wsTempApplyDefaults();
  }
  wsTempRenderSummary();
  wsTempRenderList();
}

async function wsTempCleanSelected() {
  const d = wsTempState.data;
  if (!d || !d.ok || wsTempState.busy) return;
  const keys = Array.from(wsTempState.checked);
  if (!keys.length) {
    if (typeof toast === "function") toast(wsTempT("先勾选要清理的项"), "warn");
    return;
  }
  let bytes = 0;
  for (const key of keys) bytes += Number((wsTempState.leaves.get(key) || {}).bytes) || 0;
  const msg = wsTempT(
    "将把 {n} 项（{size}）移入系统回收站。\n\n正在渲染的工程与其它程序的占用不会被删；删不掉的文件会汇总报告。要清理吗？",
    { n: keys.length, size: wsTempFmt(bytes) },
  );
  const ok =
    typeof confirmDialog === "function"
      ? await confirmDialog(msg, {
          title: wsTempT("清理工作目录临时文件"),
          okText: wsTempT("移入回收站"),
          cancelText: wsTempT("取消"),
          danger: true,
        })
      : true;
  if (!ok) return;

  wsTempState.busy = true;
  wsTempState.note = "";
  wsTempRenderSummary();
  wsTempRenderList();
  let r = null;
  try {
    r = await window.api.wsTempClean({
      workspace: d.workspace,
      wfId: wsTempCurrentWfId(),
      keys,
    });
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  wsTempState.busy = false;
  if (!r || r.ok === false) {
    wsTempState.note = wsTempT("清理失败：{err}", { err: (r && r.error) || "" });
    if (typeof toast === "function") toast(wsTempState.note, "err");
  } else {
    const removed = Array.isArray(r.removed) ? r.removed : [];
    const failed = Array.isArray(r.failed) ? r.failed : [];
    wsTempState.note = wsTempT("已移入回收站：{n} 项 · {size}", {
      n: removed.length,
      size: wsTempFmt(r.freedBytes || 0),
    });
    if (failed.length) {
      wsTempState.note +=
        wsTempT("；{n} 项没删掉（可能正被别的程序占用）：", { n: failed.length }) +
        failed
          .slice(0, 3)
          .map((f) => f.key + "（" + (f.error || "") + "）")
          .join("；");
    }
    if (typeof toast === "function") toast(wsTempState.note, failed.length ? "warn" : "ok");
  }
  await wsTempRefresh(true);
}

/** 打开面板（顶栏按钮与设置里的入口共用） */
function openWorkspaceTempPanel() {
  const mask = ensureWsTempHost();
  mask.hidden = false;
  const title = mask.querySelector(".ws-temp-title");
  if (title) title.textContent = wsTempT("工作目录占用与清理");
  const rescan = mask.querySelector(".ws-temp-rescan");
  if (rescan) rescan.textContent = wsTempT("重新统计");
  const clean = mask.querySelector(".ws-temp-clean");
  if (clean) clean.textContent = wsTempT("清理选中");
  const done = mask.querySelector(".ws-temp-done");
  if (done) done.textContent = wsTempT("关闭");
  wsTempRefresh();
}

function closeWorkspaceTempPanel() {
  if (wsTempHost) wsTempHost.hidden = true;
}

/* 全局出口：app-settings.js（设置里的入口）与 app.js（顶栏按钮）都按名字调用 */
window.openWorkspaceTempPanel = openWorkspaceTempPanel;
window.workspaceTempButton = workspaceTempButton;

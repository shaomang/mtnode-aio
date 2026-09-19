"use strict";
/* ============================================================
 * 画布左侧边栏「文件」页 —— VSCode explorer 式文件树
 * 自包含模块：全局 MTNodeSideFiles / sidebarFilesDropPayload / sidebarFilesDropToCanvas。
 *
 * 职责（对应左侧边栏顶部 Tabs 的「文件」一格）：
 *   · 目录口径：页头一行选择器 =「画布工作目录」＋画布上所有开发节点 devPath（去重）
 *     ＋「浏览…」手动选目录；默认画布工作目录；选择按画布记忆（S.wf.sideFiles）。
 *   · 树：递归懒加载（展开文件夹才读盘，一层一个 file:readDir）；显示点号隐藏文件，
 *     但 node_modules / .git 只列不自动展开。
 *   · 预览：md / 文本 / 图像行右侧「预览」字样，点击复用已有右侧面板 openFilePeek；
 *     单击只选中，双击文件名 = 预览（目录 = 展开 / 收起）。Ctrl / Shift 多选。
 *   · 文件操作：右键菜单 重命名 / 复制 / 剪切 / 删除 / 在资源管理器中显示 / 复制完整路径，
 *     页头小工具条 刷新 / 粘贴。重命名是树内行内编辑（Enter 提交 / Esc 取消），
 *     粘贴落到当前选中文件夹（无选中 = 工作目录根），重名自动加 (2)。
 *   · 删除：确认后走系统回收站（file:trash），回收站不可用时主进程报错 → 提示并中止。
 *   · 拖到画布：内部拖拽（application/x-mtnode-files）→ 先弹窗确认，再由 app.js 的
 *     createNodesFromDroppedFiles 按类型建节点（图像 / 文本 / 音视频 / 其余 → 文件块）；
 *     拖文件夹只取**第一层**文件、不递归；整批记一步，Ctrl+Z 一次撤销。
 *
 * 依赖（都在 app.js 之后加载，取用时机在调用期，不做模块初始化绑定）：
 *   S / I18n / toast / confirmDialog / wfWorkspace / renderSidebar（包装）
 *   app-fileview.js：openFilePeek / fileviewLangOf / fileviewIsImagePath
 *   app.js：classifyDropFile / createNodesFromDroppedFiles（拖入建节点）
 * 纯函数段（不碰 DOM / window）可被 test/ 切片真跑。
 * ============================================================ */

/* ===== 纯函数段（test/smoke-sidebar-files.js 直接切片真跑） ===== */
const SF_IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "tiff", "tif",
]);
const SF_MEDIA_EXT = new Set([
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "wma",
  "mp4", "mov", "webm", "mkv", "avi", "m4v", "flv",
]);
const SF_TEXT_EXT = new Set([
  "md", "markdown", "txt", "text", "log", "json", "jsonc", "yaml", "yml", "toml",
  "ini", "cfg", "conf", "env", "csv", "tsv", "xml", "html", "htm", "css", "scss",
  "less", "js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "svelte", "py", "rb",
  "php", "go", "rs", "java", "kt", "cs", "c", "h", "cpp", "hpp", "lua", "sh",
  "bash", "ps1", "bat", "cmd", "sql", "gitignore", "editorconfig",
]);
/* 只列不展开的重型目录（用户仍可手动展开；搜索也不会走进去） */
const SF_HEAVY_DIRS = new Set(["node_modules", ".git"]);
/* 搜索递归的条数上限（按需递归补子目录，不做全盘遍历） */
const SF_SEARCH_CAP = 800;

function sfBaseName(p) {
  const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i < 0 ? s : s.slice(i + 1);
}
function sfDirOf(p) {
  const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i < 0) return /^[a-zA-Z]:$/.test(s) ? s + "\\" : "";
  if (i === 0) return "/";
  const head = s.slice(0, i);
  return /^[a-zA-Z]:$/.test(head) ? head + "\\" : head;
}
function sfJoin(dir, name) {
  const d = String(dir == null ? "" : dir).replace(/[\\/]+$/, "");
  const sep = /\\/.test(d) || /^[a-zA-Z]:/.test(d) || /^\/\//.test(d) ? "\\" : "/";
  if (!d) return String(name == null ? "" : name);
  return d + sep + String(name == null ? "" : name);
}
function sfExtOf(p) {
  const b = sfBaseName(p);
  const i = b.lastIndexOf(".");
  if (i <= 0) return "";
  return b.slice(i + 1).toLowerCase();
}
/* 行内重命名只选主名（不选中扩展名），VSCode 同款 */
function sfSplitName(name) {
  const b = String(name == null ? "" : name);
  const i = b.lastIndexOf(".");
  if (i <= 0) return { stem: b, ext: "" };
  return { stem: b.slice(0, i), ext: b.slice(i) };
}
function sfIsMd(p) {
  const e = sfExtOf(p);
  return e === "md" || e === "markdown";
}
/* 文本 / 代码：优先复用 app-fileview.js 的语言判定（单一真源），退化到扩展名表 */
function sfLangOf(p) {
  return typeof fileviewLangOf === "function" ? fileviewLangOf(p) || "" : "";
}
function sfIsTextLike(p) {
  return !!sfLangOf(p) || SF_TEXT_EXT.has(sfExtOf(p));
}
function sfIsImagePath(p) {
  if (typeof fileviewIsImagePath === "function") return !!fileviewIsImagePath(p);
  return SF_IMAGE_EXT.has(sfExtOf(p));
}
/* 需求口径：md / 文本 / 图像才给「预览」字样 */
function sfPreviewable(p) {
  return sfIsImagePath(p) || sfIsTextLike(p);
}
/* 类型筛选格：全部 / 文本 / 图像 / 媒体 / 其他 */
function sfTypeBucket(p) {
  if (sfIsImagePath(p)) return "image";
  if (SF_MEDIA_EXT.has(sfExtOf(p))) return "media";
  if (sfIsTextLike(p)) return "text";
  return "other";
}
/* 文件名左侧图标分档 */
function sfIconKind(p, isDir) {
  if (isDir) return "dir";
  if (sfIsImagePath(p)) return "image";
  if (SF_MEDIA_EXT.has(sfExtOf(p))) return "media";
  if (sfIsMd(p)) return "md";
  if (sfIsTextLike(p)) return "code";
  return "file";
}
function sfMatchQuery(name, q) {
  const s = String(q == null ? "" : q).trim().toLowerCase();
  if (!s) return true;
  return String(name == null ? "" : name).toLowerCase().includes(s);
}
function sfMatchType(p, filter) {
  return !filter || filter === "all" || sfTypeBucket(p) === filter;
}
/* 目录在前、同类按名字（数字按数值序，与资源管理器一致） */
function sfSortEntries(list) {
  const nat = (a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return [...(list || [])].sort((a, b) => {
    if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
    return nat(a.name, b.name);
  });
}
function sfFormatSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
/* 重名自动加 (2)（不覆盖）：exists 可是函数或 Set */
function sfUniqueName(name, exists) {
  const has =
    typeof exists === "function"
      ? exists
      : (n) => !!(exists && typeof exists.has === "function" && exists.has(n));
  const base = String(name == null ? "" : name);
  if (!has(base)) return base;
  const { stem, ext } = sfSplitName(base);
  for (let i = 2; i < 1000; i++) {
    const cand = stem + " (" + i + ")" + ext;
    if (!has(cand)) return cand;
  }
  return base;
}
/* 拖入画布前的汇总文案（纯函数：给定类型计数 → 一句话；
   词条走 I18n 时可用，纯 Node 切片下退化为中文原文） */
function sfDropSummary(counts, dirInfo) {
  const T = (s, vars) => {
    let out = typeof I18n !== "undefined" && I18n && I18n.t ? I18n.t(s, vars) : s;
    if (vars) {
      for (const k of Object.keys(vars)) out = out.split("{" + k + "}").join(String(vars[k]));
    }
    return out;
  };
  const parts = [];
  if (counts.image) parts.push(T("图像") + " " + counts.image);
  if (counts.text) parts.push(T("文本") + " " + counts.text);
  if (counts.audio) parts.push(T("音频") + " " + counts.audio);
  if (counts.video) parts.push(T("视频") + " " + counts.video);
  if (counts.other) parts.push(T("文件") + " " + counts.other);
  let s =
    T("将创建 {n} 个节点：", { n: counts.total || 0 }) + (parts.join(" / ") || "—");
  if (dirInfo && dirInfo.dirs) {
    s += T("；另有 {d} 个文件夹，只取第一层共 {n} 个文件（不递归）", {
      d: dirInfo.dirs,
      n: dirInfo.files,
    });
  }
  return s;
}
/* ===== 纯函数段结束 ===== */

/* ── 图标（16 viewBox 线性 SVG，与顶栏图标同风格） ── */
const SF_ICON = {
  dir:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.5 3.5h4l1.3 1.6h7.7v7.4H1.5z" opacity=".9"/></svg>',
  md:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M2.5 2.5h8l3 3v8h-11z"/><path fill="none" stroke="currentColor" stroke-width="1.1" d="M4.5 11V7l1.8 2 1.7-2v4M10.5 7v4M9.2 9.8l1.3 1.4 1.3-1.4"/></svg>',
  code:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M2.5 2.5h8l3 3v8h-11z"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="M6.4 7 4.8 9l1.6 2M9.6 7l1.6 2-1.6 2"/></svg>',
  image:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M1.8 3.2h12.4v9.6H1.8z"/><circle cx="5.4" cy="6.4" r="1.1" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="m3 12 3.4-3.6L9 11l1.8-1.6L13 12"/></svg>',
  media:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M2.6 3.2h4v9.6h-4zM8.9 5.4l4.5-2v9.2l-4.5-2z"/></svg>',
  file:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M3.5 2.5h6l3 3v8h-9z"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="M9.5 2.5v3h3"/></svg>',
};

/* ── 运行态（模块级单例，不进画布数据） ── */
const SF = {
  tab: "nodes", /* nodes | files */
  rootKind: "canvas", /* canvas | project | custom */
  root: "",
  expanded: new Set(),
  cache: new Map(), /* dir → {exists, entries[]} */
  sel: new Set(),
  dirs: new Set(), /* 已知是目录的路径（粘贴落点 / 剪贴判断用） */
  anchor: "",
  clip: null, /* {mode:"copy"|"cut", paths:[]} */
  query: "",
  typeFilter: "all",
  flatOrder: [],
  renaming: "",
  search: null, /* {q, list, capped} */
  menu: null,
  renameInput: null,
  wfId: "", /* 当前画布 id：切画布时重解析目录选择 */
};

function sf$(id) {
  return document.getElementById(id);
}
function sfWorkflow() {
  try {
    return typeof S !== "undefined" && S && S.wf ? S.wf : null;
  } catch (_) {
    return null;
  }
}
/* 画布上所有开发节点项目根（去重；devPathOfIn 是 app.js 的单一真源） */
function sfDevRoots() {
  const wf = sfWorkflow();
  if (!wf || !Array.isArray(wf.nodes)) return [];
  const out = [];
  const seen = new Set();
  for (const n of wf.nodes) {
    if (!n || n.kind !== "super" || !n.dev) continue;
    let p = "";
    try {
      p =
        typeof devPathOfIn === "function"
          ? String(devPathOfIn(n, wf) || "")
          : String(n.devPath || "");
    } catch (_) {
      p = String(n.devPath || "");
    }
    p = p.trim().replace(/[\\/]+$/, "");
    if (!p) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
function sfCanvasWs() {
  try {
    return typeof wfWorkspace === "function" ? String(wfWorkspace() || "").trim() : "";
  } catch (_) {
    return "";
  }
}
function sfStoredRoot() {
  const wf = sfWorkflow();
  const st = wf && wf.sideFiles;
  if (!st || typeof st !== "object") return null;
  const kind = st.kind === "project" || st.kind === "custom" ? st.kind : "canvas";
  return { kind, dir: String(st.dir || "") };
}
function sfSaveRoot(kind, dir) {
  const wf = sfWorkflow();
  if (!wf) return;
  wf.sideFiles = { kind, dir: String(dir || "") };
  try {
    if (typeof scheduleSave === "function") scheduleSave();
  } catch (_) {}
}
/* 当前根（按画布记忆；记忆失效则回落画布工作目录） */
function sfResolveRoot() {
  const st = sfStoredRoot();
  if (st && st.kind === "project" && st.dir) return { kind: "project", dir: st.dir };
  if (st && st.kind === "custom" && st.dir) return { kind: "custom", dir: st.dir };
  return { kind: "canvas", dir: sfCanvasWs() };
}

/* ── 页头：Tabs / 目录选择器 / 工具条 ── */
function sfBuildTabs() {
  const tabs = sf$("sideTabs");
  if (!tabs || tabs.__sfBound) return;
  tabs.__sfBound = true;
  const nodes = sf$("sideTabNodes");
  const files = sf$("sideTabFiles");
  if (nodes) nodes.onclick = () => sfSetTab("nodes");
  if (files) files.onclick = () => sfSetTab("files");
  const rootSel = sf$("sideFilesRoot");
  if (rootSel) {
    rootSel.onchange = async () => {
      const v = String(rootSel.value || "");
      if (v === "__browse__") {
        const r = await window.api
          .fileOpenDialog({ title: I18n.t("选择文件夹"), directory: true })
          .catch(() => null);
        const p = r && r.path;
        if (!p) {
          sfSyncRootSelect();
          return;
        }
        sfSaveRoot("custom", p);
        sfEnterRoot({ kind: "custom", dir: p });
        return;
      }
      if (v === "__canvas__") {
        sfSaveRoot("canvas", "");
        sfEnterRoot({ kind: "canvas", dir: sfCanvasWs() });
        return;
      }
      if (v.startsWith("__proj__")) {
        const p = v.slice("__proj__".length);
        sfSaveRoot("project", p);
        sfEnterRoot({ kind: "project", dir: p });
      }
    };
  }
  const open = sf$("sideFilesOpen");
  if (open) {
    open.onclick = () => {
      if (!SF.root) {
        toast(I18n.t("尚未设置工作目录"), "warn");
        return;
      }
      window.api.shellOpenPath(SF.root).catch(() => {});
    };
  }
  const refresh = sf$("sideFilesRefresh");
  if (refresh) refresh.onclick = () => sfRefresh();
  const paste = sf$("sideFilesPaste");
  if (paste) paste.onclick = () => sfPaste();
  const search = sf$("sideFilesSearch");
  if (search) {
    search.oninput = () => {
      SF.query = String(search.value || "");
      clearTimeout(SF._qTimer);
      SF._qTimer = setTimeout(() => {
        if (SF.query.trim()) sfRunSearch();
        else {
          SF.search = null;
          sfRender();
        }
      }, 200);
    };
  }
  const type = sf$("sideFilesType");
  if (type) {
    type.innerHTML = "";
    for (const o of [
      { v: "all", label: I18n.t("全部") },
      { v: "text", label: I18n.t("文本") },
      { v: "image", label: I18n.t("图像") },
      { v: "media", label: I18n.t("媒体") },
      { v: "other", label: I18n.t("其他") },
    ]) {
      const el = document.createElement("option");
      el.value = o.v;
      el.textContent = o.label;
      type.appendChild(el);
    }
    type.value = SF.typeFilter;
    type.onchange = () => {
      SF.typeFilter = String(type.value || "all");
      if (SF.query.trim()) sfRunSearch();
      else sfRender();
    };
  }
}
function sfSyncRootSelect() {
  const sel = sf$("sideFilesRoot");
  if (!sel) return;
  const cur = SF.rootKind === "project" ? "__proj__" + SF.root : SF.rootKind === "custom" ? "__custom__" : "__canvas__";
  const opts = [];
  const ws = sfCanvasWs();
  opts.push({ v: "__canvas__", label: I18n.t("画布工作目录") + (ws ? "" : I18n.t("（未设置）")) });
  for (const p of sfDevRoots()) opts.push({ v: "__proj__" + p, label: I18n.t("项目根：") + sfBaseName(p) });
  if (SF.rootKind === "custom" && SF.root) opts.push({ v: "__custom__", label: I18n.t("自定义：") + sfBaseName(SF.root) });
  opts.push({ v: "__browse__", label: I18n.t("浏览…") });
  sel.innerHTML = "";
  for (const o of opts) {
    const el = document.createElement("option");
    el.value = o.v;
    el.textContent = o.label;
    if (o.v === cur) el.selected = true;
    sel.appendChild(el);
  }
  sel.title = SF.root || I18n.t("尚未设置工作目录");
}
function sfSetTab(tab) {
  SF.tab = tab === "files" ? "files" : "nodes";
  const sb = sf$("sidebar");
  if (sb) sb.classList.toggle("sf-on", SF.tab === "files");
  const nodes = sf$("sideTabNodes");
  const files = sf$("sideTabFiles");
  if (nodes) nodes.classList.toggle("on", SF.tab === "nodes");
  if (files) files.classList.toggle("on", SF.tab === "files");
  if (SF.tab === "files") sfEnterRoot(null);
}
function sfEnterRoot(next) {
  if (next) {
    SF.rootKind = next.kind;
    SF.root = next.dir || (next.kind === "canvas" ? sfCanvasWs() : "");
  } else if (!SF.root || SF.root !== sfResolveRoot().dir) {
    const r = sfResolveRoot();
    SF.rootKind = r.kind;
    SF.root = r.dir;
  }
  SF.expanded.clear();
  SF.cache.clear();
  SF.sel.clear();
  SF.dirs.clear();
  SF.anchor = "";
  SF.search = null;
  const wf = sfWorkflow();
  SF.wfId = (wf && wf.id) || "";
  sfSyncRootSelect();
  sfRender();
}
function sfRefresh() {
  SF.cache.clear();
  SF.search = null;
  sfRender();
}

/* ── 读盘 ── */
async function sfReadDir(dir) {
  if (SF.cache.has(dir)) return SF.cache.get(dir);
  const r = await window.api.fileReadDir(dir).catch(() => null);
  const val = {
    exists: !!(r && r.ok !== false && r.exists !== false),
    entries: (r && r.entries) || [],
    error: (r && r.error) || "",
  };
  SF.cache.set(dir, val);
  return val;
}
/* 搜索：按需递归子目录文件名（含隐藏文件；不走 node_modules / .git），有条数上限 */
async function sfWalkNames(root) {
  const out = [];
  const queue = [root];
  let capped = false;
  while (queue.length) {
    const dir = queue.shift();
    const r = await sfReadDir(dir);
    if (!r.exists) continue;
    for (const e of r.entries) {
      if (e.isDir) {
        if (SF_HEAVY_DIRS.has(e.name)) continue;
        queue.push(sfJoin(dir, e.name));
        continue;
      }
      out.push({ name: e.name, path: sfJoin(dir, e.name), isDir: false, size: e.size });
      if (out.length >= SF_SEARCH_CAP) {
        capped = true;
        return { list: out, capped };
      }
    }
  }
  return { list: out, capped };
}
async function sfRunSearch() {
  const q = SF.query.trim();
  const root = SF.root;
  if (!q || !root) {
    SF.search = null;
    sfRender();
    return;
  }
  const token = (SF._searchToken = uid("sfq"));
  const r = await sfWalkNames(root);
  if (token !== SF._searchToken) return;
  const list = r.list
    .filter((e) => sfMatchQuery(e.name, q) && sfMatchType(e.path, SF.typeFilter))
    .sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  SF.search = { q, list, capped: r.capped };
  sfRender();
}

/* ── 渲染 ── */
function sfRender() {
  const box = sf$("sideFilesTree");
  if (!box) return;
  const keepScroll = box.scrollTop;
  box.innerHTML = "";
  SF.flatOrder = [];
  SF.dirs.clear();
  if (!SF.root) {
    sfEmpty(box, I18n.t("尚未设置工作目录：请在上方选择画布工作目录、项目根，或「浏览…」选一个文件夹"));
    return;
  }
  if (SF.search) {
    sfRenderSearch(box);
    box.scrollTop = keepScroll;
    return;
  }
  sfRenderDir(box, SF.root, 0);
  box.scrollTop = keepScroll;
}
function sfEmpty(box, text) {
  const e = document.createElement("div");
  e.className = "sf-empty";
  e.textContent = text;
  box.appendChild(e);
}
function sfRenderSearch(box) {
  const head = document.createElement("div");
  head.className = "sf-search-head";
  head.textContent = I18n.t("搜索：") + SF.search.q + " · " + SF.search.list.length;
  box.appendChild(head);
  if (!SF.search.list.length) {
    sfEmpty(box, I18n.t("没有匹配的文件"));
  } else {
    for (const e of SF.search.list) {
      box.appendChild(sfRow(e.path, e.name, false, 0, sfDirOf(e.path)));
    }
  }
  if (SF.search.capped) {
    const w = document.createElement("div");
    w.className = "sf-search-head";
    w.textContent = I18n.t("结果过多，只显示前 ") + SF_SEARCH_CAP + I18n.t(" 条");
    box.appendChild(w);
  }
}
function sfRenderDir(box, dir, depth) {
  const cached = SF.cache.get(dir);
  if (!cached) {
    const loading = document.createElement("div");
    loading.className = "sf-empty";
    loading.textContent = I18n.t("读取中…");
    box.appendChild(loading);
    sfReadDir(dir).then(() => {
      if (SF.tab === "files") sfRender();
    });
    return;
  }
  if (!cached.exists) {
    sfEmpty(box, I18n.t("目录不存在或不可读：") + dir);
    return;
  }
  const entries = sfSortEntries(cached.entries).filter((e) => {
    if (SF.typeFilter === "all") return true;
    return e.isDir || sfMatchType(sfJoin(dir, e.name), SF.typeFilter);
  });
  if (!entries.length) {
    if (depth === 0) sfEmpty(box, I18n.t("这个目录是空的"));
    return;
  }
  for (const e of entries) {
    const p = sfJoin(dir, e.name);
    if (e.isDir) SF.dirs.add(p);
    box.appendChild(sfRow(p, e.name, !!e.isDir, depth, ""));
    if (e.isDir && SF.expanded.has(p)) {
      sfRenderDir(box, p, depth + 1);
    }
  }
}
function sfRow(path, name, isDir, depth, sub) {
  const row = document.createElement("div");
  row.className = "sf-row";
  row.dataset.path = path;
  row.style.setProperty("--sf-depth", String(depth || 0));
  row.draggable = true;
  const open = isDir && SF.expanded.has(path);
  const tw = document.createElement("span");
  tw.className = "sf-twisty" + (isDir ? "" : " leaf");
  tw.textContent = isDir ? (open ? "▾" : "▸") : "";
  if (isDir) {
    tw.onclick = (ev) => {
      ev.stopPropagation();
      sfToggleDir(path);
    };
  }
  const ico = document.createElement("span");
  const ik = sfIconKind(path, isDir);
  ico.className = "sf-ico sf-ico-" + ik;
  ico.innerHTML = SF_ICON[ik] || SF_ICON.file;
  row.appendChild(tw);
  row.appendChild(ico);
  if (SF.renaming === path) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "sf-name-input";
    inp.value = name;
    inp.onclick = (ev) => ev.stopPropagation();
    inp.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        sfCommitRename(path, inp.value);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        SF.renaming = "";
        sfRender();
      }
    };
    inp.onblur = () => {
      if (SF.renaming === path) sfCommitRename(path, inp.value);
    };
    row.appendChild(inp);
    SF.renameInput = inp;
  } else {
    const nm = document.createElement("span");
    nm.className = "sf-name";
    nm.textContent = name;
    nm.title = path;
    nm.ondblclick = (ev) => {
      ev.stopPropagation();
      if (isDir) sfToggleDir(path);
      else if (sfPreviewable(path)) sfPreview(path);
    };
    row.appendChild(nm);
  }
  if (sub) {
    const s = document.createElement("span");
    s.className = "sf-sub";
    s.textContent = sub;
    s.title = sub;
    row.appendChild(s);
  }
  if (!isDir && sfPreviewable(path)) {
    const pv = document.createElement("span");
    pv.className = "sf-prev";
    pv.textContent = I18n.t("预览");
    pv.title = I18n.t("在右侧文件面板中预览");
    pv.onclick = (ev) => {
      ev.stopPropagation();
      sfPreview(path);
    };
    row.appendChild(pv);
  }
  if (SF.sel.has(path)) row.classList.add("sel");
  if (SF.clip && SF.clip.mode === "cut" && SF.clip.paths.includes(path)) row.classList.add("cut");
  row.onclick = (ev) => sfOnRowClick(path, ev);
  row.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!SF.sel.has(path)) {
      SF.sel.clear();
      SF.sel.add(path);
      SF.anchor = path;
      sfRender();
    }
    sfRowMenu(ev.clientX, ev.clientY, path, isDir);
  };
  row.ondragstart = (ev) => {
    if (!SF.sel.has(path)) {
      SF.sel.clear();
      SF.sel.add(path);
      SF.anchor = path;
      /* 拖拽中不能整树重绘（会把正在拖的 DOM 换掉、拖拽被取消）：只就地改选中态 */
      const box = sf$("sideFilesTree");
      if (box)
        for (const el of box.querySelectorAll(".sf-row"))
          el.classList.toggle("sel", el.dataset.path === path);
    }
    const paths = sfSelectedPaths();
    try {
      ev.dataTransfer.effectAllowed = "copyMove";
      ev.dataTransfer.setData("application/x-mtnode-files", JSON.stringify(paths));
      ev.dataTransfer.setData("text/plain", paths.join("\n"));
    } catch (_) {}
  };
  SF.flatOrder.push(path);
  return row;
}
function sfSelectedPaths() {
  if (SF.sel.size) return [...SF.sel];
  return SF.anchor ? [SF.anchor] : [];
}
function sfOnRowClick(path, ev) {
  const ctrl = !!(ev && (ev.ctrlKey || ev.metaKey));
  if (ev && ev.shiftKey && SF.anchor) {
    const order = SF.flatOrder;
    const a = order.indexOf(SF.anchor);
    const b = order.indexOf(path);
    if (a >= 0 && b >= 0) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      SF.sel.clear();
      for (let i = lo; i <= hi; i++) SF.sel.add(order[i]);
      sfRender();
      return;
    }
  }
  if (ctrl) {
    if (SF.sel.has(path)) SF.sel.delete(path);
    else SF.sel.add(path);
    SF.anchor = path;
  } else {
    SF.sel.clear();
    SF.sel.add(path);
    SF.anchor = path;
  }
  sfRender();
}
function sfToggleDir(path) {
  if (SF.expanded.has(path)) SF.expanded.delete(path);
  else SF.expanded.add(path);
  sfRender();
}
function sfPreview(path) {
  if (typeof openFilePeek === "function") {
    if (!openFilePeek(path, { mode: "read" })) toast(I18n.t("无法预览该文件"), "warn");
  }
}

/* ── 菜单（瞬时菜单：点外部即收，属 AGENTS 允许的两类之一） ── */
function sfCloseMenu() {
  if (SF.menu && SF.menu.parentNode) SF.menu.parentNode.removeChild(SF.menu);
  SF.menu = null;
  document.removeEventListener("mousedown", sfMenuOutside, true);
}
function sfMenuOutside(ev) {
  if (SF.menu && !SF.menu.contains(ev.target)) sfCloseMenu();
}
function sfMenu(x, y, items) {
  sfCloseMenu();
  const m = document.createElement("div");
  m.className = "sf-menu";
  for (const it of items) {
    if (!it) continue;
    if (it.sep) {
      const s = document.createElement("div");
      s.className = "sf-menu-sep";
      m.appendChild(s);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sf-menu-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    else
      b.onclick = () => {
        sfCloseMenu();
        try {
          it.run();
        } catch (err) {
          toast(String((err && err.message) || err), "err");
        }
      };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  SF.menu = m;
  setTimeout(() => document.addEventListener("mousedown", sfMenuOutside, true), 0);
}
function sfRowMenu(x, y, path, isDir) {
  const paths = sfSelectedPaths();
  const many = paths.length > 1;
  const single = !many;
  const items = [];
  if (single && !isDir && sfPreviewable(path))
    items.push({ label: I18n.t("预览"), run: () => sfPreview(path) });
  items.push({
    label: I18n.t("在资源管理器中显示"),
    run: () => window.api.shellShowItem(path),
  });
  items.push({
    label: I18n.t("复制完整路径"),
    run: () => {
      window.api.clipboardWriteText(path);
      toast(I18n.t("已复制路径"), "ok");
    },
  });
  items.push({ sep: true });
  items.push({
    label: I18n.t("重命名"),
    disabled: many,
    run: () => sfBeginRename(path),
  });
  items.push({
    label: I18n.t("复制"),
    run: () => {
      SF.clip = { mode: "copy", paths };
      sfRender();
      toast(I18n.t("已复制 ") + paths.length + I18n.t(" 项"), "ok");
    },
  });
  items.push({
    label: I18n.t("剪切"),
    run: () => {
      SF.clip = { mode: "cut", paths };
      sfRender();
      toast(I18n.t("已剪切 ") + paths.length + I18n.t(" 项"), "ok");
    },
  });
  items.push({
    label: I18n.t("粘贴"),
    disabled: !SF.clip || !SF.clip.paths.length,
    run: () => sfPaste(),
  });
  items.push({ sep: true });
  items.push({
    label: I18n.t("删除"),
    danger: true,
    run: () => sfDelete(paths),
  });
  sfMenu(x, y, items);
}

/* ── 行内重命名 ── */
function sfBeginRename(path) {
  SF.renaming = path;
  sfRender();
  const inp = SF.renameInput;
  if (inp) {
    setTimeout(() => {
      try {
        inp.focus();
        const { stem } = sfSplitName(inp.value);
        inp.setSelectionRange(0, stem.length);
      } catch (_) {}
    }, 0);
  }
}
async function sfCommitRename(path, value) {
  const cur = sfBaseName(path);
  const name = String(value == null ? "" : value).trim();
  SF.renaming = "";
  if (!name || name === cur) {
    sfRender();
    return;
  }
  const r = await window.api
    .fileRename(path, name)
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  if (!r || r.ok === false) {
    toast(I18n.t("重命名失败：") + ((r && r.error) || ""), "err");
    sfRender();
    return;
  }
  const dest = r.path || sfJoin(sfDirOf(path), name);
  const parent = sfDirOf(path);
  SF.cache.delete(parent);
  SF.sel.clear();
  SF.sel.add(dest);
  SF.anchor = dest;
  await sfReadDir(parent);
  sfRender();
  toast(I18n.t("已重命名：") + name, "ok");
}

/* ── 复制 / 剪切 / 粘贴 / 删除 ── */
function sfPasteDir() {
  const paths = sfSelectedPaths();
  if (paths.length === 1 && SF.dirs.has(paths[0])) return paths[0];
  if (paths.length === 1) return sfDirOf(paths[0]) || SF.root;
  return SF.root;
}
async function sfPaste() {
  const clip = SF.clip;
  if (!clip || !clip.paths.length) {
    toast(I18n.t("剪贴板为空"), "warn");
    return;
  }
  const dest = sfPasteDir();
  if (!dest) return;
  const listing = await sfReadDir(dest);
  if (!listing.exists) {
    toast(I18n.t("目标文件夹不存在：") + dest, "warn");
    return;
  }
  const names = new Set(listing.entries.map((e) => e.name));
  let done = 0;
  const errs = [];
  for (const src of clip.paths) {
    if (clip.mode === "cut" && sfDirOf(src) === dest) continue; /* 剪到自己所在目录 = 无操作 */
    const name = sfUniqueName(sfBaseName(src), names);
    const target = sfJoin(dest, name);
    const call = clip.mode === "cut" ? window.api.fileMove : window.api.fileCopy;
    const r = await call(src, target).catch((err) => ({
      ok: false,
      error: String((err && err.message) || err),
    }));
    if (r && r.ok !== false) {
      names.add(name);
      done++;
    } else errs.push(sfBaseName(src) + "：" + ((r && r.error) || ""));
  }
  if (clip.mode === "cut") SF.clip = null;
  SF.cache.clear();
  SF.sel.clear();
  await sfReadDir(dest);
  sfRender();
  if (errs.length) toast(I18n.t("粘贴失败：") + errs.join(" · "), "err");
  else if (done) toast(I18n.t("已粘贴 ") + done + I18n.t(" 项"), "ok");
}
async function sfDelete(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  const msg =
    list.length === 1
      ? I18n.t("确定删除「{name}」？它会移入系统回收站。", { name: sfBaseName(list[0]) })
      : I18n.t("确定删除选中的 {n} 项？它们会移入系统回收站。", { n: list.length });
  const ok = await confirmDialog(msg, {
    title: I18n.t("删除"),
    okText: I18n.t("删除"),
    cancelText: I18n.t("取消"),
    danger: true,
  });
  if (!ok) return;
  let done = 0;
  const errs = [];
  for (const p of list) {
    const r = await window.api
      .fileTrash(p)
      .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    if (r && r.ok !== false) done++;
    else errs.push(sfBaseName(p) + "：" + ((r && r.error) || ""));
  }
  SF.cache.clear();
  SF.sel.clear();
  sfRender();
  if (errs.length)
    toast(
      I18n.t("删除失败（未删除，可能该位置不支持回收站）：") + errs.join(" · "),
      "err",
    );
  else if (done) toast(I18n.t("已删除 ") + done + I18n.t(" 项（在系统回收站）"), "ok");
}

/* ── 拖到画布（内部拖拽 → 确认 → 建节点） ── */
function sidebarFilesDropPayload(dt) {
  try {
    if (!dt || typeof dt.getData !== "function") return [];
    const raw = dt.getData("application/x-mtnode-files");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x) : [];
  } catch (_) {
    return [];
  }
}
async function sidebarFilesDropToCanvas(paths, pt) {
  const input = (paths || []).filter(Boolean);
  if (!input.length) return false;
  const files = [];
  const dirs = [];
  for (const p of input) {
    const isDir = await window.api.fileIsDir(p).catch(() => false);
    (isDir ? dirs : files).push(p);
  }
  /* 文件夹只取第一层文件（不递归）；子文件夹跳过 */
  const inner = [];
  for (const d of dirs) {
    const r = await sfReadDir(d);
    for (const e of r.entries) {
      if (e.isDir) continue;
      inner.push(sfJoin(d, e.name));
    }
  }
  const all = files.concat(inner);
  if (!all.length) {
    toast(I18n.t("这里没有可建节点的文件"), "warn");
    return true;
  }
  const counts = { image: 0, text: 0, audio: 0, video: 0, other: 0, total: all.length };
  for (const p of all) {
    const k =
      typeof classifyDropFile === "function" ? classifyDropFile(p) : "other";
    if (counts[k] === undefined) counts.other++;
    else counts[k]++;
  }
  const summary = sfDropSummary(counts, { dirs: dirs.length, files: inner.length });
  const ok = await confirmDialog(
    I18n.t("{summary}？创建后可 Ctrl+Z 一次撤销。", { summary: summary }),
    {
      title: I18n.t("拖入画布"),
      okText: I18n.t("创建节点"),
      cancelText: I18n.t("取消"),
    },
  );
  if (!ok) return true;
  if (typeof createNodesFromDroppedFiles !== "function") return true;
  await createNodesFromDroppedFiles(
    all.map((p) => ({ path: p })),
    pt || { x: 0, y: 0 },
  );
  return true;
}

/* ── 接线：包装 renderSidebar（切画布 / 打开边栏时文件页跟着刷新） ── */
function sfWrapRenderSidebar() {
  if (typeof window === "undefined") return;
  if (typeof window.renderSidebar !== "function" || window.renderSidebar.__sfWrapped) return;
  const orig = window.renderSidebar;
  const wrapped = function () {
    const r = orig.apply(this, arguments);
    try {
      if (SF.tab === "files") {
        /* 切画布（wf 变了）→ 目录选择按新画布的记忆重解析；同画布只重画树 */
        const wf = sfWorkflow();
        const wfId = (wf && wf.id) || "";
        if (wfId !== SF.wfId) {
          SF.wfId = wfId;
          SF.root = "";
          SF.expanded.clear();
          sfEnterRoot(null);
        } else sfRender();
      }
    } catch (_) {}
    return r;
  };
  wrapped.__sfWrapped = true;
  window.renderSidebar = wrapped;
}
function sfInit() {
  sfBuildTabs();
  sfWrapRenderSidebar();
  sfSyncRootSelect();
}
sfInit();

window.MTNodeSideFiles = {
  state: SF,
  init: sfInit,
  setTab: sfSetTab,
  refresh: sfRefresh,
  render: sfRender,
  preview: sfPreview,
  paste: sfPaste,
  dropPayload: sidebarFilesDropPayload,
  dropToCanvas: sidebarFilesDropToCanvas,
};
window.sidebarFilesDropPayload = sidebarFilesDropPayload;
window.sidebarFilesDropToCanvas = sidebarFilesDropToCanvas;

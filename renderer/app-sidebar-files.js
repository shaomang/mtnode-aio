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
 *   · 预览：md / 文本 / 图像 / 视频 / 音频 / PDF 行右侧「预览」字样，点击复用已有右侧面板 openFilePeek
 *     （音频由面板里的波形播放器承接；PDF 走面板里的 PDF 视图，页面图走 pdf:render）；
 *     单击只选中，双击文件名 = 预览（目录 = 展开 / 收起）。Ctrl / Shift 多选。
 *   · 文件操作：右键菜单 重命名 / 复制 / 剪切 / 删除 / 在资源管理器中显示 / 复制完整路径，
 *     页头小工具条 刷新 / 粘贴，键盘 Ctrl+C / Ctrl+X / Ctrl+V（焦点在本页时生效）。
 *     重命名是树内行内编辑（Enter 提交 / Esc 取消），粘贴落到当前选中文件夹
 *     （无选中 = 工作目录根），重名自动加 (2)。
 *   · 与 Windows 资源管理器双向互通（同一份系统剪贴板）：
 *       外部 → 本页：资源管理器复制 / 剪切后在这里粘贴；从资源管理器把文件 / 文件夹
 *                    拖进树 = 一律复制（文件夹递归）。
 *       本页 → 外部：这里复制 / 剪切后，在资源管理器里 Ctrl+V 能粘出文件 / 文件夹。
 *     读写走主进程 fsclip:readFiles / fsclip:writeFiles（真正的 CF_HDROP，见 fs-clipboard.js）。
 *     剪切标记（Preferred DropEffect = 2）识别得到就按移动处理；系统剪贴板里没有文件项时
 *     才回退到本模块的内部剪贴板记录 SF.clip。
 *   · 批量：超过 100 项弹非模态进度框（带「中断」），中断后已完成的保留不回滚。
 *   · 删除：确认后走系统回收站（file:trash），回收站不可用时主进程报错 → 提示并中止。
 *   · 拖到画布：内部拖拽（application/x-mtnode-files）→ 先弹窗确认，再由 app.js 的
 *     createNodesFromDroppedFiles 按类型建节点（图像 / 文本 / 音视频 / PDF 文件节点 /
 *     其余 → 执行节点）；
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
/* 视频：右侧文件面板现在内嵌原生播放器（不设体积上限），所以文件栏也给它「预览」入口 */
const SF_VIDEO_EXT = new Set([
  "mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "wmv", "flv", "mpeg", "mpg",
]);
/* 音频：右侧文件面板复用画布的方角波形播放器（点波形试听），文件栏同样给「预览」入口 */
const SF_AUDIO_EXT = new Set([
  "mp3", "wav", "wave", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma",
  "aif", "aiff", "amr", "weba", "mid", "midi", "caf", "ape", "mka",
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
  if (e === "md" || e === "markdown") return true;
  /* 没有后缀的文件按 Markdown 预览（与 app-fileview.js 的 fileviewLangOf / app.js 的
     isMdFilePath 同口径）：名字里整个没有 "." 才认，.env / .gitignore 这类隐藏文件不在此列 */
  return !e && sfBaseName(p).indexOf(".") < 0;
}
/* 文本 / 代码：优先复用 app-fileview.js 的语言判定（单一真源），退化到扩展名表 */
function sfLangOf(p) {
  return typeof fileviewLangOf === "function" ? fileviewLangOf(p) || "" : "";
}
function sfIsTextLike(p) {
  /* 没有后缀的文件按 Markdown 当文本看（fileviewLangOf 已判成 md，这里再兜一层，
     免得脚本加载顺序变了就退成「其他」、连预览入口都没有） */
  return sfIsMd(p) || !!sfLangOf(p) || SF_TEXT_EXT.has(sfExtOf(p));
}
function sfIsImagePath(p) {
  if (typeof fileviewIsImagePath === "function") return !!fileviewIsImagePath(p);
  return SF_IMAGE_EXT.has(sfExtOf(p));
}
/* 与 app-fileview.js 的 fileviewIsVideoPath 同口径：桥在就委托，缺席时用本地表 */
function sfIsVideoPath(p) {
  if (typeof fileviewIsVideoPath === "function") return !!fileviewIsVideoPath(p);
  return SF_VIDEO_EXT.has(sfExtOf(p));
}
/* 与 app-fileview.js 的 fileviewIsAudioPath 同口径：桥在就委托，缺席时用本地表 */
function sfIsAudioPath(p) {
  if (typeof fileviewIsAudioPath === "function") return !!fileviewIsAudioPath(p);
  return SF_AUDIO_EXT.has(sfExtOf(p));
}
/* 与 app.js / pdf-markdown.js 同口径：桥在就委托它的 pdfIsPdfPath，缺席时按后缀判 */
function sfIsPdfPath(p) {
  if (typeof pdfIsPdfPath === "function") return !!pdfIsPdfPath(p);
  return sfExtOf(p) === "pdf";
}
/* 需求口径：md / 文本 / 图像 / 视频 / 音频 / PDF 给「预览」字样
   （视频由面板里的原生播放器承接，音频由面板复用的波形播放器承接，
    PDF 由面板里的 PDF 视图承接（renderer/app-fileview.js 的 renderFilePeekPdf）） */
function sfPreviewable(p) {
  return (
    sfIsPdfPath(p) ||
    sfIsImagePath(p) ||
    sfIsVideoPath(p) ||
    sfIsAudioPath(p) ||
    sfIsTextLike(p)
  );
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
  if (sfIsPdfPath(p)) return "pdf";
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
  if (counts.pdf) parts.push("PDF " + counts.pdf);
  if (counts.other) parts.push(T("执行节点") + " " + counts.other);
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
  pdf:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M3.5 2.5h6l3 3v8h-9z"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="M9.5 2.5v3h3"/><path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" d="M5.4 8.6h5.2M5.4 10.4h3.4"/></svg>',
};

/* ── 运行态（模块级单例，不进画布数据） ── */
const SF = {
  tab: "nodes", /* nodes | files（画布）· files | core | refs（研究视图） */
  rootKind: "canvas", /* canvas | project | custom | research */
  root: "",
  expanded: new Set(),
  cache: new Map(), /* dir → {exists, entries[]} */
  sel: new Set(),
  dirs: new Set(), /* 已知是目录的路径（粘贴落点 / 剪贴判断用） */
  anchor: "",
  clip: null, /* 内部剪贴板（兜底）：{mode:"copy"|"cut", paths:[]} */
  active: false, /* 焦点 / 最近点击是否在本页（Ctrl+C/X/V 归属判定用） */
  busy: null, /* 批量粘贴进行中：{el, cancel, fill, meta, total} */
  query: "",
  typeFilter: "all",
  flatOrder: [],
  renaming: "",
  search: null, /* {q, list, capped} */
  menu: null,
  renameInput: null,
  /* 研究视图的根覆盖（<画布工作目录>/research）；只在研究视图里非空 */
  overrideDir: "",
  prevTab: "", /* 进研究视图前用户停在哪一格（离开时还回去） */
  researchTab: "", /* 研究视图里用户停在哪一格：files / core / refs */
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
/* 当前根（按画布记忆；记忆失效则回落画布工作目录）。
   研究视图强制覆盖成 <画布工作目录>/research（见 sfSetRootOverride）：覆盖只活在内存里，
   不写进 wf.sideFiles —— 那是「画布」的选择，不该被研究视图改掉。 */
function sfResolveRoot() {
  if (SF.overrideDir) return { kind: "research", dir: SF.overrideDir };
  const st = sfStoredRoot();
  if (st && st.kind === "project" && st.dir) return { kind: "project", dir: st.dir };
  if (st && st.kind === "custom" && st.dir) return { kind: "custom", dir: st.dir };
  return { kind: "canvas", dir: sfCanvasWs() };
}
/* 研究视图用：根锁定在 research/（目录可能还不存在 —— 初始化之后才有） */
function sfSetRootOverride(dir) {
  const d = String(dir || "").trim();
  SF.overrideDir = d;
  const sb = sf$("sidebar");
  if (sb) sb.classList.toggle("sf-research", !!d);
  /* 进研究视图：落回上次那一格（文件 / 核心 / 资料），没记过就用「核心」——
     左栏原来那棵内容树被搬到这里，进来第一眼该看到的是它。 */
  sfSetTab(d ? SF.researchTab || "core" : "files");
  sfEnterRoot(d ? { kind: "research", dir: d } : null);
}
function sfClearRootOverride() {
  /* 没有工作目录时 overrideDir 一直是空的，但左栏仍是研究视图那三格 —— 离开时照样要还原，
     否则画布视图会停在「核心 / 资料」的空白页上。 */
  if (!SF.overrideDir && SF.tab !== "core" && SF.tab !== "refs") return;
  SF.overrideDir = "";
  const sb = sf$("sidebar");
  if (sb) sb.classList.remove("sf-research");
  /* 回到画布记忆里那个根，并把 Tab 还给用户原来那一格 */
  sfEnterRoot(null);
  if (SF.prevTab) sfSetTab(SF.prevTab);
  else sfSetTab("nodes");
  SF.prevTab = "";
}
/* 研究视图重绘当前那一格：文件页重读盘，核心 / 资料两页交给研究模块自己画。
   （以前 renderSidebar 直接 setTab("files")，会把用户选中的「核心 / 资料」硬切掉。） */
function sfRepaintCurrent() {
  if (SF.tab === "core" || SF.tab === "refs") {
    try {
      if (window.MTResearch && typeof window.MTResearch.paintSide === "function")
        window.MTResearch.paintSide(SF.tab);
    } catch (_) {}
    return;
  }
  sfRefresh();
}

/* 进 / 出研究视图的唯一入口（由视图外壳 applyViewChrome 调） */
function sfOnViewChange(view) {
  if (view === "research") {
    if (!SF.overrideDir && SF.tab) SF.prevTab = SF.tab;
    const ws = sfCanvasWs();
    sfSetRootOverride(ws ? sfJoin(ws, "research") : "");
    return;
  }
  sfClearRootOverride();
}

/* ── 页头：Tabs / 目录选择器 / 工具条 ── */
/* 研究视图的「核心 / 资料」两颗 Tab 接拖入：从资源管理器拖文件到 Tab 上 = 投进投料台对应那一栏。
   （面板空白处的拖入在 app-research.js 的 bindPanelDrop 里，两边共用 dropIntoPanel。） */
function sfBindResearchTabDrop(tabEl, role) {
  if (!tabEl || tabEl.__dropBound) return;
  tabEl.__dropBound = "1";
  const hasFiles = (dt) => {
    try {
      return !!dt && Array.prototype.indexOf.call(dt.types || [], "Files") >= 0;
    } catch (_) {
      return false;
    }
  };
  tabEl.addEventListener("dragover", (ev) => {
    if (!hasFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    try {
      ev.dataTransfer.dropEffect = "copy";
    } catch (_) {}
    tabEl.classList.add("drop-on");
  });
  tabEl.addEventListener("dragleave", () => tabEl.classList.remove("drop-on"));
  tabEl.addEventListener("drop", (ev) => {
    if (!hasFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.stopPropagation();
    tabEl.classList.remove("drop-on");
    try {
      if (window.MTResearch && typeof window.MTResearch.dropIntoPanel === "function")
        window.MTResearch.dropIntoPanel(role, ev.dataTransfer);
    } catch (_) {}
  });
}
function sfBuildTabs() {
  const tabs = sf$("sideTabs");
  if (!tabs || tabs.__sfBound) return;
  tabs.__sfBound = true;
  const nodes = sf$("sideTabNodes");
  const files = sf$("sideTabFiles");
  const core = sf$("sideTabCore");
  const refs = sf$("sideTabRefs");
  if (nodes) nodes.onclick = () => sfSetTab("nodes");
  if (files) files.onclick = () => sfSetTab("files");
  if (core) core.onclick = () => sfSetTab("core");
  if (refs) refs.onclick = () => sfSetTab("refs");
  /* 「核心 / 资料」两格也接拖入：文件直接拖到 Tab 上 = 投进投料台对应的那一栏 */
  sfBindResearchTabDrop(core, "core");
  sfBindResearchTabDrop(refs, "ref");
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
  /* 研究视图里根是锁死的（research/），选择器退化成一行只读回显 */
  if (SF.overrideDir) {
    sel.innerHTML = "";
    const o = document.createElement("option");
    o.value = "__research__";
    o.textContent = I18n.t("研究目录：research");
    sel.appendChild(o);
    sel.selectedIndex = 0;
    sel.disabled = true;
    sel.title = SF.overrideDir;
    return;
  }
  sel.disabled = false;
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
/* 当前是不是在研究视图：根覆盖生效，或视图外壳已经把 body 挂成 view-research */
function sfInResearch() {
  try {
    if (SF.overrideDir) return true;
    return !!document.body && document.body.classList.contains("view-research");
  } catch (_) {
    return !!SF.overrideDir;
  }
}
function sfSetTab(tab) {
  const want = String(tab || "");
  /* 画布视图只有 节点 / 文件 两格；研究视图换成 文件 / 核心 / 资料 三格
     （节点列表属于画布）。判据 = 根覆盖生效，或视图外壳已把 body 挂成 view-research
     —— 没有工作目录时 overrideDir 是空的，左栏照样是三格，不能退回节点页。 */
  const inRs = sfInResearch();
  if (inRs) SF.tab = want === "files" || want === "refs" ? want : "core";
  else SF.tab = want === "files" ? "files" : "nodes";
  if (inRs) SF.researchTab = SF.tab;
  const sb = sf$("sidebar");
  if (sb) {
    sb.classList.toggle("sf-on", SF.tab === "files");
    sb.classList.toggle("sf-core", SF.tab === "core");
    sb.classList.toggle("sf-refs", SF.tab === "refs");
  }
  const nodes = sf$("sideTabNodes");
  const files = sf$("sideTabFiles");
  const core = sf$("sideTabCore");
  const refs = sf$("sideTabRefs");
  if (nodes) nodes.classList.toggle("on", SF.tab === "nodes");
  if (files) files.classList.toggle("on", SF.tab === "files");
  if (core) core.classList.toggle("on", SF.tab === "core");
  if (refs) refs.classList.toggle("on", SF.tab === "refs");
  if (SF.tab === "files") sfEnterRoot(null);
  /* 核心 / 资料两页由研究模块自己画（内容树 / 文献库），这里只递一声「该画哪一页」 */
  if (SF.tab === "core" || SF.tab === "refs") {
    try {
      if (window.MTResearch && typeof window.MTResearch.paintSide === "function")
        window.MTResearch.paintSide(SF.tab);
    } catch (_) {}
  }
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
  /* PDF 也走右侧文件面板（renderer/app-fileview.js 的 renderFilePeekPdf：页面图走
     主进程 pdf:render），与图片 / 视频 / 音频 / 文本同一个预览框，不再弹翻页浮层。
     面板通道缺席时才退回 app-pdfview.js 的浮层。 */
  if (typeof openFilePeek === "function") {
    if (!openFilePeek(path, { mode: "read" })) toast(I18n.t("无法预览该文件"), "warn");
    return;
  }
  if (sfIsPdfPath(path) && typeof openPdfPreview === "function") {
    openPdfPreview(path, { title: sfBaseName(path) });
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
      /* 走唯一出口（renderer/app-clipboard.js）：原来直接调桥 + 立刻 toast，
         桥没应答时用户照样看到「已复制路径」（假成功）。成功文案不变。 */
      appClipboardCopy(path, I18n.t("已复制路径"));
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
    run: () => sfCopySel("copy"),
  });
  items.push({
    label: I18n.t("剪切"),
    run: () => sfCopySel("cut"),
  });
  items.push({
    label: I18n.t("粘贴"),
    disabled: !!SF.busy,
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

/* ── 复制 / 剪切 / 粘贴（与 Windows 资源管理器双向互通） ──
   读：主进程 fsclip:readFiles（PowerShell 读 FileDrop 全部条目 + Preferred DropEffect）；
   写：主进程 fsclip:writeFiles（写真正的 CF_HDROP，资源管理器里能直接粘贴）。
   SF.clip 只是兜底：系统剪贴板里没有文件项时才用它（用户中途在别处复制文字时，
   不该让页内那条记录失效，所以两份都留着）。 */
/* 超过这么多项才弹进度框；少量就一句 toast 收尾 */
const SF_PROGRESS_MIN = 100;

function sfPasteDir() {
  const paths = sfSelectedPaths();
  if (paths.length === 1 && SF.dirs.has(paths[0])) return paths[0];
  if (paths.length === 1) return sfDirOf(paths[0]) || SF.root;
  return SF.root;
}

/* 选中项 → 同时写进系统剪贴板（资源管理器里可直接粘贴）与内部记录 */
async function sfCopySel(mode) {
  const paths = sfSelectedPaths();
  if (!paths.length) {
    toast(I18n.t("未选择"), "warn");
    return;
  }
  const m = mode === "cut" ? "cut" : "copy";
  SF.clip = { mode: m, paths };
  sfRender();
  let r = null;
  try {
    r = await window.api.fsClipWriteFiles(paths, m);
  } catch (err) {
    r = { ok: false, error: String((err && err.message) || err) };
  }
  const done = (m === "cut" ? I18n.t("已剪切 ") : I18n.t("已复制 ")) + paths.length + I18n.t(" 项");
  if (r && r.ok !== false) {
    toast(done, "ok");
    return;
  }
  /* 系统剪贴板写失败：页内粘贴仍可用（内部记录在），但资源管理器里粘不出来 —— 必须说清 */
  toast(done + I18n.t("（写入系统剪贴板失败：{err}）", { err: (r && r.error) || "" }), "warn");
}

/* ── 批量进度框（非模态：不挡操作，带「中断」，完成后自动关） ── */
function sfProgressClose() {
  const b = SF.busy;
  SF.busy = null;
  if (b && b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el);
}
function sfProgressOpen(title) {
  sfProgressClose();
  const el = document.createElement("div");
  el.className = "sf-progress";
  const t = document.createElement("div");
  t.className = "sf-progress-title";
  t.textContent = title;
  const bar = document.createElement("div");
  bar.className = "sf-progress-bar";
  const fill = document.createElement("i");
  bar.appendChild(fill);
  const meta = document.createElement("div");
  meta.className = "sf-progress-meta";
  meta.textContent = "0 / 0";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sf-progress-cancel";
  btn.textContent = I18n.t("中断");
  btn.onclick = () => {
    if (!SF.busy) return;
    SF.busy.cancel = true;
    btn.disabled = true;
    btn.textContent = I18n.t("正在中断…");
  };
  el.appendChild(t);
  el.appendChild(bar);
  el.appendChild(meta);
  el.appendChild(btn);
  document.body.appendChild(el);
  SF.busy = { el, cancel: false, fill, meta, total: 0 };
  return SF.busy;
}
function sfProgressUpdate(done, total) {
  const b = SF.busy;
  if (!b || !b.fill) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  try {
    b.fill.style.width = pct + "%";
    b.meta.textContent = done + " / " + total;
  } catch (_) {}
}

/* 批量复制 / 移动。items 可以是路径字符串，也可以是 fsclip 回的 {path} 对象。
   返回 { ok, failed[], skipped, cancelled, total }；中断时已完成的保留，不回滚。 */
async function sfRunBatch(items, dest, opts) {
  const list = (items || [])
    .map((x) => (typeof x === "string" ? x : x && x.path))
    .filter((p) => typeof p === "string" && !!p);
  const mode = opts && opts.mode === "cut" ? "cut" : "copy";
  const total = list.length;
  const res = { ok: 0, failed: [], skipped: 0, cancelled: false, total };
  if (!total) return res;
  const listing = await sfReadDir(dest);
  const names = new Set(listing.entries.map((e) => e.name));
  const destKey = String(dest).toLowerCase();
  if (total > SF_PROGRESS_MIN) {
    sfProgressOpen(mode === "cut" ? I18n.t("移动中…") : I18n.t("粘贴中…"));
  }
  /* 少量不弹进度框，但同样占住「正在粘贴」这把锁：连按两次 Ctrl+V 不会两批交错跑 */
  if (!SF.busy) SF.busy = { el: null, cancel: false, fill: null, meta: null, total: 0 };
  SF.busy.total = total;
  sfProgressUpdate(0, total);
  for (const src of list) {
    if (SF.busy && SF.busy.cancel) {
      res.cancelled = true;
      break;
    }
    /* 源就在目标目录里 = 无操作（资源管理器同款），也不在粘贴时多复制出第二份 */
    if (sfDirOf(src).toLowerCase() === destKey) {
      res.skipped++;
      sfProgressUpdate(res.ok + res.failed.length + res.skipped, total);
      continue;
    }
    const name = sfUniqueName(sfBaseName(src), names);
    const target = sfJoin(dest, name);
    const call = mode === "cut" ? window.api.fileMove : window.api.fileCopy;
    let r = null;
    try {
      r = await call(src, target);
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    if (r && r.ok !== false) {
      names.add(name);
      res.ok++;
    } else res.failed.push(sfBaseName(src) + "：" + ((r && r.error) || ""));
    sfProgressUpdate(res.ok + res.failed.length + res.skipped, total);
  }
  sfProgressClose();
  return res;
}
function sfBatchToast(res, mode, verb) {
  if (res.failed.length) {
    toast(
      I18n.t("粘贴失败：") +
        res.failed.slice(0, 5).join(" · ") +
        (res.failed.length > 5 ? " …" : "") +
        I18n.t("（成功 {ok} / 共 {total} 项）", { ok: res.ok, total: res.total }),
      "err",
    );
    return;
  }
  if (res.cancelled) {
    toast(
      I18n.t("已中断：完成 {done} / 共 {total} 项", { done: res.ok, total: res.total }),
      "warn",
    );
    return;
  }
  if (!res.ok && !res.skipped) return;
  const head =
    (verb || (mode === "cut" ? I18n.t("已移动 ") : I18n.t("已粘贴 "))) + res.ok + I18n.t(" 项");
  const tail = res.skipped ? I18n.t("（跳过 {n} 项）", { n: res.skipped }) : "";
  toast(head + tail, "ok");
}

/* 这次粘贴该用哪份文件列表：系统剪贴板优先（与资源管理器同步），没有才回退内部记录 */
async function sfClipItems() {
  let sys = null;
  try {
    sys = await window.api.fsClipReadFiles();
  } catch (_) {}
  if (sys && sys.ok !== false && Array.isArray(sys.paths) && sys.paths.length) {
    return {
      source: "system",
      mode: sys.effect === "cut" ? "cut" : "copy",
      items: sys.paths.map((x) => (x && x.path) || "").filter(Boolean),
    };
  }
  if (SF.clip && SF.clip.paths && SF.clip.paths.length) {
    return {
      source: "internal",
      mode: SF.clip.mode === "cut" ? "cut" : "copy",
      items: SF.clip.paths.slice(),
    };
  }
  return null;
}

async function sfPaste() {
  if (SF.busy) {
    toast(I18n.t("正在粘贴中，请稍候"), "warn");
    return;
  }
  if (!SF.root) {
    toast(I18n.t("尚未设置工作目录"), "warn");
    return;
  }
  const dest = sfPasteDir();
  if (!dest) return;
  const listing = await sfReadDir(dest);
  if (!listing.exists) {
    toast(I18n.t("目标文件夹不存在：") + dest, "warn");
    return;
  }
  const clip = await sfClipItems();
  if (!clip || !clip.items.length) {
    toast(I18n.t("剪贴板为空"), "warn");
    return;
  }
  const res = await sfRunBatch(clip.items, dest, { mode: clip.mode });
  /* 内部记录的「剪切」用掉即失效；系统剪贴板那份不动（与资源管理器一致） */
  if (clip.source === "internal" && clip.mode === "cut" && res.ok) SF.clip = null;
  SF.cache.clear();
  SF.sel.clear();
  await sfReadDir(dest);
  sfRender();
  sfBatchToast(res, clip.mode);
}

/* ── 从资源管理器拖文件 / 文件夹进树：一律复制（文件夹由 file:copy 递归复制） ── */
function sfDropTargetDir(target) {
  const row = target && target.closest ? target.closest(".sf-row") : null;
  const p = row && row.dataset ? String(row.dataset.path || "") : "";
  if (!p) return SF.root;
  return SF.dirs.has(p) ? p : sfDirOf(p) || SF.root;
}
function sfSetDropHint(on) {
  const box = sf$("sideFilesTree");
  if (box) box.classList.toggle("sf-drop", !!on);
}
async function sfImportFromOS(paths, dest) {
  if (SF.busy) {
    toast(I18n.t("正在粘贴中，请稍候"), "warn");
    return;
  }
  if (!dest) return;
  const listing = await sfReadDir(dest);
  if (!listing.exists) {
    toast(I18n.t("目标文件夹不存在：") + dest, "warn");
    return;
  }
  const res = await sfRunBatch(paths, dest, { mode: "copy" });
  SF.cache.clear();
  SF.sel.clear();
  await sfReadDir(dest);
  sfRender();
  sfBatchToast(res, "copy", I18n.t("已复制 "));
}
function sfBindDrop() {
  const box = sf$("sideFilesTree");
  if (!box || box.__sfDropBound) return;
  box.__sfDropBound = true;
  /* 只认「外部文件」拖放：树内的拖拽走 application/x-mtnode-files，不在这里拦 */
  const hasOsFiles = (dt) =>
    !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, "Files") >= 0);
  box.addEventListener("dragover", (ev) => {
    if (!hasOsFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = "copy";
    sfSetDropHint(true);
  });
  box.addEventListener("dragleave", (ev) => {
    if (!ev.relatedTarget || !box.contains(ev.relatedTarget)) sfSetDropHint(false);
  });
  box.addEventListener("drop", async (ev) => {
    if (!hasOsFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.stopPropagation();
    sfSetDropHint(false);
    const files = ev.dataTransfer.files;
    const paths = [];
    for (let i = 0; i < files.length; i++) {
      let p = "";
      try {
        /* Electron 39 里 File.path 已不存在，取路径必须走 webUtils 桥 */
        p = window.api.getPathForFile ? String(window.api.getPathForFile(files[i]) || "") : "";
      } catch (_) {}
      if (p) paths.push(p);
    }
    if (!paths.length) return;
    await sfImportFromOS(paths, sfDropTargetDir(ev.target));
  });
}

/* ── 键盘：Ctrl+C / Ctrl+X / Ctrl+V（焦点在本页时生效，捕获阶段先于画布的节点复制） ── */
function sfTrackActive(ev) {
  const t = ev && ev.target;
  SF.active = !!(t && t.closest && t.closest("#sideFiles"));
}
function sfKeydown(ev) {
  if (SF.tab !== "files" || !SF.active) return;
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  const key = String(ev.key || "").toLowerCase();
  if (key !== "c" && key !== "x" && key !== "v") return;
  const t = ev.target;
  const tag = t && t.tagName ? String(t.tagName).toLowerCase() : "";
  /* 搜索框 / 重命名输入框里让位给原生文字复制粘贴 */
  if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (key === "c") sfCopySel("copy");
  else if (key === "x") sfCopySel("cut");
  else sfPaste();
}
function sfBindKeys() {
  if (typeof document === "undefined" || document.__sfKeysBound) return;
  document.__sfKeysBound = true;
  document.addEventListener("mousedown", sfTrackActive, true);
  document.addEventListener("focusin", sfTrackActive, true);
  /* 捕获阶段：画布那边的 Ctrl+C / Ctrl+V（window 冒泡监听）不会再拿走本页的复制粘贴 */
  document.addEventListener("keydown", sfKeydown, true);
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
  const counts = { image: 0, text: 0, audio: 0, video: 0, pdf: 0, other: 0, total: all.length };
  for (const p of all) {
    /* PDF 拖入会建成普通「文件节点」（保留原文件，不解析成文本），摘要里单独算「PDF」；
       其余认不出 / 可执行的文件建成执行节点，摘要里算「执行」 */
    const isPdf = typeof pdfIsPdfPath === "function" && pdfIsPdfPath(p);
    const k = isPdf
      ? "pdf"
      : typeof classifyDropFile === "function"
        ? classifyDropFile(p)
        : "other";
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
  /* 系统剪贴板互通的两个入口：键盘快捷键 + 从资源管理器拖进树 */
  sfBindKeys();
  sfBindDrop();
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
  copy: () => sfCopySel("copy"),
  cut: () => sfCopySel("cut"),
  importPaths: sfImportFromOS,
  dropPayload: sidebarFilesDropPayload,
  dropToCanvas: sidebarFilesDropToCanvas,
  /* 研究视图专用：根锁到 <画布工作目录>/research，离开自动还回去 */
  setRootOverride: sfSetRootOverride,
  clearRootOverride: sfClearRootOverride,
  onViewChange: sfOnViewChange,
  repaintCurrent: sfRepaintCurrent,
};
window.sidebarFilesDropPayload = sidebarFilesDropPayload;
window.sidebarFilesDropToCanvas = sidebarFilesDropToCanvas;

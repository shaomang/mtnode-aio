/* ============ 全局搜索（Ctrl+F） ============
 * 一个居中命令面板式浮层，跨区域全量搜索 MTNode 里的内容：
 *   画布（跨画布，含节点标题 / 正文 / 提示词 / 参数 / 运行结果 / 标注 / note）
 *   会话记录 · 专家团 · 素材库与本机文件 · 工具库 · 技能 · 模板商店 · 手册文档
 *
 * 口径（已与用户确认）：
 *   · Ctrl+F 在任何视图呼出（可编辑区让位给编辑器自带查找）；0.5s 防抖；≥2 字符才搜。
 *   · 大小写不敏感子串匹配，空格分词按 AND。
 *   · 实时扫描 + 运行期内存缓存（不建持久索引、不新增主进程模块）。
 *   · 结果按分类分组，每类默认 20 条（标题命中优先），可「显示更多」。
 *   · 搜索框下方是分栏 Tabs：默认「全部」，其后每个搜到的分类带条目数，点击即只看该分类。
 *   · 文件正文 / 手册正文 / 模板商店排在最后异步追加，该类标题显示搜索中，不阻塞其它结果。
 *   · 点开结果后关浮层并定位：画布→切画布选中节点；会话 / 专家团→切过去滚动到命中消息并高亮；
 *     素材 / 工具 / 技能 / 模板 / 文档→打开对应界面。
 *   · 浮层 persistent：不挂「点外部即关」，只走 Esc / ✕ / 点专注遮罩 / 再按一次 Ctrl+F。
 *   · 呼出即进入专注态：浮层之外的界面统一被主题色遮罩暗化（.gs-scrim），突出搜索结果。
 *
 * 加载顺序：app-teamview.js 之后、app-boot.js 之前（取用各模块已有全局函数）。
 * 公开入口：openGlobalSearch() / closeGlobalSearch() / globalSearchIsOpen()
 * ─────────────────────────────────────────────────────────────────── */

/* ── 单例状态 ── */
const GS = {
  open: false,
  query: "",
  last: "", // 上次查询：下次呼出回填并全选
  items: [],
  seq: 0,
  shown: {}, // 每类当前展示条数
  loading: {}, // 每类「正在搜索…」标记
  note: {}, // 每类副标题提示（如「正在搜索文件内容…」）
  tab: "all", // 结果分栏：all = 全部，其余 = 分类 id（用户切换的筛选）
  token: 0, // 每轮查询令牌：晚到的结果不许污染新一轮
  activeKey: "",
  flat: [],
  wfCache: new Map(), // wfId → { mtime, wf }
  docCache: new Map(), // 手册页 id → markdown
  guideCache: new Map(), // 节点指南 id → markdown
  bodyCache: new Map(), // 文本文件 absPath → { at, text }
  tplCache: new Map(), // 模板商店：查询串 → items
  tplOfflineAt: 0, // 模板商店上次失败时间（冷却期内不再重试）
  footNote: "", // 页脚补充提示（如模板商店离线）
  docCatalog: null, // 手册目录缓存
  scan: null,
  scanAt: 0,
  debounce: 0,
};

const GS_DEFAULT_SHOWN = 20;
const GS_MAX_PER_CAT = 200; // 单类收集上限（展示仍按 20 起步）
const GS_BODY_MAX_BYTES = 256 * 1024; // 单个文本文件正文读取上限
const GS_BODY_MAX_FILES = 40; // 一轮最多读多少个文本文件
const GS_TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|tsv|log|js|mjs|cjs|ts|css|html?|xml|ini|toml|py|sh|bat|ps1)$/i;

const GS_CATS = [
  { id: "canvas", label: "画布（跨画布）" },
  { id: "session", label: "会话记录" },
  { id: "team", label: "专家团" },
  { id: "asset", label: "素材库与本机文件" },
  { id: "tool", label: "工具库" },
  { id: "skill", label: "技能" },
  { id: "tpl", label: "模板商店" },
  { id: "doc", label: "手册文档" },
];

/* ── 小工具 ── */

function gsEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

function gsStr(v) {
  return v == null ? "" : String(v);
}

/* 查询分词：空格切成若干词，全部命中才算命中（AND） */
function gsTerms(q) {
  return gsStr(q)
    .toLowerCase()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

/* 返回首个命中位置（-1 = 未全部命中） */
function gsHit(text, terms) {
  const low = gsStr(text).toLowerCase();
  if (!low || !terms.length) return -1;
  let first = -1;
  for (const t of terms) {
    const at = low.indexOf(t);
    if (at < 0) return -1;
    if (first < 0 || at < first) first = at;
  }
  return first;
}

/* 命中片段：围绕首个命中词截一段，两端补省略号 */
function gsSnippet(text, terms, max) {
  const s = gsStr(text).replace(/\s+/g, " ").trim();
  if (!s) return "";
  const lim = max || 88;
  if (s.length <= lim) return s;
  const at = gsHit(s, terms);
  let start = at > 24 ? at - 24 : 0;
  if (start + lim > s.length) start = Math.max(0, s.length - lim);
  return (
    (start > 0 ? "…" : "") +
    s.slice(start, start + lim) +
    (start + lim < s.length ? "…" : "")
  );
}

/* 把文本写进元素，命中词包成 <mark>（全部走 DOM 节点，不拼 HTML） */
function gsMarkInto(host, text, terms) {
  const s = gsStr(text);
  if (!terms.length || !s) {
    host.textContent = s;
    return;
  }
  const low = s.toLowerCase();
  const ranges = [];
  for (const t of terms) {
    let from = 0;
    while (from < low.length) {
      const at = low.indexOf(t, from);
      if (at < 0) break;
      ranges.push([at, at + t.length]);
      from = at + Math.max(1, t.length);
      if (ranges.length > 80) break;
    }
  }
  if (!ranges.length) {
    host.textContent = s;
    return;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) host.appendChild(document.createTextNode(s.slice(pos, a)));
    const mk = document.createElement("mark");
    mk.className = "gs-hit";
    mk.textContent = s.slice(a, b);
    host.appendChild(mk);
    pos = b;
  }
  if (pos < s.length) host.appendChild(document.createTextNode(s.slice(pos)));
}

/* ── 浮层骨架 ── */

function gsEnsure() {
  let layer = document.getElementById("gsLayer");
  if (layer) return layer;
  layer = document.createElement("div");
  layer.id = "gsLayer";
  layer.className = "gs-layer";
  layer.hidden = true;
  layer.innerHTML =
    /* 专注遮罩：暗化浮层之外的全部界面，点它即关（只拦「无输入的空白」，
       不违反 persistent 口径——搜索框内没有任何待提交的设置项） */
    '<div class="gs-scrim" aria-hidden="true"></div>' +
    '<div class="gs-box" role="dialog" aria-modal="false">' +
    '<div class="gs-head">' +
    '<span class="gs-ico" aria-hidden="true">⌕</span>' +
    '<input id="gsInput" class="gs-input" type="text" autocomplete="off" spellcheck="false" />' +
    '<span id="gsCount" class="gs-count"></span>' +
    '<button type="button" id="gsClose" class="mini btn-sq gs-close">✕</button>' +
    "</div>" +
    '<div id="gsTabs" class="gs-tabs" hidden></div>' +
    '<div id="gsResults" class="gs-results"></div>' +
    '<div class="gs-foot"><span id="gsFootHint"></span></div>' +
    "</div>";
  document.body.appendChild(layer);

  const input = layer.querySelector("#gsInput");
  const closeBtn = layer.querySelector("#gsClose");
  input.addEventListener("input", () => {
    gsSchedule();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeGlobalSearch();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      gsOpenActive();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      ev.stopPropagation();
      gsMoveActive(1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      ev.stopPropagation();
      gsMoveActive(-1);
    }
  });
  closeBtn.onclick = () => closeGlobalSearch();
  /* 专注遮罩：点空白处（遮罩本体）即关；遮罩是独立兄弟层，搜索框本体不受影响 */
  const scrim = layer.querySelector(".gs-scrim");
  if (scrim) scrim.onclick = () => closeGlobalSearch();
  /* 浮层是 persistent 的：只允许 Esc / ✕ / 点遮罩 / 再按一次 Ctrl+F 关闭 */
  layer.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeGlobalSearch();
    }
  });
  /* Esc 兜底：焦点被点到别处时也能关（键盘显式路径，不是点外部关闭） */
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!GS.open) return;
      if (ev.key !== "Escape") return;
      if (document.getElementById("imgLb") && document.getElementById("imgLb").classList.contains("on")) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeGlobalSearch();
    },
    true,
  );
  gsPaintLabels();
  return layer;
}

function gsPaintLabels() {
  const layer = document.getElementById("gsLayer");
  if (!layer) return;
  const input = layer.querySelector("#gsInput");
  const closeBtn = layer.querySelector("#gsClose");
  const foot = layer.querySelector("#gsFootHint");
  if (input) input.placeholder = I18n.t("搜索画布、会话、专家团、素材、工具、技能与文档…");
  if (closeBtn) closeBtn.title = I18n.t("关闭（Esc）");
  if (foot)
    foot.textContent =
      I18n.t("↑↓ 选择 · Enter 打开 · Esc 关闭") +
      " · " +
      I18n.t("点开结果后自动关闭") +
      (GS.footNote ? " · " + GS.footNote : "");
}

function globalSearchIsOpen() {
  return !!GS.open;
}

function openGlobalSearch(opts) {
  opts = opts || {};
  const layer = gsEnsure();
  if (!layer) return;
  gsPaintLabels();
  GS.open = true;
  layer.hidden = false;
  layer.classList.add("on");
  const input = layer.querySelector("#gsInput");
  if (input) {
    input.value = opts.keep ? input.value : GS.last || "";
    input.focus();
    if (input.value) input.select();
  }
  const val = input ? input.value : "";
  GS.query = val;
  GS.last = val;
  if (val.trim().length >= 2 && gsTerms(val).length) {
    gsRun(true);
  } else {
    GS.items = [];
    GS.loading = {};
    GS.note = {};
    gsRender();
  }
}

function closeGlobalSearch() {
  if (!GS.open) return false;
  GS.open = false;
  GS.token++; // 作废在飞的一轮：晚到的结果不再落地
  GS.debounce && clearTimeout(GS.debounce);
  GS.debounce = 0;
  const layer = document.getElementById("gsLayer");
  if (layer) {
    layer.hidden = true;
    layer.classList.remove("on");
  }
  return true;
}

/* ── 渲染 ── */

function gsResultsHost() {
  return document.getElementById("gsResults");
}

/* ── 结果分栏（Tabs）──
 * 有结果后出现在搜索框下方：默认「全部」，其后是每个搜到的分类 + 条目数，
 * 点标签即只显示该分类（再点「全部」还原）。分类清单由 CATS 顺序决定。 */
function gsTabsHost() {
  return document.getElementById("gsTabs");
}

function gsTabList() {
  const list = [{ id: "all", label: I18n.t("全部"), n: GS.items.length, loading: false }];
  for (const cat of GS_CATS) {
    const n = GS.items.filter((it) => it.cat === cat.id).length;
    const loading = !!GS.loading[cat.id];
    if (!n && !loading) continue;
    list.push({ id: cat.id, label: I18n.t(cat.label), n: n, loading: loading });
  }
  return list;
}

function gsRenderTabs() {
  const host = gsTabsHost();
  if (!host) return;
  const list = gsTabList();
  if (list.length <= 1) {
    /* 还没产生任何结果：不占位 */
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  /* 当前筛选的分类在新一轮里没有结果了（如换了关键词）→ 回到「全部」 */
  if (GS.tab !== "all" && !list.some((t) => t.id === GS.tab)) GS.tab = "all";
  host.hidden = false;
  host.innerHTML = "";
  for (const t of list) {
    const b = gsEl("button", "gs-tab" + (t.id === GS.tab ? " on" : ""));
    b.type = "button";
    b.dataset.gsTab = t.id;
    b.appendChild(gsEl("span", "gs-tab-name", t.label));
    b.appendChild(gsEl("span", "gs-tab-n", t.loading ? String(t.n) + "…" : String(t.n)));
    b.onclick = () => {
      if (GS.tab === t.id) return;
      GS.tab = t.id;
      gsRender();
      const input = document.getElementById("gsInput");
      if (input && input.focus) input.focus();
    };
    host.appendChild(b);
  }
}

function gsRender() {
  const host = gsResultsHost();
  if (!host) return;
  host.innerHTML = "";
  GS.flat = [];
  GS.activeKey = "";
  const terms = gsTerms(GS.query);
  const shortQuery = !!GS.query && GS.query.trim().length > 0 && GS.query.trim().length < 2;

  if (!GS.query || !terms.length) {
    host.appendChild(
      gsEl(
        "div",
        "gs-empty",
        shortQuery
          ? I18n.t("至少输入 2 个字符开始搜索")
          : I18n.t("搜索画布、会话、专家团、素材、工具、技能与文档…"),
      ),
    );
    gsRenderTabs();
    gsPaintCount();
    return;
  }
  if (shortQuery) {
    host.appendChild(gsEl("div", "gs-empty", I18n.t("至少输入 2 个字符开始搜索")));
    gsRenderTabs();
    gsPaintCount();
    return;
  }

  let totalShown = 0;
  /* 只有「全部」分栏才把其它分类的在飞状态算进来 */
  let anyLoading = GS.tab === "all" && !!GS.loading.main;
  for (const cat of GS_CATS) {
    /* 分栏筛选：非「全部」时只渲染选中的那一类 */
    if (GS.tab !== "all" && cat.id !== GS.tab) continue;
    const all = GS.items.filter((it) => it.cat === cat.id);
    const loading = !!GS.loading[cat.id];
    if (!all.length && !loading) continue;
    anyLoading = anyLoading || loading;
    const head = gsEl("div", "gs-cat");
    head.appendChild(gsEl("span", "gs-cat-name", I18n.t(cat.label)));
    head.appendChild(gsEl("span", "gs-cat-n", String(all.length)));
    if (loading) {
      const sp = gsEl("span", "gs-cat-loading", GS.note[cat.id] || I18n.t("正在搜索…"));
      head.appendChild(sp);
    }
    host.appendChild(head);

    const shown = GS.shown[cat.id] || GS_DEFAULT_SHOWN;
    const rows = all.slice(0, shown);
    for (const it of rows) {
      host.appendChild(gsRow(it, terms));
      GS.flat.push(it);
      totalShown++;
    }
    if (all.length > shown) {
      const more = gsEl("button", "gs-more", I18n.t("显示更多") + "（" + (all.length - shown) + "）");
      more.type = "button";
      more.onclick = () => {
        GS.shown[cat.id] = shown + GS_DEFAULT_SHOWN;
        gsRender();
      };
      host.appendChild(more);
    }
  }
  if (!totalShown) {
    host.appendChild(
      gsEl(
        "div",
        "gs-empty",
        anyLoading ? I18n.t("正在搜索…") : I18n.t("没有匹配的内容"),
      ),
    );
  } else if (anyLoading && !Object.keys(GS.loading).some((k) => GS.loading[k] && k !== "main")) {
    /* 只有主波还在跑：末尾补一行进度，让用户知道后面还有分类要出现 */
    const tail = gsEl("div", "gs-empty", I18n.t("正在搜索…"));
    host.appendChild(tail);
  }
  gsRenderTabs();
  gsPaintCount();
}

function gsRow(it, terms) {
  const row = gsEl("div", "gs-row");
  row.dataset.gsKey = it.key;
  const t = gsEl("div", "gs-row-title");
  gsMarkInto(t, it.title, terms);
  row.appendChild(t);
  if (it.sub) row.appendChild(gsEl("div", "gs-row-sub", it.sub));
  if (it.snippet) {
    const sn = gsEl("div", "gs-row-snippet");
    gsMarkInto(sn, it.snippet, terms);
    row.appendChild(sn);
  }
  row.addEventListener("mouseenter", () => {
    if (GS.activeKey === it.key) return;
    GS.activeKey = it.key;
    gsPaintActive();
  });
  row.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    gsOpenItem(it);
  });
  return row;
}

function gsPaintCount() {
  const el = document.getElementById("gsCount");
  if (!el) return;
  const n = GS.items.length;
  const loading = Object.keys(GS.loading).some((k) => GS.loading[k]);
  el.textContent = n ? String(n) + (loading ? "…" : "") : "";
}

function gsPaintActive() {
  const host = gsResultsHost();
  if (!host) return;
  for (const row of host.querySelectorAll(".gs-row")) {
    row.classList.toggle("on", row.dataset.gsKey === GS.activeKey);
  }
}

function gsMoveActive(delta) {
  if (!GS.flat.length) return;
  let idx = GS.flat.findIndex((it) => it.key === GS.activeKey);
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  idx = (idx + delta + GS.flat.length) % GS.flat.length;
  GS.activeKey = GS.flat[idx].key;
  gsPaintActive();
  const host = gsResultsHost();
  const row = host && host.querySelector('.gs-row[data-gs-key="' + gsCssEsc(GS.activeKey) + '"]');
  if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
}

function gsCssEsc(s) {
  return gsStr(s).replace(/["\\]/g, "\\$&");
}

function gsOpenActive() {
  const it = GS.flat.find((x) => x.key === GS.activeKey) || GS.flat[0];
  if (it) gsOpenItem(it);
}

/* ── 查询调度 ── */

function gsSchedule() {
  const input = document.getElementById("gsInput");
  GS.query = input ? input.value : "";
  GS.last = GS.query;
  GS.debounce && clearTimeout(GS.debounce);
  GS.debounce = setTimeout(() => {
    GS.debounce = 0;
    gsRun(false);
  }, 500);
}

function gsPush(list, it) {
  if (list.length >= GS_MAX_PER_CAT) return;
  it.key = it.cat + ":" + it.title + ":" + (it.sub || "") + ":" + list.length;
  list.push(it);
}

async function gsRun(keepShown) {
  const q = GS.query;
  const terms = gsTerms(q);
  if (q.trim().length < 2 || !terms.length) {
    GS.token++;
    GS.items = [];
    GS.loading = {};
    GS.note = {};
    GS.tab = "all";
    gsRender();
    return;
  }
  const token = ++GS.token;
  GS.items = [];
  GS.shown = {};
  GS.loading = {};
  GS.note = {};
  GS.tab = "all"; /* 新一轮查询回到「全部」分栏 */
  if (GS.footNote) {
    GS.footNote = "";
    gsPaintLabels();
  }

  /* 第一波：全部走内存 / 一次 IPC，秒出 */
  GS.loading.main = true;
  gsRender();
  const out = { canvas: [], session: [], team: [], asset: [], tool: [], skill: [], tpl: [], doc: [] };
  const push = (it) => {
    const list = out[it.cat];
    if (list) gsPush(list, it);
  };
  const jobs = [
    gsCollectCanvas(terms, push),
    gsCollectSessions(terms, push),
    gsCollectTeam(terms, push),
    gsCollectAssets(terms, push),
    gsCollectTools(terms, push),
    gsCollectSkills(terms, push),
    gsCollectDocTitles(terms, push),
  ];
  /* 每一类落地就重绘一次：画布要逐张 wfLoad，先到的会话 / 工具 / 技能不必等它 */
  await Promise.all(
    jobs.map((j) =>
      Promise.resolve(j)
        .catch(gsLogErr)
        .then(() => {
          if (token !== GS.token) return;
          GS.items = gsFlatten(out);
          gsSortItems();
          gsRender();
        }),
    ),
  );
  if (token !== GS.token) return;
  GS.loading.main = false;
  GS.items = gsFlatten(out);
  gsSortItems();
  gsRender();

  /* 第二波：手册 / 节点指南正文 + 模板商店（异步追加） */
  GS.loading.doc = true;
  GS.loading.tpl = true;
  if (GS.tplOfflineAt && Date.now() - GS.tplOfflineAt < 60000) {
    GS.loading.tpl = false;
    GS.note.tpl = "";
  }
  gsRender();
  const wave2 = [gsCollectDocBodies(terms, out, token), gsCollectTpl(terms, out, token)];
  for (const j of wave2) {
    try {
      await j;
    } catch (e) {
      gsLogErr(e);
    }
    if (token !== GS.token) return;
    GS.items = gsFlatten(out);
    gsSortItems();
    gsRender();
  }

  /* 第三波：素材文本条目正文（用户指定：优先度最低，最后才搜） */
  GS.loading.doc = false;
  GS.loading.tpl = false;
  GS.loading.asset = true;
  GS.note.asset = I18n.t("正在搜索文件内容…");
  gsRender();
  try {
    await gsCollectFileBodies(terms, out, token);
  } catch (e) {
    gsLogErr(e);
  }
  if (token !== GS.token) return;
  GS.loading.asset = false;
  gsNoteDrop("asset");
  GS.items = gsFlatten(out);
  gsSortItems();
  gsRender();
}

function gsFlatten(out) {
  const all = [];
  for (const cat of GS_CATS) {
    const list = out[cat.id] || [];
    for (const it of list) {
      it.key = it.cat + ":" + (it.uid || it.title + "|" + (it.sub || "")) + ":" + all.length;
      all.push(it);
    }
  }
  return all;
}

/* 类内排序：分数降序（标题命中 > 正文 > 结果 / 说明），同分保持收集顺序 */
function gsSortItems() {
  const rank = {};
  GS_CATS.forEach((c, i) => (rank[c.id] = i));
  const idx = new Map();
  GS.items.forEach((it, i) => idx.set(it, i));
  GS.items.sort((a, b) => {
    if (rank[a.cat] !== rank[b.cat]) return rank[a.cat] - rank[b.cat];
    const d = (b.score || 0) - (a.score || 0);
    return d !== 0 ? d : idx.get(a) - idx.get(b);
  });
}

function gsLogErr(e) {
  try {
    console.warn("全局搜索：某一类收集失败", e);
  } catch (_) {}
}

function gsNoteDrop(catId) {
  if (GS.note[catId]) delete GS.note[catId];
}

/* ── 收集：画布（跨画布） ── */

/* 节点可搜索字段：标题优先，其次正文 / 提示词 / 参数，最后结果与说明 */
function gsNodeFields(n) {
  const f = [];
  const add = (label, get, score) => {
    const v = get();
    if (v == null || v === "") return;
    f.push({ label: label, get: get, score: score });
  };
  add(I18n.t("标题"), () => n.title, 3);
  add(I18n.t("正文"), () => n.text, 2);
  add(I18n.t("提示词"), () => n.prompt, 2);
  add(I18n.t("任务"), () => n.task, 2);
  add(I18n.t("目标"), () => n.goal, 2);
  add(I18n.t("系统提示"), () => n.systemPrompt, 2);
  add(I18n.t("函数 JS"), () => n.jscode, 2);
  add(I18n.t("参数"), () => n.fnName, 2);
  add(I18n.t("说明"), () => n.note, 1);
  add(I18n.t("保存路径"), () => n.savePath, 1);
  add(I18n.t("监视路径"), () => n.waitPath, 1);
  add(I18n.t("程序路径"), () => n.execPath, 1);
  add(I18n.t("参数"), () => (n.toolConfig ? n.toolConfig.name : ""), 1);
  add(I18n.t("说明"), () => (n.toolConfig ? n.toolConfig.description : ""), 1);
  add(I18n.t("步骤"), () => gsStepsText(n), 1);
  add(I18n.t("批次条目"), () => gsBatchText(n), 1);
  add(I18n.t("运行结果"), () => gsOutputText(n), 1);
  return f;
}

function gsStepsText(n) {
  if (!Array.isArray(n.steps)) return "";
  return n.steps
    .map((s) => (s && typeof s === "object" ? gsStr(s.title) : gsStr(s)))
    .filter(Boolean)
    .join(" · ");
}

function gsBatchText(n) {
  const arr = Array.isArray(n.items) ? n.items : Array.isArray(n.batchItems) ? n.batchItems : null;
  if (!arr) return "";
  return arr
    .map((it) => {
      if (it == null) return "";
      if (typeof it === "string") return it;
      return [gsStr(it.title), gsStr(it.value), gsStr(it.text), gsStr(it.content), gsStr(it.path)]
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean)
    .join(" · ");
}

function gsOutputText(n) {
  const o = n && n.output;
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (typeof o.text === "string") return o.text;
  return "";
}

function gsMarkText(m) {
  if (!m) return "";
  if (m.kind === "text" || m.text != null) return gsStr(m.text);
  return [gsStr(m.title), gsStr(m.label)].filter(Boolean).join(" ");
}

async function gsCollectCanvas(terms, push) {
  if (!window.api || typeof window.api.wfList !== "function") return;
  let list = [];
  try {
    list = (await window.api.wfList()) || [];
  } catch (_) {
    return;
  }
  for (const it of list) {
    let wf = null;
    if (S.wf && S.wf.id === it.id) wf = S.wf;
    else {
      const hit = GS.wfCache.get(it.id);
      if (hit && hit.mtime === it.mtime) wf = hit.wf;
      else {
        try {
          const r = await window.api.wfLoad(it.id);
          if (r && r.ok && r.data) {
            wf = r.data;
            GS.wfCache.set(it.id, { mtime: it.mtime, wf: wf });
          }
        } catch (_) {}
      }
    }
    if (!wf) continue;
    const wfName = gsStr(wf.name || it.name || it.id);
    gsPushCanvasName(it.id, wfName, terms, push);
    for (const n of wf.nodes || []) {
      if (!n) continue;
      const hit = gsNodeHit(n, terms);
      if (!hit) continue;
      push({
        cat: "canvas",
        uid: "wf:" + it.id + ":n:" + n.id + ":" + hit.label,
        title: gsStr(n.title) || I18n.t("（未命名节点）"),
        sub: wfName + " · " + hit.label,
        snippet: hit.snippet,
        score: hit.score,
        goto: { kind: "canvasNode", wfId: it.id, nodeId: n.id },
      });
    }
    for (const m of wf.marks || []) {
      const txt = gsMarkText(m);
      if (gsHit(txt, terms) < 0) continue;
      push({
        cat: "canvas",
        uid: "wf:" + it.id + ":m:" + gsStr(m && m.id),
        title: gsSnippet(txt, terms, 32) || I18n.t("标注 / 便签"),
        sub: wfName + " · " + I18n.t("标注 / 便签"),
        snippet: gsSnippet(txt, terms),
        score: 1,
        goto: { kind: "canvasNode", wfId: it.id, nodeId: "" },
      });
    }
  }
}

function gsPushCanvasName(wfId, wfName, terms, push) {
  if (gsHit(wfName, terms) < 0) return;
  push({
    cat: "canvas",
    uid: "wf:" + wfId + ":name",
    title: wfName,
    sub: I18n.t("画布名"),
    snippet: "",
    score: 3,
    goto: { kind: "canvasNode", wfId: wfId, nodeId: "" },
  });
}

function gsNodeHit(n, terms) {
  for (const f of gsNodeFields(n)) {
    const v = f.get();
    if (gsHit(v, terms) < 0) continue;
    return { label: f.label, snippet: gsSnippet(v, terms), score: f.score };
  }
  return null;
}

/* ── 收集：会话记录 ── */

function gsCollectSessions(terms, push) {
  const list = typeof agentSessions === "function" ? agentSessions() : [];
  for (const st of list) {
    if (!st || st.archived) continue;
    const title = gsStr(st.title) || I18n.t("新会话");
    if (gsHit(title, terms) >= 0) {
      push({
        cat: "session",
        uid: "s:" + st.id,
        title: title,
        sub: I18n.t("会话标题"),
        snippet: "",
        score: 3,
        goto: { kind: "session", sessionId: st.id, msgIndex: -1 },
      });
    }
    const msgs = Array.isArray(st.messages) ? st.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const body = gsStr(m.content);
      if (!body || gsHit(body, terms) < 0) continue;
      push({
        cat: "session",
        uid: "s:" + st.id + ":" + i,
        title: title,
        sub: (m.role === "user" ? I18n.t("你") : "AI") + " · " + gsStr(st.workspace).split(/[\\/]/).pop(),
        snippet: gsSnippet(body, terms),
        score: 2,
        goto: { kind: "session", sessionId: st.id, msgIndex: i },
      });
    }
  }
}

/* ── 收集：专家团 ── */

function gsCollectTeam(terms, push) {
  const chats = typeof teamChats === "function" ? teamChats() : [];
  const experts = typeof teamExperts === "function" ? teamExperts() : [];
  const expertById = new Map();
  for (const e of experts) if (e && e.id) expertById.set(e.id, e);

  for (const e of experts) {
    const txt = [gsStr(e.name), gsStr(e.role), gsStr(e.persona && e.persona.tagline)].filter(Boolean).join(" · ");
    if (gsHit(txt, terms) < 0) continue;
    push({
      cat: "team",
      uid: "e:" + e.id,
      title: gsStr(e.name) || I18n.t("专家"),
      sub: I18n.t("专家") + (e.role ? " · " + gsStr(e.role) : ""),
      snippet: gsSnippet(txt, terms),
      score: 2,
      goto: { kind: "team", chatId: "", canvasId: gsStr(e.canvasId), expertId: e.id, msgIndex: -1 },
    });
  }

  for (const c of chats) {
    if (!c || c.archived) continue;
    const title = gsStr(c.title) || I18n.t("专家会话");
    const exp = expertById.get(c.expertId);
    const who = exp ? gsStr(exp.name) : "";
    const isGroup = c.kind === "group";
    if (gsHit(title, terms) >= 0) {
      push({
        cat: "team",
        uid: "c:" + c.id,
        title: title,
        sub: (who || I18n.t("专家团")) + " · " + I18n.t("会话标题"),
        snippet: "",
        score: 3,
        goto: {
          kind: "team",
          chatId: c.id,
          canvasId: gsStr(c.canvasId || c.projectId),
          expertId: gsStr(c.expertId),
          msgIndex: -1,
        },
      });
    }
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m) continue;
      const body = gsStr(m.content);
      if (!body || gsHit(body, terms) < 0) continue;
      const speaker = gsStr(m.name) || (m.expertId && expertById.get(m.expertId) ? gsStr(expertById.get(m.expertId).name) : "");
      push({
        cat: "team",
        uid: "c:" + c.id + ":" + i,
        title: title,
        sub: [who, speaker, m.role === "user" ? I18n.t("你") : isGroup ? I18n.t("群聊发言") : "AI"]
          .filter(Boolean)
          .join(" · "),
        snippet: gsSnippet(body, terms),
        score: 2,
        goto: {
          kind: "team",
          chatId: c.id,
          canvasId: gsStr(c.canvasId || c.projectId),
          expertId: gsStr(c.expertId),
          msgIndex: i,
        },
      });
    }
  }
}

/* ── 收集：素材库与本机文件 ── */

async function gsAssetScan() {
  const now = Date.now();
  if (GS.scan && now - GS.scanAt < 60000) return GS.scan;
  if (!window.api || typeof window.api.assetsScan !== "function") return null;
  let r = null;
  try {
    r = await window.api.assetsScan();
  } catch (_) {
    r = null;
  }
  GS.scan = r && r.ok && r.configured ? r.scan || { assets: [] } : { assets: [], noRoot: true };
  GS.scanAt = now;
  return GS.scan;
}

function gsCollectAssets(terms, push) {
  return gsAssetScan().then((scan) => {
    if (!scan || !Array.isArray(scan.assets)) return;
    for (const a of scan.assets) {
      if (!a) continue;
      const head = [gsStr(a.displayName), gsStr(a.folder), gsStr(a.desc)].filter(Boolean).join(" · ");
      if (gsHit(head, terms) >= 0) {
        push({
          cat: "asset",
          uid: "a:" + a.id,
          title: gsStr(a.displayName) || gsStr(a.folder) || a.id,
          sub: I18n.t("素材") + (a.catRel ? " · " + gsStr(a.catRel) : ""),
          snippet: gsSnippet(head, terms),
          score: 2,
          goto: { kind: "asset", assetId: a.id, itemId: "", catRel: gsStr(a.catRel) },
        });
      }
      for (const it of a.items || []) {
        if (!it) continue;
        /* 条目名 + 实体文件名都参与「本机文件」这一类的名称命中 */
        const fn = gsStr(it.file || it.absPath).split(/[\\/]/).pop();
        const t = gsStr(it.title);
        const head = [t, fn].filter(Boolean).join(" · ");
        if (!head || gsHit(head, terms) < 0) continue;
        push({
          cat: "asset",
          uid: "a:" + a.id + ":i:" + it.id,
          title: t || fn,
          sub: (gsStr(a.displayName) || gsStr(a.folder)) + " · " + I18n.t("素材条目"),
          snippet: fn && fn !== t ? gsSnippet(head, terms) : "",
          score: 2,
          goto: { kind: "asset", assetId: a.id, itemId: gsStr(it.id), catRel: gsStr(a.catRel) },
        });
      }
    }
  });
}

/* 第三波：素材里的文本条目正文（用户指定最低优先） */
async function gsCollectFileBodies(terms, out, token) {
  const scan = GS.scan;
  if (!scan || !Array.isArray(scan.assets)) return;
  const cands = [];
  for (const a of scan.assets) {
    for (const it of (a && a.items) || []) {
      if (!it || it.type !== "text") continue;
      const p = gsStr(it.absPath);
      if (!p || !GS_TEXT_EXT.test(p)) continue;
      if (it.bytes && it.bytes > GS_BODY_MAX_BYTES) continue;
      cands.push({ asset: a, item: it, abs: p });
      if (cands.length >= GS_BODY_MAX_FILES * 3) break;
    }
    if (cands.length >= GS_BODY_MAX_FILES * 3) break;
  }
  let read = 0;
  for (const c of cands) {
    if (read >= GS_BODY_MAX_FILES) break;
    if (token !== GS.token) return;
    const body = await gsReadTextCached(c.abs);
    if (body == null) continue;
    read++;
    if (gsHit(body, terms) < 0) continue;
    gsPush(out.asset, {
      cat: "asset",
      uid: "body:" + c.abs,
      title: gsStr(c.item.title) || c.abs.split(/[\\/]/).pop(),
      sub: (gsStr(c.asset.displayName) || gsStr(c.asset.folder)) + " · " + I18n.t("文件正文"),
      snippet: gsSnippet(body, terms),
      score: 1,
      goto: { kind: "asset", assetId: c.asset.id, itemId: gsStr(c.item.id), catRel: gsStr(c.asset.catRel) },
    });
    if (token !== GS.token) return;
    GS.items = gsFlatten(out);
    gsSortItems();
    gsRender();
  }
}

async function gsReadTextCached(abs) {
  const now = Date.now();
  const hit = GS.bodyCache.get(abs);
  if (hit && now - hit.at < 60000) return hit.text;
  if (!window.api || typeof window.api.fileReadText !== "function") return null;
  let text = null;
  try {
    const r = await window.api.fileReadText(abs);
    if (typeof r === "string") text = r;
    else if (r && typeof r.content === "string") text = r.content;
    else if (r && typeof r.text === "string") text = r.text;
    else if (r && r.ok && typeof r.content === "string") text = r.content;
  } catch (_) {
    text = null;
  }
  if (text == null) return null;
  if (GS.bodyCache.size > 200) GS.bodyCache.clear();
  GS.bodyCache.set(abs, { at: now, text: text });
  return text;
}

/* ── 收集：工具库 ── */

async function gsCollectTools(terms, push) {
  if (!window.api || typeof window.api.toolsList !== "function") return;
  let r = null;
  try {
    r = await window.api.toolsList();
  } catch (_) {
    return;
  }
  const tools = r && r.ok ? r.tools || [] : [];
  for (const t of tools) {
    if (!t) continue;
    const params = []
      .concat((t.inputs || []).map((p) => gsStr(p && p.name)))
      .concat((t.outputs || []).map((p) => gsStr(p && p.name)));
    const head = [gsStr(t.name), gsStr(t.description)].filter(Boolean).join(" · ");
    if (gsHit(head, terms) < 0 && gsHit(params.join(" "), terms) < 0) continue;
    push({
      cat: "tool",
      uid: "t:" + t.id,
      title: gsStr(t.name) || I18n.t("（未命名工具）"),
      sub: (t.kind === "function" ? I18n.t("函数") : I18n.t("工具")) + " · " + I18n.t("工具库"),
      snippet: gsSnippet(head || params.join(" · "), terms),
      score: gsHit(gsStr(t.name), terms) >= 0 ? 3 : 2,
      goto: { kind: "tool", toolId: gsStr(t.id), name: gsStr(t.name) },
    });
  }
}

/* ── 收集：技能（本机技能 + 内置技能索引） ── */

async function gsCollectSkills(terms, push) {
  const seen = new Set();
  let skills = [];
  try {
    skills = typeof loadSkillsCached === "function" ? await loadSkillsCached() : [];
  } catch (_) {
    skills = [];
  }
  const absorb = (arr) => {
    for (const s of arr || []) {
      if (!s) continue;
      const name = gsStr(s.name || s.skillName);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const tags = Array.isArray(s.tags) ? s.tags.join(" ") : gsStr(s.tags);
      const title = gsStr(s.title);
      const head = [title, name, gsStr(s.description), tags].filter(Boolean).join(" · ");
      if (gsHit(head, terms) < 0) continue;
      push({
        cat: "skill",
        uid: "k:" + name,
        title: title || name,
        sub: I18n.t("技能") + (title ? " · " + name : ""),
        snippet: gsSnippet(head, terms),
        score: gsHit(title || name, terms) >= 0 ? 3 : 2,
        goto: { kind: "skill", name: name },
      });
    }
  };
  absorb(skills);
  try {
    if (window.api && typeof window.api.mtnodeAgentSkillIndex === "function") {
      const r = await window.api.mtnodeAgentSkillIndex();
      /* 内置技能索引：{ ok, index: { categories: [ { title, skills: [{id,name,title,description}] } ] } } */
      const cats = r && r.index && Array.isArray(r.index.categories) ? r.index.categories : null;
      if (cats) {
        const flat = [];
        for (const cat of cats) {
          for (const sk of cat.skills || []) {
            if (!sk) continue;
            flat.push({
              name: gsStr(sk.name || sk.id),
              title: gsStr(sk.title),
              description: gsStr(sk.description),
              tags: gsStr(cat.title),
            });
          }
        }
        absorb(flat);
      } else if (r && Array.isArray(r.skills || r.list)) {
        absorb(r.skills || r.list);
      }
    }
  } catch (_) {}
}

/* ── 收集：手册文档（标题在第一波、正文在第二波） ── */

async function gsDocCatalog() {
  if (GS.docCatalog) return GS.docCatalog;
  if (!window.api || typeof window.api.docsCatalog !== "function") return null;
  try {
    const r = await window.api.docsCatalog();
    GS.docCatalog = r && r.ok ? r.catalog || null : null;
  } catch (_) {
    GS.docCatalog = null;
  }
  return GS.docCatalog;
}

function gsDocSections(cat) {
  const out = [];
  const locale = I18n.getLocale && I18n.getLocale() === "en" ? "en" : "zh";
  for (const sec of (cat && cat.sections) || []) {
    const secTitle = (sec.title && (sec.title[locale] || sec.title.zh || sec.title.en)) || sec.id || "";
    for (const page of sec.pages || []) {
      if (!page || !page.id) continue;
      const title = (page.title && (page.title[locale] || page.title.zh || page.title.en)) || page.id;
      out.push({ id: page.id, title: title, section: secTitle });
    }
  }
  return out;
}

const GS_GUIDES = [
  "input_text", "input_image", "input_audio", "input_video", "input_any", "input_file",
  "proc_text", "proc_image", "agent_task", "db_table", "remotion",
  "music_gen", "tts_gen", "video_gen", "save", "save_pdf", "control", "judge", "task",
  "wait_file", "timer", "delayer", "sequencer", "gate", "splitter", "counter",
  "mutex", "split", "merge", "super", "db_replica", "global", "execute",
  "tool", "function", "net_recv", "net_send",
  "ctrl-start", "ctrl-end-ok", "ctrl-end-fail",
];

function gsGuideNode(id) {
  if (id === "ctrl-start") return { kind: "control", ctrlRole: "start" };
  if (id === "ctrl-end-ok") return { kind: "control", ctrlRole: "endSuccess" };
  if (id === "ctrl-end-fail") return { kind: "control", ctrlRole: "endFail" };
  return { kind: id };
}

async function gsCollectDocTitles(terms, push) {
  const cat = await gsDocCatalog();
  for (const page of gsDocSections(cat)) {
    const head = page.section + " / " + page.title;
    if (gsHit(head, terms) < 0) continue;
    push({
      cat: "doc",
      uid: "d:" + page.id,
      title: page.title,
      sub: I18n.t("手册文档") + (page.section ? " · " + page.section : ""),
      snippet: gsSnippet(head, terms),
      score: gsHit(page.title, terms) >= 0 ? 3 : 2,
      goto: { kind: "doc", pageId: page.id },
    });
  }
}

async function gsCollectDocBodies(terms, out, token) {
  const cat = await gsDocCatalog();
  const pages = gsDocSections(cat);
  const locale = I18n.getLocale && I18n.getLocale() === "en" ? "en" : "zh";
  for (const page of pages) {
    if (token !== GS.token) return;
    let md = GS.docCache.get(page.id);
    if (md == null) {
      md = "";
      try {
        if (window.api && typeof window.api.docsLoad === "function") {
          const r = await window.api.docsLoad(page.id, locale);
          if (r && r.ok) md = gsStr(r.markdown);
        }
      } catch (_) {}
      GS.docCache.set(page.id, md);
    }
    if (!md || gsHit(md, terms) < 0) continue;
    gsPush(out.doc, {
      cat: "doc",
      uid: "db:" + page.id,
      title: page.title,
      sub: I18n.t("手册文档") + (page.section ? " · " + page.section : ""),
      snippet: gsSnippet(md, terms),
      score: 1,
      goto: { kind: "doc", pageId: page.id },
    });
    GS.items = gsFlatten(out);
    gsSortItems();
    gsRender();
  }
  /* 节点指南：逐个 id 读（带缓存），正文命中 */
  for (const id of GS_GUIDES) {
    if (token !== GS.token) return;
    let md = GS.guideCache.get(id);
    if (md == null) {
      md = "";
      try {
        if (window.api && typeof window.api.guideLoad === "function") {
          const r = await window.api.guideLoad(id, locale);
          if (r && r.ok) md = gsStr(r.markdown);
        }
      } catch (_) {}
      GS.guideCache.set(id, md);
    }
    if (!md || gsHit(md, terms) < 0) continue;
    const label = gsStr(I18n.t(id)) === id ? id : I18n.t(id);
    gsPush(out.doc, {
      cat: "doc",
      uid: "g:" + id,
      title: I18n.t("节点指南") + " · " + label,
      sub: I18n.t("手册文档"),
      snippet: gsSnippet(md, terms),
      score: 1,
      goto: { kind: "guide", guideId: id, node: gsGuideNode(id) },
    });
    GS.items = gsFlatten(out);
    gsSortItems();
    gsRender();
  }
}

/* ── 收集：模板商店（云端，查询级缓存；离线则跳过并提示） ── */

async function gsCollectTpl(terms, out, token) {
  const q = GS.query.trim();
  if (!window.api || typeof window.api.storeRequest !== "function") return;
  if (GS.tplOfflineAt && Date.now() - GS.tplOfflineAt < 60000) return;
  const key = q.toLowerCase();
  let items = GS.tplCache.get(key);
  if (!items) {
    let r = null;
    try {
      r = await Promise.race([
        window.api.storeRequest({
          method: "GET",
          path: "/api/templates?q=" + encodeURIComponent(q) + "&tag=&sort=new&page=1&pageSize=20",
        }),
        new Promise((res) => setTimeout(() => res(null), 6000)),
      ]);
    } catch (_) {
      r = null;
    }
    if (token !== GS.token) return;
    if (!r || !r.ok || !r.data || !Array.isArray(r.data.items)) {
      GS.tplOfflineAt = Date.now();
      GS.loading.tpl = false;
      GS.note.tpl = "";
      GS.footNote = I18n.t("模板商店当前离线，未参与搜索");
      gsPaintLabels();
      return;
    }
    items = r.data.items || [];
    if (GS.tplCache.size > 30) GS.tplCache.clear();
    GS.tplCache.set(key, items);
  }
  for (const it of items) {
    if (!it) continue;
    const head = [gsStr(it.title), gsStr(it.description), Array.isArray(it.tags) ? it.tags.join(" ") : gsStr(it.tags)]
      .filter(Boolean)
      .join(" · ");
    if (gsHit(head, terms) < 0) continue;
    gsPush(out.tpl, {
      cat: "tpl",
      uid: "p:" + gsStr(it.id),
      title: gsStr(it.title) || gsStr(it.id),
      sub: I18n.t("模板商店") + (it.official ? " · " + I18n.t("官方") : ""),
      snippet: gsSnippet(head, terms),
      score: gsHit(gsStr(it.title), terms) >= 0 ? 3 : 2,
      goto: { kind: "tpl", query: q },
    });
  }
}

/* ── 跳转定位 ── */

async function gsOpenItem(it) {
  if (!it || !it.goto) return;
  const query = GS.query.trim();
  GS.last = query;
  closeGlobalSearch();
  const g = it.goto;
  try {
    if (g.kind === "canvasNode") return await gsGotoCanvas(g);
    if (g.kind === "session") return await gsGotoSession(g);
    if (g.kind === "team") return await gsGotoTeam(g);
    if (g.kind === "asset") return await gsGotoAsset(g);
    if (g.kind === "tool") return gsGotoTool(g);
    if (g.kind === "skill") return await gsGotoSkill(g);
    if (g.kind === "tpl") return gsGotoTpl(g);
    if (g.kind === "doc") return gsGotoDoc(g);
    if (g.kind === "guide") return gsGotoGuide(g);
  } catch (e) {
    toast(I18n.t("定位失败：") + ((e && e.message) || String(e)), "err");
  }
}

/* 定位前收掉会盖住目标的那几层浮窗。
   结果点开就是要「看见它」：设置 / 工具库 / 创意工坊 / 素材库 / 手册阅读器还开着时，
   画布（或会话 / 专家团）在下面切好了，用户眼里却还是那只窗 —— 常被当成「没切过去」。
   只收「整屏挡住目标」的窗，不动瞬时的右键菜单 / 悬浮面板。 */
function gsDismissCoveringLayers() {
  try {
    if (typeof closeAssetLib === "function" && typeof assetLibOpen === "function" && assetLibOpen())
      closeAssetLib();
  } catch (_) {}
  try {
    const ext = document.getElementById("extManagerDlg");
    if (ext && ext.classList.contains("on") && typeof closeExtManagerDialog === "function")
      closeExtManagerDialog();
  } catch (_) {}
  try {
    const docs = document.getElementById("appDocsDlg");
    if (docs && docs.classList.contains("on") && typeof closeAppDocs === "function") closeAppDocs();
  } catch (_) {}
  /* #overlay 全应用独一份：设置 / 节点设置 / 工具库 / 创意工坊 / 技能正文都在里面 */
  try {
    if (typeof closeOverlay === "function") closeOverlay();
  } catch (_) {}
}

async function gsGotoCanvas(g) {
  gsDismissCoveringLayers();
  if (S.view !== "workflow" && typeof setView === "function") setView("workflow");
  const wfId = gsStr(g.wfId);
  if (!wfId) return;
  /* 判据一律取「前台真源」（currentVisibleWf）而不是 S.wf：后台换画布编辑（runAgainstWf）
     期间 S.wf 会被借给别的画布，拿它当判据会出现两种「点了一点动静都没有」：
       ① 点后台正在写的那张 → loadWorkflow 见「目标已是 S.wf」直接返回，前台没动；
       ② 点用户正看着的那张 → 反而去 loadWorkflow 读盘，把在飞的编辑上下文换掉。
       另一种隐形状：目标就是可见画布、S.wf 却被借走 —— focusNode / nodeById 读的是
       S.wf，不把前台真源指回来就会定位到别的画布的节点（甚至定位不到）。 */
  const vis0 = typeof currentVisibleWf === "function" ? currentVisibleWf() : null;
  const visId0 = vis0 ? gsStr(vis0.id) : "";
  let switched = visId0 === wfId;
  if (!switched) {
    if (typeof loadWorkflow === "function") {
      await loadWorkflow(wfId);
      const vis1 = typeof currentVisibleWf === "function" ? currentVisibleWf() : null;
      switched = !!vis1 && gsStr(vis1.id) === wfId;
    }
    if (!switched && S.wf && gsStr(S.wf.id) === wfId && typeof setForegroundWf === "function") {
      /* loadWorkflow 只看 S.wf：目标恰是后台借走的那张时它会直接 return —— 补一次前台切换 */
      setForegroundWf(S.wf);
      if (typeof renderAll === "function") renderAll();
      if (typeof refreshWfSelect === "function") refreshWfSelect();
      switched = true;
    }
  } else if (vis0 && S.wf !== vis0 && typeof setForegroundWf === "function") {
    /* 目标已是可见画布，但 S.wf 被后台编辑借走：指回来，后面的 focusNode 才认这张图 */
    setForegroundWf(vis0);
  }
  if (!switched) {
    toast(I18n.t("打开失败：") + wfId, "err");
    return;
  }
  if (g.nodeId && typeof focusNode === "function") {
    if (typeof nodeById === "function" && !nodeById(g.nodeId)) {
      toast(I18n.t("节点不在当前画布"), "warn");
      return;
    }
    focusNode(g.nodeId);
  } else if (typeof renderCanvas === "function") {
    renderCanvas();
  }
}

async function gsGotoSession(g) {
  const st = typeof agentSessionById === "function" ? agentSessionById(g.sessionId) : null;
  if (!st) {
    toast(I18n.t("会话已不存在"), "warn");
    return;
  }
  /* 盖着的浮窗先收掉：会话区在下面切好了，被设置 / 素材库挡着同样等于「没切过去」 */
  gsDismissCoveringLayers();
  if (g.msgIndex >= 0) {
    /* 会话视图默认只渲染最近 200 条目：把条目预算放宽到「命中消息及其后全部条目」，
       命中消息才在 DOM 里（口径真源在 app-assist.js 的 agentEntryBudgetFrom） */
    const budget =
      typeof agentEntryBudgetFrom === "function"
        ? agentEntryBudgetFrom(st, g.msgIndex)
        : (Array.isArray(st.messages) ? st.messages.length : 0) + 1;
    st._visItems = Math.max(Number(st._visItems) || 0, budget);
  }
  if (typeof setView === "function" && S.view !== "agent") setView("agent");
  S.agentActiveId = st.id;
  if (typeof persistAgentSession === "function") await persistAgentSession();
  if (typeof renderAgentSession === "function") renderAgentSession();
  if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
  if (g.msgIndex >= 0) {
    const key = typeof histMsgKey === "function" ? histMsgKey(st.id, g.msgIndex, st.messages[g.msgIndex]) : "";
    await gsFlashMsg(document.getElementById("agentList"), key);
  }
}

async function gsGotoTeam(g) {
  gsDismissCoveringLayers();
  if (typeof setView === "function" && S.view !== "team") setView("team");
  if (typeof teamViewSetSel === "function") {
    const sel = { chatId: g.chatId || "" };
    if (g.canvasId) sel.canvasId = g.canvasId;
    if (g.expertId) sel.expertId = g.expertId;
    teamViewSetSel(sel);
  }
  if (typeof teamViewEnsure === "function") teamViewEnsure();
  if (typeof renderTeamPane === "function") renderTeamPane();
  if (g.msgIndex >= 0 && g.chatId) {
    const c = typeof teamChat === "function" ? teamChat(g.chatId) : null;
    const msgs = (c && c.messages) || [];
    const key = typeof histMsgKey === "function" ? histMsgKey(g.chatId, g.msgIndex, msgs[g.msgIndex]) : "";
    await gsFlashMsg(document.getElementById("teamChatListMsgs"), key);
  }
}

/* 滚动到命中消息并闪一下：DOM 里按 data-hist-key 逐行比对（不拼选择器，免转义问题） */
async function gsFlashMsg(host, key) {
  if (!host || !key) return;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  let el = null;
  const rows = host.querySelectorAll(".dsh-msg");
  for (const row of rows) {
    if (row.dataset && row.dataset.histKey === key) {
      el = row;
      break;
    }
  }
  if (!el) return;
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_) {
    try {
      el.scrollIntoView();
    } catch (__) {}
  }
  el.classList.add("gs-flash");
  setTimeout(() => el.classList.remove("gs-flash"), 1800);
}

async function gsGotoAsset(g) {
  if (typeof ASSET_LIB === "object" && ASSET_LIB) {
    ASSET_LIB.selAssetId = g.assetId || "";
    ASSET_LIB.selCat = g.catRel || "";
  }
  if (typeof openAssetsLibrary === "function") await openAssetsLibrary();
  else toast(I18n.t("素材库不可用（本机存储接口未就绪）"), "err");
}

function gsGotoTool(g) {
  if (typeof openToolsLibrary !== "function") return;
  openToolsLibrary();
  const name = gsStr(g.name);
  const id = gsStr(g.toolId);
  setTimeout(() => {
    const host = document.getElementById("toolsLibList");
    if (!host) return;
    for (const row of host.children) {
      const hit = (id && row.dataset && row.dataset.toolId === id) || (name && gsStr(row.textContent).indexOf(name) >= 0);
      if (!hit) continue;
      row.classList.add("gs-flash");
      row.scrollIntoView({ block: "nearest" });
      setTimeout(() => row.classList.remove("gs-flash"), 1800);
      break;
    }
  }, 60);
}

async function gsGotoSkill(g) {
  const name = gsStr(g.name);
  if (!name) return;
  let body = "";
  try {
    if (window.api && typeof window.api.skillGet === "function") {
      const r = await window.api.skillGet(name);
      if (r && r.ok && r.body) body = gsStr(r.body);
    }
    if (!body && window.api && typeof window.api.mtnodeAgentSkillGet === "function") {
      const r = await window.api.mtnodeAgentSkillGet(name);
      if (r && r.ok) body = gsStr(r.body || r.markdown || r.text);
    }
  } catch (_) {}
  if (!body) {
    toast(I18n.t("找不到该技能正文"), "warn");
    return;
  }
  if (typeof openOverlay !== "function") return;
  openOverlay(I18n.t("技能") + " · " + name, { min: false });
  const bodyEl = document.getElementById("ovBody");
  if (!bodyEl) return;
  bodyEl.innerHTML = typeof renderMarkdown === "function" ? renderMarkdown(body) : "";
  if (!bodyEl.innerHTML) bodyEl.textContent = body;
  const foot = document.getElementById("ovFoot");
  if (foot && typeof closeOverlay === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini primary";
    btn.textContent = I18n.t("关闭");
    btn.onclick = () => closeOverlay();
    foot.appendChild(btn);
  }
}

function gsGotoTpl(g) {
  if (typeof TPL_ST === "object" && TPL_ST) {
    TPL_ST.kind = "templates";
    TPL_ST.q = gsStr(g.query);
    TPL_ST.page = 1;
  }
  if (typeof openTemplateStore === "function") openTemplateStore();
}

function gsGotoDoc(g) {
  if (typeof openAppDocs === "function") openAppDocs(g.pageId);
}

function gsGotoGuide(g) {
  if (typeof openNodeGuide === "function") openNodeGuide(g.node || { kind: g.guideId });
}

/* ── 标签重绘（切语言时由 app-boot.js 调用） ── */
if (typeof window !== "undefined") {
  window.openGlobalSearch = openGlobalSearch;
  window.closeGlobalSearch = closeGlobalSearch;
  window.globalSearchIsOpen = globalSearchIsOpen;
  window.globalSearchRepaint = gsPaintLabels;
}

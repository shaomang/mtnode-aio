"use strict";
/* ============ 顶栏「素材库」：跨画布、跨会话的本机内容仓库 ============
 * 素材库＝用户在资源管理器里也能直接整理的一棵目录树（根目录由用户指定，记在
 * config.json 的 assetRoot）。落盘与判定规则的唯一真源在主进程 assets-store.js：
 *   <root>/<分类路径>/<素材夹>/.mtnode-asset.json  ← 有标记文件＝素材，无＝分类
 *   素材夹内 items/ 存实体文件（入库一律复制，库自包含）
 * 「素材」是一种纯内容类节点（kind "asset"，见 app.js / app-canvas.js），内容条目
 * 即它的输入 / 输出端子；节点只存 assetId + 相对路径，正文永远在库里 —— 画布删了
 * 库还在，库里改了所有引用它的画布重开即生效。
 *
 * 本文件负责顶栏入口与「素材库」主对话框（左右栏）：
 *   左＝分类菜单（只显示名称、无图标；新建 / 重命名 / 删除文件夹，右键菜单）
 *   右＝所选分类下的素材卡片（显示名 / 描述 / 内容数 · 设置 / 插入到画布 / 删除，
 *       右键「移动到分类」）+ 工具条（新建素材 · 上传为新素材 · 刷新 · 更改根目录）
 * 首次使用（assetRoot 未配置）先走引导：确认 → 选文件夹 → assets:setRoot；
 * 取消则本次不开库。每次开框都先 scan（用户在资源管理器里的改动即刻可见）。
 *
 * 对话框是独立元素 #assetsDlg（仿 #extManagerDlg，不复用 #overlay）：素材设置、
 * 绑定选择都要在它上面叠二级框，复用 #overlay 会互相冲掉内容。层级：
 *   #assetsDlg 2350  <  本文件的二级表单框 2380  <  #mtDialog（确认 / 输入）2400。
 * 同一份左右栏渲染在 mode:"pick" 下即「绑定素材」选择器（openAssetPicker），
 * 供素材节点复用，不再抄第二份目录树。
 *
 * 加载顺序：app-tools.js 之后、app-boot.js 之前（顶栏接线在 app-boot.js · btnAssets）。
 * ─────────────────────────────────────────────────────────────────── */

/* 库的界面状态（单实例：同一时刻只开一个素材库框 · pick 模式复用同一份） */
const ASSET_LIB = {
  open: false,
  mode: "manage", // manage＝顶栏入口 · pick＝素材节点「绑定」选择器
  root: "",
  scan: { tree: [], categories: [], assets: [] },
  selCat: "", // 当前选中分类 rel（"" ＝ 根目录）
  onPick: null, // pick 模式回调：选中一个素材
  busy: false, // 一次只跑一个写盘动作，避免连点错位
};

const ASSET_TYPE_KEYS = { text: 1, image: 1, audio: 1, video: 1 };

function assetsApiOk() {
  return !!(
    window.api &&
    typeof window.api.assetsScan === "function" &&
    typeof window.api.assetsGetRoot === "function"
  );
}

/* 条目类型短名：与端子 / body 同一份口径（app.js · assetItemTypeLabel），不再各写一套 */
function assetTypeLabel(type) {
  return assetItemTypeLabel(type);
}

/* 素材的内容类型摘要：「文本 2 · 图像 1」（按类型固定顺序，零个不显示） */
function assetItemsSummary(a) {
  const items = (a && a.items) || [];
  if (!items.length) return I18n.t("（暂无内容）");
  const n = { text: 0, image: 0, audio: 0, video: 0 };
  for (const it of items) {
    const k = ASSET_TYPE_KEYS[it.type] ? it.type : "text";
    n[k]++;
  }
  const bits = [];
  for (const k of ["text", "image", "audio", "video"]) {
    if (n[k]) bits.push(assetTypeLabel(k) + " " + n[k]);
  }
  return bits.join(" · ");
}

/* 建元素小工具（本文件所有用户数据一律走 textContent，不拼 innerHTML） */
function assetEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

function assetBtn(label, cls, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini" + (cls ? " " + cls : "");
  b.textContent = label;
  if (title) b.title = title;
  return b;
}

/* ── 根目录：首次引导 + 事后更改 ─────────────────────────────────────
 * 未指定时不创建任何东西，只回 false（调用方据此放弃开框）；
 * 已指定时只读缓存路径，不弹任何东西。 */
async function assetEnsureRoot(opts) {
  opts = opts || {};
  const api = window.api;
  let g = null;
  try {
    g = await api.assetsGetRoot();
  } catch (_) {
    g = null;
  }
  if (!g || !g.ok) {
    toast(I18n.t("读取素材库位置失败：") + ((g && g.error) || ""), "err");
    return "";
  }
  ASSET_LIB.root = g.path || "";
  if (g.configured && !opts.force) return g.path || "";
  const sure = await confirmDialog(
    I18n.t(
      "素材库还没有指定保存位置。\n\n下一步请选择一个文件夹作为素材库根目录（项目目录）。根目录之后不建议改动：更换后内容会重新扫描，已绑定的素材节点需要手动重新绑定。",
    ),
    {
      title: I18n.t("指定素材库根目录"),
      okText: I18n.t("选择文件夹"),
      cancelText: I18n.t("暂不设置"),
    },
  );
  if (!sure) return "";
  const picked = await api.fileOpenDialog({
    title: I18n.t("选择素材库根目录（项目目录）"),
    directory: true,
  });
  const p = picked && picked.path;
  if (!p) {
    if (!opts.silent) toast(I18n.t("未选择文件夹，素材库暂不打开"), "warn");
    return "";
  }
  const r = await api.assetsSetRoot(p);
  if (!r || !r.ok) {
    toast(I18n.t("设置素材库根目录失败：") + ((r && r.error) || ""), "err");
    return "";
  }
  ASSET_LIB.root = r.path || p;
  toast(I18n.t("素材库根目录：") + ASSET_LIB.root, "ok");
  return ASSET_LIB.root;
}

/* 更改根目录：二次确认（会重新扫描 + 失联节点需重绑）→ 选文件夹 → setRoot */
async function assetChangeRoot() {
  if (ASSET_LIB.busy) return false;
  ASSET_LIB.busy = true;
  try {
    const sure = await confirmDialog(
      I18n.t(
        "更换素材库根目录会导致内容重新扫描：\n\n· 新目录里没有的素材，其节点会变成「素材失联」（节点保留，可手动重新绑定）\n· 旧目录里的文件不会被删除，改回原目录即可再次识别\n\n确定更换？",
      ),
      { title: I18n.t("更换素材库根目录"), okText: I18n.t("选择新目录") },
    );
    if (!sure) return false;
    const picked = await window.api.fileOpenDialog({
      title: I18n.t("选择新的素材库根目录"),
      directory: true,
    });
    const p = picked && picked.path;
    if (!p) return false;
    const r = await window.api.assetsSetRoot(p);
    if (!r || !r.ok) {
      toast(I18n.t("设置素材库根目录失败：") + ((r && r.error) || ""), "err");
      return false;
    }
    ASSET_LIB.root = r.path || p;
    ASSET_LIB.scan = (r && r.scan) || { tree: [], categories: [], assets: [] };
    ASSET_LIB.selCat = "";
    toast(I18n.t("已更换素材库根目录并重新扫描：") + ASSET_LIB.root, "ok");
    return true;
  } finally {
    ASSET_LIB.busy = false;
  }
}

/* 一次遍历拿分类树 + 素材摘要（开框即重扫：资源管理器里的手改也能认出来） */
async function assetRescan() {
  try {
    const r = await window.api.assetsScan();
    if (!r || !r.ok) {
      if (r && r.needRoot) {
        const p = await assetEnsureRoot();
        if (!p) return false;
        return assetRescan();
      }
      toast(I18n.t("扫描素材库失败：") + ((r && r.error) || ""), "err");
      return false;
    }
    ASSET_LIB.root = r.root || ASSET_LIB.root;
    ASSET_LIB.scan = r.scan || { tree: [], categories: [], assets: [] };
    return true;
  } catch (e) {
    toast(I18n.t("扫描素材库失败：") + ((e && e.message) || e), "err");
    return false;
  }
}

/* ── 二级表单框（新建素材 / 移动到分类） ─────────────────────────────
 * 独立元素，压在 #assetsDlg 之上、#mtDialog 之下；字段渲染与取值一份代码。
 * opts: { title, fields:[{key,label,placeholder,value,multiline,options}], okText }
 * resolve(values) / 取消 → null */
function assetFormDialog(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const old = document.getElementById("assetFormDlg");
    if (old) old.remove();
    const host = document.createElement("div");
    host.id = "assetFormDlg";
    host.className = "mt-dialog on asset-form-dlg";
    const box = assetEl("div", "mt-dialog-box asset-form-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const head = assetEl("div", "mt-dialog-head");
    const headB = assetEl("b", null, opts.title || I18n.t("素材库"));
    head.appendChild(headB);
    const body = assetEl("div", "mt-dialog-body asset-form-body");
    const foot = assetEl("div", "mt-dialog-foot asset-form-foot");
    const controls = {};
    for (const f of opts.fields || []) {
      const row = assetEl("div", "asset-form-field");
      const lab = assetEl("label", null, f.label || "");
      if (f.hint) lab.title = f.hint;
      let inp;
      if (Array.isArray(f.options)) {
        inp = document.createElement("select");
        for (const o of f.options) {
          const op = document.createElement("option");
          op.value = String(o.value == null ? "" : o.value);
          op.textContent = String(o.label == null ? o.value : o.label);
          inp.appendChild(op);
        }
        if (f.value != null) inp.value = String(f.value);
      } else if (f.multiline) {
        inp = document.createElement("textarea");
        inp.rows = f.rows || 3;
        inp.value = String(f.value == null ? "" : f.value);
      } else {
        inp = document.createElement("input");
        inp.type = "text";
        inp.value = String(f.value == null ? "" : f.value);
      }
      inp.className = "asset-form-input";
      if (f.placeholder) inp.placeholder = f.placeholder;
      controls[f.key] = inp;
      row.append(lab, inp);
      body.appendChild(row);
    }
    const finish = (val) => {
      if (host._done) return;
      host._done = true;
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      resolve(val);
    };
    const collect = () => {
      const out = {};
      for (const k of Object.keys(controls))
        out[k] = String(controls[k].value == null ? "" : controls[k].value).trim();
      return out;
    };
    const cancel = assetBtn(I18n.t("取消"), null, null);
    cancel.onclick = () => finish(null);
    const ok = assetBtn(opts.okText || I18n.t("确定"), "primary", null);
    ok.onclick = () => finish(collect());
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        finish(null);
      } else if (
        ev.key === "Enter" &&
        ev.target &&
        ev.target.tagName !== "TEXTAREA"
      ) {
        /* 多行描述里 Enter 是换行；其余字段 Enter ＝ 提交 */
        ev.preventDefault();
        ev.stopPropagation();
        finish(collect());
      }
    };
    foot.append(cancel, ok);
    box.append(head, body, foot);
    host.appendChild(box);
    host.addEventListener("click", (ev) => {
      if (ev.target === host) finish(null);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(host);
    setTimeout(() => {
      const first = body.querySelector("input, textarea, select");
      if (first) {
        try {
          first.focus();
          if (first.select) first.select();
        } catch (_) {}
      }
    }, 0);
  });
}

/* ── 库内小右键菜单（不用全局 #ctx：它的 z-index 低于本对话框） ─────── */
function assetMenu(x, y, items) {
  assetCloseMenu();
  const list = (items || []).filter(Boolean);
  if (!list.length) return;
  const m = assetEl("div", "asset-lib-menu");
  for (const it of list) {
    const b = assetEl("button", "mini" + (it.danger ? " danger" : ""), it.label);
    b.disabled = !!it.disabled;
    if (it.title) b.title = it.title;
    b.onclick = () => {
      assetCloseMenu();
      if (typeof it.run === "function") it.run();
    };
    m.appendChild(b);
  }
  m.style.left = Math.max(6, Math.min(x, window.innerWidth - 190)) + "px";
  m.style.top = Math.max(6, Math.min(y, window.innerHeight - 30 - list.length * 28)) + "px";
  document.body.appendChild(m);
  const off = (ev) => {
    if (m.contains(ev.target)) return;
    assetCloseMenu();
  };
  m._off = off;
  setTimeout(() => document.addEventListener("mousedown", off, true), 0);
  m.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    assetCloseMenu();
  });
}
function assetCloseMenu() {
  document.querySelectorAll(".asset-lib-menu").forEach((el) => {
    if (el._off) document.removeEventListener("mousedown", el._off, true);
    el.remove();
  });
}

/* ── 主对话框外壳（manage / pick 同一份 DOM） ──────────────────────── */
function ensureAssetsDlg() {
  let host = document.getElementById("assetsDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "assetsDlg";
  host.className = "mt-dialog asset-lib-dlg";
  host.tabIndex = -1;
  host.innerHTML =
    '<div class="mt-dialog-box asset-lib-box" role="dialog" aria-modal="true">' +
    '<div class="asset-lib-head">' +
    '<b id="assetLibTitle"></b>' +
    '<span class="asset-lib-rootpath" id="assetLibRootPath"></span>' +
    '<span class="asset-lib-spacer"></span>' +
    '<button type="button" class="mini" id="assetLibRootBtn"></button>' +
    '<button type="button" class="mini node-guide-x" id="assetLibClose">✕</button>' +
    "</div>" +
    '<div class="asset-lib-main">' +
    '<div class="asset-lib-side">' +
    '<div class="asset-lib-sidehead"><b id="assetLibCatsLab"></b>' +
    '<button type="button" class="mini" id="assetLibNewCatBtn"></button></div>' +
    '<div class="asset-lib-tree" id="assetLibTree"></div>' +
    "</div>" +
    '<div class="asset-lib-main-body">' +
    '<div class="asset-lib-toolbar" id="assetLibToolbar"></div>' +
    '<div class="asset-lib-cards" id="assetLibCards"></div>' +
    "</div>" +
    "</div>" +
    '<div class="asset-lib-foot" id="assetLibFoot"></div>' +
    "</div>";
  document.body.appendChild(host);
  host.querySelector("#assetLibClose").onclick = () => closeAssetLib();
  host.addEventListener("click", (ev) => {
    if (ev.target === host) closeAssetLib();
  });
  host.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    /* 二级框 / 确认框开着时 Esc 先归它们（#mtDialog 与二级框各自处理） */
    const up = document.getElementById("mtDialog");
    if (up && up.classList.contains("on")) return;
    if (document.getElementById("assetFormDlg")) return;
    if (document.querySelector(".asset-lib-menu")) {
      assetCloseMenu();
      return;
    }
    ev.preventDefault();
    closeAssetLib();
  });
  host.addEventListener("contextmenu", (ev) => {
    if (!ev.target || !ev.target.closest || !ev.target.closest(".asset-lib-tree")) return;
    ev.preventDefault();
  });
  return host;
}

function assetLibOpen() {
  const host = document.getElementById("assetsDlg");
  return !!(host && host.classList.contains("on"));
}

function closeAssetLib() {
  assetCloseMenu();
  const host = document.getElementById("assetsDlg");
  if (host) host.classList.remove("on");
  ASSET_LIB.open = false;
  ASSET_LIB.mode = "manage";
  ASSET_LIB.onPick = null;
}

/* 顶栏「素材库」入口：首次引导指定根目录 → 扫描 → 开框 */
async function openAssetsLibrary() {
  if (!assetsApiOk()) {
    toast(I18n.t("素材库不可用（本机存储接口未就绪）"), "err");
    return;
  }
  if (assetLibOpen()) closeAssetLib();
  const root = await assetEnsureRoot();
  if (!root) return;
  if (!(await assetRescan())) return;
  ASSET_LIB.mode = "manage";
  ASSET_LIB.onPick = null;
  if (!assetCatExists(ASSET_LIB.selCat)) ASSET_LIB.selCat = "";
  ASSET_LIB.open = true;
  ensureAssetsDlg().classList.add("on");
  paintAssetLib();
}

/* 素材节点「绑定」用的选择器：同一份左右栏，选完回调（T4 复用，不抄第二份目录树） */
async function openAssetPicker(opts) {
  opts = opts || {};
  if (!assetsApiOk()) {
    toast(I18n.t("素材库不可用（本机存储接口未就绪）"), "err");
    return;
  }
  const root = await assetEnsureRoot();
  if (!root) return;
  if (!(await assetRescan())) return;
  ASSET_LIB.mode = "pick";
  ASSET_LIB.onPick = typeof opts.onPick === "function" ? opts.onPick : null;
  if (!assetCatExists(ASSET_LIB.selCat)) ASSET_LIB.selCat = "";
  ASSET_LIB.open = true;
  ensureAssetsDlg().classList.add("on");
  paintAssetLib();
}

function assetCatExists(rel) {
  if (!rel) return true; // ""＝根目录，恒存在
  return (ASSET_LIB.scan.categories || []).some((c) => c.rel === rel);
}

/* 展示名：分类 rel 路径 → 「A / B」（左侧菜单与卡片副标题共用） */
function assetCatLabel(rel) {
  const r = String(rel || "");
  return r ? r.split("/").join(" / ") : I18n.t("根目录");
}

/* 某分类下的直接素材（按 scan 已排好的更新时间序） */
function assetsInCat(rel) {
  const r = String(rel || "");
  return (ASSET_LIB.scan.assets || []).filter(
    (a) => String(a.catRel || "") === r,
  );
}

/* ── 绘制 ─────────────────────────────────────────────────────────── */
function paintAssetLib() {
  const host = document.getElementById("assetsDlg");
  if (!host) return;
  const pick = ASSET_LIB.mode === "pick";
  host.querySelector("#assetLibTitle").textContent = pick
    ? I18n.t("绑定素材库内容")
    : I18n.t("素材库");
  const rp = host.querySelector("#assetLibRootPath");
  rp.textContent = ASSET_LIB.root || "";
  rp.title = I18n.t("素材库根目录（在资源管理器里也可直接整理）");
  const rootBtn = host.querySelector("#assetLibRootBtn");
  rootBtn.textContent = I18n.t("更改根目录…");
  rootBtn.title = I18n.t("更换后内容会重新扫描，失联的素材节点需手动重新绑定");
  /* 选择器模式下不给改根目录：那会让正在进行的绑定半途换库，容易误操作 */
  rootBtn.style.display = pick ? "none" : "";
  rootBtn.onclick = async () => {
    if (await assetChangeRoot()) paintAssetLib();
  };
  host.querySelector("#assetLibCatsLab").textContent = I18n.t("分类");
  const newCat = host.querySelector("#assetLibNewCatBtn");
  newCat.textContent = "＋ " + I18n.t("新建文件夹");
  newCat.title = I18n.t("在当前选中的分类下新建文件夹（右键分类可重命名 / 删除）");
  newCat.onclick = () => assetMakeCategory(ASSET_LIB.selCat);
  paintAssetTree(host.querySelector("#assetLibTree"));
  paintAssetToolbar(host.querySelector("#assetLibToolbar"));
  paintAssetCards(host.querySelector("#assetLibCards"));
  paintAssetFoot(host.querySelector("#assetLibFoot"));
}

function paintAssetTree(host) {
  host.innerHTML = "";
  const cats = (ASSET_LIB.scan.categories || []).slice();
  /* 深路径在前排序后按 rel 逐段比较 → 同级相邻、层级稳定（不依赖后端返回序） */
  cats.sort((a, b) => {
    const pa = String(a.rel || "").split("/");
    const pb = String(b.rel || "").split("/");
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] == null ? "" : String(pa[i]).toLowerCase();
      const y = pb[i] == null ? "" : String(pb[i]).toLowerCase();
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
  const rowOf = (rel, name, depth, count) => {
    const on = String(ASSET_LIB.selCat || "") === String(rel || "");
    const row = assetEl("div", "asset-lib-catrow" + (on ? " on" : ""));
    row.style.paddingLeft = 8 + depth * 14 + "px";
    row.appendChild(assetEl("span", "asset-lib-catname", name));
    row.appendChild(assetEl("span", "asset-lib-catchip", String(count)));
    row.title = assetCatLabel(rel);
    row.onclick = () => {
      ASSET_LIB.selCat = rel;
      paintAssetLib();
    };
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      assetCatMenu(ev.clientX, ev.clientY, rel, name);
    };
    return row;
  };
  const rootCount = (ASSET_LIB.scan.assets || []).filter(
    (a) => !String(a.catRel || ""),
  ).length;
  host.appendChild(rowOf("", I18n.t("全部素材（根目录）"), 0, rootCount));
  for (const c of cats) {
    const depth = String(c.rel || "").split("/").length - 1;
    host.appendChild(rowOf(c.rel, c.name, depth, Number(c.assetCount) || 0));
  }
  if (!cats.length) {
    const tip = assetEl(
      "div",
      "asset-lib-treepi",
      I18n.t("还没有分类：点上方「＋ 新建文件夹」，或直接在资源管理器里建目录。"),
    );
    host.appendChild(tip);
  }
}

function paintAssetToolbar(host) {
  if (!host) return;
  host.innerHTML = "";
  const pick = ASSET_LIB.mode === "pick";
  const lab = assetEl(
    "span",
    "asset-lib-catlab",
    I18n.t("当前位置：") + assetCatLabel(ASSET_LIB.selCat),
  );
  host.appendChild(lab);
  host.appendChild(assetEl("span", "asset-lib-spacer"));
  const refresh = assetBtn(I18n.t("刷新"), null, I18n.t("重新扫描素材库目录"));
  refresh.onclick = async () => {
    if (ASSET_LIB.busy) return;
    ASSET_LIB.busy = true;
    try {
      if (await assetRescan()) paintAssetLib();
    } finally {
      ASSET_LIB.busy = false;
    }
  };
  if (!pick) {
    const nb = assetBtn(I18n.t("新建素材"), "primary", I18n.t("在当前分类下新建一个素材"));
    nb.onclick = () => assetCreateAsset();
    const ub = assetBtn(
      I18n.t("上传为新素材"),
      null,
      I18n.t("选择一个本机文件夹 → 按文件类型自动变成当前分类下的新素材（内容复制入库）"),
    );
    ub.onclick = () => assetUploadAsAsset();
    host.append(nb, ub);
  }
  host.appendChild(refresh);
}

function paintAssetCards(host) {
  host.innerHTML = "";
  const pick = ASSET_LIB.mode === "pick";
  const list = assetsInCat(ASSET_LIB.selCat);
  /* 只看直接子分类（根目录选中时＝顶层分类），决定空态该说什么 */
  const parent = String(ASSET_LIB.selCat || "");
  const nested = (ASSET_LIB.scan.categories || []).filter((c) => {
    const r = String(c.rel || "");
    return parent ? r.slice(0, parent.length + 1) === parent + "/" : r.indexOf("/") < 0;
  });
  if (!list.length && nested.length) {
    host.appendChild(
      assetEl(
        "div",
        "asset-lib-empty",
        I18n.t("该分类本身没有素材，内容在子分类里（左侧选择子分类查看）。"),
      ),
    );
    return;
  }
  if (!list.length) {
    host.appendChild(
      assetEl(
        "div",
        "asset-lib-empty",
        pick
          ? I18n.t(
              "该分类下还没有素材：可先在素材库里「新建素材」或「上传为新素材」，再回来绑定。",
            )
          : I18n.t(
              "这里还是空的。点上方「新建素材」建一个空素材，或「上传为新素材」把本机一个文件夹整体收进库里。",
            ),
      ),
    );
    return;
  }
  for (const a of list) host.appendChild(assetCard(a, pick));
}

function assetCard(a, pick) {
  const card = assetEl("div", "asset-lib-card");
  const head = assetEl("div", "asset-lib-cardhead");
  head.appendChild(assetEl("b", "asset-lib-cardname", a.displayName || a.folder));
  head.appendChild(
    assetEl("span", "asset-lib-cardcount", String(Number(a.itemCount) || 0)),
  );
  card.appendChild(head);
  card.appendChild(
    assetEl(
      "div",
      "asset-lib-cardsub",
      assetItemsSummary(a) + (a.desc ? "　" + a.desc : ""),
    ),
  );
  card.querySelector(".asset-lib-cardsub").title =
    I18n.t("文件夹：") + (a.rel || "") + "\n" + (a.desc || "");
  const acts = assetEl("div", "asset-lib-cardacts");
  if (pick) {
    const b = assetBtn(I18n.t("绑定这个素材"), "primary", I18n.t("用该素材绑定当前节点"));
    b.onclick = () => {
      const cb = ASSET_LIB.onPick;
      closeAssetLib();
      if (cb) {
        try {
          cb(a);
        } catch (_) {}
      }
    };
    card.appendChild(acts.appendChild(b));
    card.ondblclick = () => b.click();
    return card;
  }
  const st = assetBtn(
    I18n.t("设置"),
    null,
    I18n.t("改显示名称 / 描述，管理内容条目（每条＝节点的一对端子）"),
  );
  st.onclick = () => {
    if (typeof openAssetSettings === "function") openAssetSettings(a);
    else toast(I18n.t("素材设置界面尚未就绪"), "warn");
  };
  const ins = assetBtn(
    I18n.t("插入到画布"),
    "primary",
    I18n.t("在当前画布创建一个绑定该素材的「素材」节点（库内容不变）"),
  );
  ins.onclick = () => assetInsertToCanvas(a);
  const del = assetBtn(I18n.t("删除"), "danger", I18n.t("删除素材（移进素材库回收站，不实删）"));
  del.onclick = () => assetDeleteAsset(a);
  acts.append(st, ins, del);
  card.appendChild(acts);
  card.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    assetMenu(ev.clientX, ev.clientY, [
      { label: I18n.t("设置…"), run: () => st.click() },
      { label: I18n.t("插入到画布"), run: () => assetInsertToCanvas(a) },
      { label: I18n.t("移动到分类…"), run: () => assetMoveAsset(a) },
      { label: I18n.t("重新命名（文件夹）"), run: () => assetRenameAssetFolder(a) },
      { label: I18n.t("删除素材"), danger: true, run: () => assetDeleteAsset(a) },
    ]);
  };
  return card;
}

function paintAssetFoot(host) {
  host.innerHTML = "";
  const cats = (ASSET_LIB.scan.categories || []).length;
  const assets = (ASSET_LIB.scan.assets || []).length;
  host.appendChild(
    assetEl(
      "span",
      "asset-lib-fact",
      I18n.t("分类 ") +
        cats +
        " · " +
        I18n.t("素材 ") +
        assets +
        " · " +
        I18n.t("删除的内容进根目录 .trash（不实删）"),
    ),
  );
  host.appendChild(assetEl("span", "asset-lib-spacer"));
  const cancel = assetBtn(I18n.t("关闭"), null, null);
  cancel.onclick = () => closeAssetLib();
  host.appendChild(cancel);
}

/* ── 左侧分类动作 ─────────────────────────────────────────────────── */
function assetCatMenu(x, y, rel, name) {
  const atRoot = !rel;
  assetMenu(x, y, [
    {
      label: I18n.t("在此新建子文件夹"),
      run: () => assetMakeCategory(rel),
    },
    atRoot
      ? null
      : { label: I18n.t("重命名「{name}」…", { name: name }), run: () => assetRenameCategory(rel, name) },
    atRoot
      ? null
      : {
          label: I18n.t("删除「{name}」", { name: name }),
          danger: true,
          run: () => assetRemoveCategory(rel, name),
        },
    {
      label: I18n.t("在资源管理器中打开"),
      run: () => assetOpenPath(rel),
    },
  ]);
}

async function assetMakeCategory(parentRel) {
  if (ASSET_LIB.busy) return;
  const name = await promptDialog(
    I18n.t("新建文件夹（分类）名称："),
    "",
    {
      title: I18n.t("新建分类 · {where}", {
        where: assetCatLabel(parentRel),
      }),
      okText: I18n.t("创建"),
    },
  );
  const v = String(name == null ? "" : name).trim();
  if (!v) return;
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsMkdir(parentRel || "", v);
    if (!r || !r.ok) {
      toast(I18n.t("新建文件夹失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    ASSET_LIB.selCat = r.rel || parentRel || "";
    paintAssetLib();
    toast(I18n.t("已新建分类：") + (r.name || v), "ok");
  } finally {
    ASSET_LIB.busy = false;
  }
}

async function assetRenameCategory(rel, name) {
  if (ASSET_LIB.busy) return;
  const v = await promptDialog(I18n.t("新的文件夹名称："), name, {
    title: I18n.t("重命名分类"),
    okText: I18n.t("确定"),
  });
  const nv = String(v == null ? "" : v).trim();
  if (!nv || nv === name) return;
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsRename(rel, nv);
    if (!r || !r.ok) {
      toast(I18n.t("重命名失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    if (String(ASSET_LIB.selCat || "").startsWith(String(rel || "") + "/"))
      ASSET_LIB.selCat = "";
    else if (ASSET_LIB.selCat === rel) ASSET_LIB.selCat = r.rel || "";
    paintAssetLib();
    toast(I18n.t("已重命名为：") + (r.name || nv), "ok");
  } finally {
    ASSET_LIB.busy = false;
  }
}

async function assetRemoveCategory(rel, name) {
  const cat = (ASSET_LIB.scan.categories || []).find((c) => c.rel === rel) || {};
  if ((Number(cat.assetCount) || 0) > 0) {
    toast(
      I18n.t("该分类（含子分类）下还有 {n} 个素材：请先移走或删除其中的素材。", {
        n: cat.assetCount,
      }),
      "warn",
    );
    return;
  }
  const sure = await confirmDialog(
    I18n.t("删除空分类「{name}」？\n\n文件夹会移进素材库根目录的 .trash（不会真的删掉），在资源管理器里可手工找回。", {
      name: name,
    }),
    { title: I18n.t("删除分类"), danger: true, okText: I18n.t("删除") },
  );
  if (!sure) return;
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsRemove(rel);
    if (!r || !r.ok) {
      toast(I18n.t("删除失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    if (ASSET_LIB.selCat === rel) ASSET_LIB.selCat = "";
    paintAssetLib();
    toast(I18n.t("已删除分类（进回收站）：") + name, "ok");
  } finally {
    ASSET_LIB.busy = false;
  }
}

async function assetOpenPath(rel) {
  const api = window.api;
  if (!ASSET_LIB.root || typeof api.shellOpenPath !== "function") {
    toast(I18n.t("打不开该目录"), "warn");
    return;
  }
  const p = rel ? ASSET_LIB.root + "/" + rel : ASSET_LIB.root;
  const r = await api.shellOpenPath(p);
  if (r && !r.ok) toast(I18n.t("打开失败：") + ((r && r.error) || ""), "err");
}

/* ── 右侧素材动作 ─────────────────────────────────────────────────── */
async function assetCreateAsset() {
  if (ASSET_LIB.busy) return;
  const v = await assetFormDialog({
    title: I18n.t("新建素材 · {where}", { where: assetCatLabel(ASSET_LIB.selCat) }),
    okText: I18n.t("创建"),
    fields: [
      { key: "name", label: I18n.t("显示名称"), placeholder: I18n.t("例如：主角人设 / 片头音乐") },
      { key: "desc", label: I18n.t("描述"), multiline: true, rows: 3 },
    ],
  });
  if (!v) return;
  if (!v.name) {
    toast(I18n.t("请填写显示名称"), "warn");
    return;
  }
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsCreate({
      catRel: ASSET_LIB.selCat || "",
      displayName: v.name,
      desc: v.desc || "",
    });
    if (!r || !r.ok) {
      toast(I18n.t("新建素材失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    paintAssetLib();
    toast(I18n.t("已新建素材：") + v.name, "ok");
    if (typeof openAssetSettings === "function" && r.asset) openAssetSettings(r.asset);
  } finally {
    ASSET_LIB.busy = false;
  }
}

/* 「上传为新素材」：选一个本机文件夹 → 当前分类下的新素材（文件复制入库） */
async function assetUploadAsAsset() {
  if (ASSET_LIB.busy) return;
  const picked = await window.api.fileOpenDialog({
    title: I18n.t("选择要上传为素材的文件夹"),
    directory: true,
  });
  const src = picked && picked.path;
  if (!src) return;
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsImportDir({
      srcPath: src,
      catRel: ASSET_LIB.selCat || "",
    });
    if (!r || !r.ok) {
      toast(I18n.t("上传失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    paintAssetLib();
    const nm = (r.asset && r.asset.displayName) || "";
    const n = (r.asset && r.asset.itemCount) || 0;
    const skip = Number(r.skipped) || 0;
    toast(
      skip > 0
        ? I18n.t("已上传为素材：{name}（内容 {n} 条 · 跳过 {s} 个不支持的文件）", {
            name: nm,
            n: n,
            s: skip,
          })
        : I18n.t("已上传为素材：{name}（内容 {n} 条）", { name: nm, n: n }),
      "ok",
    );
  } finally {
    ASSET_LIB.busy = false;
  }
}

async function assetDeleteAsset(a) {
  const sure = await confirmDialog(
    I18n.t(
      "删除素材「{name}」？\n\n整个素材文件夹会移进素材库根目录的 .trash（不实删）。已插入画布的「素材」节点会显示为「素材失联」，节点本身保留。",
      { name: a.displayName || a.folder },
    ),
    { title: I18n.t("删除素材"), danger: true, okText: I18n.t("删除") },
  );
  if (!sure) return;
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsDelete(a.id);
    if (!r || !r.ok) {
      toast(I18n.t("删除失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    paintAssetLib();
    toast(I18n.t("已删除素材（进回收站）：") + (a.displayName || a.folder), "ok");
  } finally {
    ASSET_LIB.busy = false;
  }
}

/* 文件夹名与显示名称是两件事：这里只改磁盘上的文件夹名（.mtnode-asset.json 的 id 不动） */
async function assetRenameAssetFolder(a) {
  const cur = a.folder || "";
  const v = await promptDialog(
    I18n.t("素材文件夹名（资源管理器里看到的名字）："),
    cur,
    { title: I18n.t("重命名素材文件夹"), okText: I18n.t("确定") },
  );
  const nv = String(v == null ? "" : v).trim();
  if (!nv || nv === cur) return;
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsRename(a.rel, nv);
    if (!r || !r.ok) {
      toast(I18n.t("重命名失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    paintAssetLib();
    toast(I18n.t("已重命名文件夹：") + (r.name || nv), "ok");
  } finally {
    ASSET_LIB.busy = false;
  }
}

/* 「移动到分类」＝同一次 rename（带 toCatRel）；端子序号不变，连线不受影响 */
async function assetMoveAsset(a) {
  const cats = (ASSET_LIB.scan.categories || []).slice();
  const opts = [{ value: "", label: I18n.t("根目录") }].concat(
    cats
      .filter((c) => c.rel !== a.catRel)
      .sort((x, y) => String(x.rel).length - String(y.rel).length)
      .map((c) => ({ value: c.rel, label: assetCatLabel(c.rel) })),
  );
  const v = await assetFormDialog({
    title: I18n.t("移动素材到分类"),
    okText: I18n.t("移动"),
    fields: [
      { key: "cat", label: I18n.t("目标分类"), options: opts, value: "" },
    ],
  });
  if (!v) return;
  const to = String(v.cat || "");
  if (to === String(a.catRel || "")) return;
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsRename(a.rel, a.folder || a.displayName, to);
    if (!r || !r.ok) {
      toast(I18n.t("移动失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    ASSET_LIB.selCat = to;
    paintAssetLib();
    toast(
      I18n.t("已移动到：") + assetCatLabel(to),
      "ok",
    );
  } finally {
    ASSET_LIB.busy = false;
  }
}

/* ── 插入到画布：创建绑定该素材的「素材」节点（kind "asset" · T3 注册） ── */
/* 连点多次插入时错开位置，避免节点完全重叠（模 4 阶梯，看完就绕回去） */
let _assetInsertStep = 0;

function assetSpawnPoint() {
  const c = document.getElementById("canvas");
  const r =
    (c && c.getBoundingClientRect()) ||
    { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const pt = toStage(r.left + r.width / 2, r.top + r.height / 2);
  const step = (_assetInsertStep = (_assetInsertStep + 1) % 4);
  return { x: snap(pt.x + (step - 1) * 40), y: snap(pt.y + step * 30) };
}

function assetInsertToCanvas(a) {
  if (!S.wf || !Array.isArray(S.wf.nodes)) {
    toast(I18n.t("请先打开一个画布"), "warn");
    return null;
  }
  if (typeof addNode !== "function" || typeof NODE_DEFAULTS === "undefined" || !NODE_DEFAULTS.asset) {
    toast(I18n.t("素材节点尚未就绪"), "warn");
    return null;
  }
  const p = assetSpawnPoint();
  const node = addNode("asset", p.x, p.y, {
    title: a.displayName || a.folder || I18n.t("素材"),
    assetId: String(a.id || ""),
    assetRel: String(a.rel || ""),
    assetName: String(a.displayName || a.folder || ""),
    assetDesc: String(a.desc || ""),
    items: (a.items || []).map((it) => ({
      id: String(it.id || ""),
      title: String(it.title || ""),
      type: ASSET_TYPE_KEYS[it.type] ? it.type : "text",
    })),
  });
  if (!node) {
    toast(I18n.t("插入失败：无法创建素材节点"), "err");
    return null;
  }
  toast(I18n.t("已插入素材：") + (a.displayName || a.folder || ""), "ok");
  return node;
}

/* ════════════ 素材内容条目的「视图缓存」（素材节点 body 的取数口）════════════
   内容本体只存在素材库里，节点上只存条目身份（id / 标题 / 类型）。body 每帧同步渲染，
   向库读文件是异步的 —— 所以这里按 assetId|itemId 缓存一份读到的形状，
   缺的条目发一次 assets:itemRead，读齐后合并成一次重画（不逐条抖动画布）。
   写盘同样只在这里做：文本编辑（失焦提交）与浏览/更换文件都直接落到库，
   库端覆盖前会把旧文件收进 .versions/，撤销回滚由「执行取数」那一步接上。 */
const ASSET_ITEM_VIEW = new Map();
const ASSET_ITEM_BUSY = new Set();
let _assetViewRerender = 0;

function assetViewKey(aid, iid) {
  return String(aid || "") + "|" + String(iid || "");
}
/** 读一次缓存；没有则返回 null（body 据此显示「读取中…」并触发补齐） */
function assetItemViewGet(aid, iid) {
  return ASSET_ITEM_VIEW.get(assetViewKey(aid, iid)) || null;
}
function assetItemViewSet(aid, iid, patch) {
  const k = assetViewKey(aid, iid);
  const cur = ASSET_ITEM_VIEW.get(k) || {};
  const next = Object.assign({}, cur, patch || {});
  if (patch && Object.prototype.hasOwnProperty.call(patch, "text")) {
    next.dirty = String(next.text || "") !== String(next.savedText || "");
  }
  ASSET_ITEM_VIEW.set(k, next);
  return next;
}
/** 让某个条目下次渲染时重新向库读（库内容变了 / 刚覆盖过文件都要调） */
function assetItemViewInvalidate(aid, iid) {
  ASSET_ITEM_VIEW.delete(assetViewKey(aid, iid));
  ASSET_ITEM_BUSY.delete(assetViewKey(aid, iid));
}
function assetItemsViewInvalidateAll(aid) {
  const pre = String(aid || "") + "|";
  for (const k of Array.from(ASSET_ITEM_VIEW.keys()))
    if (k.indexOf(pre) === 0) ASSET_ITEM_VIEW.delete(k);
  for (const k of Array.from(ASSET_ITEM_BUSY))
    if (k.indexOf(pre) === 0) ASSET_ITEM_BUSY.delete(k);
}
/** 多条读取同时到货时，合并成一次重画 */
function assetViewRerenderSoon() {
  if (_assetViewRerender) return;
  _assetViewRerender = setTimeout(() => {
    _assetViewRerender = 0;
    if (typeof renderCanvas === "function") renderCanvas();
  }, 60);
}
/** 单条目的异步读取（同一 key 只飞一次） */
function assetItemViewLoad(aid, iid) {
  const k = assetViewKey(aid, iid);
  if (!aid || !iid) return;
  if (ASSET_ITEM_VIEW.has(k) || ASSET_ITEM_BUSY.has(k)) return;
  ASSET_ITEM_BUSY.add(k);
  assetItemViewSet(aid, iid, { loading: true });
  window.api
    .assetsItemRead(aid, iid)
    .then((r) => {
      if (!r || !r.ok) {
        assetItemViewSet(aid, iid, {
          loading: false,
          missing: true,
          error: (r && r.error) || I18n.t("读取失败"),
        });
        return;
      }
      /* 库里读到的内容不能盖掉用户正在输入而未提交的改动：
         本地 dirty 时保留本地正文，只更新 absPath / bytes 等元信息 */
      const prev = ASSET_ITEM_VIEW.get(k);
      const keepLocal = !!(prev && prev.dirty);
      const libText = r.type === "text" ? String(r.text || "") : "";
      assetItemViewSet(aid, iid, {
        loading: false,
        missing: false,
        text: keepLocal ? String(prev.text || "") : libText,
        savedText: libText,
        absPath: r.absPath || "",
        bytes: Number(r.bytes) || 0,
      });
    })
    .catch((e) => {
      assetItemViewSet(aid, iid, {
        loading: false,
        missing: true,
        error: String((e && e.message) || e),
      });
    })
    .finally(() => {
      ASSET_ITEM_BUSY.delete(k);
      assetViewRerenderSoon();
    });
}
/** body 渲染完调用：把该节点还没读到内容的条目补齐 */
function assetItemsEnsure(node) {
  if (!node || !String(node.assetId || "").trim()) return;
  for (const it of assetItems(node)) {
    if (!it.id) continue;
    if (assetItemViewGet(node.assetId, it.id)) continue;
    assetItemViewLoad(node.assetId, it.id);
  }
}
/** 库摘要（assets:scan / itemAdd 返回的 asset）→ 刷新所有绑定该素材的节点端子快照。
    端子序号按标题尽量保号：改名不甩线，增删条目才改端子数。 */
function assetApplySummaryToNodes(summary) {
  if (!summary || !summary.id || !S.wf || !Array.isArray(S.wf.nodes)) return 0;
  const items = (summary.items || []).map((it) => ({
    id: String(it.id || ""),
    title: String(it.title || ""),
    type: ASSET_TYPE_KEYS[it.type] ? it.type : "text",
  }));
  let n = 0;
  for (const node of S.wf.nodes) {
    if (!isAssetNode(node) || node.assetId !== summary.id) continue;
    node.items = items.map((it) => Object.assign({}, it));
    node.assetName = String(summary.displayName || summary.folder || node.assetName || "");
    node.assetRel = String(summary.rel || node.assetRel || "");
    n++;
  }
  if (n) {
    if (typeof clearDownstream === "function")
      for (const node of S.wf.nodes)
        if (isAssetNode(node) && node.assetId === summary.id)
          clearDownstream(node.id);
    if (typeof scheduleSave === "function") scheduleSave();
  }
  return n;
}
/** 文本条目：失焦提交写盘（内容没变就不碰库） */
function assetItemCommitText(node, it) {
  if (!node || !it || !String(it.id || "").trim()) return;
  if (!String(node.assetId || "").trim()) return;
  const view = assetItemViewGet(node.assetId, it.id);
  if (!view || !view.dirty) return;
  const text = String(view.text || "");
  window.api
    .assetsItemUpdateText(node.assetId, it.id, text)
    .then((r) => {
      if (!r || !r.ok) {
        toast(
          I18n.t("写入素材库失败：") + ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
        return;
      }
      assetItemViewSet(node.assetId, it.id, {
        savedText: text,
        dirty: false,
        bytes: (r.item && Number(r.item.bytes)) || view.bytes || 0,
        missing: false,
      });
      assetApplySummaryToNodes(r.asset);
      toast(I18n.t("已保存到素材库：") + (it.title || ""), "ok");
      if (typeof renderStatus === "function") renderStatus();
    })
    .catch((e) => {
      toast(I18n.t("写入素材库失败：") + String((e && e.message) || e), "err");
    });
}
const ASSET_PICK_FILTERS = {
  image: { name: "图像", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
  audio: { name: "音频", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] },
  video: { name: "视频", extensions: ["mp4", "webm", "mov", "mkv", "avi"] },
};
/** 图像 / 音频 / 视频条目：浏览（选择本机文件）→ 复制入库并顶掉旧内容 */
function assetItemPickFile(node, it, type) {
  if (!node || !it || !String(it.id || "").trim()) return;
  if (!String(node.assetId || "").trim()) return;
  const f = ASSET_PICK_FILTERS[type] || ASSET_PICK_FILTERS.image;
  window.api
    .fileOpenDialog({
      title: I18n.t("选择") + assetItemTypeLabel(type) + I18n.t("文件"),
      filters: [f],
      multi: false,
    })
    .then((r) => {
      const p = r && r.paths && r.paths.length ? r.paths[0] : (r && r.path) || "";
      if (!p) return null;
      return window.api.assetsItemUpdateBytes(node.assetId, it.id, { srcPath: p });
    })
    .then((r) => {
      if (r == null) return;
      if (!r.ok) {
        toast(
          I18n.t("写入素材库失败：") + ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
        return;
      }
      /* 换了文件扩展名也可能变（items/<id>.png → <id>.jpg）：丢掉缓存重读一次 */
      assetItemViewInvalidate(node.assetId, it.id);
      assetApplySummaryToNodes(r.asset);
      assetViewRerenderSoon();
      toast(I18n.t("已更换内容：") + (it.title || ""), "ok");
    })
    .catch((e) => {
      toast(I18n.t("写入素材库失败：") + String((e && e.message) || e), "err");
    });
}

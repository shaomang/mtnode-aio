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
 *   左＝分类 + 素材一体树（分类行可展开 ▸/▾，展开后列出该类下的素材；点素材＝右栏看它）
 *   右＝所选素材的内容详情（顶部四项动作：设置 / 复制到画布 / 删除 / 打开文件夹，正文＝
 *       可编辑标题、可换文件、可编辑正文、可增删与拖动排序的内容条目）；
 *       没选素材时＝该分类下的素材卡片（设置 / 插入到画布 / 删除 + 右键「移动到分类」）
 *       ＋ 工具条（新建素材 · 上传为新素材 · 刷新 · 更改根目录）
 * 以及「素材设置」框（openAssetSettings）：改显示名 / 描述，内容条目的增删改与重排 ——
 * 条目就是素材节点的一对端子，标题即端子名、顺序即端子序，全部先落库再回贴到画布节点，
 * 所以改名与拖序都不会把已连的数据线甩到别的条目上（口径见 app.js · assetItemPerm）。
 * 首次使用（assetRoot 未配置）先走引导：确认 → 选文件夹 → assets:setRoot；
 * 取消则本次不开库。每次开框都先 scan（用户在资源管理器里的改动即刻可见）。
 *
 * 对话框是独立元素 #assetsDlg（仿 #extManagerDlg，不复用 #overlay）：素材设置、
 * 绑定选择都要在它上面叠二级框，复用 #overlay 会互相冲掉内容。层级：
 *   #assetsDlg 2350  <  #assetSetDlg 2370  <  二级表单框 2380  <  #mtDialog 2400。
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
  selAssetId: "", // 当前选中的素材 id（"" ＝ 未选素材，右栏回落分类卡片）
  expanded: {}, // 左树已展开的分类 rel（对象当集合用；不引 Set，免得混进快照）
  dragFrom: -1, // 右栏详情条目行的拖动源行号（与设置框的 ASSET_SET.dragFrom 各管一摊）
  onPick: null, // pick 模式回调：选中一个素材
  busy: false, // 一次只跑一个写盘动作，避免连点错位
  scanned: false, // 本次会话是否成功扫过（失联判定的前提，没扫过不下结论）
  noRoot: false, // 扫过但根目录还没指定
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
  const n = assetTypeCounts(a);
  const bits = [];
  for (const k of ASSET_TYPE_ORDER) {
    if (n[k]) bits.push(assetTypeLabel(k) + " " + n[k]);
  }
  return bits.length ? bits.join(" · ") : I18n.t("（暂无内容）");
}

/* ── 素材包「是什么」：文本 / 图像 / 音频 / 视频 / 混合 / 空 ──────────────
   用户挑素材时最想先知道「这一包里装的是文本还是图，还是混在一起」。
   判定只有这一份（左树素材行、素材卡片、详情头共用），不在各处各算一套。 */
const ASSET_TYPE_ORDER = ["text", "image", "audio", "video"];

/* 条目类型计数：非法 type 归 text（与主进程 normItems / 节点快照同一口径） */
function assetTypeCounts(a) {
  const n = { text: 0, image: 0, audio: 0, video: 0 };
  for (const it of (a && a.items) || []) {
    const k = ASSET_TYPE_KEYS[it.type] ? it.type : "text";
    n[k]++;
  }
  return n;
}

/* 归一成一个「包类型」：empty（没内容）/ 单一类型 / mixed（两种以上混装） */
function assetKindOf(a) {
  const n = assetTypeCounts(a);
  const kinds = ASSET_TYPE_ORDER.filter((k) => n[k] > 0);
  if (!kinds.length) return "empty";
  if (kinds.length > 1) return "mixed";
  return kinds[0];
}

/* 徽标文案：单一类型复用条目类型短名（与端子 / body 同一份），混合 / 空走专门词条 */
function assetKindLabel(kind) {
  if (kind === "mixed") return I18n.t("混合");
  if (kind === "empty") return I18n.t("空");
  return assetTypeLabel(kind);
}

/* 类型徽标（.asset-lib-kindchip）：一眼看出这份素材是文本、图像…还是混合；
   tooltip 给出逐类型数量，鼠标一停就知道包里到底有什么。 */
function assetKindChip(a) {
  const kind = assetKindOf(a);
  const chip = assetEl("span", "asset-lib-kindchip " + kind, assetKindLabel(kind));
  chip.title = I18n.t("内容类型：") + assetItemsSummary(a);
  return chip;
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
    /* setRoot 顺手带回新目录的扫描结果：走同一份落库口径（含 scanned 标记），
       再对一遍画布上的素材节点 —— 换了根目录，失联 / 接上的此刻就重判 */
    assetApplyScan({ root: r.path || p, scan: r.scan, configured: true });
    ASSET_LIB.selCat = "";
    assetLinkSyncNodes();
    toast(I18n.t("已更换素材库根目录并重新扫描：") + ASSET_LIB.root, "ok");
    return true;
  } finally {
    ASSET_LIB.busy = false;
  }
}

/* 一次遍历拿分类树 + 素材摘要（开框即重扫：资源管理器里的手改也能认出来）。
   开着的素材设置框跟着重画 —— 素材在别处被删 / 根目录换了，它会自己收掉并说明。 */
async function assetRescan() {
  const r = await assetScanCall();
  if (r == null) return false;
  if (!r.ok) {
    if (r.needRoot) {
      const p = await assetEnsureRoot();
      if (!p) return false;
      return assetRescan();
    }
    toast(I18n.t("扫描素材库失败：") + ((r && r.error) || ""), "err");
    return false;
  }
  assetApplyScan(r);
  assetLinkSyncNodes();
  if (assetSettingsOpen()) paintAssetSettings();
  return true;
}

function assetScanCall() {
  return window.api
    .assetsScan()
    .then((r) => r)
    .catch((e) => {
      return { ok: false, error: String((e && e.message) || e) };
    });
}
/** 扫描结果落进界面状态（唯一入口：开框、刷新、静默校验都走这里） */
function assetApplyScan(r) {
  ASSET_LIB.root = String((r && r.root) || ASSET_LIB.root || "");
  ASSET_LIB.scan =
    (r && r.scan) || { tree: [], categories: [], assets: [] };
  ASSET_LIB.scanned = true;
  ASSET_LIB.noRoot = !(r && r.configured);
}

/* ════════════ 节点绑定 ↔ 素材库：失联判定与自动跟随 ════════════
   素材节点上只有 assetId + 相对路径；「库里还有没有这个素材」必须扫过一次才知道。
   · 静默校验：画布里出现已绑定的素材节点、而本会话还没扫过 → 后台扫一次，
     不弹框、不阻塞绘制，扫完按需重画（判定不出一律当作「没失联」，宁可不显示占位
     也不要在读不到目录时误伤正常素材）。
   · 找到素材：清失联标记；条目集与库不一致（在库里加/删/改/重排过内容）就把快照
     同步过来，端子号按标题保号（assetItemPerm）—— 库是事实源，节点跟着走。
   · 找不到：只打标记，items 快照与连线原样保留，body 给「素材失联」占位 +「重新绑定」，
     任何情况下都不删用户的节点。
   node.assetLost 只是「上次同步的判定结果」，用来做这一步的变化检测（要不要重画）；
   界面显示一律走实时派生的 assetNodeIsLost —— 载入时 migrateWf 抹掉这个字段，
   绝不让上一轮的判定跨会话变成事实。 */
let _assetLinkVerify = null;
/** 素材库里按 id 取摘要（没扫过 / 找不到 → null） */
function assetSummaryById(id) {
  const list = ASSET_LIB.scan && ASSET_LIB.scan.assets;
  if (!id || !Array.isArray(list)) return null;
  const k = String(id);
  for (const a of list) if (a && String(a.id) === k) return a;
  return null;
}
/** 只读判定：绑定过 + 扫过一次 + 库里没有 ＝ 失联 */
function assetNodeIsLost(node) {
  if (!isAssetNode(node)) return false;
  const id = String(node.assetId || "").trim();
  if (!id || !ASSET_LIB.scanned) return false;
  return !assetSummaryById(id);
}
/** 把当前画布的素材节点与扫描结果对一遍（改了什么就重画什么） */
function assetLinkSyncNodes() {
  if (!S.wf || !Array.isArray(S.wf.nodes)) return 0;
  let changed = 0;
  for (const n of S.wf.nodes) {
    if (!isAssetNode(n)) continue;
    const id = String(n.assetId || "").trim();
    if (!id) continue;
    const sum = assetSummaryById(id);
    if (!sum) {
      if (!n.assetLost) {
        n.assetLost = true;
        changed++;
      }
      continue;
    }
    if (n.assetLost) {
      delete n.assetLost;
      changed++;
    }
    if (assetApplySummaryToNodes(sum)) changed++;
  }
  if (changed) assetViewRerenderSoon();
  return changed;
}
/** 后台静默校验（同一时刻只飞一次） */
function assetLinkVerify(force) {
  if (!assetsApiOk()) return Promise.resolve(false);
  if (ASSET_LIB.scanned && !force) return Promise.resolve(true);
  if (_assetLinkVerify) return _assetLinkVerify;
  _assetLinkVerify = (async () => {
    try {
      const g = await window.api.assetsGetRoot();
      if (!g || !g.ok) return false; // 连状态都读不到 → 不做任何判定
      if (!g.configured) {
        ASSET_LIB.root = "";
        ASSET_LIB.scan = { tree: [], categories: [], assets: [] };
        ASSET_LIB.scanned = true;
        ASSET_LIB.noRoot = true;
        assetLinkSyncNodes();
        return true;
      }
      ASSET_LIB.root = String(g.path || "");
      const r = await assetScanCall();
      if (!r || !r.ok) return false; // 扫描失败同样不下「失联」结论
      assetApplyScan(r);
      assetLinkSyncNodes();
      return true;
    } catch (_) {
      return false;
    }
  })();
  const p = _assetLinkVerify;
  p.then(
    () => {
      _assetLinkVerify = null;
    },
    () => {
      _assetLinkVerify = null;
    },
  );
  return p;
}
/** body 渲染时调用：本会话还没校验过、画布上确实有绑定节点 → 补一次静默校验。
    _assetLinkAutoTried＝整个会话只自动试一次：根目录插在坏掉的 U 盘上时，
    扫描会一直失败；不加这道闸，每次 renderCanvas（hover / 拖动都算）都会重扫一遍目录。 */
let _assetLinkAutoTried = false;
function assetLinkCheckSoon() {
  if (ASSET_LIB.scanned || _assetLinkVerify || _assetLinkAutoTried) return;
  if (!assetsApiOk()) return;
  const nodes = (S.wf && S.wf.nodes) || [];
  let has = false;
  for (const n of nodes)
    if (isAssetNode(n) && String(n.assetId || "").trim()) {
      has = true;
      break;
    }
  if (!has) return;
  _assetLinkAutoTried = true;
  assetLinkVerify(false);
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
    /* wide ＝ 正文编辑那一类：框拉宽、正文框吃满高度（长文本不能只在 440px 里挤） */
    if (opts.wide) box.classList.add("asset-form-box-wide");
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
      /* 字段级动作按钮（文本正文的「上传文件…」就走这里）：动作只读写表单值，
         不提交表单 —— 载入后用户可以继续手改，再点「添加 / 保存到素材库」。 */
      if (Array.isArray(f.actions) && f.actions.length) {
        const acts = assetEl("div", "asset-form-actions");
        for (const act of f.actions) {
          const b = assetBtn(act.label, null, act.title || null);
          b.onclick = () => {
            const ctx = {
              get: (k) => (controls[k] ? String(controls[k].value || "") : ""),
              set: (k, v) => {
                if (controls[k]) controls[k].value = String(v == null ? "" : v);
              },
            };
            try {
              act.run(ctx);
            } catch (e) {
              toast(String((e && e.message) || e), "err");
            }
          };
          acts.appendChild(b);
        }
        row.appendChild(acts);
      }
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
      for (const k of Object.keys(controls)) {
        const raw =
          controls[k].value == null ? "" : String(controls[k].value);
        /* raw 字段（正文编辑）不 trim：文本素材尾随换行也是内容 */
        out[k] = (opts.rawKeys || []).indexOf(k) >= 0 ? raw : raw.trim();
      }
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
    /* persistent：表单里全是未提交的输入，点蒙层（host 空白）不关，只走「取消 / 确定」/ Esc */
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
  /* persistent：素材库带搜索与编辑，点 host 空白不关窗，只走 ✕ / Esc */
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
    /* 素材设置框压在上面的话，Esc 先收它（本框留着） */
    if (assetSettingsOpen()) {
      closeAssetSettings();
      return;
    }
    ev.preventDefault();
    closeAssetLib();
  });
  host.addEventListener("contextmenu", (ev) => {
    if (!ev.target || !ev.target.closest || !ev.target.closest(".asset-lib-tree")) return;
    ev.preventDefault();
  });
  /* 外部文件拖入：库框主体与右栏卡片区（详情态＝追加到所选素材，卡片态＝新建素材）。
     里层落点（条目行 / 详情列表）各自的 .asset-set-rows / 行会先接管，这里用 skip 让开。 */
  assetWireFileDrop(host.querySelector(".asset-lib-main-body"), {
    holder: ASSET_LIB,
    target: assetDropLibTarget,
    catRel: () => ASSET_LIB.selCat,
    skip: (t) => !!t.closest("#assetLibCards"),
  });
  assetWireFileDrop(host.querySelector("#assetLibCards"), {
    holder: ASSET_LIB,
    target: assetDropLibTarget,
    catRel: () => ASSET_LIB.selCat,
    /* 卡片与详情条目列表各自有落点（追加到那份素材），空白处才归这一层 */
    skip: (t) => !!t.closest(".asset-set-rows") || !!t.closest(".asset-lib-card"),
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
  /* 左树默认展开：当前分类 ＋ 所选素材所在分类（选中素材时一眼看见它在哪一层） */
  ASSET_LIB.expanded[String(ASSET_LIB.selCat || "")] = true;
  const selA = ASSET_LIB.selAssetId ? assetSummaryById(ASSET_LIB.selAssetId) : null;
  if (selA) ASSET_LIB.expanded[String(selA.catRel || "")] = true;
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
  /* 选择器永远从分类卡片视图开始：详情页那四项动作里没有「绑定」（绑定只从卡片 / 左树点）
     —— 留着上一次的 selAssetId 会开出一个没有绑定入口的页面 */
  ASSET_LIB.selAssetId = "";
  ASSET_LIB.expanded[String(ASSET_LIB.selCat || "")] = true;
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
  /* 右栏：选中了素材 → 它的内容详情；否则维持分类卡片视图。
     pick 模式（绑定选择器）永远走卡片 —— 详情页的动作里没有「绑定」。 */
  const cardsHost = host.querySelector("#assetLibCards");
  const sel =
    ASSET_LIB.mode === "manage" && ASSET_LIB.selAssetId
      ? assetSummaryById(ASSET_LIB.selAssetId)
      : null;
  /* 详情态给 #assetLibCards 加 is-detail：切掉卡片网格（含 minmax(258px) 那一列），
     让详情独占右栏宽度；回到卡片视图时移除该类，网格规则照旧生效。 */
  if (sel) {
    cardsHost.classList.add("is-detail");
    paintAssetDetail(cardsHost, sel);
  } else {
    cardsHost.classList.remove("is-detail");
    if (ASSET_LIB.selAssetId) ASSET_LIB.selAssetId = ""; // 素材没了（被删 / 换了根目录）→ 回落卡片
    paintAssetCards(cardsHost);
  }
  paintAssetFoot(host.querySelector("#assetLibFoot"));
}

/* 左树：分类行（可展开 ▸/▾）＋ 展开后挂在它下面的素材行（一体树）。
   分类层级仍按 rel 逐段排序后扁平列出（与原有口径一致，不依赖后端返回序）；
   展开态记在 ASSET_LIB.expanded。点分类＝选中该分类（右栏卡片），点素材＝选中它（右栏内容详情）。 */
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
  const isOpen = (rel) => !!ASSET_LIB.expanded[String(rel || "")];
  /* 素材行（挂在展开的分类下面）：点它＝右栏看这份素材的内容 */
  const assetRowOf = (a, depth) => {
    const on = String(ASSET_LIB.selAssetId || "") === String(a.id || "");
    const row = assetEl("div", "asset-lib-assetrow" + (on ? " on" : ""));
    row.style.paddingLeft = 8 + depth * 14 + "px";
    row.appendChild(
      assetEl("span", "asset-lib-assetname", a.displayName || a.folder || ""),
    );
    /* 类型徽标：文本 / 图像 / 音频 / 视频 / 混合 —— 左树里先看这个再点进去 */
    row.appendChild(assetKindChip(a));
    row.appendChild(
      assetEl("span", "asset-lib-catchip", String(Number(a.itemCount) || 0)),
    );
    row.title =
      assetItemsSummary(a) +
      "\n" +
      I18n.t("文件夹：") +
      (a.rel || "") +
      "\n" +
      I18n.t("点击查看内容（可编辑 / 更换）");
    row.onclick = () => {
      /* 选择器里点素材＝直接绑定（与卡片上「绑定这个素材」同一结果） */
      if (ASSET_LIB.mode === "pick") return assetPickAndBind(a);
      ASSET_LIB.selAssetId = String(a.id || "");
      ASSET_LIB.selCat = String(a.catRel || "");
      ASSET_LIB.expanded[String(a.catRel || "")] = true;
      paintAssetLib();
    };
    /* 外部文件拖到素材行＝追加成这份素材的内容条目（拖放落点反馈见 assetWireFileDrop） */
    assetWireFileDrop(row, { holder: ASSET_LIB, target: () => a });
    return row;
  };
  const rowOf = (rel, name, depth, count) => {
    const on =
      String(ASSET_LIB.selCat || "") === String(rel || "") && !ASSET_LIB.selAssetId;
    const row = assetEl("div", "asset-lib-catrow" + (on ? " on" : ""));
    row.style.paddingLeft = 8 + depth * 14 + "px";
    /* ▸/▾ 只管展开 / 收起，不冒泡到「选中这个分类」 */
    const caret = assetEl("span", "asset-lib-caret", isOpen(rel) ? "▾" : "▸");
    caret.title = isOpen(rel) ? I18n.t("收起分类") : I18n.t("展开分类");
    caret.onclick = (ev) => {
      ev.stopPropagation();
      if (isOpen(rel)) delete ASSET_LIB.expanded[String(rel || "")];
      else ASSET_LIB.expanded[String(rel || "")] = true;
      paintAssetLib();
    };
    row.appendChild(caret);
    row.appendChild(assetEl("span", "asset-lib-catname", name));
    row.appendChild(assetEl("span", "asset-lib-catchip", String(count)));
    row.title = assetCatLabel(rel);
    row.onclick = () => {
      ASSET_LIB.selCat = rel;
      ASSET_LIB.selAssetId = "";
      ASSET_LIB.expanded[String(rel || "")] = true; // 点分类顺手展开，直接看见里面的素材
      paintAssetLib();
    };
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      assetCatMenu(ev.clientX, ev.clientY, rel, name);
    };
    /* 外部文件拖到分类行＝在这个分类下新建素材（不是追加到某个已有素材） */
    assetWireFileDrop(row, { holder: ASSET_LIB, catRel: rel });
    return row;
  };
  /* 一个分类块 = 分类行 ＋（展开时）它下面的素材行 */
  const block = (rel, name, depth, count) => {
    host.appendChild(rowOf(rel, name, depth, count));
    if (!isOpen(rel)) return;
    for (const a of assetsInCat(rel)) host.appendChild(assetRowOf(a, depth + 1));
  };
  const rootCount = (ASSET_LIB.scan.assets || []).filter(
    (a) => !String(a.catRel || ""),
  ).length;
  block("", I18n.t("全部素材（根目录）"), 0, rootCount);
  for (const c of cats) {
    const depth = String(c.rel || "").split("/").length - 1;
    block(c.rel, c.name, depth, Number(c.assetCount) || 0);
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

/* pick 模式（素材节点「绑定」选择器）：选中一个素材即回调并收框 */
function assetPickAndBind(a) {
  const cb = ASSET_LIB.onPick;
  closeAssetLib();
  if (cb) {
    try {
      cb(a);
    } catch (_) {}
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
    host.appendChild(assetDropZoneEl("new"));
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
    host.appendChild(assetDropZoneEl("new"));
    return;
  }
  for (const a of list) host.appendChild(assetCard(a, pick));
  /* 外部文件拖到这里＝在当前分类下新建素材（提示块，落点接线在 ensureAssetsDlg） */
  host.appendChild(assetDropZoneEl("new"));
}

function assetCard(a, pick) {
  const card = assetEl("div", "asset-lib-card");
  const head = assetEl("div", "asset-lib-cardhead");
  head.appendChild(assetEl("b", "asset-lib-cardname", a.displayName || a.folder));
  /* 类型徽标：卡片上先说明「这包是文本 / 图像…还是混合」 */
  head.appendChild(assetKindChip(a));
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
  /* 外部文件拖到卡片＝追加成这份素材的内容条目（卡片之间的网格空白才是新建素材） */
  assetWireFileDrop(card, { holder: ASSET_LIB, target: () => a });
  const acts = assetEl("div", "asset-lib-cardacts");
  if (pick) {
    const b = assetBtn(I18n.t("绑定这个素材"), "primary", I18n.t("用该素材绑定当前节点"));
    b.onclick = () => assetPickAndBind(a);
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
  const del = assetBtn(I18n.t("删除"), "danger", I18n.t("删除素材（删进系统回收站，可在资源管理器里还原）"));
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

/* 右栏 · 选中素材的内容详情：
   顶部四项动作（设置 / 复制到画布 / 删除 / 打开文件夹，与卡片上那几项同一份实现）；
   正文＝内容条目列表（标题可改、可换文件、可编辑正文、可增删与拖动排序），
   写入一律走与「素材设置」同一份写库路径（assets* IPC），只是编辑目标换成这份素材。 */
function paintAssetDetail(host, a) {
  host.innerHTML = "";
  const wrap = assetEl("div", "asset-detail");
  const head = assetEl("div", "asset-detail-head");
  /* 头部左列：标题 / 副标题 / 文件夹行 —— class 取 components.css 里真实存在的那几个
     （.asset-detail-titlewrap / .asset-detail-title / .asset-detail-sub / .asset-detail-rel） */
  const titleWrap = assetEl("div", "asset-detail-titlewrap");
  const titleRow = assetEl("div", "asset-detail-titlerow");
  titleRow.appendChild(
    assetEl("b", "asset-detail-title", a.displayName || a.folder || ""),
  );
  /* 类型徽标：详情头与左树 / 卡片同一份判定（文本 / 图像 / 音频 / 视频 / 混合） */
  titleRow.appendChild(assetKindChip(a));
  titleWrap.appendChild(titleRow);
  titleWrap.appendChild(
    assetEl(
      "div",
      "asset-detail-sub",
      assetItemsSummary(a) + (a.desc ? "　" + a.desc : ""),
    ),
  );
  const relLine = assetEl(
    "div",
    "asset-detail-rel",
    I18n.t("文件夹：") + (a.rel || ""),
  );
  relLine.title = String(ASSET_LIB.root || "") + "/" + String(a.rel || "");
  titleWrap.appendChild(relLine);
  const acts = assetEl("div", "asset-detail-acts");
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
    I18n.t("复制到画布"),
    "primary",
    I18n.t("在当前画布创建一个绑定该素材的「素材」节点（库内容不变）"),
  );
  ins.onclick = () => assetInsertToCanvas(a);
  const del = assetBtn(
    I18n.t("删除"),
    "danger",
    I18n.t("删除素材（删进系统回收站，可在资源管理器里还原）"),
  );
  del.onclick = () => assetDeleteAsset(a);
  const open = assetBtn(
    I18n.t("打开文件夹"),
    null,
    I18n.t("在文件资源管理器中打开这个素材的文件夹"),
  );
  open.onclick = () => assetOpenPath(a.rel);
  acts.append(st, ins, del, open);
  head.append(titleWrap, acts);
  wrap.appendChild(head);

  /* 正文：条目工具条 ＋ 条目列表（行渲染与写库都与「素材设置」共用，只是带上本素材） */
  const body = assetEl("div", "asset-detail-body");
  body.appendChild(assetAddItemBar(a));
  const rows = assetSetRows(a);
  const list = assetEl("div", "asset-set-rows asset-detail-rows");
  if (!rows.length) {
    list.appendChild(
      assetEl(
        "div",
        "asset-lib-empty",
        I18n.t(
          "这个素材还没有内容：点上方「＋ 文本 / ＋ 图像 / ＋ 音频 / ＋ 视频」添加（标题＝节点上的端子名，顺序＝端子顺序）。",
        ),
      ),
    );
  } else {
    const ctx = { asset: a, holder: ASSET_LIB, repaint: () => paintAssetLib() };
    for (let i = 0; i < rows.length; i++)
      list.appendChild(assetSetRow(rows[i], i, rows.length, ctx));
  }
  /* 外部文件拖到条目区＝追加成这份素材的内容条目（提示块 ＋ 落点接线，与设置框同一份） */
  list.appendChild(assetDropZoneEl("add"));
  body.appendChild(list);
  /* 容器空白处落点＝移到末尾（与素材设置框同一口径） */
  assetWireListDrop(
    list,
    ASSET_LIB,
    (from, to) => assetSetMoveItem(from, to, a),
  );
  assetWireFileDrop(list, { holder: ASSET_LIB, target: () => a });
  wrap.appendChild(body);
  host.appendChild(wrap);
}

function paintAssetFoot(host) {
  host.innerHTML = "";
  const cats = (ASSET_LIB.scan.categories || []).length;
  const assets = (ASSET_LIB.scan.assets || []).length;
  host.appendChild(
    assetEl(
      "span",
      "asset-lib-fact",
      I18n.t("分类 ") + cats + " · " + I18n.t("素材 ") + assets,
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

/* 删除分类（文件夹）：**空与非空都能删**（素材 / 子分类 / 手动丢进去的文件一起走，整只文件夹
   进回收站，可在资源管理器里还原，绝不实删）。有内容时不再拦人 —— 拦了用户只能一个个先移走，
   操作起来像「删除失效」；改成确认框把「会一起没掉的东西」逐项数清（素材 / 内容条目 / 子分类），
   并说明引用它们的素材节点会变「素材失联」（节点与连线保留，可手动重绑）。
   计数按 catRel 前缀自己数一遍（assetCount 只算素材，条目数要说清就得连着 items 一起数）。 */
async function assetRemoveCategory(rel, name) {
  if (ASSET_LIB.busy) return;
  const here = String(rel || "");
  const inside = (ASSET_LIB.scan.assets || []).filter((a) => {
    const c = String(a.catRel || "");
    return c === here || c.startsWith(here + "/");
  });
  const nAssets = inside.length;
  const nItems = inside.reduce((s, a) => s + (Number(a.itemCount) || 0), 0);
  const nSubs = (ASSET_LIB.scan.categories || []).filter((c) =>
    String(c.rel || "").startsWith(here + "/"),
  ).length;
  const sure = await confirmDialog(
    nAssets
      ? I18n.t(
          "删除分类「{name}」？\n\n里面还有 {n} 个素材（共 {m} 条内容）和 {k} 个子分类，会一起删进系统回收站（可在资源管理器里还原）。\n· 引用这些素材的「素材」节点会变成「素材失联」（节点与连线保留，可手动重新绑定）\n· 文件夹里手工放进去的其它文件也一并进回收站\n\n确定删除？",
          { name: name, n: nAssets, m: nItems, k: nSubs },
        )
      : I18n.t("删除分类「{name}」？\n\n文件夹会删进系统回收站（可在资源管理器里还原）。", {
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
    /* 选中态收口：被删掉的分类本身、以及它下面那份被选中的素材，都不能留在界面上 */
    if (ASSET_LIB.selCat === here || String(ASSET_LIB.selCat || "").startsWith(here + "/"))
      ASSET_LIB.selCat = "";
    if (ASSET_LIB.selAssetId && !assetSummaryById(ASSET_LIB.selAssetId))
      ASSET_LIB.selAssetId = "";
    paintAssetLib();
    toast(
      nAssets
        ? I18n.t("已删除分类（含 {n} 个素材，进系统回收站）：", { n: nAssets }) + name
        : I18n.t("已删除分类（进系统回收站）：") + name,
      "ok",
    );
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
      "删除素材「{name}」？\n\n素材文件夹会删进系统回收站（可在资源管理器里还原）。已插入画布的「素材」节点会显示为「素材失联」，节点本身保留。",
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
    toast(I18n.t("已删除素材（进系统回收站）：") + (a.displayName || a.folder), "ok");
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
  });
  if (!node) {
    toast(I18n.t("插入失败：无法创建素材节点"), "err");
    return null;
  }
  /* 绑定只有一个口径（assetApplyBinding）；addNode 已经压过撤销栈，这里不再压第二次
     —— 新建素材节点在撤销里应当就是一步。 */
  assetApplyBinding(node, a, { history: false, quiet: true });
  toast(I18n.t("已插入素材：") + (a.displayName || a.folder || ""), "ok");
  return node;
}

/* ════════════ 素材节点侧：绑定 / 上传 / 失联重绑 / 设置入口 ════════════
   节点上只有 assetId + 相对路径 + 端子快照，内容实体永远在素材夹里：
   · 绑定 ＝ 在素材库左右栏（同一份渲染 · pick 模式）里挑一个素材；
   · 上传 ＝ 选本机一个文件夹 → 复制入库成为新素材 → 自动绑到本节点；
   · 失联（库里找不到这个素材）＝ 节点与端子快照全部保留，只给占位与「重新绑定」；
   · 重绑到别的素材时端子号按标题保号，对不上标题的连线断开 —— 都在一步撤销里。
   任何路径都不会删用户的节点。 */

/** 绑定 / 重绑的统一落地：写绑定 → 清旧素材缓存 → 刷下游 → 落盘重画。
    opts.history＝先压撤销栈（默认 true；刚 addNode 出来的节点传 false）；
    opts.quiet＝不弹 toast（「插入到画布」那一路自己报一句）。返回 false＝参数不合法。 */
function assetApplyBinding(node, summary, opts) {
  opts = opts || {};
  if (!isAssetNode(node) || !summary || !String(summary.id || "").trim())
    return false;
  const oldId = String(node.assetId || "");
  if (opts.history !== false) pushHistory();
  const r = assetBindNode(node, summary);
  delete node.assetLost; // 刚定位到的素材，先把失联标记摘掉
  /* 缓存整份作废：旧素材的视图没用了，新素材的视图也可能是在别处留下的旧值，
     让 body 重新向库读一次，节点上显示的永远是库里此刻的内容 */
  if (oldId && oldId !== String(summary.id)) assetItemsViewInvalidateAll(oldId);
  assetItemsViewInvalidateAll(summary.id);
  if (typeof clearDownstream === "function") clearDownstream(node.id);
  if (typeof scheduleSave === "function") scheduleSave(true);
  if (typeof renderCanvas === "function") renderCanvas();
  else assetViewRerenderSoon();
  if (typeof renderStatus === "function") renderStatus();
  if (!opts.quiet) {
    const nm = String(summary.displayName || summary.folder || "");
    const n = assetItems(node).length;
    if (!n)
      toast(
        I18n.t("已绑定素材：{name}（还没有内容，点节点上的「设置」添加）", {
          name: nm,
        }),
        "warn",
      );
    else if (r && r.dropped)
      toast(
        I18n.t(
          "已重新绑定：{name} · {n} 条对不上标题的连线已断开（Ctrl+Z 可撤销）",
          { name: nm, n: r.dropped },
        ),
        "ok",
      );
    else toast(I18n.t("已绑定素材：") + nm, "ok");
  }
  return true;
}

/** 上传落点：优先放回节点原来那个素材所在的分类（失联重传时挨着放），
    其次用素材库里上次选中的分类，都没有则落根目录。 */
function assetUploadCat(node) {
  const rel = String((node && node.assetRel) || "");
  const own = rel.indexOf("/") < 0 ? "" : rel.slice(0, rel.lastIndexOf("/"));
  if (own && assetCatExists(own)) return own;
  const sel = String(ASSET_LIB.selCat || "");
  return assetCatExists(sel) ? sel : "";
}

/** 「绑定…」：打开素材库选择器（与顶栏素材库同一份左右栏），选中即绑 */
function assetNodeBind(node) {
  if (!isAssetNode(node)) return;
  openAssetPicker({ onPick: (a) => assetApplyBinding(node, a) });
}

/** 「上传…」：选本机文件夹 → importDir 复制入库 → 自动绑定本节点 */
async function assetNodeUpload(node) {
  if (!isAssetNode(node)) return;
  if (!assetsApiOk()) {
    toast(I18n.t("素材库不可用（本机存储接口未就绪）"), "err");
    return;
  }
  if (ASSET_LIB.busy) return;
  const root = await assetEnsureRoot();
  if (!root) return;
  const picked = await window.api.fileOpenDialog({
    title: I18n.t(
      "选择要上传的文件夹（其中的文本 / 图像 / 音频 / 视频会成为素材内容）",
    ),
    directory: true,
  });
  const src = picked && picked.path;
  if (!src) {
    toast(I18n.t("未选择文件夹，取消上传"), "warn");
    return;
  }
  ASSET_LIB.busy = true;
  try {
    /* 先扫一次：确认落点分类还在（资源管理器里可能已被删），顺带刷新失联判定 */
    if (!(await assetRescan())) return;
    const catRel = assetUploadCat(node);
    const r = await window.api.assetsImportDir({ srcPath: src, catRel: catRel });
    if (!r || !r.ok) {
      toast(I18n.t("上传失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetRescan();
    if (!assetApplyBinding(node, r.asset)) {
      toast(I18n.t("已上传到素材库，但绑定节点失败"), "err");
      return;
    }
    const skip = Number(r.skipped) || 0;
    if (skip)
      toast(I18n.t("其中 {n} 个文件类型素材库不收，已跳过", { n: skip }), "warn");
  } finally {
    ASSET_LIB.busy = false;
  }
}

/** 根目录还没指定（供 app-canvas.js 的失联文案用） */
function assetLibNoRoot() {
  return !!ASSET_LIB.noRoot;
}
/** 「重新扫描」：找回素材夹 / 换回原根目录后，让画布上的失联节点立刻重新判定 */
function assetNodeRescanNow() {
  if (!assetsApiOk()) {
    toast(I18n.t("素材库不可用（本机存储接口未就绪）"), "err");
    return;
  }
  if (ASSET_LIB.busy) return;
  ASSET_LIB.busy = true;
  assetLinkVerify(true)
    .then((ok) => {
      if (!ok) {
        toast(I18n.t("重新扫描素材库失败"), "err");
        return;
      }
      assetViewRerenderSoon();
      toast(I18n.t("已重新扫描素材库"), "ok");
    })
    .finally(() => {
      ASSET_LIB.busy = false;
    });
}
/** 「重新绑定…」：与绑定同一条路，只是先说清楚为什么 */
function assetNodeRebind(node) {
  if (!isAssetNode(node)) return;
  if (ASSET_LIB.noRoot)
    toast(
      I18n.t("素材库根目录还没指定：先指定位置，或重新绑定到别处的素材"),
      "warn",
    );
  else
    toast(
      I18n.t("该素材在素材库里找不到了：选一个素材重新绑定（连线按标题保留）"),
      "warn",
    );
  assetNodeBind(node);
}

/** 失联时直接去库里处理（更改根目录 / 找回文件夹都在库里） */
function assetNodeOpenLib() {
  openAssetsLibrary();
}

/** 在资源管理器里显示这个素材夹（没扫过先补一次静默扫描） */
async function assetNodeReveal(node) {
  if (!isAssetNode(node)) return;
  const id = String(node.assetId || "").trim();
  if (!id) {
    toast(I18n.t("还没有绑定素材，没有可打开的文件夹"), "warn");
    return;
  }
  if (!ASSET_LIB.scanned) await assetLinkVerify(false);
  const sum = assetSummaryById(id);
  if (!sum) {
    toast(I18n.t("素材已失联：在素材库里找不到对应文件夹"), "warn");
    return;
  }
  const abs = ASSET_LIB.root + "/" + String(sum.rel || "");
  const r = await window.api.shellShowItem(abs);
  if (r && !r.ok) toast(I18n.t("打开失败：") + ((r && r.error) || ""), "err");
}

/** 节点头 ⚙ / 右键「设置」：素材设置框（显示名 / 描述 / 内容条目都在库里维护） */
async function assetNodeOpenSettings(node) {
  if (!isAssetNode(node)) return;
  const id = String(node.assetId || "").trim();
  if (!id) {
    toast(I18n.t("先绑定素材库内容，再设置它"), "warn");
    assetNodeBind(node);
    return;
  }
  if (!ASSET_LIB.scanned) await assetLinkVerify(false);
  const sum = assetSummaryById(id);
  if (!sum) {
    toast(I18n.t("素材已失联，先重新绑定才能设置"), "warn");
    assetNodeBind(node);
    return;
  }
  /* 对着「库里哪份素材」改已经定好了；设置框就落在本文件（openAssetSettings） */
  openAssetSettings(sum);
}

/* ════════════ 素材内容条目的「视图缓存」（素材节点 body 的取数口）════════════
   内容本体只存在素材库里，节点上只存条目身份（id / 标题 / 类型）。body 每帧同步渲染，
   向库读文件是异步的 —— 所以这里按 assetId|itemId 缓存一份读到的形状，
   缺的条目发一次 assets:itemRead，读齐后合并成一次重画（不逐条抖动画布）。
   写盘同样只在这里做：文本编辑（失焦提交）与浏览/更换文件都直接落到库，
   库端覆盖前会把旧文件收进 .versions/，撤销回滚由「执行取数」那一步接上。 */
const ASSET_ITEM_VIEW = new Map();
const ASSET_ITEM_BUSY = new Set();
/* 在飞的读取按 key 存一份 promise：执行前要「读齐再取值」的调用方（素材端子同步）
   靠它 await，body 渲染仍然只发不等。 */
const ASSET_ITEM_LOAD = new Map();
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
/** 库同步后只清「库里已经没有的条目」的缓存：还留着的路径 / 字节继续用，
    正在输入但没提交的文本不会被这次同步打断。 */
function assetItemsViewPrune(summary) {
  if (!summary || !summary.id) return;
  const keep = new Set((summary.items || []).map((it) => String(it.id || "")));
  const pre = String(summary.id) + "|";
  for (const k of Array.from(ASSET_ITEM_VIEW.keys())) {
    if (k.indexOf(pre) !== 0) continue;
    if (!keep.has(k.slice(pre.length))) ASSET_ITEM_VIEW.delete(k);
  }
  for (const k of Array.from(ASSET_ITEM_BUSY)) {
    if (k.indexOf(pre) !== 0) continue;
    if (!keep.has(k.slice(pre.length))) ASSET_ITEM_BUSY.delete(k);
  }
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
  if (!aid || !iid) return Promise.resolve();
  if (ASSET_ITEM_LOAD.has(k)) return ASSET_ITEM_LOAD.get(k);
  if (ASSET_ITEM_VIEW.has(k) || ASSET_ITEM_BUSY.has(k)) return Promise.resolve();
  ASSET_ITEM_BUSY.add(k);
  assetItemViewSet(aid, iid, { loading: true });
  const p = window.api
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
        type: r.type || "",
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
      ASSET_ITEM_LOAD.delete(k);
      assetViewRerenderSoon();
    });
  ASSET_ITEM_LOAD.set(k, p);
  return p;
}
/** 等到该条目的库内容就位（已经在飞的那次也会等到，不重复发请求） */
function assetItemViewLoaded(aid, iid) {
  if (!aid || !iid) return Promise.resolve();
  if (ASSET_ITEM_LOAD.has(aid + "|" + iid)) return ASSET_ITEM_LOAD.get(aid + "|" + iid);
  return assetItemViewLoad(aid, iid);
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
    端子唯一口径就是 assetBindNode：先 pushHistory 再改，端子号按标题保号，
    对不上标题的连线断开（一步撤销可复原）。库里只是改了显示名 / 描述时不动端子。 */
function assetApplySummaryToNodes(summary) {
  if (!summary || !summary.id || !S.wf || !Array.isArray(S.wf.nodes)) return 0;
  const nextSig = assetSigOfItems(assetItems(summary));
  const name = String(summary.displayName || summary.folder || "");
  const rel = String(summary.rel || "");
  const desc = String(summary.desc || "");
  const hit = [];
  for (const node of S.wf.nodes) {
    if (!isAssetNode(node) || String(node.assetId) !== String(summary.id))
      continue;
    if (
      assetSigOfItems(assetItems(node)) !== nextSig ||
      String(node.assetRel || "") !== rel ||
      String(node.assetName || "") !== name ||
      String(node.assetDesc || "") !== desc
    )
      hit.push(node);
  }
  if (!hit.length) return 0;
  pushHistory();
  let dropped = 0;
  for (const node of hit) {
    const r = assetBindNode(node, summary);
    if (r) dropped += Number(r.dropped) || 0;
    /* 端子集变了才需要重画：清掉这一批节点的缓存视图（本地未提交的 dirty 文本除外，
       读取时自会保留），并按库里的新条目集重新向库取内容 */
    assetItemsViewPrune(summary);
  }
  for (const node of hit)
    if (typeof clearDownstream === "function") clearDownstream(node.id);
  if (typeof scheduleSave === "function") scheduleSave();
  assetViewRerenderSoon();
  if (dropped)
    toast(
      I18n.t("素材库里的内容条目变了：{n} 条对不上标题的连线已断开（可撤销）", {
        n: dropped,
      }),
      "warn",
    );
  return hit.length;
}
/** 文本条目：失焦提交写盘（内容没变就不碰库）。
 *  与端子同步、设置框编辑走同一条 assetWriteItem：先压撤销快照、记下库里旧文件，
 *  Ctrl+Z 才会把库也一起滚回去（只回滚画布等于「撤销后数据仍被改」）。 */
async function assetItemCommitText(node, it) {
  if (!node || !it || !String(it.id || "").trim()) return false;
  if (!String(node.assetId || "").trim()) return false;
  const view = assetItemViewGet(node.assetId, it.id);
  if (!view || !view.dirty) return false;
  const text = String(view.text || "");
  const r = await assetWriteItem(
    node.assetId,
    it.id,
    { content: text },
    {
      type: "text",
      title: it.title,
      msg: I18n.t("已保存到素材库：") + (it.title || ""),
    },
  );
  if (!r.ok) {
    toast(I18n.t("写入素材库失败：") + (r.error || I18n.t("未知错误")), "err");
    return false;
  }
  if (typeof renderStatus === "function") renderStatus();
  return true;
}
/* 文件选择框的扩展名白名单：文本这一族与主进程 EXT_TYPE（assets-store.js）同一份口径，
   两边不一致会出现「选得到、入库被判成不支持」的孤儿文件。 */
const ASSET_TEXT_EXTS = [
  "txt", "md", "markdown", "json", "jsonc", "yaml", "yml", "csv", "tsv", "xml", "html",
  "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "lua", "sh", "bat", "ps1",
  "ini", "log", "srt", "ass", "lrc",
];
const ASSET_PICK_FILTERS = {
  text: { name: "文本", extensions: ASSET_TEXT_EXTS },
  image: { name: "图像", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
  audio: { name: "音频", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] },
  video: { name: "视频", extensions: ["mp4", "webm", "mov", "mkv", "avi"] },
};
/** 图像 / 音频 / 视频条目：浏览（选择本机文件）→ 复制入库并顶掉旧内容。
    文本条目同一条路：主进程按 utf8 读进来、恒落 .txt（见 assets-store.js readTextSrc）。
    节点 body 与素材设置框共用这一条路（前者只有 node，后者只有 assetId）。 */
function assetItemPickFile(node, it, type) {
  if (!node || !it) return;
  assetItemReplaceFile(String(node.assetId || ""), String(it.id || ""), it.title, type);
}
/** 从本机挑一个文本文件、把正文读进内存（表单里「上传文件…」用：填进正文框，
    用户仍可接着改，点「添加 / 保存」才写库）。读不到（二进制 / 编码异常）就报一句。 */
async function assetPickLocalText() {
  let picked = null;
  try {
    picked = await window.api.fileOpenDialog({
      title: I18n.t("选择要上传的文本文件"),
      filters: [ASSET_PICK_FILTERS.text],
      multi: false,
    });
  } catch (e) {
    return null;
  }
  const p =
    picked && picked.paths && picked.paths.length
      ? picked.paths[0]
      : (picked && picked.path) || "";
  if (!p) return null;
  let rd = null;
  try {
    rd = await window.api.fileReadText(p);
  } catch (_) {
    rd = null;
  }
  if (!rd || !rd.exists) {
    toast(I18n.t("读不到这个文件的文本内容：请改选 .txt / .md 这类纯文本文件"), "err");
    return null;
  }
  return { path: p, content: String(rd.content || "") };
}
/** 表单字段动作：选本机文本文件 → 灌进正文框（标题为空时顺手取文件名，去掉扩展名） */
async function assetFormLoadText(ctx) {
  const hit = await assetPickLocalText();
  if (!hit) return;
  ctx.set("text", hit.content);
  if (!String(ctx.get("title") || "").trim())
    ctx.set("title", String(fileName(hit.path) || "").replace(/\.[^.]+$/, ""));
  toast(
    I18n.t("已载入本机文本：{name}（可继续编辑，点确定才写进素材库）", {
      name: fileName(hit.path),
    }),
    "ok",
  );
}
/** 表单里正文字段共用的一颗「上传文件…」按钮 */
function assetTextUploadFieldAction() {
  return {
    label: I18n.t("上传文件…"),
    title: I18n.t("从本机选一个文本文件（.txt / .md / .json …）把正文读进来，不用手打"),
    run: (ctx) => assetFormLoadText(ctx),
  };
}
async function assetItemReplaceFile(aid, itemId, label, type) {
  aid = String(aid || "").trim();
  itemId = String(itemId || "").trim();
  if (!aid || !itemId) return false;
  const f = ASSET_PICK_FILTERS[type] || ASSET_PICK_FILTERS.image;
  let picked = null;
  try {
    picked = await window.api.fileOpenDialog({
      title: I18n.t("选择") + assetItemTypeLabel(type) + I18n.t("文件"),
      filters: [f],
      multi: false,
    });
  } catch (e) {
    return false;
  }
  const p =
    picked && picked.paths && picked.paths.length
      ? picked.paths[0]
      : (picked && picked.path) || "";
  if (!p) return false;
  const r = await assetWriteItem(aid, itemId, { srcPath: p }, {
    type: type,
    title: label,
    msg: I18n.t("已更换内容：") + (label || "") + I18n.t("（Ctrl+Z 可撤销）"),
  });
  if (!r.ok)
    toast(I18n.t("写入素材库失败：") + (r.error || I18n.t("未知错误")), "err");
  return !!r.ok;
}

/* ════════════ 内容写库：撤销记账 · 端子同步 · 库回滚 ════════════
 * 画布快照（snapshotState）只装 nodes/wires/groups/marks，素材库文件在快照之外；
 * 于是「撤销只回滚画布、库里那份仍是被改过的」等于用户数据丢了。这一节把两侧对齐：
 *   ① 写库前 assetHistorySlot() 压一格画布快照，并把这一格的对象拿在手上；
 *   ② 主进程每次覆盖写都回传 prevVersion（旧文件已被搬进 <素材夹>/.versions/ 的绝对路径）
 *      与 prevEmpty（覆盖前这一项本来就是 0 字节）；
 *   ③ assetRecordEdit 把它们记进那一格的 assetEdits；
 *   ④ undo()/redo()（app.js · stepHistory）换完画布后调 assetRollbackEdits，
 *      按 prevFile 复制回去（空则清回空），并把它自己产生的「旧的现在态」
 *      记到对面那一格上 —— 所以 redo 也能原样贴回来，不需要提前留副本。
 * 端子同步（连入永不自动写库；一律只亮提示，必须点节点上的「覆盖」并在二次确认后才写）
 * 的唯一判据是主进程按字节比的 assets:itemSame —— 画布那张图与库里那张图路径永远不同，
 * 猜路径必然常亮。 */
const ASSET_SYNC_PENDING = new Map(); // aid|iid → 连入的写库形状（「覆盖」亮着的依据）
let _assetRollbackBusy = false;
function assetRollbackBusy() {
  return !!_assetRollbackBusy;
}

/** 压一格「操作前」画布快照，并把真正进栈的那个对象交回来。
 *  pushHistory 有闸（后台写非当前画布 / _skipCanvasHistory）：没压进去就返回 null，
 *  这次写库不记账 —— 旧内容仍在 .versions/ 里，只是撤销不回滚库。 */
function assetHistorySlot() {
  if (typeof snapshotState !== "function" || typeof pushHistory !== "function")
    return null;
  const snap = snapshotState();
  pushHistory(snap);
  const st = (S && S.undoStack) || [];
  return st.length && st[st.length - 1] === snap ? snap : null;
}

/** 把「这次覆盖前库里那份文件」记到某一格快照上（见文件头第 ②③ 步） */
function assetRecordEdit(snap, e) {
  if (!snap || !Array.isArray(snap.assetEdits) || !e) return false;
  const aid = String(e.assetId || "");
  const iid = String(e.itemId || "");
  if (!aid || !iid) return false;
  snap.assetEdits.push({
    assetId: aid,
    itemId: iid,
    type: String(e.type || "text"),
    title: String(e.title || ""),
    /* prevFile ＝ .versions/ 里那份旧文件的绝对路径；"" ＝ 改之前本来就是空的 */
    prevFile: String(e.prevFile || ""),
    prevEmpty: e.prevEmpty !== false,
  });
  return true;
}

/** 内容写库的唯一出口（body 编辑、设置框、端子同步都走这里）。
 *  payload：{content:"…"} | {srcPath:"…"} | {base64:"…"} | {empty:true}
 *  opts：{type,title,light,msg,kind} —— light ＝ 只丢缓存不整框重画（批量同步用） */
async function assetWriteItem(aid, itemId, payload, opts) {
  opts = opts || {};
  aid = String(aid || "").trim();
  itemId = String(itemId || "").trim();
  if (!aid || !itemId) return { ok: false, error: I18n.t("素材或条目不存在") };
  if (!assetsApiOk()) return { ok: false, error: I18n.t("素材库不可用") };
  const slot = assetHistorySlot();
  let r = null;
  try {
    r =
      typeof payload.content === "string"
        ? await window.api.assetsItemUpdateText(aid, itemId, payload.content)
        : await window.api.assetsItemUpdateBytes(aid, itemId, payload || {});
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!r || !r.ok)
    return { ok: false, error: (r && r.error) || I18n.t("未知错误") };
  /* noop ＝ 主进程判定「源就是这一条此刻那份」，什么都没变：不记撤销账，
     并且把刚才为这次写库压的空快照退回去（否则白占一格 Ctrl+Z） */
  if (r.noop) {
    const st = (S && S.undoStack) || [];
    if (slot && st.length && st[st.length - 1] === slot) st.pop();
    return { ok: true, item: r.item, asset: r.asset, noop: true };
  }
  assetRecordEdit(slot, {
    assetId: aid,
    itemId: itemId,
    type: opts.type || (r.item && r.item.type) || "text",
    title: opts.title || (r.item && r.item.title) || "",
    prevFile: r.prevVersion || "",
    prevEmpty: r.prevEmpty !== false,
  });
  /* 落盘后库里那份就是新的：缓存必须作废，body 才会重新向库读一次 */
  assetItemViewInvalidate(aid, itemId);
  ASSET_SYNC_PENDING.delete(assetViewKey(aid, itemId));
  if (opts.light) {
    if (typeof scheduleSave === "function") scheduleSave();
    assetViewRerenderSoon();
  } else await assetAfterLibWrite(r.asset, opts.msg, opts.kind);
  return {
    ok: true,
    item: r.item,
    asset: r.asset,
    prevFile: r.prevVersion || "",
    prevEmpty: r.prevEmpty !== false,
  };
}

/** 该条目端子上此刻有没有「连进来了但库里还没有」的新内容（决定「覆盖」亮不亮） */
function assetItemSyncPending(node, idx) {
  if (!node || !isAssetNode(node)) return false;
  const it = assetItems(node)[Number(idx)];
  if (!it || !it.id || !String(node.assetId || "").trim()) return false;
  return ASSET_SYNC_PENDING.has(assetViewKey(node.assetId, it.id));
}
/** 亮着的那份是什么（tooltip 用；没有则 null） */
function assetItemSyncValue(node, idx) {
  const it = node ? assetItems(node)[Number(idx)] : null;
  if (!it || !it.id) return null;
  return ASSET_SYNC_PENDING.get(assetViewKey(node.assetId, it.id)) || null;
}
/** 一个条目端子的同步检查，返回 "pending"（「覆盖」亮起，等用户确认才写库）/
 *  "same"（连入的就是库里这份）/ "none"（没连线或没值）。
 *  需求口径：连入端子只做检查、永不自动写库 —— 库里这条是空的也一样，必须用户点节点上的
 *  「覆盖」并在二次确认后才换进去（可撤销）；同一条线反复跑不会反复写盘。 */
async function assetSyncCheckPort(node, idx) {
  if (!isAssetNode(node)) return "none";
  const items = assetItems(node);
  const i = Number(idx);
  const it = items[i];
  const aid = String(node.assetId || "").trim();
  if (!it || !it.id || !aid) return "none";
  if (typeof assetNodeIsLost === "function" && assetNodeIsLost(node)) return "none";
  const key = assetViewKey(aid, it.id);
  const inb =
    typeof assetPortInboundValue === "function"
      ? assetPortInboundValue(node, i)
      : null;
  const emptyIn =
    !inb ||
    (inb.kind === "text"
      ? !String(inb.text || "").trim()
      : !String(inb.path || "").trim());
  if (emptyIn) {
    ASSET_SYNC_PENDING.delete(key);
    return "none";
  }
  const payload =
    it.type === "text"
      ? { content: String(inb.text || "") }
      : { srcPath: String(inb.path || "") };
  /* 「库里这一条此刻是不是就是连进来的这份」一律问主进程按字节判。
     不拿扫描摘要 / 视图缓存里的 bytes 猜：那两者都可能滞后（light 写盘只丢缓存、不重扫），
     凭滞后值判同会让「覆盖」提示该亮时亮不起来（或反之常亮）。 */
  let cmp = null;
  try {
    cmp = await window.api.assetsItemSame(aid, it.id, payload);
  } catch (_) {
    cmp = null;
  }
  if (!cmp || !cmp.ok) return "none"; // 素材 / 条目此刻找不到：不亮也不硬写
  /* 库里这条空不空都不写库：空条目原本会自动同步，现已改为只亮提示，等用户点「覆盖」并确认 */
  if (cmp.same) {
    ASSET_SYNC_PENDING.delete(key);
    return "same";
  }
  ASSET_SYNC_PENDING.set(key, inb);
  return "pending";
}
/** 点「覆盖」：把这一条输入端子连入的内容换进素材库
 *  （写盘前由用户二次确认；旧内容进 .versions，可撤销） */
async function assetItemSyncFromPort(node, idx) {
  const items = assetItems(node);
  const i = Number(idx);
  const it = items[i];
  const aid = String((node && node.assetId) || "").trim();
  if (!it || !it.id || !aid) return;
  let inb = ASSET_SYNC_PENDING.get(assetViewKey(aid, it.id));
  /* 没跑过一轮（内存里没记下这份值）也允许直接点：当场按端子连线取一次值 */
  if (!inb && typeof assetPortInboundValue === "function")
    inb = assetPortInboundValue(node, i);
  if (!inb) {
    toast(I18n.t("这个端子目前没有连入内容"), "warn");
    return;
  }
  /* 覆盖是破坏性写库：先由用户二次确认；取消即原样返回，不写盘、不记撤销账 */
  const sure = await confirmDialog(
    I18n.t(
      "用该端子连入的内容覆盖素材库条目「{title}」？原有内容会进历史版本，可 Ctrl+Z 撤销。",
      { title: it.title },
    ),
    {
      title: I18n.t("覆盖素材内容"),
      okText: I18n.t("覆盖"),
      danger: true,
    },
  );
  if (!sure) return;
  const r = await assetWriteItem(
    aid,
    it.id,
    it.type === "text"
      ? { content: String(inb.text || "") }
      : { srcPath: String(inb.path || "") },
    {
      type: it.type,
      title: it.title,
      msg: I18n.t("已覆盖到素材库：") + it.title + I18n.t("（Ctrl+Z 可撤销）"),
    },
  );
  if (!r.ok)
    toast(I18n.t("覆盖失败：") + (r.error || I18n.t("未知错误")), "err");
}
/** 执行前把这条链要用到的素材内容读齐，并做一次端子同步检查。
 *  「读齐」是必须的：valueForInput 是同步取值，库里那份正文得先在缓存里。 */
async function assetRunPrepare(node) {
  if (!isAssetNode(node) || !String(node.assetId || "").trim()) return false;
  if (!assetsApiOk()) return false;
  await assetLinkVerify(false); // 失联判定的前提：至少扫过一次
  if (typeof assetNodeIsLost === "function" && assetNodeIsLost(node)) return false;
  const aid = String(node.assetId);
  const items = assetItems(node);
  await Promise.all(
    items.map((it) => (it.id ? assetItemViewLoaded(aid, it.id) : null)),
  );
  let pend = 0;
  for (let i = 0; i < items.length; i++) {
    const s = await assetSyncCheckPort(node, i);
    if (s === "pending") pend++;
  }
  /* 只做检查、不写库：连入不自动覆写，等用户点节点上的「覆盖」并确认；这里最多重画提示 */
  if (pend) assetViewRerenderSoon();
  return true;
}
/** 引擎在 playNodeBody 里调用：本节点自身 + 喂给它的那些素材节点先备好 */
async function assetPrepareForRun(node) {
  if (!node || !S.wf) return;
  const jobs = [];
  if (isAssetNode(node)) jobs.push(assetRunPrepare(node));
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (isAssetNode(src)) jobs.push(assetRunPrepare(src));
  }
  if (jobs.length) await Promise.all(jobs);
}
/** 引擎在 playNode 末尾调用：本节点刚产出的值若直接喂进某个素材端子，同步检查一遍。
 *  只点亮「覆盖」提示，绝不自动写库（写库唯一出口是用户点「覆盖」+ 二次确认）。 */
async function assetSyncConsumers(node) {
  if (!node || !S.wf || !Array.isArray(S.wf.wires)) return;
  const jobs = [];
  for (const w of S.wf.wires) {
    if (!w || w.rel || w.from !== node.id) continue;
    if (typeof wireFromIsControl === "function" && wireFromIsControl(w)) continue;
    const to = nodeById(w.to);
    if (!isAssetNode(to) || !String(to.assetId || "").trim()) continue;
    if (typeof assetNodeIsLost === "function" && assetNodeIsLost(to)) continue;
    jobs.push(
      (async () => {
        const i = Number(w.toIndex || 0);
        const items = assetItems(to);
        if (!items[i]) return;
        await assetItemViewLoaded(to.assetId, items[i].id);
        await assetSyncCheckPort(to, i);
      })(),
    );
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  assetViewRerenderSoon();
}
/** 按快照上记的那笔账，把库里这一条还原成改之前的样子 */
function assetRestoreEdit(e) {
  const aid = String((e && e.assetId) || "");
  const iid = String((e && e.itemId) || "");
  if (!aid || !iid || !assetsApiOk()) return Promise.resolve({ ok: false });
  const abs = String((e && e.prevFile) || "");
  /* 有旧文件 → 从 .versions/ 复制回来（扩展名跟着旧文件走）；
     没有 → 这一条改之前就是空的，清回空（撤销一次「覆盖」的落点） */
  if (abs) return window.api.assetsItemUpdateBytes(aid, iid, { srcPath: abs });
  if (String((e && e.type) || "") === "text")
    return window.api.assetsItemUpdateText(aid, iid, "");
  return window.api.assetsItemUpdateBytes(aid, iid, { empty: true });
}
/** 撤销 / 重做的库侧：倒序回滚这批改动，并把回滚自身产生的「旧的现在态」
 *  记到 targetSnap（对面那一格）上，于是反方向也能原样走回来。 */
async function assetRollbackEdits(edits, targetSnap) {
  const list = (edits || []).filter((e) => e && e.assetId && e.itemId);
  if (!list.length) return { done: 0, failed: 0 };
  _assetRollbackBusy = true;
  let done = 0;
  let failed = 0;
  const touched = new Set();
  try {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      let r = null;
      try {
        r = await assetRestoreEdit(e);
      } catch (_) {
        r = null;
      }
      if (!r || !r.ok) {
        failed++;
        continue;
      }
      done++;
      touched.add(String(e.assetId));
      assetItemViewInvalidate(String(e.assetId), String(e.itemId));
      assetRecordEdit(targetSnap, {
        assetId: e.assetId,
        itemId: e.itemId,
        type: (r.item && r.item.type) || e.type,
        title: e.title,
        prevFile: r.prevVersion || "",
        prevEmpty: r.prevEmpty !== false,
      });
    }
    await assetRescan();
    for (const aid of touched) assetItemsViewInvalidateAll(aid);
    if (assetLibOpen()) paintAssetLib();
    if (assetSettingsOpen()) paintAssetSettings();
    assetViewRerenderSoon();
    if (typeof scheduleSave === "function") scheduleSave();
  } finally {
    _assetRollbackBusy = false;
  }
  return { done: done, failed: failed };
}

/* ════════════════ 素材设置对话框：显示名 / 描述 ＋ 内容条目 CRUD ════════════════
 * 一张表管住「库里那份素材」与「画布上的端子」，写入永远只有一个方向：
 *   ① 先写库（api.assets*）；② 拿库回来的新摘要贴到画布上绑定该素材的每个节点
 *   （assetApplySummaryToNodes → assetBindNode → assetItemPerm → assetRemapItemWires）。
 * 于是端子天然跟着条目走：
 *   · 改标题 → 端子 title 变、序号不变（id 认得出＝同一条目，线不甩）；
 *   · 增条目 → 末尾多一对端子；
 *   · 删条目 → 只断这一对的连线、后面的端子号顺移，整步进撤销栈（Ctrl+Z 复原节点与线）；
 *   · 重排 → perm 口径与 app.js · fnToolMoveParam 逐字一致（把 from 移到 to、中间顺移一格），
 *     不另发明一套数法；条目顺序落盘后，别的画布下次打开 / 刷新按库为准。
 * 画布快照管不到库文件，库那侧的安全垫在 T1：覆盖进 .versions/、删除进 .trash/。 */
const ASSET_SET = {
  open: false,
  id: "", // 正在设置的素材 id（真源在库里，这里只记身份）
  dragFrom: -1, // 行拖动的源行号，-1 = 无拖拽
};

function assetSettingsOpen() {
  return !!ASSET_SET.open;
}
/** 当前设置对象：一律现从扫描结果里取（库为真源），取不到＝素材没了 */
function assetSettingsAsset() {
  return ASSET_SET.id ? assetSummaryById(ASSET_SET.id) : null;
}

/* ── 编辑目标：设置框与素材库右栏详情共用同一套写库动作，只有「改的是哪份素材」不同 ──
   assetEditAssetId(a) ＝ 本次写库该带的素材 id；assetEditAssetFor(a) ＝ 本次编辑目标的完整摘要
   （右栏详情传所选素材 a；设置框不传 → 回落 ASSET_SET 的素材）。 */
function assetEditAssetId(a) {
  const id = a && a.id ? a.id : ASSET_SET.id;
  return String(id || "").trim();
}
function assetEditAssetFor(a) {
  const id = a && a.id ? String(a.id) : String(ASSET_SET.id || "");
  if (!id) return null; // 没有编辑目标：右栏详情与设置框都不该有可改的行
  /* 库为真源：能按 id 取到就用扫描结果里此刻那份，取不到才回落到调用方给的快照 */
  return assetSummaryById(id) || (a && a.id ? a : null);
}
/** 一次库写入的统一收尾（设置框与右栏详情共用）：
    a ＝ 本次编辑目标，summary ＝ 库回来的新摘要；走与 assetAfterLibWrite 同一条路
    （同步绑定节点的端子快照 → 重扫 → 重画素材库 / 设置框 / 画布 → 回执）。 */
async function assetEditAfterWrite(a, summary, msg, kind) {
  const target = assetEditAssetFor(a);
  /* 写完把目标所在分类留在展开态：左树里刚动过的素材别因为重画而缩回去 */
  if (target && target.id) ASSET_LIB.expanded[String(target.catRel || "")] = true;
  return assetAfterLibWrite(summary, msg, kind);
}
/** 设置框正在改的那份摘要（打开时若还没扫过库，先补一次静默扫描） */
async function openAssetSettings(ref) {
  const id = String((ref && ref.id) || "").trim();
  if (!id) return;
  if (!assetsApiOk()) {
    toast(I18n.t("素材库不可用（本机存储接口未就绪）"), "err");
    return;
  }
  ASSET_SET.open = true;
  ASSET_SET.id = id;
  const host = ensureAssetSetDlg();
  host.classList.add("on");
  /* 焦点收进本框：Esc 归最上面这张框（否则会落到下面的素材库框上） */
  try {
    host.focus();
  } catch (_) {}
  paintAssetSettings();
  if (!ASSET_LIB.scanned) {
    await assetLinkVerify(false);
    if (ASSET_SET.open) paintAssetSettings();
  }
}

function closeAssetSettings() {
  ASSET_SET.open = false;
  ASSET_SET.id = "";
  ASSET_SET.dragFrom = -1;
  const host = document.getElementById("assetSetDlg");
  if (host) host.classList.remove("on");
}

function ensureAssetSetDlg() {
  let host = document.getElementById("assetSetDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "assetSetDlg";
  host.className = "mt-dialog asset-set-dlg";
  host.tabIndex = -1;
  host.innerHTML =
    '<div class="mt-dialog-box asset-set-box" role="dialog" aria-modal="true">' +
    '<div class="asset-lib-head">' +
    '<b id="assetSetTitle"></b>' +
    '<span class="asset-lib-rootpath" id="assetSetRel"></span>' +
    '<span class="asset-lib-spacer"></span>' +
    '<button type="button" class="mini" id="assetSetRevealBtn"></button>' +
    '<button type="button" class="mini" id="assetSetRefreshBtn"></button>' +
    '<button type="button" class="mini node-guide-x" id="assetSetClose">✕</button>' +
    "</div>" +
    '<div class="asset-set-body" id="assetSetBody"></div>' +
    '<div class="asset-lib-foot" id="assetSetFoot"></div>' +
    "</div>";
  document.body.appendChild(host);
  host.querySelector("#assetSetClose").onclick = () => closeAssetSettings();
  host.querySelector("#assetSetRevealBtn").onclick = () => assetSetReveal();
  host.querySelector("#assetSetRefreshBtn").onclick = () => assetSetRefresh();
  /* persistent：素材库设置窗，点蒙层不关，只走 ✕ / Esc */
  host.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    /* 压在上面的确认框 / 表单框先收 Esc（它们各自处理），这里不抢 */
    const up = document.getElementById("mtDialog");
    if (up && up.classList.contains("on")) return;
    if (document.getElementById("assetFormDlg")) return;
    ev.preventDefault();
    ev.stopPropagation();
    closeAssetSettings();
  });
  return host;
}

/** 一次库写入的统一收尾：新摘要 → 画布节点（含 pushHistory 与端子重映射）→ 重扫 → 重画。
    msg 为成功后的一句回执（不传则不提示）。
    重画不能只挂在 assetApplySummaryToNodes 上：它按「端子集签名」判定，只改正文 / 换文件
    时条目集没变 → 它会提前返回，body 里那条缓存就永远停在旧内容上。 */
async function assetAfterLibWrite(summary, msg, kind) {
  if (summary && summary.id) assetApplySummaryToNodes(summary);
  await assetRescan();
  if (S.wf) scheduleSave();
  if (assetLibOpen()) paintAssetLib();
  if (assetSettingsOpen()) paintAssetSettings();
  assetViewRerenderSoon();
  if (msg) toast(msg, kind || "ok");
  return true;
}

/* 忙闸门：同一时刻只允许一个写库动作在飞（与素材库主框共用一把锁） */
async function assetSetBusyRun(fn) {
  if (ASSET_LIB.busy) return false;
  ASSET_LIB.busy = true;
  try {
    return await fn();
  } finally {
    ASSET_LIB.busy = false;
  }
}

function assetSetReveal() {
  const a = assetSettingsAsset();
  if (!a || !ASSET_LIB.root) {
    toast(I18n.t("素材已失联：在素材库里找不到对应文件夹"), "warn");
    return;
  }
  window.api.shellShowItem(ASSET_LIB.root + "/" + String(a.rel || ""));
}

async function assetSetRefresh() {
  await assetRescan();
  if (assetLibOpen()) paintAssetLib();
  if (ASSET_SET.open) paintAssetSettings();
}

/* ── 条目行：库摘要 items 的展示形状（标题 / 类型口径与端子完全同一份） ── */
function assetSetRows(a) {
  const norm = assetItems(a || {});
  const raw = {};
  for (const it of (a && a.items) || []) if (it) raw[String(it.id)] = it;
  return norm.map((it, i) => {
    const o = raw[it.id] || {};
    return {
      id: it.id,
      title: it.title,
      type: it.type,
      idx: i,
      file: String(o.file || ""),
      absPath: String(o.absPath || ""),
      bytes: Number(o.bytes) || 0,
      missing: !!o.missing,
    };
  });
}

function paintAssetSettings() {
  const host = ensureAssetSetDlg();
  const a = assetSettingsAsset();
  if (!a) {
    /* 还没扫过库：此刻「找不到」并不说明素材没了，先给等待态，别误报成被关闭 */
    if (!ASSET_LIB.scanned) {
      host.classList.add("on");
      host.querySelector("#assetSetTitle").textContent = I18n.t("素材设置");
      host.querySelector("#assetSetRel").textContent = "";
      const wait = host.querySelector("#assetSetBody");
      wait.innerHTML = "";
      wait.appendChild(
        assetEl("div", "asset-lib-empty", I18n.t("正在读取素材库…")),
      );
      host.querySelector("#assetSetFoot").innerHTML = "";
      return;
    }
    /* 素材在别处被删了 / 换了根目录：设置框没有可改的对象，直接收掉并说明 */
    const b = host.querySelector("#assetSetTitle");
    if (b) b.textContent = I18n.t("素材设置");
    if (ASSET_SET.open) {
      ASSET_SET.open = false;
      ASSET_SET.id = "";
      host.classList.remove("on");
      toast(
        I18n.t("该素材已不在素材库里（可能被删除或换了根目录），素材设置已关闭"),
        "warn",
      );
    }
    return;
  }
  ASSET_SET.open = true;
  const pick = ASSET_LIB.mode === "pick";
  host.querySelector("#assetSetTitle").textContent = pick
    ? I18n.t("素材设置（绑定选择中）")
    : I18n.t("素材设置");
  const rel = host.querySelector("#assetSetRel");
  rel.textContent = a.rel || "";
  rel.title = I18n.t("素材文件夹（资源管理器里也能直接整理）") + "\n" + ASSET_LIB.root;
  const rv = host.querySelector("#assetSetRevealBtn");
  rv.textContent = I18n.t("在文件夹中显示");
  rv.title = I18n.t("打开这个素材在素材库里的文件夹");
  const rb = host.querySelector("#assetSetRefreshBtn");
  rb.textContent = I18n.t("刷新");
  rb.title = I18n.t("重新扫描素材库，取库里此刻的内容");
  paintAssetSetBody(host.querySelector("#assetSetBody"), a);
  paintAssetSetFoot(host.querySelector("#assetSetFoot"), a);
}

function paintAssetSetBody(box, a) {
  box.innerHTML = "";
  /* ── 资料区：显示名 / 描述（改动失焦即写库） ── */
  const meta = assetEl("div", "asset-set-meta");
  const nmLab = assetEl("label", null, I18n.t("显示名称"));
  const nm = document.createElement("input");
  nm.type = "text";
  nm.className = "asset-form-input";
  nm.value = String(a.displayName || a.folder || "");
  nm.placeholder = I18n.t("例如：主角人设 / 片头音乐");
  const dsLab = assetEl("label", null, I18n.t("描述"));
  const ds = document.createElement("textarea");
  ds.className = "asset-form-input";
  ds.rows = 2;
  ds.value = String(a.desc || "");
  ds.placeholder = I18n.t("这个素材装的是什么（只给人看，不影响端子）");
  /* 资料改动＝失焦即写库（与节点「设置」跳窗里的字段同一口径） */
  nm.addEventListener("change", () => assetSetSaveMeta(nm.value, ds.value));
  ds.addEventListener("change", () => assetSetSaveMeta(nm.value, ds.value));
  /* 单行框里 Enter ＝ 提交（走 change 同一条路）；多行描述里 Enter 是换行 */
  nm.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      nm.blur();
    }
  });
  const row1 = assetEl("div", "asset-set-mrow");
  row1.append(nmLab, nm);
  const row2 = assetEl("div", "asset-set-mrow");
  row2.append(dsLab, ds);
  meta.append(row1, row2);
  box.appendChild(meta);
  box.appendChild(
    assetEl(
      "div",
      "asset-set-tip",
      I18n.t(
        "内容条目＝节点上的一对端子：这里的标题就是端子名，这里的顺序就是端子顺序。改动直接写进素材库，画布上所有绑定该素材的节点一起跟着变。",
      ),
    ),
  );
  /* ── 条目工具条（与素材库右栏详情共用同一份：assetAddItemBar） ── */
  box.appendChild(assetAddItemBar(a));
  /* ── 条目列表（⠿ 拖动 ＋ ▲▼ 逐格；顺序即端子顺序） ── */
  const rows = assetSetRows(a);
  const list = assetEl("div", "asset-set-rows");
  list.id = "assetSetRows";
  if (!rows.length) {
    list.appendChild(
      assetEl(
        "div",
        "asset-lib-empty",
        I18n.t(
          "还没有内容：点上方「＋ 文本」上传本机文本文件（或手写一条空正文），或「＋ 图像 / 音频 / 视频」从本机选文件入库。",
        ),
      ),
    );
  }
  const ctx = { asset: a, holder: ASSET_SET, repaint: () => paintAssetSettings() };
  for (let i = 0; i < rows.length; i++)
    list.appendChild(assetSetRow(rows[i], i, rows.length, ctx));
  /* 外部文件拖到条目区＝追加成这份素材的内容条目（提示块 ＋ 落点接线，与右栏详情同一份） */
  list.appendChild(assetDropZoneEl("add"));
  box.appendChild(list);
  /* 容器级拖放：拖到列表下方空白 = 移到末尾（与参数面板同一口径） */
  assetWireListDrop(
    list,
    ASSET_SET,
    (from, to) => assetSetMoveItem(from, to, a),
  );
  assetWireFileDrop(list, { holder: ASSET_SET, target: () => a });
}

/* 「内容」条目工具条：＋ 文本（上传 / 手写）/ ＋ 图像 / ＋ 音频 / ＋ 视频
   —— 素材设置框与素材库右栏详情两处共用；a ＝ 本次编辑的素材（不传 → 设置框那份）。 */
function assetAddItemBar(a) {
  const bar = assetEl("div", "asset-set-bar");
  bar.appendChild(assetEl("b", null, I18n.t("内容")));
  bar.appendChild(assetEl("span", "asset-lib-spacer"));
  /* 文本：上传本机文本文件（可多选）或手写一条空正文，两条路并列 —— 不再只有「手动编辑」 */
  assetSetAddTextBtn(bar, a);
  const addMap = [
    ["image", I18n.t("＋ 图像"), I18n.t("从本机选图像文件复制入库（可多选）")],
    ["audio", I18n.t("＋ 音频"), I18n.t("从本机选音频文件复制入库（可多选）")],
    ["video", I18n.t("＋ 视频"), I18n.t("从本机选视频文件复制入库（可多选）")],
  ];
  for (const [type, label, tip] of addMap) {
    const b = assetBtn(label, null, tip);
    b.onclick = () => assetSetAddMedia(type, a);
    bar.appendChild(b);
  }
  return bar;
}

/* ── 条目行的 ⠿ 拖动 + 落点高亮：设置框与右栏详情共用同一套手感 ──
   holder ＝ 拖拽状态宿主（ASSET_SET / ASSET_LIB，各有 dragFrom）；move(from,to) ＝ 落库重排；
   repaint ＝ 「拖到一半松手 / 落点无效」时复位列表。返回的把手由调用方插进行里。 */
function assetWireRowDrag(row, i, holder, repaint, move) {
  const grip = assetEl("span", "asset-set-grip", "⠿");
  grip.draggable = true;
  grip.title = I18n.t(
    "拖动把手调整内容顺序（端子与已连数据线随内容移位 · ▲▼ 可逐格移动）",
  );
  grip.addEventListener("dragstart", (ev) => {
    holder.dragFrom = i;
    row.classList.add("asset-set-dragging");
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      try {
        ev.dataTransfer.setData("text/plain", String(i));
      } catch (_) {}
    }
  });
  grip.addEventListener("dragend", () => {
    /* drop 已经清过拖拽态并触发重画；只有「拖到一半松手 / 落点无效」才需要自己复位 */
    const cancelled = holder.dragFrom >= 0;
    assetClearRowDrag(row.parentElement, holder);
    if (cancelled) repaint();
  });
  row.addEventListener("dragover", (ev) => {
    if (holder.dragFrom < 0 || holder.dragFrom === i) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    const list = row.parentElement;
    if (list)
      list
        .querySelectorAll(".asset-set-drop-before,.asset-set-drop-after")
        .forEach((el) =>
          el.classList.remove("asset-set-drop-before", "asset-set-drop-after"),
        );
    const rect = row.getBoundingClientRect();
    row.classList.add(
      ev.clientY < rect.top + rect.height / 2
        ? "asset-set-drop-before"
        : "asset-set-drop-after",
    );
  });
  row.addEventListener("dragleave", () =>
    row.classList.remove("asset-set-drop-before", "asset-set-drop-after"),
  );
  row.addEventListener("drop", (ev) => {
    if (holder.dragFrom < 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const from = holder.dragFrom;
    const rect = row.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    const list = row.parentElement;
    assetClearRowDrag(list, holder);
    /* 落点按移动前的行号算：前半＝插到它前面，后半＝插到它后面 */
    let to = i;
    if (from < i) to = before ? i - 1 : i;
    else to = before ? i : i + 1;
    move(from, to);
  });
  return grip;
}

/* 容器级落点：拖到列表空白 = 移到末尾（两个列表同一口径） */
function assetWireListDrop(list, holder, move) {
  list.addEventListener("dragover", (ev) => {
    if (holder.dragFrom < 0) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  });
  list.addEventListener("drop", (ev) => {
    if (holder.dragFrom < 0) return;
    const rowEl =
      ev.target && ev.target.closest ? ev.target.closest(".asset-set-row") : null;
    if (rowEl) return; // 行内落点由该行处理
    ev.preventDefault();
    const from = holder.dragFrom;
    const n = list.querySelectorAll(".asset-set-row").length;
    assetClearRowDrag(list, holder);
    move(from, n - 1);
  });
}

/* 清拖拽态：复位宿主记的行号，并摘掉行的拖动 / 落点视觉态 */
function assetClearRowDrag(list, holder) {
  holder.dragFrom = -1;
  if (!list) return;
  list
    .querySelectorAll(".asset-set-dragging,.asset-set-drop-before,.asset-set-drop-after")
    .forEach((el) =>
      el.classList.remove(
        "asset-set-dragging",
        "asset-set-drop-before",
        "asset-set-drop-after",
      ),
    );
}

/* ── 从 Windows 资源管理器拖入文件 / 文件夹：素材库与素材设置框统一落点 ──────
   一个入口 assetWireFileDrop(el, opts) 挂 dragenter / dragover / dragleave / drop：
     · 取路径必须走 window.api.getPathForFile（Electron 39 里 File.path 已不存在）；
       桥不在（老壳 / 非桌面环境）就整个不接管，既有内部拖拽照旧。
     · 内部拖拽优先：条目行重排（holder.dragFrom ≥ 0）与侧栏文件拖拽
       （application/x-mtnode-files）一律放过，落点冲突时内部赢。
     · 拖放期间只加 / 去 .asset-drop-hot 视觉态与提示块文案，写库全在 drop 里做。
   opts:
     · target()  → 追加目标的素材摘要（有值＝追加内容条目；空 / 不传＝新建素材）
     · catRel    → 新建素材落进哪个分类（字符串或函数；缺省＝当前选中分类）
     · holder    → 该区域的内部拖拽状态宿主（ASSET_LIB / ASSET_SET）
     · skip(t)   → 真＝这一层不接管（交给更里层的落点，避免套娃高亮）
   返回 true ＝ 已接管。 */
const ASSET_DROP_INTERNAL = "application/x-mtnode-files";

/* DataTransfer.types 的定长快照（类数组，直接 indexOf 用不了） */
function assetDropTypes(ev) {
  const dt = ev && ev.dataTransfer;
  if (!dt || !dt.types) return [];
  const out = [];
  for (let i = 0; i < dt.types.length; i++) out.push(String(dt.types[i]));
  return out;
}
/* 外部文件拖入？（types 缺 Files 时用 files 兜底，兼容壳里 types 不全的情况） */
function assetDropHasFiles(ev) {
  const dt = ev && ev.dataTransfer;
  if (!dt) return false;
  if (dt.files && dt.files.length) return true;
  return assetDropTypes(ev).indexOf("Files") >= 0;
}
/* 内部拖拽？（行重排 / 侧栏文件拖入画布）—— 外部文件落点必须先让开 */
function assetDropIsInternal(ev, holder) {
  if (holder && Number(holder.dragFrom) >= 0) return true;
  return assetDropTypes(ev).indexOf(ASSET_DROP_INTERNAL) >= 0;
}
/* 从 DataTransfer 里取本机绝对路径（去重；缺桥 = 空数组） */
function assetDropPathsOf(ev) {
  const api = window.api || {};
  if (typeof api.getPathForFile !== "function") return [];
  const dt = ev && ev.dataTransfer;
  if (!dt || !dt.files) return [];
  const out = [];
  for (let i = 0; i < dt.files.length; i++) {
    let p = "";
    try {
      p = String(api.getPathForFile(dt.files[i]) || "");
    } catch (_) {
      p = "";
    }
    if (p && out.indexOf(p) < 0) out.push(p);
  }
  return out;
}

/* 落点提示块（.asset-drop-zone）：常态说「拖入…即可添加」，拖到头上时改说「松开即可添加」 */
function assetDropZoneEl(kind) {
  const z = assetEl("div", "asset-drop-zone");
  z.dataset.idle =
    kind === "new"
      ? I18n.t("将新建素材") + " · " + I18n.t("拖入本机文件 / 文件夹即可添加")
      : I18n.t("拖入本机文件 / 文件夹即可添加");
  z.textContent = z.dataset.idle;
  return z;
}
/* 落点高亮：容器与它里面的提示块一起点亮（提示块文案同时切到「松开即可添加」） */
function assetDropHotSet(el, on) {
  if (!el) return;
  el.classList.toggle("asset-drop-hot", !!on);
  const zones = el.querySelectorAll ? el.querySelectorAll(".asset-drop-zone") : [];
  for (let i = 0; i < zones.length; i++) {
    zones[i].classList.toggle("asset-drop-hot", !!on);
    zones[i].textContent = on
      ? I18n.t("松开即可添加")
      : String(zones[i].dataset.idle || "");
  }
}

/** 给一个落点挂外部文件拖放。el ＝ 落点元素；opts 见本节开头。 */
function assetWireFileDrop(el, opts) {
  if (!el) return false;
  opts = opts || {};
  const api = window.api || {};
  /* 桥不在就不接管：内部拖拽 / 老壳照旧 */
  if (
    typeof api.getPathForFile !== "function" ||
    typeof api.assetsPathKind !== "function"
  )
    return false;
  const holder = opts.holder || null;
  /* 更里层有落点时不接管这一层（否则套娃高亮、外层先吃掉事件） */
  const skipAt = (ev) => {
    if (!opts.skip) return false;
    const t = ev && ev.target;
    return !!(t && t.closest && opts.skip(t));
  };
  const live = (ev) =>
    assetDropHasFiles(ev) && !assetDropIsInternal(ev, holder) && !skipAt(ev);
  el.addEventListener("dragenter", (ev) => {
    if (!live(ev)) return;
    ev.preventDefault();
    assetDropHotSet(el, true);
  });
  el.addEventListener("dragover", (ev) => {
    if (!live(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    assetDropHotSet(el, true);
  });
  el.addEventListener("dragleave", (ev) => {
    /* 移到自己的子元素也算 leave：指针还在里面就不摘高亮 */
    if (ev.relatedTarget && el.contains && el.contains(ev.relatedTarget)) return;
    assetDropHotSet(el, false);
  });
  el.addEventListener("drop", (ev) => {
    assetDropHotSet(el, false);
    if (!live(ev)) return;
    const paths = assetDropPathsOf(ev);
    ev.preventDefault();
    ev.stopPropagation();
    if (!paths.length) return;
    assetDropHandle(paths, opts);
  });
  return true;
}

/* 库右栏此刻的追加目标：详情态＝正在看的那份素材；卡片态＝无目标（落点用来新建素材） */
function assetDropLibTarget() {
  if (ASSET_LIB.mode !== "manage" || !ASSET_LIB.selAssetId) return null;
  return assetSummaryById(ASSET_LIB.selAssetId);
}

/* 一次拖入的总分流：有追加目标＝追加内容条目，否则在指定 / 当前分类下新建素材 */
async function assetDropHandle(paths, opts) {
  if (ASSET_LIB.busy) return; // 写库忙：不重复接管，避免并发写库
  const target = typeof opts.target === "function" ? opts.target() : null;
  if (target && target.id) return assetDropAppend(target, paths);
  let cat = typeof opts.catRel === "function" ? opts.catRel() : opts.catRel;
  if (cat == null) cat = ASSET_LIB.selCat;
  return assetDropNewAsset(paths, String(cat || ""));
}

/* 逐个问主进程「这是文件还是文件夹」（只读判定，不落任何数据） */
async function assetDropPathKinds(paths) {
  const out = [];
  for (const p of paths) {
    let k = { path: p, kind: "", name: "" };
    try {
      const r = await window.api.assetsPathKind(p);
      if (r && r.ok)
        k = { path: p, kind: String(r.kind || ""), name: String(r.name || "") };
    } catch (_) {}
    out.push(k);
  }
  return out;
}
/* 文件名 → 默认素材名（去掉扩展名） */
function assetDropBaseName(n) {
  const s = String(n || "");
  return s.replace(/\.[^./\\]+$/, "") || s;
}

/* 落点①：左树分类行 / 卡片网格空白 / 库框主体 —— 弹命名框，新建一个素材装这批文件 */
async function assetDropNewAsset(paths, catRel) {
  if (ASSET_LIB.busy) return;
  const kinds = await assetDropPathKinds(paths);
  const usable = kinds.filter((k) => k.kind);
  if (!usable.length) {
    toast(
      I18n.t("拖入的内容素材库不收：这里只收文本 / 图像 / 音频 / 视频文件或文件夹"),
      "warn",
    );
    return;
  }
  const first = usable[0];
  const def =
    first.kind === "dir" ? first.name : assetDropBaseName(first.name);
  const v = await assetFormDialog({
    title: I18n.t("将新建素材"),
    okText: I18n.t("创建"),
    fields: [
      {
        key: "name",
        label: I18n.t("显示名称"),
        value: def,
        placeholder: I18n.t("例如：主角人设 / 片头音乐"),
      },
    ],
  });
  if (!v) return;
  const name = String(v.name || "").trim() || def;
  ASSET_LIB.busy = true;
  try {
    let asset = null;
    let added = 0;
    let skipped = 0;
    if (first.kind === "dir") {
      /* 目录整包收进来：复用「上传为新素材」那条 IPC（含命名） */
      const r = await window.api.assetsImportDir({
        srcPath: first.path,
        catRel: catRel,
        displayName: name,
      });
      if (!r || !r.ok) {
        toast(I18n.t("新建素材失败：") + ((r && r.error) || ""), "err");
        return;
      }
      asset = r.asset;
      added = Number(r.found) || 0;
      skipped = Number(r.skipped) || 0;
    } else {
      const r = await window.api.assetsCreate({
        catRel: catRel,
        displayName: name,
      });
      if (!r || !r.ok) {
        toast(I18n.t("新建素材失败：") + ((r && r.error) || ""), "err");
        return;
      }
      asset = r.asset;
    }
    /* 同批其余的：文件逐个追加成内容条目；目录只能一个建一个素材，这里跳过计数 */
    const rest = usable.slice(1);
    const files = rest.filter((k) => k.kind === "file").map((k) => k.path);
    skipped += rest.filter((k) => k.kind === "dir").length;
    if (files.length && asset && asset.id) {
      const r2 = await window.api.assetsImportFiles(asset.id, files);
      if (r2 && r2.ok) {
        added += Number((r2.items && r2.items.length) || 0);
        skipped += Number((r2.skipped && r2.skipped.length) || 0);
        if (r2.asset) asset = r2.asset;
      } else {
        skipped += files.length;
      }
    }
    await assetRescan();
    /* 选择器模式不给切到详情（那里没有「绑定」入口），只把库刷出来 */
    if (asset && asset.id && ASSET_LIB.mode !== "pick") {
      ASSET_LIB.selCat = String(asset.catRel || catRel || "");
      ASSET_LIB.expanded[ASSET_LIB.selCat] = true;
      ASSET_LIB.selAssetId = String(asset.id);
    }
    paintAssetLib();
    const nm = (asset && (asset.displayName || asset.folder)) || name;
    toast(
      skipped
        ? I18n.t("已上传为素材：{name}（内容 {n} 条 · 跳过 {s} 个不支持的文件）", {
            name: nm,
            n: added,
            s: skipped,
          })
        : I18n.t("已上传为素材：{name}（内容 {n} 条）", { name: nm, n: added }),
      "ok",
    );
  } finally {
    ASSET_LIB.busy = false;
  }
}

/* 落点②：左树素材行 / 卡片 / 详情条目列表 / 设置框条目列表 —— 追加成该素材的内容条目 */
async function assetDropAppend(a, paths) {
  const target = assetEditAssetFor(a);
  if (!target || !target.id) return;
  if (ASSET_LIB.busy) return;
  const kinds = await assetDropPathKinds(paths);
  const files = kinds.filter((k) => k.kind === "file").map((k) => k.path);
  const dirs = kinds.filter((k) => k.kind === "dir").length;
  if (!files.length) {
    toast(
      dirs
        ? I18n.t("文件夹请拖到素材库空白处（会新建一个素材）")
        : I18n.t("拖入的内容素材库不收：这里只收文本 / 图像 / 音频 / 视频文件"),
      "warn",
    );
    return;
  }
  ASSET_LIB.busy = true;
  try {
    const r = await window.api.assetsImportFiles(target.id, files);
    if (!r || !r.ok) {
      toast(I18n.t("添加内容失败：") + ((r && r.error) || ""), "err");
      return;
    }
    const added = Number((r.items && r.items.length) || 0);
    const skip = Number((r.skipped && r.skipped.length) || 0) + dirs;
    const nm = target.displayName || target.folder || "";
    await assetEditAfterWrite(
      target,
      r.asset,
      added
        ? skip
          ? I18n.t("已添加 {n} 条内容（{s} 个文件类型素材库不收，已跳过）", {
              n: added,
              s: skip,
            })
          : I18n.t("已添加 {n} 条内容到「{name}」", { n: added, name: nm })
        : I18n.t("没有可添加的文件：素材库只收文本 / 图像 / 音频 / 视频"),
      added ? (skip ? "warn" : "ok") : "warn",
    );
  } finally {
    ASSET_LIB.busy = false;
  }
}

/** 条目行：素材设置框与素材库右栏详情共用（ctx.asset ＝ 本次编辑的素材；
    ctx.holder ＝ 该列表的拖拽状态宿主；ctx.repaint ＝ 拖拽作废后重画该列表）。
    不传 ctx ＝ 素材设置框（编辑目标回落 ASSET_SET 的素材）。 */
function assetSetRow(r, i, n, ctx) {
  ctx = ctx || { asset: null, holder: ASSET_SET, repaint: () => paintAssetSettings() };
  const row = assetEl("div", "asset-set-row");
  row.dataset.i = String(i);
  /* ⠿ 把手：只从把手拖起（标题输入框里的选字不会被误判成整行拖拽） */
  row.appendChild(
    assetWireRowDrag(
      row,
      i,
      ctx.holder,
      ctx.repaint,
      (from, to) => assetSetMoveItem(from, to, ctx.asset),
    ),
  );
  const mkArrow = (up) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini";
    b.textContent = up ? "▲" : "▼";
    b.title = up
      ? I18n.t("上移一条内容（端子序号一并跟着走）")
      : I18n.t("下移一条内容（端子序号一并跟着走）");
    b.disabled = up ? i <= 0 : i >= n - 1;
    b.onclick = (ev) => {
      ev.stopPropagation();
      assetSetMoveItem(i, up ? i - 1 : i + 1, ctx.asset);
    };
    return b;
  };
  row.appendChild(mkArrow(true));
  row.appendChild(mkArrow(false));
  const title = document.createElement("input");
  title.type = "text";
  title.className = "asset-set-title";
  title.value = r.title;
  title.placeholder = I18n.t("内容 ") + (i + 1);
  title.title = I18n.t("端子名（会显示在节点左右两端的端子上）");
  title.addEventListener("change", () => assetSetSetTitle(r, title.value, ctx.asset));
  title.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      title.blur();
    }
  });
  row.appendChild(title);
  const kind = assetEl("span", "asset-set-kind " + r.type, assetItemTypeLabel(r.type));
  kind.title =
    I18n.t("类型") +
    "：" +
    assetItemTypeLabel(r.type) +
    "\n" +
    I18n.t("类型在建立时定下（要换类型请新建一条并删掉这条）");
  row.appendChild(kind);
  const idx = assetEl("span", "asset-set-idx", "⇄ " + (i + 1));
  idx.title =
    I18n.t("第 {n} 个输入端子 ↔ 第 {n} 个输出端子", { n: i + 1 }) +
    "\n" +
    I18n.t("连入只做检查，点端子上的「覆盖」并确认才写入素材库，输出即读出该条内容");
  row.appendChild(idx);
  const file = document.createElement("button");
  file.type = "button";
  file.className =
    "asset-set-file" + (r.missing ? " miss" : "") + (r.absPath ? "" : " none");
  file.textContent = r.file
    ? fileName(r.file) + (r.bytes ? " · " + humanBytes(r.bytes) : "")
    : I18n.t("（还没有内容）");
  file.title = r.missing
    ? I18n.t("库里的实体文件不在了：换一份内容即可恢复") + "\n" + r.absPath
    : r.absPath || I18n.t("库内路径：") + (r.file || "");
  file.onclick = () => {
    if (!r.absPath) return;
    window.api.shellShowItem(r.absPath);
  };
  row.appendChild(file);
  const ed = assetBtn(
    r.type === "text" ? I18n.t("编辑文本") : I18n.t("更换文件"),
    null,
    r.type === "text"
      ? I18n.t("打开正文编辑框（写进素材库该条目的 .txt）")
      : I18n.t("从本机选一个文件复制进来顶掉旧内容（旧内容进版本目录）"),
  );
  ed.onclick = () =>
    r.type === "text"
      ? assetSetEditText(r, ctx.asset)
      : assetItemReplaceFile(assetEditAssetId(ctx.asset), r.id, r.title, r.type);
  row.appendChild(ed);
  /* 图像与文字：除「更换文件 / 编辑文本」外，还能直接预览内容本身
     —— 一行只有一个文件名，看不到图也看不到正文（预览只读，不改库） */
  if (r.type === "image" || r.type === "text") {
    const pv = assetBtn(
      I18n.t("预览"),
      null,
      r.type === "image"
        ? I18n.t("预览这条图像内容（框内看图 · 只读，换图走「更换文件」）")
        : I18n.t("只读预览这条正文（要看全 / 临时看一眼用，改内容走「编辑文本」）"),
    );
    pv.onclick = () => assetPreviewItem(r, ctx.asset);
    row.appendChild(pv);
  }
  if (r.type === "text") {
    /* 文本条目也能直接吃本机文件：与图像 / 音频 / 视频同一颗「更换文件」入口，
       只是主进程按 utf8 收下、恒落 .txt（旧正文进版本目录 · 可撤销） */
    const up = assetBtn(
      I18n.t("上传文件"),
      null,
      I18n.t("从本机选一个文本文件（.txt / .md / .json …）顶掉这条正文（旧内容进版本目录）"),
    );
    up.onclick = () =>
      assetItemReplaceFile(assetEditAssetId(ctx.asset), r.id, r.title, "text");
    row.appendChild(up);
  }
  const rm = assetBtn("✕", "danger", I18n.t("删除这条内容（端子一并消失 · 实体文件进回收站）"));
  rm.onclick = () => assetSetRemoveItem(r, ctx.asset);
  row.appendChild(rm);
  return row;
}

/* ── 写库动作 ─────────────────────────────────────────────────────── */
/** 把当前条目列表按 ids 顺序写成 items:[{id,title}]（同时改标题与顺序） */
function assetSetMetaArg(a, order, titles) {
  return {
    id: a.id,
    items: order.map((it) => ({
      id: it.id,
      title: String((titles && titles[it.id] != null ? titles[it.id] : it.title) || "").trim(),
    })),
  };
}

async function assetSetSaveMeta(displayName, desc) {
  const a = assetSettingsAsset();
  if (!a) return;
  const dn = String(displayName == null ? "" : displayName).trim();
  const ds = String(desc == null ? "" : desc).trim();
  if (dn === String(a.displayName || "") && ds === String(a.desc || "")) return;
  await assetSetBusyRun(async () => {
    const r = await window.api.assetsSaveMeta({
      id: a.id,
      displayName: dn,
      desc: ds,
    });
    if (!r || !r.ok) {
      toast(I18n.t("保存素材资料失败：") + ((r && r.error) || ""), "err");
      return;
    }
    /* 只改名字与描述：端子集没动，节点上的 assetName / assetDesc 由快照同步刷新 */
    await assetAfterLibWrite(r.asset, I18n.t("已保存素材资料"), "ok");
  });
}

async function assetSetSetTitle(r, value, a) {
  a = assetEditAssetFor(a);
  if (!a) return;
  const nv = String(value == null ? "" : value).trim();
  if (!nv || nv === r.title) {
    /* 无效输入 / 没改：把两个可能开着的列表都还原（设置框 · 右栏详情） */
    if (assetSettingsOpen()) paintAssetSettings();
    if (assetLibOpen()) paintAssetLib();
    return;
  }
  const rows = assetSetRows(a);
  const titles = {};
  for (const x of rows) titles[x.id] = x.id === r.id ? nv : x.title;
  await assetSetBusyRun(async () => {
    const res = await window.api.assetsSaveMeta(
      assetSetMetaArg(a, rows, titles),
    );
    if (!res || !res.ok) {
      toast(I18n.t("改内容标题失败：") + ((res && res.error) || ""), "err");
      return;
    }
    await assetEditAfterWrite(
      a,
      res.asset,
      I18n.t("已改端子名：{old} → {now}", { old: r.title, now: nv }),
      "ok",
    );
  });
}

/** 重排：条目顺序走 app.js · assetMoveItem（perm 口径与 fnToolMoveParam 逐字一致：
    把 from 移到 to、中间顺移一格），顺序写进库 → 每个绑定节点的端子号按条目 id 保号
    重映射（线跟着内容走，不漂到别的条目上）。a ＝ 本次编辑的素材（不传＝设置框那份）。 */
async function assetSetMoveItem(from, to, a) {
  a = assetEditAssetFor(a);
  if (!a) return;
  if (typeof assetMoveItem !== "function") return;
  const rows = assetSetRows(a);
  const mv = assetMoveItem(rows, from, to);
  if (!mv) return; // 原地 / 越界：不动库也不动线（与 fnToolMoveParam 同一拒绝口径）
  const next = mv.list;
  await assetSetBusyRun(async () => {
    const r = await window.api.assetsSaveMeta(assetSetMetaArg(a, next));
    if (!r || !r.ok) {
      toast(I18n.t("调整内容顺序失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetEditAfterWrite(
      a,
      r.asset,
      I18n.t("已调整内容顺序：端子与已连数据线随内容移位"),
      "ok",
    );
  });
}

async function assetSetRemoveItem(r, a) {
  a = assetEditAssetFor(a);
  if (!a) return;
  const sure = await confirmDialog(
    I18n.t(
      "删除内容「{name}」？\n\n· 节点上这一对端子会消失，挂在它上面的连线一并断开（Ctrl+Z 可复原节点与连线）\n· 实体文件删进系统回收站（可在资源管理器里还原）",
      { name: r.title },
    ),
    { title: I18n.t("删除内容"), danger: true, okText: I18n.t("删除") },
  );
  if (!sure) return;
  await assetSetBusyRun(async () => {
    const res = await window.api.assetsItemRemove(a.id, r.id);
    if (!res || !res.ok) {
      toast(I18n.t("删除内容失败：") + ((res && res.error) || ""), "err");
      return;
    }
    assetItemViewInvalidate(a.id, r.id);
    await assetEditAfterWrite(
      a,
      res.asset,
      I18n.t("已删除内容：{name}（端子与连线可撤销 · 文件进系统回收站）", {
        name: r.title,
      }),
      "ok",
    );
  });
}

/* 「＋ 文本」：上传本机文本文件 与 手写正文 是并列的两条路（多选的走上传，
   每个文件一条内容；单个想再改改的走表单）。与「＋ 图像 / 音频 / 视频」同一手感。
   host ＝ 工具条，a ＝ 本次编辑的素材（不传＝设置框那份）。 */
function assetSetAddTextBtn(host, a) {
  const b = assetBtn(
    I18n.t("＋ 文本"),
    "primary",
    I18n.t("新建文本内容：可从本机上传文本文件（可多选），也可手写一条空的正文"),
  );
  b.onclick = () => {
    const r = b.getBoundingClientRect();
    assetMenu(Math.max(6, r.left), r.bottom + 4, [
      {
        label: I18n.t("上传本机文本文件…（可多选）"),
        title: I18n.t("选一个 / 多个文本文件复制进素材库，每个文件一条内容"),
        run: () => assetSetAddMedia("text", a),
      },
      {
        label: I18n.t("手写一条空正文…"),
        title: I18n.t(
          "新建一条空白的文本内容（库内落一个 .txt），在表单里写或再上传文件",
        ),
        run: () => assetSetAddText(a),
      },
    ]);
  };
  host.appendChild(b);
}

async function assetSetAddText(a) {
  a = assetEditAssetFor(a);
  if (!a) return;
  const rows = assetSetRows(a);
  const v = await assetFormDialog({
    title: I18n.t("添加文本内容"),
    okText: I18n.t("添加"),
    wide: true,
    rawKeys: ["text"],
    fields: [
      {
        key: "title",
        label: I18n.t("标题（＝端子名）"),
        placeholder: I18n.t("内容 ") + (rows.length + 1),
      },
      {
        key: "text",
        label: I18n.t("正文（可留空，用下方「上传文件…」从本机导入）"),
        multiline: true,
        rows: 12,
        actions: [assetTextUploadFieldAction()],
      },
    ],
  });
  if (!v) return;
  await assetSetBusyRun(async () => {
    const r = await window.api.assetsItemAdd({
      id: a.id,
      type: "text",
      title: v.title || "",
      content: v.text || "",
    });
    if (!r || !r.ok) {
      toast(I18n.t("添加内容失败：") + ((r && r.error) || ""), "err");
      return;
    }
    await assetEditAfterWrite(
      a,
      r.asset,
      I18n.t("已添加内容：{name}（末尾多出一对端子）", {
        name: (r.item && r.item.title) || v.title || "",
      }),
      "ok",
    );
  });
}

async function assetSetAddMedia(type, a) {
  a = assetEditAssetFor(a);
  if (!a) return;
  const f = ASSET_PICK_FILTERS[type] || ASSET_PICK_FILTERS.image;
  const picked = await window.api.fileOpenDialog({
    title: I18n.t("选择要添加的") + assetItemTypeLabel(type) + I18n.t("文件（可多选）"),
    filters: [f],
    multi: true,
  });
  const paths = (picked && picked.paths) || [];
  if (!paths.length && picked && picked.path) paths.push(picked.path);
  if (!paths.length) return;
  await assetSetBusyRun(async () => {
    const r = await window.api.assetsImportFiles(a.id, paths);
    if (!r || !r.ok) {
      toast(I18n.t("添加内容失败：") + ((r && r.error) || ""), "err");
      return;
    }
    const added = Number((r.items && r.items.length) || 0);
    const skip = Number((r.skipped && r.skipped.length) || 0);
    await assetEditAfterWrite(
      a,
      r.asset,
      skip
        ? I18n.t("已添加 {n} 条内容（{s} 个文件类型素材库不收，已跳过）", {
            n: added,
            s: skip,
          })
        : I18n.t("已添加 {n} 条内容", { n: added }),
      added ? "ok" : "warn",
    );
  });
}

/* 条目预览：图像与文本都读库内实体，只读展示（改内容走「更换文件 / 编辑文本」）。
   不走 app.js 的图片灯箱：灯箱 z-index 1400 低于素材库框（2350），在库里点开会压在框底下；
   这里用自己的 .mt-dialog 层（2400），与库 / 设置框同族但更高。 */
async function assetPreviewItem(r, a) {
  a = assetEditAssetFor(a);
  if (!a || !r) return;
  if (!r.absPath) {
    toast(I18n.t("这条内容还没有实体文件"), "warn");
    return;
  }
  if (r.type === "image") {
    assetShowPreviewBox(r.title || fileName(r.absPath), r.absPath, null);
    return;
  }
  if (r.type !== "text") {
    window.api.shellShowItem(r.absPath);
    return;
  }
  let cur = "";
  try {
    const rd = await window.api.assetsItemRead(a.id, r.id);
    if (rd && rd.ok) cur = String(rd.text || "");
    else if (rd && rd.error) {
      toast(I18n.t("读取失败：") + rd.error, "err");
      return;
    }
  } catch (_) {}
  assetShowPreviewBox(r.title || "", null, cur);
}

/* 只读预览框：图（imgPath）或文本（text）二选一。
   persistent（点蒙层不关），Esc 只收这一层（capture ＋ stopPropagation，与 assetFormDialog
   同一口径，不会顺手把底下的素材库 / 设置框也关掉）。 */
function assetShowPreviewBox(title, imgPath, text) {
  const old = document.getElementById("assetPreviewDlg");
  if (old) old.remove();
  const host = document.createElement("div");
  host.id = "assetPreviewDlg";
  host.className = "mt-dialog on";
  const box = assetEl("div", "mt-dialog-box asset-form-box asset-form-box-wide");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const head = assetEl("div", "mt-dialog-head");
  head.appendChild(
    assetEl(
      "b",
      null,
      imgPath
        ? I18n.t("预览图像内容 · {name}", { name: title })
        : I18n.t("预览文本内容 · {name}", { name: title }),
    ),
  );
  const body = assetEl("div", "mt-dialog-body asset-form-body");
  if (imgPath) {
    const img = document.createElement("img");
    img.alt = title;
    img.src = window.api.toFileUrl(imgPath);
    img.title = imgPath;
    img.style.display = "block";
    img.style.maxWidth = "100%";
    img.style.maxHeight = "60vh";
    img.style.margin = "0 auto";
    img.style.objectFit = "contain";
    body.appendChild(img);
  } else {
    const ta = document.createElement("textarea");
    ta.className = "asset-form-input";
    ta.rows = 16;
    ta.readOnly = true;
    ta.spellcheck = false;
    ta.value = String(text == null ? "" : text);
    body.appendChild(ta);
  }
  const foot = assetEl("div", "mt-dialog-foot asset-form-foot");
  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    close();
  };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    host.remove();
  };
  const cl = assetBtn(I18n.t("关闭"), null, null);
  cl.onclick = close;
  foot.appendChild(cl);
  box.append(head, body, foot);
  host.appendChild(box);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(host);
}

async function assetSetEditText(r, a) {
  a = assetEditAssetFor(a);
  if (!a) return;
  let cur = "";
  try {
    const rd = await window.api.assetsItemRead(a.id, r.id);
    if (rd && rd.ok) cur = String(rd.text || "");
    else if (rd && rd.error) cur = "";
  } catch (_) {
    cur = "";
  }
  const v = await assetFormDialog({
    title: I18n.t("编辑文本内容 · {name}", { name: r.title }),
    okText: I18n.t("保存到素材库"),
    wide: true,
    rawKeys: ["text"],
    fields: [
      { key: "title", label: I18n.t("标题（＝端子名）"), value: r.title },
      {
        key: "text",
        label: I18n.t("正文（可留空，用下方「上传文件…」从本机导入）"),
        multiline: true,
        rows: 16,
        value: cur,
        hint: I18n.t("写进素材库该条目的 .txt（旧内容先进版本目录 · 可撤销）"),
        actions: [assetTextUploadFieldAction()],
      },
    ],
  });
  if (!v) return;
  await assetSetBusyRun(async () => {
    /* 正文走 assetWriteItem：与端子同步同一条路（撤销快照 + 库里旧文件一起记账） */
    const r1 = await assetWriteItem(a.id, r.id, { content: v.text }, {
      type: "text",
      title: r.title,
      msg: I18n.t("已保存到素材库：") + (v.title || r.title),
    });
    if (!r1.ok) {
      toast(I18n.t("写入素材库失败：") + (r1.error || ""), "err");
      return;
    }
    /* 标题（＝端子名）单独一步：改标题要顺带同步所有绑定节点的端子快照 */
    const nt = String(v.title || "").trim();
    if (nt && nt !== String(r.title || "").trim()) await assetSetSetTitle(r, nt, a);
  });
}

function paintAssetSetFoot(foot, a) {
  foot.innerHTML = "";
  foot.appendChild(
    assetEl(
      "span",
      "asset-lib-fact",
      I18n.t("内容 ") +
        assetSetRows(a).length +
        " · " +
        assetItemsSummary(a) +
        (a.desc ? " · " + a.desc : ""),
    ),
  );
  foot.appendChild(assetEl("span", "asset-lib-spacer"));
  const cl = assetBtn(I18n.t("关闭"), null, null);
  cl.onclick = () => closeAssetSettings();
  foot.appendChild(cl);
}

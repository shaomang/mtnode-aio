/* 「我的应用」（应用中心第 4 页）· 编辑框 · 删除框的回归（人工跑；也可挂进冒烟）：
     node test/smoke-apps-mine.js
   口径：**真跑真源码**（把 renderer/app-apps.js 跑起来断言行为），源码级卡口只用在
   「必须钉住接线、行为不好造」的那几条（PATCH 路径 / 声明 / keep 指代 / 本机同步）。
   [1] 接线卡口：导航第 4 页、PATCH 元数据语义、删除只删自己分支、截图 {keep:n}、本机同步
       （含「我的应用」这一页现在的形态：owner 发 uid、工具条只剩刷新、空态只说「无应用」）
   [2] appsMineSpecs / appsMineFiltered：字段映射、最近更新在前、搜索（本地筛选）
   [3] appsEditTagsOf / appsOtherBranchesOf：标签解析、派生分支计数
   [4] 卡片只剩一枚作者动作（编辑）；危险色只在删除那枚上（删除在编辑窗底栏）；
       **窗口化渲染不得把 mine 标记丢掉**（曾经丢过：整页自管按钮消失、还多出一枚「下载」）
   [5] openAppEdit 真开一次 + 保存：声明未勾不给保存、PATCH body 形态（keep 指代 / 标签数组 /
       acceptDeclaration）、本机同步的调用参数
   [6] 保存后截图没生效（老服务端静默忽略）必须如实告警，不许假装成功
   [7] 删除框：未输入标题不给删、输入对得上才发 DELETE（只删我这条分支） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) fails++;
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
};
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SRC_APPS = read("renderer/app-apps.js");
/* 去注释版：只给「某字样是否还在代码里」这类源码卡口用（注释里讲历史 / 讲被移除的东西不算实现，
   与 test/smoke-node-settings.js、smoke-tip-ui.js 的 stripComments 同一口径）。 */
const SRC_APPS_CODE = SRC_APPS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SRC_I18N = read("renderer/i18n.js");
const SRC_CSS = read("renderer/css/apps.css");

/* ───────── 最小 DOM（语义对齐真 DOM：on* 句柄赋值即挂监听、setAttribute('id') == element.id） ───────── */
const ON_TYPES = ["click", "error", "keydown", "input", "change", "dragstart", "dragover", "drop", "dragleave", "dragend"];
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    hidden: false,
    className: "",
    textContent: "",
    title: "",
    placeholder: "",
    innerHTML: "",
    value: "",
    maxLength: 0,
    rows: 0,
    type: "",
    draggable: false,
    disabled: false,
    checked: false,
    files: null,
    alt: "",
    src: "",
    attrs: {},
    listeners: {},
    classList: {
      _set: new Set(),
      add(...cs) {
        for (const c of cs) if (c) this._set.add(c);
        el.className = [...this._set].join(" ");
      },
      remove(...cs) {
        for (const c of cs) this._set.delete(c);
        el.className = [...this._set].join(" ");
      },
      contains: (c) => el.classList._set.has(c),
      toggle(c, on) {
        if (on) el.classList.add(c);
        else el.classList.remove(c);
      },
    },
    appendChild(c) {
      c.parentNode = el;
      el.children.push(c);
      return c;
    },
    replaceWith(n) {
      const p = el.parentNode;
      if (!p) return;
      const i = p.children.indexOf(el);
      if (i >= 0) p.children.splice(i, 1, n);
      n.parentNode = p;
    },
    remove() {
      const p = el.parentNode;
      if (!p) return;
      const i = p.children.indexOf(el);
      if (i >= 0) p.children.splice(i, 1);
      el.parentNode = null;
    },
    setAttribute(k, v) {
      if (k === "id") {
        el.attrs.id = String(v);
        return;
      }
      if (k === "draggable") el.draggable = v === true || v === "true";
      el.attrs[k] = String(v);
      if (k === "class") el.classList.add(String(v));
      if (/^on/.test(k)) el.addEventListener(k.slice(2), v);
    },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    removeAttribute(k) {
      delete el.attrs[k];
    },
    addEventListener(type, fn) {
      el.listeners[type] = el.listeners[type] || [];
      el.listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const l = el.listeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 132, height: 74, right: 132, bottom: 74 }),
    querySelector(sel) {
      const all = el.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const want = String(sel || "").trim();
      const walk = (n) => {
        for (const c of n.children) {
          if (matches(c, want)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    dispatch(type, ev) {
      let stopped = false;
      const e = Object.assign(
        {
          type,
          preventDefault() {},
          stopPropagation() {
            stopped = true;
          },
          dataTransfer: { getData: () => "", setData() {}, effectAllowed: "" },
        },
        ev || {},
      );
      let node = el;
      while (node) {
        for (const fn of node.listeners[type] || []) fn(e);
        if (stopped) break;
        node = node.parentNode;
      }
      return e;
    },
  };
  Object.defineProperty(el, "id", {
    get: () => el.attrs.id || "",
    set: (v) => {
      el.attrs.id = String(v);
    },
    configurable: true,
  });
  for (const type of ON_TYPES) {
    Object.defineProperty(el, "on" + type, {
      get: () => (el.listeners[type] || [])[0] || null,
      set(fn) {
        const keep = (el.listeners[type] || []).slice(1);
        el.listeners[type] = typeof fn === "function" ? [fn].concat(keep) : keep;
      },
      configurable: true,
    });
  }
  return el;
}
function classListOf(el) {
  return String((el && el.className) || "").split(/\s+/).filter(Boolean);
}
function matches(el, sel) {
  if (!sel) return false;
  return sel
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => {
      const m = /^([.#]?)([\w-]+)$/.exec(part);
      if (!m) return false;
      if (m[1] === ".") return classListOf(el).includes(m[2]);
      if (m[1] === "#") return el.attrs.id === m[2];
      return el.tagName === m[2].toUpperCase();
    });
}
const REG = Object.create(null);
const document = {
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [], parentNode: null, listeners: {} }),
  body: makeEl("body"),
  getElementById: (id) => REG[String(id)] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};

/* ───────── 真源码加载（带宿主桩：openOverlay / storeRequest / toast / 账户） ───────── */
function loadApps(opts) {
  const o = opts || {};
  const sandbox = {
    window: {},
    document,
    console,
    location: {},
    URL,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  };
  sandbox.window.document = document;
  sandbox.window.setTimeout = setTimeout;
  sandbox.globalThis = sandbox;
  const calls = { store: [], sync: [], toast: [], overlay: [] };
  sandbox.__calls = calls;
  sandbox.toast = (msg, kind) => calls.toast.push({ msg: String(msg), kind: kind || "ok" });
  sandbox.openOverlay = (title, o2) => calls.overlay.push({ title: String(title), opts: o2 || {} });
  sandbox.closeOverlay = () => calls.overlay.push({ closed: true });
  sandbox.confirmDialog = () => Promise.resolve(true);
  sandbox.window.I18n = { t: (s) => String(s), getLocale: () => "zh" };
  sandbox.window.api = {
    storeRequest: (req) => {
      calls.store.push(req);
      const handler = o.onStore || (() => ({ ok: true, data: { items: [], total: 0 } }));
      return Promise.resolve(handler(req));
    },
    appsSyncCloudMeta: (id, meta) => {
      calls.sync.push({ id: id, meta: meta });
      return Promise.resolve(
        o.syncResult || { ok: true, id: id, synced: 1, missing: false, results: [{ dir: "d", kind: "dev", ok: true }] },
      );
    },
  };
  sandbox.window.MTNodeAuth = {
    state: () => ({ signedIn: true, user: o.user || { id: "u-1", username: "tester", nickname: "测试员" } }),
  };
  vm.createContext(sandbox);
  if (typeof o.gridProbe === "function") sandbox.window.__mtnodeGridPaint = o.gridProbe;
  vm.runInContext(SRC_APPS, sandbox);
  vm.runInContext(
    ";globalThis.__spies = { APPS_ST: APPS_ST, APPS_NAV: APPS_NAV, APPS_EDIT: APPS_EDIT, APPS_DEL: APPS_DEL," +
      " appsMineSpecs: appsMineSpecs, appsMineFiltered: appsMineFiltered, appsMineSpecOf: appsMineSpecOf," +
      " appsMineFetchPage: appsMineFetchPage, appsMinePageLoad: appsMinePageLoad, appsMinePageMore: appsMinePageMore," +
      " appsPaintMinePage: appsPaintMinePage," +
      " appsEditTagsOf: appsEditTagsOf, appsOtherBranchesOf: appsOtherBranchesOf," +
      " appsCoverActionsEl: appsCoverActionsEl, appsTileEl: appsTileEl, appsSpecFromMine: appsSpecFromMine," +
      " appsDetailBodyEl: appsDetailBodyEl," +
      " appsEditSyncLocal: appsEditSyncLocal, appsEditPaintFoot: appsEditPaintFoot," +
      " openAppEdit: openAppEdit, closeAppEdit: closeAppEdit, openAppDelete: openAppDelete," +
      " appsDoDelete: appsDoDelete, appsAuthUser: appsAuthUser };",
    sandbox,
  );
  return { spies: sandbox.__spies, sandbox: sandbox, calls: calls };
}
const walkEls = (root) => {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
};
const findBtn = (root, cls) => walkEls(root).find((e) => classListOf(e).includes(cls)) || null;
/* 把微任务队列跑干：桩全是立刻 resolve 的 Promise，setTimeout(0) 之后整条链都该走完 */
const flush = () => new Promise((r) => setTimeout(r, 0));
const APPS_EDIT_CLOSED = (spies) => String(!spies.APPS_EDIT.id);

/* 一条「我上架的」接口条目（字段照 publicApp 的口径） */
function mineItem(patch) {
  return Object.assign(
    {
      id: "sudoku",
      title: "数独",
      description: "经典数独",
      tags: ["游戏"],
      version: "1.1.0",
      latestVersion: "1.2.0",
      versions: [{ version: "1.2.0" }],
      entry: "index.html",
      owner: "tester",
      ownerId: "u-1",
      ownerName: "测试员",
      shots: ["shots/sudoku__u-1/1.png", "shots/sudoku__u-1/2.png"],
      thumb: "icons/sudoku__u-1.png",
      icon: "icons/sudoku__u-1.png",
      updatedAt: 2000,
      branches: [{ ownerId: "u-1" }, { ownerId: "u-2", ownerName: "别人" }],
    },
    patch || {},
  );
}
/* 只吃「我上架的条目」与目录请求的 storeRequest 桩 */
function mineHost(onPatch) {
  return (req) => {
    const p = String(req.path || "");
    if (String(req.method) === "PATCH") return onPatch ? onPatch(req) : { ok: true, data: { item: { shots: [] } } };
    if (p.indexOf("/api/apps?owner=") === 0) return { ok: true, data: { items: [mineItem({})], total: 1, page: 1 } };
    if (p.indexOf("/api/apps/catalog") === 0) return { ok: true, data: { apps: [], source: "api", sourceBase: "http://x" } };
    return { ok: true, data: {} };
  };
}

console.log("[1] 接线卡口：导航第 4 页 / PATCH 元数据 / 只删自己分支 / keep 指代 / 本机同步");
{
  const { spies } = loadApps();
  const navIds = spies.APPS_NAV.map((n) => n[0]);
  ok(navIds.indexOf("mine") >= 0, "左导航有「我的应用」页：" + JSON.stringify(navIds));
  ok(navIds.indexOf("mine") === 1, "它紧跟「应用」页（库 / 开发 在后）：" + navIds.join("/"));
  ok(/appsPaintMinePage\(body, seq\)/.test(SRC_APPS), "appsHubPaint 分发到 appsPaintMinePage");
  ok(/method: "PATCH", path: path, body: body/.test(SRC_APPS), "编辑走 PATCH /api/apps/<id>?owner=<我>");
  ok(/acceptDeclaration: true/.test(SRC_APPS), "保存带 acceptDeclaration:true（服务端强制）");
  ok(/method: "DELETE", path: path/.test(SRC_APPS), "删除走 DELETE /api/apps/<id>?owner=<我>");
  ok(
    /s\.kind === "cloud"[\s\S]{0,80}?prep\.push\(\{ send: \{ keep: Number\(s\.keepIndex\) \|\| 0 \}, sha: "" \}\)/.test(SRC_APPS),
    "截图整批提交：老图用 {keep:n} 指代、新图给 data URL（本轮起还可能是 {sha} 引用）",
  );
  ok(
    /if \(f\.shotsTouched\) \{[\s\S]+?shotsSent = prep\.map\(\(x\) => x\.send\);[\s\S]{0,80}?body\.shotsBase64 = shotsSent;/.test(SRC_APPS),
    "没动过截图就**不带** shotsBase64（服务端按「不传 = 不动」处理）",
  );
  ok(
    /cached \? \{ sha: sha \} : pubStripDataUrlSafe\(one\.dataUrl\)/.test(SRC_APPS),
    "云端已有这张图时只发 {sha} 内容指纹（不重传字节）",
  );
  ok(
    /const shotsFailed =\s*[\s\S]{0,200}?Array\.isArray\(item\.shots\) \? item\.shots\.length : -1\) !== shotsSent\.length/.test(
      SRC_APPS,
    ),
    "保存后校验回执 item.shots 张数：老服务端静默忽略时据此告警",
  );
  ok(/appsSyncCloudMeta\(id, meta\)/.test(SRC_APPS), "保存成功后调 appsSyncCloudMeta 同步本机副本");
  ok(/if \(r\.missing\)/.test(SRC_APPS), "本机没有该应用 → 走 missing 分支单独提示");
  ok(/appsEditTagsOf\(f\.tags\)/.test(SRC_APPS), "标签走 appsEditTagsOf（逗号分隔 → 数组）");
  ok(/declaration: false/.test(SRC_APPS) && /f\.declaration !== true/.test(SRC_APPS), "声明默认未勾、未勾不给保存");
  ok(/openAppDelete\(sid\)/.test(SRC_APPS) && /dom\.del = appsMiniBtn\(appsT\("删除应用（云端彻底删除，不可恢复）"/.test(SRC_APPS),
    "「删除应用（云端彻底删除，不可恢复）」搬进编辑窗底栏（与保存 / 取消同排），上下架那两枚整条移除");
  ok(SRC_APPS.indexOf("appsSetPublished") < 0, "客户端不再有 appsSetPublished（那条可见性开关连函数一起删）");
  /* i18n 与样式：新词条与新类都必须落地（缺了界面上就是中文原样或没样式） */
  ok(SRC_I18N.indexOf('"我的应用": "My apps"') >= 0, "i18n 有「我的应用」词条");
  ok(SRC_I18N.indexOf("编辑：改描述 / 标题 / 图标 / 标签 / 上架截图") >= 0, "i18n 有编辑按钮 tooltip 词条");
  ok(SRC_I18N.indexOf("必须一字不差地输入「") >= 0, "i18n 有删除确认词条");
  ok(SRC_CSS.indexOf(".overlay-box.apps-edit-box") >= 0, "css 有编辑 / 删除对话框尺寸类");
  ok(SRC_CSS.indexOf(".apps-shot") >= 0 && SRC_CSS.indexOf(".apps-ico-danger") >= 0, "css 有截图条与危险色按钮");

  /* 本轮（「我的应用」修复）四条形态卡口 —— 都是「行为已在别处真跑过、只有接线形状容易再掉」的
     那几处，所以在源码级钉住（与上方的 PATCH / {keep:n} 同一口径）。 */
  ok(
    /function appsMineOwnerKey\(/.test(SRC_APPS) && /const me = appsMineOwnerKey\(\);/.test(SRC_APPS),
    "这一页拉云端条目时 owner 发的是 appsMineOwnerKey()（登录账号 uid 优先，拿不到才退账号名）",
  );
  ok(
    SRC_APPS_CODE.indexOf("mineOfflineOnly") < 0 && SRC_APPS_CODE.indexOf("只看已下架") < 0,
    "「只看已下架」整条移除（连状态 APPS_ST.mineOfflineOnly 一起清干净、不留死代码；注释里讲历史不算）",
  );
  /* 空态卡口只扫**这一页的函数体**：去「开发」页 / 去「应用」页看看这两枚按钮在**库页**空态
     是正当入口，全文件扫会把那两处算成违规。 */
  const chunkOf = (src, name) => {
    const at = src.indexOf("function " + name + "(");
    if (at < 0) return "";
    let d = 0;
    for (let k = src.indexOf("{", at); k < src.length; k++) {
      if (src[k] === "{") d++;
      else if (src[k] === "}") {
        d--;
        if (!d) return src.slice(at, k + 1);
      }
    }
    return "";
  };
  const minePaint = chunkOf(SRC_APPS_CODE, "appsPaintMinePage");
  ok(minePaint.length > 200, "切得出 appsPaintMinePage（空态卡口的扫描范围）");
  ok(
    !/去「开发」页|去「应用」页看看/.test(minePaint),
    "这一页的空态不再有两颗向导按钮（库页那两颗不受影响）",
  );
  ok(!/只看已下架/.test(minePaint), "这一页的工具条里也没有「只看已下架」了");
  ok(SRC_APPS.indexOf('appsT("无应用")') >= 0, "空态只有一句「无应用」（拉不到与确实没有都归它）");
  /* 真正建卡的那条路：窗口化渲染（appsVirtualGridMount）建卡时**必须**把 mine 传下去 ——
     漏过一次，整页的编辑 / 删除当场消失、还多出一枚「下载」。这里把「网格拿到了什么
     选项」钉住（行为版见 [2] 的 appsPaintMinePage + 网格探针）。 */
  ok(
    /appsTileEl\(items\[i\], \{ local: !!o\.local, mine: !!o\.mine \}\)/.test(SRC_APPS),
    "窗口化渲染建卡时把 mine 与 local 一起传给 appsTileEl（曾经漏过 mine）",
  );
}

console.log("[2] 列表：字段映射 / 最近更新在前 / 搜索（本地筛选）");
{
  const { spies } = loadApps();
  spies.APPS_ST.minePage = {
    ok: true,
    at: Date.now(),
    page: 1,
    pageSize: 50,
    total: 2,
    items: [
      mineItem({ id: "old", title: "老应用", updatedAt: 1000, tags: ["工具"], description: "算账用" }),
      mineItem({ id: "new", title: "新应用", updatedAt: 5000, tags: ["游戏", "休闲"] }),
    ],
  };
  const specs = spies.appsMineSpecs();
  ok(specs.length === 2, "两条都进列表：" + specs.length);
  ok(specs[0].id === "new", "默认最近更新在前：" + specs.map((s) => s.id).join(","));
  const s = specs[0];
  ok(s.mine === true, "spec 带 mine 标记（卡片与详情窗共用）");
  ok(!("unpublished" in s), "不再消费那个可见性位（两态口径：spec 上没有 unpublished 这个字段）");
  ok(String(s.ownerId) === "u-1", "ownerId 带过来（编辑 / 删除要按它指分支）：" + s.ownerId);
  ok(Array.isArray(s.shots) && s.shots.length === 2, "shots[] 带到 spec（编辑框画现有截图）：" + JSON.stringify(s.shots));
  ok(Number(s.updatedAt) === 5000, "updatedAt 带到 spec（排序用）：" + s.updatedAt);
  ok(Array.isArray(s.branches) && s.branches.length === 2, "branches[] 带到 spec（删除框数派生分支）");
  ok(!!spies.appsMineSpecOf("new"), "appsMineSpecOf 能按 id 取到那一条");
  ok(spies.appsMineSpecOf("nope") === null, "取不到就回 null（调用方提示先刷新，不猜字段）");

  spies.APPS_ST.q = "算账";
  ok(spies.appsMineFiltered(specs).length === 1, "搜索命中描述");
  spies.APPS_ST.q = "休闲";
  ok(spies.appsMineFiltered(specs)[0].id === "new", "搜索命中标签");
  spies.APPS_ST.q = "OLD";
  ok(spies.appsMineFiltered(specs)[0].id === "old", "搜索大小写不敏感、也认 id");
  spies.APPS_ST.q = "";
  ok(spies.appsMineFiltered(specs).length === 2, "清空搜索词 → 两条都回来（标签 / 搜索这一层不受本轮可见性口径影响）");
}

console.log("[2b] 真跑 appsPaintMinePage：网格选项带 mine / 工具条只剩刷新 / 空态只说「无应用」");
/* 这一块要 await（页面里有一次真的取数），所以包成异步 IIFE —— 本文件是 CommonJS，
   顶层不能直接 await（顶层 await 会让 Node 按 ESM 解析，require 当场不可用）。 */
const minePaintProbe = (async () => {
  const paint = async (list, gridProbe) => {
    const host = loadApps({ gridProbe: gridProbe });
    const sp = host.spies;
    sp.APPS_ST.nav = "mine";
    sp.APPS_ST.q = "";
    sp.APPS_ST.minePage = { ok: true, at: Date.now(), page: 1, pageSize: 50, total: list.length, items: list };
    const body = makeEl("div");
    await sp.appsPaintMinePage(body, sp.APPS_ST.seq);
    return { sp: sp, body: body };
  };

  let got = null;
  const one = await paint([mineItem({})], (b, l, o) => {
    got = { list: l, opts: o };
    return null;
  });
  ok(!!got, "一屏卡走的是 APPS_GRID_PAINT（窗口化渲染出口）");
  ok(!!got && !!got.opts && got.opts.mine === true, "网格收到的选项带 mine:true（漏了它卡片就没有作者动作）");
  ok(!!got && got.list.length === 1 && String(got.list[0].id) === "sudoku", "网格收到的那一条就是我上架的应用");
  const barTexts = walkEls(one.body).map((e) => String(e.textContent || ""));
  /* 工具条上的按钮文案：只剩「刷新」。标签筛选片与加载更多都不会在这里出现
     （加载更多只在上游还有下一页时才画）。 */
  ok(barTexts.indexOf("刷新") >= 0, "工具条仍有「刷新」");
  ok(barTexts.indexOf("只看已下架") < 0, "工具条里没有「只看已下架」了");

  /* 空态：一句话 + 刷新 + 页头那句实话；两颗向导按钮一律不在 */
  const empty = await paint([], () => null);
  const emptyTexts = walkEls(empty.body).map((e) => String(e.textContent || ""));
  ok(emptyTexts.indexOf("无应用") >= 0, "没有我的应用 → 空态文案是「无应用」：" + JSON.stringify(emptyTexts));
  ok(emptyTexts.indexOf("刷新") >= 0, "空态仍留有「刷新」这一个重试出口");
  ok(emptyTexts.indexOf("去「开发」页") < 0, "空态没有「去「开发」页」向导按钮");
  ok(emptyTexts.indexOf("去「应用」页看看") < 0, "空态没有「去「应用」页看看」向导按钮");
  ok(
    emptyTexts.indexOf("你还没有上架过应用：在「开发」页打开自己的应用，点「上架」把它传到云端，之后就能在这里管理它。") < 0,
    "那行长引导文案也一并撤掉了",
  );
})();

console.log("[3] 标签解析 / 派生分支计数");
{
  const { spies } = loadApps();
  ok(JSON.stringify(spies.appsEditTagsOf("a, b ，c")) === JSON.stringify(["a", "b", "c"]), "逗号 / 中文逗号都能分，去空白");
  ok(JSON.stringify(spies.appsEditTagsOf("a,a,A")) === JSON.stringify(["a", "A"]), "完全相同的去重（大小写不同算两个）");
  ok(spies.appsEditTagsOf("").length === 0, "空串 → 空数组（服务端按「不写标签」处理）");
  const many = spies.appsEditTagsOf(new Array(20).fill(0).map((_, i) => "t" + i).join(","));
  ok(many.length === 8, "最多 8 个（与服务端 parseTags 同口径）：" + many.length);

  const spec = spies.appsSpecFromMine(mineItem({}));
  const others = spies.appsOtherBranchesOf(spec);
  ok(
    others.length === 1 && String(others[0].ownerId) === "u-2",
    "派生分支 = 除我以外的作者分支：" + JSON.stringify(others.map((x) => x.ownerId)),
  );
  ok(
    spies.appsOtherBranchesOf(spies.appsSpecFromMine(mineItem({ branches: [{ ownerId: "u-1" }] }))).length === 0,
    "只有我一条分支时 → 0",
  );
  ok(
    spies.appsOtherBranchesOf(
      spies.appsSpecFromMine(mineItem({ branches: [{}, { ownerId: "u-2" }, { ownerId: "u-2" }] })),
    ).length === 1,
    "没有 ownerId 的分支不算、重复的作者只算一次",
  );
}

console.log("[4] 卡片作者动作（本轮口径：只留一枚「编辑」）+ 详情里的编辑入口");
{
  const { spies } = loadApps();
  const online = spies.appsSpecFromMine(mineItem({}));
  const row = spies.appsCoverActionsEl(online, { mine: true });
  const btns = row.children;
  ok(btns.length === 1, "卡片上只剩一枚按钮（编辑）：" + btns.length);
  ok(classListOf(btns[0]).includes("apps-ico-edit"), "第 1 枚 = 编辑：" + btns[0].className);
  ok(
    !walkEls(row).some((e) => classListOf(e).includes("apps-ico-danger")),
    "危险动作都不再摆在外侧（删除收进编辑窗，且带危险色）",
  );
  ok(
    !walkEls(row).some((e) => classListOf(e).includes("apps-ico-eye") || classListOf(e).includes("apps-ico-eyeoff")),
    "「上架 / 下架」那两枚眼睛图标整条移除（可见性只有两态，界面上没有开关可画）",
  );
  /* 本轮口径：可见性只剩「在线上 / 彻底删除」两态 —— 卡片上只剩「编辑」；
     旧服务端 / 旧数据若还带着那个可见性位（unpublished），界面上也不该多出任何东西。 */
  const offlineRow = spies.appsCoverActionsEl(spies.appsSpecFromMine(mineItem({ unpublished: true })), { mine: true });
  ok(
    offlineRow.children.length === 1 && classListOf(offlineRow.children[0]).includes("apps-ico-edit"),
    "夹具带 legacy 的 unpublished 标记也一样：只剩编辑那一枚（可见性位在 spec 上根本不存在）",
  );
  ok(
    !("unpublished" in spies.appsSpecFromMine(mineItem({ unpublished: true }))),
    "appsSpecFromMine 不再把那个可见性位搬进 spec（服务端回执里带着也不消费）",
  );
  const catalogRow = spies.appsCoverActionsEl(Object.assign({}, online, { mine: false }), {});
  ok(
    !walkEls(catalogRow).some((e) => classListOf(e).includes("apps-ico-danger")),
    "目录卡（非 mine）不出现删除按钮 —— 不是自己的应用不给删",
  );
  const tile = spies.appsTileEl(online, { mine: true });
  ok(tile.dataset.appMine === "1", "卡片带 data-app-mine 标记（只读验证台与冒烟用）");
  ok(!!tile.onclick, "点卡片本身仍是开详情窗");
  /* 详情正文里也留一份带文案的作者入口（卡片图标在小屏上认不出） */
  const detail = spies.appsDetailBodyEl(online, {});
  const detailTexts = walkEls(detail).map((e) => String(e.textContent || ""));
  ok(detailTexts.indexOf("编辑…") >= 0, "详情正文里有「编辑…」入口：" + JSON.stringify(detailTexts.slice(0, 8)));
  ok(detailTexts.indexOf("删除…") < 0, "详情正文里不再有「删除…」（它搬进编辑窗底栏了）");
  const otherDetail = spies.appsDetailBodyEl(Object.assign({}, online, { mine: false }), {});
  ok(
    walkEls(otherDetail).map((e) => String(e.textContent || "")).indexOf("编辑…") < 0,
    "不是自己的条目：详情里没有编辑入口",
  );
}

const run = async () => {
  /* [2b] 是模块级异步块（它自己真跑了一次本页渲染）：先等它收口，别把它的断言落在最后一行统计之后 */
  await minePaintProbe;
  console.log("[5] 编辑框真开一次：未勾声明不给保存；保存请求形态与本机同步参数");
  {
    let patchSeen = null;
    const { spies, calls } = loadApps({
      onStore: mineHost((req) => {
        patchSeen = req;
        return { ok: true, data: { item: { shots: ["a"] } } };
      }),
    });
    spies.APPS_ST.minePage = { ok: true, at: Date.now(), page: 1, pageSize: 50, total: 1, items: [mineItem({})] };
    REG.overlay = makeEl("div");
    REG.ovBody = makeEl("div");
    REG.ovFoot = makeEl("div");

    ok(spies.openAppEdit("sudoku") === true, "openAppEdit 打开了");
    ok(calls.overlay.length === 1 && /编辑应用/.test(calls.overlay[0].title), "窗口标题带「编辑应用」：" + calls.overlay[0].title);
    ok(calls.overlay[0].opts.persistent === true, "persistent（点外部不关，AGENTS.md 的弹窗纪律）");
    ok(calls.overlay[0].opts.min === true, "保留通用 ✕ 出口（min:true）");
    ok(!!REG.overlay.querySelector || true, "（窗口壳由 openOverlay 负责，这里只桩住它）");

    const inputs = walkEls(REG.ovBody).filter((e) => e.tagName === "INPUT");
    const titleIn = inputs.find((e) => e.type === "text" && e.value === "数独");
    ok(!!titleIn, "标题输入框预填当前标题");
    const decl = inputs.find((e) => e.type === "checkbox");
    ok(!!decl && decl.checked === false, "声明勾选框默认不勾");
    const save = spies.APPS_EDIT.dom.save;
    ok(!!save, "底栏有保存按钮");
    ok(save.disabled === true, "未勾声明 → 保存按钮禁用");
    decl.checked = true;
    decl.dispatch("change");
    ok(save.disabled === false, "勾了声明 → 保存可用");
    titleIn.value = "   ";
    titleIn.dispatch("input");
    ok(save.disabled === true, "标题只剩空白 → 又禁用（标题必填）");
    titleIn.value = "数独（改名后）";
    titleIn.dispatch("input");

    const shotCells = walkEls(REG.ovBody).filter((e) => classListOf(e).includes("apps-shot"));
    ok(shotCells.length === 2, "编辑框画出云端现有的 2 张截图：" + shotCells.length);
    const delShot = findBtn(shotCells[1], "apps-shot-del");
    ok(!!delShot, "每张截图右上角有 ✕");
    delShot.dispatch("click");
    ok(spies.APPS_EDIT.form.shotsTouched === true, "删过截图 → shotsTouched 置位（保存时才会带这个字段）");
    ok(spies.APPS_EDIT.form.shots.length === 1, "删掉后只剩 1 张");

    const before = calls.store.length;
    /* 点保存：appsMiniBtn 的 onclick 是同步包装（不返回 Promise），所以点完把微任务队列跑干
       再断言 —— 底下这一串（PATCH → 重拉列表 / 目录 → 本机同步）全是立刻 resolve 的桩。 */
    save.dispatch("click");
    await flush();
    ok(calls.toast.some((t) => /已保存/.test(t.msg)), "保存成功（云端那条真的当成功了）");
    ok(String(APPS_EDIT_CLOSED(spies)) === "true", "保存后窗口收掉（closeAppEdit → closeOverlay）");
    ok(patchSeen && String(patchSeen.method) === "PATCH", "发出了一次 PATCH");
    ok(/\?owner=u-1$/.test(String(patchSeen.path)), "PATCH 路径点明我这条分支（?owner=）：" + patchSeen.path);
    ok(String(patchSeen.path).indexOf("/api/apps/sudoku") === 0, "PATCH 目标是这个应用：" + patchSeen.path);
    ok(patchSeen.body.acceptDeclaration === true, "body 带 acceptDeclaration:true");
    ok(String(patchSeen.body.title) === "数独（改名后）", "body 带新标题：" + patchSeen.body.title);
    ok(Array.isArray(patchSeen.body.tags) && patchSeen.body.tags[0] === "游戏", "标签以数组发出：" + JSON.stringify(patchSeen.body.tags));
    ok(!("zipBase64" in patchSeen.body) && !("fileBase64" in patchSeen.body), "不带 zip（只改元数据 → 服务端不动版本号）");
    ok(
      JSON.stringify(patchSeen.body.shotsBase64) === JSON.stringify([{ keep: 0 }]),
      "截图整批提交 = [{keep:0}]（删了第 2 张、第 1 张沿用）：" + JSON.stringify(patchSeen.body.shotsBase64),
    );
    ok(typeof patchSeen.body.iconBase64 === "undefined", "没动图标就不带 iconBase64（服务端按「不动」处理）");
    ok(calls.sync.length === 1, "保存成功后调了一次 appsSyncCloudMeta：" + calls.sync.length);
    const sync = calls.sync[0];
    ok(sync.id === "sudoku", "同步的是这个应用：" + sync.id);
    ok(
      String(sync.meta.title) === "数独（改名后）" && "description" in sync.meta && Array.isArray(sync.meta.tags),
      "同步标题 / 描述 / 标签：" + JSON.stringify(sync.meta),
    );
    ok(!("icon" in sync.meta) && !("iconBase64" in sync.meta), "不同步图标（库页封面取云端条目，不写本机文件）");
    const after = calls.store.slice(before);
    ok(
      after.some((r) => String(r.method) === "GET"),
      "保存后重拉列表（界面立刻反映新信息）：" + JSON.stringify(after.map((r) => String(r.method) + " " + String(r.path).slice(0, 40))),
    );
    ok(!calls.toast.some((t) => /截图没生效/.test(t.msg)), "回执张数对得上时**不**误报「截图没生效」");
  }

  console.log("[6] 老服务端静默忽略 shotsBase64：必须如实告警，不许假装成功");
  {
    const { spies, calls } = loadApps({
      onStore: mineHost(() => ({ ok: true, data: { item: { shots: ["a", "b"] } } })), /* 收到 1 张、回执仍是 2 张 = 老服务端 */
    });
    spies.APPS_ST.minePage = { ok: true, at: Date.now(), page: 1, pageSize: 50, total: 1, items: [mineItem({})] };
    REG.ovBody = makeEl("div");
    REG.ovFoot = makeEl("div");
    spies.openAppEdit("sudoku");
    const decl = walkEls(REG.ovBody).filter((e) => e.tagName === "INPUT" && e.type === "checkbox")[0];
    decl.checked = true;
    decl.dispatch("change");
    const delShot = findBtn(walkEls(REG.ovBody).filter((e) => classListOf(e).includes("apps-shot"))[1], "apps-shot-del");
    delShot.dispatch("click");
    spies.APPS_EDIT.dom.save.dispatch("click");
    await flush();
    ok(calls.toast.some((t) => /截图没生效/.test(t.msg)), "必须出现「截图没生效：云端服务端需要升级后生效」的告警");
    ok(calls.toast.some((t) => /已保存/.test(t.msg)), "同时照旧提示已保存（不把成功说成失败）");
  }

  console.log("[7] 删除框：输入标题对得上才发 DELETE（只删我这条分支）");
  {
    let delReq = null;
    const host = loadApps({
      onStore: (req) => {
        if (String(req.method) === "DELETE") {
          delReq = req;
          return { ok: true, data: { branches: [] } };
        }
        return mineHost(null)(req);
      },
    });
    host.spies.APPS_ST.minePage = { ok: true, at: Date.now(), page: 1, pageSize: 50, total: 1, items: [mineItem({})] };
    REG.ovBody = makeEl("div");
    REG.ovFoot = makeEl("div");
    ok(host.spies.openAppDelete("sudoku") === true, "openAppDelete 打开了");
    ok(/删除应用/.test(host.calls.overlay[0].title), "窗口标题带「删除应用」：" + host.calls.overlay[0].title);
    const texts = walkEls(REG.ovBody).map((e) => e.textContent);
    ok(
      texts.some((t) => /另有 1 位作者的派生分支会保留/.test(String(t))),
      "确认框写明「另有 1 位作者的派生分支会保留」：" + JSON.stringify(texts.filter(Boolean)),
    );
    ok(
      texts.some((t) => /本机已下载的副本不会被删除|本机没有下载过这个应用/.test(String(t))),
      "确认框写明本机副本不受影响",
    );
    ok(texts.some((t) => /不可恢复/.test(String(t))), "确认框写明不可恢复");
    const delBtn = host.spies.APPS_DEL.dom.del;
    ok(delBtn.disabled === true, "没输入标题 → 删除按钮禁用");
    const inp = host.spies.APPS_DEL.dom.input;
    inp.value = "数独x";
    inp.dispatch("input");
    ok(delBtn.disabled === true, "输错标题 → 仍禁用");
    inp.value = "数独";
    inp.dispatch("input");
    ok(delBtn.disabled === false, "一字不差 → 删除可用");
    delBtn.dispatch("click");
    await flush();
    ok(delReq && String(delReq.method) === "DELETE", "发出了一次 DELETE");
    ok(/\?owner=u-1$/.test(String(delReq.path)), "只删我这条分支（?owner=u-1）：" + delReq.path);
    ok(!delReq.body, "DELETE 不带 body（服务端按 ?owner= 定位分支）");
    ok(host.calls.toast.some((t) => /已删除/.test(t.msg)), "如实提示已删除");
  }

  console.log("[8] 分页：拉取 URL 形态 + 「加载更多」把下一页并进列表（同 id 去重）");
  {
    const seen = [];
    const host = loadApps({
      onStore: (req) => {
        seen.push(String(req.path));
        const p = String(req.path || "");
        if (p.indexOf("/api/apps?owner=") === 0) {
          const page = /[?&]page=(\d+)/.exec(p);
          const n = page ? Number(page[1]) : 1;
          if (n === 1) return { ok: true, data: { items: [mineItem({ id: "a" })], total: 2, page: 1 } };
          return { ok: true, data: { items: [mineItem({ id: "b" }), mineItem({ id: "a" })], total: 2, page: 2 } };
        }
        return { ok: true, data: {} };
      },
    });
    const first = await host.spies.appsMinePageLoad(true);
    ok(!!first && first.ok === true, "第 1 页拉到了");
    ok(host.spies.APPS_ST.minePage.items.length === 1, "第 1 页 1 条：");
    const url = seen[0] || "";
    ok(/\?owner=u-1/.test(url), "带 owner=<登录账号 uid>（uid 是身份；账号名可改）：" + url);
    ok(!/includeUnpublished=1/.test(url), "不再带 includeUnpublished=1（作者看自己那条只靠 owner 过滤）：" + url);
    ok(/pageSize=50/.test(url), "带 pageSize=50（接口上限）：" + url);
    const more = await host.spies.appsMinePageMore();
    ok(more === true, "「加载更多」拉到下一页");
    ok(/[?&]page=2/.test(seen[seen.length - 1] || ""), "第 2 次请求 page=2：" + seen[seen.length - 1]);
    ok(host.spies.APPS_ST.minePage.items.length === 2, "两条并进列表：" + host.spies.APPS_ST.minePage.items.length);
    ok(
      host.spies.APPS_ST.minePage.items.filter((x) => x.id === "a").length === 1,
      "同 id 不重复（接口分页有重叠时按 id 去重）",
    );
    ok(!!host.spies.APPS_ST.mine.byId["a"] && !!host.spies.APPS_ST.mine.byId["b"], "归并表跟着刷新（应用页的 mine 标记同源）");
    ok((await host.spies.appsMinePageMore()) === false, "已经拉满 total → 不再发请求");
  }

  console.log("[9] owner 身份：uid 优先，拿不到 uid 才退账号名（别把这一页拉空）");
  {
    /* ① 老登录态快照 / 上游只给账号名：退回账号名，照旧能拉到自己的条目 */
    const noUid = loadApps({ user: { username: "tester", nickname: "测试员" } });
    const seenNoUid = [];
    noUid.sandbox.window.api.storeRequest = (req) => {
      seenNoUid.push(String(req.path));
      return Promise.resolve({ ok: true, data: { items: [], total: 0, page: 1 } });
    };
    await noUid.spies.appsMinePageLoad(true);
    ok(/\?owner=tester/.test(seenNoUid[0] || ""), "没有 uid → 退账号名 tester：" + seenNoUid[0]);

    /* ② 有 uid：一律发 uid（用户名改过也拉得到） */
    const withUid = loadApps({ user: { id: "u-9", username: "renamed", nickname: "改过名" } });
    const seenUid = [];
    withUid.sandbox.window.api.storeRequest = (req) => {
      seenUid.push(String(req.path));
      return Promise.resolve({ ok: true, data: { items: [], total: 0, page: 1 } });
    };
    await withUid.spies.appsMinePageLoad(true);
    ok(/\?owner=u-9/.test(seenUid[0] || ""), "有 uid → 发 uid，不发账号名：" + seenUid[0]);
    ok(!/owner=renamed/.test(seenUid[0] || ""), "账号名不再进 owner 参数");
  }

  console.log(fails ? "\nFAIL " + fails + " 项" : "\nALL PASS");
  process.exit(fails ? 1 : 0);
};
run().catch((e) => {
  console.log("  FAIL 冒烟自身异常：" + ((e && e.stack) || e));
  process.exit(1);
});

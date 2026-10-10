/* 封面卡与本轮打赏条改动的**真跑**回归（人工跑；也可挂进冒烟）：
     node test/apps-cover-unit.js
   口径（都是「会真炸」的那几条，不靠正则看源码，而是把真源码跑起来断言行为）：
     [1] MtTips.detailRecordEl：一次都没打赏 / 数据没取到 → null（整行不画）；
         有数字 → 一行「打赏记录 + 币数」，**整行不挂任何 click**（详情里不能再有第二个打赏入口）。
     [2] appsThumbUrlOf：urls.thumb 优先；目录下发的 thumb（封面源＝上架截图第 1 张，名字带 __shot）；
         静态目录从 icon 推导同主干 .png；接口地址换成 /thumb；
         data: 与没图标一律回空串（调用方退回原图）。
     [3] appsCoverEl：缩略图 404 → 退回原图一次（data-fallback）；原图也 404 → 收起 img + .noimg
         兜底底色（封面不破图、标题仍在）。
     [4] appsCoverActionsEl：未装 = 下载（ⓘ 早已摘掉，打赏本轮也搬进详情 → 卡上不再有金币）；
         库页 = 运行(play)；点图标**不冒泡**（卡片主点击 = 开详情，不能被图标连带触发）。
     [5] appsTileEl：点卡片 → openAppsDetail(id)；卡片 role=button。
   这里只造它们真正用到的最小 DOM —— 但**语义要对齐真 DOM**（on* 句柄赋值即挂监听、
   element.id 与 setAttribute("id") 等价），否则量到的是假现场。 */
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

/* ───────── 最小 DOM（语义对齐真 DOM 的那几处） ───────── */
const ON_TYPES = ["click", "error", "keydown", "input", "change"];
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
    innerHTML: "",
    attrs: {},
    listeners: {},
    classList: {
      _set: new Set(),
      add(...cs) {
        for (const c of cs) this._set.add(c);
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
      el.attrs[k] = String(v);
      if (k === "class") el.classList.add(String(v));
      if (/^on/.test(k)) el.addEventListener(k.slice(2), v);
    },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    addEventListener(type, fn) {
      el.listeners[type] = el.listeners[type] || [];
      el.listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const l = el.listeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
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
    /** 派发事件：顺着 parentNode 冒泡，stopPropagation 就停（与真 DOM 同） */
    dispatch(type, ev) {
      let stopped = false;
      const e = Object.assign({ type, preventDefault() {}, stopPropagation() { stopped = true; } }, ev || {});
      let node = el;
      while (node) {
        for (const fn of node.listeners[type] || []) fn(e);
        if (stopped) break;
        node = node.parentNode;
      }
      return e;
    },
  };
  /* id 与 on* 句柄：真 DOM 里直接赋值就生效，冒烟里也必须这样 */
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
  return String(el.className || "").split(/\s+/).filter(Boolean);
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
const document = {
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [], parentNode: null, listeners: {} }),
  body: makeEl("body"),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};

/* 自检：迷你 DOM 的 on* 句柄语义必须与真 DOM 一致（否则后面量到的是假现场） */
{
  const b = makeEl("button");
  let n = 0;
  b.onclick = () => n++;
  b.dispatch("click");
  ok(n === 1, "[0] 迷你 DOM：onclick 赋值即挂监听（触发 " + n + " 次）");
  const c = makeEl("button");
  c.setAttribute("id", "x1");
  ok(c.id === "x1", "[0] 迷你 DOM：setAttribute('id') 与 element.id 等价");
}

/* ───────── 真源码加载 ───────── */
function baseSandbox() {
  const sandbox = {
    window: {},
    document,
    console,
    location: {},
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  };
  sandbox.window.document = document;
  sandbox.window.setTimeout = setTimeout;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}
function loadTips() {
  const sandbox = baseSandbox();
  sandbox.window.MtCoin = { coinsOfYuan: (y) => Number(y || 0) * 50, coinNumText: (n) => String(n) };
  vm.runInContext(read("renderer/app-tips.js"), sandbox);
  return sandbox.window.MtTips;
}
function loadApps() {
  const sandbox = baseSandbox();
  sandbox.window.clampAppsColsW = () => {};
  vm.runInContext(read("renderer/app-apps.js"), sandbox);
  vm.runInContext(
    ";globalThis.__spies = { appsThumbUrlOf: appsThumbUrlOf, appsCoverEl: appsCoverEl, appsCoverCandidatesOf: appsCoverCandidatesOf, appsCoverIsShot: appsCoverIsShot, appsCoverActionsEl: appsCoverActionsEl, appsTipBtnEl: appsTipBtnEl, appsDetailBodyEl: appsDetailBodyEl, appsTileEl: appsTileEl, appsIconUrl: appsIconUrl, appsUrlWithToken: appsUrlWithToken, appsLocalCoverOf: appsLocalCoverOf, appsSpecPatchStoreUrls: appsSpecPatchStoreUrls, setCat: function (c) { APPS_ST.cat = c; } };",
    sandbox,
  );
  return { spies: sandbox.__spies, sandbox };
}
const textsOf = (root) => {
  const out = [];
  const walk = (n) => {
    if (n.textContent) out.push(n.textContent);
    for (const c of n.children || []) walk(c);
  };
  walk(root);
  return out;
};

console.log("[1] detailRecordEl：0 / 缺数据整行不画，有数字只画一行只读记录");
{
  const T = loadTips();
  ok(typeof T.detailRecordEl === "function", "MtTips.detailRecordEl 已导出");
  ok(T.detailRecordEl({ kind: "app", id: "x" }, null) === null, "没取到汇总（null）→ 回 null");
  ok(T.detailRecordEl({ kind: "app", id: "x" }, { count: 0, totalYuan: 0 }) === null, "一次都没打赏（count 0）→ 回 null");
  const row = T.detailRecordEl({ kind: "app", id: "x" }, { count: 3, totalYuan: 120 });
  ok(!!row, "有打赏 → 画一行");
  ok(
    classListOf(row).includes("apps-detail-tipbar") && classListOf(row).includes("tip-record"),
    "行样式 = apps-detail-tipbar tip-record：" + row.className,
  );
  const texts = textsOf(row);
  ok(texts.includes("打赏记录"), "行里有「打赏记录」标签：" + JSON.stringify(texts));
  ok(texts.some((t) => /6000/.test(t)), "行里有币数（120 元 → 6000 鲸圆币）：" + JSON.stringify(texts));
  ok(!row.listeners.click || row.listeners.click.length === 0, "整行**不挂 click**（不可点）");
  ok(!classListOf(row).includes("clickable"), "整行不带 clickable 类");
  ok(/累计打赏/.test(row.title || ""), "悬停文案是累计总次数：" + row.title);
  ok(!row.onclick, "整行没有 onclick（点它什么都不发生）");
}

console.log("[2] appsThumbUrlOf：thumb 优先 / 静态推导 / 接口换路径 / 空值回空串");
{
  const { spies } = loadApps();
  const FEED = "https://mt-agent.com/mtnode/apps";
  ok(spies.appsThumbUrlOf({ urls: { thumb: FEED + "/api/apps/x/thumb" } }) === FEED + "/api/apps/x/thumb", "urls.thumb 优先");
  ok(
    spies.appsThumbUrlOf({ icon: "icons/sudoku__u_1.png", urls: { icon: FEED + "/icons/sudoku__u_1.png" } }) ===
      FEED + "/icons/sudoku__u_1.png",
    "静态目录：icon 已是 .png → 推导结果就是它本身",
  );
  ok(
    spies.appsThumbUrlOf({ icon: "icons/a__u1.jpg", urls: { icon: FEED + "/icons/a__u1.jpg" } }) === FEED + "/icons/a__u1.png",
    "静态目录：icon 是 .jpg → 换成同主干 .png（服务端发布的缩略图落点）",
  );
  ok(
    spies.appsThumbUrlOf({ icon: "icons/a.png", urls: { icon: "https://s.example/api/apps/a/icon?owner=u1" } }) ===
      "https://s.example/api/apps/a/thumb?owner=u1",
    "接口来源：/icon?owner=… → /thumb?owner=…（带上 owner）",
  );
  ok(spies.appsThumbUrlOf({ icon: "data:image/png;base64,AAA" }) === "", "data: 图（没有独立缩略图）→ 空串");
  ok(spies.appsThumbUrlOf({}) === "" && spies.appsThumbUrlOf(null) === "", "没图标 → 空串");
}

console.log("[2b] 封面源 = 上架截图第 1 张（本轮修的 bug：截图传了却不当封面）");
{
  const { spies, sandbox } = loadApps();
  const FEED = "https://mt-agent.com/mtnode/apps";
  /* 静态目录：服务端下发 thumb = icons/<主干>__shot.png（__shot = 封面源是截图）+ coverSource */
  const staticShot = {
    id: "a",
    icon: "icons/a__u1.jpg",
    thumb: "icons/a__u1__shot.png",
    coverSource: "shot",
    coverVer: "1791474846",
    shots: ["shots/a__u1/1.png", "shots/a__u1/2.png"],
    source: "static",
    urls: { icon: FEED + "/icons/a__u1.jpg" },
  };
  ok(spies.appsCoverIsShot(staticShot) === true, "coverSource=shot → 认得出封面源是截图");
  ok(spies.appsCoverIsShot({ id: "a" }) === false, "老条目没有 coverSource → 不算截图（行为不变）");
  ok(
    spies.appsThumbUrlOf(staticShot) === FEED + "/icons/a__u1__shot.png",
    "静态目录：用服务端下发的 __shot 缩略图，不再按 icon 推同名 .png：" + spies.appsThumbUrlOf(staticShot),
  );
  spies.setCat({ source: "static", sourceBase: FEED });
  const chain = spies.appsCoverCandidatesOf(staticShot);
  ok(chain[0] === FEED + "/icons/a__u1__shot.png", "备选链第 1 张 = 截图那条缩略图：" + chain[0]);
  ok(chain.indexOf(FEED + "/icons/a__u1.png") > 0, "备选链里还有另一条缩略图（退到图标那条 16:9 图）");
  ok(chain.indexOf(FEED + "/shots/a__u1/1.png") > chain.indexOf(FEED + "/icons/a__u1.png"), "封面源原图（第 1 张截图）排在图标原图之前");  ok(chain[chain.length - 1] === FEED + "/icons/a__u1.jpg", "最后一张才是图标原图（图标不当封面，只兜底）：" + chain[chain.length - 1]);
  /* 卡片：缩略图 404 时必须退到**那张截图**的图，而不是一头退到图标（用户报的正是这个） */
  const card = spies.appsCoverEl(staticShot, "演示应用", { withText: true });
  const cimg = card.querySelector(".apps-cover-img");
  ok(cimg.dataset.coverSource === "shot", "封面上标着 coverSource=shot（排查用）");
  cimg.dispatch("error");
  const second = String(cimg.src || "");
  ok(/\/icons\/a__u1\.png|\/shots\/a__u1\/1\.png/.test(second), "截图缩略图 404 → 退到同源的另一张（不是直接没图）：" + second);
  /* 接口目录：只有一条 /thumb（服务端自己决定源），封面源仍是截图 */
  const apiShot = {
    id: "a",
    icon: "icons/a__u1.png",
    thumb: "icons/a__u1__shot.png",
    coverSource: "shot",
    shots: ["shots/a__u1/1.png"],
    source: "api",
    urls: { icon: "https://s.example/api/apps/a/icon?owner=u1", thumb: "https://s.example/api/apps/a/thumb?owner=u1" },
  };
  spies.setCat({ source: "api", sourceBase: "https://s.example" });
  const apiChain = spies.appsCoverCandidatesOf(apiShot);
  ok(apiChain[0] === "https://s.example/api/apps/a/thumb?owner=u1", "接口目录第 1 张 = /thumb（服务端按截图现生成）：" + apiChain[0]);
  ok(apiChain.indexOf("https://s.example/api/apps/a/shots/1") > 0, "退路里有第 1 张截图本身（封面源丢了也有图）");
  /* 目录里没有 thumb 字段的老条目（老服务端）：仍按 icon 推导，行为与改动前一致 */
  spies.setCat({ source: "static", sourceBase: FEED });
  ok(
    spies.appsThumbUrlOf({ id: "a", icon: "icons/a__u1.jpg", urls: { icon: FEED + "/icons/a__u1.jpg" } }) === FEED + "/icons/a__u1.png",
    "老条目（没 thumb / 没 coverSource）→ 仍按 icon 推同主干 .png",
  );
}

console.log("[2c] appsSpecPatchStoreUrls：接口来源的相对 thumb → /api/apps/<id>/thumb（不再直拼 404 地址）");
{
  const { spies } = loadApps();
  const API = "https://www.mt-agent.com/mtnode/store-api";
  const FEED = "https://mt-agent.com/mtnode/apps";
  /* ① 接口目录：服务端下发的 thumb 是**静态目录的相对写法**，接口侧没有 icons/ 这条静态路由
     （线上实测 …/store-api/icons/<主干>__shot.png = 404）→ 必须换成接口的 /thumb。 */
  spies.setCat({ source: "api", sourceBase: API, sourceUrl: API + "/api/apps/catalog" });
  const apiSpec = spies.appsSpecPatchStoreUrls({ id: "a", icon: "icons/a__u1.webp", thumb: "icons/a__u1__shot.png" });
  ok(apiSpec.urls.icon === API + "/api/apps/a/icon", "接口来源：图标走 /api/apps/<id>/icon");
  ok(
    apiSpec.urls.thumb === API + "/api/apps/a/thumb",
    "接口来源：封面缩略图走 /api/apps/<id>/thumb（不是 store-api/icons/…）：" + apiSpec.urls.thumb,
  );
  /* ② 缓存是从**静态目录**写下的（source=cache 但基址是静态目录）：相对写法直拼才对 ——
     只看 source === "cache" 就换成接口路由，会把本来能用的封面换成 404。 */
  spies.setCat({ source: "cache", sourceBase: FEED, sourceUrl: FEED + "/catalog.json" });
  const cachedStatic = spies.appsSpecPatchStoreUrls({ id: "a", icon: "icons/a__u1.webp", thumb: "icons/a__u1__shot.png" });
  ok(
    cachedStatic.urls.thumb === FEED + "/icons/a__u1__shot.png",
    "缓存来自静态目录：相对 thumb 仍直拼静态基址：" + cachedStatic.urls.thumb,
  );
  /* ③ 老服务端没有 thumb 字段：仍按 icon 推一条 /thumb（行为与改动前一致） */
  spies.setCat({ source: "api", sourceBase: API, sourceUrl: API + "/api/apps/catalog" });
  const legacy = spies.appsSpecPatchStoreUrls({ id: "a", icon: "icons/a__u1.webp" });
  ok(legacy.urls.thumb === API + "/api/apps/a/thumb", "老服务端（没 thumb）→ 按 icon 推 /thumb：" + legacy.urls.thumb);
  /* ④ 目录里给了绝对地址就原样用（防投毒口径由主进程负责，渲染层不改写绝对地址） */
  const abs = spies.appsSpecPatchStoreUrls({ id: "a", icon: "icons/a__u1.webp", thumb: "https://cdn.example/x.png" });
  ok(abs.urls.thumb === "https://cdn.example/x.png", "绝对 thumb 原样保留：" + abs.urls.thumb);
}

console.log("[3] appsCoverEl：缩略图 404 → 退回原图 → 再 404 收图 + 兜底底色");{
  const { spies } = loadApps();
  const FEED = "https://mt-agent.com/mtnode/apps";
  const cover = spies.appsCoverEl({ id: "a", icon: "icons/a.jpg", urls: { icon: FEED + "/icons/a.jpg" } }, "演示应用", {
    withText: true,
  });
  const img = cover.querySelector(".apps-cover-img");
  ok(!!img, "有图标 → 画了背景图元素");
  ok(img.src === FEED + "/icons/a.png", "背景图先取缩略图（.png）：" + img.src);
  ok(!!cover.querySelector(".apps-cover-shade") && !!cover.querySelector(".apps-cover-name"), "带底部渐变 + 标题层");
  ok(cover.querySelector(".apps-cover-name").textContent === "演示应用", "标题层写的是应用名");
  img.dispatch("error");
  ok(img.src === FEED + "/icons/a.jpg" && img.dataset.fallback === "1", "缩略图 404 → 退回原图一次：" + img.src);
  ok(img.hidden === false, "退回原图时图还在");
  img.dispatch("error");
  ok(img.hidden === true && classListOf(cover).includes("noimg"), "原图也 404 → 收图 + .noimg 兜底底色");
  ok(cover.querySelector(".apps-cover-fb") !== null, "兜底底色层仍在（标题照常可读）");
  const noIcon = spies.appsCoverEl({ id: "b" }, "没图的应用", { withText: true });
  ok(noIcon.querySelector(".apps-cover-img") === null && classListOf(noIcon).includes("noimg"), "压根没图标 → 直接兜底底色");
}

console.log("[4] appsCoverActionsEl：卡上只留该有的那几枚图标，且都不冒泡");
{
  const { spies, sandbox } = loadApps();
  sandbox.window.MtTips = { coinIcon: () => makeEl("span") };
  const mk = (over) => spies.appsCoverActionsEl(Object.assign({ id: "a", title: "A" }, over), {});
  const notInstalled = mk({});
  let btns = notInstalled.children.filter((c) => c.tagName === "BUTTON");
  ok(btns.length === 1, "未装 + 未上架云端 → 一枚（下载）：ⓘ 本轮已摘掉，实际 " + btns.length);
  ok(
    classListOf(btns[0]).includes("apps-ico-download"),
    "只剩下载那一枚：" + btns.map((b) => b.className).join(" | "),
  );
  ok(/<svg/.test(String(btns[0].innerHTML || "")), "下载那颗的内联 SVG 直接在按钮里（不是套一层 span）");
  const cloud = mk({ ownerId: "u1" });
  btns = cloud.children.filter((c) => c.tagName === "BUTTON");
  /* 本轮需求：卡片封面右下角不再有打赏按钮（上架到云端也一样只有下载那一枚） */
  ok(btns.length === 1 && !cloud.querySelector(".apps-ico-coin"), "上架到云端也不再有金币打赏那一枚（本轮搬到详情里）");
  ok(!cloud.querySelector(".apps-ico-info"), "上架到云端的卡片上也没有 ⓘ（点卡片本身就开详情窗）");
  const localRow = spies.appsCoverActionsEl({ id: "a", title: "A" }, { local: true });
  btns = localRow.children.filter((c) => c.tagName === "BUTTON");
  ok(btns.length === 1 && classListOf(btns[0]).includes("apps-ico-play"), "库页：只剩运行（play）");
  ok(
    !localRow.querySelector(".apps-ico-info"),
    "库页封面上的 ⓘ 也摘掉了（点卡片就是开详情窗）",
  );
  ok(
    btns[0].dataset.appRun === "1" && btns[0].id === "appsRunBtn-a",
    "运行那颗带 data-app-run + 稳定 id（打开态回贴靠它）：" + btns[0].id,
  );
  let cardClicks = 0;
  const card = makeEl("div");
  card.addEventListener("click", () => cardClicks++);
  card.appendChild(btns[0]);
  btns[0].dispatch("click");
  ok(cardClicks === 0, "点图标不冒泡到卡片（不会连带打开详情）");
}

console.log("[5] appsTileEl：点卡片开详情；点图标各自做自己的事（不冒泡）");
{
  const { spies, sandbox } = loadApps();
  const opened = [];
  sandbox.window.openAppsDetail = (id) => {
    opened.push(id);
    return true;
  };
  const picks = [];
  sandbox.window.openAppsVersionDlg = (id) => {
    picks.push(id);
    return true;
  };
  /* app-apps.js 里对它是**同文件裸调用**（openAppsVersionDlg(...)）：沙箱的全局对象是 sandbox
     本身（sandbox.window 只是它的一个属性），所以 spy 要挂两份才被裸标识符取到。 */
  sandbox.openAppsVersionDlg = sandbox.window.openAppsVersionDlg;
  sandbox.window.MtTips = { coinIcon: () => makeEl("span"), open: () => {} };
  const card = spies.appsTileEl({ id: "sudoku", title: "数独", icon: "icons/s.png", ownerId: "u1" }, {});
  ok(card.attrs.role === "button", "卡片带 role=button（可键盘触发）");
  card.dispatch("click");
  ok(opened.length === 1 && opened[0] === "sudoku", "点卡片 → openAppsDetail(id)");
  const acts = card.querySelector(".apps-cover-acts");
  ok(!!acts, "卡片上有封面右下角那一排图标");
  /* ⓘ 本轮已摘掉（点卡片即开详情），打赏那枚也搬进详情了，所以这里拿下载那一枚
     验「图标各做各的事、不冒泡」（它按设计点了就是开「分支 / 版本」跳窗）。 */
  ok(!acts.querySelector(".apps-ico-info"), "封面动作排里没有 ⓘ 了（用途与点卡片重复）");
  ok(!acts.querySelector(".apps-ico-coin"), "封面动作排里也没有金币打赏了（本轮搬进详情打赏条）");
  const dl = acts.querySelector(".apps-ico-download");
  if (dl) {
    /* 本轮口径（需求 4）：卡片上的「下载 / 其他版本」**直接开「分支 / 版本」跳窗**
       （appsOpenDetailForPick → openAppsVersionDlg），不再先开详情窗。 */
    const n0 = opened.length;
    const p0 = picks.length;
    dl.dispatch("click");
    ok(
      picks.length === p0 + 1 && picks[picks.length - 1] === "sudoku" && opened.length === n0,
      "点下载 → 直接开「分支 / 版本」跳窗一次（不再先开详情，也不是静默下载）",
    );
  }
}

console.log("[6] 详情头部封面：缓存令牌（新图立刻可见）+ 本机已装封面兜底");
{
  const { spies, sandbox } = loadApps();
  const STORE = "https://s.example";
  /* 缓存令牌：?v= 用该条目的最新版本号（版本变了图必然是新上传的那张） */
  ok(
    spies.appsUrlWithToken(STORE + "/api/apps/a/thumb?owner=u1", { latestVersion: "1.2.0" }) ===
      STORE + "/api/apps/a/thumb?owner=u1&v=1.2.0",
    "拼上 ?v=<最新版本号>（保留原有查询串）",
  );
  ok(spies.appsUrlWithToken(STORE + "/api/apps/a/icon?owner=u1", { version: "1.0.0" }) === STORE + "/api/apps/a/icon?owner=u1&v=1.0.0", "没有 latestVersion 就用 version");
  ok(spies.appsUrlWithToken(STORE + "/api/apps/a/thumb?v=9", { latestVersion: "1.2.0" }) === STORE + "/api/apps/a/thumb?v=9", "已经有 v= 就不再动它（幂等）");
  ok(spies.appsUrlWithToken("", { latestVersion: "1.2.0" }) === "" && spies.appsUrlWithToken(STORE + "/x", {}) === STORE + "/x", "空地址 / 没版本号 → 原样回（绝不改成坏地址）");
  ok(spies.appsUrlWithToken("data:image/png;base64,AAA", { latestVersion: "1.2.0" }) === "data:image/png;base64,AAA", "data: 图不加令牌");

  /* 详情头部（big:true）：先取带令牌的缩略图 → 404 退回带令牌的原图 → 再 404 退本机封面。
     本机那份封面由 appsLocalCoverOf 从 APPS_ST.list 里取（沙箱里换掉它当桩，口径不变）。 */
  const spec = {
    id: "a",
    latestVersion: "1.2.0",
    icon: "icons/a__u1.png",
    urls: { icon: STORE + "/api/apps/a/icon?owner=u1", thumb: STORE + "/api/apps/a/thumb?owner=u1" },
  };
  sandbox.window.__localCover = "data:image/png;base64,LOCAL";
  vm.runInContext("appsLocalCoverOf = function () { return window.__localCover || ''; };", sandbox);
  const cover = spies.appsCoverEl(spec, "演示应用", { withText: false, big: true, eager: true });
  const img = cover.querySelector(".apps-cover-img");
  ok(img.src === STORE + "/api/apps/a/thumb?owner=u1&v=1.2.0", "详情封面取带令牌的缩略图：" + img.src);
  img.dispatch("error");
  ok(img.src === STORE + "/api/apps/a/icon?owner=u1&v=1.2.0" && img.dataset.fallback === "1", "缩略图拉不到 → 退回带令牌的原图：" + img.src);
  img.dispatch("error");
  ok(img.src === "data:image/png;base64,LOCAL" && img.dataset.localTried === "1", "原图也拉不到 → 退回本机已装那份的封面图");
  img.dispatch("error");
  ok(img.hidden === true && classListOf(cover).includes("noimg"), "本机图也拉不到 → 收图 + .noimg 兜底底色");

  /* 云端一个地址都给不出（无图标声明）：详情头部还能拿本机那张顶上 */
  const noCloud = spies.appsCoverEl({ id: "a", latestVersion: "1.0.0" }, "没云端图的应用", { withText: false, big: true });
  const nimg = noCloud.querySelector(".apps-cover-img");
  ok(!!nimg && nimg.src === "data:image/png;base64,LOCAL" && nimg.dataset.localTried === "1", "没有云端图 → 直接用本机封面（不是一块纯色底）");
  ok(!classListOf(noCloud).includes("noimg"), "本机图在时不加 .noimg");
  const noCloudNone = (() => {
    sandbox.window.__localCover = "";
    return spies.appsCoverEl({ id: "b", latestVersion: "1.0.0" }, "连本机图也没有", { withText: false, big: true });
  })();
  ok(noCloudNone.querySelector(".apps-cover-img") === null && classListOf(noCloudNone).includes("noimg"), "本机图也没有 → 兜底底色");
  /* 本机兜底只认 app.json 的 icon 声明（apps-store.js 的 localAppIconOf 读成 data URL）：
     沙箱里把桩撤掉，验证真实实现在「没声明 / 没这个应用」时回空串。 */
  vm.runInContext("appsLocalCoverOf = function () { return ''; };", sandbox);
  ok(spies.appsLocalCoverOf({ id: "b" }) === "" && spies.appsLocalCoverOf({ id: "nowhere" }) === "", "本机没声明 icon / 没这个应用 → 空串（退回纯色底）");
  /* 卡片（big 不给）不掺和：不带 ?v=、拉不到就是兜底底色，不读本机封面 */
  sandbox.window.__localCover = "data:image/png;base64,LOCAL";
  vm.runInContext("appsLocalCoverOf = function () { return window.__localCover || ''; };", sandbox);
  const card = spies.appsCoverEl({ id: "a", icon: "icons/a.png", urls: { icon: STORE + "/api/apps/a/icon" } }, "演示应用", { withText: true });
  const cimg = card.querySelector(".apps-cover-img");
  ok(cimg.src === STORE + "/api/apps/a/thumb", "卡片封面不带 ?v=（本轮只动详情头部）：" + cimg.src);
  cimg.dispatch("error"); /* 缩略图 404 → 退回静态原图（既有链路，见 [3]） */
  ok(cimg.src === STORE + "/api/apps/a/icon" && cimg.dataset.localTried === undefined, "卡片退回的是云端原图，**没去读本机封面**");
  cimg.dispatch("error");
  ok(cimg.hidden === true && classListOf(card).includes("noimg"), "两张云端图都拉不到 → 直接兜底底色（不读本机封面）");
}

console.log("[7] 详情里的打赏 icon 按钮（本轮需求：打赏入口从卡片封面搬进详情）");
{
  const { spies, sandbox } = loadApps();
  const tipOpens = [];
  /* detailRecordEl 用**最小桩**（同形状：一条 .apps-detail-tipbar.tip-record + 只读标签 + 币数）；
     真实现与它的「0 则不画 / 不可点」口径由 loadTips 那一档（[1]）钉住 —— 两个模块各在自己的
     沙箱里造 DOM，混用会量到跨 context 的假现场。 */
  sandbox.window.MtTips = {
    coinIcon: () => makeEl("span"),
    detailRecordEl: (target, tips) => {
      if (!tips || !Number(tips.count || 0)) return null;
      const row = makeEl("div");
      row.className = "apps-detail-tipbar tip-record";
      const k = makeEl("span");
      k.className = "tip-record-k";
      k.textContent = "打赏记录";
      row.appendChild(k);
      row.appendChild(makeEl("span")); /* 币数（数字 + 鲸圆币图标） */
      return row;
    },
    open: (t, o) => tipOpens.push([t, o]),
  };
  ok(spies.appsTipBtnEl({ id: "a", title: "A" }) === null, "没上架云端（没有云端目标）→ 不出按钮");
  const btn = spies.appsTipBtnEl({ id: "a", title: "A", ownerId: "u1" });
  ok(!!btn && classListOf(btn).includes("apps-ico-coin"), "上架到云端 → 一枚金币（打赏 icon）按钮：" + (btn && btn.className));
  ok(btn.dataset.appTip === "1", "按钮带 data-app-tip 标记");
  ok(!!btn.onclick, "按钮挂了 onclick（开打赏窗）");

  /* 详情正文：有打赏记录 → 按钮挂在同一条 .apps-detail-tipbar 里（「打赏记录」的右侧）；
     没有记录（0 币）→ 记录那行不画，按钮照旧在（详情里必须有打赏入口）。 */
  const detail = spies.appsDetailBodyEl({ id: "a", title: "A", ownerId: "u1" }, {});
  const coin = detail.querySelector(".apps-ico-coin");
  ok(!!coin, "详情正文里有打赏 icon 按钮");
  ok(coin.parentNode === detail, "0 币（记录行不画）时按钮自己占一条，仍在详情正文里");
  ok(!detail.querySelector(".apps-detail-tipbar.tip-record"), "0 币时「打赏记录」那一行不画（不谎报数字）");

  /* 点它只开打赏窗、不冒泡到卡片（卡片主点击 = 开详情） */
  let cardClicks = 0;
  const card = makeEl("div");
  card.addEventListener("click", () => cardClicks++);
  card.appendChild(coin);
  coin.dispatch("click");
  ok(cardClicks === 0, "点打赏按钮不冒泡到卡片（不会连带打开详情）");
  ok(
    tipOpens.length === 1 && tipOpens[0][0] && tipOpens[0][0].kind === "app" && tipOpens[0][0].id === "a",
    "点打赏按钮 → MtTips.open({kind:'app'}) 一次",
  );

  /* 有打赏记录时：按钮挂进记录那一条里，且排在记录文字之后（= 右侧）。
     汇总走**唯一取数口径** appsTipsOf —— 这里就用目录条目自带的汇总（spec.tips）喂它。 */
  const withTips = { id: "a", title: "A", ownerId: "u1", tips: { count: 3, totalYuan: 120 } };
  const detail2 = spies.appsDetailBodyEl(withTips, {});
  const bar = detail2.querySelector(".tip-record");
  ok(
    !!bar && classListOf(bar).includes("apps-detail-tipbar") && classListOf(bar).includes("tip-record"),
    "有打赏时画出「打赏记录」那一条（.apps-detail-tipbar.tip-record）：" + (bar && bar.className),
  );
  const barCoin = bar && bar.querySelector(".apps-ico-coin");
  ok(!!barCoin && barCoin.parentNode === bar, "打赏按钮挂在记录那一条里（同一行）");
  ok(
    !!barCoin && bar.children.indexOf(barCoin) === bar.children.length - 1 && bar.children.length >= 3,
    "按钮排在记录文字之后（「打赏记录」+ 币数 → 按钮）：" + (bar && bar.children.length) + " 个子元素",
  );
}

console.log(fails ? "\n[" + fails + " 项失败]" : "\n全部通过");
process.exit(fails ? 1 : 0);

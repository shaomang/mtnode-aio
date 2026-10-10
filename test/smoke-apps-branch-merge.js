"use strict";
/* test/smoke-apps-branch-merge.js — 分支可见性回归 + 版本合并（纯 Node，不起 Electron、不联网）
 *   node test/smoke-apps-branch-merge.js
 *
 * 三件事都跑**真实源码**，不抄一份逻辑：
 *   [1] 分支可见性回归（历史 bug）：renderer/app-apps.js 真跑（vm 里喂最小 DOM 垫片），
 *       输入 = 线上同形的两份数据（目录两条同 id 条目 + 「我的线上条目」）。
 *       口径：分支树头部计数与树上真渲染的行数必须一致（两条分支就要两行），
 *       并反向验证用例有效（摘掉 ownerId 守卫后树上只剩一行 = 用户报的现场）。
 *   [2] 版本合并（app-branch-merge.js 真跑）——本轮共识：合并不再是脚本式 / 类 git 的行级合并：
 *       ① 文件级差异清单 add / diff / same / local + 排除清单（storage / data.json / *.mtnodes / app.json）；
 *       ② 拉取 → 暂存目录 + 整目录备份 + 清单，**不写开发目录**；上一次留下的暂存由这次拉取清掉；
 *       ③ **不改版本号**：app.json 只由 mergeNote 补一条 merges 留痕（版本号只在用户选了「跟着动」时写）；
 *       ④ Agent 写了 .merge-done.json 才算宣布结束（不写就什么都不动）；看门狗据此自动收尾；
 *       ⑤ 越界保护：暂存根之外的目录拒绝删除。
 *   [3] 接线与词条：IPC / preload / build.json 打包白名单 / css / i18n 中英齐备 /
 *       新内置技能 mtnode-app-merge（文件 + 索引）/ 渲染层入口与建会话那一步。
 *
 * 不覆盖（**如实说明**）：不真联网下载云端 zip（fetchBuffer 用假体喂本地打的包）、
 * 不起 Electron 窗口（入口的绘制用 DOM 垫片真跑 appsMergeBtnEl + 源码断言钉住）、
 * 不跑真会话（Agent 那一步由技能的收尾文件约定与源码断言钉住）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
/* 真 i18n 模块（渲染层与主进程共用的那一份）：中/英词条与占位符替换都按它算，
   测试里不另写一份「像 I18n 的」垫片 —— 本轮 bug 正是垫片与真模块不同形才漏过去的
   （垫片只收一个参数 ⇒ 占位符填不上照样「通过」）。 */
const I18n = require("../renderer/i18n.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function section(t) {
  console.log("\n" + t);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-branch-merge-"));
function writeFileAbs(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

console.log("smoke-apps-branch-merge：分支可见性回归 + 分支合并\n");

/* ═══════════════ [1] 分支树：同 id 两条分支必须画出两行 ═══════════════ */

/* 最小 DOM 垫片：只为让 renderer/app-apps.js 在 Node 里能求值 + 能长出元素树。
   不进 DOM 的纯函数（家族归组 / 合并卡片 / 分支树）都真跑。 */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    children: [],
    parent: null,
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add(...c) {
        const own = String(el.className || "").split(/\s+/).filter(Boolean);
        for (const one of c) if (own.indexOf(one) < 0) own.push(one);
        el.className = own.join(" ");
      },
      remove(...c) {
        el.className = String(el.className || "")
          .split(/\s+/)
          .filter((x) => x && c.indexOf(x) < 0)
          .join(" ");
      },
      contains: (c) => String(el.className || "").split(/\s+/).indexOf(c) >= 0,
      toggle() {},
    },
    get textContent() {
      if (this.__text != null) return String(this.__text);
      return this.children.map((c) => c.textContent).join("");
    },
    set textContent(v) {
      this.__text = String(v == null ? "" : v);
      this.children.length = 0;
    },
    innerHTML: "",
    hidden: false,
    tabIndex: 0,
    title: "",
    value: "",
    checked: false,
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild(c) {
      if (c && typeof c === "object") c.parent = el;
      this.children.push(c);
      return c;
    },
    insertBefore(c) {
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    remove() {},
    closest: () => null,
    focus() {},
    blur() {},
    click() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    scrollTo() {},
    dispatchEvent() {},
  };
  return el;
}
function makeRendererSandbox(opts) {
  const o = opts || {};
  const doc = {
    body: makeEl("body"),
    documentElement: makeEl("html"),
    head: makeEl("head"),
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => makeEl(t),
    createTextNode: (t) => {
      const e = makeEl("#text");
      e.textContent = t;
      return e;
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    readyState: "complete",
    onkeydown: null,
  };
  const win = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    I18n: { t: (s, vars) => I18n.t(s, vars), getLocale: () => "zh" },
    /* 合并入口的判据要探桥在不在（appsMergeInfo + appsMergePull）：这里只放能答出「开发态」的假桥，
       真下载 / 真写盘不走这条（那是 [2b] 里主进程模块的活）。 */
    api: {
      appsMergeInfo: async () => ({ ok: true, dev: true, version: "1.0.0", pending: null }),
      appsMergePull: async () => ({ ok: false, error: "smoke" }),
      onAppsMergeDone: () => () => {},
    },
    /* 与运行时同形：MTNodeAuth.state() → { signedIn, user }（appsAuthUser 只认 signedIn） */
    MTNodeAuth: {
      state: () =>
        opts.auth === null
          ? null
          : {
              signedIn: true,
              user: Object.assign(
                { id: "u_b33738db79310ff5", username: "ms2308", nickname: "ms2308" },
                opts.auth || {},
              ),
            },
    },
    location: { href: "" },
    navigator: { userAgent: "smoke" },
    innerWidth: 1400,
    innerHeight: 900,
  };
  win.window = win;
  win.self = win;
  const ctx = vm.createContext(win);
  ctx.console = console;
  ctx.globalThis = ctx;
  return ctx;
}
/* 真跑 renderer/app-apps.js：把要用的那几个函数在文件作用域里取出来挂到 __probe 上 */
const APPS_EXPORTS = [
  "appsSpecWithMine",
  "appsSpecPoolAll",
  "appsFamilyEntriesOf",
  "appsFamilyKeyOf",
  "appsBranchKeyOfSpec",
  "appsBranchChildrenMap",
  "appsBranchTreeEl",
  "appsMergeSameId",
  "appsDetailBranchListOf",
  "appsBranchLabelOf",
  "appsMergeBtnEl",
  /* 词条出口：带 {author} / {version} 的整句靠它把替换表送到 I18n.t（本轮 bug 的现场） */
  "appsT",
];
function runAppsRenderer(opts) {
  const o = opts || {};
  let src = read("renderer/app-apps.js");
  if (o.mutate) src = o.mutate(src);
  const ctx = makeRendererSandbox(o);
  ctx.__probe = {};
  const tail =
    "\n;__probe = {" +
    APPS_EXPORTS.map((n) => n + ": typeof " + n + ' === "function" ? ' + n + " : null").join(", ") +
    ", APPS_ST: typeof APPS_ST !== 'undefined' ? APPS_ST : null, APPS_MERGE: typeof APPS_MERGE !== 'undefined' ? APPS_MERGE : null};\n";
  vm.runInContext(src + tail, ctx, { filename: "renderer/app-apps.js" });
  const probe = ctx.__probe;
  /* 输入数据：与线上同形 —— 目录两条同 id 条目 + 「我的线上条目」那一条 */
  probe.APPS_ST.cat = {
    ok: true,
    source: "static",
    sourceBase: "http://mt-agent.com/mtnode/apps",
    apps: o.catalog || [],
  };
  const byId = Object.create(null);
  for (const it of o.mine || []) if (it && it.id) byId[String(it.id)] = it;
  probe.APPS_ST.mine = { ok: true, at: Date.now(), byId: byId };
  return probe;
}
/* 目录里的两条同 id 条目（形状与线上 catalog.json 的服务端下发字段一致） */
function catalogEntry(id, ownerId, ownerName, extra) {
  return Object.assign(
    {
      id: id,
      ownerId: ownerId,
      familyRootId: id,
      trunk: false,
      familyRootOwnerId: "u_b33738db79310ff5",
      parentOwnerId: "",
      title: "无字",
      version: "1.0.0",
      latestVersion: "1.0.0",
      versions: [{ version: "1.0.0", createdAt: 1000, bytes: 10, sha256: "aa" }],
      desc: "d",
      description: "d",
      icon: "",
      thumb: "",
      shots: [],
      shotsThumb: [],
      shotsSha: [],
      zipUrl: "",
      sha256: "",
      owner: ownerId,
      ownerName: ownerName,
      forkOf: null,
      entry: "index.html",
      tags: [],
      bytes: 10,
      downloads: 0,
      createdAt: 1000,
      updatedAt: 1000,
    },
    extra || {},
  );
}
/* 「我的线上条目」= 接口 GET /api/apps?owner=<uid> 的那一条（**没有** familyRootId / trunk） */
function mineEntry(id, ownerId, ownerName, extra) {
  return Object.assign(
    {
      id: id,
      ownerId: ownerId,
      owner: ownerName,
      ownerName: ownerName,
      title: "无字",
      description: "d",
      version: "1.0.0",
      latestVersion: "1.0.0",
      versions: [{ version: "1.0.0", createdAt: 1000, bytes: 10, sha256: "aa" }],
      zipUrl: "",
      sha256: "",
      icon: "",
      thumb: "",
      shots: [],
      forkOf: null,
      entry: "index.html",
      tags: [],
      updatedAt: 1000,
      branches: [],
      mine: true,
    },
    extra || {},
  );
}
const AUTHOR = "u_b33738db79310ff5";
const OTHER = "u_40c0d0252539e484";
const FIXTURE_CATALOG = [
  catalogEntry("wordless", AUTHOR, "ms2308", { trunk: true, familyRootOwnerId: AUTHOR }),
  catalogEntry("wordless", OTHER, "Tester", {
    version: "1.0.1",
    latestVersion: "1.0.1",
    versions: [{ version: "1.0.1", createdAt: 2000, bytes: 12, sha256: "bb" }],
    parentOwnerId: AUTHOR,
    createdAt: 2000,
    updatedAt: 2000,
    owner: "u_f2bea279",
    forkOf: { id: "wordless", ownerId: AUTHOR, owner: "ms2308", ownerName: "ms2308" },
  }),
];
const FIXTURE_MINE = [mineEntry("wordless", AUTHOR, "ms2308")];

/* 树上真画出来的「分支行」数（walk 整棵元素树，与用户看到的行数同一口径） */
function branchRowCount(el) {
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (String(node.className || "").split(/\s+/).indexOf("apps-br-branch") >= 0) n++;
    for (const c of node.children || []) walk(c);
  };
  walk(el);
  return n;
}
function treeHeadText(el) {
  let out = "";
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (String(node.className || "").split(/\s+/).indexOf("apps-br-head") >= 0) out = node.textContent;
    for (const c of node.children || []) walk(c);
  };
  walk(el);
  return out;
}

section("[1] 分支可见性：同 id 多分支下原作者也要看到别人的分支");
{
  const probe = runAppsRenderer({ catalog: FIXTURE_CATALOG, mine: FIXTURE_MINE });
  const pool = probe.appsSpecPoolAll();
  const wordless = pool.filter((s) => s.id === "wordless");
  ok(wordless.length === 2, "条目池里 wordless 有两条（目录两条；我的那条并进我自己那一条，不另起一条）");
  ok(
    wordless.filter((s) => String(s.ownerId) === AUTHOR).length === 1,
    "我的线上条目只并进「我自己那条分支」（ownerId 相同的那个），不顶掉别人那条",
  );
  ok(
    new Set(wordless.map((s) => probe.appsBranchKeyOfSpec(s))).size === 2,
    "两条分支的分支键互不相同（ownerId 各认各的）",
  );
  const fam = probe.appsFamilyEntriesOf(wordless[0]);
  ok(fam.length === 2, "家族里两条分支都在（appsFamilyEntriesOf = 2）");

  const tree = probe.appsBranchTreeEl("wordless", { branches: probe.appsDetailBranchListOf("wordless"), withSel: true, noVers: true });
  ok(!!tree, "分支树画得出来");
  const rows = branchRowCount(tree);
  const head = treeHeadText(tree);
  ok(/2\s*条分支/.test(head), "树头计数 = 2 条分支（现场里「看得见的那个数量」：" + head + "）");
  ok(rows === 2, "树上真渲染出 2 行（现场是只出 1 行，这条就是本轮修的 bug）");
  let names = [];
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (String(node.className || "").split(/\s+/).indexOf("apps-br-who") >= 0) names.push(node.textContent);
    for (const c of node.children || []) collect(c);
  };
  collect(tree);
  ok(
    names.length === 2 && names.join(" | ").indexOf("Tester") >= 0 && names.join(" | ").indexOf("ms2308") >= 0,
    "两行分别是原作者与我以外的分支作者（" + names.join(" | ") + "）",
  );
  /* 合并卡片（应用列表那张卡）也必须是「2 个分支」而不是两条同作者的重复 */
  const merged = probe.appsMergeSameId(probe.appsSpecPoolAll()).filter((s) => s.id === "wordless");
  ok(merged.length === 1 && merged[0].branchCount === 2, "应用列表合并成一张卡、branchCount = 2");
  ok(
    (merged[0].branchSiblings || []).map((b) => String(b.ownerId)).join(",") === AUTHOR + "," + OTHER,
    "卡片上的两条分支分属两位作者（" + (merged[0].branchSiblings || []).map((b) => b.ownerId).join(",") + "）",
  );
}
{
  /* 反向验证：把 appsSpecWithMine 里那段 ownerId 守卫摘掉，同一份数据下树上必须只剩一行 */
  const probe = runAppsRenderer({
    catalog: FIXTURE_CATALOG,
    mine: FIXTURE_MINE,
    mutate: (src) => {
      const before = src;
      /* 文件是 CRLF，换行一律按 \r?\n 匹配（写死 \n 会一条都匹配不上，反向验证就假过） */
      src = src.replace(/\r?\n\s*const mineOwnerId = String\(mine\.ownerId[\s\S]*?\r?\n\s*\}\r?\n/, "\n");
      src = src.replace(/\r?\n\s*\}\r?\n(\s*const versions =)/, "\n$1");
      if (src === before) throw new Error("反向验证失败：没能在 app-apps.js 里找到 ownerId 守卫那段");
      return src;
    },
  });
  const tree = probe.appsBranchTreeEl("wordless", { branches: probe.appsDetailBranchListOf("wordless"), withSel: true, noVers: true });
  const rows = branchRowCount(tree);
  ok(
    rows === 1,
    "反向验证（摘掉 ownerId 守卫）树上只剩 " + rows + " 行 —— 用例确实钉得住这个 bug",
  );
  ok(/2\s*条分支/.test(treeHeadText(tree)), "反向验证里树头仍然写着 2 条分支（数量看得见、分支看不见的现场）");
}

/* ═══════════════ [2] 版本合并的纯逻辑（app-branch-merge.js 真跑） ═══════════════
 * 本轮口径（用户共识，见 app-branch-merge.js 的文件头）：合并不再是脚本式 / 类 git 的行级合并 ——
 * 主进程只**拉取到暂存目录 + 合并前整目录备份 + 文件级差异清单**；差异怎么覆盖由会话里的 Agent
 * 按用户逐项确认的结果做；**合并不修改版本号**（每位作者各算各的）；Agent 写了 .merge-done.json
 * 才算宣布结束（主进程见它才补 merges 留痕 + 清暂存）。这一节把这条链的每一步钉住。 */
const merge = require(path.join(ROOT, "app-branch-merge.js"));

section("[2] 两方文件级差异清单：add / diff / same / local + 排除清单");
{
  const local = path.join(TMP, "dev");
  const theirs = path.join(TMP, "theirs");
  writeFileAbs(path.join(local, "same.js"), "a\nb\n");
  writeFileAbs(path.join(theirs, "same.js"), "a\nb\n");
  writeFileAbs(path.join(local, "differ.js"), "mine\n");
  writeFileAbs(path.join(theirs, "differ.js"), "theirs\n");
  writeFileAbs(path.join(local, "only-mine.js"), "mine\n");
  writeFileAbs(path.join(theirs, "brand-new.js"), "new\n");
  writeFileAbs(path.join(local, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  writeFileAbs(path.join(theirs, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x09, 0x09]));
  writeFileAbs(path.join(local, "storage", "store.json"), '{"a":1}');
  writeFileAbs(path.join(theirs, "storage", "store.json"), '{"a":2}');
  writeFileAbs(path.join(local, "data.json"), "mine-data");
  writeFileAbs(path.join(theirs, "data.json"), "their-data");
  writeFileAbs(path.join(local, "wordless.mtnodes"), "mine-canvas");
  writeFileAbs(path.join(theirs, "wordless.mtnodes"), "their-canvas");
  writeFileAbs(path.join(local, "app.json"), '{"id":"demo","version":"1.0.0","dev":true}');
  writeFileAbs(path.join(theirs, "app.json"), '{"id":"demo","version":"9.9.9","author":"别人"}');

  const r = merge.buildDiffList(local, theirs);
  const byRel = Object.create(null);
  for (const f of r.files) byRel[f.rel] = f;
  ok(byRel["same.js"] && byRel["same.js"].kind === "same", "两边一致 → same（不用问）");
  ok(byRel["differ.js"] && byRel["differ.js"].kind === "diff", "两边都有但内容不同 → diff（要问怎么覆盖）");
  ok(byRel["brand-new.js"] && byRel["brand-new.js"].kind === "add", "对方新增 → add（要问要不要采用）");
  ok(byRel["only-mine.js"] && byRel["only-mine.js"].kind === "local", "只有我有 → local（一律保留，不进拷问）");
  ok(byRel["logo.png"] && byRel["logo.png"].kind === "diff" && byRel["logo.png"].binary === true, "二进制文件照样进清单，但标 binary（Agent 用 shell 拷）");
  ok(
    !byRel["storage/store.json"] && !byRel["data.json"] && !byRel["wordless.mtnodes"] && !byRel["app.json"],
    "排除清单生效：storage/ · data.json · *.mtnodes · app.json 都不进差异清单",
  );
  const c = r.counts;
  ok(
    c.add === 1 && c.diff === 2 && c.same === 1 && c.local === 1 && c.todo === 3,
    "计数逐类正确（" + JSON.stringify(c) + "）：todo = add + diff 才是「要问用户」的量",
  );
  const pub = r.files.map(merge.diffRowOut);
  ok(
    pub.every((f) => !f.content && !/^[A-Za-z]:/.test(String(f.rel))),
    "回给渲染层的清单只有文件名 / 类别 / 字节数（没有正文、没有绝对路径）",
  );
  ok(
    !merge.mergeSkipOf("index.html") && merge.mergeSkipOf("storage/x") && merge.mergeSkipOf("a/b.mtnodes") &&
      merge.mergeSkipOf("data.json") && merge.mergeSkipOf("app.json") && merge.mergeSkipOf("installed.json") &&
      merge.mergeSkipOf(".merge-done.json") && merge.mergeSkipOf("merge.json"),
    "mergeSkipOf 逐条判据正确（含合并流程自己那两个元数据文件）",
  );
  ok(!/mergeTextLines|conflictBlock|bumpVersion|buildPlan|buildReport/.test(read("app-branch-merge.js")), "旧的行级合并引擎 / 冲突标记 / 版本 +1 / 合并报告都已从这个模块里删掉");
}

section("[2b] 拉取 → 备份 → 差异清单 → 结束声明 → 留痕与清暂存（假依赖，真跑盘上文件）");
async function fullFlowTest() {
  const devRoot = path.join(TMP, "approot-dev");
  const appDir = path.join(devRoot, "demo");
  writeFileAbs(path.join(appDir, "index.html"), "local idx\n");
  writeFileAbs(path.join(appDir, "game.js"), "line1\nline2\n");
  writeFileAbs(path.join(appDir, "storage", "store.json"), '{"keep":true}');
  writeFileAbs(path.join(appDir, "demo.mtnodes"), "canvas");
  writeFileAbs(path.join(appDir, "app.json"), JSON.stringify({ schema: 1, id: "demo", version: "1.0.0", dev: true, cloud: { version: "1.0.0" } }));
  /* 「对方那一版」= 现打一个 zip（与云端同形），fetchBuffer 假体直接把它喂回去 */
  const packDir = path.join(TMP, "pack");
  writeFileAbs(path.join(packDir, "index.html"), "their idx\n");
  writeFileAbs(path.join(packDir, "game.js"), "line1\ntheir line\n");
  writeFileAbs(path.join(packDir, "newfile.js"), "brand new\n");
  writeFileAbs(path.join(packDir, "storage", "store.json"), '{"their":true}');
  const src = require(path.join(ROOT, "apps-store.js"));
  void src; /* 只为确认模块可被 require（[3] 里按源码断言接线） */
  const files = [];
  const walk = (d, prefix) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const rel = prefix ? prefix + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else files.push({ name: rel, data: fs.readFileSync(abs) });
    }
  };
  walk(packDir, "");
  const zipBuf = makeZip(files);

  const spec = {
    id: "demo",
    ownerId: "u_other",
    owner: "other",
    ownerName: "分支作者",
    version: "1.0.1",
    latestVersion: "1.0.1",
    entry: "index.html",
    zipUrl: "demo__u_other.zip",
    versions: [{ version: "1.0.1", sha256: "", entry: "index.html", note: "修了两个 bug" }],
  };
  const urlCalls = [];
  const merger = merge.createBranchMerge({
    t: (s) => String(s == null ? "" : s),
    appRootOf: (kind) => (kind === "dev" ? devRoot : path.join(TMP, "approot-down")),
    dataDir: () => TMP,
    tmpRoot: () => path.join(TMP, "runtime-tmp"),
    findSpecHit: async (id, ownerId) => {
      urlCalls.push({ id: id, ownerId: ownerId });
      return { spec: Object.assign({}, spec, { ownerId: ownerId }), reachable: true };
    },
    zipUrlsOf: (s) => {
      const out = { zip: "http://x/" + s.zipUrl, versions: {}, icon: "" };
      for (const v of s.versions || []) out.versions[v.version] = "http://x/api/apps/" + s.id + "/file?version=" + v.version + "&owner=" + s.ownerId + "&format=raw";
      return out;
    },
    fetchBuffer: async (url) => {
      urlCalls.push({ url: url });
      return zipBuf;
    },
    sha256: (buf) => require("crypto").createHash("sha256").update(buf).digest("hex"),
    unzipBuffer: (buf, dest) => unzipInto(buf, dest),
    rmDirRecursive: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    mk: (p) => fs.mkdirSync(p, { recursive: true }),
    readJson: (p, fb) => {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        return fb;
      }
    },
    writeJson: (p, obj) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
    },
    readManifest: (dir) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8"));
      } catch {
        return { id: "demo", version: "1.0.0", dev: true };
      }
    },
  });

  const info = merger.devInfo("demo");
  ok(info.ok && info.dev === true && info.version === "1.0.0" && info.pending === null, "devInfo：开发目录里的应用回 dev:true + 版本 + pending=null");
  ok(merger.devInfo("nope").dev === false, "devInfo：不在开发目录的应用回 dev:false");

  const noDev = merge.createBranchMerge({
    t: (s) => String(s),
    appRootOf: () => path.join(TMP, "empty-root"),
    dataDir: () => TMP,
    tmpRoot: () => path.join(TMP, "runtime-tmp"),
  });
  const r0 = await noDev.mergePull({ id: "demo", ownerId: "u_other", version: "1.0.1" });
  ok(r0.ok === false && r0.code === "not_dev_app", "不在本机开发目录的应用 → not_dev_app（入口不露、也不许硬拉）");

  /* 旧暂存：上一次没宣布结束留下的那一份，应当在这一次拉取时被清掉（用户口径） */
  const staleStaging = path.join(TMP, "runtime-tmp", "app-merge", "demo-old-v0.9.0-dead");
  fs.mkdirSync(staleStaging, { recursive: true });
  fs.writeFileSync(path.join(staleStaging, "merge.json"), JSON.stringify({ appId: "demo", at: Date.now() - 1000 }), "utf8");

  const pull = await merger.mergePull({ id: "demo", ownerId: "u_other", version: "1.0.1" });
  ok(pull.ok === true, "mergePull 成功（" + (pull.ok ? "" : pull.error) + "）");
  ok(urlCalls.some((c) => c.url && c.url.indexOf("owner=u_other") >= 0 && c.url.indexOf("version=1.0.1") >= 0), "下载地址点到了「那一条分支的那一版」（?owner=…&version=…）");
  ok(pull.their.version === "1.0.1" && pull.their.author === "分支作者" && pull.their.note === "修了两个 bug", "回执里带上对方作者 / 版本 / 版本说明");
  ok(!fs.existsSync(staleStaging), "上一次留下的暂存目录在这次拉取时被清掉");
  ok(pull.staging.indexOf(path.join("runtime-tmp", "app-merge")) >= 0 && fs.existsSync(pull.staging), "对方那一版解在数据目录的暂存目录里（" + pull.staging + "）");
  ok(fs.existsSync(path.join(pull.staging, "merge.json")), "暂存目录里写了 merge.json（谁的那一版、备份在哪）");
  ok(fs.existsSync(path.join(pull.srcDir, "newfile.js")) || fs.existsSync(path.join(pull.staging, "newfile.js")), "对方那一版真的解包出来了（Agent 读得到）");
  const kinds = Object.create(null);
  for (const f of pull.files) kinds[f.rel] = f.kind;
  ok(kinds["newfile.js"] === "add" && kinds["game.js"] === "diff" && kinds["index.html"] === "diff", "差异清单分出了 add / diff");
  ok(kinds["storage/store.json"] === undefined && kinds["demo.mtnodes"] === undefined && kinds["app.json"] === undefined, "排除清单在真拉取路径上同样生效（storage / 画布 / app.json 不进清单）");
  ok(fs.readFileSync(path.join(appDir, "game.js"), "utf8") === "line1\nline2\n", "拉取**不写开发目录**（game.js 还是原样 —— 写盘是会话里 Agent 的活）");
  ok(!fs.existsSync(path.join(appDir, "newfile.js")), "拉取阶段没往开发目录落任何新文件");
  ok(fs.existsSync(pull.backupDir) && pull.backupFiles > 0, "拉取时先做了整目录备份（" + pull.backupDir + "，" + pull.backupFiles + " 个文件）");
  ok(fs.readFileSync(path.join(pull.backupDir, "game.js"), "utf8") === "line1\nline2\n", "备份里是合并前的原文件（可回滚）");
  const pending = merger.devInfo("demo").pending;
  ok(pending && pending.staging === pull.staging && pending.done === false, "devInfo 的 pending = 这次留下的暂存（会话没宣布结束前一直看得到）");

  /* 还没宣布结束：什么都不该动 */
  const end0 = merger.mergeEnd({ id: "demo", staging: pull.staging });
  ok(end0.ok === true && end0.declared === false && end0.removed === false && fs.existsSync(pull.staging), "没有 .merge-done.json 时：不落留痕、不删暂存（会话还在拷问）");
  ok(!JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8")).merges, "没有结束声明时 app.json 一个字节都没动");

  /* Agent 宣布结束（版本号留空 = 不动） */
  fs.writeFileSync(
    path.join(pull.staging, ".merge-done.json"),
    JSON.stringify({ done: true, files: ["game.js", "newfile.js"], version: "" }),
    "utf8",
  );
  const end1 = merger.mergeEnd({ id: "demo", staging: pull.staging });
  ok(end1.ok === true && end1.declared === true && end1.removed === true, "写了结束声明之后：收尾成功并删掉暂存目录");
  ok(!fs.existsSync(pull.staging), "暂存目录真的没了");
  const man = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8"));
  ok(man.version === "1.0.0", "合并**不改版本号**（还是 1.0.0；对方是 1.0.1、包里那份更是 9.9.9，都没顶上来）");
  ok(man.dev === true && man.cloud && man.cloud.version === "1.0.0", "app.json 的 dev / cloud 上架留痕原样保留（只加了一条 merges）");
  ok(Array.isArray(man.merges) && man.merges.length === 1, "app.json 补了一条 merges 留痕");
  ok(
    man.merges[0].ownerId === "u_other" && man.merges[0].author === "分支作者" && man.merges[0].version === "1.0.1" && Number(man.merges[0].at) > 0,
    "留痕里记了来源 id / 作者 / 版本 / 时间（" + JSON.stringify(man.merges[0]) + "）",
  );
  ok(fs.readFileSync(path.join(appDir, "storage", "store.json"), "utf8") === '{"keep":true}', "storage/ 一个字节都没动（存档安全）");
  ok(fs.readFileSync(path.join(appDir, "demo.mtnodes"), "utf8") === "canvas", "该应用的画布一个字节都没动");
  ok(!fs.existsSync(path.join(appDir, "MERGE-REPORT.md")), "不再往开发目录写任何报告文件");

  /* 用户选了「我这一版跟着动」→ 版本号按用户给的那个写（仍然只有主进程写 app.json） */
  const note = merger.mergeNote({
    id: "demo",
    ownerId: "u_other",
    author: "分支作者",
    version: "1.0.1",
    newVersion: "1.0.2",
  });
  ok(note.ok === true && note.versionBefore === "1.0.0" && note.version === "1.0.2" && note.versionChanged === true, "只有拷问问出「跟着动」时才改版本号（1.0.0 → 1.0.2）");
  ok(JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8")).version === "1.0.2", "版本号落在 app.json 上");
  ok(merger.mergeNote({ id: "demo", ownerId: "u_other", author: "分支作者", version: "1.0.1" }).versionChanged === false, "不给 newVersion 时版本号一律不动");

  /* 越界保护：只许删自己建的那一棵暂存目录 */
  const outside = path.join(TMP, "not-ours");
  fs.mkdirSync(outside, { recursive: true });
  const bad = merger.mergeEnd({ id: "demo", staging: outside });
  ok(bad.ok === false && bad.code === "bad_staging" && fs.existsSync(outside), "暂存根之外的目录拒绝删除（bad_staging）");

  /* 看门狗：Agent 写完结束声明后，主进程自己收尾并回调（界面据此解禁入口） */
  const pull2 = await merger.mergePull({ id: "demo", ownerId: "u_other", version: "1.0.1" });
  ok(pull2.ok === true, "第二次拉取成功（旧暂存已清，能重新开一次合并）");
  const watched = await new Promise((resolve) => {
    const stop = merger.watchStaging("demo", pull2.staging, (r) => {
      stop();
      resolve(r);
    });
    setTimeout(() => {
      fs.writeFileSync(path.join(pull2.staging, ".merge-done.json"), JSON.stringify({ done: true, files: ["game.js"], version: "" }), "utf8");
    }, 50);
    setTimeout(() => resolve(null), 8000);
  });
  ok(watched && watched.declared === true && watched.removed === true, "看门狗看到结束声明后自动收尾（补留痕 + 清暂存）");
  ok(!fs.existsSync(pull2.staging), "看门狗收尾后暂存目录也没了");
}
/* 最小 zip（store 方式，无压缩）+ 最小解包：与主进程 unzipBuffer 同一形状，够真跑一遍即可 */
function makeZip(files) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + f.data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}
function unzipInto(buf, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let o = 0;
  while (o + 4 <= buf.length) {
    if (buf.readUInt32LE(o) !== 0x04034b50) break;
    const compSize = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nameLen).toString("utf8");
    const start = o + 30 + nameLen + extraLen;
    const data = buf.slice(start, start + compSize);
    o = start + compSize;
    if (!name || name.endsWith("/")) continue;
    const out = path.join(dest, ...name.split("/"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

/* ═══════════════ [3] 接线与词条 ═══════════════ */
section("[3] 接线：IPC / preload / 打包白名单 / 样式 / 词条 / 内置技能");
{
  const store = read("apps-store.js");
  ok(
    /ipcMain\.handle\("apps:mergeInfo"/.test(store) && /ipcMain\.handle\("apps:mergePull"/.test(store) &&
      /ipcMain\.handle\("apps:mergeNote"/.test(store) && /ipcMain\.handle\("apps:mergeEnd"/.test(store),
    "apps-store.js 注册了 apps:mergeInfo / mergePull / mergeNote / mergeEnd 四条通道",
  );
  ok(!/apps:mergePlan|apps:mergeRun/.test(store), "旧的预演 / 脚本合并两条通道已删（不留兼容层）");
  ok(/require\("\.\/app-branch-merge\.js"\)/.test(store), "apps-store.js 真 require 新模块");
  ok(/branchMerge\.watchStaging\(/.test(store) && /apps:mergeDone/.test(store), "拉取成功后挂看门狗，收到结束声明就推 apps:mergeDone 给界面");
  const pre = read("preload.js");
  ok(
    /appsMergeInfo:/.test(pre) && /appsMergePull:/.test(pre) && /appsMergeNote:/.test(pre) && /appsMergeEnd:/.test(pre) && /onAppsMergeDone:/.test(pre),
    "preload.js 暴露了 mergeInfo / mergePull / mergeNote / mergeEnd 与收尾事件订阅",
  );
  ok(!/appsMergePlan:|appsMergeRun:/.test(pre), "preload 里旧的预演 / 合并两个入口已删");
  const build = read("build.json");
  ok(/^\s*"app-branch-merge\.js",$/m.test(build), "build.json files 白名单里有 app-branch-merge.js（打包后不会 Cannot find module）");
  ok(/mtnode-agent-skills\/\*\*/.test(build), "内置技能目录在打包白名单里（新技能随包走）");
  const apps = read("renderer/app-apps.js");
  ok(
    /appsMergeEntryBtn/.test(apps) && /appsMergeStart/.test(apps) && /appsCardMergeTargetOf/.test(apps) && /appsDevStartMergeSession/.test(apps),
    "渲染层有合并入口 / 拉取链 / 开发中应用的合并目标 / 交给 Agent 建会话那一步",
  );
  ok(
    !/openAppsMergeDlg|appsMergeBuild|appsMergePaint|appsMergeRunNow|closeAppsMergeDlg|appsMergePlan/.test(apps),
    "合并预演窗那一整套已从渲染层删干净（不留悬空函数）",
  );
  ok(/APPS_MERGE\.run\[sid\]/.test(apps) && /appsMergeLockedOf/.test(apps), "进行中的合并按 id 记着：入口置灰的判据在");
  /* 入口真跑一遍：自己的分支也露（把自己的云端那一版拉回来合进本机）、不在开发目录里就不露 */
  const btnProbe = runAppsRenderer({ catalog: FIXTURE_CATALOG, mine: FIXTURE_MINE });
  btnProbe.APPS_MERGE.dev["wordless"] = { ok: true, dev: true, version: "1.0.0", pending: null };
  const mineBranch = FIXTURE_CATALOG[0];
  const theirBranch = FIXTURE_CATALOG[1];
  const btnMine = btnProbe.appsMergeBtnEl("wordless", mineBranch, FIXTURE_CATALOG);
  const btnTheirs = btnProbe.appsMergeBtnEl("wordless", theirBranch, FIXTURE_CATALOG);
  ok(!!btnMine && /apps-br-merge/.test(String(btnMine.className)), "自己的分支也露合并入口（入口常驻：把自己的云端那一版拉回来合进本机）");
  ok(!!btnTheirs && /apps-br-merge/.test(String(btnTheirs.className)), "别人的分支照样露");
  const btnText = (btnTheirs.children || []).map((c) => c.textContent).join(" | ");
  ok(btnText.indexOf("拉取 v1.0.1") >= 0 && btnText.indexOf("交给 Agent 合并") >= 0, "按钮文案是「拉取 vX 交给 Agent 合并」（" + btnText.slice(0, 80) + "…）");
  ok(btnText.indexOf("逐项问过你") >= 0 && btnText.indexOf("MERGE-REPORT") < 0, "入口说明换成了会话口径（Agent 逐项问过你才写盘），不再提冲突标记与报告");
  const noDev = runAppsRenderer({ catalog: FIXTURE_CATALOG, mine: FIXTURE_MINE });
  noDev.APPS_MERGE.dev["wordless"] = { ok: true, dev: false, version: "", pending: null };
  ok(noDev.appsMergeBtnEl("wordless", theirBranch, FIXTURE_CATALOG) === null, "不在本机开发目录里的应用不露入口");
  ok(/APPS_MERGE\.dev\[sid\]/.test(apps) && /appsMergeEnsureInfo/.test(apps), "开发态按 id 缓存再问主进程（答不到就不露按钮）");
  /* 卡片 / 列表行：开发中的应用走合并入口，非开发的照旧「更新」（整目录覆盖） */
  ok(/function appsCardMergeTargetOf\(spec\)/.test(apps) && /local\.dev !== true\) return null/.test(apps), "只有开发中的应用才走「拉取并交给 Agent 合并」（其余照旧走更新）");
  ok(/appsCardMergeTargetOf\(spec\)/.test(apps) && /appsCardUpdateTargetOf\(spec\)/.test(apps), "卡片与列表行两条路都在：开发中 → 合并入口，其余 → 更新入口");
  const css = read("renderer/css/apps.css");
  ok(/\.apps-br-merge\b/.test(css) && /\.apps-merge-entry\b/.test(css), "分支树入口块与合并按钮的样式都在");
  ok(!/\.apps-merge-box\b|\.apps-merge-go\b|\.apps-merge-files\b/.test(css), "合并窗那一批样式已删");
  const i18n = read("renderer/i18n.js");
  const enKeys = [
    "拉取 v",
    " 交给 Agent 合并",
    "：拉取到暂存目录，新建会话对比差异、逐项确认后合进开发目录（只写本机）",
    "拉取这一版到本机暂存目录，新建一条会话对比差异、逐项确认后合进开发目录（只写本机，不会自动上架）",
    "这个应用已有一次合并在进行（在开发页那条会话里）",
    "合并在一条新会话里进行：Agent 对比两版差异、逐项问过你之后才写入本机开发目录；不会自动上架。",
    "拉取失败：",
    "合并收尾：已按你的确认写入本机（对方 v",
    "合并 {author} v{version} 的差异",
    "把 {author} v{version} 的差异按我逐项确认的结果合进本机",
    "【硬规则】只按拷问结果覆盖差异，不做任何额外改动；「只有我有」的文件一律保留、不用问；不动 storage/、data.json、*.mtnodes 与备份目录；**不许直接改 app.json、不许改版本号**。",
    "这个应用不在本机开发目录里（先把它放到开发目录再合并）",
  ];
  const missing = enKeys.filter((k) => i18n.indexOf(JSON.stringify(k) + ":") < 0);
  ok(!missing.length, "合并相关词条都有英文译文" + (missing.length ? "（缺：" + missing.join(" / ") + "）" : ""));
  ok(i18n.indexOf('"MERGE-REPORT.md"') < 0 && i18n.indexOf("冲突区按 git 风格标记在文件里：") < 0, "旧口径的词条（报告 / 冲突标记）已删");
  /* 新技能：随包内置、进索引、内容与契约同源 */
  ok(exists("mtnode-agent-skills/app/app-merge/SKILL.md"), "内置技能文件在 mtnode-agent-skills/app/app-merge/SKILL.md");
  const skill = read("mtnode-agent-skills/app/app-merge/SKILL.md");
  ok(/^name:\s*mtnode-app-merge\s*$/m.test(skill), "技能 front matter 的 name = mtnode-app-merge");
  ok(
    skill.indexOf(".merge-done.json") >= 0 && /不许改版本号|不许直接改 `app\.json`/.test(skill) && skill.indexOf("mtnode-grill-me") >= 0,
    "技能写明三件事：先拷问、不许改版本号 / app.json、收尾写 .merge-done.json",
  );
  const idx = read("mtnode-agent-skills/index.json");
  ok(idx.indexOf("mtnode-app-merge") >= 0 && idx.indexOf("app/app-merge/SKILL.md") >= 0, "新技能已进索引（tools/build-mtnode-agent-skill-index.js 生成）");
  const dev = read("renderer/app-apps-dev.js");
  ok(/function appsDevStartMergeSession/.test(dev) && /window\.appsDevStartMergeSession = appsDevStartMergeSession/.test(dev), "开发页暴露了建合并会话的入口");
  ok(/function appsMergeContractText/.test(dev) && /_devContract|agentContractSession/.test(dev), "契约正文有独立函数，会话走契约注入（开发会话 / 普通契约会话两条路）");
  ok(/createDevSessionForNode/.test(dev) && /agentContractSession/.test(dev), "有画布开发节点走开发会话，没有则退成普通契约会话");
  const mergeSrc = read("app-branch-merge.js");
  ok(
    !/[\u4e00-\u9fa5]/.test(
      mergeSrc
        .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
        .replace(/"(?:[^"\\]|\\.)*"/g, (m) => (/[\u4e00-\u9fa5]/.test(m) && /t\(/.test(mergeSrc) ? "" : m)),
    ),
    "合并模块里没有裸写的中文界面文案（都走 t() 词条）",
  );
  /* 词条带占位符的键必须**真的被替换**：本轮用户报的现场 ——
     会话里显示的是「把 {author} v{version} 的差异按我逐项确认的结果合进本机」，
     作者与版本号都没填上。根因是 appsT / appsDevT 只收一个参数（把 I18n.t 的第二参
     vars 丢了），而这两个键是带 {author} / {version} 的整句。 */
  const listSrc = read("renderer/app-apps-list.js");
  ok(/function appsT\(s, vars\)/.test(apps), "appsT 收下 vars 并照传给 I18n.t（不再把替换表丢掉）");
  ok(/function appsDevT\(s, vars\)/.test(dev), "appsDevT 同上（这条链才是合并会话的标题与关键输入）");
  ok(/I18n\.t\(s, vars\)/.test(dev) && /I18n\.t\(s, vars\)/.test(apps), "两处都把 vars 传到了 I18n.t（不是只改形参）");
  ok(/function appsTr\(s, vars\)[\s\S]{0,160}appsT\(s, vars\)/.test(listSrc), "列表层的 appsTr 也照传（三条翻译出口口径一致）");
  const tplProbe = runAppsRenderer({ catalog: FIXTURE_CATALOG, mine: FIXTURE_MINE });
  const tplFilled = tplProbe.appsT("把 {author} v{version} 的差异按我逐项确认的结果合进本机", {
    author: "Tester",
    version: "1.0.2",
  });
  ok(
    tplFilled === "把 Tester v1.0.2 的差异按我逐项确认的结果合进本机",
    "appsT 真的填上了作者与版本（" + tplFilled + "）",
  );
  /* 英文界面同一条链：词条（EN）+ 替换表一起走，值也要落进去 */
  const loc0 = I18n.getLocale();
  I18n.setLocale("en");
  const enFilled = I18n.t("把 {author} v{version} 的差异按我逐项确认的结果合进本机", {
    author: "Tester",
    version: "1.0.2",
  });
  I18n.setLocale(loc0);
  ok(
    enFilled === "Merge Tester v1.0.2 differences into my machine as I confirm each item",
    "英文界面下同一句也带真值（" + enFilled + "）",
  );
  ok(/\{\w+\}/.test(tplProbe.appsT("把 {author} v{version} 的差异", {})) === false, "占位符缺值时填成空串（不会留半截 {author}）");
}

/* ═══════════════ [4] 合并会话：先拉取、再交给 Agent（真跑建会话那一步） ═══════════════ */
section("[4] 合并会话：标题 / 关键输入填真值，且**拉取成功之后**才建会话");
/** 真跑 renderer/app-apps-dev.js（vm 最小垫片），把建会话那几个函数取出来核。
 *  opts.noNode = true → 该应用在画布上没有开发节点（走 agentContractSession 那条路）。 */
function runMergeSessionProbe(opts) {
  const o = opts || {};
  const ctx = makeRendererSandbox({});
  const calls = [];
  /* 用**真 i18n 模块**当垫片：第二参替换表的行为与线上逐字一致
     （少传第二参就填不上 —— 那正是用户看到的现场）。 */
  ctx.I18n = { t: (s, vars) => I18n.t(s, vars), getLocale: () => "zh" };
  ctx.window.I18n = ctx.I18n;
  ctx.wfOfCanvasIdForRun = async () => (o.noNode ? null : { id: "wf_demo" });
  ctx.appsDevNodeOfWf = () => (o.noNode ? null : { id: "n_dev", kind: "super", dev: true });
  ctx.persistWf = () => {};
  ctx.agentTouchSession = async () => {};
  ctx.agentContractRound = async () => null;
  ctx.agentSessionById = () => null;
  if (!o.noNode) {
    ctx.createDevSessionForNode = (node, mode, req, contract) => {
      calls.push({ via: "dev", contract: String(contract || ""), req: String(req || "") });
      return { id: "as_merge_1", title: "", messages: [{ role: "user", content: String(req || "") }] };
    };
  }
  ctx.agentContractSession = (o2) => {
    calls.push({ via: "contract", contract: String(o2.contract || ""), req: String(o2.kick || ""), opts: o2 });
    return { id: "as_merge_2", title: String(o2.title || ""), messages: [{ role: "user", content: String(o2.kick || "") }] };
  };
  ctx.__probe = {};
  const tail =
    "\n;__probe = { appsDevT: appsDevT, appsDevTpl: appsDevTpl," +
    " appsDevStartMergeSession: appsDevStartMergeSession, appsMergeContractText: appsMergeContractText };\n";
  vm.runInContext(read("renderer/app-apps-dev.js") + tail, ctx, { filename: "renderer/app-apps-dev.js" });
  return { p: ctx.__probe, calls: calls };
}
async function mergeSessionTest() {
  const probe = runMergeSessionProbe();
  const p = probe.p;
  ok(typeof p.appsDevT === "function" && typeof p.appsDevTpl === "function", "合并会话那一步的函数取到了（app-apps-dev.js 能在 Node 里求值）");
  const kick = p.appsDevT("把 {author} v{version} 的差异按我逐项确认的结果合进本机", {
    author: "分支作者",
    version: "1.0.1",
  });
  ok(
    kick === "把 分支作者 v1.0.1 的差异按我逐项确认的结果合进本机",
    "appsDevT 真的填上了作者与版本（" + kick + "）",
  );
  ok(
    /appsDevTpl\(\s*"合并 \{author\} v\{version\} 的差异"/.test(read("renderer/app-apps-dev.js")) &&
      /appsDevTpl\(\s*"把 \{author\} v\{version\} 的差异按我逐项确认的结果合进本机"/.test(read("renderer/app-apps-dev.js")),
    "合并会话标题与关键输入都走 appsDevTpl（漏参当场抛错，不再静默留花括号）",
  );
  let threw = false;
  try {
    p.appsDevTpl("把 {author} v{version} 的差异合进本机", { author: "分支作者" });
  } catch (_) {
    threw = true;
  }
  ok(threw, "appsDevTpl 填不干净就抛错（{version} 缺值时不会把花括号甩给用户）");
  /* 真跑建会话：pull 回执里的作者 / 版本必须一路进到会话标题与那条关键输入 */
  const pull = {
    ok: true,
    appId: "demo",
    dir: "E:\\apps\\demo",
    staging: "E:\\data\\runtime-tmp\\app-merge\\demo-u_other-1.0.1",
    myVersion: "1.0.0",
    backupDir: "E:\\data\\runtime-tmp\\app-merge\\demo-u_other-1.0.1.bak",
    counts: { add: 1, diff: 1, same: 0, local: 2 },
    files: [
      { rel: "index.html", kind: "diff" },
      { rel: "new.js", kind: "add" },
    ],
    their: { ownerId: "u_other", author: "分支作者", version: "1.0.1", note: "修了两个 bug" },
  };
  const sess = await p.appsDevStartMergeSession(pull, "分支作者");
  ok(
    !!sess && sess.id === "as_merge_1" && probe.calls[0] && probe.calls[0].via === "dev",
    "有开发节点时走开发会话（拿到会话对象：" + (sess && sess.id) + " / " + (probe.calls[0] && probe.calls[0].via) + "）",
  );
  ok(sess.title === "合并 分支作者 v1.0.1 的差异", "会话标题 = 对方作者 + 版本号（真值：" + sess.title + "）");
  ok(
    sess.messages[0].content === "把 分支作者 v1.0.1 的差异按我逐项确认的结果合进本机",
    "会话里那条关键输入也填真值（用户看得到的就是它：" + sess.messages[0].content + "）",
  );
  ok(!/\{\w+\}/.test(sess.title + sess.messages[0].content), "标题与关键输入里一个花括号占位符都不剩");
  const contract = String((probe.calls[0] && probe.calls[0].contract) || "");
  ok(
    contract.indexOf("分支作者") >= 0 && contract.indexOf("v1.0.1") >= 0 && contract.indexOf(pull.staging) >= 0,
    "契约正文里同时给了「对方是谁的哪一版」与暂存目录绝对路径",
  );
  ok(contract.indexOf(pull.dir) >= 0, "契约给了本机开发目录的绝对路径（Agent 不用猜落点）");
  ok(
    contract.indexOf("先用 skill 工具加载内置技能 mtnode-app-merge") >= 0 &&
      contract.indexOf("① 先用 skill 工具加载") < contract.indexOf("② 再加载 mtnode-grill-me"),
    "契约写明顺序：先加载 mtnode-app-merge 技能，再拷问（skill 在动文件之前）",
  );
  ok(
    contract.indexOf("合并前整目录备份") >= 0 && contract.indexOf("文件级差异清单") >= 0,
    "契约带上主进程已做完的两件事：整目录备份 + 文件级差异清单（技能不自己比）",
  );
  /* 没有开发节点 → 退成普通契约会话：同一份标题 / 关键输入口径（agentContractSession 那条路） */
  const probe2 = runMergeSessionProbe({ noNode: true });
  const sess2 = await probe2.p.appsDevStartMergeSession(pull, "");
  ok(
    !!sess2 && sess2.id === "as_merge_2" && sess2.title === "合并 分支作者 v1.0.1 的差异",
    "画布上没有开发节点时退成普通契约会话，标题照样是作者 + 版本（" + (sess2 && sess2.title) + "）",
  );
  ok(
    sess2 && sess2.messages[0].content === "把 分支作者 v1.0.1 的差异按我逐项确认的结果合进本机",
    "那条路上关键输入同样填真值（两条路同一份口径）",
  );
  const opt2 = (probe2.calls[0] && probe2.calls[0].opts) || null;
  ok(
    !!opt2 && opt2.workspace === pull.dir && opt2.allowCanvas === false && /分支作者/.test(String(opt2.contract || "")),
    "契约会话：工作区 = 应用目录、不许读画布、契约正文带对方作者",
  );
  /* 拉取没成功 → 界面层不会建会话（顺序：先拉到内容，再交给 Agent） */
  const appsSrc = read("renderer/app-apps.js");
  const iPull = appsSrc.indexOf("pull = await api.appsMergePull(");
  const iOk = appsSrc.indexOf("if (!pull || pull.ok === false)");
  const iSess = appsSrc.indexOf("appsDevStartMergeSession(pull, label)");
  ok(
    iPull > 0 && iOk > iPull && iSess > iOk,
    "appsMergeStart：拉取 → 判成败 → 才建会话（失败那一步直接 return，绝不建半条会话）",
  );
  ok(
    /APPS_MERGE\.run\[sid\] = \{/.test(appsSrc.slice(iSess, iSess + 500)),
    "会话真建起来之后才登记「这个应用有一次合并在进行」（失败不会把入口锁死）",
  );
}

(async () => {
  await fullFlowTest();
  await mergeSessionTest();
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "全部通过 " + checks + " 项"));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fails ? 1 : 0);
})();

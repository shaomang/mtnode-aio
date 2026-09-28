"use strict";
/* 团队事实库（Fact Library） —— 冒烟测试（纯 Node，无 Electron / 无真实 DOM）
 *   node test/smoke-factlib.js
 * 需求：事实库三件套的路径解析 / 读写模块（app-factlib.js）可加载并导出全局；
 *       事实库图片的相对路径 ⇄ file:/// 绝对路径双向转换往返幂等；
 *       孤立图片回收（GC）保留任一留存版本引用到的文件、只删真孤立文件；
 *       normalizeCanvas 增 fact 后旧配置迁移不丢数据、fact 归一幂等；
 *       旧单文档配置迁移为 docs[0]、多文档 CRUD 幂等（app-team.js）；
 *       expertSystemPrompt 注入库内多篇文档路径清单 + 查阅优先级纪律（且不塞库正文）；
 *       新增词条中英词表都有。
 * 覆盖：
 *   [1] app-factlib.js 顶层加载不抛错 + 导出全局（MTNodeFactLib + factlib* 别名）
 *   [2] 图片相对路径 ⇄ file:// 双向转换幂等（app-review.js）
 *   [3] GC：保留任一留存版本引用、删除真孤立文件、重复调用不再删
 *   [4] normalizeCanvas 增 fact 后旧配置迁移不丢数据 + fact 幂等 + 旧单文档迁移 docs[0] + 多文档 CRUD 幂等（app-team.js）
 *   [5] expertSystemPrompt 含多文档路径清单 + 三条查阅优先级纪律（不含库正文）
 *   [6] 新词条在中英词表都有
 *   [7] reconcile 扫库目录自动登记新 .md（added=2 / 再跑幂等 added=0）+ statsOf 带磁盘 mtime
 *   [8] 应用目录硬守卫：resolvePaths 在「工作区在应用目录内」与「工作区为空」两种情形下
 *       都不得返回应用目录路径（应用目录 = app.getAppPath() / exe 目录，经 api.appDirs() 取）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* ═══════════ 最小 DOM 桩：app-review.js 只在调用期用 template / img ═══════════
   rvRewriteImgSrc 只做一件事：把 <img> 的 src 换掉、记下 data-rv-src，再吐回 HTML。
   故这里给出一个「只认 img 标签」的极简 template：innerHTML 写入时抠出 img 属性，
   querySelectorAll('img') 返回可读写属性的假元素，读回时按属性表重新序列化。 */
function fakeTemplate() {
  let html = "";
  let imgs = [];
  return {
    set innerHTML(v) {
      html = String(v);
      imgs = [];
      const re = /<img\b[^>]*>/gi;
      let m;
      while ((m = re.exec(html))) {
        const raw = m[0];
        const attrs = {};
        const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g;
        let a;
        while ((a = ar.exec(raw))) attrs[a[1]] = a[2];
        const el = {
          getAttribute: (k) =>
            Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null,
          setAttribute: (k, val) => {
            attrs[k] = String(val);
          },
        };
        imgs.push({ raw: raw, attrs: attrs, el: el });
      }
    },
    get innerHTML() {
      let out = html;
      for (const im of imgs) {
        const parts = Object.keys(im.attrs).map(
          (k) => k + '="' + im.attrs[k] + '"',
        );
        out = out.replace(im.raw, "<img " + parts.join(" ") + ">");
      }
      return out;
    },
    content: {
      querySelectorAll: (sel) =>
        sel === "img" ? imgs.map((x) => x.el) : [],
    },
  };
}
function fakeEl(tag) {
  const e = {
    tagName: String(tag || "").toUpperCase(),
    className: "",
    textContent: "",
    style: {},
    children: [],
    hidden: false,
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    classList: { contains: () => false, add() {}, remove() {} },
    querySelector() {
      return null;
    },
  };
  Object.defineProperty(e, "innerHTML", {
    get() {
      return "";
    },
    set() {},
  });
  return e;
}

/* ═══════════ 沙箱：app-factlib.js + app-team.js + app-inline-img.js + app-review.js ═══════════ */
function loadAll() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.toast = () => {};
  /* inlineToMd 用到 Node 常量（app.js / 浏览器提供）。 */
  sandbox.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  sandbox.document = {
    createElement: (t) => (t === "template" ? fakeTemplate() : fakeEl(t)),
    getElementById: () => null,
  };
  /* 同层脚本真实全局（app-nodes.js / app-settings.js 提供），不注入会回落兜底值。 */
  sandbox.AGENT_PRESETS = ["minimal", "standard", "lean", "code", "cordis"].map((id) => ({ id }));
  sandbox.AGENT_PRESET_DEFAULT = "minimal";
  sandbox.AGENT_PRESET_LEGACY_IDS = {};
  sandbox.normalizeAgentEffort = (v) => {
    const s = String(v == null ? "" : v).trim();
    return ["low", "medium", "high", "xhigh", "max"].indexOf(s) >= 0 ? s : "high";
  };
  sandbox.permissionPresetOptions = () =>
    ["mtnode-unattended", "workspace-write", "read-only", "danger-full-access"].map((id) => [id, id]);
  const S = { config: {}, wf: { id: "wf-1", name: "画布 A" } };
  sandbox.S = S;
  /* 主进程桥桩：文件读写走内存表，数据目录固定，file:/// 换算与真实 toFileUrl 同口径。 */
  const api = {
    configSave: () => Promise.resolve(),
    dataGetRoot: () => Promise.resolve({ ok: true, path: "E:/data" }),
    /* 应用目录守卫口径：主进程 app:dirs 给出的 asar 根 + exe 目录。 */
    appDirs: () =>
      Promise.resolve({ ok: true, appPath: "E:\\app\\console", exeDir: "E:\\app\\console" }),
    fileExists: (p) => Promise.resolve(false),
    fileReadText: () => Promise.resolve({ ok: true, exists: false, content: "" }),
    fileWriteText: () => Promise.resolve({ ok: true }),
    fileListDir: () => Promise.resolve({ ok: true, list: [] }),
    factDeleteImages: () => Promise.resolve({ ok: true, removed: [] }),
    toFileUrl: (p) => "file:///" + String(p || "").replace(/\\/g, "/"),
  };
  sandbox.api = api;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-factlib.js"), sandbox, { filename: "app-factlib.js" });
  vm.runInContext(read("renderer/app-team-icons.js"), sandbox, { filename: "app-team-icons.js" });
  vm.runInContext(read("renderer/app-team.js"), sandbox, { filename: "app-team.js" });
  /* 内嵌图片共享模块（粘贴 / 拖入 / 落盘 / 引用登记 / 无引用回收）：审阅侧只剩薄包装，
     真源在 renderer/app-inline-img.js（窗口全局 MTInlineImg），故必须排在 app-review.js 之前。 */
  vm.runInContext(read("renderer/app-inline-img.js"), sandbox, {
    filename: "app-inline-img.js",
  });
  vm.runInContext(read("renderer/app-review.js"), sandbox, { filename: "app-review.js" });
  return { sandbox, S, api, lib: sandbox.MTNodeFactLib, team: sandbox.MTNodeTeam };
}

let V = null;
let loadErr = null;
try {
  V = loadAll();
} catch (e) {
  loadErr = e;
}
ok(
  !loadErr,
  "app-factlib.js / app-team.js / app-inline-img.js / app-review.js 顶层加载不抛错" +
    (loadErr ? "（" + loadErr.message + "）" : ""),
);
const { sandbox, S, api, lib, team: T } = V || {};

/* ===================== [1] 顶层加载 + 导出全局 ===================== */
console.log("\n[1] app-factlib.js 顶层加载不抛错 + 导出全局");
{
  ok(!!lib && typeof lib === "object", "window.MTNodeFactLib 已导出");
  [
    "joinPath",
    "pathsOf",
    "resolvePaths",
    "readDoc",
    "writeDoc",
    "ensureDoc",
    "ensureLibrary",
    "statsOf",
    "safeName",
    "isAbs",
    "docPathsOf",
    "libOf",
    "listDocs",
    "ensureDocByName",
    "renameDoc",
    "removeDoc",
    "removeLibrary",
    "reconcile",
  ].forEach((k) => ok(typeof lib[k] === "function", "MTNodeFactLib." + k + " 是函数"));
  ok(
    sandbox.factlibPaths === lib.resolvePaths &&
      sandbox.factlibPathsOf === lib.pathsOf &&
      sandbox.factlibRead === lib.readDoc &&
      sandbox.factlibWrite === lib.writeDoc &&
      sandbox.factlibEnsure === lib.ensureLibrary &&
      sandbox.factlibStats === lib.statsOf,
    "factlib* 全局别名逐个指向 MTNodeFactLib 同名方法",
  );
  ok(
    sandbox.factlibDocPaths === lib.docPathsOf &&
      sandbox.factlibListDocs === lib.listDocs &&
      sandbox.factlibEnsureDoc === lib.ensureDocByName &&
      sandbox.factlibRenameDoc === lib.renameDoc &&
      sandbox.factlibRemoveDoc === lib.removeDoc &&
      sandbox.factlibRemoveLib === lib.removeLibrary &&
      sandbox.factlibReconcile === lib.reconcile,
    "factlib* 全局别名（文档路径 / 列表 / 建档 / 改名 / 删除 / 删库 / 自动登记）指向同名方法",
  );
  ok(typeof lib.TEMPLATE === "string" && lib.TEMPLATE.indexOf("# 团队事实库") >= 0, "建库模板可用");
  ok(
    !/[\\/:*?"<>|]/.test(lib.safeName('a/b:c*?"<>|')) && lib.safeName("") === "事实库",
    "safeName 清理非法字符 / 空名回落",
  );
  ok(lib.joinPath("E:\\ws", "团队事实库", "事实库.md") === "E:\\ws\\团队事实库\\事实库.md", "joinPath 保留 Windows 分隔符");
}

/* ===================== [2] 图片相对路径 ⇄ file:// 双向转换幂等 ===================== */
console.log("\n[2] 图片相对路径 ⇄ file:// 双向转换幂等（app-review.js + app-inline-img.js）");
{
  const { rvIsRelSrc, rvFileUrl, rvRewriteImgSrc, inlineToMd } = sandbox;
  ok(typeof rvRewriteImgSrc === "function" && typeof inlineToMd === "function", "转换函数可调用");

  ok(rvIsRelSrc("assets/a.png") === true, "assets/a.png 判为相对引用");
  ok(rvIsRelSrc("./assets/a.png") === true, "./assets/a.png 判为相对引用");
  ok(rvIsRelSrc("file:///E:/x/assets/a.png") === false, "file:/// 判为绝对");
  ok(rvIsRelSrc("E:\\x\\assets\\a.png") === false, "Windows 绝对路径判为绝对");
  ok(rvIsRelSrc("/abs/a.png") === false, "POSIX 绝对路径判为绝对");
  ok(rvIsRelSrc("https://x/a.png") === false && rvIsRelSrc("data:image/png;base64,AA") === false, "http / data 判为绝对");

  ok(rvFileUrl("E:\\x\\a.png") === "file:///E:/x/a.png", "本机路径 → file:/// URL");
  ok(rvFileUrl("file:///E:/x/a.png") === "file:///E:/x/a.png", "已是 file:/// 时原样返回（幂等）");

  /* 打开事实库审阅目标：rvFactPaths 需要 _rv.target（词法绑定，用同上下文脚本设置）。 */
  const factDir = "E:\\ws\\团队事实库";
  sandbox.__T = {
    type: "fact",
    path: factDir + "\\事实库.md",
    fact: { assetsDir: factDir + "\\assets", name: "事实库" },
  };
  vm.runInContext("_rv.target = __T;", sandbox);

  const md1 = "![](assets/a.png)";
  const htmlFromMd = (md) => {
    const m = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(md);
    return '<p><img alt="' + m[1] + '" src="' + m[2] + '"></p>';
  };
  const out1 = rvRewriteImgSrc(htmlFromMd(md1));
  ok(out1.indexOf('data-rv-src="assets/a.png"') >= 0, "渲染时记下原始相对路径（data-rv-src）");
  ok(
    out1.indexOf('src="file:///E:/ws/团队事实库/assets/a.png"') >= 0,
    "相对路径 → 可显示的 file:/// 绝对路径",
  );
  ok(out1.indexOf(' src="assets/a.png"') < 0, "原相对 src 已被替换");

  /* 序列化回 Markdown：优先 data-rv-src → 回到相对路径（往返不改写）。 */
  const tag = /<img\b[^>]*>/i.exec(out1)[0];
  const attrs = {};
  tag.replace(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g, (m, k, v) => {
    attrs[k] = v;
    return m;
  });
  const imgEl = {
    nodeType: 1,
    tagName: "IMG",
    childNodes: [],
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
  const md2 = inlineToMd(imgEl);
  ok(md2 === md1, "file:/// 绝对路径 → 相对路径（往返回到原文）");
  const out2 = rvRewriteImgSrc(htmlFromMd(md2));
  ok(out2 === out1, "md → html → md → html 完全幂等");
  const out3 = rvRewriteImgSrc(out1);
  ok(out3 === out1, "对已渲染 HTML 再跑一次幂等");

  const absIn = '<p><img src="E:/x/a.png"></p>';
  const absOut = rvRewriteImgSrc(absIn);
  ok(absOut.indexOf('src="E:/x/a.png"') >= 0, "绝对路径 src 原样保留");
  ok(absOut.indexOf('data-rv-src="E:/x/a.png"') >= 0, "绝对路径也记下 data-rv-src");
  ok(rvRewriteImgSrc(absOut) === absOut, "绝对路径渲染幂等");
}

/* ===================== [3] GC：保留留存版本引用 / 删除真孤立文件 ===================== */
console.log("\n[3] 孤立图片回收：任一留存版本引用都不删、只删真孤立文件");
{
  const { rvCollectImgRefs, rvRunGc } = sandbox;
  ok(typeof rvCollectImgRefs === "function" && typeof rvRunGc === "function", "GC 函数可调用");

  /* 纯函数：相对路径与文件名两种形态都要收（md 里可能写 assets/x.png 或裸 x.png）。 */
  const refs = rvCollectImgRefs(["![](assets/a.png)", "text ![](b.png) more"]);
  ok(refs.has("assets/a.png") && refs.has("a.png"), "收集原始引用 + 文件名（a.png）");
  ok(refs.has("b.png"), "收集裸文件名引用（b.png）");
  ok(rvCollectImgRefs([]).size === 0 && rvCollectImgRefs([null, ""]).size === 0, "空输入返回空集合");

  const factDir = "E:\\ws\\团队事实库";
  const assetsDir = factDir + "\\assets";
  sandbox.__T2 = {
    type: "fact",
    path: factDir + "\\事实库.md",
    fact: { assetsDir: assetsDir, name: "事实库" },
  };
  /* 版本链：旧版引用 old.png，当前版引用 cur.png；orphan.png 谁都不引用。 */
  sandbox.__D = {
    versions: [
      { text: "V1 ![](assets/old.png)", notes: [], ts: 1 },
      { text: "V2 ![](assets/cur.png)", notes: [], ts: 2 },
    ],
    notesLog: [],
  };
  vm.runInContext("_rv.target = __T2; _rv.doc = __D;", sandbox);

  let list = [
    { name: "old.png", rel: "old.png" },
    { name: "cur.png", rel: "cur.png" },
    { name: "orphan.png", rel: "orphan.png" },
  ];
  const deleted = [];
  api.fileListDir = () => Promise.resolve({ ok: true, list: list });
  api.factDeleteImages = (paths) => {
    deleted.push(paths.slice());
    return Promise.resolve({ ok: true, removed: paths.slice() });
  };

  (async () => {
    await rvRunGc();
    ok(deleted.length === 1, "第一次 GC 只调用一次删除");
    const gone = (deleted[0] || []).map((p) => String(p).replace(/\\/g, "/"));
    ok(gone.length === 1 && /assets\/orphan\.png$/.test(gone[0]), "只删真孤立文件 orphan.png");
    ok(
      gone.every((p) => !/old\.png$/.test(p) && !/cur\.png$/.test(p)),
      "留存版本（旧版 old.png / 当前版 cur.png）引用的文件都不删",
    );

    /* 真孤立文件已删：磁盘列表不再有它 → 第二次 GC 无事可做（不重复删）。 */
    list = list.filter((f) => f.rel !== "orphan.png");
    await rvRunGc();
    ok(deleted.length === 1, "重复 GC 幂等（没有新的删除调用）");

    /* 无留存版本引用任何文件时，全部视为孤立（真删）。 */
    sandbox.__D2 = { versions: [{ text: "无图", notes: [], ts: 3 }], notesLog: [] };
    vm.runInContext("_rv.doc = __D2;", sandbox);
    await rvRunGc();
    ok(deleted.length === 2 && deleted[1].length === 2, "无任何引用时两张图都被回收");
    ok(
      deleted[1].every((p) => /assets\\(old|cur)\.png$/.test(String(p))),
      "回收清单指向 assets 目录下的绝对路径",
    );

    /* ===================== [4] normalizeCanvas 增 fact：旧配置迁移不丢数据 + 幂等 ===================== */
    console.log("\n[4] normalizeCanvas 增 fact 后旧配置迁移不丢数据 + fact 幂等");
    S.config.team = {
      version: 2,
      canvases: [
        {
          id: "cv-old",
          name: "旧画布",
          workspace: "E:/ws/old",
          desc: "旧描述",
          legacy: "keep",
        },
      ],
      experts: [{ id: "e-old", canvasId: "cv-old", name: "旧专家", icon: "code" }],
      chats: [{ id: "c-old", canvasId: "cv-old", expertId: "e-old", title: "旧会话" }],
      categories: [{ id: "cat-1", name: "研发" }],
      templates: [],
    };
    T.ensure(S.config);
    const cv = T.canvas("cv-old");
    ok(
      !!cv && cv.desc === "旧描述" && cv.workspace === "E:/ws/old" && cv.legacy === "keep",
      "旧画布字段（workspace / desc / 未知键）迁移后原样保留",
    );
    ok(cv.fact === null, "缺 fact 的旧配置迁移后 fact 为 null（不伪造记录）");
    ok(!!T.expert("e-old") && !!T.chat("c-old"), "旧专家 / 会话一个不丢");

    const f1 = T.ensureFact("cv-old", {
      name: "事实库",
      file: "E:/ws/old/团队事实库/事实库.md",
      assetsDir: "E:/ws/old/团队事实库/assets",
    });
    ok(!!f1 && !!f1.id && f1.file === "E:/ws/old/团队事实库/事实库.md", "ensureFact 建库成功");
    const f2 = T.ensureFact("cv-old", { name: "另一个名字", file: "E:/other.md" });
    ok(f2.id === f1.id && f2.file === f1.file, "二次 ensureFact 幂等（返回同一记录，不覆盖）");

    T.ensure(S.config);
    const cv2 = T.canvas("cv-old");
    ok(
      !!cv2.fact && cv2.fact.id === f1.id && cv2.fact.file === f1.file,
      "再次 ensure（迁移）不丢 fact",
    );
    ok(cv2.desc === "旧描述" && !!T.expert("e-old") && !!T.chat("c-old"), "再次迁移其余数据不丢");
    const f3 = T.updateFact("cv-old", { model: "m-1" });
    ok(f3.id === f1.id && f3.file === f1.file && f3.model === "m-1", "updateFact 局部补丁不丢既有路径");

    const nf = T.normalizeFact({ file: "E:/x.md", name: "库", extra: "keep" });
    ok(JSON.stringify(T.normalizeFact(nf)) === JSON.stringify(nf), "normalizeFact 幂等（二次归一逐字段相等）");
    ok(nf.extra === "keep" && nf.id && nf.name === "库", "fact 未知键保留 + id / 默认名补齐");
    ok(T.normalizeFact(null) === null && T.normalizeFact(undefined) === null, "无 fact 时归一为 null");
    ok(T.normalizeCanvas({ id: "cv-x", name: "画布" }).fact === null, "normalizeCanvas 无 fact → null");

    /* 旧单文档配置迁移为 docs[0]：单条 file 折进 docs、镜像回写、未知键保留、幂等。 */
    const legacy = T.normalizeFact({
      file: "E:/old/团队事实库/事实库.md",
      name: "旧库",
      extra: "keep",
    });
    ok(Array.isArray(legacy.docs) && legacy.docs.length === 1, "旧单文档配置迁移出 1 篇文档（docs[0]）");
    ok(
      legacy.docs[0].file === "E:/old/团队事实库/事实库.md" && legacy.docs[0].name === "旧库",
      "docs[0] 继承旧 file / name",
    );
    ok(
      legacy.file === legacy.docs[0].file && legacy.reviewFile === legacy.docs[0].reviewFile,
      "库记录 file / reviewFile 镜像首篇文档（旧调用点兼容）",
    );
    ok(legacy.dir === "E:/old/团队事实库", "库目录由首篇文档路径推导");
    ok(legacy.extra === "keep", "旧配置迁移保留未知键");
    ok(
      JSON.stringify(T.normalizeFact(legacy)) === JSON.stringify(legacy),
      "旧配置迁移幂等（二次归一逐字段相等）",
    );

    /* 显式 docs 多文档：顺序与各自 id 原样保留，库级镜像仍指首篇。 */
    const multi = T.normalizeFact({
      name: "多文档库",
      docs: [
        { name: "甲", file: "E:/m/团队事实库/甲.md" },
        { name: "乙", file: "E:/m/团队事实库/乙.md" },
      ],
    });
    ok(
      multi.docs.length === 2 && multi.docs[0].name === "甲" && multi.docs[1].name === "乙",
      "显式 docs 多文档原样保留（顺序不变）",
    );
    ok(multi.file === "E:/m/团队事实库/甲.md", "库记录 file 镜像首篇文档");
    ok(multi.docs[0].id !== multi.docs[1].id, "每篇文档各自独立 id");

    /* 多文档 CRUD 幂等：按名 / 按 id 建档不重复，改名保持 id，删一篇不碰另一篇。 */
    const docN = T.factDocs("cv-old").length;
    const da = T.ensureFactDoc("cv-old", {
      name: "产品规格",
      file: "E:/ws/old/团队事实库/产品规格.md",
    });
    ok(!!da && T.factDocs("cv-old").length === docN + 1, "ensureFactDoc 追加一篇文档");
    ok(
      T.ensureFactDoc("cv-old", { name: "产品规格" }).id === da.id &&
        T.factDocs("cv-old").length === docN + 1,
      "同名再 ensure 幂等（返回同一篇，不重复建）",
    );
    ok(T.ensureFactDoc("cv-old", { id: da.id }).id === da.id, "按 id ensure 幂等");
    ok(T.factDoc("cv-old", da.id).name === "产品规格", "factDoc 按 id 取回该篇");
    const db = T.ensureFactDoc("cv-old", {
      name: "术语表",
      file: "E:/ws/old/团队事实库/术语表.md",
    });
    const upd = T.updateFactDoc("cv-old", db.id, { name: "术语表 v2" });
    ok(upd.name === "术语表 v2" && upd.id === db.id, "updateFactDoc 改名保持 id");
    ok(T.factDoc("cv-old", db.id).name === "术语表 v2", "改名已落库");
    ok(T.removeFactDoc("cv-old", db.id) === true, "removeFactDoc 删一篇");
    ok(
      T.factDoc("cv-old", db.id) === null && !!T.factDoc("cv-old", da.id),
      "删一篇不影响另一篇",
    );
    ok(T.removeFactDoc("cv-old", db.id) === false, "重复删除幂等（返回 false）");
    ok(
      T.fact("cv-old").file === T.factDocs("cv-old")[0].file,
      "库记录 file 镜像始终指向首篇文档",
    );

    /* ===================== [5] expertSystemPrompt 含事实库路径与事实纪律 ===================== */
    console.log("\n[5] expertSystemPrompt 含多文档路径清单与查阅优先级纪律（且不塞库正文）");
    const cvF = T.addCanvas({ id: "wf-fact", name: "事实画布" });
    const fFile = "E:/ws/fact/团队事实库/事实库.md";
    const fDoc2 = "E:/ws/fact/团队事实库/产品规格.md";
    const fAssets = "E:/ws/fact/团队事实库/assets";
    T.ensureFact(cvF.id, { name: "事实库", file: fFile, assetsDir: fAssets });
    T.ensureFactDoc(cvF.id, {
      name: "产品规格",
      file: fDoc2,
      reviewFile: "E:/ws/fact/团队事实库/产品规格.review.json",
    });
    const e = T.addExpert({ canvasId: cvF.id, name: "研究员", icon: "search", role: "研究" });
    const sys = T.expertSystemPrompt(e);
    ok(sys.indexOf("你是「研究员」") >= 0, "人设段仍在（事实库注入是追加）");
    ok(sys.indexOf(fFile) >= 0 && sys.indexOf(fDoc2) >= 0, "系统提示含库内每篇文档的绝对路径（多文档清单）");
    ok(
      sys.indexOf("产品规格") >= 0 && sys.indexOf(fDoc2) > sys.indexOf("产品规格"),
      "清单按「文档名 → 绝对路径」列出",
    );
    ok(sys.indexOf(fAssets) >= 0, "系统提示含库级共享图片目录");
    ok(
      sys.indexOf("团队事实库（本团队共享的事实来源；正文按需用文件读取工具查阅，不要凭空作答）：") >= 0,
      "标注事实库用途 + 查阅方式",
    );
    ok(
      sys.indexOf("事实库目录（新文档写这里）：") >= 0 &&
        sys.indexOf("共享图片目录（全部文档共用）：") >= 0,
      "给出建档目录与共享图片目录",
    );
    ok(sys.indexOf("查阅与建档纪律：") >= 0, "含查阅与建档纪律段");
    ok(
      sys.indexOf("① 回答事实性问题前，先读上面最相关的那一篇文档") >= 0,
      "纪律①：优先查阅事实库最相关的那一篇",
    );
    ok(sys.indexOf("② 库中信息不足时，再查阅项目内容") >= 0, "纪律②：库中信息不足再查项目内容");
    ok(
      sys.indexOf("③ 仍不足时") >= 0 && sys.indexOf("事实库中没有该信息") >= 0,
      "纪律③：仍不足直说并请用户补充 / 确认建档",
    );
    ok(
      sys.indexOf("④ 对话中发现稳定事实要同步维护事实库") >= 0,
      "纪律④：对话中同步建档 / 就地更新",
    );
    ok(sys.indexOf("库中没有的内容不得编造") >= 0, "含事实纪律：不编造");
    ok(sys.indexOf("相对路径引用") >= 0, "含「引用图片用相对路径」纪律");
    ok(sys.indexOf("# 团队事实库") < 0, "不把库正文塞进系统提示（只给路径，省 token）");

    /* 未建库的画布：整段省略，免得模型去找不存在的文件。 */
    const cvN = T.addCanvas({ id: "wf-nofact", name: "无库画布" });
    const eN = T.addExpert({ canvasId: cvN.id, name: "无库专家", icon: "code" });
    const sysN = T.expertSystemPrompt(eN);
    ok(sysN.indexOf("团队事实库（本团队共享的事实来源") < 0, "未建库时不注入事实库段");
    ok(sysN.indexOf("你是「无库专家」") >= 0, "未建库时人设段照常");

    /* ===================== [5b] 写根下发：单聊 / 群聊都带库目录与文档目录 ===================== */
    console.log("\n[5b] 专家运行时参数：事实库写根 + 权限档（单聊与群聊同口径）");
    const eW = T.addExpert({ canvasId: cvF.id, name: "写手", icon: "pen", role: "撰稿" });
    const eWChat = T.addChat({ canvasId: cvF.id, expertId: eW.id, title: "单聊" });
    const eWGroup = T.addGroupChat({ canvasId: cvF.id, participants: [eW.id] });
    const roots = T.factWriteRoots(eW);
    ok(roots.indexOf("E:/ws/fact/团队事实库") >= 0, "写根含库目录（专家建档直接放行）");
    ok(roots.indexOf(fAssets) >= 0, "写根含库级共享图片目录");
    ok(roots.indexOf(fAssets) >= 0 && roots.length >= 2, "写根去重且非空");
    const pSingle = T.expertRunParams(eWChat, eW, {});
    const pGroup = T.expertRunParams(eWGroup, eW, {});
    ok(
      !!pSingle.writeRoots && pSingle.writeRoots.length === roots.length,
      "单聊：writeRoots 随本轮下发（app-db.js 按 runKey 自动放行库内写入）",
    );
    ok(
      !!pGroup.writeRoots && pGroup.writeRoots.join("|") === pSingle.writeRoots.join("|"),
      "群聊：writeRoots 与单聊完全同口径",
    );
    ok(pSingle.writeRoots.indexOf(fAssets) >= 0, "单聊写根含图片目录");
    ok(pGroup.writeRoots.indexOf(fAssets) >= 0, "群聊写根含图片目录");
    ok(
      pSingle.permissionPreset === "workspace-write" &&
        pGroup.permissionPreset === "workspace-write",
      "有写根时权限档从 mtnode-unattended 抬到 workspace-write（升权审批有人可问，单聊 / 群聊同口径）",
    );
    ok(
      pSingle.toolPolicy.fs_write === "allow" && pGroup.toolPolicy.fs_write === "allow",
      "单聊 / 群聊都放行写文件（专家开箱即可读写事实库）",
    );
    /* 库内文档落在库子目录时，该子目录也必须是写根 —— 只授权库根会让它被判成写根外。 */
    const cvSub = T.addCanvas({ id: "wf-fact-sub", name: "子目录画布" });
    T.ensureFact(cvSub.id, {
      name: "事实库",
      dir: "E:/ws/sub/团队事实库",
      assetsDir: "E:/ws/sub/团队事实库/assets",
    });
    T.ensureFactDoc(cvSub.id, {
      name: "专题",
      file: "E:/ws/sub/团队事实库/专题/专题.md",
      reviewFile: "E:/ws/sub/团队事实库/专题/专题.review.json",
    });
    const eSub = T.addExpert({ canvasId: cvSub.id, name: "专题专家", icon: "book" });
    ok(
      T.factWriteRoots(eSub).indexOf("E:/ws/sub/团队事实库/专题") >= 0,
      "文档位于库子目录时，该子目录一并进写根",
    );

    /* ===================== [5c] 宿主自动放行：正斜杠绝对路径与理由文本不否决 ===================== */
    console.log("\n[5c] app-db.js 事实库写根自动放行（真实函数切片：路径判定 + 理由文本不否决）");
    const dbSrc = read("renderer/app-db.js");
    const sliceBetween = (startMark, endMark) => {
      const a = dbSrc.indexOf(startMark);
      const b = dbSrc.indexOf(endMark);
      if (a < 0 || b < 0 || b <= a) return "";
      return dbSrc.slice(a, b);
    };
    /* 两段互不相连的顶层函数各自切片，同一个 vm 上下文里求值（声明提升保证互相可见）。 */
    const writerootSrc =
      sliceBetween("function setRunWriteRoots(runKey, roots) {", "/* 单次运行（一次请求 = 一轮）") +
      sliceBetween("function normFsPath(p) {", "function pickOutsidePathRoot(paths, workspace) {");
    ok(writerootSrc.indexOf("function autoApproveRunWrite(") >= 0, "取到 app-db.js 写根与自动放行实现切片");
    const dbSand = {
      console,
      Set,
      Promise,
      S: { _runWriteRoots: null },
      agentToolMode: () => "allow",
      interactions: [],
      /* dshSandboxApproval 的「已记住」提示走 toast；这里只记调用，不渲染 */
      toasts: [],
      I18n: { t: (s) => String(s) },
    };
    dbSand.toast = (msg) => dbSand.toasts.push(String(msg));
    dbSand.window = {
      api: {
        dshInteract: (p) => {
          dbSand.interactions.push(p);
          return Promise.resolve({ ok: true });
        },
      },
    };
    vm.createContext(dbSand);
    vm.runInContext(writerootSrc, dbSand, { filename: "app-db-writeroots-slice.js" });
    const RUNKEY = "team:chat1:exp1";
    dbSand.setRunWriteRoots(RUNKEY, ["E:\\ws\\团队事实库", "E:\\ws\\团队事实库\\assets"]);
    ok(
      dbSand.runWriteRootsOf(RUNKEY).length === 2,
      "setRunWriteRoots 按 runKey 装好事实库写根",
    );
    /* 正斜杠绝对路径（模型最常见写法）必须判为绝对、且落在写根内 → 自动放行。 */
    dbSand.interactions.length = 0;
    const approved = dbSand.autoApproveRunWrite(
      { id: "ap1", callId: "tc1", reason: "escalate sandbox to danger-full-access: 写入事实库新文档" },
      RUNKEY,
      "E:\\canvas",
      {
        tc1: JSON.stringify({
          file_path: "E:/ws/团队事实库/新主题.md",
          content: "# 事实",
          sandbox_permissions: "danger-full-access",
          justification: "写入事实库新文档",
        }),
      },
    );
    ok(approved === true, "库内写入（正斜杠 file_path）自动放行");
    ok(
      dbSand.interactions.length === 1 &&
        dbSand.interactions[0].kind === "approval" &&
        dbSand.interactions[0].id === "ap1" &&
        dbSand.interactions[0].outcome === "allowed-once",
      "自动放行 = 直接回 allowed-once（专家不再逐次弹审批卡）",
    );
    /* 升权理由里顺带提到写根外的路径，不得否决这次库内写入（修的就是这条）。 */
    dbSand.interactions.length = 0;
    ok(
      dbSand.autoApproveRunWrite(
        { id: "ap2", callId: "tc2", reason: "escalate sandbox to danger-full-access: 写入事实库；先前读过 E:\\其它\\笔记.md" },
        RUNKEY,
        "E:\\canvas",
        {
          tc2: JSON.stringify({
            file_path: "E:\\ws\\团队事实库\\资产.md",
            sandbox_permissions: "danger-full-access",
            justification: "写入事实库新文档；先前读过 E:\\其它\\笔记.md",
          }),
        },
      ) === true,
      "升权理由提到写根外路径时，仍按调用自身目标路径放行（理由文本不否决）",
    );
    /* 写根外 / 无写根 / 非升权审批：一律不放行（保守口径不放松）。 */
    dbSand.interactions.length = 0;
    ok(
      dbSand.autoApproveRunWrite(
        { id: "ap3", callId: "tc3", reason: "escalate sandbox to danger-full-access: 改别的文件" },
        RUNKEY,
        "E:\\canvas",
        { tc3: JSON.stringify({ file_path: "E:/other/note.md" }) },
      ) === false && dbSand.interactions.length === 0,
      "写根外的写入不放行（照旧人工审批）",
    );
    ok(
      dbSand.autoApproveRunWrite(
        { id: "ap4", callId: "tc4", reason: "escalate sandbox to danger-full-access: 写入事实库" },
        "team:无写根:exp",
        "E:\\canvas",
        { tc4: JSON.stringify({ file_path: "E:/ws/团队事实库/x.md" }) },
      ) === false,
      "该 runKey 没装写根 → 不放行",
    );
    ok(
      dbSand.autoApproveRunWrite(
        { id: "ap5", callId: "tc5", reason: "危险操作确认" },
        RUNKEY,
        "E:\\canvas",
        { tc5: JSON.stringify({ file_path: "E:/ws/团队事实库/x.md" }) },
      ) === false,
      "非沙箱升权审批（理由不是 escalate sandbox to …）不接管",
    );

    /* ===================== [5d] 沙箱拒绝：本会话放行记忆 + 卡片文案 ===================== */
    console.log("\n[5d] app-db.js 沙箱拒绝询问（「本会话后续都放行」记忆）");
    const sandSrc = sliceBetween(
      "function dshSandboxEscalationReason(data) {",
      "/* 单次运行（一次请求 = 一轮）",
    );
    ok(
      sandSrc.indexOf("function dshAutoApproveSandboxSession(") >= 0 &&
        sandSrc.indexOf("function dshApproveSandboxSession(") >= 0,
      "取到沙箱放行记忆实现切片",
    );
    vm.runInContext(sandSrc, dbSand, { filename: "app-db-sandbox-session-slice.js" });
    const SB_KEEP = { id: "sb1", toolName: "write", reason: "escalate sandbox to danger-full-access: 写库外文件" };
    const SB_SKIP = { id: "sb2", toolName: "write", reason: "escalate sandbox to workspace-write: 同一模式" };
    dbSand.interactions.length = 0;
    ok(
      dbSand.dshAutoApproveSandboxSession(SB_KEEP, RUNKEY) === false &&
        dbSand.interactions.length === 0,
      "没有本会话放行记忆 → 不接管，沙箱拒绝照旧弹卡片问用户",
    );
    ok(
      dbSand.dshApproveSandboxSession({ data: SB_KEEP, runKey: RUNKEY }) === undefined &&
        dbSand.interactions.length === 1 &&
        dbSand.interactions[0].outcome === "allowed-once",
      "点「本会话后续都放行」= 记住 + 本次回 allowed-once",
    );
    dbSand.interactions.length = 0;
    ok(
      dbSand.dshAutoApproveSandboxSession({ id: "sb3", reason: SB_KEEP.reason }, RUNKEY) === true &&
        dbSand.interactions.length === 1 &&
        dbSand.interactions[0].outcome === "allowed-once",
      "同会话同类沙箱升权不再弹卡，直接放行",
    );
    dbSand.interactions.length = 0;
    ok(
      dbSand.dshAutoApproveSandboxSession(SB_SKIP, RUNKEY) === false &&
        dbSand.interactions.length === 0,
      "升到不同沙箱模式仍要询问（放行记忆不外溢）",
    );
    ok(
      dbSand.dshAutoApproveSandboxSession(SB_KEEP, "team:别的会话:exp2") === false,
      "放行记忆按 runKey 隔离，别的会话不受影响",
    );
    ok(
      dbSand.dshAutoApproveSandboxSession(
        { id: "sb4", reason: "危险操作确认：删库" },
        RUNKEY,
      ) === false,
      "非沙箱升权审批（理由不是 escalate sandbox to …）不接管",
    );
    const sbInfo = dbSand.dshSandboxAskInfo({
      id: "sb5",
      reason: "escalate sandbox to workspace-write: 写入画布工作区外的项目目录",
    });
    ok(
      !!sbInfo &&
        sbInfo.mode === "workspace-write" &&
        sbInfo.justification.indexOf("项目目录") >= 0 &&
        dbSand.dshSandboxAskInfo({ id: "sb6", reason: "工具许可" }) === null,
      "卡片信息：认出升权目标模式与理由，普通审批不误判",
    );

    /* ── 网关侧契约：沙箱拒绝必须能问到用户 ──
       approval 基础层与默认档都必须是 ask：never 会在审批服务里直接判 rejected
       （进不了 answerer），沙箱拒绝就永远到不了宿主 UI，模型只看到一句失败。 */
    const CORDIS = read("dsh/gateway/cordis.yml");
    const approvalRow = CORDIS.slice(
      CORDIS.indexOf("- id: approval"),
      CORDIS.indexOf("- id: permission"),
    );
    ok(
      /policy:\s*ask/.test(approvalRow) && !/policy:\s*never/.test(approvalRow),
      "cordis 审批基础层 = ask（否则沙箱拒绝被自动拒绝，弹不出询问）",
    );
    const unattendedRow = CORDIS.slice(
      CORDIS.indexOf("mtnode-unattended:"),
      CORDIS.indexOf("defaultPreset:"),
    );
    ok(
      /sandbox:\s*workspace-write/.test(unattendedRow) &&
        /approval:\s*ask/.test(unattendedRow),
      "默认档 mtnode-unattended = workspace-write + ask（限制不放松，只把拒绝改成询问）",
    );

    /* ===================== [6] 新词条在中英词表都有 ===================== */
    console.log("\n[6] 新词条在中英词表都有");
    const I18n = require("../renderer/i18n.js");
    const keys = new Set();
    const re = /\bT\(\s*(["'])((?:[^"'\\\n]|\\.)*?)\1\s*\)/g;
    let m;
    const factSrc = read("renderer/app-factlib.js");
    while ((m = re.exec(factSrc))) keys.add(m[2]);
    [
      /* 专家系统提示（app-team.js factLibNote）：多文档清单 + 查阅优先级纪律 */
      "团队事实库（本团队共享的事实来源；正文按需用文件读取工具查阅，不要凭空作答）：",
      "事实库目录（新文档写这里）：",
      "共享图片目录（全部文档共用）：",
      "查阅与建档纪律：",
      "① 回答事实性问题前，先读上面最相关的那一篇文档，以库中记录为准；库中没有的内容不得编造。",
      "② 库中信息不足时，再查阅项目内容（工作区文件）补充。",
      "③ 仍不足时，明确告知「事实库中没有该信息」，并请用户补充或确认建档 —— 不得凭记忆或推测作答。",
      "④ 对话中发现稳定事实要同步维护事实库：新主题新建独立文档（文档间内容不重叠、各司其职），已有主题就地更新对应文档；正文写进文档，不要塞进提示词。",
      "事实库目录对你有写权限：新建 / 更新文档直接写入上述路径；若首次写入被沙箱拒绝，按工具提示用 sandbox_permissions + justification 原样重试一次即可（该目录已获授权，不会打扰用户）。",
      "引用图片时按 md 里的相对路径引用，不要改写成本机绝对路径。",
      /* 左栏事实库分组与文档子行（app-teamview.js）：库行「打开文件夹 + 新建文档」，
         文档行只显示更新时间（刚刚 / N 分钟前 / N 小时前 / 本地日期时间），不再有字数与图片数 */
      "未建库",
      "{n} 篇",
      "打开所在文件夹",
      "新建文档",
      "例如：产品规格",
      "已新建文档「{name}」",
      "新建文档失败",
      "事实库模块未就绪，无法新建文档",
      "文档名称",
      "文档",
      "读取中…",
      "刚刚",
      " 分钟前",
      " 小时前",
      "空",
      "重命名文档",
      "删除文档",
      "由专家建档或手动新建",
      "事实库模块未就绪，无法打开审阅",
      "审阅模块未就绪，无法打开事实库",
      "该文档还没有正文文件",
      "当前没有画布，无法创建事实库",
      "事实库创建失败",
      "重命名事实库",
      "删除事实库",
      /* 插图 / GC（app-review.js） */
      "已从磁盘删除 ",
      " 个无引用图片",
      "图片会复制到事实库的 assets 目录，正文以相对路径引用",
      /* 沙箱放行卡片（app-db.js renderIxPanel / dshApproveSandboxSession） */
      "本会话后续都放行",
      "本会话后续同类沙箱放行已记住：",
      "沙箱拒绝了这次访问，请确认是否放行。目标权限：",
      "「允许一次」仅这次的调用有效；「本会话后续都放行」记住后，本会话里同类沙箱放行不再询问；「拒绝」则阻止本次调用。",
      "无人值守（工作区读写 · 沙箱拒绝时询问，默认）",
    ].forEach((k) => keys.add(k));
    ok(keys.size >= 10, "抠到 " + keys.size + " 条事实库文案（≥10）");
    ok(
      read("renderer/i18n.js").indexOf('"{c} 字 · {i} 图"') < 0,
      "i18n 已删除「{c} 字 · {i} 图」词条（不再显示图片数）",
    );

    I18n.setLocale("zh");
    let zhBroken = 0;
    for (const k of keys) if (I18n.t(k) !== k) zhBroken++;
    ok(zhBroken === 0, "中文界面原样显示（词表只做 zh → en 单向映射）");

    I18n.setLocale("en");
    const missing = [];
    for (const k of keys) {
      const v = I18n.t(k);
      if (v === k || !String(v).trim()) missing.push(k);
    }
    ok(
      missing.length === 0,
      "英文界面无回落中文" +
        (missing.length
          ? "（缺 " + missing.length + " 条：" + missing.slice(0, 5).join(" / ") + "…）"
          : ""),
    );

    /* ===================== [7] reconcile：扫库目录自动登记新 .md（幂等）+ statsOf 带 mtime ===================== */
    console.log("\n[7] reconcile：扫库目录自动登记新 .md（added / 幂等）+ statsOf 带 mtime");
    {
      const cvRec = T.addCanvas({ id: "wf-rec", name: "自动登记画布" });
      const recDir = "E:/ws/rec/团队事实库";
      T.ensureFact(cvRec.id, {
        name: "事实库",
        dir: recDir,
        assetsDir: recDir + "/assets",
      });
      const recList = [
        { name: "甲.md", rel: "甲.md" },
        { name: "乙.md", rel: "乙.md" },
        { name: "assets", rel: "assets", isDir: true },
        { name: "甲.review.json", rel: "甲.review.json" },
      ];
      api.fileListDir = () => Promise.resolve({ ok: true, list: recList });

      const r1 = await lib.reconcile(cvRec.id);
      ok(r1.added === 2, "库目录里 2 篇 .md → 登记 added=2");
      const docs = T.factDocs(cvRec.id);
      ok(docs.length === 2, "两篇文档都进了配置 docs[]");
      ok(
        docs.some((d) => d.name === "甲") && docs.some((d) => d.name === "乙"),
        "文档名取自文件名（甲 / 乙）",
      );
      ok(
        docs.every((d) => /\.md$/.test(d.file) && !/review\.json$/.test(d.file)),
        "登记项只指向 .md（跳过 assets/ 与 *.review.json）",
      );

      const r2 = await lib.reconcile(cvRec.id);
      ok(r2.added === 0, "再跑一次 added=0（幂等，不重复登记）");
      ok(T.factDocs(cvRec.id).length === 2, "幂等：文档数不变");

      api.fileStat = () => Promise.resolve({ ok: true, mtime: 1700000000000 });
      const st = await lib.statsOf(docs[0]);
      ok(st.mtime === 1700000000000, "statsOf 带磁盘 mtime（文档行更新时间用）");
      ok(
        typeof st.chars === "number" && typeof st.exists === "boolean",
        "statsOf 仍带 chars / exists",
      );
    }

    /* ===================== [8] resolvePaths 落点守卫（应用目录 / 项目源码目录） ===================== */
    console.log(
      "\n[8] resolvePaths 落点守卫（应用目录 / 开发节点项目根 / 无画布文件夹时的选择）",
    );
    {
      const APP_ROOT = "E:\\app\\console";
      const key = (p) =>
        String(p || "")
          .replace(/[\\/]+/g, "/")
          .replace(/\/+$/, "")
          .toLowerCase();
      const inApp = (p) => {
        const k = key(p);
        const base = key(APP_ROOT);
        return !!k && (k === base || k.indexOf(base + "/") === 0);
      };
      /* 画布文件夹解析入口（app-team.js 提供）；本用例直接替换成可控桩。 */
      let wsVal = "";
      sandbox.teamCanvasWorkspace = () => wsVal;
      /* 画布文件夹为空时弹出的目录选择：默认取消（返回空），可按用例改 picked。 */
      let picked = "";
      let picks = 0;
      api.fileOpenDialog = () => {
        picks++;
        return Promise.resolve({ path: picked });
      };

      /* 情形一：画布文件夹本身就在应用目录内 → 解析结果必落在应用目录内 → 拒绝（null）。 */
      wsVal = APP_ROOT;
      const pA = await lib.resolvePaths("wf-app-ws", {});
      ok(pA === null, "画布文件夹 = 应用目录根 → resolvePaths 返回 null（拒绝）");
      wsVal = APP_ROOT + "\\proj";
      const pA2 = await lib.resolvePaths("wf-app-ws-sub", {});
      ok(pA2 === null, "画布文件夹 = 应用目录子目录 → resolvePaths 返回 null（拒绝）");

      /* 情形二：画布文件夹 = 该画布的开发节点项目根（app 源码目录）→ 同样拒绝：
         这就是「库被跟着 devPath 拽进开发项目目录」的入口。 */
      sandbox.teamFactDevRoot = () => "E:\\dev\\tools\\pipeline-console";
      wsVal = "E:\\dev\\tools\\pipeline-console";
      const pDev = await lib.resolvePaths("wf-devroot", {});
      ok(pDev === null, "画布文件夹 = 开发节点项目根（源码目录）→ 返回 null（拒绝）");
      wsVal = "E:\\dev\\tools\\pipeline-console\\renderer";
      const pDev2 = await lib.resolvePaths("wf-devroot-sub", {});
      ok(pDev2 === null, "画布文件夹 = 项目源码目录子目录 → 返回 null（拒绝）");

      /* 画布文件夹恰好落在禁区时，让用户另选一个（只重试一次）→ 按重选目录落库。 */
      picked = "E:\\dev\\tools\\canvas-ok";
      const pReselect = await lib.resolvePaths("wf-devroot-reselect", {});
      ok(
        !!pReselect && key(pReselect.dir) === "e:/dev/tools/canvas-ok/团队事实库",
        "画布文件夹落在禁区 → 用户重选合规目录后按该目录落库",
      );
      picked = "";

      /* 情形三：没有画布文件夹 —— 静默模式直接放弃；非静默弹目录选择。 */
      sandbox.teamFactDevRoot = () => "";
      wsVal = "";
      const pB = await lib.resolvePaths("wf-empty", { silent: true });
      ok(pB === null, "无画布文件夹 + 静默模式 → 返回 null（不猜路径）");

      picked = "";
      picks = 0;
      const pCancel = await lib.resolvePaths("wf-empty-cancel", {});
      ok(
        pCancel === null && picks === 1,
        "无画布文件夹 + 用户取消目录选择 → 返回 null（建库失败，不落应用数据目录）",
      );

      /* 情形四：用户为这张画布选了文件夹 → <该文件夹>/团队事实库（写进库记录，不动工作区）。 */
      const cvPick = T.addCanvas({ id: "wf-pick", name: "选题画布" });
      picked = "E:\\dev\\tools\\tutorial\\mtnode_arch";
      const pPick = await lib.resolvePaths(cvPick.id, {});
      ok(
        !!pPick &&
          key(pPick.dir) === "e:/dev/tools/tutorial/mtnode_arch/团队事实库",
        "用户选定画布文件夹 → 解析出 <画布文件夹>/团队事实库",
      );
      ok(
        T.factWorkspace(cvPick.id) === "",
        "不动画布 / 会话工作区（库落点只写进库记录，不改专家会话落盘目录）",
      );

      /* 情形五：旧的全局「项目文件夹根」不再参与事实库落点。 */
      S.config.projectsRoot = "E:\\dev\\tools\\pipeline-console";
      picked = "";
      const pRoot = await lib.resolvePaths("wf-empty-root", {});
      ok(
        pRoot === null,
        "无画布文件夹时不再回落到全局项目文件夹根（旧口径已废弃）",
      );
      delete S.config.projectsRoot;

      /* 总断言：以上全部结果要么 null，要么绝不在应用目录内。 */
      const all = [pA, pA2, pDev, pDev2, pB, pCancel, pPick, pRoot];
      ok(
        all.every((p) => p === null || !inApp(p.dir)),
        "resolvePaths 的任何返回都不是应用目录路径",
      );
    }

    /* ===================== [9] 库落画布文件夹（不含开发节点项目根）+ 历史错位迁移 ===================== */
    console.log(
      "\n[9] 事实库工作区 = 画布文件夹（不吃项目根）+ relocateLibrary 历史错位迁移",
    );
    {
      const key = (p) =>
        String(p || "")
          .replace(/[\\/]+/g, "/")
          .replace(/\/+$/, "")
          .toLowerCase();
      /* 真实接线：resolvePaths 只认 teamCanvasWorkspace，它现在指向 app-team 的 factWorkspace。 */
      sandbox.teamCanvasWorkspace = sandbox.MTNodeTeam.factWorkspace;
      sandbox.teamFactDevRoot = sandbox.MTNodeTeam.factDevRoot;
      ok(
        sandbox.teamCanvasWorkspace === sandbox.MTNodeTeam.factWorkspace &&
          typeof sandbox.teamCanvasWorkspace === "function",
        "window.teamCanvasWorkspace 指向 factWorkspace（事实库专用的画布文件夹口径）",
      );

      ok(
        typeof sandbox.teamFactDevRoot === "function" &&
          sandbox.teamFactDevRoot === sandbox.MTNodeTeam.factDevRoot,
        "window.teamFactDevRoot 指向 factDevRoot（错位体检用的开发节点项目根）",
      );

      /* 磁盘桩：只有登记在表里的路径算「存在」（迁移分支靠它区分源 / 目标）。 */
      const existing = {};
      api.fileExists = (p) => Promise.resolve(!!existing[key(p)]);

      const cvWs = T.addCanvas({ id: "wf-fw", name: "画布文件夹画布" });
      /* 该画布工作目录 = 画布文件夹；同时把「项目根」桩造成应用源码目录。 */
      S.wf = { id: cvWs.id, name: "画布文件夹画布", workspace: "E:/canvas/folder" };
      sandbox.dshWorkspaceOfWf = () => "E:/app/src";
      sandbox.S.dshWorkspaceFallback = "E:/data/dsh-workspace";
      ok(
        key(T.factWorkspace(cvWs.id)) === "e:/canvas/folder",
        "factWorkspace = 该画布工作目录（画布文件夹）",
      );
      ok(
        key(T.canvasWorkspace(cvWs.id)) === "e:/app/src",
        "关键回归：canvasWorkspace（专家轮次用）仍优先项目根 —— 事实库不再跟着它走",
      );
      ok(
        key(T.factWorkspace(cvWs.id)) !== key(T.canvasWorkspace(cvWs.id)),
        "同一张项目画布：事实库落画布文件夹，不再落项目（应用源码）目录",
      );
      /* 锚点手填仍然压过画布工作目录。 */
      T.updateCanvas(cvWs.id, { workspace: "E:/hand/fact" });
      ok(key(T.factWorkspace(cvWs.id)) === "e:/hand/fact", "锚点手填 workspace 仍优先于画布工作目录");

      /* —— 历史错位：库记录已写进应用目录 → 体检出问题，确认后整库搬迁 + 配置改到位 —— */
      const wfApp = T.addCanvas({ id: "wf-app", name: "错位画布" });
      S.wf = { id: wfApp.id, name: "错位画布", workspace: "E:/canvas/folder" };
      const oldDir = "E:\\app\\console\\团队事实库";
      T.ensureFact(wfApp.id, {
        name: "事实库",
        dir: oldDir,
        assetsDir: oldDir + "\\assets",
        docs: [
          {
            id: "fdoc-1",
            name: "test",
            file: oldDir + "\\test.md",
            reviewFile: oldDir + "\\test.review.json",
          },
        ],
      });
      const moves = [];
      api.factRelocateLibrary = (o) => {
        moves.push(o);
        return Promise.resolve({ ok: true, moved: true });
      };
      existing[key(oldDir)] = true;

      /* 无界面 / 未确认：绝不静默搬迁。 */
      const noAsk = await lib.relocateLibrary(wfApp.id);
      ok(noAsk === false && moves.length === 0, "无确认（confirmDialog 缺失）→ 不搬迁");
      ok(
        key(T.fact(wfApp.id).dir) === key(oldDir),
        "未搬迁时配置保持原样（不擅自动用户数据）",
      );

      const moved = await lib.relocateLibrary(wfApp.id, { assumeYes: true });
      ok(moved === true, "确认后 relocateLibrary 返回 true（已迁移）");
      ok(moves.length === 1, "整库搬迁只调一次 fact:relocateLibrary");
      ok(
        key(moves[0].from) === key(oldDir) &&
          key(moves[0].to) === "e:/canvas/folder/团队事实库",
        "搬迁入参 = 旧应用目录 → 画布文件夹下的「团队事实库」",
      );
      const nf = T.fact(wfApp.id);
      ok(
        key(nf.dir) === "e:/canvas/folder/团队事实库" &&
          key(nf.assetsDir) === "e:/canvas/folder/团队事实库/assets",
        "配置 dir / assetsDir 改到画布文件夹",
      );
      ok(
        key(nf.docs[0].file) === "e:/canvas/folder/团队事实库/test.md" &&
          key(nf.docs[0].reviewFile) === "e:/canvas/folder/团队事实库/test.review.json",
        "每篇文档的 file / reviewFile 一并改到新目录（保留原文件名）",
      );
      ok(
        key(nf.file) === "e:/canvas/folder/团队事实库/test.md",
        "库记录首篇镜像同步",
      );

      /* 已正确落位的库：体检直接放行，不再打扰用户。 */
      const before = moves.length;
      const again = await lib.relocateLibrary(wfApp.id, { assumeYes: true });
      ok(again === false && moves.length === before, "库已在画布文件夹 → 体检放行（幂等，不再搬迁）");
      ok(
        typeof sandbox.factlibRelocate === "function" &&
          sandbox.factlibRelocate === lib.relocateLibrary,
        "全局别名 factlibRelocate 指向 relocateLibrary",
      );

      /* —— 情形二：库跟着开发节点项目根跑（源码目录，打包态不在应用目录内）——
         旧口径下这种错位永远体检不出来，库就一直留在开发项目目录里。 */
      const DEV_ROOT = "E:\\dev\\tools\\pipeline-console";
      sandbox.devProjectRootOf = () => DEV_ROOT;
      const wfDev = T.addCanvas({ id: "wf-dev", name: "开发画布" });
      S.wf = { id: wfDev.id, name: "开发画布", workspace: "E:/canvas/dev-folder" };
      const devDir = DEV_ROOT + "\\团队事实库";
      T.ensureFact(wfDev.id, {
        name: "事实库",
        dir: devDir,
        assetsDir: devDir + "\\assets",
        docs: [
          {
            id: "fdoc-dev",
            name: "笔记",
            file: devDir + "\\笔记.md",
            reviewFile: devDir + "\\笔记.review.json",
          },
        ],
      });
      existing[key(devDir)] = true;
      ok(
        (await lib.misplacedReason(devDir, wfDev.id)) === "dev",
        "库落在开发节点项目根内 → misplacedReason = dev（错位可识别）",
      );
      const n0 = moves.length;
      const movedDev = await lib.relocateLibrary(wfDev.id, { assumeYes: true });
      ok(movedDev === true && moves.length === n0 + 1, "跟着项目根跑的库也会被体检出来并搬迁");
      ok(
        key(moves[n0].to) === "e:/canvas/dev-folder/团队事实库",
        "搬迁目标 = 该画布的画布文件夹（不是项目根）",
      );
      delete existing[key(devDir)];
      ok(
        key(T.fact(wfDev.id).dir) === "e:/canvas/dev-folder/团队事实库",
        "配置改到画布文件夹（开发项目目录里不再有库记录）",
      );

      /* —— 情形三：源目录已被手删 / 配置还指着旧路 → 只重定位，不调主进程搬迁 —— */
      const wfGone = T.addCanvas({ id: "wf-gone", name: "源已不在的画布" });
      S.wf = { id: wfGone.id, name: "源已不在的画布", workspace: "E:/canvas/gone-folder" };
      const goneDir = "E:\\app\\console\\gone\\团队事实库";
      T.ensureFact(wfGone.id, {
        name: "事实库",
        dir: goneDir,
        assetsDir: goneDir + "\\assets",
        docs: [
          {
            id: "fdoc-gone",
            name: "旧稿",
            file: goneDir + "\\旧稿.md",
            reviewFile: goneDir + "\\旧稿.review.json",
          },
        ],
      });
      const n1 = moves.length;
      const movedGone = await lib.relocateLibrary(wfGone.id, { assumeYes: true });
      ok(
        movedGone === true && moves.length === n1,
        "源目录已不存在 → 只改配置重定位（不再调主进程搬迁）",
      );
      ok(
        key(T.fact(wfGone.id).dir) === "e:/canvas/gone-folder/团队事实库",
        "重定位后配置指向画布文件夹",
      );

      /* —— 情形四：目标里已有同名库 → 不搬不覆盖，改用画布文件夹里已有的那份 —— */
      const wfHave = T.addCanvas({ id: "wf-have", name: "目标已有库的画布" });
      S.wf = { id: wfHave.id, name: "目标已有库的画布", workspace: "E:/canvas/have-folder" };
      const haveFrom = "E:\\app\\console\\have\\团队事实库";
      const haveTo = "E:\\canvas\\have-folder\\团队事实库";
      T.ensureFact(wfHave.id, {
        name: "事实库",
        dir: haveFrom,
        assetsDir: haveFrom + "\\assets",
        docs: [
          {
            id: "fdoc-have",
            name: "甲",
            file: haveFrom + "\\甲.md",
            reviewFile: haveFrom + "\\甲.review.json",
          },
        ],
      });
      existing[key(haveFrom)] = true;
      existing[key(haveTo)] = true;
      const n2 = moves.length;
      const movedHave = await lib.relocateLibrary(wfHave.id, { assumeYes: true });
      ok(
        movedHave === true && moves.length === n2,
        "目标已有同名库 → 不搬（不合并、不覆盖），只改用它",
      );
      ok(
        key(T.fact(wfHave.id).dir) === key(haveTo),
        "配置指向画布文件夹里已有的库",
      );
    }

    /* ===================== [11] 删除 → 系统回收站（单篇 / 整库） ===================== */
    console.log("\n[11] 删除事实库：主进程搬进系统回收站，渲染层只摘配置记录");
    {
      /* 主进程：fact:removeLibrary 必须走 shell.trashItem，不再 unlinkSync / rmSync 硬删。 */
      const mainSrc = read("main.js");
      const hAt = mainSrc.indexOf('ipcMain.handle("fact:removeLibrary"');
      ok(hAt > 0, "main.js 有 fact:removeLibrary 处理器");
      const hSeg = hAt > 0 ? mainSrc.slice(hAt, mainSrc.indexOf('ipcMain.handle("fact:relocateLibrary"')) : "";
      ok(/shell\.trashItem\(/.test(hSeg), "删除走系统回收站（shell.trashItem）");
      ok(!/unlinkSync|rmSync/.test(hSeg), "不再物理删除（无 unlinkSync / rmSync）");
      ok(/o\.dir/.test(hSeg) && /o\.file/.test(hSeg), "两种入参形态：{ dir } 整库 / { file } 单篇");

      /* 单篇删除：{ file } 交给主进程（进回收站），随后摘掉该篇记录。 */
      const cv = T.addCanvas({ id: "wf-del", name: "待删库的画布" });
      const delDir = "E:\\ws\\del\\团队事实库";
      T.ensureFact(cv.id, { name: "事实库", dir: delDir, assetsDir: delDir + "\\assets" });
      const dA = T.ensureFactDoc(cv.id, { name: "甲", file: delDir + "\\甲.md" });
      T.ensureFactDoc(cv.id, { name: "乙", file: delDir + "\\乙.md" });
      const calls = [];
      api.factRemoveLibrary = (o) => {
        calls.push(o);
        return Promise.resolve({ ok: true, removed: [o.file || o.dir] });
      };
      const rmDoc = await lib.removeDoc(cv.id, dA.id);
      ok(rmDoc.ok === true, "removeDoc 成功返回");
      ok(
        calls.length === 1 && calls[0].file === delDir + "\\甲.md",
        "单篇删除把 { file } 交给主进程（由主进程搬进系统回收站）",
      );
      ok(
        T.factDoc(cv.id, dA.id) === null && !!T.fact(cv.id),
        "只摘这一篇记录，库记录与其它文档保留",
      );

      /* 整库删除：{ dir } 交给主进程（整目录进回收站），随后摘掉库记录。 */
      calls.length = 0;
      const rm = await lib.removeLibrary(cv.id);
      ok(rm.ok === true, "removeLibrary 成功返回");
      ok(
        calls.length === 1 && calls[0].dir === delDir && !calls[0].file,
        "整库删除把 { dir } 交给主进程（整个「团队事实库」目录进系统回收站）",
      );
      ok(T.fact(cv.id) === null, "整库删除后库记录被摘掉（左栏回到「未建库」）");

      /* 主进程报错（如网络盘不支持回收站）→ 如实回传，不静默摘记录。 */
      T.ensureFact(cv.id, { name: "事实库", dir: delDir, assetsDir: delDir + "\\assets" });
      api.factRemoveLibrary = () => Promise.resolve({ ok: false, error: "不支持回收站" });
      const bad = await lib.removeLibrary(cv.id);
      ok(bad.ok === false && bad.error === "不支持回收站", "回收站不可用时如实报错");
      ok(T.fact(cv.id) !== null, "删除失败不摘库记录（库仍可用）");
      delete api.factRemoveLibrary;
    }

    console.log(
      "\n" +
        (fails
          ? "FAILED " + fails + " / " + checks + " checks"
          : "ALL OK  " + checks + " checks"),
    );
    process.exit(fails ? 1 : 0);
  })();
}

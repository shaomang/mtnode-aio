"use strict";
/* canvas-doc-host —— 主进程侧的画布「宿主」（按 index.html 顺序整份装载渲染层）
 * ============================================================================
 * 为什么要有它：读侧内核 canvas-doc/canvas-doc-core.js 不碰 DOM、不读 S，但它的宿主对象
 * H 是 54 个渲染层原语（nodeById / inputCount / outputCount / NParam / 三张色卡 / dev* …）。
 * 那些原语的唯一真源在 renderer/app.js · app-canvas.js · app-nodes.js · app-node-params.js ·
 * app-assets.js 里 —— **不许有第二份实现**（复制一份必然漂移）。所以在「读侧搬进主进程」的
 * 过渡期，这里按 renderer/index.html 的脚本顺序把它们整份装进一个 vm 上下文，只把
 * DOM / 存盘 / IPC 那几个边界换成显式替身（口径与 test/_canvas-doc-host.js 完全一致，
 * 那边是比对闸，这里是产品侧的同一套装法），对外只暴露三件事：
 *
 *   const host = createCanvasDocHost();
 *   await host.ready();          // 装层 + 探针收敛（惰性，一个进程一次）
 *   host.load(wf, token);        // 把某张画布文档挂成 S.wf（token 不变就不重复克隆；
 *                                //   token 由调用方定，要能唯一标识「哪张画的哪一版」）
 *   host.snapshot(opts)          // = 渲染层 canvasSnapshot(opts)（同步、只读）
 *   host.contentHash()           // = 渲染层 snapshotContentHashOf(S.wf)，与读的档位无关
 *   await host.editDoc(params)   // = 渲染层写路径的编辑本体（MTCanvasDocEdit.applyEdit）：
 *                                //   跑在 S.wf 上、改的就是它，回 { receipt, warnings, effects, doc }
 *
 * 纪律：
 *   · 本文件只做「装层 + 转发」，任何画布逻辑都不许写在这里（真源是内核与渲染层）。
 *   · 只在主进程用（vm / fs），渲染层加载它没有意义。
 *   · 失败一律抛错，由调用方决定回落 —— 绝不返回半份快照。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
/* 装载顺序 = renderer/index.html 的画布链路顺序（内核与写侧引擎必须在 app.js 之前） */
const CORE_FILES = [
  "canvas-doc/canvas-doc-core.js",
  "canvas-doc/canvas-doc-edit.js",
  "canvas-doc/canvas-doc-diff.js",
  /* 录制账本（take）：纯函数、无宿主依赖，装载顺序与 index.html 一致（不装也能跑，
     但「装载顺序 = index.html」这条口径要是不跟，下一处新增脚本就会照着错的那份抄） */
  "canvas-doc/canvas-take.js",
  "renderer/app.js",
  "renderer/app-devnode.js",
  /* app-db.js 不是「数据库界面」，是画布纯逻辑的一层（procPromptForRun / dbHash /
     @引用的取文口径都在这里）。编辑本体连一根线要复算 @引用来源，缺了它就是
     「procPromptForRun is not defined」—— 所以它属于写侧依赖，别当成 UI 层 */
  "renderer/app-db.js",
  "renderer/js-exec.js",
  "renderer/app-canvas.js",
  "renderer/app-nodes.js",
  "renderer/app-node-params.js",
  "renderer/app-assets.js",
];
/* UI / 存盘出口：装完层再覆盖（盖在真源之上），只记账不真做 —— 读侧不该碰它们 */
const UI_BOUNDARY = [
  "renderCanvas",
  "refreshNodeEl",
  "ensureNodeEl",
  "renderStatus",
  "updateWires",
  "updateGroupFrames",
  "pushHistory",
  "scheduleSave",
  "persist",
  "persistWf",
  "flushCurrentWf",
  "toast",
  "confirmDialog",
  "closeNodePopsExcept",
  "repositionNodePops",
];

const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* 写侧编辑的装载期表达式：进 vm 跑渲染层那条**同一份**编辑本体（MTCanvasDocEdit.applyEdit），
   宿主 ctx 用渲染层自己的 canvasEditHostCtx()，只把四个「UI 现场出口」换成空实现
   （为什么是这四个，见 build().editDoc 的注释）。回执 / warnings / effects / 文档一次性 JSON
   过桥，出去的是纯数据。 */
const EDIT_EXPR = [
  "(async () => {",
  "  const host = Object.assign({}, canvasEditHostCtx(), {",
  "    ensureCanvasEditTools: function () {},",
  "    pushHistory: function () {},",
  "    trackWorkflow: function () {},",
  "    closeNodeSettingsDialogIfStale: function () {}",
  "  });",
  "  const out = await MTCanvasDocEdit.applyEdit(S.wf, __editParams, {",
  "    i18n: I18n,",
  "    runKey: __editOpts.runKey || '',",
  "    host: host",
  "  });",
  /* 收尾归一：渲染层那一笔在返回前会补一份快照（applyCanvasEdit 末尾 canvasSnapshot(...)），
     而搭快照时顺手把 node.tags / wf.tagCatalog 补齐（normalizeNodeTags / wfTagCatalog）——
     落盘的是补齐之后那份。这里跑**同一个函数、同一份入参**、丢掉返回值，只为拿它的副作用；
     不这么干，服务侧写下去的字节会比老路少这两处空数组，差量贴回渲染层后 S.wf 也跟着不一样。 */
  "  if (out.effects && out.effects.noChange) {",
  "    canvasSnapshot();",
  "  } else {",
  "    canvasSnapshot({ scope: __editParams.scope, scopeDepth: __editParams.scopeDepth });",
  "  }",
  "  const lg = out.effects && out.effects.layoutGroups;",
  "  return JSON.stringify({",
  "    receipt: out.receipt,",
  "    warnings: out.warnings,",
  "    effects: {",
  "      noChange: !!(out.effects && out.effects.noChange),",
  "      layoutGroups: lg ? Array.from(lg.values()).map(function (g) {",
  "        return { key: g.key, label: g.label, report: g.report || null };",
  "      }) : null",
  "    },",
  "    doc: S.wf",
  "  });",
  "})()",
].join("\n");

/* ── 最小 DOM 替身（够 app.js / app-canvas.js 装层与查表，不做任何渲染） ── */
function domNode() {
  const n = {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    childNodes: [],
    parentNode: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    value: "",
    textContent: "",
    innerHTML: "",
    checked: false,
    offsetWidth: 0,
    offsetHeight: 0,
    scrollTop: 0,
    scrollLeft: 0,
    clientWidth: 1200,
    clientHeight: 800,
  };
  const self = () => n;
  Object.assign(n, {
    appendChild: (c) => (n.children.push(c), c),
    removeChild: self,
    insertBefore: (c) => c,
    replaceChild: (c) => c,
    remove: self,
    setAttribute: self,
    removeAttribute: self,
    hasAttribute: () => false,
    getAttribute: () => null,
    addEventListener: self,
    removeEventListener: self,
    dispatchEvent: () => true,
    closest: () => null,
    matches: () => false,
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    cloneNode: () => domNode(),
    getContext: () => null,
    toDataURL: () => "",
    insertAdjacentHTML() {},
    animate: () => ({ cancel() {}, finish() {}, addEventListener() {} }),
  });
  return n;
}
function domStub() {
  const mk = () => domNode();
  return {
    createElement: mk,
    createElementNS: mk,
    createTextNode: mk,
    createDocumentFragment: mk,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: domNode(),
    head: domNode(),
    documentElement: domNode(),
    activeElement: null,
    fonts: { ready: Promise.resolve() },
  };
}

/* ── 源码回查（装载期缺全局时用）：哪个渲染层文件定义了它 ── */
const SRC_CACHE = new Map();
function sourceOf(rel) {
  if (!SRC_CACHE.has(rel)) SRC_CACHE.set(rel, READ(rel));
  return SRC_CACHE.get(rel);
}
function rendererFiles() {
  return fs
    .readdirSync(path.join(ROOT, "renderer"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => "renderer/" + f);
}
function locateDefinition(name) {
  const fnRe = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const constRe = new RegExp("^(?:const|let|var)\\s+" + name + "\\s*=", "m");
  for (const rel of rendererFiles()) {
    let src = "";
    try {
      src = sourceOf(rel);
    } catch {
      continue;
    }
    if (fnRe.test(src)) return { rel, kind: "fn" };
    if (constRe.test(src)) return { rel, kind: "const" };
  }
  return null;
}
function sliceBraces(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i++;
        else if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("括号未配平");
}
function grabFunction(src, name) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index);
  if (open < 0) return null;
  return "function " + name + src.slice(src.indexOf("(", m.index), open) + sliceBraces(src, open);
}
function grabConst(src, name) {
  const re = new RegExp("^(?:const|let|var)\\s+" + name + "\\s*=", "m");
  const m = re.exec(src);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i++;
        else if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === ";" && depth === 0) return src.slice(m.index, i + 1);
  }
  return null;
}

/* ══════════════ 造一台宿主（惰性：第一次 ready() 才装层） ══════════════ */
function createCanvasDocHost(opts) {
  opts = opts || {};
  /* 与主进程共用同一份 i18n 实例：快照里的文案跟着界面语言走 */
  const I18n = opts.i18n || require("../renderer/i18n.js");
  let ctx = null;
  let booting = null;
  const info = {
    loadedFiles: [],
    failedFiles: [],
    lateFiles: [],
    grabbed: [],
    autoStubs: [],
    trail: [],
    bootMs: 0,
  };
  let loadedToken = null;

  function build() {
    const quietLog = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
    const emptyWf = { id: "", name: "", nodes: [], wires: [], marks: [], groups: [] };
    const sb = {
      console: opts.verbose ? console : quietLog,
      JSON, Object, Array, String, Number, Math, Set, Map, WeakMap, WeakSet, Date, RegExp,
      Error, TypeError, RangeError, Promise, Symbol, Boolean,
      Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
      parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, escape: (s) => String(s),
      structuredClone: (x) => JSON.parse(JSON.stringify(x)),
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      queueMicrotask: () => 0,
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      fetch: () => Promise.resolve({ ok: false, status: 0, json: async () => ({}), text: async () => "" }),
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { language: "zh-CN", languages: ["zh-CN"], clipboard: null, platform: "Win32" },
      location: { href: "", search: "", hash: "" },
      document: domStub(),
      I18n,
      /* 装层期的空现场（app.js 自己会再定义一份 S；装完以真源为准） */
      S: { wf: emptyWf, view: "workflow", cam: { x: 0, y: 0, z: 1 }, config: { dsh: {} } },
      /* preload 桥：读侧不该真发 IPC；回「没有」即可（素材正文由渲染层那条路补） */
      api: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
      getComputedStyle: () => ({ getPropertyValue: () => "", fontSize: "12px" }),
      requestIdleCallback: () => 0,
      cancelIdleCallback: () => {},
      devicePixelRatio: 1,
      innerWidth: 1600,
      innerHeight: 900,
      scrollTo() {},
      open: () => null,
      close() {},
      focus() {},
      print() {},
    };
    sb.window = sb;
    sb.globalThis = sb;
    ctx = vm.createContext(sb);

    function applyUiBoundary() {
      for (const name of UI_BOUNDARY) {
        ctx[name] = function () {
          if (name === "confirmDialog") return Promise.resolve(true);
          if (name === "ensureNodeEl") return domNode();
          return undefined;
        };
      }
      sb.api = {
        wfSave: async () => ({ ok: true, mtime: Date.now() }),
        wfList: async () => [],
        wfLoad: async () => ({ ok: false }),
        app: { assets: async () => ({ ok: false }) },
      };
    }
    function loadFile(rel) {
      try {
        vm.runInContext(sourceOf(rel), ctx, { filename: rel });
        info.loadedFiles.push(rel);
        return true;
      } catch (err) {
        info.failedFiles.push({ rel, error: String((err && err.message) || err) });
        return false;
      }
    }
    for (const rel of CORE_FILES) loadFile(rel);
    applyUiBoundary();

    /* renderer/app.js 的 `const S` 是词法绑定，外面读不到 ctx.S —— 一律用表达式进上下文改 */
    function setWf(wf, token) {
      ctx.__wf = wf;
      vm.runInContext(
        "S.wf = __wf; S.view = 'workflow'; S.cam = { x: 0, y: 0, z: 1 };" +
          " S.superFocus = ''; S.taskFocus = ''; S.assistScope = 'global';" +
          " if (!S.config) S.config = { dsh: {} };",
        ctx,
        { filename: "host#setWf" },
      );
      loadedToken = token === undefined ? null : token;
    }
    setWf(emptyWf, null);

    function resolveMissing(name) {
      const where = locateDefinition(name);
      if (!where) {
        ctx[name] = function () {
          return [];
        };
        info.autoStubs.push(name);
        return;
      }
      if (!info.loadedFiles.includes(where.rel) && !info.failedFiles.some((f) => f.rel === where.rel)) {
        if (loadFile(where.rel)) {
          info.lateFiles.push(where.rel);
          applyUiBoundary();
          return;
        }
      }
      const src = sourceOf(where.rel);
      const body = where.kind === "fn" ? grabFunction(src, name) : grabConst(src, name);
      if (!body) {
        ctx[name] = function () {
          return [];
        };
        info.autoStubs.push(name);
        return;
      }
      try {
        if (where.kind === "fn") vm.runInContext(body, ctx, { filename: where.rel + "#" + name });
        else
          vm.runInContext(body + "\nglobalThis." + name + " = " + name + ";", ctx, {
            filename: where.rel + "#" + name,
          });
        info.grabbed.push({ name, rel: where.rel, kind: where.kind });
      } catch {
        ctx[name] = function () {
          return [];
        };
        info.autoStubs.push(name + "(抓取失败)");
      }
    }

    /* 探针：跑一次「读图 + 一次建节点连线」，每遇一个未定义全局补一次后重试（与比对闸同口径） */
    const probeEdit = {
      create: [
        { alias: "a", kind: "input_text", title: "文本A", text: "hi" },
        { alias: "b", kind: "save", title: "保存B", savePath: "out/x.txt" },
      ],
      connect: [{ from: "a", to: "b", toIndex: 0 }],
    };
    async function bootProbe() {
      ctx.__probe = probeEdit;
      for (let round = 0; round < 200; round++) {
        setWf(emptyWf, null);
        try {
          await vm.runInContext("applyCanvasEdit(__probe)", ctx, { filename: "host#probe-edit" });
          snapshot({ detail: "standard" });
          setWf(emptyWf, null);
          return;
        } catch (err) {
          const m = /^(\w+) is not defined/.exec(String((err && err.message) || ""));
          if (!m) throw err;
          info.trail.push(m[1]);
          resolveMissing(m[1]);
        }
      }
      throw new Error("画布宿主探针未收敛：" + info.trail.join(" → "));
    }

    function snapshot(snapshotOpts) {
      ctx.__opts = snapshotOpts || {};
      return vm.runInContext("canvasSnapshot(__opts)", ctx, { filename: "host#snapshot" });
    }
    /* ── 写侧：在当前 S.wf 上跑一次编辑（任务 6/8：编辑引擎进文档服务） ──
       跑的就是渲染层那条路的编辑本体 MTCanvasDocEdit.applyEdit —— 同一份引擎、同一套原语
       （canvasEditHostCtx() 逐个列出），只有一个区别：**现场出口换成空实现**。
         · ensureCanvasEditTools：工具许可闸要读渲染层的权限现场，渲染层在发请求之前已经跑过
           （顺序也照引擎：空笔不跑闸），这里再跑一次只会拿 vm 里那份假配置改用户设置。
         · pushHistory：撤销栈的快照式实现抓的是渲染层的 S.wf；服务侧这一笔的「编辑前快照」
           由渲染层自己压（它才有编辑前的现场），这里压只会往 vm 里堆垃圾。
         · trackWorkflow / closeNodeSettingsDialogIfStale：一件事是标签条、一件事是设置窗，
           两者都是 UI，渲染层按回执与差量各自补一次（与引擎调用它们的条件一致）。
       返回的是 JSON 字符串过桥后的纯数据：{ receipt, warnings, effects, doc }。 */
    async function editDoc(editParams, editOpts) {
      const o = editOpts || {};
      ctx.__editParams = editParams || {};
      ctx.__editOpts = { runKey: String(o.runKey || "") };
      /* 排版网格（app.js 的 grid()）：渲染层的 S.config.snap 是用户在设置里改过的值，
         vm 里的 S 是中性现场 —— 不把这一颗带过来，layout:true 的编辑会按缺省 24 排版。 */
      if (typeof o.snap === "number" && isFinite(o.snap) && o.snap > 0) {
        ctx.__snap = o.snap;
        vm.runInContext("if (!S.config) S.config = {}; S.config.snap = __snap;", ctx, {
          filename: "host#editDoc-snap",
        });
      }
      const json = await vm.runInContext(EDIT_EXPR, ctx, { filename: "host#editDoc" });
      return JSON.parse(json);
    }
    function contentHash() {
      return vm.runInContext("snapshotContentHashOf(S.wf)", ctx, { filename: "host#hash" });
    }
    /* 真源归一化一次：renderer 的 normalizeNodeTags 会**写回**节点（缺 tags 就补 `tags: []`），
       而它只在「投影到某个节点」时才跑 —— 同一份文档，读得深一点浅一点，读后的 wf 都不一样，
       contentHash 也就跟着漂。装载后在这里对全量节点跑一遍，文档态就定死了：之后任何读都
       是幂等的，同一版文档只有一个哈希。 */
    function canonicalize() {
      return vm.runInContext(
        "(function(){ var ns=(S.wf&&S.wf.nodes)||[]; for (var i=0;i<ns.length;i++){ var n=ns[i];" +
          " if(n&&typeof n==='object') normalizeNodeTags(n); } return ns.length; })()",
        ctx,
        { filename: "host#canonicalize" },
      );
    }

    return { snapshot, contentHash, canonicalize, editDoc, bootProbe, setWf };
  }

  let impl = null;
  function ready() {
    if (impl) return Promise.resolve(info);
    if (booting) return booting;
    booting = (async () => {
      const t0 = Date.now();
      impl = build();
      try {
        await impl.bootProbe();
      } catch (err) {
        impl = null;
        booting = null;
        throw err;
      }
      info.bootMs = Date.now() - t0;
      return info;
    })();
    return booting;
  }

  return {
    ready,
    info,
    /** 把某张画布文档挂成宿主现场；同一 token 不重复克隆（克隆只发生在真要读的时候） */
    load(wf, token) {
      if (!impl) throw new Error("画布宿主尚未就绪：先 await ready()");
      if (loadedToken !== null && token !== undefined && loadedToken === token) return;
      impl.setWf(JSON.parse(JSON.stringify(wf || {})), token);
    },
    snapshot(opts2) {
      if (!impl) throw new Error("画布宿主尚未就绪：先 await ready()");
      return impl.snapshot(opts2);
    },
    contentHash() {
      if (!impl) throw new Error("画布宿主尚未就绪：先 await ready()");
      return impl.contentHash();
    },
    /** 写侧：在当前挂着的文档上跑一次编辑；回 { receipt, warnings, effects, doc }（纯数据） */
    editDoc(params, opts) {
      if (!impl) throw new Error("画布宿主尚未就绪：先 await ready()");
      return impl.editDoc(params, opts);
    },
    /** 把当前文档在真源上归一化一次（见 impl.canonicalize 注释）；返回节点数 */
    canonicalize() {
      if (!impl) throw new Error("画布宿主尚未就绪：先 await ready()");
      return impl.canonicalize();
    },
    /** 仅供自检 / 日志：装层面（装了哪些、抓了哪些、替身了哪些） */
    describe() {
      return Object.assign({ ok: !!impl }, info);
    },
  };
}

module.exports = { createCanvasDocHost, CORE_FILES, UI_BOUNDARY, EDIT_EXPR, ROOT };

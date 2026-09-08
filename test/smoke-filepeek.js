"use strict";
/* ============================================================
 * 会话工具条「被读 / 被改的文件名」+ 右侧只读文件查看面板
 * —— 链路级冒烟测试（纯 Node + 假 DOM 桩）
 *   node test/smoke-filepeek.js
 *
 * 被测代码全部是「真实源码 / 真函数」，不抄一份逻辑：
 *   renderer/app-fileview.js   toolFileRefs / toolFileRefsAbs / resolveToolPath /
 *                              fileviewLangOf / fileviewHighlight / fileviewBaseName（纯函数直接真跑）
 *                              dshToolFileBadges / fvBadgeEl（假 DOM 真跑：徽标、+N、点击）
 *                              ensureFilePeek / openFilePeek / closeFilePeek / 拖宽 / 三种视图（假 DOM 真跑）
 *   renderer/app-assist.js     dshToolDetailsEl（抠出真函数体，在挂好 fileview 的上下文里真跑）
 *   renderer/app-plan.js       planLiveBlock / planPanelEl（同上，钉「🔧 名称」那行也挂徽标）
 *   renderer/app-codeedit.js   jsHighlightHtml（js / ts / json 的高亮必须与它同源，不是第二份词法）
 *   renderer/index.html        脚本注册顺序（app-codeedit.js 之后、app-assist.js 之前）
 *   renderer/style.css         @import css/fileview.css
 *   renderer/css/*.css         面板与徽标真实吐出的每一个 class 都真有规则（写了没加载 = 白写）
 *   renderer/i18n.js           本轮新增中文串在 EN 表逐条命中
 * 只桩外围环境（document / window / localStorage / toast / 三个工作区真源），不桩被测逻辑。
 *
 * 覆盖：
 *   [1] toolFileRefs 逐条钉住（object 型 args / JSON 串 / 被截断的串 / file_path 与 path 同名冲突 /
 *       写·读·目录模式判定 / offset·limit / 非文件工具返回空 / 不像路径的值 / 列表键 / 去重）
 *       + 路径层（相对按工作区补全、绝对不二次拼接、POSIX 不套 Windows 盘、file:/// 还原、
 *       ./ 与 ../ 就地解、能不能直接开的判据）+ 语言判定
 *   [2] fileviewHighlight：不注入 HTML（只允许 span · 剥掉 span 逐字等于转义后源码）·
 *       js/ts/json 与 jsHighlightHtml 同源 · yaml 委托 · 各语言 token class 命中 · 未知语言只转义
 *   [3] 徽标：真跑 dshToolFileBadges（三源推工作区 / 颜色档 / title / 点击 preventDefault ·
 *       stopPropagation 且把 {mode,line,count} 原样交给面板 / +N 就地展开 / 无基准只提示不开面板 /
 *       确实经过 toolFileRefs / 工作区缓存不重复打真源）+ dshToolDetailsEl 与 planLiveBlock
 *       两个渲染出口真跑挂上徽标（一处改动即全覆盖会话 / 助手 / 节点 / 计划面板）
 *   [4] 面板：假 DOM 真跑 openFilePeek（行号槽 + 高亮层 · 折行 · 跳行标记 · 目录 / 图片 / 过大 /
 *       读不到各态 · 最近文件横条 · ✕ 与 Esc 两条显式关闭 · 左缘拖宽落 localStorage）
 *       + persistent 硬断言：整轮跑完，document / window 上出现的监听类型只能是拖拽与 resize，
 *       绝不允许 click / mousedown / pointerdown / blur 这类「点外部即关」
 *   [5] 接线与样式链：脚本注册顺序 · style.css @import · build.json 通配 ·
 *       运行时真实吐出的每个 class 在 CSS 里有规则（且 CSS 里没有 JS 从不用的死规则）· i18n
 * ============================================================ */
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
/* 仓库源码是 CRLF，切片与断言一律按 \n 口径 */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const EQS = (got, want, msg) =>
  ok(
    got === want,
    msg +
      (got === want
        ? ""
        : "\n        实际=" + JSON.stringify(got) + "\n        期望=" + JSON.stringify(want)),
  );
/* 与 app.js escapePromptHl / app-fileview.js fvEsc 同口径（只放 & < >） */
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/* 假 DOM 里按 class 递归找节点（真实页面用 querySelector，这里不必实现选择器） */
function findAll(el, cls, out) {
  out = out || [];
  for (const c of (el && el.children) || []) {
    if (c.__cls && c.__cls.has(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}
const one = (el, cls) => findAll(el, cls)[0] || null;
function textOf(el) {
  if (!el) return "";
  let s = String(el.textContent || "");
  for (const c of el.children || []) s += textOf(c);
  return s;
}

/* 按名字抠出真实函数体（顶层 function 声明 → 连函数名一起取，原样喂进被测上下文） */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = src.indexOf("{", m.index);
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(m.index + 1, j + 1);
    }
  }
  throw new Error("函数体没闭合：" + name);
}

/* ═══════════════════════ 假 DOM（只桩环境，不桩逻辑） ═══════════════════════ */
/* 运行时真实吐出的每一个 class 都记在这儿：[5] 拿它去 CSS 里逐条对账。 */
function makeDom(env) {
  const EMITTED = new Set();
  const addCls = (s) =>
    String(s || "")
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => EMITTED.add(c));
  function fakeEl(tag) {
    const el = {
      tagName: String(tag || "div").toLowerCase(),
      children: [],
      parentNode: null,
      style: {},
      attrs: {},
      __h: {},
      __cls: new Set(),
      __html: "",
      id: "",
      hidden: false,
      title: "",
      textContent: "",
      value: "",
      placeholder: "",
      alt: "",
      src: "",
      type: "",
      open: false,
      tabIndex: 0,
      rows: 0,
      offsetTop: 24,
      offsetHeight: 18,
      offsetWidth: 420,
      clientHeight: 600,
      scrollTop: 0,
      scrollLeft: 0,
    };
    Object.defineProperty(el, "className", {
      get() {
        return Array.from(el.__cls).join(" ");
      },
      set(v) {
        el.__cls = new Set(String(v == null ? "" : v).split(/\s+/).filter(Boolean));
        addCls(v);
      },
    });
    Object.defineProperty(el, "innerHTML", {
      get() {
        return el.__html;
      },
      set(v) {
        el.__html = String(v == null ? "" : v);
        /* 把 HTML 串里的标签真的摊成子节点：querySelector("#id") 才有的可查 */
        el.children = [];
        const re = /<(\w+)([^>]*)>/g;
        let m;
        while ((m = re.exec(el.__html))) {
          const kid = fakeEl(m[1]);
          const am = /(\w+(?:-\w+)*)\s*=\s*"([^"]*)"/g;
          let a;
          while ((a = am.exec(m[2]))) {
            if (a[1] === "class") kid.className = a[2];
            else if (a[1] === "id") kid.id = a[2];
            else if (a[1] === "hidden") kid.hidden = true;
            else kid.attrs[a[1]] = a[2];
          }
          kid.parentNode = el;
          el.children.push(kid);
        }
        for (const c of el.__html.matchAll(/class="([^"]*)"/g)) addCls(c[1]);
      },
    });
    el.classList = {
      add(...cs) {
        cs.forEach((c) => el.__cls.add(c));
        cs.forEach((c) => addCls(c));
      },
      remove(...cs) {
        cs.forEach((c) => el.__cls.delete(c));
      },
      toggle(c, force) {
        const on = force === undefined ? !el.__cls.has(c) : !!force;
        if (on) {
          el.__cls.add(c);
          addCls(c);
        } else el.__cls.delete(c);
        return on;
      },
      contains(c) {
        return el.__cls.has(c);
      },
    };
    el.setAttribute = (k, v) => {
      if (k === "class") el.className = v;
      else if (k === "id") el.id = String(v);
      else el.attrs[k] = String(v);
    };
    el.getAttribute = (k) => (el.attrs[k] === undefined ? null : el.attrs[k]);
    el.appendChild = (c) => {
      if (c && c.__frag) {
        for (const k of c.children.slice()) el.appendChild(k);
        c.children.length = 0;
        return c;
      }
      if (c) c.parentNode = el;
      el.children.push(c);
      return c;
    };
    el.append = (...cs) => cs.forEach((c) => el.appendChild(c));
    el.insertBefore = (c, ref) => {
      const i = ref ? el.children.indexOf(ref) : -1;
      if (c) c.parentNode = el;
      el.children.splice(i < 0 ? el.children.length : i, 0, c);
      return c;
    };
    el.removeChild = (c) => {
      const i = el.children.indexOf(c);
      if (i >= 0) {
        el.children.splice(i, 1);
        c.parentNode = null;
      }
      return c;
    };
    el.addEventListener = (t, f) => (el.__h[t] = el.__h[t] || []).push(f);
    el.removeEventListener = (t, f) => {
      el.__h[t] = (el.__h[t] || []).filter((x) => x !== f);
    };
    el.querySelector = (sel) => qsel(el, sel);
    el.querySelectorAll = (sel) => qall(el, sel);
    el.closest = () => null;
    el.contains = () => false;
    el.focus = () => {};
    el.blur = () => {};
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 420, bottom: 40, width: 420, height: 40 });
    el.scrollIntoView = () => {};
    el.fire = (type, ev) => {
      const e = Object.assign(
        {
          type,
          target: el,
          currentTarget: el,
          clientX: 0,
          clientY: 0,
          key: "",
          preventDefault() {
            e.__pd = (e.__pd || 0) + 1;
          },
          stopPropagation() {
            e.__sp = (e.__sp || 0) + 1;
          },
        },
        ev || {},
      );
      for (const f of el.__h[type] || []) f(e);
      if (typeof el["on" + type] === "function") el["on" + type](e);
      return e;
    };
    return el;
  }
  const matchSel = (el, sel) =>
    sel.charAt(0) === "#" ? el.id === sel.slice(1) : el.__cls.has(sel.replace(/^\./, ""));
  function qall(root, sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children || []) {
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(root);
    return out;
  }
  const qsel = (root, sel) => qall(root, sel)[0] || null;

  const doc = {
    __emitted: EMITTED,
    __listeners: [],
    __byId: {},
    createElement: (t) => fakeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    createDocumentFragment: () => {
      const f = fakeEl("#fragment");
      f.__frag = true;
      return f;
    },
    addEventListener(t, f) {
      doc.__listeners.push(t);
      (doc.__h = doc.__h || {})[t] = (doc.__h[t] || []).concat(f);
    },
    removeEventListener() {},
    __h: {},
    fire(type, ev) {
      const e = Object.assign({ type, target: doc, preventDefault() {}, stopPropagation() {} }, ev || {});
      for (const f of doc.__h[type] || []) f(e);
      return e;
    },
    querySelector: () => null,
    getElementById(id) {
      return doc.__byId[id] || null;
    },
  };
  doc.body = fakeEl("body");
  const origAppend = doc.body.appendChild;
  doc.body.appendChild = (c) => {
    if (c && c.id) doc.__byId[c.id] = c;
    return origAppend(c);
  };
  const win = {
    innerWidth: 1440,
    innerHeight: 900,
    listeners: [],
    addEventListener(t) {
      win.listeners.push(t);
    },
    removeEventListener() {},
    getComputedStyle: () => ({ paddingTop: "8px", fontSize: "12.5px", lineHeight: "19px" }),
    api: env && env.api ? env.api : {},
  };
  const store = Object.assign({}, (env && env.localStorage) || {});
  const ls = {
    __store: store,
    getItem: (k) => (store[k] === undefined ? null : store[k]),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  return { fakeEl, doc, win, ls, EMITTED };
}

/* 把 app-fileview.js 真源码装进一个带假 DOM 的上下文 */
function loadFileview(opts) {
  const o = opts || {};
  const dom = makeDom(o);
  const toasts = [];
  const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    Promise,
    JSON,
    Math,
    Date,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Set,
    Map,
    isFinite,
    parseFloat,
    parseInt,
    encodeURIComponent,
    document: dom.doc,
    window: dom.win,
    localStorage: dom.ls,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    I18n,
    toast: (m, k) => toasts.push([String(m), k]),
  };
  vm.createContext(sandbox);
  if (o.withCodeedit) vm.runInContext(read("renderer/app-codeedit.js"), sandbox);
  if (o.yamlHook)
    vm.runInContext(
      "function highlightYamlLine(line){ return 'Y[' + line + ']'; }",
      sandbox,
    );
  vm.runInContext(read("renderer/app-fileview.js"), sandbox);
  /* 桩三个「工作区真源」与主进程口子：只桩环境，识别与补全逻辑仍是被测真函数 */
  const stubs = [];
  if (o.assistWs !== undefined) stubs.push(`assistResolveWorkspace = function(){ globalThis.__wsHits.assist++; return ${JSON.stringify(o.assistWs)}; };`);
  if (o.nodeId)
    stubs.push(
      `nodeById = function(id){ globalThis.__wsHits.byId++; return id === ${JSON.stringify(o.nodeId)} ? { id: id } : null; };`,
      `dshWorkspaceOf = function(){ globalThis.__wsHits.ws++; return ${JSON.stringify(o.nodeWs || "")}; };`,
    );
  if (o.sessionId)
    stubs.push(
      `agentSessionById = function(id){ globalThis.__wsHits.sess++; return id === ${JSON.stringify(o.sessionId)} ? { id: id } : null; };`,
      `agentRunWorkspace = function(){ globalThis.__wsHits.runws++; return ${JSON.stringify(o.sessionWs || "")}; };`,
    );
  if (o.openable)
    stubs.push(`resolveOpenableFilePath = function(p){ return ${JSON.stringify(o.openable)}; };`);
  if (stubs.length)
    vm.runInContext(
      "globalThis.__wsHits = { assist:0, byId:0, ws:0, sess:0, runws:0 };\n" + stubs.join("\n"),
      sandbox,
    );
  const EV = (expr) => vm.runInContext(expr, sandbox);
  return { EV, sandbox, dom, toasts, I18n };
}

const FV = loadFileview({}); /* [1][2] 用：纯函数段，压根不需要 DOM */
const CALL = (expr) => FV.EV("(" + expr + ")");
/* 完全不给 document / window / localStorage 的沙箱：证明第一段（识别 + 高亮）划分干净 */
const BARE = (() => {
  const s = { console, Date, Math, JSON, String, Object, Number, Array, RegExp, Set, Map, isFinite, parseFloat, parseInt, Promise };
  vm.createContext(s);
  vm.runInContext(read("renderer/app-fileview.js"), s);
  return (expr) => vm.runInContext("(" + expr + ")", s);
})();

ok(
  ["toolFileRefs", "toolFileRefsAbs", "resolveToolPath", "fileviewLangOf", "fileviewIsImagePath",
    "fileviewBaseName", "fileviewExtOf", "fileviewPathIsOpenable", "fileviewHighlight",
    "dshToolFileBadges", "openFilePeek", "closeFilePeek", "toggleFilePeek", "filePeekIsOpen",
    "fileviewOwnerWorkspace"]
    .every((n) => FV.EV("typeof " + n) === "function"),
  "app-fileview.js 挂出识别 / 路径 / 高亮 / 徽标 / 面板全套函数",
);
EQS(BARE("typeof document"), "undefined", "整个 app-fileview.js 在「完全没有 DOM / window / localStorage」的沙箱里求值成功（两段划分干净）");
EQS(
  BARE("JSON.stringify(toolFileRefs({name:'read',args:{file_path:'E:/a/b.js',offset:1}}))"),
  JSON.stringify([{ path: "E:/a/b.js", name: "b.js", mode: "read", line: 1, count: undefined }]),
  "纯 Node 沙箱（无任何 DOM）里识别函数照跑：test/ 切片不需要假 DOM",
);
EQS(BARE("fileviewHighlight('var a = 1;','js').indexOf('jsl-kw')") > 0 ? 1 : 0, 1, "同上：高亮也不依赖 DOM（拿不到 jsHighlightHtml 时退回通用词法）");

/* ═══════════════ [1] toolFileRefs：从工具参数里认出文件 ═══════════════ */
console.log("\n[1] toolFileRefs / 路径补全 / 语言判定（真函数逐条钉住）");
const refs = (t) => CALL("toolFileRefs(" + JSON.stringify(t) + ")");
const refsAbs = (t, ws) => CALL("toolFileRefsAbs(" + JSON.stringify(t) + "," + JSON.stringify(ws) + ")");
const J1 = (a) => JSON.stringify(a[0] || null);

EQS(
  J1(refs({ name: "read", args: { file_path: "E:/a/b.js", offset: 120, limit: 80 } })),
  JSON.stringify({ path: "E:/a/b.js", name: "b.js", mode: "read", line: 120, count: 80 }),
  "object 型 args（宿主插件直接给的）：file_path + offset/limit → line/count",
);
EQS(
  JSON.stringify(refs({ name: "read", args: '{"file_path":"E:/a/b.js","offset":120,"limit":80}' })),
  JSON.stringify(refs({ name: "read", args: { file_path: "E:/a/b.js", offset: 120, limit: 80 } })),
  "DSH 原样透传的 arguments JSON 串与 object 同一结果（两条真形状同源）",
);
EQS(
  J1(refs({ name: "str_replace_editor", args: '{"command":"view","path":"E:/x/y.js","file_text":"aa' })),
  JSON.stringify({ path: "E:/x/y.js", name: "y.js", mode: "read" }),
  "被截断的串：正则兜底抠出 path，command=view 判成读（不把只读那一步标橙）",
);
EQS(
  J1(refs({ name: "str_replace_editor", args: '{"command":"create","path":"E:/x/y.js","file_text":"aa' })),
  JSON.stringify({ path: "E:/x/y.js", name: "y.js", mode: "write" }),
  "被截断的串：command=create 判成改（同一工具名按 command 定性，而非按名字一刀切）",
);
EQS(
  JSON.stringify(refs({ name: "read", args: { command: "view", file_path: "E:/x/a.js" } }).map((r) => r.mode + " " + r.path)),
  JSON.stringify(["read E:/x/a.js"]),
  "command 是检索键：它的值 view 不另挂一枚「文件」，也不把只读那一步搅成改",
);
{
  const both = refs({ name: "read", args: { file_path: "E:/x/a.js", path: "E:/x/b.js", offset: 5 } });
  EQS(both.length, 2, "file_path 与 path 同时存在：两个都收（参数名顺序 = 徽标顺序）");
  EQS(both.map((r) => r.path).join("|"), "E:/x/a.js|E:/x/b.js", "先 file_path 后 path（真源参数名优先序）");
  ok(both[0].line === 5 && both[1].line === undefined, "行号区间只给第一条（一次 read 只有一个 offset）");
}
EQS(
  JSON.stringify(refs({ name: "read", args: { file_path: "E:/x/a.js", path: "E:/x/a.js" } }).length),
  "1",
  "同一路径被两个键重复给出：按 模式+路径 去重，不挂两枚一模一样的徽标",
);
EQS(
  JSON.stringify(refs({ name: "edit", args: { file_path: "E:/x/a.js" } }).map((r) => r.mode)),
  JSON.stringify(["write"]),
  "edit → 改；（工具名整名比对写类清单）",
);
EQS(
  JSON.stringify(
    [
      { name: "write", args: { file_path: "E:/a.md" } },
      { name: "mcp__fs__read_file", args: { file_path: "E:/a.md" } },
      { name: "dsh_edit", args: { file_path: "E:/a.md" } },
      { name: "weird_thing", args: { file_path: "E:/a.md" } },
    ].flatMap((t) => refs(t).map((r) => r.mode)),
  ),
  JSON.stringify(["write", "read", "write", "read"]),
  "带前缀的工具名（mcp__fs__ / dsh_）切段后仍定性正确；认不出的按最保守的读",
);
EQS(
  JSON.stringify(refs({ name: "glob", args: { pattern: "**/*.ts", path: "src" } }).map((r) => r.mode)),
  JSON.stringify(["dir"]),
  "glob / grep 这类检索工具：path 是「在哪儿搜」→ 目录档（灰），不假装是个文件",
);
EQS(JSON.stringify(refs({ name: "pwsh", args: { command: "ls", workdir: "E:/ws" } })), "[]", "pwsh 的 workdir 不是文件：返回空（刻意不解析命令行里的文件名）");
EQS(JSON.stringify(refs({ name: "web_search", args: { queries: ["a"] } })), "[]", "非文件工具（web_search）返回空");
EQS(JSON.stringify(refs({ name: "grep", args: { pattern: "x", include: "*.js" } })), "[]", "grep 的 pattern / include 是过滤式，不是路径：返回空");
EQS(JSON.stringify(refs({ name: "todo_write", args: { todos: [{ content: "x", status: "pending" }] } })), "[]", "todo_write 的 content / status 不是路径：返回空");
EQS(JSON.stringify(refs({ name: "edit", args: { file_path: "the file path", old_string: "a" } })), "[]", "光一句英文（带空格又没扩展名没分隔符）不当成文件");
EQS(JSON.stringify(refs({ name: "read", args: { file_path: "https://x.com/a.js" } })), "[]", "http(s) 地址不进文件面板");
EQS(JSON.stringify(refs({ name: "edit", args: { file_path: "E:/a.js\nnew line" } })), "[]", "多行值一定是正文，不当成路径");
EQS(JSON.stringify(refs({ name: "read", args: { file_path: "E:/a/*.js" } })), "[]", "带通配符的是表达式不是路径");
EQS(
  JSON.stringify(refs({ name: "edit", args: { file_paths: ["E:/a.md", "E:/b.md"], offset: 9 } }).map((r) => r.name + ":" + r.mode + ":" + (r.line || ""))),
  JSON.stringify(["a.md:write:", "b.md:write:"]),
  "列表键 file_paths 也认；列表项不领 line（行号只属于单文件 read）",
);
EQS(JSON.stringify(refs({ name: "read", args: "" })), "[]", "空串 args 不炸");
EQS(JSON.stringify(refs({ name: "", args: { file_path: "E:/a.js" } })), "[]", "没有工具名 → 空（不凭空造徽标）");
EQS(JSON.stringify(refs(null)), "[]", "null 记录不炸");
EQS(
  JSON.stringify(
    refs({ name: "read", args: { file_path: "E:\\素材\\a b.md" } }).map((r) => r.name),
  ),
  JSON.stringify(["a b.md"]),
  "带空格与中文的 Windows 路径照收（两种分隔符都认）",
);
EQS(
  JSON.stringify(refs({ name: "read", args: { file_path: '"E:/a.js"' } })),
  "[]",
  "值本身被再包了一层引号 → 不在识别层硬拆（剥引号是 resolveToolPath 的活儿，见下一段）",
);

/* —— 路径层：补全与归一 —— */
EQS(
  CALL("resolveToolPath(" + JSON.stringify("src/a.js") + "," + JSON.stringify("E:/ws") + ")"),
  "E:\\ws\\src\\a.js",
  "相对路径按该会话生效工作区补全",
);
EQS(
  CALL("resolveToolPath(" + JSON.stringify("E:/x/b.js") + "," + JSON.stringify("E:\\ws\\deep") + ")"),
  "E:\\x\\b.js",
  "绝对路径绝不二次拼接（不把工作区糊到盘符前面）",
);
EQS(
  CALL("resolveToolPath(" + JSON.stringify("/tmp/a.js") + "," + JSON.stringify("E:\\ws") + ")"),
  "/tmp/a.js",
  "POSIX 绝对路径不被 Windows 工作区污染，分隔符也不翻成反斜杠",
);
EQS(
  CALL("resolveToolPath(" + JSON.stringify("src/a.js") + ",'')"),
  "src\\a.js",
  "没有基准时只归一不补全（上层据此「只显文件名、不开面板」）",
);
EQS(CALL("resolveToolPath(" + JSON.stringify("file:///E:/a/b.js") + ",'')"), "E:\\a\\b.js", "本地 file:/// URL 还原成盘符路径");
EQS(CALL("resolveToolPath(" + JSON.stringify("E:/ws/out/../x.js") + ",'')"), "E:\\ws\\x.js", "./ 与 ../ 纯词法就地解（不 stat、不跟符号链接）");
EQS(CALL("resolveToolPath(" + JSON.stringify("E:/ws///") + ",'')"), "E:\\ws", "重复 / 尾部多余分隔符吃掉");
EQS(CALL("resolveToolPath('~/a.js','E:\\\\ws')"), "~\\a.js", "~ 开头不硬拼到工作区前面（那是 shell 的地盘，本层只归一）");
ok(CALL("fileviewPathIsOpenable(" + JSON.stringify("E:\\a\\b.js") + ")") === true, "绝对路径可直接喂给 fileStat / fileReadText");
ok(CALL("fileviewPathIsOpenable('src/a.js')") === false, "相对路径不可直接开（无基准时面板不该假装能读）");
{
  const abs = refsAbs({ name: "read", args: { file_path: "src/a.js", offset: 3 } }, "E:/proj");
  EQS(abs[0].abs, "E:\\proj\\src\\a.js", "toolFileRefsAbs：同一份 refs + 按工作区补 abs（line 仍带着）");
  EQS(abs[0].line, 3, "补全不丢行号区间");
}

/* —— 语言判定 —— */
EQS(
  CALL("['a.js','i.mjs','package.json','b.md','AGENTS.md','c.PY','Dockerfile','.gitignore','g.svg','h.yaml','i.bat','x.txt','f.unk'].map(p=>p+'='+fileviewLangOf(p)).join(' ')"),
  "a.js=js i.mjs=js package.json=json b.md=md AGENTS.md=md c.PY=py Dockerfile=sh .gitignore= g.svg=xml h.yaml=yaml i.bat=bat x.txt=text f.unk=",
  "fileviewLangOf：扩展名 + 无扩展名固定名（大小写不敏感），认不出返回空串（宁可不配色也不配错色）",
);
EQS(
  CALL("['a.png','b.svg','c.txt','d.JPG','e.mk'].map(p=>p+':'+fileviewIsImagePath(p)).join(' ')"),
  "a.png:true b.svg:true c.txt:false d.JPG:true e.mk:false",
  "图片扩展名判定（svg 也算图片，但面板按源码看它）",
);
EQS(CALL("[fileviewBaseName('E:\\\\d\\\\f.js'),fileviewBaseName('E:/d/'),fileviewExtOf('.gitignore'),fileviewBaseName('')].join('|')"), "f.js|d||", "拆名：末段 / 吃尾分隔符 / .gitignore 不当扩展名 / 空路径");

/* ═══════════════ [2] fileviewHighlight：注入安全 + 各语言命中 ═══════════════ */
console.log("\n[2] fileviewHighlight：不注入 HTML · 与 jsHighlightHtml 同源 · 各语言 token 命中");
const HL_SRC =
  '// c\nconst $x = "s" + 42; <div id="k" class="a">a &lt; b</div>\nSELECT * FROM t WHERE a<b;\nkey: [1, "two"] # note\n@import url(x); a{color:#fff}\ndef f(x):\n\t"""doc"""\n\treturn x\n# head **b** `c` [t](u)\n';
const HLANGS = ["js", "ts", "tsx", "json", "py", "css", "scss", "html", "xml", "yaml", "md", "sh", "ps1", "bat", "sql", "ini", "c", "go", "rs", "diff", "text", "", "unk"];
for (const l of HLANGS) {
  const h = CALL("fileviewHighlight(" + JSON.stringify(HL_SRC) + "," + JSON.stringify(l) + ")");
  ok(h.indexOf("<script") < 0 && h.indexOf("</script>") < 0, "注入测试（" + (l || "无语言") + "）：正文里的 script 不成真标签");
  const tags = [...new Set((h.match(/<\/?([a-zA-Z]+)[^>]*>/g) || []).map((s) => s.replace(/<\/?([a-zA-Z]+)[^>]*>/, "$1").toLowerCase()))];
  ok(tags.length === 0 || (tags.length === 1 && tags[0] === "span"), "注入测试（" + (l || "无语言") + "）：输出只允许 span 这一种标签（实际 " + (tags.join(",") || "无标签") + "）");
  EQS(
    h.replace(/<\/?span[^>]*>/g, ""),
    esc(HL_SRC),
    "高亮不吞不增内容（" + (l || "无语言") + "）：剥掉 span 逐字等于转义后的原文",
  );
}
EQS(CALL("fileviewHighlight('','js')"), "", "空正文 → 空高亮");
EQS(CALL("fileviewHighlight(null,'js')"), "", "null 入参不炸");
ok(
  CALL("fileviewHighlight('const s = `tpl${1}`;','js').indexOf('jsl-str')") > 0,
  "模板串 / 反引号走字符串配色（与函数节点编辑器同一口径）",
);
ok(
  CALL("fileviewHighlight('const s = \"x','js').split(String.fromCharCode(10)).length") === 1,
  "引号没闭合也只吃这一行（逐行高亮，不把整份文件吞成一个字符串）",
);
EQS(
  CALL("fileviewHighlight(" + JSON.stringify("plain <b> & nothing") + ",'text')"),
  esc("plain <b> & nothing"),
  "未知语言与 txt/log/csv 一样只转义成纯文本（零 span）",
);
{
  const RICH = {
    js: ["jsl-com", "jsl-str", "jsl-num", "jsl-kw", "jsl-punc"],
    py: ["jsl-com", "jsl-str", "jsl-kw", "jsl-fn"],
    css: ["jsl-com", "jsl-prop", "jsl-num", "jsl-punc"],
    html: ["jsl-fn", "jsl-prop", "jsl-str"],
    yaml: ["jsl-prop", "jsl-str", "jsl-num", "jsl-com"],
    md: ["jsl-kw", "jsl-str", "jsl-prop"],
    json: ["jsl-str", "jsl-punc"],
    sql: ["jsl-kw", "jsl-num"],
    diff: ["jsl-kw", "jsl-con", "jsl-str"],
  };
  for (const [lang, classes] of Object.entries(RICH)) {
    const sample =
      lang === "diff"
        ? "--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-const a = 1\n+const b = 2\nplain line\n"
        : lang === "md"
          ? "# 标题\n\n段落 **粗** `码` [链](u) <b>x</b>\n\n```js\nvar a = 1\n```\n"
          : HL_SRC;
    const h = CALL("fileviewHighlight(" + JSON.stringify(sample) + "," + JSON.stringify(lang) + ")");
    for (const c of classes)
      ok(h.indexOf('class="' + c + '"') >= 0, lang + " 命中 token 配色 ." + c);
    for (const m of h.matchAll(/class="(jsl-[a-z]+)"/g)) FV.dom.EMITTED.add(m[1]);
  }
}
ok(
  CALL("fileviewHighlight('const s = \"x' + String.fromCharCode(10) + 'const t = 2;','js').split(String.fromCharCode(10))[1].indexOf('jsl-kw')") > 0,
  "上一行引号没闭合也不污染下一行（第二行的 const 照样是关键字色）",
);

/* js / ts / json 必须与函数节点编辑器同一份词法（同源，不是第二份实现） */
const CED = loadFileview({ withCodeedit: true });
EQS(
  CED.EV("typeof jsHighlightHtml"),
  "function",
  "app-codeedit.js 先装载时，上下文里真有 jsHighlightHtml（index.html 的注册顺序就是它的前提）",
);
for (const l of ["js", "ts", "tsx", "json"]) {
  EQS(
    CED.EV("fileviewHighlight(" + JSON.stringify(HL_SRC) + "," + JSON.stringify(l) + ")"),
    CED.EV("jsHighlightHtml(" + JSON.stringify(HL_SRC) + ")"),
    l + " 直接委托 jsHighlightHtml：同一个文件在面板里和在函数节点编辑器里长得一模一样",
  );
}
ok(
  CED.EV("fileviewHighlight(" + JSON.stringify(HL_SRC) + ",'py')") !==
    CED.EV("jsHighlightHtml(" + JSON.stringify(HL_SRC) + ")"),
  "py 不走 js 词法（各语言各谱系，不是把一切当 JS 糊一遍）",
);
/* yaml 交给 app.js 的 YAML 编辑器口径：真源装载不到时给个可辨桩，验证「委托」这条边真的在 */
const YH = loadFileview({ yamlHook: true });
EQS(
  YH.EV("fileviewHighlight(" + JSON.stringify("a: 1\nb: 2") + ",'yaml')"),
  "Y[a: 1]\nY[b: 2]",
  "yaml 优先委托 app.js 的 highlightYamlLine（与 YAML 编辑器同源；逐行喂）",
);
EQS(
  FV.EV("fileviewHighlight(" + JSON.stringify("a: 1\nb: 2") + ",'yaml').split(String.fromCharCode(10)).length"),
  2,
  "拿不到 highlightYamlLine 时退回通用词法且不炸（切片单跑也能出结果）",
);

/* —— fvHtmlToRows：高亮层拆成「一行一块」，这是行号对齐的结构保证 —— */
const RT = (h) => JSON.stringify(CALL("fvHtmlToRows(" + JSON.stringify(h) + ")"));
EQS(
  RT('<span class="jsl-com">a\nb</span>'),
  JSON.stringify(['<span class="jsl-com">a</span>', '<span class="jsl-com">b</span>']),
  "跨行的 token 先补 </span> 再在下一行原样重开（颜色不断行，也不留未闭合标签）",
);
EQS(
  RT('<span class="a">x<span class="b">y\nz</span>w</span>'),
  JSON.stringify([
    '<span class="a">x<span class="b">y</span></span>',
    '<span class="a"><span class="b">z</span>w</span>',
  ]),
  "嵌套 span 按栈闭合（第二行知道自己还欠着外层那层 class）",
);
EQS(RT(""), JSON.stringify([""]), "空正文 → 一行空块（行号槽跟着出一个 1，不会零行）");
EQS(RT("a"), JSON.stringify(["a"]), "没有换行就是一块，不多切");
for (const l of ["js", "py", "css", "html", "yaml", "md", "diff", "text"]) {
  const h = CALL("fileviewHighlight(" + JSON.stringify(HL_SRC) + "," + JSON.stringify(l) + ")");
  EQS(
    CALL("fvHtmlToRows(" + JSON.stringify(h) + ").length"),
    h.split(String.fromCharCode(10)).length,
    "拆块行数严格等于换行数（" + l + "）—— 行号槽与代码层同数",
  );
  EQS(
    CALL("fvHtmlToRows(" + JSON.stringify(h) + ").map(s=>s.replace(/<\\/?span[^>]*>/g,'')).join(String.fromCharCode(10))"),
    h.replace(/<\/?span[^>]*>/g, ""),
    "拆块不吞不增正文（" + l + "）：拼回去逐字等于原高亮输出",
  );
  const unbal = Array.from(CALL("fvHtmlToRows(" + JSON.stringify(h) + ")")).filter(
    (s) => (s.match(/<span[^>]*>/g) || []).length !== (s.match(/<\/span>/g) || []).length,
  );
  ok(unbal.length === 0, "每一块内部标签自平（" + l + "）：某一行不会把后面所有行的配色带跑");
}

/* ═══════════════ [3] 徽标：真跑 dshToolFileBadges 与两个渲染出口 ═══════════════ */
console.log("\n[3] 工具条文件徽标 + dshToolDetailsEl / planLiveBlock 两个出口（假 DOM 真跑）");
const BAD = loadFileview({
  assistWs: "E:\\dev\\assist",
  nodeId: "n1",
  nodeWs: "E:\\proj\\node",
  sessionId: "s9",
  sessionWs: "E:\\proj\\sess",
});
/* 探针：把 toolFileRefs 包一层计数，钉「徽标确实经过它」而不是另写一份识别 */
BAD.EV(
  "globalThis.__trf=0; (function(){ var o=toolFileRefs; toolFileRefs=function(t){ globalThis.__trf++; return o(t); }; })(); " +
    "globalThis.__peek=[]; (function(){ var o=toggleFilePeek; toggleFilePeek=function(p,q){ globalThis.__peek.push([p,q]); return o(p,q); }; })();",
);
const badges = (t, owner) => BAD.EV("dshToolFileBadges(" + JSON.stringify(t) + "," + JSON.stringify(owner) + ")");
const kids = (f) => (f ? f.children : []);
const clsTxt = (f) => kids(f).map((c) => c.className.replace("dsh-tool-file", "").trim() + ":" + c.textContent).join(" ");

EQS(BAD.EV("__trf"), 0, "探针就位：还没跑任何徽标");
{
  const f = badges({ name: "read", args: '{"file_path":"E:/a/b.js","offset":120,"limit":80}' }, "assist");
  ok(!!f && kids(f).length === 1, "read 一条工具一枚徽标");
  EQS(f.children[0].className, "dsh-tool-file m-read", "读 = 青（m-read 档）");
  EQS(f.children[0].textContent, "b.js", "徽标正文只有文件名（全路径进 title，不撑爆那一行）");
  EQS(f.children[0].title, "读 · E:\\a\\b.js · L120×80", "title = 模式 · 完整路径 · 本次读的行区间");
  ok(BAD.EV("__trf") > 0, "徽标确实经过 toolFileRefs（没有偷偷写第二份识别）");
  const ev = f.children[0].fire("click");
  ok(ev.__pd > 0 && ev.__sp > 0, "点击徽标 preventDefault + stopPropagation（不连带展开 / 收起参数详情）");
  EQS(JSON.stringify(BAD.EV("__peek[__peek.length-1]")), JSON.stringify(["E:\\a\\b.js", { mode: "read", line: 120, count: 80 }]), "点击把 {mode,line,count} 原样交给面板（点开就落在它读过的那一段）");
  EQS(f.children[0].fire("mousedown").__sp > 0 ? 1 : 0, 1, "mousedown 也拦住（details 在这一步就会响应）");
}
EQS(clsTxt(badges({ name: "write", args: { file_path: "E:/w/out.md" } }, "assist")), "m-write:out.md", "写类工具 = 橙（m-write 档）");
EQS(clsTxt(badges({ name: "glob", args: { path: "src" } }, "assist")), "m-dir:src", "检索类工具 = 灰（m-dir 档）");
EQS(
  clsTxt(badges({ name: "read", args: { file_path: "sub/a.js" } }, "s9")),
  "m-read:a.js",
  "会话 ownerId 走 agentRunWorkspace 补基准（相对路径 → 该会话生效工作区）",
);
EQS(badges({ name: "read", args: { file_path: "sub/a.js" } }, "s9").children[0].title, "读 · E:\\proj\\sess\\sub\\a.js", "会话基准的 title 是补全后的全路径");
EQS(badges({ name: "edit", args: { file_path: "b.js" } }, "n1").children[0].title, "改 · E:\\proj\\node\\b.js", "节点 ownerId 走 dshWorkspaceOf 基准");
EQS(badges({ name: "read", args: { file_path: "c.js" } }, "assist").children[0].title, "读 · E:\\dev\\assist\\c.js", "助手那条（字面量 assist）走 assistResolveWorkspace 基准");
EQS(BAD.EV("__wsHits.ws + __wsHits.sess + __wsHits.assist + __wsHits.byId * 0"), 3, "工作区按 ownerId 缓存：重复算同一宿主不重复打真源（工具条每个 live tick 都重算）");
{
  const peekN = BAD.EV("__peek.length");
  const f = badges({ name: "read", args: { file_paths: ["E:/w/a.js", "E:/w/b.js", "E:/w/c.js", "E:/w/d.js"] } }, "zzz-no-ws");
  EQS(clsTxt(f), "m-read:a.js m-read:b.js m-read:c.js fv-more:+1", "最多 3 枚，多余收成 +N");
  ok(f.children[3].textContent === "+1" && f.children[3].title.indexOf("还有 1 个文件") >= 0 && f.children[3].title.indexOf("E:\\w\\d.js") > 0,
    "+N 写着还剩几枚、title 列出没展出的文件名与全路径");
  f.children[3].fire("click");
  EQS(f.children.map((c) => c.textContent).join(","), "a.js,b.js,c.js,d.js", "点 +N 就地展开成完整徽标串（旧那枚消失，不叠第二浮层）");
  ok(f.children.every((c) => c.__cls.has("dsh-tool-file")), "展开出来的每一枚都还是同一套徽标（点得到、颜色对）");
  EQS(BAD.EV("__peek.length"), peekN, "点 +N 只展开，不开面板");
}
{
  const before = BAD.EV("__peek.length");
  const f = badges({ name: "read", args: { file_path: "rel/only.js" } }, "no-such-owner");
  const ev = f.children[0].fire("click");
  ok(ev.__pd > 0 && ev.__sp > 0, "解析不出基准时点击同样先拦住（不会顺手把参数详情展开出去）");
  EQS(BAD.EV("__peek.length"), before, "基准解析不出 → 不开面板");
  EQS(BAD.toasts.slice(-1)[0][0], "这个会话还没解析出工作目录，只给你看文件名", "只给一句提示，不猜路径");
  EQS(BAD.toasts.slice(-1)[0][1], "warn", "提示是 warn 档");
}
EQS(JSON.stringify(badges({ name: "pwsh", args: { workdir: "E:/x", command: "dir" } }, "assist")), "null", "非文件工具 → null（调用方什么都不挂）");
EQS(JSON.stringify(badges({ name: "read", args: { file_path: "" } }, "assist")), "null", "空路径 → null");
EQS(JSON.stringify(badges(null, "assist")), "null", "null 记录 → null（不抛）");

/* —— 两个渲染出口：真跑，不抄逻辑 —— */
const ASSIST = read("renderer/app-assist.js");
const PLAN = read("renderer/app-plan.js");
const OUT = loadFileview({
  assistWs: "E:\\dev\\assist",
  nodeId: "n1",
  nodeWs: "E:\\proj\\node",
  sessionId: "s9",
  sessionWs: "E:\\proj\\sess",
});
OUT.EV(
  fnBody(ASSIST, "dshToolDetailsEl") +
    "\n" +
    fnBody(PLAN, "planPanelEl") +
    "\n" +
    fnBody(PLAN, "planLiveBlock") +
    "\nconst PLAN_LIVE_TOOL_SHOW = 20;\n" +
    "function planLiveDur(ms){ return (Math.round((ms||0)/1000)) + 's'; }\n" +
    "function plainTextToLinkHtml(s){ return String(s||''); }\n" +
    "function toolResultText(){ return ''; }\n" +
    "function fmtTime(t){ return 'T' + t; }\n" +
    "var S = { openDshTools: {} };\n" +
    "globalThis.__peek2 = []; (function(){ var o = toggleFilePeek; toggleFilePeek = function(p,q){ globalThis.__peek2.push([p,q]); }; })();",
);
{
  const det = OUT.EV("dshToolDetailsEl({name:'read',args:{file_path:'E:/s/deep/nested.js',offset:7},callId:'c1'},false,'s9')");
  const sum = det.children.find((c) => c.tagName === "summary");
  ok(!!sum, "dshToolDetailsEl 造出 details + summary");
  EQS(sum.children[0].className, "dsh-tool-chip", "summary 的第一个孩子才是那颗「工具按钮」（药丸）—— 文件名不塞在它里面");
  EQS(sum.children[0].textContent, "🔧 read", "药丸里只有工具名：文件名再长也不撑大按钮、不看着像工具名的一部分");
  EQS(sum.children[1].className, "dsh-tool-file m-read", "文件名挂在按钮后方，仍是同一份徽标（class 与 [3] 一致）");
  sum.children[1].fire("click");
  EQS(JSON.stringify(OUT.EV("__peek2[__peek2.length-1]")), JSON.stringify(["E:\\s\\deep\\nested.js", { mode: "read", line: 7 }]), "点击走面板，且带 offset 定位");
  EQS(det.open, false, "点徽标没把 details 展开（preventDefault 生效）");
  const det2 = OUT.EV("dshToolDetailsEl({name:'pwsh',args:{workdir:'E:/x',command:'ls'},callId:'c2'},true,'s9')");
  const sum2 = det2.children.find((c) => c.tagName === "summary");
  EQS(sum2.children.map((c) => c.textContent).join(" "), "◌ pwsh", "非文件工具：那一行只有「◌ 工具名」那颗按钮，不多挂任何东西");
  ok(sum2.children.length === 1 && sum2.children[0].className === "dsh-tool-chip", "非文件工具时 summary 里只剩那颗按钮本身");
  HAS(ASSIST, 'if (typeof dshToolFileBadges === "function")', "出口先探测符号（分块加载 / 切片跑测时不抛）");
  HAS(ASSIST, 'sum.className = "dsh-tool-sum"', "summary 不再是药丸本身（外框让给里面那颗按钮，两者不再同义）");
  HAS(ASSIST, "sum.appendChild(chip)", "按钮先挂上，文件名随后挂在它后面");
  HAS(ASSIST, "sum.appendChild(badges)", "文件名 append 到 summary（按钮外面），不是 append 到 chip 里面");
  ok(!/chip\.appendChild\(badges\)/.test(ASSIST), "绝不把文件名塞回工具按钮里面");
}
{
  /* 计划面板那份 args 是截断过的字符串 —— 正好看 [1] 的正则兜底 */
  const box = OUT.EV(
    "planLiveBlock({state:'running',text:'正文',tools:[{name:'str_replace_editor',state:'done',args:'" +
      JSON.stringify('{"command":"view","path":"E:/p/live.js","file_text":"long body…').slice(1, -1) +
      "'}]},'s9')",
  );
  const rows = box.children.filter((c) => c.__cls.has("ap-live-tools"));
  const it = rows[0].children.find((c) => c.__cls.has("ap-tool"));
  EQS(it.children.map((c) => c.textContent).join(""), "🔧 str_replace_editorlive.js✓", "计划面板「🔧 名称」行同一徽标同源挂上");
  EQS(it.children[1].className, "dsh-tool-file m-read", "截断 args 的 command 兜底生效：view 判成读（青），不是橙");
  it.children[1].fire("click");
  EQS(JSON.stringify(OUT.EV("__peek2[__peek2.length-1]")), JSON.stringify(["E:\\p\\live.js", { mode: "read" }]), "计划面板的基准 = 所属会话（agentRunWorkspace 真源）");
  HAS(PLAN, "planLiveBlock(live, st && st.id)", "调用点把所属会话 id 传进去（基准不靠猜）");
}

/* ═══════════════ [4] 右侧文件查看面板（假 DOM 真跑） ═══════════════ */
console.log("\n[4] openFilePeek / closeFilePeek：假 DOM 真跑 + persistent 硬断言");
const FILES = {
  "E:\\ws\\src\\a.js": { size: 260, content: "const a = 1;\nfunction f(){ return a + 2; }\n// 尾行\n" },
  "E:\\ws\\src\\big.js": { size: 9 * 1024 * 1024, content: "x".repeat(9 * 1024 * 1024) },
  "E:\\ws\\src\\gone.js": null,
  "E:\\ws\\docs\\note.md": { size: 40, content: "# 标题\n\n正文 **粗** <b>x</b>\n" },
  "E:\\ws\\assets\\p.png": { size: 900, binary: true },
};
const PV = loadFileview({
  sessionId: "pv",
  sessionWs: "E:\\ws",
  localStorage: { filePeekSize: JSON.stringify({ w: 700, wrap: false }) },
  api: {
    fileIsDir: (p) => Promise.resolve(String(p).slice(-3) === "src"),
    fileStat: (p) => Promise.resolve(FILES[p] ? { ok: true, size: FILES[p].size } : { ok: false, error: "ENOENT" }),
    fileReadText: (p) => Promise.resolve(FILES[p] && !FILES[p].binary ? { exists: true, content: FILES[p].content } : { exists: false }),
    assetMeta: () => Promise.resolve({ ok: true, bytes: 900, width: 512, height: 256 }),
    fileListDir: () => Promise.resolve({ ok: true, list: [{ rel: "src/a.js", size: 260 }, { rel: "src/deep/nested.js", size: 90 }, { rel: "docs/note.md", size: 40 }] }),
    shellShowItem: () => Promise.resolve(true),
    toFileUrl: (p) => "file:///" + String(p).replace(/\\/g, "/"),
  },
});
const host = () => PV.EV("document.getElementById('filePeek')");
(async () => {
  ok(PV.EV("openFilePeek('E:\\\\ws\\\\src\\\\a.js',{mode:'read',line:2})") === true, "openFilePeek：绝对路径 + 行号打开成功");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const h = host();
  ok(!!h && h.classList.contains("on"), "面板宿主懒建并置 .on（只此一个实例）");
  EQS(PV.EV("localStorage.__store.filePeekSize ? JSON.parse(localStorage.__store.filePeekSize).w : -1"), 700, "宽度取 localStorage 记下的偏好（review 面板同一惯例）");
  EQS(h.style.width, "700px", "记住的宽度落到内联样式");
  const name = PV.EV("document.getElementById('filePeek').querySelector('#fpName')");
  EQS(name.textContent, "a.js", "头部显示文件名");
  EQS(name.title, "E:\\ws\\src\\a.js", "头部 title 是全路径");
  const meta = PV.EV("document.getElementById('filePeek').querySelector('#fpMeta')");
  ok(/260 B/.test(meta.textContent) && /3 行|4 行/.test(meta.textContent) && /\bjs\b/.test(meta.textContent), "头部小字含体积 / 行数 / 语言：" + meta.textContent);
  ok(/L2\b/.test(meta.textContent), "这次请求读的行区间（L2）也写进头部小字");
  const scroller = PV.EV("document.getElementById('filePeek').querySelector('#fpScroll')");
  const gutter = scroller.children.find((c) => c.__cls.has("fp-gutter"));
  const code = scroller.children.find((c) => c.__cls.has("fp-code"));
  ok(!!gutter && !!code, "代码视图 = 行号槽 + 高亮层两块");
  const lrows = findAll(code, "fp-l");
  EQS(lrows.length, 4, "代码层一行一块（.fp-l 块数 = 源文件行数，含末尾那个空行）");
  EQS(gutter.textContent.split("\n").length, lrows.length, "行号与正文逐行同数：结构对齐，不靠像素折算");
  EQS(gutter.textContent, "1\n2\n3\n4", "行号从 1 连续排到最后一行（整份都在，不再被裁成一屏高）");
  ok(code.innerHTML.indexOf('class="jsl-kw"') >= 0, "高亮层真的着上色（复用 .jsl-* 一套）");
  ok(code.innerHTML.indexOf("<script") < 0, "正文里的尖括号不成真标签（面板同样不注入）");
  ok(!one(code, "fp-jm") && !one(code, "fp-linehi"), "旧的零宽哨兵与绝对定位标记带已下架（错位就是它们带来的）");
  EQS(lrows[1].className.replace("fp-l", "").trim(), "cur", "opts.line=2 → 恰好第二块带 .cur 整行标记");
  ok(!lrows[0].__cls.has("cur") && !lrows[2].__cls.has("cur"), "只标目标行，不是整片一起亮");
  EQS(PV.EV("document.getElementById('filePeek').querySelector('#fpWrapBtn').hidden"), false, "代码视图下「折行」按钮可用");
  PV.EV("document.getElementById('filePeek').querySelector('#fpWrapBtn').fire('click')");
  ok(scroller.__cls.has("fp-wrap"), "点「折行」→ .fp-wrap（可切换，不是只读摆设）");
  EQS(PV.EV("JSON.parse(localStorage.__store.filePeekSize).wrap"), true, "折行偏好与宽度存同一个键（重启还认得）");
  PV.EV("document.getElementById('filePeek').querySelector('#fpWrapBtn').fire('click')");
  ok(!scroller.__cls.has("fp-wrap"), "再点一次切回不换行");

  /* 最近文件横条 + 各视图 */
  PV.EV("openFilePeek('E:\\\\ws\\\\docs\\\\note.md',{mode:'write'})");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const strip = PV.EV("document.getElementById('filePeek').querySelector('#fpRecent')");
  EQS(strip.children.filter((c) => /fp-rchip/.test(c.className)).length, 2, "顶部最近文件横条出两枚（同一面板内切换，不叠第二实例）");
  ok(!!strip.children.find((c) => /fp-rchip/.test(c.className) && /\bcur\b/.test(c.className)), "当前文件那一枚带 .cur");
  EQS(PV.EV("document.getElementById('filePeek').querySelector('#fpMode').textContent"), "改", "mode:'write' → 头部模式徽标写「改」");
  ok(PV.EV("JSON.stringify(FV_PEEK)") !== "null", "面板运行态就位（版本与内容都在模块内，随节点无关）");
  const mdbtn = PV.EV("document.getElementById('filePeek').querySelector('#fpMdBtn')");
  EQS(mdbtn.hidden, false, "md 文件出「源码 / 渲染」切换按钮");
  PV.EV("document.getElementById('filePeek').querySelector('#fpMdBtn').fire('click')");
  ok(!!one(host().querySelector("#fpScroll"), "fp-md"), "切「渲染」走 md 视图（复用应用内阅读器版式）");
  PV.EV("document.getElementById('filePeek').querySelector('#fpMdBtn').fire('click')");
  ok(!one(host().querySelector("#fpScroll"), "fp-md"), "切回「源码」仍是行号 + 高亮");
  EQS(PV.EV("document.getElementById('filePeek').querySelector('#fpWrapBtn').hidden"), false, "md 源码视图还是代码视图：折行按钮留着");

  PV.EV("openFilePeek('E:\\\\ws\\\\src\\\\big.js',{mode:'read'})");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  ok(textOf(one(host().querySelector("#fpScroll"), "fp-blank")).indexOf("文件过大") >= 0, "超体积上限：明确说「文件过大」而不是假装它只有这么多");

  PV.EV("openFilePeek('E:\\\\ws\\\\assets\\\\p.png',{mode:'read'})");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  ok(!!one(host().querySelector("#fpScroll"), "fp-img"), "图片扩展名走内嵌预览");
  ok(/512×256/.test(PV.EV("document.getElementById('filePeek').querySelector('#fpMeta').textContent")), "图片头部给出像素尺寸");

  PV.EV("openFilePeek('E:\\\\ws\\\\src',{mode:'dir'})");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const dirScroll = PV.EV("document.getElementById('filePeek').querySelector('#fpScroll')");
  EQS(findAll(dirScroll, "fp-dir-row").length, 3, "path 指向目录 → fileListDir 出条目（点条目再开文件）");
  ok(PV.EV("document.getElementById('filePeek').querySelector('#fpNote')").textContent.indexOf("node_modules") >= 0, "目录视图说明这是递归列表并跳过 node_modules / .git");
  EQS(PV.EV("document.getElementById('filePeek').querySelector('#fpWrapBtn').hidden"), true, "目录 / 图片这类非代码视图收起「折行」（不留个按了没反应的按钮）");

  PV.EV("openFilePeek('E:\\\\ws\\\\src\\\\gone.js',{mode:'write'})");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  ok(textOf(one(host().querySelector("#fpScroll"), "fp-blank")).indexOf("还不存在") >= 0, "被改但还没落盘的文件：说「现在还不存在」，不给空白卡");

  PV.EV("openFilePeek('rel/only.js',{mode:'read'})");
  EQS(PV.toasts.slice(-1)[0][0], "无法定位该文件的完整路径，只给你看文件名", "没有 base 又解析不出绝对路径：只提示，不开面板");
  PV.EV("openFilePeek('',{mode:'read'})");
  ok(PV.EV("openFilePeek(null)") === false, "空路径直接 false（不建 DOM、不清空当前在看的内容）");

  /* —— persistent 硬断言（监听普查放到整轮跑完之后，见本节末尾）—— */
  const fvSrc = read("renderer/app-fileview.js");
  ok(!/if\s*\(\s*(?:ev|e)\.target\s*===\s*host/.test(fvSrc), "源码里没有「ev.target === host」式关闭（与 smoke-dialog-persistence 同判据）");
  ok(fvSrc.indexOf("fp-mask") < 0 && fvSrc.indexOf("backdrop") < 0, "面板没有蒙层：用户可一边看文件一边让会话继续跑");
  const closeCalls = (fvSrc.match(/closeFilePeek\(\)/g) || []).length;
  ok(closeCalls >= 2 && closeCalls <= 4, "关闭出口只有显式那几条（✕ / Esc / 再点同一徽标 · 命中 " + closeCalls + " 处）");
  HAS(fvSrc, 'if (ev.key === "Escape")', "Esc 收起（键盘是显式路径）");
  HAS(fvSrc, 'querySelector("#fpCloseBtn").onclick', "头部 ✕ 收起");
  HAS(fvSrc, "position: fixed", "面板是贴边浮层（position:fixed）");
  HAS(fvSrc, "filePeekSyncBounds()", "上下边界现量顶栏 / 状态栏（顶栏换行也不写死）");

  /* —— 显式关闭 —— */
  PV.EV("document.getElementById('filePeek').querySelector('#fpCloseBtn').fire('click')");
  ok(PV.EV("filePeekIsOpen()") === false, "点 ✕ → 关闭");
  ok(!host().classList.contains("on"), "关闭时摘掉 .on（面板收起，不留在画布上）");
  PV.EV("openFilePeek('E:\\\\ws\\\\src\\\\a.js',{mode:'read'})");
  await new Promise((r) => setImmediate(r));
  PV.EV("document.getElementById('filePeek').fire('keydown',{key:'Escape'})");
  ok(PV.EV("filePeekIsOpen()") === false, "Esc → 关闭");
  PV.EV("openFilePeek('E:\\\\ws\\\\src\\\\a.js',{mode:'read'})");
  await new Promise((r) => setImmediate(r));
  PV.EV("toggleFilePeek('E:\\\\ws\\\\src\\\\a.js',{mode:'read'})");
  ok(PV.EV("filePeekIsOpen()") === false, "再点同一个徽标 = 收起（唯一的开关式关闭路径）");

  /* —— 拖左缘改宽 —— */
  PV.EV("openFilePeek('E:\\\\ws\\\\src\\\\a.js',{mode:'read'})");
  await new Promise((r) => setImmediate(r));
  const rz = PV.EV("document.getElementById('filePeek').querySelector('#fpResize')");
  one(host(), "fp-box").offsetWidth = Number(String(host().style.width).replace('px','')); 
  rz.fire("mousedown", { clientX: 740 });
  PV.dom.doc.fire("mousemove", { clientX: 500 });
  PV.dom.doc.fire("mouseup", {});
  EQS(String(host().style.width), "940px", "左缘拖宽真的改了宽度（往左拖 240px → 宽 240px，跟鼠标走）");
  EQS(PV.EV("JSON.parse(localStorage.__store.filePeekSize).w"), Number(String(host().style.width).replace("px", "")), "拖完把宽度记回 localStorage");
  PV.EV("filePeekSetWidth(10, true)");
  EQS(Number(String(host().style.width).replace("px", "")), 360, "宽度夹下界 360（不会拖成一条缝）");
  PV.EV("filePeekSetWidth(99999, true)");
  EQS(Number(String(host().style.width).replace("px", "")), 1120, "宽度夹上界（窗口宽 - 320，绝不盖住整块画布）");

  /* —— persistent 硬断言：整轮（含拖宽）跑完，全局监听普查里不许出现「点外部即关」 —— */
  const docTypes = Array.from(new Set(PV.dom.doc.__listeners));
  const winTypes = Array.from(new Set(PV.dom.win.listeners));
  ok(
    docTypes.every((t) => /move|up/i.test(t)) &&
      !/(^|,|\b)(click|pointerdown|mousedown|blur|focusout)(,|$|\b)/.test(docTypes.join(",")),
    "document 上只出现过拖拽相关监听（" + (docTypes.join(",") || "无") + "）：没有点外部即关",
  );
  EQS(winTypes.join(","), "resize", "window 上只有 resize（跟随顶栏 / 状态栏重算边界），没有任何点外部关闭监听");
  PV.dom.doc.fire("click", { target: PV.dom.doc.body });
  ok(PV.EV("filePeekIsOpen()") === true, "开着面板时补一发 document click 也没被关掉（persistent）");

  /* ═══════════════ [5] 接线与样式链 ═══════════════ */
  console.log("\n[5] 脚本注册顺序 · style.css @import · CSS 规则对账 · build.json 通配 · i18n");
  const HTML = read("renderer/index.html");
  const iCe = HTML.indexOf('<script src="app-codeedit.js"></script>');
  const iFv = HTML.indexOf('<script src="app-fileview.js"></script>');
  const iAs = HTML.indexOf('<script src="app-assist.js"></script>');
  const iPl = HTML.indexOf('<script src="app-plan.js"></script>');
  const iApp = HTML.indexOf('<script src="app.js"></script>');
  ok(iApp >= 0 && iCe > iApp && iFv > iCe, "app-fileview.js 注册在 app-codeedit.js 之后（js/ts/json 高亮才委托得到）");
  ok(iFv > iCe && iAs > iFv, "app-fileview.js 注册在 app-assist.js 之前（消费它的那个出口在它后面）");
  ok(iFv > iCe && iPl > iFv, "app-fileview.js 也先于 app-plan.js（计划面板同源）");
  EQS((HTML.match(/<script src="app-fileview\.js"><\/script>/g) || []).length, 1, "app-fileview.js 在脚本表里只注册一次");
  const ENTRY = read("renderer/style.css");
  HAS(ENTRY, '@import url("./css/fileview.css");', "style.css 聚合入口真的 @import css/fileview.css");
  ok(ENTRY.indexOf('@import url("./css/theme-light.css");') < ENTRY.indexOf('@import url("./css/fileview.css");'), "fileview.css 排在 theme-light 之后（亮色靠 body.theme-light 更高优先级压住）");
  HAS(ENTRY, '@import url("./css/dsh.css");', "dsh.css（徽标那一段）也真在装载链里");
  {
    const BUILD = read("build.json");
    ok(/"renderer\/\*\*"/.test(BUILD), "build.json 走 renderer/** 通配（新文件随包，不需另改白名单）");
  }
  /* —— 运行时真实吐出的每个 class 都必须在 CSS 里有规则；反过来 CSS 里也不留 JS 从不用的死规则 —— */
  {
    const FVCSS = read("renderer/css/fileview.css");
    const DSHCSS = read("renderer/css/dsh.css");
    const CANVASCSS = read("renderer/css/canvas.css");
    const LIGHT = read("renderer/css/theme-light.css");
    const emitted = Array.from(PV.dom.EMITTED).concat(Array.from(BAD.dom.EMITTED));
    const inCss = (c) => {
      const re = new RegExp("\\." + c.replace(/[-]/g, "-") + "(?![\\w-])");
      return re.test(FVCSS) || re.test(DSHCSS) || re.test(CANVASCSS) || re.test(assistCss());
    };
    const assistCss = () => ASSISTCSS;
    const ASSISTCSS = read("renderer/css/assist.css");
    const interesting = Array.from(new Set(emitted)).filter(
      (c) => /^(fp-|jsl-|dsh-tool-file|fv-more|ap-|md-viewer-doc)/.test(c),
    );
    ok(interesting.length >= 40, "收集到运行时真实使用的 class 共 " + interesting.length + " 个");
    const missing = interesting.filter((c) => !inCss(c));
    ok(missing.length === 0, "面板 / 徽标 / 高亮吐出的每个 class 在 CSS 里都真有规则（" + interesting.length + " 个）");
    missing.forEach((c) => console.log("  MISS  ." + c));
    /* 死规则：CSS 里写了 .fp-x 但 JS 从不吐这个 class（写了没用到 = 下一个会话不敢删） */
    const usedInJs = new Set((fvSrc.match(/\bfp-[A-Za-z0-9_-]+/g) || []).concat(fvSrc.match(/\bdsh-tool-file\b|\bfv-more\b/g) || []));
    const cssTokens = new Set(
      (FVCSS + "\n" + DSHCSS + "\n" + LIGHT)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(/\n/)
        .filter((l) => /[{}]/.test(l) || /\{/.test(l))
        .flatMap((l) => (l.match(/\.(?:fp-[A-Za-z0-9_-]+|dsh-tool-file|fv-more)/g) || []))
        .map((s) => s.slice(1)),
    );
    const dead = Array.from(cssTokens).filter((c) => !usedInJs.has(c));
    ok(dead.length === 0, "fileview.css / dsh.css 里没有 JS 从不吐出的死 .fp-* 规则（" + cssTokens.size + " 条全部有对应用户路径）");
    dead.forEach((c) => console.log("  DEAD  ." + c));
    /* 徽标三档颜色齐备 + 亮色都有覆盖 */
    for (const m of ["m-read", "m-write", "m-dir"]) {
      ok(new RegExp("\\.dsh-tool-file\\." + m).test(DSHCSS), "dsh.css 有 .dsh-tool-file." + m + "（读青 / 改橙 / 目录灰）");
      ok(new RegExp("body\\.theme-light \\.dsh-tool-file\\." + m).test(LIGHT) || m === "m-read", "亮色主题覆盖到 ." + m);
    }
    ok(/\.dsh-tool-file\.fv-more/.test(DSHCSS), "收成 +N 那枚有独立中性色（不与读档混淆）");
    ok(/\.dsh-tool summary\s*\{[^}]*align-items:\s*center/s.test(DSHCSS) && /\.dsh-tool summary\s*\{[^}]*flex-wrap:\s*wrap/s.test(DSHCSS), "summary 排版：按钮与后面的文件名垂直居中 + 放不下就换行（不撑破工具条）");
    /* 文件名只是文字、且在工具按钮外面 —— 这两条都是用户明确要的，别再改回「带框的徽标塞进药丸」 */
    ok(!/\.dsh-tool-file\s*\{[^}]*border/s.test(DSHCSS) && !/\.dsh-tool-file\s*\{[^}]*background/s.test(DSHCSS), "文件名不给外框也不给底色（只是文字，边框底色属于那颗工具按钮）");
    ok(/\.dsh-tool-file:hover\s*\{[^}]*text-decoration:\s*underline/s.test(DSHCSS), "没有外框之后，可点的提示改成 hover 下划线");
    ok(/\.dsh-tool-chip:hover/.test(DSHCSS) && !/\.dsh-tool summary:hover/.test(DSHCSS), "悬停只涂那颗按钮（不再整行涂色，文件名点的是另一个面板）");
    ok(/\.dsh-tool\[open\] \.dsh-tool-chip/.test(DSHCSS) && /\.dsh-tool\.err \.dsh-tool-chip/.test(DSHCSS), "展开态 / 出错红都跟着那颗按钮（文件名不跟着变红）");
    ok(/\.dsh-tool-body\s*\{[^}]*border:\s*1px solid var\(--bd2\)/s.test(DSHCSS) && /\.dsh-tool-body\s*\{[^}]*margin-top:/s.test(DSHCSS), "参数框自带顶边并与按钮留缝（按钮不再与它黏合成一格）");
    ok(/body\.theme-light \.dsh-tool-chip:hover/.test(LIGHT), "亮色主题的悬停 / 展开态跟着改成那颗按钮");
    ok(!/body\.theme-light \.dsh-tool-file[^{]*\{[^}]*(?:border|background)/s.test(LIGHT), "亮色主题下文件名同样只有文字色（没把边框底色补回来）");
    ok(/\.fp-scroll\.fp-wrap \.fp-gutter/.test(FVCSS), "折行时收起行号槽（换行后行号对不上，宁可不显）");
    /* 行号「显示不完全」的两个真凶：stretch 把槽裁成一屏高 + 固定宽度截掉多位行号 */
    ok(
      /\.fp-gutter\s*\{[^}]*align-self:\s*flex-start/s.test(FVCSS) && /\.fp-gutter\s*\{[^}]*min-height:\s*100%/s.test(FVCSS),
      "行号槽按内容长（默认 align-items:stretch 会把它拉伸成一屏高再被 overflow:hidden 裁掉）",
    );
    ok(
      /\.fp-gutter\s*\{[^}]*width:\s*auto/s.test(FVCSS) && /\.fp-gutter\s*\{[^}]*min-width:\s*var\(--fp-gw\)/s.test(FVCSS),
      "行号槽宽度跟着最长行号走且留了下限（万行文件的 5 位行号不被截半截）",
    );
    ok(
      /\.fp-l\s*\{[^}]*display:\s*block/s.test(FVCSS) && /\.fp-l\s*\{[^}]*min-height:\s*calc/s.test(FVCSS),
      "一行一块 + 空行也撑成整行高（空行塌成 0 行就会让下面的行号整体顶偏）",
    );
    ok(/\.fp-l\.cur\s*\{[^}]*background:/s.test(FVCSS), "目标行整行标记写在行块自己身上（底色在字下面，不盖正文）");
    ok(!/\.fp-jm|\.fp-linehi/.test(FVCSS), "旧的零宽哨兵与绝对定位标记带样式随实现下架（不留死规则）");
    ok(/body\.theme-light \.fp-l\.cur/.test(LIGHT), "亮色主题跟着改成标记那一行（原来覆盖的是已删掉的 .fp-linehi）");
    ok(/\.fp-host\s*\{[^}]*z-index:/s.test(FVCSS), "面板有显式 z-index（压住画布但不挡对话框与 toast）");
    ok(/\.fp-host \[hidden\]/.test(FVCSS), "[hidden] 兜底（flex 作者样式会盖过浏览器默认隐藏）");
    ok(/--fp-gw|--fp-fs|--fp-lh/.test(FVCSS), "行号槽与代码层共用同一份度量变量（与 .js-edit 同思路：只写一次）");
    ok(!/position:\s*fixed/.test(read("renderer/css/theme-light.css")), "亮色覆盖不碰布局（只改颜色，改了就会与暗色那层错位）");
  }
  /* —— i18n：本轮新增中文串逐条命中 EN 表 —— */
  {
    const I18N = require(path.join(__dirname, "..", "renderer", "i18n.js"));
    const src = read("renderer/i18n.js");
    const EN_SRC = src.slice(0, src.indexOf("var locale ="));
    const keys = new Set();
    const re = /I18n\.t\(\s*(?:\/\*[\s\S]*?\*\/\s*)?"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(fvSrc))) {
      try {
        keys.add(JSON.parse('"' + m[1] + '"'));
      } catch (e) {}
    }
    ["读", "改", "目录", "折行", "不换行", "源码", "渲染", "行", "还有 ", " 个文件，点击展开", "这个会话还没解析出工作目录，只给你看文件名", "无法定位该文件的完整路径，只给你看文件名"].forEach((k) => keys.add(k));
    ok(keys.size >= 40, "提取到本轮中文串 " + keys.size + " 条（切片未失效）");
    I18N.setLocale("en");
    const miss = [];
    for (const k of keys) {
      const en = I18N.t(k);
      if (en === k || !String(en).trim()) miss.push(k);
    }
    ok(miss.length === 0, "i18n(en) 覆盖本轮每一条中文串（" + keys.size + " 条）");
    miss.forEach((k) => console.log("  MISS  " + JSON.stringify(k.slice(0, 48))));
    const pairs = [];
    const kre = /^\s{4}"((?:[^"\\]|\\.)*)"\s*:\s*(?:\n\s*)?"((?:[^"\\]|\\.)*)",?$/gm;
    let km;
    while ((km = kre.exec(EN_SRC))) pairs.push([JSON.parse('"' + km[1] + '"'), JSON.parse('"' + km[2] + '"')]);
    const byKey = new Map();
    for (const [k, v] of pairs) (byKey.get(k) || byKey.set(k, []).get(k)).push(v);
    const clash = [];
    for (const k of keys) {
      const vs = byKey.get(k);
      if (vs && vs.length > 1 && new Set(vs).size > 1) clash.push(k + " → " + JSON.stringify(vs));
    }
    ok(clash.length === 0, "本轮词条若撞上表里已有的键，英文值必须一致（不一致 = 后写的悄悄覆盖前一条）");
    clash.forEach((c) => console.log("  CLASH " + c));
    I18N.setLocale("zh");
    EQS(I18N.t("文件查看"), "文件查看", "zh 口径原样返回中文真源");
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " : "PASS ") + checks + " 项检查");
  process.exitCode = fails ? 1 : 0;
})();

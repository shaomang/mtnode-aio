"use strict";
/* 顶栏「排版」默认层级 —— 纯 Node 冒烟测试（不依赖 Electron / 不碰 %APPDATA%）
 *   node test/smoke-layout-scope.js
 *
 * 背景（本次修的 bug）：菜单里的「排版」只会排整张画布的顶层节点。用户「进入」某颗超级节点
 * 后（S.superFocus 指向那颗壳，画面里只有它的子节点）再点「排版」，排的是画面外的顶层节点，
 * 眼前这一层纹丝不动 —— 看起来就是「没用」。修后默认口径：
 *   · 停在壳里（S.superFocus = 壳）→ 排这颗壳的直接子节点（本层局部坐标 + 壳随内容撑开）；
 *   · 不在壳里（根层级）→ 沿用旧行为，排顶层节点；
 *   · 显式 scope:"global" / 确认框里选「排版整个画布」→ 才排整图（顶层 + 可选各壳内部）。
 *
 * 口径来源（都从真实源码里抠出来跑，不抄副本，改名 / 改实现立刻红）：
 *   · renderer/app-nodes.js  tidyLayoutWorkflow / currentTidyLevelHost /
 *                            tidyLayoutCurrentSuperLevel / tidyOneSuperInner / oneClickAutoLayout
 *   · renderer/app.js        snap / nodesBBox 同源函数
 * 排版引擎 layoutFlowEx 在本测量台里被替换成「按顺序横排」的假体：本测试只判「排了哪一层、
 * 落在哪套坐标系里、是否推撤销点」，不重复量分层几何（那由 test/smoke-rel-layout.js 负责）。
 * 覆盖：
 *   [1] 停在壳里：默认排本层（壳内子节点），顶层节点与壳本体都不动
 *   [2] 显式 scope:"global"：改排整图顶层，壳内不动
 *   [3] 根层级：沿用原行为，排顶层
 *   [4] 顶栏入口 oneClickAutoLayout：默认当前层级 / 选「整个画布」才全局 / 取消 = 什么都不做
 *   [5] 空壳：给「还没有可排版的节点」提示，不落撤销点
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

/* ---------- 从源码里按名字抠出顶层函数（只读，不改动源文件） ---------- */
function extract(src, names) {
  const out = [];
  for (const nm of names) {
    const pats = [
      new RegExp("\\n(?:async\\s+)?function " + nm + "\\s*\\(", "m"),
      new RegExp("\\nconst " + nm + "\\s*=", "m"),
    ];
    let at = -1;
    for (const p of pats) {
      const m = src.match(p);
      if (m) {
        at = m.index + 1;
        break;
      }
    }
    if (at < 0) throw new Error("源码里找不到函数：" + nm);
    /* 非函数（const 常量）：只取声明那一行 */
    if (!/^(?:async\s+)?function/.test(src.slice(at, at + 14))) {
      out.push(src.slice(at, src.indexOf("\n", at) + 1));
      continue;
    }
    const i = src.indexOf("{", at);
    let depth = 0;
    let inStr = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr) {
        if (c === inStr && p !== "\\") inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "/" && src[j + 1] === "/") {
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) {
          out.push(src.slice(at, j + 1));
          break;
        }
      }
    }
  }
  return out.join("\n");
}

const nodesSrc = read("renderer/app-nodes.js");
const appSrc = read("renderer/app.js");
const code = [
  extract(appSrc, ["snap"]),
  extract(nodesSrc, ["nodesBBox"]),
  extract(nodesSrc, [
    "tidyLayoutWorkflow",
    "currentTidyLevelHost",
    "tidyLayoutCurrentSuperLevel",
    "tidyOneSuperInner",
    "oneClickAutoLayout",
  ]),
].join("\n");

/* ---------- 测量台：一张「壳 s1（3 个子节点）+ 顶层 t1/t2」的画布 ---------- */
const mkNode = (id, kind, extra) =>
  Object.assign({ id, kind, title: id, x: 999, y: 999, w: 240, h: 160 }, extra || {});

function makeWorld(opts) {
  opts = opts || {};
  const wf = {
    nodes: [
      mkNode("s1", "super", { x: 5000, y: 5000, w: 600, h: 400, title: "壳A" }),
      mkNode("a1", "proc_text", { parentSuperId: "s1", title: "甲" }),
      mkNode("a2", "proc_text", { parentSuperId: "s1", title: "乙" }),
      mkNode("a3", "proc_text", { parentSuperId: "s1", title: "丙" }),
      mkNode("t1", "proc_text", { title: "顶层1" }),
      mkNode("t2", "proc_text", { title: "顶层2" }),
    ],
    wires: [],
    marks: [],
    groups: [],
  };
  if (opts.emptyShell) wf.nodes = wf.nodes.filter((n) => n.id === "s1" || n.id === "t1");

  const S = {
    wf,
    view: "workflow",
    superFocus: opts.superFocus === undefined ? "s1" : opts.superFocus,
    taskFocus: "",
    _skipCanvasHistory: false,
  };
  const events = { history: 0, toasts: [], fit: [], dialogs: [] };
  const answers = opts.answers || [];
  const sandbox = {
    S,
    events,
    console,
    /* I18n 桩：zh 口径原样回显 + {var} 替换（与 renderer/i18n.js 的 zh 分支一致） */
    I18n: {
      t(key, vars) {
        let s = String(key);
        if (vars)
          s = s.replace(/\{(\w+)\}/g, (_, k) =>
            vars[k] == null ? "" : String(vars[k]),
          );
        return s;
      },
    },
    isSuperIoNode: (n) => !!(n && n.kind === "super_io"),
    superChildrenOf: (id) => wf.nodes.filter((n) => n.parentSuperId === id),
    nodeById: (id) => wf.nodes.find((n) => n.id === id) || null,
    nodeParentSuperId: (n) => (n && n.parentSuperId) || "",
    nodeParentTaskId: (n) => (n && n.parentTaskId) || "",
    currentTaskFocus: () => S.taskFocus || "",
    currentSuperFocus: () => S.superFocus || "",
    marksOf: () => wf.marks,
    markById: (id) => wf.marks.find((m) => m.id === id) || null,
    markParentSuperId: (m) => (m && m.parentSuperId) || "",
    pushHistory: () => {
      events.history++;
    },
    renderCanvas: () => {},
    scheduleSave: () => {},
    setView: () => {},
    fitCanvas: () => {
      events.fit.push("canvas");
    },
    fitNodes: (list) => {
      events.fit.push((list || []).map((n) => n.id).join(","));
    },
    toast: (m) => {
      events.toasts.push(String(m));
    },
    grid: () => 8,
    layoutNodeSize: (n) => ({ w: (n && n.w) || 240, h: (n && n.h) || 160 }),
    sizeNodeForTidy: () => {},
    captureMarkBindings: () => [],
    rebindMarksAfterLayout: () => {},
    alignSuperContentTopLeft: (s) => {
      s.innerPanX = 0;
      s.innerPanY = 0;
    },
    fitSuperShellToContent: () => {},
    tidyAllSuperInners: () => ({ nodes: 0 }),
    /* 假排版引擎：按顺序横排 —— 足以判定「排了哪一层」，不重复量分层几何 */
    layoutFlowEx: (list, wires, origin) => {
      list.forEach((n, i) => {
        n.x = origin.x + i * 300;
        n.y = origin.y;
      });
    },
    confirmDialog: async (msg, o) => {
      events.dialogs.push({ msg: String(msg), o: o || null });
      return answers.shift() === true;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "layout-scope-extracted.js" });
  return { S, wf, events, sandbox };
}

const at = (w, id) => w.wf.nodes.find((n) => n.id === id);
const xy = (w, ids) => ids.map((id) => id + "=" + at(w, id).x + "," + at(w, id).y).join(" | ");

(async () => {
  console.log("[1] 停在壳里：默认排当前这一层（壳内子节点），顶层与壳本体都不动");
  {
    const w = makeWorld();
    const r = w.sandbox.tidyLayoutWorkflow({ notify: false });
    ok(r.ok && r.scope === "super", "回执 scope=super（实得 " + r.scope + "）");
    ok(
      at(w, "a1").x === 16 && at(w, "a2").x === 316 && at(w, "a3").x === 616 &&
        at(w, "a1").y === 16,
      "壳内子节点按本层局部坐标重排：" + xy(w, ["a1", "a2", "a3"]),
    );
    ok(
      at(w, "t1").x === 999 && at(w, "t2").x === 999,
      "顶层节点原地不动（不再越级去排整张画布）",
    );
    ok(at(w, "s1").x === 5000 && at(w, "s1").y === 5000, "壳本体坐标不动");
    ok(w.events.history === 1, "推了一次撤销点");
    ok(w.events.fit.length === 1 && w.events.fit[0] === "a1,a2,a3", "视野贴到本层子节点");
  }

  console.log("\n[2] 同一场景显式 scope:'global'：改排整图顶层，壳内不动");
  {
    const w = makeWorld();
    const r = w.sandbox.tidyLayoutWorkflow({ notify: false, scope: "global" });
    ok(r.ok && r.scope === "global", "回执 scope=global");
    ok(at(w, "t1").x === 364 && at(w, "t2").x === 664, "顶层按整图口径重排：" + xy(w, ["t1", "t2"]));
    ok(at(w, "a1").x === 999 && at(w, "a2").x === 999, "壳内子节点未被碰");
  }

  console.log("\n[3] 不在壳里（根层级）：沿用原行为，排顶层");
  {
    const w = makeWorld({ superFocus: "" });
    const r = w.sandbox.tidyLayoutWorkflow({ notify: false });
    ok(r.ok && r.scope === "global", "回执 scope=global（根层级 = 整图口径）");
    ok(at(w, "t1").x === 364, "顶层节点被排版（t1.x=" + at(w, "t1").x + "）");
  }

  console.log("\n[4] 顶栏入口 oneClickAutoLayout：壳内默认当前层级；选「整个画布」才全局");
  {
    const w = makeWorld({ answers: [true, false] });
    await w.sandbox.oneClickAutoLayout();
    ok(at(w, "a1").x === 16, "确认 + 「仅排版当前层级」→ 排的是壳内（a1.x=" + at(w, "a1").x + "）");
    ok(at(w, "t1").x === 999, "顶层未动");
    ok(
      /当前超级节点层级「壳A」/.test(w.events.dialogs[0].msg),
      "确认框点明排的是哪一层（带壳标题）",
    );
  }
  {
    const w = makeWorld({ answers: [true, true] });
    await w.sandbox.oneClickAutoLayout();
    ok(at(w, "t1").x === 364, "选「排版整个画布」→ 顶层被排（t1.x=" + at(w, "t1").x + "）");
    ok(at(w, "a1").x === 999, "该分支不再按本层口径排壳内");
  }
  {
    const w = makeWorld({ answers: [false] });
    await w.sandbox.oneClickAutoLayout();
    ok(
      w.events.history === 0 && at(w, "a1").x === 999,
      "第一问取消 → 什么都不做（无撤销点、无位移）",
    );
  }

  console.log("\n[5] 空壳：明确提示，不落撤销点");
  {
    const w = makeWorld({ emptyShell: true });
    const r = w.sandbox.tidyLayoutWorkflow({ notify: false });
    ok(r.ok === false && w.events.history === 0, "空壳回执 ok=false 且不推撤销点");
    const w2 = makeWorld({ emptyShell: true });
    await w2.sandbox.oneClickAutoLayout();
    ok(
      w2.events.toasts.some((t) => /还没有可排版/.test(t)),
      "入口给出「这颗超级节点里还没有可排版的节点」提示",
    );
  }

  console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
  if (fails) process.exit(1);
})();
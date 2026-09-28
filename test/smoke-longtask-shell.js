"use strict";
/**
 * test/smoke-longtask-shell.js —— 长周期任务「超级节点壳 + 生成工作流预置」
 *
 * 用户口径（本轮需求）：执行长任务时，每个环节的产出应当建立在**对应画布的一颗超级节点里**
 * （没有则建立），这颗超级节点与长任务绑定；涉及内容生成（图像 / 视频 / 音乐 / TTS）时，
 * 在该环节的超级节点内**建好生成工作流**，并要求**用户自己来执行生成**（生成可能产生高额费用）。
 *
 * 断言按层排：
 *   [1] 装配：index.html 加载顺序 / 三份引擎里的落点委派 / 画布壳标记与徽标 / css / i18n / 手册
 *   [2] 数据层真跑：**创建期预建**（LTSHELL.ensureForTask：父壳 + 子壳 + 生成工作流一次建齐、
 *       只建不跑、幂等、不写墓碑）/ 懒建父壳 + 环节子壳 / 产出与产物落子壳 /
 *       生成工作流预置（一律不跑）/ 控制靠上生成靠下 / 预建壳被 enable 认领而非重长 /
 *       删了不偷偷重长（墓碑 + 用户点重建才恢复）/ 存量产出迁移
 *   [3] 归属与清理：ltNormCfg 的 needsGen / genTypes 缺省口径 · 删任务只清绑定留壳与内容
 * 只读断言：不改任何文件、不起 Electron（vm 里整份装 app-longtask.js +
 * app-longtask-artifacts.js + app-longtask-shell.js 三份真身）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, ...rel.split("/")));

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
};
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

const APP = read("renderer/app.js");
const CANVASJS = read("renderer/app-canvas.js");
const LTCSS = read("renderer/css/canvas.css");
const I18N_SRC = read("renderer/i18n.js");
const HTML = read("renderer/index.html");
const LTV = read("renderer/app-longtask.js");
const LTUI = read("renderer/app-longtask-ui.js");
const LTARTJS = read("renderer/app-longtask-artifacts.js");
const SHELLJS = read("renderer/app-longtask-shell.js");
const MANUAL = read("guides/manual/longtask.md");
const MANUAL_EN = read("guides/manual/en/longtask.md");
const LTSH_EXPORT_OK = SHELLJS.slice(SHELLJS.indexOf("window.LTSHELL"));

/* ══════════════ [1] 装配与文档（静态） ══════════════ */
console.log("\n[1] 装配：加载顺序 / 落点委派 / 画布壳标记与徽标 / css / i18n / 手册");
has(HTML, '<script src="app-longtask-shell.js"></script>', "index.html 引入 app-longtask-shell.js");
ok(
  HTML.indexOf('src="app-longtask.js"') < HTML.indexOf('src="app-longtask-shell.js"') &&
    HTML.indexOf('src="app-longtask-artifacts.js"') < HTML.indexOf('src="app-longtask-shell.js"'),
  "加载顺序在 app-longtask.js 与 app-longtask-artifacts.js 之后（用到登记层与 makeNode）",
);
has(LTV, "function ltShellOutputPlace(", "产出落点走单一委派入口（引擎只认 window.LTSHELL）");
has(LTV, "function ltShellArtifactsParent(", "产物落点同一套委派");
has(LTSH_EXPORT_OK, 'presetGen: ltsPresetGen', "生成工作流预置由壳模块导出（引擎只按判空调用它）");
has(LTV, 'sh.outputFinalize(run, path, node)', "产出节点建好后交给壳模块改落点");
has(LTV, "ltShellOutputPlace(run, path, node);", "已有产出节点（重跑 / 旧档）也对齐落点");
has(LTARTJS, "ltShellArtifactsParent(run, path, node);", "产物节点建好后交给壳模块改落点");
has(LTARTJS, "if (typeof ltShellArtifactsParent === \"function\")", "壳模块缺席时按全局判空跳过（回落主画布层）");
hasnt(LTARTJS, "产物一律摆在主画布层", "旧的「产物一律摆主画布层」注释已改（新口径 = 落环节子壳）");
has(CANVASJS, 'el.classList.add("lt-shell")', "画布给长任务壳打 .lt-shell 标记");
has(CANVASJS, 'ltChip.className = "n-chip n-chip-lt"', "壳头部摆一枚只读「长任务 / 环节壳」徽标");
has(CANVASJS, 'I18n.t("长周期任务的产出壳：")', "徽标 tooltip 说明这是长任务的产出壳");
has(LTCSS, ".wf-node.super.lt-shell {", "长任务壳有专属色外框");
has(LTCSS, ".n-chip.n-chip-lt {", "徽标有专属色");
has(LTCSS, "body.theme-light .wf-node.super.lt-shell", "浅色主题同口径");
has(I18N_SRC, '"长任务": "Long task"', "i18n 有「长任务」词条且英文成对");
has(I18N_SRC, '"环节壳": "Step shell"', "i18n 有「环节壳」词条");
has(I18N_SRC, '"需要生成内容": "Needs generated content"', "i18n 有「需要生成内容」词条");
has(I18N_SRC, '"生成类型": "Generation types"', "i18n 有「生成类型」词条");
has(I18N_SRC, "Created this task's super node on the canvas", "英文词条成对（切英文不回中文）");
has(LTUI, 'ltT("需要生成内容")', "条带检查器有「需要生成内容」勾选（用户可改）");
has(LTUI, 'ltT("生成类型")', "条带检查器有「生成类型」多选");
has(LTV, "out.needsGen = !(c.needsGen === false", "ltNormCfg 归一 needsGen（缺省勾上，显式 false 才是关）");
has(LTV, '["image", "video", "music", "tts"].indexOf(s) >= 0', "ltNormCfg 归一 genTypes（只认四种生成类型）");
has(LTV, "只清掉壳上的任务绑定字段", "删任务时只清绑定、保留壳与内容");
has(LTUI, 'ltT("重建壳")', "壳被删后条带「⋯ 更多」里才出现「重建壳」入口（显式恢复，不是静默重长）");
has(LTUI, "if (needShell)", "重建入口只在墓碑落在本轮 run 上时出现");
has(MANUAL, "超级节点", "应用内手册写明超级节点壳口径");
has(MANUAL, "一律不运行", "手册写明生成工作流只建不跑");
has(MANUAL_EN, "super-node shell", "英文手册同步（AGENTS：手册中英成对）");
has(read("guides/nodes/ltout.md"), "超级节点子壳", "产出节点指南写明落点在环节子壳");
has(read("guides/nodes/en/ltout.md"), "super-node shell", "产出节点指南英文成对");
has(read("guides/nodes/ltart.md"), "超级节点子壳", "产物节点指南写明落点在环节子壳");
has(read("guides/nodes/en/ltart.md"), "super-node shell", "产物节点指南英文成对");
has(read("guides/nodes/super.md"), "长任务壳", "超节点指南列入「长任务壳」这一特殊形态");
has(read("guides/nodes/en/super.md"), "Long-task shell", "超节点指南英文成对");

/* ═══════════════ [2][3] 真跑（vm） ═══════════════ */
function buildSandbox() {
  const files = new Map();
  const setFile = (p, content) => files.set(String(p), { mtime: 1000, size: 100, content: content || "x" });
  let seq = 0;
  const S = { wf: { id: "wf-shell", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 }, workspace: "" }, config: {}, _skipCanvasHistory: false };
  const toasts = [];
  const sizes = {
    super: [280, 200],
    ltout: [360, 260],
    ltart: [260, 210],
    proc_image: [360, 200],
    video_gen: [400, 340],
    music_gen: [360, 300],
    tts_gen: [360, 300],
    control: [240, 140],
  };
  const sandbox = {
    window: {
      innerWidth: 1280,
      api: {
        fileStat: async (p) => {
          const f = files.get(String(p));
          return f ? { ok: true, mtime: f.mtime, size: f.size } : { ok: false, exists: false };
        },
        fileReadText: async (p) => {
          const f = files.get(String(p));
          return f ? { ok: true, exists: true, content: f.content } : { ok: false, exists: false };
        },
        toFileUrl: (p) => "file:///" + String(p || "").replace(/\\/g, "/"),
        ltRunSave: async () => ({ ok: true }),
        dshInteract: () => {},
      },
    },
    S: S,
    I18n: { t: (s) => s },
    document: { readyState: "loading", addEventListener() {}, getElementById() { return null; } },
    toast: (msg, kind) => toasts.push([msg, kind]),
    scheduleSave() {},
    renderCanvas() {},
    focusNode() {},
    pushHistory() {},
    closeAllNodePops() {},
    /* app.js 的 makeNode / addNode / uniqueNodeTitle 在沙箱里的等价物：
       本模块只依赖这三个建节点原语 + superChildrenOf（壳内子节点判定）。 */
    makeNode(kind, x, y) {
      const sz = sizes[kind] || [300, 200];
      return {
        id: "n" + ++seq,
        kind: kind,
        x: x,
        y: y,
        w: sz[0],
        h: sz[1],
        title: kind,
        parentSuperId: "",
        parentTaskId: "",
      };
    },
    addNode(kind, x, y, extra) {
      const n = sandbox.makeNode(kind, x, y);
      Object.assign(n, extra || {});
      S.wf.nodes.push(n);
      return n;
    },
    uniqueNodeTitle(desired, exceptId) {
      const base = String(desired || "").trim() || "节点";
      const taken = new Set(S.wf.nodes.filter((n) => n.id !== exceptId).map((n) => n.title));
      if (!taken.has(base)) return base;
      let i = 2;
      while (taken.has(base + " " + i)) i++;
      return base + " " + i;
    },
    addWire(from, to) {
      S.wf.wires.push({ id: "w" + S.wf.wires.length, from: from, to: to, toIndex: 0 });
    },
    superChildrenOf(id) {
      return S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(id));
    },
    console, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
  vm.runInContext(LTARTJS, sandbox, { filename: "renderer/app-longtask-artifacts.js" });
  vm.runInContext(SHELLJS, sandbox, { filename: "renderer/app-longtask-shell.js" });
  return { sandbox, S, files, setFile, toasts, seqOf: () => seq };
}

const AGENT_GRAPH = (title, cfg) => ({
  nodes: [
    { id: "start", kind: "start", title: "起点", cfg: {} },
    { id: "a1", kind: "agent", title: title, cfg: Object.assign({ goal: "写出这一环节的产物" }, cfg || {}) },
    { id: "end", kind: "end_ok", title: "完成", cfg: {} },
  ],
  edges: [
    { id: "e1", from: "start", to: "a1" },
    { id: "e2", from: "a1", to: "end" },
  ],
});

async function main() {
  const env = buildSandbox();
  const { sandbox, S, setFile, toasts } = env;
  const LT = sandbox.window.LT;
  const LTSH = sandbox.window.LTSHELL;
  ok(!!LT && !!LTSH, "三份脚本在同一沙箱里整份执行并导出 window.LT / window.LTSHELL（顶层不碰 DOM）");

  console.log("\n[2] 数据层真跑：创建期预建（只建不跑）/ 懒建壳 / 产出与产物落子壳 / 生成工作流预置（不跑）/ 布局 / 墓碑 / 迁移");

  /* ── ⓪ 创建期预建（本轮需求：创建即显示）：任务一经创建就把落点摆好，一律只建不跑 ──
     旧口径「跑到那一环才懒建」= 图上看得见图、画布上什么都没有；本轮改成创建即预建，
     懒建（ltsEnsure）退回运行期兜底与「壳被删」的墓碑口径。 */
  const made = LT.createFromGraph("演示任务", AGENT_GRAPH("写分镜"), S.wf);
  ok(made && made.ok, "先按正常路径落一张长任务图（任务条目进 wf.longtask，最后删任务那节要用）");
  const task = sandbox.ltTaskOf(S.wf, made.uid);
  const TID = String(task.uid);
  {
    has(SHELLJS, "function ltsEnsureForTask(wf, task) {", "壳模块有创建期预建口 ltsEnsureForTask");
    has(LTSH_EXPORT_OK, "ensureForTask: ltsEnsureForTask,", "LTSHELL.ensureForTask 已导出（引擎创建收尾按判空调用）");
    has(LTV, "function ltLandingCreate(wf, task) {", "引擎有预建总入口 ltLandingCreate（壳 / 生成工作流 + 交付节点）");
    has(LTV, "ltLandingCreate(wf, task);", "创建收尾（ltCreateFromGraph）真的调了预建总入口");
    {
      /* 源码级钉点：预建函数体里不许出现「跑」与「墓碑」的任何写法 ——
         只 makeNode + push，绝不调 runNode、绝不置 running、绝不写 run.shell* 字段。 */
      const body = SHELLJS.slice(
        SHELLJS.indexOf("function ltsEnsureForTask(wf, task) {"),
        SHELLJS.indexOf("/* ── ⑥ 壳被删的降级口径"),
      );
      ok(body.length > 500, "取到 ltsEnsureForTask 的真实现源码（下面三条静态断言才是有据可查）");
      hasnt(body, "runNode", "只建不跑：函数体里没有 runNode（一个生成都不代跑）");
      hasnt(body, "running", "也不置 running（预建的节点不显示成在跑）");
      hasnt(body, "shellGone", "不写墓碑（创建期没有 run，那套字段只属运行中的 run）");
    }
    eqNum(typeof LTSH.ensureForTask, "function", "window.LTSHELL.ensureForTask 在沙箱里可调用");
    eqNum(LTSH.graphPaths(AGENT_GRAPH("写分镜")).join(","), "start,a1,end", "同一份图路径清单给壳预建与交付预建共用（只列图定义路径）");
    const shells0 = S.wf.nodes.filter((n) => n.kind === "super");
    eqNum(shells0.length, 2, "创建那一刻父壳 + 环节子壳已经在画布上（不再等跑到那一环）");
    const root0 = shells0.find((n) => !String(n.ltShellPath || "").trim());
    const step0 = shells0.find((n) => String(n.ltShellPath || "") === "a1");
    ok(!!root0 && !!step0, "预建的父壳 / 环节子壳按 ltShellTask / ltShellPath 认得出身份");
    eqNum(String(root0.ltShellTask), TID, "父壳带任务身份（与运行时懒建同一套字段）");
    eqNum(String(step0.parentSuperId), String(root0.id), "环节子壳挂在预建的父壳里");
    const gens0 = S.wf.nodes.filter(
      (n) => String(n.parentSuperId || "") === String(step0.id) && n.ltGenType,
    );
    eqNum(gens0.length, 1, "按 cfg.genTypes 把生成节点一次摆好（缺省 = 图像一枚）");
    eqNum(String(gens0[0].kind), "proc_image", "类型 → kind 走壳模块同一份词汇表");
    const ctrl0 = S.wf.nodes.find(
      (n) => n.kind === "control" && String(n.parentSuperId || "") === String(step0.id),
    );
    ok(!!ctrl0 && String(ctrl0.ctrlRole) === "start", "控制 ▶ 一并建好（ctrlRole \"start\"）");
    ok(Number(ctrl0.y) < Number(gens0[0].y), "预建也守「控制靠上、生成靠下」的排版口径");
    ok(
      S.wf.wires.some((w) => w && w.from === ctrl0.id && w.to === gens0[0].id),
      "控制 ▶ 直连生成节点（控制流不走数据线，点下去才真的能触发）",
    );
    ok(!S.wf.nodes.some((n) => n.running || n.output), "预建一个都不跑：没有 running、也没有产出（不替用户烧额度）");
    ok(
      task.enabled === false && !String(task.activeRun || ""),
      "预建不改任务状态：enabled 仍 false、没有 run（开跑只由用户点「启用并绑定」）",
    );
    ok(!task.shellGone && !task.shellPaths, "创建期没有 run：不写墓碑、不碰 run.shell* 字段（那套字段只属运行中的 run）");
    /* 幂等：创建收尾与界面入口会重复叫它，第二次必须是空动作 */
    const before0 = S.wf.nodes.length;
    const again0 = LTSH.ensureForTask(S.wf, task);
    eqNum(S.wf.nodes.length, before0, "重复预建不重建（幂等：节点数逐字不变）");
    eqNum(again0.created, 0, "第二次 created = 0");
    eqNum(again0.skipped, true, "第二次 skipped = true（这一次什么都没建）");
    /* 启用后被「认领」而非重长：run 起来时 ltsEnsure 入口把画布上现存的壳登记进 run.shellPaths，
       于是「这一条路径建过没建过」有据可查，预建壳不会被误判成「用户删了壳」。 */
    const runClaim = sandbox.ltRunNew(task, "wf-shell", {});
    sandbox.ltInst(runClaim, "", runClaim.graph);
    const nBeforeClaim = S.wf.nodes.length;
    const claim = LTSH.ensure(runClaim, "a1");
    eqNum(claim.created, 0, "已预建的壳被认领：ensure 不新建任何壳（created = 0）");
    eqNum(S.wf.nodes.length, nBeforeClaim, "认领不动节点：不重长壳、也不重复摆生成工作流");
    ok(!!claim.root && !!claim.step, "认领返回的正是创建期预建的那两颗壳（按身份认人）");
    ok(
      !!runClaim.shellPaths && runClaim.shellPaths[""] === 1 && runClaim.shellPaths["a1"] === 1,
      "预建的壳按路径登记进 run.shellPaths（此后「删没删」按它判）",
    );
    /* 删了不偷偷重长（墓碑口径在预建壳上照旧）：认领之后用户把壳删掉 → 这一轮只提示不重建 */
    S.wf.nodes = S.wf.nodes.filter((n) => String(n.ltShellTask || "") !== TID);
    const goneClaim = LTSH.ensure(runClaim, "a1");
    eqNum(goneClaim.gone, true, "预建壳被用户删掉 → gone = true（绝不静默重长）");
    eqNum(S.wf.nodes.filter((n) => n.kind === "super").length, 0, "画布上没有被偷偷重建的壳");
    eqNum(runClaim.shellGone, true, "墓碑落在本 run 上（run.shellGone）");
    toasts.length = 0; /* 上面这条墓碑提示不算进 ⑤ 的「只提示一次」计数（那是另一个 run 的账） */
  }
  /* ── ⓪.5 本轮 bug：逐项（map）环节的实例路径不再一项一颗空壳 ──
     病根：跑到第 i 项时，这一项内部节点的路径带实例号（`shots@1/s_shot`，见 app-longtask.js
     的 ltPathKey / ltChildPrefix），而壳按 ltShellPath 一条路径一颗 —— 一份 12 项的清单就在
     画布上建出 12 颗彼此独立、且只有一颗有内容的空壳（清单 100 项 = 100 颗空壳）。
     口径：壳按**定义路径**认人（实例号 @i 一律脱掉），跑多少项都共用同一颗环节子壳。 */
  console.log("     · 逐项（map）实例：一份清单共用一颗环节子壳（不再一项一颗空壳）");
  {
    eqNum(LTSH.defPathOf("shots@1/s_shot"), "shots/s_shot", "壳定义路径口径：脱掉实例号（LTSHELL.defPathOf 已导出）");
    eqNum(LTSH.defPathOf("m@0/sub@3/step"), "m/sub/step", "嵌套实例也逐段脱（m@0/sub@3/step → m/sub/step）");
    eqNum(LTSH.defPathOf("plain/path"), "plain/path", "没带实例号的路径原样返回（幂等）");
    const MAPGRAPH = {
      nodes: [
        { id: "start", kind: "start", title: "起点", cfg: {} },
        { id: "a1", kind: "agent", title: "先写清单", cfg: { goal: "写出十二项清单" } },
        {
          id: "shots",
          kind: "map",
          title: "逐场备好生成工作流",
          cfg: {
            overKey: "shots_arr",
            itemKey: "item",
            outKeys: ["shot_file"],
            graph: {
              nodes: [
                { id: "s_start", kind: "start", title: "起点", cfg: {} },
                { id: "s_shot", kind: "agent", title: "备好这一场", cfg: { goal: "备好这一场的生成工作流" } },
                { id: "s_end", kind: "end_ok", title: "完成", cfg: {} },
              ],
              edges: [
                { id: "se1", from: "s_start", to: "s_shot" },
                { id: "se2", from: "s_shot", to: "s_end" },
              ],
            },
          },
        },
        { id: "end", kind: "end_ok", title: "完成", cfg: {} },
      ],
      edges: [
        { id: "e1", from: "start", to: "a1" },
        { id: "e2", from: "a1", to: "shots" },
        { id: "e3", from: "shots", to: "end" },
      ],
    };
    const madeMap = LT.createFromGraph("逐项演示", MAPGRAPH, S.wf);
    ok(madeMap && madeMap.ok, "落一张带逐项（map）环节的长任务图（12 项清单）");
    const taskMap = sandbox.ltTaskOf(S.wf, madeMap.uid);
    const TIDM = String(taskMap.uid);
    /* 创建期预建：定义路径只有一条通往映射内部的路径（shots/s_shot）—— 子壳一颗 */
    const mapStepShells0 = S.wf.nodes.filter(
      (n) => n.kind === "super" && String(n.ltShellPath || "") === "shots/s_shot",
    );
    eqNum(mapStepShells0.length, 1, "创建期预建：逐项内部那一颗环节子壳只有一颗（按定义路径）");
    const runMap = sandbox.ltRunNew(taskMap, "wf-shell", {});
    sandbox.ltInst(runMap, "", runMap.graph);
    /* 真跑：12 个实例各自把内部节点发布一次产出 —— 老口径会在这里建出 12 颗壳 */
    const nodesBeforeMap = S.wf.nodes.length;
    const Q = "C:\\ws\\out\\shot-01.png";
    for (let i = 0; i < 12; i++) {
      const ip = "shots@" + i;
      sandbox.ltInst(runMap, ip, runMap.graph.nodes.find((n) => n.id === "shots").cfg.graph);
      setFile(Q);
      sandbox.ltStatePut(runMap, ip + "/s_shot", "shot_file", Q);
      await sandbox.ltOutputPublish(runMap, ip + "/s_shot", { text: "第 " + (i + 1) + " 场的正文" });
    }
    const mapShells = S.wf.nodes.filter(
      (n) => n.kind === "super" && String(n.ltShellTask || "") === TIDM,
    );
    const mapStepShells = mapShells.filter((n) => String(n.ltShellPath || "").trim());
    /* 环节子壳 = 图里三个环节（a1 / shots 这个逐项环节本身 / 它内部的 s_shot），
       不是「12 项各一颗」；老口径在这里会得到 1 + 1 + 12 = 14 颗。 */
    eqNum(mapStepShells.length, 3, "12 项跑完只有三颗环节子壳（a1 + 逐项环节本身 + 它内部那一颗），不是 14 颗");
    ok(
      mapStepShells.some((n) => String(n.ltShellPath || "") === "shots"),
      "逐项环节本身有自己的子壳（生成工作流摆在这里，用户点 ▶ 的那一层）",
    );
    ok(
      mapStepShells.every((n) => String(n.ltShellPath || "").indexOf("@") < 0),
      "壳上记的路径一律是定义路径（不带实例号 @i）",
    );
    const shotsShell = mapStepShells.find((n) => String(n.ltShellPath || "") === "shots/s_shot");
    ok(!!shotsShell, "逐项内部那一颗子壳按定义路径 shots/s_shot 认得出身份");
    eqNum(
      S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(shotsShell.id) && n.kind === "ltout").length,
      12,
      "12 项的产出全部落进同一颗子壳（一项一颗产出节点，各自带实例路径认人）",
    );
    eqNum(mapShells.length, 4, "整张图一共四颗壳：父壳 + a1 + 逐项环节本身 + 它内部的 s_shot（老口径：15 颗）");
    ok(
      Object.keys(runMap.shellPaths).every((p) => p.indexOf("@") < 0),
      "run.shellPaths 也按定义路径记（墓碑账本与壳一一对应，不错位）",
    );
    ok(
      Object.keys(runMap.shellPaths).indexOf("shots/s_shot") >= 0,
      "逐项内部那条路径在账本里只有一条（shots/s_shot）",
    );
    const nAfterMap = S.wf.nodes.length;
    const againMap = LTSH.ensure(runMap, "shots@11/s_shot");
    eqNum(againMap.created, 0, "第 12 项再发布一次：认领同一颗子壳，一个新节点都不建（幂等）");
    eqNum(S.wf.nodes.length, nAfterMap, "节点数不再随实例数增长（12 项跑完就这么多，再跑第 N 项也不加）");
    ok(
      nAfterMap - nodesBeforeMap < 20,
      "整轮只多了十来个节点（老口径：12 项各建一颗空壳 + 各自的生成/控制）",
    );
    /* 老现场收口：手工摆一颗当年那种「实例路径壳」（有内容）→ 合并进定义路径壳，节点一个不删 */
    {
      const legacy = sandbox.makeNode("super", 24, 24);
      legacy.ltShellTask = TIDM;
      legacy.ltShellPath = "shots@0/s_shot";
      legacy.title = "逐场备好生成工作流";
      S.wf.nodes.push(legacy);
      const legacyOut = sandbox.makeNode("ltout", 48, 48);
      legacyOut.ltShellTask = TIDM;
      legacyOut.ltShellPath = "shots@0/s_shot";
      legacyOut.parentSuperId = legacy.id;
      S.wf.nodes.push(legacyOut);
      const nBeforeFix = S.wf.nodes.length;
      const fixed = LTSH.ensure(runMap, "shots@3/s_shot");
      ok(!!fixed.step, "收口之后照常拿得到本环节子壳");
      ok(!S.wf.nodes.some((n) => n && n.id === legacy.id), "老现场的实例路径壳被合并掉（不再永远空着占地方）");
      ok(S.wf.nodes.some((n) => n && n.id === legacyOut.id), "壳里的节点一个不删（只搬不删，用户的资产还在）");
      eqNum(String(legacyOut.parentSuperId), String(shotsShell.id), "壳里的节点改挂到定义路径那颗子壳上");
      eqNum(S.wf.nodes.length, nBeforeFix - 1, "只少了那一颗重复壳（节点数 -1）");
      const fixedAgain = LTSH.ensure(runMap, "shots@3/s_shot");
      eqNum(S.wf.nodes.length, nBeforeFix - 1, "再跑一次零动作（收口幂等）");
      ok(!!fixedAgain.step, "幂等那一轮照样有壳可用");
    }
    /* 清掉这张演示任务的所有壳，别影响下面「创建期还没有落点」的老口径段落 */
    S.wf.nodes = S.wf.nodes.filter((n) => String(n.ltShellTask || "") !== TIDM || n.kind !== "super");
    S.wf.nodes = S.wf.nodes.filter((n) => String(n.ltTaskUid || "") !== TIDM);
    S.wf.wires.length = 0;
  }
  /* 清空画布，回到「创建期还没有落点」的现场：下面几条老口径（懒建 / 墓碑 / 迁移）照旧真跑 */
  S.wf.nodes.length = 0;
  S.wf.wires.length = 0;
  const run = sandbox.ltRunNew(task, "wf-shell", {});
  sandbox.ltInst(run, "", run.graph);
  eqNum(S.wf.nodes.filter((n) => n.kind === "super").length, 0, "还没有产出时画布上一颗壳都没有（懒建口径照旧）");
  const P = "C:\\ws\\out\\shot-01.png";
  setFile(P);
  sandbox.ltStatePut(run, "a1", "shot_file", P);
  await sandbox.ltOutputPublish(run, "a1", { text: "本环节正文", files: await sandbox.ltOutputPathsOf(run, "a1") });

  const shells = S.wf.nodes.filter((n) => n.kind === "super");
  eqNum(shells.length, 2, "父壳 + 环节子壳一起建出来（一环节一颗）");
  const root = shells.find((n) => !String(n.ltShellPath || "").trim());
  const step = shells.find((n) => String(n.ltShellPath || "") === "a1");
  ok(!!root && !!step, "能按 ltShellTask / ltShellPath 认出父壳与环节子壳");
  eqNum(String(root.ltShellTask), TID, "父壳带任务身份（绑定 = 数据绑定，不新建状态节点）");
  eqNum(root.title, "长任务 · 演示任务", "父壳名 = 「长任务 · <任务名>」");
  eqNum(String(step.parentSuperId), String(root.id), "环节子壳挂在父壳里（parentSuperId）");
  eqNum(step.title, "写分镜", "子壳名 = 环节标题");
  ok(!String(root.parentSuperId || "").trim(), "父壳在主画布层（不嵌套在别的壳里）");

  /* ── ② 产出与产物都落进对应环节子壳 ── */
  const outNode = S.wf.nodes.find((n) => n.kind === "ltout");
  const artNode = S.wf.nodes.find((n) => n.kind === "ltart");
  ok(!!outNode && !!artNode, "产出节点与产物节点都建出来了");
  eqNum(String(outNode.parentSuperId), String(step.id), "产出节点落进本环节子壳");
  eqNum(String(artNode.parentSuperId), String(step.id), "产物节点落进本环节子壳");
  eqNum(String(artNode.ltShellPath), "a1", "产物节点带壳归属（ltShellTask / ltShellPath）");
  ok(
    !S.wf.nodes.some((n) => (n.kind === "ltout" || n.kind === "ltart") && !String(n.parentSuperId || "")),
    "产出 / 产物都不再平铺在主画布层",
  );

  /* ─ ③ 生成工作流预置：按类型平行建、控制靠上、生成靠下、一律不运行 ── */
  const gens = () => S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(step.id) && n.ltGenType);
  eqNum(gens().length, 1, "默认只预置图像生成（genTypes 缺省 = [\"image\"]）");
  eqNum(String(gens()[0].kind), "proc_image", "图像类型建的是 proc_image（类型 → kind 唯一词汇表在壳模块）");
  const ctrl = S.wf.nodes.find((n) => n.kind === "control" && String(n.parentSuperId || "") === String(step.id));
  ok(!!ctrl, "子壳里有一枚控制节点（用户点 ▶ 的入口）");
  eqNum(String(ctrl.ctrlRole), "start", "控制节点是起点角色（不是 endSuccess / endFail）");
  eqNum(String(ctrl.ctrlAction), "run", "控制动作只认 run（不建 clear）");
  ok(Number(ctrl.y) < Number(gens()[0].y), "控制靠上、生成靠下（与画布既有排版口径一致）");
  ok(!gens()[0].running && !gens()[0].output, "预置的生成节点没有跑过（不替用户花钱）");
  ok(String(gens()[0].prompt || "").indexOf("写分镜") >= 0, "生成节点的提示词来自环节标题");
  ok(String(gens()[0].prompt || "").indexOf("写出这一环节的产物") >= 0, "生成节点的提示词带上环节 goal");
  ok(String(gens()[0].prompt || "").indexOf("费用") >= 0, "提示词里写明生成会产生费用（用户知情）");
  {
    const before = gens().length;
    const again = LTSH.presetGen(run, "a1");
    eqNum(gens().length, before, "再预置一次不重建（幂等：同类型已有就跳过）");
    eqNum(again.created, 0, "第二次 created = 0");
  }

  /* ── ④ 按 cfg.genTypes 预置多种类型（平行摆，各自带自己的参数）── */
  {
    run.graph.nodes.find((n) => n.id === "a1").cfg.genTypes = ["image", "video", "tts", "music"];
    LTSH.presetGen(run, "a1");
    const kinds = gens().map((n) => n.kind).sort().join(",");
    eqNum(kinds, "music_gen,proc_image,tts_gen,video_gen", "四种类型各建一个节点（平行，不串成一条链）");
    ok(
      gens().every((n) => String(n.parentSuperId) === String(step.id)),
      "四种生成节点都摆在同一颗环节子壳里",
    );
    const seen = new Set();
    ok(
      gens().every((n) => {
        const k = String(n.x) + "|" + String(n.y);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
      "平行摆的生成节点各自占一格（不叠在一起）",
    );
    /* 壳里所有节点两两不重叠：控制（上）· 生成（左两列）· 产出（第三列）· 产物（更右一列起）。
       网格间距必须大于节点自身尺寸，否则 video_gen（高 340）/ proc_image（宽 400）会两两相压。 */
    const inner = () =>
      S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(step.id));
    const overlaps = (a, b) =>
      Number(a.x) < Number(b.x) + Number(b.w) &&
      Number(b.x) < Number(a.x) + Number(a.w) &&
      Number(a.y) < Number(b.y) + Number(b.h) &&
      Number(b.y) < Number(a.y) + Number(a.h);
    const bad = [];
    const all = inner();
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        if (overlaps(all[i], all[j]))
          bad.push(
            all[i].kind + "(" + all[i].x + "," + all[i].y + ") × " + all[j].kind + "(" + all[j].x + "," + all[j].y + ")",
          );
    eqNum(bad.join(" / "), "", "壳内" + all.length + "颗节点两两不重叠（控制 / 生成 / 产出 / 产物各占自己的格子）");
    run.graph.nodes.find((n) => n.id === "a1").cfg.genTypes = ["image"];
  }

  /* ─ ⑤ 墓碑：壳被用户删了 → 不偷偷重长，只提示一次 ── */
  {
    S.wf.nodes = S.wf.nodes.filter((n) => String(n.ltShellTask || "") !== TID);
    const before = S.wf.nodes.length;
    await sandbox.ltOutputPublish(run, "a1", { text: "第二版正文", files: [] });
    eqNum(S.wf.nodes.filter((n) => n.kind === "super").length, 0, "壳被删后不再自动重建（不静默重长）");
    ok(run.shellGone === true, "在本 run 上记了墓碑（判据：建过壳 shellMade，此刻却找不到）");
    const out2 = S.wf.nodes.find((n) => n.kind === "ltout");
    ok(!!out2 && !String(out2.parentSuperId || ""), "这一轮的产出回落主画布层（有地方看结果，不断链）");
    const warns = toasts.filter((t) => String(t[0]).indexOf("超级节点壳已被删除") >= 0).length;
    eqNum(warns, 1, "只提示一次（不每轮刷屏）");
    eqNum(S.wf.nodes.length >= before, true, "回落路径照旧建节点");
  }
  /* 用户点「重建」才恢复 */
  {
    const rebuilt = LTSH.rebuild(run);
    ok(rebuilt === true, "用户点「重建壳」后恢复（不是静默重长，是用户点的）");
    ok(run.shellGone !== true, "墓碑清掉");
    ok(run.shellWarned !== true, "「已提示」标记一并清掉（重建后还能再提示一次）");
    eqNum(S.wf.nodes.filter((n) => n.kind === "super" && !String(n.ltShellPath || "")).length, 1, "父壳重新建出来");
    await sandbox.ltOutputPublish(run, "a1", { text: "第三版正文", files: [] });
    const step2 = LTSH.stepShellOf(TID, "a1");
    ok(!!step2, "下一次产出时子壳按原身份补回来（同一环节不堆第二颗）");
    eqNum(S.wf.nodes.filter((n) => n.kind === "super" && String(n.ltShellPath || "") === "a1").length, 1, "子壳只有一颗（幂等）");
    const out3 = S.wf.nodes.find((n) => n.kind === "ltout" && String(n.ltPath || "") === "a1");
    eqNum(String(out3.parentSuperId), String(step2.id), "产出又落回子壳");
  }

  /* ── ⑥ 存量迁移：主画布层上的产出节点搬进它该在的环节子壳（幂等） ── */
  {
    const legacy = { id: "legacyOut", kind: "ltout", x: 900, y: 40, w: 360, h: 260, title: "产出 · 旧档", text: "", ltTaskUid: TID, ltRunId: run.runId, ltPath: "a1", parentSuperId: "", parentTaskId: "" };
    S.wf.nodes.push(legacy);
    const r1 = await sandbox.ltShellMigrateOutputs(S.wf);
    eqNum(r1.moved, 1, "旧档的产出节点搬了一次");
    const step3 = LTSH.stepShellOf(TID, "a1");
    eqNum(String(legacy.parentSuperId), String(step3.id), "搬到本环节子壳里");
    ok(legacy.y >= 40 && legacy.x >= 40, "搬完给的是子壳内坐标系（不是原来的世界坐标）");
    const r2 = await sandbox.ltShellMigrateOutputs(S.wf);
    eqNum(r2.moved, 0, "已经在对的子壳里就不再搬（幂等）");
  }

  /* ── ⑦ 关掉「需要生成内容」就不预置（用户可改）── */
  {
    const g2 = LT.norm(AGENT_GRAPH("配音", { needsGen: false, genTypes: ["tts"] }));
    const runB = sandbox.ltRunNew({ uid: "taskShellB", name: "关掉的演示", graph: g2 }, "wf-shell", {});
    sandbox.ltInst(runB, "", runB.graph);
    setFile("C:\\ws\\out\\voice.wav");
    sandbox.ltStatePut(runB, "a1", "voice_file", "C:\\ws\\out\\voice.wav");
    await sandbox.ltOutputPublish(runB, "a1", { text: "配音稿", files: await sandbox.ltOutputPathsOf(runB, "a1") });
    const stepB = LTSH.stepShellOf("taskShellB", "a1");
    ok(!!stepB, "关掉生成的环节照旧建子壳（产出仍然有归属）");
    eqNum(S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(stepB.id) && n.ltGenType).length, 0, "关掉「需要生成内容」就不预置生成节点");
    eqNum(S.wf.nodes.filter((n) => n.kind === "control" && String(n.parentSuperId || "") === String(stepB.id)).length, 0, "也不摆控制节点（没有生成可触发）");
  }

  /* ──  环节改名：子壳标题跟上 ── */
  {
    const cur = LTSH.stepShellOf(TID, "a1");
    run.graph.nodes.find((n) => n.id === "a1").title = "写分镜（改过名）";
    const n = LTSH.syncStepTitles(run);
    ok(n >= 1 && String(cur.title) === "写分镜（改过名）", "环节改名后子壳标题跟到现名（重名交给 uniqueNodeTitle）");
  }

  /* ═══════════════ [3] 归属与清理 ═══════════════ */
  console.log("\n[3] 归属与清理：生成类型词汇表 / 缺省口径 / 删任务留壳");
  eqNum(LTSH.genTypesOf({}).join(","), "image", "genTypes 缺省 = [\"image\"]（默认只勾图像）");
  eqNum(LTSH.genTypesOf({ genTypes: [] }).join(","), "image", "空数组也回落默认");
  eqNum(LTSH.genTypesOf({ genTypes: ["video", "bogus", "video"] }).join(","), "video", "非法值丢掉、去重");
  eqNum(LTSH.needsGen({}), true, "needsGen 缺省 = 勾上（未设过即 true）");
  eqNum(LTSH.needsGen({ needsGen: false }), false, "显式 false 才是关");
  ok(LTSH.GEN_KINDS.image === "proc_image" && LTSH.GEN_KINDS.video === "video_gen" && LTSH.GEN_KINDS.music === "music_gen" && LTSH.GEN_KINDS.tts === "tts_gen", "四种生成类型的 kind 映射齐备");
  {
    /* 删任务：壳与壳内内容保留，只清掉绑定字段 */
    const before = S.wf.nodes.length;
    const r = await LT.deleteTask(S.wf, TID);
    ok(r && r.ok, "删任务成功");
    eqNum(S.wf.nodes.length, before, "壳与壳内节点一个都没被删（用户的资产与产出保留）");
    const left = S.wf.nodes.filter((n) => n.kind === "super" && String(n.ltShellPath || "") === "a1");
    ok(left.length >= 1, "带环节归属的子壳仍在画布上");
    eqNum(
      S.wf.nodes.filter((n) => String(n.ltShellTask || "") === TID).length,
      0,
      "壳上的任务绑定字段已清（此后这条任务的产出不再进壳）",
    );
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke-longtask-shell crashed:", (e && e.stack) || e);
  process.exit(1);
});


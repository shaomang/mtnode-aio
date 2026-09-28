"use strict";
/**
 * test/smoke-longtask-map.js —— 长周期任务「逐项(map)环节取不到展开数组时转人工」的界面回归
 *
 * 这一条改动的本体：`ltExecMap` 取不到展开数组时**不再判 failed**，改判 `waiting_human`
 * （带 mapWait 标记）+ 压一条 kind="mapfix" 的等待项，转人工处理；条带右栏据此弹
 * `ltMapCard`（改展开键 / 按候选一键换 / 粘贴 JSON / 重新查找并继续）。
 *
 * 断言分七段，能真跑的一律真跑（vm 里把 renderer/app-longtask.js 与 app-longtask-ui.js
 * 整份装进同一个沙箱，不启动 Electron）：
 *   [1] 取不到数组不判失败（mapSource / mapItems / ltExecMap 真跑）
 *   [2] 自动接管只在「唯一确定」时发生（一份数组；或只有一份像成批的）
 *   [3] 键名对不上：唯一确定的一份数组 → 自动改认；候选里有多份「像成批的」→ 转人工（绝不替用户瞎选）
 *   [4] 归一 ltArrCoerce / getArray / mapPutArray（含「绝不允许按逗号切」）
 *   [5] 就诊说明 ltMapWaitPlan：缺哪个键 / 候选键名 / 不再判失败三层信息
 *   [6] 补救口 ltMapRepairWait：真跑（仍不可用 → 保持等人 + ok:false；补上数组 → 离开等人并真展开）
 *   [7] 界面接线：ltHumanCard(mapfix) → ltMapCard，卡片调 window.LT.mapWaitInfo / mapRepairWait，
 *       ltMapKeyVal 两种形态（handle / input）都取得到值
 * 另有 [8] 源码级补充断言（has / hasnt，明确标注是源码口径，不是真跑）。
 *
 * 只读断言：不改任何文件、不起 Electron、不碰 DOM（只给脚本一层最小假体）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

let fails = 0;
let checks = 0;
const notes = [];
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const j = (v) => {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
};
const eq = (got, want, msg) => ok(got === want, msg + "（得到 " + j(got) + "，期望 " + j(want) + "）");
const eqNum = eq;
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + j(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + j(needle) + "）"));
};
/* 只记录、不判失败：实测到与「界面/引擎该有的接法」不一致、但不在本测试授权范围内修的事 */
const note = (msg) => {
  notes.push(msg);
  console.log("  note  " + msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 等一个条件成真（异步续跑用；超时不算失败，由调用处断言最终状态） */
const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  for (;;) {
    try {
      if (fn()) return true;
    } catch (_) {}
    if (Date.now() - t0 > ms) return false;
    await sleep(15);
  }
};

const LTV = read("renderer/app-longtask.js");
const LTU = read("renderer/app-longtask-ui.js");

/* ══════════════ 沙箱：最小假 DOM（不启动 Electron） ═══════════════ */
/* 两个脚本顶层都不建 DOM；只有卡片渲染才走 document.createElement。
   这里给一层够 ltEl / ltBtn / ltInput / ltField / textarea 用的假体，
   元素上能读回 className / textContent / value，按钮能取到 onclick 并真的点下去。 */
function mkEl(tag) {
  return {
    tagName: tag,
    children: [],
    className: "",
    textContent: "",
    value: "",
    placeholder: "",
    rows: 0,
    type: "",
    title: "",
    id: "",
    hidden: false,
    innerHTML: "",
    style: {},
    dataset: {},
    attrs: {},
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      return c;
    },
    insertBefore(c) {
      this.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    focus() {},
    blur() {},
    remove() {},
    contains() {
      return false;
    },
    cloneNode() {
      return mkEl(tag);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 20 };
    },
    get firstChild() {
      return this.children[0] || null;
    },
    get parentNode() {
      return null;
    },
  };
}
function findAll(root, out) {
  out = out || [];
  if (!root) return out;
  out.push(root);
  for (const c of root.children || []) findAll(c, out);
  return out;
}
function elText(e) {
  let s = String((e && e.textContent) || "");
  for (const c of (e && e.children) || []) s += "\n" + elText(c);
  return s;
}
const btnByText = (card, label) => findAll(card).find((e) => e.tagName === "button" && String(e.textContent) === label) || null;
const elByTag = (card, tag) => findAll(card).find((e) => e.tagName === tag) || null;

const toasts = [];
const sandbox = {
  window: { api: { ltRunSave: () => Promise.resolve({ ok: true }), ltRunGet: () => Promise.resolve(null) } },
  S: { wf: null, config: {} },
  I18n: { t: (s) => s },
  document: {
    readyState: "loading",
    addEventListener() {},
    removeEventListener() {},
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    createElement: mkEl,
    createElementNS: (ns, tag) => mkEl(tag),
    body: mkEl("body"),
  },
  toast: (msg, level) => toasts.push([String(msg), String(level || "")]),
  scheduleSave() {},
  renderCanvas() {},
  focusNode() {},
  addNode() {
    return null;
  },
  closeOverlay() {},
  closeAllNodePops() {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Map,
  Set,
  Promise,
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  RegExp,
  Error,
};
vm.createContext(sandbox);
vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
vm.runInContext(LTU, sandbox, { filename: "renderer/app-longtask-ui.js" });
const LT = sandbox.window.LT;

/* ── 夹具 ─────────────────────────────────────────────────────────── */
/* 逐项节点：与需求给的那份同形（id m / kind map / cfg.overKey shot_list） */
const mapNode = (over) =>
  Object.assign(
    { id: "m", kind: "map", title: "逐项", cfg: { overKey: "shot_list", itemKey: "item", maxItems: 16, outKeys: [], graph: { nodes: [], edges: [] } } },
    over || {},
  );
/* [1] 用的最小 run：与需求同形（状态里空空如也） */
const bareRun = () => ({ runId: "r", ns: {}, graph: { nodes: [], edges: [] }, nodes: {} });
/* 一张真图：起点 → Agent(声明输出 shot_list) → 逐项 → 成功终点 */
const GRAPH = LT.norm({
  nodes: [
    { id: "s", kind: "start", title: "起点" },
    { id: "u", kind: "agent", title: "写分镜", cfg: { goal: "写一版分镜表", outKeys: ["shot_list"] } },
    { id: "m", kind: "map", title: "逐项", cfg: { overKey: "shot_list", itemKey: "item", maxItems: 16, outKeys: [], graph: { nodes: [], edges: [] } } },
    { id: "e", kind: "end_ok", title: "收工" },
  ],
  edges: [
    { from: "s", to: "u" },
    { from: "u", to: "m" },
    { from: "m", to: "e" },
  ],
});
const MAP_NODE = GRAPH.nodes.find((n) => n.id === "m");
/* 一份「跑着」的 run：起点与写分镜已 done 且两条边已点火 → 逐项这一环随时 ready。
   这样后面点「重新查找并继续」时主循环真的会把这一环跑起来（不是空等）。 */
const mkRun = (runId) => ({
  runId,
  wfId: "wf-map",
  taskId: "t1",
  status: "running",
  graph: GRAPH,
  inst: { "": GRAPH },
  ns: { "": {} },
  nodes: {},
  outputs: {},
  arts: {},
  sessions: {},
  memPending: [],
  act: {},
  waits: [],
  steps: 0,
  log: [],
  fired: {},
  aborted: false,
  booted: true,
  opts: {},
});
/* 把 run 塞进引擎的 runs 表（LT_RUNS 是引擎内部词法常量，只能借 ltSave 这一条口进） */
const registerRun = (run) => {
  sandbox.__run = run;
  vm.runInContext("ltSave(__run, true)", sandbox);
};
const mkWf = (runId) => ({ id: "wf-map", longtask: { tasks: [{ uid: "t1", enabled: true, activeRun: runId }], active: "t1" } });
/* 造一个「逐项环节正在等人」的真现场：s/u 已 done + 两条边已点火 + 真跑一遍 ltExecMap */
async function mkWaitingRun(runId) {
  const run = mkRun(runId);
  registerRun(run);
  sandbox.ltSetStat(run, "s", "done");
  sandbox.ltSetStat(run, "u", "done");
  run.fired[GRAPH.edges[0].id] = 1;
  run.fired[GRAPH.edges[1].id] = 1;
  await sandbox.ltExecMap(run, "m", MAP_NODE, "");
  return { run, wf: mkWf(runId) };
}

async function main() {
  ok(!!LT, "引擎脚本在沙箱里整份执行并导出 window.LT");
  ok(typeof sandbox.ltHumanCard === "function" && typeof sandbox.ltMapCard === "function", "条带界面脚本（app-longtask-ui.js）在同一个沙箱里装好，卡片函数在全局可调");

  /* ══════════════ [1] 取不到数组不判失败 ═══════════════ */
  console.log("\n[1] 取不到展开数组：不判失败，转「等人」（真跑 mapSource / mapItems / ltExecMap）");
  {
    const run = bareRun();
    const src = LT.mapSource(run, "", mapNode());
    eq(src.how, "none", "状态里完全没有这个键 → how 是 none（不是 failed，也不是瞎猜一个）");
    ok(Array.isArray(src.cands), "取不到时带回候选表，且候选表是数组（得到 " + j(src.cands) + "）");
    eqNum(src.cands.length, 0, "空空的状态里一个候选也没有");
    eq(src.want, "shot_list", "诊断里带上是哪个键没着落");
    let threw = null;
    let items = null;
    try {
      items = LT.mapItems(run, "", mapNode());
    } catch (e) {
      threw = e;
    }
    ok(!threw, "mapItems 取不到数组不抛错" + (threw ? "（抛了：" + (threw && threw.message) + "）" : ""));
    ok(Array.isArray(items) && items.length === 0, "mapItems 取不到时返回空数组（得到 " + j(items) + "）");

    const ask = LT.mapSource(run, "", mapNode({ cfg: { overKey: "", itemKey: "item", maxItems: 16, outKeys: [], graph: { nodes: [], edges: [] } } }));
    eq(ask.how, "ask", "overKey 是空串 → how 是 ask（先问用户要展开哪个键）");
    eq(LT.mapItems(run, "", mapNode({ cfg: { overKey: "" } })).length, 0, "没指定展开键时也是空数组，不抛错");
  }
  {
    /* 引擎口径真跑：ltExecMap 拿到空数组 → waiting_human + mapfix 等待项（旧版这里判 failed） */
    const { run } = await mkWaitingRun("r-nofail");
    const st = run.nodes["m"];
    eq(st.status, "waiting_human", "真跑 ltExecMap：取不到数组判 waiting_human，不是 failed");
    eq(st.mapWait, true, "这一环带上 mapWait 标记（条带据此知道这是「展开源没着落」的等人）");
    has(String(st.err), "shot_list", "环节的 err 就是就诊说明（说清缺哪个键" + "）");
    has(String(st.err), "不再判失败", "就诊说明里写明「不再判失败」（用户看得见这一环没断）");
    const w = (run.waits || []).find((x) => x.path === "m");
    ok(!!w, "压了一条等待项，path 指向这一环（waits=" + j((run.waits || []).map((x) => x.kind + ":" + x.path)) + "）");
    eq(w && w.kind, "mapfix", "等待项的 kind 是 mapfix（人工卡走逐项展开源那张卡）");
    eq(w && w.title, "逐项", "等待项带上节点标题");
    ok(
      (run.log || []).some((l) => l.level === "warn" && /不判失败/.test(String(l.text))),
      "运行档案里留一条 warn：现在停在这里等你指定（不是失败）",
    );
    /* 校验口径：指定了 overKey 的逐项环节不再被拦（子图必须有内部节点，这里给一张完整的） */
    const VALIDMAP = {
      nodes: [
        { id: "s", kind: "start", title: "起点" },
        {
          id: "m",
          kind: "map",
          title: "逐项",
          cfg: {
            overKey: "shot_list",
            itemKey: "item",
            outKeys: [],
            graph: {
              nodes: [
                { id: "i", kind: "start", title: "逐条开始" },
                { id: "a", kind: "agent", title: "处理单条", cfg: { goal: "处理这一条" } },
                { id: "e2", kind: "end_ok", title: "单条收工" },
              ],
              edges: [
                { from: "i", to: "a" },
                { from: "a", to: "e2" },
              ],
            },
          },
        },
        { id: "e", kind: "end_ok", title: "收工" },
      ],
      edges: [
        { from: "s", to: "m" },
        { from: "m", to: "e" },
      ],
    };
    const errs = LT.validate(VALIDMAP).filter((x) => x.level === "err");
    eqNum(errs.length, 0, "指定了 overKey 的逐项环节不再被校验拦下（" + j(errs.map((x) => x.msg)) + "）");
  }

  /* ══════════════ [2] 自动接管只在唯一确定时发生 ═══════════════ */
  console.log("\n[2] 自动接管：声明的键没有、而状态里唯一确定有一份数组");
  {
    const run = bareRun();
    run.ns = { a: { shot_list: [{ n: 1 }, { n: 2 }, { n: 3 }] } };
    const src = LT.mapSource(run, "", mapNode());
    eq(src.how, "key", "上游 Agent 把 shot_list 写回状态 → how 是 key（按声明的键直接拿到）");
    eq(src.usedKey, "shot_list", "用的就是声明的那个键");
    eq(src.arr.length, 3, "数组条目数取自状态里的那份");
    eqNum(src.path, "a", "并记下是从哪个命名空间拿的（这里是上游 Agent 的 a）");
    eqNum(LT.mapItems(run, "", mapNode()).length, 3, "mapItems 按这份数组给出 3 个条目");
    eqNum(LT.mapItems(run, "", mapNode({ cfg: { overKey: "shot_list", itemKey: "item", maxItems: 2, outKeys: [], graph: { nodes: [], edges: [] } } })).length, 2, "maxItems=2 时裁到 2 条（抽卡上限真的生效）");
    eqNum(LT.mapItems(run, "", mapNode({ cfg: { overKey: "shot_list", itemKey: "item", maxItems: 0, outKeys: [], graph: { nodes: [], edges: [] } } })).length, 3, "maxItems 非法（0）时回落到默认 16，不裁成空");
    const got = LT.getArray(run, "", "shot_list");
    eq(got && got.arr.length, 3, "getArray 独立可用：按键取到 3 条");
  }

  /* ═══════════════ [3] 键名对不上：补救与「不许瞎选」 ═══════════════ */
  console.log("\n[3] 键名对不上：唯一一份数组 → 自动改认；两份以上 → 转人工");
  {
    const run = bareRun();
    run.ns = { a: { shots: [1, 2, 3] } };
    const s1 = LT.mapSource(run, "", mapNode());
    eq(s1.how, "auto", "声明 shot_list、状态里只有 shots → 自动改认（how 是 auto）");
    eq(s1.usedKey, "shots", "改认的是状态里那份唯一数组的键名");
    eq(s1.want, "shot_list", "诊断里保留用户声明的键（用户看得见换成谁了）");
    eqNum(s1.arr.length, 3, "自动改认后条目数正确");

    /* 再塞第二个数组键：两份候选 → 不替用户选，转人工 */
    run.ns.a.other_list = [1, 2];
    const s2 = LT.mapSource(run, "", mapNode());
    ok(s2.how !== "auto", "两份数组（shots + other_list）→ 不再自动接管（得到 how=" + j(s2.how) + "）");
    eq(s2.how, "none", "两份以上时不猜：how 落到 none，由界面转人工");
    ok(
      s2.cands && s2.cands.map((c) => c.key).join(",") === "shots,other_list",
      "候选表里两份都列出来交给用户挑（得到 " + j(s2.cands && s2.cands.map((c) => c.key)) + "）",
    );
    eqNum(LT.mapItems(run, "", mapNode()).length, 0, "不替用户选 = 这一环不展开（真跑就是 0 条）");

    /* 边界：两份数组里只有一份像「成批的东西」→ 唯一确定，才认它 */
    const run2 = bareRun();
    run2.ns = { a: { shots: [1, 2, 3], draft: "一句话" } };
    const s3 = LT.mapSource(run2, "", mapNode());
    eq(s3.how, "auto", "另一份不是数组（标量 draft）→ 仍只有一份候选数组，自动改认");
    eq(s3.usedKey, "shots", "认的还是那份数组");

    /* 两份都不是「像成批」的名字 → 也不猜 */
    const run3 = bareRun();
    run3.ns = { a: { alpha: [1], beta: [2] } };
    eq(LT.mapSource(run3, "", mapNode()).how, "none", "两份都不像成批键名 → 同样转人工（不瞎猜）");
  }

  /* ═══════════════ [4] 归一：任何值 → 数组 ══════════════ */
  console.log("\n[4] 归一 ltArrCoerce / getArray / mapPutArray（含「绝不按逗号切」）");
  {
    const a1 = LT.arrCoerce([1, 2]);
    ok(Array.isArray(a1.arr) && a1.arr.length === 2 && a1.form === "array", "真数组直接用（得到 " + j(a1) + "）");
    const a2 = LT.arrCoerce('[{"a":1}]');
    eq(a2.form, "json", "JSON 数组字符串解析一次");
    eq(a2.arr[0] && a2.arr[0].a, 1, "解析出来的就是那份数组");
    const a3 = LT.arrCoerce({ items: [1, 2] });
    eq(a3.form, "wrap:items", "对象包法 {items:[…]} 按已知字段取出");
    eqNum(a3.arr.length, 2, "取出的条目数正确");
    const a4 = LT.arrCoerce({ list: [1, 2] });
    eq(a4.form, "wrap:list", "对象包法 {list:[…]} 同样取出");
    const a5 = LT.arrCoerce("x");
    eq(a5.form, "scalar", "标量字符串包成单元素数组");
    eqNum(a5.arr.length, 1, "标量 → 1 条");
    eq(a5.arr[0], "x", "值原样保留");
    const a6 = LT.arrCoerce("a,b");
    eqNum(a6.arr.length, 1, "「a,b」是**一个**条目（绝不允许按逗号切）");
    eq(a6.arr[0], "a,b", "整串原样保留下来（切了就不是一个条目了）");
    eqNum(LT.arrCoerce("").arr.length, 0, "空串 → 取不到（0 条）");
    eq(LT.arrCoerce("").form, "none", "空串归一成 none（不是 1 条空字符串）");
    eqNum(LT.arrCoerce(null).arr.length, 0, "null → 取不到（0 条）");
    const a7 = LT.arrCoerce({ zz: [1, 2] });
    eq(a7.form, "wrap:zz", "没有已知字段时按第一个数组字段取");

    /* getArray：链上 / 全 run 找一遍，找不到就是 null */
    const run = bareRun();
    run.ns = { a: { shot_list: [1, 2], blob: '["p","q"]', text: "a,b" } };
    eqNum((LT.getArray(run, "", "shot_list") || {}).arr.length, 2, "getArray 按键取到数组");
    eqNum((LT.getArray(run, "", "blob") || {}).arr.length, 2, "getArray 顺带把 JSON 字符串归一成数组");
    eqNum((LT.getArray(run, "", "text") || {}).arr.length, 1, "getArray 对标量不切逗号（1 条）");
    eq(LT.getArray(run, "", "nope"), null, "找不到的键明确返回 null（不是空数组冒充）");
    eq(LT.getArray(run, "", ""), null, "空键返回 null");

    /* mapPutArray：用户粘贴的那份落地（深拷贝，别把外部数组对象挂进状态） */
    const src2 = [1, 2, 3];
    eq(LT.mapPutArray(run, "", "pasted_keys", src2), true, "mapPutArray 写入返回 true");
    eqNum((run.ns[""].pasted_keys || []).length, 3, "写进了对应命名空间");
    src2.push(4);
    eqNum((run.ns[""].pasted_keys || []).length, 3, "写进去的是副本：外部数组再改也不动状态（深拷贝）");
    eq(LT.mapPutArray(run, "", "", [1]), false, "空键名拒绝写入（返回 false）");
  }

  /* ═══════════════ [5] 就诊说明 ═══════════════ */
  console.log("\n[5] 就诊说明 ltMapWaitPlan：缺哪个键 / 候选键名 / 不再判失败（三层都要有）");
  {
    const run = mkRun("r-plan");
    run.ns = { "": {}, a: { shots: [{ n: 1 }, { n: 2 }, { n: 3 }], other_list: ["x", "y"] } };
    const plan = LT.mapWaitPlan(run, "", mapNode());
    eq(plan.want, "shot_list", "说明里带上是哪个键没着落");
    eq(plan.how, "none", "两份候选数组 → 说明自己也是 none 口径（与判据同源）");
    has(plan.text, "要展开的数组键「shot_list」", "第一层：说清缺哪个键（得到 want=" + j(plan.want) + "）");
    has(plan.text, "还没有可用的数组", "第一层：说清这个键现在没有可用的数组");
    has(plan.text, "现在这些键可以当展开源", "第二层：列出能用的候选键");
    has(plan.text, "shots", "第二层：候选表里有 shots");
    has(plan.text, "3 项", "第二层：候选带上条目数（用户知道换了会展开几条）");
    has(plan.text, "other_list", "第二层：第二份候选取也列出来");
    has(plan.text, "上游声明过但还没写回状态的键", "第三层：指出上游该写回什么");
    has(plan.text, "不再判失败", "第三层：写明这一环不再判失败");
    has(plan.text, "接着往下跑", "第三层：写明处理完就接着往下跑");
    ok(Array.isArray(plan.usable), "返回对象带 usable（得到 " + j(plan.usable) + "）");
    ok(
      plan.usable.some((u) => u.key === "shots" && u.count === 3),
      "usable 里 shots 的条目数是 3（得到 " + j(plan.usable) + "）",
    );
    ok(Array.isArray(plan.keys) && plan.keys.indexOf("shot_list") >= 0 && plan.keys.indexOf("shots") >= 0, "返回对象带 keys（候选键名清单，得到 " + j(plan.keys) + "）");

    /* 改键名下拉的候选一览（界面上的「点一下就用它」） */
    const labels = LT.mapKeyLabels(run, "", mapNode());
    ok(
      labels.some((x) => x.key === "shots" && x.has === true && x.count === 3),
      "mapKeyLabels：shots 有值、3 条（得到 " + j(labels) + "）",
    );
    ok(
      labels.some((x) => x.key === "shot_list" && x.has === false),
      "mapKeyLabels：声明的 shot_list 标成「没值」（界面据此提示上游补写）",
    );

    /* 没指定展开键时的说法：先问用户 */
    const askPlan = LT.mapWaitPlan(run, "", mapNode({ cfg: { overKey: "" } }));
    has(askPlan.text, "还没指定要展开哪个数组键", "overKey 空串时说明改成「还没指定」的说法（转人工问一句）");
    eq(askPlan.how, "ask", "空串时 how 是 ask");
  }

  /* ═══════════════ [6] 补救口 ltMapRepairWait（真跑） ═══════════════ */
  console.log("\n[6] 补救口 ltMapRepairWait：真跑（补不上就保持等人并 ok:false，补得上就离开等人并真展开）");
  {
    const { run, wf } = await mkWaitingRun("r-repair");
    ok(LT.runOf("wf-map", "r-repair") === run, "run 已进引擎的 runs 表（ltCurrentRun 那条路才拿得到）；现场 status=" + j(run.nodes["m"].status));

    /* ── A：还是算不出数组 → 保持 waiting_human，返回 ok:false（不判失败、不空跑） ── */
    const rA = LT.mapRepairWait(wf, "m", { overKey: "shot_list" });
    eq(rA.ok, false, "补不上数组 → 返回 ok:false");
    eq(typeof rA.error, "string", "并给出人读的错误说明（得到 " + j(rA.error) + "）");
    eq(run.nodes["m"].status, "waiting_human", "这一环**保持** waiting_human（不判 failed，也不偷偷放行）");
    eq(run.nodes["m"].mapWait, true, "mapWait 标记原样保留（卡片继续是那张整改卡）");
    eqNum((run.waits || []).filter((w) => w.path === "m").length, 1, "等待项还在（人工卡不消失）");
    ok(!!rA.plan && /不再判失败/.test(String(rA.plan.text)), "ok:false 时把就诊说明一起回给界面（得到 " + j(rA.plan && rA.plan.how) + "）");

    /* ── B：用户粘贴一份 JSON 数组 → 离开等人，并且主循环真的把这一环跑完 ── */
    const rB = LT.mapRepairWait(wf, "m", { overKey: "shot_list", pasted: '[{"no":1},{"no":2}]' });
    eq(rB.ok, true, "补上数组 → 返回 ok:true");
    eq(rB.key, "shot_list", "回报用的是哪个键当展开源");
    eq(rB.count, 2, "回报条目数 2");
    ok(run.nodes["m"].status !== "waiting_human", "这一环**离开** waiting_human（得到 " + j(run.nodes["m"].status) + "）");
    eqNum((run.waits || []).filter((w) => w.path === "m").length, 0, "等待项撤掉（人工卡跟着收）");
    eqNum((run.ns[""].shot_list || []).length, 2, "粘贴的那份写进了展开键所在的命名空间");
    ok(await waitFor(() => run.nodes["m"].status === "done", 3000), "续跑真的把逐项这一环跑完（m 变 done，得到 " + j(run.nodes["m"].status) + "）");
    eqNum(run.nodes["m"].mapTotal, 2, "展开条目数记在环节状态里（拿粘贴稿真的换来了 2 个逐项实例）");
    eq(run.nodes["m"].mapKey, "shot_list", "并记下这一轮用的展开键");
    ok(!!run.inst["m@0"] && !!run.inst["m@1"], "两个逐项实例各有一份内部图（得到 " + j(Object.keys(run.inst)) + "）");
    eq((run.ns["m@0"] || {}).item && (run.ns["m@0"] || {}).item.no, 1, "0 号实例的状态里就是第 1 个条目（各项互相看不见）");
    eq((run.ns["m@1"] || {}).item && (run.ns["m@1"] || {}).item.no, 2, "1 号实例的状态里是第 2 个条目");
    ok(await waitFor(() => run.nodes["e"] && run.nodes["e"].status === "done", 2000), "续跑继续点火到成功终点（e done，得到 " + j(run.nodes["e"] && run.nodes["e"].status) + "）");

    /* ── C：护栏 —— 不在等人的环节、拿不到 run 的情形一律 ok:false ── */
    const rC = LT.mapRepairWait(wf, "e", { overKey: "shot_list" });
    eq(rC.ok, false, "对不在等人的环节调用 → ok:false（不误改别的环节）");
    const rD = LT.mapRepairWait({ id: "wf-none", longtask: { tasks: [], active: "" } }, "m", {});
    eq(rD.ok, false, "拿不到启用中的 run → ok:false（界面 toast 提示而不是静默）");
  }

  /* ═══════════════ [7] 界面接线 ═══════════════ */
  console.log("\n[7] 界面接线：ltHumanCard(mapfix) → ltMapCard → window.LT.*（真跑卡片 + 真点按钮）");
  {
    /* 7a：退格输入框（input 形态）与下拉 handle 形态都要取得到值 */
    eq(sandbox.ltMapKeyVal({ value: "  typed  " }), "typed", "ltMapKeyVal：input 形态（值是字符串）取到并去空白");
    eq(sandbox.ltMapKeyVal({ value: () => "  picked  ", input: { value: "raw" } }), "picked", "ltMapKeyVal：handle 形态（值是函数）调用 value() 取到");
    eq(
      sandbox.ltMapKeyVal({ value: () => "", input: { value: " typed-in-handle " } }),
      "typed-in-handle",
      "ltMapKeyVal：handle 的 value() 为空时回落到裸 input.value（点了候选却读不到的旧坑）",
    );
    eq(sandbox.ltMapKeyVal({}), "", "ltMapKeyVal：什么都没有 → 空串（不塞 undefined 给引擎）");
    eq(sandbox.ltMapKeyVal(null), "", "ltMapKeyVal：null → 空串");

    /* 7b：真跑卡片 —— 证明 mapfix 走 ltMapCard、且卡片经 window.LT 取文案与补救 */
    const { run, wf } = await mkWaitingRun("r-card");
    const infoCalls = [];
    const realInfo = LT.mapWaitInfo;
    const realRepair = LT.mapRepairWait;
    const repairCalls = [];
    sandbox.window.LT.mapWaitInfo = (r, p) => {
      infoCalls.push([r, p]);
      return realInfo(r, p);
    };
    sandbox.window.LT.mapRepairWait = (w, p, o) => {
      repairCalls.push({ w, p, o });
      /* 引擎这条口是**同步**返回普通对象（界面对齐了这个契约）：桩也照这个契约给回执，
         否则「卡片把回执当 Promise 用」这类接缝会被桩自己掩盖过去。 */
      return { ok: true, key: "shot_list", count: 2 };
    };
    let card = null;
    let cardErr = null;
    try {
      card = sandbox.ltHumanCard(wf, run, { kind: "mapfix", path: "m", title: "逐项", round: 1 });
    } catch (e) {
      cardErr = e;
    }
    ok(!cardErr, "ltHumanCard 对 kind=mapfix 真能渲染出卡片" + (cardErr ? "（抛了：" + (cardErr && cardErr.message) + "）" : ""));
    eqNum(infoCalls.length, 1, "卡片渲染时调了一次 window.LT.mapWaitInfo（全库只有 ltMapCard 调它 → 证明走的是 ltMapCard）");
    ok(infoCalls[0] && infoCalls[0][0] === run, "mapWaitInfo 拿到的是这个 run（同一个对象，得到 " + j(infoCalls[0] && infoCalls[0][0] === run) + "）");
    eq(infoCalls[0] && infoCalls[0][1], "m", "mapWaitInfo 拿到的是这一环的 path");
    ok(card && String(card.className).indexOf("lt-card-map") >= 0, "卡片带 lt-card-map 类（mapfix 专用卡，得到 " + j(card && card.className) + "）");
    const txt = elText(card);
    has(txt, "逐项展开源", "卡片抬头就写着「逐项展开源」");
    has(txt, "当前状态里还没有可用的数组", "卡片正文用的是引擎就诊说明（界面不自己拼一份说法）");
    const btn = btnByText(card, "重新查找并继续");
    ok(!!btn, "卡片上有「重新查找并继续」按钮");
    const input = elByTag(card, "input");
    const area = elByTag(card, "textarea");
    ok(!!input && !!area, "卡片上展开键输入框与粘贴框都在（得到 input=" + j(input && input.value) + "）");
    eq(input && input.value, "shot_list", "展开键输入框初始化成引擎给的 want");
    eq(area && area.rows, 3, "粘贴框是多行输入（贴 JSON 数组用）");
    /* 用户把展开键改成候选里的那个 + 粘一份 JSON，再点按钮 */
    input.value = "  shots  ";
    area.value = '[{"a":1}]';
    toasts.length = 0;
    let clickErr = null;
    try {
      btn.onclick();
    } catch (e) {
      clickErr = e;
    }
    ok(!clickErr, "点「重新查找并继续」不抛错" + (clickErr ? "（抛了：" + (clickErr && clickErr.message) + "）" : ""));
    eqNum(repairCalls.length, 1, "点一次 → 调一次 window.LT.mapRepairWait");
    eq(repairCalls[0] && repairCalls[0].w, wf, "补救治的是这张画布");
    eq(repairCalls[0] && repairCalls[0].p, "m", "补救治的是这一环");
    eq(repairCalls[0] && repairCalls[0].o && repairCalls[0].o.overKey, "shots", "改过的展开键真的送进引擎（去空白后 shots，得到 " + j(repairCalls[0] && repairCalls[0].o) + "）");
    eq(repairCalls[0] && repairCalls[0].o && repairCalls[0].o.pasted, '[{"a":1}]', "粘贴框内容真的送进引擎");
    await sleep(20);
    ok(toasts.some((t) => /展开源已就位/.test(t[0])), "补救成功后卡片给出人读回执（toasts=" + j(toasts) + "）");

    /* 7c：换回引擎真身，从卡片一路点到状态 —— 界面手势真的落地 */
    sandbox.window.LT.mapWaitInfo = realInfo;
    sandbox.window.LT.mapRepairWait = realRepair;
    const two = await mkWaitingRun("r-card2");
    const card2 = sandbox.ltHumanCard(two.wf, two.run, { kind: "mapfix", path: "m", title: "逐项" });
    const btn2 = btnByText(card2, "重新查找并继续");
    const area2 = elByTag(card2, "textarea");
    area2.value = '[{"no":1},{"no":2},{"no":3}]';
    let clickErr2 = null;
    try {
      btn2.onclick();
    } catch (e) {
      clickErr2 = e;
    }
    ok(
      two.run.nodes["m"].status !== "waiting_human",
      "点「重新查找并继续」：这一环真离开 waiting_human（得到 " + j(two.run.nodes["m"].status) + "）",
    );
    eqNum((two.run.ns[""].shot_list || []).length, 3, "粘贴的三条真的写进状态（界面手势 → 引擎状态）");
    ok(await waitFor(() => two.run.nodes["m"].status === "done", 3000), "这一次补救把逐项展开真的跑完（m done，得到 " + j(two.run.nodes["m"].status) + "）");
    if (clickErr2) {
      note(
        "点「重新查找并继续」抛了：" +
          String(clickErr2.message) +
          " —— 引擎补救口是**同步**返回普通对象（见 [7b] 那条契约说明），卡片把它当 Promise（.then）用就会抛在这里。" +
          "状态改动仍会落地（上面两条断言证明了），丢的是卡片的重绘 / toast 回执；这条 note 一旦出现就是那处接缝又回来了。",
      );
    }
  }

  /* ═══════════════ [8] 源码级补充（不是真跑） ═══════════════ */
  console.log("\n[8] 源码级补充断言（has / hasnt；这一段是源码口径，不是真跑）");
  {
    /* 引擎：取不到数组那一段里不许出现 failed。
       锚点取「函数头 → 成功路径（转 running）」这一段：它是这段代码的结构，不跟着行内写法变。 */
    const at0 = LTV.indexOf("async function ltExecMap(");
    const at1 = at0 >= 0 ? LTV.indexOf('ltSetStat(run, path, "running")', at0) : -1;
    ok(at0 >= 0 && at1 > at0, "在 app-longtask.js 里定位到 ltExecMap 的「取不到数组」分支（函数体 " + at0 + " → 成功路径 " + at1 + "）");
    const branch = at0 >= 0 && at1 > at0 ? LTV.slice(at0, at1) : "";
    has(branch, 'ltSetStat(run, path, "waiting_human", { mapWait: true, err: plan.text })', "取不到数组：判 waiting_human 并带 mapWait（源码口径）");
    has(branch, 'ltPushWait(run, path, "mapfix", node)', "取不到数组：压一条 mapfix 等待项（源码口径）");
    hasnt(branch, '"failed"', "取不到数组的这一段里没有判 failed（口径：不因为一次键名对不上就断链）");
    has(branch, "return;", "取不到数组这一轮直接收工（不往下空跑）");

    /* 引擎：导出面齐全（真跑 typeof，不是 grep） */
    for (const k of ["mapItems", "mapSource", "mapKeyLabels", "mapWaitPlan", "mapWaitInfo", "mapRepairWait", "mapPutArray", "arrCoerce", "getArray", "keyCandidates"]) {
      eq(typeof LT[k], "function", "window.LT." + k + " 是可调的（真跑 typeof）");
    }

    /* 界面：dispatch + 卡片调用点（真跑的接线断言在 [7]，这里只补源码口径；
       文案按「可读的片段」判，不押整行写法，免得对方换个折行就红） */
    has(LTU, 'w.kind === "mapfix"', "ltHumanCard 里认 kind=mapfix（源码口径）");
    has(LTU, "return ltMapCard(wf, run, w)", "并原样交给 ltMapCard（源码口径）");
    has(LTU, "function ltMapCard(wf, run, w)", "ltMapCard 就在条带界面脚本里（源码口径）");
    has(LTU, "mapWaitInfo(run, wpath)", "卡片经 window.LT.mapWaitInfo 取文案与候选（源码口径）");
    has(LTU, "mapRepairWait(wf, wpath", "卡片经 window.LT.mapRepairWait 交回补救手势（源码口径）");
    has(LTU, "function ltMapKeyVal(keyIn)", "ltMapKeyVal 辅助函数在（源码口径）");
    hasnt(LTU, "mapItems(", "界面不自己算展开数组（判据唯一真源在引擎）");
  }
}

(async () => {
  try {
    await main();
  } catch (e) {
    fails++;
    checks++;
    console.log("FAIL  冒烟脚本自身抛错：" + String((e && e.stack) || e));
  }
  console.log("");
  if (notes.length) console.log("（另有 " + notes.length + " 条只记录不判失败的观察，见上面 note 行）");
  if (!fails) console.log("✓ " + checks + " 项全部通过 (smoke-longtask-map)");
  else {
    console.log(" " + fails + " / " + checks + " 项失败 (smoke-longtask-map)，失败项见上面 FAIL 行");
    process.exitCode = 1;
  }
})();
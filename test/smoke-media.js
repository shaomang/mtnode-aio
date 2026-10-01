/* test/smoke-media.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-media.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-media-queue.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-media-queue.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  const show = (v) => JSON.stringify(v);
  const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

  /* ---------- 从源码里按名字抠出顶层函数（不改动源文件，口径同 smoke-media-gen-menu.js） ---------- */
  function fnBody(src, name) {
    const pats = [
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
      new RegExp("\\nconst " + name + "\\s*=", "m"),
      new RegExp("\\nvar " + name + "\\s*=", "m"),
      new RegExp("\\nlet " + name + "\\s*=", "m"),
    ];
    let at = -1;
    for (const p of pats) {
      const m = src.match(p);
      if (m) {
        at = m.index + 1;
        break;
      }
    }
    if (at < 0) throw new Error("找不到函数/常量：" + name);
    const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
    if (isFn) {
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
        if (c === "/" && src[j + 1] === "/") {
          j = src.indexOf("\n", j) - 1;
          continue;
        }
        if (c === "/" && src[j + 1] === "*") {
          j = src.indexOf("*/", j) + 1;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          inStr = c;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (!depth) return src.slice(at, j + 1);
        }
      }
      throw new Error("函数体不完整：" + name);
    }
    const iBrace = src.indexOf("{", at);
    const iBracket = src.indexOf("[", at);
    const start =
      iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
    if (start < 0) throw new Error("找不到常量体：" + name);
    let depth2 = 0;
    for (let j = start; j < src.length; j++) {
      const c = src[j];
      if (c === "{" || c === "[") depth2++;
      else if (c === "}" || c === "]") {
        depth2--;
        if (!depth2) return src.slice(at, j + 1) + ";";
      }
    }
    throw new Error("常量体不完整：" + name);
  }
  const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

  /* ---------- 沙箱：只有与判定无关的部分（渲染 / 桥 / 状态回写）用替身 ---------- */
  const rendered = { canvas: 0, panel: 0 };
  const sandbox = {
    console,
    Math,
    JSON,
    Set,
    Map,
    Promise,
    Date,
    Number,
    String,
    Object,
    Array,
    Boolean,
    RegExp,
    Error,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    S: { wf: { id: "wf1", nodes: [] }, wfBag: {}, pendingRun: new Set() },
    I18n: { t: (s) => String(s) },
    renderCanvas: () => {
      rendered.canvas++;
    },
    updateRunQueuePanel: () => {
      rendered.panel++;
    },
    toast: () => {},
    scheduleSave: () => {},
    nodeById: (id) => sandbox.S.wf.nodes.find((n) => n.id === id) || null,
    isMediaGenNode: (n) => !!n && /_gen$|video_(upscale|interp)/.test(String(n.kind)),
    isVideoPostKind: (n) => !!n && (n.kind === "video_upscale" || n.kind === "video_interp"),
    ensureBackendUiState: (n) => (n._ui = n._ui || {}),
    computeExecDropWait: () => {},
    stopMediaBackendRunWatcher: (id) => sandbox.mediaBackendRunWatchers.delete(id),
    stopMediaGenRestoreWatch: (id) => {
      const t = sandbox.mediaGenRestoreTimers.get(id);
      if (t) clearInterval(t);
      sandbox.mediaGenRestoreTimers.delete(id);
    },
    stopAllMediaGenRestoreWatch: () => {},
    stopAllMediaBackendRunWatchers: () => {},
    mediaBackendRunWatchers: new Map(),
    mediaGenRestoreTimers: new Map(),
    window: { api: {} },
  };
  vm.createContext(sandbox);
  const G = (name) =>
    vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);

  const nodesSrc = read("renderer/app-nodes.js");
  const NODES_FNS = [
    "globalStopSeq",
    "markGlobalStop",
    "beginNodeRun",
    "bumpNodeStop",
    "runBatchStopped",
    "mediaRunStopped",
    "mediaGenQueuedIds",
    "mediaGenQueueHolds",
    "addPendingRun",
    "clearPendingRun",
    "findMediaGenNodeById",
    "mediaGenMarkDropped",
    "runMediaGenSerial",
    "hasAnyMediaGenActivity",
    "stopAllMediaGen",
  ];
  const NODES_VARS = ["mediaGenWaiters", "mediaGenRestoreTimers", "mediaBackendRunWatchers"];
  vm.runInContext(
    "let _mediaGenChain = Promise.resolve();\n" +
      "let GLOBAL_STOP_SEQ = 0;\n" +
      extract(nodesSrc, NODES_VARS) +
      extract(nodesSrc, NODES_FNS) +
      "\nglobalThis.__st = { runMediaGenSerial, clearPendingRun, addPendingRun, bumpNodeStop, beginNodeRun," +
      " mediaRunStopped, mediaGenWaiters, mediaGenQueuedIds, mediaGenQueueHolds, hasAnyMediaGenActivity," +
      " stopAllMediaGen, markGlobalStop, globalStopSeq };",
    sandbox,
    { filename: "media-queue-extract.js" },
  );
  const T = sandbox.__st;

  /* ---------- 小工具 ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function mkNode(id, kind) {
    return { id, kind, title: id, running: false, _aborted: false };
  }
  function resetScene(ids) {
    sandbox.S.wf.nodes = (ids || ["up1", "itp1", "up2"]).map((id) =>
      mkNode(id, id.indexOf("itp") === 0 ? "video_interp" : "video_upscale"),
    );
    sandbox.S.wfBag = {};
    sandbox.S.pendingRun = new Set();
    T.mediaGenWaiters.clear();
    rendered.canvas = 0;
    rendered.panel = 0;
  }
  /* 起跑替身：真实 playVideoPostNode 要后端，这里只记「谁按顺序起跑了」+ 走完 running 生命周期。
     gate：可选的闸门——第一个起跑的任务停在这里，让「后面几个真在排队」的窗口稳定可控
     （否则第一个可能已经跑完出队，断言就落在竞态上）。 */
  function makeRunner(ran, gate) {
    return (n) =>
      T.runMediaGenSerial(n, async () => {
        ran.push(n.id);
        T.beginNodeRun(n);
        n.running = true;
        if (gate && ran.length === 1) await gate;
        else await sleep(12);
        n.running = false;
        n.ranAt = Date.now();
        return "ok";
      });
  }
  function deferred() {
    let release = () => {};
    const p = new Promise((r) => {
      release = r;
    });
    return { p, release };
  }

  (async function main() {
    console.log("\n[0] 源码抽取自检");
    eqArr(
      NODES_FNS.filter((n) => typeof G(n) !== "function"),
      [],
      "app-nodes.js 目标函数全部抽到真实实现",
    );

    console.log("\n[1] 排队中：别的批次清「等待中」不得把仍在链上排队的任务删掉");
    {
      resetScene();
      const ran = [];
      const gate = deferred();
      const run = makeRunner(ran, gate.p);
      const ps = sandbox.S.wf.nodes.map((n) => run(n));
      await sleep(2); /* 第一个已起跑并被闸门挡着，后两个稳定停在排队窗口里 */
      eqArr(
        [...T.mediaGenQueuedIds()].sort(),
        ["itp1", "up2"],
        "后两个节点正停在媒体串行链上排队（第一个已在跑）",
      );
      ok(
        [...sandbox.S.pendingRun].sort().join(",") === "itp1,up1,up2",
        "三个都在「等待中」名单里（正在跑的那个也在自己的名下单）",
      );
      /* 控制节点批次收尾：拿整批目标 id 清等待态（真源码 playControlNode 的 finally 写法） */
      T.clearPendingRun(["up1", "itp1", "up2"]);
      eqArr(
        [...sandbox.S.pendingRun].sort(),
        ["itp1", "up2"],
        "清等待态后：仍在串行链上排队的两个等待态**保留**（不再凭空消失），已起跑的那个正常清掉",
      );
      ok(T.hasAnyMediaGenActivity(), "「全部终止」仍能看见队列里还有排队任务");
      gate.release();
      await Promise.all(ps);
      eqArr(ran, ["up1", "itp1", "up2"], "三个排队项依次真的起跑（一个都没丢）");
    }

    console.log("\n[2] 显式停止 / 摘出排队表：等待态必须清得掉（别把修复做成清不掉）");
    {
      resetScene();
      const ran = [];
      const run = makeRunner(ran);
      const ps = sandbox.S.wf.nodes.map((n) => run(n));
      await sleep(2);
      /* stopNode 的媒体分支：先从排队表摘掉，再 force 清等待态（app.js:20746 的真写法） */
      T.mediaGenWaiters.delete("itp1");
      T.clearPendingRun(["itp1"], { force: true });
      ok(!sandbox.S.pendingRun.has("itp1"), "显式停止的排队项：等待态立刻清掉");
      await Promise.all(ps);
      eqArr(ran, ["up1", "up2"], "被显式停止的排队项不再起跑");
      eqArr(
        [sandbox.S.wf.nodes[1].videoStatus || ""],
        ["已终止（排队中的生成任务已取消）"],
        "被停止的排队项在节点上写明「已终止（排队中的生成任务已取消）」",
      );
    }

    console.log("\n[3] 串行链：N 个排队项一个都不丢、顺序不乱（派生量不再有否决权）");
    {
      resetScene(["up1", "itp1", "up2", "itp2"]);
      const ran = [];
      const run = makeRunner(ran);
      /* 旧写法会在这里被判死：出队前 _stopTick 与 _runTick 派生量对不上（未置 _aborted） */
      for (const n of sandbox.S.wf.nodes) n._stopTick = 3, (n._runTick = 0);
      const ps = sandbox.S.wf.nodes.map((n) => run(n));
      await Promise.all(ps);
      eqArr(ran, ["up1", "itp1", "up2", "itp2"], "四个排队项全部起跑，顺序与入队一致");
      eqArr(
        sandbox.S.wf.nodes.map((n) => n.videoStatus || ""),
        ["", "", "", ""],
        "没有一个被误写成「已终止（排队中的生成任务已取消）」",
      );
      eqArr([...T.mediaGenWaiters.keys()], [], "跑完排队表清空");
    }

    console.log("\n[4] 真·终止：停止过的排队项绝不起跑");
    {
      resetScene();
      const ran = [];
      const run = makeRunner(ran);
      const ps = sandbox.S.wf.nodes.map((n) => run(n));
      await sleep(2);
      T.bumpNodeStop(sandbox.S.wf.nodes[1]); /* 单独停止 itp1（真源码 bumpNodeStop） */
      T.mediaGenWaiters.delete("itp1");
      await Promise.all(ps);
      eqArr(ran, ["up1", "up2"], "被 bumpNodeStop 的排队项没有起跑");
      ok(T.mediaRunStopped(sandbox.S.wf.nodes[1]), "mediaRunStopped 认这个停止标记");
    }

    console.log("\n[5] mediaRunStopped 只认 _aborted（派生量不再独立否决）");
    {
      resetScene();
      const n = sandbox.S.wf.nodes[0];
      n._stopTick = 5;
      n._runTick = 2;
      n._aborted = false;
      ok(!T.mediaRunStopped(n), "_stopTick/_runTick 不一致但没 _aborted → 不算已停止（排队项不会被误删）");
      n._aborted = true;
      ok(T.mediaRunStopped(n), "_aborted → 算已停止");
    }

    console.log("\n[6] 排队证据来自 mediaGenWaiters：起作用的是「在链上」而不是某个批次留下的标记");
    {
      resetScene(["up1", "up2"]);
      const ran = [];
      const gate = deferred();
      const run = makeRunner(ran, gate.p);
      const ps = sandbox.S.wf.nodes.map((n) => run(n));
      await sleep(2);
      ok(T.mediaGenQueueHolds("up2"), "mediaGenQueueHolds 认得正排队的节点（up2）");
      ok(!T.mediaGenQueueHolds("up1"), "已在跑的那个不算排队");
      ok(!T.mediaGenQueueHolds("nope"), "没排队的节点不认");
      gate.release();
      await Promise.all(ps);
      ok(!T.mediaGenQueueHolds("up2"), "出队后不再持有排队项");
    }

    console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"));
  })().catch((e) => {
    console.error(e);
  });
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-media-queue.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-media-queue.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-media-take-suffix.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-media-take-suffix.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const ROOT = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  let checks = 0;
  let fails = 0;
  function ok(c, msg) {
    checks++;
    if (!c) {
      fails++;
      console.log("  FAIL  " + msg);
    } else console.log("  ok    " + msg);
  }
  function eq(a, b, msg) {
    ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
  }
  function has(s, n, msg) {
    ok(String(s).indexOf(n) >= 0, msg + (String(s).indexOf(n) >= 0 ? "" : "（缺 " + JSON.stringify(n) + "）"));
  }
  function hasnt(s, n, msg) {
    ok(String(s).indexOf(n) < 0, msg + (String(s).indexOf(n) < 0 ? "" : "（仍含 " + JSON.stringify(n) + "）"));
  }
  function section(t) {
    console.log("\n── " + t + " ──");
  }

  /* ---------- 从源码里按名字抠出顶层函数 ---------- */
  function fnBody(src, name) {
    const m = src.match(
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    );
    if (!m) throw new Error("找不到函数：" + name);
    const at = m.index + 1;
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
      if (c === "/" && src[j + 1] === "/") {
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return src.slice(at, j + 1);
    }
    throw new Error("函数体不闭合：" + name);
  }
  const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

  const APP = read("renderer/app.js");
  const HOSTS = [
    "h3/main-h3.js",
    "music3/main-music3.js",
    "yue/main-yue.js",
    "remotion/main-remotion.js",
  ];

  /* ---------- 渲染层沙箱：takeStemParts / allocateUniqueMediaExport 是源码真函数 ---------- */
  const FILES = new Set();
  let CURRENT_EXP = null;
  const sandbox = {
    console, Math, JSON, String, Number, Boolean, RegExp, Object, Array,
    extOf: (n) => {
      const m = /(\.[a-z0-9]+)$/i.exec(String(n || ""));
      return m ? m[1] : "";
    },
    stemOfFilename: (n) =>
      String(n || "").replace(/\.(ya?ml|png|jpe?g|webp|gif|wav|flac|mp3|mp4|webm|mov|pdf)$/i, ""),
    joinPath: (d, f) => String(d || "").replace(/[\\/]+$/, "") + "/" + f,
    pathExistsAbs: async (p) => FILES.has(String(p)),
    resolveMediaGenExport: () => CURRENT_EXP,
    mediaGenExt: () => ".mp4",
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extract(APP, ["takeStemParts", "allocateUniqueMediaExport", "mediaGenRollSuffix", "resolveMediaGenRollExport"]),
    sandbox,
  );
  const G = (n) => vm.runInContext(n, sandbox);

  const mkExp = (filename, dir) => ({
    ok: true,
    outputDir: dir || "D:/out",
    filename,
    path: (dir || "D:/out") + "/" + filename,
  });
  const alloc = (filename, dir) => sandbox.allocateUniqueMediaExport(mkExp(filename, dir));

  (async () => {
    section("[1] takeStemParts：#N 认号 · _N / _0N 只当旧标记剥掉");
    const parts = G("takeStemParts");
    eq(JSON.stringify(parts("foo")), JSON.stringify({ base: "foo", from: 0 }), "无标记 → 原名 / from=0");
    eq(JSON.stringify(parts("foo#3")), JSON.stringify({ base: "foo", from: 3 }), "#3 → 认号 3（接着往下递增）");
    eq(JSON.stringify(parts("foo_1")), JSON.stringify({ base: "foo", from: 0 }), "旧式 _1 → 剥掉、不认号");
    eq(JSON.stringify(parts("foo_01")), JSON.stringify({ base: "foo", from: 0 }), "旧式 _01 → 剥掉");
    eq(JSON.stringify(parts("foo_1_1_1")), JSON.stringify({ base: "foo", from: 0 }), "旧实现叠出来的 _1_1_1 → 一次剥干净");
    eq(JSON.stringify(parts("报告_2024")), JSON.stringify({ base: "报告_2024", from: 0 }), "4 位年份（_2024）不当 take 标记");
    eq(JSON.stringify(parts("foo_310")), JSON.stringify({ base: "foo", from: 0 }), "3 位旧标记（_310）仍剥掉");

    section("[2] allocateUniqueMediaExport：撞名 → #1 → #2 → #3");
    FILES.clear();
    let r = await alloc("out.mp4");
    eq(r.filename, "out.mp4", "目标不存在 → 用配置名，不加任何后缀");
    ok(!r.renamed, "目标不存在 → renamed 不置位（不弹「改为保存为」）");

    FILES.clear();
    FILES.add("D:/out/out.mp4");
    r = await alloc("out.mp4");
    eq(r.filename, "out#1.mp4", "已有 out.mp4 → out#1.mp4（不再是 out_1.mp4）");
    ok(r.renamed === true, "撞名 → renamed=true（节点状态行会说明实际落点）");

    FILES.add("D:/out/out#1.mp4");
    r = await alloc("out.mp4");
    eq(r.filename, "out#2.mp4", "out.mp4 + out#1.mp4 都在 → out#2.mp4（递增）");

    FILES.add("D:/out/out#2.mp4");
    r = await alloc("out.mp4");
    eq(r.filename, "out#3.mp4", "三个都在 → out#3.mp4（继续递增）");

    section("[3] 不叠加后缀：上一轮写回的路径 / 旧实现污染的名字都能接着递增");
    FILES.clear();
    FILES.add("D:/out/out#1.mp4");
    r = await alloc("out#1.mp4"); /* = 上一轮改完写回 node.outputPath 的样子 */
    eq(r.filename, "out#2.mp4", "outputPath 已是 out#1.mp4 → 下一轮 out#2.mp4");
    FILES.add("D:/out/out#2.mp4");
    r = await alloc("out#1.mp4");
    eq(r.filename, "out#3.mp4", "再跑一轮 → out#3.mp4，绝不出现 out#1#1.mp4");

    FILES.clear();
    FILES.add("D:/out/out_1.mp4");
    FILES.add("D:/out/out_1_1.mp4");
    r = await alloc("out_1_1.mp4"); /* 旧实现留下的污染路径 */
    eq(r.filename, "out#1.mp4", "旧污染 out_1_1.mp4 → 治愈回 out#1.mp4");
    FILES.add("D:/out/out#1.mp4");
    r = await alloc("out_1_1.mp4");
    eq(r.filename, "out#2.mp4", "再撞 → out#2.mp4（# 编号递增）");
    ok(r.filename.indexOf("_1") < 0, "产物名里不再出现 _1 式后缀");

    FILES.clear();
    FILES.add("D:/out/曲.wav");
    FILES.add("D:/out/曲#1.wav");
    FILES.add("D:/out/曲#2.wav");
    r = await alloc("曲.wav");
    eq(r.filename, "曲#3.wav", "音频节点同口径（.wav 也按 #N 递增）");
    ok(r.path === "D:/out/曲#3.wav", "exp.path 同步指向实际落点");

    section("[4] 抽卡多次：take 标记同样是 #1、#2");
    const suffix = G("mediaGenRollSuffix");
    eq(suffix(1), "#1", "第 1 个 take → #1");
    eq(suffix(2), "#2", "第 2 个 take → #2");
    eq(suffix(10), "#10", "第 10 个 take → #10（不补零）");
    const roll = G("resolveMediaGenRollExport");
    CURRENT_EXP = mkExp("out.mp4");
    eq(roll(null, 1, 3).filename, "out#1.mp4", "抽卡 3 次的第 1 发 → out#1.mp4");
    eq(roll(null, 3, 3).filename, "out#3.mp4", "抽卡 3 次的第 3 发 → out#3.mp4");
    CURRENT_EXP = mkExp("out#1.mp4"); /* 上一轮已把带标记的路径写回节点 */
    eq(roll(null, 1, 2).filename, "out#1.mp4", "配置名带旧标记 → 剥掉再编号（不是 out#1#1）");
    eq(roll(null, 2, 2).filename, "out#2.mp4", "配置名带旧标记 → 第 2 发 out#2.mp4");
    CURRENT_EXP = mkExp("out.mp4");
    eq(roll(null, 1, 1).filename, "out.mp4", "单发仍用配置名（不加标记）");

    section("[5] 四个宿主 uniqueFileInDir 同口径（真源函数 + 假 FS）");
    for (const host of HOSTS) {
      const src = read(host);
      const label = host.split("/")[0];
      const files = new Set();
      const hb = {
        console, Math, JSON, String, Number, Boolean, RegExp, Object, Array, Error,
        mk: () => {},
        join: (d, f) => String(d || "").replace(/[\\/]+$/, "") + "/" + f,
        fs: { existsSync: (p) => files.has(String(p)) },
      };
      vm.createContext(hb);
      vm.runInContext(extract(src, ["takeStemParts", "uniqueFileInDir"]), hb);
      const u = hb.uniqueFileInDir;

      let x = u("D:/o", "v.mp4", ".mp4");
      eq(x.filename, "v.mp4", label + "：目标不存在 → 原名");
      ok(!x.renamed, label + "：目标不存在 → renamed=false");

      files.add("D:/o/v.mp4");
      x = u("D:/o", "v.mp4", ".mp4");
      eq(x.filename, "v#1.mp4", label + "：已有 v.mp4 → v#1.mp4");

      files.add("D:/o/v#1.mp4");
      x = u("D:/o", "v.mp4", ".mp4");
      eq(x.filename, "v#2.mp4", label + "：v.mp4 + v#1.mp4 都在 → v#2.mp4");

      files.add("D:/o/v#2.mp4");
      x = u("D:/o", "v#2.mp4", ".mp4");
      eq(x.filename, "v#3.mp4", label + "：已是 v#2.mp4 → v#3.mp4（递增、不叠 _1）");
      ok(x.path === "D:/o/v#3.mp4", label + "：path 与 filename 一致");

      const files2 = new Set(["D:/o/v_1.mp4", "D:/o/v_1_1.mp4"]);
      const hb2 = Object.assign({}, hb, { fs: { existsSync: (p) => files2.has(String(p)) } });
      vm.createContext(hb2);
      vm.runInContext(extract(src, ["takeStemParts", "uniqueFileInDir"]), hb2);
      eq(hb2.uniqueFileInDir("D:/o", "v_1_1.mp4", ".mp4").filename, "v#1.mp4", label + "：旧污染 v_1_1.mp4 → v#1.mp4");

      hasnt(src, 'baseStem + "_" + i + ext', label + "：旧的 _i 贴后缀已移除");
      has(src, 'head + "#" + i + ext', label + "：新口径 #i 贴后缀在位");
    }

    section("[6] 文案口径：#1、#2 说齐，_01、_02 清零");
    const I18N = read("renderer/i18n.js");
    const NODES = read("renderer/app-nodes.js");
    const CANVAS = read("renderer/app-canvas.js");
    has(I18N, "连续生成次数（1–10）；多次时输出命名为 #1、#2 …", "i18n 中文词条已改 #1、#2");
    has(I18N, "multiple runs save as #1, #2 …", "i18n 英文词条已改 #1, #2");
    has(I18N, "连续处理次数（1–10）；多次时输出命名为 #1、#2 …", "i18n 超分 / 补帧中文词条已改");
    has(I18N, "multiple passes are named #1, #2 …", "i18n 超分 / 补帧英文词条已改");
    hasnt(I18N, "_01", "i18n 不再残留 _01");
    hasnt(NODES, "_01、_02 …", "设置 tooltip 不再残留 _01、_02");
    hasnt(CANVAS, "_01、_02 …", "超分 / 补帧 tooltip 不再残留 _01、_02");
    eq((NODES.match(/多次时输出命名为 #1、#2/g) || []).length, 3, "生成族 3 处 tooltip 齐（music/tts/video/remotion · yue · sensenova）");
    eq((CANVAS.match(/多次时输出命名为 #1、#2/g) || []).length, 2, "后处理 2 处 tooltip 齐");
    for (const g of [
      "guides/nodes/video_upscale.md",
      "guides/nodes/video_interp.md",
      "guides/nodes/yue_gen.md",
      "guides/nodes/sensenova_gen.md",
      "guides/nodes/en/video_upscale.md",
      "guides/nodes/en/video_interp.md",
      "guides/nodes/en/yue_gen.md",
      "guides/nodes/en/sensenova_gen.md",
      "guides/manual/media-gen.md",
    ]) {
      hasnt(read(g), "_01", g + " 指南已改 #1、#2");
    }
    has(read("mtnode-agent-skills/mtnode/media-gen-nodes/SKILL.md"), "`#1`、`#2`", "技能 mtnode-media-gen-nodes 已改 #1、#2");
    has(read("sensenova/main-sensenova.js"), 'roll = Number.isFinite(n) && n >= 1 ? "#"', "SenseNova 资产命名同口径（#N）");

    console.log("\n" + (fails ? "FAIL" : "PASS") + " · " + (checks - fails) + "/" + checks);
  })();
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-media-take-suffix.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-media-take-suffix.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

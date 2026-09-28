"use strict";
/**
 * test/smoke-longtask-release.js —— 长周期任务 · 交付未交齐放行（本轮需求）
 *
 * 需求：交付物没全部提交时也允许继续任务，但要提醒用户，并允许用户在提交时输入补充信息
 * （为什么有些未交付、哪些需要额外交付）。口径（拷问共识）：
 *   ① 提醒不阻止：条带交付卡点「确认交付完成」→ 确认窗（列未交项 + 写说明 + 继续任务 / 返回补齐）；
 *      一件都没交也允许继续；
 *   ② 留痕三处同源：状态键 deliver_note / deliver_missing → run.nodes[path].deliverReleases 逐轮
 *      → 交付目录 manifest.json 的 releases 与《交付清单.md》的「未交付说明」段；
 *   ③ 下游只对**交付环节之后、同一命名空间**的 Agent 环节注入【交付放行】段，并要求它
 *      「缺件影响后续就标需人工」；交付环节的上游环节看不到；
 *   ④ 两个硬拦截（未交齐 / 缺文件名）都松绑：后端不再回 error 拦住。
 *
 * 分层（与 smoke-longtask.js 同一套：能真跑的一律真跑，只有「接线」才 grep）：
 *   [A] 渲染层引擎：在 vm 沙箱里真跑 ltReleaseMissingItems / ltReleaseMissingText /
 *       ltPathAfter / ltReleasesForPath / ltReleasesOf（app-longtask.js 导出的 window.LT）；
 *   [B] 条带界面：真跑 ltReleaseRecText（app-longtask-ui.js 同沙箱）；
 *   [C] 主进程存储：真加载 longtask-store.js（mock electron + 数据目录），真调
 *       lt:deliverEnsure 写 manifest.json / 交付清单.md，再真读回来；
 *   [D] 接线：确认窗 / 卡片 / 提示词 / 板身横幅的存在性与旧硬拦截的消失（grep 接线，不重复真跑）。
 * 只读断言对源码，写盘只落在临时目录（跑完删）。不起 Electron。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

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
const eqStr = (a, b, msg) => ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

const LTV = read("renderer/app-longtask.js");
const LTU = read("renderer/app-longtask-ui.js");
const STORE = read("longtask-store.js");
const CSS = read("renderer/css/longtask.css");

/* ── [A][B] 渲染层：同一只沙箱装 app-longtask.js + app-longtask-ui.js（与 smoke-longtask.js 同法）── */
function makeSandbox() {
  const sandbox = {
    window: { api: {} },
    S: { wf: null, config: {} },
    I18n: { t: (s) => s },
    document: { readyState: "loading", addEventListener() {}, getElementById() { return null; } },
    toast() {},
    scheduleSave() {},
    renderCanvas() {},
    focusNode() {},
    addNode() { return null; },
    console,
    setTimeout,
    clearTimeout,
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
  };
  vm.createContext(sandbox);
  vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
  vm.runInContext(LTU, sandbox, { filename: "renderer/app-longtask-ui.js" });
  return sandbox;
}

/* ── [C] 主进程存储：真加载 longtask-store.js ───────────────────────── */
function loadStore(dataDir) {
  const handlers = Object.create(null);
  const electronPath = require.resolve("electron");
  const providersPath = require.resolve(path.join(ROOT, "config-providers.js"));
  const storePath = path.join(ROOT, "longtask-store.js");
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { app: { getPath: () => dataDir }, ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) } },
  };
  /* config-providers 的 readJson / writeJson 就是原子读写，这里只替换掉对 electron 的依赖面：
     真实现会 require electron（app.getPath），在纯 node 里加载会炸；等价替身即可。 */
  require.cache[providersPath] = {
    id: providersPath,
    filename: providersPath,
    loaded: true,
    exports: {
      readJson(p, dflt) {
        try {
          return JSON.parse(fs.readFileSync(p, "utf8"));
        } catch {
          return dflt;
        }
      },
      writeJson(p, obj) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = p + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
        fs.renameSync(tmp, p);
        return true;
      },
    },
  };
  delete require.cache[storePath];
  const mod = require(storePath);
  mod.registerLongtaskIpc({ getDataDir: () => dataDir });
  return { handlers };
}

async function main() {
  const sandbox = makeSandbox();
  const LT = sandbox.window.LT;

  /* ═════════ [A] 未交清单 / 说明排版 / 下游归属（真跑） ═════════ */
  console.log("\n[A] 放行判据与下游归属（vm 真跑 window.LT）");
  ok(!!LT, "引擎 + 界面脚本整份执行并导出 window.LT");
  ok(typeof LT.releaseMissingItems === "function", "window.LT.releaseMissingItems 已导出（判据唯一真源）");
  ok(typeof LT.releaseMissingText === "function", "window.LT.releaseMissingText 已导出（排版唯一真源）");
  ok(typeof LT.releasesForPath === "function", "window.LT.releasesForPath 已导出（下游看到哪几条）");

  const items = [
    { id: "i1", kind: "file", file: "分镜表.md", required: true, done: false },
    { id: "i2", kind: "file", file: "成片.mp4", required: true, done: true },
    { id: "i3", kind: "file", title: "一批配图", required: true, done: false },
    { id: "i4", kind: "text", title: "风格说明", required: true, done: false },
    { id: "i5", kind: "file", file: "备选封面.png", required: false, done: false },
    { id: "i6", kind: "file", file: "Agent草稿.md", required: true, done: false, byAgent: true },
  ];
  const miss = LT.releaseMissingItems(items);
  eqNum(miss.length, 3, "未交清单：必填未交 3 条（i1 / i4 没交、i3 缺文件名；i2 已交不算、选填 i5 不算、Agent 占位 i6 不算）");
  eqNum(miss.filter((m) => m.reason === "not_done").length, 2, "原因 not_done = 没交（i1 / i4）");
  eqNum(miss.filter((m) => m.reason === "no_name").length, 1, "原因 no_name = 没定下文件名（i3）");
  has(miss.filter((m) => m.id === "i3")[0].name, "文件名待补", "缺文件名的条目在清单里显式标「文件名待补」");
  ok(
    !miss.some((m) => m.id === "i6"),
    "Agent 声明但还没验收的条目不算「用户没交」（不然每次放行都被占位项顶出一个假缺件）",
  );
  eqNum(LT.releaseMissingItems([{ id: "a", kind: "file", file: "x.md", required: true, done: true }]).length, 0, "全交齐 → 未交清单为空（不产生放行记录）");
  eqNum(LT.releaseMissingItems([{ id: "a", kind: "file", file: "x.md", required: false }]).length, 0, "只缺选填 → 未交清单为空（提醒只针对必填）");

  const txt = LT.releaseMissingText(miss, "第三份素材没拿到原始文件，先用占位版推进");
  has(txt, "本轮未交齐的必填项", "说明文本有「未交齐的必填项」抬头");
  has(txt, "分镜表.md", "逐条列出未交项名字");
  has(txt, "没定下文件名（含后缀）", "缺文件名的条目写明原因（文件名待补）");
  has(txt, "第三份素材没拿到原始文件", "人工说明原样进文本（状态键 / manifest / 下游同一份）");
  const txtEmpty = LT.releaseMissingText(miss, "");
  has(txtEmpty, "（未填说明）", "说明留空也放行：显式记「（未填说明）」，不让「没写」与「没放行过」分不出来");
  eqStr(LT.releaseMissingText([], "x"), "", "没有未交项时排版为空（正常交付不写放行记录）");

  /* 下游归属：只在交付环节之后、同一命名空间才注入。
   判据是「同一命名空间且排在交付环节之后」——真实图里节点 id 由创建顺序生成（s → h → m…），
   所以这里的下游用排在 h 之后的 id（m），上游用排在 h 之前的 id（a）。 */
  const mkRun = () => ({
    runId: "r1",
    ns: {},
    graph: {
      nodes: [
        { id: "a", kind: "start", title: "起点" },
        { id: "h", kind: "human", title: "交稿", cfg: { mode: "deliver" } },
        { id: "m", kind: "agent", title: "剪辑", cfg: { goal: "剪" } },
      ],
      edges: [],
    },
    nodes: {
      h: { path: "h", status: "done", deliverReleases: [{ round: 1, at: 1700000000000, note: "占位推进", missing: [{ id: "i1", reason: "not_done", name: "分镜表.md" }] }] },
      m: { path: "m", status: "running" },
      "s/m": { path: "s/m", status: "running" },
    },
  });
  const run1 = mkRun();
  eqNum(LT.releasesForPath(run1, "m").length, 1, "交付环节 h 的**下游** m 看得到放行记录");
  eqStr(LT.releasesForPath(run1, "m")[0].title, "交稿", "注入时带得出交付环节的标题（提示词里说得清是哪一环放的）");
  eqNum(LT.releasesForPath(run1, "a").length, 0, "排在交付环节**之前**的环节看不到（不污染上游提示词）");
  eqNum(LT.releasesForPath(run1, "h").length, 0, "交付环节自己看不到（它不是自己的下游）");
  const runSub = { runId: "rs", ns: {}, graph: { nodes: [{ id: "h", kind: "human", title: "交稿", cfg: {} }, { id: "s", kind: "sub", title: "子图", cfg: {} }], edges: [] }, nodes: { h: { path: "h", status: "done", deliverReleases: [{ round: 1, at: 1, note: "", missing: [{ id: "y", reason: "not_done", name: "b.md" }] }] }, "s/a": { path: "s/a", status: "running" } } };
  eqNum(LT.releasesForPath(runSub, "s/a").length, 0, "子图内部的环节按「同一命名空间」算：主图交付环节的放行不注入它（父路径段对不上）");
  const runSub2 = { runId: "rs2", ns: {}, graph: { nodes: [{ id: "s", kind: "sub", title: "子图", cfg: {} }], edges: [] }, nodes: { "s/h": { path: "s/h", status: "done", deliverReleases: [{ round: 1, at: 1, note: "", missing: [{ id: "y", reason: "not_done", name: "b.md" }] }] }, "s/m": { path: "s/m", status: "running" } } };
  eqNum(LT.releasesForPath(runSub2, "s/m").length, 1, "子图内部自己的交付环节放行 → 子图内部的下游环节看得到（同层 s 前缀，m > h）");
  const runOther = { runId: "ro", ns: {}, graph: { nodes: [{ id: "h", kind: "human", title: "交稿", cfg: {} }, { id: "m", kind: "agent", title: "剪辑", cfg: {} }], edges: [] }, nodes: { h: { path: "h", status: "done", deliverReleases: [{ round: 1, at: 1, note: "", missing: [{ id: "y", reason: "not_done", name: "b.md" }] }] }, m: { path: "m", status: "running" } } };
  eqNum(LT.releasesForPath(runOther, "h").length, 0, "交付环节自己那条不注入（它不是自己的下游）");
  eqNum(LT.releasesForPath(runOther, "m").length, 1, "同一命名空间里排在交付环节之后的环节才拿得到（m > h）");
  const runEarly = { runId: "re", ns: {}, graph: { nodes: [{ id: "m", kind: "agent", title: "剪辑", cfg: {} }, { id: "h", kind: "human", title: "交稿", cfg: {} }], edges: [] }, nodes: { m: { path: "m", status: "done", deliverReleases: [{ round: 1, at: 1, note: "", missing: [{ id: "y", reason: "not_done", name: "b.md" }] }] }, h: { path: "h", status: "running" } } };
  eqNum(LT.releasesForPath(runEarly, "h").length, 0, "排在交付环节之前的环节看不到（h < m，不污染上游提示词）");
  const run2 = mkRun();
  run2.nodes["h@2"] = { path: "h@2", status: "done", deliverReleases: [{ round: 1, at: 1, note: "", missing: [{ id: "x", reason: "not_done", name: "a.md" }] }] };
  eqNum(LT.releasesForPath(run2, "m").length, 2, "两个交付环节（h / h@2）都在 m 的上游时按环节各给一条（不合并、不丢）");
  const run4 = { runId: "r4", ns: {}, graph: { nodes: [{ id: "m", kind: "map", title: "逐项", cfg: { overKey: "shots" } }, { id: "x", kind: "agent", title: "细修", cfg: { goal: "修" } }], edges: [] }, nodes: { "m@1/h": { path: "m@1/h", status: "done", deliverReleases: [{ round: 1, at: 1, note: "", missing: [{ id: "x", reason: "not_done", name: "a.md" }] }] }, "m@1/x": { path: "m@1/x", status: "running" }, "m@2/x": { path: "m@2/x", status: "running" } } };
  eqNum(LT.releasesForPath(run4, "m@1/x").length, 1, "map 实例内部的环节看得到同一实例里、它前面的交付环节放行（父路径是前缀）");
  eqNum(LT.releasesForPath(run4, "m@2/x").length, 0, "另一个 map 实例的环节看不到（实例之间互不可见，别把别的实例的缺件串进来）");
  eqNum(LT.releasesForPath({ runId: "r", ns: {}, nodes: { a: { path: "a", status: "running", deliverReleases: [] } } }, "m").length, 0, "没有放行记录 → 不注入（不污染每个环节的提示词）");

  const rels = LT.releasesOf({ releases: [{ round: 3, at: 1700000000000, note: "n", missing: [{ id: "i", reason: "no_name", name: "x.md" }] }, { at: 0, note: "没有时间戳的假记录" }] });
  eqNum(rels.length, 1, "磁盘 releases 读回：没有 at 的记录被丢掉（不认半条记录）");
  eqNum(rels[0].round, 3, "读回保留轮次（跨会话后界面仍能说「第 3 轮」）");

  /* ═════════ [B] 条带界面：放行文本同一口径（真跑） ════════ */
  console.log("\n[B] 条带界面的放行文本（vm 真跑 ltReleaseRecText）");
  const recTxt = vm.runInContext(
    'ltReleaseRecText({ round: 2, at: 1700000000000, note: "", missing: [{ id: "i1", reason: "not_done", name: "分镜表.md" }, { id: "i2", reason: "no_name", name: "一批配图" }] })',
    sandbox,
  );
  has(recTxt, "分镜表.md", "确认窗 / 板身共用文本：列出未交项");
  has(recTxt, "没定下文件名（含后缀）", "缺文件名的那条写明原因");
  has(recTxt, "（未填说明）", "空说明显示为「（未填说明）」");
  ok(typeof sandbox.ltHumanReleaseDialog === "function", "确认窗函数在界面脚本里（ltHumanReleaseDialog）");

  /* ═════════ [C] 交付目录：manifest.json + 交付清单.md（真写盘 · 真读回） ════════ */
  console.log("\n[C] 交付目录落盘（真加载 longtask-store.js + 真写盘读回）");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lt-rel-"));
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const { handlers } = loadStore(path.join(tmp, "data"));
  ok(!!handlers["lt:deliverEnsure"], "lt:deliverEnsure 已注册（交付目录唯一写入口）");

  const uid = "ltrel1-交稿";
  const itemsToWrite = [
    { id: "i1", kind: "file", file: "分镜表.md", desc: "每镜头一行", required: true, done: true, paths: [path.join(ws, "分镜表.md")], deliveredVia: "上传" },
    { id: "i2", kind: "file", file: "成片.mp4", desc: "最终片", required: true, done: false, paths: [] },
    { id: "i3", kind: "file", title: "一批配图", desc: "十张", required: true, done: false, paths: [] },
    { id: "i4", kind: "text", title: "风格说明", required: true, done: false, value: "" },
  ];
  const r1 = await handlers["lt:deliverEnsure"](null, { uid, workspace: ws, items: JSON.parse(JSON.stringify(itemsToWrite)) });
  ok(r1 && r1.ok, "先建目录 + 清单（这一次还没放行）");
  const mp = path.join(r1.dir, "manifest.json");
  let man = JSON.parse(fs.readFileSync(mp, "utf8"));
  eqNum((man.releases || []).length, 0, "没放行前 manifest.releases 是空（正常交付不产生放行记录）");

  const r2 = await handlers["lt:deliverEnsure"](null, {
    uid,
    workspace: ws,
    items: JSON.parse(JSON.stringify(itemsToWrite)),
    release: { note: "成片还没渲染完，先用占位版推进；额外交付：竖屏裁剪版", missing: LT.releaseMissingItems(itemsToWrite), at: 1700000000000, round: 1 },
  });
  ok(r2 && r2.ok, "带 release 的写入 = 这一轮未交齐也继续");
  man = JSON.parse(fs.readFileSync(mp, "utf8"));
  eqNum((man.releases || []).length, 1, "manifest.releases 追了一条放行记录");
  eqNum(man.releases[0].round, 1, "轮次按渲染层算好的那一份（与 run 归档同号）");
  eqStr(man.releases[0].note, "成片还没渲染完，先用占位版推进；额外交付：竖屏裁剪版", "人工说明原样落盘（跨会话读得回来）");
  eqNum(man.releases[0].missing.length, 3, "未交清单逐条落盘（成片/一批配图/风格说明）");
  const mdPath = path.join(r2.dir, "交付清单.md");
  const md = fs.readFileSync(mdPath, "utf8");
  has(md, "未交付说明", "《交付清单.md》有「未交付说明」段");
  has(md, "为什么没交、哪些需要额外交付", "说明段写清这段是哪来的（人读口径）");
  has(md, "成片还没渲染完", "说明段带上人工写的说明");
  has(md, "未交付·已放行", "顶表里未交的必填项状态是「未交付·已放行」而不是「待交付」");
  has(md, "分镜表.md", "已交付的那件仍在表里");
  has(md, "没定下文件名（含后缀）", "缺文件名的那条在未交清单里写明原因");

  /* 第二轮回读（merge）：磁盘上的放行记录读得回来，且放行记录不会被「不带 release 的同步」抹掉 */
  const r3 = await handlers["lt:deliverEnsure"](null, { uid, workspace: ws, items: JSON.parse(JSON.stringify(itemsToWrite)), merge: true });
  eqNum((r3.manifest.releases || []).length, 1, "merge 读回：放行记录还在（进环节 / 继续 run 时看得到上次是带着什么继续的）");
  const back = LT.releasesOf(r3.manifest);
  eqNum(back.length, 1, "渲染层 ltReleasesOf 能把它还原成运行态可用的形状");
  has(LT.releaseMissingText(back[0].missing, back[0].note), "成片还没渲染完", "还原后排版文本仍带得出人工说明");
  const r4 = await handlers["lt:deliverEnsure"](null, {
    uid,
    workspace: ws,
    items: JSON.parse(JSON.stringify(itemsToWrite)),
    release: { note: "第二轮说明", missing: [{ id: "i2", reason: "not_done", name: "成片.mp4" }], at: 1700000100000, round: 2 },
  });
  man = JSON.parse(fs.readFileSync(mp, "utf8"));
  eqNum(man.releases.length, 2, "第二轮放行逐轮追加（不是覆盖）");
  eqNum(man.releases[1].round, 2, "第二轮的轮次是 2（与 run 归档同号）");
  const md2 = fs.readFileSync(mdPath, "utf8");
  has(md2, "第二轮说明", "最新一轮说明在 .md 里");
  has(md2, "成片还没渲染完", "历史轮次仍保留在 .md 里（逐轮留痕，可回看）");
  const r5 = await handlers["lt:deliverEnsure"](null, { uid, workspace: ws, items: JSON.parse(JSON.stringify(itemsToWrite)) });
  man = JSON.parse(fs.readFileSync(mp, "utf8"));
  eqNum(man.releases.length, 2, "不带 release 的清单同步不会动放行记录（放行痕迹丢不了）");
  ok(r5 && r5.ok, "不带 release 的写入照旧成功（老调用点不受影响）");

  /* manifest 记录数上限：逐轮追加也有头 */
  for (let i = 0; i < 25; i++) {
    await handlers["lt:deliverEnsure"](null, {
      uid,
      workspace: ws,
      items: JSON.parse(JSON.stringify(itemsToWrite)),
      release: { note: "第 " + (i + 3) + " 轮", missing: [{ id: "i2", reason: "not_done", name: "成片.mp4" }], at: 1700000000000 + i, round: i + 3 },
    });
  }
  man = JSON.parse(fs.readFileSync(mp, "utf8"));
  eqNum(man.releases.length, 20, "放行记录上限 20 轮（防 manifest 无限长）");

  /* ════════ [D] 接线（不重复真跑的部分） ═════════ */
  console.log("\n[D] 接线：确认窗 / 卡片 / 提示词 / 板身 / 旧硬拦截已消失");
  has(LTU, "function ltHumanReleaseDialog(wf, w, st, node, items, noteIn) {", "确认窗入口 ltHumanReleaseDialog");
  has(LTU, 'openOverlay(ltT("确认交付完成"), { persistent: true, min: false })', "确认窗走 #overlay 且 persistent（禁点外部自动关）");
  has(LTU, 'back.textContent = ltT("返回补齐")', "窗里有「返回补齐」出口（不提交，说明留草稿）");
  has(LTU, 'go.textContent = ltT("继续任务")', "窗里有「继续任务」出口（提交说明并放行）");
  has(LTU, "ltDraftBind(ltEl(\"textarea\", \"lt-in\"), key)", "说明输入框绑草稿（重绘 / 返回补齐后不丢）");
  has(LTU, '"relnote"', "草稿字段是 relnote（与审批理由 why 分开，不串台）");
  has(LTU, "ltHumanResolve(wf, { path: wpath, decide: \"deliver\", items: items, note: v })", "放行走 ltHumanResolve 并带上说明");
  hasnt(LTU, '"lt-btn-prim", "lt-btn-pri" + (pr.ready && !missNames ? "" : " dim")', "旧「没交齐就置灰」的按钮写法已移除（按钮永远可点）");
  has(LTU, "点开写清原因后可继续，也可以回去补齐", "按钮 tooltip 说明「还能继续」");
  has(LTU, "已在未交齐的情况下放行", "放行后 toast 说清是放行而不是「交齐了」");
  has(LTU, "lt-dlv-rel", "交付节点板身有放行横幅（带着没交齐的项继续时看得见）");
  has(LTU, 'ltT("未交齐放行：还有 ")', "板身横幅写明还有几项必填未交");
  has(LTU, "ltReleaseRecText({ missing: miss, note: node.ltReleaseNote })", "板身横幅与确认窗同一份排版口径");
  has(LTU, "未交付·已放行", "清单条目标签能显示「未交付·已放行」");
  has(LTU, "必填（没交齐时点确认会先弹确认窗：说清原因就能继续）", "添加文件对话框的必填文案改口径（旧「全交齐才能确认交付」不再出现）");
  hasnt(LTU, "必填项全交齐才能确认交付", "旧「必填项全交齐才能确认交付」文案已移除（不再与运行时矛盾）");
  has(CSS, ".lt-rel-miss", "确认窗样式齐备（lt-rel-miss）");
  has(CSS, ".lt-dlv-rel", "板身横幅样式齐备（lt-dlv-rel）");
  has(CSS, ".lt-item-tag.rel", "「未交付·已放行」标签配色齐备");

  has(LTV, "function ltReleaseMissingItems(items) {", "未交清单判据唯一真源 ltReleaseMissingItems");
  has(LTV, "function ltReleaseMissingText(missing, note) {", "说明排版唯一真源 ltReleaseMissingText");
  has(LTV, "ltStatePut(run, o.path, \"deliver_note\", note)", "说明写进状态键 deliver_note");
  has(LTV, "ltStatePut(run, o.path, \"deliver_missing\", missing)", "未交清单写进状态键 deliver_missing");
  has(LTV, "st.deliverReleases = ltArr(st.deliverReleases).concat(", "run 里逐轮归档放行记录（deliverReleases）");
  hasnt(LTV, 'if (!prog.ready) return { ok: false, error: ltT("必填条目还没交付完（")', "旧硬拦截「必填没交齐就 error」已移除");
  hasnt(LTV, "必填文件还没定下文件名（含后缀），不能确认交付", "旧硬拦截「缺文件名就 error」已移除");
  has(LTV, 'return { ok: true, released: !!missing.length, missing: missing.length };', "放行结果回传 released / missing（UI 据此说明白）");
  has(LTV, "【交付放行（必填项没交齐，人工说明后继续）】", "下游 Agent 提示词有【交付放行】段");
  has(LTV, "就把本环节标为「需人工」", "提示词要求下游：缺件影响后续就标需人工（不硬跑）");
  has(LTV, "if (rels.length) {", "只在有放行记录时才注入（上游环节看不到）");
  has(LTV, "const rels = ltReleasesForPath(run, path);", "提示词按「本环节能看到的上游放行」注入");
  has(LTV, "ltReleasesOf(r.manifest)", "进环节 / 继续 run 时从磁盘读回放行记录（跨会话）");
  has(LTV, "release: o.missing ?", "交付目录写入带上 release（manifest.releases 的唯一入口）");
  has(STORE, "function normRelease(rel, manifest) {", "主进程侧放行记录归一 normRelease");
  has(STORE, "manifest.releases.push(rel)", "manifest.releases 逐轮追加");
  has(STORE, "const RELEASE_KEEP = 20;", "放行记录上限 20（与渲染层同口径）");
  has(STORE, "未交付说明", "《交付清单.md》写出「未交付说明」段");
  has(STORE, "未交付·已放行", "顶表状态列写「未交付·已放行」");
  has(STORE, "deliverMarkdown(uid, manifest, lastRel)", "人读镜像带上最近一轮放行");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-longtask-release)");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.log("测试异常：" + String((e && e.stack) || e));
  process.exit(1);
});
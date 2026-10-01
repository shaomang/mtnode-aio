"use strict";
/**
 * test/smoke-longtask.js —— 长周期任务系统（状态机 · 人在环 · 交付节点 · 长期记忆 · 顶部条带）
 *
 * 这套东西横跨五层，任何一层掉链子都会变成「界面能开但跑不动」，所以断言按层排：
 *   [1] 主进程存储：longtask-store.js 的通道、路径口径（数据绝不落应用目录）、FTS5 兜底
 *   [2] 装配：main.js / build.json 白名单 / preload 桥 / index.html 脚本 / style.css 引入
 *   [3] 网关契约：mtnode-longtask 插件登记、lt 帧两端都认、动作字符串与渲染层对得上
 *   [4] 交付节点（kind deliver）：登记齐全 + 只由系统创建（addNode / 复制 / canvas_edit 三道闸）
 *       + 主画布配色 + 指南与 i18n（AGENTS.md：新增节点类型必须补指南）
 *   [5] 引擎真行为：把 app-longtask.js 整份装进 vm 跑 norm / validate / itemsProgress /
 *       工具应答的归属闸（非长任务轮必须回错误，不写任何状态）
 *   [6] 条带界面与生命周期口径
 * 只读断言：不改任何文件、不起 Electron。
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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

const STORE = read("longtask-store.js");
const MAIN = read("main.js");
const PRELOAD = read("preload.js");
const BUILD = read("build.json");
const HTML = read("renderer/index.html");
const STYLE = read("renderer/style.css");
const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVASJS = read("renderer/app-canvas.js");
const DB = read("renderer/app-db.js");
const ASSIST = read("renderer/app-assist.js");
const BOOT = read("renderer/app-boot.js");
const HELP = read("renderer/app-nodehelp.js");
const I18N = read("renderer/i18n.js");
const LTV = read("renderer/app-longtask.js");
const LTU = read("renderer/app-longtask-ui.js");
const LTC = read("renderer/app-longtask-ctl.js");
const LTG = read("renderer/app-longtask-guide.js");
const LTCSS = read("renderer/css/longtask.css");
const CANVASCSS = read("renderer/css/canvas.css");
const LIGHTCSS = read("renderer/css/theme-light.css");
const GW = read("dsh/gateway/gateway.mjs");
const PLUGIN = read("dsh/gateway/longtask-plugin.mjs");
const CORDIS = read("dsh/gateway/cordis.yml");
const TV = read("dsh/gateway/tool-visibility.mjs");
const SMOKE_TOKEN = read("test/smoke-token-budget.js");

/* ═══════════════ [1] 主进程存储 ═══════════════ */
console.log("\n[1] longtask-store.js：通道 / 路径 / FTS5 兜底 / 交付目录只报告不删");
for (const ch of [
  "lt:runSave", "lt:runGet", "lt:runList", "lt:runDelete",
  "lt:memAdd", "lt:memRecall", "lt:memList", "lt:memGet", "lt:memDelete", "lt:memStats",
  "lt:deliverEnsure", "lt:deliverList", "lt:deliverOrphans",
]) {
  has(STORE, 'ipcMain.handle("' + ch + '"', "通道已挂：" + ch);
}
has(STORE, "function registerLongtaskIpc(opts)", "导出注册口 registerLongtaskIpc");
has(STORE, "getDataDir", "数据根从宿主注入的 getDataDir 解析（不自造路径）");
has(STORE, "function underAppDir(p)", "有「落进应用目录」的判定函数");
has(STORE, "function appDirs()", "应用目录清单（app.getAppPath / exe 同目录）单独成函数");
has(STORE, "if (ws && !underAppDir(ws))", "交付目录：工作目录落进应用目录就不采用，退回数据目录（AGENTS：数据不落应用文件夹）");
has(STORE, '"longtask"', "一切都在 <DATA>/longtask/ 下");
has(STORE, "mem_fts", "记忆库建了 FTS5 虚表");
has(STORE, "memFts", "FTS5 不可用时有一条 LIKE 兜底路径（不是一次抛错）");
has(STORE, "bm25", "召回按 bm25 排序（不是随便取前 N 条）");
has(STORE, "交付清单.md", "交付目录里除了 manifest.json 还有一份给人看的清单");
has(STORE, "manifest.json", "交付目录的真源是 manifest.json");
{
  const at = STORE.indexOf("lt:deliverOrphans");
  const body = STORE.slice(at, at + 1400);
  hasnt(body, "rm(", "体检只报告无主交付目录，不 rm");
  hasnt(body, "unlink", "体检只报告无主交付目录，不 unlink");
  hasnt(body, "rmdir", "体检只报告无主交付目录，不 rmdir");
}
has(STORE, "scope", "记忆带 scope（global / workspace / workflow 三层）");

/* ═══════════════ [2] 装配 ═══════════════ */
console.log("\n[2] 装配：require / build.json 白名单 / preload 桥 / 脚本与样式引入");
has(MAIN, 'require("./longtask-store.js")', "main.js require 了 longtask-store.js");
has(MAIN, "registerLongtaskIpc({ getDataDir: DATA", "main.js 启动时注册长任务 IPC（数据根 = DATA）");
has(MAIN, '["长周期任务 longtask", "longtask"]', "启动体检 appDirDataCandidates 认识 longtask 目录（数据落进应用目录会报警）");
has(BUILD, '"longtask-store.js"', "build.json files 白名单收了这个根目录主进程模块（否则打包后 Cannot find module）");
{
  const usedApi = Array.from(new Set(Array.from((LTV + LTU).matchAll(/window\.api\.(lt[A-Za-z]+)\s*\(/g)).map((m) => m[1])));
  ok(usedApi.length >= 7, "渲染层实际用到 " + usedApi.length + " 条长任务桥（少于 7 说明抽取跑偏；记忆已改走 AI 事实库，不再走 ltMemRecall / ltMemAdd 两条桥）");
  const missing = usedApi.filter((n) => !new RegExp("^\\s*" + n + ":\\s*\\(", "m").test(PRELOAD));
  eqNum(missing.length, 0, "渲染层用的每条 lt* 桥都在 preload 白名单里" + (missing.length ? "（缺：" + missing.join(",") + "）" : ""));
}
has(HTML, 'src="app-longtask.js"', "index.html 加载引擎（模型 + 状态机 + 生命周期）");
has(HTML, 'src="app-longtask-ui.js"', "index.html 加载条带界面");
ok(HTML.indexOf('src="app-plan.js"') < HTML.indexOf('src="app-longtask.js"'), "加载顺序：长任务引擎在既有线性计划系统之后（并存不互相取代）");
ok(HTML.indexOf('src="app-longtask-ui.js"') < HTML.indexOf('src="app-boot.js"'), "加载顺序：界面脚本在启动脚本之前（boot 时条带已经能挂）");
has(STYLE, '@import url("./css/longtask.css")', "style.css 引了长任务样式表");
hasnt(HTML, 'ltStrip', "index.html 里没有静态条带 DOM（运行时自己挂，不污染既有布局）");

/* ═══════════════ [3] 网关契约 ═══════════════ */
console.log("\n[3] 网关：插件登记 / lt 帧两端都认 / 动作字符串对得上 / 可裁名单");
has(PLUGIN, "export const name = 'mtnode-longtask'", "插件有名有姓：mtnode-longtask");
has(PLUGIN, "export const inject = ['tools']", "插件只注入 tools 面（三层契约里的工具层）");
has(PLUGIN, "name: 'lt_state'", "工具 lt_state 已注册");
hasnt(PLUGIN, "name: 'lt_memory'", "lt_memory 已下线：长任务插件不再注册它（长期记忆沉淀改走 mtnode_facts）");
has(read("dsh/gateway/ai-facts-plugin.mjs"), "name: 'mtnode_facts'", "接棒的工具 mtnode_facts 由 ai-facts-plugin.mjs 注册");
has(PLUGIN, "isToolHidden('lt_state')", "lt_state 走按运行裁剪的注册口（不该发的整份 schema 就不发）");
has(PLUGIN, "send({ t: 'lt', id, sessionId, action, params: params || {} })", "请求帧带 sessionId（归属校验的凭据）");
has(CORDIS, "mtnode-longtask", "cordis.yml 挂了长任务插件");
has(CORDIS, "./longtask-plugin.mjs", "cordis.yml 指向插件文件");
has(CORDIS, "MTNODE_PURE", "纯离线档（MTNODE_PURE）下该插件不加载，与其它工具插件同规则");
has(GW, "m.t !== 'lt'", "网关 onBridgeFrame 的帧类型白名单认 lt");
has(GW, "p.kind === 'lt'", "网关 interact 出口认 kind:'lt'（渲染层回结果走这条）");
has(GW, "'lt-result'", "网关把结果回给插件时叫 lt-result，与插件收帧侧同名");
{
  /* lt_memory 的四个动作（recall / list / write / propose）随工具下线：插件只发状态机那两个 */
  const pluginActions = ["stateRead", "stateWrite"];
  const missing = pluginActions.filter((a) => !new RegExp("['\"]" + a + "['\"]").test(PLUGIN) || LTV.indexOf('"' + a + '"') < 0);
  eqNum(missing.length, 0, "插件发出的动作字符串在渲染层都有分支接住" + (missing.length ? "（缺：" + missing.join(",") + "）" : ""));
  hasnt(PLUGIN, "'recall'", "插件不再发 lt_memory 的 recall 动作");
}
for (const n of ["lt_state"]) {
  has(TV, "'" + n + "'", "可裁名单收了 " + n + "（藏了才真的不发）");
  has(SMOKE_TOKEN, '"' + n + '"', "smoke-token-budget 钉住了 " + n + " 的可见性口径");
}
has(DB, 'names.push("lt_state")', "未接地长任务的普通会话把 lt_state 点名藏掉（lt_memory 已下线，不再有第二个名字）");

/* ═══════════════ [4] 交付节点 ═══════════════ */
console.log("\n[4] 交付节点（kind deliver）：登记齐全 + 只由系统创建 + 配色 / 指南 / i18n");
has(APP, 'deliver: "dlv"', "KIND_CLS 有 deliver → 主画布按类上色");
has(APP, "deliver: {", "NODE_DEFAULTS 有 deliver（渲染 / 最小尺寸 / 字段缺省都靠它）");
has(APP, "ltItems: [],", "NODE_DEFAULTS.deliver 带 ltItems（清单随画布 JSON 存）");
has(APP, "window.LT.deliverPendingItems(node)", "输入端子 = 还没交的文件项个数（一个端子严格对应一个文件，交掉即消失 · 需求本体）");
hasnt(APP, 'if (node.kind === "deliver") return 2;', "旧「固定 2 个端子（1 数据入 + 1 控制入）」已移除");
has(APP, 'deliver: "交付"', "kind 名显示为「交付」");
has(APP, 'deliver: "交付节点（长周期任务 · 人工交付清单）"', "设置项用途说明到位");
has(CANVASJS, "window.LT.ui.deliverBody(node, body)", "buildBody 把交付节点的正文交给长任务模块渲染");
has(CANVASJS, "交付节点：长周期任务未就绪", "LT 不在时也有兜底文案（不渲染成空白节点）");
has(NODES, 'if (node.kind === "deliver") {', "playNodeBody 认得交付节点：它不可执行");
has(NODES, "window.LT.ui.open(true)", "在交付节点上点 ▶ = 展开条带处理这一环（绝不下落到通用文本执行链，那会拿空提示词白烧一次模型调用）");
has(CANVASCSS, ".wf-node.dlv", "主画布有 .dlv 配色（暖琥珀 = 这一环在等人）");
has(LIGHTCSS, "body.theme-light .wf-node.dlv", "浅色主题同口径");
has(LTV, 'LOCKED: ["deliver", "ltout", "ltart"]', "引擎导出 LOCKED 名单（交付 + 产出 + 产物；下面三份闸都读它）");
has(APP, "window.LT.LOCKED.indexOf(kind) >= 0 && !(extra && extra.__ltSystem)", "addNode：没有 __ltSystem 就建不出交付节点（需求 2：不能手动创建）");
has(APP, "window.LT.LOCKED.indexOf(src.kind) >= 0", "复制 / 粘贴：交付节点被丢掉（一个环节只有一个落点）");
has(NODES, "window.LT.LOCKED.indexOf(kind) >= 0", "canvas_edit 建图侧同样拒绝创建交付节点（智能体也不能手搓）");
has(LTV, "__ltSystem: true", "系统自己建交付节点时带上放行标记（三道闸只认这一个）");
{
  const side = APP.slice(APP.indexOf("const SIDE_CATS"), APP.indexOf("const SIDE_CATS") + 4000);
  hasnt(side, '"deliver"', "侧栏节点分类里没有它（看不见 = 加不了）");
  const drop = APP.slice(APP.indexOf("const WIRE_DROP_TARGETS"), APP.indexOf("const WIRE_DROP_TARGETS") + 2600);
  hasnt(drop, '"deliver"', "拖线落点候选里没有它");
  const menu = APP.slice(APP.indexOf("function canvasCreateMenuGroups"), APP.indexOf("function canvasCreateMenuGroups") + 3000);
  hasnt(menu, '"deliver"', "右键创建菜单里没有它");
}
has(HELP, "deliver:", "app-nodehelp 的 KIND_HELP 有它（? 按钮不说「暂无说明」）");
ok(fs.existsSync(path.join(ROOT, "guides/nodes/deliver.md")), "guides/nodes/deliver.md 存在（AGENTS：新增节点类型必须补指南）");
ok(fs.existsSync(path.join(ROOT, "guides/nodes/en/deliver.md")), "guides/nodes/en/deliver.md 存在（中英成对，切英文不空页）");
has(read("guides/nodes/index.json"), '"deliver"', "guides/nodes/index.json 登记 deliver");
has(read("guides/manual/index.json"), '"longtask"', "应用内手册目录有「长周期任务」一章");
ok(fs.existsSync(path.join(ROOT, "guides/manual/longtask.md")), "guides/manual/longtask.md 存在");
for (const k of ["交付节点（长周期任务 · 人工交付清单）", "交付节点由长周期任务自动创建，不能手动添加", "启用并绑定", "停用解绑"]) {
  has(I18N, '"' + k + '"', "i18n 有词条：" + k);
}

/* ═══════════════ [7] 设置全面下拉化（本轮：避免误填） ═══════════════ */
console.log("\n[7] 长任务设置：可搜索下拉 / 会话同源模型清单 / 用户不必手打状态键");
has(HTML, 'src="app-longtask-ctl.js"', "index.html 加载可搜索下拉控件工厂");
ok(
  HTML.indexOf('src="app-longtask-ctl.js"') < HTML.indexOf('src="app-longtask-ui.js"'),
  "加载顺序：控件工厂排在条带界面之前（检查器 / 设置窗从这里取控件）",
);
has(LTC, "window.LT.ui.ctl", "控件挂在 window.LT.ui.ctl（界面只认这一处入口）");
has(LTC, "function ltSelField(", "有单选可搜索下拉 ltSelField");
has(LTC, "function ltMultiSelField(", "有多选可搜索下拉 ltMultiSelField（状态键用）");
has(LTC, "lt-sel-in", "下拉自带过滤输入框（打字只用来搜索）");
has(LTC, "devAgentModelGroups(", "模型 / 服务商清单走会话同款真源 devAgentModelGroups()");
has(LTC, "AGENT_PRESETS", "预设清单走会话同款 AGENT_PRESETS");
has(LTC, "AGENT_EFFORT_UI_ORDER", "思考强度走会话同款 AGENT_EFFORT_UI_ORDER");
has(LTC, "lt-sel-new", "允许新建的字段走显式「＋ 新建」项（打字本身不提交）");
has(LTU, 'ltMultiSelField(box, ltT("生成类型"', "「生成类型」仍是下拉多选（多选工厂 ltMultiSelField 仍在用）");
hasnt(LTU, 'ltT("输入状态键")', "「输入状态键」不再出现在界面上（本轮撤掉：内部机制，暴露给用户也没法用）");
hasnt(LTU, 'ltT("输出状态键")', "「输出状态键」同样撤掉");
hasnt(LTU, 'ltT("逗号分隔 · 留空 = 自动看全部状态")', "回落路径的裸文本框也一并撤掉（不是只藏了下拉）");
has(LTU, 'ltSelField(box, ltT("取哪个状态键"', "output「取哪个状态键」是下拉");
has(LTU, 'ltSelField(box, ltT("展开哪个数组键"', "map「展开哪个数组键」是下拉（只列数组型键）");
has(LTU, 'ltSelField(box, ltT("回跳上限"', "人工任务「回跳上限」是下拉");
has(LTU, 'roundOpts = [{ value: "0", label: ltT("不限") }]', "「回跳上限」下拉第一档是「不限」（默认不回跳限制）");
has(LTU, 'num(ltT("驳回回跳上限"), "maxRound", 0, 9', "全局「驳回回跳上限」从 0 起（0 = 不限）");
has(LTV, "const LT_DEF_MAX_ROUND = 0;", "回跳默认不限制（LT_DEF_MAX_ROUND = 0）");
has(LTV, "function ltRoundCap(node)", "回跳上限走统一口径 ltRoundCap（0 = 不限）");
has(LTV, 'ltSetStat(run, o.path, "failed", { err: ltT("回跳已达上限（")', "用完回跳次数转「失败」（另一个状态），不再停成「需人工」");
hasnt(LTV, "if (round > maxRound)", "旧「超上限即转需人工」的死循环闸已移除");
has(LTU, 'ltSelField(box, ltT("重试次数"', "agent「重试次数」是下拉");
has(LTU, 'ltSelField(box, label,', "设置窗四个阈值也走同一个下拉工厂");
hasnt(LTU, 'type = "number"', "长任务设置里不再出现裸 input[type=number]（越界值填不进去）");
has(LTU, "const hProv = C.ltSelField(", "服务商 / 路由走可搜索下拉，不是裸文本框");
has(LTU, "inheritGraph: ltInheritGraph", "继承 / 自动填入导出为 window.LT.inheritGraph");
has(LTG, "window.LT.inheritGraph", "Agent 引导落库走同一份继承归一（落库即带上继承的模型 / 预设 / 思考强度与 uid）");

/* ═══════════════ [5] 引擎真行为（vm 里跑）+ [6] 条带口径 ═══════════════ */
async function main() {
  console.log("\n[5] 引擎：norm / validate / 清单进度 / 工具应答归属闸（真跑，不是 grep）");
  const replies = [];
  const sandbox = {
    window: { api: { dshInteract: (m) => replies.push(m) } },
    S: { wf: null, config: {} },
    I18n: { t: (s) => s },
    /* 条带界面脚本顶层只用到 document.readyState / addEventListener（不 boot、不建 DOM） */
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
  /* 条带界面脚本（app-longtask-ui.js）在 [8] 段才装进同一个沙箱（那里本来就要真跑 inheritGraph）：
     交付节点板身（md 表 / 端子行 / 已交区）的函数都在它里面，故板身那组断言排在 [8] 之后。 */
  const LT = sandbox.window.LT;
  ok(!!LT, "引擎脚本在沙箱里能整份执行并导出 window.LT（顶层不碰 DOM）");
  eqNum(LT.LOCKED.join(","), "deliver,ltout,ltart", "LOCKED 名单就是交付节点 + 产出节点 + 产物节点");
  ok(LT.NODE_KINDS.indexOf("sub") >= 0 && LT.NODE_KINDS.indexOf("map") >= 0, "节点族含子图与逐项并行（需求 1：子图 + 并行）");
  ok(LT.BREATH.running && LT.BREATH.waiting_delivery && LT.BREATH.blocked, "呼吸灯态：在跑的、等交付的、卡住的（需求 4：亮法区分状态）");
  const EMPTY = LT.norm({ nodes: [], edges: [] });
  ok(Array.isArray(EMPTY.nodes) && EMPTY.nodes.length === 0, "空图归一后还是空（不塞假节点）");
  const errs0 = LT.validate({ nodes: [], edges: [] }).filter((x) => x.level === "err");
  ok(errs0.length === 1 && /图是空的/.test(errs0[0].msg), "空图给一条 err，说清先加什么");
  const GOOD = {
    nodes: [
      { id: "s", kind: "start", title: "起点" },
      { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿子", outKeys: ["draft"] } },
      { id: "h", kind: "human", title: "审稿", cfg: { mode: "approve" } },
      { id: "e", kind: "end_ok", title: "收工" },
    ],
    edges: [{ from: "s", to: "a" }, { from: "a", to: "h" }, { from: "h", to: "e" }],
  };
  eqNum(LT.validate(GOOD).filter((x) => x.level === "err").length, 0, "一条干净的路径（起点→Agent→审批→成功终点）没有 err");
  const normed = LT.norm(GOOD);
  eqNum(normed.nodes.length, 4, "归一保留 4 个节点");
  eqNum(normed.edges.length, 3, "归一保留 3 条边");
  ok(normed.nodes.every((n) => n.cfg && typeof n.cfg === "object"), "每个节点都归一出 cfg（引擎读配置不用防 undefined）");
  eqNum(normed.nodes[1].cfg.goal, "写一版稿子", "归一不会把 Agent 的目标洗成空（曾经建空 node 再归一，整张图的参数全丢）");
  eqNum(normed.nodes[1].cfg.outKeys.join(","), "draft", "归一保住声明的输出键（工具写回按这份名单收口）");
  eqNum(normed.nodes[2].cfg.mode, "approve", "人工环节的模式不被默认值盖掉");
  ok(normed.nodes.every((n) => Number(n.x) >= 0 && Number(n.w) > 0), "坐标与尺寸给了缺省值（新建节点不会叠在原点看不见）");
  const BAD = { nodes: [{ id: "x", kind: "agent", title: "没人管", cfg: {} }], edges: [] };
  const b = LT.validate(BAD);
  ok(b.some((x) => /缺起点/.test(x.msg)), "缺起点报 err");
  ok(b.some((x) => /没有任何上游/.test(x.msg)), "孤岛节点报 err（永远跑不到）");
  ok(b.some((x) => /没写目标/.test(x.msg)), "Agent 环节没目标报 err（跑起来只会瞎转）");
  const MAP = {
    nodes: [
      { id: "s", kind: "start", title: "起点" },
      { id: "m", kind: "map", title: "逐项", cfg: { overKey: "" } },
      { id: "e", kind: "end_ok", title: "收工" },
    ],
    edges: [{ from: "s", to: "m" }, { from: "m", to: "e" }],
  };
  ok(LT.validate(MAP).some((x) => /overKey/.test(x.msg)), "map 没指定展开哪个数组键 → err（不然每次运行都是空转）");

  /* ── 逐项（map）展开源：状态机本身不再因为找不到数组而出错（本轮需求本体）──────────
   * 老口径：overKey 取不到数组 → `ltSetStat(..., "failed", "map 的 overKey 取不到数组")`，
   * 整条链断在这里。新口径：先按「命名空间链 → 上游声明的输出键 → 全 run（逐项实例排最后）」
   * 找一遍并把值归一成数组，只在「全场恰好一份数组」时自动接管；还是算不出来就**转等人**
   * （waiting_human + waits 卡片），用户改键 / 补上游 / 粘 JSON 后接着跑 —— 这一条失败路径整条撤掉。
   * 判据唯一真源在 LT.mapSource / LT.mapWaitPlan，回归全部真跑（不是 grep）。 */
  console.log("\n[5m] 逐项(map)展开源：查询 / 归一 / 自动接管的边界（真跑）");
  const mkMapNode = (over) => ({
    id: "m",
    kind: "map",
    title: "逐项",
    cfg: { overKey: over, itemKey: "item", maxItems: 16, outKeys: [], graph: { nodes: [], edges: [] } },
  });
  const mkProbeRun = () => ({ runId: "r-probe", wfId: "wf-probe", status: "running", ns: { "": {} }, nodes: {}, graph: { nodes: [], edges: [] }, inst: { "": { nodes: [], edges: [] } }, fired: {} });
  const runProbe = mkProbeRun();
  const mapN = mkMapNode("shot_list");
  const srcEmpty = LT.mapSource(runProbe, "", mapN);
  eqNum(srcEmpty.how, "none", "状态里没有这个键 → how=none（明确说「没有」，不是抛错）");
  ok(Array.isArray(srcEmpty.cands), "取不到时仍给出候选键表（用户不必自己去猜有哪些键）");
  eqNum(LT.mapItems(runProbe, "", mapN).length, 0, "取不到数组 → mapItems 给空数组（调用方转等人，不再判失败）");
  eqNum(LT.mapSource(runProbe, "", mkMapNode("")).how, "ask", "overKey 还是空的 → how=ask（要用户先指定展开哪个键）");
  /* 上游 Agent 的命名空间里写了 shot_list：链上的 map 看不见，全 run 兜底要能找回来 */
  const runProbe2 = mkProbeRun();
  runProbe2.ns["a"] = { shot_list: [{ n: 1 }, { n: 2 }, { n: 3 }] };
  const srcHit = LT.mapSource(runProbe2, "", mapN);
  eqNum(srcHit.how, "key", "声明的键在别的命名空间里有值 → how=key（直接命中，不改用户的选择）");
  eqNum(srcHit.usedKey, "shot_list", "用的还是用户声明的那个键名");
  eqNum(LT.mapItems(runProbe2, "", mapN).length, 3, "按真实条目数展开（3 项）");
  const narrowN = mkMapNode("shot_list");
  narrowN.cfg.maxItems = 2;
  eqNum(LT.mapItems(runProbe2, "", narrowN).length, 2, "maxItems 裁切生效（16 上限之外还能再收窄）");
  /* 键名对不上：全场恰好一份数组 → 自动接管；有两份就不许替用户选（必须转人工） */
  const runProbe3 = mkProbeRun();
  runProbe3.ns["a"] = { shots: [1, 2] };
  const srcAuto = LT.mapSource(runProbe3, "", mapN);
  eqNum(srcAuto.how, "auto", "声明的 shot_list 没有、全场只有 shots 一份数组 → how=auto（自动接管）");
  eqNum(srcAuto.usedKey, "shots", "自动接管用的是那一份真实存在的键");
  const runProbe4 = mkProbeRun();
  runProbe4.ns["a"] = { shots: [1, 2], other_list: [3] };
  ok(LT.mapSource(runProbe4, "", mapN).how !== "auto", "两份「像成批的东西」的数组都在 → 不再自动接管（不替用户猜，转人工）");
  const runProbe5 = mkProbeRun();
  runProbe5.ns["a"] = { shots: [1, 2], style: "noir" };
  ok(LT.mapSource(runProbe5, "", mapN).how === "auto", "另一份候选不是数组（标量文本）→ 仍然唯一确定，照常接管");
  /* 归一：数组 / JSON 字符串 / 对象包法 / 标量；字符串绝不按逗号切 */
  const co = LT.arrCoerce;
  eqNum(co([1, 2]).arr.length, 2, "真数组直接用");
  eqNum(co('[{"a":1}]').form, "json", "JSON 数组字符串解析成数组");
  eqNum(co('{"items":[1,2]}').arr.length, 2, "对象包法 {items:[…]} 取里面的数组");
  eqNum(co({ list: [1, 2, 3] }).arr.length, 3, "对象包法 {list:[…]} 同样认");
  eqNum(co("a,b").arr.join("|"), "a,b", "字符串按整串当**一个**条目（绝不按逗号切，切了下游拿到的是半句话）");
  eqNum(co("").arr.length, 0, "空串 = 取不到（不是「一个空条目」）");
  /* 就诊说明：缺什么 / 能改成什么 / 三种补救办法，三层都写清（真出卡的是「键名对不上」这条） */
  const runProbe6 = mkProbeRun();
  runProbe6.ns["a"] = { other_notes: "x", shots: [1, 2] };
  const plan = LT.mapWaitPlan(runProbe6, "", mapN);
  ok(/shot_list/.test(plan.text) && /shots/.test(plan.text), "就诊说明既写清缺的是哪个键，也列出能直接改用哪个键");
  ok(plan.usable.some((u) => u.key === "shots" && u.count === 2), "就诊说明里「现在能用的键」是引擎实测出来的（带条目数）");
  ok(!plan.usable.some((u) => u.key === "other_notes"), "候选项只列**真数组**（一段文本不会被说成「1 项」来忽悠用户）");
  ok(/不再判失败|重新查找并继续/.test(plan.text), "就诊说明明说「这一环不再判失败」并给出补救入口");
  ok((LT.mapWaitPlan(runProbe, "", mapN).keys || []).length === 0, "状态里一个键都没有时候选表为空（不编造候选）");
  hasnt(LTV, 'ltT("map 的 overKey 取不到数组：")', "引擎：老失败文案整条撤掉（那条失败路径不再存在）");
  const pr = LT.itemsProgress([
    { title: "定稿", required: true, done: true },
    { title: "配图", required: true, done: false },
    { title: "备选封面", required: false, done: false },
  ]);
  eqNum(pr.need, 2, "必填项只数 required !== false 的两条");
  eqNum(pr.done, 1, "已交付一条");
  ok(pr.ready === false, "必填没交齐 → 不许放行");
  eqNum(pr.opt, 1, "选填单列，不参与放行判定");
  eqNum(LT.itemsProgress([{ required: true, done: true }]).ready, true, "必填全交齐 → ready 为真（仍需人点确认）");

  /* ── 交付节点端子契约（本轮本体）：一个未交文件项 = 一个仅输入端子 ──────────────
     端子标签 = 文件名；交掉后该端子消失、其余端子按序重排；已连的线按文件项 id 重绑
     （不是按端子号漂移）。这里把真源函数装进沙箱挨个验，不是 grep。 */
  console.log("\n[5a] 交付节点：一个未交文件 = 一个端子（端子标签=文件名 · 交掉即消失 · 线按 id 重绑）");
  const mkD = (items) => ({ id: "d1", kind: "deliver", ltItems: JSON.parse(JSON.stringify(items)), ltUid: "ltx-交稿", ltPath: "h1" });
  const I1 = { id: "i1", kind: "file", title: "分镜表.md", desc: "每镜头一行", accept: "仅 .md · ≤ 2 MB", required: true, done: false, paths: [] };
  const I2 = { id: "i2", kind: "file", title: "角色设定.md", desc: "人物小传", accept: "", required: true, done: false, paths: [] };
  const I3 = { id: "i3", kind: "text", title: "风格说明", required: true, done: false, value: "" };
  const dnode = mkD([I1, I2, I3]);
  eqNum(LT.deliverPendingItems(dnode).length, 2, "文本类条目不占端子：3 条清单（2 文件 + 1 文本）→ 2 个端子");
  eqNum((LT.deliverPortItem(dnode, 0) || {}).title, "分镜表.md", "0 号端子的标签就是它对应的文件名");
  eqNum((LT.deliverPortItem(dnode, 1) || {}).title, "角色设定.md", "1 号端子对应第二个未交文件");
  ok(LT.deliverPortItem(dnode, 2) === null, "端子号落空时返回 null（调用方不会拿到错位的文件项）");
  /* 线按 id 重绑：i1 交掉后 i2 从 1 号端子移到 0 号，线跟着走 */
  const wf0 = { nodes: [dnode], wires: [{ id: "w1", from: "s1", to: "d1", toIndex: 1, ltItem: "i2" }] };
  dnode.ltItems[0].done = true;
  dnode.ltItems[0].paths = ["D:\\ws\\mtnode-deliverables\\ltx\\分镜表.md"];
  eqNum(LT.deliverPendingItems(dnode).length, 1, "交掉的文件项不再占端子（端子消失）");
  LT.deliverRebindWires(dnode, wf0);
  eqNum(wf0.wires.length, 1, "另一条线还在（只重绑，不乱删）");
  eqNum(wf0.wires[0].toIndex, 0, "端子重排后，i2 的线从 1 号跟着移到 0 号（按 id 重绑）");
  const dnode2 = mkD([I1, I2, I3]);
  const wf1 = { nodes: [dnode2], wires: [{ id: "w1", from: "s1", to: "d1", toIndex: 0, ltItem: "i1" }, { id: "w2", from: "s2", to: "d1", toIndex: 1, ltItem: "i2" }] };
  dnode2.ltItems[0].done = true;
  LT.deliverRebindWires(dnode2, wf1);
  eqNum(wf1.wires.length, 1, "交掉的那一项的线随端子一起消失（q14：上传覆盖连线）");
  eqNum(wf1.wires[0].id, "w2", "留下的是另一项（i2）的线，没有被误删");
  eqNum(wf1.wires[0].toIndex, 0, "留下的线跟着端子重排到 0 号");
  /* 旧档（线没有 ltItem 归属）按当时占的端子号认领一次 */
  const dnode3 = mkD([I1, I2]);
  const wf2 = { nodes: [dnode3], wires: [{ id: "w1", from: "s1", to: "d1", toIndex: 1 }] };
  LT.deliverRebindWires(dnode3, wf2);
  eqNum(wf2.wires[0].ltItem, "i2", "旧档补上归属：1 号端子上的线认领当时那颗文件项");
  /* 撤回：端子回来，线跟着回到它原本的位置 */
  dnode3.ltItems[1].done = true;
  LT.deliverRebindWires(dnode3, wf2);
  eqNum(wf2.wires.length, 0, "已交项的线随端子消失");
  dnode3.ltItems[1].done = false;
  dnode3.ltItems[1].paths = [];
  LT.deliverRebindWires(dnode3, wf2);
  eqNum(LT.deliverPendingItems(dnode3).length, 2, "撤回后端子放回来（清单回到两项）");
  /* 连线收文件：只有「该端子真有线」的项才算已交 */
  const dnode4 = mkD([I1, I2]);
  const filled = LT.deliverCollectWired(dnode4, [
    { index: 0, src: { id: "s1", kind: "input_file", files: [{ path: "D:\\in\\分镜表.md" }] } },
  ]);
  eqNum(filled, 1, "0 号端子上有线 → 该文件项记为已交");
  eqNum(dnode4.ltItems[0].done, true, "连线收下的项 done=true（页面上那条端子消失）");
  eqNum(dnode4.ltItems[1].done, false, "没有线的项一律留给用户上传（不凭空当成交了）");
  has(LTV, 'it.deliveredVia = ltT("连线")', "连线交付在清单里标注来源=连线（与人上传区分得开）");
  replies.length = 0;
  await LT.handleToolEvent({ id: "f1", action: "stateRead", params: {} }, { id: "node_plain" }, null);
  eqNum(replies.length, 1, "普通节点来的 lt 帧也被应答（不能让它悬着等超时）");
  eqNum(replies[0].kind, "lt", "回帧 kind = lt（网关按 kind 找回挂起的 socket）");
  eqNum(replies[0].id, "f1", "回帧带回原 id");
  ok(!!replies[0].error, "非长任务轮：回的是错误，不是状态内容（越权读不到任何东西）");
  replies.length = 0;
  await LT.handleToolEvent({ id: "f2", action: "stateWrite", params: { patch: { draft: "偷写" } } }, { id: "ltr_r1_a" }, null);
  ok(replies.length === 1 && !!replies[0].error, "伪节点 id 但找不到对应 run：同样回错误（不假装成功）");
  replies.length = 0;
  await LT.handleToolEvent({ action: "stateRead", params: {} }, { id: "node_plain" }, null);
  eqNum(replies.length, 0, "没有 id 的帧不回话（网关无从对账，回也是垃圾）");

  /* ── 人工驳回之后不许停成 stalled（本轮修的真 bug）─────────────────────
     旧版 ltRewind 把「从回跳集外指进来」的点火（start → 目标）也一并撤掉，目标环节再也
     ready 不了，被 ltSkipUnreachable 整片标成 skipped，run 收成 stalled。 */
  console.log("\n[5b] 人工驳回：回跳后目标环节还能重新起跑（不再卡成 stalled）");
  has(LTV, "if (keep[e.from]) delete run.fired[e.id];", "回跳只撤「集内」边的点火（集外入边保留 = 回跳集唯一的起跑入口）");
  has(LTV, "function ltRearmSkipped(run)", "旧版卡住现场有救援口 ltRearmSkipped");
  has(LTV, "if (ltWouldStall(run)) {", "「继续」时只在确实无事可跑（stalled 判据）才补点火");
  const RW = LT.norm({
    nodes: [
      { id: "start", kind: "start", title: "起点" },
      { id: "a", kind: "agent", title: "起草", cfg: { goal: "写稿", outKeys: ["draft"] } },
      { id: "h", kind: "human", title: "审稿", cfg: { mode: "approve", backTo: "a" } },
      { id: "e", kind: "end_ok", title: "收工" },
    ],
    edges: [
      { id: "e1", from: "start", to: "a" },
      { id: "e2", from: "a", to: "h" },
      { id: "e3", from: "h", to: "e" },
    ],
  });
  const mkRun = () => {
    const r = {
      runId: "r-rewind", taskId: "t-rw", graph: JSON.parse(JSON.stringify(RW)),
      nodes: {}, ns: {}, fired: {}, inst: {}, waits: [], rounds: {}, booted: true, opts: {}, status: "running", log: [],
    };
    sandbox.ltInst(r, "", r.graph);
    for (const p of Object.keys(r.nodes)) r.nodes[p].status = "pending";
    r.nodes.start.status = "done";
    r.nodes.a.status = "done";
    r.fired = { e1: 1, e2: 1 };
    sandbox.ltSetStat(r, "h", "waiting_human");
    sandbox.ltPushWait(r, "h", "approve", { title: "审稿" });
    return r;
  };
  const runRW = mkRun();
  eqNum(LT.rewind(runRW, "a"), 3, "驳回回跳：目标 + 下游共 3 个环节被重置");
  eqNum(runRW.fired.e1, 1, "集外入边（start → 目标）的点火保留 —— 这就是回跳后重新起跑的口子");
  ok(!runRW.fired.e2, "集内边（目标 → 下游）的点火被撤掉：源会重跑，跑完自己重新点火");
  eqNum(runRW.nodes.h.status, "pending", "驳回环节本身回到 pending（可以再次等人）");
  ok(LT.allReady(runRW).indexOf("a") >= 0, "驳回后目标环节立刻 ready（旧版这里是空的）");
  eqNum(sandbox.ltSkipUnreachable(runRW), 0, "没有节点被误标 skipped（旧版整条链 10 个全被跳过）");
  ok(!Object.keys(runRW.nodes).some((p) => runRW.nodes[p].status === "skipped"), "全图没有一个环节停在 skipped");
  /* 旧版已经卡死的现场：全 skipped + fired 空 —— 点「继续」时靠救援口救回来 */
  const runOld = mkRun();
  for (const p of Object.keys(runOld.nodes)) runOld.nodes[p].status = "skipped";
  runOld.nodes.start.status = "done";
  runOld.fired = {};
  ok(LT.wouldStall(runOld) === true, "整片 skipped 的旧现场被判成「无事可跑」（stalled 判据）");
  ok(LT.rearmSkipped(runOld) >= 3, "救援口把被跳过的环节重新排回 pending");
  eqNum(runOld.fired.e1, 1, "只补「起点节点的无条件出边」点火（不碰 fork 的条件分支）");
  ok(LT.allReady(runOld).indexOf("a") >= 0, "旧现场补完点火后目标环节重新 ready（按「继续」真的能接着跑）");
  eqNum(sandbox.ltSkipUnreachable(runOld), 0, "补完点火后不再被标 skipped（幂等：真跳过的分支下一轮才回收）");

  /* ── [5c] 输出键没写回：内部纠错先补问，补不齐才判失败 ────────────────────
     真机现场：某个长任务环节跑完却报「⚠ 环节未完成：未写回声明的输出键：script_path,
     shot_list, asset_note」—— 活干完了、文件也落了，只是没把键写回状态，整串下游因此
     拿不到东西。现在缺键不立刻判死：先在同一条 dsh 会话里追加一段「只补写回、不要重做
     任务」的指令重问（最多 LT_OUTKEY_FIX_ROUNDS 轮），每轮都重跑一次结构化回收，
     仍缺才判失败。这里真跑纠错循环（沙箱里注入假 dshRunTask），不是 grep。 */
  console.log("\n[5c] 输出键的内部纠错：缺键先补问、补不齐才判失败（真跑）");
  {
    const fixNode = () => ({
      kind: "agent",
      title: "分镜",
      cfg: { goal: "写分镜并落盘", outKeys: ["script_path", "shot_list", "asset_note"] },
    });
    const fixRun = () => ({
      runId: "r-fix", taskId: "t-fix", graph: { nodes: [], edges: [] },
      nodes: {}, ns: {}, fired: {}, inst: {}, waits: [], rounds: {}, opts: {},
      status: "running", aborted: false, log: [],
    });
    const calls = [];
    let writeBack = true;
    sandbox.dshRunTask = async (input, opts) => {
      calls.push({ input: String(input), opts: opts || {} });
      if (!writeBack) return "已经做完了，没有要补的。";
      return (
        "补好了。\n```json\n" +
        '{ "script_path": "assets/script.md", "shot_list": ["s1"], "asset_note": "三镜头" }\n' +
        "```\n"
      );
    };
    const node1 = fixNode();
    const run1 = fixRun();
    run1.arts = { a: ["E:\\ws\\assets\\script.md"] };
    eqNum(
      LT.recoverOutKeys(run1, "a", node1, "我干完了，但没给 json 块。").join(","),
      "script_path,shot_list,asset_note",
      "首轮回收：没有 json 块 → 三个声明键全缺（判据只有一份）",
    );
    const fx1 = await LT.fixMissingOutKeys(
      run1, "a", node1, ["script_path", "shot_list", "asset_note"], "首轮正文",
      { runKey: "ltr_rfix_a", resumeSession: "sid-1", onEvent() {} },
    );
    eqNum(calls.length, 1, "缺键触发一次纠错重问（不再「一次没写回就判失败」）");
    eqNum(calls[0].opts.resumeSession, "sid-1", "纠错轮点在跑的同一条 dsh 会话上续（模型还记得自己刚干了什么）");
    eqNum(calls[0].opts.keepTrace, true, "纠错轮 keepTrace：首轮正文不从运行轨迹里被抹掉");
    has(calls[0].input, "script_path, shot_list, asset_note", "纠错指令点名缺的键");
    has(calls[0].input, "不要重做任务", "纠错指令明说「只补写回、不要重做任务」");
    has(calls[0].input, "write", "纠错指令给出 lt_state write 的写法");
    has(calls[0].input, "E:\\ws\\assets\\script.md", "已登记的产物文件摆进纠错指令（路径类键从这里取，不靠模型编）");
    eqNum(fx1.missing.length, 0, "纠错轮把键补齐 → missing 清空（这一环照常跑完，不再假失败）");
    eqNum(run1.ns.a.script_path, "assets/script.md", "补齐的键真的落进本环节命名空间");
    ok(fx1.missing.join(",") === "" && fx1.aborted === false, "返回值口径：{ text, missing, aborted }");
    has(fx1.text, "【自动纠错 · 补写回】", "纠错那一轮的正文并进本环节正文（可回看，不悄悄吞掉）");
    ok(run1.log.some((l) => /自动纠错/.test(l.text || "")), "纠错过程写进条带日志（用户看得见发生了什么）");
    writeBack = false;
    const run2 = fixRun();
    calls.length = 0;
    const node2 = { kind: "agent", title: "分镜", cfg: { goal: "写分镜", outKeys: ["script_path"] } };
    const fx2 = await LT.fixMissingOutKeys(
      run2, "a", node2, ["script_path"], "首轮正文",
      { runKey: "ltr_rfix2_a", resumeSession: "sid-2", onEvent() {} },
    );
    eqNum(calls.length, LT.outkeyFixRounds, "补不齐时最多纠错 " + LT.outkeyFixRounds + " 轮（不无限重问烧钱）");
    eqNum(fx2.missing.join(","), "script_path", "补不齐 → missing 仍非空，交给调用方按原口径判失败");
    const run3 = fixRun();
    run3.aborted = true;
    const fx3 = await LT.fixMissingOutKeys(
      run3, "a", fixNode(), ["shot_list"], "首轮正文",
      { runKey: "ltr_rfix3_a", resumeSession: "sid-3", onEvent() {} },
    );
    eqNum(fx3.aborted, true, "用户中途按停 → aborted=true，调用方按「已手动停止」收口（不判失败）");
    /* 续不上就退回独立重问：会话日志没了（RESUME_UNAVAILABLE）不能把「缺键」升级成硬错误。 */
    sandbox.dshResumeUnavailable = (m) => /RESUME_UNAVAILABLE/.test(String(m));
    const seenSids = [];
    let firstShot = true;
    sandbox.dshRunTask = async (input, opts) => {
      seenSids.push(String((opts && opts.resumeSession) || ""));
      if (firstShot) {
        firstShot = false;
        throw new Error("RESUME_UNAVAILABLE: no such session on this machine");
      }
      return '补好了。\n```json\n{ "shot_list": ["s1"] }\n```\n';
    };
    const run4 = fixRun();
    const fx4 = await LT.fixMissingOutKeys(
      run4, "a", { kind: "agent", title: "分镜", cfg: { goal: "写分镜", outKeys: ["shot_list"] } }, ["shot_list"], "首轮",
      { runKey: "ltr_rfix4_a", resumeSession: "sid-4", onEvent() {} },
    );
    eqNum(seenSids.join("|"), "sid-4|", "首枪点 sid-4 续跑，会话不可续跑时第二枪不带 resumeSession（独立重问）");
    eqNum(fx4.missing.length, 0, "退回独立重问后补齐 → 不因为「续不上」把缺键升级成硬错误");
    delete sandbox.dshResumeUnavailable;
    /* 接线口径：引擎主流程必须真的走这条纠错，而不是只留一个没人调的函数。 */
    has(LTV, "let missing = ltRecoverOutKeys(run, path, node, text);", "主流程用同一份回收判据算缺键");
    has(LTV, "const fx = await ltFixMissingOutKeys(", "主流程缺键后调纠错（不是直接判失败）");
    has(LTV, "resumeSession: runSid || undefined", "纠错点名本轮真正落地的 dsh session id（session 帧自留一份）");
    has(LTV, "if (type === \"session\" && data && data.sessionId) runSid = String(data.sessionId);", "onEvent 里自留 session id（dshRunTask 成功收尾会清掉登记表）");
    hasnt(LTV, "const missing = Array.from(allow).filter", "旧版「一次回收就判失败」的硬判据已被纠错流程取代");
    has(LTV, "LT_OUTKEY_FIX_ROUNDS = 2", "纠错轮数是钉死的常量（不是随手写死的魔法数）");
    has(LTV, "dshResumeUnavailable", "会话不可续跑时退回独立重问（不让「续不上」长出新故障点）");
    hasnt(LTV, "while (true)", "纠错不会写无限循环（有明确轮数上限）");
    /* i18n：纠错日志 / 条带 / 判失败文案都有 EN 译文（切英文不出现中文半截） */
    const I17 = require("../renderer/i18n.js");
    const keys17 = [
      "未写回声明的输出键：", "没写回输出键，判失败", "未写回输出键：",
      "自动纠错 ", "；自动补写回中 ", "纠错轮出错：", "【自动纠错 · 补写回】",
    ];
    I17.setLocale("en");
    const miss17 = keys17.filter((k) => I17.t(k) === k);
    eqNum(miss17.length, 0, "i18n 中英词条齐备（纠错文案都有 EN 译文）" + (miss17.length ? "（缺：" + miss17.join(" / ") + "）" : ""));
    I17.setLocale("zh");
    for (const k of keys17) has(I18N, '"' + k + '":', "i18n 源文件里有「" + k + "」的 EN 词条");
  }

  console.log("\n[6] 条带：运行时挂载 / 拖拽阈值 / 呼吸灯 / 重启不自动重跑 / 对话框纪律");
  has(LTU, 'strip.id = "ltStrip"', "条带在运行时建出来（不往 index.html 塞静态 DOM）");
  has(LTU, 'wrap.insertBefore(strip, wrap.firstChild)', "插到 .wf-wrap 最前面 = 页签与画布上方那根细线（不动 #wfTabs 的 DOM）");
  has(LTU, 'document.getElementById("ltStrip")) return', "挂载幂等（重复 boot 不会叠出两条）");
  has(LTU, "window.renderCanvas = wrapped", "包一层 renderCanvas 同步条带（切画布 / 改图 / 跑节点都会重绘）");
  has(LTU, "if (dy < 8) return;", "往下拖过 8px 才算展开（不误触）");
  has(LTU, "ltClampH", "展开高度夹在安全区间（不会被拖没、也不会拖满盖住画布）");
  /* 细线往下拖的口径：上限必须是「此刻窗口真实放得下多少」，不是写死的 900。
     旧版写死 900 + 画布咬着 min-height:360，窗口一矮就把 tabs / 画布 / 底部状态栏一起顶出屏幕。 */
  has(LTU, "ltBodyMaxH", "展开上限按实测剩余空间夹（上限 = 画布 tabs 贴住 .wf-wrap 下沿、画布归零）");
  has(LTU, 'wrap.classList.toggle("lt-open"', "展开时给 .wf-wrap 打 lt-open（放开画布 min-height）");
  has(LTU, "new ResizeObserver", "窗口 / 画布区域一变就重夹条带高度（矮下去也不把 tabs 顶出下沿）");
  has(LTCSS, ".wf-wrap.lt-open .fn-canvas", "展开态放开 .fn-canvas 的 360px 下限（画布可被一路压成 0 高）");
  hasnt(LTCSS, "max-height: 900px", "条带高度不再写死 900px 上限（改按窗口实测夹）");
  has(LTV, "h: Math.max(180, Number(c.h) || 320)", "配置存的是用户设定值，上限交给实测夹（不写死）");
  has(LTU, 'grip.addEventListener("dblclick"', "双击细线即开合（不想拖的时候）");
  has(LTU, "ltCfgPatch({ open", "开合仍写回全局配置（没记过的画布用它当兜底）");
  /* 需求 1：分割线位置**按画布记** —— 与相机 / 任务焦点同一份视图记忆（S.wfViews[wfId]）。 */
  has(LTU, "ltViewPatch(LT_LAST_WF_OBJ", "细线落盘按当前画布（不走跨画布共享的全局值）");
  has(LTU, "S.wfViews", "记忆挂在 S.wfViews（与 app.js 的画布视图记忆同址，切 Tab 各回各的）");
  has(LTU, "{ ltH: h, ltOpen: open }", "一张画布记一份高度 + 开合");
  has(LTU, "ltHFor(wf)", "换画布时读回**本画布**记下的高度");
  has(LTU, "ltOpenFor(wf)", "开合同样按画布读回");
  has(LTU, "ltSetOpen(ltOpenFor(wf))", "ltStripSync 切画布时先按新画布摆好再渲染（顺序不能反）");
  has(LTV, "S.config.longtask", "全局配置仍保留（没记过的画布 / 老用户的兜底口径）");
  has(LTCSS, ".lt-grip", "细线样式在（头发丝 + hover 高亮）");
  has(LTCSS, ".lt-grip:hover", "鼠标放上去会亮（需求 4：悬停高亮）");
  /* 细线的三条本轮口径：收窄上下空隙 / 拖到下方不改色 / 运行时按状态呼吸。 */
  has(LTCSS, "margin: -6px 0 -6px", "条带用负外边距收窄细线与上下的空隙");
  hasnt(LTCSS, ".lt-strip.open .lt-grip", "展开（拖到下方）不再换色：颜色只由运行状态决定");
  has(LTU, "ltGripSync", "收起态也同步细线状态（它在早退之前跑）");
  has(LTU, "lt-grip-s-", "细线按运行状态挂状态类（run / wait / fail / ok）");
  has(LTCSS, ".lt-grip-s-run", "细线运行中高亮（橙）");
  has(LTCSS, ".lt-grip-s-wait", "细线等你处理高亮（黄）");
  has(LTCSS, ".lt-grip-s-fail", "细线卡住 / 失败高亮（红）");
  has(LTCSS, ".lt-grip-s-ok", "细线跑完高亮（绿，常亮不闪）");
  has(LTCSS, "@keyframes ltGripBreath", "细线的呼吸灯关键帧在（沿用 --lt-glow 口径）");
  has(LTCSS, "--lt-glow", "呼吸灯用 --lt-glow 的 RGB 三元组（沿用 devRunBreathe 口径）");
  has(LTCSS, "@keyframes ltBreath", "呼吸灯关键帧在");
  has(LTCSS, "ltBreathSel", "选中态呼吸更亮（一眼看出哪块是你正在弄的）");
  has(LTCSS, "ltEdgeFlow", "已走过的连线有流动动画（看图就知道跑到哪了）");
  has(LTCSS, "body.theme-light", "浅色主题有一整套覆盖（不只是深色能看）");
  for (const s of ["running", "waiting_human", "waiting_delivery", "blocked"]) {
    ok(new RegExp("lt-s-" + s).test(LTCSS), "态样式齐全：lt-s-" + s);
  }
  has(LTV, "已中断（应用重启或任务停止）", "重启后 running 态一律降级为「已中断」（绝不自动重跑烧 token）");
  has(LTV, "JSON.parse(JSON.stringify(task.graph))", "启用时给 run 拍整张图的快照（之后改图不影响在跑的这次）");
  has(LTV, "setTimeout(go, 220)", "落盘节流 220ms（连改十下不写十次盘）");
  has(LTV, 'indexOf("ltr_") !== 0', "伪节点 id 前缀判定与实际生成的 id 一致（工具应答找得回 run）");
  has(LTV, "越权写入被拒绝", "写没声明的输出键直接回错误文本");
  hasnt(LTV, "ltSyncFactLibToMemory", "长期记忆与专家团事实库不再双向同步（事实库 → 记忆那条链路已收掉）");
  hasnt(LTV, "ltSyncMemoryToFactLib", "长期记忆与专家团事实库不再双向同步（记忆 → 事实库文档那条链路已收掉）");
  has(LTV, "团队事实库\\AI\\ai-facts.json", "长期记忆与 AI 事实库合并成一份存储：<画布文件夹>\\团队事实库\\AI\\ai-facts.json");
  has(LTU, "ui: {", "界面把自己的入口挂在 window.LT.ui 上（app-canvas 只认这一处）");
  hasnt(LTU, "prompt(", "条带不用原生 prompt（对话框纪律：输入要有落点）");
  hasnt(LTU, "confirm(", "条带不用原生 confirm");
  hasnt(LTU, "alert(", "条带不用原生 alert");
  hasnt(LTU, "ev.target === host", "没有「点宿主即关」的浮层（AGENTS：设置浮层必须 persistent）");
  /* 长任务这几只 persistent 弹窗必须有显式关闭路径：openOverlay 的窗壳标题栏只有
     「最小化」、没有通用 ✕，#overlay 也没有 Esc 兜底 —— 不在 #ovFoot 补一颗关闭按钮，
     窗就「开得出来、关不回去」（设置窗曾因此完全关不掉，本轮 bug）。 */
  has(LTU, "function ltFootClose(", "有统一的 ltFootClose：往 #ovFoot 补一颗显式关闭按钮");
  {
    const seg = (name, next) => LTU.slice(LTU.indexOf("function " + name + "("), LTU.indexOf(next));
    has(seg("ltSettingsDlg", "function ltMemoryDlg("), 'ltFootClose("完成并关闭"', "设置窗有「完成并关闭」（本轮 bug：原先没有任何关闭路径）");
    has(seg("ltRunsDlg", "async function ltOrphanDlg("), "ltFootClose()", "历史 run 窗有关闭按钮");
    has(seg("ltOrphanDlg", "function ltSettingsDlg("), "ltFootClose()", "交付目录体检窗有关闭按钮");
    has(seg("ltProblemsDlg", "交付节点在主画布上的 body 渲染"), "ltFootClose()", "图校验问题窗有关闭按钮");
  }
  hasnt(LTV, "mtnode_canvas_edit", "引擎不碰建图工具（读画布走既有 canvas 只读快照，不写画布）");

  /* ── [9] 删除长任务（条带右上角 · 必须弹确认）+ [10] 画布与主画布同款点阵 / 吸附 ── */
  console.log("\n[9] 删除长任务：右上角入口 / 弹窗确认 / 一次收干净（run + 交付节点 + 历史记录）");
  {
    /* 注意：上面已有一个模块级 const head，这里换个名字，别在块里重名。
       「删除任务」本轮起不再平铺在头部，而是收进「⋯ 更多」下拉（头部按钮收纳）：
       所以断言改成「头部挂着那颗更多按钮 + 更多菜单里就是删除的落点」，
       不再钉固定的字符距离（那种断言会被无关的排版改动误伤）。 */
    const headSeg = LTU.slice(LTU.indexOf("function ltRenderHead("), LTU.indexOf("function ltConfirmDeleteTask("));
    has(headSeg, "ltMoreBtn(wf, task)", "头部挂着「⋯ 更多」按钮（不常用的手动操作都收进它）");
    const moreSeg = LTU.slice(LTU.indexOf("function ltMoreBtn("), LTU.indexOf("function ltOpenEditDlg("));
    has(moreSeg, 'ltT("🗑 删除任务")', "「⋯ 更多」菜单里有删除任务");
    has(moreSeg, '"lt-btn-del"', "它是危险配色（红框），与启用 / 停用 / 记忆 一眼区分");
    has(moreSeg, "on: () => ltConfirmDeleteTask(wf)", "菜单项点下去仍走同一个确认口（逻辑不双写）");
    has(LTU, "function ltConfirmDeleteTask(", "有独立确认口 ltConfirmDeleteTask");
    has(LTU, "await confirmDialog(", "删除走通用 confirmDialog（不是原生 confirm）");
    has(LTU, "danger: true", "确认框按危险操作上色");
    has(LTU, 'okText: ltT("删除")', "确认框的确定键写「删除」而不是含糊的「确定」");
    has(LTU, 'cancelText: ltT("取消")', "确认框有显式取消键");
    has(LTU, "交付目录里的文件不会被删", "确认文案写明不动交付目录里的文件（与体检只报告同口径）");
    has(LTU, 'ltT("这张画布没有可删除的长任务")', "没任务时给提示，不是静默什么都不做");
    has(LTU, "ltConfirmDeleteTask(wf, sel.value)", "设置窗里那张任务下拉也能删（同一个落点，不双写逻辑）");
    has(LTV, "async function ltDeleteTask(", "引擎有 ltDeleteTask（删除逻辑不在 UI 层）");
    has(LTV, "deleteTask: ltDeleteTask", "window.LT 导出 deleteTask");
    has(LTV, "run.aborted = true", "删除时先停正在跑的 run（与「■ 停止」同一条中断口径，不另造一套）");
    has(LTV, 'n.kind === "deliver"', "收走本任务在主画布上的交付节点（任务没了它就没有宿主）");
    has(LTV, "window.api.ltRunDelete(wf.id, runId)", "历史 run 记录一并删（不留点不开的孤儿）");
    has(LTV, "wf.longtask.tasks = tasks.filter(", "任务条目从 wf.longtask.tasks 里摘掉");
    has(LTV, "wf.longtask.active = first ? first.uid : \"\"", "active 让给剩下的任务（或清空），不留悬空指针");
    {
      const body = LTV.slice(LTV.indexOf("async function ltDeleteTask("), LTV.indexOf("function ltCurrentRun("));
      hasnt(body, "rm(", "删除任务不删用户文件（交付目录里的东西不动）");
      hasnt(body, "unlink", "删除任务不 unlink 用户文件");
      hasnt(body, "rmdir", "删除任务不 rmdir 用户目录");
    }
  }

  /* ── [9b] 本次需求：条带头的新口径（模型 chip 可点开 / 启用并绑定上移到右端 / 强行推进挂载）──
     三处都在同一条 headSeg 上，钉住位置而非字符距离，免得被无关排版改动误伤。 */
  console.log("\n[9b] 条带头：模型 chip 可点开 · 「▶ 启用并绑定」在右端 · 「⏭ 强行进入下一状态」挂载");
  {
    const headSeg = LTU.slice(LTU.indexOf("function ltRenderHead("), LTU.indexOf("function ltConfirmDeleteTask("));
    has(headSeg, 'ltT("▶ 启用并绑定")', "「开始长任务」不再埋在「⋯ 更多」：右端常驻「▶ 启用并绑定」");
    has(headSeg, "ltEnable(wf, task.uid, {})", "它的落点就是引擎的 ltEnable（与「⋯ 更多」那颗同一处逻辑，不双写）");
    ok(
      headSeg.indexOf('ltEl("div", "lt-spacer")') < headSeg.indexOf('ltT("▶ 启用并绑定")') &&
        headSeg.indexOf('ltT("▶ 启用并绑定")') < headSeg.indexOf('ltT("⚙")'),
      "位置口径：lt-spacer 之后、⚙ 之前（右端一组）",
    );
    has(headSeg, "runLive", "run 还活着（正在跑 / 停在等人）时让位（不顶掉用户手里那条 run）");
    has(headSeg, "ltForceAdvanceBtn(wf, run)", "run 停在手上时露出「⏭ 强行进入下一状态」（run 级统一出路）");
    has(headSeg, 'chip.setAttribute("data-lt-menu", "lt-model")', "模型 chip 可点开（锚点身份写在 data-lt-menu 上，头部重建后认回来）");
    has(headSeg, "ltAgentPanelOpen(wf, chip)", "点 chip 开四格选型面板（控件与清单复用 ctl 那一份）");
    has(LTV, "forceAdvance: ltForceAdvance,", "window.LT 挂载 forceAdvance（界面施加动作的唯一落点）");
    has(LTV, "autoRepairGraph: ltAutoRepairGraph,", "window.LT 挂载 autoRepairGraph（结论性图问题就地补好，不再拦住开始）");
    has(LTCSS, ".lt-btn-force", "「⏭ 强行进入下一状态」有独立配色（与「▶ 继续」区分开）");
    has(LTCSS, ".lt-mdl", "模型选型面板的样式在同一份样式表");
  }

  console.log("\n[10] 长任务画布：与主画布同款点阵网格 · 落点与长宽都吸附网格");
  has(LTV, "function ltGrid()", "引擎有网格间距 ltGrid（与主画布同口径）");
  has(LTV, "S.config.snap", "间距取用户设置 S.config.snap（不自己存一份可调值）");
  has(LTV, "function ltSnap(v)", "引擎有吸附函数 ltSnap");
  has(LTV, "grid: ltGrid,", "window.LT 导出 grid");
  has(LTV, 'snap: ltSnap,', "window.LT 导出 snap");
  has(CANVASCSS, "--grid-size", "主画布的点阵间距走 --grid-size（长任务照抄这条口径）");
  has(LTU, "function ltGraphGridSync(", "条带有 ltGraphGridSync：按吸附步长同步点阵间距");
  has(LTU, "ltGraphGridSync(holder, svg, g)", "每次画图都同步一次（改 snap / 换图后点阵不过期）");
  has(LTU, 'setProperty("--lt-grid"', "点阵间距写进 .lt-graph 的 --lt-grid");
  has(LTU, 'Math.round(grid * k)', "间距按 viewBox 缩放系数乘回去（图被放大时不压缩点阵，才是真的对齐）");
  has(LTU, "function ltGraphViewBox(", "包围盒 viewBox 抽成函数（渲染与拖动共用同一份）");
  has(LTU, "function ltGraphViewBoxOf(", "拖动时用同一份 viewBox 反算缩放（不再读 svg 上的旧属性）");
  has(LTCSS, "radial-gradient(circle at 1px 1px, rgba(122, 138, 146, .16) 1px, transparent 1.5px)", "点阵的写法与主画布 .fn-canvas 逐字同源（点径 / 颜色 / 圆角一致）");
  has(LTCSS, "linear-gradient(180deg, var(--bg), var(--bg2))", "底色也是主画布那层 --bg → --bg2");
  has(LTCSS, "border-radius: 4px", ".lt-graph 圆角与 .fn-canvas 拉平（4px，不再自成一派 8px）");
  has(LTCSS, "cursor: grab", "画布可抓（与主画布同一手感）");
  has(LTU, 'x: snapV(60 + (ltArr(g.nodes).length % 4) * colStep)', "新建节点落点吸附网格");
  has(LTU, "w: snapV(200)", "新建节点宽度吸附网格");
  has(LTU, "h: snapV(80)", "新建节点高度吸附网格");
  has(LTU, "n.x = Math.max(0, snapFn(raw.x))", "拖动落点吸附网格（边拖边吸，松手不跳）");
  has(LTU, "n.y = Math.max(0, snapFn(raw.y))", "拖动纵向同样吸附网格");
  /* 拖动跟手：pointerdown 里 ltRenderStrip() 会把 #ltMain（含 svg）整块重建，
     挂在那一帧元素上的监听当场变死监听 —— 拖动不跟鼠标、松手才跳到错落点。 */
  has(LTU, "function ltGraphScaleOf(", "屏幕 px → 图坐标抽成等比映射函数（可单测）");
  has(LTU, "ltGraphScaleLive(host, svg)", "按此刻真实渲染的 svg 现算缩放（不缓存元素）");
  has(LTU, 'document.addEventListener("pointermove", ltDragMove, true)', "拖动 / 连线监听挂 document：pointerdown 后的整块重绘不会掐断拖拽");
  has(LTU, 'document.addEventListener("pointerup", ltDragEnd, true)', "松手也在 document 上收（拖出画布外松手照样收尾）");
  has(LTU, 'grp.setAttribute("data-lt-id", path)', "节点组带 data-lt-id：重绘后按 id 找回当前这一帧的元素");
  has(LTU, "ltDragGroupOf(host, ltDrag.path)", "每帧按 id 现找被拖的组（不再抓 pointerdown 那帧的死元素）");
  hasnt(LTU, "ltDrag.grp", "拖动状态里不再存 pointerdown 那一帧的 grp（死元素 = 拖动不动）");
  hasnt(LTU, "ev.clientX - ltDrag.x0) / k", "增量换算不再按 viewBox/盒宽 反着除（图一大就只爬 1/s²）");
  {
    const tpl = LTU.slice(LTU.indexOf("async function ltNewTask("), LTU.indexOf("/* 图内容包围盒"));
    has(tpl, "x: 48, y: 144", "手动模板的坐标也落在 24 网格上（第一次拖就不跳一格）");
    hasnt(tpl, "x: 40, y: 150", "模板不再有非网格坐标");
  }

  /* ── [8] 自动填入：真跑（把条带界面也装进同一个沙箱，调 window.LT.inheritGraph） ──
     铁律：只在字段为空时补默认，用户 / Agent 已显式写入的值一律不动。 */
  console.log("\n[8] 自动填入：空字段补默认、已有值不被覆盖（真跑，不是 grep）");
  vm.runInContext(LTU, sandbox, { filename: "renderer/app-longtask-ui.js" });
  ok(typeof LT.inheritGraph === "function", "条带界面脚本在沙箱里能整份执行并导出 inheritGraph");
  sandbox.preferredAgentProviderRoute = () => "deepseek-official";
  sandbox.defaultAgentProviderRoute = () => "deepseek-official";
  sandbox.preferredAgentModelForRoute = () => "deepseek-chat";
  sandbox.AGENT_PRESET_DEFAULT = "standard";
  sandbox.AGENT_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  sandbox.ltDeliverUid = (t) => "dlv_" + t;
  sandbox.S.assistPreset = "standard";
  sandbox.S.assistEffort = "high";
  const IG = {
    nodes: [
      { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版" } },
      { id: "b", kind: "agent", title: "定稿", cfg: { provider: "p2", model: "m2", preset: "lean", effort: "low" } },
      { id: "sub", kind: "sub", title: "子图", cfg: { graph: { nodes: [{ id: "a2", kind: "agent", title: "内层", cfg: {} }] } } },
      { id: "h", kind: "human", title: "交片", cfg: { mode: "deliver" } },
    ],
    edges: [],
  };
  LT.inheritGraph(IG);
  eqNum(IG.nodes[0].cfg.provider, "deepseek-official", "空 provider 补上默认会话路由");
  eqNum(IG.nodes[0].cfg.model, "deepseek-chat", "空 model 补上该路由默认模型（与会话下拉同一份）");
  eqNum(IG.nodes[0].cfg.preset, "standard", "空 preset 补上会话预设");
  eqNum(IG.nodes[0].cfg.effort, "high", "空 effort 补上会话思考强度");
  eqNum(IG.nodes[1].cfg.provider, "p2", "已有 provider 不被覆盖");
  eqNum(IG.nodes[1].cfg.model, "m2", "已有 model 不被覆盖");
  eqNum(IG.nodes[1].cfg.preset, "lean", "已有 preset 不被覆盖");
  eqNum(IG.nodes[1].cfg.effort, "low", "已有 effort 不被覆盖");
  eqNum(IG.nodes[2].cfg.graph.nodes[0].cfg.model, "deepseek-chat", "子图里的 Agent 节点同样继承（递归，不只顶层）");
  ok(IG.nodes[3].cfg.uid === "dlv_交片", "内容交付节点预分配交付 uid（不再等「启用时自动分配」）");
  sandbox.S.assistEffort = "off";
  eqNum(LT.inheritDefaults().effort, "", "引擎落盘白名单外的思考档留空（不写一个存不下的值）");
  sandbox.S.assistEffort = "high";

  /* ── [8b] 交付节点板身：md 表列出「每个端子对应文件是什么」（真跑，不是 grep） ──
     一个未交文件项 = 一个仅输入端子；表列 = 文件名 · 内容说明 · 必填/选填 · 格式或大小要求 · 交付状态。 */
  console.log("\n[8b] 交付节点板身：md 表 / 端子行 / 已交区（真跑，不是 grep）");
  const BITEM1 = { id: "b1", kind: "file", title: "分镜表.md", desc: "每镜头一行", accept: "仅 .md · ≤ 2 MB", required: true, done: false, paths: [] };
  const BITEM2 = { id: "b2", kind: "file", title: "角色设定.md", desc: "人物小传", accept: "", required: true, done: false, paths: [] };
  const BITEM3 = { id: "b3", kind: "text", title: "风格说明", required: true, done: false, value: "" };
  const mkBoardNode = (items) => ({ id: "d1", kind: "deliver", ltUid: "ltx-交稿", ltItems: JSON.parse(JSON.stringify(items)) });
  const mdTable = sandbox.ltDeliverMarkdownTable(mkBoardNode([BITEM1, BITEM2, BITEM3]));
  const mdLines = mdTable.split("\n");
  eqNum(mdLines.length, 2 + 3, "表 = 表头 + 分隔行 + 每一条清单一行（含不占端子的类型）");
  has(mdLines[0], "文件名", "表头第 1 列是文件名（端子标签）");
  has(mdLines[0], "内容说明", "表头有内容说明列");
  has(mdLines[0], "必填/选填", "表头有必填/选填列");
  has(mdLines[0], "格式或大小要求", "表头有格式或大小要求列");
  has(mdLines[0], "交付状态", "表头有交付状态列");
  has(mdLines[2], "分镜表.md", "第一行点名该端子的文件名");
  has(mdLines[2], "每镜头一行", "同一行带上该文件的内容说明");
  has(mdLines[2], "仅 .md · ≤ 2 MB", "同一行带上格式 / 大小要求");
  has(mdLines[2], "待交付", "未交的状态列写「待交付」");
  const mdDone = sandbox.ltDeliverMarkdownTable(mkBoardNode([Object.assign({}, BITEM1, { done: true, deliveredVia: "上传" })]));
  has(mdDone, "已交付（上传）", "已交的状态列写「已交付」并带来源");
  ok(sandbox.ltDlvAcceptCheck(BITEM1, "D:\\x\\别的.txt", 1024).length > 0, "只提示不阻止：后缀不符给一条警告");
  eqNum(sandbox.ltDlvAcceptCheck(BITEM1, "D:\\x\\分镜表.md", 1024).length, 0, "后缀对得上就不报警");
  ok(sandbox.ltDlvAcceptCheck(BITEM1, "D:\\x\\分镜表.md", 8 * 1024 * 1024).length > 0, "超过 ≤ 2 MB 的要求给一条警告");
  eqNum(sandbox.ltDlvAcceptCheck({ accept: "" }, "D:\\x\\随便.bin", 99999999).length, 0, "没写要求（accept 空）时一条都不报（不拿猜的规则误报）");
  has(LTU, "ltDeliverSyncFromNode(node)", "节点内的增删改 / 上传 / 撤回统一回写（画布优先：同时写图定义 + manifest）");
  has(LTU, "ltDlvItemUpload(node, it)", "每个端子自己有上传钮（选的文件名要跟该端子对得上）");
  has(LTU, "ltDlvItemRevoke(node, it)", "已交区可撤回（只把端子放回来，交付目录里的文件不删）");
  has(LTU, "ltDlvAddFileDlg(node)", "节点内「＋ 添加文件」小表单（文件名 / 说明 / 必填 / 格式大小）");
  hasnt(LTU, "async function ltNodeUpload", "旧的「整体上传、按顺序填第一条」入口已删除（不留第二个写入口）");
  has(LTU, "deliverPendingItems", "板身端子行取自引擎的同一份「未交文件项」口径");
  /* 真跑板身渲染：端子行确实按端子数出来（文本条目不成行），且表渲染成**真表格**（不是 md 源码） */
  {
    sandbox.document.createElement = (tag) => ({
      tagName: tag,
      className: "",
      classList: { add() {}, toggle() {}, contains: () => false },
      style: {},
      dataset: {},
      children: [],
      appendChild(c) { this.children.push(c); },
      addEventListener() {},
      setAttribute() {},
      set textContent(v) { this._t = v; },
      get textContent() { return this._t; },
    });
    /* 全站唯一 Markdown 入口：给一个能认出「渲染过了」的假实现（真实现由 app.js 承载，
       沙箱里只装长任务两个文件，故意不抄一份 marked 进来）。 */
    sandbox.renderMarkdown = (md) => "<table><tbody>" + String(md).replace(/&/g, "&amp;") + "</tbody></table>";
    const boardStub = { children: [], appendChild(c) { this.children.push(c); } };
    vm.runInContext(
      "buildDeliverBody(__n, __b)",
      Object.assign(sandbox, { __n: mkBoardNode([BITEM1, BITEM2, BITEM3]), __b: boardStub }),
    );
    const flat = [];
    const walk = (el) => {
      if (!el) return;
      flat.push(el);
      for (const c of el.children || []) walk(c);
    };
    walk(boardStub);
    const rows = flat.filter((e) => String(e.className || "").split(/\s+/).indexOf("lt-dlv-t") >= 0);
    eqNum(rows.length, 2, "板身渲染出 2 个待交付端子行（文本条目不成行 · 与端子数一致）");
    const mdBox = flat.find((e) => String(e.className || "") === "lt-dlv-md");
    ok(!!mdBox, "板身顶部渲染出了 md 表块（.lt-dlv-md）");
    has(String(mdBox && mdBox.innerHTML), "<table>", "md 表渲染成真表格（走 renderMarkdown，不再铺 `| a | b |` 源码）");
    has(String(mdBox && mdBox.innerHTML), "分镜表.md", "渲染后的表里带着端子对应的文件名");
    ok(
      !flat.some((e) => String(e.tagName || "") === "pre"),
      "渲染可用时不再用 <pre> 铺 Markdown 源码（表就是表）",
    );
    ok(
      flat.some((e) => String(e.className || "").split(/\s+/).indexOf("lt-dlv-mdh") >= 0),
      "表上方有「预览 Markdown」动作行（预览入口在这条行里）",
    );
    has(LTU, "ltDlvTableEl(node)", "板身的表统一走 ltDlvTableEl（渲染与回落一处收口）");
    has(LTU, 'typeof renderMarkdown === "function"', "渲染前先判空：渲染器缺席时不炸（单测沙箱 / 加载顺序异常）");
    /* 本轮需求：交付物清单的 Markdown 要有**预览**（开应用内 Markdown 预览器），不必再复制 Markdown */
    has(LTU, "async function ltDlvPreviewMarkdown(node) {", "板身有预览入口 ltDlvPreviewMarkdown");
    has(LTU, "openMdViewer(", "预览开的是应用内 Markdown 预览器（app.js 的 openMdViewer），不另造一个窗");
    has(LTU, "function ltDlvMarkdownPath(node) {", "落盘清单的路径单独成口（口径与 longtask-store.js 的交付清单.md 对齐）");
    hasnt(LTU, "ltDlvCopyMarkdown", "板身不再单设「复制 Markdown」按钮（预览器自带「复制全文」，不必复制出去看）");
    ok(
      /ltT\("[^"]*预览 Markdown"\)/.test(LTU),
      "按钮文案点名「预览 Markdown」（画布节点上一眼看得见）",
    );
    /* 回落：渲染器缺席时也不能空一块板身 —— 退回等宽源码 pre（看得到 + 可选中复制） */
    delete sandbox.renderMarkdown;
    const boardStub2 = { children: [], appendChild(c) { this.children.push(c); } };
    vm.runInContext(
      "buildDeliverBody(__n2, __b2)",
      Object.assign(sandbox, { __n2: mkBoardNode([BITEM1]), __b2: boardStub2 }),
    );
    const flat2 = [];
    const walk2 = (el) => {
      if (!el) return;
      flat2.push(el);
      for (const c of el.children || []) walk2(c);
    };
    walk2(boardStub2);
    ok(
      flat2.some((e) => String(e.className || "") === "lt-dlv-md-src"),
      "渲染器缺席时回落成等宽源码（板身不空白）",
    );
    /* 真跑：预览真的开预览器 —— 交付目录里那份清单 md 在 → 开它（只读）；不在 → 开板身这份虚拟文档 */
    sandbox.__opened = [];
    sandbox.__n3 = {
      id: "d3",
      kind: "deliver",
      ltUid: "ltx-交稿",
      ltDir: "D:\\交付\\ltx-交稿",
      ltItems: JSON.parse(JSON.stringify([BITEM1])),
    };
    vm.runInContext(
      "openMdViewer = function (p, o) { __opened.push({ p: String(p || ''), o: o || {} }); };",
      sandbox,
    );
    sandbox.window.api.fileStat = () => Promise.resolve({ ok: true, size: 10 });
    await vm.runInContext("ltDlvPreviewMarkdown(__n3)", sandbox);
    const op1 = sandbox.__opened[0] || {};
    ok(/交付清单\.md$/.test(String(op1.p)), "真跑：清单 md 已在磁盘上 → 开的就是它（不另拼一份内容）");
    ok(op1.o && op1.o.readOnly === true, "真跑：落盘那份按只读开（清单镜像会被应用重写，不让用户白改）");
    sandbox.window.api.fileStat = () => Promise.resolve({ ok: false, error: "路径不存在" });
    sandbox.__opened.length = 0;
    await vm.runInContext("ltDlvPreviewMarkdown(__n3)", sandbox);
    const op2 = sandbox.__opened[0] || {};
    eqNum(String(op2.p), "", "真跑：清单还没落盘 → 开虚拟文档（不弹「文件不存在」）");
    has(
      String(op2.o && op2.o.content),
      "分镜表.md",
      "真跑：虚拟文档的正文 = 板身那张表的 Markdown（板上有什么就预览什么）",
    );
    ok(op2.o && op2.o.readOnly === true, "真跑：虚拟文档同样只读（这里只是预览，不是编辑入口）");
    delete sandbox.openMdViewer;
    delete sandbox.__n3;
    delete sandbox.__opened;
  }

  /* ⑨ i18n：交付物 markdown 预览的新文案有 EN 词条（切英文不出现中文半截） */
  {
    const I18P = require("../renderer/i18n.js");
    I18P.setLocale("en");
    const keysPv = [
      "\u25A4 预览 Markdown",
      "在 Markdown 预览器里打开这份交付清单（不必先复制 Markdown）",
      "交付物清单 Markdown",
      "Markdown 预览器未就绪",
    ];
    const missPv = keysPv.filter((k) => I18P.t(k) === k);
    eqNum(
      missPv.length,
      0,
      "i18n 中英词条齐备（预览入口文案都有 EN 译文）" + (missPv.length ? "（缺：" + missPv.join(" / ") + "）" : ""),
    );
    I18P.setLocale("zh");
    for (const k of keysPv) has(I18N, '"' + k + '":', "i18n 源文件里有「" + k + "」");
  }

  /* ── [8c] 逐项(map) 真跑整条状态机 + 等人卡（本轮需求本体）─────────────────────
   * 需求口径：**完全杜绝状态机本身出错**。老口径「overKey 取不到数组 → failed」那条路径整条撤掉，
   * 改成：算不出条目数就转「等人」（waiting_human + mapfix 待办卡），run 收敛成 waiting（不是 failed），
   * 下游不点火；用户在卡上改键 / 粘 JSON 后点「重新查找并继续」→ 补救口重排这一环接着跑。
   * 这一段是集成真跑（LT.ui.enable 走完整主循环），不是 grep。 */
  console.log("\n[8c] 逐项(map)取不到数组 → 转等人（真跑主循环 + 补救口 + 卡片接线）");
  const mkMapProbeTask = (uid) => ({
    uid: uid,
    name: "探针任务",
    enabled: false,
    ver: 1,
    graph: {
      ver: 1,
      nodes: [
        { id: "s", kind: "start", title: "起点" },
        {
          id: "m",
          kind: "map",
          title: "逐项",
          cfg: {
            overKey: "shot_list",
            itemKey: "item",
            maxItems: 8,
            outKeys: [],
            graph: {
              nodes: [
                { id: "ms", kind: "start", title: "子起点" },
                { id: "me", kind: "end_ok", title: "子终点" },
              ],
              edges: [{ id: "me1", from: "ms", to: "me" }],
            },
          },
        },
        { id: "e", kind: "end_ok", title: "收工" },
      ],
      edges: [
        { id: "e1", from: "s", to: "m" },
        { id: "e2", from: "m", to: "e" },
      ],
    },
  });
  const mkMapProbeWf = (uid) => {
    const wf = { id: "wf-map-probe", nodes: [], wires: [], workspace: "D:\\ws", longtask: { tasks: [], active: "" } };
    wf.longtask.tasks = [mkMapProbeTask(uid)];
    wf.longtask.active = uid;
    return wf;
  };
  const wfWait = mkMapProbeWf("t-map-wait");
  const en = await LT.ui.enable(wfWait, "t-map-wait", {});
  ok(en && en.ok, "真跑：一张含逐项环节的图能启用（拿到 run）");
  await new Promise((r) => setTimeout(r, 160)); /* 主循环是异步的：等它收敛 */
  const runWait = LT.runOf(wfWait.id, en.run.runId);
  ok(!!runWait && runWait === en.run, "真跑：run 在引擎的运行表里查得到（按 画布id + runId 反查）");
  eqNum(runWait.nodes["m"].status, "waiting_human", "真跑：逐项环节取不到数组 → 转等人（老口径这里是 failed）");
  ok(runWait.nodes["m"].mapWait === true, "真跑：这一环标着「等展开源」（卡片据此渲染补救面）");
  eqNum(runWait.status, "waiting", "真跑：整本 run 收敛成 waiting（不是 failed，链路没断）");
  eqNum((runWait.waits || []).filter((w) => w.kind === "mapfix").length, 1, "真跑：等人清单挂上一条 mapfix 待办（条带右栏据此出卡片）");
  ok(!Object.keys(runWait.nodes).some((p) => runWait.nodes[p].status === "failed"), "真跑：全图没有一个环节停在 failed（状态机本身没出错）");
  ok(!(runWait.fired || {}).e2, "真跑：没有往下游点火（这一环没跑完，下游不该被叫起）");
  const infoWait = LT.mapWaitInfo(runWait, "m");
  ok(!!infoWait && /shot_list/.test(infoWait.text), "真跑：就诊信息里有这个环节真正缺的那个键名");
  /* 补救口一：把展开键改成状态里真实存在的键 → 这一环离开等人、按它展开 */
  const liveMapNode = LT.nodeAt(runWait, "m");
  runWait.ns["a"] = { shots: [{ n: 1 }, { n: 2 }] };
  const rep = LT.mapRepairWait(wfWait, "m", { overKey: "shots" });
  ok(rep && rep.ok, "补救口真跑：改成状态里真实存在的键 → 接受");
  await new Promise((r) => setTimeout(r, 200));
  ok(runWait.nodes["m"].status !== "waiting_human", "补救后这一环不再停在等人（重新排回 pending / 已跑起来）");
  eqNum((runWait.waits || []).filter((w) => w.kind === "mapfix").length, 0, "补救后 mapfix 待办被摘掉（卡片收起）");
  ok(!!liveMapNode && liveMapNode.cfg.overKey === "shots", "补救只改这一个环节的展开键，不替用户改别的");
  eqNum(
    (wfWait.longtask.tasks[0].graph.nodes.find((x) => x.id === "m") || {}).cfg.overKey,
    "shots",
    "补救改的键名**写回任务图定义**（不是只活在这一次 run 的内存里）",
  );
  /* 补救口二 / 三：仍取不到时不许假装成功（留在等人 + ok:false）与「直接粘贴一份 JSON 数组」
     —— 用另一本 run（上一本已经被补救口一推着跑完了，状态不再是等人，不能拿来验失败分支）。 */
  const wfFix = mkMapProbeWf("t-map-fix");
  const enFix = await LT.ui.enable(wfFix, "t-map-fix", {});
  await new Promise((r) => setTimeout(r, 160));
  const runFix = LT.runOf(wfFix.id, enFix.run.runId);
  eqNum(runFix.nodes["m"].status, "waiting_human", "第二本 run 同样停在等人（每个 run 各自独立，互不串状态）");
  const badRep = LT.mapRepairWait(wfFix, "m", { overKey: "nothing_here" });
  ok(badRep && badRep.ok === false, "补救口：键名改成不存在的 → 返回 ok:false（不假装成功）");
  eqNum(runFix.nodes["m"].status, "waiting_human", "补救失败时留在等人（绝不判失败，也绝不空跑）");
  eqNum((runFix.waits || []).filter((w) => w.kind === "mapfix").length, 1, "补救失败时 mapfix 待办照旧挂着（卡片不消失）");
  const pasted = LT.mapRepairWait(wfFix, "m", { overKey: "shot_list", pasted: '[{"n":9},{"n":8}]' });
  ok(pasted && pasted.ok && pasted.count === 2, "补救口：粘贴 JSON 数组 → 立刻当展开源（2 项）");
  await new Promise((r) => setTimeout(r, 160));
  eqNum(LT.stateGet(runFix, "", "shot_list").length, 2, "粘贴的数组写回状态，下游读得到");
  eqNum(runFix.nodes["m"].status, "done", "粘贴后这一环真的跑起来了（2 项都展开完 → done）");
  /* 界面接线：等人卡片遇到 mapfix 走专门的补救卡（不落进审批卡的通过 / 驳回），取值口径两种控件都收 */
  ok(/if \(w && w\.kind === "mapfix"\) return ltMapCard\(wf, run, w\);/.test(LTU), "界面：等人卡片遇到 mapfix 走 ltMapCard（不落进审批卡的通过 / 驳回）");
  has(LTU, "function ltMapCard(wf, run, w) {", "界面：补救卡单独成口 ltMapCard");
  has(LTU, "window.LT.mapWaitInfo(run, wpath)", "界面：卡片文案与候选取自引擎（ltMapWaitInfo），界面不另判一遍");
  has(LTU, "{ overKey: key, pasted: pasted }", "界面：「重新查找并继续」把展开键与粘贴内容交给引擎补救口");
  eqNum(typeof sandbox.ltMapKeyVal, "function", "界面：展开键取值有专属口径 ltMapKeyVal（下拉 handle 与裸 input 两种都收）");
  eqNum(sandbox.ltMapKeyVal({ value: () => "shots", input: { value: "" } }), "shots", "取值：下拉 handle 形态读 value()");
  eqNum(sandbox.ltMapKeyVal({ value: () => "", input: { value: "手工打的键" } }), "手工打的键", "取值：下拉框里手打的裸字读 input.value");
  eqNum(sandbox.ltMapKeyVal({ value: "plain" }), "plain", "取值：普通输入框形态读 .value");
  eqNum(sandbox.ltMapKeyVal(null), "", "取值：控件不在时给空串（不抛错）");

  /* ── [11] 长任务画布拖动：屏幕 px ↔ 图坐标的等比映射（真跑，不是 grep） ─
     .lt-svg 宽高 100% + viewBox 默认 xMidYMid meet：等比系数 s = min(盒宽/viewW, 盒高/viewH)，
     屏幕 1px = 1/s 图单位，宽高比不一致时居中留白 offX / offY。
     旧写法按 viewBox/盒宽 反着除，图一大（viewW > 盒宽）节点只爬鼠标的 1/s² —— 拖动不跟手、
     松手落点也偏，就是这个系数错了。 */
  console.log("\n[11] 长任务画布拖动：等比映射与留白（真跑，不是 grep）");
  const fitWide = sandbox.ltGraphScaleOf({ w: 1800, h: 400 }, { width: 600, height: 300 });
  eqNum(Number(fitWide.s.toFixed(4)), 0.3333, "图宽 1800 放进 600px 盒子：宽度受限，1 图单位 = 1/3 px");
  eqNum(Math.round(fitWide.offX), 0, "宽度受限：横向没有留白");
  eqNum(Math.round(fitWide.offY), Math.round((300 - 400 * (600 / 1800)) / 2), "纵向留白 = (盒高 − 内容高)/2（居中）");
  eqNum(Math.round(300 / fitWide.s), 900, "鼠标拖 300px = 图坐标 900（旧写法 /(viewW/盒宽) 只给 100 → 不跟手）");
  const fitTall = sandbox.ltGraphScaleOf({ w: 600, h: 3000 }, { width: 600, height: 300 });
  eqNum(Number(fitTall.s.toFixed(4)), 0.1, "图高 3000 放进 300px 盒子：高度受限，等比 0.1（不是按宽算的 1）");
  eqNum(Math.round(fitTall.offX), 270, "高度受限：横向留白 (600 − 600×0.1)/2 = 270（连线命中要先减掉它）");
  const fitNone = sandbox.ltGraphScaleOf({ w: 900, h: 240 }, { width: 0, height: 0 });
  eqNum(fitNone.s, 1, "量不到盒子（还没挂载）：退回 1:1，不把节点甩飞");
  /* 真跑一次拖动：假 DOM 里让 host.querySelector 交出「重绘后新一帧」的 svg / 节点组，
     看 transform 是否落在按等比系数算出的网格点上（旧写法会给 120，不是 936）。 */
  const drawnSet = {};
  sandbox.document.querySelector = () => ({
    clientWidth: 600,
    querySelector: (sel) =>
      sel === "svg.lt-svg"
        ? { getAttribute: () => "0 0 1800 400", getBoundingClientRect: () => ({ width: 600, height: 300, left: 0, top: 0 }) }
        : { setAttribute: (k, v) => { drawnSet[k] = v; } },
  });
  vm.runInContext(
    'ltDrag = { mode: "move", id: "a", path: "a", g: { nodes: [{ id: "a", x: 24, y: 24, w: 200, h: 80 }] }, x0: 100, y0: 100, nx: 24, ny: 24 }; ltDragMove({ clientX: 400, clientY: 100 });',
    sandbox,
  );
  eqNum(drawnSet.transform, "translate(936,24)", "真跑拖动：鼠标右移 300px → 节点跟到 x=936（24 网格上，跟手不偏）");

  /* ── [12] 需求 2：状态节点在画布上列出子任务（真跑 ltTaskRows） ──
     agent = 🤖（goal 的换行 / 列项拆条），human(deliver) = ✋ + ☐/☑，子图 = ⤵；
     「需人工」的行标 human:true（渲染成琥珀色 lt-nd-need）。 */
  sandbox.S.wf = { id: "wf-test" };
  sandbox.S.wfViews = {};
  console.log("\n[12] 状态节点的子任务清单：AI 自动 / 需人工 / 交付条目（真跑，不是 grep）");
  has(LTU, "function ltTaskRows(", "有 ltTaskRows：把这一环的子任务算成行（现算现画，不落新字段）");
  has(LTU, "function ltNodeRenderH(", "有 ltNodeRenderH：卡片高度随行数长");
  has(LTU, "n._ltH = ltNodeRenderH(n)", "渲染前先算几何：rect / 连线端点 / 端口读同一份高度");
  has(LTU, 'rt.setAttribute("class", "lt-nd-task"', "每行画成 SVG 文本（不是塞进摘要一整行）");
  has(LTU, "lt-nd-need", "需要人工的行有独立类（琥珀色上色）");
  has(LTCSS, ".lt-nd-task", "长任务画布有子任务行样式");
  has(LTCSS, ".lt-nd-need", "「需人工」的花色也在（一眼看出卡在人身上）");
  {
    const agentRows = sandbox.ltTaskRows(null, "a", { kind: "agent", cfg: { goal: "1. 查资料\n2. 写初稿\n- 交校对" } }, null);
    eqNum(agentRows.length, 3, "Agent 的 goal 按换行 / 列项拆成 3 条子任务");
    ok(agentRows.every((r) => r.icon === "🤖"), "Agent 行一律标 AI 自动（🤖）");
    ok(!agentRows.some((r) => r.human), "Agent 行的目标默认不需要人工干涉");
    const humanRows = sandbox.ltTaskRows(
      { nodes: { h: { items: [{ title: "交片", done: true }, { title: "字幕", done: false }] } } },
      "h",
      { kind: "human", cfg: { mode: "deliver" } },
      { items: [{ title: "交片", done: true }, { title: "字幕", done: false }] },
    );
    ok(humanRows[0].human === true && humanRows[0].icon === "✋", "人工任务首行列「需要你处理」");
    eqNum(humanRows[1].icon, "☑", "已交付条目用 ☑");
    eqNum(humanRows[2].icon, "☐", "未交付条目用 ☐ 且标需人工");
    ok(humanRows[2].human === true, "没交的条目算「需要人工干涉」");
    const subRows = sandbox.ltTaskRows(null, "s", { kind: "sub", cfg: { graph: { nodes: [{ kind: "human", title: "内层人工" }, { kind: "agent", title: "内层 AI", cfg: { model: "m", provider: "p" } }] } } }, null);
    eqNum(subRows[0].icon, "⤵", "子图成员逐条列出（⤵）");
    ok(subRows[0].human === true, "子图里的人工成员同样标需人工");
    ok(subRows[1].human === false, "配了模型的 Agent 成员不算需人工");
    eqNum(sandbox.ltNodeRenderH({ h: 80, _ltRows: [] }), 80, "没有子任务行时高度不动（老图不变形）");
    eqNum(sandbox.ltNodeRenderH({ h: 80, _ltRows: [1, 2, 3] }), 112, "3 行时卡片长到 70 + 3×14（连线端点同高）");
  }

  /* ── [14] 画布相机手势（Pan）/ 节点拖动 / 连线拖动：真跑断言 ──
     与主画布同口径：空白左键或任意位置中键 → 平移；节点左键 → 移节点；端子 → 连线。
     旧版只有滚轮缩放、没有 Pan，且 ltHitNode 用 n.h（不含子任务行撑高的 _ltH）命中，
     高卡片下半截接不上线 —— 这里逐条钉住。 */
  console.log("\n[14] 长任务画布：Pan / 移节点 / 连线（真跑，不是 grep）");
  /* grep 层：手势接线口径（中键不进节点拖动、平移量 = 屏幕增量 / s、命中用 _ltH、橡皮筋收尾） */
  has(LTU, 'holder.addEventListener("pointerdown", (ev) => ltGraphPanDown(ev, holder, svg, g), true)', "平移手势挂 holder 捕获阶段（中键先于节点被接管）");
  has(LTU, 'const mid = Number(ev.button) === 1', "中键被认成平移（与主画布 canvas 中键同一语义）");
  has(LTU, 'if (!mid && ev.target !== svg && ev.target !== holder) return;', "左键只有点在空白才平移（节点 / 端子 / 边各有自己的 pointerdown）");
  has(LTU, "if (mid && ev.stopPropagation) ev.stopPropagation();", "中键在捕获阶段吃掉事件：节点收不到，选中不被改");
  has(LTU, "ltGestureTake(\"pan\")", "平移起手先做手势互斥（后开始的手势接管前一个）");
  has(LTU, "ltViewSet({ x: ltPan.px - dx / s, y: ltPan.py - dy / s })", "平移量 = 屏幕增量 / 等比系数 s（与主画布 S.cam 同手感）");
  hasnt(LTU, "ltRenderStrip();\n  ltPan.svg", "平移过程中不整块重绘（重绘会掐断 Pointer 手势）");
  has(LTU, "n._ltH || Math.max(Number(n.h), 56)", "ltHitNode 命中使用这一帧真实渲染高度 _ltH（子任务行撑高的卡片下半截也能接线）");
  has(LTU, "function ltWireTempDrop(", "有 ltWireTempDrop：松手 / Esc / cancel 都先摘掉临时橡皮筋");
  has(LTU, 'const target = !cancelled && svg && ev ? ltHitNode(g, svg, ev) : "";', "松手落在空白 / 取消时命中为空 → 不建边（取消并还原，且命中按活图判）");
  has(LTU, "if (target && target !== ltDrag.from) {", "只有命中到别的节点才建边（落空白 / 落自身一律取消）");
  has(LTCSS, ".lt-edge-temp", "临时橡皮筋有独立样式（虚线预览，不掺和命中）");
  has(LTU, 'setProperty("--lt-grid-x"', "平移时点阵横向偏移跟着 viewBox 原点走");
  has(LTU, 'setProperty("--lt-grid-y"', "纵向同理（点阵跟内容一起走，不看成「拖动出错」）");
  {
    /* 手势状态（ltSel / ltPan / ltDrag）是模块作用域绑定，不进沙箱全局：一律用 evalIn 读写 */
    const evalIn = (code) => vm.runInContext(code, sandbox);

    /* ① 中键起手势进 pan 分支且不动选中：target 给节点组也照样被捕获阶段接管 */
    sandbox.S.wf = { id: "wf-test" };
    sandbox.S.wfViews = {};
    evalIn('ltSel.path = "keep"; ltSel.edge = "keep";');
    sandbox.ltViewSet({ x: 0, y: 0, z: 1 });
    const panHolder = { clientWidth: 900, classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ width: 900, height: 300 }) };
    const panSvg = { getAttribute: () => "0 0 900 300", getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }) };
    sandbox.ltGraphPanDown({ button: 1, target: { __node: true }, clientX: 10, clientY: 10, stopPropagation() {}, preventDefault() {} }, panHolder, panSvg, { nodes: [], edges: [] });
    ok(evalIn("!!ltPan"), "中键（button===1）在节点上起手也进 pan 分支（捕获阶段先吃掉）");
    eqNum(evalIn("ltPan.mid"), true, "这次手势被标成中键平移（不触发节点拖动）");
    eqNum(evalIn("ltSel.path"), "keep", "中键平移不改变当前节点选中");
    evalIn("ltPan = null;"); /* 收工，别让状态串到下一条 */

    /* ② 空白左键拖动 → ltViewSet 的 x/y 变化等于屏幕增量 / s */
    sandbox.ltViewSet({ x: 100, y: 50, z: 1 });
    const blankVb = {};
    const blankSvg = {
      getAttribute: () => "0 0 900 300",
      setAttribute: (k, v) => { blankVb[k] = v; },
      getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }),
    };
    const blankHolder = { clientWidth: 900, classList: { add() {}, remove() {} }, style: { setProperty() {} }, getBoundingClientRect: () => ({ width: 900, height: 300 }) };
    const blankTarget = { __notBlank: true }; /* 跟 svg / holder 都不同的元素：不算空白，下面单独用例 */
    sandbox.ltGraphPanDown({ button: 0, target: blankSvg, clientX: 0, clientY: 0, stopPropagation() {}, preventDefault() {} }, blankHolder, blankSvg, { nodes: [], edges: [] });
    ok(evalIn("!!ltPan"), "空白左键（target === svg）起手平移");
    evalIn("ltPan.s = 1;"); /* 盒 900×300 / viewBox 900×300：等比 1 */
    /* 先掐掉边界钳制（假 DOM 量不到 .lt-graph）：平移量要能被准算出来 */
    sandbox.document.querySelector = () => null;
    sandbox.ltPanMove({ clientX: 120, clientY: 48, buttons: 1 });
    const panned = sandbox.ltView();
    eqNum(panned.x, -20, "空白左键右移 120px：view.x = 100 − 120/1（屏幕增量 / s，与主画布同向）");
    eqNum(panned.y, 2, "纵向同理：view.y = 50 − 48/1");
    sandbox.ltPanEnd({}, false);
    eqNum(evalIn("ltSel.path"), "keep", "真拖动过的平移收尾不清选中（只有「点空白没拖」才算取消选中）");
    /* 左键点在非空白（节点）不该起平移（节点自己的 pointerdown 负责拖动） */
    sandbox.ltGraphPanDown({ button: 0, target: blankTarget, clientX: 0, clientY: 0, preventDefault() {} }, blankHolder, blankSvg, { nodes: [], edges: [] });
    ok(!evalIn("!!ltPan"), "左键点在节点 / 端子上不起平移（交给节点拖动 / 连线）");

    /* ③ 拖动中改变 s（模拟缩放 / 平移改了映射）后节点仍跟手。
       吸附网格临时调到 4（ltGrid 只认 4–64，1 会被兜底成 24）：本用例钉的是「换算」，
       数值都取 4 的整数倍，不掺网格取整；测完立刻还原。 */
    const snapBak = sandbox.S.config.snap;
    sandbox.S.config.snap = 4;
    const zoom = { vb: "0 0 900 300" };
    const movedSet = {};
    const dragSvg = {
      getAttribute: (k) => (k === "viewBox" ? zoom.vb : null),
      getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }),
    };
    const movedEl = { setAttribute: (k, v) => { if (k === "transform") movedSet.transform = v; } };
    const dragHolder = {
      classList: { add() {}, remove() {} },
      /* 真源码按 ['svg.lt-svg', 'g.lt-nd[data-lt-id="…"]'] 两种选择器取元素，都要给对 */
      querySelector: (sel) => (/^svg\.lt-svg$/.test(sel) ? dragSvg : /data-lt-id/.test(sel) ? movedEl : null),
    };
    sandbox.document.querySelector = () => dragHolder;
    const zoomNodes = [{ id: "a", x: 24, y: 24, w: 200, h: 80 }];
    /* 起点：鼠标 (100,100)，s=1 留白 0 → 图坐标 (100,100) */
    evalIn('ltDrag = { mode: "move", id: "a", path: "a", g: { nodes: ' + JSON.stringify(zoomNodes) + ' }, x0: 100, y0: 100, nx: 24, ny: 24, gx0: 100, gy0: 100, moved: false };');
    sandbox.ltDragMove({ clientX: 400, clientY: 200, buttons: 1 });
    eqNum(movedSet.transform, "translate(324,124)", "s=1 时鼠标右移 300px / 下移 100px → 图增量 300 / 100（24 + 增量，跟手）");
    /* 拖动中途 s 变成 2（盒不变、viewBox 收一半）：鼠标再右移 600px / 下移 600px，按当帧 s 换算 */
    zoom.vb = "0 0 450 150";
    sandbox.ltDragMove({ clientX: 1000, clientY: 800, buttons: 1 });
    eqNum(movedSet.transform, "translate(424,324)", "缩放改变 s（1 → 2）后仍跟手：图增量 = 屏幕增量 / 当帧 s（600px → 300 图单位）");
    evalIn("ltDrag = null;");
    sandbox.S.config.snap = snapBak;

    /* ④ ltHitNode 用 _ltH 命中高卡片（子任务行撑高后的下半截） */
    const hitSvg = {
      getAttribute: () => "0 0 900 300",
      getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }),
      closest: () => ({ clientWidth: 900 }),
    };
    const tallG = { nodes: [{ id: "tall", x: 0, y: 0, w: 200, h: 80, _ltH: 260 }] };
    eqNum(sandbox.ltHitNode(tallG, hitSvg, { clientX: 100, clientY: 200 }), "tall", "y=200 落在卡片下半截（_ltH=260）内 → 命中（旧写法按 h=80 判会落空）");
    eqNum(sandbox.ltHitNode(tallG, hitSvg, { clientX: 100, clientY: 290 }), "", "超出真实渲染高度（260）不算命中，线不落到卡片外");

    /* ⑤ 连线在空白松手：不新增边、临时橡皮筋被摘掉 */
    const wireEdges = [];
    const removedTemp = [];
    const wireTemp = { parentNode: { removeChild: (el) => removedTemp.push(el) } };
    const wireSvg = {
      getAttribute: () => "0 0 900 300",
      getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }),
      closest: () => ({ clientWidth: 900 }),
      querySelector: () => null,
      querySelectorAll: () => [wireTemp],
    };
    sandbox.document.querySelector = () => ({ querySelector: () => wireSvg });
    evalIn('ltDrag = { mode: "wire", from: "a", g: { nodes: [{ id: "a", x: 0, y: 0, w: 200, h: 80 }], edges: ' + JSON.stringify(wireEdges) + ' }, host: null, svg: null, wx: 200, wy: 40 };');
    sandbox.ltDragEnd({ type: "pointerup", clientX: 700, clientY: 280 });
    eqNum(wireEdges.length, 0, "松手落在空白：不新增 edges（取消并还原）");
    ok(removedTemp.length === 1, "临时橡皮筋同步被摘掉（不留残线）");
    ok(!evalIn("!!ltDrag"), "收尾后 ltDrag 置空（不残留状态吃后续事件）");

    /* ⑥ 平移 / 换点距后点阵偏移随 viewBox 改变（真源码：偏移 = 图原点屏幕位置对一个点距取模） */
    const gridSet = {};
    const gridHolder = { clientWidth: 900, style: { setProperty: (k, v) => { gridSet[k] = v; } } };
    const gridVb = { vb: "0 0 900 300" };
    const gridSvg = { getAttribute: () => gridVb.vb, getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }) };
    const gridG = { nodes: [{ id: "a", x: 0, y: 0, w: 200, h: 80 }] };
    sandbox.S.config.snap = 24;
    sandbox.ltGraphGridSync(gridHolder, gridSvg, gridG);
    const gx0Px = gridSet["--lt-grid-x"];
    eqNum(gx0Px, "0px", "视野未平移：点阵偏移为 0（与主画布 --grid-x 同口径）");
    gridVb.vb = "120 60 900 300"; /* 平移 120 / 60 图单位 */
    sandbox.S.config.snap = 48; /* 点距 24 → 48：取模结果必然跟着变 */
    sandbox.ltGraphGridSync(gridHolder, gridSvg, gridG);
    ok(gridSet["--lt-grid-x"] !== gx0Px, "平移 / 换点距后点阵横向偏移跟着 viewBox 原点走（不跟内容走会看成「拖动出错」）");
    const cell = Number(String(gridSet["--lt-grid"]).replace("px", "")) || 24;
    const wantX = (((0 - 120) % cell) + cell) % cell;
    eqNum(gridSet["--lt-grid-x"], wantX + "px", "横向偏移 = 图原点屏幕位置对一个点距取模（cell=" + cell + " → " + wantX + "px）");
    const wantY = (((0 - 60) % cell) + cell) % cell;
    eqNum(gridSet["--lt-grid-y"], wantY + "px", "纵向同理（cell=" + cell + " → " + wantY + "px）");
    sandbox.S.config.snap = 24;
  }

  /* ── [26] 加节点 / 删除选中搬进图内右键菜单 + Delete 键删除（真跑，不是 grep）──
     需求：工具条上那十颗「＋ 节点」与一颗「删除选中」全部移除，改为右键菜单里的选项；
     删除另可直接按 Delete 键。这里钉住三件事：条带上真的没有那些按钮了、右键菜单真的
     按光标开出来且每一项落到 ltAddNode / ltDeleteSel、Delete 键真的删掉选中的节点 / 边
     并且输入框里不误删。 */
  console.log("\n[26] 长任务图画布：加节点 / 删除选中收进右键菜单 · Delete 键删除（真跑）");
  {
    /* ① 工具条只剩缩放回显：十颗加节点按钮与「删除选中」按钮的落点都不在了 */
    hasnt(LTU, "lt-btn lt-btn-add", "工具条不再有「＋ 节点」按钮（.lt-btn-add 的落点已搬走）");
    hasnt(LTU, 'ltBtn(ltT("删除选中"), "lt-btn lt-btn-del"', "工具条不再有「删除选中」按钮");
    hasnt(LTU, "const ADD = [", "工具条的 ADD 按钮数组已删除（加节点入口不再平铺）");
    has(LTU, 'ltBtn(Math.round(view.z * 100) + "%", "lt-btn lt-btn-zoom"', "缩放回显 / 复位仍是单独一枚小件（点一下回到 100%）");
    /* 本次需求：那枚百分数不再自己独占一行 —— 工具条整条撤掉，它挂到第一行（面包屑行）右端 */
    hasnt(LTU, 'ltEl("div", "lt-gbar")', "工具条（.lt-gbar）整条撤掉：回显不再独占一行浪费空间");
    has(LTU, "crumb.appendChild(zBtn)", "缩放回显挂进面包屑那一行（第一行，与根条目「长任务名 ▾ ▸ …」同一行）");
    has(LTCSS, ".lt-crumb .lt-btn-zoom", "回显样式改挂面包屑行（margin-left:auto 顶到这一行最右端）");
    has(LTCSS, ".lt-crumb {", "面包屑那行仍是 flex（margin-left:auto 才顶得到最右）");
    hasnt(LTCSS, ".lt-gbar {", "工具条那套容器样式跟着撤（不留死规则）");
    hasnt(LTCSS, ".lt-gbar .lt-btn-add {", "工具条上的加节点按钮样式已撤（搬给右键菜单项）");
    has(LTCSS, ".lt-more-i.lt-btn-add", "右键菜单项有加节点的样式（小字压暗 + hover 提亮）");
    /* ② 接线口径：右键菜单与 Delete 键都挂在 .lt-graph（holder）上，不在 document 上乱吃键 */
    has(LTU, 'holder.addEventListener("contextmenu", (ev) => ltGraphCtxMenu(ev, task, g, svg))', "图内右键叫出菜单（空白 / 节点 / 连线上都行）");
    has(LTU, 'holder.addEventListener("keydown", (ev) => ltGraphKeyDown(ev, task, g))', "Delete 键挂在 .lt-graph 上（左栏输入框里的键不会被当成删节点）");
    has(LTU, "function ltGraphCtxMenu(ev, task, g, svg) {", "右键菜单单独成口 ltGraphCtxMenu（可单测）");
    has(LTU, "function ltGraphKeyDown(ev, task, g) {", "Delete 键单独成口 ltGraphKeyDown（可单测）");
    has(LTU, "function ltEdgeAt(g, pt, svg) {", "边命中抽成 ltEdgeAt（右键 / 删除共用一份，不各算各的）");
    has(LTU, 'ltMenuOpen(null, items, { x: Number(ev.clientX) || 0, y: Number(ev.clientY) || 0 })', "菜单落在光标处（无锚点，传 pt）");
    has(LTU, "if (anchor && anchor.classList) anchor.classList.add(\"on\");", "ltMenuOpen 的锚点分支改成可选（右键菜单没有锚点）");
    has(LTU, "if (anchor && !anchor.isConnected) return;", "ltMenuOpen 只对锚点版校验 isConnected（右键版放行）");
    has(LTU, '"在图里加一个") + label + ltT("节点")', "菜单项文案仍走 i18n（加节点 + 节点名）");
    has(LTU, "ltRenderStrip();\n  ltMenuOpen(null, items,", "先重绘（选中高亮 / 检查器）再开菜单 —— 反了会被 ltRenderHead 的 ltMenuClose 收掉");
    hasnt(LTU, "ev.button !== 2", "右键不靠 button 号判（contextmenu 事件本身即右键）");
    /* ③ 真跑：造一只菜单，数一数项、点一项看是不是真调了 ltAddNode */
    {
      const evalIn26 = (code) => vm.runInContext(code, sandbox);
      const made26 = [];
      sandbox.document.createElement = (tag) => {
        const el = {
          tagName: tag,
          className: "",
          _t: "",
          children: [],
          style: {},
          type: "",
          title: "",
          onclick: null,
          offsetWidth: 190, /* 真 DOM 里由内容撑出来；这里给个真值，好钉「右 / 下溢出窗外就往回收」 */
          offsetHeight: 300,
          classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
          setAttribute() {},
          appendChild(c) { this.children.push(c); return c; },
          addEventListener() {},
        };
        Object.defineProperty(el, "textContent", { get() { return el._t; }, set(v) { el._t = String(v); } });
        made26.push(el);
        return el;
      };
      const bodyKids = [];
      sandbox.document.body = { appendChild(c) { bodyKids.push(c); return c; } };
      sandbox.document.addEventListener = () => {};
      sandbox.document.removeEventListener = () => {};
      sandbox.window.innerWidth = 1280;
      sandbox.window.innerHeight = 800;
      sandbox.window.addEventListener = () => {};
      sandbox.window.removeEventListener = () => {};
      /* 右键菜单里那次 ltRenderStrip()：真跑要整条带重建，这里换成计数（条带 DOM 不在本沙箱） */
      const stripRuns = { n: 0 };
      sandbox.__strip26 = stripRuns;
      sandbox.__renderStrip26 = null;
      evalIn26("__renderStrip26 = ltRenderStrip; ltRenderStrip = () => { __strip26.n++; };");
      /* 右键菜单里的命中测试与「还选着吗」都从 wf.longtask.tasks 现解析图（ltCurGraph）：
         本用例直接给一张图，所以把这一口也换成定值 —— 钉的是菜单 / 删除键的行为，不是取图链路。 */
      const g26 = { ver: 1, nodes: [{ id: "a", x: 24, y: 24, w: 200, h: 80, kind: "agent", title: "起草", cfg: {} }, { id: "b", x: 500, y: 24, w: 200, h: 80, kind: "end_ok", title: "收工", cfg: {} }], edges: [{ id: "e1", from: "a", to: "b", label: "", cond: "" }] };
      const task26 = { uid: "t26", graph: g26 };
      sandbox.__g26 = g26;
      evalIn26("__origCur26 = ltCurGraph; ltCurGraph = () => ({ graph: __g26, task: null, run: null, depth: 0 });");
      const svg26 = {
        getAttribute: () => "0 0 900 300",
        getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }),
        closest: () => ({ clientWidth: 900 }),
      };
      evalIn26('ltDrill = []; ltSel.path = ""; ltSel.edge = "";');
      const ev26 = { clientX: 300, clientY: 200, preventDefault() {}, stopPropagation() {} };
      sandbox.ltGraphCtxMenu(ev26, task26, g26, svg26);
      ok(bodyKids.length === 1, "真跑：右键叫出菜单（一只 .lt-more-pop 挂到 body 上）");
      const menu26 = bodyKids[0];
      const items26 = (menu26 && menu26.children ? menu26.children : []).filter((c) => c.tagName === "button" || String(c.className).indexOf("lt-more-i") >= 0);
      eqNum(items26.length, 11, "菜单项 = 10 个加节点 + 1 个删除选中（原来是工具条上 11 颗按钮，一项没丢）");
      eqNum(items26[0].textContent, "＋ Agent 任务", "第一项仍是「＋ Agent 任务」");
      eqNum(items26[10].textContent, "删除选中", "末尾仍是「删除选中」");
      eqNum(evalIn26("__strip26.n"), 1, "开菜单前重绘了一次（选中高亮 / 右侧检查器跟着换）");
      eqNum(menu26.style.left, "110px", "菜单落在光标处并往左收自身宽度（不贴任何按钮，190 宽 → 300−190）");
      eqNum(menu26.style.top, "204px", "top = clientY + 4（贴光标右下，不盖住点的那一点）");
      /* 点「＋ Agent 任务」：真调 ltAddNode(task, g, kind)，图的节点数 +1 */
      let addCalls26 = 0;
      const addArgs26 = [];
      sandbox.__add26 = (t, g, k) => { addCalls26++; addArgs26.push([t === task26, g === g26, k]); };
      evalIn26("__origAdd26 = ltAddNode; ltAddNode = (t, g, k) => __add26(t, g, k);");
      items26[0].onclick();
      eqNum(addCalls26, 1, "真跑：点「＋ Agent 任务」调了 ltAddNode（不是只换了个壳）");
      eqNum(addArgs26[0] && addArgs26[0][0], true, "传的是这一帧的 task（不串到别的任务）");
      eqNum(addArgs26[0] && addArgs26[0][1], true, "传的是这一帧的活图 g");
      eqNum(addArgs26[0] && addArgs26[0][2], "agent", "kind = agent（菜单项与节点族一一对应）");
      evalIn26("ltAddNode = __origAdd26;");
      /* 右键点到节点：选中落到它身上，删除项带上它的节点名 */
      bodyKids.length = 0;
      items26.length = 0;
      made26.length = 0;
      sandbox.ltGraphCtxMenu({ clientX: 100, clientY: 60, preventDefault() {}, stopPropagation() {} }, task26, g26, svg26);
      eqNum(evalIn26("ltSel.path"), "a", "右键点在节点上：选中落到它身上（右键一处就看清删的是哪个）");
      const menu26b = bodyKids[bodyKids.length - 1];
      const last26 = menu26b.children.filter((c) => String(c.className).indexOf("lt-more-i") >= 0).pop();
      ok(String(last26.textContent).indexOf("起草") >= 0, "选中节点时删除项里写着节点名（起草）：" + last26.textContent);
      /* 右键点到连线（两张卡片之间的折线上，y 取连线中点）：选中落到那条边 */
      bodyKids.length = 0;
      sandbox.ltGraphCtxMenu({ clientX: 350, clientY: 64, preventDefault() {}, stopPropagation() {} }, task26, g26, svg26);
      eqNum(evalIn26("ltSel.edge"), "e1", "右键点在连线上：选中落到那条边（连线也能右键删）");
      eqNum(evalIn26("ltSel.path"), "", "选边时清掉节点选中（两者只选一个，与左键点选同口径）");
      /* ④ 真跑 Delete 键：删掉的正是选中的那条边；删完再按一次给提示，不抛错 */
      const dels26 = { edge: 0, node: 0 };
      sandbox.__del26 = (kind) => { if (kind === "edge") dels26.edge++; else dels26.node++; };
      evalIn26("__origDel26 = ltDeleteSel; ltDeleteSel = (t, g) => { __del26(ltSel.edge ? 'edge' : (ltSel.path ? 'node' : '')); return __origDel26(t, g); };");
      evalIn26('ltSel.path = ""; ltSel.edge = "e1";');
      sandbox.document.activeElement = { tagName: "BODY", isContentEditable: false };
      const delEv26 = { key: "Delete", preventDefault() { delEv26.prevented = true; } };
      sandbox.ltGraphKeyDown(delEv26, task26, g26);
      eqNum(dels26.edge, 1, "真跑：Delete 键删掉选中的那条连线");
      eqNum(delEv26.prevented, true, "Delete 被吃掉（不触发浏览器 / 宿主的默认行为）");
      eqNum(evalIn26("ltSel.edge"), "", "删完选中清空（不会留一条幽灵选中）");
      bodyKids.length = 0;
      sandbox.ltGraphKeyDown({ key: "Delete", preventDefault() {} }, task26, g26);
      eqNum(dels26.node, 0, "没选中时按 Delete 只给提示，不误删（也不抛错）");
      /* ⑤ 光标在输入框里：Delete / Backspace 让给输入框，绝不当成删节点（先钉守卫，再钉真删） */
      evalIn26('ltSel.path = "a"; ltSel.edge = "";');
      sandbox.document.activeElement = { tagName: "INPUT", isContentEditable: false };
      sandbox.ltGraphKeyDown({ key: "Delete", preventDefault() {} }, task26, g26);
      eqNum(dels26.node, 0, "输入框（INPUT）里的 Delete 不删节点（键归输入框自己）");
      sandbox.document.activeElement = { tagName: "DIV", isContentEditable: true };
      sandbox.ltGraphKeyDown({ key: "Backspace", preventDefault() {} }, task26, g26);
      eqNum(dels26.node, 0, "contenteditable 里的 Backspace 同样不删节点");
      /* ⑥ 画布拿着焦点、选着节点：Delete 真删掉它（选中对象消失后，删除项也不再出现） */
      sandbox.document.activeElement = { tagName: "BODY", isContentEditable: false };
      sandbox.ltGraphKeyDown({ key: "Delete", preventDefault() {} }, task26, g26);
      eqNum(dels26.node, 1, "真跑：画布拿着焦点、选着节点时 Delete 删掉它");
      eqNum(g26.nodes.length, 1, "真跑：图里的节点数从 2 变 1（删的是选中的那个）");
      eqNum(evalIn26("ltCtxDelSel()"), null, "删完选中清空：右键菜单里不再有「按名删除」的幽灵项");
      /* ⑦ 换一张图再删一次（Backspace 同口径）；'a' 这类字符键一律不删 */
      sandbox.__g27 = { ver: 1, nodes: [{ id: "a", x: 24, y: 24, w: 200, h: 80, kind: "agent", title: "起草", cfg: {} }], edges: [] };
      sandbox.__t27 = { uid: "t27", graph: sandbox.__g27 };
      evalIn26("ltCurGraph = () => ({ graph: __g27, task: null, run: null, depth: 0 }); ltSel.path = 'a'; ltSel.edge = '';");
      sandbox.ltGraphKeyDown({ key: "a", preventDefault() {} }, sandbox.__t27, sandbox.__g27);
      eqNum(dels26.node, 1, "别的键（字符键）不触发删除");
      sandbox.ltGraphKeyDown({ key: "Backspace", preventDefault() {} }, sandbox.__t27, sandbox.__g27);
      eqNum(dels26.node, 2, "画布拿着焦点时 Backspace 也当删除（与 Delete 同口径）");
      evalIn26("ltDeleteSel = __origDel26; ltRenderStrip = __renderStrip26; ltCurGraph = __origCur26; ltSel.path = \"\"; ltSel.edge = \"\";");
      /* ⑧ 真跑「写进活图」：开菜单前那次 ltRenderStrip() 已经先把事件里抓到的 task / g 变成孤儿
         （ltEnsure 每次重绘都换一份深拷贝，见 [15]）。所以右键创建 / 删除必须在**落笔那一刻**
         重新解析活图：节点写进孤儿 = 一重绘就没了，界面上一个字都不变 —— 症状正是
         「长任务画布右键创建无效」（删除选中同理，静默失效）。 */
      const prevWf26 = sandbox.S.wf;
      const liveCtxTask = { uid: "tC", ver: 3, graph: { ver: 3, nodes: [{ id: "x", x: 24, y: 24, w: 200, h: 80, kind: "agent", title: "起草", cfg: {} }], edges: [] } };
      sandbox.S.wf = { id: "wf-ctx", longtask: { active: "tC", tasks: [liveCtxTask] } };
      evalIn26("ltDrill = [];");
      const orphanCtx = JSON.parse(JSON.stringify(liveCtxTask.graph)); /* 重绘前那一份（同坐标，已不在 wf.longtask 上） */
      const orphanTask = { uid: "tC", ver: 3, graph: orphanCtx };
      sandbox.ltAddNode(orphanTask, orphanCtx, "human");
      eqNum(liveCtxTask.graph.nodes.length, 2, "真跑：右键创建写进活图（节点真的加上去了，不是无声无效）");
      eqNum(liveCtxTask.graph.nodes[1].kind, "human", "加进去的是菜单里选的那一类环节");
      eqNum(liveCtxTask.ver, 4, "活任务的图版本 +1（改图跟着存盘）");
      eqNum(orphanCtx.nodes.length, 1, "孤儿一个字都没改（旧写法就是写在这里，所以右键创建无声无效）");
      eqNum(orphanTask.ver, 3, "孤儿任务的版本也没动（写孤儿 = 什么都没发生）");
      /* 删除同一口径：删的必须是活图里的那一个 */
      evalIn26('ltSel.path = "x"; ltSel.edge = "";');
      sandbox.ltDeleteSel(orphanTask, orphanCtx);
      eqNum(liveCtxTask.graph.nodes.filter((n) => n.id === "x").length, 0, "真跑：删除从活图里删（选中的 x 没了）");
      eqNum(orphanCtx.nodes.filter((n) => n.id === "x").length, 1, "孤儿里的 x 一直没动（旧写法在这上面删，界面纹丝不动）");
      eqNum(evalIn26("ltSel.path"), "", "删完选中清空（不留幽灵选中）");
      sandbox.S.wf = prevWf26;
      evalIn26('ltSel.path = ""; ltSel.edge = ""; ltDrill = [];');
      sandbox.document.activeElement = null;
    }
  }

  /* ── [13] 需求 3：滚轮缩放（真跑 ltGraphWheel 的锚定换算 + 按画布记忆） ── */
  console.log("\n[13] 长任务画布滚轮缩放：锚定光标 / 上下限 / 按画布记忆 / 复位（真跑，不是 grep）");
  has(LTU, 'holder.addEventListener("wheel"', "画布接了 wheel（滚轮即缩放）");
  has(LTU, "passive: false", "监听是 passive:false（缩放要能吃掉默认滚动）");
  has(LTU, 'ltGraphViewBox(g, box.width || 900).join(" ")', "缩放落在 viewBox 上（不整块重绘，拖动不被打断）");
  has(LTU, 'querySelector(".lt-btn-zoom")', "百分数回显跟着滚轮走");
  has(LTU, "lt-btn-zoom", "第一行（面包屑那行）有缩放回显 / 复位键");
  has(LTCSS, ".lt-crumb .lt-btn-zoom", "回显样式在（挂在面包屑那一行右端，不给自己独占一行）");
  ok(/const LT_ZOOM_MIN = 0\.25/.test(LTU) && /const LT_ZOOM_MAX = 4/.test(LTU), "缩放区间 25%–400%（写死在常量里，越界一律夹住）");
  {
    const vbSet = {};
    const fakeSvg = {
      getAttribute: (k) => (k === "viewBox" ? "0 0 800 240" : null),
      setAttribute: (k, v) => { vbSet[k] = v; },
      getBoundingClientRect: () => ({ width: 800, height: 240, left: 0, top: 0 }),
    };
    const fakeHolder = {
      clientWidth: 800,
      getBoundingClientRect: () => ({ width: 800, height: 240 }),
      style: { setProperty: () => {} },
      parentNode: null,
    };
    /* 盒 800×240 / viewBox 800×240（视口比内容大时以盒子为准）：等比 s=1，留白 0；
       光标 (400,120) = 图坐标中心 (400,120)。先复位，免得上一条用例留下的视野串味。 */
    sandbox.ltViewSet({ x: 0, y: 0, z: 1 });
    const fakeGraph = { nodes: [{ id: "a", x: 0, y: 0, w: 600, h: 80 }] }; /* 内容包围盒 = 660 × 240 < 视口 */
    const wheelAt = () => sandbox.ltGraphWheel({ deltaY: -1, clientX: 400, clientY: 120, preventDefault: () => {} }, fakeHolder, fakeSvg, fakeGraph);
    const expectX = 400 - 400 / 1.12;
    const expectY = 120 - 120 / 1.12;
    wheelAt();
    const parts = String(vbSet.viewBox).split(" ").map(Number);
    eqNum(Math.round(parts[0]), Math.round(43), "放大 1.12 倍：viewBox 原点按「光标下的图坐标不动」平移（400 → 400 − 400/1.12）");
    eqNum(Math.round(parts[1]), Math.round(expectY), "纵向同样锚定光标（不会跳走）");
    eqNum(Math.round(parts[2]), Math.round(800 / 1.12), "可视宽度收到 视口/1.12（等比缩放，点阵跟着重算）");
    eqNum(Math.round(parts[3]), Math.round(240 / 1.12), "可视高度同步收");
    eqNum(Math.round(sandbox.S.wfViews["wf-test"].ltView.z * 100), 112, "缩放值按画布记忆（S.wfViews[wfId].ltView）");
    sandbox.ltGraphWheel({ deltaY: 1, clientX: 400, clientY: 120, preventDefault: () => {} }, fakeHolder, fakeSvg, fakeGraph);
    eqNum(Math.round(sandbox.S.wfViews["wf-test"].ltView.z * 100), 100, "滚回来正好回到 100%");
    for (let i = 0; i < 40; i++) wheelAt();
    eqNum(sandbox.S.wfViews["wf-test"].ltView.z, 4, "一直放大封顶 400%（不会缩到看不见 / 放到失控）");
    sandbox.ltViewSet({ x: 0, y: 0, z: 1 });
    eqNum(sandbox.S.wfViews["wf-test"].ltView.z, 1, "复位回 100%");
  }

  /* ── [15] 拖动 / 连线写进「活图」：ltEnsure 每次重绘都换一份深拷贝 ──
     ltRenderStrip() 每次都走 ltEnsure()，而它把 wf.longtask.tasks 整批换成 ltNormGraph()
     深拷贝的新对象。节点 pointerdown 里那次重绘一发生，pointerdown 之前抓到的 g 就是孤儿：
     节点坐标、新建的边全写进孤儿里，一松手重绘读活图 → 改动全丢（节点拖了弹回、连线连不上）。
     这里钉住：拖动 / 落点每帧重新解析活图；连线在拖动期间就地跟手。 */
  console.log("\n[15] 长任务画布拖动：写进活图（不被 ltEnsure 的深拷贝吃掉）+ 连线跟手");
  has(LTU, "function ltLiveGraph(", "有 ltLiveGraph：按 wf 重新解析此刻活的那份图");
  has(LTU, "function ltEdgeGeo(", "边几何抽成 ltEdgeGeo（渲染与拖动共用一份，线不会各算各的）");
  has(LTU, "function ltDragEdgesSync(", "有 ltDragEdgesSync：拖动节点时就地改相连边的 d");
  has(LTU, "ltLiveGraph(ltDrag.wf, ltDrag.g)", "拖动每帧重新解析活图（不跨重绘复用 pointerdown 那刻的引用）");
  has(LTU, "ltDragEdgesSync(g, host, ltDrag.id)", "节点移动后连线就地跟手（不整块重绘，手势不被掐断）");
  has(LTU, 'p.setAttribute("data-lt-edge", String(e.id))', "边 path 带 data-lt-edge：拖动时按 id 找回这条线");
  has(LTU, 't.setAttribute("data-lt-edge-label", String(e.id))', "边标签同样带 id（拖动时标签跟着走）");
  has(LTU, "wf: wf,", "拖动 / 连线状态里存下 wf：解析活图要用");
  hasnt(LTU, "ltDrag.g.edges.push(", "新建的边不写进可能已过期的 ltDrag.g（写孤儿 = 拖半天连不上）");
  {
    const evalIn = (code) => vm.runInContext(code, sandbox);
    const liveTask = {
      uid: "t1",
      graph: { ver: 1, nodes: [{ id: "a", x: 24, y: 24, w: 200, h: 80, kind: "agent", title: "A", cfg: {} }, { id: "b", x: 400, y: 24, w: 200, h: 80, kind: "end_ok", title: "B", cfg: {} }], edges: [{ id: "e1", from: "a", to: "b", label: "", cond: "" }] },
    };
    sandbox.S.wf = { id: "wf-live", longtask: { active: "t1", tasks: [liveTask] } };
    sandbox.S.wfViews = {};
    evalIn("ltDrill = [];");
    const snapBak = sandbox.S.config.snap;
    sandbox.S.config.snap = 4;
    const pathSet = {};
    const dragSvg = {
      getAttribute: (k) => (k === "viewBox" ? "0 0 900 300" : null),
      getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }),
      querySelectorAll: (sel) => (/path\.lt-edge/.test(sel) ? [{ getAttribute: () => "e1", setAttribute: (k, v) => { pathSet[k] = v; } }] : []),
    };
    const movedEl = { setAttribute: (k, v) => { if (k === "transform") pathSet.transform = v; } };
    const dragHolder = {
      classList: { add() {}, remove() {} },
      querySelector: (sel) => (/^svg\.lt-svg$/.test(sel) ? dragSvg : /data-lt-id/.test(sel) ? movedEl : null),
    };
    sandbox.document.querySelector = () => dragHolder;
    /* 孤儿 = ltEnsure 深拷贝换掉的那一份（坐标同起点，但已经不在 wf.longtask.tasks 上） */
    const orphan = JSON.parse(JSON.stringify(liveTask.graph));
    evalIn('ltDrag = { mode: "move", id: "a", path: "a", wf: S.wf, g: ' + JSON.stringify(orphan) + ', x0: 100, y0: 100, nx: 24, ny: 24, gx0: 100, gy0: 100, moved: false };');
    sandbox.ltDragMove({ clientX: 148, clientY: 100, buttons: 1 });
    eqNum(liveTask.graph.nodes[0].x, 72, "鼠标右移 48px → 活图里的节点 x = 24 + 48（写进活图，松手不会被深拷贝冲掉）");
    eqNum(evalIn("ltDrag.g === S.wf.longtask.tasks[0].graph"), true, "拖动中 ltDrag.g 已被换成活图（不再是 pointerdown 那刻的孤儿）");
    eqNum(orphan.nodes[0].x, 24, "孤儿对象一个字都没改（旧写法就是写在这里，所以节点拖了弹回原点）");
    ok(String(pathSet.d).indexOf("272") >= 0, "相连边的 d 就地跟着节点走（起点 72 + 宽 200 = 272，拖动期间连线跟手）");
    eqNum(pathSet.transform, "translate(72,24)", "节点组同样就地移动");
    evalIn("ltDrag = null;");
    sandbox.S.config.snap = snapBak;
  }

  /* ── [16] 环节 ↔ 绑定会话：过程日志搬进左侧会话，条带右栏不再堆 run.log ──
     需求：长任务跑 Agent 环节时，为每个环节建一条绑定「该 run · 该环节」的会话
     （同一 run 内重试 / 回跳 / 重启续跑都复用同一条）；伪节点经运行期注册表接入
     liveNodeForSession，左栏点亮「运行中」；会话归属标记 ltBound 随盘走。 */
  console.log("\n[16] 环节 ↔ 绑定会话：右栏去日志 / run+path 复用 / 注册表 / ltBound / i18n");
  {
    /* ① 右栏不再渲染 run.log（静态：整段去注释后不许再读它；run.log 仍由引擎写，档案不丢） */
    const side = LTU.slice(LTU.indexOf("function ltRenderSide("), LTU.indexOf("function ltField("));
    const sideCode = side.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    hasnt(sideCode, "run.log", "ltRenderSide 正文不再读 run.log（运行日志从右栏撤走）");
    has(LTU, "运行日志不再在这里渲染", "撤走处留了说明：run.log 仍是运行档案（继续写、随 checkpoint 落盘）");
    has(LTV, "run.log.push(", "引擎仍把过程写进 run.log（档案没丢，只是不再堆在条带上）");
    has(side, "ltHumanCard", "右栏仍渲染「等你处理」人工卡（没有连带砍掉）");
    has(side, "ltNodeInspector", "右栏仍渲染节点检查器");
    has(side, "ltOverviewInspector", "右栏仍渲染图说明");

    /* ② 装配：绑定真源 run.sessions[path]，同一 run 同一环节复用同一条会话 */
    has(LTV, "function ltBindAgentSession(run, path, node, pn)", "有 ltBindAgentSession：把环节装到一条会话上");
    has(LTV, 'const sid = String(run.sessions[key] || "")', "先按 path 取这个 run 已绑的会话 id（绑定真源 run.sessions[path]）");
    has(LTV, "let st = sid ? list.find((s) => s && s.id === sid) || null : null;", "取到就复用（重试 / 回跳不刷出新会话）");
    has(LTV, "if (!st) {", "只有取不到才新建（if (!st) 是唯一的新建分支）");
    has(LTV, "agentContractSession({", "新建走会话基建 agentContractSession（不自己造会话对象）");
    has(LTV, "run.sessions[key] = st.id;", "新会话 id 立刻写回 run.sessions[path]（随 checkpoint 落盘，重启续跑仍用它）");
    has(LTV, 'run.sessions = run.sessions && typeof run.sessions === "object" ? run.sessions : {};', "run.sessions 缺省当归一（老 checkpoint 没有这个字段也不炸）");
    has(LTV, "S.agentActiveId = prevActive;", "后台建会话不抢焦点（建完把用户正在看的会话还回去）");

    /* ③ 伪节点带 agentSessionId + 运行期注册表 S.ltLiveNodes */
    has(LTV, "function ltLiveNodeRegistry()", "有运行期注册表入口 ltLiveNodeRegistry");
    has(LTV, "pn.agentSessionId = st.id;", "伪节点带上 agentSessionId（会话页据此认领节点镜像）");
    has(LTV, "if (reg) reg[st.id] = pn;", "伪节点按会话 id 登记进注册表");
    has(LTV, "if (reg && sid) delete reg[sid];", "收尾退掉注册（左栏「运行中」随之熄灭）");
    has(LTV, "if (pn) pn.running = false;", "收尾把伪节点标成不再运行");
    has(LTV, 'st.messages.push({ role: "assistant", content: body, _src: "longtask"', "收尾把最终正文 / 报错补成会话里的一条 assistant 消息（停下来的仍可回看）");

    /* ④ app-db.js 的 liveNodeForSession 认这份注册表 */
    has(DB, "function liveNodeForSession(st)", "app-db.js 有会话 → 节点镜像 liveNodeForSession");
    has(DB, "if (S.ltLiveNodes && S.ltLiveNodes[st.id]) return S.ltLiveNodes[st.id];", "liveNodeForSession 先认运行期注册表（伪节点不在任何画布 nodes 里，扫描扫不到）");

    /* ⑤ persistAgentSession 把 ltBound 落盘；app-boot 水合用 Object.assign 原样带回 */
    has(ASSIST, "async function persistAgentSession()", "app-assist.js 有 persistAgentSession");
    {
      const pStart = ASSIST.indexOf("async function persistAgentSession(");
      const pSeg = ASSIST.slice(pStart, ASSIST.indexOf("/* 会话发送队列", pStart) > 0 ? ASSIST.indexOf("/* 会话发送队列", pStart) : pStart + 6000);
      has(pSeg, "ltBound:", "ltBound 就在 persistAgentSession 的落盘对象里（会话归属随盘走）");
      has(pSeg, 'wfId: String(s.ltBound.wfId || "")', "ltBound.wfId 归一（缺字段不写成 undefined）");
      has(pSeg, 'runId: String(s.ltBound.runId || "")', "ltBound.runId 归一");
      has(pSeg, 'path: String(s.ltBound.path || "")', "ltBound.path 归一");
    }
    has(ASSIST, 's.ltBound && typeof s.ltBound === "object"', "会话没绑长任务时 ltBound 落 null（普通会话不受影响）");
    {
      const hStart = BOOT.indexOf("S.agentSessions = S.config.agentSessions.map(");
      const hSeg = hStart >= 0 ? BOOT.slice(hStart, BOOT.indexOf("S.agentActiveId = S.config.agentActiveId")) : "";
      ok(hSeg.length > 0, "找到 app-boot 的会话水合段");
      has(hSeg, "Object.assign(", "水合以 Object.assign 兜底：白名单外的 ltBound 原样带回，不丢归属");
    }

    /* 真跑：同一 run 同一 path 复用；不同 path 各一条；重启续跑（带 run.sessions）仍复用 */
    const sessList = [];
    let created = 0;
    sandbox.agentSessions = () => sessList;
    sandbox.agentContractSession = (o) => {
      created++;
      const s = { id: "as_" + created, title: o.title, messages: [], canvasWfId: o.canvasWfId };
      sessList.push(s);
      return s;
    };
    sandbox.window.api.ltRunSave = () => Promise.resolve();
    sandbox.S.ltLiveNodes = {};
    sandbox.S.agentActiveId = "as_user";
    const run16 = { runId: "r16", wfId: "wf-test", name: "出片", nodes: {} };
    const nodeA = { title: "起草", cfg: {} };
    const pnA = sandbox.ltPseudoNode(run16, "a", nodeA);
    const sA = sandbox.ltBindAgentSession(run16, "a", nodeA, pnA);
    eqNum(created, 1, "第一次执行：为这一环节建一条会话");
    eqNum(run16.sessions.a, sA.id, "会话 id 记进 run.sessions[path]（绑定真源）");
    eqNum(pnA.agentSessionId, sA.id, "伪节点带上 agentSessionId");
    ok(sandbox.S.ltLiveNodes[sA.id] === pnA, "伪节点已登记进运行期注册表 S.ltLiveNodes[会话id]");
    eqNum(sandbox.S.agentActiveId, "as_user", "后台建会话不抢用户当前视图（agentActiveId 原样还回）");
    ok(
      String(sA.title).indexOf("长任务") === 0 && String(sA.title).indexOf("出片") > 0 && String(sA.title).indexOf("起草") > 0,
      "会话标题带「长任务 · 任务名 · 环节名」（左栏一眼认出是哪一环）",
    );
    const sA2 = sandbox.ltBindAgentSession(run16, "a", nodeA, sandbox.ltPseudoNode(run16, "a", nodeA));
    eqNum(created, 1, "同一 run 同一环节再执行（重试 / 回跳）复用同一条会话，绝不刷出新的");
    ok(sA2 === sA, "复用返回的就是原会话对象");
    const nodeB = { title: "定稿", cfg: {} };
    const pnB = sandbox.ltPseudoNode(run16, "b", nodeB);
    const sB = sandbox.ltBindAgentSession(run16, "b", nodeB, pnB);
    eqNum(created, 2, "不同环节各有一条自己的会话");
    ok(sB !== sA, "两条环节的会话互不串台");
    const run16b = { runId: "r16", wfId: "wf-test", name: "出片", nodes: {}, sessions: { a: sA.id } };
    const sA3 = sandbox.ltBindAgentSession(run16b, "a", nodeA, sandbox.ltPseudoNode(run16b, "a", nodeA));
    eqNum(created, 2, "重启续跑（run 从 checkpoint 恢复、带着 run.sessions）仍复用原会话");
    ok(sA3 === sA, "续跑接上的是同一条会话（历史不丢）");

    /* 收尾：成功 → 正文进会话；未完成 → 带原因进会话；注册表一律退掉 */
    sandbox.ltSetStat(run16, "a", "done");
    sandbox.ltReleaseAgentSession(run16, "a", pnA, sA, "交付正文");
    eqNum(sA.messages[sA.messages.length - 1].content, "交付正文", "成功后：最终正文补成会话里的一条 assistant 消息");
    eqNum(sA.messages[sA.messages.length - 1].role, "assistant", "补的是 assistant 消息（会话视图正常渲染）");
    ok(!sandbox.S.ltLiveNodes[sA.id], "收尾退掉运行期注册（左栏「运行中」熄灭）");
    eqNum(pnA.running, false, "收尾把伪节点标成不再运行");
    sandbox.ltSetStat(run16, "b", "failed", { err: "模型超时" });
    sandbox.ltReleaseAgentSession(run16, "b", pnB, sB, "");
    const failMsg = String(sB.messages[sB.messages.length - 1].content || "");
    ok(failMsg.indexOf("环节未完成") >= 0 && failMsg.indexOf("模型超时") >= 0, "未完成收尾：会话里是带原因的一行（不是空消息 / 不是成功文案）");
    ok(!sandbox.S.ltLiveNodes[sB.id], "失败收尾同样退掉注册");

    /* liveNodeForSession：真跑源码（注册表命中 → 直返；未命中 → 回落画布扫描） */
    const lnSrc = DB.slice(DB.indexOf("function liveNodeForSession("), DB.indexOf("function sessionIsRunning("));
    const lvS = { wf: null, wfBag: {}, ltLiveNodes: { as_x: { id: "ltr_r16_a", kind: "agent_task", running: true } } };
    const liveNodeOf = vm.runInNewContext(lnSrc + "\n;liveNodeForSession;", { S: lvS });
    ok(liveNodeOf({ id: "as_x" }) === lvS.ltLiveNodes.as_x, "注册表命中的会话 → 直接返回伪节点（长任务伪节点不在画布 nodes 里）");
    eqNum(liveNodeOf({ id: "as_none" }), null, "注册表 / 画布都没有 → null（普通会话不被误认成在跑）");
    lvS.wf = { nodes: [{ id: "n1", kind: "agent_task", running: true, agentSessionId: "as_plain" }] };
    eqNum(liveNodeOf({ id: "as_plain" }).id, "n1", "注册表没有时仍回落到画布扫描（既有口径不丢）");
    eqNum(liveNodeOf(null), null, "没有会话对象 → null");

    /* ⑥ i18n：这套文案有 EN 词条（切英文不出现中文半截） */
    const I16 = require("../renderer/i18n.js");
    I16.setLocale("en");
    const keys16 = ["长任务", "环节", "（本环节没有正文输出）", "环节未完成：", "未知原因"];
    const miss16 = keys16.filter((k) => I16.t(k) === k);
    eqNum(miss16.length, 0, "i18n 中英词条齐备（会话标题 / 收尾文案都有 EN 译文）" + (miss16.length ? "（缺：" + miss16.join(" / ") + "）" : ""));
    I16.setLocale("zh");
    for (const k of keys16) has(I18N, '"' + k + '":', "i18n 源文件里有「" + k + "」的 EN 词条");
  }

  /* ── [17] 橡皮筋虚线端点：绝对换算必须加回 viewBox 原点 ──
     真机（Electron 真 DOM）复现过：平移把 viewBox 原点写成非零（ltGraphViewBox 的
     [v.x, v.y, …]），而屏幕→图坐标的绝对换算漏了 +view.x/+view.y —— 平移之后橡皮筋
     虚线末尾就停在离鼠标 (view.x·s, view.y·s) 像素的地方（拖到哪儿都差一截），
     松手落点命中同样整体偏一个原点。这里把这份换算钉住（拖动中的**增量**两边同坐标系，
     原点自动抵消，不受影响）。 */
  console.log("\n[17] 长任务画布连线橡皮筋：虚线末端跟着鼠标（绝对换算加回 viewBox 原点）");
  has(LTU, "function ltGraphPointOf(svg, clientX, clientY) {", "有 ltGraphPointOf：全画布唯一一份「屏幕 → 图坐标」绝对换算");
  has(LTU, "+ (Number(view.x) || 0)", "换算里加回 viewBox 原点 x（平移后虚线末端不再整体偏一个平移量）");
  has(LTU, "+ (Number(view.y) || 0)", "纵向同理");
  has(LTU, "return ltGraphPointOf(svg, ev && ev.clientX, ev && ev.clientY);", "ltWirePoint 只是它的薄封装（橡皮筋终点与命中测试同源，不会各算各的）");
  has(LTU, "const at = ltGraphPointOf(svg, ev && ev.clientX, ev && ev.clientY);", "ltHitNode 命中测试同走这一份换算（落点跟着鼠标）");
  {
    /* 盒 900×300 / viewBox「-120 -40 1200 240」：等比 s = 0.75、留白 offX=0 / offY=60
       （与真机实测一致）。鼠标 (500,180) → 图坐标 = 原点 + 屏幕增量 / s。 */
    const panned = {
      getAttribute: (k) => (k === "viewBox" ? "-120 -40 1200 240" : null),
      getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }),
      closest: () => ({ clientWidth: 900 }),
    };
    const to = sandbox.ltWirePoint(panned, { clientX: 500, clientY: 180 });
    eqNum(Math.round(to.x), Math.round(-120 + 500 / 0.75), "平移后橡皮筋终点横向 = viewBox 原点 + 屏幕增量 / 等比系数（真机实测鼠标底下）");
    eqNum(Math.round(to.y), Math.round(-40 + (180 - 60) / 0.75), "纵向同样把原点加回来（漏了这个就是「虚线末尾不在鼠标位置」）");
    /* 上面这一对被钉在卡片上的点 = 新的正确落点 */
    eqNum(sandbox.ltHitNode({ nodes: [{ id: "a", x: 500, y: 100, w: 120, h: 60 }] }, panned, { clientX: 500, clientY: 180 }), "a", "命中测试用同一份换算：鼠标底下的节点接得住线");
    eqNum(sandbox.ltHitNode({ nodes: [{ id: "b", x: 660, y: 150, w: 60, h: 40 }] }, panned, { clientX: 500, clientY: 180 }), "", "漏加原点的旧落点（+120/+40）不再被误命中（偏的是真 bug，不是宽容度）");
    /* 原点为 0（没平移过）时口径不变：不该顺手改动既有行为 */
    const plain = {
      getAttribute: (k) => (k === "viewBox" ? "0 0 900 300" : null),
      getBoundingClientRect: () => ({ width: 900, height: 300, left: 0, top: 0 }),
      closest: () => ({ clientWidth: 900 }),
    };
    const p0 = sandbox.ltWirePoint(plain, { clientX: 500, clientY: 180 });
    ok(Math.abs(p0.x - 500) < 1e-9 && Math.abs(p0.y - 180) < 1e-9, "视野未平移（原点 0）时换算与旧口径一字不差（s=1、留白 0）");
    /* 等比居中的留白照样先减掉：盒 900×300 / viewBox 1200×240 → offY=60、原点仍加回 */
    const boxed = {
      getAttribute: (k) => (k === "viewBox" ? "-120 -40 1200 240" : null),
      getBoundingClientRect: () => ({ width: 900, height: 300, left: 10, top: 20 }),
      closest: () => ({ clientWidth: 900 }),
    };
    const pb = sandbox.ltWirePoint(boxed, { clientX: 510, clientY: 200 });
    ok(Math.abs(pb.x - to.x) < 1e-9 && Math.abs(pb.y - to.y) < 1e-9, "svg 不在视口原点（left/top 非 0）时，留白与原点换算一并成立（同一鼠标位置同一图坐标）");
  }

  /* ── [18] 长任务画布状态节点：文字按卡片宽度截断 + 裁剪兜底 + 右下角拖拽缩放 ──
     真机复现过的 bug：SVG <text> 不会被 <rect> 挡住，而截断走的是**字符数**口径
     （ltStr(...,26) / ltBrk(...,24)），中文「目标 / 说明」在默认 192px 卡片上必然探出卡片外。
     修法两道：① 截断列数由当帧 n.w 现算（ltColsOf）；② 文字层挂 clipPath 兜底。
     另加右下角缩放手柄（.lt-nd-resize）：拉宽后松手整块重绘按新宽度重排 = 看更多文字。 */
  console.log("\n[18] 长任务画布节点：按宽度截断 + 裁剪兜底 + 右下角拖拽缩放");
  /* ① 截断走「显示宽度」口径，写死的字符数口径一律清掉 */
  has(LTU, "function ltColsOf(wpx, fontPx)", "有 ltColsOf：按卡片可视宽度算列预算（字号取该行 CSS 真实字号）");
  has(LTU, "function ltTextCols(s)", "有 ltTextCols：一段文本占几格（用于扣掉行首图标 / 右上角标的占位）");
  has(LTU, "t.textContent = ltBrk(n.title, ltColsOf(ltInnerW - roundW, 13));", "标题列数由内宽现算（标题 13px）");
  has(LTU, "sub.textContent = ltNodeSummary(run, path, n, st, ltInnerW);", "摘要按当帧内宽截断（ltNodeSummary 加宽度入参）");
  has(LTU, "const cols = ltColsOf(wpx, 9.5);", "子任务行按内宽算列（9.5px 行）");
  has(LTU, "n._ltRows = ltTaskRows(run, path, n, st, Math.max(60, Number(n.w) - 20));", "渲染前按 n.w - 左右内边距算这一帧的行（调用点传当帧 n.w）");
  hasnt(LTU, "ltStr(n.title, 22)", "渲染处不再用写死的字符数截断（标题 22 字）");
  hasnt(LTU, "ltBrk(s, 24)", "渲染处不再用写死的字符数截断（子任务行 24 格）");
  hasnt(LTU, "ltBrk(s, 22)", "渲染处不再用写死的字符数截断（子任务行 22 格）");
  /* ② 裁剪兜底：文字层单独包一层 g 受 clip-path 约束，端子 / 下钻角标留在层外 */
  has(LTU, "function ltClipId(path)", "有 ltClipId：按 path 生成唯一 clip id（path 里可能带 / 等字符）");
  has(LTU, 'document.createElementNS("http://www.w3.org/2000/svg", "clipPath")', "每个节点挂一枚 clipPath（矩形同卡片尺寸）");
  has(LTU, 'ltTexts.setAttribute("clip-path", "url(#" + ltClip + ")");', "全部文字放进受裁剪的 g（异常长串也画不出卡片）");
  has(LTU, "const ltTexts = document.createElementNS(\"http://www.w3.org/2000/svg\", \"g\");", "文字层单独包一层 g（裁剪只作用于它）");
  /* ③ 右下角缩放手柄 */
  has(LTU, "const LT_ND_RESIZE = 14;", "手柄尺寸常量（右下角 14px 方块）");
  has(LTU, 'rs.setAttribute("class", "lt-nd-resize");', "节点组末尾挂 .lt-nd-resize 手柄");
  has(LTU, 'grip.setAttribute("x", n.w - LT_ND_RESIZE);', "拖动中手柄跟着卡片右下角走");
  has(LTU, 'mode: "ltresize",', "pointerdown 进 ltresize 模式（记 w0/h0 与当帧图坐标 gx0/gy0）");
  has(LTU, "ev.stopPropagation();", "手柄起手 stopPropagation：不兼作拖节点");
  has(LTU, "if (Number(ev.button) !== 0) return;", "只接左键（中键交给平移、右键留给菜单）");
  /* ④ ltDragMove 的 ltresize 分支：写 n.w/n.h 并夹最小尺寸 */
  {
    const mv = LTU.slice(LTU.indexOf('if (ltDrag.mode === "ltresize") {'), LTU.indexOf('} else if (ltDrag.mode === "ltresize") {'));
    ok(mv.length > 0, "找到 ltDragMove 的 ltresize 分支");
    has(mv, "n.w = Math.max(140, snapFn(ltDrag.w0 + dx));", "宽度 = max(140, 吸附网格)，下限保证标题 / 摘要排得下");
    has(mv, "n.h = Math.max(minH, snapFn(ltDrag.h0 + dy));", "高度不低于内容所需（minH 由 ltNodeRenderH 同源算出）");
    has(mv, "ltLiveGraph(ltDrag.wf, ltDrag.g)", "每帧重解析活图（重绘换深拷贝后不写孤儿）");
    has(mv, "Math.abs(rdx) + Math.abs(rdy) <= 3", "3px 阈值与 move 分支同口径（纯点一下不算缩放）");
    has(mv, 'el.querySelector("rect.lt-nd-resize")', "就地同步手柄位置");
    has(mv, 'el.querySelector("circle.lt-port")', "右侧端子跟着走（连线端点不脱节）");
    has(mv, "ltDrag.clip", "同步缩放当帧裁剪层矩形（缩小时文字不短暂探出）");
  }
  /* ⑤ ltDragEnd 的 ltresize 分支：moved 时存盘，松手整块重绘 → 按新宽度重排 */
  {
    const ed = LTU.slice(LTU.indexOf('} else if (ltDrag.mode === "ltresize") {'), LTU.indexOf("function ltRenderGraph("));
    ok(ed.length > 0, "找到 ltDragEnd 的 ltresize 分支");
    has(ed, "ltDrag.moved || ltDrag.domMiss", "真的拖过（或 DOM 同步落空）才重绘");
    has(ed, "scheduleSave(true)", "moved 时把 w/h 随 task.graph 存盘");
  }
  /* ⑥ CSS：手柄常态透明 / hover 才显形 / nwse-resize 光标 */
  has(LTCSS, ".lt-nd rect.lt-nd-resize {", "CSS 有 .lt-nd rect.lt-nd-resize 规则");
  has(LTCSS, ".lt-nd rect.lt-nd-resize:hover,", "hover 才显形（常态不碍眼）");
  has(LTCSS, "cursor: nwse-resize", "光标与主画布缩放同口径（nwse-resize）");
  /* ⑦ 真行为：内宽越大列越多、同一段目标文字显示得越长（拉宽 = 看更多） */
  {
    const colsN = sandbox.ltColsOf(100, 9.5);
    const colsW = sandbox.ltColsOf(400, 9.5);
    ok(colsW > colsN, "内宽越大列预算越大（" + colsN + " → " + colsW + "）");
    const longGoal = "写一版初稿，请附带参考文献与对比说明，并给出下一步建议以及风险清单";
    const node = { id: "a", kind: "agent", title: "起草", cfg: { goal: longGoal } };
    const rn = sandbox.ltTaskRows(null, "a", node, null, 100);
    const rw = sandbox.ltTaskRows(null, "a", node, null, 400);
    ok(rn.length > 0 && rw.length > 0, "同一节点在窄 / 宽两种内宽下都排出行");
    ok(rw[0].text.length > rn[0].text.length, "拉宽后同一行显示更多文字（窄 " + rn[0].text.length + " 字 → 宽 " + rw[0].text.length + " 字）");
    ok(/…$/.test(rn[0].text), "窄卡片按宽度截断（末尾省略号）");
    ok(sandbox.ltTextCols(rw[0].icon + " " + rw[0].text) <= colsW + 2, "宽卡片这一行的显示宽度仍在列预算内（不再探出卡片）");
    ok(sandbox.ltBrk("中文标题很长很长很长很长很长", sandbox.ltColsOf(120, 13)) !== "中文标题很长很长很长很长很长", "ltBrk 对超出宽度的中文标题真的截断");
  }
  /* ⑧ i18n：新文案有 EN 词条（切英文不出现中文半截） */
  {
    const I18 = require("../renderer/i18n.js");
    I18.setLocale("en");
    const keys18 = ["拖右下角可调整节点大小 · 拉宽可多看几行说明", "拖拽调整节点大小", "节点文字超出了卡片，已按宽度截断（拉宽节点可看更多）"];
    const miss18 = keys18.filter((k) => I18.t(k) === k);
    eqNum(miss18.length, 0, "i18n 中英词条齐备（缩放 / 截断文案都有 EN 译文）" + (miss18.length ? "（缺：" + miss18.join(" / ") + "）" : ""));
    I18.setLocale("zh");
    for (const k of keys18) has(I18N, '"' + k + '":', "i18n 源文件里有「" + k + "」");
  }
  /* ⑨ 手册与实现同源（AGENTS.md：指南与帮助和实现同口径） */
  {
    const MAN = read("guides/manual/longtask.md");
    has(MAN, "按**卡片宽度截断**", "手册写明文字按卡片宽度截断、不再探出卡片");
    has(MAN, "**右下角**的小手柄", "手册写明拖右下角小手柄可缩放");
    has(MAN, "拉宽后文字按新的宽度重新排", "手册写明拉宽后按新宽度重排、多显示几行");
    has(MAN, "卡片大小随画布一起存盘", "手册写明缩放结果随画布存盘");
  }

  /* ── [19] 审批卡「未提交的输入」不许被重绘抹掉 ──
     ltRenderStrip() 整块重建右栏（main.innerHTML = ""）：长任务在跑时每次环节状态变化
     （ltTouchGraph → ltRenderStripSoon）都会走一遍，审批卡里的理由框于是被一只新的空
     textarea 换掉 —— 用户写了一半的驳回理由，点一下别处（失焦 / 任何一次重绘）就没了。
     口径：输入边写边记进草稿表，重绘按 key 还原；只有「通过 / 驳回」提交后才清。 */
  console.log("\n[19] 审批卡理由框：草稿随重绘留住、提交后才清");
  {
    has(LTU, "const LT_DRAFTS = Object.create(null);", "模块级草稿表 LT_DRAFTS（不挂 DOM、不落盘）");
    has(LTU, "function ltDraftBind(el, key)", "有 ltDraftBind：还原草稿 + 持续记录输入");
    has(LTU, 'el.oninput = () => ltDraftSet(key, el.value);', "输入即写草稿（每次编辑都留痕，不靠 change / blur）");
    has(LTU, 'const v = ltDraftGet(key);\n  if (v) el.value = v;', "重绘后新控件先还原草稿值");
    has(LTU, 'const whyKey = ltDraftKey(wpath, "why");\n    const why = ltDraftBind(ltEl("textarea", "lt-in lt-in-why"), whyKey);', "审批卡理由框走 ltDraftBind（不再是裸 textarea）");
    has(LTU, "ltTaHBind(why, whyKey);", "理由框手动拖出来的高度也按同一个草稿键记住（重绘不回弹，见 smoke-longtask-textarea-height.js）");
    has(LTU, "function ltDraftKey(path, field)", "草稿键 = 环路径 + 字段名（两个待办环节不串台）");
    has(LTU, 'const wpath = String(w && w.path ? w.path : "");', "ltHumanCard 取到本卡环节路径当草稿键");
    eqNum((LTU.match(/ltDraftClear\(ltDraftKey\(wpath, "why"\)\);/g) || []).length, 2, "通过 / 驳回两条提交路径都清草稿（各一次）");
    has(LTU, "for (const k of Object.keys(LT_DRAFTS)) delete LT_DRAFTS[k];", "切画布清空草稿表（上一张画布的话不带过来）");
    has(read("guides/manual/longtask.md"), "写到一半的内容会一直留着", "手册写明理由框内容会一直留存、只有提交 / 换画布才清");
    /* 真跑：草稿写入 → 「重绘」换一只新控件 → 值被还原 → 清掉后不再还原 */
    const mkBox = () => ({ value: "", oninput: null });
    sandbox.document.createElement = mkBox;
    let ta = sandbox.ltDraftBind(mkBox(), sandbox.ltDraftKey("h1", "why"));
    ok(ta.value === "", "首次渲染：没有草稿时理由框是空的（不凭空补字）");
    ta.value = "画面偏暗，重出，保留人物比例";
    ta.oninput();
    ta = sandbox.ltDraftBind(mkBox(), sandbox.ltDraftKey("h1", "why"));
    eqNum(ta.value, "画面偏暗，重出，保留人物比例", "重绘换成新控件后，写了一半的理由原位还原（不再被抹掉）");
    const other = sandbox.ltDraftBind(mkBox(), sandbox.ltDraftKey("h2", "why"));
    eqNum(other.value, "", "另一条待办环节的理由框不被串台草稿污染");
    sandbox.ltDraftClear(sandbox.ltDraftKey("h1", "why"));
    eqNum(sandbox.ltDraftBind(mkBox(), sandbox.ltDraftKey("h1", "why")).value, "", "提交（通过 / 驳回）后草稿清掉：下一轮理由框重新是空的");
  }

  /* ── [20] 交付条目录入卡不许引用外层变量（修 ReferenceError: node is not defined）──
     ltItemInput(parent, it, commit, path, uid, editing [, isDeliver]) 的形参里从来没有 node：
     它直接用外层 ltChecklistEditor 的 node 判「是不是交付模式」，函数一被独立调到（运行时
     场景）就抛 Uncaught ReferenceError: node is not defined —— 长任务画布里的人工交付卡
     整段渲染不出来。口径：判定由调用方（ltChecklistEditor，它手里才有 node）算好传进来。
     这类「函数体内引用外层变量」的错误 grep 抓不到，必须真跑一遍。 */
  console.log("\n[20] 交付条目录入卡：判定由调用方传入，卡片渲染不抛 ReferenceError（真跑）");
  {
    const SIG = "function ltItemInput(parent, it, commit, path, uid, editing, isDeliver, guardIn) {";
    has(LTU, SIG, "ltItemInput 的形参表里有 isDeliver（交付模式判定不再从函数体里现抓 node）");
    const body20 = LTU.slice(LTU.indexOf(SIG), LTU.indexOf("function ltNodeFilePaths("));
    hasnt(body20, "node.cfg", "函数体里不再出现 node.cfg（那是外层作用域的变量，独立调用即崩）");
    has(body20, "if (!editing && isDeliver)", "交付提示按传入的 isDeliver 判断");
    has(LTU, "editing, !!(node && node.cfg && node.cfg.mode === \"deliver\"), guard);", "调用方（ltChecklistEditor）算好 isDeliver 再传（node 在那里是形参，安全）");
    /* 真跑：文件类条目走 else 分支（就是抛错那条路径），把三种调用形态各跑一遍 */
    sandbox.document.createElement = (tag) => ({
      tagName: tag,
      className: "",
      textContent: "",
      type: "",
      title: "",
      onclick: null,
      value: "",
      children: [],
      appendChild(c) { this.children.push(c); },
    });
    const box20 = { children: [], appendChild(c) { this.children.push(c); } };
    sandbox.__box = box20;
    sandbox.__commit = async () => {};
    const probe20 = `
      function __probe20(editing, isDeliver) {
        const item = { id: "i1", kind: "file", title: "分镜表.md", desc: "每镜头一行", required: true, done: false, paths: [] };
        const w = ltItemInput(__box, item, __commit, "h1", "ltx-交稿", editing, isDeliver);
        return String(w.children.length) + "/" + String(w.className);
      }
      let __noThrow = false, __err = "", __runtime = "", __noHint = "", __editMode = "";
      try { __runtime = __probe20(false, true); __noThrow = true; } catch (e) { __err = String((e && e.message) || e); }
      try { __noHint = __probe20(false, false); } catch (e) { __noHint = "抛错：" + String((e && e.message) || e); }
      try { __editMode = __probe20(true, false); } catch (e) { __editMode = "抛错：" + String((e && e.message) || e); }
      ({ __noThrow, __err, __runtime, __noHint, __editMode });`;
    const r20 = vm.runInContext(probe20, sandbox);
    ok(r20.__noThrow, "运行时交付卡渲染不再抛 ReferenceError" + (r20.__noThrow ? "" : "（" + r20.__err + "）"));
    eqNum(r20.__runtime, "2/lt-item-in", "交付模式下：操作行 + 逐文件交付提示 = 2 块，且都挂在 .lt-item-in 里");
    eqNum(r20.__noHint, "1/lt-item-in", "非交付环节只剩操作行，不弹「逐文件交付」提示（提示挂错地方也是误导）");
    eqNum(r20.__editMode, "1/lt-item-in", "图定义态（editing=true）同样只有操作行：提示只给运行时的人看");
  }

  /* ── [21] 长期记忆生成的字符串级契约（本轮 Bug：长任务全程没生成任何记忆）──
     根因是提示词层：绝大多数环节都声明了输出键，而写记忆那句原本只落在「没声明输出键」
     的 else 分支里 —— 模型从头到尾没被告知要写记忆。三处都是字符串契约，退化起来无声无息
     （界面照样能跑，记忆库就是空的），所以在这里钉住。 */
  console.log("\n[21] 长期记忆纪律：每个 Agent 环节都要求写记忆（write / propose 判据 · json 兜底 · 落盘）");
  {
    has(LTV, "【长期记忆纪律】", "提示词里有常驻的「长期记忆纪律」段");
    has(LTV, "用 mtnode_facts（本画布 AI 事实库）写进极简条例", "write 判据写明：用户直说 / 已确认事项立即入库（工具改走 mtnode_facts）");
    has(LTV, "宿主会回收 memory / propose 键", "propose 判据写明：自己推断的结论走 json 兜底交用户确认（宿主回收 memory / propose 键）");
    hasnt(LTV, "用 lt_memory", "提示词不再点名已下线的 lt_memory（不指向不存在的工具）");
    has(LTV, '\\"memory\\":[{title, body, type, scope}]', "第三条给了正文 json 兜底格式（宿主 ltRecoverOutKeys 回收 memory / propose）");
    has(LTV, "【长期记忆】里列出的条目不要重复写", "第四条写明已召回条目去重（别把同一件事记十遍）");
    hasnt(LTV, "用 lt_state 提议记入记忆", "旧笔误「用 lt_state 提议记入记忆」已修正（笔误会让模型去调错工具）");
    /* 真跑 ltAgentPrompt：把纪律段在提示词里的落点与「环节有没有声明输出键」解耦。
       只看带 outKeys 的那一版会漏掉根因 —— 恰恰是声明了输出键的环节从不提记忆。 */
    const probe21 = `
      const n21 = (outKeys) => ({ kind: "agent", title: "分镜", cfg: { goal: "写分镜", outKeys } });
      const run21 = {
        runId: "r-mem21", taskId: "t-mem21", graph: { nodes: [], edges: [] },
        nodes: {}, ns: { a: {} }, fired: {}, inst: {}, waits: [], rounds: {}, opts: {},
        status: "running", aborted: false, log: [], memPending: [],
      };
      ({ withKeys: ltAgentPrompt(run21, "a", n21(["shot_list"]), []),
         noKeys: ltAgentPrompt(run21, "a", n21([]), []) });`;
    const P21 = vm.runInContext(probe21, sandbox);
    for (const [name, txt] of [["声明了输出键的环节", P21.withKeys], ["没声明输出键的环节", P21.noKeys]]) {
      has(txt, "【长期记忆纪律】", name + "：提示词含记忆纪律段（不靠输出键分支才出现）");
      has(txt, "mtnode_facts", name + "：点名工具 mtnode_facts（lt_memory 已下线）");
      has(txt, "极简条例", name + "：给出「写进极简条例」的入库口径");
      has(txt, "propose", name + "：给出 propose 待确认口径（json 兜底 + 宿主回收）");
      hasnt(txt, "lt_state 提议记入记忆", name + "：不再把写记忆指向 lt_state");
    }
    /* 段落位置：纪律段在【产出要求】之后、【边界】之前（边界是收尾段，纪律不能被它压到后面当补充说明）。 */
    {
      const iOut21 = P21.withKeys.indexOf("【产出要求】");
      const iMem21 = P21.withKeys.indexOf("【长期记忆纪律】");
      const iEdge21 = P21.withKeys.indexOf("【边界】");
      ok(iOut21 >= 0 && iMem21 > iOut21, "纪律段排在【产出要求】之后");
      ok(iEdge21 >= 0 && iMem21 < iEdge21, "纪律段排在【边界】之前（收尾段仍压尾）");
    }
    /* 分层口径：完整规范唯一留在渲染层提示词，工具描述只补一句卡口，不抄细则。 */
    /* lt_memory 下线后，卡口落在接棒工具的描述上（ai-facts-plugin.mjs 的 FACTS_DESC）：
       工具描述只留卡口，完整规范仍在渲染层提示词与技能 mtnode-ai-facts 里。 */
    const FACTS_PLUG = read("dsh/gateway/ai-facts-plugin.mjs");
    has(FACTS_PLUG, "条目纪律：一条一件事", "FACTS_DESC 补了条目纪律卡口（工具描述只留卡口）");
    has(FACTS_PLUG, "写之前先 query", "FACTS_DESC 给出 write 判据：先 query 再 write，避免重复");
    has(FACTS_PLUG, "冲突口径", "FACTS_DESC 给出冲突口径：以现文件 / 数据库为准");
    hasnt(FACTS_PLUG, "lt_memory", "接棒工具的描述不指向已下线的 lt_memory");
    {
      const seg21 = FACTS_PLUG.slice(FACTS_PLUG.indexOf("const FACTS_DESC"), FACTS_PLUG.indexOf("export function apply"));
      hasnt(seg21, "【长期记忆纪律】", "工具描述没把渲染层四条细则抄一份（分层不破）");
    }
    /* 第四个缺口：propose 出来的候选只活在内存里，重启 / 切画布就没了 —— 用户看到的就是「没生成记忆」。 */
    has(LTV, "memPending: [],", "run 里有 memPending（候选获得 run 归属）");
    has(LTV, "run.memPending = ltArr(run.memPending).concat(add).slice(-LT_MEM_PENDING_MAX);", "提出的候选挂进 run.memPending");
    has(LTV, "ltSave(run)", "候选随 run checkpoint 走既有 ltSave 通道落盘（重启不丢）");
    has(LTV, "LT_MEM_PENDING_MAX = 50", "单 run 候选有上限（checkpoint 不无限膨胀）");
    has(LTV, "function ltMemSyncPending(wfId)", "有回收口 ltMemSyncPending（启动 / 续跑 / 切画布重新合并）");
    has(LTV, "function ltMemMergeRun(run)", "有逐 run 合并口 ltMemMergeRun");
    has(LTV, "function ltMemDropPending(p)", "有摘除口 ltMemDropPending（接受 / 驳回后不复活）");
    has(LTV, "function ltMemForgetRun(runId)", "有清口 ltMemForgetRun（删任务收掉孤儿候选）");
    eqNum((LTV.match(/ltMemSyncPending\(wf\.id\);/g) || []).length, 3, "三个挂载点各合并一次：应用启动 / 切画布 · 续跑 · 启用");
    has(LTV, "ltMemForgetRun(runId);", "删除任务时清掉该 run 挂着的候选（不被按别的 scope 写进记忆库）");
    has(LTU, "ltMemDropPending(p)", "候选对话框的接受 / 驳回改走落盘摘除（原先只 splice 内存数组）");
    has(LTV, "run.memPending", "回收路径指向同一份 run.memPending（提出与摘除同一真源）");
  }

  /* ── [22] 三条口径（文件名 / 必填判据）钉成断言，防「两处拼名」再长回来 ──
     文件名口径：端子标签 · 板身 md 表头 · 上传对齐 · 交付必填判据 —— 全部只走一份取名口径
     （ltDeliverFileName：file → title 兜底，只认带后缀的写法）。散着写在两个文件里、
     谁也不知道对方的规则，正是「需要交付的内容有误」反复复发的根因。 */
  console.log("\n[22] 文件名口径（ltDeliverFileName）+ 端子标签 + md 表头「文件名」+ 必填判据含文件名");
  {
    has(LTV, "file: ltStr(r.file, 200),", "条目归一里有 file 字段（交付物文件名的真源）");
    const FN_SIG = "function ltDeliverFileName(it) {";
    has(LTV, FN_SIG, "取名口径收敛成 ltDeliverFileName（唯一真源）");
    const fnBody = LTV.slice(LTV.indexOf(FN_SIG), LTV.indexOf("function ltDeliverNeedsName(it) {"));
    has(fnBody, "String(it.file || \"\").trim() || String(it.title || \"\").trim()", "file 是文件名真源，旧档回退 title（升级不把老条目判成没名字）");
    has(fnBody, ".split(/[\\\\/]/).pop()", "只取纯文件名（路径前缀不进端子标签）");
    has(LTV, "function ltDeliverNeedsName(it) {", "「文件名待补」判据独立成函数（描述不算文件名）");
    has(LTV, "function ltDeliverNameOf(it) {", "端子标签取名另有一口（缺名显式标「待补」）");
    /* 端子标签：画布端子标题 + 板身端子行都走同一口 */
    has(CANVASJS, "window.LT.deliverNameOf(it)", "画布端子标签走 window.LT.deliverNameOf");
    has(LTU, "function ltDlvLabel(it, max)", "板身端子标签有 ltDlvLabel");
    has(LTU, "return ltStr(window.LT.deliverNameOf(it), max || 60);", "ltDlvLabel 直接取唯一取名口径（不自己拼一份）");
    has(LTU, "function ltDlvName(it) {", "界面取文件名同样有一口 ltDlvName");
    has(LTU, "window.LT.deliverFileName(it)", "ltDlvName 指向 LT.deliverFileName（不出现第二份拼名逻辑）");
    hasnt(LTU, "String((it && it.file) || \"\")", "界面里没有自己拼 file 字段的第二份取名逻辑");
    /* md 表头「文件名」 */
    has(LTU, 'ltT("| 文件名 | 内容说明 | 必填/选填 | 格式或大小要求 | 交付状态 |")', "板身 md 表头第一列是「文件名」");
    has(LTU, 'ltDlvCell(ltDlvName(it) || "（" + ltT("文件名待补") + "）", 60)', "表里没文件名就显式写「文件名待补」，不拿描述顶替");
    /* 交付必填判据含文件名 */
    has(LTV, "function ltDeliverMissingNames(items) {", "必填判据含文件名：ltDeliverMissingNames（仍导出，供板身「文件名待补」提示用）");
    has(LTV, "it.required !== false && ltDeliverNeedsName(it)", "只数「必填」且缺带后缀文件名的条目");
    /* 本轮需求：两个硬拦截（未交齐 / 缺文件名）都松绑 —— 改成「确认窗前弹窗 + 写说明即可放行」，
       判据从「拦不拦」变成「提不提醒 + 归档什么」。真跑与落盘断言见 smoke-longtask-release.js。 */
    has(LTV, "function ltReleaseMissingItems(items) {", "运行时确认交付的提醒判据走这一份（未交清单唯一真源）");
    hasnt(LTV, "const missName = ltDeliverMissingNames(items);", "旧「缺文件名就挡住确认交付」的判据已不再拦");
    hasnt(LTV, "必填文件还没定下文件名（含后缀），不能确认交付", "旧的拒绝文案已移除（不再回 error 拦人）");
    has(LTV, "const missing = ltReleaseMissingItems(items);", "确认交付真跑时按这一份判据记放行记录");
    has(LTU, "window.LT.releaseMissingItems(items)", "条带卡片上同一份判据（不各写一份，提醒条数同源）");
    has(LTV, "deliverFileName: ltDeliverFileName,", "window.LT 导出 deliverFileName");
    has(LTV, "deliverNeedsName: ltDeliverNeedsName,", "window.LT 导出 deliverNeedsName");
    has(LTV, "deliverNameOf: ltDeliverNameOf,", "window.LT 导出 deliverNameOf");
    has(LTV, "deliverMissingNames: ltDeliverMissingNames,", "window.LT 导出 deliverMissingNames");
    /* 真跑：file → title 兜底 / 去路径 / 只认后缀 / 缺名判据 */
    const probe22 = `
      const fn = (o) => window.LT.deliverFileName(o);
      const need = (o) => window.LT.deliverNeedsName(o);
      const label = (o) => window.LT.deliverNameOf(o);
      const miss = (items) => window.LT.deliverMissingNames(items);
      ({
        file: fn({ kind: "file", file: "分镜表.md", title: "每镜头一行" }),
        fb: fn({ kind: "file", title: "角色设定.md" }),
        path: fn({ file: "D:\\\\x\\\\定稿\\\\分镜表.MD" }),
        none: fn({ kind: "file", title: "一批配图" }),
        empty: fn({}),
        needBad: need({ kind: "file", title: "一批配图" }),
        needOk: need({ kind: "file", file: "分镜表.md" }),
        needText: need({ kind: "text", title: "风格说明" }),
        needOld: need({ kind: "media", title: "成片.mp4" }),
        needNull: need(null),
        okLabel: label({ kind: "file", file: "分镜表.md" }),
        badLabel: label({ kind: "file", title: "一批配图" }),
        noLabel: label({ kind: "file", title: "" }),
        missN: miss([{ kind: "file", title: "一批配图", required: true }, { kind: "file", file: "分镜表.md", required: true }, { kind: "file", title: "随笔", required: false }]),
        miss0: miss([{ kind: "file", file: "分镜表.md", required: true }, { kind: "text", title: "风格说明", required: true }]),
      });`;
    const r22 = vm.runInContext(probe22, sandbox);
    eqNum(r22.file, "分镜表.md", "真跑：file 字段就是文件名（描述不参与取名）");
    eqNum(r22.fb, "角色设定.md", "真跑：旧档没有 file 字段时回退 title（老条目不被判成没名字）");
    eqNum(r22.path, "分镜表.MD", "真跑：带目录的名只留最后一段（端子标签不带路径）");
    eqNum(r22.none, "一批配图", "真跑：一句话描述虽然能取到字，但只是「待补」的落点");
    eqNum(r22.empty, "", "真跑：什么都没有时是空（不造一个假文件名）");
    ok(r22.needBad, "真跑：一句描述（无后缀）判「文件名待补」");
    ok(!r22.needOk, "真跑：带后缀的文件名判「不需要补」");
    ok(!r22.needText, "真跑：文本条目不参与文件名判据（只有 file / media 要文件）");
    ok(!r22.needOld, "真跑：旧档 media 条目按 title 判（成片.mp4 认）");
    ok(!r22.needNull, "真跑：空条目判「不需要补」（宁可少标一处，不误报）");
    eqNum(r22.okLabel, "分镜表.md", "真跑：端子标签就是文件名");
    ok(r22.badLabel.indexOf("文件名待补") >= 0, "真跑：没有带后缀的名字时端子标签显式标「文件名待补」");
    has(r22.noLabel, "文件名待补", "真跑：连描述都没有时也标「文件名待补」（不留空）");
    eqNum(r22.missN, 1, "真跑：必填判据只数「必填 + 缺文件名」的那一条（选填缺名不算）");
    eqNum(r22.miss0, 0, "真跑：必填都有文件名（文本项不算文件）→ 判据为 0，可确认交付");
    /* 真跑三处同口径：画布端子标签 / 板身表头列 / 上传对齐用的都是同一个名字 */
    has(LTU, "const want = ltDlvName(item); /* 对齐用的是文件名（含后缀），不是条目描述 */", "上传对齐用的是文件名（不与端子标签分家）");
    eqNum(vm.runInContext("ltDlvName({ kind: \"file\", title: \"角色设定.md\" })", sandbox), "角色设定.md", "真跑：界面口 ltDlvName 与 LT 侧同一答案（旧档 title 兜底）");
  }

  /* ── [23] 恢复链路必须补交付节点（打开 / 切回画布时自己回来，不等用户点「继续」）── */
  console.log("\n[23] 恢复链路：ltRestore 走 ltRebindDeliverNodes 补交付节点（真跑，不是 grep）");
  {
    has(LTV, "async function ltRestore(wf)", "有恢复口 ltRestore（打开 / 切回画布都走它）");
    has(LTV, "async function ltRebindDeliverNodes(run)", "补节点单独成口 ltRebindDeliverNodes");
    has(LTV, "await ltRebindDeliverNodes(run);", "续跑路径（ltResume）也走同一口补节点");
    eqNum((LTV.match(/await ltRebindDeliverNodes\(j\);/g) || []).length, 2, "ltRestore 里两条路各走一次：本次读回来的 run + 本画布全部活 run");
    has(LTV, "const rebound = new Set();", "两条路不重复跑同一条 run（rebound 记账）");
    has(LTV, "const j = await ltRunLoad(wf.id, t.activeRun);", "第一条路管「本次从盘上读回来的 run」");
    has(LTV, "for (const j of ltRunsForWf(wf.id)) {", "第二条路管「本画布全部活 run」（已在内存里的那条）");
    has(LTV, "await ltRebindDeliverNodes(j);", "已在内存的 run 也补（LT_RUNS.has 的跳过只剩「早已补过」一种含义）");
    hasnt(LTV, "const cur = ltRun(wf", "「已在内存的 run」不再绕缓存另取一份（缓存命中会让节点永久补不回来）");
    has(LTV, "if (!t.activeRun || LT_RUNS.has(t.activeRun)) continue;", "第一条路只在「从盘上读回来」时才处理（已缓存的留给第二条路）");
    has(LTV, "await ltEnsureDeliverNode(run, p, node);", "补节点走 ltEnsureDeliverNode（addNode + __ltSystem，不进撤销栈）");
    /* 真跑：一条 waiting_delivery 的 run，画布上没有交付节点 —— 恢复后必须补一次 */
    const run23 = { runId: "r23", wfId: "wf23", taskId: "t23", graph: null, nodes: {}, inst: {}, status: "waiting", aborted: true };
    const item23 = { id: "i23", kind: "file", file: "成片.mp4", desc: "最终片", accept: "仅 .mp4", required: true, done: false, paths: [] };
    const graph23 = {
      nodes: [
        { id: "s", kind: "start", title: "起点" },
        { id: "h", kind: "human", title: "交片", cfg: { mode: "deliver", uid: "ltx-交片", items: [item23] } },
        { id: "e", kind: "end_ok", title: "收工" },
      ],
      edges: [{ from: "s", to: "h" }, { from: "h", to: "e" }],
    };
    const wf23 = { id: "wf23", workspace: "", longtask: { active: "t23", tasks: [{ uid: "t23", name: "交片任务", graph: graph23, enabled: true, activeRun: "r23" }] } };
    sandbox.S.wf = wf23;
    sandbox.window.api.ltRunGet = async () => ({
      ok: true,
      run: {
        runId: "r23", wfId: "wf23", taskId: "t23", status: "waiting", booted: true, aborted: true,
        graph: JSON.parse(JSON.stringify(graph23)), inst: { "": JSON.parse(JSON.stringify(graph23)) }, fired: {}, waits: [], rounds: {}, opts: {},
        nodes: { h: { path: "h", kind: "human", status: "waiting_delivery", uid: "ltx-交片", items: [JSON.parse(JSON.stringify(item23))] } },
      },
    });
    sandbox.window.api.ltDeliverEnsure = async (uid, items) => ({ dir: "D:\\交付\\" + uid, manifest: { items } });
    sandbox.renderCanvas = () => { probe23.renders++; };
    const probe23 = { renders: 0, runs: null, ensure: 0 };
    sandbox.__wf23 = wf23;
    sandbox.__probe23 = probe23;
    const out23 = await vm.runInContext(
      `window.api.ltDeliverEnsure = (uid, items) => { __probe23.ensure++; return Promise.resolve({ dir: "D:\\\\交付\\\\" + uid, manifest: { items } }); };
       ltRestore(__wf23).then((runs) => { __probe23.runs = runs; return runs.length; });`,
      sandbox,
    );
    eqNum(out23, 1, "真跑：盘上读回 1 条停在检查点的 run");
    eqNum(probe23.runs && probe23.runs.length, 1, "ltRestore 把这条 run 交回条带（用户能看见并选择继续）");
    ok(probe23.renders >= 1, "真跑：恢复链路真的走到补节点（renderCanvas 被叫过）——画布上没有交付节点也会自己回来");
    ok(probe23.ensure >= 1, "真跑：补节点之后清单又对齐了一次（磁盘 manifest 兜底，旧的盖不掉新的）");
    const cfgIt23 = JSON.parse(JSON.stringify(graph23.nodes[1].cfg.items));
    eqNum(cfgIt23.length, 1, "真跑：任务图 cfg.items 仍是用户那一份（恢复不改内容）");
    eqNum(cfgIt23[0].file, "成片.mp4", "真跑：恢复后任务图里的文件名还在（端子标签不会变回描述）");
    sandbox.S.wf = null;
  }

  /* ── [23b] 交付节点必须落在**主画布层**（用户焦点在壳里时也一样）──────────────
     现场：长任务跑着的时候用户正待在某个任务壳 / 超级节点壳里（他就是进去看这一环的）；
     真实 makeNode 按「当前焦点」补 parentTaskId / parentSuperId，于是系统建的交付节点被塞进
     那层壳的内坐标系 —— 按主画布坐标算出来的落点在壳内等于飘到很远，画布上看不见它，
     清单进度与端子连线无从操作（「长任务没生成交付节点」的直接成因）。这里按真实 makeNode
     的口径 stub（inheritParent 时补这两个字段），钉住 ltNewSystemNode 的清空口径。 */
  console.log("\n[23b] 交付节点落主画布层：用户焦点在壳里也不被塞进壳内（真跑 + 静态）");
  {
    has(LTV, 'if (!Object.prototype.hasOwnProperty.call(props, "parentSuperId")) props.parentSuperId = "";', "ltNewSystemNode 清空 parentSuperId（系统节点落主画布层）");
    has(LTV, 'if (!Object.prototype.hasOwnProperty.call(props, "parentTaskId")) props.parentTaskId = "";', "同口径清空 parentTaskId（不跟着用户的任务焦点走）");
    /* 真跑：stub makeNode 按真实口径补 parent（S.taskFocus / S.superFocus），看节点建成什么样 */
    const seq23b = { n: 0 };
    sandbox.makeNode = (kind, x, y) => ({
      id: "probe" + ++seq23b.n,
      kind: kind,
      x: x,
      y: y,
      w: 300,
      h: 200,
      title: kind,
      files: [],
      cfg: {},
      parentTaskId: String(sandbox.S.taskFocus || ""),
      parentSuperId: String(sandbox.S.superFocus || ""),
    });
    const item23b = { id: "i1", kind: "file", title: "成片.mp4", file: "成片.mp4", required: true, done: false, paths: [] };
    const graph23b = { nodes: [{ id: "h", kind: "human", title: "交片", cfg: { mode: "deliver", uid: "ltx-23b", items: [item23b] } }], edges: [] };
    const wf23b = { id: "wf23b", workspace: "", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 } };
    sandbox.S.wf = wf23b;
    sandbox.S.taskFocus = "taskShell";
    sandbox.S.superFocus = "superShell";
    sandbox.window.api.ltDeliverEnsure = async (a) => {
      const uid = String((a && a.uid) || "");
      const items = (a && a.items) || [];
      return { ok: true, dir: "D:\\交付\\" + uid, manifest: { items: items } };
    };
    sandbox.window.api.ltDeliverList = async () => ({ ok: true, dir: "", files: [] });
    const run23b = sandbox.ltRunNew({ uid: "t23b", name: "交片任务", graph: JSON.parse(JSON.stringify(graph23b)) }, "wf23b", {});
    sandbox.ltInst(run23b, "", run23b.graph);
    const h23b = sandbox.ltNodeAt(run23b, "h");
    await sandbox.ltExecHuman(run23b, "h", h23b);
    const dn23b = sandbox.ltDeliverNodeOf("ltx-23b", wf23b);
    ok(!!dn23b && dn23b.kind === "deliver", "真跑：交付节点建出来了");
    eqNum(String((dn23b && dn23b.parentTaskId) || ""), "", "真跑：交付节点 parentTaskId 为空 —— 落主画布层，不跟着用户的任务焦点进壳");
    eqNum(String((dn23b && dn23b.parentSuperId) || ""), "", "真跑：parentSuperId 同样为空（不会被塞进超级节点壳的内坐标系）");
    eqNum(String((dn23b && dn23b.ltUid) || ""), "ltx-23b", "真跑：uid 与节点身份照旧（清归属不影响认人）");
    eqNum((dn23b && dn23b.ltItems || []).length, 1, "真跑：清单照旧注入交付节点（1 件待交）");
    sandbox.S.taskFocus = "";
    sandbox.S.superFocus = "";
    sandbox.S.wf = null;
  }

  /* ── [24] ltDeliverSyncFromNode 必须回写任务图 cfg.items（不是只改内存里的 run 快照）──
     只写 run.nodes[path].items 的话，条带卡片与下一次启用读到的仍是图里那份旧清单 ——
     用户改过的清单会在「开合画布」时不翼而飞。 */
  console.log("\n[24] 交付节点改动回写：ltDeliverSyncFromNode → 任务图 cfg.items（真跑）");
  {
    has(LTV, "function ltDeliverWriteToGraph(wf, run, taskUid, uid, path, items) {", "回写单独成口 ltDeliverWriteToGraph（可单测）");
    has(LTV, "gn.cfg.items = JSON.parse(next);", "回写落到任务图节点的 cfg.items（图定义，不是 run 快照）");
    has(LTV, "const gw = ltDeliverWriteToGraph(wf, run, node && node.ltTaskUid, uid, path, items);", "ltDeliverSyncFromNode 统一走这一口（增删改 / 上传 / 撤回同一个落点）");
    has(LTV, "if (gw.wrote) ltPersistWf(wf);", "图真被改了才落盘（幂等，不每帧写）");
    has(LTV, "ltDeliverWriteToGraph(wf, run, run.taskId, st.uid, p, items);", "恢复链路把清单回写**本 run 所属画布**的任务图（用户切走时绝不写前台那张）");
    const S24 = "async function ltDeliverSyncFromNode(node) {";
    has(LTV, S24, "有 ltDeliverSyncFromNode（节点内改清单的唯一回写口）");
    const syncBody = LTV.slice(LTV.indexOf(S24), LTV.indexOf("async function ltEnsureDeliverNode(run, path, node) {"));
    has(syncBody, "loc.node.cfg.items = JSON.parse(JSON.stringify(items));", "内存里这一轮实例的图也同步（组件 / 卡片读的是它）");
    has(syncBody, "const gw = ltDeliverWriteToGraph(", "任务图回写在函数体内真的被调到（grep 到名字不等于被调用）");
    /* 真跑 */
    const node24 = { id: "d24", kind: "deliver", ltUid: "ltx-交稿", ltPath: "h", ltTaskUid: "t24", title: "交付 · 交稿", ltItems: [{ id: "i1", kind: "file", file: "分镜表.md", required: true, done: false, paths: [] }], files: [] };
    const wf24 = { id: "wf24", workspace: "", nodes: [node24], wires: [], cam: { x: 0, y: 0, k: 1 }, longtask: { active: "t24", tasks: [{ uid: "t24", name: "交稿", enabled: true, activeRun: "r24", graph: { nodes: [{ id: "s", kind: "start", title: "起点" }, { id: "h", kind: "human", title: "交稿", cfg: { mode: "deliver", uid: "ltx-交稿", items: [{ id: "i1", kind: "file", file: "分镜表.md", required: true, done: false, paths: [] }] } }, { id: "e", kind: "end_ok", title: "收工" }], edges: [] } }] } };
    const run24 = { runId: "r24", wfId: "wf24", taskId: "t24", graph: wf24.longtask.tasks[0].graph, inst: { "": wf24.longtask.tasks[0].graph }, nodes: { h: { path: "h", kind: "human", status: "waiting_delivery", uid: "ltx-交稿", items: [{ id: "i1", kind: "file", file: "分镜表.md", required: true, done: false, paths: [] }] } }, fired: {}, waits: [], opts: {} };
    sandbox.S.wf = wf24;
    sandbox.__node24 = node24;
    sandbox.__wf24 = wf24;
    sandbox.__run24 = run24;
    sandbox.__spy24 = null;
    sandbox.__first24 = null;
    const r24 = await vm.runInContext(
      `(function () {
         const r = __run24;
         ltSave(r); /* 进 LT_RUNS 缓存：ltCurrentRun 取的就是缓存里那条 */
         __node24.ltItems = [{ id: "i1", kind: "file", file: "分镜表.md", required: true, done: false, paths: [] }, { id: "i2", kind: "file", file: "成片.mp4", required: true, done: false, paths: [] }];
         __spy24 = [];
         /* 换掉全局那份实现（赋值，不是重声明）：源码里的函数声明是全局绑定，
            直接赋值才盖得住，ltDeliverSyncFromNode 调的才是这个记录器。 */
         const __orig24 = ltDeliverWriteToGraph;
         ltDeliverWriteToGraph = function (wf2, run2, taskUid2, uid2, path2, items2) {
           /* 用 spy 记下「回写被调到 + 带的是哪份清单」：只看最终 cfg.items 分不清
              「这次同步写的」还是「上一次同步写的」。 */
           const r = __orig24(wf2, run2, taskUid2, uid2, path2, items2);
           __spy24.push({ uid: String(uid2), path: String(path2), taskUid: String(taskUid2), hasTask: !!r.task, items: items2.length, wrote: r.wrote, gLen: ((wf2.longtask.tasks[0].graph.nodes[1].cfg.items) || []).length });
           return r;
         };
         /* 沙箱是同一个，这份记录器会一直留着 —— [24] 收尾会把真实现接回来（见那一节的还原断言）。 */
         /* 同步跑两次：第一次把用户改过的清单写进图定义，第二次内容一模一样（幂等） */
         return ltDeliverSyncFromNode(__node24).then((first) => {
           __first24 = first;
           return ltDeliverSyncFromNode(__node24);
         });
       })();`,
      sandbox,
    );
    const spy24 = (sandbox.__spy24 || []).filter((x) => x.uid);
    ok(spy24.length >= 1, "真跑：ltDeliverSyncFromNode 内部真的调了 ltDeliverWriteToGraph（grep 到名字不等于被调到）");
    ok(spy24.length >= 1 && spy24[0].items === 2, "真跑：回写带的是用户改过的那份清单（2 条）");
    ok(spy24.length >= 1 && spy24[0].hasTask, "真跑：目标任务在当前画布上认得到，才允许写图定义");
    ok(spy24.length >= 1 && spy24[0].gLen === 2, "真跑：回写之后任务图的 cfg.items 就是 2 条");
    eqNum(r24 && r24.items && r24.items.length, 2, "真跑：回执报出这次写回的清单条数");
    ok(r24 && r24.graph === false, "真跑：第二次同步内容没变 → graph=false（幂等，不反复写盘）");
    const cfg24 = wf24.longtask.tasks[0].graph.nodes[1].cfg.items;
    eqNum(cfg24.length, 2, "真跑：任务图 cfg.items 从 1 条变 2 条（新加的条目真的写进图定义）");
    eqNum(cfg24[1] && cfg24[1].file, "成片.mp4", "真跑：写回去的是用户刚加的那件文件名");
    eqNum(run24.nodes.h.items.length, 2, "真跑：运行态这一轮实例同样是 2 条（两处同源）");
    has(LTV, "const wf = ltCanvasOfNode(node) || (typeof S !== \"undefined\" ? S.wf : null);", "回写目标取自节点所在画布（不给别的画布写）");
    has(LTV, "if (!task) return out;", "目标任务不属于当前画布一律不动图（跨画布不串写）");
    /* 这一节把 ltDeliverWriteToGraph 换成了 spy（同一个沙箱会一直留着），后续小节要用真实现：
       直接把源码里那段原样重声明一次接回来（幂等函数，重装即还原）。 */
    const W2G = LTV.slice(LTV.indexOf("function ltDeliverWriteToGraph("), LTV.indexOf("/* 交付节点上的人工改动"));
    ok(W2G.length > 100, "取到 ltDeliverWriteToGraph 的真实现源码（给后续小节还原用）");
    vm.runInContext(W2G + "\nvoid 0;", sandbox);
    ok(vm.runInContext("typeof ltDeliverWriteToGraph === 'function' && !/__spy24/.test(String(ltDeliverWriteToGraph))", sandbox), "真实现已接回（spy 不跨小节残留）");
    sandbox.S.wf = null;
  }

  /* ── [25] 交付条目录入卡：判定由调用方传入，卡片渲染不抛 ReferenceError ─
     ltItemInput(parent, it, commit, path, uid, editing, isDeliver) 的形参里从来没有 node。 */
  console.log("\n[25] 交付条目录入卡：isDeliver 由调用方传入 · 函数体不再抓外层 node（真跑 + 正正经经读函数体）");
  {
    const SIG = "function ltItemInput(parent, it, commit, path, uid, editing, isDeliver, guardIn) {";
    has(LTU, SIG, "ltItemInput 形参表里有 isDeliver（判定不从函数体里现抓外层 node）");
    /* 切片只包住 ltItemInput 自己（到下一个函数声明为止）：后面别的函数里出现 node 是它们自己的形参 */
    const body25 = LTU.slice(LTU.indexOf(SIG), LTU.indexOf("function ltNodeFilePaths(", LTU.indexOf(SIG)));
    hasnt(body25, "node.cfg", "函数体里不再出现 node.cfg（外层作用域的变量，独立调用即 ReferenceError）");
    hasnt(body25, "node.ltUid", "函数体里不再出现 node.ltUid（同上，渲染整段会挂）");
    has(body25, "if (!editing && isDeliver)", "交付提示按传入的 isDeliver 判断");
    has(LTU, 'editing, !!(node && node.cfg && node.cfg.mode === "deliver"), guard);', "调用方（ltChecklistEditor）算好 isDeliver 再传（node 在那里是形参，安全）");
    has(LTU, "node.cfg.uid", "ltChecklistEditor 里 node.cfg.uid 仍在（判定与 uid 都取自调用方自己手里的 node）");
    /* 真跑三种调用形态（文件类条目走的就是抛错那条路径） */
    sandbox.document.createElement = (tag) => ({
      tagName: tag,
      className: "",
      textContent: "",
      type: "",
      title: "",
      onclick: null,
      onchange: null,
      oninput: null,
      value: "",
      checked: false,
      disabled: false,
      focus() {},
      children: [],
      appendChild(c) { this.children.push(c); },
    });
    const box25 = { children: [], appendChild(c) { this.children.push(c); } };
    sandbox.__box = box25;
    sandbox.__commit = async () => {};
    const probe25 = `
      function __probe25(editing, isDeliver) {
        const item = { id: "i1", kind: "file", title: "分镜表.md", file: "分镜表.md", desc: "每镜头一行", required: true, done: false, paths: [] };
        const w = ltItemInput(__box, item, __commit, "h1", "ltx-交稿", editing, isDeliver);
        return String(w.children.length) + "/" + String(w.className);
      }
      let __noThrow25 = false, __err25 = "", __runtime25 = "", __noHint25 = "", __editMode25 = "";
      try { __runtime25 = __probe25(false, true); __noThrow25 = true; } catch (e) { __err25 = String((e && e.message) || e); }
      try { __noHint25 = __probe25(false, false); } catch (e) { __noHint25 = "抛错：" + String((e && e.message) || e); }
      try { __editMode25 = __probe25(true, false); } catch (e) { __editMode25 = "抛错：" + String((e && e.message) || e); }
      ({ __noThrow25, __err25, __runtime25, __noHint25, __editMode25 });`;
    const r25 = vm.runInContext(probe25, sandbox);
    ok(r25.__noThrow25, "真跑：运行时交付卡渲染不再抛 ReferenceError" + (r25.__noThrow25 ? "" : "（" + r25.__err25 + "）"));
    eqNum(r25.__runtime25, "2/lt-item-in", "交付模式下：操作行 + 逐文件交付提示 = 2 块，都挂在 .lt-item-in 里");
    eqNum(r25.__noHint25, "1/lt-item-in", "非交付环节只剩操作行，不弹「逐文件交付」提示");
    eqNum(r25.__editMode25, "1/lt-item-in", "图定义态（editing=true）同样只有操作行");
    has(read("renderer/app-longtask-ui.js"), "ltItemInput(itemBox, it, commit, path, node.cfg.uid, editing,", "调用点把 node.cfg.uid 与 isDeliver 一起传（函数体内不许再碰 node）");
  }

  /* ─ [26] 交付完成状态与磁盘对齐：上传过 / 文件就在那儿，计数不许退回 0 ────────
     完成状态（done / paths）只活在内存清单里：重开应用、切走画布再回来、重启后点「继续」，
     清单被重新注入成「一条都没交」，而交付目录里的文件一直在 —— 用户看到的就是
     「上传了仍然显示为 0」。真源 = app-longtask.js 的 ltDeliverReconcileDisk，
     判据只认真实存在的文件：交付目录同名文件，或条目声明路径（相对路径按工作目录展开）。 */
  console.log("\n[26] 交付计数与磁盘对齐（上传了显示为 0 的修复：真跑，不是 grep）");
  {
    has(LTV, "async function ltDeliverReconcileDisk(node, dirIn, itemsIn, wfIn) {", "对账单独成口 ltDeliverReconcileDisk（可单测）· 末位 wfIn = 这份清单属于哪张画布");
    has(LTV, "deliverReconcileDisk: ltDeliverReconcileDisk,", "对账接口导出到 window.LT（UI 与引擎同一份口径）");
    has(LTV, "await ltDeliverReconcileDisk(node, node && node.ltDir, null, wf);", "ltDeliverSyncFromNode 每次都先与磁盘对一次账（按节点所在画布取工作目录）");
    has(LTV, "const sw = await ltDeliverReconcileDisk({ ltUid: st.uid, ltDir: r.dir }, r.dir, items, wf);", "恢复现场 / 打开画布（ltRebindDeliverNodes）同样对账（按 run 所属画布）");
    has(LTV, "await ltDeliverReconcileDisk(dn, r.dir, st.items, humanWf);", "重跑同一环节（ltExecHuman）注入清单后同样对账（按 run 所属画布）");
    has(LTU, '"⟳ " + ltT("与磁盘对账")', "交付节点上有手工对账入口（计数不对时用户自己也能点）");
    const f26 = "async function ltDeliverReconcileDisk(";
    const body26 = LTV.slice(LTV.indexOf(f26), LTV.indexOf("async function ltEnsureDeliverNode(", LTV.indexOf(f26)));
    has(body26, "it.rejected) continue;", "显式撤回（rejected）的条目不参与自动认领（撤回不会被下一帧救活）");
    has(body26, "present = null;", "交付目录读不到时只认领不撤销（判不准一律保持原样）");
    has(STORE, '"rejected"]', "rejected 进 ITEM_RUNTIME_KEYS：跨会话留在 manifest 里（撤回不随重启失效）");

    const DIR26 = "D:\\ws\\mtnode-deliverables\\ltx-对账";
    const WS26 = "D:\\ws";
    const mkIt26 = (o) => Object.assign({ id: "i", kind: "file", title: "A.png", file: "A.png", required: true, done: false, paths: [], value: "", choice: [] }, o || {});
    /* A.png：交付目录里有同名文件 · 声明路径项：相对工作目录那条路径存在 · C.png / D.png：磁盘上没有 */
    const exists26 = new Set([WS26 + "\\assets\\ref\\ui-editor-start.png"]);
    sandbox.window.api.pathJoin = (...p) => p.join("\\");
    sandbox.window.api.ltDeliverList = async () => ({ ok: true, dir: DIR26, files: [{ name: "A.png", path: DIR26 + "\\A.png", size: 10 }] });
    sandbox.window.api.fileStat = async (p) => (exists26.has(String(p).replace(/\//g, "\\")) ? { ok: true, size: 10 } : { ok: false, error: "路径不存在" });
    vm.runInContext("function wfWorkspace() { return " + JSON.stringify(WS26) + "; }", sandbox);
    sandbox.__n26 = {
      id: "d26", kind: "deliver", ltUid: "ltx-对账", ltTaskUid: "t26", ltPath: "h", ltDir: DIR26,
      ltItems: [
        mkIt26({ id: "a" }),
        mkIt26({ id: "b", title: "assets/ref/ui-editor-start.png", file: "assets/ref/ui-editor-start.png" }),
        mkIt26({ id: "c", title: "C.png", file: "C.png" }),
        mkIt26({ id: "d", title: "D.png", file: "D.png", done: true, paths: [DIR26 + "\\D.png"] }),
      ],
    };
    const r26 = await vm.runInContext("window.LT.deliverReconcileDisk(__n26, __n26.ltDir, __n26.ltItems)", sandbox);
    eqNum(r26, 3, "真跑：对账改了 3 处（认回 2 件 + 撤销 1 处找不到文件的标记）");
    let n26 = sandbox.__n26.ltItems;
    ok(n26[0].done === true, "交付目录里有同名文件 → 认成已交（完成状态丢了也能认回来）");
    eqNum(n26[0].deliveredVia, "交付目录", "来源标「交付目录」，与 上传 / 连线 分得开");
    ok(n26[1].done === true, "条目声明路径（相对工作目录）存在 → 同样认成已交");
    eqNum(n26[1].deliveredVia, "工作目录", "来源标「工作目录」");
    ok(n26[2].done === false, "两处都找不到文件的条目照旧待交（不凭空认领）");
    ok(n26[3].done === false, "标记说已交、磁盘上找不到文件 → 撤销标记（计数不虚高）");
    eqNum(await vm.runInContext("window.LT.deliverReconcileDisk(__n26, __n26.ltDir, __n26.ltItems)", sandbox), 0, "幂等：再对一次账没有变化（不反复写盘 / 重绘）");
    /* 经 ltDeliverSyncFromNode 这条真路径：显式撤回的那一项，交付目录里文件还在也不许被认领回来 */
    sandbox.S.wf = { id: "wf26", workspace: WS26, nodes: [sandbox.__n26], wires: [], cam: { x: 0, y: 0, k: 1 }, longtask: { tasks: [{ uid: "t26", name: "对账任务", enabled: true, graph: { nodes: [{ id: "h", kind: "human", title: "素材交付", cfg: { mode: "deliver", uid: "ltx-对账", items: [] } }], edges: [] } }], active: "" } };
    sandbox.window.api.ltRunList = async () => ({ ok: true, runs: [] });
    sandbox.window.api.ltDeliverEnsure = async (arg) => ({ ok: true, dir: DIR26, manifest: { items: Array.isArray(arg && arg.items) ? arg.items : [] } });
    /* 用户显式撤回：done 撤掉 + rejected 立起来（交付目录里的文件不删） */
    n26[0].done = false;
    n26[0].paths = [];
    n26[0].deliveredVia = "";
    n26[0].rejected = true;
    await vm.runInContext("ltDeliverSyncFromNode(__n26)", sandbox);
    n26 = sandbox.__n26.ltItems;
    ok(n26[0].rejected === true && n26[0].done === false, "真跑：显式撤回的条目在同步（对账）之后仍是未交（不被磁盘救活）");
    eqNum(await vm.runInContext("window.LT.deliverReconcileDisk(__n26, __n26.ltDir, __n26.ltItems)", sandbox), 0, "真跑：rejected 条目不参与认领（交付目录里的同名文件也不动它）");
    ok(n26[0].done === false, "真跑：撤回不会被下一帧自动认领回来（撤回是用户说了算）");
    /* 交付目录读不到：只认领、不撤销（判不准一律保持原样） */
    sandbox.window.api.ltDeliverList = async () => ({ ok: false, dir: DIR26, files: [] });
    n26[0].rejected = false;
    n26[0].done = true;
    n26[0].paths = [DIR26 + "\\A.png"];
    n26[0].deliveredVia = "上传";
    const r26b = await vm.runInContext("window.LT.deliverReconcileDisk(__n26, __n26.ltDir, __n26.ltItems)", sandbox);
    eqNum(r26b, 0, "交付目录读不到时不撤销任何已交标记（找不到目录 ≠ 没交）");
    ok(n26[0].done === true && n26[0].deliveredVia === "上传", "交付目录读不到时已交标记与来源原样保留");
    delete sandbox.window.api.ltDeliverList;
    sandbox.S.wf = null;
  }

  /* ─ [27] 交付文件自动从连线取 · 收齐也不自动放行（本次需求本体）────────────────
     需求：长任务里交付用主画布的交付节点时，**交付文件自动从连线取**，不要用户再去长任务画布
     右侧栏重新点按钮确认。三层都钉住：① 收线认「线的归属文件项 id」而不是端子号（端子会重排）；
     ② 接线 / 每步跑完 / 条带重绘都会叫一次自动收线（不靠用户点按钮）；
     ③ **只收线、不放行**：收齐之后这一环照旧停在等交付，仍要用户点「确认交付完成」
     （本轮要求：收齐不要自动放行整个状态），缺件时更不替用户决定。 */
  console.log("\n[27] 交付文件自动从连线取 · 收齐也不自动放行（真跑，不是 grep）");
  {
    has(LTV, "autoCollectSoon: ltAutoCollectSoon,", "自动收线入口导出到 window.LT（app-nodes / UI 都从这里叫）");
    has(LTV, "ltAutoCollectSoon(run);", "引擎主循环每步之后叫一次自动收线（带上本 run）");
    has(LTV, "ltAutoCollectSoon(run);", "恢复现场（ltRebindDeliverNodes）也叫一次（带上本 run）");
    has(NODES, "window.LT.autoCollectSoon", "画布接线 / 断线那一刻显式叫一次（改图不走引擎主循环）");
    hasnt(LTV, "function ltDeliverAutoRelease", "收齐自动放行那条路已撤掉（本轮要求：只收线、不放行）");
    hasnt(LTV, "run._ltAutoDone", "自动放行用的幂等标记一并清掉（不留死代码）");
    hasnt(LTV, "if (ltDeliverAutoReady(st.items).ready) {", "人工交付环节不再当场自动放行走下游");
    has(LTV, "function ltDeliverAutoReady(items) {", "「齐没齐」判据保留（只读，条带卡用它决定显示哪句提示）");
    has(LTV, "const iid = row && row.itemId != null ? String(row.itemId) : \"\";", "收线先按线的归属文件项 id 认条目");
    has(LTV, "function ltDeliverWiredRows(deliverNode, wfIn) {", "连线取值单一来源 ltDeliverWiredRows（wfIn = 按哪张画布的连线收）");
    has(LTU, "window.LT.autoCollectSoon", "条带卡片每次重绘也叫一次（打开 / 切回画布都走到）");
    has(LTU, "点「确认交付完成」往下走", "卡片在交齐时明说「往下走要点确认」（不再说自动继续）");

    const DIR27 = "D:\\ws\\mtnode-deliverables\\ltx-交稿";
    const mkIt27 = (o) =>
      Object.assign({ id: "i1", kind: "file", title: "分镜表.md", file: "分镜表.md", required: true, done: false, paths: [], value: "", choice: [] }, o || {});
    sandbox.window.api.ltDeliverList = async () => ({ ok: true, dir: DIR27, files: [] });
    /* 交付是「文件为单位」：自动收线会把连线来的那件**复制进交付目录**（与上传同一落点），
       所以源文件与交付目录里的落点都要能 stat 到（真机上是真实存在的文件）。 */
    sandbox.window.api.fileStat = async (p) =>
      /分镜表\.md$/.test(String(p)) ? { ok: true, size: 20 } : { ok: false, error: "路径不存在" };
    const copied27 = [];
    sandbox.window.api.fileCopy = async (src, dest) => {
      copied27.push([String(src), String(dest)]);
      return { ok: true };
    };
    sandbox.window.api.pathJoin = (...p) => p.join("\\");
    sandbox.window.api.ltDeliverEnsure = async (arg) => ({ ok: true, dir: DIR27, manifest: { items: (arg && arg.items) || [] } });
    const persists27 = [];
    vm.runInContext("function ltPersistWf() { __persists27.push(1); }", Object.assign(sandbox, { __persists27: persists27 }));
    const mkRun27 = (waitPath, item) => ({
      runId: "r27", wfId: "wf27", taskId: "t27", aborted: false, booted: true, status: "waiting",
      steps: 0, opts: {},
      graph: { nodes: [{ id: "h", kind: "human", title: "交稿", cfg: { mode: "deliver", uid: "ltx-交稿", items: [mkIt27(item || {})] } }, { id: "e", kind: "end_ok", title: "收工" }], edges: [{ id: "eh", from: "h", to: "e" }] },
      inst: {},
      ns: { "": {} },
      nodes: { h: { path: "h", kind: "human", status: "waiting_delivery", uid: "ltx-交稿", items: [mkIt27(item || {})] } },
      fired: {}, waits: [{ kind: "deliver", path: waitPath, title: "交稿", round: 1 }],
    });
    const WIRE27 = { id: "w27", from: "s1", to: "d27", toIndex: 0, ltItem: "i1" };
    sandbox.S.wf = {
      id: "wf27", workspace: "D:\\ws", cam: { x: 0, y: 0, k: 1 },
      nodes: [
        { id: "s1", kind: "save", title: "落盘", savedPath: "D:\\ws\\out\\分镜表.md" },
        { id: "d27", kind: "deliver", title: "交付 · 交稿", ltUid: "ltx-交稿", ltTaskUid: "t27", ltPath: "h", ltDir: DIR27, ltItems: [mkIt27()] },
      ],
      wires: [WIRE27],
      longtask: { active: "t27", tasks: [{ uid: "t27", name: "交稿", enabled: true, activeRun: "r27", graph: { nodes: [{ id: "h", kind: "human", title: "交稿", cfg: { mode: "deliver", uid: "ltx-交稿", items: [mkIt27()] } }], edges: [] } }] },
    };
    const run27 = mkRun27("h");
    /* inst 是运行态「命名空间前缀 → 图」的映射（ltLocate / 点火判据都读它）：
       真跑是 ltInst 建的，这里手工补一份，不补就连图定义都定位不到。 */
    run27.inst = { "": run27.graph };
    sandbox.window.LT.__runs27 = run27;
    vm.runInContext("LT_RUNS.set('r27', window.LT.__runs27);", sandbox);

    /* ① 自动收线：连在交付节点上的线取到文件 → 这一项记已交、来源标「连线」，不等人点按钮 */
    const ltArr = (a) => (Array.isArray(a) ? a : []);
    const got27 = await vm.runInContext("window.LT.deliverTakeWired(__n27)", Object.assign(sandbox, { __n27: sandbox.S.wf.nodes[1] }));
    eqNum(got27, 1, "自动收线：连入的那一件当场收下（不需要用户再点「从画布连线取」）");
    const node27 = sandbox.S.wf.nodes[1];
    const it27 = ltArr(node27.ltItems)[0];
    ok(it27.done === true && it27.deliveredVia === "连线", "收下的那一项 done=true 且来源标「连线」（与上传分得开）");
    eqNum(it27.paths[0], "D:\\ws\\out\\分镜表.md", "路径来自上游节点真正的出参（save 节点的 savedPath）");
    eqNum(copied27.length, 1, "连线的文件被复制进交付目录（交付以文件为单位，与上传同一落点）");
    eqNum(copied27[0][1], DIR27 + "\\分镜表.md", "落点就是交付目录里的端子文件名（对账 / manifest 读的就是它）");
    eqNum(sandbox.S.wf.wires.length, 0, "已交项端子消失 → 它的线随端子一起摘掉（不留下错指的线）");
    ok(persists27.length >= 1, "收下的那一刻清单就同步（任务图定义 / 交付目录同源，不是等下一次同步）");

    /* ② 只收线、不放行（本轮要求）：走完整链路（条带每次重绘 / 引擎每步之后叫的就是它）——
       收线照旧自动收下，但**不允许**这一环自己往下走：状态、人工卡、下游点火全都原样不动。 */
    ok(vm.runInContext("window.LT.deliverAutoReady(__n27.ltItems).ready", Object.assign(sandbox, { __n27: node27 })) === true, "齐了：判据 ready=true（与确认窗同一个未交判据，只读不产生动作）");
    console.log("     · 真跑自动收线入口（autoCollectNow）：收线照旧自动，放行一律留给用户");
    const node28 = { id: "d27b", kind: "deliver", title: "交付 · 交稿", ltUid: "ltx-交稿", ltTaskUid: "t27", ltPath: "h", ltDir: DIR27, ltItems: [mkIt27()] };
    sandbox.S.wf.nodes = [
      { id: "s1b", kind: "save", title: "落盘", savedPath: "D:\\ws\\out\\分镜表.md" },
      node28,
    ];
    sandbox.S.wf.wires = [{ id: "w27b", from: "s1b", to: "d27b", toIndex: 0, ltItem: "i1" }];
    run27.nodes["h"].status = "waiting_delivery";
    run27.nodes["h"].items = [mkIt27()];
    run27.waits = [{ kind: "deliver", path: "h", title: "交稿", round: 1 }];
    sandbox.toasts27 = [];
    vm.runInContext("function toast(m, k) { __toasts27.push([String(m), String(k)]); }", Object.assign(sandbox, { __toasts27: sandbox.toasts27 }));
    eqNum(await vm.runInContext("window.LT.autoCollectNow()", sandbox), 1, "自动收线入口真跑：连入的那一件被收下（不必用户再去节点上收线）");
    ok(ltArr(node28.ltItems)[0].done === true, "收下后节点上的清单确实记成已交（条带计数与节点板身一致）");
    eqNum(run27.nodes["h"].status, "waiting_delivery", "收齐**不放行**：这一环照旧停在等交付（本轮要求：不要自动放行整个状态）");
    eqNum((run27.waits || []).length, 1, "人工卡仍在（右栏照旧挂着「等你处理」，等用户点「确认交付完成」）");
    ok(!((run27.fired || {})["eh"] >= 1), "没有往下游点火（任务不会自己跑过去）");
    ok(sandbox.toasts27.some((t) => /确认交付完成/.test(t[0])), "只提示「已从连线自动收下 N 件」，并指明往下走要点「确认交付完成」");
    eqNum(await vm.runInContext("window.LT.autoCollectNow()", sandbox), 0, "幂等：再叫一次没有可收的（同一环不会反复收 / 反复写盘）");
    eqNum(run27.nodes["h"].status, "waiting_delivery", "再叫一次也照旧不放行（自动收线这一路绝不放行）");
    /* 放行只有一条路：用户点「确认交付完成」（条带卡片走的就是 ltHumanResolve 这一支）。 */
    console.log("     · 真跑人工放行（ltHumanResolve · decide=deliver）：用户点了才往下走");
    /* ltHumanResolve 只接沙箱里的活对象（宿主对象跨 vm 传进去认不出来）：第一个参数给 null，
       函数自己回退读沙箱顶层的 S.wf —— 与条带卡片在真实运行里走的同一条路。 */
    /* ltHumanResolve 的 wf 必须递沙箱里的活对象（宿主对象跨 vm 传进去认不出该任务）：
       在沙箱内直接取 S.wf —— 与条带卡片在真实运行里走的同一条路。 */
    const rs27 = await vm.runInContext("ltHumanResolve(S.wf, { path: 'h', decide: 'deliver', note: '' })", sandbox);
    ok(rs27 && rs27.ok === true, "用户点「确认交付完成」→ 放行成功");
    eqNum(run27.nodes["h"].status, "done", "点了之后这一环才转 done");
    eqNum((run27.waits || []).length, 0, "人工卡这才收掉（右栏不再是「等你处理」）");
    await new Promise((r) => setTimeout(r, 60)); /* ltPump 是同步返回的火：等它把下游叫起来 */
    ok((run27.fired || {})["eh"] === 1, "往下游点了火（end_ok 那一环被叫起）—— 与自动收线彻底解耦");

    /* ③ 缺件时横竖不替用户决定：上游给不出文件 → 不收；没点确认 → 永不放行 */
    sandbox.S.wf.nodes = [
      { id: "s2", kind: "input_text", title: "纯文本", text: "只有一段话，没有文件" },
      { id: "d28", kind: "deliver", title: "交付 · 交稿", ltUid: "ltx-交稿", ltTaskUid: "t27", ltPath: "h", ltDir: DIR27, ltItems: [mkIt27()] },
    ];
    sandbox.S.wf.wires = [{ id: "w28", from: "s2", to: "d28", toIndex: 0, ltItem: "i1" }];
    run27.nodes["h"].status = "waiting_delivery";
    run27.nodes["h"].items = [mkIt27()];
    run27.waits = [{ kind: "deliver", path: "h", title: "交稿", round: 1 }];
    eqNum(await vm.runInContext("window.LT.deliverTakeWired(__n28)", Object.assign(sandbox, { __n28: sandbox.S.wf.nodes[1] })), 0, "上游给不出文件 → 一件都不收（绝不凭空当已交）");
    ok(sandbox.S.wf.nodes[1].ltItems[0].done === false, "这一项照旧待交（留给用户上传 / 去补线）");
    eqNum(run27.nodes["h"].status, "waiting_delivery", "这一环照旧停在等交付（右栏卡片还在，用户可补交或按确认放行）");
    eqNum(await vm.runInContext("window.LT.autoCollectNow()", sandbox), 0, "叫一次自动收线：没有可收的就安静返回 0（不反复写盘 / 不报错）");
    eqNum(run27.nodes["h"].status, "waiting_delivery", "缺件时更不放行（系统绝不替用户决定「就这样继续」）");
    sandbox.S.wf = null;
    delete sandbox.window.LT.__runs27;
  }

  /* ── [28] 创建期预建 + 启用后认领 / 复用（本轮需求「创建即显示」）──
     旧口径：壳 / 生成工作流 / 交付节点都是跑到那一环才懒建 —— 用户看到的是「图建好了，
     画布上什么都没有」。本轮改成创建那一刻把落点一次摆好，但**一律只建不跑**；
     启用后预建的壳被认领（登记进 run.shellPaths，不重长）、交付节点按 uid 复用（不重复建）。 */
  console.log("\n[28] 创建期预建：落点一次建好（只建不跑）+ 启用后认领 / 复用 / 删了不重长");
  {
    has(LTV, "function ltLandingCreate(wf, task) {", "引擎有预建总入口 ltLandingCreate");
    has(LTV, "ltLandingCreate(wf, task);", "ltCreateFromGraph 里真的调到（create_longtask / 会话 / 助手全覆盖）");
    has(LTV, "function ltDeliverLandingCreate(wf, task) {", "交付节点预建单独成口 ltDeliverLandingCreate");
    has(LTV, "ltUid: it.uid,", "预建的交付节点带 ltUid（与运行时同一份认人身份）");
    has(LTV, 'ltRunId: "",', "创建期没有 run：ltRunId 留空（启用后按同一 uid 复用）");
    {
      const body = LTV.slice(
        LTV.indexOf("function ltLandingCreate(wf, task) {"),
        LTV.indexOf("function ltDeliverLandingCreate(wf, task) {"),
      );
      hasnt(body, "ltEnable", "预建只建不跑：不调 ltEnable");
      hasnt(body, "ltRunNew", "预建不建 run（开跑只由用户点「启用并绑定」）");
    }
    /* 真跑：把壳模块装进同一个沙箱（引擎按全局判空调用它）。装在本节（最后一节）——
       上面的小节一直按「没有壳模块」的现场跑，不受影响。 */
    vm.runInContext(read("renderer/app-longtask-shell.js"), sandbox, { filename: "renderer/app-longtask-shell.js" });
    ok(!!sandbox.window.LTSHELL, "app-longtask-shell.js 装进同一沙箱并导出 window.LTSHELL");

    const wf28 = { id: "wf28", workspace: "D:\\ws28", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 } };
    sandbox.S.wf = wf28;
    const GRAPH28 = {
      nodes: [
        { id: "s", kind: "start", title: "起点" },
        { id: "a1", kind: "agent", title: "写分镜", cfg: { goal: "写一版分镜", outKeys: ["draft"] } },
        {
          id: "h",
          kind: "human",
          title: "交稿",
          cfg: {
            mode: "deliver",
            uid: "ltx-28",
            items: [{ id: "i1", kind: "file", title: "分镜表.md", file: "分镜表.md", required: true, done: false, paths: [] }],
          },
        },
        { id: "e", kind: "end_ok", title: "收工" },
      ],
      edges: [
        { id: "e1", from: "s", to: "a1" },
        { id: "e2", from: "a1", to: "h" },
        { id: "e3", from: "h", to: "e" },
      ],
    };
    const made28 = LT.createFromGraph("预建演示", GRAPH28, wf28);
    ok(made28 && made28.ok === true, "创建任务成功（预建不阻断创建本身）");
    const task28 = LT.tasks(wf28).find((x) => x.uid === made28.uid);
    const TID28 = String(made28.uid);
    const shells28 = wf28.nodes.filter((n) => n.kind === "super");
    eqNum(shells28.length, 2, "父壳 + 环节子壳在创建那一刻就建好（不再等跑到那一环）");
    const root28 = shells28.find((n) => !String(n.ltShellPath || "").trim());
    const step28 = shells28.find((n) => String(n.ltShellPath || "") === "a1");
    ok(!!root28 && !!step28, "预建的壳按 ltShellTask / ltShellPath 认得出身份");
    eqNum(String(root28.ltShellTask), TID28, "父壳绑定任务身份");
    const gens28 = wf28.nodes.filter((n) => String(n.parentSuperId || "") === String(step28.id) && n.ltGenType);
    eqNum(gens28.length, 1, "生成工作流预置到子壳里（缺省图像一枚）");
    ok(!gens28[0].running && !gens28[0].output, "预建的生成节点一个都没跑（不替用户烧额度）");
    const dn28 = wf28.nodes.filter((n) => n.kind === "deliver");
    eqNum(dn28.length, 1, "交付环节的交付节点在创建那一刻建好（旧口径要跑到才建）");
    eqNum(String(dn28[0].ltUid), "ltx-28", "交付节点按图里的交付 uid 认人");
    eqNum(String(dn28[0].ltPath), "h", "交付节点带环节路径");
    eqNum(String(dn28[0].ltRunId), "", "创建期没有 run：ltRunId 留空（启用后按同一 uid 复用）");
    eqNum(dn28[0].__ltSystem, true, "交付节点带 __ltSystem（不进撤销栈、不能手动复制 / 新建）");
    eqNum((dn28[0].ltItems || []).length, 1, "图里的交付清单预置到节点上");
    ok(task28.enabled === false && !String(task28.activeRun || ""), "预建只建不跑：enabled 仍 false、没有 run");
    const nCount28 = wf28.nodes.length;
    sandbox.window.LTSHELL.ensureForTask(wf28, task28);
    eqNum(wf28.nodes.length, nCount28, "预建幂等：再叫一次节点数逐字不变");

    /* 启用（run 起来）之后：预建的壳被认领、交付节点按 uid 复用 —— 一处都不重复建 */
    const prevBind28 = sandbox.window.LTSHELL.bindWf(wf28);
    try {
      const run28 = sandbox.ltRunNew(task28, "wf28", {});
      sandbox.ltInst(run28, "", run28.graph);
      const claim28 = sandbox.window.LTSHELL.ensure(run28, "a1");
      eqNum(claim28.created, 0, "预建壳被启用后的 ltsEnsure 认领：不新建壳");
      eqNum(wf28.nodes.length, nCount28, "认领不动节点：不重长壳、也不重复摆生成工作流");
      ok(
        !!run28.shellPaths && run28.shellPaths[""] === 1 && run28.shellPaths["a1"] === 1,
        "预建的壳按路径登记进 run.shellPaths（此后「删没删」按它判）",
      );
      const h28 = sandbox.ltNodeAt(run28, "h");
      await sandbox.ltExecHuman(run28, "h", h28);
      eqNum(wf28.nodes.filter((n) => n.kind === "deliver").length, 1, "跑到交付环节：按 uid 复用预建的那颗（不重复建）");
      eqNum(run28.nodes["h"].status, "waiting_delivery", "环节照旧转入等交付（流程不变）");
      await sandbox.ltRebindDeliverNodes(run28);
      eqNum(
        wf28.nodes.filter((n) => n.kind === "deliver").length,
        1,
        "恢复现场链路（ltRebindDeliverNodes）也按同一 uid 认人复用（仍然只有一颗）",
      );
      /* 用户把预建的壳删掉：认领过就该按墓碑口径走 —— 只提示不重建 */
      wf28.nodes = wf28.nodes.filter((n) => String(n.ltShellTask || "") !== TID28);
      const gone28 = sandbox.window.LTSHELL.ensure(run28, "a1");
      eqNum(gone28.gone, true, "预建壳被用户删掉 → gone = true（认领之后照旧不偷偷重长）");
      eqNum(wf28.nodes.filter((n) => n.kind === "super").length, 0, "画布上没有壳被静默重建");
      eqNum(run28.shellGone, true, "墓碑落在本 run 上（run.shellGone）");
    } finally {
      sandbox.window.LTSHELL.bindWf(prevBind28);
    }
    sandbox.S.wf = null;
  }

  /* ── [29] 面包屑根条目 = 当前长任务名 + 就地切换旧长任务（本次需求，真跑）──
     以前根条目写死一个「主图」标签：一张画布上可以有好几张长任务，用户在图上却看不出
     自己正看的是哪一张，要换一张还得翻 ⚙ 设置窗。现在它回显**正在画的那张任务名**，
     点它就是任务清单（换一张 / 新建一张），当前那张带 ✓ 且禁用。
     真跑：造两张任务 + 两个不同的 active，看根条目写的到底是不是「正在画的那张」；
     再点开菜单、点其中一项，看 active 有没有真的换过去（含下钻路径作废与落盘）。 */
  console.log("\n[29] 长任务画布：面包屑根条目 = 当前长任务名 · 点它就是任务切换清单（真跑）");
  {
    const evalIn = (code) => vm.runInContext(code, sandbox);
    /* ltRenderGraph 整条链只有面包屑这一段要 DOM：给最小可用的 document（右键菜单与
       缩放回显那几件也在 ltMenuOpen / ltEl 里用同一份 createElement） */
    sandbox.document.createElement = (tag) => {
      const el = {
        tagName: tag,
        className: "",
        id: "",
        type: "",
        title: "",
        style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } },
        hidden: false,
        isConnected: true, /* ltMenuOpen 只对锚点版校验 isConnected（重建后失效的按钮不开菜单） */
        tabIndex: 0,
        children: [],
        onclick: null,
        offsetWidth: 200,
        offsetHeight: 200,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {},
        getAttribute() { return null; },
        removeAttribute() {},
        appendChild(c) { this.children.push(c); return c; },
        insertBefore(c) { this.children.push(c); return c; },
        removeChild() {},
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 500, right: 900, bottom: 500 }; },
        querySelector() { return null; },
        closest() { return null; },
        contains() { return false; },
      };
      Object.defineProperty(el, "textContent", { get() { return el._t; }, set(v) { el._t = String(v); } });
      return el;
    };
    sandbox.document.body = { appendChild() {}, removeChild() {} };
    /* 图那一层还要 SVG：同一只假元素够用（setAttribute / appendChild / 量盒子都实现） */
    sandbox.document.createElementNS = (ns, tag) => sandbox.document.createElement(tag);
    sandbox.document.addEventListener = () => {};
    sandbox.document.removeEventListener = () => {};
    sandbox.document.querySelector = () => null;
    sandbox.window.innerWidth = 1280;
    sandbox.window.innerHeight = 800;
    sandbox.window.addEventListener = () => {};
    sandbox.window.removeEventListener = () => {};

    const wf29 = {
      id: "wf29",
      workspace: "D:\\ws29",
      nodes: [],
      wires: [],
      cam: { x: 0, y: 0, k: 1 },
      longtask: {
        active: "tA",
        tasks: [
          { uid: "tA", name: "主图", ver: 3, enabled: true, activeRun: "", graph: { nodes: [{ id: "s", kind: "start", title: "起点" }], edges: [] } },
          { uid: "tB", name: "旧稿·2024 秋 副线长任务", ver: 1, enabled: false, activeRun: "", graph: { nodes: [], edges: [] } },
        ],
      },
    };
    const taskA = wf29.longtask.tasks[0];
    const taskB = wf29.longtask.tasks[1];
    sandbox.__wf29 = wf29;
    sandbox.__ta29 = taskA;
    sandbox.__tb29 = taskB;

    /* 根条目的文案真源单独成口（可单测），ltRenderGraph 只负责把它挂进面包屑 */
    ok(typeof sandbox.ltCrumbTaskBtn === "function", "新增 ltCrumbTaskBtn：根条目文案与切换菜单单独成口");
    has(LTU, "ltCrumbTaskBtn(wf, task, 0)", "ltRenderGraph 的根条目不再写死文案，改调 ltCrumbTaskBtn（传正在画的 task）");
    hasnt(LTU, 'mk(ltT("主图"), 0)', "「主图」这条写死的面包屑根条目已删除");
    has(LTU, '"lt-crumb-i lt-crumb-root"', "根条目带 .lt-crumb-root（与中间那些路径条目区分开）");

    /* ① 真跑：正在画哪张，根条目就写哪张的名字 */
    const rootA = sandbox.ltCrumbTaskBtn(wf29, taskA, 0);
    eqNum(String(rootA.textContent), "主图 ▾", "active = 主图：根条目回显这张任务的名字（+ 可点开的 ▾）");
    const rootB = sandbox.ltCrumbTaskBtn(wf29, taskB, 0);
    eqNum(String(rootB.textContent), "旧稿·2024 秋 副线长任务 ▾", "换成另一张：名字跟着换（不再一律「主图」）");
    ok(String(rootA.title).indexOf("当前长任务：主图") === 0, "悬浮提示点名当前这张任务");
    ok(/切换到别的长任务/.test(String(rootA.title)), "任务不止一张时，提示里写清「点这里切换」");

    /* ② 真跑：点根条目 = 任务清单（当前那张 ✓ 且禁用，另一张点了真的换过去） */
    sandbox.ltRenderStrip = () => {};
    sandbox.__persist29 = 0;
    sandbox.ltPersistWf = () => { sandbox.__persist29++; };
    /* 菜单落点捕获：ltMenuOpen 收尾会调 ltMenuPlace —— 包一层把那只浮层记下来给断言看
       （顶层的 LT_MENU 是脚本作用域里的 let，从沙箱外读不到） */
    sandbox.__place29 = sandbox.ltMenuPlace;
    sandbox.ltMenuPlace = (el, anchor, pt) => {
      sandbox.__menu29 = { el, anchor };
      return sandbox.__place29(el, anchor, pt);
    };
    const left29 = { children: [], appendChild(c) { this.children.push(c); return c; } };
    sandbox.__left29 = left29;
    sandbox.document.getElementById = () => null;
    sandbox.LT_UI = null;
    evalIn("ltMenuClose(); ltRenderGraph(__left29, __wf29, __ta29, null, __ta29.graph); void 0;");
    const crumb29 = left29.children[0];
    eqNum(String(crumb29.className), "lt-crumb", "面包屑仍是这一行（缩放回显还在这行右端）");
    const root29 = crumb29.children[0];
    eqNum(String(root29.textContent), "主图 ▾", "真跑 ltRenderGraph：根条目写的就是传进去那张任务的名字");
    /* 下钻态：根条目上不吃「回根」——中间那几级路径条目本来就点得回上一层 */
    const rootA2 = sandbox.ltCrumbTaskBtn(wf29, taskA, 1);
    eqNum(String(rootA2.textContent), "主图 ▾", "下钻进子图后根条目仍写任务名（下钻路径另在后面几级）");

    /* ⑤ 下钻态的回程（本次修复）：面包屑末尾那枚「← 返回外层」。
       修之前这里根本没有回根图的条目 —— 根条目那颗按钮是任务切换清单（点当前那张不做
       事），中间几级路径条目最浅也只到第 1 层（mk 收栈是 slice(0, depth)，depth 从 1 起），
       于是双击子图 / 点「⤵ 下钻编辑子图」进去之后就再也退不回最外层图，只能换任务或收起
       整条条带。真跑：造一层下钻 → 按钮出现、点它真的收栈并重绘；退到根图 → 它自己收起。 */
    const leftB29 = { children: [], appendChild(c) { this.children.push(c); return c; } };
    sandbox.__leftB29 = leftB29;
    sandbox.__render29 = 0;
    sandbox.ltRenderStrip = () => { sandbox.__render29++; };
    evalIn("ltDrill = [{ id: 'sub1', title: '子图A' }]; ltRenderGraph(__leftB29, __wf29, __ta29, null, __ta29.graph); void 0;");
    const crumbB29 = leftB29.children[0];
    const back29 = crumbB29.children.filter((c) => String(c.className).indexOf("lt-crumb-back") >= 0)[0];
    ok(!!back29, "下钻态：面包屑末尾有「← 返回外层」（进子图后唯一能回最外层图的入口）");
    eqNum(String(back29.textContent), "← 返回外层", "按钮文案写明退的是外层");
    ok(String(back29.title).indexOf("退回上一层子图") === 0, "悬浮提示说清「退一层 · 到最外层收起」");
    eqNum(crumbB29.children.indexOf(back29), crumbB29.children.length - 2, "它排在路径条目之后、缩放回显之前（同一条面包屑里）");
    eqNum(String(crumbB29.children[1].textContent), "子图A", "下钻出来的那一级路径条目照旧在（标题就是子图名，点它仍可直接跳层）");
    back29.onclick({ stopPropagation() {} });
    eqNum(evalIn("ltDrill.length"), 0, "点一下：下钻栈真的收掉一层（回到最外层图）");
    eqNum(sandbox.__render29, 1, "点一下重绘条带（画面跟着回根图，不是只改按钮）");
    evalIn("ltRenderGraph(__leftB29, __wf29, __ta29, null, __ta29.graph); void 0;");
    /* 每次 ltRenderGraph 往 left 里挂两件（面包屑 + 画布 holder），所以第二帧的面包屑是 [2] */
    const crumbC29 = leftB29.children[2];
    eqNum(crumbC29.children.filter((c) => String(c.className).indexOf("lt-crumb-back") >= 0).length, 0, "回到最外层：这枚按钮自己收起（根态不留一枚点了没用的钮）");
    ok(String(crumbC29.children[0].className).indexOf("lt-crumb-root") >= 0, "根态面包屑仍是「任务名 ▾」打头（根条目没被这枚返回钮顶掉）");
    has(LTU, '"lt-crumb-i lt-crumb-back"', "返回钮借面包屑条目那份样式与悬停两路（另加自己的边与字色）");
    has(LTU, "ltDrill = ltDrill.slice(0, ltDrill.length - 1)", "返回 = 逐层退（与路径条目直接跳层并用，两条路都通）");
    has(LTCSS, ".lt-crumb-back {", "返回钮有独立样式（常态亮一档 + 带边）");
    has(LTCSS, ".lt-crumb-i.on:has(+ .lt-crumb-back)::after", "最深那级后面跟的是返回钮时收掉「里面还有一层」的 ▸");
    has(I18N, '"← 返回外层"', "i18n 源文件里有「← 返回外层」词条");
    has(I18N, '"← 返回外层": "← Back to outer graph"', "英文词条成对（切英文不出现中文半截）");

    root29.onclick({ stopPropagation() {} });
    const pop29 = sandbox.__menu29;
    ok(!!pop29, "点根条目真的开出一只下拉（走 ltMenuOpen：贴锚点 · 点外部 / Esc 即收）");
    const labels29 = pop29.el.children.filter((c) => c.tagName === "button").map((c) => String(c.textContent));
    eqNum(labels29[0], "✓ 主图", "清单第一项是当前这张（带 ✓）");
    eqNum(labels29[1], "旧稿·2024 秋 副线长任务", "旧长任务原样列出来（名字照抄，不另造词）");
    eqNum(labels29[labels29.length - 1], "＋ 创建长任务", "清单末尾是「＋ 创建长任务」（新建入口不丢）");
    eqNum(String(pop29.el.children[0].className), "lt-more-i lt-crumb-cur", "当前那张带 .lt-crumb-cur（样式上压暗 + 点不动）");
    pop29.el.children[0].onclick();
    eqNum(wf29.longtask.active, "tA", "点当前那张：什么都不做（它就是此刻显示的这一张）");
    eqNum(sandbox.__persist29, 0, "点当前那张不落盘（没有真的切换）");
    pop29.el.children[1].onclick();
    eqNum(wf29.longtask.active, "tB", "点旧长任务那一项：active 真的换成它（与 ⚙ 里那张下拉同一份真源）");
    eqNum(sandbox.__persist29, 1, "切换落盘一次（切走再切回来仍是这张）");
    eqNum(evalIn("ltDrill.length"), 0, "换了任务 = 换了一整棵图：下钻路径作废（子图不是这张任务里的了）");
    eqNum(String(evalIn("ltSel.path")), "", "选中的环节一并清掉（别指着上一张图里的节点）");
    sandbox.ltMenuPlace = sandbox.__place29;

    /* ③ 硬编码闸：根条目文案只回显任务名，没有第二处写死的「主图」标签 */
    hasnt(LTU, 'ltEl("button", "lt-crumb-i", ltT("主图")', "没有第二处写死的「主图」根标签");
    hasnt(LTU, "ltT(\"主图\")", "整个界面文件里再也没有「主图」这条写死文案（只剩任务名与后缀）");
    has(LTU, 'rootBtn = ltCrumbTaskBtn(', "根条目走同一处真源（换名字只改一处）");

    /* ④ 样式：根条目重一档 + 展开态 + 清单里的「当前项 / 空态项」 */
    has(LTCSS, ".lt-crumb-root {", "根条目有自己的样式（限宽省略号，长任务名不撑破这一行）");
    has(LTCSS, ".lt-crumb-root:hover", "根条目 hover 与 [data-hover] 并排写（与其它可点件的补标口径一致）");
    has(LTCSS, ".lt-crumb-root.on {", "展开中按 .on 亮边（与头部下拉同款「这里开着」的提示）");
    has(LTCSS, ".lt-more-i.lt-crumb-cur", "清单里「当前这张」有压暗样式（点了不做事，一眼看得出）");
    has(LTCSS, ".lt-more-i.lt-crumb-none", "「这张画布还没有长任务」的说明项也有样式（不是按钮手感）");
    sandbox.LT_UI = null;
  }

  console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-longtask)");
}

main().catch((e) => {
  console.log("测试异常：" + String((e && e.stack) || e));
});

/* ==================== 已并入：test/smoke-longtask-artifacts.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-artifacts.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const ROOT = path.join(__dirname, "..");
  /* 行尾统一成 \n：工作区里的源码可能是 CRLF（git autocrlf / 编辑器各异），
     下面有跨行断言（如 NODE_DEFAULTS 的 "ltart: {\n    w: 260,"），不归一就会误报。 */
  const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8").replace(/\r\n?/g, "\n");
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
  const NODES = read("renderer/app-nodes.js");
  const CANVASJS = read("renderer/app-canvas.js");
  const HELP = read("renderer/app-nodehelp.js");
  const I18N_SRC = read("renderer/i18n.js");
  const HTML = read("renderer/index.html");
  const LTCSS = read("renderer/css/longtask.css");
  const LTV = read("renderer/app-longtask.js");
  const LTARTJS = read("renderer/app-longtask-artifacts.js");
  const MANUAL = read("guides/manual/longtask.md");

  /* ═══════════════ [1] 装配与文档（静态） ═══════════════ */
  console.log("\n[1] 装配：加载顺序 / LOCKED / 登记与端子 / 渲染分支 / css / 指南");
  has(HTML, '<script src="app-longtask-artifacts.js"></script>', "index.html 引入 app-longtask-artifacts.js");
  ok(
    HTML.indexOf('src="app-longtask.js"') >= 0 &&
      HTML.indexOf('src="app-longtask.js"') < HTML.indexOf('src="app-longtask-artifacts.js"'),
    "加载顺序在 app-longtask.js 之后（用到它的登记层与 makeNode）",
  );
  has(LTV, 'LOCKED: ["deliver", "ltout", "ltart"]', "LT.LOCKED 含 ltart（手动 / 复制 / 智能体建图三处闸都读它）");
  has(APP, 'ltart: "ltart"', "KIND_CLS 有 ltart → 主画布按类上色");
  has(APP, "ltart: {\n    w: 260,", "NODE_DEFAULTS 有 ltart（渲染 / 尺寸 / 字段缺省都靠它）");
  has(APP, 'if (n.kind === "ltart") return 0;', "输出端子 0 个（产物节点不向下游出数据）");
  has(APP, 'if (node.kind === "ltart") return 0;', "输入端子 0 个（连不了线）");
  has(APP, 'ltart: "产物"', "kind 名显示为「产物」");
  has(APP, 'ltart: "产物节点（长周期任务 · 每件产物一颗 · 板身预览 · ✎ 编辑保存 · ⇢ 打开）"', "设置项用途说明到位（含头部 ✎ 编辑保存入口）");
  has(CANVASJS, "function buildLtartBody(", "板身按产物类型预览（buildLtartBody）");
  has(CANVASJS, "function ltartOpenButtonEl(", "头部有「用系统程序打开」入口");
  has(CANVASJS, 'if (node.kind === "ltart") {', "节点头部走 ltart 分支");
  has(CANVASJS, "buildLtartBody(node, body);", "buildBody 分派到 ltart 板身");
  has(CANVASJS, "fileUrlWithBust(p, bust)", "预览走 file:// URL + bust（同路径覆盖后不吃缓存）");
  has(LTCSS, ".wf-node.ltart {", "产物节点有 .ltart 一族配色");
  has(LTCSS, "body.theme-light .wf-node.ltart", "浅色主题同口径");
  has(LTCSS, ".n-ltart-stage", "预览舞台有样式");
  has(LTCSS, ".n-ltart-path", "完整路径有样式");
  has(HELP, "ltart:", "app-nodehelp 的 KIND_HELP 有它（? 按钮不说「暂无说明」）");
  /* ── 产物所在文件夹（头部 📁）：长任务产物常扎堆在一个输出目录里，用户的下一个动作
     多半是去那个目录接着翻别的文件，所以头部再给一枚「打开所在文件夹」（与 ⇢ 同排）。
     这里既钉静态入口 / 通道 / 样式 / 词条，也把文件夹路径的切分纯函数真跑一遍。 */
  has(CANVASJS, "function ltartDirOf(", "有从产物路径切出文件夹的纯函数（不动 node 字段）");
  has(CANVASJS, "function ltartFolderButtonEl(", "头部有「打开所在文件夹」入口按钮");
  has(CANVASJS, 'b.className = "n-play n-ltart-folder";', "按钮走 .n-play + 专属 .n-ltart-folder");
  has(CANVASJS, "head.appendChild(ltartFolderButtonEl(node));", "ltart 节点头部真的摆了这枚按钮");
  has(
    CANVASJS,
    'if (String(node.ltFile || "").trim()) head.appendChild(ltartFolderButtonEl(node));',
    "没有文件路径时不摆空按钮（点了只会弹提示）",
  );
  has(CANVASJS, "window.api.shellShowItem(p)", "走 shellShowItem（在文件管理器中定位并选中该文件）");
  has(CANVASJS, "window.api.shellOpenPath(dir)", "老 preload 没有 showItem 通道时退回 shellOpenPath(文件夹)");
  has(LTCSS, ".wf-node.ltart .n-head .n-ltart-folder", "这枚按钮与 ⇢ / ✎ 同排等宽、不参与收缩（挤不没）");
  has(I18N_SRC, '"打开这件产物所在的文件夹（在文件管理器中显示）"', "i18n 表里有按钮 tooltip 词条");
  has(I18N_SRC, '"打开产物所在文件夹"', "i18n 表里有 aria-label 词条");
  has(I18N_SRC, "shown in the file manager", "英文词条成对（切英文不回中文）");
  has(HELP, "点 📁 打开它所在的文件夹", "? 按钮说明里也提到这枚入口");
  has(read("guides/nodes/ltart.md"), "📁", "指南写明「打开所在文件夹」入口");
  has(read("guides/nodes/en/ltart.md"), "Open its folder", "英文指南成对（AGENTS：指南中英同步）");
  {
    /* 切分纯函数真跑：Windows 反斜杠 / POSIX 正斜杠 / 盘符根 / 根 / 相对 / 无分隔符。
       ltartDirOf 自包含（不引用任何画布全局），可单独在 vm 里装起来验行为。 */
    const fnSrc = (CANVASJS.match(/function ltartDirOf\(p\) \{[\s\S]*?\n\}/) || [])[0];
    ok(!!fnSrc, "能在源码里切出 ltartDirOf 的函数体");
    const box = {};
    vm.createContext(box);
    vm.runInContext(String(fnSrc || "function ltartDirOf(){return '';}") + "\nthis.dirOf = ltartDirOf;", box);
    const dirOf = box.dirOf;
    const cases = [
      ["C:\\ws\\out\\a.png", "C:\\ws\\out", "Windows 绝对路径切出父目录"],
      ["/home/u/out/a.mp4", "/home/u/out", "POSIX 路径切出父目录"],
      ["out\\sub\\a.md", "out\\sub", "相对路径照切（不特判盘符）"],
      ["E:\\a.png", "E:\\", "盘符根：保留根并补回分隔符（不能切成一截盘符）"],
      ["/a.png", "/", "POSIX 根：留下根"],
      ["a.png", "", "没有分隔符（纯文件名）→ 空串，按钮显式提示而不是瞎猜目录"],
    ];
    for (const [input, want, msg] of cases)
      ok(dirOf(input) === want, msg + "（" + JSON.stringify(input) + " → " + JSON.stringify(dirOf(input)) + "，期望 " + JSON.stringify(want) + "）");
  }
  for (const k of [
    "产物",
    "产物节点（长周期任务 · 每件产物一颗 · 板身预览 · ✎ 编辑保存 · ⇢ 打开）",
    "用系统默认程序打开这件产物（路径见节点底部）",
    "这类文件不在节点里预览 · 点上方 ⇢ 用系统程序打开",
  ])
    has(I18N_SRC, '"' + k + '"', "i18n 表里有词条：" + k);
  has(I18N_SRC, "one node per artifact", "英文词条成对（切英文不回中文）");
  ok(exists("guides/nodes/ltart.md"), "guides/nodes/ltart.md 存在（AGENTS：新增节点类型必须补指南）");
  ok(exists("guides/nodes/en/ltart.md"), "guides/nodes/en/ltart.md 存在（中英成对）");
  has(read("guides/nodes/index.json"), '"ltart"', "guides/nodes/index.json 登记 ltart");
  has(read("guides/nodes/ltart.md"), "一件产物 = 一颗节点", "指南写明「一件产物一颗节点」");
  has(read("guides/nodes/ltart.md"), "复用同一颗节点", "指南写明认人复用（重跑不堆）");
  has(MANUAL, "产物节点", "应用内手册写明产物节点");
  has(MANUAL, "一件一件摆成主画布上的「产物节点」", "手册写明逐件摆上画布的口径");
  has(MANUAL, "上游环节交下来的输入文件不会在下游再摆一遍", "手册写明只摆本环节自己的产物");
  /* ═══════════════ [2][3] 真跑（vm） ═══════════════ */
  async function main() {
    console.log("\n[2] 数据层真跑：分类 / 清点 / 认人复用 / 读不到不摆 / 上限 / 排版");
    const files = new Map();
    const setFile = (p, mtime, size, content) => files.set(String(p), { mtime, size, content });
    let nodeSeq = 0;
    const S = { wf: { id: "wf-art", nodes: [], cam: { x: 0, y: 0, k: 1 } }, config: {}, _skipCanvasHistory: false };
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
      toast() {},
      scheduleSave() {},
      renderCanvas() {},
      focusNode() {},
      addNode(kind, x, y, extra) {
        const n = Object.assign(
          { id: "ltn" + ++nodeSeq, kind: kind, x: x, y: y, w: 360, h: 260, title: kind, text: "" },
          extra || {},
        );
        S.wf.nodes.push(n);
        return n;
      },
      /* app.js 的 makeNode / uniqueNodeTitle 在沙箱里的等价物：本模块只依赖这两个建节点原语 */
      makeNode(kind, x, y) {
        return { id: "ltart" + ++nodeSeq, kind: kind, x: x, y: y, w: 260, h: 210, title: "产物" };
      },
      uniqueNodeTitle(desired) {
        let t = String(desired || "");
        let i = 2;
        while (S.wf.nodes.some((n) => n.title === t)) t = String(desired) + " " + i++;
        return t;
      },
      console, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp,
    };
    vm.createContext(sandbox);
    vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
    vm.runInContext(LTARTJS, sandbox, { filename: "renderer/app-longtask-artifacts.js" });
    const LA = sandbox.window.LTART;
    const LT = sandbox.window.LT;
    ok(!!sandbox.window.LT && !!LA, "两份脚本在同一沙箱里整份执行并导出 window.LT / window.LTART（顶层不碰 DOM）");

    /* 分类：什么类型走什么预览形态 */
    eqNum(LA.typeOf("C:\\out\\shot01.PNG"), "image", "扩展名大小写不敏感：PNG → 图像");
    eqNum(LA.typeOf("C:\\out\\pilot.mp4"), "video", "mp4 → 视频");
    eqNum(LA.typeOf("C:\\out\\voice.wav"), "audio", "wav → 音频");
    eqNum(LA.typeOf("C:\\out\\shotlist.md"), "text", "md → 文本");
    eqNum(LA.typeOf("C:\\out\\镜头清单.csv"), "text", "中文名的 csv → 文本");
    eqNum(LA.typeOf("C:\\out\\pack.zip"), "file", "未知类型落到「文件」（有路径 + 打开入口，不算漏）");
    eqNum(LA.fileName("C:\\out\\shots\\01.mp4"), "01.mp4", "文件名从任意分隔符里取尾段");

    /* ⓪ 关键文件口径（本轮需求）：清点出来的东西不是全都值得占画布 ——
       画布只摆用户该读 / 该收的（报告文档 / 数据表 / 成品图），中间件与音视频一律不摆。
       只影响**自动摆放**：交付环节用户亲手确认的交付件另走一条，不受这里的裁剪影响。 */
    ok(typeof LA.pickKeyFiles === "function", "导出 pickKeyFiles（清点与挑选分开，ownPaths 口径不动）");
    eqNum(LA.pickClassOf("C:\\out\\shotlist.md"), "doc", "报告文档一行 md → doc");
    eqNum(LA.pickClassOf("C:\\out\\分镜表.pdf"), "doc", "pdf → doc（交付给用户读的成稿）");
    eqNum(LA.pickClassOf("C:\\out\\角色表.csv"), "data", "数据表 csv → data");
    eqNum(LA.pickClassOf("C:\\out\\成片.png"), "image", "成品图 png → image");
    eqNum(LA.pickClassOf("C:\\out\\pilot.mp4"), null, "视频不是「读」的东西 → 不摆（画布上只多一个播放器）");
    eqNum(LA.pickClassOf("C:\\out\\voice.wav"), null, "音频同样不摆");
    eqNum(LA.pickClassOf("C:\\out\\run.log"), null, "运行日志不摆");
    eqNum(LA.pickClassOf("C:\\out\\shots.json"), null, "中间件 JSON 不摆（产出节点引用清单里照旧有）");
    eqNum(LA.pickClassOf("C:\\out\\pack.zip"), null, "归档 / 依赖包不摆");
    eqNum(
      LA.pickKeyFiles([
        "C:\\out\\a.mp4",
        "C:\\out\\b.log",
        "C:\\out\\c.md",
        "C:\\out\\d.csv",
        "C:\\out\\e.png",
        "C:\\out\\f.json",
        "C:\\out\\c.md",
      ]).join("|"),
      "C:\\out\\c.md|C:\\out\\d.csv|C:\\out\\e.png",
      "挑选 = 只留关键件（去重 + 报告 → 数据表 → 成品图的顺序）",
    );
    eqNum(LA.pickKeyFiles(["C:\\out\\a.mp4", "C:\\out\\b.log"]).length, 0, "整轮只有中间件时不摆任何东西（画布保持干净）");
    eqNum(
      LA.pickKeyFiles(["C:\\out\\1.md", "C:\\out\\2.md", "C:\\out\\3.csv"], 2).join("|"),
      "C:\\out\\1.md|C:\\out\\2.md",
      "挑选也吃上限（与产物节点上限同源，不把画布铺满）",
    );

    const mkRun = (uid) =>
      sandbox.ltRunNew({ uid: uid, name: "演示任务", graph: LT.norm({ nodes: [], edges: [] }) }, "wf-art", {});
    const P1 = "C:\\ws\\output\\shots\\pilot.md";
    const P2 = "C:\\ws\\output\\shots\\01.png";
    const P3 = "C:\\ws\\assets\\script\\shotlist.md";
    setFile(P1, 1000, 2048, "");
    setFile(P2, 1000, 4096, "");
    setFile(P3, 1000, 128, "# 分镜\n1. 开场");

    /* ① 清点 + 逐个放置 */
    const runA = mkRun("taskArtA");
    sandbox.ltInst(runA, "", runA.graph);
    let res = await LA.publish(runA, "shots", [P1, P2, P3, P1]);
    eqNum(res.placed, 3, "三件关键文件逐个摆上画布（重复路径只算一件）");
    const arts = S.wf.nodes.filter((n) => n.kind === "ltart");
    eqNum(arts.length, 3, "画布上真的多了三颗 kind ltart 节点");
    const n1 = arts.find((n) => n.ltFile === P1);
    ok(!!n1, "报告那件的节点在");
    eqNum(n1.ltTaskUid, "taskArtA", "节点带任务身份（认人靠它）");
    eqNum(n1.ltPath, "shots", "节点带环节路径");
    eqNum(n1.ltType, "text", "节点带类型（渲染形态按它选）");
    eqNum(n1.ltName, "pilot.md", "节点带文件名");
    eqNum(n1.ltSize, 2048, "节点带大小");
    eqNum(n1.ltMtime, 1000, "节点带 mtime（预览 bust 用）");
    ok(/^产物 · 文本 · pilot\.md$/.test(n1.title), "标题 = 「产物 · 类型 · 文件名」（得到 " + n1.title + "）");
    ok(n1.title.indexOf("产物") === 0, "标题前缀是「产物」");
    const n2 = arts.find((n) => n.ltFile === P2);
    eqNum(n2.ltType, "image", "png 那件按图像渲染");
    const n3 = arts.find((n) => n.ltFile === P3);
    eqNum(n3.ltType, "text", "md 那件按文本给摘要");

    /* ② 认人复用：再发布不新建，只更新指纹 */
    setFile(P1, 2000, 8192, "");
    res = await LA.publish(runA, "shots", [P1, P2, P3]);
    eqNum(res.placed, 0, "再发布：不新建节点");
    eqNum(res.updated, 3, "三件全部走「更新已有节点」");
    eqNum(S.wf.nodes.filter((n) => n.kind === "ltart").length, 3, "画布上仍只有三颗（重跑 / 回跳不堆新节点）");
    eqNum(arts.find((n) => n.ltFile === P1).ltSize, 8192, "已有节点的指纹跟到最新一版");

    /* ③ 只算本环节自己的产物：上游交下来的输入不在下游再摆一遍 */
    const runB = mkRun("taskArtB");
    sandbox.ltInst(runB, "", runB.graph);
    sandbox.ltStatePut(runB, "", "upstream_png", P2); /* 上游环节写进父命名空间 */
    res = await LA.publish(runB, "child", [P2, P3]);
    eqNum(res.placed, 1, "父命名空间里已有的 P2 被剔除（只摆本环节自己的 P3）");
    ok(!S.wf.nodes.some((n) => n.kind === "ltart" && n.ltPath === "child" && n.ltFile === P2), "下游环节没有重复摆上游的图");
    ok(S.wf.nodes.some((n) => n.kind === "ltart" && n.ltPath === "child" && n.ltFile === P3), "本环节自己的产物照摆");
    eqNum(LA.ownPaths(runB, "child", [P2, P3]).join("|"), P3, "ownPaths 直接给出「只剩自己的」那份清单");

    /* ④ 读不到 = 此刻不算产物（不摆死卡） */
    const runC = mkRun("taskArtC");
    sandbox.ltInst(runC, "", runC.graph);
    res = await LA.publish(runC, "shots", ["C:\\ws\\output\\ghost.mp4"]);
    eqNum(res.placed, 0, "读不到的路径不摆（避免画布上出现一张死卡）");

    /* ⑤ 上限：map 展开很多实例时不把画布铺满 */
    const runD = mkRun("taskArtD");
    sandbox.ltInst(runD, "", runD.graph);
    const many = [];
    for (let i = 0; i < 40; i++) {
      const p = "C:\\ws\\output\\bulk\\f" + i + ".txt";
      setFile(p, 1000, 10, "x");
      many.push(p);
    }
    res = await LA.publish(runD, "shots", many);
    eqNum(res.placed, LA.MAX, "单次最多摆 MAX（" + LA.MAX + "）件");

    /* ⑤之二 关键件闸：清点出来的中间件不占画布（本轮需求的核心），
       但清点口径（ownPaths）照旧 —— 文件没丢，只是不摆到画布上。 */
    S.wf.nodes.length = 0;
    const runK = mkRun("taskArtK");
    sandbox.ltInst(runK, "", runK.graph);
    const K1 = "C:\\ws\\raw\\shots.json";
    const K2 = "C:\\ws\\out\\take-01.mp4";
    const K3 = "C:\\ws\\out\\run.log";
    const K4 = "C:\\ws\\out\\报告.md";
    setFile(K1, 1000, 10, "{}");
    setFile(K2, 1000, 10, "");
    setFile(K3, 1000, 10, "");
    setFile(K4, 1000, 10, "# 报告");
    res = await LA.publish(runK, "shots", [K1, K2, K3, K4]);
    eqNum(res.own, 4, "清点口径不动：本环节写出来的四件全部记账");
    eqNum(res.selected, 1, "其中只有报告那件是关键件");
    eqNum(res.placed, 1, "画布上只摆这一件");
    ok(
      S.wf.nodes.some((n) => n.kind === "ltart" && n.ltFile === K4),
      "摆上来的正是报告（用户要读的那件）",
    );
    ok(
      !S.wf.nodes.some((n) => n.kind === "ltart" && [K1, K2, K3].indexOf(n.ltFile) >= 0),
      "中间件 / 视频 / 日志一件都没占画布",
    );

    /* ⑥ 排版：新节点不压住既有节点 */
    S.wf.nodes.length = 0;
    const runE = mkRun("taskArtE");
    sandbox.ltInst(runE, "", runE.graph);
    const blocker = { id: "blk", kind: "input_text", x: 700, y: 0, w: 300, h: 300, title: "挡路的节点" };
    S.wf.nodes.push(blocker);
    setFile("C:\\ws\\output\\layout\\a.png", 1000, 10, "");
    setFile("C:\\ws\\output\\layout\\b.csv", 1000, 10, "");
    await LA.publish(runE, "shots", ["C:\\ws\\output\\layout\\a.png", "C:\\ws\\output\\layout\\b.csv"]);
    const placedNodes = S.wf.nodes.filter((n) => n.kind === "ltart");
    eqNum(placedNodes.length, 2, "两件关键文件都摆上了");
    const hit = (a, b) =>
      !(Number(a.x) + Number(a.w) <= Number(b.x) || Number(b.x) + Number(b.w) <= Number(a.x) || Number(a.y) + Number(a.h) <= Number(b.y) || Number(b.y) + Number(b.h) <= Number(a.y));
    ok(!placedNodes.some((n) => hit(n, blocker)), "新摆的产物节点不压住既有节点（自动找空位）");
    ok(!hit(placedNodes[0], placedNodes[1]), "两件产物彼此也不重叠（按空位网格排开）");

    /* ⑦ Agent 相对路径产物（线上 bug 的回归）：`write` 工具的入参是工作区相对路径
       （assets/H3提示词/shot-01.md），状态里写回的也常是一段含相对路径的散文 ——
       只认「整串绝对路径」会把一整轮产物全部漏掉（用户看到「文件落了盘、画布上什么都没有」）。 */
    S.wf.nodes.length = 0;
    const runG = mkRun("taskArtG");
    sandbox.ltInst(runG, "", runG.graph);
    runG.ws = "C:\\ws";
    const RA1 = "C:\\ws\\assets\\H3提示词\\shot-01.md";
    const RA2 = "C:\\ws\\assets\\H3提示词\\shot-02.md";
    const RA3 = "C:\\ws\\assets\\script\\shotlist.md";
    setFile(RA1, 1000, 100, "# S01");
    setFile(RA2, 1000, 100, "# S02");
    setFile(RA3, 1000, 100, "# 分镜表");
    sandbox.ltNoteArtifactTool(runG, "script", {
      name: "write",
      args: JSON.stringify({ file_path: "assets/H3提示词/shot-01.md", content: "x" }),
    });
    eqNum((runG.arts.script || []).join("|"), RA1, "write 工具的相对入参按工作目录解析成绝对路径记账");
    sandbox.ltNoteArtifactTool(runG, "script", {
      name: "str_replace_editor",
      args: JSON.stringify({ command: "view", path: "assets/H3提示词/shot-02.md" }),
    });
    eqNum((runG.arts.script || []).length, 1, "str_replace_editor 的 view（只读）不算产物");
    sandbox.ltNoteArtifactTool(runG, "script", {
      name: "pwsh",
      args: JSON.stringify({ command: "Get-Content assets/H3提示词/shot-02.md" }),
    });
    eqNum((runG.arts.script || []).length, 1, "shell 工具不按入参路径记账（读到的文件不是产物）");
    sandbox.ltNoteArtifactTool(runG, "script", {
      name: "edit",
      args: JSON.stringify({ file_path: "assets/H3提示词/shot-02.md", old_string: "a", new_string: "b" }),
    });
    ok((runG.arts.script || []).indexOf(RA2) >= 0, "edit 改过的文件也算本环节产物");
    eqNum(LA.ownPaths(runG, "script", ["assets/script/shotlist.md"]).join("|"), RA3, "ownPaths 认相对路径");

    sandbox.ltStatePut(
      runG,
      "script",
      "script_path",
      "assets/script/shotlist.md（分镜表·106 秒/12 段）\n根剧本：Deepseek娘与MTNode画布_动画剧本.md",
    );
    setFile("C:\\ws\\Deepseek娘与MTNode画布_动画剧本.md", 1000, 100, "# 剧本");
    let pathsG = await sandbox.ltOutputPathsOf(runG, "script");
    ok(pathsG.indexOf(RA3) >= 0, "状态里的散文也能抽出相对路径（shotlist.md）");
    ok(pathsG.indexOf(RA1) >= 0, "工具记账的产物一起进清单（shot-01.md）");
    await sandbox.ltOutputPublish(runG, "script", { text: "本轮正文", files: pathsG });
    const artsG = S.wf.nodes.filter((n) => n.kind === "ltart");
    ok(artsG.some((n) => n.ltFile === RA1), "线上 bug 回归：相对路径写出来的产物真的摆上了画布");
    ok(artsG.some((n) => n.ltFile === RA3), "状态里抽出相对路径的那件也摆上了画布");
    ok(S.wf.nodes.filter((n) => n.kind === "ltout").length === 1, "产出节点照旧落画布");

    /* ⑧ 兜底清点：产物不从工具入参经过（外部程序把文件写进工作目录）时按时间窗扫一遍 */
    S.wf.nodes.length = 0;
    const runH = mkRun("taskArtH");
    sandbox.ltInst(runH, "", runH.graph);
    runH.ws = "C:\\ws";
    const stH = sandbox.ltStat(runH, "shots");
    stH.startedAt = 5000;
    setFile("C:\\ws\\out\\from-shell.md", 6000, 10, "# 导出的报告");
    sandbox.window.api.fileListDir = async (dir) => ({
      ok: true,
      list: [{ name: "from-shell.md", rel: "out/from-shell.md", isDir: false, mtime: 6000 }],
    });
    const scanned = await sandbox.ltStageWindowFiles(runH, "shots");
    eqNum(scanned.join("|"), "C:\\ws\\out\\from-shell.md", "时间窗内新增的文件被兜底清点出来");
    pathsG = await sandbox.ltOutputPathsOf(runH, "shots");
    eqNum(pathsG.length, 1, "状态与工具记账都空手时退回扫工作目录");

    /* ⑨ 旧 checkpoint 救援：早于本功能的 run 里产物一条都没记，点「继续」时按时间窗补摆 */
    S.wf.nodes.length = 0;
    const gI = LT.norm({ nodes: [{ id: "shots", kind: "agent", title: "写分镜", cfg: {} }], edges: [] });
    const runI = sandbox.ltRunNew({ uid: "taskArtI", name: "演示任务", graph: gI }, "wf-art", {});
    sandbox.ltInst(runI, "", runI.graph);
    runI.ws = "C:\\ws";
    const stI = sandbox.ltStat(runI, "shots");
    stI.status = "done";
    stI.startedAt = 5000;
    stI.finishedAt = 9000;
    setFile("C:\\ws\\out\\legacy.md", 6000, 10, "# 旧现场");
    sandbox.window.api.fileListDir = async () => ({
      ok: true,
      list: [{ name: "legacy.md", rel: "out/legacy.md", isDir: false, mtime: 6000 }],
    });
    eqNum(await sandbox.ltArtRescueDone(runI), 1, "旧 checkpoint 的环节按自己的时间窗补摆产物");
    ok(
      S.wf.nodes.some((n) => n.kind === "ltart" && n.ltFile === "C:\\ws\\out\\legacy.md"),
      "补摆的正是这个窗口里写出来的那件",
    );
    eqNum(await sandbox.ltArtRescueDone(runI), 0, "已经有产物节点的环节不再重复扫（幂等）");

    /* ═══════════════ [3] 引擎联动 ═══════════════ */
    console.log("\n[3] 引擎联动：ltOutputPublish 里真的调了放置（产出节点 + 产物节点一起落画布）");
    S.wf.nodes.length = 0;
    has(LTV, "if (typeof ltArtPublish === \"function\") {", "引擎按全局判空调用放置（模块缺席也不拦断产出回流）");
    has(LTV, "if (type === \"tool\") ltNoteArtifactTool(run, path, data);", "引擎在 Agent 事件流上真记写文件工具入参");
    has(LTV, "const LT_ART_WRITE_TOOL =", "写文件工具名单是显式常量（不是散落的魔法正则）");
    has(LTV, "run.ws = ws;", "运行工作目录记进 run（相对路径解析的根）");
    has(LTV, "const back = await ltArtRescueDone(j);", "打开画布（ltRestore）时对旧 checkpoint 补摆产物");
    has(LTV, "const back = await ltArtRescueDone(run);", "点「▶ 继续」（ltResume）时同样补摆一次");
    has(I18N_SRC, '"旧版本留下的现场：已把 "', "补摆日志有 i18n 词条（切英文不回中文）");
    has(I18N_SRC, "artifacts onto the canvas", "补摆日志英文成对");
    const runF = mkRun("taskArtF");
    sandbox.ltInst(runF, "", runF.graph);
    const pF = "C:\\ws\\output\\linked\\final.md";
    setFile(pF, 3000, 999, "");
    sandbox.ltStatePut(runF, "shots", "shot_file", pF); /* Agent 把落盘路径写回本环节状态 */
    await sandbox.ltOutputPublish(runF, "shots", { text: "本环节正文", files: await sandbox.ltOutputPathsOf(runF, "shots") });
    eqNum(S.wf.nodes.filter((n) => n.kind === "ltout").length, 1, "产出节点照旧落画布（产出回流没有被动过）");
    const linked = S.wf.nodes.filter((n) => n.kind === "ltart");
    eqNum(linked.length, 1, "产物节点同一次发布就摆上来了（引擎联动真的通）");
    eqNum(linked[0].ltFile, pF, "摆的正是本环节落盘的那件产物");
    eqNum(linked[0].ltPath, "shots", "归属到本环节路径");

    /* ═══════════════ [9] 真跑：入口显隐 + 保存后刷新 ═══════════════ */
    console.log("\n[9] 真跑：✎ 入口显隐 / 保存事件 → 重读指纹刷新板身");
    /* ltartEditButtonEl / ltartRefreshSavedFile 引用的画布全局（document / S / toast / I18n /
       scheduleSave / renderCanvas / window.api）在这里都补成最小桩：只需要装这两个函数体，
       不整份跑 app-canvas.js（顶层会碰真实 DOM）。带 I18n.t 前缀的字符串取值，与运行期一致。 */
    {
      const grab = (name) =>
        (CANVASJS.match(new RegExp("function " + name + "\\([^)]*\\)[ \\t]*\\{[\\s\\S]*?\\n\\}")) || [])[0];
      /* 装真身：类型判定 + 三枚同排入口 + 编辑入口 + 刷新函数 + 监听，都是 app-canvas.js 里的原文；
         只把它们的画布全局（document / S / toast / I18n / scheduleSave / renderCanvas / api）补成桩。
         只读预览入口（ltartTextPreviewButtonEl）已随本轮「移除预览、只留编辑」删除，不再切它。 */
      const typeFn = grab("ltartTypeOfNode");
      const openFn = grab("ltartOpenButtonEl");
      const folderFn = grab("ltartFolderButtonEl");
      const editFn = grab("ltartEditButtonEl");
      const refreshFn = grab("ltartRefreshSavedFile");
      const listenerSrc = (CANVASJS.match(/document\.addEventListener\("mtnode:file-saved"[\s\S]*?\n  \}\);/) || [])[0];
      ok(
        !!typeFn && !!openFn && !!folderFn && !!editFn && !!refreshFn && !!listenerSrc,
        "能在源码里切出类型判定 / 三枚入口 / 刷新函数 / 保存监听的全部函数体",
      );
      const listeners = {};
      const saved = { count: 0, auto: 0, renders: 0 };
      const statByPath = {
        "C:\\ws\\out\\shot.md": { ok: true, size: 4321, mtime: 7777 },
        "C:\\ws\\out\\other.md": { ok: true, size: 9, mtime: 8 },
      };
      const opened = [];
      const nodeEdit = { id: "e1", kind: "ltart", title: "产物 · 文本 · shot.md", ltFile: "C:\\ws\\out\\shot.md", ltSize: 100, ltMtime: 1000 };
      const nodeOther = { id: "e2", kind: "ltart", title: "产物 · 文本 · other.md", ltFile: "C:\\ws\\out\\other.md", ltSize: 1, ltMtime: 1 };
      const nodeImage = { id: "e3", kind: "ltart", title: "产物 · 图像 · a.png", ltFile: "C:\\ws\\out\\a.png", ltSize: 10, ltMtime: 2 };
      const nodeNoPath = { id: "e4", kind: "ltart", title: "产物 · 文本（旧版）", ltFile: "", ltSize: 0, ltMtime: 0 };
      const box = {
        S: { wf: { nodes: [nodeEdit, nodeOther, nodeImage, nodeNoPath] } },
        I18n: { t: (s) => s },
        toast(msg, kind) { box.toasts.push([msg, kind]); },
        toasts: [],
        renderCanvas() {
          saved.renders++;
        },
        scheduleSave(auto) {
          saved.count++;
          if (auto === true) saved.auto++;
        },
        window: {
          LTART: LA,
          api: {
            fileStat: async (p) => statByPath[String(p)] || { ok: false, exists: false },
            fileReadText: async () => ({ ok: true, exists: true, content: "x" }),
          },
        },
        openTextViewer(p) {
          opened.push(p);
        },
        document: {
          createElement(tag) {
            if (String(tag) !== "button") return {};
            return {
              tagName: "button",
              setAttribute() {},
              getAttribute() {
                return "";
              },
            };
          },
          addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
          },
        },
        console, Promise, Math, Number, String, Object, Array, JSON,
      };
      box.globalThis = box;
      vm.createContext(box);
      vm.runInContext(
        [
          typeFn || "function ltartTypeOfNode(){return 'file';}",
          openFn || "function ltartOpenButtonEl(){return null;}",
          folderFn || "function ltartFolderButtonEl(){return null;}",
          editFn || "function ltartEditButtonEl(){return null;}",
          refreshFn || "function ltartRefreshSavedFile(){return Promise.resolve(0);}",
          listenerSrc || "",
          "this.typeOfNode = ltartTypeOfNode;",
          "this.editButtonEl = ltartEditButtonEl;",
          "this.refreshSaved = ltartRefreshSavedFile;",
          /* buildBody 的 ltart 头部分支（原文口径）：⇢ → 📁（有路径）→ 文本类再 ✎（有路径）。
             这里逐字照 app-canvas.js 的 if 条件重演一遍，验证的是真函数在真分支下的显隐。
             本轮已移除与 ✎ 重复的 👁 只读预览，头部只剩这三枚。 */
          "this.headButtonsOf = function (node) {",
          "  const head = { list: [], appendChild(el) { this.list.push(el && el.className); return el; } };",
          "  if (node.kind !== 'ltart') return head.list;",
          "  head.appendChild(ltartOpenButtonEl(node));",
          "  if (String(node.ltFile || '').trim()) head.appendChild(ltartFolderButtonEl(node));",
          "  if (ltartTypeOfNode(node) === 'text') {",
          "    if (String(node.ltFile || '').trim()) head.appendChild(ltartEditButtonEl(node));",
          "  }",
          "  return head.list;",
          "};",
        ].join("\n"),
        box,
        { filename: "renderer/app-canvas.js[ltart-head]" },
      );
      /* ① 入口：文本类产物给按钮、非文本 / 无路径不摆空按钮 */
      ok(typeof box.editButtonEl === "function", "ltartEditButtonEl 在 vm 里可执行（真函数原文）");
      const okBtn = box.editButtonEl(nodeEdit);
      ok(
        !!okBtn && okBtn.className === "n-play n-ltart-edit" && okBtn.textContent === "✎",
        "文本类产物的按钮 = ✎ + .n-play .n-ltart-edit（与 ⇢/📁 同排，👁 预览已移除）",
      );
      /* ② 点击走 openTextViewer（同一套既有编辑器，保存写回原文件） */
      okBtn.onclick({ preventDefault() {}, stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 0));
      ok(opened.join("|") === "C:\\ws\\out\\shot.md", "点 ✎ 走 openTextViewer(node.ltFile)（得到 " + opened.join("|") + "）");
      ok(box.toasts.length === 0, "入口就绪时不弹任何提示（只有缺通道才显式 toast）");
      /* ③ 头部真摆了这枚按钮：文本类有路径 → 有 ✎；非文本 / 无路径 → 没有（不摆空按钮） */
      ok(
        box.headButtonsOf(nodeEdit).indexOf("n-play n-ltart-edit") >= 0,
        "头部分支在文本类产物上摆了 ✎（与 ⇢/📁 同排，👁 预览已移除）",
      );
      ok(
        box.headButtonsOf(nodeImage).indexOf("n-play n-ltart-edit") < 0,
        "非文本类产物不摆 ✎（真类型判定说了算）",
      );
      ok(
        box.headButtonsOf(nodeNoPath).indexOf("n-play n-ltart-edit") < 0,
        "没有文件路径的旧版节点不摆空按钮（点上只会弹提示）",
      );
      /* ④ 保存广播 → 命中的节点重读指纹 + 重渲染 + 落盘；其它类型 / 空路径不动 */
      eqNum(listeners["mtnode:file-saved"] ? listeners["mtnode:file-saved"].length : 0, 1, "保存监听挂了一次（document 级）");
      const before = { other: nodeOther.ltMtime, image: nodeImage.ltMtime, noPath: nodeNoPath.ltMtime };
      const fire = (path) => {
        for (const fn of listeners["mtnode:file-saved"] || []) fn({ detail: { path: path, source: "viewer" } });
      };
      fire("C:\\ws\\out\\shot.md");
      await new Promise((r) => setTimeout(r, 0));
      eqNum(nodeEdit.ltSize, 4321, "保存后命中节点重读出新的体积");
      eqNum(nodeEdit.ltMtime, 7777, "保存后命中节点重读出新的 mtime（板身摘要据它 bust）");
      ok(saved.renders === 1, "整面重渲染一次（得到 " + saved.renders + "）");
      ok(saved.count === 1 && saved.auto === 1, "刷新后落盘一次且是 auto=true（重开画布不回退）");
      eqNum(
        [nodeOther.ltMtime, nodeImage.ltMtime, nodeNoPath.ltMtime].join("|"),
        [before.other, before.image, before.noPath].join("|"),
        "其它产物节点 / 非文本件 / 空路径节点一律不动",
      );
      /* ⑤ 保底：路径为空或文件读不到时不炸、也不瞎写指纹 */
      fire("");
      fire("C:\\ws\\out\\ghost.md");
      await new Promise((r) => setTimeout(r, 0));
      eqNum(nodeEdit.ltMtime, 7777, "空路径 / 读不到的路径都不改动已有指纹（保底不踩空）");
    }

    /* ═══════════════ [9] 编辑保存入口（头部 ✎ · 保存即刷新） ═══════════════ */
    console.log("\n[9] 编辑保存入口：头部 ✎ / 复用可编辑阅读器 / 保存广播 → 节点刷新 / css / 词条 / 指南");
    has(CANVASJS, "function ltartEditButtonEl(", "有头部「✎ 编辑保存」入口按钮（不另造第二套编辑器）");
    has(CANVASJS, 'b.className = "n-play n-ltart-edit";', "按钮走 .n-play + 专属 .n-ltart-edit");
    has(
      CANVASJS,
      'if (String(node.ltFile || "").trim()) head.appendChild(ltartEditButtonEl(node));',
      "只有文本类产物且真有文件路径时才摆这枚按钮（空路径 / 非文本不摆空按钮）",
    );
    has(CANVASJS, 'ltartTypeOfNode(node) === "text"', "显隐按产物类型判定（文本件才给编辑保存）");
    has(
      CANVASJS.match(/function ltartEditButtonEl\(node\) \{[\s\S]*?\n\}/) || "",
      "openTextViewer",
      "复用应用内既有可编辑阅读器（.md 走 Markdown 阅读器、其它文本走行视图，保存写回原文件）",
    );
    has(
      CANVASJS,
      'toast(I18n.t("文本阅读器不可用（当前环境未就绪）"), "warn")',
      "阅读器未就绪时显式 toast（不静默、不阻断重绘）",
    );
    has(
      CANVASJS,
      'toast(I18n.t("无法编辑这件产物（当前环境不支持读写本地文件）"), "warn")',
      "没有本地读写通道时显式 toast（不静默）",
    );
    has(CANVASJS, 'toast(I18n.t("这件产物没有文件路径"), "warn")', "旧版节点没有文件路径时显式 toast（不瞎猜路径）");
    /* 保存广播：两条阅读器落盘成功各广播一次（虚拟文档分支不受影响），画布侧一次监听就地刷新 */
    has(
      APP,
      'new CustomEvent("mtnode:file-saved", { detail: { path: p, source: "viewer" } }),',
      "saveMdViewer / saveYamlViewer 落盘成功后广播 mtnode:file-saved（写盘是阅读器本人，画布只被动刷新）",
    );
    has(
      CANVASJS,
      'document.addEventListener("mtnode:file-saved", function (ev) {',
      "app-canvas 侧挂了一次监听（与 factlib:saved 同风格）",
    );
    has(CANVASJS, "ltartRefreshSavedFile(d && d.path);", "监听把路径交给刷新函数（其余节点原样不动）");
    has(CANVASJS, "function ltartRefreshSavedFile(path) {", "有「保存即刷新节点」的刷新函数");
    has(CANVASJS, 'n.kind === "ltart" && String(n.ltFile || "").trim() === want', "只认 ltFile 对得上的产物节点");
    has(CANVASJS, "n.ltSize = Number(st.size) || 0;", "重读文件大小写回节点");
    has(
      CANVASJS,
      "n.ltMtime = Number(st.mtime) || 0;",
      "重读 mtime 写回节点（板身摘要 / 预览的 bust 靠它，不刷新会一直显示旧内容）",
    );
    has(CANVASJS, 'if (typeof scheduleSave === "function") scheduleSave(true);', "指纹变了就地落盘（重开画布不回退）");
    has(CANVASJS, 'if (typeof renderCanvas === "function") renderCanvas();', "整面重渲染一次（板身摘要立刻跟上）");
    has(LTCSS, ".wf-node.ltart .n-head .n-ltart-edit", "这枚按钮与 ⇢ / 📁 同排等宽、不参与收缩（挤不没）");
    has(read("guides/nodes/ltart.md"), "编辑保存", "指南写明「编辑保存」入口");
    has(read("guides/nodes/en/ltart.md"), "Edit & save", "英文指南成对（AGENTS：指南中英同步）");
    has(MANUAL, "✎ 编辑保存", "应用内手册产物节点段补了同一句");
    /* 本轮需求「移除预览、只留编辑」：预览窗模块已删，头部不再有重复的 👁 */
    hasnt(CANVASJS, "ltartTextPreviewButtonEl", "头部不再有 👁 只读预览入口（与 ✎ 重复的那一半已移除）");
    ok(!exists("renderer/app-textpreview.js"), "renderer/app-textpreview.js 已删除");
    for (const k of [
      "编辑这件文本产物并保存回文件（Markdown 阅读器 / 行视图，保存写回原文件）",
      "编辑并保存文本产物",
      "文本阅读器不可用（当前环境未就绪）",
      "无法编辑这件产物（当前环境不支持读写本地文件）",
    ])
      has(I18N_SRC, '"' + k + '"', "i18n 表里有编辑保存词条：" + k);
    has(I18N_SRC, "Edit this text artifact and save it back to the file", "英文词条成对（切英文不回中文）");

    console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  }

  main().catch((e) => {
    console.error("smoke-longtask-artifacts crashed:", (e && e.stack) || e);
  });

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-artifacts.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-artifacts.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-longtask-edit.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-edit.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
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
  const seg = (a, b) => {
    const i = LTU.indexOf(a);
    const j = LTU.indexOf(b);
    ok(i >= 0 && j > i, "切片 " + a + " → " + b + " 存在");
    return i >= 0 && j > i ? LTU.slice(i, j) : "";
  };

  const LTE = read("renderer/app-longtask-edit.js");
  const LTU = read("renderer/app-longtask-ui.js");
  const LTV = read("renderer/app-longtask.js");
  const LTG = read("renderer/app-longtask-guide.js");
  const NODES = read("renderer/app-nodes.js");
  const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");
  const ROLLBACK = read("dsh/gateway/rollback-plugin.mjs");
  const HTML = read("renderer/index.html");
  const CSS = read("renderer/css/longtask.css");
  const I18N = read("renderer/i18n.js");
  const MANUAL = read("guides/manual/longtask.md");

  /* ══════════════ [1] 引擎：updateFromGraph / graphOf（vm 里真跑）═══════════════ */
  async function enginePart() {
    console.log("\n[1] 引擎：LT.updateFromGraph 原地改图 + LT.graphOf 现况快照（真跑，不是 grep）");
    let saves = 0;
    const persisted = [];
    const sandbox = {
      window: { api: {} },
      S: { wf: null, config: {} },
      I18n: { t: (s) => s },
      toast() {},
      scheduleSave() {
        saves++;
      },
      persistWf(wf) {
        persisted.push(wf);
      },
      currentVisibleWf() {
        return null; /* 测试里没有「用户看着的画布」→ 一律走 persistWf 这条 */
      },
      renderCanvas() {},
      focusNode() {},
      addNode() {
        return null;
      },
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
    const LT = sandbox.window.LT;
    eqNum(typeof LT.updateFromGraph, "function", "window.LT 导出 updateFromGraph");
    eqNum(typeof LT.graphOf, "function", "window.LT 导出 graphOf（现况快照）");

    const G1 = {
      nodes: [
        { id: "s", kind: "start", title: "起点" },
        { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿子", outKeys: ["draft"] } },
        { id: "e", kind: "end_ok", title: "收工" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "a", to: "e" },
      ],
    };
    /* 改后的图：把「起草」拆成「起草 → 初审 → 终审」 */
    const G2 = {
      nodes: [
        { id: "s", kind: "start", title: "起点" },
        { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿子", outKeys: ["draft"] } },
        { id: "r1", kind: "agent", title: "初审", cfg: { goal: "初审稿子", outKeys: ["review1"] } },
        { id: "r2", kind: "agent", title: "终审", cfg: { goal: "终审定稿", outKeys: ["review2"] } },
        { id: "e", kind: "end_ok", title: "收工" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "a", to: "r1" },
        { from: "r1", to: "r2" },
        { from: "r2", to: "e" },
      ],
    };

    const wf = { id: "wf1", name: "画布一" };
    let r = LT.updateFromGraph(wf, "", G1, "");
    ok(r && r.ok === false, "没有任务 → 拒绝（不静默吞掉）");
    has(r.error, "没有找到这张长任务", "拒绝文本说清找不到任务");

    const created = LT.createFromGraph("审稿流水线", G1, wf);
    ok(created && created.ok === true, "先建一张任务（修改的前置）");
    const uid = created.uid;
    const t0 = wf.longtask.tasks[0];
    const created0 = t0.createdAt;
    eqNum(t0.ver, 1, "新建时 ver = 1");

    r = LT.updateFromGraph(wf, uid, null, "");
    ok(r && r.ok === false, "缺 graph → 拒绝");
    has(r.error, "缺少图定义 graph", "拒绝文本说清缺的是图定义");
    eqNum(saves, 0, "缺图不触发存盘");

    r = LT.updateFromGraph(wf, uid, { nodes: [], edges: [] }, "");
    ok(r && r.ok === false, "空图 → 拒绝（参数级直接挡，不把用户的图改没）");
    eqNum((LT.tasks(wf) || [])[0].graph.nodes.length, 3, "空图不落库：原图仍是 3 个节点");

    /* 校验不过的图：多出一个没有上游的节点 */
    const DIRTY = {
      nodes: G2.nodes.concat([{ id: "x", kind: "agent", title: "没上游", cfg: { goal: "g" } }]),
      edges: G2.edges,
    };
    r = LT.updateFromGraph(wf, uid, DIRTY, "");
    ok(r && r.ok === false, "脏图 → 拒绝（校验未过）");
    has(r.error, "长周期任务图校验未通过：", "拒绝文本带「校验未通过」前缀（Agent 可读）");
    has(r.error, "没有任何上游", "拒绝文本把引擎的 err 原样带回（Agent 知道改什么）");
    has(r.error, "。请修正后重新调用 update_longtask。", "拒绝文本明确让 Agent 修正后重调 update_longtask");
    ok(Array.isArray(r.errs) && r.errs.length >= 1, "拒绝回执带结构化 errs");
    ok(Array.isArray(r.warnings), "拒绝回执带 warnings");
    eqNum((LT.tasks(wf) || [])[0].graph.nodes.length, 3, "校验不过绝不半改：原图仍是 3 个节点");

    saves = 0;
    persisted.length = 0;
    r = LT.updateFromGraph(wf, uid, G2, "");
    ok(r && r.ok === true, "干净的新图 → 原地改图成功");
    eqNum(r.uid, uid, "回执 uid 与被改的任务一致（不是新建）");
    eqNum(r.ver, 2, "ver 只增不减：v1 → v2");
    eqNum((LT.tasks(wf) || []).length, 1, "任务数不变：原地改，不新建第二条");
    const t1 = LT.tasks(wf)[0];
    eqNum(t1.uid, uid, "任务身份保留（uid 不变）");
    eqNum(t1.createdAt, created0, "createdAt 保留（不是一份新任务）");
    eqNum(t1.graph.nodes.length, 5, "图定义被换成新图（5 个节点）");
    eqNum(t1.graph.nodes[3].title, "终审", "新图内容真的落进 task.graph");
    eqNum(t1.graph.ver, 2, "图定义上的 ver 与任务 ver 同步");
    eqNum(t1.enabled, false, "enabled 原样保留（改图不等于启用）");
    ok(saves + persisted.length >= 1, "改图触发落盘");
    eqNum(persisted.length, 1, "落盘按对象自己的 id 走 persistWf（不写用户看着的另一张）");
    ok(persisted[0] === wf, "落盘的正是那张被改的画布");
    eqNum(r.running, false, "没有在跑的 run 时 running:false（不吓唬 Agent）");
    eqNum(r.runNote, "", "没在跑就没有 runNote 这句提醒");

    /* graphOf：现况快照（身份 + 图 + 运行态） */
    const snap = LT.graphOf(wf, uid);
    ok(!!snap, "graphOf 拿得到现况");
    eqNum(snap.uid, uid, "快照带 uid");
    eqNum(snap.name, "审稿流水线", "快照带任务名");
    eqNum(snap.ver, 2, "快照带当前图版本");
    eqNum(snap.enabled, false, "快照带 enabled");
    eqNum(snap.graph.nodes.length, 5, "快照带整张图定义（Agent 就是照它改）");
    eqNum(snap.run, null, "没有 run 时 run:null");
    eqNum(LT.graphOf(wf, "不存在"), null, "uid 不存在 → null（不抛错）");
    eqNum(LT.graphOf(null, uid), null, "没有画布 → null");

    /* 改图 ≠ 影响在跑的 run：run 拿的是启用那刻的快照（共识 q34）。
       这里用「任务记了 activeRun 但 run 不在内存」模拟：running 仍报 false，
       但 activeRun 原样留着 —— 这条钉住「改图不会把 run 记录抹掉」。 */
    /* 写 activeRun 要写**真源对象** wf.longtask.tasks[0]：LT.tasks() 每次都走 ltEnsure 重建
       一份归一后的 task 对象，上一行取到的 t1 在 updateFromGraph 内部那次 ltEnsure 之后
       就已经不是它了（不是 bug，是「归一是唯一入口」的代价）。 */
    wf.longtask.tasks[0].activeRun = "r_x";
    r = LT.updateFromGraph(wf, uid, G2, "");
    ok(r && r.ok === true, "带 activeRun 的任务也能改图");
    eqNum(LT.tasks(wf)[0].activeRun, "r_x", "activeRun 原样保留（不打断也没抹掉）");
    eqNum(typeof r.runNote, "string", "回执总是带 runNote 字段（无 run 时为空串）");
    hasnt(LTV.slice(LTV.indexOf("function ltUpdateFromGraph"), LTV.indexOf("function ltGraphSnapshot")), "createFromGraph", "改图路径不偷偷调建图（只原地替换）");
  }

  /* ══════════════ [2] 工具层与分发 ═══════════════ */
  function toolPart() {
    console.log("\n[2] 工具层：mtnode_app 的 get_longtask / update_longtask（enum / 卡口 / 分发 / 权限）");
    has(PLUGIN, "'get_longtask'", "action enum 收了 get_longtask");
    has(PLUGIN, "'update_longtask'", "action enum 收了 update_longtask");
    has(PLUGIN, "- get_longtask: read one existing long-running task in full", "APP_DESC 写了 get_longtask 给什么");
    has(PLUGIN, "- update_longtask: replace the graph definition of an EXISTING long-running task in place", "APP_DESC 写了 update_longtask 干什么");
    has(PLUGIN, "not a diff; the graph replaces the old one", "APP_DESC 说清 graph 是整张替换、不是增量");
    has(PLUGIN, "get_longtask / update_longtask: target long-running task uid", "新增 uid 参数并写明两个动作都用它");
    has(PLUGIN, "For create_longtask / update_longtask: the long-running-task state-machine graph.", "graph 参数说明覆盖两个动作");
    has(PLUGIN, "mtnode-grill-me", "仍指向 mtnode-grill-me 的图契约（单一真源，不抄字段）");

    has(NODES, 'if (action === "get_longtask") {', "应用动作分发有 get_longtask 分支");
    has(NODES, 'if (action === "update_longtask") {', "应用动作分发有 update_longtask 分支");
    has(NODES, "LT.graphOf(boundWf", "get_longtask 读的是「本会话所属画布」的现况");
    has(NODES, "LT.updateFromGraph(", "update_longtask 调 window.LT.updateFromGraph（归一 + 校验都在引擎里）");
    has(NODES, 'action === "get_longtask" ||', "两只动作都归 app_ops（工具清单里有它才可被模型调到）");
    has(NODES, 'action === "update_longtask" ||', "update_longtask 同样归 app_ops");
    {
      const denied = NODES.slice(NODES.indexOf("const PLAN_DENIED_APP_ACTIONS"), NODES.indexOf("function canvasOpMutates("));
      has(denied, '"update_longtask"', "规划模式把 update_longtask 列为拒绝动作（只出计划不改画布）");
      hasnt(denied, '"get_longtask"', "get_longtask 是只读，规划模式下仍放行");
    }
    has(ROLLBACK, "'get_longtask'", "回滚记账把 get_longtask 当只读（连占位都不发）");
    hasnt(ROLLBACK, "'update_longtask'", "回滚记账不放行 update_longtask（按写操作处理）");

    /* 会话侧权限：修改会话走的是「允许读画布」的契约会话 → 三件套都在（= 有全部权限） */
    has(LTE, "allowCanvas: true", "修改会话显式允许读画布（→ canvas_get / edit / app 三件套都在）");
    has(LTE, "agentContractSession(", "复用既有契约会话装配（不另造一套会话机制）");
    has(LTE, "noPlanFlow = true", "计划闸豁免：产物是改好的图，不是普通会话计划");
    hasnt(LTE, "mtnode_canvas_edit(\"", "宿主不直接拿画布写工具去画状态机图（只走 update_longtask）");
  }

  /* ══════════════ [3] 修改弹窗 ═══════════════ */
  function dialogPart() {
    console.log("\n[3] 修改弹窗：契约（get → 改 → update 原地写回）+ 每轮现况喂给 Agent + 出口");
    ok(fs.existsSync(path.join(ROOT, "renderer/app-longtask-edit.js")), "renderer/app-longtask-edit.js 存在");
    has(LTE, "window.ltOpenEditDlg = ltOpenEditDlg", "导出 window.ltOpenEditDlg（头部按钮的落点）");
    has(LTU, "window.ltOpenEditDlg", "头部按钮调的就是它");
    has(LTU, "任务链修改模块未就绪", "模块没加载时给提示，不静默失败");

    const ct = LTE.slice(LTE.indexOf("function lteContractText()"), LTE.indexOf("function lteGraphText()"));
    has(ct, "get_longtask", "契约第一步：先读现状（get_longtask）");
    has(ct, "update_longtask", "契约最后一步：原地写回（update_longtask）");
    has(ct, "不是增量补丁，是整张替换", "契约说清 graph 是整张替换");
    has(ct, "不要 create_longtask 新建任务", "契约禁止新建任务（修改 ≠ 创建）");
    has(ct, "禁止手改画布 JSON 里的 wf.longtask", "契约禁止手改 wf.longtask");
    has(ct, "禁止用 mtnode_canvas_edit 去画这张状态机图", "契约禁止用画布写工具画状态机图");
    has(ct, "校验未通过", "契约要求按 err 修好再调一次");
    has(ct, "ask_user_question", "要求有歧义时用询问窗问满（不是拿计划代替提问）");
    has(ct, "禁止】输出 <!--MTNODE-PLAN-->", "契约禁止普通会话计划块");

    /* 每轮把「当前图 + 运行态 + 用户要求」一次交清（少一条 Agent 就得凭记忆改） */
    has(LTE, "function lteRoundInput(", "每轮拼一条起轮消息");
    has(LTE, "当前图定义 JSON", "起轮消息里带当前图定义");
    has(LTE, "当前运行态", "起轮消息里带运行态（哪个环节卡住 / 在等谁）");
    has(LTE, "lteGraphText()", "图 JSON 从 LT.graphOf 现况取（不是窗内记忆）");
    has(LTE, "JSON.stringify({ uid: snap.uid, name: snap.name, ver: snap.ver, graph: snap.graph })", "喂给 Agent 的 JSON 含 uid / 名字 / 版本 / 图");
    has(LTE, "过长已截断，完整定义请用 get_longtask 读", "超长图截断并指回 get_longtask（不静默丢）");

    /* 收尾闸：本轮没写回就自动纠偏一次 */
    has(LTE, "const LTE_FIX_MAX = 1", "自动纠偏上限 = 1（一个用户轮最多一次）");
    has(LTE, "function lteSettle(", "有每轮收尾闸");
    has(LTE, "lteFixDirective()", "收尾闸会回发纠偏指令");
    has(LTE, "本轮没有把改好的图写回", "纠偏前先明确告诉用户发生了什么");
    has(LTE, "_ltEditFixRounds = 0", "用户亲口发话 → 纠偏额度清零（绝不来回拉扯）");

    /* 兜底写回：回复里那份图也按同一份归一路径落库（工具不可用时不至于白聊） */
    has(LTE, "window.LT.updateFromGraph(wf", "回复里的图由宿主走同一条 updateFromGraph 写回");
    has(LTE, "LTE.applied", "同一份图只兜底写一次（幂等位记在窗内状态，重绘不回写）");
    has(LTE, "ltgParseGraph", "复用引导区的图 JSON 解析（不双写解析器）");

    /* 持久化浮层口径：与创建窗同款 */
    has(LTE, 'openOverlay(lteT("修改任务链"), { persistent: true, min: true })', "持久化浮层 + 可最小化到状态栏");
    has(LTE, "vw * 0.5", "最小宽 ≥ 50% 视口（与审阅窗 / 创建窗同口径）");
    has(LTE, 'const rz = lteEl("div", "lte-resize")', "右下角可拖调大小");
    has(LTE, "lteSaveSize(n)", "拖过的尺寸记 localStorage");
    has(LTE, "lteDraftSave(ta.value)", "没发出去的要求随输入落盘（关窗不丢）");
    has(LTE, 'const LTE_SESSION_KEY = "ltEditSession"', "历史接回记录仍会清掉（旧版留下的 key 不让下一次开窗复活旧上下文）");
    has(LTE, "lteAbandonPrevSessions(", "开窗时结束遗留修改会话里可能还在跑的那一轮（不许它在后台继续烧）");
    hasnt(LTE, "lteFindSession", "不再按契约抬头认回旧会话（本次需求：改任务链时重启，不继承前面的上下文）");
    hasnt(LTE, "lteSessionSave", "不再把会话 id 落盘接回（同上）");
    has(LTE, "dshMsgBlock(", "对话区复用会话视图的消息渲染");
    has(LTE, "renderAgentSession", "挂窗口级重绘钩子（流式实时）");
    has(LTE, "setInterval(", "运行期轮询兜底（重绘钩子漏了也跟得上）");

    /* 输入区在最上面（用户要写的要求靠上），不用翻滚动条才找得到 */
    const iTop = LTE.indexOf('wrap.appendChild(top)');
    const iRow = LTE.indexOf('wrap.appendChild(row)');
    const iMain = LTE.indexOf('wrap.appendChild(main)');
    ok(iTop >= 0 && iRow > iTop && iMain > iRow, "排版自上而下：抬头 → 输入区 → 对话区（要写的东西在最上面）");

    /* 出口三个：看条带 / 中断本轮 / 稍后 */
    has(LTE, 'lteT("看条带")', "出口有「看条带」");
    has(LTE, 'lteT("中断本轮")', "出口有「中断本轮」");
    has(LTE, 'lteT("稍后")', "出口有「稍后」");
    has(LTE, "stopSessionRuns(st, true)", "中断走既有的停止通道（不另造一套）");

    /* 本次需求：改任务链时重启清空会话（不继承前面的上下文，避免干扰）——
       两头都要钉住：开窗不认回旧会话、每轮发送都新起一条。 */
    const segSend = LTE.slice(LTE.indexOf("async function lteSend("), LTE.indexOf("function lteClearDraft("));
    has(segSend, "agentContractSession({", "每轮「发送」都新起一条契约会话（新上下文）");
    hasnt(segSend, "agentSessionSend(", "不再往窗内旧会话续聊（改任务链不继承前面的上下文）");
    hasnt(segSend, "st._ltEditFixRounds = 0\n  st.noPlanFlow", "追问轮那条续聊分支已移除");
    has(segSend, "stopSessionRuns(prev, true)", "上一次还在跑就先停掉（不叠在旧上下文上白烧 token）");
    const segOpen = LTE.slice(LTE.indexOf("function ltOpenEditDlg("), LTE.indexOf("window.ltOpenEditDlg = ltOpenEditDlg"));
    has(segOpen, "lteClearSessionRec()", "开窗先清历史接回记录（旧 key 不复活旧上下文）");
    has(segOpen, "lteAbandonPrevSessions(cap, task.uid)", "开窗停掉遗留会话在跑的那一轮");
    hasnt(segOpen, "lteFindSession", "开窗不再认回旧会话");
    hasnt(segOpen, "lteSessionSave", "开窗不再记「下次接着聊」");
  }

  /* ═══════════════ [4] 头部按钮收纳 + 装配与文案 ═══════════════ */
  function headAndWiringPart() {
    console.log("\n[4] 收纳：不常用的手动按钮进「⋯ 更多」（瞬时菜单）；装配 / 样式 / i18n");
    /* 头部函数本身 = ltRenderHead 的开头到第一个菜单 helper（下面的 ltMenuClose）：
       少切这一段，下面「不再平铺」的负向断言会被菜单实现自己误伤。 */
    const headSeg = LTU.slice(LTU.indexOf("function ltRenderHead("), LTU.indexOf("function ltMenuClose("));
    has(headSeg, "ltMoreBtn(wf, task)", "头部挂着「⋯ 更多」按钮");
    has(headSeg, 'ltT("✎ 修改任务链")', "头部有「✎ 修改任务链」主入口");
    /* 「开始长任务」上移到条带右端（本次需求）：lt-spacer 之后、⚙ 之前常驻一颗「▶ 启用并绑定」
       主按钮 —— 落点仍是 ltEnable（与「⋯ 更多」那颗同一处逻辑），run 还活着时不出现。 */
    has(headSeg, 'ltT("▶ 启用并绑定")', "条带右端常驻「▶ 启用并绑定」主按钮（从「⋯ 更多」提上来）");
    has(headSeg, "ltEnable(wf, task.uid, {})", "主按钮的落点就是 ltEnable（不另造一套启用逻辑）");
    has(headSeg, "lt-spacer", "它排在 lt-spacer 之后（右端一组）");
    ok(
      headSeg.indexOf('ltEl("div", "lt-spacer")') < headSeg.indexOf('ltT("▶ 启用并绑定")') &&
        headSeg.indexOf('ltT("▶ 启用并绑定")') < headSeg.indexOf('ltT("⚙")'),
      "位置口径：lt-spacer 之后、⚙ 之前（右端主按钮）",
    );
    has(headSeg, "runLive", "run 还活着（正在跑 / 停在等你处理）时主按钮让位（不顶掉用户手里的 run）");
    has(headSeg, "ltForceAdvanceBtn(wf, run)", "run 停在手上时还有一颗「⏭ 强行进入下一状态」（本次需求：run 级统一出路）");
    /* 模型 chip 可点开（本次需求）：条带头那枚「模型 …」从只读回显变成选型入口 ——
       锚点身份 data-lt-menu="lt-model"（头部 ~90ms 一次重建后认回来，面板不被收掉），
       点开走 ltAgentPanelOpen（四格控件与清单复用 ctl 那一份，不复制清单）。 */
    has(headSeg, 'chip.setAttribute("data-lt-menu", "lt-model")', "模型 chip 是可点入口（锚点身份写在 data-lt-menu 上）");
    has(headSeg, "ltAgentPanelOpen(wf, chip)", "点 chip 开四格选型面板（不必先下钻某一环再翻检查器）");
    has(LTU, "function ltAgentPanelOpen(wf, chip) {", "面板本体在 app-longtask-ui.js");
    has(LTU, "ltMenuOpen(chip, [{ el: box }]);", "面板挂瞬时菜单的自定义内容块（不另造一套浮层）");
    /* forceAdvance 挂载（本次需求）：界面施加动作的唯一落点是引擎那一份 run 级推进 ——
       界面不自己改 run，拿不到就什么都不做（点了没反应正是要避免的）。 */
    has(LTV, "forceAdvance: ltForceAdvance,", "引擎导出 window.LT.forceAdvance（run 级手动推进）");
    has(LTV, "autoRepairGraph: ltAutoRepairGraph,", "引擎导出 autoRepairGraph（结论性图问题就地补好）");
    has(LTU, "API.forceAdvance(wf, { run: run })", "条带头那颗 ⏭ 的落点就是 LT.forceAdvance");
    /* 右端主按钮与「▶ 继续」并存：run 卡住 / 失败 / 停住时两颗都在，各管一件事 */
    ok(
      headSeg.indexOf("runLive") < headSeg.indexOf('ltT("▶ 继续")'),
      "主按钮先于「▶ 继续」渲染：run 停下时两颗并排（一个接着跑、一个按当前图重开）",
    );
    const moreSeg = LTU.slice(LTU.indexOf("function ltMoreBtn("), LTU.indexOf("function ltOpenEditDlg("));
    for (const k of ["按当前图重跑", "停用解绑", "记忆", "历史 run", "交付目录体检", "任务图校验", "🗑 删除任务"]) {
      has(moreSeg, 'ltT("' + k + '")', "「⋯ 更多」菜单里有「" + k + "」");
    }
    has(moreSeg, 'ltT("按当前图定义从起点重跑（正在跑的 run 会被替换）")', "「按当前图重跑」写清它会替换正在跑的 run");
    hasnt(moreSeg, 'ltT("重新启用（新 run）")', "旧的那颗重复项（重新启用（新 run））已收敛掉，菜单里不再有两颗同义项");
    hasnt(moreSeg, 'label: ltT("▶ 启用并绑定")', "菜单里不再有与右端主按钮同名的那一颗（收敛后只留「按当前图重跑」）");
    /* 收纳后头部不该再平铺这些：少一条断言，下次又会一顆颗爬回来 */
    hasnt(headSeg, 'ltT("记忆")', "「记忆」不再平铺在头部");
    hasnt(headSeg, "ltRunsDlg", "「历史 run」不再平铺在头部");
    hasnt(headSeg, "ltOrphanDlg", "「交付目录体检」不再平铺在头部");
    hasnt(headSeg, 'ltT("按引擎规则校验当前这张图，列出 err / warn")', "「任务图校验」菜单项不再平铺在头部（头部只留出错 chip）");
    /* 瞬时菜单：没有待提交的输入 → 点外部 / Esc 即收（AGENTS 的浮层分类） */
    has(LTU, "function ltMenuOutside(", "下拉点外部即收");
    has(LTU, 'ev.key === "Escape"', "下拉 Esc 即收");
    has(LTU, "document.body.appendChild(el)", "面板挂 body + fixed（.lt-head 是 overflow-x 容器，挂里面会被裁）");
    has(LTU, "ltMenuClose()", "开新面板前先收旧面板（不叠浮层）");
    has(LTU, 'ltEl("div", "lt-more-pop")', "面板类名 lt-more-pop（样式在 longtask.css）");
    hasnt(LTU.slice(LTU.indexOf("function ltMenuOutside("), LTU.indexOf("function ltMenuOpen(")), "persistent", "下拉不冒充持久化浮层（它本来就该点外部即收）");
    /* 条带整块重建时头部按钮也一起换掉（长任务运行期约 90ms 一次），但面板不许被这一次重建收掉：
       锚点身份写在按钮的 data-lt-menu 上，重建后由 ltMenuReadopt 认到新按钮并重新贴位；
       只有认不到锚点（这颗按钮这一帧不再存在）才收掉，绝不留飘着的孤儿。
       （本次需求变化：原来是「重建前先 ltMenuClose」，长任务跑着时点开菜单下一帧就被收。） */
    has(LTU, "ltMenuReadopt(oldMenu)", "头部重建后把挂在头部按钮上的下拉认回来（认不到才收）");
    has(LTU, 'b.setAttribute("data-lt-menu", "lt-more")', "下拉锚点身份 = 按钮上的 data-lt-menu（与按钮形状无关，重建后仍找得到）");
    has(LTU.slice(LTU.indexOf("function ltMenuReadopt("), LTU.indexOf("function ltMoreBtn(")), "ltMenuClose()", "认不到锚点仍收掉（不留锚点已失效的浮层）");

    const iUi = HTML.indexOf('src="app-longtask-ui.js"');
    const iGuide = HTML.indexOf('src="app-longtask-guide.js"');
    const iEdit = HTML.indexOf('src="app-longtask-edit.js"');
    ok(iUi >= 0 && iEdit > iUi, "index.html 加载顺序：edit 在 ui 之后（要用 ltBtn / 头部入口）");
    ok(iGuide >= 0 && iEdit > iGuide, "index.html 加载顺序：edit 在 guide 之后（复用 ltgParseGraph 与同一套会话口径）");
    for (const c of [".lte-top", ".lte-row", ".lte-ta", ".lte-main", ".lte-conv", ".lte-right", ".lte-status", ".lte-sum", ".lte-acts", ".lte-resize", ".lt-more-pop", ".lt-more-i", ".lt-btn-pri", ".lt-btn-force", ".lt-chip-model", ".lt-mdl", ".lt-mdl-h"]) {
      has(CSS, c, "longtask.css 有样式 " + c);
    }
    has(MANUAL, "任务链修改", "应用内手册补了「任务链修改」用法");

    const I = require("../renderer/i18n.js");
    I.setLocale("en");
    const keys = [
      "修改任务链",
      "这张画布没有可修改的长任务：先创建一张",
      "任务链修改",
      "任务链修改模块未就绪",
      "用一句话说清要改什么，Agent 按当前任务状态图原地改 / 修复（有全部权限）",
      "⋯ 更多",
      "其余不常用的操作（启用 / 停用 / 记忆 / 删除任务 等）",
      "按当前图定义拍一张快照开一个 run（图改过就用新版跑）",
      "按当前图定义从起点重跑（正在跑的 run 会被替换）",
      /* 「⋯ 更多」里收敛后的那颗（与右端主按钮同名重复的旧项已删） */
      "按当前图重跑",
      "解绑本画布：图与历史记录都保留，随时可再启用",
      "长任务记忆沉淀：查 / 记 / 导出到事实库",
      "看这张任务跑过的每一轮 run 与它们的图版本",
      "扫交付目录：报告缺项 / 孤儿，只报告不删",
      "按引擎规则校验当前这张图，列出 err / warn",
      "长任务设置：任务切换 / 历史 run / 交付目录体检 / 图校验",
      "收起长任务条带",
      "▶ 继续",
      "■ 停止",
      "▶ 启用并绑定",
      /* 本次需求：模型 chip 的选型入口 + run 级「⏭ 强行进入下一状态」按钮 */
      "⏭ 强行进入下一状态",
      "强行进入下一状态",
      "把卡住的环节放行、把被停止的环节排回队列，让状态机按图继续往下走（下一次先试「▶ 继续」）",
      "这一轮跑哪只模型（共 {n} 个 Agent 环节）",
      "模型选型控件未就绪",
      "停用解绑",
      "记忆",
      "历史 run",
      "交付目录体检",
      "任务图校验",
      "Agent 任务",
      "人工任务",
      "任务链已更新到 v",
      "本轮没有把改好的图写回：已让 Agent 按契约重做一次。",
      "当前任务图",
      "先用一句话写清要改什么",
      "这条修改会话留在左侧栏只作历史；下次打开本窗是一条全新会话（不继承上下文）",
      "已中断本轮：会话留着，随时可以接着说",
      "。请修正后重新调用 update_longtask。",
      "该任务正在跑（run ",
      "）：当前 run 仍按启用那刻的旧版图在跑，改图不会影响它；要按新图跑需在条带上重新启用。",
    ];
    const miss = keys.filter((k) => I.t(k) === k);
    eqNum(miss.length, 0, "i18n 中英词条齐全（en 档下这些 key 都有译文）" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
    /* 新模块里每条 lteT 字面量都要有 EN 译文（不能中英混排）。
       例外只剩「纯符号 / 数字」标签（如 ）—— 它们没有可翻译的语言内容，
       I.t 原样返回即正确（这里显式列出，别处不许再用「看起来像中文却说没译文」的键）。 */
    const re = /lteT\(\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    const unmatch = [];
    while ((m = re.exec(LTE))) {
      const k = m[1].replace(/\\n/g, "\n");
      if (!k.trim() || k === "Agent" || !/[\u4e00-\u9fff]/.test(k)) continue;
      if (I.t(k) === k) unmatch.push(k);
    }
    eqNum(unmatch.length, 0, "app-longtask-edit.js 的每条中文文案都有 EN 译文" + (unmatch.length ? "（缺：" + unmatch.join(" / ") + "）" : ""));
    /* 头部收纳新增的标签同样要能中英对照 */
    const re2 = /ltT\(\s*"((?:[^"\\]|\\.)*)"/g;
    const newKeys = new Set(["▶ 继续", "■ 停止", "▶ 启用并绑定", "停用解绑", "记忆", "历史 run", "交付目录体检", "任务图校验", "⋯ 更多", "收起长任务条带", "修改任务链", "任务链修改模块未就绪", "⏭ 强行进入下一状态", "强行进入下一状态", "按当前图重跑"]);
    const bad = [];
    while ((m = re2.exec(LTU))) {
      const k = m[1].replace(/\\n/g, "\n");
      if (!newKeys.has(k)) continue;
      if (I.t(k) === k) bad.push(k);
    }
    eqNum(bad.length, 0, "头部收纳这批标签都有 EN 译文" + (bad.length ? "（缺：" + bad.join(" / ") + "）" : ""));
  }

  async function main() {
    await enginePart();
    toolPart();
    dialogPart();
    headAndWiringPart();
    console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-longtask-edit)");
  }

  main().catch((e) => {
    console.log("测试异常：" + String((e && e.stack) || e));
  });
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-edit.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-edit.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-longtask-refocus.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-refocus.js";
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
  /* 源码统一按 \n 处理（仓库是 CRLF），切段与断言不必管行尾差异 */
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n/g, "\n");

  const LTU = read("renderer/app-longtask-ui.js");
  const LTV = read("renderer/app-longtask.js");
  const KEYS = read("renderer/app-keys.js");

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

  /* ── 迷你 DOM：够 ltRenderMain 用（children / appendChild / insertBefore / removeChild /
        contains / classList / innerHTML = ""），并在整块重建时记一笔 ── */
  function mkEl(cls) {
    const el = {
      nodeType: 1,
      tagName: "DIV",
      className: cls || "",
      children: [],
      parentNode: null,
      _cleared: 0,
      contains(t) {
        let p = t;
        while (p) {
          if (p === this) return true;
          p = p.parentNode;
        }
        return false;
      },
    };
    el.classList = { contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0 };
    el.appendChild = function (c) {
      if (c && c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
      this.children.push(c);
      if (c) c.parentNode = this;
      return c;
    };
    el.insertBefore = function (c, ref) {
      if (c && c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
      const i = this.children.indexOf(ref);
      if (i < 0) return this.appendChild(c);
      this.children.splice(i, 0, c);
      if (c) c.parentNode = this;
      return c;
    };
    el.removeChild = function (c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    };
    Object.defineProperty(el, "innerHTML", {
      get() {
        return "";
      },
      set() {
        this._cleared++;
        for (const c of this.children.slice()) this.removeChild(c);
      },
    });
    return el;
  }
  /* 输入控件（判据只看 tagName / isContentEditable，不需要真渲染）。
     closest 给一份最小实现：只认 ltHoldCtrlEl 那条选择器里用到的 `tag` / `tag[type="x"]` 两种写法。 */
  function mkClosest(el, tag, type) {
    const T = String(tag || el.tagName || "").toLowerCase();
    const ty = String(type || "").toLowerCase();
    return (sel) => {
      for (const part of String(sel).split(",")) {
        const m = part.trim().match(/^([a-z]+)(?:\[type="([a-z]+)"\])?$/);
        if (!m) continue;
        if (m[1] !== T) continue;
        if (m[2] && m[2] !== ty) continue;
        return el;
      }
      return null;
    };
  }
  function mkField(tag, type) {
    const e = mkEl("lt-in");
    e.tagName = String(tag || "input").toUpperCase();
    if (type) e.type = type;
    e.closest = mkClosest(e, tag, type);
    return e;
  }
  /* 原生选区替身（ltSelInCol 只看 isCollapsed / rangeCount / anchorNode / focusNode） */
  function mkSel(anchorNode, focusNode, collapsed) {
    return {
      isCollapsed: !!collapsed,
      rangeCount: anchorNode || focusNode ? 1 : 0,
      anchorNode: anchorNode || null,
      focusNode: focusNode || null,
    };
  }
  function mkDoc(active) {
    const doc = {
      activeElement: active || null,
      body: mkEl(""),
      documentElement: mkEl(""),
      listeners: [],
    };
    doc.body.tagName = "BODY";
    doc.documentElement.tagName = "HTML";
    doc.addEventListener = function (type, fn, capture) {
      this.listeners.push({ type, fn, capture: !!capture });
    };
    doc.removeEventListener = function (type, fn) {
      this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
    };
    doc.emit = function (type) {
      for (const l of this.listeners.slice()) if (l.type === type) l.fn({ type });
    };
    return doc;
  }
  /* 把 UI 源码里的判据函数搬进沙箱（共享同一份源码，不另抄一份逻辑）；
     函数引用的两个模块级量（文本框类型表 / 已挂监听标志）也照源码取一份补上。 */
  function sandboxFor(names, extra) {
    const types = (LTU.match(/const LT_TEXT_INPUT_TYPES = (\[[^\]]*\]);/) || [])[1] || "[]";
    const sb = Object.assign(
      { console, Array, Object, String, Number, Date, Math, JSON, isFinite, parseFloat, parseInt },
      { LT_TEXT_INPUT_TYPES: JSON.parse(types), ltRenderWait: false },
      extra || {},
    );
    vm.createContext(sb);
    for (const n of names) vm.runInContext(fnBody(LTU, n), sb);
    return sb;
  }

  console.log("\n[1] 焦点保护判据就位（renderer/app-longtask-ui.js）");
  {
    for (const n of ["ltEditHost", "ltFocusCol", "ltFocusInside", "ltColOf", "ltRenderWhenFocusLeaves"])
      ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有 " + n);
    for (const n of ["ltSelInCol", "ltColHold", "ltHoldArm", "ltHoldRelease", "ltHoldBind", "ltColHoldNow", "ltRenderFlushDeferred"])
      ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有框选 / 按住保护判据 " + n);
    ok(
      fnBody(LTU, "ltRenderMain").indexOf("ltFocusCol(oldRight)") > 0,
      "ltRenderMain 先判断「焦点在右栏输入里」——不再无条件重建右栏",
    );
    ok(
      fnBody(LTU, "ltRenderMain").indexOf("ltColHold(oldRight)") > 0 &&
        fnBody(LTU, "ltRenderMain").indexOf("ltColHold(oldLeft)") > 0,
      "ltRenderMain 还判断「这一栏正在框选 / 鼠标正按在栏里」（ltColHold）",
    );
    ok(
      /const LT_TEXT_INPUT_TYPES = \["", "text", "search", "url", "email", "password", "tel", "number"\];/.test(LTU),
      "拦重绘只认「文本输入」的控件类型表（下拉 / 复选框不算，见 ltEditHost 的取舍说明）",
    );
    ok(
      fnBody(LTU, "ltMount").indexOf("ltHoldBind()") > 0,
      "条带挂载时接上「鼠标按在哪一栏」的捕获监听（ltMount → ltHoldBind，只挂一次）",
    );
    const ctrlSel = (fnBody(LTU, "ltHoldCtrlEl").match(/el\.closest\(\s*'([^']+)'/) || [])[1] || "";
    ok(
      ctrlSel.indexOf("select") >= 0 && ctrlSel.indexOf("button") >= 0 && ctrlSel.indexOf('input[type="checkbox"]') >= 0,
      "「提交即生效」的控件才不记：原生 select / 按钮 / 勾选型 input",
    );
    ok(
      ctrlSel.indexOf("textarea") < 0 && ctrlSel.indexOf("[contenteditable]") < 0 && !/input(?!\[)/.test(ctrlSel.replace(/input\[[^\]]*\]/g, "")),
      "文本框 / 富文本仍吃这条保护：按下到松手之间也不重建（框选起手不被换掉）",
    );
    const watch = fnBody(LTU, "ltRenderWhenFocusLeaves");
    ok(
      watch.indexOf('addEventListener("selectionchange", onOut, true)') > 0 &&
        watch.indexOf('addEventListener("pointerup", onOut, true)') > 0 &&
        watch.indexOf('addEventListener("keyup", onOut, true)') > 0,
      "被推迟的重绘还听 selectionchange（选区折叠）/ pointerup（松手）/ keyup（Esc 收选区）",
    );
  }

  console.log("\n[2] 判据口径：谁拦重绘、谁不拦（vm 真跑）");
  {
    const sb = sandboxFor(["ltEditHost", "ltFocusCol", "ltFocusInside"], { document: mkDoc(null) });
    const col = mkEl("lt-right");
    const ta = mkField("textarea");
    const inp = mkField("input");
    const search = mkField("input");
    search.type = "search";
    const sel = mkField("select");
    const cb = mkField("input");
    cb.type = "checkbox";
    const rich = mkEl("md-rich");
    rich.isContentEditable = true;
    const btn = mkEl("lt-btn");
    btn.tagName = "BUTTON";
    const outside = mkField("input");
    for (const e of [ta, inp, search, sel, cb, rich, btn]) col.appendChild(e);

    sb.__col = col;
    sb.__ta = ta;
    const focusCol = (el) => {
      sb.document.activeElement = el;
      return vm.runInContext("ltFocusCol(__col)", sb);
    };
    const focusInside = (el) => {
      sb.document.activeElement = el;
      return vm.runInContext("ltFocusInside(__col)", sb);
    };
    ok(focusCol(ta) === true, "焦点在右栏 textarea（审批理由框 / 环节目标）→ 拦重绘（这一栏不许被重建）");
    ok(focusCol(inp) === true, "焦点在右栏文本 input（环节参数 / 交付文件名）→ 拦重绘");
    ok(focusCol(search) === true, "焦点在右栏搜索框（可搜索下拉：正打过滤词）→ 拦重绘（下拉不能被换掉）");
    ok(focusCol(rich) === true, "焦点在右栏 contenteditable（富文本）→ 拦重绘");
    ok(focusCol(sel) === false, "焦点在右栏 select → **不拦**：选完就是一次提交，「人工任务类型」切成交付要当场长出交付清单");
    ok(focusCol(cb) === false, "焦点在右栏复选框 → 不拦：勾选就是提交（勾「允许读取画布」要当场把提示刷对）");
    ok(focusCol(btn) === false, "焦点在右栏按钮上 → 不拦（按钮不是「正在输入」，面板照常跟着运行态刷）");
    ok(focusCol(outside) === false, "焦点在栏外（左栏 / 别处）的输入框 → 不拦");
    ok(focusCol(sb.document.body) === false, "焦点在 body（失焦态）→ 不拦，重绘立刻照旧");
    ok(focusCol(null) === false, "没有活动元素 → 不报错、不误拦");
    ok(focusInside(btn) === true, "补重绘的判据 ltFocusInside：按钮上的焦点也算「还在这一栏」，先把 click 让完");
    ok(focusInside(outside) === false, "焦点离开了两栏 → 该补重绘了");
  }

  console.log("\n[2b] 选区判据 ltSelInCol：栏里有活的选区才拦（vm 真跑）");
  {
    const doc = mkDoc(null);
    const sb = sandboxFor(["ltSelInCol"], { document: doc });
    const col = mkEl("lt-right");
    const textA = mkEl("");
    const textB = mkEl("");
    const outside = mkEl("");
    col.appendChild(textA);
    sb.__col = col;
    const runSel = (sel) => {
      doc.getSelection = sel ? () => sel : undefined;
      return vm.runInContext("ltSelInCol(__col)", sb);
    };
    ok(
      runSel(mkSel(textA, textB, false)) === true,
      "拖选右栏里的只读文字（选区锚点在栏内）→ 拦重绘：被选中的那段文字不会被整块重建冲掉",
    );
    ok(runSel(mkSel(textA, textB, false)) === true, "（再判一次仍拦得住：~90ms 一次的重绘每次都拦得住）");
    ok(runSel(mkSel(textA, null, false)) === true, "锚点 / 终点只落在一头也算（跨栏拖选时终点可能在栏外）");
    ok(runSel(mkSel(outside, outside, false)) === false, "选区在栏外 → 不拦（另一栏照常重绘）");
    ok(runSel(mkSel(textA, textB, true)) === false, "光标（折叠选区）不算框选 → 不拦");
    ok(runSel(null) === false, "没有选区对象 → 不拦、不报错");
    ok(runSel(mkSel(textA.parentNode, textB, false)) === true, "选区锚在**文本节点**上（真实拖选常见）→ 按父元素判定，照样拦得住");
    ok(runSel(undefined) === false, "document 没有 getSelection（迷你环境）→ 不拦、不报错");
  }

  console.log("\n[2c] 按住判据 ltHoldArm / ltColHold：控件按下不记（提交语义不变）");
  {
    const doc = mkDoc(null);
    const main = mkEl("lt-main");
    const left = mkEl("lt-left");
    const right = mkEl("lt-right");
    main.appendChild(left);
    main.appendChild(right);
    const textEl = mkEl("lt-fh");
    const ta = mkField("textarea");
    const btnEl = mkEl("lt-btn");
    btnEl.tagName = "BUTTON";
    btnEl.closest = mkClosest(btnEl, "button");
    const cbEl = mkField("input", "checkbox");
    const selEl = mkField("select");
    const outsideEl = mkEl("");
    right.appendChild(textEl);
    right.appendChild(ta);
    right.appendChild(btnEl);
    right.appendChild(cbEl);
    right.appendChild(selEl);
    let flushes = 0;
    const sb = sandboxFor(
      ["ltEditHost", "ltFocusCol", "ltSelInCol", "ltColOf", "ltHoldCtrlEl", "ltHoldArm", "ltHoldRelease", "ltColHold"],
      { document: doc, LT_UI: { main }, ltRenderFlushDeferred: () => flushes++ },
    );
    const hold = () => vm.runInContext("ltHoldColEl", sb);
    const colHold = (col) => {
      sb.__col = col;
      return vm.runInContext("ltColHold(__col)", sb);
    };
    const arm = (el) => {
      sb.__el = el;
      return vm.runInContext("ltHoldArm(__el)", sb);
    };
    const release = () => vm.runInContext("ltHoldRelease()", sb);

    arm(textEl);
    ok(hold() === right, "鼠标按在右栏的普通文字上（要框选）→ 记下这一栏");
    ok(colHold(right) === true && colHold(left) === false, "这一栏从此不许重建，另一栏照常重绘");
    release();
    ok(hold() === null && flushes === 1, "松手即释放，并立刻兑现此前被推迟的那一次重绘");

    arm(ta);
    ok(hold() === right && colHold(right) === true, "按在文本框里（右栏的理由框 / 参数）→ 也记：框选起手那一下不能被换掉（提交走 change，不在这按下里）");
    release();
    arm(btnEl);
    ok(hold() === null, "按在按钮上 → 不记：按钮的 click 要立刻生效");
    arm(cbEl);
    ok(hold() === null, "按在勾选型 input 上 → 不记：change 就是一次提交（勾「允许读取画布」要当场刷提示）");
    arm(selEl);
    ok(hold() === null, "按在原生 select 上 → 不记：选完即 change，「人工任务类型」切成交付要当场长出交付清单");
    flushes = 0;
    release();
    ok(flushes === 0, "没有按住态时松手不做无谓重绘（不在 mouseup 上白刷一帧）");
    arm(outsideEl);
    ok(hold() === null, "按在两栏之外（画布 / 头部）→ 不记");
    /* 左栏（SVG 状态机图）不吃这条保护：点节点的选中高亮要靠 pointerdown 里那次重绘落到当下这一帧 */
    const leftText = mkEl("lt-graph");
    left.appendChild(leftText);
    arm(leftText);
    ok(hold() === null, "按在左栏的图上 → 不记：点一下节点的选中高亮要立刻出来（拖动手势另有 document 级监听兜底）");
    arm(textEl);
    release();
  }

  console.log("\n[3] 真跑 ltRenderMain：焦点在哪一栏，那一栏的 DOM 原样留下");
  {
    const calls = { graph: 0, side: 0 };
    const doc = mkDoc(null);
    const main = mkEl("lt-main");
    const sb = sandboxFor(["ltEditHost", "ltFocusCol", "ltColOf", "ltRenderMain", "ltHoverHere"], {
      document: doc,
      LT_UI: { main },
      ltActiveTask: () => ({ uid: "t1", graph: { nodes: [], edges: [] }, ver: 1 }),
      ltEnabledTask: () => null,
      ltCurrentRun: () => null,
      ltEmptyState: () => mkEl("lt-empty"),
      ltEl: (tag, cls) => {
        const e = mkEl(cls || "");
        e.tagName = String(tag || "div").toUpperCase();
        return e;
      },
      ltRenderGraph: (left) => {
        calls.graph++;
        left.appendChild(mkEl("lt-graph"));
      },
      ltRenderSide: (right) => {
        calls.side++;
        right.appendChild(mkEl("lt-card"));
      },
      ltRenderWhenFocusLeaves: () => {},
      /* 按住保护 / 栏位登记（本次需求）：本档验的是「焦点保护」，按住态一律当「没按着」，
         栏位登记给一份空实现（真行为由 smoke-longtask-strip-hold.js 与 scroll 那档钉）。 */
      ltTrackCols: () => {},
      ltStripHoldNow: () => false,
    });
    const render = () => vm.runInContext("ltRenderMain({ id: 'wf1' })", sb);
    const colOf = (cls) => vm.runInContext("ltColOf(LT_UI.main, '" + cls + "')", sb);

    /* A. 焦点在右栏输入里：右栏原地留下，只重建左栏 */
    const leftA = mkEl("lt-left");
    const rightA = mkEl("lt-right");
    const taA = mkField("textarea");
    rightA.appendChild(taA);
    main.appendChild(leftA);
    main.appendChild(rightA);
    doc.activeElement = taA;
    calls.graph = 0;
    calls.side = 0;
    render();
    ok(colOf("lt-right") === rightA, "焦点在右栏输入里 → 右栏还是**同一个 DOM 节点**（没有重建、也没被摘出文档）");
    ok(rightA.contains(taA) && taA.parentNode === rightA, "那只理由框还在原位：焦点 / 选区 / 输入法组合态不被打断");
    ok(calls.side === 0, "右栏没有被重画（ltRenderSide 一次都没调）");
    ok(calls.graph === 1 && main.children.length === 2 && main.children[0].classList.contains("lt-left"), "左栏照常重建并排在右栏之前（运行态可视化不丢）");
    ok(main._cleared === 0, "这条路没有走 innerHTML = \"\"（整块重建）");

    /* B. 焦点在左栏输入里：这一栏同样留下，只重建右栏 */
    const rightB = mkEl("lt-right");
    const leftB = colOf("lt-left");
    const inpB = mkField("input");
    leftB.appendChild(inpB);
    doc.activeElement = inpB;
    calls.graph = 0;
    calls.side = 0;
    render();
    ok(colOf("lt-left") === leftB && leftB.contains(inpB), "焦点在左栏输入里 → 左栏原样留下（另一边：右栏照常跟着运行态重绘）");
    ok(calls.graph === 0 && calls.side === 1, "只重建了右栏");

    /* C. 没有可编辑焦点：维持原来的整块重建口径 */
    const oldRight = colOf("lt-right");
    doc.activeElement = doc.body;
    calls.graph = 0;
    calls.side = 0;
    render();
    ok(main._cleared === 1, "没有可编辑焦点 → 仍走 main.innerHTML = \"\" 整块重建（旧口径不变）");
    ok(colOf("lt-right") !== oldRight && calls.graph === 1 && calls.side === 1, "两栏都重建了");

    /* D. 条带里没有任务：仍是空态，不受影响 */
    const sb2 = sandboxFor(["ltEditHost", "ltFocusCol", "ltColOf", "ltRenderMain", "ltHoverHere"], {
      document: doc,
      LT_UI: { main: mkEl("lt-main") },
      ltActiveTask: () => null,
      ltEnabledTask: () => null,
      ltCurrentRun: () => null,
      ltEmptyState: () => mkEl("lt-empty"),
      ltEl: (tag, cls) => mkEl(cls || ""),
      ltRenderGraph: () => {},
      ltRenderSide: () => {},
      ltRenderWhenFocusLeaves: () => {},
      ltTrackCols: () => {},
      ltStripHoldNow: () => false,
    });
    vm.runInContext("ltRenderMain({ id: 'wf1' })", sb2);
    ok(sb2.LT_UI.main.children.length === 1 && sb2.LT_UI.main.children[0].classList.contains("lt-empty"), "没有长任务时照旧只画空态");

    /* E/F. 本次需求：焦点不在输入里，但「右栏里有一段框选出来的选区」/「鼠标正按在右栏文字上」，
           重绘也必须是「右栏原地留下、只重建左栏」—— 之前这两条路会走整块重建，被选中的
           节点整体被换掉，浏览器只能把选区收掉 = 「框选后立刻 defocus」。 */
    const calls3 = { graph: 0, side: 0 };
    const doc3 = mkDoc(null);
    const main3 = mkEl("lt-main");
    const sb3 = sandboxFor(["ltEditHost", "ltFocusCol", "ltSelInCol", "ltColHold", "ltColOf", "ltRenderMain", "ltHoverHere"], {
      document: doc3,
      LT_UI: { main: main3 },
      ltHoldColEl: null,
      ltActiveTask: () => ({ uid: "t1", graph: { nodes: [], edges: [] }, ver: 1 }),
      ltEnabledTask: () => null,
      ltCurrentRun: () => null,
      ltEmptyState: () => mkEl("lt-empty"),
      ltEl: (tag, cls) => {
        const e = mkEl(cls || "");
        e.tagName = String(tag || "div").toUpperCase();
        return e;
      },
      ltRenderGraph: (left) => {
        calls3.graph++;
        left.appendChild(mkEl("lt-graph"));
      },
      ltRenderSide: (right) => {
        calls3.side++;
        right.appendChild(mkEl("lt-card"));
      },
      ltRenderWhenFocusLeaves: () => {},
      ltTrackCols: () => {},
      ltStripHoldNow: () => false,
    });
    const render3 = () => vm.runInContext("ltRenderMain({ id: 'wf1' })", sb3);
    const colOf3 = (cls) => vm.runInContext("ltColOf(LT_UI.main, '" + cls + "')", sb3);
    const left3 = mkEl("lt-left");
    const right3 = mkEl("lt-right");
    const txt3 = mkEl("lt-fh"); /* 右栏里一段只读文字（检查器正文 / 待办卡提示） */
    right3.appendChild(txt3);
    main3.appendChild(left3);
    main3.appendChild(right3);

    doc3.activeElement = doc3.body;
    doc3.getSelection = () => mkSel(txt3, txt3, false);
    calls3.graph = 0;
    calls3.side = 0;
    render3();
    ok(colOf3("lt-right") === right3, "右栏里有活的选区（框选只读文字）→ 右栏还是**同一个 DOM 节点**：选区不会被冲掉");
    ok(right3.contains(txt3) && txt3.parentNode === right3, "被选中的那段文字原地留着（选区锚点没被摘出文档）");
    ok(main3._cleared === 0 && calls3.side === 0, "这条路没走整块重建、右栏一次都没重画");
    ok(calls3.graph === 1, "左栏照常重建（运行态可视化一条都不丢）");

    /* F. 鼠标正按在右栏文字上（框选刚起手、选区还没成形）：同样不许重建 */
    doc3.getSelection = () => mkSel(null, null, true);
    sb3.ltHoldColEl = right3;
    calls3.graph = 0;
    calls3.side = 0;
    render3();
    ok(colOf3("lt-right") === right3 && main3._cleared === 0, "鼠标正按在右栏文字上 → 右栏照旧原地留下（mousedown 的落点不会被换掉，拖拽选中的手势不作废）");
    ok(calls3.graph === 1 && calls3.side === 0, "只重建左栏");

    /* 松手 + 选区折叠（点别处 / Esc）→ 回到整块重建的老口径，界面不会长期冻结 */
    sb3.ltHoldColEl = null;
    calls3.graph = 0;
    calls3.side = 0;
    render3();
    ok(main3._cleared === 1 && colOf3("lt-right") !== right3 && calls3.graph === 1 && calls3.side === 1, "选区折叠 / 松手后 → 立刻回到整块重建的老口径（运行态更新不会被长期冻结）");
  }

  console.log("\n[4] 推迟的那一次重绘：打字 / 框选 / 按住都放开了才补，且只挂一轮监听");
  {
    const doc = mkDoc(null);
    const main = mkEl("lt-main");
    const left = mkEl("lt-left");
    const right = mkEl("lt-right");
    const ta = mkField("textarea");
    const txt = mkEl("lt-fh"); /* 右栏里一段只读文字（框选它的场景） */
    right.appendChild(ta);
    right.appendChild(txt);
    main.appendChild(left);
    main.appendChild(right);
    const calls = { strip: 0 };
    const sb = sandboxFor(
      ["ltEditHost", "ltFocusCol", "ltSelInCol", "ltColHold", "ltColHoldNow", "ltRenderFlushDeferred", "ltFocusInside", "ltColOf", "ltRenderWhenFocusLeaves"],
      {
        document: doc,
        LT_UI: { main },
        ltRenderWait: false,
        ltRenderWaitOff: null,
        ltHoldColEl: null,
        ltRenderStrip: () => {
          calls.strip++;
        },
      },
    );
    const arm = () => vm.runInContext("ltRenderWhenFocusLeaves()", sb);
    const listeners = () => doc.listeners.map((l) => l.type).sort().join(",");
    const WATCH_TYPES = "focusout,keyup,pointerup,selectionchange";

    doc.activeElement = ta;
    arm();
    arm();
    ok(doc.listeners.filter((l) => l.type === "focusout").length === 1, "只挂一条 focusout 监听（反复重绘不会越挂越多）");
    ok(doc.listeners[0].capture === true, "挂在捕获阶段（早于各处自己的失焦处理）");
    ok(listeners() === WATCH_TYPES, "四类监听各一条（focusout / selectionchange / pointerup / keyup），不重复挂");
    doc.emit("focusout");
    ok(calls.strip === 0, "焦点还在右栏输入里 → 不补重绘（用户还在打字，绝不重建这一栏）");
    doc.activeElement = doc.body;
    doc.emit("focusout");
    ok(calls.strip === 1, "焦点离开两栏 → 补一次完整重绘（运行态更新一条都不丢）");
    ok(doc.listeners.length === 0, "补完自己摘掉监听（不留悬挂）");
    /* 点栏内按钮：焦点移到按钮上（还在栏内）→ 先不补，免得把按钮在 mouseup 之前拆掉 */
    doc.activeElement = ta;
    arm();
    const btn = mkEl("lt-btn");
    right.appendChild(btn);
    doc.activeElement = btn;
    doc.emit("focusout");
    ok(calls.strip === 1 && listeners() === WATCH_TYPES, "点栏内按钮（焦点移到同栏按钮）→ 先不补重绘，让这次 click 落得下去");
    doc.activeElement = doc.body;
    doc.emit("focusout");
    ok(calls.strip === 2, "点完离开这一栏 → 再补上（面板不会一直停在旧状态）");

    /* 本次需求：焦点不在栏里、但右栏里留着一段框选出来的选区 → 重绘继续等，
       选区折叠（点别处 / Esc，selectionchange）那一刻才兑现 —— 框选期间运行态更新不丢、选区也不丢 */
    doc.getSelection = () => mkSel(txt, txt, false);
    arm();
    doc.emit("selectionchange");
    ok(calls.strip === 2, "右栏里还有活的选区 → 不补重绘（框选的那段文字原地留着，不会被换掉）");
    doc.getSelection = () => mkSel(txt, txt, true);
    doc.emit("selectionchange");
    ok(calls.strip === 3, "选区一折叠（点别处 / Esc）→ 立刻兑现这次重绘，界面不长期冻结");
    ok(doc.listeners.length === 0, "兑现后监听摘干净");

    /* 鼠标还按在右栏文字上（框选刚起手）→ 也等；松手（pointerup）那一刻兑现 */
    sb.ltHoldColEl = right;
    arm();
    doc.emit("pointerup");
    ok(calls.strip === 3, "鼠标还按着（pointerup 之前）→ 不补重绘：mousedown 的落点与拖拽手势都不会被打断");
    sb.ltHoldColEl = null;
    doc.emit("pointerup");
    ok(calls.strip === 4, "松手 → 兑现重绘（ltHoldRelease 与这条监听任一路都能收口）");
  }

  console.log("\n[5] 症状对照（快捷键只是症状，不是起因）");
  {
    ok(
      LTV.indexOf('if (type === "reasoning") st.think = 1;') > 0 &&
        LTV.indexOf("      ltRenderStripSoon();\n    },\n  };") > 0,
      "Agent 流式事件的 onEvent 逐帧叫重绘（app-longtask.js）——右栏被重建的密度来源",
    );
    ok(
      LTV.indexOf("function ltRenderStripSoon()") > 0 && LTV.indexOf("}, 90);") > 0,
      "这条重绘仍走 90ms 节流入口（依旧很密，所以只能靠「不许重建正在输入的那一栏」来治）",
    );
    ok(
      KEYS.indexOf("isEditableEl(ev.target) || isEditableEl(document.activeElement)") > 0,
      "顶栏快捷键只在「焦点还在可编辑元素里」时让位（app-keys.js）——失焦之后它才开始生效",
    );
    const mainBody = fnBody(LTU, "ltRenderMain");
    ok(
      mainBody.indexOf('main.innerHTML = ""') > 0 && mainBody.indexOf("ltRenderWhenFocusLeaves();") > 0,
      "整块重建那条路仍在，只是被推迟到焦点离开之后（两条口径并存，不是删掉重绘）",
    );
  }

  console.log(
    fails
      ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-refocus)"
      : "\n✓ " + checks + " 项全部通过  (smoke-longtask-refocus)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-refocus.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-refocus.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-longtask-hover.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-hover.js";
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
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n/g, "\n");

  const LTU = read("renderer/app-longtask-ui.js");
  const LTC = read("renderer/css/longtask.css");

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
  /* 函数全文（到第 0 列的那个收尾大括号为止）。/["\\]/ 这类带引号的正则字面量会让上面那个
     朴素括号计数器把字符串态判错，纯文本断言一律走这一份，不拿 fnBody 去切。 */
  function fnSrc(src, name) {
    const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
    if (!m) throw new Error("找不到函数：" + name);
    const rest = src.slice(m.index);
    const end = rest.indexOf("\n}\n");
    return end < 0 ? rest : rest.slice(0, end + 3);
  }

  /* ── 迷你 DOM：够这条判据用（classList / 属性表 / children / parentNode / 递归遍历），
        并集 ＝ HTML 元素（head 里那批 button）与 SVG 元素（图节点 g / 端子 circle）两种 ── */
  function mkEl(cls, attrs) {
    const el = {
      nodeType: 1,
      tagName: "DIV",
      className: cls || "",
      children: [],
      parentNode: null,
      attrs: Object.assign({}, attrs || {}),
      textContent: "",
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      /* 可点件判定用的是 closest——迷你元素照真元素给一份（只认选择器表里那几类：标签名与类名） */
      closest(sel) {
        for (const part of String(sel).split(",")) {
          const s = part.trim().toLowerCase();
          if (!s) continue;
          if (s.charAt(0) === ".") {
            if (String(this.className).split(/\s+/).indexOf(s.slice(1)) >= 0) return this;
          } else if (s === String(this.tagName || "").toLowerCase()) return this;
        }
        return null;
      },
      appendChild(c) {
        if (c && c.parentNode) c.parentNode.removeChild(c);
        this.children.push(c);
        if (c) c.parentNode = this;
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        if (c) c.parentNode = null;
        return c;
      },
      contains(t) {
        let p = t;
        while (p) {
          if (p === this) return true;
          p = p.parentNode;
        }
        return false;
      },
    };
    el.classList = { contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0 };
    Object.defineProperty(el, "innerHTML", {
      get() {
        return "";
      },
      set() {
        this._cleared = (this._cleared || 0) + 1;
        for (const c of this.children.slice()) this.removeChild(c);
      },
    });
    return el;
  }
  function mkBtn(cls, txt) {
    const b = mkEl(cls);
    b.tagName = "BUTTON";
    b.textContent = txt;
    return b;
  }
  function walkAll(root, out) {
    out = out || [];
    for (const c of root.children || []) {
      out.push(c);
      walkAll(c, out);
    }
    return out;
  }
  function withDataHover(root) {
    return walkAll(root).filter((n) => n.getAttribute("data-hover") === "1");
  }
  /* 状态机图里的一个节点卡片 + 端子（结构照 ltRenderGraph：g.lt-nd[data-lt-id] > circle.lt-port） */
  function mkGraphNode(id) {
    const g = mkEl("lt-nd lt-k-agent");
    g.tagName = "G";
    g.setAttribute("data-lt-id", id);
    const port = mkEl("lt-port");
    port.tagName = "CIRCLE";
    g.appendChild(port);
    return { g, port };
  }

  console.log("\n[1] 悬停保护判据就位（renderer/app-longtask-ui.js）");
  {
    for (const n of ["ltHoverNodeKey", "ltHoverKey", "ltHoverCapture", "ltHoverApply", "ltHoverBind"])
      ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有 " + n);
    ok(LTU.indexOf("ltHoverCapture(LT_UI.body)") > 0 && LTU.indexOf("ltHoverHere();") > 0, "ltRenderStrip 重建前后各走一步（先采一帧、建完补标）");
    ok(fnSrc(LTU, "ltRenderStrip").indexOf("ltHoverBind()") > 0, "重绘入口顺手挂上指针监听（pointermove 一移就抹标）");
    ok(/pointermove/.test(fnSrc(LTU, "ltHoverBind")) && /data-hover/.test(fnSrc(LTU, "ltHoverBind")), "指针一动就把上一帧的标清掉（悬停态只由「此刻指针在哪」决定）");
  }

  console.log("\n[2] key 口径（vm 真跑）");
  {
    const sb = { console, Array, Object, String, Number, isFinite };
    vm.createContext(sb);
    for (const n of ["ltHoverNodeKey", "ltHoverKey"]) vm.runInContext(fnBody(LTU, n), sb);
    vm.runInContext("globalThis.DOC = { elementFromPoint: function () { return null; } };", sb);
    const key = (el) => vm.runInContext("ltHoverKey", sb)(el);

    const n1 = mkGraphNode("n_a1");
    ok(key(n1.g) === "lt-nd:@n_a1", "图节点卡片：key = 节点 data-lt-id（与这一帧长什么样无关）");
    ok(key(n1.port) === "lt-nd:|port@n_a1", "端子：并上「是哪一件」，指针从端子移到卡片不会被当成同一件");
    const rs = mkEl("lt-nd-resize");
    n1.g.appendChild(rs);
    ok(key(rs) === "lt-nd:|resize@n_a1", "缩放手柄：同样带后缀（它是卡片组里的独立 rect）");
    const noId = mkEl("lt-nd");
    ok(key(noId) === "", "没有 data-lt-id 的卡片不给 key（不按没有身份的东西补标）");

    const stop = mkBtn("lt-btn lt-btn-pri", "■ 停止");
    ok(key(stop) === "lt-el:■ 停止", "普通按钮：按可点件类 + 文案取身份");
    const more = mkBtn("lt-btn lt-more", "⋯ 更多");
    ok(key(more) === "lt-el:⋯ 更多", "头部按钮同样认得出（文案就是它的身份）");
    const chip = mkEl("lt-chip lt-chip-wait");
    chip.textContent = "等你处理 ×2";
    ok(key(chip) === "lt-el:等你处理 ×2", "可点的状态胶囊：key 取它自己的文案（点击落点可能是不带按钮结构的 span）");
    const cardBtn = mkBtn("lt-btn", "通过");
    const card = mkEl("lt-mem-i");
    card.appendChild(cardBtn);
    ok(key(card) === "" && key(cardBtn) === "lt-el:通过", "非可点容器不给 key、里面的按钮照给（补标只落在真正匹配的那一件上）");
  }

  console.log("\n[3] 重建后补标（vm 真跑 ltRenderStrip）");
  {
    const body = mkEl("lt-body");
    const head = mkEl("lt-head");
    const main = mkEl("lt-main");
    body.appendChild(head);
    body.appendChild(main);
    const doc = {
      listeners: [],
      activeElement: null,
      body: mkEl(""),
      documentElement: mkEl(""),
      addEventListener(type, fn) {
        this.listeners.push({ type, fn });
      },
      removeEventListener() {},
      querySelectorAll() {
        return [];
      },
      querySelector() {
        return null;
      },
    };
    doc.body.tagName = "BODY";
    doc.documentElement.tagName = "HTML";
    /* 指针底下的那一件：由每轮的 hit 决定（模拟「鼠标停着不动、条带每 ~90ms 重建一次」） */
    const hit = { el: null };
    doc.elementFromPoint = () => hit.el;
    let graphNode = null;
    const sb = {
      console,
      Array,
      Object,
      String,
      Number,
      Date,
      Math,
      JSON,
      isFinite,
      parseFloat,
      parseInt,
      document: doc,
      /* 滚动保护的两张表（本次需求）：照源码那一份建空表（Object.create(null)）—— 本档不验
       滚动位置，只保证 ltRenderStrip 收尾那一步找得到表、不抛异常。 */
      LT_SCROLL: Object.create(null),
      LT_SCROLL_SUB: Object.create(null),
      LT_UI: { body, head, main, grip: mkEl("lt-grip") },
      ltHoverBound: false,
      ltHoverX: 300,
      ltHoverY: 40,
      ltHoldColEl: null,
      ltRenderWait: false,
      S: { wf: { id: "wf1" } },
      ltGripSync: () => {},
      ltEnsure: () => {},
      ltMenuClose: () => {},
      ltMenuReadopt: () => {},
      LT_MENU: null,
      ltActiveTask: () => ({ uid: "t1", graph: { nodes: [], edges: [] }, ver: 1 }),
      ltEnabledTask: () => null,
      ltCurrentRun: () => null,
      ltValidate: () => [],
      ltMemPendingCount: () => 0,
      /* 条带头那一枚「当前选型」chip（ltRenderHead 里新加的只读回显）：本档只验悬停补标，
         回显四件套按「拿不到清单」的空态桩掉 —— 真行为由 smoke-longtask-model.js 钉。 */
      ltAgentOptsNow: () => null,
      ltAgentSelRead: () => ({ provider: "", model: "", preset: "", effort: "" }),
      ltAgentSelParts: () => ({ route: "", model: "", preset: "", effort: "" }),
      ltAgentSelText: () => "",
      ltAgentModelShort: () => "",
      ltEl: (tag, cls, txt) => {
        const e = mkEl(cls || "");
        e.tagName = String(tag || "div").toUpperCase();
        if (txt != null) e.textContent = String(txt);
        return e;
      },
      ltBtn: (text, cls) => mkBtn("lt-btn " + (cls || ""), text),
      ltStatusChip: () => mkEl("lt-chip lt-chip-run"),
      ltMoreBtn: () => mkBtn("lt-btn lt-more", "⋯ 更多"),
      ltT: (t) => t,
      ltEmptyState: () => mkEl("lt-empty"),
      ltColOf: () => null,
      ltColHold: () => false,
      ltFocusCol: () => false,
      ltEditHost: () => null,
      ltFocusInside: () => false,
      ltSelInCol: () => false,
      ltRenderWhenFocusLeaves: () => {},
      ltRenderSide: () => {},
      /* 按住保护（本次需求）：本档只验悬停补标，按住态一律当「没按着」（真行为由
         smoke-longtask-strip-hold.js 钉）。 */
      ltStripHold: { el: null, at: 0 },
      ltRenderGraph: (left) => {
        const node = mkGraphNode("n_a1");
        graphNode = node;
        left.appendChild(node.g);
      },
    };
    vm.createContext(sb);
    for (const n of [
      "ltHoverNodeKey",
      "ltHoverKey",
      "ltHoverCapture",
      "ltHoverApply",
      "ltHoverBind",
      "ltHoverHere",
      "ltRenderStrip",
      "ltRenderHead",
      "ltRenderMain",
      "ltRenderFlushDeferred",
      "ltRenderWhenFocusLeaves",
      /* 按住保护与滚动保护（本次需求）：本档只验悬停补标，这两个直接跑真身即可 ——
         「没按着」走 ltStripHoldNow，栏位登记走 ltTrackCols，都不会碰悬停标。 */
      "ltStripOf",
      "ltStripHoldNow",
      "ltStripHoldRelease",
      "ltDeferBecauseHold",
      "ltTrackCols",
      "ltScrollTopNow",
      "ltScrollHNow",
      "ltScrollCHNow",
      "ltScrollKeyOf",
      "ltScrollSave",
      "ltScrollRestore",
      "ltScrollCollect",
      "ltScrollSaveSub",
      "ltScrollRestoreSub",
      "ltScrollSnapshot",
      "ltScrollApply",
      "ltScrollRebind",
    ])
      vm.runInContext(fnBody(LTU, n), sb);
    doc.listeners = [];
    const render = () => vm.runInContext("ltRenderStrip()", sb);
    const headBtn = () => head.children.filter((c) => c.tagName === "BUTTON")[0] || null;

    /* A. 指针压着头部按钮：重建后新按钮同样带悬停标（这正是「闪烁」的那一件） */
    hit.el = null;
    render();
    const b1 = headBtn();
    ok(!!b1 && b1.getAttribute("data-hover") === null, "第一帧（指针还不在条带里）不补任何标");
    hit.el = b1;
    render();
    const b2 = headBtn();
    ok(b2 !== b1 && b2.getAttribute("data-hover") === "1", "指针停在头部按钮上 → 重建出来的新按钮带上 data-hover（悬停态不再每 90ms 丢一帧）");
    ok(withDataHover(body).length === 1, "只给真正匹配的那一件补标（不传播到别的按钮）");

    /* B. 指针压着图节点 / 端子：左栏 SVG 整张重建，节点与端子照样补得上 */
    hit.el = null;
    render();
    hit.el = graphNode.g;
    render();
    ok(graphNode.g.getAttribute("data-hover") === "1", "指针停在图节点上 → 新节点卡片补标（悬停态续到重建出来的那一张上）");
    hit.el = graphNode.port;
    render();
    ok(graphNode.port.getAttribute("data-hover") === "1" && graphNode.g.getAttribute("data-hover") === "1", "指针停在端子上 → 新端子与它所属卡片都补标（端子悬停不会闪）");

    /* C. 指针移开（elementFromPoint 落空 = 指针不在条带里）：一个标都不补 */
    hit.el = null;
    render();
    ok(withDataHover(body).length === 0, "指针不在条带里 → 不补标（悬停态不会粘在重建后的新件上）");

    /* D. 监听真挂上了：pointermove 一移就抹掉旧标 */
    ok(doc.listeners.filter((l) => l.type === "pointermove").length === 1, "只挂一条 pointermove 监听（反复重绘不会越挂越多）");
    const hovered = mkBtn("lt-btn", "占位");
    hovered.setAttribute("data-hover", "1");
    head.appendChild(hovered);
    doc.querySelectorAll = () => [hovered];
    const move = doc.listeners.filter((l) => l.type === "pointermove")[0];
    move.fn({ clientX: 120, clientY: 33 });
    ok(hovered.getAttribute("data-hover") === null, "指针一动就抹标（并且顺手记下新的指针坐标）");

    /* E. 焦点保护那两条早退路也要补标：右栏正在打字时左栏重建，悬停态不能顺手丢掉 */
    ok((fnSrc(LTU, "ltRenderMain").match(/ltHoverHere\(\)/g) || []).length >= 4, "ltRenderMain 的四条出口（空态 / 留右栏 / 留左栏 / 整块重建）都走补标，早退路不漏");
    ok(fnBody(LTU, "ltRenderStrip").indexOf("ltHoverHere()") > 0, "strip 那一层重建后也补标（head 被换掉的那些件在这里续上）");
    ok(fnSrc(LTU, "ltRenderStrip").indexOf("LT_UI.hoverKeys = typeof ltHoverCapture === \"function\" ? ltHoverCapture(LT_UI.body) : []") > 0, "采集在任何 DOM 被换掉之前落进 LT_UI.hoverKeys（各条重建路共用这一份）");
  }

  console.log("\n[4] CSS：悬停态写成 `:hover, [data-hover]` 两路（本次需求的真正落点）");
  {
    /* 取一条规则的选择器文本（第一个 { 之前的那段），逐个看它有没有把两路并在一起 */
    const sels = [];
    const re = /([^{}]+)\{/g;
    let m;
    while ((m = re.exec(LTC))) sels.push(m[1].trim());
    const hasBoth = (frag) =>
      sels.some((s) => s.indexOf(frag) >= 0 && s.indexOf(":hover") >= 0 && s.indexOf("[data-hover]") >= 0);
    const pairs = [
      [".lt-btn:hover", ".lt-btn", "通用按钮（头部「■ 停止 / ✎ 修改任务链 / ⚙ / ✕」与右栏按钮都在这一族）"],
      [".lt-btn-pri:hover", ".lt-btn-pri", "主按钮（「＋ 创建长任务 / ▶ 继续」）"],
      [".lt-btn-force:hover", ".lt-btn-force", "「⏭ 强行进入下一状态」（本次需求：run 停在手上时的出路）"],
      [".lt-head .lt-btn.on", ".lt-head .lt-btn", "头部按钮的悬停 / 展开态"],
      [".lt-chip-wait:hover", ".lt-chip-wait", "状态胶囊「等你处理 ×N」（可点）"],
      [".lt-chip-mem:hover", ".lt-chip-mem", "状态胶囊「待确认记忆 ×N」（可点）"],
      [".lt-crumb-i:hover", ".lt-crumb-i", "面包屑条目"],
      [".lt-btn-zoom:hover", ".lt-btn-zoom", "缩放回显（点一下回 100%）"],
      [".lt-port:hover", ".lt-port", "状态机图端子"],
      [".lt-nd rect.lt-nd-resize:hover", ".lt-nd rect.lt-nd-resize", "节点缩放手柄"],
      [".lt-sel-o:hover", ".lt-sel-o", "可搜索下拉的选项"],
      [".lt-sel-tagx:hover", ".lt-sel-tagx", "多选芯片的 ✕"],
    ];
    for (const [frag, keep, label] of pairs) {
      ok(LTC.indexOf(frag) > 0, frag + " 仍在（" + label + "）");
      ok(hasBoth(keep + ":hover"), label + "：`:hover` 与 `[data-hover]` 并排写（重建后的补标与真 hover 同一份值）");
    }
    ok(/data-hover/.test(LTC) && LTC.indexOf("ltHoverKey") > 0, "样式里写清了这套标的来处（app-longtask-ui.js 的 ltHoverKey 一族）");
  }

  console.log("\n[5] 「⋯ 更多」下拉不再被头部重建收掉");
  {
    const headBody = fnSrc(LTU, "ltRenderHead");
    ok(headBody.indexOf("data-lt-menu") > 0 && headBody.indexOf("ltMenuReadopt(") > 0, "头部重建后按锚点身份把下拉认回来（以前一律 ltMenuClose，长任务跑着时点开就被收）");
    /* 只认「真的调了一次」的语句形态：注释里提到 ltMenuClose() 是说明，不是行为。
       例外（本轮口径）：模型 chip 的「再点一次自身即收」也是**在 onclick 里**收掉自己刚开的
       那一只面板 —— 它是点击手势的续写（紧跟 return），不是「重建时无条件收菜单」。
       所以判据收紧成「没有不跟 return 的裸 ltMenuClose();」：老那种无条件收仍然判失败。 */
    const bare = headBody.match(/ltMenuClose\(\s*\)\s*;(?!\s*return)/g) || [];
    ok(bare.length === 0, "ltRenderHead 不再无条件收菜单（只有认不到锚点才由 ltMenuReadopt 收；chip 的「再点一次自身即收」是手势续写，不算）");
    ok(LTU.indexOf('b.setAttribute("data-lt-menu", "lt-more")') > 0, "「⋯ 更多」按钮写下锚点身份（与按钮形状无关，重建后仍找得到）");
    const readopt = fnSrc(LTU, "ltMenuReadopt");
    ok(/ltMenuClose\(\s*\)\s*;/.test(readopt) && readopt.indexOf("ltMenuPlace(") > 0, "认不到锚点就收掉、认到就重新贴位（绝不留一只锚点已失效的浮层）");
    ok(LTU.indexOf("\nfunction ltMenuPlace(") > 0 && fnSrc(LTU, "ltMenuOpen").indexOf("ltMenuPlace(") > 0, "贴位逻辑抽成 ltMenuPlace，开菜单与重建后认锚点共用一份（不会两处各写一套溢出回收）");
  }

  console.log(
    fails
      ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-hover)"
      : "\n✓ " + checks + " 项全部通过  (smoke-longtask-hover)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-hover.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-hover.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-longtask-side-null-run.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-side-null-run.js";
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
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n/g, "\n");
  const LTU = read("renderer/app-longtask-ui.js");
  /* 源码闸要看**代码**、不看注释：本次修复的注释里就原样引用了那句坏写法
     （解释来处用），拿全文做正则必然误判。这里只把块注释与行注释抹成等长空白，
     行号与缩进保持原样，代码断言才有意义。 */
  const LTU_CODE = LTU.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(
    /(^|[^:"'`\\])\/\/[^\n]*/g,
    (m, p1) => p1 + " ".repeat(m.length - p1.length),
  );

  /* 函数体（含首尾大括号）：与 smoke-longtask-strip-scroll.js 同一口径 */
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
  /* 函数全文（到第 0 列那个收尾大括号为止）：纯文本断言专用 */
  function fnSrc(src, name) {
    const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
    if (!m) throw new Error("找不到函数：" + name);
    const rest = src.slice(m.index);
    const end = rest.indexOf("\n}\n");
    return end < 0 ? rest : rest.slice(0, end + 3);
  }

  /* ── 迷你 DOM（classList / children / 滚动几何 / querySelectorAll）── */
  function mkEl(tag, cls) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      className: cls || "",
      children: [],
      parentNode: null,
      attrs: {},
      textContent: "",
      title: "",
      style: {},
      scrollTop: 0,
      clientHeight: 0,
      scrollHeight: 0,
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      closest() {
        return null;
      },
      appendChild(c) {
        if (c && c.parentNode) c.parentNode.removeChild(c);
        this.children.push(c);
        if (c) c.parentNode = this;
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        if (c) c.parentNode = null;
        return c;
      },
      contains(t) {
        let p = t;
        while (p) {
          if (p === this) return true;
          p = p.parentNode;
        }
        return false;
      },
      querySelectorAll(sel) {
        const out = [];
        const keys = String(sel)
          .split(",")
          .map((s) => s.trim().replace(/^\[|\]$/g, ""))
          .filter(Boolean);
        const walk = (n) => {
          for (const c of n.children) {
            if (keys.some((k) => c.getAttribute(k) != null)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    el.classList = {
      contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0,
      add: (c) => {
        if (!el.classList.contains(c)) el.className = (el.className + " " + c).trim();
      },
      remove: (c) => {
        el.className = String(el.className)
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(" ");
      },
      toggle() {},
    };
    Object.defineProperty(el, "innerHTML", {
      get() {
        return "";
      },
      set() {
        for (const c of this.children.slice()) this.removeChild(c);
      },
    });
    Object.defineProperty(el, "isConnected", {
      get() {
        let p = this;
        let hops = 0;
        while (p) {
          if (p.parentNode == null) return hops > 0;
          p = p.parentNode;
          hops++;
        }
        return false;
      },
    });
    return el;
  }
  function scroller(cls, h, ch, top) {
    const el = mkEl("div", cls);
    el.clientHeight = h;
    el.scrollHeight = ch;
    el.scrollTop = top || 0;
    return el;
  }
  const SCROLL_FNS = [
    "ltScrollTopNow",
    "ltScrollHNow",
    "ltScrollCHNow",
    "ltScrollKeyOf",
    "ltScrollSave",
    "ltScrollRestore",
    "ltScrollCollect",
    "ltScrollSaveSub",
    "ltScrollRestoreSub",
    "ltScrollSnapshot",
    "ltScrollApply",
    "ltScrollRebind",
  ];
  function sandboxFor(names, extra) {
    const sb = Object.assign(
      {
        console,
        Array,
        Object,
        String,
        Number,
        Date,
        Math,
        JSON,
        isFinite,
        parseFloat,
        parseInt,
        LT_SCROLL: Object.create(null),
        LT_SCROLL_SUB: Object.create(null),
        ltEl: (tag, cls, txt) => {
          const e = mkEl(tag, cls);
          if (txt != null) e.textContent = String(txt);
          return e;
        },
        ltT: (s) => String(s),
        ltArr: (v) => (Array.isArray(v) ? v : []),
        ltStr: (v) => String(v == null ? "" : v),
      },
      extra || {},
    );
    vm.createContext(sb);
    for (const n of names) vm.runInContext(fnBody(LTU, n), sb);
    return sb;
  }

  console.log("\n[1] 源码闸：stuck 必须落成数组，不许再是 run && … 的短路值");
  {
    ok(
      !/const stuck =\s*\n?\s*run\s*&&/.test(LTU_CODE),
      "ltRenderSide 里不再有 `const stuck = run && Object.keys(...).filter(...)`（run 为空时它等于 null）",
    );
    ok(
      /const hasRun = !!run;/.test(LTU_CODE) && /const stuck = hasRun/.test(LTU_CODE),
      "先给 run 归一成一个明确的布尔（hasRun），stuck 按它分支",
    );
    ok(
      /: ltArr\(null\);/.test(LTU_CODE),
      "run 为空时 stuck 走 ltArr(null) → []（数组口径与其它清单一致，.length 永远安全）",
    );
    ok(
      /if \(stuck\.length\) \{/.test(LTU_CODE) && /ltArr\(null\);\n\s*if \(stuck\.length\)/.test(LTU_CODE),
      "紧接着的 `if (stuck.length)` 现在读的一定是数组",
    );
    ok(
      /run 为空（任务存着 activeRun/.test(LTU),
      "源码里写清了来处与症状（下一次不会再被当成「重绘顺手删掉」的代码）",
    );
  }

  console.log("\n[2] vm 真跑：run = null 时 ltRenderSide 不抛异常，右栏照样长内容");
  {
    const right = scroller("lt-right", 300, 900, 380);
    const made = [];
    const sb = sandboxFor(["ltRenderSide"], {
      LT_UI: { right },
      ltSel: { path: "", edge: "" },
      ltHumanCard: () => {
        const c = mkEl("div", "lt-card");
        made.push("human");
        return c;
      },
      ltBlockedCard: () => {
        made.push("blocked");
        return mkEl("div", "lt-card");
      },
      ltEdgeInspector: () => made.push("edge"),
      ltNodeInspector: () => made.push("node"),
      ltOverviewInspector: (host) => {
        made.push("overview");
        host.appendChild(mkEl("div", "lt-ov"));
      },
    });
    const side = vm.runInContext("ltRenderSide", sb);
    let err = null;
    try {
      /* run = null 正是「任务存着 activeRun、内存里那份 run 还没认领」那一刻 */
      side(right, { id: "wf" }, { uid: "t1", name: "任务" }, null);
    } catch (e) {
      err = e;
    }
    ok(!err, "ltRenderSide(right, wf, task, null) 不抛异常（得到 " + (err ? err.message : "无异常") + "）");
    ok(made.indexOf("overview") >= 0 || made.indexOf("node") >= 0, "右栏照常渲染检查器 / 图说明（没有因为 run 空就整块空掉）");
    ok(right.children.length >= 1, "右栏真的挂上了内容（children=" + right.children.length + "）");
    ok(made.indexOf("blocked") < 0, "run 为空 → 不列「卡住的环节」卡（没有清单可列）");
  }

  console.log("\n[3] vm 真跑：漫游一整遍「采帧 → 重建右栏 → 贴回」，滚动位置必须原样保住");
  {
    const oldRight = scroller("lt-right", 300, 1400, 520);
    const head = scroller("lt-head", 40, 40, 0);
    const left = scroller("lt-left", 300, 300, 0);
    const ui = { right: oldRight, left, head };
    const sb = sandboxFor(SCROLL_FNS, {
      LT_UI: ui,
      ltHoverHere: () => {},
      ltColOf: (root, cls) => {
        for (const c of root.children) if (c.classList.contains(cls)) return c;
        return null;
      },
    });
    const snapshot = vm.runInContext("ltScrollSnapshot", sb);
    const rebind = vm.runInContext("ltScrollRebind", sb);
    const snap = snapshot();
    ok(!!snap && snap.parts.some((p) => p.key === "col:lt-right"), "采帧带上了右栏（key=col:lt-right）");
    /* 重建：造一只同构的新右栏换进 LT_UI（模拟 ltRenderMain 的整块重建），
       新元素 scrollTop 天然是 0 —— 滚动保护没跑起来的话，用户看到的就是「回到顶端」 */
    const fresh = scroller("lt-right", 300, 1400, 0);
    ui.right = fresh;
    rebind(snap);
    ok(fresh.scrollTop === 520, "重建后右栏仍在 520（得到 " + fresh.scrollTop + "）");
    ok(oldRight.scrollTop === 520, "老栏的位置没被抹掉（ltScrollApply 记的是事实，不是 0）");
  }

  console.log("\n[4] 反证：渲染步骤抛异常 → 贴回再也跑不到（本次症状的机理）");
  {
    const oldRight = scroller("lt-right", 300, 1400, 430);
    const ui = { right: oldRight, left: scroller("lt-left", 300, 300, 0), head: scroller("lt-head", 40, 40, 0) };
    const sb = sandboxFor(SCROLL_FNS, { LT_UI: ui, ltHoverHere: () => {} });
    const snapshot = vm.runInContext("ltScrollSnapshot", sb);
    const rebind = vm.runInContext("ltScrollRebind", sb);
    const snap = snapshot();
    /* ltRenderStrip 的真实形状：先重建（旧栏被换掉），再收尾贴回 */
    const boom = () => {
      throw new TypeError("Cannot read properties of null (reading 'length')");
    };
    const fresh = scroller("lt-right", 300, 1400, 0);
    let caught = null;
    try {
      boom(); /* ← ltRenderMain 里的 ltRenderSide 抛了 */
      ui.right = fresh;
      rebind(snap); /* ← 收尾这一步因此永远执行不到 */
    } catch (e) {
      caught = e;
    }
    ok(!!caught, "渲染抛出的异常会冒到 ltRenderStrip（它没有兜底），收尾那一步被跳过");
    ok(fresh.scrollTop === 0, "于是新右栏停在 0 = 用户看到的「回到顶端」");
    /* 反过来：异常不再发生（本次修复）→ 收尾照常贴回 */
    ui.right = scroller("lt-right", 300, 1400, 0);
    rebind(snap);
    ok(ui.right.scrollTop === 430, "异常消失后，同一条收尾把位置贴回 430（修复后的行为）");
  }

  console.log(
    fails
      ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-side-null-run)"
      : "\n✓ " + checks + " 项全部通过  (smoke-longtask-side-null-run)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-side-null-run.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-side-null-run.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-longtask-guide-layout.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-guide-layout.js";
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
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n/g, "\n");

  const LTG = read("renderer/app-longtask-guide.js");
  const CSS = read("renderer/css/longtask.css");
  /* 结构断言要用「去过注释」的那份：规则里的说明文字常常自带 { }（例如 CSS 注释里举例写
     button:active { transform: translateY(1px) }），用 [^}]* 取规则体会在注释里那个 } 处截断，
     「这条规则到底写了什么」就量错了；注释类断言继续用带注释的 CSS。 */
  const CSSR = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleOf = (sel) =>
    (CSSR.match(
      new RegExp("(^|\\n)" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}"),
    ) || [""])[0];

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
  /* 迷你 DOM：够这只回归用（style / classList / 事件 / 尺寸量测 / setPointerCapture） */
  function mkEl(tag, cls) {
    const classes = new Set(String(cls || "").split(/\s+/).filter(Boolean));
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      className: cls || "",
      style: {},
      children: [],
      dataset: {},
      attrs: {},
      handlers: {},
      offsetHeight: 0,
      classList: {
        add: (c) => classes.add(String(c)),
        remove: (c) => classes.delete(String(c)),
        contains: (c) => classes.has(String(c)),
        toggle: (c, on) => (on ? classes.add(String(c)) : classes.delete(String(c))),
      },
      addEventListener(type, fn) {
        (this.handlers[type] = this.handlers[type] || []).push(fn);
      },
      removeEventListener() {},
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return this.attrs[k] == null ? null : this.attrs[k];
      },
      setPointerCapture() {},
      releasePointerCapture() {},
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      emit(type, ev) {
        for (const fn of (this.handlers[type] || []).slice()) fn(ev || {});
      },
    };
    /* 迷你元素也要「量得到自己当下的高度」：真下载入用 offsetHeight 换高时，
       inline height 一改，量出来的值立刻跟着变（本例就是拖拽以当下高度为基准那份逻辑）。 */
    let _h = 0;
    Object.defineProperty(el, "offsetHeight", {
      get() {
        const n = parseInt(String(el.style.height || ""), 10);
        return n > 0 ? n : _h;
      },
      set(v) {
        _h = Number(v) || 0;
      },
    });
    return el;
  }
  function sandboxFor(names, extra) {
    /* 常量与那个模块级高度变量（let 不会成为沙箱对象的属性，读高度走 getH） */
    const consts = LTG.slice(
      LTG.indexOf("const LTG_TA_MIN"),
      LTG.indexOf("function ltgInputApply"),
    );
    const body = { console, Math, Number, String, Object, JSON, isFinite };
    vm.createContext(body);
    vm.runInContext(consts, body);
    const sb = Object.assign(body, {
      document: { body: mkEl("body") },
      /* 窗口高度给一个足够大的值（上限 = min(520, 半屏)，这样固定上限 520 才生效） */
      window: { innerHeight: 2000 },
      isFinite,
      console,
      Math,
      Number,
      String,
      Object,
      JSON,
    });
    vm.createContext(sb);
    for (const n of names) vm.runInContext(fnBody(LTG, n), sb);
    return sb;
  }
  /* 读高度（沙箱里的 let 不挂在对象上，走 runInContext 求值） */
  function getH(sb) {
    return vm.runInContext("LTG_INPUT_H", sb);
  }

  console.log("\n[1] 布局顺序：会话消息的发送框在下方（左栏最后一格）");
  {
    ok(
      /\.ltg-left\s*\{[^}]*flex-direction:\s*column;/.test(CSS),
      ".ltg-left 是 flex 列（DOM 顺序即上下顺序）",
    );
    const mount = LTG.slice(LTG.indexOf("function ltgMount(wf) {"), LTG.indexOf("function ltgHookRepaint()"));
    const iRow = mount.indexOf("left.appendChild(row)");
    const iSplit = mount.indexOf("left.appendChild(split)");
    const iConv = mount.indexOf("left.appendChild(conv)");
    ok(iConv > 0 && iSplit > iConv, "对话区（conv）先挂，分隔条紧跟其后（消息流在上）");
    ok(iRow > iSplit, "输入行（row）挂在分隔条之后 —— 发送框在下方，不是顶部");
    ok(mount.indexOf("box.appendChild(left)") > iRow, "三者都挂在左栏里（不是别处）");
    ok(/\.ltg-split\s*\{[^}]*cursor:\s*ns-resize;/.test(CSS), "分隔条光标是上下拖（ns-resize）");
    ok(
      /\.ltg-conv\s*\{[^}]*overflow:\s*auto;/.test(CSS) && /\.ltg-conv\s*\{[^}]*min-height:\s*0;/.test(CSS),
      "对话区自己滚 + min-height:0（空间不够时让位给发送框，绝不把发送框顶出窗口）",
    );
    ok(mount.indexOf("box.appendChild(right)") > iRow, "右栏（状态 / 图摘要 / 出口）仍在左栏之后 —— 发送行不占它的位置");
  }

  console.log("\n[2] 出界根因：发送行不许越出左栏压在右栏上（用户报障那一条）");
  {
    /* 真根因（无头浏览器实测过）：inline 写 flex:none 时，textarea 以**默认内在宽（约 20 列）**
       为 flex 基准而压不下去 —— 框独占整行、发送按钮被挤出左栏，正好落在右侧那栏上
       （左栏 100..1130，按钮被算到 1138..1184，而右栏是 1140..1470）。
       两条一起钉：① inline 的 flex 必须可收缩；② 左栏自己兜 horizontal overflow。 */
    ok(
      /function ltgInputApply[\s\S]{0,400}?style\.flex = "1 1 auto"/.test(LTG),
      "ltgInputApply 写 inline flex:1 1 auto（可收缩 —— flex:none 会把发送按钮挤出左栏）",
    );
    ok(
      !/style\.flex = "none"/.test(LTG),
      "全模块没有 style.flex = \"none\" 的回潮（那正是出界根因）",
    );
    const leftRule2 = ruleOf(".ltg-left");
    ok(
      leftRule2.indexOf("overflow-x: clip") >= 0,
      ".ltg-left 兜 overflow-x:clip（横向任何情况都不越出左栏；clip 不是滚动容器，纵轴仍归 flex）",
    );
    ok(
      leftRule2.indexOf("overflow-x: hidden") < 0,
      ".ltg-left 不再用 overflow-x:hidden（hidden 会把另一轴抬成 auto = 隐形纵向滚动容器，见 [7]）",
    );
    const taCss = (CSS.match(/(^|\n)\.ltg-ta\s*\{[^}]*\}/) || [""])[0];
    ok(taCss.indexOf("flex: 1 1 auto") >= 0, "CSS 那份 .ltg-ta 也是 flex:1 1 auto（与 inline 同口径，不反压）");
    const rowCss = (CSS.match(/(^|\n)\.ltg-row\s*\{[^}]*\}/) || [""])[0];
    ok(
      rowCss.indexOf("width: 100%") >= 0 && rowCss.indexOf("min-width: 0") >= 0,
      ".ltg-row 整行占满左栏（width:100% + min-width:0，不被长内容撑破）",
    );
  }

  console.log("\n[3] 拖高：往下拖变高、上下限夹住、双击回默认（vm 真跑）");
  {
    const sb = sandboxFor(["ltgInputClamp", "ltgInputApply", "ltgSplitBind"]);
    const ta = mkEl("textarea", "ltg-ta");
    ta.offsetHeight = 108;
    const split = mkEl("div", "ltg-split");
    vm.runInContext("ltgSplitBind", sb)(split, ta);
    ok(getH(sb) === 108, "默认高度 108px（比旧版 54px 高，第一眼就够写）");
    ok(!split._ltgSplitBound === false && split.handlers.pointermove.length > 0, "分隔条已接线（pointerdown / move / up）");
    /* 按下（起点 y=400，此刻高度 108px），再往下拖 200px：输入框变高。
       方向口径：分隔条挂在输入框的**下沿**，往下拖 = 输入框变高，所以高度增量是
       「按下点到当下点的位移取反」—— 起点 y=400 拖到 y=200 就是变高 200px。 */
    split.emit("pointerdown", { button: 0, clientY: 400, pointerId: 1, preventDefault() {}, stopPropagation() {} });
    ok(split.classList.contains("dragging"), "按下即进拖动态（视觉 + 整窗光标）");
    ok(sb.document.body.classList.contains("ltg-split-drag"), "拖动中 body 带 ltg-split-drag（光标锁 ns-resize、禁选）");
    split.emit("pointermove", { clientY: 200, preventDefault() {} });
    ok(getH(sb) === 308, "往下拖 200px → 108 + 200 = 308px（拖多少长多少）");
    ok(ta.style.height === "308px" && ta.style.flex === "1 1 auto", "高度写在 inline style 上（flex:1 1 auto + px），CSS 不打架");
    ok(ta.style.width === "100%", "宽度也写在 inline style 上（可收缩的 flex 基准就是这份 100%，框铺满除「发送」外的全部宽度）");
    /* 继续往下拖：上限夹住 */
    split.emit("pointermove", { clientY: -4000, preventDefault() {} });
    ok(getH(sb) === 520, "拖过头 → 夹在上限 520px（不把消息流挤没）");
    /* 第二次按下（起点 y=600，此刻高度 = 520px，量自 inline 高度）：往上拖 80px 变矮。
       以「当下实际高度」为基准，不跳回旧值 —— 这就是拖手的那份逻辑。 */
    split.emit("pointerdown", { button: 0, clientY: 600, pointerId: 3, preventDefault() {}, stopPropagation() {} });
    split.emit("pointermove", { clientY: 680, preventDefault() {} });
    ok(getH(sb) === 440, "往上拖 80px → 520 − 80 = 440px（以当下高度为基准，不跳回旧值）");
    split.emit("pointermove", { clientY: 1000, preventDefault() {} });
    ok(getH(sb) === 120, "再往上拖 400px → 520 − 400 = 120px（这一段还没到下限）");
    split.emit("pointermove", { clientY: 1200, preventDefault() {} });
    ok(getH(sb) === 72, "继续往上拖 200px → 算出来低于下限 → 夹在 72px（绝不把框压没）");
    split.emit("pointermove", { clientY: 1800, preventDefault() {} });
    ok(getH(sb) === 72, "下限之下再往上拖仍是 72px（不抖、不归零）");
    /* 松手：退出拖动态 */
    split.emit("pointerup", { pointerId: 3 });
    ok(!split.classList.contains("dragging") && !sb.document.body.classList.contains("ltg-split-drag"), "松手退出拖动态（光标 / 禁选还原）");
    split.emit("pointermove", { clientY: 100, preventDefault() {} });
    ok(getH(sb) === 72, "松手后再移动指针不再改高度（不误触）");
    /* 双击回默认 */
    split.emit("dblclick", { preventDefault() {} });
    ok(getH(sb) === 108, "双击分隔条回到默认高度 108px");
    ok(ta.style.height === "108px", "回默认也落到 inline style 上");
    /* 右键 / 非主键不进入拖动 */
    split.emit("pointerdown", { button: 2, clientY: 100, pointerId: 9 });
    ok(!split.classList.contains("dragging"), "右键按下不进拖动态（只认主键）");
  }

  console.log("\n[4] 清空会话：开窗一律全新会话（不接回上一条引导会话）");
  {
    const mount = LTG.slice(LTG.indexOf("function ltgMount(wf) {"), LTG.indexOf("function ltgHookRepaint()"));
    ok(mount.indexOf("ltgFindSession(") < 0, "ltgMount 不再调用 ltgFindSession（不认领旧会话）");
    ok(mount.indexOf('sid: "",') > 0, "LTG.sid 起始为空 = 空对话开窗");
    ok(mount.indexOf("ltgPaint(null)") > 0, "开窗按「没有会话」重绘（消息流为空态，不是上一条的尾巴）");
    ok(mount.indexOf("ltgCreateAgentSet") < 0, "不再用旧会话的选型回填（选型只认「Agent 选型」那一栏）");
    ok(LTG.indexOf("function ltgFindSession(wf)") > 0, "判据函数本身还在（契约标记认领仍可复用，只是本窗不再调用）");
    ok(
      LTG.indexOf("本窗每次打开都是一条全新会话（不继承上一条引导会话的上下文）") > 0,
      "契约写明「全新会话」（模型不会自称接着上次聊）",
    );
    ok(LTG.indexOf("const LTG_FRESH_NOTE") > 0 && LTG.indexOf("LTG_FRESH_NOTE +") > 0, "契约正文引用了这条说明（单一真源）");
    ok(LTG.indexOf("每次打开本窗都是全新会话") > 0, "右侧说明向用户讲清：本窗不接回、旧会话留左侧栏作历史");
    ok(LTG.indexOf("这条引导会话留在左侧栏只作历史") > 0, "「稍后」出口的文案同步（不再说「下次打开接着聊」）");
  }

  console.log("\n[5] 样式：输入框高度只由 inline 表达（CSS 不设死 height / max-height）");
  {
    const ta = (CSS.match(/(^|\n)\.ltg-ta\s*\{[^}]*\}/) || [""])[0];
    ok(ta.indexOf("min-height") >= 0, ".ltg-ta 兜一个下限（inline 高度还没落上的那一帧不被压没）");
    ok(ta.indexOf("max-height") < 0, ".ltg-ta 不写 max-height（拖高的结果由 inline 说了算，不会被 CSS 反压回去）");
    ok(ta.indexOf("resize: none") >= 0, "resize:none —— 上面那条 .ltg-split 是唯一拖高入口");
    ok(CSS.indexOf(".ltg-ta") === CSS.lastIndexOf(".ltg-ta") || CSS.split(".ltg-ta {").length === 2, "旧的一份 .ltg-ta 规则已删净（不留后一份反压）");
    /* 宽度：输入框要铺满左栏（用户报障「输入框未占满宽度」）—— inline 与 CSS 各兜一份同值 */
    ok(ta.indexOf("width: 100%") >= 0, ".ltg-ta 写 width:100%（inline 缺席的那一帧仍有宽度）");
    ok(/function ltgInputApply[\s\S]{0,400}?style\.width = "100%"/.test(LTG), "ltgInputApply 同时写宽度 100%（与高度同一处，拖高 / 开窗都走它）");
  }

  console.log("\n[6] 本次修复：会话区滚动条槽恒定预留（点发送瞬间不再冒出一条滚动条）");
  {
    /* 用户报障：长任务新建窗里，消息框点「发送」的那一瞬间，右侧会冒出一条滚动条。
       实测根因（真跑应用 + 逐帧量 offsetWidth-clientWidth）：空窗时消息流装得下、
       一条滚动条都没有；发出第一条消息后内容一高，.ltg-conv 的 12px 竖直滚动条**第一次**
       出现 —— 正好压在那只发送按钮的右侧，同时还把消息挤窄 10px（内容宽度抖动）。
       口径：滚动条槽恒定预留（与 .n-prompt / .fp-scroll 同款）；不隐藏滚动条本身。 */
    const conv = (CSS.match(/(^|\n)\.ltg-conv\s*\{[^}]*\}/) || [""])[0];
    ok(conv.indexOf("scrollbar-gutter: stable") >= 0, ".ltg-conv 恒定预留滚动条槽（出不出滚动条内容宽度都一样）");
    ok(conv.indexOf("overflow: auto") >= 0, "滚动条本身不隐藏：消息多了照样能滚（只是不再突变出现）");
    const right = (CSS.match(/(^|\n)\.ltg-right\s*\{[^}]*\}/) || [""])[0];
    ok(right.indexOf("scrollbar-gutter: stable") >= 0, ".ltg-right 同一口径（图摘要 / 提示长出来时宽度不抖）");
    ok(
      /点发送/.test(CSS.slice(CSS.indexOf(".ltg-conv {"), CSS.indexOf(".ltg-conv {") + 700)),
      "CSS 注释写明这条是为「点发送瞬间冒滚动条」修的（后来人不会当噪音删掉）",
    );
  }

  console.log("\n[7] 本次修复：按下发送键的那一帧不再冒出滚动条（左栏不是隐式滚动容器）");
  {
    /* 用户报障（[6] 修完仍在，即本条）：鼠标**按下**发送键的一瞬间，右侧出现一条滚动条。
       真跑应用 + CDP 在 mousePressed 那一帧量到（修复前）：
         .ltg-left clientWidth 1028 → 1018（多出 10px 竖直滚动条）、scrollHeight 507 → 508；
         .ltg-row scrollHeight 108 → 109；按下按钮 computed transform = translateY(1px)。
       根因链 = 全局 button:active 的 1px 按下位移 × 左栏被 CSS 规范抬成纵向滚动容器：
         ① 全局 `button:active { transform: translateY(1px) }`（css/layout.css）让发送按钮
            ——左栏最后一格——的下沿在按下那一帧多出 1px；
         ② `.ltg-left` 原先写 overflow-x:hidden，而「一轴 hidden ⇒ 另一轴的 visible 变 auto」
            让它成了纵向滚动容器 → 那 1px 就够它出滚动条（10px 宽，紧贴发送按钮右缘）。
       口径：左栏写成 overflow-x:clip（不是滚动容器）+ 留 1px 下内边距（按下位移落进这一格，
       按钮下沿不再被裁）。修复后同一探针：按下那一帧 .ltg-left 1028/1028、sh=ch=507、
       按钮下沿正好落在余量里（越出 0），窗内无任何元素新增滚动条。
       滚动条本身没有被隐藏：消息多时仍由 .ltg-conv 自己滚（[6] 的滚动条槽照旧）。 */
    const left = ruleOf(".ltg-left");
    ok(left.indexOf("overflow-x: clip") >= 0, ".ltg-left overflow-x:clip —— 横轴裁住但不成为滚动容器");
    ok(left.indexOf("overflow-y") < 0, ".ltg-left 不写 overflow-y（纵轴保持 visible，任何 1px 生长都不出滚动条）");
    ok(
      left.indexOf("padding-bottom: 1px") >= 0,
      "左栏留 1px 下内边距 —— 按下那 1px 落进这一格（不越界、也不被 clip 裁掉按钮下沿）",
    );
    /* 注释里的根因（带注释的那份 CSS） */
    const leftDoc = CSS.slice(CSS.indexOf(".ltg-left {"), CSS.indexOf(".ltg-left {") + 1200);
    ok(
      /button:active/.test(leftDoc) && /translateY\(1px\)/.test(leftDoc),
      "CSS 注释写明按下位移这条真根因（后来人不会把它当噪音删掉）",
    );
    ok(leftDoc.indexOf("鼠标按下瞬间") >= 0, "CSS 注释写明这条是为「点发送、鼠标按下瞬间冒滚动条」修的");
    /* 1px 生长源确实还在全局样式里：这条修复不是为一条已经消失的规则留的 */
    const LAYOUT = read("renderer/css/layout.css");
    ok(
      /button:active\s*\{[^}]*transform:\s*translateY\(1px\)/.test(LAYOUT),
      "全局 button:active 的 translateY(1px) 仍在（css/layout.css）—— 左栏必须自己扛住这 1px",
    );
    /* 别用「删掉按下位移」绕开：发送键的按下反馈要保留 */
    ok(
      !/\.ltg[\s\S]{0,200}?:active\s*\{[^}]*transform:\s*none/.test(CSS),
      "没有用「删掉按下位移」绕（发送键的按下反馈保留）",
    );
    const conv = (CSS.match(/(^|\n)\.ltg-conv\s*\{[^}]*\}/) || [""])[0];
    ok(conv.indexOf("scrollbar-gutter: stable") >= 0, "[6] 的会话区滚动条槽没被这次修复撤掉（消息多了照样能滚）");
  }

  console.log(
    fails
      ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-guide-layout)"
      : "\n✓ " + checks + " 项全部通过  (smoke-longtask-guide-layout)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-guide-layout.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-guide-layout.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-longtask-deliver-draft.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-deliver-draft.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
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
  const eqStr = (a, b, msg) => ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
  const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

  const LTV = read("renderer/app-longtask.js");
  const LTU = read("renderer/app-longtask-ui.js");

  /* 取一个函数的正文：从 `function 名(` 起到**下一个顶层 `function` 声明**（列 0 起）之前。
     不比括号 —— 函数体里带注释 / 模板串 / 正则，逐字符数括号容易提前收口（本文件踩过）。 */
  function fnBody(src, name) {
    const at = src.indexOf("\nfunction " + name + "(");
    if (at < 0) throw new Error("找不到函数：" + name);
    const next = src.indexOf("\nfunction ", at + 1);
    return src.slice(at + 1, next < 0 ? src.length : next);
  }

  /* ── 迷你 DOM：够 ltChecklistEditor / ltItemInput 真跑（value / 事件 / 属性 / 尺寸） ── */
  function mkEl(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      className: "",
      value: "",
      checked: false,
      disabled: false,
      rows: 0,
      placeholder: "",
      title: "",
      type: "",
      name: "",
      textContent: "",
      style: {},
      children: [],
      parentNode: null,
      attrs: {},
      handlers: {},
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return this.attrs[k] == null ? null : this.attrs[k];
      },
      addEventListener(t, f) {
        (this.handlers[t] = this.handlers[t] || []).push(f);
      },
      removeEventListener() {},
      appendChild(c) {
        this.children.push(c);
        if (c) c.parentNode = this;
        return c;
      },
      insertBefore(c) {
        this.children.push(c);
        if (c) c.parentNode = this;
        return c;
      },
      contains(t) {
        let p = t;
        while (p) {
          if (p === this) return true;
          p = p.parentNode;
        }
        return false;
      },
      focus() {},
      closest() {
        return null;
      },
      getBoundingClientRect() {
        return { width: 300, height: 66, left: 0, top: 0, right: 300, bottom: 66 };
      },
      setPointerCapture() {},
      /* 真事件派发：既叫 addEventListener 的监听，也叫 onXxx 属性处理器（原生两条路都走）；
       ev.target 必须是自己（原生就是它，提交时按「哪一格触发的」认草稿要靠它） */
      emit(t, ev) {
        const e = Object.assign({ type: t, target: this }, ev || {});
        for (const f of (this.handlers[t] || []).slice()) f(e);
        const p = this["on" + t];
        if (typeof p === "function") p(e);
      },
    };
    el.classList = { contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0 };
    return el;
  }
  function makeSandbox() {
    const sandbox = {
      window: { api: {} },
      S: { wf: null, config: {} },
      I18n: { t: (s) => s },
      document: {
        readyState: "loading",
        addEventListener() {},
        removeEventListener() {},
        getElementById() {
          return null;
        },
        createElement: (tag) => mkEl(tag),
        activeElement: null,
        body: mkEl("body"),
        getSelection: () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null, focusNode: null }),
      },
      toast() {},
      scheduleSave() {},
      renderCanvas() {},
      focusNode() {},
      addNode() {
        return null;
      },
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
      isFinite,
      parseFloat,
      parseInt,
    };
    vm.createContext(sandbox);
    vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
    vm.runInContext(LTU, sandbox, { filename: "renderer/app-longtask-ui.js" });
    return sandbox;
  }
  function walk(el, fn) {
    if (!el || !el.children) return;
    for (const c of el.children) {
      fn(c);
      walk(c, fn);
    }
  }
  function findAll(root, tag) {
    const out = [];
    walk(root, (c) => {
      if (c.tagName === tag) out.push(c);
    });
    return out;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ═══════════════ [1] 机制就位 ═══════════════ */
  console.log("\n[1] 机制就位（renderer/app-longtask-ui.js）");
  {
    has(LTU, "function ltItemDraftKey(path, it, field) {", "有条目草稿键 ltItemDraftKey（环节路径 + 条目 id + 字段名）");
    has(LTU, '":it:"', "草稿键带 it: 段：与检查器字段（goal / why / relnote）不串台");
    has(LTU, 'return ltDraftKey(String(path || "") + ":it:" + String((it && it.id) || ""), field);', "键口径写明：路径 + 条目 id + 字段名（同一条 run 逐帧稳定）");
    const guard = fnBody(LTU, "ltChecklistEditor");
    has(guard, "ltDraftBind(el, k);", "每格走 ltDraftBind（还原草稿 + 输入即写）");
    has(guard, "ltScrollBind(el, k);", "每格同时按同一个键记滚动位置（重绘后停在原处）");
    has(guard, "draftKeys.push(k);", "本帧的草稿键登记成一列（提交成功后清）");
    has(guard, "if (!el || !k) return el;", "guard 对空控件 / 认不出身份的格不动手（宁可这次不保，也不乱记）");
    has(guard, 'guard(title, it, "title")', "文件名 / 标题那一格挂草稿保护");
    has(guard, 'guard(desc, it, "desc")', "内容说明那一格挂草稿保护");
    has(guard, ", guard);", "调用点把 guard 传给 ltItemInput（第 8 个参数）");
    ok(
      /function ltItemInput\(parent, it, commit, path, uid, editing, isDeliver, guardIn\) \{/.test(LTU),
      "ltItemInput 的 guardIn 挂在末位（老调用处只传 7 个参数，行为一字不变）",
    );
    const itemInput = LTU.slice(LTU.indexOf("function ltItemInput("), LTU.indexOf("function ltNodeFilePaths("));
    has(itemInput, 'typeof guardIn === "function" ? (el, field) => guardIn(el, it, field) : () => {}', "没传 guard 时退化成空动作（不抛错）");
    has(itemInput, 'guard(ta, "value")', "文本条目在真渲染路径上也挂了保护");
    has(LTU, "ltTaHBind(note, key);", "交付说明框（放行确认窗）也按草稿键记高度（与审批理由框同源）");
  }

  /* ═══════════════ [2] 提交即三份写同源 ═══════════════ */
  console.log("\n[2] 提交即三份写同源、写同步（缺一份就会被画布同步链拿旧的盖回来）");
  {
    const body = fnBody(LTU, "ltChecklistEditor");
    has(body, "node.cfg.items = items;", "图定义 cfg.items 指回本帧同一份清单（对象不换新的）");
    has(body, "st.items = items;", "运行态快照 st.items 指回同一份（卡片渲染读它）");
    has(body, "const dn = ltDeliverNodeOf(node.cfg.uid);", "按交付 uid 找到画布上那颗交付节点");
    has(body, "if (dn) dn.ltItems = items;", "画布节点的 ltItems 指回同一份（同步链的权威那一份）");
    has(body, "for (const k of draftKeys) ltDraftClear(k);", "提交成功后清本帧草稿（旧字不会跟着下一条漂）");
    ok(
      body.indexOf("draftKeys") < body.indexOf("ltRenderStrip();"),
      "清草稿排在重绘之前（这一帧长出来的控件才不会带着旧草稿）",
    );
    /* 来源口径与画布侧同步链同源：对照 app-longtask.js 的权威顺序一眼看得出是哪一份 */
    has(LTV, "if (st) st.items = JSON.parse(JSON.stringify(items));", "画布侧同步链（ltDeliverSyncFromNode）读的就是节点上的 ltItems");
    has(LTV, "const items = JSON.parse(JSON.stringify(ltArr(node && node.ltItems)));", "同步链的权威那一份 = 节点 ltItems（所以它必须是最新的）");
  }

  /* ═══════════════ [3][4][5] 真跑 ltChecklistEditor ═══════════════ */
  async function main() {
    console.log("\n[3] 真跑：打字 → change → 三份同源；画布同步推回旧清单后字仍在");
    const sandbox = makeSandbox();
    vm.runInContext(
      `
      window.__items = [
        { id: "i1", kind: "text", title: "风格说明", required: true, done: false, value: "" },
        { id: "i2", kind: "file", file: "分镜表.md", desc: "每镜头一行", required: true, done: false, paths: [] }
      ];
      window.__node = { id: "n_h", kind: "human", title: "交稿", cfg: { mode: "deliver", uid: "ltx-交稿", items: window.__items } };
      window.__rn = { path: "h", status: "waiting", uid: "ltx-交稿", items: window.__items, dir: "" };
      window.__runObj = { runId: "r1", ns: {}, graph: { nodes: [window.__node], edges: [] }, nodes: { h: window.__rn }, waits: [], status: "waiting" };
      window.__wf = { id: "wf1", longtask: { tasks: [{ uid: "t1", ver: 1, graph: { nodes: [window.__node], edges: [] } }], active: "t1" } };
      /* 画布上那颗交付节点：ltItems 是它自己那一份（真实里由 ltEnsureDeliverNode 从 cfg.items 拷来，之后各走各的） */
      window.__dn = { id: "n_dn", kind: "deliver", ltUid: "ltx-交稿", ltItems: JSON.parse(JSON.stringify(window.__items)), ltDir: "" };
      ltCurrentRun = () => window.__runObj;
      ltDeliverNodeOf = () => window.__dn;
      ltDeliverWrite = async () => "";
      ltSave = () => {};
      ltRenderStrip = () => { window.__renders = (window.__renders || 0) + 1; };
      window.__card = () => {
        const parent = document.createElement("div");
        return ltChecklistEditor(parent, window.__wf, { uid: "t1", ver: 1, graph: { nodes: [window.__node], edges: [] } }, window.__node, window.__node.cfg.items, false, "h");
      };
    `,
      sandbox,
      { filename: "lt-deliver-draft-probe" },
    );
    const inCtx = (code) => vm.runInContext(code, sandbox);
    const card = () => inCtx("window.__card()");

    const first = card();
    const ta = findAll(first, "TEXTAREA")[0];
    ok(!!ta, "交付卡渲染出文本条目的输入框");
    ok(typeof (ta && ta.oninput) === "function", "输入框挂上了草稿记录（oninput 写草稿，不靠 change / blur）");
    ta.value = "整体冷色调，夜戏为主";
    ta.emit("input", {});
    ta.emit("change", {});
    await sleep(25); /* change 的收尾里有 await（commit 会写交付目录） */

    const three = inCtx(
      `({ v: window.__items[0].value, rv: window.__rn.items[0].value, cv: window.__node.cfg.items[0].value, dv: window.__dn.ltItems[0].value, renders: window.__renders || 0 })`,
    );
    eqNum(three.renders, 1, "提交触发了一次条带重绘（ltRenderStrip 被叫到）");
    eqStr(three.v, "整体冷色调，夜戏为主", "条目自己那一份拿到用户写的字");
    eqStr(three.rv, "整体冷色调，夜戏为主", "运行态快照 st.items（卡片渲染读的那一份）拿到");
    eqStr(three.cv, "整体冷色调，夜戏为主", "图定义 cfg.items（下次启用 / 重跑读的那一份）拿到");
    eqStr(three.dv, "整体冷色调，夜戏为主", "**画布交付节点 ltItems 也拿到**（同步链的权威那一份不再是旧的）");

    /* 模拟画布侧同步链：以节点上的清单为准，整份推回运行态与图定义（老版本就是这一步把字顶掉） */
    inCtx(`
      (function () {
        const items = JSON.parse(JSON.stringify(window.__dn.ltItems));
        window.__rn.items = JSON.parse(JSON.stringify(items));
        window.__node.cfg.items = JSON.parse(JSON.stringify(items));
      })();
    `);
    const after = card();
    const ta2 = findAll(after, "TEXTAREA")[0];
    eqStr(ta2 && ta2.value, "整体冷色调，夜戏为主", "画布同步链走一轮之后，新长出来的输入框里那段字仍在（本次 bug 的验收口径）");

    console.log("\n[4] 兜底那一路也真跑：未提交就重绘 → 按草稿键还原");
    inCtx(`window.__items[0].value = ""; window.__rn.items[0].value = ""; window.__node.cfg.items[0].value = ""; window.__dn.ltItems[0].value = "";`);
    const d1 = card();
    const taD = findAll(d1, "TEXTAREA")[0];
    taD.value = "还没提交的一段字";
    taD.emit("input", {}); /* 只打字，不 change / 不失焦：真实里这就是「正在写」的那一段 */
    const d2 = card(); /* 长任务 ~90ms 一次的重绘（或画布同步）把这一帧的 DOM 换掉 */
    const taE = findAll(d2, "TEXTAREA")[0];
    eqStr(taE && taE.value, "还没提交的一段字", "未提交就重绘：新框按草稿键还原（不靠提交链也不丢字）");

    console.log("\n[5] 文件名 / 内容说明两格同样吃保护；提交过的草稿会清");
    const titleIn = findAll(d2, "INPUT").filter((i) => String(i.className).indexOf("lt-in-title") >= 0)[1];
    const descIn = findAll(d2, "INPUT").filter((i) => String(i.className).indexOf("lt-in-desc") >= 0)[0];
    ok(!!titleIn, "找到文件条目的文件名输入框");
    ok(!!descIn, "找到文件条目的内容说明输入框");
    ok(typeof (titleIn && titleIn.oninput) === "function", "文件名格也挂草稿记录");
    ok(typeof (descIn && descIn.oninput) === "function", "内容说明格也挂草稿记录");
    titleIn.value = "成片-竖屏.mp4";
    titleIn.emit("input", {});
    titleIn.emit("change", {});
    await sleep(25);
    const f = inCtx(`({ f: window.__rn.items[1].file, dv: window.__dn.ltItems[1].file, rv: window.__rn.items[1].file, cv: window.__node.cfg.items[1].file, renders: window.__renders || 0 })`);
    eqStr(f.f, "成片-竖屏.mp4", "文件名改动提交到条目上（与老行为一致）");
    eqStr(f.dv, "成片-竖屏.mp4", "文件名改动同样同步到画布交付节点（三份同源）");
    eqNum(f.renders, 2, "第二次提交又触发一次重绘");

    /* 提交成功 = 草稿清掉：下一次重绘不该再拿旧草稿把条目里的新值盖回去 */
    inCtx(`window.__items[1].file = "定稿-横屏.mp4"; window.__dn.ltItems[1].file = "定稿-横屏.mp4"; window.__rn.items[1].file = "定稿-横屏.mp4"; window.__node.cfg.items[1].file = "定稿-横屏.mp4";`);
    const g = card();
    const titleG = findAll(g, "INPUT").filter((i) => String(i.className).indexOf("lt-in-title") >= 0)[1];
    eqStr(titleG && titleG.value, "定稿-横屏.mp4", "提交过的草稿被清：条目改了名字，重绘跟着显示新名字（旧草稿不会把值顶回去）");

    /* 文本条目那一格：上一轮那条未提交的草稿还在（用户自己没提交）→ 仍按草稿还原，这是设计口径 */
    const taG = findAll(g, "TEXTAREA")[0];
    eqStr(taG && taG.value, "还没提交的一段字", "未提交的那格草稿照旧留着（只增不减，提交才清）");

    console.log(
      "\n" +
        (fails
          ? "✗ " + fails + " / " + checks + " 项失败  (smoke-longtask-deliver-draft)"
          : "✓ " + checks + " 项全部通过  (smoke-longtask-deliver-draft)"),
    );
  }

  main().catch((e) => {
    console.log("测试异常：" + String((e && e.stack) || e));
  });
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-deliver-draft.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-deliver-draft.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-longtask-textarea-height.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-textarea-height.js";
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
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n/g, "\n");

  const LTU = read("renderer/app-longtask-ui.js");
  const CSS = read("renderer/css/longtask.css");

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
  /* 迷你 DOM：够这只回归用（style / 事件 / 尺寸量测 / setPointerCapture） */
  function mkEl(tag, cls) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "textarea").toUpperCase(),
      className: cls || "",
      value: "",
      style: {},
      children: [],
      parentNode: null,
      dataset: {},
      attrs: {},
      handlers: {},
      rect: { width: 300, height: 0, right: 400, bottom: 0, top: 0, left: 100 },
      addEventListener(type, fn) {
        (this.handlers[type] = this.handlers[type] || []).push(fn);
      },
      removeEventListener() {},
      getAttribute(k) {
        return this.attrs[k] == null ? null : this.attrs[k];
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getBoundingClientRect() {
        return Object.assign({}, this.rect);
      },
      setPointerCapture() {},
      appendChild(c) {
        this.children.push(c);
        if (c) c.parentNode = this;
        return c;
      },
      emit(type, ev) {
        for (const fn of (this.handlers[type] || []).slice()) fn(ev || {});
      },
    };
    return el;
  }
  function sandboxFor(names, extra) {
    const mapExpr = (LTU.match(/const LT_TA_H = ([^;]+);/) || [])[1] || "null";
    const sb = Object.assign(
      { console, Array, Object, String, Number, Date, Math, JSON, isFinite, parseFloat, parseInt },
      { LT_TA_H: vm.runInNewContext(mapExpr, {}) },
      extra || {},
    );
    vm.createContext(sb);
    for (const n of names) vm.runInContext(fnBody(LTU, n), sb);
    return sb;
  }
  /* 把「量到的身高」摆到这只迷你框上（getBoundingClientRect 只读 rect） */
  function setH(el, h) {
    el.rect.height = h;
    el.rect.bottom = el.rect.top + h;
  }

  console.log("\n[1] 机制就位（renderer/app-longtask-ui.js）");
  {
    ok(/const LT_TA_H = Object\.create\(null\);/.test(LTU), "有一张「手动拖高」高度表 LT_TA_H");
    for (const n of ["ltTaH", "ltTaHNow", "ltTaHSet", "ltTaHApply", "ltTaHBind"])
      ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有 " + n);
    ok(
      fnBody(LTU, "ltInput").indexOf("ltTaHApply(i, hkey)") > 0 &&
        fnBody(LTU, "ltInput").indexOf("ltTaHBind(i, hkey)") > 0,
      "ltInput 建多行框时先按 key 还原高度、再接上拖高捕获（type = \"area\" 才走）",
    );
    const insp = fnBody(LTU, "ltNodeInspector");
    ok(
      insp.indexOf('ltT("目标 / 说明")') > 0 && insp.indexOf('"area", null, ltDraftKey(path, "goal")') > 0,
      "环节检查器的「目标 / 说明」把 hkey 传给了 ltInput（key = 环节 path + 字段名，第 7 参）",
    );
    ok(
      fnBody(LTU, "ltHumanCard").indexOf("ltTaHBind(why, whyKey)") > 0,
      "审批卡的意见 / 理由框也按同一个草稿键记高度（相当长的多行框，同样不许回弹）",
    );
    ok(
      /textarea\.lt-in\s*\{[^}]*min-height:\s*var\(--lt-ta-h,\s*\d+px\);/.test(CSS),
      "多行框默认高度走 CSS（textarea.lt-in 的 min-height: var(--lt-ta-h, …)）——只设下限，拖高仍是原生行为",
    );
    ok(
      /\.lt-in\s*\{[^}]*resize:\s*vertical;/.test(CSS),
      "resize: vertical 仍在（右下角手柄本来就是给用户拖的，本需求是让拖出来的高度留得住）",
    );
  }

  console.log("\n[2] key 口径：与草稿表同源（vm 真跑）");
  {
    const sb = sandboxFor(["ltTaH"]);
    sb.LT_TA_H["/n_a1:goal"] = 182.4;
    ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 182, "记下 182px 意味着同一个格读到 182px（四舍五入到整数）");
    ok(vm.runInContext('ltTaH("/n_a1:title")', sb) === 0, "同一个环节的别的字段读不到这一份（不串台）");
    ok(vm.runInContext('ltTaH("")', sb) === 0 && vm.runInContext("ltTaH()", sb) === 0, "空 key / 不传 key → 0（没记过），不报错");
    sb.LT_TA_H["/n_a1:goal"] = -5;
    ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 0, "脏值（负数）当没记过，不把框压没");
  }

  console.log("\n[3] 只在右下角（原生缩放手柄）上记账，框内点按不打扰（vm 真跑）");
  {
    const sb = sandboxFor(["ltTaH", "ltTaHNow", "ltTaHSet", "ltTaHBind"]);
    const ta = mkEl("textarea", "lt-in");
    ta.rect = { width: 300, height: 66, left: 100, top: 200, right: 400, bottom: 266 };
    setH(ta, 66);
    vm.runInContext("ltTaHBind", sb)(ta, "/n_a1:goal");
    ok(ta.getAttribute("data-lt-hk") === "/n_a1:goal", "key 挂到 data-lt-hk 上（迷你运行 / 事后复核都认得出）");
    /* 框内中部点按（选文字 / 改写）→ 抬起不记账 */
    ta.emit("pointerdown", { clientX: 250, clientY: 230, pointerId: 1 });
    setH(ta, 90);
    ta.emit("pointerup", { clientX: 250, clientY: 230 });
    ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 0, "框中间按下再抬起（只是点选 / 改写）→ 不记高度，原生交互一字不变");
    /* 右下角按下（= 拖手柄）→ 抬起按当下实际高度记账（第一次抬手后右下角已跟着长高） */
    setH(ta, 90);
    ta.emit("pointerdown", { clientX: 399, clientY: 289, pointerId: 2 });
    setH(ta, 184);
    ta.emit("pointerup", { clientX: 399, clientY: 365 });
    ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 184, "右下角按下拖高后抬起 → 记下 184px（拖到多高就记多高）");
    /* 键盘 / 无指针路径：失焦也记一次 */
    setH(ta, 120);
    ta.emit("blur", {});
    ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 120, "不走指针的路径（失焦）也记一次：高度没变也照记，值就是用户当下定的一份");
  }

  console.log("\n[4] 真跑：记下的高度活过右栏重建（拖高不再回弹）");
  {
    const sb = sandboxFor(["ltTaH", "ltTaHNow", "ltTaHSet", "ltTaHApply", "ltTaHBind"]);
    const KEY = "/n_a1:goal";
    vm.runInContext("ltTaHBind", sb)(mkEl("textarea", "lt-in"), KEY);
    /* 第一帧：用户把「目标 / 说明」拖到 208px */
    const first = mkEl("textarea", "lt-in");
    vm.runInContext("ltTaHBind", sb)(first, KEY);
    first.rect.right = 400;
    first.rect.bottom = 266;
    setH(first, 208);
    first.emit("pointerdown", { clientX: 399, clientY: 265, pointerId: 3 });
    first.emit("pointerup", { clientX: 399, clientY: 365 });
    /* 第二帧：右栏被 ltRenderStrip 整块重建 —— 新框是干净的一只（没有 inline 高度） */
    const rebuilt = mkEl("textarea", "lt-in");
    ok(!rebuilt.style.height, "重建出来的新框一开始没有 inline 高度（旧版就是这一步把高度丢了）");
    vm.runInContext("ltTaHApply", sb)(rebuilt, KEY);
    ok(rebuilt.style.height === "208px", "按 key 还原：重建后的框拿回 208px（用户拖出来的那一份）");
    vm.runInContext("ltTaHBind", sb)(rebuilt, KEY); /* 真实路径里 ltInput 还原之后紧跟这一句 */
    /* 别的环节 / 别的字段不会被上一格的高度串到 */
    const other = mkEl("textarea", "lt-in");
    vm.runInContext("ltTaHApply", sb)(other, "/n_a2:goal");
    ok(!other.style.height, "另一个环节的同一格没有记录 → 不贴高度（各记各的）");
    /* 高度表只增不减：与草稿表同一口径，重建不改写已有记录 */
    setH(rebuilt, 240);
    rebuilt.emit("pointerdown", { clientX: 399, clientY: 439, pointerId: 4 });
    rebuilt.emit("pointerup", { clientX: 399, clientY: 439 });
    ok(vm.runInContext('ltTaH("/n_a1:goal")', sb) === 240, "用户又拖一次 → 覆盖成新的高度（不是追加第二条记录）");
  }

  console.log("\n[5] 边界：量不到尺寸的迷你环境不报错、不写脏值");
  {
    const sb = sandboxFor(["ltTaH", "ltTaHNow", "ltTaHSet", "ltTaHApply", "ltTaHBind"]);
    const noRect = mkEl("textarea", "lt-in");
    noRect.getBoundingClientRect = undefined;
    noRect.offsetHeight = 0;
    ok(vm.runInContext("ltTaHNow", sb)(noRect) === 0 && vm.runInContext("ltTaHNow", sb)(null) === 0, "量不到尺寸（迷你 DOM / 尚未挂载）→ 0，不抛异常");
    ok(vm.runInContext("ltTaHSet", sb)(noRect, "/x:goal") === 0, "量不到就不记账（不会把 0 写成高度把框压没）");
    ok(vm.runInContext('ltTaH("/x:goal")', sb) === 0, "表里确实没写进脏值");
    const plain = { tagName: "TEXTAREA" };
    ok(vm.runInContext("ltTaHApply", sb)(plain, "/x:goal") === plain, "没有 style 的老运行时不报错，原样返回");
    ok(vm.runInContext("ltTaHBind", sb)(null, "/x:goal") === null, "空元素 / 空 key 直接原样返回（调用处不必先判）");
  }

  console.log(
    fails
      ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-textarea-height)"
      : "\n✓ " + checks + " 项全部通过  (smoke-longtask-textarea-height)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-textarea-height.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-textarea-height.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

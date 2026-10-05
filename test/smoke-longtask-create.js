"use strict";
/**
 * test/smoke-longtask-create.js —— 长周期任务：对话框 + Agent 引导自动创建
 *
 * 这一轮把「新建长任务」从「三处直连 ltNewTask 塞空白模板」改成：
 *   入口 → openLtCreateDlg（近全屏持久化对话框）→ 窗内 Agent 引导拷问 →
 *   mtnode_app 的 create_longtask 落库 → 条带上「启用并绑定」；
 *   唯一的手动出口只留在对话框右上角。
 *
 * 断言按层排，任一层掉链子都会变成「按钮点了没反应 / 图看着有其实没落库」：
 *   [1] 三处入口改造：不再直连 ltNewTask，统一 openLtCreateDlg
 *   [2] 对话框骨架：持久化浮层 / 近全屏 / 右下拖调（最小宽 ≥50%）/ 唯一「手动新建」/ Esc
 *   [2b] 取消出口 / 关窗保留内容 / 创建时 Agent 选型
 *   [2c] 创建即显示（本轮需求）：ltTaskReveal 挂在两条创建路径上、展开态记到所属画布、
 *        后台画布不硬展开、enabled 仍 false 且不调 ltEnable（只显示不开跑）
 *   [3] 窗内 Agent 引导：契约（mtnode-grill-me + ask_user_question + create_longtask）
 *       + 契约会话装配（标题锁死 / 绑本画布 / 允许读画布）+ 回执落地 + 三个出口
 *   [4] 网关与分发：create_longtask 的 enum / APP_DESC 卡口 / graph 参数；
 *       app-nodes 分发 + app_ops 工具 + 规划模式拒绝
 *   [5] 引擎真行为（vm 里跑）：LT.createFromGraph 的归一 / 校验拒绝 / 落库字段
 *   [6] 装配与文案：index.html 脚本顺序 / longtask.css / i18n 中英词条
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
const countOf = (hay, needle) => String(hay).split(needle).length - 1;
/* 出现顺序：na 必须排在 nb 之前（-1 = 没出现 = 判失败），用于钉「谁在上、谁在下」 */
const orderOf = (hay, na, nb, msg) => {
  const a = String(hay).indexOf(na);
  const b = String(hay).indexOf(nb);
  ok(a >= 0 && b >= 0 && a < b, msg + (a >= 0 && b >= 0 ? "" : "（没找到 " + (a < 0 ? na : nb) + "）"));
};

const LTC = read("renderer/app-longtask-create.js");
const LTG = read("renderer/app-longtask-guide.js");
const LTU = read("renderer/app-longtask-ui.js");
const LTV = read("renderer/app-longtask.js");
const NODES = read("renderer/app-nodes.js");
const ASSIST = read("renderer/app-assist.js");
const HTML = read("renderer/index.html");
const CSS = read("renderer/css/longtask.css");
const I18N = read("renderer/i18n.js");
const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");
const PLANJS = read("renderer/app-plan.js");
const BOOT = read("renderer/app-boot.js");

/* ═══════════════ [1] 四处入口改造 ═══════════════ */
console.log("\n[1] 入口：四处「＋ 创建长任务」都开对话框，不再直连 ltNewTask");
{
  /* 第四处 = 面包屑根条目那份任务清单的末项（app-longtask-ui.js ltCrumbTaskBtn，本次需求：
     根条目写当前长任务名、点它就是「换一张旧长任务 / 新建一张」的清单）—— 任务切换与新建
     都摆在同一份清单里，用户不必再翻 ⚙。前三条仍在：条带头部 / 空态 / 设置窗。 */
  eqNum(countOf(LTU, "openLtCreateDlg(wf)"), 4, "四处入口都改成 openLtCreateDlg(wf)（条带三处 + 面包屑任务清单）");
  eqNum(countOf(LTU, "ltNewTask("), 1, "条带界面里只剩 ltNewTask 的定义（四处直连已清掉）");
  has(LTU, "async function ltNewTask(wf, ctx)", "ltNewTask（空白模板）本体保留：手动出口要用它，ctx = 创建时选型");
  has(LTC, "await ltNewTask(target, ltcAgentLoad())", "手动新建走既有 ltNewTask（不重写一份模板逻辑）");
  eqNum(countOf(LTU, 'ltT("＋ 创建长任务")'), 4, "四处入口文案统一「＋ 创建长任务」");
  const seg = (name, next) => {
    const from = LTU.indexOf("function " + name + "(");
    const to = LTU.indexOf(next, from);
    return from < 0 ? "" : LTU.slice(from, to > 0 ? to : undefined);
  };
  has(seg("ltRenderHead", "function ltEmptyState("), "openLtCreateDlg(wf)", "条带头部（!task 分支）走对话框");
  has(seg("ltEmptyState", "async function ltNewTask("), "openLtCreateDlg(wf)", "空态按钮走对话框");
  has(seg("ltSettingsDlg", "function ltMemoryDlg("), "openLtCreateDlg(wf)", "设置窗任务管理行走对话框");
  has(seg("ltCrumbTaskBtn", "function ltMenuClose("), "openLtCreateDlg(wf)", "面包屑任务清单末项走对话框（同一个新建入口，不另造一套）");
}

/* ═══════════════ [2] 对话框骨架 ═══════════════ */
console.log("\n[2] 对话框：持久化浮层 / 近全屏 / 右下拖调 / 唯一手动新建 / Esc");
has(LTC, 'window.openLtCreateDlg = openLtCreateDlg', "挂 window.openLtCreateDlg（自包含新模块）");
has(LTC, 'openOverlay(ltcT("新建长周期任务"), { persistent: true, min: true })', "持久化浮层（不点外部即关）且可最小化到状态栏");
has(LTC, "ltcOvBox", "窗壳从 #overlay 取（不重造浮层壳）");
has(LTC, "vw * 0.94", "默认近全屏（宽按视口 94%）");
has(LTC, "vh * 0.86", "默认近全屏（高按视口 86%）");
has(LTC, "vw * 0.5", "最小宽 = 视口 50%（右下拖到再小也不放）");
has(LTC, "LTC_MIN_H = 360", "最小高有下限（拖不成一条缝）");
has(LTC, "vw - 60", "尺寸上限留下 #overlay 内边距，不顶出窗外");
has(LTC, "ltc-resize", "右下角有拖拽把手");
has(LTC, 'rz.addEventListener("mousedown"', "把手按下即进入拖调");
has(LTC, 'document.addEventListener("mousemove", move)', "拖动跟手（mousemove 调尺寸）");
has(LTC, "ltcSaveSize", "拖过的尺寸记进 localStorage（跨画布统一）");
has(LTC, 'const LTC_SIZE_KEY = "ltCreateDlgSize"', "记忆键名固定");
has(LTC, "box.style.position = \"relative\"", "窗壳给把手做定位锚（body 滚动时贴右下角）");
hasnt(LTC, "ev.target === host", "没有「点宿主即关」的监听（AGENTS：浮层必须 persistent）");
{
  eqNum(countOf(LTC, "ltc-manual"), 1, "对话框里只造一颗「手动新建」按钮（唯一手动出口）");
  has(LTC, 'manual.id = "ltcManual"', "按钮有固定 id");
  has(LTC, "top.appendChild(manual)", "它挂在窗内顶部条（右上角）");
  has(LTC, 'ltcT("＋ 手动新建")', "文案「＋ 手动新建」");
  has(LTC, "closeOverlay()", "手动新建成功后关窗");
  has(LTC, "ltRenderStrip()", "关窗后刷新条带（新建的任务立刻可见）");
}
has(LTC, "function ltcOnEsc(ev)", "Esc 是本窗的显式关闭路径");
has(LTC, 'document.addEventListener("keydown", ltcOnEsc)', "Esc 监听已挂");
has(LTC, 'main.closest("#overlay")', "只在本窗正挂在 #overlay 上时认 Esc（最小化 / 被换窗时不抢）");
has(LTC, 'main.id = "ltcMain"', "主区留 #ltcMain 落点给 Agent 引导区");

/* ═══════════════ [2b] 取消出口 / 关窗保留内容 / 创建时 Agent 选型 ═══════════════ */
console.log("\n[2b] 取消出口 · 关窗保留内容 · 创建时 Agent 选型（模型 / 预设 / 思考强度）");
{
  /* 取消：窗壳标题栏只有最小化、没有通用 ✕，必须自己给一颗显式出口 */
  has(LTC, 'ltcEl("button", "lt-btn ltc-cancel", ltcT("取消"))', "窗口顶部有「取消」按钮（本窗唯一缺的显式出口）");
  has(LTC, 'cancel.id = "ltcCancel"', "取消按钮有固定 id");
  has(LTC, "cancel.onclick = () => closeOverlay()", "取消 = 只关窗（不删任务、不丢内容）");
  has(LTC, "已写的内容与 Agent 选型会保留", "取消按钮的提示写明内容会保留");
  /* 关窗保留内容：正文（引导区）与选型各一份 localStorage，重开原样回填 */
  has(LTC, 'const LTC_AGENT_KEY = "ltCreateAgent"', "选型落 localStorage（关窗 / 重启后仍在）");
  has(LTC, "function ltcAgentLoad()", "开窗时读回选型");
  has(LTC, "function ltcAgentSave(cfg)", "改选型即落盘");
  has(LTG, 'const LTG_DRAFT_KEY = "ltCreateDraft"', "引导区正文落 localStorage（关窗不丢）");
  has(LTG, "ta.value = draft;", "开窗把上次的正文回填进输入框");
  has(LTG, "ltgDraftSave(ta.value)", "打字即落盘");
  has(LTG, 'ltgDraftSave("")', "发出去之后清掉暂存（不重复发送）");
  /* 创建时选型：四只可搜索下拉，真源与会话 / 节点检查器同源（ltAgentOpts） */
  has(LTC, "function ltcAgentRow(wrap)", "创建窗有「Agent 选型」一栏");
  has(LTC, "window.LT.ui.ctl", "选型控件取 app-longtask-ctl.js 的 ctl");
  has(LTC, "AO.providerOptions", "服务商 / 路由下拉");
  /* 模型下拉按「服务商 / 路由」收窄（本次需求）：上一格选定了哪家，模型就只列哪家 ——
     原先直接吃 AO.modelGroups（全量、跨服务商）会让用户点到别家的模型，
     这是「选模型时可选所有提供商的模型」那条 bug 的现场，改用收窄口径。 */
  has(LTC, "C.modelScopeOpts(AO, route, hs.model)", "模型下拉走 ctl.modelScopeOpts（按服务商收窄）");
  has(LTC, "modelOptsNow(cfg.provider),", "模型下拉初值按当前服务商收窄");
  has(LTC, "refreshModelOpts();", "换服务商 / 静默回填时重列模型清单");
  has(LTC, "AO.presetOptions", "预设下拉");
  has(LTC, "AO.effortOptions", "思考强度下拉");
  has(LTC, "AO.routeOfModel(m)", "跨服务商选模型时把 provider 一并拨正");
  eqNum(countOf(LTC, "ltcAgentRow("), 2, "ltcAgentRow 只有定义 + 开窗时的一次调用");
  eqNum(countOf(LTC, "C.ltSelField("), 4, "四只下拉都是 ltSelField（输入框只用来搜索）");
  has(LTC, "window.ltCreateAgentCfg = ltcAgentLoad", "对外出口：引导区 / 手动模板读同一份选型");
  has(LTC, "window.ltCreateAgentSet", "接回已有引导会话时把会话选型回填进窗内");
  has(LTC, "await ltNewTask(target, ltcAgentLoad())", "手动模板也吃这套选型（ltNewTask 第二参 = 继承上下文）");
  has(LTU, "ltInheritGraph(ltNormGraph(g), ctx)", "ltNewTask 用 ctx 填整张图的 Agent 环节选型");
  /* 引导会话：起会话时落下选型；开着会话时改选型就地生效；建图继承同一份 */
  has(LTG, "provider: cfg.provider || \"\"", "起会话把服务商交给契约会话");
  has(LTG, "model: cfg.model || \"\"", "起会话把模型交给契约会话");
  has(LTG, "effort: cfg.effort || \"\"", "起会话把思考强度交给契约会话");
  has(LTG, "if (cfg.preset) st.preset = String(cfg.preset)", "预设补落在会话上（agentContractSession 目前只收前三项）");
  has(LTG, "window.ltGuideApplyCfg = ltgApplyCfg", "创建窗改选型 → 已开着的引导会话就地改");
  has(LTG, "st.preset = String(", "应用选型时预设回到默认档");
  has(LTG, "const ichCtx = ltgInheritCtx()", "建图继承上下文：优先创建窗那一栏，否则用接回会话的选型");
  has(LTG, "function ltgInheritCtx()", "继承上下文收成一件（建图 / 启用 / 兜底落库共用同一份）");
  has(LTG, "function ltgAutoBuild(hit)", "兜底落库：回复正文里有图就自己建成本画布的任务");
  has(LTG, "ltgAutoBuildOnce(hit, st)", "同一份图只兜底落库一次（记名挂会话，不跟着每次重绘重复建）");
  has(LTG, "function ltgScanCanvasTask()", "回执读不出图时按画布长任务列表认领（图明明建成了右栏不能空着）");
  has(LTG, "reused: true", "兜底落库幂等：本画布已有同名任务就认领它（页面重载不叠第二张）");
  /* 本轮核心：这一条会话的产物只有长周期任务图，绝不退化成「普通会话计划 + 任务清单」 */
  has(LTG, "st.noPlanFlow = true", "引导会话置 noPlanFlow（宿主不再给它注入「任务流程 / 交计划块」指令）");
  has(LTG, "s.noPlanFlow = true", "接回既有的旧引导会话时就地补上豁免位（老会话也照新规矩走）");
  {
    const ct2 = LTG.slice(LTG.indexOf("function ltgContractText("), LTG.indexOf("function ltgSession("));
    has(ct2, "MTNODE-PLAN", "契约明文禁止输出普通会话的计划块");
    has(ct2, "todo_write", "契约明文禁止用 todo_write 登记任务清单");
    has(ct2, "把「让用户自己照着在条带上搭」当成交付", "契约明文否定「交给用户自己搭」这种假交付");
  }
  has(LTG, "function ltgAdopt(st)", "认领图 + 兜底落库收成一件（窗开着 / 关着都走它）");
  has(LTG, "function ltgSettle(st)", "每轮收尾的「必须交图」闸（不依赖对话框开着）");
  has(LTG, "function ltgFixDirective()", "没交图时的自动纠偏指令（禁止计划块 / 任务清单，要求交图）");
  has(LTG, "agentSessionSend(ltgFixDirective(), { sessionId: st.id })", "自动纠偏在同一会话里回发一轮");
  has(LTG, "st._ltgFixRounds = 0", "用户亲口发话 = 纠偏额度清零（一个用户轮最多纠偏一次）");
  has(LTG, "if (msgs.length <= Number(st._ltgRoundFrom || 0)) return;", "只在「本窗发起的这一轮真跑过」时纠偏（接回历史会话不乱发）");
  has(LTG, "await agentContractRound(st);", "起轮仍走 agentContractRound");
  has(CSS, ".ltc-opts", "选型一栏有样式（四列栅格）");
  has(CSS, ".ltc-cancel", "取消按钮有样式");
  {
    const I = require("../renderer/i18n.js");
    I.setLocale("en");
    const keys = [
      "关窗；已写的内容与 Agent 选型会保留，下次打开接着写",
      "Agent 选型：本次创建就用这套模型 / 预设 / 思考强度（可全部留空跟随默认；建成后仍可逐个节点改）。",
      "模型清单还没就绪：建成后可在节点检查器里改",
      "留空 = 跟随默认路由",
      "留空 = 跟随默认模型",
      "关窗（取消 / Esc）不会丢掉你写的正文与上面的 Agent 选型：下次打开本窗原样回来。",
      "本轮没有拿到长周期任务图：已让 Agent 按契约重出一份（不要普通会话计划）。",
    ];
    const miss = keys.filter((k) => I.t(k) === k);
    eqNum(miss.length, 0, "新增文案都有 EN 译文" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
    I.setLocale("zh");
  }
}

/* ═══════════════ [2c] 创建即显示（本轮需求） ═══════════════ */
console.log("\n[2c] 创建即显示：条带自动展开 + 归属画布口径 + 只显示不开跑");
{
  has(LTV, "function ltTaskReveal(wf, task) {", "引擎有统一收尾口 ltTaskReveal（幂等，任何创建路径都可重复调用）");
  has(LTV, "taskReveal: ltTaskReveal,", "window.LT.taskReveal 已导出（界面路径与引擎共用同一口）");
  has(LTV, "ltTaskReveal(wf, task);", "ltCreateFromGraph 末尾走收尾（create_longtask / 会话 / 助手 / 兜底落库全覆盖）");
  has(
    LTU,
    'if (typeof ltTaskReveal === "function") ltTaskReveal(wf, task);',
    "手动模板 ltNewTask 末尾走同一口（第二条创建路径不绕过收尾）",
  );
  has(LTV, "ltViewPatch(wf, { ltOpen: true })", "展开态记到**这张任务所属的画布**（切走再切回仍展开）");
  has(LTV, "const shown = !!vis && wf === vis;", "只有它此刻正是用户看着的那张才真拉起来（归属画布口径）");
  has(LTV, "window.LT.ui.open(true, wf)", "前台才 LT.ui.open(true, wf)");
  has(LTV, "ltCfgPatch({ open: true })", "前台才把全局展开态打开");
  has(
    LTV,
    "长周期任务已建好：在它所属的画布上条带已展开（切过去就能看见）",
    "后台画布只落盘 + 一条 toast（绝不在用户正看着的另一张图上硬展开）",
  );
  {
    const body = LTV.slice(
      LTV.indexOf("function ltTaskReveal(wf, task) {"),
      LTV.indexOf("function ltLandingCreate(wf, task) {"),
    );
    ok(body.length > 200, "取到 ltTaskReveal 的真实现源码（下面三条「不开跑」断言才是有据可查）");
    hasnt(body, "ltEnable", "收尾只显示不开跑：不调 ltEnable");
    hasnt(body, "ltRunNew", "收尾不建 run（开跑只由用户点「启用并绑定」）");
    hasnt(body, "ltPump", "收尾不点火推进（不代跑、不烧额度）");
  }
  has(LTV, 'enabled: false, activeRun: ""', "新建任务仍 enabled:false（本轮只改「看得见」，不改「谁来开跑」）");
  has(LTG, "LT.createFromGraph", "引导兜底落库走引擎的 createFromGraph（不自己 push 任务、不绕过收尾）");
  ok(LTG.indexOf("ltgUid") < 0, "旧的直塞任务兜底支路连同 ltgUid 辅助生成器一并清掉");
  hasnt(LTG, "wf.longtask.tasks.push", "引导侧不再自己往任务列表里塞（落库只有一条路）");
}

/* ═══════════════ [3] 窗内 Agent 引导 ═══════════════ */
console.log("\n[3] Agent 引导：契约 / 契约会话装配 / 回执落地 / 出口");
has(LTG, "window.openLtCreateDlg = wrapped", "wrap window.openLtCreateDlg（不抢窗壳，只接管 #ltcMain）");
has(LTG, "orig.__ltGuideHooked", "wrap 幂等（重复加载不套两层）");
has(LTG, "function ltgMount(wf)", "开窗即挂载引导区");
has(LTG, 'host.querySelector(":scope > .ltg")', "同窗重复挂载幂等");
{
  const ct = LTG.slice(LTG.indexOf("function ltgContractText("), LTG.indexOf("function ltgSession("));
  has(ct, "mtnode-grill-me", "契约要求先加载内置技能 mtnode-grill-me");
  has(ct, "ask_user_question", "每轮必须用 ask_user_question 问满前沿（不许把问题写成正文列表）");
  has(ct, "禁止把问题编号列在回复正文里", "明确禁止正文列表式提问");
  has(ct, "create_longtask", "共识后用 mtnode_app 的 create_longtask 落库");
  has(ct, "禁止手改画布 JSON 里的 wf.longtask", "禁止手改 wf.longtask");
  has(ct, "mtnode_canvas_edit", "禁止用建图工具画这张状态机图");
  has(ct, "（推荐）", "推荐项要标「（推荐）」并在 description 写理由");
  has(ct, "一次问满", "一轮问满整个前沿");
  has(ct, "```json", "工具不可用时把图 JSON 放进回复兜底（不假装已落库）");
}
has(LTG, "agentContractSession({", "会话经 app-assist 的 agentContractSession 装配");
has(LTG, "allowCanvas: true", "本会话允许读当前画布（环境事实自己查）");
has(LTG, "canvasWfId:", "会话绑本对话框所属画布");
has(LTG, "await agentContractRound(st)", "起轮走 agentContractRound");
{
  const st = ASSIST.slice(ASSIST.indexOf("function agentContractSession("), ASSIST.indexOf("async function agentContractRound("));
  has(st, "st.titleLocked = true", "契约会话标题锁死（不被首轮正文自动改名）");
  has(st, "st.titleAuto = false", "关掉自动命名");
  has(st, "st.noCanvasRead = opts.allowCanvas === false", "允许读画布由 allowCanvas 控制");
  has(st, "st._devContract = String(opts.contract || \"\")", "契约写进 _devContract（每轮随系统提示注入）");
  has(ASSIST, "async function agentContractRound(st, opts)", "契约会话起轮 / 重起本轮统一入口");
  has(ASSIST, "_devContract: true", "起轮带 _devContract 标记");
}
has(LTG, "function ltgFindSession(wf)", "能认出「长任务世界」的引导会话（契约标记判据仍在）");
has(LTG, "s._devContract", "按契约标记认领（重启后仍接得回）");
/* ── 本次需求：新建任务 = 清空会话（开窗一律全新会话，不接回上一条）──────────
   旧行为是 ltgMount 先 ltgFindSession 接回一条旧引导会话（连带它的问题与图摘要），
   于是「从零开始新建」其实继承着上一轮的上下文。现在开窗即空白对话：
   LTG.sid 起始为空（起轮时由 ltgSend 另起一条契约会话），旧会话留在左侧栏只作历史。 */
has(LTG, 'sid: "",', "开窗把 LTG.sid 置空 = 全新会话（不再接回旧引导会话）");
hasnt(
  LTG.slice(LTG.indexOf("function ltgMount(wf) {"), LTG.indexOf("function ltgHookRepaint()")),
  "ltgFindSession(",
  "ltgMount 不再调用 ltgFindSession（不认领旧会话；清空会话的口径就在这一条上）",
);
has(LTG, "LTG_FRESH_NOTE", "契约里写明本窗每次打开都是全新会话（模型不会自称「接着上次聊」）");
has(LTG, "每次打开本窗都是全新会话", "右侧说明向用户讲清：本窗不接回、旧会话留左侧栏作历史");
/* 发送框在下方 + 可往下拖高（本次需求）：DOM 顺序 = 对话区 → 分隔条 → 输入行（左栏最后一格），
   再把「拖高」接线与 CSS 一起钉住，免得以后有人把 row 挪回 conv 前面（跑回顶部）。 */
has(LTG, 'const split = ltgEl("div", "ltg-split")', "发送行上沿有拖高分隔条");
orderOf(LTG, "left.appendChild(conv)", "left.appendChild(split)", "对话区在分隔条之前（消息流在上）");
orderOf(LTG, "left.appendChild(split)", "left.appendChild(row)", "分隔条在输入行之前（发送框在下方，不是顶部）");
has(LTG, "ltgSplitBind(split, ta)", "分隔条已接线（往下拖 = 输入框变高）");
has(LTG, "LTG_INPUT_H = ltgInputClamp(drag.h - (ev.clientY - drag.y))", "拖拽按位移算出新高度并夹到上下限（分隔条在输入框上沿：往下拖 = 变高，符号取反）");
has(LTG, "const LTG_TA_MIN = 72", "输入框有下限（拖不没）");
has(LTG, "const LTG_TA_MAX = 520", "输入框有上限（不把消息流挤没）");
has(LTG, "ltgInputApply(ta)", "建框即按记住的高度落 inline 高度");
has(LTG, 'ta.style.flex = "1 1 auto"', "宽度由 inline 的 flex:1 1 auto 收缩铺满（flex:none 会把发送按钮挤出左栏压在右栏上）");
has(CSS, "body.ltg-split-drag", "拖动中光标 / 禁选有样式（指针划出分隔条也不丢跟手）");
has(LTG, "window.renderAgentSession = wrapped", "wrap 全局重绘钩子（窗内实时刷消息流）");
has(LTG, "setInterval", "运行期轮询兜底（最小化到状态栏也继续）");
has(LTG, "/create_longtask/i.test", "从工具回执里认 create_longtask");
has(LTG, "window.LT.ui.enable(wf, task.uid, {})", "「启用并绑定」把落库任务启用并绑本画布");
has(LTG, "ltgAbort", "有中断出口");
has(LTG, "stopSessionRuns(st, true)", "中断 = 停掉正在跑的这一轮（会话不丢）");
has(LTG, "ltgLater", "有「稍后」出口");
has(LTG, "ltgGotoSession", "有「在会话视图里打开」出口");
has(LTG, 'ltgT("看条带")', "有「看条带」出口");
has(LTG, "persistAgentSession()", "关窗前落盘（会话留在左侧栏）");
hasnt(LTG, "ev.target === host", "引导区没有「点外部即关」的监听");
hasnt(LTG, "confirm(", "引导区不用原生 confirm");
hasnt(LTG, "alert(", "引导区不用原生 alert");

/* ═══════════════ [4] 网关与分发 ═══════════════ */
console.log("\n[4] 网关与分发：create_longtask 的 enum / 卡口 / graph 参数 / 权限口径");
has(PLUGIN, "'create_longtask'", "mtnode_app 的 action enum 收了 create_longtask");
has(PLUGIN, "- create_longtask: store a long-running-task state-machine graph", "APP_DESC 写了 create_longtask 的「何时用 / 写什么」");
has(PLUGIN, "mtnode-grill-me", "APP_DESC 指向 mtnode-grill-me 的图契约（单一真源，不抄字段）");
has(PLUGIN, "Rejected with the validation errors", "APP_DESC 说明校验不过会被拒、可修正后重发");
has(PLUGIN, "For rename_workflow / create_longtask: display name", "name 参数认 create_longtask（可省，缺省按编号命名）");
has(PLUGIN, "graph: {", "mtnode_app 新增 graph 参数");
has(PLUGIN, "For create_longtask / update_longtask: the long-running-task state-machine graph.", "graph 参数说明指向技能契约（创建与原地改图共用同一份契约）");
has(NODES, 'if (action === "create_longtask") {', "应用动作分发有 create_longtask 分支");
has(NODES, "LT.createFromGraph(", "分发体调 window.LT.createFromGraph（归一 + 校验 + 落库都在引擎里）");
has(NODES, 'await ensureAgentTool("app_ops"', "create_longtask 归 app_ops 工具（工具清单里有它才可被模型调到）");
has(NODES, 'throw new Error((r && r.error) || I18n.t("长周期任务图校验未通过："))', "校验失败把 err 文本回给 Agent（不假装成功）");
{
  const denied = NODES.slice(NODES.indexOf("const PLAN_DENIED_APP_ACTIONS"), NODES.indexOf("function canvasOpMutates("));
  has(denied, '"create_longtask"', "规划模式把 create_longtask 列为拒绝动作（只出计划不改画布）");
}

/* ═══════════════ [4b] 宿主闸：长任务会话不走「普通会话计划」那条线 ═══════════════
   这是本轮 bug 的宿主侧一半：引导会话的产物只能是长周期任务状态机图 ——
   宿主既不能给它注入「任务流程 / 交计划块」指令（模型于是交一份普通计划），
   也不能把它回复里的计划块变成一份会话计划清单。 */
console.log("\n[4b] 宿主闸：planFlowExemptSession（真跑 app-plan.js，不是 grep）");
has(PLANJS, "function planFlowExemptSession(st)", "app-plan.js 有「长任务世界会话」豁免判据");
has(PLANJS, "if (planFlowExemptSession(st)) return false;", "planFlowInjectNeeded 先过豁免闸（不注入交计划块指令）");
has(PLANJS, "planFlowExemptSession(st)) return;", "planMaybeOffer 先过豁免闸（计划块不弹计划窗）");
has(ASSIST, "noPlanFlow: !!s.noPlanFlow,", "app-assist 把豁免位随会话落盘");
has(BOOT, "sess.noPlanFlow = !!sess.noPlanFlow;", "app-boot 载回豁免位（重启后仍豁免）");
{
  const planSb = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    window: { innerWidth: 1600, innerHeight: 900 },
    document: {
      createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {},
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
      }),
      addEventListener() {},
      removeEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
    },
    I18n: { t: (s) => String(s) },
  };
  vm.createContext(planSb);
  vm.runInContext(PLANJS, planSb, { filename: "app-plan.js" });
  const P = planSb;
  ok(typeof P.planFlowExemptSession === "function", "planFlowExemptSession 已可调用");
  ok(P.planFlowExemptSession({ noPlanFlow: true }) === true, "引导会话（noPlanFlow）→ 豁免");
  ok(P.planFlowExemptSession({ ltGuide: true }) === true, "运行时别名 ltGuide → 同样豁免");
  ok(
    P.planFlowExemptSession({ ltBound: { wfId: "w", runId: "r", path: "p" } }) === true,
    "长任务环节的运行档案会话（ltBound）→ 豁免",
  );
  ok(P.planFlowExemptSession({}) === false, "普通会话不豁免（不误伤）");
  ok(P.planFlowExemptSession(null) === false, "null → 不豁免（不抛）");
  ok(
    P.planFlowInjectNeeded({ noPlanFlow: true }, {}, null) === false,
    "引导会话：不注入「任务流程 / 交计划块」指令（模型不会交出普通会话计划）",
  );
  ok(P.planFlowInjectNeeded({ ltBound: {} }, {}, null) === false, "长任务环节会话：同样不注入");
  ok(
    P.planFlowInjectNeeded({}, {}, null) === true &&
      P.planFlowInjectText({}, {}, null).indexOf("【任务流程】") >= 0,
    "普通会话照旧（本轮改动不误伤既有计划流程）",
  );
  const exemptSt = { noPlanFlow: true };
  P.planMaybeOffer(exemptSt, { goal: "g", tasks: [{ title: "t1" }] });
  ok(
    !exemptSt._planDlgPending && !exemptSt.plan,
    "引导会话回复里的计划块：不弹计划窗、不落成会话计划（不会再变成「普通会话计划」）",
  );
}

/* ═══════════════ [5] 引擎真行为（vm 里跑）+ [6] 装配与文案 ═══════════════ */
async function main() {
  console.log("\n[5] 引擎：LT.createFromGraph 归一 / 校验拒绝 / 落库字段（真跑，不是 grep）");
  let saves = 0;
  /* persistWf = 「按对象自己的 id 落盘」那条路（前台画布不存在时的唯一落点）：
     用数组记下每次收到的画布对象，断言落盘命中的是被改的那张。 */
  const persisted = [];
  /* 创建即显示（本轮需求）真跑要用的三个观察点：toast 文案 / 展开态落到哪张画布 /
     条带被真正拉起来的次数（LT.ui.open）。 */
  const toasts = [];
  const viewPatches = [];
  const openCalls = [];
  let visible = null; /* currentVisibleWf 的返回值：null = 创建发生在后台画布 */
  const sandbox = {
    window: { api: { dshInteract: () => {} } },
    S: { wf: null, config: {} },
    I18n: { t: (s) => s },
    toast(m) {
      toasts.push(String(m));
    },
    ltViewPatch(wf2, patch) {
      viewPatches.push({ id: String((wf2 && wf2.id) || ""), patch: patch || {} });
    },
    scheduleSave() {
      saves++;
    },
    persistWf(wf) {
      persisted.push(wf);
    },
    currentVisibleWf() {
      return visible; /* 测试里没有「用户看着的画布」→ 默认一律走 persistWf 这条 */
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
  ok(!!LT && typeof LT.createFromGraph === "function", "window.LT.createFromGraph 已导出");
  /* 条带真被拉起来的唯一观察点：收尾是「按归属画布分流」的，前台才许打开 */
  sandbox.window.LT.ui = {
    open(open, wf2) {
      openCalls.push({ open: !!open, id: String((wf2 && wf2.id) || "") });
    },
  };

  const GOOD = {
    nodes: [
      { id: "s", kind: "start", title: "起点" },
      { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿子", outKeys: ["draft"] } },
      { id: "h", kind: "human", title: "审稿", cfg: { mode: "approve" } },
      { id: "e", kind: "end_ok", title: "收工" },
    ],
    edges: [{ from: "s", to: "a" }, { from: "a", to: "h" }, { from: "h", to: "e" }],
  };

  let r = LT.createFromGraph("x", GOOD, null);
  ok(r && r.ok === false && !!r.error, "没有画布 → 拒绝（不静默吞掉）");

  const wf = { id: "wf1", name: "画布一" };
  r = LT.createFromGraph("x", null, wf);
  ok(r && r.ok === false && /graph/.test(r.error), "缺 graph → 拒绝并说明");
  r = LT.createFromGraph("x", [], wf);
  ok(r && r.ok === false && /graph/.test(r.error), "graph 是数组 → 同样按缺图拒绝（只认对象）");

  saves = 0;
  r = LT.createFromGraph("x", { nodes: [], edges: [] }, wf);
  /* 空图在**参数级**就被挡住（归一容错会把空图放行成一张没有节点的任务，向导兜底落库
     解析不出图时会拿 {} 过来 —— 少这道闸画布上会凭空多一张空任务）。 */
  ok(r && r.ok === false, "空图 → 拒绝（参数级直接挡）");
  has(r.error, "缺少图定义 graph", "拒绝文本说清缺的是图定义（Agent 可读）");
  eqNum((LT.tasks(wf) || []).length, 0, "空图绝不落库（任务列表为空）");
  eqNum(saves, 0, "空图不触发存盘");
  eqNum(persisted.length, 0, "空图不触发落盘");

  /* 校验不过（有节点但不干净）仍走校验拒绝路径，err 文本原样回给 Agent */
  const DIRTY = {
    nodes: [
      { id: "s", kind: "start", title: "起点" },
      { id: "a", kind: "agent", title: "没目标的 Agent", cfg: {} },
    ],
    edges: [{ from: "s", to: "a" }],
  };
  r = LT.createFromGraph("x", DIRTY, wf);
  ok(r && r.ok === false, "脏图 → 拒绝（校验未过）");
  has(r.error, "长周期任务图校验未通过：", "拒绝文本带「校验未通过」前缀（Agent 可读）");
  has(r.error, "没写目标", "拒绝文本把引擎的 err 原样带回（Agent 知道改什么）");
  has(r.error, "。请修正后重新调用 create_longtask。", "拒绝文本明确让 Agent 修正后重调");
  ok(Array.isArray(r.errs) && r.errs.length >= 1, "拒绝回执带结构化 errs");
  ok(Array.isArray(r.warnings), "拒绝回执带 warnings");
  eqNum((LT.tasks(wf) || []).length, 0, "校验不过绝不落库（任务列表为空）");
  eqNum(saves, 0, "校验不过不触发存盘");
  eqNum(persisted.length, 0, "校验不过不触发落盘");

  saves = 0;
  persisted.length = 0;
  r = LT.createFromGraph("审稿流水线", GOOD, wf);
  ok(r && r.ok === true, "干净图 → 落库成功");
  ok(!!r.uid && String(r.uid).indexOf("ltask") >= 0, "回执带任务 uid");
  eqNum(r.ver, 1, "回执 ver = 1");
  eqNum(r.name, "审稿流水线", "回执带任务名");
  eqNum(r.graph.ver, 1, "图归一后钉上 ver=1");
  ok(!!r.graph.nodes.length && r.graph.nodes.every((n) => n.cfg), "回执带归一后的图（cfg 已补全）");
  const tasks = LT.tasks(wf);
  eqNum(tasks.length, 1, "任务 push 进 wf.longtask.tasks");
  const t = tasks[0];
  eqNum(t.uid, r.uid, "落库任务 uid 与回执一致");
  eqNum(t.enabled, false, "新任务 enabled:false（等用户「启用并绑定」，不自动跑）");
  eqNum(wf.longtask.active, r.uid, "active 指向新任务");
  eqNum(t.ver, 1, "任务记 ver");
  ok(Number(t.createdAt) > 0 && Number(t.updatedAt) > 0, "写 createdAt / updatedAt");
  eqNum(t.graph.nodes.length, 4, "落库图归一后仍是 4 个节点");
  /* 落盘必须命中「被改的那张画布」：会话跑在后台画布上时 scheduleSave 存的是用户看着的
     另一张，任务就只剩内存一份（切走再切回即丢）。这条断言钉住这条纪律。 */
  ok(saves + persisted.length >= 1, "落库触发了一次落盘（前台走 scheduleSave，后台走 persistWf）");
  eqNum(persisted.length, 1, "落盘按对象自己的 id 走 persistWf（不写用户看着的另一张）");
  ok(persisted[0] === wf, "落盘的正是那张被改的画布（不是前台那张）");

  r = LT.createFromGraph("", GOOD, wf);
  ok(r && r.ok === true, "名字可省（缺省按编号命名）");
  ok(/长周期任务/.test(r.name), "缺省名是「长周期任务 N」");
  eqNum(wf.longtask.active, r.uid, "第二条同样 active 指向它");

  /* 创建即显示（本轮需求）真跑：后台画布只落盘 + 一条 toast；前台那张才真把条带拉起来。
     归属纪律与 ltPersistWf / ltsBg 同源 —— 会话可能在后台画布上建任务，那一步绝不能
     把用户正看着的另一张图的条带硬展开。 */
  console.log("     · 真跑 ltTaskReveal：后台 / 前台两条路（归属画布口径）");
  {
    ok(
      viewPatches.some((v) => v.id === "wf1" && v.patch.ltOpen === true),
      "展开态记到这张任务所属的画布（ltViewPatch(wf,{ltOpen:true})）",
    );
    ok(
      toasts.some((m) => m.indexOf("在它所属的画布上条带已展开") >= 0),
      "后台画布只给一条 toast（告诉用户去哪儿看）",
    );
    eqNum(openCalls.length, 0, "后台画布不硬展开：一次 LT.ui.open 都没叫（此刻用户正看着别的图）");
    /* 后台建了几条就给几条 toast（上面两条后台创建各一条），前台那条不许再补发 */
    const bgToasts = toasts.filter((m) => m.indexOf("在它所属的画布上条带已展开") >= 0).length;
    ok(bgToasts >= 2, "每条后台创建都有一条 toast（不静默：用户在别的画布上也知道任务建好了）");
    visible = wf;
    const rFg = LT.createFromGraph("前台那条", GOOD, wf);
    ok(rFg && rFg.ok === true, "前台画布上再建一条：照常落库（收尾不影响创建本身）");
    eqNum(openCalls.length, 1, "前台那张才 LT.ui.open(true, wf)：真把条带拉起来");
    eqNum(openCalls[0].id, "wf1", "拉起来的正是这张任务所属的画布（不是别处）");
    eqNum(openCalls[0].open, true, "动作是「展开」");
    ok(!!(sandbox.S.config.longtask && sandbox.S.config.longtask.open === true), "同时落全局展开态（ltCfgPatch({open:true})）");
    const tFg = LT.tasks(wf).find((x) => x.uid === rFg.uid);
    eqNum(tFg.enabled, false, "前台这条同样 enabled:false（收尾只显示、不开跑）");
    eqNum(toasts.filter((m) => m.indexOf("在它所属的画布上条带已展开") >= 0).length, bgToasts, "前台那条不再发后台 toast（用户已经看得见）");
    visible = null;
  }
  hasnt(LTV, "mtnode_canvas_edit", "引擎不碰建图工具（图只由 create_longtask 落库）");
  has(LTV, "createFromGraph: ltCreateFromGraph", "window.LT 只读出口登记 createFromGraph");

  console.log("\n[6] 装配与文案：脚本顺序 / 样式 / i18n 中英词条");
  const iUi = HTML.indexOf('src="app-longtask-ui.js"');
  const iCreate = HTML.indexOf('src="app-longtask-create.js"');
  const iGuide = HTML.indexOf('src="app-longtask-guide.js"');
  ok(iUi >= 0 && iCreate > iUi, "index.html 加载顺序：create 在 ui 之后（手动新建要用 ltNewTask）");
  ok(iGuide > iCreate, "index.html 加载顺序：guide 在 create 之后（要 wrap openLtCreateDlg）");
  for (const c of [".ltc-top", ".ltc-hint", ".ltc-manual", ".ltc-main", ".ltc-ph", ".ltc-resize"]) {
    has(CSS, c, "longtask.css 有样式 " + c);
  }
  for (const c of [".ltg-left", ".ltg-conv", ".ltg-row", ".ltg-status", ".ltg-sum", ".ltg-acts"]) {
    has(CSS, c, "longtask.css 有引导区样式 " + c);
  }
  {
    has(I18N, '"＋ 手动新建": "＋ Create manually"', "i18n 源文件里有「＋ 手动新建」的 EN 词条");
    has(I18N, '"新建长周期任务": "New long-running task"', "i18n 源文件里有「新建长周期任务」的 EN 词条");
    const I = require("../renderer/i18n.js");
    I.setLocale("en");
    const keys = [
      "新建长周期任务",
      "＋ 创建长任务",
      "＋ 手动新建",
      "没有打开的画布",
      "长任务模块未就绪",
      "长周期任务图校验未通过：",
      "。请修正后重新调用 create_longtask。",
      "缺少图定义 graph",
      "发送",
      "中断本轮",
      "稍后",
      "在会话视图里打开",
      "看条带",
      "图摘要",
      "还没有开始：写完目标点「发送」",
      "Agent 正在等你作答：去「🐋 模型等待你的回应」卡片里点选 / 填空",
      "正在跑本轮…",
      "本轮结束：图已在条带上显示（要开跑点 ▶ 启用并绑定）",
      "（更早的内容在会话视图里）",
      "这条引导会话留在左侧栏只作历史；下次打开本窗是一条全新会话（不继承上下文）",
      "已中断本轮：会话留着，随时可以接着说",
      "长周期任务模块还没就绪",
      "启用失败：",
      "长周期任务已启用并绑定本画布",
      /* 创建即显示（本轮需求）：手动新建 toast 与后台画布 toast 都要有 EN 译文 */
      "已新建长周期任务：图已在条带上显示（要开跑点 ▶ 启用并绑定）",
      "长周期任务已建好：在它所属的画布上条带已展开（切过去就能看见），要开跑点 ▶ 启用并绑定",
    ];
    const miss = keys.filter((k) => I.t(k) === k);
    eqNum(miss.length, 0, "i18n 中英词条齐全（en 档下这些 key 都有译文）" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
    /* create 模块里每个 ltcT 字面量都必须有 EN 译文（新窗不允许出现中英混排的半截文案） */
    const re = /ltcT\(\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    const unmatch = [];
    while ((m = re.exec(LTC))) if (I.t(m[1]) === m[1]) unmatch.push(m[1]);
    eqNum(unmatch.length, 0, "app-longtask-create.js 的每条文案都有 EN 译文" + (unmatch.length ? "（缺：" + unmatch.join(" / ") + "）" : ""));
    /* guide 模块同上：引导区（占位 / 悬浮说明 / 状态 / 图摘要）每条 ltgT 字面量都要有 EN 译文，
       否则切英文时会和中文契约正文混排。「Agent」是中英同形的简称，跳过。 */
    const reG = /ltgT\(\s*"((?:[^"\\]|\\.)*)"/g;
    let mg;
    const unmatchG = [];
    while ((mg = reG.exec(LTG))) {
      const k = mg[1].replace(/\\n/g, "\n");
      if (k === "Agent") continue;
      if (I.t(k) === k) unmatchG.push(k);
    }
    eqNum(unmatchG.length, 0, "app-longtask-guide.js 的每条文案都有 EN 译文" + (unmatchG.length ? "（缺：" + unmatchG.join(" / ") + "）" : ""));
  }

  console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-longtask-create)");
}

main().catch((e) => {
  console.log("测试异常：" + String((e && e.stack) || e));
});

/* ==================== 已并入：test/smoke-longtask-canvas.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-canvas.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));

  const ROOT = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8").replace(/\r\n?/g, "\n");

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

  const LTV = read("renderer/app-longtask.js");
  const LTSHELL = read("renderer/app-longtask-shell.js");
  const LTART = read("renderer/app-longtask-artifacts.js");
  const LTOUT = read("renderer/app-longtask-out.js");

  /* ═══════════════ [1] 绑定层与唯一口径（静态） ══════════════ */
  console.log("\n[1] 「写哪张画布」只有一个口径：run.wfId（不认 S.wf）");
  has(LTV, "function ltRunCanvas(run) {", "引擎有 ltRunCanvas(run)：前台 → 内存袋，解析不到就 null（绝不退回前台画布）");
  has(LTV, "if (vis && String(vis.id || \"\") === id) return vis;", "解析顺序①：前台那张就是它 → 用它（绝大多数时候零开销）");
  has(LTV, "if (typeof canvasWfByIdLoaded === \"function\") {", "解析顺序②：已加载进内存袋的那张（loadWorkflow 的对象就是它，改的才是用户看得见的那份）");
  has(LTV, "function ltAfterCanvasWrite(wf) {", "碰完画布统一收尾 ltAfterCanvasWrite(wf)：前台才重绘 + 前台保存通道");
  has(LTV, "ltPersistWf(wf);", "后台那张按对象自己的 id 落盘（persistWf 写谁就是谁，不串前台）");
  has(LTV, "function ltSyncCanvas(wf, fn) {", "同步段 ltSyncCanvas(wf, fn)：段内 S.wf 临时换归属画布（借用 runAgainstWf 的交接语义）");
  has(LTV, "function ltNewSystemNode(wf, kind, x, y, extra) {", "系统节点统一走 ltNewSystemNode(wf, …)（makeNode 建 + 自己入列，不弹 toast / 不进撤销栈）");
  has(LTV, "function ltCanvasRefused(run, what) {", "归属画布解析不到 = ltCanvasRefused：记日志、这一笔不写");
  has(LTV, 'ltT("归属画布已不在（或还没打开），这一笔没有写：")', "拒绝时给用户一句说得清的话（不是静默丢内容）");
  has(LTV, "if (!wf) return ltCanvasRefused(run, ltT(\"交付节点\"));", "交付节点：归属画布解析不到就不建（旧口径会建到前台那张）");
  has(LTV, "if (!wf) return ltCanvasRefused(run, ltT(\"交付节点对齐\")) || 0;", "交付对齐链同样先定归属");
  has(LTV, "if (!wf) return ltCanvasRefused(run, ltT(\"产出节点\"));", "产出节点：同上");
  has(LTV, "if (!wf) return ltCanvasRefused(run, ltT(\"产出回流\"));", "产出回流整链：同上");
  has(LTV, "const wf = ltCanvasOfNode(node) || (typeof S !== \"undefined\" ? S.wf : null);", "界面入口（用户在节点上改清单 / 收线）按**节点所在画布**办事");
  has(LTV, "function ltCanvasOfNode(node) {", "ltCanvasOfNode：节点 → 它所在的那张画布（ownerWfOfNode → 前台 / S.wf / 内存袋）");
  has(LTV, "function ltWfWorkspace(wf) {", "工作目录按画布对象取（交付目录 / output / 记忆作用域共用一个口径）");
  has(LTV, "runKey: pn.id,", "Agent 环节的 dshOpts 仍按伪节点 id 分键（口径未动）");
  has(LTV, "canvasWfId: String(run.wfId || \"\"),", "并把**本轮绑定画布**显式交给 dshRunTask（画布读写 / 应用 op / 工作区全按它算）");
  has(LTV, "st.canvasWfId = String(run.wfId);", "绑定会话每次执行都校准 canvasWfId（老档案是空的时候也不许退回前台）");
  has(LTV, "if (!j.wfId) j.wfId = String(wf.id || \"\");", "极老 checkpoint 缺 wfId 时按「读它出来的那张画布」补上归属");
  has(LTV, "runCanvas: ltRunCanvas,", "绑定口径从 window.LT 导出（UI / 壳 / 产物 / 测试共用同一份）");
  has(LTV, "afterCanvasWrite: ltAfterCanvasWrite,", "收尾分流同样导出");
  has(LTSHELL, "function ltsBindWf(wf) {", "壳模块有 bindWf(wf)：引擎进入前绑、退出还原");
  has(LTSHELL, "if (ltsCtxWf) return ltsCtxWf;", "壳内 ltsWf 优先取绑定画布（没绑定才是当前画布）");
  has(LTSHELL, "if (ltsCtxWf && typeof persistWf === \"function\") persistWf(ltsCtxWf);", "壳改的是后台那张 → 只按 id 落盘，不重绘用户屏幕");
  has(LTSHELL, "bindWf: ltsBindWf,", "bindWf 从 window.LTSHELL 导出");
  has(LTV, "if (typeof sh.bindWf === \"function\") sh.bindWf(wf);", "引擎包装层进壳前绑定归属画布");
  has(LTV, "if (run && run.wfId) return ltCanvasRefused(run, ltT(\"长任务壳\"));", "归属画布解析不到 → 壳整段不进（壳的 ltsWf 没有归属会退回 S.wf）");
  has(LTART, "function ltArtWfOf(run) {", "产物模块有 ltArtWfOf(run)：run.wfId 优先，解析不到不退回前台");
  has(LTART, "ltArtSync(wf, () => {", "产物的建 / 改节点放进同步段（段内 S.wf = 归属画布）");
  has(LTART, "ltArtAfterWrite(wf);", "产物的收尾同样分流重绘 / 按 id 落盘");
  has(LTART, "function ltArtNodeOf(taskUid, path, file, wfIn) {", "产物认人按显式画布（异步清点期间用户切画布也不串）");
  has(LTART, "function ltArtPick(paths, limit) {", "只摆「关键文件」的挑选函数在（本轮需求：中间件不占画布）");
  has(LTART, "const keys = ltArtPick(own);", "发布链先挑关键件，再为要摆的那几件读指纹（不整轮扫 IO）");
  has(LTOUT, "function ltOutNodeOf(nodeId, run) {", "产出回流找节点按本 run 所属画布（切走后不许把产出判成「被删」）");
  /* 旧写法一处都不许留：这四条正文就是本轮的回归闸 */
  hasnt(LTV, "ltDeliverWriteToGraph(S && S.wf", "交付清单回写不再按前台画布");
  hasnt(LTV, "if (String(run.wfId || \"\") !== String(S.wf.id || \"\")) return 0;", "旧产物救援的「必须正好是当前画布」前置条件已去掉（切走也能救，救的是它自己那张）");
  hasnt(LTV, "await ltDeliverReconcileDisk(node, node && node.ltDir);", "磁盘对账不再缺 wf（缺了就会按前台画布的工作目录去认文件）");
  hasnt(LTV, "ltAutoCollectSoon();", "自动收线一律带上本 run（否则收的是前台那张的线）");
  hasnt(LTV, "workspace: cfg.workspace || (typeof wfWorkspace === \"function\" ? wfWorkspace() : undefined),", "Agent 工作区不再现取前台画布的工作目录");
  hasnt(LTART, "if (typeof S === \"undefined\" || !S.wf) return out;", "产物模块不再以前台画布为前置条件");

  /* ═══════════════ [2] 真跑：用户切画布之后 ═══════════════ */
  async function part2() {
    console.log("\n[2] 真跑：跑着的时候用户切去另一张画布（内容仍写进 run 自己那张）");
    const probe = { renders: 0, saves: 0, persisted: [], listWs: [], joins: [], ensureWs: [], ensureArgs: null, toast: [] };
    let nodeSeq = 0;
    const files = new Map(); /* path → { size, mtime } */
    const setFile = (p, mtime, size) => files.set(String(p), { mtime, size, content: "" });
    const wfA = { id: "wfA", name: "A 项目", workspace: "D:\\projA", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 } };
    const wfB = { id: "wfB", name: "B 项目", workspace: "D:\\projB", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 } };
    const S = { wf: wfA, wfBag: { wfA: wfA, wfB: wfB }, config: {}, _skipCanvasHistory: false };
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
          fileWriteText: async (p) => {
            files.set(String(p), { mtime: 1, size: 1, content: "" });
            return { ok: true };
          },
          pathJoin: (a, b) => {
            probe.joins.push([a, b]);
            return String(a).replace(/[\\/]+$/, "") + "\\" + String(b).replace(/^[\\/]+/, "");
          },
          ltDeliverEnsure: async (args) => {
            probe.ensureArgs = args || {};
            probe.ensureWs.push(String((args && args.workspace) || ""));
            return {
              ok: true,
              dir: String((args && args.workspace) || "") + "\\mtnode-deliverables\\" + String((args && args.uid) || ""),
              manifest: { items: (args && args.items) || [] },
            };
          },
          ltDeliverList: async (a) => {
            probe.listWs.push(String((a && a.workspace) || ""));
            return { ok: true, dir: "", files: [] };
          },
          ltRunSave: async () => ({ ok: true }),
          ltMemAdd: async () => ({ ok: true, ids: [] }),
          ltMemRecall: async () => ({ ok: true, items: [] }),
          dshInteract: () => {},
        },
      },
      S: S,
      I18n: { t: (s) => s },
      document: { readyState: "loading", addEventListener() {}, getElementById() { return null; } },
      toast: (m, k) => probe.toast.push(String(m)),
      scheduleSave: () => { probe.saves++; },
      renderCanvas: () => { probe.renders++; },
      persistWf: (wf) => probe.persisted.push(String((wf && wf.id) || "")),
      currentVisibleWf: () => S.wf,
      canvasWfByIdLoaded: (id) => (S.wfBag || {})[String(id)] || null,
      canvasTargetWf: () => S.wf,
      runAgainstWf: (wf, fn) => {
        const prev = S.wf;
        S.wf = wf;
        try {
          return fn();
        } finally {
          if (S.wf === wf) S.wf = prev;
        }
      },
      wfWorkspace: () => String((S.wf && S.wf.workspace) || ""),
      makeNode: (kind, x, y) => ({ id: "mk" + ++nodeSeq, kind: kind, x: x, y: y, w: 360, h: 260, title: kind, text: "", cfg: {} }),
      uniqueNodeTitle: (t) => t,
      focusNode() {},
      addNode() {
        return null;
      },
      console, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp,
    };
    vm.createContext(sandbox);
    vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
    vm.runInContext(LTOUT, sandbox, { filename: "renderer/app-longtask-out.js" });
    vm.runInContext(LTART, sandbox, { filename: "renderer/app-longtask-artifacts.js" });
    vm.runInContext(LTSHELL, sandbox, { filename: "renderer/app-longtask-shell.js" });
    ok(!!sandbox.window.LT && !!sandbox.window.LTOUT && !!sandbox.window.LTART && !!sandbox.window.LTSHELL, "四份脚本在同一沙箱里整份执行并各自导出（顶层不碰 DOM）");

    const GRAPH = {
      nodes: [
        { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿", outKeys: ["draft"] } },
        { id: "h", kind: "human", title: "交稿", cfg: { mode: "deliver", uid: "ltx-1", items: [{ id: "i1", kind: "file", title: "分镜表.md", file: "分镜表.md", required: true, done: false }] } },
      ],
      edges: [],
    };
    const mkTask = (uid) => ({ uid: uid, name: "演示任务", graph: JSON.parse(JSON.stringify(GRAPH)) });
    const runA = sandbox.ltRunNew(mkTask("taskA"), "wfA", {});
    sandbox.ltInst(runA, "", runA.graph);

    /* ① 用户切到 B 画布：引擎这一笔仍写在 A（且不打扰用户的屏幕） */
    S.wf = wfB;
    const p0 = probe.renders;
    const nodeA = await sandbox.ltOutputPublish(runA, "a", { text: "第一版正文" });
    ok(!!nodeA && nodeA.kind === "ltout", "产出节点建出来了（内容没有丢）");
    eqNum(wfA.nodes.filter((n) => n.kind === "ltout").length, 1, "产出节点落在 run 的所属画布（wfA）上");
    eqNum(wfB.nodes.length, 0, "用户切过去的那张画布（wfB）上一个节点都没多");
    eqNum(probe.renders, p0, "不重绘用户屏幕（renderCanvas 没被叫：他正看着别的图）");
    ok(probe.persisted.indexOf("wfA") >= 0, "改的是后台那张 → 按对象自己的 id 落盘（persistWf(wfA)）");
    eqNum(probe.saves, 0, "也没有走前台保存通道（scheduleSave 一次都没叫）");

    /* ② 交付环节：交付目录 / manifest 都跟着 run 那张画布的工作目录 */
    const hNode = sandbox.ltNodeAt(runA, "h");
    await sandbox.ltExecHuman(runA, "h", hNode);
    eqNum((probe.ensureArgs && probe.ensureArgs.uid) || "", "ltx-1", "交付环节按 uid 建交付目录（流程照旧）");
    eqNum(probe.ensureWs[0], "D:\\projA", "交付目录创建带的是 run 所属画布的工作目录（不是 wfB 的 D:\\projB）");
    eqNum(runA.nodes["h"].status, "waiting_delivery", "本环节转入等交付（流程照旧）");
    ok(String(runA.nodes["h"].dir || "").indexOf("D:\\projA") === 0, "交付目录建在 wfA 的工作目录下（不是 wfB 的 D:\\projB）");
    const dNode = await sandbox.ltEnsureDeliverNode(runA, "h", hNode);
    ok(!!dNode && dNode.kind === "deliver", "交付节点建出来了");
    eqNum(wfA.nodes.filter((n) => n.kind === "deliver").length, 1, "交付节点落在 wfA 上");
    eqNum(wfB.nodes.length, 0, "wfB 依然干净");
    probe.listWs.length = 0;
    const syncRes = await sandbox.ltDeliverSyncFromNode(dNode);
    ok(!!syncRes, "在交付节点上改清单（界面入口）也认得出它属于 wfA");
    eqNum(probe.listWs[0], "D:\\projA", "磁盘对账读的交付目录用 wfA 的工作目录（不是 wfB 的 D:\\projB）");

    /* ③ 产物上画布同样落在 run 那张 */
    const artPath = "D:\\projA\\shots\\shotlist.md";
    setFile(artPath, 100, 10);
    const artRes = await sandbox.ltArtPublish(runA, "a", [artPath]);
    eqNum(artRes.placed, 1, "产物清点后摆了一颗");
    eqNum(wfA.nodes.filter((n) => n.kind === "ltart").length, 1, "产物节点落在 wfA 上");
    eqNum(wfB.nodes.length, 0, "wfB 依然干净");
    /* ③之二 关键件闸（本轮需求）：中间件 / 视频 / 日志不占画布，清点口径不动 */
    const midPath = "D:\\projA\\shots\\shots.json";
    const vidPath = "D:\\projA\\shots\\take-01.mp4";
    setFile(midPath, 100, 10);
    setFile(vidPath, 100, 10);
    const midRes = await sandbox.ltArtPublish(runA, "a", [midPath, vidPath]);
    eqNum(midRes.placed, 0, "中间件与视频一件都不摆");
    eqNum(midRes.own, 2, "但仍然照常清点（own 记着两件，文件没丢）");
    eqNum(wfA.nodes.filter((n) => n.kind === "ltart").length, 1, "画布上仍只有报告那一颗产物节点");

    /* ④ output 环节的相对路径按 run 那张画布的工作目录展开 */
    sandbox.ltStatePut(runA, "", "draft", "正文");
    await sandbox.ltExecOutput(runA, "b", { kind: "output", title: "落盘", cfg: { key: "draft", path: "out.md" } }, "");
    const wrote = probe.joins.filter((j) => String(j[1]).indexOf("out.md") >= 0);
    ok(wrote.length >= 1 && wrote[0][0] === "D:\\projA", "output 落盘路径展开用的是 wfA 的工作目录（D:\\projA\\out.md）");

    /* ⑤ 壳模块：绑定期间口径 = 归属画布，退出即还原 */
    sandbox.window.LTSHELL.bindWf(wfA);
    const boundId = sandbox.window.LTSHELL.boundWf();
    eqNum(String((boundId && boundId.id) || ""), "wfA", "壳模块绑定期间 ltsWf = 归属画布（即便 S.wf 是 wfB）");
    sandbox.window.LTSHELL.bindWf(null);
    const afterId = sandbox.window.LTSHELL.boundWf();
    eqNum(String((afterId && afterId.id) || ""), "wfB", "退出绑定后回到「当前画布」口径（界面入口不受影响）");

    /* ⑥ 用户切回 A：口径照旧 —— 该重绘就重绘、该走前台保存就走 */
    S.wf = wfA;
    probe.persisted.length = 0;
    const p1 = probe.renders;
    const again = await sandbox.ltOutputPublish(runA, "a", { text: "第二版正文" });
    eqNum(again.id, nodeA.id, "切回来再跑一轮：复用同一颗产出节点（不堆）");
    eqNum(wfA.nodes.filter((n) => n.kind === "ltout" && n.ltPath === "a").length, 1, "环节 a 的产出节点仍只有一颗（不堆）");
    ok(probe.renders > p1, "用户看着它的时候照常重绘（界面体验没有退化）");
    ok(probe.saves >= 1, "并走前台保存通道（scheduleSave）");
    eqNum(probe.persisted.length, 0, "前台那张不走 persistWf（两条落盘通道各写各的，不重复）");

    /* ⑦ 归属画布解析不到（已删 / 还没打开）：整笔不写，绝不落到用户看着的那张 */
    const runGone = sandbox.ltRunNew(mkTask("taskGone"), "wfGone", {});
    sandbox.ltInst(runGone, "", runGone.graph);
    eqNum(sandbox.ltRunCanvas(runGone), null, "ltRunCanvas：画布不在内存里就是 null（不退回前台）");
    S.wf = wfB;
    const kindsBefore = JSON.stringify(wfA.nodes.map((n) => n.kind + ":" + (n.ltPath || "")));
    const nothing = await sandbox.ltOutputPublish(runGone, "a", { text: "不该写出去" });
    eqNum(nothing, null, "产出发布整笔不写（返回 null）");
    eqNum(wfB.nodes.length, 0, "用户看着的那张画布一个节点都没多（宁缺勿错）");
    eqNum(JSON.stringify(wfA.nodes.map((n) => n.kind + ":" + (n.ltPath || ""))), kindsBefore, "run 自己的画布也没被硬塞（节点清单逐字未变）");
    has(JSON.stringify(runGone.log || []), "归属画布已不在", "并在 run 日志里留下一句「这一笔没有写」（用户看得见发生了什么）");

    /* ⑧ 会话档案：绑定会话的 canvasWfId 每次都校准到 run.wfId */
    let persistedSess = 0;
    sandbox.agentSessions = () => [];
    sandbox.agentContractSession = () => null;
    sandbox.persistAgentSession = () => { persistedSess++; };
    sandbox.ltBindAgentSession(runA, "a", sandbox.ltNodeAt(runA, "a"), { id: "p1" });
    eqNum(persistedSess, 0, "会话基建缺席时不装配（长任务照常跑，不抛）");

    /* ⑨ 创建期预建（本轮需求「创建即显示」）：壳 / 生成工作流 / 交付节点在**任务所属画布**
          上一次建好，一律只建不跑；启用后被认领（不重长）、按 uid 复用（不重复建）、
          用户删掉后不偷偷重长。口径与本节主线一致：一切「写哪张画布」只认任务自己那张。 */
    console.log("     · 创建期预建：落点一次建好（只建不跑）+ 启用后认领 / 复用 / 不重长");
    {
      const wfC = { id: "wfC", name: "C 项目", workspace: "D:\\projC", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 } };
      S.wfBag.wfC = wfC;
      S.wf = wfB; /* 用户此刻看着 B：预建必须全部落在任务所属的 C 上 */
      const GRAPH9 = {
        nodes: [
          { id: "s", kind: "start", title: "起点" },
          { id: "a1", kind: "agent", title: "写分镜", cfg: { goal: "写一版分镜", outKeys: ["draft"] } },
          {
            id: "h",
            kind: "human",
            title: "交稿",
            cfg: {
              mode: "deliver",
              uid: "ltx-9",
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
      probe.ensureWs.length = 0;
      const made9 = sandbox.window.LT.createFromGraph("预建演示", GRAPH9, wfC);
      ok(made9 && made9.ok === true, "在后台画布上创建任务：照常落库（收尾不影响创建本身）");
      const task9 = sandbox.ltTaskOf(wfC, made9.uid);
      eqNum(wfB.nodes.length, 0, "预建一处都没落进用户看着的那张画布（归属画布 = 任务自己那张）");
      const shells9 = wfC.nodes.filter((n) => n.kind === "super");
      eqNum(shells9.length, 2, "按图路径一次建齐：父壳 + 环节子壳（不再等跑到那一环才懒建）");
      const root9 = shells9.find((n) => !String(n.ltShellPath || "").trim());
      const step9 = shells9.find((n) => String(n.ltShellPath || "") === "a1");
      ok(!!root9 && !!step9, "父壳 / 环节子壳按 ltShellTask / ltShellPath 认得出身份");
      eqNum(String(root9.ltShellTask), String(task9.uid), "父壳绑定任务身份（与运行时懒建同一套字段）");
      const gens9 = wfC.nodes.filter((n) => String(n.parentSuperId || "") === String(step9.id) && n.ltGenType);
      eqNum(gens9.length, 1, "生成工作流预置到子壳里（缺省图像一枚）");
      ok(!gens9[0].running && !gens9[0].output, "预建的生成节点没有跑过（不替用户烧额度）");
      const dn9 = wfC.nodes.filter((n) => n.kind === "deliver");
      eqNum(dn9.length, 1, "交付环节的交付节点在创建那一刻就建好（旧口径要跑到才建）");
      eqNum(String(dn9[0].ltUid), "ltx-9", "交付节点按图里的交付 uid 认人（与运行时同一份身份）");
      eqNum(String(dn9[0].ltPath), "h", "交付节点带环节路径（清单 / 上传有宿主）");
      eqNum(String(dn9[0].ltRunId), "", "创建期没有 run：ltRunId 留空（启用后按同一 uid 复用这颗节点）");
      eqNum(dn9[0].__ltSystem, true, "交付节点带 __ltSystem（不进撤销栈、不能手动复制 / 新建）");
      eqNum((dn9[0].ltItems || []).length, 1, "图里的交付清单预置到节点上（创建完就知道要交什么）");
      ok(
        probe.ensureWs.length >= 1 && probe.ensureWs[probe.ensureWs.length - 1] === "D:\\projC",
        "交付目录 / manifest 落到该画布的工作目录（不落到用户看着的 B）",
      );
      ok(task9.enabled === false && !String(task9.activeRun || ""), "预建只建不跑：enabled 仍 false、没有 run");
      const nCount9 = wfC.nodes.length;
      sandbox.window.LTSHELL.ensureForTask(wfC, task9);
      eqNum(wfC.nodes.length, nCount9, "预建幂等：再叫一次节点数逐字不变");
      /* 启用 / 认领 / 删壳这几步：引擎是在包装层里 bindWf(run 的所属画布) 再进壳的，
         这里显式绑定同一个现场（用户此刻还看着 B）—— 壳的「哪张画布」判断只认它。 */
      const prevBind9 = sandbox.window.LTSHELL.bindWf(wfC);
      try {
        /* 启用（run 起来）之后：预建的壳被认领、交付节点按 uid 复用 —— 一处都不重复建 */
        const run9 = sandbox.ltRunNew(task9, "wfC", {});
        sandbox.ltInst(run9, "", run9.graph);
        const claim9 = sandbox.window.LTSHELL.ensure(run9, "a1");
        eqNum(claim9.created, 0, "预建壳被启用后的 ltsEnsure 认领：不新建壳");
        eqNum(wfC.nodes.length, nCount9, "认领不动节点：不重长壳、也不重复摆生成工作流");
        ok(
          !!run9.shellPaths && run9.shellPaths[""] === 1 && run9.shellPaths["a1"] === 1,
          "预建的壳按路径登记进 run.shellPaths（此后「删没删」按它判）",
        );
        const h9 = sandbox.ltNodeAt(run9, "h");
        await sandbox.ltExecHuman(run9, "h", h9);
        eqNum(wfC.nodes.filter((n) => n.kind === "deliver").length, 1, "跑到交付环节：按 uid 复用预建的那颗（不重复建）");
        eqNum(run9.nodes["h"].status, "waiting_delivery", "环节照旧转入等交付（流程不变）");
        await sandbox.ltRebindDeliverNodes(run9);
        eqNum(
          wfC.nodes.filter((n) => n.kind === "deliver").length,
          1,
          "恢复现场链路（ltRebindDeliverNodes）也按同一 uid 认人复用（仍然只有一颗）",
        );
        /* 用户把预建的壳删掉：认领过就该按墓碑口径走 —— 只提示不重建 */
        wfC.nodes = wfC.nodes.filter((n) => String(n.ltShellTask || "") !== String(task9.uid));
        const gone9 = sandbox.window.LTSHELL.ensure(run9, "a1");
        eqNum(gone9.gone, true, "预建壳被用户删掉 → gone = true（认领之后照旧不偷偷重长）");
        eqNum(wfC.nodes.filter((n) => n.kind === "super").length, 0, "画布上没有壳被静默重建");
        eqNum(run9.shellGone, true, "墓碑落在本 run 上（run.shellGone），提示只发一次");
      } finally {
        sandbox.window.LTSHELL.bindWf(prevBind9);
      }
      S.wf = wfB;
    }
  }

  /* ══════════════ [3] i18n ═══════════════ */
  function part3() {
    console.log("\n[3] 拒绝句中英成对（切英文不改回中文）");
    const KEYS = [
      "归属画布已不在（或还没打开），这一笔没有写：",
      "交付节点",
      "交付节点对齐",
      "产出节点",
      "产出回流",
      "长任务壳",
    ];
    I18n.setLocale("en");
    const noEn = KEYS.filter((k) => I18n.t(k) === k);
    ok(noEn.length === 0, KEYS.length + " 条词条都有英文译文" + (noEn.length ? "（缺：" + noEn.join(" | ") + "）" : ""));
    I18n.setLocale("zh");
    ok(KEYS.every((k) => I18n.t(k) === k), "中文档逐条原样返回（词条结构未被破坏）");
  }

  async function main() {
    await part2();
    part3();
    console.log(
      "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-longtask-canvas)",
    );
  }
  main().catch((err) => {
    console.log("\n测试异常：" + ((err && (err.stack || err.message)) || err));
  });
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-canvas.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-canvas.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

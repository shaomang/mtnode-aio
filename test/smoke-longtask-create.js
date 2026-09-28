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
 *       app-nodes 分发 + app_ops 工具 + 规划模式拒绝 + 回滚记账不放行
 *   [5] 引擎真行为（vm 里跑）：LT.createFromGraph 的归一 / 校验拒绝 / 落库字段
 *   [6] 装配与文案：index.html 脚本顺序 / longtask.css / i18n 中英词条
 * 只读断言：不改任何文件、不起 Electron。
 */
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
const ROLLBACK = read("dsh/gateway/rollback-plugin.mjs");
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
hasnt(ROLLBACK, "create_longtask", "回滚记账不放行 create_longtask（APP_READ_ONLY_ACTIONS 未收它 = 按写操作处理）");
has(ROLLBACK, "APP_READ_ONLY_ACTIONS", "回滚插件的只读名单仍在（对照断言有效）");

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
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.log("测试异常：" + String((e && e.stack) || e));
  process.exit(1);
});

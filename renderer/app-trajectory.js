/*
 * 本轮（事件详情可拖宽 + 代码编辑同款 diff · 用户口径两条 · 拷问已确认）：
 *   [26] **详情栏可拖动调宽**：检查器（.dsh-trace-insp）过去写死 flex:0 0 340px，
 *       现在在它**左边缘**加一条可拖动的分隔条（.dsh-trace-divider，见 bindInspResize）：
 *       按住左右拖 = 改详情栏宽（向左拖变宽），松手才落盘一次。口径：
 *         · 默认 340 / 最小 220 / 最大 = 宿主宽 60%（列表至少留 40%）——夹取只在
 *           clampInspW 一处（CSS 里不再写死 min-width，两处都写就会互相打架）；
 *         · 宽度只写 .dsh-trace-cols 的 CSS 变量 --dsh-trace-insp-w（检查器读它），
 *           宿主宽量 .dsh-trace-cols 自己的矩形（不被详情栏宽度反向影响）；
 *         · 双击分隔条复位 340；宽度存本机 localStorage 一条（mtnode.traceInspW，
 *           与文件预览栏 mtnode.baW / 浏览器栏 mtnode.baOpen 同口径，数据不落应用目录）；
 *         · 没选中事件（检查器收起）时分隔条一并收掉（syncInspDivider），不留看不见的拖动条；
 *         · 分隔条宽度 0 + 左移 1px、命中区横向 ±4px（CSS）：不占布局，60% 量的仍是真宿主宽。
 *   [27] **编辑类事件给与对话一模一样的 diff**（用户口径「所有代码编辑也应当实现与对话中
 *       代码 diff 一致的样式」）：检查器里**差异置顶**（.dsh-diff 皮，与对话工具卡逐像素同源），
 *       原「参数」分节改为**默认收起**的可展开 details（与「结果」分节同长相），结果照旧。
 *       实现口径（别再抄一份算法回来）：算法与皮肤都在 app-assist.js 那三个函数里，
 *       由该文件挂到 window.MTNodeChatDiff（全仓唯一一处）；轨迹这边只当薄层
 *       （chatDiffOf / chatDiffEl）——认哪些工具是编辑类（write|write_file|create_file、
 *       edit|edit_file|str_replace_editor|apply_patch）、行级 diff 怎么算、折叠 9 行，
 *       一律以那边为准。全局拿不到就只是不显示 diff，检查器照常给参数 / 结果。
 *
 * 会话 · 运行轨迹视图（renderer/app-trajectory.js + css/dsh-tokens.css 的 .dsh-trace-*）
 *
 * 定位（对齐上游 dsh-client-ui-trajectory 的 View 口径）：
 * 上游把「轨迹」做成**会话壳里的第二个 View** —— 会话头部一排「对话 / 轨迹」标签，
 * 选中轨迹就把主区换成「按轮次组织的记录表 + 时间概览 + 检查器」；右栏留给
 * 浏览器活动与文件预览（本仓第三栏的用途见 app-browser.js / app-fileview.js）。
 * 本模块因此从「右栏的一块面板」升为「会话主区里的第二个视图」：
 *   · 标签栏常显（不再受设置·开发者工具约束）；
 *   · 设置·开发者工具现在管的是**检查器**（参数 / 结果 / 代码行号高亮这些开发者向的明细）
 *     —— 关掉时轨迹仍可浏览，只是不给明细入口（见 devOn()）。
 *
 * 数据来源全是**已有数据**，不新增会话接口、不新增落盘：
 *   · collectSegments：agentTraceItems("agent:<id>") 优先，回落
 *     agentChatSegItems(st)，再回落**历史消息里的段快照**（histSegmentsOf）
 *     （段模型见 app-db.js 的 runTrace：think / say / tool / err / ctx）；
 *   · 工具明细：会话里的工具记录（历史在 st.messages[].tools，本轮在 st._liveTools），
 *     按 callId 对齐 —— 参数、结果、错误、起止时间都在那儿，检查器只是把它摊开。
 *
 * 时间口径：工具记录带 at（发起）与 doneAt（结果回来，见 app-assist.js 的 tool-result
 * 分支）；拿不到带真实时刻的记录就整条轴不画（不编时间）—— 这条口径本轮升为「窗口轴」。
 *
 * 本轮完善（对齐上游「按轮次组织的记录表 + 虚拟行 + 历史分页 + 交互式概览 + 检查器」）：
 *   [1] 记录表按**轮次**分组（轮头可折叠；全折 / 全展在工具栏）；
 *       段行仍逐行携带 dataset.segIdx —— 轨迹 ↔ 对话的双击定位口径不变。
 *       **轮号口径（本次需求 · 用户已确认）**：第 N 轮 = 该会话里**用户第几次发送**；
 *       同一次发送的思考 / 正文 / 工具 / 错误全部归到同一个轮头下。**不再拿网关的 turn
 *       值当轮头编号** —— turn 是「模型往返次数」，一次发送里调几次工具就会 +1，按它分轮
 *       会把正文与工具拆到不同轮里（用户报的「一个在第一轮、一个在全部」正是这个成因：
 *       段上根本没记轮号，历史上只有思考段带过 turn）。轮号随段快照落盘（app-db.js 的
 *       traceSegmentsOf 写 round，开轮时由 app-assist 的 agentRoundOfRun 算好）；
 *       拿不到轮号的老存档走「全部」兜底 —— 绝不按顺序推断轮号（用户口径）。
 *       轮头下**不再有**「助手 · N 步」二级分组行：段行直接挂在轮头下。
 *   [2] **真虚拟滚动**：只挂可视行（上下各留一段缓冲），靠一只占位块撑出总高；
 *       行高统一固定（长内容默认折成一行，展开态脱离虚拟窗口全高列出）。
 *   [3] 顶部**按需加载更早一页**（滚到顶自动补一页，或点加载行）；加载期间给明确的
 *       加载行，不静默留白。
 *   [4] 进入视图定位到**尾部并跟随**；用户一旦上滚即**暂停跟随**，给一枚「回到底部」，
 *       新记录不再打断对旧记录的检查（上游同口径）。
 *   [5] 工具栏：搜索框（命中轮次 / 步骤 / 工具名 / 段首行文本）+ 全折 / 全展 + 命中计数与
 *       上一条 / 下一条。**本轮已整条撤掉**（见 [15]）。
 *   [6] 检查器升级：每步 token 与步间隔（按 usage 事件的时刻就近归步，配不上就不显示）、
 *       参数与结果给 JSON 树 + 「树形 / 代码」切换 + 复制。
 *
 * 本轮（会话 · 轨迹可读性收口 · 用户口径五条）：
 *   [15] **顶部搜索条整条移除**：.dsh-trace-bar（搜索框 + 命中计数 + 回车 / Shift+回车导航）
 *       连同 rowSearchText / applySearch / reSearch / stepHit / hits / hitAt / 命中环 .hit、
 *       i18n 词条与 css 规则一起撤掉；视图最上方现在就是那条总轴，腾出整整一行高度。
 *   [16] **总轴抬高、方块放大**：--dsh-trace-ruler-h 62 → 96px、--dsh-trace-track-h 7 → 14px
 *       —— 抬高的直接理由是原高度（62px）装不下脚下两行，图例被 .dsh-trace-ruler 的
 *       overflow:hidden 裁掉（内容 58px > 内框 54px，用户报的「legend 被遮挡」）；
 *       方块由 5px 高变 12px 高，真正点得中。轨数仍固定 3 条、超出照样叠画。
 *   [17] **段行套对话皮**：思考 = 灰左轨 + 极淡底 + 灰字、工具 = 青左轨 + 青底 + 等宽青字、
 *       正文 = 无轨正文、失败 = 红轨（与 .dsh-seg-think / .dsh-seg-tool / .dsh-seg-say 同款）；
 *       行高（--dsh-trace-row-h 32px，虚拟滚动按它算）与左侧定宽读数栏保持不变。
 *   [18] **token 输入蓝 / 输出绿**：行内读数栏与检查器都用两段带色 span
 *       （.dsh-tok-in = --cyan / .dsh-tok-out = --green），与左下角 Token 报告同一套类名。
 *   [19] **撤掉「展开全文」**：正文 / 思考一律单行省略号，展开态（expandedKey / toggleExpand /
 *       .dsh-trace-full）整条删除 —— 完整内容在右侧检查器与对话视图里看。
 *   [20] **右侧检查器铺满高**：.dsh-trace-cols 改 flex:1 1 auto 吃掉剩余高，
 *       参数 / 结果代码块弹性分配剩余高度（不再各自封顶 260px、下方不留死区）。
 *
 * 本轮（横轴收口 · 用户口径两条）：
 *   [21] **移除横轴的闪烁特效**：轴上「还在跑」的色块原先走 @keyframes dsh-ruler-run
 *       做一次 1.25s 呼吸（描边深浅 + 外发光来回），用户口径是横轴上不许有闪烁 ——
 *       现在 run 态是**静态**的：描边走本块族色（--dsh-seg）+ 一层同族柔光，
 *       box-shadow 定值、没有任何 animation / @keyframes 残留；「还没回来」仍看得出
 *       （行内那条行首柔光 .dsh-trace-row.run 不动）。
 *   [22] **滚轮横向拉伸（局部拉近）**：轴身上滚滚轮 = 以**指针下的那个时刻**为锚横向
 *       拉伸 / 压缩 —— 锚点时刻在轴上不动，指针附近那一段变化最大（局部拉伸），
 *       刻度 / 色块 / 滑窗带三者同一套横坐标一起缩；滚上拉近、滚下推远，每 100px 一档 25%，
 *       最多拉近到全跨度的 1/40；双击轴或按 Esc 回全轴。缩放只改「画出哪一段时间」，
 *       不动任何记录；本视窗的时间段滑出窗外时本帧把窗平移回去（拉伸不会把视窗弄丢）。
 *       未缩放时几何与上一版**逐位相同**（domainOf 回 null → 仍按全轴画）。
 *       缩放态在脚下读数的末尾可见（「缩放 2.4×」，带 tooltip），换会话归零。
 *
 * 本轮（滑窗拖动与行皮肤 · 用户口径两条）：
 *   [23] **滑窗带可拖动平移时间**：按住 .dsh-trace-window 左右拖 = 把视窗平移到那一段时间，
 *       下方列表随之滚到对应位置；拖的只是「看哪一段」——**窗长不变**，带子不被拖长 / 拖短。
 *       实现口径（别改回去）：
 *         · 带自身在 CSS 里 **pointer-events:none**（未按下时绝不挡块的点击与 hover），
 *           拖动入口因此挂在轴身上：pointerdown 的落点落在**带自己的矩形**里才算「可能的拖动」；
 *         · 位移过阈值（DRAG_SLOP = 4px）才真的进拖动态：**此时才 setPointerCapture**
 *           （按下即捕获会把带上的块整个吞掉 —— 点在带里的块上仍必须是「选行」）、
 *           光标切 grabbing、轴与带各挂 .dragging，带自此才改吃指针（拖动期间不与块抢 hover）、
 *           followTail 置 false（拖动期间不跟随；松开后由 scroll 监听里那条既有判据自然恢复）；
 *         · 折算与滚轮同源：本帧 domain（fr.dom，缩放后 = 拉近的那一段）的尺度 × 指针横向位移
 *           → Δ时间；窗整体平移、**窗长不变**，并夹进本会话全轴 [min,max]（贴住全轴即归零，
 *           与滚轮同一条夹法）；未缩放时全轴装得下整个会话、没有可平移的缩放窗，平移的对象
 *           就是**滑窗带本身**（本视窗那段真实时刻区间，窗长 = 这段跨度，同样夹进全轴），
 *           两端到头即停；
 *         · 列表跟随：把平移后的窗**中点时刻**交给「滚到某一行」那条既有通路（轴上点块选行
 *           同一份口径：按时刻找最近的段行 → 按行号算 scrollTop → renderRows 把那一带挂出来）
 *           —— 列表滚 → 带由可见行的真实时刻重算 → 带随动，闭环；拖动只滚列表、不改选中；
 *         · 收尾：pointerup / pointercancel 释放捕获、摘光标与 .dragging；**位移过了阈值即吞掉
 *           本次 click / dblclick**（在 document 捕获阶段截住：拖动绝不等于点块选行，也绝不让
 *           「双击轴」把刚拖到的窗归零）；按下不动就仍是一次普通点击，块照常可点；
 *         · 拖动中读数写在脚下那一行（「拖动中 · 窗 起–止」，带 tooltip），带自己的 tooltip
 *           加一句「按住拖动…」（中英成对，见 renderer/i18n.js）。
 *       滚轮局部拉伸、双击 / Esc 回全轴（回全轴那一帧顺带结束在拖的那一次）、换会话归零
 *       三条口径照 [22] 不变。
 *   [24] **行的色块与左轨与对话一致**：轨迹段行的皮肤照对话视图（css/dsh.css 的 .dsh-seg-*）
 *       再对一次 —— 左轨 **2px**（box-shadow inset，不占布局）、行的**右侧圆角**、
 *       对话同款淡底；段型配色（思考灰轨 / 工具青轨 / 正文无轨 / 失败红轨）与行高
 *       （--dsh-trace-row-h 32px）一个字不动（皮见 css/dsh-tokens.css 的 .dsh-trace-row.t-*）。
 *
 * 本轮（横轴交互与皮肤 · 用户口径五条 · 拷问已确认）：
 *   [25] **点上轴任意时刻就把滑窗移过去**：窗长不变、点击处对齐**窗中点**（与拖动平移
 *       同一套折算），缩放态平移的就是缩放窗本身（贴住全轴即归零，与滚轮同一条夹法），
 *       未缩放时平移的是**滑窗带**、中点交给列表跟随那条既有通路。点**事件方块**仍是
 *       「选中该行」+ 同时移窗（选中那条通路走 document 捕获阶段，本段只管移窗）；
 *       缩放态点一下**不回全轴**（用户口径）；刚拖完那一下由 swallowAfterDrag 整条截住。
 *       **hover 绿线**（.dsh-trace-hoverline）：指针在轴里时一条竖直绿线 + 一枚时刻读数，
 *       线自身做透明度呼吸（方块仍然静态无发光），移出即收；它不吃指针、不进几何签名，
 *       滚动 / 缩放把绘图区重建之后由 paintHover() 按 hoverOn / hoverF 补回来。
 *       **禁掉误拖选**：轴与轨迹列表整块 user-select:none（检查器不在其中 —— 那里仍要能
 *       选中复制）；滑窗带拖动平移照旧保留。
 *       **事件方块改带边框实心块**：填充 = 族色（--dsh-seg），1px 边框 = 同族深一档，
 *       移除全部发光边缘（hover 只提亮边框；run 态改「描边加粗 + 填充轻微提亮」）。
 *       **每步 token 归步修复**（用户报「token 未记到」）：usage 落在**它自己这一步的工具
 *       调用之前**（实测会话日志 +2ms），旧判据把它归给上一步、末尾几步永远「未记到」；
 *       现在按 (轮号, step) 分组、以「跨过 usage 的那一步」归步，token 只显示在该步**最后
 *       一段**那一行（见 tokenPlan）。
 *
 * 历史（横轴：整个会话的总时间轴 + 当前视窗的滑窗带 · 用户口径「上方的横轴条应当显示整个
 * 时间轴，并把当前视窗内的时间段用一个 sliding window 来表示」）：
 *   [11] **一条轴**：列表里那条 sticky 吸顶轴撤掉，列表外那条覆盖整个会话的总时间轴在本模块
 *       升级成**唯一**一条：位置不变（工具栏下方、列表外），列表自己滚动、轴常驻其上。
 *   [12] **全轴 + 滑窗带**：横坐标范围 = **整个会话**最早一次调用的 at … 最晚一次的 end；
 *       刻度是这段跨度内等距的绝对时刻（数量按宿主宽度分档 <420px→2 / <760px→3 / 更宽→4）；
 *       当前滚动视窗对应的时间段用一条半透明「滑窗带」（.dsh-trace-window）叠在轴上，
 *       随滚动每帧实时移动（几何签名未变就不重建 DOM）。窗口边界只取视窗内**真实**时刻的
 *       min / max —— 视窗内一条带时刻的调用都没有时**只是不画那条带**（轴照常显示），
 *       绝不按行号比例估算或插值。
 *   [13] **固定 3 轨**：轴内固定 3 条轨、不足补空轨（轴高恒定，不再随轨数长高）；同一时刻
 *       超过 3 个调用时并回已有轨叠画（轨上给一枚「叠 N」计数，不藏数据）。图例仍按**整个
 *       会话**累计计数（不随滚动变）、读数行报**本视窗**步数 / 跨度 / 起止时刻。
 *   [14] **工具栏瘦身**：右端那四枚按钮（上一条 / 下一条 / 全折 / 全展）按用户口径**全部移除**，
 *       命中导航改挂搜索框的回车 / Shift+回车；轮次仍可单点轮头折叠。
 *
 * 历史（时间轴可读性 · 用户报「总时间压在时间轴上、块全都一个色、并行与子代理分不出」）：
 *   [7] **读数挪位**：吸顶轴右侧那行读数原先是绝对定位（right/bottom）压在色块轨道带上，
 *       现在与图例一起排在轨道**下方**各占一行；轨区自己封顶，轴长高绝不吃掉脚下两行。
 *       列表最上方那条 26px 概览带（renderOverview）当时未动 —— 本轮 [11] 已把它整只撤掉。
 *   [8] **按工具族上色**：轴上的块 = 一次工具调用，块色取「工具族」（TOOL_FAMILIES 按
 *       工具名粗分 9 族 + 兜底「其它」，色令牌 --dsh-fam-*）；列表里那一行的工具名同族
 *       同色；失败压过族色（轴上块与列表行同一口径），运行中的呼吸也走本块族色。
 *   [9] **图例**：轴脚下第二行，只列本会话（不是本屏）出现过的族 + 调用次数，固定顺序、
 *       只读不可点。
 *   [10] **多行**：主流（非子代理调用）固定从第 1 轨起用「第一个空闲轨」；子代理调用
 *       （TOOL_FAMILIES 的 sub 族）各占一条专属轨并在轨左留一枚「子代理」小字；
 *       严格归属要网关给会话 id（工具事件只有 callId/turn/step），故其跨度内的其它调用
 *       按**时间跨度**做启发式并轨，不改网关、不动 app-db.js / app-assist.js 的数据。
 *
 * 自包含：不引入框架，不碰 app-browser.js 内部；出口 window.MTNodeTrajectory。
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);

  /* 会话对象的取用口径（**这里踩过坑，别再改回去**）：
     `S` 是 app.js 顶层的 `const S = {…}`（全局词法环境里的绑定），**不是 window 的属性** ——
     老写法 `window.S && …` 恒为假：activeSession() 永远返回 null → 标签栏恒 hidden、
     主区恒 hidden，「对话 / 轨迹」两枚标签一次都出不来（用户报的「轨迹无法显示」）。
     一律直读 `S` 并做 typeof 守卫（同源模块里凡直读 S 的都照这个口径）。
     拿哪条会话：activeAgentId()（app-assist.js 的唯一口径：覆盖态 / 选中项都算进去，
     取不到就回落列表首条）—— 别再自己写 S.agentActive（那是另一个不存在的字段）。 */
  function sessionsList() {
    try {
      return typeof S !== "undefined" && S && Array.isArray(S.agentSessions)
        ? S.agentSessions
        : [];
    } catch {
      return [];
    }
  }
  /** 开发者工具开着？（缺配置 = 默认开，与 app-boot.js 的缺省合并同口径）
   *  只管「检查器 / 代码高亮」这类开发者向明细 —— 轨迹标签本身常显。 */
  function devOn() {
    try {
      const d = (typeof S !== "undefined" && S && S.config && S.config.dsh) || {};
      return d.developerTools !== false;
    } catch {
      return true;
    }
  }

  function activeSession() {
    try {
      if (typeof activeAgentId === "function") {
        const id = String(activeAgentId() || "");
        if (id) {
          if (typeof agentSessionById === "function") return agentSessionById(id) || null;
          const hit = sessionsList().find((s) => s && s.id === id);
          if (hit) return hit;
        }
      }
      const list = sessionsList();
      if (!list.length) return null;
      const want = String((typeof S !== "undefined" && S && S.agentActiveId) || "");
      return (want && list.find((s) => s && s.id === want)) || list[0] || null;
    } catch {
      return null;
    }
  }
  function activeSessionId() {
    const st = activeSession();
    return st && st.id ? String(st.id) : "";
  }

  /* 本轮实时轨迹上的**会话轮号**（段自己不带它，见 app-assist.js 的 agentTraceRound /
     agentRoundOfRun）：同一次发送的全部段因此归到同一个「第 N 轮」。拿不到回 null。 */
  function traceRoundOf(rk) {
    try {
      return typeof agentTraceRound === "function" ? agentTraceRound(rk) : null;
    } catch {
      return null;
    }
  }

  /* 历史轮次段与本轮 live 段的合并（本次需求的唯一一处判据；抽成独立函数是为了让
     test/smoke-think.js 能按函数名抓到它，与 collectSegments 一起在沙箱里真跑）。
     返回「该保留的历史段」（本轮 live 段由调用方接在后面），三条规则：
       ① 历史段的 round 与本轮不同 → 保留（这就是旧轮不再消失的那一步）；
       ② round 相同 → 由 live 段代表本轮（同一轮刚跑完还没归档时 live 更全），
          不整轮丢历史 —— 先去掉与 live 段完全同一份（k+text+step+callId）的重复项，
          再只丢「对齐到尾部、内容也一致」的那一段（老存档段上常没有 round，
          只能按这个弱判据认；对不上的一律当旧轮留着）；
       ③ 段上没有 round（老存档 / 非会话运行）→ 只有当它确实是尾部那一段的重复时才丢，
          其余一律保留 —— 宁可多留一份，也绝不凭空丢掉旧轮。 */
  function agentSegsMergeRounds(hist, live, liveRound) {
    /* 尾部对位用的弱签名：只比「段类 + 正文 + 步号」，**不比 callId** ——
       落盘的 tool 段在 app-db.js 的 traceSegmentsOf 里就不带 callId（它由展示层按
       m.tools 的 callId ↔ step 配对补回来），live 段却带着；拿 callId 一起比会让
       「同一份段的两种形态」永远配不上，于是老存档段被重复显示一遍。 */
    const tailSigOf = (s) =>
      [String(s && s.k), String((s && s.text) || ""), s && s.step == null ? "" : s.step].join(
        "\u0000",
      );
    const sigOf = (s) => tailSigOf(s) + "\u0001" + (s && s.callId == null ? "" : s.callId);
    const liveSigs = Object.create(null);
    for (const s of Array.isArray(live) ? live : []) liveSigs[sigOf(s)] = 1;
    const kept = [];
    for (const s of Array.isArray(hist) ? hist : []) {
      if (liveSigs[sigOf(s)]) continue;
      if (liveRound != null && s && s.round != null && String(s.round) === String(liveRound))
        continue;
      kept.push(s);
    }
    /* 尾部对位：i of kept ←→ i of live（都从最后一段往前比）。只有「对齐到尾部、且段类 /
       正文 / 步号都同一份」的才算本轮 live 的同一份 —— 老存档的 tool 段不带 callId
       （见上面的弱签名），拿 callId 比就永远配不上；而**尾部对位 + 步号相等**这三点
       同时撞上的概率只可能是「同一份段的两种形态」（相邻两轮的步号会递增、不会相等）。
       对不上的一律当旧轮留着，绝不整段丢。 */
    const hi = kept.length;
    const li = Array.isArray(live) ? live.length : 0;
    let pair = 0;
    while (pair < hi && pair < li) {
      const h = kept[hi - 1 - pair];
      const l = live[li - 1 - pair];
      if (!h || !l) break;
      if (tailSigOf(h) !== tailSigOf(l)) break;
      pair++;
    }
    return pair > 0 ? kept.slice(0, hi - pair) : kept;
  }

  /* 段列表 = **已归档的历史轮次段快照 + 本轮实时轨迹（agentTraceItems）**，两者**合并**
     （本次需求 · 用户口径「本会话每一轮都长期保留，按第 N 轮回看」）。
     过去这里是「live 非空就直接 return」的三段回落：旧轮次的段只活在每条助手消息的
     m.segments 里，一开第二轮（app-db.js 的 traceReset 把 items 清成新轮）旧轮就整段
     从轨迹里消失 —— 用户报的「连发第二轮后切到轨迹 / 改动就只剩最后一轮」正是它。
     合并口径：历史段一律保留（按轮号分组，见 buildRows），本轮 live 段**覆盖同轮**的
     历史段 —— 同一轮刚跑完还没归档时，live 是更全的那一份，两边都在时不能一份显示两遍。
     回落到「会话已渲染的段」（agentChatSegItems）只在**没有任何已归档历史**时兜底
     （节点绑定运行等 live 段尚未落盘的形态）。
     三者都归一成 [{k,text,step,callId,round,at}]（round = 会话轮号，见文件头 [1]）。

     ⚠ 不许在这里按「显示思考」过滤（本次需求 · 用户口径，这条是硬不变量）：
     会话输入区「模式」菜单里那枚「显示思考」**只是会话视图的渲染开关** —— 关闭 =
     对话里思考段根本不建 DOM（renderer/app-assist.js 的 dshHistSegEl / agentLiveSegsEl
     提前早退）。轨迹是**完整过程记录**，与那个开关无关：关掉之后思考行照旧按行出现
     （默认收起，点行 / 看检查器看全文），工具调用行、时间轴、检查器明细一个都不少。
     数据侧本来就不受开关影响（app-db.js 的 tracePush / traceSegmentsOf 不问 showThink），
     所以这里一旦哪天顺手加一句 `if (!agentThinkShown(st)) …`，用户看到的就是
     「轨迹跟着思考一起空了」——那正是本次要修掉的错。判据只许落在会话渲染侧。 */
  function collectSegments(sid) {
    const rk = "agent:" + sid;
    const norm = (items, defRound) => {
      const out = [];
      for (const it of Array.isArray(items) ? items : []) {
        if (!it) continue;
        const k = String(it.k || it.kind || "");
        if (!k) continue;
        out.push({
          k,
          text: String(it.text == null ? "" : it.text),
          step: it.step,
          round: it.round == null ? defRound : it.round,
          callId: it.callId == null ? "" : String(it.callId),
          /* 段自己的到达时刻（app-db.js 的 tracePush 在新起一段时写）：**每步 token 的
             时间锚点**（本轮修复）。老网关 / 老段没有它 → 0，届时退回工具记录的 at。 */
          at: Number(it.at) || 0,
        });
      }
      return out;
    };
    try {
      if (typeof agentTraceItems === "function") {
        const liveRound = traceRoundOf(rk);
        const live = norm(agentTraceItems(rk), liveRound);
        if (live.length) {
          /* 已完成的历史轮次（每条助手消息的 m.segments）与本轮 live 段合并：
             live 段的轮号就是本轮，所以按轮号剔掉历史里**属于本轮**的那一份
             （同一轮刚跑完、归档还没落地时 live 更全，两边都在时不能一份显示两遍），
             其余轮次一条不丢 —— 这就是「连发第二轮后旧轮不再消失」的那一步。 */
          const st =
            typeof agentSessionById === "function" ? agentSessionById(sid) : activeSession();
          const hist = histSegmentsOf(st);
          const kept = agentSegsMergeRounds(hist, live, liveRound);
          /* 只有真的还有别的轮次时才拼：kept 为空 = 历史里那几条本来就是本轮 live 的
             同一份（老存档段上没有 round）→ 原样回 live，段序与轮号都还是 live 那一份。 */
          return kept.length ? kept.concat(live) : live;
        }
      }
    } catch {
      /* 运行时形态变了就回落 */
    }
    try {
      const st = typeof agentSessionById === "function" ? agentSessionById(sid) : activeSession();
      const hist = histSegmentsOf(st);
      if (hist.length) return hist;
    } catch {
      /* 同上 */
    }
    try {
      if (typeof agentChatSegItems === "function")
        return norm(agentChatSegItems({ id: sid, running: true }), traceRoundOf(rk));
    } catch {
      /* 同上 */
    }
    return [];
  }

  /* 已跑完的历史会话：段快照在**每条助手消息的 m.segments 里**（app-assist.js 的
     agentRoundMsgTail 落盘），这是历史轨迹的唯一来源 —— live 轨迹（agentTraceItems）只在
     本轮运行期间存在，agentChatSegItems 也要求会话正在跑（st.running + 有取消句柄）。
     缺了这条回落，切到轨迹视图只会看到「还没有可看的轨迹」空态（老数据用的是 `_segs`
     字段，一并兼容读取）。
     工具段补 callId：落盘的工具清单（m.tools）里存着 callId，段里若没写，按 app-assist.js
     dshSegToolAt 的同一口径（callId → step）配对补上 —— 检查器的参数 / 结果、行内耗时
     全靠它对齐，配不上就只显示段自身的内容，不编。 */
  function histSegmentsOf(st) {
    const out = [];
    if (!st) return out;
    for (const m of Array.isArray(st.messages) ? st.messages : []) {
      if (!m || m.role !== "assistant") continue;
      const segs = Array.isArray(m.segments)
        ? m.segments
        : Array.isArray(m._segs)
          ? m._segs
          : null;
      if (!segs || !segs.length) continue;
      const pool = Array.isArray(m.tools) ? m.tools.slice() : [];
      for (const sg of segs) {
        if (!sg || !sg.k) continue;
        let callId = sg.callId == null ? "" : String(sg.callId);
        if (sg.k === "tool" && !callId && pool.length) {
          let at = -1;
          try {
            if (typeof dshSegToolAt === "function") at = dshSegToolAt(pool, sg);
          } catch {
            at = -1;
          }
          if (at < 0) {
            for (let i = 0; i < pool.length; i++) {
              const t = pool[i];
              if (t && sg.step != null && t.step === sg.step) {
                at = i;
                break;
              }
            }
          }
          if (at >= 0) {
            const t = pool.splice(at, 1)[0];
            if (t && t.callId != null) callId = String(t.callId);
          }
        }
        out.push({
          k: String(sg.k),
          text: String(sg.text == null ? "" : sg.text),
          step: sg.step,
          /* 落盘段快照带的会话轮号（app-db.js traceSegmentsOf 写）；老数据没有 → null，
             展示层据此走「全部」兜底，不推断轮号。 */
          round: sg.round == null ? null : sg.round,
          callId,
          /* 老存档段快照不带 at（当时没落这一位）→ 0，归步退回工具记录的 at / 按序对位 */
          at: Number(sg.at) || 0,
        });
      }
    }
    return out;
  }

  /* 工具记录表（callId → 记录）：历史消息里的 st.messages[].tools + 本轮 st._liveTools。
     记录形状见 app-assist.js 的 onEvent 工具分支：{callId,turn,step,name,args,result,error,at}。 */
  function toolMapOf(st) {
    const map = new Map();
    if (!st) return map;
    const put = (t) => {
      if (!t || t.callId == null) return;
      const k = String(t.callId);
      const cur = map.get(k);
      /* 后写的补前一条缺的字段（历史记录比 live 记录更全时以历史为准） */
      map.set(
        k,
        cur
          ? Object.assign({}, cur, t, {
              args: t.args || cur.args,
              result: t.result || cur.result,
            })
          : t,
      );
    };
    for (const m of Array.isArray(st.messages) ? st.messages : []) {
      for (const t of Array.isArray(m && m.tools) ? m.tools : []) put(t);
    }
    for (const t of Array.isArray(st._liveTools) ? st._liveTools : []) put(t);
    return map;
  }

  /* ── 每步 token（本轮修复 · 用户报「轨迹里每步的 ↑入/↓出 在部分步上查不到」）──────
     真源（本次需求）：**采集点自带 (轮号, 步号) 的明细** —— app-assist.js 的
     tokUsageStepNote 在 usage 到达那一刻写下 {turn, step, calls, input, output,
     cacheRead, cacheWrite, reasoning, provider, model}，随助手消息落盘（m.usageSteps）。
     渲染直接按键取数：段的 (round, step) → 明细里同一步那一条。**不再猜**。
     为什么必须换掉旧判据：usage 帧本身不带 turn/step（网关的 accountUsage 只发
     provider/model/at），旧口径只能拿「段自己的到达时刻」与 usage 时刻比大小来推断
     （TOK_JITTER_MS / TOK_TOOL_FOLLOW_MS + p/q 邻段关系）—— 当 usage 之后、下一步的
     任何段之前悄悄隔了一段时间（真实会话里很常见），它就整条被归给**上一步**，
     于是「这一步」永远显示未记到（用户看到的正是这个）。
     兜底（老数据 / 非会话运行）：st._tokUsageTimeline 的内存时间线照旧按时刻就近归步
     （老轮次不回填，用户口径：只从改版后的新会话开始记）；两边都没有 → 不显示数字。
     显示位（用户口径不变）：一步的 token 只显示在该步**最后一段**那一行（一般是工具行；
     末尾没有工具调用的步落在正文行），同一 (轮, 步) 的其它行在 tooltip 里写清归属。 */
  const TOK_LINE = 400;
  /* 归步的两个时间窗（见 tokenPlan 里的说明）：
     · TOK_TOOL_FOLLOW_MS = 「这一次模型调用请求的工具」随后就到 —— 实测会话日志里只差
       2ms；给到 2s 是为了容下渲染层的排队，而下一步的工具调用至少隔着下一次模型调用
       （秒级），不会被误收；
     · TOK_JITTER_MS = 同一帧里合成的思考 / 正文与 usage 的前后抖动（实测 1–3ms）。 */
  const TOK_TOOL_FOLLOW_MS = 2000;
  const TOK_JITTER_MS = 25;
  function tokLineOf(st) {
    const l = st && st._tokUsageTimeline;
    return Array.isArray(l) ? l : [];
  }
  /* 步分组：同一 (轮号, step) 的段 = 一步，按段顺序排列（与行模型 / 轮头同源）。
     每组记下自己的段下标与**时间锚点** —— 锚点优先取段自己的 at（app-db.js 的 tracePush
     在新起一段时写下事件到达时刻），段没有 at 时退回它那条工具记录的 at（老数据）。 */
  function stepGroupsOf(st, segs) {
    const map = toolMapOf(st);
    const groups = [];
    const gmap = new Map();
    segs.forEach((s, i) => {
      const key =
        (s.round == null ? "__none__" : String(s.round)) +
        ":" +
        (s.step == null ? "__none__" : String(s.step));
      let g = gmap.get(key);
      if (!g) {
        g = { key, idxs: [], anchors: [] };
        gmap.set(key, g);
        groups.push(g);
      }
      g.idxs.push(i);
      let at = Number(s.at) || 0;
      if (!at && s.k === "tool" && s.callId) {
        const rec = map.get(String(s.callId));
        if (rec && rec.at) at = Number(rec.at) || 0;
      }
      if (at > 0) g.anchors.push({ i, at, tool: s.k === "tool" });
    });
    return groups;
  }
  /* 明细归属的那一轮（明细只归给「当前正在跑的这一轮」）：
     · 明细自带 round（app-assist.js 的 tokUsageStepNote 与 step 一起写下来）→ 直接认它，
       一行数据自证，不依赖任何外部状态 —— 测试沙箱与真壳走同一条路；
     · 老形态（没带 round）→ 退回会话轨迹上的轮号（st.runTrace 里最大的 tr.round，
       同一会话同时只有一轮在跑）；再拿不到 → null = 不归给任何一轮，绝不硬顶一个值。 */
  function curRoundOf(st, details) {
    let best = 0;
    let mixed = false;
    for (const d of Array.isArray(details) ? details : []) {
      const n = Number(d && d.round);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (!best) best = n;
      else if (n !== best) mixed = true;
    }
    let tr = 0;
    if (st && st.runTrace && typeof st.runTrace === "object") {
      for (const k in st.runTrace) {
        const n = Number(st.runTrace[k] && st.runTrace[k].round);
        if (Number.isFinite(n) && n > tr) tr = n;
      }
    }
    if (mixed && tr > 0) return tr;
    if (best > 0) return best;
    if (tr > 0) return tr;
    try {
      const n = Number(typeof agentTraceRound === "function" ? agentTraceRound("agent:" + st.id) : 0);
      if (Number.isFinite(n) && n > 0) return n;
    } catch (_) {}
    return null;
  }
  /* 一次算清归步与显示位：
       giOfSeg   = 段下标 → 步序号（组的顺序 = 段顺序）；
       byGi      = 步序号 → 这一步的 token 累计（可能没有：这一步没记到 usage）；
       lastGiSeg = 步序号 → 这一步**最后一段**的段下标（token 就显示在那一行）；
       hasLine   = 该会话有没有「记到过 usage」的凭据（明细或内存时间线）——
                   行内与检查器只在这条件下才提 token（老会话整句不提，不写误导）。 */
  function tokenPlan(st, segs) {
    const groups = stepGroupsOf(st, segs);
    const giOfSeg = new Map();
    const lastGiSeg = new Map();
    groups.forEach((g, gi) => {
      for (const i of g.idxs) giOfSeg.set(i, gi);
      lastGiSeg.set(gi, g.idxs[g.idxs.length - 1]);
    });
    const byGi = new Map();
    const out = {
      byGi,
      giOfSeg,
      lastGiSeg,
      /* 按 (轮号, 步号) 精确取明细（检查器用：选中那一行自己的轮号）——
         同一个步号在不同轮次里都会出现，行模型按组遍历时可退化就近取。 */
      detailInRound: (round, step) => detailOf(round, step, round),
      hasLine: false,
    };
    if (!groups.length) return out;
    const add = (gi, u) => {
      if (gi == null || gi < 0) return;
      const cur = byGi.get(gi) || {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        calls: 0,
        provider: "",
        model: "",
      };
      cur.input += Number(u.inputTokens) || 0;
      cur.output += Number(u.outputTokens) || 0;
      cur.cacheRead += Number(u.cacheReadTokens) || 0;
      cur.cacheWrite += Number(u.cacheWriteTokens) || 0;
      cur.reasoning += Number(u.reasoningTokens) || 0;
      cur.calls++;
      if (u.provider) cur.provider = String(u.provider);
      if (u.model) cur.model = String(u.model);
      byGi.set(gi, cur);
    };
    /* ① 明细优先：按 (轮号, 步号) 取数 —— 采集点写下的键与段自己的键同源
       （段的 round = 轨迹轮号、step = 网关步号），所以这里只做等值匹配，不做任何推断。 */
    const details = st && Array.isArray(st._usageSteps) ? st._usageSteps : [];
    function detailOf(round, step, roundFilter) {
      if (step == null || !details.length) return null;
      /* 轮号那一半的键怎么认（明细自带 round 时最准，采集点就是这么写的）：
         · 明细带了 round → 用段自己的 round 与它**等值匹配**（同一会话里第 1 轮的 step 1
           与第 3 轮的 step 1 不能串台）；
         · 明细没带（老形态）→ 只有明细确实属于「当前在跑的这一轮」时才认它
           （curRoundOf 取会话轨迹上的轮号；取不到就整条不认 —— 老轮次不回填，用户口径）。 */
      const wantRound = roundFilter != null ? Number(roundFilter) : Number(round);
      const anyHasRound = details.some((d) => Number(d && d.round) > 0);
      if (!anyHasRound) {
        const curRound = curRoundOf(st, details);
        if (curRound == null || !Number.isFinite(wantRound) || wantRound !== Number(curRound))
          return null;
      }
      /* **同一步的多条明细合并成一条**（同一步内两次模型调用 = 2 条明细）：入/出/缓存/
         思考各自相加，calls 相加 —— 用户口径「行内显示该步合计并标 N 次调用」。
         采集侧（tokUsageStepNote）已按 (turn, step) 累加过，这里再合并一次是为了兜住
         「明细数组里落着两条同 (轮, 步)」的形态，绝不各显示一条。 */
      let hit = null;
      for (let i = 0; i < details.length; i++) {
        const d = details[i];
        if (!d || Number(d.step) !== Number(step)) continue;
        if (Number(d.round) > 0 && Number.isFinite(wantRound) && Number(d.round) !== wantRound)
          continue;
        if (!hit) {
          hit = {
            turn: Number(d.turn) || 0,
            round: Number(d.round) || 0,
            step: Number(d.step) || 0,
            calls: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            provider: String(d.provider || ""),
            model: String(d.model || ""),
          };
        }
        hit.calls += Math.max(1, Number(d.calls) || 1);
        hit.input += Number(d.input) || 0;
        hit.output += Number(d.output) || 0;
        hit.cacheRead += Number(d.cacheRead) || 0;
        hit.cacheWrite += Number(d.cacheWrite) || 0;
        hit.reasoning += Number(d.reasoning) || 0;
        if (d.provider) hit.provider = String(d.provider);
        if (d.model) hit.model = String(d.model);
      }
      return hit;
    }
    for (const [gi, g] of groups.entries()) {
      const seg = segs[g.idxs[0]] || {};
      /* 按组遍历：组键就是 (轮号, 步号) 里的步号那一半，轮号由段自己带着 ——
         与检查器同一口径，按段自己的 round 精确取。 */
      const d = detailOf(seg.round, seg.step, seg.round);
      if (!d) continue;
      out.hasLine = true;
      add(gi, {
        inputTokens: d.input,
        outputTokens: d.output,
        cacheReadTokens: d.cacheRead,
        cacheWriteTokens: d.cacheWrite,
        reasoningTokens: d.reasoning,
        provider: d.provider,
        model: d.model,
      });
      /* 调用次数按明细自己的 calls（同一步多次模型调用：用户口径 = 行内显示合计并标 N 次） */
      const cur = byGi.get(gi);
      cur.calls = Math.max(1, Number(d.calls) || 1);
    }
    if (out.hasLine) return out;
    /* ② 兜底：内存时间线（非会话运行 / 明细口径上线前就已在跑的会话）——
       仍旧按时刻就近归步，判据与注释见下。 */
    const usages = [];
    for (const u of tokLineOf(st)) {
      const at = Number(u && u.at) || 0;
      if (at > 0) usages.push({ u, at });
    }
    if (!usages.length) return out;
    out.hasLine = true;
    const anchors = [];
    groups.forEach((g, gi) => {
      /* tool 标记要一并带上：归步靠它认「紧跟在 usage 后面的那次工具调用」（见下） */
      for (const a of g.anchors) anchors.push({ gi, at: a.at, tool: !!a.tool });
    });
    if (anchors.length) {
      anchors.sort((a, b) => a.at - b.at || a.gi - b.gi);
      for (const { u, at } of usages) {
        /* p = 时刻 ≤ usage 的最后一个锚点所属的步；q = 时刻 > usage 的第一个锚点 */
        let p = -1;
        let q = -1;
        let qa = null;
        for (const a of anchors) {
          if (a.at <= at) p = a.gi;
          else {
            q = a.gi;
            qa = a;
            break;
          }
        }
        let gi = p >= 0 ? p : q;
        /* q 比 p 晚才谈得上「这一条 usage 结束的是谁」：
             · q 那个锚点是**工具调用**、且紧跟其后（几毫秒 —— 模型这一次调用请求的工具
               马上就到）→ 归 q（那一步没有思考 / 正文，或思考 / 正文还没落段）；
             · 或 q 那个锚点几乎同刻（同一帧里合成的思考 / 正文，实测 1–3ms）→ 也归 q；
             · 否则（q 已经是下几步的段了）→ 归 p：usage 落在 p 这一步的跨度之内
               （末尾没有工具调用的那几步就是这一种）。 */
        if (q >= 0 && qa && q > p) {
          const gap = qa.at - at;
          if ((qa.tool && gap <= TOK_TOOL_FOLLOW_MS) || gap <= TOK_JITTER_MS) gi = q;
        }
        add(gi, u);
      }
      return out;
    }
    /* 一个时间锚点都没有：按序对位（时间线末尾 N 条 ↔ 末尾 N 步）。 */
    const n = Math.min(usages.length, groups.length);
    for (let k = 0; k < n; k++) {
      add(groups.length - n + k, usages[usages.length - n + k].u);
    }
    return out;
  }
  /* 步间隔（相邻两条 usage 的时刻差）：既是最小可用的耗时口径，也用于检查器的「步间隔」 */
  function stepGapOf(st, selectedIdx, segs) {
    const line = tokLineOf(st);
    if (!line.length) return 0;
    const map = toolMapOf(st);
    let want = 0;
    for (let i = Math.min(selectedIdx, segs.length - 1); i >= 0; i--) {
      const s = segs[i];
      if (s && s.k === "tool" && s.callId) {
        const rec = map.get(String(s.callId));
        if (rec && rec.at) {
          want = Number(rec.at);
          break;
        }
      }
    }
    if (!want) return 0;
    let prev = 0;
    let end = 0;
    let foundBase = false;
    let baseAt = 0;
    for (const u of line) {
      const at = Number(u && u.at) || 0;
      if (!at) continue;
      if (at <= want) {
        baseAt = at;
        foundBase = true;
        continue;
      }
      /* 基准 = 「≤ 选中步」的最后一条 usage；end = 基准之后的第一条 ——
         用显式标志而不是拿 0 当哨兵（0 会被 !end 判真反复复位）。 */
      if (foundBase && !end) {
        prev = baseAt;
        end = at;
        break;
      }
    }
    /* 没有基准（选中步之前没有任何 usage）：宁可不显示，也不编一个数字。
       有基准但基准之后没有下一条 → 同样返回 0（调用方据此不显示这一栏）。 */
    if (!foundBase) return 0;
    return prev && end ? Math.max(0, end - prev) : 0;
  }
  /* 内存时间线（兜底口径 · 本次需求起**不再是主口径**）：
     采集侧（app-assist.js 的 usage 分支）只在这条 usage 没被明细接手时才调它 ——
     明细接手 = 采集点拿到了 (轮号, 步号)（tokUsageStepNote 返回 true）。两种口径
     **互斥**，同一条 usage 不会被算两遍。 */
  function pushTokLine(st, data) {
    if (!st || !data) return;
    const l = (st._tokUsageTimeline = Array.isArray(st._tokUsageTimeline)
      ? st._tokUsageTimeline
      : []);
    l.push({
      at: Number(data.at) || Date.now(),
      provider: String(data.provider || ""),
      model: String(data.model || ""),
      inputTokens: Number(data.inputTokens) || 0,
      outputTokens: Number(data.outputTokens) || 0,
      cacheReadTokens: Number(data.cacheReadTokens) || 0,
      cacheWriteTokens: Number(data.cacheWriteTokens) || 0,
      reasoningTokens: Number(data.reasoningTokens) || 0,
    });
    if (l.length > TOK_LINE) l.splice(0, l.length - TOK_LINE);
  }

  const KIND_LABEL = {
    think: "思考",
    say: "正文",
    tool: "工具",
    err: "错误",
    ctx: "上下文",
  };
  /* 记录表的行高（虚拟滚动按它算占位高度）：统一固定 —— 长内容默认折成一行，
     展开态会脱离虚拟窗口（见 renderRows）。
     本次需求：26px → 32px —— 行内要并排放「序号刻度 | 时刻 · 耗时 · 每步 token | 正文摘要」，
     26px 装不下；**仍是固定行高**，虚拟滚动的算法与占位公式一行未改（同步改的是
     css/dsh-tokens.css 的 --dsh-trace-row-h 与 test/smoke-trajectory-view.js 的行高断言）。 */
  const TRACE_ROW_H = 32;
  const TRACE_BUFFER = 8;
  /* 一页挂多少段（「更早的历史」按需加载的口径）：初次进表先挂尾部这一页，
     往上滚 / 点加载行再补一页 —— 历史上千段的会话不会一次建出全部行。 */
  const TRACE_PAGE = 200;
  /* 工具名 → 中文标题（与会话里的工具卡片同一份口径，见 app-assist.js 的 dshToolTitleOf） */
  function toolTitle(name) {
    try {
      if (typeof dshToolTitleOf === "function") return dshToolTitleOf({ name });
    } catch {
      /* 抽不到就退回原名 */
    }
    return String(name || "");
  }

  /* ── 工具族（本次需求 · 轴上色块按族上色 / 图例 / 子代理分轨的唯一口径）────────────
     轴上的块此前一律 t-tool（工具橙），一眼分不出是哪一类工具。这里按**工具名**粗分
     9 族 + 兜底「其它」，族色见 css/dsh-tokens.css 的 --dsh-fam-*（一族一色；轴块、
     列表行的工具名、图例三处取同一份令牌，永远不会对不上号）。
     族名沿用会话里已有的中文工具标题词汇 —— 「工具名 → 中文标签」的唯一真源是
     app-assist.js 的 DSH_TOOL_TITLE_RULES / dshToolTitleOf，这里只做**粗分**，
     不另抄一份逐工具清单：新工具落进哪条正则就自动归于哪族，落不进就是「其它」灰。
     顺序即图例顺序（固定顺序 = 图例不随会话与滚动跳动）。 */
  const TOOL_FAMILIES = [
    {
      id: "read",
      label: "读取",
      res: [/^(read|read_file|readfile|read_image|readimage|glob|grep|rg|ripgrep)(\.exe)?$/i],
    },
    {
      id: "write",
      label: "写入与编辑",
      res: [/^(write|write_file|create_file|edit|edit_file|str_replace_editor|apply_patch)(\.exe)?$/i],
    },
    { id: "run", label: "运行命令", res: [/^(pwsh|powershell|bash|shell|sh|zsh|cmd)(\.exe)?$/i] },
    { id: "web", label: "联网", res: [/^(web_search|websearch|web_fetch|webfetch)$/i] },
    { id: "sub", label: "子代理", res: [/^(subagent|subagent_fork|agent_task)$/i] },
    {
      id: "talk",
      label: "交互与计划",
      res: [
        /^(mtnode_)?(ask_user_question|todo_write|create_goal|get_goal|update_goal|list_agents|send_message|interrupt_agent)$/i,
        /^skill$/i,
      ],
    },
    { id: "own", label: "画布与自家工具", res: [/^mtnode_/i, /^lt_/i] },
    { id: "browser", label: "浏览器", res: [/^browser_/i] },
    { id: "job", label: "后台任务", res: [/^(job_list|job_output|job_kill)$/i] },
  ];
  /* 兜底族：认不出名字（含老记录没留下工具名）的调用 —— 灰，且**排在图例最后**
     （它是兜底不是一族，不该挤掉真族的位置） */
  const FAM_OTHER = { id: "other", label: "其它", res: [] };
  /* 子代理族（分轨与轨标签只认它）：引用族表里的那一条，不另抄一份判据 */
  const FAM_SUB = TOOL_FAMILIES.filter((f) => f.id === "sub")[0];
  function toolFamilyOf(name) {
    const nm = String(name || "").trim();
    if (!nm) return FAM_OTHER;
    for (const f of TOOL_FAMILIES) {
      for (const re of f.res) if (re.test(nm)) return f;
    }
    return FAM_OTHER;
  }
  function familyLabel(f) {
    return T((f || FAM_OTHER).label);
  }
  function fmtMs(ms) {
    const n = Number(ms) || 0;
    if (n <= 0) return "";
    if (n < 1000) return n + " ms";
    if (n < 60000) return (n / 1000).toFixed(1) + " s";
    return Math.round(n / 1000) + " s";
  }
  function fmtClock(t) {
    try {
      if (typeof fmtTime === "function") return fmtTime(t);
    } catch {
      /* 拿不到格式化就走本地时间 */
    }
    const d = new Date(Number(t) || 0);
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0") +
      ":" +
      String(d.getSeconds()).padStart(2, "0")
    );
  }
  function fmtNum(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    if (v < 1000000) return (v / 1000).toFixed(1) + "k";
    return (v / 1000000).toFixed(2) + "M";
  }
  /* 每步 token 的紧凑写法（轴侧刻度栏只有一格宽）：`↑in（新增 N）↓out`。
     两个数都是 0 时不写 0/0，返回 null —— 调用方据此按「没记到」处理。
     本次需求：行内与检查器里都是**两段 DOM**（.dsh-tok-in / .dsh-tok-out，输入蓝 /
     输出绿 --cyan / --green）+ 一段「（新增 N）」小字，故数字口径只有 fmtTokParts 一处，
     DOM 口径只有 tokSpans / tokStepNode 一处；纯文本读法走 fmtInText（tooltip 用）。 */
  function fmtTokParts(input, output) {
    const a = Number(input) || 0;
    const b = Number(output) || 0;
    if (!a && !b) return null;
    return { in: a, out: b };
  }
  /* 两步口径（本次需求 · 用户口径「计费输入 + 小字（新增 N）」）：
     · 入 = 计费输入 = 非缓存输入 + 缓存读 + 缓存写（与 scripts/audit-token-usage.mjs
       的 promptTokens 同一口径，能与上游账单对上）；
     · 新增 = 非缓存输入那一份（这一步真正新进入历史、没吃到缓存的部分）——
       「每一步都在重发整份历史」与「这一步真加了东西」一眼分清。
     newOf 传 null/undefined = 明细里没有它（老时间线只有 inputTokens 口径）→
     只显示旧的「↑计费输入」，绝不拿 0 冒充「这一步没新增」。 */
  function fmtInText(total, newOf) {
    const t = Number(total) || 0;
    const n = Number(newOf);
    if (!Number.isFinite(n) || n < 0) return "↑" + fmtNum(t);
    return "↑" + fmtNum(t) + Tn("（新增 {n}）", fmtNum(n));
  }
  /* 两段带色 span（输入蓝 / 输出绿）：`↑12.3k（新增 300）` + `↓456`。
     调用方拿到 null 就按「未记到」处理。 */
  function tokSpans(input, output, cls, newOf) {
    const p = fmtTokParts(input, output);
    if (!p) return null;
    const wrap = document.createElement("span");
    wrap.className = cls || "dsh-tok";
    const up = document.createElement("span");
    up.className = "dsh-tok-in";
    up.textContent = "↑" + fmtNum(p.in);
    const dn = document.createElement("span");
    dn.className = "dsh-tok-out";
    dn.textContent = "↓" + fmtNum(p.out);
    wrap.appendChild(up);
    /* 「（新增 N）」：纯新增输入那一份，淡淡一段小字（不是第二个数字，别落输入蓝）。
       没给 newOf（老时间线只有 inputTokens 口径）就整段不出现 —— 不拿 0 冒充。 */
    const n = Number(newOf);
    if (Number.isFinite(n) && n >= 0) {
      const nn = document.createElement("span");
      nn.className = "dsh-tok-new";
      nn.textContent = Tn("（新增 {n}）", fmtNum(n));
      up.appendChild(nn);
    }
    wrap.appendChild(dn);
    return wrap;
  }
  /* 一步的 token 那一整块（行内读数栏与检查器共用一份 DOM 口径）：
     ↑计费输入（新增 N）↓输出 [· N 次调用] —— 数字只在这里成型，两处不会各写一套。 */
  function tokStepNode(tok, cls, callsOnly) {
    if (!tok) return null;
    const node = tokSpans(tok.in, tok.out, cls || "dsh-tok", tok.new);
    if (!node) return null;
    if (!callsOnly && tok.calls > 1) {
      const cn = document.createElement("span");
      cn.className = "dsh-tok-calls";
      cn.textContent = " · " + tok.calls + T(" 次调用");
      node.appendChild(cn);
    }
    return node;
  }
  /* 「服务商 · 模型」（usage 帧自带归属）：谁花的 token 一句话说清；拿不到就不写。 */
  function modelTextOf(u) {
    if (!u) return "";
    const p = String(u.provider || "");
    const m = String(u.model || "");
    if (p && m) return p + " · " + m;
    return m || p;
  }
  function T(s) {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function") return I18n.t(s);
    } catch {
      /* 拿不到词条就走原文 */
    }
    return String(s);
  }
  /* 带占位符的词条：词条表里写成「第 {n} 轮」，这里按占位符填。 */
  function Tn(s, n) {
    return String(T(s)).split("{n}").join(String(n));
  }

  /* ── 视图状态：每条会话自己记「当前看的是对话还是轨迹」 ─────────────────────
     上游的 View 选择是持久化偏好（有效且已注册的偏好优先，否则回 chat）。本仓把它落在
     会话对象上（st.trajView === "trace" 即轨迹视图），随会话落盘白名单一起走。 */
  const VIEWS = ["chat", "trace", "changes"];
  function viewOf(st) {
    const v = st && st.trajView ? String(st.trajView) : "";
    return VIEWS.indexOf(v) > 0 ? v : "chat";
  }
  function setView(st, v) {
    if (!st) return;
    st.trajView = VIEWS.indexOf(String(v)) > 0 ? String(v) : "";
    try {
      if (typeof persistAgentSession === "function") persistAgentSession();
    } catch {
      /* 落盘失败不影响本次切换 */
    }
    sync();
  }

  let tabsEl = null;
  let mainEl = null;
  /* 「改动」主区（第三栏 · 本次需求）：与轨迹主区并列的另一块整块视图 */
  let changesEl = null;
  let listEl = null;
  let inspEl = null;
  let footEl = null;
  let loadEl = null;
  let tailEl = null;
  let spacerEl = null;
  let selected = -1;
  /* 最近一次**真的渲染过**的会话 id（与 render() 一起写）。sync() 用它判断「这一帧要不要
     重画」—— 不能用「视图选择刚变过」那种一次性状态：sync 被会话重绘与 1.5s 轮询反复调用，
     必须由一个持久事实（画过谁）决定，否则第一次切进轨迹视图那一帧会被整个跳过。 */
  let lastRendered = "";
  let lastSegs = [];
  let lastSessionId = "";

  /* ── 行模型（本轮需求）──────────────────────────────────────────────────
     rows = 轮头 / 助手分组头 / 段行 的扁平序列（虚拟滚动的单位）。
     段行保留段索引 = dataset.segIdx（轨迹↔对话定位口径不变）。 */
  let rows = [];
  let allRows = [];
  /* 折叠状态（轮头一级；「助手分组」那一级本次需求撤掉）：整会话一份（不落盘） */
  let collapsedTurns = new Set();
  /* 已挂窗口：winStart = 窗口起点在**行模型里的下标**（往上翻页时减小，直到 0）；
     scrollTop / followTail = 滚动位置与「是否跟随尾部」。
     只有一个窗口：虚拟切片只在这个窗口内裁，避免「分页窗口」与「虚拟窗口」互相打架。 */
  let winStart = 0;
  let scrollTop = 0;
  let followTail = true;
  let viewportH = 0; /* 0 = 量不到可视高度（无布局，如冒烟环境）→ 全量挂 */
  /* 轴宿主的宽度（量不到就 0）：刻度数量按它分档（2 / 3 / 4 个）——窄窗口不让刻度挤成一团。 */
  let hostW = 0;
  /* ── 详情栏宽度（本次需求 · 检查器可拖宽）──────────────────────────────────
     轨迹右侧那栏明细（.dsh-trace-insp）过去写死 flex:0 0 340px：参数 / 结果一长就只能
     在窄栏里滚。现在在它**左边缘**加一条可拖动分隔条（.dsh-trace-divider），按住左右拖
     = 改详情栏宽（向左拖变宽，与右栏那条分界线同一读法），松手才落盘一次。
     口径（拷问已确认）：默认 340 / 最小 220 / 最大 = 宿主 60% / 双击复位 340 /
     宽度存本机 localStorage 一条（与文件预览栏 mtnode.baW、浏览器栏 mtnode.baOpen 同口径）。
     实现三件事（少一件就会「拖不动」或「拖出界」）：
       · 宽度只写 .dsh-trace-cols 上的 --dsh-trace-insp-w（检查器读它），不直接改 inspEl.style
         —— 一处写、一处夹，DOM 里看得见；
       · 宿主宽用 .dsh-trace-cols.getBoundingClientRect().width（它铺满主区，不受详情栏宽度
         反向影响），量不到就沿用上一次（换会话归零后由 resize / 下一次拖重新量）；
       · 起止值分开算（startW + dx）：夹到边界后仍能原路拖回，不会「拖不动了」。 */
  const INSP_W_DEFAULT = 340; /* 与旧写死的 flex:0 0 340px 同一个数：默认观感不变 */
  const INSP_W_MIN = 220; /* 与 CSS 里那条 min-width:220px 同一个数（两处一起改） */
  const INSP_W_FRACTION = 0.6; /* 上限：宿主宽的 60%（列表至少留 40%） */
  const INSP_W_LS = "mtnode.traceInspW"; /* localStorage 键（本机一份） */
  let inspW = INSP_W_DEFAULT;
  let colsEl = null; /* .dsh-trace-cols：分隔条的宿主，宽度写它身上 */
  let inspDivEl = null; /* 分隔条本体（只有详情栏露出来时才显形） */
  let divDrag = null; /* 拖动中的账 { id, x0, base, host }；松手即清 */
  let loadingMore = false;
  /* 检查器的「树形 / 代码」切换 */
  let inspRaw = false;
  /* 顶部横轴（本次需求 · 横轴窗口化）：常驻元素 + 「上一帧画的是什么」的签名
     （避免滚动时空转重画）。它在**列表外**（视图最上方），列表自己滚动、它常驻其上。 */
  let rulerEl = null;
  let rulerSig = "";
  /* ── 横轴缩放（本轮需求：滚轮横向拉伸）──────────────────────────────────────
     横轴在轴身上滚轮 = 以**指针下的那个时刻**为锚做横向拉伸 / 压缩（刻度、色块、
     滑窗带三者同源一起缩，锚点时刻不动），因此拉近时看得见的是**指针附近那一段**的
     细分时间（局部拉伸），离指针越远拉伸越少。
     量记在**本会话**的轴域上：[zoomLo, zoomHi] = 本会话全轴 [min, max] 之内当前画出的
     时间窗（null = 未缩放，照全轴画 —— 1 倍时一个像素的算法都与上一版逐位相同）。
     zoomFollow = 「缩放是跟着用户滚轮走的」：屏幕外的视窗就不去硬拽它，一旦滚动视窗
     的时间段整体滑出这个窗，本帧就把窗平移回去（见 domainOf）—— 拉伸只改尺度，不把
     视窗弄丢。换会话 / 双击轴 / Esc 一起归零（见 render 与 ensureMain）。 */
  let zoomLo = null;
  let zoomHi = null;
  let zoomSession = "";
  /* 一档滚轮拉伸比：每 100px 的 deltaY 变动 25%（约 4 档 = 一次明显的拉近） */
  const ZOOM_STEP = 0.25;
  /* 拉伸上限（相对本会话全轴跨度）：最细到全跨度的 1/40 —— 再细就只剩一两个块在轴上 */
  const ZOOM_MAX = 40;

  /* ── 滑窗带拖动（本轮需求 [23]：拖动平移 + 列表跟随）────────────────────────
     带自身在 CSS 里是 pointer-events:none（未按下时绝不挡块的点击与 hover），拖动入口因此
     挂在轴身上（见 ensureMain 的三个指针监听）：按下点落在**带自己的矩形**里才算「可能的
     拖动」，位移过阈值才真的进拖动态（那时才 setPointerCapture + 带改吃指针 + 光标 grabbing）。
     拖动只改「画出哪一段时间」与列表滚动位置，任何记录都不动；实现细节见文件头 [23]。 */
  const DRAG_SLOP = 4; /* 位移阈值（px）：小于它算点击 → 块照常可点、可双击 */
  const DRAG_SWALLOW_MS = 350; /* 拖动收尾后吞掉 click / dblclick 的时间窗（防误触双击归零） */
  let dragPend = null; /* 按下但还没定：{ id, x0, perPx, base, len, full, canPan } */
  let dragOn = false; /* 真的进了拖动态（位移过阈值 + 指针已捕获） */
  let dragWin = null; /* 拖动中平移出来的那只窗 { lo, hi }（脚下读数用；松手即清） */
  let dragSwallowUntil = 0; /* 拖动刚结束（< DRAG_SWALLOW_MS）→ 这一段里的 click / dblclick 吞掉 */

  /* ── hover 绿线（本轮需求 [25]）：指针在横轴上时的一条竖直绿线 + 一枚时刻读数 ──────
     它 pointer-events:none、不进任何几何签名：滚动 / 缩放重画把绘图区整只重建之后，
     由 paintHover() 按这三位原样补回来（见 updateRuler 尾部）。 */
  let hoverOn = false; /* 指针是不是在轴里（只在轴里 hover 才画，见文件头 [25]） */
  let hoverF = 0; /* 指针在绘图区里的横向比例 0..1（线的位置与读数都由它算） */
  /* updateRuler 每帧写下的本帧时间窗 {min,max}：hover 读数与「点击折算成时刻」共用一份，
     免得 pointermove / click 每次都去 rulerFrame() 全量重算一遍。 */
  let lastDom = null;

  function normSeg(s) {
    return {
      k: s.k,
      text: s.text,
      step: s.step,
      round: s.round == null ? null : s.round,
      callId: s.callId || "",
      at: Number(s.at) || 0,
      rec: null,
    };
  }

  /* 把段切成「轮头 → 段行」的行模型（本次需求：撤掉「助手 · N 步」二级分组行）。
     轮号取自段自己的 round（会话轮号 = 该会话里用户第几次发送，见文件头 [1]）；
     没有 round（老数据 / 非会话运行）统一归一组，表头写「全部」—— 不推断。 */
  function buildRows(segs, st) {
    const map = toolMapOf(st);
    /* 每步 token：归步与显示位都走同一份 tokenPlan（见上方注释）——
       行内读数栏、行 tooltip 与检查器读出同一个数，不再各算一份。 */
    const plan = tokenPlan(st, segs);
    /* 这一步记到的 token（该步**任意**一行都能读到，供 tooltip 与检查器）：
       有明细（或内存时间线兜底）就算「记到过」，数值可以是 0（真 0 也算记到）。 */
    const stepTokOf = (segIdx) => {
      const gi = plan.giOfSeg.get(segIdx);
      const u = gi == null ? undefined : plan.byGi.get(gi);
      return u || null;
    };
    /* 这一行是不是本步 token 的**显示行**（= 该步最后一段） */
    const isTokRow = (segIdx) => {
      const gi = plan.giOfSeg.get(segIdx);
      return gi != null && plan.lastGiSeg.get(gi) === segIdx;
    };
    /* 行模型上带**数字**（tokIn / tokOut / tokNew），不带拼好的字符串 —— 行内的两段颜色
       （输入蓝 / 输出绿）与「（新增 N）」小字由渲染侧按 span 落，text 只在 tooltip 里要。 */
    const tokOf = (segIdx) => {
      const u = stepTokOf(segIdx);
      if (!u) return null;
      const inBill = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
      const out = Number(u.output) || 0;
      if (!inBill && !out) return null;
      return {
        in: inBill,
        out: out,
        /* 纯新增输入 = 非缓存输入那一份；明细里没有 output-only 之类的老数据时为 0 */
        new: Math.max(0, Number(u.input) || 0),
        calls: Math.max(0, Number(u.calls) || 0),
      };
    };
    const groups = [];
    const gmap = new Map();
    const NONE = "__none__";
    segs.forEach((seg, i) => {
      const s = normSeg(seg);
      if (s.k === "tool" && s.callId) s.rec = map.get(String(s.callId)) || null;
      const tk = s.round == null ? NONE : String(s.round);
      let g = gmap.get(tk);
      if (!g) {
        g = { key: tk, round: s.round == null ? null : s.round, items: [] };
        gmap.set(tk, g);
        groups.push(g);
      }
      g.items.push({ segIdx: i, seg: s });
    });
    const out = [];
    for (const g of groups) {
      const tKey = "turn:" + g.key;
      const tools = g.items.filter((x) => x.seg.k === "tool").length;
      out.push({
        kind: "turn",
        key: tKey,
        round: g.round,
        collapsed: collapsedTurns.has(tKey),
        label: g.round == null ? T("全部") : Tn("第 {n} 轮", g.round),
        meta: g.items.length + T(" 步 · 工具 ") + tools + T(" 次"),
        segIdx: -1,
      });
      if (collapsedTurns.has(tKey)) continue;
      /* 轴的序号刻度（本次需求）：**每轮从 1 起** —— 按段自己的 step 值归号，
         同一个 step 的多段共用一个号（思考 → 工具 → 正文是同一步里的三件事）。 */
      const stepNo = new Map();
      let seq = 0;
      for (const it of g.items) {
        const k = it.seg.step == null ? "__none__" : String(it.seg.step);
        if (!stepNo.has(k)) stepNo.set(k, ++seq);
      }
      for (const it of g.items) {
        const k = it.seg.step == null ? "__none__" : String(it.seg.step);
        out.push({
          kind: "seg",
          key: "seg:" + it.segIdx,
          round: g.round,
          step: it.seg.step,
          stepNo: stepNo.get(k),
          segIdx: it.segIdx,
          seg: it.seg,
          /* 每步 token（可空）：**只挂在该步最后一段**那一行（用户口径：数字只出现一次），
             给不出就 null；这一步整体有没有记到走 stepTok（tooltip / 检查器用）。 */
          tok: isTokRow(it.segIdx) ? tokOf(it.segIdx) : null,
          stepTok: stepTokOf(it.segIdx),
          hasTokLine: plan.hasLine,
          collapsed: false,
        });
      }
    }
    return out;
  }

  /* 依当前折叠态重建行模型，并只把「尾部一页」挂进窗口。
     本次需求把顶部搜索条整条移除，随之撤掉的是搜索命中这条链路
     （原 rowSearchText / applySearch / recomputeHits / hits / hitAt 与命中环 .hit
     —— 一整条一起走，别只删输入框留下一堆永远为空的命中状态）。 */
  function rebuildRows(st, segs, resetWindow) {
    allRows = buildRows(segs, st);
    /* winStart = 0 是「已经翻到最早」，**不是**该重置的信号（老判据 winStart <= 0
       会让翻到最早之后的每次重绘都弹回尾部窗口）。只有换会话 / 窗口越界才重置。 */
    if (resetWindow || winStart >= allRows.length) {
      winStart = Math.max(0, allRows.length - TRACE_PAGE);
    }
    rows = rowsInWindow();
  }
  /* 窗口内的行：跳过「整段都在窗口之前」的段行；被折叠的轮次 / 分组只留表头。 */
  function rowsInWindow() {
    const keep = new Set();
    for (let i = winStart; i < allRows.length; i++) {
      const r = allRows[i];
      if (r && r.kind === "seg") keep.add(r.segIdx);
    }
    const out = [];
    for (const r of allRows) {
      const tk = "turn:" + (r.round == null ? "__none__" : r.round);
      if (r.kind === "seg") {
        if (!keep.has(r.segIdx)) continue;
        if (collapsedTurns.has(tk)) continue;
        out.push(r);
        continue;
      }
      out.push(r);
    }
    return out;
  }

  /* ── 会话头部的「对话 / 轨迹 / 改动」标签栏（上游 conversation.view 环）─────────
     宿主：主区顶部（.agent-main 的第一个孩子）。三个标签，纯按钮，不引框架。
     第三枚「改动」= 本次需求（renderer/app-changes.js：本会话改过哪些文件 + 逐笔 diff）：
     它常显、不受「设置 · 开发者工具」开关约束（那一位只管轨迹的检查器 / 参数明细）。 */
  function ensureTabs() {
    if (tabsEl && tabsEl.isConnected) return tabsEl;
    const main = $(".agent-main");
    if (!main) return null;
    tabsEl = document.createElement("div");
    tabsEl.className = "dsh-view-tabs agent-view-tabs";
    tabsEl.id = "agentViewTabs";
    tabsEl.setAttribute("role", "tablist");
    const mk = (id, label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dsh-view-tab";
      b.dataset.view = id;
      b.setAttribute("role", "tab");
      b.textContent = label;
      b.onclick = () => {
        const st = activeSession();
        if (!st) return;
        setView(st, id);
      };
      return b;
    };
    tabsEl.appendChild(mk("chat", T("对话")));
    tabsEl.appendChild(mk("trace", T("轨迹")));
    tabsEl.appendChild(mk("changes", T("改动")));
    main.insertBefore(tabsEl, main.firstChild);
    return tabsEl;
  }

  function mkBtn(cls, label, title, on) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    if (title) b.title = title;
    if (on) {
      b.addEventListener("mousedown", (ev) => ev.stopPropagation());
      b.addEventListener("click", (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        on(ev);
      });
    }
    return b;
  }

  /* ── 详情栏宽度：读 / 夹 / 写 / 落盘（本次需求）────────────────────────────
     读写口径见上面那一节的状态声明：宽度只写 .dsh-trace-cols 的 CSS 变量
     --dsh-trace-insp-w（检查器读它），落盘只在本机 localStorage 一条 —— 数据不落应用目录。 */
  function inspHostW() {
    /* 宿主宽：优先量 .dsh-trace-cols 自己的矩形（它铺满主区，不被详情栏宽度反向影响）；
       量不到（无布局 / 迷你 DOM）用窗口宽顶一下；再量不到就回 0 = 不设上限（由拖动的起点兜底）。 */
    let w = 0;
    try {
      if (colsEl && typeof colsEl.getBoundingClientRect === "function")
        w = Number(colsEl.getBoundingClientRect().width) || 0;
    } catch {
      w = 0;
    }
    if (!w) {
      try {
        w = Number(window.innerWidth) || 0;
      } catch {
        w = 0;
      }
    }
    return w;
  }
  function clampInspW(w, host) {
    const h = Number(host) || 0;
    const cap = h > 0 ? Math.max(INSP_W_MIN, Math.floor(h * INSP_W_FRACTION)) : 0;
    const n = Math.round(Number(w) || INSP_W_DEFAULT);
    const lo = INSP_W_MIN;
    return Math.max(lo, cap > 0 ? Math.min(cap, n) : n);
  }
  function inspWStore(w) {
    try {
      localStorage.setItem(INSP_W_LS, String(Math.round(w)));
    } catch {
      /* 无 localStorage（隐私模式 / 冒烟沙箱）：这次拖的宽度照用，只是不记忆 */
    }
  }
  function inspWLoad() {
    try {
      const v = Number(localStorage.getItem(INSP_W_LS));
      if (v > 0) inspW = v;
    } catch {
      /* 读不到就沿用默认 */
    }
  }
  /* 宽度落到面板上：persist = 松手 / 双击那一次才落盘（拖动中每帧只改 DOM）。 */
  function applyInspW(w, persist) {
    inspW = clampInspW(w == null ? inspW : w, inspHostW());
    try {
      if (colsEl && colsEl.style) colsEl.style.setProperty("--dsh-trace-insp-w", inspW + "px");
    } catch {
      /* 无 style 的迷你 DOM：跳过（断言读 inspW / _debug） */
    }
    if (persist) inspWStore(inspW);
    return inspW;
  }
  /* 分隔条的显隐与宽度跟详情栏同步：没选中事件（检查器 hidden）= 整条收掉，
     不留一条看不见却拖得动的空条；露出来时按当前宽度重夹一次（宿主变窄后自动回让）。 */
  function syncInspDivider() {
    if (!inspDivEl) return;
    if (!inspEl || inspEl.hidden) {
      inspDivEl.hidden = true;
      return;
    }
    inspDivEl.hidden = false;
    applyInspW(inspW, false);
  }
  /* 拖动收尾：摘光标 / 摘监听 / 释放捕获；persist 只在这里发生一次。 */
  function inspDivEnd(ev) {
    const d = divDrag;
    if (!d) return;
    if (ev && ev.pointerId != null && ev.pointerId !== d.id) return;
    divDrag = null;
    try {
      if (inspDivEl && inspDivEl.releasePointerCapture && inspDivEl.hasPointerCapture && inspDivEl.hasPointerCapture(d.id))
        inspDivEl.releasePointerCapture(d.id);
    } catch {
      /* 没捕获过 / 老引擎：忽略 */
    }
    try {
      if (inspDivEl && inspDivEl.classList) inspDivEl.classList.remove("dragging");
    } catch {
      /* 迷你 DOM：忽略 */
    }
    try {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    } catch {
      /* 迷你 DOM：忽略 */
    }
    if (typeof window.removeEventListener === "function") {
      window.removeEventListener("pointermove", inspDivMove);
      window.removeEventListener("pointerup", inspDivEnd);
      window.removeEventListener("pointercancel", inspDivEnd);
    }
    applyInspW(inspW, true);
  }
  function inspDivMove(ev) {
    const d = divDrag;
    if (!d || !ev) return;
    if (ev.pointerId != null && ev.pointerId !== d.id) return;
    if (ev.cancelable !== false && typeof ev.preventDefault === "function") ev.preventDefault();
    /* 起始值与增量分开算（d.base + dx）：向左拖 = 变宽（与助手栏那条分界线同一读法） */
    applyInspW(d.base + (d.x0 - (Number(ev.clientX) || 0)), false);
  }
  /* 分隔条（本次需求）：挂在 .dsh-trace-cols 里、排在列表与检查器之间；宽度 0 + 左移
     1px 的半宽 + 命中区加宽（CSS 里那几条），因此它**不占布局宽度**、不影响 60% 的算法。 */
  function bindInspResize() {
    if (!colsEl || inspDivEl) return inspDivEl;
    inspDivEl = document.createElement("div");
    inspDivEl.className = "dsh-trace-divider";
    inspDivEl.id = "agentTraceDivider";
    inspDivEl.hidden = true;
    inspDivEl.setAttribute("role", "separator");
    inspDivEl.setAttribute("aria-orientation", "vertical");
    inspDivEl.title = T("按住左右拖 = 调整详情栏宽度（向左拖变宽 · 双击复位）");
    inspDivEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      divDrag = { id: ev.pointerId, x0: Number(ev.clientX) || 0, base: inspW };
      if (inspDivEl.classList) inspDivEl.classList.add("dragging");
      try {
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      } catch {
        /* 迷你 DOM：忽略 */
      }
      try {
        if (inspDivEl.setPointerCapture) inspDivEl.setPointerCapture(ev.pointerId);
      } catch {
        /* 老引擎：没有捕获也能拖（松手靠 pointerup） */
      }
      if (typeof window.addEventListener === "function") {
        window.addEventListener("pointermove", inspDivMove);
        window.addEventListener("pointerup", inspDivEnd);
        window.addEventListener("pointercancel", inspDivEnd);
      }
    });
    inspDivEl.addEventListener("dblclick", (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      applyInspW(INSP_W_DEFAULT, true); /* 双击复位（与开发页三栏那条双击复位同口径） */
    });
    colsEl.appendChild(inspDivEl);
    inspWLoad();
    applyInspW(inspW, false);
    if (typeof window.addEventListener === "function") {
      /* 宿主变窄（窗口缩放 / 换布局）：按新宿主重夹一次，但不落盘 ——
         窗口再拉大时仍回到用户拖出来的那个宽度。 */
      window.addEventListener("resize", () => applyInspW(inspW, false));
    }
    return inspDivEl;
  }

  /* ── 主区里的轨迹视图容器（工具栏 + 窗口横轴 + 记录表 + 检查器 + 页脚）──────── */
  function ensureMain() {
    if (mainEl && mainEl.isConnected) return mainEl;
    const body = $(".agent-body");
    const list = $("#agentList");
    if (!body || !list) return null;
    mainEl = document.createElement("div");
    mainEl.className = "dsh-trace-main";
    mainEl.id = "agentTraceMain";
    mainEl.hidden = true;
    /* 面板刚建出来：视口量值与滚动位置一律归零，交给下一帧重量 ——
       否则会拿上一个会话（或上一次布局）的旧视口去裁行，头几行被裁掉。 */
    viewportH = 0;
    scrollTop = 0;

    /* 顶部**不再有工具栏**（本次需求 · 用户口径「移除上方整个搜索条这一栏，腾出更多空间」）：
       原先那一行 .dsh-trace-bar（搜索框 + 命中计数 + 回车导航）整条撤掉，
       连带 rowSearchText / applySearch / reSearch / stepHit / hits / hitAt / 命中环 .hit
       一整条命中链路一起走 —— 只删输入框会留下一堆永远为空的命中状态。
       视图最上方现在就是那条总轴（全轴 + 滑窗带），列表在它下面自己滚动。 */

    /* 顶部横轴（本次需求 · 横轴窗口化）：挂在**原总时间轴的位置** ——
       mainEl 的第一只子件（列表**之外**），列表在它下面自己滚动、轴常驻其上（不 sticky，
       也不再随滚动跑掉）。横坐标范围 = **整个会话**（最早一次调用的 at … 最晚一次的 end），
       当前滚动视窗对应的时间段用一条半透明滑窗带叠在轴上、随滚动实时移动。
       轴内从上到下四行：时刻刻度 / 3 条轨的色块 / 本视窗读数 / 工具族图例；
       轨数**固定 3 条**（不足补空轨、超出并轨叠画），轴高因此恒定 —— 不再与虚拟滚动
       的「本屏可见行数」互相推高，也不必再封顶轴内滚动。
       常驻件（本轴）不在滚动容器里，故 clearRows 不必跳它；
       滚动容器里仍有两只常驻节点要跳：loadEl / spacerEl（外加尾部浮标 tailEl）。 */
    rulerEl = document.createElement("div");
    rulerEl.className = "dsh-trace-ruler";
    rulerEl.id = "agentTraceRuler";
    rulerEl.addEventListener("mousedown", (ev) => ev.stopPropagation());
    /* 轴上的滚轮 = **横向拉伸**（本轮需求）：以指针下的那个时刻为锚拉近 / 拉远 ——
       锚点时刻在轴上不动，离指针越远拉伸越少（指针附近那一段变化最大）。
       滚轮本来在这条轴上没有别的活（列表的纵向滚动归 .dsh-trace-list 自己），
       所以不必要求修饰键：轴身上直接滚就是缩放，双击轴 / Esc 回全轴。
       缩放只改「画出哪一段时间」，不改任何记录 —— 色块、刻度、滑窗带一起缩。 */
    rulerEl.addEventListener(
      "wheel",
      (ev) => {
        const d = Number(ev && ev.deltaY) || 0;
        if (!d) return;
        if (ev.cancelable !== false && typeof ev.preventDefault === "function") ev.preventDefault();
        const fr = rulerFrame();
        if (!fr) return; /* 一条带真实时刻的记录都没有：轴上没什么可拉伸 */
        const full = Math.max(1, fr.max - fr.min);
        /* 本帧窗（未缩放时 = 全轴），缩放从它往回算 —— 一档一档叠着拉 */
        const d0 = fr.dom || { min: fr.min, max: fr.max };
        let len = Math.max(1, Math.min(full, d0.max - d0.min));
        let lo = Math.max(fr.min, Math.min(d0.min, fr.max));
        /* 指针在轴上的横向比例：量得到就按指针取锚，量不到（无布局 / 合成事件没带 clientX）
           取左缘 —— 不编一个假的指针位置 */
        let f = 0;
        try {
          const cx = Number(ev && ev.clientX);
          const bx = rulerEl.getBoundingClientRect ? rulerEl.getBoundingClientRect() : null;
          if (bx && bx.width > 0 && isFinite(cx) && cx >= 0) {
            f = Math.max(0, Math.min(1, (cx - Number(bx.left || 0)) / bx.width));
          }
        } catch {
          /* 没有布局（冒烟里的迷你 DOM）：锚取左缘 */
        }
        const anchorT = lo + len * f;
        /* 滚上 = 拉近（窗变短）、滚下 = 拉远；每 100px 一档 25%。
           先按比例把窗变长，再把锚点**钉回**原位（锚点时刻不动 = 指针下那一段不动），
           最后把窗夹进全轴：左缘越界收左缘、右缘越界收右缘 —— 顺序不能换
           （先夹左缘再夹右缘会把刚钉好的锚点又推走，本轮第一版就错在这）。 */
        const k = Math.max(0.2, Math.min(20, 1 + ZOOM_STEP * (d / 100)));
        let nLen = Math.max(full / ZOOM_MAX, Math.min(full, len * k));
        let nLo = anchorT - (anchorT - lo) * (nLen / len);
        let nHi = nLo + nLen;
        if (nLo < fr.min) {
          nLo = fr.min;
          nHi = nLo + nLen;
        }
        if (nHi > fr.max) {
          nHi = fr.max;
          nLo = Math.max(fr.min, nHi - nLen);
        }
        /* 贴着全轴（<= 1/1000 的差别）→ 直接归零，让轴干净地回全轴那一份几何 */
        if (nHi - nLo >= full - full / 1000) {
          zoomLo = null;
          zoomHi = null;
        } else {
          zoomLo = nLo;
          zoomHi = nHi;
          zoomSession = activeSessionId();
        }
        rulerSig = ""; /* 缩放态变了：签名作废，本帧必重画 */
        updateRuler();
      },
      { passive: false },
    );
    /* 双击轴 = 放弃缩放、回全轴（缩放得回来才敢用）。回全轴那一帧顺带**结束在拖的那一次**：
       一边拖一边被归零只会互相打架（见下面的 abortDrag）。 */
    rulerEl.addEventListener("dblclick", () => {
      abortDrag();
      if (zoomLo == null && zoomHi == null) return;
      zoomLo = null;
      zoomHi = null;
      rulerSig = "";
      updateRuler();
    });

    /* 滑窗带拖动（本轮需求 [23]）：带在 CSS 里不吃指针（未按下时照旧不挡块的点击与 hover），
       所以拖动入口挂在轴身上，按 pointerdown 的**落点**判定「是不是抓在带上」：
         · 落在带上 → 只记一条候选（不捕获、不 preventDefault —— 此刻它还只是一次可能的点击，
           点带里那些块仍必须能选行）；
         · 位移过阈值才真的进拖动态（startDrag）：setPointerCapture 抓住指针（此后事件一律回到
           轴上，手滑到轴外也不丢）、光标 grabbing、轴与带挂 .dragging、并暂停跟随；
         · 每帧 panWindowBy：按本帧 domain 的尺度把 Δx 折成 Δ时间平移窗（窗长不变），
           窗中点交给列表跟随那条通路；
        pointerup / pointercancel 收尾（document 上另挂一条捕获兜底：还没进拖动态、也就没捕获
       指针时，指针在轴外抬起同样要把这条候选清掉）。 */
    rulerEl.addEventListener("pointerdown", (ev) => {
      if (!ev) return;
      /* 只认主键（鼠标左键 / 触摸 / 笔）：右键与中键不参与拖动 */
      if (ev.button != null && ev.button !== 0) return;
      if (dragPend || dragOn) return;
      const fr = rulerFrame();
      if (!fr) return; /* 整个会话都没有带真实时刻的记录：轴上没东西可拖 */
      if (!bandHitAt(ev)) return; /* 按在块上 / 空轨 / 读数行上：不是抓带，交给块自己的点击 */
      const x = Number(ev.clientX);
      if (!isFinite(x)) return;
      const w = axisWidthPx();
      if (!(w > 0)) return; /* 量不到轴宽 → 折不出时间：宁可不拖，也不编一个尺度 */
      const full = { min: fr.min, max: fr.max };
      const dom = fr.dom || full;
      const dSpan = Math.max(1, dom.max - dom.min);
      /* 缩放态才谈得上「平移缩放窗」；未缩放时全轴装得下整个会话，平移到对象是滑窗带自己。
         窗长与窗中点两种态各取一份（见文件头 [23]）。 */
      const canPan = dSpan < Math.max(1, full.max - full.min) - 1;
      const band = fr.band;
      const len = canPan ? dSpan : band ? Math.max(1, band.end - band.at) : 0;
      if (!(len > 0)) return;
      dragWin = null;
      dragPend = {
        id: ev.pointerId,
        x0: x,
        /* 本帧 domain 的尺度：1px = 多少毫秒（与滚轮的横坐标同一套） */
        perPx: dSpan / w,
        base: canPan ? (dom.min + dom.max) / 2 : (band.at + band.end) / 2,
        len,
        full,
        canPan,
        lastDx: 0,
      };
    });
    rulerEl.addEventListener("pointermove", (ev) => {
      const p = dragPend;
      if (!p || !ev || ev.pointerId !== p.id) return;
      const x = Number(ev.clientX);
      if (!isFinite(x)) return;
      const dx = x - p.x0;
      if (!dragOn) {
        if (Math.abs(dx) < DRAG_SLOP) return; /* 还没过阈值：这一次仍可能只是「点块选行」 */
        startDrag(ev, p);
      }
      if (ev.cancelable !== false && typeof ev.preventDefault === "function") ev.preventDefault();
      panWindowBy(dx, p);
    });
    const onDragEnd = (ev) => {
      if (!dragPend) return;
      if (ev && ev.pointerId != null && ev.pointerId !== dragPend.id) return;
      const id = dragPend.id;
      const wasOn = dragOn;
      dragPend = null;
      dragOn = false;
      dragWin = null;
      try {
        if (rulerEl.releasePointerCapture && id != null) rulerEl.releasePointerCapture(id);
      } catch {
        /* 没捕获过 / 老引擎：忽略 */
      }
      if (!wasOn) return; /* 没过阈值 = 一次普通点击：什么都不用收 */
      /* 拖过了阈值：接下来那一小段里的 click / dblclick 一律吞掉（见下面的 swallow 监听）——
         拖动绝不能被读成「点块选行」，也绝不能让「双击轴」把刚拖到的窗归零。
         followTail 不再自己定：既有判据（scroll 监听里的 maxTop-top<=24）自然恢复跟随。 */
      dragSwallowUntil = Date.now() + DRAG_SWALLOW_MS;
      setDragCursor(false);
    };
    rulerEl.addEventListener("pointerup", onDragEnd);
    rulerEl.addEventListener("pointercancel", onDragEnd);
    if (typeof document.addEventListener === "function") {
      /* 兜底（捕获阶段先于轴自己的监听跑，onDragEnd 幂等）：候选期指针在轴外抬起也要收干净 */
      document.addEventListener("pointerup", onDragEnd, true);
      document.addEventListener("pointercancel", onDragEnd, true);
    }
    mainEl.appendChild(rulerEl);

    const cols = document.createElement("div");
    cols.className = "dsh-trace-cols";
    colsEl = cols;
    listEl = document.createElement("div");
    listEl.className = "dsh-trace-list";
    /* 加载更早一页的加载行与虚拟占位块都挂在滚动容器里（常驻节点，重绘时保留） */
    loadEl = mkBtn("dsh-trace-more", T("↑ 加载更早的步骤"), T("再往前加载一页更早的步骤"), () =>
      loadEarlier(),
    );
    loadEl.hidden = true;
    listEl.appendChild(loadEl);
    /* 占位块：撑总高（total × TRACE_ROW_H），**同时是行流的定位容器**（本次需求 ·
       横轴搬出滚动容器后，它是列表里的第一只节点，行流原点就在它自己的顶边）。 */
    spacerEl = document.createElement("div");
    spacerEl.className = "dsh-trace-spacer";
    listEl.appendChild(spacerEl);
    cols.appendChild(listEl);
    inspEl = document.createElement("aside");
    inspEl.className = "dsh-trace-insp";
    inspEl.hidden = true;
    cols.appendChild(inspEl);
    /* 详情栏宽度（本次需求）：分隔条排在列表与检查器之间（见 .dsh-trace-divider），
       宽度落在 cols 的 --dsh-trace-insp-w 上 —— 检查器 CSS 读它，默认 340 与旧值一致。 */
    bindInspResize();
    mainEl.appendChild(cols);

    /* 「回到底部跟随」浮标：挂在**轨迹列表自己那一栏**里（sticky 钉在滚动容器下沿）——
       不飘到右侧检查器上、也不压页脚；层级高于顶部横轴（见 --dsh-z-trace-tail）。
       它是列表里的最后一只常驻节点（排在占位块之后），清行时同样跳过。 */
    tailEl = mkBtn("dsh-trace-tailbar", T("↓ 回到底部跟随"), T("恢复跟随最新的记录"), () => {
      followTail = true;
      scrollToTail();
    });
    tailEl.hidden = true;
    listEl.appendChild(tailEl);

    footEl = document.createElement("div");
    footEl.className = "dsh-trace-foot";
    mainEl.appendChild(footEl);

    /* 滚动：算出虚拟窗口 + 是否暂停跟随；滚到顶自动补一页。 */
    listEl.addEventListener("scroll", () => {
      const top = Number(listEl.scrollTop) || 0;
      const maxTop = Math.max(
        0,
        (Number(listEl.scrollHeight) || 0) - (Number(listEl.clientHeight) || viewportH || 0),
      );
      /* 用户上滚（离开底部一段）即暂停跟随；回到接近底部自动恢复。
         拖动滑窗带期间例外（本轮需求 [23]）：那时列表是被拖动**按着窗中点**牵着滚的，
         滚到尾部一带也不许把跟随接回来（接回来会当场把列表抢回底部、窗又被拽走）——
         拖动期间一律 false，松手后这条判据自然恢复。 */
      followTail = dragOn ? false : maxTop - top <= 24;
      scrollTop = top;
      /* 滚到已挂窗口的顶端（不是整个列表的顶端）就先补一页更早的 */
      if (scrollTop <= 8 && winStart > 0) loadEarlier();
      renderRows();
    });

    /* 轨迹 → 对话：点分组头折叠 / 展开，点行选中，双击跳到对话那一段。
       本次需求撤掉「展开全文」开关后，这里不再有 .dsh-trace-expand 分支。 */
    listEl.addEventListener("click", (ev) => {
      const t = ev.target;
      const head = t && t.closest ? t.closest(".dsh-trace-group") : null;
      if (head && listEl.contains(head)) {
        toggleGroup(head.dataset.gkey, head.dataset.gkind);
        return;
      }
      const row = t && t.closest ? t.closest(".dsh-trace-row") : null;
      if (!row || !listEl.contains(row)) return;
      /* 选中一律按**段下标**（行的行号只是挂载顺序，段下标才是稳定键） */
      const segIdx = Number(row.dataset.segIdx);
      if (Number.isFinite(segIdx)) select(segIdx, !!(ev.detail >= 2));
    });

    /* 拖动收尾后的那一小段（DRAG_SWALLOW_MS）里把落在这条轴上的 click / dblclick 吞掉
       （本轮需求 [23]）：拖动绝不能被读成「点块选行」，也绝不能让轴上的 dblclick 把手刚
       拖到的窗归零（见 onDragEnd）。按**时间窗**吞（不在吞掉一个之后就把窗关掉）：
       click 与 dblclick 是先后两只事件，关早了第二只就漏进去、正好把手拖到的窗打成全轴。
       挂在 document 的**捕获**阶段、且注册在下面「点块选行」那条捕获监听之前 ——
       同阶段按注册顺序跑，它先跑就把这一对事件整条截住，块上的选中与轴上的双击都收不到。 */
    const swallowAfterDrag = (ev) => {
      if (Date.now() > dragSwallowUntil) return;
      const t = ev && ev.target;
      const inRuler = !!(rulerEl && t && (t === rulerEl || (rulerEl.contains && rulerEl.contains(t))));
      if (!inRuler) return;
      if (ev.cancelable !== false && typeof ev.preventDefault === "function") ev.preventDefault();
      if (typeof ev.stopPropagation === "function") ev.stopPropagation();
    };
    if (typeof document.addEventListener === "function") {
      document.addEventListener("click", swallowAfterDrag, true);
      document.addEventListener("dblclick", swallowAfterDrag, true);
    }

    /* ── 点上轴跳窗 + hover 绿线（本轮需求 [25]）─────────────────────────────
       两条监听都挂在轴身上（带自身仍然不吃指针，见 [23]）：
         · click = 把滑窗移到点到的那个时刻（窗长不变、点击处对齐窗中点）。点块那一下
           仍会走 document 捕获阶段那条既有监听选中该行 —— 本监听只负责移窗，两件事互不
           抢；刚拖完的那一下由 swallowAfterDrag 在捕获阶段整条截住（拖动 ≠ 点击跳窗）。
         · pointermove / pointerleave = hover 绿线（只在轴里出现，移出即收）。 */
    rulerEl.addEventListener("click", (ev) => {
      if (!ev) return;
      if (ev.button != null && ev.button !== 0) return;
      if (Date.now() <= dragSwallowUntil) return; /* 刚拖完：那一下不是点击 */
      if (dragOn || dragPend) return;
      if (!inPlotAt(ev)) return; /* 点在脚下的读数 / 图例上：不是点轴 */
      const t = timeAtClientX(ev);
      if (t == null) return;
      jumpToTime(t);
    });
    const onHoverMove = (ev) => {
      if (!ev) return;
      if (!inPlotAt(ev)) {
        if (hoverOn) {
          hoverOn = false;
          paintHover();
        }
        return;
      }
      const w = axisWidthPx();
      const x = Number(ev.clientX);
      const pr = rectOf(rulerPlotEl());
      let f = null;
      if (pr && pr.width > 0 && isFinite(x)) f = (x - pr.left) / pr.width;
      else if (w > 0 && isFinite(x)) f = x / w; /* 迷你 DOM：按「轴左缘 = 0」折算（同 click） */
      if (f == null) return;
      hoverOn = true;
      hoverF = Math.max(0, Math.min(1, f));
      paintHover();
    };
    rulerEl.addEventListener("pointermove", onHoverMove);
    rulerEl.addEventListener("pointerleave", () => {
      if (!hoverOn) return;
      hoverOn = false;
      paintHover();
    });

    /* 对话 → 轨迹：对话区点某个轨迹段（[data-seg-idx] / [data-seg]）且当前正看轨迹时，
       本视图跟着选中（捕获阶段挂一次，避免与对话区自己的点击处理抢）。 */
    document.addEventListener(
      "click",
      (ev) => {
        if (!mainEl || mainEl.hidden) return;
        const seg =
          ev.target && ev.target.closest ? ev.target.closest("[data-seg-idx],[data-seg]") : null;
        if (!seg || !listEl || listEl.contains(seg)) return;
        const idx = Number(seg.dataset.segIdx != null ? seg.dataset.segIdx : seg.dataset.seg);
        /* 轴上的块 data-seg-idx 就是段下标，直接选中那一**段**（别再转行号：
           select 收的是段下标，转了就会选中别的段）。 */
        if (Number.isFinite(idx)) select(idx, false);
      },
      true,
    );

    /* 挂到消息区**后面** —— 位置取「消息列在宿主里的顶层那一块」的下一个，不能直接拿
       `list.nextSibling` 当 insertBefore 的参照点。用户报的渲染错误就是这里抛的：
         `渲染错误：Uncaught NotFoundError: Failed to execute 'insertBefore' on 'Node':
          The node before which the new node is to be inserted is not a child of this node.
          @ app-trajectory.js:1696`
       成因：#agentList 不一定是 .agent-body 的直接子节点 ——
         · app-assist.js 的 ensureHistRail()（轮次轨的滚动壳）会把它包进 .hist-scroll-wrap、
           并把轮次轨（.hist-rail）**追加在消息列之后**：此时 list.nextSibling 是壳里的那条轨，
           它不是 .agent-body 的孩子 → insertBefore 当场抛 NotFoundError；
         · 开发页 / 助手栏借走会话正文时，它的父级又是 .apps-dev-conv / .assist-pane。
       抛一次就毁掉整块视图（mainEl 挂不上、hidden 也没人翻），而且**不是一次性的**：
       mainEl 因此永远 isConnected=false，之后每次重绘（renderAgentSession → sync）与
       boot 里那条 1.5s 轮询都会重建一次再抛一次。
       所以先上溯到「父级就是 .agent-body」的那一层再插：
         · 有壳 → 插在壳之后（仍在消息区之后，与旧行为一字不差）；
         · 没壳（老形态）→ 插在消息列之后，与旧行为一字不差；
         · 上溯不到（消息列被借到别处 / 已摘出文档）→ 退回 body 末尾：宁可位置略偏一次，
           也绝不让「挂一块视图」把整条 sync 抛出去 —— 这条兜底只在「消息列不在会话主体里
           且主区要重挂」的窄缝里生效，正常进出（会话视图 / 开发页借用）都走上面两条。 */
    let anchor = list;
    while (anchor.parentNode && anchor.parentNode !== body) anchor = anchor.parentNode;
    if (anchor.parentNode === body) body.insertBefore(mainEl, anchor.nextSibling);
    else body.appendChild(mainEl);
    return mainEl;
  }

  /* 折叠：轮头（只有这一级）。折叠后只留表头（段行不挂）。
     本轮需求撤掉了工具栏那两枚「全折 / 全展」按钮（用户口径：右端四枚按钮全移除）——
     轮次仍可单点轮头逐条折叠 / 展开，批量折叠没有了入口，故 collapseAll 一并删掉。 */
  function toggleGroup(key) {
    if (!key) return;
    const set = collapsedTurns;
    if (set.has(key)) set.delete(key);
    else set.add(key);
    rebuildRows(activeSession(), lastSegs, false);
    renderRows();
  }
  /* 更早一页：winStart 向前推一页；补进来的行高回补到滚动位置，否则用户会被顶到别处去。 */
  function loadEarlier() {
    if (loadingMore || winStart <= 0) return false;
    /* 往前补一页：按**行模型下标**（分组头也占行高），并守住「已挂段数大致是一页」。 */
    let segsBack = 0;
    let at = winStart;
    while (at > 0 && segsBack < TRACE_PAGE) {
      at--;
      const r = allRows[at];
      if (r && r.kind === "seg") segsBack++;
    }
    if (at >= winStart) return false;
    loadingMore = true;
    if (loadEl) {
      loadEl.hidden = false;
      loadEl.textContent = T("正在加载更早的步骤…");
    }
    winStart = at;
    /* 显式保留窗口（第三参 false = 不重置）——别漏这个实参：漏了就会按位置串到
       resetWindow 上，刚补进来的一页当帧被重置回尾部窗口（用户点着像没反应）。 */
    rebuildRows(activeSession(), lastSegs, false);
    renderRows();
    loadingMore = false;
    updateBar();
    return true;
  }
  function scrollToTail() {
    try {
      listEl.scrollTop = Number(listEl.scrollHeight) || 0;
      scrollTop = Number(listEl.scrollTop) || 0;
    } catch {
      /* 无布局（冒烟）时只翻标记 */
    }
    followTail = true;
    renderRows();
  }
  /* 常驻件的显隐收敛（本次需求删掉搜索后只剩两件）：加载行（还有更早的页才显示）
     与「回到底部跟随」浮标（暂停跟随时才显示）。 */
  function updateBar() {
    if (loadEl && !loadingMore) {
      const hasMore = winStart > 0;
      loadEl.hidden = !hasMore;
      if (hasMore) loadEl.textContent = T("↑ 加载更早的步骤");
    }
    if (tailEl) tailEl.hidden = followTail;
  }
  /* 行流容器 = 占位块（行挂在它里面，行的 top 就是它在行模型里的下标 × 行高）——
     没有它（理论上不会发生：ensureMain 里与列表同生共死）就退回列表本身。 */
  function rowsHost() {
    return spacerEl || listEl;
  }
  /* 已挂的行 / 分组头（按挂载顺序）：行流在占位块里；列表的直接子节点另有三只常驻件
     （加载行 / 占位块 / 回到底部浮标），它们不进「已挂行」这份口径。
     取「已挂元素」只此一处 —— 选择行、反查行、诊断计数共用它。 */
  function mountedEls() {
    const out = [];
    const host = rowsHost();
    if (host && host.children) for (const c of host.children) out.push(c);
    if (!listEl || !listEl.children || host === listEl) return out;
    for (const c of listEl.children) {
      if (c === loadEl || c === spacerEl || c === tailEl) continue;
      out.push(c);
    }
    return out;
  }
  /* 清空已挂的行（分组头 / 段行 / 空态提示）。
     children 是**活的 HTMLCollection**（没有 slice / filter 这些数组方法）——
     边遍历边删会漏行，必须先拷成数组：真窗口里 `children.slice()` 直接抛 TypeError，
     轨迹视图一进去就整块画不出来（见 render 里同一处）。分两层清：
       ① 行流容器（占位块）里的行；② 列表里的一次性节点（空态提示等）。
     三只常驻节点（加载行 / 占位块 / 回到底部浮标）一律跳过；顶部横轴已在滚动容器之外
     （本轮窗口化 · mainEl 的直接子件），不再需要在这里豁免。 */
  function clearRows() {
    const host = rowsHost();
    if (host && host.children) {
      for (const c of Array.from(host.children)) host.removeChild(c);
    }
    if (!listEl) return;
    for (const c of Array.from(listEl.children)) {
      if (c === loadEl || c === spacerEl || c === tailEl) continue;
      listEl.removeChild(c);
    }
  }
  /* 行流的起点（像素）：行绝对定位在占位块（rowsHost）里，占有块自己的顶边就是原点 ——
     量到非 0 只可能是列表的内边距盒偏移（本轮横轴搬出滚动容器后，轴上不再占这个偏移）。
     量不到（无布局环境，如冒烟里的迷你 DOM）就是 0：那时窗口按整表算，用不上这个偏移。 */
  function streamTop() {
    try {
      const v = Number(spacerEl && spacerEl.offsetTop);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }
  /* 按行号取**已挂的**那一行 DOM（行号 = 模块行模型下标，与 dataset.idx 同源） */
  function mountedRowAt(idx) {
    for (const c of mountedEls()) {
      if (!c || !c.dataset) continue;
      if (String(c.dataset.idx) === String(idx)) return c;
    }
    return null;
  }
  /* 按段下标取**已挂的**那一行 DOM（不在已挂切片里返回 null）。
     给冒烟与诊断用：行序不是契约，段下标才是。 */
  function mountedRowOf(segIdx) {
    for (const c of mountedEls()) {
      if (!c || !c.dataset) continue;
      if (String(c.dataset.segIdx) === String(segIdx)) return c;
    }
    return null;
  }
  /* 已挂出来的段数（页脚「已加载最近 N 步」用） */
  function mountedSegs() {
    let n = 0;
    for (const r of rows) if (r.kind === "seg") n++;
    return n;
  }

  /* 量视口与轴宿主宽度（一个渲染帧只量一次）：视口高给虚拟窗口裁行，宿主宽给刻度分档。 */
  function syncViewport() {
    try {
      const h = Number(listEl && listEl.clientHeight) || 0;
      if (h > 0) viewportH = h;
    } catch {
      /* 无布局时沿用上一次（或 0 = 全量挂） */
    }
    syncHostWidth();
  }

  /* ── 虚拟滚动：只挂可视行 + 上下缓冲，用占位块撑总高 ──────────────────────
     行高统一固定（TRACE_ROW_H）；展开行脱离虚拟窗口，此时整表全高列出（用户就一行要看全，
     再省 DOM 没意义，而且行高会变、滚动锚定不可控）。
     无布局环境（量不到 clientHeight，例如冒烟里的迷你 DOM）同样全量挂：不假装有视口，
     否则诊断与断言看到的就是一个被窗口裁过的假现场。 */
  function renderRows() {
    if (!listEl) return;
    /* 没有行可画（空会话 / 空态）：直接收工 —— 下面的「清掉旧行」只认行节点，
       会把 render() 挂上的空态提示一并清掉，用户看到的就是一片空白。
       顶部横轴同理：没有行就没有轴，收掉它（会话里确实没有可画的时刻）。 */
    if (!rows.length) {
      if (spacerEl) spacerEl.style.height = "0px";
      if (rulerEl) {
        clearRuler();
        rulerEl.hidden = true;
        rulerSig = "none";
      }
      updateBar();
      return;
    }
    /* children 是**活的 HTMLCollection**（没有 slice / filter 这些数组方法）——
       边遍历边删会漏行，必须先拷成数组（口径与写法都在 clearRows 里：它是唯一清行入口）。 */
    clearRows();
    /* 先量可视高度：占位块是常驻节点（ensureMain 就挂上，与滚动容器同生共死），
       这里量到的就是真视口。量不到（无布局环境，如冒烟里的迷你 DOM）才全量挂 ——
       别拿「量到 0」当无布局：真窗口首帧也可能还没布局完。 */
    syncViewport();
    /* 全局行号坐标系：占位高度、行号、行的 top、滚动位置全部按 allRows 下标来。
       （rows 是「通过折叠 / 分页过滤后的行集」，只决定哪些行该挂，不参与坐标换算。）
       行的 top 从**行流容器（占位块）顶**算起，而滚动位置从列表内边距盒顶算起 ——
       两者差 streamTop()（占位块相对列表内边距盒的偏移），换算时减掉它。 */
    const total = allRows.length;
    const shown = new Set(rows.map((r) => r.key));
    if (spacerEl) spacerEl.style.height = total * TRACE_ROW_H + "px";
    /* ── 先定滚动位置，再定挂行窗口（本次需求 · 不许出现「整帧的行都在可视区之外」）──
       跟随尾部时，本帧的滚动位置就是要贴到底（列表内容刚变、还没滚动过的那一帧，
       listEl.scrollTop 停在旧值 / 0 上）。这一步必须在窗口算式**之前**做完：
       否则窗口按旧 scrollTop 算，挂出来的行整段落在可视区之外 —— 首帧一片空，
       要等 followTail 的二次滚动再重画一次才补上，中间那一帧用户看到的就是空屏。
       口径不变：跟随态才自动贴底（用户上滚即暂停跟随，见 scroll 监听里的 maxTop-top<=24），
       贴底值由**占位块**（行模型总量 × 行高，本帧刚写死）算出，不读列表的 scrollHeight：
       后者在内容刚变、浏览器还没重排时仍是上一份内容的值，拿它做判据会让「该不该贴底」
       跟着上一份内容的长短摇摆（这也是「同一次渲染两种结果」的来源之一）。 */
    let followFloor = -1;
    if (followTail) {
      try {
        const spacerH = spacerEl ? Number(String(spacerEl.style.height).replace("px", "")) || 0 : 0;
        const ch = viewportH || Number(listEl.clientHeight) || 0;
        /* 贴底值 = 行流总高 + 行流起点 − 视口高（与占位公式同一套口径）；
           量不到占位块时退回列表自己的 scrollHeight（无布局环境，全量挂，贴不贴底都一样）。 */
        followFloor = spacerH > 0
          ? Math.max(0, spacerH + streamTop() - ch)
          : Math.max(0, (Number(listEl.scrollHeight) || 0) - ch);
        /* 该不该贴底：跟随态下「已经在列表顶端那一带（换会话 / 首次进表留下的 0）」
           或「离尾部 200px 以内」都贴。上半句是**首帧**的关键 —— 换会话时滚动位置归零，
           若无条件只看「离尾部多远」，38k 高的长会话首帧会判成「不贴」，
           于是窗口按 0 算：挂出来的行整段在可视区之外，列表一片空。
           用户自己上滚过就会先被 scroll 监听标成不跟随（followTail=false），所以这里
           不会把用户的滚动位置抢回底部。 */
        if (followFloor - (Number(listEl.scrollTop) || 0) < 200 || (Number(listEl.scrollTop) || 0) <= 8) {
          listEl.scrollTop = followFloor;
          scrollTop = Number(listEl.scrollTop) || 0;
        }
      } catch {
        /* 无布局时忽略 */
      }
    }
    /* 只有一个窗口：winStart 是已挂行的下界，可视区间直接按全局行号算
       （scrollTop − 行流起点 = 全局行号坐标系里的位置）。 */
    const streamAt = streamTop();
    const windowTop = Math.max(0, scrollTop - streamAt);
    let first = 0;
    let last = total;
    if (viewportH > 0 && total * TRACE_ROW_H > viewportH + TRACE_ROW_H) {
      first = Math.max(0, Math.floor(windowTop / TRACE_ROW_H) - TRACE_BUFFER);
      last = Math.min(total, Math.ceil((windowTop + viewportH) / TRACE_ROW_H) + TRACE_BUFFER);
    }
    /* 可视区间落在已挂窗口**之前**（分页还没补到那一带）时，把切片下移到窗口起点：
       那是这段内容里能显示的最早位置。**注意别在这里改 winStart** —— 渲染只读分页窗口，
       一改就等于把「往上翻页」的效果当帧抹掉（点加载行看着没反应）。
       下界同样不下探到 winStart 之前（未挂的行没有 DOM，挂了也是空白）。
       切片取的是**本帧滚动位置**（跟随尾部时上面刚把滚动位置定到底）对应的那一带窗口，
       不再是无脑取窗口起点那几行 —— 后者在长会话首帧（scrollTop=0、winStart=尾部）时
       挂出来的行整段落在可视区之外，正是首帧空屏的来源。未挂页没有 DOM，下界仍不下探。

       但「切片下移到窗口起点」只解决半程：**窗口起点本身就落在可视区之外**（恢复的滚动
       位置在中间、winStart 还停在尾部一页）时，无论怎么切，挂出来的行都在屏幕外 ——
       用户看到的是空列表、且不滚动就永远不触发补页（scroll 监听只在真有滚动事件时才跑）。
       所以这里补一条**只针对「错得很远」**的自愈：可视区间整段落在已挂窗口之前、
       且离窗口起点超过一屏缓冲（TRACE_BUFFER × TRACE_ROW_H）时，把窗口下界挪到可视区
       那几行所在的位置（与 loadEarlier 同一口径：只挪 winStart，行模型不动）。
       拖到「超过一屏缓冲」是为了不打断正常的往上翻页 —— 用户自己滚到顶端时可视区
       与 winStart 只差几行，走上面那条老路（切片下移），窗口起点照旧单调前移。 */
    if (last <= winStart) {
      const bandStart = Math.max(0, Math.floor(windowTop / TRACE_ROW_H) - TRACE_BUFFER);
      const bandLast = Math.min(total, Math.ceil((windowTop + viewportH) / TRACE_ROW_H) + TRACE_BUFFER);
      /* 自愈只在**可视区整段落在已挂窗口之前、且离窗口起点超过一屏缓冲**时动手；
         可视区若已经伸进窗口（bandLast > winStart）就不动窗口、只下移切片 —— 那正是
         「往上翻页」的正常态：用户自己滚到顶端时可视区刚挨着 winStart，
         窗口起点照旧单调前移（分页语义不变）。 */
      if (viewportH > 0 && bandStart > 0 && winStart - bandStart > TRACE_BUFFER) {
        winStart = Math.max(0, Math.min(bandStart, Math.max(0, bandLast - TRACE_BUFFER * 2)));
        /* 窗口下界一挪，`rows`（按 winStart 过滤出来的行集）当帧就得跟着重算 ——
           不重算的话新窗口里的行不在 shown 里，循环会把它们全部跳过（挂出 0 行）。 */
        rows = rowsInWindow();
        shown.clear();
        for (const r of rows) shown.add(r.key);
      }
      first = Math.max(bandStart, winStart);
      last = Math.min(total, Math.max(first + 1, Math.max(bandLast, winStart + TRACE_BUFFER * 2)));
    }
    first = Math.min(Math.max(first, winStart), Math.max(0, total - 1));
    last = Math.max(first + 1, Math.min(total, last));
    for (let i = first; i < last; i++) {
      const r = allRows[i];
      if (!r || !shown.has(r.key)) continue;
      /* 行号 = 全局下标（选择 / 检查器 / 轴 / 对话区反查共用它）；
         top 也按全局下标算 —— 与滚动位置同坐标系（原点 = 行流容器顶，见 streamTop）。 */
      const node = rowEl(r, i);
      if (!node) continue;
      node.style.top = i * TRACE_ROW_H + "px";
      rowsHost().appendChild(node);
    }

    updateBar();
    /* 顶部横轴跟着这一帧的可视区间重画（刻度 + 色块 3 轨 + 本视窗跨度读数）——
       放在行挂完之后：轴的数据来自 allRows（行模型）与 scrollTop / viewportH（当前视口），
       两者此刻都是最新的。签名没变时它自己收工，不重建 DOM（滚动时每帧实时跟随）。 */
    updateRuler();
    /* 贴底这一帧已在**窗口算式之前**用掉（followFloor，见上）：这里只做收尾 ——
       浏览器把 scrollTop 夹回 maxTop 时（列表高出来的那一帧会夹），把夹回来的真值同步回
       模块的 scrollTop，下一次窗口换算才不会按旧值算。绝不再动一次滚动位置：
       本帧挂的行就是按上面那个位置算的，再滚一次就又和已挂行错位一帧。 */
    if (followFloor >= 0) {
      try {
        const top = Number(listEl.scrollTop) || 0;
        if (top !== scrollTop) scrollTop = top;
      } catch {
        /* 无布局时忽略 */
      }
    }
  }

  /* 行内刻度栏（本次需求 · 时间上横轴之后的形态）：时刻 · 耗时 · 每步 token 缩成一小条
     定宽读数，紧贴正文之前 —— 行首不再有轴栏 / 序号 / 节点圆点（竖线整条撤掉），
     时间的主体（刻度与色块）搬到列表上方那条窗口横轴上（rulerFrame / updateRuler）。
     口径不变：序号是行内的「第几步」，**绝对时刻只在有真实值时才标** ——
     工具段取 rec.at（网关给的发起时刻），正文 / 思考段没有自己的时刻就整格写「—」，
     绝不插值、不编时间；token 只在该步**最后一段**那一行给（行 tooltip 里说明本步的
     token 值，历史会话没有内存 token 时间线就整句不提，见 tokenPlan）。 */
  function tickEl(row) {
    const seg = row && row.seg;
    if (!seg) return null;
    const rec = seg.rec || null;
    const el = document.createElement("span");
    el.className = "dsh-trace-tick";
    /* 三栏只有**有值时**才成栏：没有真实时刻就只留一枚淡淡的点（不写「未记到」——
       满格中文会把 32px 行高的正文摘要挤掉），耗时与 token 没有值就整栏不建。
       读数一个都不编：值全部来自 rec.at / rec.doneAt 与 usage 归步（见 tokenPlan）。 */
    const at = document.createElement("span");
    at.className = "dsh-trace-tick-at";
    if (rec && rec.at) at.textContent = fmtClock(rec.at);
    else {
      at.classList.add("off");
      at.textContent = "·";
    }
    el.appendChild(at);
    if (rec && rec.at && rec.doneAt) {
      const dur = document.createElement("span");
      dur.className = "dsh-trace-tick-dur";
      dur.textContent = fmtMs(rec.doneAt - rec.at);
      el.appendChild(dur);
    }
    if (row.tok) {
      /* 每步 token：**两段带色 span**（输入蓝 / 输出绿，同类名 .dsh-tok-in / .dsh-tok-out
         与检查器、Token 报告共用一份配色）+「（新增 N）」小字（纯新增输入，人眼分清
         「重发整份历史」与「这一步真加了东西」）。成型口径只有 tokStepNode 一处。 */
      const tok = tokStepNode(row.tok, "dsh-trace-tick-tok dsh-tok", true);
      if (tok) el.appendChild(tok);
    }
    const who = KIND_LABEL[seg.k] || seg.k;
    const bits = [who];
    if (row.stepNo != null) bits.push(Tn("第 {n} 步", row.stepNo));
    if (seg.step != null) bits.push("step " + seg.step);
    if (rec && rec.at) bits.push(T("发起") + " " + fmtClock(rec.at));
    if (rec && rec.at && rec.doneAt) bits.push(T("耗时") + " " + fmtMs(rec.doneAt - rec.at));
    const modelTxt = modelTextOf(row.stepTok);
    if (row.tok) {
      bits.push(T("每步 token") + " " + fmtInText(row.tok.in, row.tok.new) + " ↓" + fmtNum(row.tok.out));
      if (row.tok.calls > 1) bits.push(Tn("本步 {n} 次调用", row.tok.calls));
      if (modelTxt) bits.push(modelTxt);
    } else if (row.stepTok) {
      /* 本步记到了 token，但**不显示在这一行**（只显示在该步最后一段）：说清去哪儿看、
         并写明这一行属于哪一步，不让用户以为「这一步没记到」（用户口径）。 */
      const si = (Number(row.stepTok.input) || 0) +
        (Number(row.stepTok.cacheRead) || 0) +
        (Number(row.stepTok.cacheWrite) || 0);
      bits.push(
        T("本步 token ") +
          fmtInText(si, Number(row.stepTok.input) || 0) +
          " ↓" +
          fmtNum(row.stepTok.output) +
          T("（显示在本步最后一段）"),
      );
      if (row.stepNo != null) bits.push(Tn("这一行属于第 {n} 步", row.stepNo));
      if (modelTxt) bits.push(modelTxt);
    }
    /* 本步一条 usage 都没记到：行内**不写**这行状态字（用户口径：查询类说明留在
       tooltip 与检查器，行内不摆「未记到」）；此处仅当该会话完全没有记到过 usage
       时才整句不提 —— 老会话（改版前）本来就没有明细，提了才是误导。 */
    bits.push(rec && rec.at ? T("时刻取自工具调用的真实时间戳") : T("这一段没有独立时间戳"));
    el.title = bits.join(" · ");
    return el;
  }

  function groupEl(r) {
    const row = document.createElement("div");
    row.className = "dsh-trace-group g-" + r.kind + (r.collapsed ? " off" : "");
    row.dataset.gkey = r.key;
    row.dataset.gkind = r.kind;
    row.dataset.idx = "-1";
    const tw = document.createElement("span");
    tw.className = "dsh-trace-caret";
    tw.textContent = r.collapsed ? "▸" : "▾";
    /* 本次口径：分组头**不带**节点圆点 —— 时间已上横轴（列表上方那条窗口轴），行内不再有竖轨可骑，
       分组头只留一枚三角标「点它折 / 展这一组」。 */
    row.appendChild(tw);
    const label = document.createElement("b");
    label.className = "dsh-trace-group-label";
    label.textContent = r.label || "";
    row.appendChild(label);
    if (r.meta) {
      const meta = document.createElement("span");
      meta.className = "dsh-trace-group-meta";
      meta.textContent = r.meta;
      row.appendChild(meta);
    }
    return row;
  }

  /* 段类型类 t-* 是行**唯一**的类型口径（样式与检查器都按它认段类型）：
     本次需求撤掉竖轴之后，原先「骑在轴上的节点配色」类 n-* 已没有对应样式与节点，
     不再往行上挂 —— 留一个没有任何规则认的类名只会误导后人。 */

  function rowEl(r, idx) {
    if (!r) return null;
    if (r.kind !== "seg") return groupEl(r);
    const seg = r.seg;
    const row = document.createElement("div");
    row.className = "dsh-trace-row t-" + (KIND_LABEL[seg.k] ? seg.k : "say");
    row.dataset.idx = String(idx);
    row.dataset.segIdx = String(r.segIdx);
    row.dataset.seg = String(r.segIdx);
    if (seg.step != null) row.dataset.step = String(seg.step);
    if (r.segIdx === selected) row.classList.add("on");
    const running = !!(
      seg.k === "tool" &&
      seg.rec &&
      !seg.rec.result &&
      !seg.rec.error
    );
    /* 运行中的标记：只挂 run 类（行首一条柔光），行内不再写任何「运行中」字样；
       轴上的块同样带 run 类做呼吸 —— 这两处非文字线索是「还在跑」的唯一表达。 */
    if (running) row.classList.add("run");
    /* 工具族（本次需求）：行上仍挂族类，但**行内工具名不再取族色** ——
       行按「与对话一致」的口径上色（工具=青、思考=灰、失败=红，见 css/dsh-tokens.css 的
       .dsh-trace-row.t-* 一节）；族色只留在轴上那枚色块与图例里（一处一族色，不两说）。 */
    if (seg.k === "tool") {
      const rec0 = seg.rec || null;
      row.classList.add("fam-" + toolFamilyOf(rec0 && rec0.name).id);
      if (rec0 && rec0.error) row.classList.add("err");
    }

    const tick = tickEl(r);
    if (tick) row.appendChild(tick);

    const body = document.createElement("div");
    body.className = "dsh-trace-body";
    const rec = seg.rec || null;
    if (seg.k === "tool") {
      /* 工具行：一行摘要（标题 + 这次调用到底干了什么），明细都在右侧检查器里 */
      const sum = document.createElement("div");
      sum.className = "dsh-trace-tool";
      const nm = document.createElement("span");
      nm.className = "dsh-trace-tool-name";
      const label = rec && rec.name ? toolTitle(rec.name) : "";
      nm.textContent = label || seg.text || T("工具调用");
      sum.appendChild(nm);
      if (rec && rec.name && label !== String(rec.name)) {
        const raw = document.createElement("span");
        raw.className = "dsh-trace-tool-raw";
        raw.textContent = String(rec.name);
        sum.appendChild(raw);
      }
      body.appendChild(sum);
      /* 失败：一条工具调用最该被看见的几个字。
         耗时已经进轴侧刻度栏（tickEl），这里不再重复报一遍；
         「还在跑」不写字 —— 由行首柔光与轴上块呼吸表达，故仅有运行时态时整行 meta 不建。 */
      const meta = document.createElement("div");
      meta.className = "dsh-trace-row-meta";
      const mb = [];
      if (rec && rec.error) mb.push(T("失败"));
      meta.textContent = mb.join(" · ");
      if (meta.textContent) body.appendChild(meta);
    } else if (seg.k === "ctx") {
      const d = document.createElement("div");
      d.className = "dsh-trace-ctx";
      d.textContent = seg.text || "";
      body.appendChild(d);
    } else if (seg.k === "err") {
      const det = document.createElement("details");
      det.className = "dsh-trace-detail err";
      det.open = true;
      const sm = document.createElement("summary");
      sm.textContent = seg.text ? T("错误") : T("错误（无正文）");
      det.appendChild(sm);
      const pre = document.createElement("pre");
      pre.textContent = seg.text || "";
      det.appendChild(pre);
      body.appendChild(det);
    } else {
      /* 固定行高口径（本次需求 · 撤掉「展开全文」）：正文 / 思考一律折成一行、
         超出用省略号截断 —— 完整内容在右侧检查器与对话视图里看。
         展开态随之整条撤掉（expandedKey / toggleExpand / .dsh-trace-full 都不再存在），
         行的 top 与占位高因此永远只有「行号 × 固定行高」一种算法。 */
      const txt = document.createElement("div");
      txt.className = "dsh-trace-oneline";
      txt.textContent = firstLineOf(seg.text);
      body.appendChild(txt);
    }
    row.appendChild(body);
    return row;
  }

  function firstLineOf(text) {
    const s = String(text == null ? "" : text);
    const i = s.indexOf("\n");
    const head = i < 0 ? s : s.slice(0, i);
    return head || s.slice(0, 120) || T("（空段）");
  }

  /** 选中第 idx 步；jump=true 时切回对话视图并滚到对应那一段（闪一下）。 */
  function select(segIdx, jump) {
    selected = segIdx;
    if (listEl) {
      /* 行挂在行流容器（占位块）里：选中态要按「已挂的行」扫，不能只看列表的直接子节点 */
      for (const row of mountedEls()) {
        const on = row.dataset && String(row.dataset.segIdx) === String(segIdx);
        row.classList.toggle("on", on);
        if (on && jump) {
          try {
            row.scrollIntoView({ block: "nearest" });
          } catch {
            /* 老 Chromium 没有平滑参数也照样滚 */
          }
        }
      }
    }
    renderInspector();
    if (!jump) return;
    /* 「跳到对话」= 切回对话视图 + 定位那一段：轨迹视图下对话区是 hidden，
       直接 scrollIntoView 是无效的（隐藏元素没有布局盒）。 */
    const st = activeSession();
    if (st && viewOf(st) === "trace") {
      st.trajView = "";
      try {
        if (typeof persistAgentSession === "function") persistAgentSession();
      } catch {
        /* ignore */
      }
      sync();
    }
    const seg =
      document.querySelector('[data-seg-idx="' + segIdx + '"]') ||
      document.querySelector('[data-seg="' + segIdx + '"]');
    if (!seg) return;
    try {
      seg.scrollIntoView({ block: "center" });
    } catch {
      /* ignore */
    }
    seg.classList.remove("dsh-flash");
    void seg.offsetWidth; /* 重启动画：读一次 offsetWidth 触发回流 */
    seg.classList.add("dsh-flash");
    setTimeout(() => seg.classList.remove("dsh-flash"), 1000);
  }

  /* 代码块：行号槽 + 语法高亮（复用右侧文件面板那一套 fileviewHighlight / .jsl-* 词法，
     与「检查器看代码」的上游口径同源 —— 有行号、可复制原文）。 */
  function codeBlock(text, lang) {
    const wrap = document.createElement("div");
    wrap.className = "dsh-trace-code";
    const lines = String(text == null ? "" : text).split("\n");
    const gutter = document.createElement("div");
    gutter.className = "dsh-trace-ln";
    for (let i = 1; i <= lines.length; i++) {
      const n = document.createElement("span");
      n.textContent = String(i);
      gutter.appendChild(n);
    }
    const pre = document.createElement("pre");
    pre.className = "dsh-trace-src";
    let html = null;
    try {
      if (typeof fileviewHighlight === "function")
        html = fileviewHighlight(String(text || ""), lang || "");
    } catch {
      html = null;
    }
    if (html == null) {
      const esc = document.createElement("div");
      esc.textContent = String(text || "");
      html = esc.innerHTML;
    }
    pre.innerHTML = html;
    wrap.appendChild(gutter);
    wrap.appendChild(pre);
    return wrap;
  }
  function copyBtn(text, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini dsh-trace-copy";
    b.textContent = label || T("复制");
    b.title = T("复制原文到剪贴板");
    b.addEventListener("mousedown", (ev) => ev.stopPropagation());
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const done = () => {
        b.textContent = T("已复制");
        b.classList.add("ok");
        setTimeout(() => {
          b.textContent = label || T("复制");
          b.classList.remove("ok");
        }, 1200);
      };
      const fail = () => {
        b.textContent = T("复制失败");
        setTimeout(() => (b.textContent = label || T("复制")), 1200);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(text == null ? "" : text)).then(done, fail);
          return;
        }
      } catch {
        /* 走下面的兜底 */
      }
      fail();
    });
    return b;
  }
  /* 参数/结果的展示语言（决定用哪套词法）：json 优先，其次按文件后缀 */
  function langOf(text, path) {
    const s = String(text || "").trim();
    if (s.charAt(0) === "{" || s.charAt(0) === "[") return "json";
    const m = /\.([a-z0-9]+)$/i.exec(String(path || ""));
    return m ? m[1].toLowerCase() : "";
  }
  function toolArgsPath(rec) {
    const a = rec && rec.args;
    if (!a || typeof a !== "object") return "";
    return String(a.file_path || a.path || a.filename || "");
  }
  function resultTextOf(rec) {
    try {
      if (typeof toolResultText === "function") return toolResultText(rec) || "";
    } catch {
      /* 抽不到就自己拼 */
    }
    const parts = [];
    for (const b of Array.isArray(rec && rec.result) ? rec.result : []) {
      if (b && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("\n\n").trim();
  }

  /* ── JSON 树（上游「完整 JSON 对象或数组使用树形展示」）───────────────────
     默认折到两层：叶子直接给值，容器给「对象 · N 项」；点标题展开 / 收起。
     工具栏那枚「树形 / 代码」按钮切回带行号的代码块（上游 `{}` 切换同读法）。 */
  const JSON_TREE_MAX = 200;
  function jsonTreeEl(value, depth, budget) {
    const box = document.createElement("div");
    box.className = "dsh-trace-json";
    if (value === null || typeof value !== "object") {
      const leaf = document.createElement("span");
      leaf.className = "dsh-trace-json-leaf";
      try {
        leaf.textContent = JSON.stringify(value);
      } catch {
        leaf.textContent = String(value);
      }
      box.appendChild(leaf);
      return box;
    }
    const isArr = Array.isArray(value);
    const keys = isArr ? value.map((_, i) => String(i)) : Object.keys(value);
    const det = document.createElement("details");
    det.className = "dsh-trace-json-node";
    det.open = (depth || 0) < 2;
    const sm = document.createElement("summary");
    sm.textContent = (isArr ? T("数组") : T("对象")) + " · " + keys.length + T(" 项");
    det.appendChild(sm);
    const bud = budget || { n: 0 };
    for (const k of keys) {
      bud.n++;
      if (bud.n > JSON_TREE_MAX) break;
      const line = document.createElement("div");
      line.className = "dsh-trace-json-line";
      const kn = document.createElement("span");
      kn.className = "dsh-trace-json-key";
      kn.textContent = (isArr ? "[" + k + "]" : k) + ": ";
      line.appendChild(kn);
      line.appendChild(jsonTreeEl(value[k], (depth || 0) + 1, bud));
      det.appendChild(line);
    }
    box.appendChild(det);
    return box;
  }
  function jsonOf(text) {
    const s = String(text || "").trim();
    if (!s || (s.charAt(0) !== "{" && s.charAt(0) !== "[")) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
  /* 一栏代码类内容：JSON 树 / 代码切换 + 复制。外面那层始终是 .dsh-trace-code
     （「一块带行号的代码块」这条既有口径不变：树形只是把它换一种呈现）。 */
  function codeSection(label, raw, path) {
    const host = document.createElement("div");
    host.className = "dsh-trace-insp-block";
    const tools = document.createElement("div");
    tools.className = "dsh-trace-insp-tools";
    const tree = jsonOf(raw);
    if (tree != null) {
      tools.appendChild(
        mkBtn(
          "mini dsh-trace-mode",
          inspRaw ? T("树形") : T("代码"),
          T("在 JSON 树与代码之间切换"),
          () => {
            inspRaw = !inspRaw;
            renderInspector();
          },
        ),
      );
    }
    tools.appendChild(copyBtn(raw, T("复制") + label));
    host.appendChild(tools);
    const wrap = codeBlock(raw, langOf(raw, path));
    if (tree != null && !inspRaw) {
      /* 树形：行号槽收起（树没有行号可言），源码槽换挂 JSON 树 —— 与代码互斥，不并排 */
      const gut = wrap.querySelector(".dsh-trace-ln");
      const pre = wrap.querySelector(".dsh-trace-src");
      if (gut) gut.hidden = true;
      if (pre) {
        pre.hidden = true;
        pre.textContent = "";
      }
      wrap.appendChild(jsonTreeEl(tree, 0, { n: 0 }));
    }
    host.appendChild(wrap);
    return host;
  }

  /* ── 文件改动 diff（本次需求）：薄层，只取对话侧那份实现 ─────────────────────
     对话（renderer/app-assist.js 的工具卡）先算好 diff、再画 .dsh-diff 块，两个真函数由
     该文件挂到 window.MTNodeChatDiff（唯一一处）。轨迹这边**不复制算法**：
       · 挂上了 → 直接拿来用（同一份行级 diff、同一套皮肤、同一个折叠上限）；
       · 没挂上（老壳 / 名字改了 / 顺带被删）→ 返回 null = 检查器只是不显示 diff，
         参数与结果照常给（绝不因此抛错，也绝不偷偷自己算一份）。
     判据（哪些工具算编辑类）完全在对手那边：write|write_file|create_file 与
     edit|edit_file|str_replace_editor|apply_patch，本文件不重写这份名单。 */
  function chatDiffOf(rec) {
    if (!rec || !rec.name) return null;
    try {
      const api = typeof window !== "undefined" ? window.MTNodeChatDiff : null;
      if (!api || typeof api.of !== "function") return null;
      return api.of(rec) || null;
    } catch {
      return null;
    }
  }
  function chatDiffEl(diff) {
    if (!diff) return null;
    try {
      const api = typeof window !== "undefined" ? window.MTNodeChatDiff : null;
      if (!api || typeof api.el !== "function") return null;
      return api.el(diff) || null;
    } catch {
      return null;
    }
  }
  /* 「参数」分节的可折叠版（本次需求 · 拷问口径）：与「结果」分节同长相（同一条 label +
     同一套代码块 / JSON 树），只是正文收进一只 details —— 默认收起，点标题就地展开。
     它是给**编辑类事件**用的（diff 已经在上方把改动说清楚了，参数那一大坨原文收起来）。 */
  function foldSec(label, node) {
    const box = document.createElement("div");
    box.className = "dsh-trace-insp-sec dsh-trace-sec-fold";
    const det = document.createElement("details");
    det.className = "dsh-trace-fold";
    det.open = false; /* 默认收起（本次需求 · 拷问口径）：写明白，别只靠「没设过 open」 */
    const sm = document.createElement("summary");
    sm.className = "dsh-trace-insp-label";
    sm.textContent = label;
    sm.title = T("点一下展开原始参数");
    det.appendChild(sm);
    det.appendChild(node);
    box.appendChild(det);
    inspEl.appendChild(box);
  }

  /* ── 检查器（上游 Trajectory 的「选中记录 → 局部检查器」）──────────────────
     内容：类型 / 轮·步 / 时间 / 耗时 / 每步 token / 步间隔 / 工具名 / 参数 / 结果 / 错误。
     受设置·开发者工具约束：关掉时只给一句提示，不给明细入口。 */
  function renderInspector() {
    if (!inspEl) return;
    const st = activeSession();
    /* 选中值是**段下标**：段一律回 lastSegs 里查（行号会随虚拟窗口变，段下标不会）。 */
    const segIdx = selected;
    const seg = segIdx >= 0 && segIdx < lastSegs.length ? lastSegs[segIdx] : null;
    if (!seg) {
      inspEl.hidden = true;
      inspEl.textContent = "";
      syncInspDivider();
      return;
    }
    inspEl.hidden = false;
    inspEl.textContent = "";
    const head = document.createElement("div");
    head.className = "dsh-trace-insp-head";
    const title = document.createElement("b");
    title.textContent = KIND_LABEL[seg.k] || seg.k;
    head.appendChild(title);
    const rec = seg.rec || (seg.callId ? toolMapOf(st).get(String(seg.callId)) : null);
    if (rec && rec.name) {
      const nm = document.createElement("span");
      nm.className = "dsh-trace-insp-name";
      nm.textContent = toolTitle(rec.name);
      nm.title = String(rec.name);
      head.appendChild(nm);
    }
    inspEl.appendChild(head);
    const meta = document.createElement("div");
    meta.className = "dsh-trace-insp-meta";
    const bits = [];
    /* 检查器与轮头同一个轮号（会话轮号 = 用户第几次发送），不再显示网关内部的 turn */
    if (seg.round) bits.push(Tn("第 {n} 轮", seg.round));
    if (seg.step != null) bits.push(Tn("第 {n} 步", seg.step));
    if (rec && rec.at) bits.push(fmtClock(rec.at));
    if (rec && rec.at && rec.doneAt) bits.push(T("耗时 ") + fmtMs(rec.doneAt - rec.at));
    if (rec && rec.result && rec.result.length) {
      const bytes = rec.result.reduce((n, b) => n + String((b && b.text) || "").length, 0);
      bits.push(T("结果 ") + (bytes > 1024 ? Math.round(bytes / 1024) + " KB" : bytes + " B"));
    }
    /* 每步 token（本轮修复：按 (轮号, 步号) 明细取数，明细不在才回落内存时间线 ——
       见 tokenPlan）。这一步记到了就念出来（含「（新增 N）」与「服务商 · 模型」）；
       真没记到才明说「未记到」（该会话从没记到过 usage 就整句不提，那种「未记到」是误导）。 */
    const tokPlan = tokenPlan(st, lastSegs);
    /* 按**选中的这一行的轮号**取明细（同一会话里第 1 轮的 step 1 与第 2 轮的 step 1
       不能串台）：明细取到就用它，否则退回该步在计划表里的累计（内存时间线口径）。 */
    const tokDetail = tokPlan.detailInRound(seg.round, seg.step);
    const tok = tokDetail
      ? {
          input: Number(tokDetail.input) || 0,
          output: Number(tokDetail.output) || 0,
          cacheRead: Number(tokDetail.cacheRead) || 0,
          cacheWrite: Number(tokDetail.cacheWrite) || 0,
          calls: Math.max(1, Number(tokDetail.calls) || 1),
          provider: String(tokDetail.provider || ""),
          model: String(tokDetail.model || ""),
        }
      : (() => {
          const gi = tokPlan.giOfSeg.get(segIdx);
          return gi == null ? null : tokPlan.byGi.get(gi) || null;
        })();
    let tokNode = null;
    if (tok) {
      const inBill = (Number(tok.input) || 0) + (Number(tok.cacheRead) || 0) + (Number(tok.cacheWrite) || 0);
      const outN = Number(tok.output) || 0;
      if (inBill || outN) {
        tokNode = tokStepNode(
          {
            in: inBill,
            out: outN,
            new: Number(tok.input) || 0,
            calls: Number(tok.calls) || 0,
          },
          "dsh-tok",
          false,
        );
      }
    }
    const modelTxt = modelTextOf(tok);
    const gap = stepGapOf(st, segIdx, lastSegs);
    if (gap) bits.push(T("步间隔 ") + fmtMs(gap));
    if (modelTxt) bits.push(modelTxt);
    /* 文本段与 token 段拼成一行：分隔符写进各自的 textContent（不用 createTextNode ——
       冒烟里的迷你 DOM 没有它，而这几行只是拼字，没有别的语义）。 */
    const sep = bits.length && (tokNode || seg.k === "tool" || seg.k === "say" || seg.k === "think")
      ? " · "
      : "";
    if (tokNode) {
      meta.textContent = bits.join(" · ") + sep + T("本步 token ") + " ";
      meta.appendChild(tokNode);
    } else if (
      tokPlan.hasLine &&
      (seg.k === "tool" || seg.k === "say" || seg.k === "think" || seg.k === "err")
    ) {
      /* 这个会话确实记到过 usage，偏偏这一步没有 → 明说没记到（不编数字）。
         整条线都没记到过（改版前的老会话，明细不回填）就整句不提 token —— 那种
         「未记到」是误导。 */
      meta.textContent =
        bits.join(" · ") + sep + T("本步 token 未记到（这一步没有 usage 记录）");
    } else {
      meta.textContent = bits.join(" · ");
    }
    inspEl.appendChild(meta);
    if (!devOn()) {
      const hint = document.createElement("div");
      hint.className = "dsh-trace-insp-hint";
      hint.textContent = T("参数与结果明细在「设置 · 开发者工具」里打开（轨迹本身不受影响）");
      inspEl.appendChild(hint);
      syncInspDivider();
      return;
    }
    const sec = (label, node) => {
      const box = document.createElement("div");
      box.className = "dsh-trace-insp-sec";
      const l = document.createElement("div");
      l.className = "dsh-trace-insp-label";
      l.textContent = label;
      box.appendChild(l);
      box.appendChild(node);
      inspEl.appendChild(box);
    };
    /* 文件改动 diff（本次需求 · 用户口径「所有代码编辑也应当实现与对话中代码 diff 一致的样式」）：
       与对话工具卡同一读法 —— **差异在最前**、逐行 +/- 着色、超过折叠上限给「… 其余 N 行」。
       算法与皮肤都不在本题重写：走的还是 app-assist.js 挂出来的 window.MTNodeChatDiff
       （of = 认编辑类工具 + 算 diff，el = 画 .dsh-diff 块），轨迹这边只负责摆位置。
       拿不到那份全局（将来改名 / 被删）就**只是不显示 diff**，检查器照常给参数 / 结果 ——
       不在轨迹里再写一份算法，那正是「两份实现早晚走神」的老路。 */
    const diff = chatDiffOf(rec);
    if (diff) {
      const host = document.createElement("div");
      host.className = "dsh-trace-insp-block";
      const l = document.createElement("div");
      l.className = "dsh-trace-insp-label";
      l.textContent = T("文件改动");
      host.appendChild(l);
      const dEl = chatDiffEl(diff);
      if (dEl) host.appendChild(dEl);
      const box = document.createElement("div");
      box.className = "dsh-trace-insp-sec";
      box.appendChild(host);
      inspEl.appendChild(box);
    }
    if (rec && rec.args) {
      const raw = typeof rec.args === "string" ? rec.args : JSON.stringify(rec.args, null, 2);
      /* 有 diff 时参数**默认收起**（本次需求 · 拷问口径：diff 置顶、参数折成可展开 details，
         与「结果」分节同长相）；没有 diff（read / grep / shell 等）时维持原样直接摊开。 */
      if (diff) foldSec(T("参数"), codeSection(T("参数"), raw, toolArgsPath(rec)));
      else sec(T("参数"), codeSection(T("参数"), raw, toolArgsPath(rec)));
    }
    const out = rec ? resultTextOf(rec) : seg.text;
    if (out) {
      sec(
        rec && rec.error ? T("结果（出错）") : T("结果"),
        codeSection(T("结果"), out, toolArgsPath(rec)),
      );
    } else if (seg.text) {
      const p = document.createElement("div");
      p.className = "dsh-trace-insp-text";
      p.textContent = seg.text;
      p.appendChild(copyBtn(seg.text, T("复制")));
      sec(T("内容"), p);
    }
    syncInspDivider();
  }

  /* ── 顶部横轴（本轮需求 · 整个会话的总时间轴 + 当前视窗的滑窗带）───────────────
     用户口径（拷问已确认，取代上一版「只剩窗口轴」）：
       · 这一条轴画的是**整个会话**：横坐标范围 = 全会话最早一次调用的 at …
         最晚一次的 end；刻度是这段跨度内等距的绝对时刻（数量按宿主宽度分档 2/3/4 个）；
       · **当前滚动视窗**对应的时间段用一条半透明「滑窗带」叠在轴上（左 = 视窗内最早
         那条调用的 at，右 = 视窗内最晚那条的 end），随滚动每帧实时移动；
         视窗内一条带真实时刻的调用都没有时，**只是不画那条带**（轴照常显示）——
         不插值、不按行号比例估算窗口边界；
       · 只给**工具调用段**标点（思考 / 正文 / 上下文段没有自己的时刻，不推算、不编时刻）；
       · 轴内**固定 3 条轨**（不足补空轨 → 轴高恒定），同一时刻超过 3 个调用时并回已有轨
         叠画（轨上给一枚「叠 N」计数，不藏数据）；色块 = 一次工具调用，长度 = 真实耗时；
       · 图例按**整个会话**累计计数（不随滚动变）；读数行报**本视窗**的步数 / 跨度 / 起止；
       · 点块 = 选中并滚到那行（块带 data-seg-idx，行走列表自己的 click 处理）。

     数据事实（不许编）：目前只有工具调用记录带真实时刻（rec.at 发起 / rec.doneAt 结果回来，
     见 app-assist.js 的工具分支）—— 思考 / 正文 / 上下文段没有自己的时刻，因此轴上不给它们标点。
     刻度值 = **整个会话跨度内**等距取的绝对时刻（不是真实事件时刻，只作尺度参照）。

     布局与虚拟滚动的关系：轴是列表**之外**的固定一行（mainEl 的直接子件），
     不进滚动流、不占行号坐标 —— 行流（所有段行 / 分组头）挂在占位块里，占位块是列表的第一只
     节点，行号坐标系与滚动位置同原点（streamTop() 量占位块的 offsetTop，滚动位置换算时减掉）。
     轴高固定（3 轨 + 脚下两行）：它不随并行度长高，也就不会与虚拟滚动的「本屏可见行数」互相推高。 */
  /* 轴内固定轨数：不足补空轨、超出并轨叠画 —— 轴高恒定、绝不无限长。 */
  const RULER_TRACKS = 3;

  /* 刻度数量按宿主宽度分档（本次需求 · 窄窗口不让刻度挤成一团）：
     <420px → 2 个，<760px → 3 个，更宽 → 4 个；量不到宽度（无布局环境，如冒烟里的迷你 DOM）
     固定 3 个 —— 不假装知道宽度。 */
  function tickCountFor(w) {
    const n = Number(w) || 0;
    if (n <= 0) return 3;
    if (n < 420) return 2;
    if (n < 760) return 3;
    return 4;
  }
  /* 本轴宿主（.dsh-trace-main）的宽度：刻度分档与轴区封顶都按它算。量不到就沿用上一次（或 0）。 */
  function syncHostWidth() {
    try {
      const w = Number(mainEl && mainEl.clientWidth) || 0;
      if (w > 0) hostW = w;
    } catch {
      /* 无布局时沿用上一次（或 0 = 按 3 个刻度画） */
    }
  }

  /* 横轴的重画从「清空」开始：显式 removeChild 而不是 textContent = "" ——
     本模块的迷你 DOM（test/smoke-trajectory-view.js）里 textContent 只覆盖文本、
     不摘子节点，用它会**越画越多**（真 DOM 与冒烟的读法必须同源）。 */
  function clearRuler() {
    if (!rulerEl) return;
    for (const c of Array.from(rulerEl.children)) rulerEl.removeChild(c);
  }

  /* 本视窗（当前滚动位置 + 可视高度）对应的全局行号区间；量不到视口
     （无布局环境，如冒烟里的迷你 DOM）就取全表。 */
  function visibleRowRange() {
    const total = allRows.length;
    if (viewportH > 0 && total * TRACE_ROW_H > viewportH) {
      /* 坐标换算与 renderRows 同一口径：先减掉行流起点（占位块）的像素偏移，
         否则「本视窗」会多算列表顶部那一两行。量不到布局时 streamTop() = 0（迷你 DOM）。 */
      const top = Math.max(0, scrollTop - streamTop());
      return {
        first: Math.max(0, Math.floor(top / TRACE_ROW_H)),
        last: Math.min(total, Math.ceil((top + viewportH) / TRACE_ROW_H)),
      };
    }
    return { first: 0, last: total };
  }

  /* 每一行的真实时刻（**只读已有记录**，抽不到就 null，不推算）：
     工具段取 rec.at，结束取 rec.doneAt（没有就按 at 起算，宽度给最小像素）。 */
  function rowTimeOf(r) {
    const rec = r && r.seg ? r.seg.rec : null;
    if (!rec || !rec.at) return null;
    const at = Number(rec.at) || 0;
    if (!at) return null;
    const doneAt = Number(rec.doneAt) || 0;
    /* run = 这次调用还没有结果回来（与行上的 run 类同一判据，见 rowEl 的 running） */
    return { at, end: doneAt > at ? doneAt : at, run: !rec.result && !rec.error };
  }

  /* 缩放态的读法（本轮需求 · 滚轮横向拉伸）：
     把 [zoomLo, zoomHi] 收进本会话全轴 [min, max]，并在**本视窗那一段跑偏到窗外**时
     把窗平移回去 —— 拉伸只改尺度，绝不把「你在看的那一段」关在窗外。
     跑偏的判据是「视窗时间段的**中点**落在窗内 15%–85% 之外」（不是「带整体出窗」）：
     真实会话里一屏常常装着大半条带，用「出窗」当判据会让兜底**每一帧都触发**，
     缩放窗被一路推回全轴 —— 用户滚轮拉近的效果当场消失（本轮第一版就是这样）。
     缩放归零 / 窗已贴住全轴 → 回 null（照全轴画，一个像素都不差）。 */
  function domainOf(min, max, band) {
    const full = Math.max(1, max - min);
    if (zoomLo == null || zoomHi == null || activeSessionId() !== zoomSession) return null;
    let lo = Math.max(min, Math.min(Number(zoomLo) || 0, max));
    let hi = Math.min(max, Math.max(Number(zoomHi) || 0, min));
    if (!(hi - lo > 1)) return null;
    if (band && hi > lo) {
      /* 本视窗时间段的**中点**在窗内的相对位置（0 = 窗左缘、1 = 窗右缘）：
         落在 15%–85% 之外 = 用户已经滚到这一段之外，把窗平移过去盖住它。 */
      const mid = (band.at + band.end) / 2;
      const f = (mid - lo) / (hi - lo);
      if (f < 0.15 || f > 0.85) {
        const len = Math.min(full, hi - lo);
        let nlo = Math.max(min, Math.min(mid - len / 2, max - len));
        let nhi = nlo + len;
        if (nhi > max) {
          nhi = max;
          nlo = Math.max(min, max - len);
        }
        zoomLo = nlo;
        zoomHi = nhi;
        lo = nlo;
        hi = nhi;
      }
    }
    if (hi - lo >= full - 1) return null; /* 没真的拉近 → 与全轴同一份几何 */
    return { min: lo, max: hi };
  }

  /* ── 滑窗带拖动（本轮需求 [23]）：命中判定 → 折算平移 → 列表跟随 ──────────────
     这一段只做「怎么拖」：命中判定（带自身不吃指针，按落点判）、Δx → Δ时间、窗平移与夹取、
     以及把窗中点交给列表跟随那条路。状态与三个指针监听见 dragPend / ensureMain。 */

  /* 一只元素的可量矩形（量不到布局 → null）。真 DOM 与冒烟迷你 DOM 都走这一处兜底。 */
  function rectOf(el) {
    try {
      const r =
        el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      if (!r) return null;
      const w = Number(r.width) || 0;
      const h = Number(r.height) || 0;
      if (!(w > 0) && !(h > 0)) return null;
      return { left: Number(r.left) || 0, top: Number(r.top) || 0, width: w, height: h };
    } catch {
      return null;
    }
  }
  /* 百分比字符串 → 数（"12.5%" → 12.5）；不是数就 null（不编位置） */
  function pctOf(v) {
    const n = parseFloat(String(v == null ? "" : v));
    return isFinite(n) ? n : null;
  }
  /* 轴上那两只关键元素：滑窗带（拖动的命中对象）与绘图区（横坐标的容器）。 */
  function rulerBandEl() {
    try {
      return rulerEl && typeof rulerEl.querySelector === "function"
        ? rulerEl.querySelector(".dsh-trace-window")
        : null;
    } catch {
      return null;
    }
  }
  function rulerPlotEl() {
    try {
      return rulerEl && typeof rulerEl.querySelector === "function"
        ? rulerEl.querySelector(".dsh-trace-ruler-plot")
        : null;
    } catch {
      return null;
    }
  }
  /* 轴的绘制宽度（px）=「Δx → Δ时间」的分母。量不到绘图区就退回轴身自己的宽（减去左右内边距
     6px × 2），再量不到才用轴宿主宽度；都没有（0）= 折不出时间 → 根本不该开始拖。 */
  function axisWidthPx() {
    const pr = rectOf(rulerPlotEl());
    if (pr && pr.width > 0) return pr.width;
    const rr = rectOf(rulerEl);
    if (rr && rr.width > 12) return rr.width - 12;
    return hostW > 0 ? hostW : 0;
  }
  /* 按下点是不是落在滑窗带上（带的横向范围就是可抓范围）：
     真 DOM 直接用带自己的矩形 —— 带是 top:0;bottom:0 铺满绘图区的，纵向也一并判掉
     （按在脚下的读数行 / 图例上不算抓带）；
     量不到布局（老引擎）就退回「绘图区 + 带的 left / width 百分比」；两者都量不到
     （冒烟里的迷你 DOM / 合成事件没带坐标）时按「按在带上」处理 —— 那种环境里无从判定，
     而按下后不动仍只是一次点击，不会误伤块的选中。 */
  function bandHitAt(ev) {
    const band = rulerBandEl();
    if (!band) return null;
    const x = Number(ev && ev.clientX);
    const y = Number(ev && ev.clientY);
    const br = rectOf(band);
    if (br && isFinite(x)) {
      const pad = 2;
      if (x < br.left - pad || x > br.left + br.width + pad) return null;
      if (isFinite(y) && (y < br.top - pad || y > br.top + br.height + pad)) return null;
      return band;
    }
    const pr = rectOf(rulerPlotEl());
    const l = pctOf(band.style && band.style.left);
    const w = pctOf(band.style && band.style.width);
    if (!pr || l == null || !isFinite(x)) return band;
    const x0 = pr.left + (pr.width * l) / 100;
    const x1 = x0 + Math.max(2, (pr.width * (w || 0)) / 100);
    return x >= x0 - 2 && x <= x1 + 2 ? band : null;
  }
  /* 拖动态的可见口径：轴光标 grabbing + 轴与带各挂一枚 .dragging（带在重画时按 dragOn 补类）。
     签名一并作废 —— 「在拖」这事进了画出来的那一份读数，得让它当帧重画一次。 */
  function setDragCursor(on) {
    try {
      if (rulerEl && rulerEl.style) rulerEl.style.cursor = on ? "grabbing" : "";
    } catch {
      /* 迷你 DOM 没有 style 也不该在这里炸 */
    }
    try {
      if (rulerEl && rulerEl.classList) {
        if (on) rulerEl.classList.add("dragging");
        else rulerEl.classList.remove("dragging");
      }
    } catch {
      /* 没有 classList 时忽略（只是少一枚视觉标记） */
    }
    rulerSig = "";
    updateRuler();
  }
  /* 进拖动态（位移过阈值那一刻才走这一条，见 ensureMain 的 pointermove）：
     捕获指针 + 暂停跟随 + 光标与 .dragging。**不在这里改窗** —— 平移由 panWindowBy 做。 */
  function startDrag(ev, p) {
    dragOn = true;
    /* 拖动期间暂停跟随：列表要按窗中点走，绝不能被「贴底」抢回尾部 */
    followTail = false;
    updateBar();
    try {
      if (rulerEl && rulerEl.setPointerCapture && p && p.id != null) rulerEl.setPointerCapture(p.id);
    } catch {
      /* 合成事件 / 老引擎没有捕获：轴上那条 pointermove 依旧收得到（指针还在轴上时） */
    }
    setDragCursor(true);
  }
  /* 中止在拖的那一次（Esc / 双击轴归零 / 换会话）：拖动与「回全轴」同时发生没有意义，
     收干净捕获、类与光标，不留半拖状态。回执 = 这一下真的收掉了什么。 */
  function abortDrag() {
    if (!dragPend && !dragOn) return false;
    const id = dragPend ? dragPend.id : null;
    const wasOn = dragOn;
    dragPend = null;
    dragOn = false;
    dragWin = null;
    try {
      if (rulerEl && rulerEl.releasePointerCapture && id != null) rulerEl.releasePointerCapture(id);
    } catch {
      /* 没捕获过就没什么可放 */
    }
    if (wasOn) setDragCursor(false);
    return true;
  }
  /* 平移这一步（本轮需求 [23] 的核心）：
     Δx → Δ时间（尺度 = 本帧 domain，缩放后就是拉近的那一段）→ 窗整体平移（**窗长不变**）
     → 夹进本会话全轴 [min,max] → 窗中点交给列表跟随。两种态各有一份「窗」：
       · 缩放态：平移的就是缩放窗本身（写回 zoomLo / zoomHi；贴住全轴即归零，与滚轮同一条夹法）；
       · 未缩放：全轴装得下整个会话、没有可平移的缩放窗，平移的是**滑窗带本身**
         （本视窗那段真实时刻区间，窗长 = 这段跨度），中点照样交给列表跟随。 */
  function panWindowBy(dx, p) {
    if (!p || p.lastDx === dx) return; /* 指针没动（同一位置重复到达）：本帧无事可做 */
    p.lastDx = dx;
    const dt = dx * p.perPx;
    const full = p.full;
    const half = p.len / 2;
    /* 中点允许的范围 = 窗整体必须落在全轴之内（窗比全轴还长时就只留全轴中点） */
    const lo = full.min + half;
    const hi = full.max - half;
    let mid = p.base + dt;
    mid = hi >= lo ? Math.max(lo, Math.min(mid, hi)) : (full.min + full.max) / 2;
    dragWin = { lo: mid - half, hi: mid + half };
    if (p.canPan) {
      const fullSpan = Math.max(1, full.max - full.min);
      if (dragWin.hi - dragWin.lo >= fullSpan - fullSpan / 1000) {
        /* 贴着全轴（<= 1/1000 的差别）→ 直接归零，让轴干净地回全轴那一份几何 */
        zoomLo = null;
        zoomHi = null;
      } else {
        zoomLo = dragWin.lo;
        zoomHi = dragWin.hi;
        zoomSession = activeSessionId();
      }
      rulerSig = ""; /* 窗变了：签名作废（与滚轮同一条路） */
    }
    followMid(mid);
    updateRuler();
  }

  /* ── 点上轴跳窗 + hover 绿线（本轮需求 [25]）───────────────────────────────
     用户口径两条：
       · **点轴上任何时间点都让滑窗过去**：点空白处 = 只移窗（不改选中）；点事件方块 =
         选中该行 + 同时移窗（选中那条通路一个字没动 —— 块上的 data-seg-idx 走 document
         捕获阶段那条既有监听，本段只负责移窗）；
       · **hover 时一条绿色呼吸灯线**跟着指针走（只在轴里出现），线上挂一枚时刻读数。
     移窗口径与拖动平移**同一套**（别改回去）：窗**长不变**，点击处对齐**窗中点**；
     缩放态平移的就是缩放窗本身（贴住全轴即归零，与滚轮同一条夹法），未缩放时全轴装得下
     整个会话、平移的是**滑窗带本身**（本视窗那段真实时刻区间），中点照样交给列表跟随。
     缩放态点一下**不回全轴**（用户口径）：拉近的那一段是用户自己拉的，与跳窗互不干扰。 */
  function timeAtClientX(ev) {
    if (!lastDom) return null;
    const w = axisWidthPx();
    if (!(w > 0)) return null;
    const x = Number(ev && ev.clientX);
    if (!isFinite(x)) return null;
    const pr = rectOf(rulerPlotEl());
    /* 量得到绘图区就按它折算（真窗口）；量不到（冒烟里的迷你 DOM）按「轴左缘 = 0」
       折算 —— 与滚轮那条锚点兜底同一口径，绝不编一个假的指针位置。 */
    let f = pr && pr.width > 0 ? (x - pr.left) / pr.width : x / w;
    f = Math.max(0, Math.min(1, f));
    return lastDom.min + (lastDom.max - lastDom.min) * f;
  }
  /* 这一次点击算不算「点在轴的时间区」：点在脚下的读数 / 图例上不算（量不到布局则一律算）。 */
  function inPlotAt(ev) {
    const pr = rectOf(rulerPlotEl());
    if (!pr) return true;
    const y = Number(ev && ev.clientY);
    if (!isFinite(y)) return true;
    return y >= pr.top - 1 && y <= pr.top + pr.height + 1;
  }
  function jumpToTime(t) {
    if (!isFinite(t)) return false;
    const fr = rulerFrame();
    if (!fr) return false;
    const full = { min: fr.min, max: fr.max };
    const dom = fr.dom || full;
    const dSpan = Math.max(1, dom.max - dom.min);
    const canPan = dSpan < Math.max(1, full.max - full.min) - 1;
    const band = fr.band;
    const len = canPan ? dSpan : band ? Math.max(1, band.end - band.at) : 0;
    if (!(len > 0)) return false; /* 视窗内没有任何带时刻的调用：没有可平移的窗（不编位置） */
    const half = len / 2;
    const lo = full.min + half;
    const hi = full.max - half;
    const mid = hi >= lo ? Math.max(lo, Math.min(t, hi)) : (full.min + full.max) / 2;
    dragWin = null; /* 点一下不是拖动：脚下不留「拖动中」那段读数 */
    if (canPan) {
      const fullSpan = Math.max(1, full.max - full.min);
      if (len >= fullSpan - fullSpan / 1000) {
        /* 贴着全轴（<= 1/1000 的差别）→ 归零，让轴干净地回全轴那一份几何 */
        zoomLo = null;
        zoomHi = null;
      } else {
        zoomLo = mid - half;
        zoomHi = mid + half;
        zoomSession = activeSessionId();
      }
      rulerSig = ""; /* 窗变了：签名作废（与滚轮 / 拖动同一条路） */
      updateRuler();
    }
    followMid(mid);
    return true;
  }
  /* hover 线上的那只元素（没有就 null）。 */
  function hoverElOf() {
    try {
      return rulerEl && rulerEl.querySelector
        ? rulerEl.querySelector(".dsh-trace-hoverline")
        : null;
    } catch {
      return null;
    }
  }
  /* 指针在轴上的那一刻（读数用）：按本帧时间窗与指针比例折算，量不到就不给数。 */
  function hoverTime() {
    if (!lastDom) return 0;
    return lastDom.min + (lastDom.max - lastDom.min) * hoverF;
  }
  /* 画 / 收那条 hover 绿线（幂等；滚动重画之后由 updateRuler 尾部再调一次补回来）。 */
  function paintHover() {
    if (!rulerEl) return false;
    const cur = hoverElOf();
    if (!hoverOn || !lastDom) {
      if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
      return false;
    }
    const plot = rulerPlotEl();
    if (!plot) return false;
    let el = cur;
    if (!el) {
      el = document.createElement("div");
      el.className = "dsh-trace-hoverline";
      el.id = "agentTraceHoverLine";
      const lb = document.createElement("span");
      lb.className = "dsh-trace-hover-time";
      el.appendChild(lb);
      plot.appendChild(el);
    }
    el.style.left = (hoverF * 100).toFixed(3) + "%";
    /* setAttribute 是给「行内写法可复核」留的可读副本（真 DOM 里与 style 同步，
       迷你 DOM（冒烟）里 style 是普通对象、只有这一份能被检查到）。 */
    el.setAttribute("style", "left:" + el.style.left);
    const lb = el.querySelector ? el.querySelector(".dsh-trace-hover-time") : null;
    if (lb) {
      const t = hoverTime();
      lb.textContent = t ? fmtClock(t) : "";
      lb.title = T("指针下的时刻（点一下就把视窗移到这一刻）");
      /* 贴边不裁：左端 8% 以内左对齐、右端 8% 以内右对齐，中间居中 */
      lb.style.transform =
        hoverF < 0.08 ? "none" : hoverF > 0.92 ? "translateX(-100%)" : "translateX(-50%)";
    }
    return true;
  }
  /* 列表跟随（「滚到某一行」那条既有通路，本轮需求 [23]）：把窗**中点时刻**交给它 ——
     按时刻找最近的那一个段行（段行里只有工具调用带真实时刻，见 rowTimeOf），
     按行号算出滚动位置滚过去，再 renderRows 把那一带挂出来（虚拟滚动下目标行多半没挂，
     所以不能靠 DOM 反查）。列表一滚，滑窗带由可见行的真实时刻重算 → 带随动，闭环。
     拖动只滚列表、**不改选中**：选中仍归「点块 / 点行」那条既有通路（轴上点块 = select）。 */
  function followMid(t) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < allRows.length; i++) {
      const r = allRows[i];
      if (!r || r.kind !== "seg") continue;
      const rt = rowTimeOf(r);
      if (!rt) continue;
      const d = Math.abs((rt.at + rt.end) / 2 - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return false; /* 一条带真实时刻的调用都没有：不滚（不编位置） */
    return scrollRowCenter(best);
  }
  /* 按**行号**把列表滚到那一行（尽量居中；两端夹回可滚范围）+ 挂出那一带的行。
     与 renderRows 同一套坐标：行流起点 = streamTop()，总高 = allRows.length × 行高。 */
  function scrollRowCenter(idx) {
    if (!listEl || !(idx >= 0)) return false;
    const streamAt = streamTop();
    const ch = viewportH || Number(listEl.clientHeight) || 0;
    const maxTop = Math.max(0, allRows.length * TRACE_ROW_H + streamAt - ch);
    const want = idx * TRACE_ROW_H + streamAt - ch / 2 + TRACE_ROW_H / 2;
    const top = Math.max(0, Math.min(want, maxTop));
    try {
      listEl.scrollTop = top;
    } catch {
      /* 无布局（冒烟）时只同步模块的 scrollTop，与 scrollToTail 同口径 */
    }
    scrollTop = Number(listEl.scrollTop) || top;
    renderRows();
    return true;
  }

  /* 一帧要画的轴的几何（本轮需求 · 全轴 + 滑窗带）：
       · marks / ticks = **整个会话**：横坐标范围 = 全会话最早一次调用的 at … 最晚一次的 end，
         刻度是这段跨度内等距的绝对时刻（数量按宿主宽度分档 2/3/4 个）；
       · band = **本视窗**（当前滚动位置 + 可视高度）内那些调用的真实时刻范围，画成一条
         半透明滑窗带叠在轴上、随滚动每帧移动；视窗内一条带时刻的调用都没有 → band = null
         （只不画那条带，轴照常显示；绝不按行号比例估算窗口边界）；
       · 轨分配与图例次数都按**整个会话**算（图例不随滚动变）。 */
  function rulerFrame() {
    const win = visibleRowRange();
    const all = [];
    const inWin = [];
    for (let i = 0; i < allRows.length; i++) {
      const r = allRows[i];
      if (!r || r.kind !== "seg") continue;
      const t = rowTimeOf(r);
      if (!t) continue;
      /* 族与失败态都取**这条调用自己的记录**（rec.name / rec.error），抽不到就落兜底族：
         没有名字的老记录照样画一块，只是颜色归「其它」灰（不编名字、不猜族）。 */
      const rec = (r.seg && r.seg.rec) || null;
      const nm = rec && rec.name ? String(rec.name) : "";
      const fam = toolFamilyOf(nm);
      const m = {
        i,
        segIdx: r.segIdx,
        k: r.seg.k,
        at: t.at,
        end: t.end,
        run: t.run,
        fam,
        sub: fam.id === FAM_SUB.id,
        err: !!(rec && rec.error),
        name: nm,
        label: nm ? toolTitle(nm) : "",
      };
      all.push(m);
      if (i >= win.first && i < win.last) inWin.push(m);
    }
    if (!all.length) return null; /* 整个会话都没有真实时刻 → 轴区不显示 */
    all.sort((a, b) => a.at - b.at);
    let min = all[0].at;
    let max = all[0].end;
    for (const m of all) {
      if (m.at < min) min = m.at;
      if (m.end > max) max = m.end;
    }
    /* 全会话只有一个时刻（或全挤在同一毫秒）时给一个最小跨度，让它在轴上有个可读的位置 ——
       跨度取「真实耗时的两倍」且不小于 0.4s：整个块因此**居中**占轴宽的一半
       （前后留白等宽）。刻度只是尺度参照，不冒充真实区间；真实耗时本来就够长时
       不必补，因为下面 clamp 出来的跨度（2×耗时）天然不小于它。 */
    if (max - min < 1000) {
      const mid = (min + max) / 2;
      const span0 = Math.max(400, (max - min) * 2);
      /* 时刻是从 0 起算的毫秒数：左边界不越过 0（不编出一个不存在的负时刻） */
      min = Math.min(Math.max(0, mid - span0 / 2), min);
      max = Math.max(min + span0, mid + span0 / 2, max);
    }
    const span = Math.max(1, max - min);
    /* 本视窗的时间段（滑窗带）：只取视窗内**真实**时刻的 min / max —— 没有就 null。 */
    let band = null;
    let bandFlat = null;
    if (inWin.length) {
      let wMin = inWin[0].at;
      let wMax = inWin[0].end;
      for (const m of inWin) {
        if (m.at < wMin) wMin = m.at;
        if (m.end > wMax) wMax = m.end;
      }
      bandFlat = { at: wMin, end: wMax };
    }
    /* 本帧真正画的时间窗（本轮需求 · 滚轮横向拉伸）：
       没缩放 → [min, max]（全轴）；缩放过 → domainOf 收好的那一段（锚点与视窗都保住）。
       刻度、色块、滑窗带**全部**按这只窗算百分比 —— 三者永远同一套横坐标。 */
    const dom = domainOf(min, max, bandFlat) || { min, max };
    if (bandFlat) {
      band = {
        at: bandFlat.at,
        end: bandFlat.end,
        left: ((bandFlat.at - dom.min) / Math.max(1, dom.max - dom.min)) * 100,
        width: Math.max(0.6, ((bandFlat.end - bandFlat.at) / Math.max(1, dom.max - dom.min)) * 100),
      };
    }
    const marks = all;
    /* 图例：按**整个会话**（all）统计每族的调用次数，只列出现过的族。
       顺序固定 = TOOL_FAMILIES 的顺序，兜底「其它」压尾 —— 图例因此不随滚动 / 重绘跳位
       （次数也按整个会话算，同一屏里数字不会忽大忽小）。 */
    const seen = new Map();
    for (const m of all) seen.set(m.fam.id, (seen.get(m.fam.id) || 0) + 1);
    const legend = legendOf(seen);
    /* 固定 3 轨分配（本次需求 · 轨数不再按需长）：
       · **主流固定第 1 轨**：非子代理调用取第一条空闲的非子代理轨（第 1 轨空着就一定是它）；
       · **子代理调用**（sub 族）各占一条专属轨（第 2 轨起，轨左标一枚「子代理」小字），
         其时间跨度内到达的其它调用优先并进它那条轨 —— 严格归属要网关在工具事件里带
         会话 id，现在只有 callId / turn / step，故按**时间跨度**做启发式（见文件头 [10]），
         不改网关。子代理那条横条本就横跨整条轨，本轨里的其它块叠在它上面：描边块套着看，
         正好是「这一段时间里子代理自己干了什么」；
       · **3 条轨都占着**就把这一块并回已有轨叠画（同一时刻 >3 个调用时）—— 轴不长高、
         也不藏数据，轨上另有「叠 N」计数（stackN 按同轨重叠峰值扫出来）。 */
    const tracks = [];
    for (let k = 0; k < RULER_TRACKS; k++) tracks.push({ last: 0, sub: null });
    for (const m of marks) {
      let put = -1;
      if (m.sub) {
        /* 子代理优先占一条还空着的非第 1 轨（第 1 轨留给主流）；没有空的就沿后一条子代理轨叠 */
        for (let k = 1; k < RULER_TRACKS; k++) {
          if (!tracks[k].sub && tracks[k].last <= m.at) {
            put = k;
            break;
          }
        }
        if (put < 0) {
          for (let k = 1; k < RULER_TRACKS; k++) {
            if (!tracks[k].sub) {
              put = k;
              break;
            }
          }
        }
        if (put >= 0) {
          tracks[put].sub = m;
          tracks[put].subAt = m.at;
          tracks[put].subEnd = m.end;
        }
      } else {
        /* 1) 落在某条子代理轨的跨度里、且该轨上的块不打架 → 并进它（last 只记本轨已放的
              **非子代理**块，子代理那条横条不参与这门碰撞账 —— 它就是本轨的背景跨度） */
        for (let k = 0; k < RULER_TRACKS; k++) {
          const tr = tracks[k];
          if (!tr.sub || tr.last > m.at) continue;
          if (m.at < tr.subAt || m.at > tr.subEnd) continue;
          put = k;
          break;
        }
        /* 2) 主流：第一条空闲的非子代理轨 */
        if (put < 0) {
          for (let k = 0; k < RULER_TRACKS; k++) {
            const tr = tracks[k];
            if (tr.sub || tr.last > m.at) continue;
            put = k;
            break;
          }
        }
        /* 3) 都占着 → 并回第 1 轨叠画（轴不长第 4 条轨） */
        if (put < 0) put = 0;
      }
      /* 碰撞账只记**非子代理**块：子代理那条横条本身就是本轨的背景跨度（它的起止另记在
         subAt / subEnd 上），若把它的 end 也写进 last，它跨度内的调用就全被自己挡在轨外了。 */
      if (!m.sub) tracks[put].last = Math.max(m.end, m.at + span * 0.012);
      m.track = put;
    }
    /* 每轨的重叠峰值（见上面第 3 条口径）：按左右端点扫一遍，>1 时轨上给一枚「叠 N」——
       替掉旧的「轴内纵向滚动」，数据不藏、只是叠着画。 */
    const stackN = new Array(RULER_TRACKS).fill(1);
    for (let k = 0; k < RULER_TRACKS; k++) {
      const evs = [];
      for (const m of marks) {
        if (m.track !== k) continue;
        evs.push({ t: m.at, d: 1 });
        evs.push({ t: Math.max(m.end, m.at + 1), d: -1 });
      }
      evs.sort((a, b) => a.t - b.t || a.d - b.d);
      let cur = 0;
      for (const e of evs) {
        cur += e.d;
        if (cur > stackN[k]) stackN[k] = cur;
      }
    }
    const ticks = [];
    const tickN = tickCountFor(hostW);
    /* 刻度值取**当前画出来的这只窗**内的等距绝对时刻（未缩放时等于全轴刻度，逐位相同） */
    const dSpan = Math.max(1, dom.max - dom.min);
    for (let k = 0; k < tickN; k++) ticks.push(dom.min + (dSpan * k) / Math.max(1, tickN - 1));
    return {
      marks,
      ticks,
      span,
      min,
      max,
      /* 本帧画的时间窗（缩放后与 min/max 不同）：块的 left / width 与刻度都按它算 */
      dom,
      zoom: span / dSpan,
      trackN: RULER_TRACKS,
      stackN,
      legend,
      /* 本视窗的滑窗带（null = 视窗内没有任何带真实时刻的调用：只不画带，轴照常） */
      band,
      /* 每轨是不是「子代理轨」（是则带上那枚子代理调用：轨左要标小字） */
      trackSub: tracks.map((t) => (t.sub ? { name: t.sub.name, label: t.sub.label } : null)),
    };
  }

  /* 图例数据（整会话次数的读法只此一处：唯一一条轴共用同一套顺序 / 兜底）。 */
  function legendOf(seen) {
    const legend = [];
    for (const f of TOOL_FAMILIES) {
      if (seen.has(f.id)) legend.push({ id: f.id, label: f.label, count: seen.get(f.id) });
    }
    if (seen.has(FAM_OTHER.id))
      legend.push({ id: FAM_OTHER.id, label: FAM_OTHER.label, count: seen.get(FAM_OTHER.id) });
    return legend;
  }

  /* 按一帧几何重画顶部横轴：刻度行 + 色块轨道（固定 3 条）+ 读数 + 图例（后两件各占一行，
     在轨道**下方**）。只在「画出来的东西真的变了」时重建 DOM
     （滚动每帧都会调它 —— 实时跟随，签名一样就收工）。 */
  function updateRuler() {
    if (!rulerEl) return;
    const fr = rulerFrame();
    /* 整个会话都没有带真实时刻的记录 → 轴区不显示（连占位都不要，列表直接顶上） */
    if (!fr) {
      /* 轴都没了：hover 读数与「点击折算」也跟着失效（不留上一帧的时间窗） */
      lastDom = null;
      hoverOn = false;
      if (rulerSig !== "none") {
        clearRuler();
        rulerEl.hidden = true;
        rulerSig = "none";
      }
      return;
    }
    const win = visibleRowRange();
    let segsInView = 0;
    for (let i = win.first; i < win.last; i++) {
      if (allRows[i] && allRows[i].kind === "seg") segsInView++;
    }
    /* 本帧画的时间窗记下来：hover 读数与「点击折算成时刻」共用这一份（见 timeAtClientX /
       hoverTime）—— 两者都在重画之外发生，不能各自去 rulerFrame() 重算。 */
    lastDom = { min: fr.dom.min, max: fr.dom.max };
    /* 刻度数量也进签名（宿主变宽变窄时重画）。 */
    const tickN = fr.ticks.length;
    const legendSig = fr.legend.map((g) => g.id + ":" + g.count).join(",");
    /* 几何签名里带上族 / 失败态 / 子代理标记 / 轨号：族或轨一变就得重画（不只是位置变）。
       滑窗带的位置也进签名 —— 滚动时轴本身不动，动的就是这条带。 */
    const geom = fr.marks.map(
      (m) =>
        m.segIdx +
        "@" +
        (((m.at - fr.dom.min) / Math.max(1, fr.dom.max - fr.dom.min)) * 100).toFixed(2) +
        "w" +
        Math.max(0.4, ((m.end - m.at) / Math.max(1, fr.dom.max - fr.dom.min)) * 100).toFixed(2) +
        "t" +
        m.track +
        "f" +
        m.fam.id +
        (m.err ? "e" : "") +
        (m.sub ? "s" : ""),
    );
    const bandSig = fr.band
      ? fr.band.left.toFixed(2) + "+" + fr.band.width.toFixed(2)
      : "-";
    const sig =
      "win" +
      "|" +
      fr.trackN +
      "|" +
      segsInView +
      "|" +
      tickN +
      "|" +
      fmtMs(fr.span) +
      "|" +
      /* 缩放倍数进签名（倍数是约数会给错帧：用两位小数，一档滚轮必变） */
      (fr.zoom || 1).toFixed(2) +
      "|" +
      viewportH +
      "|" +
      hostW +
      "|" +
      legendSig +
      "|" +
      bandSig +
      "|" +
      /* 拖动态也进签名（本轮需求 [23]）：点在拖时带挂 .dragging、脚下读数多一句「拖动中」，
         窗被夹在两端（位置不再变）时签名就靠这几项变化 —— 否则那一帧会按旧签名被跳过。 */
      (dragOn ? "drag" + (dragWin ? dragWin.lo.toFixed(0) + "-" + dragWin.hi.toFixed(0) : "") : "") +
      "|" +
      geom.join(",");
    if (sig === rulerSig) return;
    rulerSig = sig;
    rulerEl.hidden = false;
    clearRuler();
    /* 固定 3 轨写进自定义属性（轨区高度由 CSS 用 calc(轨数 × 轨高) 算出来，轴高因此恒定）。
       写法用 setProperty（带 typeof 守卫）：直接 `style["--x"] = v` 在真 CSSStyleDeclaration 上
       是**无效**的（实测只有空 inline 文本），冒烟里的迷你 DOM 又没有 setProperty ——
       两条路都留，取交集语义。 */
    const setVar = (el, k, v) => {
      if (!el || !el.style) return;
      if (typeof el.style.setProperty === "function") el.style.setProperty(k, v);
      else el.style[k] = v;
    };
    setVar(rulerEl, "--dsh-trace-tracks", String(fr.trackN));
    /* 轨数固定，轴高不再需要封顶变量；清掉可能残留的旧值（上一版按宿主高度写进来的
       --dsh-trace-maxh 还挂在同一个元素上时，CSS 里那份兜底封顶会误伤）。 */
    try {
      if (rulerEl.style && typeof rulerEl.style.removeProperty === "function")
        rulerEl.style.removeProperty("--dsh-trace-maxh");
    } catch {
      /* 迷你 DOM 没有 removeProperty：不写它就是了 */
    }

    /* 轴体的绘图区（刻度行 + 色块轨 + 滑窗带共用一个定位容器）：
       滑窗带要与刻度、色块**同一套横坐标**，所以三者必须同宽同原点。 */
    const plot = document.createElement("div");
    plot.className = "dsh-trace-ruler-plot";

    /* 刻度行：**当前画出来的那只时间窗**内等距的绝对时刻（数量按宿主宽度分档：2 / 3 / 4 个）。
       未缩放时窗 = 全轴（与上一版逐位相同）；滚轮拉近后刻度跟着变细。
       首尾各留一点内边距，避免贴边被裁。 */
    const ticks = document.createElement("div");
    ticks.className = "dsh-trace-ruler-ticks";
    fr.ticks.forEach((t, i) => {
      const el = document.createElement("span");
      el.className = "dsh-trace-ruler-tick";
      el.textContent = fmtClock(t);
      el.style.left = 4 + (i * 92) / Math.max(1, fr.ticks.length - 1) + "%";
      ticks.appendChild(el);
    });
    plot.appendChild(ticks);

    /* 色块时间带：一次工具调用 = 一个块，横坐标 = 绝对时刻，宽度 = 真实耗时，固定 3 轨。
       块上带 data-seg-idx（与段行同源）—— 点块经列表的既有 click 处理选中并滚到那一行。
       轨左可有一枚「子代理」小字、轨右可有一枚「叠 N」（同轨叠画峰值 >1 时）——
       两者都绝对定位、不占横向时间坐标。 */
    const bands = document.createElement("div");
    bands.className = "dsh-trace-ruler-tracks";
    for (let k = 0; k < fr.trackN; k++) {
      const tr = document.createElement("div");
      tr.className = "dsh-trace-track n" + k;
      if (fr.trackSub && fr.trackSub[k]) {
        tr.classList.add("sub");
        const lb = document.createElement("span");
        lb.className = "dsh-trace-track-label";
        lb.textContent = familyLabel(FAM_SUB);
        /* tooltip 说清这条轨是什么、以及是哪一枚子代理调用（名字抽不到就只留前半句） */
        const sl = fr.trackSub[k].label;
        lb.title = T("子代理轨（这一轨是子代理自己的调用）") + (sl ? " · " + sl : "");
        tr.appendChild(lb);
      }
      if (fr.stackN && fr.stackN[k] > 1) {
        const st = document.createElement("span");
        st.className = "dsh-trace-stack";
        st.textContent = T("叠 ") + fr.stackN[k];
        st.title = T("这一轨上有 ") + fr.stackN[k] + T(" 个调用在时间上重叠（轴内固定 3 轨，重叠的块叠着画）");
        tr.appendChild(st);
      }
      bands.appendChild(tr);
    }
    for (const m of fr.marks) {
      const bar = document.createElement("button");
      bar.type = "button";
      /* 类名四件：段类型（t-*，既有的唯一类型口径）+ 工具族（fam-*，取 --dsh-fam 上色）
         + 失败（err，压过族色）+ 运行中（run，按本块族色呼吸）。 */
      bar.className =
        "dsh-trace-mark t-" +
        (KIND_LABEL[m.k] ? m.k : "say") +
        " fam-" +
        m.fam.id +
        (m.err ? " err" : "") +
        (m.run ? " run" : "");
      bar.dataset.segIdx = String(m.segIdx);
      bar.dataset.at = String(m.at);
      bar.dataset.fam = m.fam.id;
      /* 横坐标按**本帧的时间窗**算（fr.dom）：未缩放时 = 全轴，缩放后 = 拉近的那一段 */
      const dSpan = Math.max(1, fr.dom.max - fr.dom.min);
      bar.style.left = (((m.at - fr.dom.min) / dSpan) * 100).toFixed(3) + "%";
      bar.style.width = Math.max(0.4, ((m.end - m.at) / dSpan) * 100).toFixed(3) + "%";
      /* tooltip：族名 · 工具名（与族名重复就省一件）· 时刻 · 耗时 —— 块上没有字，
         是哪一次调用只能从这儿读。 */
      const bits = [familyLabel(m.fam)];
      if (m.label && m.label !== familyLabel(m.fam)) bits.push(m.label);
      bits.push(fmtClock(m.at));
      const dur = fmtMs(m.end - m.at);
      if (dur) bits.push(dur);
      bar.title = bits.join(" · ");
      /* 描边直角块：行内只落 left / width 两条几何，**不写**底色与圆角（实心填充 +
        3px 圆角那套写法一律不许回来，静态口径见 test/smoke-trajectory-view.js 的 [9]）。
        setAttribute 是给「行内写法可复核」留的可读副本：真 DOM 里与 style 同步，
        迷你 DOM（冒烟）里 style 是普通对象、只有这一份能被检查到。 */
      bar.setAttribute("style", "left:" + bar.style.left + ";width:" + bar.style.width);
      const tr = bands.children[m.track] || bands.children[0];
      if (tr) tr.appendChild(bar);
    }
    plot.appendChild(bands);

    /* 滑窗带（本轮需求 [23] 起还可拖动）：把**当前滚动视窗**对应的时间段标在这条全轴上 ——
       半透明色块 + 两侧竖边，随滚动每帧移动。**未按下时**带按 CSS 口径不吃指针事件
       （绝不挡住块的点击与 hover），拖动入口挂在轴身上、按落点判命中（见 bandHitAt）；
       **进拖动态之后**才把带自己设成吃指针 + cursor:grabbing（拖动中光标落得到带上，
       且拖动期间不再与块抢 hover），并挂 .dragging —— 见文件头 [23]。 */
    if (fr.band) {
      const band = document.createElement("div");
      band.className = "dsh-trace-window";
      band.id = "agentTraceWindow";
      band.dataset.at = String(fr.band.at);
      band.dataset.end = String(fr.band.end);
      band.style.left = fr.band.left.toFixed(3) + "%";
      band.style.width = fr.band.width.toFixed(3) + "%";
      band.setAttribute("style", "left:" + band.style.left + ";width:" + band.style.width);
      /* 指针口径写在 setAttribute("style", …) **之后**：那一句在真 DOM 里会整份替换行内样式
         （写在前面的 pointer-events / cursor 会被它抹掉）。 */
      band.style.pointerEvents = dragOn ? "auto" : "none";
      band.style.cursor = dragOn ? "grabbing" : "";
      if (dragOn) band.classList.add("dragging");
      band.title =
        T("本视窗在这一段里的位置（滑窗带）") +
        " · " +
        fmtClock(fr.band.at) +
        "–" +
        fmtClock(fr.band.end) +
        " · " +
        T("按住拖动可平移这段窗（窗长不变，列表跟随；双击轴或 Esc 回全轴）") +
        " · " +
        T("点轴上任意时刻可把窗移过去");
      plot.appendChild(band);
    }
    rulerEl.appendChild(plot);

    /* 脚下第一行：读数 —— **本视窗**可见步数、跨度与起止时刻（窗口边界与滑窗带同源）。
       视窗内没有任何带真实时刻的调用时只报步数并点明（不编一个假跨度）。
       滚轮拉近过就在末尾挂一枚缩放读数（+ tooltip 讲清怎么拉、怎么回全轴）——
       缩放是**看得见的状态**，不许变成「用户不知道为什么轴变小了」的暗态。
       拖动中（本轮需求 [23]）在**最前面**加一段「拖动中 · 窗 起–止」：拖出来的那只窗
       （缩放态 = 平移后的缩放窗，未缩放 = 平移后的滑窗带）当场可读，松手即回到常规读数。 */
    const scale = document.createElement("span");
    scale.className = "dsh-trace-scale";
    scale.textContent =
      (dragOn && dragWin
        ? T("拖动中 · 窗 ") + fmtClock(dragWin.lo) + "–" + fmtClock(dragWin.hi) + " · "
        : "") +
      (fr.band
        ? segsInView +
          T(" 步 · 本视窗跨度 ") +
          fmtMs(fr.band.end - fr.band.at) +
          " · " +
          fmtClock(fr.band.at) +
          "–" +
          fmtClock(fr.band.end)
        : segsInView + T(" 步 · 本视窗内无工具调用")) +
      (fr.zoom > 1.001 ? " · " + T("缩放 ") + fr.zoom.toFixed(1) + "×" : "");
    if (dragOn) {
      scale.title = T("按住滑窗带拖动：窗整体平移（窗长不变），列表跟着滚到窗中点那一行；松手回到常规读数");
    } else if (fr.zoom > 1.001) {
      scale.title =
        T("横轴已横向拉近 ") +
        fr.zoom.toFixed(1) +
        T("×（在轴上滚轮可继续拉近 / 拉远，双击轴或按 Esc 回全轴）");
    }
    rulerEl.appendChild(scale);

    /* 脚下第二行：工具族图例（族色小方块 + 族名 + **整个会话**的调用次数）。
       只读、不可点（没有筛选状态就不会与「选中某一行」互相打架）；族多了自动换行。 */
    const leg = document.createElement("div");
    leg.className = "dsh-trace-legend";
    leg.id = "agentTraceLegend";
    leg.title = T("本会话各工具族的调用次数");
    for (const g of fr.legend) {
      const it = document.createElement("span");
      it.className = "dsh-trace-legend-item fam-" + g.id;
      it.dataset.fam = g.id;
      const sw = document.createElement("span");
      sw.className = "dsh-trace-legend-swatch";
      const tx = document.createElement("span");
      tx.className = "dsh-trace-legend-label";
      tx.textContent = T(g.label);
      const ct = document.createElement("span");
      ct.className = "dsh-trace-legend-count";
      ct.textContent = "×" + g.count;
      it.appendChild(sw);
      it.appendChild(tx);
      it.appendChild(ct);
      leg.appendChild(it);
    }
    rulerEl.appendChild(leg);

    /* hover 绿线（本轮需求 [25]）：绘图区刚整只重建过 —— 指针还在轴上就把那条线按
       hoverOn / hoverF 原样补回来（paintHover 只碰这一个元素，不会反过来再触发重画）。 */
    paintHover();
  }


  function render(sid) {
    if (!listEl) return;
    const segs = collectSegments(sid);
    const st = activeSession();
    lastRendered = sid;
    lastSegs = segs;
    /* 换会话 = 换内容：折叠 / 分页窗口全部归零（不把上个会话的视图状态带过来） */
    const sessionChanged = lastSessionId !== sid;
    if (sessionChanged) {
      lastSessionId = sid;
      collapsedTurns = new Set();
      winStart = 0;
      followTail = true;
      /* 换会话 = 换时间轴：轴的签名作废，下一帧按新会话重画（不沿用上一会话的几何） */
      rulerSig = "";
      /* 在拖的那一次也一起收掉（本轮需求 [23]）：旧会话的窗与列表都对不上了，拖着没意义 */
      abortDrag();
      /* hover 绿线同理：换会话 = 换轴，指针比例与时刻都对不上了（下一次 pointermove 重建） */
      hoverOn = false;
      lastDom = null;
      /* 缩放也归零（本轮需求）：上个会话拉近的那一段对不上新会话的轴域，留着就是给错帧 */
      zoomLo = null;
      zoomHi = null;
      zoomSession = "";
      /* 换会话把可视高度重新量一次：同步量不到（无布局）就先归零，
         下一帧真量到再按窗口挂 —— 免得沿用上个会话的旧视口。 */
      viewportH = 0; /* 换会话重新量 */
      hostW = 0; /* 轴宿主宽度同理（刻度分档下一帧按真宽度重算） */
      selected = -1;
    }
    /* 同上：children 是 HTMLCollection，先拷成数组再删（`children.slice()` 在真窗口里
       抛 TypeError → sync 从标签点击那条栈上冒出去，轨迹视图整块不显示）。
       清行只走 clearRows() 一处：三只常驻节点（加载行 / 占位块 / 回到底部浮标）必须显式跳过。 */
    clearRows();
    if (!segs.length) {
      rows = [];
      allRows = [];
      const empty = document.createElement("div");
      empty.className = "dsh-trace-empty";
      empty.textContent = T("这条会话还没有可看的轨迹（跑一轮之后再看）");
      listEl.appendChild(empty);
      if (spacerEl) spacerEl.style.height = "0px";
      if (loadEl) loadEl.hidden = true;
      /* 空态：吸顶轴一并收掉（没有行就没有时刻可标） */
      if (rulerEl) {
        clearRuler();
        rulerEl.hidden = true;
        rulerSig = "none";
      }
      lastDom = null;
      hoverOn = false;
      if (footEl) footEl.textContent = "";
      if (inspEl) inspEl.hidden = true;
      /* 详情栏收起 → 分隔条一并收掉（本次需求：没有详情可拖时不留一条看不见的拖动条） */
      syncInspDivider();
      updateBar();
      return;
    }
    /* 只有换会话那一次才重置已挂窗口；其余重绘保留用户往上翻到的位置，
       否则「加载更早」刚补进来的一页会被下一次重绘抹掉（点着像没反应）。 */
    rebuildRows(st, segs, sessionChanged);
    renderRows();
    if (footEl) {
      const tools = segs.filter((s) => s.k === "tool").length;
      footEl.textContent =
        segs.length +
        T(" 步 · 工具调用 ") +
        tools +
        T(" 次") +
        (winStart > 0 ? " · " + T("已加载最近 ") + mountedSegs() + T(" 步") : "");
    }
    if (followTail) scrollToTail();
  }

  /* ── 轨迹视图 = 会话主区里的「整块」视图（本次需求）────────────────────────
     轨迹视图期间，会话主体那些「属于对话视图」的件必须**一并让位**：消息区（#agentList
     或包它的 .hist-scroll-wrap 轮次轨壳）、清单面板（#agentQueue / #agentPlan / #agentTodo）、
     输入区（.agent-composer）、以及脚部的 token 报告
     （.agent-body > .tok-badge）。三件事一起做，缺一条就会被看见：
       · CSS：.agent-body.dsh-trace-on 下这些件 display:none（dsh-tokens.css 里那份规则）；
       · 标记类：dsh-trace-on 挂在 .agent-body 上（切回对话即摘，不留给下一次渲染）；
       · 行内：hidden 属性 + style.display 两处一起设 —— renderAgentSession 每次重绘都会把
         #agentList 的 style.display 抹回 ""，并在 .agent-body 末尾**重新挂一枚 token 报告**
         （app-assist.js 的 tokBadgeTailMount → app-agent.js 的 tokAgentTailHost），所以
         光靠 CSS 不够稳；重绘之后由 sync()（renderAgentSession 的收尾会调它）统一再收一次口。
     复原口径：hidden 回原值、style.display 归 ""，一个字都不留 —— 报告栏自身的折叠 / 展开
     逻辑与数据一行都不改，切回对话就是原样（含 renderAgentSession 自己的 display 写法）。 */
  function hideForTrace(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el._trcHidden === undefined) el._trcHidden = !!el.hidden;
    el.hidden = true;
    el.style.display = "none";
    return el;
  }
  function restoreForTrace(el) {
    if (!el || el.nodeType !== 1) return;
    /* 只复原**我们自己设过**的那件（_trcHidden 是「本件在轨迹视图期间被收过」的标记）：
       轨迹视图期间应用自己把清单面板 / token 报告收起或展开都不归我们管，绝不替他写回旧值。 */
    if (el._trcHidden !== undefined) el.hidden = !!el._trcHidden;
    /* 行内 display 归 ""（= 回到样式表口径）。renderAgentSession 重绘时自己写的 "" 也长这样，
       所以「切回对话后不留残留」与「不覆盖重绘」是同一件事。 */
    el.style.display = "";
    /* 标记就此清掉：下一次进轨迹视图重新按**当时**的 hidden 记一遍（否则会拿旧值覆盖）。 */
    try {
      delete el._trcHidden;
    } catch {
      el._trcHidden = undefined;
    }
  }
  /** 某个宿主容器（会话主体 / 助手栏 / 开发页右栏）名下的「对话视图」件（顺序无所谓）。
      只收**本容器自己的**直接子件 + 它自己的轮次轨壳，不做全局兜底：
      消息区 / 输入区被开发页借走时不在会话主体里，那由 applyViewChrome 按容器各收一份；
      若在这里再按 id 全局抓一次，就会把别人容器里的那一只登记进本容器的复原清单，
      一进一出把它误恢复（实测踩过：轨迹视图里 #agentList 反而被放出来）。 */
  function chatOnlyElsIn(host) {
    const out = [];
    if (!host || !host.children) return out;
    const add = (el) => {
      if (el && el.nodeType === 1 && out.indexOf(el) < 0) out.push(el);
    };
    add(host.querySelector ? host.querySelector(".hist-scroll-wrap") : null);
    for (const child of Array.from(host.children)) {
      if (!child || !child.classList) continue;
      if (child.classList.contains("dsh-trace-main")) continue;
      /* 「改动」主区（本次需求）：与轨迹主区同级 —— 它也是「本视图自己的」整块，
         绝不能被当成对话视图那几件收掉，否则切进改动栏主区自己就 hidden 了。 */
      if (child.classList.contains("dsh-chg-main")) continue;
      if (child.id === "agentViewTabs" || child.classList.contains("agent-view-tabs")) continue;
      if (
        child.id === "agentList" ||
        child.id === "agentQueue" ||
        child.id === "agentPaused" ||
        child.id === "agentPlan" ||
        child.id === "agentTodo" ||
        child.classList.contains("agent-composer") ||
        child.classList.contains("tok-badge") ||
        child.classList.contains("hist-scroll-wrap") ||
        /* 清单三件共用的类口径（#agentPaused 也挂 .agent-queue）：id 万一改名也不会漏 */
        child.classList.contains("agent-queue") ||
        child.classList.contains("agent-todo") ||
        child.classList.contains("agent-plan")
      )
        add(child);
    }
    /* 轮次轨壳里的那只消息列（.hist-scroll-wrap > .agent-list）也一并收：
       壳自己被 display:none 挡住不等于消息列让位了 —— renderAgentSession 重绘会把
       #agentList 的 style.display 抹回 ""，显式收过的这一只才不会被那一下放出来。 */
    for (const wrap of out.slice()) {
      for (const inner of Array.from(wrap.children || []))
        if (
          inner &&
          inner.classList &&
          (inner.id === "agentList" ||
            inner.classList.contains("agent-list") ||
            inner.classList.contains("agent-conv") ||
            inner.classList.contains("chat-list") ||
            inner.classList.contains("assist-list"))
        )
          add(inner);
    }
    return out;
  }
  /** 按当前视图收 / 放「对话视图」的那几件（幂等；每帧都调）。 */
  function applyViewChrome(trace) {
    const body = $(".agent-body");
    /* 宿主容器（会话主体 + 助手栏 / 开发页右栏）：标记类挂/摘 + 收/放都在这里一处做掉。
       复原走 host._trcChrome 那份**登记清单**（不是「遍历当前子节点」）——
       重绘会把节点整个换掉，遍历当前子节点就会漏掉被换下去、又被搬回来的那些。 */
    const hosts = [];
    if (body) hosts.push(body);
    for (const h of Array.from(document.querySelectorAll(".assist-pane, .apps-dev-conv")))
      if (hosts.indexOf(h) < 0) hosts.push(h);
    for (const host of hosts) {
      if (trace) {
        host.classList.add("dsh-trace-on");
        host._trcChrome = chatOnlyElsIn(host);
        for (const el of host._trcChrome) hideForTrace(el);
      } else {
        host.classList.remove("dsh-trace-on");
        /* 只复原**我们登记过**的那几件（host._trcChrome 是进轨迹视图时记下的清单）——
           不遍历当前子节点：重绘会把节点换掉，遍历就会漏掉被换下去 / 又被搬回来的那些。 */
        for (const el of host._trcChrome || []) restoreForTrace(el);
        host._trcChrome = [];
      }
    }
  }

  /** 按当前状态刷新标签、主区视图与内容（幂等；外部只要调它）。 */
  function sync() {
    const tabs = ensureTabs();
    const st = activeSession();
    const sid = activeSessionId();
    const view = st ? viewOf(st) : "chat";
    const main = ensureMain();
    const chg = ensureChangesMain();
    /* 没选中会话（或会话都没了）：标签栏收起来，两块主区都收起、回到对话 */
    if (!tabs || !st || !sid) {
      if (tabs) tabs.hidden = true;
      if (main) main.hidden = true;
      if (chg) chg.hidden = true;
      /* 没有会话也按「对话视图」复原：不留残留的 hidden / 行内 display
         （#agentList 的复原由 applyViewChrome 的复原分支一并做掉）。 */
      applyViewChrome(false);
      return;
    }
    tabs.hidden = false;
    for (const b of tabs.children) {
      const on = b.dataset.view === view;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (!main) return;
    const trace = view === "trace";
    const changes = view === "changes";
    main.hidden = !trace;
    if (chg) chg.hidden = !changes;
    /* 视图态统一收口（本次需求）：轨迹 / 改动两栏下消息区 / 清单面板 / 输入区 / token 报告
       全让位，主区吃满 .agent-body 的整块高度与宽度；切回对话原样复原（见 applyViewChrome）。 */
    applyViewChrome(trace || changes);
    /* 改动栏每次切进来都重挂一次（mount 是幂等的：换会话才重置选中态）——它跟着会话走，
       会话里的改动随时在长（正在跑的这一轮也照收），所以不做「画过就跳过」的优化。 */
    if (changes) renderChanges(sid);
    /* 轨迹视图下要跟着会话走：切会话 = 换内容（collectSegments 结果不同）。
       lastRendered 只在 render() 真的把内容画出来之后才记 —— 用它而不是用「切过视图」
       当判据：老写法（sid !== lastSid 才算换会话）在「本条会话第一次切进轨迹视图」时会
       把这一帧整个跳过，主区显形了却什么都没画（用户看到的就是「轨迹无法显示」）。 */
    if (trace && (sid !== lastRendered || !listEl.children.length)) {
      /* 先量视口再渲染：虚拟窗口要按真实可视高度裁行，量晚了这一帧会整表全挂
         （renderRows 自己量不到就不裁 —— 那条兜底是给无布局环境用的）。 */
      syncViewport();
      render(sid);
    } else if (trace) renderRows();
  }

  /* ── 「改动」主区（本次需求 · 会话改过哪些文件 + 逐笔 diff）───────────────────
     与轨迹主区**并列**的第二块主区：两块各自铺满 .agent-body 剩高，同一时刻只显一块。
     渲染整块交给 renderer/app-changes.js（它自包含，只读窗口上的 window.MTNodeChanges）：
     本文件不碰它的内部 —— 每次切进来 / 换会话时调一次 mount(sid)，它自己收、自己画。
     缺模块（老构建 / 切片冒烟）时给一句明确空态，绝不静默白屏。 */
  function ensureChangesMain() {
    if (changesEl && changesEl.isConnected) return changesEl;
    const body = $(".agent-body");
    const list = $("#agentList");
    if (!body || !list) return null;
    changesEl = document.createElement("div");
    changesEl.className = "dsh-chg-main";
    changesEl.id = "agentChangesMain";
    changesEl.hidden = true;
    body.appendChild(changesEl);
    return changesEl;
  }
  function changesApi() {
    try {
      return typeof window !== "undefined" && window.MTNodeChanges ? window.MTNodeChanges : null;
    } catch {
      return null;
    }
  }
  function renderChanges(sid) {
    const host = ensureChangesMain();
    if (!host) return;
    const api = changesApi();
    if (!api || typeof api.mount !== "function") {
      host.textContent = "";
      const e = document.createElement("div");
      e.className = "dsh-chg-empty";
      e.textContent = T("改动视图模块未加载（renderer/app-changes.js）");
      host.appendChild(e);
      return;
    }
    try {
      api.mount(host, sid);
    } catch (_) {
      host.textContent = "";
      const e = document.createElement("div");
      e.className = "dsh-chg-empty";
      e.textContent = T("改动视图渲染失败");
      host.appendChild(e);
    }
  }

  /* 出口：sync / render 是外部驱动入口（renderAgentSession 与标签点击都调 sync），
     devOn / viewOf / setView 供会话壳与冒烟用；noteUsage 给 app-assist.js 的 usage 分支
     投喂每步 token 的时间线；`_debug()` 只回内部计数与视图状态 —— 纯只读诊断，
     给 test/smoke-trajectory-view.js 核对用，不进任何 UI、不落盘。 */
  window.MTNodeTrajectory = {
    sync,
    render,
    devOn,
    viewOf,
    setView,
    noteUsage: (st, data) => pushTokLine(st, data),
    /** 每步 token 计划表（本次需求 · 明细优先）：检查器要按**选中的那一段自己的轮号**
     *  精确取明细（同一会话里第 1 轮的 step 1 与第 2 轮的 step 1 不能串台），
     *  而行模型是按组遍历（没有选中段）—— 两条路都在这里收口，不各写一套取数。
     *  返回 { byGi, giOfSeg, lastGiSeg, hasLine, tokOf(segIdx), detailInRound(round, step) }；
     *  拿不到会话返回 null。 */
    tokenPlanOf: (st, segs) => {
      if (!st) return null;
      const plan = tokenPlan(st, Array.isArray(segs) ? segs : []);
      return {
        byGi: plan.byGi,
        giOfSeg: plan.giOfSeg,
        lastGiSeg: plan.lastGiSeg,
        hasLine: plan.hasLine,
        tokOf: (segIdx) => {
          const gi = plan.giOfSeg.get(segIdx);
          return gi == null ? null : plan.byGi.get(gi) || null;
        },
        detailInRound: (round, step) => plan.detailInRound(round, step),
      };
    },
    /** 按段下标取已挂的那一行（不在已挂切片里 → null）。冒烟 / 诊断用。 */
    rowOfSeg: (segIdx) => mountedRowOf(segIdx),
    /** 按行号取已挂的那一行（行号 = 模块行模型下标，与 dataset.idx 同源）。 */
    rowAt: (idx) => mountedRowAt(idx),
    /** 横轴缩放归零（本轮需求）：与轴上双击 / Esc 同一条路 —— 冒烟用它验证「拉得回来」。
     *  在拖的那一次也一并收掉（本轮需求 [23]：归零与拖动同时发生只会互相打架）。 */
    resetZoom: () => {
      abortDrag();
      if (zoomLo == null && zoomHi == null) return false;
      zoomLo = null;
      zoomHi = null;
      rulerSig = "";
      updateRuler();
      return true;
    },
    _debug: () => {
      let mounted = -1;
      let groups = -1;
      try {
        if (listEl) {
          mounted = 0;
          groups = 0;
          /* 行挂在行流容器（占位块）里 —— 计数与 mountedRowAt / select 同一份口径 */
          for (const c of mountedEls()) {
            if (!c || !c.classList) continue;
            if (c.classList.contains("dsh-trace-row")) mounted++;
            else if (c.classList.contains("dsh-trace-group")) groups++;
          }
        }
      } catch {
        /* 迷你 DOM 缺 classList 时只回 -1 */
      }
      return {
        selected,
        lastRendered,
        segs: lastSegs.length,
        hasList: !!listEl,
        inspChildren: inspEl ? inspEl.children.length : -1,
        /* 详情栏宽度（本次需求）：当前值 / 分隔条在不在 / 正在拖 —— 纯只读诊断 */
        inspW,
        divider: !!inspDivEl,
        dividerHidden: inspDivEl ? !!inspDivEl.hidden : true,
        divDrag: !!divDrag,
        rows: rows.length,
        rowTotal: allRows.length,
        viewportH,
        allRows: allRows.length,
        mounted,
        groups,
        winStart,
        scrollTop,
        followTail,
        collapsedTurns: collapsedTurns.size,
        /* 横轴缩放态（本轮需求）：null = 全轴未缩放；有值 = 本会话轴上画的那一段时间 */
        zoomLo,
        zoomHi,
        /* 滑窗带拖动（本轮需求 [23]）：在拖 / 按下待定 / 拖出来的那只窗 —— 纯只读诊断 */
        dragOn,
        dragPend: !!dragPend,
        dragWin: dragWin ? { lo: dragWin.lo, hi: dragWin.hi } : null,
        /* 点上轴跳窗 + hover 绿线（本轮需求 [25]）：指针在不在轴里、横向比例、那一处的时刻，
           以及本帧画的时间窗 —— 都是纯只读诊断，不进任何 UI、不落盘 */
        hoverOn,
        hoverF,
        hoverT: hoverOn ? hoverTime() : 0,
        dom: lastDom ? { min: lastDom.min, max: lastDom.max } : null,
        hoverLine: !!hoverElOf(),
        /* 「改动」主区（本次需求 · 纯只读诊断）：它建出来了没 / 显不显 / 里面收了几组改动。
           冒烟靠这三项核对「切到改动栏 = 轨迹主区收起、改动主区显形」，不碰任何内部状态。 */
        hasChanges: !!changesEl,
        changesHidden: changesEl ? !!changesEl.hidden : true,
        changeGroups: changesEl ? Number(changesEl.dataset.chgGroups || 0) : -1,
        changePicked: changesEl ? String(changesEl.dataset.chgPicked || "") : "",
      };
    },
  };

  /* Esc = 放弃横轴缩放、回全轴（本轮需求 · 缩放的第二个出口，见 [22]）。
     挂在 document 上（不在轴身上）：鼠标早就不在轴上了也按得回全轴 —— 只认这一件事，
     没有任何输入待提交，故不与「对话框 persistent」那条口径冲突。
     回全轴那一帧顺带**结束在拖的那一次**（本轮需求 [23]）：一边拖一边被归零只会互相打架。 */
  if (typeof document.addEventListener === "function") {
    document.addEventListener("keydown", (ev) => {
      if (!ev || ev.key !== "Escape") return;
      abortDrag();
      if (zoomLo == null && zoomHi == null) return;
      zoomLo = null;
      zoomHi = null;
      rulerSig = "";
      updateRuler();
    });
  }
  /* 迷你 DOM（冒烟）里 document.addEventListener 是空实现：缩放的退出路径另有
     窗口出口 MTNodeTrajectory.resetZoom（轴上双击 / Esc 与它同一条路）。 */


  /* 会话重画 / 切会话 / 运行推进都会走到这里：DOMContentLoaded 后低频轮询兜底
     （主路径是 app-assist.js 的 renderAgentSession → MTNodeTrajectory.sync）。 */
  function boot() {
    setInterval(sync, 1500);
    sync();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

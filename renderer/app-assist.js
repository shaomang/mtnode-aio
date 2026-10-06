"use strict";
/* ============ 右侧全局 AI 助手 ============ */

/* 助手每轮的「当前应用状态」快照 —— 只给计数 + 选中 / 焦点。
   它是每轮都注入、且与任务无关的固定开销，所以这里连「节点索引」都不带：画布信息只有
   节点数 / 连线数 / 分组数 + selection（id/kind/title 最小描述）+ taskFocus / superFocus。
   节点列表、结构、连线与正文一律由模型按需用 mtnode_canvas_get 现拉（列表 / 结构走
   detail:"minimal" + sections，正文走 ids:[…] + detail:"full"）——「画布多大」与
   「每轮成本」由此解耦：62 个节点的索引不再随系统提示每轮重发。
   opts.canvasFree = 本轮与画布无关（Gate B）：连选中 / 焦点也不给，只剩计数与
   本画布身份。判据与 noCanvas 整档闸同源：那一档下 get / edit / app 三件套根本没注册，
   快照再发出去也没有任何工具能消费它。本次需求起这一档由**按消息自动判定**给出
   （agentSessionSend 的 turnCanvasFree / assistSend 的 assistCanvasFree），
   用户侧不再有能置它的按钮。 */
async function assistAppSnapshot(opts) {
  const canvasFree = !!(opts && opts.canvasFree);
  const sel = currentSelection().map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
  }));
  const scopeCurrent = assistScopeIsCurrent();
  const safeApp =
    "mtnode_app:status|list_workflows|rename_workflow|select_nodes|undo|redo|export_canvas_png" +
    (agentToolAllowed("app_dsh_plugins") ? "|list_dsh_plugins" : "");
  const confirmApp = [
    agentToolAllowed("app_delete") ? "mtnode_app:delete_workflow" : null,
    agentToolAllowed("app_dsh_plugins")
      ? "mtnode_app:install_dsh_plugin|remove_dsh_plugin|set_dsh_plugin"
      : null,
  ].filter(Boolean);
  /* 画布计数直接取自内存对象：不调 canvasSnapshotFull、不序列化任何节点 */
  const lwf = S.wf || {};
  const base = {
    view: S.view,
    locale: I18n.getLocale(),
    sidebarOpen: !!S.sidebarOpen && S.view !== "agent",
    assistOpen: !!S.assistOpen,
    assistScope: scopeCurrent ? "current" : "global",
    /* 明写在快照里：模型看到这一位就不会再尝试画布操作（人设也同步说了） */
    canvasFree: canvasFree,
    providers: ((S.config && S.config.providers) || []).map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      models: (p.models || []).slice(0, 12),
      vision: !!p.vision,
    })),
    dsh: {
      model: (S.config && S.config.dsh && S.config.dsh.model) || "",
      preset: (S.config && S.config.dsh && S.config.dsh.preset) || "",
      permissionPreset:
        (S.config && S.config.dsh && S.config.dsh.permissionPreset) || "",
      assistAutoApprove: !!(
        S.config &&
        S.config.dsh &&
        S.config.dsh.assistAutoApprove
      ),
      agentToolPresetId:
        (S.config && S.config.dsh && S.config.dsh.agentToolPresetId) ||
        "default",
      agentTools: agentToolPresetStatusText(),
    },
    agentSessionCount: agentSessions().length,
    tools: (() => {
      const assistAuto = !!(
        S.config &&
        S.config.dsh &&
        S.config.dsh.assistAutoApprove
      );
      const canEdit =
        agentToolAllowed("canvas_nodes") ||
        agentToolAllowed("canvas_control") ||
        agentToolAllowed("canvas_draw") ||
        agentToolAllowed("canvas_layout") ||
        agentToolAllowed("canvas_super");
      /* 与画布无关：画布 / 应用工具本轮不存在，safe / confirm 一律清空
         （留着就是让模型去撞没注册的工具）；拒绝项照实列出，口径不变。 */
      if (canvasFree)
        return {
          safe: [],
          confirm: [],
          denied: agentToolCatalog()
            .flatMap((c) => c.items)
            .filter((it) => !agentToolAllowed(it.key))
            .map((it) => it.key),
        };
      return {
        safe: [
          agentToolAllowed("canvas_read") ? "mtnode_canvas_get" : null,
          agentToolAllowed("app_ops") ? safeApp : null,
          assistAuto && canEdit
            ? "mtnode_canvas_edit（助手改画布已批准，直接生效）"
            : null,
        ].filter(Boolean),
        confirm: [
          !assistAuto && canEdit ? "mtnode_canvas_edit" : null,
          ...confirmApp,
          agentToolAllowed("vision") ? "mtnode_vision（首次许可）" : null,
        ].filter(Boolean),
        denied: agentToolCatalog()
          .flatMap((c) => c.items)
          .filter((it) => !agentToolAllowed(it.key))
          .map((it) => it.key),
      };
    })(),
  };
  /* 画布摘要：只到「有哪张图、多大」这一级 —— 节点列表一个字段都不发。
     非 canvas-free 轮额外带上选中与焦点（仍是 id 量级）；canvas-free 轮整块不给。 */
  const canvasSummary = {
    workflow: {
      id: lwf.id,
      name: lwf.name,
      nodeCount: (lwf.nodes || []).length,
      workspace: lwf.workspace || "",
    },
    nodeCount: (lwf.nodes || []).length,
    wireCount: (lwf.wires || []).length,
    groupCount: (lwf.groups || []).length,
  };
  if (canvasFree) return Object.assign(base, canvasSummary);
  return Object.assign(base, canvasSummary, {
    selection: sel,
    taskFocus:
      (typeof currentTaskFocus === "function" ? currentTaskFocus() : S.taskFocus) || "",
    superFocus:
      (typeof currentSuperFocus === "function" ? currentSuperFocus() : S.superFocus) || "",
  });
}

/* ── 「这轮任务跟画布有关吗」的唯一判据（本次开发需求：撤掉手动的「与画布无关」按钮，
      改由宿主按这轮用户消息**自动判定**；会话侧与助手侧共用本函数）─────────────
   · 命中则**不发**画布 / 应用工具说明、也不注入画布快照（app-db.js 的 MTNODE_NO_CANVAS
     整档闸每步省约 26K 字符），人设同时换成「本轮不碰画布」版 —— 否则模型会照着旧纪律
     撞不存在的工具、白烧一整步；
   · **没命中就按「有关」处理**（宁可多带一次画布工具，也不让模型撞空 —— 少发一次
     画布工具省的是 token，发错一次省的是用户的一整轮）；
   · 另外两句是保险丝，让「少发一次工具」这件事可纠正：模型自己看得出本轮不相关、
     也可请用户补一句「改画布上某个节点」再重跑，而不会去撞不存在的工具。
   hist 给最近几轮用户消息（会话侧传）：这一轮说「继续 / 改一下」而前一轮在讲画布时，
   接续轮照旧带画布工具 —— 上下文还在画布上，不该因为这一轮没复述关键词就把它抽走。 */
function agentCanvasTurnRelated(text, hist) {
  const s = String(text || "").trim();
  if (!s) return true;
  /* 用户明说与画布无关：照他说的办（此时即便句中出现「画布」也照此处理） */
  if (/与画布无关|和画布无关|跟画布无关|别(?:管|动|碰)画布|不(?:用|要|需|需要|必)(?:管|读|看|动|改|碰)?画布|canvas[\s-]?free/i.test(s))
    return false;
  const hits = (t) => {
    const x = String(t || "");
    if (!x) return false;
    /* @引用（画布内容引用语法）：写 @标题 的任务一定在图里干活 */
    if (/@[^\s@]/.test(x)) return true;
    return (
      /(画布|节点|连线|端口|端子|超级节点|开发节点|流程壳|批处理|分组|排版|工作流|提示词|智能节点|工具节点|函数节点|数据库副本|素材节点|保存节点|控制节点)/.test(x) ||
      /(workflow|canvas|\bnodes?\b|wire|port|super\s?node|layout|prompt)/i.test(x)
    );
  };
  if (hits(s)) return true;
  const back = Array.isArray(hist) ? hist.slice(-4) : [];
  for (const h of back) if (hits(h)) return true;
  /* 没命中任何画布相关词、也没声明无关 → 按「有关」处理（照常读画布，绝不误抽） */
  return true;
}

/* 会话里最近几轮**用户**消息的正文（不含助手回复）：给 agentCanvasTurnRelated 做接续判据。
   msgs 传当前消息之前的全部消息（当前这一条已进数组也没关系：本函数只看角色与正文）。 */
function agentSessionUserHistory(st, msg) {  try {
    const list = (st && st.messages) || [];
    const cur = String((msg && msg.content) || "");
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < 6; i--) {
      const m = list[i];
      if (!m || m.role !== "user") continue;
      /* 只算用户真正说过的话：浏览器求助的「已回应，模型继续中」是界面痕迹（本次需求），
         既不是用户的输入，也不该参与「这轮与画布有关吗」的判据；
         「这一轮已经结束」（轮次收尾时卡片收口的痕迹）同理 */
      if (String(m._src || "") === "ix-browser") continue;
      if (String(m._src || "") === "ix-round-end") continue;
      const c = String(m.content || "").trim();
      if (!c || c === cur) continue;
      out.push(c);
    }
    return out.reverse();
  } catch (_) {
    return [];
  }
}

/* 助手侧的同一判据：判据函数只有一份（agentCanvasTurnRelated），这里只是把「助手
   没有会话历史」这件事说清楚 —— 助手按这一条消息判，不拿画布会话的历史去补。
   （分节装配冒烟会抠这一行做夹具短路，保持单语句、不跨行。） */
function assistCanvasTurnRelated(text) {
  return agentCanvasTurnRelated(text, null);
}

/* ── 「先拷问需求（grill-me）」：会话窗口 + 右侧助手栏的模式开关（本次开发需求）──
   口径（用户拷问四轮已确认）：
     · 会话级缺省开（st.grill：没写过 = 开，点关之后这条会话记住，随会话落盘）；
       助手栏另存一个全局位（S.assistPure 同族的 S.assistGrill，随配置落盘，缺省开）。
     · 契约**按轮注入**：每轮由模型自己判「这轮像不像需求 / 开发 / 要改东西」——
       像才带契约；拿不准就不拷问、直接干活。判据写进契约，与「本轮是不是开工」
       同一处判断，不会再出现两套判据互相打脸。
     · 纯净模式开着时整段 system prompt 都置空（本就不注入）；
       自动续跑轮 / 断点续跑轮 / 开发任务书契约会话都不注入（都不该由模型自己追问自己）；
       用户手敲的斜杠命令（/plan、/compact 等）是命令不是需求，模型按契约自判不拷问。 */
/* 会话级开关态：只有用户亲口写过 false 才算关（缺省开；水合见 agentSessions）。
   这里刻意**不另抽一层函数**：本文件多处被冒烟按函数名抠进 vm 单独求值
   （如 smoke-think 抠 agentModeEntryOf），多一层未一起抠出的依赖就会当场 ReferenceError。 */
function grillTurnOn(s, opts) {
  opts = opts || {};
  return !!(
    !(s && s.grill === false) &&
    !opts.autoContinue &&
    !opts.resumeRound &&
    !opts.devContract
  );
}
/* 拷问契约正文：与开发节点任务书里那段【拷问模式】同一套纪律，只改两处差异 ——
   ① 会话 / 助手随时能改文件与画布，所以不禁「只读地查现状」，只禁「出实施计划 / 开工」；
   ② 收尾不回写任何节点字段（那不是会话的活）。 */
const GRILL_CONTRACT =
  "\n\n【拷问模式 · 先问清再动手】这条会话开着「先拷问需求」。" +
  "你每一轮先自判一次：**这一轮像不像需求 / 开发 / 改东西**（要新建或修改文件、画布、节点、配置、功能、方案）；" +
  "像就先拷问再动手，**拿不准就不拷问、直接干活**（普通的问答、查资料、解释、闲聊、继续执行上一轮已确认的事都不算需求）。\n" +
  "要拷问时：先用 skill 工具加载内置技能 mtnode-grill-me 并严格照它的纪律执行 —— " +
  "把这一轮需求映射成决策树，每轮用 ask_user_question 工具跳出 MTNode 询问窗，一次把整个前沿的全部问题问完" +
  "（题面写进 question、候选写进 options、推荐项放第一位并在 label 末尾标「（推荐）」、理由写 description）；" +
  "禁止把问题编号列在回复正文里、让用户在输入框作答；需要事实就自己用只读工具去查（读代码 / 读文件 / 联网），不要拿环境问题问用户；" +
  "到你用最后一次询问窗获得用户明确「确认无歧义」之前：**只问不做** —— 不出实施计划、不开工" +
  "（也不要拿 todo_write 任务清单替代实施计划）；确有必要时可以只读地查看现状（读文件 / 读画布）以便把问题问准。\n" +
  "用户答完就据此重算前沿、继续下一轮；他中途补充了新需求，就按新需求重新判一次、重新拷问一遍。" +
  "只有得到明确「确认无歧义」（或用户明说「别问了 / 直接做」）之后才开始实施。" +
  /* 收尾卡的写法（与询问窗的渲染口径同源见 renderer/app-db.js 的 ixSummarySplit /
     ixSummaryBlock）：题面首行 + 空行后的 Markdown 总结 → 卡片渲染成「📋 总结」区。
     不写死这段，模型会把整份共识挤在题面那一行，卡片再好也只能显示成一坨。 */
  "收尾那张确认卡按固定格式写：question 的第一行只放一句话题面（如「以上共识是否无误？」—— 卡片会把它显示成标题行），空行之后才是整份共识总结、用 Markdown 写（小标题 + 要点列表，必要时表格），卡片会把这一段渲染进「📋 总结」区；选项只留两项：推荐项 = 明确同意开工（如「确认无歧义，开始实施（推荐）」），另一个 = 还要改（如「还要改，我补充」），措辞随交流语言。不要把总结挤进题面那一行，也不要拆成几张卡。";

function summarizeCanvasEdit(params) {
  params = params || {};
  const bits = [];
  const nCreate = Array.isArray(params.create) ? params.create.length : 0;
  const nUpdate = Array.isArray(params.update) ? params.update.length : 0;
  const nConnect = Array.isArray(params.connect) ? params.connect.length : 0;
  const nDisc = Array.isArray(params.disconnect) ? params.disconnect.length : 0;
  const nRemove = Array.isArray(params.remove) ? params.remove.length : 0;
  const nSuperConnect = Array.isArray(params.superConnect)
    ? params.superConnect.length
    : 0;
  if (nCreate) bits.push(I18n.t("创建 ") + nCreate + I18n.t(" 个节点"));
  if (nUpdate) bits.push(I18n.t("更新 ") + nUpdate + I18n.t(" 个节点"));
  if (nConnect) bits.push(I18n.t("连接 ") + nConnect + I18n.t(" 条线"));
  if (nSuperConnect)
    bits.push(I18n.t("跨超级节点连接 ") + nSuperConnect + I18n.t(" 对节点"));
  if (nDisc) bits.push(I18n.t("断开 ") + nDisc + I18n.t(" 条线"));
  if (nRemove) bits.push(I18n.t("删除 ") + nRemove + I18n.t(" 个节点"));
  if (params.group) bits.push(I18n.t("创建组"));
  if (params.setWorkflowName)
    bits.push(I18n.t("重命名画布 → ") + String(params.setWorkflowName));
  if (params.layout === true || (params.layout !== false && nCreate > 0))
    bits.push(I18n.t("自动排版"));
  if (!bits.length) bits.push(I18n.t("修改画布"));
  const titles = [];
  for (const c of (params.create || []).slice(0, 8)) {
    if (c && c.title) {
      const img =
        c.imagePath ||
        (Array.isArray(c.imagePaths) && c.imagePaths.length
          ? c.imagePaths.length + I18n.t(" 张图像")
          : "");
      titles.push(String(c.title) + (img ? " ← " + String(img) : ""));
    }
  }
  for (const u of (params.update || []).slice(0, 6)) {
    if (u && u.title) titles.push(String(u.title));
  }
  return {
    summary: bits.join(" · "),
    detail:
      titles.length
        ? I18n.t("涉及：") + titles.join("、") + (titles.length >= 8 ? "…" : "")
        : "",
    raw: JSON.stringify(params, null, 2).slice(0, 4000),
  };
}

function assistRunLocked() {
  return !!(S.assistRunning || S.assistRunActive);
}

function assistWorkspaceLocked() {
  return assistRunLocked() || assistScopeIsCurrent();
}

/* ══════════ 工作区真源（运行与显示同一口径）══════════
   优先级：手填（助手 S.assistWorkspace / 会话 st.workspace）
          > 画布项目根（开发节点 devPath）
          > 画布工作目录 / 应用默认目录。
   运行按它解析，界面也按它显示：只改运行不改显示，用户会以为文件
   还落在画布目录里。 */

/* 画布工作目录（顶栏统一目录）；宿主未加载该函数时退回空（不抛错） */
function canvasWorkspaceDir() {
  try {
    return String(typeof wfWorkspace === "function" ? wfWorkspace() : "").trim();
  } catch (_) {
    return "";
  }
}

/* 画布的项目根。单一真源 = app.js 的 devProjectRootOf()（顶层开发块优先、
   devPath 就近继承、多根先归并共同祖先，归并不了才标歧义并取文档序第一个）；
   这里只把它整理成 { path, roots, ambiguous, hasDevNodes } 供运行与显示共用。
   可选 wf = 按「那张画布」解析（会话所属画布不是用户此刻看到的画布时用）：留空仍指前台。
   宿主尚未加载该函数时（独立沙箱）退回本地最小扫描，逻辑保持一致。 */
function canvasProjectRoot(wf) {
  const canvas = wf || S.wf;
  const nodes = canvas && Array.isArray(canvas.nodes) ? canvas.nodes : [];
  const isDev = (n) => !!(n && n.kind === "super" && n.dev && !n.db);
  const devs = nodes.filter(isDev);
  const empty = { path: "", roots: [], ambiguous: false, hasDevNodes: !!devs.length };
  try {
    if (typeof devProjectRootOf === "function") {
      /* 先调用再读标记：devProjectRootOf 每次刷新 S.devProjectRootAmbiguous（只刷前台） */
      const p = String(devProjectRootOf(canvas) || "").trim();
      return {
        path: p,
        roots: p ? [p] : [],
        ambiguous: canvas === S.wf ? !!S.devProjectRootAmbiguous : false,
        hasDevNodes: !!devs.length,
      };
    }
    if (!devs.length || typeof devPathOf !== "function") return empty;
    const parentOf = (n) => {
      if (!n || !n.parentSuperId) return null;
      /* 指定了画布就在该画布的节点表里找父级，否则走前台口径 */
      if (canvas && Array.isArray(canvas.nodes))
        return canvas.nodes.find((x) => x && x.id === n.parentSuperId) || null;
      return typeof nodeById === "function" ? nodeById(n.parentSuperId) : null;
    };
    /* 就近取根：给了具体画布就走同一套继承逻辑的「指定画布」版（devPathOfIn），
       宿主没提供该函数时逐字走前台口径 */
    const pathOf = (n) =>
      canvas && typeof devPathOfIn === "function"
        ? devPathOfIn(n, canvas)
        : devPathOf(n);
    /* 顶层功能块（祖先链上没有别的开发块）优先，其次任意开发块 */
    const tops = devs.filter((n) => {
      let cur = parentOf(n);
      let guard = 0;
      while (cur && guard++ < 64) {
        if (isDev(cur)) return false;
        cur = parentOf(cur);
      }
      return true;
    });
    const roots = [];
    const add = (p) => {
      const s = String(p || "").trim();
      if (s && roots.indexOf(s) < 0) roots.push(s);
    };
    for (const n of tops) add(pathOf(n));
    if (!roots.length) for (const n of devs) add(pathOf(n));
    return {
      path: roots[0] || "",
      roots,
      ambiguous: roots.length > 1,
      hasDevNodes: true,
    };
  } catch (_) {
    return empty;
  }
}

/* 生效工作区的来源标签（tooltip 用） */
function workspaceSourceLabel(src) {
  if (src === "manual") return I18n.t("手填指定");
  if (src === "project") return I18n.t("画布项目根（开发节点 devPath）");
  if (src === "canvas") return I18n.t("画布工作目录");
  if (src === "default") return I18n.t("应用默认目录");
  return I18n.t("未指定");
}

/* 一句话说清这个目录是哪儿来的；多个项目根 / 有开发块但没设项目根时给出指引 */
function workspaceInfoNote(info) {
  const src = info && info.source;
  const bits = [I18n.t("来源：") + workspaceSourceLabel(src)];
  const root = info && info.root;
  if (src === "project" && root && root.ambiguous)
    bits.push(
      I18n.t(
        "本画布有多个项目根，已用第一个；要换另一个请在顶层功能块设置 devPath，或直接手填工作目录。",
      ),
    );
  if (src !== "project" && root && root.hasDevNodes && !root.path)
    bits.push(
      I18n.t(
        "本画布有开发节点但尚未设置项目根：在顶层功能块设 devPath 后，工作目录会优先用它。",
      ),
    );
  return bits.join(" ");
}

/* 助手（右侧栏）生效工作区：手填 > 画布项目根 > 画布目录 > 默认目录。
   「仅当前画布」范围下手填无效（输入框本就只读），仍跟随画布：项目根优先。 */
function assistWorkspaceInfo() {
  const manual = String(S.assistWorkspace || "").trim();
  if (manual && !assistScopeIsCurrent())
    return { path: manual, source: "manual", root: null };
  const root = canvasProjectRoot();
  if (root.path) return { path: root.path, source: "project", root };
  const cw = canvasWorkspaceDir();
  if (cw) return { path: cw, source: "canvas", root };
  const fb = String(S.dshWorkspaceFallback || "").trim();
  if (fb) return { path: fb, source: "default", root };
  return { path: "", source: "", root };
}

function assistResolveWorkspace() {
  return String(assistWorkspaceInfo().path || "").trim();
}

function assistDisplayWorkspace() {
  if (assistRunLocked() && S.assistRunWorkspace != null)
    return String(S.assistRunWorkspace || "");
  return assistResolveWorkspace();
}

/* 会话运行 / 上文压缩的生效工作区（唯一真源）：
   st.workspace 手填优先 > 所属画布项目根 > 应用默认目录，不再各处自写 || 兜底。
   「所属画布」= 会话自己那张图（canvasWfId），不是用户此刻看到的图：会话跑着的时候用户
   切去别的画布干活，工作目录不能跟着漂。所属画布还没加载进内存时（重启后直接聊老会话）
   退回前台画布口径解析，开轮解析到画布对象后下一轮即归位。 */
function sessionCanvasWf(st) {
  const id = st && st.canvasWfId;
  if (!id || typeof canvasWfByIdLoaded !== "function") return null;
  return canvasWfByIdLoaded(id);
}

function agentWorkspaceInfo(st) {
  const manual = String((st && st.workspace) || "").trim();
  if (manual) return { path: manual, source: "manual", root: null };
  const root = canvasProjectRoot(sessionCanvasWf(st));
  if (root.path) return { path: root.path, source: "project", root };
  const fb = String(S.dshWorkspaceFallback || "").trim();
  if (fb) return { path: fb, source: "default", root };
  return { path: "", source: "", root };
}

function agentRunWorkspace(st) {
  return String(agentWorkspaceInfo(st).path || "").trim();
}

/* 展示口径的生效工作区：与 agentRunWorkspace 同一真源（看得见文件会落在哪） */
function sessionWorkspaceShown(st) {
  return agentRunWorkspace(st);
}

/* 悬浮说明整行：生效目录 + 它从哪儿来（手填 / 项目根 / 默认）+ 所属画布 */
function sessionWorkspaceTooltipLine(st) {
  const info = agentWorkspaceInfo(st);
  return (
    I18n.t("\n工作目录: ") +
    (info.path || I18n.t("（默认）")) +
    "\n" +
    workspaceInfoNote(info) +
    sessionCanvasTooltipLine(st)
  );
}

/* ── 会话 UI 上的「所属画布」（任务：用户切走画布后一眼看出这条会话改的是哪张图）──
   名字解析走 app.js 的 wfNameOfId（同步、不读盘：内存活对象 → 标签条快照 → 已删标记 →
   短 id）。没绑定（老会话，开轮时才补绑）就是空串，宁可不显示也不瞎写一张图。 */
function sessionCanvasName(st) {
  const id = st && st.canvasWfId;
  if (!id || typeof wfNameOfId !== "function") return "";
  return String(wfNameOfId(id) || "").trim();
}
function sessionCanvasTooltipLine(st) {
  const nm = sessionCanvasName(st);
  return nm ? I18n.t("\n所属画布: ") + nm : "";
}
/* 节点绑定会话的标题形如「开发 · 模块名」（细化 / 问询 / 建议同理，函数与工具开发会话也用它）。
   两种口径都认：会话契约字段（开发 / 细化 / 问询 必有）与标题前缀（建议记录会话只有标题）。
   前缀词表 SESSION_BOUND_TITLE_WORDS 按当前 UI 语言 + 中文原文 + 英文原词三份取，
   判据（sessionIsDevBoundTitle）与自动命名（sessionDevTitlePrefix）共用同一份。 */
const SESSION_BOUND_TITLE_WORDS = ["开发", "细化", "问询", "建议", "Dev", "Refine", "Ask", "Suggest"];
const sessionWordNorm = (s) =>
  String(s || "")
    .replace(/\s+/g, "")
    .toLowerCase();
function sessionIsDevBoundTitle(st) {
  if (!st) return false;
  if (st._devContract || st.devContract) return true;
  const t = String(st.title || "");
  if (t.indexOf("·") < 0) return false;
  const head = sessionWordNorm(t.split("·")[0]);
  if (!head) return false;
  for (const w of SESSION_BOUND_TITLE_WORDS) {
    if (head === sessionWordNorm(w) || head === sessionWordNorm(I18n.t(w))) return true;
  }
  return false;
}
/* 绑定会话标题的「<前缀词> · 」那一段（原样保留，含当前语言的字面）。
   侧栏 ▣ 行的取舍（sessionIsDevBoundTitle）与 /rename 的映射都靠这个形状，
   所以自动命名只替换后半的「模块名」，前缀一个字符都不动。非绑定会话返回 ""。 */
function sessionDevTitlePrefix(st) {
  const t = String((st && st.title) || "");
  if (t.indexOf("·") < 0) return "";
  const head = t.split("·")[0];
  const h = sessionWordNorm(head);
  if (!h) return "";
  for (const w of SESSION_BOUND_TITLE_WORDS) {
    if (h === sessionWordNorm(w) || h === sessionWordNorm(I18n.t(w)))
      return head.trim() + " · ";
  }
  return "";
}

/* 自动短标题的清洗：引擎给的是 LLM 生成的一小段文本，可能带换行 / 引号 / 句号，
   侧栏一行放不下也不能带控制字符。返回 ""=放弃这次命名。 */
const SESSION_AUTO_TITLE_MAX = 24;
function autoSessionTitleOf(raw) {
  let s = String(raw == null ? "" : raw)
    /* 控制字符（含换行 / 制表）压成空格，整条收成单行 */
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  /* 去首尾成对包裹符与尾部句读（模型爱写「标题。」或 "标题"） */
  s = s
    .replace(/^[“”"'‘’「『《【〈]+/, "")
    .replace(/[”"'’」』》】〉]+$/, "")
    .replace(/[。．.、，,；;：:\s]+$/, "")
    .trim();
  if (!s) return "";
  /* 按码点截断（emoji / 代理对算一个可见字符），超出补省略号 */
  const chars = Array.from(s);
  if (chars.length > SESSION_AUTO_TITLE_MAX)
    s = chars.slice(0, SESSION_AUTO_TITLE_MAX).join("") + "…";
  return s;
}
/* 消费引擎的 session-title 事件（网关 → {type:"title",data:{title,source}}）：
   会话执行任务时，把左侧栏那条标题换成这一轮内容的主题。
   三道闸：· 一次性武装（st._autoTitleRound，发送时按 titleAuto/titleLocked 置一次）
             —— 只要还没真正命名过一次就保持放行，round-1 迟到的 title
              （含刚过 done、下一轮发送前到达的）与后续轮的首个主题都能落地；
           · 用户手改过的标题永不被覆盖（st.titleLocked，在飞事件迟到也一样）；
           · 清洗后为空 → 保留原回落（首条消息前 24 字）。
   按来源分流：provider/user 命中写 st.title / st.titleAuto 并关闭武装位（provider 锁最终主题、
   user 视同 titleLocked 永不让位）；fallback／缺省仅占位不锁位；同值直接返回（幂等，不重绘不落盘）。 */
function applyAutoSessionTitle(st, raw, srcKind) {
  if (!st || st.titleLocked || !st._autoTitleRound) return false;
  const theme = autoSessionTitleOf(raw);
  if (!theme) return false;
  const next = sessionDevTitlePrefix(st) + theme;
  if (next === st.title) return false;
  if (srcKind === "provider" || srcKind === "user") {
    /* 引擎 LLM 真实主题(provider) / 用户改名(user)：最终定名，上锁并关闭武装位 */
    st.title = next;
    st.titleAuto = true;
    st._autoTitleRound = false;
    if (srcKind === "user") st.titleLocked = true;
  } else {
    /* 引擎 5 词回落(fallback) / 缺省：仅占位，仅当当前无标题时写一次，决不锁位 */
    if (st.title) return false;
    st.title = next;
  }
  try {
    if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
  } catch (_) {}
  try {
    if (typeof persistAgentSession === "function")
      Promise.resolve(persistAgentSession()).catch(() => {});
  } catch (_) {}
  return true;
}

/* ============ 绑定会话的「主题」标题 ============
   开发 / 细化绑定会话创建时标题固定是「开发 · 模块名」。产品承诺「跑起来后标题随
   这一轮的主题更新」，靠的是引擎的 session-title LLM：它只把**首条用户消息**喂给
   辅助模型，而 dsh/gateway/cordis.yml 里 maxInputBytes=4096 是硬闸 —— MTNode 的首条
   用户消息却是「【系统设定】+ 整份人设 / 任务书 + 【内容】」，动辄十几 KB，一律超限。
   provider 抛错后只剩引擎 5 词回落（fallback），渲染层又只在标题为空时才接受回落
   （见 applyAutoSessionTitle）—— 于是标题永远停在「开发 · 模块名」。
   这里按首条关键输入（本次开发需求 / 细化范围）自己补一个主题，口径与普通会话的
   24 字回落一致；刻意**不置 titleAuto** —— 引擎主题若真到达，仍可覆盖它。 */
const SESSION_TOPIC_MAX = 24;
function sessionTopicOfText(raw) {
  let s = String(raw == null ? "" : raw)
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  /* 旧形态绑定会话的首条消息是整份任务书（新版才只放用户关键输入）：
     把「【开发任务书】…」截成标题毫无意义，直接放弃这次改名 */
  if (s.indexOf(I18n.t("【开发任务书】")) === 0 || s.indexOf("【开发任务书】") === 0) return "";
  const heads = [
    I18n.t("本次开发需求："),
    "本次开发需求：",
    I18n.t("用户指定的细化范围："),
    "用户指定的细化范围：",
  ];
  for (const p of heads)
    if (p && s.indexOf(p) === 0) {
      s = s.slice(p.length).trim();
      break;
    }
  /* 「细化该功能块」只是动作、没有主题信息：宁可保留模块名，也不改成一个废话标题 */
  if (!s || s === I18n.t("细化该功能块")) return "";
  return s.slice(0, SESSION_TOPIC_MAX) + (s.length > SESSION_TOPIC_MAX ? "…" : "");
}
/* 绑定会话的主题候选：先看首条 dev-node 消息（新版只放用户关键输入），
   看不出信息（如细化会话的「细化该功能块」）再看任务书契约里的细化范围行。
   两处都取不到 = 返回 ""，调用方保持模块名不动。 */
function sessionTopicOfBoundSession(st) {
  const msgs = Array.isArray(st && st.messages) ? st.messages : [];
  const first = msgs.find((m) => m && m.role === "user" && m._src === "dev-node");
  const fromMsg = sessionTopicOfText(first && first.content);
  if (fromMsg) return fromMsg;
  const contract = String((st && st._devContract) || "");
  for (const p of [I18n.t("用户指定的细化范围："), "用户指定的细化范围："]) {
    const at = contract.indexOf(p);
    if (at < 0) continue;
    const topic = sessionTopicOfText(contract.slice(at + p.length).split("\n")[0]);
    if (topic) return topic;
  }
  return "";
}
/* 把绑定会话的标题换成「<前缀> · <主题>」：只动「开发 · 」后面那段，前缀原样保留。
   用户手改过（titleLocked）或引擎已定名（titleAuto）的会话一律不碰。
   返回是否改了标题。 */
function retitleBoundSessionByTopic(st) {
  if (!st || st.titleLocked || st.titleAuto) return false;
  const prefix = sessionDevTitlePrefix(st);
  if (!prefix) return false;
  const topic = sessionTopicOfBoundSession(st);
  if (!topic) return false;
  const next = prefix + topic;
  if (next === st.title) return false;
  st.title = next;
  return true;
}

/* 助手工作目录输入框的「只读守卫」句柄（app-db.js 的 workspaceReadOnlyGuard）：
   只建一次，绑定在 #assistWsInput 上，之后由 syncAssistWorkspaceChrome 按锁定状态开关。 */
let assistWsGuard = null;

function syncAssistWorkspaceChrome() {
  const ws = $("#assistWsInput");
  const br = $("#assistWsBrowse");
  const locked = assistWorkspaceLocked();
  const runLock = assistRunLocked();
  const shown = assistDisplayWorkspace();
  /* 来源说明只认「当前解析出的生效工作区」：运行中显示的是开轮时锁定的目录，
     两者不一致时不硬套来源（宁可不说，也不说错） */
  const live = assistWorkspaceInfo();
  const note =
    shown === live.path ? workspaceInfoNote(live) : I18n.t("来源：本轮开轮时锁定");
  const withNote = (text) => (note ? text + "\n" + note : text);
  if (ws) {
    if (document.activeElement !== ws || locked) ws.value = shown;
    /* 助手工作目录也是**只读输入**（同顶栏画布目录）：一律走右侧文件夹选择器，
       手打错目录同样只在很深的读写步骤才报错。
       守卫建出来就是只读并一直保持；locked（运行中 / 锁定）与「仅当前画布」两种情况下
       连 Ctrl+V 粘贴也不给，只能跟随画布口径。 */
    if (!assistWsGuard) assistWsGuard = workspaceReadOnlyGuard(ws);
    assistWsGuard.lockKeys(locked || assistScopeIsCurrent());
    assistWsGuard.hint(I18n.t("双击直选文件夹，Ctrl+V 粘贴路径"));
    ws.placeholder = assistScopeIsCurrent()
      ? I18n.t("跟随当前画布：项目根优先，其次画布工作目录")
      : I18n.t("留空 = 画布项目根 / 画布工作目录…");
    if (runLock)
      ws.title = withNote(I18n.t("运行中已锁定工作目录，切换画布也不会更改"));
    else if (assistScopeIsCurrent())
      ws.title = withNote(I18n.t("跟随当前画布（项目根优先，只读）"));
    else
      ws.title = withNote(
        I18n.t("助手可读写此目录下的文件；留空则用画布项目根 / 画布工作目录"),
      );
  }
  if (br) {
    br.disabled = locked;
    br.hidden = locked;
    /* 句柄可能还没建（本函数在 ws 分支之前就被调用、或 #assistWsInput 不在场）：
       没守卫时不去碰它，避免 undefined.browse */
    if (assistWsGuard) assistWsGuard.browse(() => br.click());
  }
}

function persistAssistUi() {
  if (!S.config) return;
  S.config.assistOpen = !!S.assistOpen;
  S.config.assistLive2d = !!S.assistLive2d;
  S.config.assistPreset = S.assistPreset || AGENT_PRESET_DEFAULT;
  S.config.assistProvider = S.assistProvider || "deepseek-official";
  S.config.assistModel = S.assistModel || "";
  S.config.assistEffort = S.assistEffort || "high";
  S.config.assistWorkspace = S.assistWorkspace || "";
  S.config.assistScope =
    S.assistScope === "global" ? "global" : "current";
  /* 与画布无关（Gate B · 助手侧）：全局偏好，与 assistScope 同级落盘 */
  S.config.assistCanvasFree = !!S.assistCanvasFree;
  /* 助手栏「模式」菜单的两枚开关（本次需求）：助手没有会话档案，偏好只能落在全局
     配置上（与会话级 st.grill / st.pure 各存各的）。两者都**缺省开 / 关**：
     assistGrill 缺省开（没写过 = true），assistPure 缺省关。 */
  S.config.assistGrill = S.assistGrill !== false;
  S.config.assistPure = !!S.assistPure;
  S.config.assistW = clampAssistW(S.assistW || 320);
  S.config.assistMessages = (S.assistMessages || []).slice(-80).map((m) => {
    const o = {
      role: m.role,
      content: String(m.content || "").slice(0, 8000),
    };
    const at = Number(m.at || m.createdAt || m.ts) || 0;
    if (at > 0) o.at = at;
    if (m.reasoning) o.reasoning = String(m.reasoning).slice(0, 12000);
    if (Array.isArray(m.tools) && m.tools.length) {
      o.tools = m.tools.slice(0, 40).map((t) => ({
        callId: t.callId,
        turn: t.turn,
        step: t.step,
        name: t.name,
        args: String(t.args || "").slice(0, 4000),
        result: Array.isArray(t.result)
          ? t.result.slice(0, 8).map((b) =>
              b && typeof b === "object"
                ? {
                    type: b.type,
                    text: String(b.text || "").slice(0, 4000),
                  }
                : b,
            )
          : null,
        error: t.error || null,
        at: t.at,
      }));
    }
    return o;
  });
  window.api.configSave(S.config).catch(() => {});
}

const ASSIST_W_MIN = 320;

function clampAssistW(w) {
  const half = Math.max(ASSIST_W_MIN, Math.floor((window.innerWidth || 1200) / 2));
  const n = Math.round(Number(w) || ASSIST_W_MIN);
  return Math.max(ASSIST_W_MIN, Math.min(half, n));
}

function applyAssistWidth(w, persist) {
  S.assistW = clampAssistW(w == null ? S.assistW : w);
  const pane = $("#assistPane");
  if (pane) pane.style.setProperty("--assist-w", S.assistW + "px");
  if (persist !== false && S.config) {
    S.config.assistW = S.assistW;
    window.api.configSave(S.config).catch(() => {});
  }
}

/* 分栏之间的竖分界线（.agent-side-resize / .assist-resize / .ba-resize，样式见 css 对应文件）：
   ① 整条边界都可拖 —— 命中区由 CSS 铺满栏高（top/bottom 0），不是中间那一小段；
   ② 指针移出这条细线 / 移出窗口才松手也断不了线 —— 按下即 setPointerCapture；
   ③ 收尾统一走 finish()，pointerup / pointercancel / 捕获丢失三路都回到干净态（光标、选中、
   监听与 .dragging 一起撤），拖动中只改 CSS 变量 / 样式，松手才落盘一次。 */
function bindSideDividerDrag(opts) {
  const handle = $("#" + opts.id);
  if (!handle || handle._bound) return null;
  handle._bound = true;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  let dragging = false;
  let startX = 0;
  let startW = 0;
  let pid = null;
  const onMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    /* 起始值与增量分开算（startW + dx）：夹取到边界后仍能原路拖回，
       不会因为「上次被夹住」把后续增量吃掉（体感「拖不动了」）。 */
    opts.apply(startW + (startX - (Number(ev.clientX) || 0)) * opts.sign, false);
  };
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    try {
      if (pid != null && handle.hasPointerCapture && handle.hasPointerCapture(pid))
        handle.releasePointerCapture(pid);
    } catch (_) {}
    pid = null;
    opts.apply(opts.current(), true); /* 松手才落盘一次 */
  };
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    startX = Number(ev.clientX) || 0;
    startW = opts.current();
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    try {
      pid = ev.pointerId;
      handle.setPointerCapture(pid);
    } catch (_) {}
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
  return handle;
}

function bindAssistResize() {
  const handle = bindSideDividerDrag({
    id: "assistResize",
    /* 向左拖 = 变宽 */
    sign: 1,
    current: () => S.assistW || ASSIST_W_MIN,
    apply: (w, persist) => applyAssistWidth(w, persist),
  });
  if (!handle) return;
  window.addEventListener("resize", () => {
    if (S.assistOpen) applyAssistWidth(S.assistW, false);
  });
}

/* ============ 会话左栏（会话列表）宽度：默认最小，可拖拽加宽 ============ */
const AGENT_SIDE_W_MIN = 280;

function clampAgentSideW(w) {
  const half = Math.max(
    AGENT_SIDE_W_MIN,
    Math.floor((window.innerWidth || 1200) / 2),
  );
  const n = Math.round(Number(w) || AGENT_SIDE_W_MIN);
  return Math.max(AGENT_SIDE_W_MIN, Math.min(half, n));
}

function applyAgentSideWidth(w, persist) {
  S.agentSideW = clampAgentSideW(w == null ? S.agentSideW : w);
  const pane = $("#agentPane");
  if (pane) pane.style.setProperty("--agent-side-w", S.agentSideW + "px");
  if (persist !== false && S.config) {
    S.config.agentSideW = S.agentSideW;
    window.api.configSave(S.config).catch(() => {});
  }
  /* 拖这条分界线时会话列是**居中**的：列的位置会跟着变（宽度不变），
     轮次竖条要跟着重新贴回滚动条，否则拖动过程中会与滚动条错开一段。 */
  const list = $("#agentList");
  if (list) {
    try {
      updateHistRail(list);
    } catch (_) {}
  }
}

function bindAgentSideResize() {
  const handle = bindSideDividerDrag({
    id: "agentSideResize",
    /* 向右拖 = 变宽 */
    sign: -1,
    current: () => S.agentSideW || AGENT_SIDE_W_MIN,
    apply: (w, persist) => applyAgentSideWidth(w, persist),
  });
  if (!handle) return;
  /* 双击分界线 = 回到默认（最小）宽度 */
  handle.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    applyAgentSideWidth(AGENT_SIDE_W_MIN, true);
  });
  /* 窗口变窄时重新夹取，避免左栏挤掉会话内容 */
  window.addEventListener("resize", () =>
    applyAgentSideWidth(S.agentSideW, false),
  );
}

/* ============ 会话窗滚轮兜底：主会话列两边的空白也能上下滚动会话 ============
 * 会话列 .agent-list 与输入区 .agent-composer 都是「居中定宽」（max-width:820px + margin auto），
 * 窗口一宽，两侧就各剩一条不属于任何滚动容器的空白；滚轮落在那里，浏览器从目标往上找不到
 * 一个可滚的祖先 → 画面纹丝不动（用户体感：会话滚不动，非得把鼠标挪进正文那一窄条）。
 * 这里在 .agent-main 上兜一层：wheel 冒泡到容器时，若「从事件目标到容器」整条祖先链上没有任何
 * 元素能沿该方向继续滚，就把这次位移补给会话列。
 * 三条边界：
 *   ① 内层真能滚的一律交回原生（消息里的代码块 / 思考折叠、计划清单 .at-list、发送队列、
 *      会话左栏列表、输入框……），既不双速也不抢滚动条；
 *   ② 会话列在该方向已经到头就不吞事件（惯性 / 连刷时不至于卡死在半路）；
 *   ③ 跟随底部（_convStick）与列表内滚轮同口径：上翻立刻脱离跟随，滚回底部恢复跟随。 */
const AGENT_WHEEL_LINE_PX = 20; /* deltaMode=lines：一行按 20px 折算 */
const AGENT_WHEEL_MAX_PX = 400; /* 单次位移上限：高刷滚轮 / 触控板一次别跳半屏 */
/* 这些控件上的滚轮有自己的语义（改文本、翻下拉、展开菜单），一律不去接管 */
const AGENT_WHEEL_KEEP_SELECTOR =
  "input, textarea, select, [contenteditable], .agent-menu";

function agentElCanScrollDir(el, dy) {
  if (!el || el.nodeType !== 1 || !dy) return false;
  const max = Number(el.scrollHeight || 0) - Number(el.clientHeight || 0);
  if (!(max > 0)) return false;
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  if (cs) {
    const oy = String(cs.overflowY || "");
    const ox = String(cs.overflowX || "");
    const scrollable =
      oy === "auto" ||
      oy === "scroll" ||
      oy === "overlay" ||
      /* 只写 overflow-x 时 overflow-y 的「计算值」仍是 visible，但实际会被当作 auto 滚动 */
      (oy === "visible" &&
        (ox === "auto" || ox === "scroll" || ox === "overlay"));
    if (!scrollable) return false;
  }
  const top = Number(el.scrollTop) || 0;
  return dy < 0 ? top > 0 : top < max - 1;
}

/* 祖先链上第一个能自己消化这次滚轮的容器（走到 host 为止，host 之外不算） */
function agentWheelNativeOwner(el, host, list, dy) {
  for (let n = el; n && n !== host; n = n.parentElement) {
    if (!n || n.nodeType !== 1) continue;
    /* 落在会话列自己身上（正文、气泡、列表内边距）：原生就会滚它，别再叠一次位移 */
    if (n === list) return n;
    if (agentElCanScrollDir(n, dy)) return n;
  }
  return null;
}

function agentWheelPixels(ev, list) {
  const dy = Number(ev && ev.deltaY) || 0;
  if (!dy) return 0;
  const mode = Number(ev.deltaMode) || 0; /* 0=px 1=lines 2=pages */
  let px = dy;
  if (mode === 1) px = dy * AGENT_WHEEL_LINE_PX;
  else if (mode === 2)
    px = dy * Math.max(80, Number(list && list.clientHeight) || 200);
  return Math.max(-AGENT_WHEEL_MAX_PX, Math.min(AGENT_WHEEL_MAX_PX, px));
}

function bindAgentPaneWheelScroll() {
  const pane = $("#agentPane");
  const host = (pane && pane.querySelector(".agent-main")) || pane;
  if (!host || host._agentWheelBound) return;
  host._agentWheelBound = true;
  host.addEventListener(
    "wheel",
    (ev) => {
      if (!ev || ev.defaultPrevented) return;
      /* 缩放（Ctrl+滚轮）与带修饰键的组合键不动 */
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const dy = Number(ev.deltaY) || 0;
      if (!dy) return;
      const t = ev.target;
      if (!t || t.nodeType !== 1) return;
      if (typeof t.closest === "function" && t.closest(AGENT_WHEEL_KEEP_SELECTOR))
        return;
      const list = $("#agentList");
      if (!list || (list.style && list.style.display === "none")) return;
      if (agentWheelNativeOwner(t, host, list, dy)) return; /* ① 交回原生 */
      if (!agentElCanScrollDir(list, dy)) return; /* ② 到头就别吞事件 */
      const px = agentWheelPixels(ev, list);
      if (!px) return;
      ev.preventDefault();
      if (typeof bindConvStick === "function") bindConvStick(list);
      const before = Number(list.scrollTop) || 0;
      const prevStick = convStickOf(list);
      if (px < 0) markConvStick(list, false);
      setConvScrollTop(list, before + px);
      if (px > 0) {
        if (isScrollNearBottom(list, CONV_STICK_SLACK)) markConvStick(list, true);
      } else if (typeof requestAnimationFrame === "function") {
        /* 与列表内滚轮同款兜底：这一帧其实没动，就不改用户原本的跟随意图 */
        requestAnimationFrame(() => {
          if ((Number(list.scrollTop) || 0) === before)
            markConvStick(list, prevStick);
        });
      }
    },
    { passive: false },
  );
}

function setAssistOpen(on, persist) {
  S.assistOpen = !!on;
  const layout = $("#layout");
  if (layout) layout.classList.toggle("assist-open", S.assistOpen);
  if (S.assistOpen) applyAssistWidth(S.assistW, false);
  if (persist !== false) persistAssistUi();
  if (S.assistOpen) renderAssistPanel();
}

function setAssistLive2d(on, persist) {
  S.assistLive2d = !!on;
  const layout = $("#layout");
  if (layout) layout.classList.toggle("assist-live2d-on", S.assistLive2d);
  const box = $("#assistLive2d");
  if (box) box.hidden = !S.assistLive2d;
  if (persist !== false) persistAssistUi();
}

function toggleAssist() {
  setAssistOpen(!S.assistOpen);
}

function toggleAssistLive2d() {
  setAssistLive2d(!S.assistLive2d);
}

/* 全局助手：供应商 / 模型下拉（与智能会话同款数据源） */
function fillAssistModelControls() {
  const provSel = $("#assistProvSel");
  const modelSel = $("#assistModelSel");
  if (!provSel || !modelSel) return;
  const addOpt = (sel, value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  /* 每次从当前配置读取，避免首次绑定时的空目录快照。
     dshProvider() 的 models 已过白 / 黑名单；停用的服务商由 dshProvider / mtnodePiProviders
     过滤掉，因此这里不会出现任何停用服务商。 */
  const modelsFor = (prov) => {
    const catalog = S.providerCatalog || {
      deepseek: [
        { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", input: ["text", "image"] },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
      ],
      piai: [],
    };
    if (prov === "deepseek-official") {
      const dpNow = dshProvider();
      if (dpNow && Array.isArray(dpNow.models) && dpNow.models.length)
        return dpNow.models.map((m) => ({ id: String(m), name: "" }));
      return (catalog.deepseek || []).map((m) => ({ id: m.id, name: m.name }));
    }
    const mp = mtnodePiProviders().find((x) => "mtnode_" + x.route === prov);
    return ((mp && mp.models) || []).map((id) => ({ id, name: "" }));
  };
  const fillModels = (prov) => {
    const items = modelsFor(prov);
    let cur = S.assistModel || "";
    if (!cur || !items.some((x) => x.id === cur))
      cur = (items[0] && items[0].id) || "";
    modelSel.innerHTML = "";
    if (!items.length) {
      addOpt(modelSel, "", I18n.t("（无可用模型）"));
      modelSel.value = "";
      S.assistModel = "";
      return;
    }
    const vis = new Set(visionModelsForProvider(prov).map((m) => m.id));
    for (const m of items) addOpt(modelSel, m.id, modelLabel(m, vis));
    modelSel.value = cur;
    S.assistModel = cur;
  };
  const mtnode = mtnodePiProviders();
  const dp = dshProvider();
  let curProv = S.assistProvider || "deepseek-official";
  provSel.innerHTML = "";
  /* 官方路由对应的 DeepSeek 服务商被停用时，这条整体不列（与节点设置 / 会话菜单同口径） */
  const dsOk =
    typeof deepseekRouteSelectable === "function"
      ? deepseekRouteSelectable(S.config)
      : true;
  if (dsOk)
    addOpt(provSel, "deepseek-official", (dp && dp.name) || I18n.t("DeepSeek 官方"));
  for (const p of mtnode) addOpt(provSel, "mtnode_" + p.route, p.name);
  if (![...provSel.options].some((o) => o.value === curProv)) {
    curProv = preferredAgentProviderRoute();
  }
  provSel.value = curProv;
  fillModels(curProv);
  provSel.onchange = () => {
    S.assistProvider = provSel.value;
    S.assistModel = "";
    fillModels(provSel.value);
    persistAssistUi();
  };
  modelSel.onchange = () => {
    S.assistModel = modelSel.value;
    persistAssistUi();
  };
}

function fillAssistScopeControl() {
  const sel = $("#assistScopeSel");
  if (!sel) return;
  const curName =
    (S.wf && String(S.wf.name || "").trim()) || I18n.t("未命名画布");
  const v = S.assistScope === "global" ? "global" : "current";
  sel.innerHTML = "";
  const optCur = document.createElement("option");
  optCur.value = "current";
  optCur.textContent = I18n.t("当前画布") + " · " + curName;
  const optG = document.createElement("option");
  optG.value = "global";
  optG.textContent = I18n.t("全局");
  sel.appendChild(optCur);
  sel.appendChild(optG);
  sel.value = v;
  sel.disabled = !!S.assistRunning;
}

function updateAssistScopeChrome() {
  const scopeCurrent = assistScopeIsCurrent();
  /* 「先拷问需求」状态回显（本次需求）：助手栏头部那行小字里带上它 ——
     用户不再需要展开模式菜单才知道这一轮会不会被追问。 */
  const grill = S.assistGrill !== false;
  assistGrillTagPaint(grill);
  const sub = document.querySelector("#assistPane .assist-sub");
  if (sub) {
    const scope = scopeCurrent
      ? I18n.t("仅当前画布")
      : I18n.t("可见全局状态");
    sub.textContent = grill
      ? I18n.t("拷问需求") + " · " + scope
      : scope;
  }
  paintAssistModeChip();
}
/* 助手栏头部的「拷问需求」小字标记（本次需求）：开 = 显示，关 = 收起。
   与会话侧头部那一枚同一份词条、同一处观感。 */
function assistGrillTagPaint(on) {
  const el = document.getElementById("assistGrillTag");
  if (!el) return;
  el.hidden = !on;
  el.textContent = I18n.t("拷问需求");
  el.title = I18n.t("先拷问需求：开启中 —— 像需求 / 开发的那几轮会先用询问窗问清再动手");
}

/* 助手侧「与画布无关」按钮已随本次需求移除（改为按消息自动判定，见 agentCanvasTurnRelated）：
   原来这里那个 updateAssistCanvasFreeChrome()（回显按钮开启态 + tooltip）一并删掉。
   S.assistCanvasFree / S.config.assistCanvasFree 仍按旧位落盘 —— 老存档读回来不报错，
   但本轮起不再读它（运行时的判据只有一条：这轮消息跟画布有没有关）。 */

/* 助手栏「预设」下拉的档位清单：吃 app.js 的 AGENT_PRESETS 真源（**表序 = 菜单序，
   第一档就是默认档**），不再由 index.html 写死一份漏档的旧名单（旧清单只有 4 项、
   叫「通用助手 / 精简执行 / 代码专家 / Cordis 插件开发」，既没有思维精简，档位名也
   与别三处不一致）。按「语言 + 档位序列」做指纹：切语言或档位表变动才重建。 */
function syncAssistPresetOptions(sel) {
  if (!sel || typeof document === "undefined" || !document.createElement) return;
  if (
    typeof AGENT_PRESETS === "undefined" ||
    !Array.isArray(AGENT_PRESETS) ||
    !AGENT_PRESETS.length
  )
    return;
  const loc = I18n && I18n.getLocale ? I18n.getLocale() : "";
  const sig = loc + "|" + AGENT_PRESETS.map((p) => p.id).join(",");
  if (sel.dataset && sel.dataset.presetSig === sig && sel.options && sel.options.length)
    return;
  const keep = sel.value;
  sel.textContent = "";
  for (const p of AGENT_PRESETS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = I18n.t(p.labelKey);
    if (p.hint) o.title = I18n.t(p.hint);
    sel.appendChild(o);
  }
  if (sel.dataset) sel.dataset.presetSig = sig;
  /* 原来选中的档还在表里就留着（重建后 value 会被清掉，且 minimal 如今是第一档） */
  if (keep && sel.options && sel.options.length) {
    for (const o of sel.options) if (o.value === keep) { sel.value = keep; break; }
  }
}

function renderAssistPanel(opts) {
  const list = $("#assistList");
  if (!list) return;
  const stickCap = captureConvStick(list, opts && opts.forceStick);
  list.innerHTML = "";
  const msgs = S.assistMessages || [];
  const scopeCurrent = assistScopeIsCurrent();
  if (!msgs.length && !S.assistRunning) {
    const empty = document.createElement("div");
    empty.className = "assist-empty";
    empty.textContent = scopeCurrent
      ? I18n.t(
          "当前工作范围是本画布。我能查看并修改当前画布节点与配置。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图前会请你确认；要参考其他画布请把工作范围改为「全局」。\n（与画布无关的任务我会自动省掉画布工具，不占 token。）",
        )
      : I18n.t(
          "我能看到当前画布、节点与配置，也可参考其他画布列表。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图或删除画布前会请你确认。",
        );
    list.appendChild(empty);
  }
  /* 消息逐条渲染（用户消息下方的「↶ 回滚」入口已随会话轮次回滚功能一并移除） */
  for (let i = 0; i < msgs.length; i++) {
    try {
      list.appendChild(dshMsgBlock(msgs[i], "assist", i));
    } catch (e) {
      /* 单条消息坏数据不拖垮整表：跳过并留痕，避免列表停在旧消息处、新消息永远不出现 */
      try {
        console.error("assist 消息渲染失败: idx=" + i, e);
      } catch (_) {}
    }
  }
  if (S.assistRunning) {
    const row = document.createElement("div");
    row.className = "dsh-msg dsh-ai";
    const head = document.createElement("div");
    head.className = "dsh-msg-head";
    const role = document.createElement("span");
    role.className = "dsh-role live";
    role.textContent = I18n.t("AI · 运行中");
    head.appendChild(role);
    row.appendChild(head);
    const think = document.createElement("div");
    think.className = "dsh-think-live";
    think.id = "assist-think";
    think.textContent = traceThinkDisplay(
      "assist",
      (S.thinking && S.thinking.assist && S.thinking.assist[0]) || "",
    );
    row.appendChild(think);
    const tools = document.createElement("div");
    tools.className = "dsh-tools";
    tools.id = "assist-tools";
    for (const t of S.assistLiveTools || [])
      tools.appendChild(dshToolDetailsEl(t, true, "assist"));
    row.appendChild(tools);
    const body = document.createElement("div");
    body.className = "dsh-msg-body dsh-stream";
    body.id = "assist-stream";
    body.textContent = traceSayDisplay("assist", S.assistPending);
    row.appendChild(body);
    list.appendChild(row);
  }
  /* 助手栏最底部（输入行下面）：同一份 Token 累计报告 Badge（按模型累计，点击展开） */
  if (typeof tokBadgeTailMount === "function" && typeof assistTokOwner === "function") {
    try {
      tokBadgeTailMount(assistTokOwner(), list);
    } catch {}
  }
  const reapplyStick = () => restoreConvStick(list, stickCap);
  scheduleHistoryCollapse(list, reapplyStick);
  const sendBtn = $("#assistSend");
  if (sendBtn) {
    if (S.assistRunning) {
      sendBtn.textContent = I18n.t("■ 终止");
      sendBtn.classList.add("danger");
    } else {
      sendBtn.textContent = I18n.t("发送");
      sendBtn.classList.remove("danger");
    }
  }
  const presetSel = $("#assistPresetSel");
  syncAssistPresetOptions(presetSel);
  if (presetSel && document.activeElement !== presetSel)
    presetSel.value = S.assistPreset || AGENT_PRESET_DEFAULT;
  const effortSel = $("#assistEffortSel");
  if (effortSel && document.activeElement !== effortSel) {
    /* 白名单回显：词汇表内档位原样保留（不重置已存档位），未露出 UI 的档位仅显示回落档 */
    const cur = normalizeAgentEffort(S.assistEffort);
    effortSel.value = AGENT_EFFORT_UI_ORDER.includes(cur) ? cur : "high";
    if (S.assistEffort !== cur) S.assistEffort = cur;
  }
  syncAssistWorkspaceChrome();
  fillAssistScopeControl();
  updateAssistScopeChrome();
  fillAssistModelControls();
  restoreConvStick(list, stickCap);
  if (typeof requestAnimationFrame === "function") {
    /* 折叠等事后高度变化：再按锚点还原一次（贴底滚到底，未贴底保持原位） */
    requestAnimationFrame(() => restoreConvStick(list, stickCap));
  }
  /* 助手输入框上方的内嵌图胶囊条（本文件末段；幂等，每轮只做签名比对） */
  try {
    chatInlineImgTick();
  } catch (_) {}
}

function clearAssistChat() {
  if (S.assistRunning) {
    toast(I18n.t("请先终止当前运行"), "warn");
    return;
  }
  S.assistMessages = [];
  S.assistPending = "";
  S.assistLiveTools = [];
  S.assistRunActive = false;
  /* 清空即新会话：Token 累计报告一起归零 */
  S.assistTokenReport = null;
  if (S._assistTokOwner) {
    S._assistTokOwner.tokenReport = null;
    S._assistTokOwner._tokLive = null;
  }
  if (S.thinking) delete S.thinking.assist;
  persistAssistUi();
  renderAssistPanel({ forceStick: true });
  toast(I18n.t("助手会话已清空"), "ok");
}

async function assistSend(text) {
  if (S.assistRunning) return;
  let t = String(text || "").trim();
  if (!t) return;
  if (t.charAt(0) === "\u3001") t = "/" + t.slice(1);
  const skillWrap = await resolveSkillSlash(t);
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  if (!Array.isArray(S.assistMessages)) S.assistMessages = [];
  const assistUm = { role: "user", content: t, at: Date.now() };
  S.assistMessages.push(assistUm);
  if (S.assistMessages.length > 80)
    S.assistMessages.splice(0, S.assistMessages.length - 80);
  S.assistRunning = true;
  S.assistPending = "";
  S.assistLiveTools = [];
  S.assistRunActive = true;
  beginSaveNodeHold();
  S.assistRunWorkspace =
    assistResolveWorkspace() || S.dshWorkspaceFallback || "";
  if (!S.thinking) S.thinking = {};
  S.thinking.assist = [""];
  persistAssistUi();
  renderAssistPanel({ forceStick: true });
  updateRunQueuePanel();

  /* 与画布无关（Gate B · 助手侧）：本轮不注册画布三件套，也不取整张画布快照。
     **本次开发需求：不再由用户按按钮声明，改为按这条消息自动判定**（按钮已移除）——
     判据 = agentCanvasTurnRelated（与会话侧同一个函数）。判不准按「有关」处理，
     所以助手默认行为与改造前完全一致，只有明确指向画布 / 节点图之外的消息才省这一档。
     判据在这里定一次，往下（快照 / 分节 / 隐藏名单 / 签名 / 运行参数）全用同一个值。 */
  const assistCanvasFree = !assistCanvasTurnRelated(t);
  /* 助手栏「纯净模式」（本次需求 · 与助手栏「模式」菜单新增的那一枚同源）：
     与会话窗口完全一致 —— system prompt 整段置空 + 工具侧 pure 位下发网关
     （见 app-db.js 的 pureOn，最终走网关空预设文本 + MTNODE_PURE）。
     读的是全局偏好 S.assistPure（随配置落盘，见 persistAssistUi）。 */
  const assistPure = !!S.assistPure;
  /* 「先拷问需求」助手栏这一枚的开关态（真源 = 全局偏好 S.assistGrill，缺省开）：
     契约按轮贴在人设尾部，是否真拷问由模型自判（见下方 personaHostFull）。 */
  const assistGrill = S.assistGrill !== false;
  /* 不缩进序列化：这份快照每轮原样重发，缩进（null, 2）纯属白送的空格 token */
  const stateJson = JSON.stringify(
    await assistAppSnapshot({ canvasFree: assistCanvasFree }),
  );
  /* 历史存档里曾被回滚的轮次消息不进上下文（activeSessionMessages 无标记时不复制数组） */
  const assistHist = activeSessionMessages(S.assistMessages);
  const hist = assistHist
    .slice(0, -1)
    .slice(-16)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  const scopeCurrent = assistScopeIsCurrent();
  const wfName =
    (S.wf && S.wf.name) || I18n.t("未命名画布");
  const assistAuto = !!(
    S.config &&
    S.config.dsh &&
    S.config.dsh.assistAutoApprove
  );
  /* 「与画布无关」档下这些讲画布 / 应用工具的规则段整段置空（buildSections 丢空节），
     人设与工作范围换成无画布版 —— 裁掉工具就必须同时裁掉「去用这些工具」的指令，
     否则模型会照着旧纪律撞不存在的工具、白烧一整步。 */
  const canvasEditRule = assistCanvasFree
    ? ""
    : assistAuto
    ? "- mtnode_canvas_edit：创建/修改/连线/删除节点等图编辑；当前「助手改画布」为批准，调用会直接生效。\n"
    : "- mtnode_canvas_edit：创建/修改/连线/删除节点等图编辑；会弹窗请用户确认（请等待确认结果，勿臆造成功）。若用户拒绝：用文字说明已完成的文件/步骤与未完成项，不要静默结束。\n";
  /* ── 规则段的真源分工（本轮去重）──────────────────────────────────────────
     参数机制（字段 / 枚举 / 端子 / alias）的唯一真源 = mtnode_canvas_get 与
     mtnode_canvas_edit 的工具描述与参数表；完整操作规范的唯一真源 = 内置技能
     （mtnode-dev-architect / mtnode-canvas-edit-rules / mtnode-canvas-batch-safety /
     mtnode-canvas-layout-ux / mtnode-media-gen-nodes / mtnode-db-facts / mtnode-ai-facts）。下面各节只留
     「每轮都要照做的行为纪律」——同一规则不再抄第二遍，省下的就是每一步都在付的固定 token。 */
  const superConnectRule = assistCanvasFree
    ? ""
    : "  · 跨超级节点 / 跨层级接线用 mtnode_canvas_edit 的 superConnect（它自动逐层桥接，参数口径见该工具说明），不要自己建桥接线。\n";
  const devNodeRule = assistCanvasFree
    ? ""
    :
    "  · 【开发节点 / 功能块】要建或改开发节点（kind super + dev:true）时，先用 skill 工具加载内置技能 mtnode-dev-architect 并照它执行。硬底线：note 必须两段（【功能】面向非技术的设计说明 + 【实现】面向技术的实现梗概，合计 ≤200 字，禁止只写一段、禁止把技术细节写进【功能】）；按 DEV 功能色卡上色（新建 module 块已自动套色，归类不对才改正卡值，绝不自创色值；用户在节点头部色板手选过的颜色不要再动）；细化先给出覆盖多层的整棵梗概、经用户一次确认后自顶向下逐层建块（无需或无法细化时如实说明，不要硬建节点）；模块取舍 / 技术选型等不确定处先问用户。\n" +
    "  · 每个开发节点的折叠卡有「开发」「细化」按钮（文件节点另有「打开」），两者都先弹对话框、用户确认后于该模块绑定的新会话里运行；「建议」（只读调研：不改文件、不改画布，只回恰好 4 条下一步方案供用户多选与补充，同一对话框里的「开发」按钮才按所选方案开工）已从卡片按钮收起，只在节点右键菜单里。\n" +
    "  · 每个功能块收尾都要用 devFiles 补丁回写本模块的真实核心文件（≤10 条 · 相对 devPath · 最外层项目块不填）——节点「文件」按钮只读这份列表，不回填就永远停在自动兜底甚至空表。\n" +
    "  · 画布含开发节点时，项目根就是 Agent 工作区根（顶层块的 devPath 在建图首轮就写好，之后子块继承）：项目根内的文件（含 AGENTS.md 共识文件）直接读写，**不要为写文件申请任何提权或绕法**；仍写不进时如实请用户把工作目录指向项目根。\n";
  const scopeBlock = assistCanvasFree
    ? "工作范围：与画布无关（宿主按这条消息自动判定）—— 本轮不注册 mtnode_canvas_get / mtnode_canvas_edit / mtnode_app，也不读取任何画布内容。\n工具：只剩文件读写、联网搜索与命令执行（外加识图子代理，视工具许可而定）。\n若确实要动画布：按人设那句请用户补一句画布 / 节点再发一次，别去撞不存在的工具。\n"
    : scopeCurrent
    ? "工作范围：仅当前画布「" +
      wfName +
      "」。list_workflows / canvas_get 只会看到本画布。\n" +
      "工具：\n" +
      "- mtnode_canvas_get：读取当前画布（默认 minimal，只回节点索引；要读某节点正文用 ids:[标题或 id] + detail:\"full\"，看连线 / 结构用 sections 收窄）\n" +
      "- mtnode_app：rename_workflow（仅本画布）/ select_nodes / undo / redo / status / list_workflows（仅本画布）/ export_canvas_png（把整张画布拍成高清 PNG 落盘，仅前台画布，拍完把路径给你）；delete_workflow 仅可删本画布且需确认；list_dsh_plugins / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin（安装与挂载需确认，插件装在配置目录、升级保留）。\n"
    : "工作范围：全局。可参考全部画布列表。\n" +
      "工具：\n" +
      "- mtnode_canvas_get：读取当前画布 + 全部画布列表（默认 minimal，只回节点索引；要读某节点正文用 ids:[标题或 id] + detail:\"full\"，看连线 / 结构用 sections 收窄）\n" +
      "- mtnode_app：rename_workflow / select_nodes / undo / redo / status / list_workflows / export_canvas_png（把当前画布拍成高清 PNG 落盘，仅前台画布，拍完把路径给你）；delete_workflow 会弹窗确认；list_dsh_plugins / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin（安装与挂载需确认，插件装在配置目录、升级保留）。\n";
  /* ── systemPrompt 分节（见 app-prompt-sections.js）──────────────────────────
     每段各自独立成节，节序 = 改造前的拼接顺序、节间分隔符传空串 ⇒
     拼出来的字符串与今天逐字节一致；app_state（当前应用状态 JSON，每轮都变的最大头）
     单独成节，便于将来按节 diff。skill_index / db_grounding / tool_policy /
     lang_taste 由 app-db.js 统一追加，此处不重复注入。 */
  const personaHost = assistCanvasFree
    ? "你是 MTNode AI编排器的全局助手，位于界面右侧栏。宿主按这条消息判定**本轮与画布无关**：本轮不注册任何画布与应用工具（mtnode_canvas_get / mtnode_canvas_edit / mtnode_app 都不可用），你只读写文件、联网、执行命令，也不注入整张画布快照。\n本轮不要承诺任何画布改动，也不要臆造节点或画布现状。若这条任务其实需要动画布：**先别硬做** —— 用一句话说明「这轮按无关档跑、画布工具没在」，请用户在同一句里补上画布 / 节点（例如「改画布上的『文本节点 2』」）再发一次，下一轮就会带上画布工具。\n"
    : "你是 MTNode AI编排器的全局助手，位于界面右侧栏。你能看到并操作应用内画布、节点、服务商与智能配置摘要。\n";
  /* 拷问契约（本次需求 · 助手栏「先拷问需求」那一枚）：贴在人设尾部（不是单开一节）——
     节序表里没有这个 id 会被排到全表末尾，离「该不该开工」的判断点太远；
     贴在人设后面才有约束力。纯净模式开着时整段 system prompt 都置空（本就不注入）。 */
  const assistGrillContract = assistGrill && !assistPure ? GRILL_CONTRACT : "";
  const visionMediaRules = assistCanvasFree
    ? /* 无画布档：整段画布 / 节点口径撤掉，只留「回执即事实」这条通用纪律 */
      "- 工具回执里没有的结果，不要向用户声称已完成。\n"
    : "- mtnode_vision：识图子代理。中途需要看本地图片内容（游戏 UI、截图 OCR、核对生成图）时调用，传 imagePath（绝对路径）+ question；首次会请用户许可（允许一次 / 始终允许 / 拒绝）。不要把大批图片塞进主对话。\n" +
    "  · 文字处理与图生文（多模态识图）要隔离：先由专用识图 / 智能任务节点把图像转成文字，再让纯文本节点吃那段文字，这样文字步骤能选更合适的非视觉模型。\n" +
    "  · 图像参考节点用 kind input_image，把本机绝对路径写进 imagePath（应用会复制进画布资产），已知路径就不要让用户再拖拽；多图 batch:true + imagePaths。\n" +
    "  · 改节点模型：create/update 传 model，文本 / 图像节点配 providerId（服务商 id 或唯一名称），智能任务配 provider（deepseek-official 或 mtnode_<id> / 名称）。\n" +
    "  · 工具回执（created[] / updated[] / hasImage / warnings）才是事实依据：没出现在回执里的结果，不要向用户声称已完成。\n" +
    "  · 音 / 视频生成节点（music_gen / tts_gen / video_gen / remotion）的后端、outputPath、抽卡与显存互斥口径见技能 mtnode-media-gen-nodes；写 music_gen / yue_gen 的风格提示词与歌词先加载内置技能 minimax-music-prompt / minimax-music-lyrics（提示词 = 一段六句英文散文，不是标签堆）；批次与文生图的防 N² 细则见技能 mtnode-canvas-edit-rules（细则再进 mtnode-canvas-batch-safety）。\n";
  /* @引用、save / wait_file、端子与批次规则已由技能 mtnode-canvas-edit-rules 承载
     （mtnode_canvas_edit 只留卡口与一句指向）；这里只留助手侧的排版动作。 */
  const layoutRules = assistCanvasFree
    ? ""
    : "  · 排版：用 createMarks 分区（box + around:[节点alias] + label：编辑区 / 说明 / 处理区 / 输出区），并放 control 控制节点（ctrlAction=run，不要建 clear「清空」；控制流不走数据线，须直连每个该一键重跑的节点）；用户要编辑或点 ▶ 的节点放上方（较小 y），处理 / 保存 / 长说明放下方或右侧。完整规范见技能 mtnode-canvas-layout-ux。\n" +
    "  · 用户要求整理排版 / 一键排版时：先 mtnode_canvas_get 读节点与绘制的 x/y/w/h，再自行判断，用 mtnode_canvas_edit（layout:false）的 update / updateMarks 校准位置与尺寸（整洁、可编辑节点靠上、绘制跟着节点走）；禁止调用 layout action，勿增删节点、勿改连线，然后简短确认。\n";
  const principleBlock = assistCanvasFree
    ? "原则：本轮与画布无关（宿主按这条消息自动判定）—— 不读写画布、不承诺任何节点改动，只完成任务本身；不要编造不存在的节点或画布。若任务其实要动画布，请按人设那句让用户补一句画布 / 节点再发。回答简洁（交流语言见文末语言口味）。\n"
    : scopeCurrent
    ? "原则：仅操作当前画布；app_state 只给计数与选中 / 焦点，节点列表与正文一律按需 mtnode_canvas_get 现拉，不得凭标题编造节点内容；改节点图、删画布、装/卸 DSH 插件再走确认。回答简洁（交流语言见文末语言口味）。不要编造不存在的节点或画布。\n" +
      "相关性：先自己判断本轮任务是否与画布有关 —— 无关就别读画布（不要调 mtnode_canvas_get），直接完成这一件活；有关再按需现拉。\n" +
      "纪律：长正文一条都不进主上下文 —— 节点之间只写 @标题 引用，禁止把上游节点正文粘贴进 prompt/task（@引用口径见技能 mtnode-canvas-edit-rules）；长文案 / 长说明交给 agent_task 或 input_text 节点落文件，你只报路径；建图时不要贴成品正文当示例，只写一句形态描述。收尾克制：只报改了什么、产物路径、需用户操作的 1–2 处，不复述画布全表。建图—自查—排版这类多轮工作放进子代理上下文，主对话只收最终回执。\n"
    : "原则：可参考其他画布列表；app_state 只给计数与选中 / 焦点，节点列表与正文一律按需 mtnode_canvas_get 现拉，不得凭标题编造节点内容；改节点图、删画布、装/卸 DSH 插件再走确认。回答简洁（交流语言见文末语言口味）。不要编造不存在的节点或画布。\n" +
      "相关性：先自己判断本轮任务是否与画布有关 —— 无关就别读画布（不要调 mtnode_canvas_get），直接完成这一件活；有关再按需现拉。\n" +
      "纪律：长正文一条都不进主上下文 —— 节点之间只写 @标题 引用，禁止把上游节点正文粘贴进 prompt/task（@引用口径见技能 mtnode-canvas-edit-rules）；长文案 / 长说明交给 agent_task 或 input_text 节点落文件，你只报路径；建图时不要贴成品正文当示例，只写一句形态描述。收尾克制：只报改了什么、产物路径、需用户操作的 1–2 处，不复述画布全表。建图—自查—排版这类多轮工作放进子代理上下文，主对话只收最终回执。\n";
  /* 应用状态 JSON 单独成节：每轮都变的最大头，只有独立出来才谈得上单独 diff。
     快照只给计数与选中 / 焦点、连节点索引都不带，这条纪律跟 app_state 贴在一起，模型
     才不会以为快照里就有节点或正文而编造内容（字段真源仍在网关工具描述里）。 */
  const appStateHeads = assistCanvasFree
    ? ""
    : "本轮 app_state 只给节点计数与选中 / 焦点，不含节点索引、更不含正文：要看节点列表用 mtnode_canvas_get 缺省档（detail:\"minimal\"，每节点只给标题 / 描述(note) / 类别）；要看连线 / 绘制 / 分组 / 树再加 sections，要看配置用 detail:\"standard\"，要看某节点正文 / 提示词用 ids:[标题或 id] + detail:\"full\"。快照里没有的一律不要编造。\n";
  const appStateBlock = appStateHeads + "当前应用状态 JSON：\n" + stateJson;
  const latest = skillWrap ? skillTaskPrompt(skillWrap) : t;
  let input = hist ? hist + "\n\n用户(最新)：" + latest : latest;
  const assistMaxTok = dshRunMaxTokens();
  /* 三个可见集通道的助手侧取值：助手没有节点也就不可能接入数据库副本（dbGrounded 恒 false）；
     noCanvas = 本轮被自动判定「与画布无关」（Gate B 助手侧，判据 agentCanvasTurnRelated），
     与会话侧同一个整档闸。名单与 dshRunOnce 用同一个 dshHiddenToolsFor 算，否则判据一开，
     分节快照与真实运行签名就长期错开（快照每轮白作废）。 */
  const assistLean = typeof dshLeanToolsOn === "function" ? dshLeanToolsOn() : false;
  const assistHide =
    typeof dshHiddenToolsFor === "function"
      ? dshHiddenToolsFor({
          pure: assistPure,
          dbGrounded: false,
          lean: assistLean,
          noCanvas: assistCanvasFree,
        }).join(",")
      : "";
  /* 无画布档下画布规则段全为空串：buildSections 丢空节，fallback 的 join("") 同样不占位，
     两条路径拼出来的结果一致。 */
  const assistSections = {
    persona_host: personaHost,
    scope: scopeBlock,
    canvas_rules: canvasEditRule,
    superconnect_rules: superConnectRule,
    devnode_rules: devNodeRule,
    vision_media_rules: visionMediaRules,
    layout_rules: layoutRules,
    principle: principleBlock,
    app_state: appStateBlock,
  };
  /* 节序（app-prompt-sections.js 规范表）+ join:"" ⇒ 拼出来与改造前的整串逐字节一致 */
  const systemPrompt = assistPure
    ? ""
    : typeof renderSections === "function"
      ? renderSections("assist", assistSections, {
          join: "",
          sig: dshRunSigOf({
            workspace: S.assistRunWorkspace || S.dshWorkspaceFallback || "",
            model: S.assistModel || "",
            provider: S.assistProvider || "deepseek-official",
            preset: S.assistPreset || AGENT_PRESET_DEFAULT,
            effort: S.assistEffort || "high",
            pure: assistPure,
            lean: typeof dshLeanToolsOn === "function" ? dshLeanToolsOn() : false,
            noCanvas: assistCanvasFree,
            hide: assistHide,
            maxTokens: assistMaxTok,
          }),
        }).text + assistGrillContract
      : /* 内核不在（老沙箱只抠单文件）：按同一节序直接串接，结果与分节渲染一致；
           拷问契约按同一口径在**整段之后**追加（与会话侧 systemPrompt += GRILL_CONTRACT 同源）。 */
        [
          personaHost,
          scopeBlock,
          canvasEditRule,
          superConnectRule,
          devNodeRule,
          visionMediaRules,
          layoutRules,
          principleBlock,
          appStateBlock,
        ].join("") +
        assistGrillContract;
  let assistHitMaxTokens = false;
  try {
    const final = await dshRunTask(input, {
      runKey: "assist",
      workspace: S.assistRunWorkspace || S.dshWorkspaceFallback || "",
      preset: S.assistPreset || AGENT_PRESET_DEFAULT,
      provider: S.assistProvider || "deepseek-official",
      model: S.assistModel || undefined,
      effort: S.assistEffort || "high",
      systemPrompt,
      /* 纯净模式（助手栏「模式」菜单里那一枚 · 本次需求）：与会话窗口同一条链 ——
         systemPrompt 置空 + pure 标记下发网关（网关强制空预设文本、引擎按 MTNODE_PURE 移除人设）。 */
      pure: assistPure,
      /* Gate B（助手侧）：与画布无关 → 走 MTNODE_NO_CANVAS 整档闸，画布三件套
         （get / edit / app 合计约 26.0K 字符/步）整个不注册；快照也已换成轻量摘要。 */
      noCanvas: assistCanvasFree,
      onDone: (d) => {
        const m = d && d.metrics;
        if (m) {
          recordDshMetrics(null, m);
          const cap = Number(m.maxTokens) || assistMaxTok;
          const used =
            (Number(m.outputTokens) || 0) + (Number(m.reasoningTokens) || 0);
          if (assistMaxTok > 0 && cap > 0 && used >= Math.floor(cap * 0.95))
            assistHitMaxTokens = true;
        }
      },
      onEvent: (type, data) => {
        /* 出错自动重发（dshRunTask 触发 retry）：看 resumed 决定清不清残文 ——
           · resumed=true（续写）：已显示的部分正文 / 工具列表 / 用量保留（同一轮的内容）；
             **思考槽也保留** —— 思考是这一轮已经发生的事情，续跑起步时轨迹里的思考段
             只被切开收口（app-db.js traceSplitThink）、一段都没删，槽里清掉它就等于
             把用户刚看过的思考抹掉（本 bug：会话里的思考内容被移除；节点侧一直是保留的）。
             新一轮的思考会另起一段，不会与旧思考混成一段。
           · resumed=false（整轮重发）：正文 / 工具 / 用量 / 思考槽全清，从零流式不叠字
             （轨迹也走了 traceReset，留着槽只是残留旧内容）。
           resumed 由宿主按「这一次实际怎么发」给出（见 app-db.js notifyRetry）。 */
        if (type === "retry") {
          /* resumed=true：整轮内容（正文 / 工具 / 用量 / 思考）一律保留，这里一行都不动 */
          if (data && data.resumed) return;
          if (S.thinking) S.thinking.assist = [""];
          S.assistPending = "";
          S.assistLiveTools = [];
          const el = document.getElementById("assist-stream");
          if (el) el.textContent = "";
          /* 思考槽就地清一次：renderAssistPanel 会按清空后的缓冲重建这一行 */
          const th = document.getElementById("assist-think");
          if (th) th.textContent = "";
          renderAssistPanel();
          return;
        }
        if (type === "reasoning" && data && data.text) {
          pushThinking("assist", 0, data.text);
          const el = document.getElementById("assist-think");
          if (el)
            el.textContent = traceThinkDisplay(
              "assist",
              (S.thinking && S.thinking.assist && S.thinking.assist[0]) || "",
            );
        } else if (type === "tool" && data && data.name) {
          /* 工具调用只进 assistLiveTools（与运行轨迹的 tool 段），不污染思考文本 */
          S.assistLiveTools = S.assistLiveTools || [];
          if (!S.assistLiveTools.some((x) => x.callId === data.callId))
            S.assistLiveTools.push({
              callId: data.callId,
              turn: data.turn,
              step: data.step,
              name: data.name,
              args: data.args || "",
              result: null,
              error: null,
              at: Date.now(),
            });
          renderAssistPanel();
        } else if (type === "tool-result" && data && data.callId) {
          S.assistLiveTools = S.assistLiveTools || [];
          const tool = S.assistLiveTools.find((x) => x.callId === data.callId);
          if (tool) {
            tool.result = Array.isArray(data.content) ? data.content : [];
            tool.error = data.error || null;
            renderAssistPanel();
          }
        } else if (type === "text" && data && data.text) {
          S.assistPending = (S.assistPending || "") + data.text;
          const el = document.getElementById("assist-stream");
          if (el) el.textContent = traceSayDisplay("assist", S.assistPending);
          scrollElToBottomIfStuck($("#assistList"));
        } else if (type === "error" && data && data.message) {
          if (S.assistStopRequested || isCancelishError(data.message)) return;
          S.assistPending = (S.assistPending || "") + "\n⚠ " + data.message;
          const el = document.getElementById("assist-stream");
          if (el) el.textContent = traceSayDisplay("assist", S.assistPending);
          scrollElToBottomIfStuck($("#assistList"));
        }
      },
    });
    if (S.assistStopRequested) {
      const stopped = stripStreamErrors(S.assistPending);
      S.assistMessages.push({
        role: "assistant",
        content: stopped || I18n.t("（已终止）"),
        at: Date.now(),
      });
    } else {
      let body =
        (typeof final === "string" ? final : final && final.text) ||
        S.assistPending ||
        I18n.t("（已完成，无文本输出）");
      body = stripStreamErrors(body) || body;
      if (assistHitMaxTokens) {
        const note = I18n.t(
          "\n\n⚠ 本次输出已接近单次 maxTokens 上限，可能因此提前结束。可回复「继续」接着做，或在设置里提高智能能力的 maxTokens。",
        );
        if (!String(body).includes("maxTokens")) body = String(body || "") + note;
        toast(
          I18n.t("全局助手可能因输出 token 上限提前结束，可回复「继续」"),
          "warn",
        );
      }
      const msg = {
        role: "assistant",
        content: body,
        at: Date.now(),
      };
      /* 思考与输出分家：reasoning = 按步分段的纯思考（不含「🔧」），
         segments = 本轮轨迹段快照，重绘后仍能还原「思考 / 正文 / 工具」步序 */
      const rsn = traceThinkDisplay(
        "assist",
        (S.thinking && S.thinking.assist && S.thinking.assist[0]) || "",
      );
      if (String(rsn).trim()) msg.reasoning = rsn;
      attachTraceSegments(msg, "assist");
      if (Array.isArray(S.assistLiveTools) && S.assistLiveTools.length)
        msg.tools = S.assistLiveTools.slice();
      S.assistMessages.push(msg);
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const cancelled =
      S.assistStopRequested || isCancelishError(msg);
    if (cancelled) {
      const body = stripStreamErrors(S.assistPending);
      S.assistMessages.push({
        role: "assistant",
        content: body || I18n.t("（已终止）"),
        at: Date.now(),
      });
    } else {
      S.assistMessages.push({
        role: "assistant",
        content: I18n.t("助手失败：") + msg,
        at: Date.now(),
      });
      toast(I18n.t("全局助手失败：") + msg, "err");
    }
  } finally {
    S.assistStopRequested = false;
    S.assistRunning = false;
    S.assistRunActive = false;
    S.assistRunWorkspace = null;
    S.assistPending = "";
    S.assistLiveTools = [];
    if (S.thinking) S.thinking.assist = [""];
    persistAssistUi();
    renderAssistPanel();
    updateRunQueuePanel();
    endSaveNodeHold();
  }
}

function assistStop() {
  if (!S.assistRunning) return;
  S.assistStopRequested = true;
  S.assistRunActive = false;
  dshCancelActive("assist");
  updateRunQueuePanel();
}

/* ============ 智能会话画布(全屏 agent 会话,等于常驻的智能任务) ============ */

/* ── 会话「所属画布」(canvasWfId) ──
   会话过去每轮都现取用户此刻看到的画布（S.wf），用户一切去别的画布干活，会话就漂到
   那张图上去了。现在会话在「新建那一刻」就绑定一张所属画布，之后它的画布读写、工作区、
   数据库接地都精准落在所属画布上，与前台切到哪张图无关。
   这里只负责产出与规范化绑定值；开轮时按这个 id 解析回画布对象（app-db.js dshRunTask 的 boundWf）。 */
function currentVisibleWfId() {
  const w =
    typeof currentVisibleWf === "function"
      ? currentVisibleWf()
      : typeof S !== "undefined"
        ? S.wf
        : null;
  return w && w.id ? String(w.id) : "";
}
/* 节点绑定会话（开发 / 细化 / 问询 / 工具·函数开发 / 智能任务）绑节点所属画布；
   解析不到就退回用户此刻看到的画布，绝不留空。 */
function canvasWfIdForNode(node) {
  try {
    if (node && typeof ownerWfOfNode === "function") {
      const w = ownerWfOfNode(node);
      if (w && w.id) return String(w.id);
    }
  } catch (_) {}
  return currentVisibleWfId();
}
/* ── 自检与长时纪律（会话系统提示的行为纪律，唯一一处）────────────────────
   用户已确认的四条口径（见本功能块的开发任务书与拷问共识）：
     · 分阶段自检 + 交付前全检；
     · 发现产出与原目标不符 / 关键结论无证据 → 先自行修复并重跑，修不好才告知用户；
     · 关键结论必须带证据（来源 URL / 命令输出 / 截图路径），无证据不下断言；
     · 长任务不空转；跨重启（要数小时 / 要断点续跑）的活，建议用户提升为长周期任务图。
   浏览器一侧的纪律（接管期间停手、凭据不进对话、危险动作先问）写在 browser_help /
   browser_type 的工具描述里，此处不重复。 */
const SELF_CHECK_DISCIPLINE =
  "\n\n【自检与长时纪律】\n" +
  "· 自检分两道：每完成一个阶段 / 大步骤做一次阶段自检（这一阶段的产出对不对、证据齐不齐、下一步是什么），交付前做一次全检（对照最初的目标逐条核，漏项与猜测都算不合格）。\n" +
  "· 用 todo_write 记的清单要随手收口：每完成一条立刻标 completed（不要攒到最后一起标），交付前再写一次整份清单把每条状态写死；**绝不许把没做完的条目留在模糊状态收尾** —— 会话结束时清单里剩下的条目会被标成「未确认」，用户看到的就是一串「?」，等于这份清单白记了。\n" +
  "· 自检发现输出与原目标不符、或关键结论无证据时：先自己回去修好 / 补证据并重跑那一步，不要把它当定稿往后带，也不要在这种时候先来问用户；修不好（缺权限 / 缺信息 / 被网站拦住）才带着「试过什么、卡在哪、需要什么」来问。\n" +
  "· 关键结论必须带证据：每条硬断言后面给出可复核的依据（来源 URL / 命令输出摘要 / 截图或文件的绝对路径）。拿不到证据就明说「未验证」或「没查到」，绝不用印象补全。\n" +
  "· 长任务不空转：不要重复已经做过且没有新信息的事，不要为了显得忙而重跑同一份调研；每一步都要能说出「这一步让哪个结论前进了」。\n" +
  "· 要数小时才能做完、或需要跨重启接着跑的活：主动建议用户把它提升为「长周期任务图」（图上带阶段与断点），但不要自行替用户改图 —— 等用户确认后再动手。\n" +
  "· 浏览器工作要留下痕迹：改动前后的页面状态、下载与截图路径、跑过的命令，都写进交付说明里，让用户能自己复核。";

/* 会话列表:全部持久化于 config.agentSessions,活动会话由 agentActiveId 指定 */
function agentSessions() {
  if (!Array.isArray(S.agentSessions)) S.agentSessions = [];
  /* 所属画布水合：历史存档没有 canvasWfId → 规范成空串（表示「未绑定」）。
     开轮时按当时画布补绑一次并落盘，见 app-db.js dshRunTask 的 boundWf 解析。 */
  for (const s of S.agentSessions)
    if (s && typeof s.canvasWfId !== "string") s.canvasWfId = "";
  /* 所属应用水合：新建开发会话时带上的 appId 标记（开发页按它过滤会话，见
     renderer/app-app-flow.js 的 appSessionsOf）。老存档没有这一位 → 规范成空串 =
     不属于任何应用；只在读列表时归一，不动 60 条截断与其它任何逻辑。 */
  for (const s of S.agentSessions)
    if (s && typeof s.appId !== "string") s.appId = "";
  /* 标题标记水合：titleAuto（被引擎首轮自动命名过）/ titleLocked（用户手改过）
     归一成布尔 —— 老存档没这两位就是 false，不报错也不给旧会话凭空上锁。 */
  for (const s of S.agentSessions)
    if (s) {
      s.titleAuto = !!s.titleAuto;
      s.titleLocked = !!s.titleLocked;
    }
  /* 计划闸豁免位水合：noPlanFlow（长任务新建窗的引导建图会话）与 ltBound（长任务环节的
     运行档案会话）都参与 app-plan.js 的 planFlowExemptSession 判据；落盘见 persistAgentSession，
     这里把从配置载回 / 旧存档缺位的会话归一好，保证重启后这类会话仍不走普通会话计划线。 */
  for (const s of S.agentSessions)
    if (s) {
      s.noPlanFlow = !!s.noPlanFlow;
      s.ltBound =
        s.ltBound && typeof s.ltBound === "object"
          ? {
              wfId: String(s.ltBound.wfId || ""),
              runId: String(s.ltBound.runId || ""),
              path: String(s.ltBound.path || ""),
            }
          : null;
    }
  /* 从配置载回的会话做一次水合（planDelivered / plan → 运行时字段）；
     水合过就有 _planHydrated 标记，后续调用只是几次属性读，开销可忽略。 */
  if (typeof planHydrateSession === "function")
    for (const s of S.agentSessions) planHydrateSession(s);
  /* 轮次标签（本次需求改为「会话时间区间」）不需要水合：区间从消息历史现推
     （agentRoundRange），没有第二个计数器、也没有持久键要搬。 */
  /* 开发 / 细化绑定会话的水合：旧版把整份任务书当作首条 _src:"dev-node" 用户消息，
     现改为写入 _devContract（发送时注入系统提示）；载回旧会话时做一次迁移。 */
  if (typeof devContractHydrateSession === "function")
    for (const s of S.agentSessions) devContractHydrateSession(s);
  /* 「先拷问需求（grill-me）」水合（本次需求）：会话级开关**缺省开** ——
     老存档 / 没点过这一枚的会话都没有这一位，统一归一成 true（与开发节点 devGrill
     「没写过 = 默认开」同一口径）；用户点过关掉的会话是布尔 false，原样留着。 */
  for (const s of S.agentSessions)
    if (s && typeof s.grill !== "boolean") s.grill = true;
  return S.agentSessions;
}
/* 旧版开发 / 细化会话迁移：首条 _src:"dev-node" 消息里是整份任务书 →
   搬进 s._devContract，消息内容缩成用户关键输入（本次开发需求 / 细化范围）行。
   幂等：新形态会话（消息已精简、_devContract 已就位）直接跳过。 */
function devContractHydrateSession(s) {
  if (!s || s._devContractHydrated) return;
  s._devContractHydrated = true;
  /* 新形态会话重启后只有持久化的 devContract 字段：还原成运行时字段 _devContract */
  if (!s._devContract && s.devContract) s._devContract = s.devContract;
  if (s._devContract) return;
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  const first = msgs[0];
  if (!first || first.role !== "user" || first._src !== "dev-node") return;
  const body = String(first.content || "");
  /* 任务书在创建会话时按当时 UI 语言写入：兼容当前语言与中文原文两种抬头 */
  const headers = [I18n.t("【开发任务书】"), "【开发任务书】"];
  let isFull = false;
  for (const h of headers) if (body.indexOf(h) >= 0) isFull = true;
  if (!isFull) return;
  let visible = "";
  if (typeof devReqTextOfMessage === "function") {
    const req = devReqTextOfMessage(first);
    if (req) visible = I18n.t("本次开发需求：") + req;
  }
  if (!visible) {
    const scopePrefixes = [I18n.t("用户指定的细化范围："), "用户指定的细化范围："];
    for (const p of scopePrefixes) {
      const at = body.indexOf(p);
      if (at < 0) continue;
      const scope = body.slice(at + p.length).split("\n")[0].trim();
      if (scope) {
        visible = I18n.t("用户指定的细化范围：") + scope;
        break;
      }
    }
  }
  /* 还原不出关键输入（如旧细化会话无范围行）：保持原样，不破坏旧会话展示 */
  if (!visible) return;
  s._devContract = body;
  first.content = visible;
}
function activeAgentId() {
  const list = agentSessions();
  if (!list.some((s) => s.id === S.agentActiveId)) {
    S.agentActiveId = list.length ? list[0].id : "";
  }
  return S.agentActiveId;
}

/* ── 会话视图「本页显示哪条会话」（显示覆盖）─────────────────────────────────
   默认 = 用户选中的那条（S.agentActiveId，会话页一字不改）。应用中心的「应用 → 开发」
   三栏页开着时，右栏要显示该页左栏那条开发会话 —— 走这里的显式覆盖，**绝不写
   S.agentActiveId**：开发页开着 / 关着的整个过程中，会话页的选中项、正文与四块面板的
   归属都保持原样（离开开发页即撤掉覆盖，见 app-apps-dev.js 的 appsDevViewClear）。
   历史 bug：开发页直接把 S.agentActiveId 拨过去（清面板与拨 id 两步不同步、或那条会话
   已不在时那一步被静默跳过），于是会话页里**正在跑的另一条会话**的计划 / 任务清单 /
   发送队列会原样留在开发页右栏（用户看到的「点开开发页，右栏冒出进行中的计划表」）。
   覆盖值：
     · ""（空串）= 覆盖开着但**本页还没有会话**（开发页首轮态）→ 用占位空会话渲染：
       正文与四块面板一律为空，绝不回落到会话页的当前会话；
     · 会话 id    = 本页显示这条（它若已不在，同样落到占位空会话）。
   只影响「看」：渲染 / 滚动 / 「用户是不是正看着它」的判断统一走 agentViewIs() /
   agentViewHas()；写操作一律由调用方点名真实会话 id（发送 / 排队 / 暂停 / 终止本来
   就带 sessionId），所以占位空会话永远不会被写到。 */
let AGENT_VIEW_OVERRIDE = null; /* null = 没有覆盖；"" 或 会话 id = 覆盖值 */
let AGENT_VIEW_BLANK = null; /* 覆盖态下的占位空会话（只在内存里：不注册、不落盘） */
function agentViewOverrideOn() {
  return AGENT_VIEW_OVERRIDE !== null;
}
function agentViewOverrideId() {
  return AGENT_VIEW_OVERRIDE === null ? "" : String(AGENT_VIEW_OVERRIDE || "");
}
/* 开启 / 切换覆盖（id 为空 = 本页还没有会话：渲染成空，不回落） */
function agentViewOverrideSet(id) {
  const next = String(id || "");
  if (AGENT_VIEW_OVERRIDE === next) return;
  AGENT_VIEW_OVERRIDE = next;
  /* 换页 / 换会话 = 新的空态：上一只占位里被改过的选项不再沿用 */
  AGENT_VIEW_BLANK = null;
}
/* 撤掉覆盖：回到会话页自己的选中项（离开开发页时调用，调用方随后重绘一次） */
function agentViewOverrideClear() {
  if (AGENT_VIEW_OVERRIDE === null) return;
  AGENT_VIEW_OVERRIDE = null;
  AGENT_VIEW_BLANK = null;
}
/* 覆盖态下的占位空会话：没有消息 / 没有计划 / 没有待办 / 没有队列，一切渲染都是空 */
/* 占位空会话的 id：非法会话 id，写路径一律点名真实 id，永不落到它身上。
   另外两处按它认人：agentDraftKeyNow（首轮态那只输入框的草稿归谁）与
   renderAgentSession 的草稿存取（见下面的「消息栏草稿」段）。 */
const AGENT_VIEW_BLANK_ID = "\u0000agent-view-blank";
function agentViewBlankSt() {
  if (AGENT_VIEW_BLANK) return AGENT_VIEW_BLANK;
  AGENT_VIEW_BLANK = {
    id: AGENT_VIEW_BLANK_ID,
    title: I18n.t("新会话"),
    workspace: "",
    canvasWfId: "",
    preset: AGENT_PRESET_DEFAULT,
    provider: "deepseek-official",
    model: "",
    effort: "high",
    pure: false,
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  return AGENT_VIEW_BLANK;
}
/* 视图会话 id：覆盖态 = 覆盖值（空串 = 空态 / 那条会话已不在）；否则 = 用户选中的 */
function agentViewId() {
  if (!agentViewOverrideOn()) return activeAgentId();
  const id = agentViewOverrideId();
  if (!id) return "";
  const list = agentSessions();
  return list.some((s) => s.id === id) ? id : "";
}
/* 「用户是不是正看着这条会话」的唯一判据（渲染 / 反馈 / 计划面板刷新都走它）。
   非覆盖态与老写法（S.agentActiveId 直比）完全等价。 */
function agentViewHas(id) {
  const sid = String(id || "");
  if (!sid) return false;
  if (agentViewOverrideOn()) return agentViewOverrideId() === sid;
  return String(S.agentActiveId) === sid;
}
function agentViewIs(st) {
  return !!st && agentViewHas(st.id);
}
/* 通知会话主内容右边栏（app-browser.js 的 BrowserAct）：「眼前这条会话」变了。
   右栏据此换活动范围、并按该会话有没有浏览器决定显不显（用户已确认口径）。
   唯一挂钩点 = renderAgentSession（左栏点会话 / 新建 / 删除 / 归档 / 开发页覆盖态
   切换 / 启动恢复都汇到它），取的是**本页显示的会话**（agentViewId），不是
   S.agentActiveId —— 开发页开着时右栏显示的也是本页那条。
   调用期取全局 + typeof 守卫：老壳 / 冒烟没有 BrowserAct 时静默跳过，不动画布。 */
function agentNotifyBrowserSession(id) {
  try {
    if (window.BrowserAct && typeof window.BrowserAct.setSession === "function") {
      window.BrowserAct.setSession(id == null ? agentViewId() : String(id || ""));
    }
  } catch (_) {}
}
/* 左栏点会话行 = 「我要看这条」：开发页开着时切的是**本页显示的会话**（覆盖值），
   会话页的选中项（S.agentActiveId）一个字都不动；不在覆盖态时就是老行为。 */
function agentSelectSession(id) {
  const sid = String(id || "");
  if (!sid) return;
  if (agentViewOverrideOn()) agentViewOverrideSet(sid);
  else S.agentActiveId = sid;
}
/* 按 id 取会话：取不到就是 null —— 绝不回退到「当前活动会话」。
   计划等有明确归属（owner）的调用必须走它，否则用户一切换会话，
   剩余任务就会发进别的会话（runKey / outbox / 上下文全部串台）。 */
function agentSessionById(id) {
  const sid = String(id || "").trim();
  if (!sid) return null;
  const list = agentSessions();
  return list.find((s) => s && s.id === sid) || null;
}
function agentSessionState() {
  const list = agentSessions();
  /* 覆盖态（应用开发页开着）：只认本页显示的那条会话；本页还没有会话、或它已不在
     → 占位空会话。绝不回落到会话页的当前会话 —— 那正是开发页右栏冒出「他会话的
     计划 / 任务清单 / 发送队列」的来源（见上面 agentViewOverrideSet 的说明）。 */
  if (agentViewOverrideOn()) {
    const viewId = agentViewId();
    const st0 =
      (viewId ? list.find((s) => s.id === viewId) : null) || agentViewBlankSt();
    if (st0.provider == null) st0.provider = "deepseek-official";
    if (st0._draft == null) st0._draft = st0.draft || "";
    return st0;
  }
  let st = list.find((s) => s.id === activeAgentId());
  if (!st) {
    st = {
      id: uid("as"),
      title: I18n.t("新会话"),
      workspace: "",
      /* 所属画布：新建那一刻用户看到的画布（用户一切画布，会话不跟着漂） */
      canvasWfId: currentVisibleWfId(),
      preset: AGENT_PRESET_DEFAULT,
      provider: "deepseek-official",
      model: "",
      effort: "high",
      pure: false,
      messages: [],
      archived: false,
      updatedAt: Date.now(),
    };
    list.unshift(st);
    S.agentActiveId = st.id;
  }
  if (st.provider == null) st.provider = "deepseek-official";
  if (st._draft == null) st._draft = st.draft || "";
  return st;
}
function wsGroupOf(ws) {
  const s = String(ws || "").trim();
  if (!s) return I18n.t("默认目录");
  const parts = s
    .replace(/^[A-Za-z]:[\\/]?/, "")
    .split(/[\\/]+/)
    .filter(Boolean);
  /* 用最内层文件夹名作为项目目录（分组标签） */
  return parts.length ? parts[parts.length - 1] : I18n.t("默认目录");
}
/* ── 会话消息的保留上限（本次需求 · 用户口径「本会话每一轮都长期保留」）─────────
   过去这里是「超过 100 条就从头裁掉」的固定条数上限（本文件的开轮裁切、落盘 slice，
   app-db.js 的三处写入路径各一份）。它的实际后果不是「少留点闲聊」：一次开发 / 细化
   轮次里用户消息本来就多（询问窗的每一条回答都是一条 user 消息），一轮能吃掉 8～15 条，
   于是一到 7 轮上下，最早的**助手消息**就被整条挤出去 —— 轨迹与改动两栏的数据源正是
   「每条助手消息的 m.segments / m.tools」，那一轮从此在那两栏里消失（用户报的
   「轨迹和改动仅保留了最后一轮」）。
   所以口径改成**按轮保留**：至少留住最近 AGENT_MIN_KEEP_PER_ROUND 轮（一轮按最多
   AGENT_ROUND_MAX_ENTRIES 条消息折算），另设一个宽松的总条数上限兜住极端情况。
   两个数都只是「最多留多少」的闸，不改变任何一条消息的字段与内容。 */
const AGENT_MIN_KEEP_PER_ROUND = 120; /* 至少留住这么多轮（每轮按下面那个折算） */
const AGENT_ROUND_MAX_ENTRIES = 16; /* 一轮最多按这么多条消息算 */
const AGENT_MSG_KEEP_MAX = AGENT_MIN_KEEP_PER_ROUND * AGENT_ROUND_MAX_ENTRIES; /* 1920 条 */
/* 按「至少留住最近 N 轮」裁掉开头的旧条目；返回被裁掉的条数（未裁 = 0）。
   调用点：开轮追加用户消息后、落盘前、以及 app-db.js 那三处「问询窗回答 / 痕迹」写入后
   —— 全部同源到这一处，免得四个地方各留一个数字走神。 */
function agentTrimSessionMessages(st) {
  if (!st || !Array.isArray(st.messages)) return 0;
  if (st.messages.length <= AGENT_MSG_KEEP_MAX) return 0;
  const cut = st.messages.length - AGENT_MSG_KEEP_MAX;
  st.messages.splice(0, cut);
  return cut;
}
async function persistAgentSession() {
  const list = agentSessions();
  if (list.length > 60) list.splice(60);
  S.config.agentSessions = list.map((s) => ({
    id: s.id,
    title: s.title || I18n.t("新会话"),
    /* 标题真源标记：titleAuto = 这条已被引擎首轮自动命名（节点改名不再刷回模块名）；
       titleLocked = 用户亲口改过名（自动命名永久让位）。落盘并在水合时归一成布尔。 */
    titleAuto: !!s.titleAuto,
    titleLocked: !!s.titleLocked,
    workspace: s.workspace || "",
    /* 所属画布 id：随会话落盘，重启后仍归它自己那张图 */
    canvasWfId: s.canvasWfId || "",
    /* 所属应用 id：开发页按它过滤会话（不限条数、不参与 60 条截断口径）；
       空串 = 不属于任何应用（普通会话、旧存档） */
    appId: s.appId || "",
    preset: s.preset || AGENT_PRESET_DEFAULT,
    provider: s.provider || "deepseek-official",
    model: s.model || "",
    effort: s.effort || "high",
    pure: !!s.pure,
    /* 「先拷问需求（grill-me）」会话级开关（本次需求 · 会话窗口模式菜单里那一枚）：
       缺省开 —— 只有用户亲口关掉（布尔 false）才落 false；载回时归一（见 agentSessions）。 */
    grill: s.grill !== false,
    /* 「显示思考」开关（本次需求：原四档「工作步骤展示」在会话里收回成一枚开关）：
       只落「这条会话自己点过的那一态」（true / false），null = 没点过 ——
       跟随全局默认档（设置 · 智能能力 的 dsh.transcriptView）。
       重启后这条会话显不显示思考，仍由它自己说了算。 */
    showThink: typeof s.showThink === "boolean" ? s.showThink : null,
    /* 会话头部的「对话 / 轨迹 / 改动」View 选择（本次需求 · 上游把 View 选择做成持久化偏好）：
       只落「选了轨迹 / 选了改动」这两种非默认态，空串 = 对话（默认）。
       判据与 app-trajectory.js 的 VIEWS 同一份口径 —— 改动栏就是本轮新增的第三栏。 */
    trajView: s.trajView === "trace" || s.trajView === "changes" ? s.trajView : "",
    /* 开发绑定会话「不读画布」标记：必须随会话落盘 —— 重启后若丢了这一位，本轮可见集
       就与那份 session 的历史前缀不一致（网关 hx: 指纹变了 → 换 runtime 冷起 → 续跑
       撞 id 只能整轮重发），所以它与 pure 同级持久化。 */
    noCanvasRead: !!s.noCanvasRead,
    /* 「与画布无关」开关同样随会话落盘：丢了这一位，重启后可见集就与那份 session
       的历史前缀不一致（网关 nc: / hx: 指纹变化 → 换 runtime 冷起）。 */
    canvasFree: !!s.canvasFree,
    /* 「本会话不走普通会话计划这条线」：长周期任务新建窗的引导建图会话由
       app-longtask-guide.js 置位 —— 它的产物只能是长周期任务状态机图，
       宿主不再给它注入「任务流程 / 交计划块」指令，它回复里的计划块也不弹计划窗
       （判据见 app-plan.js 的 planFlowExemptSession）。随会话落盘，重启后仍豁免。 */
    noPlanFlow: !!s.noPlanFlow,
    /* 长任务环节绑定标记（app-longtask.js 的 ltBindAgentSession 写）：{wfId,runId,path}
       指向这条会话是哪个 run 的哪个环节的运行档案。与 canvasFree 同级落盘 —— 重启后
       仍认得出「这条会话归长任务所有」。缺省 null = 普通会话。 */
    ltBound:
      s.ltBound && typeof s.ltBound === "object"
        ? {
            wfId: String(s.ltBound.wfId || ""),
            runId: String(s.ltBound.runId || ""),
            path: String(s.ltBound.path || ""),
          }
        : null,
    draft: s._draft || "",
    /* 整对象落盘（含 reasoning / tools / segments），条数走**按轮保留**的那一个闸
       （见 agentTrimSessionMessages：至少留住最近 AGENT_MIN_KEEP_PER_ROUND 轮，
       过去的 messages.slice(-100) 会在一轮 8～15 条消息时把最早的助手消息挤掉 ——
       轨迹与改动两栏的数据源就是它，所以那边一裁，这里就只剩最后一轮）。
       segments 再限一次长：只夹单段字数（段一条不丢，见 agentSegsForDisk）——
       段一丢，工具 chip 就会从消息尾部压住最终回复 */
    messages: (s.messages || []).slice(-AGENT_MSG_KEEP_MAX).map((m) => {
      if (!m || !Array.isArray(m.segments) || !m.segments.length) return m;
      try {
        const segs = agentSegsForDisk(m.segments);
        const c = Object.assign({}, m);
        if (segs && segs.length) c.segments = segs;
        else delete c.segments;
        return c;
      } catch (_) {
        return m;
      }
    }),
    archived: !!s.archived,
    updatedAt: s.updatedAt || 0,
    /* 会话发送队列 + 任务清单（Todo）：重启后仍在 */
    outbox: (s.outbox || []).slice(-20).map((x) => ({
      id: x.id,
      text: String(x.text || "").slice(0, 4000),
      at: x.at || 0,
      /* 计划执行残留的元数据随条目持久化：重启后排水仍按原归属校验，
         已作废的计划任务不会因重启就退化成普通消息被自动发出 */
      _planExec: !!x._planExec || undefined,
      planRunId: x.planRunId != null ? String(x.planRunId) : undefined,
      sessionId: x.sessionId != null ? String(x.sessionId) : undefined,
    })),
    todos: (s.todos || []).slice(-80).map((x) => ({
      content: String(x.content || "").slice(0, 400),
      status: x.status || "pending",
      at: x.at || 0,
    })),
    todoHidden: (s.todoHidden || []).slice(-80).map(String),
    todosCollapsed: !!s.todosCollapsed,
    /* 会话时间区间（本次需求）不落盘：第一条 / 最后一条消息的时刻都从消息历史现推
       （agentRoundRange），重启后自然复原，无需持久键。 */
    /* 已确认的计划清单（逐项状态 + 进度指针）：重启后「计划」面板仍在，
       未完成项可从那一台会话继续跑，而不是随弹窗一起消失 */
    plan:
      typeof planSanitize === "function"
        ? planSanitize(s.plan)
        : s.plan && Array.isArray(s.plan.steps) && s.plan.steps.length
          ? s.plan
          : null,
    planDelivered: !!(s._planDelivered || s.planDelivered),
    planCollapsed: !!s.planCollapsed,
    /* 作废计数：终止 / 清除 / 归档 / 用户改口后随会话一起落盘；
       重启载回后这份会话不再点亮任何续跑入口（崩溃 / 落盘失败的窗口也不复活旧计划） */
    planDrops: Math.max(0, Number(s._planDrops) || 0),
    /* Token 消耗累计报告（按模型分别累计 + 时间），会话末尾 Badge 用它渲染 */
    tokenReport: s.tokenReport || null,
    /* 开发 / 细化绑定会话的任务书契约：发送时注入系统提示（不占用户消息位，
       首条消息只显示用户关键输入）；随会话持久化，重启后仍按契约运行 */
    devContract: s._devContract || "",
  }));
  S.config.agentActiveId = activeAgentId();
  try {
    await window.api.configSave(S.config);
  } catch {}
}
function newAgentSession() {
  const cur = agentSessionState();
  const list = agentSessions();
  const st = {
    id: uid("as"),
    title: I18n.t("新会话"),
    workspace: cur.workspace || "",
    /* 手动「新会话」= 用户此刻正在看的这张图 */
    canvasWfId: currentVisibleWfId(),
    preset: cur.preset || AGENT_PRESET_DEFAULT,
    provider: cur.provider || "deepseek-official",
    model: cur.model || "",
    effort: cur.effort || "high",
    /* 手动新建的会话照常读画布：「不读画布」是开发绑定会话专属（createDevSessionForNode 置位） */
    noCanvasRead: false,
    /* 「与画布无关」是用户手动声明档：新建会话默认关（照常读画布） */
    canvasFree: false,
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  list.unshift(st);
  S.agentActiveId = st.id;
  return st;
}
/* ── 契约会话通用装配（开发 / 细化 / 问询 / 工具·函数开发 / 长任务引导共用）──
   「专用会话」= 会话契约 `_devContract` 随每轮系统提示注入（不占用户消息位，见
   agentSessionSend 的 devContract 注入段），首轮用一条 `_src:"dev-node"` 的关键输入
   消息起轮（agentSessionSend 的 devContractMsg 分支只读它、不追加第二条用户消息）。
   过去这段装配散在 app.js / app-tools.js / app-toolbuild.js / app-devnode.js 各自实现，
   这里收成一个可复用注入点：调用方只给「标题 / 契约正文 / 首轮关键输入 / 归属画布」。

   opts = {
     title:       会话标题（专用会话的固定口径 → 置 titleLocked，首轮自动命名不再改它）,
     contract:    契约正文（整份任务书，每轮随系统提示注入；落盘字段 devContract）,
     kick:        首轮用户关键输入（那条 _src:"dev-node" 消息的正文；可空 = 首轮由调用方自己发）,
     canvasWfId:  所属画布 id（缺省 = 用户此刻看到的画布）,
     allowCanvas: 是否允许读画布（缺省 true；false = 置 noCanvasRead 走「不读画布」档）,
     workspace / provider / model / effort: 可选覆盖（缺省继承新会话默认）。
   返回新建的会话对象；起轮 / 追问一律走 agentContractRound。 */
function agentContractSession(opts) {
  opts = opts || {};
  const st = newAgentSession();
  if (String(opts.title || "").trim()) st.title = String(opts.title).trim();
  /* 标题锁死：契约会话的名字是入口的固定口径，不让首轮自动命名改成正文前 24 字 */
  st.titleLocked = true;
  st.titleAuto = false;
  st.canvasWfId = String(opts.canvasWfId || currentVisibleWfId() || "");
  /* 「允许读画布」本次会话放开（Gate A 关掉）；「与画布无关」档（Gate B）不适用于契约会话 */
  st.noCanvasRead = opts.allowCanvas === false;
  st.canvasFree = false;
  if (opts.workspace != null) st.workspace = String(opts.workspace || "");
  if (opts.provider) st.provider = String(opts.provider);
  if (opts.model != null) st.model = String(opts.model || "");
  if (opts.effort) st.effort = String(opts.effort);
  st._devContract = String(opts.contract || "");
  const kick = String(opts.kick || "").trim();
  if (kick) st.messages.push({ role: "user", content: kick, _src: "dev-node", at: Date.now() });
  return st;
}
/* 契约会话起一轮（或重新起本轮）：先落盘再发。
   空文本 + _devContract 标记 = 「按契约跑这条会话里的那条关键输入」，不追加新消息。 */
async function agentContractRound(st, opts) {
  opts = opts || {};
  if (!st || !st.id) return null;
  await persistAgentSession();
  return agentSessionSend(
    "",
    Object.assign({ _devContract: true, sessionId: st.id }, opts.send || {}),
  );
}
async function archiveAgentSession(id, archived) {
  const list = agentSessions();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  /* 防误操作:归档前确认(恢复不确认,可随时进行) */
  if (
    archived &&
    !(await confirmDialog(
      I18n.t("归档会话「") + (s.title || I18n.t("新会话")) + I18n.t("」？\n\n会话将收起到底部「已归档」区，可随时恢复。"),
      { title: I18n.t("归档会话"), okText: I18n.t("归档") },
    ))
  )
    return;
  s.archived = archived;
  /* 归档 = 这条会话不再接活：它那份计划就地作废（弹窗里就是这么承诺的），
     恢复会话后不会再冒出一份「可以继续跑」的旧清单。 */
  if (archived && s.plan) {
    try {
      if (typeof planDrop === "function") planDrop(s, "archived");
      else {
        delete s._planExec;
        s.plan = null;
      }
    } catch (_) {}
  }
  if (archived && S.agentActiveId === id) {
    const next = list.find((x) => !x.archived && x.id !== id);
    S.agentActiveId = next ? next.id : "";
    if (!next) {
      /* 全部归档:自动新建一个活动会话 */
      newAgentSession();
    }
  }
  await persistAgentSession();
  renderAgentSessionSidebar();
  renderAgentSession();
}

/* ============ 会话删除 ============
   行内「删除」不再弹确认框：点一下按钮变成高亮的「确认」并开始呼吸，再点一下才真删；
   鼠标移开按钮即恢复成「删除」（见 renderAgentSessionSidebar 的行按钮）。
   删除仍是不可撤销的危险动作，两次点击之间必须有一次真实的用户意图 ——
   比「弹窗 + 点确定」少一步，又比单击即删安全得多。 */
/* 一个会话算不算「在跑」：与列表行的「运行中」同一口径
   （sessionBusyForUi：自己那一轮 ∪ 名下计划并行组），删除前据此先兜底终止它。 */
function agentSessionBusy(s) {
  if (!s) return false;
  if (typeof sessionBusyForUi === "function") return !!sessionBusyForUi(s);
  if (typeof sessionIsRunning === "function") return !!sessionIsRunning(s);
  return !!s.running;
}
/* 摘掉画布上指向这些会话的关联：开发块除 agentSessionId 外还有一份 devSessionIds，
   得一并摘。返回受影响的节点数（便于调用方汇报，当前单条删除只关心副作用）。 */
function detachSessionsFromNodes(ids) {
  const set = new Set(ids || []);
  if (!S.wf || !set.size) return 0;
  let n = 0;
  for (const node of S.wf.nodes) {
    if (node.kind !== "agent_task" && !(node.kind === "super" && node.dev)) continue;
    let hit = false;
    if (set.has(node.agentSessionId)) {
      node.agentSessionId = "";
      hit = true;
    }
    if (node.kind === "super" && node.dev && Array.isArray(node.devSessionIds)) {
      for (let i = node.devSessionIds.length - 1; i >= 0; i--)
        if (set.has(node.devSessionIds[i])) {
          node.devSessionIds.splice(i, 1);
          hit = true;
        }
    }
    if (hit) n++;
  }
  if (n) {
    scheduleSave(true);
    renderCanvas();
  }
  return n;
}
/* 删一条会话的内核：摘节点关联 → 从列表摘掉 → 落盘 → 重绘。 */
async function deleteAgentSessionCore(id) {
  const list = agentSessions();
  const at = list.findIndex((x) => x && x.id === id);
  if (at < 0) return -1;
  /* 内嵌图回收的候选：这条会话自己引用过的图（消息 / 未发的草稿）。
     必须在摘掉之前取 —— 摘掉之后就找不到这条会话了。 */
  const imgCands =
    typeof chatImgSessionCandidates === "function"
      ? chatImgSessionCandidates(list[at])
      : [];
  /* 暂停态随会话一起消失（不指望调用方先终止过）：否则被删会话的「已暂停」行
     可能在下一次队列采集前还挂在左下角，点上去只会得到一句「会话已不存在」 */
  try {
    list[at].paused = false;
    list[at]._pausePending = false;
    list[at]._roundPaused = false;
  } catch (_) {}
  detachSessionsFromNodes([id]);
  list.splice(at, 1);
  if (S.agentActiveId === id) S.agentActiveId = (list[0] && list[0].id) || "";
  await persistAgentSession();
  /* 会话没了 = 它的内嵌图失去最后一处引用（还有别处引用就保留）：去抖回收 */
  if (imgCands.length && typeof chatImgGcSoon === "function") chatImgGcSoon(imgCands);
  renderAgentSessionSidebar();
  renderAgentSession();
  return at;
}
/* 删除前终止该会话的轮次：与「单条 ■ / 全部终止」同一口径（stopSessionRuns
   既取消自己那一轮，也逐个取消计划并行组的 runKey），否则删掉的会话还在后台跑。
   本函数只在用户已确认删除后调用，绝不静默打断。 */
function stopSessionForDelete(id) {
  try {
    if (typeof stopSessionRuns !== "function") return;
    const st = typeof agentSessionById === "function" ? agentSessionById(id) : null;
    if (!st) return;
    if (typeof sessionIsRunning === "function" && !sessionIsRunning(st)) return;
    stopSessionRuns(st, true);
  } catch (_) {}
}
/* 真删一条会话（不归档、不可恢复）：清节点引用 → 落盘 → 重绘；
   确认由行内「删除 → 确认」两次点击完成，这里只负责删。
   关联的智能任务节点保留，只断开与它的会话关联。 */
async function deleteAgentSession(id) {
  const list = agentSessions();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  /* 用户已点第二下 = 明确诉求：在跑的会话先兜底终止再删，绝不静默打断 */
  if (agentSessionBusy(s)) stopSessionForDelete(id);
  await deleteAgentSessionCore(id);
  toast(I18n.t("会话已删除：") + (s.title || I18n.t("新会话")), "ok");
}
/* ===================== dsh web composer（模型 / 命令 / 工作区 下拉） ===================== */
function closeAgentMenus() {
  /* 助手栏「模式」菜单（#assistModeMenu · 本次需求）与会话侧同族：互斥收起必须把它
     也带上，否则两只菜单会同时开着叠在输入区上。 */
  [
    "agentModelMenu",
    "agentCmdMenu",
    "agentToolsMenu",
    "agentModeMenu",
    "assistModeMenu",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}
function openAgentMenu(id) {
  closeAgentMenus();
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}
function agentModelName(st) {
  const dp = dshProvider();
  const models = dp && dp.models ? dp.models : [];
  const prov = st.provider || "deepseek-official";
  if (prov === "deepseek-official") {
    return st.model || (models[0] ? models[0] : "deepseek-flash");
  }
  const mp = mtnodePiProviders().find((x) => "mtnode_" + x.route === prov);
  const ms = (mp && mp.models) || [];
  return st.model || (ms[0] || "…");
}
function agentPresetLabel(id) {
  /* 档位真源是 app.js 的 AGENT_PRESETS，这里只负责取显示名 */
  return I18n.t(agentPresetById(id).labelKey);
}
function renderAgentComposer() {
  const st = agentSessionState();
  const mv = document.getElementById("agentModelTriggerVal");
  /* chip 只列「预设 · 模型」：思考强度不再被预设改写（历史上思维精简会自动降为 low），
     预设是什么档、思考是什么档，进菜单看即可，不必在 chip 上追加「生效档」标注 */
  if (mv)
    mv.textContent =
      (st.pure ? I18n.t("纯净") + " · " : "") + agentPresetLabel(st.preset) + " · " + agentModelName(st);
  const mt = document.getElementById("agentModelTrigger");
  if (mt) {
    mt.dataset.i18nTitle = "模型提供商 / 预设 / 模型 / 思考强度";
    mt.title = I18n.t(mt.dataset.i18nTitle);
  }
  const wv = document.getElementById("agentWsTriggerVal");
  if (wv) {
    /* 芯片显示的是「生效工作区」（手填 > 画布项目根 > 默认）：运行就按它落盘，
       不能只回显 st.workspace，否则用户会以为还在默认目录里写文件 */
    const shownWs = sessionWorkspaceShown(st);
    wv.textContent = shownWs ? wsGroupOf(shownWs) : I18n.t("选择工作区");
    /* 工作目录是「按所属画布的项目根」解析出来的，所以同一颗芯片必须同时说清
       归属是哪张图：否则用户切走画布后会看到目录没变、却不知道它跟着谁（以为串图）。 */
    const canvasShown = sessionCanvasName(st);
    const tip =
      I18n.t("生效工作目录：") +
      (shownWs || I18n.t("（默认）")) +
      "\n" +
      workspaceInfoNote(agentWorkspaceInfo(st)) +
      (canvasShown
        ? "\n" + I18n.t("所属画布：") + canvasShown
        : "") +
      "\n" +
      I18n.t("点击可改选其它目录（手填优先于画布项目根）");
    wv.title = tip;
    const wt = document.getElementById("agentWsTrigger");
    if (wt) {
      /* 同步 dataset.i18nTitle：切换语言时 I18n.apply 会重刷 title，不会退回旧文案 */
      wt.dataset.i18nTitle = tip;
      wt.title = tip;
    }
  }
  /* 会话级开关（先拷问需求 / 纯净模式 / 自动续跑）已收进「模式」菜单：chip 只留入口 +
     摘要，逐项开关态由 paintAgentModeChip 统一回显（见下方 buildAgentModeMenu）。*/
  paintGrillTag();
  /* 「与画布无关」chip 已随本次需求移除（改为按消息自动判定）：这里不再回显它。
     判据真源 = agentCanvasTurnRelated，下发点见 agentSessionSend 的 turnCanvasFree。 */
  /* 计划已产出且未在运行 → 浮现「▶ 执行计划」 */
  const rp = document.getElementById("agentRunPlanBtn");
  if (rp) rp.hidden = !(st._planDelivered && !st.running);
  paintAgentToolsChip();
  paintAgentModeChip();
}
/* 会话侧「模型提供商」那一格 / 那一页的唯一真源。
   清单 = app-agent.js 的 agentRouteGroupsNow()（DeepSeek 官方 + 已配置的其它文本服务商），
   与开发节点 · AI 调用弹层 · 助手栏「供应商」下拉同一批服务商，不另拼一份名单。 */
function agentProviderGroupsNow() {
  try {
    if (typeof agentRouteGroupsNow === "function") return agentRouteGroupsNow() || [];
  } catch (_) {}
  return [];
}
/* 当前会话的供应商：st.provider 常驻有值，空 = DeepSeek 官方路由（老会话口径） */
function agentSessionProviderRoute(st) {
  const r = String((st && st.provider) || "").trim();
  if (r) return r;
  try {
    return String(preferredAgentProviderRoute() || "").trim() || "deepseek-official";
  } catch (_) {
    return "deepseek-official";
  }
}
/* 会话侧「供应商」格的回显名（id → 服务商名；id 已不在配置里就照实显示 id） */
function agentProviderNameNow(route) {
  const r = String(route || "").trim() || "deepseek-official";
  const hit = agentProviderGroupsNow().filter((g) => g.id === r)[0];
  if (hit && hit.name) return hit.name;
  return r;
}
/* 会话菜单的格子：标签 + 当前值 + ›（根页的每一行都是它） */
function agentMenuItemCell(menu, label, value, pane) {
  const c = document.createElement("button");
  c.className = "agent-menu-cell";
  c.innerHTML =
    '<span class="agent-menu-cell-label"></span>' +
    '<span class="agent-menu-cell-value"></span><span class="agent-menu-cell-chevron">›</span>';
  c.querySelector(".agent-menu-cell-label").textContent = I18n.t(label);
  c.querySelector(".agent-menu-cell-value").textContent = value;
  c.onclick = () => { menu.dataset.pane = pane; buildAgentModelMenu(); };
  menu.appendChild(c);
  return c;
}
function buildAgentModelMenu() {
  const menu = document.getElementById("agentModelMenu");
  if (!menu) return;
  const st = agentSessionState();
  const pane = menu.dataset.pane || "root";
  menu.innerHTML = "";
  const back = () => {
    menu.dataset.pane = "root";
    buildAgentModelMenu();
  };
  if (pane === "root") {
    /* 第一格 = 模型提供商（本次需求）：所有模型选择都要有提供商选项，会话这一处
       此前只能看当前供应商、换不了（st.provider 只在没值时兜底默认路由）。
       选完提供商，第二格「模型」只列这一家的模型。 */
    agentMenuItemCell(menu, "模型提供商", agentProviderNameNow(agentSessionProviderRoute(st)), "provider");
    agentMenuItemCell(menu, "预设", agentPresetLabel(st.preset), "preset");
    agentMenuItemCell(menu, "模型", agentModelName(st), "model");
    agentMenuItemCell(menu, "思考强度", agentEffortDisplayLabel(st), "effort");
    return;
  }
  const bk = document.createElement("button");
  bk.className = "agent-menu-back";
  const backLabel =
    pane === "model"
      ? I18n.t("模型")
      : pane === "preset"
        ? I18n.t("预设")
        : pane === "provider"
          ? I18n.t("模型提供商")
          : I18n.t("思考强度");
  bk.textContent = "← " + backLabel;
  bk.onclick = back;
  menu.appendChild(bk);
  if (pane === "provider") {
    /* 供应商清单：当前这一家打 ✓。选一家 = 连模型一起拨过去（模型跟着服务商走），
       该家第一只模型成为新选择 —— 否则会留下「A 家的模型配 B 家路由」这种只到
       运行时才炸的组合。选完自动进「模型」格，接着挑具体模型。 */
    const cur = agentSessionProviderRoute(st);
    const groups = agentProviderGroupsNow();
    if (!groups.length) {
      const e = document.createElement("div");
      e.className = "agent-menu-empty";
      e.textContent = I18n.t("没有可用的模型");
      menu.appendChild(e);
      return;
    }
    for (const g of groups) {
      const on = g.id === cur;
      const opt = document.createElement("button");
      opt.className = "agent-menu-option" + (on ? " selected" : "");
      opt.innerHTML =
        '<span class="agent-menu-option-copy"><span class="agent-menu-option-name"></span></span>' +
        '<span class="agent-menu-check">' + (on ? "✓" : "") + "</span>";
      opt.querySelector(".agent-menu-option-name").textContent = g.name || g.id;
      opt.title = g.id;
      opt.onclick = () => {
        if (g.id !== cur) {
          st.provider = g.id;
          st.model = (g.models && g.models[0]) || "";
          persistAgentSession();
          renderAgentSession();
          renderAgentSessionSidebar();
        }
        menu.dataset.pane = "model";
        buildAgentModelMenu();
      };
      menu.appendChild(opt);
    }
    return;
  }
  if (pane === "preset") {
    /* 用归一后的档位 id 比较：历史会话存的旧 id（sketch）也要能正确打上 ✓ */
    const curPreset = agentPresetById(st.preset).id;
    for (const p of AGENT_PRESETS) {
      const opt = document.createElement("button");
      opt.className = "agent-menu-option" + (curPreset === p.id ? " selected" : "");
      opt.innerHTML =
        '<span class="agent-menu-option-copy"><span class="agent-menu-option-name"></span></span>' +
        '<span class="agent-menu-check">' + (curPreset === p.id ? "✓" : "") + "</span>";
      opt.querySelector(".agent-menu-option-name").textContent = I18n.t(p.labelKey);
      if (p.hint) opt.title = I18n.t(p.hint);
      opt.onclick = () => { st.preset = p.id; persistAgentSession(); closeAgentMenus(); renderAgentSession(); renderAgentSessionSidebar(); };
      menu.appendChild(opt);
    }
    return;
  }
  if (pane === "model") {
    /* 模型清单只列**当前供应商**的模型（本次需求）：供应商在上一格「模型提供商」已经定了
       （会话 st.provider 常驻有值），模型这一格再摊出别家的模型，点一下就会把供应商
       悄悄改掉 —— 用户看到的「选模型」实际是「连供应商一起换」，正是这次要修的误选。
       换供应商请走「模型提供商」那一格（它换完会把模型重置为该家第一只）。 */
    const cur = agentProviderGroupsNow().filter((g) => g.id === agentSessionProviderRoute(st))[0] || null;
    /* 会话存的供应商已不在配置里（服务商被删 / 旧会话）：不静默切到别家，
       照实说明并指向「模型提供商」那一格，让用户自己选一个存在的供应商。 */
    if (!cur) {
      const e = document.createElement("div");
      e.className = "agent-menu-empty";
      e.textContent = I18n.t("没有可用的模型");
      menu.appendChild(e);
      return;
    }
    const gh = document.createElement("div");
    gh.className = "agent-menu-group-title";
    gh.textContent = cur.name;
    menu.appendChild(gh);
    let any = 0;
    for (const m of cur.models) {
      any++;
      const opt = document.createElement("button");
      opt.className = "agent-menu-option" + (st.model === m ? " selected" : "");
      opt.innerHTML =
        '<span class="agent-menu-option-copy"><span class="agent-menu-option-name"></span></span>' +
        '<span class="agent-menu-check">' + (st.model === m ? "✓" : "") + "</span>";
      opt.querySelector(".agent-menu-option-name").textContent = m;
      opt.onclick = () => {
        st.model = m;
        persistAgentSession();
        closeAgentMenus();
        renderAgentSession();
        renderAgentSessionSidebar();
      };
      menu.appendChild(opt);
    }
    if (!any) {
      const e = document.createElement("div");
      e.className = "agent-menu-empty";
      e.textContent = I18n.t("没有可用的模型");
      menu.appendChild(e);
    }
  } else {
    /* 思考强度五档（无 / 轻 / 标准 / 强 / 最强）：选哪档就按哪档下发，路由能力不足时网关夹到
       同侧最近低档并回传 effort 事件（回显 = 下发契约），此处不再拍平。档位真源 =
       app.js 的 AGENT_EFFORT_UI_ORDER；「无」= off = 关闭思考；medium 未露出（默认 deepseek
       路由会夹到 low）。 */
    const cur = normalizeAgentEffort(st.effort);
    for (const v of AGENT_EFFORT_UI_ORDER) {
      const opt = document.createElement("button");
      opt.className = "agent-menu-option" + (cur === v ? " selected" : "");
      opt.innerHTML =
        '<span class="agent-menu-option-copy"><span class="agent-menu-option-name"></span></span>' +
        '<span class="agent-menu-check">' + (cur === v ? "✓" : "") + "</span>";
      opt.querySelector(".agent-menu-option-name").textContent = agentEffortLabelOf(v);
      opt.onclick = () => { st.effort = v; persistAgentSession(); closeAgentMenus(); renderAgentSession(); };
      menu.appendChild(opt);
    }
  }
}
/* ── 技能 chip：三级分类菜单（大类 → 类型 → 技能）──
   一级 = 工作流生成 / 提示词生成（+ 其他兜底）；二级 = 按类型（文本生成、音乐生成…）；
   三级 = 具体技能。全部 DOM 在打开时一次性构建，hover 只做同步 class 切换——
   立即出现，无任何延时/网络请求。 */
const SKILL_MENU_CATS = [
  { id: "workflow", label: "工作流生成" },
  { id: "prompt", label: "提示词生成" },
  { id: "misc", label: "其他" },
];
/* 已知内置技能的归类 [大类 id, 类型]；未知技能走关键词兜底 */
const SKILL_MENU_TAX = {
  "generate-workflow": ["workflow", "画布搭建"],
  "generate-task": ["workflow", "画布搭建"],
  "decompose-novel-plot": ["workflow", "画布搭建"],
  "mtnode-canvas-batch-safety": ["workflow", "画布规范"],
  "mtnode-canvas-edit-rules": ["workflow", "画布规范"],
  "mtnode-canvas-layout-ux": ["workflow", "画布规范"],
  "mtnode-db-facts": ["workflow", "画布规范"],
  "mtnode-ai-facts": ["workflow", "画布规范"],
  "mtnode-media-gen-nodes": ["workflow", "画布规范"],
  "mtnode-dev-architect": ["workflow", "开发架构"],
  "compose-novel-from-canvas": ["prompt", "小说写作"],
  "minimax-music-prompt": ["prompt", "音乐生成"],
  "minimax-music-lyrics": ["prompt", "音乐生成"],
  "novel-to-video-preproduction": ["prompt", "视频生成"],
};
/* 各大类内二级类型的固定顺序（未列出的按出现顺序排在后面） */
const SKILL_MENU_TYPE_ORDER = {
  workflow: ["画布搭建", "画布规范", "开发架构"],
  prompt: ["小说写作", "文本生成", "音乐生成", "视频生成", "图像生成"],
  misc: ["通用"],
};
function skillMenuClassify(s) {
  const n = String((s && s.name) || "").toLowerCase();
  const hit = SKILL_MENU_TAX[n];
  if (hit) return { cat: hit[0], type: hit[1] };
  const hay =
    n + " " + String((s && s.title) || "") + " " + String((s && s.description) || "");
  let cat = "misc";
  if (/提示词|prompt|歌词|lyric|caption|文案|写作|撰写/.test(hay)) cat = "prompt";
  else if (/画布|工作流|节点|任务|拆解|canvas|workflow|task/.test(hay)) cat = "workflow";
  let type = cat === "prompt" ? "文本生成" : cat === "workflow" ? "画布搭建" : "通用";
  if (/音乐|歌词|music/.test(hay)) type = "音乐生成";
  else if (/视频|影视|分镜|镜头|video/.test(hay)) type = "视频生成";
  else if (/图像|图片|绘图|image|文生图/.test(hay)) type = "图像生成";
  else if (/小说|正文|章节|文章|写作|文案/.test(hay)) type = "小说写作";
  else if (/开发|架构|代码|模块/.test(hay)) type = "开发架构";
  else if (/规范|排版|批量|事实/.test(hay)) type = "画布规范";
  return { cat, type };
}
function skillMenuSortTypes(catId, types) {
  const order = SKILL_MENU_TYPE_ORDER[catId] || [];
  types.sort((a, b) => {
    const ia = order.indexOf(a),
      ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return String(a).localeCompare(String(b), "zh");
  });
  return types;
}
async function buildAgentCmdMenu() {
  const menu = document.getElementById("agentCmdMenu");
  if (!menu) return;
  menu.innerHTML = "";
  let skills = [];
  try {
    skills = await loadSkillsCached(false);
  } catch {}
  const usable = (skills || []).filter(
    (s) => s && s.name && !isInstallOnlySkillName(s.name),
  );
  if (!usable.length) {
    menu.classList.remove("agent-skill-menu");
    const e = document.createElement("div");
    e.className = "agent-menu-empty";
    e.textContent = I18n.t("暂无技能");
    menu.appendChild(e);
    return;
  }
  /* 分组：cat -> type -> skills */
  const groups = new Map();
  for (const s of usable) {
    const { cat, type } = skillMenuClassify(s);
    if (!groups.has(cat)) groups.set(cat, new Map());
    const tmap = groups.get(cat);
    if (!tmap.has(type)) tmap.set(type, []);
    tmap.get(type).push(s);
  }
  const cats = SKILL_MENU_CATS.filter((c) => groups.has(c.id));
  menu.classList.add("agent-skill-menu");
  /* 三列容器 */
  const col1 = document.createElement("div");
  col1.className = "skill-col skill-col-cat";
  const col2 = document.createElement("div");
  col2.className = "skill-col skill-col-type";
  const col3 = document.createElement("div");
  col3.className = "skill-col skill-col-item";
  menu.appendChild(col1);
  menu.appendChild(col2);
  menu.appendChild(col3);
  const pickSkill = (s) => {
    const inp = document.getElementById("agentInput");
    if (inp) {
      inp.value = "/" + s.name + " ";
      inp.focus();
    }
    closeAgentMenus();
  };
  const showType = (k) => {
    col2.querySelectorAll(".skill-type").forEach((b) =>
      b.classList.toggle("on", b.dataset.key === k),
    );
    col3.querySelectorAll(".skill-pane").forEach((p) =>
      p.classList.toggle("on", p.dataset.key === k),
    );
  };
  const showCat = (catId) => {
    col1.querySelectorAll(".skill-cat").forEach((b) =>
      b.classList.toggle("on", b.dataset.cat === catId),
    );
    col2.querySelectorAll(".skill-pane").forEach((p) =>
      p.classList.toggle("on", p.dataset.cat === catId),
    );
    /* 自动展开该大类第一个类型，保证列三始终有内容 */
    const first = col2.querySelector(
      '.skill-pane[data-cat="' + catId + '"] .skill-type',
    );
    if (first) showType(first.dataset.key);
  };
  for (const c of cats) {
    const tmap = groups.get(c.id);
    const types = skillMenuSortTypes(c.id, [...tmap.keys()]);
    const count = types.reduce((n, t) => n + tmap.get(t).length, 0);
    /* 一级：大类 */
    const catBtn = document.createElement("button");
    catBtn.type = "button";
    catBtn.className = "skill-cat";
    catBtn.dataset.cat = c.id;
    catBtn.innerHTML =
      '<span class="skill-row-label"></span><span class="skill-row-count"></span><span class="skill-row-chev">›</span>';
    catBtn.querySelector(".skill-row-label").textContent = I18n.t(c.label);
    catBtn.querySelector(".skill-row-count").textContent = String(count);
    catBtn.onmouseenter = () => showCat(c.id); // hover 立即展开，无延时
    catBtn.onclick = () => showCat(c.id);
    col1.appendChild(catBtn);
    /* 二级：类型 pane（预构建） */
    const pane2 = document.createElement("div");
    pane2.className = "skill-pane";
    pane2.dataset.cat = c.id;
    col2.appendChild(pane2);
    for (const t of types) {
      const key = c.id + "\u0000" + t;
      const tb = document.createElement("button");
      tb.type = "button";
      tb.className = "skill-type";
      tb.dataset.key = key;
      tb.innerHTML =
        '<span class="skill-row-label"></span><span class="skill-row-count"></span><span class="skill-row-chev">›</span>';
      tb.querySelector(".skill-row-label").textContent = I18n.t(t);
      tb.querySelector(".skill-row-count").textContent = String(tmap.get(t).length);
      tb.onmouseenter = () => showType(key);
      tb.onclick = () => showType(key);
      pane2.appendChild(tb);
      /* 三级：技能 pane（预构建） */
      const pane3 = document.createElement("div");
      pane3.className = "skill-pane";
      pane3.dataset.key = key;
      col3.appendChild(pane3);
      const list = tmap.get(t)
        .slice()
        .sort((a, b) =>
          String(a.title || a.name).localeCompare(String(b.title || b.name), "zh"),
        );
      for (const s of list) {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "skill-item";
        opt.innerHTML =
          '<span class="agent-menu-option-copy"><span class="skill-item-name"></span><span class="skill-item-desc"></span></span>';
        opt.querySelector(".skill-item-name").textContent = s.title || s.name;
        opt.querySelector(".skill-item-desc").textContent =
          s.description || "/" + s.name;
        opt.title = "/" + s.name + (s.description ? "\n" + s.description : "");
        opt.onclick = () => pickSkill(s);
        pane3.appendChild(opt);
      }
    }
  }
  showCat(cats[0].id); // 打开即选中第一个大类
}
/* ── 「工具」chip：当前预设 + 逐工具 允许 / 询问 / 禁止 ──
   与右上角「审批 → Agent 工具」读写同一份配置（agentToolMode / setAgentToolMode），
   差别只是这里就地快切，不用开大面板。 */
function buildAgentToolsMenu() {
  const menu = document.getElementById("agentToolsMenu");
  if (!menu) return;
  ensureAgentToolPresets();
  menu.innerHTML = "";
  /* 预设行 */
  const presetRow = document.createElement("div");
  presetRow.className = "agent-tools-preset";
  const sel = document.createElement("select");
  sel.className = "agent-tools-preset-sel";
  sel.title = I18n.t("工具预设");
  const presets = (S.config.dsh && S.config.dsh.agentToolPresets) || [];
  for (const p of presets) {
    if (!p || !p.id) continue;
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name || p.id;
    if (p.id === ((S.config.dsh && S.config.dsh.agentToolPresetId) || "default"))
      o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    setAgentToolPresetId(sel.value);
    buildAgentToolsMenu();
    paintAgentToolsChip();
  };
  presetRow.appendChild(sel);
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "agent-tools-all";
  allBtn.textContent = I18n.t("全部允许");
  allBtn.title = I18n.t("把当前预设里的全部工具设为「允许」");
  allBtn.onclick = () => {
    setAllAgentToolsAllow();
    buildAgentToolsMenu();
    paintAgentToolsChip();
  };
  presetRow.appendChild(allBtn);
  menu.appendChild(presetRow);
  /* 分组清单 */
  for (const cat of agentToolCatalog()) {
    const head = document.createElement("div");
    head.className = "agent-tools-head";
    head.textContent = cat.label;
    menu.appendChild(head);
    for (const it of cat.items) {
      const row = document.createElement("div");
      row.className = "agent-tools-row";
      const meta = document.createElement("div");
      meta.className = "agent-tools-meta";
      const lab = document.createElement("div");
      lab.className = "agent-tools-lab";
      lab.textContent = it.label;
      meta.appendChild(lab);
      if (it.hint) {
        const small = document.createElement("small");
        small.textContent = it.hint;
        meta.appendChild(small);
      }
      row.appendChild(meta);
      const seg = document.createElement("div");
      seg.className = "agent-tools-toggles";
      const cur = agentToolMode(it.key);
      for (const m of ["allow", "ask", "deny"]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "agent-tools-mode agent-tools-" + m + (cur === m ? " on" : "");
        b.textContent =
          m === "allow" ? I18n.t("允许") : m === "ask" ? I18n.t("询问") : I18n.t("拒绝");
        b.onclick = () => {
          if (agentToolMode(it.key) === m) return;
          setAgentToolMode(it.key, m);
          buildAgentToolsMenu();
          paintAgentToolsChip();
        };
        seg.appendChild(b);
      }
      row.appendChild(seg);
      menu.appendChild(row);
    }
  }
  const status = document.createElement("div");
  status.className = "agent-tools-status";
  status.textContent = agentToolPresetStatusText();
  menu.appendChild(status);
}
/* chip 上的摘要：只写「工具」两字太安静，用户看不出有没有被限制 */
function paintAgentToolsChip() {
  const t = document.getElementById("agentToolsTrigger");
  if (!t) return;
  let n = 0;
  try {
    for (const cat of agentToolCatalog())
      for (const it of cat.items) if (agentToolMode(it.key) !== "allow") n++;
  } catch (_) {}
  t.classList.toggle("on", n > 0);
  t.title = agentToolPresetStatusText();
  const val = document.getElementById("agentToolsTriggerVal");
  if (val) val.textContent = n ? String(n) : "";
}
/* ── 「模式」chip 菜单：会话级开关的收纳口（与「工具」chip 同款下拉） ──
   本轮需求：原来平铺在输入区的两枚 chip（纯净模式 / 自动续跑=默认续跑）收进这一只菜单，
   输入区只留一枚「模式」入口；两个开关的语义与持久化口径一字未改：
   · 纯净模式 = st.pure（会话态，persistAgentSession 落盘，app-db.js 按它做整档闸）；
   · 自动续跑 = window.LongRun.autoOn(sid)（app-longrun.js 的会话级开关，缺省开）。
   状态回显（唯一真源）：chip 摘要看着两个开关算，菜单行「开 / 关」按同一份判据画。 */
function agentModeEntryOf(key) {
  const st = agentSessionState();
  /* 「先拷问需求（grill-me）」（本次需求 · 会话窗口模式菜单新增的一枚）：
     会话级开关，**缺省开**（st.grill 不是布尔 = 没点过 → 开；水合见 agentSessions）。
     开启 = 每一轮由模型自判这轮像不像需求，像就先加载内置技能 mtnode-grill-me、
     用 ask_user_question 一次问完整轮前沿，直到你确认无歧义才开工（契约见 GRILL_CONTRACT）。 */
  if (key === "grill") {
    const on = !(st && st.grill === false);
    return {
      key: "grill",
      label: "先拷问需求",
      hint:
        "开启 = 这条会话里每轮先自判「像不像需求」，像就先加载内置技能 mtnode-grill-me 问清整个前沿，经你确认无歧义后才动手；默认开启",
      title: on
        ? "先拷问需求：开启中，点击关闭（关闭后直接干活，不再逐轮拷问）"
        : "先拷问需求：已关闭，点击开启（像需求 / 开发的那几轮先问清再动手）",
      on,
      toggle: () => {
        st.grill = st.grill === false;
        persistAgentSession();
        renderAgentComposer();
        if (typeof renderAgentSession === "function") renderAgentSession();
      },
    };
  }
  if (key === "pure") {
    return {
      key: "pure",
      label: "纯净模式",
      hint: "纯净模式：移除全部 system prompt 与运行时上下文，仅保留联网搜索；该会话不再读写文件 / 改画布，省 token",
      on: !!st.pure,
      /* 开关 tooltip 复用已有整句词条（中英成对），不另造碎片键 */
      title: st.pure
        ? "纯净模式：开启中，点击关闭"
        : "纯净模式：移除全部 system prompt 与运行时上下文，仅保留联网搜索；该会话不再读写文件 / 改画布，省 token",
      toggle: () => {
        st.pure = !st.pure;
        persistAgentSession();
        renderAgentComposer();
        if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
      },
    };
  }
  if (key === "think") {
    /* 「显示思考」（本次需求：原四档「工作步骤展示」在会话里收回成这一枚开关）：
       点开 = 这条会话里出现模型的思考段；关闭 = **整条不显示**（不是折叠：思考段
       根本不建 DOM，见 dshHistSegEl / agentLiveSegsEl 的 showThink===false 早退）。
       关的只是显示：思考内容照旧随消息存档（msg.reasoning / msg.segments），
       随时可再打开看回来，绝不删数据。
       没点过的会话（st.showThink 还不是布尔）= 跟随全局默认档（设置 · 智能能力 的
       S.config.dsh.transcriptView：简洁档 = 不显示思考）。 */
    const cur = agentThinkShown(st);
    return {
      key: "think",
      label: "显示思考",
      hint:
        "关闭后这条会话里整条不显示模型的思考（不是折叠，是真的不出现）；" +
        "思考内容仍随消息存档，随时可再打开",
      on: cur,
      title: cur
        ? "显示思考：开启中，点击隐藏这条会话里的模型思考（整条不显示）"
        : "显示思考：已关闭，点击重新显示这条会话里的模型思考",
      /* 落点式写入：把**点击那一刻**决定的开关态写进会话并当场重绘。
         与 toggle 分开是为了菜单行：行是构建时算下的快照，菜单又不关，
         用户连点第二下时 toggle 里那个旧 on 会再写同一个值（看着像没反应）——
         所以行那边先按**当前**态重算目标，再用它调 set。 */
      set(on) {
        const s = agentSessionState() || st;
        s.showThink = !!on;
        persistAgentSession();
        renderAgentComposer();
        /* 开关当场生效：会话视图整体重绘一次（历史与 live 同一判据） */
        if (typeof renderAgentSession === "function") renderAgentSession();
      },
      /* 点一下 = 取反（构建时算好的 cur；连点时调用方先按当前态重算，见 onPick） */
      toggle() {
        this.set(!cur);
      },
      /* 「点这一行」的落点（菜单行走它，而不是走快照上的 toggle）：
         按**点击那一刻**的开关态取反 —— 菜单点完不关，连点第二下必须真的翻回去。 */
      onPick() {
        this.set(!agentThinkShown(agentSessionState() || st));
      },
    };
  }
  /* 助手栏的两枚开关（本次需求：助手栏也加一枚「模式」菜单，与会话侧共用同一套构件）：
     真源是全局偏好 S.assistGrill / S.assistPure（随配置落盘，见 persistAssistUi），
     与「助手侧·与画布无关」同族 —— 助手没有会话档案，偏好只能落在全局配置上。 */
  if (key === "assistGrill") {
    const on = S.assistGrill !== false;
    return {
      key: "assistGrill",
      label: "先拷问需求",
      hint:
        "开启 = 助手栏每轮先自判「像不像需求」，像就先加载内置技能 mtnode-grill-me 问清整个前沿，经你确认无歧义后才动手；默认开启",
      title: on
        ? "先拷问需求：开启中，点击关闭（关闭后助手直接干活，不再逐轮拷问）"
        : "先拷问需求：已关闭，点击开启（像需求 / 开发的那几轮先问清再动手）",
      on,
      onPick() {
        S.assistGrill = !(S.assistGrill !== false);
        persistAssistUi();
        renderAssistPanel();
      },
      toggle() {
        S.assistGrill = !(S.assistGrill !== false);
        persistAssistUi();
        renderAssistPanel();
      },
    };
  }
  if (key === "assistPure") {
    const on = !!S.assistPure;
    return {
      key: "assistPure",
      label: "纯净模式",
      hint:
        "纯净模式：移除全部 system prompt 与运行时上下文，仅保留联网搜索；助手这条不再读写文件 / 改画布，省 token",
      title: on
        ? "纯净模式：开启中，点击关闭（助手栏这条不再读写文件 / 改画布）"
        : "纯净模式：移除全部 system prompt 与运行时上下文，仅保留联网搜索；助手这条不再读写文件 / 改画布，省 token",
      on,
      onPick() {
        S.assistPure = !S.assistPure;
        persistAssistUi();
        renderAssistPanel();
      },
      toggle() {
        S.assistPure = !S.assistPure;
        persistAssistUi();
        renderAssistPanel();
      },
    };
  }
  return {
    key: "auto",
    label: "自动续跑",
    hint: "本轮完成且目标未达成、还有下一步时自动接着跑（不打断你，随时可关）",
    on: agentAutoOnNow(),
    title: agentAutoOnNow()
      ? "自动续跑：本轮完成且目标未达成、还有下一步时自动接着跑（不打断你，随时可关）"
      : "自动续跑已关闭：本轮跑完就停，等你下一条消息",
    toggle: () => {
      try {
        if (window.LongRun && typeof window.LongRun.toggleAuto === "function") window.LongRun.toggleAuto();
      } catch (_) {}
      renderAgentComposer();
    },
  };
}
function agentModeEntries() {
  /* 顺序 = 菜单里的行序（先拷问需求 / 纯净模式 / 自动续跑 / 显示思考）。
     本次需求把「先拷问需求（grill-me）」放在第一位：它是这条会话最常改的一枚，
     默认又是开的（用户一进来看菜单就知道这轮会不会被追问）。
     「显示思考」是原四档「工作步骤展示」在会话里收回来的：点开 = 会话里出现思考，
     关闭 = 整条不显示（不是折叠）。全局默认档仍在 设置 · 智能能力 里改。 */
  return [
    agentModeEntryOf("grill"),
    agentModeEntryOf("pure"),
    agentModeEntryOf("auto"),
    agentModeEntryOf("think"),
  ];
}
/* 助手栏「模式」菜单的行（本次需求）：与会话侧**同一套构件、同一份词条**，
   只是开关的真源换成全局偏好（见 agentModeEntryOf 的 assistGrill / assistPure 两支）。 */
function assistModeEntries() {
  return [agentModeEntryOf("assistGrill"), agentModeEntryOf("assistPure")];
}
/* 按 key 现取（点完开关要拿刷新后的 on / title，不能拿点击瞬间那一份旧快照）
   entries 缺省 = 会话侧那四枚；助手栏的行传 assistModeEntries。 */
function agentModeEntryByKey(key, entries) {
  const list = typeof entries === "function" ? entries() : entries || agentModeEntries();
  return list.filter((e) => e.key === key)[0] || null;
}
/* 自动续跑开关态：唯一真源在 app-longrun.js（缺省开）。模块还没挂 / 老页面 = 按开处理。 */
function agentAutoOnNow() {
  try {
    if (window.LongRun && typeof window.LongRun.autoOn === "function") {
      const s = agentSessionState();
      return !!window.LongRun.autoOn(s && s.id);
    }
  } catch (_) {}
  return true;
}
/* 「工具」菜单里的三态按钮构件，这里借来当开关：亮 = .on（同 .agent-tools-row 观感）。
   本轮需求：① 键面从「✓ / — 两个字符」换成真开关（滑块 + 槽），整块 44×26 都可点 ——
   原先的字符按钮只有约 20px 高、字符本身才几个像素，用户反馈「不容易点到 hit box」；
   ② 键面里不再写任何文字（开关态由滑块位置与配色表达），也就不存在「内容顶宽」问题，
   开 / 关的可读副本仍在 tooltip 与 chip 摘要上。 */
function agentModeToggleBtn(entry) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "agent-tools-toggle" + (entry.on ? " on" : "");
  b.dataset.modeKey = entry.key;
  b.setAttribute("role", "switch");
  b.setAttribute("aria-checked", entry.on ? "true" : "false");
  /* 视觉件：槽（.agent-mode-track）+ 滑块（::after）。不带文字，纯 CSS 画。 */
  const track = document.createElement("span");
  track.className = "agent-mode-track";
  track.setAttribute("aria-hidden", "true");
  b.appendChild(track);
  return b;
}
function paintAgentModeToggleBtn(entry, menuId) {
  const b = document.querySelector(
    "#" + (menuId || "agentModeMenu") + ' [data-mode-key="' + entry.key + '"]',
  );
  if (!b) return;
  b.classList.toggle("on", !!entry.on);
  /* 键面只留开关本体：清掉任何可能残留在按钮里的文本节点（老版本写过 ✓ / —） */
  for (const n of Array.from(b.childNodes))
    if (n.nodeType === 3) b.removeChild(n);
  b.title = I18n.t(entry.title || entry.hint);
  /* role=switch 的读屏口径就是 aria-checked 一项，不再重复挂 aria-pressed */
  b.setAttribute("aria-checked", entry.on ? "true" : "false");
}
/* 会话「模式」菜单（#agentModeMenu）。
   本次需求：助手栏也加一枚「模式」菜单（#assistModeMenu）——同一份构件、同一套处置，
   只是行集与 chip 换一套：entries 缺省 = 会话侧四枚，助手栏传 assistModeEntries。 */
function buildAgentModeMenu(menuId, entries, chipPainter) {
  const menu = document.getElementById(menuId || "agentModeMenu");
  if (!menu) return;
  const rows = typeof entries === "function" ? entries() : entries || agentModeEntries();
  const paintChip = typeof chipPainter === "function" ? chipPainter : paintAgentModeChip;
  menu.innerHTML = "";
  for (const entry of rows) {
    const row = document.createElement("div");
    row.className = "agent-tools-row as-btn";
    /* 整行可点（本次需求 · 用户报障「模式菜单里的开关点不动」）：
       行里的标签 / 说明那几个字才是用户眼里那一行，而它们历史上没有任何点击处理，
       只有最右边那枚 44×26 的开关吃点击（命中测试实测：点标签 / 说明时命中的是
       .agent-tools-meta，什么都不会发生）。所以把点整行与点开关归到同一件事上。 */
    const meta = document.createElement("div");
    meta.className = "agent-tools-meta";
    const lab = document.createElement("div");
    lab.className = "agent-tools-lab";
    lab.textContent = I18n.t(entry.label);
    meta.appendChild(lab);
    if (entry.hint) {
      const small = document.createElement("small");
      small.textContent = I18n.t(entry.hint);
      meta.appendChild(small);
    }
    row.appendChild(meta);
    const btn = agentModeToggleBtn(entry);
    row.appendChild(btn);
    /* 整行与开关共用的提示文案（现算，**不写 data-i18n-title**：那份词条会被
       I18n.applyDom 在下次切语言时整句覆盖成静态文案，同一行就只剩四个字，
       连"点完会变成什么"都读不出来；chip 的 title 也是这么处理的）。
       开关键面里不写字，所以「当前开关态 + 点完会怎样」只有这一处可读 —— 开关与整行都要挂。 */
    const paintRowTitle = (e) => {
      const tip = I18n.t(e.title || e.hint);
      const rowTip = tip + "\n" + I18n.t("点击整行也可切换");
      btn.title = tip;
      row.title = rowTip;
    };
    paintRowTitle(entry);
    /* 点击处置只有一份：点开关、点标签、点说明、按回车 / 空格都走它。
       btn 自己不再单独挂 onclick —— 冒泡上来的那一次就够（挂两处 = 点开关切两档）。 */
    const flip = () => {
      /* 「点一下」的处置归 entry 自己（点开关、点标签、点说明、按回车 / 空格都走它）：
         · 「显示思考」= 按**点击那一刻**的开关态取反再落点写入 —— `entry` 是构建
           菜单时的快照，菜单点完又不关，沿用快照里那个旧 on 的话，用户连点第二下会
           再写回同一个值，看着就是「点了没变化」（本次报障的另一面）；
         · 其它开关（纯净模式 / 自动续跑）= 原来的 toggle。
         entry 上没这一项（老页面 / 外部构件）就退回 toggle，行为与从前一致。 */
      if (typeof entry.onPick === "function") entry.onPick();
      else entry.toggle();
      /* 重画用的条目必须是**切换后**的：旧快照的 on / title 还停在点击前 */
      const fresh = agentModeEntryByKey(entry.key, rows) || entry;
      /* 提示文案带「开启中 / 已关闭」这类随状态变的字，就地按刷新后的条目重挂一份。
         顺序：先让两枚开关 / 键面的重画各写各的，最后再落这一份提示 —— 反过来的话
         paintAgentModeToggleBtn / paintChip 会把这里刚写的开关 title 覆盖掉。 */
      paintAgentModeToggleBtn(fresh);
      if (paintChip) paintChip();
      paintRowTitle(fresh);
    };
    row.onclick = () => {
      /* 点开关与点标签 / 说明走同一条路：开关自己不挂 onclick，点击冒泡到这里
         一次算一档（两边都挂 = 点一下切两档）。 */
      flip();
    };
    /* 整行可点 → 键盘也要能按（role / tabindex / Enter / 空格，空格防翻页） */
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.onkeydown = (ev) => {
      const k = ev && ev.key;
      if (k !== "Enter" && k !== " " && k !== "Spacebar") return;
      /* 只有焦点在整行上时才算这一档（开关自己不是焦点落点，行内其它节点若哪天
         变成可聚焦件，回车 / 空格归它们自己处理，冒泡上来不重复计数） */
      if (ev.target && ev.target !== row) return;
      if (ev.preventDefault) ev.preventDefault();
      flip();
    };
    menu.appendChild(row);
  }
  const status = document.createElement("div");
  status.className = "agent-tools-status";
  status.textContent = I18n.t(
    menuId === "assistModeMenu"
      ? "以上开关都只作用于右侧助手栏，随时可改"
      : "以上开关都只作用于当前会话，随时可改",
  );
  menu.appendChild(status);
}
/* chip 摘要（数据口径）：已开的开关名，空串 = 全关。仍给 tooltip 与外部读用。
   注意：这里列的是「开关处于开态」的项（与各项自己的默认值无关）—— 加新开关时
   不必来这里改口径，逐项标签自动跟上（见 agentModeEntries）。 */
function agentModeChipSummary() {
  const on = agentModeEntries()
    .filter((e) => e.on)
    .map((e) => I18n.t(e.label));
  return on.join(" · ");
}
/* chip 回显（本轮需求）：chip 键面**只写「模式」两个字**，开了什么不再写进按钮 ——
   往按钮里塞摘要会把这一枚顶宽，进而把右边几枚挤出界（用户报障）。开着的开关只由
   两处表达：① chip 变主题蓝（.on）；② tooltip 里逐项「（开）/（关）」。 */
function paintAgentModeChip() {
  const t = document.getElementById("agentModeTrigger");
  if (!t) return;
  const entries = agentModeEntries();
  for (const e of entries) paintAgentModeToggleBtn(e);
  /* 会话侧 chip 重绘顺带刷一次助手栏那一枚（切换会话 / 切语言 / 自动续跑态变化都会走到这里，
     助手栏没有自己的重绘总线）—— 两边行集不同，各画各的，互不覆盖。 */
  paintAssistModeChip();
  paintGrillTag();
  const summary = agentModeChipSummary();
  t.classList.toggle("on", !!summary);
  /* 摘要 span 留在 DOM 里兼容外部读，但永不显示（写入 → 直清 + hidden） */
  const val = document.getElementById("agentModeTriggerVal");
  if (val) {
    val.textContent = "";
    val.hidden = true;
  }
  /* tooltip 逐项回显：「显示思考」这枚开关与纯净模式 / 自动续跑用同一份口径，
     加开关不必再来这里补一行（原来写死 pure + auto，新开关进不了提示）。 */
  const mark = (e) => I18n.t(e.label) + I18n.t(e.on ? "（开）" : "（关）");
  /* 动态 title：切语言后由 renderAgentComposer（I18n.applyDom 之后的重绘）重算 */
  delete t.dataset.i18nTitle;
  t.title = I18n.t("模式：") + entries.map(mark).join(" / ");
}
/* 会话头部的「拷问需求」小字标记（本次需求 · 用户口径：这一轮到底会不会被拷问，
   要能一眼看见）：开 = 显示，关 = 收起。挂在输入区上方那一排 chip 里（.agent-chip），
   与会话头部同一处观感；文案与模式菜单里那一行共用一份词条。 */
function paintGrillTag() {
  const el = document.getElementById("agentGrillTag");
  if (!el) return;
  const s = agentSessionState();
  const on = !(s && s.grill === false);
  el.hidden = !on;
  el.textContent = I18n.t("拷问需求");
  el.title = I18n.t(
    "先拷问需求：开启中 —— 这条会话里像需求 / 开发的那几轮会先用询问窗问清，经你确认无歧义后才动手",
  );
}
/* 助手栏「模式」chip 回显（本次需求）：与会话侧同款 —— 键面只写「模式」两个字，
   开着的开关由 chip 变色（.on）+ tooltip 逐项「（开）/（关）」表达。 */
function paintAssistModeChip() {
  const t = document.getElementById("assistModeTrigger");
  if (!t) return;
  const entries = assistModeEntries();
  for (const e of entries) paintAgentModeToggleBtn(e, "assistModeMenu");
  const anyOn = entries.some((e) => e.on);
  t.classList.toggle("on", anyOn);
  const mark = (e) => I18n.t(e.label) + I18n.t(e.on ? "（开）" : "（关）");
  delete t.dataset.i18nTitle;
  t.title = I18n.t("模式：") + entries.map(mark).join(" / ");
}

function setView(view) {
  S.view = view;
  const wf = $("#btnToolWf");
  const ag = $("#btnToolAgent");
  const tm = $("#btnTeam");
  if (wf) wf.classList.toggle("on", view === "workflow");
  if (ag) ag.classList.toggle("on", view === "agent");
  if (tm) tm.classList.toggle("on", view === "team");
  const wrap = $("#wfWrap");
  const pane = $("#agentPane");
  const team = $("#teamPane");
  if (wrap) wrap.style.display = view === "workflow" ? "" : "none";
  if (pane) pane.style.display = view === "agent" ? "" : "none";
  if (team) team.style.display = view === "team" ? "" : "none";
  /* 视图互斥：画布 / 智能会话 / 团队各有自己的左侧栏，彼此不得出现。
     - 画布视图：可用 #sidebar（节点/绘图/超级节点列表），会话与团队列表不可展开
     - 会话视图：自带 .agent-side（会话列表），画布 #sidebar 强制收起
     - 团队视图：自带 .team-side（项目 / 专家 / 会话三段列表），画布 #sidebar 强制收起
     统一由 applySidebarVisibility() 收口 + body.view-* 类做 CSS 硬闸。 */
  document.body.classList.toggle("view-agent", view === "agent");
  document.body.classList.toggle("view-team", view === "team");
  document.body.classList.toggle("view-workflow", view === "workflow");
  if (typeof applySidebarVisibility === "function") applySidebarVisibility();
  S.config.view = view;
  window.api.configSave(S.config).catch(() => {});
  if (view === "agent") {
    /* 打开会话时自动隐藏右侧全局助手栏（不持久化：回到画布仍按用户偏好） */
    setAssistOpen(false, false);
    /* 全局搜索浮层（Ctrl+F）不随视图切换关闭：它跨区域搜索，切视图正是它的用途之一 */
    renderAgentSession();
    const inp = $("#agentInput");
    if (inp) inp.focus();
  } else if (view === "team") {
    /* 团队视图同样收掉右侧全局助手栏：右栏留给专家聊天区（不持久化） */
    setAssistOpen(false, false);
    if (typeof renderTeamPane === "function") renderTeamPane();
  } else {
    renderCanvas();
  }
  renderSidebar();
  renderStatus();
}

/* 供应商目录(pi-ai 目录 + DeepSeek 官方),懒加载一次 */
let _catalogPromise = null;
function ensureProviderCatalog() {
  if (!_catalogPromise) {
    _catalogPromise = window.api
      .dshProviderCatalog()
      .then((r) => {
        S.providerCatalog = {
          deepseek:
            r && r.deepseek
              ? r.deepseek
              : [
                  {
                    id: "deepseek-flash",
                    name: "DeepSeek-V4.1-Flash",
                    input: ["text", "image"],
                  },
                  {
                    id: "deepseek-v4-pro",
                    name: "DeepSeek-V4-Pro",
                    input: ["text"],
                  },
                ],
          piai: (r && r.piai) || [],
        };
        return S.providerCatalog;
      })
      .catch(() => {
        S.providerCatalog = {
          deepseek: [
            {
              id: "deepseek-flash",
              name: "DeepSeek-V4.1-Flash",
              input: ["text", "image"],
            },
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek-V4-Pro",
              input: ["text"],
            },
          ],
          piai: [],
        };
        return S.providerCatalog;
      });
  }
  return _catalogPromise;
}

/* 工具结果 → 可读文本(terminal 块给 mono 原文,其余取 text) */
function toolResultText(t) {
  const blocks = Array.isArray(t.result) ? t.result : [];
  if (t.error) {
    const e = t.error;
    const bits = [];
    if (e.name) bits.push(String(e.name));
    if (e.code) bits.push(String(e.code));
    const head = bits.length ? bits.join(" ") : I18n.t("未知错误");
    const msg = e.message || e.detail || (e.cause && e.cause.message) || "";
    return (
      I18n.t("错误:") +
      head +
      (msg ? "\n" + String(msg) : "")
    );
  }
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b.text !== "string") continue;
    if (b.type === "terminal") parts.push(I18n.t("── 终端输出 ──\n") + b.text);
    else parts.push(b.text);
  }
  return parts.join("\n\n").trim();
}

/* ── 工具按钮后面那截「这一步到底干了什么」──
 * 会话 / 助手 / 节点绑定会话 / 团队会话 / 计划面板共用同一份（统一出口 dshToolHintEl）：
 *   · shell 工具（pwsh / bash…）→ 命令正文，绿色；
 *   · grep / glob（检索）→「路径 <位置（黄）> · 目标 <绿> · 其余参数（灰，参数名转词条）」。
 * 抽不出（read / edit 这类）就返回 null，调用方什么都不挂。 */
function dshIsShellTool(name) {
  return /^(pwsh|powershell|bash|shell|sh|zsh|cmd)(\.exe)?$/.test(
    String(name || "").trim().toLowerCase(),
  );
}
/* 检索工具：网关可能给 grep / Grep / rg。逐字判，不做前缀匹配（不把「grepall」这类当检索） */
function dshIsGrepTool(name) {
  return /^(grep|rg|ripgrep)(\.exe)?$/.test(String(name || "").trim().toLowerCase());
}
/* 文件名检索：glob。同样逐字判（不把「globall」这类当它） */
function dshIsGlobTool(name) {
  return /^glob(\.exe)?$/.test(String(name || "").trim().toLowerCase());
}
/* grep / glob 都是「在一堆文件里找东西」，共用同一行「在哪找 · 找什么 · 怎么找」的读法 */
function dshIsSearchTool(name) {
  return dshIsGrepTool(name) || dshIsGlobTool(name);
}
function dshToolArgsObj(t) {
  let a = t && t.args;
  if (typeof a === "string") {
    const s = a.trim();
    if (s.charAt(0) !== "{") return null;
    try {
      a = JSON.parse(s);
    } catch (_) {
      return null;
    }
  }
  return a && typeof a === "object" ? a : null;
}
/* 显示的截断长度 = 100 字：命令正文一超过 100 字就由 JS 直接截断收尾（不再等 CSS 按行宽算），
   保证工具条那一行绝不出现第二行、也绝不把字符顶出容器；100 字以内的短命令原样整条显示。
   与 title 同一档（hover 全文也只留这 100 字），别把整页正文塞进一个 DOM 节点 / title 属性。
   grep / glob 的检索摘要共用这一档预算（dshClampSegs 逐段砍）。 */
const DSH_TOOL_CMD_MAX = 100;
function dshToolCmdInfo(t) {
  if (!t || !dshIsShellTool(t.name)) return null;
  let cmd = typeof t.cmd === "string" ? t.cmd : "";
  let desc = typeof t.desc === "string" ? t.desc : "";
  if (!cmd || !desc) {
    const a = dshToolArgsObj(t);
    if (a) {
      if (!cmd && typeof a.command === "string") cmd = a.command;
      if (!desc && typeof a.description === "string") desc = a.description;
    }
  }
  cmd = String(cmd).replace(/\s+/g, " ").trim();
  desc = String(desc).replace(/\s+/g, " ").trim();
  if (!cmd) return null;
  return { cmd, desc };
}
function dshToolCmdEl(t) {
  const info = dshToolCmdInfo(t);
  if (!info) return null;
  const el = document.createElement("span");
  el.className = "dsh-tool-cmd";
  el.textContent =
    info.cmd.length > DSH_TOOL_CMD_MAX
      ? info.cmd.slice(0, DSH_TOOL_CMD_MAX) + "…"
      : info.cmd;
  /* hover 先给 description（模型写的「这条命令干什么」，存在才有），再给完整命令 */
  el.title = (info.desc ? info.desc + "\n" : "") + info.cmd.slice(0, DSH_TOOL_CMD_MAX);
  return el;
}

/* 计划面板专用搬运：live 记录里那份 args 串会被截断，先把检索工具（grep / glob）的字符串参数原样留一份。
   只留 pattern / path / include 三个真实存在的参数（别把 write 的整篇正文搬进 live 缓冲）。 */
function dshGrepLiveStash(a) {
  if (!a || typeof a !== "object") return null;
  const out = {};
  for (const k of ["pattern", "path", "include"]) {
    if (typeof a[k] === "string" && a[k]) out[k] = a[k];
  }
  return Object.keys(out).length ? out : null;
}

/* 入参里的换行 / 制表符压成一行（换行脚本不能把工具条撑成多行） */
function dshOneLine(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

/* grep 入参名 → 中文词条（en 界面由 i18n.js 的英文表接手）；表外的键返回 ""，
   调用方按原名原样显示 —— 宁可露出 include，也不自己编一个看不懂的标签。 */
function dshGrepArgLabel(key) {
  switch (String(key || "")) {
    case "include":
      return I18n.t("包括");
    case "exclude":
      return I18n.t("排除");
    case "glob":
      return I18n.t("通配");
    case "type":
      return I18n.t("类型");
    case "output_mode":
      return I18n.t("输出模式");
    case "multiline":
      return I18n.t("多行");
    case "ignore_case":
      return I18n.t("忽略大小写");
    case "head_limit":
      return I18n.t("条数上限");
    case "offset":
      return I18n.t("偏移");
    case "context":
      return I18n.t("上下文");
    default:
      return "";
  }
}

/* grep / glob 一行读成「在哪找 · 找什么 · 怎么找」：
 *   · 目标路径（path）黄色、排在最前 = 先定位置（黄 ≠ 文件徽标的青：这段是检索范围，不是「读了某个文件」）；
 *   · 检索目标（pattern）绿色排在路径后面（= 这条检索命令真正要干的活：grep 是「匹配什么正文」，
 *     glob 是「通配哪些文件」），后面不再重复出现路径；
 *   · 其余参数（include 这类）参数名转 i18n 词条，值原样，顺序排在最后；
 *   · 入参可能是对象（网关原样下发）或 JSON 串（计划面板那份被截断过，parse 不到）；
 *     计划面板另有 planLiveFeed 原样留的一份 gargs，两条路都收。
 * 路径在这一行里只出现这一次：同一路径的文件徽标由调用方按 info.path 跳过（dshToolHintSkipPath）。 */
function dshToolGrepInfo(t) {
  if (!t || !dshIsSearchTool(t.name)) return null;
  const isGlob = dshIsGlobTool(t.name);
  const a =
    dshToolArgsObj(t) || (t.gargs && typeof t.gargs === "object" ? t.gargs : null) || {};
  const pat = dshOneLine(a.pattern);
  const path = dshOneLine(a.path);
  const opts = [];
  for (const k of Object.keys(a)) {
    if (k === "pattern" || k === "path" || k === "description") continue;
    const v = a[k];
    if (v === true) {
      opts.push(dshGrepArgLabel(k) || k);
      continue;
    }
    if (v === false || v == null || v === "") continue;
    /* 复杂值（数组 / 对象）不塞进这一行：宁可少显一个，也不显 "[object Object]" */
    if (typeof v !== "string" && typeof v !== "number") continue;
    opts.push((dshGrepArgLabel(k) || k) + " " + dshOneLine(v));
  }
  const segs = [];
  if (path) segs.push({ label: I18n.t("路径"), value: path, cls: "dsh-tool-grep-path" });
  /* glob 的 pattern 是「通配哪些文件」，grep 的是「匹配什么正文」—— 同一个字段，两种称呼 */
  if (pat)
    segs.push({
      label: I18n.t(isGlob ? "通配" : "匹配"),
      value: pat,
      cls: "dsh-tool-grep-pat",
    });
  if (opts.length) segs.push({ label: "", value: opts.join(" · "), cls: "dsh-tool-grep-opt" });
  /* 没目标也没路径 = 这一行读不出「在找什么 / 在哪找」，只剩参数没有意义 → 不挂 */
  if (!pat && !path) return null;
  return {
    segs,
    path,
    glob: isGlob,
    desc: dshOneLine(a.description),
    line: segs.map((s) => (s.label ? s.label + " " + s.value : s.value)).join(" · "),
  };
}

/* 按总字数预算逐段截断（与 shell 命令同一档 DSH_TOOL_CMD_MAX，也就是「整行」——
   平时根本不到这一档，只有超长正文才需要这道兜底）：
   靠前的段优先，被截断的那一段带省略号；CSS 再按真实行宽 max-width + ellipsis 收一层。 */
function dshClampSegs(segs, max) {
  const out = [];
  let left = max;
  for (const s of segs) {
    if (left <= 0) break;
    const text = String(s.text == null ? "" : s.text);
    if (!text) continue;
    if (text.length <= left) {
      out.push({ cls: s.cls, text: text });
      left -= text.length;
      continue;
    }
    out.push({ cls: s.cls, text: text.slice(0, Math.max(1, left - 1)) + "…" });
    left = 0;
  }
  return out;
}

function dshToolGrepEl(t) {
  const info = dshToolGrepInfo(t);
  if (!info) return null;
  const el = document.createElement("span");
  /* 几何沿用 .dsh-tool-cmd（一行 / 截断 / 宽度上限 / 计划面板收窄那一档），
     颜色分档交给 .dsh-tool-grep-* 三条 —— glob 与 grep 同一套分色（路径黄 / 目标绿 / 参数灰） */
  el.className = "dsh-tool-cmd dsh-tool-grep" + (info.glob ? " dsh-tool-glob" : "");
  /* 这一行已经把目标路径写在最前面了：把原样路径挂到 dataset，调用方据此跳过
     同一路径的文件徽标 —— 同行里同一个路径不再出现第二次（路径只显这一处，黄色）。 */
  if (info.path) el.setAttribute("data-tool-path", info.path);
  if (info.glob) el.setAttribute("data-tool-kind", "glob");
  const flat = [];
  info.segs.forEach((s, i) => {
    const pre = i ? " · " : "";
    if (s.label) flat.push({ cls: "dsh-tool-grep-k", text: pre + s.label });
    flat.push({ cls: s.cls, text: (s.label ? " " : pre) + s.value });
  });
  for (const p of dshClampSegs(flat, DSH_TOOL_CMD_MAX)) {
    const sp = document.createElement("span");
    sp.className = p.cls;
    sp.textContent = p.text;
    el.appendChild(sp);
  }
  /* hover：先给模型写的 description（这一步在干什么，存在才有），再给未截断的完整一行
     （与命令行正文同一档：title 上限就是那个兜底常量，纯粹是别把整页正文塞进一个属性里） */
  el.title = (info.desc ? info.desc + "\n" : "") + info.line.slice(0, DSH_TOOL_CMD_MAX);
  return el;
}

/* 统一出口：shell 命令正文 / grep · glob 检索摘要，都没有就 null */
function dshToolHintEl(t) {
  return dshToolCmdEl(t) || dshToolGrepEl(t);
}

/* 摘要里已经带着的路径（grep / glob 那一行最前面那段黄色路径）→ 交给 dshToolFileBadges 跳过，
   同一个路径不在后面再挂一枚徽标（「路径出现了两次」就是把这两处都画了出来）。 */
function dshToolHintSkipPath(hintEl) {
  if (!hintEl || !hintEl.getAttribute) return null;
  const p = hintEl.getAttribute("data-tool-path");
  return p ? [p] : null;
}

/* ── 工具卡片（本次需求 · 对齐上游 dsh-client-ui-tool 的 ToolRow）─────────────
 * 上游一行读成「<图标> <标题> · <摘要> …」：
 *   · 标题按工具族固定（读取 / 写入 / 编辑 / 运行命令 / 搜索文件内容 / 查找文件 /
 *     网页搜索 / 网页获取 / 读取图片 / 工具调用），文案取自上游 conversation 命名空间的
 *     tool.title.* 词条（dsh-client-ui-conversation/lib/client.js:14773-14789）；
 *   · 摘要复用本仓既有的命令正文（dshToolCmdEl）与检索摘要（dshToolGrepEl）；
 *   · 后面跟 diff 统计（+N / -M，hover 才着色）与失败 / 停止摘要（上游 errorSummary /
 *     stoppedSummary 用 error / warn 语义色）。
 * 生命周期状态（上游 ToolRowState = preparing | running | ok | error | stopped）：
 *   · preparing：工具参数还在流进来（网关的 tool-preparing，见 gateway.mjs 的 toolPrepAcc），
 *     标题旁显示「正在准备内容 N KB」（上游 write/edit 准备态同款文案）；
 *   · running：已派发未回结果 —— 只有药丸边框一道低调呼吸灯（上游 TextShimmer 的底色扫光太闪，已撤）；
 *   · ok / error / stopped：静态行，失败与停止各给一句摘要。
 * 图标沿用本仓既有的字符风格（🔧 / ◌）：新增的图标族只在标题里体现，不引外部图集。 */
const DSH_TOOL_TITLE_RULES = [
  [/^(read|read_file|readfile)(\.exe)?$/i, "读取"],
  [/^(read_image|readimage)$/i, "读取图片"],
  [/^(write|write_file|create_file)(\.exe)?$/i, "写入"],
  [/^(edit|edit_file|str_replace_editor|apply_patch)(\.exe)?$/i, "编辑"],
  [/^(pwsh|powershell|bash|shell|sh|zsh|cmd)(\.exe)?$/i, "运行命令"],
  [/^(grep|rg|ripgrep)(\.exe)?$/i, "搜索文件内容"],
  [/^glob(\.exe)?$/i, "查找文件"],
  [/^(web_search|websearch)$/i, "网页搜索"],
  [/^(web_fetch|webfetch)$/i, "网页获取"],
  [/^todo_write$/i, "更新计划"],
  /* 顺序即优先级：派生（fork）排在裸 subagent 之前，否则 subagent_fork 会被
     裸名那条正则挡住（非 dsh 表里的「派生子智能体」永远轮不到）。 */
  [/^(subagent_fork|agent_task)$/i, "派生子智能体"],
  [/^subagent$/i, "子智能体"],
  [/^mtnode_vision$/i, "读取图片"],
  /* ── 非 dsh 工具（本次需求）──────────────────────────────────────────────
     上面那些是 dsh 引擎自带的工具族；下面这批不是引擎自带的 —— MTNode 自有工具
     （画布 / 应用 / 识图 / 数据库 / 事实库 / 素材库 / 长任务状态 / 会话自己的浏览器，
     注册在 dsh/gateway/*-plugin.mjs）与被 MTNode 接管的引擎工具（提问 / 目标 / 子代理 /
     后台任务，见 dsh/DESIGN.md「引擎自带工具」）。它们原来只能回落显示英文原名，
     现在一并给中文标签，并在卡片上换一个颜色（见 dshToolIsCustom）。
     顺序仍是从具体到一般：全文匹配的名字不会互相遮挡；兜底「工具调用」照旧。 */
  [/^ask_user_question$/i, "询问用户"],
  [/^mtnode_canvas_get$/i, "读取画布"],
  [/^mtnode_app$/i, "画布应用"],
  [/^mtnode_canvas_edit$/i, "编辑画布"],
  [/^mtnode_facts$/i, "AI 事实库"],
  [/^mtnode_db$/i, "数据库查询"],
  [/^mtnode_assets$/i, "素材库"],
  [/^lt_state$/i, "长任务状态"],
  [/^browser_launch$/i, "浏览器启动"],
  [/^browser_snapshot$/i, "浏览器快照"],
  [/^browser_navigate$/i, "浏览器导航"],
  [/^browser_click$/i, "浏览器点击"],
  [/^browser_type$/i, "浏览器输入"],
  [/^browser_key$/i, "浏览器按键"],
  [/^browser_eval$/i, "浏览器取值"],
  [/^browser_wait$/i, "浏览器等待"],
  [/^browser_screenshot$/i, "浏览器截图"],
  [/^browser_tabs$/i, "浏览器标签页"],
  [/^browser_network$/i, "浏览器网络"],
  [/^browser_help$/i, "浏览器求助"],
  [/^browser_release$/i, "浏览器释放"],
  [/^(mtnode_)?create_goal$/i, "建目标"],
  [/^(mtnode_)?get_goal$/i, "读目标"],
  [/^(mtnode_)?update_goal$/i, "改目标"],
  [/^(mtnode_)?todo_write$/i, "更新计划"],
  [/^(mtnode_)?list_agents$/i, "列出子智能体"],
  [/^(mtnode_)?send_message$/i, "发消息"],
  [/^(mtnode_)?interrupt_agent$/i, "中断子智能体"],
  [/^(mtnode_)?job_list$/i, "列出后台任务"],
  [/^(mtnode_)?job_output$/i, "读取后台任务"],
  [/^(mtnode_)?job_kill$/i, "终止后台任务"],
];
function dshToolTitleOf(t) {
  const nm = String((t && t.name) || "").trim();
  for (const [re, label] of DSH_TOOL_TITLE_RULES) if (re.test(nm)) return I18n.t(label);
  return I18n.t("工具调用");
}
/* 非 dsh 工具（本次需求）：MTNode 自有工具与被 MTNode 接管的引擎工具 —— 会话里给药丸
   换一个颜色（工具库紫 .t-custom，见 css/dsh.css），与青色那批 dsh 引擎工具一眼分家。
   判据与网关侧同源（gateway.mjs 用 /^mtnode_(canvas|app|facts|assets)|^lt_/ 认「自家工具」；
   design 口径见 dsh/DESIGN.md「MTNode 自有工具 / 引擎自带工具」两段），
   另加浏览器族（dsh/gateway/browser-plugin.mjs 注册）与被接管的引擎工具那几族。
   只影响渲染：工具可见性、许可与网关行为一律不动。 */
const DSH_CUSTOM_TOOL_RES = [
  /^mtnode_/i,
  /^lt_/i,
  /^browser_/i,
  /^(ask_user_question|create_goal|get_goal|update_goal|todo_write|subagent_fork|list_agents|send_message|interrupt_agent|job_list|job_output|job_kill)$/i,
];
function dshToolIsCustom(t) {
  const nm = String((t && t.name) || "").trim();
  if (!nm) return false;
  for (const re of DSH_CUSTOM_TOOL_RES) if (re.test(nm)) return true;
  return false;
}
/* 状态：error 优先（结果带 error），其次 stopped（本条被终止），再次 preparing（参数仍在流）、
   running（已派发未回结果）、否则 ok。 */
function dshToolStateOf(t, live) {
  if (!t) return "ok";
  if (t.error) return "error";
  if (t.stopped === true) return "stopped";
  if (t.prep && !t.result && !t.args) return "preparing";
  if (live && !t.result && !t.error) return "running";
  return "ok";
}
/* 准备态字节数 → 「N KB」（上游口径：Math.ceil(raw.length / 1024)，不是精确文件大小） */
function dshToolPrepText(bytes) {
  const kb = Math.max(1, Math.ceil((Number(bytes) || 0) / 1024));
  return I18n.t("正在准备内容 {n} KB", { n: kb });
}
/* 失败摘要：上游只给一句短摘要（错误名 + 码 + 一句正文），细节仍在展开体里 */
function dshToolErrSummary(t) {
  const e = t && t.error;
  if (!e) return "";
  const bits = [];
  if (e.name) bits.push(String(e.name));
  if (e.code) bits.push(String(e.code));
  const head = bits.join(" ") || I18n.t("失败");
  const msg = dshOneLine(e.message || e.detail || "");
  return msg ? head + " · " + msg.slice(0, 80) : head;
}
/* ── 文件改动 diff（本次需求 · 对齐上游 DiffBlock）───────────────────────────
 * 上游工具卡片的 diff 是**从第一方原始事件字段派生**的（dsh-client-ui-tool/README.zh.md），
 * 而本仓网关已把完整工具入参原样下发（gateway.mjs 的 tool 事件带 args），
 * 所以 write / edit 的「改前 → 改后」在渲染层就能算出来，不需要额外读盘：
 *   · write（新建 / 覆盖）：整篇当作新增；
 *   · edit / str_replace_editor：old_string|oldText → new_string|newText。
 * 行级算法：先剥掉公共前后缀，中间「先删后增」（与上游 coarse replacement 同一读法，
 * 不做 LCS —— 上游对超大片段同样退化成整段替换）。
 * 返回 null = 这次调用看不到文件改动（read / grep / shell 等）。 */
const DSH_DIFF_MAX_ROWS = 9; /* 上游会话内折叠上限：CHAT_DIFF_MAX_LINES = 9 */
/* 超大正文不算 diff（上游「文件过大，无法显示改动」那一档）：会话每次重绘都会问一次，
   把几百 KB 的正文逐行切开再切片，流式刷新期间会明显卡；宁可只显示统计缺省的一行。
   **这一档只属于对话 / 轨迹**（用户口径）：会话「改动」栏（renderer/app-changes.js）
   要能回看任意大小的一笔改动，走的是下面不带本上限的 dshToolDiffOfFull。 */
const DSH_DIFF_MAX_CHARS = 300000;
/* 判据只写一处：哪些工具算「看得见文件改动」。两个入口（对话口径 / 改动栏口径）共用 ——
   本函数返回 null 就是「这次调用看不到文件改动」（read / grep / shell 等）。
   返回 {isEdit, path, oldTxt, newTxt} —— 字符上限由调用方决定，本层不算。 */
const DSH_DIFF_WRITE_RE = /^(write|write_file|create_file)$/;
const DSH_DIFF_EDIT_RE = /^(edit|edit_file|str_replace_editor|apply_patch)$/;
function dshDiffPartsOf(t) {
  if (!t) return null;
  const a = dshToolArgsObj(t);
  if (!a) return null;
  const nm = String((t && t.name) || "").toLowerCase();
  const isEdit = DSH_DIFF_EDIT_RE.test(nm);
  if (!isEdit && !DSH_DIFF_WRITE_RE.test(nm)) return null;
  const path = dshOneLine(a.file_path || a.path || a.filename || "");
  const oldTxt = isEdit ? dshDiffArgText(a, ["old_string", "oldText", "old_text"]) : "";
  const newTxt = isEdit
    ? dshDiffArgText(a, ["new_string", "newText", "new_text"])
    : dshDiffArgText(a, ["content", "text", "new_string", "newText"]);
  if (!newTxt && !oldTxt) return null;
  return { isEdit, path, oldTxt: String(oldTxt), newTxt: String(newTxt) };
}
function dshToolDiffOf(t) {
  if (!t) return null;
  /* 缓存：一条工具调用的入参不再变，同一份 diff 不必每次重绘重算 */
  if (t._diff !== undefined) return t._diff;
  const p = dshDiffPartsOf(t);
  if (!p) return (t._diff = null);
  if (p.oldTxt.length + p.newTxt.length > DSH_DIFF_MAX_CHARS) return (t._diff = null);
  return (t._diff = dshDiffRowsOf(p.oldTxt, p.newTxt, p.path));
}
/* 会话「改动」栏专用入口：**不看字符上限**（用户口径「移除这个上限，包括代码上色」）——
   同一份判据、同一份行级算法与皮肤，只少那一档拒绝。缓存另挂 _diffFull，绝不与 _diff 串台
   （同一条工具记录在两处口径下结论可能不同：对话里 null、改动栏里有）。 */
function dshToolDiffOfFull(t) {
  if (!t) return null;
  if (t._diffFull !== undefined) return t._diffFull;
  const p = dshDiffPartsOf(t);
  if (!p) return (t._diffFull = null);
  return (t._diffFull = dshDiffRowsOf(p.oldTxt, p.newTxt, p.path));
}
function dshDiffArgText(a, keys) {
  for (const k of keys) if (typeof a[k] === "string" && a[k]) return a[k];
  return "";
}
function dshDiffRowsOf(oldTxt, newTxt, path) {
  const oldLines = oldTxt ? String(oldTxt).replace(/\r\n?/g, "\n").split("\n") : [];
  const newLines = newTxt ? String(newTxt).replace(/\r\n?/g, "\n").split("\n") : [];
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  )
    head++;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  )
    tail++;
  const rows = [];
  for (const s of oldLines.slice(Math.max(0, head - 3), head))
    rows.push({ k: "ctx", text: s });
  const del = oldLines.slice(head, oldLines.length - tail);
  const add = newLines.slice(head, newLines.length - tail);
  for (const s of del) rows.push({ k: "del", text: s });
  for (const s of add) rows.push({ k: "add", text: s });
  for (const s of newLines.slice(newLines.length - tail, newLines.length - tail + 3))
    rows.push({ k: "ctx", text: s });
  /* 折叠之外的上下文行数：上游只用「… 其余 N 行」交代，不做总计页脚 */
  const hidden = Math.max(0, head - 3) + Math.max(0, tail - 3);
  return { path, rows, added: add.length, removed: del.length, hidden };
}
/* diff 块：逐行 +/- 着色（上游 .del/.add 的 3px 内嵌左色条 + 语义色），
   超过 9 行折叠，点一下就地展开 / 收起。
   opts（本次需求 · 会话「改动」栏，缺省 = 上面这条原口径）：
     { foldCap, rowsLimit, batchRows } —— 折叠阈值 / 首屏行数 / 每批行数。 */
function dshDiffBlockEl(diff, opts) {
  if (!diff || !diff.rows.length) return null;
  const box = document.createElement("div");
  box.className = "dsh-diff";
  const head = document.createElement("div");
  head.className = "dsh-diff-head";
  const p = document.createElement("span");
  p.className = "dsh-diff-path";
  p.textContent = diff.path || "";
  head.appendChild(p);
  const stat = document.createElement("span");
  stat.className = "dsh-diff-stat";
  const plus = document.createElement("span");
  plus.className = "d-add";
  plus.textContent = "+" + diff.added;
  const minus = document.createElement("span");
  minus.className = "d-del";
  minus.textContent = "-" + diff.removed;
  stat.appendChild(plus);
  stat.appendChild(minus);
  head.appendChild(stat);
  box.appendChild(head);
  const body = document.createElement("div");
  body.className = "dsh-diff-body";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "dsh-diff-more";
  /* 折叠阈值与分批渲染（本次需求 · 会话「改动」栏）：
     · foldCap   —— 超过多少行先折住（缺省 = DSH_DIFF_MAX_ROWS，即对话 / 轨迹原口径）；
     · rowsLimit —— 首屏最多画多少行，之后点按钮或滚到底自动再续一批（0 / 缺省 = 不限）。
     两者只由 opts 传进来 —— 对话与轨迹那两处不传 ⟹ 行为与改动前一字不差。 */
  const o = opts && typeof opts === "object" ? opts : null;
  const foldCap =
    o && Number(o.foldCap) > 0
      ? Math.max(1, Math.floor(Number(o.foldCap)))
      : DSH_DIFF_MAX_ROWS;
  const rowsLimit = o && Number(o.rowsLimit) > 0 ? Math.floor(Number(o.rowsLimit)) : 0;
  const stepRows = rowsLimit ? Math.max(1, Math.floor(Number(o.batchRows) || rowsLimit)) : 0;
  /* 折叠态画到 min(foldCap, rowsLimit)；展开后每点一次 / 每滚到底再画 stepRows 行 */
  const foldedFirst = () => Math.min(foldCap, rowsLimit || foldCap);
  let shown = foldedFirst();
  /* 每批一锁：一次「滚到底」只续一批 —— 续完内容变高，若滚动位置仍落在近底区，
     同一次用户滚动里再连画就会一路连到底（用户口径是「滚到底自动再续一批」）。 */
  let moreLock = false;
  /* 上一批画完时的滚动位置：同一位置上的重复 scroll 事件不再连画（真浏览器里一次滚到底
     会连着来好几个 scroll 事件，位置却还是那一个）。 */
  let lastScrollTop = null;
  const foldedNow = () => more.dataset.folded !== "0";
  /* 只画出 [0, limit) 这一段（limit = 0 → 全部）：整段重建，与改动前同一写法 */
  const render = (limit) => {
    body.innerHTML = "";
    const rows = limit ? diff.rows.slice(0, limit) : diff.rows;
    for (const r of rows) {
      const line = document.createElement("div");
      line.className = "dsh-diff-row d-" + r.k;
      line.textContent =
        (r.k === "add" ? "+ " : r.k === "del" ? "- " : "  ") + r.text;
      body.appendChild(line);
    }
  };
  /* 底部那颗按钮的文案与可用态（三种）：折住 = 「… 其余 N 行」可点；展开未画完 = 同样
     「… 其余 N 行」可点（点了再续一批）；已画完 = 「收起差异」可点收起。 */
  const paintMore = () => {
    const total = diff.rows.length;
    if (total <= foldCap) {
      more.hidden = true;
      if (diff.hidden > 0) {
        more.hidden = false;
        more.textContent = I18n.t("… 其余 {n} 行", { n: diff.hidden });
        more.disabled = true;
      }
      return;
    }
    more.hidden = false;
    more.disabled = false;
    more.textContent = foldedNow()
      ? I18n.t("… 其余 {n} 行", { n: total - foldedFirst() })
      : shown < total
        ? I18n.t("… 其余 {n} 行", { n: total - shown })
        : I18n.t("收起差异");
  };
  const paint = () => {
    const folded = foldedNow();
    shown = folded ? foldedFirst() : Math.max(shown, foldedFirst());
    render(folded ? foldedFirst() : rowsLimit ? Math.min(shown, diff.rows.length) : 0);
    paintMore();
  };
  paint();
  /* 再画一批（点按钮 / 滚到底都走它）：返回 true = 这一下真又画了一批，false = 已经画完。 */
  const moreRows = () => {
    const total = diff.rows.length;
    if (!foldedNow()) {
      if (!stepRows || shown >= total) return false;
      shown = Math.min(total, shown + stepRows);
      render(shown);
      paintMore();
      return true;
    }
    /* 折住时第一次展开：先摊一档（rowsLimit 有值就只摊一批，否则整块摊平） */
    more.dataset.folded = "0";
    shown = rowsLimit ? Math.min(total, Math.max(foldedFirst(), stepRows)) : total;
    render(rowsLimit ? shown : 0);
    paintMore();
    return true;
  };
  more.addEventListener("mousedown", (ev) => ev.stopPropagation());
  more.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    /* 已经画完再点 = 收起（对话 / 轨迹的原口径）；还没画完 = 再续一批 */
    if (!foldedNow() && (!stepRows || shown >= diff.rows.length)) {
      more.dataset.folded = "1";
      shown = foldedFirst();
      paint();
      return;
    }
    moreRows();
  });
  box.appendChild(body);
  box.appendChild(more);
  box._diffMoreRows = moreRows;
  /* 分批续画的出口（点按钮与滚到底共用它）：**监听不挂这里** —— diff 块归谁滚只有调用方知道（对话 / 轨迹是
     块内滚，会话「改动」栏把 .dsh-diff-body 的 max-height 放开、由外层容器滚），
     所以这里只交出口，各自那一层监听自己的滚动容器再调它。 */
  return box;
}
/* 对话 / 轨迹两处照旧走它（不带 opts ⟹ 折叠上限 9 行、展开即全文）；会话「改动」栏
   走 opts（240 行折叠 + 每批 200 行 + 「滚到底续画」）—— 判据与皮肤同源，只有这档参数不同。 */
function dshToolDiffEl(diff) {
  return dshDiffBlockEl(diff, null);
}
function dshToolDiffElOpt(diff, opts) {
  if (!diff || !diff.rows.length) return null;
  return dshDiffBlockEl(diff, opts);
}
/* 同一份 diff 供**轨迹检查器**复用（本次需求：轨迹里的事件详情也要与对话同款 diff）：
   会话·运行轨迹视图（renderer/app-trajectory.js）是独立 IIFE，过去只能把这段算法再抄一份。
   现在由本文件把真函数挂到 window.MTNodeChatDiff 上 —— **就这一处**，改判据 / 改折叠
   上限只改上面那几个常量与函数，各处同时生效（轨迹那边是薄层，不自己算 diff）。
   挂法（照 window.MTNodeTeam = API 那份口径）：挂真函数本体，不包一层、不改行为。
   · of / el / maxRows：对话与轨迹的原口径（含 30 万字符不作 diff 那一档）；
   · ofFull / elFull：「改动」栏专用 —— 没有字符上限，折叠与分批由 opts 传（见 dshToolDiffElOpt）。 */
window.MTNodeChatDiff = {
  of: dshToolDiffOf, /* (工具记录) → { path, rows, added, removed, hidden } | null */
  el: dshToolDiffEl, /* (diff) → 逐行 +/- 着色的 .dsh-diff 块（含「… 其余 N 行」折叠） */
  maxRows: DSH_DIFF_MAX_ROWS,
  ofFull: dshToolDiffOfFull, /* 同 of，但**不看字符上限**（改动栏口径） */
  elFull: dshToolDiffElOpt, /* (diff, { foldCap, rowsLimit, batchRows }) → 同款 diff 块 */
};

function dshToolDetailsEl(t, live, nodeId, opts) {
  const state = dshToolStateOf(t, live);
  const det = document.createElement("details");
  det.className = "dsh-tool" + (t.error ? " err" : "") + " st-" + state;
  det.dataset.state = state;
  const openKey =
    (nodeId || "") + ":" + (t.callId || t.name || "") + (t.at ? ":" + t.at : "");
  /* 展开态三态（与思考块同一口径）：用户点过就以用户那一次为准（true / false 都记下来），
     没点过才看档位默认 —— 「完全展开」档的工具卡默认摊开。
     **默认展开由调用方经 opts.expand 传进来**（会话分段渲染知道自己那条会话的档位），
     这里不做会话回查：工具卡在节点输出区 / 助手侧栏 / 团队视图等十几处都在用，
     没有会话归属的那几处就不该去猜档位。 */
  const oSt = openKey && S.openDshTools ? S.openDshTools[openKey] : undefined;
  if (oSt === true) det.open = true;
  else if (oSt === undefined && opts && opts.expand === true) det.open = true;
  const sum = document.createElement("summary");
  sum.className = "dsh-tool-sum";
  /* 那颗青色药丸 = 「工具按钮」本身。上游 ToolRow 是「图标 + 标题 · 摘要」，
     标题按工具族取中文（读取 / 写入 / 编辑 / 运行命令 / 搜索…，见 dshToolTitleOf）；
     没有对应标题的工具（既不是 dsh 引擎自带、也不在下面那张非 dsh 表里的）回落显示原名，
     绝不显示空壳。非 dsh 工具（本次需求）另挂 .t-custom：药丸换工具库紫，
     与青色那批 dsh 引擎工具一眼分家（判据 = dshToolIsCustom）。
     文件名同样不塞进药丸里（药丸一撑大就像「工具叫 read/x.js」），而是跟在按钮后方。 */
  const chip = document.createElement("span");
  chip.className = "dsh-tool-chip" + (dshToolIsCustom(t) ? " t-custom" : "");
  const title = dshToolTitleOf(t);
  const shown = title && title !== I18n.t("工具调用") ? title : t.name;
  chip.textContent = (live ? "◌ " : "🔧 ") + shown;
  /* 药丸里的标题是「这一步在干什么」，原始工具名留在 hover 与 dataset 上（排查时仍可读）。
     中文标签与原名不同才补一句，避免 hover 出现「询问用户 · 询问用户」。 */
  chip.title = String(t.name || "") + (title && title !== t.name ? " · " + title : "");
  chip.dataset.toolName = String(t.name || "");
  sum.appendChild(chip);
  /* pwsh / bash：按钮后面直接跟命令正文（绿色，长命令截断）；grep / glob：跟「路径 … · 目标 … · 参数」。
     一眼读出「这步在跑哪条命令 / 找什么」，不用先展开参数。抽不出就不挂。
     分隔圆点交给 CSS 的 ::before 画（上游那颗 2×2 点），不额外占一个 DOM 节点 ——
     DOM 形状保持「药丸 + 摘要 + 徽标」，既有冒烟与文件徽标索引都不动。 */
  const cmdEl = dshToolHintEl(t);
  if (cmdEl) sum.appendChild(cmdEl);
  /* 徽标本体与点击全在 app-fileview.js，与计划面板 planLiveBlock 同源：
     不展开参数也能看出这步动了哪个文件，点文件名 = 右侧滑出只读查看面板；
     点击在徽标里 preventDefault + stopPropagation，不会连带展开 / 收起详情。
     grep / glob 那一行已经带了目标路径（最前的黄色那段）→ 同一路径不再重复挂徽标。 */
  if (typeof dshToolFileBadges === "function") {
    try {
      const badges = dshToolFileBadges(t, nodeId, dshToolHintSkipPath(cmdEl));
      if (badges) sum.appendChild(badges);
    } catch (_) {}
  }
  /* 改动统计（本次需求 · 上游 diffAdded / diffRemoved）：只在 write / edit 这类
     能算出改动的调用上出现，hover 该行才着色（上游 .row:is(:hover,[aria-expanded]) 口径）。 */
  const diff = dshToolDiffOf(t);
  if (diff) {
    const stat = document.createElement("span");
    stat.className = "dsh-tool-diffstat";
    const pa = document.createElement("span");
    pa.className = "d-add";
    pa.textContent = "+" + diff.added;
    const mi = document.createElement("span");
    mi.className = "d-del";
    mi.textContent = "-" + diff.removed;
    stat.appendChild(pa);
    stat.appendChild(mi);
    stat.title = I18n.t("本次改动：新增 {a} 行，删除 {r} 行", {
      a: diff.added,
      r: diff.removed,
    });
    sum.appendChild(stat);
  }
  /* 准备态（本次需求 · 上游 preparing 阶段）：参数还在流进来，先给一行「正在准备内容 N KB」 */
  if (state === "preparing") {
    const prep = document.createElement("span");
    prep.className = "dsh-tool-prep";
    prep.textContent = dshToolPrepText(t.prep && t.prep.bytes);
    sum.appendChild(prep);
  }
  /* 失败 / 停止摘要（上游 errorSummary / stoppedSummary：各走 error / warn 语义色）。
     只在出错或本条被终止时出现；没有具体文案时至少说一句「失败」。 */
  if (state === "error") {
    const es = document.createElement("span");
    es.className = "dsh-tool-errsum";
    es.textContent = dshToolErrSummary(t);
    sum.appendChild(es);
  } else if (state === "stopped") {
    const ss = document.createElement("span");
    ss.className = "dsh-tool-stopsum";
    ss.textContent = I18n.t("已停止");
    sum.appendChild(ss);
  }
  sum.title =
    (t.name ? String(t.name) + " · " : "") +
    I18n.t("点击展开参数与结果") +
    (t.turn ? I18n.t(" · 第{turn}轮第{step}步", { turn: t.turn, step: t.step }) : "") +
    (t.at ? " · " + fmtTime(t.at) : "");
  det.appendChild(sum);
  const inner = document.createElement("div");
  inner.className = "dsh-tool-body";
  /* 文件改动 diff 排在最前（上游卡片就是「标题行 → 差异 → 其它输出」的读法）：
     从入参算出来的 +/- 行，超过 9 行折叠，点一下就地展开。 */
  if (diff) {
    const dEl = dshToolDiffEl(diff);
    if (dEl) inner.appendChild(dEl);
  }
  if (t.args) {
    const al = document.createElement("div");
    al.className = "dsh-tool-sec";
    al.textContent = I18n.t("参数");
    const pre = document.createElement("pre");
    pre.innerHTML = plainTextToLinkHtml(t.args);
    inner.appendChild(al);
    inner.appendChild(pre);
  }
  const rt = toolResultText(t);
  if (rt || t.error) {
    const rl = document.createElement("div");
    rl.className = "dsh-tool-sec";
    rl.textContent = t.error ? I18n.t("结果（出错）") : live ? I18n.t("结果（进行中）") : I18n.t("结果");
    const pre = document.createElement("pre");
    pre.innerHTML = plainTextToLinkHtml(rt || I18n.t("（无输出）"));
    inner.appendChild(rl);
    inner.appendChild(pre);
  } else if (live) {
    const rl = document.createElement("div");
    rl.className = "dsh-tool-sec";
    rl.textContent = I18n.t("等待结果…");
    inner.appendChild(rl);
  }
  det.appendChild(inner);
  det.addEventListener("mousedown", (ev) => ev.stopPropagation());
  det.addEventListener("click", (ev) => ev.stopPropagation());
  /* 手动展开/收起：记住状态，避免画布重绘后瞬间合上；输出面板高度随之自适应 */
  det.addEventListener("toggle", () => {
    if (openKey) {
      S.openDshTools = S.openDshTools || {};
      /* 三态：false 也写下来（「完全展开」档默认摊开时，用户收起过的卡片不再被默认展开顶回来） */
      S.openDshTools[openKey] = !!det.open;
    }
    const box = det.closest(".dsh-tools");
    if (!box || !box.id) return;
    const m = /^dsh-out-tools-(.+)$/.exec(box.id);
    if (!m) return;
    const n = nodeById(m[1]);
    if (n) autoFitOutputHeight(n);
  });
  return det;
}

function histMsgKey(scope, idx, m) {
  return (
    String(scope || "") +
    ":" +
    idx +
    ":" +
    (m && m.role ? m.role : "") +
    ":" +
    String((m && m.content) || "").slice(0, 64)
  );
}

function histBodyExceedsTwoLines(body) {
  if (!body) return false;
  const cs = getComputedStyle(body);
  let lh = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lh) || lh <= 0) {
    const fs = parseFloat(cs.fontSize);
    lh = (Number.isFinite(fs) && fs > 0 ? fs : 12.5) * 1.75;
  }
  const pad =
    (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return body.scrollHeight > lh * 2 + pad + 1;
}

function histCollectRows(list) {
  const rows = [];
  if (!list) return rows;
  for (const el of list.children) {
    if (!el.classList || !el.classList.contains("dsh-msg")) continue;
    rows.push(el);
  }
  return rows;
}

function histAssignRounds(rows) {
  const marks = [];
  let round = 0;
  let openUserRound = 0;
  for (const el of rows) {
    const isUser = el.classList.contains("dsh-user");
    let r;
    if (isUser) {
      round += 1;
      openUserRound = round;
      r = round;
    } else if (openUserRound) {
      r = openUserRound;
      openUserRound = 0;
    } else {
      round += 1;
      r = round;
    }
    marks.push({ el, role: isUser ? "user" : "ai", round: r });
  }
  return marks;
}

function scrollToHistMark(list, el) {
  if (!list || !el) return;
  /* 不用 smooth：滚动动效会带动轨道标记位移，导致 click release 丢失 */
  list.scrollTop = Math.max(0, el.offsetTop - 8);
}

function histRailPositionLocked(list) {
  return !!(list && list._histRailPointer);
}

function histRailSignature(marks) {
  return marks
    .map(
      (m) =>
        (m.el.dataset.histKey || m.el.dataset.histIdx || "") +
        ":" +
        m.round +
        ":" +
        m.role,
    )
    .join("|");
}

/* 竖条（.hist-rail）贴滚动条右侧：右边界 = 内容列的右外沿（列本身 + 它的滚动条）。
   列在 .hist-scroll-wrap 里是**居中定宽**的（.agent-list 等：max-width:820px + margin:0 auto），
   窗口宽时它离 wrap 右沿还有一大段空白 —— 竖条若只靠 CSS 的 right:0 就会飘到窗口最右，
   与滚动条隔开整整一段空白。这里按实测 rect 把这段空余（wrap.right − list.right）
   写成竖条的 right：滚动条就在列的最右那几像素上，所以竖条落点 = 滚动条正右侧，
   不再悬在窗口右沿；它也不占列宽（消息列宽度与居中位置一字未变）。
   列被挤到铺满整行（窄窗 / 节点内会话）时空余为 0，退回最右沿 —— 那也正是滚动条旁。
   纯读数改写一处内联样式，不动任何布局。 */
function histRailAlign(list, rail) {
  if (!list || !rail || typeof list.getBoundingClientRect !== "function") return;
  const wrap = list.parentNode;
  if (!wrap || typeof wrap.getBoundingClientRect !== "function") return;
  const gap = Math.max(
    0,
    Math.round(wrap.getBoundingClientRect().right - list.getBoundingClientRect().right),
  );
  const px = gap + "px";
  if (rail.style.right !== px) rail.style.right = px;
}

function positionHistRailMarks(list, rail, marks) {
  if (!rail) return;
  histRailAlign(list, rail);
  if (!marks || !marks.length || histRailPositionLocked(list)) return;
  const contentH = Math.max(list.scrollHeight, 1);
  const railH = Math.max(rail.clientHeight, 1);
  const btns = rail.querySelectorAll(".hist-rail-mark");
  marks.forEach((m, i) => {
    const btn = btns[i];
    if (!btn) return;
    const mid = m.el.offsetTop + m.el.offsetHeight / 2;
    const y = (mid / contentH) * railH;
    btn.style.top = Math.max(8, Math.min(railH - 8, y)) + "px";
  });
}

function rebuildHistRail(list, rail, marks) {
  rail.innerHTML = "";
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hist-rail-mark hist-rail-" + m.role;
    btn.dataset.histRow = String(i);
    const who = m.role === "user" ? I18n.t("你") : "AI";
    btn.title = who + " · #" + m.round;
    const bar = document.createElement("span");
    bar.className = "hist-rail-bar";
    const num = document.createElement("span");
    num.className = "hist-rail-n";
    num.textContent = String(m.round);
    btn.appendChild(bar);
    btn.appendChild(num);
    rail.appendChild(btn);
  }
  positionHistRailMarks(list, rail, marks);
}

function ensureHistRail(list) {
  if (!list || !list.parentNode) return null;
  let wrap = list.parentNode;
  if (!wrap.classList || !wrap.classList.contains("hist-scroll-wrap")) {
    wrap = document.createElement("div");
    wrap.className = "hist-scroll-wrap";
    if (
      list.classList.contains("agent-list") ||
      list.classList.contains("assist-list") ||
      list.classList.contains("chat-list") ||
      list.classList.contains("agent-conv")
    ) {
      wrap.classList.add("is-flex-fill");
    }
    list.parentNode.insertBefore(wrap, list);
    wrap.appendChild(list);
  }
  let rail = null;
  for (const c of wrap.children) {
    if (c.classList && c.classList.contains("hist-rail")) {
      rail = c;
      break;
    }
  }
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "hist-rail";
    wrap.appendChild(rail);
  }
  if (!rail._histClickBound) {
    rail._histClickBound = true;
    const clearHistRailPointer = () => {
      if (!list._histRailPointer) return;
      list._histRailPointer = false;
      const r = list.parentNode;
      const railEl =
        r &&
        [...r.children].find(
          (c) => c.classList && c.classList.contains("hist-rail"),
        );
      if (railEl && list._histRailMarks && list._histRailMarks.length) {
        positionHistRailMarks(list, railEl, list._histRailMarks);
      }
    };
    rail.addEventListener("mousedown", (ev) => ev.stopPropagation());
    rail.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const btn =
        ev.target && ev.target.closest
          ? ev.target.closest(".hist-rail-mark")
          : null;
      if (!btn || !list._histRailMarks) return;
      const i = Number(btn.dataset.histRow);
      const m = list._histRailMarks[i];
      if (!m || !m.el) return;
      ev.preventDefault();
      ev.stopPropagation();
      list._histRailPointer = true;
      scrollToHistMark(list, m.el);
    });
    rail.addEventListener("pointerup", clearHistRailPointer);
    rail.addEventListener("pointercancel", clearHistRailPointer);
    rail.addEventListener("lostpointercapture", clearHistRailPointer);
  }
  if (!list._histRailBound) {
    list._histRailBound = true;
    const onScroll = () => {
      if (list._histRailScrollRaf) return;
      list._histRailScrollRaf = requestAnimationFrame(() => {
        list._histRailScrollRaf = 0;
        if (!list.isConnected) return;
        const r = list.parentNode;
        const railEl =
          r &&
          [...r.children].find(
            (c) => c.classList && c.classList.contains("hist-rail"),
          );
        if (railEl && list._histRailMarks && list._histRailMarks.length) {
          positionHistRailMarks(list, railEl, list._histRailMarks);
        }
      });
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver === "function") {
      try {
        const ro = new ResizeObserver(() => {
          /* 每帧至多补一次：updateHistRail 会重建 / 重排 .hist-rail 里的标记（改布局），
             在回调里同步做 = 同帧内又产生一次未派发的尺寸通知，浏览器会抛
             「ResizeObserver loop completed with undelivered notifications.」
             （左栏宽 / 开发页三栏一拖就报的就是它）。推到 rAF 后做，回调返回时布局已定。 */
          list._histRailRoPending = true;
          if (list._histRailRoRaf) return;
          list._histRailRoRaf = requestAnimationFrame(() => {
            list._histRailRoRaf = 0;
            if (!list._histRailRoPending || !list.isConnected) return;
            list._histRailRoPending = false;
            updateHistRail(list);
          });
        });
        ro.observe(list);
        ro.observe(rail);
        list._histRailRo = ro;
      } catch (_) {}
    }
  }
  return rail;
}

function updateHistRail(list) {
  const rail = ensureHistRail(list);
  if (!rail) return;
  const marks = histAssignRounds(histCollectRows(list));
  list._histRailMarks = marks;
  if (!marks.length) {
    rail.innerHTML = "";
    list._histRailSig = "";
    return;
  }
  const sig = histRailSignature(marks);
  if (list._histRailSig !== sig) {
    list._histRailSig = sig;
    rebuildHistRail(list, rail, marks);
  } else {
    positionHistRailMarks(list, rail, marks);
  }
}

function applyHistoryCollapse(list) {
  if (!list) return;
  const rows = histCollectRows(list);
  const lastRow = rows[rows.length - 1];
  /* 最后一行是「AI · 运行中」live 行时，它前面一行通常是用户刚发的新消息：
     不能让 live 行占着末位就把新消息折叠成 2 行小条（看起来像消息没出现/没放好） */
  const liveLast = !!(
    lastRow &&
    lastRow.classList.contains("dsh-ai") &&
    lastRow.querySelector(".dsh-role.live")
  );
  S.histExpanded = S.histExpanded || {};
  rows.forEach((el, i) => {
    const body = el.querySelector(".dsh-msg-body");
    el.classList.remove("hist-collapsed");
    if (body) body.style.maxHeight = "";
    const isLast = i === rows.length - 1;
    const isPrevOfLive = !isLast && liveLast && i === rows.length - 2;
    const key = el.dataset.histKey || "";
    /* 用户输入行一般不长、且是会话里最该一眼看全的内容：一律不折叠、始终全显 */
    const isUser = el.classList.contains("dsh-user");
    if (isLast || isPrevOfLive || isUser) {
      el.classList.remove("hist-expanded");
      el.removeAttribute("title");
      return;
    }
    if (key && S.histExpanded[key]) {
      /* 已展开的消息保持展开:折叠为单向(点击只展开),不再提示点击收起 */
      el.classList.add("hist-expanded");
      el.removeAttribute("title");
      return;
    }
    if (!body || !histBodyExceedsTwoLines(body)) {
      el.classList.remove("hist-expanded");
      el.removeAttribute("title");
      return;
    }
    const cs = getComputedStyle(body);
    let lh = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lh) || lh <= 0) {
      const fs = parseFloat(cs.fontSize);
      lh = (Number.isFinite(fs) && fs > 0 ? fs : 12.5) * 1.75;
    }
    const pad =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    el.classList.add("hist-collapsed");
    el.classList.remove("hist-expanded");
    body.style.maxHeight = lh * 2 + pad + "px";
    el.title = I18n.t("点击展开");
  });
  updateHistRail(list);
}

function scheduleHistoryCollapse(list, after) {
  if (!list) return;
  const run = () => {
    if (list.isConnected) applyHistoryCollapse(list);
    else requestAnimationFrame(run);
    if (typeof after === "function") after();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      if (list.isConnected) run();
      else requestAnimationFrame(run);
    });
  } else {
    setTimeout(run, 0);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (ev) => {
    /* 折叠只发生在折叠态的行上(.hist-collapsed):点击后单向展开,
       已展开的行不再响应点击,避免再次点击收起打断复制/选中等操作 */
    const row = ev.target && ev.target.closest
      ? ev.target.closest(".dsh-msg.hist-collapsed")
      : null;
    if (!row) return;
    if (
      ev.target.closest(
        "a, button, summary, input, textarea, select, .dsh-think, .dsh-tools, .hist-rail",
      )
    )
      return;
    const key = row.dataset.histKey || "";
    const body = row.querySelector(".dsh-msg-body");
    S.histExpanded = S.histExpanded || {};
    row.classList.remove("hist-collapsed");
    row.classList.add("hist-expanded");
    if (body) body.style.maxHeight = "";
    if (key) S.histExpanded[key] = true;
    row.removeAttribute("title");
    updateHistRail(row.parentNode);
  });
}

function formatMsgTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return hm;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.getMonth() + 1 + "/" + d.getDate() + " " + hm;
  }
  return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
}

/* 消息末尾时间：精确到秒（非今天自动带日期） */
function formatMsgTimeSec(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  const hms =
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
    return hms;
  if (d.getFullYear() === now.getFullYear())
    return d.getMonth() + 1 + "/" + d.getDate() + " " + hms;
  return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + hms;
}

/* 完整时间戳（悬浮提示用）：2025/6/3 14:03:22 */
function formatMsgStamp(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return (
    d.getFullYear() +
    "/" +
    (d.getMonth() + 1) +
    "/" +
    d.getDate() +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
}

/* 相对时长：分 / 小时 / 天 / 周 / 月 / 年 */
function formatRelTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const diff = Date.now() - n;
  if (diff < 60000) return I18n.t("刚刚");
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + I18n.t(" 分钟前");
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + I18n.t(" 小时前");
  const day = Math.floor(hr / 24);
  if (day < 7) return day + I18n.t(" 天前");
  const wk = Math.floor(day / 7);
  if (wk < 5) return wk + I18n.t(" 周前");
  const mon = Math.floor(day / 30);
  if (mon < 12) return mon + I18n.t(" 个月前");
  return Math.floor(day / 365) + I18n.t(" 年前");
}

/* 会话最后对话时间：updatedAt / 所有消息 / outbox 取最大者（全量扫描：历史可能乱序、末尾几条可能缺 at） */
function sessionLastAt(s) {
  if (!s) return 0;
  let t = Number(s.updatedAt) || 0;
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const at = Number(msgs[i] && (msgs[i].at || msgs[i].createdAt || msgs[i].ts)) || 0;
    if (at > t) t = at;
  }
  const ob = Array.isArray(s.outbox) ? s.outbox : [];
  for (let i = ob.length - 1; i >= 0; i--) {
    const at = Number(ob[i] && ob[i].at) || 0;
    if (at && at > t) t = at;
  }
  return t;
}

/* ── 会话视图时间线分段（seg）：消费 app-db.js 的 runTrace 轨迹段模型 ──
   网关事件由 dshRunTask 统一喂进 S.runTrace[runKey].items（think / say /
   tool / err，按 turn/step 与 say-end 切段）。会话视图的 live 行按段序渲染；
   轮次收尾转成 msg.segments（限长）随消息持久化，历史消息按段重绘。 */
const AGENT_SEG_TEXT_MAX = 8000; // 落盘单段上限（字）
/* ── 会话轮号（本次需求 · 用户已确认口径）───────────────────────────────
   第 N 轮 = 该会话里**用户第几次发送**（开发 / 细化绑定会话的「任务书」kick 同样算一轮）。
   同一次发送产生的思考 / 正文 / 工具 / 错误全部算这一轮 —— 网关内部的 turn 是「模型往返
   次数」，一次发送里调几次工具就会 +1，拿它当轮头编号会把正文与工具拆到不同轮里
   （正是「一个在第一轮、一个在全部」的成因），所以轮头只认这个号。
   两个来源**取较大者**，保证轮号单调、绝不与已落盘的轮号撞车（撞号 = 两轮并成一个轮头，
   那正是要修的病）：
     · 用户消息数：正常情况下它正好是「第几次发送」（开轮那条消息在 agentSessionSend 里先 push）；
     · 已存段快照里的最大轮号 + 1：会话只留最近 100 条消息，老轮次被裁掉后前者会「封顶」，
       只靠它会与仍留在列表里的旧轮号重号。
   拿不到号（非会话运行 / 老数据）回 null = 不编号，展示层回落「全部」，绝不推断。 */
function agentRoundOfRun(st) {
  const msgs = st && Array.isArray(st.messages) ? st.messages : [];
  let n = 0;
  let maxStored = 0;
  for (const m of msgs) {
    if (!m) continue;
    if (m.role === "user") {
      n++;
      continue;
    }
    const segs = Array.isArray(m.segments)
      ? m.segments
      : Array.isArray(m._segs)
        ? m._segs
        : null;
    if (!segs) continue;
    for (const s of segs) {
      const r = Number(s && s.round);
      if (Number.isFinite(r) && r > maxStored) maxStored = r;
    }
  }
  /* 没有任何已存轮号时只认「第几次发送」（空会话 → 0 → null = 不编号） */
  const round = maxStored > 0 ? Math.max(n, maxStored + 1) : n;
  return round > 0 ? round : null;
}
/* 本次运行轨迹上的轮号：live 的段自己不带 round（轮号挂在这一次运行的轨迹上，
   落盘时才写进段快照，见 app-db.js traceSegmentsOf）。 */
function agentTraceRound(runKey) {
  const k =
    typeof traceRunKey === "function" ? traceRunKey(runKey) : String(runKey);
  const tr = S.runTrace && S.runTrace[k];
  const n = tr && typeof traceNum === "function" ? traceNum(tr.round, 0) : 0;
  return n > 0 ? n : null;
}
function agentTraceItems(runKey) {
  const k =
    typeof traceRunKey === "function" ? traceRunKey(runKey) : String(runKey);
  const tr = S.runTrace && S.runTrace[k];
  return tr && Array.isArray(tr.items) && tr.items.length ? tr.items : null;
}
/* 仅「本会话正在进行的聊天运行」走分段渲染：runKey=agent:<id> 且该 run 还活着
   （节点绑定的 dev 运行走各自的 runKey，保持旧渲染，不与 app-db 的就地更新打架） */
function agentChatSegItems(st) {
  if (!st || !st.running) return null;
  const rk = "agent:" + st.id;
  if (!S._runCancels || !S._runCancels[rk]) return null;
  return agentTraceItems(rk);
}
/* ── 逐项时刻（本次需求 · 用户口径「时间应当在每一项，而不是总项」）───────────
   会话里**每一项**（思考 / 正文 / 上下文注入 / 工具调用）左侧挂一条**恒显**的时刻，
   精确到秒；工具项再带上这次调用的耗时（HH:MM:SS · 1.2s）。
   注意（用户口径）：会话主体**不画竖线 / 时间轴** —— 竖线 + 节点圆点那一套是「轨迹」
   视图的视觉（renderer/app-trajectory.js），这里只给每一项一枚左侧时刻。
   时刻的来源只有两处**真实**记录（不插值、不编时刻）：
     · 工具项：工具记录自带 at / doneAt（网关给的发起与结果回来时刻，见下方 tool 事件分支）；
     · 其余段：段自己的 at —— app-db.js 的 tracePush 在事件**到达**那一刻记下，
       并随段快照落盘（app-db.js traceSegmentsOf / app-assist.js agentSegsForDisk）。
       老存档没有这个字段 → 回落显示所属消息时刻并在前面标「≈」、tooltip 里说明
       （绝不拿段序 / 轮号推算时刻）。
    **时刻栏宿主必须自己不上色**（这条别破）：青轨是 border-left、青底是 background，
    两者都以元素自己的左边框为起点 —— 宿主兼皮肤时，颜色就从时刻栏**左边**起画、把时刻
    一起裹进去（用户口径：「颜色和左侧竖条被错误地拉伸到了时间的左边，应当与思考一致」）。
    所以带皮肤的段一律**两层**：外层 .dsh-seg-*-wrap 只当时刻栏宿主（透明），
    内层才是皮肤盒（思考 = button.dsh-think-row（本次需求：一行可点开弹窗）、
    工具 = div.dsh-seg-tool）。
    回归口径：test/smoke-session-markers.js [6]。
   落法：时刻栏是该项元素的**第一只子节点**（.dsh-seg-time），CSS 按 .dsh-seg-has-time
   给这一项留出左侧一条定宽栏（--dsh-seg-time-w），因此正文一个字都不会被压住。
   与「消息级时刻」（.dsh-msg-side，挂在整条消息左侧）是两层：用户口径两层都留 ——
   用户消息只有消息级那一层，AI 消息里每一项另有自己那一层。 */
function dshSegDurText(at, doneAt) {
  const a = Number(at) || 0;
  const b = Number(doneAt) || 0;
  if (!a || !b || b <= a) return "";
  const ms = b - a;
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}
/* 一项的时刻栏元素：own = 这一项自己的真实时刻（优先），msgAt = 所属消息时刻（回落）。 */
function dshSegTimeEl(own, doneAt, msgAt) {
  const at = Number(own) || 0;
  const msg = Number(msgAt) || 0;
  const use = at || msg;
  if (!use) return null;
  const txt = formatMsgTimeSec(use);
  if (!txt) return null;
  const dur = at ? dshSegDurText(at, doneAt) : "";
  const el = document.createElement("span");
  el.className = "dsh-seg-time" + (at ? "" : " is-approx");
  /* 回落时刻**不加「≈」字符**：多一个字符就把最长形态（「M/D HH:MM:SS」）挤出栏宽、
     时刻被折成两行（真浏览器量到「≈10/1」+「09:12:31」）。「这不是这一项自己的时刻」
     由 CSS 的点线下划线 + 更淡，以及下面 title 里那句写明。 */
  el.textContent = txt + (dur ? " · " + dur : "");
  el.title = at
    ? I18n.t("这一项自己的时刻（精确到秒）") +
      " · " +
      formatMsgStamp(at) +
      (dur ? I18n.t("，耗时 ") + dur : "")
    : I18n.t("这一项自己没有独立时刻（老存档的段）：显示的是所属消息的时刻") +
      " · " +
      formatMsgStamp(use);
  return el;
}
/* 把时刻栏挂到某一项的最前面（拿不到任何真实时刻就不挂空栏）。 */
function dshSegTimeAttach(host, own, doneAt, msgAt) {
  if (!host || !host.classList) return host;
  const t = dshSegTimeEl(own, doneAt, msgAt);
  if (!t) return host;
  host.classList.add("dsh-seg-has-time");
  host.insertBefore(t, host.firstChild);
  return host;
}
/* 流式正文的就地更新（#agent-stream 那一支）：段上挂着逐项时刻栏时，整块
   `textContent = 文本` 会把时刻栏一起冲掉 —— 先摘下来、写完再挂回最前，
   「逐 token 就地更新」与「每一项左侧有时间」两条同时成立。 */
function dshSegSetStreamText(el, txt) {
  if (!el) return;
  const keep = el.querySelector ? el.querySelector(".dsh-seg-time") : null;
  el.textContent = String(txt == null ? "" : txt);
  if (keep) el.insertBefore(keep, el.firstChild);
}

/* 段数取舍：think / say / err / tool 一律不裁 —— 只夹单段字数（见 agentSegsForDisk）。
   为什么连工具段也不裁（旧口径 = 最多留最近 40 条工具段，其余由「尾部兜底 chips」补）：
     · think：需求「一轮结束后不要自动隐藏或删除思考」——思考段被顶掉就等于思考从会话里消失；
     · say：它们是本条消息的正文。say 段一丢，按段重建出来的正文就不再等于 m.content，
       dshMsgSegsViewable 判「不能按段渲染」，整条消息整块退回旧渲染（长任务常有上百个
       think 段，旧口径一超 40 段就先「只留 think」，say 全被甩掉 → 必然踩中）；
     · tool：工具明细虽完整存在 m.tools 里，但段一裁，那颗 chip 就再也配不到自己的时间线
       位置，只能作为兜底 chips 挂在消息**尾部** —— 于是长任务（工具 >40 次）的最终回复
       下方压着一堆旧工具调用，用户看到的就是「AI 最终回复未在最底部」。而且被裁的段照样
       要建一颗 chip 出来，裁段并没有省下任何渲染，只把顺序搞乱了 —— 一律保留。 */
/* 收尾 / 落盘共用：只夹单段字数（think 整段不裁 —— 需求「一轮结束后不要自动隐藏或删除
   思考」）；过长的 say / err 单段截到 AGENT_SEG_TEXT_MAX 加省略号（此时正文拼接不再等于
   content，历史渲染自动退回旧版，不丢字）。 */
function agentSegsForDisk(segList) {
  if (!Array.isArray(segList) || !segList.length) return null;
  const out = [];
  for (const s of segList) {
    if (!s || !s.k) continue;
    let text = String(s.text || "");
    if (s.k === "tool") text = "";
    if (s.k !== "think" && text.length > AGENT_SEG_TEXT_MAX)
      text = text.slice(0, AGENT_SEG_TEXT_MAX) + "…";
    const o = { k: s.k, text, step: s.step != null ? s.step : null };
    if (s.callId) o.callId = s.callId;
    /* 会话轮号（本次需求）：随段一起落盘 —— 历史轨迹/检查器要按「第 N 轮」分组，
       在这一层丢掉它就等于新会话的历史也退回「全部」（老存档没这个字段 → 不写）。 */
    if (s.round != null) o.round = s.round;
    /* 段自己的起始时刻（本次需求「时间应当在每一项」）：与轮号同理，这一层丢掉它，
       刷新后每项左侧就没有自己的时刻了（老存档没这个字段 → 不写）。 */
    if (Number(s.at) > 0) o.at = Number(s.at);
    out.push(o);
  }
  return out.length ? out : null;
}
/* 历史消息能否按时间线分段渲染：段里重建出的正文（say + ⚠err 尾部）必须与
   content 完全一致（落盘裁剪过 / 无段时退回旧渲染，保证不丢字）。
   m._segNoBody（app-db.js attachTraceSegments 打的标）= 段里还留着思考，但 say 段
   拼不回 content（被单段上限截过）→ 正文必须走 m.content，段只用来还原时间线。 */
function dshMsgSegsViewable(m) {
  if (!m || m.role !== "assistant") return false;
  const segs = m.segments;
  if (!Array.isArray(segs) || !segs.length) return false;
  if (m._segNoBody) return false;
  const says = [];
  const errs = [];
  for (const s of segs) {
    if (!s) continue;
    const t = String(s.text || "");
    if (s.k === "say" && t.trim()) says.push(t);
    else if (s.k === "err" && t.trim()) errs.push(t);
  }
  if (!says.length && !errs.length) return false;
  const body = says.join("\n\n");
  const eTxt = errs.map((s) => "⚠ " + s).join("\n\n");
  const rebuilt = body && eTxt ? body + "\n\n" + eTxt : body || eTxt;
  return String(m.content || "") === rebuilt;
}
/* ── 过程行展示档位（对齐上游 ChatPresentationPolicy）──────────────────────
   上游把「过程行怎么显示」收成四个用户档位（settings.transcript.* =
   简洁 / 标准 / 详细 / 完全展开），派生两个策略位：
     showThink          思考画不画（简洁档不画；思考仍随消息存档）
     expandProcess      完全展开：工具卡也默认摊开
   **本次需求删掉了第三位 expandThink**（原来是「详细 / 完全展开：思考块落地即展开」）：
   会话里的思考一律收成一行摘要条、点开在弹窗里读（见 dshThinkRowEl），
   没有「展开 / 收起」这回事了 —— 档位再管「落地即展开」就是管一个不存在的东西。
   档位本身保留（简洁 / 标准 / 详细 / 完全展开），差异只剩 showThink 与 expandProcess。
   **不再有「已完成轮次的过程行折成一行」这一位**（历史需求 · 用户口径
   「不应当进行任何收纳：工具调用被折进折叠条就与它在时间线上的位置分离了」）：
   工具 / 上下文注入行一律按发生顺序内联渲染，档位只在上面两位上分档。
   本仓落点：设置 · 智能能力给**新会话的全局默认档**；输入区「模式」菜单那一枚 =
   会话级开关「显示思考」（点开 = 会话里出现思考条目，关闭 = 整条不显示；
   见 agentModeEntryOf("think") 与 agentThinkShown）。
   取值口径：会话上有布尔 st.showThink 就用它，否则用全局档位派生的 showThink；
   全局档位非法 / 缺失 → "standard"（上游默认档）。 */
const DSH_TRANSCRIPT_VIEWS = ["compact", "standard", "detailed", "verbose"];
/* 四档的默认档（上游 ChatPresentationPolicy 的 standard）：**唯一真源**，
   app-settings.js 也引用它 —— 别在别处再写一份 "standard" 字面量（冒烟钉着）。 */
const DSH_TRANSCRIPT_DEFAULT = "standard";
function dshTranscriptViewNorm(v) {
  const s = String(v || "").trim();
  return DSH_TRANSCRIPT_VIEWS.indexOf(s) >= 0 ? s : "";
}
function dshTranscriptViewGlobal() {
  try {
    return dshTranscriptViewNorm(S.config && S.config.dsh && S.config.dsh.transcriptView) || DSH_TRANSCRIPT_DEFAULT;
  } catch (_) {
    return "standard";
  }
}
/* 旧存档口径（会话上曾覆盖过档位）：迁移由 app-boot 做（档位 → 布尔开关），
   这里保留读取只是为了老对象（未迁移的会话对象）仍能算出同一条全局默认。 */
function dshTranscriptViewFor(st) {
  return dshTranscriptViewNorm(st && st.transcriptView) || dshTranscriptViewGlobal();
}
function dshTranscriptViewOfSessionId(nodeId) {
  const id = String(nodeId || "");
  if (!id) return dshTranscriptViewGlobal();
  try {
    const list = S.agentSessions;
    const st = Array.isArray(list) ? list.find((s) => s && s.id === id) : null;
    if (st) return dshTranscriptViewFor(st);
  } catch (_) {}
  return dshTranscriptViewGlobal();
}
function dshPolicyOfView(view) {
  const v = dshTranscriptViewNorm(view) || DSH_TRANSCRIPT_DEFAULT;
  return {
    view: v,
    /* 思考：简洁档整块不渲染（数据仍随消息存档），其余档给一行可点开的摘要条 */
    showThink: v !== "compact",
    /* 完全展开：工具卡也默认摊开 */
    expandProcess: v === "verbose",
  };
}
function dshPresentationPolicy() {
  return dshPolicyOfView(dshTranscriptViewGlobal());
}
/* 全局默认档派生出的「思考画不画」（简洁档 = false）—— 会话级开关没定过时用它 */
function dshThinkShownGlobal() {
  return dshPolicyOfView(dshTranscriptViewGlobal()).showThink;
}
/* 档位显示名（词条与设置 · 智能能力里那一行同一份，中英成对见 i18n.js） */
function dshTranscriptViewLabel(view) {
  switch (dshTranscriptViewNorm(view) || DSH_TRANSCRIPT_DEFAULT) {
    case "compact":
      return I18n.t("简洁");
    case "detailed":
      return I18n.t("详细");
    case "verbose":
      return I18n.t("完全展开");
    default:
      return I18n.t("标准");
  }
}

/* ── 「显示思考」判据（本次需求：会话里一枚开关，点开显示 / 关闭整条不显示）──
   会话级三态 st.showThink：
     true  = 显示（思考段照它有折叠条，仍可逐条点开）
     false = **整条不显示**（不是折叠：思考段根本不建 DOM，见 dshHistSegEl /
             agentLiveSegsEl 的 showThink===false 早退）
     未设置（null / undefined）= 跟随全局默认档（设置 · 智能能力 的 transcriptView）
   关掉只关显示：思考内容照旧随消息存档（msg.reasoning / msg.segments，
   见 agentRoundMsgTail）—— 随时打开就能看回来，绝不删数据。
   判据按「这条消息属于哪条会话」取（nodeId = 会话 id）：团队 / 节点会话 / 长任务 /
   助手栏那些视图拿到的不是会话 id（或不是这条会话），一律按全局默认档 ——
   开关只作用于会话视图本身。 */
function agentThinkOverrideOf(st) {
  return st && typeof st.showThink === "boolean" ? st.showThink : null;
}
function dshThinkShownFor(nodeId) {
  const id = String(nodeId || "");
  if (id) {
    /* 直接读会话表本体（S.agentSessions）：整表重绘里每条消息都问一次，
       走 agentSessions()（逐会话水合）太贵，冒烟钉着这一条。 */
    try {
      const list = S.agentSessions;
      const st = Array.isArray(list) ? list.find((s) => s && s.id === id) : null;
      const o = agentThinkOverrideOf(st);
      if (o !== null) return o;
    } catch (_) {}
  }
  return dshThinkShownGlobal();
}
/* 会话对象口径的同一条判据（live 渲染手里就是这条会话，不必再按 id 回查） */
function agentThinkShown(st) {
  const o = agentThinkOverrideOf(st);
  return o === null ? dshThinkShownGlobal() : o;
}

/* 一轮收尾：把运行中「已展开」的思考块状态带到刚落盘的历史消息上。
   live 段的展开键是 segthink:<会话 id>:<轨迹段序>，历史是 segthink:<会话 id>:<消息序>:<段序>，
   两者不同 —— 不搬一次，用户正展开的思考会在重绘后自动缩回（看起来像被藏起来）。
   think 段不丢不裁（见 agentSegsForDisk），第 k 个 think 段一一对应。 */
function agentCarryThinkOpenState(st, msg, runKey) {
  if (!st || !msg || !Array.isArray(msg.segments) || !S.openDshTools) return;
  const tr = S.runTrace && S.runTrace[traceRunKey(runKey)];
  const items = tr && Array.isArray(tr.items) ? tr.items : null;
  if (!items || !items.length) return;
  const openFlags = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || it.k !== "think") continue;
    openFlags.push(!!S.openDshTools["segthink:" + (st.id || "") + ":" + i]);
  }
  if (!openFlags.some(Boolean)) return;
  const msgIdx = (st.messages || []).length - 1;
  let k = 0;
  msg.segments.forEach((seg, n) => {
    if (!seg || seg.k !== "think") return;
    if (openFlags[k++])
      S.openDshTools["segthink:" + (st.id || "agent") + ":" + msgIdx + ":" + n] = true;
  });
}

/* ── 每步 usage 明细（本次需求 · 修「轨迹里每步 token 出和入会丢失」）──────────────
   病根：usage 帧只带 provider/model/at（dsh/gateway/gateway.mjs 的 accountUsage 不发
   turn/step），轨迹侧只能拿「段时刻」跟 usage 时刻比大小猜归步 —— 猜不准的那几步就
   永远显示「未记到」，或者被上一步吞掉（错位一步）。
   修法：**采集点自己带上归步键**（本函数），明细随助手消息落盘（m.usageSteps），
   轨迹渲染直接按键取数，不再猜：键 = (会话轮号 round, 网关步号 step)。
     · round = 该会话里用户第几次发送（S.runTrace[runKey].round，app-db.js 落号）——
       与轨迹轮头同一个号，用户的直觉口径；
     · step  = 网关内部的步号（轨迹段自己的 step 也是它，两边同源自证对齐）；
     · round 拿不到（节点运行 / 助手运行等非会话运行，用户口径：不记）→ 返回 false，
       轨迹侧照旧回落内存时间线（「拿不到轮号就不编号」，绝不编一个号出来）；
     · **同一步有多次模型调用**（同一步内多轮流式 / 子代理 / 续跑）→ 按 calls 累加、共用
       一行（用户口径：行内显示该步合计并标「N 次调用」）；
     · **重发不重复计**：整轮重发（runKey 同名的新一轮）由轨迹的 resetAt 判定并整份
       清掉旧账 —— 失败尝试的用量不再挂在同一步上（用户口径：只记最终成功那次）。
   invalid 的返回值语义：true = 采集侧已接手（调用方**不要**再往内存时间线里塞这条，
   免得同一条 usage 被两种口径各算一次）；false = 没接手，时间线照旧。 */
function tokUsageStepNote(st, runKey, data) {
  if (!st || !data) return false;
  const tr = typeof traceOf === "function" ? traceOf(runKey) : null;
  const round = tr && typeof traceNum === "function" ? traceNum(tr.round, 0) : 0;
  if (!(round > 0)) return false;
  const step = tr ? traceNum(tr.step, 0) : 0;
  const resetAt = tr ? Number(tr.resetAt) || 0 : 0;
  if (resetAt > (Number(st._usageStepsAt) || 0)) {
    st._usageSteps = [];
    st._usageStepsAt = resetAt;
  }
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const u = {
    turn: traceNum(tr.turn, 0),
    step: step,
    calls: 1,
    input: num(data.inputTokens),
    output: num(data.outputTokens),
    cacheRead: num(data.cacheReadTokens),
    cacheWrite: num(data.cacheWriteTokens),
    reasoning: num(data.reasoningTokens),
    provider: String(data.provider || ""),
    model: String(data.model || ""),
  };
  const list = (st._usageSteps = Array.isArray(st._usageSteps) ? st._usageSteps : []);
  const k = u.turn + ":" + u.step;
  let hit = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const x = list[i];
    if (x && Number(x.turn) === u.turn && Number(x.step) === u.step) {
      hit = x;
      break;
    }
  }
  if (hit) {
    for (const f of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) hit[f] += u[f];
    hit.calls += 1;
    if (u.provider) hit.provider = u.provider;
    if (u.model) hit.model = u.model;
  } else {
    list.push(u);
    /* 一步最多记 64 条：几十步的正常会话远够；真超了（异常长的并发流）也绝不长成
       无上限数组（用户口径：明细要与消息窗口同尺度、有裁剪）。 */
    if (list.length > 64) list.splice(0, list.length - 64);
  }
  return true;
}
/* 本轮明细交给收尾消息（app-assist.js 的 agentRoundMsgTail 调用）：
   挂一次就清空采集缓冲，下一轮从零开始；调用前先对齐轨迹的 resetAt（同一轮里
   连续多次采集不会互相清）。 */
function tokUsageStepsTake(st, runKey) {
  if (!st) return null;
  const tr = typeof traceOf === "function" ? traceOf(runKey) : null;
  const resetAt = tr ? Number(tr.resetAt) || 0 : 0;
  if (resetAt > (Number(st._usageStepsAt) || 0)) {
    st._usageSteps = [];
    st._usageStepsAt = resetAt;
  }
  const list = Array.isArray(st._usageSteps) ? st._usageSteps : [];
  st._usageSteps = [];
  return list.length ? list : null;
}

/* 一轮收尾消息的公共尾巴：思考 / 段快照 / 工具清单 ─────────────────────────
   正常结束、被终止、出错三条收尾路径**共用一份口径**（需求「一轮结束后不要自动隐藏
   或删除思考」）：think 段拼出的纯思考必须随消息归档（msg.reasoning + msg.segments）。
   旧口径只有「正常结束」那条挂了这一份尾巴，终止与出错两条各 push 一条只有正文的消息 ——
   那一轮里已经流式显示过的思考与工具时间线在收尾那一刻被整段丢掉，正是用户报的
   「会话中的思考内容被错误移除了」。
   runKey = 该会话这一轮的轨迹键（"agent:<会话id>"）；调用时机：msg.content 已写好。
   段快照沿用既有落盘口径（agentSegsForDisk 只夹单段字数、段一条不丢；拼不回正文时
   历史渲染自动退回整段 reasoning，一个字都不丢）。 */
function agentRoundMsgTail(st, msg, runKey) {
  if (!msg || !runKey) return msg;
  const rsnLegacy =
    (S.thinking && S.thinking[runKey] && S.thinking[runKey][0]) || "";
  const rsn =
    typeof traceThinkDisplay === "function"
      ? traceThinkDisplay(runKey, rsnLegacy)
      : rsnLegacy;
  if (String(rsn).trim()) msg.reasoning = rsn;
  if (st && Array.isArray(st._liveTools) && st._liveTools.length)
    msg.tools = st._liveTools.slice();
  /* 每步 usage 明细（本次需求 · 修「每步 token 丢失」）：带上 (轮号, 步号) 随消息落盘 ——
     历史轨迹（切走再切回、重启后）直接按键取数，不再靠时刻猜归步。
     三条收尾路径（正常结束 / 终止 / 出错）都走本函数，故**终止与出错那一轮的用量同样留住**。 */
  try {
    const steps = typeof tokUsageStepsTake === "function" ? tokUsageStepsTake(st, runKey) : null;
    if (steps) msg.usageSteps = steps;
  } catch (_) {}
  try {
    const segs =
      typeof agentSegsForDisk === "function"
        ? agentSegsForDisk(
            typeof traceSegmentsOf === "function" ? traceSegmentsOf(runKey) : null,
          )
        : null;
    if (segs && segs.length) msg.segments = segs;
  } catch (_) {}
  return msg;
}

/* ==================== 「思考」翻译（右侧小按钮） ====================
   需求：会话里的每一段「思考」旁边给一个小按钮，点了就把这段思考翻译出来给用户看。
   口径（三条，缺一不可）：
     · 模型 = **该会话自己的模型**（dshTranslateScopeModel：scope 的会话 st.provider /
       st.model，节点绑定会话按 node.agentSessionId / devSessionIds 找回）——
       会话选哪家哪只就用哪家哪只，与这一轮推理同一份服务商与配额；
       会话那一位取不到（老会话没选过模型且这家没有模型）才回落旧口径：
       默认智能路由（preferredAgentProviderRoute）+ 该路由的 flash 档优先；
     · 无思考：spec.effort = "off" ⇒ main.js applyTextThinkingEffort 下发
       thinking:{type:"disabled"}，翻译请求不带推理，快且省；
     · 译文校验 + 逐档重试：实测 flash 会原样复述英文原文或只回「以下是翻译：」，
       这类返回一律不通过（dshXlateLooksTranslated），按「同模型常规提示词 → 同模型
       强化提示词 → 该路由更强模型」逐档重试，全失败才判 error（绝不当成功缓存）；
     · 按段缓存（S.thinkTrans），同一段只翻一次，命中即显示译文，可重复点开看。
   思考段有两种渲染（历史消息 dshHistSegEl / 运行中 agentLiveSegsEl）与两种形态
   （按段的时间线 seg、无段时的整段 m.reasoning），所以按钮 + 译文框拆成两个 builder
   （dshThinkTranslateBtn / dshThinkTranslateRow），共用同一份状态。
   **本次需求（用户口径）后它只活在思考弹窗里，而且只往一个地方写**：会话里那一行摘要条
   （dshThinkRowEl）不挂按钮、也没有译文行；窗里**只有原文框**（翻译按钮挂在它的栏头），
   点过翻译之后译文框才建出来（未点翻译时不显示译文框），译文本体写在译文框栏头**下方**
   的框里 —— 翻完由 dshThinkPopPaintXlate 就地刷新那一个框（弹窗可能已被重画，按 DOM 找，
   不 captured 引用）。原文与译文正文都按 Markdown 渲染（dshThinkMdHtml）。 */
function dshThinkTransKey(scopeId, segKey) {
  return String(scopeId || "") + ":" + String(segKey == null ? "" : segKey);
}
function dshThinkTransItem(scopeId, segKey) {
  const store = S.thinkTrans || (S.thinkTrans = {});
  return store[dshThinkTransKey(scopeId, segKey)] || null;
}
/* 翻译用谁：**该会话自己的模型**（会话 / 智能任务节点 / 开发块绑定会话各自选的
   供应商 + 模型），会话那一位没选到才回落旧口径（默认智能路由 + flash 优先）。
   返回 {route, model, prov} —— prov 由 dshTranslateProvider 解析，null = 这家没可用
   API Key（调用方据此报「未找到可用文本服务商」）。 */
function dshTranslateModel(scopeId) {
  const own = dshTranslateScopeModel(scopeId);
  if (own && own.route && own.model) {
    const prov = dshTranslateProvider(own.route);
    if (prov) return { route: own.route, model: own.model, prov };
  }
  const flash = dshTranslateFlashModel();
  return { route: flash.route, model: flash.model, prov: flash.prov };
}
/* scope 的会话对象：scopeId 既可能是会话 id（助手栏 / 长任务 / 团队对话），
   也可能是画布节点 id（智能任务 / remotion / 开发块 —— 这些节点的会话记在
   node.agentSessionId（开发块另有 devSessionIds / devAskSessionId））。 */
function dshXlateSessionOf(scopeId) {
  const sid = String(scopeId || "").trim();
  if (!sid) return null;
  const byId = typeof agentSessionById === "function" ? agentSessionById(sid) : null;
  if (byId) return byId;
  const nodes =
    S.wf && Array.isArray(S.wf.nodes)
      ? S.wf.nodes
      : typeof allNodes === "function"
        ? allNodes() || []
        : [];
  const node = nodes.find((n) => n && n.id === sid);
  if (!node) return null;
  const list = typeof agentSessions === "function" ? agentSessions() : [];
  const ids = [];
  if (node.agentSessionId) ids.push(node.agentSessionId);
  if (node.devAskSessionId) ids.push(node.devAskSessionId);
  if (Array.isArray(node.devSessionIds)) ids.push.apply(ids, node.devSessionIds);
  for (const id of ids) {
    const s = list.find((x) => x && x.id === id);
    if (s) return s;
  }
  return null;
}
/* 「该会话自己的模型」：st.provider / st.model 是运行时就近真源（见 app.js
   createDevSessionForNode、ensureAgentSessionForNode，节点参数优先同步进会话）；
   模型没写就取这家第一只（与运行时下发同一口径：provider + model 成对解析，
   绝不出现「A 家的模型配 B 家路由」）。取不到可用服务商 / 模型 → null。 */
function dshTranslateScopeModel(scopeId) {
  let route = "";
  let model = "";
  try {
    const st = dshXlateSessionOf(scopeId);
    if (st) {
      route = String(st.provider || "").trim();
      model = String(st.model || "").trim();
    }
  } catch (_) {}
  if (!route) return null;
  if (route !== "deepseek-official" && route.indexOf("mtnode_") !== 0) return null;
  if (!dshTranslateProvider(route)) return null;
  let models = [];
  try {
    models =
      typeof agentModelsForRoute === "function"
        ? agentModelsForRoute(route) || []
        : [];
  } catch (_) {
    models = [];
  }
  if (!model) model = String(models[0] || "");
  /* 会话存的模型已不在该服务商清单里（用户改了这家模型 / 旧存档）⇒ 用该家第一只，
     绝不拿一只这家根本没有的模型去发（那是 400）。清单都取不到就照会话存的发。 */
  else if (models.length && !models.some((m) => String(m) === model))
    model = String(models[0] || "");
  if (!model) return null;
  return { route, model };
}
/* 回落口径（会话那一位不可用时）：默认路由下优先 flash（无思考 + 快），否则默认模型 */
function dshTranslateFlashModel() {
  let route = "";
  try {
    route =
      typeof preferredAgentProviderRoute === "function"
        ? String(preferredAgentProviderRoute() || "")
        : "";
  } catch (_) {}
  if (!route) {
    try {
      route =
        typeof defaultAgentProviderRoute === "function"
          ? String(defaultAgentProviderRoute() || "")
          : "";
    } catch (_) {}
  }
  if (!route) route = "deepseek-official";
  let models = [];
  try {
    models =
      typeof agentModelsForRoute === "function"
        ? agentModelsForRoute(route) || []
        : [];
  } catch (_) {
    models = [];
  }
  const flash = models.find((m) => /flash/i.test(String(m || "")));
  let model = "";
  if (flash) model = String(flash);
  else {
    try {
      model =
        typeof preferredAgentModelForRoute === "function"
          ? String(preferredAgentModelForRoute(route) || "")
          : "";
    } catch (_) {}
    if (!model) model = String(models[0] || "");
  }
  return { route, model, prov: dshTranslateProvider(route) };
}
function dshTranslateProvider(route) {
  try {
    if (typeof providerForAgentRoute === "function") {
      const p = providerForAgentRoute(route);
      if (p && String(p.apiKey || "").trim()) return p;
    }
  } catch (_) {}
  return null;
}
/* ── 403「not eligible」：服务商 / 套餐没买到这个模型 ──
   实测阿里云百炼 Token Plan 域名（token-plan.cn-beijing.maas.aliyuncs.com）对**所有**模型回
   403 {"type":"AccessDenied.Unpurchased","message":"Access to model denied. Please make
   sure you are eligible for using the model."}；这条错误重发几次都是同一结果，属于
   「重发也不会有别的结果」的配置类失败（见 app-db.js 的重发闸注释）。
   判据 = 报文自身（含网关 / 主进程给正文加的 HTTP 状态前缀），不看是哪个服务商。 */
function dshAccessDeniedText(s) {
  const t = String(s || "");
  return /AccessDenied|Unpurchased|not eligible|not_eligible|ineligible|(^|[^0-9])403([^0-9]|$)/i.test(t);
}
/* 按「会话自己的路由优先，其后依次其它可用路由」排出的翻译路由候选 */
function dshXlateRoutes(route, scopeId) {
  const out = [];
  const push = (r) => {
    const rr = String(r || "").trim();
    if (!rr || out.indexOf(rr) >= 0) return;
    if (typeof providerForAgentRoute !== "function") return;
    let ok = null;
    try {
      ok = providerForAgentRoute(rr);
    } catch (_) {}
    if (ok && String(ok.apiKey || "").trim()) out.push(rr);
  };
  /* 该会话自己的路由（st.provider）优先：403 换模型时先在同家挑另一只 */
  try {
    const own = dshTranslateScopeModel(scopeId);
    if (own && own.route) push(own.route);
  } catch (_) {}
  push(route);
  try {
    if (typeof agentRouteOptions === "function")
      for (const r of agentRouteOptions()) push(r);
  } catch (_) {}
  try {
    if (typeof preferredAgentProviderRoute === "function")
      push(preferredAgentProviderRoute());
  } catch (_) {}
  try {
    if (typeof defaultAgentProviderRoute === "function")
      push(defaultAgentProviderRoute());
  } catch (_) {}
  return out;
}
/* 403 时弹窗问用户是否换一个模型来翻译（不静默降级，也不改用户没答应的配置）。
   候选 = 每条可用路由的模型清单，当前这条的那个模型不重复列出；返回 {route, model} 或 null。 */
async function dshXlateAskSwitchModel(failedRoute, failedModel, errText, scopeId) {
  if (typeof confirmDialog !== "function") return null;
  const routes = dshXlateRoutes(failedRoute, scopeId);
  const cur = String(failedRoute || "").trim();
  const nameOf = (r) =>
    typeof agentProviderNameNow === "function" ? agentProviderNameNow(r) : r;
  const alts = [];
  for (const r of routes) {
    let models = [];
    try {
      models =
        typeof agentModelsForRoute === "function"
          ? agentModelsForRoute(r) || []
          : [];
    } catch (_) {}
    for (const m of models) {
      const mm = String(m || "").trim();
      if (!mm) continue;
      if (r === cur && mm === String(failedModel || "").trim()) continue;
      alts.push({ route: r, model: mm });
    }
  }
  if (!alts.length) return null;
  const picked = alts[0]; /* 当前路由在前 = 默认同家换个模型，无则换到下一家 */
  const lines = [
    I18n.t("模型服务返回 403：该模型/套餐未开通（服务商原话：Access to model denied… not eligible）。"),
    "",
    I18n.t("当前：") + nameOf(cur) + " · " + String(failedModel || I18n.t("（未选择）")),
  ];
  if (String(errText || "").trim()) lines.push(I18n.t("原始报文：") + String(errText).slice(0, 200));
  lines.push("");
  lines.push(
    I18n.t("换一个模型来翻译？将改用：") + nameOf(picked.route) + " · " + picked.model,
  );
  const ok = await confirmDialog(lines.join("\n"), {
    title: I18n.t("换模型"),
    okText: I18n.t("换并重试"),
    cancelText: I18n.t("不换"),
  });
  return ok ? picked : null;
}
/* 采纳选中的替代模型（spec 与候选链共用一份解析口径：agent 路由是全局函数 + 可选覆盖） */
function dshXlatePick(route, model) {
  const r = String(route || "").trim();
  return {
    route: r,
    model: String(model || "").trim(),
    prov:
      typeof providerForAgentRoute === "function"
        ? providerForAgentRoute(r)
        : null,
  };
}

/* 换一只「另一只模型」来翻：按本机可用路由逐家挑。
   现场（本次需求）：会话自己那只（deepseek-official · deepseek-v4-flash）与全局助手那只
   （mtnode_qwen-token-plan-cn · deepseek-v4.1-flash）对同一段思考都原样复述，而候选链里
   只有这两只同族 flash ⇒ 逐档重试其实是「同一只模型发两遍确定性请求」，第 2 遍必然同结果，
   用户看到的永远是「翻译质量校验未通过（模型仍在输出原文）｜模型仍返回原文，已重试 2 次」。
   对策：候选链必须真的换模型（换路由），flash 档优先、其余按原顺序。 */
function dshXlateRankModels(models) {
  const list = (models || []).map((m) => String(m || "").trim()).filter(Boolean);
  const flash = list.filter((m) => /flash/i.test(m));
  const rest = list.filter((m) => !/flash/i.test(m));
  return flash.concat(rest);
}
function dshXlateAltCandidates(route, tried) {
  const out = [];
  const skip = (r, m) => {
    const rr = String(r || "").trim();
    const mm = String(m || "").trim();
    return tried.some((t) => t.route === rr && t.model === mm);
  };
  let routes = [];
  try {
    if (typeof agentRouteOptions === "function") routes = agentRouteOptions() || [];
  } catch (_) {
    routes = [];
  }
  for (const r of routes) {
    const rr = String(r || "").trim();
    if (!rr || rr === String(route || "").trim()) continue;
    if (typeof providerForAgentRoute !== "function") continue;
    let prov = null;
    try {
      prov = providerForAgentRoute(rr);
    } catch (_) {}
    if (!prov || !String(prov.apiKey || "").trim()) continue;
    let models = [];
    try {
      models =
        typeof agentModelsForRoute === "function"
          ? agentModelsForRoute(rr) || []
          : [];
    } catch (_) {
      models = [];
    }
    for (const m of dshXlateRankModels(models)) {
      if (skip(rr, m)) continue;
      out.push({ route: rr, model: m });
    }
  }
  return out;
}
/* 翻译候选链：同一条思考按「便宜优先」逐档重试，**每档必须换一只真模型**。
   实测（DeepSeek 官方 deepseek-v4-flash / v4-pro · thinking disabled）会**原样复述英文原文**
   或只输出「以下是对这段思考的翻译：」这类元话术 —— 旧实现把这种返回也当成功缓存，
   于是用户看到「译文」还是英文。对策：提示词收紧（system + user 分离，见下方 spec）+
   译文校验 + 逐档重试，全部候选都拿不到像样译文才判失败（错误行里可点「重试翻译」）。
   档序：① 该会话自己的模型 · 常规提示词 → ② 别的可用模型（换路由，flash 优先）· 常规提示词 →
   ③ 该会话自己的模型 · 强化提示词 → ④ 该路由默认（更强）模型 · 强化提示词。
   tried 去重键含路由：换了家之后的同名模型（各家都挂 deepseek-v4-flash）才会被当成新档。 */
function dshTranslateCandidates(route, model, scopeId) {
  const out = [];
  const tried = [];
  const push = (m, strict, r) => {
    const mm = String(m || "").trim();
    const rr = String(r == null ? route : r || "").trim();
    if (!mm) return;
    const key = rr + "\u0000" + mm;
    if (out.some((c) => c.key === key)) return;
    out.push({ model: mm, strict: !!strict, route: rr, key: key });
    tried.push({ route: rr, model: mm });
  };
  /* ① 首选：该会话自己的模型 · 常规提示词 */
  push(model, false);
  /* ② 换模型：别的可用路由上的模型（flash 优先）· 常规提示词 —— 这一步保证「重试」是一次
     真正的换模型，而不是把同一只模型的同一份确定性请求再发一遍。 */
  for (const a of dshXlateAltCandidates(route, tried)) push(a.model, false, a.route);
  /* ③ 同模型 + 强化提示词（补「你是翻译引擎 / 不要分析任务」的卡口） */
  push(model, true);
  /* ④ 升档：该路由的默认（更强）模型 · 强化提示词 */
  let strong = "";
  try {
    strong =
      typeof preferredAgentModelForRoute === "function"
        ? String(preferredAgentModelForRoute(route) || "")
        : "";
  } catch (_) {}
  push(strong, true);
  return out;
}
/* 输出疑似「复述原文 / 元话术」而非译文时判不通过。
   实测口径（本次需求补齐第 4 条 —— 它就是「翻译质量校验未通过」的真凶）：
     · 输出与原文**同文**（去空白后逐字相同，或字符级重合度过高）⇒ 复述，不通过。
       DeepSeek 的思考大多是「英文推理 + 本项目的中文原文 / 路径 / 术语」，这种混合文本
       仍带中文 ⇒ 旧口径只要见中文就放行（第一条 / 第二条），于是「原样吐回来」被当成译文，
       用户看到「译文」还是原文；反过来，模型有时把同一段回得一字不差，
       所以同文判据必须放在语言占比判据**前面**，且与原文语言无关。
     · 输出没有中文，且原文以中文为主 ⇒ 这是「中文→英文」的译文，通过；
     · 输出没有中文，原文也以英文为主 ⇒ 模型原样吐回英文（复述），不通过；
     · 原文以英文为主时，正文（剔掉代码块 / 行内码 / 链接 / 路径后的可读文字）前 400 字
       英文占比 ≥ 80% ⇒ 仍是复述；代码与路径不算「没翻译」，所以先把它们剔掉再算占比；
     · 开头就是「以下是这段思考的翻译：」式元话术（回的是任务分析不是译文）⇒ 不通过。 */
const DSH_XLATE_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
function dshXlateProse(s) {
  return String(s || "")
    .replace(DSH_XLATE_CODE_RE, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/[A-Za-z]:\\[^\s）)，,；;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/* 同文判据：正常化（只留中日韩文字与字母数字）后的逐字相同，或字符级重合度 ≥ 0.8
   （阈值 0.8 是实测取的口径：模型对同一段文本的复述常常只多/少一两个标点，
   而真译文与原文的重合度远低于它）。太短（< 40 字）的返回不判同文，
   否则「是的」「OK」这类短答也会被算成复述。 */
function dshXlateEchoes(src, out) {
  const norm = (s) =>
    String(s || "")
      .replace(DSH_XLATE_CODE_RE, " ")
      .replace(/[\s\u3000]+/g, "")
      .replace(/[*_>#\-|`~\[\]()]/g, "");
  const a = norm(src);
  const b = norm(out);
  if (a && b && a === b) return true;
  if (a.length < 40 || b.length < 40) return false;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i + 4 <= s.length; i++) set.add(s.slice(i, i + 4));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return false;
  let hit = 0;
  for (const g of gb) if (ga.has(g)) hit++;
  return hit / gb.size >= 0.8;
}
function dshXlateLooksTranslated(src, out) {
  const text = String(out || "").trim();
  if (!text) return false;
  /* ⓪ 同文 / 复述：与原文语言无关，先判（DeepSeek 的混合中英思考最常命中这一条） */
  if (dshXlateEchoes(src, text)) return false;
  const isCjk = (s) => (String(s || "").match(/[\u4e00-\u9fff]/g) || []).length;
  const isLat = (s) => (String(s || "").match(/[A-Za-z]/g) || []).length;
  const srcCjk = isCjk(src);
  const srcLatin = isLat(src);
  const srcMostlyCjk = srcCjk > srcLatin;
  const prose = dshXlateProse(text);
  if (!/[\u4e00-\u9fff]/.test(text)) return srcMostlyCjk;
  if (srcMostlyCjk) return true; /* 目标是英文译文，有内容即算通过 */
  const head = prose.slice(0, 400);
  const cjk = isCjk(head);
  const latin = isLat(head);
  const latinRatio = latin / (latin + cjk + 1);
  if (latin > 0 && latinRatio >= 0.8) return false;
  /* 元话术抬头：「以下是……翻译：」这类开头说明模型在描述任务而不是翻译 */
  if (
    /^(以下|下面是|这是|这里是|如下)/.test(text.slice(0, 60)) &&
    /(翻译|译文|translation)/i.test(text.slice(0, 60)) &&
    text.slice(0, 60).includes("：")
  ) {
    return false;
  }
  return true;
}
/* 思考原文 / 译文正文 → HTML（本次需求「内容显示时支持 markdown，翻译也应当注意格式」）。
   两道底线：
     · HTML 先转义再交给应用唯一那份 Markdown 渲染入口（app-review.js 的 rvMarkdownHtml，
       带公式渲染），模型输出因此不会被当 HTML 执行 —— 与旧口径（plainTextToLinkHtml）
       同一条安全底线；
     · 渲染入口拿不到（老构建 / 切片冒烟）就退回旧写法，绝不白框。 */
function dshThinkMdHtml(raw) {
  const s = String(raw || "");
  if (!s.trim()) return "";
  const esc =
    typeof escapeHtml === "function"
      ? escapeHtml(s)
      : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    if (typeof rvMarkdownHtml === "function") {
      const h = rvMarkdownHtml(esc);
      if (h) return h;
    }
  } catch (_) {}
  return typeof plainTextToLinkHtml === "function" ? plainTextToLinkHtml(s) : esc;
}
/* 译文框：栏头（译文 · 模型 · 复制）+ **栏头下方的正文框**（Markdown）。翻译中就写一句
   「翻译中…」，翻失败就在栏头给红字原因（正文留空）—— 三种状态都只占这一个框。 */
function dshThinkTranslateRow(scopeId, segKey) {
  const it = dshThinkTransItem(scopeId, segKey);
  if (!it) return null;
  const row = document.createElement("div");
  row.className = "dsh-seg dsh-seg-xlate";
  row.dataset.xlateKey = dshThinkTransKey(scopeId, segKey);
  row.addEventListener("mousedown", (ev) => ev.stopPropagation());
  const head = document.createElement("div");
  head.className = "dsh-xlate-head";
  const tag = document.createElement("span");
  tag.className = "dsh-xlate-tag";
  if (it.status === "error") {
    tag.textContent = I18n.t("⚠ 翻译失败");
    head.appendChild(tag);
    const msg = document.createElement("span");
    msg.className = "dsh-xlate-err";
    msg.textContent = String(it.error || "");
    head.appendChild(msg);
  } else {
    tag.textContent = I18n.t("译文");
    if (it.model) {
      const md = document.createElement("span");
      md.className = "dsh-xlate-model";
      md.textContent = String(it.model);
      head.appendChild(tag);
      head.appendChild(md);
    } else {
      head.appendChild(tag);
    }
    if (it.status === "done") {
      const cp = document.createElement("button");
      cp.type = "button";
      cp.className = "dsh-xlate-copy";
      cp.textContent = I18n.t("复制");
      cp.title = I18n.t("复制译文到剪贴板");
      cp.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const done = () => {
          cp.textContent = I18n.t("已复制");
          setTimeout(() => {
            cp.textContent = I18n.t("复制");
          }, 1200);
        };
        dshClipboardWrite(String(it.text || ""))
          .then((r) => {
            if (r && r.ok === false) toast(I18n.t("复制失败"), "err");
            else done();
          })
          .catch(() => toast(I18n.t("复制失败"), "err"));
      });
      head.appendChild(cp);
    }
  }
  row.appendChild(head);
  if (it.status !== "error") {
    const bodyEl = document.createElement("div");
    bodyEl.className = "dsh-xlate-md md-viewer-doc";
    if (it.status === "pending") bodyEl.textContent = I18n.t("翻译中…");
    else bodyEl.innerHTML = dshThinkMdHtml(it.text);
    row.appendChild(bodyEl);
  } else if (String(it.raw || "").trim()) {
    /* 失败时把「模型到底回了什么」摆在译文框里（本次需求）：这条报错原本只说
       「校验未通过」，用户看不到返回内容，无从判断是模型复述还是提示词不对。
       只做展示与复制，不写成 it.text —— 失败态不得被当成译文缓存。 */
    const why = document.createElement("div");
    why.className = "dsh-xlate-why";
    why.textContent = I18n.t(
      "模型没有给出译文，以下是它本次返回的内容（点「重试翻译」会换一只模型再试）",
    );
    row.appendChild(why);
    const raw = document.createElement("div");
    raw.className = "dsh-xlate-md dsh-xlate-raw md-viewer-doc";
    raw.innerHTML = dshThinkMdHtml(it.raw);
    row.appendChild(raw);
  }
  return row;
}
/* 单段翻译送入的最大字符数：思考落盘上限是 12000（与 app-boot 的 reasoning 截断同口径），
   超了只翻前 12000 字并注明截断 —— 避免一段超长推理把翻译请求顶成巨量 token。 */
const DSH_XLATE_MAX = 12000;
async function dshTranslateThinking(btn, scopeId, segKey, text, sig) {
  const store = S.thinkTrans || (S.thinkTrans = {});
  const key = dshThinkTransKey(scopeId, segKey);
  /* 就地刷新弹窗里那一个译文框（本次需求）：正文只写在译文框栏头下方的框里 ——
     旧写法是「在按钮所在的那个元素后面插一行」，按钮挂在栏头里，于是译文框被插进栏头，
     再被 dshThinkPopPaintXlate 在正文区画一次，用户看到的就是多出来的两个框。 */
  const paintXlate = () => {
    try {
      dshThinkPopPaintXlate(scopeId, segKey);
    } catch (_) {}
  };
  const paint = (it) => {
    btn.disabled = it.status === "pending";
    btn.textContent =
      it.status === "pending"
        ? I18n.t("翻译中…")
        : it.status === "error"
          ? I18n.t("重试翻译")
          : I18n.t("翻译");
    btn.classList.toggle("on", it.status === "done");
    btn.title =
      it.status === "error"
        ? String(it.error || I18n.t("翻译失败"))
        : I18n.t("用该会话自己的模型（无思考）翻译这段思考");
    paintXlate();
  };
  if (!String(text || "").trim()) return;
  const cached = store[key];
  if (cached && cached.status === "done") {
    paintXlate();
    return;
  }
  const first = dshTranslateModel(scopeId);
  if (!first.prov) {
    toast(
      I18n.t("未找到可用文本服务商（请在设置 · API/配置中配置并填写 API Key）"),
      "err",
    );
    return;
  }
  if (!first.model) {
    toast(I18n.t("未找到可用模型（请在设置中选择该服务商的模型）"), "err");
    return;
  }
  const it = {
    status: "pending",
    text: "",
    model: first.model,
    sig: sig,
  };
  store[key] = it;
  paint(it);
  const src = String(text || "");
  const body =
    src.length > DSH_XLATE_MAX
      ? src.slice(0, DSH_XLATE_MAX) + "\n\n（原文过长，以上为前一段）"
      : src;
  /* 译文上限：随原文放宽（源文本 12000 字，译文可能更长），避免被服务端默认
     max_tokens 截在半句 —— 截断的译文本不完整，却会被当成成功。 */
  const maxTok = Math.min(16384, Math.max(4096, Math.ceil(body.length / 2) + 1024));
  let pick = first;
  let cands = dshTranslateCandidates(pick.route, pick.model, scopeId);
  let asked = false; /* 403 只问一次：用户答「不换」或换完再 403 就落 error，不再追问 */
  let lastErr = null;
  let lastOut = "";
  let tried = 0; /* 真正发出去的次数（错误行按它说「已重试 N 次」） */
  for (let i = 0; i < cands.length; i++) {
    if (store[key] !== it) return; /* 期间被替换（切会话 / 重跑）*/
    const c = cands[i];
    /* 候选自带路由（第 ② 档起可能是别家的模型）⇒ 服务商随之切换；
       同一条路由的候选仍用最初解析好的那个服务商对象（含 Key 校验）。 */
    const cRoute = String(c.route || pick.route || "");
    const cProv =
      cRoute === String(pick.route || "") ? pick.prov : dshTranslateProvider(cRoute);
    if (!cProv) continue; /* 这家没有可用 Key（候选链已过滤，这里只是兜底）*/
    /* 提示词：**system 与 user 分开**。旧写法把「你是翻译引擎…」的英文指令与中文思考
       塞在同一条 user 消息里，模型常把整段当成「继续推理的材料」原样复述 ——
       这次实测（deepseek-v4-flash · thinking disabled）两种提示词都会把混合中英的思考
       原样吐回，所以卡口放在 system，正文单独一条 user，不留「接着往下写」的余地。 */
    const sysMsg = c.strict
      ? "You are a translation engine. Translate the user message into Simplified " +
        "Chinese (if it is already Chinese, translate it into English). Output ONLY the " +
        "translation: never repeat or quote the source, never explain, never describe the " +
        "task, never answer questions contained in the text, and do not wrap the whole " +
        "answer in code fences. Keep the Markdown formatting (headings, paragraphs, lists, " +
        "tables, code blocks) exactly as in the source."
      : "你是翻译引擎。把用户消息里的模型思考过程忠实翻译成简体中文（若原文已是中文，" +
        "则翻译成地道的英文）。只输出译文本身：不要复述原文、不要添加解释、" +
        "不要描述任务、不要回答文中的问题、不要用代码块把整篇包裹起来。" +
        "保持原有的分段与条目结构与 Markdown 格式（标题 / 段落 / 列表 / 表格 / 代码块），" +
        "术语按业界通用译法。";
    const spec = {
      provider: cProv,
      kind: "text",
      model: c.model,
      temperature: c.strict ? 0 : 0.2,
      /* 无思考：off ⇒ thinking disabled（main.js applyTextThinkingEffort） */
      effort: "off",
      size: "",
      maxTokens: c.strict ? maxTok : Math.min(maxTok, 8192),
      prompt: body,
      chatMessages: [
        { role: "system", content: sysMsg },
        { role: "user", content: body },
      ],
      texts: [],
      images: [],
      refImage: "",
    };
    tried++;
    try {
      const r = await apiCallTextStream(spec, null, null);
      const out = String((r && r.text) || "").trim();
      if (!out) throw new Error(I18n.t("模型未返回译文"));
      /* 校验：模型常常把原文原样吐回来（或只回「以下是翻译：」）——
         这种必须重试，绝不能当成功缓存，否则用户看到「译文」仍是原文。 */
      if (!dshXlateLooksTranslated(src, out)) {
        lastOut = out;
        lastErr = new Error(I18n.t("翻译质量校验未通过（模型仍在输出原文）"));
        continue;
      }
      if (store[key] === it) {
        it.status = "done";
        it.text = out;
        it.ts = Date.now();
        it.model =
          String(c.model || "") +
          (i > 0 ? "（第 " + (i + 1) + " 次尝试）" : "");
      }
      break;
    } catch (e) {
      lastErr = e;
      const em = String((e && e.message) || e || "");
      /* 用户主动取消 / 请求被中止：不再往下试，直接落 error */
      if (/abort|cancel|取消|已终止/i.test(em)) break;
      /* 403「not eligible」= 这家服务商 / 这个套餐没买到该模型（实测阿里云百炼 Token
         Plan 域名对所有模型都回它）。同一家的其它档与更强档必然同结果 → 不再白试，
         弹窗问用户是否换一个模型（不改用户没答应的配置，也不静默降级）。 */
      if (dshAccessDeniedText(em)) {
        lastErr = e;
        if (!asked) {
          asked = true;
          const sw = await dshXlateAskSwitchModel(cRoute, c.model, em, scopeId);
          if (store[key] !== it) return;
          if (sw) {
            const np = dshXlatePick(sw.route, sw.model);
            if (np.prov) {
              pick = np;
              it.model = np.model;
              cands = dshTranslateCandidates(np.route, np.model, scopeId);
              i = -1; /* 换家后从候选链第 1 档重来 */
              continue;
            }
            lastErr = new Error(
              I18n.t("换模型失败：该服务商没有可用的 API Key"),
            );
          }
        }
        break;
      }
    }
  }
  if (store[key] === it && it.status !== "done") {
    it.status = "error";
    it.error =
      (lastErr && lastErr.message ? lastErr.message : String(lastErr || I18n.t("翻译失败"))) +
      (lastOut
        ? "｜模型仍返回原文，已重试 " + Math.max(0, tried - 1) + " 次"
        : "");
    /* 被拒的那一版留在项上：用户能在译文框里看到「模型到底回了什么」，
       不必靠猜（本次需求的现场就是这个提示，看不到返回内容无从判断）。 */
    it.raw = lastOut;
  }
  if (store[key] === it) {
    paint(it);
    /* 思考弹窗也画着同一条译文：翻完就把它那一栏就地换掉（弹窗可能已被重画，按 DOM 找） */
    try {
      dshThinkPopPaintXlate(scopeId, segKey);
    } catch (_) {}
  }
}
/* 思考段右侧小按钮。本次需求后它只活在思考弹窗里（会话里那一行摘要条不再挂按钮），
   stopPropagation 仍然全留着：弹窗里的按钮祖先链上还有可点的行 / 宿主，别让一次
   点击顺带把窗关了。 */
function dshThinkTranslateBtn(text, scopeId, segKey, sig) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "dsh-think-xlate";
  const it = dshThinkTransItem(scopeId, segKey);
  b.textContent = it && it.status === "pending" ? I18n.t("翻译中…") : I18n.t("翻译");
  if (it && it.status === "pending") b.disabled = true;
  if (it && it.status === "done") b.classList.add("on");
  b.title =
    it && it.status === "error"
      ? String(it.error || I18n.t("翻译失败"))
      : I18n.t("用该会话自己的模型（无思考）翻译这段思考");
  b.addEventListener("mousedown", (ev) => ev.stopPropagation());
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (it && it.status === "pending") return;
    dshTranslateThinking(b, scopeId, segKey, String(text || ""), sig);
  });
  b.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
      ev.preventDefault();
      ev.stopPropagation();
    }
  });
  return b;
}
/* 译文一变就刷新弹窗里的译文框（翻译是异步的：发起后弹窗可能已经被重画过，
   所以刷新走 DOM 查找、不 captured 元素引用）。
   口径（本次需求）：**未点翻译时不显示译文框**，所以这一栏是按需建 / 按需收的 ——
   点过翻译（翻译中 / 已成 / 失败）才在原文框**下面**建出这一栏，正文只往它栏头下方的
   框里写；没有译文项就把整栏收掉。 */
function dshThinkPopPaintXlate(scopeId, segKey) {
  const root = document.querySelector(
    '.dsh-think-pop[data-xkey="' + String(dshThinkTransKey(scopeId, segKey)) + '"]',
  );
  if (!root) return null;
  let col = root.querySelector('.dsh-think-pop-col[data-think-pop="xlate"]');
  const r = dshThinkTranslateRow(scopeId, segKey);
  if (!r) {
    if (col && col.parentNode) col.parentNode.removeChild(col);
    return null;
  }
  if (!col) {
    col = document.createElement("div");
    col.className = "dsh-think-pop-col dsh-think-pop-col-xlate";
    col.dataset.thinkPop = "xlate";
    const paneEl = document.createElement("div");
    paneEl.className = "dsh-think-pop-pane dsh-think-pop-pane-xlate";
    paneEl.dataset.thinkPop = "xlate";
    col.appendChild(paneEl);
    root.appendChild(col); /* 原文框下面（不是右栏）*/
  }
  const paneEl = col.querySelector(".dsh-think-pop-pane");
  if (!paneEl) return col;
  paneEl.textContent = "";
  paneEl.appendChild(r);
  return col;
}

/* ── 思考弹窗（本次需求 · 拷问共识 + 本轮调整）──────────────────────────────
   原来会话里的思考段是 <details> 下拉：展开后正文被限高框在自己的小滚动区里，
   会话本身也跟着被顶长 —— 用户口径「移除思考下拉，改为点击思考条目弹窗，
   避免文字滚动影响浏览」。
   现在的形态：会话里只留一行摘要条（◉ 思考 · N 字），点它开一只**居中弹窗**
   （应用现有 #overlay：近全屏宽幅、正文区各自独立滚动、✕ / Esc 关；最小化已下线）。
   本轮调整（用户口径，别再改回去）：
     · 窗里**只有一个原文框**（Markdown 渲染），翻译按钮挂在它的栏头（复制旁边）；
     · **未点翻译时不显示译文框**：译文那一栏由 dshThinkPopPaintXlate 按需建出来，
       点过翻译才出现在原文框**下面**，正文写在译文框栏头下方的框里 ——
       旧写法把译文框插进栏头、又在正文区画一次，用户看到的是多出来的两个框；
     · 翻译仍走该会话自己的模型 + 按段缓存 + 译文校验那套，状态一并留在弹窗里。
   每次只开一个（#overlay 是全应用独一份的宿主）；不记忆用户拖改的尺寸。 */
let _dshThinkPop = null;
function dshThinkPopClose() {
  _dshThinkPop = null;
  try {
    if (typeof closeOverlay === "function") closeOverlay();
  } catch (_) {}
}
/* 一栏 = 栏头（标题 + 工具位）+ 正文框（自己滚）。译文那一栏只在有译文时建。 */
function dshThinkPopCol(root, which, label) {
  const col = document.createElement("div");
  col.className = "dsh-think-pop-col dsh-think-pop-col-" + which;
  col.dataset.thinkPop = which;
  const head = document.createElement("div");
  head.className = "dsh-think-pop-head";
  const t = document.createElement("span");
  t.className = "dsh-think-pop-title";
  t.textContent = label;
  head.appendChild(t);
  const tools = document.createElement("span");
  tools.className = "dsh-think-pop-tools";
  head.appendChild(tools);
  col.appendChild(head);
  const paneEl = document.createElement("div");
  paneEl.className = "dsh-think-pop-pane";
  paneEl.dataset.thinkPop = which;
  col.appendChild(paneEl);
  root.appendChild(col);
  return { col, tools, paneEl };
}
function openDshThinkPop(desc) {
  const d = desc || {};
  const txt = String(d.text || "");
  if (!txt.trim()) return;
  const scopeId = String(d.scopeId || "");
  const segKey = d.segKey == null ? "" : String(d.segKey);
  if (typeof openOverlay !== "function") return;
  openOverlay(I18n.t("◉ 思考 · ") + txt.length + I18n.t(" 字"));
  const box = document.getElementById("overlay");
  const shell = box ? box.querySelector(".overlay-box") : null;
  if (shell) shell.classList.add("dsh-think-pop-box");
  const body = document.getElementById("ovBody");
  if (!body) return;
  body.innerHTML = "";
  const root = document.createElement("div");
  root.className = "dsh-think-pop";
  root.dataset.xkey = dshThinkTransKey(scopeId, segKey);

  /* 原文框：栏头 = 「思考原文」+ 时刻 + 复制 + 翻译；正文 = Markdown，自己滚 */
  const left = dshThinkPopCol(root, "src", I18n.t("思考原文"));
  const md = document.createElement("div");
  md.className = "dsh-think-pop-md md-viewer-doc";
  md.innerHTML = dshThinkMdHtml(txt);
  left.paneEl.appendChild(md);
  if (d.at || d.meta) {
    const meta = document.createElement("div");
    meta.className = "dsh-think-pop-meta";
    meta.textContent = [d.meta, d.at ? formatMsgTimeSec(d.at) : ""]
      .filter(Boolean)
      .join(" · ");
    if (meta.textContent) left.tools.appendChild(meta);
  }
  const cp = document.createElement("button");
  cp.type = "button";
  cp.className = "dsh-think-xlate";
  cp.textContent = I18n.t("复制");
  cp.title = I18n.t("复制这段思考原文到剪贴板");
  cp.onclick = () => {
    const done = () => {
      cp.textContent = I18n.t("已复制");
      setTimeout(() => {
        cp.textContent = I18n.t("复制");
      }, 1200);
    };
    dshClipboardWrite(txt)
      .then((r) => (r && r.ok === false ? toast(I18n.t("复制失败"), "err") : done()))
      .catch(() => toast(I18n.t("复制失败"), "err"));
  };
  left.tools.appendChild(cp);

  /* 翻译按钮也挂在原文栏头（译文框按需长在下面，未点翻译时窗里就只有这一个框） */
  const first = dshTranslateModel(scopeId);
  const btn = dshThinkTranslateBtn(txt, scopeId, segKey, txt);
  if (!first || !first.prov) {
    btn.disabled = true;
    btn.title = I18n.t("未找到可用文本服务商（请在设置 · API/配置中配置并填写 API Key）");
  }
  left.tools.appendChild(btn);
  /* 已经翻过（缓存命中 / 正在翻）：译文框照原样建出来 */
  dshThinkPopPaintXlate(scopeId, segKey);

  body.appendChild(root);
  const foot = document.getElementById("ovFoot");
  if (foot) {
    const close = document.createElement("button");
    close.className = "mini primary";
    close.textContent = I18n.t("关闭");
    close.onclick = () => dshThinkPopClose();
    foot.appendChild(close);
  }
  _dshThinkPop = { scopeId: scopeId, segKey: segKey, text: txt };
}

/* 会话里那一行思考摘要条（历史消息与运行中同一形态）：
   ◉ 思考 · N 字 + 右端时刻，整行可点 → 弹窗；hover 出「点击打开」的提示。 */
function dshThinkRowEl(desc) {
  const d = desc || {};
  const txt = String(d.text || "");
  if (!txt.trim()) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dsh-seg dsh-seg-think dsh-think-row";
  btn.title = I18n.t("点击打开思考弹窗（原文按 Markdown 显示，译文点了翻译才出现）");
  const txtEl = document.createElement("span");
  txtEl.className = "dsh-think-sum-txt";
  txtEl.textContent = I18n.t("◉ 思考 · ") + txt.length + I18n.t(" 字");
  btn.appendChild(txtEl);
  btn.addEventListener("mousedown", (ev) => ev.stopPropagation());
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openDshThinkPop({
      text: txt,
      scopeId: d.scopeId,
      segKey: d.segKey,
      at: d.at,
      meta: d.meta,
    });
  });
  return btn;
}

/* 历史消息的一段 → DOM。工具段按 callId / step 从 m.tools 池里取对应条目，
   取走的从池里移除，剩余（没匹配到的）由调用方补一行 chips 兜底。 */
/* 工具段 ↔ m.tools 的配对口径：历史段渲染与「被窗口裁掉的段对账」共用这一处，
   否则两处口径一歪，被裁的段对应的工具会又从兜底 chips 里冒出来一次。 */
function dshSegToolAt(pool, seg) {
  if (!Array.isArray(pool) || !seg || seg.k !== "tool") return -1;
  for (let i = 0; i < pool.length; i++) {
    const t = pool[i];
    if (!t) continue;
    if (seg.callId) {
      if (String(t.callId) === String(seg.callId)) return i;
    } else if (seg.step != null && t.step === seg.step) return i;
  }
  return -1;
}
/* 上下文注入行（本次需求 · 对齐上游 dsh-client-ui-chat 的 context 行）：
   上游 Chat 在**所有档位**下都不显示普通上下文注入与系统提示行，只在「上下文里发生了
   会改变工具集的变化」时留一行（chat-visibility 口径，见 dsh-client-ui-chat/README.zh.md）。
   文案口径同上游 message.toolAdded / toolRemoved / toolsAdded / toolsChanged：
   工具少就逐个点名（已添加工具：read），多了只报个数（新增 N 个，移除 M 个）。 */
function dshContextText(seg) {
  const names = (seg && seg.names) || {};
  const list = (v) =>
    (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean);
  const a = list(names.added);
  const r = list(names.removed);
  if (a.length && r.length)
    return a.length + r.length <= 4
      ? I18n.t("已添加工具：") + a.join("、") + I18n.t("；已移除工具：") + r.join("、")
      : I18n.t("新增 {a} 个，移除 {r} 个", { a: a.length, r: r.length });
  if (a.length)
    return a.length === 1
      ? I18n.t("已添加工具：") + a[0]
      : I18n.t("新增 {n} 个工具", { n: a.length });
  if (r.length)
    return r.length === 1
      ? I18n.t("已移除工具：") + r[0]
      : I18n.t("移除 {n} 个工具", { n: r.length });
  return String((seg && seg.text) || "").trim();
}
function dshContextRowEl(seg) {
  const txt = dshContextText(seg);
  if (!txt.trim()) return null;
  const d = document.createElement("div");
  /* 会话主体不挂轴（竖线只在「轨迹」视图里，见 dshSegTimeEl 上方说明） */
  d.className = "dsh-seg dsh-ctx";
  const label = document.createElement("span");
  label.className = "dsh-ctx-label";
  label.textContent = I18n.t("上下文注入");
  const body = document.createElement("span");
  body.className = "dsh-ctx-text";
  body.textContent = txt;
  d.appendChild(label);
  d.appendChild(body);
  d.title = I18n.t(
    "上下文发生了变化（工具集增删）。普通上下文注入与系统提示按上游口径不显示。",
  );
  return d;
}

function dshHistSegEl(seg, pool, nodeId, idx, n, showThink, msgAt, policy) {
  if (!seg || !seg.k) return null;
  const pol = policy || null;
  /* 上下文注入行：同样按段序内联，左侧也挂它自己的时刻（本次需求） */
  if (seg.k === "ctx") {
    const c = dshContextRowEl(seg);
    if (c) dshSegTimeAttach(c, seg.at, 0, msgAt);
    return c;
  }
  if (seg.k === "think") {
    /* 会话「显示思考」关掉时整条不渲染（数据仍在 msg.reasoning / segments 里，打开即见）。
       本次需求：思考不再有下拉开合 —— 只留一行可点的摘要条，点开在弹窗里读。 */
    if (showThink === false) return null;
    const txt = String(seg.text || "");
    if (!txt.trim()) return null;
    /* 段序 × 会话 id 就是这一段思考在缓存里的键（翻译按它缓存）。 */
    const oKey =
      "segthink:" + (nodeId || "") + ":" + (idx == null ? "" : idx) + ":" + n;
    const row = document.createElement("div");
    row.className = "dsh-seg dsh-seg-think-wrap";
    const btn = dshThinkRowEl({
      text: txt,
      scopeId: nodeId,
      segKey: oKey,
      at: seg.at,
    });
    if (!btn) return null;
    row.appendChild(btn);
    /* 左侧挂这一项自己的时刻（段自带 at，老存档回落所属消息时刻） */
    dshSegTimeAttach(row, seg.at, 0, msgAt);
    return row;
  }
  if (seg.k === "say" || seg.k === "err") {
    let txt = String(seg.text || "");
    if (seg.k === "err") txt = "⚠ " + txt;
    if (!txt.trim()) return null;
    const d = document.createElement("div");
    d.className =
      "dsh-seg dsh-seg-say" + (seg.k === "err" ? " dsh-seg-err" : "");
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = renderMarkdown(txt);
    d.appendChild(md);
    dshSegTimeAttach(d, seg.at, 0, msgAt);
    return d;
  }
  if (seg.k === "tool") {
    const at = dshSegToolAt(pool, seg);
    if (at < 0) return null;
    const t = pool.splice(at, 1)[0];
    /* 两层（与思考段**同一口径**，见上方 dshSegTimeAttach 的说明）：
         外层 .dsh-seg-tool-wrap = 时刻栏宿主，**自己不上色**（透明、只让出左侧时刻栏）；
         内层 .dsh-seg-tool      = 视觉盒（2px 青轨 + 淡青底 + 内边距）。
       为什么必须分两层（用户口径「颜色和左侧竖条不该被拉伸到时间的左边，应当与思考一致」）：
       青轨是 border-left、青底是 background，两者都以**元素自己的左边框**为起点 ——
       宿主兼皮肤时这个起点在时刻栏**左边**，于是颜色把时刻一起裹了进去。 */
    const box = document.createElement("div");
    box.className = "dsh-seg dsh-seg-tool";
    const chips = document.createElement("div");
    chips.className = "dsh-tools";
    chips.appendChild(dshToolDetailsEl(t, false, nodeId, { expand: !!(pol && pol.expandProcess) }));
    box.appendChild(chips);
    const wrap = document.createElement("div");
    wrap.className = "dsh-seg dsh-seg-tool-wrap";
    wrap.appendChild(box);
    /* 工具项左侧的时刻取**这次调用自己的**真实时刻与耗时（at → doneAt）；
       记录上一条时间都抽不到时，才回落到所属消息时刻。 */
    dshSegTimeAttach(wrap, t && t.at, t && t.doneAt, msgAt);
    return wrap;
  }
  return null;
}
/* live 行：按轨迹段序输出（think → details 折叠 / say → 正文 / tool → chips / err → ⚠） */
function agentLiveSegsEl(row, st, live, items) {
  const tools = Array.isArray(st._liveTools) ? st._liveTools : [];
  const nodeId = live ? live.id : st.id;
  /* 会话「显示思考」开关：live 行与历史消息同一判据（关掉 = 思考段整块不渲染，
     数据照旧随本轮轨迹落进消息存档，见 agentRoundMsgTail）。 */
  const showThink = agentThinkShown(st);
  /* 「完全展开」档：工具卡默认摊开（与历史消息那一支同一条档位判据，见 dshPolicyOfView）——
     本次需求后这一档不再管思考（思考一律收成一行摘要条、点开在弹窗里读）。 */
  const polLive = dshPolicyOfView(dshTranscriptViewFor(st));
  const expandProcess = !!polLive.expandProcess;
  /* 正在增长的思考段未必是尾段：agent 每步「思考 → 工具」，思考段后面还会挂
     tool 段，所以按 tracePush 打的 open 标记认它，而不是认 items 末尾。 */
  const anyOpenThink = items.some((x) => x && x.k === "think" && x.open === true);
  /* 运行中的这一轮同样封顶：一轮里思考 / 工具段动辄上百，全量重绘就是卡死的直接来源。
     只从最近 AGENT_MAX_VISIBLE_ITEMS 条起渲染（这一轮还没落成历史消息，不参与最前端的
     「显示更早内容」；收尾后它的段随消息进历史，届时可在列表最前端展开）。
     索引一律用 items 里的绝对序号：流式就地更新按 dataset.segIdx 找尾段，不能错位。 */
  const off = Math.max(0, items.length - AGENT_MAX_VISIBLE_ITEMS);
  if (off > 0) {
    const cut = document.createElement("div");
    cut.className = "dsh-seg dsh-live-cut";
    cut.textContent = I18n.t("已折叠更早的运行条目：{n}", { n: off });
    row.appendChild(cut);
  }
  for (let i = off; i < items.length; i++) {
    const seg = items[i];
    if (!seg) continue;
    const isLast = i === items.length - 1;
    const streaming =
      seg.k === "think" ? seg.open === true || (isLast && !anyOpenThink) : isLast;
    if (seg.k === "think") {
      /* 「显示思考」关掉：这一项不渲染（数据仍在轨迹与消息存档里，
         再打开开关即整表重绘看回来） */
      if (!showThink) continue;
      const txt = String(seg.text || "");
      if (!txt) continue;
      const oKey = "segthink:" + (st.id || "") + ":" + i;
      /* 本次需求：不再有 details 下拉开合 —— 一行可点的摘要条，点开在弹窗里读全文。
         仍在增长的那一段挂上旧 id + 段序：重绘前的就地字数刷新与滚动记忆按它们找它。 */
      const box = document.createElement("div");
      box.className = "dsh-seg dsh-seg-think-wrap";
      const btn = dshThinkRowEl({
        text: txt,
        scopeId: st.id,
        segKey: oKey,
        at: seg.at,
      });
      if (!btn) continue;
      if (streaming) {
        btn.id = "agent-think";
        btn.dataset.segIdx = String(i);
      }
      box.appendChild(btn);
      /* 这一项的时刻来自**段自己**的 at（app-db.js tracePush 在思考增量到达那一刻记下）——
         不再拿「本轮 / 消息」的时刻冒充本段时刻（见 dshSegTimeEl 的上方口径）。 */
      dshSegTimeAttach(box, seg.at, 0, 0);
      row.appendChild(box);
    } else if (seg.k === "say" || seg.k === "err") {
      const d = document.createElement("div");
      d.className =
        "dsh-seg dsh-seg-say" + (seg.k === "err" ? " dsh-seg-err" : "");
      /* 「流式尾段」= 还在逐 token 增长的那一段：只有它走纯文本（省掉每块重渲 markdown）。
         已收口的正文段（say-end 已到，段上 open=false）虽然仍是尾段，但它已经定稿 ——
         必须按 markdown 渲染，否则会话最终答复（按定义就是最后一个正文段）会一直以
         未渲染原文的形态留在屏上，直到本轮整体重绘才变回来（用户看到的「最终答复
         没渲染 md」）。err 段不参与该判定（可能被后续同 step 的错误续写）。 */
      const stillStreaming = streaming && !(seg.k === "say" && seg.open === false);
      if (stillStreaming) {
        /* 正在流的正文段：纯文本 + 旧 id，text 事件就地更新，避免每块重渲 markdown */
        d.id = "agent-stream";
        d.dataset.segIdx = String(i);
        d.classList.add("dsh-stream");
        d.textContent =
          seg.k === "err" && !String(seg.text || "").startsWith("⚠")
            ? "⚠ " + String(seg.text || "")
            : String(seg.text || "");
      } else {
        const md = document.createElement("div");
        md.className = "md";
        md.innerHTML = renderMarkdown(
          seg.k === "err" ? "⚠ " + String(seg.text || "") : String(seg.text || ""),
        );
        d.appendChild(md);
      }
      /* 这一项自己的时刻（段 at）：**在写完正文之后再挂** —— 时刻栏是元素的第一只子节点，
         上面的 textContent 赋值会把子节点清空一次（就地更新路径另见 dshSegSetStreamText）。 */
      dshSegTimeAttach(d, seg.at, 0, 0);
      row.appendChild(d);
    } else if (seg.k === "tool") {
      const t = tools.find((x) =>
        seg.callId
          ? String(x.callId) === String(seg.callId)
          : seg.step != null && x.step != null && x.step === seg.step,
      );
      if (!t) continue;
      /* 两层结构与历史路径一致（见 dshHistSegEl 的 tool 分支）：外层只当时刻栏宿主、
         内层 .dsh-seg-tool 才是青轨 + 淡青底的视觉盒 —— 颜色不裹住左侧时刻。 */
      const box = document.createElement("div");
      box.className = "dsh-seg dsh-seg-tool";
      const chips = document.createElement("div");
      chips.className = "dsh-tools";
      chips.appendChild(dshToolDetailsEl(t, true, nodeId, { expand: expandProcess }));
      box.appendChild(chips);
      const wrap = document.createElement("div");
      wrap.className = "dsh-seg dsh-seg-tool-wrap";
      wrap.appendChild(box);
      /* 工具项左侧：这次调用自己的真实时刻 + 耗时（结果还没回来就只有发起时刻） */
      dshSegTimeAttach(wrap, t.at || seg.at, t.doneAt, 0);
      row.appendChild(wrap);
    } else if (seg.k === "ctx") {
      /* 上下文注入行：运行中也照同一份渲染（工具增删随请求头到达，往往还在跑的时候就有） */
      const c = dshContextRowEl(seg);
      if (c) {
        dshSegTimeAttach(c, seg.at, 0, 0);
        row.appendChild(c);
      }
    }
  }
}
/* 流式事件就地更新的公共判定：目标段还是不是尾段、DOM 元素对不对得上段序，
   对不上（刚从别的段类型切换过来）→ 整表重绘一次，之后继续在原地追加 */
function agentLiveSegTail(items, el, kind) {
  if (!items || !items.length || !el) return null;
  const last = items[items.length - 1];
  if (!last || last.k !== kind) return null;
  /* 已收口的正文段（say-end 已到 = 段定稿）不再是流式尾段：它按定稿的 markdown 渲染，
     往它里面写纯文本会把渲染结果冲掉 —— 返回 null 让调用方整表重绘（见 agentLiveSegsEl）。 */
  if (kind === "say" && last.open === false) return null;
  if (Number(el.dataset.segIdx) !== items.length - 1) return null;
  return last;
}
/* reasoning 事件的分段更新：只刷尾部正在增长的思考段的摘要字数与展开中的正文。
   非分段模式（如节点绑定运行）自动退回旧的 updateAgentThinkEl 整段写入。 */
let _liveSegThinkRAF = 0;
function updateAgentLiveThink(st) {
  if (typeof requestAnimationFrame !== "function") return;
  if (_liveSegThinkRAF) return;
  _liveSegThinkRAF = requestAnimationFrame(() => {
    _liveSegThinkRAF = 0;
    /* 「显示思考」关掉：会话里没有思考块可刷（若照旧往下走，每来一块思考都会
       因为找不到 #agent-think 而整表重绘一次 —— 白烧一次整表重绘） */
    if (!agentThinkShown(st)) return;
    const items = agentChatSegItems(st);
    if (!items) {
      updateAgentThinkEl(st, null);
      return;
    }
    /* 定位正在增长的思考段：优先 tracePush 标了 open 的那段（可跨 tool 段），
       没有标记时退回旧口径（尾段）。DOM 元素对不上段序 → 整表重绘一次。 */
    let idx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.k === "think" && it.open === true) {
        idx = i;
        break;
      }
    }
    if (idx < 0) idx = items.length - 1;
    const seg = items[idx];
    const rowBtn = document.getElementById("agent-think");
    if (
      !seg ||
      seg.k !== "think" ||
      !rowBtn ||
      Number(rowBtn.dataset.segIdx) !== idx
    ) {
      try {
        renderAgentSession();
      } catch (_) {}
      return;
    }
    const txt = String(seg.text || "");
    /* 只改摘要条里的文案 span（本次需求后那一行不再有按钮，但仍按 span 就地改：
       整条 textContent 会连带把行内结构与 id / dataset 一起冲掉） */
    const sumTxt =
      rowBtn.querySelector(".dsh-think-sum-txt") || rowBtn.firstElementChild;
    const label = I18n.t("◉ 思考 · ") + txt.length + I18n.t(" 字");
    if (sumTxt) sumTxt.textContent = label;
    else rowBtn.textContent = label;
    /* 全文只在弹窗里读：弹窗若正开着这一段，正文跟着长（见 openDshThinkPop 的 live 分支）。
       正文按 Markdown 渲染（本次需求），所以这里也走 dshThinkMdHtml 这同一个入口。 */
    const popMd = document.querySelector(
      '.dsh-think-pop [data-think-pop="src"] .dsh-think-pop-md',
    );
    if (popMd && _dshThinkPop && String(_dshThinkPop.segKey) === "segthink:" + (st.id || "") + ":" + idx)
      popMd.innerHTML = dshThinkMdHtml(txt);
  });
}

/* ══ 消息「复制 / 保存」动作条（会话 · 全局助手 · 专家团单聊共用）══════
   模型常把答案写成代码块或 Markdown 文档（标题 / 表格 / 列表 / 引用）：在聊天气泡里
   手动选中复制会把折行、行号、省略号一起带走，想直接拿去用很别扭。这里在消息**最下方**
   （正文之后、时间行之前）补两枚按钮：
     · 复制 ＝ 把这条内容原文写进剪贴板；
     · 保存 ＝ 另存为文件（走主进程 file:saveDialog + file:writeText，位置由用户选，
       永不落应用目录 —— 见 AGENTS.md「数据不落应用文件夹」）。
   取哪一份内容（唯一口径，勿在别处另写一套）：
     · 「纯代码消息」＝ 整条正文除一个围栏代码块外没有别的实质内容 → 取围栏内的代码，
       保存按语言给扩展名（```python → .py，认不出 → .txt）——这正是用户要拿去跑的东西；
     · 其余（正文夹代码 / 夹结构）→ 取整条正文原文（Markdown 源），一个字不丢。
   出现条件（dshMsgNeedActions）：正文含围栏代码块，或含标题 / 表格 / 引用 / 列表这类
   块级 Markdown 结构。纯段落（只加粗 / 行内码 / 链接）不出现 —— 那种消息沿用时间行里
   原有的小「复制」按钮，免得一条消息上挂两枚一模一样的「复制」（见 dshMsgBlock 尾部）。
   按钮是渲染期产物、随消息重绘重建（重绘＝内容变了，正该重建），不额外持久化。 */
/* 整条消息就是一个围栏代码块（围栏外除空白无内容）：捕获语种与代码正文 */
const DSH_MSG_CODE_ONLY_RE =
  /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/;
/* 代码围栏语种 → 扩展名（保存纯代码消息用；认不出按 .txt，绝不猜成可执行名） */
const DSH_CODE_EXT = {
  javascript: "js",
  js: "js",
  mjs: "mjs",
  cjs: "cjs",
  jsx: "jsx",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  vue: "vue",
  python: "py",
  py: "py",
  json: "json",
  jsonc: "jsonc",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  svg: "svg",
  yaml: "yaml",
  yml: "yml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  zsh: "sh",
  powershell: "ps1",
  ps1: "ps1",
  bat: "bat",
  cmd: "bat",
  java: "java",
  c: "c",
  h: "h",
  cpp: "cpp",
  "c++": "cpp",
  hpp: "hpp",
  cs: "cs",
  go: "go",
  rust: "rs",
  rs: "rs",
  ruby: "rb",
  rb: "rb",
  php: "php",
  kotlin: "kt",
  kt: "kt",
  swift: "swift",
  lua: "lua",
  r: "r",
  dart: "dart",
  markdown: "md",
  md: "md",
  text: "txt",
  txt: "txt",
  plaintext: "txt",
  diff: "diff",
  csv: "csv",
};
/* 这条正文该复制 / 保存什么：纯代码消息取代码，其余取原文 */
function dshMsgPayload(txt) {
  const raw = String(txt == null ? "" : txt);
  const hit = raw.match(DSH_MSG_CODE_ONLY_RE);
  if (hit) {
    return {
      code: true,
      lang: String(hit[2] || "").trim().toLowerCase(),
      text: String(hit[3] == null ? "" : hit[3]),
    };
  }
  return { code: false, lang: "", text: raw };
}
/* 正文里有没有值得「整段拿走」的东西：围栏代码块，或标题 / 引用 / 表格 / 列表（≥2 行） */
function dshMsgNeedActions(txt) {
  const raw = String(txt == null ? "" : txt);
  if (!raw.trim()) return false;
  /* 未闭合的围栏也算（流式输出中途）：至少用户能看到按钮 */
  if (/^[ \t]{0,3}(`{3,}|~{3,})/m.test(raw)) return true;
  let bullets = 0;
  for (const ln of raw.split(/\r?\n/)) {
    const s = ln.trim();
    if (!s) continue;
    if (/^#{1,6}[ \t]/.test(s)) return true; /* 标题 */
    if (/^>[ \t]?/.test(s)) return true; /* 引用 */
    if (/^\|.*\|$/.test(s)) return true; /* 表格行 */
    if (/^(?:[-*+]|\d{1,9}[.)])[ \t]+\S/.test(s) && ++bullets >= 2) return true; /* 列表 */
  }
  return false;
}
/* 另存为文件名：第一个标题当名字（非法字符换空格，最长 60 字），没有就用角色 + 时间戳 */
function dshMsgFileName(txt, role, ext) {
  const raw = String(txt == null ? "" : txt);
  const h = raw.match(/(?:^|\n)[ \t]{0,3}#{1,6}[ \t]+([^\n#]{1,80})/);
  let base = h ? h[1].replace(/[*_`~]/g, "").trim() : "";
  if (!base) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    base =
      (role === "user" ? I18n.t("我的输入") : I18n.t("AI 回复")) +
      "-" +
      d.getFullYear() +
      p2(d.getMonth() + 1) +
      p2(d.getDate()) +
      "-" +
      p2(d.getHours()) +
      p2(d.getMinutes());
  }
  base = base
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return (base || "message") + "." + ext;
}
/* 保存：选位置 → 写盘 → toast 回执；取消不打扰，失败说清楚原因 */
async function dshMsgSaveContent(text, role, btn) {
  const payload = dshMsgPayload(text);
  const api = window.api || {};
  if (!api.fileSaveDialog || !api.fileWriteText) {
    toast(I18n.t("保存失败：") + I18n.t("当前环境不支持文件保存"), "err");
    return;
  }
  const ext = payload.code ? DSH_CODE_EXT[payload.lang] || "txt" : "md";
  let pick = null;
  try {
    pick = await api.fileSaveDialog({
      title: I18n.t("保存消息内容"),
      defaultName: dshMsgFileName(text, role, ext),
      filters: payload.code
        ? [
            { name: I18n.t("代码文件") + " (*." + ext + ")", extensions: [ext] },
            { name: I18n.t("全部文件"), extensions: ["*"] },
          ]
        : [
            { name: I18n.t("Markdown 文件"), extensions: ["md"] },
            { name: I18n.t("文本文件"), extensions: ["txt"] },
            { name: I18n.t("全部文件"), extensions: ["*"] },
          ],
    });
  } catch (e) {
    pick = { error: (e && e.message) || String(e) };
  }
  if (pick && pick.error) {
    toast(I18n.t("保存失败：") + pick.error, "err");
    return;
  }
  if (!pick || !pick.path) return; /* 用户取消：静默 */
  let wr = null;
  try {
    wr = await api.fileWriteText(pick.path, payload.text);
  } catch (e) {
    wr = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!wr || wr.ok === false) {
    toast(
      I18n.t("保存失败：") + ((wr && wr.error) || I18n.t("未知错误")),
      "err",
    );
    return;
  }
  toast(I18n.t("已保存：") + pick.path, "ok");
  if (btn) {
    btn.classList.add("ok");
    setTimeout(() => btn.classList.remove("ok"), 1200);
  }
}
/* 动作条本体：正文已确定含代码 / Markdown 结构时由 dshMsgBlock 调用（也可被手册问答复用） */
function dshMsgActionBar(text, role) {
  const payload = dshMsgPayload(text);
  const bar = document.createElement("div");
  bar.className = "dsh-msg-actions";
  const mk = (label, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dsh-msg-act";
    b.textContent = label;
    b.title = title;
    /* 会话区有拖选 / 点选行为：按钮上的按下与点击都不许冒泡出去 */
    b.addEventListener("mousedown", (ev) => ev.stopPropagation());
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    return b;
  };
  const cp = mk(
    I18n.t("复制"),
    payload.code
      ? I18n.t("复制代码（围栏已去掉）到剪贴板")
      : I18n.t("复制本条正文原文（Markdown / 代码）到剪贴板"),
  );
  cp.addEventListener("click", () => {
    const done = () => {
      cp.classList.add("ok");
      cp.textContent = I18n.t("已复制");
      toast(I18n.t("已复制"), "ok");
      setTimeout(() => {
        cp.classList.remove("ok");
        cp.textContent = I18n.t("复制");
      }, 1200);
    };
    const fail = () => toast(I18n.t("复制失败"), "err");
    dshClipboardWrite(payload.text)
      .then((r) => (r && r.ok === false ? fail() : done()))
      .catch(fail);
  });
  bar.appendChild(cp);
  const sv = mk(I18n.t("保存"), I18n.t("把本条内容另存为文件"));
  sv.addEventListener("click", () => dshMsgSaveContent(text, role, sv));
  bar.appendChild(sv);
  return bar;
}

/* 单条消息复制按钮：点击复制本条正文（用户消息放头部、AI 回复放尾部时间行），复制成功后短暂变 ok */
function dshCopyBtn(m, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls || "dsh-msg-copy";
  b.textContent = I18n.t("复制");
  b.title = I18n.t("复制本条到剪贴板");
  b.addEventListener("mousedown", (ev) => ev.stopPropagation());
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const txt = String(m.content == null ? "" : m.content);
    const done = () => {
      b.classList.add("ok");
      b.textContent = I18n.t("已复制");
      toast(I18n.t("已复制"), "ok");
      setTimeout(() => {
        b.classList.remove("ok");
        b.textContent = I18n.t("复制");
      }, 1200);
    };
    const fail = () => toast(I18n.t("复制失败"), "err");
    dshClipboardWrite(txt)
      .then((r) => {
        if (r && r.ok === false) fail();
        else done();
      })
      .catch(fail);
  });
  return b;
}

/* ── 用户消息正文里的内嵌图：整行 `![名称](绝对路径)` 就地渲染成缩略图 ──
   图行是「那时那张图」的原始记录（正文框插入时的原样），所以历史消息回看时
   缩略图照旧在（与运行链是否可下发无关）；点缩略图开灯箱看原图。
   其余行照旧纯文本 + 链接；相对引用的图行没有基准目录 → 保留原文
   （与输入框胶囊条同一口径：显示不出来的不假装显示）。 */
/* 转义：全局 escapeHtml 缺席时（单文件切片冒烟）就地兜一份，与本文件其余守卫同口径 */
function dshEscHtml(s) {
  if (typeof escapeHtml === "function") return escapeHtml(s);
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function dshUserImgHtml(l, m) {
  const name =
    l.alt || (m && typeof m.baseName === "function" ? m.baseName(l.ref) : "") || "";
  const p = m && typeof m.localPathOfRef === "function" ? m.localPathOfRef(l.ref) : "";
  return (
    '<img class="dsh-msg-img" src="' +
    dshEscHtml(l.url) +
    '" alt="' +
    dshEscHtml(name) +
    '"' +
    (p ? ' data-dsh-img-path="' + dshEscHtml(p) + '"' : "") +
    ' title="' +
    dshEscHtml(I18n.t("点击查看大图")) +
    '">'
  );
}
function dshUserBodyHtml(text) {
  const raw = String(text == null ? "" : text);
  const m = window.MTInlineImg;
  if (!m || typeof m.imgLines !== "function") return plainTextToLinkHtml(raw);
  const byStart = new Map();
  for (const l of m.imgLines(raw)) if (l.url) byStart.set(l.start, l);
  if (!byStart.size) return plainTextToLinkHtml(raw);
  /* 逐行处理再按 \n 拼回：正文整块是 white-space: pre-wrap，只有原样保留换行，
     非图行那部分的排版才与改动前一致。 */
  let off = 0;
  const out = [];
  for (const line of raw.split("\n")) {
    const hit = byStart.get(off);
    off += line.length + 1;
    out.push(hit ? dshUserImgHtml(hit, m) : plainTextToLinkHtml(line));
  }
  return out.join("\n");
}
/* 点缩略图 → 灯箱（路径取 data 属性；src 是 file:/// URL，灯箱要的是本机路径） */
function bindDshUserImgOpen(body) {
  if (!body || !body.querySelector || !body.querySelector("img.dsh-msg-img")) return;
  body.addEventListener("click", (ev) => {
    const img =
      ev.target && ev.target.closest ? ev.target.closest("img.dsh-msg-img") : null;
    if (!img) return;
    ev.stopPropagation();
    if (typeof openImageLightbox !== "function") return;
    const p =
      String(img.getAttribute("data-dsh-img-path") || "").trim() ||
      String(img.getAttribute("src") || "");
    if (!p) return;
    openImageLightbox(p, img.getAttribute("alt") || "");
  });
}
/* ── 已撤：轮次过程折叠行（原 dshTurnProcessFold）───────────────────────────
   它把一轮里的工具 / 上下文注入段搬进一行「✓ 已完成 · 用时 X · N 次工具调用」的
   折叠条（对齐上游 turn-process 行）。**本轮需求（用户口径）撤掉**：
   「工具调用不应当被收纳，否则会和工具在顺序上分离」—— 段行被搬进折叠体之后，
   工具卡就不再待在它发生的时间线位置上（思考与答复留在外面，只有工具被搬走）。
   现在：段一律按段序内联渲染，全局档位只在 showThink / expandThink / expandProcess
   三位上分档（见 dshPolicyOfView），会话级「显示思考」开关另覆写 showThink 那一位。
   **不要再把它加回来** ——
   回归口径见 test/smoke-session-markers.js [6]（钉住模块里没有折叠行、段按序内联）。 */

function dshMsgBlock(m, nodeId, idx, opts) {
  const row = document.createElement("div");
  row.className = "dsh-msg" + (m.role === "user" ? " dsh-user" : " dsh-ai");
  /* 浏览器求助的「已回应 / 等模型继续」内嵌记录（app-db.js 的 ixNoteBrowserAnswer）：
     标记出来 —— ① 行内提示样式（不是用户手打的正文）② 无进展看门狗按这个
     data-ix-bnote 找回这一行就地补「重发本轮 / 终止本轮」。 */
  if (m && m._src === "ix-browser") {
    row.classList.add("dsh-msg-bnote");
    row.dataset.ixBnote = String(Number(m.at) || 0);
  }
  /* 「这一轮已经结束」痕迹（app-db.js 的 ixRoundEndTrace：轮次收尾时卡片收口后落的
     一行界面痕迹 —— 落盘、重开可见、不进模型上下文）。与上面那条同族，另外自带
     一枚「重发本轮」出口（落点是 app-db.js 的 ixRoundEndPaint，与无进展提示同源；
     它在函数末尾才挂 —— 出口要排在正文气泡之后，不能跑到上面去）。 */
  if (m && m._src === "ix-round-end") {
    row.classList.add("dsh-msg-bnote");
    row.dataset.ixRnote = String(Number(m.at) || 0);
  }
  if (idx != null) row.dataset.histKey = histMsgKey(nodeId || "chat", idx, m);
  /* 有分段轨迹（且正文拼接与 content 一致）就按段渲染，否则走旧渲染 */
  const segsView = dshMsgSegsViewable(m);
  /* 会话「显示思考」开关：按这条消息属于哪条会话取判据（见 dshThinkShownFor）；
     关掉时思考块整块不渲染（数据仍在 m.reasoning / m.segments 里，打开即可看回） */
  const showThink = dshThinkShownFor(nodeId);
  /* 这条消息属于哪条会话 → 全局默认档派生的展开口径（思考显示另由上面的开关覆写） */
  const policy = dshPolicyOfView(dshTranscriptViewOfSessionId(nodeId));
  const head = document.createElement("div");
  head.className = "dsh-msg-head";
  const role = document.createElement("span");
  role.className = "dsh-role";
  role.textContent = m.role === "user" ? I18n.t("你") : "AI";
  head.appendChild(role);
  /* 「⚡插话」气泡：这一句不是新的一轮，而是趁上一轮还在跑时塞进它下一步边界的 ——
     标出来，用户才知道为什么它下面没有紧跟一条回答（回答在同一个气泡串里继续）。
     _steerState：'sent' 已递交（等运行时认领）→ 'in' 已注入（收到 agent/inbox/spliced）。 */
  if (m.role === "user" && m._kind === "steer") {
    row.classList.add("dsh-msg-steer");
    const tag = document.createElement("span");
    tag.className = "dsh-steer-tag" + (m._steerState === "in" ? " is-in" : "");
    tag.textContent =
      m._steerState === "in"
        ? I18n.t("已注入本轮")
        : I18n.t("已插话 · 将在下一步生效");
    tag.title =
      m._steerState === "in"
        ? I18n.t("运行时已把这句话拼进本轮的收件箱（下一步就读到）")
        : I18n.t("已递交给正在跑的这一轮，在下一步边界生效；送不进去时自动改走发送队列");
    head.appendChild(tag);
  }
  /* 旧渲染（无分段轨迹）的思考：head 之后单独一行摘要条，见下方 row.appendChild
     （本次需求：不再是 <details> 下拉开合，点开在弹窗里读全文）。
     m._segNoBody（段里还留着思考、但 say 段拼不回正文）也走这一支：正文退回整段
     content 渲染，思考照样给一行摘要条 —— 绝不因为它就整条消息什么都不显示。 */
  let thinkBoxEl = null;
  if (
    m.role === "assistant" &&
    (!segsView || m._segNoBody) &&
    showThink &&
    m.reasoning &&
    String(m.reasoning).trim()
  ) {
    const rKey = "think:" + (nodeId || "") + ":" + String(m.content || "").slice(0, 40);
    /* 思考摘要条 + 自己的时刻栏（与分段渲染同一形态、同一份翻译缓存键） */
    const thinkBox = document.createElement("div");
    thinkBox.className = "dsh-seg dsh-seg-think-wrap dsh-think-head";
    const tRow = dshThinkRowEl({
      text: String(m.reasoning),
      scopeId: nodeId,
      segKey: rKey,
      at: m.at,
    });
    if (tRow) {
      thinkBox.appendChild(tRow);
      thinkBoxEl = thinkBox;
    }
  }
  /* 正文含代码块 / Markdown 结构 → 消息最下方补「复制 / 保存」动作条
     （口径见 dshMsgActionBar 上方注释）。判定提前算：头部 / 时间行原有的小「复制」
     在动作条已给出「复制」时让位，同一条消息不出现两枚「复制」。 */
  const actText = String(m.content == null ? "" : m.content);
  const hasActions = dshMsgNeedActions(actText);
  /* 用户消息的复制按钮留在头部；AI 回复的复制按钮放在尾部与时间同行（仅复制该条回复） */
  if (m.role === "user" && !hasActions)
    head.appendChild(dshCopyBtn(m, "dsh-msg-copy"));
  row.appendChild(head);
  if (thinkBoxEl) row.appendChild(thinkBoxEl);
  if (segsView) {
    /* 时间线：思考 / 正文 / 工具按段序就近插入（工具段从 m.tools 里取对应条目） */
    const body = document.createElement("div");
    /* 按段渲染的容器：会话主体**不画竖线**（用户口径 —— 竖线 + 时间轴只属于「轨迹」视图，
       见 renderer/app-trajectory.js），段保持各自一条 border-left 的分块读法。 */
    body.className = "dsh-msg-body dsh-msg-segs";
    const pool = Array.isArray(m.tools) ? m.tools.slice() : [];
    /* 被「显示更早内容」挡在窗口外的段：它们的工具先照同一口径认掉（不渲染），
       否则这些工具会作为兜底 chips 又冒出来一次 —— 等于藏起来的条目漏了头 */
    const from = Math.max(
      0,
      Math.min(Number(opts && opts.segFrom) || 0, m.segments.length),
    );
    for (let n = 0; n < from; n++) {
      const at = dshSegToolAt(pool, m.segments[n]);
      if (at >= 0) pool.splice(at, 1);
    }
    /* 段一律**按段序内联**渲染（本次需求 · 用户口径「不应当进行任何收纳」）：
       思考 / 正文 / 工具 / 上下文注入各自落回它在时间线上的位置，不再有
       「把工具段搬进一行折叠条」的轮次过程折叠（原 dshTurnProcessFold 已撤，
       见该函数原址的说明）；段自己的时刻由 dshSegTimeAttach 挂在每项左侧。 */
    for (let n = from; n < m.segments.length; n++) {
      const el = dshHistSegEl(m.segments[n], pool, nodeId, idx, n, showThink, m.at, policy);
      if (el) body.appendChild(el);
    }
    /* 时间线上没配到段、剩下的工具（重发 / 老数据等边角）挂消息**最前面**，
       绝不追加到时间线尾部：追加在尾部 = 工具 chips 压在最终回复下方，用户第一眼
       看到的就是「AI 最终回复未在最底部」（而且这些多是最早发生的调用，放前面才对）。 */
    if (pool.length) {
      const chips = document.createElement("div");
      chips.className = "dsh-tools dsh-tools-head";
      for (const t of pool)
        chips.appendChild(dshToolDetailsEl(t, false, nodeId));
      body.insertBefore(chips, body.firstChild);
    }
    row.appendChild(body);
  } else {
    if (m.role === "assistant" && Array.isArray(m.tools) && m.tools.length) {
      const chips = document.createElement("div");
      chips.className = "dsh-tools";
      /* 无分段轨迹的老消息：工具卡照旧按档位给默认展开（与分段那一支同源） */
      for (const t of m.tools)
        chips.appendChild(dshToolDetailsEl(t, false, nodeId, { expand: !!policy.expandProcess }));
      row.appendChild(chips);
    }
    const body = document.createElement("div");
    body.className = "dsh-msg-body";
    if (m.role === "user") {
      body.innerHTML = dshUserBodyHtml(m.content);
      bindDshUserImgOpen(body);
    } else
      body.innerHTML =
        '<div class="md">' + renderMarkdown(m.content) + "</div>";
    row.appendChild(body);
  }
  /* 正文含代码块 / Markdown 结构 → 消息最下方补「复制 / 保存」动作条
     （口径见 dshMsgActionBar 上方注释；坏了也不拖垮整条消息） */
  if (hasActions) {
    try {
      row.appendChild(dshMsgActionBar(actText, m.role));
    } catch (e) {
      try {
        console.error("消息动作条渲染失败", e);
      } catch (_) {}
    }
  }
  /* 消息时刻（本次需求）：**不再单独占消息末尾一行**，改挂到消息左侧的悬浮时刻栏
     （.dsh-msg-side，绝对定位在消息左内边距里，见 css/dsh.css 同名规则）：
     用户口径 = 时刻恒在正文左侧、悬浮显示，别在第二行再压一行时间。
     渲染改成给 dsh-msg 加上 .dsh-has-time，左侧留出时刻栏的宽度（否则会压住正文），
     时刻仍是 formatMsgTimeSec（精确到秒，非今天带日期），title 仍是完整时间戳。 */
  const endTxt = formatMsgTimeSec(m.at || m.createdAt || m.ts);
  if (endTxt) {
    const side = document.createElement("div");
    side.className = "dsh-msg-side";
    const tEl = document.createElement("span");
    tEl.className = "dsh-msg-time";
    tEl.textContent = endTxt;
    tEl.title = formatMsgStamp(m.at || m.createdAt || m.ts);
    side.appendChild(tEl);
    row.appendChild(side);
    row.classList.add("dsh-has-time");
  }
  /* 消息末尾：AI 回复带「复制本条回复」小按钮（没有按钮就不挂这一行，不留空行）。
     时刻已上左侧时刻栏，这里只剩按钮。 */
  if (m.role === "assistant") {
    const tail = document.createElement("div");
    tail.className = "dsh-msg-tail";
    /* 动作条已给出「复制」的消息不再挂这枚小按钮（同一条消息不出现两枚「复制」） */
    if (m.role === "assistant" && !hasActions)
      tail.appendChild(dshCopyBtn(m, "dsh-msg-tail-copy"));
    row.appendChild(tail);
  }
  /* 「这一轮已经结束」痕迹自带的那枚出口（app-db.js 的 ixRoundEndPaint：与无进展提示
     同源，点了 = 终止当前这一轮 + 把最后一条用户消息再发一次）。挂在正文气泡之后 ——
     排在函数开头就等于把按钮顶到正文上面去。 */
  if (m && m._src === "ix-round-end") {
    try {
      if (typeof ixRoundEndPaint === "function") ixRoundEndPaint(row, m);
    } catch (_) {}
  }
  return row;
}

/* ── 历史存档兼容：曾被「会话轮次回滚」回滚过的轮次消息不进上下文 ──────────
 * 会话轮次回滚功能已移除（旧入口挂在用户消息下方，账本 / 对象库 / journal 捕获
 * 四条链路一并删掉），这里只保留最小只读兼容：历史存档里可能还留着当时写下的
 * `_rolledBack` 标记，那些轮的内容已按用户意愿撤销、与实际文件状态不符，
 * 仍照旧摘在上下文之外，避免它们重新回到对话里。不写任何标记、不碰存档。 */
function activeSessionMessages(list) {
  const arr = Array.isArray(list) ? list : [];
  for (const m of arr) if (m && m._rolledBack) return arr.filter((x) => !(x && x._rolledBack));
  return arr;
}

/* ── 会话条目窗口：每个会话最多同时渲染 AGENT_MAX_VISIBLE_ITEMS 条，更早的靠手动
      「显示更早内容」展开（+AGENT_LOAD_MORE_ITEMS / 次）────────────────────
   为什么按「条目」而不按「轮」：一轮任务可能吐出上百个思考 / 工具段（长任务里很常见），
   整表重绘时每个段都是一次 DOM 构建（思考段还带 markdown / 译文），内容或思考一多就把
   窗口卡死 —— 而按轮算时这些段全都算在「最近 10 轮」里，一轮就能塞满整张列表。
   条目口径 = 真正落进 DOM 的时间线块：
     · 能按段渲染的消息（dshMsgSegsViewable）→ 每个段一条（思考 / 正文 / 工具）；
     · 其余消息（用户消息、退回整条渲染的老消息）→ 整条算一条。
   只影响渲染，不动 st.messages 本身：上下文与存档口径一个字节都不变。 */
const AGENT_MAX_VISIBLE_ITEMS = 200;
const AGENT_LOAD_MORE_ITEMS = 200;
function agentEntryCount(m) {
  if (
    m &&
    m.role === "assistant" &&
    typeof dshMsgSegsViewable === "function" &&
    dshMsgSegsViewable(m)
  )
    return Math.max(1, m.segments.length);
  return 1;
}
/* 从尾部往前凑条目预算：返回可见起点 start、以及起点那条消息要跳过的前置条目数 skip。
   只有能按段裁的消息才可能被裁（留下尾部段，head 照常渲染）；装不下整条的普通消息
   直接不进窗口，交给最前端的「显示更早内容」。 */
function agentEntrySlice(st) {
  const msgs = Array.isArray(st && st.messages) ? st.messages : [];
  const costs = msgs.map(agentEntryCount);
  let total = 0;
  for (const c of costs) total += c;
  let budget = Number(st && st._visItems);
  if (!Number.isFinite(budget) || budget < 1) budget = AGENT_MAX_VISIBLE_ITEMS;
  if (budget > total) budget = total;
  let acc = 0;
  let start = msgs.length;
  let skip = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const room = budget - acc;
    if (costs[i] > room) {
      /* 预算在同一段里用完：能按段裁就把这条消息的尾部段留在窗口里 */
      if (room > 0 && dshMsgSegsViewable(msgs[i])) {
        start = i;
        skip = costs[i] - room;
        acc = budget;
      }
      break;
    }
    acc += costs[i];
    start = i;
  }
  return { msgs, start, skip, total, shown: acc, vis: budget };
}
/* 让第 idx 条消息（含其后全部条目）落进窗口所需的最小预算：全局搜索跳转旧消息时用 */
function agentEntryBudgetFrom(st, idx) {
  const msgs = Array.isArray(st && st.messages) ? st.messages : [];
  if (!msgs.length) return AGENT_MAX_VISIBLE_ITEMS;
  const at = Math.max(0, Math.min(Number(idx) || 0, msgs.length - 1));
  let n = 0;
  for (let i = at; i < msgs.length; i++) n += agentEntryCount(msgs[i]);
  return Math.max(1, n);
}
/* 写剪贴板：navigator.clipboard 优先，回退 preload 桥（失败 reject） */
function dshClipboardWrite(txt) {
  if (navigator.clipboard && navigator.clipboard.writeText)
    return Promise.resolve(navigator.clipboard.writeText(txt));
  if (window.api && window.api.clipboardWriteText)
    return Promise.resolve(window.api.clipboardWriteText(txt));
  return Promise.reject(new Error("no clipboard"));
}
/* ═══════════ 消息栏草稿的「视图键」（本轮需求:未输入完毕发送的内容切窗口不许丢） ═══════════
   同一只输入框（#agentInput）在三种上下文里装的是三份不同的草稿，按视图键存取：
     · 会话页的当前会话          → 键 = 会话 id（沿用 session._draft，随会话落盘）
     · 应用开发页显示的那条会话  → 键 = 该会话 id（显示覆盖不改归属，与上一条同源）
     · 应用开发页首轮态（还没有会话）→ 键 = "\u0000dev-first:<appId>"：
       那只占位空会话不在会话表里、每次整页重绘都被换掉，草稿挂不到对象上 ——
       交给 app-apps-dev.js 按应用存（config.appsDevDrafts，落盘口径与 appsDevLastApp 同源）。
   键里带上 appId 的理由：切应用时框里的字要先退回**上一个**应用、再填新应用的；
   键跟着变，存与取才各有其主（否则 A 的半截需求会跟着跑到 B 名下）。
   历史 bug（本轮需求本体）：草稿只在「切换会话那一刻」从 DOM 抄一次，且只认会话表里的
   对象 —— 开发页首轮态那只框不属于任何会话，一次整页重绘 / 自动选会话 / 关页回收
   （appsDevViewClear → renderAgentSession）就把用户写了一半的开发需求整段丢掉。 */
const AGENT_DEV_FIRST_KEY = "\u0000dev-first:";
function agentDraftKeyNow() {
  if (agentViewOverrideOn()) {
    const id = agentViewId();
    if (id) return id;
    let appId = "";
    try {
      if (typeof appsDevDraftAppId === "function")
        appId = String(appsDevDraftAppId() || "");
    } catch (_) {
      appId = "";
    }
    return AGENT_DEV_FIRST_KEY + appId;
  }
  return String(activeAgentId() || "");
}
/* 把某个视图键下的草稿写回它自己的家（真会话 = session._draft；首轮态 = 应用草稿槽） */
function agentDraftStash(key, value) {
  const k = String(key == null ? "" : key);
  const v = String(value == null ? "" : value);
  if (k.indexOf(AGENT_DEV_FIRST_KEY) === 0) {
    try {
      if (typeof appsDevDraftSave === "function")
        appsDevDraftSave(k.slice(AGENT_DEV_FIRST_KEY.length), v);
    } catch (_) {}
    return;
  }
  const s = k ? agentSessions().find((x) => x && x.id === k) : null;
  if (s) s._draft = v;
}
/* 取某个视图键下的草稿（首轮态走应用草稿槽；真会话走它自己的 _draft） */
function agentDraftLoad(key, st) {
  const k = String(key == null ? "" : key);
  if (k.indexOf(AGENT_DEV_FIRST_KEY) === 0) {
    try {
      if (typeof appsDevDraftLoad === "function")
        return String(appsDevDraftLoad(k.slice(AGENT_DEV_FIRST_KEY.length)) || "");
    } catch (_) {}
    return "";
  }
  const s = k ? agentSessions().find((x) => x && x.id === k) : null;
  if (s) return String(s._draft || "");
  return String((st && st._draft) || "");
}
/* 输入即记（与长任务草稿表 ltDraftBind 同一纪律：不靠失焦、不靠重绘那一刻）。
   挂钩点 = app-boot.js 里 #agentInput 的 input 监听；这样任何一次整页重绘 / 自动选会话
   都能拿到最新那半截字，而不是等下一次「切换会话」才从 DOM 里抄。 */
function agentDraftTick() {
  const inp = document.getElementById("agentInput");
  if (!inp) return;
  agentDraftStash(agentDraftKeyNow(), inp.value);
}
function renderAgentSession(opts) {
  const st = agentSessionState();
  /* 右边栏（浏览器活动）跟着当前会话走：这一帧渲染的是哪条会话，那栏就显示哪条会话的
     活动；本会话没有浏览器就整条收起（见 app-browser.js 的 BA.setSession）。 */
  agentNotifyBrowserSession();
  const list = $("#agentList");
  if (!list) return;
  /* 切换会话 = 新的阅读上下文：清掉上一个会话遗留的「用户已上翻」状态，
     直接定位到新会话底部；同一会话内则完全尊重用户自己的滚动位置 */
  const switched = S._agentRenderedSessionId && S._agentRenderedSessionId !== st.id;
  if (switched) markConvStick(list, true);
  const stickCap = captureConvStick(
    list,
    (opts && opts.forceStick) || switched,
  );
  const live = liveNodeForSession(st);
  const running = !!(st.running || live);
  /* 本次需求：会话列表里不再有可滚的思考正文（思考只剩一行摘要条，正文在 #overlay
     的思考弹窗里），所以原来「清空前记住思考滚动位置、重建后再还原」那一步整条撤掉 ——
     再叫一次也只是拿一个永远不存在的 #agent-think-body。 */
  list.innerHTML = "";
  if (list) list.style.display = "";
  if (!st.messages.length && !running) {
    const hint = document.createElement("div");
    hint.className = "agent-empty";
    hint.textContent = I18n.t("选择一个工作区开始，直接描述你要完成的任务。");
    list.appendChild(hint);
  }
  /* 最多渲染最近 AGENT_MAX_VISIBLE_ITEMS 条(消息 + 段),更早的在列表最前端手动展开 */
  const slice = agentEntrySlice(st);
  const hiddenEntries = Math.max(0, slice.total - slice.shown);
  if (hiddenEntries > 0) {
    const loadRow = document.createElement("div");
    loadRow.className = "agent-load-earlier";
    const btn = document.createElement("button");
    btn.textContent = I18n.t("显示更早内容（已折叠 {n} 条）", { n: hiddenEntries });
    btn.title = I18n.t("每个会话最多同时渲染 200 条，点击展开更早的 200 条");
    btn.addEventListener("click", () => {
      const l = $("#agentList");
      const prevScroll = l ? l.scrollTop : 0;
      const prevH = l ? l.scrollHeight : 0;
      st._visItems = slice.vis + AGENT_LOAD_MORE_ITEMS;
      renderAgentSession();
      const l2 = $("#agentList");
      if (l2 && prevH > 0) setConvScrollTop(l2, prevScroll + (l2.scrollHeight - prevH));
    });
    loadRow.appendChild(btn);
    list.appendChild(loadRow);
  }
  /* 会话消息逐条渲染（仅限可见列表内；回滚入口已随会话轮次回滚功能一并移除） */
  for (let i = slice.start; i < slice.msgs.length; i++) {
    const m = slice.msgs[i];
    try {
      list.appendChild(
        dshMsgBlock(m, st.id || "agent", i, {
          /* 窗口起点那条消息若被裁过段：前面的段不进 DOM（它们的工具也已对账掉） */
          segFrom: i === slice.start ? slice.skip : 0,
        }),
      );
    } catch (e) {
      /* 单条消息坏数据不拖垮整表：跳过并留痕，避免列表停在旧消息处 */
      try {
        console.error("会话消息渲染失败: idx=" + i, e);
      } catch (_) {}
    }
  }
  if (running) {
    const row = document.createElement("div");
    row.className = "dsh-msg dsh-ai";
    const head = document.createElement("div");
    head.className = "dsh-msg-head";
    const role = document.createElement("span");
    role.className = "dsh-role live";
    role.textContent = I18n.t("AI · 运行中");
    head.appendChild(role);
    row.appendChild(head);
    const segItems = agentChatSegItems(st);
    if (segItems) {
      /* 分段轨迹：思考 / 正文 / 工具 / 错误按发生顺序逐段插进容器。
         会话主体不画竖线（竖线 + 时间轴只属于「轨迹」视图，见 app-trajectory.js） */
      row.dataset.seg = "1";
      const box = document.createElement("div");
      box.className = "dsh-msg-body dsh-msg-segs";
      agentLiveSegsEl(box, st, live, segItems);
      row.appendChild(box);
    } else {
      /* 非分段（老路径）：思考同样只给一行可点开的摘要条（本次需求）
         —— 全文改在弹窗里读，不再有下拉开合。 */
      const tRow = dshThinkRowEl({
        text: agentThinkText(st, live),
        scopeId: st.id,
        segKey: "think-live:" + (st.id || ""),
        at: Date.now(),
      });
      /* 「显示思考」关掉时这一行不挂进 DOM（思考数据仍在，打开开关即重绘看回） */
      if (tRow && agentThinkShown(st)) row.appendChild(tRow);
      updateAgentThinkEl(st, live);
      const tools = document.createElement("div");
      tools.className = "dsh-tools";
      tools.id = "agent-tools";
      const liveTools = live
        ? (S.nodeTools && S.nodeTools[live.id]) || []
        : Array.isArray(st._liveTools)
          ? st._liveTools
          : [];
      for (const t of liveTools)
        tools.appendChild(dshToolDetailsEl(t, true, live ? live.id : st.id));
      row.appendChild(tools);
      const body = document.createElement("div");
      body.className = "dsh-msg-body dsh-stream";
      body.id = "agent-stream";
      body.textContent = live
        ? traceSayDisplay(live.id, live._pendingAnswer)
        : st._pending || "";
      row.appendChild(body);
    }
    list.appendChild(row);
  }
  /* 会话最底部（输入框下面）：Token 消耗累计报告 Badge（点击展开，按模型分别累计） */
  if (typeof tokBadgeTailMount === "function") {
    try {
      tokBadgeTailMount(st, list);
    } catch {}
  }
  const reapplyStick = () => restoreConvStick(list, stickCap);
  scheduleHistoryCollapse(list, reapplyStick);
  restoreConvStick(list, stickCap);
  /* 折叠 / 展开、图片懒加载等会事后改变高度：补一帧再按锚点还原一次 */
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => restoreConvStick(list, stickCap));
  }
  const ws = $("#agentWsInput");
  /* 回填「生效工作区」（与运行同一真源），📂 打开的也就是文件真正落的目录 */
  if (ws && document.activeElement !== ws) ws.value = sessionWorkspaceShown(st) || "";
  const chatEnterSend = !S.config.dsh || S.config.dsh.chatEnter !== "newline";
  const inp = $("#agentInput");
  if (inp) {
    /* 消息栏草稿按视图隔离（agentDraftKeyNow）：视图换了先把上一只框的字存回它名下，
       再把新视图的草稿填进来。首轮态（开发页占位空会话）的草稿也在这一条路上存 / 取 ——
       它不属于任何会话对象，只按应用存（见上面「消息栏草稿的视图键」段）。 */
    const dkey = agentDraftKeyNow();
    const prevKey = S._agentInputDraftKey;
    if (prevKey != null && prevKey !== dkey) agentDraftStash(prevKey, inp.value);
    if (prevKey !== dkey) {
      inp.value = agentDraftLoad(dkey, st);
      S._agentInputDraftKey = dkey;
    }
    const prevId = S._agentRenderedSessionId;
    if (prevId !== st.id) S._agentRenderedSessionId = st.id;
    inp.placeholder = chatEnterSend
      ? I18n.t("描述任务…（Enter 发送，Shift+Enter 换行；输入 / 呼出技能与命令）")
      : I18n.t("描述任务…（Enter 换行，Ctrl+Enter 发送；输入 / 呼出技能与命令）");
    if (st.ltBound)
      inp.title = I18n.t("由长任务驱动：你发的消息会排队等本轮结束（不会插话打断）");
    else inp.removeAttribute("title");
  }
  /* 长任务驱动的绑定会话：输入区头部（chips 上方）挂一条归属说明。
     这条会话的运行由长任务引擎点火（app-longtask.js），用户看到的「运行中」
     不是等他插话的那一轮 —— 明说「由长任务驱动」，就不会误以为能直接对话打断；
     真要发消息仍走现成队列（app-boot.js doSend 的忙时入队），发送逻辑一行不改。 */
  const composer = inp ? inp.closest(".agent-composer") : null;
  if (composer) {
    let ltNote = composer.querySelector(".agent-lt-note");
    if (st.ltBound) {
      if (!ltNote) {
        ltNote = document.createElement("div");
        ltNote.className = "agent-lt-note";
        composer.insertBefore(ltNote, composer.firstChild);
      }
      ltNote.textContent = I18n.t("由长任务驱动 · 这条会话归长周期任务所有");
      ltNote.title = I18n.t(
        "过程与结果由长任务自动写入；运行中你发的消息会排在后面等本轮结束，不会打断它",
      );
    } else if (ltNote) {
      ltNote.remove();
    }
  }
  const presetSel = $("#agentPresetSel");
  if (presetSel) presetSel.value = st.preset || AGENT_PRESET_DEFAULT;
  const provSel = $("#agentProvSel");
  const modelSel = $("#agentModelSel");
  if (provSel && modelSel) {
    const catalog = S.providerCatalog || {
      deepseek: [
        { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", input: ["text", "image"] },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
      ],
      piai: [],
    };
    let curProv = st.provider || "deepseek-official";
    provSel.innerHTML = "";
    const addOpt = (sel, value, label, group) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
      return o;
    };
    /* 供应商用各自名称(DeepSeek 官方路由显示为配置的 DeepSeek 服务商名称)；
       官方路由对应的 DeepSeek 服务商被停用时这条不列，mtnode_ 那些由
       mtnodePiProviders 过滤（停用的不进清单） */
    const mtnode = mtnodePiProviders();
    const dp = dshProvider();
    const dsOk =
      typeof deepseekRouteSelectable === "function"
        ? deepseekRouteSelectable(S.config)
        : true;
    if (dsOk)
      addOpt(provSel, "deepseek-official", (dp && dp.name) || I18n.t("DeepSeek 官方"), null);
    for (const p of mtnode)
      addOpt(provSel, "mtnode_" + p.route, p.name, null);
    /* 仅显示已添加的供应商(DeepSeek 官方 + MTNode 服务商);
       目录服务商经「添加服务商」加入后才会出现 */
    if (![...provSel.options].some((o) => o.value === curProv)) {
      curProv = preferredAgentProviderRoute();
      st.provider = curProv;
      persistAgentSession();
    }
    provSel.value = curProv;
    const modelsFor = (prov) => {
      if (prov === "deepseek-official") {
        /* 仅显示已添加的模型:优先用配置的 DeepSeek 服务商模型,否则目录默认 */
        const dp = dshProvider();
        if (dp && Array.isArray(dp.models) && dp.models.length)
          return dp.models.map((m) => ({ id: String(m), name: "" }));
        return (catalog.deepseek || []).map((m) => ({ id: m.id, name: m.name }));
      }
      const mp = mtnode.find((x) => "mtnode_" + x.route === prov);
      return ((mp && mp.models) || []).map((id) => ({ id, name: "" }));
    };
    const fillModels = (prov) => {
      const items = modelsFor(prov);
      const cur = st.model || (items[0] && items[0].id) || "deepseek-flash";
      modelSel.innerHTML = "";
      const list = items.slice();
      if (cur && !list.some((x) => x.id === cur)) list.unshift({ id: cur, name: "" });
      const vis = new Set(visionModelsForProvider(prov).map((m) => m.id));
      for (const m of list)
        addOpt(modelSel, m.id, modelLabel(m, vis), null);
      modelSel.value = cur;
    };
    fillModels(curProv);
    provSel.onchange = () => {
      st.provider = provSel.value;
      const first = modelsFor(provSel.value)[0];
      st.model = first ? first.id : "";
      persistAgentSession();
      fillModels(provSel.value);
      renderAgentSessionSidebar();
    };
    modelSel.onchange = () => {
      st.model = modelSel.value;
      persistAgentSession();
    };
  }
  const effortSel = $("#agentEffortSel");
  if (effortSel) {
    /* 白名单回显：词汇表内档位原样保留（不重置已存档位） */
    const cur = normalizeAgentEffort(st.effort);
    effortSel.value = AGENT_EFFORT_UI_ORDER.includes(cur) ? cur : "high";
    if (st.effort !== cur) st.effort = cur;
  }
  /* 「上下文已用 X / Y tok」那行文字已随圆环一并移除（本次需求：与 Token 报告重复）——
     用量只看会话末尾的 Token 报告（.tok-badge）。 */
  /* 发送按钮:空闲「发送」；运行中且有输入 → 「排队发送 ↑」；运行中且输入为空 → 红色「终止 ■」 */
  paintAgentSendState();
  renderAgentQueueBar(st);
  renderAgentTodoPanel(st);
  /* 轮次标签（本次需求）：同一处渲染路径落一次，切会话 / 重绘都按这条会话自己的
     轮次记录显示（没有记录 = 空会话 / 从未开跑过一轮 → 整行不占位）。 */
  try {
    if (typeof agentRoundLabelApply === "function") agentRoundLabelApply(st);
  } catch (_) {}
  /* 「计划」面板：只吃当前这个 st（切会话时重绘，不残留上一会话的清单） */
  try {
    if (typeof renderAgentPlanPanel === "function") renderAgentPlanPanel(st);
  } catch (_) {}
  renderAgentComposer();
  renderAgentSessionSidebar();
  renderSessionFooterStat();
}

/* 运行中不取消任务：输入框有字就是「加入队列」，没字才是「终止」。
   「⚡插话」「⏸暂停」是另两枚**轮内实时**键（不是把 ■ 拆三色）：只在当前会话确实
   有一轮在跑时出现，桥不支持（老网关 / 老运行时）就整枚不显示 / 置灰说明。 */
function paintAgentSendState() {
  const sendBtn = $("#agentSend");
  if (!sendBtn) return;
  const inp = $("#agentInput");
  const st = agentSessionState();
  const busy = !!sessionIsRunning(st);
  const hasText = !!(inp && String(inp.value || "").trim());
  const stopMode = busy && !hasText;
  sendBtn.textContent = busy ? (hasText ? "↑" : "■") : "↑";
  sendBtn.classList.toggle("danger", stopMode);
  sendBtn.classList.toggle("queue-mode", busy && hasText);
  sendBtn.title = busy
    ? hasText
      ? I18n.t("加入发送队列（不打断当前任务）")
      : I18n.t("终止本会话当前运行（只停这一路）")
    : I18n.t("发送(Enter 发送,Shift+Enter 换行)");
  paintAgentInflightButtons(st, busy);
  /* 输入框上方的内嵌图胶囊条：与正文里的图行一一对应（本文件末段） */
  try {
    chatInlineImgTick();
  } catch (_) {}
  /* 会话头部的「对话 / 轨迹」标签（本次需求 · 对齐上游 conversation.view 环）：
     每次会话重绘都同步一次 —— 标签显隐、轨迹内容与检查器都归 app-trajectory.js；
     它自己的 1.5s 轮询只是兜底（切会话 / 运行推进这类路径不该等一轮）。 */
  try {
    if (window.MTNodeTrajectory && typeof MTNodeTrajectory.sync === "function")
      MTNodeTrajectory.sync();
  } catch (_) {}
}

/* 两枚轮内实时键的显隐 / 可用性 + 「已暂停」条（三者同源：都看当前会话的在跑状态）
   降级必须在界面上说得出话：
     · 桥压根没有这枚方法（老主进程 / 老 preload）→ 整枚不显示（没有可解释的必要）；
     · 引擎回 unsupported（老网关 / 老运行时）→ 键还在、但改成「按下去也只是排队」：
       用 .is-unsupported 置灰而**不是** disabled —— disabled 的按钮在 Chromium 里
       不派发鼠标事件，原生 title 提示也跟着出不来，用户只会觉得点了没反应。 */
function paintAgentInflightButtons(st, busy) {
  const b = !!busy && !!st;
  const steer = document.getElementById("agentSteer");
  if (steer) {
    const has = agentSteerCapable();
    const on = b && has && String(($("#agentInput") || {}).value || "").trim();
    steer.style.display = on ? "" : "none";
    steer.classList.toggle("is-unsupported", !!(on && S._steerUnsupported));
    steer.textContent = I18n.t("⚡ 插话");
    steer.title =
      on && S._steerUnsupported
        ? I18n.t("当前引擎不支持轮内插话（已改走发送队列）")
        : I18n.t("插话：本轮下一步就听见（不打断当前这一步）");
    if (!steer._bnd) {
      steer._bnd = true;
      steer.onclick = () => {
        const inp = $("#agentInput");
        const s = agentSessionState();
        const body = String((inp && inp.value) || "").trim();
        if (!s || !body) return;
        if (inp) inp.value = "";
        Promise.resolve(agentSteerNow(s, body)).then(() => {
          paintAgentSendState();
          if (inp) inp.focus();
        });
      };
    }
  }
  const pause = document.getElementById("agentPause");
  if (pause) {
    const has = agentPauseCapable();
    const on = b && has;
    pause.style.display = on ? "" : "none";
    pause.classList.toggle("is-unsupported", !!(on && S._pauseUnsupported));
    /* 暂停请求已经发出去（等那一轮停在当前步）时才真的按不动：
       这一枚是暂时的，不是能力缺失。 */
    pause.disabled = !!(on && st && st._pausePending);
    pause.textContent = pause.disabled
      ? I18n.t("⏸ 正在暂停")
      : I18n.t("⏸ 暂停");
    pause.title =
      on && S._pauseUnsupported
        ? I18n.t("当前引擎不支持暂停（可用 ■ 终止这一轮）")
        : I18n.t("暂停本轮（保留上下文，可继续）");
    if (!pause._bnd) {
      pause._bnd = true;
      pause.onclick = () => {
        const s = agentSessionState();
        if (s) Promise.resolve(agentPauseNow(s)).then(() => paintAgentSendState());
      };
    }
  }
  try {
    renderAgentPausedBar(st);
  } catch (_) {}
}

/* ── 会话侧边栏:按项目目录（工作路径最内层文件夹）归类,支持归档(参考 dsh) ── */
/* 会话改名:双击名称或点「改名」按钮,行内编辑(Enter 确认 · Esc 取消) */
function startSessionTitleEdit(s, nameEl) {
  if (!nameEl || !s) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "n-title-input side-sess-name-input";
  input.value = s.title || "";
  input.spellcheck = false;
  input.title = I18n.t("回车确认 · Esc 取消");
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== s.title) {
      s.title = v;
      /* 用户亲口改的名 = 标题真源：钉住它，引擎的自动命名（含在飞迟到的事件）不再覆盖 */
      s.titleLocked = true;
      s.titleAuto = false;
      s.updatedAt = Date.now();
      /* 标题映射:会话名称 → 关联 agent_task / 开发节点标题(双向,后写优先) */
      const wfs = [S.wf, ...Object.values(S.wfBag || {})];
      let touched = false;
      const devTitle = v.replace(/^(开发|细化|Dev|Refine)\s*·\s*/i, "").trim();
      for (const wf of wfs) {
        if (!wf || !Array.isArray(wf.nodes)) continue;
        for (const n of wf.nodes) {
          if (n.kind === "agent_task" && n.agentSessionId === s.id) {
            n.title = v;
            touched = true;
          } else if (
            n.kind === "super" &&
            n.dev &&
            n.agentSessionId === s.id &&
            devTitle
          ) {
            n.title = devTitle;
            touched = true;
          }
        }
      }
      if (touched) scheduleSave();
      persistAgentSession().catch(() => {});
    }
    renderAgentSessionSidebar();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("mousedown", (ev) => ev.stopPropagation());
}
function renderAgentSessionSidebar() {
  /* 开发页（renderer/app-apps-dev.js）借用本函数：它的三栏页开着时，这里按宿主给的
     **应用分组**渲染（第一层是应用行，会话折叠在各自应用下，写进开发页左栏 #appsDevSideList）；
     宿主不在 → 逐字走原来的总会话视图，#agentSideList 的渲染一字未改。 */
  const host = typeof appsDevSidebarHost === "function" ? appsDevSidebarHost() : null;
  const hostApps = host && Array.isArray(host.apps) ? host.apps : null;
  const all = agentSessions();
  const active = host ? String(host.active || "") : activeAgentId();
  const list =
    hostApps !== null
      ? hostApps.reduce(
          (out, g) => out.concat(Array.isArray(g.sessions) ? g.sessions : []),
          [],
        )
      : host && Array.isArray(host.sessions)
        ? host.sessions
        : all;
  const activeSt = list.find((s) => s.id === active);
  /* 只写会话视图自己的容器 #agentSideList。
     历史遗留 bug：以前同时写入画布边栏 #sideTree，会话每次运行 / 每个工具事件
     都会重绘它 → 用户在画布上会「突然」看到左侧栏变成会话列表。
     规则：画布边栏只放节点/绘图/超级节点；会话列表只在会话视图内。 */
  const targets = [];
  const t2 = host ? host.listEl : $("#agentSideList");
  if (t2)
    targets.push({
      el: t2,
      filter: host
        ? String(host.filter || "").trim().toLowerCase()
        : $("#agentSideFilter")
          ? $("#agentSideFilter").value.trim().toLowerCase()
          : "",
      /* 应用分组宿主（开发页左栏）才有：应用行 + 三个动作回调 */
      apps: hostApps,
      onAppSelect: host && typeof host.onAppSelect === "function" ? host.onAppSelect : null,
      onAppToggle: host && typeof host.onAppToggle === "function" ? host.onAppToggle : null,
      onAppNew: host && typeof host.onAppNew === "function" ? host.onAppNew : null,
    });
  if (!targets.length) return;

  const groups = new Map();
  const archived = [];
  for (const s of list) {
    if (s.archived) {
      archived.push(s);
      continue;
    }
    /* 分组按「生效工作区」归：没手填的会话若仍按 st.workspace 分，会全堆进
       「默认目录」，而它们的文件其实写在画布项目根里（显示与运行分家） */
    const key = wsGroupOf(sessionWorkspaceShown(s));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  /* 排序：越新的越靠上。时间与行尾显示同源（sessionLastAt：updatedAt / 消息 / outbox 取最大），
     否则会出现「5 分钟前」排在「3 天前」下面。
     只排本次渲染用的临时数组，不动 S.agentSessions 本体顺序（持久化与截断 60 条依赖本体）。 */
  const lastAtOf = (s) => sessionLastAt(s) || Number(s && s.createdAt) || 0;
  const byNewest = (a, b) =>
    lastAtOf(b) - lastAtOf(a) ||
    String((a && a.title) || "").localeCompare(String((b && b.title) || ""));
  for (const items of groups.values()) items.sort(byNewest);
  archived.sort(byNewest);
  /* 分组之间也按组内最新会话倒序：整列从上往下读就是时间从新到旧 */
  const groupOrder = [...groups.entries()]
    .map(([key, items]) => ({
      key,
      items,
      newest: items.reduce((m, s) => Math.max(m, lastAtOf(s)), 0),
    }))
    .sort((a, b) => b.newest - a.newest || a.key.localeCompare(b.key));

  const mkRow = (s, isArchived) => {
    /* 「运行中」走展示口径：自己那一轮在跑 ∪ 名下有一组计划并行任务在跑。
       并行期间 st.running 故意为 false（保用户随时改口），只看 sessionIsRunning
       会让这一整段时间在会话列表里显示「空闲」（本 bug）。 */
    const busy =
      typeof sessionBusyForUi === "function"
        ? sessionBusyForUi(s)
        : typeof sessionIsRunning === "function"
          ? sessionIsRunning(s)
          : !!s.running;
    /* 只有并行组在跑（会话自己那轮已让位）时，悬浮说明它为什么也在转圈 */
    const parOnly =
      busy &&
      !(typeof sessionIsRunning === "function"
        ? sessionIsRunning(s)
        : !!(s && s.running));
    const row = document.createElement("div");
    row.className =
      "side-sess" + (s.id === active ? " active" : "") + (busy ? " running" : "");
    const nm = document.createElement("span");
    nm.className = "side-sess-name";
    nm.textContent = s.title || I18n.t("新会话");
    nm.title = s.title + sessionWorkspaceTooltipLine(s);
    /* 行内元信息「▣ 所属画布名」：用户切去别的画布干活时，光扫一眼会话列表就知道
       这条会话改的是哪张图 —— 不会再冒出「它怎么改到别的画布去了」这种新困惑。
       开发 / 细化 / 问询 / 建议这类节点绑定会话标题已写着「开发 · 模块名」，
       行内不再追加（两行元信息挤在一起，噪声盖过信息），归属仍留在悬浮说明里。 */
    const canvasShown = sessionIsDevBoundTitle(s) ? "" : sessionCanvasName(s);
    /* 长任务归属徽标：st.ltBound = 这条会话由长周期任务的某个环节驱动
       （app-longtask.js 的 ltBindAgentSession 写）。标题前缀「长任务 · 任务名 · 环节」
       可能被用户改名或行宽省略，所以再挂一枚小徽标 —— 扫一眼列表就能分出
       「哪条不是我自己的会话」。它说明身份，不随悬停让位（与「▣ 所属画布」不同）。 */
    let ltEl = null;
    if (s.ltBound) {
      ltEl = document.createElement("span");
      ltEl.className = "side-sess-lt";
      ltEl.textContent = I18n.t("长任务");
      ltEl.title = I18n.t(
        "由长任务驱动：这条会话归长周期任务的环节所有，过程与结果自动写入；你的消息会排队等本轮结束（不打断运行）",
      );
    }
    let wfEl = null;
    if (canvasShown) {
      wfEl = document.createElement("span");
      wfEl.className = "side-sess-wf";
      wfEl.textContent = "▣ " + canvasShown;
      wfEl.title =
        I18n.t("所属画布：") +
        canvasShown +
        "\n" +
        I18n.t("会话只读写它所属的这张画布；你切到别的画布干活不会串图");
    }
    /* 运行状态指示:转圈动效 + 「运行中」(仅运行中的会话显示) */
    const stt = document.createElement("span");
    stt.className = "side-sess-status";
    const sp = document.createElement("span");
    sp.className = "side-sess-spinner";
    stt.appendChild(sp);
    stt.appendChild(document.createTextNode(I18n.t("运行中")));
    /* 并行组在跑而会话自己那轮已让位：说清楚条目为什么也在转圈（不影响改口） */
    if (parOnly) stt.title = I18n.t("计划并行任务运行中（不打断你继续发消息）");
    const btns = document.createElement("div");
    btns.className = "side-sess-btns";
    const rn = document.createElement("button");
    rn.className = "side-sess-btn";
    rn.textContent = I18n.t("改名");
    rn.title = I18n.t("重命名该会话(便于管理)");
    rn.onclick = (ev) => {
      ev.stopPropagation();
      startSessionTitleEdit(s, nm);
    };
    const fk = document.createElement("button");
    fk.className = "side-sess-btn";
    fk.textContent = I18n.t("分支");
    fk.title = I18n.t("复制该会话为新会话(参考 dsh fork)");
    fk.onclick = async (ev) => {
      ev.stopPropagation();
      await forkAgentSession(s.id);
    };
    const ar = document.createElement("button");
    ar.className = "side-sess-btn";
    ar.textContent = isArchived ? I18n.t("恢复") : I18n.t("归档");
    ar.title = isArchived ? I18n.t("取消归档,回到对应目录分组") : I18n.t("归档该会话(收起到底部已归档区)");
    ar.onclick = async (ev) => {
      ev.stopPropagation();
      await archiveAgentSession(s.id, !isArchived);
    };
    /* 删除按钮：不再弹确认框，改成「两下确认」——
       第一下按钮变成高亮的「确认」并呼吸（armed），第二下才真删；
       鼠标一移开（mouseleave）立刻收回确认态。这样误点一下不会删掉会话，
       也不会有弹窗挡在脸上。 */
    const dl = document.createElement("button");
    dl.className = "side-sess-btn danger";
    const dlIdle = () => {
      dl.classList.remove("confirm");
      dl.textContent = I18n.t("删除");
      dl.title = I18n.t("删除该会话（点两下确认，不可撤销）");
    };
    let armed = false;
    dlIdle();
    dl.onclick = async (ev) => {
      ev.stopPropagation();
      if (!armed) {
        armed = true;
        dl.classList.add("confirm");
        dl.textContent = I18n.t("确认");
        dl.title = I18n.t("再点一下即删除该会话，记录不可恢复");
        return;
      }
      armed = false;
      await deleteAgentSession(s.id);
    };
    dl.onmouseleave = () => {
      if (!armed) return;
      armed = false;
      dlIdle();
    };
    /* 浏览器被动标记（本轮需求）：这条会话正动浏览器时挂一枚不抢焦点的小标 ——
       焦点不在该会话时按「静默处理」（不弹右栏 / 不切界面 / 不提示），
       用户扫一眼左栏就知道哪条会话在用浏览器。判据与右栏显隐同源：
       BA.browserSessions（事件盖的章）∪ 网关在跑的驱动者；BA 不在（老壳）就不挂。 */
    let baEl = null;
    try {
      const ba = window.BrowserAct;
      const hasBa =
        !!ba &&
        ((ba.browserSessions && typeof ba.browserSessions.has === "function" && ba.browserSessions.has(s.id)) ||
          (!!ba.driver && ba.driver === s.id));
      if (hasBa) {
        baEl = document.createElement("span");
        baEl.className = "side-sess-ba";
        baEl.textContent = I18n.t("浏览器");
        baEl.title = I18n.t(
          "这条会话正在用浏览器：画面在会话右边栏的「浏览器活动」里（点输入区那枚按钮即可开回）；你不在看它时它不会弹栏、也不打断你",
        );
      }
    } catch (_) {}
    btns.appendChild(rn);
    btns.appendChild(fk);
    btns.appendChild(ar);
    btns.appendChild(dl);
    row.dataset.sid = s.id;
    /* 最后对话时间（相对时长：分 / 小时 / 天…），悬浮显示完整时间戳 */
    const lastAt = sessionLastAt(s);
    const tm = document.createElement("span");
    tm.className = "side-sess-time";
    tm.dataset.ts = String(lastAt || 0);
    tm.textContent = formatRelTime(lastAt);
    tm.title = lastAt
      ? I18n.t("最后对话：") + formatMsgStamp(lastAt)
      : I18n.t("尚无对话");
    row.appendChild(stt);
    row.appendChild(nm);
    if (ltEl) row.appendChild(ltEl);
    if (baEl) row.appendChild(baEl);
    if (wfEl) row.appendChild(wfEl);
    row.appendChild(tm);
    row.appendChild(btns);
    row.onclick = async () => {
      /* 开发页开着时点行 = 切「本页显示的会话」（不动会话页的选中项） */
      agentSelectSession(s.id);
      await persistAgentSession();
      renderAgentSession();
      renderAgentSessionSidebar();
    };
    return row;
  };

  /* 应用行（开发页左栏专用）：箭头 = 展开收起，行身 = 选中该应用（中栏预览 + 右栏会话一起换，
     动作由宿主 appsDevSidebarHost 给）。作者与库页 / 开发页同一口径（appsAuthorOf）。
     行右端的「＋」= 在该应用下开一条新开发会话（本轮需求：入口从开发页顶栏挪到这里，
     每行一枚，点哪一行就是哪个应用 —— 见 app-apps-dev.js 的 appsDevNewSessionFor）。 */
  const mkAppRow = (g) => {
    const row = document.createElement("div");
    row.className = "side-apps-app" + (g.current ? " active" : "");
    row.dataset.appId = String(g.id || "");
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "side-apps-caret";
    caret.textContent = g.expanded ? "▾" : "▸";
    caret.title = g.expanded
      ? I18n.t("收起该应用的会话")
      : I18n.t("展开该应用的会话");
    caret.setAttribute("aria-expanded", g.expanded ? "true" : "false");
    caret.onclick = (ev) => {
      ev.stopPropagation();
      if (typeof g.onToggle === "function") g.onToggle(String(g.id || ""));
    };
    const nm = document.createElement("span");
    nm.className = "side-apps-name";
    nm.textContent = g.name || g.id || "";
    nm.title =
      (g.name || g.id || "") +
      (g.author ? "\n" + I18n.t("作者：") + g.author : "") +
      "\n" +
      I18n.t("点这条 = 进入该应用（中栏预览与右栏会话一起换）");
    row.appendChild(caret);
    row.appendChild(nm);
    if (g.author) {
      const au = document.createElement("span");
      au.className = "side-apps-author apps-dev-author";
      au.textContent = I18n.t("作者 ") + g.author;
      au.title = I18n.t(
        "作者：云端条目按发布账号，本机应用按 app.json 的作者（没写过则回落当前登录账号）",
      );
      row.appendChild(au);
    }
    const ct = document.createElement("span");
    ct.className = "side-apps-count";
    ct.textContent = String(Number(g.count) || 0);
    ct.title = I18n.t("该应用的会话数（不含已归档）");
    row.appendChild(ct);
    /* 「＋」新开发会话（本轮需求：从开发页顶栏挪到每条应用行右端）。
       点它 = 切到该应用并回到首轮态，下一次输入就是这条新会话的第一轮；
       与点行身（选中该应用）不同，所以 stopPropagation —— 别让行身的 onclick 再拨一次。
       宿主没给回调（老壳）就不挂这颗按钮，行其余部分一字不变。 */
    if (typeof g.onNew === "function") {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "side-apps-new";
      add.textContent = "＋";
      add.title = I18n.t("新开发会话：在这个应用下开一条新会话（点它后写下需求，回车即新建并开工）");
      add.setAttribute("aria-label", I18n.t("新开发会话"));
      add.onclick = (ev) => {
        ev.stopPropagation();
        g.onNew(String(g.id || ""));
      };
      row.appendChild(add);
    }
    row.onclick = () => {
      if (typeof g.onSelect === "function") g.onSelect(String(g.id || ""));
    };
    return row;
  };

  /* 开发页左栏：**以应用为主体** —— 每个应用一行，它的会话折叠在下面（默认只展开当前应用）。
     搜索同时搜应用名与会话标题：命中应用名 = 连它的会话一起留着；只命中会话标题 = 只留命中的
     那几条。已归档的会话不进左栏（会话页另有「已归档」区）。 */
  const renderAppSide = (tree, groups, f, target) => {
    const q = String(f || "").trim().toLowerCase();
    let shown = 0;
    for (const g of groups) {
      const name = String(g.name || "");
      const nameHit =
        !q || name.toLowerCase().includes(q) || String(g.id || "").toLowerCase().includes(q);
      const sess = (Array.isArray(g.sessions) ? g.sessions.slice() : []).sort(byNewest);
      const items =
        q && !nameHit
          ? sess.filter((s) => String((s && s.title) || "").toLowerCase().includes(q))
          : sess;
      if (q && !nameHit && !items.length) continue;
      shown++;
      tree.appendChild(
        mkAppRow({
          id: g.id,
          name: name,
          author: g.author,
          count: Number(g.count) || sess.length,
          current: !!g.current,
          expanded: !!g.expanded,
          onSelect: target.onAppSelect,
          onToggle: target.onAppToggle,
          onNew: target.onAppNew,
        }),
      );
      if (!g.expanded) continue;
      for (const s of items) {
        /* 传原对象(非拷贝)：行内改名写回 s.title，拷贝会丢修改 */
        const row = mkRow(s, false);
        row.classList.add("side-apps-sess");
        tree.appendChild(row);
      }
    }
    if (!shown) {
      const e = document.createElement("div");
      e.className = "side-empty";
      e.textContent = q ? I18n.t("没有匹配的应用或会话") : I18n.t("暂无开发中的应用");
      tree.appendChild(e);
    }
  };

  for (const target of targets) {
    const tree = target.el;
    const f = target.filter;
    tree.innerHTML = "";
    /* 应用分组宿主（开发页左栏）：第一层 = 应用，不是项目目录 —— 与总会话视图
       「按项目目录分组」是两条并列的渲染路径，谁都不会写到对方容器里。 */
    if (target.apps) {
      renderAppSide(tree, target.apps, f, target);
      continue;
    }
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "side-empty";
      e.textContent = I18n.t("暂无会话");
      tree.appendChild(e);
      continue;
    }
    for (const { key, items } of groupOrder) {
      const gh = document.createElement("div");
      gh.className = "side-group";
      gh.textContent = "📁 " + key + " · " + items.length;
      gh.title = I18n.t("项目目录: ") + key;
      tree.appendChild(gh);
      for (const s of items) {
        /* 传原对象(非拷贝):行内改名会写回 s.title,拷贝会丢失修改导致改名无效 */
        if (f && !(s.title || "").toLowerCase().includes(f) && !key.toLowerCase().includes(f)) continue;
        tree.appendChild(mkRow(s, false));
      }
    }
    if (archived.length) {
      const det = document.createElement("details");
      det.className = "side-archived";
      const sum = document.createElement("summary");
      sum.textContent = I18n.t("已归档 · ") + archived.length;
      det.appendChild(sum);
      for (const s of archived) det.appendChild(mkRow(s, true));
      tree.appendChild(det);
    }
  }
  /* 活动会话的工作目录显示同步 */
  if (activeSt) {
    const ws = $("#agentWsInput");
    if (ws && document.activeElement !== ws)
      ws.value = sessionWorkspaceShown(activeSt) || "";
  }
  startAgentSideTimeTicker();
}
/* 相对时长会一直变化：定时只刷新文本节点，不重绘列表（避免滚动位置跳动） */
let _agentSideTimeTimer = null;
function tickAgentSideTimes() {
  /* 两个宿主：总会话视图的 #agentSideList 与开发页左栏的 #appsDevSideList
     （renderer/app-apps-dev.js；同一份行渲染，谁在就刷谁） */
  for (const box of [$("#agentSideList"), $("#appsDevSideList")]) {
    if (!box) continue;
    const nodes = box.querySelectorAll(".side-sess-time[data-ts]");
    for (const el of nodes) {
      const txt = formatRelTime(Number(el.dataset.ts) || 0);
      if (el.textContent !== txt) el.textContent = txt;
    }
  }
}
function startAgentSideTimeTicker() {
  if (_agentSideTimeTimer || typeof setInterval !== "function") return;
  _agentSideTimeTimer = setInterval(() => {
    try {
      tickAgentSideTimes();
    } catch (_) {}
  }, 30000);
}
/* /compact 命令入口（会话输入区的「压缩」按钮已按需求移除）：空会话 / 运行中 / 压缩进行中均有明确提示，并防重入 */
async function agentCompact() {
  const st = agentSessionState();
  if (!st.messages.length) {
    toast(I18n.t("当前会话没有可压缩的消息"), "warn");
    return;
  }
  if (sessionIsRunning(st)) {
    toast(I18n.t("运行中不可压缩：请等待当前会话结束"), "warn");
    return;
  }
  if (st._compacting) {
    toast(I18n.t("正在压缩上文…"), "warn");
    return;
  }
  st._compacting = true;
  try {
    await agentCompactRun(st);
  } finally {
    st._compacting = false;
  }
}
async function agentCompactRun(st) {
  /* 历史存档里曾被回滚的轮次消息不参与压缩：它们已不在上下文里，摘要也不该复述它们。
     构造口径收进 agentHistoryEntries（同文去重 + 整段限长 + 把只给用户看的界面痕迹
     `_src:'dev-node'` / `_src:'ix-browser'` 挡在外面）—— 压缩摘要不该把浏览器求助的
     「已回应，模型继续中」当成用户说过的话抄进去。 */
  const rbSrc = activeSessionMessages(st.messages);
  const hist = agentHistoryEntries({ messages: rbSrc }, { maxChars: 40000, skipLast: false })
    .map((r) => (r.role === "user" ? "用户：" : "助手：") + r.text)
    .join("\n\n");
  toast(I18n.t("正在压缩上文…"), "ok");
  try {
    const summary = await dshRunTask(
      "【压缩任务】把以下对话压缩为一段简明摘要,保留任务目标、关键结论与未完成事项:\n\n" + hist.slice(-40000),
      {
        runKey: "agent:" + st.id,
        /* 与本轮运行同一真源（手填 > 画布项目根 > 默认）：压缩用的引擎目录
           必须与会话运行一致，否则引擎按不同工作区重启、上文的账也分家 */
        workspace: agentRunWorkspace(st),
        preset: st.preset || AGENT_PRESET_DEFAULT,
        provider: st.provider || "deepseek-official",
        model: st.model || undefined,
        effort: st.effort || "high",
        onDone: (d) => recordDshMetrics(null, d.metrics),
      },
    );
    st.messages = [
      { role: "assistant", content: "（上文已压缩）\n\n" + summary },
    ];
    toast(I18n.t("上文已压缩"), "ok");
  } catch (e) {
    toast(I18n.t("压缩失败：") + (e.message || String(e)), "err");
  }
  await persistAgentSession();
  renderAgentSession();
}
/* 规划模式开关（/plan 命令入口，会话「规划」按钮已按需求移除），文案口径保持一致 */
async function setPlanMode(st, on) {
  st.planNext = !!on;
  if (!st.planNext) st._planDelivered = false;
  await persistAgentSession();
  renderAgentComposer();
  toast(
    st.planNext
      ? I18n.t("规划模式已开启：本轮只制定计划，不做任何改动")
      : I18n.t("规划模式已关闭：恢复直接执行改动"),
    "ok",
  );
}

/* 「▶ 执行计划」：关闭规划模式并按上一条已给出的计划开始实施 */
async function agentExecutePlan() {
  const st = agentSessionState();
  if (sessionIsRunning(st)) {
    toast(I18n.t("会话正在运行中"), "warn");
    return;
  }
  if (!st._planDelivered) {
    toast(I18n.t("当前会话还没有待执行的计划"), "warn");
    return;
  }
  st.planNext = false;
  st._planDelivered = false;
  await persistAgentSession();
  renderAgentComposer();
  await agentSessionSend(
    I18n.t(
      "计划已确认：请严格按上一条计划开始实施，不要重复规划；逐步执行并在结束时报告改动与验证结果。",
    ),
    /* 显式带上 owner 会话 id：点「执行计划」后即使立刻切换会话，实施轮仍回到本会话 */
    { planFlow: false, sessionId: st.id },
  );
}

/* 规划模式：注入到用户消息最前端的硬约束（与 planModeSystemNote 的双重约束，
   画布 / 应用改动另有宿主级拦截 handleCanvasEvent → planModeCanvasDeniedError）
   模型面向的指令文本，与其他注入说明一致保持中文 */
const PLAN_MODE_USER_DIRECTIVE =
  "【规划模式 · 本轮只出计划】本轮的唯一交付物是一份可照做的计划，绝不是改动。\n" +
  "禁止：创建 / 修改 / 删除任何文件（write、edit、str_replace_editor）；执行任何有副作用的命令（安装、删除、移动、复制、构建、git commit/checkout、重启服务、清理目录）；调用 mtnode_canvas_edit 或 mtnode_app 的修改类动作（宿主会直接拒绝并返回错误）；用 todo_write 登记执行清单；用 create_goal 立执行目标；用 subagent 派生实现工作。\n" +
  "允许并鼓励只读调研：read、glob、grep、只读命令（node --check、git status、git diff）、mtnode_canvas_get（带 detail:\"standard\"）、mtnode_db 查询、web_search、加载技能。\n" +
  "输出要求：以 # 一级标题开头，依次给出 ① 目标与验收标准 ② 现状与关键约束（引用具体文件与行号）③ 分步实施清单（每步写明文件、改动要点、为什么）④ 验证方法 ⑤ 风险与回滚；步骤要具体到无需二次决策。\n" +
  "写完计划立即结束本轮：不要开始实施，也不要追问「是否可以执行」——用户会点击输入区的「执行计划」进入实施。\n\n";

/* ============ 会话发送队列（运行中收到的新消息按序排队） ============ */

/* 入队：保留原文，不打断当前轮；计划执行消息的元数据一并随条目保存，
   drain 时据此原样恢复 opts 发送：已终止 / 清除 / 另起一轮的残留绝不会被当作普通消息发出。 */
async function agentEnqueueMessage(st, text, opts) {
  if (!st) return;
  if (!Array.isArray(st.outbox)) st.outbox = [];
  const body = String(text || "").trim();
  if (!body) return;
  const o = opts || {};
  st.outbox.push({
    id: uid("ob"),
    text: body,
    at: Date.now(),
    /* 计划执行残留标记：runId + 归属会话随条目保存，排水时校验不通过则整条丢弃 */
    _planExec: !!o._planExec || undefined,
    planRunId: o.planRunId != null ? String(o.planRunId) : undefined,
    sessionId: o.sessionId != null ? String(o.sessionId) : String(st.id || ""),
  });
  st.updatedAt = Date.now();
  await persistAgentSession();
  if (agentViewIs(st)) {
    renderAgentQueueBar(st);
    $("#agentInput") && $("#agentInput").focus();
  } else renderAgentSessionSidebar();
  /* 入队 = 这条会话的运行态可能刚被延后（跑完还要接下一轮）：队列同步一次 */
  updateRunQueuePanel();
  /* _quiet：调用方自己会给一句更准确的说法（如「插话没赶上这一轮」），
     不再叠一条泛化 toast —— 同一次点击只该有一句解释。 */
  if (!o._quiet) toast(I18n.t("已加入发送队列，当前任务继续执行"), "ok");
}

/* 删除一条 / 清空整个队列 */
async function agentRemoveQueued(st, id) {
  if (!st || !Array.isArray(st.outbox)) return;
  st.outbox = st.outbox.filter((x) => x.id !== id);
  await persistAgentSession();
  if (agentViewIs(st)) renderAgentQueueBar(st);
}
async function agentClearQueue(st) {
  if (!st || !Array.isArray(st.outbox) || !st.outbox.length) return;
  st.outbox = [];
  await persistAgentSession();
  if (agentViewIs(st)) renderAgentQueueBar(st);
}

/* ══════════════ 轮内「插话」(steer) 与「暂停」(pause) ══════════════
   两条实时操作都作用在**正在跑的这一轮**上，与「■ 终止」是三条不同的路：
     · 插话 = 这一轮继续跑，只是把用户新说的一句话塞进它的下一步边界
       （运行时 InboxTarget='next-step'：当前这一步不剪断，下一步读到它）；
     · 暂停 = 中止当前请求，但**保留 live 会话与收件箱**（agent.cancel(...,{keepInbox:true})），
       网关以 done{paused:true} 收尾且绝不发 error（否则宿主会按失败自动重发 5 轮）；
     · 终止 = 旧语义，整轮作废、上下文按原样留下，不动队列以外的任何东西。
   链路：渲染层 window.api.dshSteer / dshPause → 主进程 dsh:steer|dsh:pause →
   网关按在途表（reqId|cancelTag → 那一轮的 runtime）下发 session/steer|session/pause。
   渲染层拿不到网关的 reqId（事件在 preload 里按 reqId 过滤掉了），所以一律用
   cancelTag = "agent:"+会话 id 点名自己那一轮，再带上 sessionId 收窄（同一标签并发时不串台）。
   任一环节送不出去（老网关 / 老运行时 / 这一轮已经结束）都回 {ok:false,reason:'unsupported'}，
   宿主一律回落既有的「发送队列」，绝不让用户点了没反应。 */

/* 这一轮当前那条 live dsh 会话 id（app-db.js captureRunSession 登记在 S._runSession[runKey]）。
   暂停收尾时那份登记特意留着（见 app-db.js finish 的 keepRunSession），「继续」正是按它续跑。 */
function agentLiveRunSid(st) {
  if (!st || !st.id) return "";
  const k = "agent:" + st.id;
  const e = S._runSession && S._runSession[k];
  const live = e && e.sid ? String(e.sid) : "";
  if (live) st._liveSid = live;
  return live || String(st._liveSid || "");
}
/* 桥在不在（老版本主进程 / preload 没有这两个方法）：决定按钮显不显示。
   unsupported 只做一次性记忆（S._steerUnsupported / S._pauseUnsupported）→ 键面置灰
   + tooltip 说明，但**照样按得动**：按下去直接排队，不再白跑一趟 IPC。 */
function agentSteerCapable() {
  return !!(window.api && typeof window.api.dshSteer === "function");
}
function agentPauseCapable() {
  return !!(window.api && typeof window.api.dshPause === "function");
}
/* 「引擎没有这枚能力」与「这一枪没赶上」必须分开：
   · 老运行时没有 session/steer|session/pause → 回的是 unknown method（网关把它压进
     detail，形如 "unknown DeepSeek Harness SDK runtime method: session/steer"）；
   · 老网关连 steer / pause 这两枚 stdio 方法都没有 → 错误从 main.js 的 catch 成形，
     落在 error 字段上（"unknown method: steer"）。
   认这两处文案即可。其它 unsupported（没有在途这一轮 / 那台 runtime 已回收 / 下达
   超时）都只是本轮恰好已经结束，绝不能因此把按钮永久焊死 —— 下一轮照样要能插话。 */
const DSH_NO_SUCH_METHOD =
  /unknown[ a-z0-9/-]*method|method not found|no such method|is not a function/i;
function agentCapabilityMissing(r) {
  if (!r) return false;
  return DSH_NO_SUCH_METHOD.test(
    String((r && r.detail) || "") + " " + String((r && r.error) || ""),
  );
}

/* 插话：把这句话塞进正在跑的那一轮。返回 true = 本轮已收到（该清空输入框）。 */
async function agentSteerNow(st, text) {
  const body = String(text || "").trim();
  if (!st || !body) return false;
  /* 这一轮已经跑完 / 桥没有插话能力 → 没有「本轮」可插，按普通一轮发出去（空闲即直接跑） */
  if (!agentSteerCapable() || !sessionIsRunning(st)) {
    await agentSessionSend(body, { sessionId: st.id });
    return true;
  }
  /* 已经知道这台引擎没有这枚方法（置灰态）：不再白跑一趟 IPC，直接排队并说明一次。
     键照样按得动、话照样送得出去 —— 只是它走的是既有的发送队列。 */
  if (S._steerUnsupported) {
    await agentEnqueueMessage(st, body, { sessionId: st.id, _quiet: true });
    try {
      toast(I18n.t("当前引擎不支持轮内插话，已按排队发送"), "warn");
    } catch (_) {}
    return true;
  }
  let r = null;
  try {
    r = await window.api.dshSteer({
      cancelTag: "agent:" + st.id,
      sessionId: agentLiveRunSid(st),
      text: body,
    });
  } catch (e) {
    r = { ok: false, reason: "error", detail: String((e && e.message) || e) };
  }
  if (r && r.ok) {
    /* 气泡先按「已插话 · 将在下一步生效」落地；运行时真把它塞进收件箱时会吐一帧
       agent/inbox/spliced（网关原样透传成 session-event），届时升级为「已注入」。 */
    st.messages.push({
      role: "user",
      content: body,
      at: Date.now(),
      _kind: "steer",
      _steerState: "sent",
    });
    st.updatedAt = Date.now();
    await persistAgentSession();
    if (agentViewIs(st)) renderAgentSession();
    else renderAgentSessionSidebar();
    try {
      toast(I18n.t("已插话 · 将在下一步生效"), "ok");
    } catch (_) {}
    return true;
  }
  /* 送不进去 → 回落发送队列（与 Enter 完全同义：本轮结束后自动发出），一句话都不丢。
     两种失败分开说：
     · 引擎根本没有这枚方法（老网关 / 老运行时）→ 记一次，按钮从此置灰 + tooltip，
       免得用户反复点一个永远无效键；
     · 其它（本轮刚好已经结束 / 那台 runtime 已回收 / 下达超时）→ 什么都不记，
       下一轮照样还能插话。 */
  const gap = agentCapabilityMissing(r);
  if (gap) S._steerUnsupported = true;
  /* _quiet：这里自己给一句更准确的说法，不叠第二条泛化 toast */
  await agentEnqueueMessage(st, body, { sessionId: st.id, _quiet: true });
  try {
    toast(
      I18n.t(
        gap
          ? "当前引擎不支持轮内插话，已按排队发送"
          : "插话没赶上这一轮，已加入发送队列",
      ),
      "warn",
    );
  } catch (_) {}
  paintAgentSendState();
  return true;
}

/* 注入回执：agent/inbox/spliced 的 data.inserted 里能找到这句话 → 标成「已注入」。
   帧本身不带 sessionId（它就在这轮的 reqId 通道上到达，天然归属本轮），
   所以按文本认气泡；认不到时把最早那条待注入的插话记为已注入（best-effort）。 */
function agentMarkSteerInjected(st, data) {
  const msgs = (st && st.messages) || [];
  const texts = [];
  const ins = data && Array.isArray(data.inserted) ? data.inserted : [];
  for (const m of ins) {
    const c = m && m.content;
    if (Array.isArray(c))
      for (const b of c) if (b && typeof b.text === "string") texts.push(b.text.trim());
    else if (typeof c === "string") texts.push(c.trim());
  }
  let hit = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m._kind !== "steer" || m._steerState === "in") continue;
    const want = String(m.content || "").trim();
    if (texts.length && texts.indexOf(want) < 0) continue;
    hit = m;
    break;
  }
  if (!hit) {
    for (const m of msgs)
      if (m && m._kind === "steer" && m._steerState !== "in") {
        hit = m;
        break;
      }
  }
  if (!hit) return;
  hit._steerState = "in";
  if (agentViewIs(st)) {
    try {
      renderAgentSession();
    } catch (_) {}
  }
}

/* 暂停：中止当前请求但保留 live 会话（≠ ■ 终止：终止会关掉那一轮，暂停留得住上下文）。
   成功下发后 UI 立刻进暂停态；本轮真正以 done{paused:true} 收尾时按现状定稿、绝不排水。 */
async function agentPauseNow(st) {
  if (!st || !st.id) return;
  if (!sessionIsRunning(st)) {
    try {
      toast(I18n.t("这一轮已经结束了"), "warn");
    } catch (_) {}
    return;
  }
  if (!agentPauseCapable()) {
    try {
      toast(I18n.t("当前版本不支持暂停，可用 ■ 终止这一轮"), "warn");
    } catch (_) {}
    return;
  }
  /* 置灰态（已知引擎没有 session/pause）：不再白跑 IPC，只把话说清楚。 */
  if (S._pauseUnsupported) {
    try {
      toast(I18n.t("当前引擎不支持暂停（可用 ■ 终止这一轮）"), "warn");
    } catch (_) {}
    return;
  }
  let r = null;
  try {
    r = await window.api.dshPause({
      cancelTag: "agent:" + st.id,
      sessionId: agentLiveRunSid(st),
    });
  } catch (e) {
    r = { ok: false, reason: "error", detail: String((e && e.message) || e) };
  }
  if (r && (r.ok || r.pending)) {
    /* ok = 运行时明确接住了；pending = 主进程那一跳没赶上回音（main-dsh 的 pause
       超时口径 {ok:false,reason:'timeout',pending:true}），暂停很可能已经落地。
       两种都先进「正在暂停」：真正定稿由那一轮的 done{paused:true} 判 ——
       它要是自己跑完了，收尾处会把 paused 撤回 false，不会留下假的暂停。 */
    st._pausePending = true;
    st.paused = true;
    if (agentViewIs(st)) {
      paintAgentSendState();
      renderAgentPausedBar(st);
    }
    updateRunQueuePanel();
    try {
      toast(
        I18n.t(
          r.ok
            ? "已暂停 · 点「继续」从中断处接着跑"
            : "正在暂停 · 本轮会停在当前这一步",
        ),
        "ok",
      );
    } catch (_) {}
    return;
  }
  /* 只有「引擎没有 session/pause 这枚方法」才值得从此置灰；
     本轮恰好已经结束 / runtime 已回收，都只是暂时的。 */
  const gap = agentCapabilityMissing(r);
  if (gap) S._pauseUnsupported = true;
  try {
    toast(
      I18n.t(
        gap
          ? "当前引擎不支持暂停（可用 ■ 终止这一轮）"
          : "暂停没有下发成功，可用 ■ 终止这一轮",
      ),
      "warn",
    );
  } catch (_) {}
}

/* 继续：清暂停态，用「断点续跑」同一通道（runParams.resumeSession）点名被暂停那条
   dsh 会话，让模型从中断处往下写，不从零重建上下文。 */
async function agentResumePaused(st) {
  if (!st || !st.id) return;
  if (sessionIsRunning(st)) return; /* 已经又跑起来了，别自己挤自己 */
  const sid = agentLiveRunSid(st);
  st.paused = false;
  st._pausePending = false;
  await persistAgentSession();
  if (agentViewIs(st)) {
    paintAgentSendState();
    renderAgentPausedBar(st);
  }
  updateRunQueuePanel();
  /* 拿不到 sid（重启过 / 运行时已回收）→ 不退化成整段历史重发：
     下面这句本身就带着「从中断处接下去」的口径，会话历史照旧随普通一轮发出。 */
  await agentSessionSend(dshPausedResumeDirective(), {
    sessionId: st.id,
    resumeSession: sid || undefined,
    _pausedResume: true,
  });
}

/* 输入区上方的「已暂停」条（与发送队列条同风格）：说清楚停在哪、队列还剩几条、怎么接。 */
function renderAgentPausedBar(st) {
  const el = document.getElementById("agentPaused");
  if (!el) return;
  const on = !!(st && st.paused);
  if (!on) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "apz-head";
  const label = document.createElement("span");
  label.className = "apz-label";
  const n = st._pausePending
    ? I18n.t("正在暂停 · 本轮会停在当前这一步")
    : I18n.t("已暂停 · 上下文与已写出的内容都保留");
  const more = Array.isArray(st.outbox) && st.outbox.length
    ? I18n.t(" · 发送队列还有 ") + st.outbox.length + I18n.t(" 条（暂停期间不自动发送）")
    : "";
  label.textContent = n + more;
  head.appendChild(label);
  const go = document.createElement("button");
  go.type = "button";
  go.className = "apz-go mini";
  go.textContent = "▶ " + I18n.t("继续");
  go.title = I18n.t("从中断处接着跑（沿用这条会话的上下文，不重发任务）");
  go.onclick = () => {
    go.disabled = true;
    agentResumePaused(st);
  };
  head.appendChild(go);
  el.appendChild(head);
}

/* 队首出队发送：本轮彻底结束后调用（会话空闲才发，避免自己挤自己）。
   队列里可能混着 /new、/plan 这类不启动运行的命令 —— 它们同步处理完就继续放行下一条。
   _draining 闩锁：收尾处与 await 返回后可能同时想排水，必须串行，否则两条消息并发抢同一会话。
   暂停中一律不排水：用户按停就是「停在这里」，排水会把暂停变成继续。 */
async function agentDrainQueue(st) {
  try {
    if (!st || !Array.isArray(st.outbox) || !st.outbox.length) return;
    if (st._draining || sessionIsRunning(st) || st.paused) return;
    st._draining = true;
    try {
      while (st.outbox.length && !sessionIsRunning(st)) {
        /* 队列属于它自己那条会话：会话没了（被删 / 归档后清空）就整条作废，不再外漏 */
        if (!agentSessionById(st.id)) {
          st.outbox = [];
          break;
        }
        const item = st.outbox.shift();
        await persistAgentSession();
        if (agentViewIs(st)) renderAgentQueueBar(st);
        /* 出队发送：队列少一条、这条会话即将接下一轮运行 → 左下角同步一次 */
        updateRunQueuePanel();
        if (!item || !item.text) continue;
        /* 计划执行残留的排队条目：发出前必须仍然有效 —— 游标还在、runId 对上、
           归属仍是这条会话（planOwnedHere / planCursorOwned）。
           已终止 / 清除 / 另起一轮的旧任务一律丢弃，绝不当作普通消息自动发出。 */
        if (item._planExec) {
          let keep = false;
          try {
            keep =
              !!(st && st._planExec && st.plan) &&
              String((st._planExec && st._planExec.runId) || "") ===
                String(item.planRunId || "") &&
              typeof planOwnedHere === "function" &&
              planOwnedHere(st) &&
              typeof planCursorOwned === "function" &&
              planCursorOwned(st);
          } catch (_) {}
          if (!keep) continue; /* 丢弃：这项计划已经不存在 / 不归本会话 */
        }
        /* sessionId 固定为这条队列所属的会话：排水期间用户切了会话，
           排队消息（含计划续跑的那一轮）也不会漏进别的会话。
           计划执行消息原样恢复入队时的 opts（_planExec / planRunId / sessionId）。 */
        await agentSessionSend(
          item.text,
          item._planExec
            ? {
                _planExec: true,
                planRunId: item.planRunId,
                sessionId: item.sessionId || st.id,
              }
            : { sessionId: st.id },
        );
      }
    } finally {
      st._draining = false;
    }
  } catch (_) {}
}

/* 输入区上方的队列条：N 条待发送 + 逐条删除 + 清空 */
/* 还没生效的插话（本次需求 · 上游的 pending-steering 区）：
   _kind==="steer" 且 _steerState !== "in" 的用户消息 = 已递交给正在跑的这一轮、
   还在等它走到下一步边界；它们与「排队待发」是两件事，故在输入区上方分成两栏显示。 */
function agentPendingSteers(st) {
  const out = [];
  for (const m of Array.isArray(st && st.messages) ? st.messages : []) {
    if (!m || m._kind !== "steer") continue;
    if (m._steerState === "in") continue;
    const txt = String(m.content || "").trim();
    if (txt) out.push(m);
  }
  return out.slice(-3);
}

function renderAgentQueueBar(st) {
  const el = document.getElementById("agentQueue");
  if (!el) return;
  /* 「已暂停」条要报队列还剩几条：队列一有增减就跟着刷一次（同一处真源，不分叉） */
  try {
    renderAgentPausedBar(st);
  } catch (_) {}
  const list = (st && Array.isArray(st.outbox) ? st.outbox : []).filter(Boolean);
  const steers = agentPendingSteers(st);
  if (!list.length && !steers.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = "";
  /* 插话在前（它马上就生效），排队在后（要等本轮结束）：上游 QueueDock 的两段读法 */
  if (steers.length) {
    const sec = document.createElement("div");
    sec.className = "aq-sec aq-sec-steer";
    const head = document.createElement("div");
    head.className = "aq-head";
    const label = document.createElement("span");
    label.className = "aq-label";
    label.textContent =
      I18n.t("已插话 · 待本轮下一步生效") + " · " + steers.length + I18n.t(" 条");
    head.appendChild(label);
    sec.appendChild(head);
    for (const m of steers) {
      const row = document.createElement("div");
      row.className = "aq-item aq-item-steer";
      const tag = document.createElement("b");
      tag.textContent = "⚡";
      const txt = document.createElement("span");
      txt.className = "aq-text";
      txt.textContent = String(m.content || "");
      txt.title = String(m.content || "");
      row.appendChild(tag);
      row.appendChild(txt);
      sec.appendChild(row);
    }
    el.appendChild(sec);
  }
  if (list.length) {
    const sec = document.createElement("div");
    sec.className = "aq-sec aq-sec-queue";
    const head = document.createElement("div");
    head.className = "aq-head";
    const label = document.createElement("span");
    label.className = "aq-label";
    label.textContent =
      I18n.t("发送队列") + " · " + list.length + I18n.t(" 条（当前任务结束后依次发送）");
    head.appendChild(label);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "aq-clear mini";
    clear.textContent = I18n.t("清空");
    clear.onclick = () => agentClearQueue(st);
    head.appendChild(clear);
    sec.appendChild(head);
    const rows = document.createElement("div");
    rows.className = "aq-list";
    list.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "aq-item";
      const idx = document.createElement("b");
      idx.textContent = String(i + 1);
      const txt = document.createElement("span");
      txt.className = "aq-text";
      txt.textContent = it.text;
      txt.title = it.text;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "aq-del";
      del.textContent = "✕";
      del.title = I18n.t("移出队列");
      del.onclick = () => agentRemoveQueued(st, it.id);
      row.appendChild(idx);
      row.appendChild(txt);
      row.appendChild(del);
      rows.appendChild(row);
    });
    sec.appendChild(rows);
    el.appendChild(sec);
  }
}

/* ── 「上下文已用 X / Y tok」圆环：整只移除（本次需求）────────────────────────
 * 原落点：输入卡片下方 .agent-composer 里一枚圆环 + 百分比 + 「上下文已用 0 / 1.0M tok」
 * 文字（#agentCtxMeter / #agentCtx），data 取 st.metrics 的 inputTokens+outputTokens 与
 * contextWindow，点一下开 usage 分布面板。
 * 移除理由（用户口径）：它和会话末尾的 Token 报告是同一份 token 数据的另一种说法，
 * 重复；用量一律以报告为准。相关一并撤掉的东西：
 *   · app-boot.js 里 #agentCtx 的点击委托（圆环没了就没有可点的宿主元素）；
 *   · dsh.css 里 .agent-ctx-meter / .acm-ring / .acm-track / .acm-fill / .acm-pct / .acm-text；
 *   · i18n 词条「上下文已用 」。
 * 报告侧一字未动：Token 报告仍然是 tok-badge（app-agent.js 的 renderAgentMetrics /
 * tokBadgeTouch + 本文件的 renderSessionFooterStat），逐轮与逐模型明细全在里面。
 * 别再把它加回来：token 的真源是网关 stats（见 gateway.mjs 的 accountUsage）。 */

/* ============ 新一轮（本次需求）：清掉上一轮已了结的计划与任务清单 ============
 * 用户口径：会话里开启新一轮对话或任务时，自动清掉下方上一轮的「已完成」计划与步骤，
 * 免得被当成本轮要做的事。落地成三条规矩：
 *   ① 时机 = 用户发出的消息**真正开跑**的那一瞬（agentSessionSend 里过了「会话忙」闸、
 *      消息已入消息流之后）；上一轮还在跑时新消息先进发送队列（agentEnqueueMessage），
 *      等它排水开跑时才清 —— 与「开启新一轮」的实际时机完全对齐。
 *   ② 判据 = 两块卡**各自判、各自清**：该卡里没有待执行 / 执行中项（只剩 done / skipped /
 *      failed / unknown）就整份清掉并落盘（刷新 / 切会话 / 重启都不复活）；还有没跑完的
 *      项就整份保留（「▶ 继续执行」入口不丢），并在计划面板头部标一行「上一轮遗留」。
 *      failed / unknown 属于上一轮的账，一并清掉（用户口径：不想被当成本轮待办）。
 *   ③ 豁免 = 不属于「用户开的新一轮」的轮次一律不清：计划执行器的自动续跑轮（_planExec）、
 *      清单同步轮（_todoSync）、计划漏弹纠错轮（_planFix）、暂停恢复轮（resumeSession）；
 *      另外计划正在跑（st._planExec 在）或会话处于暂停态时也跳过（别把在跑的进度与「继续」
 *      入口弄丢），等跑完之后的下一轮再按规矩清。
 * 不做的事：只动两块面板的数据 / 显示与顶部轮次标签；消息历史、轨迹归档、Token 报告、
 * 运行队列、手动「清除」按钮一律不碰。清理**不打** _planDrops（作废计数）—— 那不是用户
 * 终止 / 清除的动作，不能牵连后续新计划与续跑入口的点亮。 */

/* 计划清单是否「全部了结」：没有可用步骤或没有待执行 / 执行中项 → true */
function agentRoundPlanSettled(plan) {
  if (!plan || !Array.isArray(plan.steps)) return true;
  return !plan.steps.some(
    (s) => s && (s.status === "pending" || s.status === "active"),
  );
}
/* 任务清单是否「全部了结」：没有条目或没有待办 / 进行中项 → true */
function agentRoundTodosSettled(todos) {
  if (!Array.isArray(todos)) return true;
  return !todos.some((t) => t && (t.status === "pending" || t.status === "active"));
}
/* 清理一份已了结的计划：数据层真删 + 面板收起（与手动「清除」同效果，但不打作废计数）。
   返回 true = 这份计划是被这次清理拿掉的。 */
function agentRoundClearPlan(st) {
  if (!st || !st.plan) return false;
  if (!agentRoundPlanSettled(st.plan)) return false;
  st.plan = null;
  try {
    delete st._planExec;
  } catch (_) {}
  st._planDelivered = false;
  st.planCollapsed = false;
  st._planOpen = null;
  try {
    if (typeof renderAgentPlanPanel === "function") renderAgentPlanPanel(st);
  } catch (_) {}
  return true;
}
/* 清理一份已了结的任务清单：条目清空 + 记账进 todoHidden（模型下一轮若又写回同一批
   内容也不会让它复活，与逐条删除同口径）。返回 true = 这次真清掉了东西。 */
function agentRoundClearTodos(st) {
  if (!st) return false;
  const list = Array.isArray(st.todos) ? st.todos : [];
  if (!list.length || !agentRoundTodosSettled(list)) return false;
  st.todoHidden = st.todoHidden || [];
  for (const t of list) {
    const c = String((t && t.content) || "");
    if (c && st.todoHidden.indexOf(c) < 0) st.todoHidden.push(c);
  }
  st.todos = [];
  try {
    if (typeof renderAgentTodoPanel === "function") renderAgentTodoPanel(st);
  } catch (_) {}
  return true;
}
/* ── 会话时间区间（本次需求 · 用户口径）：会话区左上角**不再报轮数** ──
 * 只报**整个会话**的时间区间：第一条消息 → 最后一条消息（跨轮累计）。
 * 区间一律从消息历史现推（重启后自然复原，没有第二个计数器、也没有持久键要搬）；
 * 轮号仍只在轨迹 / 改动两栏按「第 N 轮」分组（那里的号取自 agentRoundOfRun，一行未动）。 */
function agentRoundHm(d) {
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
function agentRoundTime(atMs) {
  return agentRoundHm(new Date(Number(atMs) || Date.now()));
}
/* 时刻文案：同一天 → 「HH:MM」；跨天 → 各带「MM-DD 」前缀（跨零点的会话能一眼看出跨天）。
   日期格式只写这一处，标签与 tooltip 两边共用。 */
function agentRoundTimeOf(atMs, withDay) {
  const d = new Date(Number(atMs) || Date.now());
  if (!withDay) return agentRoundHm(d);
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + agentRoundHm(d);
}
/* 整个会话的时间区间 = 历史里**第一条带时刻的消息** → **最后一条带时刻的消息**
   （用户 / 助手消息都算，这就是「第一次消息开始到最后一条」）。一条带时刻的都没有
   （空会话 / 老存档没写 at）→ { from: 0, to: 0 }，调用方整行不占位、也绝不编一个时刻。 */
function agentRoundRange(st) {
  const msgs = (st && Array.isArray(st.messages) && st.messages) || [];
  let from = 0;
  let to = 0;
  for (const m of msgs) {
    const at = Number(m && (m.at || m.createdAt || m.ts)) || 0;
    if (!(at > 0)) continue;
    if (!from || at < from) from = at;
    if (at > to) to = at;
  }
  return { from, to };
}
/* 区间文案：「09:07 – 10:32」；只有一条消息（起 = 止）→ 只报一个时刻，
   不写「09:07 – 09:07」那种同刻区间。没有任何带时刻的消息 → ""（不占位）。 */
function agentRoundSpanText(st) {
  const r = agentRoundRange(st);
  if (!(r.from > 0)) return "";
  const withDay = new Date(r.from).toDateString() !== new Date(r.to).toDateString();
  const a = agentRoundTimeOf(r.from, withDay);
  if (!(r.to > r.from)) return a;
  return a + " – " + agentRoundTimeOf(r.to, withDay);
}
/* 标签文案 = 区间本身（只有时间，没有轮号）；没有任何带时刻的消息 → ""（整行不占位） */
function agentRoundLabel(st) {
  return agentRoundSpanText(st);
}
/* 把时间区间落到会话区左上角（#agentRound：<b>起点</b><i>– 终点</i>）：
   还没有任何带时刻的消息（空会话 / 从未开跑过一轮）→ 整行 hidden 不占位。 */
function agentRoundLabelApply(st) {
  let el = null;
  try {
    el = document.getElementById("agentRound");
  } catch (_) {}
  if (!el) return;
  const r = agentRoundRange(st);
  if (!(r.from > 0)) {
    el.hidden = true;
    return;
  }
  const withDay = new Date(r.from).toDateString() !== new Date(r.to).toDateString();
  const b = el.querySelector("b");
  const i = el.querySelector("i");
  if (b) b.textContent = agentRoundTimeOf(r.from, withDay);
  if (i) i.textContent = r.to > r.from ? "– " + agentRoundTimeOf(r.to, withDay) : "";
  const span = agentRoundSpanText(st);
  el.title = span ? I18n.t("本会话时间区间：{range}", { range: span }) : "";
  el.hidden = false;
}
/* 新一轮开跑时的统一入口：清掉两块卡里**已了结**的那一份。
 * 返回 { cleared, plan, todos }：cleared = 这次真的清了东西（调用方据此决定要不要落盘）。
 * 轮号不在这里维护（见上面：一律由 agentRoundOfRun 从消息历史推），标签在清理落地后
 * 就地刷新一次。 */
function agentRoundMarkNew(st) {
  const out = { cleared: false, plan: false, todos: false };
  if (!st) return out;
  /* 计划正在跑 / 会话暂停：不属于「跑完一轮再开新一轮」的现场 → 跳过（不清、标签不刷新） */
  if (st._planExec || st.paused) return out;
  out.plan = agentRoundClearPlan(st);
  out.todos = agentRoundClearTodos(st);
  out.cleared = !!(out.plan || out.todos);
  /* 标签无论清没清到东西都要刷一次：轮号是「用户第几次发送」，这一轮刚发的消息
     已经入历史 → 标签自然走到「第 N 轮 · 本轮时刻」。只在 cleared 时刷的话，
     第 2 轮没东西可清就会一直停在「第 1 轮」—— 那正是要修的误会本身。 */
  agentRoundLabelApply(st);
  return out;
}

/* 解析 todo_write 的入参（可能是对象，也可能是 JSON 字符串） */
function agentTodoArgs(args) {
  if (!args) return null;
  if (typeof args === "object") return args;
  const s = String(args).trim();
  if (!s || s.charAt(0) !== "{") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function agentTodoStatus(s) {
  const v = String(s || "").toLowerCase();
  if (v === "completed" || v === "done" || v === "success") return "done";
  if (v === "in_progress" || v === "active" || v === "doing") return "active";
  if (v === "failed" || v === "error") return "failed";
  if (v === "unknown") return "unknown";
  return "pending";
}
/* 收到一次 todo_write → 覆盖会话清单；手动删除过的条目不再复活 */
function agentTodoText(x) {
  return String(
    (x && (x.content || x.title || x.text || x.name || x.label)) || "",
  ).trim();
}
/* 「清单未收口」自动补轮的记账（见 app-longrun.js 的 todosUnknownSet / TODO_SYNC_MAX）：
   _todoSyncUnknownSet = 上一轮补轮时那批未确认条目的内容；_todoSyncTries = 同一批补了几轮。
   模型这一轮又写了 todo_write 就把这份记账**整个清掉** —— 它已经回应过那批问号了：
     · 写清状态的条目不再是 unknown，问号自然消失；
     · 顺手把清单换了一批新条目（新条目本来没执行过，出问号是正常的）→ 旧记账必须作废，
       否则新条目的问号会被误判成「模型没回应」，自动续跑当场停住（旧记账的误伤）。
   清记账不影响配额：新一批问号从 0 开始重新计数，与「同一批最多补 TODO_SYNC_MAX 轮」同口径。 */
function agentTodoSyncAck(st) {
  if (!st) return;
  st._todoSyncPending = false;
  st._todoSyncTries = 0;
  delete st._todoSyncUnknownSet;
}
function agentApplyTodoWrite(st, args) {
  const p = agentTodoArgs(args);
  const list = p && Array.isArray(p.todos) ? p.todos : null;
  if (!list) return false;
  agentTodoSyncAck(st);
  const hidden = new Set((st.todoHidden || []).map(String));
  st.todos = list
    .filter((x) => agentTodoText(x))
    .map((x) => {
      const content = agentTodoText(x);
      return { content, status: agentTodoStatus(x.status), at: Date.now() };
    })
    .filter((x) => !hidden.has(x.content));
  st.todosAt = Date.now();
  persistAgentSession().catch(() => {});
  if (agentViewIs(st)) renderAgentTodoPanel(st);
  return true;
}
/* 一轮结束给「没跑完」的条目定性：
   出错 / 被终止 → 正在做的记红叉；其余会话已结束但结果不确定 → 问号。
   done / failed / unknown 是终态，只有 agent 再次 todo_write 才会改写。 */
function agentFinalizeTodos(st, outcome) {
  const list = st && Array.isArray(st.todos) ? st.todos : null;
  if (!list || !list.length) return;
  const bad = outcome === "error" || outcome === "cancelled";
  let changed = false;
  for (const t of list) {
    if (t.status !== "active" && t.status !== "pending") continue;
    if (bad && t.status === "active") t.status = "failed";
    else t.status = "unknown";
    changed = true;
  }
  if (!changed) return;
  persistAgentSession().catch(() => {});
  if (agentViewIs(st)) renderAgentTodoPanel(st);
}
async function agentTodoRemove(st, content) {
  if (!st || !Array.isArray(st.todos)) return;
  st.todos = st.todos.filter((t) => t.content !== content);
  st.todoHidden = st.todoHidden || [];
  if (!st.todoHidden.includes(content)) st.todoHidden.push(content);
  await persistAgentSession();
  renderAgentTodoPanel(st);
}
async function agentTodoClear(st) {
  if (!st) return;
  for (const t of st.todos || []) {
    st.todoHidden = st.todoHidden || [];
    if (!st.todoHidden.includes(t.content)) st.todoHidden.push(t.content);
  }
  st.todos = [];
  await persistAgentSession();
  renderAgentTodoPanel(st);
}
const TODO_ICON = { done: "✓", active: "◐", pending: "○", failed: "✕", unknown: "?" };
const TODO_LABEL = {
  done: "已完成",
  active: "进行中",
  pending: "待办",
  failed: "失败",
  unknown: "未确认",
};
/* 状态标记（本次需求 · 对齐上游 conversation 的 Todo dock「idle / ongoing / done markers」）：
   上游（dsh-client-ui-primitives 0.2.0-rc.2 的 StateDot）清单行用 appearance="dot" ——
   待处理空心圆、进行中旋转 loader（唯一非圆点的一档）、已完成实心圆点；
   带勾的 IconCheck 只出现在 appearance="step"（计划步骤）那一档。
   本仓的 failed / unknown 两态保留自己的语义色，形状沿用同一套。
   标记本身是纯 CSS 形状（.at-dot），文字标签只在 title 里给读屏与 hover。 */
const TODO_MARK_CLASS = {
  done: "done",
  active: "active",
  pending: "pending",
  failed: "failed",
  unknown: "unknown",
};
/* 会话底部的任务清单卡：可折叠、可逐条删除、可清除 */
function renderAgentTodoPanel(st) {
  const el = document.getElementById("agentTodo");
  if (!el) return;
  const list = (st && Array.isArray(st.todos) ? st.todos : []) || [];
  if (!list.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const done = list.filter((t) => t.status === "done").length;
  const failed = list.filter((t) => t.status === "failed").length;
  el.hidden = false;
  el.innerHTML = "";
  el.classList.toggle("collapsed", !!st.todosCollapsed);
  const head = document.createElement("div");
  head.className = "at-head";
  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "at-fold";
  fold.textContent = st.todosCollapsed ? "▸" : "▾";
  fold.title = I18n.t("展开 / 收起任务清单");
  fold.onclick = () => {
    st.todosCollapsed = !st.todosCollapsed;
    persistAgentSession().catch(() => {});
    renderAgentTodoPanel(st);
  };
  head.appendChild(fold);
  const title = document.createElement("b");
  title.className = "at-title";
  title.textContent = I18n.t("任务清单");
  head.appendChild(title);
  const count = document.createElement("span");
  count.className = "at-count" + (failed ? " has-fail" : "");
  count.textContent =
    done + " / " + list.length + (failed ? " · " + failed + I18n.t(" 失败") : "");
  count.title = I18n.t("完成 / 总数");
  head.appendChild(count);
  const bar = document.createElement("i");
  bar.className = "at-bar";
  const fill = document.createElement("u");
  fill.style.width = list.length ? Math.round((done / list.length) * 100) + "%" : "0%";
  bar.appendChild(fill);
  head.appendChild(bar);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "at-clear mini";
  clear.textContent = I18n.t("清除");
  clear.title = I18n.t("关闭并清除本清单（手动删除的条目不会再出现）");
  clear.onclick = () => agentTodoClear(st);
  head.appendChild(clear);
  el.appendChild(head);
  if (st.todosCollapsed) return;
  const ul = document.createElement("div");
  ul.className = "at-list";
  for (const t of list) {
    const row = document.createElement("div");
    row.className = "at-item st-" + (t.status || "pending");
    const ic = document.createElement("span");
    /* 形状由 CSS 画（见 dsh.css 的 .at-icon.at-dot）；这一格只留无障碍文本。
       **不叠 .at-icon** —— 那个类的 font-size:12px 与标记的 font-size:0 同特异度、
       又写在文件后面，会把字形重新放出来（绿点里再叠一枚 ✓，勾还不居中），
       看着就像标记左侧多出一个绿色块。 */
    ic.className = "at-dot m-" + (TODO_MARK_CLASS[t.status] || "pending");
    ic.textContent = TODO_ICON[t.status] || TODO_ICON.pending;
    ic.setAttribute("aria-label", I18n.t(TODO_LABEL[t.status] || TODO_LABEL.pending));
    ic.title = I18n.t(TODO_LABEL[t.status] || TODO_LABEL.pending);
    const txt = document.createElement("span");
    txt.className = "at-text";
    txt.textContent = t.content;
    txt.title = t.content;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "at-del";
    del.textContent = "✕";
    del.title = I18n.t("从清单移除");
    del.onclick = () => agentTodoRemove(st, t.content);
    row.appendChild(ic);
    row.appendChild(txt);
    row.appendChild(del);
    ul.appendChild(row);
  }
  el.appendChild(ul);
}

async function agentSessionSend(text, opts) {
  opts = opts || {};
  /* 计划执行器的单轮任务消息：不注入「任务流程」指令、不入「最近一次要求」 */
  const planExecMsg = !!opts._planExec;
  /* 漏弹自愈轮（app-plan.js planFixDirective）：它自己绝不再触发自愈，防连环重发 */
  const planFixMsg = !!opts._planFix;
  /* 清单同步轮（app-longrun.js 的 todoSyncDirective）：它只让模型把 todo_write 写对，
     所以这一轮同样不注入「任务流程」指令（否则模型会以为该重新交一份计划块）。 */
  const todoSyncMsg = !!opts._todoSync;
  /* 归属会话：opts.sessionId 有值时严格按 id 取 owner。
     取不到 → 直接结束本轮并提示，**绝不回退到当前活动会话**
     （用户切会话后计划续跑挤进别的会话，就是「计划串台」的直接原因）。
     这样一来 runKey:"agent:"+st.id、发送队列、工作区、服务商 / 模型全部落在 owner 上。 */
  let st;
  if (String(opts.sessionId || "").trim()) {
    st = agentSessionById(opts.sessionId);
    if (!st) {
      try {
        toast(I18n.t("所属会话已不存在，计划已停止"), "warn");
      } catch (_) {}
      return null;
    }
  } else {
    st = agentSessionState();
  }
  /* 用户亲口发的一轮 = 新任务：把上一条任务留下的「自动续跑」记账清干净 ——
     清单同步的按批配额（_todoSyncTries / _todoSyncUnknownSet）与跨批总闸（_todoSyncRounds）
     都只在一次任务内有效，跨任务累计会把新任务的第一次同步轮直接掐掉
     （用户会看到「已补 N 轮」而这一轮其实一轮都没补过）。
     判据与 app-longrun.js 同源：自动续跑轮带 _autoContinue（含 _todoSync），其余都是用户轮。 */
  if (!opts._autoContinue) {
    st._todoSyncTries = 0;
    st._todoSyncRounds = 0;
    st._todoSyncPending = false;
    delete st._todoSyncUnknownSet;
  }
  /* 暂停后点「继续」= 断点续跑轮：opts.resumeSession 点名被暂停那条 dsh 会话。
     与 dshRunTask 内部的重发续跑同口径 —— 那份 session 里上下文 / 人设 / 工具状态都在，
     本轮只发「从中断处接着写」这一句，绝不把整段历史再抄一遍（抄一遍等于让模型从头重写）。 */
  const resumeRound = !!String(opts.resumeSession || "").trim();
  /* 开发 / 细化绑定会话：任务书整份在会话契约 _devContract（发送时注入系统提示），
     首条 _src:"dev-node" 消息只有用户关键输入（本次开发需求 / 细化范围）；
     这里只读它作为最新用户消息，不再追加第二条 */
  const devContractMsg = !!opts._devContract;
  let t = String(text || "").trim();
  if (devContractMsg && !t) {
    /* 「按契约跑这条会话里的那条关键输入」（agentContractRound 空文本起轮）：只有
       这种情况才回落首条 _src:"dev-node" 消息。**非空文本 = 用户追问，必须原样发出去** ——
       改动前这里无条件用首条 kick 覆盖 t，追问轮实际发给模型的永远是第一轮的开发需求，
       用户补充的说明与拷问轮里手打的追问都发不出去（「回答未进上下文」的另一条路径）。 */
    const first = (st.messages || []).find(
      (m) => m && m.role === "user" && m._src === "dev-node" && String(m.content || "").trim(),
    );
    if (!first) return;
    t = String(first.content || "").trim();
  } else if (!t) {
    return;
  }
  /* 会话正忙：新消息进「发送队列」，不打断当前任务（旧行为是直接丢弃 / 取消本轮）。
     队列在当前这一轮结束后按序自动发送；用户可随时删除单条或清空。 */
  if (sessionIsRunning(st)) {
    await agentEnqueueMessage(st, t, opts);
    return;
  }
  /* 中文输入法行首顿号视为斜杠命令前缀 */
  if (t.charAt(0) === "\u3001") t = "/" + t.slice(1);
  /* 本轮要不要带画布工具：本次需求起**自动判定**（输入区那枚「与画布无关」chip 已移除），
     判据 = agentCanvasTurnRelated（这轮用户消息 + 最近几轮用户消息），拿不准按「有关」。
     · 开发 / 细化绑定会话（st.noCanvasRead）与契约会话自带一套无画布人设，它们走
       canvasPersona 的 "noRead" 分支，与这一档互不干扰；
     · st.canvasFree 这一位只留给**特殊入口的显式声明**（如插件修复会话 app-repair.js
       建会话时置 true，它就是与画布无关）；用户侧已经没有任何按钮能置它了。
       判据与下发点同源：人设档位 canvasPersona、下发网关的 noCanvas 标记、技能索引
       档位三处都读这一个值。 */
  const turnCanvasFree =
    !!st.canvasFree ||
    (!devContractMsg &&
      !st.noCanvasRead &&
      !agentCanvasTurnRelated(t, agentSessionUserHistory(st, null)));
  let skillWrap = null;
  /* 斜杠命令(参考 dsh commands 注册表:UI 侧直接处理,不发给模型)
     菜单仅展示 compact/plan 与技能；其余命令仍可手敲 */
  if (t.startsWith("/")) {
    const sp = t.split(/\s+/);
    const cmd = sp[0];
    const arg = sp.slice(1).join(" ").trim();
    if (cmd === "/new") {
      newAgentSession();
      await persistAgentSession();
      renderAgentSession();
      toast(I18n.t("已新建会话"), "ok");
    } else if (cmd === "/compact") {
      await agentCompact();
    } else if (cmd === "/plan") {
      await setPlanMode(st, !st.planNext);
    } else if (cmd === "/rename") {
      if (!arg) {
        toast(I18n.t("用法:/rename 新标题"), "warn");
        return;
      }
      st.title = arg.slice(0, 40);
      /* 与侧栏改名同一位锁：/rename 也是用户亲口命名，自动命名此后一律让位 */
      st.titleLocked = true;
      st.titleAuto = false;
      /* 标题映射:会话名称 → 关联智能任务 / 开发节点标题 */
      if (S.wf) {
        const devTitle = st.title.replace(/^(开发|Dev)\s*·\s*/i, "").trim();
        for (const n of S.wf.nodes) {
          if (n.kind === "agent_task" && n.agentSessionId === st.id)
            n.title = st.title;
          else if (
            n.kind === "super" &&
            n.dev &&
            n.agentSessionId === st.id &&
            devTitle
          )
            n.title = devTitle;
        }
        scheduleSave(true);
        renderCanvas();
      }
      await persistAgentSession();
      renderAgentSession();
      renderAgentSessionSidebar();
      toast(I18n.t("会话已重命名:") + st.title, "ok");
    } else if (cmd === "/export") {
      const txt = (st.messages || [])
        .map((m) => (m.role === "user" ? I18n.t("【用户】") : I18n.t("【助手】")) + (m.content || ""))
        .join("\n\n");
      const r = await window.api.saveTextFile({
        name: (st.title || I18n.t("会话")) + ".txt",
        content: txt,
      });
      if (!r || r.ok === false)
        toast(I18n.t("导出失败:") + ((r && r.error) || I18n.t("未知错误")), "err");
    } else if (cmd === "/permissions") {
      const cur = (S.config.dsh && S.config.dsh.permissionPreset) || "mtnode-unattended";
      toast(
        I18n.t("当前权限预设:") +
          cur +
          I18n.t("。可选:mtnode-unattended(无人值守:工作区读写,沙箱拒绝时询问) / workspace-write(读写·逐项审批) / read-only(只读·逐项审批) / danger-full-access(完全放行,不询问)。在 设置 → 智能能力 中切换。"),
        "ok",
      );
    } else if (cmd === "/help") {
      toast(
        I18n.t("输入 / 或 、 呼出技能；会话内还可 /compact 压缩上文、/plan 规划模式。"),
        "ok",
      );
    } else {
      const skillWrapHit = await resolveSkillSlash(t);
      if (skillWrapHit) {
        skillWrap = skillWrapHit;
      } else {
        toast(I18n.t("未知命令:") + cmd + I18n.t("。输入 / 或 、 呼出技能列表"), "warn");
        return;
      }
    }
    if (!skillWrap) return;
  }
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  /* 用户亲口发的一轮 = 新任务：先把上一份计划的执行游标摘掉（计划数据仍留在面板上，
     要接着跑必须由用户点「▶ 继续执行」）。并行任务在跑时 st.running 为 false，
     所以这里也兜住它：并行结果回来后发现游标没了，只了结状态、不再续跑。 */
  if (!opts._planExec) {
    try {
      delete st._planExec;
    } catch (_) {}
    /* 排队中还没弹出来的计划确认框：用户已经改口了 → 直接作废，不再弹给他 */
    try {
      if (typeof planStalePendingOffers === "function")
        planStalePendingOffers(st, "userRound");
    } catch (_) {}
  }
  /* 合并模式不追加消息：任务书消息（_src:"dev-node"）已在会话里，直接发它 */
  if (!devContractMsg) {
    const um = { role: "user", content: t, at: Date.now() };
    if (planExecMsg) um._src = "plan-exec";
    else if (opts._planFix) um._src = "plan-fix";
    st.messages.push(um);
    if (st.messages.filter((m) => m.role === "user").length === 1) {
      /* 回落命名（首条消息前 24 字）同样不得覆盖用户亲口改的名 */
      if (!st.titleLocked)
        st.title = t.slice(0, 24) + (t.length > 24 ? "…" : "");
    }
  } else {
    /* 开发 / 细化绑定会话：合并模式，不追加消息，只按主题改名。 */
    /* 绑定会话同样要随主题改名：引擎那条 LLM 主题因首条用户消息超 maxInputBytes
       到不了（见 retitleBoundSessionByTopic 注释），所以这里按关键输入自己补一个 ——
       只换「开发 · 」后面的模块名，前缀一个字符不动；用户手改过（titleLocked）或
       引擎已定名（titleAuto）的会话不碰。 */
    retitleBoundSessionByTopic(st);
  }
  /* 引擎自动命名（title 事件）是「一次性武装」闸位：只要这条会话还没被引擎真正
     命名过一次（!titleAuto）且用户没亲口改名（!titleLocked），就保持放行 ——
     不再像以前那样每次发送按用户消息数 ≤1 重置、只认本轮窗口。这样 round-1
     迟到的 title（含刚过 done、下一轮发送前到达的）以及后续轮才到的首个主题
     都能落地；真正应用过一次（titleAuto=true）或用户手改后，此位才让位。 */
  st._autoTitleRound = !st.titleAuto && !st.titleLocked;
  st.updatedAt = Date.now();
  /* 开轮裁切（本次需求 · 口径改成「按轮保留」）：这里原来是 `length > 100 → splice`
     一刀切。两个毛病：① 100 条在一轮 8～15 条消息的开发 / 细化会话里就是 7 轮上下，
     最早的**助手消息**被整条挤掉 —— 轨迹与改动两栏的数据源正是它（用户报的「只剩
     最后一轮」）；② 这一刀切在**本轮用户消息刚 push、助手的还没写**的位置，
     除非溢出量超过 AGENT_ROUND_MAX_ENTRIES，否则它会从中间切开上一轮。
     现在只把「总条数超上限且溢出量已跨过一整轮」的那一段切掉（agentTrimSessionMessages
     同源口径），否则留给落盘前与下一轮收尾去裁。 */
  if (st.messages.length - AGENT_MSG_KEEP_MAX >= AGENT_ROUND_MAX_ENTRIES)
    agentTrimSessionMessages(st);
  /* 新的一轮开始：显示窗口回到默认最近 200 条，更早的可从最前端重新「显示更早内容」 */
  st._visItems = undefined;
  st.running = true;
  /* 新一轮开跑 = 上一轮的暂停态作废（不管是点「继续」起的这一轮，还是用户直接发新话）。
     _liveSid 每轮重新捕获：插话 / 暂停都按它点名网关在途表里的那一轮。 */
  st.paused = false;
  st._pausePending = false;
  st._roundPaused = false;
  st._liveSid = "";
  st._pending = "";
  st._liveTools = [];
  /* 会话开始：开发节点「绑定会话运行中」即时反映到左下角运行队列 */
  updateRunQueuePanel();
  /* 新一轮（本次需求）：到这里这一轮是真开跑了（上面的「会话忙」闸已经放行、
     消息已入消息流），先把上一轮**已了结**的「计划」与「任务清单」整份清掉、
     再把顶部轮次标签刷到本轮（轮号由 agentRoundOfRun 从消息历史推，与本轮轨迹同源）
     —— 上一轮还有没跑完的项则整份保留（面板头部会标「上一轮遗留」）。
     计划执行轮 / 清单同步轮 / 漏弹纠错轮 / 恢复轮都不算用户开的新一轮，一律不清；
     计划正在跑或会话暂停时 agentRoundMarkNew 自己也会跳过。 */
  try {
    if (
      !planExecMsg &&
      !planFixMsg &&
      !todoSyncMsg &&
      !resumeRound &&
      !opts._autoContinue
    ) {
      if (typeof agentRoundMarkNew === "function") {
        const rr = agentRoundMarkNew(st);
        if (rr && rr.cleared) st._planDrops = 0;
      }
    }
  } catch (_) {}
  /* 任务清单：上一轮已了结的那一份由上面的新一轮清理拿掉；还有没跑完的（或本会话
     从未开跑过一轮）则原样留着，由下一次 todo_write 覆盖，或用户在面板上手动清除 */
  if (!Array.isArray(st.todos)) st.todos = [];
  st.metrics = null;
  st._usageLive = null;
  st._planDelivered = false;
  st._roundOutcome = "ok";
  /* 计划漏弹自愈的现场：
     · 用户亲口发起的轮次 → 配额清零（一个用户轮最多自愈 PLAN_FIX_MAX_ROUNDS 次）；
     · 自愈轮自己 → 只继承计数，绝不重置（否则永远有额度，会来回拉扯）；
     · 每一轮开跑前都把「待纠错」位清掉，避免上一轮的残留把这一轮也拖去重发。 */
  if (!planFixMsg) st._planFixRounds = 0;
  st._planFixAsk = false;
  beginSaveNodeHold();
  if (!S.thinking) S.thinking = {};
  S.thinking["agent:" + st.id] = [""];
  await persistAgentSession();
  if (agentViewIs(st)) renderAgentSession({ forceStick: true });
  else renderAgentSessionSidebar();
  /* 历史存档里曾被回滚的轮次消息不进上下文（activeSessionMessages 无标记时直接复用
     原数组，不复制）。
     构造口径收进 app-db.js 的 agentHistoryEntries：同文去重、回答气泡按题 id 取最新、
     整段设字符上限 —— 询问窗答案因此能随每一轮的 hist 一起进上下文（它只是一条
     普通用户消息，见 ixCommitAnswerToSession）。 */
  const rbHistSrc = activeSessionMessages(st.messages);
  const hist = agentHistoryEntries({ messages: rbHistSrc }, { maxChars: 4000 })
    .map((r) => (r.role === "user" ? I18n.t("用户：") : I18n.t("助手：")) + r.text)
    .join("\n\n");
  /* 「任务流程」指令：会话里已有未跑完的计划时注入的是「沿用 / 续跑」那段，
     而不是逼模型再规划一份新的（新旧计划互相覆盖 · 已执行项被重跑） */
  let flowText = "";
  try {
    if (resumeRound || todoSyncMsg) flowText = "";
    else if (typeof planFlowInjectText === "function")
      flowText = String(planFlowInjectText(st, opts, planExecMsg) || "");
    else if (
      typeof planFlowInjectNeeded === "function" &&
      planFlowInjectNeeded(st, opts, planExecMsg) &&
      typeof planFlowDirective === "function"
    )
      flowText = planFlowDirective();
  } catch (_) {}
  /* 本轮是否真的被要求「按契约输出计划块」——只有这种轮次才做漏弹检测：
     Skill 轮（flowText 被 skillTaskPrompt 取代）、计划执行轮、沿用现有计划轮
     （那段指令明令禁止再出计划标记）、以及自愈轮自己，一律不检测。 */
  const planAskedNew =
    !skillWrap &&
    !planExecMsg &&
    !planFixMsg &&
    !!flowText &&
    (typeof planFlowAsksForNewPlan !== "function" ||
      planFlowAsksForNewPlan(flowText));
  const latest = skillWrap
    ? skillTaskPrompt(skillWrap)
    : flowText
      ? flowText + "\n" + t
      : t;
  let input =
    resumeRound || !hist ? latest : hist + "\n\n用户(最新)：" + latest;
  /* 续跑轮（暂停后点「继续」/ 出错自动重发点名那条 dsh 会话）：正常能续上时上下文
     就在那份 session 里，一个字都不必重发。但「拿不到那条会话 / 宿主登记里没有它」
     时续跑会在运行时撞 RESUME_UNAVAILABLE，宿主随即退化成「用原始 input 整轮重发」——
     那一轮的 input 若只有一句「从中断处接着写」，用户此前确认过的全部问答就凭空没了
     （正是「中断 / 停止后再次要求继续任务，看不到之前的回答」的现场）。
     所以判据不足时把它拼在指令后面：真续上了只是一点冗余，续不上则上下文不丢。 */
  const sidForRound = String(opts.resumeSession || "").trim();
  const sidKnown =
    !!sidForRound &&
    (typeof dshResumableSession === "function" ? !!dshResumableSession("agent:" + st.id) : false);
  if (resumeRound && !sidKnown) {
    const known = agentConfirmedHistoryEntries(st);
    if (known.length)
      input +=
        "\n\n" +
        I18n.t("【用户已确认的部分（续跑兜底 · 这些答案已生效，不要重复提问）】") +
        "\n" +
        known.map((r) => "· " + r.text).join("\n");
  }
  /* 规划模式：本轮只出计划，不做任何改动（系统提示 + 用户指令双重约束，
     画布 / 应用改动另由宿主在 handleCanvasEvent 中硬性拒绝） */
  const planMode = !!st.planNext;
  if (planMode) input = PLAN_MODE_USER_DIRECTIVE + input;
  /* 纯净模式：移除 system prompt，模型输入 = 纯粹的用户输入（避免 MTNode
     system prompt 的 token 开销）。systemPrompt 置空 + pure 标记下发网关：
     网关强制空预设文本，引擎侧 pure-prompt 插件按 MTNODE_PURE 移除人设段。
     开发任务书契约同样不再注入（纯净模式由用户显式开启，接受该取舍）。 */
  const pureMode = !!st.pure;
  /* 人设的画布档位（与工具注册同一判据，真源见 app-db.js dshRunOnce）：
     · ""       全量 —— get / edit / app 三件套都在，照旧要求先读图再动手
     · "noRead" 开发绑定会话（st.noCanvasRead · Gate A）—— 本轮不注册 mtnode_canvas_get
                与 mtnode_app；人设要求不读也不改画布，收尾不写回任何节点字段
                （mtnode_canvas_edit 照常注册但不用于回写）
     · "none"   本轮被自动判定「与画布无关」（turnCanvasFree · Gate B）—— 三件套全不注册
   裁掉工具就必须同时裁掉「动手前先 mtnode_canvas_get 看清现状」这句指令和画布类技能名
   （同档位的技能索引也已经裁了），否则模型会去调不存在的工具、白白浪费一整步。 */
  const canvasPersona = pureMode
    ? ""
    : turnCanvasFree
      ? "none"
      : st.noCanvasRead
        ? "noRead"
        : "";
  const assistAutoApprove = !!(S.config && S.config.dsh && S.config.dsh.assistAutoApprove);
  let systemPrompt = "";
  if (!pureMode) {
    if (canvasPersona === "none") {
      systemPrompt =
        "你是 MTNode 里的通用会话助手。宿主按你这条消息判定**本轮与画布无关**，于是本轮不注册任何画布与应用工具（mtnode_canvas_get / mtnode_canvas_edit / mtnode_app 都不可用），你只读写文件、联网、执行命令。\n" +
        "本轮不要承诺任何画布改动，也不要臆造节点或画布现状。若这条任务其实需要动画布：**先别硬做** —— 一句话说明「这轮按无关档跑、画布工具没在」，请用户在同一句里补上画布 / 节点（例如「改画布上的『文本节点 2』」）再发一次；下一轮判据命中就会带上画布工具。\n" +
        "内置技能以文末索引为准（本档位不含画布类技能）；工具回执里没有的结果不要声称已完成。\n" +
        "回答简洁（交流语言见文末「语言口味」）。";
    } else if (canvasPersona === "noRead") {
      systemPrompt =
        "你是 MTNode 画布上绑定的开发会话助手，但本会话不读取也不修改画布。可读写文件、联网、执行命令；本轮不注册 mtnode_canvas_get 与 mtnode_app。\n" +
        "画布现状一律以【开发任务书】为准；本会话执行期间与收尾都不得改动画布上任何内容 —— 不改任何节点的 title / note / devStatus / devFiles，也不动连线或排版。\n" +
        "本会话服务的是左侧栏中属于它的那条会话：任务完成时该会话标题会随首轮主题在左侧栏自动更新（由应用处理，你无需也无权去改画布）。\n" +
        "内置技能以文末索引为准（本档位不含画布类技能）；工具回执里没有的结果不要声称已完成。\n" +
        "回答简洁（交流语言见文末「语言口味」），不要编造不存在的节点或画布。";
    } else {
      systemPrompt =
        "你是 MTNode 画布上的智能会话助手。可读写文件、联网、执行命令；也可用 mtnode_canvas_get / mtnode_canvas_edit / mtnode_app 查看并修改本会话所属的画布（节点、连线、排版等）。\n" +
        "你只能访问本会话所属的那张画布：list_workflows / canvas_get 不会返回其他画布内容。\n" +
        "该画布在会话建立时就已绑定：用户在你运行中途切去其他画布干活，你本轮的读写仍然精准落在自己那张图上，不会串到他正看着的那张。\n" +
        (assistAutoApprove
          ? "当前「助手改画布」为批准：mtnode_canvas_edit 直接生效。危险操作 delete_workflow / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin 仍会弹窗确认。\n"
          : "mtnode_canvas_edit 与危险操作 delete_workflow / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin 会弹窗请用户确认：必须等待确认结果，勿臆造成功。若用户拒绝画布修改，本次任务会立即停止，不要再继续改画布。\n") +
        "DSH 插件可经 mtnode_app 的 list_dsh_plugins / install_dsh_plugin 等管理（装在配置目录，升级保留）。\n" +
        "任务相关性纪律：本轮先自己判断任务是否与画布有关 —— 无关就别读画布（不要调 mtnode_canvas_get，也不要取画布内容 / 快照），用文件读写、联网、命令把活做完；有关再按下面纪律先读现状；判不准按「有关」处理。\n" +
        "改画布纪律：动手前先 mtnode_canvas_get 看清现状；节点字段、端子与 alias 的口径以 mtnode_canvas_edit / canvas_get 的工具说明为唯一真源，跨超级节点接线用 superConnect。\n" +
        "引用画布内容纪律：为某个节点写 prompt/task 而要用画布上别的节点的内容时，一律在 prompt/task 里写 @标题（连线源；全局广播须同时满足三条件），不要把那个节点的正文复制粘贴进去；素材节点本身不是 @ 候选，写 @内容条目标题只引那一条、且只有已连线接进本节点的端子可引；@引用的三条件与语法见技能 mtnode-canvas-edit-rules。\n" +
        "要建开发节点、批次 / 文生图链、连线 / 建图、整理排版、接数据库副本或索引 / 沉淀项目关键信息时，先用 skill 工具加载对应内置技能（mtnode-canvas-edit-rules / mtnode-dev-architect / mtnode-canvas-batch-safety / mtnode-canvas-layout-ux / mtnode-media-gen-nodes / mtnode-db-facts / mtnode-ai-facts）再动手；工具回执里没有的结果不要声称已完成。\n" +
        "回答简洁（交流语言见文末「语言口味」），不要编造不存在的节点或画布。";
    }
  }
  /* 自检与长时纪律（用户已确认：分阶段自检 + 交付前全检；发现错误先自行修复并重跑，
     修不好才告知；关键结论必须带证据；长任务不空转、跨重启的活建议提升为长周期任务图）。
     纯行为纪律，只写这一处（提示词单一真源：参数机制在工具描述、操作规范在技能，
     这里只留「把活做对」的纪律）。 */
  if (!pureMode) systemPrompt += SELF_CHECK_DISCIPLINE;
  /* 开发 / 细化绑定会话：任务书是会话契约，临时写入系统提示（不占用户消息位，
     会话里只显示用户填写的关键输入；后续追问也持续携带该契约） */
  const devContract = String(st._devContract || "").trim();
  if (devContract && !pureMode) {
    systemPrompt +=
      "\n\n【开发任务书 · 本会话模块契约（非用户消息，无需回复该段）】\n" +
      devContract +
      "\n【任务书结束】";
  }
  /* 「先拷问需求（grill-me）」（本次需求 · 会话窗口「模式」菜单新增的那一枚）：
     会话级开关缺省开（st.grill，没点过 = 开），按轮注入契约 —— 是否真拷问由模型
     自己判「这轮像不像需求」（判据写在契约里，与「本轮要不要开工」同一处判断）。
     四种轮次不带契约：纯净模式（整段 system 本就置空）、自动续跑轮（不该由模型自己
     追问自己）、断点续跑轮（那份 dsh 会话里 system 已落定，重发只会污染上下文）、
     开发 / 细化任务书会话（任务书自己那一段【拷问模式】才是它的契约，不叠第二份）。 */
  const grillTurn =
    !pureMode &&
    grillTurnOn(st, {
      autoContinue: !!opts._autoContinue,
      resumeRound,
      devContract: !!devContract,
    });
  if (grillTurn) systemPrompt += GRILL_CONTRACT;
  try {
    /* 本轮的图像附件（只发这一轮新增的图）：本轮正文里的内嵌图行 → 网关 attachImages
       → 用户消息的 image 内容块（模型这才真正「看见」那张图，而不是只读到一行路径）。
       续跑轮（暂停后点「继续」）不下发：那份会话里图已在上下文里，重发等于再计一次费。
       图行本身仍原样留在消息正文里，所以回看历史消息时缩略图照旧（见 dshMsgBlock）。 */
    const roundImages =
      resumeRound || typeof dshRunImages !== "function" ? [] : dshRunImages(t);
    const final = await dshRunTask(input, {
      runKey: "agent:" + st.id,
      /* 会话轮号（本次需求）：第 N 轮 = 该会话里用户第几次发送。同一次发送的全部段
         （思考 / 正文 / 工具 / 错误）都归这一轮；dshRunTask 把它落在本轮轨迹上，
         收尾时随段快照存档（见 app-db.js traceSegmentsOf）。 */
      round: agentRoundOfRun(st),
      images: roundImages.length ? roundImages : undefined,
      /* 暂停后「继续」：点名被暂停那条 dsh 会话走断点续跑通道（网关 session/resume）。
         拿不到 sid 时这里就是 undefined —— 与旧版一样整轮重发，行为不劣化。 */
      resumeSession: String(opts.resumeSession || "") || undefined,
      /* Token 台账逐轮明细的标题：调用方（如计划执行器）给的计划任务标题优先，
         缺省由 dshRunTask 用输入文本前 24 字回落 */
      tokTitle: opts.tokTitle || undefined,
      planMode,
      /* 生效工作区（st.workspace 手填优先 > 画布项目根 > 默认）：与展示层同源 */
      workspace: agentRunWorkspace(st),
      preset: st.preset || AGENT_PRESET_DEFAULT,
      provider: (opts.provider || st.provider || "deepseek-official"),
      model: (opts.model || st.model || undefined),
      effort: st.effort || "high",
      /* 续跑轮（暂停后点「继续」）不再重复注人设：那份 system 已经落在被暂停的
         dsh 会话里，再下发一遍只会污染上下文 —— 与 dshRunTask 内部断点续跑同一口径。 */
      systemPrompt: resumeRound ? "" : systemPrompt,
      pure: pureMode,
      /* Gate A：开发绑定会话不注册读画布工具（判据与落盘同源，见 createDevSessionForNode）。
         dshRunTask 的 baseOpts 原样透传到 dshRunOnce，这一位随每次开轮重新生效，
         轮内不变 → 同一档每步前缀一致。 */
      noCanvasRead: !!st.noCanvasRead,
      /* Gate B：本轮被自动判定「与画布无关」→ 走 MTNODE_NO_CANVAS 整档闸（canvas_get /
         edit / app 三件套整个不注册，约 26.0K 字符/步）。人设同步换成无画布版（见上方
         canvasPersona === "none" 分支），两侧判据同源于 turnCanvasFree（判据只算一次）。 */
      noCanvas: turnCanvasFree,
      onEvent: (type, data) => {
        /* 并行会话:仅当本会话正是当前查看的会话时才更新共享视图,避免后台会话
           重绘/滚动打扰用户正在看的其他会话 */
        const mine = agentViewIs(st);
        /* 出错自动重发（dshRunTask 触发 retry）：看 resumed 决定清不清残文 ——
           · resumed=true（续写）：已显示的部分正文 / 工具列表 / 用量保留（同一轮的内容）；
             **思考也保留** —— 这一轮已经思考过的内容随轨迹留在时间线上（续跑起步只把
             思考段切开收口，见 app-db.js traceSplitThink，一段都没删），清掉槽 = 把用户
             刚看过的思考从会话里抹掉（节点侧一直是保留的，两侧口径就此对齐）。
             新一轮的思考自会另起一段，不会与旧思考混成一段。
           · resumed=false（整轮重发）：正文 / 工具 / 用量 / 思考槽全清，从零流式不叠字
             （轨迹同时被 traceReset 清空，槽留着只会是残留旧内容）。
           resumed 由宿主按「这一次实际怎么发」给出（见 app-db.js notifyRetry）。 */
        if (type === "retry") {
          if (data && data.resumed) {
            if (mine) updateAgentLiveThink(st);
            return;
          }
          if (S.thinking) delete S.thinking["agent:" + st.id];
          st._pending = "";
          st._liveTools = [];
          st._usageLive = null;
          if (mine) {
            try {
              renderAgentSession();
            } catch (_) {}
          }
          return;
        }
        /* 引擎的会话短标题（dsh session-title / first-prompt 提供者）：本轮第一次执行任务
           时按内容主题更新左侧栏这条会话的名字。事件可能在开轮回落标题（首条消息前 24 字）
           之后才到，那时它覆盖回落 —— 闸位与手改锁定见 applyAutoSessionTitle。 */
        if (type === "title") {
          applyAutoSessionTitle(st, (data && data.title) || "", (data && data.source) || "");
          return;
        }
        if (type === "reasoning" && data.text) {
          pushThinking("agent:" + st.id, 0, data.text);
          /* 分段模式刷尾部思考段；非分段（节点绑定运行等）退回旧整段更新 */
          if (mine) updateAgentLiveThink(st);
        } else if (type === "tool-preparing" && data && data.callId) {
          /* 工具准备态（本次需求 · 对齐上游 preparing 阶段）：参数还在流进来时，
             先在 st._liveTools 里立一条只带字节数的记录 —— 会话流里那一行卡片随即出现，
             显示「正在准备内容 N KB」；真 tool 事件到达时就地补上 name / args（同 callId），
             卡片转入「运行中」扫光态。 */
          st._liveTools = st._liveTools || [];
          let pt = st._liveTools.find((x) => x.callId === data.callId);
          if (!pt) {
            pt = {
              callId: data.callId,
              turn: data.turn,
              step: data.step,
              name: data.name || "",
              args: "",
              result: null,
              error: null,
              at: Date.now(),
            };
            st._liveTools.push(pt);
          }
          pt.prep = { bytes: Number(data.bytes) || 0, name: String(data.name || "") };
          if (!pt.name && data.name) pt.name = String(data.name);
          if (mine) renderAgentSession();
        } else if (type === "tool" && data.name) {
          /* 工具调用只进 st._liveTools（与运行轨迹的 tool 段），不污染思考文本 */
          /* agent 自己建的任务清单：实时同步到会话底部的 Todo 面板 */
          if (/todo/i.test(String(data.name || "")))
            agentApplyTodoWrite(st, data.args);
          st._liveTools = st._liveTools || [];
          if (!st._liveTools.some((x) => x.callId === data.callId))
            st._liveTools.push({
              callId: data.callId,
              turn: data.turn,
              step: data.step,
              name: data.name,
              args: data.args || "",
              result: null,
              error: null,
              at: Date.now(),
            });
          else {
            /* 准备态立起来的那条：补上真实参数与名字，准备态记账就此作废（卡片转「运行中」） */
            const pt = st._liveTools.find((x) => x.callId === data.callId);
            if (pt) {
              pt.name = data.name || pt.name;
              pt.turn = data.turn;
              pt.step = data.step;
              pt.args = data.args || "";
              delete pt.prep;
            }
          }
          if (mine) renderAgentSession();
        } else if (type === "tool-result" && data.callId) {
          st._liveTools = st._liveTools || [];
          const t = st._liveTools.find((x) => x.callId === data.callId);
          if (t) {
            t.result = Array.isArray(data.content) ? data.content : [];
            t.error = data.error || null;
            /* 结果回来的时刻（本次需求 · 轨迹检查器按它算这一次调用的耗时）：
               工具记录自带 at（发起），补一个 doneAt 就成对。 */
            t.doneAt = Date.now();
            if (mine) renderAgentSession();
          }
        } else if (type === "usage" && data) {
          /* 运行中实时 token 消耗（与网关 stats 相同的累加口径），完成后以 metrics 为准 */
          const u = (st._usageLive = st._usageLive || {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
          });
          u.inputTokens += Number(data.inputTokens) || 0;
          u.outputTokens += Number(data.outputTokens) || 0;
          u.cacheReadTokens += Number(data.cacheReadTokens) || 0;
          u.reasoningTokens += Number(data.reasoningTokens) || 0;
          /* 轨迹视图的「每步 token」过去全靠这条内存时间线（renderer/app-trajectory.js
             的 noteUsage → st._tokUsageTimeline）：usage 事件自带 at 与模型归属，检查器
             按时刻就近归步 —— 猜不准的那几步就显示「未记到」（用户报的正是这个）。
             本次需求起：这条 usage 先交给**自带 (轮号, 步号) 的明细**（tokUsageStepNote，
             随助手消息落盘、渲染时按键取数）；没接手（拿不到会话轮号 = 非会话运行）才
             照旧进内存时间线。两种口径**互斥**，同一条 usage 绝不算两遍。 */
          try {
            if (typeof tokUsageStepNote !== "function" || !tokUsageStepNote(st, "agent:" + st.id, data)) {
              if (
                window.MTNodeTrajectory &&
                typeof window.MTNodeTrajectory.noteUsage === "function"
              )
                window.MTNodeTrajectory.noteUsage(st, data);
            }
          } catch (_) {}
          if (mine) renderSessionFooterStat();
        } else if (type === "say-end") {
          /* 正文块收尾（网关在块末发 say-end，见 dsh/DESIGN.md）：这一段已经定稿，
             不再是「流式尾段」。它恰好还是尾段时（= 最终答复那一块，后面没有工具 /
             思考段会顺手带来重绘）本会话又正看着，就地按段重绘一次 —— 最终答复立刻以
             markdown 呈现，而不是以未渲染原文的形态留在屏上等本轮 finally 那一帧。 */
          if (mine) {
            const items = agentChatSegItems(st) && agentTraceItems("agent:" + st.id);
            const last = items && items.length ? items[items.length - 1] : null;
            if (last && last.k === "say" && last.open === false) {
              try {
                renderAgentSession();
              } catch (_) {}
            }
          }
          return;
        } else if (type === "text" && data.text) {
          st._pending = (st._pending || "") + data.text;
          if (mine) {
            const el = document.getElementById("agent-stream");
            const items = agentChatSegItems(st);
            const seg = items
              ? agentLiveSegTail(items, el, "say")
              : null;
            if (seg) dshSegSetStreamText(el, String(seg.text || ""));
            else if (items || !el) {
              /* 分段模式（含尾段切换 / 首次成段）→ 整表重绘一次对齐 DOM；
                 items 刚消失（run 收尾竞态）且无流式元素时也要重绘回旧块 */
              try {
                renderAgentSession();
              } catch (_) {}
            } else dshSegSetStreamText(el, st._pending);
            scrollElToBottomIfStuck($("#agentList"));
          }
        } else if (type === "session-event" && data && data.type === "agent/inbox/spliced") {
          /* 插话的注入回执：运行时把这句话拼进收件箱时吐的一帧持久化事件（网关原样
             透传成 session-event）。它就到达在本轮的通道上，天然归属这一轮 ——
             按文本认回气泡，把「已插话 · 将在下一步生效」升级成「已注入」。 */
          agentMarkSteerInjected(st, data.data);
        } else if (type === "error" && data && data.message) {
          if (st._cancelled || isCancelishError(data.message)) return;
          const errLine = "\n⚠ " + data.message;
          st._pending = (st._pending || "") + errLine;
          if (mine) {
            const el = document.getElementById("agent-stream");
            if (agentChatSegItems(st)) {
              /* 错误已成 err 段：重绘让 ⚠ 段落在时间线正确位置 */
              try {
                renderAgentSession();
              } catch (_) {}
            } else if (el) dshSegSetStreamText(el, st._pending);
            scrollElToBottomIfStuck($("#agentList"));
          }
        }
      },
      onDone: (d) => {
        recordDshMetrics(null, d.metrics);
        st.metrics = d.metrics || null;
        st._usageLive = null;
        if (d && d.sessionId) st._liveSid = String(d.sessionId);
        /* 「⏸暂停」收尾：网关把这轮以 done{paused:true} 结束，并且**保证不发 error**
           （发了就会撞宿主既有的失败自动重发闸门 → 暂停一次反而多跑 5 轮）。
           这里只记一位，真正的 st.paused 由 finally 统一裁定。 */
        if (d && d.paused) st._roundPaused = true;
      },
    });
    if (st._cancelled) {
      st._roundOutcome = "cancelled";
      const body = stripStreamErrors(st._pending);
      /* 被终止同样把这一轮的思考 / 段快照 / 工具清单随消息归档（见 agentRoundMsgTail）：
         旧口径只写一行「（已终止）」，用户已经看到的思考块在收尾那一刻整段消失。 */
      st.messages.push(
        agentRoundMsgTail(
          st,
          {
            role: "assistant",
            content: body || I18n.t("（已终止）"),
            at: Date.now(),
          },
          "agent:" + st.id,
        ),
      );
    } else {
      /* 收尾消息：正文 = say 段按 \n\n 连接（err 段以「⚠ 」附尾，与流式口径一致），
         无段可拼时回退 final / 累加文本 /（无输出），保证不丢字；
         reasoning / segments / tools 走公共尾巴（agentRoundMsgTail） */
      const rk = "agent:" + st.id;
      const traceBody =
        typeof traceSayDisplay === "function"
          ? String(traceSayDisplay(rk, "") || "")
          : "";
      const msg = agentRoundMsgTail(
        st,
        {
          role: "assistant",
          content: traceBody || final || st._pending || I18n.t("（无输出）"),
          at: Date.now(),
        },
        rk,
      );
      st.messages.push(msg);
      /* 运行中展开的思考块，落到历史消息后要保持展开 —— 否则一轮结束就「自动藏起来」
         （live 与历史用不同的展开键，重绘即缩回）。 */
      try {
        agentCarryThinkOpenState(st, msg, rk);
      } catch (_) {}
      /* 复杂任务计划：agent 本轮输出计划标记 → 弹窗确认（音效 + 可编辑清单）；
         解析不出来但正文里有明显计划特征（标记写坏 / 漏闭合 / 裸 JSON）→
         记一次「漏弹」，本轮收尾时自动回发纠错指令让它重新生成（见下方 finally） */
      try {
        if (
          !planExecMsg &&
          !st._planExec &&
          typeof planMaybeOffer === "function"
        ) {
          const pm = planParseFromText(msg.content);
          if (pm) planMaybeOffer(st, pm);
          else {
            const miss =
              typeof planMissedDetection === "function"
                ? planMissedDetection(msg.content)
                : "";
            if (miss && planAskedNew) {
              st._planFixAsk = true;
            } else if (miss && planFixMsg) {
              /* 已经自动纠错过一次还是没弹对：不再追发，交给用户 */
              try {
                toast(
                  I18n.t("计划仍未正确生成：请重新发送你的要求，或手动整理任务清单"),
                  "warn",
                );
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
      /* 规划模式跑完：标记「计划待执行」，输入区浮现「▶ 执行计划」 */
      if (planMode) {
        st._planDelivered = true;
        if (agentViewIs(st))
          toast(I18n.t("计划已生成：点击「执行计划」开始实施"), "ok");
      }
    }
  } catch (e) {
    const errMsg = (e && e.message) || String(e);
    if (st._cancelled || isCancelishError(errMsg)) {
      st._roundOutcome = "cancelled";
      const body = stripStreamErrors(st._pending);
      /* 取消类错误收尾与「被终止」同口径：思考 / 段快照 / 工具清单照旧归档
         （见 agentRoundMsgTail —— 只写一行正文 = 把这一轮的思考内容丢掉）。 */
      st.messages.push(
        agentRoundMsgTail(
          st,
          {
            role: "assistant",
            content: body || I18n.t("（已终止）"),
            at: Date.now(),
          },
          "agent:" + st.id,
        ),
      );
    } else {
      st._roundOutcome = "error";
      /* 出错收尾同样带上思考尾巴：这一轮的思考不因收尾方式（正常 / 终止 / 出错）
         而消失（见 agentRoundMsgTail）。 */
      st.messages.push(
        agentRoundMsgTail(
          st,
          {
            role: "assistant",
            content: I18n.t("（错误：") + errMsg + "）",
            at: Date.now(),
          },
          "agent:" + st.id,
        ),
      );
      toast(I18n.t("智能会话失败：") + errMsg, "err");
    }
  } finally {
    /* 暂停态在这里一次定稿：只有真的收到 done{paused:true} 才算暂停（暂停请求发出去了
       但那一轮恰好正常跑完 = 不算）。■ 终止优先于暂停：用户按停之后又点了终止，
       就不该留下一条「可继续」的暂停态。已写出的正文在上面按现状归档，不重发、不抹字。 */
    st.paused = !!st._roundPaused && !st._cancelled;
    st._roundPaused = false;
    st._pausePending = false;
    st.running = false;
    st._cancelled = false;
    st._liveTools = [];
    /* 本轮收尾先把界面落定：st.running 一置 false，live 行就不再算「流式尾段」，
       这里立刻重绘一次 —— 最终答复（消息已在上面 push 好）马上按 markdown 落定，
       而不是以未渲染原文的形态留在屏上等 finally 末尾那一帧。旧口径里渲染是
       finally 的最后一句，前面 persist / 侧栏刷新任一步抛错就轮不到它，屏上就停在
       流式原文（用户报的「会话最终答复偶尔未正常渲染 md」）。 */
    try {
      if (agentViewIs(st)) renderAgentSession();
    } catch (_) {}
    /* 会话结束：开发节点从运行队列撤下 */
    updateRunQueuePanel();
    const outcome = st._roundOutcome || "ok";
    const hasQueued = Array.isArray(st.outbox) && st.outbox.length > 0;
    /* 计划执行被打断：终止 = 用户明确不要这份计划 → 就地永久清除
       （不留 pending 项、不留「▶ 继续执行」，重启后也不会再冒出来） */
    if (outcome === "cancelled") {
      if (st._planExec || st.plan) {
        try {
          if (typeof planDrop === "function") planDrop(st, "cancelled");
          else {
            delete st._planExec;
            st.plan = null;
          }
        } catch (_) {}
        if (agentViewIs(st)) {
          try {
            toast(I18n.t("已终止：本会话的计划清单已清除"), "warn");
          } catch (_) {}
        }
      }
    }
    /* 被「全部终止」打断 → 排队消息留在队列里等用户，不再自动接管发送。
       被「⏸暂停」让位的一轮同理，而且更严格：暂停就是「停在这里等我」，
       排水 / 自愈补发 / 计划续跑全都等用户点「继续」之后再说。 */
    const holdQueue = outcome === "cancelled" || !!st.paused;
    /* 会话收尾：清单里没跑完的条目按本轮结局定性（红叉 / 问号）。
       队列里还有下一条要发 → 先不定性，等真正空闲的那轮结束再判。
       暂停的一轮不算终账：待办原样留给「继续」之后的那一轮去收尾。 */
    try {
      if (!st.paused && (!hasQueued || outcome === "cancelled"))
        agentFinalizeTodos(st, outcome);
    } catch (_) {}
    if (S.thinking) delete S.thinking["agent:" + st.id];
    /* 本轮结束 → 刷新「最后对话时间」，侧边栏相对时长随之更新 */
    st.updatedAt = Date.now();
    await persistAgentSession();
    renderAgentSessionSidebar();
    /* 只在当前查看本会话时重绘会话区;否则仅刷新侧边栏运行状态,不打扰其他会话视图 */
    if (agentViewIs(st)) renderAgentSession();
    syncAgentTaskFromSession(st.id);
    endSaveNodeHold();
    /* 本轮真正结束 → 自动发送排队中的下一条消息 */
    /* 计划续跑只对「计划执行器自己那一轮」生效：用户手动发的一轮跑完绝不自动接着跑计划
       （否则就会出现「开头突然执行不想干的旧计划」）。手动那一轮之后计划停在面板上，
       要接着跑只能由用户点「▶ 继续执行」。 */
    try {
      if (
        planExecMsg &&
        !hasQueued &&
        !holdQueue &&
        !st._cancelled &&
        st._planExec &&
        st.plan &&
        /* 本轮所属的那一次执行仍然活着才续跑：用户中途「继续执行」另起一轮、
           或这份计划已被终止 / 清除，旧轮次的收尾一律闭嘴。 */
        String(st._planExec.runId || "") === String(opts.planRunId || "") &&
        typeof planCursorOwned === "function" &&
        planCursorOwned(st) &&
        typeof planExecContinue === "function"
      )
        planExecContinue(st);
    } catch (_) {}
    /* ---------- 计划漏弹自愈（模型生成失误的自动纠错） ----------
       本轮按要求本该弹「计划确认」，却因为标记写坏 / 漏闭合 / 没包标记而没弹 →
       自动回发一条纠错指令，让模型按契约重新生成一次。触发条件在这里一次凑齐：
         · 只认「用户亲口那一轮」（自愈轮与计划执行轮都不参与，结构上不可能连环）；
         · 本轮正常结束（被终止 / 出错 = 用户已改口，不抢他的下一步）；
         · 没有排队的用户消息（有就给用户让路，绝不插队）；
         · 配额 PLAN_FIX_MAX_ROUNDS（默认 1 次，仍失败只提示，见上面的收尾）。
       必须等 st.running 已经是 false 才发：否则 agentSessionSend 会判成"会话忙"
       把这条塞进发送队列，用户会看到一条自己没打过的排队消息。 */
    try {
      if (st._planFixAsk) {
        st._planFixAsk = false;
        const cap =
          typeof PLAN_FIX_MAX_ROUNDS === "number" ? PLAN_FIX_MAX_ROUNDS : 1;
        if (
          !planFixMsg &&
          !hasQueued &&
          !holdQueue &&
          outcome === "ok" &&
          (Number(st._planFixRounds) || 0) < cap &&
          /* 会话被用户中途删掉 → 不追发（否则 agentSessionSend 只会回一句
             「所属会话已不存在，计划已停止」，凭空多出一条看不懂的提示） */
          (typeof agentSessionById !== "function" || !!agentSessionById(st.id)) &&
          typeof planFixDirective === "function"
        ) {
          st._planFixRounds = (Number(st._planFixRounds) || 0) + 1;
          try {
            if (agentViewIs(st))
              toast(I18n.t("检测到计划未弹出，已自动要求重新生成一次"), "warn");
          } catch (_) {}
          await agentSessionSend(planFixDirective(), {
            sessionId: st.id,
            _planFix: true,
          });
        }
      }
    } catch (_) {}
    /* ---------- 长时自治 · 自动续跑（renderer/app-longrun.js） ----------
       用户已确认的口径：会话内自动续跑，以目标达成为准、自检判停；不自动中断、
       不弹卡（时间 / 轮数 / 开销只做累计小字），只在命中安全上限时停下告知。
       续跑不抢用户的下一步：只在「本轮正常结束 + 没有排队消息 + 没被暂停/终止」
       时才追轮；发的是「自检 + 续跑」指令（先对照目标自查，再决定继续还是收工）。 */
    try {
      if (
        window.LongRun &&
        typeof window.LongRun.afterRound === "function" &&
        !hasQueued &&
        !holdQueue &&
        !planFixMsg
      ) {
        await window.LongRun.afterRound(st, outcome);
      }
    } catch (_) {}
    if (!holdQueue) agentDrainQueue(st);
  }
}

/* ═══════════ 会话 / 助手输入框的内嵌图像（正文一行 ![名称](绝对路径) + 胶囊条） ═══════════
   为什么不把输入框换成富文本：这两只 <textarea> 的取值 / 草稿 / 队列 / 斜杠命令 /
   Enter 发送全挂在 .value 上（app-boot.js），换成 contenteditable 等于把这些链全改一遍。
   所以「内嵌图」在这里就是正文里的一行 Markdown，能力全部复用共享模块
   （renderer/app-inline-img.js 的 textarea 版）：粘贴 / 拖入 → 在光标处插一行
   ![名称](绝对路径)，正文里那一行就是唯一真源 —— 发送、草稿、命令都原样走老路。

   两条来源，两条落盘口径（与画布 / 审阅同一套）：
     · 资源管理器拖入 / 从浏览器复制图片文件：有本机路径 → 直接引用那个绝对路径（不复制文件）；
     · 剪贴板截图（window.api.clipboardReadImage）：只有 base64、没有路径 → 先落盘成真文件
       （优先会话 / 助手的工作目录下的 .mtnode-input/，没有工作目录退回数据目录 chat-input/），
       再引用落出来的绝对路径 —— 绝不写一行指向不存在文件的引用（模型读不到、图也显示不出来）。

   胶囊条 = 正文里图行的「所见即所得」投影：一枚胶囊对一行（#行号 + 缩略图 + 文件名 + ✕），
   点胶囊把光标定位并选中正文那一行，✕ 删掉整行。渲染是幂等的（按正文签名比对），
   所以挂在既有重绘点（paintAgentSendState / renderAssistPanel）上，切会话、
   恢复草稿、发完清空都能同步，不需要另加监听。 */
const CHAT_IMG_SPECS = [
  /* ws：落盘目录的基准（现取 —— 切会话 / 换工作目录后仍然正确） */
  { id: "agentInput", ws: () => agentRunWorkspace(agentSessionState()) },
  { id: "assistInput", ws: () => assistDisplayWorkspace() },
];

function chatImgModule() {
  return window.MTInlineImg || null;
}
function chatImgInput(spec) {
  const el = document.getElementById(spec.id);
  return el && /^textarea$/i.test(el.tagName || "") ? el : null;
}
/* 落盘目录：工作目录下 .mtnode-input/（相对路径的基准就在旁边，模型也读得到） */
function chatImgDirFor(ws) {
  const base = String(ws || "").trim();
  if (!base) return "";
  return joinPath(base, ".mtnode-input");
}
/* base64 → 字节（file:writeBytes 只认字节，字符串会被当 utf8 写坏）。
   先归一 data URL 前缀：来源可能是整条 data:image/png;base64,…（FileReader 的形态），
   直接 atob 会抛 InvalidCharacterError —— 表现就是「图片落盘失败，无法插入」。
   stripDataUrl 是共享模块的同一份口径（模块没就绪时本地兜一道，绝不写坏字节）。 */
function chatImgBytes(b64) {
  const m = chatImgModule();
  const raw =
    m && typeof m.stripDataUrl === "function"
      ? m.stripDataUrl(b64)
      : String(b64 || "").replace(/^data:[^,]*,/, "");
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/* 共享模块的 saveBase64 钩子：把「没有本机路径」的图片来源落成一张真文件。
   命名 paste-<时间戳36进制>.<ext>；同一毫秒多张也不会重名。失败回 null（模块自己提示）。 */
async function chatImgWriteBase64(picked, wsGetter) {
  const ext =
    String((picked && picked.ext) || ".png").replace(/^\./, "").toLowerCase() || "png";
  let dir = "";
  try {
    dir = chatImgDirFor(wsGetter ? wsGetter() : "");
  } catch (_) {
    dir = "";
  }
  if (!dir) {
    /* 没设工作目录：退回应用数据目录（绝不落应用安装目录，见 AGENTS.md 数据纪律） */
    try {
      const r = await window.api.dataGetRoot();
      if (r && r.ok && r.path) dir = joinPath(String(r.path), "chat-input");
    } catch (_) {
      dir = "";
    }
  }
  if (!dir) return null;
  const dest = joinPath(dir, "paste-" + Date.now().toString(36) + "." + ext);
  try {
    const w = await window.api.fileWriteBytes(dest, chatImgBytes(picked && picked.base64));
    if (w && w.ok === false) return null;
  } catch (_) {
    return null;
  }
  /* 名称 = 图行里的「名称」：剪贴板位图（截图）统一叫「截图」，
     来源是图片文件时用原文件名（剥掉扩展名） */
  const nm = String((picked && picked.name) || "")
    .replace(/\.[^.\\/]+$/, "")
    .trim();
  const generic = !nm || /^(screenshot|image|blob|clipboard|untitled)$/i.test(nm);
  return { path: dest, alt: generic ? I18n.t("截图") : nm };
}
/* 输入框上方的胶囊条容器：会话 = .agent-composer-card 之前（chips 之下、卡片之上）；
   助手 = .assist-input-row 之前。输入区被搬到应用开发页时容器随它一起走，
   所以复用判据是「容器自己还在文档里」而不是「锚点还在不在」。 */
function chatImgStripEl(ta) {
  if (ta._iiStrip && ta._iiStrip.isConnected) return ta._iiStrip;
  const card = ta.closest(".agent-composer-card") || ta.closest(".assist-input-row");
  const host = card ? card.parentElement : ta.parentElement;
  if (!host) return null;
  const box = document.createElement("div");
  box.className = "ii-line-chips";
  box.hidden = true;
  if (card) host.insertBefore(box, card);
  else host.appendChild(box);
  ta._iiStrip = box;
  return box;
}
/* 点 / 删之前按当前正文重算一次：「同一行」的偏移（胶囊是按某一帧正文画的；
   正文若从别的路径变过，拿旧偏移去选 / 去删就会动到别的行）。找不到 = 那行已经没了。 */
function chatImgLineNow(ta, l) {
  const m = chatImgModule();
  if (!m || !ta || !l) return null;
  const lines = m.imgLines(ta.value);
  let hit = lines.find((x) => x.start === l.start && x.ref === l.ref);
  if (!hit) hit = lines.find((x) => x.n === l.n && x.ref === l.ref);
  if (!hit) hit = lines.find((x) => x.ref === l.ref);
  return hit || null;
}
/* 点胶囊：光标进正文那一行并整行选中（「一一对应」看得见） */
function chatImgLineFocus(ta, l) {
  const now = chatImgLineNow(ta, l);
  if (!now) return;
  try {
    ta.focus();
    ta.setSelectionRange(now.start, now.end);
  } catch (_) {}
}
/* ✕：删掉整行（连同它独占的那个换行），删完派一次 input 事件让既有监听同步
   （发送键态 / 斜杠候选 / 胶囊条自己都挂在 input 上，不必到处加钩子） */
function chatImgLineRemove(ta, l, spec) {
  const now = chatImgLineNow(ta, l);
  if (!now) {
    /* 正文已经不是画胶囊时那一帧了：只把胶囊条按现正文重画，绝不按旧偏移乱删 */
    if (spec) chatImgStripRender(spec, ta);
    return;
  }
  const v = String(ta.value || "");
  let s = now.start;
  let e = now.end;
  if (v.slice(e, e + 1) === "\n") e++;
  else if (v.slice(s - 1, s) === "\n") s--;
  ta.value = v.slice(0, s) + v.slice(e);
  try {
    ta.setSelectionRange(s, s);
  } catch (_) {}
  try {
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (_) {}
  /* 「删除图」：这一行没了 → 本功能落的图若别处（会话消息 / 画布节点 / 其它输入框）
     一处引用都没有，就随这次删除回收（去抖一轮，连着删几张只跑一次）。 */
  chatImgGcSoon([now.ref]);
}
/* 胶囊条渲染（幂等：正文签名没变就不动 DOM，流式重绘期间不会被反复重建） */
function chatImgStripRender(spec, ta) {
  const m = chatImgModule();
  if (!m || !ta || !ta.isConnected) return;
  const lines = m.imgLines(ta.value);
  const box = chatImgStripEl(ta);
  if (!box) return;
  const sig = spec.id + "|" + lines.map((l) => l.n + ":" + l.ref).join("\n");
  if (box._iiSig === sig) return;
  box._iiSig = sig;
  box.innerHTML = "";
  box.hidden = !lines.length;
  if (!lines.length) return;
  for (const l of lines) {
    const chip = document.createElement("div");
    chip.className = "ii-line-chip";
    chip.title =
      I18n.t("第 ") +
      l.n +
      I18n.t(" 行 · 点击定位到正文里的这一行") +
      "\n" +
      l.ref;
    /* 缩略图：本机绝对路径 / file:/// 直接显示；相对引用没有基准目录 → 退回图标 */
    const thumb = document.createElement(l.url ? "img" : "span");
    thumb.className = "ii-line-chip-thumb";
    if (l.url) {
      thumb.src = l.url;
      thumb.alt = l.alt || "";
      thumb.loading = "lazy";
      if (typeof openImageLightbox === "function")
        thumb.onclick = (ev) => {
          ev.stopPropagation();
          openImageLightbox(l.ref, m.baseName(l.ref) || l.alt || "");
        };
    } else {
      thumb.textContent = "🖼";
    }
    chip.appendChild(thumb);
    const idx = document.createElement("b");
    idx.className = "ii-line-chip-idx";
    idx.textContent = "#" + l.n; /* 与正文行号一一对应 */
    chip.appendChild(idx);
    const nm = document.createElement("span");
    nm.className = "ii-line-chip-name";
    /* 显示正文里那个「名称」（与 ![名称](路径) 逐字对应），没有才退回文件名 */
    nm.textContent = l.alt || m.baseName(l.ref) || "";
    chip.appendChild(nm);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "ii-line-chip-x";
    x.textContent = "✕";
    x.title = I18n.t("从正文里删掉这一行");
    x.onclick = (ev) => {
      ev.stopPropagation();
      chatImgLineRemove(ta, l, spec);
    };
    chip.appendChild(x);
    chip.onclick = () => chatImgLineFocus(ta, l);
    box.appendChild(chip);
  }
}
/* 绑定 + 刷新（幂等）：挂在既有重绘点上，每轮只做一次签名比对 */
function chatInlineImgTick() {
  const m = chatImgModule();
  if (!m || typeof m.bindTextarea !== "function") return;
  for (const spec of CHAT_IMG_SPECS) {
    const ta = chatImgInput(spec);
    if (!ta) continue;
    /* 「清空框」判据用：这一帧正文里有哪几张图（绑定那一刻先按现值定一次） */
    if (!Array.isArray(ta._iiChipRefs))
      ta._iiChipRefs = m.imgLines(ta.value).map((l) => l.ref);
    m.bindTextarea(ta, {
      /* 目标：直接引用本机绝对路径（没有事实库、也不复制文件；正文写的就是绝对路径） */
      target: () => ({
        kind: "path",
        name: "",
        saveBase64: (picked) => chatImgWriteBase64(picked, spec.ws),
      }),
      /* 插入成功：派一次 input 事件（发送键态 / 胶囊条都随它同步），并直接刷一次胶囊条 */
      onInserted: () => {
        try {
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        } catch (_) {}
        chatImgStripRender(spec, ta);
      },
      onChanged: () => {
        chatImgStripRender(spec, ta);
        /* 「清空框」= 输入框里原本有图，这一次改动把最后一张图也去掉了：
           记下那几张，交给回收判定（还在会话消息 / 画布里的照旧保留）。 */
        const before = ta._iiChipRefs || [];
        const now = m.imgLines(ta.value).map((l) => l.ref);
        ta._iiChipRefs = now;
        const lost = before.filter((r) => now.indexOf(r) < 0);
        if (lost.length && !now.length) chatImgGcSoon(lost);
      },
    });
    chatImgStripRender(spec, ta);
  }
}

/* ═══════════ 输入框内嵌图的无引用回收（删图 / 清空框 / 删会话） ═══════════
   候选 = 本功能自己落盘的那一类图（<工作区>/.mtnode-input/、数据目录 chat-input /
        devnode-input 下的 paste-<时间戳36进制>.<ext>，见共享模块 isChatInputImage）。
   引用 = 现存的每一处：全部会话的消息 / 草稿 / 发件箱、画布节点任何字段（登记表不算）、
        两只输入框与开发草稿框的当前正文。
   从资源管理器拖进来的图是用户自己的文件（正文按绝对路径引用那条原文件），
   目录与命名两条都不合 → 从不进候选集，永不被本功能删。 */
/* 全部会话（含归档）里出现过的内嵌图路径 */
function chatImgSessionRefs(out) {
  const m = chatImgModule();
  const list = (typeof agentSessions === "function" ? agentSessions() : S.agentSessions) || [];
  if (!m || typeof m.imgRefsIn !== "function") return out;
  for (const st of list) {
    if (!st) continue;
    out.push(
      ...m.imgRefsIn({
        messages: st.messages || [],
        draft: st._draft || st.draft || "",
        outbox: st.outbox || [],
      }),
    );
  }
  return out;
}
/* 一个会话里的内嵌图（删会话时拿它当候选：消息 + 未发的草稿） */
function chatImgSessionCandidates(st) {
  const m = chatImgModule();
  if (!st || !m || typeof m.imgRefsIn !== "function") return [];
  return m.imgRefsIn({
    messages: st.messages || [],
    draft: st._draft || st.draft || "",
    outbox: st.outbox || [],
  });
}
/* 现存的每一处引用（画布 + 全部会话 + 输入框 / 草稿框当前正文） */
function chatImgRefs() {
  const m = chatImgModule();
  const out = [];
  if (!m || typeof m.imgRefsIn !== "function") return out;
  for (const spec of CHAT_IMG_SPECS) {
    const ta = chatImgInput(spec);
    if (ta) out.push(...m.imgRefsIn(String(ta.value || "")));
  }
  /* 开发节点草稿框（同一个 mtDialogForm 宿主，正文框是 textarea.mt-form-input）：
     弹窗里当前草稿写着的图同样算在用（草稿本身随节点落盘，见 node.devDraft） */
  try {
    for (const ta of document.querySelectorAll("textarea.mt-form-input"))
      out.push(...m.imgRefsIn(String(ta.value || "")));
  } catch (_) {}
  /* 画布节点（正文框引用同一张图时也算在用；登记表不算引用，与画布侧同一口径） */
  if (typeof S !== "undefined" && S.wf && Array.isArray(S.wf.nodes))
    out.push(...m.imgRefsIn({ nodes: S.wf.nodes }, { skipKeys: ["inlineImgs"] }));
  return chatImgSessionRefs(out);
}
/* 回收一批候选：只留本功能自己的图（目录 + 命名两条），再与全部引用比对，没引用才删盘。
   删盘由主进程校验（chat-input:deleteImages），目录 / 命名不合规一律 skipped。 */
async function chatImgGc(paths, opts) {
  const m = chatImgModule();
  const api = typeof window !== "undefined" ? window.api : null;
  const empty = { removed: [], skipped: [] };
  if (!m || typeof m.isChatInputImage !== "function" || typeof m.orphanImages !== "function")
    return empty;
  if (!api || typeof api.chatInputDeleteImages !== "function") return empty;
  const cands = (paths || []).filter((p) => m.isChatInputImage(p));
  if (!cands.length) return empty;
  const orphans = m.orphanImages(cands, chatImgRefs());
  if (!orphans.length) return empty;
  let r = null;
  try {
    r = await api.chatInputDeleteImages(orphans);
  } catch (_) {
    r = null;
  }
  const removed = (r && r.removed) || [];
  if (removed.length && !(opts && opts.quiet))
    toast(I18n.t("已从磁盘删除 ") + removed.length + I18n.t(" 个无引用图片"), "ok");
  return { removed, skipped: (r && r.skipped) || [] };
}
/* 去抖回收（300ms）：候选先攒着，连删多张 / 清空框只跑一轮 */
let _chatImgGcTimer = null;
let _chatImgGcPending = [];
function chatImgGcSoon(paths) {
  for (const p of paths || []) if (p) _chatImgGcPending.push(p);
  if (!_chatImgGcPending.length) return;
  if (_chatImgGcTimer) clearTimeout(_chatImgGcTimer);
  _chatImgGcTimer = setTimeout(() => {
    _chatImgGcTimer = null;
    const list = _chatImgGcPending;
    _chatImgGcPending = [];
    Promise.resolve(chatImgGc(list)).catch(() => {});
  }, 300);
}
/* 删会话（或删节点带走的会话）后回收它的内嵌图：候选来自那条会话自己，
   而它已从列表摘掉 → 引用集合天然不含它，还剩谁引用就保留给谁。 */
function chatImgGcForSessions(sessions) {
  const paths = [];
  for (const st of sessions || []) paths.push(...chatImgSessionCandidates(st));
  if (paths.length) chatImgGcSoon(paths);
}


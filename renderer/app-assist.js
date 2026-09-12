"use strict";
/* ============ 右侧全局 AI 助手 ============ */

/* 助手每轮的「当前应用状态」快照 —— 只给计数 + 选中 / 焦点。
   它是每轮都注入、且与任务无关的固定开销，所以这里连「节点索引」都不带：画布信息只有
   节点数 / 连线数 / 分组数 + selection（id/kind/title 最小描述）+ taskFocus / superFocus。
   节点列表、结构、连线与正文一律由模型按需用 mtnode_canvas_get 现拉（列表 / 结构走
   detail:"minimal" + sections，正文走 ids:[…] + detail:"full"）——「画布多大」与
   「每轮成本」由此解耦：62 个节点的索引不再随系统提示每轮重发。
   opts.canvasFree = 用户声明本轮与画布无关（Gate B）：连选中 / 焦点也不给，只剩计数与
   本画布身份。判据与 noCanvas 整档闸同源：那一档下 get / edit / app 三件套根本没注册，
   快照再发出去也没有任何工具能消费它。 */
async function assistAppSnapshot(opts) {
  const canvasFree = !!(opts && opts.canvasFree);
  const sel = currentSelection().map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
  }));
  const scopeCurrent = assistScopeIsCurrent();
  const safeApp =
    "mtnode_app:status|list_workflows|rename_workflow|select_nodes|undo|redo" +
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
    ws.readOnly = locked;
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

function bindAssistResize() {
  const handle = $("#assistResize");
  const pane = $("#assistPane");
  if (!handle || !pane || handle._bound) return;
  handle._bound = true;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  const onMove = (ev) => {
    if (!dragging) return;
    const dx = startX - ev.clientX; /* 向左拖 = 变宽 */
    applyAssistWidth(startW + dx, false);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    applyAssistWidth(S.assistW, true);
  };
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    startX = ev.clientX;
    startW = S.assistW || ASSIST_W_MIN;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
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
}

function bindAgentSideResize() {
  const handle = $("#agentSideResize");
  if (!handle || handle._bound) return;
  handle._bound = true;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  const onMove = (ev) => {
    if (!dragging) return;
    /* 向右拖 = 变宽；拖动过程中只改样式，不落盘 */
    applyAgentSideWidth(startW + (ev.clientX - startX), false);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    applyAgentSideWidth(S.agentSideW, true);
  };
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    startX = ev.clientX;
    startW = S.agentSideW || AGENT_SIDE_W_MIN;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  /* 双击把手 = 回到默认（最小）宽度 */
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
  /* 每次从当前配置读取，避免首次绑定时的空目录快照 */
  const modelsFor = (prov) => {
    const catalog = S.providerCatalog || {
      deepseek: [
        { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", input: ["text"] },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
        {
          id: "deepseek-v4-flash-vision-exp",
          name: "DeepSeek-V4-Flash-Vision-Exp",
          input: ["text", "image"],
        },
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
  const sub = document.querySelector("#assistPane .assist-sub");
  if (sub) {
    sub.textContent = scopeCurrent
      ? I18n.t("仅当前画布")
      : I18n.t("可见全局状态");
  }
}

/* 「与画布无关」开关的回显（Gate B · 助手侧）：开启态高亮 + tooltip 说清代价。
   标题走 dataset.i18nTitle，切语言时 I18n.apply 会重刷，不会退回旧文案。 */
function updateAssistCanvasFreeChrome() {
  const btn = document.getElementById("assistCanvasFreeBtn");
  if (!btn) return;
  const on = !!S.assistCanvasFree;
  btn.classList.toggle("on", on);
  btn.dataset.i18nTitle = on
    ? "与画布无关：开启中，点击关闭（助手本轮不注册任何画布与应用工具）"
    : "与画布无关：助手本轮不注册任何画布与应用工具，也不再注入整张画布快照，省 token；需要改画布时先关掉它";
  btn.title = I18n.t(btn.dataset.i18nTitle);
}

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
        empty.textContent = S.assistCanvasFree
      ? I18n.t(
          "本助手已声明「与画布无关」：本轮不注册任何画布工具，也不读画布，只读写文件 / 联网 / 执行命令。\n要总结或搭建工作流，请先关掉「与画布无关」。",
        )
      : scopeCurrent
      ? I18n.t(
          "当前工作范围是本画布。我能查看并修改当前画布节点与配置。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图前会请你确认；要参考其他画布请把工作范围改为「全局」。",
        )
      : I18n.t(
          "我能看到当前画布、节点与配置，也可参考其他画布列表。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图或删除画布前会请你确认。",
        );
    list.appendChild(empty);
  }
  /* 回滚入口挂在每条挂有回滚轮次的用户消息上（会话不在运行中时显示） */
  for (let i = 0; i < msgs.length; i++) {
    try {
      list.appendChild(
        dshMsgBlock(msgs[i], "assist", i, {
          showRollback:
            !S.assistRunning &&
            !msgs[i]._rolledBack &&
            typeof rbHasMsgRound === "function" &&
            rbHasMsgRound(msgs[i]),
        }),
      );
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
  /* 助手栏末尾：同一份 Token 累计报告 Badge（按模型累计，点击展开） */
  if (typeof tokBadgeEl === "function" && typeof assistTokOwner === "function") {
    try {
      const badge = tokBadgeEl(assistTokOwner());
      if (badge) list.appendChild(badge);
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
  updateAssistCanvasFreeChrome();
  fillAssistModelControls();
  restoreConvStick(list, stickCap);
  if (typeof requestAnimationFrame === "function") {
    /* 折叠等事后高度变化：再按锚点还原一次（贴底滚到底，未贴底保持原位） */
    requestAnimationFrame(() => restoreConvStick(list, stickCap));
  }
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
     判据在这里定一次，往下（快照 / 分节 / 隐藏名单 / 签名 / run 参数）全用同一个值。 */
  const assistCanvasFree = !!S.assistCanvasFree;
  /* 不缩进序列化：这份快照每轮原样重发，缩进（null, 2）纯属白送的空格 token */
  const stateJson = JSON.stringify(
    await assistAppSnapshot({ canvasFree: assistCanvasFree }),
  );
  /* 已回滚轮次的消息不进上下文（rbActiveMessages 只在真有标记时才复制数组） */
  const assistHist =
    typeof rbActiveMessages === "function" ? rbActiveMessages(S.assistMessages) : S.assistMessages;
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
     mtnode-canvas-layout-ux / mtnode-media-gen-nodes / mtnode-db-facts）。下面各节只留
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
    ? "工作范围：与画布无关 —— 本轮不注册 mtnode_canvas_get / mtnode_canvas_edit / mtnode_app，也不读取任何画布内容。\n工具：只剩文件读写、联网搜索与命令执行（外加识图子代理，视工具许可而定）。\n"
    : scopeCurrent
    ? "工作范围：仅当前画布「" +
      wfName +
      "」。list_workflows / canvas_get 只会看到本画布。\n" +
      "工具：\n" +
      "- mtnode_canvas_get：读取当前画布（默认 minimal，只回节点索引；要读某节点正文用 ids:[标题或 id] + detail:\"full\"，看连线 / 结构用 sections 收窄）\n" +
      "- mtnode_app：rename_workflow（仅本画布）/ select_nodes / undo / redo / status / list_workflows（仅本画布）；delete_workflow 仅可删本画布且需确认；list_dsh_plugins / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin（安装与挂载需确认，插件装在配置目录、升级保留）。\n"
    : "工作范围：全局。可参考全部画布列表。\n" +
      "工具：\n" +
      "- mtnode_canvas_get：读取当前画布 + 全部画布列表（默认 minimal，只回节点索引；要读某节点正文用 ids:[标题或 id] + detail:\"full\"，看连线 / 结构用 sections 收窄）\n" +
      "- mtnode_app：rename_workflow / select_nodes / undo / redo / status / list_workflows；delete_workflow 会弹窗确认；list_dsh_plugins / install_dsh_plugin / remove_dsh_plugin / set_dsh_plugin（安装与挂载需确认，插件装在配置目录、升级保留）。\n";
  /* ── systemPrompt 分节（见 app-prompt-sections.js）──────────────────────────
     每段各自独立成节，节序 = 改造前的拼接顺序、节间分隔符传空串 ⇒
     拼出来的字符串与今天逐字节一致；app_state（当前应用状态 JSON，每轮都变的最大头）
     单独成节，便于将来按节 diff。skill_index / db_grounding / tool_policy /
     lang_taste 由 app-db.js 统一追加，此处不重复注入。 */
  const personaHost = assistCanvasFree
    ? "你是 MTNode AI编排器的全局助手，位于界面右侧栏。本档已声明「与画布无关」：不注册任何画布与应用工具（mtnode_canvas_get / mtnode_canvas_edit / mtnode_app 都不可用），你只读写文件、联网、执行命令。\n本轮不要承诺任何画布改动，也不要臆造节点或画布现状；确实需要改画布时，请让用户先关掉助手栏的「与画布无关」再重跑。\n"
    : "你是 MTNode AI编排器的全局助手，位于界面右侧栏。你能看到并操作应用内画布、节点、服务商与智能配置摘要。\n";
  const visionMediaRules = assistCanvasFree
    ? /* 无画布档：整段画布 / 节点口径撤掉，只留「回执即事实」这条通用纪律 */
      "- 工具回执里没有的结果，不要向用户声称已完成。\n"
    : "- mtnode_vision：识图子代理。中途需要看本地图片内容（游戏 UI、截图 OCR、核对生成图）时调用，传 imagePath（绝对路径）+ question；首次会请用户许可（允许一次 / 始终允许 / 拒绝）。不要把大批图片塞进主对话。\n" +
    "  · 文字处理与图生文（多模态识图）要隔离：先由专用识图 / 智能任务节点把图像转成文字，再让纯文本节点吃那段文字，这样文字步骤能选更合适的非视觉模型。\n" +
    "  · 图像参考节点用 kind input_image，把本机绝对路径写进 imagePath（应用会复制进画布资产），已知路径就不要让用户再拖拽；多图 batch:true + imagePaths。\n" +
    "  · 改节点模型：create/update 传 model，文本 / 图像节点配 providerId（服务商 id 或唯一名称），智能任务配 provider（deepseek-official 或 mtnode_<id> / 名称）。\n" +
    "  · 工具回执（created[] / updated[] / hasImage / warnings）才是事实依据：没出现在回执里的结果，不要向用户声称已完成。\n" +
    "  · 音 / 视频生成节点（music_gen / tts_gen / video_gen / remotion）的后端、outputPath、抽卡与显存互斥口径见技能 mtnode-media-gen-nodes；批次与文生图的防 N² 细则见技能 mtnode-canvas-edit-rules（细则再进 mtnode-canvas-batch-safety）。\n";
  /* @引用、save / wait_file、端子与批次规则已由技能 mtnode-canvas-edit-rules 承载
     （mtnode_canvas_edit 只留卡口与一句指向）；这里只留助手侧的排版动作。 */
  const layoutRules = assistCanvasFree
    ? ""
    : "  · 排版：用 createMarks 分区（box + around:[节点alias] + label：编辑区 / 说明 / 处理区 / 输出区），并放 control 控制节点（ctrlAction=run，不要建 clear「清空」；控制流不走数据线，须直连每个该一键重跑的节点）；用户要编辑或点 ▶ 的节点放上方（较小 y），处理 / 保存 / 长说明放下方或右侧。完整规范见技能 mtnode-canvas-layout-ux。\n" +
    "  · 用户要求整理排版 / 一键排版时：先 mtnode_canvas_get 读节点与绘制的 x/y/w/h，再自行判断，用 mtnode_canvas_edit（layout:false）的 update / updateMarks 校准位置与尺寸（整洁、可编辑节点靠上、绘制跟着节点走）；禁止调用 layout action，勿增删节点、勿改连线，然后简短确认。\n";
  const principleBlock = assistCanvasFree
    ? "原则：本轮与画布无关 —— 不读写画布、不承诺任何节点改动，只完成任务本身；不要编造不存在的节点或画布。回答简洁（交流语言见文末语言口味）。\n"
    : scopeCurrent
    ? "原则：仅操作当前画布；app_state 只给计数与选中 / 焦点，节点列表与正文一律按需 mtnode_canvas_get 现拉，不得凭标题编造节点内容；改节点图、删画布、装/卸 DSH 插件再走确认。回答简洁（交流语言见文末语言口味）。不要编造不存在的节点或画布。\n" +
      "纪律：长正文一条都不进主上下文 —— 节点之间只写 @标题 引用，禁止把上游节点正文粘贴进 prompt/task（@引用口径见技能 mtnode-canvas-edit-rules）；长文案 / 长说明交给 agent_task 或 input_text 节点落文件，你只报路径；建图时不要贴成品正文当示例，只写一句形态描述。收尾克制：只报改了什么、产物路径、需用户操作的 1–2 处，不复述画布全表。建图—自查—排版这类多轮工作放进子代理上下文，主对话只收最终回执。\n"
    : "原则：可参考其他画布列表；app_state 只给计数与选中 / 焦点，节点列表与正文一律按需 mtnode_canvas_get 现拉，不得凭标题编造节点内容；改节点图、删画布、装/卸 DSH 插件再走确认。回答简洁（交流语言见文末语言口味）。不要编造不存在的节点或画布。\n" +
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
     noCanvas = 用户勾了「与画布无关」（Gate B 助手侧），与会话侧 st.canvasFree 同一个整档闸。
     名单与 dshRunOnce 用同一个 dshHiddenToolsFor 算，否则开关一开，分节快照与真实运行
     签名就长期错开（快照每轮白作废）。 */
  const assistLean = typeof dshLeanToolsOn === "function" ? dshLeanToolsOn() : false;
  const assistHide =
    typeof dshHiddenToolsFor === "function"
      ? dshHiddenToolsFor({
          pure: false,
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
  const systemPrompt =
    typeof renderSections === "function"
      ? renderSections("assist", assistSections, {
          join: "",
          sig: dshRunSigOf({
            workspace: S.assistRunWorkspace || S.dshWorkspaceFallback || "",
            model: S.assistModel || "",
            provider: S.assistProvider || "deepseek-official",
            preset: S.assistPreset || AGENT_PRESET_DEFAULT,
            effort: S.assistEffort || "high",
            pure: false,
            lean: typeof dshLeanToolsOn === "function" ? dshLeanToolsOn() : false,
            noCanvas: assistCanvasFree,
            hide: assistHide,
            maxTokens: assistMaxTok,
          }),
        }).text
      : /* 内核不在（老沙箱只抠单文件）：按同一节序直接串接，结果与分节渲染一致 */
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
        ].join("");
  let assistHitMaxTokens = false;
  try {
    const final = await dshRunTask(input, {
      runKey: "assist",
      /* 本轮的开轮消息：rid 由回滚账本盖在它身上（供「↶ 回滚到此处」寻址） */
      rollbackAnchor: assistUm,
      rollbackLabel: t.slice(0, 160),
      workspace: S.assistRunWorkspace || S.dshWorkspaceFallback || "",
      preset: S.assistPreset || AGENT_PRESET_DEFAULT,
      provider: S.assistProvider || "deepseek-official",
      model: S.assistModel || undefined,
      effort: S.assistEffort || "high",
      systemPrompt,
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
           · resumed=true（续写）：新内容接在同一条逻辑轮次后面，已显示的部分正文 /
             工具列表 / 思考槽一律保留，直接返回；
           · resumed=false（整轮重发）：清上一轮的部分正文 / 工具 / 思考槽，
             重发那一轮从零流式不叠字 */
        if (type === "retry") {
          if (data && data.resumed) return;
          S.assistPending = "";
          S.assistLiveTools = [];
          if (S.thinking) S.thinking.assist = [""];
          const el = document.getElementById("assist-stream");
          if (el) el.textContent = "";
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
/* 会话列表:全部持久化于 config.agentSessions,活动会话由 agentActiveId 指定 */
function agentSessions() {
  if (!Array.isArray(S.agentSessions)) S.agentSessions = [];
  /* 所属画布水合：历史存档没有 canvasWfId → 规范成空串（表示「未绑定」）。
     开轮时按当时画布补绑一次并落盘，见 app-db.js dshRunTask 的 boundWf 解析。 */
  for (const s of S.agentSessions)
    if (s && typeof s.canvasWfId !== "string") s.canvasWfId = "";
  /* 标题标记水合：titleAuto（被引擎首轮自动命名过）/ titleLocked（用户手改过）
     归一成布尔 —— 老存档没这两位就是 false，不报错也不给旧会话凭空上锁。 */
  for (const s of S.agentSessions)
    if (s) {
      s.titleAuto = !!s.titleAuto;
      s.titleLocked = !!s.titleLocked;
    }
  /* 从配置载回的会话做一次水合（planDelivered / plan → 运行时字段）；
     水合过就有 _planHydrated 标记，后续调用只是几次属性读，开销可忽略。 */
  if (typeof planHydrateSession === "function")
    for (const s of S.agentSessions) planHydrateSession(s);
  /* 开发 / 细化绑定会话的水合：旧版把整份任务书当作首条 _src:"dev-node" 用户消息，
     现改为写入 _devContract（发送时注入系统提示）；载回旧会话时做一次迁移。 */
  if (typeof devContractHydrateSession === "function")
    for (const s of S.agentSessions) devContractHydrateSession(s);
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
    preset: s.preset || AGENT_PRESET_DEFAULT,
    provider: s.provider || "deepseek-official",
    model: s.model || "",
    effort: s.effort || "high",
    pure: !!s.pure,
    /* 开发绑定会话「不读画布」标记：必须随会话落盘 —— 重启后若丢了这一位，本轮可见集
       就与那份 session 的历史前缀不一致（网关 hx: 指纹变了 → 换 runtime 冷起 → 续跑
       撞 id 只能整轮重发），所以它与 pure 同级持久化。 */
    noCanvasRead: !!s.noCanvasRead,
    /* 「与画布无关」开关同样随会话落盘：丢了这一位，重启后可见集就与那份 session
       的历史前缀不一致（网关 nc: / hx: 指纹变化 → 换 runtime 冷起）。 */
    canvasFree: !!s.canvasFree,
    draft: s._draft || "",
    /* 整对象落盘（含 reasoning / tools / segments）；segments 再限一次长：
       只夹单段字数（段一条不丢，见 agentSegsForDisk），控制 messages.slice(-100)
       的存档体积 —— 段一丢，工具 chip 就会从时间线掉到消息尾部压住最终回复 */
    messages: (s.messages || []).slice(-100).map((m) => {
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
  detachSessionsFromNodes([id]);
  list.splice(at, 1);
  if (S.agentActiveId === id) S.agentActiveId = (list[0] && list[0].id) || "";
  await persistAgentSession();
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
  ["agentModelMenu", "agentCmdMenu", "agentToolsMenu"].forEach((id) => {
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
    return st.model || (models[0] ? models[0] : "deepseek-v4-flash");
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
    mt.dataset.i18nTitle = "预设 / 模型 / 思考强度";
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
  /* 纯净模式 chip：开启态高亮 + tooltip 切换（说明同按钮标题） */
  const put = document.getElementById("agentPureTrigger");
  if (put) {
    put.classList.toggle("on", !!st.pure);
    put.dataset.i18nTitle = st.pure
      ? "纯净模式：开启中，点击关闭"
      : "纯净模式：移除全部 system prompt 与运行时上下文，仅保留联网搜索；该会话不再读写文件 / 改画布，省 token";
    put.title = I18n.t(put.dataset.i18nTitle);
  }
  /* 与画布无关 chip（Gate B）：开启态高亮 + tooltip 说清代价（改画布要先关掉） */
  const cft = document.getElementById("agentCanvasFreeTrigger");
  if (cft) {
    cft.classList.toggle("on", !!st.canvasFree);
    cft.dataset.i18nTitle = st.canvasFree
      ? "与画布无关：开启中，点击关闭（本会话不注册任何画布与应用工具）"
      : "与画布无关：该会话不注册任何画布与应用工具（读图 / 改图 / 应用操作都不发），省 token；需要改画布时先关掉它";
    cft.title = I18n.t(cft.dataset.i18nTitle);
  }
  /* 计划已产出且未在运行 → 浮现「▶ 执行计划」 */
  const rp = document.getElementById("agentRunPlanBtn");
  if (rp) rp.hidden = !(st._planDelivered && !st.running);
  paintAgentToolsChip();
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
    const pc = document.createElement("button");
    pc.className = "agent-menu-cell";
    pc.innerHTML =
      '<span class="agent-menu-cell-label">' + I18n.t("预设") + '</span>' +
      '<span class="agent-menu-cell-value"></span><span class="agent-menu-cell-chevron">›</span>';
    pc.querySelector(".agent-menu-cell-value").textContent = agentPresetLabel(st.preset);
    pc.onclick = () => { menu.dataset.pane = "preset"; buildAgentModelMenu(); };
    menu.appendChild(pc);
    const mc = document.createElement("button");
    mc.className = "agent-menu-cell";
    mc.innerHTML =
      '<span class="agent-menu-cell-label">' + I18n.t("模型") + '</span>' +
      '<span class="agent-menu-cell-value"></span><span class="agent-menu-cell-chevron">›</span>';
    mc.querySelector(".agent-menu-cell-value").textContent = agentModelName(st);
    mc.onclick = () => { menu.dataset.pane = "model"; buildAgentModelMenu(); };
    menu.appendChild(mc);
    const ec = document.createElement("button");
    ec.className = "agent-menu-cell";
    ec.innerHTML =
      '<span class="agent-menu-cell-label">' + I18n.t("思考强度") + '</span>' +
      '<span class="agent-menu-cell-value"></span><span class="agent-menu-cell-chevron">›</span>';
    ec.querySelector(".agent-menu-cell-value").textContent = agentEffortDisplayLabel(st);
    ec.onclick = () => { menu.dataset.pane = "effort"; buildAgentModelMenu(); };
    menu.appendChild(ec);
    return;
  }
  const bk = document.createElement("button");
  bk.className = "agent-menu-back";
  const backLabel = pane === "model" ? I18n.t("模型") : pane === "preset" ? I18n.t("预设") : I18n.t("思考强度");
  bk.textContent = "← " + backLabel;
  bk.onclick = back;
  menu.appendChild(bk);
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
    const groups = [];
    const dp = dshProvider();
    groups.push({ id: "deepseek-official", name: (dp && dp.name) || I18n.t("DeepSeek 官方"), models: (dp && dp.models) || [] });
    for (const p of mtnodePiProviders()) {
      const models = (p && p.models) || [];
      if (models.length) groups.push({ id: "mtnode_" + p.route, name: p.name, models });
    }
    let any = 0;
    for (const g of groups) {
      if (!g.models.length) continue;
      const gh = document.createElement("div");
      gh.className = "agent-menu-group-title";
      gh.textContent = g.name;
      menu.appendChild(gh);
      for (const m of g.models) {
        any++;
        const opt = document.createElement("button");
        opt.className = "agent-menu-option" + (st.provider === g.id && st.model === m ? " selected" : "");
        opt.innerHTML =
          '<span class="agent-menu-option-copy"><span class="agent-menu-option-name"></span></span>' +
          '<span class="agent-menu-check"></span>';
        opt.querySelector(".agent-menu-option-name").textContent = m;
        opt.onclick = () => {
          st.provider = g.id;
          st.model = m;
          persistAgentSession();
          closeAgentMenus();
          renderAgentSession();
          renderAgentSessionSidebar();
        };
        menu.appendChild(opt);
      }
    }
    if (!any) {
      const e = document.createElement("div");
      e.className = "agent-menu-empty";
      e.textContent = I18n.t("暂无模型");
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
                    id: "deepseek-v4-flash",
                    name: "DeepSeek-V4-Flash",
                    input: ["text"],
                  },
                  {
                    id: "deepseek-v4-pro",
                    name: "DeepSeek-V4-Pro",
                    input: ["text"],
                  },
                  {
                    id: "deepseek-v4-flash-vision-exp",
                    name: "DeepSeek-V4-Flash-Vision-Exp",
                    input: ["text", "image"],
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
              id: "deepseek-v4-flash",
              name: "DeepSeek-V4-Flash",
              input: ["text"],
            },
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek-V4-Pro",
              input: ["text"],
            },
            {
              id: "deepseek-v4-flash-vision-exp",
              name: "DeepSeek-V4-Flash-Vision-Exp",
              input: ["text", "image"],
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

function dshToolDetailsEl(t, live, nodeId) {
  const det = document.createElement("details");
  det.className = "dsh-tool" + (t.error ? " err" : "");
  const openKey =
    (nodeId || "") + ":" + (t.callId || t.name || "") + (t.at ? ":" + t.at : "");
  if (openKey && S.openDshTools && S.openDshTools[openKey]) det.open = true;
  const sum = document.createElement("summary");
  sum.className = "dsh-tool-sum";
  /* 那颗青色药丸 = 「工具按钮」本身，只包工具名。
     文件名不塞进药丸里（药丸一撑大就像「工具叫 read/x.js」），而是跟在按钮后方，
     且只是文字、不带外框 —— 一眼读成「🔧 read  b.js」，参考 Cursor 那一行。 */
  const chip = document.createElement("span");
  chip.className = "dsh-tool-chip";
  chip.textContent = (live ? "◌ " : "🔧 ") + t.name;
  sum.appendChild(chip);
  /* pwsh / bash：按钮后面直接跟命令正文（绿色，长命令截断）；grep / glob：跟「路径 … · 目标 … · 参数」。
     一眼读出「这步在跑哪条命令 / 找什么」，不用先展开参数。抽不出就不挂。 */
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
  sum.title =
    I18n.t("点击展开参数与结果") +
    (t.turn ? I18n.t(" · 第{turn}轮第{step}步", { turn: t.turn, step: t.step }) : "") +
    (t.at ? " · " + fmtTime(t.at) : "");
  det.appendChild(sum);
  const inner = document.createElement("div");
  inner.className = "dsh-tool-body";
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
      if (det.open) S.openDshTools[openKey] = true;
      else delete S.openDshTools[openKey];
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

function positionHistRailMarks(list, rail, marks) {
  if (!rail || !marks || !marks.length || histRailPositionLocked(list)) return;
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
        const ro = new ResizeObserver(() => updateHistRail(list));
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
    out.push(o);
  }
  return out.length ? out : null;
}
/* 历史消息能否按时间线分段渲染：段里重建出的正文（say + ⚠err 尾部）必须与
   content 完全一致（落盘裁剪过 / 无段时退回旧渲染，保证不丢字） */
function dshMsgSegsViewable(m) {
  if (!m || m.role !== "assistant") return false;
  const segs = m.segments;
  if (!Array.isArray(segs) || !segs.length) return false;
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

/* ==================== 「思考」翻译（右侧小按钮） ====================
   需求：会话里的每一段「思考」旁边给一个小按钮，点了就把这段思考翻译出来给用户看。
   口径（三条，缺一不可）：
     · 默认模型：路由取「默认智能路由」（preferredAgentProviderRoute），
       模型优先该路由下的 flash 档（如 deepseek-v4-flash），该档不可用时退回默认模型；
     · 无思考：spec.effort = "off" ⇒ main.js applyTextThinkingEffort 下发
       thinking:{type:"disabled"}，翻译请求不带推理，快且省；
     · 译文校验 + 逐档重试：实测 flash 会原样复述英文原文或只回「以下是翻译：」，
       这类返回一律不通过（dshXlateLooksTranslated），按「同模型常规提示词 → 同模型
       强化提示词 → 该路由更强模型」逐档重试，全失败才判 error（绝不当成功缓存）；
     · 按段缓存（S.thinkTrans），同一段只翻一次，命中即显示译文，可重复点开看。
   思考段有两种渲染（历史消息 dshHistSegEl / 运行中 agentLiveSegsEl）与两种形态
   （按段的时间线 seg、无段时的整段 m.reasoning），所以按钮 + 译文行拆成
   两个 builder（dshThinkTranslateBtn / dshThinkTranslateRow），三处渲染共用一份状态；
   按钮由 dshThinkTranslateAppend 塞进折叠条 <summary> 的最右端（不另起一行），
   折叠条文案是其中的 span.dsh-think-sum-txt，刷新字数只改这层。 */
function dshThinkTransKey(scopeId, segKey) {
  return String(scopeId || "") + ":" + String(segKey == null ? "" : segKey);
}
function dshThinkTransItem(scopeId, segKey) {
  const store = S.thinkTrans || (S.thinkTrans = {});
  return store[dshThinkTransKey(scopeId, segKey)] || null;
}
/* 翻译专用模型：默认路由下优先 flash（无思考 + 快），否则跟随默认模型 */
function dshTranslateModel() {
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
  if (flash) return { route, model: String(flash) };
  let model = "";
  try {
    model =
      typeof preferredAgentModelForRoute === "function"
        ? String(preferredAgentModelForRoute(route) || "")
        : "";
  } catch (_) {}
  return { route, model: model || String(models[0] || "") };
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
/* 翻译候选链：同一条思考按「便宜优先」逐档重试。
   实测（DeepSeek 官方 deepseek-v4-flash / v4-pro · thinking disabled）会**原样复述英文原文**
   或只输出「以下是对这段思考的翻译：」这类元话术 —— 旧实现把这种返回也当成功缓存，
   于是用户看到「译文」还是英文。对策：提示词收紧 + 译文校验 + 逐档重试（模型升档），
   全部候选都拿不到像样译文才判失败（错误行里可点「重试翻译」）。 */
function dshTranslateCandidates(route, model) {
  const out = [];
  const push = (m, strict) => {
    const mm = String(m || "").trim();
    if (!mm) return;
    if (out.some((c) => c.model === mm && c.strict === strict)) return;
    out.push({ model: mm, strict: !!strict });
  };
  /* ① 首选：默认路由下的 flash 档（快 + 无思考）· 常规提示词 */
  push(model, false);
  /* ② 同模型 + 强化提示词（补「你是翻译引擎 / 不要分析任务」的卡口） */
  push(model, true);
  /* ③ 升档：该路由的默认（更强）模型 · 强化提示词 */
  let strong = "";
  try {
    strong =
      typeof preferredAgentModelForRoute === "function"
        ? String(preferredAgentModelForRoute(route) || "")
        : "";
  } catch (_) {}
  if (strong && strong !== String(model || "").trim()) push(strong, true);
  return out;
}
/* 输出疑似「复述原文 / 元话术」而非译文时判不通过。
   实测口径：
     · 输出没有中文，且原文以中文为主 ⇒ 这是「中文→英文」的译文，通过；
     · 输出没有中文，原文也以英文为主 ⇒ 模型原样吐回英文（复述），不通过；
     · 原文以英文为主时，译文前 400 字英文占比 ≥ 80% ⇒ 仍是复述；
     · 开头就是「以下是这段思考的翻译：」式元话术（回的是任务分析不是译文）⇒ 不通过；
     · 前 400 字与原文逐字相同且原文以英文为主 ⇒ 复述，不通过。 */
function dshXlateLooksTranslated(src, out) {
  const text = String(out || "").trim();
  if (!text) return false;
  const isCjk = (s) => (String(s || "").match(/[\u4e00-\u9fff]/g) || []).length;
  const isLat = (s) => (String(s || "").match(/[A-Za-z]/g) || []).length;
  const srcCjk = isCjk(src);
  const srcLatin = isLat(src);
  const srcMostlyCjk = srcCjk > srcLatin;
  if (!/[\u4e00-\u9fff]/.test(text)) return srcMostlyCjk;
  if (srcMostlyCjk) return true; /* 目标是英文译文，有内容即算通过 */
  const head = text.slice(0, 400);
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
  /* 近乎逐字复述原文（前 400 字去空白后完全一致）⇒ 若原文以英文为主即复述 */
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const srcHead = norm(String(src || "").slice(0, 400));
  const outHead = norm(text.slice(0, 400));
  if (srcHead && outHead && outHead === srcHead && !srcMostlyCjk) return false;
  return true;
}
/* 译文行：有译文（或错误）就挂在该思考块下方，点按钮后可反复看，不必再等一次请求 */
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
  row.appendChild(head);
  if (it.status !== "error") {
    const pre = document.createElement("pre");
    pre.innerHTML = plainTextToLinkHtml(String(it.text || ""));
    row.appendChild(pre);
  }
  return row;
}
/* 替换某一思考块下方的译文行（就地刷新，避免整表重绘丢失滚动位置） */
function dshThinkTranslatePaint(det, scopeId, segKey) {
  const row = det.parentNode ? det.nextElementSibling : null;
  const fresh = dshThinkTranslateRow(scopeId, segKey);
  if (row && row.classList && row.classList.contains("dsh-seg-xlate")) {
    if (fresh) row.replaceWith(fresh);
    else row.remove();
    return;
  }
  if (fresh) det.insertAdjacentElement("afterend", fresh);
}
/* 单段翻译送入的最大字符数：思考落盘上限是 12000（与 app-boot 的 reasoning 截断同口径），
   超了只翻前 12000 字并注明截断 —— 避免一段超长推理把翻译请求顶成巨量 token。 */
const DSH_XLATE_MAX = 12000;
async function dshTranslateThinking(btn, scopeId, segKey, text, sig) {
  const store = S.thinkTrans || (S.thinkTrans = {});
  const key = dshThinkTransKey(scopeId, segKey);
  const det = btn.parentNode;
  const paint = (it) => {
    if (!det || !det.parentNode) return;
    dshThinkTranslatePaint(det, scopeId, segKey);
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
        : I18n.t("用默认模型（优先 flash · 无思考）翻译这段思考");
  };
  if (!String(text || "").trim()) return;
  const cached = store[key];
  if (cached && cached.status === "done") {
    if (!det || !det.parentNode) return;
    dshThinkTranslatePaint(det, scopeId, segKey);
    return;
  }
  const pick = dshTranslateModel();
  const prov = dshTranslateProvider(pick.route);
  if (!prov) {
    toast(
      I18n.t("未找到可用文本服务商（请在设置 · API/配置中配置并填写 API Key）"),
      "err",
    );
    return;
  }
  if (!pick.model) {
    toast(I18n.t("未找到可用模型（请在设置中选择该服务商的模型）"), "err");
    return;
  }
  const it = {
    status: "pending",
    text: "",
    model: pick.model,
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
  const cands = dshTranslateCandidates(pick.route, pick.model);
  let lastErr = null;
  let lastOut = "";
  for (let i = 0; i < cands.length; i++) {
    if (store[key] !== it) return; /* 期间被替换（切会话 / 重跑）*/
    const c = cands[i];
    const spec = {
      provider: prov,
      kind: "text",
      model: c.model,
      temperature: c.strict ? 0 : 0.2,
      /* 无思考：off ⇒ thinking disabled（main.js applyTextThinkingEffort） */
      effort: "off",
      size: "",
      maxTokens: c.strict ? maxTok : Math.min(maxTok, 8192),
      prompt: c.strict
        ? "You are a translation engine. Translate the text between the markers into Simplified " +
          "Chinese (if it is already Chinese, translate it into English). Output ONLY the " +
          "translation: do not repeat or quote the source, do not explain, do not describe the " +
          "task, do not answer questions contained in the text, no code fences. Keep the " +
          "paragraph and list structure.\n\n【思考内容】\n" +
          body
        : "请把下面这段模型的思考过程忠实翻译成简体中文（若原文已是中文，则翻译成地道的英文）。" +
          "保持原有的分段与条目结构，术语按业界通用译法；只输出译文本身，不要添加解释、" +
          "不要复述原文、不要用代码块包裹。\n\n【思考内容】\n" +
          body,
      texts: [],
      images: [],
      refImage: "",
    };
    try {
      const r = await apiCallTextStream(spec, null, null);
      const out = String((r && r.text) || "").trim();
      if (!out) throw new Error(I18n.t("模型未返回译文"));
      /* 校验：模型常常把英文原文原样吐回来（或只回「以下是翻译：」）——
         这种必须重试，绝不能当成功缓存，否则用户看到「译文」仍是英文。 */
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
          String(c.model || "") + (i > 0 ? "（第 " + (i + 1) + " 次尝试）" : "");
      }
      break;
    } catch (e) {
      lastErr = e;
      /* 用户主动取消 / 请求被中止：不再往下试，直接落 error */
      const em = String((e && e.message) || e || "");
      if (/abort|cancel|取消|已终止/i.test(em)) break;
    }
  }
  if (store[key] === it && it.status !== "done") {
    it.status = "error";
    it.error =
      (lastErr && lastErr.message ? lastErr.message : String(lastErr || I18n.t("翻译失败"))) +
      (lastOut ? "｜模型仍返回原文，已重试 " + cands.length + " 次" : "");
  }
  if (store[key] === it) paint(it);
}
/* 思考段右侧小按钮。stopPropagation 必须齐：summary 内的点击会开合 details，
   键盘 Enter / Space 也会触发 toggle，所以 keydown 一并拦掉。 */
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
      : I18n.t("用默认模型（优先 flash · 无思考）翻译这段思考");
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
/* 思考块 + 折叠条【最右侧】一颗翻译小按钮 + 译文行。
   按钮直接挂在 <summary> 里（不另起一行）：折叠条本身就是一整行，按钮整行右端对齐；
   summary 变 flex、文案单独套 span（更新字数时只改这个 span，不会把按钮冲掉）。
   点按钮靠 dshThinkTranslateBtn 里的 stopPropagation 拦掉 toggle，不会顺带开合思考。 */
function dshThinkTranslateAppend(row, det, sum, text, scopeId, segKey, sig) {
  row.appendChild(det);
  if (sum) {
    sum.classList.add("dsh-think-bar");
    sum.dataset.xlateBtnKey = dshThinkTransKey(scopeId, segKey);
    sum.appendChild(
      dshThinkTranslateBtn(String(text || ""), scopeId, segKey, sig),
    );
  }
  const r = dshThinkTranslateRow(scopeId, segKey);
  if (r) row.appendChild(r);
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
function dshHistSegEl(seg, pool, nodeId, idx, n) {
  if (!seg || !seg.k) return null;
  if (seg.k === "think") {
    const txt = String(seg.text || "");
    if (!txt.trim()) return null;
    const det = document.createElement("details");
    det.className = "dsh-seg dsh-seg-think";
    const oKey =
      "segthink:" + (nodeId || "") + ":" + (idx == null ? "" : idx) + ":" + n;
    if (S.openDshTools && S.openDshTools[oKey]) det.open = true;
    det.addEventListener("mousedown", (ev) => ev.stopPropagation());
    det.addEventListener("click", (ev) => ev.stopPropagation());
    det.addEventListener("toggle", () => {
      S.openDshTools = S.openDshTools || {};
      if (det.open) S.openDshTools[oKey] = true;
      else delete S.openDshTools[oKey];
    });
    const sum = document.createElement("summary");
    /* 折叠条文案单独套一层 span：翻译按钮要坐在同一行最右侧，运行时刷新字数只改这层 */
    const sumTxt = document.createElement("span");
    sumTxt.className = "dsh-think-sum-txt";
    sumTxt.textContent = I18n.t("◉ 思考 · ") + txt.length + I18n.t(" 字");
    sum.title = I18n.t("点击展开 / 收起模型思考过程");
    sum.appendChild(sumTxt);
    const pre = document.createElement("pre");
    pre.innerHTML = plainTextToLinkHtml(txt);
    det.appendChild(sum);
    det.appendChild(pre);
    /* 思考块 + 折叠条最右侧「翻译」小按钮 + 译文行（一个整体，一次插进时间线） */
    const wrap = document.createElement("div");
    wrap.className = "dsh-seg dsh-seg-think-wrap";
    dshThinkTranslateAppend(wrap, det, sum, txt, nodeId, oKey, txt);
    return wrap;
  }
  if (seg.k === "say" || seg.k === "err") {
    let txt = String(seg.text || "");
    if (seg.k === "err") txt = "⚠ " + txt;
    if (!txt.trim()) return null;
    const d = document.createElement("div");
    d.className = "dsh-seg dsh-seg-say";
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = renderMarkdown(txt);
    d.appendChild(md);
    return d;
  }
  if (seg.k === "tool") {
    const at = dshSegToolAt(pool, seg);
    if (at < 0) return null;
    const t = pool.splice(at, 1)[0];
    const wrap = document.createElement("div");
    wrap.className = "dsh-seg dsh-seg-tool";
    const chips = document.createElement("div");
    chips.className = "dsh-tools";
    chips.appendChild(dshToolDetailsEl(t, false, nodeId));
    wrap.appendChild(chips);
    return wrap;
  }
  return null;
}
/* live 行：按轨迹段序输出（think → details 折叠 / say → 正文 / tool → chips / err → ⚠） */
function agentLiveSegsEl(row, st, live, items) {
  const tools = Array.isArray(st._liveTools) ? st._liveTools : [];
  const nodeId = live ? live.id : st.id;
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
      const txt = String(seg.text || "");
      if (!txt) continue;
      const det = document.createElement("details");
      det.className = "dsh-seg dsh-seg-think";
      /* 仍在增长的思考段挂上旧 id + 段序：重绘前的
         rememberAgentThinkScroll 与就地更新都按这两个信息找到它 */
      if (streaming) {
        det.id = "agent-think";
        det.dataset.segIdx = String(i);
      }
      const oKey = "segthink:" + (st.id || "") + ":" + i;
      const sum = document.createElement("summary");
      const sumTxt = document.createElement("span");
      sumTxt.className = "dsh-think-sum-txt";
      sumTxt.textContent = I18n.t("◉ 思考 · ") + txt.length + I18n.t(" 字");
      sum.title = I18n.t("点击展开 / 收起模型思考过程");
      sum.appendChild(sumTxt);
      const pre = document.createElement("pre");
      if (streaming) {
        pre.id = "agent-think-body";
        bindAgentThinkScroll(st, pre);
      }
      det.appendChild(sum);
      det.appendChild(pre);
      /* 先挂监听再程序设 open（toggle 异步派发），沿用现有滚动跟随逻辑 */
      det.addEventListener("toggle", () => {
        S.openDshTools = S.openDshTools || {};
        if (det.open) S.openDshTools[oKey] = true;
        else delete S.openDshTools[oKey];
        if (!det.open) return;
        pre.textContent = String(seg.text || "");
        applyAgentThinkScroll(
          st,
          pre,
          streaming && !det._progToggle && agentThinkStickOf(st),
        );
      });
      if (S.openDshTools && S.openDshTools[oKey]) {
        det._progToggle = true;
        det.open = true;
        if (typeof requestAnimationFrame === "function")
          requestAnimationFrame(() => {
            det._progToggle = false;
          });
        else det._progToggle = false;
      }
      /* 已经定稿的思考段：块 + 折叠条最右侧「翻译」小按钮 + 译文行。
         正在增长的那段先不挂按钮 —— 译文要对整段思考负责，翻译一段还会继续变长的
         文字，用户下次重绘就会看到译文与原文对不上；等这段定稿（后一步的思考段或
         本轮收尾重绘）按钮自动出现。按钮在折叠条里，收起时按钮与译文都还在。 */
      const box = document.createElement("div");
      box.className = "dsh-seg dsh-seg-think-wrap";
      if (streaming) box.appendChild(det);
      else dshThinkTranslateAppend(box, det, sum, txt, st.id, oKey, txt);
      row.appendChild(box);
    } else if (seg.k === "say" || seg.k === "err") {
      const d = document.createElement("div");
      d.className = "dsh-seg dsh-seg-say";
      if (streaming) {
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
      row.appendChild(d);
    } else if (seg.k === "tool") {
      const t = tools.find((x) =>
        seg.callId
          ? String(x.callId) === String(seg.callId)
          : seg.step != null && x.step != null && x.step === seg.step,
      );
      if (!t) continue;
      const wrap = document.createElement("div");
      wrap.className = "dsh-seg dsh-seg-tool";
      const chips = document.createElement("div");
      chips.className = "dsh-tools";
      chips.appendChild(dshToolDetailsEl(t, true, nodeId));
      wrap.appendChild(chips);
      row.appendChild(wrap);
    }
  }
}
/* 流式事件就地更新的公共判定：目标段还是不是尾段、DOM 元素对不对得上段序，
   对不上（刚从别的段类型切换过来）→ 整表重绘一次，之后继续在原地追加 */
function agentLiveSegTail(items, el, kind) {
  if (!items || !items.length || !el) return null;
  const last = items[items.length - 1];
  if (!last || last.k !== kind) return null;
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
    const det = document.getElementById("agent-think");
    if (
      !seg ||
      seg.k !== "think" ||
      !det ||
      Number(det.dataset.segIdx) !== idx
    ) {
      try {
        renderAgentSession();
      } catch (_) {}
      return;
    }
    const txt = String(seg.text || "");
    const sum = det && det.querySelector("summary");
    /* 只改折叠条里的文案 span：整条 textContent 会被冲掉（那里面还有翻译按钮） */
    if (sum) {
      const sumTxt =
        sum.querySelector(".dsh-think-sum-txt") || sum.firstElementChild;
      const label = I18n.t("◉ 思考 · ") + txt.length + I18n.t(" 字");
      if (sumTxt && sumTxt.tagName !== "BUTTON") sumTxt.textContent = label;
      else sum.textContent = label;
    }
    if (det && det.open) {
      const pre = document.getElementById("agent-think-body");
      if (pre) {
        pre.textContent = txt;
        applyAgentThinkScroll(st, pre, false);
      }
    }
  });
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

function dshMsgBlock(m, nodeId, idx, opts) {
  const row = document.createElement("div");
  row.className = "dsh-msg" + (m.role === "user" ? " dsh-user" : " dsh-ai");
  if (idx != null) row.dataset.histKey = histMsgKey(nodeId || "chat", idx, m);
  /* 有分段轨迹（且正文拼接与 content 一致）就按段渲染，否则走旧渲染 */
  const segsView = dshMsgSegsViewable(m);
  const head = document.createElement("div");
  head.className = "dsh-msg-head";
  const role = document.createElement("span");
  role.className = "dsh-role";
  role.textContent = m.role === "user" ? I18n.t("你") : "AI";
  head.appendChild(role);
  /* 旧渲染（无分段轨迹）的思考块：head 之后单独一行，见下方 row.appendChild */
  let thinkBoxEl = null;
  if (
    m.role === "assistant" &&
    !segsView &&
    m.reasoning &&
    String(m.reasoning).trim()
  ) {
    const det = document.createElement("details");
    det.className = "dsh-think";
    const rKey = "think:" + (nodeId || "") + ":" + String(m.content || "").slice(0, 40);
    if (S.openDshTools && S.openDshTools[rKey]) det.open = true;
    det.addEventListener("mousedown", (ev) => ev.stopPropagation());
    det.addEventListener("click", (ev) => ev.stopPropagation());
    det.addEventListener("toggle", () => {
      S.openDshTools = S.openDshTools || {};
      if (det.open) S.openDshTools[rKey] = true;
      else delete S.openDshTools[rKey];
    });
    const sum = document.createElement("summary");
    const sumTxt = document.createElement("span");
    sumTxt.className = "dsh-think-sum-txt";
    sumTxt.textContent =
      I18n.t("思考过程 · ") + String(m.reasoning).length + I18n.t(" 字");
    sum.title = I18n.t("点击展开 / 收起模型思考过程");
    sum.appendChild(sumTxt);
    const pre = document.createElement("pre");
    pre.innerHTML = plainTextToLinkHtml(m.reasoning);
    det.appendChild(sum);
    det.appendChild(pre);
    /* 思考块 + 折叠条最右侧「翻译」小按钮 + 译文行（无分段轨迹的老消息也能翻）。
       不塞进 .dsh-msg-head（那是一行 flex role + 折叠条），改挂在 head 之后 */
    const thinkBox = document.createElement("div");
    thinkBox.className = "dsh-seg dsh-seg-think-wrap dsh-think-head";
    dshThinkTranslateAppend(
      thinkBox,
      det,
      sum,
      m.reasoning,
      nodeId,
      rKey,
      m.reasoning,
    );
    thinkBoxEl = thinkBox;
  }
  /* 用户消息的复制按钮留在头部；AI 回复的复制按钮放在尾部与时间同行（仅复制该条回复） */
  if (m.role === "user") head.appendChild(dshCopyBtn(m, "dsh-msg-copy"));
  row.appendChild(head);
  if (thinkBoxEl) row.appendChild(thinkBoxEl);
  if (segsView) {
    /* 时间线：思考 / 正文 / 工具按段序就近插入（工具段从 m.tools 里取对应条目） */
    const body = document.createElement("div");
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
    for (let n = from; n < m.segments.length; n++) {
      const el = dshHistSegEl(m.segments[n], pool, nodeId, idx, n);
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
      for (const t of m.tools)
        chips.appendChild(dshToolDetailsEl(t, false, nodeId));
      row.appendChild(chips);
    }
    const body = document.createElement("div");
    body.className = "dsh-msg-body";
    if (m.role === "user") body.innerHTML = plainTextToLinkHtml(m.content);
    else
      body.innerHTML =
        '<div class="md">' + renderMarkdown(m.content) + "</div>";
    row.appendChild(body);
  }
  /* 消息末尾：AI 回复带「复制本条回复」小按钮（与时间同行）；用户消息带回滚轮次时，前面加一个小「回滚」按钮 */
  const rbRid = opts && opts.showRollback ? rbLatestRid(m) : "";
  const endTxt = formatMsgTimeSec(m.at || m.createdAt || m.ts);
  if (rbRid || endTxt || m.role === "assistant") {
    const tail = document.createElement("div");
    tail.className = "dsh-msg-tail";
    if (rbRid) {
      const rbBtn = document.createElement("button");
      rbBtn.type = "button";
      rbBtn.className = "dsh-msg-rollback";
      rbBtn.textContent = I18n.t("↶ 回滚");
      rbBtn.title = I18n.t("撤销上一轮的全部更改");
      rbBtn.addEventListener("mousedown", (ev) => ev.stopPropagation());
      rbBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        rbAskRollback(m, nodeId);
      });
      tail.appendChild(rbBtn);
    }
    if (m.role === "assistant")
      tail.appendChild(dshCopyBtn(m, "dsh-msg-tail-copy"));
    if (endTxt) {
      const tEl = document.createElement("span");
      tEl.className = "dsh-msg-time";
      tEl.textContent = endTxt;
      tEl.title = formatMsgStamp(m.at || m.createdAt || m.ts);
      tail.appendChild(tEl);
    }
    row.appendChild(tail);
  }
  return row;
}

/* ── 回滚入口：上一轮用户输入下方的「回滚」小按钮 → 确认弹窗 → 还原 ── */

/** 弹窗里「本次更改的内容」清单：文件逐条 + 画布 / 计划 / 事实库计数。 */
function rbRoundChangeItems(round) {
  const items = [];
  const verb = {
    modify: I18n.t("修改"),
    create: I18n.t("新增"),
    delete: I18n.t("删除"),
  };
  const files = Array.isArray(round.files) ? round.files : [];
  for (const f of files) {
    const rel = String(f.rel || f.path || "");
    items.push((verb[f.kind] || I18n.t("修改")) + " " + rel);
  }
  const canvas = Array.isArray(round.canvas) ? round.canvas : [];
  for (const c of canvas) {
    const t = (c && c.touched) || {};
    const parts = [];
    if ((t.nodeIds || []).length) parts.push(I18n.t("节点") + "×" + t.nodeIds.length);
    if ((t.wireIds || []).length) parts.push(I18n.t("连线") + "×" + t.wireIds.length);
    if ((t.markIds || []).length) parts.push(I18n.t("标注") + "×" + t.markIds.length);
    if ((t.groupIds || []).length) parts.push(I18n.t("分组") + "×" + t.groupIds.length);
    items.push(
      I18n.t("画布改动：") +
        (parts.join("、") || I18n.t("（未逐条记录）")) +
        I18n.t("（需人工处理）"),
    );
  }
  if (typeof rbPlanChanged === "function" && rbPlanChanged(round))
    items.push(I18n.t("计划清单变更（需人工处理）"));
  const db = Array.isArray(round.db) ? round.db : [];
  if (db.length) items.push(I18n.t("事实库改动 ") + db.length + I18n.t(" 条（需人工处理）"));
  if (!items.length) items.push(I18n.t("（本轮无可自动列举的具体条目）"));
  return items;
}

/** 弹窗警示：账本覆盖不到的部分（命令调用 / 记录不完整等）。 */
function rbRoundWarnings(round) {
  const u = (round && round.untracked) || {};
  const w = [];
  if ((Number(u.shellCalls) || 0) > 0)
    w.push(
      I18n.t("有 ") + u.shellCalls + I18n.t(" 次命令调用可能改了文件，账本无法覆盖，请自查"),
    );
  if (u.dbCapped) w.push(I18n.t("事实库改动超过逐条记账上限，无法逐条回退"));
  if ((Number(round && round.dropped) || 0) > 0 || (round && round.status === "partial"))
    w.push(I18n.t("该轮记录不完整，还原可能不完整"));
  return w;
}

/** 回滚入口点击：先确认（说明 + 本轮更改清单），确认后执行还原并汇报结果。 */
async function rbAskRollback(m, nodeId) {
  try {
    const rid = rbLatestRid(m);
    if (!rid) return;
    const sessionId = rbSessionIdForMsg(nodeId);
    const runKey = nodeId === "assist" ? "assist" : "agent:" + String(nodeId);
    if (typeof rbActiveRid === "function" && rbActiveRid(runKey) === rid) {
      toast(I18n.t("该轮仍在运行中，结束后才能回滚"), "warn");
      return;
    }
    const round = await rbGetRound(sessionId, rid);
    if (!round) {
      toast(I18n.t("该轮没有可回滚的账本"), "warn");
      return;
    }
    if (round.restoredAt) {
      toast(I18n.t("该轮已回滚过，不能重复回滚"), "warn");
      return;
    }
    const items = rbRoundChangeItems(round);
    const warned = rbRoundWarnings(round);
    const dlg = await mtDialogForm({
      title: I18n.t("确认回滚"),
      wide: true,
      rows: [
        [I18n.t("时间"), formatMsgStamp(round.startedAt || round.ts)],
        [I18n.t("工作区"), round.workspace || I18n.t("（未记录）")],
      ],
      list: { label: I18n.t("本次更改的内容") + "（" + items.length + "）", items },
      msg: I18n.t("回滚将撤销此轮次的所有更改，且不可撤销。确认继续？"),
      warn: warned.length ? warned.join("\n") : "",
      actions: [
        { id: "cancel", label: I18n.t("取消") },
        { id: "rollback", label: I18n.t("确认回滚"), primary: true, danger: true },
      ],
    });
    if (!dlg || dlg.action !== "rollback") return;
    const res = await rbRestoreRound(sessionId, rid);
    if (!res.ok && res.error) {
      toast(res.error, "err");
      return;
    }
    /* 结果汇报：还原 / 删除 / 跳过 / 失败 / 待人工处理 / 账本警示 */
    const parts = [];
    if (res.restored.length)
      parts.push(I18n.t("已还原 ") + res.restored.length + I18n.t(" 个文件"));
    if (res.deleted.length)
      parts.push(I18n.t("已删除 ") + res.deleted.length + I18n.t(" 个本轮新建文件"));
    if (res.skipped.length) {
      const first = res.skipped
        .slice(0, 3)
        .map((s) => s.path)
        .join("、");
      parts.push(
        I18n.t("跳过 ") +
          res.skipped.length +
          I18n.t(" 项（") +
          first +
          (res.skipped.length > 3 ? "…" : "") +
          "）",
      );
    }
    if (res.errors.length)
      parts.push(I18n.t("失败 ") + res.errors.length + I18n.t(" 项"));
    if (res.pending.length)
      parts.push(I18n.t("需人工处理：") + res.pending.join("、"));
    if (res.warnings.length) parts.push(res.warnings.join("；"));
    const summary = parts.length
      ? parts.join("；")
      : I18n.t("本轮没有可回退的文件改动");
    if (res.complete) {
      /* 完整回滚：账本标已回滚 + 该轮消息摘出上下文（不再进入后续对话） */
      await rbMarkRoundRestored(sessionId, res.round, Date.now());
      let dropped = 0;
      if (nodeId === "assist") {
        dropped = rbDropRoundMessages(S.assistMessages || [], rid);
        persistAssistUi();
        renderAssistPanel({ forceStick: true });
      } else {
        const st = agentSessionById(String(nodeId));
        if (st) {
          dropped = rbDropRoundMessages(st.messages || [], rid);
          await persistAgentSession();
          if (S.agentActiveId === st.id) renderAgentSession({ forceStick: true });
          else renderAgentSessionSidebar();
        }
      }
      toast(
        I18n.t("已回滚该轮：") +
          summary +
          (dropped ? I18n.t("（") + dropped + I18n.t(" 条消息已移出上下文）") : ""),
        "ok",
      );
    } else {
      /* 部分完成：不标 restoredAt、不摘消息（上下文须如实反映现状）；
         文件部分幂等，可稍后重试。 */
      toast(I18n.t("回滚未完全完成：") + summary, "warn");
    }
  } catch (e) {
    toast(I18n.t("回滚失败：") + ((e && e.message) || String(e)), "err");
  }
}

/* ── 会话条目窗口：每个会话最多同时渲染 AGENT_MAX_VISIBLE_ITEMS 条，更早的靠手动
      「显示更早内容」展开（+AGENT_LOAD_MORE_ITEMS / 次）────────────────────
   为什么按「条目」而不按「轮」：一轮任务可能吐出上百个思考 / 工具段（长任务里很常见），
   整表重绘时每个段都是一次 DOM 构建（思考段还带 markdown / 译文），内容或思考一多就把
   窗口卡死 —— 而按轮算时这些段全都算在「最近 10 轮」里，一轮就能塞满整张列表。
   条目口径 = 真正落进 DOM 的时间线块：
     · 能按段渲染的消息（dshMsgSegsViewable）→ 每个段一条（思考 / 正文 / 工具）；
     · 其余消息（用户消息、退回整条渲染的老消息）→ 整条算一条。
   只影响渲染，不动 st.messages 本身：上下文、存档、回滚口径一个字节都不变。 */
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
function renderAgentSession(opts) {
  const st = agentSessionState();
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
  /* 整表重绘会销毁旧的 details/pre（工具事件也会走到这里）：清空前先把
     思考区的阅读位置与跟随状态存到 S（按会话 id 隔离），重建后再还原 */
  if (!switched)
    rememberAgentThinkScroll(st, document.getElementById("agent-think-body"));
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
  /* 回滚入口挂在每条挂有回滚轮次的用户消息上（仅限可见列表内、且会话不在运行中） */
  for (let i = slice.start; i < slice.msgs.length; i++) {
    const m = slice.msgs[i];
    try {
      list.appendChild(
        dshMsgBlock(m, st.id || "agent", i, {
          showRollback:
            !running &&
            !m._rolledBack &&
            typeof rbHasMsgRound === "function" &&
            rbHasMsgRound(m),
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
      /* 分段轨迹：思考 / 正文 / 工具 / 错误按发生顺序逐段插进时间线 */
      row.dataset.seg = "1";
      agentLiveSegsEl(row, st, live, segItems);
    } else {
      const think = document.createElement("details");
      think.className = "dsh-think-live";
      think.id = "agent-think";
      const thinkSum = document.createElement("summary");
      thinkSum.textContent =
        I18n.t("思考过程 · ") +
        "0" +
        I18n.t(" 字") +
        I18n.t(" · 点击查看");
      thinkSum.title = I18n.t("点击展开 / 收起模型思考过程");
      const thinkPre = document.createElement("pre");
      thinkPre.id = "agent-think-body";
      bindAgentThinkScroll(st, thinkPre);
      think.appendChild(thinkSum);
      think.appendChild(thinkPre);
      /* 先挂监听：程序设 open 同样会派发 toggle（异步排队），
         用一次性标记 _progToggle 把它和用户真实点击区分开 */
      think.addEventListener("toggle", () => {
        S._agentThinkOpen = !!think.open;
        if (!think.open) return;
        thinkPre.textContent = agentThinkText(st, live);
        /* 重建（工具事件触发整表重绘）只还原上次阅读位置，不跳底；
           只有用户真实点击展开且本就贴底时才定位到底 */
        applyAgentThinkScroll(
          st,
          thinkPre,
          !think._progToggle && agentThinkStickOf(st),
        );
      });
      think._progToggle = true;
      think.open = !!S._agentThinkOpen;
      if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(() => {
          think._progToggle = false;
        });
      else think._progToggle = false;
      row.appendChild(think);
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
  /* 会话末尾：Token 消耗累计报告 Badge（点击展开，按模型分别累计） */
  if (typeof tokBadgeEl === "function") {
    try {
      const badge = tokBadgeEl(st);
      if (badge) list.appendChild(badge);
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
    /* 消息栏草稿按会话隔离:切换会话时保存上一个会话的输入,载入当前会话的草稿 */
    const prevId = S._agentRenderedSessionId;
    if (prevId && prevId !== st.id) {
      const prev = agentSessions().find((x) => x.id === prevId);
      if (prev) prev._draft = inp.value;
    }
    if (prevId !== st.id) {
      inp.value = st._draft || "";
      S._agentRenderedSessionId = st.id;
    }
    inp.placeholder = chatEnterSend
      ? I18n.t("描述任务…（Enter 发送，Shift+Enter 换行；输入 / 呼出技能与命令）")
      : I18n.t("描述任务…（Enter 换行，Ctrl+Enter 发送；输入 / 呼出技能与命令）");
  }
  const presetSel = $("#agentPresetSel");
  if (presetSel) presetSel.value = st.preset || AGENT_PRESET_DEFAULT;
  const provSel = $("#agentProvSel");
  const modelSel = $("#agentModelSel");
  if (provSel && modelSel) {
    const catalog = S.providerCatalog || {
      deepseek: [
        { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", input: ["text"] },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
        {
          id: "deepseek-v4-flash-vision-exp",
          name: "DeepSeek-V4-Flash-Vision-Exp",
          input: ["text", "image"],
        },
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
    /* 供应商用各自名称(DeepSeek 官方路由显示为配置的 DeepSeek 服务商名称) */
    const mtnode = mtnodePiProviders();
    const dp = dshProvider();
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
      const cur = st.model || (items[0] && items[0].id) || "deepseek-v4-flash";
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
  const ctx = $("#agentCtx");
  if (ctx) {
    if (st.metrics && st.metrics.contextWindow > 0) {
      const used = (st.metrics.inputTokens || 0) + (st.metrics.outputTokens || 0);
      ctx.textContent =
        I18n.t("上下文 ") + fmtTok(used) + " / " + fmtTok(st.metrics.contextWindow) + " tok";
      ctx.title =
        I18n.t("最近一次运行的输入 ") + fmtTok(st.metrics.inputTokens) + I18n.t(" tok · 输出 ") + fmtTok(st.metrics.outputTokens) + " tok";
    } else {
      ctx.textContent = "";
    }
  }
  /* 发送按钮:空闲「发送」；运行中且有输入 → 「排队发送 ↑」；运行中且输入为空 → 红色「终止 ■」 */
  paintAgentSendState();
  renderAgentQueueBar(st);
  renderAgentTodoPanel(st);
  /* 「计划」面板：只吃当前这个 st（切会话时重绘，不残留上一会话的清单） */
  try {
    if (typeof renderAgentPlanPanel === "function") renderAgentPlanPanel(st);
  } catch (_) {}
  renderAgentComposer();
  renderAgentSessionSidebar();
  renderSessionFooterStat();
}

/* 运行中不取消任务：输入框有字就是「加入队列」，没字才是「终止」 */
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
  const active = activeAgentId();
  const list = agentSessions();
  const activeSt = list.find((s) => s.id === active);
  /* 只写会话视图自己的容器 #agentSideList。
     历史遗留 bug：以前同时写入画布边栏 #sideTree，会话每次运行 / 每个工具事件
     都会重绘它 → 用户在画布上会「突然」看到左侧栏变成会话列表。
     规则：画布边栏只放节点/绘图/超级节点；会话列表只在会话视图内。 */
  const targets = [];
  const t2 = $("#agentSideList");
  if (t2)
    targets.push({
      el: t2,
      filter: $("#agentSideFilter") ? $("#agentSideFilter").value.trim().toLowerCase() : "",
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
    if (wfEl) row.appendChild(wfEl);
    row.appendChild(tm);
    row.appendChild(btns);
    row.onclick = async () => {
      S.agentActiveId = s.id;
      await persistAgentSession();
      renderAgentSession();
      renderAgentSessionSidebar();
    };
    return row;
  };

  for (const target of targets) {
    const tree = target.el;
    const f = target.filter;
    tree.innerHTML = "";
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
  const box = $("#agentSideList");
  if (!box) return;
  const nodes = box.querySelectorAll(".side-sess-time[data-ts]");
  for (const el of nodes) {
    const txt = formatRelTime(Number(el.dataset.ts) || 0);
    if (el.textContent !== txt) el.textContent = txt;
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
  /* 已回滚轮次的消息不参与压缩：它们已不在上下文里，摘要也不该复述它们 */
  const rbSrc =
    typeof rbActiveMessages === "function" ? rbActiveMessages(st.messages) : st.messages;
  const hist = rbSrc
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
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
  if (S.agentActiveId === st.id) {
    renderAgentQueueBar(st);
    $("#agentInput") && $("#agentInput").focus();
  } else renderAgentSessionSidebar();
  /* 入队 = 这条会话的运行态可能刚被延后（跑完还要接下一轮）：队列同步一次 */
  updateRunQueuePanel();
  toast(I18n.t("已加入发送队列，当前任务继续执行"), "ok");
}

/* 删除一条 / 清空整个队列 */
async function agentRemoveQueued(st, id) {
  if (!st || !Array.isArray(st.outbox)) return;
  st.outbox = st.outbox.filter((x) => x.id !== id);
  await persistAgentSession();
  if (S.agentActiveId === st.id) renderAgentQueueBar(st);
}
async function agentClearQueue(st) {
  if (!st || !Array.isArray(st.outbox) || !st.outbox.length) return;
  st.outbox = [];
  await persistAgentSession();
  if (S.agentActiveId === st.id) renderAgentQueueBar(st);
}

/* 队首出队发送：本轮彻底结束后调用（会话空闲才发，避免自己挤自己）。
   队列里可能混着 /new、/plan 这类不启动运行的命令 —— 它们同步处理完就继续放行下一条。
   _draining 闩锁：收尾处与 await 返回后可能同时想排水，必须串行，否则两条消息并发抢同一会话。 */
async function agentDrainQueue(st) {
  try {
    if (!st || !Array.isArray(st.outbox) || !st.outbox.length) return;
    if (st._draining || sessionIsRunning(st)) return;
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
        if (S.agentActiveId === st.id) renderAgentQueueBar(st);
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
function renderAgentQueueBar(st) {
  const el = document.getElementById("agentQueue");
  if (!el) return;
  const list = (st && Array.isArray(st.outbox) ? st.outbox : []).filter(Boolean);
  if (!list.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = "";
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
  el.appendChild(head);
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
  el.appendChild(rows);
}

/* ============ 会话任务清单（Todo：agent 用 todo_write 建立） ============ */

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
function agentApplyTodoWrite(st, args) {
  const p = agentTodoArgs(args);
  const list = p && Array.isArray(p.todos) ? p.todos : null;
  if (!list) return false;
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
  if (S.agentActiveId === st.id) renderAgentTodoPanel(st);
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
  if (S.agentActiveId === st.id) renderAgentTodoPanel(st);
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
    ic.className = "at-icon";
    ic.textContent = TODO_ICON[t.status] || TODO_ICON.pending;
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
  /* 开发 / 细化绑定会话：任务书整份在会话契约 _devContract（发送时注入系统提示），
     首条 _src:"dev-node" 消息只有用户关键输入（本次开发需求 / 细化范围）；
     这里只读它作为最新用户消息，不再追加第二条 */
  const devContractMsg = !!opts._devContract;
  let t = String(text || "").trim();
  if (devContractMsg) {
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
          I18n.t("。可选:mtnode-unattended(无人值守) / workspace-write(读写·审批) / read-only(只读·审批) / danger-full-access(完全放行)。在 设置 → 智能能力 中切换。"),
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
  let rbAnchor = null;
  if (!devContractMsg) {
    const um = { role: "user", content: t, at: Date.now() };
    if (planExecMsg) um._src = "plan-exec";
    else if (opts._planFix) um._src = "plan-fix";
    st.messages.push(um);
    rbAnchor = um;
    if (st.messages.filter((m) => m.role === "user").length === 1) {
      /* 回落命名（首条消息前 24 字）同样不得覆盖用户亲口改的名 */
      if (!st.titleLocked)
        st.title = t.slice(0, 24) + (t.length > 24 ? "…" : "");
    }
  } else {
    /* 开发 / 细化绑定会话：开轮锚点就是那条任务书消息 */
    rbAnchor =
      (st.messages || []).find(
        (m) => m && m.role === "user" && m._src === "dev-node",
      ) || null;
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
  if (st.messages.length > 100) st.messages.splice(0, st.messages.length - 100);
  /* 新的一轮开始：显示窗口回到默认最近 200 条，更早的可从最前端重新「显示更早内容」 */
  st._visItems = undefined;
  st.running = true;
  st._pending = "";
  st._liveTools = [];
  /* 会话开始：开发节点「绑定会话运行中」即时反映到左下角运行队列 */
  updateRunQueuePanel();
  /* 任务清单不在新一轮开始时清空：它代表「agent 建的当前清单」，
     由下一次 todo_write 覆盖，或用户在面板上手动清除 */
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
  if (S.agentActiveId === st.id) renderAgentSession({ forceStick: true });
  else renderAgentSessionSidebar();
  /* 已回滚轮次的消息不进上下文（rbActiveMessages 无标记时直接复用原数组，不复制） */
  const rbHistSrc =
    typeof rbActiveMessages === "function" ? rbActiveMessages(st.messages) : st.messages;
  const hist = rbHistSrc
    .slice(0, -1)
    .slice(-20)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  /* 「任务流程」指令：会话里已有未跑完的计划时注入的是「沿用 / 续跑」那段，
     而不是逼模型再规划一份新的（新旧计划互相覆盖 · 已执行项被重跑） */
  let flowText = "";
  try {
    if (typeof planFlowInjectText === "function")
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
  let input = hist ? hist + "\n\n用户(最新)：" + latest : latest;
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
     · "none"   用户声明「与画布无关」（st.canvasFree · Gate B）—— 三件套全不注册
   裁掉工具就必须同时裁掉「动手前先 mtnode_canvas_get 看清现状」这句指令和画布类技能名
   （同档位的技能索引也已经裁了），否则模型会去调不存在的工具、白白浪费一整步。 */
  const canvasPersona = pureMode
    ? ""
    : st.canvasFree
      ? "none"
      : st.noCanvasRead
        ? "noRead"
        : "";
  const assistAutoApprove = !!(S.config && S.config.dsh && S.config.dsh.assistAutoApprove);
  let systemPrompt = "";
  if (!pureMode) {
    if (canvasPersona === "none") {
      systemPrompt =
        "你是 MTNode 里的通用会话助手。本会话已声明「与画布无关」：不注册任何画布与应用工具（mtnode_canvas_get / mtnode_canvas_edit / mtnode_app 都不可用），你只读写文件、联网、执行命令。\n" +
        "本轮不要承诺任何画布改动，也不要臆造节点或画布现状；确实需要改画布时，请让用户先关掉输入区的「与画布无关」开关再重跑。\n" +
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
        "改画布纪律：动手前先 mtnode_canvas_get 看清现状；节点字段、端子与 alias 的口径以 mtnode_canvas_edit / canvas_get 的工具说明为唯一真源，跨超级节点接线用 superConnect。\n" +
        "引用画布内容纪律：为某个节点写 prompt/task 而要用画布上别的节点的内容时，一律在 prompt/task 里写 @标题（连线源；全局广播须同时满足三条件），不要把那个节点的正文复制粘贴进去；素材节点本身不是 @ 候选，写 @内容条目标题只引那一条、且只有已连线接进本节点的端子可引；@引用的三条件与语法见技能 mtnode-canvas-edit-rules。\n" +
        "要建开发节点、批次 / 文生图链、连线 / 建图、整理排版或接数据库副本时，先用 skill 工具加载对应内置技能（mtnode-canvas-edit-rules / mtnode-dev-architect / mtnode-canvas-batch-safety / mtnode-canvas-layout-ux / mtnode-media-gen-nodes / mtnode-db-facts）再动手；工具回执里没有的结果不要声称已完成。\n" +
        "回答简洁（交流语言见文末「语言口味」），不要编造不存在的节点或画布。";
    }
  }
  /* 开发 / 细化绑定会话：任务书是会话契约，临时写入系统提示（不占用户消息位，
     会话里只显示用户填写的关键输入；后续追问也持续携带该契约） */
  const devContract = String(st._devContract || "").trim();
  if (devContract && !pureMode) {
    systemPrompt +=
      "\n\n【开发任务书 · 本会话模块契约（非用户消息，无需回复该段）】\n" +
      devContract +
      "\n【任务书结束】";
  }
  try {
    const final = await dshRunTask(input, {
      runKey: "agent:" + st.id,
      /* Token 台账逐轮明细的标题：调用方（如计划执行器）给的计划任务标题优先，
         缺省由 dshRunTask 用输入文本前 24 字回落 */
      tokTitle: opts.tokTitle || undefined,
      /* 本轮开轮消息 + 摘要：回滚账本把稳定 rid 盖在这条消息上，并按会话建目录 */
      rollbackAnchor: rbAnchor,
      rollbackLabel: t.slice(0, 160),
      planMode,
      /* 生效工作区（st.workspace 手填优先 > 画布项目根 > 默认）：与展示层同源 */
      workspace: agentRunWorkspace(st),
      preset: st.preset || AGENT_PRESET_DEFAULT,
      provider: (opts.provider || st.provider || "deepseek-official"),
      model: (opts.model || st.model || undefined),
      effort: st.effort || "high",
      systemPrompt,
      pure: pureMode,
      /* Gate A：开发绑定会话不注册读画布工具（判据与落盘同源，见 createDevSessionForNode）。
         dshRunTask 的 baseOpts 原样透传到 dshRunOnce，这一位随每次开轮重新生效，
         轮内不变 → 同一档每步前缀一致。 */
      noCanvasRead: !!st.noCanvasRead,
      /* Gate B：用户声明「与画布无关」→ 走 MTNODE_NO_CANVAS 整档闸（canvas_get / edit /
         app 三件套整个不注册，约 26.0K 字符/步）。人设同步换成无画布版（见上方
         canvasPersona === "none" 分支），两侧判据同源于 st.canvasFree。 */
      noCanvas: !!st.canvasFree,
      onEvent: (type, data) => {
        /* 并行会话:仅当本会话正是当前查看的会话时才更新共享视图,避免后台会话
           重绘/滚动打扰用户正在看的其他会话 */
        const mine = S.agentActiveId === st.id;
        /* 出错自动重发（dshRunTask 触发 retry）：看 resumed 决定清不清残文 ——
           · resumed=true（续写）：新内容接在同一条逻辑轮次后面，已显示的部分正文 /
             工具列表 / 用量与思考槽一律保留，别把已经说出去的话抹掉；
           · resumed=false（整轮重发）：先清上一轮的部分正文 / 工具 / 用量与思考槽，
             重发那一轮从零流式不叠字；等待窗口内会话仍算「在跑」 */
        if (type === "retry") {
          if (data && data.resumed) return;
          st._pending = "";
          st._liveTools = [];
          st._usageLive = null;
          if (S.thinking) delete S.thinking["agent:" + st.id];
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
          if (mine) renderAgentSession();
        } else if (type === "tool-result" && data.callId) {
          st._liveTools = st._liveTools || [];
          const t = st._liveTools.find((x) => x.callId === data.callId);
          if (t) {
            t.result = Array.isArray(data.content) ? data.content : [];
            t.error = data.error || null;
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
          if (mine) renderSessionFooterStat();
        } else if (type === "text" && data.text) {
          st._pending = (st._pending || "") + data.text;
          if (mine) {
            const el = document.getElementById("agent-stream");
            const items = agentChatSegItems(st);
            const seg = items
              ? agentLiveSegTail(items, el, "say")
              : null;
            if (seg) el.textContent = String(seg.text || "");
            else if (items || !el) {
              /* 分段模式（含尾段切换 / 首次成段）→ 整表重绘一次对齐 DOM；
                 items 刚消失（run 收尾竞态）且无流式元素时也要重绘回旧块 */
              try {
                renderAgentSession();
              } catch (_) {}
            } else el.textContent = st._pending;
            scrollElToBottomIfStuck($("#agentList"));
          }
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
            } else if (el) el.textContent = st._pending;
            scrollElToBottomIfStuck($("#agentList"));
          }
        }
      },
      onDone: (d) => {
        recordDshMetrics(null, d.metrics);
        st.metrics = d.metrics || null;
        st._usageLive = null;
      },
    });
    if (st._cancelled) {
      st._roundOutcome = "cancelled";
      const body = stripStreamErrors(st._pending);
      st.messages.push({
        role: "assistant",
        content: body || I18n.t("（已终止）"),
        at: Date.now(),
      });
    } else {
      /* 收尾消息：正文 = say 段按 \n\n 连接（err 段以「⚠ 」附尾，与流式口径一致），
         无段可拼时回退 final / 累加文本 /（无输出），保证不丢字；
         reasoning = 纯 think 段连接（不含 🔧 / ⚠）；segments 限长随消息落盘 */
      const rk = "agent:" + st.id;
      const traceBody =
        typeof traceSayDisplay === "function"
          ? String(traceSayDisplay(rk, "") || "")
          : "";
      const msg = {
        role: "assistant",
        content: traceBody || final || st._pending || I18n.t("（无输出）"),
        at: Date.now(),
      };
      const rsnLegacy =
        (S.thinking && S.thinking[rk] && S.thinking[rk][0]) || "";
      const rsn =
        typeof traceThinkDisplay === "function"
          ? traceThinkDisplay(rk, rsnLegacy)
          : rsnLegacy;
      if (String(rsn).trim()) msg.reasoning = rsn;
      if (Array.isArray(st._liveTools) && st._liveTools.length)
        msg.tools = st._liveTools.slice();
      try {
        const segs = agentSegsForDisk(
          typeof traceSegmentsOf === "function"
            ? traceSegmentsOf(rk)
            : null,
        );
        if (segs && segs.length) msg.segments = segs;
      } catch (_) {}
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
        if (S.agentActiveId === st.id)
          toast(I18n.t("计划已生成：点击「执行计划」开始实施"), "ok");
      }
    }
  } catch (e) {
    const errMsg = (e && e.message) || String(e);
    if (st._cancelled || isCancelishError(errMsg)) {
      st._roundOutcome = "cancelled";
      const body = stripStreamErrors(st._pending);
      st.messages.push({
        role: "assistant",
        content: body || I18n.t("（已终止）"),
        at: Date.now(),
      });
    } else {
      st._roundOutcome = "error";
      st.messages.push({
        role: "assistant",
        content: I18n.t("（错误：") + errMsg + "）",
        at: Date.now(),
      });
      toast(I18n.t("智能会话失败：") + errMsg, "err");
    }
  } finally {
    st.running = false;
    st._cancelled = false;
    st._liveTools = [];
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
        if (S.agentActiveId === st.id) {
          try {
            toast(I18n.t("已终止：本会话的计划清单已清除"), "warn");
          } catch (_) {}
        }
      }
    }
    /* 被「全部终止」打断 → 排队消息留在队列里等用户，不再自动接管发送 */
    const holdQueue = outcome === "cancelled";
    /* 会话收尾：清单里没跑完的条目按本轮结局定性（红叉 / 问号）。
       队列里还有下一条要发 → 先不定性，等真正空闲的那轮结束再判 */
    try {
      if (!hasQueued || holdQueue) agentFinalizeTodos(st, outcome);
    } catch (_) {}
    if (S.thinking) delete S.thinking["agent:" + st.id];
    /* 本轮结束 → 刷新「最后对话时间」，侧边栏相对时长随之更新 */
    st.updatedAt = Date.now();
    await persistAgentSession();
    renderAgentSessionSidebar();
    /* 只在当前查看本会话时重绘会话区;否则仅刷新侧边栏运行状态,不打扰其他会话视图 */
    if (S.agentActiveId === st.id) renderAgentSession();
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
            if (S.agentActiveId === st.id)
              toast(I18n.t("检测到计划未弹出，已自动要求重新生成一次"), "warn");
          } catch (_) {}
          await agentSessionSend(planFixDirective(), {
            sessionId: st.id,
            _planFix: true,
          });
        }
      }
    } catch (_) {}
    if (!holdQueue) agentDrainQueue(st);
  }
}


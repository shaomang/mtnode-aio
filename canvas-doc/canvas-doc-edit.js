/* canvas-doc-edit —— 画布「写侧」纯编辑引擎（同一份代码，两处入口）
 *
 * 一句话：把 applyCanvasEdit 里与 DOM / 重绘 / 落盘无关的全部逻辑（参数端子拒绝闸、
 * scope 写入闸、alias 解析、create / update / connect / disconnect / remove、marks、
 * 分组、layout 闸、warnings 与回执组装）抽成 doc → doc 的函数，好让第二阶段把它搬出
 * 渲染层时**行为逐字段不变** —— 复制一份必然漂移，必须同源。
 *
 * 两处入口：
 *   · 浏览器：renderer/index.html 在 app.js / app-nodes.js 之前以 <script> 引入，挂到
 *     globalThis.MTCanvasDocEdit；渲染层的 applyCanvasEdit（renderer/app-nodes.js）只剩
 *     一层薄包装：前置闸 → pushHistory → 调本函数 → 重绘 / 落盘 / toast / 补快照。
 *   · Node（主进程 / 脚本）：require("canvas-doc/canvas-doc-edit.js") 拿同一份 api。
 *
 * 另导出 editSkipsWrites(params)：空笔（没有任何 create/update/connect/…/layout:true）的判据，
 * 由调用方在「发请求之前」复用同一份判断（写路径搬到主进程后，渲染层要先知道这一笔会不会真的写）。
 *
 * 签名：applyEdit(doc, params, ctx) → { doc, receipt, warnings, scopeExtra, effects }
 *   doc       画布文档（**被就地修改**，就是渲染层的 S.wf 本人；调用方保证 doc 与 ctx 里
 *             那套原语指向同一份文档 —— 原语读的都是它）
 *   params    与 canvas_edit 工具入参完全一致（create / update / connect / disconnect /
 *             remove / createMarks / updateMarks / removeMarks / superConnect / group /
 *             setWorkflowName / layout / scope / scopeDepth）
 *   ctx       { i18n, runKey, host }：
 *               i18n    { t(key, vars) }（引擎不持有任何词条）
 *               runKey  本轮运行键（工具许可作用域，透传给 ensureCanvasEditTools）
 *               host    画布原语（见下方宿主契约）
 *   返回值：
 *     receipt   「不含快照」的那半份回执（字段顺序与搬家前一致：ok / created / updated /
 *               createdMarks / updatedMarks / removedMarks / connected / removed / grouped /
 *               warnings / [scopeInfo]）—— 末尾那次 canvasSnapshot(...) 由调用方补，
 *               因为那是读侧的事（canvases.docService 起来之后由主进程给）。
 *     effects   { noChange, layoutGroups }：noChange = 本笔没有任何改动（原「没有改动」早退，
 *               调用方要补一份无参快照）；layoutGroups = 本笔排版的分层报告
 *               （原 S._editLayoutGroups，调用方自己决定记不记）。
 *
 * 宿主契约（ctx.host）—— 引擎里没有任何隐式全局，函数顶部逐个解构，看得到就是全部依赖：
 *   · 建 / 改节点：NODE_DEFAULTS makeNode applyNodePatch uniqueNodeTitle devAutoColorNode
 *     importImagePathsForNode imagePathsFromPatch ensureDefaultSavePath sizeNodeForContent
 *   · 引用解析 / 归属：resolveCanvasRef canMoveNodeIntoSuper rewriteNodePathsForSuperContext
 *     applyNewNodePlacement ensurePromptRefs ensureTaskScaffold nodeById nodeParentTaskId
 *     nodeParentSuperId isSuperIoNode isPinnedCtrl taskDescendantIds
 *   · 连线：relConnectError addRelWire dataInPortIndexForWire connectError wireKeepsLayerRule
 *     bridgeNodesBetween connectPortAdvice dropWiresForReplace isControlKind addWire
 *     applySuperConnect clearDownstream pruneInvalidSuperBoundaryWires
 *   · 绘制 / 组：marksOf markById makeMarkFromSpec applyMarkPatch resolveMarkRef
 *     ensureGroupArrays pruneEmptyGroups uid
 *   · scope 闸：resolveScopeHost scopedNodeIdSet pointInScopeHost
 *   · 排版：layoutFlowEx layoutOrigin snap fitAllOpenSuperShells canvasEditWantsLayout
 *   · 回执字段：editNodePortSummary nodeHasImage canUseGlobalRefs
 *     IMAGE_SIZES DEFAULT_IMAGE_SIZE lockedKinds（= window.LT.LOCKED，交付节点禁建表）
 *   · 现场出口（渲染层独有，引擎只调不实现）：pushHistory trackWorkflow
 *     closeNodeSettingsDialogIfStale collectEditStaticWarnings
 *   · 许可闸：ensureCanvasEditTools NParam（参数端子拒绝闸）
 *
 * 纪律（硬约束，不是风格建议）：
 *   · 不碰 DOM、不读 S、不调 I18n 单例、不持有状态 —— 只有入参与它改的那份 doc。
 *   · 重绘 / 落盘 / toast / 快照追加一律留在包装层：它们是「什么时候把结果摆给用户看」，
 *     与「编辑算什么」是两件事（事务化只动前者）。
 *   · 判断与文案与搬家前逐字一致（test/smoke-canvas-doc-parity.js 的编辑黄金是止损线）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTCanvasDocEdit = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 回执收口：与搬家前同一份字段顺序（warnings 之后才拼 scopeInfo，快照由调用方补） */
  function editResult(doc, receipt, warnings, scopeExtra, effects) {
    return {
      doc,
      receipt: Object.assign(receipt, scopeExtra || {}),
      warnings,
      scopeExtra: scopeExtra || {},
      effects: effects || { noChange: false, layoutGroups: null },
    };
  }

  /** 本笔有没有任何「要写」的内容 —— 空笔早退的判据（单一真源）。
   *  为什么单独导出：写路径搬到主进程之后（canvases.docService=write），渲染层要在**发请求之前**
   *  判同一件事（空笔不该去跑工具许可闸、也不该走一次 IPC），判据照着抄一份必然漂移，所以由
   *  引擎对外给出；引擎自己下面的早退也用同一个函数。 */
  function editSkipsWrites(params) {
    params = params || {};
    const n = (v) => (Array.isArray(v) ? v.length : 0);
    const marks = Array.isArray(params.createMarks)
      ? params.createMarks
      : Array.isArray(params.marks)
        ? params.marks
        : [];
    if (
      n(params.create) ||
      n(params.update) ||
      n(params.connect) ||
      n(params.disconnect) ||
      n(params.remove) ||
      marks.length ||
      n(params.updateMarks) ||
      n(params.removeMarks) ||
      n(params.superConnect) ||
      params.group ||
      params.setWorkflowName ||
      params.layout === true
    )
      return false;
    return true;
  }

  async function applyEdit(doc, params, ctx) {
    params = params || {};
    ctx = ctx || {};
    const I18n = ctx.i18n;
    const {
      NODE_DEFAULTS, makeNode, applyNodePatch, uniqueNodeTitle, devAutoColorNode,
      importImagePathsForNode, imagePathsFromPatch, ensureDefaultSavePath, sizeNodeForContent,
      resolveCanvasRef, canMoveNodeIntoSuper, rewriteNodePathsForSuperContext,
      applyNewNodePlacement, ensurePromptRefs, ensureTaskScaffold, nodeById,
      nodeParentTaskId, nodeParentSuperId, isSuperIoNode, isPinnedCtrl, taskDescendantIds,
      relConnectError, addRelWire, dataInPortIndexForWire, connectError, wireKeepsLayerRule,
      bridgeNodesBetween, connectPortAdvice, dropWiresForReplace, isControlKind, addWire,
      applySuperConnect, clearDownstream, pruneInvalidSuperBoundaryWires,
      marksOf, markById, makeMarkFromSpec, applyMarkPatch, resolveMarkRef,
      ensureGroupArrays, pruneEmptyGroups, uid,
      resolveScopeHost, scopedNodeIdSet, pointInScopeHost,
      layoutFlowEx, layoutOrigin, snap, fitAllOpenSuperShells, canvasEditWantsLayout,
      editNodePortSummary, nodeHasImage, canUseGlobalRefs,
      IMAGE_SIZES, DEFAULT_IMAGE_SIZE, lockedKinds,
      pushHistory, trackWorkflow, closeNodeSettingsDialogIfStale, collectEditStaticWarnings,
      ensureCanvasEditTools, NParam,
    } = ctx.host;
    if (!doc) throw new Error(I18n.t("当前没有打开的画布"));
    const warnings = [];
    const created = [];
    const updated = [];
    const connected = [];
    const removed = [];
    const createdMarks = [];
    const updatedMarks = [];
    const removedMarks = [];
    const aliasMap = new Map();
    const aliasById = {};
    const markAliasMap = new Map();
    const running = new Set(
      (doc.nodes || []).filter((n) => n.running).map((n) => n.id),
    );
    const creates = Array.isArray(params.create) ? params.create : [];
    const updates = Array.isArray(params.update) ? params.update : [];
    /* 参数只能从「参数」端子来：create / update 里带 params 就整笔拒绝（写入口的闸，
       放在 pushHistory / 任何写操作之前 —— 见 renderer/app-node-params.js 的同名函数）。
       不接线而把参数挂到节点上，会把用户在 ⚙ 里改的值压住，等于用户改不动参数。 */
    {
      const reject =
        typeof NParam === "object" && NParam && typeof NParam.editParamsRejection === "function"
          ? NParam.editParamsRejection(params)
          : "";
      if (reject) throw new Error(reject);
    }
    const connects = Array.isArray(params.connect) ? params.connect : [];
    const disconnects = Array.isArray(params.disconnect) ? params.disconnect : [];
    const removes = Array.isArray(params.remove) ? params.remove : [];
    const createMarks = Array.isArray(params.createMarks)
      ? params.createMarks
      : Array.isArray(params.marks)
        ? params.marks
        : [];
    const updateMarks = Array.isArray(params.updateMarks)
      ? params.updateMarks
      : [];
    const removeMarksList = Array.isArray(params.removeMarks)
      ? params.removeMarks
      : [];
    /* 数量上限已移除：整笔调用完整执行。此前 40/80 的截断会造成「部分创建」——
       大调用（架构图、批量建图）的 connect / createMarks / group 引用被截掉的
       alias 全部落空，曾导致节点层 / 开发节点架构图建成半成品（孤儿节点）。
       null.push 崩溃根因已修，大调用现在可安全完整执行。 */
    /* 排版闸：只有本笔显式写了 layout:true 才排。2026-02 需求「不要自动改变」——
       编辑只落内容与连线，不再因为建图 / 连线 / 改标注 / 删除 / 改尺寸就顺手重排，
       也不再按正文长短重算节点尺寸（见 canvasEditWantsLayout 与 freeSpotForNode）。 */
    const wantsLayout = canvasEditWantsLayout(params, creates);
    const doLayout = wantsLayout;

    /* ── 局部画布（scope）：写入侧的越界闸 ──────────────────────────────
       需求：编辑工具要能「只改某一颗节点层 / 开发节点内部」。传了 scope 就把这次调用
       钉在那颗壳的子树里：界外节点一律不碰（跳过 + warnings 逐条说明），
       新节点缺 parentSuperId 时默认落进这颗壳，免得建完飘在根画布上。
       两种口径（与只读侧 scopedNodeIdSet 同一真源）：
         · scopeScope  = 那颗壳 + 它的直接子节点（+ scopeDepth:"all" 时的整棵子树）
           —— 这次调用允许触碰的节点；
         · nodeScopeScope = 同上再放宽一层：嵌套更深的子块只要祖先链都在
           nodeScopeScope 里就放行（编辑子块内容时用它）。 */
    const editScopeHost = resolveScopeHost(params.scope);
    const editScope =
      editScopeHost && !editScopeHost.bad
        ? { host: editScopeHost, short: params.scopeDepth === "all" ? "all" : "direct" }
        : null;
    if (editScopeHost && editScopeHost.bad) {
      warnings.push(
        I18n.t("无效的 scope（要给节点层 / 开发节点的 id 或唯一标题）：") +
          editScopeHost.token,
      );
    }
    const editAllowed = editScope
      ? editScope.short === "all"
        ? scopedNodeIdSet(editScope.host, "all")
        : scopedNodeIdSet(editScope.host, "direct")
      : null;
    const nodeScopeAllowed = editScope
      ? scopedNodeIdSet(editScope.host, "all")
      : null;
    const outOfEditScope = (n) => !!(editAllowed && !editAllowed.has(n.id));
    const outOfNodeScope = (n) => !!(nodeScopeAllowed && !nodeScopeAllowed.has(n.id));
    /* 绘制（mark）只在 scope 那颗壳里可改；根画布上的绘制（parentSuperId 为空）也算界外 */
    const outOfMarkScope = (m) =>
      !!(editAllowed && !editAllowed.has(String((m && m.parentSuperId) || "")));
    const scopeSkip = (what) =>
      warnings.push(
        I18n.t("scope 界外已跳过：") +
          what +
          I18n.t("（本次只改 ") +
          (editScope.host.title || editScope.host.id) +
          I18n.t("）"),
      );
    const scopeExtra = editScope
      ? {
          scopeInfo: {
            mode: "subtree",
            origin: "explicit",
            depth: editScope.short,
            hostId: editScope.host.id,
            hostTitle: editScope.host.title,
            note: I18n.t("本次编辑被限定在这一颗壳内部：界外节点未改动。"),
          },
        }
      : {};

    if (editSkipsWrites(params)) {
      return editResult(
        doc,
        { ok: true, message: I18n.t("没有改动"), warnings },
        warnings,
        {},
        { noChange: true },
      );
    }

    await ensureCanvasEditTools(params, ctx && ctx.runKey);

    pushHistory();
    if (!Array.isArray(doc.groups)) doc.groups = [];
    if (!Array.isArray(doc.marks)) doc.marks = [];

    if (params.setWorkflowName) {
      const name = String(params.setWorkflowName).trim();
      if (name) {
        doc.name = name;
        if (typeof trackWorkflow === "function") trackWorkflow(doc.id, name);
      }
    }

    const originHint = layoutOrigin(
      (doc.nodes || []).filter((n) => !aliasMap.has(n.id)),
    );
    /* 本笔显式给了 x/y 的新节点：记下来，收尾统一摆位时跳过它们（坐标是调用方钉的） */
    const newXY = new Set();

    for (const spec of creates) {
      let kind = spec && spec.kind;
      if (kind === "image" || kind === "img") kind = "input_image";
      if (kind === "text") kind = "input_text";
      if (kind === "save_text" || kind === "save_image") kind = "save";
      if (!NODE_DEFAULTS[kind]) {
        warnings.push(I18n.t("未知节点类型：") + (spec && spec.kind));
        continue;
      }
      /* 系统专属 kind（交付节点）：智能体建图也不给建（需求 2「不能手动新建」含代理入口） */
      if (lockedKinds && lockedKinds.indexOf(kind) >= 0) {
        warnings.push(I18n.t("交付节点由长周期任务自动创建，不能用 canvas_edit 新建，已跳过：") + (spec && spec.alias));
        continue;
      }
      const alias = String((spec && spec.alias) || "").trim();
      if (!alias) {
        warnings.push(I18n.t("create 项缺少 alias，已跳过"));
        continue;
      }
      if (aliasMap.has(alias)) {
        warnings.push(I18n.t("重复 alias：") + alias);
        continue;
      }
      const hasXY =
        typeof spec.x === "number" &&
        isFinite(spec.x) &&
        typeof spec.y === "number" &&
        isFinite(spec.y);
      const node = makeNode(
        kind,
        hasXY ? spec.x : originHint.x,
        hasXY ? spec.y : originHint.y,
      );
      /* 局部画布：scope 界外的锚点（x/y 落在壳外面）不建 —— 建了也只会飘在根画布上。
         给了 parentSuperId / packIntoSuper 的（含 alias 指向本次新建的壳）按后面的归属闸走。 */
      if (
        editScope &&
        hasXY &&
        !pointInScopeHost(editScope.host, spec.x, spec.y) &&
        spec.parentSuperId == null &&
        spec.packIntoSuper == null
      ) {
        scopeSkip(I18n.t("新节点 ") + alias);
        continue;
      }
      const wantTitle = String(spec.title || NODE_DEFAULTS[kind].title || alias);
      node.title = uniqueNodeTitle(wantTitle);
      applyNodePatch(node, spec, warnings);
      /* 开发节点：创建即按功能色卡上色（spec 显式给了 devColor 则不覆盖；
         须在 title / note 定稿后调用，归类靠这两项推断） */
      if (typeof devAutoColorNode === "function") devAutoColorNode(node);
      await importImagePathsForNode(node, imagePathsFromPatch(spec), warnings);
      node.title = uniqueNodeTitle(node.title || wantTitle, node.id);
      ensureDefaultSavePath(node);
      /* 新建节点仍给「美观尺寸」（下方 sizeNodeForContent）—— 只对**已存在**节点不改尺寸。
         没给坐标的新节点先落在 origin 附近，等父壳 / 父任务解析完（下面那次统一摆位）
         再就近找空位：那时才拿得到真实的层级，局部坐标才对得上。 */
      sizeNodeForContent(node);
      doc.nodes.push(node);
      aliasMap.set(alias, node);
      aliasById[node.id] = alias;
      if (hasXY) newXY.add(node.id);
      created.push(node);
    }

    for (const node of created) {
      /* media gens: path is set in-node; no bound save */
    }

    for (const spec of creates) {
      const alias = String((spec && spec.alias) || "").trim();
      const node = aliasMap.get(alias);
      if (!node || !spec || spec.parentTaskId == null) continue;
      const raw = String(spec.parentTaskId).trim();
      if (!raw) {
        node.parentTaskId = "";
        continue;
      }
      const p = resolveCanvasRef(raw, aliasMap, warnings);
      if (p && p.kind === "task" && p.id !== node.id) node.parentTaskId = p.id;
      else if (raw && warnings)
        warnings.push(I18n.t("无效的父任务：") + raw);
    }

    /* 收纳进节点层：与 parentTaskId 一样，须在整批 create 入 aliasMap 后再解析 alias/title */
    const applyParentSuper = (node, raw, warningsArr) => {
      if (!node) return;
      /* 局部画布（scope）：界外节点不收纳 —— 收纳会把界外节点拖进这颗壳，等于改到界外 */
      if (editScope && node.id !== editScope.host.id && outOfNodeScope(node)) {
        scopeSkip(node.title || node.id);
        return;
      }
      const token = String(raw == null ? "" : raw).trim();
      if (!token) {
        /* scope 生效且没点名父壳 → 默认落进 scope 这颗壳（用户语义就是"在这颗壳里编辑"） */
        if (editScope && node.id !== editScope.host.id) {
          node.parentSuperId = editScope.host.id;
          node.parentTaskId = editScope.host.parentTaskId || node.parentTaskId || "";
          rewriteNodePathsForSuperContext(node);
          return;
        }
        node.parentSuperId = "";
        return;
      }
      const p = resolveCanvasRef(token, aliasMap, warningsArr);
      if (p && p.kind === "super" && canMoveNodeIntoSuper(p, node)) {
        if (editScope && !editAllowed.has(p.id)) {
          scopeSkip(p.title || p.id);
          return;
        }
        node.parentSuperId = p.id;
        node.parentTaskId = p.parentTaskId || node.parentTaskId || "";
        rewriteNodePathsForSuperContext(node);
      } else if (token && warningsArr) {
        warningsArr.push(I18n.t("无效的节点层：") + token);
      }
    };
    for (const spec of creates) {
      const alias = String((spec && spec.alias) || "").trim();
      const node = aliasMap.get(alias);
      if (!node || !spec) continue;
      if (spec.parentSuperId == null && spec.packIntoSuper == null) continue;
      const raw =
        spec.parentSuperId != null ? spec.parentSuperId : spec.packIntoSuper;
      applyParentSuper(node, raw, warnings);
    }

    /* ── 新节点就近摆位（2026-02 需求：编辑不再自动排版）──────────────
       父壳 / 父任务已定，这里的层级与坐标系才是最终口径 —— 见 applyNewNodePlacement。 */
    applyNewNodePlacement(created, {
      origin: originHint,
      pinned: newXY,
      outOfScope: outOfEditScope,
    });

    for (const spec of updates) {
      const token = (spec && (spec.id || spec.alias || spec.title)) || "";
      const node = resolveCanvasRef(token, aliasMap, warnings);
      if (!node) continue;
      /* 局部画布：scope 界外的节点一律不碰（跳过而不是整体报错 —— 一批里其余照做） */
      if (outOfEditScope(node)) {
        scopeSkip(node.title || node.id);
        continue;
      }
      if (running.has(node.id) && spec.setTitle) {
        warnings.push(I18n.t("运行中的节点未改标题：") + node.title);
        spec = Object.assign({}, spec, { setTitle: undefined });
      }
      if (
        running.has(node.id) &&
        (spec.model != null ||
          spec.providerId != null ||
          spec.provider != null)
      ) {
        warnings.push(I18n.t("运行中的节点未改模型：") + node.title);
        spec = Object.assign({}, spec, {
          model: undefined,
          providerId: undefined,
          provider: undefined,
        });
      }
      applyNodePatch(node, spec, warnings);
      await importImagePathsForNode(node, imagePathsFromPatch(spec), warnings);
      if (spec.refs) ensurePromptRefs(node, spec.refs, aliasMap);
      /* 2026-02 需求：**已存在节点的尺寸不再被自动重算**。原先这里跟着调
         sizeNodeForContent()，会把用户 / 模型调好的 w/h 按新正文长短改掉（还会缩回默认尺寸）。
         现在尺寸只认本笔显式给的 w/h（applyNodePatch 里那两行）与用户手拖。 */
      updated.push({
        id: node.id,
        title: node.title,
        kind: node.kind,
        /* 回执自足：带上位置 / 尺寸与端口占用摘要，模型改完不必再 canvas_get 回读 */
        x: Math.round(Number(node.x) || 0),
        y: Math.round(Number(node.y) || 0),
        w: Math.round(Number(node.w) || 0),
        h: Math.round(Number(node.h) || 0),
        ports: editNodePortSummary(node),
        hasImage: nodeHasImage(node),
        providerId: node.providerId || undefined,
        provider: node.provider || undefined,
        model: node.model || undefined,
        size:
          node.kind === "proc_image"
            ? IMAGE_SIZES.includes(node.size)
              ? node.size
              : DEFAULT_IMAGE_SIZE
            : undefined,
      });
    }

    /* update 里的 parentSuperId 可能是 alias/title：在 patch 后再用 aliasMap 解析一次 */
    for (const spec of updates) {
      if (!spec || (spec.parentSuperId == null && spec.packIntoSuper == null))
        continue;
      const token = (spec.id || spec.alias || spec.title) || "";
      const node = resolveCanvasRef(token, aliasMap, warnings);
      if (!node) continue;
      const raw =
        spec.parentSuperId != null ? spec.parentSuperId : spec.packIntoSuper;
      applyParentSuper(node, raw, warnings);
    }

    for (const spec of creates) {
      const alias = String((spec && spec.alias) || "").trim();
      const node = aliasMap.get(alias);
      if (node && spec && spec.refs) ensurePromptRefs(node, spec.refs, aliasMap);
    }

    for (const node of created) {
      if (node && node.kind === "task") ensureTaskScaffold(node);
    }

    for (const pair of disconnects) {
      const a = resolveCanvasRef(pair && pair.from, aliasMap, warnings);
      const b = resolveCanvasRef(pair && pair.to, aliasMap, warnings);
      if (!a || !b) continue;
      if (outOfEditScope(a) || outOfEditScope(b)) {
        scopeSkip((a.title || a.id) + " → " + (b.title || b.id));
        continue;
      }
      const before = doc.wires.length;
      doc.wires = doc.wires.filter(
        (w) =>
          !(
            (w.from === a.id && w.to === b.id) ||
            (w.rel && w.from === b.id && w.to === a.id)
          ),
      );
      if (doc.wires.length === before) warnings.push(I18n.t("没有可断开的连线：") + a.title + " → " + b.title);
      else clearDownstream(b.id);
    }

    for (const pair of connects) {
      const a = resolveCanvasRef(pair && pair.from, aliasMap, warnings);
      const b = resolveCanvasRef(pair && pair.to, aliasMap, warnings);
      if (!a || !b) continue;
      if (outOfEditScope(a) || outOfEditScope(b)) {
        scopeSkip((a.title || a.id) + " → " + (b.title || b.id));
        continue;
      }
      if (pair && pair.rel) {
        /* 关系线：仅表示关系，不走数据流校验 */
        const err = relConnectError(a.id, b.id);
        if (err) {
          warnings.push(a.title + " ↔ " + b.title + "：" + err);
          continue;
        }
        addRelWire(a.id, b.id, {
          relArrow: pair.relArrow,
          relLabel: pair.relLabel,
        });
        connected.push({ from: a.id, to: b.id, fromTitle: a.title, toTitle: b.title, rel: true });
        continue;
      }
      /* 显式端子（toIndex）：不传 = null = 沿用原来的「自动选槽」。媒体节点
         （breeze_gen 的 0/1/2/3 与端口 4 控制、video_gen 的控制口在 0）靠它才能落对槽位。 */
      const wantIndex =
        pair && pair.toIndex != null && pair.toIndex !== "" ? Number(pair.toIndex) : null;
      if (wantIndex != null && (!Number.isInteger(wantIndex) || wantIndex < 0)) {
        warnings.push(a.title + " → " + b.title + "：toIndex 非法（需 0 起始整数）");
        continue;
      }
      /* 端子归一：数据线落到越界 / 控制端子时改落最近空闲的数据端子（静默改落，与手拖同一口径） */
      const useIndex = dataInPortIndexForWire(b, a, pair.fromIndex || 0, wantIndex);
      const err = connectError(a.id, b.id, useIndex, pair.fromIndex || 0);
      if (err) {
        /* 跨节点层是硬规则不许直连：自动改写成经边界端子的逐层桥接（同层不在此列）。
           连成 → 记一条 viaSuper；连不成 → bridgeNodesBetween 已把原因写进 warnings。 */
        if (!wireKeepsLayerRule(a, b)) {
          const bridgeOut = {};
          const created = bridgeNodesBetween(a, b, pair.fromIndex || 0, useIndex, warnings, bridgeOut);
          if (created > 0) {
            const entry = {
              from: a.id,
              to: b.id,
              fromTitle: a.title,
              toTitle: b.title,
              viaSuper: true,
              wires: created,
            };
            if (bridgeOut.replaced && bridgeOut.replaced.length)
              entry.replaced = bridgeOut.replaced;
            connected.push(entry);
          }
          continue;
        }
        /* 端口 / 接法预检：把候选端子清单与正确接法一并回给模型，
           省掉「报错 → 再读图 → 再改」的往返。 */
        const adv = connectPortAdvice(a.id, b.id, useIndex, pair.fromIndex || 0, err);
        warnings.push(
          a.title + " → " + b.title + "：" + err +
            (adv && adv.suggestion ? " · " + adv.suggestion : ""),
        );
        continue;
      }
      /* 已占用的端子 → 先顶掉旧的同类线（替换语义）：回执里点名被换掉的上游与端子号，
         这样 Agent 不会把「替换」误当成「新加了一条线」。 */
      const replacedWires = dropWiresForReplace(b, useIndex, isControlKind(a));
      addWire(a.id, b.id, useIndex, { fromIndex: pair.fromIndex || 0 });
      const entry = { from: a.id, to: b.id, fromTitle: a.title, toTitle: b.title };
      if (replacedWires.length) entry.replaced = replacedWires;
      connected.push(entry);
    }

    /* 跨节点层连接：任意层级 / 任意节点层内的两个节点自动贯通。
       局部画布（scope）：界外的对先剔掉再交给它，避免"顺手"连到壳外面去。 */
    const superPairs = Array.isArray(params.superConnect) ? params.superConnect : [];
    if (superPairs.length) {
      const usePairs = editScope
        ? superPairs.filter((p) => {
            const a = resolveCanvasRef(p && p.from, aliasMap, warnings);
            const b = resolveCanvasRef(p && p.to, aliasMap, warnings);
            if (!a || !b) return false;
            if (outOfEditScope(a) || outOfEditScope(b)) {
              scopeSkip((a.title || a.id) + " → " + (b.title || b.id));
              return false;
            }
            return true;
          })
        : superPairs;
      if (usePairs.length) {
        applySuperConnect(usePairs, { aliasMap, warnings, connected });
      }
    }

    for (const token of removes) {
      const node = resolveCanvasRef(token, aliasMap, warnings);
      if (!node) continue;
      if (outOfEditScope(node)) {
        scopeSkip(node.title || node.id);
        continue;
      }
      if (running.has(node.id)) {
        warnings.push(I18n.t("不能删除正在运行的节点：") + node.title);
        continue;
      }
      removed.push(node.id);
      if (node.kind === "task") {
        for (const id of taskDescendantIds(node.id)) removed.push(id);
      }
    }
    if (removed.length) {
      const expanded = new Set(removed);
      const finalIds = [];
      for (const id of expanded) {
        const n = nodeById(id);
        if (!n) continue;
        if (isPinnedCtrl(n) && !(n.parentTaskId && expanded.has(n.parentTaskId))) {
          warnings.push(I18n.t("起点 / 终点为固定节点，无法删除") + "：" + n.title);
          continue;
        }
        finalIds.push(id);
      }
      removed.length = 0;
      removed.push(...finalIds);
    }
    if (removed.length) {
      const set = new Set(removed);
      doc.nodes = doc.nodes.filter((n) => !set.has(n.id));
      doc.wires = doc.wires.filter((w) => !set.has(w.from) && !set.has(w.to));
      for (const g of doc.groups) {
        ensureGroupArrays(g);
        g.nodeIds = g.nodeIds.filter((id) => !set.has(id));
      }
      pruneEmptyGroups();
      for (const n of created) {
        if (set.has(n.id)) aliasMap.delete(n.id);
      }
      /* Agent 侧删节点绕过了 deleteNodes：设置窗若绑在被删节点上同样必须关掉
         （quiet —— 这条路径的反馈走 warnings 回执，不弹用户提示；本函数随后自己重绘落盘）。 */
      closeNodeSettingsDialogIfStale({
        silentRerender: true,
        skipSave: true,
        quiet: true,
      });
    }

    const createdLive = created.filter((n) => nodeById(n.id));
    /* 排版报告（原 S._editLayoutGroups）：只回给调用方，模块自己不持有任何状态 */
    let layoutGroups = null;
    if (doLayout) {
      const targets = (
        createdLive.length && params.layout !== true
          ? createdLive
          : createdLive.length
            ? createdLive
            : (doc.nodes || []).filter((n) => !running.has(n.id))
      ).filter((n) => !editScope || editAllowed.has(n.id));
      /* 分「所属层级」各自排版：壳层内子节点用的是舞台局部坐标，
         与顶层画布坐标不是同一个空间，混在一起排会排飞（开发节点架构图就踩过） */
      const groups = new Map();
      for (const n of targets) {
        const tid = nodeParentTaskId(n) || "";
        const sid = nodeParentSuperId(n) || "";
        const key = tid + "|" + sid;
        if (!groups.has(key)) groups.set(key, { tid, sid, key, list: [] });
        groups.get(key).list.push(n);
      }
      layoutGroups = groups;
      for (const g of groups.values()) {
        const list = g.list;
        const set = new Set(list.map((n) => n.id));
        const obstacles = (doc.nodes || []).filter((n) => {
          if (set.has(n.id) || running.has(n.id) || isSuperIoNode(n)) return false;
          return g.sid
            ? nodeParentSuperId(n) === g.sid
            : !nodeParentSuperId(n) && nodeParentTaskId(n) === g.tid;
        });
        const origin = g.sid
          ? { x: snap(16), y: snap(16) }
          : createdLive.length && params.layout !== true
            ? layoutOrigin(obstacles)
            : { x: snap(48), y: snap(48) };
        /* agent 显式给过 x/y 的老节点当起始锚点：仍参与排版，但尽量少位移；
           本次新建的节点不算锚点（它们还没被用户摆过） */
        const anchored = list.some((n) => createdLive.indexOf(n) < 0);
        const report = layoutFlowEx(
          list,
          doc.wires || [],
          origin,
          obstacles,
          anchored ? { preferAnchor: true } : {},
        );
        g.report = report;
        const host = g.sid && !g.tid ? nodeById(g.sid) : null;
        g.label = host ? host.title || host.id : I18n.t("顶层画布");
        /* 宽高比不再是硬约束：只在「排出来细长到不好读」时给一句提示（不缩节点、不放宽缝宽） */
        const ratio = report && report.h > 0 ? report.w / report.h : 1;
        if (report && ratio > 3) {
          warnings.push(
            I18n.t(
              "排版提示：「{label}」这层排成了长条（宽 {w} × 高 {h}）。节点之间已按 1 个网格间距排开、互不重叠；想更方正可再增删节点或手动微调。",
              {
                label: g.label || "",
                w: Math.round(report.w || 0),
                h: Math.round(report.h || 0),
              },
            ),
          );
        }
      }
      /* 壳层按新的内容范围撑开，否则子块 / 关系线被 720×480 默认舞台裁掉 */
      fitAllOpenSuperShells();
    }

    /* 绘制标注：在节点排版之后创建，便于 around 包住最终坐标 */
    const resolveAroundNodes = (list) => {
      const out = [];
      for (const t of list || []) {
        const n = resolveCanvasRef(t, aliasMap, warnings);
        if (n) out.push(n);
      }
      return out;
    };
    const applyAroundToSpec = (spec) => {
      const around = spec.around || spec.nodes || spec.wrap;
      if (!around || !around.length) return spec;
      const ns = resolveAroundNodes(around);
      if (!ns.length) return spec;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const n of ns) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + (n.w || 0));
        maxY = Math.max(maxY, n.y + (n.h || 0));
      }
      const pad = Math.max(0, Number(spec.pad) || 36);
      const titleH =
        spec.kind === "box" || !spec.kind || spec.kind === "frame"
          ? 0
          : 0;
      return Object.assign({}, spec, {
        x: minX - pad,
        y: minY - pad - titleH,
        w: maxX - minX + pad * 2,
        h: maxY - minY + pad * 2,
      });
    };

    const applyMarkParentSuper = (m, raw, warningsArr) => {
      if (!m) return;
      const token = String(raw == null ? "" : raw).trim();
      if (!token) {
        /* scope 生效且没点名归属 → 绘制也落进这颗壳（与节点同口径） */
        if (editScope) m.parentSuperId = editScope.host.id;
        else m.parentSuperId = "";
        return;
      }
      const p = resolveCanvasRef(token, aliasMap, warningsArr);
      if (p && p.kind === "super") {
        if (editScope && !editAllowed.has(p.id)) {
          scopeSkip(p.title || p.id);
          return;
        }
        m.parentSuperId = p.id;
        m.parentTaskId = p.parentTaskId || m.parentTaskId || "";
      } else if (token && warningsArr) {
        warningsArr.push(I18n.t("无效的节点层：") + token);
      }
    };
    for (const raw of createMarks) {
      const alias = String((raw && raw.alias) || "").trim();
      let spec = applyAroundToSpec(raw || {});
      if (!spec.kind && (spec.around || spec.nodes || spec.wrap))
        spec = Object.assign({ kind: "box" }, spec);
      const m = makeMarkFromSpec(spec, warnings);
      if (!m) continue;
      if (raw && (raw.parentSuperId != null || raw.packIntoSuper != null)) {
        const rawSuper =
          raw.parentSuperId != null ? raw.parentSuperId : raw.packIntoSuper;
        applyMarkParentSuper(m, rawSuper, warnings);
      }
      marksOf().push(m);
      if (alias) {
        if (markAliasMap.has(alias))
          warnings.push(I18n.t("重复绘制 alias：") + alias);
        else markAliasMap.set(alias, m);
      }
      /* 框体旁可选标题文字：label / title */
      const label = String((raw && (raw.label || raw.title)) || "").trim();
      if (label && m.kind === "box") {
        const tm = makeMarkFromSpec(
          {
            kind: "text",
            x: m.x + 8,
            y: m.y - 28,
            w: Math.max(120, Math.min(m.w - 16, 280)),
            h: 32,
            text: label,
            fontSize: Number(raw.labelSize) || 15,
            color: m.color,
          },
          warnings,
        );
        if (tm) {
          marksOf().push(tm);
          createdMarks.push({
            alias: alias ? alias + "_label" : "",
            id: tm.id,
            kind: tm.kind,
            text: tm.text,
            x: tm.x,
            y: tm.y,
          });
        }
      }
      createdMarks.push({
        alias: alias || "",
        id: m.id,
        kind: m.kind,
        text: m.kind === "text" ? m.text : label || undefined,
        x: m.x,
        y: m.y,
        w: m.w,
        h: m.h,
      });
    }

    for (const raw of updateMarks) {
      const token = (raw && (raw.id || raw.alias || raw.title || raw.text)) || "";
      const m = resolveMarkRef(token, markAliasMap, warnings);
      if (!m) continue;
      if (outOfMarkScope(m)) {
        scopeSkip(m.kind + " " + (m.text || m.id));
        continue;
      }
      let patch = raw;
      if (raw.around || raw.nodes || raw.wrap) {
        patch = applyAroundToSpec(
          Object.assign({}, raw, { kind: m.kind }),
        );
      }
      applyMarkPatch(m, patch, warnings);
      updatedMarks.push({
        id: m.id,
        kind: m.kind,
        text: m.kind === "text" ? m.text : undefined,
        x: m.x,
        y: m.y,
        w: m.w,
        h: m.h,
      });
    }

    if (removeMarksList.length) {
      const delIds = [];
      for (const token of removeMarksList) {
        const m = resolveMarkRef(token, markAliasMap, warnings);
        if (!m) continue;
        if (outOfMarkScope(m)) {
          scopeSkip(m.kind + " " + (m.text || m.id));
          continue;
        }
        delIds.push(m.id);
      }
      if (delIds.length) {
        const set = new Set(delIds);
        doc.marks = marksOf().filter((m) => !set.has(m.id));
        for (const g of doc.groups || []) {
          ensureGroupArrays(g);
          g.markIds = g.markIds.filter((id) => !set.has(id));
        }
        pruneEmptyGroups();
        removedMarks.push(...delIds);
      }
    }

    /* 组：在节点排版与绘制创建之后，可同时纳入节点与绘制 */
    let grouped = null;
    if (params.group && typeof params.group === "object") {
      const gspec = params.group;
      let nodeIds = [];
      let markIds = [];
      if (Array.isArray(gspec.nodes) && gspec.nodes.length) {
        for (const t of gspec.nodes) {
          /* 传入真实 warnings：resolveCanvasRef 找不到成员时会 push 提示，
             传 null 会在 null 上 push 抛 TypeError（曾导致建图调用半途崩溃） */
          const n = resolveCanvasRef(t, aliasMap, warnings);
          if (n) {
            nodeIds.push(n.id);
            continue;
          }
          const m = resolveMarkRef(t, markAliasMap, warnings);
          if (m) markIds.push(m.id);
          else warnings.push(I18n.t("组内找不到成员：") + t);
        }
      } else {
        nodeIds = createdLive.map((n) => n.id);
      }
      if (Array.isArray(gspec.marks) && gspec.marks.length) {
        for (const t of gspec.marks) {
          const m = resolveMarkRef(t, markAliasMap, warnings);
          if (m) markIds.push(m.id);
        }
      } else if (
        !(Array.isArray(gspec.nodes) && gspec.nodes.length) &&
        createdMarks.length
      ) {
        /* 未显式列 marks 且未列 nodes：把本批 createMarks 一并入组 */
        markIds = createdMarks.map((x) => x.id).filter(Boolean);
      }
      nodeIds = nodeIds.filter((id, i) => nodeIds.indexOf(id) === i);
      markIds = markIds.filter((id, i) => markIds.indexOf(id) === i);
      /* scope 生效：组只能收纳壳内成员（成组会把成员一起搬动 / 缩放，界外成员一并被挪） */
      if (editScope) {
        const beforeN = nodeIds.length;
        nodeIds = nodeIds.filter((id) => editAllowed.has(id));
        if (nodeIds.length !== beforeN) scopeSkip(I18n.t("组"));
        markIds = markIds.filter((id) => {
          const m = marksOf().filter((x) => x.id === id)[0];
          return m && !outOfMarkScope(m);
        });
      }
      if (nodeIds.length || markIds.length) {
        grouped = {
          id: uid("g"),
          title: String(gspec.title || I18n.t("组")).trim() || I18n.t("组"),
          nodeIds,
          markIds,
        };
        doc.groups.push(grouped);
      }
    }

    /* 孤儿防护：本笔编辑产生的节点 / 绘制不允许挂在画布上不存在的节点层下
       （历史 bug：整棵开发节点架构图挂到幽灵父级后，最外层功能块从此消失，
        内部块仍在，但左侧栏与层级视图全部错乱） */
    {
      const liveIds = new Set((doc.nodes || []).map((n) => n.id));
      let orphanNodes = 0;
      for (const n of createdLive) {
        const sid = nodeParentSuperId(n);
        if (sid && !liveIds.has(sid)) {
          n.parentSuperId = "";
          orphanNodes++;
        }
      }
      for (const rec of createdMarks) {
        const m = rec && rec.id ? markById(rec.id) : null;
        if (m && m.parentSuperId && !liveIds.has(m.parentSuperId)) {
          m.parentSuperId = "";
          orphanNodes++;
        }
      }
      if (orphanNodes) {
        warnings.push(
          I18n.t("已清理 ") + orphanNodes + I18n.t(" 个指向不存在节点层的引用"),
        );
      }
    }

    /* edit 收尾一次性静态校验：本笔触碰到的节点 / 连线统一过一遍，
       warnings 合并进本轮回执（旧口径的批量 N² 检查也并入这一趟）。 */
    const touchedIds = new Set();
    for (const n of createdLive) touchedIds.add(n.id);
    for (const u of updated) if (u && u.id) touchedIds.add(u.id);
    for (const c of connected) {
      if (c && c.from) touchedIds.add(c.from);
      if (c && c.to) touchedIds.add(c.to);
    }
    if (grouped) for (const id of grouped.nodeIds || []) touchedIds.add(id);
    collectEditStaticWarnings(touchedIds, warnings);
    /* 跨节点层硬规则的收口：改 parentSuperId / 删节点都可能留下层外的野线，
       每次编辑结束静默剪掉（与装箱 / 拆箱同一口径，不提示）。 */
    pruneInvalidSuperBoundaryWires();

    const receipt = Object.assign(
      {
        ok: true,
        created: createdLive.map((n) => ({
          alias: aliasById[n.id] || "",
          id: n.id,
          kind: n.kind,
          title: n.title,
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
          ports: editNodePortSummary(n),
          hasImage: nodeHasImage(n),
          size:
            n.kind === "proc_image"
              ? IMAGE_SIZES.includes(n.size)
                ? n.size
                : DEFAULT_IMAGE_SIZE
              : undefined,
          model: n.model || undefined,
          ctrlAction: n.kind === "control" ? n.ctrlAction || "run" : undefined,
          ctrlFillOnly: n.kind === "control" ? !!n.ctrlFillOnly : undefined,
          globalRefs: canUseGlobalRefs(n) ? !!n.globalRefs : undefined,
        })),
        updated,
        createdMarks,
        updatedMarks,
        removedMarks,
        connected,
        removed,
        grouped: grouped
          ? {
              id: grouped.id,
              title: grouped.title,
              nodeIds: grouped.nodeIds,
              markIds: grouped.markIds || [],
            }
          : undefined,
        warnings,
      },
      scopeExtra,
    );

    return editResult(doc, receipt, warnings, scopeExtra, {
      noChange: false,
      layoutGroups,
    });
  }

  return { applyEdit, editSkipsWrites };
});

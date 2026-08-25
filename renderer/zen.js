/* ==========================================================================
   Zen Mode 沉浸式 · 渲染引擎（renderer/zen.js）
   依赖 app.js 的顶层共享：S / I18n / dshRunTask / createWorkflowNamed /
   renderMarkdown / confirmDialog / toast / escapeHtml / uid / $
   独立存档类型 zen；与 config.agentSessions 完全分离。
   ========================================================================== */
"use strict";
(() => {
  const ZEN_GRID = () =>
    Math.max(4, Math.min(64, Number((S.config && S.config.snap) || 24)));
  const zenSnap = (v) => Math.round(v / ZEN_GRID()) * ZEN_GRID();
  const zenUid = (p) =>
    (p || "z") +
    Date.now().toString(36) +
    Math.floor(Math.random() * 46656).toString(36);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ZEN_SKILL_IDS = {
    bootstrap: "zen-bootstrap",
    planCompile: "zen-plan-compile",
    canvasCompile: "zen-canvas-compile",
  };
  const OPT_MAX = 6;
  const OPT_RADIUS = 300;
  const OPT_RADIUS2 = 420;
  const SAVE_DEBOUNCE = 10000; /* 10s */
  const BACKUP_EVERY = 10 * 60 * 1000; /* 10min */

  /* ---------------- 会话状态 ---------------- */
  const Z = {
    open: false,
    built: false,
    doc: null, /* 当前 zen 存档 */
    cam: { x: 0, y: 0, z: 1 },
    camRaf: 0,
    camDirty: false,
    dirty: false,
    saveTimer: null,
    saving: false,
    backupTimer: null,
    progressTimer: null,
    drag: null,
    runs: new Map(), /* nodeId | "__build__" -> Promise */
    activeAskId: null,
    selOptions: new Set(),
    planOpen: false,
    planTab: "edit",
    planTimer: null,
    sessionCollapsed: false,
    picking: false,
    hubId: null,
    seenIds: new Set(), /* 已渲染过的节点：只给新节点播放入场动画 */
    nodeDrag: null, /* {id, sx, sy, ox, oy, moved} 节点拖动 */
    _zenDragMoved: false,
    model: { provider: "deepseek-official", model: "" },
    lastBanner: { tag: "", text: "", running: false, multi: false },
  };

  /* ---------------- DOM ---------------- */
  const el = (id) => document.getElementById(id);

  function ensureZenDom() {
    if (Z.built) return;
    const root = el("zenRoot");
    root.innerHTML =
      '<div class="zen-bg"></div>' +
      '<header class="zen-head">' +
      '  <button type="button" class="zen-back" id="zenBack"><span class="zb-arrow">←</span><span data-i18n="返回">返回</span></button>' +
      '  <div class="zen-archive"><b class="zen-name" id="zenName">Zen</b><span class="zen-phase" id="zenPhase" data-i18n="探索">探索</span></div>' +
      '  <span class="zen-save" id="zenSave" data-i18n="已保存">已保存</span>' +
      '  <div class="zen-actions">' +
      '    <select id="zenModelSel" class="zen-model-sel" data-i18n-title="模型选择：本次提问使用的模型" title="模型选择：本次提问使用的模型"></select>' +
      '    <button type="button" class="zen-btn" id="zenArchiveBtn" data-i18n="存档">存档</button>' +
      '    <button type="button" class="zen-btn" id="zenNewBtn2" data-i18n="新建">新建</button>' +
      '    <button type="button" class="zen-btn" id="zenPlanBtn" data-i18n="计划">计划</button>' +
      '    <button type="button" class="zen-btn" id="zenBackupBtn" data-i18n="备份">备份</button>' +
      '    <button type="button" class="zen-btn danger" id="zenDeleteBtn" data-i18n="删除">删除</button>' +
      '    <button type="button" class="zen-btn primary" id="zenBuildBtn" data-i18n="构建画布">构建画布</button>' +
      "  </div>" +
      "</header>" +
      '<div class="zen-body" id="zenBody">' +
      '  <svg class="zen-edges" id="zenEdges"></svg>' +
      '  <div class="zen-stage" id="zenStage"></div>' +
      '  <div class="zen-banner" id="zenBanner" hidden aria-live="polite">' +
      '    <div class="zen-banner-tag"><span class="zb-dot"></span><span id="zenBannerTag"></span></div>' +
      '    <div class="zen-banner-text" id="zenBannerText"></div>' +
      '    <div class="zb-multi" id="zenBannerMulti" hidden data-i18n="可多选">可多选</div>' +
      "  </div>" +
      '  <div class="zen-toasts" id="zenToasts"></div>' +
      '  <div class="zen-plan" id="zenPlan" hidden>' +
      '    <div class="zen-plan-head">' +
      '      <b data-i18n="计划">计划</b>' +
      '      <span class="zen-plan-sub" id="zenPlanSub"></span>' +
      '      <div class="zen-plan-tabs">' +
      '        <button type="button" class="zen-plan-tab on" data-tab="edit" data-i18n="编辑">编辑</button>' +
      '        <button type="button" class="zen-plan-tab" data-tab="view" data-i18n="预览">预览</button>' +
      "      </div>" +
      '      <button type="button" class="zen-plan-x" id="zenPlanX">✕</button>' +
      "    </div>" +
      '    <div class="zen-plan-body">' +
      '      <textarea class="zen-plan-edit" id="zenPlanEdit" spellcheck="false"></textarea>' +
      '      <div class="zen-plan-view" id="zenPlanView" hidden></div>' +
      "    </div>" +
      '    <div class="zen-plan-foot">' +
      '      <button type="button" class="zen-btn" id="zenPlanRecompile" data-i18n="重新编译计划">重新编译计划</button>' +
      '      <button type="button" class="zen-btn primary" id="zenPlanBuild" data-i18n="构建画布">构建画布</button>' +
      '      <span class="zen-plan-note" id="zenPlanNote"></span>' +
      "    </div>" +
      "  </div>" +
      '  <div class="zen-picker" id="zenPicker" hidden>' +
      '    <div class="zen-picker-box">' +
      '      <div class="zen-picker-head"><b data-i18n="禅模式">禅模式</b><span data-i18n="选择或新建存档">选择或新建存档</span><span class="zp-hint" data-i18n="Esc 返回主界面">Esc 返回主界面</span></div>' +
      '      <div class="zen-picker-list" id="zenPickerList"></div>' +
      '      <div class="zen-picker-new">' +
      '        <input id="zenNewName" type="text" maxlength="40" data-i18n-placeholder="新存档名称…" placeholder="新存档名称…">' +
      '        <button type="button" id="zenNewBtn" data-i18n="新建">新建</button>' +
      '        <button type="button" class="zen-picker-cancel" id="zenPickerCancel" data-i18n="取消">取消</button>' +
      "      </div>" +
      "    </div>" +
      "  </div>" +
      '  <div class="zen-menu" id="zenBackupMenu" hidden>' +
      '    <div class="zen-menu-head"><b data-i18n="版本备份">版本备份</b></div>' +
      '    <div class="zen-menu-body" id="zenBackupList"></div>' +
      '    <div class="zen-menu-foot">' +
      '      <button type="button" id="zenBackupNow" data-i18n="立即备份">立即备份</button>' +
      '      <button type="button" class="zm-now" id="zenBackupClose" data-i18n="关闭">关闭</button>' +
      "    </div>" +
      "  </div>" +
      "</div>" +
      '<div class="zen-session" id="zenSession">' +
      '  <button type="button" class="zen-session-handle" id="zenSessionHandle">' +
      '    <span class="zsh-txt" data-i18n="输入">输入</span><span class="zsh-chev">▾</span>' +
      "  </button>" +
      '  <div class="zen-session-inner">' +
      '    <textarea class="zen-input" id="zenInput" rows="2" data-i18n-placeholder="补充想法、约束或直接回答…" placeholder="补充想法、约束或直接回答…"></textarea>' +
      '    <button type="button" class="zen-submit" id="zenSubmit" data-i18n="提交">提交</button>' +
      "  </div>" +
      '  <div class="zen-session-hint" id="zenSessionHint"><span><kbd>1-6</kbd> <span data-i18n="选择">选择</span> · <kbd>Enter</kbd> <span data-i18n="提交">提交</span> · <kbd>Esc</kbd> <span data-i18n="返回">返回</span></span></div>' +
      "</div>";
    Z.built = true;
    bindZenEvents();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindZenEvents() {
    const body = el("zenBody");
    const stage = el("zenStage");
    el("zenBack").onclick = () => ZenMode.close();
    el("zenArchiveBtn").onclick = () => showZenPicker();
    el("zenNewBtn2").onclick = () => createNewZenFromHead();
    el("zenPlanBtn").onclick = () => toggleZenPlan();
    el("zenPlanX").onclick = () => setZenPlanOpen(false);
    el("zenBackupBtn").onclick = () => toggleZenBackupMenu();
    el("zenBackupClose").onclick = () => hideZenBackupMenu();
    el("zenBackupNow").onclick = () => zenBackupNow();
    el("zenDeleteBtn").onclick = () => deleteZenArchive();
    el("zenBuildBtn").onclick = () => buildZenCanvas();
    el("zenPlanBuild").onclick = () => buildZenCanvas();
    el("zenPlanRecompile").onclick = () => recompileZenPlan();
    el("zenPlanEdit").addEventListener("input", () => {
      Z.doc.planMarkdown = el("zenPlanEdit").value;
      markDirty();
      clearTimeout(Z.planTimer);
      Z.planTimer = setTimeout(() => syncPlanToGraph(), 900);
    });
    el("zenPlan").querySelectorAll(".zen-plan-tab").forEach((b) => {
      b.onclick = () => {
        Z.planTab = b.dataset.tab;
        renderZenPlan();
      };
    });
    el("zenSubmit").onclick = () => submitZenAnswer();
    el("zenInput").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        submitZenAnswer();
      }
    });
    /* 会话输入框 ↔ 第 6 个「自定义」选项 双向同步 */
    el("zenInput").addEventListener("input", () => {
      if (!Z.open || !Z.doc) return;
      const custom = findCustomOption();
      if (!custom) return;
      const v = el("zenInput").value;
      custom.title = v;
      markDirty();
      const inp = document.querySelector(
        '#zenStage .zen-node[data-nid="' + custom.id + '"] .zn-title-input',
      );
      if (inp && document.activeElement !== inp) inp.value = v;
      if (String(v).trim()) {
        const ask = zenNode(Z.activeAskId);
        if (ask && custom.parentId === ask.id) {
          if (ask.payload && !ask.payload.multiSelect) Z.selOptions.clear();
          Z.selOptions.add(custom.id);
          syncOptionSelVisuals();
        }
      } else {
        Z.selOptions.delete(custom.id);
        syncOptionSelVisuals();
      }
    });
    el("zenSessionHandle").onclick = () => {
      Z.sessionCollapsed = !Z.sessionCollapsed;
      el("zenSession").classList.toggle("collapsed", Z.sessionCollapsed);
    };
    el("zenNewBtn").onclick = () => createZenFromPicker();
    el("zenNewName").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        createZenFromPicker();
      }
    });
    el("zenPickerCancel").onclick = () => hideZenPicker();
    el("zenPicker").addEventListener("click", (ev) => {
      if (ev.target === el("zenPicker")) hideZenPicker();
    });
    el("zenModelSel").onchange = () => {
      const v = el("zenModelSel").value || "deepseek-official|";
      const i = v.indexOf("|");
      Z.model = { provider: v.slice(0, i), model: v.slice(i + 1) };
    };

    /* 相机：滚轮缩放（以光标为中心） */
    body.addEventListener(
      "wheel",
      (ev) => {
        if (!Z.open || !Z.doc) return;
        if (ev.target.closest(".zen-plan, .zen-picker, .zen-menu")) return;
        if (ev.target.closest(".zen-node, .zen-hub")) return;
        ev.preventDefault();
        const rect = body.getBoundingClientRect();
        const mx = ev.clientX - rect.left,
          my = ev.clientY - rect.top;
        const nz = Math.min(2.2, Math.max(0.18, Z.cam.z * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
        const ratio = nz / Z.cam.z;
        Z.cam.x = mx - (mx - Z.cam.x) * ratio;
        Z.cam.y = my - (my - Z.cam.y) * ratio;
        Z.cam.z = nz;
        applyZenTransformSoon();
      },
      { passive: false },
    );
    /* 相机：空白处左键 / 中键平移；节点/Hub 交给独立拖动 */
    body.addEventListener("mousedown", (ev) => {
      if (!Z.open || !Z.doc) return;
      if (ev.target.closest(".zen-node, .zen-hub, .zen-plan, .zen-picker, .zen-menu, .zen-session, .zen-banner")) return;
      if (ev.button !== 0 && ev.button !== 1) return;
      ev.preventDefault();
      Z.drag = {
        sx: ev.clientX,
        sy: ev.clientY,
        px: Z.cam.x,
        py: Z.cam.y,
        moved: false,
      };
      body.classList.add("zen-panning");
    });
    /* 节点拖动：选项节点 / 分支 / Hub 均可按住拖动（吸附网格） */
    stage.addEventListener("mousedown", (ev) => {
      if (!Z.open || !Z.doc || ev.button !== 0) return;
      if (!el("zenPicker").hidden || !el("zenBackupMenu").hidden) return;
      const wrap = ev.target.closest(".zen-node-wrap, .zen-hub-wrap");
      if (!wrap || !wrap.dataset.nid) return;
      if (ev.target.closest(".zn-rollback, .zn-title-input")) return;
      const n = zenNode(wrap.dataset.nid);
      if (!n) return;
      ev.preventDefault();
      ev.stopPropagation();
      Z.nodeDrag = {
        id: n.id,
        sx: ev.clientX,
        sy: ev.clientY,
        ox: n.x,
        oy: n.y,
        moved: false,
      };
      body.classList.add("zen-dragging");
    });
    window.addEventListener("mousemove", (ev) => {
      const nd = Z.nodeDrag;
      if (nd) {
        if (ev.buttons !== undefined && (ev.buttons & 1) === 0) {
          Z.nodeDrag = null;
          body.classList.remove("zen-dragging");
          return;
        }
        const z = Z.cam.z > 0 ? Z.cam.z : 1;
        const dx = (ev.clientX - nd.sx) / z,
          dy = (ev.clientY - nd.sy) / z;
        if (Math.abs(ev.clientX - nd.sx) + Math.abs(ev.clientY - nd.sy) > 2)
          nd.moved = true;
        const n = zenNode(nd.id);
        if (n) {
          n.x = zenSnap(nd.ox + dx);
          n.y = zenSnap(nd.oy + dy);
          const wrap = stage.querySelector(
            '.zen-node-wrap[data-nid="' + nd.id + '"], .zen-hub-wrap[data-nid="' + nd.id + '"]',
          );
          if (wrap) {
            wrap.style.left = n.x + "px";
            wrap.style.top = n.y + "px";
          }
          renderZenEdges();
        }
        return;
      }
      const d = Z.drag;
      if (!d) return;
      if (ev.buttons !== undefined && (ev.buttons & 5) === 0) {
        Z.drag = null;
        body.classList.remove("zen-panning");
        return;
      }
      const dx = ev.clientX - d.sx,
        dy = ev.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      Z.cam.x = d.px + dx;
      Z.cam.y = d.py + dy;
      applyZenTransformSoon();
    });
    window.addEventListener("mouseup", (ev) => {
      const nd = Z.nodeDrag;
      if (nd) {
        Z.nodeDrag = null;
        body.classList.remove("zen-dragging");
        if (nd.moved) {
          Z._zenDragMoved = true;
          markDirty();
        }
        return;
      }
      if (!Z.drag) return;
      Z.drag = null;
      body.classList.remove("zen-panning");
      persistZenCam();
    });

    /* 舞台点击：Hub 播放 / 选项选择/编辑 / 分支聚焦 / 回滚（拖动后抑制点击） */
    stage.addEventListener("click", (ev) => {
      if (!Z.open || !Z.doc) return;
      if (Z._zenDragMoved) {
        Z._zenDragMoved = false;
        return;
      }
      const hubEl = ev.target.closest(".zen-hub");
      if (hubEl) {
        onHubClick();
        return;
      }
      const nodeEl = ev.target.closest(".zen-node");
      if (!nodeEl) return;
      const id = nodeEl.dataset.nid;
      const n = zenNode(id);
      if (!n) return;
      /* 点击标题输入框 → 编辑（不触发选中） */
      if (ev.target.closest(".zn-title-input")) return;
      if (ev.target.closest(".zn-rollback")) {
        rollbackZenNode(id);
        return;
      }
      if (n.status === "options") {
        /* 属于非焦点提问节点的选项：先聚焦其父提问，再选中 */
        if (n.parentId !== Z.activeAskId && zenNode(n.parentId)) {
          focusAskNode(n.parentId);
        }
        /* 留空的自定义槽：点击进入编辑 */
        if (n.payload && n.payload.isCustom && !String(n.title || "").trim()) {
          const inp = nodeEl.querySelector(".zn-title-input");
          if (inp) inp.focus();
          return;
        }
        toggleSelectOption(id, ev.ctrlKey || ev.metaKey || ev.shiftKey);
      } else if (
        (n.kind === "branch" || n.kind === "option") &&
        (n.status === "asking" || n.status === "ready")
      ) {
        focusAskNode(id);
      } else if (n.status === "done") {
        zenToast(I18n.t("点击节点上的「回滚」可撤销该分支"), "warn");
      }
    });

    /* 选项标题内联编辑 */
    stage.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t || !t.classList || !t.classList.contains("zn-title-input")) return;
      const n = zenNode(t.dataset.nid);
      if (!n) return;
      n.title = t.value;
      /* 自定义空槽：同时回填会话输入框 */
      if (n.payload && n.payload.isCustom) {
        const zi = el("zenInput");
        if (zi && document.activeElement !== zi) zi.value = t.value;
      }
      markDirty();
      /* 有内容即自动选中该选项（单选则替换） */
      if (String(t.value).trim()) {
        const ask = zenNode(Z.activeAskId);
        if (ask && n.parentId === ask.id) {
          if (ask.payload && !ask.payload.multiSelect) Z.selOptions.clear();
          Z.selOptions.add(n.id);
          syncOptionSelVisuals();
        }
      } else if (n.payload && n.payload.isCustom) {
        Z.selOptions.delete(n.id);
        syncOptionSelVisuals();
      }
    });
    stage.addEventListener("focusout", (ev) => {
      const t = ev.target;
      if (t && t.classList && t.classList.contains("zn-title-input")) {
        renderZenStage();
      }
    });
    stage.addEventListener("keydown", (ev) => {
      const t = ev.target;
      if (t && t.classList && t.classList.contains("zn-title-input") && ev.key === "Enter") {
        ev.preventDefault();
        t.blur();
      }
    });

    /* 全局键盘 */
    document.addEventListener("keydown", (ev) => {
      if (!Z.open || !Z.doc) return;
      const mt = el("mtDialog");
      if (mt && mt.classList.contains("on")) return; /* 确认框优先 */
      if (ev.key === "Escape") {
        if (!el("zenBackupMenu").hidden) {
          hideZenBackupMenu();
          return;
        }
        if (!el("zenPicker").hidden) {
          if (!Z.doc) ZenMode.close();
          else hideZenPicker();
          return;
        }
        ev.preventDefault();
        ZenMode.close();
        return;
      }
      /* 数字 1-6 选择当前选项 */
      if (/^[1-6]$/.test(ev.key) && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        if (!el("zenPicker").hidden || !el("zenBackupMenu").hidden) return;
        const tgt = ev.target;
        if (tgt && (tgt.tagName === "TEXTAREA" || tgt.tagName === "INPUT")) return;
        const opts = activeOptionNodes();
        const n = Number(ev.key) - 1;
        if (opts[n]) toggleSelectOption(opts[n].id, true);
      }
    });
  }

  /* ---------------- 相机 ---------------- */
  function applyZenTransform() {
    const st = el("zenStage");
    if (!st || !Z.open) return;
    st.style.transform =
      "translate(" + Z.cam.x + "px," + Z.cam.y + "px) scale(" + Z.cam.z + ")";
    renderZenEdges();
  }
  function applyZenTransformSoon() {
    if (Z.camRaf) {
      Z.camDirty = true;
      return;
    }
    Z.camRaf = requestAnimationFrame(() => {
      Z.camRaf = 0;
      applyZenTransform();
    });
  }
  function zenToScreen(sx, sy) {
    return { x: Z.cam.x + sx * Z.cam.z, y: Z.cam.y + sy * Z.cam.z };
  }
  function centerZenOn(x, y, z) {
    const body = el("zenBody");
    if (!body) return;
    const r = body.getBoundingClientRect();
    Z.cam.x = r.width / 2 - x * z;
    Z.cam.y = r.height * 0.44 - y * z;
    Z.cam.z = z;
    applyZenTransform();
  }
  function persistZenCam() {
    if (!Z.doc) return;
    Z.doc.cam = { x: Z.cam.x, y: Z.cam.y, z: Z.cam.z };
    markDirty();
  }

  /* ---------------- 节点工具 ---------------- */
  function zenNode(id) {
    return Z.doc ? Z.doc.nodes.find((n) => n.id === id) || null : null;
  }
  function zenChildren(id) {
    return Z.doc.nodes.filter((n) => n.parentId === id);
  }
  function zenDescendants(id) {
    const out = [];
    const walk = (pid) => {
      for (const n of zenChildren(pid)) {
        out.push(n.id);
        walk(n.id);
      }
    };
    walk(id);
    return out;
  }
  function zenEdgeOf(from, to) {
    return Z.doc.edges.find((e) => e.from === from && e.to === to);
  }
  function activeOptionNodes() {
    const ask = zenNode(Z.activeAskId);
    if (!ask) return [];
    return zenChildren(ask.id).filter((n) => n.status === "options");
  }
  /* 当前提问的「自定义」空槽（末位） */
  function findCustomOption() {
    if (!Z.doc || !Z.activeAskId) return null;
    return zenChildren(Z.activeAskId).find(
      (n) => n.status === "options" && n.payload && n.payload.isCustom,
    );
  }
  function hubNode() {
    return Z.doc ? Z.doc.nodes.find((n) => n.kind === "hub") || null : null;
  }
  function zenGraphSummary(maxNodes) {
    if (!Z.doc) return "";
    const lines = [];
    const depthOf = (n) => {
      let d = 0,
        p = n;
      while (p && p.parentId) {
        d++;
        p = zenNode(p.parentId);
      }
      return d;
    };
    const statusTxt = (n) =>
      ({
        hub: "中心",
        asking: "提问中",
        options: "候选",
        ready: "待播放",
        running: "运行中",
        done: "已处理",
        pruned: "已剪枝",
      })[n.status] || n.status;
    const list = Z.doc.nodes.slice(0, Number(maxNodes) || 60);
    for (const n of list) {
      /* 空标题的自定义槽不进入图谱摘要 */
      if (!String(n.title || "").trim() && n.kind !== "hub") continue;
      lines.push(
        "  ".repeat(depthOf(n)) +
          "- [" +
          (n.kind === "hub" ? "HUB" : n.kind === "branch" ? "分支" : "选项") +
          "] " +
          String(n.title || "").slice(0, 40) +
          " (" +
          statusTxt(n) +
          ")",
      );
    }
    return lines.join("\n");
  }
  function zenChatContext() {
    if (!Z.doc) return "";
    const chat = (Z.doc.chat || []).slice(-24);
    return chat
      .map((m) => (m.role === "user" ? "用户：" : "助手：") + String(m.content || "").slice(0, 240))
      .join("\n");
  }
  function zenAnswerDescribe(node) {
    const la = node.payload && node.payload.lastAnswer;
    if (!la) return "";
    const parts = [];
    if (la.labels && la.labels.length) parts.push("选择了：" + la.labels.join("、"));
    if (la.free) parts.push("补充文字：" + la.free);
    return parts.join("；");
  }
  function statusClasses(n) {
    let c = "zen-node";
    if (n.kind === "branch") c += " branch-root";
    if (n.status === "done") c += " done";
    if (n.status === "running") c += " running";
    if (n.status === "asking") c += " asking";
    if (n.id === Z.activeAskId) c += " focused";
    if (n.status === "options" && Z.selOptions.has(n.id)) c += " sel";
    return c;
  }

  /* ---------------- 渲染 ---------------- */
  function renderZenHead() {
    if (!Z.doc) return;
    el("zenName").textContent = Z.doc.name || "Zen";
    const ph = el("zenPhase");
    ph.textContent =
      Z.doc.phase === "plan"
        ? I18n.t("计划")
        : Z.doc.phase === "canvas"
          ? I18n.t("画布")
          : I18n.t("探索");
    ph.className = "zen-phase" + (Z.doc.phase !== "explore" ? " ph-" + Z.doc.phase : "");
    el("zenBuildBtn").disabled = !Z.doc.planMarkdown.trim();
    el("zenPlanBtn").disabled = !Z.doc.planMarkdown.trim();
    updateZenSaveIndicator();
  }
  function updateZenSaveIndicator() {
    const s = el("zenSave");
    if (!s) return;
    if (Z.saving) {
      s.textContent = I18n.t("保存中…");
      s.className = "zen-save saving";
    } else if (Z.dirty) {
      s.textContent = I18n.t("未保存");
      s.className = "zen-save dirty";
    } else {
      s.textContent = I18n.t("已保存");
      s.className = "zen-save";
    }
  }
  function renderZenEdges() {
    const svg = el("zenEdges");
    if (!svg || !Z.doc) return;
    svg.innerHTML = "";
    const draw = (from, to, cls) => {
      const a = zenNode(from),
        b = zenNode(to);
      if (!a || !b) return;
      const pa = zenToScreen(a.x, a.y),
        pb = zenToScreen(b.x, b.y);
      const mx = (pa.x + pb.x) / 2,
        my = (pa.y + pb.y) / 2;
      const dx = pb.x - pa.x,
        dy = pb.y - pa.y;
      const dist = Math.max(40, Math.hypot(dx, dy));
      const bow = Math.min(90, dist * 0.28);
      const cxm = mx - (dy / dist) * bow,
        cym = my + (dx / dist) * bow;
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute(
        "d",
        "M " + pa.x + " " + pa.y + " Q " + cxm + " " + cym + " " + pb.x + " " + pb.y,
      );
      path.setAttribute("class", "zen-edge" + (cls ? " " + cls : ""));
      if (b.status === "options" && Z.selOptions.has(b.id)) path.classList.add("sel");
      svg.appendChild(path);
    };
    /* 1) 常规连线：指向 分支 / 候选选项 / 回滚后的提问根 的边。
       已处理站点不再放射连线，改由「路径链」表达。 */
    for (const e of Z.doc.edges) {
      const b = zenNode(e.to);
      if (!b || b.status === "done") continue;
      draw(e.from, e.to, b.kind === "branch" ? "flow" : "");
    }
    /* 2) 路径链：每个提问根的已处理子节点按选择顺序串联，末端连回该提问根
       （例如 第1选择 → 第2选择 → 主按钮）。 */
    for (const root of Z.doc.nodes) {
      const done = zenChildren(root.id).filter((c) => c.status === "done");
      if (!done.length) continue;
      for (let i = 0; i < done.length; i++) {
        if (i + 1 < done.length) draw(done[i].id, done[i + 1].id, "path");
        else draw(done[i].id, root.id, "path");
      }
    }
  }
  function renderZenBanner() {
    const b = el("zenBanner");
    if (!Z.lastBanner.text && !Z.lastBanner.running) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    b.className =
      "zen-banner" + (Z.lastBanner.running ? " running" : "") + (Z.lastBanner.err ? " err" : "");
    el("zenBannerTag").textContent = Z.lastBanner.tag || "zen";
    el("zenBannerText").textContent = Z.lastBanner.running
      ? I18n.t("正在思考…")
      : Z.lastBanner.text;
    el("zenBannerMulti").hidden = !(Z.lastBanner.multi && !Z.lastBanner.running);
  }
  function renderZenStage() {
    const stage = el("zenStage");
    if (!stage || !Z.doc) return;
    stage.innerHTML = "";
    for (const n of Z.doc.nodes) {
      if (n.status === "pruned" && !n._leaving) continue;
      const wrap = n.kind === "hub" ? hubEl(n) : optionEl(n);
      if (n._leaving) wrap.classList.add("leaving");
      else if (!Z.seenIds.has(n.id)) wrap.classList.add("enter");
      stage.appendChild(wrap);
      Z.seenIds.add(n.id);
    }
    applyZenTransform();
    renderZenBanner();
  }
  function hubEl(n) {
    const wrap = document.createElement("div");
    wrap.className = "zen-hub-wrap";
    wrap.style.left = n.x + "px";
    wrap.style.top = n.y + "px";
    wrap.dataset.nid = n.id;
    const hub = document.createElement("button");
    hub.type = "button";
    hub.className =
      "zen-hub" + (n.status === "running" ? " running" : n.status === "ready" ? " ready" : "");
    const short = escapeHtml(n.display || n.title || "");
    const q =
      n.payload && n.payload.question ? escapeHtml(n.payload.question) : "";
    let screenInner;
    if (n.status === "running") {
      screenInner = '<div class="zh-display">…</div>';
    } else if (n.status === "hub") {
      screenInner = '<div class="zh-display">' + I18n.t("点击开始") + "</div>";
    } else if (q) {
      screenInner =
        '<div class="zh-display">' + short + '</div><div class="zh-q">' + q + "</div>";
    } else {
      screenInner = '<div class="zh-display">' + short + "</div>";
    }
    const footTxt =
      n.status === "running"
        ? I18n.t("思考中")
        : n.status === "ready"
          ? I18n.t("待播放")
          : n.status === "hub"
            ? I18n.t("就绪")
            : I18n.t("中心");
    hub.innerHTML =
      '<div class="zh-screen">' +
      screenInner +
      '</div><div class="zh-foot"><span class="zh-led"></span><span class="zh-foot-txt">' +
      footTxt +
      '</span><span class="zh-play">▶ ' +
      I18n.t("播放") +
      "</span></div>";
    wrap.appendChild(hub);
    return wrap;
  }
  function optionEl(n) {
    const wrap = document.createElement("div");
    wrap.className = "zen-node-wrap";
    wrap.style.left = n.x + "px";
    wrap.style.top = n.y + "px";
    wrap.dataset.nid = n.id;
    const box = document.createElement("div");
    box.className = statusClasses(n);
    box.dataset.nid = n.id;
    if (n.payload && n.payload.isCustom && !String(n.title || "").trim()) {
      box.classList.add("custom");
    }
    const isOpt = n.status === "options";
    const isAskRoot = n.id === Z.activeAskId;
    const isMulti = n.parentId && zenNode(n.parentId) && zenNode(n.parentId).payload && zenNode(n.parentId).payload.multiSelect;
    const label = isOpt
      ? isMulti
        ? I18n.t("可选 · 点击选择")
        : I18n.t("点击选择")
      : n.status === "done"
        ? I18n.t("已处理")
        : n.status === "running"
          ? I18n.t("思考中")
          : isAskRoot
            ? I18n.t("当前提问")
            : n.kind === "branch"
              ? I18n.t("分支提问")
              : I18n.t("候选");
    const statusLine =
      n.status === "running"
        ? '<span class="zn-prog">…</span>'
        : escapeHtml(
            n.status !== "done" && (n.kind === "branch" || isAskRoot)
              ? I18n.t("点击继续")
              : "",
          );
    /* 快捷键数字徽标：仅候选选项显示（1-6） */
    let numBadge = "";
    if (isOpt) {
      const idx = activeOptionNodes().findIndex((x) => x.id === n.id);
      if (idx >= 0) numBadge = '<span class="zn-num">' + (idx + 1) + "</span>";
    }
    /* 标题：候选选项可内联编辑；已处理/提问根/分支节点只读 */
    const titleTag = isOpt
      ? '<input class="zn-title-input" type="text" data-nid="' +
        escapeHtml(n.id) +
        '" value="' +
        escapeHtml(n.title || "") +
        '" placeholder="' +
        I18n.t("输入你的答案…") +
        '" maxlength="40">'
      : '<div class="zn-title">' + escapeHtml(n.title || "") + "</div>";
    box.innerHTML =
      '<div class="zn-label"><span class="zn-check">✓</span>' +
      escapeHtml(label) +
      "</div>" +
      titleTag +
      (n.hint ? '<div class="zn-hint">' + escapeHtml(n.hint || "") + "</div>" : "") +
      numBadge +
      '<div class="zn-status"><span class="zn-dot"></span>' +
      statusLine +
      (n.status === "done"
        ? '<button type="button" class="zn-rollback">↺ ' + I18n.t("回滚") + "</button>"
        : "") +
      "</div>" +
      (n.payload && n.payload.mapInfo
        ? '<div class="zn-map"><span class="zn-map-dot"></span>' +
          escapeHtml(n.payload.mapInfo) +
          "</div>"
        : "");
    wrap.appendChild(box);
    return wrap;
  }

  function renderZen() {
    if (!Z.open || !Z.doc) return;
    renderZenHead();
    renderZenStage();
    renderZenPlan();
  }

  /* ---------------- Banner / Toast ---------------- */
  function setZenBanner(tag, text, opts) {
    Z.lastBanner = Object.assign({ tag: tag || "", text: text || "", running: false, multi: false, err: false }, opts || {});
    renderZenBanner();
  }
  function zenToast(msg, kind) {
    const box = el("zenToasts");
    if (!box) return;
    const d = document.createElement("div");
    d.className = "zen-toast" + (kind ? " " + kind : "");
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => d.remove(), 3600);
  }

  /* ---------------- 持久化 ---------------- */
  function markDirty() {
    Z.dirty = true;
    updateZenSaveIndicator();
    clearTimeout(Z.saveTimer);
    Z.saveTimer = setTimeout(flushZenSave, SAVE_DEBOUNCE);
  }
  async function flushZenSave() {
    clearTimeout(Z.saveTimer);
    Z.saveTimer = null;
    if (!Z.doc || !Z.dirty || Z.saving) return;
    /* 相机落档 */
    Z.doc.cam = { x: Z.cam.x, y: Z.cam.y, z: Z.cam.z };
    Z.saving = true;
    updateZenSaveIndicator();
    try {
      await window.api.zenSave(Z.doc.id, Z.doc);
      Z.dirty = false;
    } catch (e) {
      zenToast(I18n.t("保存失败：") + ((e && e.message) || String(e)), "err");
    }
    Z.saving = false;
    updateZenSaveIndicator();
  }
  async function zenBackupNow() {
    if (!Z.doc) return;
    try {
      await flushZenSave();
      const r = await window.api.zenBackup(Z.doc.id);
      if (r && r.ok) {
        zenToast(I18n.t("已创建版本备份"), "ok");
        if (!el("zenBackupMenu").hidden) renderZenBackupMenu();
      } else if (r && r.error) {
        zenToast(r.error, "err");
      }
    } catch (e) {
      zenToast(I18n.t("备份失败：") + ((e && e.message) || String(e)), "err");
    }
  }
  function startZenTimers() {
    clearInterval(Z.backupTimer);
    Z.backupTimer = setInterval(() => {
      if (Z.open && Z.doc && !Z.saving) zenBackupNow();
    }, BACKUP_EVERY);
    clearInterval(Z.progressTimer);
    Z.progressTimer = setInterval(() => {
      if (Z.open && Z.doc && Z.doc.phase === "canvas") renderZenPlanProgress();
    }, 3000);
  }
  function stopZenTimers() {
    clearInterval(Z.backupTimer);
    clearInterval(Z.progressTimer);
    Z.backupTimer = null;
    Z.progressTimer = null;
  }
  window.addEventListener("beforeunload", () => {
    if (Z.dirty && Z.doc) {
      try {
        window.api.zenSave(Z.doc.id, Z.doc);
      } catch (_) {}
    }
  });

  /* ---------------- 模型选择 ---------------- */
  function populateZenModelSel() {
    const sel = el("zenModelSel");
    if (!sel) return;
    sel.innerHTML = "";
    const entries = [];
    const addEntry = (provider, model, label) => {
      if (!model) return;
      if (!entries.some((e) => e.provider === provider && e.model === model)) {
        entries.push({ provider, model, label });
      }
    };
    /* DeepSeek 官方路由：优先配置的服务商模型，否则目录默认 */
    let dp = null;
    try {
      dp = dshProvider();
    } catch (_) {}
    if (dp && Array.isArray(dp.models) && dp.models.length) {
      const dn = dp.name || "DeepSeek";
      for (const m of dp.models) addEntry("deepseek-official", String(m), dn + " · " + String(m));
    } else {
      const catalog = (S.providerCatalog && S.providerCatalog.deepseek) || [
        { id: "deepseek-v4-flash" },
        { id: "deepseek-v4-pro" },
      ];
      for (const m of catalog)
        addEntry("deepseek-official", m.id, I18n.t("DeepSeek 官方") + " · " + m.id);
    }
    /* MTNode 自定义服务商 */
    let pi = [];
    try {
      pi = mtnodePiProviders();
    } catch (_) {}
    for (const p of pi) {
      for (const m of p.models || []) {
        addEntry("mtnode_" + p.route, String(m), (p.name || p.route) + " · " + String(m));
      }
    }
    if (!entries.length) {
      sel.hidden = true;
      Z.model = { provider: "deepseek-official", model: "" };
      return;
    }
    sel.hidden = false;
    for (const e of entries) {
      const o = document.createElement("option");
      o.value = e.provider + "|" + e.model;
      o.textContent = e.label;
      sel.appendChild(o);
    }
    /* 默认：优先沿用配置里的默认模型 */
    const prefer = (S.config && S.config.dsh && S.config.dsh.model) || "";
    const hit = prefer ? entries.find((e) => e.model === prefer) : null;
    if (hit) sel.value = hit.provider + "|" + hit.model;
    const v = sel.value || "deepseek-official|";
    const i = v.indexOf("|");
    Z.model = { provider: v.slice(0, i), model: v.slice(i + 1) };
  }

  /* ---------------- 存档选择器 ---------------- */
  async function showZenPicker() {
    if (!Z.open) return;
    el("zenBackupMenu").hidden = true;
    const list = await window.api.zenList().catch(() => []);
    Z.picking = true;
    el("zenPicker").hidden = false;
    renderZenPickerList(list);
    setTimeout(() => {
      try {
        el("zenNewName").focus();
      } catch (_) {}
    }, 30);
  }
  function hideZenPicker() {
    el("zenPicker").hidden = true;
    Z.picking = false;
    renderZen();
  }
  function renderZenPickerList(list) {
    const box = el("zenPickerList");
    box.innerHTML = "";
    const items = list || [];
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "zen-picker-empty";
      d.textContent = I18n.t("还没有存档，输入名称开始");
      box.appendChild(d);
      return;
    }
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "zen-pick-item" + (it.phase !== "explore" ? " ph-" + it.phase : "");
      row.innerHTML =
        '<span class="zpi-mark"></span>' +
        '<span class="zpi-main"><span class="zpi-name">' +
        escapeHtml(it.name || it.id) +
        '</span><span class="zpi-meta">' +
        escapeHtml(
          (it.phase === "canvas" ? I18n.t("画布") : it.phase === "plan" ? I18n.t("计划") : I18n.t("探索")) +
            " · " +
            (it.nodes || 0) +
            " " +
            I18n.t("节点") +
            " · " +
            zenFmtTime(it.mtime),
        ) +
        "</span></span>";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "zpi-del";
      del.textContent = "✕";
      del.title = I18n.t("删除存档");
      del.onclick = async (ev) => {
        ev.stopPropagation();
        const ok = await confirmDialog(I18n.t("删除存档「{name}」？备份也将一并删除。", { name: it.name }), {
          title: I18n.t("删除存档"),
          danger: true,
          okText: I18n.t("删除"),
        });
        if (!ok) return;
        await window.api.zenDelete(it.id).catch(() => {});
        if (Z.doc && Z.doc.id === it.id) {
          Z.doc = null;
          el("zenStage").innerHTML = "";
        }
        showZenPicker();
      };
      row.appendChild(del);
      row.onclick = async () => {
        const r = await window.api.zenLoad(it.id);
        if (!r || !r.ok) {
          zenToast(I18n.t("打开存档失败"), "err");
          return;
        }
        adoptZenDoc(r.data);
        hideZenPicker();
      };
      box.appendChild(row);
    }
  }
  function zenFmtTime(t) {
    if (!t) return "";
    const d = new Date(t);
    const p = (v) => String(v).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  async function createNewZenFromHead() {
    const name = await promptDialog(I18n.t("新存档名称"), "", {
      title: I18n.t("新建禅模式存档"),
      okText: I18n.t("创建"),
      placeholder: I18n.t("新存档名称…"),
    });
    if (name === null) return;
    await createZenDoc(name.trim());
  }
  async function createZenFromPicker() {
    const v = el("zenNewName").value.trim();
    if (!v) {
      zenToast(I18n.t("先输入存档名称"), "warn");
      return;
    }
    el("zenNewName").value = "";
    await createZenDoc(v);
  }
  async function createZenDoc(name) {
    try {
      const r = await window.api.zenCreate(name || "");
      if (!r || !r.ok) throw new Error((r && r.error) || "create failed");
      adoptZenDoc(r.data);
      hideZenPicker();
      zenToast(I18n.t("已创建存档：") + (r.data.name || ""), "ok");
    } catch (e) {
      zenToast(I18n.t("创建失败：") + ((e && e.message) || String(e)), "err");
    }
  }
  async function deleteZenArchive() {
    if (!Z.doc) return;
    const ok = await confirmDialog(
      I18n.t("删除当前禅模式存档「{name}」？其版本备份也将一并删除。", { name: Z.doc.name }),
      { title: I18n.t("删除当前存档"), danger: true, okText: I18n.t("删除") },
    );
    if (!ok) return;
    const id = Z.doc.id;
    await window.api.zenDelete(id).catch(() => {});
    Z.doc = null;
    Z.activeAskId = null;
    Z.hubId = null;
    Z.selOptions = new Set();
    el("zenStage").innerHTML = "";
    el("zenEdges").innerHTML = "";
    el("zenBanner").hidden = true;
    setZenPlanOpen(false);
    zenToast(I18n.t("已删除禅模式存档"), "ok");
    /* 仍有存档则回到选择器，否则退出禅模式 */
    const list = await window.api.zenList().catch(() => []);
    if (list.length) {
      await showZenPicker();
    } else {
      await ZenMode.close();
    }
  }
  /* 多按钮选择对话框（复用 #mtDialog，Esc = null） */
  function zenChoiceDialog(title, message, choices) {
    return new Promise((resolve) => {
      const host = ensureMtDialog();
      const seq = ++_mtDialogSeq;
      const titleEl = document.getElementById("mtDlgTitle");
      const body = document.getElementById("mtDlgBody");
      const foot = document.getElementById("mtDlgFoot");
      if (titleEl) titleEl.textContent = title;
      if (body) {
        body.innerHTML = "";
        const p = document.createElement("p");
        p.className = "mt-dialog-msg";
        p.textContent = message;
        body.appendChild(p);
      }
      if (foot) foot.innerHTML = "";
      let done = false;
      const finish = (v) => {
        if (done || seq !== _mtDialogSeq) return;
        done = true;
        host.removeEventListener("keydown", onKey);
        closeMtDialog();
        resolve(v);
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          finish(null);
        }
      };
      (choices || []).forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = c.danger ? "mini danger" : c.primary ? "mini primary" : "mini";
        b.textContent = c.label;
        b.onclick = () => finish(c.value);
        foot.appendChild(b);
      });
      host.classList.add("on");
      host.addEventListener("keydown", onKey);
      setTimeout(() => {
        try {
          const st = foot.querySelector("button");
          if (st) st.focus();
        } catch (_) {}
      }, 0);
    });
  }
  /* Fork：把当前存档复制为新画布，每个选中分支成为一条旁路（branch） */
  async function forkZenArchive(labels) {
    if (!Z.doc) return;
    await flushZenSave();
    const base = JSON.parse(JSON.stringify(Z.doc));
    let r = null;
    try {
      r = await window.api.zenCreate((Z.doc.name || "Zen") + " · " + I18n.t("分支"));
    } catch (e) {
      zenToast(I18n.t("创建失败：") + ((e && e.message) || String(e)), "err");
      return;
    }
    if (!r || !r.ok) {
      zenToast(I18n.t("创建失败：") + ((r && r.error) || "create failed"), "err");
      return;
    }
    const fork = r.data;
    const askId = Z.activeAskId;
    const askRoot = zenNode(askId);
    /* 复制历史：排除当前提问根仍挂着的候选选项 */
    const keepIds = new Set(
      Z.doc.nodes
        .filter((n) => !(n.parentId === askId && n.status === "options"))
        .map((n) => n.id),
    );
    fork.cam = base.cam
      ? { x: base.cam.x, y: base.cam.y, z: base.cam.z }
      : { x: 0, y: 0, z: 1 };
    fork.chat = (base.chat || []).slice();
    fork.planMarkdown = base.planMarkdown || "";
    fork.projectFolder = base.projectFolder || "";
    fork.phase = base.phase === "canvas" ? "plan" : base.phase || "explore";
    fork.workflowId = "";
    fork.planNodeMap = {};
    fork.nodes = JSON.parse(
      JSON.stringify(Z.doc.nodes.filter((n) => keepIds.has(n.id))),
    );
    fork.edges = JSON.parse(
      JSON.stringify(
        (Z.doc.edges || []).filter((e) => keepIds.has(e.from) && keepIds.has(e.to)),
      ),
    );
    const hubFork = fork.nodes.find((n) => n.kind === "hub") || fork.nodes[0] || null;
    const hx = hubFork ? hubFork.x : 0;
    const hy = hubFork ? hubFork.y : 0;
    const sk = (askRoot && askRoot.skillId) || ZEN_SKILL_IDS.bootstrap;
    let bx = zenSnap(hx + 380);
    for (const label of labels || []) {
      const br = {
        id: zenUid("zf"),
        kind: "branch",
        x: bx,
        y: zenSnap(hy + 80),
        w: 216,
        h: 104,
        title: String(label || "").slice(0, 22),
        display: String(label || "").slice(0, 22),
        status: "asking",
        skillId: sk,
        parentId: hubFork ? hubFork.id : "",
        selectedOptionIds: [],
        payload: { forkLabel: String(label || "") },
      };
      fork.nodes.push(br);
      if (hubFork) fork.edges.push({ from: hubFork.id, to: br.id });
      bx += 240;
    }
    await window.api.zenSave(fork.id, fork).catch(() => {});
    zenToast(I18n.t("已创建分支画布：") + fork.name, "ok");
    adoptZenDoc(fork);
  }
  function adoptZenDoc(doc) {
    /* 存档前先落盘当前存档 */
    flushZenSave();
    const wasFresh = !Array.isArray(doc.nodes) || doc.nodes.length === 0;
    Z.doc = doc;
    normalizeZenDoc(doc);
    populateZenModelSel();
    Z.hubId = hubNode() ? hubNode().id : null;
    Z.activeAskId = null;
    Z.selOptions = new Set();
    Z.sessionCollapsed = false;
    el("zenSession").classList.remove("collapsed");
    el("zenInput").value = "";
    /* 新存档 / 旧版默认镜头(0,0,1) / 损坏镜头：Hub 居中；否则恢复上次镜头 */
    const camIsDefault =
      !doc.cam ||
      typeof doc.cam.x !== "number" ||
      typeof doc.cam.y !== "number" ||
      typeof doc.cam.z !== "number" ||
      !isFinite(doc.cam.x) ||
      !isFinite(doc.cam.y) ||
      !isFinite(doc.cam.z) ||
      (Math.abs(doc.cam.x) < 4 &&
        Math.abs(doc.cam.y) < 4 &&
        Math.abs(doc.cam.z - 1) < 0.05);
    if (!wasFresh && !camIsDefault) {
      Z.cam = { x: doc.cam.x, y: doc.cam.y, z: doc.cam.z };
    } else if (Z.hubId) {
      const h = zenNode(Z.hubId);
      centerZenOn(h.x, h.y, 1);
    }
    const h = hubNode();
    if (h && h.status !== "running") {
      Z.activeAskId = h.id;
      if (h.status === "ready") {
        setZenBanner(
          h.skillId || ZEN_SKILL_IDS.bootstrap,
          (h.payload && h.payload.question) || h.display || h.title || "",
        );
        const opts = activeOptionNodes();
        Z.lastBanner.multi = !!(h.payload && h.payload.multiSelect && opts.length);
      }
    }
    renderZen();
    applyZenTransform();
    if (!Z.doc.planMarkdown) Z.doc.planMarkdown = "";
  }
  function normalizeZenDoc(doc) {
    if (!Array.isArray(doc.nodes)) doc.nodes = [];
    if (!Array.isArray(doc.edges)) doc.edges = [];
    if (!Array.isArray(doc.chat)) doc.chat = [];
    if (typeof doc.planMarkdown !== "string") doc.planMarkdown = "";
    if (!doc.phase) doc.phase = "explore";
    if (!Array.isArray(doc.activeNodeIds)) doc.activeNodeIds = [];
    for (const n of doc.nodes) {
      if (!n.payload) n.payload = {};
      if (!Array.isArray(n.selectedOptionIds)) n.selectedOptionIds = [];
      if (!n.status) n.status = "options";
    }
    /* 全新存档：种入中央 Hub */
    if (!doc.nodes.some((n) => n.kind === "hub")) {
      doc.nodes.unshift({
        id: zenUid("zh"),
        kind: "hub",
        x: 0,
        y: 0,
        w: 300,
        h: 200,
        title: doc.name || "Zen",
        display: I18n.t("点击开始"),
        status: "hub",
        skillId: ZEN_SKILL_IDS.bootstrap,
        parentId: "",
        selectedOptionIds: [],
        payload: {},
      });
      doc.phase = "explore";
    }
  }

  /* ---------------- 备份菜单 ---------------- */
  function toggleZenBackupMenu() {
    const m = el("zenBackupMenu");
    if (m.hidden) {
      m.hidden = false;
      renderZenBackupMenu();
    } else hideZenBackupMenu();
  }
  function hideZenBackupMenu() {
    el("zenBackupMenu").hidden = true;
  }
  async function renderZenBackupMenu() {
    const box = el("zenBackupList");
    box.innerHTML = "";
    if (!Z.doc) return;
    const r = await window.api.zenListBackups(Z.doc.id).catch(() => null);
    const list = (r && r.ok && r.list) || [];
    if (!list.length) {
      const d = document.createElement("div");
      d.className = "zen-menu-empty";
      d.textContent = I18n.t("暂无备份（每 10 分钟自动备份）");
      box.appendChild(d);
      return;
    }
    for (const b of list) {
      const row = document.createElement("div");
      row.className = "zen-menu-item";
      row.innerHTML =
        '<span class="zmi-time">' +
        escapeHtml(zenFmtTime(b.mtime)) +
        '</span><span class="zmi-act">' +
        I18n.t("恢复") +
        "</span>";
      row.onclick = async () => {
        const ok = await confirmDialog(I18n.t("恢复到该备份？当前内容会被覆盖。"), {
          title: I18n.t("恢复备份"),
          danger: true,
          okText: I18n.t("恢复"),
        });
        if (!ok) return;
        const rr = await window.api.zenRestoreBackup(Z.doc.id, b.file).catch(() => null);
        if (rr && rr.ok) {
          adoptZenDoc(rr.data);
          hideZenBackupMenu();
          zenToast(I18n.t("已恢复备份"), "ok");
        } else {
          zenToast(I18n.t("恢复失败"), "err");
        }
      };
      box.appendChild(row);
    }
  }

  /* ---------------- Skill 内核 ---------------- */
  async function fetchZenSkillText(skillId) {
    if (!window.api || !window.api.zenSkillText) return "";
    try {
      const r = await window.api.zenSkillText(skillId);
      return r && r.ok ? String(r.text || "") : "";
    } catch (_) {
      return "";
    }
  }
  function zenSystemPrompt(skillText) {
    return [
      "你是 MTNode「禅模式」的引导引擎，在沉浸式全屏问答中逐步把用户的模糊想法澄清为可执行的计划。",
      "你只与用户问答和整理信息；本阶段严禁调用任何画布工具（mtnode_canvas_*）或修改文件。",
      "中文优先，语气平静、克制、具体。",
      "【输出契约】只输出一个 JSON 对象（不要代码块、不要多余文字）：",
      '{ "banner": "横幅问句：清晰具体可回答（≤64字）", "display": "中央显示屏短句（≤16字）", "options": [{"id":"o1","label":"选项（≤20字）","hint":"说明（≤40字）","skill":"可选，选中后下一轮使用的 skill id"}], "multiSelect": false, "nextSkillHint": "下一轮建议 skill id", "planReady": false, "planMarkdown": null }',
      "规则：options 提供 2~6 个选项；只有一个合理答案时也要给「其他/自定义」；多选题 multiSelect=true；",
      "信息已足够制定计划时 planReady=true（planMarkdown 可留 null，由计划编译技能生成）；",
      "用户文字回答时把它当作答案消化并继续追问；用户开启全新话题时先回应新话题再引导。",
      "",
      "—— 当前技能说明书（必须遵循）——",
      skillText || "",
    ]
      .filter((x) => x !== "")
      .join("\n");
  }
  function zenPlanCompilePrompt(skillText) {
    return [
      "你是 MTNode「禅模式」的计划编纂引擎。把下面的决策图谱整理成结构化 Markdown 计划。",
      "要求：用 ## 章节与 - [ ] 清单组织；关键决策节点各占一条；顺序从输入到产出可执行；",
      "每条清单后保留行内注释 <!-- zen:node:<节点id> -->（与图谱节点一一对应，注释勿改内容）；",
      "若某节点无对应图谱节点，注释写 <!-- zen:node:none -->。",
      "只输出 Markdown 正文，不要代码块，不要多余说明。",
      "",
      "—— 技能说明书 ——",
      skillText || "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  function zenCanvasCompilePrompt(skillText, gtBody, gwBody) {
    return [
      "你是 MTNode「禅模式」的画布构建引擎。用户已确认计划，现在把计划编译成 MTNode 可执行工作流画布。",
      "使用画布工具（mtnode_canvas_get / mtnode_canvas_edit）在当前画布中搭建工作流：",
      "1. 每个计划条目映射为画布节点；输入/可编辑节点放在画布上方，处理居中，保存/输出放下方；",
      "2. 复杂步骤用 agent_task 节点；跨节点文件交接用 wait_file 控制线；",
      "3. 节点标题与计划条目一一对应；完成后用 mtnode_canvas_get 核对并自动排版，确保无重叠；",
      "4. 全部完成后只输出 JSON 映射表：",
      '{ "map": [ {"taskNodeId":"画布节点id","planAnchor":"计划锚点(如 zen:node:xxx 或序号)","title":"节点标题"} ] }',
      "只输出该 JSON，不要其他内容。",
      "",
      "—— 技能说明书：禅画布编译 ——",
      skillText || "",
      "—— 技能说明书：generate-task ——",
      gtBody || "",
      "—— 技能说明书：generate-workflow ——",
      gwBody || "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  function parseZenContract(text) {
    let t = String(text || "").trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"),
      b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    let obj = null;
    try {
      obj = JSON.parse(t.slice(a, b + 1));
    } catch (_) {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const banner = String(obj.banner || "").trim();
    const display = String(obj.display || "").trim();
    const options = Array.isArray(obj.options)
      ? obj.options
          .filter((o) => o && o.label)
          .slice(0, OPT_MAX)
          .map((o, i) => ({
            id: String(o.id || "o" + (i + 1)),
            label: String(o.label).trim().slice(0, 22),
            hint: String(o.hint || "").trim().slice(0, 60),
            skill: String(o.skill || "").trim(),
          }))
      : [];
    if (!banner && !display && !options.length) return null;
    return {
      banner: banner || display || I18n.t("请继续"),
      display: display || banner.slice(0, 16),
      options,
      multiSelect: !!obj.multiSelect,
      nextSkillHint: String(obj.nextSkillHint || "").trim(),
      planReady: !!obj.planReady,
      planMarkdown: obj.planMarkdown ? String(obj.planMarkdown) : null,
    };
  }
  function parseZenMap(text) {
    let t = String(text || "").trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"),
      b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try {
      const obj = JSON.parse(t.slice(a, b + 1));
      if (obj && Array.isArray(obj.map)) {
        const out = {};
        for (const m of obj.map) {
          if (m && m.taskNodeId) {
            out[String(m.taskNodeId)] = {
              planAnchor: String(m.planAnchor || ""),
              title: String(m.title || ""),
            };
          }
        }
        return out;
      }
    } catch (_) {}
    return null;
  }

  /* ---------------- 问答闭环 ---------------- */
  function onHubClick() {
    const hub = hubNode();
    if (!hub) return;
    if (hub.status === "hub") {
      runZenAsk(hub);
      return;
    }
    if (hub.status === "running") return;
    if (hub.status === "ready") {
      if (Z.activeAskId !== hub.id) {
        focusAskNode(hub.id);
        return;
      }
      submitZenAnswer();
    }
  }
  function focusAskNode(id) {
    const n = zenNode(id);
    if (!n) return;
    Z.activeAskId = id;
    Z.selOptions = new Set((n.selectedOptionIds || []).filter((x) => zenNode(x)));
    const q = (n.payload && n.payload.question) || n.display || n.title || "";
    setZenBanner(n.skillId || ZEN_SKILL_IDS.bootstrap, q);
    const opts = activeOptionNodes();
    Z.lastBanner.multi = !!(n.payload && n.payload.multiSelect && opts.length > 1);
    renderZen();
  }
  function focusBranchNode(id) {
    const n = zenNode(id);
    if (!n) return;
    const opts = zenChildren(id).filter((c) => c.status === "options");
    if (!opts.length) {
      /* 分支已问完但无候选：重新触发提问 */
      n.status = "asking";
      markDirty();
      renderZen();
      runZenAsk(n);
      return;
    }
    focusAskNode(id);
  }
  function toggleSelectOption(id, force) {
    const ask = zenNode(Z.activeAskId);
    if (!ask || !ask.payload) return;
    const n = zenNode(id);
    if (!n || n.status !== "options" || n.parentId !== ask.id) return;
    const multi = !!ask.payload.multiSelect;
    const isSel = Z.selOptions.has(id);
    if (isSel) {
      Z.selOptions.delete(id);
    } else {
      /* 单选且未强行多选：清空重选；Ctrl/Shift/数字键（force）可追加，实现强行多选 */
      if (!multi && !force) Z.selOptions.clear();
      Z.selOptions.add(id);
    }
    renderZenStage();
  }
  function syncOptionSelVisuals() {
    document.querySelectorAll("#zenStage .zen-node[data-nid]").forEach((b) =>
      b.classList.toggle("sel", Z.selOptions.has(b.dataset.nid)),
    );
    renderZenEdges();
  }
  async function runZenAsk(node) {
    if (!Z.doc) return;
    if (Z.runs.has(node.id)) return;
    node.status = "running";
    markDirty();
    setZenBanner(node.skillId || ZEN_SKILL_IDS.bootstrap, "", { running: true });
    renderZen();
    const skillId = node.skillId || ZEN_SKILL_IDS.bootstrap;
    const skillText = await fetchZenSkillText(skillId);
    const input =
      "【当前存档】" +
      (Z.doc.name || "") +
      "\n【已澄清的图谱】\n" +
      zenGraphSummary() +
      "\n【问答记录】\n" +
      (zenChatContext() || "（空）") +
      "\n\n请基于以上内容继续提问（第一次运行则从问候与领域选择开始）。";
    const promise = dshRunTask(input, {
      workspace: Z.doc.projectFolder || "",
      systemPrompt: zenSystemPrompt(skillText),
      effort: "high",
      provider: Z.model.provider,
      model: Z.model.model || undefined,
    });
    Z.runs.set(node.id, promise);
    try {
      const text = await promise;
      /* 存档已切换：放弃本次结果，避免写进别的存档 */
      if (!Z.doc || zenNode(node.id) !== node) return;
      const c = parseZenContract(text);
      if (!c) throw new Error("bad-contract");
      applyZenContract(node, c, {});
    } catch (e) {
      node.status = node.kind === "hub" ? "hub" : "asking";
      const msg =
        (e && e.message) === "bad-contract"
          ? I18n.t("模型未按契约返回，请重试")
          : (e && e.message) || String(e);
      setZenBanner(skillId, "", {});
      zenToast(msg, "err");
      Z.doc.chat.push({ role: "ai", content: I18n.t("（提问失败：") + msg + "）", at: Date.now() });
      markDirty();
    } finally {
      Z.runs.delete(node.id);
      renderZen();
    }
  }
  function applyZenContract(node, c, consumed) {
    /* consumed: {doneIds:[], pruneIds:[]} */
    node.display = c.display;
    node.payload.question = c.banner; /* 完整问题，同步显示在中心显示屏 */
    node.status = "ready";
    if (c.nextSkillHint) node.skillId = c.nextSkillHint;
    node.selectedOptionIds = [];
    node.payload.multiSelect = c.multiSelect;
    node.payload.optionDefs = c.options;
    /* 旧选项：被选中的保留为 done；未选中的剪枝 */
    const doneIds = new Set(consumed.doneIds || []);
    for (const child of zenChildren(node.id)) {
      if (child.status !== "options") continue;
      if (doneIds.has(child.id)) {
        child.status = "done";
        child.selectedOptionIds = [];
      } else {
        pruneZenNodeTree(child.id, false);
      }
    }
    /* 路径推进：
       - 单选 1 项：选中选项与提问节点交换位置成为路径站点，提问节点前移一步；
       - 多选 / 强行多选：多个选中选项合并为 1 个历史节点（站点），同样前移一步。 */
    const chosenNodes = (consumed.doneIds || [])
      .map((id) => zenNode(id))
      .filter(Boolean);
    if (chosenNodes.length > 1) {
      const labels = chosenNodes.map((n) => n.title || "");
      const lastOpt = chosenNodes[chosenNodes.length - 1];
      /* 选中的选项节点合并进 1 个历史节点（移除原节点） */
      for (const dn of chosenNodes) pruneZenNodeTree(dn.id, false);
      const merged = {
        id: zenUid("zm"),
        kind: "option",
        x: node.x,
        y: node.y,
        w: 216,
        h: 104,
        title: labels.join(" + ").slice(0, 60),
        hint: "",
        display: "",
        status: "done",
        skillId: lastOpt.skillId || "",
        parentId: node.id,
        selectedOptionIds: [],
        payload: { isMerged: true, mergedLabels: labels.slice() },
      };
      const tx = node.x,
        ty = node.y;
      node.x = lastOpt.x;
      node.y = lastOpt.y;
      merged.x = tx;
      merged.y = ty;
      Z.doc.nodes.push(merged);
    } else if (chosenNodes.length === 1) {
      const chosen = chosenNodes[0];
      if (chosen.id !== node.id) {
        const tx = node.x,
          ty = node.y;
        node.x = chosen.x;
        node.y = chosen.y;
        chosen.x = tx;
        chosen.y = ty;
      }
    }
    /* 新选项节点：模型选项最多 OPT_MAX-1 个 + 末尾固定留空「自定义」槽 */
    const newOpts = [];
    const modelOpts = (c.options || []).slice(0, OPT_MAX - 1);
    const defs = modelOpts.concat([
      { id: "custom", label: "", hint: "", skill: "", isCustom: true },
    ]);
    for (const def of defs) {
      const n = {
        id: zenUid("zo"),
        kind: "option",
        x: 0,
        y: 0,
        w: 216,
        h: 104,
        title: def.label || "",
        hint: def.hint || "",
        display: "",
        status: "options",
        skillId: def.skill || "",
        parentId: node.id,
        selectedOptionIds: [],
        payload: { defId: def.id, isCustom: !!def.isCustom },
      };
      newOpts.push(n);
      Z.doc.nodes.push(n);
      Z.doc.edges.push({ from: node.id, to: n.id });
    }
    layoutChildren(node.id);
    Z.activeAskId = node.id;
    Z.selOptions = new Set();
    setZenBanner(node.skillId || ZEN_SKILL_IDS.bootstrap, c.banner, {
      multi: c.multiSelect && modelOpts.length > 1,
    });
    Z.doc.chat.push({ role: "ai", content: c.banner, at: Date.now() });
    if (c.planReady) {
      if (c.planMarkdown) enterPlanPhase(c.planMarkdown);
      else compileZenPlan(); /* 异步补编译 */
    }
    markDirty();
  }
  function layoutChildren(askId) {
    const ask = zenNode(askId);
    if (!ask) return;
    /* 只摆放当前候选选项；已处理节点留在原位（路径站点） */
    const kids = zenChildren(askId).filter((n) => n.status === "options" && !n._leaving);
    if (!kids.length) return;
    const kidIds = new Set(kids.map((k) => k.id));
    /* 避让对象：除提问节点与本次候选外的所有可见节点（站点/分支/Hub） */
    const occupied = Z.doc.nodes.filter(
      (n) => n.id !== ask.id && !kidIds.has(n.id) && n.status !== "pruned" && !n._leaving,
    );
    /* 候选槽：两环 × 6 角，按序尝试 */
    const slots = [];
    for (let ring = 0; ring < 2; ring++) {
      const r = ring ? OPT_RADIUS2 : OPT_RADIUS;
      for (let s = 0; s < OPT_MAX; s++) {
        slots.push((-90 + s * 60) * (Math.PI / 180) + (ring ? 0.5 : 0));
      }
    }
    const placed = []; /* {x, y} */
    const clash = (x, y) =>
      occupied.some((o) => Math.hypot(o.x - x, o.y - y) < 150) ||
      placed.some((p) => Math.hypot(p.x - x, p.y - y) < 150);
    kids.forEach((n, i) => {
      const ang = slots[i % slots.length];
      const r = i < OPT_MAX ? OPT_RADIUS : OPT_RADIUS2;
      /* 优先用无碰撞槽位；有碰撞时向后找空位；全部占用则退回默认 */
      let pick = null;
      for (let k = 0; k < slots.length; k++) {
        const a = slots[k];
        const rr = k < OPT_MAX ? OPT_RADIUS : OPT_RADIUS2;
        const x = zenSnap(ask.x + rr * Math.cos(a));
        const y = zenSnap(ask.y + rr * Math.sin(a));
        if (!clash(x, y)) {
          pick = { x, y };
          break;
        }
      }
      if (!pick) {
        pick = {
          x: zenSnap(ask.x + r * Math.cos(ang)),
          y: zenSnap(ask.y + r * Math.sin(ang)),
        };
      }
      n.x = pick.x;
      n.y = pick.y;
      n.w = 216;
      n.h = 104;
      placed.push({ x: pick.x, y: pick.y });
    });
  }
  function pruneZenNodeTree(id, animate, keepRoot) {
    const desc = (keepRoot ? [] : [id]).concat(zenDescendants(id));
    pruneZenNodeIds(desc, animate);
  }
  function pruneZenNodeIds(ids, animate) {
    const set = new Set(ids);
    const doPrune = () => {
      Z.doc.nodes = Z.doc.nodes.filter((n) => !set.has(n.id));
      Z.doc.edges = Z.doc.edges.filter((e) => !set.has(e.from) && !set.has(e.to));
      for (const nid of set) Z.seenIds.delete(nid);
      Z.selOptions = new Set([...Z.selOptions].filter((x) => !set.has(x)));
      if (set.has(Z.activeAskId)) Z.activeAskId = Z.hubId;
      markDirty();
      renderZen();
    };
    if (animate) {
      for (const nid of set) {
        const n = zenNode(nid);
        if (n) {
          n._leaving = true;
          if (n.status !== "options") n.status = "pruned";
        }
      }
      /* 先渲染离场态，再移除 */
      renderZenStage();
      setTimeout(doPrune, 320);
    } else doPrune();
  }

  async function submitZenAnswer() {
    if (!Z.doc) return;
    const ask = zenNode(Z.activeAskId);
    if (!ask) {
      /* 无焦点：文字作为「额外分支」 */
      createBranchFromInput();
      return;
    }
    if (ask.status === "running") return;
    const free = el("zenInput").value.trim();
    const opts = activeOptionNodes();
    /* 输入内容即第 6 个「自定义」选项：提交前同步并自动选中 */
    const custom = findCustomOption();
    if (custom) {
      custom.title = free;
      if (free) {
        if (ask.payload && !ask.payload.multiSelect) Z.selOptions.clear();
        Z.selOptions.add(custom.id);
      } else {
        Z.selOptions.delete(custom.id);
      }
    }
    const selIds = opts
      .filter((o) => Z.selOptions.has(o.id) && String(o.title || "").trim())
      .map((o) => o.id);
    if (!selIds.length && !free) {
      if (!opts.length && (ask.status === "ready" || ask.status === "hub")) {
        /* 提问节点已没有候选项（回滚清空后）：重新出题 */
        runZenAsk(ask);
        return;
      }
      zenToast(I18n.t("先选择一项，或输入文字回答"), "warn");
      return;
    }
    /* 单选题被强行多选：询问合并 / Fork 新画布 */
    const forcedMulti = selIds.length > 1 && !(ask.payload && ask.payload.multiSelect);
    if (forcedMulti) {
      const forkLabels = selIds.map((id) => zenNode(id).title || "");
      const choice = await zenChoiceDialog(
        I18n.t("单选题已多选"),
        I18n.t("此题为单选题，但已选择多个答案。如何处理？"),
        [
          { label: I18n.t("合并为1个历史节点"), value: "merge" },
          { label: "Fork · " + I18n.t("新画布"), value: "fork", primary: true },
          { label: I18n.t("取消"), value: null },
        ],
      );
      if (choice === "fork") {
        await forkZenArchive(forkLabels.filter(Boolean));
        return;
      }
      if (!choice) return;
      /* merge → 照常提交，applyZenContract 会把多选合并为 1 个历史节点 */
    }
    const labels = selIds.map((id) => zenNode(id).title || "");
    /* 自定义槽内容已作为选项之一进入 labels，不再单独追加，避免重复 */
    const customIncluded = custom && free && selIds.includes(custom.id);
    const answerText = labels.length ? labels.join(" + ") : free;
    Z.doc.chat.push({ role: "user", content: answerText, at: Date.now() });
    const consumed = {
      doneIds: selIds,
      pruneIds: opts.filter((o) => !Z.selOptions.has(o.id)).map((o) => o.id),
    };
    ask.payload.lastAnswer = {
      optionIds: selIds,
      labels,
      free: customIncluded ? "" : free,
    };
    ask.selectedOptionIds = selIds.slice();
    /* 选中选项若带 skill，切换提问技能 */
    const withSkill = selIds
      .map((id) => zenNode(id))
      .filter((n) => n && n.skillId)
      .map((n) => n.skillId);
    if (withSkill.length) ask.skillId = withSkill[withSkill.length - 1];
    ask.status = "running";
    el("zenInput").value = "";
    Z.selOptions = new Set();
    markDirty();
    setZenBanner(ask.skillId || ZEN_SKILL_IDS.bootstrap, "", { running: true });
    renderZen();
    const skillId = ask.skillId || ZEN_SKILL_IDS.bootstrap;
    const skillText = await fetchZenSkillText(skillId);
    const input =
      "【当前存档】" +
      (Z.doc.name || "") +
      "\n【已澄清的图谱】\n" +
      zenGraphSummary() +
      "\n【问答记录】\n" +
      zenChatContext() +
      "\n\n用户最新回答：" +
      answerText +
      "\n请消化该回答并继续追问；信息足够时 planReady=true。";
    const promise = dshRunTask(input, {
      workspace: Z.doc.projectFolder || "",
      systemPrompt: zenSystemPrompt(skillText),
      effort: "high",
      provider: Z.model.provider,
      model: Z.model.model || undefined,
    });
    Z.runs.set(ask.id, promise);
    try {
      const text = await promise;
      /* 存档已切换：放弃本次结果 */
      if (!Z.doc || zenNode(ask.id) !== ask) return;
      const c = parseZenContract(text);
      if (!c) throw new Error("bad-contract");
      applyZenContract(ask, c, consumed);
    } catch (e) {
      ask.status = "ready";
      const msg =
        (e && e.message) === "bad-contract"
          ? I18n.t("模型未按契约返回，请重试")
          : (e && e.message) || String(e);
      setZenBanner(skillId, "", {});
      zenToast(msg, "err");
      /* 失败时恢复会话输入框与自定义槽的同步 */
      const c2 = findCustomOption();
      const zi = el("zenInput");
      if (c2 && zi && document.activeElement !== zi && c2.title) {
        zi.value = c2.title;
      }
      markDirty();
    } finally {
      Z.runs.delete(ask.id);
      renderZen();
    }
  }
  function createBranchFromInput() {
    const free = el("zenInput").value.trim();
    if (!free) {
      zenToast(I18n.t("输入一个问题或想法，开一条新的探索分支"), "warn");
      return;
    }
    el("zenInput").value = "";
    const hub = hubNode();
    const parent = hub || null;
    const front = hub ? { x: hub.x, y: hub.y } : { x: 0, y: 0 };
    /* 从当前（前端）位置向右旁开，避免与已有分支重叠 */
    let bx = front.x + 380,
      by = front.y + 60;
    let guard = 0;
    while (guard++ < 12) {
      const clash = Z.doc.nodes.some(
        (n) =>
          n.kind === "branch" &&
          Math.abs(n.x - bx) < 300 &&
          Math.abs(n.y - by) < 220,
      );
      if (!clash) break;
      bx += 260;
    }
    const branch = {
      id: zenUid("zb"),
      kind: "branch",
      x: zenSnap(bx),
      y: zenSnap(by),
      w: 216,
      h: 104,
      title: free.slice(0, 22),
      display: free.slice(0, 22),
      status: "asking",
      skillId: ZEN_SKILL_IDS.bootstrap,
      parentId: parent ? parent.id : "",
      selectedOptionIds: [],
      payload: {},
    };
    Z.doc.nodes.push(branch);
    if (parent) Z.doc.edges.push({ from: parent.id, to: branch.id });
    Z.doc.chat.push({ role: "user", content: free, at: Date.now() });
    Z.activeAskId = branch.id;
    markDirty();
    renderZen();
    runZenAsk(branch);
  }

  /* ---------------- 回滚 ---------------- */
  async function rollbackZenNode(id) {
    const n = zenNode(id);
    if (!n || n.status !== "done") return;
    const ok = await confirmDialog(
      I18n.t("回滚该节点？其全部下游分支将移除，并重新对它提问。"),
      { title: I18n.t("回滚分支"), danger: true, okText: I18n.t("回滚") },
    );
    if (!ok) return;
    /* 移除：该节点自身 + 全部下游子树 + 当前焦点仍挂着的未答选项（跳回的时间线） */
    const removeSet = new Set([id, ...zenDescendants(id)]);
    const cur = zenNode(Z.activeAskId);
    if (cur && cur.id !== id && (cur.status === "ready" || cur.status === "hub")) {
      for (const ch of zenChildren(cur.id)) {
        if (ch.status === "options") removeSet.add(ch.id);
      }
    }
    Z.doc.planMarkdown = stripZenPlanAnchors(Z.doc.planMarkdown, removeSet);
    /* 保留该节点作为新的提问焦点：只剪其下游与悬空选项 */
    pruneZenNodeIds([...removeSet].filter((x) => x !== id), true);
    n.status = "asking";
    n.selectedOptionIds = [];
    n.payload.optionDefs = [];
    n.payload.lastAnswer = null;
    /* 恢复提问根与父节点的连线（若回滚前被路径链取代而缺失） */
    if (n.parentId && !zenEdgeOf(n.parentId, n.id)) {
      Z.doc.edges.push({ from: n.parentId, to: n.id });
    }
    Z.activeAskId = n.id;
    Z.selOptions = new Set();
    markDirty();
    renderZen();
    runZenAsk(n);
  }
  function stripZenPlanAnchors(md, ids) {
    if (!md) return md || "";
    let out = md;
    for (const id of ids) {
      const re = new RegExp(
        "<!--\\s*zen:node:" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*-->",
        "g",
      );
      out = out.replace(re, "<!-- zen:node:pruned -->");
    }
    return out;
  }

  /* ---------------- 计划阶段 ---------------- */
  function toggleZenPlan() {
    if (!Z.doc) return;
    if (!Z.doc.planMarkdown.trim()) {
      zenToast(I18n.t("计划尚未生成：继续问答，或直接点击「构建画布」触发计划编译"), "warn");
      return;
    }
    setZenPlanOpen(!Z.planOpen);
  }
  function setZenPlanOpen(open) {
    Z.planOpen = open;
    el("zenPlan").hidden = !open;
    if (open) renderZenPlan();
  }
  function renderZenPlan() {
    if (!Z.doc) return;
    const p = el("zenPlan");
    p.querySelectorAll(".zen-plan-tab").forEach((b) =>
      b.classList.toggle("on", b.dataset.tab === Z.planTab),
    );
    el("zenPlanEdit").hidden = Z.planTab !== "edit";
    el("zenPlanView").hidden = Z.planTab !== "view";
    el("zenPlanSub").textContent =
      Z.doc.planMarkdown.trim()
        ? I18n.t("可编辑 · 与图谱双向同步")
        : I18n.t("尚无计划");
    if (Z.planTab === "edit") {
      const ta = el("zenPlanEdit");
      if (document.activeElement !== ta) ta.value = Z.doc.planMarkdown || "";
    } else {
      const v = el("zenPlanView");
      v.innerHTML = Z.doc.planMarkdown.trim()
        ? '<div class="md">' + renderMarkdown(Z.doc.planMarkdown) + "</div>"
        : '<div class="zen-plan-empty"><span class="zpe-mark">◎</span>' + I18n.t("尚无计划：继续问答澄清，或点击「重新编译计划」") + "</div>";
      renderZenPlanProgress();
    }
  }
  function renderZenPlanProgress() {
    const note = el("zenPlanNote");
    if (!note || !Z.doc) return;
    if (Z.doc.phase !== "canvas") {
      note.textContent = Z.doc.phase === "plan" ? I18n.t("确认计划后点击「构建画布」") : "";
      return;
    }
    const wf = zenWorkflowOf();
    const map = Z.doc.planNodeMap || {};
    const ids = Object.keys(map);
    if (!wf || !ids.length) {
      note.textContent = Z.doc.workflowId ? I18n.t("返回主画布查看任务进度") : "";
      return;
    }
    let done = 0;
    for (const tid of ids) {
      const tn = wf.nodes.find((x) => x.id === tid);
      if (tn && tn.taskStatus === "done") done++;
      if (tn && (tn.taskStatus === "running" || tn.running)) {
        note.textContent = I18n.t("任务执行中… ") + done + "/" + ids.length;
        return;
      }
    }
    note.textContent = I18n.t("任务进度") + " " + done + "/" + ids.length;
  }
  function zenWorkflowOf() {
    if (!Z.doc || !Z.doc.workflowId) return null;
    if (S.wf && S.wf.id === Z.doc.workflowId) return S.wf;
    if (S.wfBag && S.wfBag[Z.doc.workflowId]) return S.wfBag[Z.doc.workflowId];
    return null;
  }
  async function enterPlanPhase(markdown) {
    Z.doc.planMarkdown = markdown || "";
    Z.doc.phase = "plan";
    Z.planOpen = true;
    markDirty();
    renderZen();
    setZenPlanOpen(true);
    zenToast(I18n.t("计划已生成，可编辑或直接构建画布"), "ok");
  }
  async function compileZenPlan() {
    if (!Z.doc) return;
    if (Z.runs.has("__plan__")) return;
    setZenBanner(ZEN_SKILL_IDS.planCompile, "", { running: true });
    const skillText = await fetchZenSkillText(ZEN_SKILL_IDS.planCompile);
    const input =
      "【当前存档】" +
      (Z.doc.name || "") +
      "\n【已澄清的图谱】\n" +
      zenGraphSummary() +
      "\n【问答记录】\n" +
      zenChatContext() +
      "\n\n请编译计划。";
    const promise = dshRunTask(input, {
      workspace: Z.doc.projectFolder || "",
      systemPrompt: zenPlanCompilePrompt(skillText),
      effort: "high",
      provider: Z.model.provider,
      model: Z.model.model || undefined,
    });
    Z.runs.set("__plan__", promise);
    try {
      const text = await promise;
      const md = String(text || "").replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/, "").trim();
      if (md) {
        Z.doc.planMarkdown = md;
        Z.doc.phase = "plan";
        markDirty();
        renderZen();
        setZenPlanOpen(true);
        zenToast(I18n.t("计划已生成"), "ok");
      } else throw new Error("empty");
    } catch (e) {
      /* 兜底：本地模板编译 */
      const md = localPlanTemplate();
      Z.doc.planMarkdown = md;
      Z.doc.phase = "plan";
      markDirty();
      renderZen();
      setZenPlanOpen(true);
      zenToast(I18n.t("已按图谱生成计划草稿，可手动编辑"), "warn");
    } finally {
      Z.runs.delete("__plan__");
      setZenBanner(ZEN_SKILL_IDS.planCompile, "", {});
      renderZen();
    }
  }
  function localPlanTemplate() {
    const hub = hubNode();
    const lines = ["## 目标", ""];
    if (hub) lines.push("- [ ] " + (hub.display || hub.title || "") + " <!-- zen:node:" + hub.id + " -->");
    lines.push("", "## 执行步骤", "");
    const walk = (pid, depth) => {
      for (const n of zenChildren(pid)) {
        if (n.status === "pruned") continue;
        const title = n.title || n.display || "";
        lines.push("- [ ] " + title + " <!-- zen:node:" + n.id + " -->");
        walk(n.id, depth + 1);
      }
    };
    if (hub) walk(hub.id, 0);
    lines.push("", "## 产出", "", "- [ ] 交付物清单 <!-- zen:node:none -->");
    return lines.join("\n");
  }
  async function recompileZenPlan() {
    if (!Z.doc) return;
    const ok = await confirmDialog(I18n.t("基于当前图谱重新生成计划？手动编辑的段落可能被替换。"), {
      title: I18n.t("重新编译计划"),
      okText: I18n.t("重新编译"),
    });
    if (!ok) return;
    await compileZenPlan();
  }
  /* 计划改 → 图谱：解析锚点与清单文本，保守合并（只改标题，不增删） */
  function syncPlanToGraph() {
    if (!Z.doc || !Z.doc.planMarkdown) return;
    const anchors = {};
    const re = /<!--\s*zen:node:([A-Za-z0-9_-]+)\s*-->\s*[\s\S]*?-\s*\[[ xX]\]\s*([^\n]+)/g;
    let m;
    while ((m = re.exec(Z.doc.planMarkdown))) {
      const id = m[1];
      const text = m[2].trim();
      if (id !== "none" && id !== "pruned" && text) anchors[id] = text;
    }
    let changed = 0;
    for (const [id, text] of Object.entries(anchors)) {
      const n = zenNode(id);
      if (!n) continue;
      const clean = text.replace(/[*_`]/g, "").slice(0, 30);
      if (clean && clean !== n.title) {
        n.title = clean;
        changed++;
      }
    }
    if (changed) {
      markDirty();
      renderZen();
      zenToast(I18n.t("已同步 {n} 处标题到图谱", { n: changed }), "ok");
    }
  }

  /* ---------------- 画布构建 ---------------- */
  async function buildZenCanvas() {
    if (!Z.doc) return;
    if (Z.runs.has("__build__")) return;
    if (!Z.doc.planMarkdown.trim()) {
      zenToast(I18n.t("先生成计划再构建画布"), "warn");
      return;
    }
    if (Z.doc.phase === "canvas" && Z.doc.workflowId) {
      const again = await confirmDialog(I18n.t("已构建过画布，重新生成将新建一个同名画布。继续？"), {
        title: I18n.t("构建画布"),
        okText: I18n.t("重新生成"),
      });
      if (!again) return;
    }
    const ok = await confirmDialog(
      I18n.t("将按计划生成可执行画布，写入所选项目文件夹，并允许 AI 写入画布节点（本次免逐项确认）。"),
      { title: I18n.t("构建画布"), okText: I18n.t("允许写入") },
    );
    if (!ok) return;
    /* 项目文件夹 */
    let folder = String(Z.doc.projectFolder || "").trim();
    if (folder) {
      const exists = await window.api.fileIsDir(folder).catch(() => false);
      if (!exists) {
        zenToast(I18n.t("项目文件夹已失效，请重新选择"), "err");
        folder = "";
      }
    }
    if (!folder) {
      const r = await window.api.fileOpenDialog({ title: I18n.t("选择项目文件夹"), directory: true });
      if (!r || !r.path) return;
      folder = r.path;
      Z.doc.projectFolder = folder;
    }
    /* 保存计划与文件夹 */
    await flushZenSave();
    setZenBanner(ZEN_SKILL_IDS.canvasCompile, "", { running: true });
    zenToast(I18n.t("正在生成画布…（可稍等片刻）"), "ok");
    /* 创建同名画布并绑定工作目录（先落盘当前画布，避免覆盖丢失） */
    try {
      if (typeof flushCurrentWf === "function") flushCurrentWf();
    } catch (_) {}
    const created = await createWorkflowNamed(Z.doc.name);
    Z.doc.workflowId = created.id;
    if (S.wf && S.wf.id === created.id) {
      S.wf.workspace = folder;
      S.wf.zenDocId = Z.doc.id;
      await window.api.wfSave(S.wf.id, JSON.parse(JSON.stringify(S.wf)));
    }
    markDirty();
    const skillText = await fetchZenSkillText(ZEN_SKILL_IDS.canvasCompile);
    let gtBody = "",
      gwBody = "";
    try {
      const gt = await window.api.skillGet("generate-task");
      if (gt && gt.ok && gt.body) gtBody = gt.body;
    } catch (_) {}
    try {
      const gw = await window.api.skillGet("generate-workflow");
      if (gw && gw.ok && gw.body) gwBody = gw.body;
    } catch (_) {}
    const input =
      "【项目文件夹】" +
      folder +
      "\n【存档名】" +
      (Z.doc.name || "") +
      "\n【计划】\n" +
      Z.doc.planMarkdown +
      "\n【决策图谱】\n" +
      zenGraphSummary() +
      "\n\n请构建工作流画布并返回映射表。";
    const promise = dshRunTask(input, {
      workspace: folder,
      systemPrompt: zenCanvasCompilePrompt(skillText, gtBody, gwBody),
      effort: "max",
      provider: Z.model.provider,
      model: Z.model.model || undefined,
    });
    Z.runs.set("__build__", promise);
    try {
      const text = await promise;
      const map = parseZenMap(text);
      Z.doc.planNodeMap = map || {};
      /* 写入画布元数据 */
      const wf = zenWorkflowOf();
      if (wf && wf.id === Z.doc.workflowId) {
        wf.zenPlanMap = Z.doc.planNodeMap;
        wf.zenDocId = Z.doc.id;
        await window.api.wfSave(wf.id, JSON.parse(JSON.stringify(wf)));
      }
      /* 图谱节点打上映射标记 */
      for (const info of Object.values(Z.doc.planNodeMap)) {
        if (!info || !info.planAnchor) continue;
        const nid = info.planAnchor.replace(/^zen:node:/, "");
        const n = zenNode(nid);
        if (n && n.payload) n.payload.mapInfo = info.title || "";
      }
      Z.doc.phase = "canvas";
      markDirty();
      renderZen();
      zenToast(I18n.t("画布已生成：") + (Z.doc.name || ""), "ok");
      setZenPlanOpen(true);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      zenToast(I18n.t("画布生成失败：") + msg, "err");
    } finally {
      Z.runs.delete("__build__");
      setZenBanner("", "");
      renderZen();
    }
  }

  /* ---------------- 打开 / 关闭 ---------------- */
  async function openZenMode() {
    ensureZenDom();
    const root = el("zenRoot");
    root.classList.add("on");
    root.hidden = false;
    Z.open = true;
    I18n.applyDom(root);
    startZenTimers();
    if (Z.doc) {
      renderZen();
      applyZenTransform();
      return;
    }
    await showZenPicker();
  }
  async function closeZenMode() {
    if (!Z.open) return;
    hideZenBackupMenu();
    el("zenPicker").hidden = true;
    Z.picking = false;
    setZenPlanOpen(false);
    await flushZenSave();
    stopZenTimers();
    const root = el("zenRoot");
    root.classList.remove("on");
    root.hidden = true;
    Z.open = false;
  }
  async function toggleZenMode() {
    if (Z.open) await closeZenMode();
    else await openZenMode();
  }

  /* ---------------- 暴露 ---------------- */
  window.ZenMode = {
    open: openZenMode,
    close: closeZenMode,
    toggle: toggleZenMode,
    isOpen: () => Z.open,
    flush: flushZenSave,
    _internals: {
      parseZenContract,
      parseZenMap,
      localPlanTemplate,
      stripZenPlanAnchors,
      zenGraphSummary,
    },
  };
})();

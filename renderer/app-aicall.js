"use strict";
/* ============================================================
 * 「AI 调用」设定（模型 / 预设 / 思考强度） —— 工具节点 · 函数节点 · 开发节点共用
 * ------------------------------------------------------------
 * 需求：工具节点与函数节点上要有一个和开发节点同款的入口按钮，点开可选
 * 模型 / 预设 / 思考强度；选完之后，该节点需要借助 AI（API）时就按选中的来，
 * 用户改了选择，该节点与它管内的一切随之改。
 *
 * 一套字段、三处落点（都在节点自身，随工作流保存 / canvas_get 可见）：
 *   aiModel    模型 id（空 = 未选择，跟随默认）
 *   aiProvider 智能路由 id（deepseek-official / mtnode_<providerId>，由模型推断）
 *   aiPreset   预设档 id（app.js 的 AGENT_PRESETS，与会话同一张表）
 *   aiEffort   思考强度档位（app.js 的 AGENT_EFFORT_ORDER 词汇表内值）
 * 开发节点历史字段（devModel / devProvider / devPreset / devEffort）是同一套语义的
 * 旧名字：读取时后者优先、前者兜底，写入一律写 ai* —— 不迁移、不打断既有画布。
 *
 * 生效值（aiResolvedOf）＝ 就近向上找最近的「可承载 AI 的节点」：
 *   · 目标自身选过就是目标（工具 / 函数 / 开发节点都能自己承载）；
 *   · 没选则沿 parentSuperId 往上找最近的工具节点（工具节点内的 AI 节点 =
 *     用父工具的设定），再往上找最近已选的开发节点（工具挂在功能块里时跟随功能块）；
 *   · 都没选 → null = 跟随默认（与开发节点旧口径一致）。
 * 工具节点运行（runToolNode → aiApplyToToolRun）时把生效值下发到内部子图的 AI 节点，
 * 内部节点自己选过模型 / 服务商的一律不动 —— 就近优先，与开发节点同口径。
 * 函数节点由 app-nodes.js 的 runFunctionNode 解析出生效值交给主进程运行的 jscode，
 * jscode 里 await mtnode.ai(...) 就用这套（见 fn-runtime.js 的 buildMtnodeBridge）。
 *
 * UI：节点头部小按钮（.n-dev-model，开发节点同款样式，文案随节点类型变）＋
 * 弹层 #aiCallPop（复用 .dev-model-pop 全套样式，不新增 CSS）。函数 / 工具节点的
 * 折叠卡板身里再放一枚同一弹层的入口（app-canvas.js 的 n-dev-btns 行）。
 * ============================================================ */
(function () {
  /* ---------------- 节点判定 / 字段归一 ---------------- */

  /* 能自己承载「AI 调用」选择的节点：工具节点、函数节点、开发节点 */
  function aiCallTarget(node) {
    if (!node) return false;
    if (node.kind === "function") return true;
    if (isToolNode(node)) return true;
    if (node.kind === "super" && node.dev && !node.db) return true;
    return false;
  }

  function isToolAiNode(node) {
    return typeof isToolNode === "function" && isToolNode(node);
  }

  /* 旧画布加载归一：只补字段、只把可承载节点的默认值补种，绝不清用户已选的键 */
  function ensureAiCallState(node) {
    if (!node) return;
    if (typeof node.aiModel !== "string") node.aiModel = "";
    if (typeof node.aiProvider !== "string") node.aiProvider = "";
    if (typeof node.aiPreset !== "string") node.aiPreset = "";
    if (typeof node.aiEffort !== "string") node.aiEffort = "";
    /* 开发节点：既有 dev* 字段就是本套语义的历史键，读时兜底即可，不搬迁 */
    if (node.kind === "super" && node.dev) {
      if (typeof node.devModel !== "string") node.devModel = "";
      if (typeof node.devProvider !== "string") node.devProvider = "";
      if (typeof node.devPreset !== "string") node.devPreset = "";
      if (typeof node.devEffort !== "string") node.devEffort = "";
    }
  }

  /* 开发节点用（app.js 加载归一里调用）：补齐字段，不补种默认选择 */
  function ensureDevAiCallState(node) {
    ensureAiCallState(node);
  }

  /* 新建的工具 / 函数节点：按当前默认路由 / 默认模型 / 默认预设补种一份可见的选择。
     不补种的话按钮永远显示「自动」，用户会以为没有这套设定可用。 */
  function aiCallSeedDefaults(node) {
    if (!node || !(node.kind === "function" || isToolAiNode(node))) return;
    ensureAiCallState(node);
    let route = "";
    try {
      route = String(preferredAgentProviderRoute() || "").trim();
    } catch (_) {
      route = "";
    }
    if (!route) {
      try {
        route = defaultAgentProviderRoute();
      } catch (_) {
        route = "";
      }
    }
    if (!route) route = "deepseek-official";
    let model = "";
    try {
      model = String(preferredAgentModelForRoute(route) || "").trim();
    } catch (_) {
      model = "";
    }
    node.aiProvider = route;
    node.aiModel = model;
    if (!aiPresetKnown(node.aiPreset)) node.aiPreset = aiPresetKnown(AGENT_PRESET_DEFAULT);
    if (!aiEffortKnown(node.aiEffort)) node.aiEffort = aiEffortKnown("high");
  }

  /* ---------------- 归一 / 显示名（真源都在 app.js / app-assist.js，这里只查不抄） ---- */

  function aiPresetKnown(id) {
    if (typeof devPresetKnown === "function") return devPresetKnown(id);
    return String(id == null ? "" : id).trim();
  }
  function aiEffortKnown(v) {
    if (typeof devEffortKnown === "function") return devEffortKnown(v);
    const s = String(v == null ? "" : v)
      .trim()
      .toLowerCase();
    if (typeof AGENT_EFFORT_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_ORDER))
      return AGENT_EFFORT_ORDER.indexOf(s) >= 0 ? s : "";
    return s;
  }
  function aiRouteName(route) {
    try {
      if (typeof devAgentRouteName === "function") return devAgentRouteName(route);
    } catch (_) {}
    return String(route || "deepseek-official");
  }
  function aiModelGroups() {
    try {
      if (typeof devAgentModelGroups === "function") return devAgentModelGroups() || [];
    } catch (_) {}
    return [];
  }
  function aiModelFitsRoute(route, model) {
    try {
      if (typeof devModelFitsRoute === "function") return devModelFitsRoute(route, model);
    } catch (_) {}
    return !!String(model || "").trim();
  }
  function aiRouteOfModel(model) {
    try {
      if (typeof devRouteOfModel === "function") return devRouteOfModel(model) || "";
    } catch (_) {}
    return "";
  }
  function aiPresetName(id) {
    const raw = aiPresetKnown(id);
    if (!raw) return "";
    try {
      if (typeof agentPresetLabel === "function") return String(agentPresetLabel(raw));
    } catch (_) {}
    return raw;
  }
  function aiPresetShortName(id) {
    const t = String(aiPresetName(id) || "").trim();
    /* 与开发节点同一口径：长档名取括号前的部分，按钮上才塞得下 */
    const m = t.match(/^([^（(]+)/);
    return (m ? m[1] : t).trim();
  }
  function aiEffortName(v) {
    try {
      if (typeof agentEffortLabelOf === "function") return String(agentEffortLabelOf(v));
    } catch (_) {}
    return aiEffortKnown(v) || "";
  }
  function aiEffortShortTag(v) {
    const raw = aiEffortKnown(v);
    if (!raw) return "";
    if (typeof AGENT_EFFORT_LABELS !== "undefined" && AGENT_EFFORT_LABELS[raw])
      return I18n.t(AGENT_EFFORT_LABELS[raw]);
    return aiEffortName(raw);
  }

  /* ---------------- 本节点 / 生效值 ---------------- */

  /* 本节点自己选定的模型：{provider, model}；未选 → null。
     三种来源按优先级：
       ① 承载节点的「AI 调用」字段 aiModel / aiProvider；
       ② 开发节点的历史字段 devModel / devProvider（同义旧键，不迁移也读得到）；
       ③ AI 节点自身已有的运行配置（proc_* 的 providerId+model、agent_task 的
          provider+model）—— 内部 AI 节点「自己选过」就是这一份，就近优先靠它。 */
  function aiModelOwn(node) {
    ensureAiCallState(node);
    if (!aiCallTarget(node) && !aiCallNodeNeeds(node)) return null;
    let m = String(node.aiModel || "").trim();
    let r = String(node.aiProvider || "").trim();
    if (!m && node.dev) {
      m = String(node.devModel || "").trim();
      r = String(node.devProvider || "").trim();
    }
    if (!m && aiCallNodeNeeds(node)) {
      m = String(node.model || "").trim();
      r =
        node.kind === "agent_task"
          ? String(node.provider || "").trim()
          : String(node.providerId || "").trim()
            ? "mtnode_" + String(node.providerId).trim()
            : "";
    }
    if (!m) return null;
    let routes = [];
    try {
      routes = typeof agentRouteOptions === "function" ? Array.from(agentRouteOptions()) : [];
    } catch (_) {
      routes = [];
    }
    if (r && routes.length && routes.indexOf(r) < 0) r = "";
    if (r && aiModelFitsRoute(r, m)) return { provider: r, model: m };
    const found = aiRouteOfModel(m);
    return { provider: found || r || "deepseek-official", model: m };
  }

  /* 预设 / 思考强度：只有「能自己承载 AI 调用的节点」（工具 / 函数 / 开发节点）才有
     「自己选过」这回事。proc_text / proc_image / agent_task 上的 effort / preset 是
     它们自己的运行参数（不是「AI 调用」选择），绝不能当成继承链上的取值 ——
     否则内部节点会拿自己的旧参数顶掉工具节点的选择（就近优先只认承载者）。 */
  function aiPresetOwn(node) {
    ensureAiCallState(node);
    if (!aiCallTarget(node)) return "";
    const own = aiPresetKnown(node.aiPreset);
    if (own) return own;
    return node.dev ? aiPresetKnown(node.devPreset) : "";
  }

  function aiEffortOwn(node) {
    ensureAiCallState(node);
    if (!aiCallTarget(node)) return "";
    const own = aiEffortKnown(node.aiEffort);
    if (own) return own;
    return node.dev ? aiEffortKnown(node.devEffort) : "";
  }

  function aiParentOf(node) {
    const id =
      typeof nodeParentSuperId === "function"
        ? nodeParentSuperId(node)
        : (node && node.parentSuperId) || "";
    return id && typeof nodeById === "function" ? nodeById(id) : null;
  }

  /* 生效的 AI 调用设定：{provider, model, preset, effort, source, inherited,
     modelChosen / presetChosen / effortChosen, …}
     四项各自沿 parentSuperId 就近向上找第一个已选值 —— 与开发节点 devAgentSettingsOf
     同一套「互不牵连 · 就近继承」口径，只是把可承载节点从「开发节点」放宽到
     「工具 / 函数 / 开发节点」。
     *Chosen 三项说的是「这个生效值是不是本节点自己选的」：工具节点运行时要靠它
     判断内部子图该不该被覆盖 —— 本节点自己选的才叫「就近优先」。 */
  function aiResolvedOf(node) {
    const out = {
      provider: "",
      model: "",
      preset: "",
      effort: "",
      source: null,
      inherited: false,
      modelChosen: false,
      presetSource: null,
      presetInherited: false,
      presetChosen: false,
      effortSource: null,
      effortInherited: false,
      effortChosen: false,
    };
    if (!node) return out;
    let cur = node;
    let guard = 0;
    while (cur && guard++ < 64) {
      if (!out.model) {
        const own = aiModelOwn(cur);
        if (own) {
          out.provider = own.provider;
          out.model = own.model;
          out.source = cur;
          out.inherited = cur !== node;
          out.modelChosen = cur === node;
        }
      }
      if (!out.preset) {
        const p = aiPresetOwn(cur);
        if (p) {
          out.preset = p;
          out.presetSource = cur;
          out.presetInherited = cur !== node;
          out.presetChosen = cur === node;
        }
      }
      if (!out.effort) {
        const e = aiEffortOwn(cur);
        if (e) {
          out.effort = e;
          out.effortSource = cur;
          out.effortInherited = cur !== node;
          out.effortChosen = cur === node;
        }
      }
      if (out.model && out.preset && out.effort) break;
      const parent = aiParentOf(cur);
      cur = parent && aiOnChain(parent) ? parent : null;
    }
    return out;
  }

  /* 该节点此刻是否有「生效的 AI 调用选择」（供运行期判定要不要下发 / 覆盖） */
  function aiResolvedModel(node) {
    const s = aiResolvedOf(node);
    if (!s.model) return null;
    return {
      provider: s.provider,
      model: s.model,
      source: s.source,
      inherited: s.inherited,
    };
  }

  /* 需要借助 AI 的节点种类：按序号取服务商的图像 / 文本处理、智能任务 */
  function aiCallNodeNeeds(node) {
    if (!node) return false;
    return (
      node.kind === "proc_text" ||
      node.kind === "proc_image" ||
      node.kind === "agent_task"
    );
  }

  /* 继承链上的节点：能自己承载选择的三类 ＋ 真正要吃这套设定的 AI 节点
     （proc_text / proc_image / agent_task 自己不算承载者，但它们要按就近继承拿
     「预设 / 思考强度」—— 工具节点没选模型、只选了预设时，内部 AI 节点照样吃到）。 */
  function aiOnChain(node) {
    return aiCallTarget(node) || aiCallNodeNeeds(node);
  }

  /* 内部 AI 节点是否已「自己选过」服务商 / 模型 —— 已选的绝不覆盖（就近优先）。
     agent_task 自主路由（provider / model）；proc_* 走 API 模式（providerId / model）。 */
  function aiCallNodeChosen(n) {
    if (!n) return false;
    if (n.kind === "agent_task") return !!(String(n.provider || "").trim() || String(n.model || "").trim());
    return !!(String(n.providerId || "").trim() || String(n.model || "").trim());
  }

  /* 把生效值下发到一个 AI 节点；返回实际改了什么（供提示 / 测试断言）。
     eff = aiResolvedOf(宿主) 的结果：*Chosen = 宿主自己选的（就近优先），
     否则是继承来的 —— 继承值只对「没自己配过」的内部节点生效。
     textEffort = app-canvas.js 的 normalizeTextEffort（proc_text 的下发词汇是 off/low/medium/high/max） */
  function aiApplyToNode(n, eff, opts) {
    const changed = [];
    if (!n || !eff || !eff.model) return changed;
    if (!aiCallNodeNeeds(n)) return changed;
    const force = !!(opts && opts.force === true);
    const chosen = {
      model: !!(opts && opts.chosen && opts.chosen.model),
      preset: !!(opts && opts.chosen && opts.chosen.preset),
      effort: !!(opts && opts.chosen && opts.chosen.effort),
    };
    if (n.kind === "agent_task") {
      const own = aiCallNodeChosen(n);
      const writeModel = !own || force || chosen.model;
      const writePreset = chosen.preset && eff.preset;
      /* 思考档只有在「宿主自己选了这一格」或强制时才下发；没被选过时连自身参数都不动 */
      const writeEffort = ((chosen.effort || force) && eff.effort) || "";
      if (writeModel) {
        if (n.provider !== eff.provider) {
          n.provider = eff.provider;
          changed.push("provider");
        }
        if (n.model !== eff.model) {
          n.model = eff.model;
          changed.push("model");
        }
      }
      if (writePreset && n.preset !== eff.preset) {
        n.preset = eff.preset;
        changed.push("preset");
      }
      if (writeEffort && n.effort !== writeEffort) {
        n.effort = writeEffort;
        changed.push("effort");
      }
      if (changed.length) n.vision = null;
      return changed;
    }
    const own = aiCallNodeChosen(n);
    const route = String(eff.provider || "").trim();
    const routeProviderId = route.startsWith("mtnode_") ? route.slice("mtnode_".length) : "";
    /* DeepSeek 官方路由留给本节点原有配置（官方=第一条 DeepSeek 服务商），
       非官方路由把 providerId 指到对应服务商，模型 / 强度按选择下发。
       下发给内部 AI 节点的只有两类：① 内部节点自己没配过（继承兜底）；
       ② force（强制覆盖，测试 / 显式调用）—— 内部节点的自选永不覆盖。 */
    if (!own || force) {
      if (routeProviderId && n.providerId !== routeProviderId) {
        n.providerId = routeProviderId;
        changed.push("provider");
      }
      if (n.model !== eff.model) {
        n.model = eff.model;
        changed.push("model");
      }
    }
    if ((chosen.effort || force) && eff.effort) {
      const txt =
        typeof normalizeTextEffort === "function"
          ? normalizeTextEffort(eff.effort)
          : eff.effort;
      if (n.effort !== txt) {
        n.effort = txt;
        changed.push("effort");
      }
    }
    if (changed.length) n.vision = null;
    return changed;
  }

  /* 工具节点运行入口：把生效值下发到它的内部子图（内部节点自己选过的不动）。
     只下发「本工具节点自己选的」那几格（chosen）—— 从上层开发节点继承来的值不下发，
     不然会把内部节点的既有配置改写掉。返回真正被改写的内部节点列表。 */
  function aiApplyToToolRun(host) {
    const touched = [];
    if (!host || !isToolAiNode(host)) return touched;
    const eff = aiResolvedOf(host);
    if (!eff.model) return touched;
    const chosen = {
      model: eff.modelChosen,
      preset: eff.presetChosen,
      effort: eff.effortChosen,
    };
    const children = typeof superChildrenOf === "function" ? superChildrenOf(host.id) : [];
    for (const c of children) {
      if (!aiCallNodeNeeds(c)) continue;
      if (typeof isSuperIoNode === "function" && isSuperIoNode(c)) continue;
      const ch = aiApplyToNode(c, eff, { chosen });
      if (ch.length) touched.push({ node: c, changed: ch });
    }
    return touched;
  }

  /* 函数节点运行入口：解析出生效值给 jscode 用（mtnode.ai / mtnode.aiConfig）。
     返回 { provider, model, preset, effort, providerConfig } 或 null。 */
  function aiRunSpecFor(node) {
    const eff = aiResolvedOf(node);
    if (!eff.model) return null;
    let providerConfig = null;
    try {
      if (typeof providerForAgentRoute === "function")
        providerConfig = providerForAgentRoute(eff.provider) || null;
    } catch (_) {
      providerConfig = null;
    }
    return {
      provider: eff.provider,
      model: eff.model,
      preset: eff.preset,
      effort: eff.effort,
      providerName: aiRouteName(eff.provider),
      providerConfig,
    };
  }

  /* 运行期兜底：把生效值写回本节点自己（没选过时补上），返回是否改动。
     函数 / 工具节点「运行了就用选中的模型」这条不靠别的开关，靠这里落定。
     预设 / 思考强度同样补齐：新建时补过种，这里兜住旧画布（加功能前建的节点）。
     补种 = 写 aiPreset / aiEffort（不是 dev*，避免给开发节点之外的节点塞开发字段）。 */
  function aiApplyToSelf(node) {
    ensureAiCallState(node);
    if (!aiCallTarget(node)) return false;
    const eff = aiResolvedOf(node);
    if (!eff.model) return false;
    let dirty = false;
    if (!String(node.aiModel || "").trim()) {
      node.aiModel = eff.model;
      node.aiProvider = eff.provider;
      dirty = true;
    }
    if (!String(node.aiPreset || "").trim()) {
      const p = eff.preset || aiPresetKnown(AGENT_PRESET_DEFAULT);
      if (p) {
        node.aiPreset = p;
        if (node.dev) node.devPreset = p;
        dirty = true;
      }
    }
    if (!String(node.aiEffort || "").trim()) {
      const e = eff.effort || aiEffortKnown("high");
      if (e) {
        node.aiEffort = e;
        if (node.dev) node.devEffort = e;
        dirty = true;
      }
    }
    return dirty;
  }

  /* ---------------- 头部按钮 ---------------- */

  function aiCallButtonLabel(node) {
    const s = aiResolvedOf(node);
    const parts = [s.model || I18n.t("自动")];
    if (s.preset) parts.push(aiPresetShortName(s.preset));
    if (s.effort) parts.push(aiEffortShortTag({ effort: s.effort }));
    return parts.filter(Boolean).join(" · ");
  }

  /* auto = 三格都没定（跟随默认）；inherited = 来自上层节点（虚线）。
     类名用 .n-ai-call（与开发节点 .n-dev-model 同款视觉、不同类名 —— 开发节点上的
     Agent 设定按钮与它的锚点选择器保持原样，两块面板互斥但不共享 DOM 标记）。 */
  function aiCallButtonState(node) {
    const eff = aiResolvedModel(node);
    if (eff) return "n-ai-call ai-call-btn" + (eff.inherited ? " inherited" : "");
    const s = aiResolvedOf(node);
    return (
      "n-ai-call ai-call-btn" + (s.preset || s.effort ? "" : " auto")
    );
  }

  function aiCallScopedWord(node) {
    if (isToolAiNode(node)) return I18n.t("本工具节点需要借助 AI 时");
    if (node && node.kind === "function") return I18n.t("本函数节点需要借助 AI 时");
    return I18n.t("本功能块的「建议 / 开发 / 细化」");
  }

  function aiCallButtonTitle(node) {
    const eff = aiResolvedModel(node);
    const scoped = aiCallScopedWord(node);
    let t;
    if (!eff)
      t = I18n.t("AI 调用：自动（跟随默认）· 点击选择模型 / 预设 / 思考强度");
    else {
      const m = aiRouteName(eff.provider) + " · " + eff.model;
      t = eff.inherited
        ? I18n.t("AI 调用：") +
          m +
          I18n.t("（继承自「") +
          ((eff.source && (eff.source.title || eff.source.id)) || "") +
          I18n.t("」）· 点击为本节点单独选择")
        : I18n.t("AI 调用：") + m + I18n.t(" · 点击修改");
    }
    return (
      t +
      "\n" +
      I18n.t("生效范围：") +
      scoped +
      I18n.t("一律按这里的设定调用模型，改动立即生效。") +
      "\n" +
      I18n.t("AI 调用预设：") +
      aiPresetDialogText(node) +
      "\n" +
      I18n.t("思考强度：") +
      aiEffortDialogText(node)
    );
  }

  function aiCallButtonEl(node) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = aiCallButtonState(node);
    const ico = document.createElement("span");
    ico.className = "ico";
    ico.textContent = "🤖";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = aiCallButtonLabel(node);
    btn.appendChild(ico);
    btn.appendChild(lbl);
    btn.title = aiCallButtonTitle(node);
    btn.setAttribute("aria-label", btn.title);
    btn.onclick = (ev) => {
      ev.stopPropagation();
      toggleAiCallPicker(node, btn);
    };
    return btn;
  }

  /* 板身（函数 / 工具节点折叠卡）里的入口：与头部按钮同一弹层，挂在按钮下沿 */
  function aiCallBodyButtonEl(node) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "n-dev-open n-ai-call-open";
    b.textContent = I18n.t("AI 调用");
    b.title = aiCallButtonTitle(node);
    /* 与「开发」按钮同排：不跟 .n-dev-open 的 flex:1 撑满（那是单按钮时的排版口径） */
    b.style.flex = "none";
    b.style.padding = "0 10px";
    b.onclick = (ev) => {
      ev.stopPropagation();
      toggleAiCallPicker(node, b);
    };
    return b;
  }

  function aiCallButtonRefresh(node) {
    if (!node) return;
    const sel =
      '.wf-node[data-nid="' +
      node.id +
      '"] .n-ai-call, .wf-node[data-nid="' +
      node.id +
      '"] .n-ai-call-open';
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.classList.contains("n-ai-call")) {
        el.className = aiCallButtonState(node);
        const lbl = el.querySelector(".lbl");
        if (lbl) lbl.textContent = aiCallButtonLabel(node);
      }
      const t = aiCallButtonTitle(node);
      el.title = t;
      if (typeof el.setAttribute === "function") el.setAttribute("aria-label", t);
    }
  }

  /* ---------------- 弹层 ---------------- */

  let _aiNode = null;
  let _aiPane = "model";

  const AI_PANES = [
    { key: "provider", label: "模型提供商" },
    { key: "preset", label: "预设" },
    { key: "model", label: "模型" },
    { key: "effort", label: "思考强度" },
  ];

  function aiPaneLabel(key) {
    const p = AI_PANES.filter((x) => x.key === key)[0];
    return p ? p.label : "模型";
  }

  /* 本节点选用的模型提供商路由：本节点已选 → 否则就近继承到的生效值 → 都没有交默认。
     弹层「模型提供商」这一格显示 / 写回都用它（与 aiModelOwn 的 provider 同源）。 */
  function aiProviderRouteNow(node) {
    const own = String((node && node.aiProvider) || "").trim();
    if (own) return own;
    if (node && node.dev) {
      const dev = String(node.devProvider || "").trim();
      if (dev) return dev;
    }
    const eff = aiResolvedModel(node);
    if (eff && eff.provider) return String(eff.provider);
    try {
      return String(preferredAgentProviderRoute() || "").trim() || "deepseek-official";
    } catch (_) {
      return "deepseek-official";
    }
  }

  function aiPaneCell(node, pane) {
    const s = aiResolvedOf(node);
    if (pane === "provider")
      return {
        value: aiRouteName(aiProviderRouteNow(node)),
        tip: I18n.t("模型提供商：") + aiModelDialogText(node),
      };
    if (pane === "preset")
      return {
        value: s.preset
          ? aiPresetName(s.preset) + (s.presetInherited ? " ↩" : "")
          : I18n.t("自动"),
        tip: I18n.t("AI 调用预设：") + aiPresetDialogText(node),
      };
    if (pane === "effort")
      return {
        value: s.effort
          ? aiEffortName({ effort: s.effort }) + (s.effortInherited ? " ↩" : "")
          : I18n.t("自动"),
        tip: I18n.t("思考强度：") + aiEffortDialogText(node),
      };
    const eff = aiResolvedModel(node);
    return {
      value: eff ? eff.model + (eff.inherited ? " ↩" : "") : I18n.t("自动"),
      tip: I18n.t("AI 调用模型：") + aiModelDialogText(node),
    };
  }

  function aiDlgEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function renderAiCells(cells, node) {
    cells.innerHTML = "";
    for (const p of AI_PANES) {
      const c = aiPaneCell(node, p.key);
      const b = aiDlgEl(
        "button",
        "dev-model-cell pane-" + p.key + (p.key === _aiPane ? " on" : ""),
        null,
      );
      b.type = "button";
      b.appendChild(aiDlgEl("span", "dev-model-cell-label", I18n.t(p.label)));
      b.appendChild(aiDlgEl("span", "dev-model-cell-value", c.value));
      b.appendChild(aiDlgEl("span", "dev-model-cell-chevron", "›"));
      b.title = c.tip;
      const key = p.key;
      b.onclick = () => {
        _aiPane = key;
        renderAiCallPop();
      };
      cells.appendChild(b);
    }
  }

  function aiPopOption(list, text, on, onclick, tip, tag) {
    const b = aiDlgEl("button", "dev-model-opt" + (on ? " on" : ""), null);
    b.type = "button";
    b.appendChild(aiDlgEl("span", "m", text));
    if (tag) b.appendChild(aiDlgEl("span", "i", tag));
    if (on) b.appendChild(aiDlgEl("span", "c", "✓"));
    if (tip) b.title = tip;
    if (onclick) b.onclick = onclick;
    list.appendChild(b);
    return b;
  }

  /* 模型提供商格（本次需求）：所有模型选择处都要有提供商选项 —— 此前「模型」格只能按
     服务商分组跨家点，本节点 / 就近继承选的是哪一家看不出来、也点不了。
     选一家 = 连模型一起拨过去（模型第一只），本节点就此显式选定（不再继承）；
     这一格换了之后「模型」格接着列这一家的模型（弹层保持打开，用户接着挑）。 */
  function renderAiProviderPane(list, node) {
    const cur = aiProviderRouteNow(node);
    let groups = [];
    try {
      groups =
        typeof agentRouteGroupsNow === "function" ? agentRouteGroupsNow() || [] : [];
    } catch (_) {
      groups = [];
    }
    if (!groups.length) groups = aiModelGroups();
    for (const g of groups) {
      const on = g.id === cur;
      aiPopOption(
        list,
        g.name || g.id,
        on,
        () => {
          const m = ((g.models || [])[0] || "").trim();
          /* 这一家清单为空也要记下路由（aiProvider），否则「选了家却回到自动」看不出为什么 */
          applyAiCallSetting(node, "model", m, g.id, {
            keepOpen: true,
            keepPane: true,
            absentOk: true,
          });
          _aiPane = "model";
          renderAiCallPop();
        },
        g.id,
      );
    }
  }

  function renderAiPresetPane(list, node) {
    const own = aiPresetOwn(node);
    const s = aiResolvedOf(node);
    const inherited = !own && !!s.preset && !!s.presetInherited;
    aiPopOption(
      list,
      I18n.t("跟随默认（不指定）"),
      !own,
      () => applyAiCallSetting(node, "preset", ""),
      I18n.t("不指定：本节点与未自行选择的内部节点跟随默认预设。"),
    );
    const presets =
      typeof AGENT_PRESETS !== "undefined" && Array.isArray(AGENT_PRESETS)
        ? AGENT_PRESETS
        : [];
    for (const p of presets) {
      aiPopOption(
        list,
        I18n.t(p.labelKey),
        own === p.id,
        () => applyAiCallSetting(node, "preset", p.id),
        p.hint ? I18n.t(p.hint) : "",
        inherited && s.preset === p.id ? I18n.t("（继承）") : "",
      );
    }
  }

  function renderAiEffortPane(list, node) {
    const own = aiEffortOwn(node);
    const uiOrder =
      typeof AGENT_EFFORT_UI_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_UI_ORDER)
        ? AGENT_EFFORT_UI_ORDER
        : ["low", "high", "xhigh", "max"];
    const maxTip = I18n.t("最强：推理预算最高（更慢、更费 token），不受任何预设影响");
    for (const v of uiOrder) {
      aiPopOption(
        list,
        aiEffortName(v) || I18n.t("标准"),
        own === v,
        () => applyAiCallSetting(node, "effort", v),
        v === "max" ? maxTip : "",
      );
    }
  }

  function renderAiModelPane(list, node) {
    const own = aiModelOwn(node);
    const curKey = own ? own.provider + "|" + own.model : "";
    let any = 0;
    for (const g of aiModelGroups()) {
      const models = g.models || [];
      if (!models.length) continue;
      list.appendChild(aiDlgEl("div", "dev-model-group", g.name));
      for (const m of models) {
        aiPopOption(list, m, curKey === g.id + "|" + m, () =>
          applyAiCallSetting(node, "model", m, g.id),
        );
        any++;
      }
    }
    if (!any)
      list.appendChild(
        aiDlgEl(
          "div",
          "dev-model-empty",
          I18n.t("暂无可用模型：请先在 设置 → 模型服务 中添加服务商与模型。"),
        ),
      );
  }

  function aiCallPopEl() {
    let el = document.getElementById("aiCallPop");
    if (el) return el;
    el = document.createElement("div");
    el.id = "aiCallPop";
    el.className = "dev-model-pop";
    const head = document.createElement("div");
    head.className = "dev-model-head";
    head.appendChild(aiDlgEl("b", null, I18n.t("AI 调用")));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mini dev-model-close";
    close.textContent = "✕";
    close.onclick = () => closeAiCallPicker();
    head.appendChild(close);
    const cells = document.createElement("div");
    cells.className = "dev-model-cells";
    const scope = document.createElement("div");
    scope.className = "dev-model-scope";
    const list = document.createElement("div");
    list.className = "dev-model-list";
    const foot = document.createElement("div");
    foot.className = "dev-model-actions";
    el.appendChild(head);
    el.appendChild(cells);
    el.appendChild(scope);
    el.appendChild(list);
    el.appendChild(foot);
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    document.body.appendChild(el);
    return el;
  }

  function renderAiCallPop() {
    const el = document.getElementById("aiCallPop");
    if (!el || !_aiNode) return;
    const node = _aiNode;
    const pane = _aiPane;
    const cells = el.querySelector(".dev-model-cells");
    if (cells) renderAiCells(cells, node);
    const scope = el.querySelector(".dev-model-scope");
    if (scope) scope.textContent = aiScopeText(node, pane);
    const list = el.querySelector(".dev-model-list");
    if (list) {
      list.innerHTML = "";
      if (pane === "provider") renderAiProviderPane(list, node);
      else if (pane === "preset") renderAiPresetPane(list, node);
      else if (pane === "effort") renderAiEffortPane(list, node);
      else renderAiModelPane(list, node);
    }
    const foot = el.querySelector(".dev-model-actions");
    if (foot) {
      foot.innerHTML = "";
      const reset = aiDlgEl(
        "button",
        "mini dev-model-reset",
        I18n.t("跟随默认（不指定）"),
      );
      reset.type = "button";
      reset.title =
        I18n.t("清除本节点「") +
        I18n.t(aiPaneLabel(pane)) +
        I18n.t("」这一格的选择，退回跟随默认（或继承上层）。");
      reset.onclick = () => applyAiCallSetting(node, pane, "");
      foot.appendChild(reset);
    }
  }

  /* 弹层顶部一句话：这一格现在生效的是什么、谁定的 */
  function aiScopeLine(value, srcNode, inherited, unsetText) {
    if (!value) return unsetText;
    if (inherited)
      return (
        I18n.t("当前继承自「") +
        ((srcNode && (srcNode.title || srcNode.id)) || "") +
        I18n.t("」：") +
        value +
        I18n.t("；在此单独选择后，本节点改用它。")
      );
    return I18n.t("本节点已选择：") + value + I18n.t("；其下未自行选择的内部节点一并使用它。");
  }

  function aiScopeText(node, pane) {
    const s = aiResolvedOf(node);
    if (pane === "provider") {
      const eff = aiResolvedModel(node);
      return aiScopeLine(
        aiRouteName(aiProviderRouteNow(node)),
        eff && eff.source,
        !!(eff && eff.inherited),
        I18n.t("未选择：本节点需要借助 AI 时跟随默认模型提供商。"),
      );
    }
    if (pane === "effort") {
      if (!s.effort) return I18n.t("未选择：跟随默认思考档（标准）。");
      return (
        I18n.t("思考强度：") +
        aiEffortName({ effort: s.effort }) +
        aiInheritSuffix(s.effortSource, node)
      );
    }
    if (pane === "preset")
      return aiScopeLine(
        s.preset ? aiPresetName(s.preset) : "",
        s.presetSource,
        s.presetInherited,
        I18n.t("未选择：本节点与未自行选择的内部节点跟随默认预设。"),
      );
    const eff = aiResolvedModel(node);
    return aiScopeLine(
      eff ? aiRouteName(eff.provider) + " · " + eff.model : "",
      eff && eff.source,
      !!(eff && eff.inherited),
      I18n.t("未选择：本节点需要借助 AI 时跟随默认模型。"),
    );
  }

  function aiModelDialogText(node) {
    const eff = aiResolvedModel(node);
    if (!eff) return I18n.t("自动（跟随默认）");
    return (
      aiRouteName(eff.provider) +
      " · " +
      eff.model +
      (eff.inherited
        ? I18n.t("（继承自「") +
          ((eff.source && (eff.source.title || eff.source.id)) || "") +
          I18n.t("」）")
        : "")
    );
  }

  function aiInheritSuffix(srcNode, node) {
    if (!srcNode || srcNode === node) return "";
    return I18n.t("（继承自「") + (srcNode.title || srcNode.id) + I18n.t("」）");
  }

  function aiPresetDialogText(node) {
    const s = aiResolvedOf(node);
    if (!s.preset) return I18n.t("自动（跟随默认）");
    return aiPresetName(s.preset) + aiInheritSuffix(s.presetSource, node);
  }

  function aiEffortDialogText(node) {
    const s = aiResolvedOf(node);
    if (!s.effort) return I18n.t("自动（跟随默认）");
    return aiEffortName({ effort: s.effort }) + aiInheritSuffix(s.effortSource, node);
  }

  /* 四格共用写回：key = "provider" | "preset" | "model" | "effort"（model 另带 route）；
     空值 = 清除本节点选择。写节点 → 存盘 → 就地刷新按钮 → 重绘画布（弹层保持打开，
     用户还要接着改别的格；这是 persistent 面板，不点外部收起）。
     opts.keepPane = 重绘后停在哪一格（「模型提供商」那一格换完要接着挑模型）。 */
  function applyAiCallSetting(node, key, value, route, opts) {
    if (!node || !aiCallTarget(node)) return;
    const k = String(key || "model");
    pushHistory();
    ensureAiCallState(node);
    const wasUnset =
      k === "model" ? !String(node.aiModel || "").trim() : false;
    if (k === "preset") node.aiPreset = aiPresetKnown(value);
    else if (k === "effort") node.aiEffort = aiEffortKnown(value);
    else if (k === "provider") {
      /* 「模型提供商」那一格跟随默认 = 清除本节点的提供商与模型（回到默认路由） */
      node.aiModel = "";
      node.aiProvider = "";
      if (!wasUnset) {
        node.aiPreset = aiPresetKnown(AGENT_PRESET_DEFAULT);
        node.aiEffort = aiEffortKnown("high");
      }
    } else {
      const m = String(value || "").trim();
      node.aiModel = m;
      /* 常规：选了模型才记路由（模型与提供商成对）；「模型提供商」那一格例外（absentOk）：
         即便这一家清单为空也把路由记下，用户明确选了哪一家不再被抹成「自动」。 */
      node.aiProvider = (m || (opts && opts.absentOk)) ? String(route || "").trim() : "";
      /* 清掉模型选择 = 回到「跟随默认」：预设 / 思考强度也退回新建时的默认补种，
         否则会留下上一轮选择里的档位，与新节点的表现不一致。 */
      if (!m && !wasUnset && !(opts && opts.absentOk)) {
        node.aiPreset = aiPresetKnown(AGENT_PRESET_DEFAULT);
        node.aiEffort = aiEffortKnown("high");
      }
    }
    /* 开发节点：历史字段与本套字段同义，同步写过去，别的按 devModel 读的老代码不受影响 */
    if (node.dev) {
      if (k === "preset") node.devPreset = node.aiPreset;
      else if (k === "effort") node.devEffort = node.aiEffort;
      else {
        node.devModel = node.aiModel;
        node.devProvider = node.aiProvider;
      }
    }
    scheduleSave(true);
    aiCallButtonRefresh(node);
    if (opts && opts.keepPane) _aiPane = String(opts.keepPane);
    try {
      renderCanvas();
      renderAiCallPop();
    } catch (_) {}
  }

  function openAiCallPop(node, anchor) {
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("aiCall");
    _aiNode = node;
    _aiPane = "model";
    const el = aiCallPopEl();
    el.classList.add("on");
    renderAiCallPop();
    if (anchor && typeof nodePopAnchor === "function") {
      /* 头部按钮可锚（节点平移 / 缩放后跟随）；板身按钮没有稳定选择器，只定位一次 */
      const nid = anchor.closest && anchor.closest(".wf-node")
        ? anchor.closest(".wf-node").getAttribute("data-nid") || node.id
        : node.id;
      nodePopAnchor(el, null, { h: 320 }, nid);
    }
    if (typeof placeNodePop === "function") placeNodePop(el, anchor, el._popOpt || {});
  }

  function closeAiCallPicker() {
    _aiNode = null;
    const el = document.getElementById("aiCallPop");
    if (el) el.classList.remove("on");
  }

  function toggleAiCallPicker(node, anchor) {
    if (!node || !aiCallTarget(node)) return;
    const el = document.getElementById("aiCallPop");
    if (_aiNode === node && el && el.classList.contains("on")) {
      closeAiCallPicker();
      return;
    }
    S.uiAiCallNode = node.id;
    openAiCallPop(node, anchor);
  }

  /* ---------------- 对外出口 ---------------- */

  window.MTNodeAiCall = {
    /* 节点判定 / 归一 */
    target: aiCallTarget,
    ensureState: ensureAiCallState,
    seedDefaults: aiCallSeedDefaults,
    /* 生效值 */
    resolvedOf: aiResolvedOf,
    resolvedModel: aiResolvedModel,
    modelOwn: aiModelOwn,
    presetOwn: aiPresetOwn,
    effortOwn: aiEffortOwn,
    presetKnown: aiPresetKnown,
    effortKnown: aiEffortKnown,
    /* 运行期 */
    nodeNeedsAi: aiCallNodeNeeds,
    applyToNode: aiApplyToNode,
    applyToToolRun: aiApplyToToolRun,
    runSpecFor: aiRunSpecFor,
    applyToSelf: aiApplyToSelf,
    /* UI */
    buttonEl: aiCallButtonEl,
    bodyButtonEl: aiCallBodyButtonEl,
    buttonRefresh: aiCallButtonRefresh,
    openPicker: openAiCallPop,
    closePicker: closeAiCallPicker,
    togglePicker: toggleAiCallPicker,
    applySetting: applyAiCallSetting,
  };

  /* 全局函数别名：index.html 的脚本分层（app.js / app-canvas.js / app-nodes.js 按调用期
     取函数）与 test/ 的切片真跑都用这些名字，不强迫调用方走命名空间。 */
  window.aiCallTarget = aiCallTarget;
  window.ensureAiCallState = ensureAiCallState;
  window.ensureDevAiCallState = ensureDevAiCallState;
  window.aiCallSeedDefaults = aiCallSeedDefaults;
  window.aiResolvedOf = aiResolvedOf;
  window.aiResolvedModel = aiResolvedModel;
  window.aiModelOwn = aiModelOwn;
  window.aiCallButtonEl = aiCallButtonEl;
  window.aiCallBodyButtonEl = aiCallBodyButtonEl;
  window.aiCallButtonRefresh = aiCallButtonRefresh;
  window.openAiCallPicker = openAiCallPop;
  window.closeAiCallPicker = closeAiCallPicker;
  window.toggleAiCallPicker = toggleAiCallPicker;
  window.applyAiCallSetting = applyAiCallSetting;
  window.aiApplyToNode = aiApplyToNode;
  window.aiCallNodeNeeds = aiCallNodeNeeds;
  window.aiCallNodeChosen = aiCallNodeChosen;
  window.aiApplyToToolRun = aiApplyToToolRun;
  window.aiRunSpecFor = aiRunSpecFor;
  window.aiApplyToSelf = aiApplyToSelf;
})();

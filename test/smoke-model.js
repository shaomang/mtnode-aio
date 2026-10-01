/* test/smoke-model.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-model.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-model-provider-option.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-model-provider-option.js";
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
  const eqStr = (a, b, msg) =>
    ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

  const ASSIST = read("renderer/app-assist.js");
  const DEVNODE = read("renderer/app-devnode.js");
  const AICALL = read("renderer/app-aicall.js");
  const CTL = read("renderer/app-longtask-ctl.js");
  const APP = read("renderer/app.js");
  const PLAN = read("renderer/app-plan.js");
  const I18N = read("renderer/i18n.js");

  /* ═══════════════ 假 DOM（够跑 buildAgentModelMenu 这一族） ═══════════════ */
  /* 极简 HTML 片段解析：只认菜单用到的嵌套 <span class="...">…</span>
     —— innerHTML 赋值要真的建出可 querySelector 的元素树，否则真跑跑不起来 */
  function parseSpans(html) {
    const src = String(html);
    const stack = [];
    const root = { children: [] };
    let cur = root;
    const re = /<span(\s+class="([^"]*)")?>|<\/span>|([^<]+)/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[0] === "</span>") {
        cur = stack.pop() || root;
        continue;
      }
      if (m[1] != null) {
        const el = mkEl("span");
        el.className = m[2] || "";
        cur.children.push(el);
        stack.push(cur);
        cur = el;
        continue;
      }
      if (m[3]) cur.children.push(Object.assign(mkEl("span"), { _text: m[3] }));
    }
    return root.children;
  }
  function mkEl(tag) {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      className: "",
      hidden: false,
      dataset: {},
      title: "",
      children: [],
      _text: "",
      appendChild(c) {
        el.children.push(c);
        return c;
      },
      setAttribute() {},
      addEventListener() {},
      querySelector(sel) {
        const cls = String(sel || "").replace(/^\./, "");
        const walk = (list) => {
          for (const c of list) {
            if (String(c.className || "").split(/\s+/).indexOf(cls) >= 0) return c;
            const deep = walk(c.children || []);
            if (deep) return deep;
          }
          return null;
        };
        return walk(el.children);
      },
    };
    Object.defineProperty(el, "innerHTML", {
      get: () => "",
      set(v) {
        el.children.length = 0;
        for (const c of parseSpans(v)) el.appendChild(c);
      },
    });
    Object.defineProperty(el, "textContent", {
      get: () => {
        if (el.children.length) return el.children.map((c) => c.textContent).join("");
        return el._text;
      },
      set(v) {
        el._text = v == null ? "" : String(v);
        el.children.length = 0;
      },
    });
    return el;
  }
  const hasClass = (el, cls) => String((el && el.className) || "").split(/\s+/).indexOf(cls) >= 0;
  const byClass = (el, cls) => ((el && el.children) || []).filter((c) => hasClass(c, cls));
  /* 某个 option 的显示名（.agent-menu-option-name 正文） */
  const optName = (o) => {
    const n = o && o.querySelector && o.querySelector(".agent-menu-option-name");
    return n ? n.textContent : "";
  };
  /* 某一格（.agent-menu-cell）的回显值 */
  const cellValue = (c) => {
    const v = c && c.querySelector && c.querySelector(".agent-menu-cell-value");
    return v ? v.textContent : "";
  };
  const cellLabel = (c) => {
    const l = c && c.querySelector && c.querySelector(".agent-menu-cell-label");
    return l ? l.textContent : "";
  };

  /* 两家服务商各有一只同名模型 shared —— 跨家误选的现场就是这个形状 */
  const GROUPS = [
    { id: "deepseek-official", name: "DeepSeek 官方", models: ["ds-flash", "ds-pro"] },
    { id: "mtnode_a", name: "A家", models: ["shared", "a-only"] },
    { id: "mtnode_b", name: "B家", models: ["shared", "b-only"] },
  ];

  /* 从 app-assist.js 切出真正的菜单构建函数（closeAgentMenus → buildAgentModelMenu 结束），
     连同本轮的 agentProviderGroupsNow / agentSessionProviderRoute / agentProviderNameNow /
     agentMenuItemCell 一起跑 —— 不是抄一份逻辑。 */
  function sliceMenuSrc(src) {
    const a = src.indexOf("function closeAgentMenus() {");
    const b = src.indexOf("/* ── 技能 chip：三级分类菜单", a);
    if (a < 0 || b < 0) return "";
    return src.slice(a, b);
  }
  const MENU_SRC = sliceMenuSrc(ASSIST);

  function mkMenuSandbox() {
    const menu = mkEl("div");
    const st = { provider: "mtnode_a", model: "a-only", preset: "standard", effort: "high" };
    const doc = {
      createElement: mkEl,
      getElementById: (id) => (id === "agentModelMenu" ? menu : null),
    };
    const sandbox = {
      document: doc,
      I18n: { t: (k, v) => i18nResolve(k, v) },
      console,
      stRef: st,
      menuRef: menu,
      agentSessionState: () => st,
      persistAgentSession: () => {},
      renderAgentSession: () => {},
      renderAgentSessionSidebar: () => {},
      preferredAgentProviderRoute: () => "mtnode_a",
      agentPresetById: (id) => ({ id: id || "standard", labelKey: "标准模式" }),
      agentPresetLabel: () => "标准模式",
      agentEffortDisplayLabel: () => "标准",
      normalizeAgentEffort: (v) => String(v || "high"),
      AGENT_EFFORT_UI_ORDER: ["off", "low", "high", "xhigh", "max"],
      AGENT_EFFORT_LABELS: { off: "无", low: "轻", high: "标准", xhigh: "强", max: "最强" },
      agentEffortLabelOf: (v) => ({ off: "无", low: "轻", high: "标准", xhigh: "强", max: "最强" })[String(v)] || "标准",
      /* 本轮的提供商真源：菜单只认这一个 */
      agentRouteGroupsNow: () => JSON.parse(JSON.stringify(GROUPS)),
      agentProviderGroupsNow: () => JSON.parse(JSON.stringify(GROUPS)),
      /* 真实 agentModelName 依赖的两个 dsh 侧函数（切片里没带过来） */
      dshProvider: () => ({ name: "DeepSeek 官方", models: ["ds-flash", "ds-pro"] }),
      mtnodePiProviders: () => [
        { route: "a", name: "A家", models: ["shared", "a-only"] },
        { route: "b", name: "B家", models: ["shared", "b-only"] },
      ],
      AGENT_PRESETS: [{ id: "standard", labelKey: "标准模式" }],
    };
    vm.createContext(sandbox);
    vm.runInContext(MENU_SRC, sandbox, { filename: "renderer/app-assist.js#menu" });
    return sandbox;
  }
  /* 词条解析：真实 i18n 在后面 [B] 里查；真跑这一段只关心结构不关心翻译 */
  function i18nResolve(k, v) {
    let s = String(k);
    if (v && typeof v === "object")
      for (const key of Object.keys(v)) s = s.split("{" + key + "}").join(String(v[key]));
    return s;
  }

  console.log("\n[A] 真跑会话选型菜单：根页有「模型提供商」一格，点它进提供商页");
  ok(MENU_SRC.length > 800, "从 app-assist.js 切到真正的菜单构建源码（" + MENU_SRC.length + " 字符）");
  {
    const sb = mkMenuSandbox();
    sb.buildAgentModelMenu();
    const cells = byClass(sb.menuRef, "agent-menu-cell");
    eqStr(cells.length, 4, "根页 4 格（模型提供商 / 预设 / 模型 / 思考强度）");
    eqStr(cells.map(cellLabel).join(","), "模型提供商,预设,模型,思考强度", "第一格就是「模型提供商」（提供商排在最前，先定家再挑模型）");
    eqStr(cellValue(cells[0]), "A家", "提供商格回显当前这一家的显示名");
    eqStr(cellValue(cells[2]), "a-only", "模型格回显当前模型");
  }
  {
    const sb = mkMenuSandbox();
    sb.menuRef.dataset.pane = "provider";
    sb.buildAgentModelMenu();
    const opts = byClass(sb.menuRef, "agent-menu-option");
    eqStr(opts.map(optName).join(","), "DeepSeek 官方,A家,B家", "提供商页列出全部可选提供商（DeepSeek 官方 + 已配置的两家）");
    const checked = opts.filter((o) => {
      const c = o.querySelector(".agent-menu-check");
      return c && c.textContent === "✓";
    });
    eqStr(checked.length, 1, "只给当前这一家打 ✓");
    eqStr(optName(checked[0]), "A家", "✓ 打在当前会话的供应商上");
    ok(!!byClass(sb.menuRef, "agent-menu-back")[0], "提供商页有返回根页的「←」");
  }
  {
    /* 选另一家 = 连模型一起拨过去（留下「A家的模型配B家路由」才是真的会炸） */
    const sb = mkMenuSandbox();
    sb.menuRef.dataset.pane = "provider";
    sb.buildAgentModelMenu();
    const bOpt = byClass(sb.menuRef, "agent-menu-option").filter((o) => optName(o) === "B家")[0];
    bOpt.onclick();
    eqStr(sb.stRef.provider, "mtnode_b", "点 B家：会话供应商改成 B家");
    eqStr(sb.stRef.model, "shared", "点 B家：模型一起拨成该家第一只（不留跨家组合）");
    eqStr(sb.menuRef.dataset.pane, "model", "选完提供商自动进「模型」格，接着挑具体模型");
  }
  {
    /* 点模型不许动供应商（老需求仍然成立） */
    const sb = mkMenuSandbox();
    sb.menuRef.dataset.pane = "model";
    sb.buildAgentModelMenu();
    const opts = byClass(sb.menuRef, "agent-menu-option");
    eqStr(opts.map(optName).join(","), "shared,a-only", "模型格只列当前这一家（A家）的模型");
    opts[0].onclick();
    eqStr(sb.stRef.provider, "mtnode_a", "点模型不改供应商");
    eqStr(sb.stRef.model, "shared", "点模型只改模型");
  }
  {
    /* 会话存的供应商已不在配置里：照实说明，不静默切别家 */
    const sb = mkMenuSandbox();
    sb.stRef.provider = "mtnode_gone";
    sb.menuRef.dataset.pane = "model";
    sb.buildAgentModelMenu();
    const empty = byClass(sb.menuRef, "agent-menu-empty");
    eqStr(empty.length, 1, "供应商没了 → 模型格给空态说明（不编一个别家的表）");
    eqStr(sb.stRef.provider, "mtnode_gone", "空态下也不静默改掉会话存的供应商");
  }

  console.log("\n[B] 其余四处模型选择入口：都有模型提供商口径");
  const panesHasProvider = (src, name) =>
    ok(
      src.indexOf('{ key: "provider"') >= 0 && src.indexOf("agentRouteGroupsNow") >= 0,
      name + "：格子里有「模型提供商」，且取的是统一真源 agentRouteGroupsNow",
    );
  panesHasProvider(DEVNODE, "开发节点 Agent 设定（app-devnode.js）");
  has(DEVNODE, 'if (pane === "provider") devRenderProviderPane(list, node);', "开发节点：提供商格有对应的清单渲染分支");
  has(DEVNODE, 'applyDevAgentSetting(node, "model", m, g.id, {', "开发节点：选提供商连模型一起拨过去");
  has(DEVNODE, "keepOpen: true, absentOk: true", "开发节点：弹层留着接着挑模型；这一家清单为空也记下路由");
  has(AICALL, 'if (pane === "provider") renderAiProviderPane(list, node);', "AI 调用弹层：提供商格有对应的清单渲染分支");
  has(AICALL, 'applyAiCallSetting(node, "model", m, g.id, {', "AI 调用弹层：选提供商连模型一起拨过去");
  has(AICALL, "keepOpen: true,", "AI 调用弹层：弹层留着（用户接着挑模型）");
  has(AICALL, 'node.aiProvider = (m || (opts && opts.absentOk)) ? String(route || "").trim() : "";', "AI 调用弹层：提供商与模型仍成对落盘，提供商那一格才允许「只记家」");
  /* 长任务：服务商格 + 收窄后的模型格（真源在 app-longtask-ctl.js） */
  has(CTL, "providerOptions: routes.map((g) => ({ value: g.id, label: g.name, hint: g.id })),", "长任务选型：providerOptions 就是服务商格清单");
  has(CTL, "const modelGroupsFor = (r) => {", "长任务选型：模型格按服务商收窄（选家与挑模型两格分开）");
  /* 建图选型：模型下拉按服务商 optgroup 分组（选中即连服务商一起拨正） */
  has(APP, "const og = document.createElement(\"optgroup\");", "建图选型：模型下拉按服务商分组");
  has(APP, "addOpt(og, g.id + \"|\" + m, String(m));", "建图选型：每项 value = 「路由|模型」成对编码（不丢提供商）");
  has(APP, "  typeof devAgentModelGroups === \"function\" ? devAgentModelGroups() || [] : [];", "建图选型：清单来自带服务商名的分组真源（不是裸模型列表）");
  /* 计划逐项：模型清单按服务商分组 */
  has(PLAN, "for (const g of _planModelPool || []) {", "计划逐项：模型清单按服务商分组遍历");
  has(PLAN, "planDlgEl(\"div\", \"mt-plan-model-group\", g.name || g.id || \"\")", "计划逐项：分组标题就是服务商名");

  console.log("\n[C] i18n：新词条中英齐备（切英文不出现中文半截）");
  {
    const I17 = require("../renderer/i18n.js");
    const keys = [
      "模型提供商",
      "模型提供商：",
      "模型提供商 / 预设 / 模型 / 思考强度",
      "未选择：本功能块与子功能块跟随默认模型提供商。",
      "未选择：本节点需要借助 AI 时跟随默认模型提供商。",
    ];
    I17.setLocale("en");
    const miss = keys.filter((k) => I17.t(k) === k);
    eqStr(miss.length, 0, "i18n 中英词条齐备" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
    eqStr(I17.t("模型提供商"), "Model provider", "英文词条内容正确");
    I17.setLocale("zh");
    eqStr(I17.t("模型提供商"), "模型提供商", "中文界面回显中文原文");
    for (const k of keys) has(I18N, '"' + k + '"', "i18n 源文件里有「" + k + "」的词条");
  }

  console.log("\n" + (fails ? "FAIL" : "PASS") + "  smoke-model-provider-option：" + checks + " 项，" + fails + " 项失败");

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-model-provider-option.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-model-provider-option.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-model-provider-scope.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-model-provider-scope.js";
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
  const eqStr = (a, b, msg) =>
    ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
  const eqNum = (a, b, msg) =>
    ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

  const CTL = read("renderer/app-longtask-ctl.js");
  const LTU = read("renderer/app-longtask-ui.js");
  const LTC = read("renderer/app-longtask-create.js");
  const ASSIST = read("renderer/app-assist.js");
  const I18N = read("renderer/i18n.js");

  /* ═══════════════ 假 DOM（与 smoke-longtask-model.js 同口径，只够跑 ltSelField） ═══════════ */
  function mkEl(tag) {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      className: "",
      hidden: false,
      value: "",
      placeholder: "",
      type: "",
      autocomplete: "",
      spellcheck: true,
      attrs: {},
      handlers: {},
      children: [],
      _text: "",
      appendChild(c) {
        el.children.push(c);
        return c;
      },
      setAttribute(k, v) {
        el.attrs[k] = String(v);
      },
      addEventListener(k, fn) {
        (el.handlers[k] = el.handlers[k] || []).push(fn);
      },
      select() {},
      scrollIntoView() {},
      contains() {
        return false;
      },
      closest() {
        return null;
      },
    };
    const parts = () => String(el.className || "").split(/\s+/).filter(Boolean);
    el.classList = {
      add(...c) {
        const s = parts();
        for (const x of c) if (s.indexOf(x) < 0) s.push(x);
        el.className = s.join(" ");
      },
      remove(...c) {
        el.className = parts().filter((x) => c.indexOf(x) < 0).join(" ");
      },
      contains(c) {
        return parts().indexOf(c) >= 0;
      },
      toggle(c, force) {
        const had = el.classList.contains(c);
        const want = force === undefined ? !had : !!force;
        if (want && !had) el.classList.add(c);
        else if (!want && had) el.classList.remove(c);
        return want;
      },
    };
    Object.defineProperty(el, "childElementCount", { get: () => el.children.length });
    Object.defineProperty(el, "textContent", {
      get: () => el._text,
      set(v) {
        el._text = v == null ? "" : String(v);
        el.children.length = 0;
      },
    });
    return el;
  }
  const mkFakeDoc = () => ({
    createElement: mkEl,
    activeElement: null,
    addEventListener() {},
    getElementById() {
      return null;
    },
  });
  const hasClass = (el, cls) => String((el && el.className) || "").split(/\s+/).indexOf(cls) >= 0;
  const childByClass = (el, cls) => ((el && el.children) || []).filter((c) => hasClass(c, cls))[0] || null;
  /* 下拉里当前可见的分组标签（= 模型格那一格能点到的服务商） */
  function groupLabels(pop) {
    const out = [];
    for (const ch of pop.children) if (hasClass(ch, "lt-sel-g")) out.push(ch.textContent);
    return out;
  }
  /* 某一分组里的模型 label 列表 */
  function optsOf(pop, groupLabel) {
    let label = "";
    const out = [];
    for (const ch of pop.children) {
      if (hasClass(ch, "lt-sel-g")) {
        label = ch.textContent;
        continue;
      }
      if (hasClass(ch, "lt-sel-grp") && label === groupLabel) {
        for (const op of ch.children) {
          const ol = childByClass(op, "lt-sel-ol");
          out.push(ol ? ol.textContent : "");
        }
      }
    }
    return out;
  }

  /* 两家服务商各有一只同名模型 shared —— 「选 B 家落到 A 家」的现场就是这个形状 */
  const GROUPS = [
    { id: "prov-a", name: "A家", models: ["shared", "a-only"] },
    { id: "prov-b", name: "B家", models: ["shared", "b-only"] },
  ];
  function mkCtlSandbox(extra) {
    const sandbox = {
      window: {},
      document: mkFakeDoc(),
      devAgentModelGroups: () => JSON.parse(JSON.stringify(GROUPS)),
      preferredAgentProviderRoute: () => "prov-b",
      preferredAgentModelForRoute: (r) => (r === "prov-b" ? "b-only" : ""),
      AGENT_PRESETS: [{ id: "standard", labelKey: "标准预设" }],
      AGENT_EFFORT_UI_ORDER: ["low", "high"],
      AGENT_EFFORT_ORDER: ["low", "medium", "high", "xhigh", "max"],
      AGENT_EFFORT_LABELS: { low: "低", high: "高" },
      AGENT_PRESET_DEFAULT: "standard",
      S: { assistPreset: "standard", assistEffort: "high" },
      I18n: { t: (s) => s },
      console,
    };
    Object.assign(sandbox, extra || {});
    vm.createContext(sandbox);
    vm.runInContext(CTL, sandbox, { filename: "renderer/app-longtask-ctl.js" });
    return sandbox;
  }

  const cs = mkCtlSandbox();
  const ctl = cs.window.LT && cs.window.LT.ui && cs.window.LT.ui.ctl;

  console.log("\n[1] 收窄口径真跑：modelGroupsFor(route) 只列这一家（真跑 app-longtask-ctl.js）");
  ok(!!ctl && typeof ctl.agentOpts === "function", "控件工厂整份执行并挂上 window.LT.ui.ctl");
  const AO = ctl.agentOpts();
  ok(typeof AO.modelGroupsFor === "function", "agentOpts 出口新增 modelGroupsFor（收窄清单唯一真源）");
  {
    const all = AO.modelGroups.map((g) => g.group).join(",");
    eqStr(all, "A家,B家", "路由留空时的全量清单仍是两家都在（清单本身就是选型入口）");
    const a = AO.modelGroupsFor("prov-a");
    eqStr(a.map((g) => g.group).join(","), "A家", "选了 A 家：模型清单只剩 A家 这一组");
    eqStr(
      a[0].items.map((it) => it.label).join(","),
      "shared,a-only",
      "A家 组里就是它自己的两只模型（同名 shared 只出现一次）",
    );
    eqStr(a[0].items.map((it) => it.value).join(","), "prov-a|shared,prov-a|a-only", "value 仍是「路由|模型」成对编码");
    const b = AO.modelGroupsFor("prov-b");
    eqStr(b.map((g) => g.group).join(","), "B家", "选了 B 家：只剩 B家 这一组");
    eqStr(b[0].items.map((it) => it.label).join(","), "shared,b-only", "B家 组里没有 A家 的 a-only");
    eqStr(AO.modelGroupsFor("").map((g) => g.group).join(","), "A家,B家", "空路由 = 全量（老调用方的口径不变）");
    eqStr(AO.modelGroupsFor("prov-gone").length, 0, "路由不在清单里（服务商被删）→ 空清单，不编一个别家的表");
  }
  has(CTL, "const modelGroupsFor = (r) => {", "收窄函数在 ctl 里只有一份");
  has(CTL, "modelGroupsFor: modelGroupsFor,", "modelGroupsFor 挂进 agentOpts 出口");
  has(CTL, "if (!s) return modelGroups;", "路由留空走全量分支（不是空表）");
  {
    const seg = CTL.slice(CTL.indexOf("const modelGroups = routes"));
    const dup = seg.slice(0, seg.indexOf("const modelGroupsFor")).indexOf("ltaKeyOf(g.id, m)") >= 0;
    ok(dup, "全量清单只建一次（收窄函数复用它，不复制第二份 key 拼法）");
  }

  console.log("\n[2] 控件真跑：模型格 setOptions 到收窄清单后点不到别家的模型");
  ok(typeof ctl.modelScopeOpts === "function", "ctl 出口新增 modelScopeOpts（模型格收窄选项的唯一口径）");
  {
    const fdoc = mkFakeDoc();
    const cs2 = mkCtlSandbox({ document: fdoc });
    const ctl2 = cs2.window.LT.ui.ctl;
    const AO2 = ctl2.agentOpts();
    const host = fdoc.createElement("div");
    /* 模型格：初值先按 A 家给（模拟到达时路由已选定） */
    const handle = ctl2.ltSelField(
      host,
      "模型",
      "prov-a|shared",
      ctl2.modelScopeOpts(AO2, "prov-a", null),
      () => {},
      { allowEmpty: true, emptyLabel: "跟随默认" },
    );
    const pop = childByClass(handle.el, "lt-sel-pop");
    handle.open();
    eqStr(groupLabels(pop).join(","), "A家", "模型格初开：只列 A家 一组（别家的模型根本点不到）");
    eqStr(handle.input.value, "shared", "当前值照常回显成模型名");
    /* 换到 B 家：先回显值，再按 B 家重列（面板 / 检查器的真实顺序） */
    handle.setValue("prov-b|b-only", true);
    handle.setOptions(ctl2.modelScopeOpts(AO2, "prov-b", handle));
    handle.close();
    handle.open();
    eqStr(groupLabels(pop).join(","), "B家", "换到 B 家：清单跟着换成 B家（不整窗重建也收窄）");
    eqStr(optsOf(pop, "B家").join(","), "shared,b-only", "B家 组里两只都在（含同名 shared）");
    eqStr(handle.value(), "prov-b|b-only", "换家后控件的值 = 新家的「路由|模型」成对编码");
    /* 历史值（不属于该家）不许被静默吞掉：单独成组列出并说明 */
    handle.setValue("prov-a|a-only", true);
    handle.setOptions(ctl2.modelScopeOpts(AO2, "prov-b", handle));
    handle.close();
    handle.open();
    const labels = groupLabels(pop);
    ok(labels.indexOf("B家") >= 0, "B家 分组仍在（收窄不等于清空）");
    ok(labels.indexOf("（不属于该服务商）") >= 0, "不属于该家的历史值单独成组（不静默改掉，看得到原因）");
    eqStr(optsOf(pop, "（不属于该服务商）").join(","), "a-only", "那一组里显示的是模型名（用户认模型，不认编码）");
    {
      const g = pop.children.filter((c) => hasClass(c, "lt-sel-g") && c.textContent === "（不属于该服务商）")[0];
      const grp = g ? pop.children[pop.children.indexOf(g) + 1] : null;
      const hint = grp && childByClass(grp.children[0], "lt-sel-oh");
      ok(!!hint && hint.textContent.indexOf("A家") >= 0, "越界项的 hint 说清它原本属于哪一家（「A家」在）");
    }
    eqStr(handle.value(), "prov-a|a-only", "控件仍持有该值（回显不乱、也不偷偷换成别家的模型）");
  }
  has(CTL, "function ltcModelScopeOpts(AO, route, handle) {", "modelScopeOpts 的实现只有一份（四处模型格共用）");
  has(CTL, "const cur = handle && typeof handle.value === \"function\"", "越界值判据取控件当前值（现取现算，不缓存）");
  has(CTL, "modelScopeOpts: ltcModelScopeOpts,", "modelScopeOpts 挂进 ctl 出口");

  console.log("\n[3] 界面接线：四处模型格都按上一格收窄");
  /* [3a] 会话头部的模型菜单：模型清单只列当前供应商，不再「点模型 = 换供应商」 */
  {
    const seg = ASSIST.slice(ASSIST.indexOf('if (pane === "model") {'), ASSIST.indexOf("} else {", ASSIST.indexOf('if (pane === "model") {')));
    has(seg, 'const cur = agentProviderGroupsNow().filter((g) => g.id === agentSessionProviderRoute(st))[0] || null', "会话模型菜单按当前供应商（模型提供商那一格）命中当前供应商");
    has(seg, "for (const m of cur.models) {", "只遍历当前供应商的模型（不再 for (const g of groups) 铺全部）");
    ok(seg.indexOf("st.provider = g.id") < 0, "点模型不再顺手改供应商（正是这次要修的误选）");
    has(seg, "if (!cur) {", "会话存的供应商已不在配置里 → 单独分支（照实说明，不静默切别家）");
    has(seg, "st.model = m;", "写回口径不变：仍只改 st.model");
    has(ASSIST, 'e.textContent = I18n.t("没有可用的模型");', "空态文案用已有词条（不新增词条）");
  }
  /* [3b] 长任务检查器 */
  has(LTU, "const modelOptsNow = (route) =>", "检查器模型格有收窄取用口");
  has(LTU, "C.modelScopeOpts(AO, route, hModel)", "检查器走 ctl.modelScopeOpts（不自己写一份过滤）");
  has(LTU, "modelOptsNow(node.cfg.provider),", "检查器模型格初值按 node.cfg.provider 收窄");
  has(LTU, "if (hModel) hModel.setOptions(modelOptsNow(v));", "检查器换路由时就地重列模型清单");
  /* [3c] 条带 chip 面板（四格选型口） */
  has(LTU, "modelOptsNow(sel0.provider),", "chip 面板模型格初值按当前路由收窄");
  has(LTU, "if (hModel) hModel.setOptions(modelOptsNow(v));", "chip 面板换路由时就地重列（不整窗重建，未提交输入不丢）");
  /* [3d] 建图「Agent 选型」一栏 */
  has(LTC, "const modelOptsNow = (route) => C.modelScopeOpts(AO, route, hs.model);", "建图选型的模型格同一份收窄口径");
  has(LTC, "modelOptsNow(cfg.provider),", "建图选型模型格初值按 cfg.provider 收窄");
  has(LTC, "refreshModelOpts();", "建图选型换路由 / 静默回填时重列模型清单");
  {
    const n = (LTC.match(/refreshModelOpts\(\);/g) || []).length;
    ok(n >= 2, "建图选型在两个路径上都重列（换路由 " + n + " 处 ≥ 2：含静默回填）");
  }
  hasntAll([["app-longtask-ui.js", LTU], ["app-longtask-create.js", LTC]], "AO.modelGroups,", "长任务两处模型格不再直接吃全量清单（改吃收窄后的）");

  function hasntAll(list, needle, msg) {
    for (const [name, src] of list) {
      const c = String(src).indexOf(needle) < 0;
      ok(c, name + "：" + msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
    }
  }

  /* 兼容性：老调用方仍在的出口不许被顺手删掉 */
  has(CTL, "modelGroups: modelGroups,", "全量 modelGroups 出口保留（老调用方 / 单测仍可用）");
  has(CTL, "modelsOf: modelsOf,", "modelsOf 保留（换服务商时判断原模型属不属于新家的判据）");
  has(CTL, "routeOfModel: routeOfModel,", "routeOfModel 保留");

  console.log("\n[4] i18n：新增词条中英齐备（切英文不出现中文半截）");
  {
    const I17 = require("../renderer/i18n.js");
    const keys = ["（不属于该服务商）", "（属于「{route}」）"];
    I17.setLocale("en");
    const miss = keys.filter((k) => I17.t(k) === k);
    eqNum(miss.length, 0, "i18n 中英词条齐备" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
    eqStr(I17.t("（不属于该服务商）"), "(not from this provider)", "英文词条内容正确");
    eqStr(
      I17.t("（属于「{route}」）", { route: "A家" }),
      '(belongs to "A家")',
      "带占位符的词条能整句替换（切英文不出现中文半截）",
    );
    I17.setLocale("zh");
    eqStr(I17.t("（不属于该服务商）"), "（不属于该服务商）", "中文界面回显中文原文");
    for (const k of keys) has(I18N, '"' + k + '"', "i18n 源文件里有「" + k + "」的词条");
  }

  function hasntAll(list, needle, msg) {
    for (const [name, src] of list) {
      const c = String(src).indexOf(needle) < 0;
      ok(c, name + "：" + msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
    }
  }

  console.log("\n" + (fails ? "FAIL" : "PASS") + "  smoke-model-provider-scope：" + checks + " 项，" + fails + " 项失败");
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-model-provider-scope.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-model-provider-scope.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-model-kind.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-model-kind.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");

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
  function EQ(got, want, msg) {
    ok(
      got === want,
      msg +
        (got === want ? "" : "\n        实际=" + JSON.stringify(got) + "\n        期望=" + JSON.stringify(want)),
    );
  }
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
  const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
  function fnBody(src, name) {
    const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(src);
    if (!m) return "";
    let k = src.indexOf("{", m.index);
    let d = 0;
    for (; k < src.length; k++) {
      if (src[k] === "{") d++;
      else if (src[k] === "}") {
        d--;
        if (!d) return src.slice(m.index, k + 1);
      }
    }
    return "";
  }

  const MK = require("../renderer/app-model-kind.js");

  /* ═════════ [1] 单个模型识别 ═════════ */
  console.log("\n[1] 模型 id → 形态：常见图像家族判图像、对话模型判文本");
  {
    const IMAGE_IDS = [
      "gpt-image-2-vip",
      "gpt-image-2.5-all",
      "gpt-image-2.5-sunburst",
      "dall-e-3",
      "seedream-5-0-pro-260628",
      "flux-1.1-pro",
      "stable-diffusion-3.5-large",
      "sd3.5",
      "sdxl-turbo",
      "midjourney-v6",
      "niji-6",
      "kolors-v1.5",
      "cogview-4",
      "imagen-4.0-generate-001",
      "qwen-image-plus",
      "wanx-v1",
      "hunyuan-image-3.0",
      "ideogram-v3",
      "recraft-v3",
      "kontext-pro",
      "grok-2-image-1212",
    ];
    let bad = [];
    for (const id of IMAGE_IDS)
      if (MK.inferModelKind(id) !== "image") bad.push(id);
    ok(bad.length === 0, "图像家族全部识别为 image（漏判：" + (bad.join(", ") || "无") + "）");

    const TEXT_IDS = [
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "qwen3.8-flash",
      "qwen3.7-max",
      "glm-5.2",
      "kimi-k3",
      "MiniMax-M2.5",
      "mimo-v2.5",
      "gpt-4o",
      "claude-opus-4",
      "gemini-2.5-pro",
      "gemma-4-E4B-it",
      "llama-3.3-70b",
      "hy3",
      "ZHIPU/GLM-5.3-Flash",
      "aoi",
      "gpt-sovits",
    ];
    bad = [];
    for (const id of TEXT_IDS) if (MK.inferModelKind(id) !== "text") bad.push(id);
    ok(bad.length === 0, "对话 / 本地文本模型全部识别为 text（误判：" + (bad.join(", ") || "无") + "）");

    /* 关键反例：含 image 但其实是文本的视觉输入模型（input: text+image ≠ 出图） */
    EQ(
      MK.inferModelKind("deepseek-flash"),
      "text",
      "视觉输入模型不是图像生成模型（能看图 ≠ 会出图）",
    );
    EQ(MK.inferModelKind("gemini-2.5-flash-image"), "text", "gemini 带 image 后缀仍按文本家族判（保守不误伤）");
    EQ(MK.inferModelKind(""), "text", "空 id 回落文本（安全侧）");
    EQ(MK.inferModelKind("whatever-new-model"), "text", "未知 id 回落文本（安全侧）");
  }

  /* ═════════ [2] 手工覆盖：覆盖永远赢过识别 ═════════ */
  console.log("\n[2] 手工覆盖（config.modelKinds）优先于自动识别");
  {
    const cfg = { modelKinds: { pv1: { "new-model": "image" } } };
    EQ(MK.modelKindOf(cfg, "pv1", "new-model"), "image", "识别不出的新模型可手工指定为图像");
    EQ(MK.modelKindOverride(cfg, "pv1", "new-model"), "image", "读取覆盖值");
    EQ(MK.modelKindOverride(cfg, "pv2", "new-model"), "", "别的服务商的覆盖互不串台");
    EQ(MK.modelKindOf(cfg, "pv2", "new-model"), "text", "未覆盖处仍走自动识别");
    const bad = { modelKinds: { pv1: { x: "video" } } };
    EQ(MK.modelKindOverride(bad, "pv1", "x"), "", "非法覆盖值一律忽略（回落识别）");
    EQ(MK.modelKindOf(bad, "pv1", "x"), "text", "非法覆盖不改变结论");
    EQ(MK.modelKindOf(null, "pv1", "gpt-image-2-vip"), "image", "无配置对象也不抛（空配置可跑）");
  }

  /* ═════════ [3] 服务商形态：同一端点混挂两类模型 ═════════ */
  console.log("\n[3] 服务商形态：配成 text_openai 但含图像模型 → 文本 + 图像双形态");
  {
    const cfg = {};
    const mixed = {
      id: "pmthfnbl9to6",
      name: "API易",
      type: "text_openai",
      models: ["qwen3.7-plus", "gpt-image-2-vip"],
    };
    EQ(MK.providerKinds(cfg, mixed).join("+"), "text+image", "混合端点算两种形态（这就是从前选不到图像模型的那家）");
    EQ(MK.providerHasKind(cfg, mixed, "text"), true, "含文本模型 → 文本节点可选");
    EQ(MK.providerHasKind(cfg, mixed, "image"), true, "含图像模型 → 图像节点也可选");
    EQ(MK.modelsOfKind(cfg, mixed, "text").join(","), "qwen3.7-plus", "文本模型下拉只列文本模型");
    EQ(MK.modelsOfKind(cfg, mixed, "image").join(","), "gpt-image-2-vip", "图像模型下拉只列图像模型");

    const pureText = { id: "deepseek", type: "text_openai", models: ["deepseek-flash", "deepseek-v4-pro"] };
    EQ(MK.providerKinds(cfg, pureText).join("+"), "text", "纯文本服务商只有文本形态");
    EQ(MK.providerHasKind(cfg, pureText, "image"), false, "纯文本服务商不出现在图像节点");

    const pureImg = { id: "gpt_image_2", type: "image_openai", models: ["gpt-image-2-vip", "seedream-5-0-pro-260628"] };
    EQ(MK.providerKinds(cfg, pureImg).join("+"), "image", "显式 image_* 类型 = 图像形态");
    EQ(MK.providerHasKind(cfg, pureImg, "text"), false, "图像服务商不出现在文本节点");

    /* 目录提示（视觉输入）与服务商形态无关，只是补充判据 */
    const catalog = {
      deepseek: [{ id: "deepseek-flash", input: ["text", "image"] }],
      piai: [{ id: "x", models: [{ id: "vision-model", input: ["text", "image"] }] }],
    };
    EQ(MK.catalogModelAcceptsImage(catalog, "deepseek-flash"), true, "目录 input 含 image = 能吃图");
    EQ(MK.catalogModelAcceptsImage(catalog, "vision-model"), true, "pi-ai 目录同样判");
    EQ(MK.catalogModelAcceptsImage(catalog, "deepseek-v4-pro"), false, "目录里没标 image 的不算");
  }

  /* ═════════ [4] 类型纠偏：按**本次要用的那个模型** ═════════ */
  console.log("\n[4] 类型纠偏：所选模型的形态与服务商类型不符时给出应有的类型");
  {
    const cfg = {};
    const p = { id: "px", type: "text_openai", models: ["gpt-image-2-vip", "qwen3.7-plus"] };
    EQ(MK.correctedTypeForModel(cfg, p, "gpt-image-2-vip"), "image_openai", "选中图像模型 + 文本类型 → 纠为 image_openai");
    EQ(MK.correctedTypeForModel(cfg, p, "qwen3.7-plus"), "", "选中文本模型且类型已是文本 → 不动");
    EQ(MK.correctedTypeForModel(cfg, p, ""), "", "没有模型 → 不动");
    const p2 = { id: "py", type: "image_openai", models: ["gpt-image-2-vip"] };
    EQ(MK.correctedTypeForModel(cfg, p2, "gpt-image-2-vip"), "", "类型本来就对 → 不动");
    const p3 = { id: "pz", type: "image_stability", models: ["core", "sd3.5"] };
    EQ(MK.correctedTypeForModel(cfg, p3, "sd3.5"), "", "Stability 专用端点保持原类型（不改成 image_openai）");
    const p4 = { id: "pw", type: "image_stability", models: ["gpt-4o"] };
    EQ(MK.correctedTypeForModel(cfg, p4, "gpt-4o"), "text_openai", "图像专用端点上选了文本模型 → 纠回 text_openai");
    EQ(MK.providerTypeForKind("image_mj", "image"), "image_mj", "Midjourney 保持自身类型");
    EQ(MK.providerTypeForKind("text_openai", "image"), "image_openai", "文本类型 + 图像形态 = OpenAI 兼容图像接口");
    EQ(MK.providerTypeForKind(undefined, "text"), "text_openai", "缺类型按文本兜底");
    EQ(MK.modelKindForNode({ kind: "proc_image" }), "image", "proc_image 要图像模型");
    EQ(MK.modelKindForNode({ kind: "proc_text" }), "text", "proc_text 要文本模型");

    /* 本次请求的副本：纠偏只落在副本上，**绝不回写用户配置** ——
       「用着用着模型突然不见了」的回归口径（回写 type 会让同一端点的另一类模型
       从会话 / 节点的模型选择器里一起消失，要用户去设置刷新才回来）。 */
    const reqImg = MK.providerForRequest(cfg, p, "gpt-image-2-vip");
    EQ(reqImg.type, "image_openai", "选中图像模型 → 本次请求按图像接口族发");
    EQ(p.type, "text_openai", "原服务商对象一字不动（配置不被运行期改写）");
    ok(reqImg !== p, "纠偏时给的是副本（不是同一个引用）");
    const reqTxt = MK.providerForRequest(cfg, p, "qwen3.7-plus");
    ok(reqTxt === p, "形态一致 → 原样返回同一个对象（不多造对象）");
    EQ(MK.providerForRequest(cfg, null, "x"), null, "没有服务商时原样返回（不抛）");
    const relayCard = { id: "mtnode-relay", type: "text_openai", source: "mtnode-relay", models: ["deepseek-flash", "gpt-image-2.5-vip"] };
    const relayReq = MK.providerForRequest({ modelKinds: { "mtnode-relay": { "gpt-image-2.5-vip": "image" } } }, relayCard, "gpt-image-2.5-vip");
    EQ(relayReq.type, "image_openai", "中转卡跑图像模型：本次请求按图像端点发");
    EQ(relayCard.type, "text_openai", "中转卡（云端口径）类型保持 text_openai —— 文本模型不消失");
  }

  /* ═════════ [5] 全渲染层同源接入点 ═════════ */
  console.log("\n[5] 接入点：设置页 / 节点设置 / 体检 / 运行期都走同一份判定");
  {
    const SETTINGS = read("renderer/app-settings.js");
    const CANVAS = read("renderer/app-canvas.js");
    const APPJS = read("renderer/app.js");
    const NODES = read("renderer/app-nodes.js");
    const HTML = read("renderer/index.html");
    const CSS = read("renderer/css/components.css");

    HAS(HTML, 'src="app-model-kind.js"', "index.html 接入 app-model-kind.js");
    const iKind = HTML.indexOf('src="app-model-kind.js"');
    const iApp = HTML.indexOf('src="app.js"');
    ok(iKind > iApp, "app-model-kind.js 排在 app.js 之后（同层调用期取用）");

    HAS(SETTINGS, "modelKindOf(S.config", "设置页模型行用 modelKindOf 取形态");
    HAS(SETTINGS, "modelKindOverride(S.config", "设置页区分「手工指定 / 自动识别」");
    HAS(SETTINGS, "S.config.modelKinds", "徽标点击写进 config.modelKinds");
    HAS(SETTINGS, "自动识别模型类型", "模型列表有「自动识别模型类型」按钮（清覆盖、回自动）");
    HAS(SETTINGS, "按模型纠正类型", "服务商卡片有「按模型纠正类型」按钮");
    HAS(SETTINGS, "providerKinds(S.config, prov)", "服务商卡片显示形态（文本 / 图像 / 混合）");
    HAS(SETTINGS, "defaultKindOfProvider", "手动添加服务商时按模型识别类型");
    HAS(SETTINGS, "inferModelKind", "添加服务商（目录 / 手动）按模型形态判定");

    HAS(fnBody(CANVAS, "nsProviderModelFields"), "providerHasKind", "节点设置按形态分流服务商");
    HAS(fnBody(CANVAS, "nsProviderModelFields"), "modelsOfKind", "节点设置模型下拉只列该形态模型");
    HAS(CANVAS, "（形态不符）", "节点里存着反形态模型时标注原因（不静默改值）");

    HAS(APPJS, "function apiProvidersForKind(kind)", "app.js 有 apiProvidersForKind 统一入口");
    const apiP = fnBody(APPJS, "apiProvidersForKind");
    HAS(apiP, "providerHasKind(S.config, p, want)", "apiProvidersForKind 走形态判定（不再只看 type）");
    HAS(fnBody(APPJS, "apiProviderValid"), "providerHasKind", "apiProviderValid 走形态判定");
    HAS(fnBody(APPJS, "nodeModelGate"), "modelsOfKind(S.config, p,", "无模型判据按形态取该服务商的模型表");
    HAS(fnBody(APPJS, "assignDefaultProvider"), "modelsOfKind(S.config, prov, \"image\")", "新图像节点默认模型取该形态的第一个");

    HAS(NODES, "providerForRequest", "运行期按所选模型纠服务商类型（只改本次请求的副本）");
    ok(
      NODES.indexOf("prov.type = ") < 0 && NODES.indexOf("providerForRequest(S.config") >= 0,
      "运行期绝不回写服务商 type（回写会让同一端点的另一类模型从选择器里消失）",
    );
    HAS(NODES, "providerHasKind(S.config, p, \"text\")", "识图候选只从含文本模型的服务商里挑");

    const MAIN = read("main.js");
    ok(
      MAIN.indexOf("function effectiveProviderType") >= 0 &&
        MAIN.indexOf("const reqType = effectiveProviderType(provider, kind)") >= 0,
      "主进程按接口族分派图像请求（text_openai 的混合端点不再抛「未知服务商类型」）",
    );
    ok(
      MAIN.indexOf('if (provider.type === "image_openai")') < 0 &&
        MAIN.indexOf('if (reqType === "image_openai")') >= 0,
      "图像分派不再直接看服务商级 type（改看 reqType）",
    );
    HAS(read("renderer/app-relay.js"), "function healType()", "中转卡类型被改坏时自动纠回 text_openai（不用手动刷新）");
    HAS(read("renderer/app-relay.js"), "var heal = healType();", "打开设置 / 登录态刷新时就地自愈（不打扰服务端）");
    ok(
      (NODES.match(/ensureMaskPrereqs\(node, spec\.provider \|\| prov/g) || []).length >= 2,
      "蒙版前置校验按本次请求的服务商判（混挂端点配成 text_openai 也照样能开蒙版）",
    );

    HAS(CSS, ".pk-badge", "模型形态徽标有专属样式");
    HAS(CSS, ".pf-kind", "服务商形态行有样式");

    const I18N = read("renderer/i18n.js");
    for (const s of [
      "自动识别模型类型",
      "按模型纠正类型",
      "图像模型",
      "文本模型",
      "（形态不符）",
    ])
      HAS(I18N, s, "i18n 收词条：" + s);
  }

  /* ═════════ [6] 纯函数段：不依赖 DOM / 全局 S ═════════ */
  console.log("\n[6] app-model-kind.js 是纯函数段（可单独 require）");
  {
    const src = read("renderer/app-model-kind.js");
    ok(src.indexOf("document.") < 0, "不碰 DOM（document 一个都没有）");
    ok(src.indexOf("window.") < 0, "不依赖 window");
    ok(
      !/^var S\s*=|^let S\s*=|^const S\s*=/m.test(src),
      "不声明全局 S（配置一律按参数传入）",
    );
    ok(!!MK.providerKinds && typeof MK.providerKinds === "function", "CommonJS 导出可用（测试与工具可直接 require）");
  }

  console.log(
    (fails ? "\nFAILED " + fails + " / " + checks + " checks" : "\nALL OK  " + checks + " checks") + "\n",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-model-kind.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-model-kind.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

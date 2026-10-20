"use strict";
/* ============================================================================
 * test/smoke-agent-compact-menu.js — 会话「⚙ 模型」菜单里的「上下文压缩」一格
 *
 *   node test/smoke-agent-compact-menu.js            断言模式（绿 = 退出码 0）
 *
 * 为什么要有它：右侧助手栏有「上下文压缩」下拉（#assistCompactSel），而用户日常开着的是
 * **会话窗口** —— 会话侧此前没有这个入口，压缩档只能跑去设置里改。本轮在会话「⚙ 模型」
 * 菜单里补了同一格，它必须是**同一份值**：真源 config.dsh.compact（main.js 的
 * syncCompactPolicy 把它写进 dsh 组合的 compaction-basic 行），写回必须走助手栏那条链
 * （applyAssistCompactChoice → persistAssistUi）。别人另存一份（S.agentCompact / 会话级
 * 字段）就会造成「设置面板显示中档、组合里是早档」这种看不见的错配。
 *
 * 做法：从 renderer/app-assist.js 抠出**真正在跑**的函数（改名 / 删了即变红）——
 * buildAgentModelMenu 那一族 + 本轮新增的 compact 三件套（ASSIST_COMPACT_OPTIONS 常量、
 * compactPolicyOf、assistCompactOptionLabel / agentCompactMenuValue / applyAssistCompactChoice）
 * —— 配一个够用的假 DOM（只认菜单用到的 span 嵌套 + textContent）真跑两页：
 *   · 根页：第 5 格 = 「上下文压缩」，回显 = 当前档（关闭 / 早 / 中 / 晚，非法档回落中档）；
 *   · compact 页：四档清单与助手栏同源、当前档打 ✓、返回键回根页；
 *   · 选一下：写 S.config.dsh.compact + persistAssistUi 落盘一次 + 提示「下一个新会话生效」
 *     （提示语不点名「助手栏」—— 从会话改完不该收到错话）；
 *   · chip tooltip：index.html 与 renderAgentComposer 的 dataset 都说到这一格（切语言不掉字）。
 * ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "renderer", "app-assist.js"), "utf8");
const IDX = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");
/* 档位清单 / 归一 / 词条住在 renderer/app-dsh-compact.js（设置面板与助手栏共用的小单元）：
   真实 index.html 里它排在 app-assist.js 之前，这里也一起抠出来注入。 */
const SHARED = fs.readFileSync(path.join(ROOT, "renderer", "app-dsh-compact.js"), "utf8");

let checks = 0;
let fails = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const eq = (got, want, msg) =>
  ok(got === want, msg + "（得到 " + JSON.stringify(got) + "，期望 " + JSON.stringify(want) + "）");

/* ---------- 从产品源码抠构件（抠不到就抛错让 smoke 变红，逼着两边同步） ---------- */
function sliceBraces(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i++;
        else if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("括号未配平（锚点附近改动过大？）");
}
function grabFn(name, src) {
  const hay = src || SRC;
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(hay);
  if (!m) throw new Error("找不到函数 " + name + "（改名了？／搬去别的加载单元了？）");
  const open = hay.indexOf("{", hay.indexOf(")", m.index));
  return hay.slice(m.index, open + sliceBraces(hay, open).length);
}
function grabOptionsConst() {
  const start = SHARED.indexOf("const ASSIST_COMPACT_OPTIONS = [");
  if (start < 0) throw new Error("renderer/app-dsh-compact.js 里找不到 ASSIST_COMPACT_OPTIONS");
  const end = SHARED.indexOf("];", start);
  if (end < 0) throw new Error("ASSIST_COMPACT_OPTIONS 的收尾 ] 没找到");
  return SHARED.slice(start, end + 2);
}
/* 数值常量（自定义触发线的边界 / 固定档清单）：抠原文，不自己编值 */
function grabConstFromAssist(name) {
  const m = new RegExp("^const " + name + "\\s*=\\s*([^;\\n]+);", "m").exec(SHARED);
  if (!m) throw new Error("renderer/app-dsh-compact.js 里找不到常量 " + name);
  return "const " + name + " = " + m[1] + ";";
}
/* 跨行对象常量（COMPACT_TIER_SIZE_DEFAULTS）：按花括号配对抠原文 */
function grabObjectConstFromShared(name) {
  const at = SHARED.indexOf("const " + name + " = {");
  if (at < 0) throw new Error("renderer/app-dsh-compact.js 里找不到常量 " + name);
  let i = SHARED.indexOf("{", at);
  let depth = 0;
  for (; i < SHARED.length; i++) {
    if (SHARED[i] === "{") depth++;
    else if (SHARED[i] === "}") {
      depth--;
      if (depth === 0) return SHARED.slice(at, i + 1) + ";";
    }
  }
  throw new Error("常量 " + name + " 的花括号不配对");
}
/* 菜单那一族：closeAgentMenus → 技能菜单注释之前（与 smoke-model 同一处切法） */
function sliceMenuSrc() {
  const a = SRC.indexOf("function closeAgentMenus() {");
  const b = SRC.indexOf("/* ── 技能 chip：三级分类菜单", a);
  if (a < 0 || b < 0) throw new Error("切不出菜单函数族（closeAgentMenus / 技能菜单锚点变了？）");
  return SRC.slice(a, b);
}

/* ---------- 够用的假 DOM（只认菜单用到的那几种：span 嵌套 + textContent） ---------- */
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
    get: () => (el.children.length ? el.children.map((c) => c.textContent).join("") : el._text),
    set(v) {
      el._text = v == null ? "" : String(v);
      el.children.length = 0;
    },
  });
  return el;
}
const hasClass = (el, cls) => String((el && el.className) || "").split(/\s+/).indexOf(cls) >= 0;
const byClass = (el, cls) => ((el && el.children) || []).filter((c) => hasClass(c, cls));
const optName = (o) => {
  const n = o && o.querySelector && o.querySelector(".agent-menu-option-name");
  return n ? n.textContent : "";
};
const cellLabel = (c) => {
  const l = c && c.querySelector && c.querySelector(".agent-menu-cell-label");
  return l ? l.textContent : "";
};
const cellValue = (c) => {
  const v = c && c.querySelector && c.querySelector(".agent-menu-cell-value");
  return v ? v.textContent : "";
};
const checkOf = (o) => {
  const c = o && o.querySelector && o.querySelector(".agent-menu-check");
  return c ? c.textContent : "";
};

/* ---------- 沙箱：抠出来的菜单族 + compact 三件套（都是真源，不是抄一份） ---------- */
const MENU_SRC = sliceMenuSrc();
/* 词条表：用真 i18n 表解析（档位文案的中英两版都在这里验），不在沙箱里编造译文 */
const I18nReal = require(path.join(ROOT, "renderer", "i18n.js"));
function mkSandbox(cfg) {
  const menu = mkEl("div");
  const st = {
    provider: "deepseek-official",
    model: "deepseek-flash",
    preset: "minimal",
    effort: "high",
  };
  const state = { config: cfg || { dsh: {} }, toasts: [], saved: 0, rendered: 0 };
  const sandbox = {
    document: {
      createElement: mkEl,
      getElementById: (id) => (id === "agentModelMenu" ? menu : null),
    },
    I18n: { t: (k) => I18nReal.t(k) },
    console,
    S: state,
    toast: (...a) => state.toasts.push(String(a[0] || "")),
    persistAssistUi: () => {
      state.saved++;
    },
    agentSessionState: () => st,
    persistAgentSession: () => {},
    agentTouchSession: () => {},
    agentFlushSessionSaveQuiet: () => {},
    renderAgentSession: () => {
      state.rendered++;
    },
    renderAgentSessionSidebar: () => {},
    preferredAgentProviderRoute: () => "deepseek-official",
    agentPresetById: (id) => ({ id: id || "minimal", labelKey: "极简模式" }),
    agentPresetLabel: () => "极简模式",
    agentEffortDisplayLabel: () => "标准",
    normalizeAgentEffort: (v) => String(v || "high"),
    AGENT_EFFORT_UI_ORDER: ["off", "low", "high", "xhigh", "max"],
    agentEffortLabelOf: (v) => String(v),
    AGENT_PRESETS: [{ id: "minimal", labelKey: "极简模式" }],
    agentRouteGroupsNow: () => [],
    /* 根页与 compact 页都不该碰供应商清单：真碰了就让测试炸出来（而不是静默取空） */
    agentProviderGroupsNow: () => {
      throw new Error("根页 / compact 页不该取供应商清单（那是 provider 页的事）");
    },
    mtnodePiProviders: () => [],
    dshProvider: () => ({ name: "DeepSeek 官方", models: ["deepseek-flash"] }),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    grabOptionsConst() +
      "\n" +
      grabConstFromAssist("COMPACT_CUSTOM_MIN") +
      "\n" +
      grabConstFromAssist("COMPACT_CUSTOM_MAX") +
      "\n" +
      grabConstFromAssist("COMPACT_FIXED_TIERS") +
      "\n" +
      grabObjectConstFromShared("COMPACT_TIER_SIZE_DEFAULTS") +
      "\n" +
      grabConstFromAssist("COMPACT_RETAIN_MIN") +
      "\n" +
      grabConstFromAssist("COMPACT_RETAIN_MAX") +
      "\n" +
      grabConstFromAssist("COMPACT_SUMMARY_MIN") +
      "\n" +
      grabConstFromAssist("COMPACT_SUMMARY_MAX") +
      "\n" +
      grabFn("compactPolicyOf", SHARED) +
      "\n" +
      grabFn("compactLimitOf", SHARED) +
      "\n" +
      grabFn("compactTierSizeDefault", SHARED) +
      "\n" +
      grabFn("compactRetainEffectiveOf", SHARED) +
      "\n" +
      grabFn("compactSummaryEffectiveOf", SHARED) +
      "\n" +
      grabFn("assistCompactOptionLabel", SHARED) +
      "\n" +
      grabFn("compactCustomSuffix", SHARED) +
      "\n" +
      grabFn("syncCompactSideControls") +
      "\n" +
      grabFn("syncCompactCustomInput") +
      "\n" +
      grabFn("syncCompactLimitInputs") +
      "\n" +
      grabFn("agentCompactMenuValue") +
      "\n" +
      grabFn("applyAssistCompactChoice") +
      "\n" +
      grabFn("applyAssistCompactTrigger") +
      "\n" +
      grabFn("applyAssistCompactLimit") +
      "\n" +
      "function closeAgentMenus(){}\n" +
      MENU_SRC +
      "\nthis.buildAgentModelMenu = buildAgentModelMenu;",
    sandbox,
    { filename: "renderer/app-assist.js#menu" },
  );
  sandbox.__menu = menu;
  sandbox.__state = state;
  sandbox.__st = st;
  return sandbox;
}
/* 档位文案 = 「档位名 · 上下文阈值」两截（界面不冗余），与 renderer/app-dsh-compact.js 的
   ASSIST_COMPACT_OPTIONS 逐字一致；「自定义」档名不带数，量级标注由 compactCustomSuffix 拼 */
const LABELS = {
  off: "关闭",
  frugal: "省钱 · 100k",
  mid: "中 · 300k",
  late: "晚 · 450k",
  custom: "自定义",
};

async function main() {
  /* 本用例要读真词条（中文界面），先把语言钉回 zh —— 其它 smoke 可能把它切到 en */
  I18nReal.setLocale("zh");

  console.log("\n[1] 会话「⚙ 模型」菜单根页：思考强度下一格就是「上下文压缩」");
  {
    const sb = mkSandbox({ dsh: { compact: { enabled: true, tier: "mid" } } });
    sb.buildAgentModelMenu();
    const cells = byClass(sb.__menu, "agent-menu-cell");
    eq(cells.length, 5, "根页 5 格（模型提供商 / 预设 / 模型 / 思考强度 / 上下文压缩）");
    eq(
      cells.map(cellLabel).join(","),
      "模型提供商,预设,模型,思考强度,上下文压缩",
      "「上下文压缩」紧接在「思考强度」之后（与会话里其它选型格同一处，不再只藏在设置里）",
    );
    eq(cellValue(cells[4]), LABELS.mid, "缺省档回显「中」（缺省 = 开 · 中档，与组合里的 0.3 / 32768 对得上）");
    const sbOff = mkSandbox({ dsh: { compact: { enabled: false, tier: "late" } } });
    sbOff.buildAgentModelMenu();
    eq(
      cellValue(byClass(sbOff.__menu, "agent-menu-cell")[4]),
      LABELS.off,
      "enabled:false 回显「关闭」（不按保留的 tier 显示，用户看到的就是关掉了）",
    );
    const sbBad = mkSandbox({ dsh: { compact: { tier: "nonsense" } } });
    sbBad.buildAgentModelMenu();
    eq(cellValue(byClass(sbBad.__menu, "agent-menu-cell")[4]), LABELS.mid, "非法档回落「中」（脏值不会写进组合）");
  }

  console.log("\n[2] compact 页：五档清单与助手栏同源、当前档打 ✓、返回键回根页 + 自定义一行");
  {
    const sb = mkSandbox({ dsh: { compact: { enabled: true, tier: "frugal" } } });
    sb.__menu.dataset.pane = "compact";
    sb.buildAgentModelMenu();
    /* 档位行 = 五个（自定义那一行是 label，也带 .agent-menu-option 类；按「有 ✓ 的按钮」区分） */
    const opts = byClass(sb.__menu, "agent-menu-option").filter((o) => o.tagName === "BUTTON" || o.onclick);
    eq(opts.length, 5, "五档（关闭 / 省钱 / 中 / 晚 / 自定义）");
    eq(
      opts.slice(0, 4).map(optName).join("|"),
      [LABELS.off, LABELS.frugal, LABELS.mid, LABELS.late].join("|"),
      "前四档的文案 = 助手栏那一份 ASSIST_COMPACT_OPTIONS（三处入口同一个真源）",
    );
    ok(optName(opts[4]).indexOf(LABELS.custom) === 0,
      "第五档 = 自定义（文案前缀与助手栏那份一致；末尾的量级标注单独断言）");
    const checked = opts.filter((o) => checkOf(o) === "✓");
    eq(checked.length, 1, "只给当前这一档打 ✓");
    eq(optName(checked[0]), LABELS.frugal, "✓ 打在 config.dsh.compact.tier = frugal 那一档上");
    /* 自定义那一档的回显带量级标注 */
    eq(optName(opts[4]), LABELS.custom + " · 100K",
      "自定义那一档的回显带当前触发线（100K = config 里的缺省值）");
    const bk = byClass(sb.__menu, "agent-menu-back")[0];
    ok(!!bk, "compact 页有返回根页的「←」");
    eq(bk && bk.textContent, "← 上下文压缩", "返回键文案 = 「← 上下文压缩」（不落进「思考强度」那一支）");
    let threw = null;
    try {
      bk.onclick();
    } catch (e) {
      threw = e;
    }
    ok(!threw && sb.__menu.dataset.pane === "root", "点返回回根页（空态路径不抛错）");
    const sbOff = mkSandbox({ dsh: { compact: { enabled: false, tier: "mid" } } });
    sbOff.__menu.dataset.pane = "compact";
    sbOff.buildAgentModelMenu();
    const checkedOff = byClass(sbOff.__menu, "agent-menu-option").filter((o) => checkOf(o) === "✓");
    eq(checkedOff.length, 1, "关掉时仍且仅有一个 ✓");
    eq(optName(checkedOff[0]), LABELS.off, "关掉时 ✓ 落在「关闭」那一档");
  }

  console.log("\n[3] 选一下 = 走与助手栏同一条写回链（config.dsh.compact + 落盘 + 提示）");
  {
    const sb = mkSandbox({ dsh: { compact: { enabled: true, tier: "mid" } } });
    sb.__menu.dataset.pane = "compact";
    sb.buildAgentModelMenu();
    const late = byClass(sb.__menu, "agent-menu-option").filter((o) => optName(o) === LABELS.late)[0];
    ok(!!late, "五档里的「晚」那一项在");
    late.onclick();
    const c = sb.__state.config.dsh.compact;
    ok(
      c && c.enabled === true && c.tier === "late",
      "选「晚」→ config.dsh.compact = {enabled:true,tier:'late',customTriggerTokens:…}（与设置面板 / 助手栏同一份值，实测 " +
        JSON.stringify(c) +
        "）",
    );
    eq(c && c.customTriggerTokens, 100000, "切档位保留自定义触发线（不放成 undefined）");
    eq(sb.__state.saved, 1, "走 persistAssistUi → configSave 落盘一次（不是只改内存）");
    ok(
      sb.__state.toasts.length === 1 && /下一个新会话生效/.test(sb.__state.toasts[0]),
      "提示语仍是「下一个新会话生效」：" + sb.__state.toasts[0],
    );
    ok(!/助手栏/.test(sb.__state.toasts[0]), "提示语不点名「助手栏」（从会话改完不会收到一句错话）");
    eq(sb.__state.rendered, 1, "选完重画一次会话（菜单随即关掉，值当场回显）");
    const off = byClass(sb.__menu, "agent-menu-option").filter((o) => optName(o) === LABELS.off)[0];
    off.onclick();
    const c2 = sb.__state.config.dsh.compact;
    ok(
      c2 && c2.enabled === false && c2.tier === "late",
      "再选「关闭」→ enabled:false 且保留原档 late（再打开回到原档，实测 " + JSON.stringify(c2) + "）",
    );
    eq(sb.__state.saved, 2, "第二次也落了盘");
    ok(/上下文压缩已关闭/.test(sb.__state.toasts[1]), "关闭的提示语单独一条：" + sb.__state.toasts[1]);
  }

  console.log("\n[3b] 自定义档：菜单里那一行输入框是真入口（合法写回 / 越界拒绝）");
  {
    const sb = mkSandbox({ dsh: { compact: { enabled: true, tier: "custom", customTriggerTokens: 250000 } } });
    sb.__menu.dataset.pane = "compact";
    sb.buildAgentModelMenu();
    const rows = byClass(sb.__menu, "agent-menu-option");
    const customRow = rows.filter((o) => hasClass(o, "agent-menu-input-row"))[0];
    ok(!!customRow, "自定义那一行在（label + 数字框，三处入口一致）");
    ok(!!customRow && hasClass(customRow, "agent-menu-input-row"),
      "那一行带 agent-menu-input-row 类（CSS 靠它去掉手型与 hover 底色）");
    const tin = customRow && customRow.children.filter((c) => c.tagName === "INPUT")[0];
    ok(!!tin, "行里真的有一个 input（不是只画个标签）");
    eq(tin && tin.value, "250000", "输入框回填当前触发线（250k）");
    eq(customRow && customRow.hidden, false, "选了自定义档 → 那一行露出");
    eq(optName(customRow), "自定义触发线",
      "自定义那一行自己的标签 = 「自定义触发线」（它是一行参数，不参与档位 ✓ 竞争）");
    tin.onchange();
    eq(sb.__state.saved, 1, "在框里改数 → 走同一条落盘链");
    eq(sb.__state.config.dsh.compact.customTriggerTokens, 250000, "值没变（未改内容时原样写回）");
    tin.value = "9000";
    tin.onchange();
    eq(sb.__state.config.dsh.compact.customTriggerTokens, 250000, "越界（9000）被拒绝：配置里仍是上一个合法值");
    eq(tin.value, "250000", "越界后输入框回填成当前生效值（界面不留脏数）");
    ok(sb.__state.toasts.some((t) => /自定义触发线要填/.test(t)), "越界有明确提示：" + JSON.stringify(sb.__state.toasts));
    const sbMid = mkSandbox({ dsh: { compact: { enabled: true, tier: "mid" } } });
    sbMid.__menu.dataset.pane = "compact";
    sbMid.buildAgentModelMenu();
    const midRow = byClass(sbMid.__menu, "agent-menu-option").filter((o) => hasClass(o, "agent-menu-input-row"))[0];
    eq(midRow && midRow.hidden, true, "中档时那一行收起（只有选了自定义才露出）");
    /* 本次共识：保留原文 / 摘要上限也只在「开着 + 自定义」档露出（与触发线同一组） */
    const inputRowsOf = (sbx) =>
      byClass(sbx.__menu, "agent-menu-option").filter((o) => hasClass(o, "agent-menu-input-row"));
    const midRows = inputRowsOf(sbMid);
    eq(midRows.length, 3, "中档：自定义那一组三行都在 DOM 里（触发线 + 保留原文 + 摘要上限，顺序固定）");
    eq(midRows.slice(1).map(optName).join(","), "保留原文,摘要上限", "后两行的标签 = 保留原文 / 摘要上限");
    ok(midRows.slice(1).every((r) => r.hidden === true),
      "中档：保留原文 / 摘要上限两行都收起（非自定义档不出现数字填写）");
    ok(midRows.slice(1).every((r) => {
      const i = r.children.filter((c) => c.tagName === "INPUT")[0];
      return !!i && i.disabled === true;
    }), "中档：两个框还置了 disabled（收起后不留键盘入口）");
    const customRows = inputRowsOf(sb);
    ok(customRows.length === 3 && customRows.slice(1).every((r) => r.hidden === false),
      "自定义档：保留原文 / 摘要上限两行一起露出（与触发线同一组）");
    ok(customRows.slice(1).every((r) => {
      const i = r.children.filter((c) => c.tagName === "INPUT")[0];
      return !!i && i.disabled === false;
    }), "自定义档：两个框可编辑");
    const offSb = mkSandbox({ dsh: { compact: { enabled: false, tier: "custom" } } });
    offSb.__menu.dataset.pane = "compact";
    offSb.buildAgentModelMenu();
    ok(inputRowsOf(offSb).every((r) => r.hidden === true),
      "关闭档（即使记住的档位是自定义）：整组数字都不露出（判据 = 开着 + 自定义）");
  }

  console.log("\n[4] 会话 chip 的 tooltip 也说到了这一格（切语言不掉字）");
  {
    ok(
      /id="agentModelTrigger"[^>]*data-i18n-title="模型提供商 \/ 预设 \/ 模型 \/ 思考强度 \/ 上下文压缩"/.test(IDX),
      "index.html 的 ⚙ chip tooltip 含「上下文压缩」",
    );
    ok(
      SRC.indexOf('mt.dataset.i18nTitle = "模型提供商 / 预设 / 模型 / 思考强度 / 上下文压缩";') >= 0,
      "renderAgentComposer 里那份 dataset 同步改了（切语言按 dataset 重放 tooltip）",
    );
    I18nReal.setLocale("en");
    const en = I18nReal.t("模型提供商 / 预设 / 模型 / 思考强度 / 上下文压缩");
    ok(
      en !== "模型提供商 / 预设 / 模型 / 思考强度 / 上下文压缩" && /compaction/i.test(en),
      "英文界面 tooltip 有对应词条（不回落中文）：" + en,
    );
    I18nReal.setLocale("zh");
    ok(
      I18N.indexOf('"模型提供商 / 预设 / 模型 / 思考强度 / 上下文压缩":') >= 0,
      "i18n 源文件里有这条中英词条",
    );
  }

  const bad = fails;
  console.log(
    "\n" + (bad ? "✗ " + bad + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-agent-compact-menu)",
  );
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke-agent-compact-menu 运行异常：" + ((e && e.stack) || e));
  process.exit(1);
});

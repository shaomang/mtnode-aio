"use strict";
/* 一人公司 / 专家团 —— 按运行的工具许可（runKey 作用域） —— 冒烟测试（纯 Node，无 DOM）
 *   node test/smoke-team-perms.js
 * 需求：专家自带 perm.toolAllow 只在这一轮生效（S._runToolPolicy[runKey]），runKey 之间互不串味，
 *       没装策略一律回退全局「Agent 工具许可」预设 —— 现有审批面板 / 助手 / 老会话行为逐字不变。
 * 覆盖：
 *   [1] 抠出 app-nodes.js 的真实权限函数（agentToolMode / agentDeniedToolNames / setRunToolPolicy …）
 *   [2] 全局预设：无 runKey 时按全局预设解析（含显式 deny）
 *   [3] runKey 作用域优先：本轮策略覆盖全局（显式 allow 也能翻回来）
 *   [4] runKey 隔离 + 缺省回退：别的 runKey / 清空策略 → 回全局
 *   [5] 专家默认策略：读 / 写文件、联网、反问与读画布放行；命令、画布改动、应用操作询问；
 *       删除画布 / 插件 / 子代理 / 目标 / 作业 / 识图禁止；画布六类全拒才整档摘掉画布三件套
 *   [6] 拒权文案与接线：本轮策略提示「团队面板」，app-db 安装策略并透传 runKey
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* ═══════════ 沙箱：app-team.js（专家默认许可）+ app-nodes.js 权限函数切片 ═══════════ */
const nodesSrc = read("renderer/app-nodes.js");
const start = nodesSrc.indexOf("function permissionPresetOptions()");
const end = nodesSrc.indexOf("async function ensureAgentTool(");
if (start < 0 || end <= start) {
  console.error("FAIL  找不到 app-nodes.js 权限函数区段");
}
const REGION = nodesSrc.slice(start, end);

const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.I18n = { t: (s) => String(s) };
sandbox.api = { configSave: () => Promise.resolve() };
sandbox.AGENT_PRESETS = ["minimal", "standard", "lean", "code", "cordis"].map((id) => ({ id }));
sandbox.AGENT_PRESET_DEFAULT = "minimal";
sandbox.AGENT_PRESET_LEGACY_IDS = {};
sandbox.normalizeAgentEffort = (v) => String(v == null ? "" : v).trim() || "high";
sandbox.toast = () => {};
sandbox.paintApprovalsBtn = () => {};
const S = { config: {} };
sandbox.S = S;
vm.createContext(sandbox);
vm.runInContext(read("renderer/app-team.js"), sandbox, { filename: "app-team.js" });
vm.runInContext(
  REGION +
    "\nthis.__api = { agentToolMode, agentToolAllowed, agentDeniedToolNames, setRunToolPolicy, clearRunToolPolicy, runToolPolicyOf, agentToolCatalog, defaultToolAllow, normalizeToolAllowMap, agentToolDeniedError, assertAgentTool };",
  sandbox,
  { filename: "app-nodes-perms-extract.js" },
);

const A = sandbox.__api;
const T = sandbox.MTNodeTeam;
ok(!!A && typeof A.agentToolMode === "function", "app-nodes.js 权限函数切片加载成功");
ok(!!T && typeof T.defaultToolAllow === "function", "app-team.js 专家默认许可可用");

/* 全局预设装配：让 defaultToolAllow（全 allow）先跑一遍，再按需改键。 */
const globalAllow = A.defaultToolAllow();
A.agentToolCatalog(); /* 触发 ensureAgentToolPresets 建立 S.config.dsh */

/* ===================== [1] 全局预设（无 runKey） ===================== */
console.log("\n[1] 全局预设：无 runKey 时按全局解析");
ok(A.agentToolMode("canvas_read") === "allow", "缺省全局 = allow（审批面板行为不变）");
S.config.dsh.agentToolPresets[0].allow.canvas_read = "deny";
ok(A.agentToolMode("canvas_read") === "deny", "全局预设显式 deny 生效");
ok(A.agentToolMode("fs_read") === "allow", "其它键不受影响");
S.config.dsh.agentToolPresets[0].allow.canvas_read = "allow";

/* ===================== [2] runKey 作用域优先 ===================== */
console.log("\n[2] runKey 作用域优先：本轮策略覆盖全局");
S.config.dsh.agentToolPresets[0].allow.canvas_read = "deny";
A.setRunToolPolicy("team:c1:e1", { canvas_read: "allow", fs_write: "ask", web: "allow" });
ok(A.agentToolMode("canvas_read", "team:c1:e1") === "allow", "本轮 allow 覆盖全局 deny");
ok(A.agentToolMode("fs_write", "team:c1:e1") === "ask", "本轮 ask 生效");
ok(A.agentToolMode("web", "team:c1:e1") === "allow", "本轮 allow 生效");
ok(!!A.runToolPolicyOf("team:c1:e1"), "策略按 runKey 安装");

/* ===================== [3] runKey 隔离 + 缺省回退 ===================== */
console.log("\n[3] runKey 隔离 + 缺省回退");
ok(A.agentToolMode("canvas_read", "team:c1:e2") === "deny", "别的 runKey 回全局（不串味）");
ok(A.agentToolMode("canvas_read") === "deny", "无 runKey 回全局");
A.setRunToolPolicy("team:c1:e1", null);
ok(!A.runToolPolicyOf("team:c1:e1"), "空策略删除该 runKey 的旧策略");
ok(A.agentToolMode("canvas_read", "team:c1:e1") === "deny", "删除后回全局");
A.setRunToolPolicy("team:c1:e1", { fs_read: "deny" });
A.clearRunToolPolicy("team:c1:e1");
ok(!A.runToolPolicyOf("team:c1:e1"), "clearRunToolPolicy 清理干净");
S.config.dsh.agentToolPresets[0].allow.canvas_read = "allow";

/* ===================== [4] 专家默认策略 ===================== */
console.log("\n[4] 专家默认策略：能读画布、改画布要点头");
{
  const expertPolicy = T.defaultToolAllow();
  const rk = T.runKeyOf("chat1", "exp1");
  A.setRunToolPolicy(rk, expertPolicy);
  ok(A.agentToolMode("fs_read", rk) === "allow", "读文件 allow");
  ok(A.agentToolMode("web", rk) === "allow", "联网 allow");
  ok(A.agentToolMode("ask_user", rk) === "allow", "反问 allow");
  ok(A.agentToolMode("fs_write", rk) === "allow", "写文件 allow（默认可读写事实库）");
  ok(A.agentToolMode("canvas_read", rk) === "allow", "读画布 allow（专家能查看与核验画布）");
  ok(A.agentToolMode("canvas_nodes", rk) === "ask", "节点与连线 ask");
  ok(A.agentToolMode("canvas_draw", rk) === "ask", "绘图 ask");
  ok(A.agentToolMode("canvas_layout", rk) === "ask", "排版与成组 ask");
  ok(A.agentToolMode("app_ops", rk) === "ask", "应用操作 ask");
  ok(A.agentToolMode("shell", rk) === "ask", "命令 ask");
  ok(A.agentToolMode("app_delete", rk) === "deny", "删除画布 deny");
  ok(A.agentToolMode("vision", rk) === "deny", "识图 deny");

  const denied = A.agentDeniedToolNames(rk);
  /* 默认许可放行了画布，三件套必须留在可见工具里 —— 旧默认「画布与应用类一律拒绝」
     会把它们整档摘掉，专家连画布都看不到（本轮报错即由此而来）。 */
  for (const n of ["mtnode_canvas_get", "mtnode_canvas_edit", "mtnode_app"])
    ok(denied.indexOf(n) < 0, "画布三件套可见（不在隐藏名单）：" + n);
  for (const n of ["mtnode_vision", "subagent", "create_goal", "job_list"])
    ok(denied.indexOf(n) >= 0, "隐藏名单含 " + n);
  /* 反问用户是专家默认放行的，因此 ask_user_question 必须留在可见工具里 */
  ok(denied.indexOf("ask_user_question") < 0, "反问用户放行（不在隐藏名单）");

  /* 画布六类全拒 → 整档闸才摘掉三件套（app-team.js expertNoCanvas 同判据） */
  A.setRunToolPolicy(rk, {
    canvas_read: "deny",
    canvas_nodes: "deny",
    canvas_control: "deny",
    canvas_draw: "deny",
    canvas_layout: "deny",
    canvas_super: "deny",
  });
  const deniedAll = A.agentDeniedToolNames(rk);
  for (const n of ["mtnode_canvas_get", "mtnode_canvas_edit"])
    ok(deniedAll.indexOf(n) >= 0, "画布六类全拒 → 整档摘掉 " + n);
  ok(T.expertNoCanvas({ perm: { toolAllow: { canvas_read: "deny" } } }) === false,
    "只拒『读画布』不算全拒（专家仍可打开画布工具）");
  ok(
    T.expertNoCanvas({
      perm: {
        toolAllow: {
          canvas_read: "deny",
          canvas_nodes: "deny",
          canvas_control: "deny",
          canvas_draw: "deny",
          canvas_layout: "deny",
          canvas_super: "deny",
        },
      },
    }) === true,
    "画布六类全拒 → expertNoCanvas 为真（整档省下 26K 字符 / 步）",
  );
  ok(T.expertNoCanvas({}) === false, "缺省许可（v4）不再整档摘掉画布");

  /* 专家只收窄不扩权：给专家一个「全 allow」策略也不会被宿主能力放大 */
  A.setRunToolPolicy(rk, { canvas_read: "deny" });
  ok(A.agentToolMode("canvas_read", rk) === "deny", "显式 deny 生效");
}

/* ===================== [5] 拒权文案与接线 ===================== */
console.log("\n[5] 拒权文案与运行接线");
{
  const rk = "team:c9:e9";
  A.setRunToolPolicy(rk, { canvas_read: "deny" });
  let scopedMsg = "";
  try {
    A.assertAgentTool("canvas_read", "", rk);
  } catch (e) {
    scopedMsg = String(e && e.message);
  }
  ok(scopedMsg.indexOf("团队面板") >= 0, "本轮策略拒权提示指向团队面板");
  ok(scopedMsg.indexOf("审批") < 0, "本轮策略拒权不再指向全局审批面板");

  S.config.dsh.agentToolPresets[0].allow.canvas_read = "deny";
  let globalMsg = "";
  try {
    A.assertAgentTool("canvas_read", "");
  } catch (e) {
    globalMsg = String(e && e.message);
  }
  ok(globalMsg.indexOf("审批") >= 0, "全局预设拒权仍指向右上角「审批」");
  S.config.dsh.agentToolPresets[0].allow.canvas_read = "allow";

  const db = read("renderer/app-db.js");
  ok(
    db.indexOf("setRunToolPolicy(") >= 0 && db.indexOf("opts.toolPolicy || opts.toolAllow || null") >= 0,
    "dshRunOnce 把 opts.toolPolicy 装进本轮 runKey 作用域",
  );
  ok(/dshHiddenToolsFor\(\{[\s\S]{0,220}?runKey/.test(db), "dshHiddenToolsFor 透传 runKey");
  ok(/agentToolPolicySystemNote\(\{[\s\S]{0,200}?runKey/.test(db), "工具许可提示词按本轮 runKey 生成");
  ok(/agentDeniedToolNames\(o\.runKey\)/.test(db), "隐藏名单按本轮 runKey 计算");

  const teamSrc = read("renderer/app-team.js");
  ok(/toolPolicy:\s*ta\b/.test(teamSrc) && /var ta = normalizeToolAllow\(perm\.toolAllow\)/.test(teamSrc), "专家 perm.toolAllow 经 toolPolicy 下发");
  ok(
    /noCanvas:\s*options\.noCanvas === true \|\| expertNoCanvas\(exp\)/.test(teamSrc),
    "专家 noCanvas 按本专家的许可算（不再一刀切挡住画布）",
  );
  const viewSrc = read("renderer/app-teamview.js");
  ok(
    /window\.MTNodeTeam\.expertNoCanvas\(exp\)/.test(viewSrc),
    "app-teamview 兜底运行路径同口径（共用 MTNodeTeam.expertNoCanvas）",
  );
}

console.log(
  "\n" +
    (fails
      ? "FAILED " + fails + " / " + checks + " checks"
      : "ALL OK  " + checks + " checks"),
);

/* ==================== 已并入：test/smoke-team-view.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-team-view.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) =>
    fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

  /* 最小 DOM 桩：teamViewEl / teamViewAvatar / teamViewRenderExpertCard 只用到这几个成员。
     innerHTML 用访问器：赋值即清空 children（贴近真实 DOM，专家卡折叠区靠它重绘）。
     classList / querySelector 走真实语义：切画布加载屏靠 .team-pane-loading.on 判定。 */
  function fakeEl(tag) {
    const cls = new Set();
    const e = {
      tagName: tag,
      className: "",
      textContent: "",
      style: {},
      children: [],
      options: [],
      value: "",
      _html: "",
      _ev: {},
      hidden: false,
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      setAttribute() {},
      addEventListener(t, fn) {
        (this._ev[t] || (this._ev[t] = [])).push(fn);
      },
      removeEventListener() {},
      _fire(t, ev) {
        const e2 = ev || { target: this };
        if (!e2.stopPropagation) e2.stopPropagation = function () {};
        if (!e2.preventDefault) e2.preventDefault = function () {};
        (this._ev[t] || []).forEach((fn) => fn(e2));
      },
      classList: {
        contains: (c) => cls.has(c),
        add(c) {
          cls.add(c);
        },
        remove(c) {
          cls.delete(c);
        },
      },
      querySelector(sel) {
        const want = String(sel || "").replace(/^\./, "");
        const walk = (n) => {
          for (const c of n.children || []) {
            if (String(c.className || "").split(/\s+/).indexOf(want) >= 0) return c;
            const hit = walk(c);
            if (hit) return hit;
          }
          return null;
        };
        return walk(this);
      },
    };
    Object.defineProperty(e, "innerHTML", {
      get() {
        return this._html;
      },
      set(v) {
        this._html = String(v);
        this.children.length = 0;
      },
    });
    return e;
  }

  function loadView() {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.console = console;
    /* I18n 桩：与 renderer/i18n.js 的 t(key, vars) 同语义（占位符 {name} 替换），
       否则 teamViewT 的 vars 透传测不出来。最后一次 vars 记到 __lastI18nVars。 */
    sandbox.__lastI18nVars = null;
    sandbox.I18n = {
      t: (s, vars) => {
        sandbox.__lastI18nVars = vars === undefined ? null : vars;
        let out = String(s);
        if (vars && typeof vars === "object")
          out = out.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
        return out;
      },
    };
    const els = {};
    sandbox.document = {
      createElement: (t) => fakeEl(t),
      getElementById: (id) => els[id] || null,
    };
    sandbox.__testEls = els;
    sandbox.api = { configSave: () => Promise.resolve() };
    /* toast 桩：折叠头「编辑」入口在招聘模块缺失时走 warn 提示（不得抛错）。 */
    sandbox.__toasts = [];
    sandbox.toast = (m, kind) => sandbox.__toasts.push([m, kind || ""]);
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.AGENT_PRESETS = [];
    sandbox.AGENT_PRESET_DEFAULT = "minimal";
    sandbox.AGENT_PRESET_LEGACY_IDS = {};
    sandbox.normalizeAgentEffort = (v) => (v ? String(v) : "high");
    sandbox.permissionPresetOptions = () => [];
    const S = {
      config: { teamView: { projectId: "wf-old" } },
      wf: { id: "wf-1", name: "画布 A" },
    };
    sandbox.S = S;
    vm.createContext(sandbox);
    vm.runInContext(read("renderer/app-team-icons.js"), sandbox, { filename: "app-team-icons.js" });
    vm.runInContext(read("renderer/app-team.js"), sandbox, { filename: "app-team.js" });
    vm.runInContext(read("renderer/app-teamview.js"), sandbox, { filename: "app-teamview.js" });
    return { sandbox, S, team: sandbox.MTNodeTeam, icons: sandbox.MTNodeTeamIcons };
  }

  let V = null;
  let loadErr = null;
  try {
    V = loadView();
  } catch (e) {
    loadErr = e;
  }
  ok(!loadErr, "app-teamview.js 顶层加载不抛错" + (loadErr ? "（" + loadErr.message + "）" : ""));
  const { sandbox, S, team: T, icons: IC } = V || {};

  /* ===================== [1] 自带 str ===================== */
  console.log("\n[1] 顶层加载 + 本文件自带 str 兜底");
  {
    const src = read("renderer/app-teamview.js");
    ok(/function str\s*\(/.test(src), "文件内声明了局部 str（不再依赖他文件的局部函数）");
    ok(typeof sandbox.str === "function", "加载后 window.str 可用");
    ok(sandbox.str(null) === "" && sandbox.str(0) === "0", "str 兜底语义正确");
  }

  /* ===================== [2] 关键函数调用不抛错 ===================== */
  console.log("\n[2] 关键渲染函数调用不抛 ReferenceError（裸 str 回归）");
  {
    const call = (name, fn) => {
      try {
        fn();
        ok(true, name + " 可调用");
      } catch (e) {
        ok(false, name + " 抛错：" + e.message);
      }
    };
    call("teamViewSel()", () => sandbox.teamViewSel());
    call("teamViewCategoryOptions('')", () => sandbox.teamViewCategoryOptions(""));
    call("teamViewModelLabel({})", () => sandbox.teamViewModelLabel({}));
    call("teamViewChatsFor(null, null)", () => sandbox.teamViewChatsFor(null, null));
    call("teamViewAvatar(专家)", () =>
      sandbox.teamViewAvatar({ icon: "code", color: "#ff0000", glyph: "🧩" }, "lg"),
    );
  }

  /* ===================== [3] 头像 ===================== */
  console.log("\n[3] 头像：空心线条 SVG + 专家色落在描边");
  {
    const av = sandbox.teamViewAvatar({ icon: "code", color: "#ff0000" });
    ok(av.className.indexOf("team-avatar") >= 0, "外层是 .team-avatar");
    const glyph = av.children[0];
    ok(!!glyph && glyph.className.indexOf("team-avatar-glyph") >= 0, "内层是 .team-avatar-glyph");
    ok(/<svg/.test(glyph.innerHTML) && /stroke="currentColor"/.test(glyph.innerHTML), "渲染空心线条 SVG");
    ok(/fill="none"/.test(glyph.innerHTML), "SVG fill:none（空心）");
    ok(glyph.style.color === "#ff0000", "专家色落在图标描边上（style.color）");
    ok(!av.style.background && !av.style.backgroundColor, "头像底色不写死颜色（交给 CSS 主题变量）");
    const lg = sandbox.teamViewAvatar({ icon: "code" }, "lg");
    ok(/width="28"/.test(lg.children[0].innerHTML), "lg 尺寸图标 28px");
    const fb = sandbox.teamViewAvatar({ glyph: "🧩" });
    ok(fb.children[0].innerHTML === IC.svg("module", { size: 18 }), "旧 emoji 回落到映射图标（🧩→module）");
  }

  /* ===================== [4] 选择键迁移 ===================== */
  console.log("\n[4] 选择键迁移：projectId → canvasId");
  {
    ok(S.config.teamView.projectId === "wf-old", "预置旧键 projectId");
    const v = sandbox.teamViewSel();
    ok(v.canvasId === "wf-old", "读到旧键即迁移为 canvasId");
    ok(v.projectId === "wf-old", "旧键保留（读兼容，不删）");
  }

  /* ===================== [5] 团队恒绑定当前画布 ===================== */
  console.log("\n[5] 团队恒绑定当前画布：ensure 强制当前画布 + 标题 = 当前画布名");
  {
    /* 另一张有专家的画布：即使选择键指向它，ensure 也必须回到当前画布。 */
    T.ensureCanvas();
    const other = T.addCanvas({ id: "wf-2", name: "画布 B" });
    T.addExpert({ canvasId: other.id, name: "B 专家", icon: "server" });
    T.addCanvas({ id: "wf-3", name: "空画布" });
    sandbox.teamViewSetSel({ canvasId: "wf-2", expertId: "", chatId: "" });

    const st = sandbox.teamViewEnsure();
    ok(st.canvasId === "wf-1", "选择键指向别的画布时，ensure 仍强制当前画布（wf-1）");
    ok(st.proj && st.proj.id === "wf-1", "proj 恒为当前画布锚点");
    ok(!st.exp || String(st.exp.canvasId || st.exp.projectId) === "wf-1", "选中的专家属于当前画布");

    const logo = fakeEl("span");
    sandbox.__testEls.teamSideLogo = logo;
    sandbox.teamViewRenderTitle({ proj: { id: "wf-1", name: "画布 A" } });
    ok(logo.textContent === "画布 A", "标题写当前画布名（不再写死 AI团队）");
    ok(String(logo.title || "").indexOf("画布 A") >= 0, "标题 tooltip 带当前画布名");
  }

  /* ===================== [6] 分类下拉 ===================== */
  console.log("\n[6] 分类下拉选项");
  {
    const opts = sandbox.teamViewCategoryOptions("野分类");
    const vals = opts.map((o) => o[0]);
    ok(vals[0] === "", "首项是「未分类」（空值）");
    ok(vals.indexOf("研发") >= 0, "含默认分类（研发）");
    ok(vals.indexOf("野分类") >= 0, "含当前未知分类值（不会丢）");
    ok(vals[vals.length - 1] === "__new__", "末项是「＋ 新建分类…」哨兵");
  }

  /* ===================== [7] 标题=当前画布 + 复制按钮 + 删除入口移除 ===================== */
  console.log("\n[7] 标题使用当前画布 + 复制按钮 + 删除入口已移除");
  {
    const html = read("renderer/index.html");
    const paneAt = html.indexOf('id="teamPane"');
    const pane = html.slice(paneAt, html.indexOf('class="assist-pane"', paneAt));
    ok(paneAt >= 0 && pane.indexOf('id="teamSideLogo"') >= 0, "左栏标题宿主 #teamSideLogo 存在");
    ok(pane.indexOf('data-i18n="AI团队"') < 0, "左栏不再写死 AI团队");
    ok(pane.indexOf('id="teamCopyBtn"') >= 0 && /<svg/.test(pane), "标题右侧有「复制」icon 按钮");
    ok(
      pane.indexOf('id="teamProjectList"') < 0 && pane.indexOf('data-i18n="画布"') < 0,
      "移除左栏「画布」锚点列表",
    );
    ok(html.indexOf('id="teamAddProject"') < 0, "移除「＋新建项目」入口");
    ok(html.indexOf('id="teamAddCategory"') < 0, "移除左栏「新建分类」入口（分类收口到招聘页）");
    ok(html.indexOf('id="teamExpertCard"') >= 0, "右栏专家卡折叠区宿主存在");

    const src = read("renderer/app-teamview.js");
    ok(
      src.indexOf("team-anchor-del") < 0 && src.indexOf("teamViewRemoveAnchor") < 0,
      "锚点行 ✕ 删除按钮与移除逻辑已移除",
    );
    ok(
      /function openTeamCopyDlg\s*\(/.test(src) && /teamCopyCanvas\(/.test(src),
      "复制按钮走 openTeamCopyDlg + teamCopyCanvas",
    );
    ok(/wfList/.test(src), "目标画布候选走 wfList（磁盘画布列表）");
    ok(/仅增量复制/.test(src), "对话框说明「仅增量复制」");
  }

  /* ===================== [8] 剪枝守卫 + 专家卡折叠 ===================== */
  console.log("\n[8] 进视图剪枝带守卫；专家卡折叠默认收起");
  {
    const src = read("renderer/app-teamview.js");
    ok(/typeof window\.teamPruneCanvases !== "function"/.test(src), "剪枝前有 typeof 守卫（模块未加载不炸）");
    ok(/function teamViewEnsure\(\)\s*\{\s*\n?\s*teamViewPrune\(\)/.test(src), "进视图先剪枝");
    ok(/var teamViewCardOpen = ""/.test(src), "折叠态缺省为空（全部收起）");

    const box = fakeEl("div");
    box.hidden = true;
    sandbox.__testEls.teamExpertCard = box;

    delete sandbox.renderExpertCard;
    sandbox.teamViewRenderExpertCard({ exp: { id: "e1", name: "x" }, chat: null });
    ok(box.hidden === true, "无 window.renderExpertCard 时整块隐藏（不渲染）");

    sandbox.renderExpertCard = (exp) => "CARD:" + exp.id;
    sandbox.teamViewCardOpen = "";
    sandbox.teamViewRenderExpertCard({ exp: { id: "e1", name: "x" }, chat: null });
    ok(box.hidden === false, "有 renderExpertCard 时显示折叠区");
    ok(box.children.length === 1 && /team-card-fold/.test(box.children[0].className), "渲染折叠头");
    ok(box.children.length === 1, "默认收起（不渲染 body）");

    sandbox.teamViewCardOpen = "e1";
    sandbox.teamViewRenderExpertCard({ exp: { id: "e1", name: "x" }, chat: null });
    ok(
      box.children.length === 2 && /team-card-body/.test(box.children[1].className),
      "展开后追加卡片 body",
    );
    ok(box.children[1].innerHTML === "CARD:e1", "复用 window.renderExpertCard（单一真源）");

    /* 折叠头：可编辑口径 + 「✎ 编辑」入口（复用招聘对话框编辑模式，点击不切换折叠）。 */
    const fold = box.children[0];
    const hint = fold.children.filter((c) => /team-card-hint/.test(c.className))[0];
    ok(!!hint && hint.textContent === "✎ 可编辑设定与权限", "折叠头 hint 改为「✎ 可编辑设定与权限」");
    ok(src.indexOf("只读 · 修改请回招聘页") < 0, "旧「只读 · 修改请回招聘页」文案已移除");
    const editBtn = fold.children.filter((c) => /team-card-edit/.test(c.className))[0];
    ok(!!editBtn && editBtn.textContent === "✎ 编辑", "展开态折叠头带「✎ 编辑」按钮");
    ok(!!editBtn && editBtn.type === "button", "编辑按钮 type=button（不提交表单）");

    /* 点击编辑：调 window.teamRecruitEdit(专家 id)，且不切换折叠态。 */
    const edits = [];
    sandbox.teamRecruitEdit = (id) => edits.push(id);
    sandbox.__toasts.length = 0;
    editBtn._fire("click", { stopPropagation() {}, preventDefault() {}, target: editBtn });
    ok(edits.length === 1 && edits[0] === "e1", "点击编辑调 window.teamRecruitEdit(专家 id)");
    ok(sandbox.teamViewCardOpen === "e1", "点击编辑不切换折叠态");

    /* 招聘模块未加载（teamRecruitEdit 缺失）：warn 提示、不抛错。 */
    delete sandbox.teamRecruitEdit;
    let noThrow = true;
    try {
      editBtn._fire("click", { stopPropagation() {}, preventDefault() {}, target: editBtn });
    } catch (_) {
      noThrow = false;
    }
    ok(noThrow, "招聘模块缺失时点击编辑不抛错");
    ok(
      sandbox.__toasts.length === 1 && sandbox.__toasts[0][1] === "warn",
      "招聘模块缺失时 toast warn「编辑入口未就绪」",
    );

    sandbox.teamViewCardOpen = "";
    sandbox.teamViewRenderExpertCard({ exp: { id: "e1" }, chat: { kind: "group" } });
    ok(box.hidden === true, "群聊视图隐藏专家卡");
    sandbox.teamViewRenderExpertCard({ exp: null, chat: null });
    ok(box.hidden === true, "无选中专家时隐藏专家卡");
  }

  /* ===================== [9] copyCanvas 增量复制 ===================== */
  console.log("\n[9] copyCanvas：只追加 / 不覆盖目标已有内容 / 会话重指向新专家");
  {
    /* 源画布 wf-1：两位专家 + 单聊 + 群聊；目标画布 wf-2 已有一位专家（不能被覆盖）。 */
    const e1 = T.addExpert({ canvasId: "wf-1", name: "甲", icon: "code" });
    const e2 = T.addExpert({ canvasId: "wf-1", name: "乙", icon: "server" });
    T.addChat({ expertId: e1.id, canvasId: "wf-1", title: "单聊" });
    T.addGroupChat({ projectId: "wf-1" });
    const beforeB = T.experts("wf-2").length;

    const r = T.copyCanvas("wf-1", "wf-2");
    ok(r.experts === 2 && r.chats === 2, "复制计数：2 位专家 + 2 个会话");

    const copied = T.experts("wf-2").filter((x) => x.name === "甲" || x.name === "乙");
    ok(copied.length === 2, "两位专家都复制到目标画布");
    ok(
      copied.every((x) => x.id !== e1.id && x.id !== e2.id),
      "专家 id 换新（不与源共用）",
    );
    ok(T.experts("wf-2").length === beforeB + 2, "目标画布已有专家保留（增量，不覆盖）");
    ok(T.experts("wf-1").length === 2, "源画布专家不受影响");

    const sc = T.chats().find((c) => c.canvasId === "wf-2" && c.title === "单聊");
    ok(!!sc && copied.some((x) => x.id === sc.expertId), "单聊重指向复制出来的专家");
    const gc = T.chats().find((c) => c.canvasId === "wf-2" && c.kind === "group");
    ok(
      !!gc &&
        gc.participants.length === 2 &&
        gc.participants.every((id) => copied.some((x) => x.id === id)),
      "群聊参与者重指向复制出来的专家",
    );
    const srcChats = T.chats().filter((c) => (c.canvasId || c.projectId) === "wf-1").length;
    const dstChats = T.chats().filter((c) => (c.canvasId || c.projectId) === "wf-2").length;
    ok(dstChats === srcChats, "会话一并复制到目标画布");
    ok(T.copyCanvas("wf-1", "wf-1").experts === 0, "源=目标时不做任何复制");
  }

  /* ===================== [10] 切画布：立即换团队 + 加载屏防串线 ===================== */
  console.log("\n[10] 切画布：立即换团队 + 切换途中盖加载屏（防串线）");
  {
    const srcView = read("renderer/app-teamview.js");
    const srcApp = read("renderer/app.js");
    const css = read("renderer/css/layout.css");
    ok(
      /function teamViewBeginCanvasSwitch\s*\(/.test(srcView) &&
        /function teamViewOnCanvasSwitch\s*\(/.test(srcView),
      "app-teamview.js 提供「切换开始 / 落定」两个钩子",
    );
    ok(
      /team-pane-loading/.test(srcView) && /\.team-pane-loading\b/.test(css),
      "加载屏类名脚本与 layout.css 齐备",
    );
    ok(/position:\s*relative/.test(css.slice(css.indexOf(".team-pane {"))), "面板为加载屏提供定位上下文");
    ok(
      /function renderTeamPane\(\)[\s\S]{0,260}?if \(teamViewSwitching\)/.test(srcView),
      "切换中 renderTeamPane 直接返回（绝不画旧画布团队）",
    );
    ok(/teamViewBeginCanvasSwitch\(id\)/.test(srcApp), "loadWorkflow 开头就盖加载屏");
    ok(/teamViewOnCanvasSwitch\(\)/.test(srcApp), "setForegroundWf 落定后立刻换团队 + 撤屏");
    ok(/teamViewCancelCanvasSwitch\(\)/.test(srcApp), "读盘失败分支撤屏并回退旧画布");
    ok(
      /正在切换画布…/.test(srcView) &&
        /"正在切换画布…":\s*"/.test(read("renderer/i18n.js")),
      "加载屏文案有英文译文",
    );

    /* 行为：团队视图下 begin 盖屏 → 途中重渲染不动旧内容 → 落定后立刻切新画布。 */
    S.view = "team";
    S.config.visitedWorkflows = [{ id: "wf-2", name: "画布 B" }];
    const pane = fakeEl("div");
    sandbox.__testEls.teamPane = pane;
    const logo = fakeEl("span");
    logo.textContent = "旧画布";
    sandbox.__testEls.teamSideLogo = logo;

    ok(sandbox.teamViewBeginCanvasSwitch("wf-2") === true, "团队视图下 begin 返回 true（盖屏）");
    const load = pane.querySelector(".team-pane-loading");
    ok(!!load && load.classList.contains("on"), "加载屏已显示（.on）");
    ok(load.children[2].textContent === "画布 B", "加载屏显示目标画布名（取画布 Tab 记忆）");

    sandbox.renderTeamPane();
    ok(logo.textContent === "旧画布", "切换途中重渲染不碰旧画布内容（串线闸）");

    S.wf = { id: "wf-2", name: "画布 B" };
    sandbox.teamViewOnCanvasSwitch();
    ok(logo.textContent === "画布 B", "落定后标题立即切到新画布");
    ok(!load.classList.contains("on"), "落定后加载屏撤下");

    S.view = "workflow";
    ok(sandbox.teamViewBeginCanvasSwitch("wf-2") === false, "非团队视图不盖屏");
    ok(sandbox.teamViewOnCanvasSwitch() === false, "非团队视图落定回调是空操作");
  }

  /* ===================== [11] 左栏角色行 ===================== */
  console.log("\n[11] 左栏角色行：＋新建单聊 / 空分类不显示 / 不显示模型");
  {
    const html = read("renderer/index.html");
    ok(html.indexOf('id="teamNewChat"') < 0, "顶部「＋ 新会话」按钮已移除");
    ok(html.indexOf('id="teamCopyBtn"') >= 0, "标题右侧「复制」按钮保留");

    const src = read("renderer/app-teamview.js");
    ok(/function teamViewNewChatFor\s*\(/.test(src), "新增 teamViewNewChatFor（为角色开一段新单聊）");
    ok(/team-side-add-chat/.test(src), "角色行渲染「＋」按钮（.team-side-add-chat）");
    const expSrc = src.slice(
      src.indexOf("function teamViewRenderExperts"),
      src.indexOf("function teamViewRenderChats"),
    );
    ok(!/teamViewModelLabel/.test(expSrc), "角色行不再渲染模型标签（左栏树里已删 teamViewModelLabel）");
    ok(/buckets = buckets\.filter/.test(src), "空分类被过滤（没有角色的分类不予显示）");
    ok(
      /\.team-side-add-chat\b/.test(read("renderer/css/layout.css")),
      "layout.css 提供 .team-side-add-chat 样式",
    );

    /* 行为：wf-1 有 2 位未分类专家 + 8 个空默认分类 → 只渲染 1 个分类桶。 */
    const box = fakeEl("div");
    sandbox.__testEls.teamExpertList = box;
    /* 事实库：库行 + 库内多篇文档子行（文档行显示更新时间，不再显示字数）。 */
    T.ensureFact("wf-1", {
      name: "事实库",
      file: "E:/ws/a/团队事实库/事实库.md",
      assetsDir: "E:/ws/a/团队事实库/assets",
    });
    T.ensureFactDoc("wf-1", {
      name: "产品规格",
      file: "E:/ws/a/团队事实库/产品规格.md",
    });
    sandbox.teamViewRenderExperts({ canvasId: "wf-1" });
    const cats = box.children.filter((c) => /team-cat-row/.test(c.className));
    ok(cats.length === 1, "8 个空分类不显示，只留 1 个有角色的桶（未分类）");
    ok(box.children.length === 3, "渲染 1 个分类头 + 1 组角色 + 末尾事实库分组");
    const factWrap = box.children[2];
    ok(/team-side-fact-group/.test(factWrap.className), "末尾是事实库分组（.team-side-fact-group）");
    const factRow = factWrap.children[0];
    ok(/team-side-fact\b/.test(factRow.className), "分组首行是事实库行（.team-side-fact）");
    ok(!!factRow.querySelector(".team-side-add-chat"), "库行常显「＋」＝新建文档");
    ok(
      factRow.querySelector(".team-side-sub").textContent === "2 篇",
      "库行显示文档数（{n} 篇）",
    );
    /* 事实库删除（本轮新增）：库行与文档行各挂一个**与会话行同款**的「✕」按钮
       （.team-side-act danger，hover 出现），点击先弹确认框，确认后才由主进程搬进系统回收站。 */
    const titlesOf = (n, acc) => {
      (n.children || []).forEach((c) => {
        if (c.title) acc.push(String(c.title));
        titlesOf(c, acc);
      });
      return acc;
    };
    const dangerBtnsOf = (n, acc) => {
      (n.children || []).forEach((c) => {
        if (String(c.className || "").split(/\s+/).indexOf("danger") >= 0) acc.push(c);
        dangerBtnsOf(c, acc);
      });
      return acc;
    };
    const factActs = titlesOf(factRow, []);
    ok(
      factActs.some((t) => t.indexOf("打开所在文件夹") >= 0),
      "库行有「打开所在文件夹」",
    );
    const factDels = dangerBtnsOf(factRow, []);
    ok(
      factDels.length === 1 &&
        /team-side-act/.test(factDels[0].className) &&
        factDels[0].textContent === "✕",
      "库行有「✕」删除事实库按钮（.team-side-act danger，与会话行同款）",
    );
    ok(
      factActs.some((t) => t.indexOf("删除该事实库") >= 0 && t.indexOf("回收站") >= 0),
      "库行删除按钮的 tooltip 说明「移入系统回收站」",
    );
    ok(
      !factActs.some((t) => /重命名/.test(t)),
      "库行仍无重命名入口",
    );
    /* 点删库按钮 → 弹确认框（点名库名 + 说明进回收站），不确认不动手。 */
    let capMsg = "";
    let capOpts = null;
    sandbox.confirmDialog = (m, o) => {
      capMsg = String(m);
      capOpts = o || {};
      return { then() {} }; /* 只截文案，不真正删除 */
    };
    factDels[0]._fire("click");
    ok(
      capMsg.indexOf("删除事实库") >= 0 && capMsg.indexOf("回收站") >= 0,
      "库行点删除：弹确认框并说明移入系统回收站",
    );
    ok(
      capOpts.danger === true && capOpts.title === "删除事实库" && capOpts.okText === "删除",
      "确认框走危险操作样式（danger + 标题「删除事实库」+ 确认键「删除」）",
    );
    const docRows = factWrap.children[1];
    ok(/team-side-fact-docs/.test(docRows.className), "库行下是文档子行容器（.team-side-fact-docs）");
    ok(docRows.children.length === 2, "库内 2 篇文档各一行（多文档在左栏列出）");
    const drow = docRows.children[0];
    ok(/team-side-fact-doc/.test(drow.className), "文档子行（.team-side-fact-doc）");
    ok(
      !!drow.querySelector(".team-side-name") && !!drow.querySelector(".team-side-sub"),
      "文档子行显示文档名 + 更新时间位",
    );
    ok(!drow.querySelector(".team-side-add-chat"), "文档子行不带「＋」（新建文档只在库行）");
    const docDels = dangerBtnsOf(drow, []);
    ok(
      docDels.length === 1 && docDels[0].textContent === "✕" && /danger/.test(docDels[0].className),
      "文档子行有「✕」删除该文档按钮（与会话行同款）",
    );
    ok(
      titlesOf(drow, []).some((t) => t.indexOf("删除该文档") >= 0 && t.indexOf("回收站") >= 0),
      "文档行删除按钮的 tooltip 说明「移入系统回收站」",
    );
    capMsg = "";
    capOpts = null;
    docDels[0]._fire("click");
    ok(
      capMsg.indexOf("删除文档") >= 0 && capMsg.indexOf("回收站") >= 0,
      "文档行点删除：弹确认框并说明移入系统回收站",
    );
    ok(
      capOpts.danger === true && capOpts.title === "删除文档" && capOpts.okText === "删除",
      "文档行确认框走危险操作样式（danger + 标题「删除文档」）",
    );
    delete sandbox.confirmDialog;
    /* 文档行更新时间文案：刚刚 / N 分钟前 / N 小时前，超过 24h 用本地 YYYY-MM-DD HH:mm。 */
    ok(sandbox.teamViewFactStamp(Date.now()) === "刚刚", "更新时间文案：刚刚");
    ok(
      sandbox.teamViewFactStamp(Date.now() - 5 * 60000) === "5 分钟前",
      "更新时间文案：N 分钟前",
    );
    ok(
      sandbox.teamViewFactStamp(Date.now() - 3 * 3600000) === "3 小时前",
      "更新时间文案：N 小时前",
    );
    ok(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(
        sandbox.teamViewFactStamp(Date.now() - 48 * 3600000),
      ),
      "更新时间文案：超过 24h 用本地日期时间",
    );
    ok(sandbox.teamViewFactStamp(0) === "", "无时间戳不显示更新时间文案");
    const kids = box.children[1];
    ok(/team-cat-kids/.test(kids.className) && kids.children.length === 2, "2 位角色各一行");
    const row = kids.children[0];
    ok(!!row.querySelector(".team-side-add-chat"), "角色行右侧有「＋」按钮");
    ok(
      !!row.querySelector(".danger"),
      "角色行右侧有「✕」删除专家按钮（hover 出现）",
    );
    ok(
      !row.children.some((c) => /team-badge/.test(c.className)),
      "角色行不再有模型角标",
    );

    /* 「＋」的行为：为这位角色开一段新单聊并选中。 */
    S.wf = { id: "wf-1", name: "画布 A" };
    const before = T.chats().filter((c) => (c.canvasId || c.projectId) === "wf-1").length;
    const e3 = T.addExpert({ canvasId: "wf-1", name: "丙", icon: "code" });
    const c = sandbox.teamViewNewChatFor(e3);
    ok(!!c && c.expertId === e3.id, "新单聊挂在被点的角色上");
    ok(
      T.chats().filter((x) => (x.canvasId || x.projectId) === "wf-1").length === before + 1,
      "会话数 +1（原顶部按钮行为迁移到角色行「＋」）",
    );
    const sel = sandbox.teamViewSel();
    ok(sel.expertId === e3.id && sel.chatId === c.id, "新单聊自动选中（右栏立即显示）");
  }

  /* ===================== [12] 删除专家（保留会话）/ 删除会话 / 孤儿会话 ===================== */
  console.log("\n[12] 删除专家保留会话 + 删除会话 + 孤儿会话标记");
  {
    const del = T.addExpert({ canvasId: "wf-1", name: "要被删的专家", icon: "cat" });
    ok(IC.keys().indexOf("cat") >= 0, "角色扮演类图标 cat 已在图标目录内");
    const c1 = T.addChat({ expertId: del.id, canvasId: "wf-1", title: "留下来的会话" });
    const c2 = T.addChat({ expertId: del.id, canvasId: "wf-1", title: "要删的会话" });

    sandbox.teamViewRemoveExpert(del);
    ok(!T.expert(del.id), "专家已删除");
    ok(!!T.chat(c1.id) && !!T.chat(c2.id), "删除专家后其会话全部保留（不级联删除）");
    ok(T.chat(c1.id).expertName === "要被删的专家", "保留的会话记下原专家名");
    ok(
      sandbox
        .teamViewChatsFor({ id: "wf-1" }, null)
        .some((c) => c.id === c1.id),
      "孤儿会话仍出现在当前画布会话列表",
    );

    const list = fakeEl("div");
    sandbox.__testEls.teamChatList = list;
    sandbox.teamViewRenderChats({ chats: [T.chat(c1.id)], chat: null });
    const orow = list.children[0];
    ok(!!orow.querySelector(".team-side-orphan"), "孤儿会话行带「专家已删除」标记");
    ok(!!orow.querySelector(".danger"), "会话行有「✕」删除会话按钮");

    const head = fakeEl("div");
    sandbox.__testEls.teamMainHead = head;
    sandbox.teamViewRenderMain({ orphan: true, chat: T.chat(c1.id) });
    ok(head.children.length === 2, "孤儿会话右栏渲染头像 + 说明（不挂到别的专家上）");

    sandbox.teamViewRemoveChat(T.chat(c2.id));
    ok(!T.chat(c2.id), "会话可单独删除");
    ok(!!T.chat(c1.id), "删一个会话不影响另一个");
  }

  /* ===================== [13] 占位符替换（{name} 不再原样显示） ===================== */
  console.log("\n[13] 团队文案占位符替换：删除专家确认框指向具体名字");
  {
    const src = read("renderer/app-teamview.js");
    ok(/function teamViewT\(s, vars\)/.test(src), "teamViewT 接第二参 vars");
    ok(/I18n\.t\(s, vars\)/.test(src), "vars 透传给 I18n.t（占位符替换单一真源）");

    const withVars = sandbox.teamViewT("删除专家「{name}」？该操作不可恢复。", { name: "甲" });
    ok(withVars.indexOf("甲") >= 0, "teamViewT 把 {name} 替换成专家名");
    ok(!/\{\w+\}/.test(withVars), "teamViewT 结果不留未替换占位符");
    ok(
      sandbox.__lastI18nVars && sandbox.__lastI18nVars.name === "甲",
      "vars 确实传到了 I18n.t",
    );

    /* 无 I18n 时的本地兜底：临时摘掉 window.I18n 再替换。 */
    const keep = sandbox.I18n;
    sandbox.I18n = null;
    const fb = sandbox.teamViewT("删除专家「{name}」？该操作不可恢复。", { name: "乙" });
    sandbox.I18n = keep;
    ok(fb.indexOf("乙") >= 0 && !/\{\w+\}/.test(fb), "无 I18n 时本地兜底也做替换");

    /* 端到端：确认框正文里必须出现专家名，且不出现 {name}。 */
    let capMsg = "";
    sandbox.confirmDialog = (m) => {
      capMsg = String(m);
      return { then() {} }; /* 只截文案，不真正删除 */
    };
    const e1 = T.addExpert({ canvasId: "wf-1", name: "占位符专家", icon: "cat" });
    sandbox.teamViewRemoveExpert(e1);
    ok(capMsg.indexOf("占位符专家") >= 0, "无会话专家：确认框点名「占位符专家」");
    ok(!/\{\w+\}/.test(capMsg), "无会话专家：确认框无未替换占位符");
    ok(capMsg.indexOf("不可恢复") >= 0, "无会话专家：走「不可恢复」文案");

    const e2 = T.addExpert({ canvasId: "wf-1", name: "带会话的专家", icon: "cat" });
    T.addChat({ expertId: e2.id, canvasId: "wf-1", title: "保留我" });
    capMsg = "";
    sandbox.teamViewRemoveExpert(e2);
    ok(capMsg.indexOf("带会话的专家") >= 0, "有会话专家：确认框点名「带会话的专家」");
    ok(/1 个会话/.test(capMsg), "有会话专家：确认框带上保留的会话数");
    ok(!/\{\w+\}/.test(capMsg), "有会话专家：确认框无未替换占位符");
    delete sandbox.confirmDialog;
  }

  /* ===================== [14] 并发对话：运行态按会话隔离 ===================== */
  console.log("\n[14] 同时可与多个专家对话：运行态按 chatId 隔离，一条在跑不挡另一条");
  (async () => {
    const src = read("renderer/app-teamview.js");
    ok(!/var teamLive = null/.test(src), "不再有全局单例 teamLive");
    ok(/var teamLives = Object\.create\(null\)/.test(src), "运行态改为按会话的 teamLives 映射");
    ok(/function teamLiveOf\(chatId\)/.test(src), "提供 teamLiveOf(chatId)");
    ok(
      !/if \(teamLive && teamLive\.running\) return;/.test(src),
      "发送 / 重发不再被全局运行态一票否决",
    );

    const { sandbox, S, team } = V;
    const expA = team.addExpert({ canvasId: "wf-1", name: "专家甲", icon: "cat" });
    const expB = team.addExpert({ canvasId: "wf-1", name: "专家乙", icon: "cat" });
    const cA = team.addChat({ expertId: expA.id, canvasId: "wf-1", title: "和甲聊" });
    const cB = team.addChat({ expertId: expB.id, canvasId: "wf-1", title: "和乙聊" });

    /* 甲正在跑：给它的 live 记录置 running。 */
    const liveA = {
      chatId: cA.id,
      running: true,
      pending: "甲还在答",
      reasoning: "",
      tools: [],
      err: "",
      speaker: expA,
      stopped: false,
    };
    sandbox.teamLivePut(cA.id, liveA);
    ok(sandbox.teamLiveOf(cA.id) === liveA, "teamLivePut / teamLiveOf 能装取某会话运行态");

    /* 切到乙的会话，发一条消息：不应被甲的运行挡住。 */
    S.config.teamView.canvasId = "wf-1";
    S.config.teamView.expertId = expB.id;
    S.config.teamView.chatId = cB.id;
    sandbox.__testEls.teamChatInput = fakeEl("textarea");
    sandbox.__testEls.teamChatInput.value = "乙，你怎么看？";
    const ranKeys = [];
    sandbox.dshRunTask = async (input, opts) => {
      ranKeys.push(opts.runKey);
      return "乙的回复";
    };
    await sandbox.teamChatSend();
    ok(
      ranKeys.length === 1 && ranKeys[0].indexOf("team:" + cB.id + ":") === 0,
      "甲在跑时仍能向乙发起一轮（runKey 落在乙的会话上）",
    );
    ok(sandbox.teamLiveOf(cA.id) === liveA && liveA.running === true, "乙开跑不影响甲自己的运行态");
    const msgsB = (team.chat(cB.id) || {}).messages || [];
    ok(
      msgsB.length === 2 && msgsB[0].role === "user" && msgsB[1].content === "乙的回复",
      "乙的会话正常落用户消息与回复",
    );
    ok(
      sandbox.teamLiveOf(cB.id) && sandbox.teamLiveOf(cB.id).running === false,
      "乙这一轮结束后自己的运行态复位",
    );

    /* 终止只停当前视图那条会话。 */
    const stopped = [];
    sandbox.dshCancelActive = (k) => stopped.push(k);
    sandbox.teamLivePut(cA.id, Object.assign({}, liveA, { running: true }));
    sandbox.teamLivePut(cB.id, {
      chatId: cB.id,
      running: true,
      pending: "",
      reasoning: "",
      tools: [],
      err: "",
      speaker: expB,
      stopped: false,
    });
    S.config.teamView.chatId = cA.id;
    sandbox.teamChatStop();
    ok(stopped.length === 1 && stopped[0] === "team:" + cA.id, "终止只发当前会话的 runKey");
    ok(
      sandbox.teamLiveOf(cB.id).running === true,
      "终止甲不会把仍在跑的乙一起停掉",
    );
    delete sandbox.dshRunTask;
    delete sandbox.dshCancelActive;

    console.log(
      "\n" +
        (fails
          ? "FAILED " + fails + " / " + checks + " checks"
          : "ALL OK  " + checks + " checks"),
    );
  })();
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-team-view.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-team-view.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-team-round.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-team-round.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) =>
    fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

  /* 最小 DOM 桩：只有 renderTeamPane / teamViewRenderMsgs 会用到 getElementById，
     全部返回 null 让它们快速返回；createElement 给 teamViewEl 用。 */
  function fakeEl(tag) {
    const cls = new Set();
    const e = {
      tagName: tag,
      className: "",
      textContent: "",
      style: {},
      children: [],
      options: [],
      value: "",
      _html: "",
      _ev: {},
      hidden: false,
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      setAttribute() {},
      removeAttribute() {},
      addEventListener(t, fn) {
        (this._ev[t] || (this._ev[t] = [])).push(fn);
      },
      removeEventListener() {},
      classList: {
        contains: (c) => cls.has(c),
        add(c) {
          cls.add(c);
        },
        remove(c) {
          cls.delete(c);
        },
        toggle(c, on) {
          const v = on === undefined ? !cls.has(c) : !!on;
          if (v) cls.add(c);
          else cls.delete(c);
          return v;
        },
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      insertBefore(c) {
        this.children.unshift(c);
        return c;
      },
    };
    Object.defineProperty(e, "innerHTML", {
      get() {
        return this._html;
      },
      set(v) {
        this._html = String(v);
        this.children.length = 0;
      },
    });
    return e;
  }

  /* ═══════════ 沙箱：icons → team（真）→ teamview（真），窗口即全局 ═══════════ */
  function loadAll() {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.console = console;
    sandbox.I18n = {
      t: (s, vars) => {
        let out = String(s);
        if (vars && typeof vars === "object")
          out = out.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
        return out;
      },
    };
    const els = {};
    sandbox.document = {
      createElement: (t) => fakeEl(t),
      getElementById: (id) => els[id] || null,
    };
    sandbox.__testEls = els;
    sandbox.api = { configSave: () => Promise.resolve() };
    sandbox.toast = () => {};
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    sandbox.cancelAnimationFrame = (id) => clearTimeout(id);
    sandbox.AGENT_PRESETS = ["minimal", "standard", "lean", "code", "cordis"].map((id) => ({ id }));
    sandbox.AGENT_PRESET_DEFAULT = "minimal";
    sandbox.AGENT_PRESET_LEGACY_IDS = {};
    sandbox.normalizeAgentEffort = (v) => {
      const s = String(v == null ? "" : v).trim();
      return ["low", "medium", "high", "xhigh", "max"].indexOf(s) >= 0 ? s : "high";
    };
    sandbox.permissionPresetOptions = () =>
      ["mtnode-unattended", "workspace-write", "read-only", "danger-full-access"].map((id) => [id, id]);
    const S = { config: {}, wf: { id: "wf-round", name: "圆桌画布" } };
    sandbox.S = S;
    vm.createContext(sandbox);
    vm.runInContext(read("renderer/app-team-icons.js"), sandbox, { filename: "app-team-icons.js" });
    vm.runInContext(read("renderer/app-team.js"), sandbox, { filename: "app-team.js" });
    vm.runInContext(read("renderer/app-teamview.js"), sandbox, { filename: "app-teamview.js" });
    return { sandbox, S, team: sandbox.MTNodeTeam };
  }

  let env = null;
  let loadErr = null;
  try {
    env = loadAll();
  } catch (e) {
    loadErr = e;
  }
  ok(!loadErr, "app-team.js + app-teamview.js 顶层加载不抛错" + (loadErr ? "（" + loadErr.message + "）" : ""));
  const { sandbox, S, team: T } = env || {};
  ok(!!T && typeof T.runGroupRound === "function", "暴露 window.MTNodeTeam.runGroupRound");
  ok(typeof sandbox.teamGroupRun === "function", "暴露 window.teamGroupRun（团队视图群聊入口）");

  T.ensure(S.config);
  const CANVAS = "wf-round";
  T.ensureCanvas({ id: CANVAS, name: "圆桌画布" });

  /* 四位候选专家：主持人 + 财务（与「现金流 / 预算」问题相关）+ 工程 + 设计。 */
  const E1 = T.addExpert({ canvasId: CANVAS, name: "甲", role: "主持人", icon: "cat", persona: { expertise: ["主持", "议程"] } });
  const E2 = T.addExpert({ canvasId: CANVAS, name: "乙", role: "财务", icon: "cat", persona: { expertise: ["现金流", "预算"] } });
  const E3 = T.addExpert({ canvasId: CANVAS, name: "丙", role: "工程", icon: "cat", persona: { expertise: ["架构", "稳定性"] } });
  const E4 = T.addExpert({ canvasId: CANVAS, name: "丁", role: "设计", icon: "cat", persona: { expertise: ["界面", "可用性"] } });
  const FOUR = [E1, E2, E3, E4];

  function groupOf(exps, facId) {
    return T.addGroupChat({
      canvasId: CANVAS,
      participants: exps.map((e) => e.id),
      facilitatorId: facId || (exps[0] && exps[0].id) || "",
      title: "圆桌讨论",
    });
  }
  const idsOf = (list) => (list || []).map((e) => e.id);

  async function waitFor(cond, ms = 2000) {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("waitFor 超时");
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /* ===================== [1] 选人上限与「不全员」约束 ===================== */
  console.log("\n[1] 选人上限与「不全员」约束（clampParticipants / 常量）");
  {
    ok(T.GROUP_MIN_PARTICIPANTS === 2, "最少参与人 = 2");
    ok(T.GROUP_MAX_PARTICIPANTS === 6, "最多参与人 = 6");

    const allIds = idsOf(FOUR);
    const all = T.clampParticipants(FOUR, allIds, "随便问点什么");
    ok(all.length < FOUR.length, "候选 4 位、点名全员 → 至少排除 1 位（不全员）");
    ok(all.length <= T.GROUP_MAX_PARTICIPANTS, "结果不超过上限 6 位");
    ok(idsOf(all).every((id) => allIds.indexOf(id) >= 0), "结果全部来自候选");
    ok(
      idsOf(all).every((id, i, a) => i === 0 || allIds.indexOf(a[i - 1]) < allIds.indexOf(id)),
      "输出顺序 = 候选原始顺序",
    );

    const one = T.clampParticipants(FOUR, [E1.id], "随便问点什么");
    ok(one.length === T.GROUP_MIN_PARTICIPANTS, "只点名 1 位 → 补齐到下限 2 位");

    const dup = T.clampParticipants(FOUR, [E1.id, E1.id, "不存在的 id"], "随便问点什么");
    ok(idsOf(dup).length === new Set(idsOf(dup)).size, "重复 id 去重");
    ok(idsOf(dup).every((id) => allIds.indexOf(id) >= 0), "未知 id 被忽略");

    const eight = FOUR.concat([
      T.addExpert({ canvasId: CANVAS, name: "戊", role: "法务", icon: "cat" }),
      T.addExpert({ canvasId: CANVAS, name: "己", role: "运维", icon: "cat" }),
      T.addExpert({ canvasId: CANVAS, name: "庚", role: "增长", icon: "cat" }),
      T.addExpert({ canvasId: CANVAS, name: "辛", role: "内容", icon: "cat" }),
    ]);
    const capped = T.clampParticipants(eight, idsOf(eight), "随便问点什么");
    ok(capped.length === T.GROUP_MAX_PARTICIPANTS, "8 位候选点名全员 → 夹到上限 6 位");
    ok(capped.length < eight.length, "8 位候选仍不全员");

    ok(T.clampParticipants([], [], "x").length === 0, "空候选返回空");

    const three = [E1, E2, E3];
    ok(
      T.clampParticipants(three, idsOf(three), "x").length === 2,
      "候选恰好 3 位点名全员 → 只留 2 位",
    );
  }

  /* ===================== [2] 专家数 < 3 的兜底 ===================== */
  console.log("\n[2] 专家数 < 3：没有可裁余地，全部参与且不跑主持人选人");
  (async function () {
    /* 只放 2 位专家的画布：候选不足 3 位 → 无裁量空间。 */
    const TWO = "wf-two";
    T.addExpert({ canvasId: TWO, name: "双甲", role: "主持人", icon: "cat" });
    const b2 = T.addExpert({ canvasId: TWO, name: "双乙", role: "工程", icon: "cat" });
    const chat2 = T.addGroupChat({ canvasId: TWO, participants: [], title: "圆桌讨论" });
    let runCalls = 0;
    sandbox.dshRunTask = () => {
      runCalls++;
      return Promise.resolve("不该被调用");
    };
    const sel2 = await T.selectParticipants(chat2, "帮我看看架构");
    ok(sel2.participants.length === 2, "2 位专家全部参与（候选不足 3 位兜底）");
    ok(sel2.mode === "local", "兜底走本地口径（mode=local）");
    ok(runCalls === 0, "候选不足 3 位不发起主持人选人 run");
    ok(!!sel2.reason, "兜底给出一句理由");
    void b2;

    const ONE = "wf-one";
    T.addExpert({ canvasId: ONE, name: "独苗", role: "主持人", icon: "cat" });
    const chat1 = T.addGroupChat({ canvasId: ONE, participants: [], title: "圆桌讨论" });
    const sel1 = await T.selectParticipants(chat1, "随便问");
    ok(sel1.participants.length === 1, "只有 1 位专家时也全部参与（最小可运行）");
    delete sandbox.dshRunTask;

    /* ===================== [3] @提及只唤起被 @ 者 ===================== */
    console.log("\n[3] @提及只唤起被 @ 者（跳过选人，不受 2–6 人数约束）");
    const chat = groupOf(FOUR, E1.id);
    const mentions = T.parseMentions("@乙 你怎么看这件事？", chat);
    ok(mentions.length === 1 && mentions[0] === E2.id, "parseMentions 只命中被 @ 的专家");

    let selRunCalls = 0;
    sandbox.dshRunTask = () => {
      selRunCalls++;
      return Promise.resolve("不该被调用");
    };
    const selM = await T.selectParticipants(chat, "@乙 你怎么看这件事？");
    ok(selM.mode === "mention", "@ 命中时 mode=mention（跳过主持人选人）");
    ok(selM.participants.length === 1 && selM.participants[0].id === E2.id, "只由被 @ 的专家参与");
    ok(selRunCalls === 0, "@ 定向不发起主持人选人 run");
    delete sandbox.dshRunTask;

    /* ===================== [4] 选人 JSON：成功走 host / 失败走本地 ===================== */
    console.log("\n[4] 选人 JSON：解析成功走 host；解析失败走本地相关性回退");
    const Q = "现金流 预算 的风险怎么看？";

    sandbox.dshRunTask = () =>
      Promise.resolve('```json\n{"participants":["乙","丙"],"reason":"现金流与落地各一位"}\n```');
    const selH = await T.selectParticipants(chat, Q);
    ok(selH.mode === "host", "合法选人 JSON → mode=host");
    ok(
      selH.ids.length === 2 && selH.ids[0] === E2.id && selH.ids[1] === E3.id,
      "按姓名逐字命中并落成专家 id（保候选顺序）",
    );
    ok(selH.reason.indexOf("现金流") >= 0, "主持人理由透传");

    sandbox.dshRunTask = () => Promise.resolve("抱歉，我不确定该让谁发言。");
    const selL = await T.selectParticipants(chat, Q);
    ok(selL.mode === "local", "选人 JSON 解析失败 → mode=local 回退");
    ok(selL.participants.length < FOUR.length, "本地回退同样不全员");
    ok(selL.participants.length >= T.GROUP_MIN_PARTICIPANTS, "本地回退不低于下限 2 位");
    ok(
      selL.ids.indexOf(E2.id) >= 0,
      "本地相关性打分把与问题相关的专家（乙 / 现金流）排进本轮",
    );
    ok(selL.reason.indexOf("相关性") >= 0, "本地回退理由说明按相关性选人");

    sandbox.dshRunTask = () =>
      Promise.resolve('{"participants":["没有这个人"],"reason":"x"}');
    const selNone = await T.selectParticipants(chat, Q);
    ok(selNone.mode === "local", "选人 JSON 里没有任何命中姓名 → 视为失败，走本地回退");
    delete sandbox.dshRunTask;

    /* ===================== [5] 并行性 ===================== */
    console.log("\n[5] 并行性：多位专家同时 in-flight，结果按参与者顺序回收");
    const chatP = groupOf(FOUR, E1.id);
    let inflight = 0;
    let maxInflight = 0;
    let peak = 0;
    const gates = {};
    sandbox.dshRunTask = (input, opts) => {
      const expId = String((opts && opts.runKey) || "").split(":")[2];
      inflight++;
      peak++;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise((resolve) => {
        gates[expId] = () => {
          inflight--;
          resolve("回复-" + expId);
        };
      });
    };
    const orderOnMsg = [];
    const roundP = T.runGroupRound({
      chat: chatP,
      text: "@乙 @丙 请各自表态",
      round: 1,
      onMessage: (m) => orderOnMsg.push(m.expertId),
    });
    await waitFor(() => Object.keys(gates).length === 2);
    ok(maxInflight === 2, "两位专家的 run 同时处于 in-flight（并行，非串行）");
    ok(peak === 2, "本轮只起跑本轮参与者（2 位）");
    /* 后起的先完成：验证回收顺序不跟着完成快慢漂。 */
    gates[E3.id]();
    await new Promise((r) => setTimeout(r, 0));
    gates[E2.id]();
    const resP = await roundP;
    ok(
      resP.messages.length === 2 && resP.messages[0].expertId === E2.id && resP.messages[1].expertId === E3.id,
      "结果按参与者顺序回收（乙 → 丙，尽管丙先完成）",
    );
    ok(resP.messages[0].content === "回复-" + E2.id && resP.messages[1].content === "回复-" + E3.id, "每路内容正确对应各自的 run");
    ok(
      orderOnMsg.length === 2 && orderOnMsg[0] === E3.id && orderOnMsg[1] === E2.id,
      "onMessage 按完成顺序回调（丙先完成先回），与落库顺序解耦",
    );
    const lp = T.lastRoundOf(T.chat(chatP.id));
    ok(!!lp && lp.mode === "mention" && lp.ids.length === 2, "本轮参与人与选人理由落库（lastParticipants）");
    ok(lp.ids[0] === E2.id && lp.ids[1] === E3.id, "落库顺序 = 参与人顺序");
    delete sandbox.dshRunTask;

    /* ===================== [6] 单个专家失败不影响其余 ===================== */
    console.log("\n[6] 单个专家失败只写进他这条消息，不影响其余");
    const chatF = groupOf(FOUR, E1.id);
    sandbox.dshRunTask = (input, opts) => {
      const expId = String((opts && opts.runKey) || "").split(":")[2];
      if (expId === E2.id) return Promise.reject(new Error("乙这边炸了"));
      return Promise.resolve("丙的正常回复");
    };
    let threw = false;
    let resF = null;
    try {
      resF = await T.runGroupRound({ chat: chatF, text: "@乙 @丙 请各自表态", round: 1 });
    } catch (e) {
      threw = true;
    }
    ok(!threw, "单个专家失败不拖垮整轮（runGroupRound 不抛错）");
    ok(!!resF && resF.messages.length === 2, "另一位专家的结果照常回收（2 条）");
    const mFail = resF.messages.find((m) => m.expertId === E2.id);
    const mOk = resF.messages.find((m) => m.expertId === E3.id);
    ok(!!mFail && !!mFail.error && mFail.content === "", "失败者的消息带 error、content 为空");
    ok(!!mOk && mOk.content === "丙的正常回复" && !mOk.error, "未失败者内容完整、无 error");
    delete sandbox.dshRunTask;

    /* ===================== [7] 终止一次取消本轮全部 runKey ===================== */
    console.log("\n[7] 终止一次取消本轮全部 runKey");
    const chatS = groupOf(FOUR, E1.id);
    const gates2 = {};
    sandbox.dshRunTask = (input, opts) => {
      const expId = String((opts && opts.runKey) || "").split(":")[2];
      return new Promise((resolve) => {
        gates2[expId] = () => resolve("回复-" + expId);
      });
    };
    const roundS = T.runGroupRound({ chat: chatS, text: "@乙 @丙 请各自表态", round: 1 });
    await waitFor(() => Object.keys(gates2).length === 2);
    const active = T.activeRunKeys(chatS.id);
    ok(active.length === 2, "本轮有 2 路在跑的 runKey");
    ok(
      active.indexOf(T.runKeyOf(chatS.id, E2.id)) >= 0 && active.indexOf(T.runKeyOf(chatS.id, E3.id)) >= 0,
      "runKey = team:<chatId>:<expertId>，按专家隔离",
    );
    const cancelled = [];
    sandbox.dshCancelActive = (k) => cancelled.push(k);
    T.stopExpert("team:" + chatS.id);
    ok(cancelled.length === 2, "终止会话级 runKey → 一次取消本轮全部在跑的 runKey");
    ok(cancelled.indexOf(T.runKeyOf(chatS.id, E2.id)) >= 0 && cancelled.indexOf(T.runKeyOf(chatS.id, E3.id)) >= 0, "两位专家都被取消（不再只停第一位）");
    const resolved = T.resolveRunKey("team:" + chatS.id);
    ok(active.indexOf(resolved) >= 0, "resolveRunKey 能反查该会话正在跑的 runKey");
    /* 放行未决 run，收尾不留下悬挂 Promise。 */
    Object.keys(gates2).forEach((k) => gates2[k]());
    await roundS;
    ok(T.activeRunKeys(chatS.id).length === 0, "本轮结束后在跑集合清空");
    delete sandbox.dshRunTask;
    delete sandbox.dshCancelActive;

    /* ===================== [8] 一轮结束自动触发主持人汇总 ===================== */
    console.log("\n[8] 一轮结束后自动请主持人汇总（无发言 / 用户终止则不汇总）");
    const TEAM = sandbox.MTNodeTeam;
    const realRunGroup = TEAM.runGroupRound;
    const realAggregate = TEAM.aggregateGroup;
    const realWriteAdvice = TEAM.writeAdviceFile;
    let aggCalls = 0;
    let rgArgs = null;
    let nextRound = null;
    TEAM.runGroupRound = async (o) => {
      rgArgs = o;
      return nextRound;
    };
    TEAM.aggregateGroup = async () => {
      aggCalls++;
      return { card: { title: "x", conclusion: "c" }, text: "card", facilitator: { id: E1.id, name: "甲" } };
    };
    TEAM.writeAdviceFile = async () => "";

    const chatA = groupOf(FOUR, E1.id);
    nextRound = {
      round: 1,
      participants: [E2.id, E3.id],
      messages: [
        { role: "assistant", content: "乙的发言", expertId: E2.id, name: "乙" },
        { role: "assistant", content: "丙的发言", expertId: E3.id, name: "丙" },
      ],
    };
    await sandbox.teamGroupRun(chatA, "请讨论现金流的风险");
    ok(aggCalls === 1, "一轮有发言结束 → 自动触发主持人汇总（aggregateGroup 调 1 次）");
    ok(!!rgArgs && rgArgs.chat && rgArgs.chat.id === chatA.id, "先跑本轮（runGroupRound 收到本会话）");
    ok(!!rgArgs && rgArgs.round === 1, "轮次 1 传入");
    ok(
      !!rgArgs && typeof rgArgs.onEvent === "function" && typeof rgArgs.shouldStop === "function",
      "传入 onEvent（并行分路）与 shouldStop（终止检查）",
    );
    const msgsA = (T.chat(chatA.id) || {}).messages || [];
    ok(msgsA.length >= 3, "本轮署名发言 + 建议卡落回会话消息流");

    /* 全员失败（无任何 content）：不汇总。 */
    const chatB = groupOf(FOUR, E1.id);
    aggCalls = 0;
    nextRound = {
      round: 1,
      messages: [
        { role: "assistant", content: "", expertId: E2.id, error: "boom" },
        { role: "assistant", content: "", expertId: E3.id, error: "boom" },
      ],
    };
    await sandbox.teamGroupRun(chatB, "全员失败的一轮");
    ok(aggCalls === 0, "全员失败（无发言）→ 不汇总");

    /* 用户中途终止：即使专家已产出，也不汇总。 */
    const chatC = groupOf(FOUR, E1.id);
    aggCalls = 0;
    TEAM.runGroupRound = async (o) => {
      rgArgs = o;
      const live = sandbox.teamLiveOf(o.chat.id);
      if (live) live.stopped = true;
      return { round: 1, messages: [{ role: "assistant", content: "被打断的发言", expertId: E2.id }] };
    };
    await sandbox.teamGroupRun(chatC, "跑一半被终止");
    ok(aggCalls === 0, "用户终止本轮 → 不自动汇总");

    TEAM.runGroupRound = realRunGroup;
    TEAM.aggregateGroup = realAggregate;
    TEAM.writeAdviceFile = realWriteAdvice;

    console.log(
      "\n" +
        (fails
          ? "FAILED " + fails + " / " + checks + " checks"
          : "ALL OK  " + checks + " checks"),
    );
  })();

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-team-round.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-team-round.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-team-i18n.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-team-i18n.js";
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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) =>
    fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

  const I18n = require("../renderer/i18n.js");
  /* app-team-icons.js 的 T() 读 window.I18n —— 给它一个 window 才能加载。 */
  global.window = global.window || global;
  require("../renderer/app-team-icons.js");
  const ICONS = global.window.MTNodeTeamIcons;

  const TEAM_FILES = [
    "renderer/app-team.js",
    "renderer/app-teamview.js",
    "renderer/app-team-recruit.js",
    "renderer/app-team-icons.js",
  ];

  /* 抠出所有 T("…") / teamViewT("…") 的单行字面量（与 i18n 词表键一一对应）。 */
  function teamKeys() {
    const set = new Set();
    const re = /\b(?:T|teamViewT)\(\s*(["'])((?:[^"'\\\n]|\\.)*?)\1\s*\)/g;
    for (const f of TEAM_FILES) {
      const src = read(f);
      let m;
      while ((m = re.exec(src))) set.add(m[2]);
    }
    return [...set].sort();
  }

  /* ===================== [1] 词条覆盖率 ===================== */
  console.log("\n[1] 词条覆盖率：四个脚本的 T()/teamViewT() 文案全部有英文译文");
  const KEYS = teamKeys();
  ok(KEYS.length >= 200, "抠到 " + KEYS.length + " 条团队文案（≥200）");

  const missing = [];
  I18n.setLocale("en");
  for (const k of KEYS) {
    const v = I18n.t(k);
    if (v === k || !/[A-Za-z]{2,}/.test(v)) missing.push(k);
  }
  ok(
    missing.length === 0,
    "英文界面无回落中文" +
      (missing.length
        ? "（缺 " + missing.length + " 条：" + missing.slice(0, 5).join(" / ") + "…）"
        : ""),
  );

  /* 中文界面必须原样显示（词表只做 zh → en 单向映射，不许把中文键也改掉）。 */
  I18n.setLocale("zh");
  let zhBroken = 0;
  for (const k of KEYS) if (I18n.t(k) !== k) zhBroken++;
  ok(zhBroken === 0, "中文界面原样显示全部 " + KEYS.length + " 条");
  I18n.setLocale("zh");

  /* ===================== [1b] 顶栏按钮与团队面板（index.html） ===================== */
  console.log("\n[1b] 顶栏按钮与团队面板（renderer/index.html）文案有英文译文");
  {
    const html = read("renderer/index.html");
    const btnAt = html.indexOf('id="btnTeam"');
    const btnEnd = btnAt >= 0 ? html.indexOf("</button>", btnAt) : -1;
    const paneAt = html.indexOf('id="teamPane"');
    const paneEnd = html.indexOf('class="assist-pane"');
    const region =
      btnAt >= 0 && btnEnd > btnAt && paneAt > btnEnd && paneEnd > paneAt
        ? html.slice(btnAt, btnEnd) + "\n" + html.slice(paneAt, paneEnd)
        : "";
    ok(region.length > 0, "定位到顶栏按钮 + 团队面板区段");
    const keys = new Set();
    const re = /data-i18n(?:-title|-placeholder)?="([^"]+)"/g;
    let m;
    while ((m = re.exec(region))) keys.add(m[1]);
    /* 顶部「＋ 新会话」按钮已移除（新建单聊改到左栏角色行的「＋」，文案由 JS 下发），
       面板里的 data-i18n 文案从 11 条降到 9 条。 */
    ok(keys.size >= 9, "抠到 " + keys.size + " 条界面文案");
    const miss = [];
    I18n.setLocale("en");
    for (const k of keys) {
      const v = I18n.t(k);
      if (v === k || !/[A-Za-z]{2,}/.test(v)) miss.push(k);
    }
    ok(miss.length === 0, "英文界面无回落中文" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
    I18n.setLocale("zh");
  }

  /* ===================== [2] 图标目录 ===================== */
  console.log("\n[2] 图标目录：标签 + 分组名全部有英文译文");
  ok(!!ICONS && typeof ICONS.keys === "function", "加载 app-team-icons.js（window.MTNodeTeamIcons）");
  const ICON_KEYS = ICONS.keys();
  ok(ICON_KEYS.length >= 48, "图标目录 " + ICON_KEYS.length + " 个（≥48 个空心线条 SVG）");
  I18n.setLocale("en");
  const iconMiss = ICON_KEYS.filter((k) => !/[A-Za-z]{2,}/.test(ICONS.label(k)));
  ok(
    iconMiss.length === 0,
    "图标标签英文界面无回落中文" + (iconMiss.length ? "（缺：" + iconMiss.join(" / ") + "）" : ""),
  );
  const grpMiss = ICONS.groups().filter((g) => !/[A-Za-z]{2,}/.test(g.label));
  ok(
    grpMiss.length === 0,
    "图标分组名英文界面无回落中文" + (grpMiss.length ? "（缺：" + grpMiss.map((g) => g.id).join(" / ") + "）" : ""),
  );
  ok(
    ICON_KEYS.every((k) => /fill="none"/.test(ICONS.svg(k)) && /stroke="currentColor"/.test(ICONS.svg(k))),
    "每个图标都是空心线条（fill:none + stroke:currentColor）",
  );
  I18n.setLocale("zh");

  /* ===================== [3] 模板名 / 岗位 ===================== */
  console.log("\n[3] 内置模板名与岗位全部有英文译文");
  {
    const src = read("renderer/app-team-recruit.js");
    const seg = src.slice(src.indexOf("var PRESET_SPECS"), src.indexOf("function buildPresets"));
    const names = [];
    const roles = [];
    let m;
    const rn = /\bname:\s*"([^"]+)"/g;
    while ((m = rn.exec(seg))) names.push(m[1]);
    const rr = /\brole:\s*"([^"]+)"/g;
    while ((m = rr.exec(seg))) roles.push(m[1]);
    ok(names.length === 39, "抠到 39 个模板名（" + names.length + "）");
    ok(roles.length === 39, "抠到 39 个岗位名（" + roles.length + "）");
    I18n.setLocale("en");
    const nm = names.filter((k) => {
      const v = I18n.t(k);
      return v === k || !/[A-Za-z]{2,}/.test(v);
    });
    const rm = [...new Set(roles)].filter((k) => {
      const v = I18n.t(k);
      return v === k || !/[A-Za-z]{2,}/.test(v);
    });
    ok(nm.length === 0, "模板名无回落中文" + (nm.length ? "（缺：" + nm.join(" / ") + "）" : ""));
    ok(rm.length === 0, "岗位名无回落中文" + (rm.length ? "（缺：" + rm.join(" / ") + "）" : ""));
    I18n.setLocale("zh");
  }

  /* ===================== [4] 关键 UI 词条 ===================== */
  console.log("\n[4] 关键 UI 词条：招聘 / 圆桌 / 采纳 / 权限 / 画布锚点 / 分类 / 模型 / 专家卡 / 编辑");
  const KEY_TERMS = [
    "招募专家",
    "手动招聘",
    "自动招聘",
    "开始招聘",
    "确认录用",
    "圆桌讨论",
    "收敛出建议",
    "采纳并生成待办",
    "采纳为决策记录",
    "仅存档",
    "审批档",
    "长度预算",
    "少数意见（原文保留）",
    "未收敛分歧",
    "待验证假设",
    /* 画布锚点 / 图标选择器 / 分类管理 */
    "【画布】",
    "选择图标",
    "按语义分组的图标网格",
    "分类管理",
    "管理分类",
    "已有同名分类",
    "新的分类名称（≤12 字）",
    "画布没有可用工作区，无法采纳",
    /* 本轮新增：AI团队改名 / 锚点移除 / 模型控制区 / 结构化专家卡 */
    "AI团队",
    "AI团队：按画布管理专家，与专家对话（专家团）",
    "移除团队",
    "移除该画布的团队（专家与会话一并删除）",
    "移除画布「",
    "」的团队？该画布下的专家与会话将一并删除。",
    "温度",
    "专家卡",
    "实时预览 · 专家卡",
    "专家卡渲染失败。",
    "（未填岗位）",
    "基本信息",
    "人设",
    "简介",
    "背景",
    "专长",
    "风格",
    "提示词",
    "身份",
    "约束",
    "图标",
    /* 本轮新增：标题=当前画布 / 增量复制到其他画布 */
    "团队：按画布管理专家，与专家对话（专家团）",
    "当前画布：",
    "复制团队到其他画布",
    "把当前画布的团队（专家、会话、招聘草稿）复制到另一张画布。仅增量复制：只追加，不删除、不覆盖目标画布已有内容；当前画布不受影响。",
    "目标画布",
    "正在读取画布列表…",
    "没有其他画布可复制。先新建一张画布再来。",
    "当前画布还没有可复制的团队内容",
    "已复制到「",
    " 位、会话 ",
    " 个会话",
    /* 本轮新增：切画布时的团队加载屏（防串线） */
    "正在切换画布…",
    /* 本轮新增：左栏事实库分组（库行打开文件夹 / 新建文档，文档行只显示更新时间） */
    "打开所在文件夹",
    "新建文档",
    "例如：产品规格",
    "已新建文档「{name}」",
    "未建库",
    "{n} 篇",
    "读取中…",
    "刚刚",
    " 分钟前",
    " 小时前",
    "由专家建档或手动新建",
    /* 本轮新增：专家卡可直接编辑设定与权限（复用招聘对话框编辑模式） */
    "✎ 可编辑设定与权限",
    "✎ 编辑",
    "编辑该专家的设定与权限",
    "编辑入口未就绪",
    "编辑专家",
    "保存修改",
    "已保存专家设定",
    "校验未通过，未保存修改",
  ];
  I18n.setLocale("en");
  for (const k of KEY_TERMS) {
    const v = I18n.t(k);
    ok(v !== k && /[A-Za-z]{2,}/.test(v), "「" + k + "」→「" + v + "」");
  }
  I18n.setLocale("zh");

  /* ===================== [5] 手册页 ===================== */
  console.log("\n[5] 应用内手册：AI团队页（中英）+ index.json 挂载");
  const ZH_DOC = "guides/manual/one-person-company.md";
  const EN_DOC = "guides/manual/en/one-person-company.md";
  ok(fs.existsSync(path.join(ROOT, ZH_DOC)), "存在中文手册页 " + ZH_DOC);
  ok(fs.existsSync(path.join(ROOT, EN_DOC)), "存在英文手册页 " + EN_DOC);
  const zhDoc = read(ZH_DOC);
  const enDoc = read(EN_DOC);
  ok(zhDoc.indexOf("招聘") >= 0 && zhDoc.indexOf("圆桌") >= 0, "中文页覆盖招聘与圆桌");
  ok(/Hire|Recruit/i.test(enDoc) && /Roundtable/i.test(enDoc), "英文页覆盖招聘与圆桌");
  ok(zhDoc.indexOf("画布锚点") >= 0 && zhDoc.indexOf("空心线条") >= 0, "中文页覆盖画布锚点与空心线条图标");
  ok(zhDoc.indexOf("管理分类") >= 0 && zhDoc.indexOf("39 个") >= 0, "中文页覆盖分类管理与 39 个模板");
  ok(/canvas anchor/i.test(enDoc) && /hollow-line/i.test(enDoc), "英文页覆盖 canvas anchor 与 hollow-line icons");
  ok(/Manage categories/i.test(enDoc) && /39/.test(enDoc), "英文页覆盖分类管理与 39 个模板");
  /* 口径：功能名 AI 团队、团队恒绑当前画布 / 增量复制 / 画布删除自动清理、温度、删除长度预算；
     本轮新增圆桌「按问题选人（不全员）→ 并行独立作答 → 主持人汇总」。 */
  ok(zhDoc.indexOf("AI 团队") >= 0, "中文页功能名改为 AI 团队");
  ok(zhDoc.indexOf("自动清理") >= 0, "中文页说明画布删除自动清理");
  ok(zhDoc.indexOf("增量复制") >= 0 && zhDoc.indexOf("不删除、不覆盖") >= 0, "中文页说明「增量复制 / 不删除、不覆盖」");
  ok(zhDoc.indexOf("当前画布名") >= 0, "中文页说明标题 = 当前画布名");
  ok(zhDoc.indexOf("温度") >= 0, "中文页覆盖温度");
  ok(zhDoc.indexOf("并行") >= 0 && zhDoc.indexOf("不全员") >= 0, "中文页覆盖圆桌选人（不全员）+ 并行作答");
  ok(zhDoc.indexOf("专家卡") >= 0, "中文页覆盖专家卡");
  ok(zhDoc.indexOf("长度预算") < 0, "中文页已删除「长度预算」描述");
  ok(/AI team/i.test(enDoc), "英文页功能名改为 AI team");
  ok(
    /pick participants by question/i.test(enDoc) && /in parallel/i.test(enDoc),
    "英文页覆盖圆桌选人（not the whole roster）+ 并行作答",
  );
  ok(/incrementally copies/i.test(enDoc) && /cleaned up automatically/i.test(enDoc), "英文页说明增量复制 / 画布删除自动清理");
  ok(/current canvas name/i.test(enDoc), "英文页说明标题 = current canvas name");
  ok(/temperature/i.test(enDoc) && /(read-only )?expert card/i.test(enDoc), "英文页覆盖温度与专家卡（可编辑口径）");
  ok(!/length budget/i.test(enDoc), "英文页已删除 length budget 描述");
  const idx = JSON.parse(read("guides/manual/index.json"));
  const flat = [];
  for (const s of idx.sections || [])
    for (const p of s.pages || []) flat.push(p);
  const page = flat.find((p) => p && p.id === "one-person-company");
  ok(!!page, "index.json 挂载 id = one-person-company");
  if (page) {
    ok(page.title && page.title.zh && page.title.en, "目录标题中英双语齐全");
    ok(
      page.title.zh === "AI 团队与多角色" && page.title.en === "AI team & roles",
      "目录标题同步为 AI 团队与多角色 / AI team & roles",
    );
  }

  /* ===================== [6] 打包白名单 ===================== */
  console.log("\n[6] 打包白名单：renderer/** 已覆盖（无新主进程模块）");
  /* build.json 是 JSONC（带注释），不做 JSON.parse，按文本核对白名单。 */
  const build = read("build.json");
  ok(
    /"renderer\/\*\*"/.test(build),
    "build.json files 含 renderer/**（四个团队脚本随渲染层打包）",
  );
  for (const mod of ["app-team.js", "app-teamview.js", "app-team-recruit.js", "app-team-icons.js"]) {
    ok(fs.existsSync(path.join(ROOT, "renderer", mod)), "renderer/" + mod + " 存在");
  }
  ok(
    !fs.existsSync(path.join(ROOT, "team-store.js")) &&
      !fs.existsSync(path.join(ROOT, "consultation-engine.js")),
    "未新增根目录主进程模块（无需扩 build.json files 白名单）",
  );

  /* index.html 脚本加载顺序 = 模块分层：icons → team → recruit → teamview。 */
  const html = read("renderer/index.html");
  const order = ["app-team-icons.js", "app-team.js", "app-team-recruit.js", "app-teamview.js"].map(
    (m) => html.indexOf('src="' + m + '"'),
  );
  ok(
    order.every((i) => i >= 0) && order.every((i, n) => n === 0 || i > order[n - 1]),
    "index.html 脚本顺序：icons → team → recruit → teamview",
  );

  console.log(
    "\n" +
      (fails
        ? "FAILED " + fails + " / " + checks + " checks"
        : "ALL OK  " + checks + " checks"),
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-team-i18n.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-team-i18n.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

"use strict";
/* 一人公司 / 专家团 —— 团队视图（app-teamview.js） —— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-team-view.js
 * 需求：团队视图能加载不抛错（曾因裸 str 调用崩溃）；头像为空心线条 SVG、底色用主题色、
 *       专家色只落在描边；选择键由 projectId 迁移到 canvasId；左栏是画布锚点列表。
 * 覆盖：
 *   [1] 顶层加载不抛错 + 本文件自带 str（不再引用其它模块的局部函数）
 *   [2] 关键渲染函数调用不抛 ReferenceError（裸 str 回归）
 *   [3] 头像：team-avatar + 空心线条 SVG（stroke=currentColor）+ 专家色落在描边上
 *   [4] 选择键迁移：S.config.teamView.projectId → canvasId
 *   [5] 团队恒绑定当前画布：ensure 强制当前画布 + 标题 = 当前画布名
 *   [6] 分类下拉选项：未分类 + 已有分类 + 未知当前值 + 新建哨兵
 *   [7] 标题使用当前画布（不再写死 AI团队）+ 复制按钮 + 删除入口已移除
 *   [8] 进视图剪枝带 typeof 守卫；专家卡折叠区默认收起、群聊隐藏；展开态折叠头「✎ 编辑」入口
 *       （调 teamRecruitEdit、点击不切换折叠、模块缺失时 warn 不抛错）
 *   [9] copyCanvas 增量复制：只追加 / 不覆盖目标已有内容 / 会话重指向新专家
 *  [10] 切画布：立即换团队 + 加载屏防串线
 *  [11] 左栏角色行：顶部「＋ 新会话」已移除 → 每行右侧一个「＋」开单聊 / 空分类不显示 / 角色行不显示模型 /
 *       事实库分组（库行：打开文件夹 + 新建文档 + ✕ 删除事实库；文档子行：更新时间文案 + ✕ 删除该文档；
 *       删除按钮与会话行同款 .team-side-act danger，点击弹确认框后进系统回收站）
 *  [12] 删除专家保留会话 + 删除会话 + 孤儿会话标记
 *  [13] 团队文案占位符替换：teamViewT(s, vars) → I18n.t，删除专家确认框点名专家名（不再显示 {name}）
 *  [14] 并发对话：运行态按会话隔离（teamLives），一条会话在跑不挡另一条；终止只停当前会话
 */
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
  process.exit(fails ? 1 : 0);
})();
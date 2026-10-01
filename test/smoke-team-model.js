"use strict";
/* 一人公司 / 专家团 —— 数据模型与配置存储 —— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-team-model.js
 * 需求：专家（Expert）结构、缺省合并与 v1→v2 迁移（画布锚点 + 图标键）、运行接线
 *       （人设 / 模型 / 权限）参数正确，并且团队脚本绝不使用 hostPersona。
 * 覆盖：
 *   [1] 缺省初始化与迁移幂等（S.config.team，version 2）
 *   [2] v1 → v2 迁移：projects → canvases，专家 / 会话一个不丢；emoji glyph → icon 键
 *   [3] Expert schema 归一化（canvasId / icon / category / persona / prompt / model / perm）
 *   [4] 深合并更新（只改一个键不重置同组其它字段）+ 级联删除
 *   [5] 默认工具许可（读 / 写文件 / 联网 / 反问放行，命令询问，画布与应用类拒绝）
 *   [6] 分类：默认 8 个 + 新建（重名去重）+ 删除（专家回未分类，不删人）
 *   [7] 运行接线：runKey / 四段式 systemPrompt / 模型与权限参数 / 不碰 hostPersona
 *   [8] 温度：0–2 归一（缺省 0.7 / 越界夹取 / 非法回落）+ 深合并单键不重置同组
 *   [9] pruneCanvases：拿不到画布列表绝不删；缺画布级联删专家 / 会话；幂等
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

/* ═══════════ 沙箱：app-team-icons.js + app-team.js（无 DOM 依赖） ═══════════ */
function loadTeam() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.api = { configSave: () => Promise.resolve() };
  /* 同层脚本的真实全局（app-nodes.js / app-settings.js 在应用里提供）：
     不注入会让 effort / preset / 审批档全部回落到兜底值，测不到「按专家配置生效」。 */
  sandbox.AGENT_PRESETS = ["minimal", "standard", "lean", "code", "cordis"].map((id) => ({ id }));
  sandbox.AGENT_PRESET_DEFAULT = "minimal";
  sandbox.AGENT_PRESET_LEGACY_IDS = {};
  sandbox.normalizeAgentEffort = (v) => {
    const s = String(v == null ? "" : v).trim();
    return ["low", "medium", "high", "xhigh", "max"].indexOf(s) >= 0 ? s : "high";
  };
  sandbox.permissionPresetOptions = () =>
    ["mtnode-unattended", "workspace-write", "read-only", "danger-full-access"].map((id) => [id, id]);
  /* 画布锚点：currentCanvasId() 读 S.wf.id（currentVisibleWfId 未定义时的兜底）。 */
  const S = { config: {}, wf: { id: "wf-1", name: "画布 A" } };
  sandbox.S = S;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-team-icons.js"), sandbox, {
    filename: "app-team-icons.js",
  });
  vm.runInContext(read("renderer/app-team.js"), sandbox, { filename: "app-team.js" });
  return { sandbox, S, team: sandbox.MTNodeTeam, icons: sandbox.MTNodeTeamIcons };
}

const { sandbox, S, team: T, icons: IC } = loadTeam();
ok(!!T && typeof T.addExpert === "function", "app-team.js 暴露 window.MTNodeTeam");
ok(!!IC && typeof IC.svg === "function", "app-team-icons.js 暴露 window.MTNodeTeamIcons");

/* ===================== [1] 缺省初始化与迁移 ===================== */
console.log("\n[1] 缺省初始化与迁移幂等（S.config.team）");
{
  const cfg = {};
  const t1 = T.ensure(cfg);
  ok(!!t1 && t1.version === 4, "空配置 ensure 出 version 4");
  ok(
    Array.isArray(t1.canvases) &&
      Array.isArray(t1.experts) &&
      Array.isArray(t1.chats) &&
      Array.isArray(t1.recruitDrafts) &&
      Array.isArray(t1.categories) &&
      Array.isArray(t1.templates),
    "六个集合缺省为空数组 / 默认分类",
  );
  ok(t1.projects === undefined, "不再有 projects 字段（已改名 canvases）");
  const snap = JSON.stringify(cfg.team);
  T.ensure(cfg);
  ok(JSON.stringify(cfg.team) === snap, "二次 ensure 内容不变（幂等）");

  const broken = { team: { version: 0, canvases: null, experts: "x" } };
  const t2 = T.ensure(broken);
  ok(t2.version === 4, "版本 0 迁移到 4");
  ok(Array.isArray(t2.canvases) && Array.isArray(t2.experts), "非数组字段归一为空数组");

  const noTeam = {};
  T.ensure(noTeam);
  ok(!!noTeam.team && noTeam.team.version === 4, "缺 team 键时自动补建");

  /* 默认分类：首次初始化预置 8 个；用户删空后（categories:[]）不再自动补回。 */
  ok(
    t1.categories.length === 8 && t1.categories.every((c) => c.id && c.name),
    "默认预置 8 个分类",
  );
  const emptied = { team: { version: 2, categories: [] } };
  ok(T.ensure(emptied).categories.length === 0, "categories: [] 视为用户删空，不自动补回");

  /* v2 → v3：存量专家写文件许可从旧默认「询问」抬到「允许」；显式 deny 不动。 */
  const oldPerm = {
    team: {
      version: 2,
      experts: [
        { id: "e-ask", perm: { toolAllow: { fs_write: "ask" } } },
        { id: "e-deny", perm: { toolAllow: { fs_write: "deny" } } },
      ],
    },
  };
  const t3 = T.ensure(oldPerm);
  ok(t3.experts[0].perm.toolAllow.fs_write === "allow", "旧默认 ask → allow（专家默认可读写事实库）");
  ok(t3.experts[1].perm.toolAllow.fs_write === "deny", "用户显式 deny 保持不动");

  /* v3 → v4：画布 / 应用操作的旧默认「拒绝」抬到「读画布放行、改画布与应用操作询问」，
     专家才能查看与核验画布；删除画布 / 插件 / 识图等仍拒绝的键不动。 */
  const oldCanvas = {
    team: {
      version: 3,
      experts: [
        {
          id: "e-canvas",
          perm: {
            toolAllow: {
              canvas_read: "deny",
              canvas_draw: "deny",
              canvas_layout: "deny",
              app_ops: "deny",
              app_delete: "deny",
              vision: "deny",
              web: "deny",
            },
          },
        },
      ],
    },
  };
  const t4 = T.ensure(oldCanvas);
  const ta4 = t4.experts[0].perm.toolAllow;
  ok(t4.version === 4, "版本升到 4");
  ok(ta4.canvas_read === "allow", "旧默认「读画布 deny」→ allow（专家能核验画布）");
  ok(ta4.canvas_draw === "ask" && ta4.canvas_layout === "ask", "旧默认「绘图 / 排版 deny」→ ask");
  ok(ta4.app_ops === "ask", "旧默认「应用操作 deny」→ ask");
  ok(ta4.app_delete === "deny" && ta4.vision === "deny", "仍拒绝的键（删除画布 / 识图）不动");
  ok(ta4.web === "deny", "用户显式改过的非默认值不动");
}

/* ===================== [2] v1 → v3 迁移 ===================== */
console.log("\n[2] v1 → v3 迁移：projects → canvases，专家 / 会话不丢，emoji → icon");
{
  const cfg = {
    team: {
      version: 1,
      projects: [{ id: "p1", name: "旧项目", workspace: "E:/ws/old" }],
      experts: [
        { id: "e1", projectId: "p1", name: "旧专家", glyph: "🧭", color: "#6db4ff" },
        { id: "e2", projectId: "p1", name: "无头像专家" },
      ],
      chats: [{ id: "c1", projectId: "p1", expertId: "e1", title: "旧会话" }],
      recruitDrafts: [{ id: "d1", projectId: "p1", name: "旧草稿" }],
    },
  };
  const t = T.ensure(cfg);
  ok(t.version === 4, "版本升到 4");
  ok(t.canvases.length === 1 && t.canvases[0].id === "p1", "旧项目转成画布锚点（id 原样）");
  ok(t.canvases[0].name === "旧项目", "锚点名沿用旧项目名");
  ok(t.canvases[0].workspace === "E:/ws/old", "锚点工作区保留");
  ok(t.experts.length === 2, "两位专家全部保留");
  ok(t.experts[0].canvasId === "p1" && t.experts[1].canvasId === "p1", "专家 projectId → canvasId");
  ok(t.experts[0].icon === "compass", "emoji 🧭 迁移为图标键 compass");
  ok(!!t.experts[1].icon && IC.keys().indexOf(t.experts[1].icon) >= 0, "无头像专家补到合法图标键");
  ok(t.chats.length === 1 && t.chats[0].canvasId === "p1", "会话 projectId → canvasId（不丢）");
  ok(t.recruitDrafts.length === 1 && t.recruitDrafts[0].canvasId === "p1", "草稿 projectId → canvasId");
  const snap = JSON.stringify(cfg.team);
  T.ensure(cfg);
  ok(JSON.stringify(cfg.team) === snap, "迁移幂等（二次 ensure 不再变）");
}

/* ===================== [3] Expert schema 归一化 ===================== */
console.log("\n[3] Expert schema 归一化");
let expert = null;
{
  const c = T.ensureCanvas();
  ok(!!c && c.id === "wf-1" && c.name === "画布 A", "ensureCanvas 按当前画布建锚点");
  ok(T.currentCanvasId() === "wf-1" && T.currentCanvasName() === "画布 A", "currentCanvasId / Name 读当前画布");
  ok(T.canvases()[0].id === "wf-1", "canvases() 含新建锚点");

  expert = T.addExpert({
    canvasId: c.id,
    name: "财务顾问",
    icon: "coin",
    category: "商业",
    role: "财务 / 现金流",
    persona: { tagline: "盯现金流", expertise: ["现金流", "盈亏平衡"] },
    prompt: { identity: "你是财务顾问", goal: "给出可执行建议", constraints: "不碰法务", output: "条目式" },
    customField: "keep-me",
  });
  ok(!!expert && /^exp/.test(expert.id), "缺省生成 exp* 主键");
  ok(expert.canvasId === c.id && expert.projectId === c.id, "canvasId 正确挂载（projectId 读兼容镜像）");
  ok(expert.icon === "coin", "icon 图标键保留");
  ok(expert.color === T.colorFor("财务顾问") || !!expert.color, "自动补专家色");
  ok(expert.category === "商业", "category 保留");
  ok(Array.isArray(expert.persona.expertise) && expert.persona.expertise.length === 2, "persona.expertise 归一为数组");
  ok(expert.prompt.identity === "你是财务顾问", "prompt 四段保留");
  ok(expert.model.provider === "deepseek-official" && expert.model.effort === "high", "model 缺省 provider / effort");
  ok(!!expert.perm.permissionPreset, "perm.permissionPreset 归一化");
  ok(expert.customField === "keep-me", "未知键保留（向后兼容兄弟模块）");

  const byGlyph = T.normalizeExpert({ name: "看图", glyph: "🛡️" });
  ok(byGlyph.icon === "shield", "normalizeExpert 把旧 emoji 迁成图标键");
  const badIcon = T.normalizeExpert({ name: "x", icon: "not-a-key" }).icon;
  ok(
    badIcon !== "not-a-key" && IC.keys().indexOf(badIcon) >= 0,
    "非法图标键回落到合法目录键（" + badIcon + "）",
  );
}

/* ===================== [8] 温度 ===================== */
console.log("\n[8] 温度：归一 / 夹取 / 回落 + 深合并单键不重置同组");
{
  const cv = T.ensureCanvas();
  ok(typeof T.normalizeTemperature === "function", "导出 normalizeTemperature");
  ok(T.normalizeTemperature(undefined) === 0.7, "缺省 0.7");
  ok(T.normalizeTemperature("abc") === 0.7, "非数字回落 0.7");
  ok(T.normalizeTemperature(NaN) === 0.7, "NaN 回落 0.7");
  ok(T.normalizeTemperature(5) === 2, "越界上夹取到 2");
  ok(T.normalizeTemperature(-1) === 0, "越界下夹取到 0");
  ok(T.normalizeTemperature(0.333) === 0.33, "两位小数归一");
  ok(T.normalizeTemperature("1.5") === 1.5, "数字字符串接受");

  const e = T.addExpert({ canvasId: cv.id, name: "温度专家", model: { temperature: 1.5 } });
  ok(e.model.temperature === 1.5, "合法温度原样保留");
  const dflt = T.addExpert({ canvasId: cv.id, name: "缺省温度专家" });
  ok(dflt.model.temperature === 0.7, "未填温度时补 0.7");

  const before = JSON.parse(JSON.stringify(e));
  const after = T.updateExpert(e.id, { model: { temperature: 0.2 } });
  ok(after.model.temperature === 0.2, "单键改温度生效");
  ok(
    after.model.provider === before.model.provider &&
      after.model.effort === before.model.effort &&
      after.model.preset === before.model.preset &&
      after.model.model === before.model.model,
    "同组 provider / model / effort / preset 未被重置（深合并）",
  );

  const chat = T.addChat({ expertId: e.id, canvasId: cv.id, title: "温度单聊" });
  const params = T.expertRunParams(chat, e);
  ok(!("temperature" in params), "expertRunParams 不下发温度（dsh 无宿主通道，仅存配置）");
}

/* ===================== [4] 深合并更新 + 级联删除 ===================== */
console.log("\n[4] 深合并更新 + 级联删除");
{
  const before = JSON.parse(JSON.stringify(expert));
  const after = T.updateExpert(expert.id, { model: { model: "deepseek-v4-pro" } });
  ok(after.model.model === "deepseek-v4-pro", "model.model 已更新");
  ok(after.model.provider === before.model.provider, "同组 provider 未被重置（深合并）");
  ok(after.model.effort === before.model.effort, "同组 effort 未被重置");
  ok(after.prompt.identity === before.prompt.identity, "未传的 prompt 组保持原样");

  const perm = T.updateExpert(expert.id, { perm: { toolAllow: { fs_read: "deny" } } });
  ok(perm.perm.toolAllow.fs_read === "deny", "perm.toolAllow 单键更新生效");
  ok(perm.perm.toolAllow.fs_write === "allow", "同组其它键保持（深合并）");

  const chat = T.addChat({ expertId: expert.id, canvasId: expert.canvasId, title: "单聊" });
  ok(!!chat && T.chat(chat.id), "新增会话成功");
  T.removeExpert(expert.id);
  ok(!T.expert(expert.id), "删除专家成功");
  const kept = T.chat(chat.id);
  ok(!!kept, "删除专家后其会话保留（不级联删除，避免信息丢失）");
  ok(kept && kept.expertName === "财务顾问", "保留的会话记下原专家名（孤儿会话可回看）");
  ok(T.removeChat(chat.id) && !T.chat(chat.id), "会话可单独删除");
}

/* ===================== [5] 默认工具许可 ===================== */
console.log("\n[5] 默认工具许可（专家默认读写事实库 + 能看 / 能改画布要点头）");
{
  const allow = T.defaultToolAllow();
  ok(Object.keys(allow).length === 18, "18 个许可键（对齐 app-nodes.js agentToolCatalog）");
  for (const k of ["fs_read", "fs_write", "web", "ask_user", "canvas_read"])
    ok(allow[k] === "allow", k + " = allow");
  for (const k of ["shell", "canvas_nodes", "canvas_control", "canvas_draw", "canvas_layout", "canvas_super", "app_ops"])
    ok(allow[k] === "ask", k + " = ask");
  for (const k of ["app_delete", "app_dsh_plugins", "subagent", "goal", "jobs", "vision"])
    ok(allow[k] === "deny", k + " = deny");
}

/* ===================== [6] 分类 ===================== */
console.log("\n[6] 分类：新建去重 / 删除回未分类");
{
  const c = T.addCategory({ name: "测试分类" });
  ok(!!c && c.name === "测试分类", "新建分类成功");
  ok(T.addCategory({ name: "测试分类" }).id === c.id, "同名分类去重（返回已有）");
  ok(T.categories().some((x) => x.id === c.id), "分类列表含新建分类");

  const cv = T.ensureCanvas();
  const e = T.addExpert({ canvasId: cv.id, name: "分类专家", category: "测试分类" });
  const other = T.addCategory({ name: "临时分类" });
  const renamed = T.updateCategory(other.id, { name: "改名分类" });
  ok(renamed.name === "改名分类", "分类改名成功");
  ok(T.removeCategory(c.id), "删除分类成功");
  ok(T.expert(e.id).category === "", "删除分类后专家回到未分类（不删人）");
  ok(!!T.expert(e.id), "专家仍在");
}

/* ===================== [7] 运行接线 ===================== */
console.log("\n[7] 运行接线：runKey / 人设 / 模型 / 权限");
{
  const cv = T.addCanvas({ id: "wf-2", name: "画布 B", workspace: "E:/ws/canvas-b" });
  const e = T.addExpert({
    canvasId: cv.id,
    name: "增长顾问",
    icon: "megaphone",
    role: "增长",
    persona: { tagline: "只谈可量化的增长", background: "十年增长经验", tone: "直接" },
    prompt: { identity: "你是增长顾问", goal: "给出增长方案", constraints: "不承诺具体数字", output: "分点" },
    model: { provider: "mtnode_xxx", model: "some-model", effort: "medium", preset: "standard" },
    perm: { permissionPreset: "workspace-write", toolAllow: { fs_read: "allow", fs_write: "allow", web: "allow", canvas_read: "deny" } },
  });
  const chat = T.addChat({ expertId: e.id, canvasId: cv.id, title: "单聊" });

  ok(T.runKeyOf(chat.id, e.id) === "team:" + chat.id + ":" + e.id, "runKey = team:<chatId>:<expertId>");

  const sys = T.expertSystemPrompt(e);
  ok(sys.indexOf("你是「增长顾问」") >= 0, "systemPrompt 含身份段");
  ok(sys.indexOf("目标：") >= 0 && sys.indexOf("约束：") >= 0 && sys.indexOf("输出要求：") >= 0, "含目标 / 约束 / 输出段");
  ok(sys.indexOf("你的工具许可") >= 0, "含工具许可实况");

  const params = T.expertRunParams(chat, e);
  ok(params.runKey === "team:" + chat.id + ":" + e.id, "params.runKey 正确");
  ok(params.workspace === "E:/ws/canvas-b", "workspace = 画布锚点工作区");
  ok(params.provider === "mtnode_xxx" && params.model === "some-model", "provider / model 取自专家");
  ok(params.effort === "medium" && params.preset === "standard", "effort / preset 取自专家");
  ok(params.permissionPreset === "workspace-write", "permissionPreset 走单次运行覆盖");
  ok(params.noCanvas === false, "画布六类没全拒 → 不整档摘掉画布工具（专家能核验画布）");
  ok(!!params.toolPolicy && params.toolPolicy.canvas_read === "deny", "toolPolicy 装进本轮运行");
  ok(!!params.toolPolicy && params.toolPolicy.fs_write === "allow", "toolPolicy 保留写文件放行");
  /* 全拒画布六类的专家仍整档省下这 26K 字符 / 步 */
  const noCanvasExpert = T.addExpert({
    canvasId: cv.id,
    name: "不碰画布的顾问",
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
  });
  ok(
    T.expertRunParams(chat, noCanvasExpert).noCanvas === true,
    "画布六类全拒 → noCanvas: true（整档不注册画布三件套）",
  );

  const src = read("renderer/app-team.js");
  ok(/T\("【画布】"\)/.test(src) && !/T\("【项目】"\)/.test(src), "群聊 / 聚合提示词里的锚点口径为「画布」");
  ok(!/hostPersona\s*[:=]/.test(src), "app-team.js 不使用 hostPersona（避免整段替换系统提示）");
  ok(/systemPrompt:\s*expertSystemPrompt\(exp\)/.test(src), "人设经 opts.systemPrompt 下发");
}

/* ===================== [9] pruneCanvases（画布删除即团队消失） ===================== */
(async function () {
  console.log("\n[9] pruneCanvases：拿不到画布列表绝不删 / 缺画布级联删 / 幂等");
  const api = sandbox.api;
  T.addCanvas({ id: "wf-gone", name: "已删画布", workspace: "E:/ws/gone" });
  const eg = T.addExpert({ canvasId: "wf-gone", name: "孤儿专家", icon: "server" });
  const cg = T.addChat({ expertId: eg.id, canvasId: "wf-gone", title: "孤儿会话" });
  const dg = T.addRecruitDraft({ canvasId: "wf-gone", name: "孤儿草稿" });
  ok(!!T.canvas("wf-gone") && !!T.expert(eg.id), "预置一张待剪画布 + 专家");

  /* 1) wfList 不存在：一个都不能删（S.wfBag 只含本次加载过的画布，按它剪会误删）。 */
  delete api.wfList;
  let n = await T.pruneCanvases();
  ok(n === 0 && !!T.canvas("wf-gone") && !!T.expert(eg.id), "wfList 缺失时不删任何锚点");

  /* 2) 返回空数组：同样不删。 */
  api.wfList = async () => [];
  n = await T.pruneCanvases();
  ok(n === 0 && !!T.canvas("wf-gone"), "wfList 返回空数组时不删（防误删未加载画布）");

  /* 3) 抛错：吞掉异常，不删。 */
  api.wfList = async () => {
    throw new Error("boom");
  };
  n = await T.pruneCanvases();
  ok(n === 0 && !!T.canvas("wf-gone"), "wfList 抛错时不删任何锚点");

  /* 4) 正常返回磁盘画布列表：剪掉不在列表里的锚点，并级联清理。 */
  api.wfList = async () => [{ id: "wf-1", name: "画布 A" }];
  n = await T.pruneCanvases();
  ok(n >= 1, "剪掉 " + n + " 个已不存在的画布锚点");
  ok(!T.canvas("wf-gone"), "已删画布的锚点被移除");
  ok(!T.expert(eg.id) && !T.chat(cg.id), "级联删除该画布的专家与会话");
  ok(!dg || !T.recruitDraft(dg.id), "级联删除该画布的招聘草稿");
  ok(!!T.canvas("wf-1"), "当前画布保留（并入存活集合兜底）");

  /* 5) 幂等：再跑一次什么都不删。 */
  n = await T.pruneCanvases();
  ok(n === 0, "重复调用幂等（返回 0，不再写盘）");

  console.log(
    "\n" +
      (fails
        ? "FAILED " + fails + " / " + checks + " checks"
        : "ALL OK  " + checks + " checks"),
  );
})();

/* ==================== 已并入：test/smoke-team-recruit.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-team-recruit.js";
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
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* DOM 桩：renderExpertCard + 招聘对话框（编辑模式）都要能跑。
     语义贴近真实 DOM：textContent / innerHTML 赋值即清空 children；appendChild 递归登记 id；
     classList 走真实 Set；querySelector(All) 支持 ".cls" / "#id"；addEventListener 记录可手动触发。 */
  var DOM_IDS = {};
  function registerIds(node) {
    if (!node) return;
    if (node.id) DOM_IDS[node.id] = node;
    for (const c of node.children || []) registerIds(c);
  }
  function matchSel(node, sel) {
    const s = String(sel || "");
    if (s.charAt(0) === "#") return node.id === s.slice(1);
    if (s.charAt(0) === ".")
      return String(node.className || "").split(/\s+/).indexOf(s.slice(1)) >= 0;
    return String(node.tagName || "").toLowerCase() === s.toLowerCase();
  }
  function fakeEl(tag) {
    const cls = new Set();
    const evs = {};
    const e = {
      tagName: String(tag || "").toUpperCase(),
      className: "",
      id: "",
      _text: "",
      _html: "",
      style: {},
      dataset: {},
      children: [],
      options: [],
      value: "",
      title: "",
      type: "",
      placeholder: "",
      rows: 0,
      disabled: false,
      hidden: false,
      appendChild(c) {
        this.children.push(c);
        /* 贴近真实 DOM：给 <select> 追加 <option> 时同步进 options（统一编辑权限的 select 靠它）。 */
        if (String(c.tagName || "").toUpperCase() === "OPTION") this.options.push(c);
        registerIds(c);
        return c;
      },
      setAttribute() {},
      removeAttribute() {},
      addEventListener(t, fn) {
        (evs[t] || (evs[t] = [])).push(fn);
      },
      removeEventListener() {},
      _fire(t, ev) {
        const e2 = ev || { target: this };
        if (!e2.stopPropagation) e2.stopPropagation = function () {};
        if (!e2.preventDefault) e2.preventDefault = function () {};
        (evs[t] || []).forEach((fn) => fn(e2));
      },
      closest() {
        return null;
      },
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
      querySelector(sel) {
        let hit = null;
        const walk = (n) => {
          for (const c of n.children || []) {
            if (hit) return;
            if (matchSel(c, sel)) {
              hit = c;
              return;
            }
            walk(c);
          }
        };
        walk(this);
        return hit;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children || []) {
            if (matchSel(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    Object.defineProperty(e, "textContent", {
      get() {
        return this._text;
      },
      set(v) {
        this._text = String(v);
        this.children.length = 0;
      },
    });
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
  /* 收集一棵假 DOM 树的全部文本（含 innerHTML 里塞进去的 SVG 字符串，仅用于判定）。 */
  function collectText(node) {
    if (!node) return "";
    let out = node.textContent || "";
    for (const c of node.children || []) out += " " + collectText(c);
    return out;
  }

  /* ═══════════ 沙箱：app-team-icons.js + app-team.js + app-team-recruit.js ═══════════ */
  function loadTeam() {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.console = console;
    sandbox.I18n = { t: (s) => String(s) };
    sandbox.api = { configSave: () => Promise.resolve() };
    sandbox.document = {
      createElement: (t) => fakeEl(t),
      getElementById: (id) => DOM_IDS[id] || null,
      body: fakeEl("body"),
    };
    sandbox.toast = () => {};
    sandbox.setTimeout = () => 0;
    sandbox.clearTimeout = () => {};
    sandbox.AGENT_PRESETS = ["minimal", "standard", "lean", "code", "cordis"].map((id) => ({ id }));
    sandbox.AGENT_PRESET_DEFAULT = "minimal";
    sandbox.AGENT_PRESET_LEGACY_IDS = {};
    sandbox.normalizeAgentEffort = (v) => {
      const s = String(v == null ? "" : v).trim();
      return ["low", "medium", "high", "xhigh", "max"].indexOf(s) >= 0 ? s : "high";
    };
    sandbox.permissionPresetOptions = () =>
      ["mtnode-unattended", "workspace-write", "read-only", "danger-full-access"].map((id) => [id, id]);
    /* 工具目录真源在 app-nodes.js（19 key 分 4 组）；沙箱里按同一形状给一份，
       否则 MTNodeTeam.toolCatalog() 会回退成「扁平数组」兜底，统一编辑权限的工具行就渲染不出来。 */
    sandbox.agentToolCatalog = () => [
      {
        id: "core",
        label: "核心能力",
        items: [
          { key: "fs_read", label: "读取文件", hint: "read_file" },
          { key: "fs_write", label: "写入文件", hint: "write_file" },
          { key: "shell", label: "执行命令", hint: "run_command" },
          { key: "web", label: "联网搜索", hint: "web_search" },
          { key: "ask_user", label: "反问用户", hint: "ask_user" },
          { key: "subagent", label: "子代理", hint: "subagent" },
          { key: "goal", label: "目标与清单", hint: "goal" },
          { key: "jobs", label: "后台作业", hint: "jobs" },
        ],
      },
      { id: "vision", label: "识图", items: [{ key: "vision", label: "识图", hint: "vision" }] },
      {
        id: "canvas",
        label: "画布",
        items: [
          { key: "canvas_read", label: "读取画布", hint: "mtnode_canvas_get" },
          { key: "canvas_nodes", label: "节点与连线", hint: "mtnode_canvas_edit" },
          { key: "canvas_control", label: "控制类节点", hint: "control" },
          { key: "canvas_draw", label: "绘图", hint: "marks" },
          { key: "canvas_layout", label: "排版与成组", hint: "layout" },
          { key: "canvas_super", label: "超级节点", hint: "super" },
        ],
      },
      {
        id: "app",
        label: "应用",
        items: [
          { key: "app_ops", label: "应用操作", hint: "app" },
          { key: "app_delete", label: "删除画布", hint: "delete" },
          { key: "app_dsh_plugins", label: "插件管理", hint: "plugins" },
        ],
      },
    ];
    const S = { config: {}, wf: { id: "wf-recruit", name: "招聘画布" } };
    sandbox.S = S;
    vm.createContext(sandbox);
    vm.runInContext(read("renderer/app-team-icons.js"), sandbox, { filename: "app-team-icons.js" });
    vm.runInContext(read("renderer/app-team.js"), sandbox, { filename: "app-team.js" });
    vm.runInContext(read("renderer/app-team-recruit.js"), sandbox, {
      filename: "app-team-recruit.js",
    });
    return {
      sandbox,
      S,
      team: sandbox.MTNodeTeam,
      recruit: sandbox.MTNodeTeamRecruit,
      icons: sandbox.MTNodeTeamIcons,
    };
  }

  const { sandbox, S, team: T, recruit: R, icons: IC } = loadTeam();
  ok(!!R && typeof R.validateRoleCard === "function", "app-team-recruit.js 暴露 window.MTNodeTeamRecruit");
  T.ensure(S.config);

  /* ===================== [1] 模板库 ===================== */
  console.log("\n[1] 模板库：39 个预置角色全部可录用（含图标 / 分类）");
  ok(R.TEMPLATES.length === 39, "预置角色数量 = 39（" + R.TEMPLATES.length + "）");
  let badTpl = [];
  for (const tpl of R.TEMPLATES) {
    const v = R.validateRoleCard(tpl);
    if (!v.ok) badTpl.push(tpl.id + ":" + v.errors.map((e) => e.msg).join("|"));
    const b = R.budgetOf(tpl);
    if (b.persona.used > b.persona.limit || b.prompt.used > b.prompt.limit)
      badTpl.push(tpl.id + ":预算超限");
  }
  ok(badTpl.length === 0, "全部模板通过校验与预算" + (badTpl.length ? "（" + badTpl[0] + "）" : ""));
  ok(
    R.TEMPLATES.every((t) => t.prompt.identity && t.prompt.goal && t.prompt.constraints && t.prompt.output),
    "每个模板四段提示词齐全",
  );
  ok(
    R.TEMPLATES.every((t) => t.perm && t.perm.toolAllow && Object.keys(t.perm.toolAllow).length === 18),
    "每个模板工具许可覆盖 18 个 key",
  );
  ok(
    R.TEMPLATES.every((t) => t.icon && IC.keys().indexOf(t.icon) >= 0),
    "每个模板图标都在图标目录内（空心线条 SVG）",
  );
  ok(
    R.TEMPLATES.every((t) => String(t.category || "").trim()),
    "每个模板都有所属分类",
  );
  ok(R.TEMPLATES.every((t) => !t.glyph), "模板不再使用 emoji glyph（统一 icon）");
  const good = clone(R.TEMPLATES[0]);
  ok(R.validateRoleCard(good).ok, "基准卡（模板）校验通过");

  /* ===================== [2] parseRoleCardJSON ===================== */
  console.log("\n[2] parseRoleCardJSON：容忍围栏 / 废话 / 嵌套，非法输入拒收");
  {
    let r = R.parseRoleCardJSON('```json\n{"name":"x","role":"r"}\n```');
    ok(r.ok && r.card.name === "x", "```json 围栏解析成功");
    r = R.parseRoleCardJSON('好的，这是角色卡：{"name":"x","nested":{"a":1}} 谢谢');
    ok(r.ok && r.card.nested.a === 1, "前后废话 + 嵌套对象解析成功");
    r = R.parseRoleCardJSON('{"name":"a}b{c"}');
    ok(r.ok && r.card.name === "a}b{c", "字符串内的花括号不打断配对");
    r = R.parseRoleCardJSON("");
    ok(!r.ok, "空输出拒收");
    r = R.parseRoleCardJSON("这里没有 JSON");
    ok(!r.ok, "无 JSON 拒收");
    r = R.parseRoleCardJSON('{"name":"x"');
    ok(!r.ok, "未闭合 JSON 拒收");
    r = R.parseRoleCardJSON('{"name":}');
    ok(!r.ok, "语法错误 JSON 拒收");
    r = R.parseRoleCardJSON("```json\n[1,2,3]\n```");
    ok(!r.ok, "数组（非对象）拒收");
    ok(typeof R.parseRoleCardJSON("x").error === "string", "拒收时返回可读 error");
  }

  /* ===================== [3] validateRoleCard ===================== */
  console.log("\n[3] validateRoleCard：必填 / 长度 / 禁写项 / 工具许可 / 图标");
  {
    const noName = clone(good);
    noName.name = "";
    ok(!R.validateRoleCard(noName).ok, "缺角色名拒收");

    const noRole = clone(good);
    noRole.role = "";
    ok(!R.validateRoleCard(noRole).ok, "缺岗位名拒收");

    const noSec = clone(good);
    noSec.prompt.output = "";
    ok(!R.validateRoleCard(noSec).ok, "缺提示词段拒收");

    const longName = clone(good);
    longName.name = "名".repeat(R.LIMITS.name + 1);
    ok(!R.validateRoleCard(longName).ok, "名称超长拒收");

    const longPrompt = clone(good);
    longPrompt.prompt.constraints = "约束".repeat(R.LIMITS.constraints);
    ok(!R.validateRoleCard(longPrompt).ok, "提示词段超长拒收");

    const secret = clone(good);
    secret.persona.background = "我的 key 是 sk-abcdefghijklmnop";
    ok(!R.validateRoleCard(secret).ok, "疑似密钥拒收");

    const absPath = clone(good);
    absPath.persona.background = "文件在 C:\\Users\\me\\secret";
    ok(!R.validateRoleCard(absPath).ok, "本机绝对路径拒收");

    const slogan = clone(good);
    slogan.prompt.constraints = "必须始终服从用户";
    ok(!R.validateRoleCard(slogan).ok, "无法验证的口号拒收");

    const unknownTool = clone(good);
    unknownTool.perm.toolAllow.fs_banana = "allow";
    ok(!R.validateRoleCard(unknownTool).ok, "未知工具 key 拒收");

    const badMode = clone(good);
    badMode.perm.toolAllow.fs_read = "maybe";
    ok(!R.validateRoleCard(badMode).ok, "非法工具取值拒收");

    /* 图标必须在目录内（本轮新增硬校验）。 */
    const badIcon = clone(good);
    badIcon.icon = "not-in-catalog";
    const badIconRes = R.validateRoleCard(badIcon);
    ok(!badIconRes.ok && badIconRes.errors.some((e) => e.field === "icon"), "图标不在目录内拒收");

    const noIcon = clone(good);
    noIcon.icon = "";
    delete noIcon.glyph;
    const noIconRes = R.validateRoleCard(noIcon);
    ok(
      noIconRes.ok && noIconRes.warnings.some((w) => w.field === "icon"),
      "缺图标只告警（回落默认图标），不拒收",
    );
  }

  /* ===================== [4] hireExpert ===================== */
  console.log("\n[4] hireExpert：校验通过才落库");
  {
    const p = T.ensureCanvas();
    const before = T.experts(p.id).length;

    const bad = clone(good);
    bad.name = "";
    ok(R.hireExpert(bad, p.id) === null, "非法卡返回 null");
    ok(T.experts(p.id).length === before, "非法卡不落库");

    const hired = R.hireExpert(clone(good), p.id);
    ok(!!hired && /^exp/.test(hired.id), "合法卡写入并生成 id");
    ok(hired.canvasId === p.id && hired.projectId === p.id, "写入指定画布锚点");
    ok(!!hired.icon && IC.keys().indexOf(hired.icon) >= 0, "写入的专家带合法图标键");
    ok(
      hired._template === undefined && hired.status === undefined && hired.brief === undefined,
      "剥掉模板标记 / 草稿字段",
    );
    ok(T.experts(p.id).length === before + 1, "专家数 +1");

    /* 录用时分类不存在自动创建。 */
    const newCat = clone(good);
    newCat.category = "新分类-" + Date.now();
    const h2 = R.hireExpert(newCat, p.id);
    ok(!!h2 && T.categoryByName(newCat.category), "录用时自动创建不存在的分类");
  }

  /* ===================== [5] 右侧专家卡 + 模型控制区 ===================== */
  console.log("\n[5] 右侧专家卡：结构化渲染 + 模型四控件（不再有「长度预算」）");
  {
    const src = read("renderer/app-team-recruit.js");

    /* paintPreview：去掉长度预算，改为 专家卡 + 模型控制区 + 校验清单。 */
    const pvStart = src.indexOf("function paintPreview");
    const pv = src.slice(pvStart, src.indexOf("function buildAutoMode", pvStart));
    ok(pvStart >= 0 && pv.length > 0, "定位到 paintPreview");
    ok(!/budget/i.test(pv), "paintPreview 不再引用 budget 渲染");
    ok(!/长度预算/.test(pv), "paintPreview 不再渲染「长度预算」");
    ok(/renderExpertCard\(R\.card\)/.test(pv), "paintPreview 渲染结构化专家卡");
    ok(/modelControl\(\)/.test(pv), "paintPreview 渲染模型控制区");
    ok(!/budgetBar/.test(src), "budgetBar 函数已删除");
    /* 长度上限仍在校验清单里生效（validateRoleCard 未受影响）。 */
    ok(typeof R.validateRoleCard === "function" && R.LIMITS.constraints > 0, "长度上限仍由 validateRoleCard 生效");

    /* 模型四控件（源码口径：四个控件直接读写 R.card.model）。 */
    const mcStart = src.indexOf("function modelControl");
    const mc = src.slice(mcStart, src.indexOf("function paintPreview", mcStart));
    ok(mcStart >= 0 && mc.length > 0, "定位到 modelControl");
    for (const id of ["trModelPick", "trModelEffort", "trModelPreset", "trModelTemp"])
      ok(mc.indexOf(id) >= 0, "模型控件存在：" + id);
    ok(mc.indexOf("思考强度") >= 0 && mc.indexOf("预设档") >= 0 && mc.indexOf("温度") >= 0, "三档标签：思考强度 / 预设档 / 温度");
    ok(/min\s*=\s*"0"/.test(mc) && /max\s*=\s*"2"/.test(mc) && /step\s*=\s*"0\.1"/.test(mc), "温度输入框范围 0–2 / 步进 0.1");
    ok(/Math\.max\(0,\s*Math\.min\(2,\s*n\)\)/.test(mc), "温度写入前夹取到 [0,2]");
    ok(/onModelPatch\(\{\s*temperature:\s*n\s*\}\)/.test(mc), "温度改动写回 card.model.temperature");
    ok(/R\.card\.model\[k\]\s*=\s*patch\[k\]/.test(src), "onModelPatch 直接读写 R.card.model");
    /* 左侧表单不再有模型字段（模型控制收口到右侧，避免两处互相覆盖）。 */
    ok(!/modelOptionsOf/.test(src), "左侧模型联动监听已移除");

    /* renderExpertCard 运行时：结构化分段 + 温度 + 空字段占位。 */
    ok(typeof R.renderExpertCard === "function", "导出 renderExpertCard（团队视图折叠区复用）");
    const card = {
      name: "系统架构师",
      role: "系统架构",
      category: "研发",
      icon: "code",
      color: "#6db4ff",
      persona: { tagline: "稳", background: "十年架构", expertise: ["后端", "云原生"], style: "简洁", tone: "冷静", language: "zh-CN" },
      prompt: { identity: "你是系统架构师", goal: "给出可落地架构", constraints: "不写业务代码", output: "分点" },
      model: { provider: "deepseek-official", model: "deepseek-v4-pro", effort: "high", preset: "standard", temperature: 0.3 },
      perm: { permissionPreset: "workspace-write", toolAllow: { fs_read: "allow", fs_write: "ask" } },
    };
    let cardEl = null;
    try {
      cardEl = R.renderExpertCard(card);
      ok(!!cardEl && cardEl.className.indexOf("team-expert-card") >= 0, "renderExpertCard 返回专家卡元素");
    } catch (e) {
      ok(false, "renderExpertCard 抛错：" + e.message);
    }
    const text = collectText(cardEl);
    for (const t of ["基本信息", "人设", "提示词", "模型", "权限", "温度"])
      ok(text.indexOf(t) >= 0, "专家卡含结构段：" + t);
    ok(text.indexOf("0.3") >= 0, "专家卡显示温度值 0.3");
    ok(text.indexOf("系统架构师") >= 0 && text.indexOf("研发") >= 0, "专家卡显示名称 / 分类");
    ok(!/\[object Object\]/.test(text), "不输出对象拼接原文");
    ok(!/identity|constraints/.test(text), "不输出字段英文名原文（用中文结构化标签）");
    const emptyText = collectText(R.renderExpertCard({ name: "空专家" }));
    ok(emptyText.indexOf("—") >= 0, "空字段显示占位「—」");
  }

  /* ===================== [6] 编辑已有专家（openEdit） ===================== */
  console.log("\n[6] 编辑已有专家：预填 / 不新建 / 校验失败不落库");
  {
    const p = T.ensureCanvas();
    const hired = R.hireExpert(clone(good), p.id);
    ok(!!hired, "先录用一个专家作为编辑对象");
    T.updateExpert(hired.id, {
      name: "被编辑的专家",
      persona: { tagline: "原始职责一句话" },
      model: {
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        effort: "high",
        preset: "standard",
        temperature: 0.4,
      },
    });
    const countBefore = T.experts(p.id).length;

    ok(
      typeof R.openEdit === "function" && sandbox.teamRecruitEdit === R.openEdit,
      "导出 openEdit / window.teamRecruitEdit",
    );

    let savedWith = null;
    R.openEdit(hired.id, (e) => {
      savedWith = e;
    });

    const byId = (id) => sandbox.document.getElementById(id);
    ok(
      !!byId("teamRecruitTitle") && byId("teamRecruitTitle").textContent === "编辑专家",
      "标题改为「编辑专家」",
    );
    ok(byId("trSide") === null, "编辑模式不渲染模板库侧栏");
    ok(byId("trSaveTpl") === null, "编辑模式无「存为模板」");
    const hireBtn = byId("trHire");
    ok(!!hireBtn && hireBtn.textContent === "保存修改", "主按钮改为「保存修改」");
    const tabsEl = byId("teamRecruitTabs");
    ok(!!tabsEl && tabsEl.style.display === "none", "编辑模式收起「手动 / 自动招聘」页签");
    ok(!!byId("trName") && byId("trName").value === "被编辑的专家", "表单预填专家名（字段与专家一致）");
    ok(byId("trTagline").value === "原始职责一句话", "表单预填人设");
    ok(byId("trIdentity").value === hired.prompt.identity, "表单预填提示词");
    ok(byId("trModelTemp").value === "0.4", "表单预填模型温度");
    ok(byId("trPermPreset").value === hired.perm.permissionPreset, "表单预填审批档");

    /* 保存：走 updateExpert，绝不调 addExpert（不新建）。 */
    let updateCalls = 0;
    let addCalls = 0;
    let updatedId = "";
    let updatedPatch = null;
    const origUpdate = T.updateExpert;
    const origAdd = T.addExpert;
    T.updateExpert = function (id, patch) {
      updateCalls++;
      updatedId = id;
      updatedPatch = patch;
      return origUpdate.call(T, id, patch);
    };
    T.addExpert = function () {
      addCalls++;
      return origAdd.apply(T, arguments);
    };
    byId("trName").value = "改名后的专家";
    R.confirmEdit();
    ok(updateCalls === 1 && updatedId === hired.id, "保存走 teamUpdateExpert 且 id = 原专家");
    ok(addCalls === 0, "保存不调用 addExpert（不新建）");
    ok(
      !!updatedPatch &&
        updatedPatch.canvasId === hired.canvasId &&
        updatedPatch.projectId === hired.projectId,
      "写回保留 canvasId / projectId",
    );
    ok(T.expert(hired.id).name === "改名后的专家", "改动写回原专家");
    ok(T.experts(p.id).length === countBefore, "专家总数不变");
    ok(!!savedWith && savedWith.id === hired.id, "保存后触发 onSaved 回调");
    ok(R.isOpen() === false, "保存后关闭对话框");

    /* 校验失败：不更新、不新建，专家内容不变、对话框保持打开。 */
    R.openEdit(hired.id);
    const nameNow = T.expert(hired.id).name;
    let u2 = 0;
    let a2 = 0;
    T.updateExpert = function () {
      u2++;
    };
    T.addExpert = function () {
      a2++;
    };
    byId("trName").value = "";
    R.confirmEdit();
    ok(u2 === 0 && a2 === 0, "校验失败不落库（不更新、不新建）");
    ok(T.expert(hired.id).name === nameNow, "校验失败专家内容不变");
    ok(R.isOpen() === true, "校验失败对话框保持打开（不丢输入）");
    T.updateExpert = origUpdate;
    T.addExpert = origAdd;
  }

  /* ===================== [7] 自动招聘 → 录用并录入模板库 ===================== */
  (async function () {
    console.log("\n[7] 自动招聘：录用即把角色卡录入模板库（可关 / 不重复录）");
    const p = T.ensureCanvas();
    const byId = (id) => sandbox.document.getElementById(id);

    /* dsh 运行入口桩：把预置 JSON 当成模型输出（流式文本一次性吐回）。 */
    const autoCard = {
      name: "自动招聘的专家",
      role: "自动岗位",
      category: "自动分类",
      icon: "robot",
      color: "#6db4ff",
      persona: {
        tagline: "验证自动录入",
        background: "十年自动化经验",
        expertise: ["招聘", "录入"],
        style: "简洁",
        tone: "冷静",
        language: "zh-CN",
      },
      prompt: { identity: "你是自动招聘的专家", goal: "验证自动录入", constraints: "不写代码", output: "分点" },
      model: { provider: "deepseek-official", model: "", effort: "high", preset: "standard" },
      perm: { permissionPreset: "workspace-write", toolAllow: { fs_read: "allow", fs_write: "allow" } },
    };
    sandbox.dshRunTask = (input, opts) => {
      if (opts && typeof opts.onEvent === "function") opts.onEvent("text", { text: JSON.stringify(autoCard) });
      return Promise.resolve(JSON.stringify(autoCard));
    };

    R.openAuto(p.id);
    ok(!!byId("trAutoTpl") && byId("trAutoTpl").checked === true, "自动招聘页有「自动录入模板库」勾选，默认勾上");
    byId("trBrief").value = "要一个盯现金流的财务顾问";
    byId("trGen").onclick();
    await Promise.resolve();
    ok(!!byId("trConfirm") && byId("trConfirm").disabled === false, "模型返回合法卡 → 「确认录用」可用");

    const tplBefore = T.templates().length;
    const expBefore = T.experts(p.id).length;
    byId("trConfirm").onclick();
    ok(T.experts(p.id).length === expBefore + 1, "录用写入专家团（+1）");
    ok(T.templates().length === tplBefore + 1, "录用同时录入模板库（+1）");
    const tpl = T.templates().filter((x) => x.name === autoCard.name)[0];
    ok(!!tpl && tpl.custom === true, "录入的模板是自建模板（custom=true）");
    ok(
      !!tpl && tpl.prompt && tpl.prompt.identity === autoCard.prompt.identity && tpl.role === autoCard.role,
      "模板内容与角色卡一致（四段提示词 / 岗位名）",
    );
    ok(!!tpl && !tpl.canvasId && !tpl.projectId, "模板不带画布锚点（不跟着某个画布走）");
    ok(R.templateById(tpl.id) !== null, "录入后可按 id 从模板库取回（下次可一键套用）");
    ok(R.isOpen() === false, "录用后对话框关闭");

    /* 同名不重复录：模板库列表只显示名称，同名两条用户没法分辨 → 就地覆盖。
       走一遍真实路径（重开 → 重新生成同名卡 → 录用），tplRecorded 才会复位。 */
    const tplAfter1 = T.templates().length;
    R.openAuto(p.id);
    byId("trBrief").value = "同一个岗位再招一个";
    byId("trGen").onclick();
    await Promise.resolve();
    byId("trConfirm").onclick();
    ok(T.templates().length === tplAfter1, "同名角色卡再次录用：模板就地更新，不新增条目");

    /* 取消勾选：录用照常，模板库不动。 */
    R.openAuto(p.id);
    ok(!!byId("trAutoTpl") && byId("trAutoTpl").checked === true, "重开自动招聘页勾选复位为默认勾上");
    byId("trAutoTpl").checked = false;
    byId("trAutoTpl").onchange();
    byId("trBrief").value = "再来一个";
    byId("trGen").onclick();
    await Promise.resolve();
    const tplBefore2 = T.templates().length;
    const expBefore2 = T.experts(p.id).length;
    byId("trConfirm").onclick();
    ok(T.experts(p.id).length === expBefore2 + 1, "取消勾选仍照常录用");
    ok(T.templates().length === tplBefore2, "取消勾选不录入模板库");

    /* ===================== [8] 统一编辑权限（openPermBatch） ===================== */
    console.log("\n[8] 统一编辑权限：范围 / 保持不变 / 审批档与逐项写回");
    {
      const byId = (id) => sandbox.document.getElementById(id);
      const p = T.ensureCanvas();
      const exps = T.experts(p.id);
      ok(exps.length >= 2, "画布上已有 ≥2 位专家");

      /* 给第一位预置一个非默认项，验证未被改动的项原样保留。 */
      T.updateExpert(exps[0].id, { perm: { toolAllow: { fs_read: "deny" } } });
      ok(T.expert(exps[0].id).perm.toolAllow.fs_read === "deny", "预置：第一位 fs_read = deny");

      const toasts = [];
      sandbox.toast = (m, k) => {
        toasts.push([m, k]);
      };

      ok(
        typeof sandbox.teamPermBatchOpen === "function" &&
          R.openPermBatch === sandbox.teamPermBatchOpen,
        "导出 openPermBatch / window.teamPermBatchOpen",
      );

      let savedN = -1;
      sandbox.teamPermBatchOpen(p.id, (n) => {
        savedN = n;
      });
      const host = byId("teamPermDlg");
      ok(!!host && host.classList.contains("on"), "对话框已打开（#teamPermDlg.on）");
      ok(byId("teamPermScope").value === "canvas", "范围默认当前画布");
      ok(byId("teamPermScopeHint").textContent === "共 {n} 位专家", "显示命中专家数");
      ok(byId("teamPermPreset").value === "", "审批档默认「保持不变」");
      const sels = host.querySelectorAll(".team-perm-sel");
      const toolSels = sels.filter((s) => s.dataset && s.dataset.key && s.dataset.key !== "permissionPreset");
      ok(toolSels.length === 18, "逐项许可覆盖 18 个工具 key（" + toolSels.length + "）");
      const visionSel = toolSels.filter((s) => s.dataset.key === "vision")[0];
      ok(!!visionSel && visionSel.value === "", "逐项许可默认「保持不变」");
      ok(
        visionSel.options.map((o) => o.value).join(",") === ",allow,ask,deny",
        "逐项选项 = 保持不变 / 允许 / 询问 / 拒绝",
      );
      ok(
        byId("teamPermPreset")
          .options.map((o) => o.value)
          .join(",") === ",mtnode-unattended,workspace-write,read-only,danger-full-access",
        "审批档选项 = 保持不变 + 四个预设",
      );

      /* 只改两项（审批档 + vision），其余保持各专家现状。 */
      const beforeMaps = exps.map((e) => ({
        id: e.id,
        preset: e.perm.permissionPreset,
        ta: Object.assign({}, e.perm.toolAllow),
      }));
      byId("teamPermPreset").value = "read-only";
      visionSel.value = "deny";
      byId("teamPermApply").onclick();
      const after = T.experts(p.id);
      ok(after.every((e) => e.perm.permissionPreset === "read-only"), "审批档统一写为 read-only");
      ok(after.every((e) => e.perm.toolAllow.vision === "deny"), "vision 统一写为 deny");
      let kept = true;
      beforeMaps.forEach((b) => {
        const e = T.expert(b.id);
        Object.keys(b.ta).forEach((k) => {
          if (k === "vision") return;
          if (e.perm.toolAllow[k] !== b.ta[k]) kept = false;
        });
      });
      ok(kept, "未改动的项原样保留（fs_read 等按各专家现状）");
      ok(T.expert(exps[0].id).perm.toolAllow.fs_read === "deny", "第一位预置的 fs_read=deny 未被抹掉");
      ok(savedN === after.length, "onSaved 回调带命中专家数");
      ok(host.classList.contains("on") === false, "应用后对话框关闭");

      /* 重开复位：全部回到「保持不变」。 */
      sandbox.teamPermBatchOpen(p.id);
      ok(byId("teamPermPreset").value === "", "重开审批档复位为「保持不变」");
      ok(
        byId("teamPermDlg")
          .querySelectorAll(".team-perm-sel")
          .filter((s) => s.dataset && s.dataset.key === "vision")[0].value === "",
        "重开逐项许可复位为「保持不变」",
      );

      /* 范围 = 全部画布：另一张画布的专家一并命中。 */
      const other = T.addCanvas({ name: "另一张画布" });
      const otherExp = T.addExpert({ canvasId: other.id, name: "别画布专家", icon: "person" });
      sandbox.teamPermBatchOpen(p.id);
      byId("teamPermScope").value = "all";
      byId("teamPermScope").onchange();
      ok(
        T.experts(p.id).length <= T.experts().length,
        "范围=全部画布时命中专家数不少于当前画布",
      );
      byId("teamPermPreset").value = "read-only";
      byId("teamPermApply").onclick();
      ok(T.expert(otherExp.id).perm.permissionPreset === "read-only", "另一画布专家也命中");

      /* 本画布没有专家 → 范围默认「全部画布」。 */
      const empty = T.addCanvas({ name: "空画布" });
      sandbox.teamPermBatchOpen(empty.id);
      ok(byId("teamPermScope").value === "all", "本画布没有专家时范围默认全部画布");
      R.closePermBatch();

      /* 无改动：不写任何专家，给提示。 */
      let calls = 0;
      const origUpdate = T.updateExpert;
      T.updateExpert = function () {
        calls++;
      };
      sandbox.teamPermBatchOpen(p.id);
      byId("teamPermApply").onclick();
      ok(calls === 0, "全部「保持不变」时不写任何专家");
      ok(
        toasts.some((t) => t[0] === "没有需要应用的改动"),
        "提示「没有需要应用的改动」",
      );
      T.updateExpert = origUpdate;
    }

    console.log(
      "\n" +
        (fails
          ? "FAILED " + fails + " / " + checks + " checks"
          : "ALL OK  " + checks + " checks"),
    );
  })();

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-team-recruit.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-team-recruit.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

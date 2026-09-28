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
  process.exit(fails ? 1 : 0);
})();

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

/* ═══════════ 沙箱：app-team.js（专家默认许可）+ app-nodes.js 权限函数切片 ═══════════ */
const nodesSrc = read("renderer/app-nodes.js");
const start = nodesSrc.indexOf("function permissionPresetOptions()");
const end = nodesSrc.indexOf("async function ensureAgentTool(");
if (start < 0 || end <= start) {
  console.error("FAIL  找不到 app-nodes.js 权限函数区段");
  process.exit(1);
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
process.exit(fails ? 1 : 0);

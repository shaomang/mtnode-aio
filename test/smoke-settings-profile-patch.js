/* 冒烟：宿主托管的设置下发（0.2 命令行叠加层）
 *
 * 背景（0.2 破坏性变更）：运行时不再把「服务商目录 / 权限预设 / 官方模型清单 / 宿主人设」
 * 当 settings.yaml 读回 —— @deepseek-ai/dsh-settings 会在 Loader 结算后把
 * <DSH_HOME>/settings.yaml **导入** active profile 并改名 .imported，之后不再读该文件。
 * 0.2 的真源是补丁层，而能打到全部四行的只有**命令行叠加层**（`--patch <file>`）：
 *   · profile 用户补丁层（profiles/sdk/cordis.patch.yml）打得到顶层行（permission 实测
 *     生效），打不到基座 `insert:` 插进来的行（llm-deepseek / system-prompt / llm-pi-ai）；
 *   · 运行时自己的 ctx.settings.update 直接拒绝：实测回
 *     「Configuration for "llm-deepseek" is overridden by a home patch or command-line overlay」。
 * 所以网关把托管四段写成 <DSH_HOME>/mtnode-settings.patch.yml，随 cordis.yml 之后下发。
 *
 * 本冒烟直连 gateway 导出的 applySettings（纯写入器，不起运行时、不联网），钉住：
 *   [1] 写出 <DSH_HOME>/mtnode-settings.patch.yml，四段都在（llm-pi-ai 只在有服务商时出现）；
 *   [2] llm-deepseek.models 带 inputModalities: [text, image]（看图轮的前置条件）；
 *   [3] 指纹未变 = 不重写（changed:false，mtime 不动）；变了才重写；
 *   [4] 服务商目录只在 llm-pi-ai.config.providers 里，密钥只经 env 引用；用户自己的补丁
 *       文件（profile 层）不被本写入器碰；
 *   [5] 人设为空 = 不写 system-prompt 行。
 * 「真的抵达运行时」由 test/smoke-config-probe.js 端到端核（config/probe 桥）。
 *
 * 跑法：node test/smoke-settings-profile-patch.js
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ " + label);
  }
}

const GATEWAY = path.resolve(__dirname, "..", "dsh", "gateway", "gateway.mjs");

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-settings-patch-"));
  const overlayFile = path.join(home, "mtnode-settings.patch.yml");
  const userPatchFile = path.join(home, "profiles", "sdk", "cordis.patch.yml");
  console.log("settings-profile-patch smoke — home=" + home);

  let applySettings;
  let yaml;
  try {
    /* import gateway.mjs 会跑它的模块级初始化（用户插件目录 / 挂载状态都按 DSH_HOME 定位）。
       先把 DSH_HOME 指到本次临时目录，避免测试去碰仓库里 dsh/gateway/cordis.yml —— 测试
       只该读被测函数，不该有副作用落到源码树。 */
    process.env.DSH_HOME = home;
    const mod = await import(pathToFileURL(GATEWAY).href);
    applySettings = mod.applySettings;
    yaml = require(path.resolve(__dirname, "..", "dsh", "gateway", "node_modules", "yaml"));
  } catch (err) {
    console.log("  ✗ 无法加载网关模块 / yaml：" + String((err && err.message) || err));
    process.exitCode = 1;
    return;
  }
  ok(typeof applySettings === "function", "gateway.mjs 导出 applySettings");

  /* 用户自己的补丁（profile 层）——本写入器一个字都不该动它 */
  fs.mkdirSync(path.dirname(userPatchFile), { recursive: true });
  const userPatchText = ["# 用户自己的补丁层", "- id: tool-bash", "  disabled: true", ""].join("\n");
  fs.writeFileSync(userPatchFile, userPatchText, "utf8");

  const providers = [
    {
      route: "my-relay",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-not-a-real-key",
      models: ["kimi-k2", "glm-4.5"],
    },
  ];
  const officialModels = [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 131072, maxTokens: 8192, inputModalities: ["text", "image"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 131072, maxTokens: 8192, inputModalities: ["text"] },
  ];

  /* ── 第一次写：全量托管段 ─────────────────────────────────────────────── */
  const r1 = applySettings(home, "high", providers, "workspace-write", "你是 MTNode 的助手。", officialModels);
  ok(r1.changed === true, "[1] 首次调用 changed=true");
  ok(r1.envPatch.MTNODE_KEY_1 === "sk-not-a-real-key", "[1] 服务商密钥走 envPatch（MTNODE_KEY_1），不落盘");
  ok(fs.existsSync(overlayFile), "[1] 写出 mtnode-settings.patch.yml（命令行叠加层）");
  ok(r1.overlayFile === overlayFile, "[1] 回执带回叠加层路径（建运行时据此下发 --patch）");
  ok(!fs.existsSync(path.join(home, "settings.yaml")), "[1] 不再写 settings.yaml（0.2 已不读它）");
  ok(fs.readFileSync(userPatchFile, "utf8") === userPatchText, "[4] 用户自己的 profile 补丁层未被碰");

  let rows = yaml.parse(fs.readFileSync(overlayFile, "utf8"));
  ok(Array.isArray(rows), "[1] 叠加层是顶层 YAML 数组");
  const byId = new Map((rows || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  ok(byId.size === (rows || []).length, "[4] 托管 id 无重复");
  ok(!!byId.get("llm-pi-ai"), "[1] 有服务商时写 llm-pi-ai");
  const route = byId.get("llm-pi-ai") && byId.get("llm-pi-ai").config && byId.get("llm-pi-ai").config.providers["mtnode_my-relay"];
  ok(!!route, "[1] 服务商路由 mtnode_my-relay 进 providers");
  ok(route && route.apiKeyEnv === "MTNODE_KEY_1", "[1] 路由只写 apiKeyEnv 引用，不写密钥值");
  ok(route && route.baseURL === "https://example.invalid/v1", "[1] 路由写 baseURL");
  ok(route && route.api === "openai-completions", "[1] 通用路由写 api 声明（目录同源路由才省略：模型级 api 以目录为准）");
  ok(route && Array.isArray(route.models) && route.models[0].id === "kimi-k2", "[1] 模型清单按 id 写出");
  ok(byId.get("llm-deepseek") && byId.get("llm-deepseek").config.reasoningEffort === "high", "[1] llm-deepseek 写兜底思考档");
  const models = (byId.get("llm-deepseek") || { config: {} }).config.models || [];
  const flash = models.find((m) => m.id === "deepseek-v4-flash");
  ok(!!flash, "[2] llm-deepseek.models 含 deepseek-v4-flash");
  ok(flash && Array.isArray(flash.inputModalities) && flash.inputModalities.includes("image"), "[2] 视觉模型带 inputModalities: [text, image]");
  ok(byId.get("permission") && byId.get("permission").config.defaultPreset === "workspace-write", "[1] permission.defaultPreset 写出");
  ok(byId.get("system-prompt") && byId.get("system-prompt").config.personaPrefix === "你是 MTNode 的助手。", "[1] 宿主人设写 system-prompt.personaPrefix（0.2 字段名，纯文本）");
  ok(byId.get("system-prompt") && byId.get("system-prompt").config.includeHarnessIdentity === false, "[1] 宿主人设行同时关掉引擎身份段（与旧口径一致）");

  /* ── 指纹未变：不重写 ────────────────────────────────────────────────── */
  const before = fs.statSync(overlayFile).mtimeMs;
  const r2 = applySettings(home, "high", providers, "workspace-write", "你是 MTNode 的助手。", officialModels);
  ok(r2.changed === false, "[3] 同参数二次调用 changed=false");
  ok(fs.statSync(overlayFile).mtimeMs === before, "[3] 未变则不重写（mtime 不动）");

  /* ── 改档重写 + 人设清空 ─────────────────────────────────────────────── */
  const r3 = applySettings(home, "low", providers, "workspace-write", "", officialModels);
  ok(r3.changed === true, "[3] 思考档变化触发重写");
  rows = yaml.parse(fs.readFileSync(overlayFile, "utf8"));
  const managed = rows.filter((r) => r && ["llm-deepseek", "llm-pi-ai", "permission", "system-prompt"].includes(r.id));
  ok(managed.length === 3, "[5] 人设为空 = 不写 system-prompt（只剩 3 条托管行）");
  ok(rows.find((r) => r && r.id === "llm-deepseek").config.reasoningEffort === "high", "[5] 思考档仍只写兜底默认 high（档位走 env MTNODE_EFFORT）");
  ok(fs.readFileSync(userPatchFile, "utf8") === userPatchText, "[4] 重写后用户的 profile 补丁层仍未被碰");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("\nsettings-profile-patch smoke: pass " + pass + " / fail " + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

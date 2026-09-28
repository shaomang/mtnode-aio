"use strict";
/**
 * 从 dsh-home/settings.yaml 恢复 config.json 中的 providers 结构（不含 API Key）。
 * 用法: node scripts/recover-config-from-dsh.js [dataDir]
 */
const fs = require("fs");
const path = require("path");

const dataDir =
  process.argv[2] ||
  path.join(process.env.APPDATA || "", "pipeline-console", "pipeline-console");
const configPath = path.join(dataDir, "config.json");
const settingsPath = path.join(dataDir, "dsh-home", "settings.yaml");

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function parseSettingsProviders(yaml) {
  const lines = String(yaml || "").split(/\r?\n/);
  const providers = [];
  let cur = null;
  let inModels = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const mRoute = line.match(/^ {4}([^:\s][^:]*):$/);
    if (mRoute) {
      if (cur) providers.push(cur);
      const route = mRoute[1].trim();
      const id = route.startsWith("mtnode_") ? route.slice("mtnode_".length) : route;
      cur = {
        id,
        route,
        baseUrl: "",
        api: "openai-completions",
        models: [],
      };
      inModels = false;
      continue;
    }
    if (!cur) continue;
    const mBase = line.match(/^ {6}baseURL:\s*(.+)$/);
    if (mBase) {
      cur.baseUrl = mBase[1].trim();
      continue;
    }
    const mApi = line.match(/^ {6}api:\s*(.+)$/);
    if (mApi) {
      cur.api = mApi[1].trim();
      continue;
    }
    if (/^ {6}models:\s*$/.test(line)) {
      inModels = true;
      continue;
    }
    const mModel = line.match(/^ {8}- id:\s*(.+)$/);
    if (inModels && mModel) cur.models.push(mModel[1].trim());
  }
  if (cur) providers.push(cur);
  return providers;
}

function friendlyName(route, baseUrl) {
  if (route === "qwen-token-plan-cn") return "阿里云百炼兼容";
  if (baseUrl.includes("opencode.ai")) return "OpenCode Go";
  if (baseUrl.includes("apiyi.com")) return "API易";
  if (route.startsWith("pm")) return route;
  return route;
}

function toConfigProvider(p) {
  const baseUrl = String(p.baseUrl || "").trim();
  const models = (p.models || []).slice();
  const hasVision = models.some((m) => /vision/i.test(m));
  return {
    id: p.id,
    name: friendlyName(p.route, baseUrl),
    type: "text_openai",
    baseUrl,
    api: p.api || "openai-completions",
    source: p.route.startsWith("mtnode_") ? p.route.slice("mtnode_".length) : p.route,
    apiKey: "",
    models,
    vision: hasVision,
  };
}

function main() {
  if (!fs.existsSync(settingsPath)) {
    console.error("settings.yaml not found:", settingsPath);
    process.exit(1);
  }
  const yaml = fs.readFileSync(settingsPath, "utf8");
  const parsed = parseSettingsProviders(yaml);
  if (!parsed.length) {
    console.error("No providers found in settings.yaml");
    process.exit(1);
  }

  const cfg = readJson(configPath, {
    version: 1,
    snap: 24,
    activeWorkflowId: "default",
    providers: [],
    locale: "zh",
  });
  const restored = parsed.map(toConfigProvider);
  const keepIds = new Set(restored.map((p) => p.id));
  const others = (cfg.providers || []).filter((p) => !keepIds.has(p.id));
  cfg.providers = restored.concat(others);

  const bakDir = path.join(dataDir, "config-backups");
  fs.mkdirSync(bakDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, path.join(bakDir, `config-before-recover-${stamp}.json`));
  }
  const tmp = configPath + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, configPath);

  console.log("Recovered providers:");
  for (const p of restored) {
    console.log(`- ${p.name} (${p.id}) · ${p.baseUrl} · ${p.models.length} models`);
  }
  console.log("\nWrote:", configPath);
  console.log("API Key 需在各服务商后台重新复制填写。");
}

main();

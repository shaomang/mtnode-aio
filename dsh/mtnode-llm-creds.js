"use strict";
/**
 * 从 MTNode 主配置（dataDir/config.json）解析 dsh.run 所需的 LLM 凭据。
 * Music3 / H3 / 其它主进程插件应走此路径，勿依赖进程环境变量或 deepseek-official 默认路由。
 */
const fs = require("fs");
const path = require("path");

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function isDeepseekHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes("deepseek");
  } catch {
    return false;
  }
}

function modelIdsOf(p) {
  return (Array.isArray(p && p.models) ? p.models : [])
    .map((m) => (typeof m === "string" ? m : m && m.id))
    .filter(Boolean)
    .map(String);
}

function loadAppConfig(dataDir) {
  return readJson(path.join(dataDir, "config.json"), {}) || {};
}

/** 非 DeepSeek 的 OpenAI 兼容文本服务商 → 网关 mtnode_* 路由列表 */
function mtnodePiProviders(dataDir) {
  const out = [];
  const appCfg = loadAppConfig(dataDir);
  const providers = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  providers.forEach((p, i) => {
    if (!p || p.type !== "text_openai" || !String(p.apiKey || "").trim()) return;
    if (isDeepseekHost(p.baseUrl)) return;
    if (!String(p.baseUrl || "").trim() || !modelIdsOf(p).length) return;
    out.push({
      route: p.id || "p" + (i + 1),
      name: p.name || p.id,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      api: p.api || "openai-completions",
      models: modelIdsOf(p),
    });
  });
  return out;
}

function deepseekProvider(dataDir) {
  const appCfg = loadAppConfig(dataDir);
  const providers = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  for (const p of providers) {
    if (!p || p.type !== "text_openai" || !p.baseUrl) continue;
    if (!String(p.apiKey || "").trim()) continue;
    if (!isDeepseekHost(p.baseUrl)) continue;
    return p;
  }
  return null;
}

/**
 * 解析一次 dsh.run 的鉴权参数（与渲染层 dshRunTask / BongoChat 一致）。
 * @returns {{ ok: true, provider: string, apiKey: string, baseUrl: string, webSearchApiKey: string, mtnodeProviders: object[], model: string, maxTokens: number, permissionPreset: string } | { ok: false, error: string }}
 */
function resolveDshRunAuth(dataDir) {
  const appCfg = loadAppConfig(dataDir);
  const dshCfg = (appCfg && appCfg.dsh) || {};
  const piProvs = mtnodePiProviders(dataDir);
  const dsProv = deepseekProvider(dataDir);

  let provider = "deepseek-official";
  if (dsProv && String(dsProv.apiKey || "").trim()) {
    provider = "deepseek-official";
  } else if (piProvs.length) {
    provider = "mtnode_" + piProvs[0].route;
  } else {
    return {
      ok: false,
      error:
        "未配置可用的文本服务商 API Key。请在 MTNode「设置 · API/配置 → 模型服务」填写后重试（不要依赖系统环境变量）。",
    };
  }

  let apiKey = (dsProv && dsProv.apiKey) || "";
  let baseUrl = (dsProv && dsProv.baseUrl) || "";
  if (provider !== "deepseek-official") {
    const mp = piProvs.find((x) => "mtnode_" + x.route === provider);
    if (mp) {
      apiKey = mp.apiKey;
      baseUrl = mp.baseUrl;
    } else {
      apiKey = "";
      baseUrl = "";
    }
  }

  if (!String(apiKey || "").trim()) {
    return {
      ok: false,
      error:
        "未配置可用的文本服务商 API Key。请在 MTNode「设置 · API/配置 → 模型服务」填写后重试。",
    };
  }

  const webSearchApiKey =
    String((dsProv && dsProv.apiKey) || "").trim() ||
    (provider === "deepseek-official" ? String(apiKey || "").trim() : "");

  let model = String(dshCfg.model || "").trim();
  if (!model) {
    if (provider === "deepseek-official" && dsProv) {
      model = modelIdsOf(dsProv)[0] || "deepseek-v4-flash";
    } else {
      const mp = piProvs.find((x) => "mtnode_" + x.route === provider);
      model = (mp && mp.models && mp.models[0]) || "deepseek-v4-flash";
    }
  }

  return {
    ok: true,
    provider,
    apiKey,
    baseUrl,
    webSearchApiKey,
    mtnodeProviders: piProvs,
    model,
    maxTokens: Number(dshCfg.maxTokens) || 49152,
    permissionPreset: dshCfg.permissionPreset || "mtnode-unattended",
  };
}

module.exports = {
  loadAppConfig,
  mtnodePiProviders,
  deepseekProvider,
  resolveDshRunAuth,
  isDeepseekHost,
};

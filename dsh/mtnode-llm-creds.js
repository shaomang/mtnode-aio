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

/* ── MTNode 中转服务（source="mtnode-relay"）的凭据 ──────────────────────────
   这张服务商卡的 apiKey **就是中转 Key 本身**（由主进程写进 config.json，
   见 docs/relay-admin.md）：设置卡上显示全文、可复制，桌宠 / 插件宿主这些独立进程
   读同一份配置即可用，所以本模块**直接读 p.apiKey**。
   两种情形仍然要挡住：
     · 卡上还是占位串 mtnode-account-token（= 这张卡还没拿到真票）→ 视为没有凭据；
     · 同进程里主进程注入过 setRelayKeyResolver（老配置迁移态 / 票刚被 401 清掉）→ 用它的返回值。
   两条都拿不到就**跳过该服务商**，绝不把占位串当 Key 发出去（那会 401，报错还看不出原因）。 */
const RELAY_PLACEHOLDER = "mtnode-account-token";
let relayKeyResolver = null;
function setRelayKeyResolver(fn) {
  relayKeyResolver = typeof fn === "function" ? fn : null;
}
function apiKeyOf(p) {
  const raw = String((p && p.apiKey) || "").trim();
  if (p && String(p.source || "") === "mtnode-relay") {
    if (raw && raw !== RELAY_PLACEHOLDER) return raw;
    return relayKeyResolver ? String(relayKeyResolver(p) || "").trim() : "";
  }
  return raw;
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
    const key = apiKeyOf(p);
    if (!p || p.type !== "text_openai" || !key) return;
    if (isDeepseekHost(p.baseUrl)) return;
    if (!String(p.baseUrl || "").trim() || !modelIdsOf(p).length) return;
    out.push({
      route: p.id || "p" + (i + 1),
      name: p.name || p.id,
      baseUrl: p.baseUrl,
      apiKey: key,
      /* source 一并带上：调用方（主进程插件宿主）据此知道这张卡的凭据来自哪里；
         中转卡的 Key 在上面的 apiKeyOf() 里已经取好（配置里那一串，或注入的解析器）。 */
      source: String(p.source || ""),
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
    if (!apiKeyOf(p)) continue;
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

  let apiKey = dsProv ? apiKeyOf(dsProv) : "";
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
    String((dsProv && apiKeyOf(dsProv)) || "").trim() ||
    (provider === "deepseek-official" ? String(apiKey || "").trim() : "");

  let model = String(dshCfg.model || "").trim();
  if (!model) {
    if (provider === "deepseek-official" && dsProv) {
      model = modelIdsOf(dsProv)[0] || "deepseek-flash";
    } else {
      const mp = piProvs.find((x) => "mtnode_" + x.route === provider);
      model = (mp && mp.models && mp.models[0]) || "deepseek-flash";
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
    maxTokens: (() => {
      const n = Number(dshCfg.maxTokens);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    })(),
    permissionPreset: dshCfg.permissionPreset || "mtnode-unattended",
  };
}

module.exports = {
  loadAppConfig,
  mtnodePiProviders,
  deepseekProvider,
  resolveDshRunAuth,
  isDeepseekHost,
  setRelayKeyResolver,
  apiKeyOf,
};

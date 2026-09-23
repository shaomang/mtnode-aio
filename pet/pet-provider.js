"use strict";
/**
 * 桌宠 BongoChat 的对话服务商解析（纯函数，无 Electron 依赖）。
 *
 * 为什么单独一个模块：桌宠对话跑在独立进程（pet/standalone-main.js）与本地调试脚本里，
 * 服务商列表 / 路由决议必须与渲染层（renderer/app.js 的 dshProvider /
 * mtnodePiProviders / agentRouteFromProviderId）同口径 —— 尤其「DeepSeek 官方」：
 * 它走 llm-deepseek 官方路由（provider 串 = "deepseek-official"），既不写进
 * mtnode_* 路由表，也不是普通的 text_openai 行，任何一处漏掉它就表现为
 * 「选不到 / 选了也被降级成别家」。
 */
const DEFAULT_DEEPSEEK_BASE = "https://api.deepseek.com";
const DEEPSEEK_OFFICIAL_ROUTE = "deepseek-official";

/** baseUrl 是否指向 DeepSeek（官方路由判据，与 app.js 的 dshProvider 同口径）。 */
function isDeepseekHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes("deepseek");
  } catch {
    return false;
  }
}

/** model 归一成字符串 id（配置里两种存法都出现过：纯字符串 / {id} 对象）。 */
function modelIdsOf(p) {
  return (Array.isArray(p && p.models) ? p.models : [])
    .map((m) => (typeof m === "string" ? m : m && m.id))
    .filter(Boolean)
    .map(String);
}

function isTextProvider(p) {
  return !!p && p.type === "text_openai";
}

function hasUsableCreds(p) {
  return !!(
    p &&
    String(p.baseUrl || "").trim() &&
    String(p.apiKey || "").trim() &&
    modelIdsOf(p).length
  );
}

/** 第一个可用的 DeepSeek 官方文本服务商（设置里那行 id 通常为 "deepseek"）。 */
function officialTextProvider(appCfg) {
  const providers = Array.isArray(appCfg && appCfg.providers) ? appCfg.providers : [];
  for (const p of providers) {
    if (!isTextProvider(p)) continue;
    if (!String(p.apiKey || "").trim()) continue;
    if (isDeepseekHost(p.baseUrl)) return p;
  }
  return null;
}

/**
 * 对话页「服务商」下拉的数据源。
 * DeepSeek 官方**必须**在这里出现（值 = "deepseek-official"，与引擎路由同名）：
 * 漏掉它，用户就在桌宠里选不到官方供应商，而配置里存的 "deepseek" 又因为
 * 不在列表里被前端回落到第一家第三方服务商（选中的显示与实际请求的服务商不一致）。
 */
function listTextProviders(appCfg) {
  const providers = Array.isArray(appCfg && appCfg.providers) ? appCfg.providers : [];
  const out = [];
  if (officialTextProvider(appCfg)) {
    out.push({
      id: DEEPSEEK_OFFICIAL_ROUTE,
      name: "DeepSeek 官方",
      baseUrl: DEFAULT_DEEPSEEK_BASE,
      models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"],
    });
  }
  providers.forEach((p, i) => {
    if (!isTextProvider(p)) return;
    if (isDeepseekHost(p.baseUrl)) return; /* 官方已由上面一行代表 */
    if (!hasUsableCreds(p)) return;
    out.push({
      id: String(p.id || "p" + (i + 1)),
      name: String(p.name || p.id || "provider"),
      baseUrl: String(p.baseUrl || ""),
      models: modelIdsOf(p),
    });
  });
  return out;
}

/**
 * 解析本轮对话真正要用的服务商与模型（cfg = pet/config.json）。
 * 返回的 provider 原样带 apiKey：路由与密钥都按它下发，
 * 官方路由的 apiKey 就是 DeepSeek 官方 Key（联网搜索也用这一把）。
 */
function resolveChatProvider(cfg, appCfg) {
  const c = cfg || {};
  const providers = Array.isArray(appCfg && appCfg.providers) ? appCfg.providers : [];
  const official = officialTextProvider(appCfg);
  const thirdParty = providers.filter((p) => isTextProvider(p) && !isDeepseekHost(p.baseUrl) && hasUsableCreds(p));

  const wantId = String(c.chatProviderId || "").trim();
  let p = null;
  if (wantId) {
    /* 官方那一行有两个可能的存法：下拉现在用的路由名 "deepseek-official" 与配置里的
       行 id / 名称（真机历史值是 "deepseek"）—— 按 routeNameOf 归一后比对。 */
    if (official && routeNameOf(wantId, appCfg) === DEEPSEEK_OFFICIAL_ROUTE) p = official;
    else p = thirdParty.find((x) => String(x.id || "") === wantId || String(x.name || "") === wantId) || null;
  }
  /* 没点名（或点的那家已从配置里删掉）→ 保持旧兜底：优先第三方，都没有才用官方 */
  if (!p) p = thirdParty[0] || official || null;
  if (!p) return null;

  const models = modelIdsOf(p);
  const wantModel = String(c.chatModel || "").trim();
  /* 只认「这个服务商真有的模型」：选过别家之后旧模型仍留在配置里时，
     按旧模型下发会被对端 404（模型不存在），所以落到该服务商的首个模型。 */
  const model = (wantModel && models.includes(wantModel) ? wantModel : models[0]) || "deepseek-v4-flash";
  return { provider: p, model: String(model) };
}

/**
 * 非 DeepSeek 的 OpenAI 兼容文本服务商 → 网关 mtnode_* 路由列表
 * （DeepSeek 官方走 llm-deepseek，不进这张表）。
 */
function mtnodePiProviders(appCfg) {
  const out = [];
  const providers = Array.isArray(appCfg && appCfg.providers) ? appCfg.providers : [];
  providers.forEach((p, i) => {
    if (!isTextProvider(p) || !String(p.apiKey || "").trim()) return;
    if (isDeepseekHost(p.baseUrl)) return;
    if (!String(p.baseUrl || "").trim() || !(p.models || []).length) return;
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

/** 配置里的服务商行 → 网关路由串（官方 = deepseek-official，其余 = mtnode_<id>）。 */
function dshRouteForProvider(p) {
  if (!p) return DEEPSEEK_OFFICIAL_ROUTE;
  if (isDeepseekHost(p.baseUrl)) return DEEPSEEK_OFFICIAL_ROUTE;
  return "mtnode_" + String(p.id || "p");
}

/**
 * 已保存的 chatProviderId → 下拉里的选项值。
 * 历史配置存的是官方那一行的行 id / 名称（真机上是 "deepseek"），而下拉的官方项
 * 值是路由名 "deepseek-official"：不对齐就会「存的是官方、面板却选中别家」。
 */
function routeNameOf(savedId, appCfg) {
  const want = String(savedId || "").trim();
  if (!want) return "";
  const official = officialTextProvider(appCfg);
  if (official) {
    const names = [DEEPSEEK_OFFICIAL_ROUTE, String(official.id || ""), String(official.name || "")]
      .filter(Boolean)
      .map(String);
    if (names.includes(want)) return DEEPSEEK_OFFICIAL_ROUTE;
  }
  return want;
}

/** 配置里 DeepSeek 官方那一行的 apiKey（联网搜索固定用它），没有则空串。 */
function deepseekWebSearchKey(appCfg) {
  const p = officialTextProvider(appCfg);
  return p ? String(p.apiKey || "").trim() : "";
}

module.exports = {
  DEFAULT_DEEPSEEK_BASE,
  DEEPSEEK_OFFICIAL_ROUTE,
  isDeepseekHost,
  modelIdsOf,
  officialTextProvider,
  listTextProviders,
  resolveChatProvider,
  mtnodePiProviders,
  dshRouteForProvider,
  routeNameOf,
  deepseekWebSearchKey,
};
"use strict";
/* ============================================================
 * renderer/app-brief-model.js — 「简报模型」：设置口径 + 一次性调用通道 + 用量记账
 *
 * 简报（这次会话跑到哪儿了的一页白话，内核见 app-brief.js）由模型写，但**不写回会话**：
 * 它是一次独立的一次性调用，请求里只有「系统提示 + 这一份输入」，不带任何会话历史
 * —— 否则简报会把主会话的上下文再喂一遍，既污染口径也白烧 token。
 *
 * 三件事（只此三件）：
 *   ① 设置口径：真源 config.dsh.brief = { provider, model }（会话「模型」菜单里那一格，
 *      紧挨「上下文压缩」）。provider 为空 = **跟随该会话当前 provider / model**（缺省档，
 *      不是「没配」—— 所以那一格既不置灰，也没有「未配置」这种状态）。
 *      provider 写成 route（"deepseek-official" / "mtnode_<卡 id>"，与
 *      dsh/gateway/gateway.mjs 的 routeOfProvider 同口径），费用面板按它找卡。
 *   ② 一次性调用 briefModelOnce(opts)：复用主进程既有 apiCall 内核 —— 经渲染层已有的
 *      文本通道 window.api.apiCall（main.js 的 api:call，与 apps-store 的 aiCall /
 *      fn-runtime 的 aiCallStream 同一份内核），本文件**不新造网络层**。
 *      手选那一档只下发 brief:true，提供商与模型由主进程按 syncBriefModel 同步过去的
 *      同一份快照补（渲染层不必再解析一次路由 → 服务商）。
 *   ③ 用量记账 briefAccountUsage()：走 app-agent.js 的 tokAddCompactionRound（与「上下文
 *      压缩」轮次同一套：合计 / 按模型桶 / 一条轮次明细），费用面板照常可见。
 *
 * 一处不精确（写在这里，免得以后当成 bug 查）：主进程 api:call 的回执只有 text /
 * finishReason，内核不回 usage，所以 input / output token 按「1 token ≈ 2 字符」估
 * （与手动压缩同一个常数，见 app-dsh-compact.js 的 COMPACT_CHARS_PER_TOKEN）。
 * ============================================================ */

/* 1 token ≈ 2 字符（与 app-dsh-compact.js 的 COMPACT_CHARS_PER_TOKEN 同值；这里不跨文件
   引用，免得那一份改值时本文件悄悄跟着变而不自知） */
const BRIEF_CHARS_PER_TOKEN = 2;
/* 简报是「重写整份」的活，温度低一点更稳（不追求花样） */
const BRIEF_TEMPERATURE = 0.3;

/** 读回归一后的设置：{ provider, model }；provider 空 = 跟随会话模型（model 一并忽略）。 */
function briefModelOf(cfg) {
  const b = (cfg && cfg.dsh && cfg.dsh.brief) || {};
  const provider = String(b.provider || "").trim();
  if (!provider) return { provider: "", model: "" };
  return { provider, model: String(b.model || "").trim() };
}

/** 设置格 / 菜单项的回显值：手选 → 「服务商名 · 模型」，缺省 → 「跟随会话模型」 */
function briefModelMenuValue(cfg) {
  const b = briefModelOf(cfg || (typeof S !== "undefined" ? S.config : null));
  if (!b.provider) return I18n.t("跟随会话模型");
  const name =
    typeof agentProviderNameNow === "function"
      ? agentProviderNameNow(b.provider)
      : b.provider;
  return b.model ? name + " · " + b.model : name;
}

/** 写回（唯一入口）：route 空 = 改回「跟随会话模型」。落盘链与「上下文压缩」同一条
    （persistAssistUi → configSave → main.js 的 syncBriefModel 同步一份到主进程）。 */
function setBriefModel(route, model) {
  if (typeof S === "undefined" || !S || !S.config) return false;
  const r = String(route || "").trim();
  if (!S.config.dsh) S.config.dsh = {};
  S.config.dsh.brief = { provider: r, model: r ? String(model || "").trim() : "" };
  persistAssistUi();
  toast(
    r ? I18n.t("简报模型已更新") : I18n.t("简报模型已改为跟随会话模型"),
    "ok",
  );
  return true;
}

/* ── 用量记账 ──────────────────────────────────────────────────────────────
   与 app-agent.js 的 tokAddCompactionRound 同一套（合计 rounds / 按模型桶 / roundList 一条
   明细，标题「简报模型」）。**不碰在途台账**（_tokLive / _tokLiveRound）：简报常常在主会话
   正跑着的时候生成，踩掉在途数字比少记一条明细糟得多。 */
function briefAccountUsage(o) {
  const owner =
    typeof agentSessionState === "function" ? agentSessionState() : null;
  if (!owner || typeof tokAddCompactionRound !== "function") return null;
  const per = BRIEF_CHARS_PER_TOKEN;
  const inTok = Math.max(0, Math.round(tokNum(o && o.inputChars) / per));
  const outTok = Math.max(0, Math.round(tokNum(o && o.outputChars) / per));
  const startedAt = tokNum(o && o.startedAt) || Date.now();
  const endedAt = tokNum(o && o.endedAt) || startedAt;
  return tokAddCompactionRound(owner, null, {
    provider: String((o && o.route) || ""),
    model: String((o && o.model) || ""),
    usage: { inputTokens: inTok, outputTokens: outTok, calls: 1 },
    startedAt: startedAt,
    endedAt: endedAt,
    wallMs: Math.max(0, endedAt - startedAt),
    title: "简报模型",
    runKey: "brief",
    rid: "brief:" + tokOwnerId(owner) + ":" + endedAt,
  });
}

/* ── 一次性调用通道 ─────────────────────────────────────────────────────────
   opts：{ system, user, temperature, effort }（user 与 prompt 同义）。
   回执：{ ok, text, provider, model, finishReason } 或 { ok:false, error, provider, model }。
   · 请求里**只有这两段文本**：不带会话消息、不带工具、不带系统人设 —— 调用完对会话历史
     零影响（这正是它和「在主会话里问一句」的区别）。
   · 手选那一档：只传 brief:true，provider / model 由主进程按快照补；
     跟随那一档：用**本次会话当前**的 provider / model（会与主会话争并发，成本也按那只算）。 */
async function briefModelOnce(opts) {
  const o = opts || {};
  const system = String(o.system || "").trim();
  const user = String(o.user || o.prompt || "").trim();
  if (!user) return { ok: false, error: I18n.t("简报调用缺少输入正文") };
  const api = typeof window !== "undefined" ? window.api : null;
  if (!api || typeof api.apiCall !== "function")
    return { ok: false, error: I18n.t("模型调用通道不可用") };

  const st = typeof agentSessionState === "function" ? agentSessionState() : null;
  const pick = briefModelOf(typeof S !== "undefined" ? S.config : null);
  const followRoute =
    typeof agentSessionProviderRoute === "function" && st
      ? agentSessionProviderRoute(st)
      : "";
  const route = pick.provider || String(followRoute || "");
  const model =
    pick.provider
      ? pick.model
      : st && typeof agentModelName === "function"
        ? String(agentModelName(st) || "")
        : String((st && st.model) || "");

  const chatMessages = [];
  /* 系统段只在调用方给了才发：简报的写法约束（白话、不写文件名）本来就写在提示词里，
     这里不再叠一层人设，免得与 app-brief.js 的口径打架 */
  if (system) chatMessages.push({ role: "system", content: system });
  chatMessages.push({ role: "user", content: user });

  /* 没有模型就没得调：手选那只、会话那只都拿不到时如实报错，不猜一只替上去 */
  if (!model)
    return {
      ok: false,
      error: I18n.t("简报模型：当前没有可用的模型，请先在「简报模型」里选一只"),
      provider: route,
      model: "",
    };

  const spec = {
    kind: "text",
    chatMessages: chatMessages,
    temperature: Number.isFinite(Number(o.temperature))
      ? Number(o.temperature)
      : BRIEF_TEMPERATURE,
    /* 简报不需要思考：省时间也省钱（服务商不支持时会按各自口径忽略） */
    effort: String(o.effort || "off"),
  };
  if (pick.provider) {
    spec.brief = true;
  } else {
    let provider = null;
    try {
      provider =
        typeof providerForAgentRoute === "function"
          ? providerForAgentRoute(route)
          : null;
    } catch (_) {
      provider = null;
    }
    if (!provider)
      return {
        ok: false,
        error: I18n.t("简报模型：当前会话的服务商不可用"),
        provider: route,
        model: model,
      };
    spec.provider = provider;
    spec.model = model;
  }

  const startedAt = Date.now();
  let r = null;
  try {
    r = await api.apiCall(spec);
  } catch (e) {
    return {
      ok: false,
      error: String((e && e.message) || e),
      provider: route,
      model: model,
    };
  }
  const endedAt = Date.now();
  if (!r || !r.ok)
    return {
      ok: false,
      error: String((r && r.error) || I18n.t("简报调用失败")),
      provider: route,
      model: model,
    };
  const text = String(r.text || "");
  /* 一次真实调用才记账（失败的那次不计：与「写盘成功才算一次」同一口径） */
  briefAccountUsage({
    route: route,
    model: model,
    inputChars: system.length + user.length,
    outputChars: text.length,
    startedAt: startedAt,
    endedAt: endedAt,
  });
  return {
    ok: true,
    text: text,
    provider: route,
    model: model,
    finishReason: String(r.finishReason || ""),
  };
}

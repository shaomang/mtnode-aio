"use strict";
/* MTNode 中转服务的**客户端**回归 —— 零依赖，`node test/smoke-relay-client.js`
 *
 * 服务端本体的回归在 test/smoke-relay.js（中转站计费 / 门禁 / 管理台 / 会话测试）。
 * 这一份钉住「云端清单如何落到客户端、以及那张卡长什么样」，需求口径见 docs/relay-admin.md：
 *   [1] 凭据不落盘：provider 只落占位串，真 token 由主进程现取（config.json 里没有凭据）
 *   [2] 只读边界：卡上没有一处可改接入信息的输入框；能改的只有启用开关与本机优先级
 *   [3] 可见性：everRecharged=false ⇒ 连卡都不建；余额耗尽 ⇒ 卡在但置灰且不可被引用
 *   [4] 刷新时机：登录成功 / 充值成功 / 打开卡（>24h）/ 手动「刷新」
 *   [5] 位置规则：名下还有别的可用服务商就追加到末尾，一个都没有才置顶
 *   [6] 服务端同步字段：models[].kind = text/image、everRecharged 只认本人流水（含人工调账）
 *   [7] 各处接线：index.html 顺序 / preload 桥 / IPC / DSH 会话参数 / 插件宿主解析器
 *   [8] i18n：新文案都有英文键（未译会回退中文，但英文界面会中英混排）
 *   [9] 文档与部署：docs/relay-admin.md 与部署自检都在
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const has = (rel, needle) => read(rel).includes(needle);
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* 取一个具名函数的函数体（跳过字符串与注释里的花括号），用于「只读卡里有没有输入框」这类结构断言 */
function fnBody(rel, name) {
  const src = read(rel);
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  const from = src.indexOf("{", at);
  if (from < 0) return "";
  let depth = 0;
  let i = from;
  let quote = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === "\\") i += 2;
      else if (c === quote) {
        quote = "";
        i++;
      } else i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      const j = src.indexOf("\n", i);
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const j = src.indexOf("*/", i);
      i = j < 0 ? src.length : j + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
    i++;
  }
  return src.slice(from);
}

function main() {
  /* ── [1] 凭据不落盘 ───────────────────────────────────────────── */
  console.log("[1] 凭据不落盘（config.json 里只有占位串）");
  ok(
    has("main.js", 'const RELAY_PROVIDER_SOURCE = "mtnode-relay"') &&
      has("main.js", 'const RELAY_KEY_PLACEHOLDER = "mtnode-account-token"'),
    "main.js 有来源标识与占位串常量（两处口径同源）",
  );
  const authKeyBody = fnBody("main.js", "providerAuthKey");
  ok(
    authKeyBody.includes("authStore.load()") &&
      authKeyBody.includes("cur.token") &&
      authKeyBody.includes("RELAY_PROVIDER_SOURCE"),
    "providerAuthKey：中转服务现取账号登录 token，其余服务商用配置里的 Key",
  );
  const specBody = fnBody("main.js", "buildRequestSpec");
  ok(
    specBody.includes("providerAuthKey(provider)") &&
      !specBody.includes('"Bearer " + provider.apiKey'),
    "buildRequestSpec 的 Authorization 走 providerAuthKey（不再直取 provider.apiKey）",
  );
  const checkBody = fnBody("main.js", "checkProvider");
  ok(
    checkBody.includes("relay.blocked") && checkBody.includes("providerAuthKey(provider)"),
    "checkProvider：余额耗尽 / 未登录在发请求前就给出可执行的错（不等上游 402）",
  );
  ok(
    has("renderer/app-relay.js", "apiKey: KEY_PLACEHOLDER") &&
      has("renderer/app-relay.js", 'var KEY_PLACEHOLDER = "mtnode-account-token"'),
    "渲染层只往配置里写占位串（真凭据一辈子不进 config.json）",
  );
  ok(
    !/localStorage|sessionStorage/.test(read("renderer/app-relay.js")),
    "中转模块不往渲染层存储里塞任何东西（无 localStorage / sessionStorage）",
  );
  ok(
    has("preload.js", "relayMe: () => ipcRenderer.invoke('relay:me')") &&
      has("main.js", 'ipcMain.handle("relay:me"'),
    "拉取只走主进程桥（渲染层拿不到 token，也拼不出任意 URL）",
  );

  /* ── [2] 只读边界 ───────────────────────────────────────────── */
  console.log("[2] 只读边界：接入信息一处都不许手改");
  const card = fnBody("renderer/app-settings.js", "relayProvCard");
  ok(card.length > 500, "找到 relayProvCard（只读卡渲染函数）");
  ok(
    card.includes("由账号登录态托管（只读）") && card.includes("relay-ro"),
    "API Key / Base URL / 名称 / 类型 / 形态 / 清单都以 <code> 只读展示",
  );
  ok(
    !card.includes('createElement("input")') ||
      (card.match(/createElement\("input"\)/g) || []).length === 1,
    "卡里只有一个 input（启用开关），没有可编辑字段输入框",
  );
  ok(
    card.includes('offCb.type = "checkbox"') && card.includes("providerManuallyOff"),
    "启用开关读 providerManuallyOff（余额耗尽不让勾选框自己掉）",
  );
  /* 断言代码、不听注释：只读卡的功能注释里就写着「不提供✕ 删除」 */
  const cardCode = card
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  ok(
    !cardCode.includes("✕ 删除") &&
      !cardCode.includes("del.textContent") &&
      !cardCode.includes("removedProviders"),
    "不提供删除（这张卡跟着账号走，删了也没意义）",
  );
  ok(
    card.includes('textContent = "↑"') && card.includes('textContent = "↓"'),
    "本机优先级 ↑↓ 保留（用户能把别的服务商排到它前面）",
  );
  ok(
    !/复制为自定义服务商/.test(card) && !card.includes("addProviderDialog"),
    "不提供「复制为自定义服务商」这类逃生通道",
  );
  const provCardBody = fnBody("renderer/app-settings.js", "provCard");
  ok(
    provCardBody.includes("MtRelay.isRelay(prov)") && provCardBody.includes("relayProvCard"),
    "provCard 把中转卡交给只读卡渲染（普通卡那套输入框一个都不走）",
  );
  ok(
    has("renderer/app-settings.js", "刷新中转清单") &&
      card.includes('textContent = I18n.t("刷新")') &&
      card.includes("sync({ force: true })"),
    "两处手动刷新入口：提供商页标题栏一个、卡里一个",
  );
  ok(
    card.includes("MtWallet.open") && card.includes('I18n.t("去充值")'),
    "卡上显示余额并有「去充值」入口（复用账户充值对话框）",
  );

  /* ── [3] 可见性与不可用语义 ─────────────────────────────────── */
  console.log("[3] 可见性：只有充过值的账号才有卡；余额耗尽只置灰");
  const apply = fnBody("renderer/app-relay.js", "applyDoc");
  const sync = fnBody("renderer/app-relay.js", "sync");
  ok(
    sync.includes("doc.everRecharged") && sync.includes("dropProvider()"),
    "everRecharged=false ⇒ 把卡收掉（换到没充值的账号 / 退出登录同样处理）",
  );
  ok(
    apply.includes("!doc.enabled || !ids.length") && apply.includes("models: blocked ? [] : ordered.slice()"),
    "余额耗尽：可选清单为空（各处模型选择器自动列不到它），但快照留在 relay.models",
  );
  ok(
    apply.includes("blocked: blocked") && apply.includes("everRecharged: true"),
    "卡上的 relay 快照带 blocked / everRecharged（UI 与主进程都读它）",
  );
  ok(
    apply.includes("error:") && apply.includes("errorAt"),
    "拉取失败把原因挂回卡上（沿用上次快照，不清空）",
  );
  const modelKind = read("renderer/app-model-kind.js");
  const disabled = fnBody("renderer/app-model-kind.js", "providerDisabled");
  ok(
    disabled.includes("providerManuallyOff") && disabled.includes("providerRelayBlocked"),
    "providerDisabled = 手动停用 ∪ 中转余额耗尽（统一进「不可被引用」这条闸门）",
  );
  ok(
    !/providerDisabled\s*\(prov\)\s*\{\s*return[^}]*disabled === true/.test(modelKind),
    "旧的一行版 providerDisabled 已被替换（不留两份口径）",
  );
  ok(
    has("renderer/app-model-kind.js", "function providerStateText") &&
      has("renderer/app-canvas.js", "providerStateText"),
    "选择器里的状态后缀分「已停用」与「余额不足」两种叫法（用户该做的事不同）",
  );
  ok(
    fnBody("renderer/app-settings.js", "provTile").includes("providerStateText"),
    "提供商网格角标同口径（余额不足不是「已停用」）",
  );

  /* ── [4] 刷新时机 ───────────────────────────────────────────── */
  console.log("[4] 刷新时机：登录 / 充值 / 打开卡 / 手动");
  ok(
    has("renderer/app-auth.js", "MtRelay.onAuthState"),
    "登录态每次刷新都通知中转模块（换账号必重拉、同账号走 24h 新鲜度）",
  );
  const onAuth = fnBody("renderer/app-relay.js", "onAuthState");
  ok(
    onAuth.includes("uid === lastUserId") && onAuth.includes("sync({ force: true })"),
    "换账号强制重拉；同一账号只按 24h 新鲜度决定要不要拉",
  );
  ok(
    has("renderer/app-wallet.js", "MtRelay.sync({ force: true })"),
    "充值到账立刻回拉（余额从 0 变正时卡片当场出现 / 恢复）",
  );
  ok(
    has("renderer/app-settings.js", "MtRelay.syncIfStale()") &&
      fnBody("renderer/app-settings.js", "openProviderConfigDialog").includes("syncIfStale"),
    "打开设置与打开该卡都按快照新旧决定是否自动刷（>24h 才刷）",
  );
  ok(
    has("renderer/app-relay.js", "var FRESH_MS = 24 * 3600 * 1000"),
    "快照新鲜期 = 24 小时",
  );
  const syncIfStale = fnBody("renderer/app-relay.js", "syncIfStale");
  ok(
    syncIfStale.includes("Date.now() - at < FRESH_MS") && syncIfStale.includes("skipped"),
    "syncIfStale：新鲜就直接跳过，不打扰服务端",
  );

  /* ── [5] 位置规则与本地顺序 ─────────────────────────────────── */
  console.log("[5] 位置与本地顺序");
  ok(
    apply.includes("hasUsableOther(null)") &&
      apply.includes("c.providers.push(next)") &&
      apply.includes("c.providers.unshift(next)"),
    "名下还有别的可用服务商就追加到末尾，一个都没有才置顶",
  );
  ok(
    apply.includes("next.disabled = prov.disabled === true"),
    "原地更新时保留用户排好的位置与手动停用开关（刷新不重置）",
  );
  const merge = fnBody("renderer/app-relay.js", "mergeOrder");
  ok(
    merge.includes("keep.concat(added)"),
    "刷新保留本地模型顺序：按 id 取交集，新模型追加末尾",
  );

  /* ── [6] 服务端同步字段 ─────────────────────────────────────── */
  console.log("[6] 服务端同步字段（kind / everRecharged）");
  ok(
    has("store-saas/relay.mjs", 'kind: up.kind === "image" ? "image" : "text"'),
    "relay.mjs：models[].kind 归一为 text / image（不再把上游 id 当形态）",
  );
  ok(
    !has("store-saas/relay.mjs", "({ id: m.id, kind: m.upstream })"),
    "旧的 kind: m.upstream 映射已移除（生产配置里那是 deepseek / image，客户端判不出形态）",
  );
  const meBlock = read("store-saas/server.mjs");
  ok(
    /everRecharged/.test(meBlock) && /String\(e\.userId \|\| ""\) === String\(user\.id \|\| ""\)/.test(meBlock),
    "everRecharged 只认本人流水（整账本里有别人的充值不算）",
  );
  ok(
    /e\.type === "recharge"/.test(meBlock) && /e\.type === "adjust" && Number\(e\.deltaCents\) > 0/.test(meBlock),
    "充值史 = 支付充值 + 正向人工调账（两种都算）",
  );
  ok(
    has("main.js", "relayModelKindsOf") && has("renderer/app-relay.js", "c.modelKinds[PROVIDER_ID]"),
    "服务端给的形态落进 config.modelKinds（与用户手工纠正形态同一张表）",
  );

  /* ── [7] 全局接线 ───────────────────────────────────────────── */
  console.log("[7] 接线：脚本顺序 / 桥 / 智体会话 / 插件宿主");
  const html = read("renderer/index.html");
  const iAuth = html.indexOf('<script src="app-auth.js">');
  const iRelay = html.indexOf('<script src="app-relay.js">');
  const iWallet = html.indexOf('<script src="app-wallet.js">');
  const iSettings = html.indexOf('<script src="app-settings.js">');
  ok(iRelay > iAuth && iRelay > iSettings && iWallet > iRelay, "index.html：app-auth → app-relay → app-wallet 顺序正确");
  ok(
    has("renderer/style.css", 'css/components.css') && has("renderer/css/components.css", ".relay-card"),
    "中转卡样式在 css/components.css（本来就在这里放 .prov-* ）",
  );
  ok(
    has("main.js", "function dshParamsWithRelayKey") && has("main.js", "dshParamsWithRelayKey(params)"),
    "智体会话（DSH）参数里的占位串换成账号 token 后再进网关",
  );
  ok(
    has("main.js", 'require("./dsh/mtnode-llm-creds.js").setRelayKeyResolver(providerAuthKey)') &&
      has("dsh/mtnode-llm-creds.js", "setRelayKeyResolver"),
    "插件宿主（Music3 / H3）解析 dsh.run 凭据时注入同一份解析器",
  );
  ok(
    fnBody("dsh/mtnode-llm-creds.js", "apiKeyOf").includes('String(p.source || "") === "mtnode-relay"'),
    "解析不到中转凭据就跳过该服务商（绝不把占位串当 Key 发出去）",
  );
  ok(
    has("renderer/app-settings.js", "relay-sync-slot") && has("renderer/app-settings.js", "MtRelay.stateText"),
    "提供商页有中转状态行（余额 + 上次同步 / 失败原因）",
  );

  /* ── [8] i18n ──────────────────────────────────────────────── */
  console.log("[8] i18n：新文案都有英文键");
  const i18n = read("renderer/i18n.js");
  const keys = [
    "MTNode 中转服务",
    "由账号登录态托管（只读）",
    "刷新中转清单",
    "去充值",
    "账号托管",
    "余额不足",
    "可用余额 ",
    "上次同步 ",
    "模型清单（云端下发，从上到下为使用优先级）",
  ];
  const missing = keys.filter((k) => !i18n.includes('"' + k + '":'));
  ok(missing.length === 0, "中转服务文案全部有英文键" + (missing.length ? "（缺：" + missing.join(" / ") + "）" : ""));

  /* ── [9] 文档与部署 ────────────────────────────────────────── */
  console.log("[9] 文档与部署自检");
  ok(exists("docs/relay-admin.md"), "docs/relay-admin.md 存在（server.mjs 注释引用它）");
  const doc = exists("docs/relay-admin.md") ? read("docs/relay-admin.md") : "";
  ok(
    doc.includes("everRecharged") && doc.includes("relay:me") && doc.includes("mtnode-relay"),
    "文档写清客户端同步契约（接口 / 字段 / 来源标识）",
  );
  ok(
    doc.includes("部署") && doc.includes("deploy.sh"),
    "文档含部署步骤（上传 → deploy.sh → 自检）",
  );
  ok(
    has("store-saas/deploy.sh", "relay-auth") && has("store-saas/deploy.sh", "relay-env"),
    "部署链自带中转站自检（鉴权 401 + 上游凭据在位）",
  );

  /* ── [10] 余额一律按元 ─────────────────────────────────────── */
  console.log("[10] 金额口径：元（4 位小数），客户端不出现「分」");
  ok(
    has("main.js", "balanceYuan: Number(doc.balanceYuan) || 0") &&
      has("main.js", "totalYuan: Number(doc.totalYuan) || 0") &&
      fnBody("main.js", 'ipcMain.handle("relay:me"').indexOf("Cents") < 0,
    "main.js 的 relay:me 只中转 Yuan 字段（不再有 balanceCents / totalCents / subCents）",
  );
  ok(
    has("renderer/app-relay.js", "balanceYuan: Number(doc.balanceYuan) || 0") &&
      has("renderer/app-relay.js", "totalYuan: Number(doc.totalYuan) || 0"),
    "renderer/app-relay.js 的 relay 快照按元落 config.json（balanceYuan / totalYuan）",
  );
  ok(
    has("renderer/app-wallet.js", 'return "¥" + Number(yuan || 0).toFixed(4);') &&
      has("renderer/app-relay.js", 'return "¥" + Number(yuan || 0).toFixed(4);') &&
      has("auth-store.js", '"balanceYuan"'),
    "钱包 / 中转模块的 money() 按元 4 位小数显示，账号摘要放行 balanceYuan",
  );
  ok(
    !read("renderer/app-settings.js").includes("totalCents") && !read("renderer/app-wallet.js").includes("Cents"),
    "渲染层不再读任何 Cents 字段（余额与订单/流水一律元）",
  );

  console.log("");
  if (fails) {
    console.log("✗ " + fails + " / " + checks + " 项失败");
    process.exitCode = 1;
  } else {
    console.log("✓ 全部 " + checks + " 项通过");
  }
}

main();

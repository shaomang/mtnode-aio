"use strict";
/* MTNode 中转服务的**客户端**回归 —— 零依赖，`node test/smoke-relay-client.js`
 *
 * 服务端本体的回归在 test/smoke-relay.js（中转站计费 / 门禁 / 管理台 / 会话测试）。
 * 这一份钉住「云端清单如何落到客户端、以及那张卡长什么样」，需求口径见 docs/relay-admin.md：
 *   [1] 凭据不落盘：provider 只落占位串，真 token 由主进程现取（config.json 里没有凭据）
 *   [2] 只读边界：卡上没有一处可改接入信息的输入框；能改的只有启用开关与本机优先级
 *   [3] 可见性：everRecharged=false ⇒ 连卡都不建；余额耗尽 ⇒ 卡在但置灰且不可被引用
 *   [4] 刷新时机：本地无快照才拉 / 登录后立即拉 / 启动 config 就绪后补拉 / 充值成功 / 手动「刷新」
 *   [5] 位置规则：名下还有别的可用服务商就追加到末尾，一个都没有才置顶
 *   [6] 服务端同步字段：models[].kind = text/image、everRecharged 只认本人流水（含人工调账）
 *   [7] 各处接线：index.html 顺序 / preload 桥 / IPC / DSH 会话参数 / 插件宿主解析器
 *   [8] i18n：新文案都有英文键（未译会回退中文，但英文界面会中英混排）
 *   [9] 文档与部署：docs/relay-admin.md 与部署自检都在
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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

async function main() {
  /* 需要等异步回执的断言登记在这里，收尾（main 末尾 await）统一跑；同步断言照旧原地跑 */
  const laterChecks = [];

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

  /* ── [1b] 打码凭据：设置卡上看得见「用的是哪张 Key」，明文仍不出主进程 ── */
  console.log("[1b] 打码凭据：前 4 + **** + 后 4，明文不出主进程");
  const maskBody = fnBody("main.js", "maskSecret");
  ok(
    maskBody.includes("slice(0, 4)") &&
      maskBody.includes('"****"') &&
      maskBody.includes("slice(-4)") &&
      maskBody.includes("length <= 7"),
    "main.js 的 maskSecret：前 4 + **** + 后 4（长度 ≤ 7 整串打码，短凭据不会被拼回原文）",
  );
  /* 就地跑一遍这条口径：断言的是行为，不是注释 */
  const maskSecret = new Function("return function maskSecret(secret) " + maskBody + ";")();
  ok(
    maskSecret("0123456789abcdef") === "0123****cdef" &&
      maskSecret("123") === "***" &&
      maskSecret("") === "",
    "maskSecret 实测：16 位 → 0123****cdef；3 位 → ***；空 → 空串",
  );
  ok(
    has("main.js", 'ipcMain.handle("relay:keyInfo"') &&
      has("preload.js", "relayKeyInfo: () => ipcRenderer.invoke('relay:keyInfo')"),
    "relay:keyInfo 只走主进程桥（渲染层拿到的永远只有打码串）",
  );
  /* 带冒号的 IPC 名 `function x(` 取不到（fnBody 按 `function <name>(` 找，注释里也出现过
     这串）：这里直接钉源码里那几行，断言的是「回给渲染层的字段里没有明文 token」 */
  const mainSrc = read("main.js");
  const keyInfoAt = mainSrc.indexOf('ipcMain.handle("relay:keyInfo"');
  /* 窗口 1000 → 2600：relay:keyInfo 的回包里新增了独立中转票的**有效期**字段
     （fromRelayKey / expiresAt / renewBeforeMs / renewDue，见本轮「中转 Key 独立」），
     readIssue 那行因此往后挪了；这条断言要钉的仍是「回给渲染层的字段里没有明文 token」。 */
  const keyInfoReturn = keyInfoAt < 0 ? "" : mainSrc.slice(keyInfoAt, keyInfoAt + 2600);
  ok(
    keyInfoReturn.includes("maskedKey: maskSecret(token)") &&
      !/\btoken:\s*token\b/.test(keyInfoReturn) &&
      keyInfoReturn.includes("keyLength: token.length"),
    "relay:keyInfo 只回 maskedKey / keyLength / signedIn，绝不回明文 token",
  );
  const relayMod = read("renderer/app-relay.js");
  ok(
    relayMod.includes("syncKeyInfo") &&
      relayMod.includes("relayKeyInfo()") &&
      relayMod.includes("keyMasked: keyView.maskedKey") &&
      /if \(p\) \{\s*\n\s*p\.relay = Object\.assign\(\{\}, meta\(p\), \{[\s\S]{0,180}keyMasked: key\.maskedKey/.test(relayMod),
    "app-relay.js：打码串落进 relay 快照（离线也照旧显示），并随快照重建保留",
  );
  ok(
    relayMod.includes("resetKeyView()"),
    "换账号 / 退出登录把上一份打码凭据抹掉（不把别人的 Key 尾巴留在新账号脸上）",
  );
  ok(
    !/keyMasked[\s\S]{0,80}apiKey\s*=/.test(relayMod),
    "打码串只进 relay 元数据用于显示，**不回填 provider.apiKey**（配置里永远是占位串）",
  );
  /* 「没登录」与「凭据在手却解不开」在界面上必须分开说（readIssue 链路口径） */
  ok(
    has("auth-store.js", 'lastReadIssue = "decrypt_failed"') &&
      has("auth-store.js", 'lastReadIssue = "encryption_unavailable"') &&
      has("auth-store.js", "readIssue: () => lastReadIssue"),
    "auth-store 记录最近一次凭据读取失败的原因（decrypt_failed / encryption_unavailable）",
  );
  ok(
    keyInfoReturn.includes('readIssue: String(readIssue || "")') &&
      has("main.js", "authStore.readIssue()"),
    "relay:keyInfo 把 readIssue 转给渲染层（只一张原因标签，不含凭据内容）",
  );
  ok(
    has("renderer/app-settings.js", 'meta.keyIssue === "decrypt_failed"') &&
      has("renderer/app-settings.js", 'meta.keyIssue === "encryption_unavailable"'),
    "只读卡据此给出「重新登录一次」的动作提示（不是笼统的「未取到凭据」）",
  );

  /* 行为回归（跑真的 renderer/app-relay.js，window.api 用桩）：
     字段名在「主进程回包（maskedKey）」与「卡上快照（keyMasked）」之间映射过一次，
     抄错就会得到空打码串 —— 这条钉住「同步之后卡上真的有打码串」。 */
  const vm = require("vm");
  let relayRun = null;
  const relaySync = (() => {
    const S = { config: { providers: [], modelKinds: {} } };
    const win = {};
    const sandbox = {
      window: win,
      S: S,
      console: { log() {}, warn() {} },
      I18n: { t: (s) => s },
      repaintSettingsProvTiles: () => {},
      renderCanvas: () => {},
      setTimeout,
      clearTimeout,
    };
    sandbox.window.api = {
      relayKeyInfo: () =>
        Promise.resolve({ ok: true, signedIn: true, maskedKey: "5500****4162", keyLength: 48, readIssue: "" }),
      relayMe: () =>
        Promise.resolve({
          ok: true,
          at: Date.now(),
          doc: {
            baseUrl: "https://relay.invalid/v1",
            providerName: "MTNode 中转服务",
            enabled: true,
            everRecharged: true,
            balanceYuan: 99.5,
            totalYuan: 99.5,
            models: [{ id: "deepseek-v4-flash", kind: "text" }],
          },
        }),
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(relayMod, sandbox, { filename: "app-relay.js" });
    relayRun = sandbox;
    return sandbox.window.MtRelay.sync({ force: true });
  })();
  /* 先记下「还没等到同步回执」时的快照：同步是异步的，断言要等它落地（见 main 收尾） */
  laterChecks.push(() => {
    const card0 = relayRun && relayRun.S.config.providers[0];
    ok(
      !!card0 &&
        card0.relay.keyMasked === "5500****4162" &&
        card0.relay.authKey === true &&
        card0.apiKey === "mtnode-account-token",
      "同步一次后：卡上 relay.keyMasked 就是主进程给的那串（apiKey 仍是占位串）",
    );
  });
  void relaySync;

  /* ── [2] 只读边界 ───────────────────────────────────────────── */
  console.log("[2] 只读边界：接入信息一处都不许手改");
  const card = fnBody("renderer/app-settings.js", "relayProvCard");
  ok(card.length > 500, "找到 relayProvCard（只读卡渲染函数）");
  ok(
    card.includes("由账号登录态托管（只读）") && card.includes("relay-ro"),
    "API Key / Base URL / 名称 / 类型 / 形态 / 清单都以 <code> 只读展示",
  );
  ok(
    card.includes("meta.keyMasked") && card.includes("meta.authKey") &&
      card.includes("MtRelay.maskKey"),
    "只读卡「API Key」一行显示打码串（前 4 + **** + 后 4；并标明凭据到没到）",
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
  console.log("[4] 刷新时机：本地无快照才拉 / 登录后立即拉 / config 就绪补拉 / 手动");
  ok(
    has("renderer/app-auth.js", "MtRelay.onAuthState"),
    "登录态每次刷新都通知中转模块（换账号必重拉、同账号看本地有没有快照）",
  );
  const onAuth = fnBody("renderer/app-relay.js", "onAuthState");
  ok(
    onAuth.includes("uid === lastUserId") && onAuth.includes("sync({ force: true })"),
    "换账号强制重拉",
  );
  ok(
    onAuth.includes("dropProvider();\n    return sync({ force: true });") ||
      onAuth.includes("dropProvider()") &&
        onAuth.indexOf("dropProvider()") < onAuth.indexOf("sync({ force: true })"),
    "换账号先把上一个账号的卡作废再重拉（不把别人的模型留在新账号脸上）",
  );
  ok(
    has("renderer/app-wallet.js", "MtRelay.sync({ force: true })"),
    "充值到账立刻回拉（余额从 0 变正时卡片当场出现 / 恢复）",
  );
  ok(
    has("renderer/app-settings.js", "MtRelay.syncIfStale()") &&
      fnBody("renderer/app-settings.js", "openProviderConfigDialog").includes("syncIfStale"),
    "打开设置与打开该卡都按「本地有没有快照」决定是否自动拉",
  );
  /* 需求口径（本 bug 的根因）：中转 Key = 账号登录 token，长期不变 ⇒ 不做时间新鲜度重拉；
     新装应用登录后拉不到，是因为登录态比 S.config 先到、那一次同步静默失败且再无重试。 */
  const syncFn = fnBody("renderer/app-relay.js", "sync");
  ok(
    syncFn.includes("if (!cfg())") && syncFn.includes("pendingFlush = true") &&
      syncFn.includes("config-not-ready"),
    "config 还没载入（启动竞态）时记一笔待补，不静默丢弃（曾经就是卡建不出来的原因）",
  );
  ok(
    syncFn.includes("hasLocalSnapshot() && !o.force"),
    "本地已有快照就不拉（快照不设新鲜期：Key 长期不变）",
  );
  ok(
    has("renderer/app-relay.js", "function hasLocalSnapshot()") &&
      has("renderer/app-relay.js", "function flush()") &&
      has("renderer/app-boot.js", "MtRelay.flush()"),
    "config 载入后由 app-boot 补拉一次（flush）",
  );
  ok(
    fnBody("renderer/app-relay.js", "flush").includes("uid !== lastUserId"),
    "补拉时按「本地快照是否属于本账号」决定强制重拉还是走「有快照就不拉」",
  );
  ok(
    has("renderer/app-relay.js", "var FRESH_MS = 24 * 3600 * 1000"),
    "快照新鲜期常量仍保留（只作卡上状态口径，不再决定要不要拉）",
  );
  const syncIfStale = fnBody("renderer/app-relay.js", "syncIfStale");
  ok(
    syncIfStale.includes("hasLocalSnapshot()") && syncIfStale.includes("skipped"),
    "syncIfStale：本地有快照直接跳过，不打扰服务端（失败也不做节流，下次还有机会）",
  );
  ok(
    syncIfStale.indexOf("Date.now() - at") < 0 && syncIfStale.indexOf("RETRY_GAP") < 0,
    "syncIfStale 里不再有「24h 新鲜度」与「失败节流」两个旧判据",
  );
  /* 失败可见：本地没卡时「刷新中转清单」必须始终可点（唯一的自救入口） */
  ok(
    !read("renderer/app-settings.js").includes('relayRefresh.style.display = prov ? "" : "none"'),
    "「刷新中转清单」按钮不再因「本地没有中转卡」而隐藏（失败时用户能自己重试）",
  );
  ok(
    has("renderer/app-relay.js", '"未同步（点「刷新中转清单」重试）"'),
    "卡上没有快照时状态行给出可执行的下一步（而不是空着）",
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
    "未同步（点「刷新中转清单」重试）",
    "该账号还没有充值记录，充值成功后中转清单会自动出现",
    "模型清单（云端下发，从上到下为使用优先级）",
    "由账号登录态托管（只读）：打码显示，真凭据不下发到界面",
    "由账号登录态托管（只读）：暂未取到账号凭据，登录后自动带上",
    "凭据 = 本机登录账号的 token（打码显示，前 4 + **** + 后 4；真凭据只留在主进程）",
    "还没有取到账号凭据：登录 MTNode 账号后自动带上（打码显示）",
    "本机的账号凭据读不出来（换了 Windows 账号或加密密钥变动）：请重新登录一次 MTNode 账号，凭据会自动补上",
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

  /* ── [10b] 中转余额按鲸圆币显示（本次需求）────────────────────
     1 币 = ¥0.02；**只换显示**：快照里的 totalYuan 仍是元，门禁与判定口径一个没动。 */
  console.log("[10b] 中转余额按鲸圆币显示（元仍是存储与判定口径）");
  ok(
    has("renderer/app-settings.js", "relayBalanceEl") &&
      has("renderer/app-settings.js", "MtCoin.balanceEl") &&
      !/I18n\.t\("可用余额 "\)\s*\+\s*MtRelay\.money/.test(read("renderer/app-settings.js")),
    "设置页中转状态行与只读卡的余额都换成了币元件（不再拼 MtRelay.money）",
  );
  ok(
    has("renderer/app-settings.js", "function relayBalanceEl(totalYuan)") &&
      has("renderer/app-settings.js", "Number(meta.totalYuan) || 0"),
    "余额元值照旧来自快照的 totalYuan（只换显示，云端字段没动）",
  );
  const coinWin = { window: {}, document: null, I18n: { t: (s) => s } };
  coinWin.window = coinWin;
  vm.createContext(coinWin);
  vm.runInContext(read("renderer/app-whalecoin.js"), coinWin);
  ok(
    coinWin.window.MtCoin.balanceTextOfYuan(99.5) === "4,975",
    "¥99.5 → 4,975 币（中转余额按 50:1 显示）",
  );
  ok(
    coinWin.window.MtCoin.yuanOfCoins(975) === 19.5,
    "币 → 元反算可逆（975 币 = ¥19.5），云端口径不受影响",
  );

  /* ── [11] 下发给网关的服务商表里不许出现占位串（本 bug 的根因回归）──────
     现象：充值用户用「MTNode 中转服务」那条路由开会话/助手，仍回
     401「缺少或已失效的中转 Key」。根因：renderer 的 mtnodePiProviders() 拼条目时只带
     route/name/baseUrl/apiKey/api/models，**丢了 source**，而 dsh:run 的
     dshParamsWithRelayKey 只换得掉顶层 apiKey —— 条目里的占位串被网关写进
     settings.yaml 的 apiKeyEnv，Bearer 就是那串占位符。
     这里两件事都钉：① 渲染层两个同名函数都带 source；② 主进程行为回归（真跑那段函数）。 */
  console.log("[11] 会话/助手下发前：中转卡的占位串必须换成账号凭据");
  ok(
    fnBody("renderer/app-agent.js", "mtnodePiProviders").includes("source: String(p.source ||") &&
      fnBody("renderer/app.js", "mtnodePiProviders").includes("source: String(p.source ||"),
    "渲染层两份 mtnodePiProviders 都把 source 带进条目（少了它主进程认不出中转卡）",
  );
  ok(
    has("dsh/mtnode-llm-creds.js", "source: String(p.source ||") &&
      has("main.js", "function looksLikeRelayProvider") &&
      has("main.js", "function relayProviderCardBase"),
    "插件宿主凭据解析也带 source；主进程另有「占位串 / 卡 id / 地址」三重兜底",
  );
  /* 行为回归：把 main.js 里的真函数抠出来，配桩跑一遍（比断言源码字符串硬） */
  {
    const os = require("os");
    /* 末尾补一个顶格桩函数：被切的函数正好是文件里最后一个顶层函数时，
       「下一个顶格 function」仍然找得到，切片才不会把后面的 ipcMain.handle 一起带进来。 */
    const mainSrc = read("main.js") + String.fromCharCode(10) + "function __mtSmokeTail__() {}" + String.fromCharCode(10);
    /* 按「顶层 function 名」切片：从本函数头切到下一个顶层 function（含其上方注释）。
       只要不把别的顶层 function 一起切进来，在函数里顺带定义的函数就会被完整带出。 */
    /* 顶格（行首无缩进）的 function 声明 = 顶层声明；函数体里的嵌套声明都有缩进，
       用这个判据切出「本函数 + 它内部定义的函数」，既完整又不会带出下一个顶层函数。 */
    const isNameChar = (c) => !!c && /[A-Za-z0-9_$]/.test(c);
    const pickFn = (name) => {
      const i = mainSrc.indexOf("function " + name + "(");
      if (i < 0) return "";
      let end = mainSrc.length;
      let from = i + 1;
      for (;;) {
        const j = mainSrc.indexOf("\nfunction ", from);
        if (j < 0) break;
        /* 只认顶格声明（前面就是换行）+ 后面紧跟名字：函数体里的声明都带缩进 */
        if (isNameChar(mainSrc.slice(j + 10, j + 11))) {
          end = j;
          break;
        }
        from = j + 1;
      }
      return mainSrc.slice(i, end);
    };
    /* 顶格声明切到最后一个顶层函数会带上它下面的 ipcMain.handle 段：再砍一刀（不用正则转义）。 */
    const cutAt = (parts) => {
      const k = parts.indexOf(String.fromCharCode(10) + "ipcMain.");
      return k >= 0 ? parts.slice(0, k) : parts;
    };
    const parts = cutAt(
      pickFn("looksLikeRelayProvider") + String.fromCharCode(10) + pickFn("dshParamsWithRelayKey"),
    );
    const RELAY_KEY_PLACEHOLDER = "mtnode-account-token";
    const RELAY_PROVIDER_SOURCE = "mtnode-relay";
    const KNOWN_BASE = "https://www.mt-agent.com/mtnode/store-api/relay/v1";
    const build = (knownBase) => {
      const providerAuthKey = () => "REAL_TOKEN_FROM_AUTH_STORE";
      const sandbox = {
        providerAuthKey,
        RELAY_KEY_PLACEHOLDER,
        RELAY_PROVIDER_SOURCE,
        relayProviderCardBase: () => knownBase,
      };
      return new Function(
        "providerAuthKey",
        "RELAY_KEY_PLACEHOLDER",
        "RELAY_PROVIDER_SOURCE",
        "relayProviderCardBase",
        parts + "\nreturn dshParamsWithRelayKey;",
      )(
        sandbox.providerAuthKey,
        sandbox.RELAY_KEY_PLACEHOLDER,
        sandbox.RELAY_PROVIDER_SOURCE,
        sandbox.relayProviderCardBase,
      );
    };
    /* 老渲染层形态（本次 bug 现场）：条目没有 source，只有 route + 占位串 */
    const oldCard = {
      route: "mtnode-relay",
      name: "MTNode 中转服务",
      baseUrl: KNOWN_BASE,
      apiKey: RELAY_KEY_PLACEHOLDER,
      api: "openai-completions",
      models: ["deepseek-v4-flash"],
    };
    const out1 = build(KNOWN_BASE)({
      provider: "mtnode_mtnode-relay",
      apiKey: RELAY_KEY_PLACEHOLDER,
      mtnodeProviders: [oldCard],
    });
    ok(
      out1.mtnodeProviders[0].apiKey === "REAL_TOKEN_FROM_AUTH_STORE" &&
        out1.apiKey === "REAL_TOKEN_FROM_AUTH_STORE",
      "无 source 的中转卡也换掉了（占位串绝不进网关 settings.yaml）",
    );
    const out2 = build(KNOWN_BASE)({
      mtnodeProviders: [Object.assign({}, oldCard, { source: "mtnode-relay" })],
    });
    ok(out2.mtnodeProviders[0].apiKey === "REAL_TOKEN_FROM_AUTH_STORE", "带 source 的中转卡换掉了");
    /* 普通第三方服务商绝不能被误换（401 = Key 填错，与登录态无关） */
    const out3 = build(KNOWN_BASE)({
      provider: "mtnode_opencode",
      apiKey: "sk-third-party",
      mtnodeProviders: [
        { route: "opencode", baseUrl: "https://api.example.com/v1", apiKey: "sk-third-party", models: ["x"] },
      ],
    });
    ok(
      out3.mtnodeProviders[0].apiKey === "sk-third-party" && out3.apiKey === "sk-third-party",
      "别的服务商的 Key 原样不动（只认中转链路）",
    );
    /* 条目既没有 source 也没有卡 id、本地又拿不到卡快照时，判据只剩地址里的中转站路径标记 */
    const out4 = build("")({ mtnodeProviders: [Object.assign({}, oldCard, { route: "p9" })], apiKey: RELAY_KEY_PLACEHOLDER });
    ok(out4.mtnodeProviders[0].apiKey === "REAL_TOKEN_FROM_AUTH_STORE", "配置里没有卡时靠地址标记兜底");
    void os;
  }

  /* ── [12] 独立中转票：客户端存下、优先使用、401 只清中转凭据 ───────── */
  console.log("[12] 独立中转票（180 天）与 401 兜底");
  ok(
    has("auth-store.js", "relayKey: typeof data.relayKey") &&
      has("auth-store.js", "relayKeyExpiresAt") &&
      has("auth-store.js", "setRelayKey: (relayKey, expiresAt)"),
    "加密凭据里存独立中转票（与登录 token 分开，明文仍只在本机主进程）",
  );
  ok(
    fnBody("main.js", "providerAuthKey").includes("cur.relayKey") &&
      fnBody("main.js", "providerAuthKey").includes("cur.token"),
    "providerAuthKey 优先独立票，老凭据退回登录 token 兜底",
  );
  ok(
    has("main.js", "function relayAuthFailed") &&
      has("main.js", "const RELAY_AUTH_MARK = \"MTNODE_RELAY_AUTH\"") &&
      has("store-saas/relay.mjs", "MTNODE_RELAY_AUTH"),
    "中转 401 有专用标记：客户端据此清凭据并提示重登（别的服务商 401 不动）",
  );
  ok(
    has("store-saas/server.mjs", "RELAY_KEY_MS") &&
      has("store-saas/server.mjs", "async function issueRelayKey") &&
      has("store-saas/server.mjs", "async function ensureRelayKey") &&
      has("store-saas/server.mjs", "relayKeyExpiresAt: keyView.expiresAt"),
    "服务端发/回 180 天独立票（relay:me 是发放口，用时滑动续期）",
  );
  /* 上报 bug 的根因回归：发放口**每次都必须给得到明文**。
     库里只有 tokenHash，「明文只在下发那一次给」= 一次性 —— 客户端那一次没接住
     （重装 / 清了本机凭据 / 解密失败 / 换机 / 落库失败）就再也领不到，
     只能退回登录 token，而数据面只认独立票 ⇒ 恒 401，界面却一直提示「重新登录一次即可自动领取」
     （那句横幅其后已按要求移除，见 [12]；发放口这条根因回归照旧要钉）。
     服务端行为（两次都拿到票、旧票作废）由 test/smoke-relay.js 的 [3b] 段真跑服务端验；
     这里钉住实现口径不被改回「有现役票就回空串」。 */
  const ensureBody = fnBody("store-saas/server.mjs", "ensureRelayKey");
  ok(
    !/reissued:\s*false/.test(ensureBody) && /issueRelayKey\(u, t\)/.test(ensureBody),
    "发放口每次来领都发一张新的明文票（不再「有现役票就回空串」——上报 bug 的根因）",
  );
  ok(
    fnBody("store-saas/server.mjs", "issueRelayKey").includes("deleteSession"),
    "重发前把该账号旧票一并作废（保底一票制：库里只留最新一张）",
  );
  /* relay:me 是 ipcMain.handle 里的箭头函数，fnBody 只认具名 function，这里按段取文本 */
  const meSrc = (() => {
    const s2 = read("main.js");
    const at = s2.indexOf('ipcMain.handle("relay:me"');
    const end = s2.indexOf('ipcMain.handle("relay:keyInfo"', at);
    return at < 0 ? "" : s2.slice(at, end < 0 ? at + 4000 : end);
  })();
  ok(
    meSrc.includes("maskedKey: maskSecret(") && meSrc.includes("fromRelayKey:") && meSrc.includes("keyState"),
    "relay:me 把「刚存下的凭据」状态（打码串 / fromRelayKey）一并回给渲染层（明文仍不出主进程）",
  );
  ok(
    fnBody("renderer/app-relay.js", "sync").includes("ks.fromRelayKey") &&
      fnBody("renderer/app-relay.js", "sync").includes("MtRelayAuth.refresh"),
    "渲染层领到票当刻就把它落进卡（cachedKeyView）并回刷顶部横幅，不等下次登录",
  );
  ok(
    fnBody("renderer/app-relay-auth.js", "signedIn").includes("MtRelay.syncIfStale"),
    "登录走完顺手去领一次票（票由客户端自己领，「登录着但还没有独立票」才不会卡住）",
  );
  ok(
    has("renderer/app-relay-auth.js", "function mtRelayAuthNotice") &&
      has("renderer/app-relay-auth.js", "relayAuthBar") &&
      has("renderer/index.html", 'src="app-relay-auth.js"') &&
      has("renderer/app-boot.js", "MtRelayAuth.init"),
    "渲染层：可点提示 + 顶部常驻横幅，启动时接入",
  );
  /* 本轮需求：移除「本机还没有中转服务凭据：重新登录一次即可自动领取（无需在「提供商」里手填 Key）」——
     登录着但本机还没领到独立票属于一两秒的过渡态（票由客户端自己领），
     提示出来只会让用户以为「按提示重登了也没用」；代码与 i18n 两边都不许再留这句。 */
  ok(
    !/本机还没有中转服务凭据/.test(read("renderer/app-relay-auth.js")) &&
      !/本机还没有中转服务凭据/.test(read("renderer/i18n.js")),
    "「本机还没有中转服务凭据」提示已移除（renderer/app-relay-auth.js 与 i18n.js 都不再留这句）",
  );
  ok(
    !/i\.fromRelayKey/.test(fnBody("renderer/app-relay-auth.js", "render")) &&
      has("renderer/app-relay-auth.js", 'i.readIssue === "write_unverified"') &&
      has("renderer/app-relay-auth.js", '"中转服务凭据即将到期：重新登录一次即可领取新的凭据"'),
    "render 只剩「凭据解不开 / 存不住」与「快到期」两种横幅（登录着没票不再亮）",
  );
  ok(has("renderer/i18n.js", '"重新登录": "Sign in again"'), "重登按钮文案有英文键");
  /* 到期自动续期（共识第 6 条）：登录 / 启动 / 打开设置卡片都走 syncIfStale，
     命中「该续期了」就顺带领一张新票 —— 不靠用户记得点「刷新中转清单」。 */
  const renewDueFn = fnBody("renderer/app-relay.js", "renewDue");
  ok(
    has("renderer/app-relay.js", "function renewDue()") &&
      renewDueFn.includes("relayKeyInfo") &&
      renewDueFn.includes("fromRelayKey") &&
      renewDueFn.includes("renewDue"),
    "续期判据只问主进程 relay:keyInfo（renewDue / 还没有独立票），不碰凭据明文",
  );
  ok(
    fnBody("renderer/app-relay.js", "syncIfStale").includes("renewDue()") &&
      fnBody("renderer/app-relay.js", "syncIfStale").includes("force: true") &&
      has("renderer/app-relay.js", "var renewing = false"),
    "syncIfStale 命中续期即强制同步一次（并发只用 renewing 挡，不做失败节流）",
  );
  ok(
    has("renderer/app-relay-auth.js", '"中转服务凭据即将到期：重新登录一次即可领取新的凭据"'),
    "快到期时顶部横幅说清动作（重新登录一次即换新票）",
  );

  if (relaySync && typeof relaySync.then === "function") {
    await relaySync.then(
      () => {},
      () => {},
    );
  }
  /* ── [13] 凭据自愈：解不开就隔离留档、写下去必须读得回来 ────────────────
     现场（用户上报）：auth-store.json 里 600 字节的密文在当前 Windows 账号下
     decryptString 恒失败（error.log 里成片的「账户凭据读取失败」），客户端却一直
     只提示「重新登录一次即可自动领取」——用户重登多少遍都出不来凭据
     （那句横幅其后已按要求移除，但「解不开就留档 + 写后回读校验」这两条口径照旧要钉）。
     两条口径必须钉住：①解不开的文件搬走留档，别继续毒化后续每一次 load()；
     ②写下去要回读校验，safeStorage 写得出读不回来时换本机密钥加密（能读回来）。 */
  console.log("[13] 凭据自愈：解不开即留档清理 + 写后回读校验 + 兜底加密");
  const authSrc = read("auth-store.js");
  ok(
    authSrc.includes("function quarantine(") &&
      authSrc.includes('quarantine(String(lastReadIssue || "broken"))') &&
      authSrc.includes('".broken-"'),
    "解不开的凭据文件搬走留档（同名 .broken-<时间>-<原因>，不删：出问题还能把文件发回来查）",
  );
  ok(
    /const back = decode\(JSON\.parse\(fs\.readFileSync\(filePath\(\), "utf8"\)\)\)/.test(authSrc) &&
      authSrc.includes('quarantine("roundtrip")') &&
      authSrc.includes('error: "write_unverified"'),
    "写后回读校验：写下去的凭据读不回来就判这次落盘失败（并隔离那份死文件）",
  );
  ok(
    authSrc.includes("function aesEncode(") &&
      authSrc.includes('enc: "aesgcm"') &&
      authSrc.includes("safeStorage.decryptString(buf) === json") &&
      authSrc.includes("WARN_FALLBACK"),
    "safeStorage 自检不通过即改用本机密钥的 AES-256-GCM（密文与密钥都只在本机数据目录）",
  );
  ok(
    authSrc.includes("function warnThrottled(") && authSrc.includes("WARN_GAP_MS"),
    "同一个「读不出来 / 写不回来」按 10 分钟节流（现场曾 2 秒一条把 error.log 刷满）",
  );

  /* 行为回归：拿现场那份**真的解不开**的密文跑一遍（没有就现造一份） */
  {
    const os = require("os");
    const live = path.join(process.env.APPDATA || "", "pipeline-console", "auth-store.json");
    let brokenRaw = null;
    try {
      brokenRaw = fs.readFileSync(live, "utf8");
    } catch {}
    if (!brokenRaw) {
      brokenRaw = JSON.stringify({
        v: 1,
        enc: "safeStorage",
        payload: Buffer.from("not-a-dpapi-blob-just-noise-0123456789").toString("base64"),
        savedAt: Date.now(),
      });
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-authheal-"));
    fs.writeFileSync(path.join(dir, "auth-store.json"), brokenRaw, "utf8");
    const script =
      "const { app, safeStorage } = require('electron');\n" +
      "const fs=require('fs'),path=require('path');\n" +
      "const { createAuthStore } = require(" + JSON.stringify(path.join(ROOT, "auth-store.js")) + ");\n" +
      "function boot(){ const d=" + JSON.stringify(dir) + ";\n" +
      "  const warns=[]; const s=createAuthStore({safeStorage,dataDir:()=>d,onWarn:(m)=>warns.push(m)});\n" +
      "  const out={before:fs.readdirSync(d)}; out.load=s.load(); out.readIssue=s.readIssue();\n" +
      "  out.after=fs.readdirSync(d);\n" +
      "  out.save=s.save({token:'healed-token',user:{id:'healed'}}); out.reload=s.load();\n" +
      "  const bad={isEncryptionAvailable:()=>true,encryptString:()=>Buffer.from('x'),\n" +
      "    decryptString:()=>{throw new Error('boom')}};\n" +
      "  const d2=d+'-bad'; fs.mkdirSync(d2,{recursive:true});\n" +
      "  const s2=createAuthStore({safeStorage:bad,dataDir:()=>d2,onWarn:()=>{}});\n" +
      "  out.badSave=s2.save({token:'t2',user:{id:'u2'}}); out.badReload=s2.load();\n" +
      "  out.badEnc=JSON.parse(fs.readFileSync(path.join(d2,'auth-store.json'),'utf8')).enc;\n" +
      "  out.warns=warns;\n" +
      "  console.log('AUTHHEAL '+JSON.stringify(out)); app.exit(0); }\n" +
      "if (app.whenReady) app.whenReady().then(boot); else boot();\n";
    const scriptPath = path.join(dir, "probe.js");
    fs.writeFileSync(scriptPath, script, "utf8");
    const electronBin = path.join(
      ROOT,
      "node_modules",
      "electron",
      "dist",
      process.platform === "win32" ? "electron.exe" : "electron",
    );
    if (!fs.existsSync(electronBin)) {
      ok(true, "跳过【凭据自愈真跑】：本机没有 node_modules/electron（打包环境）");
    } else {
      const { spawnSync } = require("child_process");
      const run = spawnSync(electronBin, [scriptPath], { encoding: "utf8", timeout: 120000 });
      const line = String(run.stdout || "")
        .split(/\r?\n/)
        .find((l) => l.startsWith("AUTHHEAL "));
      if (!line) {
        ok(false, "【凭据自愈真跑】没跑起来：" + String(run.stderr || "").slice(0, 200));
      } else {
        const o = JSON.parse(line.slice("AUTHHEAL ".length));
        ok(
          o.load === null &&
            o.readIssue === "decrypt_failed" &&
            o.after.some((f) => f.indexOf("auth-store.json.broken-") === 0) &&
            o.after.indexOf("auth-store.json") < 0,
          "现场那份解不开的凭据：load 回 null + 文件已搬到 .broken-* 留档（不再反复毒化）",
        );
        ok(
          o.save && o.save.ok === true && o.reload && o.reload.token === "healed-token",
          "隔离之后重新登录能写出一份**读得回来**的凭据（重登一次就真的恢复）",
        );
        ok(
          o.badEnc === "aesgcm" && o.badSave && o.badSave.ok === true && o.badReload && o.badReload.token === "t2",
          "safeStorage 写得出读不回来时：改用本机密钥 AES-GCM，凭据照旧读得回来",
        );
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  /* 行为回归：中转卡打开后**不会**因为快照刷新把自己关掉（用户上报的第二个症状） */
  console.log("[13b] 设置里的中转卡：快照刷新不再把自己关掉");
  {
    class El {
      constructor(tag) {
        this.tagName = String(tag || "div").toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attrs = {};
        this.dataset = {};
        this.style = { cssText: "", setProperty() {} };
        this._cls = new Set();
        this._text = "";
        this._html = "";
        this.hidden = false;
        this.disabled = false;
        this._l = {};
        this.value = "";
        this.checked = false;
        this.title = "";
        this.type = "";
        this.id = "";
      }
      get className() {
        return Array.from(this._cls).join(" ");
      }
      set className(v) {
        this._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
      }
      get classList() {
        const s = this._cls;
        return {
          add: (...c) => c.forEach((x) => s.add(x)),
          remove: (...c) => c.forEach((x) => s.delete(x)),
          toggle: (c, on) => (on === undefined ? (s.has(c) ? s.delete(c) : s.add(c)) : on ? s.add(c) : s.delete(c)),
          contains: (c) => s.has(c),
        };
      }
      get textContent() {
        return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
      }
      set textContent(v) {
        this.children = [];
        this._text = v == null ? "" : String(v);
      }
      get innerHTML() {
        return this._html;
      }
      set innerHTML(v) {
        this._html = String(v == null ? "" : v);
        this.children = [];
        const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>/g;
        const stack = [this];
        let m;
        while ((m = re.exec(this._html))) {
          const close = m[1];
          const tag = m[2];
          const attrs = m[3];
          if (close) {
            if (stack.length > 1) stack.pop();
            continue;
          }
          const el = new El(tag);
          const idm = /\bid="([^"]*)"/.exec(attrs);
          if (idm) el.id = idm[1];
          const cm = /\bclass="([^"]*)"/.exec(attrs);
          if (cm) el.className = cm[1];
          stack[stack.length - 1].appendChild(el);
          if (!/\/$/.test(attrs) && !["br", "img", "input", "hr"].includes(tag.toLowerCase())) stack.push(el);
        }
      }
      appendChild(c) {
        if (!c) return c;
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        this.children.push(c);
        return c;
      }
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      }
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      }
      setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k === "id") this.id = String(v);
      }
      getAttribute(k) {
        return this.attrs[k] === undefined ? null : this.attrs[k];
      }
      addEventListener(t, fn) {
        (this._l[t] = this._l[t] || []).push(fn);
      }
      removeEventListener(t, fn) {
        const a = this._l[t] || [];
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      }
      dispatch(t, ev) {
        (this._l[t] || []).slice().forEach((fn) => fn(ev || {}));
      }
      click() {
        const ev = { preventDefault() {}, stopPropagation() {}, target: this };
        this.dispatch("click", ev);
        if (typeof this.onclick === "function") this.onclick(ev);
      }
      focus() {}
      querySelector(sel) {
        return this._find((e) => matchSel(e, sel));
      }
      querySelectorAll(sel) {
        const out = [];
        this._walk((e) => {
          if (matchSel(e, sel)) out.push(e);
        });
        return out;
      }
      _walk(fn) {
        for (const c of this.children) {
          fn(c);
          c._walk(fn);
        }
      }
      _find(pred) {
        for (const c of this.children) {
          if (pred(c)) return c;
          const r = c._find(pred);
          if (r) return r;
        }
        return null;
      }
    }
    function matchSel(el, sel) {
      const s = String(sel).trim();
      if (s.startsWith("#")) return el.id === s.slice(1);
      if (s.startsWith(".")) return el.classList.contains(s.slice(1));
      if (s.includes(",")) return s.split(",").some((x) => matchSel(el, x));
      return el.tagName === s.toUpperCase();
    }
    const doc = {
      body: new El("body"),
      documentElement: new El("html"),
      createElement: (t) => new El(t),
      createTextNode: (t) => {
        const e = new El("#text");
        e._text = String(t);
        return e;
      },
      getElementById: (id) => doc.body._find((e) => e.id === id),
      querySelector: (s) => doc.body.querySelector(s),
      querySelectorAll: (s) => doc.body.querySelectorAll(s),
      addEventListener() {},
      removeEventListener() {},
    };
    const vi = require("vm");
    const S = { config: { providers: [], modelKinds: {} } };
    const win = {};
    /* app-settings.js 的 provCard 要用 app.js 里的类型标签表（真身由 index.html 的脚本顺序提供） */
    const providerTypeLabels = vi.runInNewContext(
      "(" + read("renderer/app.js").match(/const PROVIDER_TYPE_LABELS = (\[[\s\S]*?\]);/)[1] + ")",
    );
    /* MtRelay 桩：只提供「打开卡时订阅变更」与「打开时顺手同步一次」两处入口，
       让测试能像真身那样**在卡打开之后**触发一次重画（真身是 app-relay.js 的 emit）。 */
    let relaySub = null;
    const relayStub = {
      isRelay: (p) => !!p && String(p.source || "") === "mtnode-relay",
      onChange: (cb) => {
        relaySub = cb;
        return () => {
          relaySub = null;
        };
      },
      syncIfStale: () => Promise.resolve({ ok: true, skipped: true }),
      meta: (p) => (p && p.relay) || {},
      maskKey: (s) => String(s || ""),
      KEY_PLACEHOLDER: "mtnode-account-token",
      stateText: () => "",
      money: (y) => "¥" + Number(y || 0).toFixed(4),
      tsText: () => "—",
    };
    const sandbox = {
      window: win,
      document: doc,
      S,
      Promise,
      setTimeout,
      clearTimeout,
      console: { log() {}, warn() {} },
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      I18n: { t: (s) => String(s) },
      PROVIDER_TYPE_LABELS: providerTypeLabels,
      MtRelay: relayStub,
      api: {
        relayMe: () => Promise.resolve({ ok: false, error: "stub" }),
        relayKeyInfo: () => Promise.resolve({ ok: true, signedIn: true, maskedKey: "5500****4162" }),
      },
      toast: () => {},
      $: (s) => doc.querySelector(s),
      $$: (s) => doc.querySelectorAll(s),
      openOverlay: () => {},
      closeOverlay: () => {},
      renderCanvas: () => {},
      providerStateText: () => "",
      providerManuallyOff: () => false,
      openAuthDialog: () => {},
      settingsStamp: () => {},
      settingsSaved: () => Promise.resolve(false),
      ensureDefaultProviders: () => {},
      providerKinds: () => ({}),
      MtWallet: { open: () => {}, money: (y) => "¥" + Number(y || 0).toFixed(4) },
      applyTheme: () => {},
      renderAgentMenu: () => {},
      buildAgentModeMenu: () => {},
      agentModeEntryOf: () => null,
    };
    sandbox.window.window = sandbox.window;
    vi.createContext(sandbox);
    vi.runInContext(read("renderer/app-settings.js"), sandbox, { filename: "app-settings.js" });
    const relayCard1 = {
      id: "mtnode-relay",
      name: "MTNode 中转服务",
      source: "mtnode-relay",
      type: "text_openai",
      baseUrl: "https://example.invalid/relay/v1",
      apiKey: "mtnode-account-token",
      vision: true,
      models: ["m1"],
      relay: {
        everRecharged: true,
        models: ["m1"],
        kinds: { m1: "text" },
        at: Date.now(),
        error: "",
        blocked: false,
        authKey: true,
        keyMasked: "5500****4162",
        keyIssue: "",
        fromRelayKey: true,
        expiresAt: 0,
        renewDue: false,
      },
      disabled: false,
    };
    S.config.providers = [relayCard1];
    const host = sandbox.ensureProvCfgDlg();
    sandbox.openProviderConfigDialog(relayCard1);
    const onAfterOpen = host.classList.contains("on");
    ok(!!relaySub, "打开中转卡时会订阅 MtRelay 的变更（同步结果要落回这张卡）");
    /* 同步一来整张卡被换成**新的对象**（renderer/app-relay.js 的 applyDoc 行为），
       随后 MtRelay 播一次变更 → 对话框按订阅回调重画（真身就是这条路）。 */
    const rebuilt = JSON.parse(JSON.stringify(relayCard1));
    rebuilt.relay.keyMasked = "aa11****bb22";
    S.config.providers = [rebuilt];
    if (relaySub) relaySub("synced");
    ok(
      onAfterOpen && host.classList.contains("on"),
      "中转卡打开后：快照刷新（卡对象被整只换掉）不再把自己关掉（原写法 indexOf 判死即收窗）",
    );
    const bodyNow = host.querySelector("#provCfgBody");
    ok(
      !!bodyNow && !!bodyNow.children[0] && bodyNow.children[0].classList.contains("relay-card"),
      "重画后窗里仍是中转只读卡（按 id / source 重绑到新对象）",
    );
    S.config.providers = [];
    if (relaySub) relaySub("removed");
    ok(!host.classList.contains("on"), "真被删掉（配置里没有这只服务商）时仍然收窗（不留下悬空对话框）");
  }

  /* ── [14] 401 只清「真失效」的凭据；写不住 / 没下发要分开说 ───────────── */
  console.log("[14] 401 判定收紧 + 领票结果如实回给界面");
  const authFailBody = fnBody("main.js", "relayAuthFailed");
  ok(
    authFailBody.includes("authStatus") &&
      authFailBody.includes("保留本机凭据不清理") &&
      /if \(!authStatus\)/.test(authFailBody),
    "带标记但非 401/403（5xx / 网络错误）不再清本机凭据（服务端抖一下不该让用户白重登）",
  );
  ok(
    has("main.js", "persisted:") &&
      has("main.js", "issuedRelayKey:") &&
      has("main.js", "writeIssue") &&
      has("main.js", "[relay] 领到中转 Key 但没能存住"),
    "relay:me 回包带上「服务端发没发 / 本机存没存住」（领到票却没落住时也能说清）",
  );
  ok(
    has("renderer/app-relay.js", "ks.writeIssue") &&
      has("renderer/app-relay.js", 'keyIssue: "server_no_relay_key"'),
    "渲染层把「发了没存住」「服务端没发」分别写成卡上的原因标签",
  );
  ok(
    has("renderer/app-relay-auth.js", 'i.readIssue === "write_unverified"') &&
    has("renderer/app-relay-auth.js", "本机的登录凭据读不出来（已留档并清理）"),
    "顶部横幅：凭据读不出来 / 存不住时给出对应文案（不再只报「还没有凭据」）",
  );
  ok(
    has("renderer/i18n.js", "This machine cannot read its stored sign-in credential") &&
      has("renderer/i18n.js", "The server did not issue a relay credential this time") &&
      has("renderer/i18n.js", "This machine cannot persist the account credential"),
    "本轮三条新文案都有英文键",
  );

  for (const fn of laterChecks) fn();
  report();
}

function report() {
  console.log("");
  if (fails) {
    console.log("✗ " + fails + " / " + checks + " 项失败");
    process.exitCode = 1;
  } else {
    console.log("✓ 全部 " + checks + " 项通过");
  }
}

main();

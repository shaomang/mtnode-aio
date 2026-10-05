"use strict";
/* MTNode 中转服务的**客户端**回归 —— 零依赖，`node test/smoke-relay-client.js`
 *
 * 服务端本体的回归在 test/smoke-relay.js（中转站计费 / 门禁 / 管理台 / 会话测试）。
 * 这一份钉住「云端清单如何落到客户端、以及那张卡长什么样」，需求口径见 docs/relay-admin.md：
 *   [1] 真票就在配置卡上：主进程把中转 Key（明文，48 位十六进制）写进磁盘 config.json
 *       那张卡的 apiKey，并在 relay 对象上记 { at, expiresAt, rotate }（见 main.js 的
 *       writeRelayKeyToConfig / saveRelayKeyEverywhere / relayCardOfDisk）。占位串
 *       mtnode-account-token 只作「这张卡还没拿到真票」的识别标记，**绝不下发**。
 *   [1b] relay:keyInfo 回明文 key（maskedKey / maskSecret 整套打码口径已删除）
 *   [1c] relay:rotateKey（preload relayRotateKey → POST /api/relay/me { rotate:true }）
 *   [1d] 401 处理：relayAuthFailed → clearRelayCredentialEverywhere（两处一起丢、登录态不动）
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

/* 取一个具名函数的函数体（跳过字符串与注释里的花括号），用于「只读卡里有没有输入框」这类结构断言。
   **参数表要先跳过**：像 `async function apiCall({ provider, kind, … })` 这种解构参数，
   第一只 `{` 属于参数表而不是函数体 —— 不跳过去，取到的"函数体"就是那串参数，
   断言会静默变空（曾经把 apiCall 的重试口径断在窗外）。 */
function fnBody(rel, name) {
  const src = read(rel);
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  /* 参数表配平：从 name 后那只 `(` 起数括号（字符串 / 注释照旧跳过） */
  let p = src.indexOf("(", at);
  if (p < 0) return "";
  let paren = 0;
  let quote = "";
  let i = p;
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
    if (c === "(") paren++;
    else if (c === ")") {
      paren--;
      if (paren === 0) {
        i++;
        break;
      }
    }
    i++;
  }
  const from = src.indexOf("{", i);
  if (from < 0) return "";
  let depth = 0;
  let k = from;
  quote = "";
  while (k < src.length) {
    const c = src[k];
    const n = src[k + 1];
    if (quote) {
      if (c === "\\") k += 2;
      else if (c === quote) {
        quote = "";
        k++;
      } else k++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      k++;
      continue;
    }
    if (c === "/" && n === "/") {
      const j = src.indexOf("\n", k);
      k = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const j = src.indexOf("*/", k);
      k = j < 0 ? src.length : j + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(from, k + 1);
    }
    k++;
  }
  return src.slice(from);
}

async function main() {
  /* 需要等异步回执的断言登记在这里，收尾（main 末尾 await）统一跑；同步断言照旧原地跑 */
  const laterChecks = [];

  /* ── [1] 真票就在配置卡上（明文）────────────────────────────────
     本轮口径：主进程把中转 Key（明文，48 位十六进制）写进磁盘 config.json 里那张
     中转卡的 apiKey，并在 relay 对象上记 { at, expiresAt, rotate }；占位串只作
     「这张卡还没拿到真票」的识别标记，绝不下发上游。 */
  console.log("[1] 真票就在配置卡上（config.json 那张卡的 apiKey 就是真 Key）");
  ok(
    has("main.js", 'const RELAY_PROVIDER_SOURCE = "mtnode-relay"') &&
      has("main.js", 'const RELAY_KEY_PLACEHOLDER = "mtnode-account-token"'),
    "main.js 有来源标识与占位串常量（占位串 = 「还没拿到真票」的识别标记，绝不下发）",
  );
  ok(
    has("main.js", "function writeRelayKeyToConfig(") &&
      has("main.js", "function saveRelayKeyEverywhere(") &&
      has("main.js", "function relayCardOfDisk("),
    "主进程三件套齐备：写卡（writeRelayKeyToConfig）/ 两处一起写（saveRelayKeyEverywhere）/ 读盘上那张卡（relayCardOfDisk）",
  );
  const writeCardBody = fnBody("main.js", "writeRelayKeyToConfig");
  ok(
    writeCardBody.includes("allowPlaceholder") &&
      writeCardBody.includes("k === RELAY_KEY_PLACEHOLDER && !allowPlaceholder") &&
      writeCardBody.includes("expiresAt: Number(expiresAt || 0) || 0") &&
      writeCardBody.includes("nextRelay.rotate = {") &&
      writeCardBody.includes("{ apiKey: k, relay: nextRelay }"),
    "writeRelayKeyToConfig：真票落 apiKey + relay.{at,expiresAt,rotate}；占位串默认拒绝写（只有丢废票时显式放行）",
  );
  ok(
    fnBody("main.js", "saveRelayKeyEverywhere").includes("authStore.setRelayKey(key, expiresAt)") &&
      fnBody("main.js", "saveRelayKeyEverywhere").includes("writeRelayKeyToConfig(key, expiresAt, rotate)"),
    "saveRelayKeyEverywhere：本机凭据档与 config.json 那张卡**两处一起写**",
  );
  const authKeyBody = fnBody("main.js", "providerAuthKey");
  ok(
    authKeyBody.includes("RELAY_KEY_PLACEHOLDER") &&
      authKeyBody.includes("authStore.load()") &&
      authKeyBody.includes("cur.relayKey") &&
      authKeyBody.includes("relayCardOfDisk()") &&
      !authKeyBody.includes("cur.token"),
    "providerAuthKey 的优先级：卡上真票 > 本机凭据档里的票 > 盘上那张卡；绝不回占位串、也绝不回退登录 token",
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
    has("renderer/app-relay.js", "apiKey: keyView.key || KEY_PLACEHOLDER") &&
      has("renderer/app-relay.js", 'var KEY_PLACEHOLDER = "mtnode-account-token"'),
    "渲染层把真票写进卡上（apiKey: keyView.key || KEY_PLACEHOLDER；占位串只作「还没拿到票」的标记）",
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

  /* ── [1b] 真票明文下发：relay:keyInfo 回 key，maskSecret / maskedKey 已删除 ── */
  console.log("[1b] relay:keyInfo 回明文 key（maskedKey / maskSecret 整套打码口径已废除）");
  ok(
    !/function maskSecret\s*\(/.test(read("main.js")) && !read("main.js").includes("maskedKey"),
    "main.js 里 maskSecret 函数与 maskedKey 字段一并删除（打码口径作废）",
  );
  ok(
    has("main.js", 'ipcMain.handle("relay:keyInfo"') &&
      has("preload.js", "relayKeyInfo: () => ipcRenderer.invoke('relay:keyInfo')"),
    "relay:keyInfo 只走主进程桥（卡上要显示完整 Key 并给复制按钮，见 [2]）",
  );
  /* 带冒号的 IPC 名 `function x(` 取不到（fnBody 按 `function <name>(` 找，注释里也出现过
     这串）：这里直接钉源码里那几行，断言的是「回给渲染层的字段就是真票那一串」。 */
  const mainSrc = read("main.js");
  const keyInfoAt = mainSrc.indexOf('ipcMain.handle("relay:keyInfo"');
  const keyInfoReturn = keyInfoAt < 0 ? "" : mainSrc.slice(keyInfoAt, keyInfoAt + 2600);
  ok(
    keyInfoReturn.includes("const st = relayKeyStateNow();") &&
      keyInfoReturn.includes("key: st.key") &&
      keyInfoReturn.includes("keyLength: st.key.length") &&
      keyInfoReturn.includes("fromConfig: st.fromConfig") &&
      keyInfoReturn.includes("fromRelayKey: st.fromRelayKey") &&
      keyInfoReturn.includes("expiresAt: st.expiresAt") &&
      keyInfoReturn.includes("renewBeforeMs: st.renewBeforeMs") &&
      keyInfoReturn.includes("renewDue: st.due") &&
      keyInfoReturn.includes("rotate: st.rotate") &&
      keyInfoReturn.includes('from: st.signedIn ? "store" : "none"') &&
      !keyInfoReturn.includes("maskedKey"),
    "relay:keyInfo 回包：key（明文）/ keyLength / fromConfig / fromRelayKey / expiresAt / renewBeforeMs / renewDue / rotate / from=store|none，**没有** maskedKey",
  );
  ok(
    keyInfoReturn.includes('readIssue: String(readIssue || "")') &&
      keyInfoReturn.includes('const writeIssue = st.writeIssue === "write_unverified" ? st.writeIssue : "";') &&
      has("main.js", "authStore.readIssue()"),
    "relay:keyInfo 把 readIssue / writeIssue 转给渲染层（只一张原因标签，不含凭据内容）",
  );
  const relayMod = read("renderer/app-relay.js");
  ok(
    relayMod.includes("syncKeyInfo") &&
      relayMod.includes("relayKeyInfo()") &&
      relayMod.includes("keyViewFromInfo") &&
      relayMod.includes("key: String(r.key || \"\")") &&
      !relayMod.includes("keyMasked") &&
      !relayMod.includes("maskKey"),
    "app-relay.js：按 relay:keyInfo 回的 key 落进卡（maskKey / keyMasked 已删除）",
  );
  ok(
    relayMod.includes("resetKeyView()") &&
      relayMod.includes("p.apiKey = KEY_PLACEHOLDER"),
    "换账号 / 退出登录把卡上那份真票抹掉（apiKey 退回占位标记，等主进程重新写回）",
  );
  ok(
    relayMod.includes("p.apiKey = key.key || KEY_PLACEHOLDER") &&
      relayMod.includes("apiKey: keyView.key || KEY_PLACEHOLDER"),
    "app-relay.js 写进卡上的是真票（apiKey: keyView.key || KEY_PLACEHOLDER），没票才退回占位串",
  );
  /* 「没登录」与「凭据在手却解不开」在界面上必须分开说（readIssue 链路口径） */
  ok(
    has("auth-store.js", 'lastReadIssue = "decrypt_failed"') &&
      has("auth-store.js", 'lastReadIssue = "encryption_unavailable"') &&
      has("auth-store.js", "readIssue: () => lastReadIssue"),
    "auth-store 记录最近一次凭据读取失败的原因（decrypt_failed / encryption_unavailable）",
  );
  ok(
    !has("renderer/app-settings.js", 'meta.keyIssue === "decrypt_failed"') &&
      !has("renderer/app-settings.js", 'meta.keyIssue === "encryption_unavailable"') &&
      has("renderer/app-settings.js", 'meta.keyIssue === "server_no_relay_key"') &&
      !has("renderer/app-settings.js", "请重新登录一次"),
    "只读卡不再提「凭据读不出来 / 重新登录一次」，只留「服务端没下发 → 点刷新」这一档",
  );

  /* ── [1c] relay:rotateKey（卡上「更换 Key」）──────────────────────────── */
  console.log("[1c] relay:rotateKey：preload 桥 + 成功 / 429 两条回包口径");
  ok(
    has("preload.js", "relayRotateKey: () => ipcRenderer.invoke('relay:rotateKey')") &&
      has("main.js", 'ipcMain.handle("relay:rotateKey"'),
    "接线：preload 的 relayRotateKey → 主进程 relay:rotateKey",
  );
  const rotateSrc = (() => {
    const at = mainSrc.indexOf('ipcMain.handle("relay:rotateKey"');
    const end = mainSrc.indexOf('ipcMain.handle("relay:keyInfo"', at);
    return at < 0 ? "" : mainSrc.slice(at, end < 0 ? at + 2600 : end);
  })();
  const rotateFlat = rotateSrc.replace(/\s+/g, " ");
  ok(rotateSrc.length > 200, "找到 relay:rotateKey 的 handler");
  ok(
    rotateFlat.includes('path: "/api/relay/me"') &&
      rotateFlat.includes('method: "POST"') &&
      rotateFlat.includes("json: { rotate: true }"),
    "relay:rotateKey 打 POST /api/relay/me { rotate: true }",
  );
  ok(
    rotateFlat.includes("status === 429") &&
      rotateFlat.includes('I18n.t("今日更换次数已用完（5/5）")') &&
      rotateFlat.includes('code: String(doc.code || (r && r.code) || "")') &&
      rotateFlat.includes("rotate: rotateLimit") &&
      rotateFlat.includes("status === 401"),
    "限频回包：status 429 + code（RELAY_ROTATE_LIMIT）+「今日更换次数已用完（5/5）」+ rotate 余量；401 未登录单独一档",
  );
  ok(
    rotateFlat.includes("const saved = saveRelayKeyEverywhere(key, exp, rotate);") &&
      rotateFlat.includes("return { ok: true, key, keyExpiresAt: exp, rotate, storeOk: saved.storeOk, configOk: saved.configOk, }"),
    "成功回包：{ ok:true, key, keyExpiresAt, rotate, storeOk, configOk }（新票两处一起写）",
  );
  ok(
    relayMod.includes("window.api.relayRotateKey") &&
      relayMod.includes("function rotateKey()") &&
      relayMod.includes("rotateKey: rotateKey") &&
      relayMod.includes("keyView: keyViewFor"),
    "renderer/app-relay.js 的 rotateKey 走 window.api.relayRotateKey，并导出 MtRelay.rotateKey / MtRelay.keyView",
  );
  ok(
    fnBody("renderer/app-relay.js", "rotateKey").includes("res.key") &&
      fnBody("renderer/app-relay.js", "rotateKey").includes("p.apiKey = key") &&
      fnBody("renderer/app-relay.js", "rotateKey").includes("rotate: res.rotate || null"),
    "rotateKey 成功后把新票写进内存里的卡并落盘（磁盘上那份已由主进程写好），失败原样回报",
  );

  /* ── [1d] 401 处理：两处一起丢（本机凭据档 + 配置卡），登录态一律不动 ────── */
  console.log("[1d] relayAuthFailed → clearRelayCredentialEverywhere（两处一起丢）");
  const clearBody = fnBody("main.js", "clearRelayCredentialEverywhere");
  ok(
    has("main.js", "function clearRelayCredentialEverywhere") &&
      clearBody.includes("authStore.clearRelayKey()") &&
      clearBody.includes("writeRelayKeyToConfig(RELAY_KEY_PLACEHOLDER, 0, null, { allowPlaceholder: true })") &&
      !clearBody.includes("authStore.clear()"),
    "clearRelayCredentialEverywhere：本机凭据档 clearRelayKey + 配置卡 apiKey 退回占位串；不动登录态",
  );
  const authFailBody0 = fnBody("main.js", "relayAuthFailed");
  ok(
    authFailBody0.includes("clearRelayCredentialEverywhere()") &&
      !authFailBody0.includes("authStore.clear("),
    "relayAuthFailed 走 clearRelayCredentialEverywhere（401 只丢掉那张作废的票，登录态一律不动）",
  );

  /* 行为回归（跑真的 renderer/app-relay.js，window.api 用桩）：
     主进程回的 key（明文）必须真的落进卡上的 apiKey，卡上没有 keyMasked。 */
  const vm = require("vm");
  const RELAY_PLAIN_KEY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4";
  const RELAY_EXP = 4102444800000;
  const RELAY_ROTATE = { day: "2026-02-19", left: 4, limit: 5 };
  let relayRun = null;
  let relaySavedCfg = null;
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
        Promise.resolve({
          ok: true,
          signedIn: true,
          key: RELAY_PLAIN_KEY,
          keyLength: RELAY_PLAIN_KEY.length,
          fromConfig: true,
          fromRelayKey: true,
          expiresAt: RELAY_EXP,
          renewBeforeMs: 0,
          renewDue: false,
          rotate: RELAY_ROTATE,
          from: "store",
          readIssue: "",
          writeIssue: "",
        }),
      relayMe: () =>
        Promise.resolve({
          ok: true,
          at: Date.now(),
          keyState: {
            has: true,
            fromConfig: true,
            key: RELAY_PLAIN_KEY,
            expiresAt: RELAY_EXP,
            due: false,
            fromRelayKey: true,
            persisted: true,
            writeIssue: "",
            rotate: RELAY_ROTATE,
          },
          key: RELAY_PLAIN_KEY,
          keyExpiresAt: RELAY_EXP,
          rotate: RELAY_ROTATE,
          issuedRelayKey: true,
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
      configSave: (c) => {
        relaySavedCfg = c;
        return Promise.resolve(true);
      },
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
        card0.apiKey === RELAY_PLAIN_KEY &&
        !("keyMasked" in (card0.relay || {})) &&
        card0.relay.authKey === true &&
        card0.relay.fromConfig === true &&
        !!card0.relay.rotate &&
        card0.relay.rotate.left === 4,
      "同步一次后：卡上 apiKey 就是主进程回的那串真票（relay 里没有 keyMasked，带 fromConfig / rotate 余量）",
    );
    ok(
      !!relaySavedCfg &&
        !!relaySavedCfg.providers[0] &&
        relaySavedCfg.providers[0].apiKey === RELAY_PLAIN_KEY,
      "落盘的 config.json 里那张卡的 apiKey 也是同一串真票（不再写占位串）",
    );
    ok(
      !!relayRun &&
        typeof relayRun.window.MtRelay.keyView === "function" &&
        relayRun.window.MtRelay.keyView(card0).key === RELAY_PLAIN_KEY &&
        relayRun.window.MtRelay.maskKey === undefined,
      "MtRelay.keyView(prov) 回的就是真票；MtRelay.maskKey 已不存在",
    );
  });
  void relaySync;

  /* ── [2] 只读边界 ───────────────────────────────────────────── */
  console.log("[2] 只读边界：接入信息一处都不许手改");
  const card = fnBody("renderer/app-settings.js", "relayProvCard");
  ok(card.length > 500, "找到 relayProvCard（只读卡渲染函数）");
  ok(
    card.includes("relay-ro") && card.includes('I18n.t("API Key")') &&
      card.includes("MtRelay.keyView") && card.includes('classList.add("relay-key")'),
    "API Key 那一格显示**完整 Key**（<code class=\"relay-ro relay-key\">，取值走 MtRelay.keyView）",
  );
  /* 断言代码、不听注释（本文件同一口径见下面 cardCode）：
     那段说明行已整行删除，卡的代码里不该再出现它（注释里留一句「为什么删」是允许的）。 */
  const cardNoComment = card
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  ok(
    !cardNoComment.includes("由账号登录态托管") && !cardNoComment.includes("maskKey") &&
      !cardNoComment.includes("keyMasked") && !cardNoComment.includes("有效期至"),
    "打码那一套（maskKey / keyMasked / 凭据说明行）在卡上已整块撤掉",
  );
  ok(
    card.includes('row.className = "relay-keyops"') &&
      card.includes('cp.textContent = I18n.t("复制")') &&
      /* 复制不再直连 navigator.clipboard（权限闸会拒 → 曾经的「复制失败」）：
         统一走 app-settings.js 的 settingsClipboardWrite（navigator → preload 桥 → execCommand），
         并按返回结果给文案；回归见 test/smoke-settings-copy-key.js */
      card.includes("settingsClipboardWrite(keyText)") &&
      card.includes("复制失败，请手动选中后按 Ctrl+C 复制") &&
      !card.includes("navigator.clipboard") &&
      card.includes("cp.disabled = !keyText"),
    "Key 那一格旁边是「复制」按钮（settingsClipboardWrite 真票、失败给手动复制指引；没票时禁用）",
  );
  ok(
    card.includes('rb.textContent = I18n.t("更换 Key")') &&
      card.includes("confirmDialog(") &&
      card.includes("MtRelay.rotateKey()") &&
      card.includes('I18n.t("今日还可更换 {n} 次（每天 5 次）"'),
    "「更换 Key」按钮走 confirmDialog 二次确认 + MtRelay.rotateKey()（确认文案带上当日余量）",
  );
  ok(
    card.includes('I18n.t("可直接用于 Codex 等 OpenAI 兼容客户端：Base URL 就是上面那行接口地址")'),
    "有票时的提示行：可直接用于 Codex 等 OpenAI 兼容客户端（Base URL 就是上面那行接口地址）",
  );
  ok(
    card.includes('meta.keyIssue === "server_no_relay_key"') &&
      card.includes('I18n.t("还没有取到中转 Key：请先登录 MTNode 账号，或点「刷新中转清单」")'),
    "没票时的动作提示：先登录 MTNode 账号 / 点「刷新中转清单」（并区分「服务端没下发」）",
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
  /* 只读卡上**没有充值入口**（本轮口径）：全应用唯一的充值入口是右上角账户菜单里的
     「余额」（renderer/app-auth.js）。此前卡上那枚「去充值」只有充过值的账号才看得见，
     把入口挂在卡上等于对没充值的账号把它藏起来 —— 现场症状正是「已充值账户连充值入口也没了」。 */
  ok(
    !card.includes('I18n.t("去充值")') && !card.includes("MtWallet.open"),
    "只读卡上不再挂充值按钮（入口只留右上角账户菜单的「余额」）",
  );
  ok(
    !has("renderer/i18n.js", '"去充值"') && !has("renderer/i18n.js", '"打开余额（到账后中转清单会自动刷新）"'),
    "卡上那两枚按钮的 i18n 词条一并撤掉（不留死键）",
  );
  ok(
    fnBody("renderer/app-settings.js", "relayProvCard").includes('textContent = I18n.t("刷新")'),
    "余额行只剩「刷新」（充值与到账后的回拉在账户菜单那边的余额窗里）",
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
    "智体会话（DSH）参数里的占位串换成卡上那张真票后再进网关",
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

  /* ── [7b] 桌宠侧回滚：不再有自己的领票模块，只读同一份配置 ───────────────
     本轮口径：桌宠是独立进程，中转 Key 就在配置里那张卡上（主进程写入）——
     pet/pet-relay-cred.js 与 test/smoke-pet-relay.js 已删除，standalone-main.js 里
     不再有 PetRelayCred 接线，readAppConfig() 直接读盘，pet:listProviders 不换票；
     pet-provider.js 的 apiKeyOf 只保留「空 / 占位串 = 这家不可用」这道闸。 */
  console.log("[7b] 桌宠侧回滚：无自带领票模块，占位串闸门仍在");
  ok(
    !exists("pet/pet-relay-cred.js") && !exists("test/smoke-pet-relay.js"),
    "pet/pet-relay-cred.js 与 test/smoke-pet-relay.js 已删除（桌宠不再各自领票）",
  );
  const petStand = read("pet/standalone-main.js");
  const petStandCode = petStand
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  ok(
    !petStandCode.includes("PetRelayCred") && !petStandCode.includes("pet-relay-cred"),
    "standalone-main.js 里没有 PetRelayCred / pet-relay-cred 接线（只剩注释里那句「已删」）",
  );
  ok(
    !petStandCode.includes("relay/me") && !/relayCred|mintRelayKey/.test(petStandCode),
    "pet:listProviders 一路不换票（桌宠侧不再打发放口，谁也不会把别人的票顶掉）",
  );
  const petRead = fnBody("pet/standalone-main.js", "readAppConfig");
  ok(
    petRead.includes("readJson(appConfigPath(), {})") && !petRead.includes("PetRelayCred"),
    "readAppConfig() 直接读盘上那份 config.json（中转 Key 就在那张卡上）",
  );
  ok(
    !/"pet\/pet-relay-cred\.js"/.test(read("build.json")),
    "build.json 白名单里的 pet/pet-relay-cred.js 已删",
  );
  ok(
    fnBody("pet/pet-provider.js", "apiKeyOf").includes("RELAY_KEY_PLACEHOLDER") &&
      fnBody("pet/pet-provider.js", "apiKeyOf").includes("isRelayCard"),
    "pet-provider.js 的 apiKeyOf 只保留「空 / 占位串 = 这家不可用」这道闸",
  );
  /* 真跑桌宠的服务商解析器（纯函数模块，零依赖）：占位串那张卡列不出来，真票那张能列出来 */
  {
    const PetProvider = require(path.join(ROOT, "pet", "pet-provider.js"));
    const PLAIN = "f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e7f809";
    const relayCard = (key) => ({
      id: "mtnode-relay",
      name: "MTNode 中转服务",
      source: "mtnode-relay",
      type: "text_openai",
      baseUrl: "https://relay.invalid/v1",
      apiKey: key,
      models: ["deepseek-v4-flash"],
    });
    const placeholderKey = "mtnode-account-token";
    const withPlaceholder = PetProvider.listTextProviders({ providers: [relayCard(placeholderKey)] });
    const withPlain = PetProvider.listTextProviders({ providers: [relayCard(PLAIN)] });
    const piPlaceholder = PetProvider.mtnodePiProviders({ providers: [relayCard(placeholderKey)] });
    const piPlain = PetProvider.mtnodePiProviders({ providers: [relayCard(PLAIN)] });
    ok(
      withPlaceholder.length === 0 && piPlaceholder.length === 0,
      "实测：卡上还是占位串 → 桌宠列不出来（不拿占位串去撞 401）",
    );
    ok(
      withPlain.length === 1 && withPlain[0].id === "mtnode-relay" && piPlain.length === 1 &&
        piPlain[0].apiKey === PLAIN,
      "实测：卡上是真票 → 桌宠照常列出，并把这一串当下发凭据",
    );
  }

  /* ── [8] i18n ──────────────────────────────────────────────── */
  console.log("[8] i18n：新文案都有英文键");
  const i18n = read("renderer/i18n.js");
  const keys = [
    "MTNode 中转服务",
    "刷新中转清单",
    "账号托管",
    "余额不足",
    "可用余额 ",
    "上次同步 ",
    "未同步（点「刷新中转清单」重试）",
    "该账号还没有充值记录，充值成功后中转清单会自动出现",
    "模型清单（云端下发，从上到下为使用优先级）",
    /* 本轮新口径（真票就在卡上、显示全文 + 复制给 Codex 用、可手动换 Key）的文案 */
    "这串就是中转 Key：可直接用于 Codex 等 OpenAI 兼容客户端（Base URL 即上面的接口地址）",
    "可直接用于 Codex 等 OpenAI 兼容客户端：Base URL 就是上面那行接口地址",
    "复制中转 Key 到剪贴板",
    "中转 Key 已复制到剪贴板",
    "还没有取到中转 Key：请先登录 MTNode 账号，或点「刷新中转清单」",
    "更换 Key",
    "换一张新的中转 Key（旧 Key 立即失效）",
    "确定更换中转 Key？",
    "今日还可更换 {n} 次（每天 5 次）",
    /* 本轮新增：中转 401 真救不回来时界面只说这一句（用户口径） */
    "无效的 API Key",
    /* 「本机的账号凭据读不出来…请重新登录一次」那条已按用户口径**永久移除**，
       词条与代码都不留（见下面 gone 列表与 smoke-relay 的 [2] 段），这里不再要求它有英文键。 */
  ];
  const missing = keys.filter((k) => !i18n.includes('"' + k + '":'));
  ok(missing.length === 0, "中转服务文案全部有英文键" + (missing.length ? "（缺：" + missing.join(" / ") + "）" : ""));
  /* 打码口径作废：那两条「凭据 = 本机登录账号的 token…（打码显示）」的词条已没有代码引用
     （卡上现在显示完整 Key）。它们还留在 i18n.js 的字典里属于**源码侧的遗留死键** ——
     测试只钉「渲染层不再引用打码口径」，剩下的由源码侧清理（见本轮报告）。 */
  {
    const i18nMaskKeys = [
      "凭据 = 本机登录账号的 token（打码显示，前 4 + **** + 后 4；真凭据只留在主进程）",
      "还没有取到账号凭据：登录 MTNode 账号后自动带上（打码显示）",
    ];
    const files = fs
      .readdirSync(path.join(ROOT, "renderer"))
      .filter((f) => f.endsWith(".js") && f !== "i18n.js");
    const users = [];
    for (const f of files) {
      const s = read("renderer/" + f);
      for (const k of i18nMaskKeys) if (s.includes(k)) users.push("renderer/" + f + " → " + k);
    }
    ok(users.length === 0, "打码口径那两条词条在渲染层已无任何引用" + (users.length ? "（残留：" + users.join("、") + "）" : ""));
  }
  /* 被删掉的那批词条不许残留在 EN 表里（死键会被 smoke-filepeek 之类挑出来）。
     按**词条行**（"键": 开头）查，注释里写「为什么删」不算残留。 */
  const gone = [
    "由账号登录态托管（只读）",
    "由账号登录态托管（只读）：打码显示，真凭据不下发到界面",
    "由账号登录态托管（只读）：暂未取到账号凭据，登录后自动带上",
    "; the credential expires soon",
    "去充值",
    "打开余额（到账后中转清单会自动刷新）",
    "; valid until ",
  ];
  const left = gone.filter((k) => i18n.includes('"' + k + '":'));
  ok(left.length === 0, "随凭据说明行 / 卡上充值按钮撤掉的词条已清干净" + (left.length ? "（残留：" + left.join(" / ") + "）" : ""));

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
    has("renderer/app-wallet.js", 'return "¥" + Number(yuan || 0).toFixed(1);') &&
      has("renderer/app-relay.js", 'return "¥" + Number(yuan || 0).toFixed(1);') &&
      has("auth-store.js", '"balanceYuan"'),
    "钱包 / 中转模块的 money() 按元 1 位小数显示（¥2.0 / ¥50.0），账号摘要放行 balanceYuan",
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
  console.log("[12] 独立中转票（3650 天）与 401 兜底");
  ok(
    has("auth-store.js", "relayKey: typeof data.relayKey") &&
      has("auth-store.js", "relayKeyExpiresAt") &&
      has("auth-store.js", "setRelayKey: (relayKey, expiresAt)"),
    "加密凭据里存独立中转票（与登录 token 分开，明文仍只在本机主进程）",
  );
  /* 有效期口径：3650 天（≈10 年），分发一次后只要余额够就一直能用；
     续期窗口与 setRelayKey 落在同一份常量上（auth-store 是客户端唯一真源）。 */
  ok(
    has("auth-store.js", "const RELAY_KEY_MS = 3650 * 24 * 3600 * 1000;") &&
      has("auth-store.js", "relayRenewBeforeMs: () => RELAY_RENEW_BEFORE_MS") &&
      fnBody("main.js", "relayKeyStateNow").includes("relayRenewBeforeMs"),
    "客户端中转票口径 = 3650 天，续期窗口跟着有效期走（main.js 判续期用同一份常量）",
  );
  /* 凭据文件读不回来（DPAPI 上下文变了）这一态必须记下来并改用本机密钥存下一份，
     否则用户每重启一次就要白丢一次登录（现场病征：登录了还让重新登录）。 */
  ok(
    has("auth-store.js", "let forceAes = false") &&
      has("auth-store.js", 'if (raw.enc === "safeStorage") forceAes = true') &&
      has("auth-store.js", "if (encryptionAvailable() && !forceAes)"),
    "safeStorage 写出读不回即记为「本机不可靠」，此后一律用本机密钥 AES-GCM 存凭据",
  );
  ok(
    fnBody("main.js", "providerAuthKey").includes("cur.relayKey") &&
      fnBody("main.js", "providerAuthKey").includes("relayCardOfDisk()") &&
      !fnBody("main.js", "providerAuthKey").includes("cur.token"),
    "providerAuthKey：卡上真票 > 本机凭据档 > 盘上那张卡；**不再回退登录 token**",
  );
  ok(
    has("main.js", "function relayAuthFailed") &&
      has("main.js", "const RELAY_AUTH_MARK = \"MTNODE_RELAY_AUTH\"") &&
      has("store-saas/relay.mjs", "MTNODE_RELAY_AUTH"),
    "中转 401 有专用标记（别的服务商 401 一律不动登录态）",
  );
  /* 本轮修复的正主：登录后仍恒 401「中转 Key 已失效，请重新登录」。
     根因 = 领票只有「登录那一刻 / 打开设置」两个时机，票丢了 / 被顶掉时没人补；
     且老写法在 401 时连登录态一起 clear()，把「补领」这条路自己掐断。 */
  ok(
    has("auth-store.js", "clearRelayKey") &&
      fnBody("main.js", "relayAuthFailed").includes("clearRelayCredentialEverywhere()") &&
      fnBody("main.js", "clearRelayCredentialEverywhere").includes("authStore.clearRelayKey()") &&
      fnBody("main.js", "clearRelayCredentialEverywhere").includes("RELAY_KEY_PLACEHOLDER") &&
      !fnBody("main.js", "relayAuthFailed").includes("authStore.clear()"),
    "401 两处一起丢（本机凭据档 + 配置卡退回占位串），登录态保留（「补领新票」的路不被自己掐断）",
  );
  const mintFn = fnBody("main.js", "ensureRelayCredential");
  ok(
    has("main.js", "function ensureRelayCredential") &&
      mintFn.includes('path: "/api/relay/me"') &&
      mintFn.includes("saveRelayKeyEverywhere") &&
      mintFn.includes('String(src.source || "") !== RELAY_PROVIDER_SOURCE'),
    "缺票即自动补领：走 /api/relay/me 现领 + 两处一起落（saveRelayKeyEverywhere，只对中转卡动手）",
  );
  ok(
    mintFn.includes("cur.token") &&
      mintFn.includes("relayBootMintTried") &&
      mintFn.includes("relayMintInflight") &&
      has("main.js", "const RELAY_MINT_GAP_MS = 30 * 1000"),
    "补领的边界：没登录 / 凭据解不开不发请求；并发复用同一个 in-flight；冷却挡 401 风暴",
  );
  const callSrc = fnBody("main.js", "apiCall");
  ok(
    callSrc.includes("await ensureRelayCredential({ provider })") &&
      callSrc.includes("err.relayAuth") &&
      callSrc.includes("ensureRelayCredential({ provider, force: true })") &&
      callSrc.includes("return await attempt()"),
    "每次请求前自愈 + 撞 401 补票后原样重试一次（用户零操作）",
  );
  ok(
    has("main.js", "ensureRelayCredential({ provider: spec.provider, force: true })"),
    "流式先被拒（流还没吐字节）时同样先补票再兜底重发",
  );
  ok(
    has("store-saas/server.mjs", "RELAY_KEY_MS") &&
      has("store-saas/server.mjs", "async function issueRelayKey") &&
      has("store-saas/server.mjs", "async function ensureRelayKey") &&
      has("store-saas/server.mjs", "relayKeyExpiresAt: keyView.expiresAt"),
    "服务端发/回独立票（relay:me 是发放口，用时滑动续期）",
  );
  /* 上报 bug 的根因回归：发放口**必须给得到明文，且同一账号给的永远是同一张**。
     老口径「每次重发一张新票 + 作废该账号旧票」看着像在修「领不到票」，实际制造了新症状：
     客户端的登录 / 启动 / 打开设置都打这个入口 ⇒ 多开客户端 / 多台机器互相顶掉 ⇒
     恒 401「中转 Key 已失效，请重新登录」（现场截图）。现在明文票落用户记录 relayKeyPlain，
     发放口已有有效票就原样返回同一张；作废只剩退出登录 / 换账号 / 删号三条显式路径。
     服务端行为（同一张 / 换账号才轮换 / 旧票作废）由 test/smoke-relay.js 的 [3b] 段真跑服务端验；
     这里钉住实现口径不被改回「每次调用都 issueRelayKey」。 */
  const ensureBody = fnBody("store-saas/server.mjs", "ensureRelayKey");
  ok(
    !/await issueRelayKey\(u, t\);\s*\n\s*return \{ expiresAt: made\.expiresAt, ttlMs: RELAY_KEY_MS, token: made\.token \};\s*\n\}/.test(
      ensureBody,
    ) &&
      ensureBody.includes("RELAY_KEY_REUSE_MS") &&
      ensureBody.includes("relayPlainOf(u)") &&
      /token:\s*cur\.key/.test(ensureBody),
    "发放口幂发：已有有效票就原样返回同一张（不再每次调用都重发 —— 多开客户端互相顶掉的根因）",
  );
  ok(
    fnBody("store-saas/server.mjs", "issueRelayKey").includes("deleteSession") &&
      fnBody("store-saas/server.mjs", "issueRelayKey").includes("RELAY_KEY_FIELD"),
    "重发只发生在过期 / 换账号 / 手工失效时，且重发前把该账号旧票一并作废、明文一并改写",
  );
  /* relay:me 是 ipcMain.handle 里的箭头函数，fnBody 只认具名 function，这里按段取文本 */
  const meSrc = (() => {
    const s2 = read("main.js");
    const at = s2.indexOf('ipcMain.handle("relay:me"');
    const end = s2.indexOf('ipcMain.handle("relay:keyInfo"', at);
    return at < 0 ? "" : s2.slice(at, end < 0 ? at + 4000 : end);
  })();
  ok(
    meSrc.includes("keyState = relayKeyStateNow();") &&
      meSrc.includes("keyState,") &&
      meSrc.includes("issuedRelayKey") &&
      meSrc.includes("key: keyState.key,") &&
      meSrc.includes("keyExpiresAt: keyState.expiresAt,") &&
      meSrc.includes("rotate: keyState.rotate || rotateNow,"),
    "relay:me 回包新增 key（明文）/ keyExpiresAt / rotate（当日换票余量），并把 keyState 一并给渲染层",
  );
  ok(
    fnBody("renderer/app-relay.js", "sync").includes("ks.fromRelayKey") &&
      fnBody("renderer/app-relay.js", "sync").includes("MtRelayAuth.refresh"),
    "渲染层领到票当刻就把它落进卡（cachedKeyView）并回刷凭据状态，不等下次登录",
  );
  ok(
    fnBody("renderer/app-relay-auth.js", "signedIn").includes("MtRelay.syncIfStale"),
    "登录走完顺手去领一次票（票由客户端自己领，「登录着但还没有独立票」才不会卡住）",
  );
  ok(
    has("renderer/app-relay-auth.js", "function mtRelayAuthNotice") &&
      has("renderer/index.html", 'src="app-relay-auth.js"') &&
      has("renderer/app-boot.js", "MtRelayAuth.init"),
    "渲染层：中转提示模块仍在（真救不回来的 401 只说一句人话），启动时接入",
  );
  /* 本轮需求：**永久移除**「本机的登录凭据读不出来（已留档并清理）：请重新登录一次…」
     与顶部常驻横幅（.relay-auth-bar / .rab-btn / .rab-close 全删）——
     本机凭据存不住时 auth-store.js 自己改用本机密钥加密重存（零提示）；
     中转 401 由主进程静默换票 + 重试，真救不回来只说一句「无效的 API Key」。
     「文案已彻底移除」那条（含注释剥离的严格扫描）在 test/smoke-relay.js 的 [2] 段里钉。 */
  ok(
    has("renderer/app-relay-auth.js", 'className = "relay-auth-bar"') === false &&
      has("renderer/app-relay-auth.js", "rab-close") === false &&
      has("renderer/app-relay-auth.js", "showBar") === false,
    "顶部常驻横幅整块删除（不再有「重新登录」按钮 / ✕ / 亮横幅的逻辑）",
  );
  ok(
    has("renderer/css/components.css", ".relay-auth-bar {") === false &&
      has("renderer/css/components.css", ".relay-auth-toast {") === false &&
      has("renderer/css/components.css", ".toast-action {") === false &&
      has("renderer/app-relay-auth.js", 'className = "toast relay-auth-toast"') === false,
    "横幅与可点 toast 的样式一并删除（不留没人用的死规则）",
  );
  /* 本轮口径：能自动救回来的 401 不提示（主进程补票 + 重试），真救不回来只说一句人话 ——
     不再分「没登录 / 票没领到」两句劝用户重登（用户口径：那句话永久移除）。 */
  const noticeFn = fnBody("renderer/app-relay-auth.js", "mtRelayAuthNotice");
  ok(
    noticeFn.includes("INVALID_KEY_TEXT") &&
      !noticeFn.includes("重新登录"),
    "凭据失效提示收敛成一句「无效的 API Key」（不再劝用户重新登录）",
  );
  ok(
    has("renderer/app-relay-auth.js", 'var INVALID_KEY_TEXT = "无效的 API Key"'),
    "那句人话是模块里的常量（唯一文案真源）",
  );
  ok(
    has("renderer/i18n.js", '"无效的 API Key": "Invalid API key"'),
    "「无效的 API Key」有英文键（与 OpenAI 的 invalid_api_key 同口径）",
  );
  ok(
    has("main.js", "function apiErrUser") &&
      (read("main.js").match(/apiErrUser\(/g) || []).length >= 5,
    "所有抛错路径统一走 apiErrUser：中转 401 只出「无效的 API Key」，别的错误原样透出",
  );
  /* 到期自动续期（共识第 6 条）：登录 / 启动 / 打开设置卡片都走 syncIfStale，
     命中「该续期了」就顺带领一张新票 —— 不靠用户记得点「刷新中转清单」。 */
  const renewDueFn = fnBody("renderer/app-relay.js", "renewDue");
  ok(
    has("renderer/app-relay.js", "function renewDue()") &&
      renewDueFn.includes("relayKeyInfo") &&
      renewDueFn.includes('String(i.key || "")') &&
      renewDueFn.includes("renewDue"),
    "续期判据只问主进程 relay:keyInfo（还没有真票 / renewDue），不碰别处",
  );
  ok(
    fnBody("renderer/app-relay.js", "syncIfStale").includes("renewDue()") &&
      fnBody("renderer/app-relay.js", "syncIfStale").includes("force: true") &&
      has("renderer/app-relay.js", "var renewing = false"),
    "syncIfStale 命中续期即强制同步一次（并发只用 renewing 挡，不做失败节流）",
  );
  ok(
    !has("renderer/app-relay-auth.js", '"中转服务凭据即将到期：重新登录一次即可领取新的凭据"') &&
      !has("renderer/i18n.js", '"中转服务凭据即将到期：重新登录一次即可领取新的凭据":'),
    "「快到期，重新登录一次即可换新」整条撤掉（代码与 i18n 都不留：续期由客户端顺带完成，见 syncIfStale）",
  );
  /* 本轮需求：发放口**幂发同一张票**（老口径每次轮换 + 作废旧票 ⇒ 多开客户端 / 多台机器
     互相顶掉 ⇒ 恒 401 ⇒ 界面让人重登）。服务端行为由 test/smoke-relay.js 的 [3b] 真跑验；
     这里钉住实现口径不被改回「每次调用都 issueRelayKey」。 */
  const ensureReuse = fnBody("store-saas/server.mjs", "ensureRelayKey");
  ok(
    ensureReuse.includes("RELAY_KEY_REUSE_MS") &&
      ensureReuse.includes("relayPlainOf(u)") &&
      /token:\s*cur\.key/.test(ensureReuse),
    "发放口幂发：已有有效票就原样返回同一张（不再每次调用都重发）",
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
  /* 有效期口径（本轮需求）：「Key 分发一次后不应当失效」= 3650 天；续期窗口跟着走。 */
  ok(
    authSrc.includes("const RELAY_KEY_MS = 3650 * 24 * 3600 * 1000;") &&
      authSrc.includes("function clearRelayKey(") &&
      authSrc.includes("relayRenewBeforeMs: () => RELAY_RENEW_BEFORE_MS"),
    "客户端中转票有效期 3650 天 + 只清票不清登录态（clearRelayKey）+ 续期窗口导出",
  );
  ok(
    authSrc.includes("function quarantine(") &&
      authSrc.includes('quarantine(String(lastReadIssue || "broken"))') &&
      authSrc.includes('".broken-"'),
    "解不开的凭据文件搬走留档（同名 .broken-<时间>-<原因>，不删：出问题还能把文件发回来查）",
  );
  ok(
    /let back = decode\(JSON\.parse\(fs\.readFileSync\(filePath\(\), "utf8"\)\)\)/.test(authSrc) &&
      authSrc.includes("quarantine(\"roundtrip\")") &&
      authSrc.includes('error: "write_unverified"') &&
      /* 回读失败先**改存本机密钥再写一次**（forceAes + fallback），
         仍读不回来才判失败并隔离 —— 只校验不重试的话，用户每重启一次就要白丢一次登录 */
      authSrc.includes("forceAes = true") &&
      authSrc.includes("{ fallback: true }") &&
      /back = decode\(JSON\.parse\(fs\.readFileSync\(filePath\(\), "utf8"\)\)\)/.test(authSrc),
    "写后回读校验：读不回来先改存本机密钥重写一次，仍读不回来才判落盘失败（并隔离那份死文件）",
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

  /* 行为回归：拿一份**真的解不开**的密文跑一遍。
     为什么不再去读本机现场那份 auth-store.json：本机凭证已由本轮修好（能读回来），
     拿一份**好**文件去跑「解不开就留档」自然测不出东西（本轮之前它恰好是坏的，
     这条断言一直靠现场状态成立 —— 那是脆的）。现在固定自造一份 safeStorage 密文：
     Electron 的 safeStorage.decryptString 拿到这种噪音必然抛错，正好当「解不开」的样本。 */
  {
    const os = require("os");
    const brokenRaw = JSON.stringify({
      v: 1,
      enc: "safeStorage",
      payload: Buffer.from("not-a-dpapi-blob-just-noise-0123456789").toString("base64"),
      savedAt: Date.now(),
    });
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
          "解不开的凭据：load 回 null + 文件已搬到 .broken-* 留档（不再反复毒化）",
        );
        ok(
          o.save && o.save.ok === true && o.reload && o.reload.token === "healed-token",
          "隔离之后重新登录能写出一份**读得回来**的凭据（重登一次就真的恢复）",
        );
        ok(
          o.badEnc === "aesgcm" && o.badSave && o.badSave.ok === true && o.badReload && o.badReload.token === "t2",
          "safeStorage 写得出读不回来时：改用本机密钥 AES-GCM，凭据照旧读得回来",
        );
        /* 用户口径：这类「凭据读不出来 / 请重新登录一次」的话**永久移除**，界面与提示词里
           都不许再出现（留档那条告警只进 error.log，且措辞里不再劝用户重登）。 */
        ok(
          !(o.warns || []).some((m) => /重新登录/.test(String(m))),
          "留档告警里不再出现「重新登录一次」这类把责任推给用户的话（只进日志、不改口径成用户动作）",
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
      /* 卡上那行 Key 的取值口径（与真身 app-relay.js 的 keyView 同口径：卡上 apiKey 就是真票） */
      keyView: (p) => {
        const own = String((p && p.apiKey) || "");
        const key = own === "mtnode-account-token" ? "" : own;
        return {
          authKey: !!key,
          key: key,
          keyIssue: "",
          fromConfig: !!key,
          fromRelayKey: !!key,
          expiresAt: 0,
          renewDue: false,
          rotate: (p && p.relay && p.relay.rotate) || null,
        };
      },
      rotateKey: () => Promise.resolve({ ok: false, error: "stub" }),
      KEY_PLACEHOLDER: "mtnode-account-token",
      stateText: () => "",
      money: (y) => "¥" + Number(y || 0).toFixed(1),
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
        relayKeyInfo: () =>
          Promise.resolve({
            ok: true, signedIn: true, key: "stub-relay-key", keyLength: 14,
            fromConfig: true, fromRelayKey: true, expiresAt: 0, renewBeforeMs: 0, renewDue: false,
            rotate: null, from: "store", readIssue: "", writeIssue: "",
          }),
        relayRotateKey: () => Promise.resolve({ ok: false, error: "stub" }),
      },
      /* relayProvCard 的「更换 Key」按钮会用到（本轮只在渲染期断言它在，不点它） */
      confirmDialog: () => Promise.resolve(false),
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
      MtWallet: { open: () => {}, money: (y) => "¥" + Number(y || 0).toFixed(1) },
      applyTheme: () => {},
      renderAgentMenu: () => {},
      buildAgentModeMenu: () => {},
      agentModeEntryOf: () => null,
    };
    sandbox.window.window = sandbox.window;
    vi.createContext(sandbox);
    vi.runInContext(read("renderer/app-settings.js"), sandbox, { filename: "app-settings.js" });
    const CARD_KEY = "c0ffee0123456789abcdef0123456789abcdef0123456789abcdef01234567";
    const relayCard1 = {
      id: "mtnode-relay",
      name: "MTNode 中转服务",
      source: "mtnode-relay",
      type: "text_openai",
      baseUrl: "https://example.invalid/relay/v1",
      apiKey: CARD_KEY,
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
        keyIssue: "",
        fromConfig: true,
        fromRelayKey: true,
        expiresAt: 0,
        renewDue: false,
        rotate: { day: "2026-02-19", left: 4, limit: 5 },
      },
      disabled: false,
    };
    S.config.providers = [relayCard1];
    const host = sandbox.ensureProvCfgDlg();
    sandbox.openProviderConfigDialog(relayCard1);
    const onAfterOpen = host.classList.contains("on");
    ok(!!relaySub, "打开中转卡时会订阅 MtRelay 的变更（同步结果要落回这张卡）");
    /* 真跑一遍 relayProvCard（上面这棵假 DOM）：卡上那格显示的必须是**完整 Key**，
       旁边是「复制」与「更换 Key」两个按钮，下面是给 Codex 用的提示行。 */
    const bodyOpen = host.querySelector("#provCfgBody");
    const keyEl = bodyOpen && bodyOpen.querySelector(".relay-key");
    ok(
      !!keyEl && keyEl.textContent === CARD_KEY,
      "真跑 relayProvCard：API Key 那一格是完整 Key（.relay-key 的正文 == 卡上 apiKey）",
    );
    const keyOps = bodyOpen && bodyOpen.querySelector(".relay-keyops");
    const opTexts = keyOps ? keyOps.children.map((c) => c.textContent) : [];
    ok(
      opTexts.length === 2 && opTexts[0] === "复制" && opTexts[1] === "更换 Key",
      "Key 那一格旁边是「复制」与「更换 Key」两个按钮（实际渲染：" + JSON.stringify(opTexts) + "）",
    );
    const hints = bodyOpen ? bodyOpen.querySelectorAll(".settings-hint") : [];
    ok(
      hints.some((h) => /Codex 等 OpenAI 兼容客户端/.test(h.textContent)),
      "提示行说清这串 Key 可直接用于 Codex 等 OpenAI 兼容客户端（Base URL 就是上面那行接口地址）",
    );
    /* 没票（卡上还是占位串）时的动作提示：先登录 / 点「刷新中转清单」 */
    {
      const noKeyCard = JSON.parse(JSON.stringify(relayCard1));
      noKeyCard.apiKey = "mtnode-account-token";
      noKeyCard.relay.authKey = false;
      noKeyCard.relay.fromConfig = false;
      noKeyCard.relay.fromRelayKey = false;
      S.config.providers = [noKeyCard];
      sandbox.openProviderConfigDialog(noKeyCard);
      const bodyNoKey = host.querySelector("#provCfgBody");
      const keyEl2 = bodyNoKey && bodyNoKey.querySelector(".relay-key");
      const hints2 = bodyNoKey ? bodyNoKey.querySelectorAll(".settings-hint") : [];
      ok(
        !!keyEl2 && keyEl2.textContent === "—" &&
          hints2.some((h) => /还没有取到中转 Key/.test(h.textContent) && /刷新中转清单/.test(h.textContent)),
        "没票时：Key 那格空着（「—」）并给动作提示「请先登录 MTNode 账号，或点「刷新中转清单」」",
      );
      S.config.providers = [relayCard1];
    }
    /* 同步一来整张卡被换成**新的对象**（renderer/app-relay.js 的 applyDoc 行为），
       随后 MtRelay 播一次变更 → 对话框按订阅回调重画（真身就是这条路）。 */
    const rebuilt = JSON.parse(JSON.stringify(relayCard1));
    rebuilt.relay.rotate = { day: "2026-02-19", left: 3, limit: 5 };
    rebuilt.apiKey = "beefbeef0123456789abcdef0123456789abcdef0123456789abcdef012345";
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
    const keyNow = bodyNow && bodyNow.querySelector(".relay-key");
    ok(
      !!keyNow && keyNow.textContent === rebuilt.apiKey,
      "重画后 Key 那格跟着新卡走（换 Key 之后界面立刻显示新那串）",
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
    !has("renderer/app-relay-auth.js", 'i.readIssue === "write_unverified"') &&
      !has("renderer/app-relay-auth.js", "readIssue") &&
      !has("renderer/app-relay-auth.js", '"重新登录"'),
    "顶部横幅那一族分支整块删除（不再按 readIssue 亮横幅、不再有「重新登录」按钮文案）",
  );
  ok(
    has("renderer/i18n.js", "The server did not issue a relay credential this time") &&
      has("renderer/i18n.js", '"无效的 API Key": "Invalid API key"') &&
      !has("renderer/i18n.js", "This machine cannot read its stored sign-in credential") &&
      !has("renderer/i18n.js", "This machine cannot persist the account credential"),
    "i18n：只留「服务端没下发」（点刷新即可）与「无效的 API Key」两条；被删文案的英文键一并撤掉",
  );
  ok(
    has("main.js", "function apiErrUser") &&
      has("main.js", "无效的 API Key") &&
      !has("main.js", "stripRelayAuthMark") &&
      read("main.js").split("apiErrUser(").length - 1 >= 5,
    "主进程：删标记的旧写法换成 apiErrUser（中转 401 直接给「无效的 API Key」，不再透出上游 JSON）",
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

"use strict";
/* 会话「思考」翻译（右侧小按钮）—— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-think-translate.js
 *
 * 需求：会话里的思考内容旁边给一个右侧小按钮，点了用默认模型（优先 flash）+ 无思考
 *       把这段思考翻译出来，译文就地显示、可重复查看、可复制。
 *
 * 本轮改了什么（真源都在项目根，本测试只做静态口径核对 + i18n 真模块配对）：
 *   renderer/app-assist.js   思考翻译模块（dshThinkTranslateBtn / Row / Paint /
 *                            dshTranslateThinking / dshTranslateModel）+ 三处思考渲染接线
 *                            （历史分段 / 运行中分段 / 无分段的老消息）
 *   renderer/app.js          S.thinkTrans 运行态（不持久化）
 *   renderer/css/dsh.css     按钮 + 译文行样式（深色）
 *   renderer/css/theme-light.css  浅色版
 *   renderer/i18n.js         新中文串逐条有英文词条
 *
 * 覆盖：
 *   [1] 三处思考渲染都挂上翻译按钮与译文行（不许只挂一处）
 *   [2] 调用口径：默认路由 + 优先 flash 模型 + effort:"off"（无思考）+ 逐段缓存
 *   [3] 按钮交互：stopPropagation（不会连带开合 details）+ 键盘 Enter/Space 拦截
 *   [4] 状态与样式：S.thinkTrans 运行态、CSS 类与主题色齐备
 *   [5] i18n：新串在英文界面逐条命中（用真 i18n 模块，不做「只含中文的孤儿串」）
 */
const fs = require("fs");
const path = require("path");

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
const abs = (rel) => path.join(__dirname, "..", ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");

const ASSIST = read("renderer/app-assist.js");
const APP = read("renderer/app.js");
const MAIN = read("main.js");
const DB = read("renderer/app-db.js");
const DSS = read("renderer/css/dsh.css");
const LIGHT = read("renderer/css/theme-light.css");
const I18N_SRC = read("renderer/i18n.js");
const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));
const I18N_REAL = require(path.join(__dirname, "..", "renderer", "i18n.js"));

function section(name) {
  console.log("\n" + name);
}

/* ═══════════════════ [1] 三处思考渲染都接线 ═══════════════════ */
section("[1] 三处思考渲染都挂上翻译按钮（历史分段 / 运行中分段 / 无分段老消息）");
ok(
  typeof I18N_SRC === "string" && ASSIST.indexOf("function dshThinkTranslateBtn(") > 0,
  "app-assist.js 有 dshThinkTranslateBtn（右侧小按钮 builder）",
);
ok(
  ASSIST.indexOf("function dshThinkTranslateAppend(") > 0,
  "app-assist.js 有 dshThinkTranslateAppend（按钮 + 译文行一次插入）",
);
ok(
  ASSIST.indexOf("function dshThinkTranslateRow(") > 0 &&
    ASSIST.indexOf("function dshThinkTranslatePaint(") > 0,
  "app-assist.js 有译文行 builder + 就地刷新（不整表重绘）",
);
ok(
  ASSIST.indexOf("function dshTranslateThinking(") > 0,
  "app-assist.js 有 dshTranslateThinking（点击后的翻译流程）",
);
const appendCalls = (ASSIST.match(/dshThinkTranslateAppend\(/g) || []).length;
ok(
  appendCalls >= 4,
  "dshThinkTranslateAppend 至少 4 处出现（1 定义 + 3 处渲染接线），实测 " + appendCalls,
);
ok(
  ASSIST.indexOf("dshThinkTranslateAppend(wrap, det, sum, txt, nodeId, oKey, txt)") > 0,
  "历史分段（dshHistSegEl）挂上翻译",
);
ok(
  ASSIST.indexOf("else dshThinkTranslateAppend(box, det, sum, txt, st.id, oKey, txt)") >
    0,
  "运行中分段（agentLiveSegsEl）在思考段定稿后挂上翻译",
);
ok(
  /if \(streaming\) box\.appendChild\(det\);\s*\n\s*else dshThinkTranslateAppend/.test(
    ASSIST,
  ),
  "仍在增长的思考段不挂按钮（不翻半截、避免译文与原文对不上）",
);
ok(
  /dshThinkTranslateAppend\(\s*\n?\s*thinkBox,\s*\n?\s*det,\s*\n?\s*sum,/.test(ASSIST),
  "无分段的老消息（m.reasoning 整段）也挂上翻译",
);
/* 按钮必须在思考折叠条那一行最右端：append 只往 summary 里塞按钮，不再另起一行 */
const appendSrc = ASSIST.slice(
  ASSIST.indexOf("function dshThinkTranslateAppend("),
  ASSIST.indexOf("/* 历史消息的一段 → DOM"),
);
ok(
  appendSrc.indexOf("sum.appendChild(") > 0 &&
    appendSrc.indexOf('sum.classList.add("dsh-think-bar")') > 0,
  "按钮塞进折叠条 summary 的最右端（不另起一行）",
);
ok(
  appendSrc.indexOf('document.createElement("div")') < 0,
  "append 不再创建独立的按钮行 div（按钮行已并入折叠条）",
);
ok(
  (ASSIST.match(/class="dsh-think-sum-txt"|className = "dsh-think-sum-txt"/g) || [])
    .length >= 3 &&
    ASSIST.indexOf('sum.querySelector(".dsh-think-sum-txt")') > 0,
  "折叠条文案单独一层 span（刷新字数不会把按钮冲掉）",
);

/* ═══════════════════ [2] 调用口径 ═══════════════════ */
section("[2] 调用口径：默认模型（优先 flash）+ 无思考 + 逐段缓存");
ok(
  ASSIST.indexOf("function dshTranslateModel(") > 0 &&
    ASSIST.indexOf("preferredAgentProviderRoute") > 0,
  "模型解析走「默认智能路由」（preferredAgentProviderRoute）",
);
ok(
  ASSIST.indexOf("/flash/i.test(") > 0 && ASSIST.indexOf("const flash =") > 0,
  "该路由下有 flash 档时优先 flash（deepseek-v4-flash）",
);
ok(
  ASSIST.indexOf("preferredAgentModelForRoute") > 0,
  "flash 不可用时退回默认模型（preferredAgentModelForRoute）",
);
ok(
  /effort:\s*"off"/.test(ASSIST),
  'spec.effort = "off"（无思考：main.js applyTextThinkingEffort 下发 thinking disabled）',
);
ok(
  ASSIST.indexOf("applyTextThinkingEffort") > 0,
  "注释点明 off 的落点（applyTextThinkingEffort），口径可追溯",
);
ok(
  ASSIST.indexOf("dshTranslateProvider") > 0 &&
    ASSIST.indexOf("providerForAgentRoute") > 0,
  "服务商按路由解析（providerForAgentRoute）并校验 API Key",
);
ok(
  ASSIST.indexOf("S.thinkTrans") > 0 &&
    ASSIST.indexOf("if (cached && cached.status === \"done\")") > 0,
  "逐段缓存：同一段翻过一次即复用（S.thinkTrans）",
);
ok(
  ASSIST.indexOf("apiCallTextStream(spec, null, null)") > 0,
  "翻译复用渲染层统一的流式文本调用 apiCallTextStream",
);
ok(
  ASSIST.indexOf("【思考内容】") > 0 &&
    ASSIST.indexOf("只输出译文本身") > 0,
  "提示词写清「只输出译文」并附【思考内容】",
);
ok(
  ASSIST.indexOf("const DSH_XLATE_MAX = 12000") > 0 &&
    ASSIST.indexOf("src.length > DSH_XLATE_MAX") > 0,
  "超长思考先截断（DSH_XLATE_MAX = 12000），不让翻译请求变成巨量 token",
);

/* ═══════════════════ [3] 按钮交互 ═══════════════════ */
section("[3] 按钮交互：不会连带开合思考折叠块");
const btnSrc = ASSIST.slice(
  ASSIST.indexOf("function dshThinkTranslateBtn("),
  ASSIST.indexOf("function dshThinkTranslateAppend("),
);
ok(
  btnSrc.indexOf("ev.stopPropagation()") > 0 &&
    btnSrc.indexOf("ev.preventDefault()") > 0,
  "按钮 click / mousedown 拦掉冒泡（点按钮不会顺带展开 / 收起 details）",
);
ok(
  btnSrc.indexOf('ev.key === "Enter"') > 0 && btnSrc.indexOf('ev.key === " "') > 0,
  "键盘 Enter / Space 一并拦掉（键盘激活也不会开合 details）",
);
ok(
  btnSrc.indexOf('b.disabled = true') > 0,
  "翻译中按钮置灰，避免重复发请求",
);
const rowSrc = ASSIST.slice(
  ASSIST.indexOf("function dshThinkTranslateRow("),
  ASSIST.indexOf("function dshThinkTranslatePaint("),
);
ok(
  rowSrc.indexOf("dshClipboardWrite") > 0 && rowSrc.indexOf('I18n.t("复制")') > 0,
  "译文行带「复制」按钮（复用 dshClipboardWrite）",
);
ok(
  rowSrc.indexOf("plainTextToLinkHtml") > 0,
  "译文用纯文本渲染（plainTextToLinkHtml），不把模型输出当 HTML 执行",
);

/* ═══════════════════ [4] 状态与样式 ═══════════════════ */
section("[4] 运行态与样式");
ok(
  /thinkTrans:\s*\{\}/.test(APP) && APP.indexOf("S.thinkTrans") > 0,
  "app.js 有 S.thinkTrans 运行态（不持久化，与 S.thinking / S.openDshTools 同层）",
);
ok(
  DSS.indexOf("button.dsh-think-xlate") > 0 &&
    DSS.indexOf(".dsh-think-bar") > 0 &&
    DSS.indexOf(".dsh-seg-xlate") > 0,
  "dsh.css 有按钮 / 按钮行 / 译文行的样式",
);
ok(
  DSS.indexOf(".dsh-seg-xlate pre") > 0,
  "译文正文限高自滚（.dsh-seg-xlate pre），不把会话撑长",
);
ok(
  LIGHT.indexOf(".dsh-seg-xlate") > 0 && LIGHT.indexOf("button.dsh-think-xlate") > 0,
  "浅色主题有对应覆盖（theme-light.css）",
);
ok(
  // 只用真实存在的变量：--cyan / --cyan2 / --red / --bd2
  !/var\(--(cyan2|red2|cyan|red|bd2)\s*,/.test(DSS.slice(DSS.indexOf(".dsh-think-bar"))),
  "思考翻译样式只用已定义的主题变量（无 --cyan2, --cyan 式无效回退）",
);

/* ═══════════════════ [5] i18n 中英成对 ═══════════════════ */
section("[5] i18n：新串在英文界面逐条命中");
const keys = [
  "翻译",
  "翻译中…",
  "重试翻译",
  "译文",
  "⚠ 翻译失败",
  "翻译失败",
  "模型未返回译文",
  "复制译文到剪贴板",
  "用默认模型（优先 flash · 无思考）翻译这段思考",
  "未找到可用文本服务商（请在设置 · API/配置中配置并填写 API Key）",
  "未找到可用模型（请在设置中选择该服务商的模型）",
  "复制失败",
];
for (const k of keys) {
  ok(I18N_SRC.indexOf('"' + k + '"') >= 0, "i18n 有词条：" + k.slice(0, 18));
}
I18n.setLocale("en");
for (const k of keys) {
  const en = I18n.t(k);
  ok(en && en !== k && /^[\x20-\x7e…⚠·]*$/.test(en), "英文界面已译：" + k.slice(0, 18) + " → " + en);
}
I18n.setLocale("zh");
ok(I18N_REAL.t("翻译") === "翻译", "中文口径原样返回（中文为键）");

/* ═══════════════════ [6] 译文校验 + 逐档重试（「翻译没翻成中文」的修） ═══════════════════ */
section("[6] 译文校验 + 逐档重试：复述原文 / 元话术不再被当成译文缓存");
ok(
  ASSIST.indexOf("function dshXlateLooksTranslated(") > 0 &&
    ASSIST.indexOf("function dshTranslateCandidates(") > 0,
  "app-assist.js 有译文校验（dshXlateLooksTranslated）与候选链（dshTranslateCandidates）",
);
ok(
  ASSIST.indexOf("if (!dshXlateLooksTranslated(src, out))") > 0 &&
    ASSIST.indexOf("lastOut = out;") > 0,
  "校验不通过 ⇒ 记下并走下一档（不落缓存、不显示成译文）",
);
ok(
  ASSIST.indexOf("翻译质量校验未通过（模型仍在输出原文）") > 0,
  "校验失败有明确错误文案（用户可点「重试翻译」）",
);
ok(
  ASSIST.indexOf("for (let i = 0; i < cands.length; i++)") > 0 &&
    ASSIST.indexOf("dshTranslateCandidates(") > 0,
  "请求改走候选链循环（同模型常规 → 同模型强化 → 更强模型）",
);
ok(
  ASSIST.indexOf("maxTokens: c.strict ? maxTok : Math.min(maxTok, 8192)") > 0 &&
    ASSIST.indexOf("const maxTok = Math.min(16384") > 0,
  "译文带上限 maxTokens，避免长思考被服务端默认上限截成半句",
);
ok(
  MAIN.indexOf("body.max_tokens = Math.max(256, Math.min(32768, Math.round(cap)))") > 0 &&
    MAIN.indexOf("spec.maxTokens,") > 0,
  "main.js 把 spec.maxTokens 夹到合理区间后下发（api:callStream → buildRequestSpec）",
);
ok(
  ASSIST.indexOf('if (store[key] === it && it.status !== "done")') > 0,
  "只有所有候选都没拿到像样译文时，该段才落到 error 态",
);
ok(
  ASSIST.indexOf("it.model =") > 0 && ASSIST.indexOf("（第 ") > 0,
  "译文行标注实际生效的模型与第几次尝试（可追溯）",
);

/* ═══════════════════ [7] 403「not eligible」：弹窗问一句换模型，不静默降级、不白等重发 ═══════════════════
   现场：阿里云百炼 Token Plan 域名（token-plan.cn-beijing.maas.aliyuncs.com）对**所有**模型回
   403 {"type":"AccessDenied.Unpurchased","message":"Access to model denied. Please make sure you
   are eligible for using the model."}。旧行为：翻译逐档白试三轮，会话运行还按「可重发」等 5 秒
   ×5 原样重发（同一模型 / 同一 Key / 同一套餐，结果一模一样），用户看到的就是一句 403。
   新口径：判出这类「没开通」的 403 ⇒ 弹窗问用户要不要换一个能用的模型；同意就换路由重来。 */
section("[7] 403 not eligible：弹窗询问换模型（翻译按钮 + 运行重发闸 ×2 家）");
ok(
  ASSIST.indexOf("function dshAccessDeniedText(") > 0 &&
    ASSIST.indexOf("AccessDenied|Unpurchased|not eligible") > 0,
  "app-assist.js 有 403 未开通判据（dshAccessDeniedText：AccessDenied / Unpurchased / not eligible）",
);
ok(
  ASSIST.indexOf("async function dshXlateAskSwitchModel(") > 0 &&
    /typeof confirmDialog !== "function"/.test(ASSIST),
  "翻译侧 403 询问窗用通用确认框 confirmDialog（app.js，不受 #overlay 弹窗影响）",
);
ok(
  ASSIST.indexOf("const sw = await dshXlateAskSwitchModel(") > 0 &&
    ASSIST.indexOf("i = -1; /* 换家后从候选链第 1 档重来 */") > 0 &&
    ASSIST.indexOf("let cands = dshTranslateCandidates(") > 0,
  "用户同意后换路由 / 换模型、候选链重算并从头重试（不再白试同家的其余档）",
);
ok(
  ASSIST.indexOf("if (!asked)") > 0 && ASSIST.indexOf("asked = true;") > 0,
  "403 只问一次（答「不换」或换完再 403 就落 error，不连环弹窗）",
);
ok(
  ASSIST.indexOf("换模型失败：该服务商没有可用的 API Key") > 0,
  "选中的替代路由没有 API Key 时给明确失败文案，不静默吞掉",
);
ok(
  ASSIST.indexOf("function dshTranslateProvider(") > 0 &&
    ASSIST.indexOf("top: 0,") < 0 &&
    ASSIST.indexOf("prov: dshTranslateProvider(route)") > 0,
  "翻译模型解析一次性带回 {route, model, prov}（切换后 provider 跟着换）",
);
ok(
  DB.indexOf("function dshRunAccessDenied(") > 0 &&
    DB.indexOf("function dshRunAskSwitchModel(") > 0 &&
    DB.indexOf("function dshRunRoutes(") > 0,
  "app-db.js 有同源的 403 判据 / 询问窗 / 候选路由（会话 · 助手 · 节点共用一条运行闸）",
);
ok(
  /const attempt = \(resume, switchTo\) =>/.test(DB) &&
    /const nextOpts = switchTo\s*\n\s*\? Object\.assign\(\{\}, baseOpts, \{\s*\n\s*provider: switchTo\.route/.test(
      DB,
    ),
  "用户同意后按 {provider, model} 整轮重发（attempt(resume, switchTo)）",
);
ok(
  DB.indexOf("if (tries >= DSH_RETRY_MAX || !dshRunRetryable(msg)) {") > 0 &&
    DB.indexOf("return attempt(null, sw);") > 0,
  "403 不进 5 次原样重发闸，而是走「问一句 → 换模型重发」",
);
ok(
  /if \(\s*\/AccessDenied\|Unpurchased\|not eligible\|not_eligible\|ineligible\|\(\^\|\[\^0-9\]\)403/.test(
    DB,
  ) && DB.indexOf("让用户以为程序卡住") > 0,
  "dshRunRetryable 把 403「not eligible」判死（注释写明为什么重发没意义）",
);
ok(
  ASSIST.indexOf('I18n.t("当前：")') > 0 &&
    ASSIST.indexOf('I18n.t("原始报文：")') > 0,
  "询问窗里说清「当前是哪家 / 哪只模型 + 服务商原话」再问（用户据此判断要不要换）",
);
const xlateKeys = [
  "换模型",
  "换并重试",
  "不换",
  "换一个模型来翻译？将改用：",
  "换一个模型重发这一轮？将改用：",
  "模型服务返回 403：该模型/套餐未开通（服务商原话：Access to model denied… not eligible）。",
  "换模型失败：该服务商没有可用的 API Key",
  "当前：",
  "原始报文：",
  "已改用：",
];
for (const k of xlateKeys) {
  ok(
    I18N_SRC.indexOf('"' + k + '"') >= 0,
    "i18n 有 403 换模型词条：" + k.slice(0, 16),
  );
}
I18n.setLocale("en");
for (const k of xlateKeys) {
  const en = I18n.t(k);
  ok(
    en && en !== k && /^[\x20-\x7e…—]*$/.test(en),
    "英文界面已译（403 换模型）：" + k.slice(0, 16),
  );
}
I18n.setLocale("zh");

/* 真跑一次重发判据（抽出 app-db.js 的真实 dshRunRetryable，不是静态字符串核对）：
   403「not eligible」判死，429 与网络类照旧可重发。 */
{
  const vm = require("vm");
  const dbSrc = DB;
  const grab = (head) => {
    const i = dbSrc.indexOf(head);
    if (i < 0) throw new Error("抽不到：" + head);
    /* 结束锚点必须在函数体内找「return true;」之后（正文注释里也有 } 形状的片段）；
       行尾按实际文件取（app-db.js 是 CRLF），两种都兜住 */
    const anchor = dbSrc.indexOf("return true;", i);
    if (anchor < 0) throw new Error("抽不到函数体：" + head);
    let j = dbSrc.indexOf("\r\n}\r\n", anchor);
    if (j < 0) j = dbSrc.indexOf("\n}\n", anchor);
    if (j < 0) throw new Error("抽不到函数尾：" + head);
    return dbSrc.slice(i, j + (dbSrc[j] === "\r" ? 5 : 3));
  };
  const sandbox = {
    console,
    I18n: { t: (s) => String(s) },
    isCancelishError: (m) => /已手动停止|已请求终止|用户取消了本轮|Request was aborted/i.test(String(m || "")),
  };
  vm.createContext(sandbox);
  vm.runInContext(grab("function dshRunRetryable("), sandbox, {
    filename: "retryable-extract.js",
  });
  const R = (m) => vm.runInContext("dshRunRetryable(" + JSON.stringify(m) + ")", sandbox);
  ok(
    R(
      'HTTP 403：Access to model denied. Please make sure you are eligible for using the model.',
    ) === false,
    "重发判据：403 not eligible → 判死（不再白等 5 秒 ×5 原样重发）",
  );
  ok(
    R('{"error":{"type":"AccessDenied.Unpurchased"}}') === false,
    "重发判据：AccessDenied.Unpurchased → 判死",
  );
  ok(R("HTTP 403：Forbidden") === false, "重发判据：任何 403 都不重发");
  ok(R("429 Too Many Requests") === true, "重发判据：429 照旧可重发（没误伤正主）");
  ok(R("network error ETIMEDOUT") === true, "重发判据：网络类照旧可重发");
}

console.log(
  "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-think-translate)",
);
process.exit(fails ? 1 : 0);

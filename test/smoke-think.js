/* test/smoke-think.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-think.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-think-translate.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-think-translate.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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

  /* ═══════════════════ [1] 思考条目 + 弹窗都接线 ═══════════════════ */
  section("[1] 思考条目只剩一行摘要条，翻译按钮活在弹窗的原文栏头（本次需求）");
  ok(
    typeof I18N_SRC === "string" && ASSIST.indexOf("function dshThinkTranslateBtn(") > 0,
    "app-assist.js 有 dshThinkTranslateBtn（按钮 builder）",
  );
  ok(
    ASSIST.indexOf("function dshThinkRowEl(") > 0,
    "app-assist.js 有 dshThinkRowEl（一行摘要条：整行可点 → 弹窗）",
  );
  ok(
    ASSIST.indexOf("function dshThinkTranslateRow(") > 0 &&
      ASSIST.indexOf("function dshThinkPopPaintXlate(") > 0,
    "app-assist.js 有译文框 builder + 就地刷新那一个框（不整表重绘）",
  );
  ok(
    ASSIST.indexOf("function dshTranslateThinking(") > 0,
    "app-assist.js 有 dshTranslateThinking（点击后的翻译流程）",
  );
  const rowCalls = (ASSIST.match(/dshThinkRowEl\(\{/g) || []).length;
  ok(
    rowCalls >= 4,
    "dshThinkRowEl 至少 4 处接线（历史分段 / 运行中分段 / 无分段老消息 / 无分段 live），实测 " + rowCalls,
  );
  ok(
    /const btn = dshThinkRowEl\(\{\s*\n\s*text: txt,\s*\n\s*scopeId: nodeId,/.test(ASSIST),
    "历史分段（dshHistSegEl）改成一行摘要条",
  );
  ok(
    /const btn = dshThinkRowEl\(\{\s*\n\s*text: txt,\s*\n\s*scopeId: st\.id,/.test(ASSIST),
    "运行中分段（agentLiveSegsEl）同样是摘要条（正在增长的那段也照旧跟字数）",
  );
  ok(
    /const tRow = dshThinkRowEl\(\{/.test(ASSIST) &&
      (ASSIST.match(/const tRow = dshThinkRowEl\(\{/g) || []).length >= 2,
    "无分段老消息（m.reasoning 整段）与无分段 live 也各有一行摘要条",
  );
  /* 本次需求：不再有下拉开合 —— details / summary / 展开态键都不该再出现 */
  ok(
    ASSIST.indexOf("dshThinkTranslateAppend") < 0 &&
      ASSIST.indexOf(".dsh-think-bar") < 0 &&
      ASSIST.indexOf('S.openDshTools[oKey]') < 0,
    "旧的「下拉展开 + 折叠条最右端按钮」整套接线已删（同一处只剩一条交互口径）",
  );
  ok(
    (ASSIST.match(/[A-Za-z]+\.className = "dsh-think-sum-txt"/g) || []).length >= 1 &&
      ASSIST.indexOf('rowBtn.querySelector(".dsh-think-sum-txt")') > 0,
    "摘要条文案单独一层 span（流式刷新字数只改这一层，不冲掉整行结构）",
  );
  /* 本轮需求（用户口径）：窗里只有一个原文框，翻译按钮挂在它的栏头；译文框点了翻译才建，
     译文本体写在译文框栏头下方的框里 —— 旧写法把译文框插进栏头、又在正文区画一次。 */
  ok(
    ASSIST.indexOf("function dshThinkPopCol(") > 0 &&
      /dshThinkPopCol\(root, "src", I18n\.t\("思考原文"\)\)/.test(ASSIST) &&
      !/dshThinkPopCol\(root, "xlate"/.test(ASSIST),
    "弹窗只建原文一栏（译文那一栏不预先建 → 未点翻译时看不到译文框）",
  );
  ok(
    ASSIST.indexOf("function dshThinkTranslatePaint(") < 0 &&
      /left\.tools\.appendChild\(cp\)/.test(ASSIST) &&
      /left\.tools\.appendChild\(btn\)/.test(ASSIST),
    "「复制」与「翻译」都挂原文栏头，旧的「往按钮后面插一行」那条路径已删",
  );
  ok(
    /if \(!r\) \{[\s\S]{0,160}?removeChild\(col\)/.test(ASSIST) &&
      /root\.appendChild\(col\); \/\* 原文框下面（不是右栏）\*\//.test(ASSIST),
    "有译文才建译文框、并把正文写进它栏头下方的框（没译文就把整栏收掉）",
  );
  ok(
    !/paneEl\.dataset\.xkey = XKEY/.test(ASSIST) && !/\bconst XKEY = /.test(ASSIST),
    "弹窗不再按 xkey 找「右栏正文位」（那一层分栏已撤）",
  );
  ok(
    ASSIST.indexOf("function dshThinkMdHtml(") > 0 &&
      /escapeHtml\(s\)/.test(ASSIST) &&
      ASSIST.indexOf("rvMarkdownHtml(esc)") > 0 &&
      ASSIST.indexOf("plainTextToLinkHtml(s)") > 0,
    "原文 / 译文都按 Markdown 渲染：先转义 HTML 再走应用唯一那份渲染入口，拿不到才回落纯文本",
  );

  /* ═══════════════════ [2] 调用口径 ═══════════════════ */
  section("[2] 调用口径：会话自己的模型（回落默认路由 + flash）+ 无思考 + 逐段缓存");
  ok(
    ASSIST.indexOf("function dshTranslateModel(") > 0 &&
      ASSIST.indexOf("preferredAgentProviderRoute") > 0,
    "模型解析有回落口径（preferredAgentProviderRoute；会话自己那一位优先，见 [8]）",
  );
  ok(
    ASSIST.indexOf("/flash/i.test(") > 0 && ASSIST.indexOf("const flash =") > 0,
    "回落时该路由下有 flash 档就优先 flash（deepseek-v4-flash）",
  );
  ok(
    ASSIST.indexOf("preferredAgentModelForRoute") > 0,
    "回落时 flash 不可用才退回默认模型（preferredAgentModelForRoute）",
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
    /* 本轮（翻译质量校验误杀修）后提示词改成 system + user 分离：
       卡口在 system（「你是翻译引擎…只输出译文本身」），整段思考单独一条 user ——
       「【思考内容】」这个拼接标记已撤（把指令与思考拼成一条 user 会让模型原样复述）。 */
    ASSIST.indexOf("你是翻译引擎") > 0 &&
      ASSIST.indexOf("只输出译文本身") > 0 &&
      /chatMessages:\s*\[\s*\n\s*\{ role: "system"/.test(ASSIST),
    "提示词写清「只输出译文本身」并走 system + user 分离（不再拼【思考内容】一条 user）",
  );
  ok(
    ASSIST.indexOf("const DSH_XLATE_MAX = 12000") > 0 &&
      ASSIST.indexOf("src.length > DSH_XLATE_MAX") > 0,
    "超长思考先截断（DSH_XLATE_MAX = 12000），不让翻译请求变成巨量 token",
  );

  /* ═══════════════════ [3] 按钮交互 ═══════════════════ */
  section("[3] 按钮交互：不连带关窗 / 开合任何东西");
  const btnSrc = ASSIST.slice(
    ASSIST.indexOf("function dshThinkTranslateBtn("),
    ASSIST.indexOf("function dshThinkPopPaintXlate("),
  );
  ok(
    btnSrc.indexOf("ev.stopPropagation()") > 0 &&
      btnSrc.indexOf("ev.preventDefault()") > 0,
    "按钮 click / mousedown 拦掉冒泡（点按钮不顺带触发祖先上的点击）",
  );
  ok(
    btnSrc.indexOf('ev.key === "Enter"') > 0 && btnSrc.indexOf('ev.key === " "') > 0,
    "键盘 Enter / Space 一并拦掉（键盘激活也不会触发祖先）",
  );
  ok(
    btnSrc.indexOf('b.disabled = true') > 0,
    "翻译中按钮置灰，避免重复发请求",
  );
  const rowSrc = ASSIST.slice(
    ASSIST.indexOf("function dshThinkTranslateRow("),
    ASSIST.indexOf("function dshThinkTranslateBtn("),
  );
  ok(
    rowSrc.indexOf("dshClipboardWrite") > 0 && rowSrc.indexOf('I18n.t("复制")') > 0,
    "译文块带「复制」按钮（复用 dshClipboardWrite）",
  );
  ok(
    rowSrc.indexOf("dshThinkMdHtml") > 0 &&
      rowSrc.indexOf("dsh-xlate-md") > 0 &&
      rowSrc.indexOf('I18n.t("翻译中…")') > 0,
    "译文本体写在译文框栏头**下方**的正文框里、按 Markdown 渲染（翻译中 / 失败不占正文框）",
  );

  /* ═══════════════════ [4] 状态与样式 ═══════════════════ */
  section("[4] 运行态与样式");
  ok(
    /thinkTrans:\s*\{\}/.test(APP) && APP.indexOf("S.thinkTrans") > 0,
    "app.js 有 S.thinkTrans 运行态（不持久化，与 S.thinking / S.openDshTools 同层）",
  );
  ok(
    DSS.indexOf("button.dsh-think-xlate") > 0 &&
      DSS.indexOf(".dsh-seg-xlate") > 0 &&
      DSS.indexOf(".dsh-think-pop-pane") > 0,
    "dsh.css 有按钮 / 译文框 / 弹窗正文框的样式",
  );
  ok(
    DSS.indexOf(".dsh-think-pop-pane .dsh-xlate-md") > 0 &&
      DSS.indexOf(".dsh-think-pop .md-viewer-doc") > 0,
    "原文 / 译文的 Markdown 正文都限在弹窗的框里（复用 .md-viewer-doc 版式并收掉页宽）",
  );
  ok(
    DSS.indexOf(".dsh-think-pop-pane-xlate") > 0 && !/\.dsh-seg-xlate pre \{/.test(DSS),
    "一个译文只占一个框（译文栏不再套第二层虚线框，旧的 pre 规则已撤）",
  );
  ok(
    LIGHT.indexOf(".dsh-seg-xlate") > 0 && LIGHT.indexOf("button.dsh-think-xlate") > 0,
    "浅色主题有对应覆盖（theme-light.css）",
  );
  ok(
    // 只用真实存在的变量：--cyan / --cyan2 / --red / --bd2
    !/var\(--(cyan2|red2|cyan|red|bd2)\s*,/.test(DSS.slice(DSS.indexOf(".dsh-think-pop-pane"))),
    "思考弹窗样式只用已定义的主题变量（无 --cyan2, --cyan 式无效回退）",
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

  /* ═══════════════════ [8] 翻译用该会话自己的模型（本次需求） ═══════════════════
     需求原话：翻译时，使用该会话自己的模型。
     旧口径：一律用「默认智能路由 + flash 优先」，同一屏上几个不同供应商的会话
     （DeepSeek 官方 / 各文本服务商 / 本地 llama）翻译全走同一条路由 —— 用的不是
     该会话的模型，也不吃该会话那一份服务商与配额。
     新口径：scope（会话 id 或画布节点 id）→ 该会话对象 → st.provider / st.model，
     模型跟着会话走；模型没写就取这家第一只（与运行时下发同一口径）；这家没有可用
     API Key / 没有模型 / scope 找不回会话 → 才回落「默认路由 + flash 优先」。 */
  section("[8] 翻译用该会话自己的模型：scope → 会话 → provider/model，取不到才回落");
  ok(
    ASSIST.indexOf("function dshTranslateScopeModel(") > 0 &&
      ASSIST.indexOf("function dshTranslateFlashModel(") > 0,
    "app-assist.js 有「会话自己的模型」解析（dshTranslateScopeModel）+ 回落口径（dshTranslateFlashModel）",
  );
  ok(
    /function dshTranslateModel\(scopeId\)[\s\S]{0,400}dshTranslateScopeModel\(scopeId\)[\s\S]{0,400}dshTranslateFlashModel\(\)/.test(
      ASSIST,
    ),
    "dshTranslateModel(scopeId) 以会话自己的模型为主、flash 口径为回落（顺序即优先级）",
  );
  ok(
    ASSIST.indexOf("function dshXlateSessionOf(") > 0 &&
      ASSIST.indexOf("typeof agentSessionById === \"function\"") > 0,
    "scope 是会话 id 时按 id 取会话（agentSessionById，取不到不回退到当前活动会话）",
  );
  ok(
    /node\.agentSessionId[\s\S]{0,200}node\.devAskSessionId[\s\S]{0,200}node\.devSessionIds/.test(
      ASSIST,
    ),
    "scope 是画布节点 id 时按 node.agentSessionId / devSessionIds / devAskSessionId 找回会话",
  );
  ok(
    /route = String\(st\.provider \|\| ""\)\.trim\(\);\s*\n\s*model = String\(st\.model \|\| ""\)\.trim\(\);/.test(
      ASSIST,
    ),
    "会话自己的供应商 + 模型成对取用（st.provider / st.model，运行时同一份真源）",
  );
  ok(
    /if \(!model\) model = String\(models\[0\] \|\| ""\);/.test(ASSIST) &&
      /if \(!model\) return null;/.test(ASSIST),
    "会话没写模型 ⇒ 取这家第一只；这家没有可用模型 ⇒ 回落（不塞空模型）",
  );
  ok(
    /else if \(models\.length && !models\.some\(\(m\) => String\(m\) === model\)\)/.test(ASSIST),
    "会话存的模型已不在该家清单 ⇒ 也用该家第一只（不拿这家没有的模型去发 400）",
  );
  ok(
    /route !== "deepseek-official" && route\.indexOf\("mtnode_"\) !== 0/.test(ASSIST) &&
      /if \(!dshTranslateProvider\(route\)\) return null;/.test(ASSIST),
    "服务商在有效路由集合内且真有 API Key 才用（否则回落，不静默换成别家）",
  );
  ok(
    ASSIST.indexOf("const first = dshTranslateModel(scopeId);") > 0,
    "翻译流程把 scope 一路传进模型解析（dshTranslateThinking(btn, scopeId, …)）",
  );
  ok(
    /function dshXlateRoutes\(route, scopeId\)[\s\S]{0,700}dshTranslateScopeModel\(scopeId\)/.test(
      ASSIST,
    ),
    "403 换模型的候选路由也把会话自己那家排在最前（换模型不跳出该会话的供应商）",
  );
  ok(
    ASSIST.indexOf("dshXlateAskSwitchModel(cRoute, c.model, em, scopeId)") > 0,
    "403 询问窗带 scope 与**候选自己的路由**（换家后当前路由就是那一家，候选与本次 scope 一致）",
  );
  ok(
    ASSIST.indexOf("用该会话自己的模型（无思考）翻译这段思考") > 0 &&
      ASSIST.indexOf("用默认模型（优先 flash · 无思考）翻译这段思考") < 0,
    "按钮 tooltip 改说「该会话自己的模型」（旧「默认模型（优先 flash）」文案不再出现在 app-assist.js）",
  );
  I18n.setLocale("zh");
  ok(
    I18n.t("用该会话自己的模型（无思考）翻译这段思考") ===
      "用该会话自己的模型（无思考）翻译这段思考",
    "新 tooltip 词条中文口径原样返回",
  );
  I18n.setLocale("en");
  ok(
    /own model/i.test(I18n.t("用该会话自己的模型（无思考）翻译这段思考")),
    "新 tooltip 词条有英文对译：" + I18n.t("用该会话自己的模型（无思考）翻译这段思考"),
  );
  I18n.setLocale("zh");

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

  /* 真跑一次「翻译用该会话自己的模型」（抽出 app-assist.js 的真实函数，喂假会话与
     假服务商配置，看它到底选谁 —— 不是读源码文本）：
     scope 是会话 id / 画布节点 id 两种形态都验，回落口径也验一次。 */
  {
    const vm = require("vm");
    /* 按大括号配平抽函数（跳过字符串与行注释），不靠固定锚点 */
    const grabFn = (src, name) => {
      const head = "function " + name + "(";
      const i = src.indexOf("\n" + head);
      if (i < 0) throw new Error("抽不到函数：" + name);
      let j = src.indexOf("{", i);
      let depth = 0;
      for (let k = j; k < src.length; k++) {
        const ch = src[k];
        if (ch === '"' || ch === "'" || ch === "`") {
          const q = ch;
          k++;
          while (k < src.length && src[k] !== q) {
            if (src[k] === "\\") k++;
            k++;
          }
          continue;
        }
        if (ch === "/" && src[k + 1] === "/") {
          while (k < src.length && src[k] !== "\n") k++;
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (!depth) return src.slice(i + 1, k + 1);
        }
      }
      throw new Error("抽不到函数尾：" + name);
    };
    const src = [
      "dshTranslateModel",
      "dshXlateSessionOf",
      "dshTranslateScopeModel",
      "dshTranslateProvider",
      "dshTranslateFlashModel",
    ]
      .map((f) => grabFn(ASSIST, f))
      .join("\n");
    /* 假配置：DeepSeek 官方有 Key（v4-flash / v4-pro），另一家服务商有 Key（qwen-max） */
    const mkSb = (sessions, nodes) => {
      const provs = {
        "deepseek-official": { apiKey: "sk-ds" },
        mtnode_p1: { apiKey: "sk-p1" },
        mtnode_nokey: { apiKey: "" },
      };
      const models = {
        "deepseek-official": ["deepseek-v4-flash", "deepseek-v4-pro"],
        mtnode_p1: ["qwen-max", "qwen-plus"],
        mtnode_nokey: ["ghost-1"],
      };
      const sb = {
        console,
        S: { wf: { nodes: nodes || [] }, agentSessions: sessions || [] },
        agentSessionById: (id) => (sessions || []).find((s) => s && s.id === id) || null,
        agentSessions: () => sessions || [],
        providerForAgentRoute: (r) => provs[r] || null,
        agentModelsForRoute: (r) => models[r] || [],
        preferredAgentProviderRoute: () => "deepseek-official",
        defaultAgentProviderRoute: () => "deepseek-official",
        preferredAgentModelForRoute: (r) => (models[r] || [])[0] || "",
      };
      vm.createContext(sb);
      vm.runInContext(src, sb, { filename: "xlate-model-extract.js" });
      return sb;
    };
    const call = (sb, scope) =>
      vm.runInContext(
        "dshTranslateModel(" + (scope === undefined ? "" : JSON.stringify(scope)) + ")",
        sb,
      );
    /* ① 会话自己选了别家服务商 + 别只模型：就用它（不吃 flash 优先） */
    {
      const sb = mkSb([{ id: "as1", provider: "mtnode_p1", model: "qwen-plus" }]);
      const r = call(sb, "as1");
      ok(
        r.route === "mtnode_p1" && r.model === "qwen-plus" && !!r.prov,
        "真跑：会话选 mtnode_p1 · qwen-plus（非 flash）⇒ 翻译就用它，实测 " +
          r.route +
          " · " +
          r.model,
      );
    }
    /* ② 会话是 DeepSeek 官方且自己选了 pro：也用会话自己那只，不偷偷换回 flash */
    {
      const sb = mkSb([{ id: "as2", provider: "deepseek-official", model: "deepseek-v4-pro" }]);
      const r = call(sb, "as2");
      ok(
        r.route === "deepseek-official" && r.model === "deepseek-v4-pro",
        "真跑：会话选 deepseek-v4-pro ⇒ 不回落 flash（实测 " + r.model + "）",
      );
    }
    /* ③ 会话没写模型：取这家第一只（与运行时下发同一口径） */
    {
      const sb = mkSb([{ id: "as3", provider: "mtnode_p1", model: "" }]);
      const r = call(sb, "as3");
      ok(
        r.route === "mtnode_p1" && r.model === "qwen-max",
        "真跑：会话没写模型 ⇒ 取该服务商第一只（实测 " + r.model + "）",
      );
    }
    /* ③b 会话存的模型已不在该服务商清单里（用户换过这家模型 / 旧存档）⇒ 用该家第一只，
       不拿一只这家根本没有的模型去发 */
    {
      const sb = mkSb([{ id: "as3b", provider: "mtnode_p1", model: "qwen-gone" }]);
      const r = call(sb, "as3b");
      ok(
        r.route === "mtnode_p1" && r.model === "qwen-max",
        "真跑：会话存的模型已不在该家清单 ⇒ 用该家第一只（实测 " +
          r.model +
          "，不是 qwen-gone）",
      );
    }
    /* ③c 会话选的就是该家清单里的第二只 ⇒ 原样用它，一个字都不改 */
    {
      const sb = mkSb([{ id: "as3c", provider: "mtnode_p1", model: "qwen-plus" }]);
      const r = call(sb, "as3c");
      ok(
        r.model === "qwen-plus",
        "真跑：会话选的是该家清单里的第二只 ⇒ 原样用它（实测 " + r.model + "）",
      );
    }
    /* ④ scope 是画布节点 id：按 node.agentSessionId 找回该节点会话 */
    {
      const sb = mkSb([{ id: "as4", provider: "mtnode_p1", model: "qwen-max" }], [
        { id: "n1", kind: "agent_task", agentSessionId: "as4" },
      ]);
      const r = call(sb, "n1");
      ok(
        r.route === "mtnode_p1" && r.model === "qwen-max",
        "真跑：scope 是节点 id ⇒ 按 node.agentSessionId 用该节点会话的模型",
      );
    }
    /* ⑤ 开发块节点：scope 是节点 id，会话在 devSessionIds[0] */
    {
      const sb = mkSb([{ id: "as5", provider: "mtnode_p1", model: "qwen-plus" }], [
        { id: "dev1", kind: "super", dev: true, devSessionIds: ["as5"] },
      ]);
      const r = call(sb, "dev1");
      ok(
        r.route === "mtnode_p1" && r.model === "qwen-plus",
        "真跑：开发块绑定会话（devSessionIds）照样按它自己的模型翻",
      );
    }
    /* ⑥ 会话那家没有可用 API Key ⇒ 回落默认路由 + flash 优先（不静默用别家顶替） */
    {
      const sb = mkSb([{ id: "as6", provider: "mtnode_nokey", model: "ghost-1" }]);
      const r = call(sb, "as6");
      ok(
        r.route === "deepseek-official" && r.model === "deepseek-v4-flash" && !!r.prov,
        "真跑：会话那家没 Key ⇒ 回落默认路由 + flash（实测 " + r.route + " · " + r.model + "）",
      );
    }
    /* ⑦ 会话那家路由已不在配置里（服务商被删 / 旧会话）⇒ 同样回落，不硬发 */
    {
      const sb = mkSb([{ id: "as7", provider: "mtnode_gone", model: "x-1" }]);
      const r = call(sb, "as7");
      ok(
        r.route === "deepseek-official" && r.model === "deepseek-v4-flash",
        "真跑：会话的供应商已不在配置里 ⇒ 回落默认路由（不拿老路由硬发）",
      );
    }
    /* ⑧ 无 scope（老调用方 / 找不到归属）⇒ 旧口径原样（默认路由 + flash） */
    {
      const sb = mkSb([{ id: "as8", provider: "mtnode_p1", model: "qwen-max" }]);
      const r = call(sb, undefined);
      ok(
        r.route === "deepseek-official" && r.model === "deepseek-v4-flash",
        "真跑：没有 scope ⇒ 旧口径（默认路由 + flash）原样保留",
      );
    }
    /* ⑨ 该家一只模型都没有 ⇒ 回落（不返回空模型让调用方白跑） */
    {
      const sb = mkSb([{ id: "as9", provider: "mtnode_p1", model: "" }]);
      vm.runInContext("globalThis.__m = 0;", sb);
      sb.agentModelsForRoute = (r) => (r === "mtnode_p1" ? [] : ["deepseek-v4-flash"]);
      const r = call(sb, "as9");
      ok(
        r.route === "deepseek-official" && r.model === "deepseek-v4-flash",
        "真跑：会话那家没有可用模型 ⇒ 回落默认路由（不返回空模型）",
      );
    }
  }

  console.log(
    "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-think-translate)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-think-translate.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-think-translate.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：思考翻译「校验误杀 + 重试没换模型」回归 ====================
   现场（用户报）：点「翻译」后永远得到
     「翻译质量校验未通过（模型仍在输出原文）｜模型仍返回原文，已重试 2 次」
   本机实测（.tmp-xlate/diag.mjs · deepseek-v4-flash · thinking disabled）：
     · 思考正文是「英文推理 + 本项目中文原文 / 路径」的混合文本时，旧提示词
       （把英文指令与思考塞在同一条 user 消息里）会让模型原样复述整段；
     · 旧校验「输出里有中文 ⇒ 通过」于是放行这段复述（真相被掩盖），
       而候选链里两只候选（会话自己那只 deepseek-v4-flash 与全局助手那只
       deepseek-v4.1-flash）都是同族 flash ⇒ 第 2 次请求是同一只模型的同一份
       确定性请求，必然同结果。
   现口径：① 校验先判「同文复述」（与语言无关，剔掉代码块 / 行内码 / 链接 / 路径后的
   字符级重合度 ≥ 0.8 即判死）；② 候选链必须在第 2 档就换一只真模型（换路由）；
   ③ 提示词改成 system + user 分离，正文单独一条 user。 */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-think-xlate-quality.js";
  const { fs, path, vm } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const readRel = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
  const ASSIST = readRel("renderer/app-assist.js");
  const DSS = readRel("renderer/css/dsh.css");
  const I18N_SRC = readRel("renderer/i18n.js");
  const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));

  /* 按大括号配平抽顶层函数 / 常量（跳过字符串与行注释），不靠固定锚点。
     注意：本次要抽的函数里有正则字面量（/[*_>#...]/），而字符类里会出现 { } [ ]
     —— 配平必须先把注释 / 字符串 / 正则整体吞掉，否则会在大括号计数上提前收尾
     （报「函数体不完整」）。吞掉的片段用空格占位，长度与索引保持一一对应。 */
  function blankOut(src) {
    const out = src.split("");
    const n = src.length;
    const isId = (ch) => /[A-Za-z0-9_$]/.test(ch || "");
    let prev = "";
    for (let i = 0; i < n; i++) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") out[i++] = " ";
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        out[i++] = " ";
        out[i++] = " ";
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) out[i++] = " ";
        if (i < n) out[i++] = " ";
        if (i < n) out[i++] = " ";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        out[i] = " ";
        i++;
        while (i < n && src[i] !== q) {
          if (src[i] === "\\") {
            out[i++] = " ";
            if (i < n) out[i++] = " ";
            continue;
          }
          out[i++] = " ";
        }
        if (i < n) out[i] = " ";
        prev = q;
        continue;
      }
      /* 正则字面量：`/` 出现在「不是标识符 / 数字之后」的位置（= ( , : [ ! & | ? { ; return …） */
      if (c === "/" && !isId(prev) && prev !== ")" && prev !== "]") {
        out[i] = " ";
        i++;
        let inClass = false;
        while (i < n) {
          const d = src[i];
          if (d === "\\") {
            out[i++] = " ";
            if (i < n) out[i++] = " ";
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          else if (d === "\n") break;
          out[i++] = " ";
        }
        if (i < n && src[i] === "/") out[i] = " ";
        i++;
        while (i < n && /[a-z]/i.test(src[i])) out[i++] = " ";
        i--;
        prev = "/";
        continue;
      }
      if (!/\s/.test(c)) prev = c;
    }
    return out.join("");
  }
  const BLANK_ASSIST = blankOut(ASSIST);
  function fnBody(src, name) {
    const clean = src === ASSIST ? BLANK_ASSIST : blankOut(src);
    const pats = [
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
      new RegExp("\\nconst " + name + "\\s*=", "m"),
    ];
    let at = -1;
    for (const p of pats) {
      const m = clean.match(p);
      if (m) {
        at = m.index + 1;
        break;
      }
    }
    if (at < 0) throw new Error("找不到函数/常量：" + name);
    const isFn = /^(async\s+)?function/.test(clean.slice(at, at + 14));
    const i = clean.indexOf(isFn ? "{" : "=", at);
    let depth = 0;
    for (let j = i; j < clean.length; j++) {
      const c = clean[j];
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (!depth) return src.slice(at, j + 1) + (isFn ? "" : ";");
      }
    }
    throw new Error("函数体不完整：" + name);
  }

  /* ═══════════════════ [A] 真跑校验函数：同文复述必须判死，真译文不许误杀 ═══════════════════ */
  section("[A] 译文校验真跑：混合中英思考的同文复述判死、带代码 / 路径的真译文不误杀");
  {
    const sb = { console };
    vm.createContext(sb);
    vm.runInContext(
      [
        fnBody(ASSIST, "DSH_XLATE_CODE_RE"),
        fnBody(ASSIST, "dshXlateProse"),
        fnBody(ASSIST, "dshXlateEchoes"),
        fnBody(ASSIST, "dshXlateLooksTranslated"),
      ].join("\n"),
      sb,
      { filename: "xlate-quality.js" },
    );
    const looks = (src, out) =>
      vm.runInContext("dshXlateLooksTranslated(" + JSON.stringify(src) + "," + JSON.stringify(out) + ")", sb);
    const echoes = (src, out) =>
      vm.runInContext("dshXlateEchoes(" + JSON.stringify(src) + "," + JSON.stringify(out) + ")", sb);

    /* 现场语料 ①：DeepSeek 在中文项目里的常态思考 —— 英文推理 + 中文原文 / 路径 */
    const mixed = [
      "The user says the thinking translation keeps failing the quality check.",
      "需求：检查思考翻译功能为什么出现 翻译质量校验未通过（模型仍在输出原文）。",
      "I need to read E:\\dev\\tools\\pipeline-console\\renderer\\app-assist.js and find",
      "dshTranslateThinking, then check the candidate chain in dshTranslateCandidates.",
    ].join("\n");
    const mixedOut = mixed;
    const mixedZh =
      "用户说思考翻译一直通不过质量校验。需求：检查思考翻译功能为什么出现这句话。" +
      "需要查看 renderer/app-assist.js 里的 dshTranslateThinking，再核对 dshTranslateCandidates 的候选链。";
    /* 现场语料 ②：纯英文推理 */
    const en = [
      "The user reports that the thinking-translation feature shows a quality check failure.",
      "I need to look at renderer/app-assist.js around dshTranslateThinking and check how",
      "dshXlateLooksTranslated decides whether the output is a translation.",
    ].join("\n");
    const enZh =
      "用户反馈思考翻译功能出现质量校验失败，需要查看 renderer/app-assist.js 中 dshTranslateThinking 附近的代码，" +
      "确认 dshXlateLooksTranslated 如何判断输出是否为译文。";

    ok(looks(mixed, mixedOut) === false, "混合中英思考被原样复述 ⇒ 判死（旧口径「见中文就放行」会把它当译文）");
    ok(echoes(mixed, mixedOut) === true, "同文判据命中（字符级重合度口径，与原文语言无关）");
    ok(looks(mixed, mixedZh) === true, "混合中英思考的真译文 ⇒ 通过（不误杀）");
    ok(looks(en, en) === false, "纯英文原文被原样复述 ⇒ 判死");
    ok(looks(en, enZh) === true, "纯英文原文的真译文 ⇒ 通过");
    ok(
      looks(en, "用户反馈翻译功能报错。\n```js\nfunction dshXlateLooksTranslated(src, out) { return true; }\n```\n路径 E:\\dev\\tools\\pipeline-console\\renderer\\app-assist.js 第 5415 行是 dshTranslateThinking。") === true,
      "真译文但正文带大段代码 / 路径 ⇒ 通过（语言占比只在剔掉代码与路径后的可读正文上算）",
    );
    ok(looks(en, "以下是这段思考的中文翻译：") === false, "只回「以下是……翻译：」的元话术 ⇒ 判死");
    ok(looks("我需要检查一下这个函数的行为，然后修掉这个 bug。", "我需要检查一下这个函数的行为，然后修掉这个 bug。") === false, "中文原文被原样吐回（漏翻）⇒ 判死");
    ok(looks("我需要检查一下这个函数的行为，然后修掉这个 bug。", "I need to check the behavior of this function and fix the bug.") === true, "中文原文 → 地道英文译文 ⇒ 通过");
    ok(looks("", "") === false, "空输出 ⇒ 判死（不给空译文落缓存）");
    ok(
      ASSIST.indexOf("function dshXlateEchoes(") > 0 &&
        ASSIST.indexOf("hit / gb.size >= 0.8") > 0 &&
        /if \(dshXlateEchoes\(src, text\)\) return false;/.test(ASSIST),
      "同文判据在语言占比判据**之前**（dshXlateLooksTranslated 第一刀就是 dshXlateEchoes）",
    );
  }

  /* ═══════════════════ [B] 候选链真跑：第 2 档必须换一只真模型（换路由） ═══════════════════ */
  section("[B] 候选链真跑：同一只模型不再连发两次，第 2 档换到别家模型");
  {
    const sb = {
      console,
      agentRouteOptions: () => ["deepseek-official", "mtnode_p1", "mtnode_nokey"],
      providerForAgentRoute: (r) =>
        r === "mtnode_nokey" ? { apiKey: "" } : r === "mtnode_p1" ? { apiKey: "sk-p1" } : { apiKey: "sk-ds" },
      agentModelsForRoute: (r) =>
        r === "mtnode_p1" ? ["qwen3.7-max", "qwen3.8-flash"] : ["deepseek-v4-flash"],
      preferredAgentModelForRoute: (r) => (r === "deepseek-official" ? "deepseek-v4-flash" : "qwen3.7-max"),
    };
    vm.createContext(sb);
    vm.runInContext(
      [
        fnBody(ASSIST, "dshXlateRankModels"),
        fnBody(ASSIST, "dshXlateAltCandidates"),
        fnBody(ASSIST, "dshTranslateCandidates"),
      ].join("\n"),
      sb,
      { filename: "xlate-cands.js" },
    );
    const cands = (route, model) =>
      vm.runInContext(
        "dshTranslateCandidates(" + JSON.stringify(route) + "," + JSON.stringify(model) + ")",
        sb,
      );
    /* 现场配置：会话自己 = deepseek-official · deepseek-v4-flash（该家只有这一只）、
       全局助手 = mtnode_qwen-token-plan-cn · deepseek-v4.1-flash（这里用 mtnode_p1 代） */
    const list = cands("deepseek-official", "deepseek-v4-flash");
    ok(list.length >= 3, "候选链至少 3 档（实测 " + list.length + " 档：" + list.map((c) => c.route + "/" + c.model).join(" → ") + "）");
    ok(
      list[0].route === "deepseek-official" && list[0].model === "deepseek-v4-flash",
      "第 1 档 = 该会话自己的模型（不跳档）",
    );
    ok(
      list[1].route === "mtnode_p1" && list[1].model === "qwen3.8-flash",
      "第 2 档 = 别家模型（flash 档优先，实测 " + list[1].route + "/" + list[1].model + "）",
    );
    const modelsAtRoute = (r, m) => list.filter((c) => c.route === r && c.model === m).length;
    ok(
      modelsAtRoute("deepseek-official", "deepseek-v4-flash") <= 2 &&
        list.length === new Set(list.map((c) => c.route + "\u0000" + c.model)).size,
      "同一只模型最多两档（常规 + 强化提示词），且候选链无 (路由, 模型) 重复档（实测 " +
        list.length + " 档，去重后 " + new Set(list.map((c) => c.route + "\u0000" + c.model)).size + " 档）",
    );
    ok(
      list.every((c) => String(c.route || "").length > 0),
      "每档都带自己的路由（调用方按它取服务商，换家后不会拿着 A 家的 Key 发 B 家的模型）",
    );
    ok(
      !list.some((c) => c.route === "mtnode_nokey"),
      "没有 API Key 的路由不进候选链（不白发一次必然 401 的请求）",
    );
    ok(
      ASSIST.indexOf("dshTranslateCandidates(pick.route, pick.model, scopeId)") > 0 &&
        ASSIST.indexOf("cands = dshTranslateCandidates(np.route, np.model, scopeId)") > 0,
      "两处调用都带上 scope（403 换家后候选链按同一 scope 重算）",
    );
    ok(
      ASSIST.indexOf("cRoute === String(pick.route || \"\") ? pick.prov : dshTranslateProvider(cRoute)") > 0,
      "spec.provider 随候选路由切换（同路由仍用最初那份含 Key 校验的服务商对象）",
    );
    ok(
      ASSIST.indexOf("模型没有给出译文，以下是它本次返回的内容（点「重试翻译」会换一只模型再试）") > 0 &&
        ASSIST.indexOf("it.raw = lastOut;") > 0 &&
        ASSIST.indexOf("dsh-xlate-raw") > 0,
      "失败态保留「模型本次返回的内容」并在译文框里展示（用户能自查，不靠猜）",
    );
    ok(
      ASSIST.indexOf('"｜模型仍返回原文，已重试 " + Math.max(0, tried - 1) + " 次"') > 0,
      "「已重试 N 次」按真正发出去的次数算（不再拿候选链长度冒充重试次数）",
    );
  }

  /* ═══════════════════ [C] 提示词：system + user 分离（不再把指令与思考拼成一条） ═══════════════════ */
  section("[C] 提示词 system + user 分离：整段思考单独一条 user 消息");
  ok(
    /chatMessages:\s*\[\s*\n\s*\{ role: "system", content: sysMsg \},\s*\n\s*\{ role: "user", content: body \},/.test(
      ASSIST,
    ) && ASSIST.indexOf("prompt: body,") > 0,
    "spec 带 chatMessages（system=翻译卡口 / user=思考正文），prompt 仍是正文",
  );
  ok(
    ASSIST.indexOf("【思考内容】") < 0,
    "旧的「指令 + 【思考内容】 + 正文」拼一条 user 的写法已撤（app-assist.js 里不再有该标记）",
  );
  ok(
    ASSIST.indexOf("你是翻译引擎") > 0 &&
      ASSIST.indexOf("never repeat or quote the source") > 0,
    "常规 / 强化两套卡口都在（中文常规、英文强化）",
  );

  /* ═══════════════════ [D] 词条与样式 ═══════════════════ */
  section("[D] 新词条中英成对 + 失败态样式");
  const newKeys = ["模型没有给出译文，以下是它本次返回的内容（点「重试翻译」会换一只模型再试）"];
  for (const k of newKeys) {
    ok(I18N_SRC.indexOf('"' + k + '"') >= 0, "i18n 有词条：" + k.slice(0, 20));
    I18n.setLocale("en");
    const en = I18n.t(k);
    ok(en && en !== k && /^[\x20-\x7e…⚠·（）()「」]*$/.test(en), "英文界面已译：" + en.slice(0, 60));
    I18n.setLocale("zh");
  }
  ok(
    DSS.indexOf(".dsh-xlate-why") > 0 && DSS.indexOf(".dsh-xlate-raw") > 0,
    "dsh.css 有失败态说明 / 原始返回的样式（灰调降饱和，与青调译文一眼可分）",
  );

  console.log(
    "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-think-xlate-quality)",
  );
  if (fails) MERGED_FAILED = true;

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-think-xlate-quality.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-think-xlate-quality.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-think-merge.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-think-merge.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
  const show = (v) => JSON.stringify(v);
  const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
  const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
  const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);

  /* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
  function fnBody(src, name) {
    const pats = [
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
      new RegExp("\\nconst " + name + "\\s*=", "m"),
      new RegExp("\\nvar " + name + "\\s*=", "m"),
    ];
    let at = -1;
    for (const p of pats) {
      const m = src.match(p);
      if (m) {
        at = m.index + 1;
        break;
      }
    }
    if (at < 0) throw new Error("找不到函数/常量：" + name);
    const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
    if (isFn) {
      const i = src.indexOf("{", at);
      if (i < 0) throw new Error("找不到函数体：" + name);
      let depth = 0;
      let inStr = null;
      for (let j = i; j < src.length; j++) {
        const c = src[j];
        const p = src[j - 1];
        if (inStr) {
          if (c === inStr && p !== "\\") inStr = null;
          continue;
        }
        if (c === "/" && src[j + 1] === "/") {
          j = src.indexOf("\n", j) - 1;
          continue;
        }
        if (c === "/" && src[j + 1] === "*") {
          j = src.indexOf("*/", j) + 1;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          inStr = c;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (!depth) return src.slice(at, j + 1);
        }
      }
      throw new Error("函数体不完整：" + name);
    }
    const iBrace = src.indexOf("{", at);
    const iBracket = src.indexOf("[", at);
    const start =
      iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
    if (start < 0) throw new Error("找不到常量体：" + name);
    let depth2 = 0;
    for (let j = start; j < src.length; j++) {
      const c = src[j];
      if (c === "{" || c === "[") depth2++;
      else if (c === "}" || c === "]") {
        depth2--;
        if (!depth2) return src.slice(at, j + 1) + ";";
      }
    }
    throw new Error("常量体不完整：" + name);
  }
  /* 单行常量（数字 / 字符串，fnBody 的括号配平对它们会越界） */
  function constLine(src, name) {
    const re = new RegExp("\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*", "m");
    const m = src.match(re);
    if (!m) throw new Error("找不到单行常量：" + name);
    return m[0].replace(/^\n/, "") + "\n";
  }
  const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

  const dbSrc = read("renderer/app-db.js");

  /* =====================================================================
   * [A] 抽真实实现（traceRunKey / traceNum / traceReset / traceOf / tracePush /
   *     traceText / traceThinkDisplay / stripToolLines / joinThinkText /
   *     traceThinkCloseIfBig / traceCloseThink）
   * ===================================================================== */
  const S = {};
  const sandbox = { S, console };
  vm.createContext(sandbox);
  vm.runInContext(
    constLine(dbSrc, "THINK_TINY_CHARS") +
      "\n" +
      extract(dbSrc, [
        "traceRunKey",
        "traceNum",
        "traceReset",
        "traceOf",
        "joinThinkText",
        "traceStreamKey",
        "traceToolSeq",
        "traceThinkOpenItem",
        "traceThinkEventSameStream",
        "traceThinkCloseIfBig",
        "traceCloseThink",
        "traceCloseSay",
        "tracePush",
        "traceText",
        "stripToolLines",
        "traceThinkDisplay",
      ]),
    sandbox,
    { filename: "think-merge-extract.js" },
  );
  function G(name) {
    return vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);
  }
  console.log("[A] app-db.js 思考碎片合并：真实实现抽取");
  const WANTED = [
    "THINK_TINY_CHARS",
    "traceRunKey",
    "traceNum",
    "traceReset",
    "traceOf",
    "joinThinkText",
    "traceStreamKey",
    "traceToolSeq",
    "traceThinkOpenItem",
    "traceThinkEventSameStream",
    "traceThinkCloseIfBig",
    "traceCloseThink",
    /* 正文段的收口出口（say-end / 换 turn / 换 step / 工具 / 报错都走它）：
       tracePush 依赖它，抽真实现时必须一并带上 */
    "traceCloseSay",
    "tracePush",
    "traceText",
    "traceThinkDisplay",
  ];
  const missing = WANTED.filter((n) => G(n) === null || G(n) === undefined);
  eqNum(missing.length, 0, "目标函数 / 常量全部抽到真实实现" + (missing.length ? "（缺 " + show(missing) + "）" : ""));
  eqNum(typeof G("tracePush"), "function", "tracePush 是真函数");
  eqNum(typeof G("joinThinkText"), "function", "joinThinkText 是真函数");
  eqNum(typeof G("traceThinkCloseIfBig"), "function", "traceThinkCloseIfBig 是真函数");
  const TINY = G("THINK_TINY_CHARS");
  ok(typeof TINY === "number" && TINY > 0, "THINK_TINY_CHARS 是正数（得到 " + show(TINY) + "）");
  has(dbSrc, "if (kind === \"think\") {", "合并闸只对 think 生效（源码原文）");
  has(dbSrc, "function traceThinkCloseIfBig(", "边界收口抽成 traceThinkCloseIfBig（源码原文）");
  has(
    dbSrc,
    "if (String(it.text || \"\").length < THINK_TINY_CHARS) return false;",
    "只有写够阈值的思考才在边界处收口（源码原文）",
  );
  has(dbSrc, "traceThinkCloseIfBig(tr);", "工具调用 / 换 step 处调用收口（源码原文）");
  has(dbSrc, "let it = traceThinkOpenItem(tr);", "只并进当前仍开放、且同一条流的思考段（源码原文）");
  has(
    dbSrc,
    "it.text = joinThinkText(it.text, body, sameStream);",
    "合并走 joinThinkText（源码原文）",
  );
  has(dbSrc, "(Number(it.toolSeq) || 0) === seq;", "同流判据 = 同一 step 且这条流自上次追加以来没插过工具（源码原文）");
  has(
    dbSrc,
    "if (traceThinkEventSameStream(tr, e, turn, step)) traceCloseThink(tr);",
    "只有同一条流的正文才收口思考（源码原文）",
  );
  has(
    dbSrc,
    "if (String(body).trim() && traceThinkEventSameStream(tr, e, turn, step))",
    "只有同一条流的非空白正文才收口思考（源码原文）",
  );
  has(dbSrc, "function traceStreamKey(", "流键抽成 traceStreamKey（源码原文）");
  has(dbSrc, "function traceThinkEventSameStream(", "同流判定抽成 traceThinkEventSameStream（源码原文）");
  has(dbSrc, "return a + \"\\n\" + b;", "跨 step / 跨工具才插换行（源码原文）");
  has(dbSrc, "if (sameStream) return a + b;", "同一条思考流的增量原样相接、不插任何字符（源码原文）");
  has(dbSrc, "if (/\\s$/.test(a) || /^\\s/.test(b)) return a + b;", "接缝已有空白则不重复插（源码原文）");

  /* 真实 tracePush 驱动：think 段 = items 里 k==='think' 的条目 */
  function thinkSegs(runKey) {
    const tr = S.runTrace[G("traceRunKey")(runKey)];
    return (tr && tr.items ? tr.items : []).filter((it) => it.k === "think");
  }
  const thinkPush = (runKey, txt, ev) => G("tracePush")(runKey, "think", txt, ev || {});

  /* ===== [1] 40 个碎片 → 段数下降、封闭段都够阈值、全文有序不丢 ===== */
  console.log(
    "\n[1] 连续 40 个 15–60 字、step 递增的碎片 → 段数远小于 40，封闭段都够阈值，全文按序不丢",
  );
  const RK1 = "merge40";
  G("traceReset")(RK1);
  const frags = [];
  for (let i = 0; i < 40; i++) {
    /* 每片 15–60 字（都 < 阈值），带序号便于校验顺序与完整性 */
    const len = 15 + ((i * 7) % 46);
    let s = "片段" + i + "-";
    while (s.length < len) s += "字";
    frags.push(s.slice(0, len));
    thinkPush(RK1, frags[i], { turn: 1, step: i + 1 });
  }
  const segs1 = thinkSegs(RK1);
  ok(segs1.length < 40, "40 个碎片合并后段数显著下降（得到 " + segs1.length + " 段）");
  ok(segs1.length >= 2, "不是全并成一坨（得到 " + segs1.length + " 段）");
  ok(
    segs1.slice(0, -1).every((s) => s.text.length >= TINY),
    "除最后一段（仍开放）外每段都写够阈值才收口（没有「思考 · 8 字」的小块）",
  );
  const joined1 = G("traceThinkDisplay")(RK1, "");
  const stripped1 = joined1.replace(/\s+/g, "");
  ok(
    frags.every((f, i) => stripped1.indexOf(f.replace(/\s+/g, "")) >= 0),
    "全部碎片字符都出现在拼接全文里（不丢字）",
  );
  let pos = -1;
  let ordered = true;
  for (const f of frags) {
    const at = stripped1.indexOf(f.replace(/\s+/g, ""), pos + 1);
    if (at < 0) {
      ordered = false;
      break;
    }
    pos = at;
  }
  ok(ordered, "碎片在拼接全文里保持原顺序（不乱序）");
  eqNum(
    stripped1,
    frags.map((f) => f.replace(/\s+/g, "")).join(""),
    "拼接全文 = 各碎片按序相接（无增删字）",
  );
  ok(joined1.indexOf("片段0-") < joined1.indexOf("片段39-"), "首片在前、末片在后");
  ok(
    segs1.every((s) => !/\s{2,}/.test(s.text)),
    "每段内部没有连续空白（双空格 / 空行）",
  );
  eqNum(segs1.map((s) => s.text).join("\n\n"), joined1, "各段文本按序拼起来 = traceThinkDisplay");

  /* ===================== [2] 够长才在边界处收口（保留交替） ===================== */
  console.log("\n[2] ≥阈值 的思考在边界处收口另起；小块继续并入当前开放段");
  const RK2 = "bigone";
  G("traceReset")(RK2);
  const bigA = "A".repeat(TINY + 20);
  const bigB = "B".repeat(TINY + 20);
  thinkPush(RK2, bigA, { turn: 1, step: 1 });
  thinkPush(RK2, bigB, { turn: 1, step: 2 });
  const segs2 = thinkSegs(RK2);
  eqNum(segs2.length, 2, "两段都 ≥阈值 → 换 step 即收口，各起一段（不被并成一段）");
  eqNum(segs2[0].text, bigA, "第一段就是第一块");
  eqNum(segs2[1].text, bigB, "第二段是第二块（未被合并）");
  eqNum(G("traceThinkDisplay")(RK2, ""), bigA + "\n\n" + bigB, "traceText 段间空行分隔，两块都在");

  /* 长块收口后跟的小块：另起一段（开放），下一块长思考再把它吸进来 */
  const RK2b = "bigmix";
  G("traceReset")(RK2b);
  thinkPush(RK2b, bigA, { turn: 1, step: 1 });
  thinkPush(RK2b, "小尾巴", { turn: 1, step: 2 });
  const segs2b = thinkSegs(RK2b);
  eqNum(segs2b.length, 2, "长块已在边界收口 → 小块另起一段（只此一段短，不会成排）");
  eqNum(segs2b[0].text, bigA, "长块原样保留");
  eqNum(segs2b[1].text, "小尾巴", "小块单独一段");
  thinkPush(RK2b, bigB, { turn: 1, step: 3 });
  const segs2c = thinkSegs(RK2b);
  eqNum(segs2c.length, 2, "后续长块并进还没写够的那段（不新增小块）");
  eqNum(segs2c[1].text, "小尾巴\n" + bigB, "小块 + 长块在同一段里（换行分隔）");

  /* ============ [3] 碎片跨 tool 合并；够长的思考在工具处收口（保留穿插） ============ */
  console.log("\n[3] 过短思考跨 tool 段并回同一段；够长思考在工具处收口、保留 think→tool→think");
  const RK3 = "toolcut";
  G("traceReset")(RK3);
  thinkPush(RK3, "工具前的短思考", { turn: 1, step: 1 });
  G("tracePush")(RK3, "tool", "", { turn: 1, step: 1, callId: "call-1" });
  thinkPush(RK3, "工具后的短思考", { turn: 1, step: 2 });
  const segs3 = thinkSegs(RK3);
  eqNum(segs3.length, 1, "跨 tool 段的过短思考并回同一段（不再散成多块）");
  eqNum(segs3[0].text, "工具前的短思考\n工具后的短思考", "两段思考在同一段里，顺序不变（跨 step 用换行）");
  const items3 = S.runTrace[G("traceRunKey")(RK3)].items;
  eqArr(
    items3.map((it) => it.k),
    ["think", "tool"],
    "时间线是 think → tool（不再为碎片重复新增 think 段）",
  );
  eqNum(items3[1].callId, "call-1", "工具段的 callId 原样保留");
  /* 两段都够长 → 工具前后各自成段，穿插工具调用的时间线保留 */
  const RK3d = "toollong";
  G("traceReset")(RK3d);
  thinkPush(RK3d, bigA, { turn: 1, step: 1 });
  G("tracePush")(RK3d, "tool", "", { turn: 1, step: 1, callId: "call-9" });
  thinkPush(RK3d, bigB, { turn: 1, step: 2 });
  eqNum(thinkSegs(RK3d).length, 2, "两段都 ≥阈值 → 工具后仍另起一段");
  const items3d = S.runTrace[G("traceRunKey")(RK3d)].items;
  eqArr(
    items3d.map((it) => it.k),
    ["think", "tool", "think"],
    "够长的思考与工具调用交替（允许穿插，不再粘成一坨）",
  );
  eqNum(items3d[0].text, bigA, "工具前那段思考保持独立");
  eqNum(items3d[2].text, bigB, "工具后那段思考另起一段");
  /* 换 turn → 收口另起，不并进上一轮 */
  const RK3e = "turncut";
  G("traceReset")(RK3e);
  thinkPush(RK3e, "第一轮短思考", { turn: 1, step: 1 });
  thinkPush(RK3e, "第二轮短思考", { turn: 2, step: 1 });
  eqNum(thinkSegs(RK3e).length, 2, "换 turn → 思考收口，另起一段");
  /* say / err 段同样收口：中间夹了 say / err，思考也不得并回工具前那段 */
  const RK3b = "saycut";
  G("traceReset")(RK3b);
  thinkPush(RK3b, "第一小段", { turn: 1, step: 1 });
  G("tracePush")(RK3b, "say", "正文", { turn: 1, step: 1 });
  thinkPush(RK3b, "第二小段", { turn: 1, step: 2 });
  eqNum(thinkSegs(RK3b).length, 2, "中间夹 say → 两段 think 不合并");
  const RK3c = "errcut";
  G("traceReset")(RK3c);
  thinkPush(RK3c, "前小段", { turn: 1, step: 1 });
  G("tracePush")(RK3c, "err", "出错了", { turn: 1, step: 1 });
  thinkPush(RK3c, "后小段", { turn: 1, step: 2 });
  eqNum(thinkSegs(RK3c).length, 2, "中间夹 err → 两段 think 不合并");
  /* 纯空白 say（适配器在思考之间夹的换行增量）不算「开口」，不阻断合并 */
  const RK3f = "blanksay";
  G("traceReset")(RK3f);
  thinkPush(RK3f, "前半小段", { turn: 1, step: 1 });
  G("tracePush")(RK3f, "say", "\n", { turn: 1, step: 1 });
  thinkPush(RK3f, "后半小段", { turn: 1, step: 2 });
  const segs3f = thinkSegs(RK3f);
  eqNum(segs3f.length, 1, "中间夹纯空白 say → 两段 think 仍合并");
  eqNum(segs3f[0].text, "前半小段\n后半小段", "纯空白 say 不打断、不丢字");

  /* ===================== [4] 接缝不插多余字符 ===================== */
  console.log("\n[4] 同一条思考流原样相接（不插空格）；跨段才插换行");
  const jt = G("joinThinkText");
  eqNum(jt("a", "b", true), "ab", "同一 turn/step 的流式增量：原样相接（一个字符都不插）");
  eqNum(jt("a", "b", false), "a\nb", "跨 turn/step / 跨工具：插一个换行");
  eqNum(jt("a ", "b", true), "a b", "同流且接缝左侧已有空格 → 原样相接");
  eqNum(jt("a", " b", true), "a b", "同流且接缝右侧已有空格 → 原样相接");
  eqNum(jt("a\n", "b", false), "a\nb", "跨段且接缝左侧已有换行 → 原样相接");
  eqNum(jt("a", "\nb", false), "a\nb", "跨段且接缝右侧已有换行 → 原样相接");
  eqNum(jt("a ", " b", true), "a  b", "两侧都有空白 → 保留既有空白（不额外加）");
  eqNum(jt("", "b", true), "b", "空前缀 → 直接取后段");
  eqNum(jt("a", "", true), "a", "空后段 → 保留前段");
  /* 真实 tracePush 路径：碎片自带首尾空白时接缝不重复插 */
  const RK4 = "seam";
  G("traceReset")(RK4);
  thinkPush(RK4, "前半段 ", { turn: 1, step: 1 });
  thinkPush(RK4, "后半段", { turn: 1, step: 2 });
  const segs4 = thinkSegs(RK4);
  eqNum(segs4.length, 1, "自带尾部空白的碎片仍并入同一段");
  eqNum(segs4[0].text, "前半段 后半段", "接缝只有一个空格（不因合并多插一个）");
  ok(!/\s{2,}/.test(segs4[0].text), "真实路径也不产生双空格");
  /* 跨 step 且两侧无空白 → 一个换行 */
  const RK4b = "seamnl";
  G("traceReset")(RK4b);
  thinkPush(RK4b, "上一段", { turn: 1, step: 1 });
  thinkPush(RK4b, "下一段", { turn: 1, step: 2 });
  eqNum(thinkSegs(RK4b)[0].text, "上一段\n下一段", "跨 step 接缝用换行拼接");
  /* 同一 step 内的逐块增量：原样相接（「字符间被插入空格」的直接回归） */
  const RK4c = "seamsp";
  G("traceReset")(RK4c);
  thinkPush(RK4c, "同一", { turn: 1, step: 1 });
  thinkPush(RK4c, "步内", { turn: 1, step: 1 });
  thinkPush(RK4c, "的增量", { turn: 1, step: 1 });
  eqNum(thinkSegs(RK4c)[0].text, "同一步内的增量", "同一 step 内逐块增量原样相接（不插空格）");
  /* 同一 step 内插了工具调用 → 换行分隔，不把两段粘死 */
  const RK4d = "seamtool";
  G("traceReset")(RK4d);
  thinkPush(RK4d, "调工具前", { turn: 1, step: 1 });
  G("tracePush")(RK4d, "tool", "", { turn: 1, step: 1, callId: "t1" });
  thinkPush(RK4d, "调工具后", { turn: 1, step: 1 });
  eqNum(
    thinkSegs(RK4d)[0].text,
    "调工具前\n调工具后",
    "同一 step 里插了工具 → 换行分隔（不误当同一条流粘死）",
  );

  /* ===================== [5] traceThinkDisplay 完整文本 ===================== */
  console.log("\n[5] traceThinkDisplay 返回完整文本");
  const RK5 = "display";
  G("traceReset")(RK5);
  thinkPush(RK5, "第一段思考", { turn: 1, step: 1 });
  thinkPush(RK5, "第二段思考", { turn: 1, step: 2 });
  const disp = G("traceThinkDisplay")(RK5, "回退文本");
  ok(disp.indexOf("第一段思考") >= 0 && disp.indexOf("第二段思考") >= 0, "两段内容都在返回文本里");
  eqNum(G("traceText")(RK5, "think"), disp, "traceThinkDisplay = traceText('think')");
  eqNum(G("traceThinkDisplay")("no-such-run", "回退文本"), "回退文本", "无轨迹时回退到调用方给的旧缓冲");
  /* 合并只影响段数，say / err 口径不动 */
  const RK5b = "sayintact";
  G("traceReset")(RK5b);
  thinkPush(RK5b, "思", { turn: 1, step: 1 });
  G("tracePush")(RK5b, "say", "正文一", { turn: 1, step: 1 });
  G("tracePush")(RK5b, "say", "正文二", { turn: 1, step: 1 });
  eqNum(G("traceText")(RK5b, "say"), "正文一正文二", "say 续写口径未变（同段直接相接）");

  /* ============ [6] 收尾落盘只夹单段字数：think / say / err / tool 段全保留、顺序不变 ============ */
  console.log("\n[6] agentSegsForDisk 只夹单段字数：全部段保留，思考与工具都留在时间线原位");
  const asSrc = read("renderer/app-assist.js");
  has(asSrc, "function agentSegsForDisk(segList) {", "段数取舍收口在 agentSegsForDisk（源码原文）");
  ok(
    asSrc.indexOf("AGENT_SEG_TOOL_MAX") < 0 && asSrc.indexOf("agentSegsTrimCap") < 0,
    "工具段条数上限口径已删净（段一裁，工具 chip 就掉到消息尾部压住最终回复）",
  );
  const sb2 = { console };
  vm.createContext(sb2);
  vm.runInContext(
    constLine(asSrc, "AGENT_SEG_TEXT_MAX") +
      "\n" +
      extract(asSrc, ["agentSegsForDisk", "dshMsgSegsViewable"]),
    sb2,
    { filename: "segs-for-disk-extract.js" },
  );
  const G2 = (n) =>
    vm.runInContext("(typeof " + n + " === 'undefined' ? null : " + n + ")", sb2);
  /* 形状：1 段思考 + 45 个工具段 + 末尾 1 段正文 → 一条不丢、顺序不变 */
  const many = [{ k: "think", text: "一整轮的思考", step: 1 }];
  for (let i = 1; i <= 45; i++)
    many.push({ k: "tool", text: "", step: i, callId: "c" + i });
  many.push({ k: "say", text: "最终回答", step: 46 });
  const trimmed = G2("agentSegsForDisk")(many);
  eqNum(trimmed.length, many.length, "46 条段一条不丢（旧口径会把 45 个工具段夹到 40）");
  eqNum(
    trimmed.filter((s) => s.k === "tool").length,
    45,
    "45 个工具段全部保留（每颗 chip 都配得上自己的时间线位置）",
  );
  ok(
    trimmed.some((s) => s.k === "think"),
    "思考段没有被上限顶掉（旧口径「只留最后 N 段」会先丢它 → 一轮跑完思考消失）",
  );
  eqNum(trimmed[0].k, "think", "思考段仍在时间线最前，顺序不变");
  eqNum(
    trimmed[trimmed.length - 1].text,
    "最终回答",
    "正文段照旧在整条消息末尾（AI 最终回复仍是最后那条内容）",
  );
  /* 旧口径的现场（就是本 bug）：长任务常有上百个 think / tool 段 —— 段一被裁，
     工具 chip 就只能从消息尾部冒出来（压在最终回复下方）；现在只夹单段字数。 */
  const real = [];
  for (let i = 1; i <= 60; i++) {
    real.push({ k: "think", text: "第 " + i + " 步思考（≥阈值的一段）", step: i });
    real.push({ k: "tool", text: "", step: i, callId: "call-" + i });
  }
  real.push({ k: "say", text: "最终回答", step: 61 });
  const keptReal = G2("agentSegsForDisk")(real);
  eqNum(
    keptReal.filter((s) => s.k === "think").length,
    60,
    "60 段思考全保留（不再被段数上限顶掉、也不截断）",
  );
  eqNum(
    keptReal.filter((s) => s.k === "say").length,
    1,
    "正文段保留（丢了它整条消息就退回旧渲染 → 思考并成一块）",
  );
  eqNum(
    keptReal.filter((s) => s.k === "tool").length,
    60,
    "60 个工具段全保留（不再被夹到 40 → 没有 chip 掉到消息尾部）",
  );
  eqNum(
    keptReal.map((s) => s.k).join(","),
    real.map((s) => s.k).join(","),
    "整条时间线的段序与运算前逐位一致（不重排、不丢段）",
  );
  const msgReal = { role: "assistant", content: "最终回答", segments: keptReal };
  ok(
    G2("dshMsgSegsViewable")(msgReal),
    "落盘后仍按段渲染 → 一轮跑完思考留在原位（本 bug 的直接回归）",
  );
  /* 条数不设限；单段字数上限只夹 say / err（think 全保留） */
  const manySays = [];
  for (let i = 0; i < 45; i++) manySays.push({ k: "say", text: "s" + i, step: i });
  const trimmed2 = G2("agentSegsForDisk")(manySays);
  eqNum(trimmed2.length, 45, "正文段不受条数约束（全保留）");
  eqNum(trimmed2[trimmed2.length - 1].text, "s44", "最后一段正文照旧在末尾");
  /* 可还原性不受影响：裁剪后正文拼接仍等于 content 时历史渲染照样走分段 */
  const msg6 = { role: "assistant", content: "最终回答", segments: trimmed };
  ok(G2("dshMsgSegsViewable")(msg6), "裁剪后仍可分段渲染（思考块随之显示出来）");
  /* 思考段落盘不截断（需求：一轮结束后不要自动隐藏 / 删除思考） */
  const SEG_MAX = G2("AGENT_SEG_TEXT_MAX");
  const bigThink = { k: "think", text: "思".repeat(SEG_MAX + 500), step: 1 };
  const keptBig = G2("agentSegsForDisk")([bigThink, { k: "say", text: "正文", step: 2 }]);
  const keptThink = keptBig.find((s) => s.k === "think");
  eqNum(keptThink.text.length, SEG_MAX + 500, "思考段不按 say 的上限截断（正文才截）");
  has(dbSrc, "if (it.k !== \"think\") {", "traceSegmentsOf 只对 say / err 设预算（源码原文）");
  has(asSrc, "if (s.k !== \"think\" && text.length > AGENT_SEG_TEXT_MAX)", "agentSegsForDisk 不裁思考（源码原文）");
  has(asSrc, "function agentCarryThinkOpenState(", "收尾把展开的思考状态带到历史消息（源码原文）");
  has(asSrc, "agentCarryThinkOpenState(st, msg, rk);", "收尾消息落盘后调用状态搬运（源码原文）");

  /* ===== [7] 并发流交错：别的流的正文 / 工具不切碎这条流的思考 ===== */
  console.log("\n[7] 并发流（子代理 / 续跑轮）交错到达：另一条流的正文不再把思考切碎");
  const RK7 = "interleave";
  G("traceReset")(RK7);
  /* 真实形状（见本机会话存档）：主 agent 在 step 6 逐步思考，子代理正文在 step 19 穿插 */
  const frag7 = [];
  for (let i = 0; i < 20; i++) {
    frag7.push("思" + i + "考");
    thinkPush(RK7, "思" + i + "考", { turn: 1, step: 6 });
    G("tracePush")(RK7, "say", "子代理正文" + i, { turn: 1, step: 19 });
  }
  const segs7 = thinkSegs(RK7);
  eqNum(segs7.length, 1, "另一条流的正文穿插 20 次 → 思考仍是一段（旧口径每次 say 都切一段）");
  eqNum(segs7[0].text, frag7.join(""), "同一条流的碎片原样相接（不插空格、不插换行）");
  ok(
    segs7[0].open === true && segs7[0].text.length < 2 * TINY,
    "整段保持开放、碎片继续并进来（没有按每条外流正文切成 20 段）",
  );
  /* 带会话 id：另一条流哪怕同一步说话也不收口本流思考段 */
  const RK7b = "sidsplit";
  G("traceReset")(RK7b);
  thinkPush(RK7b, "主代理思考一", { turn: 1, step: 1, sid: "A" });
  G("tracePush")(RK7b, "say", "子代理正文", { turn: 1, step: 1, sid: "B" });
  thinkPush(RK7b, "主代理思考二", { turn: 1, step: 1, sid: "A" });
  eqNum(thinkSegs(RK7b).length, 1, "带会话 id：另一条流同一步的正文不切碎本流思考");
  eqNum(thinkSegs(RK7b)[0].text, "主代理思考一主代理思考二", "同一条流的增量原样相接");
  /* 另一条流的工具调用同样不收口；本流自己的才在够长时收口 */
  const RK7c = "sidtool";
  G("traceReset")(RK7c);
  thinkPush(RK7c, "A".repeat(TINY + 5), { turn: 1, step: 1, sid: "A" });
  G("tracePush")(RK7c, "tool", "", { turn: 1, step: 1, callId: "tB", sid: "B" });
  ok(thinkSegs(RK7c)[0].open === true, "另一条流的工具调用不收口本流思考段");
  G("tracePush")(RK7c, "tool", "", { turn: 1, step: 1, callId: "tA", sid: "A" });
  ok(thinkSegs(RK7c)[0].open === false, "本流自己的工具调用才在够长时收口（保留交替）");
  thinkPush(RK7c, "B".repeat(10), { turn: 1, step: 2, sid: "A" });
  eqNum(thinkSegs(RK7c).length, 2, "收口后本流的下一段思考另起一块");
  /* 交错场景里本流换 step：够长才收口，保证 think→tool→think 的交替仍在 */
  const RK7d = "interstepp";
  G("traceReset")(RK7d);
  thinkPush(RK7d, "A".repeat(TINY + 5), { turn: 1, step: 6 });
  G("tracePush")(RK7d, "say", "另一条流的正文", { turn: 1, step: 19 });
  thinkPush(RK7d, "A".repeat(TINY + 5), { turn: 1, step: 7 });
  eqNum(thinkSegs(RK7d).length, 2, "同一流换 step 且已够长 → 收口另起（穿插交替保留）");
  /* 两条流都在思考且交错到达：宁可并进同一段，也绝不每块断一段 */
  const RK7f = "sidboth";
  G("traceReset")(RK7f);
  thinkPush(RK7f, "主一", { turn: 1, step: 1, sid: "A" });
  thinkPush(RK7f, "子一", { turn: 1, step: 3, sid: "B" });
  thinkPush(RK7f, "主二", { turn: 1, step: 1, sid: "A" });
  thinkPush(RK7f, "子二", { turn: 1, step: 3, sid: "B" });
  const segs7f = thinkSegs(RK7f);
  eqNum(segs7f.length, 1, "两条流交错思考 → 仍是一段（老网关分不清流时也不许碎成一块块）");
  ok(
    segs7f[0].text.indexOf("主一") >= 0 &&
      segs7f[0].text.indexOf("主二") >= 0 &&
      segs7f[0].text.indexOf("子一") >= 0 &&
      segs7f[0].text.indexOf("子二") >= 0,
    "四条碎片都在同一段里，顺序不乱、不丢字",
  );
  /* 无会话 id 时退化成「按步分流」：同一步的正文仍算同一条流，正常收口 */
  const RK7e = "nosid";
  G("traceReset")(RK7e);
  thinkPush(RK7e, "思考一", { turn: 1, step: 1 });
  G("tracePush")(RK7e, "say", "正文", { turn: 1, step: 1 });
  thinkPush(RK7e, "思考二", { turn: 1, step: 2 });
  eqNum(thinkSegs(RK7e).length, 2, "无会话 id：同一步的正文照常收口（普通单流行为不变）");

  /* ---------- 收尾 ---------- */
  console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"));

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-think-merge.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-think-merge.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-think-visible.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-think-visible.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

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
  const show = (v) => JSON.stringify(v);
  const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
  const eqStr = (a, b, msg) => ok(String(a) === String(b), msg + "（得到 " + show(a) + "）");
  const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
  const hasnt = (src, needle, msg) => ok(src.indexOf(needle) < 0, msg);
  const abs = (rel) => path.join(__dirname, "..", ...rel.split("/"));
  const read = (rel) => fs.readFileSync(abs(rel), "utf8");
  function section(name) {
    console.log("\n" + name);
  }

  /* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
  function fnBody(src, name) {
    const pats = [
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
      new RegExp("\\nconst " + name + "\\s*=", "m"),
      new RegExp("\\nvar " + name + "\\s*=", "m"),
    ];
    let at = -1;
    for (const p of pats) {
      const m = src.match(p);
      if (m) {
        at = m.index + 1;
        break;
      }
    }
    if (at < 0) throw new Error("找不到函数/常量：" + name);
    const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
    const i = src.indexOf("{", at);
    if (i < 0) throw new Error("找不到函数体：" + name);
    let depth = 0;
    let inStr = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr) {
        if (c === inStr && p !== "\\") inStr = null;
        continue;
      }
      if (c === "/" && src[j + 1] === "/") {
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数体不完整：" + name);
  }
  const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

  const DB = read("renderer/app-db.js");
  const ASSIST = read("renderer/app-assist.js");
  const BOOT = read("renderer/app-boot.js");
  const HTML = read("renderer/index.html");
  const I18N_SRC = read("renderer/i18n.js");
  const I18n = require(abs("renderer/i18n.js"));

  /* =====================================================================
   * [1] 续跑起步「切开」思考段（真实现：app-db.js 的轨迹模块）
   * ===================================================================== */
  section("[1] 续跑起步切开思考段：思考内容一段都不删（真实现）");
  ok(DB.indexOf("function traceSplitThink(") > 0, "app-db.js 有 traceSplitThink（切开，不删）");
  hasnt(DB, "traceDropThink", "老口径 traceDropThink（整段摘掉思考）已从真源消失");
  has(
    DB,
    "else if (opts.resumeSession) traceSplitThink(runKey);",
    "dshRunOnce 在续跑起步（resumeSession）时调用它（源码原文）",
  );
  {
    const S = {};
    const sandbox = { S, console };
    vm.createContext(sandbox);
    vm.runInContext(
      "const THINK_TINY_CHARS = 64;\n" +
        extract(DB, [
          "traceRunKey",
          "traceNum",
          "traceReset",
          "traceOf",
          "joinThinkText",
          "traceStreamKey",
          "traceToolSeq",
          "traceThinkOpenItem",
          "traceThinkEventSameStream",
          "traceThinkCloseIfBig",
          "traceCloseThink",
          "traceCloseSay",
          "tracePush",
          "traceSplitThink",
          "traceText",
        ]),
      sandbox,
      { filename: "think-visible-extract.js" },
    );
    const G = (n) => vm.runInContext("(typeof " + n + ' === "undefined" ? null : ' + n + ")", sandbox);
    /* 失败轮：思考 → 工具 → 正文半截 → 错误 */
    G("traceReset")("k1");
    G("tracePush")("k1", "think", "失败轮的旧思考", { turn: 1, step: 1 });
    G("tracePush")("k1", "tool", "", { turn: 1, step: 1, callId: "c1" });
    G("tracePush")("k1", "say", "失败轮的半截正文", { turn: 1, step: 1 });
    G("tracePush")("k1", "err", "429 Too Many Requests", { turn: 1, step: 1 });
    const tr = G("traceSplitThink")("k1");
    eqStr(
      G("traceText")("k1", "think"),
      "失败轮的旧思考",
      "切开之后旧思考仍在轨迹里（旧口径这里会变成空串 = 思考被移除）",
    );
    eqNum(tr.items.filter((it) => it.k === "think" && it.open === true).length, 0, "旧思考段已收口（不再吃后续增量）");
    eqNum(tr._thinkIdx, -1, "开放思考段下标复位");
    eqStr(G("traceText")("k1", "say"), "失败轮的半截正文", "正文段一字不动（续写要保）");
    /* 续跑轮的新思考：另起一段，不并进旧段 */
    G("tracePush")("k1", "think", "续跑轮的新思考", { turn: 2, step: 1 });
    eqStr(
      G("traceText")("k1", "think"),
      "失败轮的旧思考\n\n续跑轮的新思考",
      "两段思考都在、段间空行分隔（新思考不并进旧段）",
    );
    eqNum(tr.items.filter((it) => it.k === "think").length, 2, "思考段 = 2（旧段 + 新段），不拼成一坨");
    /* 归档口径：段快照里 think 段整段照收（限长闸明确不裁 think） */
    {
      const segMax = (DB.match(/const TRACE_SEG_MAX_CHARS = (\d+)/) || [])[1];
      ok(!!segMax, "抽到真实的 TRACE_SEG_MAX_CHARS（段快照预算）");
      vm.runInContext(
        "const TRACE_SEG_MAX_CHARS = " + segMax + ";\n" + extract(DB, ["traceSegmentsOf"]),
        sandbox,
        { filename: "segs.js" },
      );
      const segs = G("traceSegmentsOf")("k1");
      const thinks = segs.filter((s) => s.k === "think").map((s) => s.text);
      eqNum(thinks.length, 2, "段快照里两段思考都在（归档不丢）");
      eqStr(thinks.join("|"), "失败轮的旧思考|续跑轮的新思考", "段快照文本按序完整");
    }
  }

  /* =====================================================================
   * [2] 续跑重发（retry resumed=true）不清思考槽
   * ===================================================================== */
  section("[2] 续跑重发的清残文口径：resumed 时思考槽保留（会话侧与节点侧对齐）");
  {
    const at = ASSIST.indexOf('if (type === "retry") {', ASSIST.indexOf('runKey: "agent:" + st.id'));
    const blk = ASSIST.slice(at, at + 900);
    ok(at > 0, "抽到会话侧 onEvent 的 retry 分支");
    ok(
      /if \(data && data\.resumed\)\s*\{\s*\n\s*if \(mine\) updateAgentLiveThink\(st\);\s*\n\s*return;\s*\n\s*\}/.test(
        blk,
      ),
      "resumed=true 时直接返回（正文 / 工具 / 用量 / 思考一律保留）",
    );
    ok(
      blk.indexOf('delete S.thinking["agent:" + st.id]') >
        blk.indexOf("if (data && data.resumed)"),
      "清思考槽只在整轮重发（resumed=false）分支里 —— 续跑不再清掉用户已看到的思考",
    );
    hasnt(
      blk.slice(0, blk.indexOf("if (data && data.resumed)")),
      "delete S.thinking",
      "resumed 分支之前没有任何「先清思考」的代码（否则又会白删一次）",
    );
    /* 节点侧一直是保留的：两处口径对齐（本来就是它做对了） */
    const dbRetry = DB.slice(DB.indexOf('if (type === "retry") {'), DB.indexOf('if (type === "retry") {') + 700);
    ok(
      /if \(data && data\.resumed\) return;/.test(dbRetry),
      "节点侧（app-db.js onDshNodeEvent）resumed 时什么都不清（会话侧现在与它一致）",
    );
  }

  /* =====================================================================
   * [3] 三条收尾路径都把思考归档（真实现 agentRoundMsgTail）
   * ===================================================================== */
  section("[3] 正常 / 终止 / 出错三条收尾路径共用一份「思考 + 段快照 + 工具」尾巴");
  has(ASSIST, "function agentRoundMsgTail(", "app-assist.js 有 agentRoundMsgTail（收尾消息公共尾巴）");
  {
    /* 真跑一次：轨迹里已有 think / say / err 段 → 尾巴必须挂上 reasoning 与 segments */
    const S = {
      thinking: { "agent:s1": ["残留内存缓冲（不该赢过轨迹）"] },
      runTrace: {},
    };
    const sb = {
      S,
      console,
      I18n: { t: (s) => String(s) },
      agentSegsForDisk: (list) => (Array.isArray(list) && list.length ? list : null),
    };
    vm.createContext(sb);
    const segMax3 = (DB.match(/const TRACE_SEG_MAX_CHARS = (\d+)/) || [])[1];
    vm.runInContext(
      "const THINK_TINY_CHARS = 64;\nconst TRACE_SEG_MAX_CHARS = " + segMax3 + ";\n" +
        extract(DB, [
          "traceRunKey",
          "traceNum",
          "traceReset",
          "traceOf",
          "joinThinkText",
          "traceStreamKey",
          "traceToolSeq",
          "traceThinkOpenItem",
          "traceThinkEventSameStream",
          "traceThinkCloseIfBig",
          "traceCloseThink",
          "traceCloseSay",
          "tracePush",
          "traceText",
          "stripToolLines",
          "traceThinkDisplay",
          "traceSegmentsOf",
        ]) +
        "\n" +
        extract(ASSIST, ["agentRoundMsgTail"]),
      sb,
      { filename: "round-tail.js" },
    );
    const RUN = (code) => vm.runInContext(code, sb);
    RUN('traceReset("agent:s1")');
    RUN('tracePush("agent:s1", "think", "终止前的思考", { turn: 1, step: 1 })');
    RUN('tracePush("agent:s1", "say", "半截正文", { turn: 1, step: 1 })');
    const msg = RUN('agentRoundMsgTail({ _liveTools: [{ callId: "c1", name: "read" }] }, { role: "assistant", content: "半截正文" }, "agent:s1")');
    eqStr(msg.reasoning, "终止前的思考", "收尾消息挂上思考（终止 / 出错路径过去这里是空的 = 思考被丢掉）");
    ok(Array.isArray(msg.segments) && msg.segments.length >= 2, "收尾消息挂上段快照（时间线可还原）");
    ok(Array.isArray(msg.tools) && msg.tools.length === 1, "收尾消息挂上本轮工具清单");
    /* 无思考的一轮：不写空 reasoning（不制造空折叠块） */
    RUN('traceReset("agent:s2")');
    RUN('tracePush("agent:s2", "say", "只有正文", { turn: 1, step: 1 })');
    const msg2 = RUN('agentRoundMsgTail(null, { role: "assistant", content: "只有正文" }, "agent:s2")');
    eqNum(msg2.reasoning === undefined, true, "这一轮没有思考 → 不写 reasoning 字段");
  }
  {
    /* 三条收尾路径（正常 / _cancelled 终止 / catch 里取消类错误 / 其它出错）都走它 */
    const calls = (ASSIST.match(/agentRoundMsgTail\(\s*\n?\s*st,/g) || []).length;
    ok(calls >= 4, "agentRoundMsgTail 在收尾路径上被调用 " + calls + " 次（正常 + 终止 + 取消类错误 + 其它出错）");
    ok(
      /catch \(e\) \{[\s\S]{0,600}?st\._cancelled \|\| isCancelishError\(errMsg\)[\s\S]{0,400}?agentRoundMsgTail\(/.test(
        ASSIST,
      ),
      "被终止 / 取消类错误那条收尾也带思考尾巴（源码序：判取消 → 归档）",
    );
  }

  /* =====================================================================
   * [4] 「显示思考」开关（本次需求：原四档「工作步骤展示」在会话里收回成它）
   * ===================================================================== */
  section("[4] 「显示思考」开关（模式菜单第三枚 = 会话级显示 / 整条不显示）");
  ok(HTML.indexOf('id="agentModeMenu"') > 0, "index.html 有模式菜单宿主（开关落在既有菜单里，不改结构）");
  {
    /* 真跑 agentModeEntryOf("think")：取当前态 → 点一下取反 → 落盘并重绘 */
    const calls = { persist: 0, composer: 0, render: 0 };
    let SESSION = { id: "as1", pure: false };
    const sb = {
      window: {},
      console,
      I18n: { t: (s) => String(s) },
      S: { config: { dsh: { transcriptView: "standard" } } },
      agentSessionState: () => SESSION,
      persistAgentSession: () => {
        calls.persist++;
      },
      renderAgentComposer: () => {
        calls.composer++;
      },
      renderAgentSession: () => {
        calls.render++;
      },
    };
    vm.createContext(sb);
    vm.runInContext(
      extract(ASSIST, [
        "agentModeEntryOf",
        "dshTranscriptViewNorm",
        "dshTranscriptViewGlobal",
        "dshTranscriptViewFor",
        "dshTranscriptViewLabel",
        "dshPolicyOfView",
        "dshThinkShownGlobal",
        "agentThinkOverrideOf",
        "agentThinkShown",
      ]) +
      /* 四档表在源码里是顶层 const；vm 里各脚本的顶层 const 不共享词法环境，
         这里按「成为 globalThis 属性」注入一份（真浏览器里 const 是共享的） */
      "\nvar DSH_TRANSCRIPT_VIEWS = ['compact','standard','detailed','verbose'];\nvar DSH_TRANSCRIPT_DEFAULT = 'standard';\n",
      sb,
      { filename: "mode-entry.js" },
    );
    const entry = (st) => {
      SESSION = st;
      return vm.runInContext('agentModeEntryOf("think")', sb);
    };
    const def = entry({ id: "as1" });
    eqStr(def.key, "think", "开关入口 key = think");
    eqStr(def.label, "显示思考", "开关入口名 = 显示思考");
    eqNum(def.on, true, "没点过的会话 → 跟随全局默认档 standard（思考照常显示）");
    ok(/显示思考：开启中/.test(def.title), "tooltip 写明当前态（开启中 → 点一下隐藏）");
    const flip1 = entry({ id: "as1" });
    flip1.toggle();
    eqNum(SESSION.showThink, false, "点一下 → 这条会话关掉显示思考（整条不显示）");
    ok(calls.persist >= 1, "开关态写进会话落盘（persistAgentSession）");
    ok(calls.composer >= 1 && calls.render >= 1, "开关当场重绘（chip + 会话视图一起刷新）");
    const off = entry({ id: "as1", showThink: false });
    eqNum(off.on, false, "关着的会话 = on 为假");
    ok(/显示思考：已关闭/.test(off.title), "关着时 tooltip 是「已关闭，点击重新显示」");
    off.toggle();
    eqNum(SESSION.showThink, true, "再点一下 → 重新显示思考（连点不会卡在同一态）");
    /* 全局默认档换成「简洁」时，没点过的会话默认就是关（会话级开关没定过 = 跟随全局） */
    eqNum(
      vm.runInContext(
        'S.config.dsh.transcriptView = "compact"; agentThinkShown({ id: "as3", showThink: null })',
        sb,
      ),
      false,
      "全局档 = 简洁 → 没点过的会话默认不显示思考",
    );
    vm.runInContext('S.config.dsh.transcriptView = "standard";', sb);
    /* 菜单行序：显示思考仍在最后一行（原四档那一枚的位置）；本轮起第一枚是
       「先拷问需求（grill-me）」（本次开发需求 · 默认开）。 */
    vm.runInContext("function agentAutoOnNow() { return true; }", sb);
    vm.runInContext(extract(ASSIST, ["agentModeEntries"]), sb, { filename: "mode-entries.js" });
    const keys = vm.runInContext("agentModeEntries().map(function (e) { return e.key; })", sb);
    eqStr(
      keys.join(","),
      "grill,pure,auto,think",
      "菜单行序 = 先拷问需求 / 纯净模式 / 自动续跑 / 显示思考（烤问在最上、思考在最下）",
    );
    /* 「先拷问需求」缺省开：没写过这一位的会话（老存档）也算开 */
    eqStr(
      vm.runInContext('agentModeEntryOf("grill").on', sb),
      true,
      "会话没写过 grill → 这一枚按开处理（缺省开 · 与开发节点 devGrill 同口径）",
    );
  }
  {
    /* 落盘白名单 + 重启水合（老存档迁移） */
    has(
      ASSIST,
      'showThink: typeof s.showThink === "boolean" ? s.showThink : null,',
      "persistAgentSession 白名单带上 showThink（null = 跟随全局默认档）",
    );
    ok(
      /const legacyView = dshTranscriptViewNorm\(sess\.transcriptView\);\s*\n\s*sess\.showThink = legacyView \? legacyView !== "compact" : null;/.test(
        BOOT,
      ),
      "app-boot 水合会话时迁移老字段：旧 transcriptView 简洁档 = 关掉显示思考，其余档 = 显示",
    );
    has(BOOT, "delete sess.transcriptView;", "迁移后删掉旧档位字段（不再有两个真源）");
    has(BOOT, 'transcriptView: "standard",', "配置缺省 transcriptView = standard（上游默认档）");
    ok(
      /t\.title = I18n\.t\("模式："\) \+ entries\.map\(mark\)\.join\(" \/ "\);/.test(ASSIST),
      "「模式」chip tooltip 逐项遍历（开关入口自动进提示）",
    );
    has(
      ASSIST,
      'menuId === "assistModeMenu"',
      "菜单说明文案分两处渲染（会话「以上开关都只作用于当前会话」/ 助手栏「…右侧助手栏」）",
    );
    ok(
      ASSIST.indexOf('"以上开关都只作用于当前会话，随时可改"') > 0 &&
        ASSIST.indexOf('"以上开关都只作用于右侧助手栏，随时可改"') > 0,
      "两条说明词条都在（中英成对见 renderer/i18n.js）",
    );
  }
  {
    /* 渲染判据真跑：按「这条消息属于哪条会话」取，别的视图（团队 / 节点 / 助手）不受影响。
       判据直接读会话表本体（S.agentSessions）—— 整表重绘里每条消息都问一次，
       这里故意把 agentSessions()（会逐会话做水合）打桩成抛错：一旦回退用它就立刻炸。 */
    const sb = {
      console,
      S: {
        agentSessions: [{ id: "as1", showThink: false }, { id: "as2", showThink: null }],
        config: { dsh: { transcriptView: "standard" } },
      },
      agentSessions: () => {
        throw new Error("判据不该走 agentSessions()（逐会话水合，太贵）");
      },
    };
    vm.createContext(sb);
    vm.runInContext(
      extract(ASSIST, [
        "dshThinkShownFor",
        "agentThinkShown",
        "dshThinkShownGlobal",
        "agentThinkOverrideOf",
        "dshTranscriptViewNorm",
        "dshTranscriptViewGlobal",
        "dshTranscriptViewFor",
        "dshTranscriptViewOfSessionId",
        "dshPolicyOfView",
      ]) +
      "\nvar DSH_TRANSCRIPT_VIEWS = ['compact','standard','detailed','verbose'];\nvar DSH_TRANSCRIPT_DEFAULT = 'standard';\n",
      sb,
      { filename: "think-shown.js" },
    );
    const Q = (code) => vm.runInContext(code, sb);
    eqNum(Q('dshThinkShownFor("as1")'), false, "关掉开关的会话 → 思考段整条不渲染");
    eqNum(Q('dshThinkShownFor("as2")'), true, "没点过的会话 → 跟随全局默认档（standard）→ 照常显示");
    eqNum(Q('dshThinkShownFor("chat-1")'), true, "不是会话 id 的视图（团队 / 节点会话 / 助手）→ 照常显示");
    eqNum(Q('dshThinkShownFor("")'), true, "没有归属 → 照常显示");
    eqNum(Q('agentThinkShown({ showThink: false })'), false, "会话对象口径同源（live 渲染用）");
    eqNum(Q("agentThinkShown(null)"), true, "拿不到会话时按全局默认档（standard）→ 显示");
    /* 全局档位仍派生两位策略（会话级「显示思考」开关只覆写其中的 showThink）；
       本次需求把原来第三位 expandThink（详细 / 完全展开 = 思考落地即展开）删掉了 ——
       思考一律收成一行摘要条、点开在弹窗里读，没有「展开」这回事。 */
    eqNum(Q('dshPolicyOfView("compact").showThink'), false, "简洁档：不显示思考块");
    eqNum(Q('dshPolicyOfView("standard").showThink'), true, "标准档：显示思考块");
    eqNum(
      Q('typeof dshPolicyOfView("detailed").expandThink'),
      "undefined",
      "详细档不再有 expandThink（思考一律点开弹窗）",
    );
    eqNum(
      Q('typeof dshPolicyOfView("verbose").expandThink'),
      "undefined",
      "完全展开档同样没有 expandThink",
    );
    eqNum(Q('dshPolicyOfView("verbose").expandProcess'), true, "完全展开：工具卡也默认摊开");
    eqNum(
      Q('typeof dshPolicyOfView("standard").foldCompletedTurns'),
      "undefined",
      "策略里不再有 foldCompletedTurns（工具调用一律按时间线内联、不收纳）",
    );
    eqNum(Q('dshPolicyOfView("bogus").view'), "standard", "非法值回落 standard（上游默认档）");
  }

  /* =====================================================================
   * [5] 渲染接线：三处思考块 + live 回退块都受判据控制
   * ===================================================================== */
  section("[5] 渲染接线（历史分段 / 运行中分段 / 无分段老消息 / 无分段 live 块）");
  has(
    ASSIST,
    "function dshHistSegEl(seg, pool, nodeId, idx, n, showThink, msgAt, policy) {",
    "历史分段渲染接收 showThink 判据与档位策略（msgAt = 逐项时刻的回落时刻）",
  );
  has(
    ASSIST,
    'if (showThink === false) return null;',
    "历史思考段：关掉时整块不渲染（其余段照旧）",
  );
  has(
    ASSIST,
    "const el = dshHistSegEl(m.segments[n], pool, nodeId, idx, n, showThink, m.at, policy);",
    "dshMsgBlock 把判据与档位策略传进历史分段渲染",
  );
  has(ASSIST, "const showThink = dshThinkShownFor(nodeId);", "dshMsgBlock 按消息归属解析判据");
  ok(
    /* 判据放宽一次（本次需求 · 段快照不再整份丢）：m._segNoBody = 段里还留着思考、但
       say 段拼不回 content（被单段上限截过）—— 这种消息正文必须走 m.content，思考照旧
       渲染，所以这一支也要认。 */
    /m\.role === "assistant" &&\s*\n\s*\(!segsView \|\| m\._segNoBody\) &&\s*\n\s*showThink &&/.test(
      ASSIST,
    ),
    "无分段的老消息（整段 m.reasoning）同样受判据控制",
  );
  has(ASSIST, "const showThink = agentThinkShown(st);", "运行中分段渲染（agentLiveSegsEl）按本会话取判据");
  ok(
    /if \(seg\.k === "think"\) \{\s*\n\s*\/\* 「显示思考」关掉[\s\S]{0,200}?if \(!showThink\) continue;/.test(
      ASSIST,
    ),
    "运行中思考段：关掉时跳过（不建 DOM、也不参与就地更新）",
  );
  has(
    ASSIST,
    "if (tRow && agentThinkShown(st)) row.appendChild(tRow);",
    "无分段 live 的思考摘要条（节点绑定运行等）关掉时不挂进 DOM",
  );
  /* 关掉只是不渲染：数据侧一字不动 */
  ok(
    ASSIST.indexOf("agentRoundMsgTail") > 0 &&
      /if \(String\(rsn\)\.trim\(\)\) msg\.reasoning = rsn;/.test(ASSIST),
    "开关不影响归档（思考照旧写进 msg.reasoning / segments）",
  );
  /* 本轮需求：**任何档位都不再收纳工具调用**（用户口径「不应当进行任何收纳，否则会和工具
     在顺序上分离」）—— 折叠行渲染器与它的调用点整只撤掉，思考自然也不会被折进去。
     用户报的「思考仍然未正确显示」当初正是它（标准档把 think 段一起搬进折叠体）。 */
  ok(
    ASSIST.indexOf("function dshTurnProcessFold(") < 0 && ASSIST.indexOf("foldRow") < 0,
    "轮次过程折叠行（及其调用点）已整只撤掉：工具与思考都不再被收纳",
  );
  ok(
    /for \(let n = from; n < m\.segments\.length; n\+\+\) \{[\s\S]{0,400}?body\.appendChild\(el\);/.test(
      ASSIST,
    ),
    "段一律按段序内联 append 进正文（没有任何「搬进折叠体」的分支）",
  );

  /* =====================================================================
   * [6] i18n：新串逐条有英文词条（真模块跑一遍）
   * ===================================================================== */
  section("[6] i18n：新串中英成对");
  const keys = [
    "显示思考",
    "关闭后这条会话里整条不显示模型的思考（不是折叠，是真的不出现）；思考内容仍随消息存档，随时可再打开",
    "显示思考：开启中，点击隐藏这条会话里的模型思考（整条不显示）",
    "显示思考：已关闭，点击重新显示这条会话里的模型思考",
    "简洁",
    "详细",
    "完全展开",
    "工作步骤展示（新会话默认档位：简洁 = 不显示思考 / 标准 / 详细 / 完全展开 = 思考与工具卡都默认摊开；工具调用一律按时间线内联、不收纳；每会话还可在输入区「模式」菜单里用「显示思考」开关单独隐藏 / 显示思考）",
    "以上开关都只作用于当前会话，随时可改",
    /* 逐项时刻（本轮需求）：每一项左侧那条时刻栏的三条词条 */
    "这一项自己的时刻（精确到秒）",
    "，耗时 ",
    "这一项自己没有独立时刻（老存档的段）：显示的是所属消息的时刻",
  ];
  for (const k of keys) {
    ok(I18N_SRC.indexOf('"' + k + '"') >= 0, "i18n 表里有词条：" + k.slice(0, 16));
  }
  I18n.setLocale("en");
  for (const k of keys) {
    const en = I18n.t(k);
    ok(en && en !== k && !/[\u4e00-\u9fa5]/.test(en), "英文界面已译（无中文残留）：" + k.slice(0, 16));
  }
  ok(/Show thinking/.test(I18n.t("显示思考")), "英文词条语义对得上（Show thinking）");
  I18n.setLocale("zh");
  eqStr(I18n.t("显示思考"), "显示思考", "中文口径原样返回（中文为键）");
  /* 四档循环那一套词条已随会话级档位一起收回：菜单里不该再留「工作步骤展示」死词条 */
  ok(
    I18N_SRC.indexOf('"工作步骤展示"') < 0 &&
      I18N_SRC.indexOf('"工作步骤展示："') < 0 &&
      I18N_SRC.indexOf('" · 点击切到「"') < 0,
    "四档菜单的死词条已清（工作步骤展示 / 工作步骤展示： /  · 点击切到「）",
  );

  /* =====================================================================
   * [7] 轨迹不跟着「显示思考」一起空（本次需求：开关只做会话渲染隐藏）
   * ===================================================================== */
  section("[7] 「显示思考」关掉时：会话里思考块不建 DOM，轨迹照旧有思考行");
  {
    /* ① 静态：轨迹模块的段采集不许出现会话侧那套显示判据（**注释先剥掉**：
       不变量注释里点名了那几个判据，数它们会误判） */
    const TRAJ_SRC = read("renderer/app-trajectory.js");
    const TRAJ_CODE = TRAJ_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    ok(
      TRAJ_CODE.indexOf("showThink") < 0 &&
        TRAJ_CODE.indexOf("agentThinkShown") < 0 &&
        TRAJ_CODE.indexOf("dshThinkShownFor(") < 0,
      "[7] app-trajectory.js 代码里不引用会话侧显示判据（showThink / agentThinkShown / dshThinkShownFor( 各 0 处）",
    );
    ok(
      /一条是硬不变量|这条是硬不变量/.test(TRAJ_SRC),
      "[7] collectSegments 上方写明「不许按显示思考过滤」这条硬不变量（源码原文）",
    );
    /* ② 静态：会话侧仍按判据早退（历史分段 + 运行中分段两条路都在） */
    const guardCount = (ASSIST.match(/if \(showThink === false\) return null;/g) || []).length;
    eqNum(guardCount, 1, "[7] 会话侧历史分段渲染仍有 showThink===false 早退（1 处）");
    has(
      ASSIST,
      "if (!showThink) continue;",
      "[7] 会话侧运行中分段渲染仍有 !showThink 跳过（思考段不建 DOM）",
    );
    /* ③ 真模块跑：轨迹段采集函数（renderer/app-trajectory.js 的 collectSegments 原文）
       在 showThink=false 的会话上取段 —— 历史段快照与 live 轨迹都必须带思考段。 */
    const grabFn = (src, name, indent) => {
      const pad = " ".repeat(indent || 2);
      const at = src.indexOf(pad + "function " + name + "(");
      if (at < 0) throw new Error("grabFn: 找不到函数 " + name);
      const nxt = src.indexOf("\n" + pad + "function ", at + 1);
      return src.slice(at, nxt < 0 ? src.length : nxt);
    };
    const histMsg = {
      role: "assistant",
      content: "答复",
      reasoning: "想过",
      segments: [
        { k: "think", text: "想一下", step: 1 },
        { k: "tool", text: "", step: 2 },
        { k: "say", text: "答复", step: 3 },
      ],
    };
    const liveItems = [
      { k: "think", text: "先看代码", step: 1 },
      { k: "tool", text: "", step: 1, callId: "c1" },
      { k: "say", text: "看完了", step: 1 },
    ];
    let liveEmpty = true;
    const sb = {
      console: { warn: () => {}, log: () => {}, error: () => {} },
      /* 会话对象：**关着「显示思考」**（本次需求的关键前提）；没有这条会话时返回 null，
         用来走「三个来源都空」的那一支 */
      agentSessionById: (id) =>
        String(id) === "asX"
          ? {
              id: "asX",
              showThink: false,
              running: true,
              messages: [{ role: "user", content: "问题" }, histMsg],
            }
          : null,
      activeSession: () => null,
      agentTraceItems: () => (liveEmpty ? null : liveItems),
      agentTraceRound: () => 1,
      agentChatSegItems: () => null,
      dshSegToolAt: (pool, seg) => {
        if (!Array.isArray(pool) || !seg || seg.k !== "tool") return -1;
        for (let i = 0; i < pool.length; i++) {
          const t = pool[i];
          if (!t) continue;
          if (seg.callId) {
            if (String(t.callId) === String(seg.callId)) return i;
          } else if (seg.step != null && t.step === seg.step) return i;
        }
        return -1;
      },
    };
    vm.createContext(sb);
    vm.runInContext(
      [
        grabFn(TRAJ_SRC, "agentSegsMergeRounds"),
        grabFn(TRAJ_SRC, "collectSegments"),
        grabFn(TRAJ_SRC, "histSegmentsOf"),
        grabFn(TRAJ_SRC, "toolMapOf"),
        grabFn(TRAJ_SRC, "traceRoundOf"),
      ].join("\n") + "\nthis.collectSegments = collectSegments;\n",
      sb,
      { filename: "trajectory-collect.js" },
    );
    const collect = (sid) => vm.runInContext("collectSegments(" + JSON.stringify(sid) + ")", sb);
    const histSegs = collect("asX");
    const kinds = histSegs.map((s) => s.k).join(",");
    eqStr(kinds, "think,tool,say", "[7] 历史会话（showThink=false）→ 轨迹段含思考，段序原样");
    eqStr(histSegs[0].text, "想一下", "[7] 思考段正文完整交给轨迹（不因开关被藏）");
    ok(collect("none").length === 0, "[7] 三个来源都空 → 空数组（不是 undefined，轨迹走空态）");
    liveEmpty = false;
    const liveSegs = collect("asX");
    /* 本次需求（用户报的「轨迹 / 改动只剩最后一轮」）：历史段与 live 段**合并**输出，
       旧轮一条不丢。fixture 里那份历史段正是上一轮（步骤号递增，与 live 不是同一份），
       所以这里既钉住「live 三轮都在」，也钉住「旧轮还在它前面」。 */
    ok(
      liveSegs.length === 6 &&
        liveSegs.slice(0, 3).every((s) => s.round == null) &&
        liveSegs.slice(3).map((s) => s.k).join(",") === "think,tool,say",
      "[7] 旧轮段在前 + 本轮 live 段在后，两份都留着（实得 " +
        liveSegs.map((s) => s.k).join(",") +
        "）",
    );
    eqStr(
      liveSegs.slice(3).map((s) => s.k).join(","),
      "think,tool,say",
      "[7] 本轮 live 轨迹（showThink=false）→ 思考 / 工具 / 正文三段都在",
    );
    eqNum(liveSegs[3].round, 1, "[7] live 段照旧带上本轮轮号（轨迹按「第 N 轮」分组不受影响）");
    /* 会话侧口径（真函数）：开关关着时历史分段仍可渲染（思考留在存档里，轨迹读得到） */
    const viewSb = { console, S: { agentSessions: [], config: { dsh: {} } } };
    vm.createContext(viewSb);
    vm.runInContext(extract(ASSIST, ["dshMsgSegsViewable"]), viewSb, {
      filename: "trajectory-segs-viewable.js",
    });
    ok(
      vm.runInContext(
        "dshMsgSegsViewable(" + JSON.stringify(histMsg) + ")",
        viewSb,
      ),
      "[7] 开关关着也不动段快照（dshMsgSegsViewable 照旧成立 → 轨迹读得到同一份段）",
    );
  }

  console.log(
    "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-think-visible)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-think-visible.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-think-visible.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：思考弹窗的「译文只写一个框」（本轮需求） ====================
   真函数跑进迷你 DOM：未点翻译时窗里只有原文一栏；点过翻译才在原文框**下面**建出译文栏，
   译文本体只写在译文框栏头下方的那个框里（旧写法会多出两个框：栏头里插一个、正文区再画一个）。 */
(function () {
  const __dirname = TEST_DIR;
  const { fs, path, vm } = SHARED;
  let fails = 0, checks = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok    " + msg);
    else {
      fails++;
      MERGED_FAILED = true;
      console.log("FAIL  " + msg);
    }
  };
  const section = (name) => console.log("\n" + name);
  const ASSIST_SRC = fs.readFileSync(path.join(TEST_DIR, "..", "renderer", "app-assist.js"), "utf8");

  /* 抠函数本体（跳过字符串与注释再按大括号配对，与 smoke-agent-changes 同一读法） */
  function fnBody(src, name) {
    const re = new RegExp("(^|\\n)\\s*(async\\s+)?function\\s+" + name + "\\s*\\(");
    const m = re.exec(src);
    if (!m) throw new Error("找不到函数 " + name);
    const at = m.index + (m[1] ? 1 : 0);
    let j = src.indexOf("{", at);
    let depth = 0;
    let inStr = null;
    for (; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr) {
        if (c === inStr && p !== "\\") inStr = null;
        continue;
      }
      if (c === "/" && src[j + 1] === "/") {
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数 " + name + " 括号不配对");
  }

  /* 迷你 DOM：只做弹窗这条链路用到的那几样（含 [attr="v"] 选择器 —— 模块按 data-think-pop
     找译文栏）。 */
  function mkEl(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      id: "",
      parentNode: null,
      _children: [],
      _cls: new Set(),
      _attrs: {},
      dataset: {},
      title: "",
      type: "",
      disabled: false,
      _text: "",
      _html: "",
    };
    Object.defineProperty(el, "textContent", {
      get() {
        let s = el._text == null ? "" : el._text;
        for (const c of el._children) s += c.textContent;
        return s;
      },
      set(v) {
        el._text = String(v == null ? "" : v);
        for (const c of el._children.slice()) el.removeChild(c);
      },
    });
    el.classList = {
      add: (...c) => c.forEach((x) => el._cls.add(x)),
      remove: (...c) => c.forEach((x) => el._cls.delete(x)),
      contains: (c) => el._cls.has(c),
      toggle: (c, on) =>
        on === undefined
          ? el._cls.has(c)
            ? el._cls.delete(c)
            : el._cls.add(c)
          : on
            ? el._cls.add(c)
            : el._cls.delete(c),
    };
    Object.defineProperty(el, "className", {
      get: () => Array.from(el._cls).join(" "),
      set: (v) => {
        el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
      },
    });
    Object.defineProperty(el, "innerHTML", {
      get: () => el._html,
      set: (v) => {
        el._html = String(v == null ? "" : v);
        if (!el._html) for (const c of el._children.slice()) el.removeChild(c);
      },
    });
    el.appendChild = (c) => {
      if (!c) return c;
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = el;
      el._children.push(c);
      return c;
    };
    el.removeChild = (c) => {
      const i = el._children.indexOf(c);
      if (i >= 0) el._children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    };
    el.setAttribute = (k, v) => {
      el._attrs[k] = String(v);
    };
    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
    el.addEventListener = () => {};
    el.querySelectorAll = (sel) => {
      const out = [];
      const walk = (n) => {
        for (const c of n._children) {
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    };
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
    return el;
  }
  function matchesSelf(node, sel) {
    const s = String(sel || "").trim();
    if (!s || !node || node.nodeType !== 1) return false;
    let rest = s;
    for (const m of s.match(/\[[^\]]+\]/g) || []) {
      rest = rest.replace(m, "");
      const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(m);
      if (!am) return false;
      const key = am[1].replace(/^data-/, "").replace(/-([a-z])/g, (x, c) => c.toUpperCase());
      const val = node.dataset[key];
      if (am[2] == null ? val == null : String(val) !== am[2]) return false;
    }
    for (const p of rest.match(/[.#][\w-]+/g) || []) {
      if (p[0] === ".") {
        if (!node._cls.has(p.slice(1))) return false;
      } else if (node.id !== p.slice(1)) return false;
    }
    const tag = /^[a-zA-Z]+/.exec(rest);
    if (tag && node.tagName !== tag[0].toUpperCase()) return false;
    return true;
  }
  function matches(node, sel) {
    const parts = String(sel || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    if (!matchesSelf(node, parts[parts.length - 1])) return false;
    let n = node.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      let hit = false;
      while (n) {
        if (matchesSelf(n, parts[i])) {
          hit = true;
          n = n.parentNode;
          break;
        }
        n = n.parentNode;
      }
      if (!hit) return false;
    }
    return true;
  }

  section("[9] 思考弹窗：译文只写一个框（未点翻译时没有译文框）");
  try {
    const docRoot = mkEl("body");
    const ovBody = mkEl("div");
    const ovFoot = mkEl("div");
    const ovBox = mkEl("div");
    ovBox.className = "overlay-box";
    docRoot.appendChild(ovBody);
    const seenEsc = [];
    const sb = {
      console,
      S: { thinkTrans: {} },
      I18n: { t: (s) => String(s) },
      document: {
        createElement: (t) => mkEl(t),
        getElementById: (id) =>
          id === "ovBody" ? ovBody : id === "ovFoot" ? ovFoot : id === "overlay" ? ovBox : null,
        querySelector: (s) => docRoot.querySelector(s),
        querySelectorAll: (s) => docRoot.querySelectorAll(s),
      },
      openOverlay: () => {},
      formatMsgTimeSec: (t) => String(t),
      dshTranslateModel: () => ({ route: "deepseek-official", model: "m1", prov: { id: "p" } }),
      plainTextToLinkHtml: (t) => String(t),
      escapeHtml: (t) =>
        String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      rvMarkdownHtml: (md) => {
        seenEsc.push(String(md));
        return "<p>" + md + "</p>";
      },
    };
    vm.createContext(sb);
    vm.runInContext(
      [
        fnBody(ASSIST_SRC, "dshThinkTransKey"),
        fnBody(ASSIST_SRC, "dshThinkTransItem"),
        fnBody(ASSIST_SRC, "dshThinkMdHtml"),
        fnBody(ASSIST_SRC, "dshThinkTranslateRow"),
        fnBody(ASSIST_SRC, "dshThinkPopPaintXlate"),
        fnBody(ASSIST_SRC, "dshThinkPopCol"),
        fnBody(ASSIST_SRC, "dshThinkTranslateBtn"),
        fnBody(ASSIST_SRC, "openDshThinkPop"),
        "this.paintXlate = dshThinkPopPaintXlate;",
        "this.openPop = openDshThinkPop;",
      ].join("\n"),
      sb,
      { filename: "think-pop.js" },
    );
    const cols = () => docRoot.querySelectorAll(".dsh-think-pop-col");
    const xlateCol = () => docRoot.querySelector('.dsh-think-pop-col[data-think-pop="xlate"]');

    /* ① 未点翻译：只有原文一栏，正文是 Markdown（转义后进渲染入口），栏头挂「复制」+「翻译」 */
    sb.openPop({ text: "看一看 <b>这段</b>\n## 小标题", scopeId: "s1", segKey: "k1" });
    ok(cols().length === 1 && !xlateCol(), "[9] 未点翻译：窗里只有原文一栏（不显示译文框）");
    ok(
      docRoot.querySelectorAll(".dsh-think-pop-pane").length === 1 &&
        !!docRoot.querySelector('.dsh-think-pop [data-think-pop="src"] .dsh-think-pop-md'),
      "[9] 原文正文写在原文框里（.dsh-think-pop-md，Markdown 渲染）",
    );
    ok(
      seenEsc.length === 1 && seenEsc[0].indexOf("&lt;b&gt;") > 0,
      "[9] 模型输出先转义再进 Markdown 渲染入口（不被当 HTML 执行）",
    );
    ok(
      docRoot.querySelectorAll(".dsh-think-pop-tools .dsh-think-xlate").length === 2,
      "[9] 原文栏头挂「复制」+「翻译」两枚按钮（没有第二处入口）",
    );

    /* ② 点翻译（翻译中）：译文栏才建出来，长在原文框**下面**，正文写它栏头下方的框里 */
    sb.S.thinkTrans["s1:k1"] = { status: "pending", text: "", model: "m1" };
    sb.paintXlate("s1", "k1");
    const c2 = cols();
    ok(
      c2.length === 2 && c2[0].dataset.thinkPop === "src" && c2[1].dataset.thinkPop === "xlate",
      "[9] 点翻译后译文栏建在原文框下面（一上一下，不是左右分栏）",
    );
    ok(
      docRoot.querySelectorAll(".dsh-seg-xlate").length === 1 &&
        xlateCol().querySelector(".dsh-xlate-md").textContent.indexOf("翻译中…") >= 0,
      "[9] 翻译中只占译文框那一个框的正文位（不再往栏头插一个框）",
    );

    /* ③ 翻完：译文也走同一个 Markdown 渲染入口，仍然只有一个译文框 */
    const escBefore = seenEsc.length;
    sb.S.thinkTrans["s1:k1"] = { status: "done", text: "## 标题\n- 一条", model: "m1" };
    sb.paintXlate("s1", "k1");
    ok(
      docRoot.querySelectorAll(".dsh-seg-xlate").length === 1 &&
        seenEsc.length === escBefore + 1 &&
        seenEsc[seenEsc.length - 1].indexOf("- 一条") > 0,
      "[9] 译文也按 Markdown 渲染（翻译注意格式），整块重建后仍然只有一个译文框",
    );
    ok(
      xlateCol().querySelector(".dsh-xlate-md").innerHTML.indexOf("<p>") === 0 &&
        xlateCol().querySelector(".dsh-xlate-copy").textContent === "复制",
      "[9] 译文正文落在译文框栏头下方的正文位里（翻完才挂「复制译文」）",
    );

    /* ④ 失败：栏头红字原因，正文留空 */
    sb.S.thinkTrans["s1:k1"] = { status: "error", error: "boom", model: "m1" };
    sb.paintXlate("s1", "k1");
    ok(
      xlateCol().querySelector(".dsh-xlate-err").textContent === "boom" &&
        !xlateCol().querySelector(".dsh-xlate-md"),
      "[9] 翻译失败只在栏头给原因（不多画一个空正文框）",
    );

    /* ④b 失败但留了「模型本次返回的内容」（本轮需求）：说明句 + 原始返回摆在译文框里，
       且**不得**写成译文正文（.dsh-xlate-md）——失败态绝不能被当成译文缓存。 */
    sb.S.thinkTrans["s1:k1"] = {
      status: "error",
      error: "校验未通过",
      model: "m1",
      raw: "原始返回正文",
    };
    sb.paintXlate("s1", "k1");
    const escBefore2 = seenEsc.length;
    ok(
      !!xlateCol().querySelector(".dsh-xlate-why") &&
        !!xlateCol().querySelector(".dsh-xlate-raw") &&
        seenEsc.length === escBefore2, /* 假 DOM 的 innerHTML 桩不落 HTML，转义在 ④c 验 */
      "[9] 失败态展示「模型本次返回的内容」的说明句 + 内容框（不是译文正文、不给「复制译文」）",
    );
    /* ④c 原始返回同样走「先转义再进渲染入口」这条唯一安全底线（与原文 / 译文同源），
       且失败态绝不写 it.text（不会被当成译文缓存） */
    const escSeen = [];
    sb.rvMarkdownHtml = (md) => {
      escSeen.push(String(md));
      return "<p>" + md + "</p>";
    };
    sb.S.thinkTrans["s1:k1"] = { status: "error", error: "x", model: "m1", raw: "看 <b>这个</b>" };
    sb.paintXlate("s1", "k1");
    ok(
      escSeen.length >= 1 && escSeen[escSeen.length - 1].indexOf("&lt;b&gt;") > 0 &&
        !sb.S.thinkTrans["s1:k1"].text,
      "[9] 被拒返回先转义再进 Markdown 渲染入口，且不写进 it.text（失败态不当译文缓存）",
    );

    /* ⑤ 没有译文项（切走 / 重跑）：整栏收掉，回到「只有原文框」 */
    delete sb.S.thinkTrans["s1:k1"];
    sb.paintXlate("s1", "k1");
    ok(cols().length === 1 && !xlateCol(), "[9] 译文项没了就把整栏收掉（回到未点翻译的形态）");
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [9] 弹窗 DOM 用例异常：" + (e && e.stack ? e.stack : e));
  }
  console.log(
    "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-think-pop)",
  );
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

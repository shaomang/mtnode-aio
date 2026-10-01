"use strict";
/* 会话自己的浏览器 + 活动流 + 长时自治 —— 冒烟测试（纯 Node，零依赖）
 *   node test/smoke-browser.js
 *   MTNODE_BROWSER_SMOKE=1 node test/smoke-browser.js   # 追加真机集成段（真起 Edge/Chrome）
 *
 * 覆盖（对标用户已确认的 16 条共识）：
 *   [1] 浏览器底座：候选探测链 / 用户数据目录落在数据目录下 / CDP 零新依赖（内置 WebSocket）
 *   [2] 安全闸纯函数：域名名单判定 / 危险动作关键词 / 策略归一
 *   [3] 网关接线：interact 白名单含 browser · browser 方法 · 桥帧处理 · 活动流留痕 ·
 *                 runtime key 的 nb: 成分 · MTNODE_NO_BROWSER 注入
 *   [4] 运行时插件：13 个 browser_* 工具全注册 · 整档闸（PURE / NO_BROWSER）· 只在会话可用
 *   [5] cordis 组合：mtnode-browser 行存在且与会话口径一致（pure / isolate 才禁用）
 *   [6] 活动流留痕库：真落盘（tmp 库）· 归一 · 查询过滤 · 按会话清空 · 超量清理常数
 *   [7] 渲染层：侧栏页签 · 活动流面板 · 求助卡 · 长时 chip · 自检纪律 · i18n 词条成对
 *   [8] 实况流：默认 dock 在会话右边栏 · 独立窗口/收回 · 帧不落库不自动拉起浏览器
 *   [9] 打包白名单：activity-store.js 进 build.json files（否则打包后 Cannot find module）
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");
const exists = (rel) => fs.existsSync(path.join(__dirname, "..", rel.split("/").join(path.sep)));

const HOST = read("dsh/gateway/browser-host.mjs");
const PLUGIN = read("dsh/gateway/browser-plugin.mjs");
const GATEWAY = read("dsh/gateway/gateway.mjs");
const CORDIS = read("dsh/gateway/cordis.yml");
const TV = read("dsh/gateway/tool-visibility.mjs");
const MAIN = read("main.js");
const PRELOAD = read("preload.js");
const DSH = read("dsh/main-dsh.js");
const ACTIVITY = read("activity-store.js");
const BUILDCONF = read("build.json");
const HTML = read("renderer/index.html");
const APP_BROWSER = read("renderer/app-browser.js");
const APP_LONGRUN = read("renderer/app-longrun.js");
const APP_ASSIST = read("renderer/app-assist.js");
const APP_DB = read("renderer/app-db.js");
const APP_NODES = read("renderer/app-nodes.js");
const CSS = read("renderer/css/browser.css");
const STYLE = read("renderer/style.css");
const I18N = read("renderer/i18n.js");

console.log("smoke-browser：会话自己的浏览器 / 活动流 / 求助接管 / 长时自治\n");

/* ============ [1] 浏览器底座 ============ */
console.log("[1] 浏览器底座（browser-host.mjs）");
{
  ok(/export function browserCandidates\(/.test(HOST), "有候选探测链（Windows / macOS / Linux 各一组）");
  ok(/msedge\.exe/.test(HOST) && /chrome\.exe/.test(HOST), "Windows 候选含 Edge 与 Chrome（本机只有 Edge 时回退链仍成立）");
  ok(/Microsoft Edge\.app\/Contents\/MacOS/.test(HOST) && /\/usr\/bin\/google-chrome/.test(HOST),
    "macOS / Linux 候选也在（通用探测链，但只在 Windows 验收）");
  ok(/export function detectBrowser\(/.test(HOST), "detectBrowser()：找不到回空串，由调用方折算成明确错误");
  ok(/Node ≥22|Node ≥ 22/.test(HOST) && /typeof WebSocket !== 'function'/.test(HOST),
    "CDP 零新依赖：用内置 WebSocket，缺了就明确报错（不引 playwright / puppeteer）");
  const deps = JSON.parse(read("dsh/gateway/package.json")).dependencies;
  /* 0.2 起 browser-use 实验包（browser-use-playwright-mcp / stagehand-native）按
     「内核全开」口径挂进网关：它们的名字里带 playwright，但 Chromium 内核不随包发 ——
     装包时由 playwright / @puppeteer/browsers 在用户机器上按需下载到各自缓存目录。
     MTNode 自有的浏览器底座（browser-host.mjs）仍然零新依赖。 */
  ok(
    !Object.keys(deps).some((d) => /^(playwright|puppeteer|@playwright\/[^/]+)$/i.test(d)),
    "网关没有把 playwright / puppeteer 本体当直接依赖（浏览器内核不随包发）",
  );
  ok(
    /Node ≥22|Node ≥ 22/.test(HOST) && /typeof WebSocket !== 'function'/.test(HOST),
    "自有浏览器底座仍是零新依赖：用内置 WebSocket，缺了就明确报错",
  );
  ok(/browser-profile/.test(HOST), "用户数据目录名固定 browser-profile（独立配置、跨会话保持登录态）");
  ok(/--user-data-dir=/.test(HOST) && /--remote-debugging-port=/.test(HOST), "启动参数带专属 user-data-dir 与调试端口");
  ok(/export async function stopBrowser/.test(HOST) && /自动重启|清干净再起/.test(HOST),
    "崩溃 / 失效后自动重起（不打扰模型）");
  ok(/export function claimDriver/.test(HOST) && /另一条会话驱动/.test(HOST),
    "驱动串行锁：同一时刻只让一条会话驱动，抢用给明确错误而非排队");
  ok(/export function setTakeover/.test(HOST) && /export function isTakeover/.test(HOST), "接管状态可设可读（接管期间由网关拒绝 Agent 动作）");
  ok(/export async function bringToFront/.test(HOST) && /Page\.bringToFront/.test(HOST),
    "能把浏览器窗口抬到前台（用户手动打开 / 登录求助时，窗口必须在他眼前）");
  ok(/Browser\.setWindowBounds/.test(HOST), "最小化的窗口先还原成正常态再抬前台");
  ok(/export async function snapshot/.test(HOST) && /elements/.test(HOST) && /textTruncated/.test(HOST),
    "快照回结构化页面摘要（标题 / URL / 可点元素 / 可见文本 + 截断标记），不是回图");
  for (const fn of ["navigate", "click", "typeText", "pressKey", "evaluateJs", "waitFor", "tabs", "screenshot", "network"])
    ok(new RegExp("export async function " + fn + "\\(").test(HOST), "工具面有 " + fn + "()");
  ok(/Network\.requestWillBeSent|Network\.enable/.test(HOST), "页内网络留痕（方法 / 状态 / URL）");
  ok(/Runtime\.exceptionThrown|Log\.entryAdded/.test(HOST), "页内控制台错误留痕（活动流里能看到它报了什么错）");
  ok(/危险动作|DANGEROUS_WORDS/.test(HOST) && /dangerOfClick/.test(HOST), "危险动作判据是纯函数（提交 / 支付 / 删除 / 发送 / 发布…）");
  ok(/export function domainVerdict/.test(HOST) && /blocked/.test(HOST) && /confirm/.test(HOST), "域名判定：拦截名单硬拒绝 + 风险名单首次确认");
}

/* ============ [2] 纯函数真跑 ============ */
console.log("\n[2] 安全闸纯函数（真跑，不看源码）");
(async () => {
  const H = await import(require("url").pathToFileURL(path.join(__dirname, "..", "dsh", "gateway", "browser-host.mjs")).href);
  {
    const v1 = H.domainVerdict("https://mail.google.com/mail/u/0", H.DEFAULT_POLICY);
    ok(v1.confirm === true && v1.blocked === false, "风险站点（mail.google.com）判为「首次访问需确认」");
    const v2 = H.domainVerdict("https://example.com/x", { blocked: ["example.com"], confirm: [] });
    ok(v2.blocked === true && /拦截名单/.test(v2.why), "拦截名单命中 → 硬拒绝并给出原因");
    const v3 = H.domainVerdict("https://docs.deepseek.com/a", H.DEFAULT_POLICY);
    ok(v3.blocked === false && v3.confirm === false, "普通站点不拦不问（默认名单不误伤）");
    ok(H.dangerOfClick("立即购买", "#buy").danger === true, "「立即购买」判为危险动作");
    ok(H.dangerOfClick("Submit", "button[type=submit]").danger === true, "Submit / type=submit 判为危险动作");
    ok(H.dangerOfClick("下一页", "a.next").danger === false, "翻页类点击不算危险动作（不打扰用户）");
    const vBank = H.domainVerdict("https://www.bankofamerica.com/login", { blocked: ["bank"], confirm: [] });
    ok(vBank.blocked === false, "名单按「域名 / 子域」精确匹配：拦截 `bank` 不误伤 bankofamerica.com");
    const vSub = H.domainVerdict("https://mail.google.com/mail", { blocked: [], confirm: ["google.com"] });
    ok(vSub.confirm === true, "子域命中父域名单（mail.google.com 命中 google.com）");
    const p = H.normalizePolicy({ blocked: [" A.com ", "", "a.com"], confirm: [] });
    ok(p.blocked.length === 2 && p.blocked[1] === "a.com", "名单归一：去空白 / 小写 / 保序");
    ok(p.confirm.length > 0 && p.approveDangerous === true, "风险名单为空时回落默认名单（不出现「什么都不问」）");
    ok(H.profileDirOf("C:/data/dsh-home").replace(/\\/g, "/").endsWith("data/browser-profile"),
      "用户数据目录 = 数据目录下（不落应用文件夹）");
  }

  /* ============ [3] 网关接线 ============ */
  console.log("\n[3] 网关接线（gateway.mjs）");
  {
    ok(/m\.t !== 'browser'/.test(GATEWAY), "桥帧白名单收了 browser 帧");
    ok(/async function handleBrowserFrame/.test(GATEWAY), "有 browser 帧的执行入口（网关进程内驱动，不回渲染层）");
    ok(/BrowserHost\.registerActivitySink/.test(GATEWAY), "浏览器留痕转成宿主事件（活动流实时 + 落库）");
    ok(/'browser-act'/.test(GATEWAY), "活动流事件名 browser-act（渲染层全局订阅）");
    ok(/case 'browser': \{/.test(GATEWAY) && /action === 'status'/.test(GATEWAY) && /action === 'open'/.test(GATEWAY)
      && /action === 'policy'/.test(GATEWAY) && /action === 'takeover'/.test(GATEWAY),
      "控制面方法：status / open / stop / policy / takeover");
    ok(/p\.kind === 'browser'/.test(GATEWAY) && /browser-result/.test(GATEWAY),
      "interact 回执分流：browser 确认卡与 browser-result 工具结果不混用同一通道");
    ok(/\|nb:' \+ \(noBrowserOn \? '1' : '0'\)/.test(GATEWAY), "runtime key 有 nb: 成分（可见集变了换台运行时，不打爆提示缓存）");
    ok(/env\.MTNODE_NO_BROWSER = '1'/.test(GATEWAY) && /delete env\.MTNODE_NO_BROWSER/.test(GATEWAY),
      "整档闸经 spawn env 下达（空值显式 delete，避免脏值传染）");
    ok(/summarizeToolArgs/.test(GATEWAY) && /summarizeToolOutput/.test(GATEWAY),
      "shell / 文件类工具也进活动流（调用摘要 + 结果摘要）");
    ok(/password\|passwd\|secret\|token/.test(GATEWAY), "摘要对凭据类入参只记长度（密钥不进活动流正文）");
    ok(/活动流[\s\S]{0,200}不进模型上下文/.test(GATEWAY), "留痕口径写明：只进活动流与落库，不进模型上下文");
  }

  /* ============ [4] 运行时插件 ============ */
  console.log("\n[4] 运行时插件（browser-plugin.mjs）");
  {
    const names = [
      "browser_launch", "browser_snapshot", "browser_navigate", "browser_click", "browser_type",
      "browser_key", "browser_eval", "browser_wait", "browser_screenshot", "browser_tabs",
      "browser_network", "browser_help", "browser_release",
    ];
    for (const n of names) ok(new RegExp("name: '" + n + "'").test(PLUGIN), "注册了 " + n);
    ok((PLUGIN.match(/name: 'browser_/g) || []).length === 13, "browser_* 工具恰好 13 个（工具面 = 核心 + 常用扩展）");
    ok(/MTNODE_PURE/.test(PLUGIN) && /MTNODE_NO_BROWSER/.test(PLUGIN), "整档闸：纯净模式与「节点 / 未授权环节」整只不注册");
    ok(/hiddenToolsFromEnv\(\)/.test(PLUGIN), "按名字裁剪同源 tool-visibility.mjs（工具许可被拒时整族不注册）");
    ok(/exec\.agent\.id/.test(PLUGIN), "浏览器帧盖发起轮的章（agent.id = session id，归属不明一律 abort）");
    ok(/browser_help/.test(PLUGIN) && /kind:\s*\{[\s\S]{0,120}'login'/.test(PLUGIN),
      "browser_help 是模型侧求助入口（login / verify / choice / blocked / danger）");
    ok(/NEVER type passwords|绝不|不要输入密码/i.test(PLUGIN), "type 工具描述明文禁止代填凭据（密码由用户亲自输入）");
    ok(/只回结构化页面摘要，截图按需|browser_snapshot is enough/.test(PLUGIN), "模型所见口径写进工具描述：摘要为主、截图按需");
    /* defineTool 契约：output 必填（缺了它 defineTool 在 options.output.render 上抛
       TypeError → 插件整只装载失败 → 运行时 plugin tree 起不来 → 每一轮会话都回
       「cannot create effect on inactive context」，AI 会话整体不可用）。这条钉住
       「13 个工具都带 output」，是那次事故的回归口径。 */
    {
      const defs = PLUGIN.split("defineTool({").slice(1);
      const missing = defs.filter((d) => !/output:\s*rpcOutput\(\)/.test(d.split("}))")[0]));
      ok(defs.length === 13 && missing.length === 0,
        "defineTool 契约：13 个工具都带 output（schema + render），缺了整只插件装载失败（会话不可用）");
    }
  }

  /* ============ [5] cordis 组合 + 可见性白名单 ============ */
  console.log("\n[5] cordis 组合与可见集白名单");
  {
    ok(/id: mtnode-browser[\s\S]{0,200}name: '\.\/browser-plugin\.mjs'/.test(CORDIS), "cordis.yml 挂载了 mtnode-browser");
    ok(/id: mtnode-browser[\s\S]{0,260}MTNODE_PURE === '1'/.test(CORDIS),
      "只有 isolate / pure 才整行禁用（节点侧由 MTNODE_NO_BROWSER 走插件注册口，不借口令行）");
    const m = await import(require("url").pathToFileURL(path.join(__dirname, "..", "dsh", "gateway", "tool-visibility.mjs")).href);
    const leaked = ["browser_click", "browser_help"].filter((n) => m.HIDEABLE_TOOLS.indexOf(n) < 0);
    ok(leaked.length === 0, "浏览器工具名在可见集白名单里（被点到也不会被静默丢弃）");
    ok(m.normalizeHiddenTools(["browser_click", "nope", "browser_help"]).join(",") === "browser_click,browser_help",
      "归一：白名单 + 去重 + 字典序（同档每轮逐字相同）");
  }

  /* ============ [6] 活动流留痕库（真落盘） ============ */
  console.log("\n[6] 活动流留痕库（activity-store.js，真库真读写）");
  {
    const store = require(path.join(__dirname, "..", "activity-store.js"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-act-"));
    const r1 = store.push([
      { at: 1000, kind: "navigate", sessionId: "s1", text: "打开 https://example.com" },
      { at: 1001, kind: "bash", sessionId: "s1", text: "npm test", path: "" },
      { kind: "click", sessionId: "s2", text: "点击 立即购买" },
    ], dir);
    ok(r1.ok === true && r1.written === 3, "push 落盘三条（含跨会话）");
    const q1 = store.query({ sessionId: "s1" }, dir);
    ok(q1.ok === true && q1.rows.length === 2 && q1.total === 3, "按会话过滤只回该会话的条目（total 仍是全库）");
    const q2 = store.query({ kind: "click" }, dir);
    ok(q2.rows.length === 1 && q2.rows[0].text.indexOf("立即购买") >= 0, "按类型过滤命中");
    ok(q1.rows[0].at >= q1.rows[1].at, "按时间倒序（新在前）");
    const r2 = store.clear({ sessionId: "s2" }, dir);
    ok(r2.ok === true && r2.removed === 1, "按会话清空");
    ok(store.query({}, dir).total === 2, "清空后库内只剩另一会话的两条");
    const norm = store.normalize({ kind: "bash", text: "x".repeat(900), sessionId: "s" });
    ok(norm.text.length <= 801 && norm.kind === "bash", "归一：正文截断（不给库塞长日志）");
    ok(store.PER_SESSION_CAP > 0 && store.TOTAL_CAP > store.PER_SESSION_CAP, "有每会话与整库两级清理上限");
    ok(!/app\.getAppPath/.test(ACTIVITY) && /activity\.sqlite/.test(ACTIVITY), "库文件固定名 activity.sqlite（由调用方给数据目录，不写应用文件夹）");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ============ [7] 渲染层 ============ */
  console.log("\n[7] 渲染层（侧栏活动流 / 求助卡 / 长时 chip / 自检纪律）");
  {
    ok(/id="agentBrowserChip"/.test(HTML) && /id="baPanel"/.test(HTML) && /id="baResize"/.test(HTML),
      "浏览器活动＝会话主内容右边栏：输入区有 chip 入口 + 自带 DOM 的活动栏（#baPanel / #baResize）");
    ok(!/agentSideTab/.test(HTML), "旧左栏两枚页签已摘掉（会话列表独占左栏，旧界面不变）");
    ok(/id="baPanel"[^>]*hidden/.test(HTML), "活动栏默认 hidden：不被调用或启动时整条不显示");
    /* 本轮需求：原来平铺的「纯净模式」/「自动续跑」两枚 chip 收进「模式」菜单（同「工具」chip） */
    ok(/id="agentModeTrigger"/.test(HTML) && /id="agentModeMenu"/.test(HTML),
      "输入区只有一枚「模式」chip，开关收进 #agentModeMenu（与「工具」菜单同款）");
    ok(!/id="agentPureTrigger"/.test(HTML) && !/id="agentAutoChip"/.test(HTML),
      "旧的两枚平铺 chip（纯净模式 / 自动续跑）已下架，菜单取而代之");
    ok(/agent-chip auto|agent-chip-auto/.test(HTML) === false, "旧自动续跑的专属 chip 样式引用已清掉");
    ok(/app-browser\.js/.test(HTML) && /app-longrun\.js/.test(HTML), "两个新模块都进了加载链");
    ok(/css\/browser\.css/.test(STYLE), "样式聚合入口 @import 了 css/browser.css");
    ok(/openBrowserActivityPanel|BA\.openPanel/.test(APP_BROWSER), "浏览器活动面板有打开入口");
    /* 本轮需求：右边栏不被调用或启动时不予显示 —— 显隐只有 .agent-pane.ba-open 一个
       开关（BA.setOpen），chip 切它；宽度落 --ba-w。缺了任一条就退回「常显占宽度」。 */
    ok(/function \(open, persist\)|BA\.setOpen = function/.test(APP_BROWSER) && /classList\.toggle\("ba-open"/.test(APP_BROWSER)
      && /box\.hidden = !on/.test(APP_BROWSER), "面板显隐唯一口径：.ba-open + hidden（未调用时不显示）");
    ok(/agentBrowserChip/.test(APP_BROWSER) && /BA\.toggle/.test(APP_BROWSER), "输入区 chip 切右边栏显隐");
    ok(/mtnode\.baOpen/.test(APP_BROWSER) && /mtnode\.baW/.test(APP_BROWSER), "显隐与宽度按本机记忆恢复（只在会话视图恢复）");
    ok(/MutationObserver/.test(APP_BROWSER) && /agentPane/.test(APP_BROWSER), "视图切进 / 切出走 #agentPane display 同步（画布 / 团队视图不显示）");
    ok(/dshBrowser/.test(APP_BROWSER) && /activityPush/.test(APP_BROWSER) && /activityQuery/.test(APP_BROWSER), "面板经桥说话：控制面 + 留痕读写");
    ok(/baOpen/.test(APP_BROWSER) && /打开浏览器/.test(APP_BROWSER), "面板上有「打开浏览器」入口（可先手动登录）");
    ok(/baTakeover/.test(APP_BROWSER) && /toggleTakeover/.test(APP_BROWSER), "面板上有接管 / 交还");
    ok(/openPolicy|baPolicy/.test(APP_BROWSER) && /approveDangerous/.test(APP_BROWSER), "名单与危险动作审批可在面板编辑");
    ok(/KIND_GROUP/.test(APP_BROWSER) && /GROUP_LABEL/.test(APP_BROWSER) && /g-browser/.test(CSS) && /g-shell/.test(CSS) && /g-file/.test(CSS),
      "活动流分类着色：浏览器 / 命令 / 文件一眼区分（源码分组 + 样式三色）");
    ok(/dshOnActivity/.test(APP_BROWSER) && /dshOnActivity/.test(PRELOAD), "活动流走全局事件订阅（reqId 空通道，preload 侧同源）");
    ok(/ix-browser-help/.test(APP_DB) && /ixAnswerBrowser/.test(APP_DB), "求助 / 确认卡有专属渲染与回执出口");
    ok(/msg\.type === "browser"/.test(APP_DB), "会话事件分发认得 browser 帧");
    ok(/kind: "browser"/.test(APP_DB), "回执按 kind:'browser' 回传（与 canvas / tool 同一条交互通道）");
    ok(/window\.LongRun\.afterRound/.test(APP_ASSIST), "轮末钩子接进会话收尾（自动续跑入口）");
    ok(/SELF_CHECK_DISCIPLINE/.test(APP_ASSIST) && /分阶段/.test(APP_ASSIST) && /交付前/.test(APP_ASSIST),
      "自检纪律进系统提示（分阶段 + 交付前全检）");
    ok(/关键结论必须带证据/.test(APP_ASSIST) && /不要把它当定稿/.test(APP_ASSIST),
      "自检口径：先自行修复并重跑，关键结论必须带证据");
    ok(/长周期任务图/.test(APP_ASSIST), "跨重启的活写明建议提升为长周期任务图");
    ok(/AUTO_CAP = 30/.test(APP_LONGRUN) && /不自动中断|不拦人/.test(APP_LONGRUN + APP_BROWSER),
      "自动续跑有安全上限且口径写明「不自动中断、阀值只累计给你看」");
    ok(/DONE_RE/.test(APP_LONGRUN) && /todosOpen/.test(APP_LONGRUN), "自检判停：完成信号 + 清单收口两条判据");
    ok(/agentSessionSend/.test(APP_LONGRUN) && /自检判停/.test(APP_LONGRUN), "续跑发的是「自检 + 续跑」指令（先自查再决定继续还是收工）");
    ok(/不自动中断/.test(APP_LONGRUN) || /不拦人/.test(APP_LONGRUN), "长时口径：不弹卡、不自动中断（用户自己盯）");
    ok(/canvasFreeOn/.test(APP_DB) && /noBrowser: \(nodeLock \|\| canvasFreeOn\) && !pureOn/.test(APP_DB.replace(/\s+/g, " ")),
      "宿主按运行算 noBrowser（节点 / 与画布无关整档不注册）");
    ok(/MTNODE_NO_BROWSER/.test(APP_NODES) || /noBrowser/.test(APP_DB), "浏览器工具可用范围在宿主侧有唯一判据");
    for (const k of ["浏览器活动", "自动续跑", "打开浏览器", "接管", "拦截名单", "浏览器需要你帮忙", "收起浏览器活动栏", "拖动分界线调整活动栏宽度（整条边界都可拖）", "拖动边框中部调整活动栏宽度", "自动续跑：本轮完成且目标未达成、还有下一步时自动接着跑（不打断你，随时可关）"]) {
      ok(I18N.indexOf('"' + k + '"') > 0, "i18n 有词条：" + k);
    }
    /* 真跑一次 I18n：切到 en 后新词条必须回英文（键在表里不等于调得对 ——
       本文件是 UMD，导出的是 { t, setLocale, ... }，不是「键 → 值」的平表）。 */
    try {
      const I = require(path.join(__dirname, "..", "renderer", "i18n.js"));
      I.setLocale("en");
      const probe = ["浏览器活动", "自动续跑", "允许这一次", "浏览器需要你帮忙", "拦截名单", "会话在浏览器上需要你帮忙（点「浏览器活动」右边栏查看）", "停止跟随", "跟随最新", "已停止跟随：往上翻旧记录不会被拽回底部；点一下恢复跟随最新"];
      const miss = probe.filter((k) => {
        const en = I.t(k);
        return !en || en === k;
      });
      ok(miss.length === 0, "i18n(en) 真跑：新词条都回英文" + (miss.length ? "（缺：" + miss.join(",") + "）" : ""));
      /* 「模式」菜单（本轮需求）的词条成对 + 真跑：chip 摘要与菜单说明都得回英文；
         本次需求把原四档「工作步骤展示」在会话里收回成一枚「显示思考」开关
         （点开 = 会话里出现思考，关闭 = 整条不显示） */
      const modeKeys = ["模式", "以上开关都只作用于当前会话，随时可改", "模式：", "（开）", "（关）", "显示思考", "关闭后这条会话里整条不显示模型的思考（不是折叠，是真的不出现）；思考内容仍随消息存档，随时可再打开"];
      const modeMiss = modeKeys.filter((k) => I18N.indexOf('"' + k + '"') < 0);
      ok(modeMiss.length === 0, "「模式」菜单词条在表里" + (modeMiss.length ? "（缺：" + modeMiss.join(",") + "）" : ""));
      const modeEnMiss = modeKeys.filter((k) => { const en = I.t(k); return !en || en === k; });
      ok(modeEnMiss.length === 0, "i18n(en) 真跑：模式菜单词条都回英文" + (modeEnMiss.length ? "（缺：" + modeEnMiss.join(",") + "）" : ""));

    } catch (e) {
      ok(false, "i18n(en) 真跑失败：" + ((e && e.message) || e));
    }
    ok(/body\.theme-light/.test(CSS), "样式有亮色主题覆盖");
    ok(/\.ba-col/.test(CSS) && /\.ba-row\.g-browser/.test(CSS) && /\.ix-help-msg/.test(CSS), "样式分片齐备（右边栏面板 / 分类行 / 求助卡正文）");
    ok(/\.agent-pane\.ba-open/.test(CSS) && /var\(--ba-w/.test(CSS),
      "面板宽度走 --ba-w（.agent-pane.ba-open 才开第三栏），关着不占宽度");
    /* 分界线整条可拖：命中区铺满栏高（top/bottom 0）+ 常态可见竖筋；不再有中间加宽把手。 */
    const baResizeCss = CSS.slice(CSS.indexOf(".ba-resize {"), CSS.indexOf(".ba-resize:hover"));
    ok(/top:\s*0;/.test(baResizeCss) && /bottom:\s*0;/.test(baResizeCss) &&
      /cursor:\s*col-resize;/.test(baResizeCss) && /background-size:\s*1px 100%;/.test(baResizeCss),
      "css：右栏分界线整条可拖（top/bottom 0 铺满栏高 + 常态 1px 竖筋 + col-resize）");
    ok(baResizeCss.indexOf("transform: translateY(-50%)") < 0 && baResizeCss.indexOf("height: 56px") < 0,
      "css：右栏分界线取消了中间那段加宽把手（不再居中 + 定高）");
    ok(CSS.indexOf(".ba-resize::after") < 0, "css：右栏分界线的把手装饰已删（不加宽成一个块）");
    const sidCss = read("renderer/css/dsh.css"), asstCss = read("renderer/css/assist.css"), appsCss = read("renderer/css/apps.css");
    const fullHeight = (css, sel) => {
      const seg = css.slice(css.indexOf(sel + " {"), css.indexOf(sel + ":hover"));
      return /top:\s*0;/.test(seg) && /bottom:\s*0;/.test(seg) && /cursor:\s*col-resize;/.test(seg);
    };
    ok(fullHeight(sidCss, ".agent-side-resize") && fullHeight(asstCss, ".assist-resize") && fullHeight(appsCss, ".apps-dev-resize"),
      "css：会话左栏 / 助手栏 / 开发页三栏的分界线同样整条铺满栏高（全站一个口径）");
    ok(sidCss.indexOf(".agent-side-resize::after") < 0 && asstCss.indexOf(".assist-resize::after") < 0 &&
      appsCss.indexOf(".apps-dev-resize::after") < 0,
      "css：四处分界线的加宽把手装饰全部删除（只留一条可见的线）");
    /* 亮色主题的常态竖筋必须限定在 :not(:hover):not(.dragging)：
       它的特异性高于各文件的 .x:hover，不加限定会把 hover / 拖动时的整条加亮也压成灰色，
       白底上就看不出「这条能被拖」。 */
    const lightCss = read("renderer/css/theme-light.css");
    const lightSeg = lightCss.slice(lightCss.indexOf("body.theme-light .agent-side-resize"));
    const lightBlock = lightSeg.slice(0, lightSeg.indexOf("}") + 1);
    ok(/(agent-side-resize|assist-resize|ba-resize|apps-dev-resize):not\(:hover\):not\(\.dragging\)/.test(lightBlock),
      "css：亮色主题的常态竖筋限定在非 hover / 非 dragging，不压掉整条加亮（否则看不出能拖）");
    /* 「右栏拖不动」的真凶：视图观察器挂在 #agentPane 的 style 属性上，而拖分界线改的
       正是同一个属性 —— 回调不带限定就会走 setOpen → applyWidth(记忆宽度)，把刚拖出来的
       宽度按回去（真机实测：拖 360/380/400 全在同一帧内被改回 340）。这里钉住「只认
       display 变化」这一条；行为侧由 test/smoke-side-divider-drag.js [5][6] 真按指针事件钉住。 */
    ok(/const disp = pane\.style\.display;[\s\S]{0,150}if \(disp === lastDisplay\) return;/.test(APP_BROWSER),
      "app-browser：视图观察器只认 display 变化，写 --ba-w 不再触发显隐 / 宽度重算（右栏可拖的前提）");
    /* 提示条只报信，容器不吃指针事件：#toastBox 的 z-index 压过分界线，
       它一旦吃掉事件，右下角那条线在弹提示的那几秒里就按不住。 */
    const compCss = read("renderer/css/components.css");
    const toastSeg = compCss.slice(compCss.indexOf("#toastBox {"), compCss.indexOf(".toast {"));
    ok(/pointer-events:\s*none/.test(toastSeg),
      "css：#toastBox 不吃指针事件（浮层不顶掉四条分界线的命中区）");
    /* 活动列表的「跟随最新 / 停止跟随」：一直把列表拽回最新是最烦的（用户正在核上文）。
       行为侧由 test/smoke-ba-follow.js 真按真滚钉住，这里钉接线与落盘口径。 */
    ok(/id="baFollow"/.test(HTML), "面板底部有「跟随最新」开关（键面由 JS 画，不挂 data-i18n）");
    ok(/follow\.onclick = \(\) => BA\.toggleFollow\(\)/.test(APP_BROWSER), "开关接线到 BA.toggleFollow");
    ok(/BA\.setFollow = function \(on, persist\)/.test(APP_BROWSER) && /mtnode\.baFollow/.test(APP_BROWSER),
      "跟随状态可设可存（localStorage mtnode.baFollow，与右栏显隐 / 宽度同口径）");
    ok(/list\.scrollTop = BA\.follow \? list\.scrollHeight : Math\.min\(keepTop, list\.scrollHeight\)/.test(APP_BROWSER),
      "重画口径：跟随中停最新，停了跟随回原来的位置（不再把视线拽回底部）");
    ok(/atBottom !== BA\.follow/.test(APP_BROWSER), "手动往上翻自动停跟随、滚回底部自动恢复（不用先找开关）");
    ok(/BrowserAct\.repaintChrome/.test(read("renderer/app-boot.js")), "切界面语言时重画本面板 JS 画的键面文字");
    ok(/\.ba-foot \.mini\.on/.test(CSS), "跟随键亮起来有对应样式（.ba-foot .mini.on）");
  }

  /* ============ [7b] 文档与指南（中英成对 + 目录登记） ============ */
  console.log("\n[7b] 文档与指南（手册 / 节点指南 / 设计文档）");
  {
    const MAN_ZH = read("guides/manual/agent-browser.md");
    const MAN_EN = read("guides/manual/en/agent-browser.md");
    ok(/会话的浏览器能力|打开浏览器/.test(MAN_ZH) && /浏览器活动/.test(MAN_ZH), "应用内手册中文页讲清侧栏「浏览器活动」与「打开浏览器」");
    ok(/\["browser"|"agent-browser"|browser/.test(JSON.stringify(require(path.join(__dirname, "..", "guides", "manual", "index.json")))), "手册目录登记了 agent-browser 页");
    ok(/Browser activity/.test(MAN_EN) && /Auto-continue/.test(MAN_EN), "英文手册页同步（Browser activity / Auto-continue）");
    ok(/agent-browser/.test(read("guides/manual/_write.mjs")), "手册生成器 _write.mjs 的 id 清单含 agent-browser（再生成不会被盖回）");
    const NODE_ZH = read("guides/nodes/browser.md");
    const NODE_EN = read("guides/nodes/en/browser.md");
    ok(/browser_snapshot/.test(NODE_ZH) && /browser_help/.test(NODE_ZH), "节点指南列出工具族与关键工具");
    ok(/browser_snapshot/.test(NODE_EN) && /session only|sessions only/.test(NODE_EN), "节点指南英文页同步（含「仅会话」口径）");
    ok(/browser/.test(JSON.stringify(require(path.join(__dirname, "..", "guides", "nodes", "index.json")))), "节点指南目录登记了 browser 篇");
    const DOC = read("docs/agent-browser.md");
    ok(/仅会话可用/.test(DOC) && /活动流不进模型上下文/.test(DOC) && /不自动中断/.test(DOC),
      "设计文档写明三条前提（仅会话 / 留痕不进上下文 / 不自动中断）");
    ok(/新增帧类型 `browser`/.test(DOC) && /MTNODE_NO_BROWSER/.test(DOC), "设计文档写明帧类型与整档闸下达方式");
    ok(/smoke-browser\.js/.test(DOC), "设计文档指向本冒烟测试");
  }

  /* ============ [8] 实况流与「独立窗口 / 收回」（默认 dock 在会话右边栏） ============ */
  console.log("\n[8] 实况流与 dock / 独立窗口（默认右栏、未被调用不显示）");
  {
    /* 网关侧：实况流、输入转发、窗口形态 */
    ok(/export function registerViewSink\(/.test(HOST), "实况帧走内存回调（registerViewSink）");
    ok(!/activitySink\(.*frame|frame.*activitySink/.test(HOST), "帧不投活动流（那条路只给摘要留痕）");
    ok(/Page\.startScreencast/.test(HOST) && /Page\.screencastFrameAck/.test(HOST), "实况画面走 CDP screencast + ack 流控");
    ok(/VIEW_MIN_INTERVAL_MS/.test(HOST) && /tooSoon/.test(HOST), "帧率上限：过密的帧只 ack 不投（中间帧丢、末帧必达）");
    ok(/export async function viewInput\(/.test(HOST)
      && /Input\.dispatchMouseEvent/.test(HOST)
      && /Input\.dispatchKeyEvent/.test(HOST)
      && /Input\.insertText/.test(HOST),
      "输入转发：鼠标 / 滚轮 / 键盘 / IME 文本四条齐备");
    ok(/export async function setViewMode\(/.test(HOST) && /Browser\.setWindowBounds/.test(HOST),
      "窗口形态走 Browser.setWindowBounds（docked 移出可视区 / detached 恢复）");
    ok(/VIEW_OFFSCREEN_BOUNDS/.test(HOST) && /VIEW_FALLBACK_BOUNDS/.test(HOST) && /看门狗/.test(HOST),
      "离屏不出帧的兜底：看门狗回落 + 状态里标出兜底模式");
    /* 本轮修：启用浏览器 = 内部界面（不再另开一个新窗口） */
    ok(/export async function parkSessionWindow\(/.test(HOST) && /state\.viewParked = !!okOff/.test(HOST),
      "宿主有 parkSessionWindow（会话启用浏览器即把真实窗口移出可视区 = 内部界面）");
    ok(/export async function detachWindow\(/.test(HOST) && /isAtParkingSpot\(after\)/.test(HOST),
      "detachWindow 兜住「窗口还在 -2400,-2400 看不见」：位姿没还原就不算成功");
    ok(/state\.viewMode = 'docked'\s*\n\s*state\.viewParked = !!okOff/.test(HOST) || /viewMode = 'docked'/.test(HOST),
      "形态默认 docked（独立窗口只是本次运行里的显式例外）");
    ok(!/bringToFront\(\)/.test(GATEWAY.split("kind === 'login'")[1] ? GATEWAY.split("kind === 'login'")[1].slice(0, 400) : ""),
      "登录求助不再把真窗口抬到前台（接管也走内部界面）");
    {
      const launchBranch = GATEWAY.split("if (op === 'launch')")[1] || "";
      ok(/parkSessionWindow\(\)/.test(launchBranch.slice(0, 1200)),
        "会话 launch 分支紧接着停靠真实窗口（少了它就有窗口戳在屏幕上）");
      ok(/mode !== 'detached'/.test(launchBranch.slice(0, 1200)),
        "用户亲手点过的「独立窗口」不被 launch 顶掉（那条是本次运行的例外）");
    }
    {
      const vs = GATEWAY.split("async viewStart(params)")[1] || "";
      ok(/mode !== 'detached'/.test(vs.slice(0, 1600)),
        "viewStart 只在不是「独立窗口」时才把窗口搬回右栏（否则那个按钮等于点不动）");
    }
    ok(/disable-backgrounding-occluded-windows/.test(HOST) && /CalculateNativeWinOcclusion/.test(HOST),
      "启动参数让离屏窗口照常出帧（否则 docked 永远等不到帧）");
    /* 本轮修：会话自动拉起的浏览器**不带窗口**（开发 / 会话过程中屏幕上不该弹真窗口），
       只有用户亲手点面板上的「打开浏览器」那一次才是带窗口的一只。
       历史 bug：靠 parkSessionWindow 搬窗口，机器上离屏不出帧时 1.5s 看门狗又把窗口搬回屏幕。 */
    {
      ok(/--headless=new/.test(HOST) && /function launchArgs\(exe, profileDir, port, headless\)/.test(HOST),
        "启动参数按窗口模式分支：无窗口（headless）那只走 --headless=new");
      ok(/windowsHide: true/.test(HOST), "spawn 一律 windowsHide（无窗口那只绝不闪窗体）");
      ok(/export async function ensureBrowser\(opts\)[\s\S]{0,2600}const headless = !wantVisible/.test(HOST)
        && /if \(wantVisible && state\.headless\) await stopBrowser/.test(HOST),
        "ensureBrowser 认 visible：缺省无窗口；要带窗口而当前是无窗口那只时重起一只");
      ok(/headless: !!state\.headless/.test(HOST) && /if \(state\.headless\) \{[\s\S]{0,400}viewParked = true/.test(HOST),
        "viewStatus 带 headless；无窗口那只的 parkSessionWindow 直接算已让位（不读位姿、不标 fallback）");
      ok(/这只是无窗口（后台）浏览器/.test(HOST), "detachWindow 对无窗口那只给可执行的说法（点「打开浏览器」看真窗口）");
      const launchBranch2 = GATEWAY.split("if (op === 'launch')")[1] || "";
      ok(/visible: !!params\.visible/.test(launchBranch2.slice(0, 1600)),
        "网关 launch 分支按 visible 传给宿主（浏览器工具不传 = 无窗口）");
      ok(/async open\(opts\)[\s\S]{0,600}visible: wantVisible/.test(GATEWAY)
        && /visible: p\.visible !== false/.test(GATEWAY),
        "面板「打开浏览器」= 唯一带窗口的入口（visible 缺省 true）");
      ok(/BA\.headless/.test(APP_BROWSER) && /btn\.hidden = !BA\.running \|\| !!BA\.headless/.test(APP_BROWSER),
        "渲染层跟随 headless：无窗口那只收起「独立窗口」按钮");
      ok(/visible: true/.test(APP_BROWSER) && /T\("无窗口运行"\)/.test(APP_BROWSER),
        "面板「打开浏览器」显式要带窗口的一只，实况区文案切「无窗口运行」");
      ok(/无窗口运行/.test(I18N)
        && /这只是无窗口（后台）浏览器，画面就在这里；想看真窗口请在面板上点「打开浏览器」。/.test(I18N)
        && /这只是无窗口（后台）浏览器，没有可显示的窗口/.test(I18N),
        "无窗口三句词条都在 i18n 里（实况区文案 / 说明 / 按钮 title 才有中英）");
    }
    ok(/export function viewStatus\(/.test(HOST) && /viewMode/.test(HOST) && /fallback/.test(HOST),
      "状态里有 mode / fallback / seq（渲染层据此画文案与按钮）");
    ok(/v\.on = false/.test(HOST) && /Page\.stopScreencast/.test(HOST), "停流会摘订阅 + stopScreencast");
    ok(/state\.view\.sink = typeof fn === 'function'/.test(HOST), "viewSink 只收函数（帧不落任何外部存储）");

    /* 帧通路：网关 → 宿主 → 渲染层（全程不落库、不自动拉起浏览器） */
    ok(/BrowserHost\.registerViewSink/.test(GATEWAY), "网关注册实况帧 sink");
    ok(/'browser-frame'/.test(GATEWAY), "帧事件名 browser-frame（宿主全局通道）");
    ok(/async viewStart\(/.test(GATEWAY) && /async viewStop\(/.test(GATEWAY) && /async viewInput\(/.test(GATEWAY) && /async viewMode\(/.test(GATEWAY),
      "网关控制面有 viewStart / viewStop / viewInput / viewMode");
    ok(/async viewStart\(params\) \{[\s\S]{0,600}statusOf\(\)/.test(GATEWAY) && /![a-zA-Z]*\.running/.test(GATEWAY.split("async viewStart(params)")[1].slice(0, 700)),
      "viewStart 只连「已经在跑」的浏览器：实况自己不把浏览器拉起来");
    ok(!/stream[\s\S]{0,200}activityPush/.test(GATEWAY), "实况帧不经 activityPush（硬约束：绝不落库）");
    ok(/action === 'view'/.test(GATEWAY), "浏览器控制面收 action:'view'（method 区分 start/stop/input/mode）");
    ok(/request\('browser'/.test(DSH) && /browser\(params\)/.test(DSH), "main-dsh 透传既有的 browser 控制面（含 view 方法）");
    ok(/dshBrowserViewStart:/.test(PRELOAD) && /dshBrowserViewStop:/.test(PRELOAD) && /dshBrowserViewInput:/.test(PRELOAD) && /dshBrowserViewMode:/.test(PRELOAD),
      "preload 桥新增四条实况控制面（start / stop / input / mode）");
    ok(/onBrowserFrame:/.test(PRELOAD) && /type !== 'browser-frame'/.test(PRELOAD), "preload 有 onBrowserFrame 订阅（按事件名过滤）");
    ok(/ipcMain\.handle\("dsh:browser"/.test(MAIN) && /\.catch\(\(e\) => \(\{ ok: false, error/.test(MAIN),
      "主进程同一条 dsh:browser 透传并兜底（老网关不认 view 时回错误而不 reject）");

    /* 渲染层：默认 dock、可切独立窗口，且未被调用 / 未启动时整条不显示 */
    ok(/id="baLive"/.test(HTML) && /id="baLiveCanvas"/.test(HTML) && /id="baLiveModeBtn"/.test(HTML) && /id="baLivePause"/.test(HTML),
      "右栏实况区 DOM（画面 + 独立窗口/收回 + 暂停观察）在 index.html 里自带");
    ok(/id="baPanel" hidden/.test(HTML), "面板默认 hidden：没被调用 / 没启动浏览器时整条不显示");
    ok(/BA\.setOpen = function \(open, persist\)[\s\S]{0,700}classList\.toggle\("ba-open", on\)/.test(APP_BROWSER)
      && /if \(box\) box\.hidden = !on;/.test(APP_BROWSER),
      "显隐唯一口径未被破坏（.ba-open + hidden）");
    ok(/export function registerViewSink/.test(HOST) && !/process\.env\.MTNODE_VIEW/.test(HOST), "实况流没有额外的环境开关（只跟面板 / 浏览器状态走）");
    ok(/BA\.liveStart = async function/.test(APP_BROWSER) && /BA\.liveStop = async function/.test(APP_BROWSER), "渲染层有开 / 停流");
    ok(/BA\.liveSync = function[\s\S]{0,600}BA\.isOpen\(\)[\s\S]{0,200}BA\.running[\s\S]{0,120}paused/.test(APP_BROWSER),
      "开流四条件：面板开着 + 会话视图 + 浏览器在跑 + 没暂停");
    /* 本轮修：右栏「被调用即出现」——不自动开的话实况流永远不连，浏览器只能是眼前的独立窗口 */
    ok(/BA\.autoOpenForUse = async function[\s\S]{0,900}BA\.userClosed[\s\S]{0,300}display === "none"[\s\S]{0,700}BA\.running/.test(APP_BROWSER)
      && /BA\.userClosed = !on/.test(APP_BROWSER),
      "会话一用浏览器就自动开右栏（刹车＝用户亲手关过 / 非会话视图 / 浏览器没在跑）");
    const autoKinds = (APP_BROWSER.match(/const AUTO_OPEN_KINDS = \{[\s\S]*?\};/) || [""])[0];
    ok(/isBrowserKind\(kind\)/.test(APP_BROWSER) && /const isBrowserKind = \(k\) => \{[\s\S]{0,180}AUTO_OPEN_KINDS\[s\] \|\| s\.startsWith\("browser"\)/.test(APP_BROWSER) && /browser: 1, navigate: 1/.test(autoKinds) && !/shell|file:/.test(autoKinds),
      "自动开栏只认浏览器类活动（shell / 文件摘要不替用户弹第三栏；判据收口到 isBrowserKind）");
    ok(/BA\.liveSetMode = async function/.test(APP_BROWSER) && !/mtnode\.baViewMode/.test(APP_BROWSER),
      "「独立窗口 / 收回」状态机 + 形态**不落 localStorage**（默认内部界面；独立窗口只是本次运行里的显式例外）");
    ok(/BA\.live\.mode = "docked"/.test(APP_BROWSER) && /await BA\.liveStop\(\)/.test(APP_BROWSER),
      "detached 时不重复解码（停流），浏览器停 / 崩回到 docked 待启动态");
    ok(/BA\.liveInput = function/.test(APP_BROWSER) && /pointerdown|pointermove/.test(APP_BROWSER) && /"wheel"/.test(APP_BROWSER)
      && /addEventListener\("keydown"/.test(APP_BROWSER) && /compositionend/.test(APP_BROWSER),
      "画布上的指针 / 滚轮 / 键盘 / IME 都转发（按 CSS 像素 + 画布显示尺寸）");
    ok(/window\.api\.onBrowserFrame\(BA\.onFrame\)/.test(APP_BROWSER) && /BA\.onFrame = function/.test(APP_BROWSER),
      "帧订阅 + seq 去重（乱序 / 重放的旧帧直接丢）");
    ok(/data-i18n="独立窗口"/.test(HTML) && /id="baLiveModeBtn"[^>]*hidden/.test(HTML) && /id="baLiveModeBtn"/.test(HTML),
      "「独立窗口 / 收回」入口在实况区头部（静态 hidden：浏览器没启动时这枚按钮不出现；文案由 JS 按形态切）");
    ok(/btn\.hidden = !BA\.running/.test(APP_BROWSER),
      "渲染层按真状态显隐这枚按钮：#baLiveModeBtn.hidden = !BA.running（未启动＝不显示）");
    ok(/\.ba-live-stage/.test(CSS) && /\.ba-live-mask/.test(CSS) && /\.ba-live-note/.test(CSS), "实况区样式（画面 / 等待遮罩 / 兜底说明）");
    const pair = ["实况", "独立窗口", "收回", "暂停观察", "等待浏览器画面…", "已在独立窗口"];
    ok(pair.every((k) => I18N.includes('"' + k + '"')), "i18n 新词条齐备：" + pair.join(" / "));
    /* 本轮修：默认内部界面（toast / 失败兜底文案都有中英词条，否则切英文就露中文） */
    ok(I18N.includes('"浏览器已就绪（默认在右栏实况里；想看真窗口点「独立窗口」）"')
      && I18N.includes('"没能把真实窗口摆出来：先在右栏实况里操作，或再点一次。"'),
      "i18n 补上「默认内部界面」两条词条（就绪提示 + detached 没摆出来的兜底提示）");
    /* 本轮修：会话列表上的被动标记（静默处理时用户扫一眼就知道哪条会话在用浏览器） */
    ok(/\.side-sess-ba/.test(require("fs").readFileSync(require("path").join(__dirname, "..", "renderer", "css", "dsh.css"), "utf8"))
      && /BA\.noteBrowserSession/.test(APP_BROWSER)
      && /side-sess-ba/.test(require("fs").readFileSync(require("path").join(__dirname, "..", "renderer", "app-assist.js"), "utf8")),
      "被动标记齐备：CSS .side-sess-ba + BA.noteBrowserSession + app-assist 会话行渲染");
  }

  /* ============ [9] 打包与主进程接线 ============ */
  console.log("\n[9] 打包白名单与主进程接线");
  {
    ok(/"activity-store\.js"/.test(BUILDCONF), "build.json files 收了 activity-store.js（否则打包后 Cannot find module）");
    ok(/require\("\.\/activity-store\.js"\)/.test(MAIN), "main.js require 了活动流留痕库");
    ok(/ipcMain\.handle\("activity:push"/.test(MAIN) && /activity:query/.test(MAIN) && /activity:clear/.test(MAIN),
      "活动流三条 IPC（push / query / clear）");
    ok(/ipcMain\.handle\("dsh:browser"/.test(MAIN), "浏览器控制面 IPC（dsh:browser）");
    ok(/browser\(params\)/.test(DSH) && /request\('browser'/.test(DSH), "网关适配器透传 browser 方法");
    ok(/dshBrowser:/.test(PRELOAD) && /activityPush:/.test(PRELOAD) && /dshOnActivity:/.test(PRELOAD),
      "preload 白名单桥暴露 dshBrowser / activity* / dshOnActivity");
    ok(/activity-store\.js/.test(BUILDCONF) && !/^\s*"\.\/activity-store/.test(BUILDCONF), "白名单条目格式与既有条目一致");
  }

  /* ============ [10] 可选真机集成（默认不跑） ============ */
  console.log("\n[10] 真机集成（默认跳过；MTNODE_BROWSER_SMOKE=1 才跑）");
  if (process.env.MTNODE_BROWSER_SMOKE === "1") {
    try {
      const H = await import(require("url").pathToFileURL(path.join(__dirname, "..", "dsh", "gateway", "browser-host.mjs")).href);
      const exe = H.detectBrowser();
      ok(!!exe, "本机找到可驱动的浏览器" + (exe ? "：" + exe : "（装 Edge / Chrome 后重试）"));
      if (exe) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-brsmoke-"));
        const r = await H.ensureBrowser({ profileDir: path.join(dir, "profile"), timeoutMs: 20000 });
        ok(!!r.port && r.reused === false, "真起浏览器：" + r.port + "（专属 user-data-dir）");
        await H.navigate({ url: "https://example.com", waitMs: 1200 });
        const snap = await H.snapshot({ textLimit: 500 });
        ok(snap.url.indexOf("example.com") >= 0 && snap.title.length > 0, "导航 + 快照拿到标题与 URL：" + snap.title);
        ok(Array.isArray(snap.elements), "快照带可交互元素清单（" + snap.elements.length + " 个）");
        const shot = await H.screenshot({ dir: path.join(dir, "shots") });
        ok(shot.bytes > 1000 && fs.existsSync(shot.path), "截图落盘：" + shot.bytes + " 字节");
        const net = await H.network({ limit: 5 });
        ok(net.requests.length >= 1, "网络留痕有记录（" + net.requests.length + " 条）");

        /* 实况流真机段（MTNODE_BROWSER_VIEW=1 才跑）：出帧 → 输入转发 → dock/detach → 停流。
           帧由本段自己的 sink 数（顺手证明帧只走内存回调）。 */
        if (process.env.MTNODE_BROWSER_VIEW === "1") {
          const frames = [];
          H.registerViewSink((f) => frames.push(f));
          const ANIM = 'data:text/html,<title>view-smoke</title><body style="background:%23223">' +
            '<h1 id=h>hello</h1><script>let i=0;setInterval(function(){document.getElementById("h").textContent="hello "+(++i)},100)</script></body>';
          await H.navigate({ url: ANIM, waitMs: 900 });
          const v0 = await H.startViewStream({ quality: 60, maxWidth: 800, maxHeight: 600 });
          ok(v0.ok === true && v0.on === true, "startViewStream 成功（实况流开）");
          await new Promise((r) => setTimeout(r, 2500));
          const got = frames.filter((f) => f.frame);
          ok(got.length >= 2, "真出帧：" + got.length + " 帧（seq 递增 " + got.slice(0, 6).map((f) => f.seq).join(",") + "…）");
          ok(/^\/9j\//.test(String((got[0] && got[0].frame) || "")), "帧是裸 base64 JPEG（渲染层补 dataURL 后 drawImage）");
          const recent = got.filter((f) => f.at > Date.now() - 1000).length;
          ok(recent <= 14, "帧率受控（最近 1s " + recent + " 帧 ≤ 14）");
          await H.navigate({ url: 'data:text/html,<title>view-input</title><body style="margin:0"><button id=b style="position:absolute;left:0;top:0;width:120px;height:40px" onclick="document.title=%27clicked%27">go</button></body>', waitMs: 700 });
          await H.viewInput({ kind: "mouse", type: "mouseMoved", x: 30, y: 18, w: 1000, h: 700, buttons: 0 });
          await H.viewInput({ kind: "mouse", type: "mousePressed", x: 30, y: 18, w: 1000, h: 700, button: "left", buttons: 1, clickCount: 1 });
          await H.viewInput({ kind: "mouse", type: "mouseReleased", x: 30, y: 18, w: 1000, h: 700, button: "left", buttons: 0, clickCount: 1 });
          await new Promise((r) => setTimeout(r, 600));
          const tt = await H.evaluateJs({ expression: "document.title" });
          ok(String(tt && tt.value) === "clicked", "实况输入真点到页面（面板坐标 → 页面按钮）");
          ok((await H.setViewMode("detached")).mode === "detached", "独立窗口 → 独立窗口形态");
          ok((await H.setViewMode("docked")).mode === "docked", "收回 → 面板形态（真实窗口让位）");
          const n0 = frames.filter((f) => f.frame).length;
          await H.stopViewStream();
          await new Promise((r) => setTimeout(r, 1200));
          const n1 = frames.filter((f) => f.frame).length;
          ok(n1 === n0, "停流后不再有画面帧（" + n0 + " 帧为止；只多一条 stop 状态）");
        }
        await H.stopBrowser({ silent: true });
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* 浏览器进程可能还捏着目录：清不掉不算失败 */ }
        ok(true, "收尾关闭浏览器");
      }
    } catch (e) {
      ok(false, "真机集成失败：" + ((e && e.message) || e));
    }
  } else {
    console.log("  （跳过：本段会真开一个可见浏览器窗口）");
  }

  console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "全部通过：" + checks + " 项"));
})();

/* ==================== 已并入：test/smoke-browser-rail.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-browser-rail.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const SRC = fs.readFileSync(path.join(__dirname, "..", "renderer", "app-browser.js"), "utf8");

  let fails = 0;
  const ok = (cond, msg) => {
    console.log((cond ? "  ok    " : "FAIL  ") + msg);
    if (!cond) fails++;
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /* ── 最小 DOM 桩（只覆盖 app-browser.js 用到的那些）──────────────────────── */
  function mkClassList() {
    const s = new Set();
    return {
      _s: s,
      add: (c) => s.add(c),
      remove: (c) => s.delete(c),
      contains: (c) => s.has(c),
      toggle: (c, on) => {
        if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); return s.has(c); }
        if (on) s.add(c); else s.delete(c);
        return !!on;
      },
    };
  }
  function mkEl(id) {
    /* addEventListener 记下回调：用例要真把事件打进去，看接线有没有生效
       （不再只是「onclick 是个函数」这种表面断言） */
    const on = {};
    return {
      id,
      hidden: false,
      textContent: "",
      innerHTML: "",
      value: "",
      checked: false,
      oninput: null,
      onclick: null,
      onchange: null,
      clientWidth: 1280,
      scrollTop: 0,
      scrollHeight: 0,
      classList: mkClassList(),
      style: { display: "", width: "", setProperty() {}, removeProperty() {} },
      _on: on,
      addEventListener(type, cb) { (on[type] = on[type] || []).push(cb); },
      appendChild() {},
      setAttribute() {},
      getAttribute: () => null,
      focus() {},
      getContext: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 340, height: 620 }),
    };
  }

  const IDS = [
    "agentPane", "agentBrowserChip", "baPanel", "baResize", "baClose", "baOpen", "baStop",
    "baTakeover", "baPolicy", "baRefresh", "baFilter", "baAll", "baClear", "baList",
    "baCount", "baStatus", "baLiveCanvas", "baLivePause", "baLiveModeBtn", "baLiveMode",
    "baLiveNote", "baLiveMask", "baLive",
  ];

  function makeApp(opts) {
    const o = opts || {};
    const els = {};
    for (const id of IDS) els[id] = mkEl(id);
    els.baPanel.hidden = true;

    const store = Object.assign({}, o.storage || {});
    const calls = { viewStart: 0, viewStop: 0, status: 0, viewInput: 0 };
    const state = { running: !!o.running };

    const api = {
      dshBrowser: async (p) => {
        const action = p && p.action;
        if (action === "status") {
          calls.status++;
          return { ok: true, running: state.running, exe: "msedge.exe", port: 9222 };
        }
        return { ok: true, running: state.running };
      },
      dshBrowserViewStart: async () => { calls.viewStart++; return { ok: true, on: true, mode: "docked" }; },
      dshBrowserViewStop: async () => { calls.viewStop++; return { ok: true, on: false }; },
      dshBrowserViewInput: async () => { calls.viewInput++; return { ok: true }; },
      /* viewMode 像真网关一样「回声」请求的形态（真网关回 {ok, mode, parked, ...}）：
         渲染层现在以网关回执为准（没摆出来的 detached 会被回落成 docked），
         假实现恒回 docked 就测不出两个方向。 */
      dshBrowserViewMode: async (m) => {
        const raw = m && typeof m === "object" ? m.mode : m;
        const want = String(raw || "") === "detached" ? "detached" : "docked";
        state.mode = want;
        calls.viewMode = (calls.viewMode || 0) + 1;
        return { ok: true, mode: want, parked: want === "docked", on: state.running };
      },
      activityQuery: async () => ({ ok: true, rows: [], total: 0 }),
      activityPush: async () => ({ ok: true }),
      activityClear: async () => ({ ok: true }),
      dshOnActivity: () => () => {},
      onBrowserFrame: () => () => {},
      dshSteer: async () => ({ ok: true }),
    };

    const win = { api, I18n: { t: (k) => k }, toast: () => {} };
    const observers = [];
    const sb = {
      console,
      setTimeout,
      clearTimeout,
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      },
      MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} },
      Image: class { },
      requestAnimationFrame: (cb) => setTimeout(cb, 0),
      document: {
        readyState: "complete",
        addEventListener() {},
        body: mkEl("body"),
        querySelector: (sel) => (sel && sel[0] === "#" ? els[sel.slice(1)] || null : null),
        querySelectorAll: () => [],
        createElement: (t) => mkEl(t),
      },
    };
    sb.window = win;
    win.document = sb.document;
    /* 「用户正看着哪条会话」的唯一判据（app-assist.js 的 agentViewHas）：
       给了 viewing 才注入 —— 没给的用例走「认不出会话 → 退回旧行为」，与老壳同口径。
       state.viewing 可在用例里改（测切会话）。 */
    if (o.viewing) {
      state.viewing = String(o.viewing);
      sb.agentViewHas = (id) => String(id || "") === state.viewing;
      win.agentViewHas = sb.agentViewHas;
    }
    vm.createContext(sb);
    vm.runInContext(SRC, sb, { filename: "app-browser.js" });
    const BA = win.BrowserAct;
    const act = (kind, text) => { win.browserActivityOnEvent({ kind, text: text || "x" }); };
    return { BA, els, store, calls, state, act, pane: els.agentPane };
  }

  (async () => {
    /* ── [1] 默认不显示 ───────────────────────────────────────────────────── */
    console.log("[1] 默认：没被调用时整条不显示");
    {
      const app = makeApp({ running: false });
      await tick(); await tick();
      const BA = app.BA;
      ok(!!BA, "app-browser.js 在沙箱里装起来了（window.BrowserAct）");
      ok(BA.isOpen() === false && app.els.baPanel.hidden === true && !app.pane.classList.contains("ba-open"),
        "右栏默认收起（hidden + 无 .ba-open，旧两栏界面一字不差）");
      ok(app.calls.viewStart === 0, "没被调用就不开流（不占帧、不占解码成本）");
      ok(app.els.baLiveModeBtn.hidden === true,
        "浏览器没开时「独立窗口」按钮不显示（形态切换只在真有一只在跑的浏览器时才有意义）");
    }

    /* ── [2] 会话一用浏览器 → 右栏出现 + 真开流 ──────────────────────────── */
    console.log("\n[2] 会话一碰浏览器：右栏自动出现并连上实况");
    {
      const app = makeApp({ running: false });
      await tick(); await tick();
      /* 浏览器是被会话刚拉起来的：渲染层手里的状态还是「没在跑」，
         所以自动开栏必须先问一次网关，别拿过期状态当判据 */
      app.state.running = true;
      app.act("browser", "浏览器已启动（Edge）");
      await tick(); await tick(); await tick(); await tick();
      ok(app.calls.status > 0, "自动开栏前先刷新一次浏览器状态（不吃过期状态）");
      ok(app.BA.isOpen() === true && app.els.baPanel.hidden === false && app.pane.classList.contains("ba-open"),
        "右栏自己出现（.ba-open + hidden=false：dock 的前提就是它）");
      ok(app.calls.viewStart === 1, "紧接着真开实况流（viewStart → 网关 dock 真实窗口）"
        + " [viewStart=" + app.calls.viewStart + " on=" + app.BA.live.on + " running=" + app.BA.running
        + " open=" + app.BA.isOpen() + " stop=" + app.calls.viewStop + "]");
      ok(app.store["mtnode.baOpen"] === "1", "显隐照旧落 localStorage（可复核）");
      ok(app.els.baLiveModeBtn.hidden === false,
        "浏览器在跑时「独立窗口」按钮显示出来（文案由 livePaintStatus 按形态切）");
    }

    /* ── [3] 用户亲手关过就不打扰 ─────────────────────────────────────────── */
    console.log("\n[3] 用户亲手关过：本次运行不再自动弹");
    {
      const app = makeApp({ running: true });
      await tick(); await tick();
      app.BA.setOpen(false);              // 等于点 ✕ / 再点一次 chip
      await tick();
      ok(app.BA.userClosed === true, "亲手关＝记下 userClosed");
      app.act("navigate", "打开 https://platform.deepseek.com");
      await tick(); await tick();
      ok(app.BA.isOpen() === false && app.els.baPanel.hidden === true, "后续活动不再自动弹出来");
      ok(app.calls.viewStart === 0, "也没开流");
    }

    /* ── [4] 非浏览器活动不弹 ─────────────────────────────────────────────── */
    console.log("\n[4] shell / 文件摘要不替用户弹第三栏");
    {
      const app = makeApp({ running: true });
      await tick(); await tick();
      app.act("shell", "npm test");
      app.act("file", "写入 E:/tmp/a.md");
      await tick(); await tick();
      ok(app.BA.isOpen() === false, "命令 / 文件类活动不自动开栏（那些不是「浏览器活动」）");
      app.act("browser_launch", "browser_launch · {}");   // 网关的工具类活动行
      await tick(); await tick();
      ok(app.BA.isOpen() === true, "浏览器工具行（browser_*）照旧自动开栏");
    }

    /* ── [5] 非会话视图不弹 ───────────────────────────────────────────────── */
    console.log("\n[5] 非会话视图（画布 / 团队）不弹");
    {
      const app = makeApp({ running: true });
      await tick(); await tick();
      app.pane.style.display = "none";
      app.act("browser", "浏览器已启动（Edge）");
      await tick(); await tick();
      ok(app.BA.isOpen() === false && app.els.baPanel.hidden === true, "不在会话视图就不占宽度（与助手栏同口径）");
    }

    /* ── [6] 浏览器没在跑不弹 ─────────────────────────────────────────────── */
    console.log("\n[6] 浏览器没在跑：不弹、也不顺手拉起");
    {
      const app = makeApp({ running: false });
      await tick(); await tick();
      app.act("browser", "浏览器已启动（Edge）");   // 状态仍是 running:false
      await tick(); await tick();
      ok(app.BA.isOpen() === false, "状态说没在跑就不开栏（开流只连已经在跑的浏览器）");
      ok(app.calls.viewStart === 0, "更不会去拉流");
    }

    /* ── [7] 栏本来就开着，浏览器后来才被拉起 ─────────────────────────────── */
    console.log("\n[7] 栏已经开着（上次没收 / 启动恢复）但流没连：浏览器被拉起就把流补上");
    {
      const app = makeApp({ running: false, storage: { "mtnode.baOpen": "1" } });
      await tick(); await tick();
      ok(app.BA.isOpen() === true, "按记忆恢复：这一栏本来就是开着的");
      ok(app.calls.viewStart === 0, "此刻浏览器还没跑，不硬开流");
      app.state.running = true;
      app.act("browser_launch", "browser_launch · {}");
      await tick(); await tick(); await tick();
      ok(app.calls.viewStart === 1,
        "开着的那条栏把实况流补上（viewStart=1 —— 少了它，窗口就没人 dock）");
    }

    /* ── [8] 「提出来」= 独立窗口，不再被偷偷搬走 ─────────────────────────── */
    console.log("\n[8] 提出来之后不再自动开流，点「收回」才回到右栏实况");
    {
      const app = makeApp({ running: true });
      await tick(); await tick();
      await app.BA.liveSetMode("detached");
      await tick(); await tick();
      ok(app.BA.live.mode === "detached" && app.BA.live.on === false,
        "提出来 = 流停掉（画面就在眼前，不重复解码）");
      const before = app.calls.viewStart;
      app.act("browser_navigate", "browser_navigate · platform.deepseek.com");
      await tick(); await tick(); await tick();
      ok(app.calls.viewStart === before,
        "独立窗口形态下浏览器动作不再自动开流（否则真窗口会被立刻搬回去）");
      await app.BA.liveSetMode("docked");
      await tick(); await tick(); await tick();
      ok(app.calls.viewStart === before + 1, "点「收回」→ 重新开流（画面回右栏、真窗口让位）");
    }

    /* ── [9] 控件引用的 API 真实存在：点下去真把形态切一圈 ────────────────── */
    console.log("\n[9] #baLiveModeBtn 的 onclick 真能切 docked / detached（不是属性在、实现没了）");
    {
      const app = makeApp({ running: true });
      await tick(); await tick();
      const btn = app.els.baLiveModeBtn;
      ok(typeof app.BA.liveToggleMode === "function",
        "BA.liveToggleMode 是函数（控件引用的成员真实存在）");
      ok(!!btn.onclick, "#baLiveModeBtn.onclick 被接上了（bindLive 认得这个 id）");
      ok(app.BA.live.mode === "docked", "实况默认形态 = docked（右栏）");
      /* 点下去要等一拍：BA.liveSetMode 是 async（先 viewMode 再改形态），
         不等就把「同步刻还没变」误判成按钮空转 */
      let threw = "";
      try { await btn.onclick(); } catch (err) { threw = String((err && err.message) || err); }
      await tick();
      ok(!threw && app.BA.live.mode === "detached",
        "点一下 → detached（真调到了 BA 的实现，不是空转）"
        + " [mode=" + app.BA.live.mode + (threw ? " threw=" + threw : "") + "]");
      try { await btn.onclick(); } catch (_) {}
      await tick();
      ok(app.BA.live.mode === "docked",
        "再点一下 → 切回来 docked（两个方向都通，不是单向假按钮）");
    }

    /* ── [10] 静态扫描：每个 BA.<name> 引用都必须在 BA 上真实存在 ─────────── */
    console.log("\n[10] 扫全文件的 BA.<name>：引用了不存在的 BA API 就红灯");
    {
      const app = makeApp({ running: false });
      await tick(); await tick();
      const BA = app.BA;
      /* 白名单 = BA 上的数据字段 / 容器（不是 API），只放行这些；
         其余引用一律要求「在 BA 上真实存在」，函数类引用还要求可调用 */
      const DATA = {
        rows: "object", total: "number", running: "boolean", takeover: "boolean", policy: "object",
        sessionId: "string", browserSessions: "object", dbBrowserSession: "string", driver: "string",
        userChoice: "object", open: "boolean", userClosed: "boolean", userOpened: "boolean",
        autoOpenBusy: "boolean", filter: "string", follow: "boolean", w: "number", live: "object",
        _sideMarked: "object",
      };
      const names = new Set();
      const re = /\bBA\.([A-Za-z_$][\w$]*)/g;
      let m;
      while ((m = re.exec(SRC))) names.add(m[1]);

      const typed = new Set();
      const missing = [];
      const badType = [];
      for (const n of names) {
        // hasOwnProperty 不用 in：别让 Object.prototype 上的名字（constructor…）混过去
        const has = Object.prototype.hasOwnProperty.call(BA, n);
        if (!has) { missing.push(n); continue; }
        const want = DATA[n];
        if (!want) continue;
        typed.add(n);
        const got = typeof BA[n];
        if (got !== want) badType.push(n + "=" + got + "≠" + want);
      }
      ok(names.size >= 40, "扫到 " + names.size + " 个 BA.<name> 引用（覆盖实况 / 会话 / 活动流各面）");
      ok(missing.length === 0,
        "每个被引用的 BA API 都真实存在（引用了不存在的 BA API = 红灯）"
        + (missing.length ? " [缺: " + missing.join(" ") + "]" : ""));
      ok(badType.length === 0,
        "白名单数据字段类型也对得上（" + typed.size + " 个："
        + [...typed].sort().join(" ") + "）" + (badType.length ? " [不符: " + badType.join(" ") + "]" : ""));
      ok(typeof DATA.liveMode !== "string" && typeof BA.live.mode === "string",
        "白名单不藏私货：它只放行数据字段，函数 / API 类引用一律走「真实存在」这一关");
    }

    /* ── [11] bindLive 抛错隔离：绑过的事实不许被跳过 ─────────────────────── */
    console.log("\n[11] bindLive 里某个控件抛错，也不许跳过「画布已绑定」与后续接线");
    {
      const app = makeApp({ running: true });
      await tick(); await tick();
      /* 实况输入转发的前提是「面板开着 + 流在跑」（liveInput 见 BA.live.on）：这里按
         用户真会点它的情形来 —— 面板开着、浏览器在跑，画布上的滚轮才该送到网关。 */
      app.BA.setOpen(true);
      await tick(); await tick();
      const canvas = app.els.baLiveCanvas;
      ok(canvas._bound === true, "启动接线跑完后 #baLiveCanvas 已盖过章（_bound）");
      const on = canvas._on || {};
      ok(typeof on.pointerdown === "function" || (on.pointerdown || []).length > 0,
        "指针接线在（_bound 之后才挂的画布监听）");
      /* 桩一个会抛错的实现：真机换模型 / 网关卡死时就是这种抛错 */
      app.BA.liveToggleMode = function () { throw new Error("boom-live-toggle"); };
      const btn = app.els.baLiveModeBtn;
      let threw = "";
      try { btn.onclick(); } catch (err) { threw = String((err && err.message) || err); }
      ok(canvas._bound === true,
        "点了会抛错的控件之后，_bound 仍然是 true（绑定事实没有被抛错跳过）"
        + (threw ? " [已隔离: " + threw + "]" : ""));
      let wheelThrew = "";
      const wheel = (on.wheel || [])[0];
      try {
        if (wheel) wheel({ deltaY: 120, clientX: 10, clientY: 10, preventDefault() {}, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, button: 0, buttons: 0 });
      } catch (err) { wheelThrew = String((err && err.message) || err); }
      ok(!!wheel && !wheelThrew, "抛错之后滚轮转发照旧可用（后面的接线没被跳过）");
      ok(app.calls.viewInput > 0, "滚轮真的送到了网关（viewInput 被调 "
        + app.calls.viewInput + " 次，不是只挂了个死回调）");
    }

    /* ── [12] 焦点不在该会话：静默处理（本轮需求）──────────────────────────── */
    console.log("\n[12] 焦点不在该会话：不弹右栏 / 不切界面 / 只留被动标记 + 静默连流");
    {
      /* 沙箱里补上「用户正看着哪条会话」的唯一判据（app-assist.js 的 agentViewHas）：
         本段专门测会话闸，所以它必须存在 —— 认不出会话时 BA.viewing 会回 true（老壳退回旧行为）。 */
      const app = makeApp({ running: true, viewing: "as_a" });
      await tick(); await tick();
      app.BA.setSession("as_a");
      await tick(); await tick();
      ok(app.BA.viewing("as_a") === true && app.BA.viewing("as_b") === false,
        "BA.viewing 真读 agentViewHas（焦点是否在这条会话上）");
      /* ① 焦点在这条会话：照旧自动开栏 */
      app.act("navigate", "打开 https://example.com");
      await tick(); await tick(); await tick();
      ok(app.BA.isOpen() === true, "焦点在这条会话：右栏照旧自己出现");

      /* ② 切到另一条会话（焦点不在它）：它再动浏览器 → 不弹栏、不提示、但画面照常连 */
      const app2 = makeApp({ running: true, viewing: "as_other" });
      await tick(); await tick();
      app2.BA.setSession("as_me");
      await tick(); await tick();
      ok(app2.BA.isOpen() === false, "起点：右栏收着");
      app2.act("navigate", "打开 https://example.com");
      await tick(); await tick(); await tick();
      ok(app2.BA.isOpen() === false && app2.els.baPanel.hidden === true,
        "焦点不在该会话：**不弹右栏**（绝不把用户的界面挪走）");
      ok(app2.calls.viewStart === 1,
        "但把实况画面静默连起来（切过去立刻有画面，不是「连接中…」空窗）[viewStart="
        + app2.calls.viewStart + " on=" + app2.BA.live.on + "]");
      ok(app2.BA._sideMarked.has("as_me"),
        "左栏那条会话上留了被动标记（BA._sideMarked：不抢焦点、不弹提示）");
      ok(!app2.BA._sideMarked.has("as_other"), "别的会话不会被顺手盖章");

      /* ③ 静态口径：静默走的是「只连流」的函数，没碰 setOpen */
      const silent = (SRC.split("BA.silentConnect = function")[1] || "").slice(0, 500);
      ok(!/setOpen|autoOpenForUse/.test(silent),
        "静默连流只开流，不改面板显隐、不递归触发自动开栏");
      ok(/BA\.viewing = function/.test(SRC) && /agentViewHas/.test(SRC),
        "「焦点在不在这条会话」的唯一判据收口到 agentViewHas");
    }

    console.log("\n" + (fails ? "FAILED " + fails : "全部通过"));
    if (fails ? 1 : 0) MERGED_FAILED = true;
  })();

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-browser-rail.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-browser-rail.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);

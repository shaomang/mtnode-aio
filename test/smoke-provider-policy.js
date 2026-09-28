"use strict";
/* 服务商模型策略：白名单 / 黑名单 / 停用 + 请求三档超时 —— 冒烟测试
 *   node test/smoke-provider-policy.js        （或 node test/run-all.mjs provider-policy）
 *
 * 立规（对标 OpenCode 的 provider 配置，三项都是**可选**字段，缺省与现状一字不差）：
 *   · modelAllow  模型白名单：逗号 / 空格分隔的通配模式，**先收窄**（非空时只留命中的模型）
 *   · modelDeny   模型黑名单：同格式，在白名单结果上**再剔除**
 *   · disabled    停用该服务商：不进任何模型选择器，但设置里仍可见 / 可编辑 / 可恢复
 *   · timeoutConnect / timeoutHeader / timeoutChunk  连接 / 首字节 / 分块空闲三档超时，缺省 300000
 * 通配语义：* 零或多个字符、? 一个字符，其余字符按字面量（正则元字符转义）；匹配模型 id，大小写不敏感。
 *
 * 覆盖：
 *   [1] 通配匹配：* / ? / 正则元字符字面量 / 大小写
 *   [2] 白名单收窄 + 黑名单剔除的组合语义 · 空配置返回原列表 · 单模型判据 providerModelAllowed
 *   [3] providerSelectableModels / modelsOfKind：停用与策略两条口径各管一段
 *   [4] deepseekRouteSelectable：官方路由在 DeepSeek 服务商被停用后消失（没配则照旧）
 *   [5] 三档超时的缺省 300000 与显式值优先级（真跑 main.js 里的 timeoutTiersOf）
 *   [6] 三档看门狗真跑：连接 / 首字节 / 分块各自触发，stop() 之后不再触发（定时器不泄漏）
 *   [7] 接线契约（静态）：主进程两处请求都换成三档看门狗 · 渲染层各模型选择器都接了过滤 · 两份
 *       app.js / app-agent.js 的同名函数逐字一致 · i18n 与手册都写上了
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");

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
function EQ(got, want, msg) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(g === w, msg + (g === w ? "" : "\n        实际=" + g + "\n        期望=" + w));
}
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const countOf = (src, re) => (src.match(re) || []).length;

const MK = require("../renderer/app-model-kind.js");
const {
  providerModelFilter,
  providerModelAllowed,
  providerDisabled,
  providerSelectableModels,
  providerTimeoutTiers,
  providerTimeoutSpec,
  modelGlobToRegExp,
  modelPatterns,
  modelMatchesPatterns,
  deepseekRouteSelectable,
  TIMEOUT_DEFAULT_MS,
} = MK;

const MAIN = read("main.js");
const APP = read("renderer/app.js");
const AGENT = read("renderer/app-agent.js");
const SETTINGS = read("renderer/app-settings.js");
const NODES = read("renderer/app-nodes.js");
const ASSIST = read("renderer/app-assist.js");
const CANVAS = read("renderer/app-canvas.js");
const TEAMVIEW = read("renderer/app-teamview.js");
const REVIEW = read("renderer/app-review.js");
const DEVNODE = read("renderer/app-devnode.js");
const KIND = read("renderer/app-model-kind.js");
const I18N = read("renderer/i18n.js");
const MANUAL = read("guides/manual/providers.md");

/* 从源码里切出一个具名函数（真跑用；与其他冒烟同一套做法） */
function fnBody(src, name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) return "";
  let k = src.indexOf("{", m.index);
  let d = 0;
  for (; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") {
      d--;
      if (!d) return src.slice(m.index, k + 1);
    }
  }
  return "";
}

/* ═════════ [1] 通配匹配：* / ? / 正则元字符字面量 ═════════ */
console.log("\n[1] 通配匹配：* 零或多个、? 一个字符、其余按字面量（含正则元字符）");
{
  EQ(modelMatchesPatterns("deepseek-flash", ["deepseek-*"]), true, "* 命中前缀");
  EQ(modelMatchesPatterns("deepseek-", ["deepseek-*"]), true, "* 匹配零个字符");
  EQ(modelMatchesPatterns("deepseek-v4-flash", ["deepseek-*-flash"]), true, "中间 *");
  EQ(modelMatchesPatterns("gpt-4o-mini", ["gpt-4?-mini"]), true, "? 恰好一个字符");
  EQ(modelMatchesPatterns("gpt-400-mini", ["gpt-4?-mini"]), false, "? 不吃两个字符");
  EQ(modelMatchesPatterns("gpt-4-mini", ["gpt-4?-mini"]), false, "? 必须有一个字符");
  EQ(modelMatchesPatterns("anything", ["*"]), true, "单独 * = 全部命中");
  /* 正则元字符按字面量：点是点、加号是加号、括号是括号，不能被当成量词 / 分组 */
  EQ(modelMatchesPatterns("a.b", ["a.b"]), true, "点号字面量命中同形 id");
  EQ(modelMatchesPatterns("axb", ["a.b"]), false, "点号不是「任意字符」");
  EQ(modelMatchesPatterns("gpt-4o", ["gpt-4o+"]), false, "加号按字面量");
  EQ(modelMatchesPatterns("gpt-4o+", ["gpt-4o+"]), true, "加号字面量命中自身");
  EQ(modelMatchesPatterns("a(b)", ["a(b)"]), true, "括号按字面量");
  EQ(modelMatchesPatterns("ab", ["a(b)"]), false, "括号不做分组");
  EQ(modelMatchesPatterns("a|b", ["a|b"]), true, "竖线按字面量");
  EQ(modelMatchesPatterns("a", ["a|b"]), false, "竖线不是「或」");
  EQ(modelMatchesPatterns("x$y", ["x$y"]), true, "美元符按字面量");
  EQ(modelMatchesPatterns("deepseek-flash", ["deepseek-flash$"]), false, "$ 不是行尾锚点");
  EQ(modelMatchesPatterns("model[1]", ["model[1]"]), true, "方括号按字面量");
  EQ(modelMatchesPatterns("m1", ["model[1]"]), false, "方括号不做字符集");
  /* 整体锚定：模式必须整串命中（不是子串包含） */
  EQ(modelMatchesPatterns("xxxdeepseek-flash", ["deepseek-*"]), false, "不是子串包含");
  EQ(modelMatchesPatterns("deepseek-flash-xxx", ["deepseek-flash"]), false, "尾部多余不算命中");
  /* 大小写不敏感 */
  EQ(modelMatchesPatterns("DeepSeek-Flash", ["deepseek-*"]), true, "id 大写也命中");
  EQ(modelMatchesPatterns("deepseek-flash", ["DEEPSEEK-*"]), true, "模式大写也命中");
  EQ(modelMatchesPatterns("GPT-4O-MINI", ["gpt-4o-mini"]), true, "大小写混写");
  /* 空模式 / 空 id 都不算命中（空串绝不能变成「匹配一切」） */
  EQ(modelGlobToRegExp("   "), null, "空模式返回 null");
  EQ(modelMatchesPatterns("", ["*"]), false, "空 id 不算命中");
  EQ(modelMatchesPatterns("a b", ["a b"]), true, "空格也能进模式（分隔符在拆分那一层）");
  /* 模式串拆分：中英逗号 / 分号 / 空白都是分隔符，去重保序 */
  EQ(modelPatterns("a, b  c"), ["a", "b", "c"], "逗号与空格分隔");
  EQ(modelPatterns("a，b；c\nd"), ["a", "b", "c", "d"], "中文逗号 / 分号 / 换行分隔");
  EQ(modelPatterns("a, a, b"), ["a", "b"], "去重保序");
  EQ(modelPatterns(""), [], "空串 = 零条模式");
  EQ(modelPatterns(null), [], "null = 零条模式");
}

/* ═════════ [2] 白名单收窄 + 黑名单剔除 ═════════ */
console.log("\n[2] 白名单先收窄、黑名单再剔除；空配置原样返回");
{
  const models = ["deepseek-flash", "deepseek-v4-pro", "gpt-4o-mini", "gpt-image-2"];
  EQ(providerModelFilter({}, models), models, "两条都留空 = 原列表（老配置行为一字不变）");
  EQ(
    providerModelFilter({ modelAllow: "  ", modelDeny: "" }, models),
    models,
    "空白串 = 不限制",
  );
  EQ(providerModelFilter(null, models), models, "没有服务商对象也原样返回");
  EQ(
    providerModelFilter({ modelAllow: "deepseek-*" }, models),
    ["deepseek-flash", "deepseek-v4-pro"],
    "白名单非空 ⇒ 只留命中的（先收窄）",
  );
  EQ(
    providerModelFilter({ modelDeny: "deepseek-*" }, models),
    ["gpt-4o-mini", "gpt-image-2"],
    "只有黑名单 ⇒ 在全部模型里剔除命中的",
  );
  EQ(
    providerModelFilter({ modelAllow: "deepseek-*", modelDeny: "*-pro" }, models),
    ["deepseek-flash"],
    "两者都有 ⇒ 先收窄再剔除（白名单救不回被黑名单删掉的）",
  );
  EQ(
    providerModelFilter(
      { modelAllow: "gpt-*", modelDeny: "gpt-image-*" },
      models,
    ),
    ["gpt-4o-mini"],
    "白名单收窄到 gpt-*，再剔除图像模型",
  );
  EQ(
    providerModelFilter({ modelDeny: "*" }, models),
    [],
    "黑名单 * = 全剔除（选择器里这家就没有可选模型）",
  );
  EQ(
    providerModelFilter({ modelAllow: "none-*" }, models),
    [],
    "白名单一条不命中 = 空表",
  );
  /* 幂等：过滤结果再过一次同样规则不变（调用点可以放心叠加） */
  const prov = { modelAllow: "deepseek-*,gpt-4o-mini", modelDeny: "*-pro" };
  const once = providerModelFilter(prov, models);
  EQ(providerModelFilter(prov, once), once, "过滤是幂等的");
  /* models 省略时取 prov.models */
  EQ(
    providerModelFilter({ models, modelDeny: "gpt-*" }),
    ["deepseek-flash", "deepseek-v4-pro"],
    "省略第二参数时读 prov.models",
  );
  EQ(providerModelFilter({ models: null, modelDeny: "*" }), [], "没有模型清单 = 空表");
  /* 大小写：白 / 黑名单同样不敏感 */
  EQ(
    providerModelFilter({ modelAllow: "DEEPSEEK-FLASH" }, models),
    ["deepseek-flash"],
    "白名单大小写不敏感",
  );
  EQ(
    providerModelFilter({ modelDeny: "GPT-4O-*" }, models),
    ["deepseek-flash", "deepseek-v4-pro", "gpt-image-2"],
    "黑名单大小写不敏感",
  );
  /* 单个模型判据与整表过滤同源 */
  EQ(providerModelAllowed({}, "anything"), true, "无规则 ⇒ 单模型放行");
  EQ(providerModelAllowed({ modelDeny: "gpt-*" }, "GPT-4o"), false, "单模型判据认黑名单");
  EQ(providerModelAllowed({ modelAllow: "gpt-*" }, "deepseek-flash"), false, "单模型判据认白名单");
  EQ(providerModelAllowed(null, "x"), true, "没有服务商对象 ⇒ 放行");
  /* 原列表不被改动（过滤器不能就地改 prov.models） */
  const keep = models.slice();
  providerModelFilter({ models, modelDeny: "*" }, models);
  EQ(models, keep, "过滤不动原数组");
}

/* ═════════ [3] 停用：选择器口径 与 策略口径 各管一段 ═════════ */
console.log("\n[3] providerDisabled / providerSelectableModels / modelsOfKind");
{
  EQ(providerDisabled({}), false, "没写 disabled = 可用（老配置）");
  EQ(providerDisabled({ disabled: false }), false, "disabled:false = 可用");
  EQ(providerDisabled({ disabled: "true" }), false, "只认布尔 true（字符串不算）");
  EQ(providerDisabled({ disabled: true }), true, "disabled:true = 停用");
  EQ(providerDisabled(null), false, "空对象安全");

  const prov = { models: ["deepseek-flash", "gpt-image-2"], modelAllow: "deepseek-*" };
  EQ(
    providerSelectableModels(prov),
    ["deepseek-flash"],
    "选择器口径 = 白 / 黑名单过滤结果",
  );
  EQ(
    providerSelectableModels(Object.assign({}, prov, { disabled: true })),
    [],
    "停用的服务商 ⇒ 选择器口径空表",
  );
  /* modelsOfKind 只吃策略（白 / 黑名单），不吃停用：停用是「把它收起来」，
     不是「把画布上早就绑着它的节点打断」 */
  EQ(
    MK.modelsOfKind({}, prov, "text"),
    ["deepseek-flash"],
    "modelsOfKind 认白名单",
  );
  EQ(
    MK.modelsOfKind({}, Object.assign({}, prov, { disabled: true }), "text"),
    ["deepseek-flash"],
    "modelsOfKind 不因停用而清空（运行路径不受可见性影响）",
  );
  EQ(
    MK.modelsOfKind({}, Object.assign({}, prov, { modelDeny: "*" }), "image"),
    [],
    "被黑名单剔除的模型连形态表里也没有",
  );
  EQ(MK.modelsOfKind({}, null, "text"), [], "空服务商 = 空表");
}

/* ═════════ [4] DeepSeek 官方路由的停用口径 ═════════ */
console.log("\n[4] deepseekRouteSelectable：官方路由跟着那家 DeepSeek 服务商走");
{
  const ds = (extra) =>
    Object.assign(
      {
        id: "p1",
        type: "text_openai",
        baseUrl: "https://api.deepseek.com/v1",
        models: ["deepseek-flash"],
      },
      extra || {},
    );
  EQ(deepseekRouteSelectable({ providers: [] }), true, "一家都没配 ⇒ 目录兜底路由照旧可选");
  EQ(deepseekRouteSelectable({}), true, "空配置安全");
  EQ(deepseekRouteSelectable({ providers: [ds()] }), true, "配了且没停用 ⇒ 可选");
  EQ(
    deepseekRouteSelectable({ providers: [ds({ disabled: true })] }),
    false,
    "配了但被停用 ⇒ 官方路由一并消失",
  );
  EQ(
    deepseekRouteSelectable({ providers: [ds({ disabled: true }), ds({ id: "p2" })] }),
    true,
    "两家 DeepSeek、还有一家没停用 ⇒ 仍然可选",
  );
  EQ(
    deepseekRouteSelectable({
      providers: [
        { id: "p3", type: "text_openai", baseUrl: "https://api.apiyi.com/v1", models: ["x"] },
      ],
    }),
    true,
    "非 DeepSeek 服务商不影响官方路由",
  );
  EQ(
    deepseekRouteSelectable({
      providers: [ds({ type: "image_openai" })],
    }),
    true,
    "图像类型的 DeepSeek 不算（官方路由只认文本服务商）",
  );
}

/* ═════════ [5] 三档超时：缺省 300000 与显式值优先级 ═════════ */
console.log("\n[5] 三档超时缺省 300000；显式值优先（真跑 main.js 的 timeoutTiersOf）");
{
  EQ(TIMEOUT_DEFAULT_MS, 300000, "渲染层缺省常量 = 300000");
  const t0 = providerTimeoutTiers({});
  EQ(
    [t0.timeoutConnect, t0.timeoutHeader, t0.timeoutChunk],
    [300000, 300000, 300000],
    "什么都不填 ⇒ 三档各自 300000",
  );
  const t1 = providerTimeoutTiers({ timeoutConnect: 15000 });
  EQ(
    [t1.timeoutConnect, t1.timeoutHeader, t1.timeoutChunk],
    [15000, 300000, 300000],
    "只填连接 ⇒ 其余两档仍 300000",
  );
  const t2 = providerTimeoutTiers({
    timeoutConnect: 1000,
    timeoutHeader: 2000,
    timeoutChunk: 3000,
  });
  EQ(
    [t2.timeoutConnect, t2.timeoutHeader, t2.timeoutChunk],
    [1000, 2000, 3000],
    "三档都填 ⇒ 原样生效",
  );
  const t3 = providerTimeoutTiers({ timeoutConnect: 0, timeoutHeader: -5, timeoutChunk: "x" });
  EQ(
    [t3.timeoutConnect, t3.timeoutHeader, t3.timeoutChunk],
    [300000, 300000, 300000],
    "非正数 / 非数字 ⇒ 回到缺省（不是「不设时限」）",
  );
  const t4 = providerTimeoutTiers({ timeoutConnect: 1500.6 });
  EQ(t4.timeoutConnect, 1501, "小数四舍五入成整数毫秒");
  EQ(providerTimeoutTiers(null).timeoutChunk, 300000, "空服务商安全");
  EQ(
    providerTimeoutSpec({ timeoutHeader: 8000 }),
    { timeoutConnect: 300000, timeoutHeader: 8000, timeoutChunk: 300000 },
    "providerTimeoutSpec = 随 spec 下发的那三个字段",
  );

  /* 主进程那一份：切片真跑，验证「spec 优先 > 服务商 > 缺省」的取数顺序 */
  const tiersSrc =
    "const TIMEOUT_DEFAULT_MS = 300000;\n" + fnBody(MAIN, "timeoutTiersOf");
  ok(tiersSrc.indexOf("function timeoutTiersOf") > 0, "main.js 里切得到 timeoutTiersOf");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(tiersSrc + "\nthis.tiers = timeoutTiersOf;", sandbox);
  const T = sandbox.tiers;
  EQ(
    [
      T().connect,
      T(null, undefined).header,
    ],
    [300000, 300000],
    "主进程：无来源 ⇒ 三档 300000",
  );
  const r1 = T({ timeoutConnect: 111 }, { timeoutConnect: 222, timeoutHeader: 333 });
  EQ(
    [r1.connect, r1.header, r1.chunk],
    [111, 333, 300000],
    "spec 显式值优先；spec 没写的那档退到服务商；都没有用缺省",
  );
  const r2 = T({}, { timeoutChunk: 444 });
  EQ([r2.connect, r2.chunk], [300000, 444], "spec 空对象不吃掉服务商的值");
  const r3 = T({ timeoutHeader: 0 }, { timeoutHeader: 555 });
  EQ(r3.header, 555, "spec 写 0（非正）= 不算显式，退到服务商");
  EQ(T({ timeoutConnect: "9000" }).connect, 9000, "数字字符串也认（IPC 过来的可能不是 number）");
}

/* ═════════ [6] 三档看门狗真跑：各档触发 + stop() 不泄漏 ═════════ */
console.log("\n[6] attachRequestWatchdog 真跑：连接 / 首字节 / 分块 各自触发，stop() 后静默");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeReq() {
  const r = new EventEmitter();
  r.destroyedWith = null;
  r.destroy = (e) => {
    r.destroyedWith = e;
    r.emit("error", e);
  };
  return r;
}
(async () => {
  const wdSrc =
    "const TIMEOUT_DEFAULT_MS = 300000;\n" +
    'const TIMEOUT_TIER_LABEL = { connect: "连接超时", header: "首字节超时", chunk: "分块超时" };\n' +
    fnBody(MAIN, "attachRequestWatchdog") +
    "\nthis.attach = attachRequestWatchdog;";
  ok(
    wdSrc.indexOf("function attachRequestWatchdog") > 0,
    "main.js 里切得到 attachRequestWatchdog",
  );
  const box = {};
  vm.createContext(box);
  /* 看门狗只用宿主的时间函数，别的一概不依赖（顺带证明它没偷偷用 Electron 的东西） */
  box.setTimeout = setTimeout;
  box.clearTimeout = clearTimeout;
  vm.runInContext(wdSrc, box);
  const attach = box.attach;

  /* 连接档：只挂上、不推进任何阶段 ⇒ 连接超时 */
  {
    const req = makeReq();
    const fired = [];
    attach(req, { connect: 40, header: 5000, chunk: 5000 }, (l) => fired.push(l));
    await sleep(220);
    EQ(fired, ["连接超时"], "不发 socket 事件 ⇒ 连接档触发");
  }
  /* 首字节档：socket 建连后一直没来响应体 ⇒ 首字节超时 */
  {
    const req = makeReq();
    const fired = [];
    attach(req, { connect: 5000, header: 40, chunk: 5000 }, (l) => fired.push(l));
    const sock = new EventEmitter();
    sock.connecting = true;
    req.emit("socket", sock);
    sock.emit("connect"); /* 建连完成 → 进首字节档 */
    await sleep(220);
    EQ(fired, ["首字节超时"], "建连后不来响应 ⇒ 首字节档触发");
  }
  /* 分块档：来了第一块之后停住 ⇒ 分块空闲超时（每来一块都重置，不会误杀长流） */
  {
    const req = makeReq();
    const fired = [];
    const wd = attach(req, { connect: 5000, header: 5000, chunk: 40 }, (l) =>
      fired.push(l),
    );
    const sock = new EventEmitter();
    sock.connecting = false; /* 复用已连接的 socket：直接进首字节档 */
    req.emit("socket", sock);
    wd.noteData();
    await sleep(30);
    EQ(fired, [], "30ms 内还没到 40ms 的块间空闲 ⇒ 不报错");
    await sleep(200);
    EQ(fired, ["分块超时"], "块与块之间停住 ⇒ 分块档触发");
  }
  /* 每个数据块都重置空闲计时：持续到块就不该超时 */
  {
    const req = makeReq();
    const fired = [];
    const wd = attach(req, { connect: 5000, header: 5000, chunk: 60 }, (l) =>
      fired.push(l),
    );
    const sock = new EventEmitter();
    sock.connecting = false;
    req.emit("socket", sock);
    for (let i = 0; i < 4; i++) {
      wd.noteData();
      await sleep(30);
    }
    EQ(fired, [], "每 30ms 来一块、阈值 60ms ⇒ 一直不超时");
  }
  /* stop()：请求已经收尾 ⇒ 定时器必须清掉，之后一个回调都不能来 */
  {
    const req = makeReq();
    const fired = [];
    attach(req, { connect: 40, header: 40, chunk: 40 }, (l) => fired.push(l)).stop();
    await sleep(220);
    EQ(fired, [], "stop() 之后连接档不再触发");
  }
  {
    const req = makeReq();
    const fired = [];
    const wd = attach(req, { connect: 5000, header: 5000, chunk: 40 }, (l) =>
      fired.push(l),
    );
    const sock = new EventEmitter();
    sock.connecting = false;
    req.emit("socket", sock);
    wd.noteData();
    wd.stop();
    await sleep(200);
    EQ(fired, [], "stop() 之后分块档不再触发");
  }
  /* 触发之后自带 stop：destroy 一次、不会再补第二次回调（同一次请求只报一个错） */
  {
    const req = makeReq();
    const fired = [];
    attach(req, { connect: 40, header: 40, chunk: 40 }, (l) => fired.push(l));
    await sleep(220);
    EQ(fired.length, 1, "同一次请求只报一次超时");
  }

  /* ═════════ [7] 接线契约（静态） ═════════ */
  console.log("\n[7] 接线契约：主进程三档看门狗 · 渲染层过滤调用 · 两份副本一致 · i18n 与手册");
  {
    /* 主进程：三档看门狗定义齐、两个请求路径都换成它，旧的一档 setTimeout 不再留着 */
    HAS(MAIN, "function attachRequestWatchdog", "main.js 定义了三档看门狗");
    HAS(MAIN, "function timeoutTiersOf", "main.js 定义了三档取数");
    HAS(MAIN, "const TIMEOUT_DEFAULT_MS = 300000", "main.js 缺省 300000");
    HAS(MAIN, 'connect: "连接超时"', "主进程报错认「连接超时」这一档");
    HAS(MAIN, 'header: "首字节超时"', "主进程报错认「首字节超时」这一档");
    HAS(MAIN, 'chunk: "分块超时"', "主进程报错认「分块超时」这一档");
    HAS(
      MAIN,
      "I18n.t(\"请求超时（{tier}）\").replace(\"{tier}\", String(tierLabel || \"\"))",
      "超时报错带上是哪一档",
    );
    EQ(
      countOf(MAIN, /attachRequestWatchdog\(/g),
      3,
      "看门狗被调用两次（fetchJson / streamTextChat）+ 定义一次",
    );
    ok(
      !/rq\.setTimeout\(180000/.test(MAIN),
      "streamTextChat 里旧的单档 rq.setTimeout(180000) 已撤",
    );
    ok(
      !/req\.setTimeout\(tmoJson/.test(MAIN),
      "fetchJson 里旧的单档 req.setTimeout(tmoJson) 已撤",
    );
    HAS(MAIN, "const wd = tmoJson", "fetchJson 挂了看门狗（timeoutMs=0 时一个定时器都不挂）");
    HAS(MAIN, "wd = attachRequestWatchdog(rq, tiers", "streamTextChat 挂了看门狗");
    ok(
      countOf(MAIN, /wd\.stop\(\)/g) >= 8,
      "每条出口都 stop()（resolve / reject / error / close / 中止），实际 " +
        countOf(MAIN, /wd\.stop\(\)/g) +
        " 处",
    );
    HAS(MAIN, "req.timeouts = timeoutTiersOf(spec, spec.provider)", "流式 IPC 从 spec 读三档");
    HAS(
      MAIN,
      "const tiers = timeoutTiersOf(req.timeouts, req.provider)",
      "streamTextChat 按 spec > 服务商 > 缺省 取数",
    );
    HAS(MAIN, "const tiers = timeoutTiersOf(", "apiCall 也带上三档");
    ok(
      /abKey,\s*\n\s*tiers,\s*\n\s*\);/.test(MAIN),
      "apiCall 把三档交给 fetchJson",
    );

    /* 渲染层：纯函数都在共享处，且被各处真调用 */
    HAS(KIND, "function providerModelFilter", "app-model-kind.js 提供 providerModelFilter");
    HAS(KIND, "function providerModelAllowed", "…提供 providerModelAllowed");
    HAS(KIND, "function providerDisabled", "…提供 providerDisabled");
    HAS(KIND, "function providerSelectableModels", "…提供 providerSelectableModels");
    HAS(KIND, "function providerTimeoutTiers", "…提供 providerTimeoutTiers");
    HAS(KIND, "function providerTimeoutSpec", "…提供 providerTimeoutSpec");
    HAS(KIND, "function deepseekRouteSelectable", "…提供 deepseekRouteSelectable");
    HAS(KIND, "function modelGlobToRegExp", "…提供通配 → 正则");
    HAS(KIND, "providerSelectableModels,", "…全部导出（其它渲染层文件直接用）");
    HAS(KIND, "providerTimeoutSpec,", "…导出 providerTimeoutSpec");
    HAS(KIND, "providerModelFilter(prov, prov && prov.models)", "modelsOfKind 接了策略过滤");

    HAS(APP, "providerSelectableModels === \"function\"", "app.js 的 dshProvider 接过滤");
    HAS(APP, "if (off && off(p)) continue;", "app.js 的 dshProvider 跳过停用");
    HAS(APP, "const models = pf ? pf(p) : p.models || [];", "app.js 的 mtnodePiProviders 交过滤后的模型");
    HAS(AGENT, "providerSelectableModels === \"function\"", "app-agent.js 同源接过滤");
    HAS(AGENT, "if (off && off(p)) return;", "app-agent.js 的 mtnodePiProviders 跳过停用");
    HAS(APP, "deepseekRouteSelectable(S.config)", "app.js 的官方路由受停用影响");
    HAS(AGENT, "deepseekRouteSelectable(S.config)", "app-agent.js 同源受停用影响");
    HAS(NODES, "pf ? pf(dp, dp.models) : dp.models", "agentModelsForRoute 过滤官方模型");
    ok(
      !/providerDisabled\(p\)\)\s*\n\s*return \[\];/.test(NODES),
      "agentModelsForRoute 不因停用清空（运行路径不受可见性影响）",
    );
    HAS(AGENT, "function agentRouteDisabled", "app-agent.js 有「只是停用」判据");
    HAS(APP, "function agentRouteDisabled", "app.js 同源有「只是停用」判据");
    HAS(AGENT, "if (route && agentRouteDisabled(route)) {", "syncAgentProviderRoute 不因停用换路由");
    HAS(APP, "if (route && agentRouteDisabled(route)) {", "app.js 同源不因停用换路由");
    for (const [src, who] of [
      [AGENT, "app-agent.js"],
      [APP, "app.js"],
    ]) {
      const body = fnBody(src, "visionCandidatesForNode");
      ok(
        body.indexOf("providerDisabled(p)) continue;") > 0 &&
          body.indexOf("deepseekRouteSelectable(S.config)") > 0,
        who + " 的视觉候选表跳过停用服务商 / 停用的官方路由",
      );
    }
    HAS(CANVAS, "const keepDs = dsOk || curProv === \"deepseek-official\";", "节点绑定的停用官方路由留在表里回显");
    HAS(CANVAS, "const boundOff = !!(", "节点绑定的停用服务商留在表里回显");
    HAS(CANVAS, "该服务商已被停用：不再出现在别处的模型选择里", "回显时说明为什么标着「已停用」");
    HAS(DEVNODE, "const out = dsOk ? [\"deepseek-official\"] : [];", "开发节点 Agent 路由表认可 selectable");
    HAS(NODES, "providerTimeoutSpec(spec.provider || {})", "流式调用把三档随 spec 下发");
    HAS(
      APP,
      "typeof providerDisabled === \"function\" && providerDisabled(p)",
      "apiProvidersForKind 跳过停用（节点 / 复核的服务商下拉）",
    );
    HAS(CANVAS, "typeof providerDisabled === \"function\" && providerDisabled(p)", "节点设置的服务商下拉跳过停用");
    HAS(CANVAS, "deepseekRouteSelectable(S.config)", "节点设置的供应商下拉认可 selectable");
    HAS(ASSIST, "deepseekRouteSelectable(S.config)", "全局助手 / 会话菜单的供应商下拉同上");
    HAS(TEAMVIEW, "deepseekRouteSelectable(S.config)", "团队视图的供应商下拉同上");
    HAS(REVIEW, "providerModelFilter(p, all)", "AI 复核的模型下拉接过滤");
    ok(
      countOf(APP + AGENT, /providerSelectableModels === "function"/g) >= 4,
      "两份副本都接了过滤（app.js + app-agent.js）",
    );

    /* 设置页：四个字段都读写，且提示行按需求原文 */
    HAS(SETTINGS, "prov.modelAllow = allowInp.value", "服务商对话框读写信白名单");
    HAS(SETTINGS, "prov.modelDeny = denyInp.value", "服务商对话框读写黑名单");
    HAS(SETTINGS, "prov[key] = Math.round(v)", "服务商对话框写三档超时");
    HAS(SETTINGS, '"连接超时（毫秒）"', "对话框有「连接超时」输入");
    HAS(SETTINGS, '"首字节超时（毫秒）"', "对话框有「首字节超时」输入");
    HAS(SETTINGS, '"分块超时（毫秒）"', "对话框有「分块超时」输入");
    HAS(SETTINGS, 'inp.placeholder = "300000"', "超时输入占位符 300000");
    HAS(SETTINGS, "prov.disabled = true", "对话框可停用该服务商");
    HAS(SETTINGS, 'I18n.t("模型白名单")', "对话框有「模型白名单」字段");
    HAS(SETTINGS, 'I18n.t("模型黑名单")', "对话框有「模型黑名单」字段");
    HAS(SETTINGS, "paintPolicyNote", "过滤结果有实时小结");
    HAS(SETTINGS, 'I18n.t("策略外")', "模型表里标出被策略排除的行");

    /* 两份同名函数必须逐字一致（另一份是运行期生效的那份，漂移过就会「改了没生效」） */
    const norm = (s) => s.replace(/\r\n/g, "\n");
    const A = norm(APP);
    const B = norm(AGENT);
    for (const n of [
      "dshProvider",
      "mtnodePiProviders",
      "agentRouteOptions",
      "agentRouteDisabled",
      "agentRouteGroupsNow",
      "syncAgentProviderRoute",
      "visionCandidatesForNode",
      "agentRouteFromProviderId",
      "defaultAgentProviderRoute",
      "preferredAgentProviderRoute",
      "providerForAgentRoute",
    ]) {
      const a = fnBody(A, n);
      const b = fnBody(B, n);
      ok(a && a === b, "app.js 与 app-agent.js 的 " + n + " 逐字一致");
    }

    /* i18n：中英两份都要有（本文件是「键 = 中文原文」的单字典，中英同源） */
    for (const k of [
      '"模型白名单": "Model allowlist"',
      '"模型黑名单": "Model denylist"',
      '"留空 = 不限制；支持 * 与 ? 通配；白名单先收窄，黑名单再剔除"',
      '"请求超时（{tier}）"',
      '"连接超时": "connect timeout"',
      '"首字节超时": "first-byte timeout"',
      '"分块超时": "chunk timeout"',
      '"停用该服务商": "Disable this provider"',
      '"停用后不出现在模型选择器里（配置与密钥保留）"',
      '"模型白名单": "Model allowlist"',
    ])
      HAS(I18N, k, "i18n 词条：" + k);

    /* 手册：四项能力都要写到 */
    HAS(MANUAL, "白名单", "手册写了白名单");
    HAS(MANUAL, "黑名单", "手册写了黑名单");
    HAS(MANUAL, "停用", "手册写了停用");
    HAS(MANUAL, "超时", "手册写了三档超时");
    HAS(MANUAL, "300000", "手册写了缺省 300000");
  }

  /* ═════════ [8] 持久化：新字段跟着配置走，插件刷新不吃掉它们 ═════════ */
  console.log("\n[8] config-providers：四个新字段写盘 / 读回 / 插件刷新都保留（临时目录，不碰 %APPDATA%）");
  {
    const os = require("os");
    const CP = require("../config-providers.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-prov-policy-"));
    const cfg = path.join(dir, "config.json");
    const prov = {
      id: "p1",
      name: "自建网关",
      type: "text_openai",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      models: ["deepseek-flash", "gpt-4o-mini"],
      modelAllow: "deepseek-*",
      modelDeny: "*-pro",
      timeoutConnect: 5000,
      timeoutHeader: 60000,
      timeoutChunk: 120000,
      disabled: true,
    };
    fs.writeFileSync(cfg, JSON.stringify({ providers: [prov] }, null, 2), "utf8");
    const back = CP.readJson(cfg, null).providers[0];
    EQ(
      [
        back.modelAllow,
        back.modelDeny,
        back.timeoutConnect,
        back.timeoutHeader,
        back.timeoutChunk,
        back.disabled,
      ],
      ["deepseek-*", "*-pro", 5000, 60000, 120000, true],
      "新字段原样读回",
    );
    EQ(
      providerModelFilter(back, back.models),
      ["deepseek-flash"],
      "读回来的配置直接就能过滤",
    );
    /* 插件式刷新（mergeManagedProvider）只补自己的字段，用户填的策略一个字都不能丢 */
    const r = CP.mergeManagedProvider(cfg, {
      id: "p1",
      source: "plug-a",
      baseUrl: "https://api2.example.com/v1",
      models: ["glm-4"],
    });
    ok(r.ok === true, "mergeManagedProvider 正常返回");
    const after = r.providers[0];
    EQ(
      [after.modelAllow, after.modelDeny, after.disabled, after.timeoutChunk],
      ["deepseek-*", "*-pro", true, 120000],
      "插件刷新不丢白 / 黑名单、停用与超时",
    );
    EQ(
      CP.readJson(cfg, null).providers[0].modelDeny,
      "*-pro",
      "磁盘上那一份同样保留",
    );
    /* 老配置（一个字段都没有）读写一遍仍然「什么都不填」 */
    const old = {
      id: "p2",
      name: "老配置",
      type: "text_openai",
      baseUrl: "https://a/v1",
      apiKey: "k",
      models: ["m1"],
    };
    fs.writeFileSync(cfg, JSON.stringify({ providers: [old] }, null, 2), "utf8");
    const oldBack = CP.readJson(cfg, null).providers[0];
    EQ(providerModelFilter(oldBack, oldBack.models), ["m1"], "老配置 ⇒ 原列表（行为一字不变）");
    EQ(providerDisabled(oldBack), false, "老配置 ⇒ 不算停用");
    EQ(
      providerTimeoutTiers(oldBack).timeoutConnect,
      300000,
      "老配置 ⇒ 三档超时都走缺省 300000",
    );
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  console.log(
    "\n" + (fails ? "FAILED " : "PASS ") + (checks - fails) + "/" + checks + " 项检查",
  );
  process.exitCode = fails ? 1 : 0;
})();
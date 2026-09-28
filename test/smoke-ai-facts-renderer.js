"use strict";
/* AI 事实库 · 渲染层（app-ai-facts.js）—— 冒烟测试（纯 Node，无 Electron / 无真实 DOM）
 *   node test/smoke-ai-facts-renderer.js
 * 需求：Agent 建项目架构 / 建工作流时把关键结论沉淀成「极简条例」，落盘到每张画布一份的
 *       AI 事实库（固定路径 <画布文件夹>\团队事实库\AI\ai-facts.json），检索走工具 mtnode_facts，
 *       命中计数决定常被索引的留下、不重要的在超上限时被淘汰；画布删除后在同一工作目录重建
 *       能立刻载入；用户可在专家团左栏点开弹窗查阅 / 编辑。
 * 说明：主进程侧那套（ai-facts-store.js 的固定路径 + 落盘守卫）由 test/smoke-ai-facts.js 覆盖，
 *       本文件只锁渲染层这一条链路（本模块用 window.api 的通用文件桥读写同一份文件）。
 * 覆盖：
 *   [1] app-ai-facts.js 顶层加载不抛错 + 导出 window.MTNodeAiFacts（8 个接口 + 全局别名）
 *   [2] 落点固定路径：<画布文件夹>\团队事实库\AI\ai-facts.json + 推导成功即登记 S.config.aiFacts
 *   [3] 落点豁免：画布文件夹就是应用源码目录也照建（不调用团队事实库的 misplacedReason）
 *   [4] 画布删除后在同一工作目录重建：命中固定路径即立刻载入已有库（无弹窗）
 *   [5] 无绑定画布 → 拒绝；无画布文件夹 → silent 不弹窗 / 非 silent 弹目录选择 / 取消即不可用
 *   [6] 写入语义：新建 / 同标题（归一化）＝更新原条 / 空条例报错 / 未知动作报错
 *   [7] 命中计数：query 与 get 命中才 +1，list 不计数；落盘 JSON 形状正确
 *   [8] 分数与淘汰：score = hit / (1 + 距上次命中天数)（线性衰减，不设半衰期）、超上限削低分、
 *       pinned 永不淘汰、pinned 占满上限时保留超额
 *   [9] 坏档保护：解析失败先备份 .bak 再当空库，原文件不被改写
 *  [10] 帧路由契约：renderer/app-db.js 分派 + kind:'facts'；gateway 白名单 / facts-result；
 *       ai-facts-plugin.mjs 注册 mtnode_facts；cordis.yml 挂载；名字不进隐藏名单（永远可见）
 *  [11] 技能与索引：SKILL.md frontmatter / index.json / INDEX.md / 预设名单 / 两处一句指向
 *  [12] 界面接入：index.html 脚本与样式、专家团左栏入口行、i18n 中英成对
 */
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
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

const SRC = read("renderer/app-ai-facts.js");
const DAY = 24 * 60 * 60 * 1000;
const WS = "E:\\proj\\demo";
const fileOf = (ws) => ws + "\\团队事实库\\AI\\ai-facts.json";

/* ═══════════ vm 沙箱：把渲染层模块原样搬进最小环境跑真行为 ═══════════
   app-ai-facts.js 只依赖 window.api（主进程白名单桥）、window.teamCanvasWorkspace
   （app-team.js factWorkspace 的画布文件夹口径）、S.config（配置命名空间）与
   currentVisibleWf（当前绑定画布）；弹窗相关函数在装载期一律不执行。 */
function makeEnv(opts) {
  const o = opts || {};
  const files = Object.assign({}, o.files || {});
  const log = [];
  const api = {
    pathJoin: function () {
      const parts = Array.prototype.slice
        .call(arguments)
        .map((x) => String(x == null ? "" : x).replace(/[\\/]+$/, ""))
        .filter((s) => s !== "");
      return parts.join("\\");
    },
    fileReadText: function (p) {
      log.push(["read", p]);
      return Promise.resolve(
        files[p] != null
          ? { ok: true, exists: true, content: files[p] }
          : { ok: true, exists: false, content: "" },
      );
    },
    fileWriteText: function (p, c) {
      log.push(["write", p]);
      files[p] = String(c);
      return Promise.resolve({ ok: true });
    },
    fileOpenDialog: function () {
      log.push(["pick"]);
      return Promise.resolve({ path: o.pick || "" });
    },
    configSave: function () {
      log.push(["cfg"]);
      return Promise.resolve({ ok: true });
    },
    /* 应用目录：团队事实库的守卫就是拿它判「落点在应用内」——AI 库豁免，这里给出以便反证。 */
    appDirs: function () {
      return Promise.resolve({ ok: true, appPath: WS, exeDir: WS, dirs: [] });
    },
  };
  const S = {
    config: { aiFacts: { canvases: {} } },
    wf: o.wf === undefined ? null : o.wf,
  };
  const ctx = {
    window: {
      api: api,
      I18n: undefined,
      teamCanvasWorkspace: (id) => (o.ws && o.ws[String(id)]) || "",
    },
    S: S,
    console: console,
    Date: Date,
    Math: Math,
    JSON: JSON,
    String: String,
    Number: Number,
    Array: Array,
    Object: Object,
    Promise: Promise,
    Error: Error,
    isFinite: isFinite,
    currentVisibleWf: () => S.wf,
  };
  vm.createContext(ctx);
  const API = vm.runInContext(SRC + "\n;window.MTNodeAiFacts;", ctx, {
    filename: "renderer/app-ai-facts.js",
  });
  return { API: API, ctx: ctx, files: files, log: log, S: S };
}

async function main() {
  console.log("\n[1] 模块装载与导出（renderer/app-ai-facts.js）");
  const env = makeEnv({ ws: { c1: WS } });
  ok(!!env.API && typeof env.API === "object", "顶层加载不抛错，window.MTNodeAiFacts 已挂好");
  for (const k of ["pathOf", "load", "save", "op", "scoreOf", "countOf", "openDlg", "canvasId"])
    ok(env.API && typeof env.API[k] === "function", "导出接口 " + k);
  for (const g of [
    "aiFactsPathOf",
    "aiFactsLoad",
    "aiFactsSave",
    "aiFactsOp",
    "aiFactsScoreOf",
    "aiFactsCountOf",
    "aiFactsOpenDlg",
    "aiFactsCanvasId",
  ])
    ok(typeof env.ctx.window[g] === "function", "全局别名 " + g + "（同层脚本按 typeof 取用）");

  console.log("\n[2] 落点固定路径 + 推导成功即登记配置");
  const p1 = await env.API.pathOf("c1");
  ok(p1 && p1.file === fileOf(WS), "固定路径 = <画布文件夹>\\团队事实库\\AI\\ai-facts.json");
  ok(p1 && p1.dir === WS && p1.fromWorkspace === true, "画布文件夹取自 teamCanvasWorkspace（顶栏工作目录口径）");
  ok(
    env.S.config.aiFacts.canvases.c1 && env.S.config.aiFacts.canvases.c1.dir === WS,
    "推导成功即把画布文件夹登记进 S.config.aiFacts.canvases（重建识别的前提）",
  );
  const cfgLog = env.log.filter((x) => x[0] === "cfg").length;
  await env.API.pathOf("c1");
  ok(
    env.log.filter((x) => x[0] === "cfg").length === cfgLog,
    "配置值没变就不再写盘（切画布 / 反复载入不刷配置）",
  );

  console.log("\n[3] 落点豁免（AI 库不进团队事实库的落点守卫）");
  ok(
    !/\bisInAppDir\s*\(/.test(SRC) && !/\bmisplacedReason\s*\(/.test(SRC),
    "app-ai-facts.js 不调用 misplacedReason / isInAppDir（只在注释里点名它并说明豁免）",
  );
  const envApp = makeEnv({ ws: { c1: "E:\\dev\\tools\\pipeline-console" } });
  const pApp = await envApp.API.pathOf("c1");
  ok(
    pApp && pApp.file === fileOf("E:\\dev\\tools\\pipeline-console"),
    "画布文件夹在应用目录内时仍返回路径（豁免共识；appDirs 给出的就是它）",
  );
  ok(SRC.indexOf("落点豁免") > 0, "文件头写明豁免共识与理由");

  console.log("\n[4] 画布删除后在同一路径重建 → 立刻载入（无弹窗）");
  const seeded = {
    version: 1,
    cap: 100,
    entries: [
      {
        id: "af-old-1",
        title: "模块划分",
        text: "三块：外壳 / 渲染层 / dsh",
        hits: 3,
        lastHit: Date.now(),
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  const env4 = makeEnv({ ws: { cNEW: WS }, files: { [fileOf(WS)]: JSON.stringify(seeded) } });
  const r4 = await env4.API.load("cNEW");
  ok(r4.ok === true && r4.exists === true && r4.data.entries.length === 1, "新画布 id 命中固定路径即载入已有库");
  ok(r4.data.entries[0].title === "模块划分", "载入的是磁盘上那一份（不是空库）");
  ok(
    env4.S.config.aiFacts.canvases.cNEW && env4.S.config.aiFacts.canvases.cNEW.dir === WS,
    "重建载入时自动登记画布文件夹（用户什么都没点）",
  );
  ok(env4.log.filter((x) => x[0] === "pick").length === 0, "重建载入全程不弹目录选择");

  console.log("\n[5] 无绑定画布 / 无画布文件夹的兜底");
  const env5 = makeEnv({});
  let err5 = "";
  try {
    await env5.API.op({ action: "list" }, "");
  } catch (e) {
    err5 = String((e && e.message) || e);
  }
  ok(err5.indexOf("当前没有绑定画布") >= 0, "无绑定画布：工具侧拒绝并给出唯一错误文本");
  const l5 = await env5.API.load("");
  ok(l5.ok === false && !!l5.error && l5.data.entries.length === 0, "load 无画布：ok:false + 错误文本 + 空库");
  const ps5 = await env5.API.pathOf("c1", { silent: true });
  ok(ps5 === null, "没有画布文件夹且 silent：不弹目录选择，返回 null");
  ok(env5.log.filter((x) => x[0] === "pick").length === 0, "silent 路径解析绝不弹窗");
  const env5b = makeEnv({ pick: "E:\\picked" });
  const p5b = await env5b.API.pathOf("c1");
  ok(p5b && p5b.picked === true && p5b.dir === "E:\\picked", "没有画布文件夹：弹目录选择让用户为这张画布选一个");
  ok(env5b.S.config.aiFacts.canvases.c1.dir === "E:\\picked", "选定结果写进配置（此后跟着画布走）");
  const env5c = makeEnv({ pick: "" });
  ok((await env5c.API.pathOf("c1")) === null, "用户取消目录选择 → 库不可用（不猜落点、不回落全局库）");

  console.log("\n[6] 写入语义（新建 / 同标题 upsert / 脏项）");
  const env6 = makeEnv({ ws: { c1: WS } });
  const w1 = await env6.API.op(
    { action: "write", params: { records: [{ title: "关键路径", text: "主进程 main.js；渲染层 renderer/" }] } },
    "c1",
  );
  ok(w1.ok === true && w1.count === 1 && w1.written[0].updated === false, "write 新建一条");
  const parsed6 = JSON.parse(env6.files[fileOf(WS)]);
  ok(
    parsed6.version === 1 && parsed6.cap === 100 && parsed6.entries.length === 1,
    "落盘 JSON 形状：version / cap / entries",
  );
  ok(parsed6.entries[0].id.indexOf("af-") === 0, "新建条目的 id 形如 af-…");
  const w2 = await env6.API.op(
    { action: "write", params: { record: { title: "  关键路径 ", text: "主进程 main.js + preload.js" } } },
    "c1",
  );
  ok(w2.count === 1 && w2.written[0].updated === true, "同标题（trim / 折叠空白 / 小写归一化）＝更新原条，不新增");
  const l6 = await env6.API.op({ action: "list" }, "c1");
  ok(l6.entries.length === 1 && l6.entries[0].text.indexOf("preload.js") > 0, "更新换掉了正文");
  let err6 = "";
  try {
    await env6.API.op({ action: "write", params: { record: { title: "", text: "   " } } }, "c1");
  } catch (e) {
    err6 = String((e && e.message) || e);
  }
  ok(!!err6, "标题与正文都为空：直接报错（不产生脏条目）");
  let err6b = "";
  try {
    await env6.API.op({ action: "nope" }, "c1");
  } catch (e) {
    err6b = String((e && e.message) || e);
  }
  ok(err6b.indexOf("未知动作") >= 0, "未知动作报错");

  console.log("\n[7] 命中计数：只有 query / get 命中才算，list 不算");
  const q7 = await env6.API.op({ action: "query", params: { q: "主进程" } }, "c1");
  ok(q7.found === 1 && q7.count === 1 && q7.entries[0].hits === 1, "query 命中：hits + 1");
  ok(typeof q7.entries[0].score === "number", "query 回执带分数（常被索引的先给）");
  const l7 = await env6.API.op({ action: "list" }, "c1");
  ok(l7.entries[0].hits === 1, "list 列全部：不计数");
  const id7 = q7.entries[0].id;
  const g7 = await env6.API.op({ action: "get", params: { id: id7 } }, "c1");
  ok(g7.record.hits === 2 && typeof g7.record.createdAt === "number", "get 命中：hits + 1，回执带全字段");
  const l7b = await env6.API.op({ action: "list" }, "c1");
  ok(l7b.entries[0].hits === 2, "两次命中累计到磁盘");
  const q7b = await env6.API.op({ action: "query", params: { q: "根本没有的词" } }, "c1");
  ok(q7b.found === 0 && q7b.entries.length === 0, "查不到：found 0 + 空数组（调用方据此说「库里没有」）");
  let err7 = "";
  try {
    await env6.API.op({ action: "get", params: { id: "af-不存在" } }, "c1");
  } catch (e) {
    err7 = String((e && e.message) || e);
  }
  ok(err7.indexOf("没有该条例") >= 0, "get 不存在的 id 报错");

  console.log("\n[8] 分数（score = hit / (1 + 距上次命中天数)）与淘汰（pin 永不淘汰）");
  ok(env6.API.scoreOf({ hits: 1, lastHit: Date.now() }) === 1, "刚命中一次 = 1.0");
  ok(
    env6.API.scoreOf({ hits: 1, lastHit: Date.now() - 30 * DAY }) === 0,
    "30 天没查 = 1/31 ≈ 0（线性衰减，不设半衰期）",
  );
  ok(env6.API.scoreOf({ hits: 4, lastHit: 0, updatedAt: 0, createdAt: 0 }) === 4, "没有时间基准时按 0 天算（不编造时间）");
  const now8 = Date.now();
  const capFiles = {
    [fileOf(WS)]: JSON.stringify({
      version: 1,
      cap: 3,
      entries: [
        { id: "e1", title: "常查", text: "x", hits: 9, lastHit: now8, pinned: false },
        { id: "e2", title: "少查", text: "x", hits: 1, lastHit: now8, pinned: false },
        { id: "e3", title: "久未查", text: "x", hits: 1, lastHit: now8 - 90 * DAY, pinned: false },
        { id: "e4", title: "固定", text: "x", hits: 0, lastHit: 0, pinned: true },
      ],
    }),
  };
  const env8 = makeEnv({ ws: { c1: WS }, files: Object.assign({}, capFiles) });
  const w8 = await env8.API.op({ action: "write", params: { record: { title: "新条", text: "x" } } }, "c1");
  ok(w8.count === 3 && w8.cap === 3, "写入后超出上限 → 削到 cap");
  ok(w8.evicted.length === 2, "淘汰条数 = 超额数（回执列出被淘汰的）");
  const kept8 = JSON.parse(env8.files[fileOf(WS)]).entries.map((e) => e.id);
  ok(kept8.indexOf("e4") >= 0, "pinned 的永不淘汰");
  ok(kept8.indexOf("e1") >= 0, "分数最高的常查条目留下");
  ok(kept8.indexOf("e3") < 0, "分数最低（久未查）的先走");
  ok(w8.evicted.some((e) => e.id === "e3"), "淘汰回执点名了被淘汰的条目");
  const env8b = makeEnv({
    ws: { c1: WS },
    files: {
      [fileOf(WS)]: JSON.stringify({
        version: 1,
        cap: 1,
        entries: [
          { id: "p", title: "固定", text: "x", hits: 0, pinned: true },
          { id: "f", title: "自由", text: "x", hits: 5, lastHit: now8, pinned: false },
        ],
      }),
    },
  });
  const w8b = await env8b.API.op({ action: "write", params: { record: { title: "再来", text: "y" } } }, "c1");
  ok(w8b.overflow === true && w8b.evicted.length === 0 && w8b.count === 3, "pinned 已占满上限：保留超额、不再淘汰");
  ok(String(w8b.note).length > 0, "overflow 回执带一句说明（模型据此知道为什么还超）");
  const env8c = makeEnv({ ws: { c1: WS } });
  await env8c.API.op({ action: "write", params: { record: { title: "a", text: "a" } } }, "c1");
  const l8c = await env8c.API.op({ action: "list" }, "c1");
  const pid8 = l8c.entries[0].id;
  const pin8 = await env8c.API.op({ action: "pin", params: { ids: [pid8] } }, "c1");
  ok(pin8.ok === true && pin8.pinned === 1, "pin 动作（默认保护）");
  const l8d = await env8c.API.op({ action: "list" }, "c1");
  ok(l8d.entries[0].pinned === true, "pin 落盘");
  const pin8b = await env8c.API.op({ action: "pin", params: { id: pid8, on: false } }, "c1");
  const l8e = await env8c.API.op({ action: "list" }, "c1");
  ok(pin8b.ok === true && l8e.entries[0].pinned === false, "pin on:false 取消保护（单个 id 也认）");
  const del8 = await env8c.API.op({ action: "delete", params: { ids: [pid8] } }, "c1");
  ok(del8.deleted === 1 && del8.count === 0, "delete 按 id 删除");

  console.log("\n[9] 坏档保护：备份 .bak 再当空库");
  const badRaw = "{ 这不是 json";
  const env9 = makeEnv({ ws: { c1: WS }, files: { [fileOf(WS)]: badRaw } });
  const r9 = await env9.API.load("c1");
  ok(r9.ok === true && r9.exists === false && r9.data.entries.length === 0, "解析失败当空库（不抛、不阻塞）");
  ok(r9.backup === fileOf(WS) + ".bak" && env9.files[r9.backup] === badRaw, "坏档原样备份成 ai-facts.json.bak");
  ok(env9.files[fileOf(WS)] === badRaw, "坏档本身不被改写（等首次写入才重写）");

  console.log("\n[10] 帧路由与网关契约（工具 mtnode_facts）");
  const DB = read("renderer/app-db.js");
  ok(
    DB.indexOf('msg.type === "facts"') > 0 && DB.indexOf("handleAiFactsToolEvent(msg.data || {}, boundWf)") > 0,
    "app-db.js：facts 帧有独立分派（与 db / tool-run 同一口径）",
  );
  ok(
    DB.indexOf('kind: "facts"') > 0 && DB.indexOf("window.MTNodeAiFacts") > 0,
    "app-db.js：宿主按本轮绑定画布调 MTNodeAiFacts.op 并回 kind:'facts'",
  );
  ok(DB.indexOf("当前没有绑定画布") > 0, "app-db.js：无绑定画布回错误文本（会话不中断）");
  const GW = read("dsh/gateway/gateway.mjs");
  ok(/m\.t !== 'facts'/.test(GW), "gateway.mjs：桥接帧白名单收了 facts");
  ok(
    /p\.kind === 'facts'/.test(GW) && /t: 'facts-result'/.test(GW),
    "gateway.mjs：interact kind:'facts' → facts-result（与 db 同形状）",
  );
  const PLUG = read("dsh/gateway/ai-facts-plugin.mjs");
  ok(/name: 'mtnode_facts'/.test(PLUG), "ai-facts-plugin.mjs 注册工具 mtnode_facts");
  ok(
    /enum:\s*\[\s*'list',\s*'query',\s*'get',\s*'write',\s*'delete',\s*'pin'\s*\]/.test(PLUG),
    "动作枚举 list / query / get / write / delete / pin",
  );
  ok(/t: 'facts'/.test(PLUG) && /t === 'facts-result'/.test(PLUG), "插件走 t:'facts' → facts-result 帧");
  ok(PLUG.indexOf("MTNODE_BRIDGE_PORT") > 0 && PLUG.indexOf("exec.agent.id") > 0, "走同一条桥 + 归属盖章（sessionId）");
  ok(PLUG.length < 20000, "工具定义紧凑（每步都随固定前缀重发）");
  /* 共识是「所有会话默认可见」：名字若留在 HIDEABLE_TOOLS 里只是允许将来按运行裁剪，
     关键是宿主**没有任何 hide 名单点名它**（点了 = 某档运行里它整个不存在）。 */
  const dropLists = DB.match(/DSH_TOOLS_DROPPED_BY_[A-Z_]+\s*=\s*\[[^\]]*\]/g) || [];
  ok(dropLists.length > 0, "找到 app-db.js 的按运行裁剪名单（" + dropLists.length + " 份）");
  ok(
    dropLists.every((s) => s.indexOf("mtnode_facts") < 0),
    "app-db.js 的 hideTools 名单不点名 mtnode_facts（默认全程可见）",
  );
  ok(
    read("renderer/app-nodes.js").indexOf("mtnode_facts") < 0,
    "app-nodes.js 的工具许可映射不牵涉 mtnode_facts（不新增许可开关）",
  );
  const CORDIS = read("dsh/gateway/cordis.yml");
  ok(
    CORDIS.indexOf("mtnode-ai-facts") > 0 && CORDIS.indexOf("./ai-facts-plugin.mjs") > 0,
    "cordis.yml 挂载 mtnode-ai-facts（disabled 与相邻 MTNode 插件同表达式）",
  );
  const TV = read("dsh/gateway/tool-visibility.mjs");
  ok(
    /HIDEABLE_TOOLS[\s\S]*mtnode_facts/.test(TV) || TV.indexOf("mtnode_facts") < 0,
    "网关白名单里的名字都合法（mtnode_facts 若在可裁名单内也只是「允许裁」，不影响默认可见）",
  );
  ok(read("dsh/DESIGN.md").indexOf("'facts'") > 0, "dsh/DESIGN.md 本地协议表补了 facts 帧");

  console.log("\n[11] 技能 / 索引 / 预设同步");
  const SK = read("mtnode-agent-skills/mtnode/ai-facts/SKILL.md");
  ok(/^---[\s\S]*name:\s*mtnode-ai-facts/.test(SK), "SKILL.md frontmatter name: mtnode-ai-facts");
  ok(SK.indexOf("title:") > 0 && /Use when/i.test(SK), "frontmatter 有 title 与英文 Use when（模型按关键词命中）");
  ok(SK.length > 800, "正文写了完整规范（沉淀时机 / 先查再写 / 冲突口径 / 库不可用）");
  const IDX = read("mtnode-agent-skills/index.json");
  ok(IDX.indexOf("mtnode-ai-facts") > 0 && IDX.indexOf("mtnode/ai-facts/SKILL.md") > 0, "技能索引含 mtnode-ai-facts");
  ok(read("mtnode-agent-skills/INDEX.md").indexOf("mtnode-ai-facts") > 0, "INDEX.md 含 mtnode-ai-facts");
  ok(GW.indexOf("mtnode-ai-facts") > 0, "预设系统提示的技能名单补了 mtnode-ai-facts");
  for (const f of [
    "mtnode-agent-skills/mtnode/dev-architect/SKILL.md",
    "mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md",
  ])
    ok(read(f).indexOf("mtnode-ai-facts") > 0, f + " 有一句指向 mtnode-ai-facts（规范只写在技能一处）");
  ok(
    read("renderer/app-assist.js").indexOf("mtnode-ai-facts") > 0,
    "助手技能名单 / 分类表收录了 mtnode-ai-facts",
  );

  console.log("\n[12] 界面接入与 i18n 中英成对");
  const HTML = read("renderer/index.html");
  ok(HTML.indexOf('<script src="app-ai-facts.js"></script>') > 0, "index.html 引入 app-ai-facts.js");
  ok(
    HTML.indexOf("css/ai-facts.css") > 0 && exists("renderer/css/ai-facts.css"),
    "index.html 引入 css/ai-facts.css 且文件存在",
  );
  ok(
    HTML.indexOf('<script src="app-factlib.js">') < HTML.indexOf('<script src="app-ai-facts.js">'),
    "脚本分层：app-factlib.js 之后挂 app-ai-facts.js（同层相邻）",
  );
  const TVIEW = read("renderer/app-teamview.js");
  ok(TVIEW.indexOf("team-side-ai-fact") > 0, "专家团左栏事实库分组里有 AI 事实库行");
  ok(TVIEW.indexOf("teamViewAiFactRow(canvasId)") > 0, "入口行挂在分组末尾（一般库行 / 文档行顺序未动）");
  ok(TVIEW.indexOf("aiFactsOpenDlg(") > 0, "点这一行开查阅弹窗");
  ok(TVIEW.indexOf("typeof aiFactsCountOf") > 0, "按调用期 typeof 取用（不依赖脚本装载顺序）");
  ok(
    SRC.indexOf("openOverlay(") > 0 && SRC.indexOf("closeOverlay(") > 0,
    "查阅弹窗走 app.js 的 openOverlay（persistent、可最小化）",
  );
  ok(
    !/document\.addEventListener\(\s*["'](mousedown|click)["']/.test(SRC) &&
      !/window\.addEventListener\(\s*["'](mousedown|click)["']/.test(SRC),
    "弹窗不挂「点外部即关」式监听（带输入的浮层必须 persistent）",
  );
  /* i18n 成对：app-ai-facts.js 全部文案 + app-db.js 那两条 facts 文案（app-db.js 其余文案
     属于既有模块，本轮不动也不替它背 i18n 账） */
  const I18N = read("renderer/i18n.js");
  const ZH = [];
  const pushT = (src) => {
    const re = /\b(?:T|I18n\.t)\(\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(src))) if (ZH.indexOf(m[1]) < 0) ZH.push(m[1]);
  };
  pushT(SRC);
  ZH.push("当前没有绑定画布", "AI 事实库模块未就绪（app-ai-facts.js）");
  ok(ZH.length > 20, "从源码里刮出 " + ZH.length + " 条本模块用户可见中文串");
  const miss = ZH.filter((s) => I18N.indexOf('"' + s + '":') < 0);
  ok(miss.length === 0, "新词条中英成对" + (miss.length ? "（缺：" + miss.slice(0, 5).join(" / ") + "）" : ""));

  console.log(
    "\n" + (fails ? "FAILED " + fails + "/" + checks : "SMOKE-AI-FACTS-RENDERER OK（" + checks + " 项）"),
  );
  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => {
  console.log("FAIL  测试自身异常：" + ((e && e.stack) || e));
  process.exitCode = 1;
});
"use strict";
/* Token 开销预算 —— 冒烟测试（纯 Node，不依赖 Electron；只 import 网关自有插件）
 *   node test/smoke-token-budget.js
 * 本轮落地：把「每一步都在重发的固定开销」与「历史里囤积的返回体」钉成回归门槛。
 * 实测账单与取舍见 docs/codex-agent-benchmark.md「本轮落地：Token 开销」，
 * 量账单的工具是 scripts/audit-token-usage.mjs。
 * 覆盖：
 *   [1] 画布工具 JSON Schema 字符上限（mtnode_canvas_edit ≤17,000、描述本体 ≤2,000）
 *       + 瘦身后仍在的硬信息（端子口径 / judge 0=YES / superConnect / save 与 wait_file / 批次）
 *   [2] 属性表只抄一遍：create[] 与 update[] 共用一张表（update 只多定位字段）
 *   [3] 按运行裁剪可见工具集：MTNODE_LEAN_TOOLS / MTNODE_NO_CANVAS 四种组合
 *   [4] 网关下达链路：run 参数 → runtime key（lean: / nc:）→ spawn env → 预设补一句
 *   [5] 历史与返回预算：cordis.yml 的 spill / pruner 新阈值 + 思考剥离插件挂载行
 *   [6] 思考回放裁剪：只裁非末步、只换块不删块、原始请求对象一字不改、非法开关整链 no-op
 *   [7] 渲染层开关与下发：设置「精简工具负载」→ runParams.lean / nodeLock → runSig
 *   [8] 审计脚本存在且口径齐（固定前缀 / 每步 prompt / 工具返回 / 思考 / 缓存命中）
 *   [9] 按名字的隐藏名单（第三个闸）：Gate A 开发绑定轮只裁「读画布」两件套、Gate B
 *       声明轮走整档闸且名字不重复进名单、细化 / 问询轮可见集一字不变、
 *       助手两档的 app_state 都只给计数 + 选中 / 焦点（不取整图快照、不带正文）、
 *       名单与标记都进 runSig
 *   [10] 本轮落地：edit 回执自足（x/y/w/h + 端口摘要）/ detail:"diff" / 端子预检
 *       （ports 暴露 + connect 候选建议 + 保存后缀前移）/ 收尾一次性校验 warnings /
 *       canvas_get 结构哈希缓存（同图同参重读回「无变化」短回执） */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

const { pathToFileURL } = require("url");

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const LEAN_ENV = "MTNODE_LEAN_TOOLS";
const NO_CANVAS_ENV = "MTNODE_NO_CANVAS";
const TRIM_ENV = "MTNODE_TRIM_REASONING";
/* 第三个闸（按名字的隐藏名单）同样是 spawn env。宿主进程（MTNode 里跑起来的 shell）
   常常带着它 —— 本轮实测：带着 MTNODE_HIDE_TOOLS=mtnode_db,mtnode_vision 时，
   [3] 的三条「全量注册」断言会假失败。清标记必须三个通道一起清。 */
const HIDE_ENV = "MTNODE_HIDE_TOOLS";

function clearFlags() {
  delete process.env[LEAN_ENV];
  delete process.env[NO_CANVAS_ENV];
  delete process.env[HIDE_ENV];
}

/* 加载并跑一次 canvas-plugin 的 apply()：返回这一轮真正注册出去的工具。
   env 由 apply() 现场读（spawn 时定死），所以同一个模块实例可以反复 apply。 */
function registeredTools(mod, env) {
  clearFlags();
  for (const k of Object.keys(env || {})) {
    if (env[k] != null) process.env[k] = env[k];
  }
  const tools = [];
  mod.apply({
    tools: { register: (t) => tools.push(t) },
    on() {},
    effect() {},
  });
  return tools;
}

const schemaChars = (t) =>
  JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length;
/* defineTool 会把参数表包成 { type:'object', properties:{…} } —— 取属性表本体 */
const paramSpec = (t) => {
  const p = t.parameters || {};
  return p.properties && typeof p.properties === "object" ? p.properties : p;
};

/* ── 渲染层源码取证（Windows 工作区常见 CRLF，锚点串一律按 \n 写）── */
const readN = (rel) => read(rel).replace(/\r\n?/g, "\n");
const has = (hay, needle, msg) => ok(hay.indexOf(needle) >= 0, msg);
const hasnt = (hay, needle, msg) =>
  ok(hay.indexOf(needle) < 0, msg + "（源码里不该再出现：" + needle + "）");
/* 跳过字符串 / 注释做括号配对：为的是「就在这一条路径里」，不是全文 grep 到就算数 */
function sliceBraces(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i++;
        else if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("括号未配平（锚点附近代码改动过大？）");
}
/* 把整条函数声明原样抠出来（放进 vm 沙箱跑真行为，而不是读它的字面量） */
function grabFunction(src, name, where) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) {
    ok(false, (where || "") + " 应定义函数 " + name);
    return "";
  }
  const open = src.indexOf("{", src.indexOf(")", m.index));
  return src.slice(m.index, open + sliceBraces(src, open).length);
}
/* 抠一个字符串数组常量（宿主侧那份「整档闸裁掉的名字」表） */
function grabStringList(src, name, where) {
  const m = new RegExp("const " + name + "\\s*=\\s*\\[[^\\]]*\\]", "m").exec(src);
  if (!m) {
    ok(false, (where || "") + " 应定义常量数组 " + name);
    return [];
  }
  return (m[0].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
}
/* 抠一段「顶层函数到下一个顶层函数」的区域（对象字面量太大，不适合括号配对时用它） */
function grabRegion(src, header, where) {
  const a = src.indexOf(header);
  if (a < 0) {
    ok(false, (where || "") + " 里找不到锚点：" + header);
    return "";
  }
  let b = src.length;
  for (const re of [
    /\nfunction\s+[\w$]+\s*\(/g,
    /\nasync\s+function\s+[\w$]+\s*\(/g,
  ]) {
    re.lastIndex = a + header.length;
    const m = re.exec(src);
    if (m) b = Math.min(b, m.index);
  }
  return src.slice(a, b);
}

/* 思考回放裁剪插件的假运行时：只关心「有没有注册监听」与「实际发出去的请求」。 */
function fakeLlmCtx() {
  const listeners = [];
  const sent = [];
  const ctx = {
    llm: {
      stream(options) {
        sent.push(options);
        return {
          [Symbol.asyncIterator]() {
            return { next: () => Promise.resolve({ done: true, value: undefined }) };
          },
        };
      },
    },
    on(event, fn, opts) {
      listeners.push({ event, fn, opts });
    },
  };
  return { ctx, listeners, sent };
}

const rblk = (text) => Object.freeze({ type: "reasoning", text });
const tblk = (text) => Object.freeze({ type: "text", text });
const ublk = (id) => Object.freeze({ type: "tool_use", id, name: "read", input: {} });
const asst = (id, blocks) =>
  Object.freeze({
    id,
    role: "assistant",
    content: Object.freeze(blocks),
    source: Object.freeze({ replayState: Object.freeze({ blocks }) }),
  });
const user = (text) => Object.freeze({ role: "user", content: text });
const LONG = "推".repeat(300);
const SHORT = "想两句";
const ELIDED = "[earlier thinking elided]";

/* 主体是 async（内含多处 await import / await runAppSnapshot）——必须留句柄给收尾等它：
   否则文件末尾那个同步的 process.exit() 会赶在主体跑完前退出，
   本文件 [1]–[10] 的断言全部落空却仍报全绿（本轮实测踩到）。 */
const MAIN = (async () => {
  /* ==================== [1][2] 画布工具负载上限与必留硬信息 ==================== */
  console.log("\n[1] mtnode_canvas_* 工具 JSON 负载上限（固定前缀的最大单项）");
  const canvas = await import(pathToFileURL(abs("dsh/gateway/canvas-plugin.mjs")).href);
  clearFlags();
  const all = registeredTools(canvas, {});
  const byName = {};
  for (const t of all) byName[t.name] = t;
  const chars = {};
  for (const k of Object.keys(byName)) chars[k] = schemaChars(byName[k]);
  console.log(
    "      实测字符：" +
      Object.keys(chars)
        .sort()
        .map((k) => k + "=" + chars[k])
        .join(" · "),
  );
  ok(!!byName.mtnode_canvas_edit && !!byName.mtnode_canvas_get, "画布主干两个工具任何档位都在");
  ok(
    chars.mtnode_canvas_edit <= 17000,
    "mtnode_canvas_edit ≤ 17,000 字符（实测 " + chars.mtnode_canvas_edit + "，优化前 59,185）",
  );
  ok(
    chars.mtnode_canvas_get <= 8000,
    "mtnode_canvas_get ≤ 8,000 字符（实测 " + chars.mtnode_canvas_get + "）",
  );
  const GET_PARAMS = paramSpec(byName.mtnode_canvas_get);
  const GET_SRC = read("dsh/gateway/canvas-plugin.mjs");
  ok(
    GET_SRC.indexOf("DEFAULT_GET_DETAIL = 'minimal'") >= 0 &&
      (GET_PARAMS.detail.description || "").toLowerCase().indexOf("default") >= 0,
    "canvas_get 默认档位 = minimal：只回节点索引，要配置得显式 detail:\"standard\"、要全文 detail:\"full\" + ids（漏传也在网关侧兜底）",
  );
  ok(
    GET_SRC.indexOf("sizeHint") >= 0,
    "canvas_get 返回体自报体积（sizeHint）：模型看得见这一步花了多少字符",
  );
  const GET_DESC_CHARS = (byName.mtnode_canvas_get.description || "").length;
  ok(
    GET_DESC_CHARS <= 10000,
    "GET_DESC 本体 ≤ 10,000 字符（实测 " + GET_DESC_CHARS +
      "；阈值放宽到 10,000 —— 描述是画布读图口径的真源，按 kind 字段清单与 GRANULARITY 逐参数复述已删，参数取法真源仍是 parameters 表，不再抄第二份）",
  );
  ok(
    GET_SRC.indexOf("GRANULARITY") < 0 &&
      GET_SRC.indexOf("DEV_FUNC_COLORS_TABLE") < 0 &&
      GET_SRC.indexOf("DEV_FUNC_COLORS_SHORT") < 0,
    "删掉只写进描述、与别处重复的副本：GRANULARITY 逐参数清单 + 功能色卡硬拷贝（色卡由 detail:\"standard\" 的 devFuncColors 返回，真源在 renderer/app-devnode.js）",
  );
  const GET_DESC_BODY = byName.mtnode_canvas_get.description || "";
  ok(
    GET_DESC_BODY.indexOf("dev/devPath/devStatus/devKind") < 0 &&
      GET_DESC_BODY.indexOf("imgQuality/imgBackground/maskOn") < 0,
    "字段清单不再进描述（它按 kind 生成、每轮重发且会随实现漂移：旧版那句「默认就带 prompt/task/goal」早就与实现相反）",
  );
  ok(
    GET_SRC.indexOf("editSummary") >= 0 && GET_SRC.indexOf("整图快照已省略") >= 0,
    "canvas_edit 回执只给计数 + 别名 / 标题 + warnings（不把整图快照囤进历史）",
  );
  ok(
    chars.mtnode_canvas_edit + chars.mtnode_canvas_get <= 24000,
    "画布两个主干工具合计 ≤ 24,000 字符（实测 " + (chars.mtnode_canvas_edit + chars.mtnode_canvas_get) + "）",
  );
  const EDIT_PARAMS = paramSpec(byName.mtnode_canvas_edit);
  const EDIT_BLOB =
    (byName.mtnode_canvas_edit.description || "") + JSON.stringify(EDIT_PARAMS);
  for (const [needle, why] of [
    ["fromIndex 0 = YES", "judge 两个输出的端子口径（接反就是 YES/NO 互换）"],
    ["输入端子 0 = 控制入", "tool / function「参数即端子」的数法"],
    ["整体替换", "传 inputs / outputs = 换端子表，会连带改连线"],
    ["parentTaskId", "task 计划与实现的归属"],
    ["superConnect", "跨超级节点连线的唯一入口"],
    ["wait_file", "智能节点文件交接（不接 save、不作数据输入）"],
    ["batchMode", "批次语义（防 N² 的判据）"],
    ["mtnode-dev-architect", "长规范指向技能，不在工具描述里抄"],
    ["mtnode-canvas-edit-rules", "完整画布编辑硬规则指向按需技能（描述只留卡口 + 一句指向）"],
  ]) {
    ok(EDIT_BLOB.indexOf(needle) >= 0, "瘦身仍保留硬信息：" + needle + "（" + why + "）");
  }
  ok(
    (byName.mtnode_canvas_edit.description || "").indexOf("硬规则（误接线主要来源）") < 0,
    "12 条硬规则正文已从 EDIT_DESC 迁出（工具描述每轮重发，长规则改由技能按需加载）",
  );
  /* EDIT_DESC 本体（含固定前缀 NODE_LOCK）才是「每轮重发」的部分；参数表是 create/update
     共用的 80+ 字段定义，属必要的机器可读契约，不在本轮瘦身范围。长规则迁进技能后，
     描述本体应稳定在一句话量级 —— 这条上限挡住它再次膨胀回几千字。 */
  const EDIT_DESC_CHARS = (byName.mtnode_canvas_edit.description || "").length;
  ok(
    EDIT_DESC_CHARS <= 2000,
    "EDIT_DESC 本体 ≤ 2,000 字符（实测 " + EDIT_DESC_CHARS +
      "；瘦身前约 3.1K 含 NODE_LOCK，完整硬规则在技能 mtnode-canvas-edit-rules）",
  );
  ok(
    !/systemPrompt/.test(EDIT_BLOB),
    "legacy 字段（旧 chat 节点的 systemPrompt）说明已删",
  );

  console.log("\n[2] 属性表只抄一遍（create / update 不再各带一份）");
  const createProps = EDIT_PARAMS.create.items.properties;
  const updateProps = EDIT_PARAMS.update.items.properties;
  ok(Object.keys(createProps).length >= 80, "create[] 属性表完整（" + Object.keys(createProps).length + " 项，字段一项未减）");
  ok(
    Object.keys(updateProps).length <= 8,
    "update[] 只列定位与尺寸字段（" + Object.keys(updateProps).length + " 项 ≤ 8），不重抄属性表",
  );
  ok(
    (EDIT_PARAMS.update.items.description || "").indexOf("同一份") >= 0,
    "update[] 描述明确指向 create[] 那份表（真源唯一）",
  );
  const marksChars = JSON.stringify(EDIT_PARAMS.marks || {}).length;
  const createMarksChars = JSON.stringify(EDIT_PARAMS.createMarks || {}).length;
  ok(
    marksChars * 3 < createMarksChars,
    "旧别名 marks 只剩一句指向（" + marksChars + " 字符，createMarks 本体 " + createMarksChars + " 字符），不抄第二份表",
  );
  ok(
    JSON.stringify(EDIT_PARAMS.disconnect || {}).length <
      JSON.stringify(EDIT_PARAMS.connect || {}).length / 2,
    "disconnect 复用 connect 的表说明，不重复 items 定义",
  );

  /* ==================== [3] 按运行裁剪可见工具集 ==================== */
  console.log("\n[3] 按运行裁剪可见工具集（可见集在 spawn 时定档，不在轮内热改）");
  ok(byName.mtnode_app.description.indexOf("ONLY for the global assistant") >= 0,
    "画布 / 应用工具描述开头的「智能节点不得调用」硬规则仍在（裁剪之外的第二道保险）");
  const namesOf = (env) => registeredTools(canvas, env).map((t) => t.name).sort();
  const full = namesOf({});
  ok(
    eq(full, ["mtnode_app", "mtnode_canvas_edit", "mtnode_canvas_get", "mtnode_vision"]),
    "默认档 = 四个工具全注册（未开启任何裁剪时行为与此前一致）",
  );
  const lean = namesOf({ [LEAN_ENV]: "1" });
  ok(
    eq(lean, ["mtnode_canvas_edit", "mtnode_canvas_get"]),
    "精简工具负载 → 不注册 mtnode_app / mtnode_vision（省约 4.7K 字符/步）",
  );
  ok(
    namesOf({ [LEAN_ENV]: "on" }).length === 2 && namesOf({ [LEAN_ENV]: "true" }).length === 2,
    "env 真值口径 1 / on / true 同样生效",
  );
  ok(
    namesOf({ [LEAN_ENV]: "off" }).length === 4 && namesOf({ [LEAN_ENV]: "" }).length === 4,
    "env 为 off / 空 = 不裁剪（回落全量注册）",
  );
  const nc = namesOf({ [NO_CANVAS_ENV]: "1" });
  ok(
    eq(nc, ["mtnode_vision"]),
    "画布智能节点（nodeLock）→ 只剩 mtnode_vision（识图仍被允许）",
  );
  ok(
    !nc.includes("mtnode_canvas_get") && !nc.includes("mtnode_canvas_edit") && !nc.includes("mtnode_app"),
    "宿主一律拒收的三个画布 / 应用工具不再下发（省 25,619 字符/步）",
  );
  const both = namesOf({ [LEAN_ENV]: "1", [NO_CANVAS_ENV]: "1" });
  ok(both.length === 0, "两个标记同时开 → 该插件一个工具都不注册");
  ok(eq(namesOf({}), full), "清掉 env 后回到全量注册（无残留状态）");
  clearFlags();
  /* 第三个通道：按名字的隐藏名单 MTNODE_HIDE_TOOLS（注册口只认规范名单里的名字）。
     这条通道是「点名裁」—— Gate A 开发绑定轮靠它只砍读画布两件套，
     绝不允许顺手把 mtnode_canvas_edit 也砍掉（收尾要回写本节点）。 */
  const hid = (v) => namesOf({ [HIDE_ENV]: v });
  ok(
    eq(hid("mtnode_app,mtnode_canvas_get"), ["mtnode_canvas_edit", "mtnode_vision"]),
    "隐藏名单点名 mtnode_app / mtnode_canvas_get → 注册出去的恰是改图 + 识图两件套",
  );
  ok(
    eq(hid("mtnode_canvas_get,mtnode_app"), hid("mtnode_app,mtnode_canvas_get")),
    "名单顺序不影响结果（网关已归一成字典序，同一档每轮逐字相同 → 前缀稳定）",
  );
  ok(
    eq(hid("read,grep,shell,mtnode_vision"), ["mtnode_app", "mtnode_canvas_edit", "mtnode_canvas_get"]),
    "名单点名 mtnode_vision → 只掉它；dsh 内置工具名（read / grep / shell）不注册在本插件，跳过",
  );
  ok(eq(hid("not_a_tool"), full), "白名单外的垃圾名字一律丢弃（宿主脏数据不许原样灌进运行时）");
  ok(eq(hid(""), full), "空名单 = 不裁（与未接入本能力时一字不差）");
  ok(
    eq(hid("mtnode_app,mtnode_canvas_get,mtnode_canvas_edit,mtnode_vision"), []),
    "四个名字点满 → 本插件一个都不注册（名单通道能覆盖整档闸能做的一切）",
  );
  clearFlags();
  ok(eq(namesOf({}), full), "[3] 收尾：三个通道都没有残留状态（漏清 MTNODE_HIDE_TOOLS 在这里就炸）");

  /* ==================== [4] 网关下达链路 ==================== */
  console.log("\n[4] gateway.mjs：run 参数 → runtime key → spawn env → 预设补一句");
  const GATE = read("dsh/gateway/gateway.mjs");
  /* 只钉「handleRun 的解构表里点名了这几个 run 参数」，不钉换行与相邻字段：
     原先的写法把 rollback 也钉进去，该参数已从 handleRun 摘除（全仓再无 rollback run 参数，
     grep dsh/gateway/gateway.mjs 零命中），换行也改过一版 —— 于是这条断言长期假红，
     只因文件末尾 process.exit 抢跑才没暴露（见文件顶部注释）。 */
  const RUN_PARAMS_SRC = (() => {
    const from = GATE.indexOf("async function handleRun(params)");
    const to = GATE.indexOf("} = params", from);
    return from >= 0 && to > from ? GATE.slice(from, to) : "";
  })();
  ok(
    RUN_PARAMS_SRC.length > 0 &&
      ["pure", "tools", "lean", "noCanvas"].every((n) => new RegExp("\\b" + n + "\\b").test(RUN_PARAMS_SRC)),
    "handleRun 收宿主下发的 lean / noCanvas 两个 run 参数（在解构表里点名）",
  );
  ok(GATE.indexOf("const leanFlag = !!lean && !pureFlag") >= 0 && GATE.indexOf("const noCanvasFlag = !!noCanvas && !pureFlag") >= 0,
    "pure 轮两个标记归零（画布 / 数据库插件本就被 cordis 整体禁用）");
  ok(GATE.indexOf("'|lean:' + (leanOn ? '1' : '0')") >= 0 && GATE.indexOf("'|nc:' + (noCanvasOn ? '1' : '0')") >= 0,
    "两个标记进 runtime key（换可见集 = 冷起自己的运行时，不打爆提示缓存）");
  ok(GATE.indexOf("env.MTNODE_LEAN_TOOLS = '1'") >= 0 && GATE.indexOf("delete env.MTNODE_LEAN_TOOLS") >= 0,
    "env MTNODE_LEAN_TOOLS 下达（关时显式 delete，不残留）");
  ok(GATE.indexOf("env.MTNODE_NO_CANVAS = '1'") >= 0 && GATE.indexOf("delete env.MTNODE_NO_CANVAS") >= 0,
    "env MTNODE_NO_CANVAS 下达");
  ok(GATE.indexOf("toolsJson, lean, noCanvas, hideTools, noBrowser) {") >= 0,
    "getRuntime 形参以四个可见集通道结尾（位置参数：定义与调用点必须同步扩列；noBrowser = browser_* 仅会话可用）");
  ok(GATE.indexOf("leanFlag, noCanvasFlag,") >= 0, "getRuntime 收到本轮两个标记");
  ok(/const LEAN_TOOLS_NOTE\s*=/.test(GATE), "定义 LEAN_TOOLS_NOTE（裁了工具就要告诉模型工具不存在）");
  ok(GATE.indexOf("leanFlag && presetBase ? presetBase + LEAN_TOOLS_NOTE : presetBase") >= 0,
    "只在真的裁剪过的那一轮补说明；人设为空的轮次不补");
  ok((GATE.match(/LEAN_TOOLS_NOTE/g) || []).length >= 2, "说明文本只有一份定义（不四处复制）");
  const noteAt = GATE.indexOf("const LEAN_TOOLS_NOTE =");
  const noteSrc = noteAt >= 0 ? GATE.slice(noteAt, GATE.indexOf("/** @type {Map<string", noteAt)) : "";
  ok(
    noteSrc.length > 0 && noteSrc.length <= 400,
    "说明是一句话量级（源码 " + noteSrc.length + " 字符，含代码与注释），不是第二份规范",
  );
  ok(GATE.indexOf("【精简工具负载】") >= 0, "补的那一句点名被裁掉的两个工具（模型不会去撞不存在的工具）");
  ok(GATE.indexOf("this run does not register them") >= 0 || GATE.indexOf("does not even register them") >= 0,
    "PRESETS.node 措辞与「未注册」一致（不再只说会被拒绝）");

  /* ==================== [5] 返回与历史预算 ==================== */
  console.log("\n[5] cordis.yml：工具返回 / 历史预算阈值");
  const CORDIS = read("dsh/gateway/cordis.yml");
  const numOf = (re, label) => {
    const m = CORDIS.match(re);
    const v = m ? Number(m[1]) : NaN;
    ok(Number.isFinite(v), "读到 " + label + " 配置项");
    return v;
  };
  const spill = numOf(/maxInlineBytes:\s*(\d+)/, "spill-policy");
  const thr = numOf(/thresholdChars:\s*(\d+)/, "tool-result-pruner thresholdChars");
  const head = numOf(/headChars:\s*(\d+)/, "tool-result-pruner headChars");
  const tail = numOf(/tailChars:\s*(\d+)/, "tool-result-pruner tailChars");
  ok(spill > 0 && spill <= 12000, "spill-policy.maxInlineBytes ≤ 12,000（实测 " + spill + "，原 50,000 正好囤住整条 grep）");
  ok(thr > 0 && thr <= 4096, "pruner.thresholdChars ≤ 4,096（实测 " + thr + "，原 8,192 → 5K–50K 的返回常驻历史）");
  ok(head > 0 && head <= 1536, "pruner.headChars ≤ 1,536（实测 " + head + "）");
  ok(tail > 0 && tail <= 512, "pruner.tailChars ≤ 512（实测 " + tail + "）");
  ok(CORDIS.indexOf("'./plugins/reasoning-replay-trim-plugin.mjs'") >= 0, "思考回放裁剪插件已挂在 cordis（开关由 env 决定）");
  ok(CORDIS.indexOf("id: mtnode-reasoning-replay-trim") >= 0, "挂载行有稳定 id（设置面板按它读用途）");
  ok(CORDIS.indexOf("MTNODE_PURE === '1'") >= 0, "纯净模式的整块工具门控仍在（未被本轮改动碰坏）");

  /* ==================== [6] 思考回放裁剪 ==================== */
  console.log("\n[6] 历史思考回放：只裁非末步、只换块不删块、不改原始请求");
  /* 插件首裁会向 stderr 打一行 [rr-trim] 诊断；测试里接管掉，免得被当成报错 */
  const stderrWrites = [];
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };
  const trim = await import(pathToFileURL(abs("dsh/gateway/plugins/reasoning-replay-trim-plugin.mjs")).href);
  ok(trim.name === "mtnode-reasoning-replay-trim", "插件导出 name 与 cordis 挂载行一致");
  for (const off of [undefined, "", "0", "off", "false", "no", "abc", "-3", "0.5"]) {
    delete process.env[TRIM_ENV];
    if (off != null) process.env[TRIM_ENV] = off;
    const f = fakeLlmCtx();
    trim.apply(f.ctx);
    ok(f.listeners.length === 0, "开关 " + JSON.stringify(off) + " → 不注册任何监听（整链 no-op 兜底）");
  }
  delete process.env[TRIM_ENV];
  process.env[TRIM_ENV] = "1";
  const f1 = fakeLlmCtx();
  trim.apply(f1.ctx);
  ok(f1.listeners.length === 1 && f1.listeners[0].event === "llm/stream", "开关 = 1 → 挂一个 llm/stream 监听");
  ok(f1.listeners[0].opts === undefined, "默认（非 prepend）注册 = 站到链内侧，让不变式先在原始请求上跑完");
  const handler = f1.listeners[0].fn;

  const last = asst("a2", [rblk("最后一步的思考".repeat(30)), tblk("结论")]);
  const earlier = asst("a1", [rblk(LONG), tblk("上一轮正文"), ublk("call-1")]);
  const msgs = Object.freeze([user("任务"), earlier, last]);
  const options = Object.freeze({ sessionId: "s1", messages: msgs });
  let nextCalls = 0;
  const next = () => {
    nextCalls++;
    return "NEXT";
  };
  const before = JSON.stringify(msgs);
  const ret = handler(options, next);
  ok(f1.sent.length === 1 && nextCalls === 0, "有可裁内容 → 带副本重进 llm.stream（不走 next）");
  ok(ret && typeof ret[Symbol.asyncIterator] === "function", "返回值仍是可迭代的流对象");
  const sent = f1.sent[0];
  ok(sent !== options, "发出去的是新对象（原始请求对象没被动过）");
  ok(sent.messages.length === msgs.length, "消息条数不变");
  ok(sent.messages[2] === last, "最后一条 assistant 原样引用（那一步的思考正在被续写）");
  ok(sent.messages[0] === msgs[0] && sent.messages[1] !== earlier, "只替换够长的非末条 assistant");
  const sentBlocks = sent.messages[1].content;
  ok(sentBlocks.length === 3, "被裁消息的块数不变（占位替换，绝不删块）");
  ok(sentBlocks[0].type === "reasoning" && sentBlocks[0].text === ELIDED, "reasoning 块换成极短占位块且类型仍是 reasoning");
  ok(sentBlocks[1] === earlier.content[1] && sentBlocks[2] === earlier.content[2], "text / tool_use 块原样引用（不误伤正文与工具轮次）");
  ok(sent.messages[1].source === earlier.source, "source.replayState 等保真元数据原样带走（不降级成 foreignAssistant）");
  ok(JSON.stringify(msgs) === before, "原始 messages 一字未改（会话日志 / UI 回显 / 耐久推导都不受影响）");
  ok(sent.messages[1].content[0].text.length < 40, "占位块比原文短得多（这一步才真的省到 token）");
  const again = handler(sent, next);
  ok(again === "NEXT" && nextCalls === 1 && f1.sent.length === 1, "重进的那一次认出自己 → 直接 next() 放行（不递归）");

  const onlyOne = handler(Object.freeze({ sessionId: "s2", messages: Object.freeze([user("任务"), earlier]) }), () => "N1");
  ok(onlyOne === "N1" && f1.sent.length === 1, "只有一条 assistant = 它就是末步 → 不裁");
  const shortThink = handler(
    Object.freeze({ sessionId: "s3", messages: Object.freeze([user("任务"), asst("b1", [rblk(SHORT)]), last]) }),
    () => "N2",
  );
  ok(shortThink === "N2" && f1.sent.length === 1, "短于阈值的思考不裁（不值得为几十字改请求形状）");
  process.env[TRIM_ENV] = "50";
  const f2 = fakeLlmCtx();
  trim.apply(f2.ctx);
  const mid = asst("c1", [rblk("思".repeat(60))]);
  const ret2 = f2.listeners[0].fn(
    Object.freeze({ sessionId: "s4", messages: Object.freeze([user("任务"), mid, last]) }),
    () => "N3",
  );
  ok(ret2 !== "N3" && f2.sent[0].messages[1].content[0].text === ELIDED, "env 给整数 = 自定义阈值（50 字时 60 字的思考被裁）");
  delete process.env[TRIM_ENV];
  process.stderr.write = realStderrWrite;
  const rrLogs = stderrWrites.filter((x) => x.indexOf("[rr-trim]") >= 0);
  ok(
    rrLogs.length === 2 && rrLogs[0].indexOf("session=s1") >= 0 && rrLogs[1].indexOf("session=s4") >= 0,
    "每 session 首裁只打一行诊断（去重且有界），测试输出不被诊断刷屏",
  );

  /* ==================== [7] 渲染层开关与下发 ==================== */
  console.log("\n[7] 渲染层：设置开关 → run 参数 → 网关（默认关 = 行为与此前一致）");
  const SET = read("renderer/app-settings.js");
  ok(SET.indexOf('leanCb.checked = S.config.dsh.leanToolPayload === true;') >= 0,
    "设置 · 智能能力有「精简工具负载」勾选项（默认关）");
  ok(SET.indexOf("leanToolPayload: dshEls.leanToolPayload") >= 0, "collect() 落盘 leanToolPayload（保存设置才生效）");
  const DB = read("renderer/app-db.js");
  ok(DB.indexOf("function dshLeanToolsOn()") >= 0 && DB.indexOf("S.config.dsh.leanToolPayload") >= 0,
    "开关的唯一读点 dshLeanToolsOn()（不在多处各读一遍配置）");
  ok(DB.indexOf("const noCanvasOn = (nodeLock || canvasFreeOn) && !pureOn;") >= 0,
    "画布智能节点（nodeLock）**或**用户声明与画布无关（canvasFreeOn）→ noCanvas 恒开，与设置开关互不牵连");
  ok(DB.indexOf("const canvasFreeOn = !!opts.noCanvas && !pureOn;") >= 0,
    "「与画布无关」是独立的一条来源（opts.noCanvas），pure 轮同样归零");
  ok(DB.indexOf("lean: leanOn,") >= 0 && DB.indexOf("noCanvas: noCanvasOn,") >= 0,
    "两个标记随 runParams 下发网关");
  ok(DB.indexOf("p.lean ? 1 : 0,") >= 0 && DB.indexOf("p.noCanvas ? 1 : 0,") >= 0,
    "两个标记进本轮配置指纹（改档 = 网关换 runtime → 判整轮重发，不假装续跑）");
  ok(DB.indexOf('const leanOn = dshLeanToolsOn() && !pureOn;') >= 0, "pure 轮不下发裁剪标记（画布工具本就被禁）");
  const ASSIST = read("renderer/app-assist.js");
  ok(ASSIST.indexOf("lean: typeof dshLeanToolsOn === \"function\" ? dshLeanToolsOn() : false,") >= 0,
    "助手侧签名与 dshRunOnce 同口径（否则分节快照长期对不上）");
  const I18N = read("renderer/i18n.js");
  const leanLabel = (SET.match(/"(精简工具负载[^"]*)"/) || [, ""])[1];
  ok(!!leanLabel, "设置项有走 I18n.t 的中文文案（不写死中文串）");
  ok(
    !!leanLabel && I18N.indexOf('"' + leanLabel + '": "Lean tool payload') >= 0,
    "新 UI 文案的 i18n 键与界面逐字一致，且有英文词条（不做只含中文的孤儿串）",
  );

  /* ==================== [8] 审计脚本 ==================== */
  console.log("\n[8] scripts/audit-token-usage.mjs（账单可复测：优化前后各跑一次）");
  const AUDIT_PATH = abs("scripts/audit-token-usage.mjs");
  ok(fs.existsSync(AUDIT_PATH), "审计脚本在位（AGENTS.md 归入「诊断脚本 · 只读」）");
  const AUDIT = fs.existsSync(AUDIT_PATH) ? fs.readFileSync(AUDIT_PATH, "utf8") : "";
  for (const [needle, why] of [
    ["session.jsonl", "读 dsh 会话日志本体"],
    ["zstd", "压缩日志也能读"],
    ["request/header", "按 header 量固定前缀（system + 逐个工具字符数）"],
    ["assistant/message.usage", "按步统计 prompt 与增量"],
    ["tool/result", "按工具归集返回体积"],
    ["cacheRead", "缓存命中口径（命中率是这轮优化的分母）"],
    ["reasoningTokens", "思考文本量单独统计"],
  ]) {
    ok(AUDIT.indexOf(needle) >= 0, "审计口径含 " + needle + "（" + why + "）");
  }
  const AGENTS = read("AGENTS.md");
  ok(AGENTS.indexOf("audit-token-usage.mjs") >= 0, "AGENTS.md 已把它登记为诊断脚本（后续会话找得到）");
  ok(AGENTS.indexOf("提示词单一真源") >= 0, "AGENTS.md 的「提示词单一真源」约定在位（防规则再被抄第二份）");

  /* ============ [9] 按名字的隐藏名单（第三个闸）：两个闸的分工 + 助手快照 + 签名 ============ */
  console.log("\n[9] 隐藏名单：Gate A 点名裁读图 / Gate B 整档裁三件套 / 名字不重复 / 都进签名");
  const DB_SRC = readN("renderer/app-db.js");
  const APP_SRC = readN("renderer/app.js");
  const ASSIST_SRC = readN("renderer/app-assist.js");
  const NODES_SRC = readN("renderer/app-nodes.js");
  const TV = await import(pathToFileURL(abs("dsh/gateway/tool-visibility.mjs")).href);
  ok(TV.HIDE_ENV === HIDE_ENV, "spawn env 名以 tool-visibility.mjs 为真源（测试不各写一份字面量）");

  /* —— 名单一致性：宿主点名的每一个名字都必须在网关白名单里
        （否则被静默丢弃 = 既省不到 token，又让人设里那句「它不存在」变成假话）—— */
  const LIST_LEAN = grabStringList(DB_SRC, "DSH_TOOLS_DROPPED_BY_LEAN", "app-db.js");
  const LIST_NOCANVAS = grabStringList(DB_SRC, "DSH_TOOLS_DROPPED_BY_NO_CANVAS", "app-db.js");
  const LIST_NOREAD = grabStringList(DB_SRC, "DSH_TOOLS_DROPPED_BY_NO_READ", "app-db.js");
  ok(eq(LIST_NOREAD, ["mtnode_canvas_get", "mtnode_app"]),
    "Gate A 只点名「读画布」两件套：mtnode_canvas_get + mtnode_app（改图的 edit 必须留着收尾回写）");
  for (const [label, list] of [
    ["LEAN", LIST_LEAN],
    ["NO_CANVAS", LIST_NOCANVAS],
    ["NO_READ", LIST_NOREAD],
  ]) {
    const unknown = list.filter((n) => TV.HIDEABLE_TOOLS.indexOf(n) < 0);
    ok(unknown.length === 0,
      "DSH_TOOLS_DROPPED_BY_" + label + " 点名的名字全在网关白名单内" + (unknown.length ? "（多出：" + unknown.join(",") + "）" : ""));
  }
  const deniedSrc = grabFunction(NODES_SRC, "agentDeniedToolNames", "app-nodes.js");
  const pushed = [];
  const pushRe = /\.push\(([^)]*)\)/g;
  let pm;
  while ((pm = pushRe.exec(deniedSrc))) {
    for (const s of pm[1].match(/"([^"]+)"/g) || []) pushed.push(s.slice(1, -1));
  }
  ok(pushed.length >= 12, "工具许可 → 工具名的映射仍点名 " + pushed.length + " 个名字（拒绝某类 = 整本说明书不发）");
  /* 识图单入口：dsh 引擎自带的 read_image 与许可无关，任何一轮都摘 —— 写在早退之前，
     否则「一个类别都没拒」的轮次会把名字漏掉（那时正是它最该被裁的轮次）。 */
  const readImageAt = deniedSrc.indexOf('out.push("read_image")');
  const earlyReturnAt = deniedSrc.indexOf("if (!denied.length) return");
  ok(readImageAt >= 0 && earlyReturnAt > readImageAt,
    "read_image 无条件进隐藏名单，且在「没有拒绝项就早退」之前（会话里只留 mtnode_vision 一个识图入口）");
  /* 名字必须在网关可裁白名单内：不在白名单就会被 normalizeHiddenTools 静默丢弃 ——
     宿主以为藏了、运行时其实照发（识图单入口失效，每步还白付一份 schema）。 */
  ok(TV.HIDEABLE_TOOLS.indexOf("read_image") >= 0 &&
      TV.normalizeHiddenTools("read_image").indexOf("read_image") >= 0 &&
      TV.hiddenToolsEnvValue(["read_image"]) === "read_image",
    "read_image 在网关可裁白名单内且能穿过归一（点名不会被静默丢弃）");
  const denyBad = pushed.filter((n) => TV.HIDEABLE_TOOLS.indexOf(n) < 0);
  ok(denyBad.length === 0, "agentDeniedToolNames 只产出白名单内的名字" + (denyBad.length ? "（多出：" + denyBad.join(",") + "）" : ""));

  /* —— 渲染层真行为：把 dshHiddenToolsFor 原样搬进 vm 沙箱跑，断言算出来的名单 —— */
  const hideFnSrc = grabFunction(DB_SRC, "dshHiddenToolsFor", "app-db.js");
  function makeHidden(deny) {
    const ctx = vm.createContext({
      DSH_TOOLS_DROPPED_BY_LEAN: LIST_LEAN,
      DSH_TOOLS_DROPPED_BY_NO_CANVAS: LIST_NOCANVAS,
      DSH_TOOLS_DROPPED_BY_NO_READ: LIST_NOREAD,
      agentDeniedToolNames: () => (deny || []).slice(),
      Array, JSON, Object, String,
    });
    return vm.runInContext(hideFnSrc + "\n(dshHiddenToolsFor)", ctx, {
      filename: "renderer/app-db.js#hidden-tools",
    });
  }
  const hidden = makeHidden([]);
  /* ltGrounded 缺省按 true 传：这五个断言考的是 Gate A / Gate B / db 三件事，
     长任务那两件套另开断言（下面 LT 两条），别把不相关的名字混进期望值里。 */
  const ROUND0 = { pure: false, dbGrounded: true, lean: false, noCanvas: false, noCanvasRead: false, ltGrounded: true };
  ok(eq(hidden(Object.assign({}, ROUND0)), []),
    "对照轮（未打标 / 已接库）名单为空 → 细化、问询与普通会话的可见集一字不变（本闸默认不动任何东西）");
  const noReadList = hidden({ pure: false, dbGrounded: true, lean: false, noCanvas: false, noCanvasRead: true, ltGrounded: true });
  ok(eq(noReadList, ["mtnode_app", "mtnode_canvas_get"]),
    "noCanvasRead 轮的隐藏名单恰为排序后的 mtnode_app,mtnode_canvas_get（字典序 → 同档每轮逐字相同）");
  ok(eq(hidden({ pure: false, dbGrounded: true, lean: true, noCanvas: false, noCanvasRead: true, ltGrounded: true }), ["mtnode_canvas_get"]),
    "lean 已整档裁掉 mtnode_app 时名单只剩 mtnode_canvas_get（covered 判据按名字算，同一件事不说两遍）");
  ok(eq(hidden({ pure: false, dbGrounded: true, lean: false, noCanvas: true, noCanvasRead: true, ltGrounded: true }), []),
    "canvasFree（整档闸）已裁三件套 → 那两个名字不再重复进 hideTools 名单");
  ok(eq(hidden({ pure: false, dbGrounded: false, lean: false, noCanvas: false, noCanvasRead: true, ltGrounded: true }), ["mtnode_app", "mtnode_canvas_get", "mtnode_db"]),
    "没接数据库副本时 mtnode_db 与读图两件套并进同一份名单（一次归一：去重 + 排序）");
  ok(eq(hidden({ pure: true, dbGrounded: false, lean: false, noCanvas: false, noCanvasRead: true }), []),
    "pure 轮名单归零（画布 / 数据库插件本就被 cordis 整体禁用，点名无意义）");
  ok(eq(makeHidden(["mtnode_canvas_get", "mtnode_app"])(Object.assign({}, ROUND0, { noCanvasRead: true })), noReadList),
    "工具许可拒绝与 Gate A 撞出的同名条目去重后仍是同一份名单（runtime key 才不会每轮漂移）");
  /* —— 长周期任务工具（app-longtask.js）：同一个闸，判据是「这轮是不是状态机里的一环」。
       lt_memory 已下线（长期记忆沉淀改走 mtnode_facts），名单里只剩 lt_state 一个名字 —— */
  const LT_NAMES = ["lt_state"];
  ok(eq(LT_NAMES.filter((n) => TV.HIDEABLE_TOOLS.indexOf(n) < 0), []),
    "lt_state 在网关可裁白名单内（藏了才真的不发，不然只是名字好看）");
  ok(eq(hidden({ pure: false, dbGrounded: true, lean: false, noCanvas: false, noCanvasRead: false }), LT_NAMES),
    "普通会话（没接地长任务）把 lt_state 点名藏掉：宿主只会回「不属于任何长任务」，白占每步定义");
  ok(eq(hidden({ pure: false, dbGrounded: true, lean: false, noCanvas: false, noCanvasRead: false, ltGrounded: true }), []),
    "长任务轮（伪节点带 _lt → ltGrounded）lt_state 回到可见集");
  ok(hidden({ pure: true, dbGrounded: false, ltGrounded: false }).length === 0,
    "pure 轮即便没接地长任务也不点名（插件本来就不注册）");
  has(DB_SRC, "ltGrounded: !!(opts.node && opts.node._lt),",
    "判据只看伪节点标记：普通会话 / 助手 / 普通智能节点不传该字段，名字进名单，改的是新增工具的可见集，不动既有轮的其余成分");
  has(DB_SRC, 'if (msg.type === "lt") {', "lt 帧在 dshRunTask 的事件分派里有独立分支（与 db / tool-run 同一口径）");
  has(DB_SRC, "window.LT.handleToolEvent(msg.data || {}, opts.node, boundWf)", "lt 帧交给长任务模块应答（宿主才是 run 与记忆的真源）");

  /* —— 端到端：宿主算出的名单打进 spawn env，注册口掉的恰好就是这两个 —— */
  ok(eq(namesOf({ [HIDE_ENV]: noReadList.join(",") }), ["mtnode_canvas_edit", "mtnode_vision"]),
    "名单 → env → 注册口全链一致：开发绑定轮只剩改图 + 识图（约 10.0K 字符/步不再重发）");
  ok(GATE.indexOf("'|hx:' + hxHash") >= 0 && GATE.indexOf("if (hiddenEnv) env[HIDE_TOOLS_ENV] = hiddenEnv") >= 0,
    "网关把规范名单同时打进 runtime key 的 hx: 指纹与 spawn env（换档 = 冷起一台自己的运行时）");
  ok(GATE.indexOf("【本轮不注册的工具】") >= 0, "名单通道也补一句「这些工具不存在」（模型不会去撞没有的工具）");

  /* —— 渲染层下发：Gate A 只走名单、Gate B 走整档闸且不再重复点名 —— */
  has(DB_SRC, "const noReadOn = !!opts.noCanvasRead && !pureOn && !canvasFreeOn;",
    "canvasFree 已开时 noReadOn 归零：三件套本来就不注册，不必再点名（上一条名单断言的前提）");
  has(DB_SRC, "noCanvasRead: noReadOn,", "dshRunOnce 把归一后的 Gate A 标记喂给 dshHiddenToolsFor");
  has(DB_SRC, "noCanvas: noCanvasOn,", "runParams.noCanvas = nodeLock ∪ canvasFreeOn（Gate B 勾选即 1）");
  has(DB_SRC, "hideTools: hideToolsOn.length ? hideToolsOn : undefined,", "空名单不下发（老网关走同一条路径，可见集一字不变）");
  has(ASSIST_SRC, "noCanvasRead: !!st.noCanvasRead,", "会话侧 Gate A 随落盘标记开轮（轮内不变 → 同档每步前缀一致）");
  has(ASSIST_SRC, "noCanvas: turnCanvasFree,", "会话侧 Gate B（按消息自动判定）→ runParams.noCanvas 为 1（判据只算一次，人设与下发同源）");
  has(ASSIST_SRC, "const turnCanvasFree =", "会话侧判定值就是 turnCanvasFree（判据真源 = agentCanvasTurnRelated）");
  has(ASSIST_SRC, "function agentCanvasTurnRelated(text, hist)", "自动判定函数在位（撤掉手动「与画布无关」按钮后的唯一判据）");
  has(ASSIST_SRC, "const assistCanvasFree = !assistCanvasTurnRelated(t);", "助手栏同样按这条消息自动判定（同一个判据函数，不再读 S.assistCanvasFree）");
  has(ASSIST_SRC, "function assistCanvasTurnRelated(text) {", "助手侧判据包装在位（转发给 agentCanvasTurnRelated，助手没有会话历史）");
  has(ASSIST_SRC, "noCanvas: assistCanvasFree,", "助手栏判据命中即走整档闸（判据只定一次，往下全用同一个值）");
  has(ASSIST_SRC, "await assistAppSnapshot({ canvasFree: assistCanvasFree })", "app_state 的取值与 Gate B 同源（判据不分叉）");
  has(ASSIST_SRC, "app_state: appStateBlock,", "应用状态单独成节（每轮都变的最大头，才谈得上单独 diff）");
  const devSess = grabFunction(APP_SRC, "createDevSessionForNode", "app.js");
  has(devSess, 'noCanvasRead: mode === "dev",', "Gate A 只在「开发」轮打标：细化（refine）轮不裁读图");
  const askSess = grabRegion(APP_SRC, "async function startDevAskSession(node, question) {", "app.js");
  ok(askSess.length > 0 && askSess.indexOf("noCanvasRead") < 0 && askSess.indexOf("canvasFree") < 0,
    "问询轮建会话时两个标记都不置位 → 可见集与改造前完全一致（它本来要在图上调研架构）");

  /* —— 签名：三个可见集通道都进 runSig（真跑 dshRunSigOf，断言漂移必换指纹）—— */
  const sigCtx = vm.createContext({ dbHash: (s) => "h:" + String(s), Math, String });
  const sigFn = vm.runInContext(
    grabFunction(DB_SRC, "dshRunSigOf", "app-db.js") + "\n(dshRunSigOf)",
    sigCtx,
    { filename: "renderer/app-db.js#run-sig" },
  );
  const sig = (o) => sigFn(Object.assign({ workspace: "w", model: "m", provider: "p", preset: "minimal", effort: "high", pure: false }, o));
  ok(typeof sigFn === "function", "dshRunSigOf 能在沙箱里真跑（下面断言的是行为，不是源码字面量）");
  ok(sig({ lean: true }) !== sig({ lean: false }), "lean 标记进签名（改档 = 网关换 runtime → 判整轮重发，不假装续跑）");
  ok(sig({ noCanvas: true }) !== sig({ noCanvas: false }), "noCanvas 标记进签名");
  ok(sig({ hide: noReadList.join(",") }) !== sig({ hide: "" }),
    "hideTools 名单进签名：开发绑定轮与全量轮不是同一指纹");
  ok(sig({ hide: "mtnode_app,mtnode_canvas_get" }) === sig({ hide: "mtnode_app,mtnode_canvas_get" }),
    "同一份名单每轮算出同一签名（排序稳定 → 同档会话共享一台运行时、每步前缀一致）");
  ok(sig({ hide: "mtnode_app,mtnode_canvas_get" }) !== sig({ hide: "mtnode_canvas_get,mtnode_app" }),
    "签名按名单原文比对（乱序 = 换签名 = 冷起）：绝不把别的可见集的上下文当同配置续跑");
  const sigBody = grabFunction(DB_SRC, "dshRunSigOf", "app-db.js");
  ok(
    sigBody.indexOf("p.lean ? 1 : 0,") < sigBody.indexOf("p.noCanvas ? 1 : 0,") &&
      sigBody.indexOf("p.noCanvas ? 1 : 0,") < sigBody.indexOf('p.hide || "",'),
    "三个通道在签名里各占一位且顺序固定（lean → noCanvas → hide，与网关 lean:/nc:/hx: 同序）",
  );
  has(DB_SRC, 'hide: hideToolsOn.join(","),', "会话侧 runSig 传的是算好的名单原文");
  has(ASSIST_SRC, "hide: assistHide,", "助手侧签名喂同一条通道（否则开关一开，分节快照与真实运行签名长期对不上）");

  /* —— 助手 app_state：只给计数 + 选中 / 焦点，两档都不取整图快照 —— */
  /* 快照函数在 vm 沙箱里真跑（源文件那段真代码），canvasSnapshotFull / canvasSnapshot
     都换成记账 stub：本轮改动之后它们一次都不该被调用 —— 只要有人把「取整图」加回来，
     下面「两档全图调用 = 0」立刻失败。 */
  const NODE_BODY_KEYS = grabStringList(NODES_SRC, "NODE_BODY_KEYS", "app-nodes.js");
  ok(
    eq(NODE_BODY_KEYS, ["text", "prompt", "task", "goal", "jscode"]),
    "正文键真源 = text/prompt/task/goal/jscode（下面「一个正文键都不带」正是按这五键断言）",
  );
  const BODY = "超长正文".repeat(100); /* 单字段 400 字符 */
  function runAppSnapshot(canvasFree) {
    const bigNodes = [];
    for (let i = 0; i < 120; i++) {
      bigNodes.push({
        id: "n" + i,
        kind: "proc_text",
        title: "节点" + i,
        x: i,
        y: i,
        text: BODY,
        prompt: BODY,
        task: BODY,
        goal: BODY,
        jscode: BODY,
      });
    }
    const wires = bigNodes.slice(0, 119).map((n, i) => ({ from: n.id, to: bigNodes[i + 1].id }));
    /* 记账 stub：本轮改动后助手快照不该再碰它一次 */
    let fullCalls = 0;
    const optsSeen = [];
    const grab = (opts) => {
      fullCalls++;
      optsSeen.push(opts || null);
      return Promise.resolve({ nodes: bigNodes, wires });
    };
    const ctx = vm.createContext({
      currentSelection: () => [{ id: "n0", kind: "proc_text", title: "节点0" }],
      currentTaskFocus: () => "t1",
      currentSuperFocus: () => "s1",
      assistScopeIsCurrent: () => true,
      canvasSnapshotFull: grab,
      canvasSnapshot: grab,
      agentToolAllowed: () => true,
      agentToolCatalog: () => [],
      agentToolPresetStatusText: () => "全部允许",
      agentSessions: () => [],
      I18n: { getLocale: () => "zh-CN" },
      S: {
        view: "canvas",
        sidebarOpen: false,
        assistOpen: true,
        wf: { id: "wf1", name: "画布一", nodes: bigNodes, wires, groups: [{ id: "g1" }], workspace: "E:\\tmp\\p" },
        config: { providers: [], dsh: {} },
      },
    });
    const fn = vm.runInContext(
      grabFunction(ASSIST_SRC, "assistAppSnapshot", "app-assist.js") + "\n(assistAppSnapshot)",
      ctx,
      { filename: "renderer/app-assist.js#app-snapshot" },
    );
    return Promise.resolve(fn({ canvasFree })).then((got) => ({ got, fullCalls, optsSeen }));
  }
  const fullRound = await runAppSnapshot(false);
  const freeRound = await runAppSnapshot(true);
  const fGot = freeRound.got;
  /* 画布快照字段一个都不该出现在 app_state 里（两档都一样） */
  const CANVAS_SNAP_KEYS = [
    "nodes", "wires", "marks", "groups", "cam", "workflows",
    "imageSizes", "markColors", "devFuncColors", "defaultImageSize", "scopeNote",
  ];
  ok(fullRound.fullCalls === 0 && freeRound.fullCalls === 0,
    "两档都不再取整图快照（canvasSnapshotFull / canvasSnapshot 零调用）：节点索引改由模型按需 canvas_get 现拉");
  const leaked = CANVAS_SNAP_KEYS.filter((k) => k in fGot);
  ok(leaked.length === 0,
    "canvas-free 轮的 app_state 里没有任何画布快照字段（一个都不该留）" + (leaked.length ? "：漏 " + leaked.join(",") : ""));
  ok(fGot.canvasFree === true, "快照里明写 canvasFree: true（模型看到这一位就不再尝试画布操作，人设同步说了）");
  ok(fGot.nodeCount === 120 && fGot.wireCount === 119 && fGot.groupCount === 1,
    "画布摘要只给计数：只到「有哪张图、多大」这一级，节点列表一个字段都不发");
  ok(!!fGot.workflow && fGot.workflow.name === "画布一" && fGot.workflow.nodeCount === 120,
    "仍带本画布身份与工作区（归属可核对，不至于凭空猜图）");
  ok(!("selection" in fGot) && !("taskFocus" in fGot) && !("superFocus" in fGot),
    "canvas-free 轮连选中 / 焦点都不给（本轮声明与画布无关）");
  ok(fGot.tools.safe.length === 0 && fGot.tools.confirm.length === 0,
    "canvas-free 轮不把画布 / 应用工具列进 safe / confirm（留着就是让模型去撞没注册的工具）");
  const fullJson = JSON.stringify(fullRound.got);
  const freeJson = JSON.stringify(fGot);
  const fullLeaked = CANVAS_SNAP_KEYS.filter((k) => k in fullRound.got);
  ok(fullLeaked.length === 0,
    "非 canvas-free 轮也不带任何画布快照字段（62 节点索引不再随系统提示每轮重发）" +
      (fullLeaked.length ? "：漏 " + fullLeaked.join(",") : ""));
  ok(Array.isArray(fullRound.got.selection) && fullRound.got.selection.length === 1 &&
      fullRound.got.selection[0].id === "n0",
    "选中节点以最小描述带上（id/kind/title）");
  ok(fullRound.got.taskFocus === "t1" && fullRound.got.superFocus === "s1",
    "taskFocus / superFocus 以最小描述带上（模型知道此刻聚焦在哪颗壳 / 哪条计划）");
  const bodyLeak = [];
  (function walk(v, path) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, path + "[" + i + "]"));
      return;
    }
    for (const k of Object.keys(v)) {
      if (NODE_BODY_KEYS.indexOf(k) >= 0) bodyLeak.push(path + "." + k);
      walk(v[k], path + "." + k);
    }
  })(fullRound.got, "");
  ok(
    bodyLeak.length === 0,
    "非 canvas-free 轮的 app_state 里没有任何正文键（text / prompt / task / goal / jscode）" +
      (bodyLeak.length ? "：漏 " + bodyLeak.slice(0, 4).join(",") : ""),
  );
  ok(fullJson.indexOf(BODY) < 0, "超长正文本身一个字节都没进 app_state（不只是字段名被摘掉）");
  const RAW_BODY_CHARS = 120 * NODE_BODY_KEYS.length * BODY.length;
  ok(
    fullJson.length <= 3000 && RAW_BODY_CHARS > fullJson.length * 50,
    "同一张图：节点正文合计 " + RAW_BODY_CHARS + " 字符 → app_state 仅 " + fullJson.length +
      " 字符（只给计数 + 选中 / 焦点，列表与正文一律按需 canvas_get）",
  );
  ok(freeJson.length < fullJson.length,
    "canvas-free 轮仍更轻：app_state 从 " + fullJson.length + " 字符降到 " + freeJson.length +
      " 字符（连选中 / 焦点都不带）");

  /* ===== [10] 本轮落地：edit 回执自足 / detail:diff / 端子预检 / 收尾校验 / 读图缓存 ===== */
  console.log("\n[10] edit 回执自足 + detail:diff + 端子预检 + 收尾一次性校验 + canvas_get 缓存");
  const PLUGIN_N = readN("dsh/gateway/canvas-plugin.mjs");

  /* —— edit 回执：真跑网关的纯函数 editSummary / editNodeReceipt / clipLabel —— */
  const summaryFn = vm.runInContext(
    [
      grabFunction(PLUGIN_N, "clipLabel", "canvas-plugin.mjs"),
      grabFunction(PLUGIN_N, "editNodeReceipt", "canvas-plugin.mjs"),
      grabFunction(PLUGIN_N, "editSummary", "canvas-plugin.mjs"),
      "(editSummary)",
    ].join("\n"),
    vm.createContext({ String, Object, Array, JSON, Number, Math }),
    { filename: "canvas-plugin.mjs#edit-summary" },
  );
  const EDIT_VALUE = {
    ok: true,
    created: [
      {
        alias: "a1", id: "n1", kind: "proc_image", title: "图", x: 10, y: 20, w: 240, h: 160,
        ports: { in: [{ i: 0, name: "提示词", kind: "text", n: 1 }], out: [{ i: 0, name: "图像", kind: "image", n: 0 }] },
      },
    ],
    updated: [{ id: "n2", kind: "proc_text", title: "文", x: 1, y: 2, w: 3, h: 4, ports: { in: [], out: [] } }],
    connected: [{ fromTitle: "甲", toTitle: "乙" }],
    removed: ["n9"],
    createdMarks: [], updatedMarks: [], removedMarks: [],
    warnings: ["w1"],
  };
  const sum = summaryFn(EDIT_VALUE);
  ok(
    sum.created[0].x === 10 && sum.created[0].y === 20 && sum.created[0].w === 240 && sum.created[0].h === 160,
    "edit 回执 created[] 自带 x/y/w/h（改完不必回读画布就知道摆在哪、多大）",
  );
  ok(
    sum.created[0].ports && sum.created[0].ports.in[0].name === "提示词" && sum.created[0].ports.out[0].kind === "image",
    "edit 回执带端口占用摘要（端子 index/name/kind/已连数）",
  );
  ok(
    sum.updated[0].x === 1 && sum.updated[0].w === 3 && !!sum.updated[0].ports && sum.updated[0].ports.in.length === 0,
    "updated[] 同样自足（位置 / 尺寸 / 端口摘要）",
  );
  ok(
    sum.counts && sum.counts.created === 1 && /无需回读/.test(sum.hint || ""),
    "summary 口径：计数 + hint 明说回执已自足、无需回读",
  );
  const sumDiff = summaryFn(EDIT_VALUE, "diff");
  ok(
    !("counts" in sumDiff) && !("hint" in sumDiff),
    "detail:\"diff\" 只回明细，不回计数摘要与提示（同类任务的窄口径回执）",
  );
  ok(
    sumDiff.created.length === 1 && sumDiff.updated.length === 1 && sumDiff.connected.length === 1 &&
      sumDiff.removed.length === 1 && sumDiff.warnings[0] === "w1",
    "diff 明细含 created / updated / connected / removed + warnings",
  );
  ok(
    EDIT_PARAMS.detail && eq(EDIT_PARAMS.detail.enum, ["summary", "diff"]),
    "edit 的 detail 参数在 schema 里（enum summary / diff，与回执实现同源）",
  );

  /* —— 端子预检 + 路径约束 + 收尾一次性校验：把 app-nodes.js 的真函数搬进沙箱跑 —— */
  const NODES_I18N = require(path.join(__dirname, "..", "renderer", "i18n.js"));
  const SNAPSHOT_PORT_KINDS = grabStringList(NODES_SRC, "SNAPSHOT_PORT_KINDS", "app-nodes.js");
  const SINGLE_DATA_IN_KINDS = grabStringList(NODES_SRC, "SINGLE_DATA_IN_KINDS", "app-nodes.js");
  /* 端子随连线增量涨的类别名单（snapshotInputGrowsWithWires 的判据）：同样从源码抽 */
  const INCREMENTAL_PORT_KINDS = grabStringList(NODES_SRC, "INCREMENTAL_PORT_KINDS", "app-nodes.js");
  /* 控制族名单（真源 app.js isControlKind）：沙箱里照实体建模，不写死成「恒 false」——
     portRule 的判据用到它，桩失真会让「控制类节点不给端子规则」这条断言假失败。 */
  const CONTROL_KINDS = ["control", "wait_file", "timer", "delayer", "sequencer", "gate", "splitter", "counter", "mutex", "judge", "task"];
  const PORT_WF = {
    nodes: [
      { id: "up", kind: "proc_text", title: "上游", x: 0, y: 0, w: 200, h: 120 },
      { id: "vid", kind: "video_gen", title: "视频", x: 0, y: 200, w: 240, h: 160 },
      { id: "rem", kind: "remotion", title: "动效", x: 0, y: 400, w: 240, h: 160 },
      { id: "pi", kind: "proc_image", title: "图", x: 0, y: 600, w: 240, h: 160, prompt: "generate several images" },
      { id: "ag", kind: "agent_task", title: "智能", x: 400, y: 0, w: 240, h: 160 },
      /* 泛用增量端子的普通输入节点（不在 ports 名单里）：portRule 这一支的主要消费者之一 */
      { id: "in", kind: "input_text", title: "文本", x: 600, y: 0, w: 240, h: 160, text: "正文" },
      { id: "sv", kind: "save", title: "存", x: 400, y: 200, w: 240, h: 160, savePath: "out.wav" },
      /* 素材节点：端子数 = 内容条目数（第 i 入 ↔ 第 i 出），端子名 = 条目标题、
         类型 = 条目类型 —— 条目即端子，这一支必须进 ports 预检（见下面 asset 断言） */
      { id: "as", kind: "asset", title: "素材", x: 400, y: 400, w: 240, h: 160, assetId: "a1",
        items: [{ id: "i1", title: "开场白", type: "text" }, { id: "i2", title: "封面", type: "image" }] },
    ],
    wires: [
      { id: "w1", from: "up", to: "vid", toIndex: 1, fromIndex: 0 },
      { id: "w2", from: "ag", to: "pi", toIndex: 1, fromIndex: 0 },
      { id: "w3", from: "up", to: "as", toIndex: 0, fromIndex: 0 },
    ],
  };
  const portById = (id) => PORT_WF.nodes.filter((n) => n.id === id || n.title === id)[0] || null;
  const editCtx = vm.createContext({
    S: { wf: PORT_WF },
    nodeById: portById,
    /* 端子数量按各 kind 的最小可用口径给桩；命名 / 类型 / 占用仍跑真源码。
       video_gen 按 v5 布局给 4 槽：控制输入（端口 0）· 1 提示词 · 2–3 首末帧；
       素材节点端子数 = 内容条目数（入出同一数法） */
    inputCount: (n) =>
      n && n.kind === "asset"
        ? (n.items || []).length
        : n && n.kind === "video_gen"
          ? 4
          : ["remotion", "proc_image"].indexOf(n.kind) >= 0
            ? 2
            : 1,
    /* video_gen 端子排：控制口固定在端口 0（第一个）· 数据端口 1..N ≡ 数据槽号。
       这里按内置 FL2VA 口径给桩（真实函数在 app.js，依赖 videoGenMode / videoGenMax* 一族） */
    videoGenControlPort: () => 0,
    /* 分段衔接端子（内置 FL2VA / R2V 开 chainEnabled 才多一个槽）：本用例的 video_gen 未开，恒 0 */
    videoGenMaxChains: () => 0,
    /* 衔接槽位置真源（videoGenSlotMeta 会问它）：没有这个槽 → 0 */
    videoGenChainSlotIndex: () => 0,
    outputCount: (n) => (n && n.kind === "asset" ? (n.items || []).length : 1),
    isFnToolNode: () => false,
    /* 「泛用增量端子」的真源算法（app.js inputCount 末行）：端口数 = 已连数据线 + 1。
       portRule 的名单闸之外还要核这一道，桩必须给真算法，否则判据失真。 */
    allWiresTo: (id) => (PORT_WF.wires || []).filter((w) => w.to === id),
    /* 素材节点（kind "asset"）：条目即端子（第 i 入 ↔ 第 i 出）。
       判定与条目读取取最小桩（真源在 app.js isAssetNode / assetItems），
       本用例的 as 节点带两条目 → 入出各 2 个端子，命名 / 类型 / 占用跑真源码。 */
    isAssetNode: (n) => !!(n && n.kind === "asset"),
    assetItems: (n) =>
      (n && Array.isArray(n.items) ? n.items : []).map((it, i) => ({
        id: String((it && it.id) || ""),
        title: String((it && it.title) || "").trim() || "内容 " + (i + 1),
        type: String((it && it.type) || "text"),
      })),
    assetPortKind: (node, dir, idx) => {
      const items = node && Array.isArray(node.items) ? node.items : [];
      const i = Number(idx);
      return isFinite(i) && i >= 0 && i < items.length
        ? String((items[i] && items[i].type) || "text")
        : null;
    },
    snapshotAssetNodeOf: () => undefined,
    assetItemViewGet: () => null,
    assetItemViewLoaded: () => null,
    isVideoPostKind: () => false,
    /* 控制族判定桩：真源是 app.js isControlKind（control / wait_file / timer / delayer /
       sequencer / gate / splitter / counter / mutex / judge / task）。必须照实体建模 ——
       portRule 的判据之一就是它（控制类端子由结构钉死，不算「随连线增量」）。 */
    isControlKind: (n) => CONTROL_KINDS.indexOf(String((n && n.kind) || "")) >= 0,
    fnToolPortKind: () => "any",
    fnToolParamList: () => [],
    SINGLE_DATA_IN_KINDS,
    SNAPSHOT_PORT_KINDS,
    INCREMENTAL_PORT_KINDS,
    I18n: {
      t: (k, vars) => {
        let s = NODES_I18N.t(k);
        if (vars && typeof vars === "object")
          s = s.replace(/\{(\w+)\}/g, (_, kk) => (vars[kk] == null ? "" : String(vars[kk])));
        return s;
      },
    },
    /* 收尾校验的依赖桩：让五个分支都能被走到（判定真源仍是被 grab 的真函数） */
    warnBatchCartesianRisk: (w) => { w.push("批量 N² 警告"); },
    isSaveNode: (n) => !!(n && n.kind === "save"),
    saveDataSources: (n) => (n && n.kind === "save" ? [portById("ag"), portById("ag")] : []),
    saveMediaCertain: () => true,
    saveMediaKind: () => "image",
    saveExtForMedia: () => ".png",
    forcePathExt: (p, e) => String(p).replace(/\.[^./\\]*$/, "") + e,
    extOf: (p) => {
      const m = String(p).match(/\.[^./\\]+$/);
      return m ? m[0] : "";
    },
    connectError: (_from, to) => (to === "vid" || to === "pi" ? "输入端子已被占用" : ""),
    String, Object, Array, JSON, Number, Math, Set, RegExp, Error, console,
  });
  const editApi = vm.runInContext(
    [
      "(function () {",
      grabFunction(NODES_SRC, "editPortNameOf", "app-nodes.js"),
      grabFunction(NODES_SRC, "editPortKindOf", "app-nodes.js"),
      grabFunction(NODES_SRC, "nodePortList", "app-nodes.js"),
      grabFunction(NODES_SRC, "snapshotHasFixedPorts", "app-nodes.js"),
      grabFunction(NODES_SRC, "snapshotPortsOf", "app-nodes.js"),
      grabFunction(NODES_SRC, "snapshotInputGrowsWithWires", "app-nodes.js"),
      grabFunction(NODES_SRC, "snapshotDynamicPortRule", "app-nodes.js"),
      grabFunction(NODES_SRC, "connectPortAdvice", "app-nodes.js"),
      grabFunction(NODES_SRC, "looksLikeMultiImagePrompt", "app-nodes.js"),
      grabFunction(NODES_SRC, "warnIfProcImageMultiPrompt", "app-nodes.js"),
      grabFunction(NODES_SRC, "saveMediaClassOfExt", "app-nodes.js"),
      grabFunction(NODES_SRC, "savePathExtWarning", "app-nodes.js"),
      grabFunction(NODES_SRC, "isSmartAgentNode", "app-nodes.js"),
      grabFunction(NODES_SRC, "wireStaticError", "app-nodes.js"),
      grabFunction(NODES_SRC, "collectEditStaticWarnings", "app-nodes.js"),
      "return { nodePortList, snapshotPortsOf, snapshotHasFixedPorts, snapshotDynamicPortRule, connectPortAdvice, saveMediaClassOfExt, savePathExtWarning, collectEditStaticWarnings };",
      "})()",
    ].join("\n"),
    editCtx,
    { filename: "renderer/app-nodes.js#edit-precheck" },
  );

  const vidPorts = editApi.snapshotPortsOf(portById("vid"));
  const vidIn1 = vidPorts ? vidPorts.filter((p) => p.dir === "in" && p.index === 1)[0] : null;
  ok(
    Array.isArray(vidPorts) && vidPorts.length === 5 && vidIn1 && vidIn1.connectedTo &&
      vidIn1.connectedTo[0].node === "上游",
    "canvasSnapshot 对固定端子节点暴露 ports（含 connectedTo 指向的上游标题）",
  );
  ok(
    editApi.snapshotPortsOf(portById("up")) === undefined,
    "端子数不固定的普通节点不暴露 ports（只给真正需要预检的那几类）",
  );
  /* 素材节点（kind asset）也进 ports 预检：端子数 = 内容条目数（第 i 入 ↔ 第 i 出），
     端子名 = 条目标题、端子类型 = 条目类型。这一支是 isAssetNode 的消费点 ——
     它一断（沙箱缺 isAssetNode）整段就抛 ReferenceError，故在此钉住。 */
  const assetPorts = editApi.snapshotPortsOf(portById("as"));
  const assetIn0 = assetPorts ? assetPorts.filter((p) => p.dir === "in" && p.index === 0)[0] : null;
  const assetOut1 = assetPorts ? assetPorts.filter((p) => p.dir === "out" && p.index === 1)[0] : null;
  ok(
    Array.isArray(assetPorts) && assetPorts.length === 4 &&
      assetIn0 && assetIn0.name === "开场白" && assetIn0.kind === "text" &&
      assetIn0.connectedTo && assetIn0.connectedTo[0].node === "上游" &&
      assetOut1 && assetOut1.name === "封面" && assetOut1.kind === "image",
    "素材节点也暴露 ports：条目即端子（第 i 入 ↔ 第 i 出，端子名 = 条目标题、类型 = 条目类型）",
  );
  /* 端子数不固定的节点（proc_image / proc_text / sensenova_gen / input_* …）：输入端子随连线
     增量长出来，ports 只能报「当下真实存在」的那几个槽 —— 空白节点就只剩「端口 0 = 提示词」，
     实测中模型据此误判「这个节点没有图像参考端子」，去试连一条线再看 warnings 反推接法
     （白花两轮往返）。所以同档补一条 portRule 说明端子怎么长：一次读图就读全。
     proc_image / sensenova_gen 同时在 SNAPSHOT_PORT_KINDS 里（ports 照旧给），
     判据因而不能是「在不在固定名单里」——增量口径由 snapshotInputGrowsWithWires 单独认。 */
  const piPorts = editApi.snapshotPortsOf(portById("pi"));
  const piRule = piPorts ? piPorts.rule : null;
  ok(
    !!piRule && typeof piRule.note === "string" && typeof piRule.hint === "string" &&
      !!piRule.input && !!piRule.output && !!piRule.now &&
      piRule.now.in === 2 && piRule.now.out === 1,
    "增量端子的节点在 ports.rule 里回端子规则（note / input / output / now / hint 五段齐，now = 当下端子数）",
  );
  ok(
    !!piRule && piRule.input.indexOf("端口 1+") >= 0 && piRule.input.indexOf("图像引用") >= 0 &&
      piRule.note.indexOf("增量") >= 0,
    "端子规则写清「端口 0 = 提示词 / 文本入口 · 端口 1+ = 数据槽（文本 / 图像引用都收）」——不写就是靠猜接线",
  );
  ok(
    !!piRule && piRule.hint.indexOf("端口 1+") >= 0 && piRule.hint.indexOf("warnings") >= 0,
    "端子规则明说 ports 只列当前存在的端子、接参考图直连端口 1+，不必先试连看 warnings",
  );
  ok(
    editApi.snapshotDynamicPortRule(portById("as")) === undefined &&
      editApi.snapshotDynamicPortRule(portById("vid")) === undefined &&
      editApi.snapshotDynamicPortRule(portById("rem")) === undefined &&
      editApi.snapshotDynamicPortRule(portById("sv")) === undefined,
    "端子数固定的节点（video_gen / remotion）、素材节点与普通节点不重复给规则（各自的端子口径已够用）",
  );
  /* 泛用增量名单（INCREMENTAL_PORT_KINDS）是这条规则的主要判据：input_text 这类普通输入节点
     不在 ports 名单里（照旧只回 portRule），名单外的、或端子数不再等于「已连数据线 + 1」的
     一律不给 —— 名单漂了只会少说一句，不会对固定端子节点说错话。 */
  const inRule = editApi.snapshotDynamicPortRule(portById("in"));
  ok(
    !!inRule && inRule.now.in === 1 && inRule.now.out === 1 &&
      editApi.snapshotPortsOf(portById("in")) === undefined,
    "泛用增量端子的普通输入节点只回 portRule（不在 ports 名单里就不重复给端子表）",
  );
  has(
    NODES_SRC,
    'const INCREMENTAL_PORT_KINDS = [',
    "增量端子名单列成常量（真源仍是 app.js inputCount，这里只做判据）",
  );
  has(
    NODES_SRC,
    "return (Number(inputCount(node)) || 0) === wired + 1;",
    "名单之外再核一道「端子数 = 已连数据线 + 1」，名单漂了也不会误报",
  );
  ok(
    Array.isArray(editApi.snapshotPortsOf(portById("as"))) &&
      !editApi.snapshotPortsOf(portById("as")).rule &&
      !(portById("up") && editApi.snapshotPortsOf(portById("up"))),
    "素材节点与普通节点名单不变（素材照旧只有端子表、普通处理节点走 portRule 这条）",
  );
  has(
    NODES_SRC,
    'if (o.detail !== "minimal") node.portRule = snapshotDynamicPortRule(n);',
    "快照只在 standard / full 档挂 portRule（minimal 档是纯索引，照旧不带）",
  );
  has(
    PLUGIN_N,
    "- portRule (standard / full):",
    "canvas_get 描述写明 portRule 口径（模型知道去哪看「端子怎么长」）",
  );
  const advice = editApi.connectPortAdvice("up", "vid", 1, 0, "输入端子已被占用");
  ok(
    advice && /已被.*占用/.test(advice.suggestion) && /可用数据端子/.test(advice.suggestion),
    "connect 失败回候选建议：点名占用者 + 列出仍可用的数据端子（控制口不计入）",
  );
  ok(
    advice.free.length === 2 && advice.ports.length === 4,
    "建议里带完整端子清单与空闲端子（4 个端子：3 数据 + 1 控制口不计入；数据里 1 个已占 → 空 2）",
  );
  const adviceFree = editApi.connectPortAdvice("up", "rem", 1, 0, "输入端子已被占用");
  ok(
    adviceFree && /可用数据端子/.test(adviceFree.suggestion) && adviceFree.free.length === 1,
    "有端子空着时直接点名可用数据端子（一次往返就改对）",
  );
  ok(
    editApi.saveMediaClassOfExt("a.md") === "text" &&
      editApi.saveMediaClassOfExt("a.yaml") === "text" &&
      editApi.saveMediaClassOfExt("a.png") === "image" &&
      editApi.saveMediaClassOfExt("a.wav") === "audio" &&
      editApi.saveMediaClassOfExt("a.mp4") === "video",
    "保存后缀的媒体类别映射齐备（.md / .yaml / .png / .wav / .mp4）",
  );
  ok(
    editApi.savePathExtWarning({ kind: "save", savePath: "a.png" }, "a.png") === "",
    "后缀与输入类型一致时不告警（不制造噪声）",
  );
  ok(
    /已按输入类型强制/.test(editApi.savePathExtWarning({ kind: "save", savePath: "a.wav" }, "a.wav")),
    "create / update 阶段就校验保存路径后缀并回 warning（不等服务商报错）",
  );

  const staticWarns = [];
  editApi.collectEditStaticWarnings(new Set(["pi", "sv"]), staticWarns);
  const hasWarn = (s) => staticWarns.some((w) => w.indexOf(s) >= 0);
  ok(hasWarn("批量 N² 警告"), "收尾校验 ①：批量 N² 全量注入（复用既有 warnBatchCartesianRisk）");
  ok(hasWarn("文生图每次只生成 1 张"), "收尾校验 ②：proc_image 被要求多图（复用既有 warnIfProcImageMultiPrompt）");
  ok(hasWarn("保存节点不能接智能处理节点"), "收尾校验 ③：save 误接智能节点（agent_task / agent:true）");
  ok(hasWarn("保存路径后缀与输入类型不符"), "收尾校验 ④：保存路径后缀与输入类型");
  ok(hasWarn("输入端子已被占用"), "收尾校验 ⑤：连线合法性 / 端子类型（真跑 connectError，同一边判定真源）");
  ok(
    staticWarns.filter((w) => w.indexOf("保存节点不能接智能处理节点") >= 0).length === 1,
    "同一份 warnings 里同一条提示只出现一次（去重后合并成一轮回执）",
  );
  has(NODES_SRC, "collectEditStaticWarnings(touchedIds, warnings);",
    "applyCanvasEdit 收尾只跑这一趟静态校验（把「错了—报错—再改」压成一轮往返）");
  has(NODES_SRC, "const extWarn = savePathExtWarning(node, rawPath);",
    "applyNodePatch 在强制后缀之前先算预检（拿到的是原始后缀，才能点名错在哪）");

  /* —— canvas_get 读图缓存：结构哈希 + 同参重读短回执（网关侧，源码取证） —— */
  const hashFnSrc = grabFunction(NODES_SRC, "snapshotContentHashOf", "app-nodes.js");
  ok(
    hashFnSrc.indexOf("snapshotHashSource") >= 0 && hashFnSrc.indexOf("snap.nodes") < 0 &&
      hashFnSrc.indexOf("cam") < 0 && hashFnSrc.indexOf("selection") < 0,
    "结构哈希对画布真源算（不拿裁过的快照算），剔除 cam / selection 等易变项",
  );
  has(NODES_SRC, "snap.contentHash = snapshotContentHashOf(S.wf);",
    "canvasSnapshotFull 把真源的 contentHash 回给网关（哈希真源只在渲染层）");
  /* 为什么必须与裁法解耦：这个哈希是写操作的乐观并发基准。跟着 detail 档位变，
     客户端「读完立刻改」会被永远判成「画布已被改动」（实测：minimal 读 → standard
     读哈希即变，写整片被拒）。真跑回归见 test/smoke-mcp-version-gate.js。 */
  has(NODES_SRC, "哈希必须算在**画布真源**上",
    "注释写明哈希与 detail / sections 裁法解耦的理由（否则后人一改又退回快照哈希）");
  for (const [needle, why] of [
    ["const getSeen = new Map()", "网关按会话记住读过的结构哈希"],
    ["const key = hash + '|' + JSON.stringify(a)", "键 = 结构哈希 + 本次请求参数（先 minimal 后 full 不会被误挡）"],
    ["unchanged: true", "同图同参重读回「无变化」短回执，不再重发整图"],
    ["if (getSeen.size > 200) getSeen.clear()", "缓存有界（长会话不会无限膨胀）"],
  ]) {
    has(PLUGIN_N, needle, "canvas_get 缓存：" + why);
  }

  /* —— minimal 档 = 纯节点索引（渲染层真跑见 smoke-canvas-scope [5]，这里钉住网关 / 落点） —— */
  has(NODES_SRC, 'const NODE_MINIMAL_KEYS = ["title", "note", "kind"];',
    "minimal 档节点级白名单 = 标题 / 描述 / 类别（id / 坐标 / 状态 / 层级 / tags / 配置 / 正文一律不带）");
  has(NODES_SRC, 'const MINIMAL_SNAPSHOT_SECTIONS = ["nodes"];',
    "minimal 档重型块只留 nodes（marks / wires / groups / taskTree / superTree / tagCatalog 不带）");
  has(NODES_SRC, "恒保留的只有极小信封：workflow / scopeInfo / assistScope · scopeNote。",
    "注释口径同步：minimal 只留 workflow / scopeInfo / assistScope·scopeNote 这层小信封");
  has(NODES_SRC, 'const out = o.detail === "minimal" ? pruneMinimalSnapshot(snap, opts) : snap;',
    "canvasSnapshot 出口统一走 pruneMinimalSnapshot（节点与重型块一起裁，不是只裁节点字段；结果落 out 供 refs 闸再补）");
  has(NODES_SRC, "function snapshotWantsSection(o, opts, key)",
    "canvasSnapshotFull 与 canvasSnapshot 共用「这次要不要这个重型块」的判据");
  has(NODES_SRC, "if (minimal && !want(\"workflows\")) delete snap.workflows;",
    "minimal 档连「全部画布列表 / 选中 / 助手面板开关」都不带（锁定本画布只靠 scopeNote 说明）");
  has(NODES_SRC, "for (const k of MINIMAL_SNAPSHOT_DROP) delete snap[k];",
    "视角与色卡（cam / view / 焦点 / markColors / devFuncColors）在 minimal 档一并摘掉（三张静态参考表已移出本名单）");
  has(PLUGIN_N, 'At detail "minimal" ONLY nodes is returned unless you name others here',
    "sections 参数说明写清 minimal 是白名单语义（只查连线 = sections:[\"nodes\",\"wires\"]）");
  has(PLUGIN_N, '在任何档位都不默认带，显式传 sections:["refs"] 才取得到。',
    '描述写明三张静态参考表（kinds / imageSizes / defaultImageSize）已从所有档位移除，只有 sections:["refs"] 才取回');
  has(NODES_SRC, "function snapshotWantsStaticRefs(opts)",
    "渲染层新增 refs 按需闸（canvasSnapshot 出口单独判，不进 SNAPSHOT_HEAVY_SECTIONS）");
  has(NODES_SRC, "if (snapshotWantsStaticRefs(opts)) attachSnapshotStaticRefs(out);",
    "refs 闸补在 pruneMinimalSnapshot 裁剪之后（否则会被 MINIMAL_SNAPSHOT_DROP 再摘掉）");

  /* ===== [11] 本轮落地：上下文压缩（组合行 + 策略模块 + 设置/下发三处同名） =====
     为什么钉这一组：dsh 默认触发线 = 适配器声明的 contextWindow × 0.8，而网关给
     deepseek-v4 系列声明的是 1,000,000 → 要跑到 800k token 才压，本机所有会话都到不了
     （审计脚本里「压缩 0 次」）。所以「组合里这一行在不在、比例对不对、设置能不能改到它」
     必须有门槛，否则下次谁把行删了 / 比例改回 0.8，账单会静默涨回去。
     本轮新增：省钱档（绝对 ~100k 触发，靠固定 headroomTokens 常量 643,872）与自定义档
     （用户填 100k–500k）；原早档下线，旧值 "early" 归一到「中」。
     再一轮修 bug（「选了 100k 档却没在 100k 压」）：modelPolicies 原先只点名一个写死的
     模型名 deepseek-flash，而这条路由实际跑的是配置里那一个（本机 = deepseek-v4-flash）
     → 整份 policy 静默落空、触发线退回 ≈678k。现在点名一族 id（兜底官方族 ∪ 配置里官方
     服务商的 models），并且每条 policy 显式带 maxTokens（插件会把 headroomTokens 当摘要
     请求的输出上限）。下面那组断言就是这两条口径的门槛。 */
  console.log("\n[11] 上下文压缩：组合行 + dsh-compact-policy 策略模块 + 设置与下发同源");
  {
    const CORDIS = readN("dsh/gateway/cordis.yml");
    const POLICY = read("dsh-compact-policy.js");
    const MAIN_SRC = read("main.js");
    const SETTINGS_SRC = read("renderer/app-settings.js");
    const I18N_SRC2 = read("renderer/i18n.js");
    const BUILD = read("build.json");
    has(CORDIS, "\n- id: compaction-basic\n", "组合里有 compaction-basic 行（dsh 自带压缩真正被挂上）");
    /* 只取这一行的 config 段：从 `- id:` 到**第一个空行**为止（空行之后是别的行/注释；
       整块切到下一个 `- id:` 会把 2000 多字的别处注释也圈进来，断言就失去意义）。 */
    const rowStart = CORDIS.indexOf("\n- id: compaction-basic\n") + 1;
    const rowBlank = CORDIS.indexOf("\n\n", rowStart);
    const rowBody = CORDIS.slice(rowStart, rowBlank < 0 ? CORDIS.length : rowBlank);
    has(rowBody, "thresholdRatio: 0.3", "触发比例 = 0.3（声明窗口 1M → 约 300k token 触发，而不是默认的 800k）");
    has(rowBody, "retainRatio: 0.04", "兜底保留比例 = 0.04（未列名模型按窗口比例留最近原文；必须 < 最小档 0.3）");
    has(rowBody, "auto: true", "出厂 auto: true（默认自动压缩）");
    has(rowBody, "modelPolicies:", "按路由列了 modelPolicies（已知主力模型走绝对保留尾部）");
    has(rowBody, "retainTokens: 32768", "默认档保留尾部 = 32,768 token（绝对值，不按 1M 窗口的 16% 留 160k）");
    has(rowBody, "maxTokens: 256000",
      "每条 policy 都显式给了 maxTokens = 主力路由的单次输出上限（否则插件会拿 headroomTokens 当摘要请求的输出上限：省钱档会变成 64 万）");
    has(rowBody, "provider: deepseek-official", "点名 deepseek-official 路由（本机实测会话全走它；比例算出的保留量偏大，所以给绝对量）");
    ok(!/provider: mtnode\b/.test(rowBody),
      "不点名自配服务商（provider 名是 mtnode_<route>、route 与模型名都由用户配置决定，点名必落空 → 那类路由走 retainRatio 兜底）");

    has(POLICY, 'const TIERS = ["frugal", "mid", "late", "custom"]',
      "四档 = 省钱 / 中 / 晚 / 自定义（设置里只给档位与一条触发线，不摊原始百分比）");
    has(POLICY, 'const DEFAULT_TIER = "mid"', "出厂档仍是「中」（省钱档不是新用户默认档）");
    has(POLICY, "const FRUGAL_HEADROOM_TOKENS = 643872",
      "省钱档 = 固定 headroom 常量 643,872（= 1M 窗口 − 256K 预留输出 − 100K，真正落在 100k 触发）");
    has(POLICY, "function customHeadroomOf(triggerTokens)",
      "自定义档：触发线换算成 headroomTokens（同一套 min() 口径，不新增配置键）");
    has(POLICY, "const OFFICIAL_MODELS_FALLBACK = Object.freeze([",
      "点名清单有兜底那一族（不是一个写死的模型名 —— 见下面那条实测回归）");
    has(POLICY, "function officialModelIdsOf(cfg)",
      "点名清单另外从 config.providers 里取官方服务商的模型 id（这条路由实际跑哪个 id 只有配置知道）");
    has(POLICY, "function isOfficialDeepseekProvider(p)",
      "「哪家算官方路由」的判据与 renderer/app-agent.js 的 dshProvider() 同一句（host 含 deepseek）");
    has(POLICY, 'const CUSTOM_TRIGGER_MIN = 100000', "自定义触发线下界 = 100k");
    has(POLICY, 'const CUSTOM_TRIGGER_MAX = 500000', "自定义触发线上界 = 500k");
    has(POLICY, "function normalizeCustomTrigger(raw)", "自定义触发线越界一律回落缺省（绝不抛）");
    has(POLICY, "function normalizeCompactPolicy(raw)", "归一函数独立成模块（与 dsh-agent-policy 同构，非法值一律回落默认）");
    has(POLICY, "function applyCompactPolicy(text, rawPolicy)", "写组合的唯一入口 = applyCompactPolicy(text, policy)");
    has(POLICY, "function compactPolicyFromConfig(cfg)", "真源读取 = config.dsh.compact（设置界面写的就是它）");
    has(MAIN_SRC, 'require("./dsh-compact-policy.js")', "main.js require 了策略模块");
    has(MAIN_SRC, "function syncCompactPolicy(cfg)", "main.js 有 syncCompactPolicy（与 syncSubagentPolicy 同构）");
    ok((MAIN_SRC.match(/syncCompactPolicy\(/g) || []).length >= 3,
      "syncCompactPolicy 在「启动时」与「保存配置后」两处都被调用（定义 1 次 + 调用 ≥2 次）");
    has(BUILD, '"dsh-compact-policy.js"', "build.json 白名单已登记（否则打包后 Cannot find module）");

    ok(SETTINGS_SRC.indexOf("S.config.dsh.compact") < 0 &&
      SETTINGS_SRC.indexOf("ASSIST_COMPACT_OPTIONS") < 0,
      "上下文压缩已从设置移除（档位只在助手栏 / 会话菜单两处，配置真源不变）");
    has(I18N_SRC2, '"上下文压缩": "Context compaction"', "i18n 中英词条齐（英文界面不回落中文）");
    ok(I18N_SRC2.indexOf('"压缩时机":') < 0,
      "设置专用的「压缩时机」词条随设置那一组一起下线（会话侧用「上下文压缩」那一格）");
    has(I18N_SRC2, '"省钱 · 100k": "Frugal · 100k"',
      "省钱档档名有英文词条（档位文案只留「档位名 · 上下文阈值」，英文界面不回落中文）");
    has(I18N_SRC2, '"自定义": "Custom"',
      "自定义档档名有英文词条");

    /* 幂等与往返：拿真组合文件跑一遍策略模块（策略与出货一致时必须零改动） */
    try {
      const pol = require(path.join(__dirname, "..", "dsh-compact-policy.js"));
      const text = read("dsh/gateway/cordis.yml");
      const def = pol.applyCompactPolicy(text, pol.compactPolicyFromConfig({}));
      ok(def.changed === false, "默认策略（开 · 中档）对出货组合零改动（幂等，不会每次启动都写盘）");
      const frugal = pol.applyCompactPolicy(text, { enabled: true, tier: "frugal" });
      const fst = pol.compactStateInCordis(frugal.text);
      ok(frugal.changed === true && fst.thresholdRatio === 0.9 &&
        eq(fst.headroomTokens, pol.KNOWN_TARGETS.map(() => 643872)) &&
        eq(fst.retainTokens, pol.KNOWN_TARGETS.map(() => 16384)) &&
        eq(fst.maxTokens, pol.KNOWN_TARGETS.map(() => pol.MAIN_ROUTE_RESERVED_OUTPUT)),
        "省钱档写进去的是每条点名路由 headroomTokens: 643872 + retainTokens: 16384 + maxTokens: 256000（档位真的落到这些路由上）");
      const cst = pol.compactStateInCordis(
        pol.applyCompactPolicy(text, { enabled: true, tier: "custom", customTriggerTokens: 500000 }).text,
      );
      ok(eq(cst.headroomTokens, pol.KNOWN_TARGETS.map(() => 244000)),
        "自定义 500k → 每条点名路由 headroomTokens: 244,000（= 744,000 − 500,000）");
      /* ── 本轮修的 bug 的回归：点了名，但没点到真正在跑的那个 id ──
         现场：会话头部是 provider=deepseek-official / model=deepseek-v4-flash（配置里那家
         DeepSeek 服务商只列了这一个），而策略原先只点名 deepseek-flash → modelPolicies
         整体落空 → 省钱档的绝对触发线一起落空（触发线退回 ≈678k），用户在「100k」档位上
         永远等不到自动压缩。三条口径钉住：兜底那一族覆盖网关认得的官方 id、配置里那个 id
         一定进点名表、触发线算式就是 100k。 */
      const GW = readN("dsh/gateway/gateway.mjs");
      const knownBlock = (GW.match(/const OFFICIAL_MODEL_KNOWN = \{[\s\S]*?\n\}/) || [""])[0];
      const knownIds = (knownBlock.match(/'([a-z0-9.-]+)':\s*\{/g) || []).map((s) => s.replace(/[':{\s]/g, ""));
      ok(knownIds.length >= 3 && knownIds.every((id) => pol.OFFICIAL_MODELS_FALLBACK.indexOf(id) >= 0),
        "兜底点名表覆盖网关 OFFICIAL_MODEL_KNOWN 的每一个官方 id（新增官方模型时这里会先红：" + knownIds.join(",") + "）");
      ok(pol.KNOWN_TARGETS.every((t) => t.provider === "deepseek-official") &&
        pol.KNOWN_TARGETS.some((t) => t.model === "deepseek-v4-flash"),
        "兜底点名表含本机实测真正在跑的那个 id（deepseek-v4-flash）");
      ok(pol.MAIN_ROUTE_WINDOW - pol.MAIN_ROUTE_RESERVED_OUTPUT - pol.FRUGAL_HEADROOM_TOKENS === 100128,
        "省钱档触发线 = 1M − 256K − 643,872 = 100,128 ≈ 100k（档位名与算式同源）");
      ok(pol.compactConfigOf({ tier: "frugal" }).modelPolicies.every((p) => p.maxTokens === pol.MAIN_ROUTE_RESERVED_OUTPUT) &&
        pol.compactConfigOf({ tier: "mid" }).modelPolicies.every((p) => p.maxTokens === pol.MAIN_ROUTE_RESERVED_OUTPUT),
        "每条 policy 都带 maxTokens（插件那条「headroomTokens 当 maxTokens」的兜底不会启动）");
      const cfgOfficial = {
        providers: [
          { id: "deepseek", type: "text_openai", baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-flash"] },
          { id: "p1", type: "text_openai", baseUrl: "https://api.apiyi.com/v1", models: ["glm-5.2"] },
        ],
      };
      const cfgPolicy = pol.compactPolicyFromConfig(
        Object.assign({ dsh: { compact: { enabled: true, tier: "frugal" } } }, cfgOfficial),
      );
      const cfgAppliedText = pol.applyCompactPolicy(text, cfgPolicy).text;
      const cfgApplied = pol.compactStateInCordis(cfgAppliedText);
      has(cfgAppliedText.replace(/\r\n?/g, "\n"), "model: deepseek-v4-flash\n        headroomTokens: 643872",
        "配置里那家官方服务商的模型 id 也被点名（headroom 真的加到本机在跑的那条路由上）");
      ok(cfgApplied.headroomTokens.length === pol.officialModelIdsOf(cfgOfficial).length,
        "点名条数 = 兜底那一族 ∪ 配置里官方服务商的模型 id");
      const exotic = pol.compactPolicyFromConfig(
        Object.assign({ dsh: { compact: { tier: "frugal" } } }, cfgOfficial, {
          providers: [
            { id: "deepseek", type: "text_openai", baseUrl: "https://api.deepseek.com", models: ["deepseek-chat"] },
          ],
        }),
      );
      ok(exotic.officialModels.indexOf("deepseek-chat") >= 0 &&
        exotic.officialModels.indexOf("deepseek-flash") >= 0,
        "配置里出现兜底表没有的官方模型 id 时追加点名（新 id 不会又静默退回默认触发线）");
      ok(pol.normalizeCompactPolicy({ officialModels: [] }).officialModels.length === pol.KNOWN_TARGETS.length,
        "点名清单为空一律回落兜底那一族（绝不产出空 modelPolicies = 静默不压缩）");
      ok(eq(pol.normalizeCompactPolicy({ tier: "custom", customTriggerTokens: 9999 }).customTriggerTokens, 100000),
        "自定义触发线越界（9999）回落缺省 100k");
      ok(eq(pol.normalizeCompactPolicy({ tier: "custom", customTriggerTokens: 5000000 }).customTriggerTokens, 100000),
        "自定义触发线越界（5000k）回落缺省 100k");
      ok(pol.normalizeCompactPolicy({ tier: "early" }).tier === "mid",
        "已下线的早档旧值归一到「中」（老配置不会读出脏档）");
      const back = pol.applyCompactPolicy(frugal.text, { enabled: true, tier: "mid" });
      ok(back.text === text, "省钱档改回中档后与出货原文逐字一致（往返无损，结构没被改写）");
      const off = pol.applyCompactPolicy(text, { enabled: false, tier: "mid" });
      const st = pol.compactStateInCordis(off.text);
      ok(st && st.auto === false, "关掉后 auto: false（读回的取值不被上方注释里的示例数字带偏）");
      ok(pol.compactStateInCordis(text).retainTokens.length === pol.KNOWN_TARGETS.length,
        "读数只统计真正生效的 modelPolicies（不含注释示例；条数 = 策略模块点名的路由数）");
      ok(pol.compactStateInCordis(text).headroomTokens.length === 0,
        "中档不写 headroomTokens（触发线仍由 thresholdRatio 决定，档位行为没被这次改动带偏）");
      const noRow = pol.applyCompactPolicy("- id: tool-todo\n  config:\n    a: 1\n", { enabled: true, tier: "late" });
      ok(noRow.changed === false, "组合里没有这一行时不自己插行（挂载由组合决定，模块只改配置值）");
    } catch (e) {
      ok(false, "策略模块可直接 require 并跑通：" + ((e && e.message) || String(e)));
    }
  }

  /* ===== [12] 本轮落地：上下文压缩档位挪到助手栏「思考强度」下一行 =====
     为什么钉这一组：压缩档的第二个人口（助手栏下拉）与设置面板**必须是同一份值**——
     别人把它写成第二份真源（另存一个 S.assistCompact）就会出现「面板显示中档、组合里是早档」
     这种看不见的错配；位置也要钉住（用户点名「思考强度下方」）。
     本轮新增：省钱 / 自定义两档（三处入口同一张表）、自定义触发线输入框
     （档位文案只留「档位名 · 上下文阈值」，不写解释性长句）。 */
  console.log("\n[12] 上下文压缩档位：助手栏「思考强度」下一行 + 与设置同一份值");
  {
    const IDX = readN("renderer/index.html");
    const ASSIST_SRC2 = readN("renderer/app-assist.js");
    const SHARED_SRC = readN("renderer/app-dsh-compact.js");
    const BOOT_SRC = readN("renderer/app-boot.js");
    const I18N_SRC3 = readN("renderer/i18n.js");
    const IDX_CSS = readN("renderer/css/assist.css");

    const effIdx = IDX.indexOf('id="assistEffortSel"');
    const cmpIdx = IDX.indexOf('id="assistCompactSel"');
    ok(effIdx > 0 && cmpIdx > effIdx,
      "助手栏下拉 id=assistCompactSel 落在 id=assistEffortSel 之后（「思考强度」下一行）");
    /* 压缩这一格自己占一条行：从下拉往后取到它自己那只 </label>（后面还有「自定义触发线」
       那一行，锚点要收到本行结尾，不能一路扫到下一条 .assist-ctrl-item） */
    const ctrlEnd = IDX.indexOf("</label>", cmpIdx);
    ok(ctrlEnd > cmpIdx && IDX.slice(cmpIdx, ctrlEnd).indexOf('class="assist-ctrl-item"') < 0,
      "压缩这一格自己是一条 .assist-ctrl-item 行（不塞进「思考强度」那一格）");
    ok(/id="assistCompactSel"[^>]*data-i18n-title="上下文压缩时机/.test(IDX),
      "下拉带 i18n 悬浮说明（切语言不退回中文）");
    ok(/<span data-i18n="上下文压缩">/.test(IDX),
      "行标签走 data-i18n（语言切换由 applyDom 换字，不靠重绘）");

    /* 档位清单 / 归一 / 边界住在共享小单元 app-dsh-compact.js（设置面板与助手栏是两个各自
       独立的加载单元，这一小份必须是同一份，否则会出现「面板显示中档、组合里是省钱档」） */
    has(SHARED_SRC, 'const ASSIST_COMPACT_OPTIONS = [', "档位清单常量在 renderer/app-dsh-compact.js");
    has(IDX, '<script src="app-dsh-compact.js"></script>',
      "index.html 在 app-settings.js / app-assist.js 之前加载它（两个加载单元都拿得到）");
    const idxShared = IDX.indexOf('<script src="app-dsh-compact.js">');
    ok(idxShared > 0 && idxShared < IDX.indexOf('<script src="app-settings.js">') &&
      idxShared < IDX.indexOf('<script src="app-assist.js">'),
      "加载顺序：共享小单元 → 设置面板 → 助手栏（按 index.html 的脚本顺序分层）");
    /* 只取常量数组那一段（整文件里档位 id 还出现在归一与判定两处，全文件扫会多出重复项） */
    const optFrom = SHARED_SRC.indexOf("const ASSIST_COMPACT_OPTIONS = [");
    const optBlock = SHARED_SRC.slice(optFrom, SHARED_SRC.indexOf("];", optFrom));
    const optVals = (optBlock.match(/\["(off|frugal|mid|late|custom)", "/g) || []).map(
      (s) => s.slice(2, -4),
    );
    ok(eq(optVals, ["off", "frugal", "mid", "late", "custom"]),
      "五档顺序 = 关闭 / 省钱 / 中 / 晚 / 自定义（省钱排最前、自定义排最后，与用户定的下拉次序一致）");
    has(SHARED_SRC, "function compactPolicyOf(cfg)", "读值走 compactPolicyOf（与策略模块同源口径）");
    has(SHARED_SRC, '["frugal", "mid", "late", "custom"].indexOf(String(c.tier)) >= 0 ? String(c.tier) : "mid"',
      "归一：非法 tier 回落 mid");
    has(SHARED_SRC, "enabled: c.enabled !== false", "归一：缺省 = 开（与 dsh-compact-policy 的 DEFAULT_POLICY 一致）");
    has(SHARED_SRC, "customTriggerTokens", "自定义触发线也是同一份 config.dsh.compact 里的一项（不另立真源）");
    has(SHARED_SRC, "const COMPACT_CUSTOM_MIN = 100000", "界面侧的触发线下界与策略模块一致（100k）");
    has(SHARED_SRC, "const COMPACT_CUSTOM_MAX = 500000", "界面侧的触发线上界与策略模块一致（500k）");
    /* 助手栏侧：清单 / 回显 / 写回全走共享小单元 + 自己那条落盘链 */
    has(ASSIST_SRC2, "function syncAssistCompactOptions(sel)", "清单 + 回显合并成一个 sync（切语言重建、按语言做指纹）");
    has(ASSIST_SRC2, "if (document.activeElement === sel) return;", "正在选的时候不回写（下拉不会自己关掉）");
    has(ASSIST_SRC2, 'sel.value = cp.enabled === false ? "off" : cp.tier;', "回显 = enabled:false → 关闭，否则显示档位");
    has(ASSIST_SRC2, "function applyAssistCompactTrigger(raw)", "自定义触发线的写回入口独立成函数（越界拒绝并提示）");
    has(ASSIST_SRC2, "function syncCompactSideControls(tier)",
      "自定义输入框的显隐由一个函数统管（三处入口同口径）");
    has(ASSIST_SRC2, "function syncCompactCustomInput(input)", "自定义输入框的回填独立成函数（正在输入时不打断）");
    has(ASSIST_SRC2, "customTriggerTokens: cur.customTriggerTokens,",
      "写回时保留自定义触发线（切档位不丢用户填过的数）");
    has(ASSIST_SRC2, "function applyAssistCompactChoice(v)", "写回入口独立成函数（boot 只接线）");
    has(ASSIST_SRC2, 'syncAssistCompactOptions($("#assistCompactSel"));', "每次重画助手栏都回刷一次（打开面板即正确回显）");
    has(ASSIST_SRC2, 'syncCompactCustomInput($("#assistCompactCustomInput"));',
      "每次重画助手栏也回填自定义触发线输入框");
    has(BOOT_SRC, "applyAssistCompactChoice(compactSel.value)", "app-boot.js 把 onchange 接到写回入口");
    has(BOOT_SRC, "applyAssistCompactTrigger(compactCustomInput.value)",
      "app-boot.js 把自定义输入框接到同一条写回链");
    has(I18N_SRC3, '"关闭":', "关闭那一档复用已有词条（不另立一条长句）");
    const i18nMiss = [
      "关闭",
      "上下文压缩时机已更新（下一个新会话生效）",
      "省钱 · 100k",
      "中 · 300k",
      "晚 · 450k",
      "自定义",
      "自定义触发线",
      "自定义触发线要填 100k – 500k 之间的整数。",
      "自定义触发线已更新（下一个新会话生效）",
    ].filter((k) => I18N_SRC3.indexOf('"' + k + '":') < 0);
    ok(i18nMiss.length === 0, "本轮新增的 i18n 键都在词条表里：" + (i18nMiss.join(" / ") || "齐"));

    /* 助手栏的宿主 DOM：自定义触发线输入框（显隐由 syncCompactSideControls 统管）；
       省钱档那行长说明句已按本轮要求整体撤掉——三处入口都不再出现 */
    ok(/id="assistCompactCustom"[\s\S]{0,200}id="assistCompactCustomInput"/.test(IDX),
      "助手栏有自定义触发线输入框（#assistCompactCustom > #assistCompactCustomInput，默认 hidden）");
    ok(/id="assistCompactCustom"[^>]*hidden/.test(IDX), "自定义输入框默认收起（只有选了自定义档才露出）");
    ok(IDX.indexOf("FrugalNote") < 0, "省钱档长说明句已从 index.html 撤掉");
    ok(ASSIST_SRC2.indexOf("FrugalNote") < 0, "显隐函数里也不再找那个说明句（不留死引用）");
    has(IDX_CSS, '.assist-ctrl-item input[type="number"]', "输入框有专属样式（与相邻下拉同观感）");

    /* 真行为：把归一函数抠出来放进沙箱跑（助手栏读的那一份必须与出货组合对得上） */
    try {
      const sandbox = {};
      vm.createContext(sandbox);
      vm.runInContext(
        "const COMPACT_CUSTOM_MIN = 100000, COMPACT_CUSTOM_MAX = 500000;\n" +
          "const COMPACT_RETAIN_MIN = 4096, COMPACT_RETAIN_MAX = 131072;\n" +
          "const COMPACT_SUMMARY_MIN = 4096, COMPACT_SUMMARY_MAX = 256000;\n" +
          grabFunction(SHARED_SRC, "compactLimitOf", "renderer/app-dsh-compact.js") +
          grabFunction(SHARED_SRC, "compactPolicyOf", "renderer/app-dsh-compact.js") +
          "\nthis.p = compactPolicyOf;",
        sandbox,
      );
      const p = sandbox.p;
      ok(eq(p({}), { enabled: true, tier: "mid", customTriggerTokens: 100000, retainTokens: null, summaryMaxTokens: null }),
        "缺省配置 → 开 · 中档 · 自定义触发线 100k · 压缩后大小跟随档位（与组合里的 0.3 / 32768 对得上）");
      ok(eq(p({ dsh: { compact: { enabled: false, tier: "late" } } }),
        { enabled: false, tier: "late", customTriggerTokens: 100000, retainTokens: null, summaryMaxTokens: null }),
        "关 · 晚档原样读出");
      ok(eq(p({ dsh: { compact: { tier: "nonsense" } } }),
        { enabled: true, tier: "mid", customTriggerTokens: 100000, retainTokens: null, summaryMaxTokens: null }),
        "非法档位回落中档（不把脏值写进组合）");
      ok(eq(p({ dsh: { compact: { tier: "custom", customTriggerTokens: 250000 } } }),
        { enabled: true, tier: "custom", customTriggerTokens: 250000, retainTokens: null, summaryMaxTokens: null }),
        "自定义档与它的触发线原样读出（切走再切回不丢）");
      ok(eq(p({ dsh: { compact: { tier: "custom", customTriggerTokens: 42 } } }).customTriggerTokens, 100000),
        "越界的自定义触发线回落 100k（界面不显示脏值）");
      ok(eq(p({ dsh: { compact: { tier: "early" } } }).tier, "mid"),
        "已下线的早档旧值在界面侧也归一到「中」（与策略模块同口径）");
      /* 设置面板：上下文压缩整组已按要求从设置移除（档位只在会话侧两处） */
      const settingsSrc = readN("renderer/app-settings.js");
      ok(settingsSrc.indexOf("assistCompactCustomSet") < 0 &&
        settingsSrc.indexOf("ASSIST_COMPACT_OPTIONS") < 0,
        "设置面板已不再挂上下文压缩（自定义触发线 / 档位表都不在设置里）");
      ok(settingsSrc.indexOf("FrugalNote") < 0, "设置面板也不再挂省钱档说明句（界面不冗余）");
      /* 会话「模型」菜单里也有同一处编辑入口（三处一致） */
      has(ASSIST_SRC2, 'trow.className = "agent-menu-option agent-menu-input-row"',
        "会话 ⚙「模型」菜单的压缩页里也有自定义触发线一行（三处入口一致）");
      const pol2 = require(path.join(__dirname, "..", "dsh-compact-policy.js"));
      const off2 = pol2.applyCompactPolicy(read("dsh/gateway/cordis.yml"), p({ dsh: { compact: { enabled: false, tier: "late" } } }));
      const st2 = pol2.compactStateInCordis(off2.text);
      ok(st2 && st2.auto === false && /retainTokens: 65536/.test(off2.text),
        "助手栏选「关闭」后组合行 = auto:false 且保留尾巴仍是该档的 65536（关掉不丢用户选的档）");
      /* 界面侧与策略模块必须算出同一个 headroom（省钱档 100k 的口径只有一处真源） */
      const frugalApp = pol2.applyCompactPolicy(
        read("dsh/gateway/cordis.yml"),
        p({ dsh: { compact: { tier: "frugal" } } }),
      );
      ok(eq(pol2.compactStateInCordis(frugalApp.text).headroomTokens, pol2.KNOWN_TARGETS.map(() => pol2.FRUGAL_HEADROOM_TOKENS)),
        "界面侧选的省钱档 → 组合里就是策略模块那个 headroom 常量（两处不会各写一个数）");
    } catch (e) {
      ok(false, "compactPolicyOf 可在沙箱里跑通：" + ((e && e.message) || String(e)));
    }
  }

  /* ===== [13] 压缩后的大小可调：保留原文 retainTokens + 摘要上限 maxTokens =====
     为什么钉这一组：这两个值是「压完还剩多少」的唯一两个旋钮（以前写死在档位里）。
     三件必须同时成立，否则界面上填了数、组合里没生效：
       ① 策略模块认得这两个键（越界归一成 null = 跟随档位）并写进组合行；
       ② 自配服务商（mtnode_<route>）也盖，但按 128K 窗口保守夹取（否则小窗口路由报错）；
       ③ 界面两个入口（助手栏 + 会话 ⚙）读 / 写同一份 config.dsh.compact。 */
  console.log("\n[13] 压缩后的大小可调：保留原文 / 摘要上限（档位做预设 + 自配路由夹取）");
  {
    const POLICY2 = read("dsh-compact-policy.js");
    const SHARED2 = readN("renderer/app-dsh-compact.js");
    const ASSIST3 = readN("renderer/app-assist.js");
    const IDX2 = readN("renderer/index.html");
    const BOOT2 = readN("renderer/app-boot.js");
    const I18N4 = readN("renderer/i18n.js");
    has(POLICY2, "const RETAIN_TOKENS_MIN = 4096", "保留原文下界 4K（再低就把最近原文压没了）");
    has(POLICY2, "const RETAIN_TOKENS_MAX = 131072", "保留原文上界 128K");
    has(POLICY2, "const SUMMARY_MAX_TOKENS_MIN = 4096", "摘要上限下界 4K");
    has(POLICY2, "const SUMMARY_MAX_TOKENS_MAX = 256000", "摘要上限上界 = 主力路由单次输出上限");
    has(POLICY2, "function normalizeLimitTokens(raw, min, max)", "两个量的归一独立成函数（越界 = 没填）");
    has(POLICY2, "function selfTargetsOf(cfg)",
      "自配服务商（mtnode_<route>）的目标清单从 providers 现算（用户选了「所有路由都盖」）");
    has(POLICY2, "const SELF_ROUTE_WINDOW = 128000", "自配路由窗口未知 → 按 128K 保守夹取");
    has(POLICY2, "const SELF_ROUTE_RETAIN_FRACTION = 0.2",
      "自配路由保留量最多给到消息预算的 20%（插件硬校验 retain < threshold）");
    has(POLICY2, "const officialThreshold = Math.floor(", "官方主力路由的保留量也夹到触发线之下（省钱档 100K）");

    const pol3 = require(path.join(__dirname, "..", "dsh-compact-policy.js"));
    ok(eq(pol3.normalizeCompactPolicy({ retainTokens: 100, summaryMaxTokens: 900000 }),
      {
        enabled: true,
        tier: "mid",
        customTriggerTokens: 100000,
        retainTokens: null,
        summaryMaxTokens: null,
        officialModels: pol3.OFFICIAL_MODELS_FALLBACK.slice(),
        selfTargets: [],
      }),
      "越界 / 脏值一律归一成 null（= 跟随档位默认，老配置行为一字不变）");
    const normSized = pol3.normalizeCompactPolicy({ retainTokens: 16384, summaryMaxTokens: 8192 });
    ok(eq(normSized.retainTokens, 16384) && eq(normSized.summaryMaxTokens, 8192), "合法值原样读出");
    const cfgSized = pol3.compactPolicyFromConfig({
      dsh: { compact: { tier: "mid", retainTokens: 65536, summaryMaxTokens: 8192 } },
      providers: [
        { type: "text_openai", baseUrl: "https://api.other.com/v1", route: "myroute", models: ["gpt-x"] },
      ],
    });
    const sizedPolicies = pol3.compactConfigOf(cfgSized).modelPolicies;
    const offiSized = sizedPolicies.filter((p) => p.provider === "deepseek-official");
    const selfSized = sizedPolicies.filter((p) => p.provider === "mtnode_myroute");
    ok(offiSized.length === pol3.KNOWN_TARGETS.length &&
      offiSized.every((p) => p.retainTokens === 65536 && p.maxTokens === 8192),
      "官方主力路由：用户填的 65,536 / 8,192 就是写进组合的那两行");
    ok(selfSized.length === 1 && selfSized[0].model === "gpt-x" &&
      selfSized[0].retainTokens === 19046 && selfSized[0].maxTokens === 8192,
      "自配路由也盖：保留量夹到消息预算的 20%（95,232 × 0.2 = 19,046），摘要上限取 8,192");
    const huge = pol3.compactConfigOf(pol3.normalizeCompactPolicy({ tier: "frugal", retainTokens: 131072 }))
      .modelPolicies.filter((p) => p.provider === "deepseek-official");
    ok(huge.every((p) => p.retainTokens < 100128),
      "省钱档触发线只有 100,128 → 填 128K 的保留量被夹到触发线之下（否则插件加载期就报非法）");
    const appliedSized = pol3.compactStateInCordis(
      pol3.applyCompactPolicy(read("dsh/gateway/cordis.yml"), cfgSized).text,
    );
    ok(eq(appliedSized.maxTokens, pol3.KNOWN_TARGETS.map(() => 8192).concat([8192])),
      "写进组合的 maxTokens 已换成用户的摘要上限（含自配路由那一条）");

    has(SHARED2, "const COMPACT_RETAIN_MIN = 4096", "界面侧保留原文下界与策略模块同值");
    has(SHARED2, "const COMPACT_SUMMARY_MAX = 256000", "界面侧摘要上限上界与策略模块同值");
    has(SHARED2, "const COMPACT_TIER_SIZE_DEFAULTS = {", "档位默认体积表也在共享小单元里（切档位回落到它）");
    has(SHARED2, "function compactLimitOf(raw, min, max)", "界面侧的归一与策略模块同口径（越界 = 没填）");
    has(SHARED2, "function compactRetainEffectiveOf(cfg)", "保留原文生效值由一个函数统管（空 = 跟随档位）");
    has(SHARED2, "function compactSummaryEffectiveOf(cfg)", "摘要上限生效值由一个函数统管");
    has(SHARED2, "const COMPACT_CHARS_PER_TOKEN = 2", "手动链 1 token ≈ 2 字符的换算只有一处");

    has(ASSIST3, "function applyAssistCompactLimit(kind, raw)", "写回入口 = applyAssistCompactLimit（越界拒绝并提示）");
    has(ASSIST3, "retainTokens: tierChanged ? null : cur.retainTokens,",
      "切档位 = 清空两个自定义体积值（回到该档默认）");
    has(ASSIST3, "const keepChars = Math.max(0, Number(info && info.keepChars) || 0);",
      "手动压缩也保留最近原文尾（keepChars）");
    has(ASSIST3, "if (!m || m._fold || m._compact) continue;",
      "上一次的摘要消息不参与「保留原文尾」（上下文里永远只有一份最新摘要）");
    has(ASSIST3, "if (!count) return 0;", "一条都折不动时不加空摘要（返回 0，调用方提示）");
    has(IDX2, 'id="assistCompactRetainInput"', "助手栏有保留原文输入框");
    has(IDX2, 'id="assistCompactSummaryInput"', "助手栏有摘要上限输入框");
    has(BOOT2, 'applyAssistCompactLimit("retain", compactRetainInput.value)', "app-boot 接线：保留原文");
    has(BOOT2, 'applyAssistCompactLimit("summary", compactSummaryInput.value)', "app-boot 接线：摘要上限");
    has(ASSIST3, '["retain", "保留原文", COMPACT_RETAIN_MIN, COMPACT_RETAIN_MAX, "compactRetain"]',
      "会话 ⚙「上下文压缩」页里也有这两个输入行（两个入口同源）");
    const i18nMiss2 = [
      "保留原文",
      "摘要上限",
      "压缩后大小已更新（下一个新会话生效）",
      "已跟随档位默认（下一个新会话生效）",
      "保留原文要填 4K – 128K 之间的整数（留空 = 跟随档位）。",
      "摘要上限要填 4K – 256K 之间的整数（留空 = 跟随档位）。",
      "剩下的上文都在保留量之内，没有可压缩的内容",
    ].filter((k) => I18N4.indexOf('"' + k + '":') < 0);
    ok(i18nMiss2.length === 0, "本轮新增的 i18n 键都在词条表里：" + (i18nMiss2.join(" / ") || "齐"));
  }

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-token-budget)",
  );
  if (fails) MERGED_FAILED = true; /* 主体自己的失败也必须进退出码（原先只打印、不影响退出码） */
})().catch((e) => {
  MERGED_FAILED = true;
  console.error("smoke-token-budget 运行异常：" + (e && e.stack ? e.stack : e));
});

/* ==================== 已并入：test/smoke-token-badge-bottom.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-token-badge-bottom.js";
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
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n?/g, "\n");

  const ASSIST = read("renderer/app-assist.js");
  const APP = read("renderer/app.js");
  const AGENT = read("renderer/app-agent.js");
  const DSH_CSS = read("renderer/css/dsh.css");

  /* ==================== [1] 尾部容器样式 ==================== */
  console.log("\n[1] 会话最底部：报告挂到输入框下面的尾部容器");
  const tailFrom = DSH_CSS.indexOf(".agent-body > .tok-badge,\n.assist-pane > .tok-badge {");
  const tailSrc =
    tailFrom > 0 ? DSH_CSS.slice(tailFrom, DSH_CSS.indexOf("}", tailFrom) + 1) : "";
  ok(tailFrom > 0, "dsh.css 有「.agent-body / .assist-pane > .tok-badge」尾部容器规则组");
  ok(/flex: none;/.test(tailSrc), "尾部容器里的 Badge 仍是 flex:none（不抢消息区高度）");
  const agentWFrom = DSH_CSS.indexOf(".agent-body > .tok-badge {");
  const agentWSrc =
    agentWFrom > 0 ? DSH_CSS.slice(agentWFrom, DSH_CSS.indexOf("}", agentWFrom) + 1) : "";
  ok(agentWFrom > 0, "摘到会话面板尾部容器的真样式");
  ok(
    /width: calc\(100% - 36px\);/.test(agentWSrc) && /max-width: 784px;/.test(agentWSrc),
    "会话面板：与输入区同宽（输入区 820 上限 − 左右 18px 内边距）",
  );
  ok(/margin: 0 auto 14px/.test(agentWSrc), "会话面板：与输入区同轴居中，落在最底部");
  /* 用 lastIndexOf：前面那条规则组的末行也是 `.assist-pane > .tok-badge {` */
  const assistWFrom = DSH_CSS.lastIndexOf(".assist-pane > .tok-badge {");
  const assistWSrc =
    assistWFrom > 0 ? DSH_CSS.slice(assistWFrom, DSH_CSS.indexOf("}", assistWFrom) + 1) : "";
  ok(assistWFrom > 0, "摘到助手栏尾部容器的真样式");
  ok(/margin: 0 10px 10px/.test(assistWSrc), "助手栏：与消息区 / 输入行同边距");

  const stickyFrom = DSH_CSS.indexOf(".agent-conv > .tok-badge,");
  const stickySrc =
    stickyFrom > 0 ? DSH_CSS.slice(stickyFrom, DSH_CSS.indexOf("}", stickyFrom) + 1) : "";
  ok(stickyFrom > 0, "节点内会话的吸附规则组仍在（.agent-conv / .chat-list）");
  ok(
    /\.agent-conv > \.tok-badge,/.test(stickySrc) && /\.chat-list > \.tok-badge \{/.test(stickySrc),
    "节点内会话进吸附选择器（节点框没余量，报告仍钉消息区下沿）",
  );
  ok(/position: sticky;/.test(stickySrc), "position: sticky（贴住滚动视口，不脱离文档流）");
  ok(/bottom: 0;/.test(stickySrc), "bottom: 0（恒贴可视区下沿，向上翻历史也不消失）");
  ok(/z-index: 6;/.test(stickySrc), "z-index 抬升（压在消息正文之上）");
  ok(/margin-bottom: 0;/.test(stickySrc), "末位外边距清零（否则滚动内容从 Badge 底下的缝里露出来）");
  ok(
    !/\.agent-list > \.tok-badge/.test(DSH_CSS) && !/\.assist-list > \.tok-badge/.test(DSH_CSS),
    "消息区吸附已从 .agent-list / .assist-list 撤掉（报告不再沉在消息流里）",
  );
  ok(
    !/\.agent-list \.tok-badge,/.test(DSH_CSS) && !/\.assist-list \.tok-badge \{/.test(DSH_CSS),
    "消息区里的旧边距规则（margin: 10px 8px 4px）一并清掉",
  );
  ok(
    /\.tok-badge \{[\s\S]{0,200}flex: none/.test(DSH_CSS),
    "Badge 基础样式仍是 flex:none（尾部容器里不改变它在列里的尺寸口径）",
  );
  ok(
    !/badge\.style\.margin = "6px 6px 0";/.test(APP) &&
      /function nodeTokOwnerNoBadge\(owner\)/.test(AGENT),
    "节点内会话不再挂报告：行内边距清底那段随挂点一起删掉，宿主判定加节点归属闸",
  );

  /* ==================== [2] 展开态封顶 ==================== */
  console.log("\n[2] 展开态封顶：报告不会高过容器把上沿顶出去");
  const bodyFrom = DSH_CSS.indexOf(".tok-badge-body {");
  const bodySrc =
    bodyFrom > 0 ? DSH_CSS.slice(bodyFrom, DSH_CSS.indexOf("}", bodyFrom) + 1) : "";
  ok(bodyFrom > 0, "摘到 .tok-badge-body 真样式");
  ok(/overflow: auto;/.test(bodySrc), "正文区纵横向都能滚（原 overflow-x 不够用）");
  ok(/max-height: min\(42vh, 360px\)/.test(bodySrc), "正文区封顶（视口与绝对值取小）");

  /* ==================== [3] 宿主判定 + 渲染路径 ==================== */
  console.log("\n[3] 接线：宿主判定走「输入框下面」的尾部容器");
  ok(
    /function tokAgentTailHost\(\)/.test(AGENT) &&
      /closest\("\.agent-composer"\)/.test(AGENT) &&
      /return document\.querySelector\("\.agent-body"\);/.test(AGENT),
    "会话面板尾部容器 = .agent-composer 的父级（拿不到退回 .agent-body）",
  );
  ok(
    /sid === "assist"[\s\S]{0,140}assistPane[\s\S]{0,140}assistList/.test(AGENT),
    "助手栏宿主 = #assistPane（退化 #assistList）",
  );
  ok(
    /S\.agentActiveId === sid[\s\S]{0,160}tokAgentTailHost\(\)/.test(AGENT),
    "当前会话宿主 = 尾部容器（不再是 #agentList 消息区）",
  );
  ok(
    /const conv = document\.querySelector\([\s\S]{0,140}\.agent-conv[\s\S]{0,80}if \(conv\) return conv;/.test(
      AGENT,
    ),
    "节点内会话宿主仍是 .agent-conv（节点框没余量，口径单独保留）",
  );
  ok(
    /existing\.parentElement/.test(AGENT) && /sid === "assist"[\s\S]{0,900}\.chat-list/.test(AGENT),
    "宿主判定顺序未动（先认已有父级 → 助手栏 → 当前会话 → 节点会话 → 绑定会话）",
  );
  ok(
    /function tokBadgeTailMount\(owner, list\)/.test(AGENT) &&
      /list\.querySelectorAll\("\.tok-badge"\)/.test(AGENT) &&
      /host\.appendChild\(badge\);/.test(AGENT),
    "tokBadgeTailMount：清掉消息区残留的旧 Badge，再把新的挂到尾部容器末尾",
  );
  ok(
    /const kids = host\.children \|\| \[\];[\s\S]{0,240}classList\.contains\("tok-badge"\)[\s\S]{0,60}\.remove\(\);/.test(
      AGENT,
    ),
    "尾部容器只留当前归属的一枚（换会话 / 换归属先清干净）",
  );
  ok(
    /if \(!found\.length\) \{[\s\S]{0,180}tokBadgeTailMount\(owner\);/.test(AGENT),
    "局部刷新（tokBadgeTouch）：无 Badge 时走同一口补挂",
  );
  ok(
    /const list = \$\("#agentList"\);/.test(ASSIST) &&
      /tokBadgeTailMount\(st, list\);/.test(ASSIST),
    "会话（#agentList）：渲染收尾挂到输入框下面的尾部容器",
  );
  ok(
    /const list = \$\("#assistList"\);/.test(ASSIST) &&
      /tokBadgeTailMount\(assistTokOwner\(\), list\);/.test(ASSIST),
    "助手栏（#assistList）：渲染收尾挂到输入行下面的尾部容器",
  );
  ok(
    !/const badge = tokBadgeEl\(st\);[\s\S]{0,140}list\.appendChild\(badge\);/.test(ASSIST) &&
      !/const badge = tokBadgeEl\(assistTokOwner\(\)\);[\s\S]{0,140}list\.appendChild\(badge\);/.test(
        ASSIST,
      ),
    "两条面板路径都不再把报告塞进消息区末尾",
  );
  ok(
    !/const badge = owner && tokBadgeEl\(owner\);/.test(APP) &&
      /不再挂 Token 报告徽章/.test(APP),
    "节点内会话（.agent-conv）：渲染收尾不再挂报告（本轮需求：智能任务节点不带下方 token 预算栏）",
  );
  ok(
    /if \(nodeTokOwnerNoBadge\(owner\)\) return null;/.test(AGENT),
    "宿主判定：节点归属的 owner 直接回 null（徽章不再落到 .agent-conv / .chat-list）",
  );

  /* ==================== [4] 费用口径说明入口已整体移除 ====================
     本次需求：会话底部说明「费用为什么高于实际消费」随问题解决一并撤下 ——
     三处挂点（会话折叠摘要 / 会话合计行 / 节点 Token 弹窗）、那套小节函数、
     中英词条与 dsh.css 的样式全部删净，不留死代码与死规则。 */
  console.log("\n[4] 「费用为什么高于实际消费」口径说明入口已整体移除（代码 / 词条 / 样式）");
  const COST = read("renderer/app-cost.js");
  const I18N_SRC = read("renderer/i18n.js");
  ok(
    !/costHelpEl|costWhyLines|costWhyText|costWhyDialog|COST_WHY_TITLE/.test(AGENT + APP + COST + ASSIST),
    "三处挂点与小节函数全删净（会话折叠摘要 / 会话合计行 / 节点 Token 弹窗都不再挂「？」）",
  );
  ok(
    !/tok-cost-help|tok-cost-why/.test(DSH_CSS),
    "dsh.css 的两套样式（? 圆钮 / 口径弹窗正文）一并删掉，不留死规则",
  );
  ok(
    !/"费用为什么高于实际消费？":/.test(I18N_SRC) &&
      !/"口径：官方路由的单价与峰谷按官方价格页/.test(I18N_SRC) &&
      !/"对账请以 DeepSeek 账单和余额变化为准。":/.test(I18N_SRC),
    "i18n 不再登记说明入口的标题与整批说明词条（英文界面也不会再冒出这批文案）",
  );
  ok(
    !/costWhyLines\(\)/.test(AGENT),
    "复制的 Token 报告回到「只报数」：不再往报告尾部追加那段口径说明",
  );

  console.log(
    "\n" +
      (fails ? " " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-token-badge-bottom)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-token-badge-bottom.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-token-badge-bottom.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：先等主体（async）跑完，再连同并入块的结论定退出码 —— 顺序不能反 */
MAIN.then(() => {
  if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
  process.exit(MERGED_FAILED ? 1 : 0);
});

"use strict";
/* SenseNova 本地图像生成节点（sensenova_gen · 插件 sensenova-local）的注册与契约回归
 *   node test/smoke-sensenova.js
 * 与 test/smoke-yue.js 同一套路：能用真实函数验的（端子数 / 类型名 / 桶表 / 归一 / 扩展名）就从
 * renderer 源码里按名字抠出来在 vm 里真跑，其余（菜单成员、IPC 通道对、打包白名单、插件卡
 * 分支、指南与图标、随包后端契约）做源码级契约断言。**不依赖真实后端**：不装环境、不起服务、
 * 不下载 32.66GB 权重、不出图。
 *
 * 锁住的需求（SenseNova 节点移植，任务 1-8）：
 *   1. 渲染层节点注册点齐全：KIND_CLS / KIND_ICON_SVG / NODE_DEFAULTS / 端子泛用增量
 *      （无连线 1 入 · 连一条多一条）+ 输出 2 出
 *   2. 右键「图像生成」子菜单里有 SenseNova（与云端文生图 proc_image 同组）
 *   3. 执行链：playSensenovaGenNode + 媒体串行链 + 全局音视频锁 + 抽卡种子 + 取消 + 图像输出
 *   4. 端子契约（与 proc_image 同一条泛用增量规则）：端口 0 = 提示词 / 文本入口 ·
 *      端口 1+ = 增量数据槽（文本与图像引用都收）· 输出 0 = 图像 · 输出 1 = 控制输出；
 *      落盘**不要求用户填路径**（不下发 outputDir/filename，由宿主落应用托管目录后回传绝对路径）
 *   5. 设置表单：官方 11 个训练桶 / 步数 / CFG / 显存档位 / 精度 / think / 抽卡 / 种子（无「输出路径」项）
 *   6. IPC：preload 白名单 ⇄ 宿主 handle 与事件一一成对；main.js 三处接线
 *   7. 打包与插件：build.json 白名单 / extraResources · catalog 卡片 · 插件卡与自动修复分支
 *   8. i18n 中英词条齐 · 节点指南（中英 + 索引 + 图）齐 · 图标
 *   9. 随包后端契约：sensenova-pack manifest（id / 端口 / 入口 / 磁盘）/ server 路由与错误码 /
 *      engine 反归一化与 torch.no_grad()（不得回退 inference_mode）/ install.ps1 国内镜像清单
 *      （无「裸 GitHub 唯一路径」）与关键边界（--no-deps / -SkipModels / progress / 结果标记）
 *
 * 覆盖：
 *   [1] app.js 注册点（真实 inputCount / outputCount / minWFor / nodeKindLabel / 桶表在 vm 里跑）
 *   [2] 菜单 / 拖线落点 / 停止 / 老档迁移
 *   [3] app-nodes.js 执行链与连线规则（含 agent 快照字段）
 *   [4] app-canvas.js 设置表单 / 端子渲染 / 节点体
 *   [5] 全局音视频互斥锁
 *   [6] IPC 通道与 main.js 接线
 *   [7] build.json / 插件目录 / 插件卡 / 自动修复 / 安装技能
 *   [8] i18n / 指南 / 图标
 *   [9] sensenova-pack 后端契约与国内镜像安装脚本
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + show(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + show(needle) + "）"));
};
const count = (src, re) => (src.match(re) || []).length;
const uniq = (arr) => [...new Set(arr)];
const sorted = (arr) => arr.slice().sort();
const sq0 = (buckets) => {
  const b = buckets.find((x) => x.ratio === "1:1") || {};
  return (Number(b.width) || 0) * (Number(b.height) || 0);
};
const buildSrc = read("build.json"); /* JSONC（含块注释）：按文本断言，不做 JSON.parse */

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
  const start = iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
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

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");
const canvasSrc = read("renderer/app-canvas.js");
const i18nSrc = read("renderer/i18n.js");
const lockSrc = read("media-gen-global-lock.js");
const preloadSrc = read("preload.js");
const mainSrc = read("main.js");
const hostSrc = read("sensenova/main-sensenova.js");
const hostPreloadSrc = read("sensenova/preload-sensenova.js");
const pluginsMainSrc = read("plugins/main-app-plugins.js");
const appPluginsSrc = read("renderer/app-plugins.js");
const appRepairSrc = read("renderer/app-repair.js");
const catalog = JSON.parse(read("plugins/catalog.default.json"));
const nodeIdx = JSON.parse(read("guides/nodes/index.json"));
const packManifest = JSON.parse(read("sensenova-pack/manifest.json"));
const installPs1 = read("sensenova-pack/scripts/install.ps1");
const serverPy = read("sensenova-pack/app/server.py");
const enginePy = read("sensenova-pack/app/engine.py");
const skillMd = read("skills/sensenova-local-install/SKILL.md");

/* ---------- [1] 真实函数跑在 vm 里（端子数 / 类型名 / 尺寸按源文件真值验） ---------- */
/* app.js 的 inputCount 在 vm 里真跑：allWiresTo 反映这份可变连线表（默认无连线） */
let SANDBOX_WIRES = [];
/* app-nodes.js 取值口（sensenovaGenPromptText / sensenovaGenRefPaths）的输入：用例逐条替换 */
let SANDBOX_INPUTS = [];
const SANDBOX_STUBS = {
  I18n: { t: (s) => String(s) },
  /* 只在该 kind 走到对应分支时才会被调；其余给安全替身避免 ReferenceError */
  allWiresTo: () => SANDBOX_WIRES,
  /* —— 取值侧 stub：与 proc_image 同一条链（inputValuesFor → resolveRefs → assemblePrompt /
     runImagePaths）。只验「接线照收」，@ 引用展开与全局广播由 app.js 的既有回归覆盖。 —— */
  inputValuesFor: () => SANDBOX_INPUTS,
  resolveRefs: (text) => ({ prompt: String(text || ""), textSources: [], imagePaths: [] }),
  assemblePrompt: (p, srcs) =>
    [String(p || "")]
      .concat((srcs || []).map((s) => (s && s.text) || ""))
      .filter((s) => String(s).trim())
      .join("\n"),
  runImagePaths: (node, i, refs, images) => (images || []).slice(),
  assetItems: () => [],
  isAssetNode: () => false,
  superIsOpenShell: () => false,
  superExternalInWiresAll: () => [],
  superInternalBridgeWiresAll: () => [],
  superExternalOutWiresAll: () => [],
  superInternalOutFeedsAll: () => [],
  superDynamicPortCount: () => 0,
  fnToolParamList: () => [],
  videoGenInputCount: () => 2,
  videoPostInputCount: () => 2,
  attemptCount: (n) => Math.max(1, Math.min(10, Number(n && n.attempts) || 1)),
};
const APP_FNS = [
  "KIND_CLS",
  "KIND_ICON_SVG",
  "nodeKindCls",
  "nodeKindLabel",
  "nodeKindPurposeKey",
  "inputCount",
  "hasFixedInPorts",
  "outputCount",
  "minWFor",
  "minHFor",
  "isExecStart",
  "isExecEnd",
  "ctrlRoleOf",
  "isSaveKind",
  "isSaveNode",
  "isToolNode",
  "isFunctionNode",
  "isFnToolNode",
  "isVideoPostKind",
  "SENSENOVA_RESOLUTION_BUCKETS",
  "SENSENOVA_VRAM_MODES",
  "SENSENOVA_DTYPES",
  "SENSENOVA_CFG_NORMS",
  "sensenovaResolutionBuckets",
  "sensenovaNormalizeNode",
  "sensenovaSizeSummary",
  "mediaGenExt",
  "isImageSource",
  "isImageWireFrom",
  "inferMediaFromSource",
];
const sandbox = Object.assign(
  {
    console,
    Math,
    JSON,
    Set,
    Map,
    WeakMap,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
  },
  SANDBOX_STUBS,
);
vm.createContext(sandbox);
vm.runInContext(APP_FNS.map((n) => fnBody(appSrc, n)).join("\n"), sandbox, {
  filename: "sensenova-extract.js",
});
const G = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);

/* ---------- [1b] app-nodes.js 的取值口也跑真实函数（验证端子泛化后「接线照收」） ---------- */
const NODES_FNS = [
  "sensenovaGenPromptText",
  "sensenovaGenRefPaths",
  "normalizeGpuReading",
];
const nodesSandbox = Object.assign(
  {
    console,
    Math,
    JSON,
    Set,
    Map,
    WeakMap,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
  },
  SANDBOX_STUBS,
);
vm.createContext(nodesSandbox);
vm.runInContext(NODES_FNS.map((n) => fnBody(nodesSrc, n)).join("\n"), nodesSandbox, {
  filename: "sensenova-nodes-extract.js",
});
const NG = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", nodesSandbox);

/* NODE_DEFAULTS 是数据块（initializer 引用别的常量），按源码文本核对 */
const ndBlock = (() => {
  const at = appSrc.indexOf("const NODE_DEFAULTS = {");
  const end = appSrc.indexOf("\n};", at);
  return at < 0 ? "" : appSrc.slice(at, end);
})();
const snDefaults = (ndBlock.match(/sensenova_gen:\s*\{([\s\S]*?)\n  \},/) || [null, ""])[1];

/* ---------------------------------------------------------------- */
(async function main() {
  console.log("\n[ex] 源码抽取自检");
  eqArr(
    APP_FNS.filter((n) => typeof G(n) !== "function" && typeof G(n) !== "object").filter(
      (n) => n !== "SENSENOVA_RESOLUTION_BUCKETS",
    ),
    [],
    "app.js 目标函数全部抽到真实实现",
  );
  ok(G("KIND_CLS") && typeof G("KIND_CLS") === "object", "KIND_CLS 数据块已抽到");
  ok(G("KIND_ICON_SVG") && typeof G("KIND_ICON_SVG") === "object", "KIND_ICON_SVG 数据块已抽到");
  ok(Array.isArray(G("SENSENOVA_RESOLUTION_BUCKETS")), "SENSENOVA_RESOLUTION_BUCKETS 表格已抽到");
  eqArr(
    NODES_FNS.filter((n) => typeof NG(n) !== "function"),
    [],
    "app-nodes.js 取值口（sensenovaGenPromptText / sensenovaGenRefPaths / normalizeGpuReading）也抽到真实实现",
  );

  /* ===================== [1] app.js 注册点 ===================== */
  console.log("\n[1] app.js：节点注册点与端子（真实函数在 vm 里跑）");
  eqStr(G("KIND_CLS").sensenova_gen, "proc-img", "KIND_CLS.sensenova_gen 复用图像生成族配色（proc-img）");
  eqStr(G("KIND_CLS").sensenova_gen, G("KIND_CLS").proc_image, "与云端文生图 proc_image 同色族");
  const icon = G("KIND_ICON_SVG").sensenova_gen;
  ok(typeof icon === "string" && icon.indexOf("<svg") === 0 && icon.indexOf("</svg>") > 0, "KIND_ICON_SVG.sensenova_gen 是一段完整 SVG");
  has(icon, 'stroke="currentColor"', "图标用 currentColor 描边（跟相邻线性图标同风格）");
  ok(icon !== G("KIND_ICON_SVG").proc_image, "SenseNova 图标不与云端文生图雷同");

  ok(snDefaults.length > 0, "NODE_DEFAULTS 里有 sensenova_gen 的默认值");
  has(snDefaults, 'title: "SenseNova 图像节点"', "新建 sensenova_gen 的默认标题");
  eqStr(snDefaults.match(/w:\s*(\d+)/)[1], "360", "sensenova_gen 默认宽 360");
  eqStr(snDefaults.match(/h:\s*(\d+)/)[1], "300", "sensenova_gen 默认高 300");
  for (const f of ["prompt", "ratioBucket", "width", "height", "numSteps", "cfgScale", "cfgNorm", "timestepShift", "seed", "rerollSeed", "attempts", "vramMode", "dtype", "think", "sensenovaStatus"])
    has(snDefaults, f + ":", "NODE_DEFAULTS.sensenova_gen 带字段 " + f);
  hasnt(snDefaults, "outputPath:", "NODE_DEFAULTS.sensenova_gen 不再带 outputPath（产物落应用托管目录后回传）");
  has(snDefaults, 'ratioBucket: "1:1"', "默认画幅 = 官方 1:1 桶");
  has(snDefaults, 'vramMode: "fast"', "默认显存档位 = fast（官方 24G 卡档）");
  has(snDefaults, 'dtype: "bfloat16"', "默认精度 = bfloat16");

  const snNode = { id: "s1", kind: "sensenova_gen", title: "SenseNova" };
  eqNum(G("inputCount")(snNode), 1, "sensenova_gen 无连线时输入端子 = 1（泛用动态端子，与 proc_image 同一规则）");
  ok(G("hasFixedInPorts")(snNode) === false, "sensenova_gen 不是固定端子节点（端子数随连线增量）");
  SANDBOX_WIRES = [{ to: "s1" }, { to: "s1" }];
  eqNum(G("inputCount")(snNode), 3, "连 2 条线 → 输入端子 3（端口 0 = 提示词 + 两条增量数据槽）");
  SANDBOX_WIRES = [];
  eqNum(G("outputCount")(snNode), 2, "sensenova_gen 输出端子数 = 2（0=图像 · 1=控制输出）");
  eqNum(G("minWFor")(snNode), 340, "sensenova_gen 最小宽 340");
  eqNum(G("minHFor")(snNode), 240, "sensenova_gen 最小高 240");
  eqStr(G("nodeKindLabel")(snNode), "SenseNova", "nodeKindLabel(sensenova_gen) = SenseNova");
  eqStr(G("nodeKindCls")(snNode), "proc-img", "nodeKindCls(sensenova_gen) 落到图像生成族");
  const purpose = G("nodeKindPurposeKey")(snNode);
  ok(!!purpose, "sensenova_gen 有用途文案键");
  has(i18nSrc, '"' + purpose + '"', "用途文案键在 i18n 里有词条：" + purpose);

  const buckets = G("SENSENOVA_RESOLUTION_BUCKETS");
  eqNum(buckets.length, 11, "官方分辨率桶恰好 11 个（不是自由值）");
  eqArr(sorted(buckets.map((b) => b.ratio)), ["16:9", "1:1", "1:2", "1:3", "2:1", "2:3", "3:1", "3:2", "3:4", "4:3", "9:16"], "11 个桶名与官方训练分辨率一致");
  ok(buckets.every((b) => b.width > 0 && b.height > 0), "每个桶都有正宽高");
  ok(
    buckets.every((b) => b.width * b.height >= 3900000) && sq0(buckets) === 2048 * 2048,
    "最小那桶也 ≈ 4M 像素（1:1 = 2048×2048；降分辨率省不了显存）",
  );
  const sq = buckets.find((b) => b.ratio === "1:1");
  eqNum(sq.width, 2048, "1:1 桶 = 2048");
  eqNum(sq.height, 2048, "1:1 桶 = 2048");
  eqArr(G("SENSENOVA_VRAM_MODES"), ["full", "fast", "balanced", "low"], "显存档位四档与后端 vramModes 同序");
  eqArr(G("SENSENOVA_DTYPES"), ["bfloat16", "float16", "float32"], "精度三档");
  eqArr(G("SENSENOVA_CFG_NORMS"), ["none", "global", "channel", "cfg_zero_star"], "CFG Norm 四档");

  /* 后端 /health 的 resolutions 优先；没起服回落兜底表 */
  eqNum(G("sensenovaResolutionBuckets")(null).length, 11, "后端未起服 → 回落 11 桶兜底表");
  const fromHealth = G("sensenovaResolutionBuckets")({ resolutions: [{ ratio: "21:9", width: 3072, height: 1316 }] });
  eqArr(fromHealth.map((b) => b.ratio), ["21:9"], "后端 /health 给的桶表优先（同一份 ratio→WxH 口径）");

  /* 归一：桶名 → WxH；枚举夹紧；不认识的值回落 */
  const norm = { id: "n1", kind: "sensenova_gen", ratioBucket: "16:9", numSteps: 9999, cfgScale: -5, cfgNorm: "bogus", timestepShift: 99, vramMode: "nope", dtype: "bad", seed: 3.7, attempts: 42 };
  G("sensenovaNormalizeNode")(norm);
  eqNum(norm.width, 2720, "归一：16:9 桶带出宽 2720");
  eqNum(norm.height, 1536, "归一：16:9 桶带出高 1536");
  eqNum(norm.numSteps, 200, "归一：步数夹到上限 200");
  eqNum(norm.cfgScale, 0, "归一：CFG 夹到下限 0");
  eqStr(norm.cfgNorm, "none", "归一：非法 cfgNorm 回落 none");
  eqNum(norm.timestepShift, 20, "归一：Shift 夹到上限 20");
  eqStr(norm.vramMode, "fast", "归一：非法档位回落 fast");
  eqStr(norm.dtype, "bfloat16", "归一：非法精度回落 bfloat16");
  eqNum(norm.seed, 3, "归一：种子取整");
  eqNum(norm.attempts, 10, "归一：抽卡夹到上限 10");
  eqNum(norm.imgCfgScale, 1, "归一：参考图条件强度缺省 1.0（= 官方默认，图像 CFG 关闭）");
  const norm3 = { id: "n3", kind: "sensenova_gen", imgCfgScale: 99 };
  G("sensenovaNormalizeNode")(norm3);
  eqNum(norm3.imgCfgScale, 20, "归一：参考图条件强度夹到上限 20");
  const norm2 = { id: "n2", kind: "sensenova_gen", ratioBucket: "不认识的桶", width: 3456, height: 1152 };
  G("sensenovaNormalizeNode")(norm2);
  eqStr(norm2.ratioBucket, "3:1", "归一：桶名不认识时按现有 WxH 反查回桶名");

  eqStr(G("sensenovaSizeSummary")({ ratioBucket: "2:1", width: 2880, height: 1440 }), "2:1 · 2880x1440", "一行摘要 = 桶名 · WxH");

  /* 图像族口径：产物是图像（下游 save_image / 预览 / @ 引用直接复用） */
  eqStr(G("mediaGenExt")(snNode), ".png", "sensenova_gen 输出扩展名固定 .png");
  ok(G("isImageSource")(snNode) === true, "isImageSource(sensenova_gen) = true");
  ok(G("isImageWireFrom")(snNode, 0) === true, "isImageWireFrom(sensenova_gen, 0) = true（图像端子语义与 proc_image 一致）");
  eqStr(G("inferMediaFromSource")(snNode), "image", "inferMediaFromSource(sensenova_gen) = image");

  /* ===================== [2] 菜单 / 拖线落点 / 停止 / 迁移 ===================== */
  console.log("\n[2] 右键菜单 · 拖线落点 · 停止 · 老档迁移");
  has(appSrc, 'ctxSubmenu(I18n.t("图像生成")', "「图像生成」一级子菜单存在");
  const subAt = appSrc.indexOf('ctxSubmenu(I18n.t("图像生成")');
  const subBlock = appSrc.slice(subAt, appSrc.indexOf("]),", subAt));
  has(subBlock, '"proc_image"', "「图像生成」成员含云端文生图 proc_image");
  has(subBlock, '"sensenova_gen"', "「图像生成」成员含本地 sensenova_gen");
  ok(
    subBlock.indexOf('"proc_image"') < subBlock.indexOf('"sensenova_gen"'),
    "云端文生图在前、SenseNova 在后（菜单顺序）",
  );
  has(subBlock, 'I18n.t("SenseNova（本地图像生成 · SenseNova-U1.5-8B-MoT）")', "菜单项文案写明本地图像生成与后端名");
  has(subBlock, 'addNode("sensenova_gen"', "点菜单项真实建 sensenova_gen");
  const dropAt = appSrc.indexOf("const WIRE_DROP_TARGETS = [");
  const dropBlock = appSrc.slice(dropAt, appSrc.indexOf("];", dropAt));
  has(dropBlock, '{ kind: "sensenova_gen", g: "处理节点" }', "WIRE_DROP_TARGETS 收 sensenova_gen（拖线落空白处可就地新建）");
  has(appSrc, 'else if (node.kind === "sensenova_gen") node.sensenovaStatus = I18n.t("已取消");', "停止 sensenova_gen 时写 sensenovaStatus");
  const migAt = appSrc.indexOf("function migrateWf");
  ok(migAt > 0, "migrateWf 存在");
  const migBlock = appSrc.slice(migAt, appSrc.indexOf("\nfunction ", migAt + 10));
  has(migBlock, '"sensenova_gen"', "migrateWf 认识 sensenova_gen（老档归一）");
  has(migBlock, "sensenovaNormalizeNode", "迁移里走 sensenovaNormalizeNode");

  /* ===================== [3] app-nodes.js 执行链与连线 ===================== */
  console.log("\n[3] app-nodes.js：执行链 / 串行 / 抽卡 / 取消 / 连线规则");
  const playBody = fnBody(nodesSrc, "playSensenovaGenNode");
  ok(!!playBody, "playSensenovaGenNode 存在");
  has(playBody, "window.api.sensenovaGenerate", "生成走桥 api.sensenovaGenerate");
  has(playBody, "fetchMediaGenLock", "取全局音视频互斥锁（全局仅 1 个任务）");
  has(playBody, "mediaGenLockBusyMsg", "锁被别的节点占用时按「图像」提示并让位");
  has(playBody, "nextMediaGenSeed", "抽卡用通用种子 +1 逻辑");
  has(playBody, "sensenovaNormalizeNode", "下发生成请求前先把画幅归一成官方桶");
  has(playBody, "sensenovaGenPromptText", "提示词取端子优先 / 节点正文兜底");
  hasnt(playBody, "requireMediaGenExport", "执行链不再强制用户填输出路径（requireMediaGenExport 已移除）");
  hasnt(playBody, "prepareMediaGenRollExport", "不再逐轮解析导出路径（落盘交给主进程托管目录）");
  hasnt(playBody, "syncMediaGenPathFromExport", "不再回写节点输出路径（本节点没有 outputPath）");
  has(playBody, "sensenovaGenRefPaths", "参考图走 sensenovaGenRefPaths 采集后随 refImages 下发（图像编辑模式）");
  has(playBody, "sensenovaGenRefUsedText", "参考图生效文案进节点状态与 warnings（用户看得见）");
  has(playBody, "refImages: refPaths", "生成载荷把采集到的参考图路径下发给后端（refImages）");
  has(playBody, "imgCfgScale", "生成载荷带 imgCfgScale（参考图条件强度，图像编辑模式才生效）");
  hasnt(playBody, "sensenovaGenRefNotice", "旧的「纯文生图 → 忽略参考图」降级文案已移除");
  has(playBody, 'st.supported === false', "后端硬件门槛不过 → 硬停（不启动后端也不下权重）");
  has(playBody, 'kind: "image"', "产出标记为图像内容输出（node.output.kind = image）");
  has(playBody, "fireControlOutgoing", "完成后驱动控制输出端子");
  for (const k of ["nodeId", "workflowId", "prompt", "ratio", "width", "height", "numSteps", "cfgScale", "cfgNorm", "timestepShift", "seed", "vramMode", "dtype", "think", "rollIndex"])
    ok(
      new RegExp("\\b" + k + "\\s*[:,]").test(playBody),
      "生成载荷带 " + k + (new RegExp("\\b" + k + "\\s*[:,]").test(playBody) ? "" : "（缺）"),
    );
  for (const k of ["outputDir", "filename"])
    hasnt(playBody, k + ":", "生成载荷不下发 " + k + "（由宿主落应用托管目录后回传绝对路径）");
  has(playBody, '"image"', "输出端子类型按图像");
  const dispatch = fnBody(nodesSrc, "playNodeBody");
  has(dispatch, 'node.kind === "sensenova_gen"', "playNodeBody 认识 sensenova_gen");
  has(dispatch, "runMediaGenSerial(node, () => playSensenovaGenNode(node, quiet))", "sensenova_gen 经媒体串行链排队");
  const med = fnBody(nodesSrc, "isMediaGenNode");
  has(med, '"sensenova_gen"', "isMediaGenNode 名单里有 sensenova_gen（后端探活 / 终止 / 队列同一套）");
  const fetchFn = fnBody(nodesSrc, "fetchMediaBackendStatus");
  has(fetchFn, "window.api.sensenovaStatus", "后端探活问 api.sensenovaStatus");
  const listenFn = fnBody(nodesSrc, "bindMediaBackendListeners");
  has(listenFn, "window.api.onSensenovaProgress", "订阅 onSensenovaProgress（生成进度）");
  has(listenFn, "window.api.onSensenovaGpu", "订阅 onSensenovaGpu（显存监视）");
  has(hostSrc, '"sensenova:progress"', "宿主会发 sensenova:progress");
  has(hostSrc, '"sensenova:gpu"', "宿主会发 sensenova:gpu");
  /* 显存 / GPU 读数闪跳回归：status.gpu 是探测形（gpus[]），push 通道是单帧，
     渲染口不折算就会在一次探活回写后把真实读数刷成 0%（2s 探活 / 2s 推流交替 → 一直闪跳） */
  const normGpu = NG("normalizeGpuReading");
  const probeShape = {
    hasNvidia: true,
    gpus: [{ name: "RTX 4090", driver: "555.99", memTotalMb: 24576, memUsedMb: 12000, util: 87 }],
    maxVramGb: 24,
    driverVersion: "555.99",
  };
  eqStr(show(normGpu(probeShape)), show({ name: "RTX 4090", memUsed: 12000, memTotal: 24576, util: 87, memPct: 48.8 }), "探测形 status.gpu → 折算成单帧读数（不再是 undefined → 0%）");
  eqStr(show(normGpu({ name: "RTX 4090", memUsed: 12000, memTotal: 24576, util: 87, memPct: 48.8 })), show({ name: "RTX 4090", memUsed: 12000, memTotal: 24576, util: 87, memPct: 48.8 }), "单帧（push 通道 / 其余宿主 status）原样透传");
  eqStr(show(normGpu([{ name: "G", memUsed: 1, memTotal: 2, util: 3, memPct: 50 }])), show({ name: "G", memUsed: 1, memTotal: 2, util: 3, memPct: 50 }), "数组形读数取首卡");
  eqStr(show(normGpu({ hasNvidia: false, gpus: [], maxVramGb: 0 })), show(null), "无卡（gpus 空）→ null，不画假进度条");
  eqStr(show(normGpu(null)), show(null), "空读数 → null");
  has(fnBody(nodesSrc, "summarizeMediaBackendStatus"), "normalizeGpuReading(st.gpu)", "探活回写 ui.info 时就归一（bug 源头：sensenova status.gpu 是探测形）");
  has(fnBody(nodesSrc, "appendMediaBackendPanel"), "normalizeGpuReading(info.gpu)", "节点面板渲染口再兜一次归一");
  has(fnBody(nodesSrc, "mediaGenCancelRemote"), "sensenovaCancelGenerate", "画布「停止」调到 api.sensenovaCancelGenerate");
  has(nodesSrc, "SENSENOVA_ERROR_CODES", "渲染层有后端错误短码表");
  for (const code of ["not_installed", "no_cuda", "cuda_oom", "vram_too_low", "backend_start_timeout", "generate_failed", "save_failed", "busy_other_node"])
    has(fnBody(nodesSrc, "sensenovaGenErrorText"), code, "错误码翻人话覆盖 " + code);

  /* 连线规则（与 proc_image 同一条泛用增量规则）：数据线可接文本也可接图像引用；
     没有 sensenova 专用分支，控制线 / 数据线一律落第一个空闲端子 */
  const connBody = fnBody(nodesSrc, "connectError");
  hasnt(connBody, '"sensenova_gen"', "connectError 里没有 sensenova 专用分支（走通用泛用端子判定）");
  hasnt(connBody, "SenseNova", "connectError 里不再有 SenseNova 专用拦截文案");
  hasnt(nodesSrc, "SenseNova 图像节点需要文本来源（提示词）；它只吃文字", "不再拒绝图像来源（旧「只吃文字」拦截已删）");
  hasnt(nodesSrc, "SenseNova 图像节点控制输入端子为端口 1", "不再要求控制线落端口 1（旧固定控制端子已删）");
  hasnt(fnBody(nodesSrc, "SINGLE_DATA_IN_KINDS"), "sensenova_gen", "不再按「单数据端子」处理（增量端子多输入本就连得下）");
  const wireBody = fnBody(nodesSrc, "addWire");
  hasnt(wireBody, '"sensenova_gen"', "addWire 不再为 sensenova 特判（控制 / 数据线一律落第一个空闲端子）");
  has(wireBody, "firstFreeInPortIndex", "动态端子落点复用 firstFreeInPortIndex（与端子空闲判定同源）");

  /* 取值侧（真实函数跑在第二个 vm 里）：数据槽接入的文本进提示词、图像被采集成参考图 */
  const snVal = { id: "sv1", kind: "sensenova_gen", prompt: "", title: "SenseNova" };
  SANDBOX_INPUTS = [
    { title: "文本节点 1", value: { kind: "text", text: "雪山湖泊" } },
    { title: "图像节点 1", value: { kind: "image", path: "C:/img/a.png" } },
  ];
  eqStr(NG("sensenovaGenPromptText")(snVal), "雪山湖泊", "端口 0 接文本 → 该文本成为提示词（接线即提示词）");
  eqArr(NG("sensenovaGenRefPaths")(snVal), ["C:/img/a.png"], "数据槽接图像 → 采集成参考图并下发后端（端子照收，不拒绝连线）");
  const snVal2 = { id: "sv2", kind: "sensenova_gen", prompt: "海边日落", title: "SenseNova" };
  SANDBOX_INPUTS = [
    { title: "图像节点 2", value: { kind: "image", path: "C:/img/b.png" } },
    { title: "文本节点 2", value: { kind: "text", text: "补充说明" } },
  ];
  const p2 = NG("sensenovaGenPromptText")(snVal2);
  ok(p2.indexOf("海边日落") === 0, "节点自填提示词优先（得到 " + show(p2) + "）");
  has(p2, "补充说明", "其余数据槽文本并入背景块（与 proc_image 同一装配口径）");
  eqArr(NG("sensenovaGenRefPaths")(snVal2), ["C:/img/b.png"], "节点自填时图像槽仍被采集并下发（参考图真的参与生成）");
  SANDBOX_INPUTS = [];

  /* agent 可读可改的快照字段 */
  const snapIdx = nodesSrc.indexOf("const SNAPSHOT_PORT_KINDS = [");
  ok(snapIdx > 0, "SNAPSHOT_PORT_KINDS 清单存在");
  const snapBlock = nodesSrc.slice(snapIdx, nodesSrc.indexOf("];", snapIdx));
  has(snapBlock, '"sensenova_gen"', "SNAPSHOT_PORT_KINDS 含 sensenova_gen（定端口节点回 ports）");
  for (const f of ["sensenovaPrompt", "ratioBucket", "numSteps", "cfgScale", "cfgNorm", "vramMode", "think", "sensenovaStatus", "sensenovaOutput"])
    has(nodesSrc, f + ":", "快照字段暴露 " + f);
  has(fnBody(nodesSrc, "applyNodePatch"), "sensenovaPrompt", "applyNodePatch 认 sensenovaPrompt（读侧字段名也能写）");

  /* ===================== [4] app-canvas.js 设置表单与节点体 ===================== */
  console.log("\n[4] app-canvas.js：设置表单 / 端子渲染 / 节点体");
  const formAt = canvasSrc.indexOf('registerNodeSettingsForm("sensenova_gen"');
  ok(formAt > 0, "registerNodeSettingsForm('sensenova_gen') 已登记");
  const formBlock = canvasSrc.slice(formAt, canvasSrc.indexOf("\n});", formAt));
  has(formBlock, "nsSensenovaGenParamFields", "表单挂桶表 / 采样 / 显存档位字段");
  has(formBlock, "sensenovaGenParamSummaryText", "表单 summary 与 body 摘要同源");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.ratioBucket", "桶选择写 node.ratioBucket");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.width", "桶选择连带写 node.width");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.numSteps", "采样步数写 node.numSteps");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.vramMode", "显存档位写 node.vramMode");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.dtype", "精度写 node.dtype");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.think", "think 写 node.think");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.rerollSeed", "摇数写 node.rerollSeed");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.attempts", "抽卡写 node.attempts");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.imgCfgScale", "参考图条件强度写 node.imgCfgScale");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "node.seed", "种子写 node.seed");
  has(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "sensenovaBucketItems", "桶表下拉走 sensenovaBucketItems（真源后端 /health）");
  hasnt(fnBody(nodesSrc, "nsSensenovaGenParamFields"), "nsMediaGenPathField", "设置表单里没有「输出路径」项（产物自动落应用托管目录）");
  has(canvasSrc, "nsSensenovaGenParamFields(ctx, ctx.node)", "设置窗 build 里真挂该字段组");
  has(canvasSrc, 'appPluginInstalled("sensenova-local")', "节点体按插件 id sensenova-local 判未装警示条");
  has(canvasSrc, "appendSensenovaGenSummaryBody(node, body)", "节点体画 sensenova_gen 参数摘要");
  has(canvasSrc, "node.sensenovaStatus", "节点体有 sensenovaStatus 状态行");
  hasnt(canvasSrc, '(node.kind === "sensenova_gen" && i === 1)', "端子渲染：不再把端口 1 当控制输入（无固定控制端子）");
  has(canvasSrc, 'I18n.t("提示词（要画成什么 · 可接文本节点，也可接参考图）")', "端子渲染：端口 0 tooltip = 提示词（可接文本，也可接参考图）");
  has(canvasSrc, 'I18n.t("（数据槽：可接文本 / 图像）")', "端子渲染：端口 1+ 标注为增量数据槽（文本 / 图像都收）");
  /* 端口类型 / 端口名真源（app-nodes.js 的 editPortKindOf / editPortNameOf 两张表）：
     端口 0 = 提示词（text）· 端口 1+ = any（由连线决定，文本与图像引用都收）；输出 0 = image · 1 = control */
  const snInKind = (fnBody(nodesSrc, "editPortKindOf").match(/k === "sensenova_gen"\)[^\n]*/) || [""])[0];
  has(snInKind, '"text"', "端口类型真源：sensenova_gen 端口 0 = text");
  has(snInKind, '"any"', "端口类型真源：sensenova_gen 端口 1+ = any（文本 / 图像引用都收）");
  const snInName = (fnBody(nodesSrc, "editPortNameOf").match(/if \(k === "sensenova_gen"\)[\s\S]{0,120}/) || [""])[0];
  has(snInName, 'I18n.t("提示词")', "端口名真源：sensenova_gen 端口 0 = 提示词");
  has(snInName, 'I18n.t("输入端子 ")', "端口名真源：sensenova_gen 端口 1+ = 输入端子 N（不再叫「控制」）");
  const snKindOut = (fnBody(nodesSrc, "editPortKindOf").match(/sensenova_gen"\) return i === 0 \? "image"[^\n]*/) || [""])[0];
  has(snKindOut, '"control"', "端口类型真源：sensenova_gen 输出 0 = image · 输出 1 = control");
  has(canvasSrc, 'else if (node.kind === "sensenova_gen" && oi === 0)', "端子渲染：输出端口 0 是图像端子");
  has(canvasSrc, "SenseNova 插件未安装：请", "节点体写明未装时的安装指引");
  has(canvasSrc, "调用 SenseNova 本地后端生成图像", "节点头部 ▶ 的 tooltip 指向本机后端");
  has(nodesSrc, "打开 SenseNova 控制台日志", "节点头部可开控制台日志");

  /* ===================== [5] 全局音视频互斥锁 ===================== */
  console.log("\n[5] media-gen-global-lock.js：忙时文案按「图像」说");
  const busy = fnBody(lockSrc, "busyMessage");
  has(busy, '"sensenova_gen"', "busyMessage 认识 sensenova_gen");
  has(busy, '"图像"', "忙时文案复用「图像」标签");

  /* ===================== [6] IPC 通道与 main.js 接线 ===================== */
  console.log("\n[6] IPC：preload 白名单 ⇄ 宿主 handle / 事件一一成对");
  const handles = uniq([...hostSrc.matchAll(/ipcMain\.handle\("(sensenova:[^"]+)"/g)].map((m) => m[1]));
  const invokes = uniq([...preloadSrc.matchAll(/ipcRenderer\.invoke\('(sensenova:[^']+)'/g)].map((m) => m[1]));
  eqNum(handles.length, 22, "宿主注册 22 个 sensenova: handle");
  eqArr(sorted(invokes), sorted(handles), "preload invoke 通道与宿主 handle 完全一致（不多不少）");
  const expectedHandles = [
    "sensenova:getStatus", "sensenova:pickInstallDir", "sensenova:setInstallDir", "sensenova:setConfig",
    "sensenova:install", "sensenova:agentInstall", "sensenova:agentRecoverInstall", "sensenova:selfRepair",
    "sensenova:cancelInstall", "sensenova:start", "sensenova:stop", "sensenova:ensureReady",
    "sensenova:generate", "sensenova:cancelGenerate", "sensenova:forceKill", "sensenova:getLock",
    "sensenova:consoleTail", "sensenova:gpuProbe", "sensenova:health", "sensenova:open",
    "sensenova:close", "sensenova:removePluginMeta",
  ];
  eqArr(sorted(handles), sorted(expectedHandles), "22 个通道名与冻结清单逐个对上");
  const sends = uniq([...hostSrc.matchAll(/"sensenova:(progress|gpu|consoleChanged)"/g)].map((m) => "sensenova:" + m[1]));
  const ons = uniq([...preloadSrc.matchAll(/ipcRenderer\.on\('(sensenova:[^']+)'/g)].map((m) => m[1]));
  eqArr(sorted(sends), sorted(["sensenova:progress", "sensenova:gpu", "sensenova:consoleChanged"]), "宿主发 3 个事件通道");
  eqArr(sorted(ons), sorted(sends), "preload 订阅的事件与宿主发送的一一对应");
  for (const m of ["sensenovaStatus", "sensenovaHealth", "sensenovaOpen", "sensenovaClose", "sensenovaInstall", "sensenovaAgentInstall", "sensenovaAgentRecoverInstall", "sensenovaSelfRepair", "sensenovaCancelInstall", "sensenovaStart", "sensenovaStop", "sensenovaEnsureReady", "sensenovaForceKill", "sensenovaGenerate", "sensenovaCancelGenerate", "sensenovaGetLock", "sensenovaPickInstallDir", "sensenovaSetInstallDir", "sensenovaSetConfig", "sensenovaGpuProbe", "sensenovaConsoleTail", "sensenovaRemovePluginMeta"])
    has(preloadSrc, m + ":", "preload 暴露 " + m);
  for (const e of ["onSensenovaProgress", "onSensenovaConsoleChanged", "onSensenovaGpu"])
    has(preloadSrc, e + ":", "preload 暴露 " + e + "（返回退订函数）");
  /* 控制台窗自己的白名单桥：与宿主 handle 同一份通道名 */
  const winInvokes = uniq([...hostPreloadSrc.matchAll(/ipcRenderer\.invoke\("(sensenova:[^"]+)"/g)].map((m) => m[1]));
  eqArr(sorted(winInvokes), sorted(expectedHandles), "控制台窗 preload 的通道与宿主 handle 一一成对");
  for (const e of ["onProgress", "onConsoleChanged", "onGpu"])
    has(hostPreloadSrc, e + ":", "控制台窗 preload 暴露 " + e);
  has(mainSrc, 'require("./sensenova/main-sensenova.js")', "main.js require sensenova/main-sensenova.js");
  has(mainSrc, "registerSensenovaIpc({", "main.js 调 registerSensenovaIpc");
  has(mainSrc, "onSensenovaDshEvent(ev)", "main.js 在 dsh 事件转发里调 onSensenovaDshEvent");
  has(mainSrc, "shutdownSensenovaUiOnly()", "退出路径只 shutdownSensenovaUiOnly（后端单例不随 MTNode 退出）");
  const reqBlock = mainSrc.slice(mainSrc.indexOf("registerSensenovaIpc({"), mainSrc.indexOf("registerSensenovaIpc({") + 300);
  for (const k of ["getDataDir", "getMainWin", "appRoot", "getDsh"])
    has(reqBlock, k, "registerSensenovaIpc 传参含 " + k);
  const expBlock = hostSrc.slice(hostSrc.indexOf("module.exports = {"));
  for (const e of ["registerSensenovaIpc", "shutdownSensenovaUiOnly", "onSensenovaDshEvent"])
    has(expBlock, e, "sensenova/main-sensenova.js 导出 " + e);

  /* ===================== [7] 打包 / 插件目录 / 插件卡 / 自动修复 ===================== */
  console.log("\n[7] 打包白名单 · catalog 卡片 · 插件卡与自动修复分支");
  ok(/\n\s*"sensenova\/\*\*",/.test(buildSrc), "build.json files 白名单含 sensenova/**（否则打包后 Cannot find module）");
  const extraAt = buildSrc.indexOf('"from": "sensenova-pack"');
  ok(extraAt > 0, "build.json extraResources 含 sensenova-pack 脚手架");
  const extraBlock = buildSrc.slice(extraAt, buildSrc.indexOf("}", extraAt));
  has(extraBlock, '"to": "sensenova-pack"', "sensenova-pack 打到 resources/sensenova-pack");
  for (const f of ["app/**", "scripts/**", "requirements.txt", "manifest.json"])
    has(extraBlock, '"' + f + '"', "sensenova-pack filter 覆盖 " + f);

  const card = (catalog.plugins || catalog.items || []).find((p) => p && p.id === "sensenova-local");
  ok(!!card, "catalog.default.json 里有 sensenova-local 卡片");
  eqStr(card.kind, "sensenova", "卡片 kind = sensenova");
  eqStr(card.handler, "sensenova", "卡片 handler = sensenova");
  eqStr(card.icon, "sensenova-local.png", "卡片图标 = sensenova-local.png");
  eqNum(card.order, 36, "卡片 order 36");
  eqStr(card.minAppVersion, "1.1.28", "minAppVersion 1.1.28");
  ok(!!(card.title && card.title.zh && card.title.en), "卡片标题中英齐备");
  has(card.subtitle.zh, "显存", "卡片中文文案写明显存要求");
  has(card.subtitle.zh, "60GB", "卡片中文文案写明磁盘建议");
  has(pluginsMainSrc, '"sensenova"', "plugins/main-app-plugins.js 的 KNOWN_KINDS 认 sensenova");
  has(pluginsMainSrc, 'raw.handler === "sensenova"', "handler → kind 推断认 sensenova");
  has(appPluginsSrc, "async function refreshSensenovaPluginCard", "插件卡刷新函数 refreshSensenovaPluginCard 存在");
  has(appPluginsSrc, 'item.kind === "sensenova" || item.handler === "sensenova"', "插件卡分发链有 sensenova 分支");
  has(appPluginsSrc, "onSensenovaConsoleChanged", "卡片订阅控制台开关变化就地刷新");
  has(appPluginsSrc, "bindSensenovaProgress", "卡片绑定安装/更新进度");
  has(appRepairSrc, 'sensenova: "sensenova-local-install"', "自动修复：sensenova → 技能 sensenova-local-install");
  has(appRepairSrc, 'sensenova: "sensenovaOpen"', "自动修复：sensenova → 控制台入口 sensenovaOpen");
  has(appRepairSrc, 'label: "SenseNova 图像"', "常驻服务表登记 SenseNova 图像");
  has(appRepairSrc, '"sensenova_gen"', "自动修复别名表含节点 kind sensenova_gen");
  has(hostSrc, 'INSTALL_SKILL = "sensenova-local-install"', "宿主安装用的技能名 = 仓内真实技能目录名");
  ok(exists("skills/sensenova-local-install/SKILL.md"), "skills/sensenova-local-install/SKILL.md 存在");
  has(read("dsh/main-dsh.js"), "'sensenova-local-install'", "网关 INSTALL_SKILL_SOURCES 注册该技能真源");
  has(hostSrc, "function syncSensenovaInstallSkill(", "宿主侧补一份兜底同步（老网关升级后也能装）");
  has(fnBody(hostSrc, "syncSensenovaInstallSkill"), "syncInstallSkills", "兜底同步先叫网关统一同步（一份逻辑）");
  ok(exists("plugins/icons/sensenova-local.png"), "插件封面图标存在：plugins/icons/sensenova-local.png");
  const png = fs.readFileSync(path.join(ROOT, "plugins", "icons", "sensenova-local.png"));
  ok(
    png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
    "插件图标是合法 PNG（魔数校验）",
  );

  /* ===================== [8] i18n / 指南 ===================== */
  console.log("\n[8] i18n 词条 · 节点指南（中英 + 索引 + 图）");
  const NEW_KEYS = [
    "SenseNova",
    "SenseNova 图像节点",
    "SenseNova（本地图像生成 · SenseNova-U1.5-8B-MoT）",
    "SenseNova 图像插件未就绪",
    "SenseNova 未安装：请在「插件 · SenseNova 本地图像生成」里安装后再试",
    "参考图已生效：本次按图像编辑生成（{n} 张参考图参与条件）",
    "参考图条件强度",
    "提示词（要画成什么 · 可接文本节点，也可接参考图）",
    "（数据槽：可接文本 / 图像）",
    "分辨率桶（官方训练尺寸）",
    "采样步数",
    "显存档位",
    "权重精度",
    "think（先推理再出图 · 另存 .think.txt）",
    "SenseNova 自动安装超时（权重约 32.66GB，下载要看网速）：请稍后重试 ▶",
    "本机没有可用的 NVIDIA 显卡：SenseNova 本地出图需要一张 N 卡",
    "打开 SenseNova 控制台日志",
    "图像生成",
  ];
  eqArr(
    NEW_KEYS.filter((k) => i18nSrc.indexOf('"' + k + '"') < 0),
    [],
    "全部新文案在 i18n 里都有词条（" + NEW_KEYS.length + " 条）",
  );
  /* 泛化收口：源码里所有字面提到 SenseNova 的界面取词都必须登记英文词条 */
  const snCopy = uniq(
    [...(appSrc + "\n" + nodesSrc + "\n" + canvasSrc).matchAll(/I18n\.t\(\s*"([^"]*SenseNova[^"]*)"/g)].map((m) => m[1]),
  );
  ok(snCopy.length >= 10, "扫到 SenseNova 界面取词 " + snCopy.length + " 条");
  eqArr(
    snCopy.filter((k) => i18nSrc.indexOf('"' + k + '"') < 0),
    [],
    "所有 SenseNova 界面取词在 i18n 里都有英文词条（缺一即红）",
  );
  const i18nObj = require(path.join(ROOT, "renderer", "i18n.js"));
  const prevLocale = i18nObj.getLocale ? i18nObj.getLocale() : "zh";
  i18nObj.setLocale("en");
  eqStr(i18nObj.t("SenseNova 图像节点"), "SenseNova Image Node", "英文词条：节点名");
  eqStr(i18nObj.t("分辨率桶（官方训练尺寸）"), "Resolution bucket (official training size)", "英文词条：分辨率桶");
  eqStr(i18nObj.t("显存档位"), "VRAM tier", "英文词条：显存档位");
  eqStr(i18nObj.t("（数据槽：可接文本 / 图像）"), " (data slot: accepts text / image)", "英文词条：增量数据槽");
  i18nObj.setLocale(prevLocale || "zh");

  for (const p of ["guides/nodes/sensenova_gen.md", "guides/nodes/en/sensenova_gen.md", "guides/nodes/img/sensenova_gen.svg"])
    ok(exists(p), "节点指南文件存在：" + p);
  ok(nodeIdx.ids.indexOf("sensenova_gen") >= 0, "sensenova_gen 已进节点指南索引");
  eqStr(nodeIdx.ids[nodeIdx.ids.indexOf("sensenova_gen") - 1], "proc_image", "索引里 sensenova_gen 紧跟 proc_image（图像生成相邻）");
  const guideZh = read("guides/nodes/sensenova_gen.md");
  has(guideZh, "SenseNova", "中文指南写明节点名");
  /* 端子泛化后旧口径（端口 1 = 控制输入）由文档线跟进；这里改钉本轮确定的新口径 */
  has(guideZh, "端子语义与输出形态", "中文指南写明端子语义与 proc_image 完全一致");
  has(guideZh, "无需填任何路径", "中文指南写明不需要填输出路径（产物自动落资产目录）");
  has(guideZh, "sensenova-local-install", "中文指南写明自动修复技能名");
  const guideEn = read("guides/nodes/en/sensenova_gen.md");
  has(guideEn, "no path to fill in", "英文指南与中文成对（无输出路径口径）");
  const svg = read("guides/nodes/img/sensenova_gen.svg");
  ok(svg.indexOf("<svg") >= 0 && svg.indexOf("</svg>") > 0, "节点指南配图是合法单根 SVG");
  hasnt(svg, "placeholder", "配图无 placeholder 残留");
  has(read("docs/sensenova-local-backend.md"), "8774", "后端契约文档固化端口 8774");

  /* ===================== [9] sensenova-pack 后端契约与安装脚本 ===================== */
  console.log("\n[9] sensenova-pack：manifest / server / engine / 国内镜像安装脚本");
  for (const p of ["sensenova-pack/manifest.json", "sensenova-pack/requirements.txt", "sensenova-pack/start_backend.cmd", "sensenova-pack/README.md", "sensenova-pack/app/__init__.py", "sensenova-pack/app/__main__.py", "sensenova-pack/app/server.py", "sensenova-pack/app/engine.py", "sensenova-pack/scripts/install.ps1"])
    ok(exists(p), "后端脚手架文件存在：" + p);
  eqStr(packManifest.id, "sensenova-local", "manifest id = sensenova-local");
  eqStr(packManifest.entry, "app", "后端入口 = python -m app");
  eqNum(packManifest.apiPort, 8774, "后端 API 端口 8774");
  eqNum(packManifest.diskHintGb, 60, "磁盘建议预留 60GB");
  eqArr(packManifest.vramModes, ["full", "fast", "balanced", "low"], "manifest 显存档位与节点下拉一致");
  has(packManifest.modelModelScope, "SenseNova/SenseNova-U1.5-8B-MoT", "权重仓 = ModelScope SenseNova/SenseNova-U1.5-8B-MoT");

  /* server：标准库 HTTP 契约路由齐 + 错误码 → HTTP 映射 */
  for (const r of ['"/health"', '"/generate"', '"/progress"', '"/cancel"', '"/shutdown"'])
    has(serverPy, r, "server 路由存在：" + r);
  has(serverPy, "class SenseNovaHandler(BaseHTTPRequestHandler)", "server 用标准库 BaseHTTPRequestHandler（零依赖）");
  has(serverPy, "ThreadingHTTPServer", "server 用标准库 ThreadingHTTPServer 起服务");
  for (const [code, http] of [["bad_request", 400], ["cancelled", 409], ["busy", 429], ["model_load_failed", 500], ["generate_failed", 500], ["save_failed", 500]])
    ok(
      new RegExp('"' + code + '":\\s*' + http).test(serverPy),
      "错误码 " + code + " → HTTP " + http,
    );
  has(serverPy, "MTNODE_SENSENOVA_MOCK", "server 认 MTNODE_SENSENOVA_MOCK=1 造占位 PNG 供契约冒烟");

  /* engine：上游推理口径 + 反归一化 + no_grad（不得回退 inference_mode） */
  has(enginePy, "load_model_and_tokenizer", "engine 用上游 load_model_and_tokenizer 加载");
  has(enginePy, "make_offload_ctx", "engine 用上游 make_offload_ctx 做分层卸载");
  has(enginePy, "t2i_generate", "engine 调 model.t2i_generate(...)");
  has(enginePy, "(x.float() * 0.5 + 0.5).clamp(0, 1)", "engine 反归一化 (x*0.5+0.5).clamp(0,1) 存 PNG");
  has(enginePy, "with torch.no_grad():", "engine 前向包在 torch.no_grad() 里");
  {
    const codeLines = enginePy.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    eqNum(
      codeLines.filter((l) => /torch\.inference_mode\s*\(/.test(l)).length,
      0,
      "engine 代码行不得再调 torch.inference_mode()（第二张必崩的坑，注释里提到可以）",
    );
  }
  has(enginePy, "SUPPORTED_RESOLUTIONS", "engine 有 SUPPORTED_RESOLUTIONS 桶表真源");
  /* 参考图（本轮 bug 修复）：路径 → PIL → it2i_generate；不可读只警告不静默 */
  has(enginePy, "it2i_generate", "engine 有图像编辑通道：model.it2i_generate(...)");
  has(enginePy, "def load_reference_images(", "engine 有参考图加载口 load_reference_images");
  has(enginePy, "img_cfg_scale", "engine 转发 img_cfg_scale（参考图条件强度）");
  has(enginePy, '"mode": "edit" if ref_images else "t2i"', "engine 回执标明本次是 t2i 还是 edit");
  has(serverPy, "refImages", "server 入参表写明参考图字段 refImages");
  has(serverPy, '"mode":"t2i"|"edit"', "server 契约文档写明 mode / refImagesUsed 回执字段");
  has(hostSrc, "refImagePathsForBody", "宿主核参考图路径（存在 + 图片后缀）后才下发");
  has(hostSrc, "body.refImages = ref.paths", "宿主把参考图路径放进 /generate 请求体（唯一投递口）");
  hasnt(hostSrc, "reference_image_unsupported", "旧的「后端不支持参考图」降级码已移除");
  hasnt(hostSrc, "referenceIgnored", "回执不再有 referenceIgnored 降级字段");

  /* 本轮三个 bug 的回归：① 完成后释放 ② 图参考模式慢的现场结论 ③ String(...).join is not a function */
  has(enginePy, "def release_run_memory(", "engine 有本次运行显存释放口 release_run_memory");
  has(enginePy, "self.release_run_memory(", "generate() 结束时一定回收本次运行显存（完成后释放）");
  has(enginePy, "def ref_input_max_pixels(", "engine 有参考图输入像素预算 ref_input_max_pixels（对齐上游 --input_max_pixels auto）");
  has(enginePy, "参考图前缀要跑两遍", "编辑模式为什么慢写进 warnings（图参考模式非常慢给出结论与提速档位）");
  hasnt(hostSrc, "String(deps.missing || []).join(", "宿主缺依赖文案不再对 String(...) 调 .join（曾抛 String(...).join is not a function）");
  has(hostSrc, "Array.isArray(deps.missing)", "宿主缺依赖清单按数组归一后再拼文案（缺依赖不再吞成 JS TypeError）");
  has(hostSrc, '"host_internal_error"', "宿主自己的 JS 异常单独归成 host_internal_error，不冒充后端错误");

  /* install.ps1：国内镜像清单（无「裸 GitHub 唯一路径」）+ 关键边界 */
  for (const h of [
    "mirror.sjtu.edu.cn/pytorch-wheels",
    "mirrors.aliyun.com/pytorch-wheels",
    "download.pytorch.org/whl",
    "pypi.tuna.tsinghua.edu.cn",
    "mirrors.aliyun.com/pypi/simple",
    "registry.npmmirror.com/-/binary/python-build-standalone",
    "hf-mirror.com",
  ])
    has(installPs1, h, "install.ps1 含国内镜像：" + h);
  has(installPs1, "from modelscope import snapshot_download", "权重优先走 ModelScope（国内直连）");
  has(installPs1, "SenseNova/SenseNova-U1.5-8B-MoT", "权重仓名 = SenseNova/SenseNova-U1.5-8B-MoT");
  has(installPs1, 'HF_ENDPOINT = "https://hf-mirror.com"', "权重失败回退 hf-mirror");

  /* tarball 三代理在前、裸 GitHub 只作最后兜底（「镜像清单不含裸 github 唯一路径」） */
  const urlsAt = installPs1.indexOf("$urls = @(");
  ok(urlsAt > 0, "install.ps1 有推理包下载候选数组 $urls");
  const urlsBlock = installPs1.slice(urlsAt, installPs1.indexOf(")", urlsAt) + 1);
  const urlLines = urlsBlock
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^"https?:/.test(l))
    .map((l) => l.replace(/^"/, "").replace(/",?$/, ""));
  eqNum(urlLines.length, 4, "下载候选恰好 4 条（三代理 + 一裸直连）");
  const PROXIES = ["ghfast.top", "gh-proxy.com", "ghproxy.net"];
  for (const proxy of PROXIES)
    ok(urlLines.some((u) => u.indexOf(proxy) === 8 || u.indexOf(proxy) > 0), "下载候选含国内 GitHub 代理：" + proxy);
  ok(
    urlLines.slice(0, 3).every((u) => PROXIES.some((p) => u.indexOf(p) > 0)),
    "前三条都是代理路径（不是裸 GitHub）",
  );
  ok(
    urlLines[3] === "https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz",
    "裸 GitHub 直连只作最后兜底（唯一路径不存在，代理全挂才走它）",
  );
  has(installPs1, "--no-deps", "推理包装进 venv 强制 --no-deps（防 pip 重解 torch）");
  has(installPs1, "[switch]$SkipModels", "支持 -SkipModels（离线 / 续装）");
  has(installPs1, "[string]$TorchIndex", "支持 -TorchIndex 覆盖 torch 源");
  has(installPs1, "[string]$TorchWheel", "支持 -TorchWheel 完全离线装 torch");
  has(installPs1, "Test-PkgSourceReady", "源码就绪判据独立成 Test-PkgSourceReady（残缺目录可自愈）");
  has(installPs1, "LICENSE", "选择性解包成员含 LICENSE（hatchling 元数据校验必需）");
  has(installPs1, "PIP_INDEX_URL", "pip 走 PIP_* 环境变量覆盖本机全局配置");
  hasnt(installPs1, '"-m", "pip", "install", "--isolated"', "不使用 pip --isolated（会连 PIP_* 一起忽略，把不可达 ngc 索引放回来）");
  has(installPs1, "[sensenova-install] progress:", "全程打 [sensenova-install] progress: NN 进度标记");
  has(installPs1, ".sensenova-agent-result", "写 .sensenova-agent-result 结果标记（Agent 安装链读它）");
  has(installPs1, "attn-backend", "探测注意力档位并落 .attn-backend（Windows 无 flash-attn → sdpa）");

  /* 安装技能同步了实测修正口径 */
  has(skillMd, "连跑两次", "技能写明真实验收必须连跑两次（第一张成功、之后 500 的坑）");
  has(skillMd, "no_grad", "技能写明 engine 用 torch.no_grad()");
  has(skillMd, "pip --isolated", "技能写明 pip --isolated 不管用");
  has(skillMd, "SJTU", "技能写明 torch 走 SJTU 镜像");
  has(skillMd, "hf-mirror", "技能写明权重回退 hf-mirror");

  console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
  if (fails) {
    console.log(fails + " 项失败");
    process.exit(1);
  }
  console.log("全部通过");
})();

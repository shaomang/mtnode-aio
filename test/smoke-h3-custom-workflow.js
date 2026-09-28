"use strict";
/* H3「自建 ComfyUI 工作流」→ 接入 MTNode 画布 video_gen 节点
 *   node test/smoke-h3-custom-workflow.js
 *
 * 覆盖两半：
 *   A. 主进程库 + 执行（h3/h3-workflows.js 真身，纯 Node 直跑）
 *      [1] UI 格式 → API 图（Reroute 透传 / 常量内联 / 前端节点丢弃）
 *      [2] 扫描参数候选 + 建议映射 + 输出节点 + 种子字段
 *      [3] 参数表校验与「与最新图同步」（保留改名 / 标失效 / 补新建议）
 *      [4] 值注入（文本 / 数字 / 素材文件名 / 种子统一下发 / 连线字段拒绝）+ 待上传清单
 *      [5] 输出节点挑选（自动 / 指定 / 指定已消失）
 *      [6] 全局库读写（临时目录：导入 → 列表 / 扫描 / 改名 / 导出 / 删除 + registry 自愈）
 *   B. 画布接入（与 test/smoke-wire-drop-menu.js 同一套路：从渲染层源码按名字抠**真实函数**进 vm 跑）
 *      [7] 端子模型：自建模式的端口布局（端口 1 = 文本 · 端口 2+ = 素材）与内置模式零回归
 *      [8] 取值与下发：端口优先于直填、wfPortMap、file:/// 归一、自建只下发精简对象
 *      [9] 接线契约（源码级）：IPC 通道、preload 桥、面板挂载、内置参数块隐藏、
 *          canvas_get 透出、Agent patch、i18n 双语、指南、CSS
 *      [10] 宿主路由判定（main-h3.js 真身）：内置任务带画布 id 绝不再被判成自建
 *          （回归现场：工作流不存在 id=wf_mtjt9bmr）
 *      [11] API → UI 反向转换（「打开该模板进 ComfyUI」）：内置 FL2VA / R2V 真图回环 +
 *          导出落盘到临时目录（绝不写 ComfyUI 现场、绝不写回库）
 *
 * 替身只替与判定无关的部分：连线取值（wiresTo / nodeById / valueFromWire / displayValueOf）、
 * DOM 与 IPC；端子模型、取值合并、下发装配、库与注入全部是源码里的真函数。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const h3wf = require("../h3/h3-workflows.js");

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
function section(t) {
  console.log("\n── " + t + " ──");
}
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + show(needle) + "）"));
};

/* ---------- 从源码里按名字抠出顶层函数 / 常量 ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数 / 常量：" + name);
  if (/^(async\s+)?function/.test(src.slice(at, at + 14))) {
    const i = src.indexOf("{", at);
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
  const lineEnd = src.indexOf("\n", at);
  return src.slice(at, lineEnd) + ";";
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");
const canvasSrc = read("renderer/app-canvas.js");
const mainH3Src = read("h3/main-h3.js");
const preloadSrc = read("preload.js");
const h3PreloadSrc = read("h3/preload-h3.js");
const cssSrc = read("renderer/css/canvas.css");
const pluginSrc = read("dsh/gateway/canvas-plugin.mjs");

/* ═══════════════ A · 主进程库与执行 ═══════════════ */

/* 一份「典型 ComfyUI UI 导出」：LoadImage → 提示词 → MiniMaxH3 → SaveVideo，
   外加 Reroute 透传、常量原语内联、Note 前端节点三种转换情形 */
const UI_DOC = {
  nodes: [
    { id: 1, type: "CheckpointLoaderSimple", mode: 0, title: "载入模型", inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [10] }, { name: "CLIP", type: "CLIP", links: [11] }], widgets_values: ["h3.safetensors"] },
    { id: 2, type: "CLIPTextEncode", mode: 0, title: "画面提示词", inputs: [{ name: "clip", type: "CLIP", link: 11 }], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [12] }], widgets_values: ["a cat"] },
    { id: 3, type: "LoadImage", mode: 0, title: "首帧", inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [13] }], widgets_values: ["first.png", "upload"] },
    { id: 4, type: "Reroute", mode: 0, inputs: [{ name: "*", type: "*", link: 13 }], outputs: [{ name: "*", type: "*", links: [14] }] },
    { id: 5, type: "PrimitiveFloat", mode: 0, inputs: [], outputs: [{ name: "FLOAT", type: "FLOAT", links: [15] }], widgets_values: [3.5] },
    { id: 6, type: "Note", mode: 4, inputs: [], outputs: [], widgets_values: ["给自己看的说明"] },
    {
      id: 7,
      type: "MiniMaxH3Generate",
      mode: 0,
      title: "H3 生成",
      inputs: [
        { name: "model", type: "MODEL", link: 10 },
        { name: "positive", type: "CONDITIONING", link: 12 },
        { name: "image", type: "IMAGE", link: 14 },
        { name: "shift_audio", type: "FLOAT", link: 15 },
        { name: "prompt", type: "STRING", widget: { name: "prompt" } },
        { name: "length", type: "INT", widget: { name: "length" } },
        { name: "steps", type: "INT", widget: { name: "steps" } },
        { name: "sampler_name", type: "COMBO", widget: { name: "sampler_name" } },
        { name: "scheduler", type: "COMBO", widget: { name: "scheduler" } },
      ],
      outputs: [{ name: "VIDEO", type: "VIDEO", links: [16] }],
      widgets_values: ["prompt text", 96, 12, "res_multistep", "simple"],
    },
    { id: 8, type: "SaveVideo", mode: 0, title: "保存视频", inputs: [{ name: "video", type: "VIDEO", link: 16 }], outputs: [], widgets_values: ["video/MTNode_H3"] },
  ],
  links: [
    [10, 1, 0, 7, 0, "MODEL"],
    [11, 1, 1, 2, 0, "CLIP"],
    [12, 2, 0, 7, 1, "CONDITIONING"],
    [13, 3, 0, 4, 0, "IMAGE"],
    [14, 4, 0, 7, 2, "IMAGE"],
    [15, 5, 0, 7, 3, "FLOAT"],
    [16, 7, 0, 8, 0, "VIDEO"],
  ],
};

section("[1] UI 格式 → API 图");
{
  eqNum(h3wf.detectFormat(UI_DOC).format, "ui", "detectFormat 认到 UI 格式");
  const apiOnly = { "1": { class_type: "SaveVideo", inputs: { filename_prefix: "a" } } };
  eqNum(h3wf.detectFormat(apiOnly).format, "api", "detectFormat 认到 API 格式");
  ok(h3wf.detectFormat({ foo: 1 }).error || h3wf.detectFormat({ foo: 1 }).format === "unknown", "看不懂的 JSON 不硬判");

  const norm = h3wf.normalizeGraph(UI_DOC);
  const g = norm.graph;
  eqNum(norm.format, "ui", "normalizeGraph 报告转换来源");
  ok(!g["6"], "Note（前端节点）被丢弃");
  ok(!g["4"], "Reroute 不进 API 图");
  ok(!g["5"], "常量原语节点不进 API 图");
  eqArr(g["7"].inputs.image, ["3", 0], "Reroute 回溯：图像输入直连到源节点 3");
  eqNum(g["7"].inputs.shift_audio, 3.5, "常量原语的值内联进下游字段");
  eqNum(g["3"].inputs.image, "first.png", "LoadImage 的 upload 控件被跳过，image 落对字段");
  eqNum(g["2"].inputs.text, "a cat", "CLIPTextEncode 字段名对齐");
  eqNum(g["7"].inputs.prompt, "prompt text", "H3 节点 widget 按 LEGACY 表落名");
  ok(Array.isArray(norm.warnings) && norm.warnings.length > 0, "旁路 / 静音节点给出警告：" + show(norm.warnings[0] || "").slice(0, 40));
  const shape = h3wf.validateApiGraphShape(g);
  ok(shape.ok, "转换结果通过 API 形状校验：" + show(shape.errors || []).slice(0, 80));
  ok(!h3wf.validateApiGraphShape({ 1: { inputs: {} } }).ok, "缺 class_type 的图被判无效");
  ok(!h3wf.validateApiGraphShape({ 1: { class_type: "X", inputs: { a: ["9", 0] } } }).ok, "连到不存在的节点被判无效");
}

section("[2] 扫描：候选 / 建议映射 / 输出 / 种子");
{
  const graph = h3wf.normalizeGraph(UI_DOC).graph;
  const scan = h3wf.scanGraph(graph);
  const bySrc = (id, f) => scan.candidates.find((c) => String(c.nodeId) === id && c.field === f);
  ok(bySrc("7", "prompt") && bySrc("7", "prompt").type === "text", "H3 prompt → 文本候选");
  ok(bySrc("3", "image") && bySrc("3", "image").type === "image", "LoadImage.image → 图像素材候选");
  ok(bySrc("7", "length") && bySrc("7", "length").suggested === false, "length 是候选但不默认提升");
  ok(scan.outputs.some((o) => String(o.nodeId) === "8" && o.isVideo), "SaveVideo 认成视频输出节点");
  eqArr(scan.seedFields.map((s) => s.nodeId + "." + s.field), [], "本图没有 seed 字段（数值 96 是 length 不是种子）");
  const sug = scan.suggested.map((p) => p.type + ":" + p.source.nodeId + "." + p.source.field);
  ok(sug.some((x) => x === "image:3.image"), "建议映射含素材槽");
  ok(sug.some((x) => x === "text:7.prompt"), "建议映射含提示词");
  ok(sug.some((x) => x === "text:2.text"), "建议映射含 CLIP 文本编码");
  const withSeed = h3wf.scanGraph({
    1: { class_type: "KSampler", inputs: { seed: 7, steps: 20, cfg: 5, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    2: { class_type: "ModelSamplingFlux", inputs: { noise_seed: 3 } },
    3: { class_type: "CLIPTextEncode", inputs: { text: "hi", clip: ["1", 0] } },
  });
  eqArr(
    withSeed.seedFields.map((s) => s.nodeId + "." + s.field).sort(),
    ["1.seed", "2.noise_seed"],
    "多种种子字段名都被收进 seedFields",
  );
  ok(!withSeed.candidates.some((c) => c.field === "clip"), "连线值（数组 [id,slot]）不会被当成参数候选");
}

section("[3] 参数表：校验 + 与最新图同步");
{
  const graph = h3wf.normalizeGraph(UI_DOC).graph;
  const bad = h3wf.normalizeParams(
    [
      { key: "bad key!", type: "text", source: { nodeId: "7", field: "prompt" } },
      { key: "ok", type: "color", source: { nodeId: "7", field: "prompt" } },
      { key: "nolocate", type: "text", source: {} },
      { key: "missingnode", type: "text", source: { nodeId: "99", field: "prompt" } },
      { key: "missingfield", type: "text", source: { nodeId: "7", field: "nope" } },
      { key: "ok", type: "text", source: { nodeId: "2", field: "text" } },
    ],
    graph,
  );
  ok(!bad.ok && bad.errors.length >= 5, "非法 key / 类型 / 落点 / 重复 key 全部报错（" + bad.errors.length + " 条）");
  const good = h3wf.normalizeParams(
    [{ key: "p1", label: "我的提示词", type: "text", source: { nodeId: "7", field: "prompt" }, defaultValue: "x" }],
    graph,
  );
  ok(good.ok, "合法参数表通过校验");
  eqNum(good.params[0].defaultValue, "prompt text", "defaultValue 以图内现值为准（图是默认值的真源）");

  const stored = [
    { key: "my_prompt", label: "我自己改的名", type: "text", source: { nodeId: "7", field: "prompt" }, defaultValue: "旧值" },
    { key: "gone", label: "已消失", type: "text", source: { nodeId: "42", field: "text" }, defaultValue: "" },
  ];
  const merged = h3wf.syncParamsWithScan(stored, graph, null);
  const kept = merged.params.find((p) => p.key === "my_prompt");
  eqNum(kept.label, "我自己改的名", "同步后保留用户改过的名称");
  eqNum(kept.defaultValue, "prompt text", "同步后默认值刷成图内现值");
  ok(merged.params.find((p) => p.key === "gone").stale === true, "图上消失的落点标 stale（不静默删）");
  ok(merged.added >= 1, "新扫出的建议参数被补进来（added=" + merged.added + "）");
  eqNum(merged.stale, 1, "失效计数 = 1");
  const again = h3wf.syncParamsWithScan(merged.params, graph, null);
  eqNum(again.added, 0, "再同步一次不重复追加");
  eqNum(again.params.length, merged.params.length, "再同步一次条数不变");
}

section("[4] 注入：applyMapping / collectUploads");
{
  const graph = h3wf.normalizeGraph(UI_DOC).graph;
  const scan = h3wf.scanGraph(graph);
  const params = h3wf.normalizeParams(scan.suggested, graph).params;
  const uploaded = { "image_3_image": "mtnode_a1b2c3_first.png" };
  const vals = { "text_7_prompt": "一只戴帽子的猫", "number_7_steps": 9 };
  const r = h3wf.applyMapping(graph, vals, params, 777, { uploaded, seedFields: scan.seedFields });
  eqNum(r.errors.length, 0, "注入无错误：" + show(r.errors).slice(0, 120));
  const g2 = r.graph;
  ok(g2 !== graph, "注入返回新图（不改库内原图）");
  eqNum(g2["7"].inputs.prompt, "一只戴帽子的猫", "文本参数写进目标字段");
  eqNum(g2["3"].inputs.image, "mtnode_a1b2c3_first.png", "素材参数用上传后的 ComfyUI 文件名");
  /* 图里没有连线的 seed 字段时，统一下发只作用在扫到的 seedFields 上 */
  const g3 = h3wf.applyMapping(
    {
      1: { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
      2: { class_type: "RandomNoise", inputs: { noise_seed: 2 } },
    },
    {},
    [],
    555,
    { seedFields: h3wf.collectSeedFields({ 1: { class_type: "KSampler", inputs: { seed: 1, steps: 20 } }, 2: { class_type: "RandomNoise", inputs: { noise_seed: 2 } } }) },
  ).graph;
  eqNum(g3["1"].inputs.seed, 555, "节点级单一种子下发到 KSampler.seed");
  eqNum(g3["2"].inputs.noise_seed, 555, "同一粒种子下发到 RandomNoise.noise_seed");
  const linked = h3wf.applyMapping(
    { 1: { class_type: "CLIPTextEncode", inputs: { text: ["2", 0] } }, 2: { class_type: "String Literal", inputs: { string: "x" } } },
    { t: "y" },
    [{ key: "t", type: "text", source: { nodeId: "1", field: "text" } }],
    null,
    {},
  );
  eqNum(linked.errors.length, 1, "目标是连线时拒绝写值（不误覆盖上游输出）");
  const noFile = h3wf.applyMapping(
    { 1: { class_type: "LoadImage", inputs: { image: "a.png" } } },
    { img: "E:\\素材\\b.png" },
    [{ key: "img", type: "image", source: { nodeId: "1", field: "image" } }],
    null,
    {},
  );
  eqNum(noFile.errors.length, 1, "本机绝对路径没上传时报错而不是塞进图里");
  const ups = h3wf.collectUploads({ img: "E:\\素材\\b.png", txt: "hello", vid: "clip.mp4" }, [
    { key: "img", type: "image" },
    { key: "txt", type: "text" },
    { key: "vid", type: "video" },
  ]);
  eqNum(ups.length, 1, "只有本机路径素材进上传清单");
  eqArr(ups.map((u) => u.key + ":" + u.type), ["img:image"], "上传清单带 key 与类型");
}

section("[5] 输出节点挑选");
{
  const graph = {
    1: { class_type: "SaveAudio", inputs: { filename_prefix: "a" } },
    2: { class_type: "SaveVideo", inputs: { filename_prefix: "b" } },
    3: { class_type: "VHS_VideoCombine", inputs: { filename_prefix: "c" } },
  };
  const scan = h3wf.scanGraph(graph);
  eqNum(h3wf.pickOutputNode(scan, "").nodeId, "3", "默认取最后一个视频产物");
  eqNum(h3wf.pickOutputNode(scan, "2").nodeId, "2", "指定输出节点生效");
  eqNum(h3wf.pickOutputNode(scan, "2").matched, "preferred", "matched=preferred");
  eqNum(h3wf.pickOutputNode(scan, "9").matched, "preferred_missing", "指定的节点已消失 → 回落并标注");
  eqNum(h3wf.pickOutputNode({ outputs: [] }, "").matched, "none", "没有任何输出时返回 none");
}

section("[6] 全局库读写（临时目录）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "h3wf-"));
  const store = new h3wf.H3WorkflowStore({ dataDir: tmp });
  const imp = store.importWorkflow({ text: JSON.stringify(UI_DOC), title: "首尾帧 · 改" });
  ok(imp.ok === true, "UI 格式导入成功");
  eqNum(imp.record.format, "ui", "记录里保留原始格式标记");
  eqNum(imp.record.graph["7"].class_type, "MiniMaxH3Generate", "库存的是转换后的 API 图");
  const imp2 = store.importWorkflow({ text: JSON.stringify({ "1": { class_type: "SaveVideo", inputs: {} } }) });
  ok(imp2.ok, "API 格式导入成功");
  ok(imp2.summary.title !== "首尾帧 · 改", "未命名工作流自动取名：" + imp2.summary.title);
  eqNum(store.list().length, 2, "列表两条");
  const detail = store.listDetailed();
  ok(detail.every((d) => !d.missing && d.nodeCount > 0), "listDetailed 带节点数");
  ok(detail.some((d) => d.outputs && d.outputs.length), "列表项带输出节点摘要");
  const sc = store.scan(imp.summary.id);
  ok(sc && sc.suggestedParams.length, "scan 给出可直接用的建议映射（" + sc.suggestedParams.length + " 条）");
  ok(store.rename(imp.summary.id, "改名后") .ok, "改名成功");
  eqNum(store.get(imp.summary.id).title, "改名后", "改名落盘");
  const dup = store.importWorkflow({ text: JSON.stringify(UI_DOC), title: "改名后" });
  ok(dup.ok && dup.replaced === true, "同名导入 = 覆盖并提示 replaced");
  const keep = store.importWorkflow({ text: JSON.stringify(UI_DOC), title: "改名后", overwrite: false });
  ok(keep.ok && keep.summary.title !== "改名后", "overwrite:false 自动改名另存：" + keep.summary.title);
  const ex = store.exportText(imp.summary.id);
  ok(ex.ok && JSON.parse(ex.text)["7"].class_type === "MiniMaxH3Generate", "导出 JSON 可回读");
  store.setValidation(imp.summary.id, { status: "ok", checkedAt: new Date().toISOString(), missing: [] });
  eqNum(store.get(imp.summary.id).validation.status, "ok", "校验结果写回条目");
  eqNum(store.remove(imp.summary.id).ok, true, "删除成功");
  ok(!store.get(imp.summary.id), "删完读不到");
  ok(store.remove("no-such-id").ok === true, "删除不存在的条目是幂等的（不报错）");
  ok(store.remove("../escape").ok === false, "非法 id 的删除被拒");
  /* registry 损坏 → 从目录树自愈重建 */
  fs.writeFileSync(store.dirs.index, "{ broken", "utf8");
  eqNum(store.list().length, 2, "registry 坏了也能从目录重建出 2 条");
  eqNum(store.stats().count, 2, "stats 总数正确");
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ═══════════════ B · 画布接入 ═══════════════ */

const sandbox = {
  console,
  Math,
  JSON,
  Set,
  Map,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  Date,
  isFinite,
  parseInt,
  Promise,
  I18n: { t: (s) => String(s) },
  toast: () => {},
  scheduleSave: () => {},
  renderCanvas: () => {},
  pushHistory: () => {},
  clipStr: (s, n) => String(s).slice(0, n),
  wireFromIsControl: (w) => !!(w && w.ctrl),
  /* 连线取值替身：用例里往 SLOT[...] 塞「这条线带进来的值」 */
  SLOT: {},
  window: { api: {} },
};
const S = { wf: { id: "wf-test", nodes: [], wires: [], workspace: "E:\\ws" } };
sandbox.S = S;
/* 连线取值替身：只替「读上游端子的值」这一步（它依赖整套连线 / 值归一 machinery），
   端子模型与合并逻辑全用源码里的真函数。 */
sandbox.nodeById = (id) => (S.wf.nodes || []).find((n) => n.id === id) || null;
sandbox.wiresTo = (id) => (S.wf.wires || []).filter((w) => w.to === id);
sandbox.valueFromWire = (w) => sandbox.SLOT[w.to + ":" + w.toIndex] || null;
sandbox.displayValueOf = (src) => (src && src.__display) || null;
/* 媒体端子值归一（file:/// URL → 本机路径）由 test/smoke-media-gen-menu.js [6] 逐例钉死；
   这里只给一个够用的替身，让 videoGenSlotValue 能跑通「衔接端子拿到的是本机路径」这一步。 */
sandbox.pathFromMediaValue = (v) => {
  const s = String((v && (v.path || v.text)) || v || "");
  return s.replace(/^file:\/\/\/?/, "").replace(/^([a-zA-Z]:)%2F/, "$1:/");
};
vm.createContext(sandbox);
vm.runInContext(
  extract(appSrc, [
    "videoGenMode",
    "videoGenProgressiveCount",
    "videoGenMaxImages",
    "videoGenMaxVideos",
    "videoGenMaxAudios",
    "videoGenMaxChains",
    /* 衔接槽位置真源（FL2VA 槽 4 · R2V 槽 17）：videoGenSlotMeta 会调它，不抽进来就 ReferenceError */
    "videoGenChainSlotIndex",
    "isCustomVideoGen",
    "videoGenWfFileParams",
    "videoGenWfTextParam",
    "customWfInputCount",
    "customWfSlotMeta",
    "videoGenControlPort",
    "videoGenIsDataPort",
    "videoGenDataSlotsTotal",
    "videoGenPortOfSlot",
    "videoGenSlotOfPort",
    "videoGenSlotOccupied",
    "videoGenPortMeta",
    "videoGenInputCount",
    "videoGenSlotMeta",
  ]) +
    "\n" +
    extract(nodesSrc, [
      "videoGenSlotValue",
      /* 分段衔接取值链（R2V 下槽号是 17 不是 4 —— 这里钉死「按 key 反查、绝不写死」） */
      "videoGenChainSlot",
      "videoGenChainValue",
      "videoGenChainRefIndex",
      "videoGenChainMentionOn",
      "videoGenChainMentionText",
      "H3_WF_TYPES",
      "H3_WF_FILE_TYPES",
      "h3WfParamList",
      "h3WfValues",
      "h3WfHasSource",
      "h3WfPortOf",
      "h3WfUniqueKey",
      "pruneVideoGenWfWires",
      "collectVideoGenWfValues",
      "buildVideoGenRunParams",
    ]),
  sandbox,
  { filename: "renderer-h3wf-extract" },
);
const mkNode = (extra) =>
  Object.assign(
    { id: "v1", kind: "video_gen", title: "视频", workflowId: "", wfParams: [], wfParamValues: {}, wfPortMap: {}, customOutputNodeId: "" },
    extra || {},
  );

section("[7] 端子模型：控制输入固定端口 0（第一个），数据端口从 1 起 ≡ 数据槽号");
{
  const P = (key, type, label) => ({ key, type, label, source: { nodeId: "7", field: key } });
  const b = mkNode({ videoMode: "fl2va" });
  eqNum(sandbox.videoGenInputCount(b), 4, "内置 FL2VA：控制输入 + 提示词 + 首帧 + 末帧 = 4 个端子");
  eqNum(sandbox.videoGenControlPort(b), 0, "内置 FL2VA 控制输入 = 端口 0（固定在最前）");
  /* 回归：端子排必须每个下标都有落得住的元数据，且端口 0 正是控制口
     （历史 bug：控制口写 N+1 越界 → 那颗控制端子不渲染、端口 0 显示成一个错槽） */
  eqArr(
    [0, 1, 2, 3].map((i) => (sandbox.videoGenPortMeta(b, i) || {}).kind),
    ["ctrl", "text", "image", "image"],
    "FL2VA 端子排：控制 0 · 提示词 1 · 首帧 2 · 末帧 3",
  );
  eqNum(sandbox.videoGenPortMeta(b, 4), null, "越界端口没有端子（不再猜一个槽出来）");
  ok(!sandbox.videoGenIsDataPort(b, 0), "端口 0 不是数据端子（数据线不得占控制口）");
  ok(sandbox.videoGenIsDataPort(b, 3), "端口 3 是最后一个数据端子");
  eqArr(
    [1, 2, 3].map((i) => sandbox.videoGenSlotMeta(b, i).kind),
    ["text", "image", "image"],
    "数据槽号（1 起始）语义不变：槽1=提示词 · 槽2/3=首末帧",
  );
  eqNum(sandbox.videoGenSlotOfPort(1), 1, "v5 同号换算：端口 1 ↔ 数据槽 1");
  eqNum(sandbox.videoGenPortOfSlot(1), 1, "v5 同号换算：数据槽 1 ↔ 端口 1");
  eqNum(sandbox.isCustomVideoGen(b), false, "workflowId 为空 = 内置模式");
  /* 分段衔接（默认关 = 零回归；勾选后 FL2VA 多一个「↩ 上一段视频」槽，控制口仍在端口 0） */
  eqNum(sandbox.videoGenMaxChains(b), 0, "未勾选衔接：内置 FL2VA 不加槽（端子布局零回归）");
  const bc = mkNode({ videoMode: "fl2va", chainEnabled: true });
  eqNum(sandbox.videoGenInputCount(bc), 5, "开衔接：控制 + 提示词 + 首末帧 + ↩ 上一段视频 = 5 个端子");
  eqNum(sandbox.videoGenControlPort(bc), 0, "开衔接：控制输入不动，仍在端口 0");
  eqArr(
    [0, 1, 2, 3, 4].map((i) => (sandbox.videoGenPortMeta(bc, i) || {}).kind),
    ["ctrl", "text", "image", "image", "video"],
    "开衔接端子排：端口 0 = 控制（第一个）· 端口 4 = ↩ 上一段视频（视频类）",
  );
  eqNum(sandbox.videoGenSlotMeta(bc, 4).key, "chain", "开衔接：数据槽 4 的 key = chain");
  eqNum(sandbox.videoGenSlotMeta(bc, 4).label, "↩", "开衔接：数据槽 4 端子标签 = ↩");
  eqArr(
    [1, 2, 3, 4].map((i) => sandbox.videoGenSlotMeta(bc, i).kind),
    ["text", "image", "image", "video"],
    "开衔接数据槽号：1 提示词 · 2 首帧 · 3 末帧 · 4 ↩ 上一段视频",
  );
  /* R2V（多参考）同样支持分段衔接：衔接槽**排在参考音频组之后**（槽 17），
     绝不能用 FL2VA 那套「末帧之后」—— 那个位置在 R2V 下正好是 A1，会吃掉参考音频端子。 */
  eqNum(sandbox.videoGenMaxChains(mkNode({ videoMode: "r2v" })), 0, "R2V 未勾选衔接：不加槽（仍 16 个数据槽 · 零回归）");
  const br = mkNode({ videoMode: "r2v", chainEnabled: true });
  eqNum(sandbox.videoGenMaxChains(br), 1, "R2V 勾选衔接：同样多一个数据槽（多参考也能续写上一段）");
  eqNum(sandbox.videoGenDataSlotsTotal(br), 17, "R2V 开衔接：16 原有数据槽 + ↩ = 17");
  eqNum(sandbox.videoGenInputCount(br), 18, "R2V 开衔接：控制（端口 0）+ 17 数据端子 = 18 个端子");
  eqNum(sandbox.videoGenControlPort(br), 0, "R2V 开衔接：控制输入仍固定在端口 0（不参与顺延）");
  eqNum(sandbox.videoGenChainSlotIndex(br), 17, "R2V 的衔接槽号 = 17（不是照搬 FL2VA 的 4）");
  eqNum(sandbox.videoGenSlotMeta(br, 17).key, "chain", "R2V 数据槽 17 的 key = chain");
  eqNum(sandbox.videoGenSlotMeta(br, 17).label, "↩", "R2V 数据槽 17 端子标签 = ↩");
  eqNum((sandbox.videoGenSlotMeta(br, 17) || {}).kind, "video", "R2V 数据槽 17 是视频类端子（接上一段成片）");
  eqArr(
    [11, 12, 13, 14, 15, 16].map((i) => sandbox.videoGenSlotMeta(br, i).label),
    ["V1", "V2", "V3", "A1", "A2", "A3"],
    "防回归重点：开衔接后 R2V 的参考视频 V1–V3 与参考音频 A1–A3 槽号一个都没被顶掉",
  );
  eqArr(
    [14, 15, 16].map((i) => sandbox.videoGenSlotMeta(br, i).kind),
    ["audio", "audio", "audio"],
    "衔接槽排在音频组之后（槽 14..16 仍是 audio，A1 没被 ↩ 吃掉）",
  );
  eqNum(sandbox.videoGenPortMeta(br, 17).kind, "video", "R2V 端口 17 = ↩（数据端口号 ≡ 槽号）");
  eqNum(sandbox.videoGenPortMeta(br, 18), null, "R2V 开衔接后越界端口没有端子");
  eqNum(
    sandbox.videoGenMaxChains(mkNode({ videoMode: "fl2va", chainEnabled: true, workflowId: "wf-1" })),
    0,
    "自建工作流模式不加衔接槽（端口由参数表决定）",
  );
  eqNum(
    sandbox.videoGenMaxChains(mkNode({ videoMode: "r2v", chainEnabled: true, workflowId: "wf-1" })),
    0,
    "自建工作流 + R2V 同样不加衔接槽",
  );

  const c = mkNode({
    workflowId: "wf-cat",
    wfParams: [P("t1", "text", "画面提示词"), P("i2", "image", "首帧图"), P("i3", "image", "参考图"), P("n1", "number", "步数"), P("s1", "seed", "种子")],
  });
  ok(sandbox.isCustomVideoGen(c), "workflowId 非空 = 自建模式");
  eqNum(sandbox.videoGenInputCount(c), 4, "自建：控制（端口 0）+ 1 文本 + 2 个图像（number / seed 不占端子）");
  eqArr(
    [1, 2, 3].map((i) => sandbox.videoGenSlotMeta(c, i).kind),
    ["text", "image", "image"],
    "自建端子类型按参数类型排（数据槽号口径）",
  );
  eqArr(
    [1, 2, 3].map((i) => sandbox.videoGenSlotMeta(c, i).key),
    ["t1", "i2", "i3"],
    "端子 key = 参数 key（连线校验按它判类型）",
  );
  const vd = mkNode({ workflowId: "wf-v", wfParams: [P("a", "audio", "配音"), P("v", "video", "参考视频"), P("t", "text", "提示词")] });
  eqArr(
    [1, 2, 3].map((i) => sandbox.videoGenSlotMeta(vd, i).kind),
    ["text", "audio", "video"],
    "素材端子按参数表顺序排（audio 在前就占 2 号数据槽）",
  );
  eqNum(sandbox.videoGenControlPort(c), 0, "自建工作流：控制输入固定端口 0（不随数据槽数变化）");
  eqArr(
    [0, 1, 2, 3].map((i) => (sandbox.videoGenPortMeta(c, i) || {}).kind),
    ["ctrl", "text", "image", "image"],
    "自建端子排：端口 0 = 控制 + 数据端口 1..3",
  );
  eqNum(sandbox.videoGenInputCount(c), 4, "自建输入端子总数 = 数据槽 3 + 控制 1");
  const many = mkNode({
    workflowId: "wf-many",
    wfParams: Array.from({ length: 12 }, (_, i) => P("i" + i, "image", "图" + i)),
  });
  eqNum(sandbox.customWfInputCount(many), 1 + 9, "图像素材最多 9 个端子（超出的只能面板直填）");
  eqNum(sandbox.videoGenControlPort(many), 0, "端子全排满时控制口仍在端口 0");
  eqNum(sandbox.videoGenInputCount(many), 1 + 9 + 1, "自建端子总数 = 数据槽 + 控制 1");
  eqNum(sandbox.h3WfPortOf(c, "i2"), 2, "h3WfPortOf：首帧图 = 2 号数据槽（面板与 Agent 快照口径）");
  eqNum(sandbox.h3WfPortOf(c, "n1"), null, "h3WfPortOf：number 参数没有端子");
  eqNum(sandbox.h3WfPortOf(c, "nope"), null, "h3WfPortOf：不存在的 key 返回 null");
  eqNum(sandbox.h3WfUniqueKey(c, "t1"), "t1_2", "同名 key 自动加后缀避免撞车");
}

section("[8] 取值合并与下发装配");
{
  /* 起跑函数体只做源码级核对（它依赖整套运行 machinery，塞进沙箱跑不划算） */
  const runBody = fnBody(nodesSrc, "playVideoGenNode");
  const P = (key, type, label) => ({ key, type, label, source: { nodeId: "7", field: key } });
  const node = mkNode({
    workflowId: "wf-cat",
    wfParams: [P("t1", "text", "画面提示词"), P("i2", "image", "首帧图"), P("i3", "image", "参考图"), P("n1", "number", "步数")],
    wfParamValues: { n1: 12, i3: "E:\\素材\\直填.png" },
  });
  sandbox.S.wf.nodes = [node, { id: "up1", kind: "proc_text" }, { id: "up2", kind: "input_image" }];
  /* 画布连线存的是**端口下标**：v5 起端口号 ≡ 数据槽号（端口 0 = 控制输入）
     → 槽1=提示词落端口 1，槽2=首帧图落端口 2 */
  sandbox.S.wf.wires = [
    { from: "up1", to: "v1", fromIndex: 0, toIndex: 1 },
    { from: "up2", to: "v1", fromIndex: 0, toIndex: 2 },
  ];
  sandbox.SLOT["v1:1"] = { kind: "text", text: "从端口进来的提示词" };
  sandbox.SLOT["v1:2"] = { kind: "image", path: "E:\\素材\\端口.png" };
  const vals = sandbox.collectVideoGenWfValues(node);
  eqNum(vals.t1, "从端口进来的提示词", "端子有数据 → 端子值优先");
  eqNum(vals.i2, "E:\\素材\\端口.png", "图像端子带绝对路径（含分隔符 = 待上传）");
  eqNum(vals.i3, "E:\\素材\\直填.png", "端子没接 → 用面板直填值");
  eqNum(vals.n1, 12, "非端子参数走直填");
  ok(!Object.prototype.hasOwnProperty.call(vals, "x9"), "未提升的 key 不出现在值表里");

  /* wfPortMap 指定「哪个参数用哪个端子」 */
  const mapped = mkNode({
    workflowId: "wf-map",
    wfParams: [P("tA", "text", "A"), P("tB", "text", "B")],
    wfPortMap: { "1": "tB" },
  });
  sandbox.S.wf.nodes = [mapped, { id: "up1", kind: "proc_text" }];
  mapped.id = "v2";
  sandbox.S.wf.wires = [{ from: "up1", to: "v2", fromIndex: 0, toIndex: 1 }];
  const before = sandbox.collectVideoGenWfValues(mapped);
  sandbox.SLOT["v2:1"] = { kind: "text", text: "走 1 号端子" };
  const after = sandbox.collectVideoGenWfValues(mapped);
  eqNum(before.tB, undefined, "没有连线时不写值（保留工作流默认）");
  eqNum(after.tB, "走 1 号端子", "wfPortMap 把 1 号端子指向指定参数");
  eqNum(after.tA, undefined, "未被端子指向的文本参数不吃端子值");

  /* 下发装配：自建 = 精简对象；内置 = 原样（零回归） */
  sandbox.S.wf.nodes = [node, { id: "up1", kind: "proc_text" }, { id: "up2", kind: "input_image" }];
  sandbox.S.wf.wires = [
    { from: "up1", to: "v1", fromIndex: 0, toIndex: 1 },
    { from: "up2", to: "v1", fromIndex: 0, toIndex: 2 },
  ];
  const ctx = { nodeId: "v1", seed: 42, mode: "fl2va", prompt: "x", exp: { outputDir: "E:\\out", filename: "a.mp4" } };
  const custom = sandbox.buildVideoGenRunParams(node, ctx);
  eqNum(custom.customWorkflowId, "wf-cat", "自建：customWorkflowId = 节点选的库 id");
  ok(!Object.prototype.hasOwnProperty.call(custom, "workflowId"), "自建：下发不再有 workflowId 这个歧义键");
  eqNum(custom.wfParams.length, 4, "自建：带参数表");
  eqNum(custom.seed, 42, "自建：带节点级种子");
  eqArr(Object.keys(custom.wfParamValues).sort(), ["i2", "i3", "n1", "t1"], "自建：带合并后的值表");
  ["duration", "ratio", "outputRes", "steps", "postEnabled", "mode", "prompt", "refImages"].forEach((k) =>
    ok(!Object.prototype.hasOwnProperty.call(custom, k), "自建：不下发内置字段 " + k),
  );
  ["chainVideoPath", "chainFrames", "chainDenoise"].forEach((k) =>
    ok(!Object.prototype.hasOwnProperty.call(custom, k), "自建：不下发分段衔接字段 " + k),
  );
  const bi = mkNode({ videoMode: "r2v", duration: 8, outputRes: "720p" });
  const built = sandbox.buildVideoGenRunParams(bi, Object.assign({}, ctx, { mode: "r2v", refImages: ["a.png"] }));
  eqNum(built.customWorkflowId, "", "内置：customWorkflowId 必须为空（宿主据此才不分叉）");
  eqNum(built.canvasWorkflowId, "wf-test", "内置：画布 id 只进 canvasWorkflowId（供全局锁归因）");
  ok(!Object.prototype.hasOwnProperty.call(built, "workflowId"), "内置：画布 id 不再塞进 workflowId（回归：内置报「工作流不存在 id=wf_…」）");
  eqNum(sandbox.buildVideoGenRunParams(mkNode({ workflowId: " " }), ctx).customWorkflowId, "", "节点 workflowId 只有空白 = 内置模式");
  eqNum(built.duration, 8, "内置：时长照常下发");
  eqNum(built.outputRes, "720p", "内置：分辨率照常下发");
  eqArr(built.refImages, ["a.png"], "内置：参考图照常下发");
  ok(built.mode === "r2v" && built.prompt === "x", "内置：模式与提示词照常下发");
  /* 分段衔接下发字段（内置分支）：未开衔接时为空串 / 默认值，默认零回归 */
  eqNum(built.chainVideoPath, "", "内置：未开衔接 → chainVideoPath 空串（后端不加衔接子图）");
  eqNum(built.chainFrames, 22, "内置：衔接帧数默认 22");
  eqNum(built.chainDenoise, 1, "内置：重绘幅度默认 1（沿用全局 denoise）");
  const chainNode = mkNode({ videoMode: "fl2va", chainEnabled: true, chainFrames: 200, chainDenoise: 0.4 });
  const chainBuilt = sandbox.buildVideoGenRunParams(
    chainNode,
    Object.assign({}, ctx, { mode: "fl2va", chainVideoPath: "E:\\out\\seg1.mp4" }),
  );
  eqNum(chainBuilt.chainVideoPath, "E:\\out\\seg1.mp4", "内置：上一段成片路径随 ctx 下发（取 ↩ 端子的本机绝对路径）");
  eqNum(chainBuilt.chainFrames, 60, "内置：衔接帧数上限钳到 60");
  eqNum(chainBuilt.chainDenoise, 0.4, "内置：重绘幅度 0.4 原样下发（0.3–0.6 = 引导加重绘）");
  eqNum(
    sandbox.buildVideoGenRunParams(mkNode({ videoMode: "fl2va", chainDenoise: 0 }), ctx).chainDenoise,
    0,
    "内置：重绘幅度 0 照原样下发（宿主按 0 = 纯引导处理）",
  );
  /* R2V 开衔接：同一套下发字段（宿主按模式分派衔接子图） */
  const r2vChain = mkNode({ videoMode: "r2v", chainEnabled: true, chainFrames: 24, chainDenoise: 0.45 });
  const r2vBuilt = sandbox.buildVideoGenRunParams(
    r2vChain,
    Object.assign({}, ctx, { mode: "r2v", chainVideoPath: "E:\\out\\seg1.mp4" }),
  );
  eqNum(r2vBuilt.chainVideoPath, "E:\\out\\seg1.mp4", "R2V：上一段成片路径照常下发（多参考也走衔接）");
  eqNum(r2vBuilt.chainFrames, 24, "R2V：引导帧数下发");
  eqNum(r2vBuilt.chainDenoise, 0.45, "R2V：重绘幅度下发（0.3–0.6 = 引导加重绘）");

  /* 衔接端子取值：槽号**按 key 反查**，绝不允许写死 4 —— R2V 的衔接端子在槽 17，
     那里（槽 4）是参考图 I3；写死就会把参考图当成上一段成片送去衔接。 */
  sandbox.SLOT = {};
  sandbox.S.wf.nodes = [
    mkNode({ videoMode: "r2v", chainEnabled: true }),
    { id: "upP", kind: "proc_text" },
    { id: "upV", kind: "input_video" },
  ];
  sandbox.S.wf.wires = [
    { from: "upP", to: "v1", fromIndex: 0, toIndex: 4 },
    { from: "upV", to: "v1", fromIndex: 0, toIndex: 17 },
  ];
  sandbox.SLOT["v1:4"] = { kind: "image", path: "E:\\错放\\I3.png" };
  sandbox.SLOT["v1:17"] = { kind: "video", path: "E:\\out\\seg1.mp4" };
  eqNum(sandbox.videoGenChainSlot(sandbox.S.wf.nodes[0]), 17, "取值：R2V 的衔接端子 = 槽 17（按模式反查，不是写死的 4）");
  eqStr(
    sandbox.videoGenChainValue(sandbox.S.wf.nodes[0]),
    "E:\\out\\seg1.mp4",
    "取值：R2V 从端口 17 拿到上一段成片（槽 4 上就算有图也不吃 · 写死 4 就会拿错）",
  );
  const flChain = Object.assign(mkNode({ videoMode: "fl2va", chainEnabled: true }), { id: "v2" });
  sandbox.S.wf.nodes = [flChain, { id: "upV2", kind: "input_video" }];
  sandbox.S.wf.wires = [{ from: "upV2", to: "v2", fromIndex: 0, toIndex: 4 }];
  sandbox.SLOT["v2:4"] = { kind: "video", path: "E:\\out\\segA.mp4" };
  eqNum(sandbox.videoGenChainSlot(flChain), 4, "取值：FL2VA 的衔接端子仍是槽 4（末帧之后）");
  eqStr(sandbox.videoGenChainValue(flChain), "E:\\out\\segA.mp4", "取值：FL2VA 从端口 4 拿到上一段成片");
  eqNum(sandbox.videoGenChainSlot(mkNode({ videoMode: "r2v" })), 0, "取值：未开衔接 = 没有衔接槽（下发空串）");
  eqNum(sandbox.videoGenChainValue(mkNode({ videoMode: "r2v" })), null, "取值：未开衔接不取值");
  /* 真源不在场（只抽部分函数的桩沙箱）也要取对端子：按 meta.key === "chain" 反查兜底。
     这里刻意**不给** videoGenChainSlotIndex，只给一套按 R2V 口径排端子的替身。 */
  const chainSlotFallback = vm.runInNewContext(
    fnBody(nodesSrc, "videoGenChainSlot") + "\nvideoGenChainSlot({ kind: 'video_gen', videoMode: 'r2v', chainEnabled: true })",
    {
      videoGenMaxChains: () => 1,
      videoGenDataSlotsTotal: () => 17,
      videoGenSlotMeta: (n, i) =>
        i === 17 ? { kind: "video", key: "chain", label: "↩" } : { kind: "image", key: "ref" + i, label: "I" + i },
    },
    { filename: "renderer/app-nodes.js#chain-slot-fallback" },
  );
  eqNum(chainSlotFallback, 17, "兜底：没有真源时按 key === \"chain\" 反查，R2V 仍是槽 17（不是写死的 4）");
  /* R2V 衔接占用第几路参考视频（与宿主注入位同一套算式：未满追加 · 连满顶掉 V3） */
  eqNum(sandbox.videoGenChainRefIndex(mkNode({ videoMode: "r2v" }), 0), 1, "一路参考视频都没连 → 衔接占 V1");
  eqNum(sandbox.videoGenChainRefIndex(mkNode({ videoMode: "r2v" }), 2), 3, "已连 2 路 → 衔接占 V3");
  eqNum(sandbox.videoGenChainRefIndex(mkNode({ videoMode: "r2v" }), 3), 3, "连满 3 路 → 顶掉最后一路 V3（不静默丢）");
  /* 续写声明：R2V 没有 first_frame，必须告诉模型按那一路 <Video N> 续写 */
  eqStr(
    sandbox.videoGenChainMentionText(2),
    "Continue seamlessly from <Video 2> as the starting point; keep subjects, scene and camera continuity.",
    "续写声明文案（官方 <Video N> 口径 · video continuation）",
  );
  ok(sandbox.videoGenChainMentionOn({}) === true, "chainMention 缺字段 = 默认开（老画布照旧生效）");
  ok(sandbox.videoGenChainMentionOn({ chainMention: false }) === false, "chainMention 显式 false 才关");
  ok(
    /videoGenChainRefIndex\(node, refVideos\.length\)/.test(runBody),
    "运行期按实际参考视频条数算占用第几路（与宿主同一套算式）",
  );
  ok(
    /chainRefIndex && videoGenChainMentionOn\(node\)/.test(runBody) &&
      /prompt: runPrompt/.test(runBody),
    "R2V 才补续写声明，且补过的那份才是发给后端的 prompt（FL2VA 提示词逐字不变）",
  );
}

section("[9] 接线契约（源码级）");
{
  /* 主进程：库 / IPC / 执行分叉 */
  ok(/require\("\.\/h3-workflows\.js"\)/.test(mainH3Src), "main-h3.js 引入 h3-workflows.js 真源");
  ["h3:wfList", "h3:wfGet", "h3:wfSyncParams", "h3:wfValidate", "h3:wfImport", "h3:wfDelete", "h3:wfRename", "h3:wfExport", "h3:wfTemplateExport"].forEach(
    (ch) => ok(mainH3Src.includes('ipcMain.handle("' + ch + '"'), '主进程注册 ' + ch),
  );
  ok(/if \(customWfId\) \{\s*\n\s*return await runCustomWorkflow/.test(mainH3Src), "generateVideo：customWorkflowId 非空即分叉到自建执行分支");
  ok(!/if \(String\(params\.workflowId \|\| ""\)\.trim\(\)\)/.test(mainH3Src), "分叉条件不再吃 params.workflowId（画布 id 撞键 → 内置报「工作流不存在」的根因）");
  ok(!/const wfId = String\(params\.workflowId/.test(mainH3Src), "自建分支的库 id 取自路由判定结果，不再直接读 workflowId");
  ok(/tryAcquireLock\(\{\s*\n\s*nodeId,\s*\n\s*workflowId: String\(params\.canvasWorkflowId/.test(mainH3Src), "全局锁里的 workflowId = 画布 id（仅归因，不参与路由）");
  const customBranch = mainH3Src.split("async function runCustomWorkflow")[1].split("async function cancelGenerate")[0];
  ok(!/params\.postEnabled|Object\.assign\(\{\}, wfParams, \{ postVideoPath/.test(customBranch), "自建分支不追加 4K 超分补帧阶段");
  ok(!/buildPostWorkflow|phase:\s*"post"/.test(customBranch), "自建分支不做任何后处理注入（超分 / 补帧只在 h3:postProcess 里成图）");
  ok(/preferredNodeId: outPick\.nodeId/.test(mainH3Src), "自建分支按挑选的输出节点取产物");
  ok(/uploadFileToComfy\(port, u\.path, u\.type\)/.test(mainH3Src), "自建分支把本机素材上传到 ComfyUI 再注入");

  /* 分段衔接（长视频无缝衔接）：宿主图 = 上一段末帧引导 + 重绘幅度（源码级钉住口径） */
  ok(/nodes\[chainLoadV\] = w\("LoadVideo", \{ file: uploaded\.chain \}\)/.test(mainH3Src), "衔接子图：LoadVideo 载入上一段成片");
  ok(/nodes\[chainGetV\] = w\("GetVideoComponents", \{ video: link\(chainLoadV, 0\) \}\)/.test(mainH3Src), "衔接子图：GetVideoComponents 拆帧");
  ok(/batch_index: -chainFrames/.test(mainH3Src), "衔接子图：取上一段末尾 chainFrames 帧做引导窗口");
  ok(/batch_index: -1,[\s\S]{0,80}length: 1/.test(mainH3Src), "衔接子图：窗口最后一帧（帧数-1 = 末帧）作构图锚");
  ok(/else if \(chainAnchor\) h3Inputs\.first_frame = link\(chainAnchor, 0\)/.test(mainH3Src), "锚定构图：无首帧输入时才用衔接末帧，用户首帧优先");
  ok(
    /chainRedraw > 0 && chainRedraw < 1/.test(mainH3Src) && /denoise: useChainRedraw \? chainRedraw : Number\(params\.denoise\) \|\| 1/.test(mainH3Src),
    "引导加重绘：(0,1) 才落 denoise；0 与 1 退回纯引导（沿用全局 denoise，denoise=0 非法）",
  );
  ok(/uploadFileToComfy\(port, chainPath, "video"\)/.test(mainH3Src), "衔接成片登记进 ComfyUI input（与后处理同口径）");
  ok(/衔接视频不存在，已跳过段间引导/.test(mainH3Src), "衔接文件缺失只记日志跳过，不阻断正常生成");
  ok(/chainFrames: params\.chainFrames != null \? Number\(params\.chainFrames\) : 22/.test(mainH3Src), "wfParams 带 chainFrames（与渲染层同名字段）");
  ok(/chainDenoise: params\.chainDenoise != null \? Number\(params\.chainDenoise\) : 1/.test(mainH3Src), "wfParams 带 chainDenoise（与渲染层同名字段）");

  /* 分段衔接 · R2V（多参考）：上一段末尾 N 帧当一路 <Video N> 续写引导（源码级钉住） */
  ok(/if \(uploaded\.chain\) \{/.test(mainH3Src), "衔接子图不再限定 FL2VA：uploaded.chain 一到就建（R2V 也进图）");
  ok(!/mode === "fl2va" && uploaded\.chain/.test(mainH3Src), "旧条件（仅 fl2va 才衔接）已移除");
  ok(
    mainH3Src.indexOf("params.refAudios || []") < mainH3Src.indexOf('const chainPath = String(params.chainVideoPath'),
    "衔接上传排在两种模式的素材分支之后（R2V 分支也走得到，不是塞在 fl2va 里）",
  );
  has(mainH3Src, "const H3_REF_VIDEO_MAX = 3;", "参考视频 3 路封顶有唯一真源常量（衔接占用 / 顶替都按它算）");
  has(mainH3Src, "const chainImg = link(chainWin, 0);", "R2V：末 N 帧窗口的画面帧直接当一路参考视频");
  ok(/videoLinks\.push\(chainImg\)/.test(mainH3Src), "R2V：参考视频没连满 → 衔接窗口追加为最后一路（V1 起顺序占位）");
  ok(/videoAudioLinks\.push\(null\)/.test(mainH3Src), "R2V：衔接这一路不喂音轨（窗口只有 N 帧，配整段音轨会音画长度不匹配）");
  ok(
    /const refsFull = videoLinks\.length >= H3_REF_VIDEO_MAX;/.test(mainH3Src) &&
      /videoLinks\[H3_REF_VIDEO_MAX - 1\] = chainImg;/.test(mainH3Src) &&
      /videoAudioLinks\[H3_REF_VIDEO_MAX - 1\] = null;/.test(mainH3Src),
    "R2V：连满 3 路时顶掉最后一路 V3（索引与素材对齐，不静默丢）",
  );
  ok(/dropped\.forEach\(\(nid\) => delete nodes\[nid\]\)/.test(mainH3Src), "被顶掉的参考视频那两节点一并从图里摘掉（不留孤儿节点）");
  ok(/notes\.chainVideo = chainVideoNote/.test(mainH3Src) && /graphNotes\.chainVideo/.test(mainH3Src), "占了第几路 / 是否顶替 → 交给上层落控制台日志");
  has(mainH3Src, "该路原有参考视频本段未接入", "顶替 V3 时话写明白：用户那条参考视频本段没进图");
  ok(
    /const chainActive = !!chainAnchor \|\| !!chainRefVideo;/.test(mainH3Src) &&
      /!!chainActive && Number\.isFinite\(chainRedraw\)/.test(mainH3Src),
    "引导加重绘与模式无关：FL2VA 末帧锚 或 R2V 衔接参考视频 任一生效都共用 chainDenoise",
  );
  ok(
    /function videoGenChainSlot\(node\) \{[\s\S]{0,900}videoGenChainSlotIndex\(node\)[\s\S]{0,900}meta\.key === "chain"/.test(nodesSrc),
    "渲染层取值：先问 app.js 真源、再按 meta.key === \"chain\" 反查兜底（绝不写死槽号 4）",
  );
  ok(!/videoGenSlotValue\(node, 4\)/.test(fnBody(nodesSrc, "videoGenChainValue")), "衔接取值不再硬编码 videoGenSlotValue(node, 4)（R2V 槽 4 是参考图，会取错端子）");
  has(nodesSrc, "Continue seamlessly from <Video ", "R2V 续写声明文案在渲染层（官方 <Video N> = video continuation 续写起点）");
  ok(/videoGenSlotValue\(node, slot\)/.test(fnBody(nodesSrc, "videoGenChainValue")), "衔接取值按反查到的槽号取（模式自动跟进）");
  ok(/chainEnabled/.test(canvasSrc) && /自动补写续写声明/.test(canvasSrc), "设置窗「分段衔接」两种模式都出现，R2V 多一个自动补写续写声明开关");

  /* 桥：两条线（主窗口 + H3 管理窗）各自暴露 */
  ["h3WorkflowList", "h3WorkflowGet", "h3WorkflowSyncParams", "h3WorkflowValidate", "h3WorkflowTemplateExport"].forEach(
    (m) => ok(preloadSrc.includes(m + ":"), "preload 暴露 window.api." + m),
  );
  ["wfList", "wfImport", "wfDelete", "wfRename", "wfExport", "wfValidate", "wfGet", "wfTemplateExport"].forEach(
    (m) => ok(h3PreloadSrc.includes(m + ":"), "H3 管理窗暴露 " + m),
  );

  /* 渲染层：面板挂载 + 内置参数块在自建模式下隐藏 */
  ok(/appendVideoGenWorkflowControls\(wfHost, node, addField\);/.test(canvasSrc), "video_gen 设置窗顶部挂自建工作流区");
  ok(/if \(isCustomVideoGen\(node\)\) return;/.test(canvasSrc), "自建模式下内置参数整块不出现（表单早退）");
  eqNum((nodesSrc.match(/function appendVideoGenWorkflowControls/g) || []).length, 1, "面板函数无重复定义");
  eqNum((nodesSrc.match(/function appendVideoGenWfParamRow/g) || []).length, 1, "参数行函数无重复定义");
  ok(/if \(isCustomVideoGen\(node\)\) return videoGenWfInputCount\(node\);/.test(appSrc) || /if \(isCustomVideoGen\(node\)\) return customWfInputCount\(node\);/.test(appSrc), "端子数：自建模式改按参数表算");
  ok(/const isCustomVid = node\.kind === "video_gen" && isCustomVideoGen\(node\);/.test(nodesSrc), "参数面板按自建模式分流（时长档位换秒数）");

  /* Agent 可读可改：canvas_get 透出 + applyNodePatch 接受 */
  ok(/workflowId:\s*\n?\s*n\.kind === "video_gen" && String\(n\.workflowId/.test(nodesSrc), "canvas_get 快照透出自建 workflowId");
  ok(/if \(patch\.workflowId != null\) \{/.test(nodesSrc), "Agent 可 patch workflowId 切换自建工作流");
  ok(/patch\.wfParamValues && typeof patch\.wfParamValues === "object"/.test(nodesSrc), "Agent 可 patch 直填值");

  /* 样式 / i18n / 指南 */
  ["mgwf-row", "mgwf-grow", "mgwf-type", "mgwf-port", "mgwf-src", "mgwf-head"].forEach((c) =>
    ok(cssSrc.includes("." + c), "canvas.css 有 ." + c),
  );
  const I18n = require("../renderer/i18n.js");
  I18n.setLocale("en");
  const wfRegion = nodesSrc.slice(
    nodesSrc.indexOf("H3 自建 ComfyUI 工作流（接入 video_gen 节点）"),
    nodesSrc.indexOf("function applyMediaGenConfiguredPath"),
  );
  const literals = new Set();
  for (const m of wfRegion.matchAll(/I18n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)) literals.add(JSON.parse('"' + m[1] + '"'));
  for (const m of wfRegion.matchAll(/^\s*\["[a-z]*", "((?:[^"\\]|\\.)*)"\]/gm)) literals.add(JSON.parse('"' + m[1] + '"'));
  const noEntry = [...literals].filter((k) => I18n.t(k) === k && /[\u4e00-\u9fa5]/.test(k));
  eqNum(noEntry.length, 0, "自建工作流面板的中文串全部有英文词条（缺：" + show(noEntry).slice(0, 120) + "）");
  ok(literals.size >= 40, "面板文案条数合理（" + literals.size + " 条）");
  ok(I18n.t("自建 ComfyUI 工作流") !== "自建 ComfyUI 工作流", "关键词条已翻译：" + I18n.t("自建 ComfyUI 工作流"));
  /* media-net 手册页已删（本轮手册按「快速开始」画布重排），自建工作流说明改由 media-gen 页承载 */
  for (const f of ["guides/nodes/video_gen.md", "guides/nodes/en/video_gen.md", "guides/manual/media-gen.md", "guides/manual/en/media-gen.md"])
    ok(/自建 ComfyUI 工作流|Custom ComfyUI workflow/.test(read(f)), f + " 已补自建工作流说明");
  ok(/workflowId: \{[^}]*自建 ComfyUI 工作流库 id/.test(pluginSrc), "画布工具属性表含 video_gen 的自建库 id");
  eqNum((pluginSrc.match(/自建 ComfyUI 工作流库 id/g) || []).length, 1, "create 与 update 共用同一份 NODE_PROPS（描述只写一处 · 提示词单一真源）");
  ok(/const UPDATE_SPEC = \{[\s\S]{0,400}与 create\[\] 的属性表同一份/.test(pluginSrc), "update 显式指向 create 的属性表（workflowId 跟着可改）");
}

section("[10] 宿主路由判定（main-h3.js 真身函数 · 回归：内置任务被判成自建）");
{
  const code = extract(mainH3Src, ["resolveCustomWorkflowId", "customWorkflowMissingMessage"]);
  const mkHost = (store) => {
    const sb = { workflowStore: () => store };
    vm.runInNewContext(code, sb, { filename: "h3-route-extract" });
    return sb;
  };
  const lib = {
    get: (id) => (id === "wf-cat" ? { id: "wf-cat", title: "猫咪视频" } : null),
    list: () => [{ id: "wf-cat", title: "猫咪视频" }],
  };
  const host = mkHost(lib);

  /* 现场复现：内置链带的是画布 id（形如 wf_mtjt9bmr），曾被当成自建库 id 报「工作流不存在」 */
  eqNum(host.resolveCustomWorkflowId({ canvasWorkflowId: "wf_mtjt9bmr" }), "", "内置：只带画布 id → 不分叉（走内置 FL2VA / R2V 链）");
  eqNum(
    host.resolveCustomWorkflowId({ canvasWorkflowId: "wf_mtjt9bmr", workflowId: "wf_mtjt9bmr" }),
    "",
    "老载荷：workflowId = 画布 id 且库里查不到 → 仍按内置跑",
  );
  eqNum(host.resolveCustomWorkflowId({ customWorkflowId: "wf-cat", canvasWorkflowId: "wf_mtjt9bmr" }), "wf-cat", "自建：两个 id 同时下发时只认 customWorkflowId");
  eqNum(host.resolveCustomWorkflowId({ customWorkflowId: "  wf-cat  " }), "wf-cat", "两侧空白自动 trim");
  eqNum(host.resolveCustomWorkflowId({ workflowId: "wf-cat" }), "wf-cat", "老载荷：workflowId 在库里真存在 → 仍按自建跑（兼容不丢功能）");
  eqNum(host.resolveCustomWorkflowId({}), "", "空载荷 → 内置");
  eqNum(host.resolveCustomWorkflowId(null), "", "null 载荷 → 内置");
  eqNum(host.resolveCustomWorkflowId({ customWorkflowId: "" }), "", "customWorkflowId 显式空串 → 内置");
  const boom = mkHost({
    get: () => {
      throw new Error("EACCES");
    },
    list: () => {
      throw new Error("EACCES");
    },
  });
  eqNum(boom.resolveCustomWorkflowId({ workflowId: "wf-cat" }), "", "库读取抛错：老载荷回落内置（内置路径不受库状态影响）");
  eqNum(boom.resolveCustomWorkflowId({ customWorkflowId: "wf-cat" }), "wf-cat", "库读取抛错：自建 id 照样透传，由分支里报真实原因");

  const msg = host.customWorkflowMissingMessage("wf_gone");
  ok(/wf_gone/.test(msg), "缺条目的报错带上具体 id：" + msg.slice(0, 40) + "…");
  ok(/重新选择/.test(msg) && /猫咪视频/.test(msg), "报错提示重新选择并列出库内现有条目");
  ok(host.customWorkflowMissingMessage("").length > 0, "id 为空也有话可说");
  ok(mkHost({ get: () => null, list: () => [] }).customWorkflowMissingMessage("x").includes("导入"), "空库时提示去管理窗口导入");
}

section("[11] API → UI 反向转换：内置 FL2VA / R2V 真图回环 + 导出落盘（临时目录 · 不碰 ComfyUI 现场）");
{
  const constBlock = (name) => {
    const m = new RegExp("\\nconst " + name + " = \\{[\\s\\S]*?\\n\\};", "m").exec(mainH3Src);
    if (!m) throw new Error("找不到常量：" + name);
    return m[0].trim();
  };
  const host = {};
  vm.runInNewContext(
    [constBlock("MODELS"), constBlock("POST_MODELS"), constBlock("EASY_SAFE"), extract(mainH3Src, ["calcLength", "clampNum", "buildH3Workflow", "builtinTemplateGraph"])].join("\n"),
    host,
    { filename: "h3-builtin-extract" },
  );
  const emptyFields = (g) => {
    const out = [];
    for (const k of Object.keys(g).sort()) {
      for (const f of Object.keys((g[k] && g[k].inputs) || {})) if (g[k].inputs[f] === "") out.push(k + "." + f);
    }
    return out.sort();
  };
  const canon = (g) => {
    const out = {};
    for (const k of Object.keys(g).sort()) {
      const n = g[k] || {};
      const inputs = {};
      for (const f of Object.keys(n.inputs || {}).sort()) {
        if (n.inputs[f] === "") continue;
        inputs[f] = n.inputs[f];
      }
      out[k] = { class_type: n.class_type, inputs };
    }
    return out;
  };
  for (const mode of ["fl2va", "r2v"]) {
    const api = host.builtinTemplateGraph(mode);
    const ui = h3wf.apiToUiGraph(api);
    eqNum(ui.nodes.length, Object.keys(api).length, `${mode}：内置图 ${Object.keys(api).length} 个节点全部还原成 UI 节点`);
    eqNum(ui.warnings.length, 0, `${mode}：反向转换零警告（内置图没有悬空连线）`);
    eqNum(
      ui.links.length,
      Object.values(api).reduce((s, n) => s + Object.values(n.inputs).filter((v) => Array.isArray(v)).length, 0),
      `${mode}：每条连线都落进 links 表（${ui.links.length} 条）`,
    );
    ok(ui.nodes.every((n) => n.size && n.size[0] > 0), `${mode}：UI 节点带尺寸`);
    eqNum(new Set(ui.nodes.map((n) => n.pos.join(","))).size, ui.nodes.length, `${mode}：位置按依赖层排开，没有两个节点叠在一起`);
    const norm = h3wf.normalizeGraph({ nodes: ui.nodes, links: ui.links });
    eqNum(norm.format, "ui", `${mode}：产物正是导入路径吃的 UI 格式`);
    ok(h3wf.validateApiGraphShape(norm.graph).ok, `${mode}：转回来的 API 图通过形状校验`);
    ok(JSON.stringify(canon(norm.graph)) === JSON.stringify(canon(api)), `${mode}：回环后与原 API 图同口径一致（class_type / 连线 / widget 值全对）`);
    eqArr(emptyFields(norm.graph), [], `${mode}：回环只少了空串字段（${show(emptyFields(api))}）——uiToApiGraph 既有口径「空 widget 值不写回字段」，对真实 ComfyUI 导出同样成立`);
    const scan = h3wf.scanGraph(norm.graph);
    ok(scan.outputs.length >= 1, `${mode}：还认得出产物节点（${scan.outputs[0].nodeId}）`);
    const params = h3wf.normalizeParams(scan.suggested, norm.graph).params;
    eqNum(h3wf.applyMapping(norm.graph, {}, params, 123, { seedFields: scan.seedFields }).errors.length, 0, `${mode}：转回来的图注入无错误`);
    eqNum(h3wf.pickOutputNode(scan, "").nodeId, h3wf.pickOutputNode(h3wf.scanGraph(api), "").nodeId, `${mode}：输出节点挑选结果与原图一致`);
    ok(h3wf.collectSeedFields(norm.graph).some((s) => s.field === "noise_seed"), `${mode}：RandomNoise.noise_seed 仍被认成种子字段（节点级种子照常下发）`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "h3rt-"));
    const lib = path.join(tmp, "lib");
    const out = path.join(tmp, "comfy-workflows");
    const store = new h3wf.H3WorkflowStore({ dataDir: lib });
    const made = store.createFromGraph({ title: "内置 " + mode, graph: api, format: "api", sourceName: "builtin:" + mode, template: true });
    ok(made.ok, `${mode}：内置图入库当模板`);
    const before = JSON.stringify(store.get(made.summary.id).graph);
    const exp = store.exportComfyUiFile(made.summary.id, out);
    ok(exp.ok, `${mode}：exportComfyUiFile 成功（${exp.error || exp.filename}）`);
    ok(exp.path && exp.path.startsWith(out) && fs.existsSync(exp.path), `${mode}：文件只落在指定目录`);
    const doc = JSON.parse(fs.readFileSync(exp.path, "utf8"));
    ok(Array.isArray(doc.nodes) && Array.isArray(doc.links) && doc.nodes.length > 1, `${mode}：落盘内容是 {nodes,links} UI 文档`);
    eqNum(exp.filename, "内置 " + mode + ".json", `${mode}：文件名保留中文标题原样（宿主的回退提示要让用户在 ComfyUI 列表里认出这条）`);
    ok(JSON.stringify(store.get(made.summary.id).graph) === before, `${mode}：导出后库内原图一字节没动（无写回）`);
    eqNum(fs.readdirSync(path.join(lib, h3wf.WORKFLOWS_DIRNAME, made.summary.id)).join(","), h3wf.WORKFLOW_FILE, `${mode}：条目目录里仍只有 ${h3wf.WORKFLOW_FILE}（没多出 UI 文件）`);
    ok(store.exportComfyUiFile("wf_nope", out).ok === false, `${mode}：id 不存在时拒绝导出`);
    ok(store.exportComfyUiFile(made.summary.id, "  ").ok === false, `${mode}：目标目录为空时拒绝导出`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  try {
    h3wf.apiToUiGraph({ 1: { class_type: "X", inputs: { a: ["9", 0] } } });
    ok(false, "形状不合法的 API 图应被拒");
  } catch (e) {
    ok(/校验/.test(String(e && e.message)), "API 图不合法时直接抛错（不会产出一个打不开的文件）");
  }
  eqNum(h3wf.recordToUiWorkflowText({}).ok, false, "记录缺图时返回错误对象而不是抛异常");
  /* 落盘文件名：中文原样留着，只去掉文件系统不认的字符（宿主的回退提示靠它指认条目） */
  eqNum(h3wf.comfyWorkflowFileName("猫咪 首尾帧 · v2"), "猫咪 首尾帧 · v2", "中文 / 空格 / 间隔号原样保留");
  eqNum(h3wf.comfyWorkflowFileName('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j", "路径分隔符与 Windows 非法字符换成空格");
  eqNum(h3wf.comfyWorkflowFileName("   尾巴点号...  "), "尾巴点号", "首尾空白与结尾点号清掉（Windows 会拒）");
  eqNum(h3wf.comfyWorkflowFileName("  ", "wf_abc123"), "wf_abc123", "标题空时回落 id");
  eqNum(h3wf.comfyWorkflowFileName("x".repeat(200)).length, 80, "超长标题截到 80 字符");
}

section("[12] EasyCache 复用阈值：H3 走画质安全档（回归：官方 0.2/0.15/0.95 一开就掉画质）");
{
  const constBlock = (name) => {
    const m = new RegExp("\\nconst " + name + " = \\{[\\s\\S]*?\\n\\};", "m").exec(mainH3Src);
    if (!m) throw new Error("找不到常量：" + name);
    return m[0].trim();
  };
  const host = {};
  vm.runInNewContext(
    [constBlock("MODELS"), constBlock("POST_MODELS"), constBlock("EASY_SAFE"), extract(mainH3Src, ["calcLength", "clampNum", "buildH3Workflow", "builtinTemplateGraph"])].join("\n"),
    host,
    { filename: "h3-easy-extract" },
  );
  const B = vm.runInNewContext("EASY_SAFE", host);
  const cl = (v, k) => host.clampNum(v, B[k].min, B[k].max, B[k].value);
  /* 实测口径：官方默认 0.2/0.15/0.95 在 20 步 H3 上逐帧差异 max 0.13、相邻帧抖动
   * 0.0119（关缓存 0.0092）；安全档 0.08/0.30/0.90 差异 0.004、抖动与关缓存一致。 */
  eqNum(cl(0.2, "reuse"), B.reuse.max, "官方 reuse 0.2 被夹到安全上限（不许再回到那档）");
  eqNum(cl(0.15, "start"), B.start.min, "官方 start 0.15 被夹到安全下限（缓存不再第 3 步就生效）");
  eqNum(cl(0.95, "end"), 0.95, "官方 end 0.95 落在合法区间内（第二个种子实测与 0.90 差异 <0.01，故只钉区间不硬改）");
  eqNum(cl(1.5, "end"), B.end.max, "超上限 end 被夹回安全上沿");
  eqNum(cl(undefined, "reuse"), B.reuse.value, "缺值 → 安全档默认 reuse");
  eqNum(cl(NaN, "start"), B.start.value, "非有限数 → 安全档默认 start");
  eqNum(cl(-1, "end"), B.end.min, "越界负值 → 夹到下限");
  ok(B.reuse.value >= B.reuse.min && B.reuse.value <= B.reuse.max, "安全档默认 reuse 落在允许区间内");
  ok(B.start.value === 0.3 && B.end.value === 0.9, "安全档默认 start/end 就是实测那一档");
  ok(B.reuse.max < 0.2 + 1e-9, "reuse 允许上限不超过官方默认（官方档永远进不来）");
  const api = host.builtinTemplateGraph("fl2va");
  const easy = Object.values(api).find((n) => n.class_type === "EasyCache");
  ok(!!easy, "内置模板里仍有 EasyCache 节点（优化没被删）");
  eqNum(easy.inputs.reuse_threshold, B.reuse.value, "内置模板 EasyCache reuse 用安全档默认");
  eqNum(easy.inputs.start_percent, B.start.value, "内置模板 EasyCache start 用安全档默认");
  eqNum(easy.inputs.end_percent, B.end.value, "内置模板 EasyCache end 用安全档默认");
}

console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"));
process.exit(fails ? 1 : 0);

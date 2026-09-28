"use strict";
/* 模型形态识别（文本模型 / 图像生成模型）—— 冒烟测试（纯 Node · 真实源码真跑）
 *   node test/smoke-model-kind.js
 *
 * 立规：服务商配置里只有**服务商级** type 与一串模型 id。同一个 OpenAI 兼容端点
 * 常把文本模型与图像模型挂在一起（用户真实配置里就有：api.apiyi.com 一家同时有
 * qwen3.7-plus 与 gpt-image-2-vip），只配成 text_openai 时图像节点根本选不到那个
 * 图像模型，配错还会在运行期抛「未知服务商类型：text_openai」。
 * 所以「谁算文本 / 谁算图像」必须有一层**模型级**判定，且全渲染层同源：
 *   renderer/app-model-kind.js  识别 + 覆盖 + 服务商形态 + 类型纠偏（本测试主体）
 *   renderer/app-settings.js    模型行徽标（可手改）· 添加服务商按模型拆分
 *   renderer/app-canvas.js      节点设置的服务商 / 模型下拉按形态过滤
 *   renderer/app.js             无模型判据（nodeModelGate 按形态取模型表，不再弹批量替换窗）
 *   renderer/app-nodes.js       运行期按所选模型纠服务商类型
 * 本测试既真跑识别逻辑，也钉住上面四处的接入点（改动走样即红）。
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
function EQ(got, want, msg) {
  ok(
    got === want,
    msg +
      (got === want ? "" : "\n        实际=" + JSON.stringify(got) + "\n        期望=" + JSON.stringify(want)),
  );
}
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
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

const MK = require("../renderer/app-model-kind.js");

/* ═════════ [1] 单个模型识别 ═════════ */
console.log("\n[1] 模型 id → 形态：常见图像家族判图像、对话模型判文本");
{
  const IMAGE_IDS = [
    "gpt-image-2-vip",
    "gpt-image-2.5-all",
    "gpt-image-2.5-sunburst",
    "dall-e-3",
    "seedream-5-0-pro-260628",
    "flux-1.1-pro",
    "stable-diffusion-3.5-large",
    "sd3.5",
    "sdxl-turbo",
    "midjourney-v6",
    "niji-6",
    "kolors-v1.5",
    "cogview-4",
    "imagen-4.0-generate-001",
    "qwen-image-plus",
    "wanx-v1",
    "hunyuan-image-3.0",
    "ideogram-v3",
    "recraft-v3",
    "kontext-pro",
    "grok-2-image-1212",
  ];
  let bad = [];
  for (const id of IMAGE_IDS)
    if (MK.inferModelKind(id) !== "image") bad.push(id);
  ok(bad.length === 0, "图像家族全部识别为 image（漏判：" + (bad.join(", ") || "无") + "）");

  const TEXT_IDS = [
    "deepseek-flash",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "qwen3.8-flash",
    "qwen3.7-max",
    "glm-5.2",
    "kimi-k3",
    "MiniMax-M2.5",
    "mimo-v2.5",
    "gpt-4o",
    "claude-opus-4",
    "gemini-2.5-pro",
    "gemma-4-E4B-it",
    "llama-3.3-70b",
    "hy3",
    "ZHIPU/GLM-5.3-Flash",
    "aoi",
    "gpt-sovits",
  ];
  bad = [];
  for (const id of TEXT_IDS) if (MK.inferModelKind(id) !== "text") bad.push(id);
  ok(bad.length === 0, "对话 / 本地文本模型全部识别为 text（误判：" + (bad.join(", ") || "无") + "）");

  /* 关键反例：含 image 但其实是文本的视觉输入模型（input: text+image ≠ 出图） */
  EQ(
    MK.inferModelKind("deepseek-flash"),
    "text",
    "视觉输入模型不是图像生成模型（能看图 ≠ 会出图）",
  );
  EQ(MK.inferModelKind("gemini-2.5-flash-image"), "text", "gemini 带 image 后缀仍按文本家族判（保守不误伤）");
  EQ(MK.inferModelKind(""), "text", "空 id 回落文本（安全侧）");
  EQ(MK.inferModelKind("whatever-new-model"), "text", "未知 id 回落文本（安全侧）");
}

/* ═════════ [2] 手工覆盖：覆盖永远赢过识别 ═════════ */
console.log("\n[2] 手工覆盖（config.modelKinds）优先于自动识别");
{
  const cfg = { modelKinds: { pv1: { "new-model": "image" } } };
  EQ(MK.modelKindOf(cfg, "pv1", "new-model"), "image", "识别不出的新模型可手工指定为图像");
  EQ(MK.modelKindOverride(cfg, "pv1", "new-model"), "image", "读取覆盖值");
  EQ(MK.modelKindOverride(cfg, "pv2", "new-model"), "", "别的服务商的覆盖互不串台");
  EQ(MK.modelKindOf(cfg, "pv2", "new-model"), "text", "未覆盖处仍走自动识别");
  const bad = { modelKinds: { pv1: { x: "video" } } };
  EQ(MK.modelKindOverride(bad, "pv1", "x"), "", "非法覆盖值一律忽略（回落识别）");
  EQ(MK.modelKindOf(bad, "pv1", "x"), "text", "非法覆盖不改变结论");
  EQ(MK.modelKindOf(null, "pv1", "gpt-image-2-vip"), "image", "无配置对象也不抛（空配置可跑）");
}

/* ═════════ [3] 服务商形态：同一端点混挂两类模型 ═════════ */
console.log("\n[3] 服务商形态：配成 text_openai 但含图像模型 → 文本 + 图像双形态");
{
  const cfg = {};
  const mixed = {
    id: "pmthfnbl9to6",
    name: "API易",
    type: "text_openai",
    models: ["qwen3.7-plus", "gpt-image-2-vip"],
  };
  EQ(MK.providerKinds(cfg, mixed).join("+"), "text+image", "混合端点算两种形态（这就是从前选不到图像模型的那家）");
  EQ(MK.providerHasKind(cfg, mixed, "text"), true, "含文本模型 → 文本节点可选");
  EQ(MK.providerHasKind(cfg, mixed, "image"), true, "含图像模型 → 图像节点也可选");
  EQ(MK.modelsOfKind(cfg, mixed, "text").join(","), "qwen3.7-plus", "文本模型下拉只列文本模型");
  EQ(MK.modelsOfKind(cfg, mixed, "image").join(","), "gpt-image-2-vip", "图像模型下拉只列图像模型");

  const pureText = { id: "deepseek", type: "text_openai", models: ["deepseek-flash", "deepseek-v4-pro"] };
  EQ(MK.providerKinds(cfg, pureText).join("+"), "text", "纯文本服务商只有文本形态");
  EQ(MK.providerHasKind(cfg, pureText, "image"), false, "纯文本服务商不出现在图像节点");

  const pureImg = { id: "gpt_image_2", type: "image_openai", models: ["gpt-image-2-vip", "seedream-5-0-pro-260628"] };
  EQ(MK.providerKinds(cfg, pureImg).join("+"), "image", "显式 image_* 类型 = 图像形态");
  EQ(MK.providerHasKind(cfg, pureImg, "text"), false, "图像服务商不出现在文本节点");

  /* 目录提示（视觉输入）与服务商形态无关，只是补充判据 */
  const catalog = {
    deepseek: [{ id: "deepseek-flash", input: ["text", "image"] }],
    piai: [{ id: "x", models: [{ id: "vision-model", input: ["text", "image"] }] }],
  };
  EQ(MK.catalogModelAcceptsImage(catalog, "deepseek-flash"), true, "目录 input 含 image = 能吃图");
  EQ(MK.catalogModelAcceptsImage(catalog, "vision-model"), true, "pi-ai 目录同样判");
  EQ(MK.catalogModelAcceptsImage(catalog, "deepseek-v4-pro"), false, "目录里没标 image 的不算");
}

/* ═════════ [4] 类型纠偏：按**本次要用的那个模型** ═════════ */
console.log("\n[4] 类型纠偏：所选模型的形态与服务商类型不符时给出应有的类型");
{
  const cfg = {};
  const p = { id: "px", type: "text_openai", models: ["gpt-image-2-vip", "qwen3.7-plus"] };
  EQ(MK.correctedTypeForModel(cfg, p, "gpt-image-2-vip"), "image_openai", "选中图像模型 + 文本类型 → 纠为 image_openai");
  EQ(MK.correctedTypeForModel(cfg, p, "qwen3.7-plus"), "", "选中文本模型且类型已是文本 → 不动");
  EQ(MK.correctedTypeForModel(cfg, p, ""), "", "没有模型 → 不动");
  const p2 = { id: "py", type: "image_openai", models: ["gpt-image-2-vip"] };
  EQ(MK.correctedTypeForModel(cfg, p2, "gpt-image-2-vip"), "", "类型本来就对 → 不动");
  const p3 = { id: "pz", type: "image_stability", models: ["core", "sd3.5"] };
  EQ(MK.correctedTypeForModel(cfg, p3, "sd3.5"), "", "Stability 专用端点保持原类型（不改成 image_openai）");
  const p4 = { id: "pw", type: "image_stability", models: ["gpt-4o"] };
  EQ(MK.correctedTypeForModel(cfg, p4, "gpt-4o"), "text_openai", "图像专用端点上选了文本模型 → 纠回 text_openai");
  EQ(MK.providerTypeForKind("image_mj", "image"), "image_mj", "Midjourney 保持自身类型");
  EQ(MK.providerTypeForKind("text_openai", "image"), "image_openai", "文本类型 + 图像形态 = OpenAI 兼容图像接口");
  EQ(MK.providerTypeForKind(undefined, "text"), "text_openai", "缺类型按文本兜底");
  EQ(MK.modelKindForNode({ kind: "proc_image" }), "image", "proc_image 要图像模型");
  EQ(MK.modelKindForNode({ kind: "proc_text" }), "text", "proc_text 要文本模型");
}

/* ═════════ [5] 全渲染层同源接入点 ═════════ */
console.log("\n[5] 接入点：设置页 / 节点设置 / 体检 / 运行期都走同一份判定");
{
  const SETTINGS = read("renderer/app-settings.js");
  const CANVAS = read("renderer/app-canvas.js");
  const APPJS = read("renderer/app.js");
  const NODES = read("renderer/app-nodes.js");
  const HTML = read("renderer/index.html");
  const CSS = read("renderer/css/components.css");

  HAS(HTML, 'src="app-model-kind.js"', "index.html 接入 app-model-kind.js");
  const iKind = HTML.indexOf('src="app-model-kind.js"');
  const iApp = HTML.indexOf('src="app.js"');
  ok(iKind > iApp, "app-model-kind.js 排在 app.js 之后（同层调用期取用）");

  HAS(SETTINGS, "modelKindOf(S.config", "设置页模型行用 modelKindOf 取形态");
  HAS(SETTINGS, "modelKindOverride(S.config", "设置页区分「手工指定 / 自动识别」");
  HAS(SETTINGS, "S.config.modelKinds", "徽标点击写进 config.modelKinds");
  HAS(SETTINGS, "自动识别模型类型", "模型列表有「自动识别模型类型」按钮（清覆盖、回自动）");
  HAS(SETTINGS, "按模型纠正类型", "服务商卡片有「按模型纠正类型」按钮");
  HAS(SETTINGS, "providerKinds(S.config, prov)", "服务商卡片显示形态（文本 / 图像 / 混合）");
  HAS(SETTINGS, "defaultKindOfProvider", "手动添加服务商时按模型识别类型");
  HAS(SETTINGS, "inferModelKind", "添加服务商（目录 / 手动）按模型形态判定");

  HAS(fnBody(CANVAS, "nsProviderModelFields"), "providerHasKind", "节点设置按形态分流服务商");
  HAS(fnBody(CANVAS, "nsProviderModelFields"), "modelsOfKind", "节点设置模型下拉只列该形态模型");
  HAS(CANVAS, "（形态不符）", "节点里存着反形态模型时标注原因（不静默改值）");

  HAS(APPJS, "function apiProvidersForKind(kind)", "app.js 有 apiProvidersForKind 统一入口");
  const apiP = fnBody(APPJS, "apiProvidersForKind");
  HAS(apiP, "providerHasKind(S.config, p, want)", "apiProvidersForKind 走形态判定（不再只看 type）");
  HAS(fnBody(APPJS, "apiProviderValid"), "providerHasKind", "apiProviderValid 走形态判定");
  HAS(fnBody(APPJS, "nodeModelGate"), "modelsOfKind(S.config, p,", "无模型判据按形态取该服务商的模型表");
  HAS(fnBody(APPJS, "assignDefaultProvider"), "modelsOfKind(S.config, prov, \"image\")", "新图像节点默认模型取该形态的第一个");

  HAS(NODES, "correctedTypeForModel", "运行期按所选模型纠服务商类型");
  HAS(NODES, "服务商类型与所选模型不符，已按模型纠正为", "纠偏时给用户明确提示（不静默）");
  HAS(NODES, "providerHasKind(S.config, p, \"text\")", "识图候选只从含文本模型的服务商里挑");

  HAS(CSS, ".pk-badge", "模型形态徽标有专属样式");
  HAS(CSS, ".pf-kind", "服务商形态行有样式");

  const I18N = read("renderer/i18n.js");
  for (const s of [
    "自动识别模型类型",
    "按模型纠正类型",
    "图像模型",
    "文本模型",
    "（形态不符）",
    "服务商类型与所选模型不符，已按模型纠正为",
  ])
    HAS(I18N, s, "i18n 收词条：" + s);
}

/* ═════════ [6] 纯函数段：不依赖 DOM / 全局 S ═════════ */
console.log("\n[6] app-model-kind.js 是纯函数段（可单独 require）");
{
  const src = read("renderer/app-model-kind.js");
  ok(src.indexOf("document.") < 0, "不碰 DOM（document 一个都没有）");
  ok(src.indexOf("window.") < 0, "不依赖 window");
  ok(
    !/^var S\s*=|^let S\s*=|^const S\s*=/m.test(src),
    "不声明全局 S（配置一律按参数传入）",
  );
  ok(!!MK.providerKinds && typeof MK.providerKinds === "function", "CommonJS 导出可用（测试与工具可直接 require）");
}

console.log(
  (fails ? "\nFAILED " + fails + " / " + checks + " checks" : "\nALL OK  " + checks + " checks") + "\n",
);
process.exit(fails ? 1 : 0);

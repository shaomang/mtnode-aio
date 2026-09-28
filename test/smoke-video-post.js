"use strict";
/* 视频后处理（超分 / 补帧）从 H3 生成链拆出后的独立节点 —— 链路级冒烟
 *   node test/smoke-video-post.js
 *
 * 需求口径：超分 / 补帧不再跟着 Minimax H3 生成一起跑（生成链只出原生片），
 * 改成画布上两个独立节点 video_upscale / video_interp → 宿主 IPC h3:postProcess
 * （kind=upscale 走 Real-ESRGAN x4 + 目标长边；kind=interp 走 RIFE 补帧）。
 *
 * 覆盖：
 *   [1] 宿主（h3/main-h3.js）：h3:postProcess 注册 + buildPostWorkflow 真跑（两 kind 成图）
 *   [2] 生成链无后处理注入：generateVideo / runCustomWorkflow / buildH3Workflow 都不出 post 阶段
 *   [3] 24G 安全档默认值：resolvePostOptions 逐档钉死（超分逐帧 / RIFE 逐帧 + 极小缓存）
 *   [4] preload / preload-h3 双桥暴露
 *   [5] 两个 kind 注册：NODE_DEFAULTS + 设置表单 + 菜单成员
 *   [6] 端子契约 / 媒体类型 / .mp4（渲染层真函数：inputCount · outputCount · slot 表 · 媒体判定）
 *   [7] 渲染层不再下发 post*（buildVideoGenRunParams）+ 执行分发走媒体串行链
 *   [8] i18n 词条齐（中英双向）
 *   [9] 指南 / 索引齐
 *   [10] 产物判定齐：history 里 LoadVideo 的「输入预览」不得当成成片（补帧 output_missing 根因）
 *   [11] 内存闸：超分把 64G 内存跑满（显存空着）—— 后端 --cache-ram + 提交前按帧数估峰值自动降档
 *   [12] 超分倍率 x2：输出 = 源 × 2，本机没 x2 权重也成立（内存口径按模型算）
 *   [13] 流式超分：16G 可用的逐帧分块链（stream_upscale.py + resolvePostEngine 选路 +
 *        流式档不降档 + 前端默认值 / i18n / 指南同步）
 *   [14] 流式补帧：16G 可用的逐帧链（stream_interp.py + resolvePostEngine 选路 +
 *        流式档不降档 + 前端默认值 / i18n / 指南同步）
 *
 * 替身只替与判定无关的部分：DOM / 落盘 / 连线取值；成图、参数归一、端子与媒体判定全是源码真函数。
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
function section(t) {
  console.log("\n── " + t + " ──");
}
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const has = (src, needle, msg) => ok(String(src).indexOf(needle) >= 0, msg + (String(src).indexOf(needle) >= 0 ? "" : "（缺 " + show(needle) + "）"));
const hasnt = (src, needle, msg) => ok(String(src).indexOf(needle) < 0, msg + (String(src).indexOf(needle) < 0 ? "" : "（仍含 " + show(needle) + "）"));
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");

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
const constBlock = (src, name) => {
  const m = new RegExp("\\nconst " + name + " = \\{[\\s\\S]*?\\n\\};", "m").exec(src);
  if (!m) throw new Error("找不到常量块：" + name);
  return m[0].trim();
};
/* 剥掉注释：源码级「某标识符已彻底退场」判定要把历史说明排除掉 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "*") {
      const j = src.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === "/" && c2 === "/") {
      const j = src.indexOf("\n", i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const appSrc = read("renderer/app.js");
const nodesSrc = read("renderer/app-nodes.js");
const canvasSrc = read("renderer/app-canvas.js");
const mainH3Src = read("h3/main-h3.js");
const preloadSrc = read("preload.js");
const h3PreloadSrc = read("h3/preload-h3.js");
const i18nSrc = read("renderer/i18n.js");

/* ═══════════ [1] 宿主：h3:postProcess + buildPostWorkflow 真跑 ═══════════ */
section("[1] 宿主 h3/main-h3.js：h3:postProcess 注册 + buildPostWorkflow 两 kind 成图");
const host = {};
{
  vm.runInNewContext(
    [
      constBlock(mainH3Src, "POST_MODELS"),
      constBlock(mainH3Src, "POST_SAFE_DEFAULTS"),
      `const POST_UPSCALE_SCALES = ${/const POST_UPSCALE_SCALES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      `const POST_TARGET_LONG_SIDE_MIN = ${/const POST_TARGET_LONG_SIDE_MIN = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_MODEL_EXTS = ${/const POST_MODEL_EXTS = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      `const POST_OOM_RE = ${mainH3Src.split("const POST_OOM_RE =")[1].split("\n").find((l) => l.trim().startsWith("/")).trim()};`,
      /* 流式超分档位的常量（resolvePostOptions / downgradePostOptions 真跑要用） */
      `const POST_STREAM_SCRIPT = ${JSON.stringify(/const POST_STREAM_SCRIPT = "([^"]+)"/.exec(mainH3Src)[1])};`,
      `const POST_STREAM_DEFAULT_TILE = ${/const POST_STREAM_DEFAULT_TILE = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_STREAM_DEFAULT_OVERLAP = ${/const POST_STREAM_DEFAULT_OVERLAP = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_STREAM_DEFAULT_CRF = ${/const POST_STREAM_DEFAULT_CRF = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_STREAM_DEFAULT_PRESET = ${JSON.stringify(/const POST_STREAM_DEFAULT_PRESET = "([^"]+)"/.exec(mainH3Src)[1])};`,
      `const POST_STREAM_MIN_FP16_VRAM_GB = ${/const POST_STREAM_MIN_FP16_VRAM_GB = (\d+)/.exec(mainH3Src)[1]};`,
      extract(mainH3Src, ["postDimsForLongSide", "normalizeUpscaleModelName", "normalizeUpscaleScale", "upscaleFactorOfModel", "pickNativeX2Model", "upscaleOutputLongSide", "resolvePostOptions", "downgradePostOptions", "isPostOomError", "buildPostWorkflow", "resolvePostEngine"]),
    ].join("\n"),
    host,
    { filename: "video-post-host-extract.js" },
  );

  has(mainH3Src, 'ipcMain.handle("h3:postProcess"', "主进程注册 IPC 通道 h3:postProcess");
  has(mainH3Src, "async function postProcessVideo(", "宿主有独立后处理任务 postProcessVideo");
  has(mainH3Src, "resolveUpscaleModelForComfy(comfy, opts.model)", "提交前按真实 upscale_models 目录校正模型名（找不到就带可用清单报错）");
  ok(typeof host.buildPostWorkflow === "function", "buildPostWorkflow 抽到真实实现");

  const up = host.buildPostWorkflow({ kind: "upscale", videoPath: "E:/in/a.mp4", fps: 24, width: 1280, height: 720, upscale: { model: "RealESRGAN_x4plus.pth", targetLongSide: 3840, perBatch: 1, tile: 0, lowVram: true } });
  const upClasses = Object.values(up).map((n) => n.class_type);
  ok(upClasses.indexOf("LoadVideo") >= 0 && upClasses.indexOf("GetVideoComponents") >= 0, "超分图从源视频取帧（LoadVideo → GetVideoComponents）");
  ok(upClasses.indexOf("UpscaleModelLoader") >= 0 && upClasses.indexOf("ImageUpscaleWithModelBatched") >= 0, "超分图含 Real-ESRGAN x4 上采样链");
  ok(upClasses.indexOf("ImageScale") >= 0, "有源分辨率时按目标长边追加 ImageScale");
  ok(upClasses.indexOf("CreateVideo") >= 0 && upClasses.indexOf("SaveVideo") >= 0, "超分图回 CreateVideo（带音轨）+ SaveVideo");
  ok(upClasses.indexOf("RIFE VFI") < 0, "超分图不含补帧节点（两类互不串跑）");
  const scaleNode = Object.values(up).find((n) => n.class_type === "ImageScale");
  eqNum(scaleNode.inputs.width, host.postDimsForLongSide(1280, 720, 3840)[0], "ImageScale 宽按目标长边等比取偶");

  /* 回归：老节点存的模型名不带扩展名 → ComfyUI 判 model_name value_not_in_list 拒图 */
  const upLoader = (mm) => Object.values(host.buildPostWorkflow({ kind: "upscale", videoPath: "E:/in/a.mp4", fps: 24, upscale: mm })).find((n) => n.class_type === "UpscaleModelLoader");
  eqNum(upLoader({ model: "RealESRGAN_x4plus" }).inputs.model_name, "RealESRGAN_x4plus.pth", "无扩展名模型名自动补 .pth（Combo 校验口径）");
  eqNum(upLoader({ model: "RealESRGAN_x4plus.pth" }).inputs.model_name, "RealESRGAN_x4plus.pth", "已带 .pth 不重复追加");
  eqNum(upLoader({}).inputs.model_name, "RealESRGAN_x4plus.pth", "没填模型走随包默认（含扩展名）");

  const ip = host.buildPostWorkflow({ kind: "interp", videoPath: "E:/in/b.mp4", fps: 24, interp: { multiplier: 2, clearCacheEvery: 2, batchSize: 1, scaleFactor: 1 } });
  const ipClasses = Object.values(ip).map((n) => n.class_type);
  ok(ipClasses.indexOf("RIFE VFI") >= 0, "补帧图含 RIFE VFI");
  ok(ipClasses.indexOf("UpscaleModelLoader") < 0, "补帧图不含超分节点（两类互不串跑）");
  const rife = Object.values(ip).find((n) => n.class_type === "RIFE VFI");
  eqNum(rife.inputs.multiplier, 2, "RIFE multiplier 按节点参数下发");
  eqNum(rife.inputs.batch_size, 1, "RIFE batch_size = 1（24G 逐帧）");
  const createVid = Object.values(ip).find((n) => n.class_type === "CreateVideo");
  eqNum(createVid.inputs.fps, 48, "补帧后 CreateVideo 的 fps 按倍数重算（24 → 48）");
  eqNum(Object.values(ip).find((n) => n.class_type === "CreateVideo").inputs.audio[0], String(Object.keys(ip).find((k) => ip[k].class_type === "GetVideoComponents")), "音轨从 GetVideoComponents 原样带回");
  let threw = "";
  try { host.buildPostWorkflow({ kind: "upscale" }); } catch (e) { threw = String(e && e.message); }
  eqNum(threw, "post_video_missing", "缺源视频路径直接抛 post_video_missing");
}

/* ═══════════ [2] 生成链无后处理注入 ═══════════ */
section("[2] 生成链（内置 / 自建）都不再注入后处理阶段");
{
  const genSlice = mainH3Src.split("async function generateVideo(params)")[1].split("async function runCustomWorkflow")[0];
  ok(genSlice.length > 2000, "取到 generateVideo 整段（" + genSlice.length + " 字符）");
  hasnt(stripComments(genSlice), 'phase: "post"', "生成段不发 phase:'post' 进度");
  hasnt(stripComments(genSlice), "buildPostWorkflow", "生成段不追加后处理图");
  hasnt(stripComments(genSlice), "postEnabled", "生成段不读老的 postEnabled（残留字段一律忽略）");
  const h3wfBody = stripComments(fnBody(mainH3Src, "buildH3Workflow"));
  hasnt(h3wfBody, "RIFE", "内置生成图不含 RIFE 补帧节点");
  hasnt(h3wfBody, "Upscale", "内置生成图不含 Real-ESRGAN 超分节点");
  hasnt(h3wfBody, "post4kDims", "内置生成图不再做 4K 后处理尺寸换算");
  const customBranch = mainH3Src.split("async function runCustomWorkflow")[1].split("async function cancelGenerate")[0];
  hasnt(stripComments(customBranch), 'phase: "post"', "自建执行段不发 phase:'post'");
  const postSlice = mainH3Src.split("async function postProcessVideo(params)")[1].split("ipcMain.handle(\"h3:postProcess\"")[0];
  has(postSlice, 'phase: "post"', "后处理任务自己发 phase:'post' 进度（节点自己的进度条）");
}

/* ═══════════ [3] 默认档位：流式超分默认 + 两档 OOM 降档（流式 / 图兜底） ═══════════ */
section("[3] 默认档位（resolvePostOptions 真跑 + 首次 OOM 按引擎降一档）");
{
  const up0 = host.resolvePostOptions("upscale", {});
  eqArr(
    up0,
    {
      model: "RealESRGAN_x4plus.pth",
      scale: 4,
      targetLongSide: 3840,
      perBatch: 1,
      tile: 256,
      overlap: 16,
      precision: "fp32",
      engine: "stream",
      lowVram: true,
    },
    "超分默认：x4plus · 倍率 x4 · 长边 3840 · 流式档 · 安全档开（fp32 + tile 256）",
  );
  /* 流式档参数：tile 沿用节点值，精度按 lowVram / 显存决定，engine 只认显式 graph */
  eqNum(host.resolvePostOptions("upscale", { lowVram: false }).tile, 512, "关掉安全档：默认分块回到 512");
  eqNum(host.resolvePostOptions("upscale", { lowVram: false }).precision, "fp16", "关掉安全档且显存够：精度 fp16");
  eqNum(host.resolvePostOptions("upscale", { tile: 1024, lowVram: true }).tile, 1024, "节点显式给的分块大小原样沿用（不因安全档减半）");
  eqNum(host.resolvePostOptions("upscale", { vramGb: 4, lowVram: false }).precision, "fp32", "宿主报来显存 < 6G → 落 fp32");
  eqNum(host.resolvePostOptions("upscale", { vramGb: 24, lowVram: false }).precision, "fp16", "显存充足 → fp16");
  eqNum(host.resolvePostOptions("upscale", { precision: "fp16", lowVram: true }).precision, "fp16", "节点显式指定精度时以节点为准");
  eqNum(host.resolvePostOptions("upscale", { engine: "graph" }).engine, "graph", "显式 engine=graph 才回旧图链");
  eqNum(host.resolvePostOptions("upscale", { engine: "nonsense" }).engine, "stream", "非法引擎值退回流式（默认）");
  eqNum(host.resolvePostOptions("upscale", { overlap: 24 }).overlap, 24, "overlap 可调（默认 16）");
  /* 模型名一律归一（画布上老节点存的是不带扩展名的名字） */
  eqNum(host.resolvePostOptions("upscale", { model: "RealESRGAN_x4plus" }).model, "RealESRGAN_x4plus.pth", "归一：不带扩展名 → 补 .pth");
  eqNum(host.resolvePostOptions("upscale", { model: "4x-UltraSharp.safetensors" }).model, "4x-UltraSharp.safetensors", "归一：别的扩展名原样保留");
  eqNum(host.normalizeUpscaleModelName("E:\\ComfyUI\\models\\upscale_models\\RealESRGAN_x4plus"), "RealESRGAN_x4plus.pth", "归一：误填整条路径时只取文件名并补扩展名");
  eqNum(host.resolvePostOptions("upscale", { lowVram: false, perBatch: 4 }).perBatch, 4, "关掉安全档才按 perBatch 批量");
  eqNum(host.resolvePostOptions("upscale", { lowVram: true, perBatch: 4 }).perBatch, 1, "安全档开着：perBatch 强制 1（忽略请求值）");
  eqNum(host.resolvePostOptions("upscale", { targetLongSide: 10 }).targetLongSide, 1280, "目标长边下限钳到 1280");
  const ip0 = host.resolvePostOptions("interp", {});
  eqArr(
    ip0,
    {
      multiplier: 2,
      clearCacheEvery: 2,
      batchSize: 1,
      scaleFactor: 1,
      maxLongSide: 0,
      precision: "fp32",
      engine: "stream",
      lowVram: true,
    },
    "补帧默认：2x · 逐帧 · 流式档 · 安全档开（fp32 + 不预缩放）",
  );
  eqNum(host.resolvePostOptions("interp", { batchSize: 8 }).batchSize, 1, "补帧 24G 安全档：batch_size 恒为 1");
  eqNum(host.resolvePostOptions("interp", { multiplier: 99 }).multiplier, 4, "补帧倍数钳到 4");
  /* 流式补帧档参数：精度按 lowVram / 显存决定，maxLongSide 缺省 0（不预缩放），engine 只认显式 graph */
  eqNum(host.resolvePostOptions("interp", { lowVram: false }).precision, "fp16", "关掉安全档且显存够：补帧精度 fp16");
  eqNum(host.resolvePostOptions("interp", { vramGb: 4, lowVram: false }).precision, "fp32", "宿主报来显存 < 6G → 补帧落 fp32");
  eqNum(host.resolvePostOptions("interp", { precision: "fp16", lowVram: true }).precision, "fp16", "补帧精度节点显式指定时以节点为准");
  eqNum(host.resolvePostOptions("interp", { engine: "graph" }).engine, "graph", "补帧显式 engine=graph 才回旧图链");
  eqNum(host.resolvePostOptions("interp", { engine: "nonsense" }).engine, "stream", "补帧非法引擎值退回流式（默认）");
  eqNum(host.resolvePostOptions("interp", { maxLongSide: 1280 }).maxLongSide, 1280, "补帧预缩放长边沿用节点值（0 = 不预缩放）");
  /* 流式档 OOM 降档：只动 tile 与精度，不降画质（目标长边 / 倍率一字不动） */
  const down = host.downgradePostOptions("upscale", up0);
  eqNum(down.tile, 128, "OOM 降档（流式）：tile 减半（256 → 128）");
  eqNum(down.precision, "fp32", "OOM 降档（流式）：精度落 fp32");
  eqNum(down.targetLongSide, 3840, "OOM 降档（流式）：目标长边不动（内存与它无关）");
  eqNum(down.scale, 4, "OOM 降档（流式）：倍率不动");
  eqNum(down.engine, "stream", "OOM 降档（流式）：仍在流式档");
  eqNum(host.downgradePostOptions("upscale", { engine: "stream", tile: 512, precision: "fp16" }).tile, 256, "OOM 降档：显式 fp16 + tile 512 → 256");
  eqNum(host.downgradePostOptions("upscale", { engine: "stream", tile: 64, precision: "fp16" }).tile, 64, "tile 有下限 64（不出现 0）");
  /* 图兜底档 OOM 降档：老口径一字未变 */
  const downG = host.downgradePostOptions("upscale", {
    model: "RealESRGAN_x4plus.pth",
    scale: 4,
    targetLongSide: 3840,
    perBatch: 2,
    tile: 512,
    overlap: 16,
    precision: "fp16",
    engine: "graph",
    lowVram: false,
  });
  eqNum(downG.targetLongSide, 1920, "OOM 降档（图兜底）：目标长边减半");
  eqNum(downG.perBatch, 1, "OOM 降档（图兜底）：强制逐帧");
  eqNum(downG.engine, "graph", "OOM 降档（图兜底）：仍在图档");
  eqNum(host.downgradePostOptions("interp", { multiplier: 4, clearCacheEvery: 4, batchSize: 1, scaleFactor: 1 }).multiplier, 2, "OOM 降档：补帧退回 2x");
  /* 流式补帧档 OOM 降档：只落 fp32（倍率不动，避免白降画质） */
  const downIp = host.downgradePostOptions("interp", host.resolvePostOptions("interp", {}));
  eqNum(downIp.precision, "fp32", "OOM 降档（流式补帧）：精度落 fp32");
  eqNum(downIp.multiplier, 2, "OOM 降档（流式补帧）：倍率不动");
  eqNum(downIp.engine, "stream", "OOM 降档（流式补帧）：仍在流式档");
  eqNum(downIp.maxLongSide, 0, "OOM 降档（流式补帧）：没给预缩放长边就保持 0（不凭空缩放）");
  eqNum(
    host.downgradePostOptions("interp", { engine: "stream", precision: "fp16", maxLongSide: 1920, multiplier: 4 }).maxLongSide,
    1440,
    "OOM 降档（流式补帧）：显式给过预缩放长边再降一档（1920 → 1440）",
  );
  eqNum(
    host.downgradePostOptions("interp", { engine: "stream", precision: "fp16", maxLongSide: 600 }).maxLongSide,
    640,
    "OOM 降档（流式补帧）：预缩放长边有下限 640",
  );
  ok(host.isPostOomError(new Error("CUDA error: out of memory")), "认「显存不足」族 OOM");
  ok(!host.isPostOomError(new Error("CUDA error: device-side assert")), "别的 CUDA 报错不降档（不掩盖真问题）");
}

/* ═══════════ [4] preload / preload-h3 双桥 ═══════════ */
section("[4] preload / h3 preload 双桥暴露 h3:postProcess");
{
  has(preloadSrc, "h3PostProcess:", "主窗口 preload 暴露 window.api.h3PostProcess");
  has(preloadSrc, "invoke('h3:postProcess'", "主窗口 preload 桥到 h3:postProcess");
  has(h3PreloadSrc, "postProcess:", "H3 管理窗 preload 暴露 postProcess");
  has(h3PreloadSrc, 'invoke("h3:postProcess"', "H3 管理窗桥到 h3:postProcess");
  has(fnBody(nodesSrc, "playVideoPostNode"), "h3PostProcess", "画布后处理节点调用 window.api.h3PostProcess");
}

/* ═══════════ [5] 两个 kind 注册：NODE_DEFAULTS + 表单 + 菜单 ═══════════ */
section("[5] video_upscale / video_interp：注册 / 设置表单 / 菜单成员");
{
  const ndBlock = (() => {
    const at = appSrc.indexOf("const NODE_DEFAULTS = {");
    const end = appSrc.indexOf("\n};", at);
    return at < 0 ? "" : appSrc.slice(at, end);
  })();
  const defOf = (kind) => (ndBlock.match(new RegExp(kind + ":\\s*\\{([\\s\\S]*?)\\n  \\},")) || [null, ""])[1];
  const up = defOf("video_upscale");
  const ip = defOf("video_interp");
  ok(up && ip, "NODE_DEFAULTS 里有 video_upscale / video_interp");
  has(up, 'title: "视频超分节点"', "超分节点默认标题");
  has(ip, 'title: "视频补帧节点"', "补帧节点默认标题");
  ["model", "targetLongSide", "perBatch", "tile", "lowVram", "attempts", "outputPath"].forEach((f) => has(up, f + ":", "超分默认值带 " + f));
  ["multiplier", "clearCacheEvery", "batchSize", "scaleFactor", "lowVram", "attempts", "outputPath"].forEach((f) => has(ip, f + ":", "补帧默认值带 " + f));
  eqNum(/lowVram: true/.test(up), true, "超分默认 24G 安全档开（lowVram: true）");
  eqNum(/lowVram: true/.test(ip), true, "补帧默认 24G 安全档开（lowVram: true）");
  /* 节点默认值与表单选项都必须带扩展名：model_name 的候选是 upscale_models 里的文件名 */
  has(up, 'model: "RealESRGAN_x4plus.pth"', "超分节点默认模型名带 .pth（新节点不会再存不带扩展名的值）");
  has(appSrc, "function videoUpscaleModelValue(", "渲染层有统一的超分模型名归一函数");
  has(canvasSrc, "VIDEO_UPSCALE_MODEL_DEFAULT,", "超分模型下拉的选项值取带扩展名的常量（不再写字面量）");
  has(canvasSrc, "videoUpscaleModelValue(node.model)", "下拉按归一值选中 / 回写（老节点存的不带扩展名也能命中选项）");

  has(canvasSrc, 'registerNodeSettingsForm("video_upscale"', "画布登记 video_upscale 设置表单");
  has(canvasSrc, 'registerNodeSettingsForm("video_interp"', "画布登记 video_interp 设置表单");
  ok(/registerNodeSettingsForm\("video_upscale"[\s\S]{0,4000}?registerNodeSettingsForm\("video_interp"/.test(canvasSrc), "两张表单相邻成块（同一族）");

  const vMenu = appSrc.slice(appSrc.indexOf('ctxSubmenu(I18n.t("视频生成")'), appSrc.indexOf('ctxSubmenu(I18n.t("音频生成")'));
  ok(vMenu.length > 200, "取到「视频生成」子菜单整块");
  ok(/ctxKindItem\(\s*"video_upscale"/.test(vMenu), "菜单含 video_upscale 成员");
  ok(/ctxKindItem\(\s*"video_interp"/.test(vMenu), "菜单含 video_interp 成员");
  has(vMenu, "独立后处理", "菜单文案写明「独立后处理」");
}

/* ═══════════ [6] 端子契约 / 媒体类型 / .mp4（渲染层真函数） ═══════════ */
section("[6] 端子（2 入 / 2 出 · 端口0 控制）· 媒体类型 video · 输出 .mp4");
const R = {};
{
  const S = { wf: { nodes: [], wires: [] }, config: {} };
  const sandbox = {
    S,
    console,
    Math,
    JSON,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    I18n: { t: (s) => String(s) },
    I18n_t: null,
    /* 与判定无关的替身 */
    isSaveNode: () => false,
    isExecEnd: () => false,
    isFnToolNode: () => false,
    isExecStart: () => false,
    allWiresTo: () => [],
    wireFromIsControl: () => false,
    nodeById: () => null,
    valueForInput: () => null,
    wiresTo: () => [],
    isControlKind: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      "const SAVE_EXT = { text: '.md', image: '.png', audio: '.wav', video: '.mp4', pdf: '.pdf' };",
      extract(appSrc, [
        "saveExtForMedia",
        "isVideoPostKind",
        "videoPostInputCount",
        "videoPostSlotMeta",
        "inputCount",
        "outputCount",
        "mediaGenExt",
        "inferMediaFromSource",
      ]),
    ].join("\n"),
    sandbox,
    { filename: "video-post-renderer-extract.js" },
  );
  const G = (n) => vm.runInContext("(typeof " + n + " === 'undefined' ? null : " + n + ")", sandbox);
  Object.assign(R, { G, sandbox });

  const up = { id: "u1", kind: "video_upscale" };
  const ip = { id: "i1", kind: "video_interp" };
  eqNum(G("inputCount")(up), 2, "超分输入端子 2 个（端口0 控制 · 端口1 源视频）");
  eqNum(G("inputCount")(ip), 2, "补帧输入端子 2 个（同上）");
  eqNum(G("outputCount")(up), 2, "超分输出端子 2 个（端口0 视频 · 端口1 控制）");
  eqNum(G("outputCount")(ip), 2, "补帧输出端子 2 个（同上）");
  eqArr([0, 1, 2].map((i) => G("videoPostSlotMeta")(up, i).kind), ["ctrl", "video", "text"], "slot 表：0=控制 · 1=源视频 · 2+=可选素材");
  eqArr([0, 1, 2].map((i) => G("videoPostSlotMeta")(up, i).label), ["控制", "V", "M1"], "slot 标签：控制 / V（源视频）/ M1…（素材）");
  eqNum(G("mediaGenExt")(up), ".mp4", "超分输出后缀 = .mp4（视频族）");
  eqNum(G("mediaGenExt")(ip), ".mp4", "补帧输出后缀 = .mp4（视频族）");
  eqNum(G("saveExtForMedia")("video"), ".mp4", "SAVE_EXT.video = .mp4（单一真源）");
  eqNum(G("inferMediaFromSource")(up, 0), "video", "超分输出按视频判定");
  eqNum(G("inferMediaFromSource")(ip, 0), "video", "补帧输出按视频判定");

  /* 源码级：控制线只连端口0 · 端口1 收视频/文本 · 端口2+ 收素材 */
  has(nodesSrc, "后处理节点控制输入端子为端口 0", "控制线只落端口 0（连别的号报错并指路）");
  has(nodesSrc, "源视频端子需要视频文件路径或文本来源", "端口 1 只收视频 / 文本来源");
  has(nodesSrc, "素材端子需要文本或媒体文件路径", "端口 2+ 收素材（文本 / 媒体路径）");
  has(appSrc, "isVideoPostKind(from)", "端口 1 控制/数据由 isVideoPostKind 分流");
}

/* ═══════════ [7] 渲染层不再下发 post* + 执行分发 ═══════════ */
section("[7] 渲染层：生成节点不再下发 post* · 后处理节点走媒体串行链");
{
  const genParams = stripComments(fnBody(nodesSrc, "buildVideoGenRunParams"));
  hasnt(genParams, "postEnabled", "buildVideoGenRunParams 不下发 postEnabled");
  hasnt(genParams, "postInterp", "buildVideoGenRunParams 不下发 postInterp*");
  hasnt(genParams, "postPerBatch", "buildVideoGenRunParams 不下发 postPerBatch");
  has(fnBody(nodesSrc, "buildVideoPostRunParams"), "kind: node.kind === \"video_interp\" ? \"interp\" : \"upscale\"", "后处理节点按 kind 组装 h3:postProcess 参数");
  has(fnBody(nodesSrc, "buildVideoPostRunParams"), "model: videoUpscaleModelValue(node.model)", "下发的超分模型名走归一（不再把不带扩展名的值直接发给 ComfyUI）");
  const playBody = fnBody(nodesSrc, "playNodeBody");
  has(playBody, "playVideoPostNode(node, quiet)", "playNodeBody 分发到 playVideoPostNode");
  has(playBody, "runMediaGenSerial(node, () => playVideoPostNode(node, quiet))", "后处理节点走媒体串行链（同一时刻只一个音视频任务）");
  has(fnBody(nodesSrc, "isMediaGenNode"), "isVideoPostKind(node)", "isMediaGenNode 认识两类后处理节点");
  has(appSrc, "isVideoPostKind(n)", "outputCount / 端子表按 isVideoPostKind 判两类");
  has(nodesSrc, "视频生成插件未就绪", "宿主桥缺失时给可读提示");
}

/* ═══════════ [8] i18n 词条齐 ═══════════ */
section("[8] i18n：两 kind 的中文文案在 en 口径逐条命中");
{
  const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));
  const KEYS = [
    "视频超分", "视频补帧", "视频超分节点", "视频补帧节点",
    "视频超分（Real-ESRGAN x4 / x2 超分 · 独立后处理）", "视频补帧（RIFE 补帧 · 独立后处理）",
    "超分模型 / 倍率 / 目标长边 / 分块流式",
    "补帧倍率 / 精度 / 逐帧流式",
    "24G 安全档", "低显存安全档（强制逐帧）", "低显存安全档",
    "超分倍率", "x4 倍率（Real-ESRGAN x4plus · 画质最好）",
    "x2 倍率（输出只放大 2 倍 · 更快更省显存）",
    "输出相对源视频放大的倍数：x2 = 长宽各翻一倍（更快更省显存）；x4 = Real-ESRGAN 原生倍率；逐帧分块流式下倍率不再受内存限制",
    "输出长边像素上限（1280–7680）；逐帧分块流式下不再受内存限制；x2 倍率时还会被「源长边 × 2」封顶，源分辨率未知时不缩放",
    "目标长边（像素）", "逐帧批量 per_batch", "分块 tile（像素）",
    "每次交给超分模型的帧数；低显存安全档保持 1（流式档逐帧处理，此项只影响图兜底链）",
    "分块 fp16 省显存，16G 机器也能跑 15 秒片；关闭后按 per_batch 批量，更快但更吃显存",
    "流式超分的分块大小（像素）；显存只跟它有关，512 适合 16G 机器，0 = 后端默认 512",
    "逐帧分块流式超分：常驻内存只与一个分块有关，与视频时长无关，16G 机器也能跑 15 秒级视频；4K（长边 3840）输出不再受内存限制。",
    "补帧倍率", "清缓存间隔（帧）", "逐帧批量 batch_size", "缩放系数 scale_factor",
    "每 N 帧清一次缓存；流式档每帧算完即写盘，此项只影响图兜底链",
    "每次交给 RIFE 的帧数；流式档逐帧处理，此项只影响图兜底链",
    "RIFE 内部缩放系数（1.0=原分辨率）；流式档同样生效，不改变输出分辨率",
    "低精度 fp16 省显存，16G 机器也能跑 15 秒片；关闭后按更高精度跑，更快但更吃显存",
    "逐帧流式补帧：常驻内存只与相邻两帧有关，与视频时长无关，16G 机器也能跑 15 秒级视频；4x 倍率同样不再受内存限制，只是耗时更长。",
    "请连接源视频输入（端子 V）", "源视频 → 逐帧流式 RIFE 补帧（fps 按倍数重算）",
    "独立后处理 · 执行时自动启停 H3 后端",
  ];
  I18n.setLocale("en");
  const miss = KEYS.filter((k) => !String(I18n.t(k) || "").trim() || I18n.t(k) === k);
  if (miss.length) miss.forEach((k) => console.log("  MISS  " + show(k)));
  eqArr(miss, [], "en 口径下两 kind 全部文案都有译文（" + KEYS.length + " 条）");
  I18n.setLocale("zh");
  eqArr(KEYS.filter((k) => I18n.t(k) !== k), [], "zh 口径原样返回中文真源");
}

/* ═══════════ [9] 指南 / 索引 ═══════════ */
section("[9] 节点指南齐（中英 + 索引）");
{
  const gdir = path.join(__dirname, "..", "guides", "nodes");
  for (const id of ["video_upscale", "video_interp"]) {
    ok(fs.existsSync(path.join(gdir, id + ".md")), "guides/nodes/" + id + ".md 存在");
    ok(fs.existsSync(path.join(gdir, "en", id + ".md")), "guides/nodes/en/" + id + ".md 存在");
  }
  const idx = JSON.parse(read("guides/nodes/index.json"));
  ok(idx.ids.indexOf("video_upscale") >= 0 && idx.ids.indexOf("video_interp") >= 0, "两 kind 已进节点指南索引");
  const up = read("guides/nodes/video_upscale.md");
  const ip = read("guides/nodes/video_interp.md");
  has(up, "Real-ESRGAN", "超分指南写明 Real-ESRGAN");
  has(ip, "RIFE", "补帧指南写明 RIFE");
  has(up + ip, "独立后处理", "指南写明两类是独立后处理节点");
  has(up, "⚙ 设置", "超分指南是跳窗口径");
  has(ip, "⚙ 设置", "补帧指南是跳窗口径");
  has(up, ".mp4", "超分指南写明输出 .mp4");
  has(ip, ".mp4", "补帧指南写明输出 .mp4");
}

/* ═══════════ [10] 产物判定：输入预览 ≠ 成片（补帧 output_missing 根因回归） ═══════════ */
section("[10] 宿主产物判定：history 里把「LoadVideo 的输入预览」和「SaveVideo 的成片」分清楚");
{
  /* 真机形状（ComfyUI comfy_extras/nodes_video.py + execution.py）：
     SaveVideo 与 LoadVideo / LoadImage 的 ui 一律 as_dict() 成 {images:[{filename,subfolder,type}], animated:[true]}
     —— 没有 videos 键；且非产物节点只要返回过 ui 就会进 history。
     补帧图第一步就是 LoadVideo（源视频 upload 进 input/，它回报的文件名 = 上传名），节点编号又最小 →
     「取第一个 mp4」抓到的就是这条 type=input 的预览 → 去 output 根目录找 → output_missing。 */
  const os = require("os");
  const logs = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "h3post-"));
  const comfy = path.join(tmp, "ComfyUI");
  const outRoot = path.join(comfy, "output");
  const realFile = path.join(outRoot, "video", "MiniMax_H3_post_interp2x_00001_.mp4");
  fs.mkdirSync(path.dirname(realFile), { recursive: true });
  fs.writeFileSync(realFile, "x".repeat(128));

  /* vm 只认第二个参数（context 对象）上的全局；options 里的未知键会被静默忽略 */
  const P = {
    fs,
    join: path.join,
    console,
    appendConsole: (m) => logs.push(String(m)),
    /* 与 h3-workflows.js 的产物类判定同口径（isVideoOutputClass） */
    h3wf: {
      isPlainObject: (v) => !!v && typeof v === "object" && !Array.isArray(v),
      isVideoOutputClass: (c) =>
        /(SaveVideo|SaveWebM|SaveMP4|VideoCombine|SaveAnimated|VHS_VideoCombine|SaveVideoFFmpeg|StoreVideo)/i.test(
          String(c || ""),
        ),
    },
  };
  vm.runInNewContext(
    [
      constBlock(mainH3Src, "POST_MODELS"),
      constBlock(mainH3Src, "POST_SAFE_DEFAULTS"),
      `const POST_TARGET_LONG_SIDE_MIN = ${/const POST_TARGET_LONG_SIDE_MIN = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_MODEL_EXTS = ${/const POST_MODEL_EXTS = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      extract(mainH3Src, [
        "postDimsForLongSide",
        "normalizeUpscaleModelName",
        "JOB_VIDEO_EXT_RE",
        "findVideoOutputNodeId",
        "isInputPreviewEntry",
        "findFileUnder",
        "pickJobVideoMeta",
        "comfyOutputPath",
        "collectJobOutputs",
      ]),
    ].join("\n"),
    P,
    { filename: "video-post-meta-extract.js" },
  );

  const interpGraph = host.buildPostWorkflow({
    kind: "interp",
    videoPath: "1_1_1_1.mp4",
    fps: 24,
    interp: { multiplier: 2, clearCacheEvery: 2, batchSize: 1, scaleFactor: 1 },
  });
  const saveId = P.findVideoOutputNodeId(interpGraph);
  eqNum(
    saveId,
    String(Object.keys(interpGraph).find((k) => interpGraph[k].class_type === "SaveVideo")),
    "产物节点认到图里的 SaveVideo（不是编号最小的 LoadVideo）",
  );
  eqNum(P.findVideoOutputNodeId({ 1: { class_type: "LoadVideo" }, 2: { class_type: "CreateVideo" } }), "", "图里没有 Save* 时返回空（交给「没有产物」报错）");

  const hist = {
    1: { images: [{ filename: "1_1_1_1.mp4", subfolder: "", type: "input" }], animated: [true] },
    2: { images: [{ filename: "frame0.png", subfolder: "", type: "input" }] },
    [saveId]: { images: [{ filename: "MiniMax_H3_post_interp2x_00001_.mp4", subfolder: "video", type: "output" }], animated: [true] },
  };
  eqNum(P.pickJobVideoMeta(hist, saveId).filename, "MiniMax_H3_post_interp2x_00001_.mp4", "认 SaveVideo 报的成片（老写法在这里会拿到 input 里的源视频名）");
  eqNum(P.pickJobVideoMeta(hist, saveId).subfolder, "video", "成片带 subfolder=video（老写法拼成 output 根目录 → output_missing）");
  eqNum(P.pickJobVideoMeta(hist, "").filename, "MiniMax_H3_post_interp2x_00001_.mp4", "没给 preferredNodeId 也不按「第一个 mp4」取（取最后一个视频产物）");
  /* 成片在前、输入预览在后：靠 type 过滤成立，不靠枚举顺序 */
  const late = {
    9: { images: [{ filename: "final_cut.mp4", subfolder: "video", type: "output" }] },
    10: { images: [{ filename: "src_upload.mp4", subfolder: "", type: "input" }] },
  };
  eqNum(P.pickJobVideoMeta(late, "").filename, "final_cut.mp4", "输入预览即便排在最后也不会被取走（type 过滤，不是取末尾）");
  eqNum(P.pickJobVideoMeta({ 1: hist[1], 2: hist[2] }, ""), null, "只剩输入预览 → 判「没有产物」，绝不把源视频当成片拷出去");
  eqNum(P.pickJobVideoMeta({ 9: { videos: [{ filename: "a.webm", subfolder: "video", type: "output" }] } }, "").filename, "a.webm", "别家节点用 videos 键（VHS / 旧版）同样认得到");
  eqNum(P.pickJobVideoMeta({ 9: { images: [{ filename: "out.mkv", subfolder: "v", type: "output" }] } }, "").filename, "out.mkv", "mkv 同样算视频产物");
  eqNum(P.collectJobOutputs({ 7: { images: [{ filename: "out.mkv", subfolder: "v", type: "output" }] } }, "").meta.kind, "video", "产物归集里 mkv 归 video（不再当静态图）");
  eqNum(P.isInputPreviewEntry({ type: "INPUT" }), true, "type 大小写不一也认作输入预览");
  eqNum(P.isInputPreviewEntry({ type: "output" }), false, "output 不是预览");

  const r = P.collectJobOutputs(hist, saveId);
  eqNum(r.meta.filename, "MiniMax_H3_post_interp2x_00001_.mp4", "自建工作流收集产物同样跳过输入预览");
  eqArr(r.collected.map((x) => x.filename), ["MiniMax_H3_post_interp2x_00001_.mp4"], "产物清单不再混进输入文件（报错文案不虚报 video×N）");

  eqNum(P.comfyOutputPath(comfy, "MiniMax_H3_post_interp2x_00001_.mp4", "video"), realFile, "回报路径真实存在 → 原样使用");
  eqNum(P.comfyOutputPath(comfy, "MiniMax_H3_post_interp2x_00001_.mp4", ""), realFile, "subfolder 报空也按文件名在 output 下找到实际落点");
  ok(logs.some((l) => l.indexOf("[out]") === 0), "兜底命中会留一条「改用实际落点」日志");
  const missing = P.comfyOutputPath(comfy, "nope.mp4", "video");
  ok(!fs.existsSync(missing) && /nope\.mp4$/.test(missing), "确实没生成的文件：返回后端回报路径，交 output_missing 报错");

  /* 源码级：老的「随手取第一个 mp4」写法必须退场 */
  const waitBody = stripComments(fnBody(mainH3Src, "submitAndWaitComfy"));
  hasnt(waitBody, "vids[0]", "不再无条件取第一个 videos 条目");
  hasnt(waitBody, "const mp4 = imgs.find", "不再按节点顺序取第一个 mp4");
  has(waitBody, "pickJobVideoMeta(outputs, preferredNodeId)", "非 collect 分支统一走 pickJobVideoMeta");
  has(fnBody(mainH3Src, "postProcessVideo"), "preferredNodeId: findVideoOutputNodeId(graph)", "补帧 / 超分提交时上报 SaveVideo 节点");
  has(fnBody(mainH3Src, "generateVideo"), "preferredNodeId: findVideoOutputNodeId(promptGraph)", "生成提交时同样上报（r2v 参考视频是同一族坑）");
  const copyBody = fnBody(mainH3Src, "copyOutputToDir");
  has(copyBody, "comfyOutputPath(comfy, filename, subfolder)", "拷贝前按实际落点定位（子目录层级不一致不再直接失败）");
  has(copyBody, "output_missing:", "仍然找不到时报 output_missing，并附后端回报的产物名");
  has(copyBody, "if (!JOB_VIDEO_EXT_RE.test(destName))", "目标名后缀判定与产物判定共用一份视频扩展名常量");
  has(mainH3Src, "else if (JOB_VIDEO_EXT_RE.test(fn)) kind = \"video\"", "产物归集同样不再漏 mkv");
  has(mainH3Src, 'let outPath = comfyOutputPath(comfy, meta.filename, meta.subfolder || "")', "后处理分支的产物路径走 comfyOutputPath");
  has(mainH3Src, 'comfyOutputPath(comfy, finalVideoMeta.filename, finalVideoMeta.subfolder || "")', "生成分支的产物路径同样");

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ═══════════ [11] 内存闸：超分不得把系统内存跑满（显存空着是正常的） ═══════════ */
/* 合成 mp4 的构造器 / 一条 1920×1080×300 帧样本片：给 [11] 与 [12] 共用
   （两段都在同一份合成器上验「帧数 / 分辨率 → 峰值内存」的口径，别各写一份） */
let POST_MK_MP4 = null;
section("[11] 超分内存闸：后端 --cache-ram + 提交前按真实帧数估峰值自动降档");
{
  /* 合成一个最小可解析的 MP4：ftyp + moov{ mvhd + trak{ tkhd + mdia{ hdlr + minf{ stbl{ stts }}}}}
   * 帧数只从 stts 的 sample_count 求和来（容器级字段，不解码视频）。
   * 字段偏移按 ISO/IEC 14496-12（并与真实文件实测一致）：mvhd v0 的 timescale@+12 / duration@+16，
   * tkhd v0 的 width@+76 / height@+80。 */
  const box = (type, payload) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + payload.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, payload]);
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    return b;
  };
  const fixed1616 = (v) => u32(Math.round(v * 65536));
  const zeros = (n) => Buffer.alloc(n);
  const mkMp4 = (w, h, frames) => {
    const mvhd = box(
      "mvhd",
      Buffer.concat([
        u32(0), u32(0), u32(0), u32(1000), u32(1000), /* ver/flags · ctime · mtime · timescale 1000 · duration 1000 → 1s */
        zeros(4 + 4 + 2 + 2 + 2 + 2), /* reserved · layer · alt · volume · reserved */
        zeros(36), /* matrix */
        zeros(24),
        u32(2),
      ]),
    );
    const tkhd = box(
      "tkhd",
      Buffer.concat([
        u32(0), u32(0), u32(0), u32(1), u32(0), u32(0), /* ver/flags · ctime · mtime · track_id · reserved · duration */
        zeros(8 + 2 + 2 + 2 + 2), /* reserved · layer · alt · volume · reserved → matrix@40, w@76, h@80 */
        /* 单位矩阵（a=d=w=1，其余 0）：横片不是旋转，解析时不得把宽高对调 */
        fixed1616(1), u32(0), u32(0),
        u32(0), fixed1616(1), u32(0),
        u32(0), u32(0), fixed1616(1),
        fixed1616(w),
        fixed1616(h),
      ]),
    );
    const hdlr = box("hdlr", Buffer.concat([u32(0), u32(0), Buffer.from("vide", "latin1"), zeros(12)]));
    /* 一条 stts 记录：sample_count = frames（容器级帧数） */
    const stts = box("stts", Buffer.concat([u32(0), u32(1), u32(frames), u32(40)]));
    const trak = box(
      "trak",
      Buffer.concat([
        tkhd,
        box("mdia", Buffer.concat([hdlr, box("minf", Buffer.concat([box("stbl", stts)]))])),
      ]),
    );
    return Buffer.concat([box("ftyp", Buffer.from("isom", "latin1")), box("moov", Buffer.concat([mvhd, trak]))]);
  };

  const os = require("os");
  POST_MK_MP4 = mkMp4;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "h3ram-"));
  const video = path.join(tmp, "clip.mp4");
  fs.writeFileSync(video, mkMp4(1920, 1080, 300));
  const big = path.join(tmp, "big4k.mp4");
  fs.writeFileSync(big, mkMp4(3840, 2160, 300));
  const frag = path.join(tmp, "frag.mp4");
  fs.writeFileSync(frag, Buffer.concat([box("ftyp", Buffer.from("isom", "latin1")), box("moof", zeros(16)), box("mdat", zeros(64))]));

  const M = { fs, path, join: path.join, os, process, Buffer, Math, Number, String, Object, JSON, console, setTimeout, clearInterval, setInterval };
  vm.runInNewContext(
    [
      `const CONTAINER_BOXES = ${/const CONTAINER_BOXES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      constBlock(mainH3Src, "POST_MODELS"),
      constBlock(mainH3Src, "POST_SAFE_DEFAULTS"),
      `const POST_UPSCALE_SCALES = ${/const POST_UPSCALE_SCALES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      `const POST_TARGET_LONG_SIDE_MIN = ${/const POST_TARGET_LONG_SIDE_MIN = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_RAM_RESERVE_GB = ${/const POST_RAM_RESERVE_GB = (\d+)/.exec(mainH3Src)[1]};`,
      `const BYTES_PER_F32_PX = ${/const BYTES_PER_F32_PX = (\d+)/.exec(mainH3Src)[1]};`,
      extract(mainH3Src, [
        "postDimsForLongSide",
        "normalizeUpscaleScale",
        "upscaleFactorOfModel",
        "upscaleOutputLongSide",
        "findBoxDeep",
        "readMoovMeta",
        "probeMp4Meta",
        "systemRamGb",
        "startRamWatch",
        "planGbText",
        "estimateUpscaleRamGb",
        "estimatePostPeakRamGb",
        "resolveUpscaleRamPlan",
      ]),
    ].join("\n"),
    M,
    { filename: "video-post-ram-extract.js" },
  );

  /* [11a] 容器元数据（估内存的输入） */
  const meta = M.probeMp4Meta(video);
  ok(!!meta, "probeMp4Meta 能读合成 mp4 的 moov");
  eqNum(meta.frames, 300, "帧数 = stts 里各条 sample_count 之和");
  eqNum(meta.width, 1920, "视频轨宽从 tkhd 的 16.16 定长点（+76）读出");
  eqNum(meta.height, 1080, "视频轨高同上（+80）");
  eqNum(meta.duration, 1, "时长 = mvhd duration / timescale");
  eqNum(M.probeMp4Meta(frag), null, "fragmented / 无 moov 的文件返回 null（估不出来不阻断任务）");
  eqNum(M.probeMp4Meta(path.join(tmp, "nope.mp4")), null, "文件不存在返回 null");

  /* [11b] 峰值内存估算：显存空着、内存见顶是这条链的常态 */
  const g720 = M.estimateUpscaleRamGb(1280, 720, 3840, 300);
  ok(g720 > 20 && g720 < 40, "720p × 300 帧 → 4K x4 峰值内存约 " + g720 + "G（几十 G 量级，与显存无关）");
  const gShort = M.estimateUpscaleRamGb(1280, 720, 3840, 24);
  ok(gShort < g720 / 5, "帧数少一个量级 → 估算同比例下降（不是常数）");
  eqNum(M.estimateUpscaleRamGb(0, 0, 3840, 0), null, "缺分辨率 / 帧数时返回 null（不误降档）");

  /* [11c] 提交前内存闸：先二分目标长边，仍放不下就预缩放源帧 */
  const planOver = M.resolveUpscaleRamPlan({ sourcePath: video, targetLongSide: 3840 }, 1920, 1080);
  eqNum(planOver.frames, 300, "内存闸用容器里的真帧数（1920×1080 × 300 帧）");
  eqNum(planOver.downgraded, true, "预算不够 → 自动降档（不允许把 64G 跑满）");
  const tPlan = planOver.opts.targetLongSide;
  ok(
    tPlan >= 1000 && tPlan <= 3840,
    "目标长边被压到预算内（" + tPlan + "px，不低于最低档 × 预缩放下限）",
  );
  ok(planOver.afterGb <= planOver.budgetGb, "降档后估算回到预算内（" + planOver.afterGb + " ≤ " + planOver.budgetGb + "）");
  ok(planOver.beforeGb > planOver.budgetGb, "降档前确实超预算（" + planOver.beforeGb + " > " + planOver.budgetGb + "）");
  eqNum(M.resolveUpscaleRamPlan({ sourcePath: frag, targetLongSide: 3840 }, 1920, 1080).downgraded, false, "读不到帧数 → 原样放行，不动用户设置");

  /* 峰值主项是「源像素 × 16」的 x4 中间张量，只降目标长边压不住 —— 必须预缩放源帧 */
  const planPre = M.resolveUpscaleRamPlan({ sourcePath: video, targetLongSide: 1280 }, 1920, 1080);
  ok(planPre.opts.preScale > 0 && planPre.opts.preScale < 1, "最低目标档仍超预算 → 走 preScale 预缩放（" + planPre.opts.preScale + "）");
  eqArr(planPre.opts.preDims, M.postDimsForLongSide(1920, 1080, Math.round(1920 * planPre.opts.preScale)), "预缩放尺寸按源比例取偶（与成图同一口径）");
  ok(planPre.afterGb <= planPre.budgetGb, "预缩放后估算回到预算内（" + planPre.afterGb + " ≤ " + planPre.budgetGb + "）");

  const planBig = M.resolveUpscaleRamPlan({ sourcePath: big, targetLongSide: 3840 }, 3840, 2160);
  eqNum(planBig.meta.width, 3840, "4K 源被正确识别（3840×2160）");
  ok(planBig.opts.preScale > 0 && planBig.opts.preScale <= 0.3, "4K × 300 帧 → 源被缩到 ≤30% 才放得进预算（" + planBig.opts.preScale + "）");
  ok(planBig.afterGb <= planBig.budgetGb, "4K 源预缩放后同样回到预算内（" + planBig.afterGb + " ≤ " + planBig.budgetGb + "）");

  /* 小片：720p × 24 帧 → 预算内，一切照用户设置，不动 */
  const light = path.join(tmp, "light.mp4");
  fs.writeFileSync(light, mkMp4(1280, 720, 24));
  const planLight = M.resolveUpscaleRamPlan({ sourcePath: light, targetLongSide: 3840 }, 1280, 720);
  eqNum(planLight.downgraded, false, "估算在预算内 → 不动用户设置");
  eqNum(planLight.opts.targetLongSide, 3840, "目标长边原样保留");
  eqNum(planLight.opts.preScale, undefined, "不做预缩放");

  /* [11d] 后端启动参数：给 ComfyUI 的系统内存缓存一个保留下限 */
  has(mainH3Src, 'args.push("--cache-ram", String(cacheRamGb), String(inactiveGb))', "启动带 --cache-ram（活跃 / 非活跃两个阈值）");
  has(mainH3Src, "optCacheRamGb", "保留下限可配置（config.optCacheRamGb）");
  has(mainH3Src, "optCacheRamGb: POST_CACHE_RAM_ACTIVE_GB", "默认值走 POST_CACHE_RAM_ACTIVE_GB（8G）");
  has(mainH3Src, "cacheRamGb > 0", "0 = 不加 --cache-ram（退回 ComfyUI 默认）");
  has(mainH3Src, "resolveUpscaleRamPlan(", "超分提交前走内存闸");
  has(mainH3Src, "preScale", "放不下时下发 preScale（进超分前预缩放）");
  has(fnBody(mainH3Src, "buildPostWorkflow"), "p.preDims", "后处理图按 preDims 插一层 ImageScale（预缩放在超分之前）");
  has(mainH3Src, "startRamWatch()", "后处理期间监视系统内存水位");
  has(mainH3Src, "appendPostRamReport(memWatch, true)", "成功时打印实测内存峰值");
  has(mainH3Src, "[warn] 本机系统内存已被跑满", "跑满时给出「内存不是显存」的明确归因");

  /* [11e-2] 内存**持续攀升**护栏：单次峰值 ≠ 跨单累积。
   * 后端是常驻进程（stopBackend 只在用户点停时才杀），POST /free 只卸模型、不清 malloc arena：
   * 跑几单 4K 超分 / RIFE 之后进程 RSS 只涨不落 → 第 N 单比第 2 单紧得多。 */
  const rail = (() => {
    const V = { fs, path, join: path.join, os, process, Buffer, Math, Number, String, Object, JSON, console, setTimeout, clearInterval, setInterval };
    vm.runInNewContext(
      [
        `const CONTAINER_BOXES = ${/const CONTAINER_BOXES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
        constBlock(mainH3Src, "POST_MODELS"),
        constBlock(mainH3Src, "POST_SAFE_DEFAULTS"),
        `const POST_UPSCALE_SCALES = ${/const POST_UPSCALE_SCALES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
        `const POST_TARGET_LONG_SIDE_MIN = ${/const POST_TARGET_LONG_SIDE_MIN = (\d+)/.exec(mainH3Src)[1]};`,
        `const POST_RAM_RESERVE_GB = ${/const POST_RAM_RESERVE_GB = (\d+)/.exec(mainH3Src)[1]};`,
        `const BYTES_PER_F32_PX = ${/const BYTES_PER_F32_PX = (\d+)/.exec(mainH3Src)[1]};`,
        `const POST_MEM_RAIL_MIN_FREE_GB = ${/const POST_MEM_RAIL_MIN_FREE_GB = ([\d.]+)/.exec(mainH3Src)[1]};`,
        `const POST_MEM_RAIL_KEEP_RATIO = ${/const POST_MEM_RAIL_KEEP_RATIO = ([\d.]+)/.exec(mainH3Src)[1]};`,
        `const POST_MEM_RAIL_GUARD_RATIO = ${/const POST_MEM_RAIL_GUARD_RATIO = ([\d.]+)/.exec(mainH3Src)[1]};`,
        `const COMFY_RAM_STATS_TTL_MS = ${/const COMFY_RAM_STATS_TTL_MS = ([\d_ *]+)/.exec(mainH3Src)[1]};`,
        "let comfyRamStatsCache = { at: 0, port: 0, origin: '', ram: null };",
        extract(mainH3Src, [
          "postDimsForLongSide",
          "planGbText",
          "posNumOrNull",
          "gb1",
          "ramRailVerdict",
        ]),
      ].join("\n"),
      V,
      { filename: "video-post-ram-rail-extract.js" },
    );
    return V;
  })();

  /* 判决口径：守住超过一半内存 → 回收；本机低于硬闸 → 回收；正常波动不误杀 */
  const vKeep = rail.ramRailVerdict(30, 8, 64);
  eqNum(vKeep.keptGb, 22, "守住内存 = 任务前后可用内存之差（30G → 8G = 22G）");
  eqNum(vKeep.keptPct, 34, "守住比例按总内存算（22 / 64 = 34%）");
  eqNum(vKeep.recycle, true, "守住超过一半（>32G）→ 触发回收");

  const vTight = rail.ramRailVerdict(9, 4, 64);
  eqNum(vTight.keepTooMuch, false, "只守住 5G 不算「不回收」（未过一半）");
  eqNum(vTight.tightNow, true, "可用只剩 4G（低于硬闸 6G）→ 本机紧张");
  eqNum(vTight.recycle, true, "本机紧张同样触发回收（别在悬崖边再挤一单）");

  const vOk = rail.ramRailVerdict(50, 46, 64);
  eqNum(vOk.recycle, false, "守住 4G 且还有 46G 可用 → 不回收（正常运行不误杀）");
  const vNowTight = rail.ramRailVerdict(50, 20, 64);
  eqNum(vNowTight.tightNow, true, "可用 20G < 总内存的 65% → 启动前的硬闸也认（ramRailVerdict 同一函数两个用途）");
  eqNum(vNowTight.recycle, true, "启动前硬闸命中 → 先回收再干活");
  eqNum(
    rail.ramRailVerdict(null, 8, 64).recycle,
    false,
    "量不到任务开始时水位 → 一律放行（不误杀）",
  );
  eqNum(rail.ramRailVerdict(30, null, 64).recycle, false, "收尾量不到 → 放行");

  /* 源码级：护栏挂在「任务之间」，且只在没有任务时才动手 */
  has(mainH3Src, "POST_MEM_RAIL_MIN_FREE_GB", "预留硬闸常量（可用内存地板）");
  has(mainH3Src, "POST_MEM_RAIL_KEEP_RATIO", "「守住超过一半内存」判据常量");
  has(mainH3Src, "async function recycleBackendForRam(", "有任务之间的后端回收函数");
  const recycleBody = fnBody(mainH3Src, "recycleBackendForRam");
  has(recycleBody, "waitBackendIdle(", "回收前先等后端空闲（不打断别的任务）");
  has(recycleBody, "refreshStaleLock() || activeGenerate", "二次确认：刚又有任务进来就不动手");
  has(recycleBody, "saveConfig({ wantRunning: !!cfg.wantRunning", "回收不改 wantRunning（服务该待命还是待命），只重启");
  has(recycleBody, "startBackend()", "回收后后台重新拉起（下次任务直接复用）");
  has(mainH3Src, "async function waitBackendIdle(", "有「等空闲」实现");
  has(mainH3Src, "async function probeComfyRamStats(", "内存事实取后端自己报的 /system_stats（同口径）");
  has(mainH3Src, "comfyRamStatsCache", "内存采样有 60 秒复用窗口（状态轮询不再各打一次）");
  has(mainH3Src, "COMFY_RAM_STATS_TTL_MS", "采样复用窗口有常量");
  has(
    fnBody(mainH3Src, "ensureBackendReadyForJob"),
    "recycleBackendForRam(",
    "启动任务前若本机已低于硬闸，先回收再干活",
  );
  has(fnBody(mainH3Src, "ensureBackendReadyForJob"), "optRebuildOnRamHigh !== false", "启动前回收受开关控制");
  const postForRail = mainH3Src.split("async function postProcessVideo(params)")[1].split('ipcMain.handle("h3:postProcess"')[0];
  has(postForRail, "ramBeforeFreeGb", "后处理任务记下开工前的可用内存");
  has(postForRail, "ramRailVerdict(", "收尾按前后差值判决");
  has(postForRail, "recycleBackendForRam(", "判决要求回收时真的回收");
  has(postForRail, "[mem] 这一单结束后", "控制台打印「这一单守住多少」（把持续攀升变成可读数字）");

  /* [11e-3] arena 碎片：多线程进程每个线程一份 malloc arena，大块张量摊在多份缓存里回不到系统 */
  has(mainH3Src, 'env.MALLOC_ARENA_MAX = "1"', "后端环境固定 MALLOC_ARENA_MAX=1（压 arena 碎片，这正是「持续攀升」的第二来源）");
  has(mainH3Src, "env.OMP_NUM_THREADS", "后端线程上限可配（OMP_NUM_THREADS）");
  has(mainH3Src, "env.MKL_NUM_THREADS", "后端线程上限可配（MKL_NUM_THREADS）");
  has(mainH3Src, "optArenaThreads: 8", "线程上限默认 8（0 = 不改环境变量）");

  /* [11e] 管理窗：开关 + 取值回显（下次启动后端生效） */
  const h3Html = read("h3/ui/index.html");
  const h3Ui = read("h3/ui/ui.js");
  has(h3Html, 'id="optCacheRam"', "管理窗有「系统内存缓存保留下限」开关");
  has(h3Html, 'id="optCacheRamGb"', "开关带 GB 取值框");
  has(h3Ui, "optCacheRamGb: on ? gb : 0", "关掉开关 = 下发 0（不加 --cache-ram）");
  has(h3Ui, "Number(st.optCacheRamGb)", "管理窗按 status 回显当前档位");
  has(mainH3Src, "optCacheRamGb: Number(cfg.optCacheRamGb) > 0", "statusForUi 回显该取值（打开管理窗即见当前档）");
  /* 内存护栏的界面口径：开关 + 现状（可用内存 / 最近一次回收时间） */
  has(h3Html, 'id="optRebuildRam"', "管理窗有「内存护栏：任务之间内存不回收就重启后端」开关");
  has(h3Html, 'id="optArenaThreads"', "管理窗有线程上限取值框");
  has(h3Html, 'id="memRailInfo"', "管理窗有内存护栏现状行");
  has(h3Ui, "optRebuildOnRamHigh: !!$(\"optRebuildRam\").checked", "开关回写走 setLaunchOpts");
  has(h3Ui, "renderMemRail(st)", "状态刷新时渲染内存护栏现状");
  has(mainH3Src, "optRebuildOnRamHigh: cfg.optRebuildOnRamHigh !== false", "statusForUi 回显护栏开关");
  has(mainH3Src, "lastRecycleAt", "回收时间进状态（管理窗显示「最近一次回收」）");

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ═══════════ [12] 超分倍率 x2（节点可只放大 2 倍 · 内存口径按模型算） ═══════════ */
section("[12] 超分支持 x2 倍率：输出 = 源 × 2 · 本机没 x2 权重也成立");
{
  /* [12a] 参数归一：倍率只认 2 / 4，缺省仍是 x4（老节点不带 scale 字段） */
  eqNum(host.resolvePostOptions("upscale", {}).scale, 4, "老节点（没有 scale 字段）默认仍是 x4 倍率");
  eqNum(host.resolvePostOptions("upscale", { scale: 2 }).scale, 2, "显式选 x2 → 倍率 2");
  eqNum(host.resolvePostOptions("upscale", { scale: "2" }).scale, 2, "字符串 \"2\" 也认（下拉回写口径）");
  eqNum(host.resolvePostOptions("upscale", { scale: 3 }).scale, 4, "非法倍率（3）退回 x4，不下发怪值");
  eqNum(host.resolvePostOptions("upscale", { scale: 2 }).targetLongSide, 3840, "倍率不影响目标长边（它是上限，不是目标值）");

  /* [12b] 权重名 → 模型固有倍数：决定中间张量（峰值内存主项）多大 */
  eqNum(host.upscaleFactorOfModel("RealESRGAN_x4plus.pth"), 4, "x4plus → 固有 4 倍");
  eqNum(host.upscaleFactorOfModel("RealESRGAN_x2plus.pth"), 2, "x2plus → 固有 2 倍（中间张量只有 1/4）");
  eqNum(host.upscaleFactorOfModel("4x-UltraSharp.safetensors"), 4, "别的 x4 权重 → 4 倍");
  eqNum(host.pickNativeX2Model(["RealESRGAN_x4plus.pth", "RealESRGAN_x2plus.pth"]), "RealESRGAN_x2plus.pth", "本机有 x2 权重时优先用它");
  eqNum(host.pickNativeX2Model(["RealESRGAN_x4plus.pth"]), "", "本机没有 x2 权重 → 返回空串（走 x4 兜底，不是报错）");
  eqNum(host.pickNativeX2Model(null), "", "目录读不到同样不阻断");

  /* [12c] 输出长边 = min(目标长边, 源长边 × 倍率)：x2 不会被目标长边拉成 4 倍 */
  eqNum(host.upscaleOutputLongSide(3840, 1920, 2), 3840, "1080p 源 × x2 = 3840（正好 4K）");
  eqNum(host.upscaleOutputLongSide(3840, 1280, 2), 2560, "720p 源 × x2 = 2560（不因为目标 3840 就放大 3 倍）");
  eqNum(host.upscaleOutputLongSide(3840, 1920, 4), 3840, "x4 倍率仍是目标长边说了算（源 ×4 = 7680 当上限）");
  eqNum(host.upscaleOutputLongSide(1920, 1920, 4), 1920, "目标长边比源还小 → 原样（封顶不等于放大）");

  /* [12d] 成图：x2 时插在末端的 ImageScale 缩到源 ×2；x4 一字不动（回归） */
  const g2 = host.buildPostWorkflow({
    kind: "upscale",
    videoPath: "E:/in/a.mp4",
    fps: 24,
    width: 1280,
    height: 720,
    upscale: { model: "RealESRGAN_x4plus.pth", scale: 2, targetLongSide: 3840, perBatch: 1, lowVram: true },
  });
  const sc2 = Object.values(g2).filter((n) => n.class_type === "ImageScale").pop();
  eqArr([sc2.inputs.width, sc2.inputs.height], [2560, 1440], "x2：x4 权重的产物被缩到源 ×2（2560×1440）");
  eqNum(
    Object.values(g2).find((n) => n.class_type === "SaveVideo").inputs.filename_prefix,
    "video/MiniMax_H3_post_upscaleX2_2560",
    "产物名带倍率（一眼看出这一单是 2 倍）",
  );
  const g4 = host.buildPostWorkflow({
    kind: "upscale",
    videoPath: "E:/in/a.mp4",
    fps: 24,
    width: 1280,
    height: 720,
    upscale: { model: "RealESRGAN_x4plus.pth", scale: 4, targetLongSide: 3840, perBatch: 1, lowVram: true },
  });
  eqArr(
    [Object.values(g4).filter((n) => n.class_type === "ImageScale").pop().inputs.width,
     Object.values(g4).filter((n) => n.class_type === "ImageScale").pop().inputs.height],
    [3840, 2160],
    "x4：目标长边 3840（老口径逐字不变）",
  );
  eqNum(Object.values(g4).find((n) => n.class_type === "UpscaleModelLoader").inputs.model_name, "RealESRGAN_x4plus.pth", "x4 仍加载 x4 权重");
  const g2native = host.buildPostWorkflow({
    kind: "upscale",
    videoPath: "E:/in/a.mp4",
    fps: 24,
    width: 1280,
    height: 720,
    upscale: { model: "RealESRGAN_x2plus.pth", scale: 2, targetLongSide: 3840, perBatch: 1, lowVram: true },
  });
  eqNum(Object.values(g2native).find((n) => n.class_type === "UpscaleModelLoader").inputs.model_name, "RealESRGAN_x2plus.pth", "选到原生 x2 权重就直接加载它");

  /* [12e] 峰值内存估算按「模型固有倍数」而不是「输出倍率」：x4 兜底时不能低估 */
  const X = {
    fs,
    path,
    Math,
    Number,
    String,
    Object,
    console,
  };
  vm.runInNewContext(
    [
      constBlock(mainH3Src, "POST_MODELS"),
      constBlock(mainH3Src, "POST_SAFE_DEFAULTS"),
      `const POST_UPSCALE_SCALES = ${/const POST_UPSCALE_SCALES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      `const POST_TARGET_LONG_SIDE_MIN = ${/const POST_TARGET_LONG_SIDE_MIN = (\d+)/.exec(mainH3Src)[1]};`,
      `const BYTES_PER_F32_PX = ${/const BYTES_PER_F32_PX = (\d+)/.exec(mainH3Src)[1]};`,
      extract(mainH3Src, ["postDimsForLongSide", "normalizeUpscaleScale", "upscaleFactorOfModel", "upscaleOutputLongSide", "estimateUpscaleRamGb"]),
    ].join("\n"),
    X,
    { filename: "video-post-x2-extract.js" },
  );
  const gbX4 = X.estimateUpscaleRamGb(1280, 720, 3840, 300, { model: "RealESRGAN_x4plus.pth", scale: 4 });
  const gbX2 = X.estimateUpscaleRamGb(1280, 720, 3840, 300, { model: "RealESRGAN_x2plus.pth", scale: 2 });
  const gbX2fallback = X.estimateUpscaleRamGb(1280, 720, 3840, 300, { model: "RealESRGAN_x4plus.pth", scale: 2 });
  ok(gbX2 < gbX4 / 3, "原生 x2 权重的峰值内存不到 x4 的 1/3（" + gbX2 + "G vs " + gbX4 + "G）");
  eqNum(gbX2fallback, gbX4, "x4 权重兜底跑 x2：输出变小但中间张量还是 x4 → 估算不跟着变小（不低估内存）");

  /* [12f] 内存闸里同样按模型算：x2 权重下要压的幅度明显更小 */
  const Y = { fs, path, join: path.join, os: require("os"), Buffer, Math, Number, String, Object, JSON, console, setTimeout, clearInterval, setInterval };
  vm.runInNewContext(
    [
      `const CONTAINER_BOXES = ${/const CONTAINER_BOXES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      constBlock(mainH3Src, "POST_MODELS"),
      constBlock(mainH3Src, "POST_SAFE_DEFAULTS"),
      `const POST_UPSCALE_SCALES = ${/const POST_UPSCALE_SCALES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      `const POST_TARGET_LONG_SIDE_MIN = ${/const POST_TARGET_LONG_SIDE_MIN = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_RAM_RESERVE_GB = ${/const POST_RAM_RESERVE_GB = (\d+)/.exec(mainH3Src)[1]};`,
      `const BYTES_PER_F32_PX = ${/const BYTES_PER_F32_PX = (\d+)/.exec(mainH3Src)[1]};`,
      extract(mainH3Src, [
        "postDimsForLongSide",
        "normalizeUpscaleScale",
        "upscaleFactorOfModel",
        "upscaleOutputLongSide",
        "findBoxDeep",
        "readMoovMeta",
        "probeMp4Meta",
        "systemRamGb",
        "planGbText",
        "estimateUpscaleRamGb",
        "estimatePostPeakRamGb",
        "resolveUpscaleRamPlan",
      ]),
    ].join("\n"),
    Y,
    { filename: "video-post-x2-plan-extract.js" },
  );
  const osmod = require("os");
  const tmp2 = fs.mkdtempSync(path.join(osmod.tmpdir(), "h3x2-"));
  const clip = path.join(tmp2, "clip.mp4");
  fs.writeFileSync(clip, POST_MK_MP4(1920, 1080, 300)); /* 与 [11] 同形状的样本片（1920×1080 · 300 帧） */
  const planX4 = Y.resolveUpscaleRamPlan({ sourcePath: clip, targetLongSide: 3840, model: "RealESRGAN_x4plus.pth", scale: 4 }, 1920, 1080);
  const planX2 = Y.resolveUpscaleRamPlan({ sourcePath: clip, targetLongSide: 3840, model: "RealESRGAN_x2plus.pth", scale: 2 }, 1920, 1080);
  ok(planX2.beforeGb < planX4.beforeGb, "同一源：原生 x2 的预计峰值明显更低（" + planX2.beforeGb + "G vs " + planX4.beforeGb + "G）");
  ok(planX2.afterGb <= planX4.afterGb, "x2 需要压的幅度不超过 x4（内存闸按同一预算收敛）");
  if (planX2.downgraded) {
    ok(
      !planX4.downgraded || (planX2.opts.preScale || 1) >= (planX4.opts.preScale || 1),
      "两档都要预缩放时，x2 缩得更少（x2 " + (planX2.opts.preScale || 1) + " vs x4 " + (planX4.opts.preScale || 1) + "）",
    );
  }

  /* [12g] 源码级：兜底路径 + 管理/设置入口 */
  has(mainH3Src, "pickNativeX2Model(avail)", "提交前先在本机目录里找原生 x2 权重");
  has(mainH3Src, "倍率 x2：本机没找到 x2 权重", "没有 x2 权重时降级说明（不是报错）");
  has(fnBody(mainH3Src, "buildPostWorkflow"), "upscaleOutputLongSide(", "成图的输出尺寸统一走倍率封顶函数");
  has(fnBody(mainH3Src, "downgradePostOptions"), "normalizeUpscaleScale(opts.scale)", "OOM 降档保留用户选的倍率");
  ok(/video_upscale:\s*\{[\s\S]{0,800}?\n    scale: 4,/.test(appSrc), "NODE_DEFAULTS 的 video_upscale 带 scale: 4");
  has(fnBody(nodesSrc, "buildVideoPostRunParams"), "scale: Number(node.scale) === 2 ? 2 : 4", "渲染层把倍率下发给 h3:postProcess");
  has(canvasSrc, '"超分倍率"', "设置窗口有「超分倍率」下拉");
  has(canvasSrc, "RealESRGAN_x2plus.pth", "超分模型下拉列出原生 x2 权重");
  has(canvasSrc, "x2 倍率（输出只放大 2 倍 · 更快更省显存）", "下拉写明 x2 的取舍");
  has(canvasSrc, 'String(node.scale === 2 ? 2 : 4)', "节点卡片摘要回显当前倍率");

  fs.rmSync(tmp2, { recursive: true, force: true });
}

/* ═══════════ [13] 流式超分：16G 可用的逐帧分块链（脚本 / 选路 / 不降档 / 前端指南） ═══════════
 * 需求口径：旧 ComfyUI 图链把整段帧张量攒在系统内存里，峰值 ∝ 时长（15s@720p x4 中间张量 ~21G），
 * 64G 都见顶、16G 根本跑不动。新链 = h3-pack/post/stream_upscale.py 逐帧 decode → 按 tile 分块过模型
 * → 立刻编码写盘，常驻内存只与一个 tile 有关 —— 与时长无关，16G 也能跑 15 秒级 x2/x4 超分。
 * 本段全为静态文本断言 + 纯函数真跑，不拉起 GPU / Python。 */
section("[13] 流式超分后端 / 宿主选路 / 流式档不降档 / 前端与指南同步");
{
  /* [13a] 后端脚本：纯 torch RRDBNet + PyAV 逐帧 + 分块 + 自检（零新增依赖、不碰 basicsr） */
  const pyRel = "h3-pack/post/stream_upscale.py";
  ok(fs.existsSync(path.join(__dirname, "..", pyRel.split("/").join(path.sep))), pyRel + " 存在");
  const py = read(pyRel);
  has(py, "class RRDBNet(nn.Module)", "自带 RRDBNet 定义（纯 torch 复刻，不依赖 basicsr）");
  has(py, "num_block: int = 23", "23 个残差块（与 RealESRGAN_x4plus.pth 逐键对齐）");
  has(py, "num_feat=64", "64 通道（RRDBNet 默认宽度）");
  has(py, "num_grow_ch=32", "grow 32（逐键对齐口径）");
  has(py, "weights_only=True", "torch.load 走 weights_only=True");
  has(py, "params_ema", "键名 params_ema 兜底（官方权重存的是 EMA）");
  has(py, "def upscale_frame(", "可分块推理的单帧超分算子");
  has(py, "def tile_starts(", "分块起点计算（带 overlap）");
  has(py, "def make_window(", "overlap 线性羽化窗");
  has(py, "def out_dims_for_long_side(", "输出长边取偶换算");
  has(py, "def resolve_output_long_side(", "输出 = min(目标长边, 源长边 × 倍率)");
  has(py, "def copy_audio(", "音轨从源文件直拷（不重编码）");
  has(py, "def run_stream(", "逐帧流式主循环");
  has(py, "def run_self_test(", "--self-test CPU 冒烟实现");
  has(py, "def _cleanup_partial(", "取消 / 失败时清理半成品");
  has(py, "peakRamMb", "进度 / 回执带峰值内存");
  has(py, "peakVramMb", "进度 / 回执带峰值显存");
  has(py, "--tile", "支持 --tile 分块大小");
  has(py, "--overlap", "支持 --overlap");
  has(py, "--precision", "支持 --precision（fp16 / fp32）");
  has(py, "--target-long-side", "支持 --target-long-side");
  has(py, "--json-out", "--json-out 落事实回执");
  has(py, "--self-test", "有 --self-test（无 GPU 也能跑通整链）");
  const pyImports = py
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(import|from)\s+/.test(l))
    .join("\n");
  hasnt(pyImports, "basicsr", "不 import basicsr（venv 里本来就没有）");
  hasnt(pyImports, "realesrgan", "不 import realesrgan");
  has(pyImports, "import av", "PyAV 真被 import（解码 / 编码都走它，不需要 ffmpeg.exe）");
  has(pyImports, "import torch", "torch 真被 import（ComfyUI venv 自带）");
  has(pyImports, "import numpy as np", "numpy 真被 import");
  ok(!/^\s*import\s+subprocess\b/m.test(py), "不靠外部 ffmpeg 子进程（venv 内没有 ffmpeg.exe）");

  /* [13b] 宿主选路：upscale 默认流式 / interp 永远走图 / 缺件回退并写明原因 */
  ok(typeof host.resolvePostEngine === "function", "resolvePostEngine 抽到真实实现（纯函数选路）");
  eqArr(
    host.resolvePostEngine("upscale", {}, { scriptExists: true, venvExists: true }),
    { engine: "stream", reason: "default_stream" },
    "超分默认走逐帧流式（内存与时长无关）",
  );
  eqNum(host.resolvePostEngine("upscale", { engine: "graph" }, { scriptExists: true, venvExists: true }).engine, "graph", "显式 engine=graph → 图路径");
  eqNum(host.resolvePostEngine("upscale", { engine: "graph" }, { scriptExists: true, venvExists: true }).reason, "requested_graph", "回退原因 = 用户显式指定");
  eqNum(host.resolvePostEngine("upscale", {}, { scriptExists: false, venvExists: true }).engine, "graph", "脚本缺失 → 回退图路径");
  eqNum(host.resolvePostEngine("upscale", {}, { scriptExists: false, venvExists: true }).reason, "script_missing", "回退原因写明 script_missing");
  eqNum(host.resolvePostEngine("upscale", {}, { scriptExists: true, venvExists: false }).reason, "venv_missing", "缺 venv 解释器 → 回退图路径（原因 venv_missing）");
  eqNum(host.resolvePostEngine("upscale", {}, {}).engine, "graph", "环境事实缺失（探测不到脚本）也回退图路径，不硬闯");
  eqArr(
    host.resolvePostEngine("interp", {}, { scriptExists: true, venvExists: true, weightsExists: true }),
    { engine: "stream", reason: "interp_default_stream" },
    "补帧默认也走逐帧流式（常驻内存只与相邻两帧有关，内存与时长无关）",
  );
  eqNum(
    host.resolvePostEngine("interp", { engine: "graph" }, { scriptExists: true, venvExists: true, weightsExists: true }).reason,
    "requested_graph",
    "补帧显式 engine=graph → 图路径",
  );
  eqNum(
    host.resolvePostEngine("interp", {}, { scriptExists: false, venvExists: true, weightsExists: true }).reason,
    "interp_script_missing",
    "补帧缺脚本 → 回退图路径（interp_script_missing）",
  );
  eqNum(
    host.resolvePostEngine("interp", {}, { scriptExists: true, venvExists: false, weightsExists: true }).reason,
    "interp_venv_missing",
    "补帧缺 venv 解释器 → 回退图路径（interp_venv_missing）",
  );
  eqNum(
    host.resolvePostEngine("interp", {}, { scriptExists: true, venvExists: true, weightsExists: false }).engine,
    "graph",
    "补帧缺 RIFE 权重 → 回退图路径（不硬闯）",
  );
  eqNum(
    host.resolvePostEngine("interp", {}, { scriptExists: true, venvExists: true, weightsExists: false }).reason,
    "interp_weights_missing",
    "补帧缺权重的原因写明 interp_weights_missing",
  );
  eqNum(
    host.resolvePostEngine("nonsense", {}, { scriptExists: true, venvExists: true }).reason,
    "kind_not_upscale",
    "未知 kind 仍一律走图（超分之外的旧口径未变）",
  );
  has(mainH3Src, 'const POST_STREAM_SCRIPT = "stream_upscale.py"', "脚本名有常量（不散落字面量）");
  has(mainH3Src, "function streamVenvPython(", "解释器定位 = ComfyUI venv python");
  has(mainH3Src, "function streamUpscaleScriptPath(", "脚本定位有独立函数");
  has(fnBody(mainH3Src, "streamUpscaleScriptPath"), "bundledPackRoot()", "打包态从 resourcesPath/h3-pack 取（同 bundledPackRoot 口径）");
  has(fnBody(mainH3Src, "streamUpscaleScriptPath"), "runtimePackRoot()", "再兜运行时更新包");
  ok(/function streamVenvPython\(comfy\)[\s\S]{0,220}?"venv"[\s\S]{0,80}?"Scripts"[\s\S]{0,80}?"python\.exe"/.test(mainH3Src), "venv 解释器路径 = <ComfyUI>/venv/Scripts/python.exe");
  has(mainH3Src, "function runStreamUpscaleJob(", "有 spawn 子进程的流式执行函数");
  has(mainH3Src, "function ensureVideoExt(", "落名补 .mp4（与 copyOutputToDir 同口径）");
  const runStreamBody = fnBody(mainH3Src, "runStreamUpscaleJob");
  has(runStreamBody, "spawn(String(j.py), args", "真 spawn venv python");
  has(runStreamBody, '"--tile"', "把 tile 传给脚本");
  has(runStreamBody, '"--precision"', "把精度传给脚本");
  has(runStreamBody, 'child.stdin.write("cancel\\n")', "取消时向 stdin 写 cancel");
  has(runStreamBody, "child.kill()", "取消时终止子进程");
  has(runStreamBody, "activeGenerate.streamKill = killChild", "kill 挂到 activeGenerate（用户点停止能中断）");
  has(runStreamBody, "emitProgress({", "stdout JSON 进度转 emitProgress");
  has(runStreamBody, "ev.type === \"progress\"", "认 progress 事件");
  has(runStreamBody, "err.oom = code === 3", "退出码 3 / oom 标记 → err.oom（供上层降档）");
  has(runStreamBody, "err.streamCancelled = true", "取消单独标记，不走失败回退");
  has(mainH3Src, "→ 已回退图路径", "回退图路径时在控制台写明原因");
  has(mainH3Src, "缺流式脚本", "缺脚本的回退日志带上具体路径");
  has(mainH3Src, "缺 ComfyUI venv 解释器", "缺 venv 的回退日志带上具体路径");
  const postSlice13 = mainH3Src.split("async function postProcessVideo(params)")[1].split('ipcMain.handle("h3:postProcess"')[0];
  has(postSlice13, "resolvePostEngine(kind, opts, {", "postProcessVideo 用纯函数选路");
  has(postSlice13, "opts.engine === \"stream\"", "upscale 分支按引擎分流");
  has(postSlice13, "runStreamUpscaleJob({", "流式分支真跑脚本");
  has(postSlice13, "超分引擎 = ", "控制台打印选路结论");
  has(postSlice13, "downgradePostOptions(kind, opts)", "流式 OOM 也走降档（重试一次）");
  has(postSlice13, "engine: \"graph\"", "流式未出片 → 切回图路径兜底");
  /* 流式路径不再把源视频 upload 进 ComfyUI/input（PyAV 直读源文件）；upload 已挪进图分支 */
  const streamBranch = postSlice13.split('opts.engine === "stream"')[1].split("/* ── ComfyUI 图路径")[0];
  hasnt(streamBranch, "uploadFileToComfy", "流式分支不上传源视频（PyAV 直读）");
  has(postSlice13.split("/* ── ComfyUI 图路径")[1] || "", "uploadFileToComfy", "图兜底分支仍先 upload 源视频（老逻辑一字未改）");

  /* [13c] 流式档不做任何降档；图兜底 / 补帧口径一字未变 */
  const Z = { fs, path, join: path.join, os: require("os"), process, Buffer, Math, Number, String, Object, JSON, console, setTimeout, clearInterval, setInterval };
  vm.runInNewContext(
    [
      `const CONTAINER_BOXES = ${/const CONTAINER_BOXES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      constBlock(mainH3Src, "POST_MODELS"),
      constBlock(mainH3Src, "POST_SAFE_DEFAULTS"),
      `const POST_UPSCALE_SCALES = ${/const POST_UPSCALE_SCALES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      `const POST_TARGET_LONG_SIDE_MIN = ${/const POST_TARGET_LONG_SIDE_MIN = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_RAM_RESERVE_GB = ${/const POST_RAM_RESERVE_GB = (\d+)/.exec(mainH3Src)[1]};`,
      `const BYTES_PER_F32_PX = ${/const BYTES_PER_F32_PX = (\d+)/.exec(mainH3Src)[1]};`,
      extract(mainH3Src, [
        "postDimsForLongSide",
        "normalizeUpscaleScale",
        "upscaleFactorOfModel",
        "upscaleOutputLongSide",
        "findBoxDeep",
        "readMoovMeta",
        "probeMp4Meta",
        "systemRamGb",
        "planGbText",
        "estimateUpscaleRamGb",
        "estimatePostPeakRamGb",
        "resolveUpscaleRamPlan",
      ]),
    ].join("\n"),
    Z,
    { filename: "video-post-stream-plan-extract.js" },
  );
  const tmp3 = fs.mkdtempSync(path.join(require("os").tmpdir(), "h3stream-"));
  const clip3 = path.join(tmp3, "clip.mp4");
  fs.writeFileSync(clip3, POST_MK_MP4(1920, 1080, 300)); /* 与 [11] 同形状：1920×1080 · 300 帧 */
  const planStream = Z.resolveUpscaleRamPlan({ sourcePath: clip3, targetLongSide: 3840, engine: "stream" }, 1920, 1080);
  eqNum(planStream.stream, true, "流式档被内存闸识别（plan.stream）");
  eqNum(planStream.downgraded, false, "流式档不做任何降档（内存与时长无关）");
  eqNum(planStream.opts.targetLongSide, 3840, "流式档保留用户的目标长边（4K 不再受内存限制）");
  eqNum(planStream.opts.preScale, undefined, "流式档不做 preScale 预缩放");
  eqNum(planStream.afterGb, planStream.beforeGb, "afterGb 只是旧图链口径的对照数字");
  ok(
    planStream.beforeGb > planStream.budgetGb,
    "同一源在旧图链口径下确实超预算（" + planStream.beforeGb + "G > " + planStream.budgetGb + "G）——正是 64G 见顶的成因",
  );
  ok(planStream.frames === 300 && planStream.meta && planStream.meta.width === 1920, "流式档仍照旧读容器元数据（帧数 / 分辨率进日志）");
  /* 图兜底档（不给 engine）：同一源照旧降档 —— 旧口径一字未变 */
  const planGraph13 = Z.resolveUpscaleRamPlan({ sourcePath: clip3, targetLongSide: 3840 }, 1920, 1080);
  eqNum(planGraph13.stream, false, "不给 engine = 图兜底档（老节点 / 老调用行为不变）");
  eqNum(planGraph13.downgraded, true, "图兜底档同一源仍自动降档（旧口径未变）");
  ok(planGraph13.afterGb <= planGraph13.budgetGb, "图兜底档降档后回到预算内（未变）");
  /* 补帧不进超分内存闸：只有 kind==='upscale' 才调 resolveUpscaleRamPlan */
  const ramCallAt = postSlice13.indexOf("resolveUpscaleRamPlan(");
  const upscaleIfAt = postSlice13.indexOf('if (kind === "upscale")');
  ok(upscaleIfAt >= 0 && ramCallAt > upscaleIfAt, "内存闸只在 kind==='upscale' 分支内（补帧路径不受影响）");
  has(fnBody(mainH3Src, "downgradePostOptions"), 'String(opts.engine || "") === "stream"', "降档按引擎分流（先判流式）");
  has(fnBody(mainH3Src, "downgradePostOptions"), 'precision: "fp32"', "流式 OOM 降档落 fp32");
  has(fnBody(mainH3Src, "downgradePostOptions"), "POST_STREAM_DEFAULT_TILE) / 2", "流式 OOM 降档 tile 减半");
  has(fnBody(mainH3Src, "resolveUpscaleRamPlan"), 'String(next.engine || "") === "stream"', "内存闸里流式档短路（不二分长边 / 不预缩放）");
  has(mainH3Src, "plan.stream = true", "内存闸给流式档打标记");
  has(mainH3Src, "常驻内存只与一个 tile 有关、与时长无关", "控制台写明流式档的内存口径");

  /* [13d] 前端节点 / i18n / 指南同步 */
  const ndBlock13 = (() => {
    const at = appSrc.indexOf("const NODE_DEFAULTS = {");
    const end = appSrc.indexOf("\n};", at);
    return at < 0 ? "" : appSrc.slice(at, end);
  })();
  const upDef13 = (ndBlock13.match(/video_upscale:\s*\{([\s\S]*?)\n  \},/) || [null, ""])[1];
  ok(/tile:\s*512/.test(upDef13), "video_upscale 默认 tile = 512（16G 机器的分块档）");
  has(upDef13, "targetLongSide: 3840", "目标长边上限仍是 3840（流式档下不再受内存限制）");
  has(upDef13, "lowVram: true", "低显存安全档默认开");
  has(appSrc, "16G 内存也能跑 15 秒级视频", "节点注释写明 16G 可用");
  has(appSrc, "常驻内存只与一个分块有关、与视频时长无关", "节点注释写明内存与时长无关");
  has(nodesSrc, "内存与时长无关", "渲染层执行注释写明内存与时长无关");
  const postParams = fnBody(nodesSrc, "buildVideoPostRunParams");
  has(postParams, "tile: Number(node.tile) || 0", "buildVideoPostRunParams 透传 tile（字段名未改）");
  has(postParams, 'engine: node.engine === "graph" ? "graph" : "stream"', "透传 engine（默认流式，显式 graph 才走旧链）");
  has(postParams, 'node.precision === "fp16" || node.precision === "fp32"', "透传 precision（空串交给宿主按显存决定）");
  has(postParams, "lowVram: node.lowVram !== false", "lowVram 仍照旧透传");
  has(canvasSrc, "分块 tile（像素）", "设置表单有「分块 tile（像素）」字段");
  has(canvasSrc, "分块 fp16 省显存，16G 机器也能跑 15 秒片", "安全档说明改为流式口径");
  has(canvasSrc, "超分模型 / 倍率 / 目标长边 / 分块流式", "设置窗标题改为流式口径");
  has(i18nSrc, '"超分模型 / 倍率 / 目标长边 / 分块流式"', "i18n 真源同步为流式口径");
  has(i18nSrc, "与视频时长无关，16G 机器也能跑 15 秒级视频", "i18n 写明内存与时长无关 / 16G 可用");
  has(i18nSrc, '"分块 tile（像素）": "Tile (px)"', "新词条有英文译文");
  has(i18nSrc, '"分块 fp16 省显存，16G 机器也能跑 15 秒片；关闭后按 per_batch 批量，更快但更吃显存"', "安全档新词条有英文译文");
  const gUp = read("guides/nodes/video_upscale.md");
  const gUpEn = read("guides/nodes/en/video_upscale.md");
  has(gUp, "stream_upscale.py", "中文指南写明流式链脚本");
  has(gUp, "与视频时长、分辨率、倍率都无关", "中文指南写明内存与时长无关");
  has(gUp, "16G 内存也能完成 15 秒级视频的 x2 / x4 超分", "中文指南写明 16G 可用");
  has(gUpEn, "16 GB machine can finish an x2 / x4 upscale of a 15-second clip", "英文指南写明 16 GB 可用");
  has(gUp, "已回退图路径", "指南写明只在兜底时才回旧口径");
  hasnt(gUp, "必须大内存机器", "删掉「必须大内存机器」的错误引导");
  hasnt(gUpEn, "big-memory machine", "英文指南同样删掉大内存引导");
  const wm = read("guides/nodes/_write.mjs");
  has(wm, "16G 内存也能完成 15 秒级视频的 x2 / x4 超分", "指南生成器模板同步（重生成不会回滚成旧口径）");
  fs.rmSync(tmp3, { recursive: true, force: true });
}

/* ═══════════ [14] 流式补帧：16G 可用的逐帧链（脚本 / 选路 / 不降档 / 前端指南） ═══════════
 * 需求口径：旧 ComfyUI 图链把整段视频的帧解出来、RIFE 再把所有中间帧收集成一个列表，
 * 15s 1080p30 一份帧数组约 11GB、4x 后约 45GB（还要 ×3 共存）—— 64G 都见顶、16G 根本跑不动。
 * 新链 = h3-pack/post/stream_interp.py 用 PyAV 顺序 decode，同一时刻只持有相邻两帧 + 一张中间帧，
 * 每帧算完立刻编码写盘 —— 常驻内存与时长 / 总帧数无关，16G 也能跑 15 秒级 2x/4x 补帧。
 * 本段全为静态文本断言 + 纯函数真跑，不拉起 GPU / Python。 */
section("[14] 流式补帧后端 / 宿主选路 / 流式档不降档 / 前端与指南同步");
{
  /* [14a] 后端脚本：纯 torch 复刻 RIFE IFNet + PyAV 逐帧 + 自检（零新增依赖、不碰任何 rife 包） */
  const pyRel = "h3-pack/post/stream_interp.py";
  ok(fs.existsSync(path.join(__dirname, "..", pyRel.split("/").join(path.sep))), pyRel + " 存在");
  const py = read(pyRel);
  has(py, "class IFNet(nn.Module)", "自带 RIFE IFNet 定义（纯 torch 复刻，不依赖任何 rife 包）");
  has(py, "class IFBlock(nn.Module)", "自带 IFBlock（多尺度光流块）");
  has(py, "class Head(nn.Module)", "自带 Head（光流 + 掩膜输出头）");
  has(py, "def detect_arch(", "按 state_dict 键名判定 RIFE 架构版本");
  has(py, "def resolve_scale_list(", "scale_list 与旧图链口径一致");
  has(py, "weights_only=True", "torch.load 走 weights_only=True");
  has(py, "params_ema", "键名 params_ema 兜底（官方权重存的是 EMA）");
  has(py, "相邻两帧", "文件头写明常驻内存只与相邻两帧有关（对齐 RAM 闸口径）");
  has(py, "av.open(", "PyAV 真被使用（顺序 decode / 编码 / 音轨直拷，不依赖 ffmpeg.exe）");
  has(py, "def iter_middles(", "逐对产出中间帧的流式生成器");
  has(py, "if m == 4:", "multiplier 4 档：连续两轮插值（t=0.5 → 0.25 / 0.75）");
  has(py, "for i in range(1, m):", "multiplier 2 档：每对插 1 张（t=0.5）");
  has(py, "def copy_audio(", "音轨从源文件直拷（不重编码）");
  has(py, "def run_stream(", "逐帧流式主循环");
  has(py, "def run_self_test(", "--self-test CPU 冒烟实现");
  has(py, "def _cleanup_partial(", "取消 / 失败时清理半成品");
  has(py, "peakRamMb", "进度 / 回执带峰值内存");
  has(py, "peakVramMb", "进度 / 回执带峰值显存");
  has(py, "--max-long-side", "支持 --max-long-side 预缩放");
  has(py, "--precision", "支持 --precision（fp16 / fp32）");
  has(py, "--multiplier", "支持 --multiplier");
  has(py, "--json-out", "--json-out 落事实回执");
  has(py, "--self-test", "有 --self-test（无 GPU 也能跑通整链）");
  has(py, "EXIT_OOM = 3", "退出码 3 = OOM（宿主据此降档重试）");
  has(py, "EXIT_CANCEL = 4", "退出码 4 = 已取消（宿主不上报失败）");
  has(py, '"error": "oom"', "OOM 事件带 oom 标记");
  const pyImports = py
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(import|from)\s+/.test(l))
    .join("\n");
  hasnt(pyImports, "rife", "不 import 任何 rife / 官方包（只复刻架构）");
  hasnt(pyImports, "basicsr", "不 import basicsr（venv 里本来就没有）");
  hasnt(pyImports, "realesrgan", "不 import realesrgan");
  has(pyImports, "import av", "PyAV 真被 import（解 / 编码与音轨直拷都走它）");
  has(pyImports, "import torch", "torch 真被 import（ComfyUI venv 自带）");
  has(pyImports, "import numpy as np", "numpy 真被 import");
  ok(!/^\s*import\s+subprocess\b/m.test(py), "不靠外部 ffmpeg 子进程（venv 内没有 ffmpeg.exe）");

  /* [14b] 宿主选路 / 执行（源码级 + 纯函数真跑） */
  has(mainH3Src, 'const POST_STREAM_INTERP_SCRIPT = "stream_interp.py"', "补帧脚本名有常量（不散落字面量）");
  has(mainH3Src, "const POST_RIFE_WEIGHT_PREFERENCE", "RIFE 权重优先序有常量（与脚本内 RIFE_WEIGHT_PREFERENCE 一字对齐）");
  has(mainH3Src, "function streamInterpScriptPath(", "补帧脚本定位有独立函数");
  has(fnBody(mainH3Src, "streamInterpScriptPath"), "bundledPackRoot()", "打包态从 resourcesPath/h3-pack 取（同 bundledPackRoot 口径）");
  has(fnBody(mainH3Src, "streamInterpScriptPath"), "runtimePackRoot()", "再兜运行时更新包");
  has(mainH3Src, "function streamInterpWeightsPath(", "RIFE 权重探测有独立函数（选路要用）");
  has(fnBody(mainH3Src, "streamInterpWeightsPath"), "streamInterpWeightsCache", "权重探测结果进程内缓存（不每单选路都 stat）");
  has(fnBody(mainH3Src, "streamInterpWeightsPath"), "POST_RIFE_WEIGHT_PREFERENCE", "权重按官方文件名优先序探测");
  has(mainH3Src, "function runStreamInterpJob(", "有 spawn 子进程的流式补帧执行函数");
  const runIp = fnBody(mainH3Src, "runStreamInterpJob");
  has(runIp, "spawn(String(j.py), args", "真 spawn venv python");
  has(runIp, '"--multiplier"', "把补帧倍率传给脚本");
  has(runIp, '"--max-long-side"', "把预缩放长边传给脚本");
  has(runIp, '"--precision"', "把精度传给脚本");
  has(runIp, '"--model"', "宿主已探到权重就显式传给脚本");
  has(runIp, '"--comfy-root"', "同时兜 --comfy-root 让脚本自己也能找");
  has(runIp, 'child.stdin.write("cancel\\n")', "取消时向 stdin 写 cancel");
  has(runIp, "child.kill()", "取消时终止子进程");
  has(runIp, "activeGenerate.streamKill = killChild", "kill 挂到 activeGenerate（用户点停止能中断）");
  has(runIp, "emitProgress({", "stdout JSON 进度转 emitProgress");
  has(runIp, 'ev.type === "progress"', "认 progress 事件");
  has(runIp, "err.oom = code === 3", "退出码 3 / oom 标记 → err.oom（供上层降档）");
  has(runIp, "err.streamCancelled = true", "取消单独标记，不走失败回退");
  has(runIp, "peakRamMb", "进度里带峰值内存（控制台可读）");
  const postSlice14 = mainH3Src.split("async function postProcessVideo(params)")[1].split('ipcMain.handle("h3:postProcess"')[0];
  has(postSlice14, "resolvePostEngine(kind, opts, {", "postProcessVideo 用纯函数选路");
  has(postSlice14, "补帧引擎 = ", "控制台打印补帧选路结论");
  has(postSlice14, "→ 已回退图路径", "回退图路径时在控制台写明原因");
  has(postSlice14, "缺流式脚本", "缺脚本的回退日志带上具体路径");
  has(postSlice14, "缺 ComfyUI venv 解释器", "缺 venv 的回退日志带上具体路径");
  has(postSlice14, "缺 RIFE 权重，已搜 ", "缺权重的回退日志带上搜过的目录");
  has(postSlice14, "runStreamInterpJob({", "流式补帧分支真跑脚本");
  has(postSlice14, "流式补帧未出片（", "流式补帧失败写明原因");
  has(postSlice14, "downgradePostOptions(kind, opts)", "流式补帧 OOM 也走降档（重试一次）");
  has(postSlice14, "流式补帧 OOM → 降一档重试（精度 fp32）", "流式补帧降档只落 fp32（倍率不动）");
  const ipStreamBlock = postSlice14
    .split('if (kind === "interp" && opts.engine === "stream")')[1]
    .split("/* ── ComfyUI 图路径")[0];
  hasnt(ipStreamBlock, "uploadFileToComfy", "流式补帧分支不上传源视频（PyAV 直读）");

  /* [14c] 流式补帧档不做任何降档；降档函数对补帧流式档只落 fp32 */
  const W = { fs, path, join: path.join, os: require("os"), process, Buffer, Math, Number, String, Object, JSON, console, setTimeout, clearInterval, setInterval };
  vm.runInNewContext(
    [
      `const CONTAINER_BOXES = ${/const CONTAINER_BOXES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      constBlock(mainH3Src, "POST_MODELS"),
      constBlock(mainH3Src, "POST_SAFE_DEFAULTS"),
      `const POST_UPSCALE_SCALES = ${/const POST_UPSCALE_SCALES = (\[[^\]]*\])/.exec(mainH3Src)[1]};`,
      `const POST_TARGET_LONG_SIDE_MIN = ${/const POST_TARGET_LONG_SIDE_MIN = (\d+)/.exec(mainH3Src)[1]};`,
      `const POST_RAM_RESERVE_GB = ${/const POST_RAM_RESERVE_GB = (\d+)/.exec(mainH3Src)[1]};`,
      `const BYTES_PER_F32_PX = ${/const BYTES_PER_F32_PX = (\d+)/.exec(mainH3Src)[1]};`,
      extract(mainH3Src, [
        "postDimsForLongSide",
        "normalizeUpscaleScale",
        "upscaleFactorOfModel",
        "upscaleOutputLongSide",
        "findBoxDeep",
        "readMoovMeta",
        "probeMp4Meta",
        "systemRamGb",
        "planGbText",
        "estimateUpscaleRamGb",
        "estimatePostPeakRamGb",
        "resolveUpscaleRamPlan",
      ]),
    ].join("\n"),
    W,
    { filename: "video-post-interp-stream-plan-extract.js" },
  );
  const tmp4 = fs.mkdtempSync(path.join(require("os").tmpdir(), "h3interp-"));
  const clip4 = path.join(tmp4, "clip.mp4");
  fs.writeFileSync(clip4, POST_MK_MP4(1920, 1080, 300)); /* 与 [11] 同形状：1920×1080 · 300 帧 */
  const planIp = W.resolveUpscaleRamPlan({ sourcePath: clip4, multiplier: 4, engine: "stream" }, 1920, 1080);
  eqNum(planIp.stream, true, "流式补帧档被内存闸识别（plan.stream）");
  eqNum(planIp.downgraded, false, "流式补帧档不做任何降档（内存与时长无关）");
  eqNum(planIp.opts.multiplier, 4, "流式补帧档保留用户倍率（不被内存策略降成 2x）");
  eqNum(planIp.opts.engine, "stream", "流式补帧档仍在流式档");
  eqNum(planIp.opts.preScale, undefined, "流式补帧档不做 preScale 预缩放");
  eqNum(planIp.afterGb, planIp.beforeGb, "afterGb 只是旧图链口径的对照数字");
  ok(
    planIp.beforeGb > planIp.budgetGb,
    "同一源在旧图链口径下确实超预算（" + planIp.beforeGb + "G > " + planIp.budgetGb + "G）——正是补帧把 64G 跑满的成因",
  );
  ok(planIp.frames === 300 && planIp.meta && planIp.meta.width === 1920, "流式补帧档仍照旧读容器元数据（帧数 / 分辨率进日志）");
  has(fnBody(mainH3Src, "downgradePostOptions"), 'String(opts.engine || "") === "stream"', "降档按引擎分流（流式补帧先判流式）");
  has(fnBody(mainH3Src, "downgradePostOptions"), "precision: \"fp32\"", "流式补帧 OOM 降档落 fp32");
  has(mainH3Src, "常驻内存只与相邻两帧 + 模型有关", "控制台写明流式补帧档的内存口径");
  fs.rmSync(tmp4, { recursive: true, force: true });

  /* [14d] 前端节点 / i18n / 指南同步 */
  const ndBlock14 = (() => {
    const at = appSrc.indexOf("const NODE_DEFAULTS = {");
    const end = appSrc.indexOf("\n};", at);
    return at < 0 ? "" : appSrc.slice(at, end);
  })();
  const ipDef14 = (ndBlock14.match(/video_interp:\s*\{([\s\S]*?)\n  \},/) || [null, ""])[1];
  has(ipDef14, "multiplier: 2", "补帧倍率档位保留（默认 2x）");
  has(ipDef14, 'precision: "fp16"', "video_interp 默认 precision = fp16（流式档精度默认值）");
  has(ipDef14, "lowVram: true", "低显存安全档默认开");
  has(appSrc, "16G 内存也能跑 15 秒级视频", "补帧节点注释写明 16G 可用");
  has(appSrc, "常驻内存只与相邻两帧有关、与视频时长无关", "补帧节点注释写明内存与时长无关");
  const postParams14 = fnBody(nodesSrc, "buildVideoPostRunParams");
  has(postParams14, 'engine: node.engine === "graph" ? "graph" : "stream"', "透传 engine（默认流式，显式 graph 才走旧链）");
  has(postParams14, 'node.precision === "fp16" || node.precision === "fp32"', "透传 precision（空串交给宿主按显存决定）");
  has(postParams14, "lowVram: node.lowVram !== false", "lowVram 仍照旧透传");
  has(postParams14, "multiplier: Number(node.multiplier) || 2", "补帧倍率字段名未改");
  has(canvasSrc, "补帧倍率 / 精度 / 逐帧流式", "设置窗标题改为流式口径");
  has(canvasSrc, "低精度 fp16 省显存，16G 机器也能跑 15 秒片", "补帧安全档说明改为流式口径");
  has(canvasSrc, "逐帧流式补帧：常驻内存只与相邻两帧有关", "设置窗底部提示改为流式口径");
  has(i18nSrc, '"补帧倍率 / 精度 / 逐帧流式"', "i18n 真源同步为流式口径");
  has(i18nSrc, '"逐帧流式补帧：常驻内存只与相邻两帧有关，与视频时长无关，16G 机器也能跑 15 秒级视频；4x 倍率同样不再受内存限制，只是耗时更长。"', "i18n 写明内存与时长无关 / 16G 可用");
  has(i18nSrc, '"低精度 fp16 省显存，16G 机器也能跑 15 秒片；关闭后按更高精度跑，更快但更吃显存"', "补帧安全档新词条有英文译文");
  has(i18nSrc, '"源视频 → 逐帧流式 RIFE 补帧（fps 按倍数重算）"', "状态行文案同步为流式口径");
  const gIp = read("guides/nodes/video_interp.md");
  const gIpEn = read("guides/nodes/en/video_interp.md");
  has(gIp, "stream_interp.py", "中文指南写明流式补帧脚本");
  has(gIp, "相邻两帧 + 模型", "中文指南写明内存只与相邻两帧有关");
  has(gIp, "16G 内存也能完成 15 秒级视频的 2x / 4x 补帧", "中文指南写明 16G 可用");
  has(gIp, "已回退图路径", "指南写明只在兜底时才回旧口径");
  hasnt(gIp, "必须大内存机器", "删掉「必须大内存机器」的错误引导");
  hasnt(gIp, "先补到 2x", "删掉「4x 先补到 2x」的旧引导");
  hasnt(gIpEn, "big-memory machine", "英文指南同样删掉大内存引导");
  has(gIpEn, "a 16 GB machine can do 2x / 4x interpolation", "英文指南写明 16 GB 可用");
  const wm14 = read("guides/nodes/_write.mjs");
  has(wm14, "stream_interp.py", "指南生成器模板同步（重生成不会回滚成旧口径）");
  has(wm14, "16G 内存也能完成 15 秒级视频的 2x / 4x 补帧", "生成器模板保留 16G 可用口径");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);
"use strict";
/* ============ FLUX 3 Image Klein（flux3klein_gen）节点执行体 ============
 *
 * 与「图像生成」(proc_image) 同口径的那几条：
 *   · 端子 0 = 提示词入口（接线即提示词，支持 @ 引用 / Tag / 全局广播图）；
 *     端子 1 = 参考图（可接多张，最多 10 张，接了就是图像编辑）；端子 2 = 控制入。
 *   · 输出 0 = 图像（{kind:"image", path}），输出 1 = 控制出（出图完成后触发）。
 *   · 抽卡 1–10 次、种子 +1 摇数、蒙版局部重绘、透明背景双通道差分抠图，
 *     这四项与云端文生图是同一套语义（同一批共享函数），只是把请求换成宿主。
 *
 * 与云端不同的地方（本机后端决定的）：
 *   · 画幅只走比例桶（1:1 / 16:9 / 3:2 / 4:3 / 2:3 / 3:4 / 9:16，默认长边 1024、上限 2048），
 *     不再有服务商 size 列表 / 画幅锁定 / 质量与背景直传参数。
 *   · 蒙版重绘由 ComfyUI 原生做（VAEEncode + SetLatentNoiseMask），出图后仍按蒙版把
 *     未涂抹区域的像素换回底图（官方口径的后处理，见 flux3kleinRestickMask）。
 *   · 透明背景 = 两通道（先黑底基准、再拿基准当唯一参考图换纯白），2N 张图；
 *     Flux 没有「直出 Alpha」的参数，所以只有差分这一条路。
 */

/** 比例桶 → 像素（长边 1024 档，16 的倍数；与宿主 buildGraph 的 align16 一致） */
const FLUX3KLEIN_RATIOS = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "3:2": [1248, 832],
  "4:3": [1152, 896],
  "2:3": [832, 1248],
  "3:4": [896, 1152],
  "9:16": [768, 1344],
};
const FLUX3KLEIN_MAX_REFS = 10;
const FLUX3KLEIN_MATTE_HEAD = "\n\n[[MTNODE-MATTE-PASS]]";
const FLUX3KLEIN_MATTE_TAIL = "[[/MTNODE-MATTE-PASS]]";
const FLUX3KLEIN_MASK_HEAD = "\n\n[[MTNODE-MASK-PASS]]";
const FLUX3KLEIN_MASK_TAIL = "[[/MTNODE-MASK-PASS]]";

/** 参考图在 Flux 3 提示词里的官方指代是 <ref_image_0>…；缺了就补上，
 *  否则模型常把参考图当成要复刻的成品，忽略「换场景 / 换动作」的文字要求。 */
function flux3kleinTagRefs(prompt, count) {
  const tags = [];
  for (let i = 0; i < count; i++) {
    const tag = "<ref_image_" + i + ">";
    if (prompt.indexOf(tag) < 0) tags.push(tag);
  }
  return tags.length ? tags.join(" ") + "\n" + prompt : prompt;
}

function flux3kleinRatioOf(node) {
  const r = String((node && node.ratioBucket) || "").trim();
  return FLUX3KLEIN_RATIOS[r] ? r : "1:1";
}

/** 节点字段归一（旧画布 / 新拖出来的节点都走这里，别在别处再抄一份默认值） */
function flux3kleinNormalize(node) {
  if (!node) return null;
  const ratio = flux3kleinRatioOf(node);
  const wh = FLUX3KLEIN_RATIOS[ratio];
  node.ratioBucket = ratio;
  /* 宽高只由比例桶决定：旧画布残留的 9:16 宽高不能压过当前选的 16:9。
     蒙版重绘会在执行时按底图原尺寸重新覆盖，不受这里影响。 */
  node.width = wh[0];
  node.height = wh[1];
  const steps = Number(node.steps);
  node.steps = Number.isFinite(steps) ? Math.max(1, Math.min(60, Math.round(steps))) : 16;
  const cfg = Number(node.cfg);
  node.cfg = Number.isFinite(cfg) ? Math.max(0, Math.min(10, cfg)) : 1;
  node.precision = String(node.precision || "int8") === "bf16" ? "bf16" : "int8";
  node.rolls = Math.max(1, Math.min(10, Math.round(Number(node.rolls) || 1)));
  if (node.rerollSeed == null) node.rerollSeed = true;
  if (node.maskOn == null) node.maskOn = false;
  if (node.bgRmOn == null) node.bgRmOn = false;
  const tol = Number(node.bgRmTol);
  node.bgRmTol = Number.isFinite(tol) ? Math.max(0, Math.min(128, Math.round(tol))) : 10;
  const soft = Number(node.bgRmSoft);
  node.bgRmSoft = Number.isFinite(soft) ? Math.max(0, Math.min(128, Math.round(soft))) : 32;
  if (node.bgRmAlign == null) node.bgRmAlign = true;
  if (!Array.isArray(node.bgRmPairs)) node.bgRmPairs = [];
  return node;
}

/** 把正文里「独立成词」的节点标题就地换成某段来源正文（@ 命中的文本来源用）。
 *  Flux 3 Klein 是图像模型：它在正文里读到节点标题（「文本节点」）时不会去别处找内容，
 *  只会照着参考图描一遍。所以 @标题 必须展开成那段文本本身。 */
function flux3kleinExpandTitle(text, title, repl) {
  if (!title) return { text, hit: false };
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bar = "[\\s，。、；：！？,.;:!?()（）\\[\\]【】]";
  const re = new RegExp("(^|" + bar + ")" + esc + "(?=$|" + bar + ")", "g");
  let hit = false;
  const out = String(text).replace(re, (m, p1) => {
    hit = true;
    return p1 + repl;
  });
  return { text: out, hit };
}

/** 提示词：本机图像模型吃的是「这一张图的一句话说明」，所以**正文原样下发** ——
 *  接线文本 → resolveRefs（@ 引用 / 全局广播）→ 其余来源按段落平铺。
 *  不要再套 assemblePrompt 的「【背景信息】/### 标题/【内容】」框架：真机实测（2026-10，INT8/BF16
 *  1344×768 同种子同参考图 A/B）套了框架的输出与参考图几乎一模一样 —— 加了提示词也不换场景，
 *  同一段正文去掉框架后立刻按提示词重建画面。同一段文本也只会贴一次（旧口径正文与背景块各来一遍）。 */
function flux3kleinPromptText(node) {
  const ins = inputValuesFor(node, 0);
  const wired = [];
  for (const it of ins) {
    const v = it && it.value;
    if (v && v.kind === "text" && String(v.text || "").trim())
      wired.push({ title: String((it && it.title) || I18n.t("输入")), text: String(v.text) });
  }
  const own = String(node.prompt || "").trim();
  const base = own || (wired.length ? wired[0].text : "");
  if (!base.trim()) return "";
  let refs = null;
  try {
    refs = resolveRefs(base, node, 0);
  } catch {
    refs = null;
  }
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  let core = String((refs && refs.prompt) || base).trim();
  const seen = new Set([norm(core)]);
  const blocks = [];
  const sources = ((refs && refs.textSources) || []).concat(own ? wired : wired.slice(1));
  for (const s of sources) {
    const t = String((s && s.text) || "").trim();
    if (!t) continue;
    /* @标题 已经被 resolveRefs 换成了标题：就地换回那段正文，且不再当独立段落重复贴一遍 */
    const r = flux3kleinExpandTitle(core, String((s && s.title) || "").trim(), t);
    if (r.hit) {
      core = r.text.trim();
      seen.add(norm(core));
      continue;
    }
    if (seen.has(norm(t))) continue;
    seen.add(norm(t));
    blocks.push(t);
  }
  return blocks.length ? core + "\n\n" + blocks.join("\n\n") : core;
}

/** 本次运行实际会下发的参考图（端子 1 的连线图 + @ 引用图 + 未连线的全局广播图） */
function flux3kleinRefPaths(node) {
  const images = [];
  for (const it of inputValuesFor(node, 1)) {
    const v = it && it.value;
    if (v && v.kind === "image" && v.path) images.push(v.path);
  }
  let refs = null;
  try {
    refs = resolveRefs(flux3kleinPromptText(node), node, 1);
  } catch {
    refs = null;
  }
  let list = images;
  try {
    list = runImagePaths(node, 1, refs, images);
  } catch {
    list = images;
  }
  const seen = new Set();
  const out = [];
  for (const p of list || []) {
    const s = String(p || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= FLUX3KLEIN_MAX_REFS) break;
  }
  return out;
}

function flux3kleinMaskActive(node) {
  return !!(node && node.maskOn && String(node.maskPath || "").trim());
}

function flux3kleinMatteActive(node) {
  return !!(node && node.bgRmOn) && !flux3kleinMaskActive(node);
}

/** 透明背景第 1 通道（纯黑基准）注入段：文案与云端文生图同一段，只换节点类型判定 */
function flux3kleinMatteSuffix1(node) {
  if (!flux3kleinMatteActive(node)) return "";
  return (
    FLUX3KLEIN_MATTE_HEAD +
    "\n" +
    I18n.t(
      "【透明背景 · 双通道差分抠图｜第 1 通道（基准）：纯黑背景】请把画面中除主体以外的全部背景区域（含天空、地面、投影、环境细节）绘制成完全均匀的纯黑 #000000：无渐变、无纹理、无阴影、无反射、无暗角、无地面投影。主体保持完整清晰，边缘锐利干净，构图居中稳定、四周留出一圈空白边距，主体不得触碰或超出画面边缘。这一张是本次抠图的唯一基准：随后会严格复刻它、只替换背景色来求 Alpha，因此请按最终成品的标准画好主体。",
    ) +
    "\n" +
    FLUX3KLEIN_MATTE_TAIL
  );
}
function flux3kleinMatteSuffix2(node) {
  if (!flux3kleinMatteActive(node)) return "";
  return (
    FLUX3KLEIN_MATTE_HEAD +
    "\n" +
    I18n.t(
      "【透明背景 · 双通道差分抠图｜第 2 通道：纯白背景】请把参考图的背景整体替换为完全均匀的纯白 #FFFFFF：无渐变、无纹理、无光晕、无投影。参考图是本次任务的唯一基准，除背景颜色以外，画面的一切内容必须与它逐像素完全一致——主体的位置、大小、比例、朝向、姿态、轮廓、颜色、纹理、细节、光照、构图与画幅都不得有任何变化；不要重绘主体，不要移动，不要缩放，不要裁切，不要加边框。",
    ) +
    "\n" +
    FLUX3KLEIN_MATTE_TAIL
  );
}
function flux3kleinMaskSuffix(node) {
  if (!flux3kleinMaskActive(node)) return "";
  return (
    FLUX3KLEIN_MASK_HEAD +
    "\n" +
    I18n.t(
      "【蒙版局部重绘 · 只编辑蒙版透明区域】本次请求带有蒙版，蒙版的透明区域就是唯一允许编辑的区域，不透明区域不在本次编辑范围内。只把透明区域内的内容按提示词修改；其余区域的构图、透视、物体位置与大小、轮廓、光线方向与色温、景深、整体色调、材质细节必须完全不变，不裁切、不缩放、不旋转、不平移。新内容要与现场光照、遮挡、接触关系自然融合，边缘干净，不留蒙版边界痕迹。",
    ) +
    "\n" +
    FLUX3KLEIN_MASK_TAIL
  );
}

/** 读图片像素尺寸（蒙版 / 缩放画幅要用它把宽高钉死） */
function flux3kleinImageSize(path) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = fileUrlWithBust(path, String(Date.now()));
  });
}

function flux3kleinStatus(node, msg) {
  node.flux3kleinStatus = msg;
  node.sensenovaStatus = msg;
}

/** 蒙版外像素回贴：ComfyUI 的 latent 蒙版同样会往蒙版外渗一点，出图后按蒙版把外面换回底图 */
async function flux3kleinRestickMask(node, outPath, basePath) {
  const maskPath = String(node.maskPath || "").trim();
  if (!maskPath || !basePath || !outPath) return outPath;
  try {
    if (typeof readImageRGBA !== "function") return outPath;
    const base = await readImageRGBA(basePath);
    const gen = await readImageRGBA(outPath);
    const mask = await readImageRGBA(maskPath);
    const w = gen.w;
    const h = gen.h;
    if (!w || !h || base.w !== w || base.h !== h || mask.w !== w || mask.h !== h) return outPath;
    const plane = maskAlphaPlaneOf(mask.id, w, h);
    /* 1) 二值化：alpha < 128 = 可编辑；2) 腐蚀 2px 把边界还给原图；3) 3×3 羽化这一圈 */
    const editable = new Uint8Array(w * h);
    for (let i = 0; i < editable.length; i++) editable[i] = plane[i] < 128 ? 255 : 0;
    const eroded = boxExtremum(editable, w, h, 2, true);
    const feathered = boxBlurPlane(eroded, w, h);
    for (let i = 0, p = 0; i < feathered.length; i++, p += 4) {
      const a = feathered[i] / 255;
      for (let c = 0; c < 3; c++)
        gen.id.data[p + c] = Math.round(gen.id.data[p + c] * a + base.id.data[p + c] * (1 - a));
      gen.id.data[p + 3] = 255;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").putImageData(gen.id, 0, 0);
    const b64 = canvas.toDataURL("image/png").split(",")[1];
    const res = await window.api.assetWriteBase64(
      (S.wf && S.wf.id) || "",
      "flux3klein_restick_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      b64,
      "png",
    );
    if (!res || !res.ok || !res.path) return outPath;
    return res.path;
  } catch {
    return outPath;
  }
}

/** 一次请求（宿主负责上传 / 排队 / 轮询 / 落盘）；返回 { ok, path, seconds } */
function flux3kleinRunOnce(node, params) {
  return window.api.flux3kleinGenerate(params);
}

async function playFlux3KleinNode(node, quiet) {
  if (!window.api || !window.api.flux3kleinGenerate) {
    toast(I18n.t("FLUX 3 Image Klein 插件未就绪：请在顶栏「插件」里安装并启用"), "err");
    return;
  }
  if (node.running && !node._prestart) return;
  if (typeof mediaRunStopped === "function" && mediaRunStopped(node)) {
    if (typeof mediaGenMarkDropped === "function") mediaGenMarkDropped(node, false);
    return;
  }
  flux3kleinNormalize(node);

  /* 全局互斥：本机大模型（音乐 / 视频 / 图像）同时只跑 1 个 */
  try {
    const lk = typeof fetchMediaGenLock === "function" ? await fetchMediaGenLock() : null;
    if (lk && lk.nodeId && lk.nodeId !== node.id) {
      node.error = mediaGenLockBusyMsg(lk);
      node._busyErrAt = Date.now();
      flux3kleinStatus(node, node.error);
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch {}

  let basePrompt = flux3kleinPromptText(node).trim();
  if (!basePrompt) {
    node.error = I18n.t("提示词为空：请接入文本输入（端子 0）或在节点里填写提示词");
    flux3kleinStatus(node, node.error);
    if (!quiet) toast(node.error, "warn");
    renderCanvas();
    return;
  }

  const refs = flux3kleinRefPaths(node);
  if (refs.length) basePrompt = flux3kleinTagRefs(basePrompt, refs.length);
  /* Klein 是「整段画面描述」驱动的蒸馏编辑模型：给了参考图、提示词却只有几个字时，
     它会把参考图原样（或多姿态拼图）复刻出来，看着就像「提示词没生效」。本机没有提示词
     增强器（不做 upsampler），所以这里只提醒用户补成一句话，不擅自改他写的正文。 */
  const promptChars = basePrompt.replace(/<ref_image_\d+>/g, "").replace(/\s+/g, " ").trim().length;
  if (refs.length && promptChars > 0 && promptChars < 30) {
    if (!quiet)
      toast(
        I18n.t("提示词太短：FLUX 3 Klein 要成句的画面描述（主体＋动作＋场景＋光线），几个字的短语会直接复刻参考图"),
        "warn",
      );
  }
  const maskOn = flux3kleinMaskActive(node);
  const matteOn = flux3kleinMatteActive(node);
  let width = Number(node.width) || FLUX3KLEIN_RATIOS[flux3kleinRatioOf(node)][0];
  let height = Number(node.height) || FLUX3KLEIN_RATIOS[flux3kleinRatioOf(node)][1];

  /* 蒙版重绘：画幅必须与底图一致（mask 只对第 1 张图生效） */
  if (maskOn) {
    if (!refs.length) {
      node.error = I18n.t("蒙版重绘需要一张底图：请把要重绘的图接到端子 1（蒙版按它的原尺寸绘制）");
      flux3kleinStatus(node, node.error);
      if (!quiet) toast(node.error, "err");
      renderCanvas();
      return;
    }
    const size = await flux3kleinImageSize(refs[0]);
    if (size.w > 0 && size.h > 0) {
      width = Math.round(size.w / 16) * 16;
      height = Math.round(size.h / 16) * 16;
      node.width = width;
      node.height = height;
    }
  }

  const nRolls = Math.max(1, Math.min(10, Math.round(Number(node.rolls) || 1)));
  const ui0 = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
  if (ui0) {
    ui0.ok = null;
    ui0.genPct = 2;
    ui0.genMsg = I18n.t("启动后端并生成…");
  }
  node.running = true;
  node.error = null;
  if (typeof beginNodeRun === "function") beginNodeRun(node);
  node.genRollDone = 0;
  node.genPaths = [];
  flux3kleinStatus(node, I18n.t("启动后端并生成…"));
  if (typeof startMediaBackendRunWatcher === "function") startMediaBackendRunWatcher(node);
  renderCanvas();

  const t0 = Date.now();
  let okCount = 0;
  let lastPath = "";
  const warnings = [];
  const baseName = "flux3klein_" + node.id.slice(-6);

  const call = async (prompt, pRefs, seed, withMask) => {
    const r = await flux3kleinRunOnce(node, {
      nodeId: node.id,
      canvasWorkflowId: (S.wf && S.wf.id) || "",
      prompt,
      negative: String(node.negative || ""),
      width,
      height,
      steps: Number(node.steps) || 16,
      cfg: Number(node.cfg) || 0,
      seed,
      precision: node.precision || "int8",
      refs: pRefs,
      maskPath: withMask ? String(node.maskPath || "") : "",
    });
    return r || { ok: false, error: "generate_failed" };
  };

  try {
    for (let roll = 1; roll <= nRolls; roll++) {
      if (typeof mediaRunStopped === "function" && mediaRunStopped(node)) break;
      const seed =
        typeof nextMediaGenSeed === "function"
          ? nextMediaGenSeed(node)
          : Math.floor(Math.random() * 1e9);
      node.genRollDone = roll - 1;
      {
        const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
        if (ui) {
          ui.genPct = 8;
          ui.genMsg =
            (typeof mediaGenRollProgressTag === "function" ? mediaGenRollProgressTag(node) : "") +
            I18n.t("生成中…");
        }
        flux3kleinStatus(node, ui ? ui.genMsg : I18n.t("生成中…"));
      }
      renderCanvas();

      /* 第 1 次：黑底基准（或普通出图 / 蒙版重绘） */
      const prompt1 = basePrompt + (matteOn ? flux3kleinMatteSuffix1(node) : "") + (maskOn ? flux3kleinMaskSuffix(node) : "");
      const r1 = await call(prompt1, refs, seed, maskOn);
      if (node._aborted || (r1 && (r1.error === "cancelled" || r1.cancelled))) {
        node.error = null;
        flux3kleinStatus(node, I18n.t("已取消"));
        return;
      }
      if (!r1 || !r1.ok) {
        const code = String((r1 && r1.error) || "generate_failed");
        node.error = flux3kleinErrorText(code, r1 && (r1.message || r1.detail));
        flux3kleinStatus(node, node.error);
        if (typeof looksLikeBackendConnError === "function" && looksLikeBackendConnError(code))
          markMediaBackendDown(node, r1);
        if (!quiet) toast(node.error, "err");
        return;
      }
      let outPath = String(r1.path || "");
      if (Number(r1.seconds) > 0) {
        const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
        if (ui) {
          ui.info = ui.info || {};
          ui.info.lastSeconds = Number(r1.seconds);
        }
      }
      if (!outPath) {
        node.error = I18n.t("后端没有回传图像路径");
        flux3kleinStatus(node, node.error);
        if (!quiet) toast(node.error, "err");
        return;
      }

      /* 蒙版：把未涂抹区域换回底图（官方口径的后处理） */
      if (maskOn) outPath = await flux3kleinRestickMask(node, outPath, refs[0]);

      /* 透明背景：第 2 通道（纯白），以第 1 通道为唯一参考图，然后差分出 Alpha */
      if (matteOn) {
        try {
          const r2 = await call(basePrompt + flux3kleinMatteSuffix2(node), [outPath], seed, false);
          if (!r2 || !r2.ok) throw new Error(String((r2 && (r2.message || r2.error)) || "second_pass_failed"));
          const white = String(r2.path || "");
          if (!white) throw new Error("second_pass_no_path");
          const alphaName = baseName + "_" + roll + "_alpha_" + Date.now().toString(36);
          const alphaPath = await differenceMatteAssetPath(node, white, outPath, alphaName);
          if (typeof rememberMattePair === "function") rememberMattePair(node, white, outPath, alphaPath);
          node.genPaths.push(white);
          outPath = alphaPath;
        } catch (e) {
          warnings.push(I18n.t("透明背景抠图未完成，已交付黑底基准图：") + ((e && e.message) || String(e)));
        }
      }

      okCount++;
      lastPath = outPath;
      node.genPaths.push(outPath);
      node.output = { kind: "image", path: outPath };
      node.ranAt = Date.now();
      node.genRollDone = roll;
      if (Array.isArray(r1.warnings)) for (const w of r1.warnings) if (w) warnings.push(String(w));
    }

    if (node._aborted) {
      node.error = null;
      flux3kleinStatus(node, I18n.t("已取消"));
      return;
    }
    if (!okCount) return;
    let done =
      typeof mediaGenDoneMsg === "function"
        ? mediaGenDoneMsg(Date.now() - t0)
        : (Date.now() - t0) / 1000 + "s";
    if (matteOn) done += " · " + I18n.t("透明背景（双通道差分）");
    if (warnings.length) done += " · " + warnings[0];
    flux3kleinStatus(node, done);
    const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
    if (ui) {
      ui.genPct = 100;
      ui.genMsg = done;
    }
    if (!quiet) {
      toast(
        nRolls > 1
          ? I18n.t("图像已生成：") + okCount + "/" + nRolls + I18n.t(" 次")
          : I18n.t("图像已生成：") + lastPath,
        "ok",
      );
      if (warnings.length) toast(warnings.join(" / "), "warn");
    }
  } catch (e) {
    if (node._aborted) {
      node.error = null;
      flux3kleinStatus(node, I18n.t("已取消"));
    } else {
      node.error = (e && e.message) || String(e);
      flux3kleinStatus(node, node.error);
      if (!quiet) toast(node.error, "err");
    }
  } finally {
    const wasStopped = typeof mediaRunStopped === "function" && mediaRunStopped(node);
    node.running = false;
    node._aborted = false;
    if (typeof stopMediaBackendRunWatcher === "function") stopMediaBackendRunWatcher(node.id);
    if (typeof refreshMediaNodeUi === "function") refreshMediaNodeUi(node, { soft: true });
    renderCanvas();
    if (typeof scheduleSave === "function") scheduleSave();
    if (!wasStopped && typeof nodeHasOutputContent === "function" && nodeHasOutputContent(node))
      await fireControlOutgoing(node, 1, new Set([node.id]));
  }
}

/** 错误码 → 人话（与其它本机图像节点同一口径；未知码原样回传） */
function flux3kleinErrorText(code, detail) {
  const d = detail ? "：" + String(detail).slice(0, 200) : "";
  switch (String(code || "")) {
    case "not_installed":
      return I18n.t("FLUX 3 Image Klein 未安装：请在「插件 · FLUX 3 Image Klein」里安装后再试");
    case "no_venv":
      return I18n.t("后端依赖未装好（缺 Python 环境）：请在插件控制台重跑安装");
    case "no_cuda":
      return I18n.t("本机没有可用的 NVIDIA 显卡：FLUX 3 Image Klein 本机推理需要一张 N 卡");
    case "low_disk":
      return I18n.t("磁盘空间不足：请换一个剩余空间够的安装目录");
    case "backend_start_failed":
      return I18n.t("后端启动失败：请打开插件控制台日志查看具体原因");
    case "backend_unreachable":
      return I18n.t("连不上本地 ComfyUI（127.0.0.1:8197）：请在插件里关闭后重新开启");
    case "backend_start_timeout":
      return I18n.t("后端启动超时（首次加载权重较慢）：请稍后重试 ▶");
    case "generate_timeout":
      return I18n.t("生成超时：步数过大或显存频繁换入换出，请降低步数后重试");
    case "busy_media":
      return I18n.t("已有音视频生成任务进行中（全局仅 1 个，禁止并行），请等待完成后再试");
    case "busy":
      return I18n.t("后端正忙（同时只跑一张图），请等待当前任务结束");
    case "cancelled":
      return I18n.t("已取消");
    case "empty_prompt":
      return I18n.t("提示词为空：请接入文本输入或在节点里填写提示词");
    case "generate_failed":
      return I18n.t("图像生成失败" + d);
    default:
      return String(code || "flux3klein_error") + d;
  }
}

/* ═══════════ ⚙ 设置窗 ═══════════ */
function flux3kleinParamSummary(node) {
  flux3kleinNormalize(node);
  const bits = [String(node.ratioBucket)];
  bits.push(String(Number(node.steps) || 16) + I18n.t(" 步"));
  bits.push(node.precision === "bf16" ? "BF16" : "INT8");
  if (flux3kleinMaskActive(node)) bits.push(I18n.t("蒙版重绘"));
  if (node.bgRmOn) bits.push(I18n.t("透明背景"));
  if (Number(node.rolls) > 1) bits.push(I18n.t("抽卡 ") + String(node.rolls));
  return bits.join(" · ");
}

/* 节点 body 里的只读摘要（两行：生成参数 / 后处理开关）——与 SenseNova 图像节点同族写法 */
function appendFlux3KleinSummaryBody(node, body) {
  if (typeof appendNodeSettingsSummary !== "function") return;
  flux3kleinNormalize(node);
  appendNodeSettingsSummary(node, body, {
    slots: [
      {
        id: "mgbucket-" + node.id,
        label: I18n.t("尺寸"),
        value: String(node.width) + "×" + String(node.height),
      },
      { label: I18n.t("精度"), value: node.precision === "bf16" ? "BF16" : "INT8" },
      { label: I18n.t("步数"), value: String(Number(node.steps) || 16) },
      { id: "mgrolls-" + node.id, label: I18n.t("抽卡"), value: String(Number(node.rolls) || 1) },
      { id: "mgseed-" + node.id, label: I18n.t("种子"), value: String(Number(node.seed) || 0) },
    ],
    cls: "mg-sum",
  });
  appendNodeSettingsSummary(node, body, {
    slots: [
      { label: I18n.t("蒙版重绘"), value: flux3kleinMaskActive(node) ? "on" : "off" },
      { label: I18n.t("透明背景"), value: node.bgRmOn ? "on" : "off" },
      { label: I18n.t("参考图"), value: String(flux3kleinRefPaths(node).length) },
    ],
    cls: "mg-sum",
  });
}

function flux3kleinMattePanel(ctx, node) {
  ctx.section(I18n.t("透明背景（双通道差分）"));
  nsCheck(
    ctx,
    I18n.t("开启透明背景"),
    !!node.bgRmOn,
    (v) => {
      node.bgRmOn = !!v;
    },
    null,
  );
  ctx.hint(
    I18n.t(
      "Flux 没有「直出 Alpha」参数：开启后每张图会跑两遍（先黑底基准，再拿基准当唯一参考图换纯白），两图逐像素差分出透明通道；抽卡 N 次就是 2N 张图。",
    ),
  );
  nsNumber(
    ctx,
    I18n.t("抠图噪点地板"),
    Number(node.bgRmTol),
    { min: 0, max: 128, step: 1, fallback: 10, title: I18n.t("越大越敢把半透明像素判成完全透明；默认 10") },
    (v) => {
      node.bgRmTol = Math.max(0, Math.min(128, Math.round(v)));
    },
  );
  nsNumber(
    ctx,
    I18n.t("边缘羽化"),
    Number(node.bgRmSoft),
    { min: 0, max: 128, step: 1, fallback: 32, title: I18n.t("只糊 Alpha 通道，不动颜色") },
    (v) => {
      node.bgRmSoft = Math.max(0, Math.min(128, Math.round(v)));
    },
  );
  nsCheck(
    ctx,
    I18n.t("自动对齐两通道"),
    node.bgRmAlign !== false,
    (v) => {
      node.bgRmAlign = !!v;
    },
    null,
  );
}

if (typeof registerNodeSettingsForm === "function") {
  registerNodeSettingsForm("flux3klein_gen", {
    gearTitle: () => I18n.t("比例 / 精度 / 步数 / 种子 / 抽卡 / 蒙版 / 透明背景"),
    summary: (node) => flux3kleinParamSummary(node),
    build: (ctx) => {
      const node = ctx.node;
      flux3kleinNormalize(node);
      ctx.section(I18n.t("生成"));
      nsSelect(
        ctx,
        I18n.t("比例"),
        Object.keys(FLUX3KLEIN_RATIOS).map((r) => [
          r,
          r + "（" + FLUX3KLEIN_RATIOS[r][0] + "×" + FLUX3KLEIN_RATIOS[r][1] + "）",
        ]),
        node.ratioBucket,
        (v) => {
          const ratio = FLUX3KLEIN_RATIOS[v] ? v : "1:1";
          node.ratioBucket = ratio;
          node.width = FLUX3KLEIN_RATIOS[ratio][0];
          node.height = FLUX3KLEIN_RATIOS[ratio][1];
        },
      );
      ctx.hint(I18n.t("默认长边 1024（16 的倍数）；比例桶是固定训练档，拉伸会糊。"));
      nsSelect(
        ctx,
        I18n.t("精度"),
        [
          ["int8", "INT8 蒸馏（5.6GB · 默认 · 8G 卡起）"],
          ["bf16", "BF16 蒸馏（11.1GB · 更准 · 建议 24G 卡）"],
        ],
        node.precision,
        (v) => {
          node.precision = v === "bf16" ? "bf16" : "int8";
        },
      );
      nsNumber(
        ctx,
        I18n.t("采样步数"),
        Number(node.steps) || 16,
        { min: 1, max: 60, step: 1, fallback: 16, title: I18n.t("蒸馏档 16 步即可；再高收益很小、明显变慢") },
        (v) => {
          node.steps = Math.max(1, Math.min(60, Math.round(v || 16)));
        },
      );
      nsNumber(
        ctx,
        I18n.t("CFG"),
        Number(node.cfg) || 0,
        { min: 0, max: 10, step: 0.1, fallback: 1, title: I18n.t("蒸馏模型用 1.0（cfg=0 表示不启用 CFG）") },
        (v) => {
          node.cfg = Math.max(0, Math.min(10, Number(v) || 0));
        },
      );
      nsNumber(
        ctx,
        I18n.t("种子"),
        node.seed != null ? node.seed : 42,
        { step: 1, fallback: 42, live: true, title: I18n.t("每次执行时按「摇数」递增") },
        (v) => {
          node.seed = Math.floor(v);
        },
      );
      nsCheck(
        ctx,
        I18n.t("摇数（每次执行种子 +1）"),
        node.rerollSeed !== false,
        (v) => {
          node.rerollSeed = !!v;
        },
        null,
      );
      nsNumber(
        ctx,
        I18n.t("抽卡次数"),
        Number(node.rolls) || 1,
        {
          min: 1,
          max: 10,
          step: 1,
          fallback: 1,
          title: I18n.t("每次执行生成几张（每张各自一个种子）；开透明背景时是 2 倍张数"),
        },
        (v) => {
          node.rolls = Math.max(1, Math.min(10, Math.round(v || 1)));
        },
      );
      ctx.section(I18n.t("提示词"));
      {
        const ta = document.createElement("textarea");
        ta.className = "mini-ta";
        ta.value = String(node.prompt || "");
        ta.placeholder = I18n.t("例如：一只红狐站在清晨的新雪里，写实摄影，逆光");
        ta.addEventListener("change", () => {
          node.prompt = ta.value;
          ctx.commit();
        });
        ctx.field(I18n.t("提示词（端子 0 接文本时以线为准）"), ta);
        ctx.hint(
          I18n.t(
            "这里要写成句的画面描述（主体＋动作＋场景＋光线）。只写几个字的短语时，模型会把参考图原样复刻，看起来就像提示词没生效。",
          ),
        );
      }
      nsText(
        ctx,
        I18n.t("负面提示词"),
        String(node.negative || ""),
        { span: true, live: true, placeholder: I18n.t("空 = 不启用负面（蒸馏档 cfg=1 时一般不需要）") },
        (v) => {
          node.negative = v;
        },
      );
      ctx.section(I18n.t("蒙版"));
      ctx.hint(
        I18n.t(
          "蒙版在节点头部那颗小按钮里画（与「图像生成」同一套编辑器）：涂抹要改的区域，运行时只重绘那里，未涂抹区域的像素在出图后按蒙版换回底图。",
        ),
      );
      flux3kleinMattePanel(ctx, node);
    },
  });
}

"use strict";
/* ============ InfiniteTalk 数字人节点（infinitetalk_gen）的执行体 ============
 *
 * 设计口径（与用户共识一致）：
 *   · 输入 = 人物图（端口 0）/ 语音（端口 1，必填）/ 源视频（端口 2，可选，V2V）/ 提示词（端口 3）
 *     / 控制输入（端口 4）；输出 = mp4（端口 0）+ 控制（端口 1）。
 *   · 端口 2 接了源视频 = V2V（按视频换口型，画面构图跟源视频走）；端口 2 空 = I2V（用人物图）。
 *   · 长音频由宿主（infinitetalk/main-infinitetalk.js）按 81 帧分块续写，本文件不切音频 ——
 *     渲染层只负责「取到输入端 → 起一次任务 → 跟着进度刷新 → 收下产物路径」。
 *   · 全局音视频锁、后端起停、断点续跑、产物落盘全在宿主：这里拿不到就不要自己造。
 *   · 与音乐 / H3 / 语音同一条串行链（playNodeBody → runMediaGenSerial），互斥不并行。
 */

/** 某个端口上的值：**只看接到这个端子上的线**。
 *  不能直接用 inputValuesFor(node, idx) —— 它会把该节点的**所有**入线都取一遍值，
 *  人物图与语音同时接上时，端口 1 先拿到的是端口 0 那张图（input_image 的取值不看 idx），
 *  于是「参考图」被当成音频喂给 ffmpeg（报 Output file does not contain any stream）。
 *  源端子序号用连线自己的 fromIndex：input_audio / input_video 的端口 1 是转写文本，
 *  按消费端端口号取会拿到一段文字而不是音频文件。 */
function infinitetalkPortValues(node, idx) {
  let wires = [];
  try {
    wires = typeof wiresTo === "function" ? wiresTo(node.id) || [] : [];
  } catch {
    wires = [];
  }
  const out = [];
  for (const w of wires) {
    if (!w || Number(w.toIndex) !== Number(idx)) continue;
    const src = typeof nodeById === "function" ? nodeById(w.from) : null;
    if (!src) continue;
    const pinned =
      src.kind === "input_audio" ||
      src.kind === "input_video" ||
      src.kind === "function" ||
      (typeof isSuperLikeNode === "function" && isSuperLikeNode(src)) ||
      (typeof isItemPortSource === "function" && isItemPortSource(src));
    let fromIdx = pinned ? Number(w.fromIndex || 0) : Number(idx);
    let value = null;
    try {
      value = typeof valueForInput === "function" ? valueForInput(src, fromIdx, node) : null;
    } catch {
      value = null;
    }
    out.push({
      title: src ? itemTitleOf(src, fromIdx, node) : I18n.t("输入"),
      value,
    });
  }
  return out;
}

/** 端口取值：图像 / 视频端口要 path，音频端口可能是 file:/// URL 或纯路径（统一成纯路径） */
function infinitetalkPortValue(node, idx) {
  const list = infinitetalkPortValues(node, idx);
  for (const it of list || []) {
    const v = it && it.value;
    if (!v) continue;
    if (v.path) return String(v.path);
    const t = String(v.text || "").trim();
    if (t) return t;
  }
  return "";
}

function infinitetalkPlainPath(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^file:\/\//i.test(s)) {
    try {
      return decodeURIComponent(s.replace(/^file:\/\/\/?/i, ""));
    } catch {
      return s.replace(/^file:\/\/\/?/i, "");
    }
  }
  return s;
}

function infinitetalkSetStatus(node, msg) {
  node.infinitetalkStatus = msg;
  /* 画布节点体复用视频族那一套（状态行读 videoStatus），两处写同一句 */
  node.videoStatus = msg;
}

/** 进度订阅：只认本节点的推送（宿主广播里带 nodeId） */
let infinitetalkProgressOff = null;
function infinitetalkWatchProgress(node) {
  if (infinitetalkProgressOff || !window.api || !window.api.onInfinitetalkProgress) return;
  infinitetalkProgressOff = window.api.onInfinitetalkProgress((d) => {
    if (!d || String(d.nodeId || "") !== String(node.id || "")) return;
    if (d.message) infinitetalkSetStatus(node, String(d.message));
    const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
    if (ui) {
      if (d.pct != null) ui.genPct = Math.max(0, Math.min(100, Number(d.pct) || 0));
      ui.genMsg = String(d.message || "");
    }
    if (typeof refreshMediaNodeUi === "function") refreshMediaNodeUi(node, { soft: true });
  });
}

async function playInfinitetalkNode(node, quiet) {
  if (!window.api || !window.api.infinitetalkGenerate) {
    toast(I18n.t("InfiniteTalk 数字人插件未就绪"), "err");
    return;
  }
  if (node.running && !node._prestart) return;
  if (typeof mediaRunStopped === "function" && mediaRunStopped(node)) {
    if (typeof mediaGenMarkDropped === "function") mediaGenMarkDropped(node, false);
    return;
  }

  /* 输入预检：源视频（V2V）优先；没有源视频就必须要人物图（I2V）；语音必填 */
  const imagePath = infinitetalkPlainPath(infinitetalkPortValue(node, 0));
  const audioPath = infinitetalkPlainPath(infinitetalkPortValue(node, 1));
  const videoPath = infinitetalkPlainPath(infinitetalkPortValue(node, 2));
  if (!videoPath && !imagePath) {
    const msg = I18n.t("请连接人物图（端口 0）或源视频（端口 2）");
    infinitetalkSetStatus(node, msg);
    if (!quiet) toast(msg, "warn");
    renderCanvas();
    return;
  }
  if (!audioPath) {
    const msg = I18n.t("请连接语音（端口 1）");
    infinitetalkSetStatus(node, msg);
    if (!quiet) toast(msg, "warn");
    renderCanvas();
    return;
  }

  const exp = typeof requireMediaGenExport === "function" ? requireMediaGenExport(node, quiet) : { ok: true, managed: true, path: "" };
  if (!exp) {
    renderCanvas();
    return;
  }

  let st = null;
  try {
    st = await window.api.infinitetalkStatus();
  } catch {}
  {
    const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
    if (ui) {
      ui.ok = null;
      ui.info = st
        ? typeof summarizeMediaBackendStatus === "function"
          ? summarizeMediaBackendStatus(node, st)
          : null
        : null;
      ui.genPct = 2;
      ui.genMsg = I18n.t("启动后端并生成…");
    }
  }
  if (typeof mediaRunStopped === "function" && mediaRunStopped(node)) {
    if (typeof mediaGenMarkDropped === "function") mediaGenMarkDropped(node, false);
    return;
  }

  node.running = true;
  node.error = null;
  if (typeof beginNodeRun === "function") beginNodeRun(node);
  infinitetalkSetStatus(node, I18n.t("启动后端并生成…"));
  infinitetalkWatchProgress(node);
  if (typeof startMediaBackendRunWatcher === "function") startMediaBackendRunWatcher(node);
  renderCanvas();

  const t0 = Date.now();
  try {
    const params = {
      nodeId: node.id,
      mode: videoPath ? "v2v" : "i2v",
      imagePath: imagePath,
      videoPath: videoPath,
      audioPath: audioPath,
      prompt: String(infinitetalkPortValue(node, 3) || node.prompt || "").trim(),
      negative: String(node.negative || ""),
      resolution: node.resolution || "480p",
      steps: Number(node.steps) || 4,
      seed:
        typeof nextMediaGenSeed === "function" && node.rerollSeed !== false
          ? nextMediaGenSeed(node)
          : Number(node.seed) || 42,
      outputPath: String((exp && exp.path) || ""),
    };
    const r =
      typeof withVramConfirm === "function"
        ? await withVramConfirm((forceVram) =>
            window.api.infinitetalkGenerate(forceVram ? Object.assign({}, params, { forceVram: true }) : params),
          )
        : await window.api.infinitetalkGenerate(params);

    if (node._aborted || (r && (r.error === "cancelled" || r.cancelled))) {
      node.error = null;
      infinitetalkSetStatus(node, I18n.t("已取消"));
      return;
    }
    if (!r || !r.ok) {
      const err = (r && (r.message || r.error)) || I18n.t("生成失败");
      if (err === "busy_other_node" || (r && r.error === "busy_other_node")) {
        node.error = I18n.t("已有音视频生成任务进行中，已中断本节点（全局仅 1 个，禁止并行）");
        node._busyErrAt = Date.now();
      } else {
        node.error = String(err);
      }
      infinitetalkSetStatus(node, node.error);
      if (typeof looksLikeBackendConnError === "function" && looksLikeBackendConnError(err)) {
        if (typeof markMediaBackendDown === "function") markMediaBackendDown(node);
      }
      if (!quiet) toast(node.error, "err");
      return;
    }
    const out = String(r.path || "");
    node.output = out ? { kind: "video", path: out, text: out } : null;
    node.ranAt = Date.now();
    if (!node.genPaths || !Array.isArray(node.genPaths)) node.genPaths = [];
    if (out) node.genPaths.push(out);
    infinitetalkSetStatus(node, I18n.t("完成 · ") + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
    if (ui) {
      ui.genPct = 100;
      ui.genMsg = I18n.t("完成");
    }
    if (!quiet) toast(I18n.t("数字人视频已生成：") + out);
  } catch (e) {
    node.error = (e && e.message) || String(e);
    infinitetalkSetStatus(node, node.error);
    if (!quiet) toast(node.error, "err");
  } finally {
    node.running = false;
    node._aborted = false;
    if (typeof refreshMediaNodeUi === "function") refreshMediaNodeUi(node, { soft: true });
    renderCanvas();
    if (typeof scheduleSave === "function") scheduleSave();
  }
}

/** ⚙ 设置窗：画幅 / 步数 / 种子 / 提示词 / 负面提示词 / 输出路径 */
function infinitetalkParamSummary(node) {
  return (
    String(node.resolution || "480p") +
    " · " +
    String(Number(node.steps) || 4) +
    I18n.t(" 步")
  );
}
if (typeof registerNodeSettingsForm === "function") {
  registerNodeSettingsForm("infinitetalk_gen", {
    gearTitle: () => I18n.t("画幅 / 步数 / 种子 / 提示词 / 输出路径"),
    summary: (node) => infinitetalkParamSummary(node),
    build: (ctx) => {
      const node = ctx.node;
      ctx.section(I18n.t("生成"));
      nsSelect(
        ctx,
        I18n.t("画幅"),
        [
          ["480p", "480p（832×480 · 默认）"],
          ["720p", "720p（1280×768 · 更慢 / 更吃显存）"],
        ],
        node.resolution || "480p",
        (v) => {
          node.resolution = v === "720p" ? "720p" : "480p";
        },
      );
      ctx.hint(
        I18n.t(
          "端口 2 接了源视频 = V2V（构图跟源视频走，按所选画幅缩放）；端口 2 空 = I2V（人物图按中心裁切适配）。",
        ),
      );
      nsNumber(
        ctx,
        I18n.t("采样步数"),
        Number(node.steps) || 4,
        {
          min: 1,
          max: 40,
          step: 1,
          fallback: 4,
          title: I18n.t("默认 4 步（lightx2v 蒸馏档）；调到 8 以上会明显变慢，收益有限"),
        },
        (v) => {
          node.steps = Math.max(1, Math.min(40, Math.round(v || 4)));
        },
      );
      nsNumber(
        ctx,
        I18n.t("种子"),
        node.seed != null ? node.seed : 42,
        { step: 1, fallback: 42, live: true, title: I18n.t("每段生成时种子依次 +1") },
        (v) => {
          node.seed = Math.floor(v);
        },
      );
      nsCheck(
        ctx,
        I18n.t("摇数（每次执行种子 +1）"),
        node.rerollSeed !== false,
        (v) => {
          node.rerollSeed = v;
        },
        null,
      );
      ctx.section(I18n.t("提示词"));
      {
        const ta = document.createElement("textarea");
        ta.className = "mini-ta";
        ta.value = String(node.prompt || "");
        ta.placeholder = I18n.t("一个人对着镜头自然地说话");
        ta.addEventListener("change", () => {
          node.prompt = ta.value;
          ctx.commit();
        });
        ctx.field(I18n.t("提示词（端口 3 为空时才用）"), ta);
      }
      nsText(
        ctx,
        I18n.t("负面提示词"),
        String(node.negative || ""),
        { span: true, live: true, placeholder: I18n.t("空 = 用宿主默认（模糊 / 变形 / 多手多指…）") },
        (v) => {
          node.negative = v;
        },
      );
      nsMediaGenPathField(ctx, node, "video");
    },
  });
}

"use strict";
/* ============ SoulX-FlashHead Lite 实时数字人节点（soulxflashhead_gen）的执行体 ============
 *
 * 设计口径（与用户共识一致）：
 *   · 输入 = 人物图（端口 0）/ 语音（端口 1，必填）/ 控制输入（端口 2）；
 *     输出 = mp4（端口 0）+ 控制（端口 1）。
 *   · 输出固定 512×512 @25fps；Model_Lite 自己按 33 帧窗口做无限长流式续写，
 *     **宿主不切块** —— 本文件只负责「取到输入端 → 起一次任务 → 跟着 FPS/RTF 进度刷新 → 收下产物」。
 *   · 全局音视频锁、后端起停、产物落盘、实时指标全在宿主
 *     （soulxflashhead/main-soulxflashhead.js）：这里拿不到就不要自己造。
 *   · 与音乐 / H3 / 语音 / InfiniteTalk 同一条串行链（playNodeBody → runMediaGenSerial），互斥不并行。
 */

/** 某个端口上的值：只看接到这个端子上的线（口径同 app-infinitetalk.js 的 portValues）。 */
function soulxflashheadPortValues(node, idx) {
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
    const fromIdx = pinned ? Number(w.fromIndex || 0) : Number(idx);
    let value = null;
    try {
      value = typeof valueForInput === "function" ? valueForInput(src, fromIdx, node) : null;
    } catch {
      value = null;
    }
    out.push({ title: src ? itemTitleOf(src, fromIdx, node) : I18n.t("输入"), value });
  }
  return out;
}

/** 端口取值：图像端口要 path，音频端口可能是 file:/// URL 或纯路径（统一成纯路径） */
function soulxflashheadPortValue(node, idx) {
  for (const it of soulxflashheadPortValues(node, idx) || []) {
    const v = it && it.value;
    if (!v) continue;
    if (v.path) return String(v.path);
    const t = String(v.text || "").trim();
    if (t) return t;
  }
  return "";
}

function soulxflashheadPlainPath(v) {
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

function soulxflashheadSetStatus(node, msg) {
  node.soulxflashheadStatus = msg;
  /* 画布节点体复用视频族那一套（状态行读 videoStatus），两处写同一句 */
  node.videoStatus = msg;
}

/** 进度订阅：只认本节点的推送（宿主广播里带 nodeId） */
let soulxflashheadProgressOff = null;
function soulxflashheadWatchProgress(node) {
  if (soulxflashheadProgressOff || !window.api || !window.api.onSoulxflashheadProgress) return;
  soulxflashheadProgressOff = window.api.onSoulxflashheadProgress((d) => {
    if (!d || String(d.nodeId || "") !== String(node.id || "")) return;
    if (d.message) soulxflashheadSetStatus(node, String(d.message));
    const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
    if (ui) {
      if (d.pct != null) ui.genPct = Math.max(0, Math.min(100, Number(d.pct) || 0));
      ui.genMsg = String(d.message || "");
    }
    /* 实时指标直接写进节点，画布上的状态行因此能看到 FPS / RTF（不另开面板） */
    if (d.fps != null) node.lastFps = Number(d.fps) || 0;
    if (d.rtf != null) node.lastRtf = Number(d.rtf) || 0;
    if (typeof refreshMediaNodeUi === "function") refreshMediaNodeUi(node, { soft: true });
  });
}

async function playSoulxflashheadNode(node, quiet) {
  if (!window.api || !window.api.soulxflashheadGenerate) {
    toast(I18n.t("SoulX 实时数字人插件未就绪"), "err");
    return;
  }
  if (node.running && !node._prestart) return;
  if (typeof mediaRunStopped === "function" && mediaRunStopped(node)) {
    if (typeof mediaGenMarkDropped === "function") mediaGenMarkDropped(node, false);
    return;
  }

  const imagePath = soulxflashheadPlainPath(soulxflashheadPortValue(node, 0));
  const audioPath = soulxflashheadPlainPath(soulxflashheadPortValue(node, 1));
  if (!imagePath) {
    const msg = I18n.t("请连接人物图（端口 0）");
    soulxflashheadSetStatus(node, msg);
    if (!quiet) toast(msg, "warn");
    renderCanvas();
    return;
  }
  if (!audioPath) {
    const msg = I18n.t("请连接语音（端口 1）");
    soulxflashheadSetStatus(node, msg);
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
    st = await window.api.soulxflashheadStatus();
  } catch {}
  {
    const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
    if (ui) {
      ui.ok = null;
      ui.info =
        st && typeof summarizeMediaBackendStatus === "function" ? summarizeMediaBackendStatus(node, st) : null;
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
  soulxflashheadSetStatus(node, I18n.t("启动后端并生成…"));
  soulxflashheadWatchProgress(node);
  if (typeof startMediaBackendRunWatcher === "function") startMediaBackendRunWatcher(node);
  renderCanvas();

  const t0 = Date.now();
  try {
    const params = {
      nodeId: node.id,
      imagePath,
      audioPath,
      steps: Number(node.steps) || 4,
      seed:
        typeof nextMediaGenSeed === "function" && node.rerollSeed !== false
          ? nextMediaGenSeed(node)
          : Number(node.seed) || 42,
      outputPath: String((exp && exp.path) || ""),
      canvasWorkflowId: (typeof S !== "undefined" && S.wf && S.wf.id) || "",
    };
    const r =
      typeof withVramConfirm === "function"
        ? await withVramConfirm((forceVram) =>
            window.api.soulxflashheadGenerate(forceVram ? Object.assign({}, params, { forceVram: true }) : params),
          )
        : await window.api.soulxflashheadGenerate(params);

    if (node._aborted || (r && (r.error === "cancelled" || r.cancelled))) {
      node.error = null;
      soulxflashheadSetStatus(node, I18n.t("已取消"));
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
      soulxflashheadSetStatus(node, node.error);
      if (typeof looksLikeBackendConnError === "function" && looksLikeBackendConnError(err)) {
        if (typeof markMediaBackendDown === "function") markMediaBackendDown(node);
      }
      if (!quiet) toast(node.error, "err");
      return;
    }
    const out = String(r.path || "");
    node.output = out ? { kind: "video", path: out, text: out } : null;
    node.ranAt = Date.now();
    node.lastFps = Number(r.fps) || node.lastFps || 0;
    node.lastRtf = Number(r.rtf) || node.lastRtf || 0;
    node.lastChunks = Number(r.chunks) || 0;
    if (!node.genPaths || !Array.isArray(node.genPaths)) node.genPaths = [];
    if (out) node.genPaths.push(out);
    soulxflashheadSetStatus(
      node,
      I18n.t("完成 · ") +
        ((Date.now() - t0) / 1000).toFixed(1) +
        "s" +
        (node.lastFps ? " · " + node.lastFps.toFixed(1) + " FPS" : ""),
    );
    const ui = typeof ensureBackendUiState === "function" ? ensureBackendUiState(node) : null;
    if (ui) {
      ui.genPct = 100;
      ui.genMsg = I18n.t("完成");
    }
    if (!quiet) toast(I18n.t("数字人视频已生成：") + out);
  } catch (e) {
    node.error = (e && e.message) || String(e);
    soulxflashheadSetStatus(node, node.error);
    if (!quiet) toast(node.error, "err");
  } finally {
    node.running = false;
    node._aborted = false;
    if (typeof refreshMediaNodeUi === "function") refreshMediaNodeUi(node, { soft: true });
    renderCanvas();
    if (typeof scheduleSave === "function") scheduleSave();
  }
}

/** ⚙ 设置窗：步数 / 种子 / 输出路径（分辨率固定 512×512 @25fps） */
function soulxflashheadParamSummary(node) {
  return "512×512 · " + String(Number(node.steps) || 4) + I18n.t(" 步");
}
if (typeof registerNodeSettingsForm === "function") {
  registerNodeSettingsForm("soulxflashhead_gen", {
    gearTitle: () => I18n.t("步数 / 种子 / 输出路径"),
    summary: (node) => soulxflashheadParamSummary(node),
    build: (ctx) => {
      const node = ctx.node;
      ctx.section(I18n.t("生成"));
      ctx.hint(
        I18n.t(
          "输出固定 512×512 @25fps（官方 Model_Lite 实时口径）；长音频整段一次流式跑完，宿主不再切块。",
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
          title: I18n.t("默认 4 步（官方 lite 蒸馏档）；调高会掉出实时区"),
        },
        (v) => {
          node.steps = Math.max(1, Math.min(40, Math.round(v || 4)));
        },
      );
      nsNumber(
        ctx,
        I18n.t("种子"),
        node.seed != null ? node.seed : 42,
        { step: 1, fallback: 42, live: true, title: I18n.t("每次生成时种子依次 +1") },
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
      nsMediaGenPathField(ctx, node, "video");
    },
  });
}

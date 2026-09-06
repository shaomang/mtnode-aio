"use strict";
/* ============ 处理（Play / 批量） ============ */

function buildSpec(node, prov, idx) {
  const ins = inputValuesFor(node, idx);
  const images = [];
  const imageSources = [];
  for (const i of ins) {
    if (i.value && i.value.kind === "image") {
      images.push(i.value.path);
      /* 批次图像：把条目标题（源文件名 / 角色名）写入背景，模型才能知道当前是哪张图 */
      imageSources.push({
        title: i.title || I18n.t("图像"),
        text:
          I18n.t("（图像输入）") +
          "\n" +
          I18n.t("标题：") +
          (i.title || I18n.t("图像")),
      });
    }
  }
  const runPrompt = procPromptForRun(node);
  const refs = resolveRefs(runPrompt, node, idx);
  /* 全局广播图像：同样只有提示词里明文 @ 命中的来源才进参考图 */
  const wiredFrom = new Set(wiresTo(node.id).map((w) => w.from));
  for (const src of globalRefSourcesForRun(node, runPrompt)) {
    if (wiredFrom.has(src.id)) continue;
    const v = valueForInput(src, idx);
    if (v && v.kind === "image") {
      images.push(v.path);
      imageSources.push({
        title: itemTitleOf(src, idx) || I18n.t("图像"),
        text:
          I18n.t("（图像输入）") +
          "\n" +
          I18n.t("标题：") +
          (itemTitleOf(src, idx) || I18n.t("图像")),
      });
    }
  }
  /* 图生图：连线图已可能被 @ 引用进 refImages，再 concat 会翻倍；文生图背景仍可带标题说明 */
  const sources =
    node.kind === "proc_image"
      ? refs.textSources || []
      : (refs.textSources || []).concat(imageSources);
  const mergedImages = mergeImagePaths(refs.refImages, images);
  return {
    provider: prov,
    kind:
      node.kind === "proc_text" || node.kind === "agent_task" ? "text" : "image",
    model: node.model || (prov.models || [])[0] || "",
    temperature:
      node.temperature == null
        ? 0.7
        : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    /* 思考强度：文本节点下发 off/低/中/高（off ⇒ thinking 关闭），旧 none → low */
    effort:
      node.kind === "proc_text" ? normalizeTextEffort(node.effort) : undefined,
    size:
      node.kind === "proc_image"
        ? IMAGE_SIZES.includes(node.size)
          ? node.size
          : DEFAULT_IMAGE_SIZE
        : "",
    prompt: withBgRmPrompt(node, assemblePrompt(refs.prompt, sources)),
    texts: [],
    images: mergedImages,
    refImage: mergedImages[0] || "",
  };
}

/* 流式文本调用：resolve {text, reasoning}；reasoning 增量回调（思考内容，按尝试槽存储）；
   delta 增量回调（正文流式） */
function apiCallTextStream(spec, onReasoning, onDelta) {
  return new Promise((resolve, reject) => {
    window.api.apiCallStream(spec, (ev) => {
      if (ev.type === "reasoning") {
        if (onReasoning) onReasoning(ev.text || "");
      } else if (ev.type === "delta") {
        if (onDelta) onDelta(ev.text || "");
      } else if (ev.type === "done") {
        resolve(ev);
      } else if (ev.type === "error") {
        reject(new Error(ev.error || I18n.t("调用失败")));
      }
    });
  });
}

/* 图像资产文件名：含随机后缀，避免并行尝试（同毫秒）文件名冲突覆盖 */
function assetName(node, itemTitle, attemptT, tag) {
  return (
    node.id.slice(-8) +
    "_" +
    (itemTitle ? safeFile(itemTitle) : "") +
    (tag ? "_" + tag : "") +
    "_" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 6) +
    (attemptT ? "_t" + attemptT : "")
  );
}

const VISION_HINT =
  "未添加多模态模型（请在设置中添加支持识图的模型，例如 DeepSeek-V4-Flash-Vision-Exp，或为该文本服务商勾选「支持视觉」）";

/* 文本节点接入图像时的多模态校验：当前服务商无视觉模型且未勾选视觉则拒绝 */
function ensureVision(prov, images) {
  if (!images || !images.length || !prov) return;
  if (prov.vision) return;
  if (visionModelsForProvider("mtnode_" + prov.id).length) return;
  throw new Error(I18n.t(VISION_HINT));
}

/* 已配置且勾选「支持视觉」的文本服务商（原模式 API 路径） */
function textVisionProviders() {
  return (S.config.providers || []).filter(
    (p) =>
      p.type === "text_openai" &&
      !!p.vision &&
      String(p.apiKey || "").trim(),
  );
}

/* 文本处理节点（原模式）接到图像输入时：优先同服务商目录视觉模型，再切到勾选视觉的服务商。
   当前已可用 → 不动；没有可用视觉模型 → 提示并返回 ok:false。 */
function ensureProcTextVision(node, opts) {
  opts = opts || {};
  if (!node || node.kind !== "proc_text" || node.agent) return { ok: true };
  if (!imageInputsOf(node).length) return { ok: true };
  const cur = (S.config.providers || []).find((p) => p.id === node.providerId);
  if (cur) {
    const localVis = visionModelsForProvider("mtnode_" + cur.id);
    if (localVis.some((m) => m.id === String(node.model || ""))) {
      return { ok: true, provider: cur, model: node.model };
    }
    if (localVis.length) {
      const pick = localVis[0];
      const switched = node.model !== pick.id;
      if (switched) {
        node.model = pick.id;
        if (opts.notify !== false) {
          toast(
            I18n.t("已自动切换至视觉模型：") +
              (cur.name || cur.id) +
              " / " +
              (pick.name || pick.id),
            "ok",
          );
        }
        if (opts.save !== false) scheduleSave(true);
      }
      return { ok: true, switched, provider: cur, model: pick.id };
    }
    if (cur.vision) return { ok: true, provider: cur, model: node.model };
  }
  const cands = textVisionProviders();
  if (!cands.length) {
    if (opts.notify !== false) toast(I18n.t(VISION_HINT), "warn");
    return { ok: false, reason: I18n.t(VISION_HINT) };
  }
  const pick = cands[0];
  const model =
    (pick.models && pick.models.length && pick.models[0]) || node.model || "";
  const switched = node.providerId !== pick.id || node.model !== model;
  if (switched) {
    node.providerId = pick.id;
    node.model = model;
    if (opts.notify !== false) {
      toast(
        I18n.t("已自动切换至视觉模型：") +
          (pick.name || pick.id) +
          " / " +
          (model || I18n.t("（未选择）")),
        "ok",
      );
    }
    if (opts.save !== false) scheduleSave(true);
  }
  return { ok: true, switched, provider: pick, model };
}

async function runDshOnce(node, spec, attemptT, images) {
  node._pendingAnswer = "";
  /* 智能任务：会话模式多轮；普通模式仅本次消息（历史已在 playNode 清空） */
  const sent = procPromptForRun(node);
  const skillWrap = await resolveSkillSlash(sent, { denyCanvasSkills: true });
  const skillLatest = skillWrap ? skillTaskPrompt(skillWrap) : "";
  if (skillWrap && spec) {
    spec.prompt = applySkillWrapToAssembled(
      spec.prompt,
      skillWrap.raw,
      skillLatest,
    );
  }
  if (node.kind === "agent_task") {
    if (!Array.isArray(node.messages)) node.messages = [];
    const cur = String(sent || "").trim();
    const lm = node.messages[node.messages.length - 1];
    if (cur && !(lm && lm.role === "user" && lm.content === cur)) {
      node.messages.push({ role: "user", content: cur, at: Date.now() });
    }
  }
  const msgs = node.messages || [];
  const useHist = node.kind === "agent_task" && !!node.chatMode;
  const hist = useHist
    ? msgs
        .slice(0, -1)
        .slice(-20)
        .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
        .join("\n\n")
    : "";
  let latest = skillLatest || String(sent || "").trim() || spec.prompt;
  /* 复杂任务计划：注入「任务流程」指令（Skill / 计划执行器 / 已判定过跳过） */
  let planFlowInjected = false; /* 本次运行是否被要求「按契约输出计划块」（漏弹自愈的闸门） */
  if (
    node.kind === "agent_task" &&
    attemptCount(node) <= 1 &&
    !skillWrap &&
    !node._planExec &&
    !node._planFlowDone &&
    typeof planFlowDirective === "function"
  ) {
    if (String(spec.prompt || "").trim())
      spec.prompt = planFlowDirective() + "\n" + spec.prompt;
    latest = planFlowDirective() + "\n" + latest;
    node._planFlowDone = true;
    planFlowInjected = true;
  }
  const input =
    useHist && hist
      ? hist + "\n\n用户(最新)：" + latest
      : spec.prompt;
  const runOpts = {
    node,
    model: spec.vm || node.model || undefined,
    provider:
      spec.vmProvider ||
      String(node.provider || "").trim() ||
      defaultAgentProviderRoute(),
    effort: node.effort != null && node.effort !== "" ? node.effort : undefined,
    preset: node.preset || undefined,
    images,
    systemPrompt: "回答简洁。用工作区文件交付结果，不要改画布。",
    onEvent: (type, data) => onDshNodeEvent(node, attemptT, type, data),
    onDone: (d) => recordDshMetrics(node, d.metrics),
  };
  const text = await dshRunTask(input, runOpts);
  /* out = 本轮完整正文（下游数据口径不变）；分段只影响界面显示与助手消息存档 */
  let out = String(text || node._pendingAnswer || "");
  /* 复杂任务计划：agent 输出计划标记 → 弹窗确认 → 节点模式逐项执行（节点保持运行中） */
  if (node.kind === "agent_task" && attemptCount(node) <= 1 && typeof planNodeOffer === "function") {
    let replaced = await planNodeOffer(node, out);
    /* 计划漏弹自愈（与会话路径同口径）：本次运行被要求过「任务流程」契约，正文里明显
       有计划内容（标记写坏 / 漏闭合 / 裸 goal+tasks JSON）却解析不出合法计划块 →
       弹窗根本不出现，节点就这么静默跑完。追发一次纠错指令重生成，一次为限。
       重跑复用同一份 runOpts：模型 / 服务商 / 画布实时轨迹口径都不变；把上一轮输出
       尾部带上（节点模式没有会话历史），让它照原内容改写而不是从零再规划一遍。 */
    if (
      replaced === null &&
      planFlowInjected &&
      typeof planMissedDetection === "function" &&
      planMissedDetection(out) &&
      typeof planFixDirective === "function"
    ) {
      try {
        toast(I18n.t("检测到计划未弹出，已自动要求重新生成一次"), "warn");
      } catch (_) {}
      const again = await dshRunTask(
        input +
          "\n\n" +
          planFixDirective() +
          "\n\n【你上一轮的输出 · 计划块没写对，照它改写即可】\n" +
          out.slice(-2500),
        runOpts,
      );
      out = String(again || node._pendingAnswer || out);
      replaced = await planNodeOffer(node, out);
    }
    if (replaced !== null) out = replaced;
  }
  if (!out.trim()) {
    const nTools = ((S.nodeTools && S.nodeTools[node.id]) || []).length;
    if (!nTools) throw new Error(I18n.t("智能运行无输出"));
  }
  const body = out.trim() ? out : I18n.t("（已完成，无文本输出）");
  if (node.kind === "agent_task") {
    const msg = assistantMsgFromNode(node, body);
    const lm = node.messages[node.messages.length - 1];
    if (!(lm && lm.role === "assistant" && lm.content === body)) {
      node.messages.push(msg);
    } else {
      if (msg.reasoning) lm.reasoning = msg.reasoning;
      if (msg.tools) lm.tools = msg.tools;
      if (msg.segments) lm.segments = msg.segments;
    }
    /* 不在此处清空 task：运行中用户可能已输入下一条 */
  }
  syncAgentTaskToSession(node, spec.prompt, body);
  return { kind: "text", text: body };
}

async function runOnce(node, prov, idx, itemTitle, attemptT) {
  const spec = buildSpec(node, prov, idx);
  if (isDshTask(node)) {
    /* 图像输入:提示可用 mtnode_vision；智能节点不弹窗切换主模型 */
    const imgNodes = imageInputsOf(node, idx);
    let taskVis = null;
    if (imgNodes.length) {
      const paths = collectTaskImagePaths(node, spec, idx);
      const labels = imgNodes.map((n) => "「" + n.title + "」");
      if (!labels.some((lab) => String(spec.prompt || "").includes(lab))) {
        let note =
          I18n.t("\n\n【已连接图像输入】") +
          I18n.listJoin(labels) +
          I18n.t("（请结合任务要求参考这些图像）");
        if (paths.length) {
          note +=
            I18n.t("\n需要识图时调用 mtnode_vision，imagePath：\n") +
            paths.map((p) => "- " + p).join("\n");
        }
        spec.prompt = String(spec.prompt || "") + note;
      }
      taskVis = await resolveVisionForRun(node);
      if (taskVis) {
        spec.vmProvider = taskVis.provider;
        spec.vm = taskVis.model;
      }
    }
    /* 智能模式：提示词成为任务，agent 可读文件/联网/执行命令后完成 */
    return await runDshOnce(
      node,
      spec,
      attemptT,
      taskVis && imgNodes.length
        ? collectTaskImagePaths(node, spec, idx)
        : undefined,
    );
  }
  spec.abKey = node._abKey || "";
  if (node.kind === "proc_text") ensureVision(prov, spec.images);
  if (node.kind === "proc_text") {
    const r = await apiCallTextStream(spec, (t) =>
      pushThinking(node.id, attemptT || 0, t),
    );
    if (!r.text) throw new Error(I18n.t("响应无文本内容"));
    return { kind: "text", text: r.text };
  }
  const rr = await window.api.apiCall(spec);
  if (!rr.ok) throw new Error(rr.error || I18n.t("调用失败"));
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, itemTitle, attemptT, ""),
    rr.base64,
    rr.ext || "png",
  );
  /* 透明背景开启时：这里会在内部自动补生成严格对齐的黑底第 2 通道并差分抠图（用户无感知） */
  const path = await finishProcImageOutput(node, spec, res.path, itemTitle, attemptT);
  return { kind: "image", path };
}

/* 聚合模式：每个批量条目 = 一个「虚拟输入节点」（条目标题=标题，条目内容=内容），
   允许通过 @条目标题 引用任意一个条目 */
function aggCandidates(node) {
  const out = [];
  const seen = new Set();
  const addSrc = (src, portIdx) => {
    if (!src || seen.has(src.id)) return;
    seen.add(src.id);
    for (const it of allTextItems(src, node, portIdx))
      out.push({ title: it.title || src.title, kind: "text", text: it.text });
    for (const it of allImageItems(src, node, portIdx))
      out.push({ title: it.title || src.title, kind: "image", path: it.path });
  };
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    addSrc(src, superPortIdxFromWire(src, w));
  }
  if (usesGlobalRefs(node)) {
    for (const src of globalRefSources(node.id)) addSrc(src);
  }
  return out;
}
function resolveRefsAgg(prompt, node) {
  const refImages = [];
  const unresolved = new Set();
  const tagBlocks = [];
  const seenTagNodes = new Set();
  const cands = aggCandidates(node);
  /* !@数据库标题 引用：先替换为可读指针 */
  const bang = resolveDbBangRefs(prompt, node);
  prompt = bang.prompt;
  const out = mapAtMentions(prompt, atRefNamesFor(cands), (h, raw) => {
    const tok = h.name || h.token;
    const c = findCandidateByTitle(cands, tok);
    if (!c) {
      const tag = tagByAtToken(tok);
      if (
        tag &&
        collectTagRefBlocksAgg(tag, node, tagBlocks, refImages, seenTagNodes)
      )
        return "Tag:" + tag;
      unresolved.add(tok);
      return raw;
    }
    if (c.kind === "text") return c.title; // 去掉 @，指向背景中对应条目块
    const path = c.path;
    let n = refImages.indexOf(path);
    if (n < 0) {
      refImages.push(path);
      n = refImages.length - 1;
    }
    /* 与 resolveRefs 一致：按请求包中参考图顺序编号 */
    return I18n.t("第{n}张参考图", { n: n + 1 });
  });
  return { prompt: out, refImages, unresolved: [...unresolved], tagBlocks };
}

/* 聚合模式：所有条目的内容合并为一次请求（每条目作为独立输入块） */
function buildSpecAgg(node, prov) {
  const images = [];
  const textBlocks = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    const portIdx = superPortIdxFromWire(src, w);
    for (const it of allTextItems(src, node, portIdx)) textBlocks.push(it);
    for (const it of allImageItems(src, node, portIdx)) {
      images.push(it.path);
      textBlocks.push({
        title: it.title || src.title || I18n.t("图像"),
        text:
          I18n.t("（图像输入）") +
          "\n" +
          I18n.t("标题：") +
          (it.title || src.title || I18n.t("图像")),
      });
    }
  }
  const runPrompt = procPromptForRun(node);
  const wiredAgg = new Set(wiresTo(node.id).map((w) => w.from));
  /* 聚合模式同样只注入被明文 @ 命中的全局来源 */
  for (const src of globalRefSourcesForRun(node, runPrompt)) {
    if (wiredAgg.has(src.id)) continue;
    for (const it of allTextItems(src)) textBlocks.push(it);
    for (const it of allImageItems(src)) {
      images.push(it.path);
      textBlocks.push({
        title: it.title || src.title || I18n.t("图像"),
        text:
          I18n.t("（图像输入）") +
          "\n" +
          I18n.t("标题：") +
          (it.title || src.title || I18n.t("图像")),
      });
    }
  }
  const refs = resolveRefsAgg(runPrompt, node);
  /* 聚合图生图：去掉「（图像输入）」标题块，避免与「第 N 张参考图」重复说明 */
  const promptBlocks =
    node.kind === "proc_image"
      ? textBlocks.filter((b) => {
          const t = String(b.text || "");
          return !t.startsWith(I18n.t("（图像输入）"));
        })
      : textBlocks;
  const useBlocks = dedupeBlockTitles(
    promptBlocks.concat(refs.tagBlocks || []),
  );
  const prompt = useBlocks.length
    ? "【背景信息】\n" +
      useBlocks.map((b) => "### " + b.title + "\n" + b.text).join("\n\n") +
      "\n\n【内容】\n" +
      refs.prompt
    : refs.prompt;
  const mergedImages = mergeImagePaths(refs.refImages, images);
  return {
    provider: prov,
    kind:
      node.kind === "proc_text" || node.kind === "agent_task" ? "text" : "image",
    model: node.model || (prov.models || [])[0] || "",
    temperature:
      node.temperature == null
        ? 0.7
        : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    /* 思考强度：文本节点下发 off/低/中/高（off ⇒ thinking 关闭），旧 none → low */
    effort:
      node.kind === "proc_text" ? normalizeTextEffort(node.effort) : undefined,
    size:
      node.kind === "proc_image"
        ? IMAGE_SIZES.includes(node.size)
          ? node.size
          : DEFAULT_IMAGE_SIZE
        : "",
    prompt: withBgRmPrompt(node, prompt),
    texts: [],
    images: mergedImages,
    refImage: mergedImages[0] || "",
  };
}

async function runOnceAgg(node, prov, attemptT) {
  const spec = buildSpecAgg(node, prov);
  if (isDshTask(node)) {
    /* 图像输入:与 runOnce 一致；智能节点不弹窗切换主模型 */
    const imgNodes = [];
    for (const n of imageInputsOf(node)) {
      const src = nodeById(n.id);
      if (!src) continue;
      for (const it of allImageItems(src))
        imgNodes.push({
          id: src.id,
          title: it.title || src.title || I18n.t("图像"),
          path: it.path,
        });
    }
    let taskVis = null;
    if (imgNodes.length) {
      const labels = imgNodes.map((n) => "「" + n.title + "」");
      const paths = [];
      for (const n of imgNodes) {
        if (n.path && !paths.includes(n.path)) paths.push(n.path);
      }
      if (!labels.some((lab) => String(spec.prompt || "").includes(lab))) {
        let note =
          I18n.t("\n\n【已连接图像输入】") +
          I18n.listJoin(labels) +
          I18n.t("（请结合任务要求参考这些图像）");
        if (paths.length) {
          note +=
            I18n.t("\n需要识图时调用 mtnode_vision，imagePath：\n") +
            paths.map((p) => "- " + p).join("\n");
        }
        spec.prompt = String(spec.prompt || "") + note;
      }
      taskVis = await resolveVisionForRun(node);
      if (taskVis) {
        spec.vmProvider = taskVis.provider;
        spec.vm = taskVis.model;
      }
    }
    return await runDshOnce(
      node,
      spec,
      attemptT,
      taskVis && imgNodes.length
        ? collectTaskImagePaths(node, spec)
        : undefined,
    );
  }
  spec.abKey = node._abKey || "";
  if (node.kind === "proc_text") ensureVision(prov, spec.images);
  if (node.kind === "proc_text") {
    const r = await apiCallTextStream(spec, (t) =>
      pushThinking(node.id, attemptT || 0, t),
    );
    if (!r.text) throw new Error(I18n.t("响应无文本内容"));
    return { kind: "text", text: r.text };
  }
  const rr = await window.api.apiCall(spec);
  if (!rr.ok) throw new Error(rr.error || I18n.t("调用失败"));
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, "", attemptT, "agg"),
    rr.base64,
    rr.ext || "png",
  );
  const path = await finishProcImageOutput(node, spec, res.path, "", attemptT);
  return { kind: "image", path };
}

async function previewNode(node) {
  /* dsh 任务节点：实际请求由引擎内部组装,展示任务摘要而非伪造请求 */
  if (isDshTask(node)) {
    const sup = dshSupported();
    if (!sup.ok) {
      toast(sup.reason, "warn");
      return;
    }
    const d = (S.config && S.config.dsh) || {};
    const ins = inputValuesFor(node, 0);
    const titles = batchTitles(node);
    /* 服务商显示:节点选中的供应商名称(支持 DeepSeek 及其他文本服务商) */
    let provName = "";
    {
      const prov = node.provider || "deepseek-official";
      if (prov === "deepseek-official") {
        const dp = dshProvider();
        provName = (dp && dp.name) || I18n.t("DeepSeek 官方");
      } else if (prov.startsWith("mtnode_")) {
        const mp = mtnodePiProviders().find(
          (x) => "mtnode_" + x.route === prov,
        );
        provName = (mp && mp.name) || prov;
      } else {
        provName = prov;
      }
    }
    openOverlay(I18n.t("智能任务摘要"));
    const bodyEl = $("#ovBody");
    const pre = document.createElement("pre");
    pre.className = "preview-req";
    pre.textContent =
      I18n.t("服务商：") +
      provName +
      I18n.t("\n模型：") +
      (node.model || d.model || "deepseek-v4-flash") +
      I18n.t("\n工作目录：") +
      (dshWorkspaceOf(node) || I18n.t("（应用默认数据目录）")) +
      I18n.t("\n输入节点：") +
      (ins.length || I18n.t("无")) +
      (titles
        ? I18n.t("\n批量模式：") +
          (node.batchMode === "agg" ? I18n.t("聚合(单次)") : I18n.t("逐条")) +
          " × " +
          titles.length +
          I18n.t(" 项")
        : "") +
      I18n.t("\n\n任务内容：\n") +
      procPromptOf(node);
    bodyEl.appendChild(pre);
    const foot = $("#ovFoot");
    const copy = document.createElement("button");
    copy.className = "mini primary";
    copy.textContent = I18n.t("复制摘要");
    copy.onclick = () => {
      navigator.clipboard
        .writeText(pre.textContent)
        .then(() => toast(I18n.t("已复制摘要"), "ok"));
    };
    const close = document.createElement("button");
    close.className = "mini";
    close.textContent = I18n.t("关闭");
    close.onclick = closeOverlay;
    foot.appendChild(copy);
    foot.appendChild(close);
    return;
  }
  const prov = S.config.providers.find((p) => p.id === node.providerId);
  if (!prov) {
    toast(I18n.t("未配置服务商（设置 · API/配置）"), "warn");
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    toast(I18n.t("该服务商未填写 API Key（设置 · API/配置）"), "warn");
    return;
  }
  const spec = buildSpec(node, prov, 0);
  const r = await window.api.apiPreview(spec);
  if (!r.ok) {
    toast(I18n.t("预览失败：") + r.error, "err");
    return;
  }
  openOverlay(I18n.t("请求预览 · 运行时将发送以下完整请求"));
  const bodyEl = $("#ovBody");
  const q = r.request;
  let txt = q.method + "  " + q.url + "\n\nHeaders:\n";
  for (const [k, v] of Object.entries(q.headers))
    txt += "  " + k + ": " + v + "\n";
  txt += "\nBody:\n" + JSON.stringify(q.body, null, 2);
  if (
    node.kind === "proc_text" &&
    spec.images.length &&
    !prov.vision
  ) {
    txt = "⚠ " + I18n.t(VISION_HINT) + I18n.t("\n（以下请求将忽略图像输入）\n\n") + txt;
  }
  if (node.kind === "proc_image" && node.bgRmOn) {
    /* 透明背景：让「其实要出两张图」在预览里就看得见 */
    txt =
      "⚠ " +
      I18n.t(
        "透明背景（双通道差分抠图）已开启：以下是第 1 通道（纯白背景）请求。运行时会自动补发第 2 通道（完全一致、严格对齐的纯黑背景）并差分出 Alpha —— 共 2 次生成，约 2 倍 Token。\n\n",
      ) +
      txt;
  }
  const pre = document.createElement("pre");
  pre.className = "preview-req";
  pre.textContent = txt;
  bodyEl.appendChild(pre);
  const foot = $("#ovFoot");
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = I18n.t("复制请求");
  copy.onclick = () => {
    navigator.clipboard
      .writeText(pre.textContent)
      .then(() => toast(I18n.t("已复制请求"), "ok"));
  };
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  foot.appendChild(copy);
  foot.appendChild(close);
}

function isAutoProcKind(n) {
  return (
    !!n &&
    (n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "agent_task" ||
      n.kind === "music_gen" ||
      n.kind === "tts_gen" ||
      n.kind === "video_gen" ||
      n.kind === "remotion" ||
      n.kind === "wait_file" ||
      n.kind === "task")
  );
}

async function waitFilePathReady(node) {
  if (!node || node.kind !== "wait_file") return false;
  const r = resolveSavePath(node.waitPath, node);
  if (!r.ok) return false;
  try {
    if (window.api && window.api.fileExists)
      return !!(await window.api.fileExists(r.path));
  } catch {
    return false;
  }
  return false;
}

/* 与 ensureProcessed 跳过条件一致：已有结果 / 错误则不再自动跑 */
function nodeAlreadyProcessed(node) {
  if (!node) return true;
  if (node.kind === "wait_file") {
    /* 等待节点：文件曾就绪则视为完成（路径是否仍在由 ensureProcessed 再验） */
    return !!(node.waitReady || node.error);
  }
  if (attemptCount(node) > 1) {
    const outs = node.attemptOutputs || [];
    if (
      outs.some(
        (o) => o && (o.output || (o.batchOutputs && o.batchOutputs.length)),
      )
    )
      return true;
    if (outs.some((o) => o && o.error)) return true;
  } else {
    if (node.output || (node.batchOutputs && node.batchOutputs.length))
      return true;
    if (node.error) return true;
  }
  return false;
}

/* 控制「补缺」：是否已有可用输出内容（不含仅有 error；保存节点看已保存路径） */
function nodeHasOutputContent(node) {
  if (!node) return false;
  if (isSaveNode(node))
    return !!(
      node.savedPath ||
      (Array.isArray(node.savedPaths) && node.savedPaths.length)
    );
  if (node.kind === "control") return false;
  if (node.kind === "wait_file") return !!node.waitReady;
  if (node.kind === "task")
    return node.taskStatus === "done" && !!(node.output && node.output.text);
  if (attemptCount(node) > 1) {
    const outs = node.attemptOutputs || [];
    return outs.some(
      (o) => o && (o.output || (o.batchOutputs && o.batchOutputs.length)),
    );
  }
  return !!(node.output || (node.batchOutputs && node.batchOutputs.length));
}

function isNodePending(node) {
  return !!(node && S.pendingRun && S.pendingRun.has(node.id) && !node.running);
}

/* 收集将自动执行的上游链（含可选自身），用于 ▶ pending 动效 */
function collectPendingRunIds(node, includeSelf) {
  const out = new Set();
  const walk = (n) => {
    if (!isAutoProcKind(n) || out.has(n.id)) return;
    for (const src of procSourcesOf(n)) walk(src);
    if (!n.running && !nodeAlreadyProcessed(n)) out.add(n.id);
  };
  if (node) walk(node);
  if (includeSelf && node && !node.running) out.add(node.id);
  return out;
}

function addPendingRun(ids) {
  if (!S.pendingRun) S.pendingRun = new Set();
  let added = false;
  for (const id of ids || []) {
    if (!S.pendingRun.has(id)) {
      S.pendingRun.add(id);
      added = true;
    }
  }
  if (added) {
    renderCanvas();
    updateRunQueuePanel();
  }
}

function clearPendingRun(ids) {
  if (!S.pendingRun || !ids) return;
  let changed = false;
  for (const id of ids) {
    if (S.pendingRun.delete(id)) changed = true;
  }
  if (changed) {
    renderCanvas();
    updateRunQueuePanel();
  }
}

/* 当前控制/级联批次内的节点 id：由队列启动，ensure 不得再抢跑（否则易死锁 + 残留等待） */
function isScheduledRunNode(n) {
  return !!(n && S._scheduledRunIds && S._scheduledRunIds.has(n.id));
}

function procSourcesOutsideSchedule(node) {
  return procSourcesOf(node).filter((s) => !isScheduledRunNode(s));
}

function procSourcesOf(node) {
  const out = [];
  const seen = new Set();
  if (!node) return out;
  const add = (src) => {
    if (!src || seen.has(src.id) || !isAutoProcKind(src)) return;
    seen.add(src.id);
    out.push(src);
  };
  for (const w of wiresTo(node.id)) add(nodeById(w.from));
  /* 未被明文 @ 命中的全局来源本次不会注入内容，也就不必强制补跑其上游 */
  for (const src of globalRefSourcesForRun(node, procPromptForRun(node)))
    add(src);
  /* 需求等待以控制线连入时：仍作为阻塞依赖，先等文件就绪再跑本节点 */
  for (const w of allWiresTo(node.id)) {
    if (!wireFromIsControl(w)) continue;
    const src = nodeById(w.from);
    if (!src || src.kind !== "wait_file" || seen.has(src.id)) continue;
    seen.add(src.id);
    out.push(src);
  }
  return out;
}

async function ensureProcessedAll(sources, ran) {
  ran = ran || [];
  const list = (sources || []).filter(Boolean);
  if (!list.length) return ran;
  if (list.length === 1) return ensureProcessed(list[0], ran);
  await Promise.all(list.map((src) => ensureProcessed(src, ran)));
  return ran;
}

/* 递归确保上游处理节点均已产生结果（未被处理过的先执行，直到所有输入都有内容）。
   多个互不依赖的上游并行补跑，避免排队。 */
async function ensureProcessed(node, ran) {
  ran = ran || [];
  if (!node) return ran;
  if (!isAutoProcKind(node)) return ran;
  /* 本批调度中的节点只等队列启动，禁止在此 playNode，避免互相 await playLocks 锁死 */
  if (isScheduledRunNode(node)) return ran;
  /* 已有产物则立刻返回，切勿 await 仍被 playNode 握着的锁。
     典型死锁：处理节点完成后级联保存，playNode 持锁等 cascade，save 又 ensure 上游去等这把锁。 */
  if (node.kind !== "wait_file" && nodeAlreadyProcessed(node)) return ran;
  await ensureProcessedAll(procSourcesOutsideSchedule(node), ran);
  if (node.kind !== "wait_file" && nodeAlreadyProcessed(node)) return ran;
  if (S.playLocks && S.playLocks.has(node.id)) {
    if (node.kind !== "wait_file" && nodeAlreadyProcessed(node)) return ran;
    await S.playLocks.get(node.id);
    return ran;
  }
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return ran;
  }
  if (attemptCount(node) > 1) {
    const outs = node.attemptOutputs || [];
    if (
      outs.some(
        (o) => o && (o.output || (o.batchOutputs && o.batchOutputs.length)),
      )
    )
      return ran;
    if (outs.some((o) => o && o.error)) return ran; // 已有错误则不再自动重试
  } else {
    if (node.kind === "wait_file") {
      if (node.waitReady && (await waitFilePathReady(node))) return ran;
      node.waitReady = false;
      node.output = null;
      node.error = null;
      node.waitStatus = "";
    } else {
      if (node.output || (node.batchOutputs && node.batchOutputs.length))
        return ran;
      if (node.error) return ran; // 已有错误则不再自动重试
    }
  }
  ran.push(node.title);
  await playNode(node, true, { noCascade: true });
  return ran;
}

/* 单次尝试的运行体：{output, batchOutputs, error, ranAt}，错误不抛出（记入槽内） */
async function runAttempt(node, prov, t) {
  const res = { output: null, batchOutputs: null, error: null, ranAt: 0 };
  try {
    const titles = batchTitles(node);
    if (titles && node.batchMode === "agg") {
      /* 聚合模式：所有条目作为独立输入，单次运行，输出单个结果 */
      res.output = await runOnceAgg(node, prov, t);
      res.ranAt = Date.now();
    } else if (titles) {
      /* 批量模式：每条目一次运行，全部并行（含智能节点） */
      const tasks = titles.map((title, idx) =>
        runOnce(node, prov, idx, title, t)
          .then((output) => ({ title, ok: true, output }))
          .catch((e) => ({
            title,
            ok: false,
            error: node._aborted ? I18n.t("已手动停止") : e.message || String(e),
          })),
      );
      res.batchOutputs = await Promise.all(tasks);
      res.ranAt = Date.now();
    } else {
      res.output = await runOnce(node, prov, 0, null, t);
      res.ranAt = Date.now();
    }
  } catch (e) {
    res.error = node._aborted ? I18n.t("已手动停止") : e.message || String(e);
  }
  return res;
}

function isProcessPlayKind(n) {
  return (
    !!n &&
    (n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "agent_task")
  );
}

function isCascadeRunKind(n) {
  return (
    isProcessPlayKind(n) ||
    isMediaGenNode(n) ||
    isComputeExecKind(n) ||
    !!(n && (isSaveNode(n) || n.kind === "task" || n.kind === "net_send" || n.kind === "net_recv"))
  );
}

function isCascadeWalkKind(n) {
  return !!(
    n &&
    (n.kind === "split" ||
      n.kind === "merge" ||
      n.kind === "input_text" ||
      n.kind === "input_image")
  );
}

/* 数据连线可达的下游：处理 / 智能任务 / 保存 / 任务；拆分·合并·输入只穿过不执行 */
function collectDownstreamCascade(start) {
  const run = [];
  const seen = new Set();
  if (!start || !S.wf) return run;
  const q = [start.id];
  seen.add(start.id);
  const fanoutGlobal = (g) => {
    if (!g || g.kind !== "global") return;
    for (const n of S.wf.nodes || []) {
      if (!usesGlobalRefs(n) || seen.has(n.id) || n.id === start.id) continue;
      seen.add(n.id);
      if (isCascadeRunKind(n)) run.push(n);
      if (isCascadeRunKind(n) || isCascadeWalkKind(n)) q.push(n.id);
    }
  };
  fanoutGlobal(start);
  while (q.length) {
    const fromId = q.shift();
    for (const w of S.wf.wires || []) {
      if (w.rel) continue;
      if (w.from !== fromId) continue;
      if (wireFromIsControl(w)) continue;
      const n = nodeById(w.to);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      if (isCascadeRunKind(n)) run.push(n);
      if (isCascadeRunKind(n) || isCascadeWalkKind(n) || n.kind === "global")
        q.push(n.id);
      fanoutGlobal(n);
    }
  }
  return run;
}

function nodePlaySucceeded(node) {
  if (!node || node._aborted) return false;
  if (attemptCount(node) > 1) {
    const outs = node.attemptOutputs || [];
    return outs.some(
      (o) =>
        o &&
        !o.error &&
        (o.output || (o.batchOutputs && o.batchOutputs.length)),
    );
  }
  if (node.error) return false;
  return nodeHasOutputContent(node);
}

/* 节点跑完后是否自动接着跑下游：默认关闭。
   大图（数百节点）+ 控制节点 / 环路时，自动级联会自我放大（每个节点跑完又触发一遍下游），
   曾经把应用直接跑崩；要连跑请用「控制节点 ▶」或工具栏「运行」。
   想恢复旧行为：设置里打开「节点完成后自动执行下游」，或在控制台
   setAutoRunDownstream(true)。 */
let AUTO_RUN_DOWNSTREAM_ON_FINISH =
  (() => {
    try {
      return localStorage.getItem("mtnode.autoRunDownstream") === "1";
    } catch {
      return false;
    }
  })();
function setAutoRunDownstream(on) {
  AUTO_RUN_DOWNSTREAM_ON_FINISH = !!on;
  try {
    localStorage.setItem("mtnode.autoRunDownstream", AUTO_RUN_DOWNSTREAM_ON_FINISH ? "1" : "0");
  } catch {}
  toast(
    AUTO_RUN_DOWNSTREAM_ON_FINISH
      ? I18n.t("已开启：节点完成后自动执行下游")
      : I18n.t("已关闭：节点完成后不再自动执行下游"),
    "warn",
  );
}

async function decideCascadeAfterPlay(node, quiet, opts) {
  if (quiet || (opts && opts.noCascade) || !isProcessPlayKind(node))
    return { nodes: null, skipSaveIds: null };
  /* 默认不再自动跑下游：一次 ▶ 只执行本节点，避免失控 */
  if (!AUTO_RUN_DOWNSTREAM_ON_FINISH || runBatchStopped(node))
    return { nodes: null, skipSaveIds: null };
  const down = collectDownstreamCascade(node);
  if (!down.length) return { nodes: null, skipSaveIds: null };
  const skipSaveIds = new Set(down.map((n) => n.id));
  const occupied = down.filter(nodeHasOutputContent);
  if (!occupied.length) return { nodes: down, skipSaveIds };
  const titles = occupied.map((n) => n.title || n.kind);
  const more = titles.length > 8 ? "…" : "";
  const ok = await confirmDialog(
    I18n.t(
      "下游节点已有输出。继续执行将覆盖这些内容，也可以到此为止、不继续执行下游。",
    ) +
      "\n" +
      I18n.listJoin(titles.slice(0, 8)) +
      more,
    {
      title: I18n.t("下游已有内容"),
      okText: I18n.t("执行并覆盖"),
      cancelText: I18n.t("不继续执行"),
    },
  );
  return { nodes: ok ? down : [], skipSaveIds };
}

async function runCascadeNode(n, seen) {
  if (!n || seen.has(n.id)) return;
  seen.add(n.id);
  if (n.kind === "task") return playTaskNode(n, true);
  if (isSaveNode(n))
    return saveNodeAction(n);
  if (isComputeExecKind(n))
    return playNode(n, true, { noCascade: true, ensureUpstream: true, batchDriven: true });
  if (isMediaGenNode(n) || isProcessPlayKind(n))
    /* 同批节点由队列按依赖启动；ensureUpstream 只补跑批次外上游 */
    return playNode(n, true, { noCascade: true, ensureUpstream: true, batchDriven: true });
  if (n.kind === "net_send" || n.kind === "net_recv")
    return playNode(n, true, { noCascade: true, ensureUpstream: true, batchDriven: true });
}

async function runDownstreamCascade(nodes) {
  const list = (nodes || []).filter((n) => n && nodeById(n.id) && !n.running);
  if (!list.length) return;
  invalidateControlRunTargets(list);
  const pending = new Set(list.map((n) => n.id));
  addPendingRun(pending);
  const seen = new Set();
  const prevSkip = S._cascadeSkipSaveIds;
  S._cascadeSkipSaveIds = pending;
  try {
    await runControlRunnableQueue(null, list, seen, (n) =>
      runCascadeNode(n, seen),
    );
    const names = list.map((n) => n.title).filter(Boolean);
    if (names.length)
      toast(I18n.t("已自动执行下游节点：") + I18n.listJoin(names), "ok");
  } catch (e) {
    toast(I18n.t("下游执行失败：") + ((e && e.message) || String(e)), "err");
  } finally {
    S._cascadeSkipSaveIds = prevSkip;
    /* 无论成败，本批次等待态必须清掉，禁止整图锁在「等待中」 */
    clearPendingRun(pending);
    renderCanvas();
    renderStatus();
  }
}

async function playNode(node, quiet, opts) {
  if (!S.playLocks) S.playLocks = new Map();
  const hit = S.playLocks.get(node.id);
  if (hit) {
    await hit;
    return;
  }
  let unlock = () => {};
  const lock = new Promise((r) => {
    unlock = r;
  });
  S.playLocks.set(node.id, lock);
  /* 新批次发车：清掉上一次的停止标记（一次「终止」只作废当时那一批） */
  beginNodeRun(node);
  /* 用户直接点 ▶ 属于「重新开始」，解除「全部终止」的短窗口拦截；
     由控制节点 / 级联批次驱动的（batchDriven）仍然会被拦掉 */
  if (!(opts && opts.batchDriven)) S._lastStopAllAt = 0;
  try {
    const cascadeAfter = await playNodeBody(node, quiet, opts || {});
    if (cascadeAfter && cascadeAfter.length && nodePlaySucceeded(node)) {
      try {
        await runDownstreamCascade(cascadeAfter);
      } catch (e) {
        toast(I18n.t("下游执行失败：") + (e.message || String(e)), "err");
      }
    }
  } finally {
    if (S.playLocks.get(node.id) === lock) S.playLocks.delete(node.id);
    unlock();
  }
}

/* ── 音乐/视频节点：后端连接探测 + 状态可视化 ── */
const MEDIA_BACKEND_PROBE_MS = 5000;
const mediaBackendProbeTimers = new Map();
const mediaBackendRunWatchers = new Map();
let mediaBackendListenersBound = false;

function isMediaGenNode(node) {
  return !!(
    node &&
    (node.kind === "music_gen" ||
      node.kind === "tts_gen" ||
      node.kind === "video_gen" ||
      node.kind === "remotion")
  );
}

/* ── 网络节点（net_recv / net_send）：节点级独立端口（监听/发送可不同）+ 通道(16bit) 分流，异步互不干涉 ── */
const NET_DEFAULT_PORT = 40999; /* 全局设置回退默认 */
const NET_LISTEN_PORT = 40999; /* 接收节点默认监听端口 */
const NET_SEND_PORT = 41000; /* 发送节点默认目标端口（与监听不同，便于同机双向调试） */
const netRecvSubs = new Map(); /* nodeId -> {port, channel, proto} 当前在监听的接收节点 */

function isNetNode(node) {
  return !!(node && (node.kind === "net_recv" || node.kind === "net_send"));
}
/* 有效端口：节点未单独指定(0)则用全局设置端口；仍未设置则按节点类型取默认（监听 40999 / 发送 41000） */
function netPortOf(node) {
  const raw = Number(node && node.netPort);
  if (raw) return Math.max(1, Math.min(65535, Math.round(raw)));
  const g = Number(S.config && S.config.netPort);
  if (g) return Math.max(1, Math.min(65535, Math.round(g)));
  return node && node.kind === "net_send" ? NET_SEND_PORT : NET_LISTEN_PORT;
}
function netProtoOf(node) {
  return node && node.netProto === "udp" ? "udp" : "tcp";
}
/* 新建网络节点时自动分配下一个空闲通道：从 0 起，每开启一个递增（16bit） */
function nextNetChannel() {
  const used = new Set((S.wf && S.wf.nodes || [])
    .filter((n) => isNetNode(n))
    .map((n) => Number(n.netChannel) || 0));
  if (!used.has(0)) return 0;
  let c = 1;
  while (used.has(c) && c <= 65535) c++;
  return c <= 65535 ? c : 0;
}
function netUnsubRecv(node) {
  const sub = netRecvSubs.get(node.id);
  if (sub) {
    netRecvSubs.delete(node.id);
    if (window.api && window.api.netUnlisten)
      window.api
        .netUnlisten({ port: sub.port, channel: sub.channel, proto: sub.proto })
        .catch(() => {});
  }
}
/* 发送节点读取「信息输入(端口0)」的文本（含图像路径字符串等） */
function netPayloadFrom(node) {
  const src = firstSource(node);
  if (!src) return { ok: false, error: I18n.t("未连接信息输入") };
  const disp = displayValueOf(src, node) || {};
  if (disp.text != null) return { ok: true, data: String(disp.text) };
  if (disp.items && disp.items.length)
    return {
      ok: true,
      data: disp.items.map((i) => i.content ?? i.text ?? i.title ?? "").join("\n"),
    };
  if (disp.image) return { ok: true, data: String(disp.image) };
  const o = src.output;
  if (o != null)
    return { ok: true, data: typeof o === "string" ? o : JSON.stringify(o) };
  return { ok: false, error: I18n.t("信息输入为空") };
}

async function playNetRecvNode(node, quiet) {
  if (node.running) return;
  node.running = true;
  beginNodeRun(node);
  node.error = null;
  const port = netPortOf(node);
  const channel = (Number(node.netChannel) || 0) & 0xffff;
  const proto = netProtoOf(node);
  netUnsubRecv(node);
  try {
    const r = await window.api.netListen({ port, channel, proto });
    if (r && r.listenErr) {
      node.netListening = false;
      node.error = I18n.t("监听失败：") + r.listenErr;
      node.netStatus = "";
    } else {
      netRecvSubs.set(node.id, { port, channel, proto });
      node.netListening = true;
      node.netStatus =
        I18n.t("监听中 · 端口 ") +
        port +
        " · 通道 " +
        channel +
        " · " +
        proto.toUpperCase();
    }
    node.ranAt = Date.now();
  } catch (e) {
    node.netListening = false;
    node.netStatus = "";
    node.error = (e && e.message) || String(e);
  } finally {
    node.running = false;
    renderCanvas();
    renderStatus();
  }
}

async function playNetSendNode(node, quiet) {
  if (node.running) return;
  node.running = true;
  beginNodeRun(node);
  node.error = null;
  const port = netPortOf(node);
  const channel = (Number(node.netChannel) || 0) & 0xffff;
  const proto = netProtoOf(node);
  const payload = netPayloadFrom(node);
  try {
    if (!payload.ok) {
      node.netStatus = "";
      node.error = payload.error;
      node.netCount = (node.netCount || 0);
      return;
    }
    const r = await window.api.netSend({
      host: String(node.netHost || "127.0.0.1"),
      port,
      channel,
      proto,
      data: payload.data,
    });
    if (r && r.ok) {
      node.netCount = (node.netCount || 0) + 1;
      node.netStatus =
        I18n.t("已发送 ") + node.netCount + " 条 · " + proto.toUpperCase() + " " +
        String(node.netHost || "127.0.0.1") + ":" + port;
    } else {
      node.error = (r && r.error) || I18n.t("发送失败");
      node.netStatus = "";
    }
    node.ranAt = Date.now();
  } catch (e) {
    node.netStatus = "";
    node.error = (e && e.message) || String(e);
  } finally {
    node.running = false;
    renderCanvas();
    renderStatus();
  }
}

/* 收到网络消息：路由到匹配的接收节点并向下游级联（异步推送，不进入普通运行队列） */
async function pumpNetRecvMessage(m) {
  const ch = Number(m && m.channel);
  if (!Number.isFinite(ch)) return;
  const proto = m && m.proto;
  const data = m ? m.data : "";
  const at = m ? m.at : Date.now();
  const hits = (S.wf && S.wf.nodes || []).filter(
    (n) =>
      n.kind === "net_recv" &&
      (Number(n.netChannel) || 0) === ch &&
      netRecvSubs.get(n.id) &&
      netProtoOf(n) === proto,
  );
  if (!hits.length) return;
  for (const node of hits) {
    node.output = { kind: "text", text: String(data) };
    node.netCount = (node.netCount || 0) + 1;
    node.netLast = String(data);
    const short = String(data).length > 26 ? String(data).slice(0, 26) + "…" : String(data);
    node.netStatus = I18n.t("已收到 ") + node.netCount + " 条 · " + short;
    node.ranAt = at;
    renderCanvas();
    renderStatus();
  }
  /* 数据线可达的下游处理/保存节点：静默级联 */
  for (const node of hits) {
    const down = collectDownstreamCascade(node);
    if (down.length) await runDownstreamCascade(down);
  }
  /* 控制端子（端口1）：收到消息时触发下游控制目标 */
  for (const node of hits) await fireNetRecvControl(node);
}

/* 从某节点的指定输出端子触发下游可控制运行节点（控制线语义；seen 防环） */
async function fireControlOutgoing(node, outIdx, seen) {
  if (!node) return;
  /* 已被「停止 / 全部终止」的节点不再驱动下游控制线
     （终止后队列自己长出任务，就是这么来的） */
  if (runBatchStopped(node)) return;
  const s2 = new Set(seen || []);
  s2.add(node.id);
  const wires = execOutWires(node, outIdx);
  if (!wires.length) return;
  for (const w of wires) {
    const next = nodeById(w.to);
    if (!next || s2.has(next.id)) continue;
    if (!canControlRun(next)) continue;
    try {
      await runControlledNode(next, s2);
    } catch (e) {
      if (next) next.error = (e && e.message) || String(e);
    }
  }
}

/* 触发「接收」节点的控制输出端子（端口1），驱动下游可控制运行节点 */
async function fireNetRecvControl(node) {
  return fireControlOutgoing(node, 1, new Set([node.id]));
}

let netMessageBound = false;
function bindNetMessageListener() {
  if (netMessageBound || !window.api || !window.api.onNetMessage) return;
  netMessageBound = true;
  window.api.onNetMessage((m) => {
    pumpNetRecvMessage(m || {}).catch(() => {});
  });
}

/* 「监听模式」：接收节点默认在 MTNode 启动/切换到本画布时自动进入监听状态（节点体可取消勾选） */
function netAutoListenEnabled(node) {
  return !!(node && node.kind === "net_recv" && node.netAutoListen !== false);
}
/* 逐节点自动开始监听（已在监听的跳过；单个失败不阻断其它节点） */
async function autoListenNetRecvNodes(quiet) {
  if (!S.wf || !window.api || !window.api.netListen) return;
  const nodes = (S.wf.nodes || []).filter((n) => netAutoListenEnabled(n));
  for (const n of nodes) {
    if (n.running) continue;
    if (netRecvSubs.get(n.id)) continue;
    try {
      await playNetRecvNode(n, !!quiet);
    } catch {}
  }
}

/* ═══════════════ 网络节点（net_recv / net_send）的设置与摘要 ═══════════════
 * 端口 / 通道 / 协议 / 目标地址是**设置** → 一律进 ⚙ 跳窗（app-canvas.js 的
 * NODE_SETTINGS_FORMS 登记表单调 nsNetFields）；节点 body 只留状态、一行只读摘要，
 * 以及「开始监听 / 发送 / 清空 / netdebug」这些动作按钮。
 * 老口径不变：端口填 0 = 用全局设置端口；接收节点改端口 / 协议 / 通道 = 立刻停掉当前
 * 监听（下一拍按新配置重来）——不然用户会以为改完了，其实还在收旧通道。
 */

/* 跳窗里的网络字段（isSend = 发送节点：多个「目标地址」，没有自动监听） */
function nsNetFields(ctx, node, isSend) {
  const restart = () => {
    if (isSend) return;
    if (node.netListening || netRecvSubs.get(node.id)) {
      node.netListening = false;
      playNetRecvNode(node, true);
    }
  };
  if (isSend) {
    nsText(
      ctx,
      I18n.t("目标地址"),
      String(node.netHost || "127.0.0.1"),
      {
        placeholder: "127.0.0.1",
        live: true,
        title: I18n.t("对端地址：本机默认 127.0.0.1，可填远程 IP"),
      },
      (v) => {
        node.netHost = String(v || "").trim() || "127.0.0.1";
      },
    );
  }
  nsNumber(
    ctx,
    I18n.t(isSend ? "目标端口" : "监听端口") +
      I18n.t("（0 = 用全局端口 ") +
      netPortOf(node) +
      "）",
    Number(node.netPort) || 0,
    {
      min: 0,
      max: 65535,
      step: 1,
      fallback: 0,
      title: I18n.t("节点端口；0=用全局设置端口（当前 ") + netPortOf(node) + "）",
    },
    (v) => {
      node.netPort = v;
      restart();
    },
  );
  nsNumber(
    ctx,
    I18n.t("通道号（16bit）"),
    (Number(node.netChannel) || 0) & 0xffff,
    {
      min: 0,
      max: 65535,
      step: 1,
      fallback: 0,
      title: I18n.t("通道号（16bit 整数，0–65535）"),
    },
    (v) => {
      node.netChannel = v;
      restart();
    },
  );
  nsSelect(
    ctx,
    I18n.t("协议"),
    [
      ["tcp", "TCP"],
      ["udp", "UDP"],
    ],
    node.netProto === "udp" ? "udp" : "tcp",
    (v) => {
      node.netProto = v === "udp" ? "udp" : "tcp";
      restart();
    },
  );
  if (!isSend) {
    nsCheck(
      ctx,
      I18n.t("启动时自动监听"),
      node.netAutoListen !== false,
      (v) => {
        node.netAutoListen = v;
      },
      { title: I18n.t("勾选后，打开 MTNode 或切换到本画布时自动进入监听状态") },
    );
  }
}

/* 一行摘要：协议 · 端口（标出用的是节点端口还是全局） · 通道 ·（发送：目标）·（接收：自动监听） */
function netSettingsSummary(node, isSend) {
  const parts = [];
  parts.push(netProtoOf(node).toUpperCase());
  const np = Number(node.netPort) || 0;
  parts.push(
    I18n.t("端口") + " " + (np ? String(np) : I18n.t("全局 ") + netPortOf(node)),
  );
  parts.push(I18n.t("通道") + " " + ((Number(node.netChannel) || 0) & 0xffff));
  if (isSend)
    parts.push(
      I18n.t("目标") + " " + (String(node.netHost || "").trim() || "127.0.0.1"),
    );
  else
    parts.push(
      I18n.t("自动监听") +
        "：" +
        (node.netAutoListen !== false ? I18n.t("开") : I18n.t("关")),
    );
  return parts.join(" · ");
}

function buildNetRecvBody(body, node) {
  const st = document.createElement("div");
  st.className =
    "n-status" +
    (node.error ? " err" : node.netListening ? " done" : node.netStatus ? " done" : "");
  st.textContent =
    node.netStatus ||
    (node.error ? String(node.error) : I18n.t("未监听 · 点击「开始监听」"));
  body.appendChild(st);
  appendNodeSettingsSummary(node, body);
  if (node.netLast) {
    const prev = document.createElement("div");
    prev.className = "net-last";
    prev.textContent = String(node.netLast).slice(0, 200);
    prev.title = String(node.netLast);
    body.appendChild(prev);
  }
  const ops = document.createElement("div");
  ops.className = "net-ops";
  const btn = document.createElement("button");
  btn.className = "mini" + (node.netListening ? "" : " primary");
  btn.textContent = node.netListening ? I18n.t("■ 停止监听") : I18n.t("▶ 开始监听");
  btn.onclick = () => {
    if (node.netListening || netRecvSubs.get(node.id)) {
      netUnsubRecv(node);
      node.netListening = false;
      node.netStatus = I18n.t("已停止监听");
      renderCanvas();
      renderStatus();
    } else {
      playNetRecvNode(node);
    }
  };
  ops.appendChild(btn);
  const clr = document.createElement("button");
  clr.className = "mini";
  clr.textContent = I18n.t("清空");
  clr.onclick = () => {
    pushHistory();
    node.netCount = 0;
    node.netLast = "";
    node.output = null;
    scheduleSave();
    renderCanvas();
  };
  ops.appendChild(clr);
  const dbg = document.createElement("button");
  dbg.className = "mini";
  dbg.textContent = "netdebug";
  dbg.title = I18n.t("用 netdebug 调试本通道（预填协议/端口/通道，以客户端发送测试帧）");
  dbg.onclick = () => {
    const p = window.api && window.api.netOpenDebug
      ? window.api.netOpenDebug({
          proto: netProtoOf(node),
          host: "127.0.0.1",
          port: netPortOf(node),
          channel: (Number(node.netChannel) || 0) & 0xffff,
          role: "client",
        })
      : Promise.resolve({ ok: false, error: "preload 无 netOpenDebug" });
    p.then((res) => {
      if (res && !res.ok) {
        node.netStatus = "netdebug: " + (res.error || I18n.t("启动失败"));
        renderCanvas();
      }
    }).catch(() => {});
  };
  ops.appendChild(dbg);
  body.appendChild(ops);
}

function buildNetSendBody(body, node) {
  const st = document.createElement("div");
  st.className = "n-status" + (node.error ? " err" : node.netStatus ? " done" : "");
  st.textContent = node.netStatus || node.error || I18n.t("等待触发 · 连接信息输入后发送");
  body.appendChild(st);
  appendNodeSettingsSummary(node, body);
  const ops = document.createElement("div");
  ops.className = "net-ops";
  const btn = document.createElement("button");
  btn.className = "mini primary";
  btn.textContent = I18n.t("▶ 发送");
  btn.onclick = () => playNetSendNode(node);
  ops.appendChild(btn);
  const clr = document.createElement("button");
  clr.className = "mini";
  clr.textContent = I18n.t("清空计数");
  clr.onclick = () => {
    pushHistory();
    node.netCount = 0;
    node.netStatus = "";
    scheduleSave();
    renderCanvas();
  };
  ops.appendChild(clr);
  const dbg = document.createElement("button");
  dbg.className = "mini";
  dbg.textContent = "netdebug";
  dbg.title = I18n.t("用 netdebug 监听本节点目标端口，抓取出站帧（预填协议/端口/通道）");
  dbg.onclick = () => {
    const p = window.api && window.api.netOpenDebug
      ? window.api.netOpenDebug({
          proto: netProtoOf(node),
          host: "0.0.0.0",
          port: netPortOf(node),
          channel: (Number(node.netChannel) || 0) & 0xffff,
          role: "server",
        })
      : Promise.resolve({ ok: false, error: "preload 无 netOpenDebug" });
    p.then((res) => {
      if (res && !res.ok) {
        node.netStatus = "netdebug: " + (res.error || I18n.t("启动失败"));
        renderCanvas();
      }
    }).catch(() => {});
  };
  ops.appendChild(dbg);
  body.appendChild(ops);
}

function ensureBackendUiState(node) {
  if (!node.backendUi || typeof node.backendUi !== "object") {
    node.backendUi = {
      ok: null,
      probing: false,
      lastAt: 0,
      info: null,
      genPct: 0,
      genMsg: "",
    };
  }
  return node.backendUi;
}

function looksLikeBackendConnError(err) {
  const s = String(err || "");
  const low = s.toLowerCase();
  return (
    /请先在|未启用|启用后端|后端服务|连接失败|无法连接|econnrefused|enotfound|fetch failed|network|unreachable|timed?\s*out|socket hang up|comfy.*(down|fail)|gradio.*(down|fail)/i.test(
      s,
    ) || /econnrefused|enotfound|fetch failed|network|unreachable|timed?\s*out|socket hang up/.test(low)
  );
}

function stopMediaBackendProbe(nodeId) {
  const t = mediaBackendProbeTimers.get(nodeId);
  if (t) {
    clearInterval(t);
    mediaBackendProbeTimers.delete(nodeId);
  }
}

function stopMediaBackendRunWatcher(nodeId) {
  const t = mediaBackendRunWatchers.get(nodeId);
  if (!t) return;
  clearInterval(t);
  mediaBackendRunWatchers.delete(nodeId);
  /* 在途生成的监视器收摊 = 队列里这一条的状态变了：立刻重绘，不等心跳 */
  updateRunQueuePanel();
}

function startMediaBackendProbeLoop(nodeId) {
  if (mediaBackendProbeTimers.has(nodeId)) return;
  const timer = setInterval(() => {
    const n = nodeById(nodeId);
    if (!n || !isMediaGenNode(n)) {
      stopMediaBackendProbe(nodeId);
      return;
    }
    const ui = ensureBackendUiState(n);
    if (ui.ok === true) {
      stopMediaBackendProbe(nodeId);
      return;
    }
    probeMediaBackend(n, { quiet: true });
  }, MEDIA_BACKEND_PROBE_MS);
  mediaBackendProbeTimers.set(nodeId, timer);
}

function startMediaBackendRunWatcher(node) {
  if (!node || !isMediaGenNode(node)) return;
  stopMediaBackendRunWatcher(node.id);
  /* 记录起跑时的停止代号：一旦该节点被停止 / 「全部终止」，监视器立刻自毁，
     不再探测回写（旧实现会让已终止的节点继续占用运行队列） */
  const stopTick = Number(node._stopTick) || 0;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const n = nodeById(node.id);
    if (
      !n ||
      !n.running ||
      node._aborted ||
      (Number(node._stopTick) || 0) !== stopTick ||
      /* 兜底上限：任务本身由 generate IPC 收尾，监视器不无限存活 */
      Date.now() - startedAt > 3 * 60 * 60 * 1000
    ) {
      stopMediaBackendRunWatcher(node.id);
      return;
    }
    probeMediaBackend(n, { quiet: true, soft: true });
  }, 2000);
  mediaBackendRunWatchers.set(node.id, timer);
  /* 后端任务进入在途：运行队列补上「在途生成 / 后端生成中」 */
  updateRunQueuePanel();
}

function markMediaBackendDown(node, st) {
  if (!isMediaGenNode(node)) return;
  const ui = ensureBackendUiState(node);
  ui.ok = false;
  if (st) ui.info = summarizeMediaBackendStatus(node, st);
  ui.lastAt = Date.now();
  startMediaBackendProbeLoop(node.id);
}

function summarizeMediaBackendStatus(node, st) {
  if (!st) return null;
  const apiUp =
    node.kind === "music_gen"
      ? !!st.gradioUp
      : node.kind === "tts_gen"
        ? !!st.apiUp
        : !!st.comfyUp;
  return {
    version: st.version || "",
    port: st.port || 0,
    running: !!st.running,
    apiUp,
    installed: !!st.installed,
    installing: !!st.installing,
    wantRunning: !!st.wantRunning,
    installDir: st.installDir || "",
    lock: st.lock || null,
    gpu: st.gpu || null,
    cpuVae: !!st.cpuVae,
  };
}

function refreshMediaNodeUi(node, opts) {
  opts = opts || {};
  if (!node || !S.wf) return;
  if (opts.soft) {
    try {
      const root = document.querySelector('.wf-node[data-nid="' + node.id + '"]');
      if (!root) {
        refreshNodeEl(node.id);
        return;
      }
      const old = root.querySelector(".n-backend-panel");
      if (!old) {
        refreshNodeEl(node.id);
        return;
      }
      const wrap = document.createElement("div");
      appendMediaBackendPanel(wrap, node);
      const neu = wrap.firstChild;
      if (neu) old.replaceWith(neu);
      const ui = ensureBackendUiState(node);
      const probe = root.querySelector(".n-backend-probe");
      if (probe) {
        probe.className =
          "n-play n-backend-probe" +
          (ui.probing ? " wait" : ui.ok === true ? " ok" : ui.ok === false ? " bad" : " wait");
      }
      /* 路径 / 种子：body 上是只读摘要片段，跳窗里是可编辑控件，两边一起刷
         （摘要里的种子带「+1」摇数标记，控件只要数字 → 分开给值） */
      syncNodeSettingsValue(
        node,
        "mgpath",
        mediaGenOutputRaw(node) || String(node.outputPath || ""),
      );
      syncNodeSettingsValue(
        node,
        "mgseed",
        mediaGenSeedSlotText(node),
        String(node.seed != null ? node.seed : 0),
      );
      const errEl = root.querySelector(".n-status.err");
      if (node.error) {
        if (errEl) errEl.textContent = node.error;
        else {
          const body = root.querySelector(".n-body") || root;
          const st = document.createElement("div");
          st.className = "n-status err";
          st.textContent = node.error;
          body.appendChild(st);
        }
      } else if (errEl) {
        errEl.remove();
      }
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    refreshNodeEl(node.id);
  } catch {
    renderCanvas();
  }
}

/* 后端状态单一取数口：三类生成节点各自的宿主插件（Gradio / GPT-SoVITS 管理服务 / Comfy）。
   remotion 无远端后端，调用方自行早退。取不到（插件未装 / IPC 异常）一律返回 null。 */
async function fetchMediaBackendStatus(node) {
  if (!node || !window.api) return null;
  if (node.kind === "music_gen")
    return window.api.music3Status ? await window.api.music3Status() : null;
  if (node.kind === "tts_gen")
    return window.api.ttsStatus ? await window.api.ttsStatus() : null;
  return window.api.h3Status ? await window.api.h3Status() : null;
}

async function probeMediaBackend(node, opts) {
  opts = opts || {};
  if (!isMediaGenNode(node) || !window.api) return;
  /* remotion 无远端后端：渲染在本地主进程宿主完成，不做连接探测 */
  if (node.kind === "remotion") return;
  const ui = ensureBackendUiState(node);
  if (ui.probing && !opts.force) return;
  ui.probing = true;
  if (!opts.quiet) refreshMediaNodeUi(node, { soft: true });
  let st = null;
  try {
    st = await fetchMediaBackendStatus(node);
  } catch {
    st = null;
  }
  ui.probing = false;
  ui.lastAt = Date.now();
  ui.info = summarizeMediaBackendStatus(node, st);
  const ok = !!(st && st.running);
  if (opts.soft) {
    if (!ok) {
      ui.ok = false;
      startMediaBackendProbeLoop(node.id);
    } else if (ui.ok !== true) {
      ui.ok = true;
      stopMediaBackendProbe(node.id);
    }
  } else {
    ui.ok = ok;
    if (ok) stopMediaBackendProbe(node.id);
    else startMediaBackendProbeLoop(node.id);
  }
  if (opts.manual) {
    toast(
      ok
        ? I18n.t("后端当前在线（任务执行时会自动启停）")
        : I18n.t("后端当前未运行（执行节点时会自动启动）"),
      ok ? "ok" : "warn",
    );
  }
  refreshMediaNodeUi(node, { soft: true });
}

function ensureMediaBackendProbesForWorkflow(opts) {
  opts = opts || {};
  if (!S.wf || !S.wf.nodes) return;
  const live = new Set();
  for (const n of S.wf.nodes) {
    if (!isMediaGenNode(n)) continue;
    live.add(n.id);
    const ui = ensureBackendUiState(n);
    if (opts.reset) {
      ui.ok = null;
      ui.probing = false;
      ui.genPct = n.running ? ui.genPct : 0;
      if (!n.running) ui.genMsg = "";
    }
    if (ui.ok === true) continue;
    probeMediaBackend(n, { quiet: true });
  }
  for (const id of [...mediaBackendProbeTimers.keys()]) {
    if (!live.has(id)) stopMediaBackendProbe(id);
  }
  for (const id of [...mediaBackendRunWatchers.keys()]) {
    if (!live.has(id)) stopMediaBackendRunWatcher(id);
  }
}

function bindMediaBackendListeners() {
  if (mediaBackendListenersBound || !window.api) return;
  mediaBackendListenersBound = true;
  if (window.api.onMusic3Progress) {
    window.api.onMusic3Progress((data) => {
      if (!data || data.phase !== "generate" || !data.nodeId) return;
      const n = nodeById(data.nodeId);
      if (!n || n.kind !== "music_gen") return;
      const ui = ensureBackendUiState(n);
      if (data.cancelled || n._aborted || String(data.message || "") === "已取消") {
        n.running = false;
        n.error = null;
        n.musicStatus = I18n.t("已取消");
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        stopMediaBackendRunWatcher(n.id);
        refreshMediaNodeUi(n, { soft: true });
        return;
      }
      if (data.pct != null) ui.genPct = Math.max(0, Math.min(100, Number(data.pct) || 0));
      if (data.message) {
        ui.genMsg = mediaGenRollProgressTag(n) + String(data.message);
        n.musicStatus = ui.genMsg;
      }
      if (data.error && looksLikeBackendConnError(data.message)) {
        markMediaBackendDown(n);
      }
      refreshMediaNodeUi(n, { soft: true });
    });
  }
  if (window.api.onH3Progress) {
    window.api.onH3Progress((data) => {
      if (!data || data.phase !== "generate" || !data.nodeId) return;
      const n = nodeById(data.nodeId);
      if (!n || n.kind !== "video_gen") return;
      const ui = ensureBackendUiState(n);
      if (data.cancelled || n._aborted || String(data.message || "") === "已取消") {
        n.running = false;
        n.error = null;
        n.videoStatus = I18n.t("已取消");
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        stopMediaBackendRunWatcher(n.id);
        refreshMediaNodeUi(n, { soft: true });
        return;
      }
      if (data.pct != null) ui.genPct = Math.max(0, Math.min(100, Number(data.pct) || 0));
      if (data.message) {
        ui.genMsg = mediaGenRollProgressTag(n) + String(data.message);
        n.videoStatus = ui.genMsg;
      }
      if (data.error && looksLikeBackendConnError(data.message)) {
        markMediaBackendDown(n);
      }
      refreshMediaNodeUi(n, { soft: true });
    });
  }
  if (window.api.onMusic3Gpu) {
    window.api.onMusic3Gpu((gpu) => {
      if (!gpu || !S.wf) return;
      for (const n of S.wf.nodes || []) {
        if (n.kind !== "music_gen") continue;
        const ui = ensureBackendUiState(n);
        if (ui.ok !== true && !n.running) continue;
        ui.info = ui.info || {};
        ui.info.gpu = gpu;
        if (n.running || S.sel === n.id) refreshMediaNodeUi(n, { soft: true });
      }
    });
  }
  if (window.api.onH3Gpu) {
    window.api.onH3Gpu((gpu) => {
      if (!gpu || !S.wf) return;
      for (const n of S.wf.nodes || []) {
        if (n.kind !== "video_gen") continue;
        const ui = ensureBackendUiState(n);
        if (ui.ok !== true && !n.running) continue;
        ui.info = ui.info || {};
        ui.info.gpu = gpu;
        if (n.running || S.sel === n.id) refreshMediaNodeUi(n, { soft: true });
      }
    });
  }
  bindRemotionNodeListeners();
}

/* Remotion 渲染进度（remotion:progress，phase=render）：驱动节点状态与进度条。
   与 onH3Progress 同构；渲染在本地主进程宿主完成，无后端连接探测。 */
function bindRemotionNodeListeners() {
  if (!window.api || !window.api.onRemotionProgress) return;
  window.api.onRemotionProgress((data) => {
    if (!data || data.phase !== "render" || !data.nodeId) return;
    const n = nodeById(data.nodeId);
    if (!n || n.kind !== "remotion") return;
    if (data.cancelled || n._aborted || String(data.message || "") === "已取消") {
      n.running = false;
      n.error = null;
      n.remotionStatus = I18n.t("已取消");
      n.remotionPct = 0;
      renderCanvas();
      return;
    }
    if (data.pct != null)
      n.remotionPct = Math.max(0, Math.min(100, Number(data.pct) || 0));
    if (data.message) {
      const ui = ensureBackendUiState(n);
      n.remotionStatus =
        mediaGenRollProgressTag(n) + String(data.message);
      ui.genPct = n.remotionPct;
      ui.genMsg = n.remotionStatus;
    }
    if (data.error) {
      n.error = String(data.message || data.error || "");
      n.running = false;
      n.remotionPct = 0;
    }
    renderCanvas();
  });
}

function appendBackendProbeBtn(head, node) {
  const ui = ensureBackendUiState(node);
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "n-play n-backend-probe" +
    (ui.probing ? " wait" : ui.ok === true ? " ok" : ui.ok === false ? " bad" : " wait");
  b.textContent = "◎";
  b.title =
    ui.ok === true
      ? I18n.t("后端已连接 · 点击重新检测")
      : ui.ok === false
        ? I18n.t("后端未连接 · 点击重试")
        : I18n.t("检测与后端的连接");
  b.onclick = (ev) => {
    ev.stopPropagation();
    probeMediaBackend(node, { manual: true, force: true });
  };
  head.appendChild(b);
}


function appendMediaConsoleBtn(head, node) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "n-play n-media-console";
  b.textContent = "▤";
  b.title =
    node.kind === "video_gen"
      ? I18n.t("打开 H3 控制台日志")
      : node.kind === "tts_gen"
        ? I18n.t("打开 GPT-SoVITS 控制台")
        : I18n.t("打开 Music 3 控制台日志");
  b.onclick = async (ev) => {
    ev.stopPropagation();
    if (!window.api) return;
    try {
      const r =
        node.kind === "video_gen"
          ? window.api.h3Open
            ? await window.api.h3Open()
            : null
          : node.kind === "tts_gen"
            ? window.api.ttsOpen
              ? await window.api.ttsOpen()
              : null
            : window.api.music3Open
              ? await window.api.music3Open()
              : null;
      if (!r || !r.ok) {
        toast(
          I18n.t("打开控制台失败：") + ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
      }
    } catch (e) {
      toast(I18n.t("打开控制台失败：") + ((e && e.message) || String(e)), "err");
    }
  };
  head.appendChild(b);
}

/* Remotion 控制台按钮（▤）：打开主进程 remotion 控制台窗（状态 / 安装 / 日志） */
function appendRemotionConsoleBtn(head, node) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "n-play n-media-console";
  b.textContent = "▤";
  b.title = I18n.t("打开 Remotion 控制台（状态 / 安装 / 日志）");
  b.onclick = async (ev) => {
    ev.stopPropagation();
    if (!window.api || !window.api.remotionOpen) return;
    try {
      const r = await window.api.remotionOpen();
      if (!r || !r.ok) {
        toast(
          I18n.t("打开控制台失败：") + ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
      }
    } catch (e) {
      toast(I18n.t("打开控制台失败：") + ((e && e.message) || String(e)), "err");
    }
  };
  head.appendChild(b);
}
function appendMediaBackendPanel(body, node) {
  const ui = ensureBackendUiState(node);
  const info = ui.info || {};
  const gpu = info.gpu || null;
  const panel = document.createElement("div");
  panel.className = "n-backend-panel";
  panel.dataset.nid = node.id;

  const row = document.createElement("div");
  row.className = "n-backend-pills";
  const pill = (label, state) => {
    const s = document.createElement("span");
    s.className = "n-backend-pill " + (state || "");
    s.textContent = label;
    return s;
  };
  row.appendChild(
    pill(
      ui.ok === true ? I18n.t("已连接") : ui.ok === false ? I18n.t("未连接") : I18n.t("检测中"),
      ui.ok === true ? "ok" : ui.ok === false ? "bad" : "wait",
    ),
  );
  if (info.port)
    row.appendChild(pill(":" + info.port, info.running ? "ok" : "muted"));
  if (info.apiUp != null)
    row.appendChild(
      pill(
        node.kind === "music_gen"
          ? "Gradio"
          : node.kind === "tts_gen"
            ? "API"
            : "Comfy",
        info.apiUp ? "ok" : "bad",
      ),
    );
  if (info.version) row.appendChild(pill("v" + info.version, "muted"));
  if (info.installing) row.appendChild(pill(I18n.t("安装中"), "wait"));
  else if (info.installed === false) row.appendChild(pill(I18n.t("未安装"), "bad"));
  panel.appendChild(row);

  const addBar = (label, pct, detail, parent, hint) => {
    const wrap = document.createElement("div");
    wrap.className = "n-backend-bar";
    const lab = document.createElement("div");
    lab.className = "n-backend-bar-lab";
    const left = document.createElement("span");
    left.textContent = label;
    const right = document.createElement("span");
    right.textContent =
      detail != null && detail !== ""
        ? detail
        : Math.round(pct || 0) + "%";
    lab.appendChild(left);
    lab.appendChild(right);
    const track = document.createElement("div");
    track.className = "n-backend-bar-track";
    const fill = document.createElement("i");
    fill.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
    track.appendChild(fill);
    wrap.appendChild(lab);
    wrap.appendChild(track);
    if (hint) {
      const hintEl = document.createElement("div");
      hintEl.className = "n-backend-hint";
      hintEl.textContent = hint;
      wrap.appendChild(hintEl);
    }
    (parent || panel).appendChild(wrap);
    return wrap;
  };

  if (gpu) {
    const bars = document.createElement("div");
    bars.className = "n-backend-bars-row";
    addBar(
      I18n.t("显存"),
      gpu.memPct,
      gpu.memUsed != null && gpu.memTotal != null
        ? gpu.memUsed + "/" + gpu.memTotal + " MiB" +
          (gpu.memPct != null ? " · " + gpu.memPct + "%" : "")
        : gpu.memPct != null
          ? gpu.memPct + "%"
          : "",
      bars,
    );
    addBar(
      I18n.t("GPU"),
      gpu.util,
      (gpu.util != null ? gpu.util : 0) + "%",
      bars,
    );
    panel.appendChild(bars);
  } else if (ui.ok === true) {
    const hint = document.createElement("div");
    hint.className = "n-backend-hint";
    hint.textContent = I18n.t("暂无 GPU 读数");
    panel.appendChild(hint);
  }

  const showGen = node.running || (ui.genPct > 0 && ui.genPct < 100) || !!ui.genMsg;
  if (showGen) {
    const genPct = node.running ? ui.genPct || 8 : ui.genPct;
    const genHint =
      ui.genMsg || (node.running ? I18n.t("生成中…") : "") || "";
    addBar(
      I18n.t("生成"),
      genPct,
      ui.genPct ? Math.round(ui.genPct) + "%" : node.running ? "…" : "",
      panel,
      genHint,
    );
  }

  if (info.lock && info.lock.nodeId) {
    const lockEl = document.createElement("div");
    lockEl.className = "n-backend-hint";
    const holder = nodeById(info.lock.nodeId);
    lockEl.textContent =
      I18n.t("任务锁 · ") +
      ((holder && holder.title) || info.lock.nodeId) +
      (info.lock.nodeId === node.id ? I18n.t("（本节点）") : "");
    panel.appendChild(lockEl);
  }

  if (node.kind === "video_gen" && info.cpuVae) {
    const hint = document.createElement("div");
    hint.className = "n-backend-hint";
    hint.textContent = I18n.t("CPU VAE 已启用");
    panel.appendChild(hint);
  }

  body.appendChild(panel);
}

function musicGenSlotText(node, slot) {
  const w = wiresTo(node.id).find((x) => Number(x.toIndex) === Number(slot));
  if (!w) return "";
  const src = nodeById(w.from);
  const v = valueFromWire(w, node, 0);
  if (v && v.kind === "text") return String(v.text || "");
  const d = displayValueOf(src, node);
  if (d && d.text != null) return String(d.text);
  return "";
}


function syncMediaGenSeedFromDom(node) {
  if (!node || !node.id) return;
  /* 种子输入框现在只存在于「设置」跳窗里（body 上是只读摘要，读它没有意义）；
     窗没开 → node.seed 就是真源，不必回读。 */
  const v = Math.floor(Number(readNodeSettingsCtl(node, "mgseed")));
  if (isFinite(v)) node.seed = v;
}
/** 摇数开启时每次生成（含抽卡）种子 +1；关闭则沿用当前种子。返回本次使用的种子。 */
function nextMediaGenSeed(node) {
  syncMediaGenSeedFromDom(node);
  let s = Math.floor(Number(node.seed));
  if (!isFinite(s)) s = 0;
  if (node.rerollSeed !== false) {
    s += 1;
    if (s > 2147483647) s = 0;
    node.seed = s;
    scheduleSave();
    syncNodeSettingsValue(node, "mgseed", mediaGenSeedSlotText(node), String(s));
  }
  return s;
}
/* ═══════════ 生成类节点（music_gen / video_gen / tts_gen）的设置与摘要 ═══════════
 * 立规：设置一律在 ⚙ 跳窗里改，节点 body 只留「一行只读摘要 + 动作按钮」。
 *   nsMediaGenParamFields / nsMediaGenPathField → 跳窗里的可编辑控件（app-canvas.js
 *     的 NODE_SETTINGS_FORMS 登记表单调用它们，字段真源与老 body 面板完全一致）；
 *   appendMediaGenSummaryBody → body 上的一到两行只读摘要，值片段沿用老控件的 id
 *     （mgdur- / mgseed- / mgrolls- / mgpath- / ttsvoice-），运行期回填与跳窗控件
 *     由 app-canvas.js 的 syncNodeSettingsValue() 一起刷新，两边不会看到一个改一个不改。
 * 动作按钮（浏览 / 位置 / 打开）留在摘要行上：它们是动作，不是设置。
 */
function mediaGenDurValue(node) {
  if (node.kind === "music_gen") return Number(node.audioDuration) || 60;
  return node.duration != null ? Number(node.duration) : 5;
}
/* 抽卡 / 时长 / 种子 / 摇数（music_gen · video_gen 专用；tts_gen 没这几项，别调它） */
function nsMediaGenParamFields(ctx, node) {
  const isMusic = node.kind === "music_gen";
  const isCustomVid = node.kind === "video_gen" && isCustomVideoGen(node);
  nsNumber(
    ctx,
    I18n.t("抽卡次数"),
    attemptCount(node),
    {
      id: nodeSettingsCtlId("mgrolls", node.id),
      min: 1,
      max: 10,
      step: 1,
      fallback: 1,
      title: I18n.t("连续生成次数（1–10）；多次时输出命名为 _01、_02 …"),
    },
    (v) => {
      node.attempts = attemptCount({ attempts: v });
      syncNodeSettingsValue(node, "mgrolls", String(node.attempts));
    },
  );
  if (isCustomVid) {
    /* 自建工作流：时长 / 分辨率 / 后处理由工作流图自身决定 → 不给时长字段 */
    ctx.hint(I18n.t("自建工作流：时长 / 分辨率 / 后处理由工作流图自身决定"));
  } else {
    nsNumber(
      ctx,
      I18n.t("时长（秒）"),
      mediaGenDurValue(node),
      isMusic
        ? {
            id: nodeSettingsCtlId("mgdur", node.id),
            min: 10,
            max: 150,
            step: 1,
            fallback: 60,
            title: I18n.t("时长（秒，≤150）"),
          }
        : {
            id: nodeSettingsCtlId("mgdur", node.id),
            min: 4,
            max: 15,
            step: 0.5,
            fallback: 5,
            title: I18n.t("时长（秒，4–15）"),
          },
      (v) => {
        if (isMusic) node.audioDuration = Math.max(10, Math.min(150, v || 60));
        else node.duration = Math.max(4, Math.min(15, v || 5));
        syncNodeSettingsValue(
          node,
          "mgdur",
          String(mediaGenDurValue(node)) + "s",
          String(mediaGenDurValue(node)),
        );
      },
    );
  }
  nsNumber(
    ctx,
    I18n.t("种子"),
    node.seed != null ? node.seed : 0,
    {
      id: nodeSettingsCtlId("mgseed", node.id),
      step: 1,
      fallback: 0,
      live: true,
      title: I18n.t("种子"),
    },
    (v) => {
      node.seed = Math.floor(v);
      syncNodeSettingsValue(node, "mgseed", String(node.seed));
    },
  );
  nsCheck(
    ctx,
    I18n.t("摇数（每次执行种子 +1）"),
    node.rerollSeed !== false,
    (v) => {
      node.rerollSeed = v;
    },
    { title: I18n.t("每次执行种子 +1（默认开启）") },
  );
}

/* 输出路径（媒体生成必须自己指定落盘位置：老口径完全保留） */
function nsMediaGenPathField(ctx, node, media) {
  const isTts = node.kind === "tts_gen";
  const extHint = media === "video" ? "*.mp4" : isTts ? "*.wav / *.mp3" : "*.wav";
  const hasWs = !!String(wfWorkspace() || "").trim();
  nsText(
    ctx,
    I18n.t("输出路径"),
    mediaGenOutputRaw(node) || String(node.outputPath || ""),
    {
      id: nodeSettingsCtlId("mgpath", node.id),
      span: true,
      live: true,
      placeholder: hasWs
        ? I18n.t("相对工作目录或绝对路径（") + extHint + I18n.t("）…")
        : I18n.t("输出路径（必须设置，") + extHint + I18n.t("）…"),
      title: I18n.t(
        "输出文件路径；相对路径需先设顶栏工作目录。后缀由输出类型固定（语音跟随所选输出格式）。",
      ),
      /* 失焦时按老口径补后缀 + 相对化（这个函数本身就是那件事的真源） */
      normalize: (v) => applyMediaGenConfiguredPath(node, v, media),
      commit: { history: true, rerender: true },
    },
    (raw) => {
      const v = String(raw || "").trim();
      /* normalize 已经写过 node.outputPath 时别再覆盖（值相同，但口径只留一处） */
      if (v !== String(node.outputPath || "").trim()) {
        node.outputPath = v;
        node.filename = "";
      }
      syncNodeSettingsValue(node, "mgpath", v);
    },
  );
  if (!String(mediaGenOutputRaw(node) || node.outputPath || "").trim())
    ctx.hint(I18n.t("未设置输出路径时无法启动生成"));
}

/* 路径动作按钮：浏览（写路径）/ 位置（在文件夹中显示）/ 打开（系统默认应用） */
function mediaGenPathActionButtons(node, media) {
  const isTts = node.kind === "tts_gen";
  const ext = isTts
    ? mediaGenExt(node)
    : saveExtForMedia(media === "video" ? "video" : "audio");
  const applyPath = (raw) => {
    applyMediaGenConfiguredPath(node, raw, media);
    syncNodeSettingsValue(node, "mgpath", node.outputPath);
    scheduleSave();
    renderCanvas();
  };
  const btns = [];
  const br = document.createElement("button");
  br.className = "mini";
  br.textContent = I18n.t("浏览");
  br.onclick = async (ev) => {
    ev.stopPropagation();
    const ws = String(wfWorkspace() || "").trim();
    const defaultName = safeFile(node.title || (media === "video" ? "video" : "music")) + ext;
    /* 语音节点默认前缀 voice/SoVITS/（相对工作目录 → 由 applySuperRelToPath 归位） */
    let defaultPath = isTts ? "voice/SoVITS/" + defaultName : defaultName;
    const cur = mediaGenOutputRaw(node) || String(node.outputPath || "").trim();
    if (cur) {
      const r0 = resolveSavePath(forcePathExt(cur, ext), node);
      defaultPath = r0.ok ? r0.path : cur;
    } else if (ws) {
      defaultPath = joinPath(ws, applySuperRelToPath(node, defaultPath));
    }
    const r = await window.api.fileSaveDialog({
      title:
        media === "video"
          ? I18n.t("选择视频保存位置")
          : I18n.t("选择音频保存位置"),
      defaultPath,
      filters:
        media === "video"
          ? [
              { name: I18n.t("视频"), extensions: ["mp4"] },
              { name: I18n.t("全部文件"), extensions: ["*"] },
            ]
          : isTts
            ? [
                { name: I18n.t("音频"), extensions: ["wav", "mp3"] },
                { name: I18n.t("全部文件"), extensions: ["*"] },
              ]
            : [
                { name: I18n.t("音频"), extensions: ["wav"] },
                { name: I18n.t("全部文件"), extensions: ["*"] },
              ],
    });
    if (r && r.path) applyPath(r.path);
  };
  btns.push(br);
  const hasTarget =
    !!String(mediaGenOutputRaw(node) || node.outputPath || "").trim() ||
    !!(node.output && (node.output.path || node.output.text));
  if (hasTarget) {
    const op = document.createElement("button");
    op.className = "mini";
    op.textContent = I18n.t("位置");
    op.title = I18n.t("在文件夹中显示已生成文件");
    op.onclick = async (ev) => {
      ev.stopPropagation();
      const show = await resolveMediaGenActionPath(node);
      if (show && window.api && window.api.shellShowItem) window.api.shellShowItem(show);
      else toast(I18n.t("文件不存在或无法预览"), "warn");
    };
    btns.push(op);
    const openBtn = document.createElement("button");
    openBtn.className = "mini";
    openBtn.textContent = I18n.t("打开");
    openBtn.title = I18n.t("用系统默认应用打开");
    openBtn.onclick = async (ev) => {
      ev.stopPropagation();
      const target = await resolveMediaGenActionPath(node);
      if (!target) {
        toast(I18n.t("文件不存在或无法预览"), "warn");
        return;
      }
      await openContentRef(target, "file");
    };
    btns.push(openBtn);
  }
  return btns;
}

/* body 摘要：一行参数 +（媒体类）一行输出路径（带动作按钮）。tts 另加音色 / 语速 / 格式。 */
function appendMediaGenSummaryBody(node, body, media) {
  const isTts = node.kind === "tts_gen";
  const isCustomVid = node.kind === "video_gen" && isCustomVideoGen(node);
  const slots = [];
  if (isTts) {
    slots.push({
      id: "ttsvoice-" + node.id,
      label: I18n.t("音色"),
      value: String(node.voice || "").trim() || I18n.t("（默认）"),
    });
    slots.push({ label: I18n.t("语速"), value: String(ttsSpeedOf(node)) });
    slots.push({ label: I18n.t("格式"), value: ttsFormatOf(node) });
  } else if (isCustomVid) {
    slots.push({ label: I18n.t("工作流"), value: (node.wfMeta && node.wfMeta.title) || I18n.t("（未选择）") });
    slots.push({ id: "mgrolls-" + node.id, label: I18n.t("抽卡"), value: String(attemptCount(node)) });
    slots.push({ id: "mgseed-" + node.id, label: I18n.t("种子"), value: mediaGenSeedSlotText(node) });
  } else {
    slots.push({
      id: "mgdur-" + node.id,
      label: I18n.t("时长"),
      value: mediaGenDurValue(node) + "s",
    });
    slots.push({ id: "mgrolls-" + node.id, label: I18n.t("抽卡"), value: String(attemptCount(node)) });
    slots.push({ id: "mgseed-" + node.id, label: I18n.t("种子"), value: mediaGenSeedSlotText(node) });
  }
  appendNodeSettingsSummary(node, body, { slots, cls: "mg-sum" });
  const pslots = [
    {
      id: "mgpath-" + node.id,
      label: I18n.t("输出"),
      value:
        mediaGenOutputRaw(node) ||
        String(node.outputPath || "").trim() ||
        I18n.t("（未设置）"),
    },
  ];
  appendNodeSettingsSummary(node, body, {
    slots: pslots,
    gear: false,
    cls: "mg-sum mg-sum-path",
    actions: mediaGenPathActionButtons(node, media),
  });
}

/* 摘要里的种子片段：开着摇数时标出来，免得看到种子没变以为没生效 */
function mediaGenSeedSlotText(node) {
  return (
    String(node.seed != null ? node.seed : 0) +
    (node.rerollSeed !== false ? " +1" : "")
  );
}

/* 同一批字段的「一行文本」版：登记表单要 summary（浏览态、别处引用）时用这个，
   与 appendMediaGenSummaryBody 的片段口径一一对应，不另起一套说法。 */
function mediaGenParamSummaryText(node) {
  const isTts = node.kind === "tts_gen";
  const isCustomVid = node.kind === "video_gen" && isCustomVideoGen(node);
  const parts = [];
  if (isTts) {
    parts.push(
      I18n.t("音色 ") +
        (String(node.voice || "").trim() || I18n.t("（默认）")) +
        " · " +
        I18n.t("语速 ") +
        ttsSpeedOf(node) +
        " · " +
        ttsFormatOf(node),
    );
  } else {
    if (isCustomVid)
      parts.push(
        I18n.t("工作流") +
          " " +
          ((node.wfMeta && node.wfMeta.title) ||
            node.workflowId ||
            I18n.t("（未选择）")),
      );
    else
      parts.push(I18n.t("时长 ") + mediaGenDurValue(node) + "s");
    parts.push(I18n.t("抽卡 ") + attemptCount(node));
    parts.push(I18n.t("种子 ") + mediaGenSeedSlotText(node));
  }
  parts.push(
    I18n.t("输出 ") +
      (mediaGenOutputRaw(node) ||
        String(node.outputPath || "").trim() ||
        I18n.t("（未设置）")),
  );
  return parts.join(" · ");
}

/* ═══════════════ H3 自建 ComfyUI 工作流（接入 video_gen 节点） ═══════════════
 * 分工真源：库读写 / UI→API 转换 / 参数扫描 / 参数校验 / 值注入全在主进程
 * h3/h3-workflows.js，渲染层只做四件事——选工作流、决定「哪些参数提升为节点端子」、
 * 面板直填值、挑输出节点；端子布局见 app.js 的 customWfInputCount / customWfSlotMeta
 * （端口 0 = 控制 · 端口 1 = 文本 · 端口 2+ = 素材，按 wfParams 里的类型顺序排）。
 * 空 node.workflowId = 内置 FL2VA / R2V 链，这条路径上的代码一概不走（零回归）。
 */
const H3_WF_TYPES = ["text", "number", "image", "video", "audio", "seed"];
const H3_WF_FILE_TYPES = ["image", "video", "audio"];
const H3_WF_LIB_TTL_MS = 60000;
const H3_WF_FILE_FILTERS = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
  video: ["mp4", "webm", "mov", "mkv", "avi"],
  audio: ["wav", "mp3", "flac", "ogg", "m4a", "aac"],
};
const H3_WF_VALIDATION_TEXT = {
  ok: "校验通过",
  missing_nodes: "缺节点包",
  skipped: "跳过校验（后端未运行）",
  unchecked: "未校验",
};
/** 库列表缓存：面板每次 renderCanvas 都会重建 DOM，不能每次都打 IPC */
let _h3WfLib = { items: [], at: 0, error: "" };
let _h3WfLibPending = null;
const _h3WfMetaLoading = new Set();

function h3WfLibFresh() {
  return Date.now() - _h3WfLib.at < H3_WF_LIB_TTL_MS;
}

/** 取 H3 全局自建工作流库（force = 忽略缓存重拉）；并发共用同一个 in-flight 请求 */
function loadH3WorkflowLibrary(force) {
  if (!window.api || !window.api.h3WorkflowList) return Promise.resolve([]);
  if (!force && h3WfLibFresh()) return Promise.resolve(_h3WfLib.items);
  if (_h3WfLibPending) return _h3WfLibPending;
  _h3WfLibPending = window.api
    .h3WorkflowList()
    .then((r) => {
      if (r && r.ok) {
        _h3WfLib = {
          items: Array.isArray(r.items) ? r.items : [],
          at: Date.now(),
          error: "",
        };
      } else {
        _h3WfLib.error = String((r && r.error) || "wfList failed");
      }
      return _h3WfLib.items;
    })
    .catch((e) => {
      _h3WfLib.error = String((e && e.message) || e);
      return _h3WfLib.items;
    })
    .then((items) => {
      _h3WfLibPending = null;
      return items;
    });
  return _h3WfLibPending;
}

/* ── 节点上的参数表（wfParams）小工具：一律按引用原地改 ── */
function h3WfParamList(node) {
  if (!Array.isArray(node.wfParams)) node.wfParams = [];
  return node.wfParams;
}
function h3WfValues(node) {
  if (!node.wfParamValues || typeof node.wfParamValues !== "object")
    node.wfParamValues = {};
  return node.wfParamValues;
}
function h3WfFindParam(node, key) {
  return h3WfParamList(node).find((p) => p && p.key === key) || null;
}
/** 某落点（节点 + 字段）是否已被提升为参数 —— 与主进程 sameParamSource 同口径 */
function h3WfHasSource(node, nodeId, field) {
  return h3WfParamList(node).some(
    (p) =>
      p &&
      String((p.source || {}).nodeId) === String(nodeId) &&
      String((p.source || {}).field) === String(field),
  );
}
/** 该参数实际占用的数据端口号（1 = 文本 · 2+ = 素材）；null = 超出端子数，只能面板直填 */
function h3WfPortOf(node, key) {
  const max = Math.max(1, videoGenInputCount(node) || 1);
  for (let i = 1; i <= max; i++) {
    const m = videoGenSlotMeta(node, i);
    if (m && m.param && m.param.key === key) return i;
  }
  return null;
}
function h3WfUniqueKey(node, base) {
  const list = h3WfParamList(node);
  const b = String(base || "p").replace(/[^A-Za-z0-9_.\-]/g, "_") || "p";
  let k = b;
  let i = 2;
  while (list.some((p) => p && p.key === k)) k = b + "_" + i++;
  return k;
}
/** 切换 / 清空自建工作流：wfId 空 = 回到内置链（清掉全部映射，零回归） */
async function setVideoGenWorkflow(node, wfId) {
  pushHistory();
  const id = String(wfId || "").trim();
  node.workflowId = id;
  node.wfParams = [];
  node.wfParamValues = {};
  node.wfPortMap = {};
  node.customOutputNodeId = "";
  node.wfMeta = null;
  if (!id) {
    scheduleSave();
    renderCanvas();
    return;
  }
  await loadVideoGenWfMeta(node, id);
  /* 端子数量随参数表变化：把落到不存在端口上的旧连线清掉，避免悬空线 */
  pruneVideoGenWfWires(node);
  scheduleSave();
  renderCanvas();
}
/** 读一条工作流的扫描结果（候选 + 建议映射 + 输出节点），填进 node.wfMeta */
async function loadVideoGenWfMeta(node, id) {
  if (!window.api || !window.api.h3WorkflowGet) return null;
  const r = await window.api.h3WorkflowGet(id).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (!r || !r.ok) {
    toast(I18n.t("读取工作流失败：") + String((r && r.error) || ""), "err");
    return null;
  }
  const rec = r.record || {};
  const scan = r.scan || {};
  node.wfMeta = {
    id: String(rec.id || id),
    title: String(rec.title || id),
    format: String(rec.format || "api"),
    validation: rec.validation || { status: "unchecked", checkedAt: "" },
    nodeCount: Number(scan.nodeCount) || 0,
    candidates: Array.isArray(scan.candidates) ? scan.candidates : [],
    outputs: Array.isArray(scan.outputs) ? scan.outputs : [],
    seedFields: Array.isArray(scan.seedFields) ? scan.seedFields : [],
  };
  /* 新选工作流 = 直接用主进程算好的建议映射（用户之后在面板上增删改） */
  node.wfParams = (Array.isArray(r.suggestedParams) ? r.suggestedParams : []).map(
    (p) => Object.assign({}, p),
  );
  return node.wfMeta;
}
/** ↻ 刷新：让主进程把「节点已存参数表」与该图最新扫描合并（保留改名 / 补新建议 / 标失效） */
async function refreshVideoGenWorkflow(node, opts) {
  const o = opts || {};
  const id = String(node.workflowId || "").trim();
  if (!id || !window.api || !window.api.h3WorkflowSyncParams) return;
  if (_h3WfMetaLoading.has(node.id)) return;
  _h3WfMetaLoading.add(node.id);
  try {
    const r = await window.api
      .h3WorkflowSyncParams({ id, params: h3WfParamList(node) })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    if (!r || !r.ok) {
      toast(I18n.t("刷新工作流失败：") + String((r && r.error) || ""), "err");
      return;
    }
    node.wfMeta = Object.assign({}, node.wfMeta || {}, {
      id,
      title: String(r.title || (node.wfMeta && node.wfMeta.title) || id),
      candidates: Array.isArray(r.candidates) ? r.candidates : [],
      outputs: Array.isArray(r.outputs) ? r.outputs : [],
      seedFields: Array.isArray(r.seedFields) ? r.seedFields : [],
      validation: r.validation || (node.wfMeta && node.wfMeta.validation) || { status: "unchecked" },
    });
    node.wfParams = Array.isArray(r.params) ? r.params : [];
    if (!o.quiet) {
      if (r.stale) toast(I18n.t("有 ") + r.stale + I18n.t(" 个参数落点已失效（图里改了）"), "warn");
      else if (r.added) toast(I18n.t("已同步：新增 ") + r.added + I18n.t(" 个建议参数"), "ok");
      else toast(I18n.t("工作流已是最新"), "ok");
    }
    pruneVideoGenWfWires(node);
    scheduleSave();
    renderCanvas();
  } finally {
    _h3WfMetaLoading.delete(node.id);
  }
}
/** 参数表缩小时：把指向已消失数据端子的连线清掉（控制线不动） */
function pruneVideoGenWfWires(node) {
  if (!isCustomVideoGen(node)) return false;
  const max = Math.max(1, videoGenInputCount(node) || 1);
  const wires = (S.wf && S.wf.wires) || [];
  const kept = wires.filter((w) => {
    if (w.to !== node.id) return true;
    if (wireFromIsControl(w)) return true;
    const idx = Number(w.toIndex);
    return !isFinite(idx) || idx <= max;
  });
  const changed = kept.length !== wires.length;
  if (changed) S.wf.wires = kept;
  return changed;
}
function h3WfValidationText(v) {
  const st = String((v && v.status) || "unchecked");
  const base = I18n.t(H3_WF_VALIDATION_TEXT[st] || st);
  const miss = v && Array.isArray(v.missing) ? v.missing.length : 0;
  return miss ? base + "（" + miss + "）" : base;
}

/** 面板 · 自建工作流区（由 app-canvas.js 在 video_gen 展开面板顶部调用） */
function appendVideoGenWorkflowControls(panel, node, addField) {
  const apiReady = !!(window.api && window.api.h3WorkflowList);
  const srcSel = document.createElement("select");
  [
    ["", "内置 H3 链（首末帧 / 多参考）"],
    ["custom", "自建 ComfyUI 工作流"],
  ].forEach(([v, t]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(t);
    srcSel.appendChild(o);
  });
  srcSel.value = isCustomVideoGen(node) ? "custom" : "";
  srcSel.addEventListener("change", async () => {
    if (srcSel.value !== "custom") {
      await setVideoGenWorkflow(node, "");
      return;
    }
    const items = apiReady ? await loadH3WorkflowLibrary(true) : [];
    if (!items.length) {
      srcSel.value = "";
      toast(I18n.t("自建工作流库为空 · 请先在 H3 管理窗口导入"), "warn");
      if (window.api.h3Open) window.api.h3Open();
      return;
    }
    await setVideoGenWorkflow(node, items[0].id);
  });
  addField(I18n.t("工作流来源"), srcSel);
  if (!isCustomVideoGen(node)) return;

  if (!apiReady) {
    const bad = document.createElement("div");
    bad.className = "n-backend-hint";
    bad.textContent = I18n.t("视频生成后端未就绪，无法读取自建工作流库");
    panel.appendChild(bad);
    return;
  }

  const meta = node.wfMeta || null;
  const row = document.createElement("div");
  row.className = "mgwf-row";
  const wfSel = document.createElement("select");
  wfSel.className = "mgwf-grow";
  const paint = (items) => {
    const cur = String(node.workflowId || "");
    wfSel.innerHTML = "";
    if (!items.length && !cur) {
      const o = document.createElement("option");
      o.textContent = I18n.t("（库为空）");
      wfSel.appendChild(o);
      return;
    }
    let found = false;
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.id;
      o.textContent =
        (it.title || it.id) +
        " · " +
        (Number(it.nodeCount) || 0) +
        " " +
        I18n.t("节点");
      if (String(it.id) === cur) {
        o.selected = true;
        found = true;
      }
      wfSel.appendChild(o);
    }
    if (!found && cur) {
      const o = document.createElement("option");
      o.value = cur;
      o.textContent = (meta && meta.title) || I18n.t("（库中已无此工作流）");
      o.selected = true;
      wfSel.appendChild(o);
    }
  };
  paint(_h3WfLib.items);
  wfSel.addEventListener("change", () => setVideoGenWorkflow(node, wfSel.value));
  row.appendChild(wfSel);
  const mkBtn = (text, title, fn) => {
    const b = document.createElement("button");
    b.className = "mini";
    b.textContent = text;
    b.title = title;
    b.onclick = (ev) => {
      ev.stopPropagation();
      fn();
    };
    row.appendChild(b);
    return b;
  };
  mkBtn("↻", I18n.t("重新读取工作流（与库内最新图同步参数表）"), () =>
    refreshVideoGenWorkflow(node, { quiet: false }),
  );
  mkBtn(I18n.t("管理"), I18n.t("打开 H3 管理窗口 · 导入 / 删除自建工作流"), () => {
    if (window.api.h3Open) window.api.h3Open();
  });
  panel.appendChild(row);
  if (!h3WfLibFresh()) loadH3WorkflowLibrary().then((items) => { if (document.body.contains(wfSel)) paint(items); });
  /* 旧画布迁移过来的节点（只有 workflowId，没读过扫描）：自动补一次静默同步 */
  if (!meta || !Array.isArray(meta.candidates)) {
    const h = document.createElement("div");
    h.className = "n-backend-hint";
    h.textContent = I18n.t("正在读取工作流参数…");
    panel.appendChild(h);
    refreshVideoGenWorkflow(node, { quiet: true });
    return;
  }

  const info = document.createElement("div");
  info.className = "n-backend-hint";
  info.textContent =
    (meta.nodeCount || 0) +
    I18n.t(" 节点 · ") +
    (String(meta.format || "api").toUpperCase() === "API" ? I18n.t("API 格式") : meta.format) +
    " · " +
    h3WfValidationText(meta.validation);
  info.title = I18n.t("校验按后端 /object_info 比对节点包（后端未运行时跳过，不阻断生成）");
  panel.appendChild(info);
  const valBtn = document.createElement("button");
  valBtn.className = "mini";
  valBtn.textContent = I18n.t("校验节点包");
  valBtn.onclick = async (ev) => {
    ev.stopPropagation();
    toast(I18n.t("正在按后端 /object_info 校验…"), "info");
    const r = await window.api
      .h3WorkflowValidate(node.workflowId)
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    if (!r || !r.ok) toast(I18n.t("校验失败：") + String((r && r.error) || ""), "err");
    else {
      node.wfMeta = Object.assign({}, node.wfMeta, {
        validation: {
          status: String(r.status || "unchecked"),
          missing: Array.isArray(r.missing) ? r.missing : [],
          checkedAt: new Date().toISOString(),
        },
      });
      scheduleSave();
      toast(String(r.message || ""), r.status === "ok" ? "ok" : "warn");
      renderCanvas();
    }
  };
  panel.appendChild(valBtn);

  /* 输出节点 */
  const outs = Array.isArray(meta.outputs) ? meta.outputs : [];
  const outSel = document.createElement("select");
  {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = I18n.t("自动（最后一个视频产物）");
    if (!node.customOutputNodeId) o.selected = true;
    outSel.appendChild(o);
  }
  for (const ot of outs) {
    const o = document.createElement("option");
    o.value = String(ot.nodeId);
    o.textContent =
      "节点 " + ot.nodeId + " · " + (ot.nodeTitle || ot.classType) + (ot.isVideo ? " ▶" : "");
    if (String(node.customOutputNodeId || "") === String(ot.nodeId)) o.selected = true;
    outSel.appendChild(o);
  }
  outSel.addEventListener("change", () => {
    node.customOutputNodeId = outSel.value;
    scheduleSave();
  });
  outSel.title = outs.length
    ? I18n.t("多个输出节点时指定取哪一个作为本节点的视频产物")
    : I18n.t("该工作流没有 Save* 输出节点，生成可能拿不到产物");
  addField(I18n.t("输出节点"), outSel);

  /* 参数表 */
  const head = document.createElement("div");
  head.className = "n-field-hint mgwf-head";
  head.textContent = I18n.t("提升为节点参数");
  panel.appendChild(head);
  const tip = document.createElement("div");
  tip.className = "n-backend-hint";
  tip.textContent = I18n.t("每项在节点上占一个端子（端口 1 = 文本 · 端口 2+ = 素材）；未提升的字段沿用工作流里的默认值。");
  panel.appendChild(tip);

  const list = h3WfParamList(node);
  if (!list.length) {
    const e0 = document.createElement("div");
    e0.className = "n-backend-hint";
    e0.textContent = I18n.t("当前没有提升任何参数：全部沿用工作流默认值（可只跑固定图）。");
    panel.appendChild(e0);
  }
  list.forEach((p, i) => {
    appendVideoGenWfParamRow(panel, node, p, i, list.length);
  });

  /* 从候选里添加 */
  const candSel = document.createElement("select");
  {
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = I18n.t("（选择要提升的参数…）");
    candSel.appendChild(o0);
    for (const c of meta.candidates || []) {
      if (h3WfHasSource(node, c.nodeId, c.field)) continue;
      const o = document.createElement("option");
      o.value = c.nodeId + "|" + c.field;
      o.textContent =
        (c.nodeTitle || c.classType || c.field) + " · " + c.field + " · " + c.type;
      candSel.appendChild(o);
    }
  }
  if (candSel.options.length > 1) {
    const addRow = document.createElement("div");
    addRow.className = "mgwf-row";
    candSel.className = "mgwf-grow";
    const add = document.createElement("button");
    add.className = "mini";
    add.textContent = "＋ " + I18n.t("提升");
    add.onclick = (ev) => {
      ev.stopPropagation();
      const v = String(candSel.value || "");
      if (!v) return;
      const [nid, field] = v.split("|");
      const c = (meta.candidates || []).find(
        (x) => String(x.nodeId) === String(nid) && String(x.field) === String(field),
      );
      if (!c) return;
      pushHistory();
      list.push({
        key: h3WfUniqueKey(node, c.type + "_" + c.nodeId + "_" + c.field),
        label: c.nodeTitle || c.label || c.field,
        type: H3_WF_TYPES.includes(c.type) ? c.type : "text",
        role: c.role || "",
        source: { nodeId: String(c.nodeId), field: String(c.field) },
        defaultValue: c.currentValue,
      });
      scheduleSave();
      renderCanvas();
    };
    addRow.appendChild(candSel);
    addRow.appendChild(add);
    panel.appendChild(addRow);
  }
  const resetRow = document.createElement("div");
  resetRow.className = "mgwf-row";
  const reset = document.createElement("button");
  reset.className = "mini";
  reset.textContent = I18n.t("恢复建议映射");
  reset.title = I18n.t("丢掉本节点上的改动，按工作流扫描结果重建参数表");
  reset.onclick = async (ev) => {
    ev.stopPropagation();
    pushHistory();
    const r = await window.api.h3WorkflowGet(node.workflowId).catch(() => null);
    if (!r || !r.ok) {
      toast(I18n.t("读取工作流失败"), "err");
      return;
    }
    node.wfParams = (Array.isArray(r.suggestedParams) ? r.suggestedParams : []).map((p) =>
      Object.assign({}, p),
    );
    node.wfParamValues = {};
    pruneVideoGenWfWires(node);
    scheduleSave();
    renderCanvas();
  };
  resetRow.appendChild(reset);
  panel.appendChild(resetRow);
}

/** 一行参数：类型 / 名称 / 端口 / 排序 / 移除 + 直填值（端口有数据时端口优先覆盖） */
function appendVideoGenWfParamRow(panel, node, p, index, total) {
  if (!p || !p.key) return;
  const vals = h3WfValues(node);
  const row = document.createElement("div");
  row.className = "mgwf-row";
  const typeSel = document.createElement("select");
  typeSel.className = "mgwf-type";
  H3_WF_TYPES.forEach((t) => {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = t;
    if ((p.type || "text") === t) o.selected = true;
    typeSel.appendChild(o);
  });
  typeSel.title = I18n.t("参数类型决定它在节点上占用哪种端子");
  typeSel.addEventListener("change", () => {
    pushHistory();
    p.type = typeSel.value;
    delete vals[p.key];
    pruneVideoGenWfWires(node);
    scheduleSave();
    renderCanvas();
  });
  const lab = document.createElement("input");
  lab.className = "mgwf-grow";
  lab.type = "text";
  lab.value = String(p.label || p.key);
  lab.title = I18n.t("端子与面板上显示的名称");
  lab.addEventListener("change", () => {
    p.label = String(lab.value || "").trim() || p.key;
    scheduleSave();
  });
  lab.addEventListener("mousedown", (ev) => ev.stopPropagation());
  lab.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  const port = h3WfPortOf(node, p.key);
  const badge = document.createElement("span");
  badge.className = "mgwf-port" + (port ? "" : " off");
  badge.textContent = port ? I18n.t("端子 ") + port : I18n.t("直填");
  badge.title = port
    ? I18n.t("该参数由节点第 ") + port + I18n.t(" 号数据端子注入（端子优先于直填）")
    : I18n.t("超出端子数（图 / 视频 / 音频上限 9 / 3 / 3）：只能用下方直填值");
  const mv = (dir) => {
    const list = h3WfParamList(node);
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    pushHistory();
    const [it] = list.splice(index, 1);
    list.splice(j, 0, it);
    pruneVideoGenWfWires(node);
    scheduleSave();
    renderCanvas();
  };
  const btn = (text, title, fn, danger) => {
    const b = document.createElement("button");
    b.className = "mini" + (danger ? " danger" : "");
    b.textContent = text;
    b.title = title;
    b.disabled = !fn;
    if (fn)
      b.onclick = (ev) => {
        ev.stopPropagation();
        fn();
      };
    row.appendChild(b);
    return b;
  };
  row.appendChild(typeSel);
  row.appendChild(lab);
  row.appendChild(badge);
  btn("▲", I18n.t("上移（调整端子顺序）"), index > 0 ? () => mv(-1) : null);
  btn("▼", I18n.t("下移（调整端子顺序）"), index < total - 1 ? () => mv(1) : null);
  btn("✕", I18n.t("取消提升此参数"), () => {
    pushHistory();
    const list = h3WfParamList(node);
    const at = list.indexOf(p);
    if (at >= 0) list.splice(at, 1);
    delete h3WfValues(node)[p.key];
    pruneVideoGenWfWires(node);
    scheduleSave();
    renderCanvas();
  }, true);
  panel.appendChild(row);

  /* 第二行：直填值 / 素材路径 / 来源说明 */
  const row2 = document.createElement("div");
  row2.className = "mgwf-row mgwf-row-sub";
  const src = p.source || {};
  const note = document.createElement("span");
  note.className = "mgwf-src";
  note.textContent =
    I18n.t("节点 ") + String(src.nodeId || "?") + " · " + String(src.field || "?") +
    (p.stale ? " · " + I18n.t("落点已失效") : "");
  note.title = p.stale
    ? I18n.t("当前工作流图里已找不到这个落点（图被改过）：点 ↻ 刷新或移除该参数")
    : I18n.t("注入位置：该节点的该字段");
  if (p.type === "seed") {
    note.textContent += " · " + I18n.t("种子由上方「种子 / 摇数」统一下发");
    row2.appendChild(note);
    panel.appendChild(row2);
    return;
  }
  const inp = document.createElement("input");
  inp.type = p.type === "number" ? "number" : "text";
  inp.className = "mgwf-grow";
  const cur = Object.prototype.hasOwnProperty.call(vals, p.key) ? vals[p.key] : p.defaultValue;
  inp.value = cur == null ? "" : String(cur);
  inp.placeholder =
    p.type === "number"
      ? I18n.t("留空 = 用工作流默认值 ") + String(p.defaultValue == null ? "" : p.defaultValue)
      : I18n.t("留空 = 用工作流默认值");
  inp.title = I18n.t("端口没接数据时用这里的值");
  inp.addEventListener("input", () => {
    const raw = inp.value;
    if (raw === "") delete vals[p.key];
    else vals[p.key] = p.type === "number" ? Number(raw) : raw;
  });
  inp.addEventListener("change", () => scheduleSave());
  inp.addEventListener("mousedown", (ev) => ev.stopPropagation());
  inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  row2.appendChild(inp);
  if (H3_WF_FILE_TYPES.includes(p.type)) {
    const br = document.createElement("button");
    br.className = "mini";
    br.textContent = I18n.t("浏览");
    br.onclick = async (ev) => {
      ev.stopPropagation();
      const r = await window.api.fileOpenDialog({
        title: I18n.t("选择素材文件"),
        filters: [
          { name: I18n.t("素材文件"), extensions: H3_WF_FILE_FILTERS[p.type] || ["*"] },
        ],
      });
      if (!r || !r.path) return;
      vals[p.key] = r.path;
      inp.value = r.path;
      scheduleSave();
    };
    row2.appendChild(br);
    const up = document.createElement("span");
    up.className = "mgwf-src";
    up.textContent = I18n.t("（生成时自动上传到 ComfyUI）");
    row2.appendChild(up);
  } else {
    row2.appendChild(note);
  }
  panel.appendChild(row2);
  if (H3_WF_FILE_TYPES.includes(p.type)) {
    const row3 = document.createElement("div");
    row3.className = "mgwf-row mgwf-row-sub";
    row3.appendChild(note);
    panel.appendChild(row3);
  }
}

function applyMediaGenConfiguredPath(node, raw, media) {
  if (!node) return "";
  /* 语音节点按自己选的输出格式定扩展名（wav / mp3），其余仍是音频 .wav / 视频 .mp4 */
  const ext =
    node.kind === "tts_gen"
      ? mediaGenExt(node)
      : saveExtForMedia(media === "video" ? "video" : "audio");
  const v = String(raw || "").trim();
  node.outputPath = v
    ? applySuperRelToPath(node, preferRelativeSavePath(forcePathExt(v, ext)))
    : "";
  node.filename = "";
  return node.outputPath;
}

/** Keep node.outputPath in sync with the actual export file (unique rename / saved path). */
function syncMediaGenPathFromExport(node, expOrPath) {
  if (!node) return;
  let abs = "";
  if (typeof expOrPath === "string") {
    abs = String(expOrPath || "").trim();
  } else if (expOrPath && expOrPath.ok) {
    abs = joinPath(expOrPath.outputDir, expOrPath.filename);
  }
  if (!abs) return;
  applyMediaGenConfiguredPath(
    node,
    abs,
    node.kind === "video_gen" ? "video" : "audio",
  );
}

function resolveMusicOutputDir(node) {
  const raw = String(node.outputPath || "output").trim() || "output";
  const r = resolveSavePath(raw, node);
  if (r.ok) return r.path;
  if (isAbsPath(raw)) return raw;
  return raw;
}

async function playMusicGenNode(node, quiet) {
  if (!window.api || !window.api.music3Generate) {
    toast(I18n.t("音乐生成插件未就绪"), "err");
    return;
  }
  if (node.running) return;
  /* 「全部终止 / 单独停止」之后不得再起跑（含串行队列里排到点的任务） */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }

  /* 全局互斥：音视频生成全局仅允许 1 个 */
  try {
    const lock = await fetchMediaGenLock();
    if (lock && lock.nodeId && lock.nodeId !== node.id) {
      node.error = mediaGenLockBusyMsg(lock);
      node.musicStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch {}

  const prompt = musicGenSlotText(node, 0).trim();
  const lyrics = musicGenSlotText(node, 1).trim();
  if (!prompt) {
    toast(I18n.t("请连接提示词输入（端子 P）"), "warn");
    return;
  }
  if (!lyrics) {
    toast(I18n.t("请连接歌词输入（端子 L）；纯器乐可用 [instrumental]"), "warn");
    return;
  }

  const exp0 = requireMediaGenExport(node, quiet);
  if (!exp0) {
    renderCanvas();
    return;
  }
  const nRolls = attemptCount(node);

  let st = null;
  try {
    st = await window.api.music3Status();
  } catch {}
  {
    const ui = ensureBackendUiState(node);
    ui.ok = null;
    ui.info = summarizeMediaBackendStatus(node, st);
    ui.genPct = 2;
    ui.genMsg = I18n.t("启动后端并生成…");
    stopMediaBackendProbe(node.id);
  }

  /* 上面这些 await（取全局锁 / 查后端状态）期间可能已被终止 → 不占锁、不起跑 */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }
  node.running = true;
  node.error = null;
  beginNodeRun(node);
  node.genRollDone = 0;
  node.genPaths = [];
  node.musicStatus = I18n.t("启动后端并生成…");  startMediaBackendRunWatcher(node);
  renderCanvas();

  const duration = Math.max(10, Math.min(150, Number(node.audioDuration) || 60));
  const t0 = Date.now();
  let okCount = 0;
  let lastPath = "";

  try {
    for (let roll = 1; roll <= nRolls; roll++) {
      if (mediaRunStopped(node)) break;
      const exp = await prepareMediaGenRollExport(node, roll, nRolls);
      if (!exp || !exp.ok) {
        requireMediaGenExport(node, quiet);
        node.error = savePathResolveError(exp && exp.code);
        node.musicStatus = node.error;
        if (!quiet) toast(node.error, "warn");
        return;
      }
      if (roll === 1 && nRolls === 1 && exp.renamed) {
        syncMediaGenPathFromExport(node, exp);
        if (!quiet) toast(I18n.t("目标文件已存在，改为保存为：") + exp.filename, "ok");
      }
      const seed = nextMediaGenSeed(node);
      {
        const ui = ensureBackendUiState(node);
        ui.genPct = Math.max(2, ui.genPct || 2);
        ui.genMsg =
          mediaGenRollProgressTag(node) +
          (nRolls > 1 ? I18n.t("生成中…") : I18n.t("启动后端并生成…"));
        node.musicStatus = ui.genMsg;
      }
      node.genRollDone = roll - 1;
      refreshMediaNodeUi(node, { soft: true });

      const r = await window.api.music3Generate({
        nodeId: node.id,
        workflowId: (S.wf && S.wf.id) || "",
        prompt,
        lyrics,
        audioDuration: duration,
        seed,
        outputDir: exp.outputDir,
        filename: exp.filename,
        offload: node.offload !== false,
      });
      if (node._aborted || (r && (r.error === "cancelled" || r.cancelled))) {
        node.error = null;
        node.musicStatus = I18n.t("已取消");
        const ui = ensureBackendUiState(node);
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        return;
      }
      if (!r || !r.ok) {
        const err = (r && (r.message || r.error)) || I18n.t("生成失败");
        if (err === "busy_other_node" || (r && r.error === "busy_other_node")) {
          node.error = I18n.t("已有音视频生成任务进行中，已中断本节点（全局仅 1 个，禁止并行）");
        } else if (String(err) === "cancelled") {
          node.error = null;
          node.musicStatus = I18n.t("已取消");
          return;
        } else {
          node.error = String(err);
        }
        node.musicStatus = node.error;
        if (looksLikeBackendConnError(err)) markMediaBackendDown(node);
        if (!quiet) toast(node.error, "err");
        return;
      }
      okCount++;
      lastPath = String(r.path || "");
      if (lastPath) node.genPaths.push(lastPath);
      node.output = { kind: "audio", path: lastPath, text: lastPath };
      node.ranAt = Date.now();
      if (lastPath && nRolls === 1) syncMediaGenPathFromExport(node, lastPath);
      node.genRollDone = roll;
    }
    if (node._aborted) {
      node.error = null;
      node.musicStatus = I18n.t("已取消");
      const ui = ensureBackendUiState(node);
      ui.genMsg = I18n.t("已取消");
      ui.genPct = 0;
      return;
    }
    if (!okCount) return;
    const doneMsg = mediaGenDoneMsg(Date.now() - t0);
    node.musicStatus = doneMsg;
    {
      const ui = ensureBackendUiState(node);
      ui.genPct = 100;
      ui.genMsg = doneMsg;
      ui.ok = false;
    }
    if (!quiet) {
      toast(
        nRolls > 1
          ? I18n.t("音乐已生成：") + okCount + "/" + nRolls + I18n.t(" 次")
          : I18n.t("音乐已生成：") + lastPath,
        "ok",
      );
    }
  } catch (e) {
    if (node._aborted) {
      node.error = null;
      node.musicStatus = I18n.t("已取消");
    } else {
      node.error = (e && e.message) || String(e);
      node.musicStatus = node.error;
      if (looksLikeBackendConnError(node.error)) markMediaBackendDown(node);
      if (!quiet) toast(node.error, "err");
    }
  } finally {
    /* 被用户终止（单独停止 / 全部终止）时不再驱动下游控制线，
       否则「已全部终止」之后队列里又会长出新的生成任务。 */
    const wasStopped = mediaRunStopped(node);
    node.running = false;
    node._aborted = false;
    stopMediaBackendRunWatcher(node.id);
    renderCanvas();
    scheduleSave();
    /* 生成成功：触发控制输出端子（端口1）驱动下游控制目标 */
    if (!wasStopped && nodeHasOutputContent(node))
      await fireControlOutgoing(node, 1, new Set([node.id]));
  }
}

/* ── SoVITS 语音生成（tts_gen）：接入本机 GPT-SoVITS TTS 插件 ─────────────
   后端 = 插件「GPT-SoVITS 语音合成」(tts-local)：主进程 tts/main-tts.js 拉起
   OpenAI 兼容管理服务（127.0.0.1:<port>），节点经 api.ttsGenerate → tts:generate
   → /v1/audio/speech，音频字节由主进程直接写盘并回传绝对路径（渲染层不碰二进制）。
   与音乐 / 视频共用同一条渲染层串行链与同一套后端状态机，但**不持主进程全局音视频
   锁**：SoVITS 是独立进程、显存另算，全局锁的持有方仍只有音乐 / 视频。 */
const TTS_API_POLL_MS = 2000;
const TTS_API_WAIT_MS = 180000;

/* 音色清单：后端 /api/status 的 voices（[{id,name}] 或 ["id"]）；
   后端未起时返回空列表——UI 允许手填音色，不阻塞配置节点。 */
function ttsVoicesFromStatus(st) {
  const list = st && st.apiStatus && Array.isArray(st.apiStatus.voices)
    ? st.apiStatus.voices
    : [];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    const id = String(
      (v && (v.id || v.voiceId || v.name)) || (typeof v === "string" ? v : ""),
    ).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String((v && v.name) || id).trim() || id });
  }
  return out;
}
/* 节点未选音色时交给后端默认（服务端取 voices[0]），不猜、不硬编码名字 */
function ttsDefaultVoiceFromStatus(st) {
  const vs = ttsVoicesFromStatus(st);
  return vs.length ? vs[0].id : "";
}
function ttsSpeedOf(node) {
  const v = Number(node && node.speed);
  return v > 0 ? Math.max(0.5, Math.min(2, v)) : 1;
}
function ttsFormatOf(node) {
  return node && node.ttsFormat === "mp3" ? "mp3" : "wav";
}

/* 后端 / HTTP 错误 → 一句能照着做的中文提示；认不出的原样回显便于排查。
   主进程把 HTTP 错误体整段塞进 error（FastAPI 形如 {"detail":"voice_not_found"}）。 */
function ttsErrorText(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      const d =
        (j && j.detail) ||
        (j && j.error && (j.error.message || j.error.code)) ||
        (j && j.error);
      if (typeof d === "string" && d.trim()) s = d.trim();
    } catch (_) {
      /* 非 JSON：按原文处理 */
    }
  }
  const T = I18n.t;
  const exact = {
    text_required: T("待合成文本为空"),
    no_output_path: T("未设置输出路径"),
    no_api_key: T("GPT-SoVITS 服务密钥缺失（请先在「插件 · GPT-SoVITS 语音合成」启动一次后端）"),
    empty_audio: T("后端返回空音频（请检查该音色的参考音频）"),
    not_installed: T("GPT-SoVITS 后端尚未安装（请在「插件 · GPT-SoVITS 语音合成」中安装）"),
    no_venv: T("GPT-SoVITS 后端缺少 Python 环境（请在「插件 · GPT-SoVITS 语音合成」中重新安装）"),
    bad_dir: T("GPT-SoVITS 后端安装目录未设置或不合法（请在「插件」中重新选择目录）"),
    backend_down: T("GPT-SoVITS 后端未能在规定时间内就绪（可打开插件控制台查看启动日志）"),
    no_voice: T("后端没有可用音色（请先在插件里添加参考音频音色）"),
    voice_not_found: T("音色不存在（请重新选择音色）"),
    lang_denied: T("语种被后端策略拒绝（请在插件里调整语种策略或换文本）"),
    write_failed: T("音频写盘失败（请检查输出路径是否可写）"),
  };
  const key = s.split(/[:\s]+/)[0].toLowerCase();
  if (exact[s.toLowerCase()]) return exact[s.toLowerCase()];
  if (exact[key]) return exact[key] + (s.length > key.length ? "：" + s.slice(key.length + 1) : "");
  if (/econnrefused|enotfound|fetch failed|socket hang up|timed?\s*out|network/i.test(s))
    return T("无法连接 GPT-SoVITS 后端（后端可能已退出，请重新执行本节点）");
  return s || T("合成失败");
}

/* 确保 GPT-SoVITS 管理服务在线：已在线直接返回；未运行则拉起并轮询 apiUp。
   { ok:true, st } / { ok:false, cancelled?, error? }（error 已是中文展示文案） */
async function ensureTtsBackendReady(node) {
  let st = null;
  try {
    st = await fetchMediaBackendStatus(node);
  } catch (_) {
    st = null;
  }
  if (st && st.apiUp) return { ok: true, st };
  if (!window.api || !window.api.ttsStart)
    return { ok: false, error: I18n.t("语音合成插件未就绪") };
  if (!st || !st.installed)
    return { ok: false, st, error: ttsErrorText("not_installed") };
  let r = null;
  try {
    r = await window.api.ttsStart();
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  if (r && r.ok) {
    try {
      st = await fetchMediaBackendStatus(node);
    } catch (_) {
      st = null;
    }
    /* startBackend 自身已等到端口就绪 → 这里 apiUp 未确认也放行一次，由合成兜底 */
    if (!st || st.apiUp) return { ok: true, st };
  }
  /* 慢启动 / 后端在别处被拉起：再兜一轮，期间允许被「停止」作废 */
  const deadline = Date.now() + TTS_API_WAIT_MS;
  for (;;) {
    if (node && mediaRunStopped(node)) return { ok: false, cancelled: true, st };
    try {
      st = await fetchMediaBackendStatus(node);
    } catch (_) {
      st = null;
    }
    if (st && st.apiUp) return { ok: true, st };
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, TTS_API_POLL_MS));
  }
  return { ok: false, st, error: ttsErrorText((r && r.error) || "backend_down") };
}

async function playTtsGenNode(node, quiet) {
  if (!window.api || !window.api.ttsGenerate) {
    toast(I18n.t("语音合成插件未就绪"), "err");
    return;
  }
  if (node.running) return;
  /* 「全部终止 / 单独停止」之后不得再起跑（含串行队列里排到点的任务） */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }

  const text = musicGenSlotText(node, 0).trim();
  if (!text) {
    const msg = I18n.t("请连接文本来源（待合成文本 · 端子 T）");
    node.error = msg;
    node.ttsStatus = msg;
    if (!quiet) toast(msg, "warn");
    renderCanvas();
    return;
  }
  const exp0 = requireMediaGenExport(node, quiet);
  if (!exp0) {
    renderCanvas();
    return;
  }
  const nRolls = attemptCount(node);
  const speed = ttsSpeedOf(node);
  const fmt = ttsFormatOf(node);

  {
    const ui = ensureBackendUiState(node);
    ui.ok = null;
    ui.genPct = 5;
    ui.genMsg = I18n.t("启动后端并合成…");
    stopMediaBackendProbe(node.id);
  }
  /* 取数与解析路径都是 await 之后的事：期间可能已被终止 → 不起跑 */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }
  node.running = true;
  node.error = null;
  beginNodeRun(node);
  node.genRollDone = 0;
  node.genPaths = [];
  node.ttsStatus = I18n.t("启动后端并合成…");
  renderCanvas();

  const t0 = Date.now();
  let okCount = 0;
  let lastPath = "";
  try {
    const ready = await ensureTtsBackendReady(node);
    if (!ready.ok) {
      if (ready.cancelled || node._aborted) {
        node.error = null;
        node.ttsStatus = I18n.t("已取消");
        const ui0 = ensureBackendUiState(node);
        ui0.genMsg = I18n.t("已取消");
        ui0.genPct = 0;
        return;
      }
      node.error = ready.error;
      node.ttsStatus = ready.error;
      markMediaBackendDown(node, ready.st);
      if (!quiet) toast(node.error, "err");
      return;
    }
    {
      const ui = ensureBackendUiState(node);
      ui.ok = true;
      ui.info = summarizeMediaBackendStatus(node, ready.st);
      stopMediaBackendProbe(node.id);
      ui.genPct = 20;
    }
    startMediaBackendRunWatcher(node);
    /* 音色：节点未选则交后端默认（服务端取第一个已注册音色） */
    const voice = String(node.voice || "").trim() || ttsDefaultVoiceFromStatus(ready.st);

    for (let roll = 1; roll <= nRolls; roll++) {
      if (mediaRunStopped(node)) break;
      const exp = await prepareMediaGenRollExport(node, roll, nRolls);
      if (!exp || !exp.ok) {
        requireMediaGenExport(node, quiet);
        node.error = savePathResolveError(exp && exp.code);
        node.ttsStatus = node.error;
        if (!quiet) toast(node.error, "warn");
        return;
      }
      if (roll === 1 && nRolls === 1 && exp.renamed) {
        syncMediaGenPathFromExport(node, exp);
        if (!quiet) toast(I18n.t("目标文件已存在，改为保存为：") + exp.filename, "ok");
      }
      {
        const ui = ensureBackendUiState(node);
        ui.genPct = Math.max(ui.genPct || 20, 40);
        ui.genMsg = mediaGenRollProgressTag(node) + I18n.t("语音合成中…");
        node.ttsStatus = ui.genMsg;
      }
      node.genRollDone = roll - 1;
      refreshMediaNodeUi(node, { soft: true });

      const r = await window.api.ttsGenerate({
        nodeId: node.id,
        workflowId: (S.wf && S.wf.id) || "",
        text,
        voice,
        speed,
        response_format: fmt,
        outputPath: exp.path,
      });
      if (node._aborted) {
        node.error = null;
        node.ttsStatus = I18n.t("已取消");
        const ui = ensureBackendUiState(node);
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        return;
      }
      if (!r || !r.ok) {
        const err = (r && (r.error || r.message)) || "tts_failed";
        node.error = ttsErrorText(err);
        node.ttsStatus = node.error;
        if (!r || looksLikeBackendConnError(err)) markMediaBackendDown(node);
        if (!quiet) toast(node.error, "err");
        return;
      }
      okCount++;
      lastPath = String(r.path || "");
      if (lastPath) node.genPaths.push(lastPath);
      node.output = { kind: "audio", path: lastPath, text: lastPath };
      node.ranAt = Date.now();
      if (lastPath && nRolls === 1) syncMediaGenPathFromExport(node, lastPath);
      node.genRollDone = roll;
    }
    if (node._aborted) {
      node.error = null;
      node.ttsStatus = I18n.t("已取消");
      const ui = ensureBackendUiState(node);
      ui.genMsg = I18n.t("已取消");
      ui.genPct = 0;
      return;
    }
    if (!okCount) return;
    const doneMsg = mediaGenDoneMsg(Date.now() - t0);
    node.ttsStatus = doneMsg;
    {
      const ui = ensureBackendUiState(node);
      ui.genPct = 100;
      ui.genMsg = doneMsg;
    }
    if (!quiet) {
      toast(
        nRolls > 1
          ? I18n.t("语音已生成：") + okCount + "/" + nRolls + I18n.t(" 次")
          : I18n.t("语音已生成：") + lastPath,
        "ok",
      );
    }
  } catch (e) {
    if (node._aborted) {
      node.error = null;
      node.ttsStatus = I18n.t("已取消");
    } else {
      node.error = ttsErrorText((e && e.message) || String(e));
      node.ttsStatus = node.error;
      if (looksLikeBackendConnError((e && e.message) || String(e)))
        markMediaBackendDown(node);
      if (!quiet) toast(node.error, "err");
    }
  } finally {
    /* 被用户终止时不再驱动下游控制线（否则「已全部终止」后队列又长出新任务） */
    const wasStopped = mediaRunStopped(node);
    node.running = false;
    node._aborted = false;
    stopMediaBackendRunWatcher(node.id);
    renderCanvas();
    scheduleSave();
    if (!wasStopped && nodeHasOutputContent(node))
      await fireControlOutgoing(node, 1, new Set([node.id]));
  }
}

/* ── 运行批次作废（「结束所有节点任务」的真·止血） ─────────────────────
   旧实现只把 node.running 置 false，但：
     · 媒体节点在一条无法撤销的 Promise 串行链里排队 → 终止后队列照旧起新任务；
     · 主进程后端任务与全局音视频锁没有被取消 → 锁轮询 / 进度事件把节点重新标成运行中；
     · 节点跑完的 finally 仍会 fireControlOutgoing 驱动下游 → 队列里又长出任务。
   现在每次「停止」都给节点递增 _stopTick，运行体起跑时记下发车时的 _runTick：
   两者不一致 = 这批已经被作废，所有后续动作（起跑、排队、驱动下游）一律拦掉。 */
let GLOBAL_STOP_SEQ = 0;
function globalStopSeq() {
  return GLOBAL_STOP_SEQ;
}
function markGlobalStop() {
  GLOBAL_STOP_SEQ++;
  try {
    S._lastStopAllAt = Date.now();
  } catch (_) {}
  return GLOBAL_STOP_SEQ;
}
/* 起跑 / 排队前记下车时的代号（每个节点真正的起跑点都会调用） */
function beginNodeRun(node) {
  if (!node) return;
  node._runTick = Number(node._stopTick) || 0;
  node._runSeq = GLOBAL_STOP_SEQ;
  node._aborted = false;
}
/* 停止本节点当前批次：_aborted 让在途运行体在下一个检查点退出，
   _stopTick 让「还没起跑」的排队项（媒体串行队列）直接作废 */
function bumpNodeStop(node) {
  if (!node) return;
  node._stopTick = (Number(node._stopTick) || 0) + 1;
  node._aborted = true;
  node._stopAt = Date.now();
  /* 计算执行并发闸的排队项：入队后单独停止 = 立刻作废并退出「等待中」，
     不必等到下一次出队才从面板上消失（函数 / 工具节点的排队看得见也停得掉） */
  try {
    computeExecDropWait(node);
  } catch (_) {}
}
/* 本批是否已被用户终止：只认 _aborted（每个节点起跑时都会清）
   —— 不用时间戳差值，避免误伤之后用户主动的新运行 */
function runBatchStopped(node) {
  return !!(node && node._aborted);
}
/* 媒体节点还额外看排队代号：入队后被单独停止过 → 作废 */
function mediaRunStopped(node) {
  if (!node) return false;
  if (node._aborted) return true;
  return (Number(node._stopTick) || 0) !== (Number(node._runTick) || 0);
}

/* 媒体生成排队表：nodeId -> entry（终止时整表清空 = 排队项作废） */
const mediaGenWaiters = new Map();
/* 「后端锁恢复」轮询：nodeId -> interval id（终止时必须关掉，否则会把节点重新标成运行中） */
const mediaGenRestoreTimers = new Map();

function stopMediaGenRestoreWatch(nodeId) {
  const t = mediaGenRestoreTimers.get(nodeId);
  if (!t) return;
  clearInterval(t);
  mediaGenRestoreTimers.delete(nodeId);
  /* 恢复锁轮询结束 = 该生成节点不再占用运行队列：立刻同步 */
  updateRunQueuePanel();
}
function stopAllMediaGenRestoreWatch() {
  for (const id of [...mediaGenRestoreTimers.keys()]) stopMediaGenRestoreWatch(id);
}
function stopAllMediaBackendRunWatchers() {
  for (const id of [...mediaBackendRunWatchers.keys()]) stopMediaBackendRunWatcher(id);
}
/* 真正取消主进程里的后端任务（同时释放全局音视频锁）；只终止属于本节点的在途任务。
   tts_gen 不在此列：GPT-SoVITS 是一次性 HTTP 请求（主进程无取消接口、也不持全局锁），
   取消只走渲染层作废（_aborted / _stopTick），在途那条合成完即丢弃、不再驱动下游。 */
function mediaGenCancelRemote(node) {
  if (!node || !window.api) return;
  try {
    if (node.kind === "music_gen" && window.api.music3CancelGenerate)
      window.api.music3CancelGenerate(node.id);
    else if (node.kind === "video_gen" && window.api.h3CancelGenerate)
      window.api.h3CancelGenerate(node.id);
    else if (node.kind === "remotion" && window.api.remotionCancel)
      window.api.remotionCancel(node.id);
  } catch (_) {}
}
function findMediaGenNodeById(id) {
  let n = nodeById(id);
  if (n && isMediaGenNode(n)) return n;
  for (const wid of Object.keys(S.wfBag || {})) {
    const w = S.wfBag[wid];
    const hit = ((w && w.nodes) || []).find((x) => x.id === id && isMediaGenNode(x));
    if (hit) return hit;
  }
  return null;
}
/* 排队项被作废 / 在途任务被终止：只写状态，绝不启动后端 */
function mediaGenMarkDropped(node, wasRunning) {
  if (!node) return;
  const msg = wasRunning
    ? I18n.t("已终止（后端生成任务已取消）")
    : I18n.t("已终止（排队中的生成任务已取消）");
  node.running = false;
  node.error = null;
  if (node.kind === "music_gen") node.musicStatus = msg;
  else if (node.kind === "tts_gen") node.ttsStatus = msg;
  else if (node.kind === "video_gen") node.videoStatus = msg;
  else if (node.kind === "remotion") node.remotionStatus = msg;
  const ui = ensureBackendUiState(node);
  ui.genPct = 0;
  ui.genMsg = msg;
  stopMediaBackendRunWatcher(node.id);
  stopMediaGenRestoreWatch(node.id);
}

async function restoreMediaGenLocks() {
  const fn =
    window.api &&
    (window.api.mediaGenGetLock ||
      window.api.music3GetLock ||
      window.api.h3GetLock);
  if (!fn) return;
  try {
    const lk = await fn();
    const lock = lk && lk.lock;
    if (!lock || !lock.nodeId) return;
    const n = nodeById(lock.nodeId);
    if (!n || (n.kind !== "music_gen" && n.kind !== "video_gen")) return;
    /* 本批已被终止：不要再把节点标成运行中（否则终止后队列复活） */
    if (runBatchStopped(n)) return;
    n.running = true;
    const msg = I18n.t("后端任务进行中（已从锁恢复）…");
    if (n.kind === "music_gen") n.musicStatus = msg;
    else n.videoStatus = msg;
    renderCanvas();
    stopMediaGenRestoreWatch(n.id);
    const poll = setInterval(async () => {
      try {
        /* 用户已终止 / 全局终止：立刻收摊，不再回写 running 状态 */
        if (runBatchStopped(n)) {
          stopMediaGenRestoreWatch(n.id);
          n.running = false;
          renderCanvas();
          updateRunQueuePanel();
          return;
        }
        const cur = await fn();
        if (!cur || !cur.lock || cur.lock.nodeId !== n.id) {
          stopMediaGenRestoreWatch(n.id);
          n.running = false;
          const done = I18n.t("任务已结束");
          if (n.kind === "music_gen") n.musicStatus = done;
          else n.videoStatus = done;
          renderCanvas();
          updateRunQueuePanel();
        }
      } catch {
        stopMediaGenRestoreWatch(n.id);
      }
    }, 3000);
    mediaGenRestoreTimers.set(n.id, poll);
    /* 从后端锁恢复出「在途生成」：这条也要出现在运行队列里 */
    updateRunQueuePanel();
  } catch {}
}

function videoGenSlotValue(node, slot) {
  const w = wiresTo(node.id).find((x) => Number(x.toIndex) === Number(slot));
  if (!w) return null;
  const src = nodeById(w.from);
  if (!src) return null;
  const meta = videoGenSlotMeta(node, slot);
  const v = valueFromWire(w, node, 0);
  if (meta.kind === "image") {
    if (v && v.kind === "image" && v.path) return { kind: "image", path: v.path };
    if (src.imageAsset) return { kind: "image", path: src.imageAsset };
    const d = displayValueOf(src, node);
    if (d && d.image) return { kind: "image", path: d.image };
    return null;
  }
  if (v && v.kind === "text") return { kind: "text", text: String(v.text || "") };
  if (v && v.kind === "image" && v.path) return { kind: "path", text: String(v.path) };
  /* 音视频端子值可能是 { kind:"audio"/"video", path, url }，也可能是裸 file:/// URL：
     交给后端前一律归一回本机绝对路径（非 URL 的字符串原样透传，行为不变） */
  if (v && (v.kind === "audio" || v.kind === "video"))
    return { kind: "path", text: pathFromMediaValue(v) };
  const d = displayValueOf(src, node);
  if (d && d.text != null)
    return meta.kind === "text"
      ? { kind: "text", text: String(d.text) }
      : { kind: "path", text: pathFromMediaValue(String(d.text)) };
  if (d && d.image) return { kind: "path", text: String(d.image) };
  return null;
}

function resolveVideoOutputDir(node) {
  const raw = String(node.outputPath || "output").trim() || "output";
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) {
    return raw;
  }
  const ws = (S.wf && S.wf.workspace) || "";
  if (ws) {
    return ws.replace(/[\\/]+$/, "") + "\\" + raw.replace(/^[\\/]+/, "");
  }
  return raw;
}

/** 组装 h3Generate 参数：内置模式原样下发（零回归）；自建工作流模式走精简对象
 *  （时长 / 分辨率 / 后处理等内置专属字段一概不下发）。 */
function buildVideoGenRunParams(node, ctx) {
  const exp = ctx.exp || {};
  if (isCustomVideoGen(node)) {
    return {
      nodeId: ctx.nodeId,
      workflowId: String(node.workflowId || "").trim(),
      wfParams: Array.isArray(node.wfParams) ? node.wfParams : [],
      wfParamValues: collectVideoGenWfValues(node),
      customOutputNodeId: String(node.customOutputNodeId || ""),
      seed: ctx.seed,
      outputDir: exp.outputDir,
      filename: exp.filename,
    };
  }
  return {
    nodeId: ctx.nodeId,
    workflowId: (S.wf && S.wf.id) || "",
    mode: ctx.mode,
    prompt: ctx.prompt,
    firstImage: ctx.firstImage || "",
    lastImage: ctx.lastImage || "",
    refImages: ctx.refImages || [],
    refVideos: ctx.refVideos || [],
    refAudios: ctx.refAudios || [],
    duration: Number(node.duration) || 5,
    ratio: node.ratio || "16:9",
    seed: ctx.seed,
    steps: Number(node.steps) || 20,
    sampler: node.sampler || "res_multistep",
    scheduler: node.scheduler || "simple",
    denoise: node.denoise != null ? Number(node.denoise) : 1,
    shiftVideo: node.shiftVideo != null ? Number(node.shiftVideo) : 12,
    shiftAudio: node.shiftAudio != null ? Number(node.shiftAudio) : 3,
    optEasyCache: node.optEasyCache !== false,
    easyReuse: node.easyReuse != null ? Number(node.easyReuse) : 0.2,
    easyStart: node.easyStart != null ? Number(node.easyStart) : 0.15,
    easyEnd: node.easyEnd != null ? Number(node.easyEnd) : 0.95,
    optSageAttn: node.optSageAttn !== false,
    optLowVramAttn: node.optLowVramAttn !== false,
    lowVramHeadChunks: node.lowVramHeadChunks != null ? Number(node.lowVramHeadChunks) : 4,
    optChunkFfn: node.optChunkFfn !== false,
    chunkFfnChunks: node.chunkFfnChunks != null ? Number(node.chunkFfnChunks) : 2,
    chunkFfnSeqThreshold:
      node.chunkFfnSeqThreshold != null ? Number(node.chunkFfnSeqThreshold) : 4096,
    optVramBarrier: node.optVramBarrier !== false,
    sageMode:
      node.optSageAttn === false
        ? "disabled"
        : !node.sageMode || node.sageMode === "disabled"
          ? "auto"
          : node.sageMode,
    sageCompile: !!node.sageCompile,
    postEnabled: node.postEnabled !== false,
    postInterp: node.postInterp !== false,
    postInterpMultiplier:
      node.postInterpMultiplier != null ? Number(node.postInterpMultiplier) : 2,
    postPerBatch: node.postPerBatch != null ? Number(node.postPerBatch) : 4,
    refImageSize: node.refImageSize || "match",
    outputRes: node.outputRes || "auto",
    fps: Number(node.fps) || 24,
    bitDepth: Number(node.bitDepth) || 8,
    videoFormat: node.videoFormat || "auto",
    videoCodec: node.videoCodec || "auto",
    filenamePrefix: node.filenamePrefix || "video/MiniMax_H3",
    outputDir: exp.outputDir,
    filename: exp.filename,
  };
}

/** 收集自定义工作流的运行时值：面板直填 + 端口注入（端口优先覆盖）。
 *  文本端口1 → text 参数；文件端口 → 素材参数（wfPortMap 指定或按类型顺序默认）。 */
function collectVideoGenWfValues(node) {
  const out = {};
  const list = Array.isArray(node.wfParams) ? node.wfParams : [];
  const pv =
    node.wfParamValues && typeof node.wfParamValues === "object" ? node.wfParamValues : {};
  const pm = node.wfPortMap && typeof node.wfPortMap === "object" ? node.wfPortMap : {};
  const put = (key, val) => {
    if (key && val != null && val !== "") out[key] = val;
  };
  for (const p of list) {
    if (!p || !p.key) continue;
    if (Object.prototype.hasOwnProperty.call(pv, p.key)) put(p.key, pv[p.key]);
  }
  const v1 = videoGenSlotValue(node, 1);
  if (v1 && v1.text) {
    let tk = null;
    if (pm["1"] && list.some((p) => p.key === pm["1"])) tk = pm["1"];
    else {
      const t = videoGenWfTextParam(node);
      if (t) tk = t.key;
    }
    if (tk) put(tk, String(v1.text));
  }
  const files = videoGenWfFileParams(node);
  files.forEach((p, idx) => {
    let port = 2 + idx;
    for (const [pk, val] of Object.entries(pm)) {
      if (String(val) === p.key && Number(pk) >= 2) {
        port = Number(pk);
        break;
      }
    }
    const v = videoGenSlotValue(node, port);
    let pathText = "";
    if (v && v.path) pathText = String(v.path);
    else if (v && v.text && /[\\/]/.test(String(v.text))) pathText = String(v.text);
    if (pathText) put(p.key, pathText.trim());
  });
  return out;
}

async function playVideoGenNode(node, quiet) {
  if (!window.api || !window.api.h3Generate) {
    toast(I18n.t("视频生成插件未就绪"), "err");
    return;
  }
  if (node.running) return;
  /* 同音乐节点：被终止过的节点不得再起跑 */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }

  try {
    const lock = await fetchMediaGenLock();
    if (lock && lock.nodeId && lock.nodeId !== node.id) {
      node.error = mediaGenLockBusyMsg(lock);
      node.videoStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch {}

  const customVid = isCustomVideoGen(node);
  const promptVal = videoGenSlotValue(node, 1);
  const prompt = (promptVal && promptVal.text ? promptVal.text : "").trim();
  /* 自建工作流：文本参数可能不在端口1（或根本没有文本参数），不强制要求提示词 */
  if (!customVid && !prompt) {
    toast(I18n.t("请连接提示词输入（端子 P）"), "warn");
    return;
  }

  const exp0 = requireMediaGenExport(node, quiet);
  if (!exp0) {
    renderCanvas();
    return;
  }
  const nRolls = attemptCount(node);

  let st = null;
  try {
    st = await window.api.h3Status();
  } catch {}
  {
    const ui = ensureBackendUiState(node);
    ui.ok = null;
    ui.info = summarizeMediaBackendStatus(node, st);
    ui.genPct = 2;
    ui.genMsg = I18n.t("启动后端并生成…");
    stopMediaBackendProbe(node.id);
  }

  /* 上面这些 await（取全局锁 / 查后端状态）期间可能已被终止 → 不占锁、不起跑 */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }
  node.running = true;
  node.error = null;
  beginNodeRun(node);
  node.genRollDone = 0;
  node.genPaths = [];
  node.videoStatus = I18n.t("启动后端并生成…");
  startMediaBackendRunWatcher(node);
  renderCanvas();

  const mode = videoGenMode(node);
  const maxImg = videoGenMaxImages(node);
  const maxVid = videoGenMaxVideos(node);
  const maxAud = videoGenMaxAudios(node);
  const firstImage = mode === "fl2va" ? ((videoGenSlotValue(node, 2) || {}).path || "") : "";
  const lastImage = mode === "fl2va" ? ((videoGenSlotValue(node, 3) || {}).path || "") : "";
  const refImages = [];
  const refVideos = [];
  const refAudios = [];
  if (mode === "r2v") {
    for (let i = 0; i < maxImg; i++) {
      const v = videoGenSlotValue(node, 2 + i);
      if (v && v.path) refImages.push(v.path);
      else if (v && v.text && /\.(png|jpe?g|webp|bmp|gif)$/i.test(v.text.trim()))
        refImages.push(v.text.trim());
    }
    for (let i = 0; i < maxVid; i++) {
      const v = videoGenSlotValue(node, 2 + maxImg + i);
      const p = String((v && (v.path || v.text)) || "").trim();
      if (p) refVideos.push(p);
    }
    for (let i = 0; i < maxAud; i++) {
      const v = videoGenSlotValue(node, 2 + maxImg + maxVid + i);
      const p = String((v && (v.path || v.text)) || "").trim();
      if (p) refAudios.push(p);
    }
  }

  const t0 = Date.now();
  let okCount = 0;
  let lastPath = "";

  try {
    for (let roll = 1; roll <= nRolls; roll++) {
      if (mediaRunStopped(node)) break;
      const exp = await prepareMediaGenRollExport(node, roll, nRolls);
      if (!exp || !exp.ok) {
        requireMediaGenExport(node, quiet);
        node.error = savePathResolveError(exp && exp.code);
        node.videoStatus = node.error;
        if (!quiet) toast(node.error, "warn");
        return;
      }
      if (roll === 1 && nRolls === 1 && exp.renamed) {
        syncMediaGenPathFromExport(node, exp);
        if (!quiet) toast(I18n.t("目标文件已存在，改为保存为：") + exp.filename, "ok");
      }
      const seed = nextMediaGenSeed(node);
      {
        const ui = ensureBackendUiState(node);
        ui.genPct = Math.max(2, ui.genPct || 2);
        ui.genMsg =
          mediaGenRollProgressTag(node) +
          (nRolls > 1 ? I18n.t("生成中…") : I18n.t("启动后端并生成…"));
        node.videoStatus = ui.genMsg;
      }
      node.genRollDone = roll - 1;
      refreshMediaNodeUi(node, { soft: true });

      const r = await window.api.h3Generate(
        buildVideoGenRunParams(node, {
          nodeId: node.id,
          seed,
          mode,
          prompt,
          firstImage,
          lastImage,
          refImages,
          refVideos,
          refAudios,
          exp,
        }),
      );
      if (node._aborted || (r && (r.error === "cancelled" || r.cancelled))) {
        node.error = null;
        node.videoStatus = I18n.t("已取消");
        const ui = ensureBackendUiState(node);
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        return;
      }
      if (!r || !r.ok) {
        const err = (r && (r.message || r.error)) || I18n.t("生成失败");
        if (err === "busy_other_node" || (r && r.error === "busy_other_node")) {
          node.error = I18n.t("已有音视频生成任务进行中，已中断本节点（全局仅 1 个，禁止并行）");
        } else if (String(err) === "cancelled") {
          node.error = null;
          node.videoStatus = I18n.t("已取消");
          return;
        } else {
          node.error = String(err);
        }
        node.videoStatus = node.error;
        if (looksLikeBackendConnError(err)) markMediaBackendDown(node);
        if (!quiet) toast(node.error, "err");
        return;
      }
      okCount++;
      lastPath = String(r.path || "");
      if (lastPath) node.genPaths.push(lastPath);
      node.output = { kind: "video", path: lastPath, text: lastPath };
      node.ranAt = Date.now();
      if (lastPath && nRolls === 1) syncMediaGenPathFromExport(node, lastPath);
      node.genRollDone = roll;
    }
    if (node._aborted) {
      node.error = null;
      node.videoStatus = I18n.t("已取消");
      const ui = ensureBackendUiState(node);
      ui.genMsg = I18n.t("已取消");
      ui.genPct = 0;
      return;
    }
    if (!okCount) return;
    const doneMsg = mediaGenDoneMsg(Date.now() - t0);
    node.videoStatus = doneMsg;
    {
      const ui = ensureBackendUiState(node);
      ui.genPct = 100;
      ui.genMsg = doneMsg;
      ui.ok = false;
    }
    if (!quiet) {
      toast(
        nRolls > 1
          ? I18n.t("视频已生成：") + okCount + "/" + nRolls + I18n.t(" 次")
          : I18n.t("视频已生成：") + lastPath,
        "ok",
      );
    }
  } catch (e) {
    if (node._aborted) {
      node.error = null;
      node.videoStatus = I18n.t("已取消");
    } else {
      node.error = (e && e.message) || String(e);
      node.videoStatus = node.error;
      if (looksLikeBackendConnError(node.error)) markMediaBackendDown(node);
      if (!quiet) toast(node.error, "err");
    }
  } finally {
    /* 被用户终止（单独停止 / 全部终止）时不再驱动下游控制线，
       否则「已全部终止」之后队列里又会长出新的生成任务。 */
    const wasStopped = mediaRunStopped(node);
    node.running = false;
    node._aborted = false;
    stopMediaBackendRunWatcher(node.id);
    renderCanvas();
    scheduleSave();
    /* 生成成功：触发控制输出端子（端口1）驱动下游控制目标 */
    if (!wasStopped && nodeHasOutputContent(node))
      await fireControlOutgoing(node, 1, new Set([node.id]));
  }
}

async function restoreVideoGenLocks() {
  return restoreMediaGenLocks();
}

/* ── Remotion 视频节点（应用插件 remotion） ──
   流程：描述文本（连线端子1 文本源）→ apiCall 生成 Composition.tsx（React 动效，
   提示词模板含 Remotion API 速查与约束，仅允许 import remotion/react）→
   window.api.remotionGenerate（主进程 remotion/main-remotion.js：写模板 → spawn
   node render.mjs → 本地渲染 mp4，取 media-gen-global-lock 全局互斥）→ 进度/取消 → node.output=视频路径。
   注：宿主优先采用这份 TSX 作为 src/Composition.tsx（渲染即所见，见 writeRenderSources）；
   无它时才回退内置标题卡模板（按 title / subtitle / bgColor 结构化参数渲染）。 */

/* Remotion 输出分辨率预设（宽x高，px）定义在 app.js（REMOTION_SIZES，先加载共用）。 */

function remotionSizeWH(node) {
  const raw = String(node && node.size || "").trim();
  const m = raw.match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/);
  if (m) return { width: Number(m[1]) || 1280, height: Number(m[2]) || 720 };
  return { width: 1280, height: 720 };
}

/* LLM 生成 Composition.tsx 的提示词模板：Remotion API 速查 + 硬约束 */
function remotionTsxPrompt(desc, opt) {
  opt = opt || {};
  const w = opt.width || 1280;
  const h = opt.height || 720;
  const fps = opt.fps || 30;
  const dur = opt.duration || 5;
  return (
    I18n.t("请为下面这段视频描述编写一个完整的 Remotion Composition.tsx 文件（React 动效合成）。\n") +
    I18n.t("视频描述：") +
    "“" +
    desc +
    "”\n\n" +
    I18n.t("输出要求（必须全部满足）：") +
    "\n" +
    "1. " +
    I18n.t("只输出一个完整的 TypeScript 源文件，不要解释、不要 Markdown 代码围栏，文件内容从 import 开始到文件末尾。") +
    "\n" +
    "2. " +
    I18n.t("仅允许从 \"remotion\" 和 \"react\" 导入（例如 react 的 useState/useMemo，remotion 的 AbsoluteFill/useCurrentFrame/useVideoConfig/interpolate/spring/Sequence/Img/Audio/Easing 等）；禁止导入任何其它 npm 包。") +
    "\n" +
    "3. " +
    I18n.t("导出组件名必须是 Main（export const Main: React.FC = ...），并使用 AbsoluteFill 作为根容器。") +
    "\n" +
    "4. " +
    I18n.t("必须使用 useVideoConfig() 读取 width/height/fps/durationInFrames，不要硬编码视频尺寸与总帧数。") +
    "\n" +
    "5. " +
    I18n.t("时长按 ") +
    dur +
    I18n.t(" 秒 × ") +
    fps +
    I18n.t(" fps 设计动画节奏；动效要连贯自然（淡入淡出 / 位移 / 缩放 / 颜色过渡至少两种），内容贴合描述，文字用中文。") +
    "\n" +
    "6. " +
    I18n.t("所有样式用内联 style 对象（style={{...}}），不要 CSS 文件、不要 class 选择器；颜色用十六进制。") +
    "\n" +
    "7. " +
    I18n.t("代码必须可被 TypeScript 直接编译（宽松配置下），不要使用未定义变量，不要在顶层执行副作用。") +
    "\n" +
    "8. " +
    I18n.t("interpolate 的 inputRange 关键帧数组必须严格递增且元素不重复（从小到大，如 [0,20,60]）；在 map / 循环里按 i 计算关键帧时，后一个帧号必须严格大于前一个（可用 Math.max 兜底），否则渲染会直接失败。") +
    "\n\n" +
    I18n.t("Remotion API 速查：") +
    "\n" +
    "- useCurrentFrame(): " +
    I18n.t("当前帧号") +
    "\n" +
    "- interpolate(frame, [a,b], [c,d], {extrapolateLeft/Right: \"clamp\"}): " +
    I18n.t("数值插值（inputRange 必须严格递增、元素不重复）") +
    "\n" +
    "- spring({frame, fps, config: {damping, stiffness, mass}}): " +
    I18n.t("弹性动画 0→1") +
    "\n" +
    "- <Sequence from={n}>…</Sequence>: " +
    I18n.t("子序列延迟") +
    "\n" +
    "- <Img src={\"...\"}/> / <Audio src={\"...\"}/>: " +
    I18n.t("图像 / 音频（本任务不提供外部资源，可不使用）") +
    "\n" +
    "- opacity/transform 过渡示例：opacity: interpolate(frame,[0,20],[0,1],{extrapolateRight:\"clamp\"})；transform: `translateY(${interpolate(...)}px)`" +
    "\n" +
    I18n.t("画面尺寸 ") +
    w +
    "×" +
    h +
    "，" +
    I18n.t("参考它设计字号与元素布局（可用百分比 / 相对计算）。")
  );
}

async function playRemotionNode(node, quiet) {
  if (!window.api || !window.api.remotionGenerate) {
    toast(I18n.t("Remotion 插件未就绪（请先在插件中安装）"), "err");
    return;
  }
  if (node.running) return;
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }
  /* 全局音视频互斥预检：友好提示（宿主仍会强制取锁） */
  try {
    const st = await window.api.remotionStatus();
    if (!st || !st.installed || !st.runtimeReady) {
      const msg = I18n.t("Remotion 插件尚未安装或未就绪（请先在「插件 · Remotion 动效视频」中安装）");
      node.error = msg;
      node.remotionStatus = msg;
      if (!quiet) toast(msg, "warn");
      renderCanvas();
      return;
    }
    /* 已就绪：同步一次插件缓存，让节点「未安装」警示条及时消失 */
    if (typeof refreshAppPluginsCache === "function") refreshAppPluginsCache();
    const lock = st.lock;
    if (lock && lock.nodeId && lock.nodeId !== node.id) {
      node.error = mediaGenLockBusyMsg(lock);
      node.remotionStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch (_) {}

  /* 描述文本：仅取连线端口1（文本源），节点内不再提供描述字段 */
  let desc = "";
  {
    const v = videoGenSlotValue(node, 1); /* 复用端子取值：端口1=文本输入 */
    if (v && v.text) desc = String(v.text).trim();
  }
  if (!desc) {
    toast(I18n.t("请接入文本节点"), "warn");
    return;
  }

  /* 服务商 / 模型校验（与 proc_text 一致：text_openai 服务商 + API Key） */
  let prov = (S.config.providers || []).find((p) => p.id === node.providerId);
  if (!prov) {
    node.error = I18n.t("未配置服务商（设置 · API/配置）");
    node.remotionStatus = node.error;
    renderCanvas();
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    node.error = I18n.t("该服务商未填写 API Key（设置 · API/配置）");
    node.remotionStatus = node.error;
    renderCanvas();
    return;
  }

  node.running = true;
  node.error = null;
  node._abKey = uid("ab");
  beginNodeRun(node);
  node.remotionStatus = I18n.t("LLM 生成动效代码…");
  node.remotionPct = 2;
  renderCanvas();

  const { width, height } = remotionSizeWH(node);
  const duration = Math.max(1, Math.min(60, Number(node.duration) || 5));
  const fps = Math.max(1, Math.min(60, Number(node.fps) || 30));
  let tsx = "";
  try {
    const spec = {
      provider: prov,
      kind: "text",
      model: node.model || (prov.models || [])[0] || "",
      temperature:
        node.temperature == null
          ? 0.4
          : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
      effort: "low",
      prompt: remotionTsxPrompt(desc, { width, height, fps, duration }),
      texts: [],
      images: [],
      refImage: "",
      abKey: node._abKey || "",
    };
    const rr = await window.api.apiCall(spec);
    if (node._aborted || !node.running || mediaRunStopped(node)) {
      node.error = null;
      node.remotionStatus = I18n.t("已取消");
      node.remotionPct = 0;
      renderCanvas();
      syncRemotionToSession(node, { desc, cancelled: true });
      return;
    }
    if (!rr || !rr.ok) throw new Error((rr && (rr.error || rr.message)) || I18n.t("调用失败"));
    tsx = String(rr.text || "").trim();
    if (!tsx) throw new Error(I18n.t("LLM 未返回动效代码"));
    node.tsx = tsx;
    node.remotionStatus = I18n.t("渲染视频…");
    node.remotionPct = 4;
    renderCanvas();
  } catch (e) {
    node.running = false;
    node.error = (e && e.message) || String(e);
    node.remotionStatus = node.error;
    renderCanvas();
    scheduleSave();
    syncRemotionToSession(node, { desc, ok: false, error: node.error });
    return;
  }

  const seed = nextMediaGenSeed(node);
  const t0 = Date.now();
  try {
    if (node._aborted || !node.running || mediaRunStopped(node)) {
      node.error = null;
      node.remotionStatus = I18n.t("已取消");
      node.remotionPct = 0;
      renderCanvas();
      syncRemotionToSession(node, { desc, cancelled: true });
      return;
    }
    const r = await window.api.remotionGenerate({
      nodeId: node.id,
      workflowId: (S.wf && S.wf.id) || "",
      /* LLM 生成的动效合成：宿主直接采用为 src/Composition.tsx（不合规则渲染失败并报 custom_tsx_*） */
      prompt: tsx,
      tsx,
      /* 回退路径（内置模板）的结构化参数：标题取描述首行 */
      title: desc.split(/\r?\n/)[0].slice(0, 60) || I18n.t("Remotion 视频"),
      subtitle: "",
      backgroundColor: "#0f1218",
      durationSeconds: duration,
      fps,
      width,
      height,
      seed,
    });
    if (node._aborted || (r && (r.error === "cancelled" || r.cancelled))) {
      node.error = null;
      node.remotionStatus = I18n.t("已取消");
      node.remotionPct = 0;
      syncRemotionToSession(node, { desc, cancelled: true });
      return;
    }
    if (!r || !r.ok) {
      const err = (r && (r.message || r.error)) || I18n.t("渲染失败");
      if (String(err) === "busy_other_node" || (r && r.error === "busy_other_node")) {
        node.error = I18n.t("已有音视频生成任务进行中，已中断本节点（全局仅 1 个，禁止并行）");
      } else if (String(err) === "cancelled") {
        node.error = null;
        node.remotionStatus = I18n.t("已取消");
        syncRemotionToSession(node, { desc, cancelled: true });
        return;
      } else {
        node.error = String(err);
      }
      node.remotionStatus = node.error;
      if (!quiet) toast(node.error, "err");
      syncRemotionToSession(node, { desc, ok: false, error: node.error });
      return;
    }
    const path = String(r.path || r.outputPath || "");
    if (!path) throw new Error(I18n.t("渲染完成但未返回输出路径"));
    node.output = { kind: "video", path, text: path };
    node.ranAt = Date.now();
    node.remotionPct = 100;
    node.remotionStatus = mediaGenDoneMsg(Date.now() - t0);
    if (!quiet) toast(I18n.t("视频已生成：") + path, "ok");
    syncRemotionToSession(node, {
      desc,
      ok: true,
      tsx,
      path,
      size: width + "x" + height,
      fps,
      duration,
      elapsed: Date.now() - t0,
    });
  } catch (e) {
    if (node._aborted) {
      node.error = null;
      node.remotionStatus = I18n.t("已取消");
      syncRemotionToSession(node, { desc, cancelled: true });
    } else {
      node.error = (e && e.message) || String(e);
      node.remotionStatus = node.error;
      if (!quiet) toast(node.error, "err");
      syncRemotionToSession(node, { desc, ok: false, error: node.error });
    }
  } finally {
    const wasStopped = mediaRunStopped(node);
    node.running = false;
    node._aborted = false;
    renderCanvas();
    scheduleSave();
    /* 生成成功：触发控制输出端子（端口1）驱动下游控制目标 */
    if (!wasStopped && nodeHasOutputContent(node))
      await fireControlOutgoing(node, 1, new Set([node.id]));
  }
}

/* Remotion 节点生成记录 → 绑定智能会话（参照 syncAgentTaskToSession 口径）：
   user=生成描述（_src:'node-desc'，同标记更新 / hasUser 去重）；
   assistant=结果摘要（成功=输出路径+分辨率/fps/时长/耗时+TSX 代码块；失败=错误信息；取消=已取消），
   hasAi 去重后经 assistantMsgFromNode 构造；写后 persistAgentSession()。 */
function syncRemotionToSession(node, info) {
  if (!node || !node.agentSessionId || !info) return;
  const list = agentSessions();
  const sess = list.find((s) => s.id === node.agentSessionId);
  if (!sess) return;
  /* user：本次生成描述（_src:'node-desc' 去重，参照 syncAgentTaskToSession 的 hasUser） */
  const desc = String((info && info.desc) || "").trim();
  if (desc) {
    const marked = sess.messages.find((m) => m._src === "node-desc");
    if (marked) {
      if (marked.content !== desc) marked.content = desc;
    } else {
      const hasUser = sess.messages.some(
        (m) => m.role === "user" && m.content === desc,
      );
      if (!hasUser)
        sess.messages.push({
          role: "user",
          content: desc,
          _src: "node-desc",
          at: Date.now(),
        });
    }
  }
  /* assistant：结果摘要（成功=输出路径+分辨率/fps/时长/耗时+TSX；失败=错误信息；取消=已取消），hasAi 去重 */
  const lines = [];
  if (info.cancelled) {
    lines.push(I18n.t("生成已取消"));
  } else if (!info.ok || info.error) {
    lines.push(I18n.t("生成失败：") + String(info.error || I18n.t("未知错误")));
  } else {
    const meta = [];
    if (String(info.size || "").trim())
      meta.push(String(info.size).trim().replace("x", "×"));
    if (info.duration != null) meta.push(info.duration + "s");
    if (info.fps != null) meta.push(info.fps + "fps");
    if (info.elapsed != null) meta.push((info.elapsed / 1000).toFixed(1) + "s");
    lines.push(
      I18n.t("生成完成：视频已输出到 ") +
        String(info.path || "") +
        (meta.length ? "（" + meta.join(" · ") + "）" : ""),
    );
  }
  const tsx = String(info.tsx || node.tsx || "").trim();
  if (tsx) {
    lines.push(I18n.t("生成的动效代码（TSX）："));
    lines.push("```tsx");
    lines.push(tsx);
    lines.push("```");
  }
  const summary = lines.join("\n");
  if (summary) {
    const hasAi = sess.messages.some(
      (m) => m.role === "assistant" && m.content === summary,
    );
    if (!hasAi) sess.messages.push(assistantMsgFromNode(node, summary));
  }
  sess.updatedAt = Date.now();
  persistAgentSession().catch(() => {});
}

/* 全局媒体生成串行链：video_gen / music_gen 共享主进程单一后端，
   控制节点并行触发 / 多次尝试并发时排队串行执行，避免并发 busy 与后端竞争。
   排队项登记在 mediaGenWaiters：「全部终止」清空该表后，排队项直接作废，
   绝不再启动后端任务（旧实现是一个无法撤销的 Promise 链，终止后仍会依次开跑）。 */
let _mediaGenChain = Promise.resolve();
function runMediaGenSerial(node, fn) {
  const entry = {
    token: {},
    seq: GLOBAL_STOP_SEQ,
    tick: Number(node && node._stopTick) || 0,
  };
  if (node) {
    mediaGenWaiters.set(node.id, entry);
    /* 排队期间也登记到「等待中」：看得见、也能被「全部终止」一次清掉
       （旧实现完全隐身：终止后队列里才冒出视频任务） */
    addPendingRun([node.id]);
  }
  const run = _mediaGenChain.then(() => {
    if (node) clearPendingRun([node.id]);
    const cur = node && mediaGenWaiters.get(node.id);
    if (cur && cur === entry) {
      mediaGenWaiters.delete(node.id);
      /* 出队瞬间：「排队生成」这条已不存在，先同步一次再起跑，
         否则面板要等到下一次心跳才从等待中挪走 */
      updateRunQueuePanel();
    }
    /* 排队期间发生过终止（表被清空 / 该节点停止代号变化）→ 直接作废，不开后端 */
    if (
      !node ||
      !cur ||
      cur !== entry ||
      cur.seq !== GLOBAL_STOP_SEQ ||
      cur.tick !== (Number(node._stopTick) || 0) ||
      mediaRunStopped(node)
    ) {
      if (node) {
        mediaGenMarkDropped(node, false);
        renderCanvas();
        updateRunQueuePanel();
      }
      return null;
    }
    return fn();
  });
  _mediaGenChain = run.then(
    () => {},
    () => {},
  );
  return run;
}
/* 是否还有媒体生成活动（在途或排队）：供「全部终止」判断与提示文案。
   O(1)：在途任务一定有 run watcher，不需要扫全图节点（大图上会白耗 CPU）。 */
function hasAnyMediaGenActivity() {
  return !!(mediaGenWaiters.size || mediaBackendRunWatchers.size || mediaGenRestoreTimers.size);
}

/* 全部终止时调用：清空排队 + 关掉所有媒体相关轮询 + 取消在途后端任务并释放全局锁。
   只处理「确实有任务（在途或排队）」的节点，不给从没跑过的节点乱写状态。 */
function stopAllMediaGen() {
  const ids = new Set([
    ...mediaGenWaiters.keys(),
    ...mediaBackendRunWatchers.keys(),
    ...mediaGenRestoreTimers.keys(),
  ]);
  try {
    for (const wid of [S.wf, ...Object.values(S.wfBag || {})])
      for (const n of (wid && wid.nodes) || [])
        if (isMediaGenNode(n) && n.running) ids.add(n.id);
  } catch (_) {}
  mediaGenWaiters.clear();
  stopAllMediaGenRestoreWatch();
  stopAllMediaBackendRunWatchers();
  let cancelled = 0;
  for (const id of ids) {
    const n = findMediaGenNodeById(id);
    if (!n) continue;
    const hadJob = !!n.running;
    bumpNodeStop(n);
    n.running = false;
    mediaGenMarkDropped(n, hadJob);
    if (hadJob) {
      mediaGenCancelRemote(n);
      cancelled++;
    }
  }
  return cancelled;
}

async function playNodeBody(node, quiet, opts) {
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return;
  }
  /* 刚按过「全部终止」：由控制节点 / 级联批次驱动的再入一律拒绝起跑。
     （在途 await 可能已经把本批目标叫回来了，但它属于刚被作废的那一批）
     用户直接点 ▶ 不受影响。 */
  if (
    opts &&
    opts.batchDriven &&
    S._lastStopAllAt &&
    Date.now() - Number(S._lastStopAllAt) < 1500
  ) {
    bumpNodeStop(node);
    node.running = false;
    node.error = I18n.t("已手动停止");
    return;
  }
  if (node.kind === "music_gen") {
    return runMediaGenSerial(node, () => playMusicGenNode(node, quiet));
  }
  if (node.kind === "tts_gen") {
    return runMediaGenSerial(node, () => playTtsGenNode(node, quiet));
  }
  if (node.kind === "video_gen") {
    return runMediaGenSerial(node, () => playVideoGenNode(node, quiet));
  }
  if (node.kind === "remotion") {
    return runMediaGenSerial(node, () => playRemotionNode(node, quiet));
  }
  if (node.kind === "wait_file") {
    return playWaitFileNode(node, quiet);
  }
  if (node.kind === "net_recv") {
    return playNetRecvNode(node, quiet);
  }
  if (node.kind === "net_send") {
    return playNetSendNode(node, quiet);
  }
  if (node.kind === "timer") {
    return playTimerNode(node, quiet);
  }
  if (node.kind === "delayer") {
    return playDelayerNode(node, quiet);
  }
  if (node.kind === "sequencer") {
    return playSequencerNode(node, quiet);
  }
  if (node.kind === "gate") {
    return playGateNode(node, quiet);
  }
  if (node.kind === "splitter") {
    return playSplitterNode(node, quiet);
  }
  if (node.kind === "counter") {
    return playCounterNode(node, quiet);
  }
  if (node.kind === "mutex") {
    return playMutexNode(node, quiet);
  }
  if (node.kind === "judge") {
    return playJudgeNode(node, quiet);
  }
  if (node.kind === "task") {
    return playTaskNode(node, quiet);
  }
  /* 函数节点 / 工具节点：自身的运行时执行引擎（JS 执行 / 内部图运行），
     复用本文件其余执行器（runAttempt / apiCall* / 上游补跑 / 持久化）。
     工具节点判定用 isToolNode()（规范形态＝超级节点变体 super + tool:true），
     必须排在普通 super 之前，否则会被当成无引擎的壳节点。 */
  if (node.kind === "function") {
    return runFunctionNode(node, quiet, opts);
  }
  if (isToolNode(node)) {
    return runToolNode(node, quiet, opts);
  }
  if (node.kind === "agent_task" && !String(node.task || "").trim()) {
    toast(I18n.t("先填写任务描述"), "warn");
    return;
  }
  opts = opts || {};
  const cascadePlan = await decideCascadeAfterPlay(node, quiet, opts);
  /* quiet：不弹 toast / 不加 pending；ensureUpstream：仍补跑未处理的上游（控制/级联调度用） */
  const ensureUpstream = !quiet || !!opts.ensureUpstream;
  let pendingIds = null;
  if (!quiet) {
    /* 只挂自身与上游；下游等待由 runDownstreamCascade 负责，避免父节点结束后残留锁死 */
    pendingIds = collectPendingRunIds(node, true);
    addPendingRun(pendingIds);
  }
  if (ensureUpstream) {
    const ran = [];
    try {
      await ensureProcessedAll(procSourcesOutsideSchedule(node), ran);
    } catch (e) {
      if (pendingIds) clearPendingRun(pendingIds);
      throw e;
    }
    if (ran.length && !quiet)
      toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
    if (!quiet) {
      const un =
        node.batchMode === "agg" && batchTitles(node)
          ? resolveRefsAgg(procPromptOf(node), node).unresolved
          : resolveRefs(procPromptOf(node), node, 0).unresolved;
      if (un.length)
        toast(I18n.t("未解析的 @引用：") + I18n.listJoin(un), "warn");
      /* 全局广播只注入被明文 @ 命中的来源：开了彩虹却零命中时给出提示，避免用户以为静默生效 */
      if (usesGlobalRefs(node)) {
        const gs = globalRefSources(node.id);
        if (gs.length && !mentionedRefSources(procPromptOf(node), gs).length)
          toast(
            I18n.t("已开启全局引用，但提示词未 @ 引用任何全局来源，本次未注入内容"),
            "warn",
          );
      }
    }
  }
  const clearPendingEarly = () => {
    if (pendingIds) clearPendingRun(pendingIds);
    else if (S.pendingRun) {
      S.pendingRun.delete(node.id);
      renderCanvas();
      updateRunQueuePanel();
    }
  };
  /* 文本节点接入图像：先尝试自动切到视觉服务商（再校验 Key）——仅原模式 */
  if (node.kind === "proc_text" && !node.agent) {
    const ev = ensureProcTextVision(node, { notify: !quiet });
    if (!ev.ok) {
      clearPendingEarly();
      node.error = ev.reason || I18n.t(VISION_HINT);
      renderCanvas();
      return;
    }
  }
  let prov = S.config.providers.find((p) => p.id === node.providerId);
  if (isDshTask(node)) {
    /* 智能模式按节点所选路由校验（DeepSeek 官方或全局其它文本服务商） */
    const sup = dshSupported();
    if (!sup.ok) {
      clearPendingEarly();
      node.error = sup.reason;
      renderCanvas();
      return;
    }
    syncAgentProviderRoute(node, { save: true });
    let route = String(node.provider || "").trim();
    if (!route) {
      route = defaultAgentProviderRoute();
      node.provider = route;
    }
    prov = providerForAgentRoute(route);
  }
  if (!prov) {
    clearPendingEarly();
    node.error = I18n.t("未配置服务商（设置 · API/配置）");
    renderCanvas();
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    clearPendingEarly();
    node.error = I18n.t("该服务商未填写 API Key（设置 · API/配置）");
    renderCanvas();
    return;
  }
  if (S.pendingRun) S.pendingRun.delete(node.id);
  /* 智能任务：会话模式保留历史并清空输入框；普通模式每次新对话、保留提示词 */
  if (node.kind === "agent_task") {
    const sent = String(node.task || "").trim();
    if (!S.agentTaskSent) S.agentTaskSent = {};
    S.agentTaskSent[node.id] = sent;
    if (!node.chatMode) {
      node.messages = [];
      node._pendingAnswer = "";
      delete node._lastTools;
      node._planFlowDone = false;
    }
    if (!Array.isArray(node.messages)) node.messages = [];
    const lm = node.messages[node.messages.length - 1];
    if (sent && !(lm && lm.role === "user" && lm.content === sent)) {
      node.messages.push({ role: "user", content: sent, at: Date.now() });
    }
    if (node.chatMode) node.task = "";
  }
  node.running = true;
  node.error = null;
  node._abKey = uid("ab");
  beginNodeRun(node);
  node.attemptsDone = 0;
  node._pendingAnswer = "";
  if (!S.thinking) S.thinking = {};
  S.thinking[node.id] = []; // 重置思考缓冲（按尝试槽）
  if (S.wf) {
    rememberWf(S.wf);
    S.nodeWfId = S.nodeWfId || {};
    S.nodeWfId[node.id] = S.wf.id;
  }
  if (node.kind === "agent_task" && node.agentSessionId) {
    const sess = agentSessions().find((s) => s.id === node.agentSessionId);
    if (sess) sess.running = true;
  }
  if (node.kind === "agent_task") node._convNearBottom = true;
  renderCanvas();
  renderStatus();
  if (S.view === "agent") renderAgentSession({ forceStick: true });
  const runP = (async () => {
    try {
      const nA = attemptCount(node);
      if (nA > 1) {
        /* 多次尝试：并行运行 N 次，结果按尝试槽存放 */
        node.attemptOutputs = Array.from({ length: nA }, () => ({
          output: null,
          batchOutputs: null,
          error: null,
          ranAt: 0,
        }));
        const results = await Promise.all(
          Array.from({ length: nA }, (_, t) =>
            runAttempt(node, prov, t).then((res) => {
              node.attemptsDone = t + 1;
              return res;
            }),
          ),
        );
        node.attemptOutputs = results;
        node.attemptIdx = Math.min(node.attemptIdx || 0, nA - 1);
        node.ranAt = Date.now();
        const okc = results.filter((r) => !r.error).length;
        if (!quiet)
          toast(
            I18n.t("多次尝试完成：") + okc + "/" + nA + I18n.t(" 次成功"),
            okc === nA ? "ok" : "warn",
          );
      } else {
        const res = await runAttempt(node, prov, 0);
        node.output = res.output;
        node.batchOutputs = res.batchOutputs;
        node.error = res.error;
        node.ranAt = res.ranAt;
        if (res.error) {
          if (!quiet) toast(I18n.t("处理失败：") + res.error, "err");
        } else if (res.batchOutputs && res.batchOutputs.length) {
          const okc = res.batchOutputs.filter((r) => r.ok).length;
          if (!quiet)
            toast(
              I18n.t("批量处理完成：") +
                okc +
                "/" +
                res.batchOutputs.length +
                I18n.t(" 项成功"),
              okc === res.batchOutputs.length ? "ok" : "warn",
            );
        } else if (res.output) {
          if (!quiet)
            toast(
              node.kind === "agent_task"
                ? I18n.t("智能任务完成（") + res.output.text.length + I18n.t(" 字符）")
                : node.kind === "proc_text"
                  ? I18n.t("文本生成完成（") + res.output.text.length + I18n.t(" 字符）")
                  : I18n.t("图像生成完成"),
              "ok",
            );
        }
      }
    } catch (e) {
      node.error = e.message || String(e);
      if (!quiet) toast(I18n.t("处理失败：") + node.error, "err");
    } finally {
      node.running = false;
      clearAgentTaskSent(node);
      /* 本节点挂上的 pending 一律清掉；下游覆盖批次另有自己的 pending 生命周期 */
      if (pendingIds) clearPendingRun(pendingIds);
      else if (S.pendingRun) {
        S.pendingRun.delete(node.id);
        renderCanvas();
        updateRunQueuePanel();
      }
      if (node.kind === "agent_task" && node.agentSessionId) {
        const sess = agentSessions().find((s) => s.id === node.agentSessionId);
        if (sess) {
          sess.running = false;
          sess._pending = "";
          /* 节点跑完 = 该会话本轮结束：清单定性 + 放行排队消息 */
          try {
            agentFinalizeTodos(sess, node._aborted ? "cancelled" : node.error ? "error" : "ok");
          } catch (_) {}
          setTimeout(() => {
            try {
              agentDrainQueue(sess);
            } catch (_) {}
          }, 0);
        }
      }
      const owner = ownerWfOfNode(node);
      if (owner) persistWf(owner);
      refreshNodeUi(node);
      if (S.wf && owner && S.wf.id === owner.id) {
        scheduleSave(true);
        autoSaveSaves(true, cascadePlan.skipSaveIds);
      }
      if (S.nodeWfId) delete S.nodeWfId[node.id];
    }
  })();
  S.runPromises.set(node.id, runP);
  try {
    await runP;
  } finally {
    S.runPromises.delete(node.id);
  }
  return cascadePlan.nodes;
}

/* ═══════════════ 计算执行节点：函数节点 / 工具节点 ═══════════════
 * 函数节点（kind "function"）：渲染层 JS 执行器（契约在 renderer/js-exec.js —— new
 *                  Function 宽松执行，语言能力全开、无白名单；运行于渲染层，preload 未
 *                  暴露 Node，拿不到文件 / 网络），入参对象 → 返回对象。
 * 工具节点（super + tool:true 变体，判定 isToolNode）：本身就是超级节点容器
 *                  （数据 I/O 通道与 super 一致，见 app.js isSuperLikeNode），
 *                  ▶ / 控制触发后运行其内部图：
 *                  输入端子（外部数据线 → 本节点）自动绑定为内侧输入节点的取值来源，
 *                  内侧汇出（子节点 → 本节点）的输出值写回输出端子。
 * 两者都复用本文件既有执行器：ensureProcessedAll（上游补跑）/ runControlRunnableQueue
 * + runCascadeNode（内部图调度，并行度 10、环路串行兜底）/ 结果持久化。
 */

/* 计算执行类节点：自身无 LLM 调用，由本文件内置引擎驱动。
   工具节点判定走 isToolNode()（规范形态是超级变体，kind 字面值为 "super"）。 */
function isComputeExecKind(n) {
  return !!(n && (isFunctionNode(n) || isToolNode(n)));
}

/* 函数代码正文：以 jscode 为准（节点编辑字段 · docs/tool-function-nodes.md §1.2），
   兼容旧字段 funcCode / code */
function functionCodeOf(node) {
  const raw =
    node && node.jscode != null
      ? node.jscode
      : node && node.funcCode != null
        ? node.funcCode
        : node && node.code != null
          ? node.code
          : "";
  return String(raw).replace(/^\uFEFF/, "");
}

/* 沿入线取某个端子的值（类超级节点端口按 fromIndex 对齐） */
function computePortValue(w, consumer) {
  const src = nodeById(w.from);
  if (!src || isControlKind(src)) return null;
  const idx = superPortIdxFromWire(src, w);
  return valueForInput(src, idx == null ? 0 : idx, consumer || null);
}

/* 函数节点入参对象（js-exec.js 契约）：
 *   input = { <参数名>: value, $<端子序号>: value, values:[...], items:[...] }
 * 文本端子值 {kind:"text",text}；图像端子值 {kind:"image",path}。
 * 按「端子」聚合，不按「连线」：端子号就是画布上那个外侧输入端子号
 * （0 = 控制入、1..N = 各输入参数，与 _agentCallArgs 的索引同一口径），
 * 所以 input.$1 恒等于参数端子 1 的值 —— 与连线挂载顺序无关。
 * 数组（批量）参数端子可挂多条数据线 → input[参数名] / input.$端子号 = 值数组
 * （逐元素按该端子声明 kind 归一 · 按连线顺序 · 一条线也没挂时是空数组 []）；
 * 普通参数维持单值不变（同号多挂的旧脏线只取最先挂上的那条，其余忽略）。
 * 注入优先级：node._agentCallArgs（Agent func call 与「测试」台共用的只读注入点，
 * 契约同 app.js externalValueIntoSuper：索引 0 = 控制入、参数 i 在索引 i+1）
 * 存在时完全取代画布连线取数 —— 不落盘、不改连线、不触碰上游节点。
 * 数组参数的注入值给数组（逐元素归一）或给单个值（按一元素数组收）都认，没给 = 空数组。
 * 取到的值一律按「本节点该输入端子的声明类型」归一（单一真源 normPortValueByKind）：
 * 注入点按 loose 口径（参数类型是定义里写明的，字符串即路径），连线取数只认带图像
 * 扩展名的路径文本；无端子声明时原样，不改既有形状。 */
function functionInputObject(node) {
  const input = { values: [], items: [] };
  if (!node || !S.wf) return input;
  const params = fnToolParamList(node, "in");
  /* 参数 i ↔ 外侧输入端子 i+1（端子 0 = 控制入）；写入形状两条路径共用一份 */
  const put = (i, value) => {
    const title = String((params[i] && params[i].name) || "");
    input.values[i] = value;
    input.items[i] = { title: title, value: value };
    input["$" + (i + 1)] = value;
    if (value != null && title && input[title] === undefined)
      input[title] = value;
  };
  const callArgs = Array.isArray(node._agentCallArgs)
    ? node._agentCallArgs
    : null;
  if (callArgs) {
    for (let i = 0; i < params.length; i++) {
      const port = i + 1;
      const raw = callArgs[port] === undefined ? null : callArgs[port];
      let value;
      if (fnToolInPortIsArray(node, port)) {
        /* 数组参数：注入给数组就逐元素归一，给单个值按一元素数组收，null 才是空数组 ——
           保持「数组端子恒为数组」的形状，函数体可无条件 .map / .length */
        const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
        value = list.map((x) =>
          normFnToolPortValue(node, "in", port, x, { loose: true }).value,
        );
      } else {
        value = normFnToolPortValue(node, "in", port, raw, {
          loose: true,
        }).value;
      }
      put(i, value);
    }
    return input;
  }
  const ws = wiresTo(node.id);
  for (let i = 0; i < params.length; i++) {
    const port = i + 1; /* 参数 i 对外侧端子 i+1 */
    const isArr = fnToolInPortIsArray(node, port);
    const list = [];
    for (let k = 0; k < ws.length; k++) {
      const w = ws[k];
      if ((Number(w.toIndex) || 0) !== port) continue;
      const src = nodeById(w.from);
      if (!src || isControlKind(src)) continue;
      /* 可能 null：上游暂无输出 */
      const value = normFnToolPortValue(
        node,
        "in",
        port,
        computePortValue(w, node),
      ).value;
      if (isArr) list.push(value);
      else if (!list.length) list.push(value); /* 普通端子一号一值 */
    }
    put(i, isArr ? list : list.length ? list[0] : null);
  }
  return input;
}

/* ── 计算执行节点（函数 / 工具）并发闸 ─────────────────────────────────
   函数节点的 JS 已搬到主进程的独立线程执行（根目录 fn-runtime.js），这里补齐队列侧：
     · 一次运行 = 一个槽位 + 一个 runId（node.id#run#<_abKey>，见 fnRunId）；
     · 槽位满则排队：排队期间登记进「等待中」（S.pendingRun → 左下角运行队列看得见），
       出队即 clearPendingRun + updateRunQueuePanel，再进「处理中」；
     · 排队期间发生过「停止 / 全部终止」（全局终止代号变化 / 本节点 _stopTick 变化 /
       _aborted）→ 直接作废，绝不起线程 —— 判定口径与 runMediaGenSerial 完全一致；
     · 嵌套豁免：等待者的祖先已持槽（工具节点内部图里的函数节点、Agent func call
       驱动的工具内部图）→ 直接放行且不占新槽位。否则「N 个工具节点各占 1 槽 +
       它们内部的函数节点等槽」会互相锁死，这是与媒体串行链不同的地方。
   上限是常量（同时开太多独立线程 / 外部进程反而更慢，也更难回收）。 */
const COMPUTE_EXEC_CONCURRENCY = 4;
const computeExecSlots = new Set(); /* 正在持槽的节点 id */
const computeExecWaiters = new Map(); /* 排队中的节点 id -> entry（FIFO 即 Map 插入序） */

function computeExecNodeById(id) {
  if (!id) return null;
  let n = typeof nodeById === "function" ? nodeById(id) : null;
  if (n) return n;
  for (const wid of Object.keys(S.wfBag || {})) {
    const w = S.wfBag[wid];
    const hit = ((w && w.nodes) || []).find((x) => x && x.id === id);
    if (hit) return hit;
  }
  return null;
}

/* 排队项是否已作废：节点没了 / 已被别的批次跑起来 / 入队后被终止过 */
function computeExecEntryStopped(node, entry) {
  if (!node || node.running) return true;
  if (entry.seq !== GLOBAL_STOP_SEQ) return true;
  if (entry.tick !== (Number(node._stopTick) || 0)) return true;
  return runBatchStopped(node);
}

/* 本节点的祖先链上是否有计算执行节点正持槽（工具图嵌套 → 免排队） */
function computeExecAncestorHoldsSlot(node) {
  let cur = node;
  const seen = new Set();
  for (let d = 0; d < 16 && cur; d++) {
    let pid = "";
    try {
      pid = String(
        (typeof nodeParentSuperId === "function" ? nodeParentSuperId(cur) : cur.parentSuperId) ||
          "",
      );
    } catch (_) {
      pid = "";
    }
    if (!pid || seen.has(pid)) return false;
    seen.add(pid);
    if (computeExecSlots.has(pid)) return true;
    cur = computeExecNodeById(pid);
  }
  return false;
}

/* 让出槽位后推进排队队列：能起就起，该废就废（作废项不占槽，继续看下一个） */
function computeExecDrain() {
  while (
    computeExecSlots.size < COMPUTE_EXEC_CONCURRENCY &&
    computeExecWaiters.size
  ) {
    const first = computeExecWaiters.entries().next().value;
    const id = first[0];
    const entry = first[1];
    computeExecWaiters.delete(id);
    /* 出队瞬间：「等待中」这一行已经不存在，先同步面板再交棒，
       否则要等到下一次心跳才从等待中挪走 */
    clearPendingRun([id]);
    if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
    if (computeExecEntryStopped(computeExecNodeById(id), entry)) {
      entry.settle("dropped");
      continue;
    }
    computeExecSlots.add(id);
    entry.settle("go");
  }
}

/* 交出槽位（幂等：没持槽就是空操作，嵌套豁免的调用方也可以放心调） */
function computeExecRelease(node) {
  const id = node && node.id;
  if (!id || !computeExecSlots.has(id)) return;
  computeExecSlots.delete(id);
  computeExecDrain();
}

/* 停止链专用：把该节点的排队项立刻作废并退出「等待中」。
   （bumpNodeStop 里挂钩；不挂钩的话排队项要等到下一次出队才消失） */
function computeExecDropWait(node) {
  const id = node && node.id;
  if (!id) return false;
  const entry = computeExecWaiters.get(id);
  if (!entry) return false;
  computeExecWaiters.delete(id);
  clearPendingRun([id]);
  try {
    entry.settle("dropped");
  } catch (_) {}
  computeExecDrain();
  return true;
}

/* 有计算执行活动（在途或排队）：供停止 / 全部终止的判断与观测。
   单节点口径见 fnRunInFlight / fnRunQueued / computeExecNodeActive（本文件下方，
   工具壳连壳内一起算 —— 画布切换与「全部终止」都靠它认出看不见的排队 / 在飞运行）。 */
function hasAnyComputeExecActivity() {
  return !!(computeExecSlots.size || computeExecWaiters.size);
}

/* 请求一个计算执行槽位。返回：
   { mode:"free" }  未占槽（嵌套豁免 / 同节点重入），release 是空操作
   { mode:"held" }  已占槽，跑完必须 release
   { mode:"dropped" } 排队期间被终止（或节点没了）→ 本次运行作废，不要起线程 */
async function computeExecAcquire(node) {
  const id = node && node.id;
  if (!id) return { mode: "free" };
  if (computeExecSlots.has(id) || computeExecAncestorHoldsSlot(node))
    return { mode: "free" };
  if (computeExecSlots.size < COMPUTE_EXEC_CONCURRENCY) {
    computeExecSlots.add(id);
    return { mode: "held" };
  }
  /* 同节点重复点 ▶（上一次还在排队）：并入那一次排队，自己直接作废 ——
     一个节点的一次运行只允许存在一套线程 / 进程 */
  if (computeExecWaiters.has(id)) {
    await computeExecWaiters.get(id).promise;
    return { mode: "dropped" };
  }
  const entry = {
    seq: GLOBAL_STOP_SEQ,
    tick: Number(node._stopTick) || 0,
    settle: null,
  };
  entry.promise = new Promise((res) => {
    entry.settle = res;
  });
  computeExecWaiters.set(id, entry);
  addPendingRun([id]);
  computeExecDrain(); /* 兜底：万一此刻已有空槽（并发让位）立刻推进 */
  const got = await entry.promise;
  return got === "go" ? { mode: "held" } : { mode: "dropped" };
}

/* running=true 之后必须真的重绘过一帧，再进执行体。
   旧实现同步在渲染主线程跑用户 JS：状态位是置了，但事件循环没归还，画面刷不出来
   —— 用户看到的正是「MTNode 被锁死、点不动、也看不到运行中」。
   后台画布上 rAF 可能迟迟不触发，所以 80ms 兜底放行，绝不为刷一帧卡住运行。 */
function computeExecYieldPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    setTimeout(finish, 80);
    try {
      if (typeof waitCanvasPaint === "function")
        waitCanvasPaint().then(finish, finish);
      else if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(() => setTimeout(finish, 0));
      else setTimeout(finish, 0);
    } catch (_) {
      finish();
    }
  });
}

/* 计算执行节点公共生命周期：并发闸 → 上游补跑 → 执行体 → 结果落盘 / 错误回写 / 级联 */
async function runComputeExecNode(node, quiet, opts, body) {
  opts = opts || {};
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return null;
  }
  /* 先进闸（排队期间节点自身尚未 running → 面板显示「等待中」），
     排到槽位才开始这一轮运行；排队时被终止则整次作废，不起线程也不起进程 */
  const gate = await computeExecAcquire(node);
  if (gate.mode === "dropped") {
    node.running = false;
    if (!node.error) node.error = I18n.t("已手动停止");
    if (typeof refreshNodeUi === "function") refreshNodeUi(node);
    else {
      renderCanvas();
      if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
    }
    return null;
  }
  try {
    return await runComputeExecNodeGated(node, quiet, opts, body);
  } finally {
    computeExecRelease(node);
  }
}

async function runComputeExecNodeGated(node, quiet, opts, body) {
  const cascadePlan = await decideCascadeAfterPlay(node, quiet, opts);
  let pendingIds = null;
  if (!quiet && !opts.noCascade) {
    pendingIds = collectPendingRunIds(node, true);
    addPendingRun(pendingIds);
  }
  node.running = true;
  node.error = null;
  node.ranAt = 0;
  node.output = null;
  node.batchOutputs = null;
  node.attemptOutputs = null;
  node.attemptsDone = 0;
  node.portOutputs = null;
  node._abKey = uid("ab");
  beginNodeRun(node);
  /* 新一轮起跑：清掉上一轮可能被按下的「待取消」补刀标记，
     免得把用户之后主动点的 ▶ 误杀（句柄注册时只认本次运行） */
  fnClearPending(node);
  if (S.wf) {
    rememberWf(S.wf);
    S.nodeWfId = S.nodeWfId || {};
    S.nodeWfId[node.id] = S.wf.id;
  }
  renderCanvas();
  renderStatus();
  const runP = (async () => {
    try {
      /* 先让界面真正刷出一帧「运行中」再往下跑（执行体本身已不在主线程，见 fn-runtime.js） */
      await computeExecYieldPaint();
      if (runBatchStopped(node)) return;
      /* 补跑未处理的数据上游（与 proc 节点一致；控制 / 级联驱动带 ensureUpstream） */
      if (opts.ensureUpstream || !quiet) {
        const ran = [];
        await ensureProcessedAll(procSourcesOutsideSchedule(node), ran);
        if (ran.length && !quiet)
          toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
      }
      if (!runBatchStopped(node)) await body(node, quiet, opts);
    } catch (e) {
      node.error = node._aborted
        ? I18n.t("已手动停止")
        : (e && e.message) || String(e);
      if (!quiet && !node._aborted)
        toast(I18n.t("处理失败：") + node.error, "err");
    } finally {
      node.running = false;
      /* 被停止的收尾统一写在这里：工具外壳提前 return 时自己没写过错误，
         界面会一片空白、看不出是「被停掉」还是「没跑过」。停止链
         （app.js stopNode / stopAllRuns / 删除节点）只负责取消线程与回收进程，
         节点状态一律由这里落定，两边不抢着写。 */
      if (!node.error && runBatchStopped(node)) node.error = I18n.t("已手动停止");
      /* 错误端子：js-exec 契约约定 error 同时写 node.error 与 portOutputs.__error */
      if (!node.portOutputs) node.portOutputs = {};
      node.portOutputs.__error = node.error || "";
      if (node.output) node.portOutputs.$0 = node.output;
      if (pendingIds) clearPendingRun(pendingIds);
      else if (S.pendingRun) {
        S.pendingRun.delete(node.id);
        renderCanvas();
        updateRunQueuePanel();
      }
      const owner = ownerWfOfNode(node);
      if (owner) persistWf(owner);
      refreshNodeUi(node);
      if (S.wf && owner && S.wf.id === owner.id) {
        scheduleSave(true);
        autoSaveSaves(true, cascadePlan.skipSaveIds);
      }
      if (S.nodeWfId) delete S.nodeWfId[node.id];
    }
  })();
  S.runPromises.set(node.id, runP);
  try {
    await runP;
  } finally {
    S.runPromises.delete(node.id);
  }
  return cascadePlan.nodes;
}

/* ── 函数节点：JS 执行（执行器 renderer/js-exec.js → 主进程独立线程 fn-runtime.js） ── */

/* 函数返回值 → 输出端子集合（多输出分发）。规则（docs/tool-function-nodes.md §3）：
 *   · return 为普通对象、且至少命中一个「输出参数名」→ 按键名映射到输出端子 0..M-1
 *     （只写命中的端子，未命中的不写 → 下游取不到值）；
 *   · 标量 / 字符串 / 数组 / 一个都没命中 → 兼容旧口径单输出：只写 $0（= 首个输出端子）；
 *   · 返回值本身已是归一化媒体值 {kind:"image"|"audio"|"video",path} 时按单输出处理。
 * 每个端子的值再按「该输出端子声明的数据类型」归一一次（单一真源 normPortValueByKind）：
 *   图像端子 return "E:\a.png" → {kind:"image",path}；文本端子 return 图像值 → 取其路径作文本。
 * 返回 { ports, count, fixes }：ports = { $<端子序号>: {kind,text|path}, __error:"" }，
 * count = 命中的端子数（0 = 走了单输出兼容分支），
 * fixes = [{index,name,fix}] = 发生过「图像降级为文本」的端子（调用方决定是否提示；
 * 本函数纯计算，不写节点字段 —— 「测试」台复用同一映射却不污染节点运行态）。 */
function functionPortsFromReturn(node, value) {
  const eng = window.mtnodeJsExec || {};
  const ports = {};
  const fixes = [];
  const params = fnToolParamList(node, "out");
  const to = (v, i) => {
    const base =
      (typeof eng.toOutput === "function" ? eng.toOutput(v) : null) || {
        kind: "text",
        text: "",
      };
    return normPortValueByKind(base, fnToolPortKind(node, "out", i));
  };
  const put = (i, v) => {
    const nz = to(v, i);
    if (nz.fix)
      fixes.push({
        index: i,
        name: String((params[i] || {}).name || ""),
        fix: nz.fix,
      });
    return nz.value;
  };
  const plain =
    !!value && typeof value === "object" && !Array.isArray(value);
  const mediaVal =
    plain &&
    typeof value.kind === "string" &&
    value.kind !== "text" &&
    value.path !== undefined;
  let count = 0;
  if (plain && !mediaVal) {
    for (let i = 0; i < params.length; i++) {
      const name = String((params[i] || {}).name || "").trim();
      if (!name) continue;
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
      ports["$" + i] = put(i, value[name]);
      count++;
    }
  }
  if (!count) ports.$0 = put(0, value);
  ports.__error = "";
  return { ports: ports, count: count, fixes: fixes };
}

/* 一次函数运行的 runId：节点 id + 本次运行代号（_abKey 口径，缺则现造一个）。
   主进程运行时按它给这次运行建「一个 worker 线程 + 一份外部进程台账」，
   收尾 / 停止都按 runId 回收 —— 见根目录 fn-runtime.js 与 main-proc-host.js。 */
function fnRunId(node, tag) {
  const base = String((node && node.id) || "fn");
  const seq =
    (node && node._abKey) ||
    (typeof uid === "function" ? uid("fn") : String(Date.now()));
  return base + "#" + (tag || "run") + "#" + seq;
}

/* 本次运行的停止句柄（node.id → cancel()）：放在模块级 Map 而不是节点字段上，
   闭包进不了存档，也不会被 JSON 序列化带进撤销历史。停止链（app.js stopNode /
   stopAllRuns / 删除节点 / 删除画布）经 fnCancelRunsOf / fnCancelRunsOfNodes 取用，
   保证「节点不在运行态 ⇒ 它绑定的线程 / 进程不存在」。 */
const FN_CANCEL_HANDLES = new Map();

/* 「停止落在起跑前一瞬」的补刀标记（node.id 集合）：
   运行体从 running=true 到真的把句柄注册进来之间有几处 await（刷一帧、补跑上游），
   这期间按 ■ 是问不到句柄的 —— 不补这一刀，就会出现「用户已停止、线程却又起了、
   进程还活着」。句柄一注册就立刻按它取消，本次运行结束时（fnSetCancel(node,null)）
   一并作废这个标记，不会牵连用户之后的新运行（起跑处 fnClearPending 也会清）。 */
const FN_CANCEL_PENDING = new Set();

function fnClearPending(node) {
  if (node && node.id) FN_CANCEL_PENDING.delete(node.id);
}

function fnSetCancel(node, fn) {
  if (!node) return;
  const id = node.id;
  if (typeof fn === "function") {
    FN_CANCEL_HANDLES.set(id, fn);
    if (FN_CANCEL_PENDING.has(id)) {
      FN_CANCEL_PENDING.delete(id);
      /* 已经有人在等这次取消了：句柄刚到手就地取消，不留残活的缝 */
      Promise.resolve(fnCancelHandle(id)).catch(() => null);
    }
    return;
  }
  FN_CANCEL_HANDLES.delete(id);
  FN_CANCEL_PENDING.delete(id);
}

/* 本次停止动作的覆盖范围：函数节点 = 它自己；工具节点 = 外壳 + 内部图里的每一个节点
   （含嵌套壳）。工具节点自己不占线程，跑的是内部图里的函数节点，所以停止范围必须连壳内
   一起算，否则会出现「停了外壳、内部线程还在跑、外部进程还活着」。
   返回 { ids:Set<string>, inner:[节点] }；inner 不含外壳自身。 */
function fnScopeOf(node) {
  const ids = new Set();
  const inner = [];
  if (!node || !node.id) return { ids, inner };
  ids.add(String(node.id));
  if (!isToolNode(node)) return { ids, inner };
  let list = [];
  try {
    const owner =
      (typeof ownerWfOfNode === "function" ? ownerWfOfNode(node) : null) || S.wf;
    list = (owner && owner.nodes) || [];
  } catch (_) {
    list = (S.wf && S.wf.nodes) || [];
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of list) {
      if (!n || !n.id || ids.has(String(n.id))) continue;
      const p = String(
        (typeof nodeParentSuperId === "function"
          ? nodeParentSuperId(n)
          : n.parentSuperId) || "",
      );
      if (!p || !ids.has(p)) continue;
      ids.add(String(n.id));
      inner.push(n);
      grew = true;
    }
  }
  return { ids, inner };
}

/* 该节点（工具节点含其壳内）当前是否有「可取消的在途函数运行」 */
function fnHasLiveRun(node) {
  if (!FN_CANCEL_HANDLES.size) return false;
  const { ids } = fnScopeOf(node);
  for (const id of ids) if (FN_CANCEL_HANDLES.has(id)) return true;
  return false;
}

/* 该节点名下是否有「计算执行活动」：在途句柄 / 正在持槽 / 排队中，任一即真。
   与 fnHasLiveRun 的差别就是「还没起线程」的那两半：槽位已占（正在刷帧 / 补跑上游）
   和只在排队（等待中）。画布切换靠它决定「这张画布的节点对象能不能被磁盘副本替换」——
   换了就会把一次在飞 / 排队的运行甩成看不见也停不掉的幽灵。 */
function fnScopeHasFlag(node, flag) {
  if (!node || !node.id) return false;
  if (flag.has(String(node.id))) return true;
  if (!flag.size || !isToolNode(node)) return false;
  /* 工具壳：内部图里任一节点的槽位 / 排队 / 句柄都算在它名下（停壳必须连壳内一起停） */
  const { ids } = fnScopeOf(node);
  for (const id of ids) if (flag.has(String(id))) return true;
  return false;
}
/* 在途：句柄已注册（线程真在跑）或已占槽（正在刷帧 / 补跑上游，马上起线程） */
function fnRunInFlight(node) {
  return fnScopeHasFlag(node, FN_CANCEL_HANDLES) || fnScopeHasFlag(node, computeExecSlots);
}
/* 只在排队（等待中），线程还没起 */
function fnRunQueued(node) {
  return fnScopeHasFlag(node, computeExecWaiters);
}
function computeExecNodeActive(node) {
  return fnRunInFlight(node) || fnRunQueued(node);
}

/* 整张画布口径（app.js wfHasRunning 用）：这张画布里还有没有计算执行活动 */
function computeExecActivityInWf(wf) {
  if (
    !FN_CANCEL_HANDLES.size &&
    !computeExecSlots.size &&
    !computeExecWaiters.size
  )
    return false;
  const nodes = (wf && Array.isArray(wf.nodes) && wf.nodes) || [];
  for (const n of nodes) {
    if (!n || !isComputeExecKind(n)) continue;
    if (computeExecNodeActive(n)) return true;
  }
  return false;
}

/* 取消一个句柄：主进程先 terminate 线程（此后不可能再起进程），再按 runId 连进程树回收。
   返回该次运行的收尾结果（含 killedProcs / killedPids）；没有句柄返回 null。 */
async function fnCancelHandle(id) {
  const key = String(id == null ? "" : id);
  const fn = key ? FN_CANCEL_HANDLES.get(key) : null;
  if (typeof fn !== "function") return null;
  FN_CANCEL_HANDLES.delete(key);
  try {
    return await fn();
  } catch (_) {
    return null;
  }
}

/* 停止链统一入口（app.js stopNode / stopAllRuns / 删除节点 / 删除画布 / 停任务都走这里）：
   bumpNodeStop 已经打掉「排队项」，本函数负责在途的那一半 ——
   逐个取消范围内的线程，并按 runId 回收外部进程。
   返回 { runs, procs, pids }：runs = 真的终止掉的线程数，procs = 回收掉的外部进程数
   （进程数写进 toast，让用户看得见「进程已经不在了」）。 */
async function fnCancelRunsOf(node) {
  const sum = { runs: 0, procs: 0, pids: [] };
  if (!node || !node.id) return sum;
  const { ids, inner } = fnScopeOf(node);
  /* 工具节点：壳内节点一并打停止标记 —— 排队中的立刻退出「等待中」，
     在途的在当前检查点退出，不会留下「外壳停了、内部又起跑」的幽灵；
     内部在跑的模型请求也一并断掉（外壳都停了，不能继续烧 token）。 */
  const scoped = [node].concat(inner);
  for (const c of inner) {
    try {
      bumpNodeStop(c);
    } catch (_) {}
    try {
      if (c._abKey && window.api && window.api.apiAbort)
        window.api.apiAbort(c._abKey);
    } catch (_) {}
  }
  for (const c of scoped) {
    const id = c && c.id ? String(c.id) : "";
    if (!id || !ids.has(id)) continue;
    if (FN_CANCEL_HANDLES.has(id)) {
      const r = await fnCancelHandle(id);
      sum.runs++;
      sum.procs += Number(r && r.killedProcs) || 0;
      const pids = (r && r.killedPids) || [];
      for (const p of pids) sum.pids.push(p);
    } else if (
      isFunctionNode(c) &&
      (c.running || computeExecSlots.has(id) || FN_CANCEL_PENDING.has(id))
    ) {
      /* 还没把句柄注册进来的那一瞬（刷帧 / 补跑上游里）：记下待取消，
         运行体一注册就立刻按它取消 —— 绝不允许「按了停止，线程却又起、进程还活着」。
         只有函数节点会注册句柄（工具外壳自己不跑代码），所以补刀只打在函数节点上。 */
      FN_CANCEL_PENDING.add(id);
    }
  }
  return sum;
}

/* 节点表版（删除节点 / 删除画布 / 工具节点临时内部图作废用）：
   只回收这批节点名下在途的线程与进程。
   传入的节点表应已含后代（deleteNodes 的 ids、被删画布与影子克隆的 nodes 都是全集）。 */
async function fnCancelRunsOfNodes(nodes) {
  const sum = { runs: 0, procs: 0, pids: [] };
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return sum;
  const ids = new Set();
  for (const n of list) if (n && n.id) ids.add(String(n.id));
  let touched = false;
  if (FN_CANCEL_HANDLES.size) {
    for (const key of [...FN_CANCEL_HANDLES.keys()]) {
      if (!ids.has(String(key))) continue;
      touched = true;
      const r = await fnCancelHandle(key);
      sum.runs++;
      sum.procs += Number(r && r.killedProcs) || 0;
      const pids = (r && r.killedPids) || [];
      for (const p of pids) sum.pids.push(p);
    }
  }
  if (touched) return sum;
  /* 一个句柄都没命中：这批里若还有「算作在跑」的计算执行节点，按节点走一遍统一入口
     （连带工具壳内 + 待取消补刀），保证不留残活 */
  for (const n of list) {
    if (!n || !isComputeExecKind(n)) continue;
    if (!n.running && !computeExecNodeActive(n)) continue;
    const r = await fnCancelRunsOf(n);
    sum.runs += r.runs;
    sum.procs += r.procs;
    for (const p of r.pids) sum.pids.push(p);
  }
  return sum;
}

async function runFunctionNode(node, quiet, opts) {
  return runComputeExecNode(node, quiet, opts, async (n, q) => {
    const engine = window.mtnodeJsExec;
    if (!engine || typeof engine.run !== "function")
      throw new Error(I18n.t("函数节点执行器未加载（js-exec.js）"));
    const code = functionCodeOf(n);
    if (!String(code).trim())
      throw new Error(I18n.t("函数节点：请先填写 JS 代码"));
    const input = functionInputObject(n);
    /* 异步执行：代码在主进程的独立线程里跑，渲染层全程不阻塞（异常 / 超时都已被
       执行器捕获成 res.ok === false），所以「运行中」刷得出来、也随时能停 */
    let res = null;
    /* 注意：这里不再先 fnSetCancel(n, null)「清场」—— 句柄只会在本次运行的
       onCancel 里登记、在下面的 finally 里注销；开跑前先清空反而会把停止链刚写下的
       「待取消」补刀标记抹掉（用户在刷帧 / 补跑上游期间按的 ■ 就白按了）。 */
    try {
      res = await engine.run(code, input, {
        runId: fnRunId(n, "run"),
        onCancel: (cancelRun) => fnSetCancel(n, cancelRun),
      });
    } finally {
      fnSetCancel(n, null);
    }
    if (!res || res.ok === false) {
      /* 被停止：与引擎其它执行器同口径写「已手动停止」，不当成代码错误刷屏 */
      n.error =
        n._aborted || (res && res.cancelled)
          ? I18n.t("已手动停止")
          : (res && res.error) || I18n.t("执行失败");
      if (!q && n.error !== I18n.t("已手动停止"))
        toast(I18n.t("函数节点执行失败：") + n.error, "err");
    } else {
      const m = functionPortsFromReturn(n, res ? res.value : undefined);
      n.portOutputs = m.ports;
      n.output = m.ports.$0 || null; /* 主输出 = 端子 0，与生命周期收尾写回一致 */
      /* 端子归一提示：本轮重算（无降级就清掉上一轮的文案） */
      delete n._portKindFix;
      for (const f of m.fixes || [])
        notePortKindFix(n, "out", f.index, f.fix, f.name);
      if (!q)
        toast(
          m.count > 1
            ? I18n.t("函数节点完成 · 分发 ") + m.count + I18n.t(" 个输出端子")
            : I18n.t("函数节点完成"),
          "ok",
        );
    }
    n.ranAt = Date.now();
  });
}

/* 「测试」台专用：严格只读地跑一次函数节点 —— 测试入参经 node._agentCallArgs
   注入点进入（见 functionInputObject），全程不写 node.output / portOutputs、
   不级联下游、不进撤销历史、不改 running / error / ranAt（节点运行态原样保留）。
   执行同样走主进程的独立线程（await 才拿到结果），所以试跑期间界面不卡。
   返回 { ok, ports, count, error, fixes }，ports 与画布 ▶ 用的是同一个映射函数
   （端子归一也在里面做）；fixes 只随返回值给出，不写进节点（_portKindFix 属运行态）。 */
async function testFunctionNode(node, args) {
  const fail = (msg) => ({
    ok: false,
    ports: { __error: msg },
    count: 0,
    error: msg,
    fixes: [],
  });
  const engine = window.mtnodeJsExec;
  if (!engine || typeof engine.run !== "function")
    return fail(I18n.t("函数节点执行器未加载（js-exec.js）"));
  const code = functionCodeOf(node);
  if (!String(code).trim()) return fail(I18n.t("函数节点：请先填写 JS 代码"));
  const prev = node._agentCallArgs;
  node._agentCallArgs = Array.isArray(args) ? args : [];
  let res = null;
  try {
    res = await engine.run(code, functionInputObject(node), {
      runId: fnRunId(node, "test"),
    });
  } catch (e) {
    res = { ok: false, error: (e && e.message) || String(e) };
  } finally {
    if (prev === undefined) delete node._agentCallArgs;
    else node._agentCallArgs = prev;
  }
  if (!res || res.ok === false)
    return fail((res && res.error) || I18n.t("执行失败"));
  const m = functionPortsFromReturn(node, res.value);
  return {
    ok: true,
    ports: m.ports,
    count: m.count,
    error: "",
    fixes: m.fixes || [],
  };
}

/* ── 工具节点：运行内部图（类超级节点容器，父级 = 本节点） ── */
async function runToolNode(node, quiet, opts) {
  return runComputeExecNode(node, quiet, opts, async (n, q) => {
    const inner = superChildrenOf(n.id);
    /* 内部可运行子图：proc / 智能 / 媒体 / 计算执行 / 保存 / 任务 / 网络
       （与 runCascadeNode 覆盖面一致；input_* 为参数 / 常量，不执行；
       wait_file 与纯控制类节点暂不在工具图内自动触发） */
    const runnable = inner.filter(
      (c) =>
        !isSuperIoNode(c) &&
        c.kind !== "wait_file" &&
        (isAutoProcKind(c) ||
          isMediaGenNode(c) ||
          isComputeExecKind(c) ||
          isSaveNode(c) ||
          c.kind === "net_recv" ||
          c.kind === "net_send"),
    );
    if (!runnable.length) {
      n.error = I18n.t("工具节点内部没有可执行的节点");
      if (!q) toast(I18n.t("工具节点内部没有可执行的节点"), "warn");
      return;
    }
    const seen = new Set();
    await runControlRunnableQueue(null, runnable, seen, (c) =>
      runCascadeNode(c, seen),
    );
    if (runBatchStopped(n)) return;
    /* 内侧汇流 → 输出端子写回（复用 super 的 superInternalOutFeeds 通道语义）；
       每个端子的值按「该输出端子声明的数据类型」归一一次（单一真源
       normPortValueByKind，见 app.js），图像端子拿到路径文本 → {kind:"image",path}，
       文本端子拿到图像 → 取其路径作文本并在节点摘要提示一句。归一只换形状，不吞数据；
       内部节点自身的输出原样保留（普通子图链路一字不改）。 */
    const outs = {};
    let any = false;
    delete n._portKindFix;
    for (const w of superInternalOutFeedsAll(n)) {
      const j = Number(w.toIndex || 0);
      if (outs["$" + j]) continue;
      const ch = nodeById(w.from);
      if (!ch || ch.running) continue;
      const raw = valueForInput(ch, Number(w.fromIndex || 0), ch) || null;
      const nz = normPortValueByKind(
        raw,
        fnToolPortKind(n, "out", j),
      );
      if (nz.fix) {
        const pe = fnToolParamList(n, "out")[j] || {};
        notePortKindFix(n, "out", j, nz.fix, pe.name);
      }
      const v = nz.value;
      if (v) any = true;
      outs["$" + j] = v;
    }
    n.portOutputs = outs;
    n.portOutputs.__error = "";
    if (outs.$0) n.output = outs.$0;
    else if (!any) {
      const bad = inner.find((c) => c.error && !c.running);
      if (bad)
        n.error =
          I18n.t("内部节点失败：") + (bad.title || bad.id) + "：" + bad.error;
    }
    n.ranAt = Date.now();
  });
}

/* ============ 保存节点（单条 / 批量 / 聚合） ============ */

/* 解析节点配置的保存路径为绝对路径；失败时 toast 并返回 null */
function absSaveDest(node, quiet) {
  const r = resolveSavePath(node && node.savePath, node);
  if (r.ok) return r.path;
  if (!quiet) toast(savePathResolveError(r.code), "warn");
  return null;
}

/* 聚合保存：所有条目合并为一个 YAML（键 = 条目 field，不用节点标题） */
async function saveTextAgg(node, quiet) {
  const dest = absSaveDest(node, quiet);
  if (!dest) return false;
  const entries = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src || isControlKind(src)) continue;
    const portIdx = superPortIdxFromWire(src, w);
    const items = allTextItems(src, node, portIdx);
    if (items.length) {
      for (const it of items)
        entries.push({
          key: yamlSaveKey(it.title, src.title),
          text: it.text,
        });
    } else {
      const v = valueFromWire(w, node, 0);
      if (v && v.kind === "text")
        entries.push({ key: "", text: v.text });
    }
  }
  if (!entries.length) {
    if (!quiet) toast(I18n.t("没有可保存的文本输入"), "warn");
    return false;
  }
  const r = await window.api.fileWriteText(dest, yamlSaveBody(entries));
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = dest;
  node.savedPaths = [dest];
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存聚合 YAML → ") + dest, "ok");
  return true;
}

async function saveTextOnce(node, quiet) {
  const titles = batchTitles(node);
  if (titles && node.batchMode === "agg") return saveTextAgg(node, quiet);
  const destBase = absSaveDest(node, quiet);
  if (!destBase) return false;
  if (titles) {
    const paths = [];
    for (let idx = 0; idx < titles.length; idx++) {
      const entries = [];
      for (const w of wiresTo(node.id)) {
        const src = nodeById(w.from);
        if (!src || isControlKind(src)) continue;
        const fromIdx =
          src.kind === "super" ? Number(w.fromIndex || 0) : idx;
        const v = valueForInput(src, fromIdx, node);
        if (v && v.kind === "text")
          entries.push({
            key: yamlSaveKey(itemTitleOf(src, fromIdx, node), src.title),
            text: v.text,
          });
      }
      if (!entries.length) continue;
      const p = batchOutPath(destBase, titles[idx], ".yaml");
      const r = await window.api.fileWriteText(p, yamlSaveBody(entries));
      if (!r.ok) {
        if (!quiet) toast(I18n.t("保存失败：") + p, "err");
        continue;
      }
      paths.push(p);
    }
    if (!paths.length) {
      if (!quiet) toast(I18n.t("没有可保存的文本输入"), "warn");
      return false;
    }
    node.savedPaths = paths;
    node.savedPath = destBase;
    node.savedAt = Date.now();
    if (!quiet)
      toast(
        I18n.t("已保存 ") +
          paths.length +
          I18n.t(" 个 YAML 文件 → ") +
          fileName(paths[0]) +
          " …",
        "ok",
      );
    return true;
  }
  const entries = [];
  let missing = false;
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src || isControlKind(src)) continue;
    const fromIdx = src.kind === "super" ? Number(w.fromIndex || 0) : 0;
    const v = valueForInput(src, fromIdx, node);
    if (!v || v.kind !== "text") {
      missing = true;
      continue;
    }
    entries.push({
      key: yamlSaveKey(itemTitleOf(src, fromIdx, node), src.title),
      text: v.text,
    });
  }
  if (!entries.length) {
    if (!quiet) toast(I18n.t("没有可保存的文本输入"), "warn");
    return false;
  }
  if (missing && !quiet) toast(I18n.t("部分输入节点尚无文本输出，已跳过"), "warn");
  const yaml = yamlSaveBody(entries);
  const r = await window.api.fileWriteText(destBase, yaml);
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = destBase;
  node.savedPaths = [destBase];
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存 YAML → ") + destBase, "ok");
  return true;
}

/* 聚合保存（图像）：所有条目合并取第一张写入单文件 */
async function saveImageAgg(node, quiet) {
  const dest0 = absSaveDest(node, quiet);
  if (!dest0) return false;
  const paths = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    for (const it of allImageItems(src, node, superPortIdxFromWire(src, w)))
      paths.push(it.path);
  }
  if (!paths.length) {
    if (!quiet) toast(I18n.t("图像保存节点需要一个图像输入"), "warn");
    return false;
  }
  const dest = forcePathExt(dest0, ".png");
  const r = await window.api.fileCopyAssetTo(paths[0], dest);
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = dest;
  node.savedPaths = [dest];
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存图像 → ") + dest, "ok");
  return true;
}

async function saveImageOnce(node, quiet) {
  const titles = batchTitles(node);
  if (titles && node.batchMode === "agg") return saveImageAgg(node, quiet);
  const destBase0 = absSaveDest(node, quiet);
  if (!destBase0) return false;
  if (titles) {
    const paths = [];
    for (let idx = 0; idx < titles.length; idx++) {
      const ins = inputValuesFor(node, idx);
      const v = ins[0] && ins[0].value;
      if (!v || v.kind !== "image") continue;
      const p = batchOutPath(destBase0, titles[idx], ".png");
      const r = await window.api.fileCopyAssetTo(v.path, p);
      if (!r.ok) {
        if (!quiet) toast(I18n.t("保存失败：") + p, "err");
        continue;
      }
      paths.push(p);
    }
    if (!paths.length) {
      if (!quiet) toast(I18n.t("图像保存节点需要一个图像输入"), "warn");
      return false;
    }
    node.savedPaths = paths;
    node.savedPath = destBase0;
    node.savedAt = Date.now();
    if (!quiet)
      toast(
        I18n.t("已保存 ") + paths.length + I18n.t(" 个图像文件 → ") + fileName(paths[0]) + " …",
        "ok",
      );
    return true;
  }
  const ins = inputValuesFor(node, 0);
  if (!ins.length || !ins[0].value || ins[0].value.kind !== "image") {
    if (!quiet) toast(I18n.t("图像保存节点需要一个图像输入"), "warn");
    return false;
  }
  const destBase = forcePathExt(destBase0, ".png");
  const r = await window.api.fileCopyAssetTo(ins[0].value.path, destBase);
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = destBase;
  node.savedPaths = [destBase];
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存图像 → ") + destBase, "ok");
  return true;
}

async function saveMediaFileOnce(node, quiet, media) {
  const destBase0 = absSaveDest(node, quiet);
  if (!destBase0) return false;
  const ext = saveExtForMedia(media);
  const ins = inputValuesFor(node, 0);
  const v = ins[0] && ins[0].value;
  /* 端子值给的是本机路径，也可能是上游 @引用 / 手填的 file:/// URL → 一律先归一回路径再复制 */
  const srcPath = pathFromMediaValue(v);
  if (!srcPath) {
    if (!quiet)
      toast(
        media === "audio"
          ? I18n.t("保存节点需要一个音频输入")
          : I18n.t("保存节点需要一个视频输入"),
        "warn",
      );
    return false;
  }
  const destBase = forcePathExt(destBase0, ext);
  const r = await window.api.fileCopyAssetTo(srcPath, destBase);
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = destBase;
  node.savedPaths = [destBase];
  node.savedAt = Date.now();
  if (!quiet)
    toast(
      (media === "audio" ? I18n.t("已保存音频 → ") : I18n.t("已保存视频 → ")) +
        destBase,
      "ok",
    );
  return true;
}

/* 全局助手 / 智能会话改画布期间：自动保存先不落盘，避免半成品与移入超节点后路径重复写。
   注意：仅约束「自动保存」；用户手动 ▶ 执行保存节点不受影响，直接保存输入内容。 */
function beginSaveNodeHold() {
  S._saveNodeHold = (S._saveNodeHold || 0) + 1;
}
function endSaveNodeHold() {
  S._saveNodeHold = Math.max(0, (S._saveNodeHold || 0) - 1);
  if (!S._saveNodeHold) flushDeferredSaveNodes();
}
function agentBlocksSaveNodes() {
  return (
    (S._saveNodeHold || 0) > 0 ||
    !!S.assistRunActive ||
    anyAgentSessionRunning()
  );
}
function flushDeferredSaveNodes() {
  if (!S._deferAutoSaveAfterAgent) return;
  S._deferAutoSaveAfterAgent = false;
  try {
    /* forceWired：助手刚搭完图，连着的保存节点应落盘一次（路径已含超节点子文件夹） */
    autoSaveSaves(true);
  } catch (_) {
    /* ignore */
  }
}

async function saveNodeOnce(node, quiet, opts) {
  /* 手动执行（saveNodeAction）与智能助手/会话无关：直接保存输入内容，不受 hold 约束 */
  if (!(opts && opts.manual) && agentBlocksSaveNodes()) {
    S._deferAutoSaveAfterAgent = true;
    return false;
  }
  const media = saveMediaKind(node);
  if (media === "text") return saveTextOnce(node, quiet);
  if (media === "image") return saveImageOnce(node, quiet);
  return saveMediaFileOnce(node, quiet, media);
}

async function saveNodeAction(node) {
  beginNodeRun(node);
  /* 保存节点独立于会话/智能助手：手动 ▶ 直接保存来自输入的内容 */
  if (!String(node.savePath || "").trim()) {
    toast(I18n.t("请先指定保存路径（可用「浏览」选择）"), "warn");
    return;
  }
  const pathCheck = resolveSavePath(node.savePath, node);
  if (!pathCheck.ok) {
    toast(savePathResolveError(pathCheck.code), "warn");
    return;
  }
  const pendingIds = new Set([node.id]);
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (
      !src ||
      (src.kind !== "proc_text" &&
        src.kind !== "proc_image" &&
        src.kind !== "agent_task" &&
        src.kind !== "music_gen" &&
        src.kind !== "tts_gen" &&
        src.kind !== "video_gen")
    )
      continue;
    /* 上游已跑完：不要再标成等待，否则处理→保存级联时刚完成的生成节点会被送进等待队列 */
    if (!src.running && nodeAlreadyProcessed(src)) continue;
    for (const id of collectPendingRunIds(src, true)) pendingIds.add(id);
  }
  addPendingRun(pendingIds);
  const ran = [];
  try {
    await ensureProcessedAll(procSourcesOutsideSchedule(node), ran);
    if (ran.length) toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
    const ok = await saveNodeOnce(node, false, { manual: true });
    if (ok) {
      renderCanvas();
      renderStatus();
      scheduleSave();
    }
  } finally {
    clearPendingRun(pendingIds);
  }
}
async function autoSaveSaves(forceWired, skipIds) {
  if (agentBlocksSaveNodes()) {
    S._deferAutoSaveAfterAgent = true;
    return;
  }
  if (!S.wf || !Array.isArray(S.wf.nodes)) return;
  let changed = false;
  const skip = skipIds || S._cascadeSkipSaveIds;
  for (const n of S.wf.nodes) {
    if (!isSaveNode(n)) continue;
    if (skip && skip.has(n.id)) continue;
    if (!n.savePath) continue;
    const wired = wiresTo(n.id).some((w) => {
      const src = nodeById(w.from);
      return src && !isControlKind(src);
    });
    if (forceWired) {
      /* 上游输出刚更新：只要连着保存节点就落盘，无需再点 ▶ */
      if (!wired) continue;
    } else {
      /* 常规持久化触发：尊重「自动保存」开关（默认开） */
      if (n.auto === false || !wired) continue;
    }
    try {
      if (await saveNodeOnce(n, true))
        changed = true;
    } catch {
      /* 忽略自动保存错误 */
    }
  }
  /* 绘制文字编辑中禁止重绘，否则会拆掉 contentEditable 焦点 */
  if (changed) renderCanvas();
}

/* 控制节点两端的已连接节点（指挥线双向：连出或连入都算；经超级节点端子隧穿） */
function controlTargets(node) {
  const out = [];
  const seen = new Set();
  if (!node || !S.wf) return out;
  const add = (n) => {
    if (!n || n.id === node.id || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  };
  const addExpand = (n, via) => {
    if (!n) return;
    if (n.kind !== "super") {
      add(n);
      return;
    }
    /* via: { dir:'in'|'out', index } — 进入超节点的方向与端子号 */
    const idx = Number((via && via.index) || 0);
    if (via && via.dir === "in") {
      for (const bw of superInternalBridgeWiresAll(n)) {
        if (Number(bw.fromIndex || 0) !== idx) continue;
        addExpand(nodeById(bw.to), null);
      }
      return;
    }
    if (via && via.dir === "out") {
      for (const ow of superExternalOutWiresAll(n)) {
        if (Number(ow.fromIndex || 0) !== idx) continue;
        addExpand(nodeById(ow.to), null);
      }
      return;
    }
    add(n);
  };
  for (const w of S.wf.wires) {
    if (w.rel) continue;
    if (w.from === node.id) {
      const to = nodeById(w.to);
      if (to && to.kind === "super" && nodeParentSuperId(node) !== to.id) {
        addExpand(to, { dir: "in", index: w.toIndex });
      } else if (to && to.kind === "super" && nodeParentSuperId(node) === to.id) {
        addExpand(to, { dir: "out", index: w.toIndex });
      } else add(to);
    }
    if (w.to === node.id) {
      const from = nodeById(w.from);
      if (from && from.kind === "super" && nodeParentSuperId(node) !== from.id) {
        /* 超 → 本控制：外侧输出来自内侧汇流 */
        for (const feed of superInternalOutFeedsAll(from)) {
          if (Number(feed.toIndex) !== Number(w.fromIndex || 0)) continue;
          addExpand(nodeById(feed.from), null);
        }
      } else if (
        from &&
        from.kind === "super" &&
        nodeParentSuperId(node) === from.id
      ) {
        /* 内侧桥接 → 本控制：外侧输入源也算关联（少见） */
        for (const ext of superExternalInWiresAll(from)) {
          if (Number(ext.toIndex) !== Number(w.fromIndex || 0)) continue;
          add(nodeById(ext.from));
        }
      } else add(from);
    }
  }
  return out;
}

function canControlRun(n) {
  return (
    !!n &&
    !isExecStart(n) &&
    !isExecEnd(n) &&
    (n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "agent_task" ||
      isFunctionNode(n) ||
      isToolNode(n) ||
      n.kind === "wait_file" ||
      n.kind === "timer" ||
      n.kind === "delayer" ||
      n.kind === "sequencer" ||
      n.kind === "gate" ||
      n.kind === "splitter" ||
      n.kind === "counter" ||
      n.kind === "mutex" ||
      n.kind === "task" ||
      n.kind === "judge" ||
      isSaveNode(n) ||
      n.kind === "music_gen" ||
      n.kind === "tts_gen" ||
      n.kind === "video_gen" ||
      n.kind === "remotion" ||
      n.kind === "control" ||
      n.kind === "net_send" ||
      n.kind === "net_recv")
  );
}

/* 控制节点执行前作废目标输出，避免 ensureProcessed 因旧结果跳过上游 */
function invalidateControlRunTargets(nodes) {
  for (const n of nodes || []) {
    if (!n || n.kind === "control") continue;
    if (
      n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      n.kind === "agent_task" ||
      n.kind === "wait_file" ||
      n.kind === "task"
    ) {
      n.output = null;
      n.batchOutputs = null;
      n.error = null;
      n.ranAt = 0;
      n.attemptOutputs = null;
      n.attemptsDone = 0;
      n.attemptIdx = 0;
      if (n.kind === "wait_file") {
        n.waitStatus = "";
        n.waitReady = false;
      }
      if (n.kind === "task") n.taskStatus = "pending";
    }
    if (isSaveNode(n)) {
      n.savedPaths = [];
      n.savedPath = "";
      n.savedAt = 0;
    }
  }
}

/* 控制执行依赖图：数据边；wait_file 指挥边计入；普通控制指挥边忽略 */
function controlRunDepGraph(nodes) {
  const list = (nodes || []).filter(Boolean);
  const set = new Set(list.map((n) => n.id));
  const indeg = {};
  const adj = {};
  const byId = {};
  for (const n of list) {
    indeg[n.id] = 0;
    adj[n.id] = [];
    byId[n.id] = n;
  }
  for (const w of S.wf.wires || []) {
    if (w.rel) continue;
    if (!set.has(w.from) || !set.has(w.to)) continue;
    const from = nodeById(w.from);
    if (!from) continue;
    if (wireFromIsControl(w)) {
      if (from.kind !== "wait_file") continue;
    } else if (isControlKind(from)) {
      continue;
    }
    adj[w.from].push(w.to);
    indeg[w.to]++;
  }
  return { list, set, indeg, adj, byId };
}

/* 按数据连线分层（仅用于预览/测试）：同层无依赖则并行。
   实际执行见 runControlRunnableQueue（就绪即启动，避免慢节点挡住无关节点）。 */
function controlRunLayers(nodes) {
  const { list, indeg, adj } = controlRunDepGraph(nodes);
  if (!list.length) return [];
  if (list.length === 1) return [list.slice()];
  const indegLeft = { ...indeg };
  const layers = [];
  const placed = new Set();
  let ready = list.filter((n) => indegLeft[n.id] === 0);
  while (ready.length) {
    const wave = [];
    for (const n of ready) {
      if (placed.has(n.id)) continue;
      placed.add(n.id);
      wave.push(n);
    }
    if (!wave.length) break;
    layers.push(wave);
    const next = [];
    const nextSeen = new Set();
    for (const n of wave) {
      for (const toId of adj[n.id] || []) {
        indegLeft[toId]--;
        if (indegLeft[toId] === 0) {
          const t = list.find((x) => x.id === toId);
          if (t && !placed.has(t.id) && !nextSeen.has(t.id)) {
            nextSeen.add(t.id);
            next.push(t);
          }
        }
      }
    }
    ready = next;
  }
  /* 环路无法分层：每个剩余节点单独一层，串行以免互相读到空输出 */
  for (const n of list) {
    if (!placed.has(n.id)) layers.push([n]);
  }
  return layers;
}

function controlRunOrder(nodes) {
  const order = [];
  for (const wave of controlRunLayers(nodes)) {
    for (const n of wave) order.push(n);
  }
  return order;
}

/**
 * 控制节点执行调度：依赖满足即启动，不设整层屏障。
 * 例如 wait_file 与无关并行分支同属「第 0 层」时，等待文件不会挡住另一支已就绪节点。
 */
async function runControlRunnableQueue(controlNode, runnable, seen, runOne) {
  const exec = runOne || ((n) => runControlledNode(n, seen));
  const { list, indeg, adj, byId } = controlRunDepGraph(runnable);
  if (!list.length) return;
  const scheduledIds = new Set(list.map((n) => n.id));
  const prevScheduled = S._scheduledRunIds;
  S._scheduledRunIds = scheduledIds;
  /* 发车时的全局终止代号：期间只要点过「全部终止」，本批剩余目标一律不启动 */
  const epochAtStart = GLOBAL_STOP_SEQ;
  const stopped = () =>
    (controlNode && runBatchStopped(controlNode)) ||
    GLOBAL_STOP_SEQ !== epochAtStart;
  const runExec = async (n) => {
    try {
      await exec(n);
    } catch {
      /* 单个目标失败不阻断其余节点 */
    }
  };
  try {
    if (list.length === 1) {
      await runExec(list[0]);
      return;
    }
    /* 控制范围内最多同时并行 10 个目标；超出部分等有槽位再启动 */
    const MAX_CONCURRENT = 10;
    const indegLeft = { ...indeg };
    const launched = new Set();
    const queued = [];
    let inFlight = 0;
    let settle = () => {};
    const done = new Promise((r) => {
      settle = r;
    });

    const pump = () => {
      while (inFlight < MAX_CONCURRENT && queued.length) {
        const n = queued.shift();
        if (!n || launched.has(n.id)) continue;
        if (stopped()) continue;
        launch(n);
      }
      if (inFlight === 0 && !queued.length) {
        if (stopped()) {
          queued.length = 0;
          settle();
          return;
        }
        /* 环路残留：串行解开，与旧版分层回退一致 */
        const left = list.find((x) => !launched.has(x.id));
        if (left) {
          indegLeft[left.id] = 0;
          queued.push(left);
          pump();
          return;
        }
        settle();
      }
    };

    const launch = (n) => {
      if (!n || launched.has(n.id)) return;
      if (stopped()) return;
      launched.add(n.id);
      inFlight++;
      Promise.resolve()
        .then(() => {
          if (stopped()) return;
          return exec(n);
        })
        .catch(() => {
          /* 单个目标失败不阻断其余节点 */
        })
        .finally(() => {
          for (const toId of adj[n.id] || []) {
            indegLeft[toId]--;
            if (indegLeft[toId] === 0) queued.push(byId[toId]);
          }
          inFlight--;
          pump();
        });
    };

    for (const n of list) {
      if (indegLeft[n.id] === 0) queued.push(n);
    }
    pump();
    if (inFlight === 0 && !queued.length) {
      const left = list.find((x) => !launched.has(x.id));
      if (left) {
        indegLeft[left.id] = 0;
        queued.push(left);
        pump();
      } else {
        return;
      }
    }
    await done;
  } finally {
    S._scheduledRunIds = prevScheduled;
  }
}

function applyClearOutput(node) {
  if (!node || node.running) return false;
  node.output = null;
  node.batchOutputs = null;
  node.error = null;
  node.ranAt = 0;
  node.attemptOutputs = null;
  node.attemptsDone = 0;
  node.attemptIdx = 0;
  if (node._hBase != null) {
    node.h = node._hBase;
    node._hBase = null;
  }
  resetNodeSession(node);
  if (isSaveNode(node)) {
    node.savedPaths = [];
    node.savedPath = "";
    node.savedAt = 0;
  }
  if (node.kind === "wait_file") {
    node.waitStatus = "";
    node.waitReady = false;
  }
  if (
    (node.kind === "input_text" || node.kind === "input_image") &&
    !node.ro &&
    !inputInherited(node)
  ) {
    node.text = "";
    node.imageAsset = "";
    if (Array.isArray(node.entries)) node.entries = [];
  }
  clearDownstream(node.id);
  return true;
}

async function runControlledNode(n, seen) {
  if (!n || seen.has(n.id)) return;
  if (n.kind === "control") return playControlNode(n, seen);
  seen.add(n.id);
  if (n.kind === "task") return playTaskNode(n, false);
  if (isSaveNode(n))
    return saveNodeAction(n);
  /* 控制类节点：由各自 play 语义执行（计数累加 / 闸门放行 / 互斥选口 / 延时 / 序列 / 分发 / 定时 / 判断） */
  if (n.kind === "timer") return playTimerNode(n, true);
  if (n.kind === "delayer") return playDelayerNode(n, true);
  if (n.kind === "sequencer") return playSequencerNode(n, true);
  if (n.kind === "gate") return playGateNode(n, true);
  if (n.kind === "splitter") return playSplitterNode(n, true);
  if (n.kind === "counter") return playCounterNode(n, true);
  if (n.kind === "mutex") return playMutexNode(n, true);
  if (n.kind === "judge") {
    const yn = await playJudgeNode(n, true);
    if (yn === true || yn === false)
      await fireControlOutgoing(n, yn ? 0 : 1, seen);
    return;
  }
  if (
    n.kind === "proc_text" ||
    n.kind === "proc_image" ||
    n.kind === "agent_task" ||
    isFunctionNode(n) ||
    isToolNode(n) ||
    n.kind === "music_gen" ||
    n.kind === "tts_gen" ||
    n.kind === "video_gen" ||
    n.kind === "remotion" ||
    n.kind === "wait_file" ||
    n.kind === "net_send" ||
    n.kind === "net_recv"
  )
    /* quiet：避免把控制范围内整条链标成「等待」且不级联；ensureUpstream：仍补跑范围外未处理上游 */
    return playNode(n, true, {
      noCascade: true,
      ensureUpstream: true,
      batchDriven: true,
    });
}

async function playControlNode(node, seen) {
  /* 用户直接点控制节点 ▶（没有外层批次）= 重新开始：解除「全部终止」的短窗口拦截 */
  if (!seen) S._lastStopAllAt = 0;
  seen = seen || new Set();
  if (!node || seen.has(node.id)) return;
  seen.add(node.id);
  const targets = controlTargets(node);
  if (!targets.length) {
    toast(I18n.t("未连接任何节点"), "warn");
    return;
  }
  const action = node.ctrlAction === "clear" ? "clear" : "run";
  if (action === "clear") {
    const running = targets.filter((n) => n.running);
    if (running.length) {
      toast(
        I18n.t("请先终止当前运行") +
          "：" +
          I18n.listJoin(running.map((n) => n.title)),
        "warn",
      );
      return;
    }
    pushHistory();
    let nOk = 0;
    for (const t of targets) {
      if (t.kind === "control") continue;
      if (applyClearOutput(t)) nOk++;
    }
    scheduleSave(true);
    renderCanvas();
    renderStatus();
    toast(I18n.t("已清空 ") + nOk + I18n.t(" 个节点"), "ok");
    return;
  }
  const runnable0 = targets.filter(canControlRun);
  if (!runnable0.length) {
    toast(I18n.t("所连接节点无法执行"), "warn");
    return;
  }
  const fillOnly = !!node.ctrlFillOnly;
  const runnable = fillOnly
    ? runnable0.filter((n) => n.kind === "control" || !nodeHasOutputContent(n))
    : runnable0;
  if (!runnable.length) {
    toast(I18n.t("补缺：已连接节点均已有输出，无需执行"), "ok");
    return;
  }
  const running = runnable.filter((n) => n.running && n.kind !== "control");
  if (running.length) {
    toast(
      I18n.t("请先终止当前运行") +
        "：" +
        I18n.listJoin(running.map((n) => n.title)),
      "warn",
    );
    return;
  }
  /* 全量执行：先作废旧输出；补缺模式：只清理将要跑的节点，保留已有结果 */
  invalidateControlRunTargets(runnable);
  node.running = true;
  beginNodeRun(node);
  renderCanvas();
  renderStatus();
  try {
    /* 就绪即启动：有依赖的等上游，无依赖的立刻并行，不被无关慢节点挡住 */
    await runControlRunnableQueue(node, runnable, seen);
    if (fillOnly && !runBatchStopped(node)) {
      const skipped = runnable0.filter(
        (n) => n.kind !== "control" && nodeHasOutputContent(n),
      ).length;
      const ran = runnable.filter((n) => n.kind !== "control").length;
      if (skipped > 0)
        toast(
          I18n.t("补缺完成：执行 ") +
            ran +
            I18n.t(" 个 · 跳过 ") +
            skipped +
            I18n.t(" 个已有输出"),
          "ok",
        );
    }
  } finally {
    node.running = false;
    node._aborted = false;
    /* 控制调度结束：扫掉本批目标上的等待态 */
    clearPendingRun(runnable.map((n) => n && n.id).filter(Boolean));
    renderCanvas();
    renderStatus();
    scheduleSave(true);
  }
}

function stopControlNode(node) {
  if (!node || !node.running) return;
  node._aborted = true;
  for (const t of controlTargets(node)) {
    if (t.running) stopNode(t);
    if (t.kind === "control" && t.running) stopControlNode(t);
  }
  node.running = false;
  renderCanvas();
  renderStatus();
}

/* 清空节点输出：回到无输出内容的状态。
   对会话类节点（智能任务 / 对话 / 智能文本）一并清空历史与工具日志，等同重置该节点会话。 */
function clearOutput(node) {
  if (!node) return;
  if (node.running) {
    toast(I18n.t("请先终止当前运行"), "warn");
    return;
  }
  pushHistory();
  applyClearOutput(node);
  scheduleSave(true);
  renderCanvas();
  renderStatus();
  if (S.view === "agent") renderAgentSession();
}

/* 彻底重置节点会话：消息、思考、工具轨迹、运行指标、关联智能会话内容 */
function resetNodeSession(node) {
  if (!node) return;
  const isSession =
    node.kind === "agent_task" ||
    (node.kind === "proc_text" && node.agent);
  if (isSession) {
    node.messages = [];
    node._pendingAnswer = "";
    delete node._lastTools;
    delete node.dshMetrics;
    delete node.dshTools;
    if (node.kind === "agent_task") {
      node.task = "";
      /* 关联智能会话：清空内容，保留会话 id 与节点绑定（等同会话内「新建」） */
      if (node.agentSessionId) {
        const sess = agentSessions().find((s) => s.id === node.agentSessionId);
        if (sess) {
          sess.messages = [];
          sess._pending = "";
          sess._liveTools = [];
          sess.metrics = null;
          sess.running = false;
          sess.planNext = false;
          sess.updatedAt = Date.now();
          if (node.title) sess.title = node.title;
          persistAgentSession().catch(() => {});
        }
      }
    }
  }
  if (S.thinking && S.thinking[node.id]) S.thinking[node.id] = [];
  if (S.nodeTools) S.nodeTools[node.id] = [];
  if (S.openDshTools) {
    const prefix = node.id + ":";
    for (const k of Object.keys(S.openDshTools)) {
      if (k === node.id || k.indexOf(prefix) === 0 || k.indexOf("dsh-node-tools-" + node.id) === 0)
        delete S.openDshTools[k];
    }
    delete S.openDshTools["dsh-node-tools-" + node.id];
  }
}

/* ============ 输出浏览（大窗对话显示 Output 内容） ============ */

/* 节点输出中的纯文本（批量 = 全部条目拼接；供复制） */
function outputTextOf(node) {
  if (node && node.running && isDshTask(node) && node._pendingAnswer)
    return node._pendingAnswer;
  const r = selResult(node);
  if (!r) return "";
  if (r.error) return r.error;
  if (r.batchOutputs && r.batchOutputs.length)
    return r.batchOutputs
      .map(
        (x) =>
          "──── " + (x.title || I18n.t("条目")) + " ────\n" +
          (x.ok && x.output && x.output.kind === "text"
            ? x.output.text
            : x.error || ""),
      )
      .join("\n\n");
  if (r.output && r.output.kind === "text") return r.output.text;
  return "";
}
function globalSourcePlainText(src) {
  if (!src) return "";
  const head = src.title || nodeKindLabel(src);
  const texts = allTextItems(src);
  if (!texts.length) return "";
  return texts
    .map((it) => {
      const t = it.title && it.title !== src.title ? it.title : head;
      return "──── " + t + " ────\n" + (it.text || "");
    })
    .join("\n\n");
}

function fillGlobalRefDetail(el, src) {
  el.innerHTML = "";
  if (!src) {
    const e = document.createElement("div");
    e.className = "n-empty";
    e.textContent = I18n.t("点击芯片查看内容");
    el.appendChild(e);
    return;
  }
  const head = document.createElement("div");
  head.className = "g-ref-detail-head";
  const t = document.createElement("div");
  t.className = "browse-title";
  t.textContent = (src.title || nodeKindLabel(src)) + " · " + nodeKindLabel(src);
  head.appendChild(t);
  const loc = document.createElement("button");
  loc.type = "button";
  loc.className = "mini";
  loc.textContent = I18n.t("定位");
  loc.title = I18n.t("画布居中定位到：") + (src.title || nodeKindLabel(src));
  loc.onclick = () => {
    closeOverlay();
    focusNode(src.id);
  };
  head.appendChild(loc);
  el.appendChild(head);
  const texts = allTextItems(src);
  const images = allImageItems(src);
  if (!texts.length && !images.length) {
    const empty = document.createElement("div");
    empty.className = "n-empty";
    empty.textContent = I18n.t("（空）");
    el.appendChild(empty);
    return;
  }
  for (const it of texts) {
    if (it.title && it.title !== src.title) {
      const st = document.createElement("div");
      st.className = "browse-title";
      st.textContent = it.title;
      el.appendChild(st);
    }
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = renderMarkdown(it.text || "");
    el.appendChild(md);
  }
  for (const it of images) {
    if (!it.path) continue;
    const img = document.createElement("img");
    img.className = "browse-img";
    img.src = window.api.toFileUrl(it.path);
    bindImagePreview(img, it.path, it.title || src.title || I18n.t("图像"));
    bindImgSaveAs(img);
    el.appendChild(img);
  }
}

function openGlobalTagDialog(gNode) {
  if (!gNode || gNode.kind !== "global") return;
  openOverlay(I18n.t("全局 Tag · ") + (gNode.title || I18n.t("全局")), {
    persistent: true,
  });
  const bodyEl = $("#ovBody");
  const foot = $("#ovFoot");
  const hint = document.createElement("div");
  hint.className = "g-tag-hint";
  hint.textContent = I18n.t(
    "勾选 Tag：仅显示带该标的连入节点，并为当前连入节点打上该标。可添加 / 删除 Tag。",
  );
  bodyEl.appendChild(hint);
  const grid = document.createElement("div");
  grid.className = "g-tag-grid";
  const paint = () => {
    grid.innerHTML = "";
    const cat = wfTagCatalog().slice().sort((a, b) => a.localeCompare(b, "zh"));
    const active = new Set(normalizeGlobalTagFilter(gNode));
    if (!cat.length) {
      const empty = document.createElement("div");
      empty.className = "n-empty";
      empty.textContent = I18n.t("暂无 Tag · 点击下方添加");
      grid.appendChild(empty);
      return;
    }
    for (const tag of cat) {
      const cell = document.createElement("label");
      cell.className = "g-tag-cell" + (active.has(tag) ? " on" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = active.has(tag);
      cb.addEventListener("change", () => {
        pushHistory();
        const list = normalizeGlobalTagFilter(gNode);
        if (cb.checked) {
          if (!list.includes(tag)) list.push(tag);
          gNode.tagFilter = list;
          stampTagsOntoGlobalWired(gNode, [tag]);
        } else {
          gNode.tagFilter = list.filter((x) => x !== tag);
        }
        cell.classList.toggle("on", cb.checked);
        scheduleSave(true);
        refreshNodeEl(gNode.id);
        if (S.sidebarOpen) renderSidebar();
      });
      const name = document.createElement("span");
      name.className = "g-tag-name";
      name.textContent = tag;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "g-tag-del";
      del.textContent = "✕";
      del.title = I18n.t("删除此 Tag（所有节点上的该标一并移除）");
      del.onclick = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const ok = await confirmDialog(
          I18n.t("删除 Tag「{tag}」？已打在节点上的该标也会移除。", { tag }),
          { title: I18n.t("删除 Tag"), danger: true, okText: I18n.t("删除") },
        );
        if (!ok) return;
        pushHistory();
        deleteTagEverywhere(tag);
        scheduleSave(true);
        paint();
        refreshNodeEl(gNode.id);
        if (S.sidebarOpen) renderSidebar();
        renderCanvas();
      };
      cell.appendChild(cb);
      cell.appendChild(name);
      cell.appendChild(del);
      grid.appendChild(cell);
    }
  };
  paint();
  bodyEl.appendChild(grid);
  const addBtn = document.createElement("button");
  addBtn.className = "mini primary";
  addBtn.textContent = I18n.t("＋ 添加 Tag");
  addBtn.onclick = async () => {
    const name = await promptDialog(I18n.t("新 Tag 名称"), "", {
      title: I18n.t("添加 Tag"),
      okText: I18n.t("添加"),
    });
    if (name == null) return;
    const t = normalizeTagName(name);
    if (!t) {
      toast(I18n.t("Tag 名称不能为空"), "warn");
      return;
    }
    pushHistory();
    ensureTagInCatalog(t);
    scheduleSave(true);
    paint();
    if (S.sidebarOpen) renderSidebar();
  };
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = () => {
    closeOverlay();
    refreshNodeEl(gNode.id);
    if (S.sidebarOpen) renderSidebar();
  };
  foot.appendChild(addBtn);
  foot.appendChild(close);
}

function openGlobalRefsDialog(fromNode) {
  const srcs =
    fromNode && fromNode.kind === "global"
      ? globalDisplaySources(fromNode)
      : globalRefSources();
  openOverlay(
    I18n.t("全局参考 · ") +
      ((fromNode && fromNode.title) || I18n.t("全局")),
  );
  const box = $("#overlay .overlay-box");
  if (box) {
    box.classList.add("wide");
    box.classList.add("g-ref-wide");
  }
  const bodyEl = $("#ovBody");
  bodyEl.classList.add("g-ref-ov");
  const shell = document.createElement("div");
  shell.className = "g-ref-dlg";
  const side = document.createElement("div");
  side.className = "g-ref-side";
  const detail = document.createElement("div");
  detail.className = "g-ref-detail";
  let selected = null;
  const paintSel = (src) => {
    selected = src;
    side.querySelectorAll(".g-chip").forEach((b) => {
      b.classList.toggle("sel", !!(src && b.dataset.nid === src.id));
    });
    fillGlobalRefDetail(detail, src);
  };
  if (!srcs.length) {
    const e = document.createElement("div");
    e.className = "n-empty";
    e.textContent =
      fromNode &&
      fromNode.kind === "global" &&
      normalizeGlobalTagFilter(fromNode).length
        ? I18n.t("无匹配该 Tag 的连入节点")
        : I18n.t("（无连入）");
    side.appendChild(e);
    fillGlobalRefDetail(detail, null);
  } else {
    for (const src of srcs) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "g-chip kind-" + globalChipKindCls(src);
      chip.dataset.nid = src.id;
      chip.textContent = src.title || nodeKindLabel(src);
      chip.title = src.title || nodeKindLabel(src);
      chip.onclick = () => paintSel(src);
      side.appendChild(chip);
    }
    paintSel(srcs[0]);
  }
  shell.appendChild(side);
  shell.appendChild(detail);
  bodyEl.appendChild(shell);
  const foot = $("#ovFoot");
  const copyBtn = document.createElement("button");
  copyBtn.className = "mini primary";
  copyBtn.textContent = I18n.t("复制文本");
  copyBtn.title = I18n.t("复制当前连入文本");
  copyBtn.onclick = () => {
    const txt = globalSourcePlainText(selected);
    if (!txt) {
      toast(I18n.t("无可复制的文本（输出为图像）"), "warn");
      return;
    }
    navigator.clipboard.writeText(txt).then(() => toast(I18n.t("已复制"), "ok"));
  };
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  foot.appendChild(copyBtn);
  foot.appendChild(close);
}

/* 弹窗大窗显示节点输出（文本 / 图像 / 批量 / 错误） */
function browseOutput(node) {
  const r = selResult(node);
  const liveTxt =
    node.running && isDshTask(node) ? node._pendingAnswer || "" : "";
  if ((!r || (!r.output && !r.batchOutputs && !r.error)) && !liveTxt) {
    toast(I18n.t("该节点暂无输出"), "warn");
    return;
  }
  openOverlay(I18n.t("输出浏览 · ") + (node.title || ""));
  const box = $("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const bodyEl = $("#ovBody");
  const content = document.createElement("div");
  content.className = "browse-body";
  if (liveTxt) {
    const md = document.createElement("div");
    md.className = "md";
    md.textContent = liveTxt;
    content.appendChild(md);
  } else if (r && r.error) {
    const e = document.createElement("div");
    e.className = "n-status err";
    e.textContent = "✕ " + r.error;
    content.appendChild(e);
  } else if (r && r.batchOutputs && r.batchOutputs.length) {
    for (const x of r.batchOutputs) {
      const row = document.createElement("div");
      row.className = "browse-row";
      const t = document.createElement("div");
      t.className = "browse-title";
      t.textContent = x.title || I18n.t("条目");
      row.appendChild(t);
      if (x.ok && x.output) {
        if (x.output.kind === "text") {
          const md = document.createElement("div");
          md.className = "md";
          md.innerHTML = renderMarkdown(x.output.text);
          row.appendChild(md);
        } else {
          const img = document.createElement("img");
          img.className = "browse-img" + (node.bgRmOn ? " bg-rm-preview" : "");
          img.src = window.api.toFileUrl(x.output.path);
          bindImagePreview(img, x.output.path, x.title || I18n.t("输出图像"));
          bindImgSaveAs(img);
          row.appendChild(img);
        }
      } else if (x.error) {
        const e = document.createElement("div");
        e.className = "n-status err";
        e.textContent = "✕ " + x.error;
        row.appendChild(e);
      }
      content.appendChild(row);
    }
  } else if (r && r.output) {
    if (r.output.kind === "text") {
      const md = document.createElement("div");
      md.className = "md";
      md.innerHTML = renderMarkdown(r.output.text);
      content.appendChild(md);
    } else {
      const img = document.createElement("img");
      img.className = "browse-img" + (node.bgRmOn ? " bg-rm-preview" : "");
      img.src = window.api.toFileUrl(r.output.path);
      bindImagePreview(
        img,
        r.output.path,
        node.title || I18n.t("输出图像"),
      );
      bindImgSaveAs(img);
      content.appendChild(img);
    }
  } else {
    const e = document.createElement("div");
    e.className = "n-empty";
    e.textContent = I18n.t("（无输出内容）");
    content.appendChild(e);
  }
  bodyEl.appendChild(content);
  const foot = $("#ovFoot");
  const copyBtn = document.createElement("button");
  copyBtn.className = "mini primary";
  copyBtn.textContent = I18n.t("复制文本");
  copyBtn.title = I18n.t("复制输出中的全部文本");
  copyBtn.onclick = () => {
    const txt = outputTextOf(node);
    if (!txt) {
      toast(I18n.t("无可复制的文本（输出为图像）"), "warn");
      return;
    }
    navigator.clipboard.writeText(txt).then(() => toast(I18n.t("已复制"), "ok"));
  };
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  foot.appendChild(copyBtn);
  foot.appendChild(close);
}

/* 局部刷新派生显示节点（拆分/合并的内容随输入实时变化） */
function refreshNodeEl(id) {
  const old = document.querySelector('.wf-node[data-nid="' + id + '"]');
  const n = nodeById(id);
  if (!old || !n) return;
  const el = nodeElement(n);
  old.replaceWith(el);
  if (fitNodeChrome(el, n)) refreshPorts(el, n);
  updateWires();
  fillPreviews();
}
function refreshDerived() {
  for (const n of S.wf.nodes) {
    if (n.kind === "split" || n.kind === "merge" || n.kind === "global")
      refreshNodeEl(n.id);
  }
}

/* ============ 连线 ============ */

/*
 * 超级节点「外框端子」与「内框端子」等价，只作内外衔接隧道：
 *   外侧输入 i  ≡ 内侧桥接输出 i（外部 → 内部）
 *   内侧汇流输入 j ≡ 外侧输出 j（内部 → 外部）
 * 回路检测必须按穿透后的逻辑边，不能把超级节点宿主当成普通图顶点，
 * 否则「外→超→内」与「内→超→外」会被误判成回路。
 */
function logicalDataEdgesFromWire(w, wf) {
  wf = wf || S.wf;
  const edges = [];
  const add = (a, b) => {
    if (a && b && a !== b) edges.push([a, b]);
  };
  if (!w) return edges;
  /* 关系线（UML 风格）不进入数据 / 控制拓扑 */
  if (w.rel) return edges;
  const from = nodeByIdIn(w.from, wf);
  const to = nodeByIdIn(w.to, wf);
  if (!from || !to) return edges;
  /* 控制线不进入数据拓扑（脉冲隧穿由 pulseExecOutgoing 单独处理） */
  if (wireFromIsControl(w, wf)) {
    add(w.from, w.to);
    return edges;
  }
  const fi = Number(w.fromIndex || 0);
  const ti = Number(w.toIndex || 0);
  /* 超 → 内部：内侧输入桥接 */
  if (from.kind === "super" && nodeParentSuperId(to) === from.id) {
    for (const x of superExternalInWires(from, wf)) {
      if (Number(x.toIndex) === fi) add(x.from, w.to);
    }
    return edges;
  }
  /* 内部 → 超：内侧输出汇流 */
  if (to.kind === "super" && nodeParentSuperId(from) === to.id) {
    for (const x of superExternalOutWires(to, wf)) {
      if (Number(x.fromIndex || 0) === ti) add(w.from, x.to);
    }
    return edges;
  }
  /* 外部 → 超：外侧输入 */
  if (to.kind === "super" && nodeParentSuperId(from) !== to.id) {
    for (const x of superInternalBridgeWires(to, wf)) {
      if (Number(x.fromIndex || 0) === ti) add(w.from, x.to);
    }
    return edges;
  }
  /* 超 → 外部：外侧输出 */
  if (from.kind === "super" && nodeParentSuperId(to) !== from.id) {
    for (const x of superInternalOutFeeds(from, wf)) {
      if (Number(x.toIndex) === fi) add(x.from, w.to);
    }
    return edges;
  }
  add(w.from, w.to);
  return edges;
}

function buildLogicalWireAdj(wires, extraEdges) {
  const adj = {};
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    const list = adj[a] || (adj[a] = []);
    if (list.indexOf(b) < 0) list.push(b);
  };
  for (const w of wires || []) {
    for (const e of logicalDataEdgesFromWire(w)) add(e[0], e[1]);
  }
  for (const e of extraEdges || []) add(e[0], e[1]);
  return adj;
}

function reachableInAdj(adj, start, goal) {
  if (!start || !goal) return false;
  if (start === goal) return true;
  const q = [start];
  const seen = new Set(q);
  while (q.length) {
    const n = q.pop();
    for (const m of adj[n] || []) {
      if (m === goal) return true;
      if (!seen.has(m)) {
        seen.add(m);
        q.push(m);
      }
    }
  }
  return false;
}

function wouldCycle(fromId, toId, toIndex, fromIndex) {
  if (!fromId || !toId) return false;
  if (fromId === toId) return true;
  const proposed = logicalDataEdgesFromWire({
    from: fromId,
    to: toId,
    fromIndex: fromIndex || 0,
    toIndex: toIndex == null ? 0 : toIndex,
  });
  /* 超级节点仅单侧挂线时，尚无穿透逻辑边，不构成回路 */
  if (!proposed.length) return false;
  const adj = buildLogicalWireAdj((S.wf && S.wf.wires) || []);
  for (const e of proposed) {
    if (reachableInAdj(adj, e[1], e[0])) return true;
  }
  return false;
}

/* ── 连线校验用的「端子级」媒体类型判定（单一真源在 app.js · wireSourceMediaType）──
   工具 / 函数节点没有「图像类 kind」可看：整节点既算文本来源又不算图像来源，
   一视同仁会把它的图像端子当成文本线放行进纯文本目标、又拦在图像目标外。
   所以这两类节点一律按「真正接出来的那个端子」的声明类型判定；
   其余节点仍按节点 kind 判定（行为逐字不变）。 */
function wireActsAsImage(from, fi) {
  if (!from) return false;
  /* 素材节点：整节点没有单一媒体类型可看 —— 只有条目端子说得出这条线是不是图像 */
  if (isFnToolNode(from) || isAssetNode(from))
    return wireSourceMediaType(from, fi) === "image";
  return isImageSource(from);
}
function wireActsAsText(from, fi) {
  if (!from) return false;
  if (isFnToolNode(from) || isAssetNode(from))
    return wireSourceMediaType(from, fi) === "text";
  return isTextSource(from);
}

/* 输入端子是否为「数组（批量）参数」端子：值是一串而不是一个 → 同一个端子可挂多条数据线。
   数组标记的判定唯一真源在 app-canvas.js · fnBrowseParamIsArray（array / arr / list /
   batch / repeat 任一为真，或 kind 含 array|list），这里只按端子号取条目，别处不再各写一套。 */
function fnToolInPortIsArray(host, idx) {
  if (!host || !isFnToolNode(host)) return false;
  const e = fnToolParamList(host, "in")[Number(idx) - 1];
  if (!e) return false;
  return typeof fnBrowseParamIsArray === "function"
    ? !!fnBrowseParamIsArray(e)
    : false;
}

/* 工具 / 函数节点：按源端子的媒体类型挑一个输入参数端子。
   want = "image" | "text"（参数 kind 只有这两类，音视频线按文本路径处理）；
   先挑「类型匹配且空闲」的普通端子，挑不到再落到「类型匹配」的数组端子 ——
   数组端子可挂多条线，已挂线也算可用（只有函数节点真能按端子聚合多条线，
   工具节点的外侧输入仍是一号一值，已挂线的数组端子不再落）。
   两类都挑不到返回 null → 由调用方给出「去哪儿改」的类型错误，而不是静默占错端子。 */
function fnToolFreePortForMedia(host, want) {
  const n = fnToolParamList(host, "in").length;
  const kindOf = (i) => (fnToolPortKind(host, "in", i) || "text") === want;
  for (let i = 1; i <= n; i++) {
    if (fnToolInPortIsArray(host, i)) continue;
    if (fnToolInPortOccupied(host, i)) continue;
    if (kindOf(i)) return i;
  }
  for (let i = 1; i <= n; i++) {
    if (!fnToolInPortIsArray(host, i)) continue;
    if (fnToolInPortOccupied(host, i) && !isFunctionNode(host)) continue;
    if (kindOf(i)) return i;
  }
  return null;
}

/* 这条数据线在「参数端子」眼里的类型：图像线 → image，其余（文本 / 音视频文件路径）→ text。
   媒体类型仍取单一真源 wireSourceMediaType（端子声明优先，其次节点 kind 与该端子实际值），
   所以连普通超级节点真正汇出来的图像也能对上图像端子，不必只认图像类 kind。 */
function wireParamKind(from, fi) {
  return wireSourceMediaType(from, fi) === "image" ? "image" : "text";
}

/* 一条线在工具 / 函数节点上「实际会落到哪个输入端子」（校验与落点的唯一真源）：
   指定了端子就用它；未指定（拖到节点身上 / 跨级连接 / agent connect）时，
   数据线优先按 fnToolFreePortForMedia 的口径落点 —— 类型匹配且空闲的普通端子优先，
   挑不到落到类型匹配的数组端子（函数节点上已挂线也算可用），
   再挑不到才退回任意空闲端子 ——
   好让类型校验点名「哪个端子是什么类型、去哪儿改」，而不是把图像线悄悄塞进文本端子。 */
function fnToolInPortIndex(host, from, fi, toIndex, fromCtrl) {
  if (toIndex != null) return Number(toIndex);
  if (fromCtrl) return fnToolFreePortIndex(host, "in", true);
  const byKind = fnToolFreePortForMedia(host, wireParamKind(from, fi));
  return byKind != null ? byKind : fnToolFreePortIndex(host, "in", false);
}

/** 工具 / 函数节点「输入参数端子」的类型匹配校验：
    端子声明的 kind（text | image）就是这条数据线的准入类型 ——
    图像线只能进图像端子，文本线（含音视频文件路径）只能进文本端子。
    返回 null = 放行（控制端子 / 越界 / 无端子级声明一律交回既有规则处理）。
    错误文案点名参数与去处：改接来源节点的哪个端子，或在本节点的「设置」里改参数类型。 */
function fnToolInPortTypeError(host, idx, from, fi) {
  const want = fnToolPortKind(host, "in", idx);
  if (!want) return null;
  const got = wireParamKind(from, fi);
  if (got === want) return null;
  const e = fnToolParamList(host, "in")[Number(idx) - 1];
  const pname = String((e && e.name) || "").trim() || I18n.t("参数 ") + Number(idx);
  const where = isFunctionNode(host)
    ? I18n.t("该函数节点的「设置」")
    : I18n.t("该工具节点的「设置」");
  return want === "image"
    ? I18n.t("「{p}」是图像参数，只接受图像来源：请把来源节点的图像输出端子连到它，或在{n}里把「{p}」改成文本参数", {
        p: pname,
        n: where,
      })
    : I18n.t("「{p}」是文本参数，不接受图像来源：请在{n}里把「{p}」改成图像参数，或改接来源节点的文本输出端子", {
        p: pname,
        n: where,
      });
}

function connectError(fromId, toId, toIndex, fromIndex) {
  const from = nodeById(fromId),
    to = nodeById(toId);
  if (!from || !to) return I18n.t("节点不存在");
  if (from.kind === "super" && nodeParentSuperId(to) === from.id) {
    const fi = Number(fromIndex || 0);
    if (fi < 0 || fi >= Math.max(1, inputCount(from)))
      return I18n.t("无效的输入端子");
    if (fromId === toId || wouldCycle(fromId, toId, toIndex, fromIndex))
      return I18n.t("不能连接成回路");
    return null;
  }
  if (to.kind === "super" && nodeParentSuperId(from) === to.id) {
    const ti = toIndex == null ? 0 : Number(toIndex);
    if (ti < 0 || ti >= Math.max(1, outputCount(to)))
      return I18n.t("无效的输出端子");
    if (fromId === toId || wouldCycle(fromId, toId, toIndex, fromIndex))
      return I18n.t("不能连接成回路");
    return null;
  }
  const fromSuper = nodeParentSuperId(from);
  const toSuper = nodeParentSuperId(to);
  if (fromSuper !== toSuper) {
    return I18n.t("超级节点内外不能直接连线，请经内侧端子桥接");
  }
  if (!hasOutput(from)) return I18n.t("该节点没有输出端子");
  const fi = Number(fromIndex || 0);
  if (fi < 0 || fi >= outputCount(from)) return I18n.t("该节点没有输出端子");
  if (
    to.kind === "wait_file" ||
    to.kind === "timer" ||
    to.ro
  )
    return I18n.t("该节点不接受输入");
  if (inputCount(to) === 0) return I18n.t("该节点不接受输入");
  const fromCtrl = isControlKind(from);
  if (to.kind === "global" && (fromCtrl || !isRefableSource(from)))
    return I18n.t("全局节点仅接受文本或图像来源");
  if (fromId === toId || wouldCycle(fromId, toId, toIndex, fromIndex))
    return I18n.t("不能连接成回路");
  if (
    S.wf.wires.some(
      (w) =>
        !w.rel &&
        w.from === fromId &&
        w.to === toId &&
        Number(w.fromIndex || 0) === fi,
    )
  )
    return I18n.t("这两节点已连接");
  if (to.kind === "task") {
    if (!fromCtrl) return I18n.t("任务节点仅接受控制信号（不接内容连线）");
    if (S.wf.wires.some((w) => !w.rel && w.to === toId))
      return I18n.t("任务控制输入端子已被占用");
  }
  if (from.kind === "task") {
    if (fi !== 0 && fi !== 1) return I18n.t("任务节点仅有成功 / 失败控制输出");
  }
  if (!fromCtrl && isSaveNode(to)) {
    const incoming = saveDataSources(to);
    /* 端口感知：工具 / 函数节点按真正接出来的那个端子判定媒体（图像端子 → 图像保存），
       其余节点仍只看 0 号端子（inferMediaFromSource 内部同口径）。 */
    const media = wireSourceMediaType(from, fi);
    if (incoming.length) {
      const em = saveMediaKind(to);
      if (em === "image" || em === "audio" || em === "video") {
        return I18n.t("图像 / 音频 / 视频保存仅接受 1 个输入");
      } else if (media !== "text") {
        return I18n.t("该保存节点当前按文本保存，不能混接媒体");
      }
    } else if (media !== "image" && saveMediaKind(to) === "image") {
      /* 节点已按图像定型（旧「图像保存」节点 / .png 路径）却还没有来源：
         文本端子连进来不能静默把扩展名改回 .yaml，必须点名去哪儿改。 */
      return I18n.t("该保存节点按图像保存，只接受图像端子：请改接图像来源，或把保存路径改成 .yaml 用文本保存");
    }
    if (
      media === "image" &&
      !wireActsAsImage(from, fi) &&
      from.kind !== "split" &&
      from.kind !== "merge"
    )
      return I18n.t("图像保存需要图像来源");
  } else if (!fromCtrl && to.kind === "split") {
    if (wiresTo(toId).length) return I18n.t("拆分节点仅接受 1 个输入");
  } else if (!fromCtrl && to.kind === "music_gen") {
    if (!wireActsAsText(from, fi))
      return I18n.t("音乐生成节点需要文本来源（提示词 / 歌词）");
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && (slot < 0 || slot > 1)) return I18n.t("无效的输入端子");
    if (slot != null) {
      if (
        S.wf.wires.some((w) => !w.rel && w.to === toId && Number(w.toIndex) === slot && !wireFromIsControl(w))
      )
        return I18n.t("该输入端子已被占用");
    } else if (nextFreeMediaDataSlot(to, from, fi) == null) {
      return I18n.t("该输入端子已被占用");
    }
  } else if (fromCtrl && to.kind === "music_gen") {
    /* 控制线：仅允许连到控制输入端子（端口2）；未指定端子时自动落到控制输入 */
    const ctrlSlot = 2;
    const slot = toIndex == null ? ctrlSlot : Number(toIndex);
    if (slot !== ctrlSlot) return I18n.t("音乐生成节点控制输入端子为端口 2");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === ctrlSlot && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  } else if (!fromCtrl && to.kind === "tts_gen") {
    /* SoVITS 语音：端口0=待合成文本（仅接受文本来源）· 端口1=控制输入 */
    if (!wireActsAsText(from, fi))
      return I18n.t("语音生成节点需要文本来源（待合成文本）");
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && slot !== 0) return I18n.t("无效的输入端子");
    if (slot != null) {
      if (
        S.wf.wires.some(
          (w) => !w.rel && w.to === toId && Number(w.toIndex) === 0 && !wireFromIsControl(w),
        )
      )
        return I18n.t("该输入端子已被占用");
    } else if (nextFreeMediaDataSlot(to, from, fi) == null) {
      return I18n.t("该输入端子已被占用");
    }
  } else if (fromCtrl && to.kind === "tts_gen") {
    /* 控制线：仅允许连到控制输入端子（端口1）；未指定端子时自动落到控制输入 */
    const ctrlSlot = 1;
    const slot = toIndex == null ? ctrlSlot : Number(toIndex);
    if (slot !== ctrlSlot) return I18n.t("语音生成节点控制输入端子为端口 1");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === ctrlSlot && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  } else if (!fromCtrl && to.kind === "video_gen") {
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && (slot < 1 || slot > videoGenInputCount(to))) return I18n.t("无效的输入端子");
    if (slot == null) {
      if (nextFreeMediaDataSlot(to, from, fi) == null) return I18n.t("该输入端子已被占用");
    } else if (S.wf.wires.some((w) => !w.rel && w.to === toId && Number(w.toIndex) === slot && !wireFromIsControl(w)))
      return I18n.t("该输入端子已被占用");
    if (slot != null) {
      const meta = videoGenSlotMeta(to, slot);
      if (meta.kind === "text") {
        if (!wireActsAsText(from, fi)) return I18n.t("提示词端子需要文本来源");
      } else if (meta.kind === "image") {
        if (!wireActsAsImage(from, fi)) return I18n.t("图像端子需要图像来源");
      } else {
        /* video/audio: accept text path or image source carrying a file path */
        if (!wireActsAsText(from, fi) && !wireActsAsImage(from, fi))
          return I18n.t("音视频端子需要文本路径或媒体文件路径");
      }
    } else {
      /* 自动分配：无法预知槽位类型；文本/图像源都可接受（提示词槽优先文本，参考槽优先媒体路径） */
      if (!wireActsAsText(from, fi) && !wireActsAsImage(from, fi))
        return I18n.t("视频节点需要文本或图像来源");
    }
  } else if (fromCtrl && to.kind === "video_gen") {
    /* 控制线：固定连到控制输入端子（端口0，不随数据槽数变化） */
    const slot = toIndex == null ? 0 : Number(toIndex);
    if (slot !== 0) return I18n.t("视频节点控制输入端子为端口 0");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === 0 && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  } else if (!fromCtrl && to.kind === "remotion") {
    /* Remotion：端口1=描述文本输入（固定），仅接受文本来源 */
    const slot = toIndex == null ? 1 : Number(toIndex);
    if (slot !== 1) return I18n.t("Remotion 描述文本输入端子为端口 1");
    if (!wireActsAsText(from, fi)) return I18n.t("Remotion 描述端子需要文本来源");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === 1 && !wireFromIsControl(w),
      )
    )
      return I18n.t("该输入端子已被占用");
  } else if (fromCtrl && to.kind === "remotion") {
    /* 控制线：固定连到控制输入端子（端口0） */
    const slot = toIndex == null ? 0 : Number(toIndex);
    if (slot !== 0) return I18n.t("Remotion 控制输入端子为端口 0");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === 0 && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  }
  /* 超级节点：外侧输入与内侧汇流共用 to=host，占用检测只看外侧输入（含控制线） */
  if (to.kind === "super") {
    const toolFixed = isToolNode(to);
    let ti = toIndex == null ? 0 : Number(toIndex);
    if (ti < 0 || ti >= Math.max(1, inputCount(to)))
      return I18n.t("无效的输入端子");
    /* 工具节点（super + tool:true）：端子以参数为准 → 端口 0 只收控制线，
       1..N 是参数端子、只收数据线（控制信号不占参数端子，否则取数通道被堵死）。
       未指定端子（拖线自动落点 / 跨级连接 / agent connect）→ 先按参数挑一个空闲端子：
       超级节点那套「顺延已挂线条数」会把内侧汇流也算进去，参数端子会被错占或越界。 */
    if (toolFixed && toIndex == null) {
      /* 未指定端子 → 与 addWire 的落点同一套规则（优先同类型的空闲参数端子） */
      const free = fnToolInPortIndex(to, from, fi, null, fromCtrl);
      if (free == null)
        return fromCtrl
          ? I18n.t("控制输入端子已被占用")
          : I18n.t("没有空闲的输入参数端子");
      ti = free;
    }
    if (toolFixed) {
      if (fromCtrl && ti !== 0)
        return I18n.t("控制信号只能连到控制输入端子（端口 0）");
      if (!fromCtrl && ti === 0)
        return I18n.t("端口 0 是控制输入端子（不接受数据连线）");
    }
    if (superExternalInWiresAll(to).some((w) => Number(w.toIndex) === ti))
      return I18n.t("该输入端子已被占用");
    /* 工具节点：参数即端子 → 端子声明的类型（text | image）决定这条数据线能不能进 */
    if (toolFixed && !fromCtrl) {
      const kindErr = fnToolInPortTypeError(to, ti, from, fi);
      if (kindErr) return kindErr;
    }
    return null;
  }
  /* 函数节点：端子同样由参数钉死（输入 0=控制 · 1..N=参数），占用与类型都按端子判定 ——
     独立分支，绝不落到文末那条「按 allWiresTo().length 顺延」的通用占用判定
     （那条对固定端子节点本就失真：内侧汇流 / 数组端子同号多条线都会算错）。
     · 数组（批量）参数端子：可挂多条数据线 → 放行；
     · 普通参数端子：仍报「该输入端子已被占用」；
     · 控制线只走端口 0，不占参数端子，与本分支无关（行为逐字不变）。
     类型匹配校验与工具节点共用 fnToolInPortTypeError。 */
  if (isFunctionNode(to)) {
    if (fromCtrl) return null;
    const nIn = fnToolParamList(to, "in").length;
    const ti = fnToolInPortIndex(to, from, fi, toIndex, false);
    if (ti == null) return I18n.t("没有空闲的输入参数端子");
    if (Number(ti) === 0)
      return I18n.t("端口 0 是控制输入端子（不接受数据连线）");
    if (Number(ti) < 0 || Number(ti) > nIn) return I18n.t("无效的输入端子");
    if (
      fnToolInPortOccupied(to, ti) &&
      !fnToolInPortIsArray(to, ti)
    )
      return I18n.t("该输入端子已被占用");
    const kindErr = fnToolInPortTypeError(to, ti, from, fi);
    if (kindErr) return kindErr;
    return null;
  }
  /* 素材节点：端子 = 素材库里的内容条目（第 i 入 ↔ 第 i 出，端子号即条目序号）。
     · 一个条目最多挂一条数据线（条目不是数组端子）；
     · 这条线的媒体类型必须与条目类型一致 —— 落盘按类型定扩展名，混填等于把散文写进 .wav；
     · 控制线一律挡在门外：素材是纯内容源，与 input_* 同族，不参与控制流。
     与文末那条「按已挂线条数顺延占用」的通用判定互斥（那条对固定端子本就失真）。 */
  if (isAssetNode(to)) {
    const items = assetItems(to);
    if (fromCtrl)
      return I18n.t("素材节点是内容来源，不接受控制连线（▶ 请连真正要执行的节点）");
    if (!items.length)
      return I18n.t("该素材还没有内容条目：请先在素材库为它添加内容");
    const ti =
      toIndex == null ? assetFreeInPortIndex(to, from, fi) : Number(toIndex);
    if (ti == null) return I18n.t("没有与这条线类型匹配的空闲内容端子");
    if (ti < 0 || ti >= items.length) return I18n.t("无效的输入端子");
    if (assetInPortOccupied(to, ti)) return I18n.t("该内容端子已被占用");
    const want = items[ti].type;
    const got = wireSourceMediaType(from, fi);
    if (!assetPortAccepts(want, got))
      return I18n.t(
        "「{t}」端子是{w}内容，只接受{w}来源（当前是 {g}）：请改接同类来源，或在素材设置里换一个端子",
        {
          t: items[ti].title,
          w: assetItemTypeLabel(want),
          g: assetItemTypeLabel(got),
        },
      );
    return null;
  }
  const cur = allWiresTo(toId).length;
  if (
    to.kind !== "music_gen" &&
    to.kind !== "tts_gen" &&
    to.kind !== "video_gen" &&
    toIndex != null &&
    toIndex < cur
  )
    return I18n.t("该输入端子已被占用");
  return null;
}

/* 视频 / 音乐节点：找下一个空闲数据槽（跳过控制槽与已占槽）；无则 null。
   from 存在时按来源类型优先匹配：文本源 → 提示词槽；图像源 → 参考图槽。
   fromIndex：来源真正接出来的那个端子 —— 工具 / 函数节点必须按端子判定类型，
   其余节点仍只看 0 号端子（wireActsAsText / wireActsAsImage 内部同口径）。
   video_gen：端口0 为控制输入（固定），数据槽从端口1 开始。 */
function nextFreeMediaDataSlot(node, from, fromIndex) {
  if (!node || !S.wf) return null;
  const occupied = (i) =>
    (S.wf.wires || []).some(
      (w) => !w.rel && w.to === node.id && Number(w.toIndex) === i && !wireFromIsControl(w),
    );
  if (node.kind === "music_gen") {
    for (let i = 0; i < 2; i++) if (!occupied(i)) return i;
    return null;
  }
  if (node.kind === "tts_gen") {
    /* 端口0=待合成文本（唯一数据槽）· 端口1=控制输入；数据线只落端口0 */
    if (!occupied(0)) return 0;
    return null;
  }
  if (node.kind === "remotion") {
    /* 端口0=控制输入（固定）· 端口1=描述文本输入；数据线只落端口1 */
    if (!occupied(1)) return 1;
    return null;
  }
  if (node.kind !== "video_gen") return null;
  const fromImg = wireActsAsImage(from, fromIndex);
  const fromTxt = wireActsAsText(from, fromIndex);
  /* 图像源：优先参考图槽（提示词槽只接受文本） */
  if (fromImg) {
    for (let i = 2; i <= videoGenInputCount(node); i++) {
      if (occupied(i)) continue;
      const meta = videoGenSlotMeta(node, i);
      if (meta.kind === "image") return i;
    }
    /* 无空闲参考图槽时回退任意空闲数据槽 */
    for (let i = 2; i <= videoGenInputCount(node); i++)
      if (!occupied(i)) return i;
    return null;
  }
  /* 文本源：优先提示词槽（端口1），其次任意空闲数据槽（video/audio 槽也接受文本路径） */
  if (!occupied(1)) return 1;
  for (let i = 2; i <= videoGenInputCount(node); i++)
    if (!occupied(i)) return i;
  return null;
}

function addWire(fromId, toId, toIndex, opts) {
  opts = opts || {};
  const cur = allWiresTo(toId).length;
  let idx = toIndex == null ? cur : toIndex;
  const toN = nodeById(toId);
  const fromN = nodeById(fromId);
  const fromIdx = Number(opts.fromIndex || 0);
  if (toIndex == null && toN && (toN.kind === "video_gen" || toN.kind === "music_gen" || toN.kind === "tts_gen" || toN.kind === "remotion")) {
    if (fromN && isControlKind(fromN)) {
      /* 控制线：video_gen/remotion 固定落到端口0（控制输入）；music_gen 落到端口2；tts_gen 落到端口1 */
      idx = toN.kind === "music_gen" ? 2 : toN.kind === "tts_gen" ? 1 : 0;
    } else {
      /* 数据线：落到空闲数据槽（跳过控制槽），避免误占控制端子。
         来源是工具 / 函数节点时按它真正接出来的那个端子挑槽（图像端子 → 参考图槽）。 */
      const free = nextFreeMediaDataSlot(toN, fromN, fromIdx);
      if (free != null) idx = free;
    }
  }
  /* 工具 / 函数节点：端子数由参数钉死（输入 0=控制 · 1..N=参数；输出 0..M-1=参数 · 末位=控制），
     不能像超级节点那样「按已挂线条数」顺延 → 未指定端子时走 fnToolInPortIndex 这一套落点
     （与 connectError 校验的端子必须是同一个）：类型匹配且空闲的普通端子优先，
     挑不到落到类型匹配的数组端子（函数节点上同号已挂线也照挂），再挑不到才是任意空闲端子。
     from 若是本节点的内部子节点，这条线是「内侧汇流」→ 找的是输出端子。 */
  if (toIndex == null && toN && isFnToolNode(toN)) {
    const innerSide = !!(fromN && nodeParentSuperId(fromN) === toN.id);
    const wantCtrl = !!(fromN && isControlKind(fromN));
    /* 内侧汇流（子节点 → 宿主）落的是输出端子，仍按参数顺序找空闲输出；
       外侧数据线走 fnToolInPortIndex —— 与 connectError 校验的端子必须是同一个。 */
    const free = innerSide
      ? fnToolFreePortIndex(toN, "out", wantCtrl)
      : fnToolInPortIndex(toN, fromN, fromIdx, null, wantCtrl);
    if (free != null) idx = free;
  }
  /* 素材节点：端子号 = 内容条目序号（第 i 入 ↔ 第 i 出），同样不能「按已挂线条数」顺延
     —— 那会把图像线落到文本条目上、并把整排端子号错位。未指定端子时走
     assetFreeInPortIndex：与 connectError 校验的必须是同一个端子。 */
  if (toIndex == null && toN && isAssetNode(toN)) {
    const free = assetFreeInPortIndex(toN, fromN, fromIdx);
    if (free != null) idx = free;
  }
  S.wf.wires.push({
    id: uid("w"),
    from: fromId,
    to: toId,
    toIndex: idx,
    fromIndex: fromIdx,
    pinned: !!opts.pinned,
  });
  if (!isControlKind(nodeById(fromId))) clearDownstream(toId);
  /* 文本处理节点接到图像：自动切到视觉服务商/模型 */
  const to = nodeById(toId);
  const from = nodeById(fromId);
  if (
    to &&
    to.kind === "proc_text" &&
    !to.agent &&
    from &&
    (from.kind === "input_image" || from.kind === "proc_image")
  ) {
    ensureProcTextVision(to, opts || { notify: false, save: false });
  }
  /* 输出节点连到保存节点：自动开启保存，上游更新时落盘，无需再点 ▶。
     扩展名沿用既有 applySavePathExt —— 它经 saveMediaKind 按「真正接出来的那个端子」
     判定媒体（工具 / 函数节点的图像端子 → 自动 .png）。 */
  if (
    to &&
    (isSaveNode(to)) &&
    from &&
    !isControlKind(from)
  ) {
    to.auto = true;
    applySavePathExt(to);
  }
  if (to && to.kind === "global" && from && !isControlKind(from)) {
    const filters = normalizeGlobalTagFilter(to);
    if (filters.length) stampTagsOntoGlobalWired(to, filters);
  }
}

/* ============ 关系线（rel）：仅表示模块/元素间关系，不参与数据流 ============ */
function relConnectError(fromId, toId) {
  const from = nodeById(fromId),
    to = nodeById(toId);
  if (!from || !to) return I18n.t("节点不存在");
  if (fromId === toId) return I18n.t("不能把关系线连到自身");
  /* 允许同一层级互连，或父超级节点 ↔ 直属子元素（包含关系） */
  const fs = nodeParentSuperId(from),
    ts = nodeParentSuperId(to);
  if (fs !== ts && fs !== toId && ts !== fromId) {
    return I18n.t("关系线仅支持同一层级或直属父子的元素之间");
  }
  if (
    (S.wf.wires || []).some(
      (w) =>
        w.rel &&
        ((w.from === fromId && w.to === toId) ||
          (w.from === toId && w.to === fromId)),
    )
  )
    return I18n.t("这两元素之间已有关系线");
  return null;
}
function addRelWire(fromId, toId, opts) {
  opts = opts || {};
  const arrow =
    ["forward", "backward", "both", "none"].indexOf(opts.relArrow) >= 0
      ? opts.relArrow
      : "forward";
  S.wf.wires.push({
    id: uid("w"),
    from: fromId,
    to: toId,
    fromIndex: 0,
    toIndex: 0,
    rel: true,
    relArrow: arrow,
    relLabel: String(opts.relLabel || "").trim(),
  });
}

function connect(fromId, toId, toIndex, fromIndex) {
  const err = connectError(fromId, toId, toIndex, fromIndex);
  if (err) {
    toast(err, "warn");
    return;
  }
  pushHistory();
  addWire(fromId, toId, toIndex, { notify: true, save: false, fromIndex: fromIndex || 0 });
  renderCanvas();
  scheduleSave(true);
  renderStatus();
}

/* ────────────────────────────────────────────────────────────
   跨超级节点连接（agent 内置工具）
   让不同层级 / 不同超级节点内的任意两个节点互相连通：
   从源节点向上逐层「汇入」各自超级节点的外部输出端子，
   再向目标节点逐层「桥接」各自超级节点的外部输入端子，
   顶层超级节点之间直接相连，最终 from → to 贯通。
   ──────────────────────────────────────────────────────────── */
function superAncestorChainOf(n) {
  /* 自内向外收集 n 的所有超级节点祖先（含最近的），不含 n 自身 */
  const chain = [];
  let cur = n && nodeById(n.parentSuperId);
  const seen = new Set();
  while (cur && cur.kind === "super" && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = nodeById(cur.parentSuperId);
  }
  return chain;
}

/** 源→目标是否已存在任意端子上的连线（幂等保护，避免重复调用累积冗余线） */
function wireExistsBetween(fromId, toId) {
  return (S.wf && S.wf.wires || []).some(
    (w) => w.from === fromId && w.to === toId,
  );
}

/** 把一个内部节点「汇入」它的直属超级节点：node → super（占用 super 的外部输出端子） */
function superFeedUp(node, superNode, warnings) {
  if (!node || !superNode || !nodeById(node.id) || !nodeById(superNode.id)) return;
  if (wireExistsBetween(node.id, superNode.id)) return; /* 已连则跳过 */
  /* 工具节点：输出端子 = 各输出参数（末位为控制出），必须显式挑一个空闲参数端子 */
  let ti = null;
  if (isToolNode(superNode)) {
    ti = fnToolFreePortIndex(superNode, "out", isControlKind(node));
    if (ti == null) {
      if (warnings)
        warnings.push(
          I18n.t("跨级汇入失败：") +
            (superNode.title || superNode.id) +
            " " +
              I18n.t("没有空闲的输出参数端子（请在工具设置里增加出参）"),
        );
      return;
    }
  }
  const err = connectError(node.id, superNode.id, ti, 0);
  if (err) {
    if (warnings) warnings.push(I18n.t("跨级汇入失败：") + (node.title || node.id) + " → " + (superNode.title || superNode.id) + "：" + err);
    return;
  }
  addWire(node.id, superNode.id, ti, { fromIndex: 0 });
}

/** 把超级节点的外部输入「桥接」到内部子节点：super → node（占用 super 的外部输入端子） */
function superBridgeDown(superNode, node, warnings) {
  if (!superNode || !node || !nodeById(superNode.id) || !nodeById(node.id)) return;
  if (wireExistsBetween(superNode.id, node.id)) return; /* 已连则跳过 */
  /* 工具节点：端口 0 是控制入 → 跨级下发只能桥到参数端子（1..N） */
  let fi = 0;
  if (isToolNode(superNode)) {
    fi = fnToolFreePortIndex(superNode, "in", false);
    if (fi == null) {
      if (warnings)
        warnings.push(
          I18n.t("跨级桥接失败：") +
            (superNode.title || superNode.id)
          + " "
          + I18n.t("没有空闲的输入参数端子（请在工具设置里增加入参）"),
        );
      return;
    }
  }
  const err = connectError(superNode.id, node.id, null, fi);
  if (err) {
    if (warnings) warnings.push(I18n.t("跨级桥接失败：") + (superNode.title || superNode.id) + " → " + (node.title || node.id) + "：" + err);
    return;
  }
  addWire(superNode.id, node.id, null, { fromIndex: fi });
}

/** 上层超级节点 → 下层超级节点（顶层连接，或层间贯穿） */
function superLinkOuter(superFrom, superTo, warnings) {
  if (!superFrom || !superTo || superFrom.id === superTo.id) return;
  if (nodeById(superFrom.id) && nodeById(superTo.id)) {
    if (wireExistsBetween(superFrom.id, superTo.id)) return; /* 已连则跳过 */
    /* 目标是工具节点时：端口 0 是控制入，跨级连接要落在空闲的参数端子上 */
    let ti = null;
    if (isToolNode(superTo)) {
      ti = fnToolFreePortIndex(superTo, "in", false);
      if (ti == null) {
        if (warnings)
          warnings.push(
            I18n.t("超级节点连接失败：") +
              (superTo.title || superTo.id) +
              " " +
              I18n.t("没有空闲的输入参数端子（请在工具设置里增加入参）"),
          );
        return;
      }
    }
    const err = connectError(superFrom.id, superTo.id, ti, 0);
    if (err) {
      if (warnings) warnings.push(I18n.t("超级节点连接失败：") + (superFrom.title || superFrom.id) + " → " + (superTo.title || superTo.id) + "：" + err);
      return;
    }
    addWire(superFrom.id, superTo.id, ti, { fromIndex: 0 });
  }
}

/** 单对跨超级节点连接 from → to；返回实际建立的连线条数 */
function applySuperConnectOne(fromNode, toNode, warnings) {
  if (!fromNode || !toNode) return 0;
  if (fromNode.id === toNode.id) {
    if (warnings) warnings.push(I18n.t("不能连接同一节点"));
    return 0;
  }
  const fromChain = superAncestorChainOf(fromNode); /* 源侧 super 链（自内向外） */
  const toChain = superAncestorChainOf(toNode);     /* 目标侧 super 链（自内向外） */
  let made = 0;
  /* 1) 源侧逐层上传：from → 最近 super → 再上层 super … */
  let prev = fromNode;
  for (const sup of fromChain) {
    superFeedUp(prev, sup, warnings);
    made++;
    prev = sup;
  }
  /* 2) 目标侧逐层下发：最外层 super → … → 最近 super → to */
  const toRev = toChain.slice().reverse();
  let next = toNode;
  for (const sup of toRev) {
    superBridgeDown(sup, next, warnings);
    made++;
    next = sup;
  }
  /* 3) 顶层相连：源侧最外层 super ↔ 目标侧最外层 super */
  const topFrom = fromChain.length ? fromChain[fromChain.length - 1] : fromNode;
  const topTo = toChain.length ? toChain[toChain.length - 1] : toNode;
  if (topFrom.id !== topTo.id) {
    superLinkOuter(topFrom, topTo, warnings);
    made++;
  }
  return made;
}

/** agent 工具入口：superConnect: [{from, to, fromIndex?}] */
function applySuperConnect(pairs, ctx) {
  const warnings = ctx && ctx.warnings ? ctx.warnings : [];
  const connected = ctx && ctx.connected ? ctx.connected : [];
  const aliasMap = ctx && ctx.aliasMap ? ctx.aliasMap : null;
  let madeTotal = 0;
  for (const pair of (pairs || []).slice(0, 20)) {
    const a = resolveCanvasRef(pair && pair.from, aliasMap, warnings);
    const b = resolveCanvasRef(pair && pair.to, aliasMap, warnings);
    if (!a || !b) continue;
    const before = (S.wf && S.wf.wires ? S.wf.wires : []).length;
    const made = applySuperConnectOne(a, b, warnings);
    if (made) {
      connected.push({ from: a.id, to: b.id, fromTitle: a.title, toTitle: b.title, viaSuper: true });
      madeTotal += made;
    }
  }
  return madeTotal;
}


function clipStr(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/* canvas_get / 助手快照：节点正文一律全文，不做字数或 token 截断 */
function snapTextField(raw) {
  const s = String(raw == null ? "" : raw);
  return { text: s, textLen: s.length };
}

/* canvas_get 颗粒度：
   detail   = 节点字段档位：minimal（仅 id/kind/title/位置/状态/层级/tags）| standard（+全部配置字段与正文长度，不含正文）| full（全部，默认）
   ids      = 只返回这些节点（按 id 或唯一标题匹配），wires 随之收窄
   bodies   = 是否返回正文全文（text/prompt/task/goal）；缺省：full 时为 true，其余为 false
   bodyLimit= 正文按 N 字符截断（0=不限）；*Len 始终为真实长度
   sections = 重型块白名单（nodes/marks/wires/groups/taskTree/superTree/tagCatalog/workflows/selection），
              在 canvasSnapshotFull 末尾过滤；小上下文（workflow/view/cam/imageSizes/kinds/markColors/devFuncColors/
              taskFocus/superFocus/assistScope/scopeNote）恒保留 */
const NODE_MINIMAL_KEYS = [
  "id", "kind", "title", "x", "y", "w", "h", "running",
  "parentTaskId", "parentSuperId", "taskStatus", "tags",
];
/* jscode（函数节点函数体）与 prompt / task 同属正文：bodies:false 时只留 *Len，bodyLimit 生效 */
const NODE_BODY_KEYS = ["text", "prompt", "task", "goal", "jscode"];
const SNAPSHOT_HEAVY_SECTIONS = [
  "nodes", "marks", "wires", "groups", "taskTree", "superTree",
  "tagCatalog", "workflows", "selection",
];

function normalizeSnapshotOpts(opts) {
  opts = opts || {};
  const detail =
    opts.detail === "minimal" || opts.detail === "standard"
      ? opts.detail
      : "full";
  const wantBodies =
    opts.bodies === undefined ? detail === "full" : !!opts.bodies;
  const bodyLimit = Math.max(0, Math.round(Number(opts.bodyLimit) || 0));
  const ids =
    Array.isArray(opts.ids) && opts.ids.length
      ? opts.ids.map((x) => (x == null ? "" : String(x))).filter(Boolean)
      : null;
  return { detail, wantBodies, bodyLimit, onlyIds: ids };
}

function nodeInFilter(n, o) {
  if (!o.onlyIds) return true;
  return o.onlyIds.some((t) => n.id === t || n.title === t);
}

function pruneNodeSnap(node, o) {
  if (!node) return node;
  if (o.detail === "minimal") {
    const out = {};
    for (const k of NODE_MINIMAL_KEYS) {
      if (node[k] !== undefined) out[k] = node[k];
    }
    return out;
  }
  if (!o.wantBodies) {
    const out = {};
    for (const k of Object.keys(node)) {
      if (!NODE_BODY_KEYS.includes(k)) out[k] = node[k];
    }
    return out;
  }
  if (o.bodyLimit > 0) {
    for (const k of NODE_BODY_KEYS) {
      const v = node[k];
      if (typeof v === "string" && v.length > o.bodyLimit) {
        node[k] = v.slice(0, o.bodyLimit);
      }
    }
  }
  return node;
}

function applySnapshotSectionFilter(snap, sections) {
  if (!snap || !Array.isArray(sections) || !sections.length) return snap;
  const keep = new Set(sections.map((s) => String(s)));
  for (const k of SNAPSHOT_HEAVY_SECTIONS) {
    if (!keep.has(k)) delete snap[k];
  }
  return snap;
}

/* Agent 侧透出「功能色卡」：唯一真源是 app-devnode.js 的 DEV_FUNC_COLORS 常量，
   这里只搬运 key / zh / en / hex（keywords 属内部推断细节，不塞进快照浪费 token）。
   mtnode_canvas_get 与助手快照都通过 devFuncColors 字段读到同一张表。 */
function devFuncColorCatalog() {
  const src =
    typeof DEV_FUNC_COLORS !== "undefined" && Array.isArray(DEV_FUNC_COLORS)
      ? DEV_FUNC_COLORS
      : [];
  return src
    .map((c) => ({
      key: String((c && c.key) || ""),
      zh: String((c && c.zh) || ""),
      en: String((c && c.en) || ""),
      hex: String((c && c.hex) || "").toLowerCase(),
    }))
    .filter((c) => c.key && /^#[0-9a-f]{6}$/.test(c.hex));
}

function canvasSnapshot(opts) {
  const o = normalizeSnapshotOpts(opts);
  const wf = S.wf || { id: "", name: "", nodes: [], wires: [], groups: [], marks: [] };
  const scopeNodes = (wf.nodes || [])
    .filter(
      (n) => !isSuperIoNode(n) && nodeInCurrentScope(n),
    )
    .filter((n) => nodeInFilter(n, o));
  const selNodeIds = o.onlyIds ? new Set(scopeNodes.map((n) => n.id)) : null;
  return {
    workflow: {
      id: wf.id,
      name: wf.name,
      nodeCount: (wf.nodes || []).length,
      workspace: wf.workspace || "",
    },
    view: S.view || "workflow",
    cam: S.cam
      ? { x: Math.round(S.cam.x), y: Math.round(S.cam.y), z: Number(S.cam.z.toFixed(3)) }
      : null,
    imageSizes: IMAGE_SIZES.slice(),
    defaultImageSize: DEFAULT_IMAGE_SIZE,
    kinds: Object.keys(NODE_DEFAULTS).map((k) => ({
      kind: k,
      title: NODE_DEFAULTS[k].title,
      w: NODE_DEFAULTS[k].w,
      h: NODE_DEFAULTS[k].h,
    })),
    taskFocus: currentTaskFocus() || undefined,
    superFocus: currentSuperFocus() || undefined,
    taskTree: (wf.nodes || [])
      .filter((n) => n.kind === "task")
      .map((n) => ({
        id: n.id,
        title: n.title,
        parentTaskId: n.parentTaskId || "",
        goal: clipStr(n.goal, 160),
        status: n.taskStatus || "pending",
        steps: (n.steps || []).map((s) => (s && s.title) || ""),
        childCount: (wf.nodes || []).filter((x) => x.parentTaskId === n.id)
          .length,
      })),
    superTree: (wf.nodes || [])
      .filter((n) => n.kind === "super")
      .map((n) => ({
        id: n.id,
        title: n.title,
        parentSuperId: n.parentSuperId || "",
        parentTaskId: n.parentTaskId || "",
        subFolder: n.subFolder || "",
        superOpen: !!n.superOpen,
        db: !!n.db,
        dbCount: n.dbIndex && n.dbIndex.records ? n.dbIndex.records.length : 0,
        dev: !!n.dev,
        devPath: n.dev ? String(n.devPath || "") || undefined : undefined,
        devStatus: n.dev ? n.devStatus || "pending" : undefined,
        devKind: n.dev ? devKindOf(n) || "module" : undefined,
        /* 核心文件列表（展示口径：显式写入优先，为空时是自动兜底收集的结果） */
        devFiles: n.dev ? devCoreFilesOf(n) : undefined,
        devModel: n.dev ? String(n.devModel || "").trim() || undefined : undefined,
        devProvider: n.dev
          ? String(n.devProvider || "").trim() || undefined
          : undefined,
        /* Agent 预设 / 思考强度（与会话同一张档位表；空 = 跟随默认） */
        devPreset: n.dev
          ? String(n.devPreset || "").trim() || undefined
          : undefined,
        devEffort: n.dev
          ? String(n.devEffort || "").trim() || undefined
          : undefined,
        childCount: (wf.nodes || []).filter(
          (x) => nodeParentSuperId(x) === n.id && !isSuperIoNode(x),
        ).length,
        note: clipStr(n.note, 120),
      })),
    tagCatalog: wfTagCatalog().slice(),
    nodes: scopeNodes.map((n) => {
      const inputSnap =
        n.kind === "input_text" ? snapTextField(n.text) : null;
      const promptSnap =
        n.prompt != null ? snapTextField(n.prompt) : null;
      const taskSnap =
        n.task != null ? snapTextField(n.task) : null;
      const goalSnap =
        n.kind === "task" ? snapTextField(n.goal) : null;
      /* 函数节点的 JS 函数体（node.jscode）与 prompt / task 同属正文口径 */
      const jscodeSnap = isFunctionNode(n) ? snapTextField(n.jscode) : null;
      const node = {
      id: n.id,
      kind: n.kind,
      title: n.title,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      running: !!n.running,
      text: inputSnap ? inputSnap.text : undefined,
      textLen: inputSnap ? inputSnap.textLen : undefined,
      prompt: promptSnap ? promptSnap.text : undefined,
      promptLen: promptSnap ? promptSnap.textLen : undefined,
      task: taskSnap ? taskSnap.text : undefined,
      taskLen: taskSnap ? taskSnap.textLen : undefined,
      jscode: jscodeSnap ? jscodeSnap.text : undefined,
      jscodeLen: jscodeSnap ? jscodeSnap.textLen : undefined,
      savePath: n.savePath || undefined,
      waitPath: n.kind === "wait_file" ? n.waitPath || undefined : undefined,
      waitIntervalSec:
        n.kind === "wait_file"
          ? Math.max(1, Math.min(60, Math.round(Number(n.waitIntervalSec) || 2)))
          : undefined,
      timerMode: n.kind === "timer" ? n.timerMode || undefined : undefined,
      timerAt: n.kind === "timer" ? n.timerAt || undefined : undefined,
      timerEverySec:
        n.kind === "timer"
          ? Math.max(1, Math.round(Number(n.timerEverySec) || 3600))
          : undefined,
      timerCron: n.kind === "timer" ? n.timerCron || undefined : undefined,
      timerArmed: n.kind === "timer" ? !!n.timerArmed : undefined,
      timerNextAt: n.kind === "timer" ? n.timerNextAt || undefined : undefined,
      delaySec: n.kind === "delayer" ? n.delaySec || undefined : undefined,
      seqOutputs: n.kind === "sequencer" ? n.seqOutputs || undefined : undefined,
      seqGapSec: n.kind === "sequencer" ? n.seqGapSec || undefined : undefined,
      gateInputs: n.kind === "gate" ? n.gateInputs || undefined : undefined,
      splitOutputs:
        n.kind === "splitter" ? n.splitOutputs || undefined : undefined,
      counterEvery:
        n.kind === "counter" ? n.counterEvery || undefined : undefined,
      counterCount:
        n.kind === "counter" ? n.counterCount || undefined : undefined,
      mutexInputs: n.kind === "mutex" ? n.mutexInputs || undefined : undefined,
      mutexMode: n.kind === "mutex" ? n.mutexMode || undefined : undefined,
      agent: n.kind === "proc_text" ? !!n.agent : undefined,
      globalRefs: canUseGlobalRefs(n) ? !!n.globalRefs : undefined,
      tags:
        n.kind !== "global" && normalizeNodeTags(n).length
          ? normalizeNodeTags(n).slice()
          : undefined,
      providerId:
        n.kind === "proc_text" ||
        n.kind === "proc_image" ||
        n.kind === "judge"
          ? n.providerId || undefined
          : undefined,
      provider:
        n.kind === "agent_task" || (n.kind === "proc_text" && n.agent)
          ? n.provider || undefined
          : undefined,
      model:
        n.kind === "proc_text" ||
        n.kind === "proc_image" ||
        n.kind === "agent_task" ||
        n.kind === "judge"
          ? n.model || undefined
          : undefined,
      size:
        n.kind === "proc_image"
          ? IMAGE_SIZES.includes(n.size)
            ? n.size
            : DEFAULT_IMAGE_SIZE
          : undefined,
      hasImage:
        n.kind === "input_image"
          ? !!(
              n.imageAsset ||
              (Array.isArray(n.entries) &&
                n.entries.some((e) => e && e.path))
            )
          : undefined,
      imageName:
        n.kind === "input_image" && n.imageAsset
          ? singleImageTitle(n)
          : n.kind === "input_image" &&
              Array.isArray(n.entries) &&
              n.entries[0] &&
              n.entries[0].path
            ? entryDisplayTitle(n.entries[0])
            : undefined,
      imageTitles:
        n.kind === "input_image" && n.batch
          ? (n.entries || [])
              .filter((e) => e && e.path)
              .map((e) => entryDisplayTitle(e))
          : undefined,
      imageCount:
        n.kind === "input_image"
          ? n.batch
            ? (n.entries || []).filter((e) => e && e.path).length
            : n.imageAsset
              ? 1
              : 0
          : undefined,
      ctrlAction: n.kind === "control" ? n.ctrlAction || "run" : undefined,
      ctrlFillOnly: n.kind === "control" ? !!n.ctrlFillOnly : undefined,
      ctrlRole: n.kind === "control" ? n.ctrlRole || undefined : undefined,
      ctrlPinned: n.kind === "control" && n.ctrlPinned ? true : undefined,
      judgeResult: n.kind === "judge" ? n.judgeResult || undefined : undefined,
      parentTaskId: n.parentTaskId || undefined,
      parentSuperId: n.parentSuperId || undefined,
      note: n.kind === "super" ? n.note || undefined : undefined,
      expandW: n.kind === "super" ? n.expandW || undefined : undefined,
      expandH: n.kind === "super" ? n.expandH || undefined : undefined,
      subFolder: n.kind === "super" ? n.subFolder || undefined : undefined,
      superOpen: n.kind === "super" ? !!n.superOpen : undefined,
      db: n.kind === "super" ? !!n.db : undefined,
      dbMode:
        n.kind === "super" && n.db ? n.dbMode || "super" : undefined,
      dbCount:
        n.kind === "super" && n.dbIndex && n.dbIndex.records
          ? n.dbIndex.records.length
          : undefined,
      dbNodeId: n.kind === "db_replica" ? n.dbNodeId || undefined : undefined,
      dbName: n.kind === "db_replica" ? n.dbName || undefined : undefined,
      compiledAt: n.kind === "db_replica" ? n.compiledAt || undefined : undefined,
      dev: n.kind === "super" && !n.db ? !!n.dev : undefined,
      devPath:
        n.kind === "super" && n.dev ? String(n.devPath || "") || undefined : undefined,
      devStatus:
        n.kind === "super" && n.dev ? n.devStatus || "pending" : undefined,
      devKind:
        n.kind === "super" && n.dev ? devKindOf(n) || "module" : undefined,
      devColor:
        n.kind === "super" && n.dev ? devColorOf(n) || undefined : undefined,
      devModel:
        n.kind === "super" && n.dev
          ? String(n.devModel || "").trim() || undefined
          : undefined,
      devProvider:
        n.kind === "super" && n.dev
          ? String(n.devProvider || "").trim() || undefined
          : undefined,
      /* Agent 预设 / 思考强度：与本块模型同一就近继承链，空 = 跟随默认 */
      devPreset:
        n.kind === "super" && n.dev
          ? String(n.devPreset || "").trim() || undefined
          : undefined,
      devEffort:
        n.kind === "super" && n.dev
          ? String(n.devEffort || "").trim() || undefined
          : undefined,
      /* 核心文件列表（≤10 · 相对本块项目根）：与节点「文件」按钮同一口径；
         最外层（项目）开发节点恒为空数组 */
      devFiles:
        n.kind === "super" && n.dev ? devCoreFilesOf(n) : undefined,
      devFilesAuto:
        n.kind === "super" && n.dev && devCoreFilesSourceOf(n) === "auto"
          ? true
          : undefined,
      /* 工具节点（kind super + tool:true · 判定 isToolNode）：toolConfig 即定义与端子表；
         函数节点（kind function）：fnName / description / inputs / outputs（jscode 走正文口径）。
         参数即端子（输入 0 = 控制入、1..N = 各入参；输出 0..M-1 = 各出参、末位 = 控制出）。
         回读与 canvas_edit 参数补丁、设置面板、存档加载共用同一归一真源：入参如实带 list
         （列表端子 = 可被多条数据线重复连入、JS 侧取到数组），出参恒单值（list 归一时已清掉）。 */
      tool: isToolNode(n) ? true : undefined,
      toolConfig: isToolNode(n)
        ? (() => {
            ensureFnToolNodeState(n);
            const c = n.toolConfig || {};
            return {
              name: String(c.name || ""),
              description: String(c.description || ""),
              inputs: fnToolParamList(n, "in").map((p) => ({
                name: p.name,
                kind: p.kind,
                list: p.list === true,
              })),
              outputs: fnToolParamList(n, "out").map((p) => ({
                name: p.name,
                kind: p.kind,
              })),
            };
          })()
        : undefined,
      fnName: isFunctionNode(n)
        ? String(n.fnName || "") || undefined
        : undefined,
      description: isFunctionNode(n)
        ? String(n.description || "") || undefined
        : undefined,
      inputs: isFunctionNode(n)
        ? fnToolParamList(n, "in").map((p) => ({
            name: p.name,
            kind: p.kind,
            list: p.list === true,
          }))
        : undefined,
      outputs: isFunctionNode(n)
        ? fnToolParamList(n, "out").map((p) => ({ name: p.name, kind: p.kind }))
        : undefined,
      execPath:
        n.kind === "execute" ? String(n.execPath || "") || undefined : undefined,
      execIcon:
        n.kind === "execute" ? execIconKeyOf(n) || undefined : undefined,
      execColor:
        n.kind === "execute" ? execColorOf(n) || undefined : undefined,
      fileCount: n.kind === "input_file" ? (n.files || []).length : undefined,
      dbFiles: n.kind === "input_file" ? (n.files || undefined) : undefined,
      tableDef: n.kind === "db_table" ? n.tableDef || undefined : undefined,
      rows: n.kind === "db_table" ? n.rows || undefined : undefined,
      schemaFile: n.kind === "db_table" ? n.schemaFile || undefined : undefined,
      dataFile: n.kind === "db_table" ? n.dataFile || undefined : undefined,
      builtAt: n.kind === "db_table" ? n.builtAt || undefined : undefined,
      netChannel: isNetNode(n) ? (Number(n.netChannel) || 0) & 0xffff : undefined,
      netProto: isNetNode(n) ? (n.netProto === "udp" ? "udp" : "tcp") : undefined,
      netHost: isNetNode(n) ? String(n.netHost || "127.0.0.1") : undefined,
      netPort: isNetNode(n) ? Number(n.netPort) || 0 : undefined,
      netListening: n.kind === "net_recv" ? !!n.netListening : undefined,
      netAutoListen: n.kind === "net_recv" ? n.netAutoListen !== false : undefined,
      netCount: isNetNode(n) ? n.netCount || 0 : undefined,
      delaySec: n.kind === "delayer" ? n.delaySec || 0 : undefined,
      seqOutputs: n.kind === "sequencer" ? n.seqOutputs || 3 : undefined,
      seqGapSec: n.kind === "sequencer" ? n.seqGapSec || 0 : undefined,
      gateInputs: n.kind === "gate" ? n.gateInputs || 2 : undefined,
      splitOutputs: n.kind === "splitter" ? n.splitOutputs || 3 : undefined,
      counterEvery: n.kind === "counter" ? n.counterEvery || 2 : undefined,
      counterCount: n.kind === "counter" ? n.counterCount || 0 : undefined,
      mutexInputs: n.kind === "mutex" ? n.mutexInputs || 2 : undefined,
      mutexMode: n.kind === "mutex" ? n.mutexMode || "first" : undefined,
      /* video_gen / music_gen 配置（agent 可读可改） */
      videoMode: n.kind === "video_gen" ? n.videoMode || "fl2va" : undefined,
      /* 自建 ComfyUI 工作流：非空 = 该节点走工作流库分支（内置参数失效） */
      workflowId:
        n.kind === "video_gen" && String(n.workflowId || "").trim()
          ? String(n.workflowId).trim()
          : undefined,
      wfTitle:
        n.kind === "video_gen" && isCustomVideoGen(n)
          ? String((n.wfMeta && n.wfMeta.title) || "")
          : undefined,
      wfParams:
        n.kind === "video_gen" && isCustomVideoGen(n)
          ? (Array.isArray(n.wfParams) ? n.wfParams : []).map((p) => ({
              key: p.key,
              type: p.type,
              label: p.label,
              port: h3WfPortOf(n, p.key),
              source: p.source,
            }))
          : undefined,
      duration:
        n.kind === "video_gen" || n.kind === "remotion"
          ? Number(n.duration) || 5
          : undefined,
      outputRes:
        n.kind === "video_gen" ? n.outputRes || "auto" : undefined,
      steps: n.kind === "video_gen" ? Number(n.steps) || 20 : undefined,
      ratio: n.kind === "video_gen" ? n.ratio || "16:9" : undefined,
      postEnabled:
        n.kind === "video_gen" ? n.postEnabled !== false : undefined,
      postInterp:
        n.kind === "video_gen" ? n.postInterp !== false : undefined,
      attempts:
        n.kind === "video_gen" ||
        n.kind === "music_gen" ||
        n.kind === "tts_gen" ||
        n.kind === "remotion"
          ? Math.max(1, Math.min(10, Math.round(Number(n.attempts) || 1)))
          : undefined,
      outputPath:
        n.kind === "video_gen" ||
        n.kind === "music_gen" ||
        n.kind === "tts_gen" ||
        n.kind === "remotion"
          ? mediaGenOutputRaw(n) || n.outputPath || undefined
          : undefined,
      /* tts_gen 配置（agent 可读可改） */
      voice: n.kind === "tts_gen" ? String(n.voice || "") : undefined,
      speed:
        n.kind === "tts_gen"
          ? Math.round(ttsSpeedOf(n) * 10) / 10
          : undefined,
      ttsFormat: n.kind === "tts_gen" ? ttsFormatOf(n) : undefined,
      ttsStatus:
        n.kind === "tts_gen"
          ? String(n.ttsStatus || "").slice(0, 200) || undefined
          : undefined,
      output:
        n.kind === "tts_gen" && n.output && n.output.path
          ? {
              kind: "audio",
              path: String(n.output.path),
            }
          : undefined,
      /* remotion 配置（agent 可读可改） */
      remotionSize:
        n.kind === "remotion" ? n.size || "1280x720" : undefined,
      fps:
        n.kind === "remotion" ? Math.max(1, Math.min(60, Number(n.fps) || 30)) : undefined,
      seed: n.kind === "remotion" ? Math.floor(Number(n.seed) || 0) : undefined,
      remotionText:
        n.kind === "remotion" ? String(n.text || "").slice(0, 500) : undefined,
      remotionTsxLen: n.kind === "remotion" ? (n.tsx || "").length : undefined,
      goal: goalSnap ? goalSnap.text : undefined,
      goalLen: goalSnap ? goalSnap.textLen : undefined,
      steps:
        n.kind === "task"
          ? (n.steps || []).map((s) => (s && s.title) || "")
          : undefined,
      taskStatus: n.kind === "task" ? n.taskStatus || "pending" : undefined,
      };
      return pruneNodeSnap(node, o);
    }),
    marks: (wf.marks || [])
      .filter((m) => markInCurrentScope(m))
      .map((m) => ({
      id: m.id,
      kind: m.kind,
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h,
      text: m.kind === "text" ? clipStr(m.text, 120) : undefined,
      color: m.color,
      fontSize: m.kind === "text" ? m.fontSize : undefined,
      stroke: m.kind === "box" || m.kind === "arrow" ? m.stroke : undefined,
      x2: m.kind === "arrow" ? m.x2 : undefined,
      y2: m.kind === "arrow" ? m.y2 : undefined,
      parentSuperId: m.parentSuperId || undefined,
    })),
    markColors: MARK_COLORS.slice(),
    /* 开发节点功能色卡（Agent 按功能分类上色要用）：常量透出，真源见 app-devnode.js */
    devFuncColors: devFuncColorCatalog(),
    wires: (wf.wires || [])
      .filter((w) => {
        const a = nodeById(w.from);
        const b = nodeById(w.to);
        if (!a || !b || !nodeInCurrentScope(a) || !nodeInCurrentScope(b)) return false;
        if (selNodeIds && (!selNodeIds.has(a.id) || !selNodeIds.has(b.id))) return false;
        return true;
      })
      .map((w) => {
      const a = nodeById(w.from);
      const b = nodeById(w.to);
      return {
        id: w.id,
        from: w.from,
        to: w.to,
        fromTitle: a ? a.title : "",
        toTitle: b ? b.title : "",
        rel: w.rel ? true : undefined,
        relLabel: w.rel ? w.relLabel || "" : undefined,
        relArrow: w.rel ? relArrowOf(w) : undefined,
      };
    }),
    groups: (wf.groups || []).map((g) => ({
      id: g.id,
      title: g.title,
      nodeIds: (g.nodeIds || []).slice(),
      markIds: (g.markIds || []).slice(),
    })),
  };
}

function assistScopeIsCurrent() {
  return (S.assistScope || "current") !== "global";
}

/* 画布智能节点（智能任务 / 文本智能）运行中：锁定本画布 */
function isCanvasScopedAgentNode(n) {
  return !!(
    n &&
    (n.kind === "agent_task" ||
      (n.kind === "proc_text" && n.agent))
  );
}

function isCanvasNodeAgentRun() {
  return (S._canvasNodeAgentDepth || 0) > 0;
}

function canvasDeniedForAgentNodeError() {
  return I18n.t(
    "智能节点不能读取或编辑画布、修改节点图或创建任务。请使用读写文件、联网、命令、技能与识图完成任务。",
  );
}

/* 智能节点人设：保留文件/命令/联网，禁止画布与工作流工具 */
function agentNodeCapabilityNote() {
  return (
    "【智能节点】你是画布上的执行节点，不是工作流搭建助手。" +
    "允许：读写与编辑工作区文件、执行命令、联网搜索与抓取网页、使用已安装技能与 MCP 工具、调用 mtnode_vision 识图、向用户提问或派生子任务（均须遵守当前审批/权限预设）。用写文件交付结果。" +
    "禁止：调用 mtnode_canvas_get / mtnode_canvas_edit / mtnode_app；禁止创建、修改、删除节点/连线/绘制/成组；禁止创建任务图；禁止重命名或删除画布；禁止选中节点或撤销/重做。" +
    "上述画布与应用调用会被系统直接拒绝。忽略默认人设里关于搭建画布、修改节点图、创建任务的说明。回答简洁（交流语言见文末「语言口味」）。"
  );
}

/* ============ 规划模式（会话「规划」按钮）：本轮只出计划，禁止任何改动 ============ */

/* 规划模式下宿主直接拒绝的应用级动作（status / list_workflows / list_dsh_plugins 只读放行） */
const PLAN_DENIED_APP_ACTIONS = new Set([
  "rename_workflow",
  "delete_workflow",
  "select_nodes",
  "undo",
  "redo",
  "install_dsh_plugin",
  "remove_dsh_plugin",
  "set_dsh_plugin",
]);

/* 该画布 / 应用调用是否会改动用户可见状态 */
function canvasOpMutates(op, params) {
  if (op === "edit") return true; // mtnode_canvas_edit 全部是写操作
  if (op === "app")
    return PLAN_DENIED_APP_ACTIONS.has(String((params || {}).action || ""));
  return false; // get / vision 只读
}

/* 规划模式下来自会话的运行（画布节点自身已被整体禁止） */
function isPlanModeCanvasRun(ctx) {
  return !!(ctx && ctx.planMode);
}

function planModeCanvasDeniedError() {
  return I18n.t(
    "规划模式：本轮只允许制定计划，任何画布 / 应用修改已被宿主拒绝。请仅输出完整的分步计划并立即结束本轮，等待用户点击「执行计划」。",
  );
}

/* 规划模式的系统提示段（每轮全新会话，靠系统提示 + 用户指令双重约束） */
function planModeSystemNote() {
  return [
    "【规划模式生效中】本轮的唯一交付物是一份可照做的计划，不是改动。",
    "禁止：创建 / 修改 / 删除任何文件（write、edit、str_replace_editor）；执行任何有副作用的命令（安装、删除、移动、复制、构建、git commit/checkout、重启服务、清理目录）；调用 mtnode_canvas_edit 与 mtnode_app 的修改类动作（宿主会直接拒绝并返回错误）；用 todo_write 登记执行清单；用 create_goal 立执行目标；用 subagent 派生实现工作。",
    "允许并鼓励只读调研：read、glob、grep、只读命令（node --check、git status、git diff 等）、mtnode_canvas_get（配 detail:\"standard\" 等省 token 参数）、mtnode_db 查询、web_search、加载技能。",
    "计划格式：以 # 一级标题开头，依次给出 ① 目标与验收标准 ② 现状与关键约束（引用具体文件与行号）③ 分步实施清单（每步写明文件、改动要点、为什么）④ 验证方法 ⑤ 风险与回滚。步骤要具体到无需二次决策。",
    "写完计划立即结束本轮：不要开始实施，也不要追问「是否可以执行」；用户点击界面上的「执行计划」后才会进入实施。",
  ].join("\n");
}

/* 禁止跨画布：智能任务/会话始终锁定；全局助手仅在「当前画布」范围时锁定 */
function restrictOtherCanvases() {
  if ((S._canvasNodeAgentDepth || 0) > 0) return true;
  if (anyAgentSessionRunning()) return true;
  if (S.assistRunActive && assistScopeIsCurrent()) return true;
  return false;
}
/* 旧名兼容 */
function assistRestrictOtherCanvases() {
  return restrictOtherCanvases();
}

function applyAssistScopeToSnapshot(snap, opts) {
  if (!snap || typeof snap !== "object") return snap;
  const locked = restrictOtherCanvases() || (opts && opts.restrict === true);
  snap.assistScope = locked
    ? "current"
    : assistScopeIsCurrent()
      ? "current"
      : "global";
  if (!locked) return snap;
  /* 以运行绑定画布为准（用户切走可见画布时仍锁在任务所在画布） */
  const cur = canvasTargetWf() || S.wf;
  snap.workflows = cur
    ? [
        {
          id: cur.id,
          name: cur.name,
          nodes: (cur.nodes || []).length,
          active: true,
        },
      ]
    : [];
  snap.scopeNote = I18n.t(
    "工作范围=当前画布：不得读取或操作其他画布内容。",
  );
  return snap;
}

async function canvasSnapshotFull(opts) {
  const snap = canvasSnapshot(opts || {});
  let workflows = [];
  try {
    workflows = await window.api.wfList();
  } catch {}
  snap.workflows = (workflows || []).map((w) => ({
    id: w.id,
    name: w.name,
    nodes: w.nodes,
    active: !!(S.wf && S.wf.id === w.id),
  }));
  snap.selection = currentSelection().map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
  }));
  snap.assistOpen = !!S.assistOpen;
  snap.sidebarOpen = !!S.sidebarOpen && S.view !== "agent";
  applyAssistScopeToSnapshot(snap);
  applySnapshotSectionFilter(snap, (opts || {}).sections);
  return snap;
}

function resolveAppNode(token, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  const byId = nodeById(s);
  if (byId) return byId;
  const hits = (S.wf.nodes || []).filter((n) => n.title === s);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    if (warnings) warnings.push(I18n.t("标题不唯一，请改用 id：") + s);
    return null;
  }
  if (warnings) warnings.push(I18n.t("找不到节点：") + s);
  return null;
}

async function resolveWorkflowRef(token) {
  const s = String(token || "").trim();
  if (!s) return null;
  const list = await window.api.wfList();
  const byId = (list || []).find((w) => w.id === s);
  if (byId) return byId;
  const byName = (list || []).filter((w) => w.name === s);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1)
    throw new Error(I18n.t("画布名称不唯一，请改用 id：") + s);
  throw new Error(I18n.t("找不到画布：") + s);
}

async function createWorkflowNamed(name) {
  const id = "wf_" + Date.now().toString(36);
  clearHistory();
  setForegroundWf({
    id,
    name: String(name || "").trim() || I18n.t("未命名画布"),
    nodes: [],
    wires: [],
    groups: [],
    marks: [],
  }); /* 新建即切为用户可见的前台画布：_fgWf 同步登记 */
  reviveWf(id); /* 全新画布对象：解禁同名 id（旧对象墓碑仍在，串写不进来） */
  await window.api.wfSave(id, S.wf);
  S.config.activeWorkflowId = id;
  await window.api.configSave(S.config);
  rememberWf(S.wf);
  renderAll();
  trackWorkflow(id, S.wf.name);
  await refreshWfSelect();
  toast(I18n.t("已创建新画布"), "ok");
  return { id, name: S.wf.name };
}

async function renameWorkflowByRef(workflow, name) {
  const nm = String(name || "").trim();
  if (!nm) throw new Error(I18n.t("请填写画布名称"));
  let id = S.wf && S.wf.id;
  if (workflow) {
    const w = await resolveWorkflowRef(workflow);
    id = w.id;
  }
  if (!id) throw new Error(I18n.t("当前没有打开的画布"));
  /* 已删画布（黑名单）不允许再改名：这里的 wfSave 会凭空复活一个空壳画布 */
  if (wfIsDeleted(id))
    throw new Error(deletedWfError({ id, name: S.wf && S.wf.id === id ? S.wf.name : "" }));
  if (S.wf && S.wf.id === id) {
    S.wf.name = nm;
    scheduleSave(true);
    trackWorkflow(id, nm);
    renderAll();
  } else {
    const r = await window.api.wfLoad(id);
    if (!r.ok) throw new Error(r.error || I18n.t("打开失败"));
    const wf = r.data;
    wf.id = id;
    wf.name = nm;
    await window.api.wfSave(id, wf);
    trackWorkflow(id, nm);
    await refreshWfSelect();
  }
  toast(I18n.t("画布已重命名：") + nm, "ok");
  return { id, name: nm };
}

/* ── 删除画布的目标解析（确认框与执行体共用同一口径）─────────────────────
   杜绝「弹窗显示 A、实际删掉 B」：
   - 受限范围（智能任务 / 会话锁画布）：无 ref 时只能删本会话绑定的画布
     （S.canvasRunWf，退一步用「用户可见的前台画布」），有 ref 也必须就是它。
     绝不兜底 S.wf —— 后台换画布编辑（runAgainstWf）在飞时 S.wf 是别人的画布。
   - 全局范围：必须显式给出 workflow，缺失直接报错要求指定，不再默认「删当前」。
   返回磁盘上的真实目标 { id, name, nodes }（wfList 口径，与主进程校验同源）。 */
async function resolveDeleteWfTarget(params, opts) {
  const p = params || {};
  const ref = String(p.workflow || p.id || p.name || "").trim();
  const restricted = assistRestrictOtherCanvases();
  let bound = null;
  if (restricted) {
    bound =
      (S.canvasRunWf && S.canvasRunWf.id ? S.canvasRunWf : null) ||
      currentVisibleWf();
    if (!bound || !bound.id) throw new Error(I18n.t("当前会话没有绑定画布，无法删除"));
  } else if (!ref) {
    throw new Error(
      I18n.t(
        "缺少 workflow：请显式指定要删除的画布（id 或名称）。为避免误删，全局范围不会默认删除「当前画布」。",
      ),
    );
  }
  const token = ref || (bound && bound.id);
  const w = await resolveWorkflowRef(token);
  if (!w || !w.id) throw new Error(I18n.t("找不到画布：") + token);
  if (restricted && String(w.id) !== String(bound.id))
    throw new Error(
      (opts && opts.scopeBlocked) ||
        I18n.t("智能任务仅能访问当前画布，无法读取或操作其他画布。"),
    );
  /* 已在黑名单里的画布（本轮删除成功后 agent 又调一次）：明确报错 */
  if (wfIsDeleted(w.id)) throw new Error(deletedWfError(w));
  return {
    id: String(w.id),
    name: String(w.name || w.id),
    nodes: Number(w.nodes || 0),
    restricted: !!restricted,
  };
}

/* params 对象身份为键的「确认戳」：确认框解析并展示过的目标登记在这里，
   执行前复核弹窗期间目标没被换掉（模型无法伪造，不进任何数据通道）。 */
const APP_OP_CONFIRM_STAMPS = new WeakMap();
function stampAppOpConfirm(params, stamp) {
  if (!params || typeof params !== "object") return;
  try {
    APP_OP_CONFIRM_STAMPS.set(params, stamp);
  } catch {}
}
function takeAppOpConfirmStamp(params) {
  if (!params || typeof params !== "object") return null;
  const s = APP_OP_CONFIRM_STAMPS.get(params) || null;
  try {
    APP_OP_CONFIRM_STAMPS.delete(params);
  } catch {}
  return s;
}

async function deleteWorkflowByRef(workflow, opts) {
  opts = opts || {};
  const ref = String(workflow == null ? "" : workflow).trim();
  /* 删除入口不再兜底 S.wf：调用方（applyAppOp 的 delete_workflow 分支）必须
     先经 resolveDeleteWfTarget 锁定目标，把画布引用显式传进来。 */
  if (!ref)
    throw new Error(
      I18n.t("缺少 workflow：请显式指定要删除的画布（id 或名称）。"),
    );
  const w = await resolveWorkflowRef(ref);
  if (!w || !w.id) throw new Error(I18n.t("找不到画布：") + ref);
  /* 与调用方锁定的目标不一致（弹窗到执行之间画布列表变了）：立刻中止 */
  if (opts.expectId && String(w.id) !== String(opts.expectId))
    throw new Error(
      I18n.t("删除目标与锁定的画布不一致，已中止：") + w.id,
    );
  /* 已在黑名单里的画布（本轮删除成功后 agent 又调一次）：明确报错，不重复删、
     更不能让它走后面的落点重建路径把旧对象再写回磁盘。 */
  if (wfIsDeleted(w.id)) throw new Error(deletedWfError(w));
  const expectName = String(opts.expectName || w.name || w.id);
  /* 主进程双重校验：id + 名称都要和磁盘上那份 json 对得上，否则 fail closed */
  const r = await window.api.wfDelete({
    id: w.id,
    expectId: String(w.id),
    expectName,
  });
  /* 主进程回 ok 才算删除成功（物理删 / 软删都按「对用户已不存在」收口）；
     失败原因原样回给用户（toast）与模型（抛出的 error），绝不谎报成功、
     不摘状态、不重建画布。 */
  if (!r || !r.ok) {
    const reason =
      (r && (r.error || r.code)) || I18n.t("主进程未返回删除结果");
    toast(I18n.t("删除被拒绝：") + reason, "err");
    throw new Error(I18n.t("删除失败：") + reason);
  }
  /* 删除已确认：统一收口 —— 掐待保存定时器、从 wfBag / canvasRunStack /
     nodeWfId 里摘干净，并把 id 记入黑名单（此后 persist 类写回一律丢弃）。 */
  forgetDeletedWf(
    w.id,
    (S.wfBag && S.wfBag[w.id]) || (S.wf && String(S.wf.id) === String(w.id) ? S.wf : null),
  );
  /* 落点必须在摘标签之前选定（要在原标签序列里找「下一个」）。
     R1：不再无条件 wfSave("default", 空壳) 把已有默认画布整个清空。 */
  const land = await pickLandingWfAfterDelete(w.id);
  const list = S.config.visitedWorkflows || [];
  const i = list.findIndex((t) => t.id === w.id);
  if (i >= 0) list.splice(i, 1);
  const fg = currentVisibleWf();
  if ((S.wf && S.wf.id === w.id) || (fg && fg.id === w.id)) {
    let landed = false;
    if (land.exists) {
      /* 切到落点走真实加载（workspace 等字段随磁盘数据回来），skipFlush 防复活 */
      await loadWorkflow(land.id, { skipFlush: true });
      if (S.wf && S.wf.id === land.id) {
        landed = true;
        /* loadWorkflow 可能因「目标已是 S.wf」直接返回：仍要把前台真源指过来 */
        if (currentVisibleWf() !== S.wf) setForegroundWf(S.wf);
        toast(
          I18n.t("画布已删除，已切换到：") + (S.wf.name || land.id),
          "ok",
        );
      }
    }
    if (!landed) {
      /* 只有磁盘上确实没有 default.json（或落点加载失败）时才新建空默认画布 */
      await createDefaultWorkflowFresh();
      toast(I18n.t("画布已删除，已重建默认画布"), "ok");
    }
  } else {
    toast(I18n.t("已删除画布：") + (w.name || w.id), "ok");
  }
  await window.api.configSave(S.config);
  renderAll();
  await refreshWfSelect();
  return {
    ok: true,
    deleted: w.id,
    /* 把「到底删了哪一张」原样回给模型：名称 + 节点数 + 回收站路径 */
    deletedName: w.name || w.id,
    deletedNodes: Number(w.nodes || 0),
    trashPath: r.trashPath || null,
    active: S.wf && S.wf.id,
  };
}

async function applyAppOp(params) {
  params = params || {};
  const action = String(params.action || "").trim();
  const warnings = [];
  if (!action) throw new Error(I18n.t("缺少 action"));
  if (action === "delete_workflow") await ensureAgentTool("app_delete");
  else if (
    action === "list_dsh_plugins" ||
    action === "install_dsh_plugin" ||
    action === "remove_dsh_plugin" ||
    action === "set_dsh_plugin"
  ) {
    await ensureAgentTool("app_dsh_plugins");
  } else if (
    action === "status" ||
    action === "list_workflows" ||
    action === "rename_workflow" ||
    action === "select_nodes" ||
    action === "undo" ||
    action === "redo"
  ) {
    await ensureAgentTool("app_ops");
    if (action === "status" || action === "list_workflows")
      await ensureAgentTool("canvas_read");
  }
  const scopeBlocked = S.assistRunActive && assistScopeIsCurrent()
    ? I18n.t(
        "当前工作范围为「当前画布」，无法访问其他画布。请将工作范围改为「全局」后再试。",
      )
    : I18n.t(
        "智能任务仅能访问当前画布，无法读取或操作其他画布。",
      );

  if (
    action === "fit_canvas" ||
    action === "focus_node" ||
    action === "set_view" ||
    action === "switch_workflow" ||
    action === "create_workflow"
  ) {
    throw new Error(I18n.t("未知应用操作：") + action);
  }

  if (action === "status" || action === "list_workflows") {
    return Object.assign({ ok: true, action }, await canvasSnapshotFull());
  }

  if (action === "list_dsh_plugins") {
    if (!window.api || !window.api.dshPluginList)
      throw new Error(I18n.t("DSH 插件接口不可用"));
    const r = await window.api.dshPluginList();
    const plugins = ((r && r.plugins) || []).map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title || p.name,
      kind: p.kind,
      core: !!p.core,
      source: p.source === "config" ? "config" : "app",
      disabled: !!p.disabled,
      toggleable: !!p.toggleable,
      removable: !!p.removable,
      version: p.version || "",
      description: (p.description || "").slice(0, 240),
    }));
    return { ok: true, action, plugins, count: plugins.length };
  }

  if (action === "install_dsh_plugin") {
    if (!window.api || !window.api.dshPluginAdd)
      throw new Error(I18n.t("DSH 插件接口不可用"));
    const pkg = String(params.pkg || params.plugin || params.name || "").trim();
    if (!pkg) throw new Error(I18n.t("缺少插件名 pkg"));
    const rr = await window.api.dshPluginAdd(pkg);
    if (rr && rr.ok === false)
      throw new Error((rr && rr.error) || I18n.t("安装失败"));
    return {
      ok: true,
      action,
      pkg,
      restarted: !!(rr && rr.restarted),
      message: (rr && rr.message) || I18n.t("DSH 插件已安装：") + pkg,
      plugins: (rr && rr.plugins) || [],
    };
  }

  if (action === "remove_dsh_plugin") {
    if (!window.api || !window.api.dshPluginRemove)
      throw new Error(I18n.t("DSH 插件接口不可用"));
    const pkg = String(params.pkg || params.plugin || params.name || "").trim();
    if (!pkg) throw new Error(I18n.t("缺少插件名 pkg"));
    const rr = await window.api.dshPluginRemove(pkg);
    if (rr && rr.ok === false)
      throw new Error((rr && rr.error) || I18n.t("移除失败"));
    return {
      ok: true,
      action,
      pkg,
      restarted: !!(rr && rr.restarted),
      plugins: (rr && rr.plugins) || [],
    };
  }

  if (action === "set_dsh_plugin") {
    if (!window.api || !window.api.dshPluginSetEnabled)
      throw new Error(I18n.t("DSH 插件接口不可用"));
    const pkg = String(params.pkg || params.plugin || params.name || "").trim();
    if (!pkg) throw new Error(I18n.t("缺少插件名 pkg"));
    const enabled = params.enabled !== false && params.enabled !== "false";
    const id = params.id ? String(params.id) : undefined;
    const rr = await window.api.dshPluginSetEnabled(pkg, enabled, id);
    if (rr && rr.ok === false)
      throw new Error((rr && rr.error) || I18n.t("操作失败"));
    return {
      ok: true,
      action,
      pkg,
      enabled,
      restarted: !!(rr && rr.restarted),
      plugins: (rr && rr.plugins) || [],
    };
  }

  if (action === "rename_workflow") {
    if (assistRestrictOtherCanvases()) {
      const bound = canvasTargetWf() || S.wf;
      const ref = String(params.workflow || params.id || "").trim();
      if (ref && bound && ref !== bound.id && ref !== bound.name)
        throw new Error(scopeBlocked);
      /* 无 ref 时改绑定画布，避免用户已切走可见画布时误改别的 */
      if (!ref && bound) {
        const renamed = await renameWorkflowByRef(
          bound.id,
          params.name || params.setName || params.title,
        );
        return { ok: true, action, renamed };
      }
    }
    const renamed = await renameWorkflowByRef(
      params.workflow || params.id || "",
      params.name || params.setName || params.title,
    );
    return { ok: true, action, renamed };
  }

  if (action === "delete_workflow") {
    /* 收紧删除入口：目标一律经 resolveDeleteWfTarget 锁定 ——
       受限范围只允许删本会话绑定的画布（不兜底 S.wf），全局范围必须显式
       指定 workflow。与确认框（summarizeAppOp）共用同一解析，弹窗期间目标
       变了就中止；主进程再按 id + 名称双重校验，拒绝原因原样回传。 */
    const t = await resolveDeleteWfTarget(params, { scopeBlocked });
    const stamp = takeAppOpConfirmStamp(params);
    if (stamp && String(stamp.id) !== String(t.id))
      throw new Error(
        I18n.t("删除目标与确认框里的画布不一致，已中止，请重新发起删除。"),
      );
    if (stamp && String(stamp.name) !== String(t.name))
      throw new Error(
        I18n.t("画布名称在确认期间已变化，已中止，请重新确认后删除。"),
      );
    const deleted = await deleteWorkflowByRef(t.id, {
      expectId: t.id,
      expectName: t.name,
    });
    return Object.assign({ ok: true, action }, deleted, await canvasSnapshotFull());
  }

  if (action === "select_nodes") {
    if (!S.wf) throw new Error(I18n.t("当前没有打开的画布"));
    const tokens = [];
    if (Array.isArray(params.nodes)) tokens.push(...params.nodes);
    if (params.node) tokens.push(params.node);
    clearSelection();
    const picked = [];
    for (const t of tokens) {
      const n = resolveAppNode(t, warnings);
      if (n) {
        S.selSet.add(n.id);
        picked.push({ id: n.id, title: n.title, kind: n.kind });
      }
    }
    if (picked.length) S.sel = picked[picked.length - 1].id;
    renderCanvas();
    return { ok: true, action, selected: picked, warnings };
  }

  if (action === "undo") {
    undo();
    return { ok: true, action };
  }
  if (action === "redo") {
    redo();
    return { ok: true, action };
  }

  throw new Error(I18n.t("未知应用操作：") + action);
}

function canvasOpNeedsConfirm(op, params) {
  if (!S.assistRunActive && !anyAgentSessionRunning()) return false;
  if (S.config && S.config.dsh && S.config.dsh.assistAutoApprove) return false;
  if (op === "edit") return true;
  if (op === "app" && params && params.action === "delete_workflow") return true;
  if (
    op === "app" &&
    params &&
    (params.action === "install_dsh_plugin" ||
      params.action === "remove_dsh_plugin" ||
      params.action === "set_dsh_plugin")
  ) {
    return true;
  }
  return false;
}

function canvasConfirmFromAgentSession() {
  return anyAgentSessionRunning() && !S.assistRunActive;
}

/* 用户拒绝智能会话的画布修改：立即中止该次 agent，不再继续工具调用 */
function abortAgentSessionOnCanvasDeny() {
  if (!anyAgentSessionRunning()) return;
  let sid = "";
  try {
    const st = agentSessionState();
    if (st) {
      st._cancelled = true;
      sid = st.id;
    }
  } catch (_) {}
  if (sid) dshCancelActive("agent:" + sid);
  toast(I18n.t("已拒绝画布修改，智能会话已停止"), "warn");
  if (S.view === "agent") {
    try {
      renderAgentSession();
    } catch (_) {}
  }
}

/* 识图子代理：首次需用户许可；「始终允许」写入 dsh.visionInspectAllowed。
   权限预设为完全放行时视为已许可（与右上角「审批」一致）。 */
function visionInspectAllowed() {
  const d = (S.config && S.config.dsh) || {};
  if (S._visionInspectSessionDeny) return false;
  if (d.permissionPreset === "danger-full-access") return true;
  return !!d.visionInspectAllowed || !!S._visionInspectSessionOk;
}

function visionInspectStatusText() {
  const d = (S.config && S.config.dsh) || {};
  if (S._visionInspectSessionDeny) return I18n.t("识图：本会话已拒绝（不再提示）");
  if (d.permissionPreset === "danger-full-access") return I18n.t("识图：完全放行（随权限预设）");
  if (d.visionInspectAllowed) return I18n.t("识图：始终允许");
  if (S._visionInspectSessionOk) return I18n.t("识图：本会话已允许");
  return I18n.t("识图：每次询问");
}

function setVisionInspectMode(mode) {
  if (!S.config.dsh) S.config.dsh = {};
  if (mode === "always") {
    S.config.dsh.visionInspectAllowed = true;
    S._visionInspectSessionOk = true;
    S._visionInspectSessionDeny = false;
  } else if (mode === "once") {
    S.config.dsh.visionInspectAllowed = false;
    S._visionInspectSessionOk = true;
    S._visionInspectSessionDeny = false;
  } else if (mode === "ask") {
    S.config.dsh.visionInspectAllowed = false;
    S._visionInspectSessionOk = false;
    S._visionInspectSessionDeny = false;
  } else if (mode === "deny") {
    S.config.dsh.visionInspectAllowed = false;
    S._visionInspectSessionOk = false;
    S._visionInspectSessionDeny = true;
  }
  window.api.configSave(S.config).catch(() => {});
  paintApprovalsBtn();
}

function permissionPresetOptions() {
  return [
    ["mtnode-unattended", I18n.t("无人值守（工作区读写 · 不询问，默认）")],
    ["workspace-write", I18n.t("工作区读写 · 逐项审批")],
    ["read-only", I18n.t("只读 · 逐项审批")],
    ["danger-full-access", I18n.t("完全放行（不限目录 · 不询问）")],
  ];
}

function permissionPresetLabel(v) {
  const hit = permissionPresetOptions().find((x) => x[0] === v);
  return hit ? hit[1] : v || "mtnode-unattended";
}

function setPermissionPreset(v) {
  if (!S.config.dsh) S.config.dsh = {};
  const ok = permissionPresetOptions().some((x) => x[0] === v);
  S.config.dsh.permissionPreset = ok ? v : "mtnode-unattended";
  window.api.configSave(S.config).catch(() => {});
  paintApprovalsBtn();
  toast(I18n.t("权限预设已切换：") + permissionPresetLabel(S.config.dsh.permissionPreset), "ok");
}

/* Agent 工具许可：按类别开关（与权限预设正交——后者管沙箱/越权审批，这里管「能不能调用」）。
   缺省键视为允许，以便日后加类别时旧配置向前兼容。默认预设封装当前产品能力（全开）。 */
function agentToolCatalog() {
  return [
    {
      id: "canvas",
      label: I18n.t("画布（MTNode）"),
      items: [
        {
          key: "canvas_read",
          label: I18n.t("读取画布"),
          hint: "mtnode_canvas_get",
        },
        {
          key: "canvas_nodes",
          label: I18n.t("节点与连线"),
          hint: I18n.t("创建 / 修改 / 删除普通节点，连接与断开"),
        },
        {
          key: "canvas_control",
          label: I18n.t("控制类节点"),
          hint: I18n.t("执行、清空、需求等待、判断、定时、延时、序列、成功/失败终点"),
        },
        {
          key: "canvas_draw",
          label: I18n.t("绘图"),
          hint: I18n.t("创建 / 修改 / 删除绘制标记"),
        },
        {
          key: "canvas_layout",
          label: I18n.t("排版与成组"),
          hint: I18n.t("自动排版、创建组"),
        },
        {
          key: "canvas_super",
          label: I18n.t("超级节点"),
          hint: I18n.t("创建超级节点、将节点收纳进子画布（改画布确认门已覆盖）"),
        },
      ],
    },
    {
      id: "app",
      label: I18n.t("应用"),
      items: [
        {
          key: "app_ops",
          label: I18n.t("应用操作"),
          hint: I18n.t("状态、列表、重命名、选中、撤销重做"),
        },
        {
          key: "app_delete",
          label: I18n.t("删除画布"),
          hint: "mtnode_app:delete_workflow",
        },
        {
          key: "app_dsh_plugins",
          label: I18n.t("DSH 插件"),
          hint: I18n.t("列出 / 安装 / 移除 / 挂载 DSH 插件"),
        },
      ],
    },
    {
      id: "core",
      label: I18n.t("基础能力（引擎）"),
      items: [
        {
          key: "fs_read",
          label: I18n.t("读文件"),
          hint: I18n.t("浏览与读取工作区文件"),
        },
        {
          key: "fs_write",
          label: I18n.t("写文件"),
          hint: I18n.t("创建、修改、删除工作区文件"),
        },
        {
          key: "shell",
          label: I18n.t("终端命令"),
          hint: I18n.t("在工作区执行命令"),
        },
        {
          key: "web",
          label: I18n.t("联网"),
          hint: I18n.t("搜索与抓取网页"),
        },
        {
          key: "subagent",
          label: I18n.t("子代理任务"),
          hint: I18n.t("派生子任务"),
        },
        {
          key: "goal",
          label: I18n.t("目标与任务清单"),
          hint: I18n.t("跨轮续跑目标 + Todo 清单"),
        },
        {
          key: "jobs",
          label: I18n.t("后台任务"),
          hint: I18n.t("后台命令与子代理的收流 / 终止"),
        },
        {
          key: "ask_user",
          label: I18n.t("向用户提问"),
          hint: I18n.t("ask 交互"),
        },
      ],
    },
    {
      id: "vision",
      label: I18n.t("识图"),
      items: [
        {
          key: "vision",
          label: I18n.t("识图子代理"),
          hint: "mtnode_vision",
        },
      ],
    },
  ];
}

function defaultToolAllow() {
  const allow = {};
  for (const cat of agentToolCatalog()) {
    for (const it of cat.items) allow[it.key] = "allow";
  }
  /* 超级节点改动由「助手改画布」统一确认门覆盖，不再默认二次询问 */
  return allow;
}

/* 助手改画布已批准 / 用户刚确认过本次 edit 时，跳过 canvas_* 的工具许可「询问」
   （避免 assistAutoApprove 仍被 canvas_super=ask 二次拦截，导致跑到排版/成组阶段突然失败）。 */
function canvasToolAskBypassed(key) {
  if (!String(key || "").startsWith("canvas_")) return false;
  if (S.config && S.config.dsh && S.config.dsh.assistAutoApprove) return true;
  if (S._canvasEditUserApproved) return true;
  return false;
}

function normalizeToolMode(v) {
  if (v === false || v === "deny" || v === "reject" || v === 0) return "deny";
  if (v === "ask" || v === "询问") return "ask";
  return "allow";
}

function normalizeToolAllowMap(raw) {
  const base = defaultToolAllow();
  const src = raw && typeof raw === "object" ? raw : {};
  for (const k of Object.keys(base)) {
    if (src[k] !== undefined) base[k] = normalizeToolMode(src[k]);
  }
  return base;
}

function agentToolItemLabel(key) {
  for (const cat of agentToolCatalog()) {
    const hit = cat.items.find((it) => it.key === key);
    if (hit) return hit.label;
  }
  return key;
}

function makeBuiltinDefaultToolPreset() {
  return {
    id: "default",
    name: I18n.t("默认（当前能力）"),
    builtin: true,
    allow: defaultToolAllow(),
  };
}

function saveAgentToolConfig() {
  if (window.api && window.api.configSave)
    window.api.configSave(S.config).catch(() => {});
  paintApprovalsBtn();
}

function ensureAgentToolPresets() {
  if (!S.config) return;
  if (!S.config.dsh) S.config.dsh = {};
  const d = S.config.dsh;
  if (!Array.isArray(d.agentToolPresets) || !d.agentToolPresets.length) {
    d.agentToolPresets = [makeBuiltinDefaultToolPreset()];
  } else {
    let def = d.agentToolPresets.find((p) => p && p.id === "default");
    if (!def) {
      d.agentToolPresets.unshift(makeBuiltinDefaultToolPreset());
    } else {
      def.builtin = true;
      def.name = I18n.t("默认（当前能力）");
      def.allow = normalizeToolAllowMap(def.allow);
      /* 旧版默认 canvas_super=ask 会与「助手改画布」叠成二次确认；内置默认统一为允许 */
      if (def.allow && def.allow.canvas_super === "ask")
        def.allow.canvas_super = "allow";
    }
    for (const p of d.agentToolPresets) {
      if (!p || typeof p !== "object") continue;
      if (!p.id) p.id = "user_" + Date.now().toString(36);
      if (!p.name) p.name = I18n.t("自定义预设");
      p.allow = normalizeToolAllowMap(p.allow);
    }
  }
  const ids = d.agentToolPresets.map((p) => p && p.id);
  if (!d.agentToolPresetId || ids.indexOf(d.agentToolPresetId) < 0)
    d.agentToolPresetId = "default";
}

function agentToolActivePreset() {
  ensureAgentToolPresets();
  const d = S.config.dsh;
  return (
    d.agentToolPresets.find((p) => p && p.id === d.agentToolPresetId) ||
    d.agentToolPresets[0]
  );
}

function agentToolMode(key) {
  const p = agentToolActivePreset();
  if (!p || !p.allow || p.allow[key] === undefined) return "allow";
  return normalizeToolMode(p.allow[key]);
}

function agentToolAllowed(key) {
  return agentToolMode(key) !== "deny";
}

function agentToolDeniedError(key, detail) {
  return new Error(
    I18n.t("当前工具预设不允许：") +
      agentToolItemLabel(key) +
      (detail ? "（" + detail + "）" : "") +
      I18n.t("。请在右上角「审批」中调整 Agent 工具许可。"),
  );
}

function assertAgentTool(key, detail) {
  if (!agentToolAllowed(key)) throw agentToolDeniedError(key, detail);
}

/* ── 按运行裁剪可见工具集：类别 → 工具名（本文件是这条映射的唯一真源）──
   见下方 agentDeniedToolNames 的说明。 */
const AGENT_TOOL_DENY_ALL_OF = {
  /* 画布改动只有 mtnode_canvas_edit 一个入口：连它五类子权限全拒 = 这个工具没用 */
  mtnode_canvas_edit: ["canvas_nodes", "canvas_control", "canvas_draw", "canvas_layout", "canvas_super"],
  /* 应用类同理，只有 mtnode_app 一个入口 */
  mtnode_app: ["app_ops", "app_delete", "app_dsh_plugins"],
};

/**
 * 「Agent 工具许可」里被**拒绝**的类别 → 这一轮根本不该存在的工具名（宿主侧映射唯一真源）。
 *
 * 为什么值得单独出一份名单：拒绝某类过去只是「宿主硬拦 + 提示词说一句」，工具定义照旧
 * 每轮随固定前缀重发（识图 1,544 / 读画布 6,448 / 改画布 15,994 / 应用 3,177 字符，
 * 每一步都付）。名单随 run 参数 hideTools 下达网关（归一与白名单真源
 * dsh/gateway/tool-visibility.mjs，契约见 dsh/DESIGN.md「按运行裁剪可见工具集契约」）。
 *
 * 只做形状明确的翻译：一个许可项 = 一个工具；或「这一类子权限全拒」= 该类唯一的入口工具。
 * fs_read / fs_write / shell / web 刻意不翻译 —— 那四项由 dsh 沙箱与审批档管辖，把 read
 * 藏掉会让「读过的文件才能写」这条观察策略变成模型永远满足不了的条件，反而更费 token。
 * @returns {string[]} 未排序的工具名（网关负责去重排序）
 */
function agentDeniedToolNames() {
  const denied = [];
  for (const cat of agentToolCatalog()) {
    for (const it of cat.items) {
      if (agentToolMode(it.key) === "deny") denied.push(it.key);
    }
  }
  if (!denied.length) return [];
  const has = (k) => denied.indexOf(k) >= 0;
  const out = [];
  if (has("vision")) out.push("mtnode_vision");
  if (has("canvas_read")) out.push("mtnode_canvas_get");
  if (has("ask_user")) out.push("ask_user_question");
  /* 子代理一旦关掉，派生与收口的整族工具都没有意义 */
  if (has("subagent"))
    out.push("subagent", "subagent_fork", "list_agents", "send_message", "interrupt_agent");
  if (has("goal")) out.push("create_goal", "get_goal", "update_goal", "todo_write");
  if (has("jobs")) out.push("job_list", "job_output", "job_kill");
  /* 一类只有一个入口工具的，要求「全拒」才摘（拒一项还能用别项，工具就得留着） */
  for (const tool of Object.keys(AGENT_TOOL_DENY_ALL_OF)) {
    if (AGENT_TOOL_DENY_ALL_OF[tool].every(has)) out.push(tool);
  }
  return out;
}

async function ensureAgentTool(key, detail) {
  const mode = agentToolMode(key);
  if (mode === "deny") throw agentToolDeniedError(key, detail);
  if (mode !== "ask") return;
  if (canvasToolAskBypassed(key)) return;
  const ok = await confirmDialog(
    I18n.t("Agent 请求使用工具：") +
      agentToolItemLabel(key) +
      (detail ? "\n" + detail : ""),
    {
      title: I18n.t("工具许可询问"),
      okText: I18n.t("批准"),
      cancelText: I18n.t("拒绝"),
    },
  );
  if (!ok) throw agentToolDeniedError(key, detail || I18n.t("用户拒绝"));
}

function normalizeCanvasCreateKind(kind) {
  if (kind === "image" || kind === "img") return "input_image";
  if (kind === "text") return "input_text";
  if (kind === "save_text" || kind === "save_image") return "save";
  return kind;
}

function canvasKindToolKey(kind) {
  /* 工具节点的规范形态是超级节点变体（super + tool:true），创建它等同于建一个超级壳 */
  if (kind === "super" || kind === "super_io" || kind === "tool")
    return "canvas_super";
  return isControlKind({ kind: kind }) ? "canvas_control" : "canvas_nodes";
}

function collectCanvasEditToolKeys(params) {
  params = params || {};
  const keys = new Set();
  const creates = Array.isArray(params.create) ? params.create : [];
  const updates = Array.isArray(params.update) ? params.update : [];
  const connects = Array.isArray(params.connect) ? params.connect : [];
  const disconnects = Array.isArray(params.disconnect) ? params.disconnect : [];
  const superConnects = Array.isArray(params.superConnect) ? params.superConnect : [];
  const removes = Array.isArray(params.remove) ? params.remove : [];
  const createMarks = Array.isArray(params.createMarks)
    ? params.createMarks
    : Array.isArray(params.marks)
      ? params.marks
      : [];
  const updateMarks = Array.isArray(params.updateMarks) ? params.updateMarks : [];
  const removeMarksList = Array.isArray(params.removeMarks)
    ? params.removeMarks
    : [];
  const doLayout =
    params.layout === true || (params.layout !== false && creates.length > 0);
  const aliasKind = new Map();
  for (const spec of creates) {
    if (!spec) continue;
    const kind = normalizeCanvasCreateKind(spec.kind);
    if (!NODE_DEFAULTS[kind]) continue;
    const alias = String(spec.alias || "").trim();
    if (alias) aliasKind.set(alias, kind);
    keys.add(canvasKindToolKey(kind));
  }
  const peekKind = (token) => {
    const s = String(token || "").trim();
    if (!s) return "";
    if (aliasKind.has(s)) return aliasKind.get(s);
    const byId = typeof nodeById === "function" ? nodeById(s) : null;
    if (byId) return byId.kind;
    const hits = ((S.wf && S.wf.nodes) || []).filter((n) => n.title === s);
    return hits.length === 1 ? hits[0].kind : "";
  };
  const peekNode = (token) => {
    const s = String(token || "").trim();
    if (!s) return null;
    const byId = typeof nodeById === "function" ? nodeById(s) : null;
    if (byId) return byId;
    const hits = ((S.wf && S.wf.nodes) || []).filter((n) => n.title === s);
    return hits.length === 1 ? hits[0] : null;
  };
  for (const spec of updates) {
    const token = (spec && (spec.id || spec.alias || spec.title)) || "";
    const kind = peekKind(token);
    keys.add(kind ? canvasKindToolKey(kind) : "canvas_nodes");
  }
  if (connects.length || disconnects.length) keys.add("canvas_nodes");
  for (const token of removes) {
    const raw =
      token && typeof token === "object"
        ? token.id || token.alias || token.title
        : token;
    const kind = peekKind(raw);
    keys.add(kind ? canvasKindToolKey(kind) : "canvas_nodes");
    const n = peekNode(raw);
    if (n && n.kind === "task" && typeof taskDescendantIds === "function") {
      for (const id of taskDescendantIds(n.id)) {
        const d = nodeById(id);
        if (d) keys.add(canvasKindToolKey(d.kind));
      }
    }
  }
  if (createMarks.length || updateMarks.length || removeMarksList.length)
    keys.add("canvas_draw");
  if (doLayout || params.group) keys.add("canvas_layout");
  for (const spec of creates) {
    if (!spec) continue;
    if (normalizeCanvasCreateKind(spec.kind) === "super")
      keys.add("canvas_super");
    if (spec.parentSuperId != null || spec.packIntoSuper != null || spec.note != null)
      keys.add("canvas_super");
  }
  for (const spec of updates) {
    if (!spec) continue;
    if (spec.parentSuperId != null || spec.packIntoSuper || spec.note != null)
      keys.add("canvas_super");
    const token = spec.id || spec.alias || spec.title || "";
    if (peekKind(token) === "super") keys.add("canvas_super");
  }
  if (params.packIntoSuper || params.superId) keys.add("canvas_super");
  if (superConnects.length) keys.add("canvas_super");
  if (params.setWorkflowName) keys.add("app_ops");
  return keys;
}

function assertCanvasEditTools(params) {
  for (const key of collectCanvasEditToolKeys(params)) assertAgentTool(key);
}

async function ensureCanvasEditTools(params) {
  for (const key of collectCanvasEditToolKeys(params)) await ensureAgentTool(key);
}

function agentToolPolicySystemNote(opts) {
  try {
    ensureAgentToolPresets();
  } catch (_) {
    return "";
  }
  const nodeLock = !!(opts && opts.nodeLock);
  const p = agentToolActivePreset();
  const allow = (p && p.allow) || defaultToolAllow();
  const denied = [];
  const asking = [];
  for (const cat of agentToolCatalog()) {
    for (const it of cat.items) {
      const mode = normalizeToolMode(allow[it.key]);
      if (mode === "deny") denied.push(it.label + " (" + it.key + ")");
      else if (mode === "ask") asking.push(it.label + " (" + it.key + ")");
    }
  }
  const name = (p && p.name) || I18n.t("默认（当前能力）");
  let s =
    I18n.t("【Agent 工具许可】当前预设「") +
    name +
    I18n.t("」。");
  const assistAuto =
    !!(S.config && S.config.dsh && S.config.dsh.assistAutoApprove);
  if (nodeLock) {
    s += I18n.t(
      "本次运行为智能节点：即使审批预设允许，也不可使用读取画布、节点与连线、控制类节点、绘图、排版与成组、应用操作、删除画布。",
    );
  }
  if (!denied.length && !asking.length) {
    if (!nodeLock)
      s += I18n.t("当前预设允许全部已列出的工具类别（与产品默认能力一致）。");
    if (assistAuto)
      s += I18n.t(
        "助手改画布已批准：mtnode_canvas_edit / 超级节点等画布修改直接生效，无需再等确认。",
      );
    return s;
  }
  if (denied.length)
    s += I18n.t("拒绝：") + denied.join(I18n.t("、")) + "。";
  const askingShown = asking.filter((lab) => {
    if (!assistAuto) return true;
    /* 批准改画布时 canvas_* 询问已被宿主跳过，勿写入提示造成「需审批却被拒」的误判 */
    return !/\(canvas_/.test(lab);
  });
  if (askingShown.length)
    s +=
      I18n.t("询问：") +
      askingShown.join(I18n.t("、")) +
      I18n.t("（调用前会请用户确认）。");
  if (assistAuto)
    s += I18n.t(
      "助手改画布已批准：mtnode_canvas_edit / 超级节点等画布修改直接生效，无需再等确认。",
    );
  if (denied.length)
    s += I18n.t(
      "拒绝项对应的工具不可调用；画布 / 应用 / 识图类调用会被系统直接拒绝。",
    );
  if (normalizeToolMode(allow.canvas_layout) === "deny")
    s += I18n.t("若仍要创建节点，edit 必须传 layout:false，且禁止 group。");
  const coreOff = ["fs_read", "fs_write", "shell", "web", "subagent", "ask_user"].filter(
    (k) => normalizeToolMode(allow[k]) === "deny",
  );
  if (coreOff.length)
    s += I18n.t(
      "基础能力的禁止项请遵守，不要调用读/写文件、终端、联网、子代理或向用户提问中被关掉的能力。",
    );
  return s;
}

function setAgentToolPresetId(id) {
  ensureAgentToolPresets();
  const hit = S.config.dsh.agentToolPresets.find((p) => p && p.id === id);
  if (!hit) return;
  S.config.dsh.agentToolPresetId = hit.id;
  saveAgentToolConfig();
  toast(I18n.t("工具预设已切换：") + hit.name, "ok");
}

function setAgentToolMode(key, mode) {
  const p = agentToolActivePreset();
  if (!p.allow) p.allow = defaultToolAllow();
  p.allow[key] = normalizeToolMode(mode);
  saveAgentToolConfig();
}

function setAgentToolAllow(key, on) {
  setAgentToolMode(key, on ? "allow" : "deny");
}

/* 把当前预设里的全部工具一次性设为「允许」（只落一次盘） */
function setAllAgentToolsAllow() {
  const p = agentToolActivePreset();
  const allow = p.allow && typeof p.allow === "object" ? p.allow : {};
  for (const cat of agentToolCatalog())
    for (const it of cat.items) allow[it.key] = "allow";
  p.allow = allow;
  saveAgentToolConfig();
  toast(I18n.t("已全部设为允许"), "ok");
}

function addAgentToolPreset() {
  ensureAgentToolPresets();
  const cur = agentToolActivePreset();
  const suggested =
    I18n.t("自定义") + " " + S.config.dsh.agentToolPresets.length;
  promptDialog(I18n.t("新预设名称"), suggested, {
    title: I18n.t("新建工具预设"),
  }).then((raw) => {
    if (raw == null) return;
    const name = String(raw).trim() || I18n.t("自定义预设");
    const id = "user_" + Date.now().toString(36);
    S.config.dsh.agentToolPresets.push({
      id,
      name,
      builtin: false,
      allow: normalizeToolAllowMap(cur.allow || {}),
    });
    S.config.dsh.agentToolPresetId = id;
    saveAgentToolConfig();
    toast(I18n.t("已新建工具预设：") + name, "ok");
    openApprovalsPanel();
  });
}

function renameAgentToolPreset() {
  const p = agentToolActivePreset();
  if (!p || p.builtin || p.id === "default") {
    toast(I18n.t("内置默认预设不能重命名"), "warn");
    return;
  }
  promptDialog(I18n.t("重命名预设"), p.name || "", {
    title: I18n.t("重命名"),
  }).then((raw) => {
    if (raw == null) return;
    const name = String(raw).trim();
    if (!name) return;
    p.name = name;
    saveAgentToolConfig();
    toast(I18n.t("预设已重命名：") + name, "ok");
    openApprovalsPanel();
  });
}

function deleteAgentToolPreset() {
  const p = agentToolActivePreset();
  if (!p || p.builtin || p.id === "default") {
    toast(I18n.t("内置默认预设不能删除"), "warn");
    return;
  }
  confirmDialog(I18n.t("删除工具预设「") + p.name + I18n.t("」？"), {
    title: I18n.t("删除"),
    danger: true,
    okText: I18n.t("删除"),
  }).then((ok) => {
    if (!ok) return;
    S.config.dsh.agentToolPresets = S.config.dsh.agentToolPresets.filter(
      (x) => x && x.id !== p.id,
    );
    S.config.dsh.agentToolPresetId = "default";
    saveAgentToolConfig();
    toast(I18n.t("已删除工具预设"), "ok");
    openApprovalsPanel();
  });
}

function agentToolPresetStatusText() {
  try {
    const p = agentToolActivePreset();
    const allow = (p && p.allow) || {};
    let nAsk = 0;
    let nDeny = 0;
    for (const cat of agentToolCatalog()) {
      for (const it of cat.items) {
        const mode = normalizeToolMode(allow[it.key]);
        if (mode === "ask") nAsk++;
        else if (mode === "deny") nDeny++;
      }
    }
    const name = (p && p.name) || I18n.t("默认（当前能力）");
    const bits = [];
    if (nAsk) bits.push(I18n.t("询问 ") + nAsk);
    if (nDeny) bits.push(I18n.t("拒绝 ") + nDeny);
    return bits.length
      ? I18n.t("工具：") + name + " · " + bits.join(I18n.t("、"))
      : I18n.t("工具：") + name;
  } catch (_) {
    return I18n.t("工具：") + I18n.t("默认（当前能力）");
  }
}

function closeApprovalsPanel() {
  const pan = $("#approvalsPanel");
  if (pan) pan.classList.remove("on");
  const btn = $("#btnApprovals");
  if (btn) btn.classList.remove("on");
}

function paintApprovalsBtn() {
  const btn = $("#btnApprovals");
  if (!btn) return;
  const d = (S.config && S.config.dsh) || {};
  const perm = d.permissionPreset || "mtnode-unattended";
  btn.title =
    I18n.t("审批与权限") +
    " · " +
    permissionPresetLabel(perm) +
    " · " +
    agentToolPresetStatusText() +
    " · " +
    visionInspectStatusText();
  btn.setAttribute("aria-label", btn.title);
}

function openApprovalsPanel() {
  let pan = $("#approvalsPanel");
  if (!pan) {
    pan = document.createElement("div");
    pan.id = "approvalsPanel";
    pan.className = "approvals-panel";
    document.body.appendChild(pan);
    document.addEventListener(
      "mousedown",
      (ev) => {
        if (!pan.classList.contains("on")) return;
        if (pan.contains(ev.target)) return;
        if (ev.target.closest && ev.target.closest("#btnApprovals")) return;
        closeApprovalsPanel();
      },
      true,
    );
  }
  if (!S.config.dsh) S.config.dsh = {};
  ensureAgentToolPresets();
  pan.innerHTML = "";
  const h = document.createElement("h4");
  h.textContent = I18n.t("审批与权限");
  pan.appendChild(h);

  const sec1 = document.createElement("div");
  sec1.className = "ap-sec";
  const lab1 = document.createElement("label");
  lab1.className = "ap-label";
  lab1.textContent = I18n.t("权限预设（沙箱 + 工具越权审批；下一轮智能任务起生效）");
  sec1.appendChild(lab1);
  const sel = document.createElement("select");
  for (const [v, l] of permissionPresetOptions()) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    sel.appendChild(o);
  }
  sel.value = S.config.dsh.permissionPreset || "mtnode-unattended";
  sel.onchange = () => {
    setPermissionPreset(sel.value);
    paintApprovalsPanelBody(pan);
  };
  sec1.appendChild(sel);
  pan.appendChild(sec1);

  const secTools = document.createElement("div");
  secTools.className = "ap-sec";
  const labTools = document.createElement("label");
  labTools.className = "ap-label";
  labTools.textContent = I18n.t(
    "Agent 工具许可（按类别：批准 / 询问 / 拒绝；默认全批准。下一轮任务起写入系统提示）",
  );
  secTools.appendChild(labTools);
  const presetRow = document.createElement("div");
  presetRow.className = "ap-preset-row";
  const toolSel = document.createElement("select");
  toolSel.id = "apToolPresetSel";
  const activePreset = agentToolActivePreset();
  for (const p of S.config.dsh.agentToolPresets) {
    if (!p) continue;
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.builtin || p.id === "default" ? p.name : p.name;
    toolSel.appendChild(o);
  }
  toolSel.value = activePreset.id;
  toolSel.onchange = () => {
    setAgentToolPresetId(toolSel.value);
    openApprovalsPanel();
  };
  presetRow.appendChild(toolSel);
  const mkToolBtn = (label, fn, primary) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "mini primary" : "mini";
    b.textContent = label;
    b.onclick = () => {
      fn();
    };
    presetRow.appendChild(b);
    return b;
  };
  mkToolBtn(I18n.t("＋ 新建"), addAgentToolPreset, true);
  const renameBtn = mkToolBtn(I18n.t("重命名"), renameAgentToolPreset, false);
  const delBtn = mkToolBtn(I18n.t("删除"), deleteAgentToolPreset, false);
  const locked = !!(activePreset.builtin || activePreset.id === "default");
  renameBtn.disabled = locked;
  delBtn.disabled = locked;
  secTools.appendChild(presetRow);
  const catsHost = document.createElement("div");
  catsHost.className = "ap-cats";
  for (const cat of agentToolCatalog()) {
    const det = document.createElement("details");
    det.className = "ap-cat";
    det.open = cat.id === "canvas" || cat.id === "app";
    const sum = document.createElement("summary");
    sum.textContent = cat.label;
    det.appendChild(sum);
    for (const it of cat.items) {
      const row = document.createElement("div");
      row.className = "ap-tool-row";
      const meta = document.createElement("div");
      meta.className = "ap-tool-meta";
      const lab = document.createElement("div");
      lab.className = "ap-tool-lab";
      lab.textContent = it.label;
      meta.appendChild(lab);
      if (it.hint) {
        const small = document.createElement("small");
        small.textContent = it.hint;
        meta.appendChild(small);
      }
      row.appendChild(meta);
      const toggles = document.createElement("div");
      toggles.className = "ap-mode-toggles";
      toggles.setAttribute("role", "group");
      toggles.setAttribute("aria-label", it.label);
      const cur = agentToolMode(it.key);
      const modes = [
        ["allow", I18n.t("批准")],
        ["ask", I18n.t("询问")],
        ["deny", I18n.t("拒绝")],
      ];
      for (const [mode, label] of modes) {
        const b = document.createElement("button");
        b.type = "button";
        b.className =
          "ap-mode-btn ap-mode-" + mode + (cur === mode ? " on" : "");
        b.textContent = label;
        b.onclick = () => {
          setAgentToolMode(it.key, mode);
          toggles.querySelectorAll(".ap-mode-btn").forEach((x) => {
            x.classList.toggle(
              "on",
              x.classList.contains("ap-mode-" + mode),
            );
          });
          const stEl = $("#apToolPresetStatus");
          if (stEl) stEl.textContent = agentToolPresetStatusText();
          paintApprovalsBtn();
        };
        toggles.appendChild(b);
      }
      row.appendChild(toggles);
      det.appendChild(row);
    }
    catsHost.appendChild(det);
  }
  secTools.appendChild(catsHost);
  const toolSt = document.createElement("div");
  toolSt.className = "ap-status";
  toolSt.id = "apToolPresetStatus";
  toolSt.textContent = agentToolPresetStatusText();
  secTools.appendChild(toolSt);
  const toolHint = document.createElement("div");
  toolHint.className = "ap-hint";
  toolHint.textContent = I18n.t(
    "与上方「权限预设」独立：那边管沙箱与越权是否询问，这边管 Agent 允许调用哪些能力。批准=直接可用，询问=调用前确认，拒绝=硬拦截。可切换当前预设，或「＋ 新建」另存一份。",
  );
  secTools.appendChild(toolHint);
  pan.appendChild(secTools);

  const sec2 = document.createElement("div");
  sec2.className = "ap-sec";
  const lab2 = document.createElement("label");
  lab2.className = "ap-label";
  lab2.textContent = I18n.t("识图子代理 mtnode_vision（查看本地图片前的许可）");
  sec2.appendChild(lab2);
  const st = document.createElement("div");
  st.className = "ap-status";
  st.id = "apVisionStatus";
  st.textContent = visionInspectStatusText();
  sec2.appendChild(st);
  const row = document.createElement("div");
  row.className = "dsh-btn-row";
  const mk = (label, mode, primary) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = primary ? "mini primary" : "mini";
    b.textContent = label;
    b.onclick = () => {
      setVisionInspectMode(mode);
      const el = $("#apVisionStatus");
      if (el) el.textContent = visionInspectStatusText();
      toast(visionInspectStatusText(), "ok");
    };
    row.appendChild(b);
  };
  mk(I18n.t("始终允许"), "always", true);
  mk(I18n.t("本会话允许"), "once", false);
  mk(I18n.t("每次询问"), "ask", false);
  mk(I18n.t("本会话拒绝"), "deny", false);
  sec2.appendChild(row);
  const hint = document.createElement("div");
  hint.className = "ap-hint";
  hint.textContent = I18n.t(
    "若智能任务报 mtnode_vision 失败 / 审批被禁用：点「始终允许」或「本会话允许」即可恢复识图。无人值守预设不会弹工具审批；需要逐项确认时请改用「工作区读写 · 逐项审批」。",
  );
  sec2.appendChild(hint);
  pan.appendChild(sec2);

  const sec3 = document.createElement("div");
  sec3.className = "ap-sec";
  const lab3 = document.createElement("label");
  lab3.className = "ap-label";
  lab3.textContent = I18n.t("助手改画布（全局助手 / 智能会话）");
  sec3.appendChild(lab3);
  const row3 = document.createElement("div");
  row3.className = "ap-tool-row";
  const meta3 = document.createElement("div");
  meta3.className = "ap-tool-meta";
  const labAssist = document.createElement("div");
  labAssist.className = "ap-tool-lab";
  labAssist.textContent = I18n.t("画布修改确认");
  meta3.appendChild(labAssist);
  const small3 = document.createElement("small");
  small3.textContent = I18n.t(
    "批准=不弹窗（含超级节点）；询问=每次确认一次（不再二次问超级节点）",
  );
  meta3.appendChild(small3);
  row3.appendChild(meta3);
  const toggles3 = document.createElement("div");
  toggles3.className = "ap-mode-toggles";
  const assistAuto = !!S.config.dsh.assistAutoApprove;
  const assistModes = [
    ["allow", I18n.t("批准"), true],
    ["ask", I18n.t("询问"), false],
  ];
  for (const [mode, label, autoVal] of assistModes) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "ap-mode-btn ap-mode-" +
      mode +
      ((assistAuto && autoVal) || (!assistAuto && !autoVal) ? " on" : "");
    b.textContent = label;
    b.onclick = () => {
      S.config.dsh.assistAutoApprove = !!autoVal;
      window.api.configSave(S.config).catch(() => {});
      toggles3.querySelectorAll(".ap-mode-btn").forEach((x) => {
        x.classList.toggle("on", x.classList.contains("ap-mode-" + mode));
      });
      toast(
        autoVal
          ? I18n.t("已开启：助手改画布不再弹确认")
          : I18n.t("已关闭：助手改画布需确认"),
        "ok",
      );
    };
    toggles3.appendChild(b);
  }
  row3.appendChild(toggles3);
  sec3.appendChild(row3);
  pan.appendChild(sec3);

  pan.classList.add("on");
  const btn = $("#btnApprovals");
  if (btn) btn.classList.add("on");
  paintApprovalsBtn();
}

function paintApprovalsPanelBody(pan) {
  /* 权限下拉已即时保存；刷新识图与工具预设状态文案 */
  const el = pan && pan.querySelector("#apVisionStatus");
  if (el) el.textContent = visionInspectStatusText();
  const st = pan && pan.querySelector("#apToolPresetStatus");
  if (st) st.textContent = agentToolPresetStatusText();
  paintApprovalsBtn();
}

function toggleApprovalsPanel() {
  const pan = $("#approvalsPanel");
  if (pan && pan.classList.contains("on")) closeApprovalsPanel();
  else openApprovalsPanel();
}

function confirmVisionInspect(params) {
  params = params || {};
  return new Promise((resolve) => {
    openOverlay(I18n.t("允许识图子代理？"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent = I18n.t(
      "智能助手请求调用识图模型查看本地图片（例如游戏 UI / 截图 OCR）。首次需要你的许可。",
    );
    body.appendChild(p);
    const detail = document.createElement("div");
    detail.style.cssText = "color:var(--muted); font-size:12px; margin-bottom:8px";
    const q = String(params.question || "").trim();
    const path = String(params.imagePath || "").trim();
    detail.textContent =
      (path ? I18n.t("图片：") + path + "\n" : "") +
      (q ? I18n.t("问题：") + q.slice(0, 400) : "");
    detail.style.whiteSpace = "pre-wrap";
    detail.style.wordBreak = "break-all";
    body.appendChild(detail);
    const note = document.createElement("div");
    note.style.cssText = "margin-top:8px; color:var(--orange2); font-size:11.5px";
    note.textContent = I18n.t(
      "「始终允许」会记住选择；「允许一次」仅本次会话有效。图片会发给已配置的视觉模型。也可随时点右上角「审批」调整。",
    );
    body.appendChild(note);
    foot.innerHTML = "";
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      closeOverlay();
      resolve(outcome);
    };
    const deny = document.createElement("button");
    deny.className = "mini";
    deny.textContent = I18n.t("拒绝");
    deny.onclick = () => finish("deny");
    const once = document.createElement("button");
    once.className = "mini";
    once.textContent = I18n.t("允许一次");
    once.onclick = () => finish("once");
    const always = document.createElement("button");
    always.className = "mini primary";
    always.textContent = I18n.t("始终允许");
    always.onclick = () => finish("always");
    foot.appendChild(deny);
    foot.appendChild(once);
    foot.appendChild(always);
  });
}

async function ensureVisionInspectPermission(params) {
  if (S._visionInspectSessionDeny) {
    return false;
  }
  if (visionInspectAllowed()) return true;
  if (S._visionInspectAsking) return S._visionInspectAsking;
  S._visionInspectAsking = confirmVisionInspect(params)
    .then((outcome) => {
      S._visionInspectAsking = null;
      if (outcome === "always") {
        setVisionInspectMode("always");
        return true;
      }
      if (outcome === "once") {
        setVisionInspectMode("once");
        return true;
      }
      /* 拒绝：本会话不再弹识图许可，避免反复打断；可在右上角「审批」恢复 */
      setVisionInspectMode("deny");
      return false;
    })
    .catch(() => {
      S._visionInspectAsking = null;
      return false;
    });
  return S._visionInspectAsking;
}

/* 解析识图路由：供应商顺序 → 模型顺序；DeepSeek 等无图主机排到末尾；失败可重试下一路由 */
function resolveVisionInspectRoutes(preferredModel) {
  const want = String(preferredModel || "").trim();
  const preferred = [];
  const fallback = [];
  const seen = new Set();
  const push = (provObj, modelId, modelName, soft) => {
    if (!provObj || !modelId) return;
    const key = provObj.id + "|" + modelId;
    if (seen.has(key)) return;
    seen.add(key);
    const item = {
      provider: Object.assign({}, provObj, { vision: true }),
      model: modelId,
      modelName: modelName || modelId,
      providerName: provObj.name || provObj.id,
      soft: !!soft,
    };
    if (soft) fallback.push(item);
    else preferred.push(item);
  };
  for (const p of S.config.providers || []) {
    if (p.type !== "text_openai") continue;
    if (!String(p.apiKey || "").trim() || !String(p.baseUrl || "").trim()) continue;
    const softHost = providerHostBlocksVision(p);
    const route = "mtnode_" + p.id;
    const vis = visionModelsForProvider(route);
    if (vis.length) {
      /* 目录已声明 image 的模型可直连，不因 deepseek 主机名降级 */
      for (const m of vis) push(p, m.id, m.name || m.id, false);
    } else if (p.vision && Array.isArray(p.models) && p.models.length) {
      for (const id of p.models) push(p, String(id), String(id), softHost || true);
    }
  }
  let cands = preferred.concat(fallback);
  if (!cands.length) return [];
  if (want) {
    const hit = cands.filter((c) => c.model === want);
    if (hit.length) cands = hit.concat(cands.filter((c) => c.model !== want));
  }
  return cands;
}

function resolveVisionInspectRoute(preferredModel) {
  const cands = resolveVisionInspectRoutes(preferredModel);
  return cands.length ? cands[0] : null;
}

function visionCallLooksRetryable(err) {
  const s = String((err && err.message) || err || "").toLowerCase();
  if (!s) return false;
  return (
    s.includes("403") ||
    s.includes("401") ||
    s.includes("404") ||
    s.includes("vision") ||
    s.includes("image") ||
    s.includes("multimodal") ||
    s.includes("not support") ||
    s.includes("unsupported") ||
    s.includes("invalid_request") ||
    s.includes("识图")
  );
}

async function applyVisionInspect(params) {
  params = params || {};
  const imagePath = String(params.imagePath || "").trim();
  const question = String(params.question || "").trim();
  if (!imagePath) return { ok: false, error: I18n.t("缺少 imagePath") };
  if (!question) return { ok: false, error: I18n.t("缺少 question") };
  try {
    await ensureAgentTool("vision");
  } catch (e) {
    return {
      ok: false,
      error: (e && e.message) || String(e),
      denied: true,
      status: 403,
    };
  }
  if (!isAbsPath(imagePath)) {
    return { ok: false, error: I18n.t("imagePath 必须是本机绝对路径") };
  }
  try {
    const exists =
      window.api && window.api.fileExists
        ? await window.api.fileExists(imagePath)
        : true;
    if (!exists) return { ok: false, error: I18n.t("文件不存在") + "：" + imagePath };
  } catch {
    return { ok: false, error: I18n.t("无法检查文件：") + imagePath };
  }
  const allowed = await ensureVisionInspectPermission({
    imagePath,
    question,
  });
  if (!allowed) {
    return {
      ok: false,
      error: S._visionInspectSessionDeny
        ? I18n.t("识图已被本会话拒绝；请点右上角「审批」改为允许")
        : I18n.t("用户拒绝了识图子代理"),
      denied: true,
      status: 403,
    };
  }
  const routes = resolveVisionInspectRoutes(params.model);
  if (!routes.length) {
    return {
      ok: false,
      error: I18n.t(
        "没有可用的视觉模型；请在「模型服务」把支持识图的服务商排到前面，勾选「支持视觉」，并把视觉模型排到该服务商列表最前（DeepSeek 官方不支持识图）",
      ),
    };
  }
  const prompt =
    I18n.t("你是识图子代理。根据用户问题仔细查看图片并作答；只输出与问题相关的观察与结论，不要编造看不到的内容。\n\n问题：") +
    question;
  const failures = [];
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    try {
      const rr = await window.api.apiCall({
        provider: route.provider,
        kind: "text",
        model: route.model,
        prompt,
        texts: [],
        images: [imagePath],
        temperature: 0.2,
      });
      if (rr && rr.ok) {
        return {
          ok: true,
          answer: String(rr.text || ""),
          provider: route.providerName,
          model: route.model,
          imagePath,
          tried: i + 1,
        };
      }
      const err = (rr && rr.error) || I18n.t("识图调用失败");
      failures.push(route.providerName + " / " + route.model + " → " + err);
      if (visionCallLooksRetryable(err) && i < routes.length - 1) continue;
      return {
        ok: false,
        error:
          err +
          (failures.length > 1
            ? "\n" + I18n.t("已尝试：") + "\n- " + failures.join("\n- ")
            : ""),
        provider: route.providerName,
        model: route.model,
        tried: failures,
      };
    } catch (e) {
      const err = (e && e.message) || String(e);
      failures.push(route.providerName + " / " + route.model + " → " + err);
      if (visionCallLooksRetryable(err) && i < routes.length - 1) continue;
      return {
        ok: false,
        error:
          err +
          (failures.length > 1
            ? "\n" + I18n.t("已尝试：") + "\n- " + failures.join("\n- ")
            : ""),
        provider: route.providerName,
        model: route.model,
        tried: failures,
        status: /\b403\b/.test(err) ? 403 : undefined,
      };
    }
  }
  return {
    ok: false,
    error:
      I18n.t("识图调用失败") +
      "\n" +
      I18n.t("已尝试：") +
      "\n- " +
      failures.join("\n- "),
    tried: failures,
  };
}

async function summarizeAppOp(params) {
  params = params || {};
  if (params.action === "delete_workflow") {
    /* 与执行体同一口径解析删除目标，把 id + 节点数 + 名称摊给用户看，
       并把解析结果登记成「确认戳」供 applyAppOp 复核（防弹窗期间目标漂移）。
       解析失败时不猜测目标，直接把原因显示出来（执行端还会再校验一次）。 */
    let t = null;
    let fail = "";
    try {
      t = await resolveDeleteWfTarget(params);
    } catch (e) {
      fail = (e && e.message) || String(e);
    }
    if (t) stampAppOpConfirm(params, { id: t.id, name: t.name, nodes: t.nodes });
    const ref = String(params.workflow || params.id || params.name || "").trim();
    return {
      summary:
        I18n.t("删除画布") +
        " · " +
        (t ? t.name : ref || I18n.t("未指定画布")),
      detail:
        (t
          ? I18n.t("将删除画布") +
            "「" +
            t.name +
            "」" +
            I18n.t("（id ") +
            t.id +
            I18n.t(" · 节点 ") +
            t.nodes +
            I18n.t(" 个），仅影响这一个画布。")
          : I18n.t("无法定位要删除的画布：") + fail) +
        "\n" +
        I18n.t("请先核对上面的 id 与节点数，确认要删的就是它。") +
        "\n" +
        I18n.t(
          "画布文件与其图像资产会移入本机回收站目录（%APPDATA%\\pipeline-console\\trash），不会静默物理删除。",
        ),
      raw: JSON.stringify(params, null, 2).slice(0, 2000),
    };
  }
  if (params.action === "install_dsh_plugin") {
    const pkg = String(params.pkg || params.plugin || params.name || "").trim();
    return {
      summary: I18n.t("安装 DSH 插件") + (pkg ? " · " + pkg : ""),
      detail: I18n.t("将下载并安装到配置目录（应用升级后保留），安装后智能引擎会重启。"),
      raw: JSON.stringify(params, null, 2).slice(0, 2000),
    };
  }
  if (params.action === "remove_dsh_plugin") {
    const pkg = String(params.pkg || params.plugin || params.name || "").trim();
    return {
      summary: I18n.t("移除 DSH 插件") + (pkg ? " · " + pkg : ""),
      detail: I18n.t("将从配置目录卸载该插件，引擎会重启。"),
      raw: JSON.stringify(params, null, 2).slice(0, 2000),
    };
  }
  if (params.action === "set_dsh_plugin") {
    const pkg = String(params.pkg || params.plugin || params.name || "").trim();
    const on = params.enabled !== false && params.enabled !== "false";
    return {
      summary:
        (on ? I18n.t("挂载 DSH 插件") : I18n.t("取消挂载 DSH 插件")) +
        (pkg ? " · " + pkg : ""),
      detail: I18n.t("更改插件挂载状态后引擎会重启。"),
      raw: JSON.stringify(params, null, 2).slice(0, 2000),
    };
  }
  return {
    summary: I18n.t("应用操作：") + (params.action || ""),
    detail: "",
    raw: JSON.stringify(params, null, 2).slice(0, 2000),
  };
}

/* ── 宿主确认框的「归属轮次」绑定 ────────────────────────────────────────
   confirmAssistCanvasEdit / confirmAssistAppOp 弹出的是宿主级模态框：它只知道
   「有智能体请求改画布」，不知道是哪一轮发起的。发起它的可能是一轮早已结束的
   运行（本轮的预热轮、上一轮遗留的后台 job 或子代理）。网关侧已按 session 章
   门控这类帧（见 dsh/gateway/gateway.mjs 的 [ix-gate]），这里补另一半：每个
   确认框登记到发起轮（帧 id + runKey + 帧 sessionId），本轮收尾、网关撤帧
   （ix-drop）或用户点终止时一律自动关闭并回失败回执 —— 否则用户点「确认」只
   把结果写回一个没人再听的 socket，就是「弹窗跳出来、回答后执行无效」。 */
const IX_CONFIRM_DEAD = "__ix_confirm_dead__";
function canvasConfirmRegistry() {
  if (!S._canvasConfirms) S._canvasConfirms = new Map();
  return S._canvasConfirms;
}
/* 与 ixPruneOrphanCards 同一判活口径：取消句柄已从 _runCancels 消失 = 那一轮
   已经结束（正常收尾 / 用户终止 / 看门狗兜底）。runKey 为空 = 不归属任何智能
   轮次（渲染层本地调用），不做判定，保持原行为。 */
function canvasConfirmRunLive(runKey) {
  if (!runKey) return true;
  return !!(S._runCancels && S._runCancels[runKey]);
}
function canvasConfirmUnregister(id) {
  const k = String(id || "");
  const reg = canvasConfirmRegistry();
  const it = reg.get(k);
  if (!it) return null;
  reg.delete(k);
  return it;
}
function canvasConfirmRegister(entry) {
  if (!entry || !entry.id || typeof entry.settle !== "function") return;
  canvasConfirmRegistry().set(String(entry.id), entry);
}
/* 网关撤帧（ix-drop）：按帧 id 精确自毁 */
function canvasConfirmDrop(id) {
  const it = canvasConfirmUnregister(id);
  if (it) it.settle();
}
/* 本轮收尾 / 用户点终止：撤掉这一轮挂起的全部确认框 */
function canvasConfirmDropRun(runKey) {
  const k = String(runKey || "");
  if (!k) return;
  const reg = canvasConfirmRegistry();
  for (const [id, it] of Array.from(reg)) {
    if (String(it.runKey || "") !== k) continue;
    reg.delete(id);
    it.settle();
  }
}
/* 本地兜底：所属轮已不在途（网关被强杀、老版网关不发撤帧）→ 立刻自毁。
   由 ixPruneOrphanCards 与本轮看门狗周期调用，与提问 / 审批卡同一清理节奏。 */
function canvasConfirmPruneOrphans() {
  const reg = canvasConfirmRegistry();
  if (!reg.size) return;
  for (const [id, it] of Array.from(reg)) {
    if (canvasConfirmRunLive(it.runKey)) continue;
    reg.delete(id);
    it.settle();
  }
}

function confirmAssistAction(title, info, opts) {
  info = info || {};
  opts = opts || {};
  return new Promise((resolve) => {
    openOverlay(title || I18n.t("确认操作"));
    overlayPersistent = true;
    /* owner = 发起这一帧的那一轮：{ id: 帧 id, runKey, sessionId } */
    const owner = opts.owner || null;
    const confirmId = owner && owner.id ? String(owner.id) : "";
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent = info.summary || "";
    body.appendChild(p);
    if (info.detail) {
      const d = document.createElement("div");
      d.style.cssText = "color:var(--muted); font-size:12px; margin-bottom:10px";
      d.textContent = info.detail;
      body.appendChild(d);
    }
    if (info.raw) {
      const pre = document.createElement("pre");
      pre.style.cssText =
        "max-height:240px; overflow:auto; background:var(--code); border:1px solid var(--bd); padding:8px; font-size:11px; white-space:pre-wrap; word-break:break-all";
      pre.textContent = info.raw;
      body.appendChild(pre);
    }
    const note = document.createElement("div");
    note.style.cssText = "margin-top:10px; color:var(--orange2); font-size:11.5px";
    note.textContent = opts.rejectStopsAgent
      ? I18n.t("拒绝后本次修改不会生效，并立即停止智能会话继续工作。")
      : I18n.t("拒绝后本次修改不会生效；可让助手改方案后再试。");
    body.appendChild(note);
    if (confirmId) {
      const hint = document.createElement("div");
      hint.style.cssText = "margin-top:6px; color:var(--muted); font-size:11px";
      hint.textContent = I18n.t("发起该请求的运行结束后，此确认框会自动消失。");
      body.appendChild(hint);
    }
    foot.innerHTML = "";
    /* 屏幕上这一刻显示的框是不是我：自毁路径可能晚于用户打开别的弹窗（设置、
       保存路径…），那时绝不能越界 closeOverlay 把别人正在填的表关掉。 */
    const overlayBox = () => document.querySelector("#overlay .overlay-box");
    const overlayIsMine = () => {
      if (!confirmId) return true;
      const b = overlayBox();
      return !!b && b.dataset.ixConfirmId === confirmId;
    };
    let done = false;
    /* ans: true=确认 / false=拒绝 / IX_CONFIRM_DEAD=发起轮已结束，自动撤框 */
    const settle = (ans, closeDom) => {
      if (done) return;
      done = true;
      canvasConfirmUnregister(confirmId);
      const b = overlayBox();
      if (closeDom && overlayIsMine()) {
        if (b && b.dataset.ixConfirmId) delete b.dataset.ixConfirmId;
        closeOverlay();
      }
      resolve(ans);
    };
    if (confirmId) {
      const b = overlayBox();
      if (b) b.dataset.ixConfirmId = confirmId;
      /* 登记到发起轮：本轮收尾 / ix-drop / 用户终止时会调用 settle */
      canvasConfirmRegister({
        id: confirmId,
        runKey: String((owner && owner.runKey) || ""),
        sessionId: String((owner && owner.sessionId) || ""),
        settle: () => settle(IX_CONFIRM_DEAD, true),
      });
    }
    const cancel = document.createElement("button");
    cancel.className = "mini";
    cancel.textContent = I18n.t("拒绝");
    cancel.onclick = () => settle(false, true);
    const ok = document.createElement("button");
    ok.className = "mini primary";
    ok.textContent = I18n.t("确认修改");
    ok.onclick = () => settle(true, true);
    foot.appendChild(cancel);
    foot.appendChild(ok);
  });
}

function confirmAssistCanvasEdit(params, owner) {
  const info = summarizeCanvasEdit(params);
  const fromSession = canvasConfirmFromAgentSession();
  info.summary =
    (fromSession
      ? I18n.t("智能会话请求修改当前画布：")
      : I18n.t("全局助手请求修改当前画布：")) + info.summary;
  return confirmAssistAction(I18n.t("确认画布修改"), info, {
    rejectStopsAgent: fromSession,
    owner,
  });
}

async function confirmAssistAppOp(params, owner) {
  /* 摘要需要读一次画布列表才能显示真实 id / 节点数，故为异步；
     调用方以 Promise 方式消费（.then / .catch），行为不变。 */
  const info = await summarizeAppOp(params);
  const fromSession = canvasConfirmFromAgentSession();
  info.summary =
    (fromSession
      ? I18n.t("智能会话请求：")
      : I18n.t("全局助手请求：")) + info.summary;
  return confirmAssistAction(I18n.t("确认危险操作"), info, {
    rejectStopsAgent: fromSession,
    owner,
  });
}

async function applyCanvasOp(op, params, runCtx) {
  if (
    isCanvasNodeAgentRun() &&
    (op === "get" || op === "edit" || op === "app")
  ) {
    throw new Error(canvasDeniedForAgentNodeError());
  }
  if (op === "app") return applyAppOp(params || {});
  if (op === "vision") {
    return await applyVisionInspect(params || {});
  }
  if (!S.wf) throw new Error(I18n.t("当前没有打开的画布"));
  /* 绑定的画布已被删除（黑名单 / 对象墓碑）：明确报「画布已删除」，
     不再静默改内存 + 落盘 —— 那会把用户刚删掉的画布凭空复活。 */
  if (wfWriteBlocked(S.wf)) throw new Error(deletedWfError(S.wf));
  if (op === "get") {
    await ensureAgentTool("canvas_read");
    return Object.assign({ ok: true }, await canvasSnapshotFull(params || {}));
  }
  if (op === "edit") return await applyCanvasEdit(params || {}, runCtx || null);
  throw new Error(I18n.t("未知画布操作：") + op);
}

function handleCanvasEvent(data, runCtx) {
  const id = data && data.id;
  if (!id) return;
  runCtx = runCtx || {};
  /* 归属：这一帧由哪一轮（runKey）发起、盖的是哪个 session 章（sessionId）。
     dshRunTask 会把两者透传进来；网关已按 sessionId 拦掉不属于本轮的帧，这里
     的 runKey 只用于本地判活与自毁，不重复裁决放行。 */
  const frameOwner = {
    id: String(id),
    runKey: String(runCtx.runKey || ""),
    sessionId: String(data.sessionId || runCtx.sessionId || ""),
  };
  const deadRunError = I18n.t("发起轮已结束，未执行");
  let replied = false;
  const finish = (result, error, opts) => {
    /* 一帧只有一次回执：确认后走 run()、或确认框自毁，谁先到算谁，绝不重复发帧 */
    if (replied) return;
    replied = true;
    window.api
      .dshInteract({ kind: "canvas", id, result, error: error || undefined })
      .then((res) => {
        /* stale = 网关侧这条 pending 已经没了（本轮结束 / 已被撤销）：插件那端
           早已收到 {t:'abort'} 并以失败收场，模型不会拿到半截结果。自毁路径自己
           会提示一次，这里别再重复刷屏；其余路径必须说明，否则用户以为改了。 */
        if (res && res.stale && !(opts && opts.silentStale))
          toast(I18n.t("画布操作已失效（发起轮已结束），未执行"), "warn");
      })
      .catch(() => {});
  };
  const opEarly = data.op || "get";
  if (
    isCanvasNodeAgentRun() &&
    (opEarly === "get" || opEarly === "edit" || opEarly === "app")
  ) {
    const err = canvasDeniedForAgentNodeError();
    finish({ ok: false, error: err }, err);
    return;
  }
  /* 规划模式：只读放行，任何画布 / 应用改动由宿主硬性拒绝（不弹确认，直接失败） */
  if (isPlanModeCanvasRun(runCtx) && canvasOpMutates(opEarly, data.params || {})) {
    const err = planModeCanvasDeniedError();
    finish({ ok: false, error: err }, err);
    return;
  }
  /* 发起轮已经结束（取消句柄被删）：与 ixPush 同一判活口径。这一帧的回执注定
     没人接，弹框就是一张「点了没反应」的死框 —— 直接不弹，回失败让模型继续。 */
  if (!canvasConfirmRunLive(frameOwner.runKey)) {
    canvasConfirmPruneOrphans();
    finish({ ok: false, error: deadRunError }, deadRunError, {
      silentStale: true,
    });
    return;
  }
  const run = async () => {
    try {
      let result;
      const opName = data.op || "get";
      if (opName === "app" || opName === "vision") {
        /* 应用级 / 识图：不绑定运行时画布袋 */
        result = await applyCanvasOp(opName, data.params || {}, runCtx);
      } else {
        const target = canvasTargetWf();
        result = await runAgainstWf(target, () =>
          applyCanvasOp(opName, data.params || {}, runCtx),
        );
      }
      finish(result, result && result.ok === false ? result.error || "" : "");
    } catch (e) {
      const error = (e && e.message) || String(e);
      finish({ ok: false, error }, error);
    }
  };
  const op = data.op || "get";
  if (canvasOpNeedsConfirm(op, data.params || {})) {
    const ask =
      op === "app"
        ? confirmAssistAppOp(data.params || {}, frameOwner)
        : confirmAssistCanvasEdit(data.params || {}, frameOwner);
    ask
      .then((ans) => {
        if (ans === IX_CONFIRM_DEAD) {
          /* 自动撤框：本轮已经收尾，操作不执行，回执按失败补上 */
          finish({ ok: false, error: deadRunError }, deadRunError, {
            silentStale: true,
          });
          toast(I18n.t("画布修改询问已自动关闭（发起轮已结束），未执行"), "warn");
          return;
        }
        if (!ans) {
          finish(
            { ok: false, error: I18n.t("用户拒绝了此次操作") },
            I18n.t("用户拒绝了此次操作"),
          );
          if (canvasConfirmFromAgentSession()) abortAgentSessionOnCanvasDeny();
          else if (S.assistRunActive)
            toast(
              I18n.t("已拒绝画布修改；助手将继续并说明已完成与未完成部分"),
              "warn",
            );
          return;
        }
        /* 本次 edit 已统一确认：内部 canvas_super 等勿再弹第二次询问 */
        S._canvasEditUserApproved = true;
        Promise.resolve(run()).finally(() => {
          S._canvasEditUserApproved = false;
        });
      })
      .catch(() => {
        finish(
          { ok: false, error: I18n.t("用户拒绝了此次操作") },
          I18n.t("用户拒绝了此次操作"),
        );
        if (canvasConfirmFromAgentSession()) abortAgentSessionOnCanvasDeny();
        else if (S.assistRunActive)
          toast(
            I18n.t("已拒绝画布修改；助手将继续并说明已完成与未完成部分"),
            "warn",
          );
      });
    return;
  }
  run();
}

function rectsOverlap(a, b, pad) {
  pad = pad || 0;
  return (
    a.x < b.x + b.w + pad &&
    a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad &&
    a.y + a.h + pad > b.y
  );
}

function layoutOrigin(obstacles) {
  if (!obstacles.length) return { x: snap(48), y: snap(48) };
  let maxX = -Infinity;
  let minY = Infinity;
  for (const n of obstacles) {
    /* 用绘制尺寸（展开超级节点 = expandW/H），否则新布局会叠到可见壳层上 */
    const sz = layoutNodeSize(n);
    maxX = Math.max(maxX, n.x + sz.w);
    minY = Math.min(minY, n.y);
  }
  return { x: snap(maxX + 96), y: snap(minY) };
}

function shiftToClear(placed, obstacles) {
  if (!obstacles.length) return { x: 0, y: 0 };
  const pad = 28;
  const hit = (dx, dy) => {
    for (const a of placed) {
      const sa = layoutNodeSize(a);
      const A = { x: a.x + dx, y: a.y + dy, w: sa.w, h: sa.h };
      for (const b of obstacles) {
        const sb = layoutNodeSize(b);
        if (rectsOverlap(A, { x: b.x, y: b.y, w: sb.w, h: sb.h }, pad)) return true;
      }
    }
    return false;
  };
  if (!hit(0, 0)) return { x: 0, y: 0 };
  const downs = [48, 96, 160, 240, 360, 520, 720, 960, 1280];
  const rights = [80, 160, 280, 420, 600, 840, 1100];
  for (const dy of downs) {
    if (!hit(0, dy)) return { x: 0, y: dy };
  }
  for (const dx of rights) {
    if (!hit(dx, 0)) return { x: dx, y: 0 };
    for (const dy of downs) {
      if (!hit(dx, dy)) return { x: dx, y: dy };
    }
  }
  return { x: 0, y: 1400 };
}

/* 排版收尾的兜底防重叠：
   - 用「绘制尺寸」（layoutNodeSize）判断，展开超级节点按 expandW/H 参与碰撞；
   - 任何残余重叠（绘制尺寸 ≠ 存储尺寸、跨组件装箱误差、障碍物误判、尺寸漂移等）
     都按「更省位移的轴、优先向下」推开，网格向上取整保证不欠推；
   - 多趟松弛直到干净或达到趟数上限（正常排版极少触发，纯兜底）。 */
const LAYOUT_OVERLAP_PAD = 10;
const LAYOUT_OVERLAP_MAX_PASS = 12;
function resolvePlacedOverlaps(nodes, obstacles, opts) {
  const pad = opts && opts.pad != null ? opts.pad : LAYOUT_OVERLAP_PAD;
  const placed = (nodes || []).filter(Boolean);
  const obs = (obstacles || []).filter(Boolean);
  if (placed.length < 2 && !obs.length) return 0;
  const g = grid();
  const rectOf = (n) => {
    const s = layoutNodeSize(n);
    return { x: n.x, y: n.y, w: s.w, h: s.h };
  };
  const centerY = (n) => n.y + layoutNodeSize(n).h / 2;
  const centerX = (n) => n.x + layoutNodeSize(n).w / 2;
  /* 稳定顺序（x → y），保证每次排版结果一致 */
  const order = placed.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  let total = 0;
  for (let pass = 0; pass < LAYOUT_OVERLAP_MAX_PASS; pass++) {
    let any = false;
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      const ra = rectOf(a);
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        const rb = rectOf(b);
        if (!rectsOverlap(ra, rb, pad)) continue;
        const ox = Math.min(ra.x + ra.w + pad, rb.x + rb.w + pad) - Math.max(ra.x, rb.x);
        const oy = Math.min(ra.y + ra.h + pad, rb.y + rb.h + pad) - Math.max(ra.y, rb.y);
        if (oy <= ox) {
          const low = centerY(a) <= centerY(b) ? b : a;
          low.y = Math.ceil((low.y + oy) / g) * g;
        } else {
          const right = centerX(a) <= centerX(b) ? b : a;
          right.x = Math.ceil((right.x + ox) / g) * g;
        }
        total++;
        any = true;
      }
      /* 障碍物只挡不推 */
      for (const o of obs) {
        const ro = rectOf(o);
        if (!rectsOverlap(ra, ro, pad)) continue;
        const ox = Math.min(ra.x + ra.w + pad, ro.x + ro.w + pad) - Math.max(ra.x, ro.x);
        const oy = Math.min(ra.y + ra.h + pad, ro.y + ro.h + pad) - Math.max(ra.y, ro.y);
        if (oy <= ox) a.y = Math.ceil((a.y + oy) / g) * g;
        else a.x = Math.ceil((a.x + ox) / g) * g;
        total++;
        any = true;
      }
    }
    if (!any) break;
  }
  return total;
}

function layoutNodePriority(n) {
  if (!n) return 9;
  if (isExecStart(n)) return -1;
  if (isExecEnd(n)) return 8;
  if (n.kind === "control") return 0;
  if (n.kind === "task") return 1;
  if (
    n.kind === "input_text" ||
    n.kind === "input_image" ||
    n.kind === "input_audio" ||
    n.kind === "input_video" ||
    /* 素材节点＝静态内容源，与输入族同一档：整理时排在最左 */
    n.kind === "asset"
  )
    return 2;
  if (n.kind === "split") return 3;
  if (n.kind === "merge" || n.kind === "global" || n.kind === "wait_file" || n.kind === "timer") return 4;
  if (n.kind === "delayer" || n.kind === "sequencer") return 4.2;
  if (
    n.kind === "gate" ||
    n.kind === "splitter" ||
    n.kind === "counter" ||
    n.kind === "mutex"
  )
    return 4.3;
  if (n.kind === "judge") return 4.5;
  if (
    n.kind === "proc_text" ||
    n.kind === "proc_image" ||
    n.kind === "agent_task"
  )
    return 5;
  if (isSaveNode(n)) return 6;
  return 5;
}

/* 分层从左到右排版：连通分量 + barycenter 减交叉 + 父子垂直对齐 */
function layoutNodeSize(n) {
  const sz = nodeDrawSize(n);
  return { w: Math.max(40, sz.w || 240), h: Math.max(40, sz.h || 160) };
}

function findLayoutComponents(nodes, wires) {
  const ids = new Set((nodes || []).map((n) => n.id));
  const parent = {};
  const find = (id) => {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]];
      id = parent[id];
    }
    return id;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const n of nodes || []) parent[n.id] = n.id;
  for (const w of wires || []) {
    if (ids.has(w.from) && ids.has(w.to)) unite(w.from, w.to);
  }
  const groups = new Map();
  for (const n of nodes || []) {
    const r = find(n.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n);
  }
  return [...groups.values()].map((ns) => {
    const set = new Set(ns.map((n) => n.id));
    return {
      nodes: ns,
      wires: (wires || []).filter((w) => set.has(w.from) && set.has(w.to)),
    };
  });
}

/* ============ 排版用边：关系线（rel）也参与分层 ============
   数据线：方向固定，原样保留（数据流排版行为不变）。
   关系线：按箭头定向（backward = 反向）；both / none 视为软约束；
   若某条有向关系边会让依赖图成环 → 降级为软约束。
   软约束不参与分层（分层必须无环），但参与「减交叉」重排与垂直对齐。
   —— 这样纯关系线构成的开发节点架构图也能得到真正的分层布局，
      而不是退化成一堆互不相连的方块网格。
   返回 { inEdges, outEdges, allIn, allOut }：hard = 分层用，all = 排序 / 对齐用。 */
function layoutEdgeSets(nodes, wires) {
  const ids = new Set(nodes.map((n) => n.id));
  const hard = [];
  const soft = [];
  const adj = new Map();
  const addAdj = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  const rels = [];
  for (const w of wires || []) {
    if (!ids.has(w.from) || !ids.has(w.to) || w.from === w.to) continue;
    if (!w.rel) {
      hard.push({ from: w.from, to: w.to });
      addAdj(w.from, w.to);
      continue;
    }
    const mode = typeof relArrowOf === "function" ? relArrowOf(w) : "forward";
    if (mode === "both" || mode === "none") {
      rels.push({ a: w.from, b: w.to, undirected: true, sort: 1e9 });
      continue;
    }
    const fwd = mode !== "backward";
    const from = fwd ? w.from : w.to;
    const to = fwd ? w.to : w.from;
    const nf = nodeById(from),
      nt = nodeById(to);
    rels.push({
      a: w.from,
      b: w.to,
      from,
      to,
      /* 稳定排序：按起点位置（上→下、左→右），保证每次排版结果一致 */
      sort: (nf ? (nf.y || 0) * 4 + (nf.x || 0) : 0) * 1e6 + (nt ? nt.y || 0 : 0),
    });
  }
  const reachable = (from, to) => {
    if (from === to) return true;
    const seen = new Set([from]);
    const q = [from];
    while (q.length) {
      const cur = q.shift();
      for (const nx of adj.get(cur) || []) {
        if (nx === to) return true;
        if (seen.has(nx)) continue;
        seen.add(nx);
        q.push(nx);
      }
    }
    return false;
  };
  rels
    .sort((x, y) => x.sort - y.sort || String(x.a).localeCompare(String(y.a)))
    .forEach((e) => {
      if (e.undirected) {
        soft.push({ a: e.a, b: e.b });
        return;
      }
      if (reachable(e.to, e.from)) {
        soft.push({ a: e.a, b: e.b }); /* 成环 → 只作软约束 */
        return;
      }
      hard.push({ from: e.from, to: e.to });
      addAdj(e.from, e.to);
    });
  const inEdges = {};
  const outEdges = {};
  const allIn = {};
  const allOut = {};
  for (const n of nodes) {
    inEdges[n.id] = [];
    outEdges[n.id] = [];
    allIn[n.id] = [];
    allOut[n.id] = [];
  }
  const addBoth = (m, a, b) => {
    if (!m[a]) return;
    m[a].push(b);
  };
  for (const e of hard) {
    addBoth(outEdges, e.from, e.to);
    addBoth(inEdges, e.to, e.from);
    addBoth(allOut, e.from, e.to);
    addBoth(allIn, e.to, e.from);
  }
  for (const e of soft) {
    addBoth(allOut, e.a, e.b);
    addBoth(allIn, e.b, e.a);
    addBoth(allOut, e.b, e.a);
    addBoth(allIn, e.a, e.b);
  }
  return { inEdges, outEdges, allIn, allOut };
}

function assignLayoutLayers(nodes, inEdges, outEdges) {
  /* 依赖图已尽量无环（见 layoutEdgeSets）；仍保留回边保护 */
  const layer = {};
  const visiting = new Set();
  const depthOf = (id) => {
    if (layer[id] != null) return layer[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of inEdges[id] || []) d = Math.max(d, depthOf(p) + 1);
    visiting.delete(id);
    layer[id] = d;
    return d;
  };
  for (const n of nodes) depthOf(n.id);
  const maxL = Math.max(0, ...Object.values(layer));
  const cols = [];
  for (let i = 0; i <= maxL; i++) cols[i] = [];
  for (const n of nodes) cols[layer[n.id] || 0].push(n);
  for (const col of cols) {
    if (!col || !col.length) continue;
    col.sort((a, b) => layoutNodePriority(a) - layoutNodePriority(b));
  }
  return cols;
}

function sortLayerByKey(col, keyOf) {
  return col
    .map((n, i) => ({ n, i, k: keyOf(n, i) }))
    .sort((a, b) => {
      if (a.k !== b.k) return a.k - b.k;
      return a.i - b.i;
    })
    .map((x) => x.n);
}

function orderLayersByBarycenter(cols, inEdges, outEdges) {
  const layerOf = new Map();
  cols.forEach((col, i) => {
    if (!col) return;
    for (const n of col) layerOf.set(n.id, i);
  });
  const nbrs = (id) => {
    const a = inEdges[id] || [];
    const b = outEdges[id] || [];
    return a.length && !b.length ? a : a.concat(b);
  };
  /* 邻居用「所在层内的序号」加权，跨层越远权重越低：
     这样长距离关系边（跨 2+ 层）也会拉动排序，而不只是相邻层。 */
  for (let pass = 0; pass < 8; pass++) {
    const idx = new Map();
    cols.forEach((col) => {
      if (!col) return;
      col.forEach((n, i) => idx.set(n.id, i));
    });
    const order = cols.map((_, i) => i);
    if (pass % 2) order.reverse();
    for (const i of order) {
      const col = cols[i];
      if (!col || col.length < 2) continue;
      const keys = col.map((n, ord) => {
        let sum = 0,
          wsum = 0;
        for (const nb of nbrs(n.id)) {
          const L = layerOf.get(nb);
          if (L == null) continue;
          const at = idx.has(nb) ? idx.get(nb) : ord;
          const w = 1 / (1 + Math.abs(L - i));
          sum += at * w;
          wsum += w;
        }
        return wsum ? sum / wsum : ord + layoutNodePriority(n) * 0.01;
      });
      cols[i] = sortLayerByKey(col, (_n, k) => keys[k]);
    }
  }
}

function resolveLayerOverlaps(col, gapY) {
  if (!col || col.length < 2) return;
  const sorted = col.slice().sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const psz = layoutNodeSize(prev);
    const minY = prev.y + psz.h + gapY;
    if (cur.y < minY) cur.y = snap(minY);
  }
}

function alignLayerToParents(col, inEdges, nodeMap, gapY, originY, outEdges) {
  if (!col || !col.length) return;
  /* 期望纵位 = 邻居中心均值（入边权重 2，出边权重 1）：
     纯关系线构成的架构图里，两侧邻居都要参与靠拢 */
  const desired = col.map((n) => {
    let sum = 0,
      wsum = 0;
    const acc = (id, w) => {
      const p = nodeMap.get(id);
      if (!p) return;
      sum += (p.y + layoutNodeSize(p).h / 2) * w;
      wsum += w;
    };
    for (const id of inEdges[n.id] || []) acc(id, 2);
    if (outEdges) for (const id of outEdges[n.id] || []) acc(id, 1);
    return wsum ? sum / wsum : null;
  });
  const order = col
    .map((n, i) => ({ n, i, d: desired[i], p: layoutNodePriority(n) }))
    .sort((a, b) => {
      if (a.d != null && b.d != null) return a.d - b.d;
      if (a.d != null) return -1;
      if (b.d != null) return 1;
      return a.p - b.p;
    });
  let y = originY;
  for (const it of order) {
    const n = it.n;
    const sz = layoutNodeSize(n);
    let ny = it.d != null ? it.d - sz.h / 2 : y;
    ny = Math.max(ny, y);
    n.y = snap(ny);
    y = n.y + sz.h + gapY;
  }
  resolveLayerOverlaps(col, gapY);
}

function layoutFlowComponent(nodes, wires, origin, opts) {
  if (!nodes.length) return { w: 0, h: 0 };
  opts = opts || {};
  const gapX = opts.gapX != null ? opts.gapX : 80;
  const gapY = opts.gapY != null ? opts.gapY : 48;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  /* hard 边（无环）决定分层；all 边（含软约束）决定减交叉与垂直靠拢 */
  const { inEdges, outEdges, allIn, allOut } = layoutEdgeSets(nodes, wires);
  const cols = assignLayoutLayers(nodes, inEdges, outEdges);
  orderLayersByBarycenter(cols, allIn, allOut);

  const colWidths = cols.map((col) =>
    Math.max(40, ...(col || []).map((n) => layoutNodeSize(n).w)),
  );
  let x = origin.x;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i] || [];
    if (!col.length) continue;
    for (const n of col) n.x = snap(x);
    alignLayerToParents(col, allIn, nodeMap, gapY, origin.y, allOut);
    for (let pass = 0; pass < 2; pass++) {
      alignLayerToParents(col, allIn, nodeMap, gapY, origin.y, allOut);
    }
    x += colWidths[i] + gapX;
  }

  const bb = nodesBBox(nodes);
  if (!bb) return { w: 0, h: 0 };
  return { w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, minX: bb.minX, minY: bb.minY };
}

function layoutFlow(nodes, wires, origin, obstacles) {
  /* 不写死间距：有 relation 线时 layoutFlowEx 自动放宽走廊 */
  layoutFlowEx(nodes, wires, origin, obstacles, {});
}

/* 关系线主导的图（开发节点架构图）需要更宽的间距：直线才少穿方块、少叠在一起 */
const LAYOUT_REL_GAP_X = 164;
const LAYOUT_REL_GAP_Y = 72;
function relWiresIn(wires) {
  for (const w of wires || []) if (w && w.rel) return true;
  return false;
}

function layoutFlowEx(nodes, wires, origin, obstacles, opts) {
  if (!nodes.length) return;
  /* 关系线也参与排版：按箭头定向，成环的降级为软约束（见 layoutEdgeSets） */
  opts = opts || {};
  const hasRel = relWiresIn(wires);
  /* 有关系线时列/行间距至少留够宽度（调用方给的更小值会被抬到下限） */
  const gapX =
    opts.gapX != null
      ? Math.max(opts.gapX, hasRel ? LAYOUT_REL_GAP_X : 0)
      : hasRel
        ? LAYOUT_REL_GAP_X
        : 80;
  const gapY =
    opts.gapY != null
      ? Math.max(opts.gapY, hasRel ? LAYOUT_REL_GAP_Y : 0)
      : hasRel
        ? LAYOUT_REL_GAP_Y
        : 48;
  const compGapX =
    opts.compGapX != null
      ? Math.max(opts.compGapX, hasRel ? 208 : 0)
      : hasRel
        ? 208
        : 128;
  const compGapY =
    opts.compGapY != null
      ? Math.max(opts.compGapY, hasRel ? 160 : 0)
      : hasRel
        ? 160
        : 120;
  const maxRowW = opts.maxRowW != null ? opts.maxRowW : 4400;
  const components = findLayoutComponents(nodes, wires);
  components.sort((a, b) => b.nodes.length - a.nodes.length);

  let cursorX = origin.x;
  let cursorY = origin.y;
  let rowMaxH = 0;
  const compOpts = Object.assign({}, opts, { gapX, gapY });

  for (const comp of components) {
    const relOrigin = { x: 0, y: 0 };
    layoutFlowComponent(comp.nodes, comp.wires, relOrigin, compOpts);
    const compBb = nodesBBox(comp.nodes);
    if (!compBb) continue;
    const w = compBb.maxX - compBb.minX;
    const h = compBb.maxY - compBb.minY;

    if (cursorX > origin.x && cursorX + w > origin.x + maxRowW) {
      cursorX = origin.x;
      cursorY += rowMaxH + compGapY;
      rowMaxH = 0;
    }

    const dx = cursorX - compBb.minX;
    const dy = cursorY - compBb.minY;
    for (const n of comp.nodes) {
      n.x = snap(n.x + dx);
      n.y = snap(n.y + dy);
    }
    cursorX += w + compGapX;
    rowMaxH = Math.max(rowMaxH, h);
  }

  const sh = shiftToClear(nodes, obstacles || []);
  if (sh.x || sh.y) {
    for (const n of nodes) {
      n.x = snap(n.x + sh.x);
      n.y = snap(n.y + sh.y);
    }
  }

  /* 兜底防重叠：任何残余重叠（绘制尺寸 ≠ 存储尺寸、跨组件装箱误差、障碍物误判、
     尺寸漂移等）都在这里按最小位移推开，保证排版结果互不压住 */
  resolvePlacedOverlaps(nodes, obstacles || []);
}

function nodesBBox(nodes) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes || []) {
    /* 用绘制尺寸：展开超级节点按 expandW/H 参与包围盒，组件装箱才不会互相压住 */
    const sz = layoutNodeSize(n);
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + sz.w);
    maxY = Math.max(maxY, n.y + sz.h);
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function nodeHasVisibleImage(node) {
  if (!node) return false;
  if (node.kind === "input_image") {
    if (node.imageAsset) return true;
    return (node.entries || []).some((e) => e && e.path);
  }
  if (
    node.kind === "proc_image" ||
    (isSaveNode(node) && saveMediaKind(node) === "image")
  ) {
    if (node.output && node.output.path) return true;
    if ((node.batchOutputs || []).some((x) => x && x.output && x.output.path))
      return true;
    if ((node.entries || []).some((e) => e && e.path)) return true;
  }
  return false;
}

/* 美观尺寸：图像节点便于观察；文本可读；控制保持默认 */
function sizeNodeForTidy(node) {
  const d = NODE_DEFAULTS[node.kind];
  if (!d) return;
  const kind = node.kind;
  const hasImg = nodeHasVisibleImage(node);
  const batchN =
    isBatch(node) && Array.isArray(node.entries) ? node.entries.length : 0;

  if (kind === "control") {
    if (isExecStart(node) || isExecEnd(node)) {
      node.w = 180;
      node.h = 96;
      return;
    }
    node.w = d.w;
    node.h = d.h;
    return;
  }
  if (kind === "task") {
    node.w = snap(Math.max(d.w, 280));
    node.h = snap(Math.max(d.h, 220));
    return;
  }
  if (kind === "judge") {
    node.w = snap(Math.max(d.w, 240));
    node.h = snap(Math.max(d.h, 160));
    return;
  }
  if (kind === "input_image" || kind === "proc_image") {
    if (hasImg) {
      node.w = snap(batchN > 1 ? 320 : 300);
      node.h = snap(batchN > 1 ? 280 : 250);
    } else {
      node.w = snap(d.w);
      node.h = snap(d.h);
    }
    return;
  }
  /* 素材节点：一条内容一行 —— 高度随条目数与类型走（图像 / 视频行更高），
     放不下就交给 body 自己的滚动条（需求：内容依次排列、允许下拉）。 */
  if (kind === "asset") {
    const items = assetItems(node);
    let rows = 0;
    for (const it of items)
      rows +=
        it.type === "image"
          ? 152
          : it.type === "video"
            ? 196
            : it.type === "audio"
              ? 108
              : 122;
    node.w = snap(Math.max(d.w, 300));
    node.h = snap(Math.max(d.h, Math.min(620, 64 + rows)));
    return;
  }
  if (isSaveKind(kind) && saveMediaKind(node) === "image") {
    node.w = snap(hasImg ? 280 : d.w);
    node.h = snap(hasImg ? 230 : d.h);
    return;
  }
  if (kind === "input_text") {
    const body = isBatch(node)
      ? (node.entries || [])
          .map((e) => String((e && e.content) || ""))
          .join("\n")
      : String(node.text || "");
    const lines = Math.min(
      14,
      Math.max(4, body.split(/\n/).length + Math.floor(body.length / 56)),
    );
    node.w = snap(Math.min(320, Math.max(d.w, 220)));
    node.h = snap(Math.min(280, Math.max(d.h, 40 + lines * 16)));
    return;
  }
  if (isSaveKind(kind) || kind === "split" || kind === "merge" || kind === "global" || kind === "wait_file" || kind === "timer" || kind === "delayer" || kind === "sequencer" || kind === "gate" || kind === "splitter" || kind === "counter" || kind === "mutex") {
    node.w = d.w;
    node.h = d.h;
    return;
  }
  sizeNodeForContent(node);
  node.w = snap(Math.max(d.w, Math.min(node.w, 360)));
  node.h = snap(Math.max(d.h, Math.min(node.h, 280)));
}

function nodeCenter(n) {
  return { x: n.x + (n.w || 0) / 2, y: n.y + (n.h || 0) / 2 };
}

function nodesInsideMarkBounds(m, nodes, slop) {
  const b = markBounds(m);
  if (!b) return [];
  const pad = slop == null ? 12 : slop;
  const out = [];
  for (const n of nodes || []) {
    const c = nodeCenter(n);
    if (
      c.x >= b.x - pad &&
      c.x <= b.x + b.w + pad &&
      c.y >= b.y - pad &&
      c.y <= b.y + b.h + pad
    )
      out.push(n.id);
  }
  return out;
}

function nearestNodeId(x, y, nodes) {
  let best = null;
  let bestD = Infinity;
  for (const n of nodes || []) {
    const c = nodeCenter(n);
    const d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
    if (d < bestD) {
      bestD = d;
      best = n.id;
    }
  }
  return best;
}

/* 排版前记录绘制与节点的从属关系，排版后重新包住 / 定位 */
function captureMarkBindings(nodes) {
  const list = marksOf();
  const boxes = list.filter((m) => m.kind === "box");
  const bindings = [];
  for (const m of list) {
    let nodeIds = nodesInsideMarkBounds(m, nodes);
    /* 同组的 markIds ↔ nodeIds 一并关联 */
    for (const g of S.wf.groups || []) {
      ensureGroupArrays(g);
      if ((g.markIds || []).includes(m.id)) {
        for (const nid of g.nodeIds || []) {
          if (!nodeIds.includes(nid)) nodeIds.push(nid);
        }
      }
    }
    /* 文本若未包住节点：挂到正下方最近框体所包的节点，或最近节点 */
    if (m.kind === "text" && !nodeIds.length) {
      const mc = { x: m.x + (m.w || 0) / 2, y: m.y + (m.h || 0) / 2 };
      let bestBox = null;
      let bestDy = Infinity;
      for (const b of boxes) {
        const bb = markBounds(b);
        if (!bb) continue;
        const cx = bb.x + bb.w / 2;
        if (Math.abs(cx - mc.x) > bb.w / 2 + 40) continue;
        const dy = bb.y - (m.y + (m.h || 0));
        if (dy >= -8 && dy < bestDy && dy < 100) {
          bestDy = dy;
          bestBox = b;
        }
      }
      if (bestBox) {
        nodeIds = nodesInsideMarkBounds(bestBox, nodes);
      }
      if (!nodeIds.length) {
        const nid = nearestNodeId(mc.x, mc.y, nodes);
        if (nid) nodeIds = [nid];
      }
    }
    let pad = 36;
    let labelAbove = false;
    if (m.kind === "box" && nodeIds.length) {
      const ns = nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
      const nb = nodesBBox(ns);
      if (nb) {
        const left = Math.max(0, nb.minX - m.x);
        const top = Math.max(0, nb.minY - m.y);
        const right = Math.max(0, m.x + (m.w || 0) - nb.maxX);
        const bottom = Math.max(0, m.y + (m.h || 0) - nb.maxY);
        pad = Math.round(
          Math.max(24, Math.min(64, (left + top + right + bottom) / 4)),
        );
      }
    }
    if (m.kind === "text" && nodeIds.length) {
      const ns = nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
      const nb = nodesBBox(ns);
      if (nb && m.y + (m.h || 0) <= nb.minY + 8) labelAbove = true;
    }
    let fromId = null;
    let toId = null;
    let fromOff = null;
    let toOff = null;
    if (m.kind === "arrow") {
      const x2 = m.x2 != null ? m.x2 : m.x;
      const y2 = m.y2 != null ? m.y2 : m.y;
      fromId = nearestNodeId(m.x, m.y, nodes);
      toId = nearestNodeId(x2, y2, nodes);
      const fn = nodes.find((n) => n.id === fromId);
      const tn = nodes.find((n) => n.id === toId);
      if (fn) fromOff = { dx: m.x - fn.x, dy: m.y - fn.y };
      if (tn) toOff = { dx: x2 - tn.x, dy: y2 - tn.y };
    }
    let anchorOff = null;
    if ((m.kind === "text" || m.kind === "box") && nodeIds.length === 1) {
      const n = nodes.find((x) => x.id === nodeIds[0]);
      if (n) anchorOff = { dx: m.x - n.x, dy: m.y - n.y, w: m.w, h: m.h };
    }
    bindings.push({
      id: m.id,
      kind: m.kind,
      nodeIds,
      pad,
      labelAbove,
      fromId,
      toId,
      fromOff,
      toOff,
      anchorOff,
    });
  }
  return bindings;
}

function rebindMarksAfterLayout(bindings) {
  for (const b of bindings || []) {
    const m = markById(b.id);
    if (!m) continue;
    const ns = (b.nodeIds || [])
      .map((id) => nodeById(id))
      .filter(Boolean);
    if (m.kind === "box" && ns.length) {
      const nb = nodesBBox(ns);
      if (!nb) continue;
      const pad = b.pad != null ? b.pad : 36;
      m.x = snap(nb.minX - pad);
      m.y = snap(nb.minY - pad);
      m.w = snap(Math.max(40, nb.maxX - nb.minX + pad * 2));
      m.h = snap(Math.max(40, nb.maxY - nb.minY + pad * 2));
      continue;
    }
    if (m.kind === "text" && ns.length) {
      const nb = nodesBBox(ns);
      if (!nb) continue;
      if (b.labelAbove || ns.length > 1) {
        m.x = snap(nb.minX);
        m.y = snap(nb.minY - (m.h || 40) - 10);
      } else if (b.anchorOff) {
        m.x = snap(ns[0].x + b.anchorOff.dx);
        m.y = snap(ns[0].y + b.anchorOff.dy);
      } else {
        m.x = snap(nb.minX);
        m.y = snap(nb.minY - (m.h || 40) - 10);
      }
      continue;
    }
    if (m.kind === "arrow") {
      const fn = b.fromId ? nodeById(b.fromId) : null;
      const tn = b.toId ? nodeById(b.toId) : null;
      if (fn && b.fromOff) {
        m.x = snap(fn.x + b.fromOff.dx);
        m.y = snap(fn.y + b.fromOff.dy);
      } else if (fn) {
        m.x = snap(fn.x + fn.w);
        m.y = snap(fn.y + fn.h / 2);
      }
      if (tn && b.toOff) {
        m.x2 = snap(tn.x + b.toOff.dx);
        m.y2 = snap(tn.y + b.toOff.dy);
      } else if (tn) {
        m.x2 = snap(tn.x);
        m.y2 = snap(tn.y + tn.h / 2);
      }
    }
  }
}

/**
 * 一键整洁排版（可撤销）：
 * - 分层从左到右，间距舒适美观
 * - 列内：面向用户可编辑/操作的节点靠上
 * - 图像节点尺寸便于观察
 * - 绘制框体/文字/箭头按排版前绑定的节点重新包住或定位
 * - opts.includeSuperInner：同时排版各超级节点内部（各自独立局部坐标）
 */
function tidyLayoutWorkflow(opts) {
  opts = opts || {};
  if (!S.wf) {
    if (opts.notify !== false) toast(I18n.t("当前没有打开的画布"), "warn");
    return { ok: false, error: I18n.t("当前没有打开的画布") };
  }
  const focus = currentTaskFocus();
  const topNodes = (S.wf.nodes || []).filter(
    (n) =>
      !isSuperIoNode(n) &&
      !nodeParentSuperId(n) &&
      nodeParentTaskId(n) === focus,
  );
  if (!topNodes.length && !opts.includeSuperInner) {
    if (opts.notify !== false) toast(I18n.t("画布上没有节点"), "warn");
    return { ok: false, error: I18n.t("画布上没有节点") };
  }
  if (opts.history !== false && !S._skipCanvasHistory) pushHistory();

  let markBindings = [];
  if (topNodes.length) {
    const beforePos = {};
    for (const n of topNodes) beforePos[n.id] = { x: n.x, y: n.y };
    markBindings = captureMarkBindings(topNodes);
    for (const n of topNodes) sizeNodeForTidy(n);

    const topIds = new Set(topNodes.map((n) => n.id));
    const topWires = (S.wf.wires || []).filter(
      (w) => topIds.has(w.from) && topIds.has(w.to),
    );
    layoutFlowEx(topNodes, topWires, { x: snap(64), y: snap(64) }, [], {
      gapX: 96,
      gapY: 56,
      prioritizeEditable: true,
    });

    /* 整体贴到画布左上，留出边距 */
    const neu = nodesBBox(topNodes);
    if (neu) {
      const dx0 = snap(64 - neu.minX);
      const dy0 = snap(64 - neu.minY);
      if (dx0 || dy0) {
        for (const n of topNodes) {
          n.x = snap(n.x + dx0);
          n.y = snap(n.y + dy0);
        }
      }
    }

    rebindMarksAfterLayout(markBindings);

    /* 未关联到节点的顶层绘制：按节点平均位移平移 */
    const boundIds = new Set(
      (markBindings || [])
        .filter((b) => (b.nodeIds && b.nodeIds.length) || b.fromId || b.toId)
        .map((b) => b.id),
    );
    let sumDx = 0,
      sumDy = 0,
      nMove = 0;
    for (const n of topNodes) {
      const p = beforePos[n.id];
      if (!p) continue;
      sumDx += n.x - p.x;
      sumDy += n.y - p.y;
      nMove++;
    }
    if (nMove) {
      const dx = sumDx / nMove;
      const dy = sumDy / nMove;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        for (const m of marksOf()) {
          if (markParentSuperId(m)) continue;
          if (boundIds.has(m.id)) continue;
          m.x = (Number(m.x) || 0) + dx;
          m.y = (Number(m.y) || 0) + dy;
        }
      }
    }
  }

  let innerCount = 0;
  if (opts.includeSuperInner) {
    innerCount = tidyAllSuperInners({
      history: false,
      render: false,
      save: false,
    }).nodes;
  }

  if (S.view !== "workflow") setView("workflow");
  renderCanvas();
  fitCanvas();
  scheduleSave(true);
  if (opts.notify !== false) {
    toast(
      innerCount
        ? I18n.t("已整理排版（含超级节点内部）")
        : I18n.t("已整理排版"),
      "ok",
    );
  }
  return {
    ok: true,
    nodes: topNodes.length,
    innerNodes: innerCount,
    marks: markBindings.length,
  };
}

/** 单个超级节点内部子图排版（关系线感知 + 壳层按内容撑开）；返回排版的孩子数 */
function tidyOneSuperInner(s) {
  const kids = superChildrenOf(s.id).filter((c) => !isSuperIoNode(c));
  if (!kids.length) {
    s.innerPanX = 0;
    s.innerPanY = 0;
    return 0;
  }
  const markBindings = captureMarkBindings(kids);
  for (const n of kids) sizeNodeForTidy(n);
  const ids = new Set(kids.map((n) => n.id));
  const wires = (S.wf.wires || []).filter(
    (w) => ids.has(w.from) && ids.has(w.to),
  );
  /* 开发节点（架构图）内部：关系线主导，需要更宽间距让直线少穿方块、彼此可辨 */
  const isDev = kids.some((n) => n.dev);
  layoutFlowEx(kids, wires, { x: snap(16), y: snap(16) }, [], {
    gapX: isDev ? 196 : 72,
    gapY: isDev ? 92 : 48,
    prioritizeEditable: true,
  });
  const bb = nodesBBox(kids);
  if (bb) {
    const dx = snap(16 - bb.minX);
    const dy = snap(16 - bb.minY);
    if (dx || dy) {
      for (const n of kids) {
        n.x = snap(n.x + dx);
        n.y = snap(n.y + dy);
      }
    }
  }
  rebindMarksAfterLayout(markBindings);
  s.innerPanX = 0;
  s.innerPanY = 0;
  alignSuperContentTopLeft(s);
  fitSuperShellToContent(s, { shrink: isDev });
  return kids.length;
}

/** 展开某壳层及其所有子孙壳层，由内向外排版（开发节点「整理架构」入口） */
function tidySuperInnerTree(host) {
  if (!host || host.kind !== "super") return 0;
  const list = [host];
  const seen = new Set([host.id]);
  const walk = (id) => {
    for (const c of superChildrenOf(id)) {
      if (!c || c.kind !== "super" || seen.has(c.id)) continue;
      seen.add(c.id);
      list.push(c);
      walk(c.id);
    }
  };
  walk(host.id);
  list.sort((a, b) => superNestDepth(b) - superNestDepth(a));
  let n = 0;
  for (const s of list) n += tidyOneSuperInner(s);
  return n;
}

/** 开发节点右键：按关系线分层整理本功能块内部架构图 */
function tidyDevArchitecture(host) {
  if (!host || host.kind !== "super") {
    toast(I18n.t("请先选中一个开发节点"), "warn");
    return;
  }
  const kids = superChildrenOf(host.id).filter((c) => !isSuperIoNode(c));
  if (!kids.length) {
    toast(I18n.t("该功能块内部还没有子元素，无需整理"), "warn");
    return;
  }
  pushHistory();
  const n = tidySuperInnerTree(host);
  renderCanvas();
  scheduleSave(true);
  toast(
    I18n.t("已按关系线整理内部排版（{n} 个元素）", { n: n }),
    "ok",
  );
}

/** 对每个超级节点内部子图独立排版，并重置内部平移到左上 */
function tidyAllSuperInners(opts) {
  opts = opts || {};
  if (!S.wf) return { ok: false, nodes: 0 };
  if (opts.history && !S._skipCanvasHistory) pushHistory();
  const focus = currentTaskFocus();
  const supers = (S.wf.nodes || []).filter(
    (n) => n.kind === "super" && nodeParentTaskId(n) === focus,
  );
  /* 由内向外：深层壳层先撑开，父壳层才量得准 */
  supers.sort((a, b) => superNestDepth(b) - superNestDepth(a));
  let total = 0;
  for (const s of supers) total += tidyOneSuperInner(s);
  if (opts.render !== false) renderCanvas();
  if (opts.save !== false) scheduleSave(true);
  return { ok: true, nodes: total };
}

/* 顶栏一键排版：整洁排版（可选同时整理超级节点内部） */
async function oneClickAutoLayout(opts) {
  opts = opts || {};
  if (!S.wf || !(S.wf.nodes || []).length) {
    toast(I18n.t("画布上没有节点"), "warn");
    return;
  }
  const focus = currentTaskFocus();
  const hasInner = (S.wf.nodes || []).some(
    (n) =>
      n.kind === "super" &&
      nodeParentTaskId(n) === focus &&
      superChildrenOf(n.id).some((c) => !isSuperIoNode(c)),
  );
  let includeInner =
    opts.includeSuperInner == null ? false : !!opts.includeSuperInner;
  if (!opts.skipConfirm) {
    if (
      !(await confirmDialog(
        I18n.t(
          "确定进行一键排版？\n\n将按连线与关系线整理节点位置（可撤销）。",
        ),
        { title: I18n.t("一键排版"), okText: I18n.t("开始排版") },
      ))
    )
      return;
    if (hasInner && opts.includeSuperInner == null) {
      includeInner = await confirmDialog(
        I18n.t(
          "是否同时排版超级节点内部？\n\n「同时排版内部」会整理各超级节点内的子节点；「仅排版画布」只调整顶层节点。",
        ),
        {
          title: I18n.t("一键排版"),
          okText: I18n.t("同时排版内部"),
          cancelText: I18n.t("仅排版画布"),
        },
      );
    }
  }
  tidyLayoutWorkflow({
    includeSuperInner: includeInner,
    history: true,
    notify: true,
  });
}

function sizeNodeForContent(node) {
  const d = NODE_DEFAULTS[node.kind];
  if (!d) return;
  const body = String(node.text || node.prompt || node.task || node.goal || "");
  const extra = Math.min(160, Math.floor(Math.max(0, body.length - 48) / 72) * 18);
  node.h = Math.max(d.h, d.h + extra);
  if (!(node.w >= d.w)) node.w = d.w;
}

/* 文生图每次只出 1 张：检测 agent 写的「多张图」类提示，写入 warnings 反馈 */
function looksLikeMultiImagePrompt(prompt) {
  const s = String(prompt || "");
  if (!s.trim()) return false;
  if (
    /生成\s*[二三四五六七八九十百\d１２３４５６７８９０]+\s*张/.test(s) ||
    /输出\s*[二三四五六七八九十百\d]+\s*张/.test(s) ||
    /画\s*[二三四五六七八九十百\d]+\s*张/.test(s) ||
    /一共\s*[二三四五六七八九十百\d]+\s*张/.test(s) ||
    /多张图|多张图像|一组图|若干张|几张图/.test(s)
  )
    return true;
  if (
    /\b(generate|create|draw|output|make)\s+(\d+|two|three|four|five|six|several|multiple)\s+(images?|pictures?|shots?|variants?)\b/i.test(
      s,
    ) ||
    /\b(several|multiple|a\s+set\s+of)\s+(images?|pictures?)\b/i.test(s) ||
    /\bN\s*=\s*[2-9]\b/.test(s)
  )
    return true;
  return false;
}
function warnIfProcImageMultiPrompt(node, warnings) {
  if (!node || node.kind !== "proc_image" || !warnings) return;
  if (!looksLikeMultiImagePrompt(node.prompt)) return;
  warnings.push(
    I18n.t(
      "文生图每次只生成 1 张：请改写 prompt 为单张描述；多图请用批量条目 / 多个节点 / attempts×N",
    ) +
      "（" +
      (node.title || "proc_image") +
      "）",
  );
}

function applyNodePatch(node, patch, warnings) {
  if (!patch || !node) return;
  if (patch.setTitle)
    node.title = uniqueNodeTitle(String(patch.setTitle), node.id);
  if (patch.text != null && node.kind === "input_text")
    node.text = String(patch.text);
  if (
    patch.prompt != null &&
    (node.kind === "proc_text" || node.kind === "proc_image")
  ) {
    node.prompt = String(patch.prompt);
    warnIfProcImageMultiPrompt(node, warnings);
  }
  if (patch.task != null && node.kind === "agent_task")
    node.task = String(patch.task);
  if (node.kind === "task") {
    if (patch.goal != null) node.goal = String(patch.goal);
    if (patch.steps != null) {
      const arr = Array.isArray(patch.steps) ? patch.steps : [];
      node.steps = arr.map((s) => {
        if (typeof s === "string")
          return { id: uid("ts"), title: s, done: false };
        return {
          id: (s && s.id) || uid("ts"),
          title: String((s && s.title) || ""),
          done: !!(s && s.done),
        };
      });
    }
  }
  if (patch.parentTaskId != null) {
    const raw = String(patch.parentTaskId || "").trim();
    if (!raw) node.parentTaskId = "";
    else {
      const p = nodeById(raw);
      if (p && p.kind === "task" && p.id !== node.id)
        node.parentTaskId = p.id;
    }
  }
  /* parentSuperId / packIntoSuper：create 批次内 alias 在 applyCanvasEdit 后置循环解析；
     此处仅处理已是真实 id 的更新，或清空拆出 */
  if (patch.parentSuperId != null || patch.packIntoSuper != null) {
    const raw = String(
      patch.parentSuperId != null ? patch.parentSuperId : patch.packIntoSuper || "",
    ).trim();
    if (!raw) {
      node.parentSuperId = "";
    } else {
      const p = nodeById(raw);
      if (p && p.kind === "super" && canMoveNodeIntoSuper(p, node)) {
        node.parentSuperId = p.id;
        node.parentTaskId = p.parentTaskId || "";
        rewriteNodePathsForSuperContext(node);
      }
    }
  }
  if (node.kind === "super") {
    if (patch.note != null) node.note = String(patch.note);
    if (typeof patch.expandW === "number" && isFinite(patch.expandW))
      node.expandW = Math.max(320, Math.round(patch.expandW));
    if (typeof patch.expandH === "number" && isFinite(patch.expandH))
      node.expandH = Math.max(220, Math.round(patch.expandH));
    if (patch.subFolder != null) {
      node.subFolder = normalizeSuperSubFolder(String(patch.subFolder));
      for (const c of (S.wf.nodes || [])) {
        if (!c || c.id === node.id) continue;
        if (!isSuperAncestorOf(node.id, c.id)) continue;
        rewriteNodePathsForSuperContext(c);
      }
    }
    if (typeof patch.superOpen === "boolean") node.superOpen = patch.superOpen;
    if (typeof patch.db === "boolean") {
      node.db = patch.db;
      if (node.db && !String(node.subFolder || "").trim()) node.subFolder = "db";
      if (node.db) node.dev = false;
    }
    if (patch.dbMode === "super" || patch.dbMode === "db")
      node.dbMode = patch.dbMode;
    if (typeof patch.dev === "boolean") {
      node.dev = patch.dev;
      if (node.dev) node.db = false;
    }
    if (patch.devPath != null)
      node.devPath = String(patch.devPath).trim();
    if (patch.devStatus != null) {
      const v = String(patch.devStatus);
      if (v === "pending" || v === "wip" || v === "done") node.devStatus = v;
    }
    if (patch.devKind != null) {
      const v = String(patch.devKind);
      if (DEV_KINDS.indexOf(v) >= 0) node.devKind = v;
      else warnings.push(I18n.t("未知元素类型：") + v);
    }
    if (patch.devColor != null) {
      const v = String(patch.devColor);
      node.devColor =
        typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)
          ? v.toLowerCase()
          : "";
    }
    /* 开发节点 Agent 模型（本块 + 未自行选择的子块共用）；传空串 = 取消选择 */
    if (patch.devModel != null) {
      const v = String(patch.devModel).trim();
      node.devModel = v;
      if (!v) node.devProvider = "";
    }
    if (patch.devProvider != null) {
      const v = String(patch.devProvider).trim();
      node.devProvider =
        typeof devAgentRoutes === "function" &&
        devAgentRoutes().indexOf(v) >= 0
          ? v
          : "";
      if (!node.devModel) node.devProvider = "";
    }
    /* 开发节点 Agent 预设 / 思考强度：与本块模型同一条就近继承链，传空串 = 取消
       选择（回到跟随默认）。未知值一律丢弃并回报，画布上不留不存在的档位。 */
    if (patch.devPreset != null) {
      const raw = String(patch.devPreset).trim();
      if (!raw) node.devPreset = "";
      else {
        const id =
          typeof agentPresetId === "function" ? agentPresetId(raw) : raw;
        const known =
          typeof AGENT_PRESETS !== "undefined" &&
          Array.isArray(AGENT_PRESETS) &&
          AGENT_PRESETS.some((p) => String(p.id) === String(id));
        if (known) node.devPreset = id;
        else warnings.push(I18n.t("未知 Agent 预设：") + raw);
      }
    }
    if (patch.devEffort != null) {
      const v = String(patch.devEffort).trim().toLowerCase();
      const known =
        typeof AGENT_EFFORT_ORDER !== "undefined" &&
        Array.isArray(AGENT_EFFORT_ORDER)
          ? AGENT_EFFORT_ORDER.indexOf(v) >= 0
          : v === "low" ||
            v === "medium" ||
            v === "high" ||
            v === "xhigh" ||
            v === "max";
      if (!v) node.devEffort = "";
      else if (known) node.devEffort = v;
      else warnings.push(I18n.t("未知思考强度档位：") + v);
    }
    /* 核心文件列表（node.devFiles · 最多 10 条 · 相对本块项目根）：
       归一化与上限只在 devCoreFilesNormalize 一处做（与 UI 编辑 / 自动兜底同一函数）；
       非开发块与最外层（项目）开发块一律拒绝写入并回报原因。 */
    if (patch.devFiles != null) {
      const who = "（" + (node.title || node.id) + "）";
      const arr = Array.isArray(patch.devFiles)
        ? patch.devFiles
        : typeof patch.devFiles === "string"
          ? patch.devFiles.split(/[\r\n]+|[,，;；]\s*/)
          : null;
      /* 本批次里 parentSuperId 可能是 alias，要到 patch 之后才解析成真实父级；
         spec 声明了父级就先按「会被挂进上层块」处理，别把新建的子块误判成顶层块 */
      const willNest =
        patch.parentSuperId != null || patch.packIntoSuper != null;
      const topBlock =
        !willNest &&
        typeof devIsTopBlock === "function" &&
        devIsTopBlock(node);
      if (!node.dev || node.db)
        warnings.push(I18n.t("核心文件列表 devFiles 仅适用于开发节点") + who);
      else if (topBlock)
        warnings.push(
          I18n.t("最外层（项目）开发节点不列举核心文件，已忽略 devFiles") + who,
        );
      else if (!arr)
        warnings.push(
          I18n.t("devFiles 需是路径数组（每项一条相对项目根的路径）") + who,
        );
      else {
        const stats = {};
        const list =
          typeof devCoreFilesNormalize === "function"
            ? devCoreFilesNormalize(arr, node, stats)
            : [];
        node.devFiles = list;
        if (!list.length && arr.length)
          warnings.push(I18n.t("devFiles 里没有可用的文件路径（已置空）") + who);
        else if (stats.dropped > 0)
          warnings.push(
            I18n.t("核心文件最多 {n} 个，多余部分已忽略", {
              n: typeof DEV_CORE_FILES_MAX === "number" ? DEV_CORE_FILES_MAX : 10,
            }) + who,
          );
      }
    }
  }
  if (node.kind === "execute") {
    if (patch.execPath != null) {
      const v = String(patch.execPath).trim();
      node.execPath = v;
      if (v) node.error = null;
    }
    if (patch.execIcon != null) {
      const v = String(patch.execIcon);
      node.execIcon = EXEC_ICON_CATALOG.some((x) => x.key === v) ? v : "auto";
    }
    if (patch.execColor != null) {
      const v = String(patch.execColor);
      node.execColor =
        typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : "";
    }
  }
  if (patch.savePath != null && isSaveNode(node)) {
    node.savePath = preferRelativeSavePath(String(patch.savePath));
    applySavePathExt(node);
  }
  if (patch.waitPath != null && node.kind === "wait_file")
    node.waitPath = applySuperRelToPath(
      node,
      preferRelativeSavePath(String(patch.waitPath)),
    );
  if (patch.waitIntervalSec != null && node.kind === "wait_file") {
    const n = Math.round(Number(patch.waitIntervalSec));
    if (isFinite(n))
      node.waitIntervalSec = Math.max(1, Math.min(60, n || 2));
  }
  if (node.kind === "timer") {
    if (
      patch.timerMode === "once" ||
      patch.timerMode === "interval" ||
      patch.timerMode === "cron"
    )
      node.timerMode = patch.timerMode;
    if (patch.timerAt != null) node.timerAt = String(patch.timerAt);
    if (patch.timerEverySec != null) {
      const n = Math.round(Number(patch.timerEverySec));
      if (isFinite(n)) node.timerEverySec = clampDurationSec(n || 3600);
    }
    if (patch.timerCron != null) node.timerCron = String(patch.timerCron);
    if (patch.timerArmed != null) {
      if (patch.timerArmed) armTimerNode(node, true);
      else disarmTimerNode(node, true);
    }
    normalizeTimerNode(node);
  }
  if (node.kind === "delayer") {
    if (patch.delaySec != null) {
      const n = Math.round(Number(patch.delaySec));
      if (isFinite(n)) node.delaySec = clampDurationSec(n || 60);
    }
    normalizeDelayerNode(node);
  }
  if (node.kind === "sequencer") {
    if (patch.seqOutputs != null) {
      const n = Math.round(Number(patch.seqOutputs));
      if (isFinite(n)) node.seqOutputs = Math.max(2, Math.min(8, n || 3));
    }
    if (patch.seqGapSec != null) {
      const n = Math.round(Number(patch.seqGapSec));
      if (isFinite(n))
        node.seqGapSec = Math.max(0, Math.min(DUR_MAX_SEC, n || 0));
    }
    normalizeSequencerNode(node);
  }
  if (node.kind === "gate") {
    if (patch.gateInputs != null) {
      const n = Math.round(Number(patch.gateInputs));
      if (isFinite(n)) node.gateInputs = Math.max(2, Math.min(8, n || 2));
    }
    normalizeGateNode(node);
  }
  if (node.kind === "splitter") {
    if (patch.splitOutputs != null) {
      const n = Math.round(Number(patch.splitOutputs));
      if (isFinite(n)) node.splitOutputs = Math.max(2, Math.min(8, n || 3));
    }
    normalizeSplitterNode(node);
  }
  if (node.kind === "counter") {
    if (patch.counterEvery != null) {
      const n = Math.round(Number(patch.counterEvery));
      if (isFinite(n)) node.counterEvery = Math.max(2, Math.min(99, n || 2));
    }
    if (patch.counterCount != null) {
      const n = Math.round(Number(patch.counterCount));
      if (isFinite(n)) node.counterCount = Math.max(0, n || 0);
    }
    normalizeCounterNode(node);
  }
  if (node.kind === "mutex") {
    if (patch.mutexInputs != null) {
      const n = Math.round(Number(patch.mutexInputs));
      if (isFinite(n)) node.mutexInputs = Math.max(2, Math.min(8, n || 2));
    }
    if (
      patch.mutexMode === "first" ||
      patch.mutexMode === "priority" ||
      patch.mutexMode === "random"
    )
      node.mutexMode = patch.mutexMode;
    normalizeMutexNode(node);
  }
  if (node.kind === "net_recv" || node.kind === "net_send") {
    if (patch.netChannel != null) {
      const c = Math.round(Number(patch.netChannel));
      if (isFinite(c))
        node.netChannel = Math.max(0, Math.min(65535, c || 0));
    }
    if (patch.netProto === "tcp" || patch.netProto === "udp")
      node.netProto = patch.netProto;
    if (patch.netHost != null) {
      const h = String(patch.netHost).trim();
      node.netHost = h || "127.0.0.1";
    }
    if (patch.netPort != null) {
      const p = Math.round(Number(patch.netPort));
      if (isFinite(p)) node.netPort = Math.max(0, Math.min(65535, p));
    }
    if (node.kind === "net_recv" && typeof patch.netAutoListen === "boolean")
      node.netAutoListen = patch.netAutoListen;
  }
  if (node.kind === "db_replica") {
    if (patch.dbNodeId != null) node.dbNodeId = String(patch.dbNodeId).trim();
    if (patch.dbName != null) node.dbName = String(patch.dbName).trim();
  }
  if (typeof patch.globalRefs === "boolean" && canUseGlobalRefs(node))
    node.globalRefs = patch.globalRefs;
  if (patch.tags != null && node.kind !== "global") {
    const list = [];
    const seen = new Set();
    for (const raw of Array.isArray(patch.tags) ? patch.tags : []) {
      const t = ensureTagInCatalog(normalizeTagName(raw));
      if (!t || seen.has(t)) continue;
      seen.add(t);
      list.push(t);
    }
    node.tags = list;
  }
  if (typeof patch.agent === "boolean" && node.kind === "proc_text") {
    node.agent = patch.agent;
    if (node.agent) syncAgentProviderRoute(node);
  }
  if (
    typeof patch.auto === "boolean" &&
    (isSaveNode(node))
  )
    node.auto = patch.auto;
  if (
    typeof patch.batch === "boolean" &&
    (node.kind === "input_text" || node.kind === "input_image")
  )
    node.batch = patch.batch;
  if (patch.batchMode === "batch" || patch.batchMode === "agg")
    node.batchMode = patch.batchMode;
  if (patch.ctrlAction === "clear" || patch.ctrlAction === "run")
    node.ctrlAction = patch.ctrlAction;
  if (node.kind === "control") {
    if (
      patch.ctrlRole === "start" ||
      patch.ctrlRole === "endSuccess" ||
      patch.ctrlRole === "endFail" ||
      patch.ctrlRole === ""
    )
      node.ctrlRole = patch.ctrlRole || "";
    if (patch.ctrlPinned != null) node.ctrlPinned = !!patch.ctrlPinned;
  }
  if (patch.prompt != null && node.kind === "judge")
    node.prompt = String(patch.prompt);
  if (patch.ctrlFillOnly != null) node.ctrlFillOnly = !!patch.ctrlFillOnly;
  if (patch.size != null && node.kind === "proc_image") {
    const s = String(patch.size).trim();
    if (IMAGE_SIZES.includes(s)) node.size = s;
    else if (warnings)
      warnings.push(
        I18n.t("无效的图像尺寸（须为可选列表之一）：") +
          s +
          I18n.t(" · 可用：") +
          IMAGE_SIZES.slice(0, 8).join(", ") +
          "…",
      );
  }
  if (typeof patch.x === "number" && isFinite(patch.x)) node.x = snap(patch.x);
  if (typeof patch.y === "number" && isFinite(patch.y)) node.y = snap(patch.y);
  if (typeof patch.w === "number" && isFinite(patch.w))
    node.w = snapDim(patch.w, minWFor(node));
  if (typeof patch.h === "number" && isFinite(patch.h))
    node.h = snapDim(patch.h, minHFor(node));
  /* video_gen / music_gen：输出路径 patch（remotion 输出由下游保存节点负责，不接受） */
  if (
    patch.attempts != null &&
    (node.kind === "video_gen" || node.kind === "music_gen" || node.kind === "tts_gen" || node.kind === "remotion")
  ) {
    const n = Math.round(Number(patch.attempts));
    if (isFinite(n)) node.attempts = Math.max(1, Math.min(10, n || 1));
  }
  if (
    patch.outputPath != null &&
    (node.kind === "video_gen" || node.kind === "music_gen" || node.kind === "tts_gen")
  ) {
    const p = String(patch.outputPath).trim();
    if (p) {
      applyMediaGenConfiguredPath(
        node,
        p,
        node.kind === "music_gen" || node.kind === "tts_gen" ? "audio" : "video",
      );
    }
  }
  /* tts_gen：音色 / 语速 / 输出格式（GPT-SoVITS 语音节点） */
  if (node.kind === "tts_gen") {
    if (patch.voice != null) node.voice = String(patch.voice).trim();
    if (patch.speed != null) {
      const v = Number(patch.speed);
      if (isFinite(v) && v > 0) node.speed = Math.max(0.5, Math.min(2, v));
    }
    const fmt = String(patch.ttsFormat || "").toLowerCase();
    if (fmt === "wav" || fmt === "mp3") {
      node.ttsFormat = fmt;
      /* 格式变了 → 输出路径扩展名跟随（.wav ⇄ .mp3），否则下次生成会被强改回去 */
      if (String(node.outputPath || "").trim())
        applyMediaGenConfiguredPath(node, node.outputPath, "audio");
    }
  }
  /* remotion：描述 / 时长 / fps / 分辨率 / 服务商 / 模型 */
  if (node.kind === "remotion") {
    if (patch.text != null) node.text = String(patch.text);
    if (patch.duration != null) {
      const d = Math.round(Number(patch.duration));
      if (isFinite(d)) node.duration = Math.max(1, Math.min(60, d || 5));
    }
    if (patch.fps != null) {
      const f = Math.round(Number(patch.fps));
      if (isFinite(f)) node.fps = Math.max(1, Math.min(60, f || 30));
    }
    if (patch.remotionSize != null && REMOTION_SIZES.includes(String(patch.remotionSize).trim()))
      node.size = String(patch.remotionSize).trim();
    if (patch.size != null && REMOTION_SIZES.includes(String(patch.size).trim()))
      node.size = String(patch.size).trim();
    if (patch.providerId != null) node.providerId = String(patch.providerId);
    if (patch.model != null) node.model = String(patch.model);
  }
  /* video_gen：生成模式与时长 */
  if (node.kind === "video_gen") {
    if (patch.videoMode === "r2v" || patch.videoMode === "fl2va")
      node.videoMode = patch.videoMode;
    if (patch.duration != null) {
      const d = Math.round(Number(patch.duration));
      if (isFinite(d)) node.duration = Math.max(4, Math.min(15, d || 5));
    }
    if (
      patch.outputRes === "auto" ||
      patch.outputRes === "480p" ||
      patch.outputRes === "720p" ||
      patch.outputRes === "1080p"
    )
      node.outputRes = patch.outputRes;
    if (typeof patch.postEnabled === "boolean")
      node.postEnabled = patch.postEnabled;
    if (typeof patch.postInterp === "boolean")
      node.postInterp = patch.postInterp;
    /* 自建 ComfyUI 工作流：workflowId 非空即切到自建模式（内置参数失效 · 端子按参数表重排）。
       只落 id + 清空映射，参数表交给面板首次展开时的 h3:wfSyncParams（真源在主进程扫描），
       Agent 侧不自己编造 source。传空串 = 回到内置 FL2VA / R2V 链。 */
    if (patch.workflowId != null) {
      const id = String(patch.workflowId).trim();
      if (id !== String(node.workflowId || "").trim()) {
        node.workflowId = id;
        node.wfMeta = null;
        node.wfParams = [];
        node.wfParamValues = {};
        node.wfPortMap = {};
        node.customOutputNodeId = "";
      }
    }
    if (isCustomVideoGen(node)) {
      if (patch.customOutputNodeId != null)
        node.customOutputNodeId = String(patch.customOutputNodeId).trim();
      if (patch.wfParamValues && typeof patch.wfParamValues === "object") {
        const vals = h3WfValues(node);
        for (const [k, v] of Object.entries(patch.wfParamValues)) {
          if (v == null || v === "") delete vals[k];
          else vals[k] = v;
        }
      }
    }
  }
  /* ── 工具节点 / 函数节点（Agent 可在画布上建并改这两类节点 · 契约 docs/tool-function-nodes.md）
     工具节点的定义与参数只有一份真源 toolConfig{name,description,inputs,outputs}；
     函数节点用顶层同名字段 fnName / description / jscode / inputs / outputs。
     description / inputs / outputs 两类通用：工具节点落进 toolConfig，函数节点落自身字段。
     归一只走 normFnToolEntry + ensureFnToolNodeState（空名补「参数 N」· kind 只认 text|image · list 按 in / out 方向如实保留或清掉），
     与「设置」面板、存档加载同一口径；参数即端子，所以参数表一律整体替换（不做增量合并）。 */
  if (isFnToolNode(node)) {
    ensureFnToolNodeState(node);
    const fnToolWarn = (msg) => {
      if (warnings) warnings.push(String(msg) + "（" + (node.title || node.id) + "）");
    };
    const normParamList = (arr, who, dir) => {
      const list = Array.isArray(arr)
        ? arr
        : typeof arr === "string"
          ? arr.split(/[\r\n]+|[,，;；]\s*/)
          : null;
      if (!list) {
        fnToolWarn(I18n.t("需是参数数组（每项 {name, kind, list}）：") + who);
        return null;
      }
      /* dir = "in" 才保留 list（列表端子只在输入侧有意义），"out" 一律被归一清掉 */
      return list.map((e, i) => {
        const p = normFnToolEntry(e, i, dir);
        if (!p.name) p.name = I18n.t("参数 ") + (i + 1);
        return p;
      });
    };
    if (patch.toolConfig != null) {
      const tc = patch.toolConfig;
      if (!isToolNode(node)) fnToolWarn(I18n.t("toolConfig 仅适用于工具节点"));
      else if (!tc || typeof tc !== "object" || Array.isArray(tc))
        fnToolWarn(I18n.t("toolConfig 需是对象：{ name, description, inputs, outputs }"));
      else {
        if (tc.name != null) applyToolConfigName(node, String(tc.name));
        if (tc.description != null)
          node.toolConfig.description = String(tc.description);
        const tin =
          tc.inputs == null
            ? null
            : normParamList(tc.inputs, "toolConfig.inputs", "in");
        if (tin) node.toolConfig.inputs = tin;
        const tout =
          tc.outputs == null
            ? null
            : normParamList(tc.outputs, "toolConfig.outputs", "out");
        if (tout) node.toolConfig.outputs = tout;
      }
    }
    if (patch.fnName != null) {
      /* 工具节点没有独立的函数名：fnName 就地视作工具名（标题仍为默认时同步标题） */
      if (isToolNode(node)) applyToolConfigName(node, String(patch.fnName));
      else {
        const v = String(patch.fnName);
        node.fnName = v;
        const t = v.trim();
        if (t && /^函数(\s*\d+)?$/.test(String(node.title || "")))
          node.title = uniqueNodeTitle(t, node.id);
      }
    }
    if (patch.description != null) {
      if (isToolNode(node))
        node.toolConfig.description = String(patch.description);
      else node.description = String(patch.description);
    }
    if (patch.jscode != null) {
      if (isToolNode(node)) fnToolWarn(I18n.t("jscode 仅适用于函数节点"));
      else node.jscode = String(patch.jscode);
    }
    if (patch.inputs != null) {
      const list = normParamList(patch.inputs, "inputs", "in");
      if (list) {
        if (isToolNode(node)) node.toolConfig.inputs = list;
        else node.inputs = list;
      }
    }
    if (patch.outputs != null) {
      const list = normParamList(patch.outputs, "outputs", "out");
      if (list) {
        if (isToolNode(node)) node.toolConfig.outputs = list;
        else node.outputs = list;
      }
    }
    ensureFnToolNodeState(node);
  } else if (
    patch.toolConfig != null ||
    patch.fnName != null ||
    patch.jscode != null
  ) {
    if (warnings)
      warnings.push(
        I18n.t("toolConfig / fnName / jscode 仅适用于工具 / 函数节点") +
          "（" +
          (node.title || node.id) +
          "）",
      );
  }
  applyNodeModelPatch(node, patch, warnings);
}

/* 解析配置里的 API 服务商：id 或唯一名称 */
function resolveApiProviderRef(token, kind, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  const list = (S.config.providers || []).filter((p) => {
    if (kind === "proc_image") return String(p.type || "").startsWith("image_");
    return p.type === "text_openai";
  });
  const byId = list.find((p) => p.id === s);
  if (byId) return byId;
  const hits = list.filter((p) => p.name === s);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 && warnings)
    warnings.push(I18n.t("服务商名称不唯一，请改用 id：") + s);
  else if (warnings) warnings.push(I18n.t("找不到服务商：") + s);
  return null;
}

/* 解析智能路由供应商：deepseek-official / mtnode_<id> / 服务商名称 */
function resolveAgentProviderRoute(token, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  if (s === "deepseek-official" || s === "deepseek") return "deepseek-official";
  if (s.startsWith("mtnode_")) {
    const id = s.slice("mtnode_".length);
    if ((S.config.providers || []).some((p) => p.id === id && p.type === "text_openai"))
      return s;
    if (warnings) warnings.push(I18n.t("找不到服务商：") + s);
    return null;
  }
  const dp = dshProvider();
  if (dp && (dp.name === s || dp.id === s)) return "deepseek-official";
  const hits = (S.config.providers || []).filter(
    (p) => p.type === "text_openai" && (p.name === s || p.id === s),
  );
  if (hits.length === 1) return "mtnode_" + hits[0].id;
  if (hits.length > 1 && warnings)
    warnings.push(I18n.t("服务商名称不唯一，请改用 id：") + s);
  else if (warnings) warnings.push(I18n.t("找不到服务商：") + s);
  return null;
}

function agentModelsForRoute(route) {
  const catalog = S.providerCatalog || {
    deepseek: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", input: ["text"] },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
      {
        id: "deepseek-v4-flash-vision-exp",
        name: "DeepSeek-V4-Flash-Vision-Exp",
        input: ["text", "image"],
      },
    ],
    piai: [],
  };
  if (route === "deepseek-official") {
    const dp = dshProvider();
    if (dp && Array.isArray(dp.models) && dp.models.length)
      return dp.models.map((m) => String(m));
    return (catalog.deepseek || []).map((m) => m.id);
  }
  if (String(route || "").startsWith("mtnode_")) {
    const id = route.slice("mtnode_".length);
    const p = (S.config.providers || []).find((x) => x.id === id);
    return ((p && p.models) || []).map((m) => String(m));
  }
  return [];
}

/* 智能助手 / 画布编辑：替换节点服务商与模型 */
function applyNodeModelPatch(node, patch, warnings) {
  if (!patch || !node) return;
  const hasProv =
    patch.providerId != null ||
    patch.provider != null ||
    patch.model != null;
  if (!hasProv) return;
  const apiKinds =
    node.kind === "proc_text" ||
    node.kind === "proc_image";
  const agentKind =
    node.kind === "agent_task" || (node.kind === "proc_text" && node.agent);

  if (agentKind && (patch.provider != null || patch.model != null)) {
    let provOk = true;
    if (patch.provider != null) {
      const route = resolveAgentProviderRoute(patch.provider, warnings);
      if (route) {
        node.provider = route;
        node.vision = null;
        if (patch.model == null) {
          const models = agentModelsForRoute(route);
          if (models.length && !models.includes(node.model))
            node.model = models[0];
        }
      } else {
        provOk = false;
      }
    }
    if (provOk && patch.model != null) {
      const m = String(patch.model).trim();
      if (m) {
        node.model = m;
        node.vision = null;
      }
    }
  }

  if (apiKinds && !node.agent) {
    if (patch.providerId != null || patch.provider != null) {
      const token =
        patch.providerId != null ? patch.providerId : patch.provider;
      const prov = resolveApiProviderRef(token, node.kind, warnings);
      if (prov) {
        node.providerId = prov.id;
        if (patch.model != null) {
          const m = String(patch.model).trim();
          if (m) node.model = m;
        } else {
          const models = prov.models || [];
          if (models.length && !models.includes(node.model))
            node.model = models[0];
        }
      }
    } else if (patch.model != null) {
      const m = String(patch.model).trim();
      if (m) node.model = m;
    }
  } else if (apiKinds && node.agent && patch.providerId != null) {
    /* 智能模式下仍可改回原模式服务商（切换 agent 后用） */
    const prov = resolveApiProviderRef(patch.providerId, node.kind, warnings);
    if (prov) node.providerId = prov.id;
  }
}

function imagePathsFromPatch(patch) {
  if (!patch) return [];
  const out = [];
  if (patch.imagePath != null && String(patch.imagePath).trim())
    out.push(String(patch.imagePath).trim());
  if (Array.isArray(patch.imagePaths)) {
    for (const p of patch.imagePaths) {
      const s = String(p || "").trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function nodeHasImage(node) {
  if (!node || node.kind !== "input_image") return false;
  if (node.imageAsset) return true;
  return !!(
    Array.isArray(node.entries) && node.entries.some((e) => e && e.path)
  );
}

/* 从本机绝对路径复制图像到工作流资产，写入 input_image 节点 */
async function importImagePathsForNode(node, paths, warnings) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return 0;
  if (!node || node.kind !== "input_image") {
    warnings.push(I18n.t("仅图像输入节点可设置 imagePath：") + (node && node.title ? node.title : ""));
    return 0;
  }
  if (node.ro) {
    warnings.push(I18n.t("拆分出的只读节点，不可修改") + "：" + node.title);
    return 0;
  }
  if (inputInherited(node)) {
    warnings.push(I18n.t("该节点已继承输入，内容只读") + "：" + node.title);
    return 0;
  }
  if (!S.wf || !S.wf.id) {
    warnings.push(I18n.t("当前没有打开的画布"));
    return 0;
  }
  let ok = 0;
  const multi = list.length > 1 || !!node.batch;
  if (multi && !node.batch) {
    node.batch = true;
    if (!Array.isArray(node.entries)) node.entries = [];
    if (node.imageAsset) {
      const sn =
        String(node.sourceName || "").trim() ||
        imageStem(node.imageAsset) ||
        "img";
      node.entries.push(
        makeImageBatchEntry(node.imageAsset, sn, sn),
      );
      node.imageAsset = "";
      node.sourceName = "";
    }
  }
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    try {
      const copied = await copyImageFromPath(p, node.id + "_img_" + i);
      if (node.batch) {
        if (!Array.isArray(node.entries)) node.entries = [];
        node.entries.push(
          makeImageBatchEntry(copied.path, copied.sourceName),
        );
      } else {
        if (node.imageAsset) invalidateImageMeta(node.imageAsset);
        node.imageAsset = copied.path;
        node.sourceName = copied.sourceName;
      }
      ok++;
    } catch (e) {
      warnings.push(
        I18n.t("载入图像失败：") +
          p +
          " — " +
          ((e && e.message) || String(e)),
      );
    }
  }
  if (ok) clearDownstream(node.id);
  return ok;
}

function ensurePromptRefs(node, refs, aliasMap) {
  if (!Array.isArray(refs) || !refs.length) return;
  const field =
    node.kind === "agent_task"
      ? "task"
      : node.kind === "proc_text" || node.kind === "proc_image"
        ? "prompt"
        : "";
  if (!field) return;
  let body = node[field] || "";
  for (const raw of refs) {
    const key = String(raw || "").trim();
    if (!key) continue;
    const target =
      (aliasMap && aliasMap.get(key)) ||
      nodeById(key) ||
      (S.wf.nodes || []).find((n) => n.title === key);
    const title = target ? target.title : key;
    const token = "@" + title;
    if (target) {
      if (body.indexOf(token) < 0) body = body ? body + "\n" + token : token;
    } else if (tagByAtToken(key)) {
      const tagTok = "@" + normalizeTagName(key);
      if (body.indexOf(tagTok) < 0)
        body = body ? body + "\n" + tagTok : tagTok;
    }
  }
  node[field] = body;
}

function resolveCanvasRef(token, aliasMap, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  warnings = warnings || []; /* 兜底：调用方传 null 时不得在 null 上 push */
  if (aliasMap && aliasMap.has(s)) return aliasMap.get(s);
  const byId = nodeById(s);
  if (byId) return byId;
  const hits = (S.wf.nodes || []).filter((n) => n.title === s);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    warnings.push(I18n.t("标题不唯一，请改用 id：") + s);
    return null;
  }
  warnings.push(I18n.t("找不到节点：") + s);
  return null;
}

/* ── 回滚·画布路：把这一笔编辑【点名】的元素解析成 id ─────────────────────
 * touched 的主体由 app-rollback.js 的前后快照 diff 得出；这里补的是「diff 看不出来」
 * 的那一类：本会话点名改过、结果只体现为坐标 / 尺寸变化的元素。少了它，
 * 「把某个节点挪个位置」会被当成自动排版副作用而漏回退。
 * 已经 remove 掉的节点此时查不到 —— 没关系，那种元素前后快照一定比得出来。 */
function rbNamedFromParams(params, aliasMap, markAliasMap) {
  const named = { nodeIds: [], wireIds: [], markIds: [], groupIds: [] };
  const CAP = 600;
  const nodeTok = (tok) => {
    const s = String(tok == null ? "" : tok).trim();
    if (!s) return;
    const byAlias = aliasMap && aliasMap.get(s);
    const sameTitle = (S.wf.nodes || []).filter((x) => x.title === s);
    const n = byAlias || nodeById(s) || (sameTitle.length === 1 ? sameTitle[0] : null);
    if (n && n.id && named.nodeIds.length < CAP && named.nodeIds.indexOf(n.id) < 0)
      named.nodeIds.push(n.id);
  };
  const markTok = (tok) => {
    const s = String(tok == null ? "" : tok).trim();
    if (!s) return;
    const byAlias = markAliasMap && markAliasMap.get(s);
    const m = byAlias || markById(s) || marksOf().find((x) => x.text === s);
    if (m && m.id && named.markIds.length < CAP && named.markIds.indexOf(m.id) < 0)
      named.markIds.push(m.id);
  };
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const spec of list(params.create)) {
    nodeTok(spec && spec.alias);
    nodeTok(spec && spec.parentTaskId);
    nodeTok(spec && spec.parentSuperId);
    nodeTok(spec && spec.packIntoSuper);
  }
  for (const spec of list(params.update)) {
    nodeTok(spec && (spec.id || spec.alias || spec.title));
    nodeTok(spec && spec.parentTaskId);
    nodeTok(spec && spec.parentSuperId);
    nodeTok(spec && spec.packIntoSuper);
  }
  for (const pair of list(params.connect)) {
    nodeTok(pair && pair.from);
    nodeTok(pair && pair.to);
  }
  for (const pair of list(params.disconnect)) {
    nodeTok(pair && pair.from);
    nodeTok(pair && pair.to);
  }
  for (const pair of list(params.superConnect)) {
    nodeTok(pair && pair.from);
    nodeTok(pair && pair.to);
  }
  for (const token of list(params.remove)) nodeTok(token);
  for (const spec of list(params.createMarks)) markTok(spec && spec.alias);
  for (const spec of list(params.updateMarks))
    markTok(spec && (spec.id || spec.alias || spec.title || spec.text));
  for (const token of list(params.removeMarks)) markTok(token);
  const g = params.group;
  if (g && typeof g === "object") {
    for (const t of list(g.marks)) markTok(t);
  }
  return named;
}

async function applyCanvasEdit(params, ctx) {
  params = params || {};
  /* 二次防线：这是真正改图并落盘的入口，绑定画布若已被删除就直接抛错，
     绝不再往内存 / 磁盘写（applyCanvasOp 已拦一次，这里防别的调用路径）。 */
  if (!S.wf) throw new Error(I18n.t("当前没有打开的画布"));
  if (wfWriteBlocked(S.wf)) throw new Error(deletedWfError(S.wf));
  const warnings = [];
  const created = [];
  const updated = [];
  const connected = [];
  const removed = [];
  const createdMarks = [];
  const updatedMarks = [];
  const removedMarks = [];
  const aliasMap = new Map();
  const aliasById = {};
  const markAliasMap = new Map();
  const running = new Set(
    (S.wf.nodes || []).filter((n) => n.running).map((n) => n.id),
  );
  const creates = Array.isArray(params.create) ? params.create : [];
  const updates = Array.isArray(params.update) ? params.update : [];
  const connects = Array.isArray(params.connect) ? params.connect : [];
  const disconnects = Array.isArray(params.disconnect) ? params.disconnect : [];
  const removes = Array.isArray(params.remove) ? params.remove : [];
  const createMarks = Array.isArray(params.createMarks)
    ? params.createMarks
    : Array.isArray(params.marks)
      ? params.marks
      : [];
  const updateMarks = Array.isArray(params.updateMarks)
    ? params.updateMarks
    : [];
  const removeMarksList = Array.isArray(params.removeMarks)
    ? params.removeMarks
    : [];
  /* 数量上限已移除：整笔调用完整执行。此前 40/80 的截断会造成「部分创建」——
     大调用（架构图、批量建图）的 connect / createMarks / group 引用被截掉的
     alias 全部落空，曾导致超级节点 / 开发节点架构图建成半成品（孤儿节点）。
     null.push 崩溃根因已修，大调用现在可安全完整执行。 */
  const doLayout =
    params.layout === true || (params.layout !== false && creates.length > 0);

  if (
    !creates.length &&
    !updates.length &&
    !connects.length &&
    !disconnects.length &&
    !removes.length &&
    !createMarks.length &&
    !updateMarks.length &&
    !removeMarksList.length &&
    !(Array.isArray(params.superConnect) && params.superConnect.length) &&
    !params.group &&
    !params.setWorkflowName &&
    !doLayout
  ) {
    return Object.assign({ ok: true, message: I18n.t("没有改动"), warnings }, canvasSnapshot());
  }

  await ensureCanvasEditTools(params);

  /* 回滚·画布路：改动前先取整画布快照（本轮没开账就直接 null，零开销）。
     与 pushHistory 的撤销栈是两回事：那是给用户手动撤销用的整栈，
     这里要的是「本轮会话开始前」这一份，且必须按触碰实体逐字段回退。 */
  const rbEdit =
    typeof rbCanvasEditOpen === "function"
      ? rbCanvasEditOpen(ctx && ctx.runKey)
      : null;

  pushHistory();
  if (!Array.isArray(S.wf.groups)) S.wf.groups = [];
  if (!Array.isArray(S.wf.marks)) S.wf.marks = [];

  if (params.setWorkflowName) {
    const name = String(params.setWorkflowName).trim();
    if (name) {
      S.wf.name = name;
      if (typeof trackWorkflow === "function") trackWorkflow(S.wf.id, name);
    }
  }

  const originHint = layoutOrigin(
    (S.wf.nodes || []).filter((n) => !aliasMap.has(n.id)),
  );
  let placeX = originHint.x;
  let placeY = originHint.y;

  for (const spec of creates) {
    let kind = spec && spec.kind;
    if (kind === "image" || kind === "img") kind = "input_image";
    if (kind === "text") kind = "input_text";
    if (kind === "save_text" || kind === "save_image") kind = "save";
    if (!NODE_DEFAULTS[kind]) {
      warnings.push(I18n.t("未知节点类型：") + (spec && spec.kind));
      continue;
    }
    const alias = String((spec && spec.alias) || "").trim();
    if (!alias) {
      warnings.push(I18n.t("create 项缺少 alias，已跳过"));
      continue;
    }
    if (aliasMap.has(alias)) {
      warnings.push(I18n.t("重复 alias：") + alias);
      continue;
    }
    const hasXY =
      typeof spec.x === "number" &&
      isFinite(spec.x) &&
      typeof spec.y === "number" &&
      isFinite(spec.y);
    const node = makeNode(
      kind,
      hasXY ? spec.x : placeX,
      hasXY ? spec.y : placeY,
    );
    const wantTitle = String(spec.title || NODE_DEFAULTS[kind].title || alias);
    node.title = uniqueNodeTitle(wantTitle);
    applyNodePatch(node, spec, warnings);
    /* 开发节点：创建即按功能色卡上色（spec 显式给了 devColor 则不覆盖；
       须在 title / note 定稿后调用，归类靠这两项推断） */
    if (typeof devAutoColorNode === "function") devAutoColorNode(node);
    await importImagePathsForNode(node, imagePathsFromPatch(spec), warnings);
    node.title = uniqueNodeTitle(node.title || wantTitle, node.id);
    ensureDefaultSavePath(node);
    sizeNodeForContent(node);
    S.wf.nodes.push(node);
    aliasMap.set(alias, node);
    aliasById[node.id] = alias;
    created.push(node);
    if (!hasXY) {
      placeY = node.y + node.h + 48;
    }
  }

  for (const node of created) {
    /* media gens: path is set in-node; no bound save */
  }

  for (const spec of creates) {
    const alias = String((spec && spec.alias) || "").trim();
    const node = aliasMap.get(alias);
    if (!node || !spec || spec.parentTaskId == null) continue;
    const raw = String(spec.parentTaskId).trim();
    if (!raw) {
      node.parentTaskId = "";
      continue;
    }
    const p = resolveCanvasRef(raw, aliasMap, warnings);
    if (p && p.kind === "task" && p.id !== node.id) node.parentTaskId = p.id;
    else if (raw && warnings)
      warnings.push(I18n.t("无效的父任务：") + raw);
  }

  /* 收纳进超级节点：与 parentTaskId 一样，须在整批 create 入 aliasMap 后再解析 alias/title */
  const applyParentSuper = (node, raw, warningsArr) => {
    if (!node) return;
    const token = String(raw == null ? "" : raw).trim();
    if (!token) {
      node.parentSuperId = "";
      return;
    }
    const p = resolveCanvasRef(token, aliasMap, warningsArr);
    if (p && p.kind === "super" && canMoveNodeIntoSuper(p, node)) {
      node.parentSuperId = p.id;
      node.parentTaskId = p.parentTaskId || node.parentTaskId || "";
      rewriteNodePathsForSuperContext(node);
    } else if (token && warningsArr) {
      warningsArr.push(I18n.t("无效的超级节点：") + token);
    }
  };
  for (const spec of creates) {
    const alias = String((spec && spec.alias) || "").trim();
    const node = aliasMap.get(alias);
    if (!node || !spec) continue;
    if (spec.parentSuperId == null && spec.packIntoSuper == null) continue;
    const raw =
      spec.parentSuperId != null ? spec.parentSuperId : spec.packIntoSuper;
    applyParentSuper(node, raw, warnings);
  }

  for (const spec of updates) {
    const token = (spec && (spec.id || spec.alias || spec.title)) || "";
    const node = resolveCanvasRef(token, aliasMap, warnings);
    if (!node) continue;
    if (running.has(node.id) && spec.setTitle) {
      warnings.push(I18n.t("运行中的节点未改标题：") + node.title);
      spec = Object.assign({}, spec, { setTitle: undefined });
    }
    if (
      running.has(node.id) &&
      (spec.model != null ||
        spec.providerId != null ||
        spec.provider != null)
    ) {
      warnings.push(I18n.t("运行中的节点未改模型：") + node.title);
      spec = Object.assign({}, spec, {
        model: undefined,
        providerId: undefined,
        provider: undefined,
      });
    }
    applyNodePatch(node, spec, warnings);
    await importImagePathsForNode(node, imagePathsFromPatch(spec), warnings);
    if (spec.refs) ensurePromptRefs(node, spec.refs, aliasMap);
    sizeNodeForContent(node);
    updated.push({
      id: node.id,
      title: node.title,
      kind: node.kind,
      hasImage: nodeHasImage(node),
      providerId: node.providerId || undefined,
      provider: node.provider || undefined,
      model: node.model || undefined,
      size:
        node.kind === "proc_image"
          ? IMAGE_SIZES.includes(node.size)
            ? node.size
            : DEFAULT_IMAGE_SIZE
          : undefined,
    });
  }

  /* update 里的 parentSuperId 可能是 alias/title：在 patch 后再用 aliasMap 解析一次 */
  for (const spec of updates) {
    if (!spec || (spec.parentSuperId == null && spec.packIntoSuper == null))
      continue;
    const token = (spec.id || spec.alias || spec.title) || "";
    const node = resolveCanvasRef(token, aliasMap, warnings);
    if (!node) continue;
    const raw =
      spec.parentSuperId != null ? spec.parentSuperId : spec.packIntoSuper;
    applyParentSuper(node, raw, warnings);
  }

  for (const spec of creates) {
    const alias = String((spec && spec.alias) || "").trim();
    const node = aliasMap.get(alias);
    if (node && spec && spec.refs) ensurePromptRefs(node, spec.refs, aliasMap);
  }

  for (const node of created) {
    if (node && node.kind === "task") ensureTaskScaffold(node);
  }

  for (const pair of disconnects) {
    const a = resolveCanvasRef(pair && pair.from, aliasMap, warnings);
    const b = resolveCanvasRef(pair && pair.to, aliasMap, warnings);
    if (!a || !b) continue;
    const before = S.wf.wires.length;
    S.wf.wires = S.wf.wires.filter(
      (w) =>
        !(
          (w.from === a.id && w.to === b.id) ||
          (w.rel && w.from === b.id && w.to === a.id)
        ),
    );
    if (S.wf.wires.length === before) warnings.push(I18n.t("没有可断开的连线：") + a.title + " → " + b.title);
    else clearDownstream(b.id);
  }

  for (const pair of connects) {
    const a = resolveCanvasRef(pair && pair.from, aliasMap, warnings);
    const b = resolveCanvasRef(pair && pair.to, aliasMap, warnings);
    if (!a || !b) continue;
    if (pair && pair.rel) {
      /* 关系线：仅表示关系，不走数据流校验 */
      const err = relConnectError(a.id, b.id);
      if (err) {
        warnings.push(a.title + " ↔ " + b.title + "：" + err);
        continue;
      }
      addRelWire(a.id, b.id, {
        relArrow: pair.relArrow,
        relLabel: pair.relLabel,
      });
      connected.push({ from: a.id, to: b.id, fromTitle: a.title, toTitle: b.title, rel: true });
      continue;
    }
    const err = connectError(a.id, b.id, null, pair.fromIndex || 0);
    if (err) {
      warnings.push(a.title + " → " + b.title + "：" + err);
      continue;
    }
    addWire(a.id, b.id, null, { fromIndex: pair.fromIndex || 0 });
    connected.push({ from: a.id, to: b.id, fromTitle: a.title, toTitle: b.title });
  }

  /* 跨超级节点连接：任意层级 / 任意超级节点内的两个节点自动贯通 */
  const superPairs = Array.isArray(params.superConnect) ? params.superConnect : [];
  if (superPairs.length) {
    applySuperConnect(superPairs, { aliasMap, warnings, connected });
  }

  for (const token of removes) {
    const node = resolveCanvasRef(token, aliasMap, warnings);
    if (!node) continue;
    if (running.has(node.id)) {
      warnings.push(I18n.t("不能删除正在运行的节点：") + node.title);
      continue;
    }
    removed.push(node.id);
    if (node.kind === "task") {
      for (const id of taskDescendantIds(node.id)) removed.push(id);
    }
  }
  if (removed.length) {
    const expanded = new Set(removed);
    const finalIds = [];
    for (const id of expanded) {
      const n = nodeById(id);
      if (!n) continue;
      if (isPinnedCtrl(n) && !(n.parentTaskId && expanded.has(n.parentTaskId))) {
        warnings.push(I18n.t("起点 / 终点为固定节点，无法删除") + "：" + n.title);
        continue;
      }
      finalIds.push(id);
    }
    removed.length = 0;
    removed.push(...finalIds);
  }
  if (removed.length) {
    const set = new Set(removed);
    S.wf.nodes = S.wf.nodes.filter((n) => !set.has(n.id));
    S.wf.wires = S.wf.wires.filter((w) => !set.has(w.from) && !set.has(w.to));
    for (const g of S.wf.groups) {
      ensureGroupArrays(g);
      g.nodeIds = g.nodeIds.filter((id) => !set.has(id));
    }
    pruneEmptyGroups();
    for (const n of created) {
      if (set.has(n.id)) aliasMap.delete(n.id);
    }
  }

  const createdLive = created.filter((n) => nodeById(n.id));
  if (doLayout) {
    const targets =
      createdLive.length && params.layout !== true
        ? createdLive
        : createdLive.length
          ? createdLive
          : (S.wf.nodes || []).filter((n) => !running.has(n.id));
    /* 分「所属层级」各自排版：壳层内子节点用的是舞台局部坐标，
       与顶层画布坐标不是同一个空间，混在一起排会排飞（开发节点架构图就踩过） */
    const groups = new Map();
    for (const n of targets) {
      const tid = nodeParentTaskId(n) || "";
      const sid = nodeParentSuperId(n) || "";
      const key = tid + "|" + sid;
      if (!groups.has(key)) groups.set(key, { tid, sid, list: [] });
      groups.get(key).list.push(n);
    }
    for (const g of groups.values()) {
      const list = g.list;
      const set = new Set(list.map((n) => n.id));
      const obstacles = (S.wf.nodes || []).filter((n) => {
        if (set.has(n.id) || running.has(n.id) || isSuperIoNode(n)) return false;
        return g.sid
          ? nodeParentSuperId(n) === g.sid
          : !nodeParentSuperId(n) && nodeParentTaskId(n) === g.tid;
      });
      const origin = g.sid
        ? { x: snap(16), y: snap(16) }
        : createdLive.length && params.layout !== true
          ? layoutOrigin(obstacles)
          : { x: snap(48), y: snap(48) };
      layoutFlow(list, S.wf.wires || [], origin, obstacles);
    }
    /* 壳层按新的内容范围撑开，否则子块 / 关系线被 720×480 默认舞台裁掉 */
    fitAllOpenSuperShells();
  }

  /* 绘制标注：在节点排版之后创建，便于 around 包住最终坐标 */
  const resolveAroundNodes = (list) => {
    const out = [];
    for (const t of list || []) {
      const n = resolveCanvasRef(t, aliasMap, warnings);
      if (n) out.push(n);
    }
    return out;
  };
  const applyAroundToSpec = (spec) => {
    const around = spec.around || spec.nodes || spec.wrap;
    if (!around || !around.length) return spec;
    const ns = resolveAroundNodes(around);
    if (!ns.length) return spec;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + (n.w || 0));
      maxY = Math.max(maxY, n.y + (n.h || 0));
    }
    const pad = Math.max(0, Number(spec.pad) || 36);
    const titleH =
      spec.kind === "box" || !spec.kind || spec.kind === "frame"
        ? 0
        : 0;
    return Object.assign({}, spec, {
      x: minX - pad,
      y: minY - pad - titleH,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    });
  };

  const applyMarkParentSuper = (m, raw, warningsArr) => {
    if (!m) return;
    const token = String(raw == null ? "" : raw).trim();
    if (!token) {
      m.parentSuperId = "";
      return;
    }
    const p = resolveCanvasRef(token, aliasMap, warningsArr);
    if (p && p.kind === "super") {
      m.parentSuperId = p.id;
      m.parentTaskId = p.parentTaskId || m.parentTaskId || "";
    } else if (token && warningsArr) {
      warningsArr.push(I18n.t("无效的超级节点：") + token);
    }
  };
  for (const raw of createMarks) {
    const alias = String((raw && raw.alias) || "").trim();
    let spec = applyAroundToSpec(raw || {});
    if (!spec.kind && (spec.around || spec.nodes || spec.wrap))
      spec = Object.assign({ kind: "box" }, spec);
    const m = makeMarkFromSpec(spec, warnings);
    if (!m) continue;
    if (raw && (raw.parentSuperId != null || raw.packIntoSuper != null)) {
      const rawSuper =
        raw.parentSuperId != null ? raw.parentSuperId : raw.packIntoSuper;
      applyMarkParentSuper(m, rawSuper, warnings);
    }
    marksOf().push(m);
    if (alias) {
      if (markAliasMap.has(alias))
        warnings.push(I18n.t("重复绘制 alias：") + alias);
      else markAliasMap.set(alias, m);
    }
    /* 框体旁可选标题文字：label / title */
    const label = String((raw && (raw.label || raw.title)) || "").trim();
    if (label && m.kind === "box") {
      const tm = makeMarkFromSpec(
        {
          kind: "text",
          x: m.x + 8,
          y: m.y - 28,
          w: Math.max(120, Math.min(m.w - 16, 280)),
          h: 32,
          text: label,
          fontSize: Number(raw.labelSize) || 15,
          color: m.color,
        },
        warnings,
      );
      if (tm) {
        marksOf().push(tm);
        createdMarks.push({
          alias: alias ? alias + "_label" : "",
          id: tm.id,
          kind: tm.kind,
          text: tm.text,
          x: tm.x,
          y: tm.y,
        });
      }
    }
    createdMarks.push({
      alias: alias || "",
      id: m.id,
      kind: m.kind,
      text: m.kind === "text" ? m.text : label || undefined,
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h,
    });
  }

  for (const raw of updateMarks) {
    const token = (raw && (raw.id || raw.alias || raw.title || raw.text)) || "";
    const m = resolveMarkRef(token, markAliasMap, warnings);
    if (!m) continue;
    let patch = raw;
    if (raw.around || raw.nodes || raw.wrap) {
      patch = applyAroundToSpec(
        Object.assign({}, raw, { kind: m.kind }),
      );
    }
    applyMarkPatch(m, patch, warnings);
    updatedMarks.push({
      id: m.id,
      kind: m.kind,
      text: m.kind === "text" ? m.text : undefined,
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h,
    });
  }

  if (removeMarksList.length) {
    const delIds = [];
    for (const token of removeMarksList) {
      const m = resolveMarkRef(token, markAliasMap, warnings);
      if (m) delIds.push(m.id);
    }
    if (delIds.length) {
      const set = new Set(delIds);
      S.wf.marks = marksOf().filter((m) => !set.has(m.id));
      for (const g of S.wf.groups || []) {
        ensureGroupArrays(g);
        g.markIds = g.markIds.filter((id) => !set.has(id));
      }
      pruneEmptyGroups();
      removedMarks.push(...delIds);
    }
  }

  /* 组：在节点排版与绘制创建之后，可同时纳入节点与绘制 */
  let grouped = null;
  if (params.group && typeof params.group === "object") {
    const gspec = params.group;
    let nodeIds = [];
    let markIds = [];
    if (Array.isArray(gspec.nodes) && gspec.nodes.length) {
      for (const t of gspec.nodes) {
        /* 传入真实 warnings：resolveCanvasRef 找不到成员时会 push 提示，
           传 null 会在 null 上 push 抛 TypeError（曾导致建图调用半途崩溃） */
        const n = resolveCanvasRef(t, aliasMap, warnings);
        if (n) {
          nodeIds.push(n.id);
          continue;
        }
        const m = resolveMarkRef(t, markAliasMap, warnings);
        if (m) markIds.push(m.id);
        else warnings.push(I18n.t("组内找不到成员：") + t);
      }
    } else {
      nodeIds = createdLive.map((n) => n.id);
    }
    if (Array.isArray(gspec.marks) && gspec.marks.length) {
      for (const t of gspec.marks) {
        const m = resolveMarkRef(t, markAliasMap, warnings);
        if (m) markIds.push(m.id);
      }
    } else if (
      !(Array.isArray(gspec.nodes) && gspec.nodes.length) &&
      createdMarks.length
    ) {
      /* 未显式列 marks 且未列 nodes：把本批 createMarks 一并入组 */
      markIds = createdMarks.map((x) => x.id).filter(Boolean);
    }
    nodeIds = nodeIds.filter((id, i) => nodeIds.indexOf(id) === i);
    markIds = markIds.filter((id, i) => markIds.indexOf(id) === i);
    if (nodeIds.length || markIds.length) {
      grouped = {
        id: uid("g"),
        title: String(gspec.title || I18n.t("组")).trim() || I18n.t("组"),
        nodeIds,
        markIds,
      };
      S.wf.groups.push(grouped);
    }
  }

  /* 孤儿防护：本笔编辑产生的节点 / 绘制不允许挂在画布上不存在的超级节点下
     （历史 bug：整棵开发节点架构图挂到幽灵父级后，最外层功能块从此消失，
      内部块仍在，但左侧栏与层级视图全部错乱） */
  {
    const liveIds = new Set((S.wf.nodes || []).map((n) => n.id));
    let orphanNodes = 0;
    for (const n of createdLive) {
      const sid = nodeParentSuperId(n);
      if (sid && !liveIds.has(sid)) {
        n.parentSuperId = "";
        orphanNodes++;
      }
    }
    for (const rec of createdMarks) {
      const m = rec && rec.id ? markById(rec.id) : null;
      if (m && m.parentSuperId && !liveIds.has(m.parentSuperId)) {
        m.parentSuperId = "";
        orphanNodes++;
      }
    }
    if (orphanNodes) {
      warnings.push(
        I18n.t("已清理 ") + orphanNodes + I18n.t(" 个指向不存在超级节点的引用"),
      );
    }
  }

  if (S._canvasEditVisible !== false) {
    renderCanvas();
    /* 不平移/缩放用户视角：节点在世界坐标中更新，相机保持不动 */
    renderStatus();
    if (typeof renderSidebar === "function" && S.sidebarOpen) renderSidebar();
    scheduleSave(true);
  } else {
    persistWf(S.wf);
  }

  const bits = [];
  if (createdLive.length) bits.push(I18n.t("创建 ") + createdLive.length + I18n.t(" 个节点"));
  if (createdMarks.length)
    bits.push(I18n.t("绘制 {n} 个", { n: createdMarks.length }));
  if (connected.length) bits.push(I18n.t("连接 ") + connected.length + I18n.t(" 条线"));
  if (removed.length) bits.push(I18n.t("删除 ") + removed.length + I18n.t(" 个节点"));
  if (doLayout) bits.push(I18n.t("已排版"));
  if (bits.length) toast(I18n.t("智能助手已更新画布：") + bits.join(" · "), "ok");

  warnBatchCartesianRisk(warnings);

  /* 回滚·画布路：改动后收口 —— 前后整快照入库 + touched 只认本轮触碰的实体。
     自动排版顺带挪动的【别人】的节点刻意不进 touched（快照备注里记 layoutMoved /
     归属不明的记 drift），回滚弹窗据此说明「这部分不逐条回退」。 */
  if (typeof rbCanvasEditClose === "function")
    rbCanvasEditClose(rbEdit, rbNamedFromParams(params, aliasMap, markAliasMap));

  return Object.assign(
    {
      ok: true,
      created: createdLive.map((n) => ({
        alias: aliasById[n.id] || "",
        id: n.id,
        kind: n.kind,
        title: n.title,
        x: n.x,
        y: n.y,
        hasImage: nodeHasImage(n),
        size:
          n.kind === "proc_image"
            ? IMAGE_SIZES.includes(n.size)
              ? n.size
              : DEFAULT_IMAGE_SIZE
            : undefined,
        model: n.model || undefined,
        ctrlAction: n.kind === "control" ? n.ctrlAction || "run" : undefined,
        ctrlFillOnly: n.kind === "control" ? !!n.ctrlFillOnly : undefined,
        globalRefs: canUseGlobalRefs(n) ? !!n.globalRefs : undefined,
      })),
      updated,
      createdMarks,
      updatedMarks,
      removedMarks,
      connected,
      removed,
      grouped: grouped
        ? {
            id: grouped.id,
            title: grouped.title,
            nodeIds: grouped.nodeIds,
            markIds: grouped.markIds || [],
          }
        : undefined,
      warnings,
    },
    canvasSnapshot(),
  );
}

function removeWire(id) {
  const i = S.wf.wires.findIndex((w) => w.id === id);
  if (i < 0) return;
  const w0 = S.wf.wires[i];
  if (isPinnedWire(w0)) {
    toast(I18n.t("该连线已固定，无法删除"), "warn");
    return;
  }
  pushHistory();
  const [w] = S.wf.wires.splice(i, 1);
  if (w.rel) {
    /* 关系线：不占端子、不参与数据流，直接清理 DOM */
    for (const pre of ["rw-", "rwl-", "rsw-", "rswl-"]) {
      const el = document.getElementById(pre + w.id);
      if (el) el.remove();
      const ring = document.getElementById(pre + w.id + "-r");
      if (ring) ring.remove();
    }
    return;
  }
  const toNode = nodeById(w.to);
  /* 固定端子（音乐 P/L、视频多路、闸门等）禁止压缩 toIndex，否则会错位 */
  if (!hasFixedInPorts(toNode)) {
    for (const x of S.wf.wires) {
      if (x.to === w.to && x.toIndex > w.toIndex) x.toIndex--;
    }
  }
  if (!wireFromIsControl(w)) clearDownstream(w.to);
}

function deleteNode(id) {
  deleteNodes([id]);
}

function duplicateNode(node) {
  duplicateNodes([node]);
}

/* 节点标题被 ellipsis 截断时，hover 立即显示完整标题（不用原生 title 的延迟） */
function ensureNodeTitleTip() {
  let tip = document.getElementById("nodeTitleTip");
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = "nodeTitleTip";
  tip.className = "n-title-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}

function hideNodeTitleTip() {
  const tip = document.getElementById("nodeTitleTip");
  if (tip) tip.hidden = true;
}

function showNodeTitleTip(anchor, text) {
  const tip = ensureNodeTitleTip();
  const s = String(text || "").trim();
  if (!s) {
    tip.hidden = true;
    return;
  }
  tip.textContent = s;
  tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pad = 6;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + tw > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - tw - pad);
  if (top + th > window.innerHeight - pad) top = Math.max(pad, r.top - th - 4);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

function bindNodeTitleTooltip(el, textOrFn) {
  if (!el) return;
  el.addEventListener("mouseenter", () => {
    const text = typeof textOrFn === "function" ? textOrFn() : textOrFn;
    showNodeTitleTip(el, text);
  });
  el.addEventListener("mouseleave", hideNodeTitleTip);
  el.addEventListener("mousedown", hideNodeTitleTip);
}

function startTitleEdit(node, titleEl) {
  if (!titleEl) return;
  hideNodeTitleTip();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "n-title-input";
  input.value = node.title || "";
  input.spellcheck = false;
  input.title = I18n.t("回车确认 · Esc 取消");
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== node.title) {
      pushHistory();
      node.title = v;
      /* 标题映射:节点标题 → 关联会话名称 */
      if (node.kind === "agent_task" && node.agentSessionId) {
        const sess = agentSessions().find((s) => s.id === node.agentSessionId);
        if (sess) {
          sess.title = v;
          persistAgentSession().catch(() => {});
          renderAgentSessionSidebar();
        }
      } else if (node.kind === "super" && node.dev) {
        /* 开发节点改名 → 其名下的开发 / 细化会话标题跟随 */
        syncDevSessionTitles(node);
        persistAgentSession().catch(() => {});
      }
      scheduleSave();
    }
    renderCanvas();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("mousedown", (ev) => ev.stopPropagation());
}


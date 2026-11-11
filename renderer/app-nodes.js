"use strict";
/* 从 paths 里剔掉已经写进正文的图像：
   （顺序与去重口径与 mergeImagePaths 一致：同一路径只留第一次出现的那条） */
function imagesNotInBody(paths, bodyBlocks) {
  const seenBody = new Set(
    (bodyBlocks || []).map((b) => String((b && b.path) || "")).filter(Boolean),
  );
  const out = [];
  const seen = new Set();
  for (const p of paths || []) {
    const s = String(p || "");
    if (!s || seen.has(s) || seenBody.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/* 本次请求要用的服务商对象 + 模型 id（buildSpec / buildSpecAgg / remotion 共用）：
   服务商 type 是用户配置里的持久字段，而一个 OpenAI 兼容端点常常同时挂文本与图像模型
   （MTNode 中转服务卡恒为 text_openai，形态靠 config.modelKinds 逐模型给出）。
   类型与所选模型形态不符时只用**副本**纠偏（app-model-kind.js 的 providerForRequest），
   绝不回写 S.config.providers —— 回写会让这一家的另一类模型从各处模型选择器里一起消失。 */
function requestProviderOf(prov, modelId) {
  return typeof providerForRequest === "function"
    ? providerForRequest(S.config, prov, modelId)
    : prov;
}
function requestModelOf(node, prov) {
  return node.model || ((prov && prov.models) || [])[0] || "";
}

function buildSpec(node, prov, idx, skillWrap) {
  /* 图像参数（quality / background / 蒙版）先归一，旧画布缺字段也拿得到确定值 */
  if (node.kind === "proc_image" && typeof normalizeImgParams === "function")
    normalizeImgParams(node);
  const images = [];
  for (const it of inputValuesFor(node, idx)) {
    const v = it && it.value;
    if (v && v.kind === "image" && v.path) images.push(v.path);
  }
  const runPrompt = procPromptForRun(node);
  const refs = resolveRefs(runPrompt, node, idx);
  /* 行首 /技能名 [说明]：命中已安装技能则就地替换为技能说明书。
     必须在 resolveRefs 之后：技能正文里的 @ / / 不被二次解析，【背景信息】块与 @ 引用不受影响 */
  if (skillWrap && typeof applySkillWrapToAssembled === "function")
    refs.prompt = applySkillWrapToAssembled(
      refs.prompt,
      skillWrap.raw,
      skillTaskPrompt(skillWrap),
    );
  /* 全局广播图像：同样只有提示词里明文 @ 命中的来源才进参考图 */
  const wiredFrom = new Set(wiresTo(node.id).map((w) => w.from));
  for (const src of globalRefSourcesForRun(node, runPrompt)) {
    if (wiredFrom.has(src.id)) continue;
    const v = valueForInput(src, idx);
    if (v && v.kind === "image" && v.path) {
      images.push(v.path);
    }
  }
  /* 图生图：连线图已可能被 @ 引用进 refImages，再 concat 会翻倍；文生图背景仍可带标题说明。
     正文里内嵌的图像（refs.bodyImageBlocks）已按位置写进正文，其路径也从连线 / 广播图里剔掉，
     同一张图不重复下发（图像本身仍走 refImages → spec.images 的真多模态链路）。
     图像节点只滤「内嵌图像的说明块」（「（图像输入）」那几行）：**文本来源（连线 / @ 引用 /
     Tag / 全局广播）一律与文本处理节点同口径收进【背景信息】** —— 图像节点引用文本就得真的
     收到那段文本。v1.4.5 起这里误写成 proc_image 整段不注入（连 @ 到的 refs.textSources 一起
     丢），@ 只剩被替换掉的节点标题、正文一个字都到不了模型；聚合路径 buildSpecAgg 一直只滤
     图像说明块，两条路径必须同一个口径（回归见 test/smoke-img-text-ref.js）。 */
  const bodyBlocks = refs.bodyImageBlocks || [];
  const sources = (refs.textSources || []).concat(
    node.kind === "proc_image" ? [] : bodyBlocks,
  );
  /* 下发图像序列：与蒙版底图同源（runImagePaths，@ 引用优先），images 已含连线图 + 广播图；
     正文里出现过的图不再作为连线 / 广播图重复下发 */
  const mergedImages = runImagePaths(
    node,
    idx,
    refs,
    imagesNotInBody(images, bodyBlocks),
  );
  const modelOf = requestModelOf(node, prov);
  return {
    provider: requestProviderOf(prov, modelOf),
    kind:
      node.kind === "proc_text" || node.kind === "agent_task" ? "text" : "image",
    model: modelOf,
    temperature:
      node.temperature == null
        ? 0.7
        : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    /* 思考强度：文本节点下发 off/低/中/高/最强（off ⇒ thinking 关闭），旧 none → low */
    effort:
      node.kind === "proc_text" ? normalizeTextEffort(node.effort) : undefined,
    size:
      node.kind === "proc_image"
        ? IMAGE_SIZES.includes(node.size)
          ? node.size
          : DEFAULT_IMAGE_SIZE
        : "",
    /* gpt-image-2 直传参数（见 main.js buildRequestSpec）：空值 = 不传，服务商默认 auto；
       maskPath 为空 = 不做局部重绘（mask 必须与原图同尺寸、只对第 1 张 image 生效） */
    quality: node.kind === "proc_image" ? node.imgQuality || "" : undefined,
    background: node.kind === "proc_image" ? node.imgBackground || "" : undefined,
    maskPath: node.kind === "proc_image" && maskActive(node) ? node.maskPath : "",
    /* 组输入（本次需求）：同 buildSpecAgg —— 组内节点清单接在正文最后
       （typeof 守卫：这颗函数被单独抽出来跑时不用担心依赖缺失） */
    prompt:
      withImageParamsPrompt(node, assemblePrompt(refs.prompt, sources)) +
      (typeof groupContextBlock === "function" ? groupContextBlock(node) : ""),
    texts: [],
    images: mergedImages,
    refImage: mergedImages[0] || "",
  };
}

/* 流式文本调用：resolve {text, reasoning}；reasoning 增量回调（思考内容，按尝试槽存储）；
   delta 增量回调（正文流式）。
   三档请求超时（连接 / 首字节 / 分块空闲）在这里随 spec 显式下发：主进程优先读这几个字段，
   缺省 300000（见 main.js 的 timeoutTiersOf / attachRequestWatchdog 与 app-model-kind.js
   的 providerTimeoutSpec）——老配置没填这几个字段时行为与服务商缺省完全一致。 */
function apiCallTextStream(spec, onReasoning, onDelta) {
  /* 首次使用闸：官方 DeepSeek 还没配 API Key → 弹图文引导窗（app-deepseek-onboard.js）
     并中止这次调用，既不烧 Token 也不让底层甩一条「未配置 API Key」的干错。
     别的服务商（mtnode_xxx）不受这条闸影响，Key 由主进程 checkProvider 照常校验。 */
  if (
    spec &&
    spec.provider &&
    typeof dsEnsureModelReady === "function" &&
    !dsEnsureModelReady(spec.provider)
  ) {
    return Promise.reject(
      typeof dsMissingKeyError === "function"
        ? dsMissingKeyError()
        : new Error(I18n.t("未配置 API Key（请在「设置 · API/配置」中填写）")),
    );
  }
  const out =
    spec && typeof providerTimeoutSpec === "function"
      ? Object.assign({}, spec, providerTimeoutSpec(spec.provider || {}))
      : spec;
  return new Promise((resolve, reject) => {
    window.api.apiCallStream(out, (ev) => {
      if (ev.type === "reasoning") {
        if (onReasoning) onReasoning(ev.text || "");
      } else if (ev.type === "delta") {
        if (onDelta) onDelta(ev.text || "");
      } else if (ev.type === "done") {
        resolve(ev);
      } else if (ev.type === "error") {
        const err = new Error(ev.error || I18n.t("调用失败"));
        /* 中转凭据失效（主进程打好的标记，见 main.js 的 relayAuthFailed）：
           渲染层据此弹「登录已失效，请重新登录」并把标记挂到错误上，调用方照常报错。 */
        if (ev.relayAuth) {
          err.relayAuth = true;
          if (typeof mtRelayAuthNotice === "function") mtRelayAuthNotice();
        }
        reject(err);
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

/* 视觉提示：默认就相信当前模型能识图（DeepSeek 官方默认的 deepseek-flash 原生多模态；
   旧的 deepseek-v4-flash-vision-exp 已下线）—— 真不吃图片时由 API 报错，这条提示只在
   「确实没有可用视觉模型」时给出，口径是「先按默认直跑，报错再说」，不是提前拦死。 */
const VISION_HINT =
  "当前模型按默认可直接识图；若调用报错提示不支持图片输入（未添加多模态模型），请在「设置 → 模型服务」添加支持识图的模型（DeepSeek 官方默认的 deepseek-flash 即可识图），或为该服务商勾选「支持视觉」";

/* 文本节点接入图像时的多模态校验：当前服务商无视觉模型且未勾选视觉则拒绝 */
function ensureVision(prov, images) {
  if (!images || !images.length || !prov) return;
  if (prov.vision) return;
  if (visionModelsForProvider("mtnode_" + prov.id).length) return;
  throw new Error(I18n.t(VISION_HINT));
}

/* 已配置且带 vision 标记的文本服务商（原模式 API 路径） */
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
  /* 正文里的内嵌图像胶囊 token（proc_text 的提示词 / agent_task 的任务）：会话模式的
     「历史 + 最新一句」用的是原始正文，这里换成可读注记，免得「@img:xxxxxxx」原样漏给
     agent（图片本体已由 buildSpec → spec.images 下发，见 resolveRefs）。 */
  const sentAsk = promptCapsulesToText(sent, node);
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
    const cur = String(sentAsk || "").trim();
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
  let latest = skillLatest || String(sentAsk || "").trim() || spec.prompt;
  /* 复杂任务计划：注入「任务流程」指令（Skill / 计划执行器 / 已判定过跳过） */
  let planFlowInjected = false; /* 本次运行是否被要求「按契约输出计划块」（漏弹自愈的闸门） */
  let flowInjected = ""; /* 本轮注入的流程指令：会话模式下排在用户原话之后，不盖住原话 */
  if (
    node.kind === "agent_task" &&
    attemptCount(node) <= 1 &&
    !skillWrap &&
    !node._planExec &&
    !node._planFlowDone &&
    typeof planFlowDirective === "function"
  ) {
    flowInjected = planFlowDirective();
    if (String(spec.prompt || "").trim()) spec.prompt = flowInjected + "\n" + spec.prompt;
    node._planFlowDone = true;
    planFlowInjected = true;
  }
  let input =
    useHist && hist
      ? typeof agentUserTurnInput === "function"
        ? agentUserTurnInput(hist, flowInjected, latest)
        : hist + "\n\n用户(最新)：" + latest
      : spec.prompt;
  /* 音频 / 视频转写（官方本地 SenseVoice）：文字节点不再自己转写 —— 接线上的音频节点
     该转的前面「转录闸门」已经转好并写回它自己身上，这里只把它的文字取来用。
     会话模式（历史 + 最新一句）下 spec.prompt 里的【背景信息】块不进 input，
     所以这里单独补一段，保证「音频接进文字节点就有文字」在两种模式下都成立
     （见 renderer/app-asr.js · asrTextBlocksFor）。 */
  if (useHist && hist && typeof asrTextBlocksFor === "function") {
    const _asrBlocks = asrTextBlocksFor(node);
    const _asrTaskText = _asrBlocks
      .map((b) => "【" + b.title + "】\n" + b.text)
      .join("\n\n");
    if (_asrTaskText) input = input + "\n\n" + _asrTaskText;
  }
  /* 组输入（本次需求）：接进来的组的节点清单。与上面音频块同一处 —— 会话模式下
     spec.prompt 的【背景信息】不进 input，只在 buildSpec 里拼一次会丢；这里兜全部路径，
     且 spec.prompt 已经含过就不再重复（普通模式 input === spec.prompt）。 */
  if (typeof groupContextBlock === "function") {
    const _grpBlock = groupContextBlock(node);
    if (_grpBlock && input.indexOf(_grpBlock.trim()) < 0) input = input + _grpBlock;
  }
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
  /* 行首 /技能名：普通节点在这里展开进提示词（智能任务节点在 runDshOnce 内部同口径解析，
     此处不重复展开，避免二次包装） */
  const dshTask = isDshTask(node);
  const skillWrap = dshTask
    ? null
    : await resolveSkillSlash(procPromptForRun(node), {
        denyCanvasSkills: true,
      });
  const spec = buildSpec(node, prov, idx, skillWrap);
  if (dshTask) {
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
  /* 蒙版局部重绘：前置校验（服务商 / 原图），并在开启时让位画幅锁定（见 app.js 同名函数）。
     判据用**本次请求的服务商**（spec.provider = 按所选模型纠过形态的副本，见 requestProviderOf）：
     混挂端点（配成 text_openai、跑的却是图像模型）本来就该走 /images/edits，
     不能因为服务商级 type 写着 text_openai 就把它判死。 */
  if (node.kind === "proc_image")
    ensureMaskPrereqs(node, spec.provider || prov, typeof idx === "number" ? idx : 0);
  /* 画幅锁定「与首参考图保持一致长宽比」：发请求前把首参考图换成补边副本、
     并把请求尺寸钉到目标画幅；出图后由 finishProcImageOutput 按同一矩形裁回。
     聚合运行没有条目标题，故 itemTitle 用 typeof 兜底（单次 / 聚合两条路径共用这段）。 */
  if (node.kind === "proc_image" && !maskActive(node))
    await applyRatioLockToSpec(node, spec, {
      write: true,
      itemTitle: typeof itemTitle === "string" ? itemTitle : "",
      attemptT: attemptT || 0,
    });
  if (node.kind === "proc_text") ensureVision(prov, spec.images);
  if (node.kind === "proc_text") {
    const r = await apiCallTextStream(spec, (t) =>
      pushThinking(node.id, attemptT || 0, t),
    );
    if (!r.text) throw new Error(I18n.t("响应无文本内容"));
    return { kind: "text", text: r.text };
  }
  /* 出图也是「模型能力」：官方 DeepSeek 没 Key 时同样先弹引导窗（同一张闸） */
  if (typeof dsEnsureModelReady === "function" && !dsEnsureModelReady(spec.provider || prov))
    throw typeof dsMissingKeyError === "function"
      ? dsMissingKeyError()
      : new Error(I18n.t("未配置 API Key（请在「设置 · API/配置」中填写）"));
  const rr = await window.api.apiCall(spec);
  if (!rr.ok) throw new Error(rr.error || I18n.t("调用失败"));
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, itemTitle, attemptT, ""),
    rr.base64,
    rr.ext || "png",
  );
  /* 透明背景开启时：这里把第 1 通道（纯黑基准）原图当唯一参考图，内部补发第 2 通道（纯白复刻）并差分抠图（用户无感知） */
  const path = await finishProcImageOutput(node, spec, res.path, itemTitle, attemptT);
  /* 中转图像计费：出图成功 = 一次调用 = 一张（与尺寸无关，见 store-saas/relay.mjs
     的 imageCostYuan）。批量模式下每个条目各走一次 runOnce，所以这里记 1 张即可；
     透明背景的差分补发是同一节点内部的第二次调用，那一次由补发路径自己记。 */
  if (path) tokNoteImageCall(node, spec, 1);
  return { kind: "image", path };
}

/* ── 中转图像计费「按张」入账（一次调用 = 一张）────────────────────────
 * 中转站的图像计费与 token 无关：**每次调用即计费，与尺寸无关**（见 store-saas/relay.mjs
 * 的 imageCostYuan）。出图成功后在这里把「这次调用」记进 Token 台账，费用在展示时由
 * app-cost.js 的 costOfImages 按云端价目现算（非中转发起人是本机、也没这条记录，
 * 计价侧对非中转路由直接返回 null，所以这里不做路由判断）。 */
function tokNoteImageCall(node, spec, n) {
  try {
    if (typeof tokAddImages !== "function" || typeof tokOwnerForRun !== "function") return;
    const prov = (spec && spec.provider) || null;
    const provider = String((prov && (prov.id || prov.route)) || node.providerId || "");
    const model = String((spec && spec.model) || node.model || "");
    if (!model) return;
    const owner = tokOwnerForRun({ node: node });
    if (!owner) return;
    tokAddImages(owner, {
      provider: provider,
      model: model,
      images: Math.max(1, Math.floor(Number(n) || 1)),
      at: Date.now(),
    });
    /* owner 是会话时台账留在会话上（会话由 app-db.js 持久化），否则节点自己随画布保存 */
    if (owner !== node && typeof persistAgentSession === "function") persistAgentSession().catch(() => {});
  } catch (_) {}
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
  /* 正文里的内嵌图像胶囊块（与 resolveRefs 同口径）：token → 就地一行
     「（图像输入）标题：…」+「图 N」+ 路径并进 refImages（随后走既有通路下发） */
  const cap = resolvePromptCapsules(prompt, node, refImages);
  prompt = cap.prompt;
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
  return {
    prompt: out,
    refImages,
    unresolved: [...unresolved],
    tagBlocks,
    bodyImageBlocks: cap.blocks,
  };
}

/* 聚合模式：所有条目的内容合并为一次请求（每条目作为独立输入块） */
function buildSpecAgg(node, prov, skillWrap) {
  if (node.kind === "proc_image" && typeof normalizeImgParams === "function")
    normalizeImgParams(node);
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
        oncePrompt: true,
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
        oncePrompt: true,
      });
    }
  }
  const refs = resolveRefsAgg(runPrompt, node);
  /* 行首 /技能名 [说明]：同 buildSpec —— 在 @ 引用解析之后就地替换为技能说明书 */
  if (skillWrap && typeof applySkillWrapToAssembled === "function")
    refs.prompt = applySkillWrapToAssembled(
      refs.prompt,
      skillWrap.raw,
      skillTaskPrompt(skillWrap),
    );
  /* 聚合图生图：去掉「（图像输入）」标题块，避免与「第 N 张参考图」重复说明。
     正文里内嵌的图像块（refs.bodyImageBlocks）同口径：它们已按位置写进正文本体，
     不必在【背景信息】里再来一遍（图像本身仍走 refImages → spec.images）。
     过滤只认「带 oncePrompt 标记的图像块」，不按文本前缀猜。 */
  const capBlocks = refs.bodyImageBlocks || [];
  const isImgGen = node.kind === "proc_image";
  const promptBlocks = textBlocks
    .filter((b) => !(isImgGen && b.oncePrompt))
    .concat(isImgGen ? [] : capBlocks);
  const useBlocks = dedupeBlockTitles(
    promptBlocks.concat(refs.tagBlocks || []),
  );
  const prompt = useBlocks.length
    ? "【背景信息】\n" +
      useBlocks.map((b) => "### " + b.title + "\n" + b.text).join("\n\n") +
      "\n\n【内容】\n" +
      refs.prompt
    : refs.prompt;  /* 下发图像序列：与蒙版底图同源（runImagePaths，@ 引用优先），images 已含各条目图 + 广播图；
     正文里出现过的图不再作为条目 / 广播图重复下发 */
  const mergedImages = runImagePaths(
    node,
    undefined,
    refs,
    imagesNotInBody(images, capBlocks),
    true,
  );
  const modelOf = requestModelOf(node, prov);
  return {
    provider: requestProviderOf(prov, modelOf),
    kind:
      node.kind === "proc_text" || node.kind === "agent_task" ? "text" : "image",
    model: modelOf,
    temperature:
      node.temperature == null
        ? 0.7
        : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
    /* 思考强度：文本节点下发 off/低/中/高/最强（off ⇒ thinking 关闭），旧 none → low */
    effort:
      node.kind === "proc_text" ? normalizeTextEffort(node.effort) : undefined,
    size:
      node.kind === "proc_image"
        ? IMAGE_SIZES.includes(node.size)
          ? node.size
          : DEFAULT_IMAGE_SIZE
        : "",
    /* gpt-image-2 直传参数：见 buildSpec 的同一段说明 */
    quality: node.kind === "proc_image" ? node.imgQuality || "" : undefined,
    background: node.kind === "proc_image" ? node.imgBackground || "" : undefined,
    maskPath: node.kind === "proc_image" && maskActive(node) ? node.maskPath : "",
    /* 组输入（本次需求）：接进来的组 → 组内节点清单，接在正文最后。
       只给清单、不给正文（正文由模型用画布读取工具按 id 自取），也不触发组内节点。
       typeof 守卫：这颗函数被单独抽出来跑时不用担心依赖缺失。 */
    prompt:
      withImageParamsPrompt(node, prompt) +
      (typeof groupContextBlock === "function" ? groupContextBlock(node) : ""),
    texts: [],
    images: mergedImages,
    refImage: mergedImages[0] || "",
  };
}

async function runOnceAgg(node, prov, attemptT) {
  /* 行首 /技能名：同 runOnce，普通节点展开进提示词 */
  const dshTask = isDshTask(node);
  const skillWrap = dshTask
    ? null
    : await resolveSkillSlash(procPromptForRun(node), {
        denyCanvasSkills: true,
      });
  const spec = buildSpecAgg(node, prov, skillWrap);
  if (dshTask) {
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
  /* 蒙版局部重绘：前置校验（服务商 / 原图），并在开启时让位画幅锁定（见 app.js 同名函数）。
     判据用**本次请求的服务商**（spec.provider = 按所选模型纠过形态的副本，见 requestProviderOf）：
     混挂端点（配成 text_openai、跑的却是图像模型）本来就该走 /images/edits，
     不能因为服务商级 type 写着 text_openai 就把它判死。 */
  if (node.kind === "proc_image")
    ensureMaskPrereqs(node, spec.provider || prov, typeof idx === "number" ? idx : 0);
  /* 画幅锁定「与首参考图保持一致长宽比」：发请求前把首参考图换成补边副本、
     并把请求尺寸钉到目标画幅；出图后由 finishProcImageOutput 按同一矩形裁回。
     聚合运行没有条目标题，故 itemTitle 用 typeof 兜底（单次 / 聚合两条路径共用这段）。 */
  if (node.kind === "proc_image" && !maskActive(node))
    await applyRatioLockToSpec(node, spec, {
      write: true,
      itemTitle: typeof itemTitle === "string" ? itemTitle : "",
      attemptT: attemptT || 0,
    });
  if (node.kind === "proc_text") ensureVision(prov, spec.images);
  if (node.kind === "proc_text") {
    const r = await apiCallTextStream(spec, (t) =>
      pushThinking(node.id, attemptT || 0, t),
    );
    if (!r.text) throw new Error(I18n.t("响应无文本内容"));
    return { kind: "text", text: r.text };
  }
  /* 聚合出图同一条首次使用闸（见 apiCallTextStream 与 runOnce） */
  if (typeof dsEnsureModelReady === "function" && !dsEnsureModelReady(spec.provider || prov))
    throw typeof dsMissingKeyError === "function"
      ? dsMissingKeyError()
      : new Error(I18n.t("未配置 API Key（请在「设置 · API/配置」中填写）"));
  const rr = await window.api.apiCall(spec);
  if (!rr.ok) throw new Error(rr.error || I18n.t("调用失败"));
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, "", attemptT, "agg"),
    rr.base64,
    rr.ext || "png",
  );
  const path = await finishProcImageOutput(node, spec, res.path, "", attemptT);
  /* 聚合模式：一次运行出一个条目结果 = 一次出图调用 = 一张（同 runOnce 的口径） */
  if (path) tokNoteImageCall(node, spec, 1);
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
      (node.model || d.model || "deepseek-flash") +
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
    copy.onclick = () => appClipboardCopy(pre.textContent, I18n.t("已复制摘要"));
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
    /* 官方 DeepSeek 没 Key：不再只丢一句 toast，直接弹那张图文引导窗 */
    if (
      typeof dsEnsureModelReady === "function" &&
      !dsEnsureModelReady(prov)
    )
      return;
    toast(I18n.t("该服务商未填写 API Key（设置 · API/配置）"), "warn");
    return;
  }
  /* 行首 /技能名：预览也走同口径，看到的就是真正会发出去的内容 */
  const skillWrap = await resolveSkillSlash(procPromptForRun(node), {
    denyCanvasSkills: true,
  });
  const spec = buildSpec(node, prov, 0, skillWrap);
  /* 画幅锁定：预览也要看到「真正会发出去的尺寸 + 补边注入段」。
     write:false 只算几何、不落补边副本（预览不该往素材库塞中间图）。 */
  let rlPlan = null;
  if (node.kind === "proc_image" && node.ratioLockOn && !maskActive(node))
    rlPlan = await applyRatioLockToSpec(node, spec, { write: false });
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
  if (q.multipart && q.multipart.length) {
    /* multipart（/images/edits 等）：这就是**真正下发的输入** —— main 侧列出的是
       sendMultipart 实际拼出的分片（同一份 multipartParts 实现、同一文件名、同一份字节）。
       以前这里打印内部的 { __multipart: {…} } 伪 JSON：里面的 image / mask 只是本地路径数组，
       与线上字段名、文件名、字节都对不上，会被误读成「路径不对 / 蒙版没传」。 */
    txt +=
      "\n" +
      I18n.t("Body（multipart/form-data · 下面就是真正下发的表单字段 · boundary 由传输层自动生成）：") +
      "\n";
    for (const p of q.multipart) {
      if (p.value !== undefined) {
        txt += "  " + p.name + " = " + JSON.stringify(p.value) + "\n";
        continue;
      }
      let line = "  " + p.name + " = " + I18n.t("文件");
      if (p.filename) line += " " + p.filename;
      if (p.dims) line += " · " + p.dims.w + "×" + p.dims.h + " " + I18n.t("像素");
      if (p.bytes != null) line += " · " + fmtBytes(p.bytes);
      line += " · " + p.path;
      if (p.error) line += " · " + I18n.t("读取失败") + "：" + p.error;
      txt += line + "\n";
    }
  } else {
    txt += "\nBody:\n" + JSON.stringify(q.body, null, 2);
  }
  if (
    node.kind === "proc_text" &&
    spec.images.length &&
    !prov.vision
  ) {
    txt = "⚠ " + I18n.t(VISION_HINT) + I18n.t("\n（以下请求将忽略图像输入）\n\n") + txt;
  }
  if (node.kind === "proc_image" && node.bgRmOn && !imgAlphaBgOn(node)) {
    /* 透明背景：让「其实要出两张图」与「本服务商能否严格锚定第 2 通道」在预览里就看得见 */
    txt =
      "⚠ " +
      (matteAnchorSupport(prov)
        ? I18n.t(
            "透明背景（双通道差分抠图）已开启：以下是第 1 通道（纯黑背景 · 唯一基准）请求。运行时会把那张原图当唯一参考图，自动补发第 2 通道（严格复刻、只换纯白背景）并差分出 Alpha —— 共 2 次生成，约 2 倍 Token。\n\n",
          )
        : I18n.t(
            "透明背景（双通道差分抠图）已开启，但本服务商无法严格锚定第 2 通道（接口收不到第 1 通道原图）：运行时将跳过抠图，只交付第 1 通道（纯黑背景）这一张，不会另画一张凑数。\n\n",
          )) +
      txt;
  }
  if (node.kind === "proc_image" && imgAlphaBgOn(node)) {
    /* 背景选了「透明」：接口直出 Alpha，提示词也会自动补一段「背景必须真透明」 */
    txt =
      "⚠ " +
      I18n.t(
        "背景已设为「透明」：请求带 background=transparent（强制 output_format=png），接口直出带 Alpha 通道的 PNG。提示词末尾已自动追加「背景必须是真透明通道」的要求，差分透明算法按钮已禁用（接口已经给透明了，不必再花 2 倍 Token）。注意这是「重绘去背」，不是精确抠像；要像素级抠图请把背景改回默认再用差分抠图。\n\n",
      ) +
      txt;
  }
  if (node.kind === "proc_image" && maskActive(node)) {
    /* 蒙版局部重绘：让「只重绘涂抹区」「蒙版压过了画幅锁定」在预览里就看得见 */
    txt =
      "⚠ " +
      I18n.t(
        "蒙版局部重绘已开启：请求里带 mask（透明区域 = 允许模型重绘，不透明区域 = 尽量保留原图），只对第 1 张 image 生效；蒙版与原图同尺寸原样下发。请把提示词写成「仅修改蒙版透明区域……其他区域保持不变」。\n",
      ) +
      I18n.t(
        "本次请求的 size 跟着首张参考图的像素尺寸走（节点自己选的尺寸不生效）：服务端按 size 出图，size 一旦与蒙版像素不一致就会先重排输入图，蒙版立刻错位、整张主体被重绘。预览里的 image / mask 就是实际下发的路径本身，没有包装。\n",
      ) +
      (node.ratioLockOn
        ? I18n.t(
            "本次以蒙版为准：画幅锁定已跳过（补边会改写第 1 张参考图，蒙版就与原图错位了）。\n",
          )
        : "") +
      "\n" +
      txt;
  }
  if (node.kind === "proc_image" && node.ratioLockOn && !maskActive(node)) {
    /* 画幅锁定：预览里直接给出「补边到哪个画幅、裁回哪个矩形」，
       上面这份请求的 size 已经是目标画幅（补边副本运行时才落盘） */
    txt =
      "⚠ " +
      (rlPlan
        ? I18n.t("画幅锁定（与首参考图保持一致长宽比）已开启：首参考图 ") +
          rlPlan.refW +
          "×" +
          rlPlan.refH +
          I18n.t(
            " 会被复制并补边到 ") +
          rlPlan.genW +
          "×" +
          rlPlan.genH +
          I18n.t(" 画幅（主体落在居中矩形 ") +
          rlPlan.x +
          "," +
          rlPlan.y +
          " · " +
          rlPlan.w +
          "×" +
          rlPlan.h +
          I18n.t(
            "）后再发请求，出图按该矩形裁回 → 最终长宽比 = 参考图长宽比。下方 image 里列的仍是原始参考图路径，运行时会换成补边副本。\n\n",
          )
        : I18n.t(
            "画幅锁定（与首参考图保持一致长宽比）已开启，但本次没有可补边的首参考图（未连入图像输入）：运行时按原尺寸直接生成，不做补边与裁回。\n\n",
          )) +
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
  copy.onclick = () => appClipboardCopy(pre.textContent, I18n.t("已复制请求"));
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
      n.kind === "yue_gen" ||
      /* MOSS-Music 音乐理解：跑完自动级联下游（结果文本 / JSON / 产物路径） */
      n.kind === "moss_music" ||
      /* FLUX 3 Image Klein：本机 ComfyUI 出图，跑完同样自动级联下游 */
      n.kind === "flux3klein_gen" ||
      /* Qwen Image 2.1：本机 ComfyUI 出图，跑完同样自动级联下游 */
      n.kind === "qwenimage_gen" ||
      n.kind === "video_gen" ||
      /* 质检节点：跑完（通过 / 未过）同样要自动级联下游门禁分支 */
      (typeof isQaKindNode === "function" && isQaKindNode(n)) ||
      (typeof isVideoPostKind === "function" && isVideoPostKind(n)) ||
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

/* 是否按「尝试槽」判产出（nodeAlreadyProcessed / nodeHasOutputContent /
   nodeProcessedForRun / nodePlaySucceeded 共用）。
   只有把结果真正写进 attemptOutputs 的执行器（处理 / 智能任务，见 playProcNode 的
   nA > 1 分支）才算多次尝试。媒体生成族的「抽卡次数」也存在 node.attempts 里
   （playVideoGenNode 等的 nRolls = attemptCount），但结果只落 node.output / genPaths，
   从不写尝试槽 —— 按槽判就会把已跑完的视频节点**永久当成「没有输出」**：节点层
   头部 ▶ 选「仅补充」时它又被算成待补、重新丢回队列排队（用户报的 bug），
   上游补跑会再烧一跑，跑完也不级联下游。 */
function usesAttemptSlots(node) {
  if (!node || attemptCount(node) <= 1) return false;
  if (typeof isMediaGenNode === "function" && isMediaGenNode(node)) return false;
  return true;
}

/* 与 ensureProcessed 跳过条件一致：已有结果 / 错误则不再自动跑 */
function nodeAlreadyProcessed(node) {
  if (!node) return true;
  if (node.kind === "wait_file") {
    /* 等待节点：文件曾就绪则视为完成（路径是否仍在由 ensureProcessed 再验） */
    return !!(node.waitReady || node.error);
  }
  if (usesAttemptSlots(node)) {
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
  if (usesAttemptSlots(node)) {
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

/* 清「等待中」标记。
   ⚠ 排队中的媒体任务（超分 / 补帧 / 生成族）不归这里管：它们的排队真源是媒体串行链的
   mediaGenWaiters（见 runMediaGenSerial）。控制批次 / 级联批次收尾时会拿整批目标的 id 调本函数，
   而那一批里「已经进媒体串行链、还没轮到自己起跑」的节点此刻并不在跑 —— 旧写法把它们仍在排队
   的等待态一并删掉，运行队列里那一行就凭空消失（用户看到的正是「排队中的任务被删了」）：
   任务其实还在链上，但期间看不见、点不到、『全部终止』也数不到它。
   所以：仍被媒体串行链持有的 id 一律保留等待态；只有显式停止（opts.force，走 stopNode /
   全部终止 / 起跑点作废）才连它一起清 —— 那条路径本来就该把排队项作废。 */
function clearPendingRun(ids, opts) {
  if (!S.pendingRun || !ids) return;
  const force = !!(opts && opts.force);
  let changed = false;
  for (const id of ids) {
    if (!force && mediaGenQueueHolds(id)) continue;
    if (S.pendingRun.delete(id)) changed = true;
  }
  if (changed) {
    renderCanvas();
    updateRunQueuePanel();
  }
}

/* ── 等待态自愈：清掉「没有任何进程 / 队列真的在等它」的幽灵 pending ──────────
   症状（用户报：breeze 节点「处理完仍然显示等待中，且无法关闭」）：节点跑完（或一次
   排队被作废）之后 id 还留在 S.pendingRun 里，于是
     · 节点头部 ▶ 被钉成 `…` + 「排队等待中…」，点它只是 await 前一次 playLock → 起不了跑；
     · 左下角运行队列的「等待中」永远留着那一行。
   S.pendingRun 只是**展示用**的集合（真正在等的证据分别属于四个队列：媒体串行链
   mediaGenWaiters、计算执行闸 computeExecWaiters / computeExecSlots、控制批次
   _scheduledRunIds、以及运行体自己的 S.runPromises），所以它可以自愈：
   一个 id 若「既不在这四个队列上、也不在跑、也没有挂着的运行 promise」，
   就没有任何东西会来清它 —— 那就是幽灵，当场摘掉。
   安全性：四个入队点（runMediaGenSerial / computeExecAcquire / runDownstreamCascade /
   playNodeBody）都是**同步 addPendingRun 之后才 await**，且挂着运行体的那一半都写在
   S.runPromises 上；扫的时候 running / runPromises 任一为真就跳过，绝不会误伤在飞的运行。 */
function sweepOrphanPendingRuns() {
  if (!S.pendingRun || !S.pendingRun.size) return 0;
  let dropped = 0;
  for (const id of [...S.pendingRun]) {
    try {
      if (typeof mediaGenQueueHolds === "function" && mediaGenQueueHolds(id)) continue;
      if (typeof computeExecWaiters !== "undefined" && computeExecWaiters.has(String(id)))
        continue;
      if (typeof computeExecSlots !== "undefined" && computeExecSlots.has(String(id)))
        continue;
      const n = typeof nodeById === "function" ? nodeById(id) : null;
      if (n && n.running) continue;
      if (S.runPromises && S.runPromises.has(id)) continue;
      if (S._scheduledRunIds && S._scheduledRunIds.has(id)) continue;
      S.pendingRun.delete(id);
      dropped++;
    } catch (_) {
      /* 取数异常时宁可留着这一条，也不误删别人正在等的（下一次心跳会再扫） */
    }
  }
  return dropped;
}

/* ── 假的「处理中」自愈：running 为真，却没有任何运行体 / 队列持有它 ──────────────
   症状（用户报）：上游跑完自动级联下游，下游一直显示「◉ 处理中」、左下角运行队列里也挂着，
   实际什么都没在跑，再点 ▶ 也不动。
   根因在执行入口：`if (node.running) { const p = S.runPromises.get(id); if (p) await p; return; }`
   —— running 只因任何原因残留为真（上一次收尾被打断 / 外部把状态位置真 / 批次早退），
   入口就静默 return：既不报错也不起跑，节点于是永久停在「处理中」。
   两道闸：
     ① 入口（playNodeBody / runComputeExecNode）遇到「running 真但没有运行体」就地清掉再照常起跑
        （见 clearGhostRunningNode）；
     ② 这里做兜底巡检：**连续两次**观察到同一状态才摘（避开「先置 running、紧接着登记运行体」
        的合法瞬时窗口），摘的时候作废旧链 + 释放 playLock，让 ▶ 立刻能重跑。
   判据 = running 真 且 下面这些「它还活着」的证据一条都没有：
     S.runPromises（主执行器）/ S.pendingRun（等待态）/ S._scheduledRunIds（控制批次）/
     媒体串行链 mediaGenWaiters / 后端在途 watcher / 锁恢复轮询 /
     计算执行闸（computeExecWaiters / computeExecSlots）。
   **S.playLocks 不算证据**：它只说明某次 playNode 还没返回，可能正 await 一个死 promise ——
   那正是本 bug 的另一半；所以摘除时连它一起删。
   范围（用户口径）：画布处理节点 —— 文本 / 图像 / 智能任务 / 媒体生成 / 保存 / 函数 / 工具。
   wait_file / 定时 / 延时 / 网络接收 / 控制节点等「合法常驻运行」一律不碰。 */
function nodeRunAliveEvidence(node) {
  const id = node && node.id ? String(node.id) : "";
  if (!id) return true;
  try {
    if (S.runPromises && S.runPromises.has(id)) return true;
    if (S.pendingRun && S.pendingRun.has(id)) return true;
    if (S._scheduledRunIds && S._scheduledRunIds.has(id)) return true;
    if (typeof mediaGenWaiters !== "undefined" && mediaGenWaiters.has(id)) return true;
    if (typeof mediaBackendRunWatchers !== "undefined" && mediaBackendRunWatchers.has(id))
      return true;
    if (typeof mediaGenRestoreTimers !== "undefined" && mediaGenRestoreTimers.has(id))
      return true;
    if (typeof computeExecWaiters !== "undefined" && computeExecWaiters.has(id)) return true;
    if (typeof computeExecSlots !== "undefined" && computeExecSlots.has(id)) return true;
  } catch (_) {
    /* 取数异常（含脚本尚未初始化完）时宁可当成「还活着」，绝不误杀 */
    return true;
  }
  return false;
}

/* 自愈覆盖的节点类型（用户口径的画布处理节点）；其余 kind 一律不碰 */
function isGhostSweepKind(n) {
  if (!n || !n.id) return false;
  try {
    if (isProcessPlayKind(n)) return true; /* proc_text / proc_image / agent_task */
    if (typeof isMediaGenNode === "function" && isMediaGenNode(n)) return true;
    if (typeof isComputeExecKind === "function" && isComputeExecKind(n)) return true;
    if (typeof isSaveNode === "function" && isSaveNode(n)) return true;
  } catch (_) {
    return false;
  }
  return false;
}

/* 摘掉一个「假处理中」状态位。
   用户口径：**什么都不留** —— 不写 node.error、不动输出与落盘结果，只回到「从未运行」的状态行。
   动作（与共识一致）：作废旧执行链 → 清 running → 释放 playLock → 允许下一次 ▶ 立刻起跑。
   为什么要复位 _aborted：判据成立时（无运行体 / 无排队位）这一批已经没有活着的执行体，
   而媒体执行器起跑前会拿 _aborted 当「本批已作废」拦掉 —— 不复位就会出现
   「显示摘掉了，但点 ▶ 又被判已终止」的死循环。作废靠 bumpNodeStop 递增的 _stopTick
   （老的串行位次照样作废），不靠 _aborted 长期挂着。 */
function clearGhostRunningNode(node, reason) {
  if (!node || !node.id) return false;
  const id = String(node.id);
  try {
    bumpNodeStop(node); /* 旧链在下一个检查点自行退出（_stopTick++ 让老的串行位次作废） */
  } catch (_) {}
  node.running = false;
  node._aborted = false;
  node._ghostCleared = true;
  node._ghostClearedAt = Date.now();
  if (S.playLocks) S.playLocks.delete(id);
  if (S.pendingRun) S.pendingRun.delete(id);
  try {
    console.warn(
      "[MTNode] 摘掉假性「处理中」：",
      node.title || id,
      "·",
      reason || "",
    );
  } catch (_) {}
  return true;
}

/* 巡检：连续两次观察到「running 真且无任何运行体证据」才摘（同一拍内的重复调用不计数）。
   挂点 = collectRunQueue（运行队列取数），不另起定时器；内部**不重绘运行队列面板**，
   避免 「面板取数 → 自愈 → 再刷面板」 的递归。 */
const GHOST_SWEEP_GAP_MS = 400;
function sweepGhostRunningNodes() {
  if (S._ghostSweeping) return 0;
  const seen = S._ghostSweepSeen || (S._ghostSweepSeen = new Map());
  const now = Date.now();
  let cleared = 0;
  const visit = (n) => {
    if (!n || !n.id) return;
    const id = String(n.id);
    if (!n.running || !isGhostSweepKind(n) || nodeRunAliveEvidence(n)) {
      if (seen.has(id)) seen.delete(id);
      return;
    }
    const prev = seen.get(id);
    if (!prev) {
      seen.set(id, { at: now, hits: 1 });
      return;
    }
    /* 同一拍里被重复调用（面板 + 状态栏）不算新的一次观察 */
    if (now - prev.at < GHOST_SWEEP_GAP_MS) return;
    seen.delete(id);
    if (clearGhostRunningNode(n, "无运行体 / 无排队位")) cleared++;
  };
  S._ghostSweeping = true;
  try {
    const seenNodes = new Set();
    const visitAll = (w) => {
      if (!w || !Array.isArray(w.nodes)) return;
      for (const n of w.nodes) {
        if (!n || seenNodes.has(n)) continue;
        seenNodes.add(n);
        visit(n);
      }
    };
    visitAll(S.wf);
    for (const wid of Object.keys(S.wfBag || {})) visitAll(S.wfBag[wid]);
    /* 不在任何画布上的残留条目不必留档 */
    if (seen.size > 400) seen.clear();
  } finally {
    S._ghostSweeping = false;
  }
  if (cleared) {
    renderCanvas();
    scheduleSave(true);
  }
  return cleared;
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

async function ensureProcessedAll(sources, ran, retryErrored) {
  ran = ran || [];
  const list = (sources || []).filter(Boolean);
  if (!list.length) return ran;
  if (list.length === 1) return ensureProcessed(list[0], ran, retryErrored);
  await Promise.all(list.map((src) => ensureProcessed(src, ran, retryErrored)));
  return ran;
}

/* 上游补跑的「是否已完成」判定：已有产物 = 已完成；**只有错误、没有任何产物**的，
   在用户亲手起跑（含 ▶ 控制批次）时算「未完成」，重试一次。
   旧写法把 error 当完成（`if (node.error) return true` / `// 已有错误则不再自动重试`），
   于是失败过一次的上游（现场：底图 · gpt-image-2.5）在后续每次 ▶ 里被整条静默跳过 ——
   输出空、没有 ranAt、日志也没有一行提示，看起来就像「节点被跳过」。
   自动级联（无用户动作触发的下游传递）仍不重试：那会变成失败节点无限重烧。 */
function nodeProcessedForRun(node, retryErrored) {
  if (!node) return true;
  if (!retryErrored) return nodeAlreadyProcessed(node);
  const hasOutput =
    node.kind === "wait_file"
      ? !!(node.waitReady || node.error)
      : usesAttemptSlots(node)
        ? (node.attemptOutputs || []).some(
            (o) => o && (o.output || (o.batchOutputs && o.batchOutputs.length)),
          )
        : !!(node.output || (node.batchOutputs && node.batchOutputs.length));
  if (hasOutput) return true;
  /* 有错误但没产物 → 交给补跑重试一次 */
  return false;
}

/* 上游「确实在跑、但本进程拿不到它的运行体」时，等它落定再让下游取值。
   现场（用户报）：批量执行 H3 视频时，后处理节点（超分 / 补帧）突然报「源视频未连接」——
   线是通的，只是那一刻上游视频还没产出（在别的批次里跑 / 排队，或运行时是从后端锁恢复的，
   没有 S.runPromises 可等）。旧写法在这两种情形下直接放行，下游拿空值当场判死。
   等不到（被终止 / 上游卡死）就照常放行，绝不把整批挂死 —— 提示语那边会说清原因。 */
const UPSTREAM_SOURCE_WAIT_MS = 10 * 60 * 1000;
async function waitUpstreamSettle(node, maxMs) {
  if (!node || !node.id) return false;
  const cap = Math.max(1000, Number(maxMs) || UPSTREAM_SOURCE_WAIT_MS);
  const t0 = Date.now();
  const seq0 = typeof GLOBAL_STOP_SEQ === "number" ? GLOBAL_STOP_SEQ : null;
  while (node.running && Date.now() - t0 < cap) {
    /* 期间按过「全部终止」：上游已作废，立刻放行（让下游按真实原因收场，不干等） */
    if (seq0 != null && typeof GLOBAL_STOP_SEQ === "number" && GLOBAL_STOP_SEQ !== seq0)
      return false;
    if (S._lastStopAllAt && Date.now() - Number(S._lastStopAllAt) < 1500) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
  return !node.running;
}

/* 递归确保上游处理节点均已产生结果（未被处理过的先执行，直到所有输入都有内容）。
   多个互不依赖的上游并行补跑，避免排队。 */
async function ensureProcessed(node, ran, retryErrored) {
  ran = ran || [];
  if (!node) return ran;
  if (!isAutoProcKind(node)) return ran;
  /* 已有产物则立刻返回，切勿 await 仍被 playNode 握着的锁。
     典型死锁：处理节点完成后级联保存，playNode 持锁等 cascade，save 又 ensure 上游去等这把锁。 */
  if (node.kind !== "wait_file" && nodeProcessedForRun(node, retryErrored)) return ran;
  await ensureProcessedAll(procSourcesOutsideSchedule(node), ran, retryErrored);
  if (node.kind !== "wait_file" && nodeProcessedForRun(node, retryErrored)) return ran;
  /* 本批调度中的节点只等队列启动，禁止在此 playNode，避免互相 await playLocks 锁死。
     但它此刻**真的在跑**（另一批 / 级联已在跑它）时必须等它落定：
     否则下游会按「源视频为空」当场起跑，报出「请连接源视频输入」（线其实是通的），
     等上游跑完再点一次又一切正常 —— 批量执行 H3 视频时的现场。 */
  if (isScheduledRunNode(node)) {
    if (!node.running) return ran;
    const sp = S.runPromises && S.runPromises.get(node.id);
    if (sp) await sp;
    else await waitUpstreamSettle(node);
    return ran;
  }
  if (S.playLocks && S.playLocks.has(node.id)) {
    if (node.kind !== "wait_file" && nodeProcessedForRun(node, retryErrored)) return ran;
    await S.playLocks.get(node.id);
    return ran;
  }
  if (node.running) {
    /* 有运行体 → 等它；没有（后端锁恢复的在途任务 / 别的批次登记后已在跑）→
       轮询等它停，别把「还在跑」当成「已经跑完、可以取空值」。 */
    const p = S.runPromises && S.runPromises.get(node.id);
    if (p) await p;
    else await waitUpstreamSettle(node);
    return ran;
  }
  if (usesAttemptSlots(node)) {
    const outs = node.attemptOutputs || [];
    if (
      outs.some(
        (o) => o && (o.output || (o.batchOutputs && o.batchOutputs.length)),
      )
    )
      return ran;
    if (outs.some((o) => o && o.error) && !retryErrored) return ran; // 已有错误则不再自动重试
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
      if (node.error) {
        if (!retryErrored) return ran; // 已有错误则不再自动重试
        /* 用户亲手起跑：清掉旧错误，让这次补跑的错误是**本轮**的（否则界面上留着上一次的文案） */
        node.error = null;
        node.ranAt = 0;
        node.attemptOutputs = null;
        node.attemptsDone = 0;
        node.attemptIdx = 0;
      }
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
      (typeof isQaKindNode === "function" && isQaKindNode(n)) ||
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
      n.kind === "input_image" ||
      /* 素材节点＝静态内容源：与输入族一样「只穿过不执行」
         （它没有执行体，内容恒在素材库里；穿过它才能让它下游的节点被级联收进来） */
      n.kind === "asset")
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
  if (usesAttemptSlots(node)) {
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
  /* 目标里若有「running 真但没有任何运行体」的残状态（用户报的现场：下游一直显示处理中、
     实际没跑，而级联又因为 !n.running 把它跳过，于是永远没人来收它），先就地摘掉，
     这一批才能真的把它拉起来。判据与运行队列自愈同一份（nodeRunAliveEvidence）。 */
  for (const n of nodes || []) {
    if (!n || !n.id || !nodeById(n.id) || !n.running) continue;
    if (!isGhostSweepKind(n) || nodeRunAliveEvidence(n)) continue;
    clearGhostRunningNode(n, "级联：目标卡在假处理中");
  }
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

/* ── 工作目录闸门（画布行为前置检查）───────────────────────────────────────
   画布上真干活的行为（执行节点 / 保存落盘 / 新建画布）都要往工作目录写东西：
   目录空着 → 相对路径解析不出绝对路径；目录填错（被删 / 打错）→ 写到深处才失败，
   用户只看到一句「写入失败」，不知道改哪。所以起跑前先问一次，缺 / 错就弹窗要求填写：
   路径不存在时**先问用户要不要新建**，确认才建（绝不偷偷建）。
   弹窗与「建 / 选」的实现都在 app.js 的 chooseWorkspaceFolderDialog / createFolderPath。 */
const WS_GATE_LABEL = {
  canvas: "画布工作目录",
  node: "节点工作目录",
};

/* 当前画布的工作目录现场：ok 表示「有效可写」，none 表示空，missing 表示填了但不存在 */
async function workspaceIssueOf() {
  const raw = String(wfWorkspace() || "").trim();
  if (!raw) return { ok: false, none: true, raw, label: WS_GATE_LABEL.canvas };
  if (await pathIsExistingDir(raw))
    return { ok: true, none: false, raw, label: WS_GATE_LABEL.canvas };
  return { ok: false, none: false, missing: true, raw, label: WS_GATE_LABEL.canvas };
}

/* 节点自己的目录口径（dshWsOf：手填 agentWorkspace / workspace 优先）。
   没有手填时节点按画布口径走，交回画布闸门统一问。 */
async function workspaceIssueOfNode(node) {
  const raw = String(dshWsOf(node) || "").trim();
  if (!raw) return workspaceIssueOf();
  if (await pathIsExistingDir(raw))
    return { ok: true, none: false, raw, label: WS_GATE_LABEL.node };
  return { ok: false, none: false, missing: true, raw, label: WS_GATE_LABEL.node };
}

/* 把一次现场的「缺 / 错」问清楚，返回可用的目录；用户放弃则回 ""。
   路径填错（missing）时预填错的那一条，用户看见自己填的就知道错在哪。 */
async function resolveWorkspaceIssue(issue, node) {
  if (!issue || issue.ok) return issue && issue.raw ? String(issue.raw) : "";
  if (typeof chooseWorkspaceFolderDialog !== "function") return "";
  const canvasWs = issue.label === WS_GATE_LABEL.canvas;
  const picked = await chooseWorkspaceFolderDialog({
    title: I18n.t("请填写工作目录"),
    message: issue.none
      ? canvasWs
        ? I18n.t(
            "这张画布还没有工作目录。智能节点读写文件、相对路径保存都相对该目录，请先填写或选择一个文件夹。",
          )
        : I18n.t(
            "这个节点还没有工作目录。它读写文件与相对路径落盘都相对该目录，请先填写或选择一个文件夹。",
          )
      : I18n.t("这项工作用的工作目录已经不存在了：") +
        "\n" +
        String(issue.raw || "") +
        "\n\n" +
        I18n.t("请重新填写或选择一个有效的文件夹：你选的这个会记回它的归属处（画布统一目录或该节点）。"),
    canvasWorkspace: canvasWs,
    initialPath: issue.none ? "" : String(issue.raw || ""),
    getPath: () =>
      canvasWs ? String(wfWorkspace() || "") : String(dshWsOf(node) || ""),
  });
  const v = String(picked || "").trim();
  if (!v) return "";
  /* 用户刚填 / 选的这个目录要记在**哪一层**：
     · 画布现场（画布目录空 / 失效）→ 记回画布统一目录（顶栏那一格会跟着变，整张画布一起生效）；
     · 节点现场（画布已有有效目录，只是这个节点手填的那条失效了）→ 只改这个节点的目录；
     · 节点现场但画布本来就没有统一目录 → 记回画布：闸门问的是「这项工作用哪个目录」，
       在画布层落定，后面别的节点就不用再逐个问一遍。 */
  const manualBefore = String(dshWsOf(node) || "").trim();
  const canvasBefore = String(wfWorkspace() || "").trim();
  if (!canvasWs && (manualBefore || canvasBefore)) {
    if (v !== manualBefore) {
      setDshWs(node, v);
      scheduleSave();
      renderCanvas();
    }
  } else if (v !== canvasBefore && S.wf) {
    S.wf.workspace = v;
    scheduleSave();
    renderCanvas();
  }
  return v;
}

/* 唯一入口：画布行为起跑前调用。返回可用目录（含刚新建好的），用户放弃运行则回 ""。
   并发弹窗去重：控制节点这一批可能同时叫起好几个下游，重入的一律等同一轮结果，
   不会叠出好几个弹窗、也不会把同一批的一半放过去一半拦下。 */
function ensureRunWorkspace(node) {
  if (S._wsGate) return S._wsGate;
  const issue = node ? workspaceIssueOfNode(node) : workspaceIssueOf();
  const p = Promise.resolve(issue)
    .then((cur) => resolveWorkspaceIssue(cur, node))
    .then((v) => {
      S._wsGate = null;
      return v;
    })
    .catch(() => {
      S._wsGate = null;
      return "";
    });
  S._wsGate = p;
  return p;
}

/* 用户点节点 ▶ 的统一入口：先过工作目录闸门，再执行；放弃则不起跑、也不报错。
   内部驱动的执行（控制流 / 级联 / 补跑）直接调 playNode(..., quiet=true)，
   闸门只在用户真正发起的那一次问（否则一批 N 个下游会连问 N 次）。 */
async function playUserNode(node, opts) {
  if (!node) return;
  const dir = await ensureRunWorkspace(node);
  if (!dir) {
    toast(I18n.t("未设置有效的工作目录：已取消本次执行"), "warn");
    return;
  }
  if (isSaveNode(node)) return saveNodeAction(node, { skipWsGate: true });
  await playNode(node, false, opts || {});
}

async function playNode(node, quiet, opts) {
  if (!S.playLocks) S.playLocks = new Map();
  const hit = S.playLocks.get(node.id);
  if (hit) {
    /* 唯一允许「击穿旧 playLock」的情形（本轮 bug）：上一次发起是媒体族排队，
       那次排队已被取消，这一节点现在只想重新进队列 —— 见 mediaRequeueStaleLock。
       照旧 await 旧 promise 的话，▶ 会一直等一个已经没人要的旧位次（点了没反应）。 */
    if (typeof mediaRequeueStaleLock === "function" && mediaRequeueStaleLock(node)) {
      mediaNodeRequeueStale(node);
    } else {
      await hit;
      return;
    }
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
    /* 服务商对不上就不跑：先按 名称唯一 / 模型归属 自动换掉（并批量换同一缺失值），
       仍对不上则保留原值、记警告并跳过本节点。 */
    if (typeof ensureNodeProviderForRun === "function" && !ensureNodeProviderForRun(node)) return;
    /* 资产锚定闸门（缺口文档 P0-2 / G3 规则 2）：节点显式开了 requireAsset 就必须在
       assetRefs 里声明真实存在的 "id@rev"（对照工程 manifest.json）。纯文本直出直接拒跑，
       点名缺哪一项。没开 / 没这个模块 = 一次直通，零行为变化。 */
    if (typeof mfAssetGate === "function") {
      const gate = await mfAssetGate(node);
      if (!gate || gate.ok === false) {
        const msg = (gate && gate.error) || I18n.t("资产引用校验未通过");
        node.lastError = msg;
        if (typeof renderCanvas === "function") renderCanvas();
        toast(msg, "err");
        return;
      }
    }
    /* 「参数」端子：运行时临时覆写本节点的配置（跑完恢复，不改画布）。
       没有参数线时 NParam.runWithParams 就是一次直通调用 —— 零开销、零行为变化。 */
    const body = () => playNodeBody(node, quiet, opts || {});
    const cascadeAfter =
      typeof NParam === "object" && NParam && typeof NParam.runWithParams === "function"
        ? await NParam.runWithParams(node, body)
        : await body();
    /* 本节点刚产出的值若有一条线直接喂进素材节点的端子：这一刻才做同步检查
       （库里那条空着 → 自动写进去；已有内容且不同 → 只点亮 ⟳ 等用户点）。
       不放 playNodeBody 里 —— 要等本节点真的有了新输出，检查才有意义。 */
    if (typeof assetSyncConsumers === "function") {
      try {
        await assetSyncConsumers(node);
      } catch (e) {
        /* 素材库写挂了不影响本轮执行结果 */
      }
    }
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
      node.kind === "yue_gen" ||
      /* MOSS-Music 音乐理解（moss_music）：本机常驻后端分析音频 / 视频，探活 / 排队 / 终止同待遇 */
      node.kind === "moss_music" ||
      /* FLUX 3 Image Klein（flux3klein_gen）：本机 ComfyUI 出图，探活 / 排队 / 终止同待遇 */
      node.kind === "flux3klein_gen" ||
      /* Qwen Image 2.1（qwenimage_gen）：本机 ComfyUI 出图，探活 / 排队 / 终止同待遇 */
      node.kind === "qwenimage_gen" ||
      /* Breeze 语音（Breeze TTS 2）：本机唯一的语音后端（文本转语音），探活 / 排队 / 终止同待遇 */
      node.kind === "breeze_gen" ||
      /* InfiniteTalk 数字人（infinitetalk_gen）：本机 ComfyUI 出片，探活 / 排队 / 终止按媒体族同待遇 */
      node.kind === "infinitetalk_gen" ||
      /* SoulX-FlashHead Lite 实时数字人（soulxflashhead_gen）：自带 Python 服务出片，探活 / 排队 / 终止同待遇 */
      node.kind === "soulxflashhead_gen" ||
      node.kind === "video_gen" ||
      node.kind === "remotion" ||
      /* 视频后处理（video_upscale / video_interp · 超分 / 补帧）：
         与 video_gen 同走 H3 后端与全局媒体互斥锁 —— 后端探活、串行排队、
         运行队列、单独 / 全部终止一律按媒体族同待遇（isVideoPostKind 见 app.js） */
      (typeof isVideoPostKind === "function" && isVideoPostKind(node)))
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
      /* 落点端口（目标输入口）一起传下去：闸门要按口记到达才谈得上「全部到齐」 */
      await runControlledNode(next, s2, Number(w.toIndex || 0), node.id);
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

/* GPU 读数的形状归一（节点面板只认单帧形）。
   push 通道（onMusic3Gpu / onYueGpu / onH3Gpu）一律是单帧：
     { name, memUsed, memTotal, util, memPct }
   但各宿主 status 里的 gpu 字段形状不齐（探测形如 gpus:[{ memTotalMb, memUsedMb }]、
   breeze 的旧键名 utilPct / memUsedMb），节点面板读的是单帧字段，不折算就会读到 undefined →
   显存条与 GPU 条都画成 0%：
   运行期「2s 探活回写 ui.info（探测形 → 0%）」与「2s GPU 推流（单帧 → 真值）」交替，
   读数就一直在闪跳。这里统一折算成单帧；取不到（null / 空 gpus）返回 null。 */
function normalizeGpuReading(gpu) {
  if (!gpu) return null;
  const g = Array.isArray(gpu) ? gpu[0] : gpu.gpus ? gpu.gpus[0] : gpu;
  if (!g || typeof g !== "object") return null;
  const num = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  /* infinitetalk 的探测形把总量/已用叫 memMb / usedMb（控制台沿用它），这里一并折算，
     否则 infinitetalk_gen 节点的显存条与 GPU 条都恒为 0%。 */
  const memUsed = num(g.memUsed != null ? g.memUsed : g.memUsedMb != null ? g.memUsedMb : g.usedMb);
  /* Qwen Image 2.1 / FLUX 3 Klein 的宿主 nvidia-smi 探测形是 totalMb / usedMb（控制台窗直接读它）：
     总量不认 totalMb 就 memTotal=undefined → memPct 算不出来，显存条与显存占用恒画成 0%。 */
  const memTotal = num(
    g.memTotal != null
      ? g.memTotal
      : g.memTotalMb != null
        ? g.memTotalMb
        : g.memMb != null
          ? g.memMb
          : g.totalMb,
  );
  /* breeze 的管理服务把利用率叫 utilPct（旧键名），其余宿主用 util：
     两种都要认，否则 breeze_gen 节点的「GPU」条永远读不到值、画成 0%。 */
  const util = num(g.util != null ? g.util : g.utilPct != null ? g.utilPct : g.utilization);
  let memPct = num(g.memPct);
  if (memPct == null && memTotal != null && memTotal > 0 && memUsed != null)
    memPct = Math.round((memUsed / memTotal) * 1000) / 10;
  /* 三项都量不到（Qwen / FLUX 的 hasNvidia:false 就是这种空壳）：返回 null，
     面板才会写「暂无 GPU 读数」，而不是画两条 0% 的假读数。 */
  if (memUsed == null && memTotal == null && util == null) return null;
  return { name: g.name || "", memUsed, memTotal, util, memPct };
}

function summarizeMediaBackendStatus(node, st) {
  if (!st) return null;
  const apiUp =
    node.kind === "music_gen" || node.kind === "yue_gen"
      ? !!st.gradioUp
      : node.kind === "moss_music"
        ? !!(st.ready || (st.health && st.health.ok))
        : st.apiUp != null
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
    /* MOSS-Music：就绪 / 装载中 / 当前模型与量化档（面板铭牌用） */
    ready: !!st.ready,
    loading: !!st.loading,
    model: st.model || "",
    quant: st.quant || "",
    /* 归一成单帧形（各宿主 status.gpu 形状不齐），见 normalizeGpuReading */
    gpu: normalizeGpuReading(st.gpu),
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

/* 后端状态单一取数口：各生成节点自己的宿主插件（Gradio / Breeze 管理服务 / Comfy）。
   remotion 无远端后端，调用方自行早退。取不到（插件未装 / IPC 异常）一律返回 null。 */
async function fetchMediaBackendStatus(node) {
  if (!node || !window.api) return null;
  if (node.kind === "music_gen")
    return window.api.music3Status ? await window.api.music3Status() : null;
  if (node.kind === "yue_gen")
    return window.api.yue2Status ? await window.api.yue2Status() : null;
  if (node.kind === "moss_music")
    return window.api.mossmusicStatus ? await window.api.mossmusicStatus() : null;
  if (node.kind === "flux3klein_gen")
    return window.api.flux3kleinStatus ? await window.api.flux3kleinStatus() : null;
  if (node.kind === "qwenimage_gen")
    return window.api.qwenimageStatus ? await window.api.qwenimageStatus() : null;
  if (node.kind === "breeze_gen")
    return window.api.breezeStatus ? await window.api.breezeStatus() : null;
  if (node.kind === "infinitetalk_gen")
    return window.api.infinitetalkStatus ? await window.api.infinitetalkStatus() : null;
  if (node.kind === "soulxflashhead_gen")
    return window.api.soulxflashheadStatus ? await window.api.soulxflashheadStatus() : null;
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
  if (window.api.onYueProgress) {
    window.api.onYueProgress((data) => {
      if (!data || data.phase !== "generate" || !data.nodeId) return;
      const n = nodeById(data.nodeId);
      if (!n || n.kind !== "yue_gen") return;
      const ui = ensureBackendUiState(n);
      if (data.cancelled || n._aborted || String(data.message || "") === "已取消") {
        n.running = false;
        n.error = null;
        n.yueStatus = I18n.t("已取消");
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        stopMediaBackendRunWatcher(n.id);
        refreshMediaNodeUi(n, { soft: true });
        return;
      }
      if (data.pct != null) ui.genPct = Math.max(0, Math.min(100, Number(data.pct) || 0));
      if (data.message) {
        ui.genMsg = mediaGenRollProgressTag(n) + String(data.message);
        n.yueStatus = ui.genMsg;
      }
      if (data.error && looksLikeBackendConnError(data.message)) {
        markMediaBackendDown(n);
      }
      refreshMediaNodeUi(n, { soft: true });
    });
  }
  if (window.api.onH3Progress) {
    window.api.onH3Progress((data) => {
      if (!data || !data.nodeId) return;
      /* 两条进度线共用 h3:progress：phase='generate' → video_gen；
         phase='post' → 独立后处理节点（超分 / 补帧），两侧状态字段同为 videoStatus */
      const isPost = data.phase === "post";
      if (!isPost && data.phase !== "generate") return;
      const n = nodeById(data.nodeId);
      if (!n) return;
      if (
        isPost
          ? !(typeof isVideoPostKind === "function" && isVideoPostKind(n))
          : n.kind !== "video_gen"
      )
        return;
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
  if (window.api.onYueGpu) {
    window.api.onYueGpu((gpu) => {
      if (!gpu || !S.wf) return;
      for (const n of S.wf.nodes || []) {
        if (n.kind !== "yue_gen") continue;
        const ui = ensureBackendUiState(n);
        if (ui.ok !== true && !n.running) continue;
        ui.info = ui.info || {};
        ui.info.gpu = gpu;
        if (n.running || S.sel === n.id) refreshMediaNodeUi(n, { soft: true });
      }
    });
  }
  if (window.api.onFlux3KleinProgress) {
    window.api.onFlux3KleinProgress((data) => {
      /* 安装进度归插件控制台窗；这里只认带 nodeId 的生成进度 */
      if (!data || data.phase !== "generate" || !data.nodeId) return;
      const n = nodeById(data.nodeId);
      if (!n || n.kind !== "flux3klein_gen") return;
      const ui = ensureBackendUiState(n);
      if (data.cancelled || n._aborted || String(data.message || "") === "已取消") {
        n.running = false;
        n._aborted = false;
        n.flux3kleinStatus = I18n.t("已取消");
        ui.genMsg = n.flux3kleinStatus;
        stopMediaBackendRunWatcher(n.id);
        refreshMediaNodeUi(n, { soft: true });
        return;
      }
      const pct = Number(data.pct);
      if (Number.isFinite(pct)) ui.genPct = Math.max(2, Math.min(99, pct));
      if (data.message) {
        ui.genMsg = mediaGenRollProgressTag(n) + String(data.message);
        n.flux3kleinStatus = ui.genMsg;
      }
      if (data.error && looksLikeBackendConnError(data.message)) markMediaBackendDown(n);
      refreshMediaNodeUi(n, { soft: true });
    });
  }
  if (window.api.onFlux3KleinGpu) {
    window.api.onFlux3KleinGpu((gpu) => {
      if (!gpu || !S.wf) return;
      for (const n of S.wf.nodes || []) {
        if (n.kind !== "flux3klein_gen") continue;
        const ui = ensureBackendUiState(n);
        if (ui.ok !== true && !n.running) continue;
        ui.info = ui.info || {};
        ui.info.gpu = gpu;
        if (n.running || S.sel === n.id) refreshMediaNodeUi(n, { soft: true });
      }
    });
  }
  if (window.api.onQwenImageProgress) {
    window.api.onQwenImageProgress((data) => {
      /* 安装进度归插件控制台窗；这里只认带 nodeId 的生成进度 */
      if (!data || data.phase !== "generate" || !data.nodeId) return;
      const n = nodeById(data.nodeId);
      if (!n || n.kind !== "qwenimage_gen") return;
      const ui = ensureBackendUiState(n);
      if (data.cancelled || n._aborted || String(data.message || "") === "已取消") {
        n.running = false;
        n._aborted = false;
        n.qwenimageStatus = I18n.t("已取消");
        ui.genMsg = n.qwenimageStatus;
        stopMediaBackendRunWatcher(n.id);
        refreshMediaNodeUi(n, { soft: true });
        return;
      }
      const pct = Number(data.pct);
      if (Number.isFinite(pct)) ui.genPct = Math.max(2, Math.min(99, pct));
      if (data.message) {
        ui.genMsg = mediaGenRollProgressTag(n) + String(data.message);
        n.qwenimageStatus = ui.genMsg;
      }
      if (data.error && looksLikeBackendConnError(data.message)) markMediaBackendDown(n);
      refreshMediaNodeUi(n, { soft: true });
    });
  }
  if (window.api.onQwenImageGpu) {
    window.api.onQwenImageGpu((gpu) => {
      if (!gpu || !S.wf) return;
      for (const n of S.wf.nodes || []) {
        if (n.kind !== "qwenimage_gen") continue;
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
        /* GPU 读数同样覆盖视频后处理节点（与 video_gen 共用一个后端） */
        if (
          n.kind !== "video_gen" &&
          !(typeof isVideoPostKind === "function" && isVideoPostKind(n))
        )
          continue;
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
  /* 视频后处理节点共用 H3 控制台（同一后端进程） */
  const isH3 =
    node.kind === "video_gen" ||
    (typeof isVideoPostKind === "function" && isVideoPostKind(node));
  /* InfiniteTalk 数字人是独立插件（自己的 ComfyUI 与控制台窗），不能落进 music3 兜底 */
  const isInfinitetalk = node.kind === "infinitetalk_gen";
  /* SoulX-FlashHead Lite 也是独立插件（自带服务与控制台窗） */
  const isSoulxflashhead = node.kind === "soulxflashhead_gen";
  b.title = isH3
    ? I18n.t("打开 H3 控制台日志")
    : isInfinitetalk
      ? I18n.t("打开 InfiniteTalk 数字人控制台")
      : isSoulxflashhead
        ? I18n.t("打开 SoulX 实时数字人控制台")
        : node.kind === "yue_gen"
        ? I18n.t("打开 YuE2 控制台日志")
        : node.kind === "flux3klein_gen"
            ? I18n.t("打开 FLUX 3 Image Klein 控制台")
          : node.kind === "qwenimage_gen"
            ? I18n.t("打开 Qwen Image 2.1 控制台")
          : node.kind === "moss_music"
            ? I18n.t("打开 MOSS-Music 控制台")
          : node.kind === "breeze_gen"
            ? I18n.t("打开 Breeze TTS 2 控制台")
            : I18n.t("打开 Music 3 控制台日志");
  b.onclick = async (ev) => {
    ev.stopPropagation();
    if (!window.api) return;
    try {
      const r =
        isH3
          ? window.api.h3Open
            ? await window.api.h3Open()
            : null
          : isInfinitetalk
            ? window.api.infinitetalkOpen
              ? await window.api.infinitetalkOpen()
              : null
            : isSoulxflashhead
              ? window.api.soulxflashheadOpen
                ? await window.api.soulxflashheadOpen()
                : null
              : node.kind === "yue_gen"
              ? window.api.yue2Open
                ? await window.api.yue2Open()
                : null
              : node.kind === "flux3klein_gen"
                  ? window.api.flux3kleinOpen
                    ? await window.api.flux3kleinOpen()
                    : null
                : node.kind === "qwenimage_gen"
                  ? window.api.qwenimageOpen
                    ? await window.api.qwenimageOpen()
                    : null
                : node.kind === "moss_music"
                  ? window.api.mossmusicOpen
                    ? await window.api.mossmusicOpen()
                    : null
                : node.kind === "breeze_gen"
                  ? window.api.breezeOpen
                    ? await window.api.breezeOpen()
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

/* ── 生成族节点头部那对键：▶（起跑）+ ■（终止）─────────────────────────────
   本函数是这 6 个节点（music_gen / yue_gen / video_gen / 视频后处理 /
   breeze_gen / remotion）头部这对键的**唯一实现**：以前每个块各抄一遍，规则
   一改就得改七处（这次就漏了一处 —— 见下）。
   本轮 bug（用户报：breeze 节点「处理完仍然显示等待中，且无法关闭」）的两半都修在这里：
     · ▶ 的形态：未跑 / 排队中 / 有错 三态照旧（排队中 = `…` + 「排队等待中…」）；
     · ■ 的形态：**只要还在队列上（running ∪ 排队中）就给 ■**。旧写法只在 running 时给，
       而排队中的节点 ▶ 是禁用的（点它只会 await 前一次 playLock），于是「排队中」这一态
       既起不了跑、也停不掉 —— 用户看到的就是一个关不掉的等待中节点。 */
function appendMediaPlayBtns(head, node, title, opts) {
  const o = opts || {};
  const pending = isNodePending(node);
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "n-play" +
    (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
  b.textContent = node.running || pending ? "…" : "▶";
  b.title = pending ? I18n.t("排队等待中…") : I18n.t(title);
  b.onclick = (ev) => {
    ev.stopPropagation();
    playUserNode(node);
  };
  head.appendChild(b);
  if (!node.running && !pending) return;
  const stop = document.createElement("button");
  stop.type = "button";
  /* 样式与别处那颗 ■ 同源：.n-stop 本身就是红色方块（不加文字，避免把小方块撑变形） */
  stop.className = "n-play n-stop";
  stop.title = node.running
    ? I18n.t(o.stopTitle || "取消生成请求")
    : I18n.t("取消排队（这个任务还没起跑）");
  stop.onclick = (ev) => {
    ev.stopPropagation();
    stopNode(node);
  };
  head.appendChild(stop);
}

/* ── 处理族节点头部那对键：▶（起跑）+ ■（终止）─────────────────────────────
   与 appendMediaPlayBtns 同一口径，只差文案：**排队中同样给 ■**。
   旧写法一律只在 `node.running` 时给 ■，而排队中的 ▶ 是禁用的（点它只会 await 前一次
   playLock）→ 「排队中」这一态既起不了跑、也停不掉，用户看到的就是一个关不掉的等待中
   节点（本轮 bug：breeze 节点处理完仍显示等待中且无法关闭；同一毛病在 proc / task /
   wait_file / 函数工具的头上也在，这里一并收口）。
   opts.playFn / opts.stopFn：控制节点与判断节点不走 playUserNode / stopNode（它们各自有
   playControlNode / stopControlNode / playJudgeNode），传进来即可共用这只函数，
   不必为「有没有 ■」再抄一份。 */
function appendNodePlayBtns(head, node, title, opts) {
  const o = opts || {};
  const playFn = typeof o.playFn === "function" ? o.playFn : () => playUserNode(node);
  const stopFn = typeof o.stopFn === "function" ? o.stopFn : () => stopNode(node);
  const pending = isNodePending(node);
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "n-play" +
    (node.running ? " running" : pending ? " pending" : node.error ? " error" : "");
  b.textContent = node.running || pending ? "…" : "▶";
  b.title = pending ? I18n.t("排队等待中…") : I18n.t(title);
  b.onclick = (ev) => {
    ev.stopPropagation();
    playFn();
  };
  head.appendChild(b);
  if (!node.running && !pending) return;
  const stop = document.createElement("button");
  stop.type = "button";
  /* 样式与别处那颗 ■ 同源：.n-stop 本身就是红色方块（不加文字，免得把小方块撑变形） */
  stop.className = "n-play n-stop";
  stop.title = node.running
    ? I18n.t(o.stopTitle || "停止运行（立即中止）")
    : I18n.t("取消排队（这个任务还没起跑）");
  stop.onclick = (ev) => {
    ev.stopPropagation();
    stopFn();
  };
  head.appendChild(stop);
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
  /* 渲染口再兜一次归一：任何来源（status 探测形 / push 单帧 / 旧存档）都不会画出 0% 假读数 */
  const gpu = normalizeGpuReading(info.gpu);
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
        node.kind === "music_gen" || node.kind === "yue_gen"
          ? "Gradio"
          : node.kind === "moss_music"
            ? "MOSS"
            : "Comfy",
        info.apiUp ? "ok" : "bad",
      ),
    );
  /* FLUX 3 Image Klein：本机 ComfyUI，权重留不留显存由后端自己管，只补一条精度铭牌 */
  if (node.kind === "flux3klein_gen") {
    row.appendChild(pill(node.precision === "bf16" ? "BF16" : "INT8", "muted"));
  }
  /* Qwen Image 2.1：同为独立 ComfyUI，只补一条量化档铭牌（INT8 / Turbo INT8） */
  if (node.kind === "qwenimage_gen") {
    row.appendChild(pill(node.precision === "turbo" ? "Turbo INT8" : "INT8", "muted"));
  }
  /* MOSS-Music：只剩量化档（int8 / int4）—— 模型固定 Instruct，不再有可选项，
     与节点 body 里的量化档下拉同一份真源（node.quant） */
  if (node.kind === "moss_music") {
    row.appendChild(pill(String(node.quant || "int8").toUpperCase(), "muted"));
  }
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

  body.appendChild(panel);
}

/* 歌词端子（L）未接入 / 节点上留空时提交的纯器乐占位 —— 两个音乐节点的共用约定：
   Music 3（music_gen）与 YuE2（yue_gen）的后端都不认识空歌词，会直接报错
   （music3-pack/app/pipeline.py 与 yue-pack/app/engine.py 都会因空歌词拒单），
   而「纯器乐」在两边都写作 `[instrumental]`。 */
const MUSIC_GEN_INSTRUMENTAL = "[instrumental]";

function musicGenSlotText(node, slot) {
  const w = wiresTo(node.id).find((x) => Number(x.toIndex) === Number(slot));
  if (!w) return "";
  const src = nodeById(w.from);
  /* 端子号：app.js 的 valueFromWire 只对节点层 / 素材条目节点认线上的 fromIndex，其余节点
     拿 batchIdx 当端子号（这里传的就是 batchIdx）—— 直接传 0 会把「音频 / 视频输入节点
     端口 1（转写输出）」读成端口 0，拿回那串 file:/// URL 而不是转写文字，这正是用户报的
     「参考文本里显示路径、不显示参考文字」的根因（breezeTextSlot 因此在箱里回显路径）。
     音视频输入节点的两个端子语义是固定的（0 = 该文件本身 · 1 = 该文件的转写文字），
     按线上的端子号取；其它节点保持原口径（传 0）逐字不变。 */
  const srcIdx = src && isBreezeMediaSource(src) ? Number(w.fromIndex || 0) : 0;
  const v = valueFromWire(w, node, srcIdx);
  if (v && v.kind === "text") return String(v.text || "");
  const d = displayValueOf(src, node);
  if (d && d.text != null) return String(d.text);
  return "";
}


function syncMediaGenSeedFromDom(node) {
  if (!node || !node.id) return;
  /* 种子输入框现在只存在于「设置」跳窗里（body 上是只读摘要，读它没有意义）；
     窗没开 → node.seed 就是真源，不必回读。
     注意：readNodeSettingsCtl 在窗没开时回空串，Number("") === 0 且 isFinite(0) 为真，
     照旧写回 node.seed 会把种子抹成 0 —— 于是每次运行都从 0 +1 到 1，重跑永远同一颗种子
     （用户看到的「每次重新运行结果一样」）。空串 / 读不出数字一律不覆盖 node.seed。 */
  const raw = String(readNodeSettingsCtl(node, "mgseed") || "").trim();
  if (!raw) return;
  const v = Math.floor(Number(raw));
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
/* ═══════════ 生成类节点（music_gen / yue_gen / video_gen）的设置与摘要 ═══════════
 * 立规：设置一律在 ⚙ 跳窗里改，节点 body 只留「一行只读摘要 + 动作按钮」。
 *   nsMediaGenParamFields / nsMediaGenPathField → 跳窗里的可编辑控件（app-canvas.js
 *     的 NODE_SETTINGS_FORMS 登记表单调用它们，字段真源与老 body 面板完全一致）；
 *   appendMediaGenSummaryBody → body 上的一到两行只读摘要，值片段沿用老控件的 id
 *     （mgdur- / mgseed- / mgrolls- / mgpath-），运行期回填与跳窗控件
 *     由 app-canvas.js 的 syncNodeSettingsValue() 一起刷新，两边不会看到一个改一个不改。
 * 动作按钮（浏览 / 位置 / 打开）留在摘要行上：它们是动作，不是设置。
 */
function mediaGenDurValue(node) {
  if (node.kind === "music_gen") return Number(node.audioDuration) || 60;
  return node.duration != null ? Number(node.duration) : 5;
}
/* 抽卡 / 时长 / 种子 / 摇数（music_gen · video_gen 专用，别调别的 kind） */
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
      title: I18n.t("连续生成次数（1–10）；多次时输出命名为 #1、#2 …"),
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

/* 输出路径（媒体生成默认自己填落盘位置；**数据输出接到保存节点的可以留空** ——
   那时路径归保存节点 / 宿主管（managed）：产物先落应用托管目录，命名与落盘由保存节点负责。
   判定真源见 app.js 的 nodeFeedsSaveNode，导出解析见 resolveMediaGenExport 的 managed 分支）
   托管态下这一格整套文案换口径：placeholder「留空 = 交给下游保存节点落盘」、tooltip 说明归谁落盘、
   下面那句说明不再是「未设置输出路径时无法启动生成」（老口径只留给没接保存节点的情形）。
   设置窗与节点体摘要同源走这里 + mediaGenManagedHint，别在别处再写第二种说法。 */
function mediaGenPathManaged(node) {
  const exp = typeof resolveMediaGenExport === "function" ? resolveMediaGenExport(node) : null;
  if (exp && exp.managed) return true;
  /* 兜底：节点自己配过固定路径时 resolve 不算 managed（那时以节点为准），
     但没配路径 + 数据输出接了保存节点，就是托管态。 */
  const raw = String(mediaGenOutputRaw(node) || node.outputPath || "").trim();
  return !!(!raw && typeof nodeFeedsSaveNode === "function" && nodeFeedsSaveNode(node));
}
function nsMediaGenPathField(ctx, node, media) {
  const extHint = media === "image" ? "*.png" : media === "video" ? "*.mp4" : "*.wav";
  const hasWs = !!String(wfWorkspace() || "").trim();
  const empty = !String(mediaGenOutputRaw(node) || node.outputPath || "").trim();
  /* 托管态：路径可留空、产物由下游保存节点落盘（文案见上） */
  const managed = mediaGenPathManaged(node);
  nsText(
    ctx,
    I18n.t("输出路径"),
    mediaGenOutputRaw(node) || String(node.outputPath || ""),
    {
      id: nodeSettingsCtlId("mgpath", node.id),
      span: true,
      live: true,
      placeholder: managed
        ? I18n.t("留空 = 交给下游保存节点落盘（") + extHint + I18n.t("）…")
        : hasWs
          ? I18n.t("相对工作目录或绝对路径（") + extHint + I18n.t("）…")
          : I18n.t("输出路径（必须设置，") + extHint + I18n.t("）…"),
      title: managed
        ? I18n.t(
            "输出路径可留空：数据输出已接入保存节点，留空时产物先落应用托管目录，再由该保存节点按自己的保存路径落盘。也可以自己填一个固定路径（填了就以这里为准）。",
          )
        : I18n.t(
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
  if (managed) {
    /* 托管态：不再报「无法启动生成」（那正是本轮要消掉的老口径），改说明产物归谁 */
    if (empty) ctx.hint(I18n.t("留空 = 交给下游保存节点落盘…"));
  } else if (empty) ctx.hint(I18n.t("未设置输出路径时无法启动生成"));
}

/* 路径动作按钮：浏览（写路径）/ 位置（在文件夹中显示）/ 打开（系统默认应用） */
function mediaGenPathActionButtons(node, media) {
  /* 扩展名与 applyMediaGenConfiguredPath 同一真源（mediaGenExt），不再按 media 猜第二份 */
  const ext = mediaGenExt(node);
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
    const defaultName =
      safeFile(
        node.title ||
          (media === "video" ? "video" : media === "image" ? "image" : "music"),
      ) + ext;
    /* 默认文件名不代用户选目录：空路径时只管给个带正确后缀的默认名 */
    let defaultPath = defaultName;
    const cur = mediaGenOutputRaw(node) || String(node.outputPath || "").trim();
    if (cur) {
      const r0 = resolveSavePath(forcePathExt(cur, ext), node);
      defaultPath = r0.ok ? r0.path : cur;
    } else if (ws) {
      defaultPath = joinPath(ws, applySuperRelToPath(node, defaultPath));
    }
    const r = await window.api.fileSaveDialog({
      title:
        media === "image"
          ? I18n.t("选择图像保存位置")
          : media === "video"
            ? I18n.t("选择视频保存位置")
            : I18n.t("选择音频保存位置"),
      defaultPath,
      filters:
        media === "image"
          ? [
              { name: I18n.t("图像"), extensions: ["png"] },
              { name: I18n.t("全部文件"), extensions: ["*"] },
            ]
          : media === "video"
            ? [
                { name: I18n.t("视频"), extensions: ["mp4"] },
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
  } else if (mediaGenPathManaged(node)) {
    /* 托管态且还没有产物：「位置 / 打开」不出现（本节点确实没有可打开的文件），
       用一个禁用小标说明为什么，免得与摘要行的「托管目录 · 由保存节点落盘」看着矛盾
       （class 沿用 .mini：设置窗里它跟「浏览」并排，节点体摘要行里同型压一档高度） */
    const tag = document.createElement("button");
    tag.className = "mini";
    tag.disabled = true;
    tag.textContent = I18n.t("由保存节点落盘，本节点没有可打开的文件");
    tag.title = I18n.t("产物由下游保存节点落盘：路径填在该保存节点自己的保存路径上");
    btns.push(tag);
  }
  return btns;
}

/* body 摘要：一行参数 +（媒体类）一行输出路径（带动作按钮）。 */
function appendMediaGenSummaryBody(node, body, media) {
  const isCustomVid = node.kind === "video_gen" && isCustomVideoGen(node);
  const slots = [];
  if (isCustomVid) {
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
        /* 托管口径（输出接保存节点、节点自己没配路径）：别显示「（未设置）」 */
        mediaGenManagedHint(node) ||
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
  const isCustomVid = node.kind === "video_gen" && isCustomVideoGen(node);
  const parts = [];
  if (isCustomVid)
    parts.push(
      I18n.t("工作流") +
        " " +
        ((node.wfMeta && node.wfMeta.title) ||
          node.workflowId ||
          I18n.t("（未选择）")),
    );
  else parts.push(I18n.t("时长 ") + mediaGenDurValue(node) + "s");
  parts.push(I18n.t("抽卡 ") + attemptCount(node));
  parts.push(I18n.t("种子 ") + mediaGenSeedSlotText(node));
  parts.push(
    I18n.t("输出 ") +
      (mediaGenOutputRaw(node) ||
        String(node.outputPath || "").trim() ||
        mediaGenManagedHint(node) ||
        I18n.t("（未设置）")),
  );
  return parts.join(" · ");
}

/* ═══════════ Breeze 语音节点（breeze_gen）的设置与摘要 ═══════════
 * Breeze TTS 2 的参数（能力 / 指令 / cfg_scale / seed / 三种格式）走自己的一套摘要与字段；
 * 抽卡 / 输出路径仍复用媒体族的既有实现（控件 id 仍是 mgrolls- / mgpath-，运行期回填同一份口径）。 */
function breezeModeLabel(mode) {
  const m = String(mode || "auto");
  if (m === "clone") return I18n.t("音色克隆");
  if (m === "design") return I18n.t("音色设计");
  if (m === "direction") return I18n.t("音色导演");
  return I18n.t("自动判定");
}
/* body 上的只读摘要：角色（或能力 · 音色）· cfg · 种子 · 格式 */
function appendBreezeGenSummaryBody(node, body, media) {
  const presetId = breezePresetIdOf(node);
  const slots = presetId
    ? [
        { id: "breezevoice-" + node.id, label: I18n.t("角色"), value: breezePresetLabelOf(node) },
        { label: "cfg", value: breezeCfgSummaryOf(node) },
        { id: "mgseed-" + node.id, label: I18n.t("种子"), value: breezeSeedSlotText(node) },
        { label: I18n.t("格式"), value: breezeFormatOf(node) },
      ]
    : [
        { label: I18n.t("能力"), value: breezeModeLabel(breezeModeOf(node)) },
        {
          id: "breezevoice-" + node.id,
          label: I18n.t("音色"),
          value: String(node.voice || "").trim() || I18n.t("（只用端子）"),
        },
        { label: "cfg", value: breezeCfgSummaryOf(node) },
        { id: "mgseed-" + node.id, label: I18n.t("种子"), value: breezeSeedSlotText(node) },
        { label: I18n.t("格式"), value: breezeFormatOf(node) },
      ];
  appendNodeSettingsSummary(node, body, { slots, cls: "mg-sum" });
  appendNodeSettingsSummary(node, body, {
    slots: [
      {
        id: "mgpath-" + node.id,
        label: I18n.t("输出"),
        value:
          mediaGenOutputRaw(node) ||
          String(node.outputPath || "").trim() ||
          /* 托管口径（输出接保存节点、节点自己没配路径）：别显示「（未设置）」 */
          mediaGenManagedHint(node) ||
          I18n.t("（未设置）"),
      },
    ],
    gear: false,
    cls: "mg-sum mg-sum-path",
    actions: mediaGenPathActionButtons(node, media),
  });
  /* 选了角色但已经不可用（管理台删了 / 组没了 / 缺音频）：卡片上直接给红字，别等运行时才报 */
  if (presetId) {
    const warn = document.createElement("div");
    warn.className = "n-empty n-preset-warn";
    const paint = () => {
      const p = breezePresetProblemOf(node);
      warn.textContent = p ? "⚠ " + p : "";
      warn.title = p || "";
      warn.style.color = p ? "var(--danger, #e5534b)" : "";
      warn.style.display = p ? "" : "none";
    };
    paint();
    body.appendChild(warn);
    /* 预设清单是异步读宿主的：读到后只改这一行字，不重画整张卡 */
    if (!breezePresetCache.at) breezePresetsLoad().then(paint);
  }
  /* 两个文本框（输入文本 / 参考文本）：卡片 body 上直接编辑，与设置窗共用 breezeTextBoxesFor；
     端子有输入时自动切只读回显（端子优先），端子为空才归用户改 —— 本节点不做转录。 */
  appendBreezeTextBoxesBody(node, body);
}
/* 同一批字段的一行文本版（登记表单的 summary 用；与上面的片段口径一一对应） */
function breezeGenParamSummaryText(node) {
  const presetId = breezePresetIdOf(node);
  const head = presetId
    ? I18n.t("角色 ") + breezePresetLabelOf(node)
    : I18n.t("能力 ") +
      breezeModeLabel(breezeModeOf(node)) +
      " · " +
      I18n.t("音色 ") +
      (String(node.voice || "").trim() || I18n.t("（只用端子）"));
  return [
    head,
    "cfg " + breezeCfgSummaryOf(node),
    I18n.t("种子 ") + breezeSeedSlotText(node),
    breezeFormatOf(node),
    I18n.t("输出 ") +
      (mediaGenOutputRaw(node) ||
        String(node.outputPath || "").trim() ||
        mediaGenManagedHint(node) ||
        I18n.t("（未设置）")),
  ].join(" · ");
}

/* ═══════════ YuE2 音乐节点（yue_gen）的设置与摘要 ═══════════
 * 抽卡 / 种子 / 摇数 / 输出路径 / offload 全部复用 music_gen 那一套实现
 * （控件 id 也是 mgrolls- / mgseed- / mgpath-，运行期回填同一份口径）；
 * 另加「思维链档位」三挡下拉（full / melody / off）。时长由后端按歌词决定，
 * 所以没有「时长」字段。 */
function nsYueGenParamFields(ctx, node) {
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
      title: I18n.t("连续生成次数（1–10）；多次时输出命名为 #1、#2 …"),
    },
    (v) => {
      node.attempts = attemptCount({ attempts: v });
      syncNodeSettingsValue(node, "mgrolls", String(node.attempts));
    },
  );
  nsSelect(
    ctx,
    I18n.t("思维链档位"),
    [
      ["full", "full（完整思维链）"],
      ["melody", "melody（旋律引导）"],
      ["off", "off（关思维链）"],
    ],
    yueGenCotOf(node),
    (v) => {
      node.cot = v === "melody" || v === "off" ? v : "full";
    },
    { title: I18n.t("YuE2 的思维链（CoT）档位：full 质量最好、melody 更快、off 仅按提示词") },
  );
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

/* yue_gen 摘要的一行文本版（登记表单的 summary 用） */
function yueGenParamSummaryText(node) {
  return [
    I18n.t("思维链 ") + yueGenCotOf(node),
    I18n.t("抽卡 ") + attemptCount(node),
    I18n.t("种子 ") + mediaGenSeedSlotText(node),
    I18n.t("输出 ") +
      (mediaGenOutputRaw(node) ||
        String(node.outputPath || "").trim() ||
        mediaGenManagedHint(node) ||
        I18n.t("（未设置）")),
  ].join(" · ");
}

/* yue_gen 的 body 摘要：参数行 +（带动作按钮的）输出路径行 */
function appendYueGenSummaryBody(node, body) {
  appendNodeSettingsSummary(node, body, {
    slots: [
      { id: "mgrolls-" + node.id, label: I18n.t("抽卡"), value: String(attemptCount(node)) },
      { id: "mgseed-" + node.id, label: I18n.t("种子"), value: mediaGenSeedSlotText(node) },
      { label: I18n.t("思维链"), value: yueGenCotOf(node) },
    ],
    cls: "mg-sum",
  });
  appendNodeSettingsSummary(node, body, {
    slots: [
      {
        id: "mgpath-" + node.id,
        label: I18n.t("输出"),
        value:
          mediaGenOutputRaw(node) ||
          String(node.outputPath || "").trim() ||
          /* 托管口径（输出接保存节点、节点自己没配路径）：别显示「（未设置）」 */
          mediaGenManagedHint(node) ||
          I18n.t("（未设置）"),
      },
    ],
    gear: false,
    cls: "mg-sum mg-sum-path",
    actions: mediaGenPathActionButtons(node, "audio"),
  });
}

/* ═══════════════ H3 自建 ComfyUI 工作流（接入 video_gen 节点） ═══════════════
 * 分工真源：库读写 / UI→API 转换 / 参数扫描 / 参数校验 / 值注入全在主进程
 * h3/h3-workflows.js，渲染层只做四件事——选工作流、决定「哪些参数提升为节点端子」、
 * 面板直填值、挑输出节点；端子布局见 app.js 的 customWfInputCount / customWfSlotMeta
 * （数据端子 1 = 文本 · 2+ = 素材，按 wfParams 里的类型顺序排 → v5 起端口下标 = 端子号；
 *  端口 0 = 控制输入，固定在最前）。
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
/** 该参数实际占用的数据槽号（1 = 文本 · 2+ = 素材）；null = 超出端子数，只能面板直填。
    返回的是**数据槽号**（面板「端子 N」与后端参数表同一口径）；v5 起它与连线端口号同号
    （端口 0 是控制输入，不占数据槽）。 */
function h3WfPortOf(node, key) {
  const total = Math.max(1, videoGenDataSlotsTotal(node) || 1);
  for (let i = 1; i <= total; i++) {
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
  /* 数据端口 = 1..N（端口 0 = 控制输入，永远有效、不参与裁剪）；越界的数据线一律摘掉 */
  const wires = (S.wf && S.wf.wires) || [];
  const kept = wires.filter((w) => {
    if (w.to !== node.id) return true;
    if (wireFromIsControl(w)) return true;
    const idx = Number(w.toIndex);
    return !isFinite(idx) || videoGenIsDataPort(node, idx);
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
  /* 扩展名唯一真源 = mediaGenExt(node)：语音按所选输出格式（wav / mp3）、
       图像节点固定 .png、其余音频 .wav / 视频 .mp4。
     这里不再按调用方传的 media 猜第二份，否则同一节点两条链会给出不同后缀。 */
  void media;
  const ext = mediaGenExt(node);
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
  /* 托管口径（exp.managed：outputDir / filename 全空，路径归保存节点 / 宿主管）：
     这里没有任何可写的路径，绝不拿它去覆盖节点上的 outputPath 配置 ——
     否则下一次运行会从「托管」退回「已配路径」，把托管目录写死进节点。 */
  if (expOrPath && typeof expOrPath === "object" && expOrPath.managed) return;
  let abs = "";
  if (typeof expOrPath === "string") {
    abs = String(expOrPath || "").trim();
  } else if (expOrPath && expOrPath.ok) {
    abs = joinPath(expOrPath.outputDir, expOrPath.filename);
  }
  if (!abs) return;
  /* 后处理节点（超分 / 补帧）产物同样是 .mp4：媒体类型按视频算，不能落到音频分支 */
  const isVideo =
    node.kind === "video_gen" ||
    node.kind === "remotion" ||
    (typeof isVideoPostKind === "function" && isVideoPostKind(node));
  applyMediaGenConfiguredPath(node, abs, isVideo ? "video" : "audio");
}

/* 状态行后缀：本次走托管口径（节点没配输出路径、产物归下游保存节点）时标一句，
   免得用户看到一个没有输出路径的节点以为产物没地方去。 */
function mediaGenManagedTag(managed) {
  return managed ? " · " + I18n.t("托管目录 · 由保存节点落盘") : "";
}

function resolveMusicOutputDir(node) {
  const raw = String(node.outputPath || "output").trim() || "output";
  const r = resolveSavePath(raw, node);
  if (r.ok) return r.path;
  if (isAbsPath(raw)) return raw;
  return raw;
}

/* ── MOSS-Music 音乐理解（moss_music）：本机常驻后端（8790）──────────────
   输入 0=音频/视频路径 · 1=自由提问（留空用节点预设）· 2=控制输入；
   输出 0=结果文本 · 1=JSON 文本 · 2=md 产物路径（宿主托管目录，三件套 md/json/srt）。
   未就绪时由宿主自动拉起服务并装载模型；失败按错误码给中文指路（与插件卡片同一套码）。 */
const MOSS_MUSIC_TASKS = [
  {
    id: "full",
    label: "完整分析",
    prompt:
      "请完整分析这段音乐：逐句转写歌词并标注开始时间（mm:ss），说明曲风、情绪、配器、曲式结构、调式 / 速度 / 和弦进行，并指出关键时间点。",
  },
  {
    id: "describe",
    label: "整曲描述",
    prompt:
      "请完整描述这段音乐：风格、情绪、乐器、人声特点、曲式结构与段落变化，并给出关键时间点。",
  },
  {
    id: "lyrics",
    label: "时间戳歌词",
    prompt: "请逐句转写歌词，并为每一句标注开始时间（mm:ss），只输出时间戳歌词。",
  },
  {
    id: "structure",
    label: "曲式与和弦",
    prompt:
      "请分析这段音乐的曲式结构（前奏 / 主歌 / 副歌 / 桥段 / 尾奏）、调性、速度与和弦进行。",
  },
  {
    id: "mood",
    label: "情绪标签",
    prompt:
      "请给出这段音乐适合的场景与情绪标签（3~5 个，可用于检索），并简要说明每个标签的理由。",
  },
];
function mossMusicTaskOf(node) {
  const id = String((node && node.preset) || "full");
  return MOSS_MUSIC_TASKS.find((t) => t.id === id) || MOSS_MUSIC_TASKS[0];
}
/** 端口 1「自由提问」接线上的文本（端子优先）。没接线、线在但上游给空 → 空串，
    由调用方回落到框内文字 / 任务预设（用户口径：空端子不报错）。 */
function mossMusicSlotQuestion(node) {
  if (!node || !node.id) return "";
  try {
    return String(musicGenSlotText(node, 1) || "").trim();
  } catch (_) {
    return "";
  }
}
/** 本次真正发给模型的提问 + 来源：
    port = 端口 1 文本 · typed = 节点框内文字 · preset = 任务预设。
    （旧实现只读 node.question，端口 1 接了文本也没人读 → 一律发预设，用户报的
    「自由提问被预设覆盖」就是这个断点。真源只留这一处，body / 运行 / 摘要共用。） */
function mossMusicQuestionPlan(node) {
  const wired = mossMusicSlotQuestion(node);
  if (wired) return { question: wired, source: "port" };
  const typed = String((node && node.question) || "").trim();
  if (typed) return { question: typed, source: "typed" };
  return { question: I18n.t(mossMusicTaskOf(node).prompt), source: "preset" };
}
function mossMusicQuestionOf(node) {
  return mossMusicQuestionPlan(node).question;
}
/** 错误码 → 中文指路（节点状态行 / toast / 插件卡片共用同一批码与同一句口径） */
function mossMusicErrorText(code, message) {
  const c = String(code || "");
  const map = {
    not_installed:
      "MOSS-Music 尚未安装：请在「插件 · MOSS-Music」里选安装目录并安装（建议 ≥60GB 磁盘）",
    no_venv:
      "MOSS-Music 缺少 Python 环境：请在插件卡片点「补装要件 / 安装」补齐 venv 与依赖",
    pack_missing: "随包脚手架缺失：请重新安装 MTNode（moss-music-pack 未找到）",
    pack_copy_failed: "脚手架复制失败：检查安装目录权限与磁盘空间后重试安装",
    script_missing: "安装脚本缺失：请重新安装 MTNode 后再装插件",
    ui_missing: "控制台页面缺失：请重新安装 MTNode 后再装插件",
    stale_python: "本机 Python 不可用：请在插件卡片重装（会重建独立 venv）",
    low_disk: "磁盘空间不足：MOSS-Music 建议预留 ≥60GB，请清理后重试",
    empty_dir: "没有选择安装目录：请在插件卡片点「选择目录」",
    refuse_root: "安装目录不能是盘符根目录：请选一个子目录（如 D:\\MOSS-Music）",
    refuse_system: "安装目录不能是系统目录：请换一个普通数据目录",
    refuse_app_dir: "安装目录不能是 MTNode 应用目录：请换到应用文件夹之外",
    bad_model: "模型档位不合法：只支持 instruct（thinking 档已移除），请在节点里重选",
    bad_quant: "量化档位不合法：只能是 int8 或 int4，请在节点里重选",
    vram_low: "显存不足：int8 需 ≥16GB、int4 需 ≥12GB —— 请在控制台或节点里切低量化档",
    backend_spawn_failed: "后端进程起不来：请打开「控制台」看日志尾部（端口 8790）",
    backend_exited: "后端进程已退出：请打开「控制台」看日志尾部，必要时点「启用」重启",
    backend_start_failed: "后端启动失败：请打开「控制台」看日志尾部，或点「启用」重启",
    backend_start_timeout: "等待后端就绪超时：请打开「控制台」看日志，或点「启用」重启",
    load_failed: "模型装载失败：请换低量化档（int8 / int4），或打开控制台看日志",
    load_timeout: "模型装载超时：请换低量化档（int8 / int4）后重试",
    busy: "后端正忙：等当前任务结束再试",
    busy_other_node:
      "本机正在跑另一个音视频任务（全局仅 1 个）：等它结束再试，或先在那边点停止",
    missing_node_id: "节点缺少 id：请复制一个新节点再运行",
    audio_missing: "没有音频 / 视频路径：请把音频或视频接到端子 0（音频 / 视频）",
    deliverable_missing: "产物缺失：后端没有写出 md / json / srt，请打开控制台看日志",
    generate_timeout:
      "分析超时：音频过长或显存不足 —— 请勾选「长音频」分块、切低量化档（int8 / int4），或缩短音频",
    same_dir: "安装目录与当前目录相同：如需重装请直接点「重装」",
    generate_failed: "分析失败：请打开「控制台」看日志尾部（端口 8790）",
  };
  if (map[c]) return "[" + c + "] " + I18n.t(map[c]);
  const detail = String(message || "").trim();
  if (detail) return "[" + (c || "generate_failed") + "] " + I18n.t("MOSS-Music 分析失败：") + detail;
  return (
    I18n.t("MOSS-Music 分析失败（") +
    (c || I18n.t("未知错误")) +
    I18n.t("）：请打开「控制台」看日志尾部")
  );
}
/** 端子 0 的媒体路径：结构化音频 / 视频值、裸路径、file:/// URL 都归一成本机路径 */
function mossMusicMediaPathOfValue(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return "";
    if (s.toLowerCase().indexOf("file://") === 0) {
      try {
        return String((typeof pathFromMediaUrl === "function" && pathFromMediaUrl(s)) || "");
      } catch (_) {
        return "";
      }
    }
    return s;
  }
  const raw = String(v.path || "").trim();
  if (raw) {
    const p = mossMusicMediaPathOfValue(raw);
    if (p) return p;
  }
  for (const t of [v.url, v.text]) {
    const p = mossMusicMediaPathOfValue(t);
    if (p) return p;
  }
  return "";
}
function mossMusicMediaPathOf(node) {
  if (!node) return "";
  const w = wiresTo(node.id).find((x) => Number(x.toIndex) === 0);
  if (!w) return "";
  const src = nodeById(w.from);
  let v = null;
  try {
    v = valueFromWire(w, node, Number(w.fromIndex) || 0);
  } catch (_) {
    v = null;
  }
  if (!v && src) {
    try {
      v = displayValueOf(src, node);
    } catch (_) {
      v = null;
    }
  }
  return mossMusicMediaPathOfValue(v);
}
function mossMusicResultTextOf(node) {
  const o = node && node.output;
  return o && o.kind === "text" ? String(o.text || "") : "";
}
/** 节点 body：预设 / 自由提问 / 长音频开关 / 模型与量化 + 后端面板 + 结果预览 + 状态行 */
function mossMusicAppendNodeBody(node, body) {
  if (!node || !body) return;
  if (
    typeof appPluginMissing === "function"
      ? appPluginMissing("moss-music")
      : !appPluginInstalled("moss-music")
  ) {
    const warn = document.createElement("div");
    warn.className = "n-backend-hint n-plugin-warn";
    warn.textContent = I18n.t(
      "⚠ MOSS-Music 插件未安装：请在「插件 · MOSS-Music」中安装后使用本节点",
    );
    warn.title = I18n.t("插件 · MOSS-Music 本地音乐理解：设置安装目录 → 安装（建议 ≥60GB）");
    body.appendChild(warn);
  }
  /* 预设 / 量化档 / 长音频都在 ⚙ 设置窗里改（body 只留一行只读摘要；模型固定 Instruct，没有可选项） */
  if (typeof appendNodeSettingsSummary === "function") appendNodeSettingsSummary(node, body);
  const qField = document.createElement("label");
  qField.className = "n-field";
  /* 端口 1 有文本 → 框只读回显那一份（端子优先，且不改写 node.question：
     用户自己填的字要留着，拔线后还能用）。 */
  const wiredQuestion = mossMusicSlotQuestion(node);
  qField.textContent = wiredQuestion
    ? I18n.t("自由提问（端口 1 有输入：这里只读回显）")
    : I18n.t("自由提问（留空用 ⚙ 里的任务预设）");
  const ta = document.createElement("textarea");
  ta.className = "n-text";
  ta.style.minHeight = "42px";
  ta.style.maxHeight = "72px";
  ta.placeholder = I18n.t("例如：副歌的和弦进行是什么？这段适合什么场景？");
  ta.value = wiredQuestion || String(node.question || "");
  ta.readOnly = !!wiredQuestion;
  if (wiredQuestion) {
    ta.title = I18n.t("本次提问取端口 1 的文本（预设与框内文字都不作数）；要改请改上游文本");
  }
  ta.addEventListener("input", () => {
    if (ta.readOnly) return;
    node.question = ta.value;
    scheduleSave();
  });
  qField.appendChild(ta);
  body.appendChild(qField);
  if (typeof appendMediaBackendPanel === "function") appendMediaBackendPanel(body, node);
  const out = mossMusicResultTextOf(node);
  if (out) {
    const prev = document.createElement("div");
    prev.className = "n-text";
    prev.style.maxHeight = "120px";
    prev.style.overflow = "auto";
    prev.style.whiteSpace = "pre-wrap";
    prev.style.cursor = "auto";
    prev.textContent = out.length > 600 ? out.slice(0, 600) + "…" : out;
    prev.title = I18n.t("完整结果见 JSON / 产物路径端子，或打开 md 文件");
    body.appendChild(prev);
    /* 节点里只放前 600 字（省重排）；不写这一行，用户会以为后端把结果截断了 */
    if (out.length > 600) {
      const more = document.createElement("div");
      more.className = "n-backend-hint";
      more.textContent = I18n.t(
        "节点内只显示前 600 字；完整结果走「结果文本 / JSON / md 路径」端口或 md 文件（未截断）",
      );
      body.appendChild(more);
    }
  }
  const st = document.createElement("div");
  st.className =
    "n-status" +
    (node.running ? " run" : node.error ? " err" : node.ranAt ? " done" : "");
  const idleHint =
    mossMusicQuestionPlan(node).source === "preset"
      ? I18n.t("接入音频 / 视频 → 选任务预设 → ▶ 分析（未就绪会自动拉起后端并装载模型）")
      : I18n.t("自由提问（预设已忽略） · 接入音频 / 视频 → ▶ 分析");
  st.textContent = node.error || node.mossStatus || idleHint;
  body.appendChild(st);
}

async function playMossMusicNode(node, quiet) {
  if (!window.api || !window.api.mossmusicGenerate) {
    toast(I18n.t("MOSS-Music 插件未就绪"), "err");
    return;
  }
  /* 串行链出队后由 mediaRunPrestart 先点亮了运行态（显存预释放那段也算本次运行）：
     那一下是本运行体的交接，不是「已经在跑」，必须放行 */
  if (node.running && !node._prestart) return;
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }
  /* 全局互斥：音视频生成全局仅允许 1 个（MOSS 也占同一把锁） */
  try {
    const lock = await fetchMediaGenLock();
    if (lock && lock.nodeId && lock.nodeId !== node.id) {
      node.error = mediaGenLockBusyMsg(lock);
      node._busyErrAt = Date.now();
      node.mossStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch {}
  const audioPath = mossMusicMediaPathOf(node);
  if (!audioPath) {
    node.error = mossMusicErrorText("audio_missing");
    node.mossStatus = node.error;
    if (!quiet) toast(node.error, "warn");
    renderCanvas();
    return;
  }
  /* 提问取值顺序：端口 1 文本 > 框内文字 > 任务预设（单一真源 mossMusicQuestionPlan） */
  const qPlan = mossMusicQuestionPlan(node);
  const question = qPlan.question;
  const qTag = qPlan.source === "preset" ? "" : I18n.t("自由提问（预设已忽略）") + " · ";
  const longAudio = node.longAudio === true;
  /* 模型只剩 Instruct：老画布节点里的 thinking 一律按 instruct 发，后端也会再归一化一次 */
  const model = "instruct";
  const quant = ["int8", "int4"].includes(node.quant) ? node.quant : "int8";

  let st = null;
  try {
    st = await window.api.mossmusicStatus();
  } catch {}
  if (st && st.installed === false) {
    node.error = mossMusicErrorText("not_installed");
    node.mossStatus = node.error;
    if (!quiet) toast(node.error, "warn");
    renderCanvas();
    return;
  }
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }
  node.running = true;
  node.error = null;
  node.mossStatus =
    qTag +
    (st && st.ready
      ? I18n.t("分析中…（长音频分块会更久）")
      : I18n.t("正在拉起后端并装载模型（首次约 30~60 秒）…"));
  beginNodeRun(node);
  {
    const ui = ensureBackendUiState(node);
    ui.ok = st && st.ready ? true : null;
    ui.info = summarizeMediaBackendStatus(node, st);
    ui.genPct = 3;
    ui.genMsg = node.mossStatus;
    stopMediaBackendProbe(node.id);
  }
  startMediaBackendRunWatcher(node);
  renderCanvas();
  const t0 = Date.now();
  try {
    const r = await window.api.mossmusicGenerate({
      nodeId: node.id,
      workflowId: (S.wf && S.wf.id) || "",
      audioPath,
      question,
      longAudio,
      model,
      quant,
      maxNewTokens: [2048, 4096, 8192].includes(node.maxNewTokens) ? node.maxNewTokens : 4096,
    });
    if (node._aborted || (r && (r.error === "cancelled" || r.cancelled))) {
      node.error = null;
      node.mossStatus = I18n.t("已终止（显存已释放）");
      const ui = ensureBackendUiState(node);
      ui.genMsg = node.mossStatus;
      ui.genPct = 0;
      return;
    }
    if (!r || !r.ok) {
      const code = String((r && r.error) || "generate_failed");
      node.error = mossMusicErrorText(code, r && r.message);
      node.mossStatus = node.error;
      node._busyErrAt = code === "busy_other_node" || code === "busy" ? Date.now() : 0;
      if (looksLikeBackendConnError(code) || code === "backend_exited") markMediaBackendDown(node);
      if (!quiet) toast(node.error, "err");
      const ui = ensureBackendUiState(node);
      ui.genMsg = node.error;
      ui.genPct = 0;
      return;
    }
    const text = String(r.text || "");
    const files = r.files && typeof r.files === "object" ? r.files : {};
    const json = JSON.stringify(
      {
        ok: true,
        text,
        files,
        cues: Array.isArray(r.cues) ? r.cues : [],
        chunks: r.chunks == null ? null : r.chunks,
        durationSeconds: r.durationSeconds == null ? null : r.durationSeconds,
        model: r.model || model,
        quant: r.quant || quant,
        audioPath,
        question,
        questionSource: qPlan.source,
        longAudio,
        at: new Date().toISOString(),
      },
      null,
      2,
    );
    node.output = {
      kind: "text",
      text,
      json,
      files,
      path: String(files.md || files.json || files.srt || ""),
      cues: Array.isArray(r.cues) ? r.cues : [],
    };
    node.ranAt = Date.now();
    const doneMsg = mediaGenDoneMsg(Date.now() - t0);
    node.mossStatus =
      qTag +
      doneMsg +
      (r.autoSplit ? I18n.t(" · 已自动分块补齐") : "") +
      (r.truncated ? I18n.t(" · ⚠ 输出可能不完整（已达上限）") : "") +
      (files.md ? I18n.t(" · 产物：") + String(files.md) : "");
    if (r.truncated && !quiet)
      toast(I18n.t("输出达到 token 上限，结果可能不完整；可把「单段输出上限」调到 8192 重跑"), "warn");
    {
      const ui = ensureBackendUiState(node);
      ui.genPct = 100;
      ui.genMsg = node.mossStatus;
      ui.ok = true;
    }
    if (!quiet) {
      const head = text ? text.split("\n").filter(Boolean)[0] || "" : "";
      toast(
        I18n.t("音乐理解完成：") + (head.length > 60 ? head.slice(0, 60) + "…" : head || I18n.t("已生成结果")),
        "ok",
      );
    }
  } catch (e) {
    if (node._aborted) {
      node.error = null;
      node.mossStatus = I18n.t("已终止（显存已释放）");
    } else {
      node.error = mossMusicErrorText("generate_failed", (e && e.message) || String(e));
      node.mossStatus = node.error;
      if (looksLikeBackendConnError(node.error)) markMediaBackendDown(node);
      if (!quiet) toast(node.error, "err");
    }
  } finally {
    node.running = false;
    node._aborted = false;
    stopMediaBackendRunWatcher(node.id);
    renderCanvas();
    scheduleSave();
  }
}

async function playMusicGenNode(node, quiet) {
  if (!window.api || !window.api.music3Generate) {
    toast(I18n.t("音乐生成插件未就绪"), "err");
    return;
  }
  /* 串行链出队后由 mediaRunPrestart 先点亮了运行态（显存预释放那段也算本次运行）：
     那一下是本运行体的交接，不是「已经在跑」，必须放行 */
  if (node.running && !node._prestart) return;
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
      node._busyErrAt = Date.now(); /* 见 app.js sweepStaleMediaBusyErrors：新报的别当场扫掉 */
      node.musicStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch {}

  const prompt = musicGenSlotText(node, 0).trim();
  /* 歌词端子（L）可以不接：未接入按纯器乐提交 —— Music 3 的器乐约定就是 [instrumental]，
     不接歌词不再拦下运行，也就与「设置里留空 = 纯器乐」的文档口径一致。 */
  const lyrics = musicGenSlotText(node, 1).trim() || MUSIC_GEN_INSTRUMENTAL;
  if (!prompt) {
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
  /* 本次是否走托管口径（没配输出路径、输出接保存节点）：托管时不下发 outputDir / filename，
     命名与落盘由宿主兜底，回执里的绝对路径只写进 node.output。 */
  let managedRun = false;

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
      if (exp.managed) managedRun = true;
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
        /* 托管：不下发 outputDir / filename → 宿主写进托管目录并回传绝对路径 */
        ...(exp.managed ? {} : { outputDir: exp.outputDir, filename: exp.filename }),
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
          node._busyErrAt = Date.now();
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
      /* 托管：宿主回传的绝对路径只进 node.output（下游保存节点取它落盘），
         绝不写回节点自己的 outputPath 配置 —— 一写就退回「已配路径」口径。 */
      if (lastPath && nRolls === 1 && !exp.managed) syncMediaGenPathFromExport(node, lastPath);
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
    const doneMsg = mediaGenDoneMsg(Date.now() - t0) + mediaGenManagedTag(managedRun);
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

/* ── YuE2 音乐生成（yue_gen）：接入本机 YuE2 插件（yue2-local）─────────────
   后端 = 插件「YuE2 本地音乐」：主进程 yue/main-yue.js 拉起本地服务，节点经
   api.yue2Generate → yue:generate → 后端产出音频并回传绝对路径。
   与 music_gen 共用同一条渲染层串行链、同一套后端状态机与**同一个主进程全局
   音视频大锁**（kind='yue_gen'）—— 音视频全局仅允许 1 个任务。
   端子：0=风格提示词 · 1=歌词 · 2=ABC 谱（可选）· 3=控制输入；未接线时回落到
   节点上直接填写的 style / lyrics / abc（本地后端的特点是可以手写谱面）。 */
function yueGenSlotText(node, slot) {
  return musicGenSlotText(node, slot);
}
/* ABC 谱（可选）：端口 2 有连线取上游，否则用节点字段 */
function yueGenAbcText(node) {
  const wired = yueGenSlotText(node, 2).trim();
  return wired || String(node.abc || "").trim();
}
function yueGenCotOf(node) {
  const v = String(node.cot || "").trim();
  return v === "melody" || v === "off" ? v : "full";
}
function yueGenCotLabel(v) {
  return v === "melody"
    ? I18n.t("melody（旋律引导）")
    : v === "off"
      ? I18n.t("off（关思维链）")
      : I18n.t("full（完整思维链）");
}

async function playYueGenNode(node, quiet) {
  if (!window.api || !window.api.yue2Generate) {
    toast(I18n.t("YuE2 音乐插件未就绪"), "err");
    return;
  }
  /* 串行链出队后由 mediaRunPrestart 先点亮了运行态（显存预释放那段也算本次运行）：
     那一下是本运行体的交接，不是「已经在跑」，必须放行 */
  if (node.running && !node._prestart) return;
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
      node._busyErrAt = Date.now(); /* 见 app.js sweepStaleMediaBusyErrors：新报的别当场扫掉 */
      node.yueStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch {}

  const prompt = (yueGenSlotText(node, 0).trim() || String(node.style || "").trim());
  /* 歌词可以不接、也可以不在节点上填：未给歌词时按纯器乐提交 —— YuE2 的器乐约定同 Music 3
     （`[instrumental]`），后端不再因空歌词拒单，与「歌词端子可选」的端子文案口径一致。
     （本轮 bug：用户报「YuE2 音乐节点必须要歌词，没歌词直接拦下运行」） */
  const lyrics = yueGenSlotText(node, 1).trim() || String(node.lyrics || "").trim() || MUSIC_GEN_INSTRUMENTAL;
  const abc = yueGenAbcText(node);
  if (!prompt) {
    toast(I18n.t("请连接风格提示词输入（端子 P），或直接在节点上填写风格提示词"), "warn");
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
    if (window.api.yue2Status) st = await window.api.yue2Status();
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
  node.yueStatus = I18n.t("启动后端并生成…");
  startMediaBackendRunWatcher(node);
  renderCanvas();

  const cot = yueGenCotOf(node);
  const t0 = Date.now();
  let okCount = 0;
  let lastPath = "";
  let managedRun = false;

  try {
    for (let roll = 1; roll <= nRolls; roll++) {
      if (mediaRunStopped(node)) break;
      const exp = await prepareMediaGenRollExport(node, roll, nRolls);
      if (!exp || !exp.ok) {
        requireMediaGenExport(node, quiet);
        node.error = savePathResolveError(exp && exp.code);
        node.yueStatus = node.error;
        if (!quiet) toast(node.error, "warn");
        return;
      }
      if (roll === 1 && nRolls === 1 && exp.renamed) {
        syncMediaGenPathFromExport(node, exp);
        if (!quiet) toast(I18n.t("目标文件已存在，改为保存为：") + exp.filename, "ok");
      }
      if (exp.managed) managedRun = true;
      const seed = nextMediaGenSeed(node);
      {
        const ui = ensureBackendUiState(node);
        ui.genPct = Math.max(2, ui.genPct || 2);
        ui.genMsg =
          mediaGenRollProgressTag(node) +
          (nRolls > 1 ? I18n.t("生成中…") : I18n.t("启动后端并生成…"));
        node.yueStatus = ui.genMsg;
      }
      node.genRollDone = roll - 1;
      refreshMediaNodeUi(node, { soft: true });

      const r = await window.api.yue2Generate({
        nodeId: node.id,
        workflowId: (S.wf && S.wf.id) || "",
        prompt,
        lyrics,
        abc,
        cot,
        seed,
        /* 托管：不下发 outputDir / filename → 宿主写进托管目录并回传绝对路径 */
        ...(exp.managed ? {} : { outputDir: exp.outputDir, filename: exp.filename }),
        offload: node.offload !== false,
      });
      if (node._aborted || (r && (r.error === "cancelled" || r.cancelled))) {
        node.error = null;
        node.yueStatus = I18n.t("已取消");
        const ui = ensureBackendUiState(node);
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        return;
      }
      if (!r || !r.ok) {
        const err = (r && (r.message || r.error)) || I18n.t("生成失败");
        if (err === "busy_other_node" || (r && r.error === "busy_other_node")) {
          node.error = I18n.t("已有音视频生成任务进行中，已中断本节点（全局仅 1 个，禁止并行）");
          node._busyErrAt = Date.now();
        } else if (String(err) === "cancelled") {
          node.error = null;
          node.yueStatus = I18n.t("已取消");
          return;
        } else {
          node.error = String(err);
        }
        node.yueStatus = node.error;
        if (looksLikeBackendConnError(err)) markMediaBackendDown(node);
        if (!quiet) toast(node.error, "err");
        return;
      }
      okCount++;
      lastPath = String(r.path || "");
      if (lastPath) node.genPaths.push(lastPath);
      node.output = { kind: "audio", path: lastPath, text: lastPath };
      node.ranAt = Date.now();
      /* 托管：宿主回传的绝对路径只进 node.output（下游保存节点取它落盘），
         绝不写回节点自己的 outputPath 配置 —— 一写就退回「已配路径」口径。 */
      if (lastPath && nRolls === 1 && !exp.managed) syncMediaGenPathFromExport(node, lastPath);
      node.genRollDone = roll;
    }
    if (node._aborted) {
      node.error = null;
      node.yueStatus = I18n.t("已取消");
      const ui = ensureBackendUiState(node);
      ui.genMsg = I18n.t("已取消");
      ui.genPct = 0;
      return;
    }
    if (!okCount) return;
    const doneMsg = mediaGenDoneMsg(Date.now() - t0) + mediaGenManagedTag(managedRun);
    node.yueStatus = doneMsg;
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
      node.yueStatus = I18n.t("已取消");
    } else {
      node.error = (e && e.message) || String(e);
      node.yueStatus = node.error;
      if (looksLikeBackendConnError(node.error)) markMediaBackendDown(node);
      if (!quiet) toast(node.error, "err");
    }
  } finally {
    /* 被用户终止（单独停止 / 全部终止）时不再驱动下游控制线 */
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


/* ── Breeze 语音生成（breeze_gen）：接入本机 Breeze TTS 2 插件 ─────────────
   后端 = 插件「Breeze TTS 2 本地 TTS」(breeze-tts-local)：主进程 breeze/main-breeze.js 拉起
   Python 管理服务（127.0.0.1:8772），后者再按需拉起官方 breeze_infer.api 推理引擎（:8773）。
   节点经 api.breezeGenerate → breeze:generate → /v1/audio/speech，音频字节由主进程直接写盘
   并回传绝对路径（渲染层不碰二进制）。

   端子：输入 0=文本 · 1=参考音频 · 2=参考文稿 · 3=指令 · 4=控制入；输出 0=音频 · 1=控制出。
   参考源优先级（用户已确认）：**端子优先**，端子空了才用节点设置里选的音色（后端音色库
   voices/<id>/{ref.wav,ref.txt}）；本次实际用了哪个源写在状态行上，不默默生效。
   能力语义（官方口径）：有参考音频且无 instruction = 音色克隆；有 instruction = 音色导演；
   无参考音频 = 音色设计。
    Breeze 引擎 eager 就要约 7.7GB 显存，所以**持全局音视频互斥锁**（与音乐 / 视频抢同一张卡），
    不是「显存另算」的独立进程。 */
const BREEZE_API_POLL_MS = 2000;
const BREEZE_API_WAIT_MS = 180000;

/* 能力档（与后端 prepare_request 的 mode 口径一致） */
function breezeModeOf(node) {
  const v = String((node && node.voiceMode) || "auto").trim();
  return ["auto", "clone", "design", "direction"].indexOf(v) >= 0 ? v : "auto";
}
function breezeFormatOf(node) {
  const v = String((node && node.ttsFormat) || "wav").toLowerCase();
  return ["wav", "flac", "mp3"].indexOf(v) >= 0 ? v : "wav";
}
function breezeCfgScaleOf(node) {
  const v = Number(node && node.cfgScale);
  return isFinite(v) && v > 0 ? Math.max(0.1, Math.min(10, v)) : 4;
}
/* 引擎模板的能力差异（这条是踩过的坑）：有参考音频且没有导演指令时走 ref_clone_tata，
   那个模板没有负向提示词，引擎对 cfg_scale≠1.0 直接 raise ValueError → 裸 HTTP 500。
   所以「克隆」这条路的 CFG 恒为 1.0：判定只写在这一处，运行期与摘要共用（与后端
   prepare_request 里的钳制同口径，后端再兜一层）。 */
function breezeModeResolvedOf(node, opts) {
  const m = breezeModeOf(node);
  if (m !== "auto") return m;
  const o = opts || {};
  if (!o.hasRef) return "design";
  return String(o.instruction || "").trim() ? "direction" : "clone";
}
function breezeCfgLockedOf(node, opts) {
  return breezeModeResolvedOf(node, opts) === "clone";
}
/* 真正下发给引擎的 cfg：克隆模式强制 1.0，其余照字段值 */
function breezeCfgScaleForRun(node, opts) {
  return breezeCfgLockedOf(node, opts) ? 1 : breezeCfgScaleOf(node);
}
/* 摘要口径的「有没有参考音频 / 有没有指令」（端子优先，与运行期 breezeResolveRef 同源；
   取不到环境就当没有 —— 摘要只用来提示，绝不影响下发值）。 */
function breezeRefHintOf(node) {
  let hasRef = !!String((node && node.voice) || "").trim();
  let instruction = String((node && node.instruction) || "").trim();
  try {
    if (!hasRef) hasRef = !!(breezeAudioSlotPath(node, 1) || breezeAudioSlotPath(node, 2));
  } catch (_) {}
  try {
    const slotInstr = breezeTextSlot(node, 3);
    if (slotInstr) instruction = slotInstr;
  } catch (_) {}
  return { hasRef, instruction };
}
/* 摘要行上的 cfg：克隆模式显示「1（克隆固定）」，让用户看得见自己填的值没被下发 */
function breezeCfgSummaryOf(node) {
  const locked =
    breezeCfgLockedOf(node, breezeRefHintOf(node)) || !!(node && node.cfgClamped);
  return (locked ? "1" : String(breezeCfgScaleOf(node))) + (locked ? I18n.t("（克隆固定）") : "");
}
function breezeSeedOf(node) {
  const v = Math.floor(Number(node && node.seed));
  return isFinite(v) ? v : 1;
}
/* 摘要里的种子片段：与其它媒体节点同口径（开着摇数时标出 +1，免得看到种子在变以为没生效） */
function breezeSeedSlotText(node) {
  return String(breezeSeedOf(node)) + (node.rerollSeed !== false ? " +1" : "");
}

/* ── 音频 / 视频输入节点的端子判据（本文件与 app.js 的 valueForInput 同口径） ── */
function isBreezeMediaSource(node) {
  return !!(
    node &&
    (node.kind === "input_audio" || node.kind === "input_video")
  );
}
/* 音频扩展名与 file:// 前缀：**不用正则字面量**（本文件这几只函数会被冒烟按字符级抠进
   沙箱，正则里的 // 会被当成行注释，把函数体切坏 —— test/smoke-breeze.js 的 skipJsLiteral）。 */
const BREEZE_AUDIO_EXTS = [".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus"];
/* 视频扩展名：只给 breezeIsMediaFilePath 判「这段字符串是媒体路径、不是文字」用
   （与 app.js 判视频后缀那一处同口径），不参与参考音频的识别。 */
const BREEZE_VIDEO_EXTS = [".mp4", ".webm", ".mov"];
function breezeHasExt(path, exts) {
  const s = String(path || "").toLowerCase();
  return exts.some((e) => s.endsWith(e));
}
function breezeHasAudioExt(path) {
  return breezeHasExt(path, BREEZE_AUDIO_EXTS);
}
function breezeHasVideoExt(path) {
  return breezeHasExt(path, BREEZE_VIDEO_EXTS);
}
function breezeIsFileUrl(v) {
  return String(v || "").toLowerCase().indexOf("file://") === 0;
}
/* 本机音频路径归一：端子值 / 显示值给的可能就是本机路径，也可能是**百分号编码的
   file:/// URL**（音频 / 视频输入节点端口 0 的对外口径就是那条 URL）—— 后者必须解码回
   本机路径再交给后端（后端 Path() 认不得 file:///…%E5%8E%9F…，会报
   ref_audio_missing「参考音频文件不存在：file:///…」）。不是音频文件就回空串。 */
function breezeAudioPathOfValue(v) {
  if (!v) return "";
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return "";
    if (!breezeIsFileUrl(s)) return breezeHasAudioExt(s) ? s : "";
    let p = "";
    try {
      p = typeof pathFromMediaUrl === "function" ? String(pathFromMediaUrl(s) || "") : "";
    } catch (_) {
      p = "";
    }
    return breezeHasAudioExt(p) ? p : "";
  }
  const raw = String(v.path || "").trim();
  if (raw && (breezeHasAudioExt(raw) || breezeIsFileUrl(raw))) {
    const p = breezeAudioPathOfValue(raw);
    if (p) return p;
  }
  /* url / text 都可能是那条 file:/// URL */
  const tails = [v.url, v.text];
  for (const t of tails) {
    const s = String(t || "").trim();
    if (!s) continue;
    const p = breezeAudioPathOfValue(s);
    if (p) return p;
  }
  return "";
}
/* 一段字符串像不像「媒体文件路径」（本机路径或 file:/// URL，扩展名认音频 / 视频）：
   参考文本那两个框只认**文字**，这类字符串一律不当文字显示（见 breezeTextSlot）。 */
function breezeIsMediaFilePath(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  if (breezeIsFileUrl(s)) return true;
  return breezeHasAudioExt(s) || breezeHasVideoExt(s);
}
/* 端子值是不是「媒体值」（音频 / 视频本身），而不是文字：
   ① 结构化值 kind = audio / video，或 path / url / text 落在媒体文件上
     （save / 生成器 / 音频输入节点 / 素材音频条目给的**裸路径**都长这样，
      而 breezeIsFileUrl 只挡得住 file:/// 那一种 —— 音频节点的显示值 / 输入节点的
      继承链会给纯本机路径，这正是「参考文本里还显示着路径」的漏口）；
   ② 裸字符串形态的媒体路径（function / tool / 用户插件节点把路径当纯文本给出）。
   文字槽（端口 0 / 2 / 3）要的是文字：命中这里 = 本槽没有文字，绝不回显、绝不使用。 */
function breezeIsMediaValue(v) {
  if (v == null) return false;
  if (typeof v === "string") return breezeIsMediaFilePath(v);
  const kind = String(v.kind || "").toLowerCase();
  if (kind === "audio" || kind === "video") return true;
  for (const f of [v.path, v.url, v.text]) {
    const s = String(f || "").trim();
    if (s && breezeIsMediaFilePath(s)) return true;
  }
  return false;
}
/* 端子取文本：槽 0 文本 / 2 参考文稿 / 3 指令（复用 musicGenSlotText 的取数口径）。
   文本槽上的**媒体值一律不算文字**，不管它从哪来：
   · 音频 / 视频输入节点端口 0 给的是该文件的 file:/// URL（app.js 的 displayValueOf
     对音视频输入的口径），端口 1 = 转写输出才是文字 —— 只认端口 1；
   · 保存节点（音频 / 视频）、breeze_gen / music_gen / video_gen、素材的音频条目、
     函数或工具节点给出的裸本机路径（`E:\…\ref.wav`）同样不是文字。
   命中就回空串：文本框显示「空」，而该路音频由 breezeAudioSlotPath 归一回本机路径，
   在参考源里当参考音频 —— 与「参考文本必须与参考音频成对」的本地拦停口径一致。

   ⚠ 绝不在这里给「音频 / 视频输入节点端口 1」另开一条早退分支（曾经有，且正是用户报的
   「参考文本里显示 file:///…mp3」的根因）：那条支路在闸门**前面** return，而它取到的
   musicGenSlotText 会因为端子号丢失（见 musicGenSlotText 的 srcIdx 注释）拿回端口 0 的
   那串 file:/// URL —— 于是闸门被绕过、路径直接当参考文字显示。这里只认两件事：
   端口 0 = 该文件本身（本槽没有文字），其余一律过下面这道媒体值闸门。 */
function breezeTextSlot(node, slot) {
  const w = wiresTo(node.id).find((x) => Number(x.toIndex) === Number(slot));
  if (w) {
    const src = nodeById(w.from);
    /* 音频 / 视频输入节点：端口 0 = 该文件的 file:/// URL（不是文字）；
       端口 1 = 转写输出（该文件的转写文字，本节点只读用它，绝不自己转录）→ 落到下面取值 */
    if (isBreezeMediaSource(src) && Number(w.fromIndex || 0) <= 0) return "";
  }
  const text = musicGenSlotText(node, slot).trim();
  if (!text) return "";
  return breezeIsMediaValue(text) ? "" : text;
}
/* 端子取音频路径：端口 1（参考音频）之外，**端口 2（参考文稿）接的是音频 / 视频输入节点
   时也认** —— 上游把「这个音频」接到参考文稿口，就等于把它的音频当参考音频给出，音频与
   它的转写正好成对（用户口径：那一段文字从该音频节点已有的转写里取，本节点不做转录）。
   声音来源逐层兜底；没有可用音频就当没接（回落到节点设置里的音色）。 */
function breezeAudioSlotPath(node, slot) {
  const idx = Number(slot) || 0;
  let vals = [];
  try {
    vals = inputValuesFor(node, idx) || [];
  } catch (_) {
    vals = [];
  }
  const w = wiresTo(node.id).find((x) => Number(x.toIndex) === idx);
  const src = w ? nodeById(w.from) : null;
  if (isBreezeMediaSource(src)) {
    /* 音频 / 视频输入节点：内容可能是它自己身上的文件（mediaAsset），也可能是接进来的入线
       （继承输入，见 app.js 的 mediaInputValueOf / inheritedMediaValueOf）。一律走同一个取数
       口径 —— 直接读 mediaAsset 会把「层外音频经壳的输入端子接进来」的那份悄悄换回旧文件。 */
    const ownValue =
      typeof mediaInputValueOf === "function" ? mediaInputValueOf(src) : null;
    const own = String((ownValue && ownValue.path) || "").trim();
    if (own && breezeHasAudioExt(own)) return own;
  }
  /* 这条线自己声明的媒体类型就是音频（保存节点 / 生成器 / 音频输入节点都算）时，
     值里的路径**不再要求扩展名**：源头已把「这是音频」说明了，扩展名兜底只用于形状不明的来源
     （否则「保存节点 → 参考文稿口」这种接法会把音频丢掉，运行时白跑一趟引擎）。 */
  let wireIsAudio = false;
  try {
    wireIsAudio = !!(
      w && wireSourceMediaType(src, Number(w.fromIndex || 0), node) === "audio"
    );
  } catch (_) {
    wireIsAudio = false;
  }
  for (const it of vals) {
    if (wireIsAudio) {
      const v = it && it.value;
      const p = String((v && (v.path || v.text || v.url)) || v || "").trim();
      const norm = p ? breezeAudioPathOfValue(p) : "";
      if (norm) return norm;
      continue;
    }
    const p = breezeAudioPathOfValue(it && it.value);
    if (p) return p;
  }
  /* 上游没给结构化值时退回「显示值」，最后再退回槽文本 */
  const shown = src && typeof displayValueOf === "function" ? displayValueOf(src, node) : null;
  const viaDisplay = breezeAudioPathOfValue(shown && shown.text);
  if (viaDisplay) return viaDisplay;
  const fallback = musicGenSlotText(node, idx).trim();
  return breezeAudioPathOfValue(fallback);
}

/* ═══════════ Breeze 文本槽：输入文本 / 参考文本 两个文本框 ═══════════
 * 需求（用户口径，别自行改动）：breeze_gen 上要看到**两个文本框** ——
 *   ①「输入文本（需要念的）」= 端口 0 的待合成文本；
 *   ②「参考文本（参考音频对应的文字）」= 端口 2 的参考文稿；
 * 两个框同一条规则：**端子有输入 → 只读回显；端子没输入 → 可编辑**，编辑内容分别落在
 * node.srcText / node.refText 上，随节点一起持久化。
 *
 * 本节点**不做转录**（用户明确）：参考文本由用户自己填，或从端口 2 接进来 —— 不调
 * SenseVoice、不写回音色库、也不去替上游转录；**音频 / 视频输入节点接在端口 2 上时**，
 * 它端口 1 的转写输出（那只节点自己转好的文字）就是参考文本，它的音频文件则当参考音频
 * （见 breezeTextSlot / breezeAudioSlotPath）。转录动作始终归音频 / 视频输入节点所有
 * （见 guides/nodes/input_audio.md）。
 *
 * 卡片 body 与设置跳窗共用 breezeTextBoxesFor 这一份实现（两处 DOM id 必须区分，
 * 但真源都只有节点上的那两个字段）。样式沿用 renderer/css/asr.css 的 .n-reftext-*。 */
const BREEZE_TEXT_BOXES = [
  {
    slot: 0,
    field: "srcText",
    placeholder: "（端口 0 有文本时这里只读回显；没有就写要念的文字）",
    title: "端子为空时，这个框里的文字就是本次要合成的内容",
    tip: "端子优先：端口 0 有输入时这里只读",
  },
  {
    slot: 2,
    field: "refText",
    placeholder: "（端口 2 有文本时这里只读回显；没有就写参考音频对应的文字）",
    title: "本次要用的参考文本：留空时若选了音色库音色，就用音色库自带的那份",
    tip: "端子优先：端口 2 有输入时这里只读",
  },
];
/** 节点字段上的正文（文本框的真源） */
function breezeTextOf(node, field) {
  return String((node && node[field]) || "");
}
/** 这个框显示什么、能不能改：端子有值 → 端子那份（只读）；端子空 → 节点上那份（可编辑） */
function breezeTextBoxState(node, spec) {
  const slotText = breezeTextSlot(node, spec.slot);
  if (slotText) return { text: slotText, locked: true };
  /* 写「参考音频对应的文字」的那个框：端口上接的是音频 / 视频输入节点 → 一样归端子
     （只读），哪怕它还没转写过（那时显示空，绝不把节点的旧文字或那条音频 URL 顶上来）。 */
  if (spec && spec.field === "refText" && breezeSlotHasMediaSource(node, spec.slot))
    return { text: "", locked: true };
  /* 端口上接的是**媒体来源**（音频 / 视频输入节点之外：生成器、保存节点、把媒体路径当纯文本
     给出的函数 / 工具节点）→ 同样算「端子有输入」：框只读、里面空着。绝不回退成可编辑，
     否则框里会显示节点上那串旧路径，用户以为端子给了参考文本。 */
  if (breezeSlotHasAnySource(node, spec.slot)) return { text: "", locked: true };
  return { text: breezeTextOf(node, spec.field), locked: false };
}
/** 这个槽上接的是不是「音频 / 视频输入节点」（参考源那一路）：接上就叫只读，
    哪怕它的转写还没跑出来（框里空着）—— 免得用户以为能自己填。 */
function breezeSlotHasMediaSource(node, slot) {
  const w = wiresTo(node.id).find((x) => Number(x.toIndex) === Number(slot));
  return !!(w && isBreezeMediaSource(nodeById(w.from)));
}
/** 这个槽上有没有接上来源（数据线，控制线不算）：接上就算「端子有输入」——
    breezeTextBoxState 用它给媒体值（不是文字）的那一路把框钉成只读。 */
function breezeSlotHasAnySource(node, slot) {
  return wiresTo(node.id).some(
    (x) =>
      Number(x.toIndex) === Number(slot) &&
      !x.rel &&
      !(typeof wireFromIsControl === "function" ? wireFromIsControl(x) : false),
  );
}
/** 待合成文本：端口 0 优先，端子为空才用「输入文本」框里那份（playBreezeGenNode 的唯一取数口） */
function breezeSrcTextOf(node) {
  return breezeTextSlot(node, 0) || breezeTextOf(node, "srcText").trim();
}
/** 用户在框里改字：写回节点字段并落库（**不重画**：正在打字时重画会吞掉焦点与光标） */
function breezeTextBoxCommit(node, spec, text) {
  if (!node || !spec) return;
  node[spec.field] = String(text == null ? "" : text);
  try {
    if (typeof scheduleSave === "function") scheduleSave();
  } catch (_) {}
}
/** 清空一个框（只对可编辑的那份有效：端子有输入时本来就不归用户改） */
function breezeTextBoxClear(node, spec) {
  if (!node || !spec) return;
  node[spec.field] = "";
  try {
    if (typeof scheduleSave === "function") scheduleSave();
  } catch (_) {}
  try {
    if (typeof renderCanvas === "function") renderCanvas();
  } catch (_) {}
}
/** 单个文本框（卡片 body 与设置跳窗共用；opts.compact = 卡片 body 的紧凑形态）
 *  界面上只留输入框本身（标题 / 端口状态胶囊 / 各种提示行都去掉了，说明走 hover title） */
function breezeTextBoxFor(node, spec, opts) {
  const o = opts || {};
  const st = breezeTextBoxState(node, spec);
  const box = document.createElement("div");
  box.className = "n-reftext" + (o.compact ? " n-reftext-card" : "");
  const ta = document.createElement("textarea");
  ta.className = "n-text n-reftext-text";
  ta.spellcheck = false;
  ta.rows = o.compact ? 3 : 4;
  ta.id = "breezetext-" + node.id + "-" + spec.field + (o.compact ? "-card" : "-set");
  ta.value = st.text;
  ta.readOnly = !!st.locked;
  ta.placeholder = I18n.t(spec.placeholder);
  ta.title = st.locked ? I18n.t(spec.tip) : I18n.t(spec.title);
  ta.addEventListener("click", (ev) => ev.stopPropagation());
  ta.addEventListener("input", () => {
    if (!st.locked) breezeTextBoxCommit(node, spec, ta.value);
  });
  box.appendChild(ta);
  /* 可编辑且已有内容 → 给一颗「清空」（端子有输入时没什么可清） */
  if (!st.locked && breezeTextOf(node, spec.field).trim()) {
    const ops = document.createElement("div");
    ops.className = "bentry-ops n-reftext-ops";
    const clr = document.createElement("button");
    clr.type = "button";
    clr.className = "mini";
    clr.textContent = I18n.t("清空");
    clr.title = I18n.t("清掉这个框里的文字（端子有输入时这一格本来就不归你改）");
    clr.onclick = (ev) => {
      ev.stopPropagation();
      breezeTextBoxClear(node, spec);
    };
    ops.appendChild(clr);
    box.appendChild(ops);
  }
  return box;
}
/** 两个文本框（顺序 = 输入文本、参考文本；卡片 body 与设置窗共用这一份）。
 *  选了角色预设时只留「输入文本」：参考音频 / 样本文字都来自那一组，端口 1/2 不参与。 */
function breezeTextBoxesFor(node, opts) {
  const o = opts || {};
  const host = document.createElement("div");
  host.className =
    "n-reftext-host n-textslots" + (o.compact ? " n-reftext-host-card" : " n-reftext-host-set");
  const hasPreset = !!breezePresetIdOf(node);
  for (const spec of BREEZE_TEXT_BOXES) {
    if (hasPreset && spec.slot === 2) continue;
    host.appendChild(breezeTextBoxFor(node, spec, o));
  }
  return host;
}
/** 卡片 body 上的两个文本框（app-canvas.js 在摘要之后按 typeof 取；缺模块时不挂） */
function appendBreezeTextBoxesBody(node, body) {
  if (!node || !body || node.kind !== "breeze_gen") return;
  try {
    body.appendChild(breezeTextBoxesFor(node, { compact: true }));
  } catch (_) {}
}
/* ── 角色预设（角色名 + 若干组「音频样本 + 样本文字 + 指令」） ────────────────
   真源在宿主（breeze/main-breeze.js 的 presets/，管理台维护），渲染层只读缓存。
   选了角色后：端口 1 / 2 在合成时**不参与**（界面上也隐藏），参考音频与样本文字来自那一组，
   指令 = 端口 3 / 节点指令（非空则覆写）否则组里的指令。没选角色 = 老口径（端子 / 音色库）。 */
const BREEZE_PRESET_CACHE_MS = 3000;
let breezePresetCache = { at: 0, presets: [], loading: null };
/** 读预设清单（带 3 秒缓存；画布上多节点同时刷摘要不会把磁盘读穿）。
 *  宿主没装插件 / 桥不可用时返回空数组，绝不抛。 */
function breezePresetsLoad(force) {
  const now = Date.now();
  if (!force && now - breezePresetCache.at < BREEZE_PRESET_CACHE_MS) {
    return Promise.resolve(breezePresetCache.presets);
  }
  if (breezePresetCache.loading) return breezePresetCache.loading;
  const api = typeof window !== "undefined" ? window.api : null;
  if (!api || typeof api.breezePresets !== "function") return Promise.resolve([]);
  const p = Promise.resolve()
    .then(() => api.breezePresets())
    .then((r) => {
      const list = r && r.ok && Array.isArray(r.presets) ? r.presets : [];
      breezePresetCache = { at: Date.now(), presets: list, loading: null };
      return list;
    })
    .catch(() => {
      breezePresetCache = { at: Date.now(), presets: breezePresetCache.presets || [], loading: null };
      return breezePresetCache.presets || [];
    });
  breezePresetCache.loading = p;
  return p;
}
/** 节点上选的角色 / 组（字段名 node.presetId · node.presetGroupId，随节点持久化） */
function breezePresetIdOf(node) {
  return String((node && node.presetId) || "").trim();
}
function breezePresetGroupIdOf(node) {
  return String((node && node.presetGroupId) || "").trim();
}
function breezePresetFind(presets, id) {
  const key = String(id || "");
  return (presets || []).find((p) => p && p.id === key) || null;
}
/** 组的显示名：组名优先，无名字的旧组回退「第 N 组」。
 *  角色窗的组卡 / 节点上的两个下拉 / 参数匹配都走这一份 —— 三个地方不许各拼各的。 */
function breezePresetGroupLabel(group, index) {
  const name = String((group && group.name) || "").trim();
  if (name) return name;
  const n = Number(index);
  return I18n.t("第 {n} 组", { n: (isFinite(n) && n >= 0 ? n : 0) + 1 });
}
/** 「第 N 组」这种按序号的写法 → N（1 起）；认不出返回 0。
 *  参数里的组名允许这么写（无名字的旧组没有别的名字可写），空格可有可无。 */
function breezeGroupOrdinalOf(text) {
  const m = String(text == null ? "" : text).trim().match(/^第\s*(\d{1,4})\s*组$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return isFinite(n) && n >= 1 ? n : 0;
}
/** 名称比较口径：忽略首尾空格与大小写（参数是人手写的，不让空格 / 大小写决定成败） */
function breezeNameKey(s) {
  return String(s == null ? "" : s).trim().toLowerCase();
}
/** 参数里的「角色名称」→ 一个角色：名称优先，再退 id；找不到 / 同名多个都算错（不许猜）。 */
function breezeMatchPreset(presets, text) {
  const raw = String(text == null ? "" : text).trim();
  const list = (presets || []).filter((p) => p && !p.draft);
  if (!raw) return { preset: null };
  const key = breezeNameKey(raw);
  let hit = list.filter((p) => breezeNameKey(p.name) === key);
  if (!hit.length) hit = list.filter((p) => String(p.id || "") === raw);
  if (hit.length === 1) return { preset: hit[0] };
  if (hit.length > 1)
    return {
      error:
        I18n.t("参数里的角色「") +
        raw +
        I18n.t("」对上了多个同名角色：") +
        hit.map((p) => String(p.name || p.id) + "(" + p.id + ")").join("、") +
        I18n.t("；请改用角色 id 指定"),
    };
  return {
    error:
      I18n.t("参数里的角色「") +
      raw +
      I18n.t("」没匹配上") +
      (list.length
        ? I18n.t("（现有：") + list.map((p) => String(p.name || p.id)).join("、") + I18n.t("）")
        : I18n.t("（现在还没有角色预设）")),
  };
}
/** 参数里的「组名」→ 角色里的某一组：组名优先，再认「第 N 组」，最后退 id。 */
function breezeMatchGroup(groups, text) {
  const raw = String(text == null ? "" : text).trim();
  const list = (Array.isArray(groups) ? groups : []).filter(Boolean);
  if (!raw) return { group: list[0] || null, index: 0 };
  const all = list.map((g, i) => ({ g, i }));
  const key = breezeNameKey(raw);
  let hit = all.filter((x) => String(x.g.name || "").trim() && breezeNameKey(x.g.name) === key);
  if (!hit.length) {
    const ord = breezeGroupOrdinalOf(raw);
    if (ord) hit = all.filter((x) => x.i + 1 === ord);
  }
  if (!hit.length) hit = all.filter((x) => String(x.g.id || "") === raw);
  if (hit.length === 1) return { group: hit[0].g, index: hit[0].i };
  if (hit.length > 1)
    return {
      error:
        I18n.t("对上了多个同名组：") +
        hit.map((x) => breezePresetGroupLabel(x.g, x.i) + "(" + x.g.id + ")").join("、") +
        I18n.t("；请改用组 id 指定"),
    };
  return {
    error:
      I18n.t("没匹配上") +
      (list.length
        ? I18n.t("（现有：") +
          list.map((g, i) => breezePresetGroupLabel(g, i)).join("、") +
          I18n.t("）")
        : I18n.t("（这个角色还没有样本组）")),
  };
}
/** 参数端子里的「角色名称 + 组名」→ 这次运行该用的 presetId / presetGroupId（纯函数，冒烟直接跑）。
 *  口径（与用户共识一致）：名称没给就用节点已选角色；组名没给就用该角色第一组；
 *  只给组名而节点也没角色 = 报错（组名必须挂在角色下面）；对不上 = 报错，绝不默默换声。 */
function breezeParamPickPlan(node, presets, presetText, groupText) {
  const pText = String(presetText == null ? "" : presetText).trim();
  const gText = String(groupText == null ? "" : groupText).trim();
  if (!pText && !gText) return { presetId: "", presetGroupId: "" };
  let preset = null;
  if (pText) {
    const m = breezeMatchPreset(presets, pText);
    if (m.error) return { error: m.error };
    preset = m.preset;
  } else {
    preset = breezePresetFind(presets, breezePresetIdOf(node));
    if (!preset)
      return {
        error:
          I18n.t("参数给了组名「") +
          gText +
          I18n.t("」，但节点没有选角色：组名必须挂在角色下面（请同时给 breezePreset，或在节点上先选角色）"),
      };
  }
  if (!preset)
    return { error: I18n.t("参数里的角色没匹配上（现在还没有角色预设）") };
  const groups = Array.isArray(preset.groups) ? preset.groups : [];
  if (!gText) {
    const first = groups[0] || null;
    return { presetId: preset.id, presetGroupId: first ? String(first.id || "") : "" };
  }
  const m = breezeMatchGroup(groups, gText);
  if (m.error)
    return {
      error:
        I18n.t("参数里的组名「") +
        gText +
        I18n.t("」在角色「") +
        String(preset.name || preset.id) +
        I18n.t("」里") +
        m.error,
    };
  return { presetId: preset.id, presetGroupId: m.group ? String(m.group.id || "") : "" };
}
/** 上面的 plan + 读一次宿主清单（带缓存）。运行期由 app-node-params.js 调用。 */
async function breezeParamPicks(node, presetText, groupText) {
  const pText = String(presetText == null ? "" : presetText).trim();
  const gText = String(groupText == null ? "" : groupText).trim();
  if (!pText && !gText) return { presetId: "", presetGroupId: "" };
  const presets = await breezePresetsLoad(true);
  return breezeParamPickPlan(node, presets, pText, gText);
}
/** 选了的那一组：指定组优先，组没了退回该角色第一组；返回 { preset, group, index } 或 null */
function breezePresetPick(node, presets) {
  const pid = breezePresetIdOf(node);
  if (!pid) return null;
  const preset = breezePresetFind(presets, pid);
  if (!preset) return null;
  const groups = Array.isArray(preset.groups) ? preset.groups : [];
  const gid = breezePresetGroupIdOf(node);
  let idx = gid ? groups.findIndex((g) => g && g.id === gid) : -1;
  if (idx < 0) idx = 0;
  if (!groups.length) return { preset, group: null, index: 0 };
  return { preset, group: groups[idx], index: idx };
}
/** 摘要 / 状态行上的一行字：角色：旁白 · 第2组；没选 = 空串 */
function breezePresetLabelOf(node, presets) {
  const pid = breezePresetIdOf(node);
  if (!pid) return "";
  const hit = breezePresetPick(node, presets || breezePresetCache.presets);
  if (!hit) return I18n.t("角色预设已删除（请重选）");
  return (
    I18n.t("角色：") +
    hit.preset.name +
    (hit.group ? " · " + breezePresetGroupLabel(hit.group, hit.index) : "")
  );
}
/** 选了角色但已经不可用（删了 / 组没了 / 缺音频）：返回一句红字提示，正常返回空串 */
function breezePresetProblemOf(node, presets) {
  const pid = breezePresetIdOf(node);
  if (!pid) return "";
  const list = presets || breezePresetCache.presets;
  const preset = breezePresetFind(list, pid);
  if (!preset) return I18n.t("角色预设已删除或不可用，请重选角色");
  const hit = breezePresetPick(node, list);
  if (!hit || !hit.group) return I18n.t("这个角色还没有样本组：请到管理台给它加一组（音频 + 样本文字）");
  if (!hit.group.hasAudio) return I18n.t("角色这一组缺少音频：请到管理台补上参考音频");
  if (!String(hit.group.refText || "").trim())
    return I18n.t("角色这一组缺少样本文字：请到管理台补上（音频与文字必须成对）");
  return "";
}
/* 参考源解析：选了角色 → 用那一组；否则端子优先，端子空了才用音色库（老工作流兼容）。
   返回 {audioPath, refText, voiceId, source, instruction?, presetId?} */
function breezeResolveRef(node, voices, presets) {
  const hit = breezePresetPick(node, presets || breezePresetCache.presets);
  if (hit) {
    /* 选了角色：端口 1 / 2 一律不参与（界面上已隐藏），免得两套参考源打架 */
    return {
      audioPath: String((hit.group && hit.group.audioPath) || ""),
      refText: String((hit.group && hit.group.refText) || ""),
      voiceId: "",
      instruction: String((hit.group && hit.group.instruction) || ""),
      presetId: hit.preset.id,
      presetGroupId: hit.group ? hit.group.id : "",
      source: breezePresetLabelOf(node, presets || breezePresetCache.presets),
    };
  }
  const slot1Audio = breezeAudioSlotPath(node, 1);
  const slot2Audio = breezeAudioSlotPath(node, 2);
  const audioPath = slot1Audio || slot2Audio;
  const slotText = breezeTextSlot(node, 2);
  const ownText = breezeTextOf(node, "refText").trim();
  const voiceId = String((node && node.voice) || "").trim();
  if (audioPath) {
    return {
      audioPath,
      /* 端子文稿 > 节点「参考文本」框里的那份（端子优先，与文本框只读口径同源） */
      refText: slotText || ownText,
      voiceId: "",
      source: slot1Audio ? I18n.t("参考音频端子") : I18n.t("参考音频端子（端口 2 的音频）"),
    };
  }
  if (voiceId) {
    const v = (voices || []).find((x) => x && x.id === voiceId);
    return {
      audioPath: "",
      refText: slotText || ownText || String((v && v.text) || "").trim(),
      voiceId,
      source: I18n.t("音色库：") + voiceId,
    };
  }
  return {
    audioPath: "",
    refText: slotText || ownText,
    voiceId: "",
    source: I18n.t("无参考音频（音色设计）"),
  };
}

/* 后端 / HTTP 错误 → 一句能照着做的中文提示；认不出的原样回显便于排查。
   主进程把 HTTP 错误体整段塞进 error（后端形如 {"detail":{"code":…,"message":…}}）。 */
function breezeErrorText(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      const d = j && (j.detail || j.error || j.message);
      if (d && typeof d === "object") s = String(d.code || d.message || "").trim() || s;
      else if (typeof d === "string" && d.trim()) s = d.trim();
    } catch (_) {
      /* 非 JSON：按原文处理 */
    }
  }
  const T = I18n.t;
  const exact = {
    text_required: T("待合成文本为空"),
    no_output_path: T("未设置输出路径"),
    no_api_key: T("Breeze TTS 2 服务密钥缺失（请先在「插件 · Breeze TTS 2 本地 TTS」启动一次后端）"),
    empty_audio: T("Breeze TTS 2 后端返回空音频（可换一个参考片段或调整 cfg_scale 后重试）"),
    ref_text_required: T(
      "参考音频必须与参考文本成对提供（请在节点的「参考文本」框里填写，或把音频节点的「转写输出」接到端口 2）",
    ),
    ref_audio_required: T("「音色克隆」需要参考音频（接端子或选一个音色）"),
    mode_conflict: T(
      "「音色设计」不使用参考音频：音色来自 instruction，请改用「音色导演」或清掉参考音频",
    ),
    instruction_required: T("「音色导演」需要 instruction（描述语气、情绪、节奏）"),
    bad_cfg_scale: T("cfg_scale 必须大于 0（官方建议 instruction 场景用 4）"),
    bad_speed: T("speed 需在 0.25 ~ 4.0 之间"),
    unsupported_format: T("后端不支持该输出格式（可选 wav / flac / mp3）"),
    missing_ffmpeg: T("本机缺少 ffmpeg，无法转 mp3（请改用 wav / flac，或重装 Breeze TTS 2 后端）"),
    transcode_failed: T("音频转码失败（请改用 wav / flac，或重装 Breeze TTS 2 后端）"),
    busy_engine: T("引擎正忙（同一时刻只跑一个合成请求），请稍后重试"),
    engine_loading: T("推理引擎还在加载权重（首次需数十秒到数分钟），请稍后重试"),
    engine_down: T("无法连接 Breeze TTS 2 推理引擎（请先点「加载模型」，或重新执行本节点）"),
    engine_stream_broken: T(
      "Breeze 引擎在合成途中中断（这段文本超出引擎一次能装下的长度，已自动改为分段重试）：若反复出现请打开插件控制台查看日志",
    ),
    internal_error: T("Breeze 后端内部出错（详情见插件控制台日志）"),
    engine_rejected: T("Breeze TTS 2 引擎拒绝了这次请求（详情见插件控制台日志）"),
    engine_exited: T("Breeze TTS 2 引擎启动后退出（详情见插件控制台日志）"),
    engine_start_timeout: T("Breeze TTS 2 引擎未能在规定时间内就绪（可打开插件控制台查看启动日志）"),
    not_installed: T("Breeze TTS 2 后端尚未安装或要件不全（请在「插件 · Breeze TTS 2 本地 TTS」中安装）"),
    no_weights: T("未找到 Breeze TTS 2 权重（请重新安装，或指定已有权重目录）"),
    bad_python: T("Breeze TTS 2 需要 Python 3.10+（请检查安装环境）"),
    torch_missing: T("Breeze TTS 2 虚拟环境缺少 torch（请重新安装）"),
    cuda_unavailable: T("torch 看不到 CUDA（Breeze TTS 2 需要 NVIDIA GPU，eager 约 7.7GB 显存）"),
    voice_not_found: T("Breeze TTS 2 音色不存在（请在控制台音色库里重新选择）"),
    voice_audio_required: T("该音色缺少参考音频（请在控制台音色库里补上）"),
    preset_missing: T("角色预设已删除或不可用（请在节点上方「角色」里重新选一个）"),
    preset_group_missing: T("这个角色没有可用的样本组（请到管理台加一组：音频 + 样本文字）"),
    preset_audio_missing: T("角色这一组缺少音频（请到管理台补上参考音频）"),
    backend_down: T("Breeze TTS 2 后端未能在规定时间内就绪（可打开插件控制台查看启动日志）"),
    write_failed: T("音频写盘失败（请检查输出路径是否可写）"),
  };
  const key = s.split(/[:\s]+/)[0].toLowerCase();
  if (exact[s.toLowerCase()]) return exact[s.toLowerCase()];
  if (exact[key])
    return exact[key] + (s.length > key.length ? "：" + s.slice(key.length + 1) : "");
  const httpM = s.match(/^HTTP Error (\d{3})/i);
  if (httpM)
    return T("后端返回 HTTP 错误：") + httpM[1] + T("（请打开插件控制台查看日志）");
  if (/econnrefused|enotfound|fetch failed|socket hang up|timed?\s*out|network/i.test(s))
    return T("无法连接 Breeze TTS 2 后端（后端可能已退出，请重新执行本节点）");
  return s || T("合成失败");
}

/* 确保 Breeze 管理服务在线：已在线直接返回；未运行则拉起并轮询 apiUp。
   { ok:true, st } / { ok:false, cancelled?, error? }（error 已是中文展示文案） */
async function ensureBreezeBackendReady(node) {
  let st = null;
  try {
    st = await fetchMediaBackendStatus(node);
  } catch (_) {
    st = null;
  }
  if (st && st.apiUp) return { ok: true, st };
  if (!window.api || !window.api.breezeStart)
    return { ok: false, error: I18n.t("Breeze 语音插件未就绪") };
  if (!st || !st.installed)
    return { ok: false, st, error: breezeErrorText("not_installed") };
  let r = null;
  try {
    r = await window.api.breezeStart();
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
  const deadline = Date.now() + BREEZE_API_WAIT_MS;
  for (;;) {
    if (node && mediaRunStopped(node)) return { ok: false, cancelled: true, st };
    try {
      st = await fetchMediaBackendStatus(node);
    } catch (_) {
      st = null;
    }
    if (st && st.apiUp) return { ok: true, st };
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, BREEZE_API_POLL_MS));
  }
  return { ok: false, st, error: breezeErrorText((r && r.error) || "backend_down") };
}

async function playBreezeGenNode(node, quiet) {
  if (!window.api || !window.api.breezeGenerate) {
    toast(I18n.t("Breeze 语音插件未就绪"), "err");
    return;
  }
  /* 串行链出队后由 mediaRunPrestart 先点亮了运行态（显存预释放那段也算本次运行）：
     那一下是本运行体的交接，不是「已经在跑」，必须放行 */
  if (node.running && !node._prestart) return;
  /* 「全部终止 / 单独停止」之后不得再起跑（含串行队列里排到点的任务） */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }
  /* 参数端子里的角色 / 组名没对上（见 app-node-params.js 的 breezeParamPicks）：
     状态行红字写清「哪个名字没匹配上」，这次合成直接停 —— 绝不默默换个声音出声。 */
  const pickError = String(node._npPresetError || "");
  if (pickError) {
    node.error = pickError;
    node.breezeStatus = pickError;
    if (!quiet) toast(pickError, "err");
    renderCanvas();
    return;
  }

  /* 待合成文本：端口 0 优先，端子为空时用节点上「输入文本」框里那份（见 breezeSrcTextOf） */
  const text = breezeSrcTextOf(node);
  if (!text) {
    const msg = I18n.t("待合成文本为空：请在「输入文本」框里填写，或从端口 0 接上文本来源");
    node.error = msg;
    node.breezeStatus = msg;
    if (!quiet) toast(msg, "warn");
    renderCanvas();
    return;
  }
  /* 全局互斥：本地大模型（音乐 / 视频 / 图像 / 语音）全局仅允许 1 个任务 ——
     Breeze 引擎 eager 就要约 7.7GB 显存，与音乐 / 视频抢同一张卡，所以照音乐 / 视频的口径占锁。
     真正持锁的是主进程宿主（generateBreezeFile），这里只做「别人占着就先别起跑」的前置判定。 */
  try {
    const lock = await fetchMediaGenLock();
    if (lock && lock.nodeId && lock.nodeId !== node.id) {
      node.error = mediaGenLockBusyMsg(lock);
      node._busyErrAt = Date.now(); /* 见 app.js sweepStaleMediaBusyErrors：新报的别当场扫掉 */
      node.breezeStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch {}
  const exp0 = requireMediaGenExport(node, quiet);
  if (!exp0) {
    renderCanvas();
    return;
  }
  const nRolls = attemptCount(node);
  /* 能力档：选了角色 = 音色导演（参考音频 + 指令同时给）；没选角色才用节点上的能力档 */
  const modeCfg = breezeModeOf(node);
  const fmt = breezeFormatOf(node);
  const instructionSlot = breezeTextSlot(node, 3);

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
  node.breezeStatus = I18n.t("启动后端并合成…");
  renderCanvas();

  const t0 = Date.now();
  let okCount = 0;
  let lastPath = "";
  let managedRun = false;
  try {
    const ready = await ensureBreezeBackendReady(node);
    if (!ready.ok) {
      if (ready.cancelled || node._aborted) {
        node.error = null;
        node.breezeStatus = I18n.t("已取消");
        const ui0 = ensureBackendUiState(node);
        ui0.genMsg = I18n.t("已取消");
        ui0.genPct = 0;
        return;
      }
      node.error = ready.error;
      node.breezeStatus = ready.error;
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

    /* 取数期间可能已被终止 → 不再往下走（不白跑一趟引擎） */
    if (node._aborted || mediaRunStopped(node)) {
      node.breezeStatus = I18n.t("已取消");
      return;
    }

    const voices = (ready.st && ready.st.apiStatus && ready.st.apiStatus.voices) || [];
    /* 角色预设：清单读失败也照常跑（退回端子模式），但选了角色却读不到就得拦住 —— 不能默默换声 */
    const presets = await breezePresetsLoad(true);
    const presetProblem = breezePresetProblemOf(node, presets);
    if (presetProblem) {
      node.error = presetProblem;
      node.breezeStatus = presetProblem;
      if (!quiet) toast(presetProblem, "err");
      return;
    }
    const ref = breezeResolveRef(node, voices, presets);
    /* 指令：端口 3 > 节点设置里的 instruction > 角色那一组的指令（空 = 忽略，用组里的） */
    const instruction =
      instructionSlot || String(node.instruction || "").trim() || String(ref.instruction || "").trim();
    const mode = ref.presetId ? "direction" : modeCfg;
    /* 克隆（有参考音频、无导演指令）的引擎模板 ref_clone_tata 没有负向提示词，引擎对
       cfg_scale≠1.0 会直接 500 —— 这一路只下发 1.0，界面填的值不下发（后端还会再钳一层）。 */
    const cfgLocked = ref.presetId
      ? false
      : breezeCfgLockedOf(node, { hasRef: !!ref.audioPath, instruction });
    const cfgScale = ref.presetId
      ? breezeCfgScaleOf(node)
      : breezeCfgScaleForRun(node, { hasRef: !!ref.audioPath, instruction });
    node.cfgClamped = cfgLocked && cfgScale !== breezeCfgScaleOf(node);
    /* 参考音频与参考文本必须成对（官方接口要求）。本节点**不做转录**：端口 2 没给文字、
       节点「参考文本」框里也没填，就在这里拦下，并指路（框里填，或去音频节点点「转录」、
       把它的转写输出接到端口 2）—— 不再自动转写。 */
    if (ref.audioPath && !ref.refText) {
      node.error = breezeErrorText("ref_text_required");
      node.breezeStatus = node.error;
      if (!quiet) toast(node.error, "err");
      return;
    }
    if (ref.audioPath && !instruction && mode === "design") {
      node.error = breezeErrorText("mode_conflict");
      node.breezeStatus = node.error;
      if (!quiet) toast(node.error, "err");
      return;
    }
    node.refSource = ref.source;

    for (let roll = 1; roll <= nRolls; roll++) {
      if (mediaRunStopped(node)) break;
      const exp = await prepareMediaGenRollExport(node, roll, nRolls);
      if (!exp || !exp.ok) {
        requireMediaGenExport(node, quiet);
        node.error = savePathResolveError(exp && exp.code);
        node.breezeStatus = node.error;
        if (!quiet) toast(node.error, "warn");
        return;
      }
      if (roll === 1 && nRolls === 1 && exp.renamed) {
        syncMediaGenPathFromExport(node, exp);
        if (!quiet) toast(I18n.t("目标文件已存在，改为保存为：") + exp.filename, "ok");
      }
      if (exp.managed) managedRun = true;
      /* 种子：与其它媒体节点同一口径 —— 摇数开启时每次合成（含抽卡）种子 +1，
         否则固定种子可复现。缺省值仍是 1（见 breezeSeedOf）。 */
      if (!isFinite(Math.floor(Number(node.seed)))) node.seed = breezeSeedOf(node);
      const seed = nextMediaGenSeed(node);
      {
        const ui = ensureBackendUiState(node);
        ui.genPct = Math.max(ui.genPct || 20, 40);
        ui.genMsg = mediaGenRollProgressTag(node) + I18n.t("Breeze 语音生成中…");
        node.breezeStatus = ui.genMsg;
      }
      node.genRollDone = roll - 1;
      refreshMediaNodeUi(node, { soft: true });

      const r = await window.api.breezeGenerate({
        nodeId: node.id,
        workflowId: (S.wf && S.wf.id) || "",
        text,
        voice: ref.voiceId,
        refAudio: ref.audioPath,
        refText: ref.refText,
        instruction,
        mode,
        /* 宿主也会据此再解析一次（管理台刚改过预设时以宿主那份为准） */
        presetId: ref.presetId || "",
        presetGroupId: ref.presetGroupId || "",
        cfgScale,
        seed,
        response_format: fmt,
        /* 托管：不下发 outputPath（只走 workflowId + nodeId）→ 宿主落托管目录并回传绝对路径 */
        ...(exp.managed ? {} : { outputPath: exp.path }),
      });
      if (node._aborted) {
        node.error = null;
        node.breezeStatus = I18n.t("已取消");
        const ui = ensureBackendUiState(node);
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        return;
      }
      if (!r || !r.ok) {
        const err = (r && (r.error || r.message)) || "breeze_failed";
        node.error = breezeErrorText(err);
        node.breezeStatus = node.error;
        if (!r || looksLikeBackendConnError(err)) markMediaBackendDown(node);
        if (!quiet) toast(node.error, "err");
        return;
      }
      okCount++;
      lastPath = String(r.path || "");
      if (lastPath) node.genPaths.push(lastPath);
      node.output = { kind: "audio", path: lastPath, text: lastPath };
      node.ranAt = Date.now();
      /* 托管：宿主回传的绝对路径只进 node.output（下游保存节点取它落盘），
         绝不写回节点自己的 outputPath 配置 —— 一写就退回「已配路径」口径。 */
      if (lastPath && nRolls === 1 && !exp.managed) syncMediaGenPathFromExport(node, lastPath);
      node.genRollDone = roll;
    }
    if (node._aborted) {
      node.error = null;
      node.breezeStatus = I18n.t("已取消");
      const ui = ensureBackendUiState(node);
      ui.genMsg = I18n.t("已取消");
      ui.genPct = 0;
      return;
    }
    if (!okCount) return;
    const doneMsg =
      mediaGenDoneMsg(Date.now() - t0) +
      mediaGenManagedTag(managedRun) +
      " · " +
      I18n.t("参考源：") +
      String(node.refSource || "");
    node.breezeStatus = doneMsg;
    {
      const ui = ensureBackendUiState(node);
      ui.genPct = 100;
      ui.genMsg = doneMsg;
    }
    if (!quiet) {
      toast(
        nRolls > 1
          ? I18n.t("Breeze 语音已生成：") + okCount + "/" + nRolls + I18n.t(" 次")
          : I18n.t("Breeze 语音已生成：") + lastPath,
        "ok",
      );
    }
  } catch (e) {
    if (node._aborted) {
      node.error = null;
      node.breezeStatus = I18n.t("已取消");
    } else {
      node.error = breezeErrorText((e && e.message) || String(e));
      node.breezeStatus = node.error;
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
    /* 本节点这一趟已经收摊：它的「等待中」标记不该再留着。
       媒体串行链的出队点（runMediaGenSerial）已经清过一次，这里再兜一次 ——
       一轮跑完之后 id 还挂在 S.pendingRun 上时，节点头部 ▶ 会被钉成「排队等待中…」
       且点不动、也没有 ■ 可按（用户报的「处理完仍然显示等待中，且无法关闭」）。
       clearPendingRun 默认会为「仍在串行链上排队」的 id 保留等待态，所以这里再排队
       一次也不会被误清；顺手扫一遍整表的幽灵项（别的节点早先留下的）。 */
    clearPendingRun([node.id]);
    sweepOrphanPendingRuns();
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
  /* 新一轮真起跑：上一轮「假处理中」被摘除的痕迹一并作废（收尾时不再按它压状态） */
  node._ghostCleared = false;
  /* 串行链预点亮的交接标记到此结束（见 mediaRunPrestart）：从这里起「running 已置」就是真的在跑 */
  node._prestart = false;
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
/* 媒体节点是否已被终止。
   只认 _aborted：全仓唯一的「停止」入口 bumpNodeStop 一定同时置 _aborted 与递增 _stopTick
   （app.js stopNode / stopAllRuns / abortTaskTree 都走它），所以「本批被作废」这件事
   _aborted 是充分且唯一可靠的判据。旧写法还 OR 一个 _stopTick !== _runTick：
   那是个**派生量** —— 任何一个入口只要碰过 _stopTick 而没置 _aborted（或相反），
   排队中的任务就会在出队那一刻被静默判死（提示「已终止（排队中的生成任务已取消）」并从
   运行队列消失），而用户从没停过它。排队项要不要作废另有两条独立证据，不会漏杀：
     · 显式停止：_aborted（本函数）+ stopNode / stopAllMediaGen 把条目从 mediaGenWaiters 摘掉；
     · 全局终止：runMediaGenSerial 出队时比对的 seq（GLOBAL_STOP_SEQ）。
   所以这里退回单一判据，杜绝「排队中被误删」。 */
function mediaRunStopped(node) {
  return !!(node && node._aborted);
}

/* 媒体生成排队表：nodeId -> entry（终止时整表清空 = 排队项作废） */
const mediaGenWaiters = new Map();
/* 仍在媒体串行链上排队（还没起跑）的节点 id 集合：运行队列 / 等待态的唯一真源。
   排队项从入队到出队（或显式停止）都在 mediaGenWaiters 里，所以「它还在等」这件事
   有独立证据，不必依赖随时会被别的批次清掉的 S.pendingRun（见 clearPendingRun 的注释）。 */
function mediaGenQueuedIds() {
  return new Set(mediaGenWaiters.keys());
}
function mediaGenQueueHolds(id) {
  const key = id == null ? "" : String(id);
  return !!key && mediaGenWaiters.has(key);
}

/* ── 「排队中被取消 → 再点 ▶ 进不了队列」的判定与作废入口（本轮 bug）───────────────
   症状（用户报：视频 / 语音 / 音乐・图像节点在运行队列里被取消后，无法再进队列）：
   媒体族节点被 runMediaGenSerial 排在串行链上等位期间，**那一轮 playNode 的 playLock
   一直挂着**（它正 await 链上的排队位）。用户在运行队列里点 ■ 取消排队（stopNode 的
   媒体分支）只摘掉媒体排队表的条目 + 清等待态，**不会、也不该**去碰那把 playLock；
   于是再点 ▶ 时 playNode 仍命中 `if (hit) { await hit; return; }` —— 只等旧 promise，
   既不报错、也不重新入队，用户看到的就是「点了没反应、队列里也不再出现它」。
   排队窗口等于链上前面那些任务的时长（视频动辄几分钟），所以才像「再也进不去」。

   判据（只在 playNode 已经确认 `S.playLocks` 里挂着旧锁时才用，所以不必再自查锁）：
   媒体族节点 + 此刻不在跑 = 这一发必须重新入队，而不是去等那个已经没人要的旧位次。
   · 「还在链上排队」的正常情形走不到这儿（▶ 那时是禁用形态、排队中也不渲染可点的 ▶）；
   · 运行中的节点 running 为真 → 照旧 await 旧锁（排队点了不生效的老语义一个字没动）；
   · 普通处理节点不在这条串行链上，判定直接放行到老的 await 分支（语义不变）。 */
function mediaRequeueStaleLock(node) {
  if (!node) return false;
  if (typeof isMediaGenNode === "function" && !isMediaGenNode(node)) return false;
  return !node.running;
}

/* 作废「上一次排队」留下的残条目（排队表条目 + 等待态标记）。之后链上那个旧位次
   出队时会认不出自己的条目（`cur !== entry`）→ 静默作废，绝不起跑后端、
   也不给节点写任何状态：新条目才是这一节点的当前意图。 */
function mediaNodeRequeueStale(node) {
  if (!node) return false;
  let hit = false;
  if (mediaGenQueueHolds(node.id)) {
    mediaGenWaiters.delete(node.id);
    hit = true;
  }
  if (S.pendingRun && S.pendingRun.has(node.id)) {
    clearPendingRun([node.id], { force: true });
    hit = true;
  }
  if (hit) {
    renderCanvas();
    updateRunQueuePanel();
  }
  return hit;
}
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
   语音（breeze_gen）：走 breeze:cancelGenerate —— 断掉在途 /v1/audio/speech 连接并停引擎。
   引擎侧没有 cancel 接口，只有停掉进程才能让生成真的停下、显存立刻还回来（以前只作废界面，
   引擎照跑，所以表现为「停不掉 / 关不掉」）。 */
function mediaGenCancelRemote(node) {
  if (!node || !window.api) return;
  try {
    if (node.kind === "music_gen" && window.api.music3CancelGenerate)
      window.api.music3CancelGenerate(node.id);
    else if (node.kind === "yue_gen" && window.api.yue2CancelGenerate)
      window.api.yue2CancelGenerate(node.id);
    else if (node.kind === "flux3klein_gen" && window.api.flux3kleinCancelGenerate)
      window.api.flux3kleinCancelGenerate(node.id);
    else if (node.kind === "qwenimage_gen" && window.api.qwenimageCancelGenerate)
      window.api.qwenimageCancelGenerate(node.id);
    else if (node.kind === "breeze_gen" && window.api.breezeCancelGenerate)
      window.api.breezeCancelGenerate(node.id);
    else if (
      (node.kind === "video_gen" ||
        (typeof isVideoPostKind === "function" && isVideoPostKind(node))) &&
      window.api.h3CancelGenerate
    )
      /* 视频后处理与生成同占 H3 后端大锁：取消入口同一个（h3:cancelGenerate） */
      window.api.h3CancelGenerate(node.id);
    else if (node.kind === "remotion" && window.api.remotionCancel)
      window.api.remotionCancel(node.id);
    else if (node.kind === "infinitetalk_gen" && window.api.infinitetalkCancelGenerate)
      window.api.infinitetalkCancelGenerate(node.id);
    else if (node.kind === "soulxflashhead_gen" && window.api.soulxflashheadCancelGenerate)
      window.api.soulxflashheadCancelGenerate(node.id);
    else if (node.kind === "moss_music" && window.api.mossmusicCancelGenerate)
      /* MOSS-Music：主进程 /cancel（分块边界退出）→ 3s → taskkill → /unload，显存一定还回来 */
      window.api.mossmusicCancelGenerate(node.id);
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
  else if (node.kind === "yue_gen") node.yueStatus = msg;
  else if (node.kind === "breeze_gen") node.breezeStatus = msg;
  else if (node.kind === "flux3klein_gen") node.flux3kleinStatus = msg;
  else if (node.kind === "qwenimage_gen") node.qwenimageStatus = msg;
  else if (
    node.kind === "video_gen" ||
    (typeof isVideoPostKind === "function" && isVideoPostKind(node))
  )
    node.videoStatus = msg;
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
      /* 媒体族里 music_gen / yue_gen / video_gen+后处理 / breeze_gen 会占后端大锁
       （remotion 走本地渲染、不占锁）：其余一律不认领 */
    if (!n || !isMediaGenNode(n) || n.kind === "remotion")
      return;
    /* 本批已被终止：不要再把节点标成运行中（否则终止后队列复活） */
    if (runBatchStopped(n)) return;
    n.running = true;
    const msg = I18n.t("后端任务进行中（已从锁恢复）…");
    if (n.kind === "music_gen") n.musicStatus = msg;
    else if (n.kind === "yue_gen") n.yueStatus = msg;
    else if (n.kind === "flux3klein_gen") n.flux3kleinStatus = msg;
    else if (n.kind === "qwenimage_gen") n.qwenimageStatus = msg;
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
        /* 后端锁查询本身也可能挂住（IPC 无回执）：8s 没回就当失联，否则这个节点会
           永远停在「处理中」，而运行队列里没有任何别的证据能戳穿它（用户报的假运行）。 */
        const cur = await Promise.race([
          fn(),
          new Promise((res) => setTimeout(() => res(null), 8000)),
        ]);
        if (!cur || !cur.lock || cur.lock.nodeId !== n.id) {
          stopMediaGenRestoreWatch(n.id);
          n.running = false;
          const done = I18n.t("任务已结束");
          if (n.kind === "music_gen") n.musicStatus = done;
          else if (n.kind === "yue_gen") n.yueStatus = done;
          else if (n.kind === "flux3klein_gen") n.flux3kleinStatus = done;
          else if (n.kind === "qwenimage_gen") n.qwenimageStatus = done;
          else n.videoStatus = done;
          renderCanvas();
          updateRunQueuePanel();
        }
      } catch {
        stopMediaGenRestoreWatch(n.id);
        /* 轮询已经没了，running 就必须跟着收：否则节点永久停在「处理中」，
           而这时运行队列里已没有任何东西能证明它还在跑 —— 正是这一种假运行。 */
        n.running = false;
        renderCanvas();
        updateRunQueuePanel();
      }
    }, 3000);
    mediaGenRestoreTimers.set(n.id, poll);
    /* 从后端锁恢复出「在途生成」：这条也要出现在运行队列里 */
    updateRunQueuePanel();
  } catch {}
}

function videoGenSlotValue(node, slot) {
  /* slot = 数据槽号（1 起始，引擎 / 参数表口径）；v5 起连线里存的端口下标 ≡ 槽号（端口 0 = 控制输入） */
  const port = videoGenPortOfSlot(slot);
  const w = wiresTo(node.id).find((x) => Number(x.toIndex) === port);
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

/** 「↩ 上一段视频」衔接端子的**数据槽号**（1 起始；未开衔接 = 0）。
 *  ⚠ 槽号按模式分，绝不能写死：FL2VA 紧跟首 / 末帧 → 槽 4；R2V 排在参考图 / 参考视频 /
 *  参考音频三组全之后 → 槽 17（写死 4 在 R2V 下取到的就是提示词槽）。
 *  真源在 app.js 的 videoGenChainSlotIndex；拿不到真源时按 meta.key === "chain" 反查一次，
 *  桩环境（只抽部分函数的冒烟沙箱）里也不会静默取错端子。 */
function videoGenChainSlot(node) {
  if (typeof videoGenChainSlotIndex === "function") {
    const i = videoGenChainSlotIndex(node);
    if (i) return i;
  }
  if (typeof videoGenMaxChains === "function" && videoGenMaxChains(node) !== 1) return 0;
  if (typeof videoGenSlotMeta !== "function" || typeof videoGenDataSlotsTotal !== "function") return 0;
  const total = videoGenDataSlotsTotal(node);
  for (let i = 1; i <= total; i++) {
    const meta = videoGenSlotMeta(node, i);
    if (meta && meta.key === "chain") return i;
  }
  return 0;
}

/** 分段衔接：取「↩ 上一段视频」端子的本机绝对路径（走 videoGenSlotValue 的媒体归一）。
 *  内置 FL2VA 与 R2V 且开关打开时才有这个槽（端子布局见 videoGenMaxChains），
 *  未开 / 未接 → 返回 null（下发空串 = 后端不加衔接子图，默认零回归）。 */
function videoGenChainValue(node) {
  const slot = videoGenChainSlot(node);
  if (!slot) return null;
  const v = videoGenSlotValue(node, slot);
  if (!v) return null;
  const p = String(v.path || v.text || "").trim();
  return p ? p : null;
}

/** R2V 衔接占用的是**第几路参考视频**（1 起始，与宿主 h3/main-h3.js 的注入位一一对应）：
 *  参考视频没连满 3 路 → 接在最后一条之后；连满 → 顶掉最后一路 V3（宿主同规则并落日志）。 */
function videoGenChainRefIndex(node, refVideoCount) {
  const max = Math.max(1, (typeof videoGenMaxVideos === "function" ? Number(videoGenMaxVideos(node)) : 0) || 3);
  const n = Math.max(0, Number(refVideoCount) || 0);
  return Math.min(n + 1, max);
}

/** 节点字段 chainMention（默认开）：只有显式 false 才关 —— 老画布没这个字段也照默认走。 */
function videoGenChainMentionOn(node) {
  return !node || node.chainMention !== false;
}

/** 自动补进提示词的续写声明（官方 ref 规范里 <Video N> 的语义本就含 video continuation /
 *  续写起点）：R2V 没有 first_frame，光把上一段末 N 帧接进去还不够，得明确告诉模型按那一路续写。 */
function videoGenChainMentionText(refIndex) {
  return (
    "Continue seamlessly from <Video " +
    Math.max(1, Number(refIndex) || 1) +
    "> as the starting point; keep subjects, scene and camera continuity."
  );
}

/** 节点摘要 / 状态行用的衔接标注：未开衔接返回空串（不改变原有文案）。 */
function videoGenChainTag(node) {
  if (videoGenMaxChains(node) !== 1) return "";
  const rawF = node.chainFrames;
  const f =
    rawF != null && Number.isFinite(Number(rawF)) && Number(rawF) > 0
      ? Math.min(60, Math.round(Number(rawF)))
      : 22;
  const rawD = node.chainDenoise;
  const d =
    rawD != null && Number.isFinite(Number(rawD))
      ? Math.min(1, Math.max(0, Number(rawD)))
      : 1;
  return "↩ " + I18n.t("衔接") + " " + f + " " + I18n.t("帧") + " · " + I18n.t("重绘") + " " + d;
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
 *  （时长 / 分辨率 / 后处理等内置专属字段一概不下发）。
 *
 *  ⚠ 下发 id 口径（宿主 h3/main-h3.js 的 resolveCustomWorkflowId 与之成对，改一处必改另一处）：
 *   · customWorkflowId —— 节点上选的 **H3 自建工作流库 id**，空 = 内置 FL2VA / R2V 链。
 *     宿主只认这个键分叉。
 *   · canvasWorkflowId —— 当前**画布** id，仅进全局媒体互斥锁做归因 / 展示，永不参与分叉。
 *   早先两者挤在同一个 `workflowId` 键上：内置链把画布 id（形如 wf_mtjt9bmr）发了过去，
 *   宿主见非空即判自建，于是内置视频生成必报「工作流不存在（id=wf_…）」。 */
function buildVideoGenRunParams(node, ctx) {
  const exp = ctx.exp || {};
  /* 托管（输出接保存节点、节点自己没配路径）：不下发 outputDir / filename，
     命名与落盘交给宿主托管兜底，回执里的绝对路径只进 node.output。 */
  const outParams = exp.managed ? {} : { outputDir: exp.outputDir, filename: exp.filename };
  const canvasId = (S.wf && S.wf.id) || "";
  if (isCustomVideoGen(node)) {
    return {
      nodeId: ctx.nodeId,
      customWorkflowId: String(node.workflowId || "").trim(),
      canvasWorkflowId: canvasId,
      wfParams: Array.isArray(node.wfParams) ? node.wfParams : [],
      wfParamValues: collectVideoGenWfValues(node),
      customOutputNodeId: String(node.customOutputNodeId || ""),
      seed: ctx.seed,
      ...outParams,
    };
  }
  return {
    nodeId: ctx.nodeId,
    customWorkflowId: "",
    canvasWorkflowId: canvasId,
    mode: ctx.mode,
    prompt: ctx.prompt,
    firstImage: ctx.firstImage || "",
    lastImage: ctx.lastImage || "",
    /* 分段衔接（内置 FL2VA / R2V 通用，自建分支不下发 —— 见上面的 isCustomVideoGen 早退）：
       chainVideoPath = 上一段成片绝对路径（空 = 不加衔接子图）；chainFrames = 引导帧数；
       chainDenoise = 重绘幅度（1 = 沿用全局 denoise；<1 = 引导加重绘，0 = 纯引导）。
       FL2VA 下宿主取它的末帧当 first_frame 锚；R2V 下它直接充当一路参考视频（<Video N> 续写）。 */
    chainVideoPath: ctx.chainVideoPath || "",
    chainFrames:
      node.chainFrames != null && Number.isFinite(Number(node.chainFrames)) && Number(node.chainFrames) > 0
        ? Math.min(60, Math.round(Number(node.chainFrames)))
        : 22,
    chainDenoise:
      node.chainDenoise != null && Number.isFinite(Number(node.chainDenoise))
        ? Math.min(1, Math.max(0, Number(node.chainDenoise)))
        : 1,
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
    easyReuse: node.easyReuse != null ? Number(node.easyReuse) : 0.08,
    easyStart: node.easyStart != null ? Number(node.easyStart) : 0.30,
    easyEnd: node.easyEnd != null ? Number(node.easyEnd) : 0.90,
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
    /* 超分 / 补帧已拆成独立后处理节点（h3:postProcess）：生成链不再下发 post*；
       老画布残留的 postEnabled / postInterp / postInterpMultiplier / postPerBatch
       键只忽略、不报错（宿主生成流程也已不再读取它们）。 */
    refImageSize: node.refImageSize || "match",
    outputRes: node.outputRes || "auto",
    fps: Number(node.fps) || 24,
    bitDepth: Number(node.bitDepth) || 8,
    videoFormat: node.videoFormat || "auto",
    videoCodec: node.videoCodec || "auto",
    filenamePrefix: node.filenamePrefix || "video/MiniMax_H3",
    ...outParams,
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

/** 参考素材跑前预检（R2V 参考图 / 参考视频 / 参考音频三组端子；slot 1 起 1=提示词）。
 *  端口上**占着线却取不到值**的槽 = 这次请求会少带一份参考素材：素材节点的内容要经一次
 *  IPC 才拿得到绝对路径，没就位时 videoGenSlotValue 与「这个槽是空的」返回同一个 null，
 *  收集循环原本静默跳过 —— 用户看到的是「加了参考音频后参考图完全失效」（图根本没进图）。
 *  这里先把占线素材条目的内容等到位（在飞的读取等它，**上次读失败留下的 missing 缓存强制重读一次**），
 *  再复判一遍：文件补回来 / 素材库换过根目录之后，不该因为一条过期的失败缓存就永远报「取不到」。
 *  读不到只在状态行如实报出来，**不拦截运行**（由用户决定是否照跑）。 */
async function videoGenRefSlotsPreflight(node) {
  const typeOf = (slot) => {
    const meta = videoGenSlotMeta(node, slot);
    return meta && meta.kind ? String(meta.kind) : "";
  };
  const maxImg = videoGenMaxImages(node);
  const maxVid = videoGenMaxVideos(node);
  const maxAud = videoGenMaxAudios(node);
  const slots = [];
  for (let i = 0; i < maxImg; i++) slots.push(2 + i);
  for (let i = 0; i < maxVid; i++) slots.push(2 + maxImg + i);
  for (let i = 0; i < maxAud; i++) slots.push(2 + maxImg + maxVid + i);
  const occupied = new Set(
    allWiresTo(node.id)
      .filter((w) => !wireFromIsControl(w))
      .map((w) => Number(w.toIndex) || 0),
  );
  const pending = slots.filter((slot) => {
    const v = videoGenSlotValue(node, slot);
    if (v && (v.path || v.text)) return false;
    return occupied.has(videoGenPortOfSlot(slot));
  });
  if (!pending.length) return [];
  /* 把占线槽的来源节点（素材节点）内容读齐：文案「有线却取不到值」的两种成因
     （读取还在飞 / 读失败）都在这一步判掉。来源不是素材节点时不产生 IPC；
     **同一个素材节点只处理一次**（同一节点可能占多个槽，重复读只会多打 IPC）。 */
  const seen = new Set();
  const sources = [];
  const sourceOfSlot = new Map();
  for (const slot of pending) {
    const port = videoGenPortOfSlot(slot);
    const w = allWiresTo(node.id).find((x) => Number(x.toIndex) === port);
    const src = w ? nodeById(w.from) : null;
    sourceOfSlot.set(slot, src);
    if (!src || !isAssetNode(src) || seen.has(src.id)) continue;
    seen.add(src.id);
    sources.push(src);
  }
  /** 该槽的来源素材节点此刻是否还在等库内容（读取在飞 / 缓存还是 loading）。 */
  const stillLoading = (slot) => {
    const src = sourceOfSlot.get(slot);
    if (!src || !isAssetNode(src)) return false;
    const aid = String(src.assetId || "").trim();
    if (!aid) return false;
    for (const it of assetItems(src)) {
      const iid = String(it.id || "").trim();
      if (!iid) continue;
      const c = typeof assetItemViewGet === "function" ? assetItemViewGet(aid, iid) : null;
      if (!c || c.loading) return true;
    }
    return false;
  };
  /** 一条素材条目的内容在飞：等它。 */
  const awaitItem = async (aid, iid) => {
    try {
      await assetItemViewLoaded(aid, iid);
    } catch {}
  };
  /** 重读一遍（**不顶掉在飞的那次**：顶掉它只会让 await 落空，回头还是拿不到值）。 */
  const reloadItem = async (aid, iid) => {
    const c = typeof assetItemViewGet === "function" ? assetItemViewGet(aid, iid) : null;
    if (c && c.loading) return awaitItem(aid, iid);
    if (c && c.missing && typeof assetItemViewInvalidate === "function")
      assetItemViewInvalidate(aid, iid);
    return awaitItem(aid, iid);
  };
  await Promise.all(
    sources.map((src) =>
      (async () => {
        const aid = String(src.assetId || "").trim();
        if (!aid || typeof assetItemViewLoaded !== "function") return;
        const keys = new Set();
        for (const it of assetItems(src)) {
          const iid = String(it.id || "").trim();
          if (!iid || keys.has(aid + "|" + iid)) continue;
          keys.add(aid + "|" + iid);
          const cached = assetItemViewGet(aid, iid);
          if (cached && !cached.missing && !cached.loading) continue;
          /* 读取失败留下的 missing 缓存要被顶掉重读（文件补回来 / 换过素材库根目录之后，
             不该因为一条过期的失败缓存就永远报「取不到」）。**在飞的那次不动**：
             顶掉它只会让下面这次 await 落空，回头还是拿不到值。 */
          if (cached && cached.missing && !cached.loading && typeof assetItemViewInvalidate === "function")
            assetItemViewInvalidate(aid, iid);
          await awaitItem(aid, iid);
        }
      })(),
    ),
  ).catch(() => {});
  /* 收尾复判：第一次「取不到」还可能是**上一刻刚到货、这一拍才落进缓存**的那一拍延迟
     （等的是上一次读取，值却在下一次刷新才可见）。确认还在飞的先等它，再复判；
     确认已经读到内容的就是真取不到，不再空等。 */
  const rest = pending.filter((slot) => {
    const v = videoGenSlotValue(node, slot);
    if (v && (v.path || v.text)) return false;
    if (stillLoading(slot)) return true;
    const src = sourceOfSlot.get(slot);
    if (src && isAssetNode(src)) {
      const aid = String(src.assetId || "").trim();
      for (const it of assetItems(src)) {
        const iid = String(it.id || "").trim();
        if (iid) reloadItem(aid, iid).catch(() => {});
      }
    }
    return false;
  });
  if (rest.length) {
    for (const src of sources) {
      const aid = String(src.assetId || "").trim();
      if (!aid) continue;
      for (const it of assetItems(src)) {
        const iid = String(it.id || "").trim();
        if (iid) await awaitItem(aid, iid);
      }
    }
  }
  const out = [];
  for (const slot of pending) {
    const v = videoGenSlotValue(node, slot);
    if (v && (v.path || v.text)) continue;
    const meta = videoGenSlotMeta(node, slot);
    out.push({
      slot,
      kind: typeOf(slot),
      label: (meta && meta.label) || I18n.t("槽 ") + slot,
    });
  }
  return out;
}
/** 预检结论 → 状态行文案（有缺就用；没有返回空串）。 */
function videoGenRefSlotsWarning(missing) {
  if (!missing || !missing.length) return "";
  const names = missing
    .map((m) => `${m.label}（${I18n.t(m.kind === "video" ? "参考视频" : m.kind === "audio" ? "参考音频" : "参考图")}）`)
    .join("、");
  return I18n.t("参考素材取不到内容，本次不会带上：") + names + " —— " + I18n.t("该端子上有连线但没取到值（素材库未就绪 / 条目文件缺失），请检查后再跑");
}

/** 显存预检被拦（宿主回 error="vram_insufficient"）→ 弹 MTNode 确认窗，用户点「仍然执行」
 *  才把同一份参数带 forceVram 重发一次。豁免只对本次这一跑生效：不写配置、不改用户任何参数。
 *  runOnce(forceVram) 负责组装并发出请求（生成 / 后处理各自一份）。 */
async function withVramConfirm(runOnce) {
  const r = await runOnce(false);
  if (!r || r.ok || r.error !== "vram_insufficient") return r;
  const msg = String(r.message || "").trim() || I18n.t("显存不足，本次没有开始执行。");
  const go = await confirmDialog(msg, {
    title: I18n.t("显存不足"),
    okText: I18n.t("仍然执行"),
    cancelText: I18n.t("先不跑"),
    danger: true,
  });
  if (!go) return r;
  return await runOnce(true);
}

/* 视频生成 / 视频后处理报错 → 右下角红色提示（用户需求：显存不足或任何类型的报错都要弹）。
   与其它媒体节点的差别只有一处：**不受 quiet 抑制**。quiet 是「内部驱动」的静默口径
   （运行本层 / 控制流 / 级联），这些路径下节点本体那行内联报错用户看不到，
   失败就只剩运行队列里悄悄少一行；而视频是最贵的一跑，失败必须看得见。
   同一句话 6 秒内只弹一次：批量里 N 颗节点一起 OOM 时不许把右下角糊满。 */
const videoErrorToastAt = new Map();
function videoErrorToast(node, msg) {
  let text = String(msg || "").replace(/\s+/g, " ").trim();
  if (!text) return;
  if (text.length > 420) text = text.slice(0, 420) + "…";
  const title = node && node.title ? String(node.title).trim() : "";
  const line = (title ? title + "：" : "") + text;
  const now = Date.now();
  const prev = videoErrorToastAt.get(line);
  if (prev && now - prev < 6000) return;
  videoErrorToastAt.set(line, now);
  if (videoErrorToastAt.size > 60) {
    for (const [k, t] of videoErrorToastAt) if (now - t > 6000) videoErrorToastAt.delete(k);
  }
  toast(line, "err");
}

async function playVideoGenNode(node, quiet) {
  if (!window.api || !window.api.h3Generate) {
    toast(I18n.t("视频生成插件未就绪"), "err");
    return;
  }
  /* 串行链出队后由 mediaRunPrestart 先点亮了运行态（显存预释放那段也算本次运行）：放行这一次交接 */
  if (node.running && !node._prestart) return;
  /* 同音乐节点：被终止过的节点不得再起跑 */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }

  try {
    const lock = await fetchMediaGenLock();
    if (lock && lock.nodeId && lock.nodeId !== node.id) {
      node.error = mediaGenLockBusyMsg(lock);
      node._busyErrAt = Date.now(); /* 见 app.js sweepStaleMediaBusyErrors：新报的别当场扫掉 */
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
  /* 参考素材跑前预检（详见 videoGenRefSlotsPreflight）：把占线素材条目的内容请到位再取值，
     仍取不到的明确报出来 —— 不再让「端口上有线、值却是 null」静默变成一张没有参考图的请求。 */
  const refMissing =
    mode === "r2v" ? await videoGenRefSlotsPreflight(node) : [];
  const refWarn = videoGenRefSlotsWarning(refMissing);
  if (refWarn) {
    node.videoStatus = refWarn;
    if (!quiet) toast(refWarn, "warn");
    renderCanvas();
  }
  const maxImg = videoGenMaxImages(node);
  const maxVid = videoGenMaxVideos(node);
  const maxAud = videoGenMaxAudios(node);
  const firstImage = mode === "fl2va" ? ((videoGenSlotValue(node, 2) || {}).path || "") : "";
  const lastImage = mode === "fl2va" ? ((videoGenSlotValue(node, 3) || {}).path || "") : "";
  /* 分段衔接：FL2VA / R2V 两种内置模式都有这个槽（自建工作流端子由工作流决定，不加）。
     槽号由 videoGenChainSlot 按模式反查（FL2VA 槽 4 · R2V 槽 17），未接 → 空串（后端不加衔接子图）。 */
  const chainTag = videoGenChainTag(node);
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
  const chainVideoPath = videoGenChainValue(node) || "";
  /* R2V 衔接 = 上一段末尾 N 帧占一路参考视频：占了第几路（V1/V2/V3）要在状态行说清楚，
     连满 3 路时宿主顶掉的是 V3 —— 与 h3/main-h3.js 的注入位同一套算法。 */
  const chainRefIndex = mode === "r2v" && chainVideoPath ? videoGenChainRefIndex(node, refVideos.length) : 0;
  const chainStatus = chainTag
    ? chainRefIndex
      ? chainTag + " · " + I18n.t("占用参考视频") + " V" + chainRefIndex
      : chainTag
    : "";
  if (chainStatus || refWarn)
    node.videoStatus =
      (chainStatus ? chainStatus + " · " : "") +
      (refWarn ? refWarn + " · " : "") +
      I18n.t("启动后端并生成…");
  /* R2V 提示词自动补一句官方口径的续写声明（节点字段 chainMention，默认开）：
     没有 first_frame 可靠，模型必须被告知按那一路 <Video N> 续写，否则衔接只体现在像素上、
     运镜与主体动作会各自重来。FL2VA 不补（那边有 first_frame 锚定，语义已由端子表达）。 */
  const runPrompt =
    chainRefIndex && videoGenChainMentionOn(node)
      ? prompt + "\n\n" + videoGenChainMentionText(chainRefIndex)
      : prompt;

  const t0 = Date.now();
  let okCount = 0;
  let lastPath = "";
  let managedRun = false;

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
      if (exp.managed) managedRun = true;
      const seed = nextMediaGenSeed(node);
      {
        const ui = ensureBackendUiState(node);
        ui.genPct = Math.max(2, ui.genPct || 2);
        ui.genMsg =
          (chainStatus ? chainStatus + " · " : "") +
          mediaGenRollProgressTag(node) +
          (nRolls > 1 ? I18n.t("生成中…") : I18n.t("启动后端并生成…"));
        node.videoStatus = ui.genMsg;
      }
      node.genRollDone = roll - 1;
      refreshMediaNodeUi(node, { soft: true });

      const r = await withVramConfirm((forceVram) => {
        const params = buildVideoGenRunParams(node, {
          nodeId: node.id,
          seed,
          mode,
          prompt: runPrompt,
          firstImage,
          lastImage,
          chainVideoPath,
          refImages,
          refVideos,
          refAudios,
          exp,
        });
        if (forceVram) params.forceVram = true;
        return window.api.h3Generate(params);
      });
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
          node._busyErrAt = Date.now();
        } else if (String(err) === "cancelled") {
          node.error = null;
          node.videoStatus = I18n.t("已取消");
          return;
        } else {
          node.error = String(err);
        }
        node.videoStatus = node.error;
        if (looksLikeBackendConnError(err)) markMediaBackendDown(node);
        videoErrorToast(node, node.error);
        return;
      }
      okCount++;
      lastPath = String(r.path || "");
      if (lastPath) node.genPaths.push(lastPath);
      node.output = { kind: "video", path: lastPath, text: lastPath };
      node.ranAt = Date.now();
      /* 托管：宿主回传的绝对路径只进 node.output（下游保存节点取它落盘），
         绝不写回节点自己的 outputPath 配置 —— 一写就退回「已配路径」口径。 */
      if (lastPath && nRolls === 1 && !exp.managed) syncMediaGenPathFromExport(node, lastPath);
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
    const doneLine =
      (chainStatus ? chainStatus + " · " : "") +
      doneMsg +
      mediaGenManagedTag(managedRun) +
      /* 缺参考素材的警告一路带到收尾状态行：提示 toast 一闪而过，成品旁边必须留得住 */
      (refWarn ? " · " + refWarn : "");
    node.videoStatus = doneLine;
    {
      const ui = ensureBackendUiState(node);
      ui.genPct = 100;
      ui.genMsg = doneLine;
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
      videoErrorToast(node, node.error);
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

/* ── 视频后处理节点（video_upscale / video_interp）执行体 ─────────────────
   超分 / 补帧不再内联在 H3 生成里：本执行体把「源视频（端口 1）」交给宿主
   独立的 h3:postProcess（kind=upscale 走 Real-ESRGAN x4 + 目标长边缩放；
   kind=interp 走 RIFE 补帧、fps 按倍数重算），结果写
   node.output={kind:'video',path} 供下游保存 / 继续串联。
   与 video_gen 同一套：全局媒体互斥锁、串行排队、进度 / 取消 / 后端探活、
   抽卡次数（多次输出 #1、#2…）、输出路径解析与产物落 node.output。
   24G 安全档由宿主 resolvePostOptions 兜底，首次 OOM 宿主自动降一档重试一次。 */

/* 源视频端口取值：媒体值 / 路径文本 / 上游展示值统一收敛成本机绝对路径。
   外层包 withOwningWf：跨画布跑本层 / 后台批次时 S.wf 不是节点所在的图，
   按 S.wf 找线会一条都找不到（现场：整片报「请连接源视频输入（端子 V）」）。 */
function videoPostSlotValue(node, slot) {
  return withOwningWf(node, () => videoPostSlotValueIn(node, slot));
}
function videoPostSlotValueIn(node, slot) {
  const w = wiresTo(node.id).find(
    (x) => Number(x.toIndex) === Number(slot) && !wireFromIsControl(x),
  );
  if (!w) return null;
  const src = nodeById(w.from);
  if (!src) return null;
  const v = valueFromWire(w, node, 0);
  if (v && v.kind === "image") return null; /* 源视频端子不吃图像 */
  if (v && (v.kind === "video" || v.kind === "audio"))
    return { path: pathFromMediaValue(v) };
  if (v && v.kind === "text") {
    const t = String(v.text || "").trim();
    return t ? { path: pathFromMediaValue(t) } : null;
  }
  if (v && v.path) return { path: pathFromMediaValue(v) };
  if (v && v.text) {
    const t = String(v.text).trim();
    if (t) return { path: pathFromMediaValue(t) };
  }
  const d = displayValueOf(src, node);
  if (d && d.text != null) {
    const t = String(d.text).trim();
    if (t) return { path: pathFromMediaValue(t) };
  }
  if (d && d.image) return { path: String(d.image) };
  return null;
}

/** 源视频端子上接着的那颗上游（没接线 → null）。
 *  用途：把「真的没接线」和「接了线但上游还没产出」分成两句话 ——
 *  后者旧写法一律报「请连接源视频输入」，用户看到的像是「视频源未连接」，
 *  可线明明连着、重跑一次又好了（批量执行 H3 视频时的现场）。 */
function videoPostSourceNode(node, slot) {
  return withOwningWf(node, () => videoPostSourceNodeIn(node, slot));
}
function videoPostSourceNodeIn(node, slot) {
  const w = wiresTo(node.id).find(
    (x) => Number(x.toIndex) === Number(slot) && !wireFromIsControl(x),
  );
  return w ? nodeById(w.from) || null : null;
}

/* 输出路径解析：与 requireMediaGenExport 同款口径，但状态行写后处理节点的 videoStatus
   （通用实现只认 music/video_gen/remotion 三种 kind，这里不重复那三支）。
   managed（节点没配路径、数据输出接了保存节点 → 路径归保存节点管）同样是「有归宿」：
   与 requireMediaGenExport 一样放行，不报错、不写错误状态行。 */
function requireVideoPostExport(node, quiet) {
  const exp = resolveMediaGenExport(node);
  if (exp && (exp.ok || exp.managed)) return exp;
  const msg = savePathResolveError(exp && exp.code);
  if (!quiet) toast(msg, "warn");
  if (node) node.videoStatus = msg;
  return null;
}

/* 源视频元数据（宽 / 高 / 帧率 / 时长）：渲染层离屏 <video> 读。
   超分要靠分辨率才执行「缩放到目标长边」；补帧要靠 fps 重算输出帧率。
   取不到一律回 0，宿主按 24fps、跳过目标长边缩放保守处理，绝不因此中断任务。 */
function probeVideoSourceMeta(path) {
  return new Promise((resolve) => {
    const out = { width: 0, height: 0, fps: 0, duration: 0 };
    const src = String(path || "").trim();
    if (!src || !window.api || !window.api.toFileUrl) return resolve(out);
    let v = null;
    let done = false;
    let timer = null;
    let frames = 0;
    let base = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        v.pause();
      } catch (_) {}
      try {
        v.removeAttribute("src");
        v.load();
      } catch (_) {}
      try {
        v.remove();
      } catch (_) {}
      resolve(out);
    };
    try {
      v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      /* 必须挂进文档、且不透明才会真的解码出帧（离屏到屏幕外、2px 大，
         不遮挡也不接收指针；用 opacity:0 会被合成器跳过 → 取不到帧率） */
      v.style.cssText =
        "position:fixed;left:-10000px;top:0;width:2px;height:2px;pointer-events:none";
      v.addEventListener("loadedmetadata", () => {
        out.width = Number(v.videoWidth) || 0;
        out.height = Number(v.videoHeight) || 0;
        out.duration = isFinite(v.duration) ? Number(v.duration) : 0;
      });
      v.addEventListener("error", finish);
      v.src = String(window.api.toFileUrl(src) || "");
      if (!v.src) {
        finish();
        return;
      }
      document.body.appendChild(v);
      /* 上限：无论哪条路径，2.5s 内一定收摊（只拿到分辨率也算有收获） */
      timer = setTimeout(finish, 2500);
      const rvfc =
        typeof v.requestVideoFrameCallback === "function"
          ? v.requestVideoFrameCallback.bind(v)
          : null;
      if (!rvfc) {
        v.addEventListener("loadedmetadata", () => setTimeout(finish, 80));
        return;
      }
      const tick = (_now, meta) => {
        if (done) return;
        const t = Number(meta && meta.mediaTime);
        const f = Number(meta && meta.presentedFrames);
        frames++;
        const fc = isFinite(f) ? f : frames;
        if (!base) base = { t, f: fc };
        else {
          const dt = t - base.t;
          const df = fc - base.f;
          if (dt >= 0.2 && df > 0) {
            out.fps = Math.max(1, Math.min(240, Math.round(df / dt)));
            finish();
            return;
          }
        }
        rvfc(tick);
      };
      v.play()
        .then(() => rvfc(tick))
        .catch(() => v.addEventListener("loadedmetadata", () => setTimeout(finish, 80)));
    } catch (_) {
      finish();
    }
  });
}

/* 组装 h3:postProcess 参数：kind 由节点类型决定；超分 / 补帧各自一组选项，
   未设的走低显存安全档默认值（宿主 resolvePostOptions 再兜一层）。
   超分默认下发 engine='stream'（逐帧分块流式，内存与时长无关）；补帧默认同样
   engine='stream'（逐帧流式补帧，内存只与相邻两帧有关，与时长无关）；宿主缺脚本 / venv
   （补帧还要求 RIFE 权重在）或流式非 OOM 失败时会自行回退旧 ComfyUI 图链，前端不需要再切档。
   tile / precision 透传给流式链：tile 沿用节点值（0 = 宿主默认 512）；
   precision 只在节点显式存了 fp16 / fp32 时才下发，留空让宿主按 lowVram / 显存自行决定。 */
function buildVideoPostRunParams(node, ctx) {
  const c = ctx || {};
  const exp = c.exp || {};
  /* 托管（输出接保存节点、节点自己没配路径）：不下发 outputDir / filename，
     命名与落盘交给宿主托管兜底，回执里的绝对路径只进 node.output。 */
  const outParams = exp.managed ? {} : { outputDir: exp.outputDir, filename: exp.filename };
  return {
    nodeId: node.id,
    kind: node.kind === "video_interp" ? "interp" : "upscale",
    canvasWorkflowId: (S.wf && S.wf.id) || "",
    sourcePath: String(c.sourcePath || ""),
    fps: Number(c.fps) || 24,
    bitDepth: Number(node.bitDepth) || 8,
    videoFormat: "auto",
    videoCodec: "auto",
    /* 分辨率缺失（探测失败）时宿主跳过「缩放到目标长边」，只出 x4 原始尺寸 */
    sourceWidth: Number(c.width) || 0,
    sourceHeight: Number(c.height) || 0,
    ...outParams,
    upscale: {
      model: videoUpscaleModelValue(node.model),
      /* 倍率 2 / 4：2 = 输出只放大 2 倍（宿主会顺手用本机的 x2 权重，没有就 x4 + 输出端缩回来） */
      scale: Number(node.scale) === 2 ? 2 : 4,
      targetLongSide: Number(node.targetLongSide) || 3840,
      perBatch: Number(node.perBatch) || 1,
      tile: Number(node.tile) || 0,
      /* 流式 / 图选路：默认逐帧分块流式；显式 graph 才走旧 ComfyUI 图链 */
      engine: node.engine === "graph" ? "graph" : "stream",
      /* 只透传节点显式存过的精度，空串表示「交给宿主按 lowVram / 显存决定」 */
      precision: node.precision === "fp16" || node.precision === "fp32" ? node.precision : "",
      lowVram: node.lowVram !== false,
    },
    interp: {
      multiplier: Number(node.multiplier) || 2,
      clearCacheEvery: Number(node.clearCacheEvery) || 2,
      batchSize: Number(node.batchSize) || 1,
      scaleFactor: node.scaleFactor != null ? Number(node.scaleFactor) : 1.0,
      /* 流式 / 图选路：默认逐帧流式补帧（内存与时长无关）；显式 graph 才走旧 ComfyUI 图链 */
      engine: node.engine === "graph" ? "graph" : "stream",
      /* 只透传节点显式存过的精度，空串表示「交给宿主按 lowVram / 显存决定」 */
      precision: node.precision === "fp16" || node.precision === "fp32" ? node.precision : "",
      lowVram: node.lowVram !== false,
    },
  };
}

async function playVideoPostNode(node, quiet) {
  if (!window.api || !window.api.h3PostProcess) {
    toast(I18n.t("视频生成插件未就绪"), "err");
    return;
  }
  /* 串行链出队后由 mediaRunPrestart 先点亮了运行态（显存预释放那段也算本次运行）：放行这一次交接 */
  if (node.running && !node._prestart) return;
  /* 同 video_gen：被终止过的节点不得再起跑 */
  if (mediaRunStopped(node)) {
    mediaGenMarkDropped(node, false);
    return;
  }

  const kind = node.kind === "video_interp" ? "interp" : "upscale";
  const label = kind === "interp" ? I18n.t("视频补帧") : I18n.t("视频超分");
  const srcVal = videoPostSlotValue(node, 1);
  const sourcePath = String((srcVal && srcVal.path) || "").trim();
  if (!sourcePath) {
    /* 取不到值分两种：① 端子上根本没有线；② 有线但上游这一刻还没产出
       （批量执行 H3 视频时很常见：视频节点还在生成 / 排队，后处理已经排到了）。
       旧写法把两者都报成「请连接源视频输入」，用户只看到「视频源未连接」，
       实际线是通的、重跑一次又能跑 —— 现在按真实原因分别说明。 */
    const up = videoPostSourceNode(node, 1);
    if (!up) {
      /* 真没接线（或源头节点已不在画布上）：只写状态行，静默（本层 / 后台批次里
         一颗一颗弹 toast 会把屏幕刷满，用户看到的正是「大量出现」的那一片）。 */
      const msg = I18n.t("请连接源视频输入（端子 V）");
      node.videoStatus = msg;
      renderCanvas();
      if (!quiet) toast(msg, "warn");
      return;
    }
    const upName = up.title || up.kind || I18n.t("上游节点");
    const upBusy = !!(
      up.running ||
      (typeof isNodePending === "function" && isNodePending(up)) ||
      (typeof mediaGenQueueHolds === "function" && mediaGenQueueHolds(up.id))
    );
    const upErr = String(up.error || "").trim();
    const msg = upBusy
      ? I18n.t(
          "源视频还没产出：上游「{name}」正在生成 / 排队，等它跑完再执行本节点（端子是连着线的，不是未连接）",
          { name: upName },
        )
      : upErr
        ? I18n.t("源视频没有产出：上游「{name}」失败了（{why}）。先修好上游再重跑本节点", {
            name: upName,
            why: upErr,
          })
        : I18n.t(
            "源视频还没产出：上游「{name}」还没有输出视频。先执行上游，或重新执行本节点",
            { name: upName },
          );
    /* 只写媒体状态行、不写 node.error：这一颗是「还没轮到源视频」而不是执行失败，
       写 error 会让「运行本层」把整层当成真报错终止（旧行为只是记一条空产出、继续跑）。 */
    node.videoStatus = msg;
    renderCanvas();
    if (!quiet) toast(msg, "warn");
    return;
  }

  try {
    const lock = await fetchMediaGenLock();
    if (lock && lock.nodeId && lock.nodeId !== node.id) {
      node.error = mediaGenLockBusyMsg(lock);
      node._busyErrAt = Date.now(); /* 见 app.js sweepStaleMediaBusyErrors：新报的别当场扫掉 */
      node.videoStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch {}

  const exp0 = requireVideoPostExport(node, quiet);
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
    ui.genMsg = I18n.t("启动后端并处理…");
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
  node.videoStatus = I18n.t("启动后端并处理…");
  startMediaBackendRunWatcher(node);
  renderCanvas();

  const t0 = Date.now();
  let okCount = 0;
  let lastPath = "";
  let managedRun = false;

  try {
    const meta = await probeVideoSourceMeta(sourcePath);
    for (let roll = 1; roll <= nRolls; roll++) {
      if (mediaRunStopped(node)) break;
      const exp = await prepareMediaGenRollExport(node, roll, nRolls);
      if (!exp || !exp.ok) {
        requireVideoPostExport(node, quiet);
        node.error = savePathResolveError(exp && exp.code);
        node.videoStatus = node.error;
        if (!quiet) toast(node.error, "warn");
        return;
      }
      if (roll === 1 && nRolls === 1 && exp.renamed) {
        syncMediaGenPathFromExport(node, exp);
        if (!quiet) toast(I18n.t("目标文件已存在，改为保存为：") + exp.filename, "ok");
      }
      if (exp.managed) managedRun = true;
      {
        const ui = ensureBackendUiState(node);
        ui.genPct = Math.max(2, ui.genPct || 2);
        ui.genMsg =
          mediaGenRollProgressTag(node) +
          (nRolls > 1 ? I18n.t("处理中…") : I18n.t("启动后端并处理…"));
        node.videoStatus = ui.genMsg;
      }
      node.genRollDone = roll - 1;
      refreshMediaNodeUi(node, { soft: true });

      const r = await withVramConfirm((forceVram) => {
        const params = buildVideoPostRunParams(node, {
          exp,
          sourcePath,
          fps: meta.fps,
          width: meta.width,
          height: meta.height,
        });
        if (forceVram) params.forceVram = true;
        return window.api.h3PostProcess(params);
      });
      if (node._aborted || (r && (r.error === "cancelled" || r.cancelled))) {
        node.error = null;
        node.videoStatus = I18n.t("已取消");
        const ui = ensureBackendUiState(node);
        ui.genMsg = I18n.t("已取消");
        ui.genPct = 0;
        return;
      }
      if (!r || !r.ok) {
        const err = (r && (r.message || r.error)) || I18n.t("处理失败");
        if (err === "busy_other_node" || (r && r.error === "busy_other_node")) {
          node.error = I18n.t("已有音视频生成任务进行中，已中断本节点（全局仅 1 个，禁止并行）");
          node._busyErrAt = Date.now();
        } else if (String(err) === "cancelled") {
          node.error = null;
          node.videoStatus = I18n.t("已取消");
          return;
        } else {
          node.error = String(err);
        }
        node.videoStatus = node.error;
        if (looksLikeBackendConnError(err)) markMediaBackendDown(node);
        videoErrorToast(node, node.error);
        return;
      }
      okCount++;
      lastPath = String(r.path || "");
      if (lastPath) node.genPaths.push(lastPath);
      node.output = { kind: "video", path: lastPath, text: lastPath };
      node.ranAt = Date.now();
      /* 托管：宿主回传的绝对路径只进 node.output（下游保存节点取它落盘），
         绝不写回节点自己的 outputPath 配置 —— 一写就退回「已配路径」口径。 */
      if (lastPath && nRolls === 1 && !exp.managed) syncMediaGenPathFromExport(node, lastPath);
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
    const doneMsg = mediaGenDoneMsg(Date.now() - t0) + mediaGenManagedTag(managedRun);
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
          ? label + I18n.t(" 完成：") + okCount + "/" + nRolls + I18n.t(" 次")
          : label + I18n.t(" 完成：") + lastPath,
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
      videoErrorToast(node, node.error);
    }
  } finally {
    /* 与 video_gen 同口径：终止后不再驱动下游控制线，成功才触发控制输出端子（端口 1） */
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

/* ── Remotion 视频节点（应用插件 remotion） ──
   两条彻底分开的路（本轮需求）：
   · 构建（用户点「构建」→ 弹窗里填构建需求）：构建 Agent 写出多文件工程 → 静态校验 →
     短试渲染验证 → 固化成节点里的源码树（node.remotionFiles + 端子契约）。
   · 运行（▶ / 上游控制线）：**只走脚本渲染，一个模型都不调** —— 固化工程 / 节点里贴的
     tsxTsx / 复用包内 Composition.tsx / 内置版面（素材与台词由端子注入）。
   节点正文 node.text 是「功能说明」，只给人看，构建与运行都不读它；
   构建需求另存 node.remotionBuildNote（见 remotionOpenBuildDialog / remotionBuildNoteOf）。
   window.api.remotionGenerate（主进程 remotion/main-remotion.js：写模板 → spawn
   node render.mjs → 本地渲染 mp4，取 media-gen-global-lock 全局互斥）→ 进度/取消 → node.output=视频路径。 */

/* Remotion 输出分辨率预设（宽x高，px）定义在 app.js（REMOTION_SIZES，先加载共用）。 */

/* 老路径遗留：内置台词卡版面的**描述关键词**判定。
   运行期不再读任何描述（功能说明 / 构建描述都不参与出片），这个判定已不在调用链上；
   留着只为说明内置版面当初为什么存在，别把它接回去。 */
const REMOTION_BUILTIN_RE =
  /\{\{\s*(hero|narration|voice|bg)\s*\}\}|台词卡|金边|对话屏|台词框|左[^。\n]{0,12}右[^。\n]{0,12}(框|卡|台词)/;

function wantsBuiltinDialoguePage(desc) {
  return REMOTION_BUILTIN_RE.test(String(desc || ""));
}

/* ═══════════ Remotion 固化工程：源码文件树 + 端子契约（唯一真源）═══════════
 * 目标（本节点契约）：构建期由 agent 写出一棵**多文件 React 工程**并把端子契约写在
 * 入口源码里；固化后运行时只把这棵文件树交给主进程渲染，**永不调模型**。
 *
 * 契约写法（入口 Composition.tsx 导出，节点解析后自动生成端子）：
 *   export const inputs = [
 *     { key: "hero",  kind: "image", label: "主图", required: true },
 *     { key: "voice", kind: "audio", label: "旁白" },
 *     { key: "lines", kind: "text",  label: "台词", list: true },
 *     { key: "speed", kind: "number", label: "速度" },
 *   ];
 * kind ∈ image | audio | video | text | number | boolean | json；list:true = 一颗端子可接多路。
 *
 * 为什么契约放在源码里：改代码即改端子，单一真源，固化后还能静态校验
 * （见 remotionStaticCheck），不会出现「端子表与代码各说一套」。
 */

/* 极小的 JS 字面量解析器：只吃对象 / 数组 / 字符串 / 数字 / 布尔 / null / 裸标识符，
 * 够解析契约里的这些字面量，且**绝不 eval 模型生成的内容**（模型可能写坏东西）。
 * 注释、尾逗号、TS 的 `as const` 都在外层先剥掉。 */
function remotionParseLiteral(text) {
  const s = String(text || "");
  let i = 0;
  const err = (m) => {
    throw new Error(m + "（偏移 " + i + "）");
  };
  const ws = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === "/" && s[i + 1] === "/") {
        const nl = s.indexOf("\n", i);
        i = nl < 0 ? s.length : nl + 1;
        continue;
      }
      if (s[i] === "/" && s[i + 1] === "*") {
        const end = s.indexOf("*/", i + 2);
        i = end < 0 ? s.length : end + 2;
        continue;
      }
      return;
    }
  };
  const str = () => {
    const q = s[i++];
    let out = "";
    while (i < s.length) {
      const c = s[i++];
      if (c === q) return out;
      if (c === "\\" && i < s.length) {
        const n = s[i++];
        const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
        if (n === "u") {
          const hex = s.slice(i, i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            continue;
          }
        }
        out += map[n] != null ? map[n] : n;
        continue;
      }
      out += c;
    }
    err("字符串没有收尾引号");
  };
  const ident = () => {
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!m) err("这里应该是一个值");
    i += m[0].length;
    return m[0];
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === undefined) err("值缺失");
    if (c === "{" || c === "[") return container();
    if (c === '"' || c === "'" || c === "`") return str();
    if (c === "-" || c === "+" || /[0-9.]/.test(c)) {
      const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i));
      if (!m) err("数字写法认不出");
      i += m[0].length;
      return Number(m[0]);
    }
    const id = ident();
    if (id === "true") return true;
    if (id === "false") return false;
    if (id === "null" || id === "undefined") return null;
    /* 裸词当字符串（TS 里 kind: image 这种没加引号的写法照样认） */
    return id;
  };
  const container = () => {
    ws();
    const open = s[i++];
    const close = open === "{" ? "}" : "]";
    const out = open === "{" ? {} : [];
    for (;;) {
      ws();
      if (s[i] === close) {
        i++;
        return out;
      }
      if (i >= s.length) err("容器没有收尾");
      if (open === "{") {
        const k =
          s[i] === '"' || s[i] === "'" || s[i] === "`" ? str() : String(ident());
        ws();
        if (s[i] !== ":") err("对象键后面缺少冒号");
        i++;
        out[k] = value();
      } else {
        out.push(value());
      }
      ws();
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === close) {
        i++;
        return out;
      }
      err("容器里缺少逗号或收尾");
    }
  };
  const v = value();
  ws();
  return v;
}

/* 从源码里抠出顶层 `export const inputs = [...]` 的字面量正文（字符串 / 注释感知的括号配对） */
function remotionContractLiteralOf(src) {
  const text = String(src || "");
  const m = /export\s+(?:const|let|var)\s+inputs\b[^=\n]*=/.exec(text);
  if (!m) return "";
  let i = text.indexOf("[", m.index + m[0].length);
  if (i < 0) return "";
  const start = i;
  let depth = 0;
  let quote = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  /* 有 `export const inputs` 但方括号没闭合：null（调用方报「契约语法坏了」），
     与「压根没有契约」的空串区分开 */
  return null;
}

const REMOTION_INPUT_KINDS = ["image", "audio", "video", "text", "number", "boolean", "json"];

/* 契约项归一 → { contract, warnings }
 * 形如 [{key,kind,label,list,required,default}]；认不出的项丢掉并留警告。
 * 两个入口共用：源码里的 `export const inputs`（remotionParseContract）与画布编辑接口
 * 显式传入的 remotionInputs —— 同一份字段口径，别让「写进去的」和「读出来的」不一样。 */
function remotionNormalizeContractInput(arr) {
  const contract = [];
  const warnings = [];
  const seen = new Set();
  for (const raw of Array.isArray(arr) ? arr : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(I18n.t("契约里有一项不是对象，已忽略"));
      continue;
    }
    const key = String(raw.key || "").trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      warnings.push(I18n.t("契约项的 key 不合法（须是标识符）：") + (key || "(空)"));
      continue;
    }
    if (seen.has(key)) {
      warnings.push(I18n.t("契约 key 重复，只保留第一项：") + key);
      continue;
    }
    seen.add(key);
    let kind = String(raw.kind || "text").toLowerCase();
    if (REMOTION_INPUT_KINDS.indexOf(kind) < 0) {
      warnings.push(I18n.t("契约项「") + key + I18n.t("」的 kind 不认识，按 text 处理：") + kind);
      kind = "text";
    }
    contract.push({
      key,
      kind,
      label: String(raw.label || "").trim() || key,
      list: !!raw.list,
      required: !!raw.required,
      ...(raw.default !== undefined ? { default: raw.default } : {}),
    });
  }
  return { contract, warnings };
}

/* 解析契约 → { contract, warnings, error } */
function remotionParseContract(src) {
  const lit = remotionContractLiteralOf(src);
  if (lit === null) return { contract: [], warnings: [], error: I18n.t("inputs 契约的方括号没有闭合") };
  if (!lit) return { contract: [], warnings: [], error: "" };
  let arr;
  try {
    arr = remotionParseLiteral(lit);
  } catch (e) {
    return {
      contract: [],
      warnings: [],
      error: I18n.t("端子契约解析失败：") + ((e && e.message) || String(e)),
    };
  }
  if (!Array.isArray(arr))
    return { contract: [], warnings: [], error: I18n.t("端子契约 inputs 必须是一个数组") };
  const norm = remotionNormalizeContractInput(arr);
  return { contract: norm.contract, warnings: norm.warnings, error: "" };
}

/* 节点上的固化工程：{ files, contract, builtAt, hasSource }
 * 来源优先级：remotionFiles（构建产物 / 多文件） > tsxTsx（老的直出单文件） */
function remotionProjectOf(node) {
  const n = node || {};
  const files = n.remotionFiles;
  if (files && typeof files === "object" && String(files["Composition.tsx"] || "").trim()) {
    const contract = Array.isArray(n.remotionInputs) && n.remotionInputs.length
      ? n.remotionInputs
      : remotionParseContract(files["Composition.tsx"]).contract;
    return { files, contract, builtAt: Number(n.remotionBuiltAt) || 0, hasSource: true };
  }
  const one = String(n.tsxTsx || "").trim();
  if (one) {
    return {
      files: { "Composition.tsx": one },
      contract: remotionParseContract(one).contract,
      builtAt: 0,
      hasSource: true,
    };
  }
  return { files: null, contract: [], builtAt: 0, hasSource: false };
}

/* 工程文件名校验：相对 src/ 的路径，不许越界 */
function remotionSafeFileName(name) {
  const n = String(name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!n || n.indexOf("\0") >= 0) return "";
  const parts = n.split("/");
  for (const p of parts) if (!p || p === "." || p === "..") return "";
  return n;
}

/* 静态校验（保存 / 构建后立刻跑，不渲染）：
 *   ① 入口存在且导出 Main；② 依赖只允许 react / remotion / three + 工程内相对文件；
 *   ③ 相对 import 指到的文件必须在文件树里；④ 契约能解析。
 * 返回 { ok, errors:[], warnings:[] } */
function remotionStaticCheck(files, entryName) {
  const errors = [];
  const warnings = [];
  const tree = files && typeof files === "object" ? files : {};
  const entry = String(entryName || "Composition.tsx");
  const names = Object.keys(tree).filter((k) => String(tree[k] || "").trim());
  if (!names.length) errors.push(I18n.t("还没有源码：先点「构建」让 agent 生成，或在设置里粘贴代码"));
  if (names.indexOf(entry) < 0)
    errors.push(I18n.t("入口文件缺失：") + entry);
  const exists = (spec, fromName) => {
    /* 相对 import 按「当前文件所在目录 + 段」解析（支持 ../，不许越出 src/ 根） */
    const parts = remotionSafeFileName(fromName).split("/").slice(0, -1);
    for (const seg of String(spec || "").split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (!parts.length) return false;
        parts.pop();
        continue;
      }
      parts.push(seg);
    }
    const joined = parts.join("/");
    if (!joined) return false;
    if (Object.prototype.hasOwnProperty.call(tree, joined)) return true;
    for (const ext of [".tsx", ".ts", ".jsx", ".js", ".css", ".json"]) {
      if (Object.prototype.hasOwnProperty.call(tree, joined + ext)) return true;
    }
    if (Object.prototype.hasOwnProperty.call(tree, joined + "/index.tsx")) return true;
    if (Object.prototype.hasOwnProperty.call(tree, joined + "/index.ts")) return true;
    return false;
  };
  let contractFound = false;
  for (const name of names) {
    const src = String(tree[name] || "");
    const bad = [];
    for (const spec of collectImportSpecs(src)) {
      if (spec.startsWith(".")) {
        if (!exists(spec, name)) bad.push(spec);
        continue;
      }
      if (!customImportAllowed(spec)) bad.push(spec);
    }
    if (bad.length)
      errors.push(
        name +
          I18n.t(" 里有不允许的 import：") +
          bad.join(", ") +
          I18n.t("（只允许 react / remotion / three 与工程内的相对文件）"),
      );
    if (name === entry) {
      if (!/export\s+(?:const|let|var|function|class)\s+Main\b|export\s+default\b/.test(src))
        errors.push(I18n.t("入口没有导出 Main 组件（export const Main = ...）"));
    }
    if (remotionContractLiteralOf(src)) contractFound = true;
  }
  if (!contractFound)
    warnings.push(I18n.t("源码里没有 export const inputs 契约：端子不会自动生成（只有控制口）"));
  const parsed = remotionParseContract(String(tree[entry] || ""));
  if (parsed.error) errors.push(parsed.error);
  for (const w of parsed.warnings) warnings.push(w);
  return { ok: errors.length === 0, errors, warnings, contract: parsed.contract };
}

/* 收集已接线的数据输入 → [{ index, key, text }]。
 * 固化后：端子 0..N-1 = 契约项（同 key 的多条线按顺序收集，供数组端子用），末位是控制口。
 * 未固化：端子无差别（0、1、2…），除控制线外全算输入（老行为）。
 * 媒体值可能是 { kind, path, url }：一律换成 path（主进程再按类型决定是否内联成 data URL）。 */
function remotionInputList(node) {
  const out = [];
  const contract = remotionContractOf(node);
  for (const w of wiresTo(node.id)) {
    const idx = Number(w.toIndex);
    if (!(idx >= 0)) continue;
    if (typeof wireFromIsControl === "function" && wireFromIsControl(w)) continue;
    if (contract.length && idx >= contract.length) continue; /* 控制口 */
    const src = nodeById(w.from);
    if (!src) continue;
    let text = "";
    const v = valueFromWire(w, node, 0);
    if (v && typeof v === "object") {
      if (v.path) text = String(v.path);
      else if (v.text != null) text = String(v.text);
      else if (v.url) text = pathFromMediaValue(v);
    } else if (v != null) {
      text = String(v);
    }
    if (!text && src.imageAsset) text = String(src.imageAsset);
    if (!text) {
      const d = displayValueOf(src, node);
      if (d && d.image) text = String(d.image);
      else if (d && d.text != null) text = String(d.text);
    }
    text = String(text || "").trim();
    if (text) out.push({ index: idx, key: contract.length ? contract[idx].key : "", text });
  }
  return out;
}

/* 「台词节拍表」→ 每句起帧（打字节拍）。接头里接了一路满足下面形态的文本时，
   内置台词卡模板按它对齐逐字吐字；否则回退整片均分。
   形态（两种都认）：
     ① 表格行： 序号 | 台词原文 | 起(s) | 止(s) | 时长(s)   ← 台词节拍节点（proc_text）的输出
     ② 时间码行：0.0s  台词原文                               ← 手写节拍
   解析不出 → 返回空数组。 */
function remotionBeatStarts(inputs, fps) {
  const list = (Array.isArray(inputs) ? inputs : []).map((x) => String((x && x.text) || ""));
  const out = [];
  const f = Math.max(1, Number(fps) || 30);
  for (const text of list) {
    const rows = String(text || "").split(/\r?\n/);
    const starts = [];
    for (const row of rows) {
      const line = row.trim();
      if (!line) continue;
      /* ① 竖线分列：倒数第 3 列是「起(s)」 */
      if (line.includes("|")) {
        const cells = line.split("|").map((s) => s.trim());
        if (cells.length < 4) continue;
        const startCell = cells[cells.length - 3];
        /* 表头行（起(s)）没有数字，跳过 */
        if (!/\d/.test(String(startCell))) continue;
        const n = Number(String(startCell).replace(/[^\d.\-]/g, ""));
        if (!isFinite(n)) continue;
        starts.push(n);
        continue;
      }
      /* ② 时间码开头 */
      const m = line.match(/^(\d+(?:\.\d+)?)\s*(?:s|秒)\b/) || line.match(/^(\d+(?:\.\d+)?)\s+[^\d\s]/);
      if (m) starts.push(Number(m[1]));
    }
    if (starts.length >= 2) {
      let inc = true;
      for (let i = 1; i < starts.length; i++) if (!(starts[i] > starts[i - 1])) inc = false;
      if (inc) {
        const frames = starts.map((s) => Math.round(s * f));
        if (frames.length > out.length) {
          out.length = 0;
          out.push(...frames);
        }
      }
    }
  }
  return out;
}

/* ── 构建期：agent 写工程 → 静态校验 → 短试渲染验证 → 失败回灌自修（最多 3 轮）──
 * 与「运行时」彻底分开：这里可以调 agent（dsh 网关，和智能会话同一条通道），
 * 产物写进 <工作目录>/.mtnode/remotion/<节点 id>/build/src/，再读回节点字段固化。
 * 固化后 ▶ 只渲染这棵文件树，永不调模型（见 playRemotionNode）。
 */

/* 构建目录（与渲染工程同一颗节点目录下的 build/，不污染 src/） */
function remotionBuildDir(node, ws) {
  const root = String(ws || "").replace(/[\\/]+$/, "");
  const id = String((node && node.id) || "default").replace(/[^\w.-]/g, "") || "default";
  return root + "/.mtnode/remotion/" + id + "/build";
}

/* 构建描述（构建弹窗里那段需求）与节点功能说明（node.text）是**两件事**：
 *   · node.text         = 这个 remotion 节点干什么（给人看，构建 Agent 一个字都不读）
 *   · remotionBuildNote = 上次构建用的需求（构建 Agent 唯一的输入，随画布保存，下次弹窗预填）
 * 老画布上 node.text 里写的其实是构建需求：第一次打开构建弹窗时复制进构建描述，
 * node.text 原样保留 —— 要不要改写成功能说明由用户自己决定。 */
function remotionBuildNoteOf(node) {
  return node ? String(node.remotionBuildNote == null ? "" : node.remotionBuildNote) : "";
}

/* 构建提示词：多文件工程 + 端子契约 + 素材约定（与主进程的注入规则同源）。
 * 需求正文只认 opt.note（构建弹窗里填的那段），不读 node.text。 */
function remotionBuildPrompt(node, opt) {
  opt = opt || {};
  const w = opt.width || 1280;
  const h = opt.height || 720;
  const fps = opt.fps || 30;
  const dur = opt.duration || 5;
  const dir = opt.buildDir || "";
  const prev = String(opt.prevCode || "").trim();
  const err = String(opt.error || "").trim();
  const header = err
    ? I18n.t("上一轮构建的合成代码没通过验证，请修好它（只改必要的文件，别推倒重写）。") +
      "\n\n" +
      I18n.t("验证报错：") +
      "\n" +
      err +
      "\n\n"
    : "";
  return (
    header +
    PS(
      "node.remotion_build",
      I18n.t("你是 MTNode 里 Remotion 视频节点的构建器。按下面的需求，写出一份**可本地渲染**的 Remotion React 工程。"),
    ) +
    "\n\n" +
    I18n.t("需求：") +
    "\n" +
    String(opt.note || "").trim() +
    "\n\n" +
    I18n.t("工程目录（用文件工具直接写入这里，不要写到别处）：") +
    dir +
    "/src/\n" +
    I18n.t("硬约束（必须全部满足）：") +
    "\n" +
    "1. " +
    I18n.t("入口是 src/Composition.tsx，必须 `export const Main`（React 组件），根容器用 <AbsoluteFill>，不要包 <Composition>。") +
    "\n" +
    "2. " +
    I18n.t("可以拆成多个文件（相对 import，例如 ./components/Title），文件都放在 src/ 下；只允许 import \"react\" / \"remotion\" / 工程内相对文件，禁止任何其它 npm 包（不许 npm install）。") +
    "\n" +
    "3. " +
    I18n.t("在入口里声明端子契约，宿主据此自动生成节点端子：") +
    "\n" +
    "   export const inputs = [\n" +
    "     { key: \"hero\", kind: \"image\", label: \"主图\", required: true },\n" +
    "     { key: \"voice\", kind: \"audio\", label: \"旁白\" },\n" +
    "     { key: \"lines\", kind: \"text\", label: \"台词\", list: true },\n" +
    "   ];\n" +
    "   " +
    I18n.t("kind 只能是 image / audio / video / text / number / boolean / json；list: true = 这颗端子可接多路（值变成数组）；key 就是组件的 props 键。") +
    "\n" +
    "4. " +
    I18n.t("组件签名写成 `export const Main: React.FC<Props> = (props) => ...`，Props 与契约一一对应；缺省值要能兜住（没接线时也要能渲染）。") +
    "\n" +
    "5. " +
    I18n.t("画面尺寸 ") +
    w +
    "×" +
    h +
    "、" +
    fps +
    " fps、" +
    dur +
    I18n.t(" 秒；用 useVideoConfig() 读 width/height/fps/durationInFrames，不要硬编码总帧数，动画按帧插值。") +
    "\n" +
    "6. " +
    I18n.t("素材 props 的取值约定（宿主注入）：image 收到 data URL 字符串，直接 <Img src={v}/>；audio / video 收到 public/ 下的裸文件名，必须用 remotion 的 staticFile(v) 包一层再给 <Audio>/<OffthreadVideo>；数组端子收到字符串数组。") +
    "\n" +
    "7. " +
    I18n.t("interpolate 的 inputRange 必须严格递增且不重复；循环里按 i 算帧号时用 Math.max 兜底。") +
    "\n" +
    "8. " +
    I18n.t("样式用内联 style 对象；文字默认中文。") +
    "\n" +
    "9. " +
    I18n.t("不要跑渲染、不要改工程目录以外的文件、不要写 package.json。") +
    "\n\n" +
    (prev
      ? I18n.t("下面是当前已有的工程源码（迭代时在此基础上改）：") + "\n\n" + prev + "\n\n"
      : "") +
    I18n.t("完成后用一两句话说明你改了哪些文件即可，代码本身写进文件，不要贴在回复里。")
  );
}

/* 把 build/src 下的文件读回来 → { "Composition.tsx": "..." }（相对 src/）
 * 只收 since 之后写过的文件（避免上一轮遗留的孤儿文件混进来） */
async function remotionReadBuildTree(buildDir, since) {
  const root = buildDir + "/src";
  const files = {};
  let count = 0;
  const walk = async (dir, rel) => {
    let r;
    try {
      r = await window.api.fileReadDir(dir);
    } catch {
      return;
    }
    const entries = (r && r.entries) || [];
    for (const ent of entries) {
      const childRel = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDir) {
        if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
        await walk(dir + "/" + ent.name, childRel);
        continue;
      }
      if (!/\.(tsx|ts|jsx|js|css|json|md|txt)$/i.test(ent.name)) continue;
      /* ent.mtime 是毫秒（file:readDir 口径）；只收本次构建开始之后写出的文件，
         免得上一版构建遗留的文件混进这一版工程 */
      if (since && Number(ent.mtime || 0) && Number(ent.mtime) < since - 2000) continue;
      if (count >= 40) continue;
      let txt = "";
      try {
        const t = await window.api.fileReadText(dir + "/" + ent.name);
        txt = typeof t === "string" ? t : String((t && (t.content != null ? t.content : t.text)) || "");
      } catch {
        continue;
      }
      if (!String(txt || "").trim()) continue;
      if (txt.length > 400000) continue;
      files[childRel] = txt;
      count++;
    }
  };
  await walk(root, "");
  return files;
}

/* 读节点当前工程的源码拼成一段（给 agent 迭代时参考） */
function remotionProjectCodeText(project) {
  const files = (project && project.files) || {};
  return Object.keys(files)
    .sort()
    .map((n) => "// ── " + n + " ──\n" + String(files[n] || ""))
    .join("\n\n");
}

/* 构建 Agent 的模型三项：空 = 跟随全局默认（dshRunOnce 自己回落到设置里的默认） */
function remotionBuildAgentOpts(node) {
  return {
    provider: String(node.buildProvider || "").trim() || undefined,
    model: String(node.buildModel || "").trim() || undefined,
    preset: String(node.buildPreset || "").trim() || undefined,
    effort: String(node.buildEffort || "").trim() || undefined,
  };
}

/* 构建 / 重建（节点上「构建」按钮与设置窗按钮共用）：
 *   轮次 ≤3：agent 写工程 → 静态校验 → 短试渲染 → 通过即固化；不通过把报错回灌再修。
 *   3 轮仍不过：**不动现有源码**（保留上一版可用工程），只把报错写在节点上。 */
async function remotionBuildNode(node, opts) {
  opts = opts || {};
  if (!node || node.running) return;
  const ws = String(typeof wfWorkspace === "function" ? wfWorkspace() : "").trim();
  if (!ws) {
    const msg = I18n.t("Remotion 构建需要画布工作目录：先在顶栏「工作目录」选一个文件夹");
    node.remotionBuildError = msg;
    toast(msg, "warn");
    renderCanvas();
    return;
  }
  /* 构建需求只认构建描述（弹窗里填的那段 / 显式 opts.note）：节点功能说明（node.text）
     不参与构建。空着不构建 —— 不退回功能说明、也不退回上一次的值。 */
  const note = String(opts.note != null ? opts.note : remotionBuildNoteOf(node)).trim();
  if (!note) {
    const msg = I18n.t("请先点「构建」，在弹窗里填写构建需求，再开始构建");
    node.remotionBuildError = msg;
    toast(msg, "warn");
    renderCanvas();
    return;
  }
  node.remotionBuildNote = note;
  if (typeof dshRunOnce !== "function") {
    toast(I18n.t("本机 Agent 网关不可用（设置 · Agent / DSH 里检查）"), "err");
    return;
  }
  const { width, height } = remotionSizeWH(node);
  const duration = Math.max(1, Math.min(60, Number(node.duration) || 5));
  const fps = Math.max(1, Math.min(60, Number(node.fps) || 30));
  const buildDir = remotionBuildDir(node, ws);
  const startedAt = Date.now();
  const prevProject = remotionProjectOf(node);
  const prevCode = opts.fresh ? "" : remotionProjectCodeText(prevProject);

  node.remotionBuildError = "";
  node.remotionVerifyError = "";
  node.remotionBuildPct = 1;
  node.remotionStatus = I18n.t("构建中：agent 正在写工程…");
  renderCanvas();
  /* 构建目录先建出来：agent 的写工具只负责写文件，目录不存在时可能先失败一次 */
  try {
    if (window.api && window.api.fileMkdir) await window.api.fileMkdir(buildDir + "/src");
  } catch {}
  try {
    let lastError = "";
    let nextFiles = null;
    let nextContract = [];
    let verify = null;
    for (let round = 1; round <= 3; round++) {
      node.remotionBuildPct = 4 + (round - 1) * 30;
      node.remotionStatus =
        round === 1
          ? I18n.t("构建中：agent 正在写工程…")
          : I18n.t("构建中：第 ") + round + I18n.t(" 轮，agent 正在按报错修复…");
      renderCanvas();
      const prompt = remotionBuildPrompt(node, {
        width,
        height,
        fps,
        duration,
        buildDir,
        note,
        prevCode: round === 1 ? prevCode : "",
        error: lastError,
      });
      const text = await dshRunOnce(prompt, {
        node,
        workspace: ws,
        writeRoots: [buildDir],
        noCanvas: true,
        systemPrompt:
          PS(
      "node.remotion_write",
      I18n.t("你是 Remotion 动效工程构建器，只负责在给定目录里写 React 源码文件。"),
    ),
        ...remotionBuildAgentOpts(node),
      });
      void text;
      const files = await remotionReadBuildTree(buildDir, startedAt);
      if (!Object.keys(files).length) {
        lastError = I18n.t("agent 没有写出任何源码文件（构建目录：") + buildDir + "/src）";
        continue;
      }
      const check = remotionStaticCheck(files, "Composition.tsx");
      if (!check.ok) {
        lastError = check.errors.join("\n");
        continue;
      }
      nextFiles = files;
      nextContract = check.contract;
      node.remotionBuildPct = 60 + (round - 1) * 10;
      node.remotionStatus = I18n.t("构建中：短试渲染验证…");
      renderCanvas();
      verify = await remotionRunVerify(node, {
        files,
        contract: check.contract,
        description: note,
        width,
        height,
        fps,
        duration: Math.min(2, duration),
      });
      if (verify && verify.ok) {
        lastError = "";
        break;
      }
      lastError =
        (verify && (verify.error || verify.message)) || I18n.t("试渲染失败（没有返回原因）");
      node.remotionVerifyError = lastError;
    }
    if (!nextFiles || !verify || !verify.ok) {
      node.remotionBuildError = lastError || I18n.t("构建失败");
      node.remotionStatus = I18n.t("构建失败：") + node.remotionBuildError;
      toast(I18n.t("构建失败（已保留上一版源码）"), "err");
      renderCanvas();
      scheduleSave();
      return;
    }
    /* 固化：文件树 + 契约 + 时间；老的单文件直出字段清掉，避免两套源码并存 */
    node.remotionFiles = nextFiles;
    node.remotionInputs = nextContract;
    node.remotionBuiltAt = Date.now();
    node.tsx = String(nextFiles["Composition.tsx"] || "");
    node.tsxTsx = "";
    node.remotionVerifyError = "";
    const kept = remotionPruneOrphanWires(node, prevProject.contract);
    node.remotionBuildPct = 100;
    node.remotionStatus =
      I18n.t("已固化：") +
      Object.keys(nextFiles).length +
      I18n.t(" 个文件 · ") +
      nextContract.length +
      I18n.t(" 颗端子") +
      (kept
        ? I18n.t("；已断开 ") + kept + I18n.t(" 条契约里已不存在的接线")
        : "");
    toast(I18n.t("构建完成并已固化，运行只走脚本渲染"), "ok");
    renderCanvas();
    scheduleSave();
  } catch (e) {
    node.remotionBuildError = (e && e.message) || String(e);
    node.remotionStatus = I18n.t("构建失败：") + node.remotionBuildError;
    renderCanvas();
    scheduleSave();
  }
}

/* 构建弹窗（本次需求的核心入口）：点「构建」才弹这一只窗，只在窗里填这次构建的需求。
 * 节点板身那颗「功能说明」与构建无关 —— 构建 Agent 读不到它，运行期也不读它。
 * 窗走 mtDialogForm（#mtDialog 单例宿主）：只有窗内按钮 / Esc 能关，点蒙层不关，
 * 与 AGENTS.md「带输入或设置的浮层一律 persistent」同一条口径。
 * 「忽略现有源码，从头重建」默认**不勾** = 在现有源码上迭代。 */
function remotionOpenBuildDialog(node) {
  if (!node) return Promise.resolve();
  if (typeof mtDialogForm !== "function") {
    toast(I18n.t("构建弹窗不可用（界面脚本未就绪）"), "err");
    return Promise.resolve();
  }
  /* 首次开窗做一次无损迁移：老画布上 node.text 写的构建需求 → 构建描述（node.text 不动） */
  if (node.remotionBuildNote == null) node.remotionBuildNote = String(node.text || "");
  const project = remotionProjectOf(node);
  const st = { fresh: false };
  return mtDialogForm({
    title: I18n.t("构建 Remotion 工程"),
    msg: project.hasSource
      ? I18n.t("已有固化工程：默认在它上面迭代，Agent 只改必要的文件。")
      : I18n.t("还没有工程：Agent 会按这段构建需求写出一份可本地渲染的 Remotion 工程。"),
    textarea: {
      label: I18n.t("构建需求（这次要让 Agent 做出什么视频）"),
      value: remotionBuildNoteOf(node),
      rows: 9,
      placeholder: I18n.t(
        "画面、节奏、文字、素材怎么用…（只用于构建；节点的「功能说明」不会发给 Agent）",
      ),
      requiredMsg: I18n.t("构建需求不能为空：先写清楚要做什么，再开始构建"),
    },
    requireText: true,
    custom: (host) => {
      const lab = document.createElement("label");
      lab.style.display = "flex";
      lab.style.alignItems = "center";
      lab.style.gap = "6px";
      lab.style.marginTop = "10px";
      lab.style.fontSize = "12px";
      lab.style.cursor = "pointer";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = false;
      cb.addEventListener("change", () => {
        st.fresh = !!cb.checked;
      });
      const txt = document.createElement("span");
      txt.textContent = project.hasSource
        ? I18n.t("忽略现有源码，从头重建（不勾 = 在现有源码上迭代）")
        : I18n.t("忽略现有源码，从头重建（当前还没有源码，勾不勾都一样）");
      lab.appendChild(cb);
      lab.appendChild(txt);
      host.appendChild(lab);
    },
    hint: I18n.t(
      "构建会调用一次构建 Agent，并做静态校验 + 短试渲染验证；通过后固化成脚本，之后运行不再调模型。",
    ),
    actions: [
      { id: "cancel", label: I18n.t("取消") },
      { id: "build", label: I18n.t("开始构建"), primary: true },
    ],
  }).then((r) => {
    if (!r || r.action !== "build") return;
    const note = String(r.text || "").trim();
    if (!note) return; /* requireText 已经拦过；这里只是兜底，绝不退回旧值 */
    node.remotionBuildNote = note;
    if (typeof scheduleSave === "function") scheduleSave();
    return remotionBuildNode(node, { note, fresh: st.fresh });
  });
}

/* 契约重建后：同 key 的接线跟着 key 挪到新端子号上；契约里已消失的 key 断开并计数
 * （调用方在状态条里提示条数）。
 * prevContract = 上一版契约（节点覆盖 remotionInputs **之前**取），用来把老端子号翻译成 key：
 * 契约项的顺序可能变（加了一项 / 删了一项），只按位置搬会把线搬到别的 key 上。 */
function remotionPruneOrphanWires(node, prevContract) {
  const prev = Array.isArray(prevContract) ? prevContract : [];
  const contract = remotionContractOf(node);
  if (!S.wf || !Array.isArray(S.wf.wires)) return 0;
  const newIndex = new Map();
  contract.forEach((c, i) => {
    if (c && c.key) newIndex.set(String(c.key), i);
  });
  let dropped = 0;
  const kept = [];
  for (const w of S.wf.wires) {
    if (!w || w.rel || w.to !== node.id) {
      kept.push(w);
      continue;
    }
    const idx = Number(w.toIndex) || 0;
    const isCtrl = typeof wireFromIsControl === "function" && wireFromIsControl(w);
    if (idx >= prev.length) {
      /* 老控制口（末位）= 新控制口：控制线保留并挪到新的末位号；数据线断开 */
      if (isCtrl) {
        w.toIndex = contract.length;
        kept.push(w);
      } else dropped++;
      continue;
    }
    const key = prev[idx] && prev[idx].key;
    if (isCtrl || !key || !newIndex.has(String(key))) {
      /* 上一版没有契约（老的无差别端子）时 key 为空：位置不可信，按「已消失」处理 */
      dropped++;
      continue;
    }
    w.toIndex = newIndex.get(String(key));
    kept.push(w);
  }
  if (dropped || kept.length !== (S.wf.wires || []).length) {
    S.wf.wires = kept;
    if (typeof renderCanvas === "function") renderCanvas();
  }
  return dropped;
}

/* 短试渲染（构建验证 / 设置窗「试渲染」）：不占全局音视频互斥锁（共识） */
async function remotionRunVerify(node, p) {
  if (!window.api || !window.api.remotionVerify) {
    return { ok: false, error: I18n.t("Remotion 插件未就绪（请先在插件中安装）") };
  }
  try {
    const r = await window.api.remotionVerify({
      nodeId: node.id,
      workflowId: (S.wf && S.wf.id) || "",
      workspace: String(typeof wfWorkspace === "function" ? wfWorkspace() : "").trim(),
      files: p.files,
      contract: p.contract || [],
      description: p.description || "",
      durationSeconds: p.duration || 2,
      fps: p.fps,
      width: p.width,
      height: p.height,
    });
    return r || { ok: false, error: I18n.t("试渲染没有返回结果") };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* import 白名单与说明符扫描：渲染层的静态校验（remotionStaticCheck）要用，必须在这里有一份。
   为什么补这两行：applyNodePatch → applyRemotionSourcePatch → remotionApplySourceEdit →
   remotionStaticCheck 会同步调它们，而它们此前只定义在 remotion/main-remotion.js（主进程），
   渲染层没有 → 画布编辑接口写 remotionFiles 立刻抛
   「collectImportSpecs is not defined」，工程源码一个字都写不进去。口径与主进程那份保持一致。 */
const CUSTOM_IMPORT_ALLOWED = /^(?:react|react-dom|remotion|three|@remotion\/three|@react-three\/fiber)(?:\/|$)/;

/* 模块说明符是否在白名单内（react / remotion 与相对路径放行） */
function customImportAllowed(spec) {
  const s = String(spec || "");
  return s[0] === "." || s[0] === "/" || CUSTOM_IMPORT_ALLOWED.test(s);
}

/* 扫出源码里全部模块说明符（静态 import / require() / 动态 import()） */
function collectImportSpecs(src) {
  const specs = [];
  const push = (s) => {
    if (s && specs.indexOf(s) < 0) specs.push(s);
  };
  let m;
  const reStatic = /(?:^|[\s;{}])import\s[^'"`]*?['"]([^'"]+)['"]/g;
  while ((m = reStatic.exec(src))) push(m[1]);
  const reCall = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reCall.exec(src))) push(m[1]);
  return specs;
}

/* 字段级「保存即静态校验」：改完源码立即校验并重算端子（试渲染另点） */
function remotionApplySourceEdit(node, files) {
  /* 上一版契约要在覆盖 remotionInputs 之前取：接线按 key 翻译到新端子号 */
  const prevContract = remotionContractOf(node);
  const check = remotionStaticCheck(files, "Composition.tsx");
  node.remotionFiles = files;
  node.tsx = String(files["Composition.tsx"] || "");
  node.tsxTsx = "";
  if (check.ok) {
    node.remotionInputs = check.contract;
    node.remotionBuiltAt = Date.now();
    node.remotionVerifyError = "";
    node.remotionBuildError = "";
  } else {
    node.remotionBuildError = check.errors.join("\n");
  }
  const dropped = remotionPruneOrphanWires(node, prevContract);
  return { ok: check.ok, errors: check.errors, warnings: check.warnings, contract: check.contract, dropped };
}

/* 工程文件树归一：{ "相对 src/ 的路径": 源码 }。
   画布编辑接口（remotionFiles）与源码编辑器共用同一条路径校验；任何一项不合法就整份
   拒绝 —— 宁可一个字都没写，也不在节点上留半棵工程。 */
function remotionFilesNormalize(raw) {
  if (raw == null) return { files: null, error: "" };
  if (typeof raw !== "object" || Array.isArray(raw))
    return {
      files: null,
      error: I18n.t('remotionFiles 需是 { "文件路径": "源码" } 对象（路径相对 src/）'),
    };
  const files = {};
  for (const [rawName, src] of Object.entries(raw)) {
    let name = remotionSafeFileName(rawName);
    if (name && /^src\//i.test(name)) name = name.slice(4);
    if (!name)
      return {
        files: null,
        error: I18n.t("工程文件路径不合法（须是相对 src/ 的路径，不许 ../ 越界）：") + rawName,
      };
    if (typeof src !== "string")
      return { files: null, error: I18n.t("工程文件内容必须是字符串：") + name };
    files[name] = src;
  }
  return { files, error: "" };
}

/* 画布编辑接口写 Remotion 工程（Agent 侧唯一入口；applyNodePatch 的 remotion 分支调它）：
   remotionFiles  → 与设置窗「保存并校验」同一条：静态校验通过才重算端子契约并搬线；
   remotionInputs → 显式契约，在源码派生之后覆盖（同 key 接线跟着 key 走，消失的断线）。
   回执全部走 warnings（与其它字段的校验回报同一形态）。 */
function applyRemotionSourcePatch(node, patch, warnings) {
  if (!node || node.kind !== "remotion" || !patch) return false;
  const warn = (m) => {
    if (warnings) warnings.push(m);
  };
  const who = "（" + (node.title || node.id) + "）";
  let changed = false;
  if (patch.remotionFiles != null) {
    const norm = remotionFilesNormalize(patch.remotionFiles);
    if (norm.error) warn(norm.error + who);
    else if (!Object.keys(norm.files || {}).length)
      warn(I18n.t("remotionFiles 是空对象，未写入工程源码") + who);
    else {
      const r = remotionApplySourceEdit(node, norm.files);
      changed = true;
      for (const w of r.warnings || []) warn(w + who);
      if (!r.ok) {
        for (const e of r.errors || [])
          warn(I18n.t("工程源码静态校验未通过：") + e);
        warn(
          I18n.t(
            "源码已写入，但端子契约保持上一版（修好源码后重写一次 remotionFiles，或在设置里「保存并校验」）",
          ) + who,
        );
      }
      if (r.dropped)
        warn(I18n.t("契约里已不存在的接线已断开：{n} 条", { n: r.dropped }) + who);
    }
  }
  if (patch.remotionInputs != null) {
    if (!Array.isArray(patch.remotionInputs))
      warn(I18n.t("remotionInputs 需是契约数组 [{key,kind,label,list,required,default}]") + who);
    else {
      const norm = remotionNormalizeContractInput(patch.remotionInputs);
      const prev = remotionContractOf(node);
      node.remotionInputs = norm.contract;
      node.remotionBuiltAt = Date.now();
      changed = true;
      for (const w of norm.warnings) warn(w + who);
      const dropped = remotionPruneOrphanWires(node, prev);
      if (dropped)
        warn(I18n.t("契约里已不存在的接线已断开：{n} 条", { n: dropped }) + who);
    }
  }
  return changed;
}

function remotionSizeWH(node) {
  const raw = String(node && node.size || "").trim();
  const m = raw.match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/);
  if (m) return { width: Number(m[1]) || 1280, height: Number(m[2]) || 720 };
  return { width: 1280, height: 720 };
}

/* 老路径遗留：单文件直出（tsxTsx）时代的 LLM 提示词模板。
 * 运行期已不再调模型（现场生成整体下线，构建改走 remotionBuildPrompt），本函数不在调用链上；
 * 保留仅为历史对照，别接回去。 */
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

/* 老路径遗留：描述里的 @引用解析（构建描述与功能说明都不再支持 @ 引用）。
 * 不在调用链上，保留仅为历史对照。 */
function remotionResolveRefs(desc, node) {
  const text = String(desc || "");
  const cands = typeof refCandidates === "function" ? refCandidates(node) : [];
  const unresolved = [];
  if (!text || !cands.length) return { prompt: text, unresolved };
  const prompt = mapAtMentions(text, atRefNamesFor(cands), (hit, raw) => {
    const tok = hit.name || hit.token;
    const c = findCandidateByTitle(cands, tok);
    if (c) return "「" + c.title + "」";
    if (tagByAtToken(tok)) return raw;
    unresolved.push(tok);
    return raw;
  });
  return { prompt, unresolved };
}

async function playRemotionNode(node, quiet) {
  if (!window.api || !window.api.remotionGenerate) {
    toast(I18n.t("Remotion 插件未就绪（请先在插件中安装）"), "err");
    return;
  }
  /* 串行链出队后由 mediaRunPrestart 先点亮了运行态：放行这一次交接 */
  if (node.running && !node._prestart) return;
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
      node._busyErrAt = Date.now(); /* 见 app.js sweepStaleMediaBusyErrors：新报的别当场扫掉 */
      node.remotionStatus = node.error;
      if (!quiet) toast(node.error, "warn");
      renderCanvas();
      return;
    }
  } catch (_) {}

  /* 运行期一个描述都不读：node.text 是**功能说明**（只给人看），构建描述只在构建时用。
     未固化时「让文本模型现场写代码」这条路已整体下线（用户口径：只有点「构建」才调模型），
     只剩三条零模型路径：贴了 tsxTsx 直出 / 复用包内 Composition.tsx / 内置版面
     （素材与台词全由端子注入）。@ 引用在功能说明与构建描述里都不再支持。 */
  const remotionInputs = remotionInputList(node);
  const runNote = remotionBuildNoteOf(node).trim();
  /* 包内产物的描述指纹：优先构建描述；老画布还没有构建描述时退回 node.text（兼容存量） */
  const artifactDesc = runNote || String(node.text || "").trim();

  /* ── 固化优先（本节点的核心契约）────────────────────────────────────────
     节点里已有合成工程（remotionFiles 多文件 / tsxTsx 单文件直出）时：
     运行时**只渲染这棵文件树，永不调模型** —— 描述改了也不会偷偷重建，
     要重建只能用户手动点「构建」。这就是「固化后完全脚本化、稳定」的落点。 */
  const project = remotionProjectOf(node);
  const frozen = project.hasSource;

  /* ── 直出合成代码优先 ──
     节点里贴了 node.tsxTsx（合成源码）时就按它渲染，不再被内置版面顶掉。 */
  const inlineTsx = frozen ? "" : String(node.tsxTsx || "").trim();

  /* ── 包内中间产物（工作流自带的合成代码）──────────────────────────────
     与工作流包一起带过来的 Composition.tsx：构建描述指纹一致 → 直接复用，一个模型都不调
     （同一颗工作流重跑 / 换机后表现一致）；指纹不一致就没有零模型解 —— 按「未固化」处理
     （走内置版面 / 提示先构建），绝不偷偷现场生成。
     fromWorkshop 的代码产物首次运行前要用户确认（wfArtifactAckIfNeeded）。 */
  let reusedTsx = "";
  if (!frozen && !inlineTsx) {
    const tsxArt = typeof wfArtifactOf === "function" ? wfArtifactOf(node, "tsx") : null;
    if (tsxArt) {
      if (typeof wfArtifactAckIfNeeded === "function") {
        const okAck = await wfArtifactAckIfNeeded(node);
        if (!okAck) {
          node.remotionStatus = I18n.t("已取消");
          renderCanvas();
          return;
        }
      }
      const txt = await wfArtifactReadText(tsxArt);
      if (
        txt &&
        typeof wfArtifactMatches === "function" &&
        wfArtifactMatches(node, tsxArt, artifactDesc)
      )
        reusedTsx = txt;
    }
  }
  /* 内置版面：未固化、没贴代码、也没有可复用的包内工程 —— 素材 / 语音 / 台词全由端子注入。
     一条线都没接时没有可渲染的东西：提示先构建（运行期不再有模型兜底）。 */
  const wantsBuiltinPage = !frozen && !inlineTsx && !reusedTsx;
  if (wantsBuiltinPage && !remotionInputs.length) {
    const msg = I18n.t("请先点「构建」把工程固化下来，或接入素材 / 语音 / 台词再运行");
    node.remotionStatus = msg;
    renderCanvas();
    if (!quiet) toast(msg, "warn");
    return;
  }

  /* 运行期不再要文本模型：三条零模型路径（固化工程 / 直出代码 / 包内复用 / 内置版面）
     都不调 LLM —— 「无模型」闸门与服务商校验一并取消，构建那一步才验模型。 */

  /* ── 画布工作目录闸门（remotion 的工程与成片都落在这里）──
     <工作目录>/.mtnode/remotion/<节点 id>/ 是宿主唯一的写作点：没有工作目录就没有合法落点，
     绝不退回插件安装目录（那条路会把用户代码写进会被升级覆盖、还要重启才生效的现场）。 */
  const remotionWs = String(typeof wfWorkspace === "function" ? wfWorkspace() : "").trim();
  if (!remotionWs) {
    node.error = I18n.t(
      "Remotion 需要画布工作目录：先在顶栏「工作目录」选一个文件夹再跑（渲染工程与成片会落在 <工作目录>/.mtnode/remotion/<节点>）",
    );
    node.remotionStatus = node.error;
    renderCanvas();
    if (!quiet) toast(node.error, "warn");
    return;
  }

  node.running = true;
  node.error = null;
  node._abKey = uid("ab");
  beginNodeRun(node);
  node.remotionStatus = frozen
    ? I18n.t("已固化：脚本渲染中…")
    : wantsBuiltinPage
      ? I18n.t("内置版面：准备素材…")
      : I18n.t("复用工程源码：渲染中…");
  node.remotionPct = 2;
  renderCanvas();

  const { width, height } = remotionSizeWH(node);
  const duration = Math.max(1, Math.min(60, Number(node.duration) || 5));
  const fps = Math.max(1, Math.min(60, Number(node.fps) || 30));
  let tsx = "";
  if (frozen) {
    /* 固化路径：文件树直接交给主进程，一个模型都不碰 */
    tsx = String((project.files || {})["Composition.tsx"] || "");
    node.remotionPct = 4;
  } else if (wantsBuiltinPage) {
    /* 内置版面：不给 tsx，主进程按结构化参数出模板，素材与台词由下面的 inputs 注入 */
    tsx = "";
  } else {
    /* 节点里贴的合成代码 / 复用的包内工程：不调模型，直接把这份代码交给主进程渲染 */
    tsx = String(reusedTsx || inlineTsx || "").trim();
    if (tsx) node.tsx = tsx;
    node.remotionPct = 4;
    renderCanvas();
  }

  const seed = nextMediaGenSeed(node);
  const t0 = Date.now();
  try {
    if (node._aborted || !node.running || mediaRunStopped(node)) {
      node.error = null;
      node.remotionStatus = I18n.t("已取消");
      node.remotionPct = 0;
      renderCanvas();
      syncRemotionToSession(node, { desc: runNote, cancelled: true });
      return;
    }
    /* 合成代码优先级：固化工程 > 节点里贴的 tsxTsx / 复用的包内工程；
       内置版面两者都不传，由主进程按结构化参数出模板。 */
    const directTsx = frozen
      ? ""
      : wantsBuiltinPage
        ? ""
        : String(tsx || "").trim() || String(node.tsxTsx || "").trim();
    const r = await window.api.remotionGenerate({
      nodeId: node.id,
      workflowId: (S.wf && S.wf.id) || "",
      /* 画布工作目录：宿主据此把渲染工程与成片落到 <工作目录>/.mtnode/remotion/<节点 id>/
         （路径一律由应用注入，工作目录里不出现任何硬编码路径） */
      workspace: remotionWs,
      /* 固化工程（多文件）：主进程把整棵树写进工程 src/，入口固定 Composition.tsx */
      files: frozen ? project.files : undefined,
      /* 端子契约：主进程据此把已接线输入组装成 props（媒体内联、数组、标量） */
      contract: frozen ? project.contract : undefined,
      /* 动效合成：单文件路径（老节点现场生成 / 直出代码），宿主采用为 src/Composition.tsx */
      prompt: directTsx,
      tsx: directTsx,
      /* 描述原文：运行期不再有描述语义（功能说明只给人看、构建描述只在构建时用），
         固定传空串 —— 主进程按 inputs 与结构化参数出内置版面。 */
      description: "",
      /* 全部已接线数据输入（固化时带 key；老节点无差别端子）：视频 / 图片 → hero，音频 → voice，文本 → narration */
      inputs: remotionInputs,
      /* 打字节拍：接头里若有一路「台词节拍表」，把每句起帧交给模板（成片跟随语音朗读） */
      beatStarts: wantsBuiltinPage ? remotionBeatStarts(remotionInputs, fps) : [],
      backgroundColor: String(node.bgColor || "").trim() || undefined, // 底色（未填则主进程取默认）
      /* 内置版面的标题：节点标题（描述不再参与画面内容） */
      title: String(node.title || "").trim().slice(0, 60) || I18n.t("Remotion 视频"),
      subtitle: "",
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
      syncRemotionToSession(node, { desc: runNote, cancelled: true });
      return;
    }
    if (!r || !r.ok) {
      const err = (r && (r.message || r.error)) || I18n.t("渲染失败");
      if (String(err) === "busy_other_node" || (r && r.error === "busy_other_node")) {
        node.error = I18n.t("已有音视频生成任务进行中，已中断本节点（全局仅 1 个，禁止并行）");
        node._busyErrAt = Date.now();
      } else if (String(err) === "cancelled") {
        node.error = null;
        node.remotionStatus = I18n.t("已取消");
        syncRemotionToSession(node, { desc: runNote, cancelled: true });
        return;
      } else {
        node.error = String(err);
      }
      node.remotionStatus = node.error;
      if (!quiet) toast(node.error, "err");
      syncRemotionToSession(node, { desc: runNote, ok: false, error: node.error });
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
      desc: runNote,
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
      syncRemotionToSession(node, { desc: runNote, cancelled: true });
    } else {
      node.error = (e && e.message) || String(e);
      node.remotionStatus = node.error;
      if (!quiet) toast(node.error, "err");
      syncRemotionToSession(node, { desc: runNote, ok: false, error: node.error });
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
  /* 生成记录真的写进了这条绑定会话：点名它盖一次时间戳（不是「当前活动会话」） */
  sess.updatedAt = Date.now();
  agentMarkSessionDirty(sess.id);
}

/* 全局媒体生成串行链：video_gen / music_gen 共享主进程单一后端，
   控制节点并行触发 / 多次尝试并发时排队串行执行，避免并发 busy 与后端竞争。
   排队项登记在 mediaGenWaiters：「全部终止」清空该表后，排队项直接作废，
   绝不再启动后端任务（旧实现是一个无法撤销的 Promise 链，终止后仍会依次开跑）。 */
let _mediaGenChain = Promise.resolve();
/**
 * 本地模型显存释放钩子（renderer/app-vram.js + 主进程 local-model-vram.js）：
 *   起跑前释放**其他**本地后端（别人的显存先还回去），跑完（成功 / 失败 / 被终止都算）
 *   再释放本次自己这个后端 —— 同一模型连跑第二次时，上一轮的模型与残留不会带进下一轮
 *   （minimax H3 连续运行偶发卡死就是这一类）。
 * 纪律：任何释放失败都**不判本次运行失败**；节点没在跑（排队中被终止）/ 桥就绪不了时直接跳过。
 */
function vramHookSkipped(node) {
  return !node || mediaRunStopped(node);
}
/* 媒体串行链出队后、运行体接手前，先把节点点亮成「运行中」。
   为什么要抢这一步：显存预释放（vramPreRunNode）实测要 1.4–5.6s（软释放 / 硬杀进程树，
   见 vram-release.log），而 node.running 一直是 playXxxGenNode 里才置真的 —— 用户点 ▶ 之后
   这几秒里卡片既不显示运行中、也不在等待态（排队位在出队那一刻就摘了），看着像「点了没反应」。
   这里只借运行态的外观（running + 进度行），真正的起跑仍由 play 函数负责：
   play 开头的「已在跑就直接返回」守卫按 _prestart 放行这一次交接，并由 beginNodeRun 清掉标记。 */
function mediaRunPrestart(node) {
  if (!node || !node.id || node.running) return;
  beginNodeRun(node);
  node.running = true;
  node._prestart = true;
  try {
    const ui = ensureBackendUiState(node);
    ui.genPct = 2;
    ui.genMsg = I18n.t("正在释放显存，准备起跑…");
  } catch (_) {}
  renderCanvas();
  try {
    updateRunQueuePanel();
  } catch (_) {}
}
function runMediaGenSerial(node, fn) {
  const hooked =
    typeof vramPreRunNode === "function" &&
    typeof vramPostRunNode === "function" &&
    !!vramBackendOfNode(node);
  if (!hooked) return mediaGenQueueRun(node, fn);
  /* 整段（出队 → 显存预释放 → 运行体 → 收尾释放）都登记成这个节点的运行体：
     后端在途 watcher 要等 play 里 ensureBackend 之后才起（冷启动时是好几秒），
     这之前节点一条「它还活着」的证据都没有，「假处理中」巡检（sweepGhostRunningNodes）
     就会把真在跑的媒体任务摘成「已完成 / 从未运行」—— 用户看到的正是
     「有历史输出时点 ▶ 立刻结束，且没有产出任何新内容」。见 trackNodeRunPromise。 */
  return trackNodeRunPromise(node, () =>
    /* 排队期间不动手：出队那一刻（真的轮到它跑）才释放，避免给别人白放一遍 */
    mediaGenQueueRun(node, async () => {
      mediaRunPrestart(node);
      try {
        if (!vramHookSkipped(node)) await vramPreRunNode(node);
      } catch {}
      try {
        return await fn();
      } catch (e) {
        /* 运行体在它自己的 try / finally **之外**抛错（起跑前的取素材 / 预检这类 await
           最容易出）：错误必须落在节点上，不能让这一抛把收尾整段跳过。 */
        if (node && !mediaRunStopped(node)) {
          node.error = (e && e.message) || String(e || "") || I18n.t("执行失败");
          try {
            toast(node.error, "err");
          } catch (_) {}
        }
      } finally {
        /* 运行体没接管（提前 return / 半途抛错）：把预点亮的状态与残留的 running 一并收回去。
           用户报的「执行完毕，偶尔仍显示执行中」就是这个残留：running 为真时后端在途
           watcher 也还活着，而 nodeRunAliveEvidence 拿它当「它还活着」的证据 →
           假运行自愈巡检永远不敢摘，节点只能一直转下去。 */
        if (node && (node._prestart || node.running)) {
          node._prestart = false;
          node.running = false;
          try {
            const ui = ensureBackendUiState(node);
            ui.genPct = 0;
            ui.genMsg = "";
          } catch (_) {}
          /* watcher 是「在途」的证据，收尾必须一起停（正常收尾由运行体自己停） */
          try {
            stopMediaBackendRunWatcher(node.id);
          } catch (_) {}
          renderCanvas();
          try {
            updateRunQueuePanel();
          } catch (_) {}
        }
        await mediaPostRunNote(node);
      }
    }),
  );
}
/* 收尾：把本次运行释放了多少显存写回状态行后缀（只写事实，不覆盖完成 / 报错文案） */
async function mediaPostRunNote(node) {
  try {
    if (!vramHookSkipped(node)) {
      const post = await vramPostRunNode(node);
      const note = post && typeof vramRunNote === "function" ? vramRunNote(post) : "";
      if (note) {
        /* 状态行后缀：只写事实（释放了谁、腾出多少），不覆盖原本的完成 / 报错文案 */
        if (node.kind === "music_gen") node.musicStatus = String(node.musicStatus || "") + note;
        else if (node.kind === "yue_gen") node.yueStatus = String(node.yueStatus || "") + note;
        else if (node.kind === "flux3klein_gen")
          node.flux3kleinStatus = String(node.flux3kleinStatus || "") + note;
        else if (node.kind === "qwenimage_gen")
          node.qwenimageStatus = String(node.qwenimageStatus || "") + note;
        else if (node.kind === "breeze_gen")
          node.breezeStatus = String(node.breezeStatus || "") + note;
        else node.videoStatus = String(node.videoStatus || "") + note;
        renderCanvas();
      }
    }
  } catch {}
}
function mediaGenQueueRun(node, fn) {
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
/* 运行体登记（S.runPromises）：给「拿不到别的活证据」的执行器当证明。
   remotion 就是这样一类 —— 渲染在本地主进程完成，它既不留在 mediaGenWaiters（出队即摘）、
   也没有后端在途 watcher / 锁恢复轮询（见 restoreMediaGenLocks 与 startMediaBackendRunWatcher
   的 remotion 例外），于是「假处理中」巡检（sweepGhostRunningNodes 走 nodeRunAliveEvidence）
   会把这**真在渲染**的运行当成残状态摘掉：用户看到的正是「点 ▶ 立刻显示已处理完，
   实际还在渲染，等渲染完输出又正常」。与 proc_text / agent_task 同口径，收尾即摘。 */
async function trackNodeRunPromise(node, fn) {
  const runP = (async () => fn())();
  const id = node && node.id ? String(node.id) : "";
  if (id) S.runPromises.set(id, runP);
  try {
    return await runP;
  } finally {
    /* 只摘自己那一笔：后面又起了新一轮就别误删它 */
    if (id && S.runPromises.get(id) === runP) S.runPromises.delete(id);
  }
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

/* 生成族起跑前的「输出路径」预检（本轮 bug）：缺保存路径这种**一眼就能判死**的配置错误
   必须在这里当场拦下，绝不能先进媒体串行链 —— 一进链就会被点亮成「排队中 / 执行中」
   （出队时 mediaRunPrestart 还会先做几秒显存预释放），随后运行体里才失败。用户看到的正是
   「没跑却显示执行中」；而且运行队列里这一行随后消失，会被完成判定当成「跑完了」——
   响完成音 + 弹完成提醒（app-db.js 的 dshRunQueueDoneCheck / app-notify.js）。
   口径与运行体里那份 requireXxxExport 完全一致（托管 = 输出接保存节点 → 放行），
   只是时机提前；remotion 没有自己的输出路径（产物由下游保存节点落盘），跳过。 */
function mediaGenExportPrecheck(node, quiet) {
  if (!node) return true;
  if (node.kind === "remotion") return true;
  /* MOSS-Music：产物目录由宿主托管（md / json / srt 三件套），节点没有自己的输出路径 */
  if (node.kind === "moss_music") return true;
  if (typeof isVideoPostKind === "function" && isVideoPostKind(node))
    return !!requireVideoPostExport(node, quiet);
  return !!requireMediaGenExport(node, quiet);
}

async function playNodeBody(node, quiet, opts) {
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) {
      await p;
      return;
    }
    /* running 真、却没有任何运行体 / 排队位持有它（判据见 nodeRunAliveEvidence）：
       这是残状态。旧写法在这里静默 return —— 节点于是永久停在「处理中」，
       自动级联每一轮都「看起来在跑它」，实际一次都没起跑。
       媒体族真在跑时由后端 watcher / 串行链 / 锁恢复轮询作证，不会被误判。
       只对白名单处理节点就地清残：wait_file / 定时 / 网络接收 / 控制等常驻节点的
       running 不归这里管，保持旧的「等它自己结束」语义。 */
    if (nodeRunAliveEvidence(node)) return;
    if (!isGhostSweepKind(node)) return;
    clearGhostRunningNode(node, "入口：running 但无运行体");
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
  /* 生成族：输出路径先在这里判（进串行链之前），缺路径就当场报、绝不变「执行中」 */
  if (isMediaGenNode(node) && !mediaGenExportPrecheck(node, quiet)) {
    renderCanvas();
    return;
  }
  if (node.kind === "moss_music") {
    return runMediaGenSerial(node, () => playMossMusicNode(node, quiet));
  }
  if (node.kind === "music_gen") {
    return runMediaGenSerial(node, () => playMusicGenNode(node, quiet));
  }
  if (node.kind === "yue_gen") {
    return runMediaGenSerial(node, () => playYueGenNode(node, quiet));
  }
  /* FLUX 3 Image Klein：同一条串行链 + 同一把全局音视频锁 */
  if (node.kind === "flux3klein_gen") {
    return runMediaGenSerial(node, () => playFlux3KleinNode(node, quiet));
  }
  /* Qwen Image 2.1：同一条串行链 + 同一把全局音视频锁 */
  if (node.kind === "qwenimage_gen") {
    return runMediaGenSerial(node, () => playQwenImageNode(node, quiet));
  }
  /* Breeze 语音（Breeze TTS 2）：进同一条媒体串行链 + 全局音视频互斥锁（引擎 eager 约 7.7GB 显存） */
  if (node.kind === "breeze_gen") {
    return runMediaGenSerial(node, () => playBreezeGenNode(node, quiet));
  }
  if (node.kind === "video_gen") {
    return runMediaGenSerial(node, () => playVideoGenNode(node, quiet));
  }
  /* InfiniteTalk 数字人：进同一条媒体串行链 + 全局音视频锁（与 H3 / 音乐 / 语音互斥） */
  if (node.kind === "infinitetalk_gen") {
    return runMediaGenSerial(node, () => playInfinitetalkNode(node, quiet));
  }
  /* SoulX-FlashHead Lite：进同一条媒体串行链 + 全局音视频锁（与 H3 / 音乐 / 语音互斥） */
  if (node.kind === "soulxflashhead_gen") {
    return runMediaGenSerial(node, () => playSoulxflashheadNode(node, quiet));
  }
  /* 视频后处理（超分 / 补帧）：与生成共用后端与串行队列，跑起来但不内联进生成 */
  if (typeof isVideoPostKind === "function" && isVideoPostKind(node)) {
    return runMediaGenSerial(node, () => playVideoPostNode(node, quiet));
  }
  if (node.kind === "remotion") {
    /* 渲染期间必须留下「它还在跑」的证据，否则假处理中巡检会当场摘掉 running
       （症状：点 ▶ 立刻就显示处理完毕，实际还在渲染）—— 见 trackNodeRunPromise。 */
    return runMediaGenSerial(node, () =>
      trackNodeRunPromise(node, () => playRemotionNode(node, quiet)),
    );
  }
  if (node.kind === "wait_file") {
    return playWaitFileNode(node, quiet);
  }
  if (node.kind === "deliver") {
    /* 交付节点不可执行：它是长周期任务某个人工环节在主画布上的落点，没有提示词也没有参数。
       点 ▶ 的语义 = 展开顶部条带、把这一环的卡片亮出来给人处理。绝不能落到下面的通用文本
       执行链（那会拿空提示词真发一次模型请求，白烧一次调用还写出个假输出）。 */
    if (window.LT && window.LT.ui && window.LT.ui.open) window.LT.ui.open(true);
    else if (!quiet) toast(I18n.t("交付节点由长周期任务驱动：展开画布上方的细线处理这一环"), "warn");
    return;
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
  if (node.kind === "popup") {
    return playPopupNode(node, quiet);
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
  /* 质检节点（qa_text / qa_image / qa_video / qa_audio / qa_file）：
     执行体在 renderer/app-qa.js（模板 → Agent 工具循环 → 0–100 判定 → 门禁 → 人工裁决）。
     内部会重跑上游生成节点，所以不进媒体串行链（否则自己等自己的锁）。 */
  if (typeof isQaKindNode === "function" && isQaKindNode(node)) {
    if (typeof playQaNode !== "function") {
      node.error = I18n.t("质检执行体未加载（renderer/app-qa.js）");
      renderCanvas();
      return;
    }
    return playQaNode(node, quiet, opts);
  }
  if (node.kind === "task") {
    return playTaskNode(node, quiet);
  }
  /* 函数节点 / 工具节点：自身的运行时执行引擎（JS 执行 / 内部图运行），
     复用本文件其余执行器（runAttempt / apiCall* / 上游补跑 / 持久化）。
     工具节点判定用 isToolNode()（规范形态＝节点层变体 super + tool:true），
     必须排在普通 super 之前，否则会被当成无引擎的壳节点。 */
  if (node.kind === "function") {
    return runFunctionNode(node, quiet, opts);
  }
  if (isToolNode(node)) {
    return runToolNode(node, quiet, opts);
  }
  /* 用户自建插件节点（声明式定义，见 renderer/app-nodeplugins.js）：模型类 / 本机 HTTP 类
     两条通路都在那个模块里，这里只分派 —— 插件节点不进下面那条通用文本执行链
     （它没有 prompt 字段，走进去会拿空提示词真发一次请求）。 */
  if (typeof isPluginKind === "function" && isPluginKind(node)) {
    return runPluginNode(node, quiet);
  }
  if (node.kind === "agent_task" && !String(node.task || "").trim()) {
    toast(I18n.t("先填写任务描述"), "warn");
    return;
  }
  opts = opts || {};
  /* 素材节点是静态源、不执行，但它给出去的值要先「备齐」：
     库里那一份正文只存在异步读回来的缓存里，而取值（valueForInput）是同步的。
     顺带在这里做端子同步检查 —— 该条没内容就把连入的写进库，已有内容且不同只点亮 ⟳。 */
  if (typeof assetPrepareForRun === "function") {
    try {
      await assetPrepareForRun(node);
    } catch (e) {
      /* 素材库读挂了不能把整轮执行带崩：端子按「无输入」处理 */
    }
  }
  /* 转写归音频 / 视频节点所有（renderer/app-asr.js）：本节点不再自己转写，
     真正的闸门在下面、上游补跑之后（那时音频文件才一定已经产出 / 更新）。 */
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
    /* 用户亲手起跑（含 ▶ 控制批次 batchDriven）允许重试「只有错误、没有产物」的上游；
       纯自动级联不重试，避免失败节点被无限重烧。 */
    const retryErroredUpstream = !quiet || !!opts.batchDriven;
    try {
      await ensureProcessedAll(procSourcesOutsideSchedule(node), ran, retryErroredUpstream);
    } catch (e) {
      if (pendingIds) clearPendingRun(pendingIds);
      throw e;
    }
    if (ran.length && !quiet)
      toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
    /* ── 转录闸门（本轮需求）──
       上游补跑之后、本节点起跑之前：把接线上的音频 / 视频节点挨个看一遍 ——
       已有新鲜转写（指纹一致）就直接用，没有 / 文件变了就当场替它转一次并写回
       那张音频节点；引擎不可用 / 模型没下载 / 转写失败一律拦下本轮
       （不静默把音频当没输入，也不把 file:/// 当文字喂给模型）。
       见 renderer/app-asr.js · asrEnsureForRun。 */
    if (typeof asrEnsureForRun === "function") {
      let ar = null;
      try {
        ar = await asrEnsureForRun(node);
      } catch (e) {
        ar = { ok: false, error: "asr_failed", message: String((e && e.message) || e) };
      }
      if (ar && ar.ok === false) {
        if (pendingIds) clearPendingRun(pendingIds);
        node.error = ar.message || I18n.t("音频转写没能完成");
        if (!quiet) toast(node.error, "warn");
        renderCanvas();
        return;
      }
    }
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
  /* ── 「无模型」闸门（本轮需求）──
     本机没有该节点要用的服务商 / 模型（他人模板、配置里删过东西、模型不可见）时
     **不起跑**：不改用户数据、不弹模型错误窗，只在用户亲手点启动（节点 ▶）时给一次
     提示；自动级联 / 控制批次驱动（quiet）只把原因写在节点上，免得一次刷出一串提示。 */
  if (typeof nodeModelGate === "function") {
    const mg = nodeModelGate(node);
    if (!mg.ok) {
      clearPendingEarly();
      node.error = mg.reason;
      renderCanvas();
      if (!quiet) toast(mg.reason, "warn");
      return;
    }
  }
  let prov = S.config.providers.find((p) => p.id === node.providerId);
  /* ── 模型形态兜底（非智能节点）──
     服务商级 type 只说明「这家端点的默认脾气」，节点选的模型才是「真正要干什么」。老画布、
     手工改过的配置、导入的画布都可能出现两者不符（最典型：OpenAI 兼容端点配成
     text_openai，模型却是 gpt-image-*）。
     纠偏现在**只发生在本次请求的那份副本上**：buildSpec / buildSpecAgg 取 spec.provider 时
     走 requestProviderOf → app-model-kind.js 的 providerForRequest，主进程侧还有
     effectiveProviderType 兜底（见 main.js）。
     以前这里把纠偏结果直接写进 prov.type 并写盘，等于用一次运行改掉用户的持久配置 ——
     同一端点混挂文本与图像模型时（MTNode 中转服务卡恒为 text_openai），跑一次图像节点就把
     这张卡的 type 改成 image_openai，它的文本模型随即从会话 / 节点的模型选择器里一起消失，
     要用户去「设置 · 提供商」刷新才回来。这类「用着用着模型不见了」的报障根因就在这里。 */
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
    /* 选中的就是官方 DeepSeek 而它没 Key → 弹图文引导窗（renderer/app-deepseek-onboard.js）。
       这里以前只写一条节点红字就 return，请求根本发不出去，所以上层那些「调用前闸门」的
       引导永远轮不到 —— 用户点了运行却只看到一句「未填写 API Key」，这就是「弹窗不生效」。 */
    if (typeof dsEnsureModelReady === "function" && !dsEnsureModelReady(prov)) {
      renderCanvas();
      return;
    }
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
    /* 节点内也开新一轮（本次需求）：这一轮起跑时把上一轮**已了结**的计划与任务清单
       一并清掉（与 app-assist.js 的 agentSessionSend 同口径、同一个入口）——
       节点里的 todo_write 会镜像到这条绑定会话的面板（app-db.js），不清就又是
       「上一轮的记录挂在本轮眼前」。清了要落盘：面板数据真删，切会话 / 重启都不复活。 */
    if (sess && typeof agentRoundMarkNew === "function") {
      try {
        const rr = agentRoundMarkNew(sess);
        if (rr && rr.cleared) {
          sess._planDrops = 0;
          persistAgentSession().catch(() => {});
        }
      } catch (_) {}
    }
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
      /* 已被「假处理中」自愈作废的那一批：用户口径什么都不留（不写错误、不弹 toast） */
      node.error = node._ghostCleared ? null : e.message || String(e);
      if (!quiet && !node._ghostCleared)
        toast(I18n.t("处理失败：") + node.error, "err");
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
 * 工具节点（super + tool:true 变体，判定 isToolNode）：本身就是节点层容器
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

/* ── 「这个入参怎么没取到值」的来源诊断（只读，给节点卡片用） ──────────────
   需求背景：文本节点一旦挂上入线就进入**继承态**（app.js inputInherited / valueForInput），
   此时它在节点里写的正文不再参与取值、改从上游取；上游若还没出值，下游收到的就是空串 ——
   用户看到的是「我明明在文本节点里写了路径，工具却报缺少路径」。
   取值语义一字不改（保留现有优先级），只把「空值 + 为什么 + 到底断在哪一环」如实记到
   消费节点的 node._inputNotes（运行态脏字段，不进存档）与 console，由卡片渲染成一行提示。
   注意：工具节点内部子图节点的直接来源是**工具节点壳**，而用户看到的是壳外面那个文本节点，
   所以提示必须沿壳上溯（wireSourceMediaType 那套「节点层穿透」的同一条口径），
   否则用户照着提示找不到该改哪个节点。
   另一条纪律：这份归因**不绑在运行上** —— computeWireInputNotes 只读、可随时调用，
   建卡片时就算（画布一变即重算），所以没点 ▶ 也能在卡片上看到「这个入参当前取不到值」，
   不必先撞一次报错。 */
function fnInputSrcNoteLegacyTrap(src) {
  if (!src) return false;
  if (typeof inputInherited !== "function" || !inputInherited(src)) return false;
  /* 继承态下「本节点自己写过正文」的两类：文本看 text（含批量条目），图像看已选图。
     批量条目也算写了内容 —— 以前只看 text，会漏掉「批量文本节点挂入线」。 */
  if (src.kind === "input_text")
    return (
      !!String(src.text || "").trim() ||
      !!(Array.isArray(src.entries) && src.entries.length)
    );
  return src.kind === "input_image" && !!String(src.imageAsset || "").trim();
}
/** 输入端点的中文类型名（提示里说清「你给的那个节点自己没内容」）。 */
function fnInputSrcKindLabel(src) {
  if (!src) return "";
  switch (src.kind) {
    case "input_text":
      return I18n.t("文本节点");
    case "input_image":
      return I18n.t("图像节点");
    case "input_audio":
      return I18n.t("音频节点");
    case "input_video":
      return I18n.t("视频节点");
    case "input_any":
      return I18n.t("文件节点");
    case "asset":
      return I18n.t("素材节点");
    case "db_table":
      return I18n.t("表节点");
    case "global":
      return I18n.t("全局节点");
    default:
      return "";
  }
}

/** 沿「壳」上溯到实际给值的那一环：来源是工具 / 节点层时，值其实是它外侧输入线上游给的
    （app.js valueForInput 的 isSuperLikeNode 分支）。没有外侧输入线 → 返回 null（说明壳自身
    就没有供值来源）；不是壳 → 原样返回。带环保护，最多穿 8 层。 */
function fnInputProviderNode(src) {
  let cur = src;
  const seen = new Set();
  for (let d = 0; d < 8 && cur; d++) {
    if (!isSuperLikeNode(cur)) return cur;
    const id = String(cur.id || "");
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const ws =
      typeof superExternalInWiresAll === "function"
        ? superExternalInWiresAll(cur)
        : [];
    const first = ws.find((w) => {
      const f = nodeById(w.from);
      return !!(f && !isControlKind(f));
    });
    if (!first) return null; /* 壳自己没有外侧输入线 = 这一环就是断点 */
    cur = nodeById(first.from);
  }
  return null;
}
function fnInputValueIsBlank(v) {
  if (v == null) return true;
  if (typeof v === "object")
    return !String(v.path != null && v.path !== "" ? v.path : (v.text == null ? "" : v.text)).trim();
  return !String(v).trim();
}
/** 空值归因："" = 没有可说的（本参数不是「取到空值」）。
    返回的文案里必须同时给出「谁」与「为什么」，用户照着就能改。 */
function fnInputBlankReason(node, port, pname, src, v) {
  const pn = String(pname || "").trim() || I18n.t("参数 ") + Number(port);
  /* 先按壳上溯到实际供值的那一环（用户能看见的那个节点），再判是不是「继承态吃掉了正文」 */
  const up = fnInputProviderNode(src);
  const who = up || src;
  const sn = String((who && who.title) || "").trim() || I18n.t("上游节点");
  if (fnInputSrcNoteLegacyTrap(who))
    return I18n.t(
      "参数「{p}」没取到值：来源文本节点「{s}」挂着上游连线（继承态），它自己写的正文不参与取值 —— 请断开这根入线用正文，或先让上游出值",
      { p: pn, s: sn },
    );
  /* 输入型端点自己就是空（静态源没有上游可等）：说清「你给的那个节点自己还没内容」，
     不冤枉成「上游还没跑」—— 用户照着就能去给它填内容。 */
  const kl =
    typeof fnInputSrcKindLabel === "function" ? fnInputSrcKindLabel(who) : "";
  if (kl)
    return I18n.t(
      "参数「{p}」没取到值：来源{kl}「{s}」自己还没有内容（没有上游可等，先给它填上内容 / 选好文件）",
      { p: pn, kl: kl, s: sn },
    );
  return I18n.t("参数「{p}」没取到值：来源「{s}」暂时没有输出（上游还没跑或结果为空）", {
    p: pn,
    s: sn,
  });
}

/* 沿入线取某个端子的值（类节点层端口按 fromIndex 对齐） */
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
  /* 「参数」端子（9001）：一份 JSON 原样交给代码 —— 注入 input.params（不覆写节点字段）。
     默认值取 ⚙ 里的 paramsJson，9001 各线按接线顺序深合并覆盖；工具子图里的函数节点
     沿 parentSuperId 就近继承父壳那份（见 app-node-params.js fnParamsForNode）。 */
  input.params =
    typeof NParam === "object" &&
    NParam &&
    typeof NParam.fnParamsForNode === "function"
      ? NParam.fnParamsForNode(node) || {}
      : {};
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
    /* Agent 注入态：_inputNotes 用不上（卡片这一帧不会建），顺手清掉上一轮的画布连线诊断 */
    node._inputNotes = [];
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
  /* 画布连线取数：诊断与取值同源 —— 同一份 `ws`、同一个 computePortValue，
     算出的 node._inputNotes 与下面组装的入参逐字对应（卡片上看到的为什么 = 跑起来的结果）。
     空端子不提示：只有**挂过线**的端子才进诊断（新节点还没接线，提示只会是噪声）。 */
  const ws = wiresTo(node.id);
  const notes = [];
  for (let i = 0; i < params.length; i++) {
    const port = i + 1; /* 参数 i 对外侧端子 i+1 */
    const isArr = fnToolInPortIsArray(node, port);
    const list = [];
    let noteSrc = null;
    for (const w of ws) {
      if ((Number(w.toIndex) || 0) !== port) continue;
      const src = nodeById(w.from);
      if (!src || isControlKind(src)) continue;
      /* 注意：这里**不跳过**「来源是父壳自己」的那种线 —— 内侧子节点从父壳外侧端子取数
         是工具节点的标准接线，值确实是这么一路传进来的（缺口径少一层值就没了）。
         空值归因已经沿壳上溯（fnInputProviderNode），提示点名的是壳外面那个真节点；
         壳外侧压根没接线时文案回落到点名壳本身，也仍然是「这个参数没配」的现场。 */
      if (!noteSrc) noteSrc = src;
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
    const val = isArr ? list : list.length ? list[0] : null;
    if (noteSrc && fnInputValueIsBlank(val))
      notes.push(fnInputBlankReason(node, port, params[i] && params[i].name, noteSrc, val));
    put(i, val);
  }
  node._inputNotes = notes;
  if (notes.length)
    for (const nmsg of notes)
      console.warn(String(node.title || node.id) + "：" + nmsg);
  return input;
}

/* ── 画布连线入参预检（只读 · 建卡片时就算）────────────────────────────
   需求：报错之前就要在卡片上看见「这个入参当前取不到值、为什么」——
   所以这份归因必须能脱离运行单独算，并在每次建卡片（画布任何变化都会重建卡片）时重算
   （app-canvas.js 的 fnToolInputNotesEl → 本函数）。工具节点自己的卡片按内侧子节点汇总调用
   本函数（见 app-canvas.js fnToolShellInputNotes）。
   口径与运行路径**同一份**：下面的 functionInputObject 就是它的完整体（多带一份入参组装），
   这里只是把它跑一遍再取 node._inputNotes —— 绝不另写一套判据，免得卡片与运行各说各话。 */
function computeWireInputNotes(node) {
  if (!node || !S.wf) return [];
  functionInputObject(node);
  return Array.isArray(node._inputNotes) ? node._inputNotes : [];
}

/** 本节点是「壳内子节点」且某条入线来自**父壳自身**时：壳上那个外侧端子没接上游线。
    外侧端子的标准接线就是「外部 → 壳 → 内侧子节点」，壳外侧空着 = 这个参数还没配。
    返回「可以不在卡片上报缺口的参数名」清单：缺口由壳自己的预检负责说，而且说的是壳外面
    那个真节点；否则用户在收起壳的工具卡片上只会看到一句「来源『XX工具』暂时没有输出」，
    被引到壳身上去。运行时（functionInputObject）照旧算这条，只影响卡片那张提示。 */
function fnInputBareShellPorts(node) {
  const out = [];
  if (!node || !S.wf) return out;
  const params = fnToolParamList(node, "in");
  const extOf = (src) =>
    typeof superExternalInWiresAll === "function" ? superExternalInWiresAll(src) : [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src || !isSuperLikeNode(src)) continue;
    if (String(src.id) !== String(node.parentSuperId)) continue;
    /* 这条线取的是壳的第 w.fromIndex 个外侧数据端子：它没接上游 → 本参数不算「取到空值」 */
    if (extOf(src).some((x) => Number(x.toIndex) === Number(w.fromIndex))) continue;
    const nm = String((params[Number(w.toIndex) - 1] || {}).name || "").trim();
    const key = nm || "参数 " + Number(w.toIndex);
    if (out.indexOf(key) < 0) out.push(key);
  }
  return out;
}

/** 本节点是「壳内子节点」且某条入线来自**父壳自身**时：壳上那个外侧端子没接上游线
    （外侧端子的标准接线就是「外部 → 壳 → 内侧子节点」，壳外侧空着 = 这个参数还没配）。
    返回 true 表示该入线可以**不在卡片上**报缺口 —— 缺口由壳自己的预检负责说，
    而且说的是壳外面那个真节点；否则用户在收起壳的工具卡片上只会看到一句「来源『XX工具』
    暂时没有输出」，被引到壳身上去。运行时（functionInputObject）照旧算这条，只影响卡片。 */
function fnInputWireFromBareShell(node, w) {
  if (!node || !w) return false;
  const src = nodeById(w.from);
  if (!src || !isSuperLikeNode(src)) return false;
  if (String(src.id) !== String(node.parentSuperId)) return false;
  const ext =
    typeof superExternalInWiresAll === "function" ? superExternalInWiresAll(src) : [];
  return !ext.some((x) => Number(x.toIndex) === Number(w.fromIndex));
}

/* 打开存档 / 切画布时清掉上一轮留下的预检提示（node._inputNotes 是运行态脏字段，
   早先版本会随画布一起存盘 —— 不清的话，卡片还没重建的那一帧会显示旧结论）。
   返回是否有改动（与 asrPurgeLegacyTranscripts 同口径，true 时调用方落盘）。 */
function purgeWireInputNotes(wf) {
  let hit = false;
  for (const n of (wf && wf.nodes) || []) {
    if (!n || n._inputNotes === undefined) continue;
    delete n._inputNotes;
    hit = true;
  }
  return hit;
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
    if (p) {
      await p;
      return null;
    }
    /* 同 playNodeBody：running 真但没有任何运行体 / 排队位 → 残状态，清掉再照常起跑 */
    if (nodeRunAliveEvidence(node)) return null;
    if (!isGhostSweepKind(node)) return null;
    clearGhostRunningNode(node, "入口：running 但无运行体");
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
        await ensureProcessedAll(
          procSourcesOutsideSchedule(node),
          ran,
          !quiet || !!opts.batchDriven,
        );
        if (ran.length && !quiet)
          toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
      }
      if (!runBatchStopped(node)) await body(node, quiet, opts);
    } catch (e) {
      /* 用户主动关闭（本次需求）：运行时干净退出（exit code: 0），不是故障 ——
         节点上只写一句中性状态，也不弹红 toast（口径见 app-db.js 的 dshUserClosedErrorOf） */
      if (typeof dshIsUserClosedError === "function" && dshIsUserClosedError(e)) {
        node.error = typeof dshUserClosedText === "function" ? dshUserClosedText() : I18n.t("用户主动关闭会话");
        if (!quiet && !node._aborted) toast(node.error, "warn");
      } else {
        node.error = node._aborted
          ? I18n.t("已手动停止")
          : (e && e.message) || String(e);
        if (!quiet && !node._aborted)
          toast(I18n.t("处理失败：") + node.error, "err");
      }
    } finally {
      node.running = false;
      /* 被停止的收尾统一写在这里：工具外壳提前 return 时自己没写过错误，
         界面会一片空白、看不出是「被停掉」还是「没跑过」。停止链
         （app.js stopNode / stopAllRuns / 删除节点）只负责取消线程与回收进程，
         节点状态一律由这里落定，两边不抢着写。
         假性「处理中」被自愈摘掉的那一批不算用户停止（用户口径：什么都不留）。 */
      if (!node.error && !node._ghostCleared && runBatchStopped(node))
        node.error = I18n.t("已手动停止");
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

/* 函数节点「AI 调用」设定 → 主进程线程能用的形状（renderer/app-aicall.js 解析生效值）：
   { providerRoute, providerName, provider(配置对象，含 baseUrl/apiKey), model, preset, effort }。
   没选过模型 → null（mtnode.ai 会明确报「还没选定 AI 调用模型」，不会静默空跑）。 */
function functionAiSpec(node) {
  if (!node || typeof aiRunSpecFor !== "function") return null;
  const s = aiRunSpecFor(node);
  if (!s || !s.model) return null;
  return {
    providerRoute: s.provider,
    providerName: s.providerName || s.provider,
    provider: s.providerConfig || null,
    model: s.model,
    preset: s.preset || "",
    effort: s.effort || "",
  };
}

/* 函数节点「图像后端」设定 → 主进程线程能用的形状（renderer/app-aicall.js 解析生效值）：
   { model, label, local, refImages, maxRefImages, strength }；
     没选过 → null（主进程按 auto 走：云端图像服务商优先）。
   jscode 里 await mtnode.image(...) 用它出图，见 fn-runtime.js 的 image 桥。 */
function functionImageSpec(node) {
  if (!node || typeof imgRunSpecFor !== "function") return null;
  const s = imgRunSpecFor(node);
  if (!s || !s.model) return null;
  return s;
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
        /* 「AI 调用」设定（模型 / 预设 / 思考强度）：交给 jscode 里的
           await mtnode.ai(...) 用；没选过模型就是 null，mtnode.ai 会给明确报错。 */
        ai: functionAiSpec(n),
        /* 「图像后端」设定：交给 jscode 里的 await mtnode.image(...) 出图 / 图生图；
           没选过就是 null（主进程按 auto 走）。wfId / nodeId 决定产物落哪个画布资产目录。 */
        img: functionImageSpec(n),
        wfId: S.wf ? S.wf.id : "",
        nodeId: n.id,
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

/* ── 工具节点：运行内部图（类节点层容器，父级 = 本节点） ── */
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
    /* 「AI 调用」设定下发：本工具节点选中的模型 / 预设 / 思考强度 = 内部子图 AI 节点的
       默认；内部节点自己选过（providerId / provider / model 任一非空）的一律不动
       —— 就近优先，与开发节点同口径。见 renderer/app-aicall.js。 */
    if (typeof aiApplyToSelf === "function") aiApplyToSelf(n);
    if (typeof aiApplyToToolRun === "function") {
      const touched = aiApplyToToolRun(n);
      if (touched.length && !q)
        toast(
          I18n.t("已按本工具节点的「AI 调用」设定运行内部 ") +
            touched.length +
            I18n.t(" 个 AI 节点"),
          "ok",
        );
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
  const destRaw = absSaveDest(node, quiet);
  if (!destRaw) return false;
  /* 保存路径默认不带后缀 → 落盘这一刻才按已确定的输入类型补后缀（纯文本 = .md） */
  const dest = forcePathExt(destRaw, saveExtForMedia("text"));
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
  const yaml = yamlSaveBody(entries);
  const r = await window.api.fileWriteText(dest, yaml);
  if (!r.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  node.savedPath = dest;
  node.savedPaths = [dest];
  /* 落盘正文留一份：保存节点的输出端子给的就是这份内容（见 app.js saveNodeOutputValue） */
  node.savedBody = yaml;
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存聚合 YAML → ") + dest, "ok");
  return true;
}

async function saveTextOnce(node, quiet) {
  const titles = batchTitles(node);
  if (titles && node.batchMode === "agg") return saveTextAgg(node, quiet);
  const destBase0 = absSaveDest(node, quiet);
  if (!destBase0) return false;
  if (titles) {
    const paths = [];
    /* 最后写盘的那份正文：保存节点的输出端子给的就是它（批量 = 最后一个条目那份） */
    let lastBody = "";
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
      const p = batchOutPath(destBase0, titles[idx], ".yaml");
      const body = yamlSaveBody(entries);
      const r = await window.api.fileWriteText(p, body);
      if (!r.ok) {
        if (!quiet) toast(I18n.t("保存失败：") + p, "err");
        continue;
      }
      paths.push(p);
      lastBody = body;
    }
    if (!paths.length) {
      if (!quiet) toast(I18n.t("没有可保存的文本输入"), "warn");
      return false;
    }
    node.savedPaths = paths;
    node.savedPath = destBase0;
    node.savedBody = lastBody;
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
  /* 保存路径默认不带后缀 → 落盘这一刻才按已确定的输入类型补后缀（纯文本 = .md） */
  const destBase = forcePathExt(destBase0, saveExtForMedia("text"));
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
  /* 落盘正文留一份：保存节点的输出端子给的就是这份内容（见 app.js saveNodeOutputValue） */
  node.savedBody = yaml;
  node.savedAt = Date.now();
  if (!quiet) toast(I18n.t("已保存 YAML → ") + destBase, "ok");
  return true;
}

/* ── PDF 生成（文本 → PDF 落盘）───────────────────────────────────────────
   取数与文本保存完全同源（allTextItems / valueForInput / batchTitles），差别只在落盘那一步：
   不写 .md，而是把整理好的 Markdown 交主进程 pdf:writeText（隐藏窗口 + printToPDF，
   公式走 renderer/math-render.js 同一套渲染器，见 pdf-write.js）。
   批量（batch）= 每个条目一份 PDF；聚合（agg）= 全部条目合成一份（条目名当小标题）。 */
function pdfEntryText(entry) {
  const body = String((entry && entry.text) || "");
  const title = String((entry && entry.title) || "").trim();
  return title ? "## " + title + "\n\n" + body : body;
}
/** 一份 PDF 的正文：单条目直接用原文；多条目按「小标题 + 分隔线」拼（聚合模式） */
function pdfDocTextOf(entries) {
  if (!entries || !entries.length) return "";
  if (entries.length === 1) return String(entries[0].text || "");
  return entries.map(pdfEntryText).join("\n\n---\n\n");
}
/** 图片相对路径的基准目录：优先画布工作目录，其次输出文件所在目录 */
function pdfBaseDirOf(dest) {
  const ws = String(wfWorkspace() || "").trim();
  if (ws) return ws;
  return dirOfPath(String(dest || ""));
}
async function savePdfToDest(node, destBase, text) {
  const outPath = forcePathExt(destBase, saveExtForMedia("pdf"));
  if (!window.api || typeof window.api.fileWritePdf !== "function")
    return { ok: false, path: outPath, error: I18n.t("当前版本没有 PDF 生成通道（缺少 pdf:writeText）") };
  const r = await window.api.fileWritePdf({
    text: String(text || ""),
    outPath: outPath,
    title: String(node.title || "PDF"),
    docTitle: String(node.pdfTitle || ""),
    baseDir: pdfBaseDirOf(outPath),
    pageSize: node.pdfPageSize || "A4",
    landscape: !!node.pdfLandscape,
    margin: node.pdfMargin || "normal",
    fontScale: node.pdfFontScale || "m",
    pageNumbers: node.pdfPageNumbers !== false,
  });
  return {
    ok: !!(r && r.ok),
    path: (r && r.path) || outPath,
    error: (r && r.error) || "",
  };
}
/** 本节点配置的保存路径（相对路径按工作目录 / 节点层子目录展开）；没配且是 PDF 生成时，
    默认名 = 输入节点的标题（pdfDefaultNameOf，见 app-canvas.js）——「接上就能出 PDF」，
    文件名与输入节点同名，不必先手动起名。 */
function saveDestBaseAbs(node) {
  const r = resolveSavePath(node && node.savePath, node);
  if (r.ok) return r.path;
  if (!node || node.kind !== "save_pdf") return "";
  const name = typeof pdfDefaultNameOf === "function" ? pdfDefaultNameOf(node) : "";
  const base = String(wfWorkspace() || "").trim();
  const rel = safeFile(name || node.title || "output");
  if (base) return joinPath(base, applySuperRelToPath(node, rel));
  if (isAbsPath(rel)) return rel;
  return "";
}
async function savePdfOnce(node, quiet) {
  const destBaseRaw = saveDestBaseAbs(node);
  if (!destBaseRaw) {
    if (!quiet) toast(I18n.t("请先指定保存路径（可用「浏览」选择）"), "warn");
    return false;
  }
  const destBase = forcePathExt(destBaseRaw, saveExtForMedia("pdf"));
  const titles = batchTitles(node);
  const jobs = [];
  if (titles && node.batchMode === "agg") {
    const entries = [];
    for (const w of wiresTo(node.id)) {
      const src = nodeById(w.from);
      if (!src || isControlKind(src)) continue;
      const items = allTextItems(src, node, superPortIdxFromWire(src, w));
      if (items.length) {
        for (const it of items) entries.push({ title: it.title, text: it.text });
      } else {
        const v = valueFromWire(w, node, 0);
        if (v && v.kind === "text") entries.push({ title: "", text: v.text });
      }
    }
    if (!entries.length) {
      if (!quiet) toast(I18n.t("没有可生成 PDF 的文本输入"), "warn");
      return false;
    }
    jobs.push({ dest: destBase, text: pdfDocTextOf(entries) });
  } else if (titles) {
    for (let idx = 0; idx < titles.length; idx++) {
      const entries = [];
      for (const w of wiresTo(node.id)) {
        const src = nodeById(w.from);
        if (!src || isControlKind(src)) continue;
        const fromIdx = src.kind === "super" ? Number(w.fromIndex || 0) : idx;
        const v = valueForInput(src, fromIdx, node);
        if (v && v.kind === "text")
          entries.push({ title: itemTitleOf(src, fromIdx, node), text: v.text });
      }
      if (!entries.length) continue;
      jobs.push({
        dest: batchOutPath(destBase, titles[idx], ".pdf"),
        text: pdfDocTextOf(entries),
      });
    }
    if (!jobs.length) {
      if (!quiet) toast(I18n.t("没有可生成 PDF 的文本输入"), "warn");
      return false;
    }
  } else {
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
      entries.push({ title: itemTitleOf(src, fromIdx, node), text: v.text });
    }
    if (!entries.length) {
      if (!quiet) toast(I18n.t("没有可生成 PDF 的文本输入"), "warn");
      return false;
    }
    if (missing && !quiet) toast(I18n.t("部分输入节点尚无文本输出，已跳过"), "warn");
    jobs.push({ dest: destBase, text: pdfDocTextOf(entries) });
  }
  const paths = [];
  let lastErr = "";
  for (const job of jobs) {
    const r = await savePdfToDest(node, job.dest, job.text);
    if (!r.ok) {
      lastErr = r.error || "";
      if (!quiet) toast(I18n.t("PDF 生成失败：") + (lastErr || fileName(r.path)), "err");
      continue;
    }
    paths.push(r.path);
  }
  if (!paths.length) return false;
  node.savedPaths = paths;
  node.savedPath = paths[0];
  node.savedAt = Date.now();
  if (!quiet)
    toast(
      paths.length > 1
        ? I18n.t("已生成 ") + paths.length + I18n.t(" 个 PDF → ") + fileName(paths[0]) + " …"
        : I18n.t("已生成 PDF → ") + paths[0],
      "ok",
    );
  return true;
}

/* 图像落盘：先按节点「图像输出」设定（尺寸 / 裁剪 / 格式 / 质量）重编码，
   默认档（原样 + PNG）与旧的「原样复制」完全等价；重编码失败退回原样复制，
   绝不让用户因为多试了一个格式就丢掉这次保存。
   返回 { ok, path, outExt }（outExt = 实际落盘后缀，调用方据此纠正目标路径）。 */
async function saveImageToDest(node, srcPath, destBase) {
  const defExt = saveExtForMedia("image");
  let outExt =
    typeof saveImageExtFor === "function" ? saveImageExtFor(node) : defExt;
  let src = srcPath;
  let enc = null;
  if (typeof prepareSaveImage === "function" && typeof imageOutActive === "function") {
    if (imageOutActive(node) || outExt !== defExt) {
      try {
        enc = await prepareSaveImage(node, srcPath);
      } catch (e) {
        enc = { ok: false, error: (e && e.message) || String(e) };
      }
      if (enc && enc.ok) {
        src = enc.path;
        outExt = enc.ext || outExt;
      } else {
        outExt = defExt;
      }
    }
  }
  const dest = forcePathExt(destBase, outExt);
  const r = await window.api.fileCopyAssetTo(src, dest);
  return { ok: !!(r && r.ok), path: dest, outExt, encErr: enc && !enc.ok ? enc.error : "" };
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
  const saved = await saveImageToDest(node, paths[0], dest0);
  const dest = saved.path;
  if (!saved.ok) {
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
      const saved = await saveImageToDest(
        node,
        v.path,
        batchOutPath(destBase0, titles[idx], ".png"),
      );
      if (!saved.ok) {
        if (!quiet) toast(I18n.t("保存失败：") + saved.path, "err");
        continue;
      }
      paths.push(saved.path);
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
  const saved = await saveImageToDest(node, ins[0].value.path, destBase0);
  const destBase = saved.path;
  if (!saved.ok) {
    if (!quiet) toast(I18n.t("保存失败"), "err");
    return false;
  }
  if (saved.encErr && !quiet)
    toast(I18n.t("图像输出设定未能应用（已按原样复制）：") + saved.encErr, "warn");
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

/* 画布助手 / 智能会话改画布期间：自动保存先不落盘，避免半成品与移入节点层后路径重复写。
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
    /* forceWired：助手刚搭完图，连着的保存节点应落盘一次（路径已含节点层子文件夹） */
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
  /* 落盘前把配置路径的后缀对齐到「这次真的按哪种类型落盘」。
     接线那一刻跑过一次 applySavePathExt，但上游若是节点层 / 工具节点，出端口的类型要等
     壳里真的汇出一份值才判得出来：那时按 text 把用户的 .md 留在配置里，等壳跑过一次、
     值变成视频，落盘按视频走（forcePathExt → .mp4），配置路径却还是 .md —— 用户看到的
     就是「保存节点凭空多出一个视频、卡片变成视频播放器」。
     只比「类别」（saveMediaClassOfExt）：文本类 .md / .yaml / .txt 彼此不动（.yaml 是
     批量 / 聚合引擎的正规后缀），类别不符才按落盘口径改写。 */
  const rawPath = String(node.savePath || "").trim();
  if (
    rawPath &&
    typeof saveMediaCertain === "function" &&
    saveMediaCertain(node) &&
    typeof saveMediaClassOfExt === "function" &&
    typeof forcePathExt === "function"
  ) {
    const cls = saveMediaClassOfExt(rawPath);
    if (cls && cls !== media) {
      let next = forcePathExt(rawPath, saveExtForMedia(media));
      if (typeof preferRelativeSavePath === "function")
        next = preferRelativeSavePath(next);
      if (typeof applySuperRelToPath === "function")
        next = applySuperRelToPath(node, next);
      node.savePath = next;
    }
  }
  if (media === "pdf") return savePdfOnce(node, quiet);
  if (media === "text") return saveTextOnce(node, quiet);
  if (media === "image") return saveImageOnce(node, quiet);
  return saveMediaFileOnce(node, quiet, media);
}

async function saveNodeAction(node, opts) {
  opts = opts || {};
  /* 保存节点不走 playNode（▶ / 控制流 / 级联都直接落到这里），所以「参数」端子的
     运行期覆写要在这条入口再包一次 —— 否则保存路径这类最常用的覆写会失效。
     没有参数线时 runWithParams 就是一次直通；_npWrapped 防重入。 */
  if (
    !opts._npWrapped &&
    typeof NParam === "object" &&
    NParam &&
    typeof NParam.runWithParams === "function"
  ) {
    return NParam.runWithParams(node, () =>
      saveNodeAction(node, Object.assign({}, opts, { _npWrapped: true })),
    );
  }
  /* 用户点保存节点的 ▶：先过工作目录闸门（保存本来就往那个目录写）。
     控制流 / 级联内部叫起的保存走 skipWsGate，不重复问。 */
  if (!opts.skipWsGate) {
    const dir = await ensureRunWorkspace(node);
    if (!dir) {
      toast(I18n.t("未设置有效的工作目录：已取消本次保存"), "warn");
      return;
    }
  }
  beginNodeRun(node);
  /* 保存节点独立于会话/智能助手：手动 ▶ 直接保存来自输入的内容 */
  /* PDF 生成没配路径时默认写「输入节点标题.pdf」（saveDestBaseAbs 兜底），
     其余保存节点仍需显式路径 */
  if (node.kind === "save_pdf") {
    if (!saveDestBaseAbs(node)) {
      toast(I18n.t("请先指定保存路径（可用「浏览」选择）"), "warn");
      return;
    }
  } else if (!String(node.savePath || "").trim()) {
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
        src.kind !== "yue_gen" &&
        src.kind !== "breeze_gen" &&
        src.kind !== "video_gen" &&
        /* 后处理（视频超分 / 补帧）与 Remotion 动效视频同样是「自己会出片」的上游：
           漏了它们，点保存节点 ▶ 只补跑别的、这几类保持未处理 → 保存节点写空文件。 */
        src.kind !== "video_upscale" &&
        src.kind !== "video_interp" &&
        src.kind !== "remotion")
    )
      continue;
    /* 上游已跑完：不要再标成等待，否则处理→保存级联时刚完成的生成节点会被送进等待队列 */
    if (!src.running && nodeAlreadyProcessed(src)) continue;
    for (const id of collectPendingRunIds(src, true)) pendingIds.add(id);
  }
  addPendingRun(pendingIds);
  const ran = [];
  try {
    /* 用户点保存节点 ▶ = 亲手起跑：同样允许重试「只有错误、没有产物」的上游 */
    await ensureProcessedAll(procSourcesOutsideSchedule(node), ran, true);
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
    /* PDF 生成不入自动保存闸：它只在用户按 ▶（或控制节点指挥）时生成，
       接线 / 上游更新都不自动落盘（需求：连上必须点运行才生成）。 */
    if (n.kind === "save_pdf") continue;
    if (skip && skip.has(n.id)) continue;
    if (!n.savePath) continue;
    const srcs = wiresTo(n.id)
      .map((w) => nodeById(w.from))
      .filter((s) => s && !isControlKind(s));
    const wired = srcs.length > 0;
    /* 保存 → 保存：只由保存节点喂料的这一颗不跟着自动落盘（否则上游每次保存都会级联
       再写一遍）。它仍可以手动 ▶，也可以接控制节点指挥。 */
    if (wired && srcs.every((s) => isSaveNode(s))) continue;
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

/* 控制节点两端的已连接节点（指挥线双向：连出或连入都算；经节点层端子隧穿） */
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
    /* via: { dir:'in'|'out', index } — 进入节点层的方向与端子号 */
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
      n.kind === "popup" ||
      n.kind === "sequencer" ||
      n.kind === "gate" ||
      n.kind === "splitter" ||
      n.kind === "counter" ||
      n.kind === "mutex" ||
      n.kind === "task" ||
      n.kind === "judge" ||
      isSaveNode(n) ||
      n.kind === "music_gen" ||
      n.kind === "moss_music" ||
      n.kind === "breeze_gen" ||
      n.kind === "video_gen" ||
      (typeof isVideoPostKind === "function" && isVideoPostKind(n)) ||
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
      n.savedBody = "";
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
  /* 控制线到达目标的落点端口：闸门要多路 AND，必须知道这次信号落在哪个输入口上 */
  const viaOf = (n) => {
    if (!controlNode || !controlNode.id || !n || !S.wf) return null;
    const idx = [];
    for (const w of S.wf.wires || []) {
      if (w.rel || w.from !== controlNode.id || w.to !== n.id) continue;
      idx.push(Number(w.toIndex || 0));
    }
    return idx.length ? idx : null;
  };
  const exec =
    runOne ||
    ((n) => runControlledNode(n, seen, viaOf(n), controlNode && controlNode.id));
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
    node.savedBody = "";
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

async function runControlledNode(n, seen, viaIndexes, sourceId) {
  if (!n || seen.has(n.id)) return;
  if (n.kind === "control") return playControlNode(n, seen);
  seen.add(n.id);
  if (n.kind === "task") return playTaskNode(n, false);
  if (isSaveNode(n))
    return saveNodeAction(n);
  /* 控制类节点：由各自 play 语义执行（计数累加 / 闸门放行 / 互斥选口 / 延时 / 序列 / 分发 / 定时 / 判断） */
  if (n.kind === "timer") return playTimerNode(n, true);
  if (n.kind === "delayer") return playDelayerNode(n, true);
  /* 弹窗：弹出浮层等确认（可改正文），确定后继续点火下游控制目标 */
  if (n.kind === "popup") return playPopupNode(n, true);
  if (n.kind === "sequencer") return playSequencerNode(n, true);
  /* 闸门不是「跑一次」而是「多路 AND 到达」：控制线驱动只记到达，绝不在这儿强制放闸
     （上游只来一路就放闸 = bug；详情见 app.js pulseGateByControl） */
  if (n.kind === "gate") return pulseGateByControl(n, seen, viaIndexes, sourceId);
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
    n.kind === "yue_gen" ||
    n.kind === "moss_music" ||
    n.kind === "breeze_gen" ||
    n.kind === "video_gen" ||
    (typeof isVideoPostKind === "function" && isVideoPostKind(n)) ||
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
  /* userFired：这一层是用户亲手点的（没有外层批次）；下面「无模型」提示只在它上面弹一次，
     批次驱动的再入（seen 已带）只把原因写回节点，不重复弹。 */
  const userFired = !seen;
  if (!seen) S._lastStopAllAt = 0;
  /* 用户起跑前的统一前置：工作目录缺 / 错先问清楚
     （内部批次驱动的那一层带 seen 再入，不重复问） */
  if (!seen) {
    const dir = await ensureRunWorkspace(node);
    if (!dir) {
      toast(I18n.t("未设置有效的工作目录：已取消本次运行"), "warn");
      return;
    }
  }
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
  let runnable = fillOnly
    ? runnable0.filter((n) => n.kind === "control" || !nodeHasOutputContent(n))
    : runnable0;
  if (!runnable.length) {
    toast(I18n.t("补缺：已连接节点均已有输出，无需执行"), "ok");
    return;
  }
  /* ── 「无模型」的节点不允许启动（本轮需求）──
     本机没有它要用的服务商 / 模型时一律不起跑（原因写回节点），用户亲手点 ▶ 时弹一次
     提示并点名是哪几个节点；其余节点照跑（一个坏节点不该拖住整批），全是无模型节点
     则整批不起跑。自动批次驱动的再入（userFired=false）不弹窗。 */
  const blocked = runnable
    .map((n) => ({ n, g: nodeModelGate(n) }))
    .filter((x) => !x.g.ok);
  if (blocked.length) {
    for (const x of blocked) x.n.error = x.g.reason;
    if (userFired) {
      toast(
        I18n.t("无模型，未启动：") +
          I18n.listJoin(blocked.map((x) => x.n.title)) +
          I18n.t("（请在各自节点的设置里选好服务商与模型）"),
        "warn",
      );
      renderCanvas();
    }
    const blockedNodes = blocked.map((x) => x.n);
    runnable = runnable.filter((n) => !blockedNodes.includes(n));
    if (!runnable.length) return;
  }
  /* 目标里「running 真但没有任何运行体」的残状态先摘掉：否则下面会把整批拦成
     「请先终止当前运行」，而那个节点其实什么都没在跑，用户永远点不动这一批。 */
  for (const n of runnable) {
    if (!n || !n.running || !isGhostSweepKind(n) || nodeRunAliveEvidence(n)) continue;
    clearGhostRunningNode(n, "控制批次：目标卡在假处理中");
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
          agentTouchSession().catch(() => {});
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
    appClipboardCopy(txt, I18n.t("已复制"));
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
          img.className =
        "browse-img" +
        (node.bgRmOn ||
        (typeof imgAlphaBgOn === "function" && imgAlphaBgOn(node))
          ? " bg-rm-preview"
          : "");
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
      img.className =
        "browse-img" +
        (node.bgRmOn ||
        (typeof imgAlphaBgOn === "function" && imgAlphaBgOn(node))
          ? " bg-rm-preview"
          : "");
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
    appClipboardCopy(txt, I18n.t("已复制"));
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
  /* 这颗节点的输入框正握着焦点（用户在打字 / 输入法组合中）：replaceWith 会把正在打的
     框连光标一起换掉，等于「打一个字就被踢出输入框」。记账，等失焦后补一次。 */
  if (typeof canvasFieldIn === "function" && canvasFieldIn(old)) {
    if (typeof deferNodeRefresh === "function") deferNodeRefresh(id);
    return;
  }
  const el = nodeElement(n);
  old.replaceWith(el);
  /* 尺寸只认数据与用户手拖：这里只重排端子（fitNodeChrome 已不再改 n.w / n.h） */
  refreshPorts(el, n);
  fitNodeChrome(el, n);
  updateWires();
  fillPreviews();
}
function refreshDerived() {
  for (const n of S.wf.nodes) {
    if (n.kind === "split" || n.kind === "merge" || n.kind === "global")
      refreshNodeEl(n.id);
  }
}

/* 音频 / 视频输入节点的卡片内容会随入线改变（继承上游 / 拔线回落到自己的文件，
   取数口径见 app.js 的 mediaInputValueOf）：落线、断线之后就地重建这些卡片，
   否则界面上还停在上一态（继承标记、按钮组、显示的文件名全都对不上 ——
   renderCanvas 走复用快路径，不保证重画 body）。
   跨一层的情况也要管：外部线接到壳上时，壳内那颗音频节点的取值同样变了。 */
function refreshMediaInputCards(nodeIds) {
  const seen = new Set();
  const push = (n) => {
    if (!n || seen.has(n.id)) return;
    if (n.kind !== "input_audio" && n.kind !== "input_video") return;
    seen.add(n.id);
    try {
      refreshNodeEl(n.id);
    } catch (_) {}
  };
  for (const id of nodeIds || []) {
    const n = typeof nodeById === "function" ? nodeById(id) : null;
    if (!n) continue;
    push(n);
    if (n.kind === "super") {
      for (const c of (S.wf && S.wf.nodes) || []) {
        if (c && nodeParentSuperId(c) === n.id) push(c);
      }
    }
  }
}

/* ============ 连线 ============ */

/*
 * 节点层「外框端子」与「内框端子」等价，只作内外衔接隧道：
 *   外侧输入 i  ≡ 内侧桥接输出 i（外部 → 内部）
 *   内侧汇流输入 j ≡ 外侧输出 j（内部 → 外部）
 * 回路检测必须按穿透后的逻辑边，不能把节点层宿主当成普通图顶点，
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
  /* 节点层仅单侧挂线时，尚无穿透逻辑边，不构成回路 */
  if (!proposed.length) return false;
  const adj = buildLogicalWireAdj((S.wf && S.wf.wires) || []);
  for (const e of proposed) {
    if (reachableInAdj(adj, e[1], e[0])) return true;
  }
  return false;
}

/* ── 连线校验用的「端子级」媒体类型判定（单一真源在 app.js · wireSourceMediaType）──
     只有「纯图像 kind」（图像输入 / 文生图 / 合并 / 拆分）按节点 kind 定案；
   下列「整节点没有单一媒体类型」的来源按「这条线真正流出的媒体类型」判定：
     · 工具 / 函数节点：按真正接出来的那个端子的声明类型；
     · 素材节点：只有条目端子说得出这条线是不是图像；
     · 保存节点：唯一输出端子给的是「本次保存的内容」，看保存节点自己的口径
       （inferMediaFromSource / saveMediaKind）；
     · **节点层（super 壳）的对外边界输出端子**：从壳内汇入那个端子的那条线取值判定 ——
       旧写法只认节点 kind 白名单，壳不在名单里，于是「底图（在壳内）→ H3 首帧」由
       agent connect 自动逐层桥接出来的最后一段（壳 → H3 首帧）恒被判成「非图像」，
       报「图像端子需要图像来源」，这条线永远接不上；
     · 文件路径类来源（input_any / input_file 里选的是 .png 等）：按后缀认作图像。
   其余普通节点仍按节点 kind 判（行为逐字不变 —— 例如 proc_text 的端子实际值就算是图像，
   也不会因此被当成图像来源）。
   （typeof 守卫：本函数会被冒烟脚本按函数体抠进沙箱，沙箱里不一定带这些帮手） */
function wireActsAsImage(from, fi, consumer) {
  if (!from) return false;
  if (isImageSource(from)) return true;
  if (
    isFnToolNode(from) ||
    isAssetNode(from) ||
    (typeof isSaveNode === "function" && isSaveNode(from))
  )
    return wireSourceMediaType(from, fi, consumer) === "image";
  /* 节点层（super 壳）的对外边界输出端子：壳整节点没有单一媒体类型，
     只能看「这条线接住的那颗端子」在壳内汇入的是什么（wireSourceMediaType → 壳内取值） */
  if (typeof isSuperLikeNode === "function" && isSuperLikeNode(from))
    return wireSourceMediaType(from, fi, consumer) === "image";
  /* 文件路径类来源（泛用文件节点 / 数据库文件节点）：本机路径按后缀认图（.png / .jpg …），
     这样用户拿一张本机图片接 H3 首帧不会被「图像端子需要图像来源」拦下。 */
  if (String(from.kind || "") === "input_any" || String(from.kind || "") === "input_file")
    return wireSourceMediaType(from, fi, consumer) === "image";
  return false;
}
/* 这条线对外就是「音频 / 视频」这种媒体（工具 / 函数节点的 audio | video 输出端子、
   素材节点的音视频条目、节点层边界端子按壳内取值）：
   wireActsAsText / wireActsAsImage 都不认这一类，缺了这一支，函数节点声明成「视频」
   的输出端子就接不进视频超分 / 补帧的源视频端子（用户报的「超分节点仍然无法直接
   链接函数节点输出的视频」）。判定一律走 wireSourceMediaType（端子声明的类型优先）。 */
function wireActsAsMedia(from, fi, consumer) {
  if (!from || typeof wireSourceMediaType !== "function") return false;
  const m = wireSourceMediaType(from, fi, consumer);
  return m === "audio" || m === "video";
}
function wireActsAsText(from, fi, consumer) {
  if (!from) return false;
  /* 数据库「文件节点」：对外给的就是那条线的「文件绝对路径」（与 input_audio /
     input_video 把本机文件当文本地址对外同口径），所以可进工具 / 函数节点的文本
     参数端子，也能当媒体路径用。这个文件到底哪个处理节点吃得下，一律由
     fileWireSupportError 在连线前按 app-toolbuild.js 的支持表判（单一真源）。 */
  if (String(from.kind || "") === "input_file") return true;
  if (isFnToolNode(from) || isAssetNode(from))
    return wireSourceMediaType(from, fi, consumer) === "text";
  /* 保存节点：媒体类保存（图像 / 音频 / 视频）对外是**带 text 路径的对象**
     （见 app.js saveNodeOutputValue：{kind, path, url, text}），落盘后 text 就是那条
     本机绝对路径 —— 与 input_video / video_gen 同口径，可当媒体路径喂进下游。
     不补这条，Remotion 固化契约里的 audio / video 端子会拒收「循环片 · 保存」这类
     保存节点的视频输出（wireActsAsText 与 wireActsAsImage 都为 false）。 */
  if (isSaveNode(from) && typeof saveMediaKind === "function") {
    const k = saveMediaKind(from);
    if (k === "image" || k === "audio" || k === "video")
      return !!(
        String(from.savedPath || "").trim() ||
        (typeof lastSavedFilePath === "function" && String(lastSavedFilePath(from) || "").trim())
      );
  }
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
    want = "image" | "video" | "audio" | "text"（参数 kind 就是这四类）；
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

/* 这条数据线在「参数端子」眼里的类型：直接取单一真源 wireSourceMediaType 的四种
   （text / image / video / audio；端子声明优先，其次节点 kind 与该端子实际值），
   所以连普通节点层真正汇出来的媒体也能对上同类型的参数端子。
   consumer = 目标节点（节点层靠它分清「流向壳内 / 流向壳外」两条取数通道）。 */
function wireParamKind(from, fi, consumer) {
  return fnToolNormPortKind(wireSourceMediaType(from, fi, consumer));
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
  const byKind = fnToolFreePortForMedia(host, wireParamKind(from, fi, host));
  return byKind != null ? byKind : fnToolFreePortIndex(host, "in", false);
}

/** 工具 / 函数节点「输入参数端子」的类型匹配校验：
    端子声明的 kind（text | image | video | audio）就是这条数据线的准入类型 ——
    图像线只能进图像端子，视频线只能进视频端子，音频线只能进音频端子，文本线进文本端子。
    返回 null = 放行（控制端子 / 越界 / 无端子级声明一律交回既有规则处理）。
    错误文案点名参数与去处：改接来源节点的哪个端子，或在本节点的「设置」里改参数类型。 */
function fnToolInPortTypeError(host, idx, from, fi) {
  const want = fnToolPortKind(host, "in", idx);
  if (!want) return null;
  const got = wireParamKind(from, fi, host);
  if (got === want) return null;
  const e = fnToolParamList(host, "in")[Number(idx) - 1];
  const pname = String((e && e.name) || "").trim() || I18n.t("参数 ") + Number(idx);
  const where = isFunctionNode(host)
    ? I18n.t("该函数节点的「设置」")
    : I18n.t("该工具节点的「设置」");
  const kindLabel = (k) =>
    k === "image"
      ? I18n.t("图像")
      : k === "video"
        ? I18n.t("视频")
        : k === "audio"
          ? I18n.t("音频")
          : I18n.t("文本");
  return I18n.t(
    "「{p}」是{k}参数，只接受{k}来源：请把来源节点的{k}输出端子连到它，或在{n}里把「{p}」改成{t}参数",
    {
      p: pname,
      k: kindLabel(want),
      t: kindLabel(got),
      n: where,
    },
  );
}

/* ── 工具构建 · 连线拦截：文件来源 → 处理节点，但该节点吃不下这个文件 ──
   判定口径的唯一真源 = app-toolbuild.js 的后缀 / 支持表（fileConsumerAccept /
   unsupportedFilesOf / toolBuildFileGreen），这里只负责把它接进 connectError：
     · 来源只认数据库「文件节点」（input_file）—— 它能装任意类型的文件，正是本机制
       要接的一类；input_image / input_audio / input_video 各有既有专线（图像→proc_text
       自动开视觉、音频 / 视频→proc_text 走节点侧转写的转录文本、媒体→生成节点的参考槽），
       一律不在此拦；
     · 目标未登记（智能 / 工具 / 函数 / 保存 / 素材等节点）一律不设限，行为逐字不变；
     · db_table 例外：它按 app-db.js 的设计吃任意文件（非文本走「文件名 / 内容说明」索引、
       图像问是否识图），不靠转换工具，所以不吃「可接受表」这一套，不拦；
     · pdf 走既有 pdf-markdown 链，unsupportedFilesOf 已跳过，不在此报不支持；
     · 该文件已在目标节点上工具构建绿灯 → 放行（内容由 @ 引用以「路径 + 指定工具调用」进提示词）；
     · 白名单与画布上那个工具构建入口同源（app-toolbuild.js 的 toolBuildFileSourceKinds，
       两边连取文件这一步都只在「携带文件的来源 kind」上做）：文本节点的正文、处理节点的
       产物都不是入线文件，所以「文本输入 → 图像处理」不会再冒「工具构建」（本轮修 bug）。
   返回可识别错误：点明扩展名并给出「工具构建」出口，供 UI 原样提示。 */
const TOOLBUILD_FILE_SOURCE_KINDS = ["input_file"];
const TOOLBUILD_WIRE_SKIP_CONSUMERS = ["db_table"];
/* 来源 kind 白名单的真源在 app-toolbuild.js（toolBuildFileSourceKinds，本轮收口到一处）：
   那边在（正常运行 / 冒烟沙箱同时加载了上半）就用它，缺失（只切本文件的沙箱 / 加载失败）
   回落到本文件这份同值兜底 —— 于是「连线时拦不拦」与「节点上画不画工具构建卡」同一口径。 */
function toolBuildWireSourceKinds() {
  return typeof toolBuildFileSourceKinds === "function"
    ? toolBuildFileSourceKinds()
    : TOOLBUILD_FILE_SOURCE_KINDS.slice();
}
function fileWireSupportError(from, fi, to) {
  if (!from || !to) return null;
  if (toolBuildWireSourceKinds().indexOf(String(from.kind || "")) < 0) return null;
  if (TOOLBUILD_WIRE_SKIP_CONSUMERS.indexOf(String(to.kind || "")) >= 0) return null;
  if (typeof fileConsumerAccept !== "function" || typeof unsupportedFilesOf !== "function")
    return null;
  /* 该 kind 未登记可接受类型 → 不设限（不误卡智能 / 工具 / 保存等节点） */
  if (!fileConsumerAccept(to)) return null;
  const bad = unsupportedFilesOf({
    from: from.id,
    to: to.id,
    fromIndex: Number(fi || 0),
    fromNode: from,
    toNode: to,
  });
  if (!bad.length) return null;
  const pending = bad.filter(
    (d) =>
      typeof toolBuildFileGreen !== "function" || !toolBuildFileGreen(to, d.path),
  );
  if (!pending.length) return null;
  const exts = [];
  for (const d of pending) {
    const t = d.ext ? "." + d.ext : I18n.t("未知类型");
    if (exts.indexOf(t) < 0) exts.push(t);
  }
  return I18n.t("该节点不支持 {ext} 文件：是否进行「工具构建」？", {
    ext: exts.join(" / "),
  });
}


/* 普通（动态端子）目标节点的**控制输入端子** = 数据端子之后那颗：
   端子数由 inputCount 按已挂数据线顺延（max(1, 数据线数 + 1)），所以没接线时它还不存在
   → 返回 null（调用方回落既有占用判定）。数据端子 = inPortKindOf 有声明（text / image /
   any）或已挂数据线的端子：控制线绝不能占端口 0 的提示词 / 文本入口，也绝不能顶掉
   已挂数据的端子。控制线的落点（addWire）与接线校验（connectError）共用这一个函数，
   保证「校验的那颗端子 = 实际落线的那颗」。 */
function dataNodeControlInPort(node) {
  if (!node || !S.wf) return null;
  /* Remotion 固化端子：末位那颗专用控制端子（契约项之后） */
  const remotionContract = node.kind === "remotion" ? remotionContractOf(node) : [];
  if (remotionContract.length) return remotionContract.length;
    /* 动态端子节点（proc_text / proc_image / agent_task / input_*）：
     专用控制端子恒存在（数据槽之后那颗），不再走下面「挑第一颗空口」的兜底 ——
     那条兜底在空白节点上会退到端口 0 的提示词入口。多路控制线共用这颗（任一到达即触发）。 */
  if (typeof isDynCtrlNode === "function" && isDynCtrlNode(node))
    return typeof dynCtrlInPortIndex === "function" ? dynCtrlInPortIndex(node) : null;
  const ic = (Number(inputCount(node)) || 0) - 1;
  if (ic < 0) return null;
  const wiredIn = (i) =>
    (S.wf.wires || []).some(
      (w) => !w.rel && w.to === node.id && Number(w.toIndex) === i,
    );
  for (let i = 0; i <= ic; i++) {
    if (inPortIsControl(node, i)) return wiredIn(i) ? null : i; /* 已是控制端子 */
    if (wiredIn(i)) continue; /* 已被数据线占了 → 试下一个 */
    /* 任意端子：只有**不声明数据类型**的才收控制线（动态节点顺延出的那颗；
       端口 0 的提示词口是一条真数据通道，不算） */
    if (inPortKindOf(node, i) == null) return i;
  }
  /* 一颗都没挑到（未接线 / 空洞都被占）→ 用 inputCount 顺延出的那颗新端子收下 */
  const nxt = ic + 1;
  if (inPortIsControl(node, nxt)) return nxt;
  return inPortKindOf(node, nxt) == null ? nxt : null;
}

/* 动态端子节点的数据线落点归一（「图像参考接进 gpt-image-2.5 端口 4」那次现场的正解）：
   显式 toIndex 越界、或落在控制端子上时，改落到「最近空闲的数据端子」——
   即追加到最高已挂数据端子之后；那颗被占则退到第一个空闲数据端子。
   控制端子 = dataNodeControlInPort（数据端子之后那颗，只收控制线）：数据线占住它，
   控制通道被顶掉、这颗端子又不属于任何数据槽 —— 现场表现就是底图节点整条不跑。
   固定端子节点（video_gen / breeze_gen / 工具 / 函数 / 素材 …）一律不在此列：
   它们的端口号是契约，改号等于改语义。 */
function dataInPortIndexForWire(to, from, fromIndex, toIndex) {
  if (!to || toIndex == null) return toIndex;
  /* 「参数」端子是哨兵端子号（PARAM_IN_INDEX），不在顺序端口的自动落槽语义里：
     显式给了就原样放行（参数线允许重号叠加，靠深合并取最后一份）。
     常量在 app.js 定义；冒烟会单独切出本函数跑，所以这里带一份同值的兜底。 */
  const paramIdx = typeof PARAM_IN_INDEX === "number" ? PARAM_IN_INDEX : 9001;
  if (Number(toIndex) === paramIdx) return paramIdx;
  if (isControlKind(from)) return toIndex; /* 控制线走自己的落点（dataNodeControlInPort) */
  const want = Number(toIndex);
  if (!isFinite(want) || want < 0) return toIndex;
  if (hasFixedInPorts(to) || isAssetNode(to) || isFnToolNode(to)) return want;
  const wires = (S.wf && S.wf.wires) || [];
  let maxData = -1;
  for (const w of wires) {
    if (!w || w.rel || w.to !== to.id) continue;
    if (typeof wireFromIsControl === "function" && wireFromIsControl(w)) continue;
    maxData = Math.max(maxData, Number(w.toIndex || 0));
  }
  const ctrl = typeof dataNodeControlInPort === "function" ? dataNodeControlInPort(to) : null;
  const hitsCtrl = ctrl != null && Number(ctrl) === want;
  if (!hitsCtrl && want <= maxData) return want; /* 合法数据端子：原样 */
  const occupied = (i) =>
    wires.some((w) => !w.rel && w.to === to.id && Number(w.toIndex) === Number(i));
  const append = maxData + 1;
  if (!occupied(append) && !(ctrl != null && Number(ctrl) === append)) return append;
  const free = typeof firstFreeInPortIndex === "function" ? firstFreeInPortIndex(to) : null;
  if (free != null && !(ctrl != null && Number(ctrl) === Number(free))) return Number(free);
  return append;
}

/* ══════════ 占用替换：另一节点连到已占用的输入端子 → 顶掉旧线，而不是报「已被占用」══
   口径（用户确认的共识）：
   · 只对「一端口一线」的输入端子生效 —— 「参数」端子（种号 9001）、数组 / 批量参数端子、
     动态端子节点的专用控制端子（本就允许多条控制线共享）保持原状，仍按原逻辑判占用；
   · 只顶掉**同类**旧线：数据线顶数据线、控制线顶控制线；控制线 ↔ 数据线错位仍是错，
     不替换（那是接错端子，不是被占用）；
   · Remotion 的端子是无差别的（数据线与控制线共用同一批口、先到先占）→ 不分类型一律顶掉；
   · toIndex 为 null（拖到节点卡片身上 / agent connect 不带端子号）不替换：没有「要换掉哪一颗」
     的意图，仍走自动落点，槽位占满时照旧报占用；
   · 类型校验先于替换生效（connectError 的槽位类型分支照旧）：接不进去的线不会把旧线换掉。 */

/** 这颗端子上「会被顶掉」的旧线（可替换 → replaceable=true）。
    返回值只读：不做任何修改，改画布只在 dropWiresForReplace 一处。 */
function inPortOccupancy(to, toIndex, fromCtrl) {
  const none = { wires: [], replaceable: false };
  if (!to || toIndex == null) return none;
  const idx = Number(toIndex);
  if (!isFinite(idx) || idx < 0) return none;
  const paramIdx = typeof PARAM_IN_INDEX === "number" ? PARAM_IN_INDEX : 9001;
  if (idx === paramIdx) return none; /* 参数端子：允许多条（深合并），没有「占用」 */
  /* 数组式端子（flux3klein_gen 的参考图口）：本来就挂多条数据线 → 不算占用、不替换 */
  if (typeof inPortAcceptsManyWires === "function" && inPortAcceptsManyWires(to, idx)) return none;
  const list =
    to.kind === "super" && typeof superExternalInWiresAll === "function"
      ? superExternalInWiresAll(to)
      : (S.wf && S.wf.wires) || [];
  const hit = list.filter(
    (w) => w && !w.rel && w.to === to.id && Number(w.toIndex || 0) === idx,
  );
  if (!hit.length) return none;
  /* 数组（批量）参数端子：本来就能挂多条数据线，不发「占用」也不替换 */
  if (
    typeof isFnToolNode === "function" &&
    isFnToolNode(to) &&
    typeof fnToolInPortIsArray === "function" &&
    fnToolInPortIsArray(to, idx)
  )
    return none;
  /* 动态端子节点的专用控制端子：多条控制线共享（任一到达即触发一次），不替换 */
  if (
    typeof isDynCtrlNode === "function" &&
    isDynCtrlNode(to) &&
    typeof dynCtrlInPortIndex === "function" &&
    idx === Number(dynCtrlInPortIndex(to))
  )
    return none;
  /* Remotion 固化端子：控制端子恒为末位（多条控制线共享，任一到达即触发一跑）；
     契约里 list:true 的数组端子可挂多条数据线；其余仍是一口一线、可顶掉。 */
  if (to.kind === "remotion") {
    const contract = remotionContractOf(to);
    if (contract.length) {
      if (idx === contract.length) return none;
      const item = contract[idx];
      if (item && item.list) return none;
      return { wires: hit, replaceable: true };
    }
    return { wires: hit, replaceable: true };
  }
  const same = fromCtrl
    ? hit.filter((w) => wireFromIsControl(w))
    : hit.filter((w) => !wireFromIsControl(w));
  return { wires: same, replaceable: same.length > 0 };
}

/** 这颗端子接这条线时是否「已占用但可以顶掉」——connectError 各占位分支的唯一判据。 */
function inPortReplaceable(to, toIndex, fromCtrl) {
  return inPortOccupancy(to, toIndex, fromCtrl).replaceable;
}

/** 落线前顶掉旧线（唯一落点）。返回被顶掉的旧线摘要（供 toast / agent 回执点名）。
    调用方必须先 pushHistory：整次替换（含多段桥接）= 一步撤销。
    这里**不做端子号左移补位**：新线马上落到同一颗端子，端子始终是占用的，
    补位只会把别的线挪错号（固定端子节点更是绝不许重排）。 */
function dropWiresForReplace(to, toIndex, fromCtrl) {
  const occ = inPortOccupancy(to, toIndex, fromCtrl);
  if (!occ.replaceable || !occ.wires.length) return [];
  const doomed = new Set(occ.wires);
  const removed = occ.wires.map((w) => {
    const src = nodeById(w.from);
    return {
      port: Number(w.toIndex || 0),
      from: w.from,
      fromTitle: (src && (src.title || src.kind)) || w.from,
      fromIndex: Number(w.fromIndex || 0),
      ctrl: wireFromIsControl(w),
    };
  });
  S.wf.wires = (S.wf.wires || []).filter((w) => !doomed.has(w));
  /* 数据线被换掉 → 下游缓存作废（与右键切断同一口径；控制线不动下游结果） */
  if (removed.some((r) => !r.ctrl)) clearDownstream(to.id);
  return removed;
}

/** 完全相同的线（同来源端子 → 同目标端子）是否已在画布上：再连一次 = 无操作。 */
function identicalWireExists(fromId, toId, toIndex, fromIndex) {
  if (toIndex == null) return false;
  return ((S.wf && S.wf.wires) || []).some(
    (w) =>
      w &&
      !w.rel &&
      w.from === fromId &&
      w.to === toId &&
      Number(w.fromIndex || 0) === Number(fromIndex || 0) &&
      Number(w.toIndex || 0) === Number(toIndex),
  );
}

/** 替换提示文案（多颗端子汇总成一条：跨层桥接一次可能落好几段）。 */
function replaceWiresToastText(list) {
  if (!list || !list.length) return "";
  if (list.length === 1) {
    const r = list[0];
    return I18n.t("已替换端口 {p} 上的原有连线（{src}）：Ctrl+Z 可撤销", {
      p: String(r.port),
      src: r.fromTitle || "",
    });
  }
  const ports = list.map((r) => String(r.port)).join(" / ");
  return I18n.t("已替换 {n} 颗端口上的原有连线（端口 {ports}）：Ctrl+Z 可撤销", {
    n: String(list.length),
    ports,
  });
}

function connectError(fromId, toId, toIndex, fromIndex) {
  const from = nodeById(fromId),
    to = nodeById(toId);
  if (!from || !to) return I18n.t("节点不存在");
  /* 组输入端子只吃组线（组线不经这里落线，见 connectGroup）：普通数据线落上去
     会变成一条「取不到值、也画不出」的线，就地拦住并说清去哪儿连。 */
  if (to && typeof isGroupInPort === "function" && isGroupInPort(to, toIndex))
    return I18n.t(
      "这是「组」输入端子：请从画布组框上的 □ 拖一根组线进来，普通数据线不接这里",
    );
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
    /* 跨节点层：硬规则不许直连，只能经边界端子逐层中转。文案给可执行口径
       （两边的壳名都要点出来），别只说「不行」。 */
    const upSide = fromSuper ? (nodeById(fromSuper) || {}).title || fromSuper : "";
    const downSide = toSuper ? (nodeById(toSuper) || {}).title || toSuper : "";
    return I18n.t(
      "节点层内外不能直接连线，必须经节点层的边界端子逐层中转：内侧节点 → 直属节点层输出端子 … → 目标节点层输入端子 → 内侧节点" +
        (upSide || downSide
          ? "（本对应经 " +
            (upSide ? "「" + upSide + "」输出端子" : "外侧") +
            " → " +
            (downSide ? "「" + downSide + "」输入端子" : "外侧") +
            "）"
          : ""),
    );
  }
  /* 「参数」端子（哨兵端子号 PARAM_IN_INDEX）：不走下面任何一条按 kind 的槽位校验 ——
     它只接文本（正文是一份 JSON 对象），可接多条（按顺序深合并，后者胜），
     只对「有配置」的节点存在（判定真源 = NParam.eligible）。 */
  if (Number(toIndex) === (typeof PARAM_IN_INDEX === "number" ? PARAM_IN_INDEX : 9001)) {
    if (typeof NParam !== "object" || !NParam || !NParam.eligible(to))
      return I18n.t("该节点没有参数端子");
    if (!hasOutput(from)) return I18n.t("该节点没有输出端子");
    const fiParam = Number(fromIndex || 0);
    if (fiParam < 0 || fiParam >= outputCount(from)) return I18n.t("该节点没有输出端子");
    if (isControlKind(from)) return I18n.t("参数端子只接数据线（文本 JSON），不接控制线");
    const okText =
      typeof wireActsAsText === "function" ? wireActsAsText(from, fiParam, to) : isTextSource(from);
    if (!okText) return I18n.t("参数端子需要文本来源（正文是一份 JSON 对象）");
    if (fromId === toId || wouldCycle(fromId, toId, toIndex, fromIndex))
      return I18n.t("不能连接成回路");
    return null;
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
  /* 重复连线：同一来源的**同一颗输出端子** → **同一颗输入端子** 才算重复。
     旧写法只比 from / fromIndex，把「同一张图分接首帧与末帧」（端口 2 / 3，来源同一个）
     也判成「这两节点已连接」—— 视频节点的首末帧因此接不上同一个图像节点，
     H3 动态静图那种「一张图首尾相接」的接法直接做不出来。固定端子节点（video_gen /
     music_gen / yue_gen / breeze_gen…）本来就有逐端子的占用判定，来源相同但端子不同
     是合法接法；同一颗端子仍是重复（占用判定也照旧会报）。未指定端子（拖到节点身上 /
     agent connect）保持旧口径：不看端子就判重复，重复调用不会静默多接一条线。
     替换语义：显式端子时「拖的是同一根线」= 无操作 → 静默放行（connect / addWire 都会去重，
     不弹任何提示）；未指定端子时保持旧口径，避免静默多接一条。 */
  const dupSlot = toIndex == null ? null : Number(toIndex);
  if (
    S.wf.wires.some(
      (w) =>
        !w.rel &&
        w.from === fromId &&
        w.to === toId &&
        Number(w.fromIndex || 0) === fi &&
        (dupSlot == null || Number(w.toIndex || 0) === dupSlot),
    )
  )
    return dupSlot == null ? I18n.t("这两节点已连接") : null;
  /* 动态端子节点：一个来源只接一次。
     端口只是「第几条线」的顺序槽，同一来源接两个槽没有语义（现场实证：DS 图同时落在
     底图节点的端口 3 与端口 4，多出来的那颗 `output` 恒空，节点运行期整条空跑）。
     固定端子节点不受此限 —— 同一张图分接首帧 / 末帧（端口 2 / 3）是合法规格。 */
  if (
    toIndex != null &&
    !hasFixedInPorts(to) &&
    !isFnToolNode(to) &&
    !isAssetNode(to) &&
    S.wf.wires.some(
      (w) =>
        !w.rel &&
        w.from === fromId &&
        w.to === toId &&
        Number(w.fromIndex || 0) === fi,
    )
  )
    return I18n.t("这两节点已连接（同一来源已接在该节点的另一个数据端子上）");
  if (to.kind === "task") {
    if (!fromCtrl) return I18n.t("任务节点仅接受控制信号（不接内容连线）");
    /* 任务节点的控制输入也是一端口一线：新控制线顶掉旧的触发线（替换语义） */
    if (
      S.wf.wires.some((w) => !w.rel && w.to === toId) &&
      !inPortReplaceable(to, toIndex == null ? 0 : Number(toIndex), true)
    )
      return I18n.t("任务控制输入端子已被占用");
  }
  if (from.kind === "task") {
    if (fi !== 0 && fi !== 1) return I18n.t("任务节点仅有成功 / 失败控制输出");
  }
  if (!fromCtrl && isSaveNode(to)) {
    const incoming = saveDataSources(to);
    /* 端口感知：工具 / 函数节点按真正接出来的那个端子判定媒体（图像端子 → 图像保存），
       其余节点仍只看 0 号端子（inferMediaFromSource 内部同口径）。 */
    const media = wireSourceMediaType(from, fi, to);
    if (incoming.length) {
      const em = saveMediaKind(to);
      if (em === "image" || em === "audio" || em === "video") {
        /* 已定型媒体保存：同类线可以顶掉旧线（替换语义），不同类仍是错接 */
        if (em !== media) return I18n.t("图像 / 音频 / 视频保存仅接受 1 个输入");
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
      !wireActsAsImage(from, fi, to) &&
      from.kind !== "split" &&
      from.kind !== "merge"
    )
      return I18n.t("图像保存需要图像来源");
  } else if (!fromCtrl && to.kind === "split") {
    /* 拆分节点只有一个输入：新线顶掉旧线（替换语义），不再要求先手动断开 */
    if (
      wiresTo(toId).length &&
      !inPortReplaceable(to, toIndex == null ? 0 : Number(toIndex), false)
    )
      return I18n.t("拆分节点仅接受 1 个输入");
  } else if (!fromCtrl && to.kind === "music_gen") {
    if (!wireActsAsText(from, fi, to))
      return I18n.t("音乐生成节点需要文本来源（提示词 / 歌词）");
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && (slot < 0 || slot > 1)) return I18n.t("无效的输入端子");
    if (slot != null) {
      if (
        S.wf.wires.some((w) => !w.rel && w.to === toId && Number(w.toIndex) === slot && !wireFromIsControl(w)) &&
        !inPortReplaceable(to, slot, false)
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
  } else if (!fromCtrl && to.kind === "yue_gen") {
    /* YuE2：端口0=风格提示词 · 端口1=歌词 · 端口2=ABC 谱（可选），只接受文本来源；
       端口3=控制输入不进数据槽 */
    if (!wireActsAsText(from, fi, to))
      return I18n.t("YuE2 音乐节点需要文本来源（风格提示词 / 歌词 / ABC 谱）");
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && (slot < 0 || slot > 2)) return I18n.t("无效的输入端子");
    if (slot != null) {
      if (
        S.wf.wires.some(
          (w) => !w.rel && w.to === toId && Number(w.toIndex) === slot && !wireFromIsControl(w),
        ) &&
        !inPortReplaceable(to, slot, false)
      )
        return I18n.t("该输入端子已被占用");
    } else if (nextFreeMediaDataSlot(to, from, fi) == null) {
      return I18n.t("该输入端子已被占用");
    }
  } else if (fromCtrl && to.kind === "yue_gen") {
    /* 控制线：仅允许连到控制输入端子（端口3）；未指定端子时自动落到控制输入 */
    const ctrlSlot = 3;
    const slot = toIndex == null ? ctrlSlot : Number(toIndex);
    if (slot !== ctrlSlot) return I18n.t("YuE2 音乐节点控制输入端子为端口 3");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === ctrlSlot && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  } else if (!fromCtrl && to.kind === "moss_music") {
    /* MOSS-Music：端口0=音频 / 视频 · 1=自由提问（文本）· 2=控制输入。
       0 号端子收媒体来源（也容忍「路径文本」），1 号只收文本。 */
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && (slot < 0 || slot > 1)) return I18n.t("无效的输入端子");
    if (slot === 0) {
      const mt = wireSourceMediaType(from, fi, to);
      if (mt !== "audio" && mt !== "video" && !wireActsAsText(from, fi, to))
        return I18n.t("音频 / 视频端子需要音频或视频来源（音频 / 视频输入节点、生成节点）");
    } else if (slot === 1) {
      if (!wireActsAsText(from, fi, to)) return I18n.t("自由提问端子需要文本来源");
    }
    if (slot != null) {
      if (
        S.wf.wires.some(
          (w) => !w.rel && w.to === toId && Number(w.toIndex) === slot && !wireFromIsControl(w),
        ) &&
        !inPortReplaceable(to, slot, false)
      )
        return I18n.t("该输入端子已被占用");
    } else if (nextFreeMediaDataSlot(to, from, fi) == null) {
      return I18n.t("该输入端子已被占用");
    }
  } else if (fromCtrl && to.kind === "moss_music") {
    /* 控制线：仅允许连到控制输入端子（端口2）；未指定端子时自动落到控制输入 */
    const ctrlSlot = 2;
    const slot = toIndex == null ? ctrlSlot : Number(toIndex);
    if (slot !== ctrlSlot) return I18n.t("MOSS-Music 节点控制输入端子为端口 2");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === ctrlSlot && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  } else if (!fromCtrl && to.kind === "breeze_gen") {
    /* Breeze 语音：端口0=待合成文本 · 1=参考音频（只接受音频来源）· 2=参考文稿
       （文本，或音频 / 视频输入节点 —— 那时取它的音频与转写）· 3=指令 · 4=控制输入 */
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && (slot < 0 || slot > 3)) return I18n.t("无效的输入端子");
    const srcIsAudio = slot === 1 || slot === 2;
    if (srcIsAudio && isBreezeMediaSource(from)) {
      /* 音频 / 视频输入节点：端口 1 收它的音频输出，端口 2 也收（音频 + 它的转写一起用） */
    } else if (slot === 1) {
      if (wireSourceMediaType(from, fi, to) !== "audio")
        return I18n.t("参考音频端子需要音频来源（音频节点 / 语音生成 / 音乐生成）");
    } else if (!wireActsAsText(from, fi, to)) {
      if (slot === 0) return I18n.t("Breeze 语音生成节点需要文本来源（待合成文本）");
      if (slot === 2) return I18n.t("参考文稿端子需要文本来源或音频 / 视频输入节点");
      return I18n.t("指令端子需要文本来源");
    }
    if (slot != null) {
      if (
        S.wf.wires.some(
          (w) => !w.rel && w.to === toId && Number(w.toIndex) === slot && !wireFromIsControl(w),
        ) &&
        !inPortReplaceable(to, slot, false)
      )
        return I18n.t("该输入端子已被占用");
    } else if (nextFreeMediaDataSlot(to, from, fi) == null) {
      return I18n.t("该输入端子已被占用");
    }
  } else if (fromCtrl && to.kind === "breeze_gen") {
    /* 控制线：仅允许连到控制输入端子（端口4）；未指定端子时自动落到控制输入 */
    const ctrlSlot = 4;
    const slot = toIndex == null ? ctrlSlot : Number(toIndex);
    if (slot !== ctrlSlot) return I18n.t("Breeze 语音生成节点控制输入端子为端口 4");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === ctrlSlot && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  } else if (!fromCtrl && to.kind === "video_gen") {
    /* 布局 v5：端口 0 = 控制输入（固定在最前）· 数据端口 1..N（端口号 ≡ 数据槽号，1=提示词）。
       数据线只能落数据端口，绝不落进端口 0 把控制开关堵死。 */
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && !videoGenIsDataPort(to, slot)) return I18n.t("无效的输入端子");
    if (slot == null) {
      if (nextFreeMediaDataSlot(to, from, fi) == null) return I18n.t("该输入端子已被占用");
    } else if (
      S.wf.wires.some((w) => !w.rel && w.to === toId && Number(w.toIndex) === slot && !wireFromIsControl(w)) &&
      !inPortReplaceable(to, slot, false)
    )
      return I18n.t("该输入端子已被占用");
    if (slot != null) {
      const meta = videoGenPortMeta(to, slot);
      if (!meta) return I18n.t("无效的输入端子");
      if (meta.kind === "text") {
        if (!wireActsAsText(from, fi, to)) return I18n.t("提示词端子需要文本来源");
      } else if (meta.kind === "image") {
        if (!wireActsAsImage(from, fi, to)) return I18n.t("图像端子需要图像来源");
      } else {
        /* video/audio: accept text path or image source carrying a file path */
        if (!wireActsAsText(from, fi, to) && !wireActsAsImage(from, fi, to))
          return I18n.t("音视频端子需要文本路径或媒体文件路径");
      }
    } else {
      /* 自动分配：无法预知槽位类型；文本/图像源都可接受（提示词槽优先文本，参考槽优先媒体路径） */
      if (!wireActsAsText(from, fi, to) && !wireActsAsImage(from, fi, to))
        return I18n.t("视频节点需要文本或图像来源");
    }
  } else if (fromCtrl && to.kind === "video_gen") {
    /* 控制线：固定连到端口 0 的控制输入（v5 起在最前，不随数据槽数变化） */
    const ctrlPort = videoGenControlPort(to);
    const slot = toIndex == null ? ctrlPort : Number(toIndex);
    if (slot !== ctrlPort)
      return I18n.t("视频节点控制输入端子为端口 ") + ctrlPort;
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === ctrlPort && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  } else if (to.kind === "remotion") {
    const contract = remotionContractOf(to);
    if (contract.length) {
      /* 固化端子：契约项各一颗（第 i 项 ↔ 第 i 号口），末位一颗专用控制端子。
         · 控制线只进末位控制口；数据线只进契约项口（控制口拒绝数据线）
         · 同 key 的数组端子（list:true）允许多接；非数组口已被占 → 顶掉旧线（与老口径一致）
         · 类型：image 口要图像来源，audio/video 口要文本路径或媒体来源，文本 / 标量口要文本来源 */
      const nIn = contract.length + 1;
      let slot = toIndex == null ? null : Number(toIndex);
      if (slot == null) {
        if (fromCtrl) slot = contract.length;
        else {
          const free = remotionFreeContractPort(to, from, fi);
          if (free == null)
            return I18n.t("没有匹配的空闲端子：契约里同类型的端子都已被占用");
          slot = free;
        }
      }
      if (!isFinite(slot) || slot < 0 || slot >= nIn) return I18n.t("无效的输入端子");
      if (fromCtrl) {
        if (slot !== contract.length) return I18n.t("控制线只能连到末位的控制输入端子");
        if (inPortWireCount(to, slot) > 0) return I18n.t("控制输入端子已被占用");
        return null;
      }
      if (slot === contract.length) return I18n.t("该端子是控制输入，接不了数据线");
      if (inPortWireCount(to, slot) > 0 && !inPortReplaceable(to, slot, fromCtrl))
        return I18n.t("该输入端子已被占用");
      const c = contract[slot];
      const k = String(c.kind || "text");
      if (k === "image") {
        if (!wireActsAsImage(from, fi, to)) return I18n.t("「") + c.label + I18n.t("」端子需要图像来源");
      } else if (k === "audio" || k === "video") {
        /* 工具 / 函数节点声明成 audio / video 的媒体输出端子，对外就是「这条线的媒体
           类型」（wireSourceMediaType 按端子声明取）。wireActsAsText / wireActsAsImage
           都不认这一类，于是函数节点的视频输出接不进契约里的 video 端子（用户报的
           「函数节点的视频输出未被 remotion 接收」）。按端子级媒体类型补同类型一支。 */
        if (
          !wireActsAsText(from, fi, to) &&
          !wireActsAsImage(from, fi, to) &&
          (typeof wireSourceMediaType !== "function" ||
            wireSourceMediaType(from, fi, to) !== k)
        )
          return I18n.t("「") + c.label + I18n.t("」端子需要媒体文件路径或文本来源");
      } else if (!wireActsAsText(from, fi, to) && !(from && from.imageAsset)) {
        return I18n.t("「") + c.label + I18n.t("」端子需要文本来源");
      }
      return null;
    }
    /* Remotion 无差别端子（数据线与控制线共用同一批口，先到先占）：
       · 端口 0、1、2… 连一条长一条，端口号 = 「第几条输入」，没有专用的描述端子
         （描述已搬进节点 node.text）；
       · 未指定端口（拖线 / agent 不传 toIndex）→ 由 addWire 落第一个空闲端子，这里放行；
       · 指定端口越界 / 已被占 → 报错，connectPortAdvice 会点名占用者并列出可用端子；
       · 类型不设限：文本 / 图片 / 音视频 / 控制信号都收（运行时按来源类型归位，
         见 remotion/main-remotion.js pickPortraitInputs）。 */
    if (toIndex != null) {
      const slot = Number(toIndex);
      const nIn = Number(inputCount(to)) || 0;
      if (!isFinite(slot) || slot < 0 || slot >= nIn) return I18n.t("无效的输入端子");
      /* 无差别端子：已被占 → 顶掉旧线（控制线 / 数据线不分类型，与用户口径一致） */
      if (inPortWireCount(to, slot) > 0 && !inPortReplaceable(to, slot, fromCtrl))
        return I18n.t("该输入端子已被占用");
    }
  } else if (!fromCtrl && isVideoPostKind(to)) {
    /* 视频超分 / 补帧：端口0=控制输入（固定）· 端口1=源视频 · 端口2+=可选素材 */
    const slot = toIndex == null ? null : Number(toIndex);
    if (slot != null && (slot < 1 || slot > videoPostInputCount(to) - 1))
      return I18n.t("无效的输入端子");
    const useSlot = slot != null ? slot : nextFreeVideoPostSlot(to);
    if (useSlot == null) return I18n.t("该输入端子已被占用");
    /* 源视频端子同样接受「声明成音频 / 视频」的端子（工具 / 函数节点的视频输出、
       素材节点的音视频条目）：它们既不是文本也不是图像来源，只按媒体类型这一支放行 */
    if (useSlot === 1) {
      if (
        !wireActsAsText(from, fi, to) &&
        !wireActsAsImage(from, fi, to) &&
        !wireActsAsMedia(from, fi, to)
      )
        return I18n.t("源视频端子需要视频文件路径或文本来源");
    } else if (
      !wireActsAsText(from, fi, to) &&
      !wireActsAsImage(from, fi, to) &&
      !wireActsAsMedia(from, fi, to)
    ) {
      return I18n.t("素材端子需要文本或媒体文件路径");
    }
    if (
      S.wf.wires.some(
        (w) =>
          !w.rel &&
          w.to === toId &&
          Number(w.toIndex) === useSlot &&
          !wireFromIsControl(w),
      ) &&
      !(slot != null && inPortReplaceable(to, useSlot, false))
    )
      return I18n.t("该输入端子已被占用");
  } else if (fromCtrl && isVideoPostKind(to)) {
    /* 控制线：固定连到控制输入端子（端口0） */
    const slot = toIndex == null ? 0 : Number(toIndex);
    if (slot !== 0) return I18n.t("后处理节点控制输入端子为端口 0");
    if (
      S.wf.wires.some(
        (w) => !w.rel && w.to === toId && Number(w.toIndex) === 0 && !wireFromIsControl(w),
      )
    )
      return I18n.t("控制输入端子已被数据线占用");
  }
    /* ── 控制端子只与控制端子相连 · 数据端子只与数据端子相连 ────────────────────
     端子归类走共享真源 app.js 的 inPortIsControl / inPortKindOf（画布端子配色、
     接线校验、拖线落点三处同一份）：控制信号只落控制输入端子，数据线不占控制端子。
     两条边界：
       · 只在**显式指定端子**时判（toIndex != null）。拖到节点身上 / agent connect
         没带端子号时落点由 addWire 决定（数据线跳过控制端子、控制线走
         dataNodeControlInPort），这里不抢着拒绝。
       · 工具 / 函数节点除外 —— 它们的参数端子有自己那套按参数类型逐颗报错的文案
         （「端口 0 是控制输入端子…」「控制信号只能连到控制输入端子（端口 0）」），
         不能抢在它们前面把文案换掉。
     前面对媒体节点的专用分支同样先行（文案与判定顺序不变），这里只收口它们漏掉的错位连接。
  Remotion 除外：它的端子是无差别的（控制线与数据线共用同一批口，先到先占），
  上面那一支已经按「越界 / 已占用」收口，这里不能再按「控制端子只接控制线」拦它。 */
  if (
    !isFnToolNode(to) &&
    to.kind !== "remotion" &&
    toIndex != null &&
    (fromCtrl || inPortIsControl(to, toIndex))
  ) {
    if (fromCtrl) {
      const hit =
        inPortIsControl(to, Number(toIndex)) ||
        inPortKindOf(to, Number(toIndex)) === "control";
      if (!hit)
        return I18n.t("该端子是数据端子，不接受控制连线（控制线只能连到控制输入端子）");
    } else if (inPortIsControl(to, Number(toIndex))) {
      return I18n.t("该端子是控制输入端子，只接受控制连线（数据线请连数据端子）");
    }
  }
  

  /* 节点层：外侧输入与内侧汇流共用 to=host，占用检测只看外侧输入（含控制线） */
  if (to.kind === "super") {
    const toolFixed = isToolNode(to);
    let ti = toIndex == null ? 0 : Number(toIndex);
    if (ti < 0 || ti >= Math.max(1, inputCount(to)))
      return I18n.t("无效的输入端子");
    /* 工具节点（super + tool:true）：端子以参数为准 → 端口 0 只收控制线，
       1..N 是参数端子、只收数据线（控制信号不占参数端子，否则取数通道被堵死）。
       未指定端子（拖线自动落点 / 跨级连接 / agent connect）→ 先按参数挑一个空闲端子：
       节点层那套「顺延已挂线条数」会把内侧汇流也算进去，参数端子会被错占或越界。 */
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
    if (
      superExternalInWiresAll(to).some((w) => Number(w.toIndex) === ti) &&
      !inPortReplaceable(to, ti, fromCtrl)
    )
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
     · 普通参数端子：一端口一线 → 占用的旧线被顶掉（替换语义），不可替换时仍报占用；
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
      !fnToolInPortIsArray(to, ti) &&
      !inPortReplaceable(to, ti, false)
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
    /* 一个条目最多挂一条数据线；已被占 → 同类来源顶掉旧线（替换语义） */
    if (assetInPortOccupied(to, ti) && !inPortReplaceable(to, ti, false))
      return I18n.t("该内容端子已被占用");
    const want = items[ti].type;
    const got = wireSourceMediaType(from, fi, to);
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
  /* 交付节点（kind deliver）：**一个未交文件项 = 一个仅输入端子**（端子标签 = 文件名），
     端子号 = 未交文件项在清单里的顺序（真源见 app-longtask.js 的 ltDeliverPendingItems）。
     · 控制线一律挡在门外：端子是「喂这个文件」的入口，控制线连进来会占掉一个文件端子，
       而且这一项交掉后端子连同控制线一起消失，执行链会莫名断掉。
     · 数据线必须落在一个真实存在的文件端子上（落空 = 该端子号没有对应的待交付文件）。
     通用「按已挂线条数顺延」的占用判定对固定端子本就失真（见下），这里独立收口。 */
  if (to.kind === "deliver") {
    if (fromCtrl)
      return I18n.t("交付节点的端子对应待交付文件，只接受数据连线（控制线请连真正要执行的节点）");
    const pending = typeof window !== "undefined" && window.LT && window.LT.deliverPendingItems ? window.LT.deliverPendingItems(to) : [];
    if (!pending.length) return I18n.t("该交付节点当前没有待交付文件的端子（文件交齐后端子就消失了）");
    const ti = toIndex == null ? null : Number(toIndex);
    if (ti == null || ti < 0 || ti >= pending.length) return I18n.t("无效的输入端子");
    if (inPortWireCount(to, ti) > 0 && !inPortReplaceable(to, ti, false))
      return I18n.t("该输入端子已被占用");
    return null;
  }
  /* 通用占用判定：**所有节点**一律逐号问这条端子上挂没挂线（inPortWireCount），
     与画布端子空闲高亮 inPortIsSpare、addWire 的自动落点共用同一份口径 ——
     三处不同源正是「空闲的端子接不上、接了线的端子显示空闲」这类错觉的根源。
     历史上普通（动态端子）节点按「toIndex < 入线总数」推断占用：端子号一旦有空洞
     （删过中间某条线 / 旧档里显式 toIndex），空洞那颗既显示空闲又报「已被占用」。
     动态节点「连一条自动多一条」由 inputCount 顺延出一颗空闲端子，行为不变。 */
  /* 动态端子节点的专用控制端子允许多条控制线（任一到达即触发一次；要等齐请用闸门），
     不参与下面这条「一颗端子一条线」的通用占用判定。 */
  const dynCtrlShare =
    fromCtrl &&
    typeof isDynCtrlNode === "function" &&
    isDynCtrlNode(to) &&
    typeof dynCtrlInPortIndex === "function" &&
    Number(toIndex) === dynCtrlInPortIndex(to);
  /* 数组式端子（flux3klein_gen 参考图口）：同一颗端子可挂多条数据线 → 不参与占用判定 */
  const manyWireShare =
    !fromCtrl &&
    toIndex != null &&
    typeof inPortAcceptsManyWires === "function" &&
    inPortAcceptsManyWires(to, toIndex);
  if (
    !dynCtrlShare &&
    !manyWireShare &&
    toIndex != null &&
    to.kind !== "music_gen" &&
    to.kind !== "yue_gen" &&
    to.kind !== "video_gen"
  ) {
    if (inPortWireCount(to, toIndex) > 0 && !inPortReplaceable(to, toIndex, fromCtrl))
      return I18n.t("该输入端子已被占用");
  }
  /* 现有判定全部通过后，最后一道：文件来源喂不进「吃不下该文件」的处理节点。
     放在末尾 = 既有错误（回路 / 占用 / 类型）优先，原判定顺序逐字不变；
     走到这里说明这条线本会接通，才提示「工具构建」这条出口。
     判定真源在 app-toolbuild.js：该模块缺失（源码切片沙箱 / 加载失败）→ 按「不拦」回落，
     行为与未启用工具构建前逐字一致。 */
  if (!fromCtrl && typeof fileWireSupportError === "function") {
    const fileErr = fileWireSupportError(from, fi, to);
    if (fileErr) return fileErr;
  }
  return null;
}

/* 连线预检建议（connectError 判负后的结构化补充，只读、绝不改判定）：
   给出目标节点的候选端子清单与「正确接法」建议，让一次往返就能改对。
   典型场景：单数据端子的媒体节点（video_gen）那个端子已被占，
   点名占用者并建议「用 super 汇聚或拆节点」，而不是只回一句「已被占用」。 */
/* 单数据端子的媒体节点：端子被占时建议「用 super 汇聚或拆节点」。
     remotion 不在此列 —— 它的输入端子与 proc_image 同为泛用增量
   （连一条多一条），多输入本就接得下；对它们说「请用 super 汇聚」是错的指路。 */
const SINGLE_DATA_IN_KINDS = [
  "video_gen", "music_gen", "proc_image",
];
function connectPortAdvice(fromId, toId, toIndex, fromIndex, err) {
  /* 只对「端子 / 占用 / 类型」类错误给候选清单：回路、跨壳违规这些与端口无关，
     补一堆端子反而干扰判断。 */
  if (
    !err ||
    !/输入端子|端子需要|参数|控制输入|不接受输入|空闲|无效的输入/.test(String(err))
  )
    return null;
  const from = nodeById(fromId),
    to = nodeById(toId);
  if (!from || !to) return null;
  if (to.kind === "wait_file" || to.kind === "timer" || to.ro) return null;
  const ins = nodePortList(to, "in");
  if (!ins.length) return null;
  const data = ins.filter((p) => p.kind !== "control");
  const free = data.filter((p) => !p.connectedTo);
  const label = (p) => "端口" + p.index + "「" + p.name + "」(" + p.kind + ")";
  const parts = [];
  let occupant = null;
  if (toIndex != null) {
    const hit = ins.filter((p) => p.index === Number(toIndex))[0];
    if (hit && hit.connectedTo && hit.connectedTo.length) occupant = hit;
  } else if (data.length && !free.length) {
    occupant = data[0];
  }
  if (occupant && occupant.connectedTo && occupant.connectedTo.length) {
    const names = occupant.connectedTo
      .map((l) => l.node)
      .filter(Boolean)
      .join("、");
    parts.push(
      "端口" + occupant.index + "「" + occupant.name + "」已被" +
        (names || "上游") + "占用",
    );
  }
  if (free.length) {
    parts.push("可用数据端子：" + free.map(label).join("、"));
  } else if (data.length) {
    parts.push("已无空闲数据端子");
    if (SINGLE_DATA_IN_KINDS.indexOf(to.kind) >= 0 || data.length === 1)
      parts.push("多输入请用 super 汇聚或拆节点");
  } else {
    parts.push("该节点没有数据输入端子（控制线走端口 0）");
  }
  return { ports: ins, free, suggestion: parts.join("；") };
}

/* 视频超分 / 补帧节点：找下一个空闲数据槽（端口1=源视频优先，其次端口2+ 可选素材）；
   控制槽（端口0）不参与；无空闲返回 null。 */
function nextFreeVideoPostSlot(node) {
  if (!node || !S.wf) return null;
  const occupied = (i) =>
    (S.wf.wires || []).some(
      (w) => !w.rel && w.to === node.id && Number(w.toIndex) === i && !wireFromIsControl(w),
    );
  if (!occupied(1)) return 1;
  const n = Math.max(2, videoPostInputCount(node));
  for (let i = 2; i < n; i++) if (!occupied(i)) return i;
  return null;
}

/* Remotion 固化端子：按契约挑数据落点（与 connectError 校验同一份口径）。
 *   · 优先「同类型的第一个空闲契约端子」；
 *   · 该端子是数组端子（list:true）时允许多条线挂同一颗；
 *   · 没有同类型空位 → null（不硬塞到别的类型口，让用户自己接对）。
 * 未固化（无契约）返回 null，走原来的无差别动态端子落点。 */
function remotionFreeContractPort(node, from, fromIndex) {
  const contract = remotionContractOf(node);
  if (!contract.length || !S.wf) return null;
  const m =
    typeof wireSourceMediaType === "function"
      ? wireSourceMediaType(from, fromIndex, node)
      : "";
  const want = m === "image" || m === "audio" || m === "video" ? m : "text";
  for (let i = 0; i < contract.length; i++) {
    const c = contract[i];
    const k = String(c.kind || "text");
    const sameFamily = want === "text" ? k !== "image" && k !== "audio" && k !== "video" : k === want;
    if (!sameFamily) continue;
    const used = (S.wf.wires || []).some(
      (w) => !w.rel && w.to === node.id && Number(w.toIndex) === i && !wireFromIsControl(w),
    );
    if (!used || c.list) return i;
  }
  return null;
}

/* 视频 / 音乐节点：找下一个空闲数据槽（跳过控制槽与已占槽）；无则 null。
   from 存在时按来源类型优先匹配：文本源 → 提示词槽；图像源 → 参考图槽。
   fromIndex：来源真正接出来的那个端子 —— 工具 / 函数节点必须按端子判定类型，
   其余节点仍只看 0 号端子（wireActsAsText / wireActsAsImage 内部同口径）。
   video_gen：端口 0 = 控制输入（固定在最前），数据端口 1..N（端口号 ≡ 数据槽号）。 */
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
  if (node.kind === "yue_gen") {
    /* 端口0=风格提示词 · 端口1=歌词 · 端口2=ABC 谱（可选）；端口3=控制输入不占数据槽 */
    for (let i = 0; i < 3; i++) if (!occupied(i)) return i;
    return null;
  }
  if (node.kind === "moss_music") {
    /* 端口0=音频 / 视频 · 1=自由提问（端口2=控制输入，不占数据槽）。
       媒体线优先进 0，文本线优先进 1。 */
    const mt = wireSourceMediaType(from, fromIndex, node);
    const first = mt === "audio" || mt === "video" ? 0 : 1;
    if (!occupied(first)) return first;
    const other = first === 0 ? 1 : 0;
    return !occupied(other) ? other : null;
  }
  if (node.kind === "breeze_gen") {
    /* 端口0=待合成文本 · 1=参考音频 · 2=参考文稿 · 3=指令（四个数据槽，端口4=控制输入不占数据槽）。
       音频来源优先落参考音频槽（1），文本来源按「空闲的文本槽」依次落位。 */
    const fromAudio = wireSourceMediaType(from, fromIndex, node) === "audio";
    if (fromAudio) return !occupied(1) ? 1 : null;
    for (const i of [0, 2, 3]) if (!occupied(i)) return i;
    return null;
  }
  if (node.kind !== "video_gen") return null;
  /* video_gen（v5）：端口 0 = 控制输入，不参与数据落点；数据端口 1..N 与**数据槽号同号**
     （1=提示词 P · 2.. 参考图 / 帧 / 视频 / 音频 / 衔接）。按槽号挑类型，
     回给连线的端口号就是同号（历史上这里 ±1 换算，是端子错位的根源）。 */
  const nSlots = videoGenDataSlotsTotal(node);
  const fromImg = wireActsAsImage(from, fromIndex, node);
  const slotKind = (s) => {
    const m = videoGenSlotMeta(node, s);
    return m ? m.kind : "";
  };
  const anyFree = (start) => {
    for (let s = start; s <= nSlots; s++) if (!occupied(s)) return s;
    return null;
  };
  /* 图像源：优先参考图 / 帧槽（提示词槽只接受文本，端口 1 起才是图） */
  if (fromImg) {
    for (let s = 2; s <= nSlots; s++) {
      if (occupied(s)) continue;
      if (slotKind(s) === "image") return s;
    }
    /* 无空闲参考图槽时回退任意空闲数据槽（仍不碰提示词槽与端口 0） */
    return anyFree(2);
  }
  /* 音频 / 视频源：优先落同类型的参考槽（A# / V#）——否则它算「文本路径来源」，
     会被下面那条规则挤进提示词槽，H3 的参考音频 / 参考视频端子形同虚设 */
  const fromMedia = wireSourceMediaType(from, fromIndex, node);
  if (fromMedia === "audio" || fromMedia === "video") {
    for (let s = 2; s <= nSlots; s++) {
      if (occupied(s)) continue;
      if (slotKind(s) === fromMedia) return s;
    }
  }
  /* 文本源：优先提示词槽（端口 1 = 数据槽 1），其次任意空闲数据槽（图 / 视频 / 音频槽也接受文本路径） */
  if (!occupied(1)) return 1;
  return anyFree(2);
}

function addWire(fromId, toId, toIndex, opts) {
  opts = opts || {};
  /* ── 跨节点层硬闸（落线总闸·唯一一处）──────────────────────────
     一条数据线只允许落在「同一层」或「节点层 ↔ 它的直属子节点」这条边界上。
     任何入口（agent 的 connect / superConnect、手拖 connect、粘贴、装箱 / 拆箱、
     读档迁移）都必须过这里，所以把判定钉在落线这一秒：越界的线**根本进不了**
     S.wf.wires。需要跨层的调用方要先走逐层桥接（boundaryBridgePlan →
     applyBoundaryBridgePlan），它产出的每一段都天然合法。 */
  const gateFrom = nodeById(fromId);
  const gateTo = nodeById(toId);
  if (gateFrom && gateTo && !wireKeepsLayerRule(gateFrom, gateTo)) return false;
  const cur = allWiresTo(toId).length;
  let idx = toIndex == null ? cur : toIndex;
  const toN = nodeById(toId);
  const fromN = nodeById(fromId);
  const fromIdx = Number(opts.fromIndex || 0);
  /* 交付节点：落点 = 第一个「没接线且对应一个待交付文件」的端子（端子号 = 未交文件项顺序，
     交掉的项不再占端子）。用入线总数当落点会落到「被已交文件空出来的错位端子号」上，
     线接到一个不存在的端子上（页面上看不见、也永远取不到文件）。 */
  if (toIndex == null && toN && toN.kind === "deliver" && !(fromN && isControlKind(fromN))) {
    const pending = window.LT && window.LT.deliverPendingItems ? window.LT.deliverPendingItems(toN) : [];
    for (let s = 0; s < pending.length; s++) {
      if (inPortWireCount(toN, s) === 0) {
        idx = s;
        break;
      }
    }
  }
  /* Remotion 固化端子：数据线按契约类型挑口，控制线落末位专用控制端子 */
  if (toIndex == null && toN && toN.kind === "remotion" && remotionContractOf(toN).length) {
    if (fromN && isControlKind(fromN)) idx = remotionContractOf(toN).length;
    else {
      const free = remotionFreeContractPort(toN, fromN, fromIdx);
      if (free != null) idx = free;
    }
  }
  /* 数组式端子（flux3klein_gen 的参考图口）：图像数据线一律落到声明 image 的那颗数组端子
     并与已有线共存 —— 不按「入线总数」顺延（第二张参考图会落到端口 2 的控制号上，
     永远进不了参考图数组）。 */
  if (
    toIndex == null &&
    toN &&
    fromN &&
    !isControlKind(fromN) &&
    typeof inPortMultiWireIndexes === "function" &&
    inPortMultiWireIndexes(toN).length &&
    wireActsAsImage(fromN, fromIdx, toN)
  ) {
    const slot = inPortMultiWireIndexes(toN).find((i) => inPortKindOf(toN, i) === "image");
    if (slot != null) idx = slot;
  }
  if (toIndex == null && toN && !hasFixedInPorts(toN)) {
    /* 动态端子节点：落点 = 第一个**空闲**端子号（与 inPortIsSpare / connectError 同一口径）。
       端子号连续时它与「入线总数」完全等价（行为不变）；有空洞时补空洞，
       而不是把线堆到空洞之后 —— 否则空洞那颗端子永远接不上。
       控制线例外：控制端子只与控制端子相连 → 落「数据端子之后那颗」控制端子
       （dataNodeControlInPort，与 connectError 同一份判定），绝不占端口 0 的提示词入口。 */
    if (fromN && isControlKind(fromN)) {
      const ctrlPort = typeof dataNodeControlInPort === "function" ? dataNodeControlInPort(toN) : null;
      if (ctrlPort != null) idx = ctrlPort;
    } else {
      const free = firstFreeInPortIndex(toN);
      if (free != null) idx = free;
      /* 数据线绝不落进控制端子（画布上那颗 .ctrl）；挑到控制端子就往后挪一颗 */
      if (inPortKindOf(toN, idx) === "control") {
        const next = (Number(inputCount(toN)) || 0) - 1;
        if (next > idx && inPortKindOf(toN, next) !== "control") idx = next;
      }
    }
  }
  if (
    toIndex == null &&
    toN &&
    (toN.kind === "video_gen" ||
      toN.kind === "music_gen" ||
      toN.kind === "yue_gen" ||
      toN.kind === "moss_music" ||
      isVideoPostKind(toN))
  ) {
    if (fromN && isControlKind(fromN)) {
      /* 控制线：video_gen 固定落到端口 0 的控制输入（第一个端子）；
         music_gen 落到端口2；yue_gen 落到端口3。
         （此前漏了后处理两支：控制线按「入线总数」顺延 → 第二根线落到端口 1 被 connectError
         判「后处理节点控制输入端子为端口 0」，▶ 永远接不上。）
           remotion 不在此列：它没有固定控制端子，控制线与数据线
         一律落第一个空闲端子（见上面动态端子落点）。 */
      idx =
        toN.kind === "music_gen"
          ? 2
          : toN.kind === "yue_gen"
            ? 3
            : toN.kind === "moss_music"
              ? 2
            : toN.kind === "video_gen"
              ? videoGenControlPort(toN)
              : 0;
    } else {
      /* 数据线：落到空闲数据槽（跳过端口 0 的控制输入），避免误占控制端子。
         未列这一支时它落到「入线总数」= 端口 0，正是「第一个没接的控制端子被上色」的元凶。
         来源是工具 / 函数节点时按它真正接出来的那个端子挑槽（图像端子 → 参考图槽）。 */
      const free = isVideoPostKind(toN)
        ? nextFreeVideoPostSlot(toN)
        : nextFreeMediaDataSlot(toN, fromN, fromIdx);
      if (free != null) idx = free;
    }
  }
  /* 工具 / 函数节点：端子数由参数钉死（输入 0=控制 · 1..N=参数；输出 0..M-1=参数 · 末位=控制），
     不能像节点层那样「按已挂线条数」顺延 → 未指定端子时走 fnToolInPortIndex 这一套落点
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
  /* 完全相同的线已经在画布上 → 幂等返回（任何入口都不会落下第二条重复线） */
  if (identicalWireExists(fromId, toId, idx, fromIdx)) return true;
  S.wf.wires.push({
    id: uid("w"),
    from: fromId,
    to: toId,
    toIndex: idx,
    fromIndex: fromIdx,
    pinned: !!opts.pinned,
  });
  /* 交付节点的线要记住自己喂的是哪个待交付文件（文件项 id）：端子会随着「交掉一项」
     消失并让其余端子重排，线按 id 重绑才不会错指到别的文件上（见 app-longtask.js 的
     ltDeliverRebindWires）。这里在建线的那一刻就登记归属，旧档靠 rebind 现补。 */
  if (toN && toN.kind === "deliver" && window.LT && window.LT.deliverPortItem) {
    const it = window.LT.deliverPortItem(toN, idx);
    if (it && it.id != null) S.wf.wires[S.wf.wires.length - 1].ltItem = String(it.id);
  }
  /* 动态端子节点：数据槽一变，专用控制端子的号就跟着变 —— 把已有的控制线挪到新号
     （数据线一个号都不改）。控制线刚落在这颗口上时这里是无操作。 */
  if (toN && typeof syncDynCtrlWires === "function") syncDynCtrlWires(toN);
  /* 连线落定的那一刻就叫一次「交付连线自动收下」：连到交付节点的线若上游已经产出文件，
     这一件当场算已交 —— 用户不必再去条带右栏点一次「从画布连线取」。
     （**只收线、不放行**：收齐之后仍由用户点「确认交付完成」往下走。）
     交付文件自动从连线取（本次需求本体）：连线是控制/数据都有的动作，改图不走引擎主循环，
     所以在这里显式叫；节流 + 重入闸在 LT 侧，连一次线只干一次活。 */
  if (toN && toN.kind === "deliver" && window.LT && typeof window.LT.autoCollectSoon === "function") window.LT.autoCollectSoon();
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
     判定媒体（工具 / 函数节点的图像端子 → 自动 .png）。
     保存 → 保存 例外：下游保存拿到的是上游保存的结果，自动打开会在上游每次落盘时
     级联再写一遍（还可能来回写）—— 不置 auto、也不替它定后缀，交给用户手动 ▶。 */
  if (
    to &&
    (isSaveNode(to)) &&
    from &&
    !isControlKind(from) &&
    !isSaveNode(from)
  ) {
    /* PDF 生成只有「点 ▶ 才生成」一种口径：接线不打开自动保存、不因此落盘 */
    if (to.kind !== "save_pdf") to.auto = true;
    applySavePathExt(to);
  }
  if (to && to.kind === "global" && from && !isControlKind(from)) {
    const filters = normalizeGlobalTagFilter(to);
    if (filters.length) stampTagsOntoGlobalWired(to, filters);
  }
  /* 音视频输入节点的内容随入线改变（继承 / 拔线恢复）→ 就地重建这些卡片 */
  refreshMediaInputCards([toId, fromId]);
  /* 表单输入：线一落定就把上游**当前**内容吸收进表单，然后断开这条线（一次性 @引用，
     见 renderer/app-input-form.js 的 absorbWire）。钩子只钉在「落线」这一秒，
     不在 render 里反复检查；吸过一次线就没了 → 再进这里是幂等无操作。
     撤销：落线前调用方已经 pushHistory（connect 等），这里不再记第二笔，
     于是「写入的值 + 摘掉的线」落在同一步撤销里。 */
  if (toN && toN.kind === "input_form" && window.IF && typeof window.IF.absorbWire === "function") {
    const w = S.wf.wires.find(
      (x) => x && !x.rel && x.from === fromId && x.to === toId,
    );
    if (w) {
      const p = window.IF.absorbWire(toN, w, { history: false });
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  }
  /* 本地语音转写（官方本地 SenseVoice）：把音频 / 视频节点接到文字处理节点 → 那个节点
     运行时先替音频节点把转好文字（renderer/app-asr.js 的 asrEnsureForRun），再取它的文字。
     连线本身不弹任何窗、也不当场转（转录按钮在音频节点上）：模型权重由 dsh 运行时自己下，
     首次识别时自动开始，进度在状态栏话筒 / 音频节点 /「语音模型」窗里都看得见。 */
}

/* ============ 关系线（rel）：仅表示模块/元素间关系，不参与数据流 ============ */
function relConnectError(fromId, toId) {
  const from = nodeById(fromId),
    to = nodeById(toId);
  if (!from || !to) return I18n.t("节点不存在");
  if (fromId === toId) return I18n.t("不能把关系线连到自身");
  /* 允许同一层级互连，或父节点层 ↔ 直属子元素（包含关系） */
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
  const fromNode = nodeById(fromId);
  const toNode = nodeById(toId);
  /* 端子归一：数据线落到越界 / 控制端子时改落最近空闲的数据端子（用户手工拖线 / API 同一口径） */
  const ti = dataInPortIndexForWire(toNode, fromNode, fromIndex, toIndex);
  /* 完全相同的线再连一次 = 无操作：静默忽略，不弹「这两节点已连接」（替换语义的配套口径）。
     表单输入例外：上次连进来时上游还没值 → 线留着没吸 → 再拖一次同一根线就是「再试一次」
     （有值就吸收并断线，还没值就再提示一次，不会把线吞掉）。 */
  if (identicalWireExists(fromId, toId, ti, fromIndex)) {
    if (toNode && toNode.kind === "input_form" && window.IF && typeof window.IF.absorbWire === "function") {
      const w = S.wf.wires.find(
        (x) =>
          x &&
          !x.rel &&
          x.from === fromId &&
          x.to === toId &&
          Number(x.fromIndex || 0) === Number(fromIndex || 0),
      );
      /* 这一支没有「刚落线」的那笔撤销（线是上一次留着的）→ 让 absorbWire 自己记一笔：
         摘线 + 写入的值落在同一步撤销里 */
      if (w) {
        const p = window.IF.absorbWire(toNode, w);
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    }
    return;
  }
  /* 跨节点层（硬规则）：不直连，自动改写成经边界端子的逐层桥接 —— 手拖与 agent 同一口径，
     改写是静默的（线本身就说明了接法，不再弹提示打扰）。 */
  if (fromNode && toNode && !wireKeepsLayerRule(fromNode, toNode)) {
    const plan = boundaryBridgePlan(fromNode, toNode, fromIndex, ti);
    if (plan.error) {
      toast(plan.error, "warn");
      return;
    }
    if (!plan.segs.some((seg) => !bridgeSegExists(seg))) return; /* 已经这样接过：幂等，静默 */
    pushHistory();
    const res = applyBoundaryBridgePlan(plan.segs);
    if (res.error) {
      toast(res.error, "warn");
      return;
    }
    renderCanvas();
    scheduleSave(true);
    renderStatus();
    /* 桥接落线时也可能顶掉边界端子上的旧线：多颗端子汇总成一条提示 */
    if (res.replaced && res.replaced.length) toast(replaceWiresToastText(res.replaced), "ok");
    return;
  }
  const err = connectError(fromId, toId, ti, fromIndex);
  if (err) {
    toast(err, "warn");
    return;
  }
  pushHistory();
  /* 已占用的端子 → 先顶掉旧的同类线（与落线同一步撤销，不删任何节点） */
  const replaced = dropWiresForReplace(toNode, ti, isControlKind(fromNode));
  addWire(fromId, toId, ti, { notify: true, save: false, fromIndex: fromIndex || 0 });
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  if (replaced.length) toast(replaceWiresToastText(replaced), "ok");
}

/* ── 组线（本次需求）──────────────────────────────────────────────
   画布组框标题栏那颗 □ 拖出来的一条线：来源是「组」，目标是智能节点
   （agent_task / proc_text 智能模式）的组输入端子（GROUP_IN_INDEX）。
   组不是节点 —— w.from 记成 "grp:<组id>"，真源在 w.grp 上；因此：
     · 它不参与上游补跑、取值、端口占用（那些链路一律走 nodeById，取不到就跳过）；
     · 运行期的用法只有一处：把组内节点整理成一份清单塞进该轮任务上下文
       （见 groupContextBlock）。 */
function groupConnectError(gid, toId) {
  const g = typeof groupById === "function" ? groupById(gid) : null;
  const to = nodeById(toId);
  if (!g) return I18n.t("组不存在（可能已被解散）");
  if (!to) return I18n.t("节点不存在");
  if (typeof isSmartGroupPortNode === "function" && !isSmartGroupPortNode(to))
    return I18n.t("组线只能接到智能节点（智能任务 / 文本智能模式）的「组」输入端子");
  return null;
}
function connectGroup(gid, toId) {
  const err = groupConnectError(gid, toId);
  if (err) {
    toast(err, "warn");
    return;
  }
  const key = String(gid);
  if (
    (S.wf.wires || []).some(
      (w) => isGroupWire(w) && String(w.grp) === key && w.to === toId,
    )
  )
    return; /* 同一个组已经接到这颗节点：幂等 */
  pushHistory();
  S.wf.wires.push({
    id: uid("w"),
    from: groupWireFromId(key),
    to: toId,
    toIndex: GROUP_IN_INDEX,
    fromIndex: 0,
    grp: key,
  });
  clearDownstream(toId);
  renderCanvas();
  scheduleSave(true);
  renderStatus();
}
/* 节点层的「组」输出端子（哨兵号 GROUP_OUT_INDEX = 9003）→ 智能节点的组输入端子。
   与组线同一套语义、同一条注入链路：线不参与数据流，只在运行期把「层内部节点 + 结构」
   清单塞进任务上下文。线的来源是层自己（它确实是节点），另在 w.sup 上记一份。 */
function layerGroupConnectError(supId, toId) {
  const host = nodeById(supId);
  const to = nodeById(toId);
  if (!host || host.kind !== "super") return I18n.t("节点层不存在（可能已被删除）");
  if (!to) return I18n.t("节点不存在");
  if (typeof isSmartGroupPortNode === "function" && !isSmartGroupPortNode(to))
    return I18n.t("组线只能接到智能节点（智能任务 / 文本智能模式）的「组」输入端子");
  if (!layerChildNodes(host).length) return I18n.t("该节点层里还没有节点");
  return null;
}
function connectLayerGroup(supId, toId) {
  const err = layerGroupConnectError(supId, toId);
  if (err) {
    toast(err, "warn");
    return;
  }
  const key = String(supId);
  if (
    (S.wf.wires || []).some(
      (w) => isSuperGroupWire(w) && String(w.sup) === key && w.to === toId,
    )
  )
    return; /* 同一层已经接到这颗节点：幂等 */
  pushHistory();
  S.wf.wires.push({
    id: uid("w"),
    from: key,
    fromIndex: GROUP_OUT_INDEX,
    to: toId,
    toIndex: GROUP_IN_INDEX,
    sup: key,
  });
  clearDownstream(toId);
  renderCanvas();
  scheduleSave(true);
  renderStatus();
}
/* 某层里**直属**的节点（不递归）：清单的层级缩进按父子关系一层层展开 */
function layerChildNodes(host) {
  if (!host) return [];
  return (S.wf.nodes || []).filter(
    (n) => n && typeof nodeParentSuperId === "function" && nodeParentSuperId(n) === host.id,
  );
}
/* 某层内部（含嵌套子层）的节点总数：用来判「层已经空了」→ 摘线 */
function layerNodeCount(host) {
  if (!host) return 0;
  let n = 0;
  for (const kid of layerChildNodes(host)) {
    n++;
    if (kid.kind === "super") n += layerNodeCount(kid);
  }
  return n;
}
/* 摘掉指向某个组（或某个节点层 / 已经不存在的来源）的全部组线；返回摘掉的条数。
   组与节点层共用一套线上表示（w.grp / w.sup），所以这里两个键都认 ——
   解散组、删除节点层、切断组输出端子走的是同一个入口。 */
function removeGroupWires(gid) {
  const key = String(gid || "");
  if (!S.wf || !Array.isArray(S.wf.wires)) return 0;
  const before = S.wf.wires.length;
  S.wf.wires = S.wf.wires.filter(
    (w) =>
      !(
        isGroupWire(w) &&
        (!key || String(w.grp || "") === key || String(w.sup || "") === key)
      ),
  );
  return before - S.wf.wires.length;
}
/* 摘掉接到某颗节点上的全部组线（右键组输入端子 = 切断这一口） */
function removeGroupWiresFromNode(nodeId) {
  if (!S.wf || !Array.isArray(S.wf.wires)) return 0;
  const before = S.wf.wires.length;
  S.wf.wires = S.wf.wires.filter(
    (w) => !(isGroupWire(w) && w.to === nodeId),
  );
  return before - S.wf.wires.length;
}
/* 读档 / 撤销后自愈：来源已经不在的组线一律摘掉 ——
   组：被解散 / 被删；节点层：被删 / 已经被搬空（层里一个节点都没有 = 清单永远是空的）。 */
function pruneOrphanGroupWires(wfIn) {
  /* 可传入目标画布对象：切画布时新图还没进 S.wf（此刻 S.wf 仍是上一张），
     按 S.wf 判会看错图 —— 既修不了新图的孤儿线，还可能误剪旧图。 */
  const wf = wfIn && Array.isArray(wfIn.wires) ? wfIn : S.wf;
  if (!wf || !Array.isArray(wf.wires)) return 0;
  const alive = new Set(
    (wf.groups || []).map((g) => String((g && g.id) || "")).filter(Boolean),
  );
  const nodes = wf.nodes || [];
  const aliveSup = new Set(
    nodes
      .filter(
        (n) =>
          n &&
          n.kind === "super" &&
          nodes.some((k) => k && k.parentSuperId === n.id),
      )
      .map((n) => String(n.id)),
  );
  const before = wf.wires.length;
  wf.wires = wf.wires.filter(
    (w) =>
      !isGroupWire(w) ||
      (w.sup ? aliveSup.has(String(w.sup)) : alive.has(String(w.grp))),
  );
  return before - wf.wires.length;
}
/* 清单里的一行：标题 · 类型 · 描述(note) · 节点 id（缩进由调用方给） */
function groupListRow(n, indent) {
  const note = String((n && n.note) || "").replace(/\s+/g, " ").trim();
  return (
    indent +
    "- " +
    (n.title || I18n.t("未命名节点")) +
    " · " +
    nodeKindLabel(n) +
    (note ? " · " + (note.length > 80 ? note.slice(0, 80) + "…" : note) : "") +
    " · id:" +
    n.id
  );
}
/* 节点层来源：层自己一行，层内部节点按嵌套缩进逐层展开（这就是「结构」） */
function pushLayerListRows(host, depth, seen, rows) {
  if (!host || seen.has(host.id)) return;
  seen.add(host.id);
  rows.push(groupListRow(host, "  ".repeat(depth)));
  pushLayerChildrenOnly(host, depth + 1, seen, rows);
}
/* 递归展开某一层内部的节点（不含该层自己那一行） */
function pushLayerChildrenOnly(host, depth, seen, rows) {
  if (!host) return;
  for (const kid of layerChildNodes(host)) {
    if (seen.has(kid.id)) continue;
    seen.add(kid.id);
    rows.push(groupListRow(kid, "  ".repeat(depth)));
    if (kid.kind === "super") pushLayerChildrenOnly(kid, depth + 1, seen, rows);
  }
}
/* 这条正文 = 该智能节点接到的全部来源（组 + 节点层，合并一份清单；层来源按嵌套缩进展开）。
   只给「清单」不给正文：每行 标题 + 类型 + 描述(note) + 节点 id，模型要看正文
   自己用 mtnode_canvas_get 按 id 取（智能节点运行时已放开读画布）。
   组里含本节点自己时照列（组往往就是围着它建的），只按节点 id 去重。 */
function groupContextBlock(node) {
  if (!node || typeof isSmartGroupPortNode !== "function" || !isSmartGroupPortNode(node))
    return "";
  const wires = (S.wf && S.wf.wires ? S.wf.wires : []).filter(
    (w) => isGroupWire(w) && w.to === node.id,
  );
  if (!wires.length) return "";
  const seen = new Set();
  const rows = [];
  for (const w of wires) {
    if (isSuperGroupWire(w)) {
      const host = nodeById(w.sup);
      if (!host || host.kind !== "super") continue;
      pushLayerListRows(host, 0, seen, rows);
      continue;
    }
    const g = typeof groupById === "function" ? groupById(w.grp) : null;
    if (!g) continue;
    if (typeof ensureGroupArrays === "function") ensureGroupArrays(g);
    for (const nid of g.nodeIds || []) {
      const n = nodeById(nid);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      rows.push(groupListRow(n, ""));
    }
  }
  if (!rows.length) return "";
  return (
    I18n.t(
      "\n\n【组输入】以下节点来自你接入的组 / 节点层（缩进表示层级结构；要正文时用 mtnode_canvas_get 按 id 取）：",
    ) +
    "\n" +
    rows.join("\n")
  );
}

/* ────────────────────────────────────────────────────────────
   跨节点层连接（手拖、agent 内置工具同一口径）
   不同层级 / 不同节点层内的任意两颗节点：由 boundaryBridgePlan 出一份逐层对齐的
   计划，每一段只连「直属父子」，再整份一起落线；任一段不合法就整对拒绝。
   ──────────────────────────────────────────────────────────── */
function superAncestorChainOf(n) {
  /* 自内向外收集 n 的所有节点层祖先（含最近的），不含 n 自身 */
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

/* ══════════ 跨节点层：逐层边界端子桥接（硬规则的唯一实现） ══════════
   规则：一条数据线只允许落在「同一层」（parentSuperId 相同）或「节点层 ↔ 它的
   直属子节点」这条边界上。跨层一律自动改写成逐层对齐的链：
     内 →（直属壳的输出端子）… →（最外壳）→（最外壳）… →（目标壳的输入端子）→ 内
   口径：先出计划（boundaryBridgePlan）→ 逐段预检 → 一起落线；任一段不合法就
   整对回滚，绝不留半截线（回执里的 connected 只认真正落进 S.wf.wires 的线）。 */

/** 这条线是否落在合法的层边界上（同层 / 直属父子）。与 app.js 的
    wireKeepsSuperBoundary 同一口径：那边按线对象判（清理历史脏线用），这里按节点判。 */
function wireKeepsLayerRule(fromNode, toNode) {
  if (!fromNode || !toNode) return false;
  if (fromNode.kind === "super" && nodeParentSuperId(toNode) === fromNode.id) return true;
  if (toNode.kind === "super" && nodeParentSuperId(fromNode) === toNode.id) return true;
  return nodeParentSuperId(fromNode) === nodeParentSuperId(toNode);
}

/** 两颗节点之间「逐层对齐」的路径（含两端）：相邻两步只差一层。
    同层时只有两个元素；两侧没有共同祖先时在顶层直接相连。 */
function layerPathBetween(fromNode, toNode) {
  const upFrom = [fromNode].concat(superAncestorChainOf(fromNode)); /* 内 → 外 */
  const upTo = [toNode].concat(superAncestorChainOf(toNode));
  const posInTo = new Map();
  upTo.forEach((n, i) => posInTo.set(n.id, i));
  let upIdx = -1;
  let toIdx = -1;
  for (let i = 0; i < upFrom.length && upIdx < 0; i++) {
    if (posInTo.has(upFrom[i].id)) {
      upIdx = i;
      toIdx = posInTo.get(upFrom[i].id);
    }
  }
  if (upIdx < 0) {
    /* 两侧没有共同祖先：各自走到顶层，两条顶层节点直接相连（同层，合法） */
    return upFrom.concat(upTo.slice().reverse());
  }
  const lca = upFrom[upIdx];
  /* 公共祖先恰好是一端（「节点 ↔ 它的壳」这类直连）：路径含它本身 */
  if (lca.id === fromNode.id) return [fromNode].concat(upTo.slice(0, toIdx).reverse());
  if (lca.id === toNode.id) return upFrom.slice(0, upIdx + 1);
  /* 两端都严格在公共祖先内部：**不含**壳本身 —— 走到壳的两侧直属子节点为止，
     两个子节点之间才是同层直连（同壳兄弟节点因此不会被绕到壳端子上） */
  return upFrom.slice(0, upIdx).concat(upTo.slice(0, toIdx).reverse());
}

/** 壳的「外侧输出端子」：内部子节点汇入的那一侧（工具节点的端子 = 参数表）。 */
function superFreeOutPort(sup) {
  if (!sup) return null;
  if (isToolNode(sup)) {
    if (typeof fnToolFreePortIndex !== "function") return null;
    return fnToolFreePortIndex(sup, "out", false);
  }
  const taken = new Set();
  for (const w of (S.wf && S.wf.wires) || []) {
    if (w.rel || w.to !== sup.id) continue;
    const src = nodeById(w.from);
    if (src && nodeParentSuperId(src) === sup.id) taken.add(Number(w.toIndex) || 0);
  }
  let i = 0;
  while (taken.has(i)) i++;
  return i;
}

/** 壳的「外侧输入端子」：外部喂进来的那一侧（内部汇入线不算）。 */
function superFreeInPort(sup) {
  if (!sup) return null;
  if (isToolNode(sup)) {
    if (typeof fnToolFreePortIndex !== "function") return null;
    return fnToolFreePortIndex(sup, "in", false);
  }
  const taken = new Set();
  for (const w of (S.wf && S.wf.wires) || []) {
    if (w.rel || w.to !== sup.id) continue;
    const src = nodeById(w.from);
    if (src && nodeParentSuperId(src) === sup.id) continue; /* 内→壳：走输出侧 */
    taken.add(Number(w.toIndex) || 0);
  }
  let i = 0;
  while (taken.has(i)) i++;
  return i;
}

/** 这颗子节点是否已经汇入过该壳（返回当时占的那颗对外输出端子号，没汇过 = null）。
    幂等靠它：同一对重复桥接时沿用原端子，不会再新开一颗、也不会累出第二条线。 */
function superUsedOutPort(supId, childId) {
  const w = ((S.wf && S.wf.wires) || []).find(
    (x) => !x.rel && x.to === supId && x.from === childId,
  );
  return w ? Number(w.toIndex || 0) : null;
}

/** 该壳是否已经桥接到这颗直属子节点（返回当时用的那颗对外输入端子号）。 */
function superUsedInPort(supId, childId) {
  const w = ((S.wf && S.wf.wires) || []).find(
    (x) => !x.rel && x.from === supId && x.to === childId,
  );
  return w ? Number(w.fromIndex || 0) : null;
}

/** 桥接计划：{segs:[{from,to,toIndex,fromIndex}], error}。不落线、不动画布。
    每一段都是「同层」或「直属壳边界」——正是落线硬闸允许的两类。 */
function boundaryBridgePlan(fromNode, toNode, fromIndex, toIndex) {
  const fail = (msg) => ({ segs: [], error: msg || I18n.t("无法逐层桥接") });
  if (!fromNode || !toNode) return fail(I18n.t("节点不存在"));
  if (fromNode.id === toNode.id) return fail(I18n.t("不能连接同一节点"));
  /* 绕回自己内部 = 回路，不是跨层 */
  if (
    typeof nodeInsideSuper === "function" &&
    (nodeInsideSuper(toNode, fromNode.id) || nodeInsideSuper(fromNode, toNode.id))
  )
    return fail(I18n.t("不能把节点层接到它自己的内部（回路）"));
  const path = layerPathBetween(fromNode, toNode);
  if (!path || path.length < 2) return fail(null);
  const segs = [];
  let port = Number(fromIndex || 0);
  let prevSeg = null;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const last = i === path.length - 2;
    let seg = null;
    if (nodeParentSuperId(a) === b.id) {
      /* 出壳：a 是 b 的直属子节点 → 落在 b 的对外输出端子 p 上，下一段从 p 出去 */
      const used = superUsedOutPort(b.id, a.id);
      const p = used != null ? used : superFreeOutPort(b);
      if (p == null)
        return fail(I18n.t("「") + (b.title || b.id) + I18n.t("」没有空闲的输出端子"));
      seg = { from: a.id, to: b.id, toIndex: p, fromIndex: port };
      port = p;
    } else if (nodeParentSuperId(b) === a.id) {
      /* 进壳：b 是 a 的直属子节点 → 从 a 的对外输入端子 p 进，上一段必须落在 p 上 */
      const used = superUsedInPort(a.id, b.id);
      const p = used != null ? used : superFreeInPort(a);
      if (p == null)
        return fail(I18n.t("「") + (a.title || a.id) + I18n.t("」没有空闲的输入端子"));
      if (prevSeg) prevSeg.toIndex = p;
      seg = { from: a.id, to: b.id, toIndex: last ? toIndex : null, fromIndex: p };
      port = 0;
    } else {
      seg = { from: a.id, to: b.id, toIndex: last ? toIndex : null, fromIndex: port };
    }
    segs.push(seg);
    prevSeg = seg;
  }
  return { segs, error: null };
}

/** 这一段（同一 from / to / 端子）是否已经存在于画布上 —— 桥接的幂等判定看端子，
    不看「两个节点之间有没有线」：同源不同端子是合法接法（一张图分接首帧 / 末帧）。 */
function bridgeSegExists(seg) {
  if (!seg) return false;
  return ((S.wf && S.wf.wires) || []).some(
    (w) =>
      !w.rel &&
      w.from === seg.from &&
      w.to === seg.to &&
      Number(w.fromIndex || 0) === Number(seg.fromIndex || 0) &&
      (seg.toIndex == null || Number(w.toIndex || 0) === Number(seg.toIndex)),
  );
}

/** 按计划落线：逐段预检 → 一起落；任一段不合法 → 撤掉本对已落的线（整体回滚）。
    同一端子已经连过的段按幂等跳过（重复 superConnect 不累加冗余线）。 */
function applyBoundaryBridgePlan(segs) {
  if (!segs || !segs.length) return { created: 0, error: I18n.t("无法逐层桥接") };
  const wires = S.wf && S.wf.wires ? S.wf.wires : [];
  /* 替换会摘掉旧线，长度差不再等于「新落了几条」→ 整份快照 + 逐段记账：
     回滚 = 把整份线表原样恢复（含被顶掉的旧线）。 */
  const snapshot = wires.slice();
  const createdIds = [];
  const replaced = [];
  const rollback = () => {
    if (!S.wf || !Array.isArray(S.wf.wires)) return;
    S.wf.wires.length = 0;
    for (const w of snapshot) S.wf.wires.push(w);
  };
  for (const seg of segs) {
    if (bridgeSegExists(seg)) continue;
    const err = connectError(seg.from, seg.to, seg.toIndex, seg.fromIndex);
    if (err) {
      rollback();
      return { created: 0, replaced: [], error: err };
    }
    /* 已占用的边界端子 → 先顶掉旧的同类线（与手拖同一口径、同一步撤销） */
    const toSeg = nodeById(seg.to);
    const ctrl = isControlKind(nodeById(seg.from));
    for (const info of dropWiresForReplace(toSeg, seg.toIndex, ctrl)) replaced.push(info);
    const n0 = (S.wf.wires || []).length;
    if (addWire(seg.from, seg.to, seg.toIndex, { fromIndex: seg.fromIndex }) === false) {
      rollback();
      return {
        created: 0,
        replaced: [],
        error: I18n.t("节点层内外不能直接连线，必须经节点层的边界端子逐层中转"),
      };
    }
    for (let i = n0; i < (S.wf.wires || []).length; i++) createdIds.push(S.wf.wires[i].id);
  }
  return { created: createdIds.length, replaced, error: null };
}

/** 一对节点自动贯通：同层直连 / 跨层逐层桥接。返回真正落下的线数。
    warnings 只写「为什么没连成」，成功不打扰（用户可见的线本身就是回执）。
    out（可选）：把本对被顶掉的旧线摘要收进 out.replaced，供 agent 回执点名。 */
function bridgeNodesBetween(fromNode, toNode, fromIndex, toIndex, warnings, out) {
  const plan = boundaryBridgePlan(fromNode, toNode, fromIndex, toIndex);
  if (plan.error) {
    if (warnings)
      warnings.push(
        (fromNode.title || fromNode.id) + " → " + (toNode.title || toNode.id) + "：" + plan.error,
      );
    return 0;
  }
  const res = applyBoundaryBridgePlan(plan.segs);
  if (res.error && warnings)
    warnings.push(
      (fromNode.title || fromNode.id) + " → " + (toNode.title || toNode.id) + "：" + res.error,
    );
  if (out && res.replaced && res.replaced.length)
    out.replaced = (out.replaced || []).concat(res.replaced);
  return res.created;
}

/** 单对跨节点层连接 from → to；返回**真建成的连线条数**（不是「试过几层」）。
    out（可选）：被顶掉的旧线摘要（agent 回执点名用）。 */
function applySuperConnectOne(fromNode, toNode, warnings, fromIndex, toIndex, out) {
  if (!fromNode || !toNode) return 0;
  const made = bridgeNodesBetween(fromNode, toNode, fromIndex, toIndex, warnings, out);
  /* 一条线都没建立：必须说清原因，绝不静默。最常见的就是「这一对已经连过」
     （同一颗端子重复 superConnect）——那是幂等，不是失败，但也不能报 connected。 */
  if (!made && warnings) {
    const a = fromNode.title || fromNode.id;
    const b = toNode.title || toNode.id;
    warnings.push(
      I18n.t("跨级连接未新建连线（同一端子已存在或无法桥接）：") + a + " → " + b,
    );
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
    const replacedOut = {};
    const made = applySuperConnectOne(a, b, warnings, pair && pair.fromIndex, undefined, replacedOut);
    const created = (S.wf && S.wf.wires ? S.wf.wires : []).length - before;
    /* connected 只认**真的落进 S.wf.wires 的线数**：made 是分层结果，created 是账实核对 */
    if (created > 0 || made > 0) {
      const entry = {
        from: a.id,
        to: b.id,
        fromTitle: a.title,
        toTitle: b.title,
        viaSuper: true,
        wires: created,
      };
      if (replacedOut.replaced && replacedOut.replaced.length)
        entry.replaced = replacedOut.replaced;
      connected.push(entry);
      madeTotal += created;
    }
  }
  return madeTotal;
}


/* ==================== 画布读侧内核（canvas-doc/canvas-doc-core.js）====================
   快照各档位 / 端子与 portRule · paramKeys 推导 / childCount 预聚合 / scope 判定 /
   contentHash / 静态表（imageSizes · defaultImageSize · kinds）全部搬到了
   canvas-doc/canvas-doc-core.js —— 同一份代码两处入口：
     · 浏览器：index.html 在 app.js 之前加载它，挂 globalThis.MTCanvasDoc（本文件是它的调用方）；
     · 主进程 / 脚本：require("canvas-doc/canvas-doc-core.js") 拿同一份 api。
   本文件只留「同名包装」：用 canvasDocHost() 把画布现场（S / I18n / 各节点原语）拼成宿主
   对象 H 再转发进去。函数名、入参、返回值口径与搬家前逐字节一致 —— 渲染、写侧闸、MCP 与
   助手快照都还按老名字调，谁也不用改。
   纪律：读侧逻辑只许改 canvas-doc/canvas-doc-core.js，这里不许再长出第二份实现。 */
function canvasDocHost() {
  return {
    /* 画布现场：原来读侧直接读 S 的那几项，只读投影，不写回 */
    state: { wf: S.wf, view: S.view, cam: S.cam, superFocus: S.superFocus },
    /* 文案由调用方给：内核不持有任何词条 */
    i18n: I18n,
    /* 静态表：imageSizes / defaultImageSize 的真源就在内核里（app.js 取的也是这一份）；
       nodeDefaults 是建图 kinds 表的来源，插件会往里追加条目，所以每次现取不缓存 */
    imageSizes: MTCanvasDoc.IMAGE_SIZES,
    defaultImageSize: MTCanvasDoc.DEFAULT_IMAGE_SIZE,
    nodeDefaults: typeof NODE_DEFAULTS === "object" ? NODE_DEFAULTS : {},
    /* 节点原语（读侧的全部外部依赖都在这一段，逐个点名 = 一眼看得全） */
    nodeById, currentTaskFocus, currentSuperFocus, nodeInCurrentScope, markInCurrentScope,
    isSuperIoNode, nodeParentSuperId, wfTagCatalog, isFunctionNode, canUseGlobalRefs,
    normalizeNodeTags, isToolNode, ensureFnToolNodeState, fnToolParamList, execIconKeyOf,
    execColorOf, isNetNode, isCustomVideoGen, h3WfPortOf, mediaGenOutputRaw, yueGenCotOf,
    breezeModeOf, breezeCfgScaleOf, breezeSeedOf, breezeFormatOf, remotionContractOf,
    MARK_COLORS, DEV_FUNC_COLORS, relArrowOf, devKindOf, devColorOf, devCoreFilesOf,
    devCoreFilesSourceOf, entryDisplayTitle, singleImageTitle,
    isFnToolNode, isAssetNode, assetItems, inputCount, outputCount, editPortNameOf,
    editPortKindOf, isControlKind, isDynCtrlNode, dynCtrlInPortIndex, allWiresTo,
    superDisplaySize,
    /* 这两个由后加载的脚本提供（app-node-params.js / app-assets.js）：取值时守一道，
       免得在这两只脚本还没求值时被调到就抛引用错误（与搬家前的 typeof 口径一致）。 */
    NParam: typeof NParam === "object" ? NParam : undefined,
    assetNodeIsLost: typeof assetNodeIsLost === "function" ? assetNodeIsLost : undefined,
  };
}

/* ── 同名包装（转发到内核）───────────────────────────────────────────────────
   只做一件事：拼宿主 + 原样转发。任何字段加工都该写在内核里，不要写在这几行。 */
function clipStr(s, n) {
  return MTCanvasDoc.clipStr(s, n);
}
function snapTextField(raw) {
  return MTCanvasDoc.snapTextField(raw);
}
function normalizeSnapshotOpts(opts) {
  return MTCanvasDoc.normalizeSnapshotOpts(opts);
}
/* 局部画布（scope）：只读 / 只改一颗壳内部 —— 判定真源见内核
   （写入侧的越界防护仍在 applyCanvasEdit 的 scope 闸，用的是同一批包装函数） */
function resolveScopeHost(token) {
  return MTCanvasDoc.resolveScopeHost(canvasDocHost(), token);
}
function superAncestorIdsOf(startId) {
  return MTCanvasDoc.superAncestorIdsOf(canvasDocHost(), startId);
}
function superSubtreeIds(host) {
  return MTCanvasDoc.superSubtreeIds(canvasDocHost(), host);
}
function nodeInSuperScope(n, host, allowed) {
  return MTCanvasDoc.nodeInSuperScope(canvasDocHost(), n, host, allowed);
}
function pointInScopeHost(host, x, y) {
  return MTCanvasDoc.pointInScopeHost(canvasDocHost(), host, x, y);
}
function scopedNodeIdSet(host, depth) {
  return MTCanvasDoc.scopedNodeIdSet(canvasDocHost(), host, depth);
}
function nodeInSnapshotScope(n, host, depth) {
  return MTCanvasDoc.nodeInSnapshotScope(canvasDocHost(), n, host, depth);
}
function snapshotScopeOf(opts) {
  return MTCanvasDoc.snapshotScopeOf(canvasDocHost(), opts);
}
function scopeInfoBlock(sc, hostsAll) {
  return MTCanvasDoc.scopeInfoBlock(canvasDocHost(), sc, hostsAll);
}
function nodeInFilter(n, o) {
  return MTCanvasDoc.nodeInFilter(n, o);
}
function pruneNodeSnap(node, o) {
  return MTCanvasDoc.pruneNodeSnap(node, o);
}
function applySnapshotSectionFilter(snap, sections) {
  return MTCanvasDoc.applySnapshotSectionFilter(snap, sections);
}
function pruneMinimalSnapshot(snap, opts) {
  return MTCanvasDoc.pruneMinimalSnapshot(snap, opts);
}
function snapshotWantsSection(o, opts, key) {
  return MTCanvasDoc.snapshotWantsSection(o, opts, key);
}
function snapshotWantsStaticRefs(opts) {
  return MTCanvasDoc.snapshotWantsStaticRefs(opts);
}
function attachSnapshotStaticRefs(snap) {
  return MTCanvasDoc.attachSnapshotStaticRefs(canvasDocHost(), snap);
}
/* 端子表：数量 / 名称 / 类型 / 占用与画布端子徽标、连线预检同一套原语 */
function nodePortList(node, dir) {
  return MTCanvasDoc.nodePortList(canvasDocHost(), node, dir);
}
function snapshotHasFixedPorts(node) {
  return MTCanvasDoc.snapshotHasFixedPorts(canvasDocHost(), node);
}
function snapshotInputGrowsWithWires(node) {
  return MTCanvasDoc.snapshotInputGrowsWithWires(canvasDocHost(), node);
}
function snapshotPortsOf(node) {
  return MTCanvasDoc.snapshotPortsOf(canvasDocHost(), node);
}
function snapshotRemotionPortRule(node) {
  return MTCanvasDoc.snapshotRemotionPortRule(canvasDocHost(), node);
}
function snapshotPortRuleOf(node) {
  return MTCanvasDoc.snapshotPortRuleOf(canvasDocHost(), node);
}
function snapshotDynamicPortRule(node) {
  return MTCanvasDoc.snapshotDynamicPortRule(canvasDocHost(), node);
}

/* ── 素材节点（kind "asset"）在 canvas_get 里的回读口径 ──────────────────────────
   内容实体恒在素材库，节点上只存绑定（assetId / assetRel / assetName / assetDesc）与
   条目快照（items：[{id,title,type}]）。本段是 Agent 读素材节点的唯一出口：
     · snapshotAssetNodeOf —— 绑定 + 条目清单（端子号 = 条目号）。没有它，Agent 读到的
       素材节点配置是空的（每个字段都 undefined），只能看见几条线凭空接在节点上 ——
       这正是「素材节点内容是空的」这条报告的根因；
     · snapshotAssetContentOf —— full / bodies 档的条目正文（文本给正文，媒体给本机
       路径），复用 bodyLimit 截断口径。standard 档只给清单与 *Len 长度提示符，
       正文仍要显式 detail:"full" 才下来（与 text / prompt 同一档位纪律）。
       （这一只读素材库 / 走异步，留在本文件；条目清单的推导在内核。） */
/** 素材节点 Snapshot 绑定 + 条目清单；非素材节点 / 未绑定 / 空条目 → undefined */
function snapshotAssetNodeOf(node) {
  return MTCanvasDoc.snapshotAssetNodeOf(canvasDocHost(), node);
}

/** 一条内容条目转成 Agent 可读的值：文本 → {text}；媒体 → {path, url}（与素材端子
 *  取数 assetItemValueOf 同一形状）。库里读不到（内容文件缺失）时只报 missing。 */
function assetItemAgentValue(node, it) {
  if (!node || !it || !String(it.id || "").trim()) return undefined;
  const sum = typeof assetItemSummary === "function" ? assetItemSummary(node, it.id) : null;
  if (sum && sum.missing) return { missing: true };
  if (it.type !== "text") {
    const p =
      typeof assetItemAbsPath === "function" ? assetItemAbsPath(node, it) : "";
    if (!p) return undefined;
    return {
      path: p,
      url: typeof mediaFileUrlOf === "function" ? mediaFileUrlOf(p) : "",
      bytes: Number((sum && sum.bytes) || 0) || undefined,
    };
  }
  const cached =
    typeof assetItemViewGet === "function"
      ? assetItemViewGet(node.assetId, it.id)
      : null;
  if (cached && !cached.missing && typeof cached.text === "string")
    return { text: cached.text, textLen: cached.text.length };
  if (sum && !sum.missing && !Number(sum.bytes)) return { text: "", textLen: 0 };
  return undefined;
}

/** 让该素材节点的条目正文就位：先等已在飞的读取（同一 key 只飞一次），再向库补读
 *  没缓存的文本条目。只有文本条目的正文要读盘 —— 媒体条目的路径 / 大小本来就在库摘要里
 *  （assetItemSummary / assetItemAbsPath），不为它多打一次 IPC。
 *  任何异常都不抛 —— 读不到就如实报「未读到」，绝不把节点吞掉。 */
async function snapshotAssetItemsLoad(node) {
  const aid = String((node && node.assetId) || "").trim();
  if (!aid) return;
  const items = assetItems(node);
  const wait = [];
  for (const it of items) {
    if (it.type !== "text") continue;
    if (!String(it.id || "").trim()) continue;
    wait.push(
      Promise.resolve(
        typeof assetItemViewLoaded === "function"
          ? assetItemViewLoaded(aid, it.id)
          : null,
      ).catch(() => null),
    );
  }
  try {
    await Promise.all(wait);
  } catch {}
}

/** full / bodies 档：把每个素材节点的条目正文挂到 items[i] 上（文本 inline，媒体给路径）。
 *  只覆盖本次返回的素材节点，不写回节点数据 —— 快照是只读投影，库内容绝不进画布存档。 */
async function snapshotAssetContentOf(snap, opts) {
  const o = normalizeSnapshotOpts(opts || {});
  if (!o.wantBodies) return snap;
  const nodes = (snap && snap.nodes) || [];
  const targets = nodes.filter((n) => n && n.kind === "asset" && n.assetItems);
  if (!targets.length) return snap;
  await Promise.all(
    targets.map((n) => {
      const src = typeof nodeById === "function" ? nodeById(n.id) : null;
      return src ? snapshotAssetItemsLoad(src) : null;
    }),
  );
  for (const n of targets) {
    const src = typeof nodeById === "function" ? nodeById(n.id) : null;
    if (!src) continue;
    const items = n.assetItems.items || [];
    for (let i = 0; i < items.length; i++) {
      const it = assetItems(src)[i];
      const val = it ? assetItemAgentValue(src, it) : undefined;
      if (!val) continue;
      const text = typeof val.text === "string" ? val.text : "";
      items[i].text = text;
      items[i].textLen = text.length;
      if (val.path) items[i].path = val.path;
      if (val.url) items[i].url = val.url;
      if (val.missing) items[i].missing = true;
      /* 正文纪律与其它正文同一口径：bodyLimit 给到就照它截断；*Len / textLen 恒为真长度 */
      if (text && o.bodyLimit > 0 && text.length > o.bodyLimit)
        items[i].text = text.slice(0, o.bodyLimit);
    }
  }
  return snap;
}

/* Agent 侧透出「功能色卡」：唯一真源是 app-devnode.js 的 DEV_FUNC_COLORS 常量，
   这里只搬运 key / zh / en / hex（keywords 属内部推断细节，不塞进快照浪费 token）。
   mtnode_canvas_get 与助手快照都通过 devFuncColors 字段读到同一张表。 */
function devFuncColorCatalog() {
  return MTCanvasDoc.devFuncColorCatalog(
    typeof DEV_FUNC_COLORS !== "undefined" && Array.isArray(DEV_FUNC_COLORS)
      ? DEV_FUNC_COLORS
      : [],
  );
}

/* 画布快照（各档位 / scope / sections / 静态参考表按需闸）：实现全在
   canvas-doc/canvas-doc-core.js 的 canvasSnapshot —— 与主进程 / MCP 用的是同一份计算，
   返回结构逐字节不变（含字段顺序与 childCount 预聚合后的同一口径）。 */
function canvasSnapshot(opts) {
  return MTCanvasDoc.canvasSnapshot(canvasDocHost(), opts);
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

/* ── 本机媒体后端实况（智能节点 / 会话共用）─────────────────────────────
   为什么要有这一段：视频 / 渲染 / 音乐 / 语音后端是**插件**，由插件宿主管进程。
   它们现在也会以只读镜像出现在重后端注册中心（br_admin 的 list 里 plugins 字段，
   见 main-backend-registry.js 的 pluginBackends），但注册中心里的 items 仍然只放
   Agent 现场装出来的额外后端 —— items 为空是常态，不代表这些能力缺失。
   Agent 拿不到安装状态时只能去猜目录，于是把「注册表为空」误报成「视频后端缺失 ·
   未装 Remotion」，明明已装也拒绝干活。真源是插件目录缓存 S.plugins（主进程
   attachInstalled 按磁盘安装目录判 installed，见 plugins/main-app-plugins.js），
   这里只把它翻成一句模型能读的实况；缓存未到位时明确说「未知」，绝不替用户断言未安装。 */
const MEDIA_BACKEND_ROWS = [
  ["minimax-h3", "视频生成 video_gen"],
  ["remotion", "动效渲染 remotion"],
  ["minimax-music3", "音乐生成 music_gen"],
  ["breeze-tts-local", "语音合成 breeze_gen"],
  ["yue2-local", "整曲生成 yue_gen"],
];
/* 结构化实况：null = 插件目录还没取到（未知，不是「未安装」） */
function mediaBackendStates() {
  if (S.pluginsReady !== true) return null;
  return MEDIA_BACKEND_ROWS.map(([id, label]) => {
    const hit = (S.plugins || []).find((p) => p && p.id === id);
    const vramHidden = !!(S.pluginsVramHidden && S.pluginsVramHidden.has(id));
    return {
      id,
      label,
      listed: !!hit,
      installed: !!(hit && hit.installed),
      vramHidden,
    };
  });
}
function mediaBackendStatusLine() {
  const states = mediaBackendStates();
  if (!states) {
    return (
      "【本机媒体后端】插件目录本轮还没取到：**不要**据此断言「未安装 / 视频不可用」，" +
      "需要确认时请用户打开右上角「插件」看一眼。"
    );
  }
  const parts = states.map((it) => {
    const st = it.vramHidden
      ? "被显存门槛收起"
      : !it.listed
        ? "目录里没有这一条"
        : it.installed
          ? "已安装"
          : "未安装";
    return it.label + "：" + st;
  });
  return (
    "【本机媒体后端】" +
    parts.join(" · ") +
    "。这些是**插件**后端，由插件宿主管进程；br_admin 的 list 里 plugins 字段只是它们的只读镜像" +
    "（含装没装与安装目录），**不要**用 register 登记它们，启停 / 安装在「插件」界面。" +
    "注册中心 items 为空只说明没有 Agent 现场登记的额外后端，**不代表视频生成 / 渲染不可用**，" +
    "禁止据此报「视频后端缺失」或「未装 Remotion」。判断装没装只认这一行（或 br_admin list 的 plugins）；" +
    "确属未安装时才请用户在「插件」里安装（技能 mtnode-media-gen-nodes / remotion-local-install / minimax-h3-install）。"
  );
}

/* 智能节点人设：保留文件/命令/联网；画布读取与节点 / 连线操作按本轮工具许可放行
   （见 app-db.js 的 NODE_AGENT_TOOL_POLICY），不再禁止调用画布工具。 */
function agentNodeCapabilityNote() {
  return (
    "【智能节点】你是画布上的执行节点，不是工作流搭建助手。" +
    "允许：读写与编辑工作区文件、执行命令、联网搜索与抓取网页、使用已安装技能与 MCP 工具、调用 mtnode_vision 识图、向用户提问或派生子任务（均须遵守当前审批/权限预设）。用写文件交付结果。" +
    "画布：允许调用 mtnode_canvas_get 读取本画布（组输入只给节点 id 清单，要看正文就按 ids 取）；也允许调用 mtnode_canvas_edit 按用户要求建节点 / 连线 —— 只按用户要求改，动现有节点前先问用户。控制类节点、节点层、绘图、排版与成组会按工具许可逐次询问；mtnode_app（画布改名 / 删除画布 / 装插件）本轮不注册，调用即失败。" +
    "输入优先级：组输入最先，其次画布，再次项目文件，最后才是外部知识；用户在任务里明说的要求永远最优先。" +
    mediaBackendStatusLine() +
    "回答简洁（交流语言见文末「语言口味」）。"
  );
}

/* ============ 规划模式（会话「规划」按钮）：本轮只出计划，禁止任何改动 ============ */

/* 规划模式下宿主直接拒绝的应用级动作（status / list_workflows / list_dsh_plugins 只读放行） */
const PLAN_DENIED_APP_ACTIONS = new Set([
  "rename_workflow",
  "delete_workflow",
  "create_longtask",
  /* 原地改一张已有长任务的图（「任务链修改」走这条）= 改画布，规划模式下一律拒绝 */
  "update_longtask",
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
    "禁止：创建 / 修改 / 删除任何文件（write、edit、str_replace_editor）；执行任何有副作用的命令（安装、删除、移动、复制、构建、重启服务、清理目录）；调用 mtnode_canvas_edit 与 mtnode_app 的修改类动作（宿主会直接拒绝并返回错误）；用 todo_write 登记执行清单；用 create_goal 立执行目标；用 subagent 派生实现工作。",
    "禁止使用任何 git 命令（含 git status / diff / log 这类只读子命令）：git 不保留每次更新信息（agent 不会每改一次就 git add），它的状态与真实改动不一致 —— 要看改动请重读文件、跑冒烟，或看会话的「改动」面板。",
    "允许并鼓励只读调研：read、glob、grep、只读命令（node --check 等）、mtnode_canvas_get（配 detail:\"standard\" 等省 token 参数）、mtnode_db 查询、web_search、加载技能。",
    "计划格式：以 # 一级标题开头，依次给出 ① 目标与验收标准 ② 现状与关键约束（引用具体文件与行号）③ 分步实施清单（每步写明文件、改动要点、为什么）④ 验证方法 ⑤ 风险与回滚。步骤要具体到无需二次决策。",
    "写完计划立即结束本轮：不要开始实施，也不要追问「是否可以执行」；用户点击界面上的「执行计划」后才会进入实施。",
  ].join("\n");
}

/* 禁止跨画布：智能任务/会话始终锁定在它「所属的那张画布」（= 本轮绑定画布，
   不是用户此刻看到的画布）；画布助手仅在「仅当前画布」范围时锁定。 */
function restrictOtherCanvases() {
  if ((S._canvasNodeAgentDepth || 0) > 0) return true;
  /* 长任务「只读画布」档：不进 nodeLock（那档放行读 + 节点 / 连线，会盖过本档的
     「只读」授权），但同样只准看本轮绑定的那张画布。 */
  if ((S._ltCanvasReadDepth || 0) > 0) return true;
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
  /* 锁定口径只看会话自身状态（画布助手「仅当前画布」/ 智能节点 / 长任务只读档），
     绝不因为「这次读的是另一张画布」就把范围说成当前画布：MCP 连接（第三方客户端）
     可以带 canvas 参数读别的画布，那是**允许**的，不是越界。 */
  const locked = restrictOtherCanvases() || (opts && opts.restrict === true);
  /* 给 API 使用者（第三方 MCP 客户端）一句话说明：这次读的是哪张、还能不能读别的。 */
  if (opts && opts.wf && !locked) {
    snap.scopeInfo = Object.assign({}, snap.scopeInfo || {}, {
      canvas: String(opts.wf.id || ""),
      canvasName: String(opts.wf.name || ""),
      note: "本次读的是指定画布；其它画布同样可用（传 canvas 参数或资源 mtnode://canvases）。",
    });
  }
  if (!locked) return snap;
  snap.assistScope = "current";
  /* 锁定的那一张 = 本轮绑定画布（会话「所属画布」）：opts.wf 由画布事件显式交进来，
     用户切走前台画布时它仍是会话自己那张。没有 opts.wf 的只剩助手侧的提示词快照
     （助手没有归属会话，锁定的就是用户正看着的那张）—— 两种情况都不看运行栈栈顶：
     并行跑着别的会话时栈顶是谁纯看时序，拿它当范围会把别人的画布说成自己的。 */
  const cur = (opts && opts.wf) || currentVisibleWf() || S.wf;
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
    "工作范围=本会话所属画布：不得读取或操作其他画布内容。",
  );
  return snap;
}

/* 结构内容哈希（FNV-1a）：**对画布真源（wf）算，不对过滤后的快照算**。
   为什么必须与快照解耦：这个哈希是写操作的乐观并发闸（MCP 的 baseHash 与自家 Agent
   同一口径）。快照是「按 detail / sections / ids / scope 裁出来的视图」——
   detail:"minimal" 的节点只剩 标题/描述/类别，而 detail:"standard" 带全部配置字段与
   位置连线，同一张没动过的画布会算出两个不同的哈希。客户端按服务端说明「把读回的
   contentHash 原样回传」时就会被判成「画布已被改动」而拒写（实测：minimal 读 → standard
   读，哈希即变，写必被拒）。所以哈希只覆盖真源里会随编辑变化的结构与设置：
   nodes（结构字段 + 正文长度；正文本身不参与——按「显式存盘才改文件」的既有口径）、
   wires / groups / marks / 画布名。刻意剔除 cam / view / selection / 运行态等易变项。
   实现（含标量归一与真源规范化文本）在 canvas-doc/canvas-doc-core.js。 */
function snapshotContentHashOf(snapOrWf) {
  return MTCanvasDoc.snapshotContentHashOf(canvasDocHost(), snapOrWf);
}
function hashScalar(v) {
  return MTCanvasDoc.hashScalar(v);
}
function snapshotHashSource(snapOrWf) {
  return MTCanvasDoc.snapshotHashSource(canvasDocHost(), snapOrWf);
}

/* 全量快照（含 wfList IPC）。opts 直通 canvasSnapshot 的档位：canvas_get 用 detail 按需取
   （网关缺省 = minimal）；助手每轮注入的快照不再走这里 —— assistAppSnapshot
   （app-assist.js）只给计数与选中 / 焦点，节点列表与正文一律由模型按需现拉。 */
async function canvasSnapshotFull(opts, scopeOpts) {
  const o = normalizeSnapshotOpts(opts || {});
  const snap = canvasSnapshot(opts || {});
  const minimal = o.detail === "minimal";
  const want = (k) => snapshotWantsSection(o, opts || {}, k);
  /* 素材节点的条目正文只存在素材库里（节点上只有条目身份），必须在这一层（async）
     向库补读一次再回给 Agent —— 只有 detail:"full" / bodies:true 才做，standard 档
     仍只给条目清单（与 text / prompt 的正文档位纪律一致）。 */
  await snapshotAssetContentOf(snap, opts || {});
  let workflows = [];
  try {
    workflows = await window.api.wfList();
  } catch {}
  /* minimal 档（缺省）连「全部画布列表 / 选中 / 助手面板开关」都不带：那是看配置时才要的
     上下文，节点索引里用不上。sections 显式点名 workflows / selection 仍会带上。 */
  if (want("workflows")) {
    snap.workflows = (workflows || []).map((w) => ({
      id: w.id,
      name: w.name,
      nodes: w.nodes,
      active: !!(S.wf && S.wf.id === w.id),
    }));
  } else {
    delete snap.workflows;
  }
  if (want("selection")) {
    snap.selection = currentSelection().map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
    }));
  } else {
    delete snap.selection;
  }
  if (!minimal) {
    snap.assistOpen = !!S.assistOpen;
    snap.sidebarOpen = !!S.sidebarOpen && S.view !== "agent";
  }
  applyAssistScopeToSnapshot(snap, scopeOpts || {});
  /* 锁定本画布时 applyAssistScopeToSnapshot 会回写 workflows（= 本图一行）；minimal 档下
     它仍能在 scopeNote 里说明「工作范围 = 本会话所属画布」，不必再带一份画布列表。 */
  if (minimal && !want("workflows")) delete snap.workflows;
  applySnapshotSectionFilter(snap, (opts || {}).sections);
  /* 哈希必须算在**画布真源**上，不能算在这个刚被 detail / sections / ids / scope 裁过的
     快照上（minimal 档的节点只剩 标题/描述/类别，与 standard 档算出两个哈希 → 客户端
     「读完立刻改」必被版本闸拒）。故显式交真源：S.wf 就是 canvasSnapshot 用的那张图。 */
  snap.contentHash = snapshotContentHashOf(S.wf);
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

async function renameWorkflowByRef(workflow, name, opts) {
  const nm = String(name || "").trim();
  if (!nm) throw new Error(I18n.t("请填写画布名称"));
  /* 「没指定画布时改哪一张」= 本轮绑定画布（会话「所属画布」），由调用方显式交进来；
     不再现取 S.wf —— 后台换画布上下文里 S.wf 虽然通常就是它，但本地直调路径不保证。 */
  const bound = (opts && opts.wf) || S.wf;
  let id = bound && bound.id;
  if (workflow) {
    const w = await resolveWorkflowRef(workflow);
    id = w.id;
  }
  if (!id) throw new Error(I18n.t("当前没有打开的画布"));
  /* 已删画布（黑名单）不允许再改名：这里的 wfSave 会凭空复活一个空壳画布 */
  if (wfIsDeleted(id))
    throw new Error(deletedWfError({ id, name: bound && bound.id === id ? bound.name : "" }));
  if (bound && String(bound.id) === String(id)) {
    /* 改的就是本轮那张图：直接写内存对象。落盘按「它是不是用户正看着的画布」分流 ——
       是 → 原路 scheduleSave + renderAll；不是（会话跑在后台画布上）→ 走 persistWf
       按它自己的 id 落盘，绝不把后台内容写进前台画布，也不重绘用户正在干的活。 */
    bound.name = nm;
    trackWorkflow(id, nm);
    /* S._canvasEditVisible === false = 正改的不是用户看着的那张（与 applyCanvasEdit
       收尾落盘用的是同一个判据） */
    if (bound === currentVisibleWf() && S._canvasEditVisible !== false) {
      scheduleSave(true);
      renderAll();
    } else {
      persistWf(bound);
      await refreshWfSelect();
    }
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
   - 受限范围（智能任务 / 会话锁画布）：无 ref 时只能删本会话「所属画布」
     （opts.wf = 本轮绑定画布，调用方显式交进来；没有才退回栈顶 / 前台画布），
     有 ref 也必须就是它。绝不兜底 S.wf —— 后台换画布编辑（runAgainstWf）在飞时
     S.wf 是别人的画布。
   - 全局范围：必须显式给出 workflow，缺失直接报错要求指定，不再默认「删当前」。
   返回磁盘上的真实目标 { id, name, nodes }（wfList 口径，与主进程校验同源）。 */
async function resolveDeleteWfTarget(params, opts) {
  const p = params || {};
  const ref = String(p.workflow || p.id || p.name || "").trim();
  const restricted = assistRestrictOtherCanvases();
  let bound = null;
  if (restricted) {
    /* 首选调用方显式交进来的本轮绑定画布（会话「所属画布」）：并行跑多条会话时
       运行栈栈顶是谁纯看时序，退一步才用它，再退才是用户正看着的前台画布。 */
    bound =
      (opts && opts.wf && opts.wf.id ? opts.wf : null) ||
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
        I18n.t("本会话只能访问它所属的画布，无法读取或操作其他画布。"),
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
  /* 只有「用户正看着的那张被删了」才需要替他挑落点：会话在后台删掉自己的所属画布时
     用户正在别的画布上干活，绝不抢切他的视图（此刻 S.wf 可能已被 runAgainstWf 换成
     后台那一张，不能拿它当判据）。 */
  if (fg && String(fg.id) === String(w.id)) {
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
  /* 同理：在后台画布上下文里 renderAll 会把「用户没在看的那一张」（甚至就是刚删掉
     的那一张）画到用户眼前。非前台一律只刷新画布标签 / 下拉，不动画面。 */
  if (S._canvasEditVisible !== false) renderAll();
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

/* ── 画布拍照（mtnode_app 的 export_canvas_png）：页脚相机按钮的同一条链路 ──
   复用 renderer/app.js 的 exportCanvasOverviewPng（同一套瓦片拼接 / 相机复位 / 夹取守卫），
   差别只有三点：
     · 不弹确认框与保存框（工具调用本身就是用户意图，别拿模态框卡住一轮运行）；
     · 智能会话 / 团队视图下先把画布临时显示出来再拍，拍完原样收回（拍照 = 截屏）；
     · 结果以 PNG 落盘并把路径交回模型 —— 默认落本画布资产目录（%APPDATA%，不落应用文件夹），
       给了 path 就写那个绝对路径；拿到路径即可交给 mtnode_vision 识图或直接给用户看。 */
async function captureCanvasForAgent(params, wf) {
  const outPath = String((params && params.path) || "").trim();
  if (outPath) {
    if (!isAbsPath(outPath)) throw new Error(I18n.t("path 必须是本机绝对路径：") + outPath);
    if (!/\.png$/i.test(outPath))
      throw new Error(I18n.t("画布总览图只能保存为 .png：") + outPath);
  }
  if (!window.api || !window.api.captureRect)
    throw new Error(I18n.t("当前环境不支持画布拍照"));
  const restore = revealCanvasForShot();
  let shot = null;
  try {
    shot = await exportCanvasOverviewPng({ fromAgent: true });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    /* 窗口最小化 / 完全不可见时主进程的 capturePage 拿不到画面（回 "empty"）：
       补一句用户能照做的提示，别只把一个 empty 丢给模型。 */
    if (/empty/i.test(msg))
      throw new Error(
        I18n.t(
          "生成总览图失败：主进程没取到画面（MTNode 窗口最小化或不可见）。请先把窗口显示出来再拍。",
        ),
      );
    throw e;
  } finally {
    /* 无论拍成没拍成，都要把视图原样还回去（会话还在跑，界面不能停在画布上） */
    restore();
  }
  if (!shot || shot.ok !== true || !shot.base64)
    throw new Error(I18n.t("生成总览图失败：") + "empty");
  let dest = outPath;
  let storedIn = "file";
  if (dest) {
    const wr = await window.api.fileWriteBytes(dest, base64ToBytes(shot.base64));
    if (wr && wr.ok === false) throw new Error(wr.error || I18n.t("保存失败"));
  } else {
    const r = await window.api.assetWriteBase64(
      wf.id,
      "canvas-shot-" + Date.now().toString(36),
      shot.base64,
      "png",
    );
    if (!r || r.ok === false || !r.path)
      throw new Error((r && r.error) || I18n.t("保存失败"));
    dest = r.path;
    storedIn = "asset";
  }
  return {
    ok: true,
    action: "export_canvas_png",
    workflow: wf.name || wf.id,
    path: dest,
    storedIn,
    width: shot.width,
    height: shot.height,
    pngKB: Math.round((shot.base64.length * 3) / 4 / 1024),
    note: I18n.t(
      "已拍下整张画布（节点 + 连线 + 标注）。要真的看懂图里内容，把 path 交给 mtnode_vision 识图；拍图期间画面会短暂移动，已自动恢复。",
    ),
  };
}

async function applyAppOp(params, runWf, runKey) {
  params = params || {};
  const action = String(params.action || "").trim();
  const warnings = [];
  if (!action) throw new Error(I18n.t("缺少 action"));
  /* 本轮绑定画布（= 会话「所属画布」，由 handleCanvasEvent 经 runCtx 交进来）。
     所有「哪张图」的判断都以它为准：状态快照、改名、删除目标一律精准命中所属画布，
     同时绝不因为用户切到别的画布干活就误改 / 误删他正开着的那张。
     MCP 连接（第三方客户端）点名了 canvas 时，runCtx.wf 已经是那张目标画布 → 同样精准命中。 */
  const boundWf = runWf || canvasTargetWf() || S.wf;
  if (action === "delete_workflow") await ensureAgentTool("app_delete", undefined, runKey);
  else if (
    action === "list_dsh_plugins" ||
    action === "install_dsh_plugin" ||
    action === "remove_dsh_plugin" ||
    action === "set_dsh_plugin"
  ) {
    await ensureAgentTool("app_dsh_plugins", undefined, runKey);
  } else if (
    action === "status" ||
    action === "list_workflows" ||
    action === "rename_workflow" ||
    action === "create_longtask" ||
    /* 长任务图的两只动作也归 app_ops（「应用操作」这一档许可 → 权限面板里能单独关掉）：
       get_longtask 只读现况，update_longtask 原地改图（两者都靠 LT 模块，见各自分支）。 */
    action === "get_longtask" ||
    action === "update_longtask" ||
    action === "select_nodes" ||
    action === "undo" ||
    action === "redo"
  ) {
    await ensureAgentTool("app_ops", undefined, runKey);
    if (action === "status" || action === "list_workflows")
      await ensureAgentTool("canvas_read", undefined, runKey);
  } else if (action === "export_canvas_png") {
    /* 画布拍照 = 把画布内容当图像读出来（走 app_ops「应用操作」+ canvas_read「读画布」
       两道许可，与 status / list_workflows 同一口径）。 */
    await ensureAgentTool("app_ops", undefined, runKey);
    await ensureAgentTool("canvas_read", undefined, runKey);
  }
  const scopeBlocked = S.assistRunActive && assistScopeIsCurrent()
    ? I18n.t(
        "助手的工作范围是「仅当前画布」：本轮只能操作它绑定的那张画布，无法访问其他画布。请将工作范围改为「全局」后再试。",
      )
    : I18n.t(
        "本会话只能访问它所属的画布，无法读取或操作其他画布。",
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
    return Object.assign(
      { ok: true, action },
      await canvasSnapshotFull({}, { wf: boundWf }),
    );
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

  if (action === "create_longtask") {
    /* 总开关关着（app-longtask.js 的 window.LT_DISABLED）：长周期任务整块停用，
       这三个动作一律拒绝，不让 Agent 在停用期往画布里落状态机数据。 */
    if (window.LT_DISABLED) throw new Error(I18n.t("长周期任务暂时停用（正在修复中），入口与状态机已隐藏"));
    /* Agent（mtnode_app 的 create_longtask）按 mtnode-grill-me 的图契约产出一张
       状态机图 → 落库到本会话「所属画布」的长周期任务列表。归一 + 校验都在
       LT.createFromGraph 里；有 err 就整条拒绝并把 err 文本回给 Agent 去修。
       落库后任务 enabled:false，等用户在条带上「启用并绑定」；这里不触发运行。 */
    if (!boundWf) throw new Error(I18n.t("当前没有打开的画布"));
    const LT = window.LT;
    if (!LT || typeof LT.createFromGraph !== "function")
      throw new Error(I18n.t("长周期任务模块还没就绪"));
    const r = LT.createFromGraph(params.name != null ? String(params.name) : "", params.graph, boundWf);
    if (!r || !r.ok) throw new Error((r && r.error) || I18n.t("长周期任务图校验未通过："));
    return Object.assign({ ok: true, action }, r);
  }

  if (action === "get_longtask") {
    if (window.LT_DISABLED) throw new Error(I18n.t("长周期任务暂时停用（正在修复中），入口与状态机已隐藏"));
    /* 「任务链修改」的第一步：Agent 要改图，先得看清「现在这张图 + 现在跑到哪」。
        与 create 分支读同一份数据源（wf.longtask），返回 LT.graphOf 的现况快照
        （身份 / ver / enabled / 运行态 / 整张图定义）；uid 可省 = 本画布当前任务。
        只读动作，不改任何东西，也不弹确认。 */
    if (!boundWf) throw new Error(I18n.t("当前没有打开的画布"));
    const LT = window.LT;
    if (!LT || typeof LT.graphOf !== "function")
      throw new Error(I18n.t("长周期任务模块还没就绪"));
    const snap = LT.graphOf(boundWf, params.uid != null ? String(params.uid) : "");
    if (!snap) throw new Error(I18n.t("没有找到这张长任务（可能已被删除）"));
    return Object.assign({ ok: true, action }, snap);
  }

  if (action === "update_longtask") {
    if (window.LT_DISABLED) throw new Error(I18n.t("长周期任务暂时停用（正在修复中），入口与状态机已隐藏"));
    /* 「任务链修改」的落点：Agent 交回一张**完整的新图**→ 原地替换既有任务的图定义
        （同一个 uid / 名字 / enabled / activeRun 都保留，ver +1）。归一 + 校验都在
        LT.updateFromGraph 里；有 err 就整条拒绝并把 err 文本回给 Agent 去修。
        在跑的 run 拿的是启用那刻的快照，改图不影响它（回执里带 runNote 说明）。 */
    if (!boundWf) throw new Error(I18n.t("当前没有打开的画布"));
    const LT = window.LT;
    if (!LT || typeof LT.updateFromGraph !== "function")
      throw new Error(I18n.t("长周期任务模块还没就绪"));
    const r = LT.updateFromGraph(
      boundWf,
      params.uid != null ? String(params.uid) : "",
      params.graph,
      params.name != null ? String(params.name) : "",
    );
    if (!r || !r.ok) throw new Error((r && r.error) || I18n.t("长周期任务图校验未通过："));
    return Object.assign({ ok: true, action }, r);
  }

  if (action === "rename_workflow") {
    if (assistRestrictOtherCanvases()) {
      const ref = String(params.workflow || params.id || "").trim();
      if (ref && boundWf && ref !== boundWf.id && ref !== boundWf.name)
        throw new Error(scopeBlocked);
      /* 无 ref 时改本会话所属画布（用户已切走可见画布也不会改到别的） */
      if (!ref && boundWf) {
        const renamed = await renameWorkflowByRef(
          boundWf.id,
          params.name || params.setName || params.title,
          { wf: boundWf },
        );
        return { ok: true, action, renamed };
      }
    }
    const renamed = await renameWorkflowByRef(
      params.workflow || params.id || "",
      params.name || params.setName || params.title,
      { wf: boundWf },
    );
    return { ok: true, action, renamed };
  }

  if (action === "delete_workflow") {
    /* 收紧删除入口：目标一律经 resolveDeleteWfTarget 锁定 ——
       受限范围只允许删本会话「所属画布」（不兜底 S.wf），全局范围必须显式
       指定 workflow。与确认框（summarizeAppOp）共用同一解析（同一绑定画布口径），
       弹窗期间目标变了就中止；主进程再按 id + 名称双重校验，拒绝原因原样回传。 */
    const t = await resolveDeleteWfTarget(params, { scopeBlocked, wf: boundWf });
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
    /* 会话把自己的所属画布删了 → boundWf 已成墓碑：收尾快照按「删除后落在哪张图」
       报回去（换到那张图的上下文里取），别把已删画布继续当成工作范围。 */
    const afterWf = wfWriteBlocked(boundWf)
      ? currentVisibleWf() || S.wf
      : boundWf;
    const snap = await runAgainstWf(afterWf, () =>
      canvasSnapshotFull({}, { wf: afterWf }),
    );
    return Object.assign({ ok: true, action }, deleted, snap);
  }

  /* 前台视图动作（选中态 / 撤销栈 / 重绘）改的是「用户屏幕上正显示的那一张」：
     本轮绑定画布不在前台时明确拒绝，绝不替用户把他正在干活的画布选中项换掉、
     更不替他把那一张图的改动撤销掉。 */
  if (action === "select_nodes" || action === "undo" || action === "redo") {
    const fg = currentVisibleWf();
    if (!boundWf || !fg || String(boundWf.id) !== String(fg.id))
      throw new Error(I18n.t(
        "该操作只作用于屏幕上正显示的画布：本会话所属画布当前不在前台，为避免改到你正在编辑的另一张图，已拒绝执行。",
      ));
  }

  /* 画布拍照（页脚相机按钮那条链路）：它同样是**截屏** —— 拍的永远是屏幕上那张画布，
     所以先按前台口径锁定目标，再把图交给 captureCanvasForAgent 落盘。 */
  if (action === "export_canvas_png") {
    const fg = currentVisibleWf();
    if (!boundWf || !fg || String(boundWf.id) !== String(fg.id))
      throw new Error(I18n.t(
        "画布拍照是截屏：只能拍屏幕上正显示的那张画布。本会话所属画布当前不在前台，请先切换到它再拍。",
      ));
    return await captureCanvasForAgent(params, boundWf);
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

/* ── 画布修改确认档（唯一真源）──────────────────────────────────────────────
   ask      = 每次修改都请用户确认（缺省）
   approve  = 画布编辑（mtnode_canvas_edit / 节点层等）直接生效，危险操作仍确认
   all      = 连危险操作（删除画布 / 插件装卸）也不问，全部放行
   三档写在同一处配置里；会话「工具」菜单、右上角「审批」面板、给模型的人设文案
   都读它，不各存一份。旧配置 dsh.assistAutoApprove（布尔）按 approve 迁移。 */
const CANVAS_EDIT_MODES = ["approve", "ask", "all"];

function canvasEditMode() {
  const d = (S.config && S.config.dsh) || {};
  const v = d.assistCanvasMode;
  if (CANVAS_EDIT_MODES.indexOf(v) >= 0) return v;
  return d.assistAutoApprove ? "approve" : "ask";
}

function canvasEditModeLabel(mode) {
  const m = mode || canvasEditMode();
  return m === "approve"
    ? I18n.t("批准")
    : m === "all"
      ? I18n.t("全部允许")
      : I18n.t("询问");
}

function canvasEditModeHint(mode) {
  const m = mode || canvasEditMode();
  return m === "approve"
    ? I18n.t("画布编辑直接生效；删除画布 / 插件装卸等危险操作仍会确认")
    : m === "all"
      ? I18n.t("画布编辑与危险操作（删除画布 / 插件装卸）全部直接生效，不再询问")
      : I18n.t("每次修改都弹确认框（默认）");
}

function setCanvasEditMode(mode) {
  if (CANVAS_EDIT_MODES.indexOf(mode) < 0) mode = "ask";
  if (!S.config.dsh) S.config.dsh = {};
  S.config.dsh.assistCanvasMode = mode;
  /* 旧字段继续跟随写：任何还在读 assistAutoApprove 的路径与旧版本配置口径一致 */
  S.config.dsh.assistAutoApprove = mode !== "ask";
  if (window.api && window.api.configSave)
    window.api.configSave(S.config).catch(() => {});
  if (typeof paintApprovalsBtn === "function") paintApprovalsBtn();
}

function canvasOpIsDangerous(op, params) {
  if (op !== "app" || !params) return false;
  return (
    params.action === "delete_workflow" ||
    params.action === "install_dsh_plugin" ||
    params.action === "remove_dsh_plugin" ||
    params.action === "set_dsh_plugin"
  );
}

function canvasOpNeedsConfirm(op, params) {
  /* MCP 连接（第三方客户端）按首次连接授权生效：不逐笔弹确认框。
     开关由 renderer/mcp-bridge.js 只在这一次调用期间置真（见 app.js 的 S._mcpAuthorized）。 */
  if (S._mcpAuthorized) return false;
  if (!S.assistRunActive && !anyAgentSessionRunning()) return false;
  const mode = canvasEditMode();
  if (mode === "all") return false;
  /* 危险操作在任何档位都要人点头（all 除外，已在上一行放行） */
  if (canvasOpIsDangerous(op, params)) return true;
  if (op === "edit") return mode !== "approve";
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
    ["mtnode-unattended", I18n.t("无人值守（工作区读写 · 沙箱拒绝时询问，默认）")],
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
          label: I18n.t("节点层"),
          hint: I18n.t("创建节点层、将节点收纳进子画布（改画布确认门已覆盖）"),
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
          hint: I18n.t("状态、列表、重命名、选中、撤销重做、长任务图读取与原地修改"),
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
      id: "assets",
      label: I18n.t("素材库与截图"),
      items: [
        {
          key: "assets_read",
          label: I18n.t("读素材库 / 窗口截图"),
          hint: I18n.t("列出素材库、取内容条目的本机路径、把 MTNode 窗口拍成静帧 PNG"),
        },
        {
          /* 写素材库（2026-11 新增）：与读分开一档 —— 勾了读不等于把删改能力一并送出。
             动作集：新建素材、加内容条目、把本机文件收进库、改自己创建的条目正文、
             改自己素材的显示名 / 描述 / 分类、删自己创建的素材与条目（进回收站）。
             归属口径在 assets-store.js：用户自己的素材与条目对应用只读；
             MCP / 本机 Agent 不受归属限制（用户共识）。 */
          key: "assets_write",
          label: I18n.t("写素材库"),
          hint: I18n.t("新建素材与内容条目、把本机文件收进库、改删自己创建的东西（删除进回收站）；不勾 = 只能读"),
        },
      ],
    },
    {
      id: "media",
      label: I18n.t("本地媒体（语音 / 视频）"),
      items: [
        {
          key: "media_asr",
          label: I18n.t("音频转写（含字幕时间轴）"),
          hint: I18n.t("audio_transcribe / audio_subtitle：本地 SenseVoice 转写音频 / 视频，含分段起止秒与字幕时间轴"),
        },
        {
          key: "media_ffmpeg",
          label: I18n.t("ffmpeg 处理"),
          hint: I18n.t("ffmpeg：探测、抽音轨、抽帧、抽帧识图、任意参数转码"),
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
  /* 节点层改动由「助手改画布」统一确认门覆盖，不再默认二次询问 */
  return allow;
}

/* 助手改画布已批准 / 全部允许 / 用户刚确认过本次 edit 时，跳过 canvas_* 的工具许可「询问」
   （避免画布确认已放行，却仍被 canvas_super=ask 二次拦截，导致跑到排版/成组阶段突然失败）。 */
function canvasToolAskBypassed(key) {
  if (!String(key || "").startsWith("canvas_")) return false;
  if (canvasEditMode() !== "ask") return true;
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

/* 素材库工具（mtnode_assets）的许可键：**读与写分两档**（2026-11 用户共识）。
   读动作（list / read / screenshot）走 assets_read；写动作（create / addItem / importFile /
   importFiles / updateText / updateMeta / removeItem / deleteAsset）走 assets_write。
   两个键都拒 = 整只工具不注册（见 agentDeniedToolNames）；只拒写 = 工具留着，
   写动作在宿主分发口被拦成一条明确错误（app-db.js）。 */
const ASSET_TOOL_WRITE_ACTIONS = {
  create: 1,
  addItem: 1,
  importFile: 1,
  importFiles: 1,
  updateText: 1,
  updateMeta: 1,
  removeItem: 1,
  deleteAsset: 1,
};
function assetsToolKeyOf(action) {
  return ASSET_TOOL_WRITE_ACTIONS[String(action || "list")] ? "assets_write" : "assets_read";
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

/* ── 按运行的工具许可（runKey 作用域）──
   某些运行自带一份工具许可，覆盖全局「Agent 工具许可」预设（且**只在这一轮生效**）：
   S._runToolPolicy[runKey] = { allow: { 类别key: allow|ask|deny } }。
   用途 = 「一人公司」的专家：每位专家自带 perm.toolAllow（读 / 写文件、联网与读画布放行、
   画布改动与应用操作逐次询问、命令询问，删除画布 / 插件 / 子代理 / 目标 / 作业 / 识图禁止），
   随本轮 dshRunTask 的 opts.toolPolicy 装进来。runKey 隔离保证
   群聊逐位跑（team:<chatId>:<expertId>）互不串味；同一 runKey 下一次运行没带策略就
   删除旧策略 → 缺省一律回退全局预设，现有「审批」面板的行为逐字不变。 */
function runToolPolicyStore() {
  if (!S._runToolPolicy || typeof S._runToolPolicy !== "object")
    S._runToolPolicy = {};
  return S._runToolPolicy;
}

/* 安装本轮策略；policy 为空 / 非法 = 清掉该 runKey 的旧策略（回退全局预设）。 */
function setRunToolPolicy(runKey, policy) {
  const k = String(runKey || "").trim();
  if (!k) return null;
  const store = runToolPolicyStore();
  const raw =
    policy && typeof policy === "object" && policy.allow && typeof policy.allow === "object"
      ? policy.allow
      : policy;
  if (!raw || typeof raw !== "object") {
    delete store[k];
    return null;
  }
  store[k] = { allow: normalizeToolAllowMap(raw) };
  return store[k];
}

function clearRunToolPolicy(runKey) {
  const k = String(runKey || "").trim();
  if (k) delete runToolPolicyStore()[k];
}

function runToolPolicyOf(runKey) {
  const k = String(runKey || "").trim();
  if (!k) return null;
  const store = S && S._runToolPolicy;
  return (store && store[k]) || null;
}

/* runKey 给了就优先读运行态策略（含显式 deny），没给 / 没装策略就回退全局预设。 */
function agentToolMode(key, runKey) {
  const rp = runToolPolicyOf(runKey);
  if (rp && rp.allow && rp.allow[key] !== undefined)
    return normalizeToolMode(rp.allow[key]);
  const p = agentToolActivePreset();
  if (!p || !p.allow || p.allow[key] === undefined) return "allow";
  return normalizeToolMode(p.allow[key]);
}

function agentToolAllowed(key, runKey) {
  return agentToolMode(key, runKey) !== "deny";
}

function agentToolDeniedError(key, detail, runKey) {
  const scoped = !!runToolPolicyOf(runKey);
  return new Error(
    I18n.t(scoped ? "本轮角色权限不允许：" : "当前工具预设不允许：") +
      agentToolItemLabel(key) +
      (detail ? "（" + detail + "）" : "") +
      I18n.t(
        scoped
          ? "。请在团队面板调整该专家的工具许可。"
          : "。请在右上角「审批」中调整 Agent 工具许可。",
      ),
  );
}

function assertAgentTool(key, detail, runKey) {
  if (!agentToolAllowed(key, runKey)) throw agentToolDeniedError(key, detail, runKey);
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
 * @param {string} [runKey] 本轮运行键：给了就按该轮的工具许可（专家 perm.toolAllow）算，
 *   缺省回退全局预设。
 * @returns {string[]} 未排序的工具名（网关负责去重排序）
 */
function agentDeniedToolNames(runKey) {
  /* 识图只有一个入口：dsh 引擎自带的 read_image 无条件不注册（看图一律走
     mtnode_vision —— 它才有宿主审批、多模态后端路由与返回预算）。与工具许可无关，
     所以写在早退之前，任何一轮都带它。 */
  const out = [];
  out.push("read_image");
  const denied = [];
  for (const cat of agentToolCatalog()) {
    for (const it of cat.items) {
      if (agentToolMode(it.key, runKey) === "deny") denied.push(it.key);
    }
  }
  if (!denied.length) return out;
  const has = (k) => denied.indexOf(k) >= 0;
  if (has("vision")) out.push("mtnode_vision");
  if (has("canvas_read")) out.push("mtnode_canvas_get");
  /* 素材库 / 窗口截图只有一个入口工具（assets_read 拒 = 整只不注册） */
  if (has("assets_read")) out.push("mtnode_assets");
  /* 本地媒体：转写（逐字稿 + 字幕）与 ffmpeg 各自一个入口，拒哪项摘哪个；
     media_asr 一项同时管 audio_transcribe 与 audio_subtitle（同一台 SenseVoice） */
  if (has("media_asr")) out.push("audio_transcribe", "audio_subtitle");
  if (has("media_ffmpeg")) out.push("ffmpeg");
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

/* ── 工具族按需注册（browser_* / 素材 / 音视频）：按「本轮提没提到」整族裁掉 ──
   这三族合计约 10K+ 字符，绝大多数会话整轮都用不上，却每一步都随固定前缀重发一遍。
   判据只看**这一轮用户原话 + 最近几轮用户消息**（会话侧传 roundHistory）：
     · 提到了 → 整族照常注册（宁可多带一次，也不让模型撞不存在的工具）；
     · 一句都没提 → 整族按名字进 hideTools（网关归一后进 runtime key 的 hx: 指纹，
       换档 = 冷起一台自己的运行时，同档每一步前缀完全一致）。
   名单真源 = dsh/gateway/tool-visibility.mjs 的 HIDEABLE_TOOLS（这里点名的每个名字都
   必须在那份白名单里，否则会被网关静默丢弃；名单一致性由 test/smoke-token-budget.js 钉住）。 */
const AGENT_TOOL_FAMILY_TOOLS = {
  /* 会话自己的浏览器（整族一个判据：某个入口不在，这一族也干不成活） */
  browser: [
    "browser_launch",
    "browser_snapshot",
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_key",
    "browser_eval",
    "browser_wait",
    "browser_screenshot",
    "browser_tabs",
    "browser_network",
    "browser_help",
    "browser_release",
  ],
  /* 素材库（读素材 + 整窗截图）只有一个入口 */
  assets: ["mtnode_assets"],
  /* 本地媒体：转写 / 字幕 / ffmpeg 是同一类活（听音频、做字幕、看视频、抽帧转码） */
  media: ["audio_transcribe", "audio_subtitle", "ffmpeg"],
};

/* 每一族的「提到了」判据（中英混写，按词面命中即算提到）。
   故意写得宽：多命中一次只是多带一份 schema，漏判一次会让模型整轮干不成活。 */
const AGENT_TOOL_FAMILY_HINTS = {
  browser:
    /(浏览器|网页|网站|网址|页面|标签页|登录页|browser|web\s?page|website|\burl\b|https?:\/\/|localhost|chrome|firefox)/i,
  assets: /(素材|素材库|资源库|缩略图|截图|asset|screenshot)/i,
  media:
    /(音频|视频|音轨|语音|字幕|转写|转录|逐字稿|录音|录像|抽帧|配音|播客|ffmpeg|\bmp3\b|\bmp4\b|\bwav\b|\bm4a\b|\bflac\b|\bsrt\b|\bvtt\b)/i,
};

/**
 * 这一轮一句都没提到、因此整族不该注册的工具名（宿主侧映射本文件是唯一真源）。
 *
 * 只做「按族」判断：任意一条命中 = 这一族全留（不是逐工具判），这样同一档的名单稳定、
 * 运行期可见集不会一步一个样。返回未排序的工具名，排序去重交给 dshHiddenToolsFor。
 * @param {string} [text] 这一轮的用户原话（不是续跑指令 —— 续跑轮的原文由调用方冻结传入）
 * @param {string[]} [hist] 最近几轮用户消息（接续轮别因为这一轮没复述关键词就掉工具）
 * @returns {string[]}
 */
function agentHiddenToolNames(text, hist) {
  const said = [];
  const addSaid = (x) => {
    const s = String(x == null ? "" : x).trim();
    if (s) said.push(s);
  };
  addSaid(text);
  const back = Array.isArray(hist) ? hist.slice(-4) : [];
  for (const h of back) addSaid(h);
  const out = [];
  for (const family of Object.keys(AGENT_TOOL_FAMILY_TOOLS)) {
    const hint = AGENT_TOOL_FAMILY_HINTS[family];
    if (hint && said.some((s) => hint.test(s))) continue;
    for (const n of AGENT_TOOL_FAMILY_TOOLS[family]) out.push(n);
  }
  return out;
}

async function ensureAgentTool(key, detail, runKey) {
  /* MCP 连接（第三方客户端）：授权在「首次连接」那一步已经给过，这里不再逐项问许可
     （与 canvasOpNeedsConfirm 同一开关，只在这一次调用期间为真）。 */
  if (S._mcpAuthorized) return;
  const mode = agentToolMode(key, runKey);
  if (mode === "deny") throw agentToolDeniedError(key, detail, runKey);
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
  if (!ok) throw agentToolDeniedError(key, detail || I18n.t("用户拒绝"), runKey);
}

function normalizeCanvasCreateKind(kind) {
  if (kind === "image" || kind === "img") return "input_image";
  if (kind === "text") return "input_text";
  if (kind === "save_text" || kind === "save_image") return "save";
  return kind;
}

function canvasKindToolKey(kind) {
  /* 工具节点的规范形态是节点层变体（super + tool:true），创建它等同于建一个超级壳 */
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
  /* 排版闸：只有本笔显式写了 layout:true 才排（自动排版已按 2026-02 需求撤掉，
     见 canvasEditWantsLayout；普通编辑既不挪位置也不改尺寸） */
  const wantsLayout = canvasEditWantsLayout(params, creates);
  const doLayout = wantsLayout;
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

function assertCanvasEditTools(params, runKey) {
  for (const key of collectCanvasEditToolKeys(params)) assertAgentTool(key, undefined, runKey);
}

async function ensureCanvasEditTools(params, runKey) {
  for (const key of collectCanvasEditToolKeys(params)) await ensureAgentTool(key, undefined, runKey);
}

function agentToolPolicySystemNote(opts) {
  try {
    ensureAgentToolPresets();
  } catch (_) {
    return "";
  }
  const nodeLock = !!(opts && opts.nodeLock);
  /* 无读画布档位（Gate A：开发绑定会话）：宿主本轮没注册 mtnode_canvas_get / mtnode_app，
     口径必须同步说一句，否则模型会照着「先读画布」的旧纪律去调不存在的工具。 */
  const noCanvasRead = !!(opts && opts.noCanvasRead);
  /* 只读画布档（长周期任务的 Agent 环节勾了「允许读取画布」）：画布三件套里只注册了
     mtnode_canvas_get，且读的是本画布。必须说一句 —— 否则模型会照着默认人设去改画布。 */
  const canvasReadOnly = !!(opts && opts.canvasReadOnly);
  /* 按运行的工具许可（专家运行）：有运行态策略时这一节必须照它说，否则人设里
     「写文件放行 / 画布禁止」与实际下发的可见工具集互相打脸。 */
  const runPolicy = runToolPolicyOf(opts && opts.runKey);
  const p = agentToolActivePreset();
  const allow = (runPolicy && runPolicy.allow) || (p && p.allow) || defaultToolAllow();
  const denied = [];
  const asking = [];
  for (const cat of agentToolCatalog()) {
    for (const it of cat.items) {
      const mode = normalizeToolMode(allow[it.key]);
      if (mode === "deny") denied.push(it.label + " (" + it.key + ")");
      else if (mode === "ask") asking.push(it.label + " (" + it.key + ")");
    }
  }
  const name = runPolicy
    ? I18n.t("本轮角色权限")
    : (p && p.name) || I18n.t("默认（当前能力）");
  let s =
    I18n.t("【Agent 工具许可】当前预设「") +
    name +
    I18n.t("」。");
  /* 画布修改确认档：ask / approve / all（真源见 canvasEditMode）。
     按运行有专权限（runPolicy）时不注入全局档位的说法。 */
  const editMode = runPolicy ? "ask" : canvasEditMode();
  const assistAuto = editMode !== "ask";
  const assistLine =
    editMode === "all"
      ? I18n.t(
          "助手改画布为「全部允许」：mtnode_canvas_edit / 节点层等画布修改，以及删除画布 / 插件装卸等危险操作，都直接生效，不再弹确认。",
        )
      : editMode === "approve"
        ? I18n.t(
            "助手改画布已批准：mtnode_canvas_edit / 节点层等画布修改直接生效，无需再等确认；删除画布 / 插件装卸等危险操作仍会弹窗确认。",
          )
        : "";
  if (nodeLock) {
    s += I18n.t(
      "本次运行为智能节点：读取画布与节点 / 连线操作已放行（改现有节点前先问用户）；控制类节点、节点层、绘图、排版与成组按上面的许可逐次询问；应用操作与删除画布一律拒绝（mtnode_app 本轮不注册）。",
    );
  }
  if (noCanvasRead)
    s += I18n.t(
      "本轮不注册读画布与应用工具（mtnode_canvas_get / mtnode_app 调用即失败）：画布现状以宿主给的契约为准；本会话不改画布 —— 执行与收尾都不回写本节点的 title / note / devStatus / devFiles，也不改其它任何节点、连线或画布内容。",
    );
  if (canvasReadOnly)
    s += I18n.t(
      "本轮只授权读取画布：mtnode_canvas_get 可用（读的是本画布）；mtnode_canvas_edit / mtnode_app 本轮未注册，调用即失败 —— 要改画布请让用户自己动手。",
    );
  if (!denied.length && !asking.length) {
    if (!nodeLock && !canvasReadOnly)
      s += I18n.t("当前预设允许全部已列出的工具类别（与产品默认能力一致）。");
    if (assistLine && !noCanvasRead) s += assistLine;
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
  if (assistLine) s += assistLine;
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
    /* persistent：这块面板里全是下拉与开关，点外部不再自动收起（关它只走顶栏同一个按钮
       toggleApprovalsPanel）—— 弹窗 persistent 是全应用原则，见 AGENTS.md */
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
  lab3.textContent = I18n.t("助手改画布（画布助手 / 智能会话）");
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
    "批准=画布编辑直接生效（危险操作仍确认）；询问=每次确认一次；全部允许=连删除画布 / 插件装卸也不问",
  );
  meta3.appendChild(small3);
  row3.appendChild(meta3);
  const toggles3 = document.createElement("div");
  toggles3.className = "ap-mode-toggles";
  toggles3.id = "apAssistCanvasToggles";
  const curMode3 = canvasEditMode();
  const assistModes = [
    ["approve", I18n.t("批准"), true],
    ["ask", I18n.t("询问"), false],
    ["all", I18n.t("全部允许"), true],
  ];
  for (const [mode, label, autoVal] of assistModes) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "ap-mode-btn ap-mode-" +
      (autoVal ? "allow" : "ask") +
      (curMode3 === mode ? " on" : "");
    b.textContent = label;
    b.title = canvasEditModeHint(mode);
    b.onclick = () => {
      setCanvasEditMode(mode);
      toggles3.querySelectorAll(".ap-mode-btn").forEach((x) => {
        x.classList.toggle("on", x === b);
      });
      toast(
        I18n.t("画布修改确认：") + canvasEditModeLabel(mode) + "（" + canvasEditModeHint(mode) + "）",
        "ok",
      );
      /* 会话侧「工具」菜单同源，跟着回显 */
      if (typeof buildAgentToolsMenu === "function") {
        buildAgentToolsMenu();
        buildAgentToolsMenu("assistToolsMenu");
      }
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

/* 解析识图路由：供应商顺序 → 模型顺序；目录已标注能吃图的模型排前面，
   只在服务商上带 vision 标记的手填模型降到次选；失败可重试下一路由 */
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
    /* 文本服务商（配成 text_openai，或同一端点里含文本模型的混合配置）：
       识图候选只从它们的文本模型里挑，图像生成模型不参与 */
    if (!providerHasKind(S.config, p, "text")) continue;
    if (!String(p.apiKey || "").trim() || !String(p.baseUrl || "").trim()) continue;
    const route = "mtnode_" + p.id;
    const vis = visionModelsForProvider(route);
    if (vis.length) {
      /* 目录已声明 image 的模型（如 DeepSeek 官方的 deepseek-flash）可直连 */
      for (const m of vis) push(p, m.id, m.name || m.id, false);
    } else if (p.vision && Array.isArray(p.models) && p.models.length) {
      /* 目录没标注、只在服务商上带 vision 标记的手填模型：降到次选 */
      for (const id of modelsOfKind(S.config, p, "text"))
        push(p, String(id), String(id), true);
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

async function applyVisionInspect(params, runKey) {
  params = params || {};
  const imagePath = String(params.imagePath || "").trim();
  const question = String(params.question || "").trim();
  if (!imagePath) return { ok: false, error: I18n.t("缺少 imagePath") };
  if (!question) return { ok: false, error: I18n.t("缺少 question") };
  try {
    await ensureAgentTool("vision", undefined, runKey);
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
        "没有可用的视觉模型；请在「模型服务」把支持识图的服务商排到前面，并把视觉模型排到该服务商列表最前（DeepSeek 官方用 deepseek-flash）",
      ),
    };
  }
  const prompt =
    PS(
      "subagent.vision",
      I18n.t("你是识图子代理。根据用户问题仔细查看图片并作答；只输出与问题相关的观察与结论，不要编造看不到的内容。\n\n问题："),
    ) +
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

async function summarizeAppOp(params, runWf) {
  params = params || {};
  if (params.action === "delete_workflow") {
    /* 与执行体同一口径解析删除目标（同一「本轮绑定画布」，不是用户此刻看到的画布），
       把 id + 节点数 + 名称摊给用户看，并把解析结果登记成「确认戳」供 applyAppOp
       复核（防弹窗期间目标漂移）。解析失败时不猜测目标，直接把原因显示出来
       （执行端还会再校验一次）。 */
    let t = null;
    let fail = "";
    try {
      t = await resolveDeleteWfTarget(params, { wf: runWf || null });
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
/* 本轮挂起的确认框数（本次需求）：看门狗用它判「这一轮是不是正在等人」——
   有确认框在等用户点，就与提问 / 审批 / 求助卡同族**不设等待上限**（见 app-db.js 的
   DSH_IX_WAIT_TIMEOUT_MS）。少了这一条，只弹确认框、没弹卡片的那一轮会被 30 分钟
   静默上限当成「引擎挂了」自动终止 —— 用户正看着框想点，会话却自己停了。 */
function canvasConfirmPendingOf(runKey) {
  const k = String(runKey || "");
  if (!k) return 0;
  let n = 0;
  for (const [, it] of canvasConfirmRegistry()) if (String(it.runKey || "") === k) n++;
  return n;
}

/* ── 关掉后还能唤回（本次需求）───────────────────────────────────────────
   确认框可以被 ✕ / Esc / 被别的弹窗顶掉 —— 那是「先放一边」，不是作答。以前这一关
   就再也找不回来：回执永远悬着，发起这一轮只能干等。现在关窗只把这一笔记进待办表，
   右下角挂一枚「待确认的修改 · 点击唤回」，点它把同一个框原样打开，仍走同一条回执。
   发起轮结束（canvasConfirmRegistry 自动撤框）时待办一并清掉，不留死链。 */
const canvasConfirmParked = new Map();
let canvasConfirmParkedSeq = 0;
function canvasConfirmParkedPaint() {
  let el = document.getElementById("canvasConfirmRecall");
  const n = canvasConfirmParked.size;
  if (!n) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("button");
    el.type = "button";
    el.id = "canvasConfirmRecall";
    el.style.cssText =
      "position:fixed; right:18px; bottom:18px; z-index:9000; display:inline-flex; align-items:center;" +
      " gap:6px; padding:8px 14px; border-radius:999px; border:1px solid var(--bd);" +
      " background:var(--panel, var(--bg)); color:var(--fg); font-size:12px; cursor:pointer;" +
      " box-shadow:0 6px 18px rgba(0,0,0,.28)";
    el.addEventListener("click", () => {
      const first = canvasConfirmParked.values().next().value;
      if (first && typeof first.open === "function") first.open();
    });
    document.body.appendChild(el);
  }
  el.textContent =
    n > 1
      ? I18n.t("待确认的修改 ") + n + I18n.t(" 笔 · 点击唤回")
      : I18n.t("待确认的修改 · 点击唤回");
  el.title = I18n.t(
    "刚才的确认框被关掉了：点这里重新打开（拒绝 / 全部允许 / 确认修改）",
  );
}

function confirmAssistAction(title, info, opts) {
  info = info || {};
  opts = opts || {};
  return new Promise((resolve) => {
    /* owner = 发起这一帧的那一轮：{ id: 帧 id, runKey, sessionId } */
    const owner = opts.owner || null;
    const confirmId = owner && owner.id ? String(owner.id) : "";
    /* 待办键：有帧 id 用帧 id（同一帧重复唤回只占一条），本地调用另起序号 */
    const parkKey = confirmId || "local-" + ++canvasConfirmParkedSeq;
    let done = false;
    /* 屏幕上这一刻显示的框是不是我：自毁路径可能晚于用户打开别的弹窗（设置、
       保存路径…），那时绝不能越界 closeOverlay 把别人正在填的表关掉。 */
    const overlayBox = () => document.querySelector("#overlay .overlay-box");
    const overlayIsMine = () => {
      if (!confirmId) return true;
      const b = overlayBox();
      return !!b && b.dataset.ixConfirmId === confirmId;
    };
    /* ans: true=确认 / false=拒绝 / IX_CONFIRM_DEAD=发起轮已结束，自动撤框 */
    const settle = (ans, closeDom) => {
      if (done) return;
      done = true;
      canvasConfirmParked.delete(parkKey);
      canvasConfirmParkedPaint();
      canvasConfirmUnregister(confirmId);
      const b = overlayBox();
      if (closeDom && overlayIsMine()) {
        if (b && b.dataset.ixConfirmId) delete b.dataset.ixConfirmId;
        closeOverlay();
      }
      resolve(ans);
    };
    /* 首次弹出与「唤回」共用这一份渲染：同一笔只有一个出口，不各写一套 */
    const paint = () => {
      if (done) return;
      canvasConfirmParked.delete(parkKey);
      canvasConfirmParkedPaint();
      openOverlay(title || I18n.t("确认操作"));
      overlayPersistent = true;
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
        hint.textContent = I18n.t(
          "发起该请求的运行结束后，此确认框会自动消失；关闭窗口不会丢弃这次请求，可从右下角「待确认的修改」唤回。",
        );
        body.appendChild(hint);
      }
      foot.innerHTML = "";
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
      /* 全部允许（本次需求）：本次直接放行，并把「画布修改确认」切到 all ——
         后续修改（含危险操作）都不再询问。与右上角「审批」/「工具」菜单同一份配置。 */
      const allowAll = document.createElement("button");
      allowAll.className = "mini";
      allowAll.textContent = I18n.t("全部允许");
      allowAll.title = I18n.t("本次直接生效，且后续画布修改都不再询问（可在「审批」里改回）");
      allowAll.onclick = () => {
        setCanvasEditMode("all");
        toast(I18n.t("已设为「全部允许」：后续画布修改不再询问"), "copy");
        settle(true, true);
      };
      const ok = document.createElement("button");
      ok.className = "mini primary";
      ok.textContent = I18n.t("确认修改");
      ok.onclick = () => settle(true, true);
      foot.appendChild(cancel);
      foot.appendChild(allowAll);
      foot.appendChild(ok);
      /* 窗被关掉（✕ / Esc / 被别的弹窗顶掉）＝先放一边：这一笔挂到「唤回」入口上，
         回执继续等用户作答；点那枚浮标把同一个框原样打开。 */
      setOverlayCloseHook(() => {
        if (done) return;
        canvasConfirmParked.set(parkKey, { open: paint });
        canvasConfirmParkedPaint();
      });
    };
    paint();
  });
}

function confirmAssistCanvasEdit(params, owner) {
  const info = summarizeCanvasEdit(params);
  const fromSession = canvasConfirmFromAgentSession();
  info.summary =
    (fromSession
      ? I18n.t("智能会话请求修改当前画布：")
      : I18n.t("画布助手请求修改当前画布：")) + info.summary;
  return confirmAssistAction(I18n.t("确认画布修改"), info, {
    rejectStopsAgent: fromSession,
    owner,
  });
}

async function confirmAssistAppOp(params, owner, runWf) {
  /* 摘要需要读一次画布列表才能显示真实 id / 节点数，故为异步；
     调用方以 Promise 方式消费（.then / .catch），行为不变。
     runWf = 本轮绑定画布：删除目标在弹窗里就按「会话所属画布」解析，
     与执行端（applyAppOp）同一口径，杜绝「显示 A、实际删 B」。 */
  const info = await summarizeAppOp(params, runWf);
  const fromSession = canvasConfirmFromAgentSession();
  info.summary =
    (fromSession
      ? I18n.t("智能会话请求：")
      : I18n.t("画布助手请求：")) + info.summary;
  return confirmAssistAction(I18n.t("确认危险操作"), info, {
    rejectStopsAgent: fromSession,
    owner,
  });
}

/* 走主进程画布文档服务取一次快照（读侧开关 canvases.docService=read 时才试）。
   为什么这里还要过一道：只有渲染层知道「本轮绑定的是哪张画布」（会话→画布映射在主进程
   不存在），所以 id 由这里定，快照本体与 contentHash 由主进程算（不进 UI 线程）。
   回执上只补渲染层独有的现场，顺序与 canvasSnapshotFull 完全一致：选中项 → 助手面板开关
   → 会话锁定的 scopeNote / 单张 workflows → minimal 收口 → sections 过滤。
   任何一步不成（开关没开 / 主进程没就绪 / 报错 / 素材条目正文要渲染层补）都返回 null，
   由调用方原路退回 canvasSnapshotFull —— 老路整体保留。 */
async function canvasDocSnapshotViaService(opts, boundWf) {
  const cfg = S.config && S.config.canvases;
  if (!cfg || cfg.docService !== "read") return null;
  const api = window.api;
  if (!api || typeof api.canvasDocGet !== "function") return null;
  const id = String((boundWf || S.wf || {}).id || "");
  if (!id) return null;
  /* 文档真源在磁盘：自动保存有 250ms 防抖，刚改完立刻让 Agent 读会读到上一版。
     有待写的那一版就先刷下去（没有待写就什么都不做，不给每次读都加一次落盘）。 */
  if (S.saveTimer) {
    try {
      await flushCurrentWf();
    } catch (_) {}
  }
  let r = null;
  try {
    r = await api.canvasDocGet(id, opts || {});
  } catch (_) {
    return null;
  }
  if (!r || !r.ok || !r.snapshot || typeof r.snapshot !== "object") return null;
  const snap = r.snapshot;
  const o = normalizeSnapshotOpts(opts || {});
  const want = (k) => snapshotWantsSection(o, opts || {}, k);
  /* 素材节点的条目正文只在渲染层（素材库条目 + 本机路径）补得出来：这一档要求正文，
     而这张图里确实有素材节点 —— 交回老路，宁可多算一次也不能少给正文。 */
  if (o.wantBodies && (snap.nodes || []).some((n) => n && n.kind === "asset" && n.assetItems))
    return null;
  if (want("selection"))
    snap.selection = currentSelection().map((n) => ({ id: n.id, kind: n.kind, title: n.title }));
  if (o.detail !== "minimal") {
    snap.assistOpen = !!S.assistOpen;
    snap.sidebarOpen = !!S.sidebarOpen && S.view !== "agent";
  }
  applyAssistScopeToSnapshot(snap, { wf: boundWf });
  /* 锁定本画布时 applyAssistScopeToSnapshot 会回写 workflows（= 本图一行）；minimal 档下
     它仍能在 scopeNote 里说明「工作范围 = 本会话所属画布」，不必再带一份画布列表。 */
  if (o.detail === "minimal" && !want("workflows")) delete snap.workflows;
  applySnapshotSectionFilter(snap, (opts || {}).sections);
  return snap;
}

async function applyCanvasOp(op, params, runCtx) {
  /* 本轮绑定画布（会话「所属画布」）：应用级操作的目标解析只认它，不认栈顶。 */
  const boundWf = (runCtx && runCtx.wf) || null;
  /* 本轮运行键：按运行的工具许可（专家自带 perm.toolAllow）以它为作用域，
     缺省（老会话 / 裸节点 / 助手）无策略 → 回退全局预设，行为不变。 */
  const runKey = (runCtx && runCtx.runKey) || "";
  /* 长任务「只读画布」档：get 是这一档授权的全部内容；edit / app 即便从别的路径注册出来，
     在这里也一律拒 —— 授权只是「读」，不是「改」。 */
  if ((S._ltCanvasReadDepth || 0) > 0 && (op === "edit" || op === "app")) {
    throw new Error(I18n.t("本环节只授权读取画布：不能改动画布或应用。"));
  }
  if (op === "app") return applyAppOp(params || {}, boundWf, runKey);
  if (op === "vision") {
    return await applyVisionInspect(params || {}, runKey);
  }
  if (!S.wf) throw new Error(I18n.t("当前没有打开的画布"));
  /* 绑定的画布已被删除（黑名单 / 对象墓碑）：明确报「画布已删除」，
     不再静默改内存 + 落盘 —— 那会把用户刚删掉的画布凭空复活。 */
  if (wfWriteBlocked(S.wf)) throw new Error(deletedWfError(S.wf));
  if (op === "get") {
    await ensureAgentTool("canvas_read", undefined, runKey);
    /* 读侧开关 canvases.docService=read：快照改由主进程文档服务算；没开 / 不成 → 老路 */
    const viaService = await canvasDocSnapshotViaService(params || {}, boundWf);
    if (viaService) return Object.assign({ ok: true }, viaService);
    return Object.assign(
      { ok: true },
      await canvasSnapshotFull(params || {}, { wf: boundWf }),
    );
  }
  if (op === "edit") return await applyCanvasEdit(params || {}, runCtx || null);
  throw new Error(I18n.t("未知画布操作：") + op);
}

/* 真机调试（应用开发会话的 mtnode_gui）：帧的执行转交主进程。
   为什么不在渲染层做：GUI 动作要用 BrowserWindow / webContents 注入脚本与 capturePage
   截图，只有主进程拿得到（根目录 mcp-gui-agent.js）。这里只做一次转发：
   api.dshGuiRun → 主进程 → 结果经 dshInteract kind:'gui' 原路回网关（与画布 / 数据库
   工具同一条桥）。归属（这帧属不属于正在跑的那一轮）已由网关按 sessionId 判完，
   渲染层不重复裁决；失败一律折成这一条工具调用的失败回执，会话不中断。 */
function handleGuiToolEvent(data, runCtx) {
  const id = data && data.id;
  if (!id) return;
  const action = String((data && data.action) || "");
  const params = (data && data.params) || {};
  let replied = false;
  const finish = (result, error) => {
    if (replied) return;
    replied = true;
    try {
      window.api
        .dshInteract({
          kind: "gui",
          id,
          result: result == null ? undefined : result,
          error: error || undefined,
        })
        .catch(() => {});
    } catch (_) {}
  };
  const fn = window.api && window.api.dshGuiRun;
  if (typeof fn !== "function") {
    finish(null, I18n.t("宿主桥未就绪：当前版本不能执行 GUI 动作"));
    return;
  }
  Promise.resolve(fn(action, params))
    .then((r) => {
      /* 主进程的回执对 GUI 失败用的是 {ok:false,error}（不是 reject），这里翻成
         工具失败 —— 与 canvas / db 同一口径，模型看到的是可读错误而不是半截结果。 */
      if (r && r.ok === false) finish(null, String(r.error || I18n.t("GUI 动作没有生效")));
      else finish(r);
    })
    .catch((e) => finish(null, (e && e.message) || String(e)));
}

/* 开发调试（mtnode_dev · 「扩展能力管理 → 开发调试」总开关打开的那一轮）：与 handleGuiToolEvent
   同一条转发路线，执行体换成根目录 dev-agent.js（起隔离实例 / CDP 驱动 / reload / restart）。
   为什么同样只能由主进程做：起 `electron .` 需要 electron 二进制与 app.getAppPath()，
   截图与控制台都在渲染进程里，只有主进程能 spawn 并连它的 CDP。归属已由网关按 sessionId 判完；
   失败一律折成这一条工具调用的失败回执，会话不中断（起不来的错误里带实例输出尾巴）。 */
function handleDevToolEvent(data, runCtx) {
  const id = data && data.id;
  if (!id) return;
  const action = String((data && data.action) || "");
  const params = (data && data.params) || {};
  let replied = false;
  const finish = (result, error) => {
    if (replied) return;
    replied = true;
    try {
      window.api
        .dshInteract({
          kind: "dev",
          id,
          result: result == null ? undefined : result,
          error: error || undefined,
        })
        .catch(() => {});
    } catch (_) {}
  };
  const fn = window.api && window.api.dshDevRun;
  if (typeof fn !== "function") {
    finish(null, I18n.t("宿主桥未就绪：当前版本不能执行开发调试动作"));
    return;
  }
  Promise.resolve(fn(action, params))
    .then((r) => {
      if (r && r.ok === false) finish(null, String(r.error || I18n.t("调试动作没有生效")));
      else finish(r);
    })
    .catch((e) => finish(null, (e && e.message) || String(e)));
}

function handleCanvasEvent(data, runCtx) {  const id = data && data.id;
  if (!id) return;
  runCtx = runCtx || {};
  /* 本轮绑定画布（= 发起这一帧的会话「所属画布」，见 app-db.js dshRunTask）：
     它是这一帧唯一的写入目标；没有它（渲染层本地直调 / 老版调用）才退回栈顶口径。 */
  const boundWf = runCtx.wf || null;
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
    /* MCP 帧（第三方客户端经主进程 mcp-server.js 推来）走 mcpFrameSettle 原路回主进程，
       不走 dshInteract —— 那条通道只认 dsh 网关里在跑的轮。 */
    if (typeof runCtx.mcpFrameSettle === "function") {
      runCtx.mcpFrameSettle(result, error || undefined);
      return;
    }
    window.api
      .dshInteract({ kind: "canvas", id, result, error: error || undefined })
      .then((res) => {
        /* stale = 网关侧这条 pending 已经没了（本轮结束 / 已被撤销）：插件那端
           早已收到 {t:'abort'} 并以失败收场，模型不会拿到半截结果。自毁路径自己
           会提示一次，这里别再重复刷屏；其余路径必须说明，否则用户以为改了。
           说明的落点（本次需求 · 拷问共识）：**不弹右下角红字**，改在会话里落一行
           「这一轮已经结束」痕迹（与卡片收口同一条通道，可复核、可重发本轮）。 */
        if (res && res.stale && !(opts && opts.silentStale)) {
          const why = I18n.t("画布操作已失效（发起轮已结束），未执行");
          if (typeof ixRoundEndTrace === "function")
            ixRoundEndTrace(frameOwner.runKey, "⏹ " + why);
          else toast(why, "warn");
        }
      })
      .catch(() => {});
  };
  const opEarly = data.op || "get";
  /* 长任务「只读画布」档：get 放行（授权只有读），edit / app 直接失败，不弹确认框。 */
  if ((S._ltCanvasReadDepth || 0) > 0 && (opEarly === "edit" || opEarly === "app")) {
    const err = I18n.t("本环节只授权读取画布：不能改动画布或应用。");
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
      if (opName === "vision") {
        /* 识图只读本机图片文件，与画布无关：不进画布上下文 */
        result = await applyCanvasOp(opName, data.params || {}, runCtx);
      } else {
        /* 目标 = 本轮绑定画布（会话「所属画布」，dshRunTask 随 runCtx 交进来）。
           应用级 op 现在也进 runAgainstWf：status / list_workflows 的快照、rename、
           delete 的目标全在那张图的上下文里解析，用户切走前台画布也改不到别的图。
           并行跑多条会话时运行栈栈顶是谁纯看时序，所以只在 runCtx 没带 wf 的本地
           调用路径上才退回旧口径。 */
        const target = boundWf || canvasTargetWf();
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
  /* 参数只能从「参数」端子来：带 params 的编辑注定被拒（闸在 applyCanvasEdit），
     在弹「是否允许改画布」之前就回失败 —— 不让用户白点一次确认。 */
  if (opEarly === "edit") {
    const reject =
      typeof NParam === "object" && NParam && typeof NParam.editParamsRejection === "function"
        ? NParam.editParamsRejection(data.params || {})
        : "";
    if (reject) {
      finish({ ok: false, error: reject }, reject);
      return;
    }
  }
  const op = data.op || "get";
  if (canvasOpNeedsConfirm(op, data.params || {})) {
    const ask =
      op === "app"
        ? confirmAssistAppOp(data.params || {}, frameOwner, boundWf)
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
    /* 用绘制尺寸（展开节点层 = expandW/H），否则新布局会叠到可见壳层上 */
    const sz = layoutNodeSize(n);
    maxX = Math.max(maxX, n.x + sz.w);
    minY = Math.min(minY, n.y);
  }
  return { x: snap(maxX + 96), y: snap(minY) };
}

function shiftToClear(placed, obstacles) {
  if (!obstacles.length) return { x: 0, y: 0 };
  /* 障碍物只要求「不压住」：这里留 1 格余量（与相邻缝同一口径），不是让块内变松 */
  const pad = layoutGap();
  const g = layoutGap();
  const hit = (dx, dy) => {
    /* 整体平移必须落在网格上：块内「缝恰好 1 格」在平移下才保持成立 */
    dx = Math.round(dx / g) * g;
    dy = Math.round(dy / g) * g;
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
  const downs = [1, 2, 3, 4, 6, 8, 12, 18, 26, 36, 50].map((k) => k * g);
  const rights = [1, 2, 3, 4, 6, 8, 12, 18, 26].map((k) => k * g);
  for (const dy of downs) {
    if (!hit(0, dy)) return { x: 0, y: dy };
  }
  for (const dx of rights) {
    if (!hit(dx, 0)) return { x: dx, y: 0 };
    for (const dy of downs) {
      if (!hit(dx, dy)) return { x: dx, y: dy };
    }
  }
  return { x: 0, y: downs[downs.length - 1] };
}

/* 排版收尾的兜底防重叠（2026-02 口径：缝 ≥ 1 格 + 坐标对齐网格）：
   - 用「绘制尺寸」（layoutNodeSize）判断，展开节点层按 expandW/H 参与碰撞；
   - 残余重叠（绘制尺寸 ≠ 存储尺寸、跨组件装箱误差、障碍物误判、尺寸漂移等）
     一律按「更省位移的轴、优先向下」推到**缝 ≥ 1 格**的位置，并落在网格上；
   - 正常情况下上一段放置已经做到「缝恰好 1 格」，这里极少触发，纯兜底。 */
const LAYOUT_OVERLAP_PAD = 10;
const LAYOUT_OVERLAP_MAX_PASS = 12;
/** 缝宽下限：相邻两节点之间只允许「≥ 1 个网格」（正常路径恰好 = 1 格） */
function layoutOverlapPad(opts) {
  if (opts && opts.pad != null) return Math.max(0, Number(opts.pad) || 0);
  return layoutGap();
}
function resolvePlacedOverlaps(nodes, obstacles, opts) {
  const pad = layoutOverlapPad(opts);
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
          /* 向下推：推到「上者底边 + 1 格」，再抬到网格（只会更远，不会更近） */
          const low = centerY(a) <= centerY(b) ? b : a;
          const up = low === b ? a : b;
          low.y = Math.ceil(Math.max(low.y + oy, up.y + layoutNodeSize(up).h + pad) / g) * g;
        } else {
          const right = centerX(a) <= centerX(b) ? b : a;
          const left = right === b ? a : b;
          right.x = Math.ceil(
            Math.max(right.x + ox, left.x + layoutNodeSize(left).w + pad) / g,
          ) * g;
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

/* ── 新节点落点：就近找空位、绝不挪动已有节点（2026-02 需求）──────────────
   背景：撤掉「编辑即自动排版」之后，agent / MCP 新建的节点不再由排版引擎摆位，
   若照旧按 `placeY = node.y + node.h + 48` 一路往下堆，会直接压在老节点上。
   于是这里只做一件事：在已有内容周围**只往外找**一个不重叠的位置（先向下、
   再向右、最后右下），全程不读写已有节点的坐标 —— 已有节点一个都不动。
   局部画布（scope / 父壳）里的新节点用的是舞台局部坐标，所以障碍物按同一层级取。 */
function nodePlacementObstacles(cand) {
  const sid = String(nodeParentSuperId(cand) || "");
  const tid = String(nodeParentTaskId(cand) || "");
  return (S.wf.nodes || []).filter((n) => {
    if (!n || n.id === cand.id) return false;
    if (isSuperIoNode(n)) return false;
    const s = layoutNodeSize(n);
    const onSid = String(nodeParentSuperId(n) || "");
    return sid ? onSid === sid : !onSid && String(nodeParentTaskId(n) || "") === tid;
  });
}

/** 新节点就近摆位（2026-02 需求：编辑不再自动排版）：只摆「本笔新建且没给 x/y」的节点。
 *  给了坐标的、已有的一律不动；障碍物 = 同一层级的既有节点 + 本批已摆好的新节点
 *  （逐个重算，同批也不重叠）；局部画布（scope）下跳过界外节点，与其余写入闸同一口径。
 *  @param {Array} created 本笔新建的节点（已在 S.wf.nodes 里、父壳 / 父任务已解析完）
 *  @param {{origin:{x:number,y:number}, pinned:Set<string>, outOfScope:(n)=>boolean}} opts */
function applyNewNodePlacement(created, opts) {
  const o = opts || {};
  const pinned = o.pinned || new Set();
  const originTop = o.origin || { x: snap(48), y: snap(48) };
  const outOfScope = typeof o.outOfScope === "function" ? o.outOfScope : () => false;
  for (const node of created || []) {
    if (!node || !nodeById(node.id)) continue;
    if (outOfScope(node)) continue;
    if (pinned.has(node.id)) continue;
    /* 顶层用「已有内容右边」当起点；壳 / 任务内部用的是舞台局部坐标，
       起点取壳内左上（与 tidyOneSuperInner 的 16/16 同一口径），否则会飘到壳外很远。 */
    const inShell = !!(nodeParentSuperId(node) || nodeParentTaskId(node));
    const origin = inShell ? { x: snap(16), y: snap(16) } : originTop;
    const spot = freeSpotForNode(node, origin, nodePlacementObstacles(node));
    node.x = spot.x;
    node.y = spot.y;
  }
}

/** 就近空闲落点：从 origin 起按阶梯只往外搜索，第一个不重叠的位置就是答案 */
function freeSpotForNode(cand, origin, obstacles) {
  const g = typeof grid === "function" ? grid() : 16;
  const snapTo = (v) => (typeof snapDim === "function" ? snapDim(v, g) : Math.round(v));
  const pad = 28;
  const downs = [0, 96, 200, 320, 470, 650, 870, 1120, 1420, 1820];
  const rights = [0, 180, 380, 620, 900, 1240, 1640, 2140, 2760];
  const clean = (x, y) => {
    const probe = { x: x, y: y, w: cand.w, h: cand.h, kind: cand.kind };
    for (const o of obstacles || []) {
      const s = layoutNodeSize(o);
      if (
        rectsOverlap(
          { x: x, y: y, w: cand.w, h: cand.h },
          { x: o.x, y: o.y, w: s.w, h: s.h },
          pad,
        )
      )
        return false;
    }
    return true;
  };
  for (const dx of rights) {
    for (const dy of downs) {
      const x = snapTo(origin.x + dx);
      const y = snapTo(origin.y + dy);
      if (clean(x, y)) return { x: x, y: y };
    }
  }
  /* 全阶梯都不行（极端密）：落到最右下方，仍不碰任何节点 */
  let farX = origin.x;
  let farY = origin.y;
  for (const o of obstacles || []) {
    const s = layoutNodeSize(o);
    farX = Math.max(farX, o.x + s.w + 96);
    farY = Math.max(farY, o.y + s.h + 96);
  }
  return { x: snapTo(farX), y: snapTo(farY) };
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
  if (n.kind === "delayer" || n.kind === "popup" || n.kind === "sequencer") return 4.2;
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
  /* 组块代理：尺寸就是组外框（已含 pad 与标题标签带），不再按节点口径量 */
  if (n && n.__layoutBlockSize)
    return {
      w: Math.max(40, Number(n.__layoutBlockSize.w) || 0),
      h: Math.max(40, Number(n.__layoutBlockSize.h) || 0),
    };
  const sz = nodeDrawSize(n);
  /* 尺寸一律吸网格（就近取整）：间距要精确 = 1 格，尺寸就必须是网格倍数，
     否则「1 格」不可能同时对所有相邻对成立（见 layoutGap / 2026-02 需求）。 */
  const s = layoutSnapSize(sz.w || 240, sz.h || 160);
  return { w: s.w, h: s.h };
}
/** 节点自身 w/h 吸到网格倍数（展开的壳层吸 expandW/H，折叠尺寸 w/h 原样留着）。
 *  排版入口在开工前调用一次：可见尺寸随后就是网格倍数，与 layoutNodeSize 完全一致。 */
function snapNodeSizesForLayout(nodes) {
  for (const n of nodes || []) {
    if (!n) continue;
    const sz = nodeDrawSize(n);
    const s = layoutSnapSize(sz.w || 240, sz.h || 160);
    if (
      n.kind === "super" &&
      (typeof superIsOpenShell !== "function" || superIsOpenShell(n))
    ) {
      n.expandW = s.w;
      n.expandH = s.h;
      continue;
    }
    n.w = s.w;
    n.h = s.h;
  }
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

/* ============ 自动排版引擎（2026-02 起：1 格间距口径） ============
   目标（与需求一一对应，调用方 = agent 自动编辑 / 一键排版 / 局部排版 / 壳内排版）：
     ① **节点之间互不重叠**（硬约束，收尾还有一道兜底）；
     ② **相邻距离恰好 = 1 个网格**（硬约束）：同一列里上下相邻 = 1 格，
        同一行里左右相邻 = 1 格，折行后行与行之间 = 1 格，互不相连的块之间 = 1 格；
     ③ 连线节点就近（层内重心排序 + 跨层纵向对齐），上游在左或上；
     ④ 折行保留，但只作「形状偏好」——一行排到多宽换行由 4:3 与宽度上限定，
        折行**不会**再放宽缝宽（缝宽只有 1 格这一种）；宽高比不再是硬约束。

   管线：分层（layoutEdgeSets + assignLayoutLayers + orderLayersByBarycenter）
        → 列打包（层 = 列，超长列拆并排子列，孤立节点各成一列）
        → 逐行放置（列宽/行高按该行最高最宽节点，缝宽一律 layoutGap()）
        → 组件装箱（互不相连的块也间隔 1 格）
        → 收尾（平移避障 + 兜底：缝 ≥ 1 格且对齐网格）。

   注：用户自己的手动编辑不触发排版（2026-02 需求）——本引擎只在排版按钮与
   agent 显式 layout:true 的编辑里跑；触发闸见 canvasEditWantsLayout。 */

/** 长宽比参考值：只用于「一行最多排多宽」的上限反推，**不再**是硬约束。
 *  2026-02 需求：相邻间距必须精确 = 1 个网格、节点互不重叠 ——
 *  包围盒比例是这两条硬约束的结果，不再反过来去压缩间距或缩节点。 */
const LAYOUT_RATIO_R = 16 / 9;
/** 折行的「形状目标」：一行排到多宽就该换行（4:3，比 16:9 更接近正方） */
const LAYOUT_ASPECT_TARGET = 4 / 3;
/** 一行/一整块的宽度上限（px）：折行阈值 = min(这个值, 高 × 4/3)。
 *  取现有装箱上限，保证「节点间不重叠 + 精确 1 格」下也有个明确的换行点。 */
const LAYOUT_FLOW_MAX_W = 4400;
/** 单列超过这个高度就拆成并排子列（否则一列长成一根竖塔） */
const LAYOUT_MAX_STACK_H = 2600;
/** 节点尺寸下限（比这更小时不再往下吸网格，避免把节点压没） */
const LAYOUT_MIN_W = 160;
const LAYOUT_MIN_H = 120;
/** 局部搜索的时间预算（常量保留：旧函数族已撤，仅作回归对照） */
const LAYOUT_REFINE_MS = 60;

/* ── 间距口径（2026-02 需求）：相邻距离 = 恰好 1 个网格 ─────────────────
   网格 = 设置里的画布网格间距（app.js 的 grid()，缺省 24，可改 4~64）。
   引擎里所有间距都只认这一个值：调用方历史上传的 gapX/gapY 微调（80/48、
   196/92、96/56…）一律不再影响缝宽，只保留 preferAnchor 这类行为开关。 */
function layoutGap() {
  return grid();
}
/** 节点尺寸的网格倍数规则：**就近**取整（250→240、154→168），
 *  低于渲染下限时抬到「不小于下限的最近网格点」——与 app.js 的 snapDim 同口径 */
function layoutSnapSized(v, minV) {
  const g = grid();
  const min = Math.max(0, Number(minV) || 0);
  const s = Math.round(Number(v) / g) * g;
  return s < min ? Math.ceil(min / g) * g : s;
}
function layoutSnapSize(w, h) {
  const g = grid();
  /* 下限随网格缩放：格子越大，节点越小会显得太碎（缺省 24px 时 = 160×120） */
  return {
    w: Math.max(40, layoutSnapSized(w, Math.max(160, g * 4))),
    h: Math.max(40, layoutSnapSized(h, Math.max(120, g * 3))),
  };
}
/** 长宽比校验：旧需求（包围盒必须收进 16:9~9:16）已在 2026-02 撤销 ——
 *  保留函数是为了让「比例不再是硬约束」这件事在代码里可检索，恒回 true。 */
function layoutRatioOk(w, h) {
  return w > 0 && h > 0;
}
/** 节点尺寸缩放族（旧需求：为凑 16:9 缩 >480px 的大节点）已撤：现在尺寸只吸网格，不缩放。 */
const LAYOUT_SHRINK_MIN = 480;
function layoutNodeShrinkable(n) {
  const sz = layoutNodeSize(n);
  return Math.max(sz.w, sz.h) > LAYOUT_SHRINK_MIN;
}
/** 层内纵向放置顺序：邻居中心均值（入边权重 2 / 出边权重 1）→ 越靠上的排越前 */
function layoutVerticalKey(n, inEdges, allIn, allOut, centerOf) {
  let sum = 0,
    wsum = 0;
  const acc = (id, w) => {
    const c = centerOf(id);
    if (c == null) return;
    sum += c * w;
    wsum += w;
  };
  for (const id of allIn[n.id] || []) acc(id, 2);
  for (const id of allOut[n.id] || []) acc(id, 1);
  return wsum ? sum / wsum : null;
}
function layoutSortColumn(col, inEdges, allIn, allOut, centerOf) {
  const keyed = col.map((n, i) => ({
    n,
    i,
    k: layoutVerticalKey(n, inEdges, allIn, allOut, centerOf),
  }));
  keyed.sort((a, b) => {
    if (a.k != null && b.k != null && Math.abs(a.k - b.k) > 1) return a.k - b.k;
    /* 无邻居 / 邻居位置相同的并列项：用户可编辑 / 控制的节点靠上（沿用旧口径） */
    const pr = layoutNodePriority(a.n) - layoutNodePriority(b.n);
    if (pr) return pr;
    return a.i - b.i;
  });
  return keyed.map((x) => x.n);
}
function layoutColumnWidth(col) {
  return Math.max(40, ...(col || []).map((n) => layoutNodeSize(n).w));
}
/** 一列的总高 = 各节点高之和 + 「恰好 1 格」× 间隔数（列内上下相邻就只有 1 格） */
function layoutColumnHeight(col) {
  if (!col || !col.length) return 0;
  const g = layoutGap();
  return col.reduce((s, n) => s + layoutNodeSize(n).h, 0) + g * (col.length - 1);
}
/** 一行的宽度上限（折行阈值 = 形状偏好，**不影响缝宽**）：
 *   · 给了 totalArea 时取 √(面积) —— 「排成正方形该有多宽」，让整块尽量接近方形；
 *   · 没给（单个连通块内部）就取宽度上限 LAYOUT_FLOW_MAX_W ——
 *     ⚠ 绝不能按几百像素的小阈值折行，否则一条链会被折成竖塔，破坏「上游在左或在上」；
 *   · 单块比它宽时不折（每行至少放得下一块 → 不会死循环）。 */
function layoutRowMaxW(blockW, area) {
  const bw = Math.max(0, Number(blockW) || 0);
  const a = Math.max(0, Number(area) || 0);
  const square = a > 0 ? Math.sqrt(a) : LAYOUT_FLOW_MAX_W;
  return Math.max(bw, Math.min(LAYOUT_FLOW_MAX_W, Math.max(720, square)));
}
/** 把一层的节点切成一列或多列（并排子列）：太长的一层竖着摆会成一根竖塔。
 *  子列只影响视觉排布，不改「上游在左或在上」（同层节点之间本来就没有硬边）。 */
function layoutSplitColumn(col, maxH) {
  const g = layoutGap();
  const h = layoutColumnHeight(col);
  const limit = Math.max(g * 3, maxH || LAYOUT_MAX_STACK_H);
  if (!col.length || h <= limit) return [col.slice()];
  const need = Math.max(2, Math.ceil(h / limit));
  const per = Math.max(1, Math.ceil(col.length / need));
  const out = [];
  for (let i = 0; i < col.length; i += per) out.push(col.slice(i, i + per));
  return out;
}
/** 分层结果 → 列列表：每层一列（过长拆并排子列），孤立节点各成一列 */
function layoutBuildColumns(nodes, wires) {
  const { inEdges, outEdges, allIn, allOut } = layoutEdgeSets(nodes, wires);
  const cols = assignLayoutLayers(nodes, inEdges, outEdges);
  orderLayersByBarycenter(cols, allIn, allOut);
  const base = [];
  cols.forEach((col) => {
    if (col && col.length) base.push(col);
  });
  const maxColH0 = Math.max(
    layoutGap() * 3,
    ...base.map((col) => layoutColumnHeight(col)),
  );
  const splitH = Math.max(900, Math.min(LAYOUT_MAX_STACK_H, maxColH0));
  const columns = [];
  for (const col of base) for (const part of layoutSplitColumn(col, splitH)) columns.push(part);
  /* 孤立（无连线）节点：各成一列，跟连通部分一样遵守 1 格间距，不另开一套落点逻辑 */
  const touched = new Set();
  for (const col of columns) for (const n of col) touched.add(n.id);
  for (const n of nodes) if (!touched.has(n.id)) columns.push([n]);
  return { columns, inEdges, outEdges, allIn, allOut };
}
/** 行内「整列对齐邻居中心」的竖直微调（只动留白，不动缝宽）：
 *  每一列在自己的可用区间里整体平移，让列内节点中心尽量贴近左右邻居的中心均值 ——
 *  连线更接近水平、穿过无关方块的机率更低（实测稠密关系图上明显）。
 *  区间 = [行顶, 行底 − 该列高]：区间内平移**不会**改变任何缝宽（列内缝恒 1 格，
 *  列与列之间的水平缝也不受影响），所以「相邻恰好 1 格」照旧成立。
 *  两趟（先按左邻、再按右邻）足够，确定性、无随机。 */
function layoutAlignColumnsInRows(groups, rowY, rowH, inEdges, allIn, allOut, g) {
  if (!groups || groups.length < 2) return;
  const centerOf = (id) => {
    for (const gr of groups) {
      for (const it of gr.local) {
        if (it.n.id === id) return { x: gr.x, y: rowY + it.y + it.h / 2 };
      }
    }
    return null;
  };
  const slackOf = (gr) => {
    const colH = gr.local.reduce((s, it, i) => s + it.h + (i ? g : 0), 0);
    return Math.max(0, rowH - colH);
  };
  for (const pass of [0, 1]) {
    const order = pass === 0 ? groups.slice() : groups.slice().reverse();
    for (const gr of order) {
      const slack = slackOf(gr);
      if (slack <= 0) continue;
      let sum = 0;
      let k = 0;
      for (const it of gr.local) {
        const acc = (id, w) => {
          const c = centerOf(id);
          if (!c) return;
          sum += c.y * w;
          k += w;
        };
        for (const id of (inEdges && inEdges[it.n.id]) || []) acc(id, pass === 0 ? 2 : 1);
        for (const id of (allOut && allOut[it.n.id]) || []) acc(id, pass === 0 ? 1 : 2);
      }
      if (!k) continue;
      const wantTop = sum / k - (gr.local.reduce((s, it, i) => s + it.h + (i ? g : 0), 0)) / 2 - rowY;
      const clamped = Math.max(0, Math.min(slack, wantTop));
      const aligned = Math.round(clamped / g) * g;
      const delta = aligned - gr.local[0].y;
      if (!delta) continue;
      for (const it of gr.local) it.y += delta;
    }
  }
}
/** 层 / 列放置（2026-02 口径）：列顺序 = 层顺序（上游在左或在上），
 *  逐行从左到右排；**任何相邻缝都恰好 = 1 个网格**：
 *   · 列与列之间：下一列的 x = 上一列最右 + 1 格；
 *   · 列内上下：下一个节点的 y = 上一个的底 + 1 格；
 *   · 行与行之间：下一行 = 该行最高列的底 + 1 格。
 *  行高按该行最高节点算；列内竖直留白只用于「整列对齐邻居」（见
 *  layoutAlignColumnsInRows），不改任何缝宽；孤立节点也是列，同样吃这套规则。
 *  opts 里的 gapX / gapY 等历史微调一律**不再影响缝宽**（只有 1 格这一种缝）。 */
function layoutPlaceLayer(nodes, wires, origin, opts) {
  opts = opts || {};
  const o = origin || { x: 0, y: 0 };
  const { columns, inEdges, allIn, allOut } = layoutBuildColumns(nodes, wires);
  if (!columns.length) return nodesBBox(nodes);
  const g = layoutGap();
  /* 先量尺寸再排位：列宽 = 该列最宽节点，列高 = 该列总高（缝已按 1 格算进） */
  const measured = columns.map((col) => ({
    col,
    w: layoutColumnWidth(col),
    h: layoutColumnHeight(col),
  }));
  let rowY = o.y;
  let i = 0;
  while (i < measured.length) {
    const rowCap = layoutRowMaxW(0, 0);
    const slice = [];
    let wSum = 0;
    while (i < measured.length) {
      const c = measured[i];
      const add = c.w + (slice.length ? g : 0);
      if (slice.length && wSum + add > rowCap) break;
      slice.push(c);
      wSum += add;
      i++;
      if (!c.col.length) break;
    }
    if (!slice.length) {
      slice.push(measured[i]);
      i++;
    }
    const rowH = Math.max(40, ...slice.map((c) => c.h));
    /* 列内纵序：邻居中心均值定序（无邻居位置可参时「可编辑 / 控制节点靠上」） */
    const centerOf = (id) => {
      /* 组块代理不在 nodeById 里：查排版期间的代理表（见 layoutPackGroupBlocks） */
      const n = nodeById(id) || LAYOUT_PROXY_MAP.get(id) || null;
      if (!n || n.x == null) return null;
      return n.y + layoutNodeSize(n).h / 2;
    };
    /* 先把这一行的每列算好局部坐标（以 rowY 为顶、缝恰好 1 格），再统一做「对齐邻居」
       的竖直微调：整列平移 —— 只动留白，缝宽一分不变（见 layoutAlignColumnsInRows）。 */
    const groups = [];
    let cx = o.x;
    for (const c of slice) {
      const sorted = layoutSortColumn(c.col, inEdges, allIn, allOut, centerOf);
      const colX = snap(cx);
      const local = [];
      let cy = 0;
      for (const n of sorted) {
        const sz = layoutNodeSize(n);
        local.push({ n: n, y: cy, h: sz.h });
        cy += sz.h + g;
      }
      groups.push({ local: local, w: layoutColumnWidth(sorted), x: colX });
      cx = colX + layoutColumnWidth(sorted) + g;
    }
    layoutAlignColumnsInRows(groups, rowY, rowH, inEdges, allIn, allOut, g);
    for (const gr of groups) {
      for (const it of gr.local) {
        it.n.x = gr.x;
        it.n.y = snap(rowY + it.y);
      }
    }
    rowY += rowH + g;
  }
  return nodesBBox(nodes);
}

/* ============ 组块：成组之后间距以「组外框」计量（2026-02 需求） ============
   背景：引擎原先只按节点尺寸留 1 格缝，而组外框 = 成员包围盒 ± GROUP_PAD（app.js）
   + 2px 边框，于是两组节点虽隔 1 格，外框反而重叠（1 格 24px < 两侧各 18px）。

   口径（本轮共识）：
     · 一个组在排版里是**一个不可拆的块**，块的外缘 = 组外框（含组内绘制标注），
       块与块之间、块与无组节点之间的缝恒为 1 格 —— 计量对象换成了外框边缘；
     · 组标题标签在框外上方，块在框上方多留 LAYOUT_GROUP_LABEL_H，行与行之间
       不会让下一组的标签压住上一组的外框；
     · 组内成员的相对位置**原样保留**（整块刚性平移），组内连线不参与组间排序；
     · 组间连线照旧参与分层（上游组在左或上），所以连线方向不变。
   实现：排版前把「组」替换成代理元素（尺寸 = 外框），排完按代理位置把成员平移
   回去 —— 分层 / 列打包 / 装箱 / 兜底全都复用同一套代码，不另开一条排版路径。 */
const LAYOUT_GROUP_PAD = 16; /* 与 app.js 的 GROUP_PAD 同值：组框在成员外圈各让 16px */
const LAYOUT_GROUP_LABEL_H = 20; /* 组标题标签在框外上方占的高度（top:-11px + 行高 16 + 边框） */
/* 排版期间的组块代理表（id → 代理）：layoutPlaceLayer 的 centerOf 要拿中心线做对齐 */
const LAYOUT_PROXY_MAP = new Map();

/** 本次参与排版的节点按「组」打包成块。
 *  返回 { items, wires, blocks, byNode }：
 *   items = 参与排版的元素（无组节点原样，有组节点换成组块代理，同组只出现一次）；
 *   wires = 重写过的连线（组内连线被吃掉，组间连线记在代理之间）；
 *   blocks = [{ proxy, group, members:[{n,dx,dy}], frame }]。 */
function layoutPackGroupBlocks(nodes, wires) {
  const list = (nodes || []).filter(Boolean);
  const groups =
    typeof S !== "undefined" && S.wf && Array.isArray(S.wf.groups) ? S.wf.groups : [];
  const blocks = [];
  const byNode = new Map();
  if (!groups.length || !list.length)
    return { items: list, wires: wires || [], blocks: blocks, byNode: byNode };
  const inSet = new Set(list.map((n) => n.id));
  for (const g of groups) {
    if (!g) continue;
    if (typeof ensureGroupArrays === "function") ensureGroupArrays(g);
    if (typeof groupVisibleInScope === "function" && !groupVisibleInScope(g)) continue;
    const ids = (g.nodeIds || []).slice();
    /* 组内成员必须**整组**都在本次排版范围里：有半截在界外时按普通节点排，
       否则会把一个组拆到两处（外框立刻重叠 —— 正是本修正要避免的）。 */
    if (!ids.length || !ids.every((id) => inSet.has(id))) continue;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const members = [];
    for (const id of ids) {
      const n = list.find((x) => x.id === id);
      if (!n) continue;
      const sz = layoutNodeSize(n);
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + sz.w);
      maxY = Math.max(maxY, n.y + sz.h);
      members.push({ n: n, dx: 0, dy: 0 });
    }
    /* 组内绘制标注也计入外框（与 app.js 的 groupBounds 同口径），
       否则带标注的组会算出偏小的块，标注还是会被邻组压住。 */
    for (const mid of g.markIds || []) {
      const m = typeof markById === "function" ? markById(mid) : null;
      if (!m) continue;
      if (typeof markInCurrentScope === "function" && !markInCurrentScope(m)) continue;
      const b = typeof markBounds === "function" ? markBounds(m) : null;
      if (!b) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (!members.length || !isFinite(minX)) continue;
    const frame = {
      x: minX - LAYOUT_GROUP_PAD,
      y: minY - LAYOUT_GROUP_PAD - LAYOUT_GROUP_LABEL_H,
      w: Math.max(40, maxX - minX + LAYOUT_GROUP_PAD * 2),
      h: Math.max(40, maxY - minY + LAYOUT_GROUP_PAD * 2 + LAYOUT_GROUP_LABEL_H),
    };
    const proxy = {
      id: "__group__" + g.id,
      kind: "__group__",
      title: g.title || "",
      x: frame.x,
      y: frame.y,
      __layoutBlockSize: { w: frame.w, h: frame.h },
    };
    const block = { proxy: proxy, group: g, members: members, frame: frame };
    proxy.__block = block;
    blocks.push(block);
    for (const m of members) {
      /* 成员相对「成员包围盒左上角」的偏移：整块平移后原样加回去 */
      m.dx = m.n.x - minX;
      m.dy = m.n.y - minY;
      byNode.set(m.n.id, block);
    }
  }
  if (!blocks.length)
    return { items: list, wires: wires || [], blocks: blocks, byNode: byNode };
  const seen = new Set();
  const items = [];
  for (const n of list) {
    const it = byNode.has(n.id) ? byNode.get(n.id).proxy : n;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
  }
  const mapId = (id) => (byNode.has(id) ? byNode.get(id).proxy.id : id);
  const wlist = [];
  for (const w of wires || []) {
    if (!w) continue;
    const from = mapId(w.from);
    const to = mapId(w.to);
    if (from === to) continue; /* 组内连线：组是一个块，组内不重排 */
    wlist.push(Object.assign({}, w, { from: from, to: to }));
  }
  return { items: items, wires: wlist, blocks: blocks, byNode: byNode };
}

/** 排完之后把组块代理的落点写回成员：整块刚性平移，成员相对位置一分不改。
 *  块左上角 = 成员包围盒左上角 − pad（水平）/ − pad − 标签高（垂直），
 *  所以成员的新坐标 = 块左上角 + 同样的偏移量。 */
function layoutUnpackGroupBlocks(blocks) {
  for (const b of blocks || []) {
    const mx = b.proxy.x + LAYOUT_GROUP_PAD;
    const my = b.proxy.y + LAYOUT_GROUP_PAD + LAYOUT_GROUP_LABEL_H;
    for (const m of b.members) {
      m.n.x = mx + m.dx;
      m.n.y = my + m.dy;
    }
  }
}

/* 两条「节点中心连线」是否交叉 —— 交叉度量用（不做精确几何，够用且便宜） */
function layoutSegCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d = (ax - bx) * (cy - dy) - (ay - by) * (cx - dx);
  if (!d) return false;
  const t = ((ax - cx) * (cy - dy) - (ay - cy) * (cx - dx)) / d;
  const u = ((ax - cx) * (ay - by) - (ay - cy) * (ax - bx)) / d;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}
function layoutCrossPairs(items) {
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i],
        b = items[j];
      if (a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) continue;
      if (layoutSegCross(a.fx, a.fy, a.tx, a.ty, b.fx, b.fy, b.tx, b.ty)) n++;
    }
  }
  return n;
}
/** 点到线段距离（排版代价用，够精确且便宜） */
function layoutPointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (!L2) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
const LAYOUT_DIR_PEN = 0.6;
/** 目标函数 ②+③：交叉 / 上游方向 / 就近（连线长度）/ 连线穿块 / 锚点位移。
 *  长宽比不进目标函数 —— 它是「最后收敛」的约束（间距 + 缩大节点）；
 *  若当成代价项，优化器会靠「把所有节点塞进一列」把比值打正，图会彻底散架。 */
function layoutCostOf(nodes, pairs, anchors) {
  const map = new Map();
  for (const n of nodes) map.set(n.id, n);
  const items = [];
  let len = 0;
  let dir = 0;
  for (const p of pairs) {
    const a = map.get(p.from);
    const b = map.get(p.to);
    if (!a || !b) continue;
    const sa = layoutNodeSize(a);
    const sb = layoutNodeSize(b);
    const ax = a.x + sa.w / 2,
      ay = a.y + sa.h / 2,
      bx = b.x + sb.w / 2,
      by = b.y + sb.h / 2;
    items.push({ from: p.from, to: p.to, fx: ax, fy: ay, tx: bx, ty: by });
    len += Math.sqrt(Math.abs(bx - ax) * Math.abs(bx - ax) + Math.abs(by - ay) * Math.abs(by - ay));
    /* 规则 2：上游必须在左边或上边（允许 ±40px 容差，不强求严格列对齐） */
    if (ax > bx + 40 && ay > by + 40) dir++;
  }
  /* 连线穿块：直线从无关方块身上跨过去 —— 真实画布可辨性的主指标 */
  let pen = 0;
  for (const it of items) {
    for (const n of nodes) {
      if (n.id === it.from || n.id === it.to) continue;
      const sz = layoutNodeSize(n);
      const cx = n.x + sz.w / 2;
      const cy = n.y + sz.h / 2;
      if (layoutPointSegDist(cx, cy, it.fx, it.fy, it.tx, it.ty) < Math.min(sz.w, sz.h) / 2) pen++;
    }
  }
  const bb = nodesBBox(nodes);
  const spread = bb ? Math.max(1, bb.maxX - bb.minX + (bb.maxY - bb.minY)) : 1;
  let anchor = 0;
  if (anchors) {
    for (const n of nodes) {
      const a = anchors.get(n.id);
      if (!a) continue;
      anchor += Math.abs(n.x - a.x) + Math.abs(n.y - a.y);
    }
  }
  const cnt = Math.max(1, items.length);
  const cntAll = Math.max(1, nodes.length);
  const span = Math.max(1, spread);
  return (
    layoutCrossPairs(items) * 10 +
    dir * 6 * cntAll +
    pen * 2 * cnt +
    (len / cnt / span) * 6 +
    (anchor / cntAll / (span * 0.02)) * 6
  );
}
/** 自动排版主入口（所有入口共用这一套引擎）。
 *  返回 { ok, nodes, ratioOk, w, h, scaled, gap } —— 调用方据此提示 / 记警告。
 *  需求（2026-02）：① 节点互不重叠；② 相邻距离恰好 1 个网格；③ 上游在左或上、
 *  连线就近；④ 折行保留（4:3 形状偏好），宽高比不再是硬约束。 */

/** 单个连通分量内部排版（2026-02 口径）：分层 → 列打包 → 逐行 1 格放置。
 *  列宽/行高按该行「最宽 / 最高」的节点算，缝宽一律 = 1 个网格；
 *  opts 里的 gapX / gapY 等历史微调不再影响缝宽（只有 1 格这一种缝）。 */
function layoutFlowComponent(nodes, wires, origin) {
  if (!nodes.length) return { w: 0, h: 0 };
  layoutPlaceLayer(nodes, wires, origin, {});
  const bb = nodesBBox(nodes);
  if (!bb) return { w: 0, h: 0, ratioOk: true, scaled: 1, gap: layoutGap() };
  const outW = bb.maxX - bb.minX;
  const outH = bb.maxY - bb.minY;
  return {
    w: outW,
    h: outH,
    minX: bb.minX,
    minY: bb.minY,
    ratioOk: layoutRatioOk(outW, outH),
    scaled: 1,
    gap: layoutGap(),
  };
}

function layoutFlow(nodes, wires, origin, obstacles, opts) {
  /* 间距不再由调用方钉：缝宽恒为 1 格（见 layoutGap） */
  layoutFlowEx(nodes, wires, origin, obstacles, opts || {});
}

/* 关系线主导的图（开发节点架构图）：间距口径与数据图**完全一致**（恒 1 格）。
   这两个常量只作历史留档 —— 缝宽已由 layoutGap() 唯一决定。 */
const LAYOUT_REL_GAP_X = 164;
const LAYOUT_REL_GAP_Y = 72;
function relWiresIn(wires) {
  for (const w of wires || []) if (w && w.rel) return true;
  return false;
}

/** 自动排版主入口（所有入口共用这一套引擎）。
 *  返回 { ok, nodes, ratioOk, w, h, scaled, gap } —— 调用方据此提示 / 记警告。
 *  需求（2026-02）：① 节点互不重叠；② 相邻距离恰好 1 个网格；
 *  ③ 上游在左或上、连线就近、少交叉；④ 折行保留（4:3 形状偏好），宽高比不再是硬约束。 */
function layoutFlowEx(nodes, wires, origin, obstacles, opts) {
  if (!nodes || !nodes.length) return { ok: false, nodes: 0, ratioOk: true };
  origin = origin || { x: snap(48), y: snap(48) };
  opts = opts || {};
  /* 间距只有一种：1 个网格。调用方历史上传的 gapX / gapY / compGapX / compGapY
     一律不再参与计算（否则「精确 1 格」立刻破功）——只保留 preferAnchor 行为开关。 */
  const g = layoutGap();
  snapNodeSizesForLayout(nodes);
  /* 组块：成组之后间距按组外框计量（见 layoutPackGroupBlocks）——
     一个组在排版里是一个不可拆的块，块与块 / 块与无组节点之间仍恒 1 格。 */
  const packing = layoutPackGroupBlocks(nodes, wires);
  const items = packing.items;
  const itemWires = packing.wires;
  LAYOUT_PROXY_MAP.clear();
  for (const b of packing.blocks) LAYOUT_PROXY_MAP.set(b.proxy.id, b.proxy);
  const components = findLayoutComponents(items, itemWires);
  components.sort((a, b) => b.nodes.length - a.nodes.length);

  /* agent 显式给的坐标当起始锚点（AI 排版路径：整体尽量少位移） */
  const anchorOf = new Map();
  if (opts.preferAnchor) for (const n of items) anchorOf.set(n.id, { x: n.x, y: n.y });

  /* 组件内部先在 0/0 起算，再整块平移到装箱位 —— 两组之间的缝也是 1 格 */
  const laid = [];
  for (const comp of components) {
    layoutFlowComponent(comp.nodes, comp.wires, { x: 0, y: 0 });
    const bb0 = nodesBBox(comp.nodes);
    if (!bb0) continue;
    const w = bb0.maxX - bb0.minX;
    const h = bb0.maxY - bb0.minY;
    laid.push({ comp: comp, bb: bb0, w: w, h: h, area: Math.max(1, w) * Math.max(1, h) });
  }
  /* 折行阈值：按「整块内容面积开平方」定 —— 排成正方形时该有多宽（形状偏好，不动缝宽） */
  const totalArea = laid.reduce((s, it) => s + it.area, 0);
  const widestBlock = laid.reduce((m, it) => Math.max(m, it.w), 0);
  const rowCap = layoutRowMaxW(widestBlock, totalArea);
  const rowMaxH = (row) => Math.max(40, ...row.map((it) => it.h));
  let cursorX = snap(origin.x);
  let cursorY = snap(origin.y);
  let slice = [];
  let sliceW = 0;
  let sliceH = 0;
  const flushRow = () => {
    if (!slice.length) return;
    /* 逐块左对齐摆放：下一块的起点 = 上一块所有节点**吸附之后**的最右缘 + 1 格。
       不能拿「未吸附的包围盒宽度」累加 —— 那样相邻块的缝会小于 1 格（实测差 1 格）。 */
    const baseX = snap(cursorX);
    const baseY = snap(cursorY);
    let cx = baseX;
    for (const it of slice) {
      const dx = cx - it.bb.minX;
      const dy = baseY - it.bb.minY;
      let right = cx;
      for (const n of it.comp.nodes) {
        n.x = snap(n.x + dx);
        n.y = snap(n.y + dy);
        right = Math.max(right, n.x + layoutNodeSize(n).w);
      }
      cx = right + g;
    }
    cursorY = baseY + sliceH + g;
    cursorX = snap(origin.x);
    slice = [];
    sliceW = 0;
    sliceH = 0;
  };
  for (const item of laid) {
    const add = item.w + (slice.length ? g : 0);
    if (slice.length && sliceW + add > rowCap) flushRow();
    slice.push(item);
    sliceW += item.w + (slice.length > 1 ? g : 0);
    sliceH = rowMaxH(slice);
  }
  flushRow();

  /* ── 收尾 ①：避障 ─────────────────────────────────────────────────────
     障碍物（本次不参与排版的既有节点）只影响整块位移，块内相对位置不动，
     所以「缝恰好 1 格」在平移下保持成立。 */
  let sh = shiftToClear(items, obstacles || []);
  /* 锚点优先：用户 / agent 给过 x/y 时，整体位移取「更省位移」的那一侧 */
  if (opts.preferAnchor && anchorOf.size) {
    let sx = 0,
      sy = 0,
      k = 0;
    for (const n of items) {
      const a = anchorOf.get(n.id);
      if (!a) continue;
      sx += n.x - a.x;
      sy += n.y - a.y;
      k++;
    }
    if (k) {
      const bx = snap(-sx / k);
      const by = snap(-sy / k);
      if (Math.abs(bx) + Math.abs(by) < Math.abs(sh.x) + Math.abs(sh.y))
        sh = { x: bx, y: by };
    }
  }
  if (sh.x || sh.y) {
    for (const n of nodes) {
      n.x = snap(n.x + sh.x);
      n.y = snap(n.y + sh.y);
    }
  }

  /* ── 收尾 ②：兜底防重叠（缝 ≥ 1 格 + 坐标对齐网格，见 resolvePlacedOverlaps） */
  resolvePlacedOverlaps(items, obstacles || []);

  const bb = nodesBBox(items);
  /* 组块排完 → 成员按块落点整块平移回去；代理表随即作废 */
  layoutUnpackGroupBlocks(packing.blocks);
  LAYOUT_PROXY_MAP.clear();
  const outW = bb ? bb.maxX - bb.minX : 0;
  const outH = bb ? bb.maxY - bb.minY : 0;
  /* 宽高比不再是硬约束：如实回报实际形状，交给调用方决定要不要提示 */
  return {
    ok: true,
    nodes: nodes.length,
    w: outW,
    h: outH,
    ratioOk: layoutRatioOk(outW, outH),
    scaled: 1,
    gap: g,
    ratioBoxW: LAYOUT_FLOW_MAX_W,
    ratioBoxH: LAYOUT_FLOW_MAX_W / LAYOUT_ASPECT_TARGET,
  };
}

function nodesBBox(nodes) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes || []) {
    /* 用绘制尺寸：展开节点层按 expandW/H 参与包围盒，组件装箱才不会互相压住 */
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

/* 美观尺寸：图像节点便于观察；文本可读；控制保持默认。
   2026-02 需求：尺寸一律吸到网格倍数（就近取整）—— 间距要精确 1 格，
   尺寸就必须是网格倍数；因此这里所有赋值都过 layoutSnapSize，不再有裸像素值。 */
function sizeNodeForTidy(node) {
  const d = NODE_DEFAULTS[node.kind];
  if (!d) return;
  const kind = node.kind;
  const hasImg = nodeHasVisibleImage(node);
  const batchN =
    isBatch(node) && Array.isArray(node.entries) ? node.entries.length : 0;
  const set = (w, h) => {
    const s = layoutSnapSize(w, h);
    node.w = s.w;
    node.h = s.h;
  };

  if (kind === "control") {
    if (isExecStart(node) || isExecEnd(node)) {
      set(180, 96);
      return;
    }
    set(d.w, d.h);
    return;
  }
  if (kind === "task") {
    set(Math.max(d.w, 280), Math.max(d.h, 220));
    return;
  }
  if (kind === "judge") {
    set(Math.max(d.w, 240), Math.max(d.h, 160));
    return;
  }
  if (kind === "input_image" || kind === "proc_image") {
    if (hasImg) set(batchN > 1 ? 320 : 300, batchN > 1 ? 280 : 250);
    else set(d.w, d.h);
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
    set(Math.max(d.w, 300), Math.max(d.h, Math.min(620, 64 + rows)));
    return;
  }
  if (isSaveKind(kind) && saveMediaKind(node) === "image") {
    set(hasImg ? 280 : d.w, hasImg ? 230 : d.h);
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
    set(Math.min(320, Math.max(d.w, 220)), Math.min(280, Math.max(d.h, 40 + lines * 16)));
    return;
  }
  if (isSaveKind(kind) || kind === "split" || kind === "merge" || kind === "global" || kind === "wait_file" || kind === "timer" || kind === "delayer" || kind === "popup" || kind === "sequencer" || kind === "gate" || kind === "splitter" || kind === "counter" || kind === "mutex") {
    set(d.w, d.h);
    return;
  }
  sizeNodeForContent(node);
  set(Math.max(d.w, Math.min(node.w, 360)), Math.max(d.h, Math.min(node.h, 280)));
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
    let pad = layoutGap();
    let labelAbove = false;
    if (m.kind === "box" && nodeIds.length) {
      const ns = nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
      const nb = nodesBBox(ns);
      if (nb) {
        const left = Math.max(0, nb.minX - m.x);
        const top = Math.max(0, nb.minY - m.y);
        const right = Math.max(0, m.x + (m.w || 0) - nb.maxX);
        const bottom = Math.max(0, m.y + (m.h || 0) - nb.maxY);
        /* 需求：分区框 = 节点外圈各让 1 格 —— 原框的留白也吸附到网格倍数，最少 1 格 */
        const avg = (left + top + right + bottom) / 4;
        pad = Math.max(layoutGap(), layoutSnapSized(avg, layoutGap()));
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
      /* 需求：分区框 = 节点外圈恰好 1 格（尺寸按网格倍数重算） */
      const pad = b.pad != null ? b.pad : layoutGap();
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
        m.y = snap(nb.minY - (m.h || layoutGap()) - layoutGap());
      } else if (b.anchorOff) {
        m.x = snap(ns[0].x + b.anchorOff.dx);
        m.y = snap(ns[0].y + b.anchorOff.dy);
      } else {
        m.x = snap(nb.minX);
        m.y = snap(nb.minY - (m.h || layoutGap()) - layoutGap());
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
 * - opts.includeSuperInner：同时排版各节点层内部（各自独立局部坐标）
 */
function tidyLayoutWorkflow(opts) {
  opts = opts || {};
  if (!S.wf) {
    if (opts.notify !== false) toast(I18n.t("当前没有打开的画布"), "warn");
    return { ok: false, error: I18n.t("当前没有打开的画布") };
  }
  /* 默认层级 = 用户当前所在层级：停在某颗节点层里就整理这颗壳内部（本层），
     不再越级去排整张画布；只有显式 scope:"global" 才排整图（顶层 + 可选各壳内部）。 */
  const levelHost = opts.scope === "global" ? null : currentTidyLevelHost();
  if (levelHost) return tidyLayoutCurrentSuperLevel(levelHost, opts);
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
    /* 间距不再由调用方钉：缝宽恒为 1 个网格（见 layoutGap / 2026-02 需求） */
    layoutFlowEx(topNodes, topWires, { x: snap(64), y: snap(64) }, [], {
      prioritizeEditable: true,
    });

    /* 整体贴到画布左上，留出边距 */
    const neu = nodesBBox(topNodes);
    if (neu) {
      const dx0 = snap(64 - neu.minX);
      const dy0 = snap(64 - neu.minY);
      if (dx0 || dy0) {
        /* 整块刚性平移（dx0/dy0 已是网格倍数）：逐个再 snap 会把组内成员的相对位置
           改掉（组块成员相对组框恒偏 pad），组与组之间的外框缝就会被吃掉。 */
        for (const n of topNodes) {
          n.x += dx0;
          n.y += dy0;
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
        ? I18n.t("已整理排版（含节点层内部）")
        : I18n.t("已整理排版"),
      "ok",
    );
  }
  return {
    ok: true,
    scope: "global",
    nodes: topNodes.length,
    innerNodes: innerCount,
    marks: markBindings.length,
  };
}

/** 排版默认层级：停在某颗节点层里 → 这颗壳（本层）；否则根层级（null） */
function currentTidyLevelHost() {
  const sf =
    typeof currentSuperFocus === "function" ? currentSuperFocus() : S.superFocus || "";
  if (!sf) return null;
  const host = typeof nodeById === "function" ? nodeById(sf) : null;
  return host && host.kind === "super" ? host : null;
}

/** 整理「当前节点层」：只排这颗壳的直接子节点（局部坐标，壳随内容撑开），可撤销。
    顶层入口的默认行为就是这个 —— 用户停在壳里点「排版」时，排的是他正看着的这一层。 */
function tidyLayoutCurrentSuperLevel(host, opts) {
  opts = opts || {};
  const kids = superChildrenOf(host.id).filter((c) => !isSuperIoNode(c));
  if (!kids.length) {
    if (opts.notify !== false)
      toast(I18n.t("这颗节点层里还没有可排版的节点"), "warn");
    return {
      ok: false,
      scope: "super",
      superId: host.id,
      error: I18n.t("这颗节点层里还没有可排版的节点"),
    };
  }
  if (opts.history !== false && !S._skipCanvasHistory) pushHistory();
  const n = tidyOneSuperInner(host);
  if (S.view !== "workflow") setView("workflow");
  renderCanvas();
  fitNodes(kids);
  scheduleSave(true);
  if (opts.notify !== false)
    toast(I18n.t("已整理排版（当前节点层）"), "ok");
  return {
    ok: true,
    scope: "super",
    superId: host.id,
    superTitle: host.title || "",
    nodes: n,
    innerNodes: n,
  };
}

/** 单个节点层内部子图排版（关系线感知 + 壳层按内容撑开）；返回排版的孩子数 */
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
  /* 开发节点（架构图）内部：关系线主导，但间距口径与别处一致 —— 恒 1 格 */
  const isDev = kids.some((n) => n.dev);
  layoutFlowEx(kids, wires, { x: snap(16), y: snap(16) }, [], {
    prioritizeEditable: true,
  });
  const bb = nodesBBox(kids);
  if (bb) {
    const dx = snap(16 - bb.minX);
    const dy = snap(16 - bb.minY);
    if (dx || dy) {
      /* 刚性平移（不用逐个 snap）：组块成员的坐标相对组框恒偏 pad，
         逐个取整会改掉组内相对位置、也会吃掉组与组之间的外框缝。 */
      for (const n of kids) {
        n.x += dx;
        n.y += dy;
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

/** 对每个节点层内部子图独立排版，并重置内部平移到左上 */
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

/* 顶栏一键排版：默认整理「当前所在层级」——停在某颗节点层里就整理这一层（这颗壳内部），
   根层级则整理顶层节点；确认框里可改选「排版整个画布」（可撤销）。 */
async function oneClickAutoLayout(opts) {
  opts = opts || {};
  if (!S.wf || !(S.wf.nodes || []).length) {
    toast(I18n.t("画布上没有节点"), "warn");
    return;
  }
  const focus = currentTaskFocus();
  const levelHost = opts.scope === "global" ? null : currentTidyLevelHost();
  let scope = opts.scope === "global" ? "global" : "";
  let includeInner =
    opts.includeSuperInner == null ? false : !!opts.includeSuperInner;
  if (!opts.skipConfirm) {
    if (levelHost) {
      /* 停在壳里：默认排当前这一层，别越级去排整张画布 */
      const kids = superChildrenOf(levelHost.id).filter((c) => !isSuperIoNode(c));
      if (!kids.length) {
        toast(I18n.t("这颗节点层里还没有可排版的节点"), "warn");
        return;
      }
      if (
        !(await confirmDialog(
          I18n.t(
            "确定进行一键排版？\n\n将按连线与关系线整理当前节点层「{title}」内部的节点位置（可撤销）。",
            { title: levelHost.title || I18n.t("节点层") },
          ),
          { title: I18n.t("一键排版"), okText: I18n.t("开始排版") },
        ))
      )
        return;
      const whole = await confirmDialog(
        I18n.t(
          "排版范围：默认只整理当前这一层（这颗节点层内部）；也可改为排版整个画布（顶层节点，连各壳内部一起整理）。",
        ),
        {
          title: I18n.t("一键排版"),
          okText: I18n.t("排版整个画布"),
          cancelText: I18n.t("仅排版当前层级"),
        },
      );
      if (whole) {
        scope = "global";
        includeInner = true;
      }
    } else {
      if (
        !(await confirmDialog(
          I18n.t(
            "确定进行一键排版？\n\n将按连线与关系线整理节点位置（可撤销）。",
          ),
          { title: I18n.t("一键排版"), okText: I18n.t("开始排版") },
        ))
      )
        return;
      const hasInner = (S.wf.nodes || []).some(
        (n) =>
          n.kind === "super" &&
          nodeParentTaskId(n) === focus &&
          superChildrenOf(n.id).some((c) => !isSuperIoNode(c)),
      );
      if (hasInner && opts.includeSuperInner == null) {
        includeInner = await confirmDialog(
          I18n.t(
            "是否同时排版节点层内部？\n\n「同时排版内部」会整理各节点层内的子节点；「仅排版画布」只调整顶层节点。",
          ),
          {
            title: I18n.t("一键排版"),
            okText: I18n.t("同时排版内部"),
            cancelText: I18n.t("仅排版画布"),
          },
        );
      }
    }
  }
  tidyLayoutWorkflow({
    scope,
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

/* save 路径后缀预检：后缀的媒体类别与「输入类型定下来的类别」不符时，当场指出并按
   输入类型强制 —— 不再等服务商报错才发现把散文写进了 .wav。
   文本允许 .md / .yaml（.yaml 批量引擎仍在），其余按 .png / .wav / .mp4。 */
function saveMediaClassOfExt(p) {
  const e = extOf(String(p || ""));
  if (!e) return "";
  if (/^\.(md|markdown|ya?ml|txt)$/i.test(e)) return "text";
  if (/^\.pdf$/i.test(e)) return "pdf";
  if (/^\.(png|jpe?g|webp|bmp|gif)$/i.test(e)) return "image";
  if (/^\.(wav|flac|mp3)$/i.test(e)) return "audio";
  if (/^\.(mp4|webm|mov)$/i.test(e)) return "video";
  return "";
}
function savePathExtWarning(node, rawPath) {
  if (!node || !String(rawPath || "").trim()) return "";
  if (!saveMediaCertain(node)) return "";
  const media = saveMediaKind(node);
  const cls = saveMediaClassOfExt(rawPath);
  if (!cls || cls === media) return "";
  return (
    I18n.t("保存路径后缀与输入类型不符，已按输入类型强制") +
    "：" + rawPath + " → " + forcePathExt(rawPath, saveExtForMedia(media))
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
    (node.kind === "proc_text" ||
      node.kind === "proc_image")
  ) {
    node.prompt = String(patch.prompt);
    if (node.kind === "proc_image") warnIfProcImageMultiPrompt(node, warnings);
  }
  if (patch.task != null && node.kind === "agent_task")
    node.task = String(patch.task);
  /* 节点参数**只能从「参数」端子来**：canvas_edit 的 params 字段已取消（旧版在这里
     把一份参数挂成 node.npParams，运行时压住 ⚙ 里的值，用户就改不动自己的参数了）。
     写入口的闸在 applyCanvasEdit：带 params 的编辑整笔拒绝。 */
  if (patch.paramStrict !== undefined) node._npStrict = !!patch.paramStrict;
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
      /* 唯一入口：内部相对路径按「旧前缀 → 新前缀」重写（不叠成 {新}/{旧}/fn） */
      setSuperSubFolder(node, String(patch.subFolder));
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
      /* 开发块的思考档白名单 = low/high/xhigh/max（不含 off）：agent 链上思考不能关，
         「无」在这里一律当未知档丢弃并回报（与 devEffortKnown 同集合，
         app.js 的 AGENT_EFFORT_ORDER 也不含 off）。 */
      const known =
        v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max";
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
    const rawPath = preferRelativeSavePath(String(patch.savePath));
    /* 后缀预检在强制之前算：拿到的是用户 / 模型写的原始后缀，才能点名错在哪 */
    const extWarn = savePathExtWarning(node, rawPath);
    node.savePath = rawPath;
    applySavePathExt(node);
    if (extWarn && warnings) warnings.push(extWarn + "（" + (node.title || node.id) + "）");
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
  /* 「文本处理节点转智能节点」已移除：只允许把旧画布上的智能模式关掉，不接受开启 */
  if (patch.agent === false && node.kind === "proc_text") node.agent = false;
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
  if (typeof patch.bgRmOn === "boolean" && node.kind === "proc_image")
    node.bgRmOn = patch.bgRmOn;
  /* gpt-image-2 直传参数：非法值丢弃并告警，别把脏枚举发给接口 */
  if (patch.imgQuality != null && node.kind === "proc_image") {
    const q = String(patch.imgQuality).trim().toLowerCase();
    if (IMG_QUALITY_VALUES.includes(q)) node.imgQuality = q;
    else if (warnings)
      warnings.push(
        I18n.t("无效的 quality（须为 low/medium/high/xhigh/max/auto 或空）：") + q,
      );
  }
  if (patch.imgBackground != null && node.kind === "proc_image") {
    const b = String(patch.imgBackground).trim().toLowerCase();
    if (IMG_BACKGROUND_VALUES.includes(b)) {
      node.imgBackground = b;
      normalizeImgParams(node);
    } else if (warnings)
      warnings.push(
        I18n.t("无效的 background（须为 transparent/opaque/auto 或空）：") + b,
      );
  }
  if (typeof patch.maskOn === "boolean" && node.kind === "proc_image") {
    if (!patch.maskOn) node.maskOn = false;
    else if (node.maskPath) node.maskOn = true;
    else if (warnings)
      warnings.push(
        I18n.t("蒙版尚未创建：请先在节点头部打开蒙版编辑器涂抹要重绘的区域"),
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
    (node.kind === "video_gen" || node.kind === "music_gen" || node.kind === "yue_gen" || node.kind === "breeze_gen" || node.kind === "remotion" ||
      (typeof isVideoPostKind === "function" && isVideoPostKind(node)))
  ) {
    const n = Math.round(Number(patch.attempts));
    if (isFinite(n)) node.attempts = Math.max(1, Math.min(10, n || 1));
  }
  if (
    patch.outputPath != null &&
    (node.kind === "video_gen" || node.kind === "music_gen" || node.kind === "yue_gen" || node.kind === "breeze_gen" ||
      (typeof isVideoPostKind === "function" && isVideoPostKind(node)))
  ) {
    const p = String(patch.outputPath).trim();
    if (p) {
      applyMediaGenConfiguredPath(
        node,
        p,
        (node.kind === "music_gen" || node.kind === "yue_gen") ? "audio" : "video",
      );
    }
  }
  /* yue_gen：思维链档位 / 风格提示词 / 歌词 / ABC 谱（YuE2 音乐节点） */
  if (node.kind === "yue_gen") {
    if (patch.cot != null) {
      const v = String(patch.cot).trim();
      node.cot = v === "melody" || v === "off" ? v : "full";
    }
    if (patch.style != null) node.style = String(patch.style);
    if (patch.lyrics != null) node.lyrics = String(patch.lyrics);
    if (patch.abc != null) node.abc = String(patch.abc);
  }
  /* breeze_gen：音色 / 能力 / 指令 / cfg_scale / seed / 输出格式（Breeze TTS 2 语音节点） */
  if (node.kind === "breeze_gen") {
    /* 音色：breezeVoice 是正式字段名，voice 是历史别名（canvas_edit 参数表两个都收，
       breezeVoice 优先）。两个名字必须写同一个字段，否则「传了不生效」的坑会再回来。 */
    const bVoice = patch.breezeVoice != null ? patch.breezeVoice : patch.voice;
    if (bVoice != null) node.voice = String(bVoice).trim();
    if (patch.breezeMode != null) {
      const v = String(patch.breezeMode).trim();
      if (["auto", "clone", "design", "direction"].indexOf(v) >= 0) node.voiceMode = v;
    }
    if (patch.breezeInstruction != null) node.instruction = String(patch.breezeInstruction);
    if (patch.breezeCfgScale != null) {
      const v = Number(patch.breezeCfgScale);
      if (isFinite(v) && v > 0) node.cfgScale = Math.max(0.1, Math.min(10, v));
    }
    if (patch.breezeSeed != null) {
      const v = Math.floor(Number(patch.breezeSeed));
      if (isFinite(v)) node.seed = v;
    }
    const bfmt = String(patch.breezeFormat || "").toLowerCase();
    if (["wav", "flac", "mp3"].indexOf(bfmt) >= 0) {
      node.ttsFormat = bfmt;
      /* 格式变了 → 输出路径扩展名跟随，否则下次生成会被强改回去 */
      if (String(node.outputPath || "").trim())
        applyMediaGenConfiguredPath(node, node.outputPath, "audio");
    }
  }
  /* remotion：功能说明 / 构建描述 / 时长 / fps / 分辨率 / 服务商 / 模型 / 直出合成代码 /
     左侧底色 + 工程源码树 remotionFiles / 端子契约 remotionInputs（画布编辑接口的白名单内） */
  if (node.kind === "remotion") {
    /* text = 这个节点干什么（功能说明，构建与运行都不读它） */
    if (patch.text != null) node.text = String(patch.text);
    /* remotionBuildNote = 构建描述（点「构建」弹窗里填的那段需求；只有构建 Agent 读它） */
    if (patch.remotionBuildNote != null)
      node.remotionBuildNote = String(patch.remotionBuildNote);
    /* 直出合成代码：贴了就走这份（跳过模型）；传空串 = 回到「固化工程 / 内置版面」
    if (patch.tsx != null) node.tsxTsx = String(patch.tsx);
    if (patch.backgroundColor != null) node.bgColor = String(patch.backgroundColor).trim();
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
    /* 工程源码 / 契约放最后：契约要在源码派生之后落地，两者同时给时以显式契约为准 */
    if (patch.remotionFiles != null && patch.tsx != null && warnings)
      warnings.push(
        I18n.t("同时给了 tsx 与 remotionFiles，已按 remotionFiles（多文件工程）优先"),
      );
    applyRemotionSourcePatch(node, patch, warnings);
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

/* 解析配置里的 API 服务商：id 或唯一名称（按节点形态选服务商，
   形态判定统一走 app-model-kind.js：同一端点混挂两类模型也能选到） */
function resolveApiProviderRef(token, kind, warnings) {
  const s = String(token || "").trim();
  if (!s) return null;
  const list =
    typeof apiProvidersForKind === "function"
      ? apiProvidersForKind(kind)
      : (S.config.providers || []).filter((p) => {
          if (kind === "proc_image")
            return String(p.type || "").startsWith("image_");
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

/* ───── 服务商缺失 / 无法对应 → 自动替换（Agent 改节点 · 参数端子覆写 · 真跑节点 三处共用） ─────
   顺序：① 本机 id 命中 → 不动；② 名称唯一 → 换；③ 用节点 model 反查「哪个服务商提供它」，
   唯一才换；④ 都不中 → 保留原值 + 警告 + 该节点跳过运行。
   同一缺失值出现在多个节点上 = 一次批量全换：写回画布节点字段，批量前压一次撤销快照。 */
const PROVIDER_REF_KEYS = ["providerId", "provider", "devProvider"];

function providerRefMode(node) {
  if (!node) return "proc_text";
  if (node.kind === "agent_task" || node.agent) return "agent";
  return node.kind === "proc_image" ? "proc_image" : "proc_text";
}

function providerCandidates(kind) {
  return typeof apiProvidersForKind === "function"
    ? apiProvidersForKind(kind)
    : ((S.config && S.config.providers) || []);
}

function providerRouteOf(prov) {
  const dp = typeof dshProvider === "function" ? dshProvider() : null;
  return dp && prov.id === dp.id ? "deepseek-official" : "mtnode_" + prov.id;
}

/** 把一条服务商引用解析成本机可用值：{ value, how } / { value:null, why }（都对不上）。 */
function fixProviderRefValue(token, mode, model) {
  const s = String(token || "").trim();
  if (!s) return null;
  const agent = mode === "agent";
  const list = providerCandidates(agent ? "proc_text" : mode);
  /* ① 本机就有（id 命中；智能路由另认 mtnode_<id> 与 deepseek-official） */
  const byId = list.find(
    (p) => p.id === s || (agent && "mtnode_" + p.id === s),
  );
  if (byId) return { value: agent ? providerRouteOf(byId) : byId.id, how: "id" };
  if (agent && s === "deepseek-official") return { value: s, how: "id" };
  /* ② 名称唯一 */
  const byName = list.filter((p) => p.name === s);
  if (byName.length === 1)
    return { value: agent ? providerRouteOf(byName[0]) : byName[0].id, how: "name" };
  if (byName.length > 1)
    return { value: null, why: I18n.t("同名服务商不止一个") };
  /* ③ model 反查：这个模型归谁 */
  const m = String(model || "").trim();
  const byModel = m
    ? list.filter((p) => (Array.isArray(p.models) ? p.models : []).includes(m))
    : [];
  if (byModel.length === 1)
    return { value: agent ? providerRouteOf(byModel[0]) : byModel[0].id, how: "model" };
  if (byModel.length > 1)
    return { value: null, why: I18n.t("提供该模型的服务商不止一个") };
  return { value: null, why: I18n.t("本机没有这个服务商") };
}

/** 读节点自己的服务商引用（不含参数覆写）→ { key, token, mode } 或 null。 */
function nodeProviderRef(node) {
  if (!node) return null;
  for (const k of PROVIDER_REF_KEYS) {
    const s = String(node[k] || "").trim();
    if (s) return { key: k, token: s, mode: k === "providerId" ? providerRefMode(node) : "agent" };
  }
  return null;
}

/** 把画布上引用同一缺失值的所有节点一次换掉（一次撤销复原）。返回被替换的节点数。
    opts.exceptId：这次改的就是它（已经写好值了，不算「替换」也不该冒提示）。 */
function replaceProviderAcrossCanvas(token, value, how, opts) {
  const from = String(token || "").trim();
  const to = String(value || "").trim();
  if (!from || !to || from === to) return 0;
  const exceptId = opts && opts.exceptId;
  const nodes = ((S.wf && S.wf.nodes) || []).filter(
    (n) =>
      n &&
      (!exceptId || n.id !== exceptId) &&
      PROVIDER_REF_KEYS.some((k) => String(n[k] || "").trim() === from),
  );
  if (!nodes.length) return 0;
  if (typeof pushHistory === "function") {
    try {
      pushHistory();
    } catch (_) {
      /* 压栈失败不影响替换本身 */
    }
  }
  for (const n of nodes)
    for (const k of PROVIDER_REF_KEYS)
      if (String(n[k] || "").trim() === from) n[k] = to;
  if (typeof renderCanvas === "function") {
    try {
      renderCanvas();
    } catch (_) {
      /* 重绘失败不回滚替换 */
    }
  }
  if (typeof toast === "function") {
    const why =
      how === "name"
        ? I18n.t("（按名称唯一匹配）")
        : how === "model"
          ? I18n.t("（按模型归属）")
          : "";
    toast(
      I18n.t("已把 ") + nodes.length + I18n.t(" 个节点从服务商「") + from +
        I18n.t("」换成「") + to + I18n.t("」") + why,
      "warn",
    );
  }
  return nodes.length;
}

/** Agent 改节点（mtnode_canvas_edit）用：解析不到就自动替换并批量换掉同一缺失值。
    返回 { ok, value?, how?, why? }，ok:false 时由调用方把 why 记进 warnings。 */
function applyProviderRefWithFix(node, key, token, mode, modelHint) {
  const s = String(token || "").trim();
  if (!s) return { ok: false, why: I18n.t("服务商为空") };
  const direct =
    mode === "agent"
      ? resolveAgentProviderRoute(s, null)
      : (resolveApiProviderRef(s, node.kind, null) || {}).id;
  if (direct) {
    node[key] = direct;
    /* 写进来的是一条「名称 / 老 id」而不是本机 id：顺手把画布上其它同样写法的节点一并归一 */
    if (String(direct) !== s) replaceProviderAcrossCanvas(s, direct, "name", { exceptId: node.id });
    return { ok: true, value: direct, how: "id" };
  }
  const fix = fixProviderRefValue(s, mode, modelHint);
  if (fix && fix.value) {
    node[key] = fix.value;
    const n = replaceProviderAcrossCanvas(s, fix.value, fix.how, { exceptId: node.id });
    return { ok: true, value: fix.value, how: fix.how, count: n };
  }
  return { ok: false, why: (fix && fix.why) || I18n.t("本机没有这个服务商") };
}

/** 真跑节点前：服务商对不上就换掉（并批量换其它引用同一缺失值的节点）。
    false = 找不到可用服务商，该节点跳过运行（保留原值，不写坏画布）。 */
function ensureNodeProviderForRun(node) {
  const ref = nodeProviderRef(node);
  if (!ref) return true;
  const fix = fixProviderRefValue(ref.token, ref.mode, node.model);
  if (!fix) return true;
  if (fix.value) {
    if (fix.value !== ref.token && !replaceProviderAcrossCanvas(ref.token, fix.value, fix.how))
      node[ref.key] = fix.value;
    return true;
  }
  if (typeof toast === "function")
    toast(
      I18n.t("服务商「") + ref.token + I18n.t("」在本机找不到") +
        (fix.why ? I18n.t("（") + fix.why + I18n.t("）") : "") +
        I18n.t("：该节点已跳过运行"),
      "err",
    );
  return false;
}

function agentModelsForRoute(route) {
  const catalog = S.providerCatalog || {
    deepseek: [
      { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", input: ["text", "image"] },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input: ["text"] },
    ],
    piai: [],
  };
  /* 服务商白 / 黑名单：这条路由下「真正可选」的模型清单（白名单先收窄、黑名单再剔除） */
  const pf =
    typeof providerModelFilter === "function" ? providerModelFilter : null;
  if (route === "deepseek-official") {
    const dp = dshProvider();
    if (dp && Array.isArray(dp.models) && dp.models.length)
      return (pf ? pf(dp, dp.models) : dp.models).map((m) => String(m));
    return (catalog.deepseek || []).map((m) => m.id);
  }
  if (String(route || "").startsWith("mtnode_")) {
    const id = route.slice("mtnode_".length);
    const p = (S.config.providers || []).find((x) => x.id === id);
    /* 停用只影响「出现在选择器里」：这条路由的模型清单照旧给全（过了白 / 黑名单），
       画布上早就绑着它的节点不受可见性影响，避免开了节点设置就被悄悄换服务商 */
    return (pf ? pf(p, p && p.models) : (p && p.models) || []).map((m) =>
      String(m),
    );
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
      const r = applyProviderRefWithFix(
        node,
        "provider",
        patch.provider,
        "agent",
        patch.model != null ? patch.model : node.model,
      );
      if (r.ok) {
        node.vision = null;
        if (patch.model == null) {
          const models = agentModelsForRoute(node.provider);
          if (models.length && !models.includes(node.model))
            node.model = models[0];
        }
      } else {
        provOk = false;
        if (warnings)
          warnings.push(
            I18n.t("服务商「") + patch.provider + I18n.t("」") + r.why,
          );
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
      const r = applyProviderRefWithFix(
        node,
        "providerId",
        token,
        providerRefMode(node),
        patch.model != null ? patch.model : node.model,
      );
      if (r.ok) {
        if (patch.model != null) {
          const m = String(patch.model).trim();
          if (m) node.model = m;
        } else {
          const prov =
            providerCandidates(providerRefMode(node)).find((p) => p.id === r.value) || {};
          const models = prov.models || [];
          if (models.length && !models.includes(node.model))
            node.model = models[0];
        }
      } else if (warnings) {
        warnings.push(I18n.t("服务商「") + token + I18n.t("」") + r.why);
      }
    } else if (patch.model != null) {
      const m = String(patch.model).trim();
      if (m) node.model = m;
    }
  } else if (apiKinds && node.agent && patch.providerId != null) {
    /* 智能模式下仍可改回原模式服务商（切换 agent 后用） */
    const r = applyProviderRefWithFix(
      node,
      "providerId",
      patch.providerId,
      providerRefMode(node),
      node.model,
    );
    if (!r.ok && warnings)
      warnings.push(I18n.t("服务商「") + patch.providerId + I18n.t("」") + r.why);
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

/* canvas_edit 回执的「端口占用摘要」：模型改完不必回读就知道每个端子叫什么、收什么、
   挂了几条线。端子**数量**复用既有推导（inputCount / outputCount），**名称**与画布端子
   徽标同一套口径（app-canvas.js renderPorts），**类型**在工具 / 函数节点上复用
   fnToolPortKind —— 不另造第二份端子真源。类型取值：control / text / image / audio /
   video / any（any = 由连线决定的数据端子）。 */
function editPortNameOf(node, dir, i, isFnT) {
  const k = node.kind;
  if (isFnT) {
    if (dir === "in") {
      if (i === 0) return I18n.t("控制");
      const p = fnToolParamList(node, "in")[i - 1];
      return String((p && p.name) || "").trim() || I18n.t("参数 ") + i;
    }
    const outs = fnToolParamList(node, "out");
    if (i >= outs.length) return I18n.t("控制");
    return String((outs[i] && outs[i].name) || "").trim() || I18n.t("参数 ") + (i + 1);
  }
  /* 素材节点：端子号 = 内容条目号（第 i 入 ↔ 第 i 出），端子名 = 该条目的标题 ——
     与画布端子徽标、assetItems.items[].title 同一份口径，不再造第二份命名。 */
  if (isAssetNode(node)) {
    const items = assetItems(node);
    const it = items[Number(i)];
    return String((it && it.title) || "").trim() || I18n.t("内容 ") + (Number(i) + 1);
  }
  /* 节点层：用户在「外观」面板里给外侧端子起的名字（唯一真源 = app-canvas.js 的
     superPortNameOf，与画布徽标同一份口径）。没起名照旧往下走各自的默认名。 */
  if (k === "super" && typeof superPortNameOf === "function") {
    const nm = superPortNameOf(node, dir, i);
    if (nm) return nm;
  }
  if (dir === "in") {
    /* 动态端子节点：末位那颗是专用控制端子（数据槽之后，恒存在） */
    if (
      typeof isDynCtrlNode === "function" &&
      isDynCtrlNode(node) &&
      typeof dynCtrlInPortIndex === "function" &&
      i === dynCtrlInPortIndex(node)
    )
      return I18n.t("控制");
    if (k === "music_gen")
      return i === 0 ? I18n.t("提示词") : i === 1 ? I18n.t("歌词") : I18n.t("控制");
    if (k === "yue_gen")
      return i === 0
        ? I18n.t("风格提示词")
        : i === 1
          ? I18n.t("歌词")
          : i === 2
            ? I18n.t("ABC 谱")
            : I18n.t("控制");
    /* MOSS-Music：0=音频/视频路径 · 1=自由提问（留空用预设）· 2=控制输入 */
    if (k === "moss_music")
      return i === 0 ? I18n.t("音频 / 视频") : i === 1 ? I18n.t("自由提问") : I18n.t("控制");
    /* Breeze 语音（Breeze TTS 2）：端口0=待合成文本 · 1=参考音频 · 2=参考文稿 · 3=指令 · 4=控制输入 */
    if (k === "breeze_gen")
      return i === 0
        ? I18n.t("文本")
        : i === 1
          ? I18n.t("参考音频")
          : i === 2
            ? I18n.t("参考文稿")
            : i === 3
              ? I18n.t("指令")
              : I18n.t("控制");
    /* 质检节点（五种同构）：入 0 被检内容 · 1 质检要求（可多线）· 2 控制 */
    if (typeof isQaKindNode === "function" && isQaKindNode(node))
      return (
        [I18n.t("被检内容"), I18n.t("质检要求"), I18n.t("控制")][i] ||
        I18n.t("输入端子 ") + (i + 1)
      );
    /* FLUX 3 Image Klein：0=提示词 · 1=参考图（可多接）· 2=控制输入 */
    if (k === "flux3klein_gen")
      return i === 0
        ? I18n.t("提示词")
        : i === 1
          ? I18n.t("参考图（可多接，最多 10 张）")
          : I18n.t("控制");
    /* Qwen Image 2.1：0=提示词 · 1=参考图（可多接）· 2=控制输入 */
    if (k === "qwenimage_gen")
      return i === 0
        ? I18n.t("提示词")
        : i === 1
          ? I18n.t("参考图（可多接，最多 10 张）")
          : I18n.t("控制");
    /* InfiniteTalk 数字人：端口0=人物图 · 1=语音 · 2=源视频(V2V) · 3=提示词 · 4=控制输入 */
    if (k === "infinitetalk_gen")
      return i === 0
        ? I18n.t("人物图")
        : i === 1
          ? I18n.t("语音")
          : i === 2
            ? I18n.t("源视频")
            : i === 3
              ? I18n.t("提示词")
              : I18n.t("控制");
    /* SoulX-FlashHead Lite：端口0=人物图 · 1=语音 · 2=控制输入 */
    if (k === "soulxflashhead_gen")
      return i === 0 ? I18n.t("人物图") : i === 1 ? I18n.t("语音") : I18n.t("控制");
    if (k === "video_gen")
      return i === videoGenControlPort(node) ? I18n.t("控制") : I18n.t("提示词 / 参考");
    if (isVideoPostKind(node))
      return i === 0
        ? I18n.t("控制")
        : i === 1
          ? I18n.t("源视频")
          : I18n.t("素材 ") + (i - 1);
    /* Remotion：无差别端子（0、1、2… 连一条长一条，数据 / 控制共用）—— 不再有「描述」
       端子，也不预设角色名，统一走文末「输入端子 N」兜底；控制线口只按连线反推上色。 */
    if (k === "gate") return I18n.t("闸门输入 ") + (i + 1);
    if (k === "mutex") return I18n.t("互斥输入 ") + (i + 1);
    if (k === "task") return I18n.t("控制");
    if (k === "net_send") return i === 0 ? I18n.t("信息") : I18n.t("控制");
    return I18n.t("输入端子 ") + (i + 1);
  }
  if (k === "task") return i === 0 ? I18n.t("成功") : I18n.t("失败");
  /* InfiniteTalk 数字人：输出 0 = 数字人视频 mp4 · 输出 1 = 控制 */
  if (k === "infinitetalk_gen") return i === 0 ? I18n.t("视频") : I18n.t("控制");
  /* SoulX-FlashHead Lite：输出 0 = 数字人视频 mp4（含原音轨）· 输出 1 = 控制 */
  if (k === "soulxflashhead_gen") return i === 0 ? I18n.t("视频") : I18n.t("控制");
  if (
    k === "music_gen" ||
    k === "yue_gen" ||
    k === "breeze_gen" ||
    k === "video_gen" ||
    isVideoPostKind(node) ||
    k === "remotion"
  )
    return i === 0 ? I18n.t("内容") : I18n.t("控制");
  /* MOSS-Music：0=结果文本 · 1=JSON 文本 · 2=md 产物路径 */
  if (k === "moss_music")
    return (
      [I18n.t("结果文本"), I18n.t("JSON"), I18n.t("产物路径")][i] ||
      I18n.t("输出端子 ") + (i + 1)
    );
  if (k === "judge") return i === 0 ? "YES" : "NO";
  /* 质检节点的输出：0 报告 · 1 通过 · 2 未过（输入侧在上面 dir==="in" 段） */
  if (typeof isQaKindNode === "function" && isQaKindNode(node))
    return (
      [I18n.t("报告"), I18n.t("通过"), I18n.t("未过")][i] ||
      I18n.t("输出端子 ") + (i + 1)
    );
  if (k === "net_recv") return i === 0 ? I18n.t("信息") : I18n.t("控制");
  /* 音频 / 视频输入：输出端子固定两个 —— 0=音频输出 / 视频输出（该文件的 file:/// URL）·
     1=转写输出（该文件的转写文字，本机 SenseVoice，没有转写内容时是空文本）。
     与画布端子徽标（app-canvas.js portBadgeText）同一口径：徽标就写清是哪两个输出。 */
  if (k === "input_audio" || k === "input_video")
    return i === 0 ? I18n.t(k === "input_audio" ? "音频输出" : "视频输出") : I18n.t("转写输出");
  return I18n.t("输出端子 ") + (i + 1);
}

function editPortKindOf(node, dir, i, isFnT) {
  const k = node.kind;
  if (isFnT) {
    if (dir === "in")
      return i === 0 ? "control" : fnToolPortKind(node, "in", i) || "any";
    return i >= fnToolParamList(node, "out").length
      ? "control"
      : fnToolPortKind(node, "out", i) || "any";
  }
  /* 素材节点：端子类型 = 该内容条目的类型（text / image / audio / video），
     入出同一数法 —— 与 assetPortKind 同源，连线准入判定也认它。 */
  if (isAssetNode(node)) return assetPortKind(node, dir, i) || "control";
  if (dir === "in") {
    if (k === "net_send") return i === 1 ? "control" : "text";
    if (k === "music_gen") return i === 2 ? "control" : "text";
    if (k === "yue_gen") return i === 3 ? "control" : "text";
    /* Breeze 语音：端口1=参考音频（audio 文件 URL）· 端口4=控制；其余数据口是文本 */
    if (k === "breeze_gen")
      return i === 4 ? "control" : i === 1 ? "audio" : "text";
    /* FLUX 3 Image Klein：0=提示词（text）· 1=参考图（image）· 2=控制输入 */
    if (k === "flux3klein_gen")
      return i === 2 ? "control" : i === 1 ? "image" : "text";
    /* Qwen Image 2.1：0=提示词（text）· 1=参考图（image）· 2=控制输入 */
    if (k === "qwenimage_gen")
      return i === 2 ? "control" : i === 1 ? "image" : "text";
    /* SoulX-FlashHead Lite：0=人物图（image）· 1=语音（audio）· 2=控制输入 */
    if (k === "soulxflashhead_gen")
      return i === 2 ? "control" : i === 0 ? "image" : "audio";
    /* InfiniteTalk 数字人：0=人物图（image）· 1=语音（audio）· 2=源视频（video）· 3=提示词（text）· 4=控制 */
    if (k === "infinitetalk_gen")
      return i === 4
        ? "control"
        : i === 0
          ? "image"
          : i === 1
            ? "audio"
            : i === 2
              ? "video"
              : "text";
    if (k === "video_gen") return i === videoGenControlPort(node) ? "control" : "any";
    if (isVideoPostKind(node)) return i === 0 ? "control" : i === 1 ? "video" : "any";
    /* Remotion：**固化后**端子类型由端子契约声明（第 i 项 ↔ 第 i 号端子，
       image/audio/video → 对应媒体类型，text/json/number/boolean → text，末位 = 控制），
       与 app.js 的 remotionContractPortKind / inPortKindOf 同源；未固化时仍是无差别端子 ——
       端口类型由连线决定（控制线落任意空口 = 控制口，其余 = 任意数据）。
       （此前这里恒回 any，导致契约已固化也按「任意」报：快照端子类型与连线准入
         都与 inPortKindOf 不一致，音频 / 视频线接不进契约端子。） */
    if (k === "remotion") {
      const rc = typeof remotionContractOf === "function" ? remotionContractOf(node) : [];
      if (rc.length) {
        if (i >= rc.length) return "control";
        const ck = String(rc[i].kind || "text").toLowerCase();
        return ck === "image" || ck === "audio" || ck === "video" ? ck : "text";
      }
      return inPortIsControl(node, i) ? "control" : "any";
    }
    if (k === "moss_music") return i === 2 ? "control" : i === 1 ? "text" : "any";
    if (k === "task") return "control";
    /* 质检节点（五种同构）：0 被检内容（按类型）· 1 质检要求（text，也可接参考样例）· 2 控制
       —— 与 app.js 的 IN_PORT_DATA_KINDS / inPortIsControl 同一张表（改那边要同步这里）。 */
    if (typeof isQaKindNode === "function" && isQaKindNode(node)) {
      const t =
        {
          qa_text: ["text", "text"],
          qa_image: ["image", "text"],
          qa_video: ["video", "text"],
          qa_audio: ["audio", "text"],
          qa_file: ["any", "text"],
        }[k] || ["any", "text"];
      return i === 2 ? "control" : t[i] || "any";
    }
    if (isControlKind(node)) return "control";
      /* 图像节点：输入端子与 proc_image 同一泛用增量规则 —— 端口 0 = 提示词（文本入口），
       端口 1+ 是增量数据槽：**文本节点与图像引用都收**（文本进【背景信息】、参考图进
       参考图列表，见 buildSpec）。曾经在这里报 "image"，与同一份快照的 portRule
       「文本 / 图像引用都收」自相矛盾：模型读到「1+ 号端子只收图像」就不再把文本节点
       接上去（真源 inPortKindOf 对 proc_image 恒回 null，实际转接不拦）。按「由连线决定」
         的 any 报。 */
    if (k === "proc_image") return i === 0 ? "text" : "any";
    /* 动态端子节点（proc_text / input_* …）：数据槽由连线决定，末位那颗是专用控制端子 */
    if (typeof isDynCtrlNode === "function" && isDynCtrlNode(node))
      return typeof dynCtrlInPortIndex === "function" &&
        i === dynCtrlInPortIndex(node)
        ? "control"
        : "any";
    return "any";
  }
  if (k === "task" || k === "judge") return "control";
  /* 质检节点：0 报告（JSON 文本）· 1 / 2 控制（通过 / 未过）—— 判定口已撤掉 */
  if (typeof isQaKindNode === "function" && isQaKindNode(node)) return i >= 1 ? "control" : "text";
  if (k === "net_recv") return i === 0 ? "text" : "control";
  if (k === "moss_music") return "text";
  if (k === "music_gen" || k === "yue_gen" || k === "breeze_gen")
    return i === 0 ? "audio" : "control";
  if (k === "flux3klein_gen") return i === 0 ? "image" : "control";
  if (k === "qwenimage_gen") return i === 0 ? "image" : "control";
  if (k === "video_gen" || isVideoPostKind(node) || k === "remotion" || k === "infinitetalk_gen" || k === "soulxflashhead_gen")
    return i === 0 ? "video" : "control";
  if (isControlKind(node)) return "control";
  if (k === "proc_image" || k === "input_image") return "image";
  /* 音视频输入：端口 0 = 音频 / 视频输出（该文件的 file:/// URL），端口 1 = 转写输出
     （该文件的转写文字 = 文本端子） */
  if (k === "input_audio") return i === 0 ? "audio" : "text";
  if (k === "input_video") return i === 0 ? "video" : "text";
  /* 保存节点：唯一输出端子 = 本次保存的那份内容，类型按它自己的口径判
     （saveMediaKind → audio / image / video / text，PDF 恒 text），与 app.js 的
     warnIfSaveMediaMismatch / inferMediaFromSource 同源。缺这一支时快照恒报 "any"，
     下游（agent 或界面）都看不出这个端子其实是音频。 */
  if (typeof isSaveNode === "function" && isSaveNode(node)) {
    if (node.kind === "save_pdf") return "text";
    const m = typeof saveMediaKind === "function" ? saveMediaKind(node) : "text";
    return m === "image" || m === "audio" || m === "video" ? m : "text";
  }
  return "any";
}

function editNodePortSummary(node) {
  if (!node) return undefined;
  /* 节点层外侧端子的用户命名写成「名字（输入3）」——名字 + 端子号，模型据此把回执里的
     端口与画布上的端子对得上（口径见 app-canvas.js 的 superPortNameTagged）。 */
  const strip = (dir) => (p) => {
    let name = p.name;
    if (node.kind === "super" && typeof superPortNameTagged === "function") {
      const tagged = superPortNameTagged(node, dir, p.index);
      if (tagged) name = tagged;
    }
    return {
      i: p.index,
      name: name,
      kind: p.kind,
      n: (p.connectedTo || []).length,
    };
  };
  return {
    in: nodePortList(node, "in").map(strip("in")),
    out: nodePortList(node, "out").map(strip("out")),
  };
}

/* ── edit 收尾一次性静态校验 ──────────────────────────────────────────
   把「错了 → 报错 → 再改」压成一轮往返：本笔编辑写完盘前，把触碰到的节点 / 连线
   统一过一遍静态检查，warnings 合并进同一份回执。判定全部复用既有真源
   （connectError / warnBatchCartesianRisk / warnIfProcImageMultiPrompt /
   saveMediaKind / saveMediaCertain / saveMediaClassOfExt），只追加提示，
   不阻断已接受的编辑、不改任何节点、不另立第二套规则。 */
function isSmartAgentNode(n) {
  return !!(n && (n.kind === "agent_task" || (n.kind === "proc_text" && n.agent)));
}

/* 已存在连线的合法性：把该线临时摘出后跑真正的 connectError（唯一判定真源），
   判完 finally 原样放回 —— 不改画布状态、不新增第二套连线规则。 */
function wireStaticError(w) {
  if (!w || w.rel || !S.wf) return "";
  const wires = S.wf.wires || [];
  const i = wires.indexOf(w);
  if (i < 0) return "";
  wires.splice(i, 1);
  try {
    return connectError(w.from, w.to, w.toIndex, w.fromIndex) || "";
  } finally {
    wires.splice(i, 0, w);
  }
}

/* touchedIds = 本笔编辑触碰过的节点 id（只报自己动过的东西，不翻旧账） */
function collectEditStaticWarnings(touchedIds, warnings) {
  if (!warnings || !S.wf) return;
  const touched = touchedIds instanceof Set ? touchedIds : new Set(touchedIds || []);
  const seen = new Set();
  const push = (msg) => {
    const s = String(msg == null ? "" : msg).trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    warnings.push(s);
  };
  const label = (n) => (n && (n.title || n.kind)) || "";
  /* ② 批量 N² 全量注入（既有真源，画布级；原行为：每次 edit 收尾都跑一次） */
  if (typeof warnBatchCartesianRisk === "function") warnBatchCartesianRisk(warnings);
  if (!touched.size) return;
  for (const n of S.wf.nodes || []) {
    if (!touched.has(n.id)) continue;
    /* ③ proc_image 被要求多图（既有真源） */
    warnIfProcImageMultiPrompt(n, { push });
    if (!isSaveNode(n)) continue;
    /* ④ save 误接智能节点：agent_task / 开了 agent 的 proc_text 自己会写文件，
          其后接 save 会把会话噪声落盘 */
    for (const src of saveDataSources(n)) {
      if (isSmartAgentNode(src)) {
        push(
          I18n.t(
            "保存节点不能接智能处理节点（智能节点自己会写文件，其后接 save 会把会话内容落盘）",
          ) +
            "：" +
            label(n) +
            " ← " +
            label(src),
        );
      }
    }
    /* ⑤ 保存路径后缀须与输入类型一致（输入类型已定才判，未定不猜后缀） */
    const raw = String(n.savePath || "").trim();
    if (raw && saveMediaCertain(n)) {
      const media = saveMediaKind(n);
      const cls = saveMediaClassOfExt(raw);
      if (cls && cls !== media) {
        push(
          I18n.t("保存路径后缀与输入类型不符") +
            "：" +
            raw +
            " → " +
            forcePathExt(raw, saveExtForMedia(media)) +
            "（" +
            label(n) +
            "）",
        );
      }
    }
  }
  /* ① 连线合法性 · 端子类型匹配：只看本笔触碰到的线 */
  for (const w of (S.wf.wires || []).slice()) {
    if (!touched.has(w.from) && !touched.has(w.to)) continue;
    const err = wireStaticError(w);
    if (!err) continue;
    push(label(nodeById(w.from)) + " → " + label(nodeById(w.to)) + "：" + err);
  }
}

/* ============ 排版的触发闸（需求改写 2026-02） ============
   排版**只有一个入口**：调用方本笔显式写 `layout: true`（agent / MCP 自己要求的），
   或用户点「一键排版」按钮走 tidyLayout（那条路根本不进 applyCanvasEdit）。

   2026-02 需求：「不要自动改变」——编辑工具**不再**因为「建图 / 连线 / 改标注 /
   删除 / 改尺寸」就顺手排一遍。原先那套自动闸会把用户摆好的位置整片挪走、
   还会撑开超级壳，观感上就是「一次编辑把整张图重排了」。

   于是 agent / MCP 的普通编辑只落内容与连线：
     · 节点位置：只认本笔显式给的坐标（x/y）；
     · 节点尺寸：只认本笔显式给的 w/h（不再按正文长短重算）；
     · 新节点没给坐标 → 就近找空位落，绝不挪动已有节点（见 freeSpotForNode）。 */
function canvasEditWantsLayout(params, creates) {
  if (!params) return false;
  return params.layout === true;
}
/* 每笔编辑里「排了哪些层级、各层收进 16:9~9:16 没有」——收不进的层级名与尺寸
   交给调用方去 toast（排版本身不弹窗，回执里的 warnings 才是唯一出口）。 */
function canvasEditLayoutReport() {
  const groups = S._editLayoutGroups;
  if (!groups || !groups.size) return { levels: 0, ratioOk: true, worst: "", w: 0, h: 0 };
  let ratioOk = true;
  let worst = "";
  let w = 0;
  let h = 0;
  for (const g of groups.values()) {
    const r = g.report;
    if (r && r.ratioOk === false) {
      ratioOk = false;
      if (!worst) {
        worst = g.label || "";
        w = r.w || 0;
        h = r.h || 0;
      }
    }
  }
  return { levels: groups.size, ratioOk, worst, w, h };
}
/* ══ 写侧：编辑引擎（canvas-doc/canvas-doc-edit.js）＋ 现场出口 ═════════════════
   任务 5/8：applyCanvasEdit 里与 DOM 无关的那一段（参数端子拒绝闸 / scope 写入闸 / alias
   解析 / create·update·connect·disconnect·remove / marks / 分组 / layout 闸 / warnings 与
   回执组装）已抽成纯函数 applyEdit(doc, params, ctx)，本文件只剩这层薄包装：

     ① 前置闸：没有打开的画布 / 画布已被删除 → 抛（原样）
     ② 把画布现场拼成宿主 ctx（canvasEditHostCtx：引擎要的原语逐个列出，真源仍在渲染层）
     ③ 重绘与落盘：前台画布 renderCanvas + renderStatus + scheduleSave(true)；后台画布 persistWf
     ④ 事务（canvases.editTxn = off|on）：同一 runKey 的连续编辑攒到回合末一次重绘 + 一次落盘

   行为不变的判据是 test/smoke-canvas-doc-parity.js 的 [3] 编辑黄金（画布 JSON + 回执计数 +
   warnings 逐条），不是肉眼。 */

/* 引擎的宿主：引擎不碰任何全局，这里就是它的全部依赖。值在**调用期**取 —— 被引用的符号有
   排在 app-nodes.js 之后才定义的文件（app-node-params.js 的 NParam、app-assets.js 的 snap…）。 */
function canvasEditHostCtx() {
  return {
    /* 建 / 改节点 */
    NODE_DEFAULTS, makeNode, applyNodePatch, uniqueNodeTitle, devAutoColorNode,
    importImagePathsForNode, imagePathsFromPatch, ensureDefaultSavePath, sizeNodeForContent,
    /* 引用解析 / 归属 */
    resolveCanvasRef, canMoveNodeIntoSuper, rewriteNodePathsForSuperContext,
    applyNewNodePlacement, ensurePromptRefs, ensureTaskScaffold, nodeById,
    nodeParentTaskId, nodeParentSuperId, isSuperIoNode, isPinnedCtrl, taskDescendantIds,
    /* 连线 */
    relConnectError, addRelWire, dataInPortIndexForWire, connectError, wireKeepsLayerRule,
    bridgeNodesBetween, connectPortAdvice, dropWiresForReplace, isControlKind, addWire,
    applySuperConnect, clearDownstream, pruneInvalidSuperBoundaryWires,
    /* 绘制 / 组 */
    marksOf, markById, makeMarkFromSpec, applyMarkPatch, resolveMarkRef,
    ensureGroupArrays, pruneEmptyGroups, uid,
    /* scope 闸（与只读侧同一批包装函数） */
    resolveScopeHost, scopedNodeIdSet, pointInScopeHost,
    /* 排版 */
    layoutFlowEx, layoutOrigin, snap, fitAllOpenSuperShells, canvasEditWantsLayout,
    /* 回执字段 */
    editNodePortSummary, nodeHasImage, canUseGlobalRefs,
    IMAGE_SIZES, DEFAULT_IMAGE_SIZE,
    /* 交付节点禁建表（引擎里叫 lockedKinds，原 window.LT.LOCKED） */
    lockedKinds: (window.LT && window.LT.LOCKED) || null,
    /* 现场出口 / 许可闸 */
    pushHistory, trackWorkflow, closeNodeSettingsDialogIfStale, collectEditStaticWarnings,
    ensureCanvasEditTools, NParam,
  };
}

/* ── 编辑事务（开关 canvases.editTxn = off|on）─────────────────────────────────
   开 = 同一 runKey 内连续编辑**只记「这张画布该重绘 / 该落盘」**，回合末做一次：
   dsh 运行收尾（app-db.js 的 finish → commitCanvasEditTxn(runKey)）或窗口失焦 / 关闭
   （app.js 的 flushNow）都收口；也可以显式 commit。每次调用照样即时返回回执 ——
   回执里的快照读的是内存文档（S.wf），与重绘时机无关。
   关（缺省）/ 没有 runKey（MCP 直连、没有会话归属的调用）：当场重绘 + 当场落盘，
   与今天逐字节一致。 */
function canvasEditTxnOn() {
  const v = S.config && S.config.canvases && S.config.canvases.editTxn;
  return String(v || "") === "on";
}
function canvasEditTxnPending() {
  if (!(S._editTxnPending instanceof Map)) S._editTxnPending = new Map();
  return S._editTxnPending;
}
/* 一笔编辑的「摆给用户看」：前台画布重绘 + 走前台存盘通道；后台画布直接按对象自己的 id
   落盘（persistWf 用 wf.id 写 wfSave，写谁就是谁，绝不串到前台那张图上）。
   save=false：只重绘、不落盘 —— 写侧开关 canvases.docService=write 时，字节已经由主进程
   文档服务写完（见 canvasEditViaDocService），渲染层这一半只剩「摆给用户看」。 */
function canvasEditCommitNow(editWf, visible, save) {
  const doSave = save !== false;
  if (visible) {
    renderCanvas();
    /* 不平移/缩放用户视角：节点在世界坐标中更新，相机保持不动 */
    renderStatus();
    if (typeof renderSidebar === "function" && S.sidebarOpen) renderSidebar();
    if (doSave) scheduleSave(true);
  } else if (doSave) {
    persistWf(editWf);
  }
}
/* 结账：给了 runKey 只结那一轮，没给就全结；返回结掉几笔（自检用）。 */
function commitCanvasEditTxn(runKey) {
  const pend = canvasEditTxnPending();
  if (!pend.size) return 0;
  const key = String(runKey || "");
  const jobs = [];
  for (const [k, it] of pend) if (!key || k === key) jobs.push([k, it]);
  for (const [k, it] of jobs) {
    pend.delete(k);
    /* 回合末收尾：一次重绘失败不能把整轮拖挂（文档已在内存里，下一笔 / 失焦还会再落） */
    try {
      canvasEditCommitNow(it.wf, it.visible);
    } catch (err) {
      console.error("[canvas-edit] 事务收尾失败", err);
    }
  }
  return jobs.length;
}
/* 新一笔进来之前：事务被关掉 → 先把攒着的结掉；同一轮换了画布 → 先结上一张。 */
function canvasEditTxnSettle(runKey, editWf) {
  const pend = canvasEditTxnPending();
  if (!pend.size) return;
  if (!canvasEditTxnOn()) {
    commitCanvasEditTxn();
    return;
  }
  const it = pend.get(runKey);
  if (it && it.wf !== editWf) commitCanvasEditTxn(runKey);
}
/* 一句话提示：与搬家前同文案、同顺序（创建 / 绘制 / 连接 / 删除 / 已排版）。 */
function canvasEditToast(receipt, laidOut) {
  const bits = [];
  if (receipt.created && receipt.created.length)
    bits.push(I18n.t("创建 ") + receipt.created.length + I18n.t(" 个节点"));
  if (receipt.createdMarks && receipt.createdMarks.length)
    bits.push(I18n.t("绘制 {n} 个", { n: receipt.createdMarks.length }));
  if (receipt.connected && receipt.connected.length)
    bits.push(I18n.t("连接 ") + receipt.connected.length + I18n.t(" 条线"));
  if (receipt.removed && receipt.removed.length)
    bits.push(I18n.t("删除 ") + receipt.removed.length + I18n.t(" 个节点"));
  if (laidOut) bits.push(I18n.t("已排版"));
  if (bits.length) toast(I18n.t("智能助手已更新画布：") + bits.join(" · "), "ok");
}

/* ── 写侧开关（canvases.docService = write）：编辑引擎进文档服务（任务 6/8）─────────
   开 = 编辑帧交给主进程文档服务执行：服务持文档、用**同一份**引擎（MTCanvasDocEdit.applyEdit）
   改、自己落盘，只把「回执 + 差量」回给渲染层；本层降级为视图 —— 把差量合进 S.wf、压一格
   撤销栈、重绘一次。回执字段与搬家前一字不改（快照仍由渲染层补：选中项 / 面板开关只有它知道）。
   关（缺省）/ 桥没装 / 服务不成 / 这一笔带图片路径 → 一行都不走这里，仍旧是渲染层自己改 + 自己存。
   随时可把开关退成 read / off：那两条路一个字都没动。 */
function canvasDocWriteEnabled() {
  const cfg = S.config && S.config.canvases;
  if (!cfg || String(cfg.docService || "") !== "write") return false;
  return !!(window.api && typeof window.api.canvasDocEdit === "function");
}
/* 这一笔要不要留在渲染层：带 imagePath / imagePaths 的编辑要在渲染进程里拷图片资产
   （window.api.assetCopy 那条 IPC 桥服务侧的 vm 里没有），交出去的只会是一句「载入图像失败」。 */
function canvasEditNeedsRenderAssets(params) {
  const specs = (Array.isArray(params && params.create) ? params.create : []).concat(
    Array.isArray(params && params.update) ? params.update : [],
  );
  return specs.some(
    (sp) => sp && ((Array.isArray(sp.imagePaths) && sp.imagePaths.length) || sp.imagePath),
  );
}
/* 服务回的排版报告是纯数组（Map 过不了 JSON），这里还原成引擎那套 Map 形状：
   canvasEditLayoutReport 只读 size / label / report.ratioOk / w / h。 */
function canvasEditLayoutGroupsFromService(list) {
  const m = new Map();
  (list || []).forEach((g, i) => {
    m.set(g && g.key != null ? g.key : i, {
      label: (g && g.label) || "",
      report: (g && g.report) || null,
    });
  });
  return m;
}
/* write 档的一笔编辑：发 op → 服务改文档并落盘 → 把差量合进 S.wf → 只重绘一次。
   返回回执（含渲染层补的那份快照）；返回 null = 这一笔没走成，调用方原路回落到渲染层写路径
   （一行行为都不变：错误文案、撤销粒度、落盘时机都在老路上）。 */
async function canvasEditViaDocService(editWf, params, o) {
  const api = window.api;
  const runKey = (o && o.runKey) || "";
  if (typeof MTCanvasDocEdit.editSkipsWrites !== "function") return null;
  /* 工具许可闸（渲染层才知道权限现场）：顺序与引擎一致 —— 空笔不跑闸，有内容才跑。
     它在渲染层跑过之后，服务侧那一份是空实现（不许拿 vm 里的假配置改用户设置）。 */
  if (!MTCanvasDocEdit.editSkipsWrites(params)) await ensureCanvasEditTools(params, runKey);
  /* 文档真源在磁盘：服务改的是落盘那一份，先把防抖里待写的刷下去（否则服务在改上一版） */
  if (S.saveTimer) {
    try {
      await flushCurrentWf();
    } catch (_) {}
  }
  /* 撤销栈沿用现有快照式：编辑前的现场压一格（粒度 = 一次调用一格，与搬家前一致；
     空笔 / 整笔拒绝不压 —— 只看服务回没回「有改动」）。 */
  const before = snapshotState();
  let r = null;
  try {
    r = await api.canvasDocEdit(String(editWf.id || ""), params, { runKey, snap: grid() });
  } catch (err) {
    console.error("[canvas-edit] 文档服务编辑失败，回落渲染层写路径", err);
    return null;
  }
  if (!r || r.ok === false || !r.receipt) return null;
  const receipt = r.receipt;
  const diff = r.diff || null;
  const diffOk = typeof MTCanvasDocDiff === "object" && MTCanvasDocDiff;
  const changed = r.changed !== false && !(diffOk && MTCanvasDocDiff.diffIsEmpty(diff));
  /* 没有改动 / 整笔拒绝：文档一个字节都没动，回执照旧带一份无参快照（与搬家前同口径） */
  if (!changed) return Object.assign(receipt, canvasSnapshot());
  /* 服务已经改成功（且落了盘）：这一笔**不许**再回落到老路重放一遍 —— 差量用不了就如实报错 */
  if (!diffOk || !diff)
    throw new Error(
      I18n.t("画布差量无法应用：文档已在服务侧更新，请重新打开画布"),
    );
  /* 差量 → S.wf（就地合，保对象身份：设置窗 / 选中项抓的还是同一个节点对象） */
  MTCanvasDocDiff.applyDocDiff(editWf, diff);
  pushHistory(before);
  if (r.effects && r.effects.layoutGroups)
    S._editLayoutGroups = canvasEditLayoutGroupsFromService(r.effects.layoutGroups);
  const visible = editWf === currentVisibleWf() && S._canvasEditVisible !== false;
  /* 引擎里那两处 UI 出口（服务侧是空实现）：按回执 / 差量补一次，条件与引擎一致 */
  if ((receipt.removed || []).length && typeof closeNodeSettingsDialogIfStale === "function")
    closeNodeSettingsDialogIfStale({ silentRerender: true, skipSave: true, quiet: true });
  if (diff.keys && diff.keys.set && Object.prototype.hasOwnProperty.call(diff.keys.set, "name"))
    trackWorkflow(editWf.id, editWf.name);
  /* 「只重绘一次」：字节已由服务落盘，这里不再 scheduleSave / persistWf */
  canvasEditCommitNow(editWf, visible, false);
  canvasEditToast(receipt, canvasEditWantsLayout(params));
  return Object.assign(
    receipt,
    canvasSnapshot({ scope: params.scope, scopeDepth: params.scopeDepth }),
  );
}

async function applyCanvasEdit(params, ctx) {
  params = params || {};
  /* 二次防线：这是真正改图并落盘的入口，绑定画布若已被删除就直接抛错，
     绝不再往内存 / 磁盘写（applyCanvasOp 已拦一次，这里防别的调用路径）。
     进函数第一行就把「本次编辑动的是哪张画布」钉成对象：调用方（handleCanvasEvent）
     已用 runAgainstWf 把 S.wf 换成本轮所属画布，所以此刻的 S.wf 就是写入目标。
     收尾落盘按这个对象自己的 id 写 —— 编辑途中的 await（图片资产拷贝）里用户可能
     切了画布，届时 S.wf 已是另一张图，再按 S.wf 存就是「存了别人的、丢了自己的」。 */
  if (!S.wf) throw new Error(I18n.t("当前没有打开的画布"));
  const editWf = S.wf;
  if (wfWriteBlocked(editWf)) throw new Error(deletedWfError(editWf));
  const runKey = String((ctx && ctx.runKey) || "");
  /* 只有「真有一轮回合」的编辑才进事务：MCP 帧（第三方客户端）虽然也带 runKey，但它一帧
     就是一次完整调用、没有回合末，必须当场重绘（mcpFrameSettle 是它的回执通道）。 */
  const txnable = !!runKey && !(ctx && typeof ctx.mcpFrameSettle === "function");
  canvasEditTxnSettle(runKey, editWf);
  /* write 档：编辑交给主进程文档服务执行，这里只把差量合进 S.wf 并重绘一次。
     没走成（开关关着 / 桥没装 / 服务回失败 / 这一笔要拷图片资产）→ 原路走下面的渲染层写路径。 */
  if (canvasDocWriteEnabled() && !canvasEditNeedsRenderAssets(params)) {
    const viaSvc = await canvasEditViaDocService(editWf, params, { runKey });
    if (viaSvc) return viaSvc;
  }
  /* 引擎只认 doc + params + 宿主；pushHistory / 许可闸 / 回执与 warnings 都在它里面，
     顺序与搬家前一致（拒绝闸先于 pushHistory，pushHistory 先于任何写操作）。 */
  const out = await MTCanvasDocEdit.applyEdit(editWf, params, {
    i18n: I18n,
    runKey,
    host: canvasEditHostCtx(),
  });
  const receipt = out.receipt;
  if (out.effects && out.effects.layoutGroups)
    S._editLayoutGroups = out.effects.layoutGroups;
  /* 「没有改动」：与搬家前一致 —— 不重绘、不落盘，直接回一份无参快照 */
  if (out.effects && out.effects.noChange)
    return Object.assign(receipt, canvasSnapshot());
  /* 收尾：只有「这张就是用户正看着的画布」才重绘 + 走前台保存通道；否则按对象自己的
     id 落盘。事务开着且有回合归属 → 攒到回合末（见上方 canvasEditTxnOn 的说明）。 */
  const visible = editWf === currentVisibleWf() && S._canvasEditVisible !== false;
  if (txnable && canvasEditTxnOn()) {
    canvasEditTxnPending().set(runKey, { wf: editWf, visible });
  } else {
    canvasEditCommitNow(editWf, visible);
  }
  canvasEditToast(receipt, canvasEditWantsLayout(params));
  return Object.assign(
    receipt,
    canvasSnapshot({ scope: params.scope, scopeDepth: params.scopeDepth }),
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
  /* 组线：来源是组不是节点 —— 不占端子号、不影响下游补跑，摘掉即可
     （连线 path 由 updateWires 统一回收） */
  if (isGroupWire(w)) return;
  const toNode = nodeById(w.to);
  /* 固定端子（音乐 P/L、视频多路、闸门等）禁止压缩 toIndex，否则会错位 */
  if (!hasFixedInPorts(toNode)) {
    for (const x of S.wf.wires) {
      if (x.to === w.to && x.toIndex > w.toIndex) x.toIndex--;
    }
  }
  /* 动态端子节点：数据槽缩短 → 专用控制端子前移，控制线跟着归位（见 dynCtrlInPortIndex） */
  if (toNode && typeof syncDynCtrlWires === "function") syncDynCtrlWires(toNode);
  if (!wireFromIsControl(w)) clearDownstream(w.to);
  /* 音视频输入节点的内容随入线改变（拔线 → 回落到自己的文件）→ 就地重建这些卡片 */
  refreshMediaInputCards([w.to, w.from]);
  /* 断线也要叫一次：交付节点上的端子重排 / 归属重绑之后，剩下的线里可能又有「现在才拿得到
     文件」的一件（上游刚产出）—— 自动收线不看「刚发生了什么」，只按当下的事实算。
     断线本身不会把已交的件退回（那是「撤回」的事，由用户显式发起）。 */
  if (toNode && toNode.kind === "deliver" && window.LT && typeof window.LT.autoCollectSoon === "function") window.LT.autoCollectSoon();
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
          agentTouchSession().catch(() => {});
          renderAgentSessionSidebar();
        }
      } else if (node.kind === "super" && node.dev) {
        /* 开发节点改名 → 其名下的开发 / 细化会话标题跟随 */
        syncDevSessionTitles(node);
        agentTouchSession().catch(() => {});
      }
      scheduleSave();
    }
    /* 标题改了要当场看得见（含节点层折叠卡 body 里的大标题）：
       ① 输入框还握着焦点时，renderCanvas 的焦点守卫会把整幅重建推后 —— 先交还焦点；
       ② 复用快速通道不重挂节点 DOM（标题输入框会一直留在头部、body 还是旧字）——
          所以按模型重建这一颗节点的元素，头部与 body 一次刷到位。 */
    try {
      input.blur();
    } catch (_) {}
    const host = document.querySelector('.wf-node[data-nid="' + node.id + '"]');
    if (host) {
      refreshNodeEl(node.id);
      /* 这一颗已按模型重建好：签名跟着刷新，否则旧签名（标题还是旧的）会把下一次
         普通重绘误判成「形状变了」，白白整幅重建一次（图片 / 视频会跟着闪一下）。 */
      if (typeof canvasRenderSig === "function") S._renderSig = canvasRenderSig();
      if (S.sidebarOpen && typeof renderSidebar === "function") renderSidebar();
    } else {
      S._renderSig = null;
      renderCanvas();
    }
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





"use strict";
/**
 * 质检节点（kind `qa_text` / `qa_image` / `qa_video` / `qa_audio` / `qa_file`）·
 * 执行体 + 自动过关门禁 + 人工裁决卡
 *
 * 干什么：拿「被检内容 + 质检要求」进场，按**节点里选中的 JSON 评分标准**
 * 跑一个带工具的多轮 Agent（可读文件 / 看图 / 抽帧 / 转写 / 查网页 / 跑命令 / 写文件），
 * 让 Agent 自己决定看什么、看完给出每维 0–100 分与理由，内核按模板权重加权成 0–100 总分，
 * 再按模板的 passLine / minScore 判 pass | fail | blocked，报告落
 * `<工程根>/qa/reports/{id}.json`。
 *
 * 门禁（只判不返工）：
 *   · pass     → 走「通过」控制出（输出 1），下游照常；
 *   · fail     → 置「需干涉」并走「未过」控制出（输出 2）；不弹卡、不自动重跑上游。
 *                人想放行时点节点上的「人工裁决」按钮：接受 → 报告记 manualOverride 并转「通过」
 *                （不重触发下游），放弃 → 判失败。
 *   · blocked  → 模型调不通 / 回包解不出 JSON / 某维没给分：只置「需干涉」、写 blocked，
 *                **绝不写 pass**。
 *
 * 评分标准不进代码：模板是纯 JSON（见 qa-templates/ 与 main-qa-media.js 的模板库），
 * 节点 body 里可以直接改这份 JSON（存 node.qaTemplateJson，只影响这一颗节点），
 * 也可以「保存为新模板」写进 <数据目录>/qa-templates/ 供全局复用。
 *
 * 边界：本文件只碰「这颗节点自己的字段 + 报告文件 + manifest 的 shots[id].qa」，
 * 不改画布上别的节点字段，也不驱动别的节点运行。
 */

/* ── 常量 ─────────────────────────────────────────────────────────────────── */

/* 菜单顺序：文 → 图 → 视频 → 音频 → 文件。
   清单真源在 renderer/app.js 的 QA_KIND_LIST（先加载）；独立加载 / 单测时用同一份兜底。 */
const QA_KINDS =
  typeof QA_KIND_LIST !== "undefined" && Array.isArray(QA_KIND_LIST)
    ? QA_KIND_LIST.slice()
    : ["qa_text", "qa_image", "qa_video", "qa_audio", "qa_file"];

const QA_KIND_META = {
  qa_text: {
    media: "text",
    label: "文本质检",
    tag: "文本",
    content: "文本（正文 / 文件内容）",
  },
  qa_image: {
    media: "image",
    label: "图像质检",
    tag: "图像",
    content: "图像文件（png / jpg / webp …）",
  },
  qa_video: {
    media: "video",
    label: "视频质检",
    tag: "视频",
    content: "视频文件（mp4 / mov / mkv …）",
  },
  qa_audio: {
    media: "audio",
    label: "音频质检",
    tag: "音频",
    content: "音频文件（wav / mp3 / m4a …）",
  },
  qa_file: {
    media: "file",
    label: "文件质检",
    tag: "文件",
    content: "任意文件（文档 / 表格 / 工程文件 …）",
  },
};

/* 上游可重跑的生成节点（只对媒体类被检内容有意义） */
const QA_GEN_KINDS = [
  "proc_image",
  "flux3klein_gen",
  "qwenimage_gen",
  "video_gen",
  "infinitetalk_gen",
  "soulxflashhead_gen",
  "remotion",
  "music_gen",
  "yue_gen",
  "breeze_gen",
];

/* 质检 Agent 的工具白名单（默认全开，⚙ 里可逐项关）。
   doc 就是告诉模型怎么写的参数示例；真源在下面的 qaRunTool。 */
const QA_TOOLS = [
  {
    id: "list",
    label: "列目录",
    doc: '{"path":"绝对路径"}',
    desc: "列出一层文件与子目录",
  },
  {
    id: "read",
    label: "读文本",
    doc: '{"path":"绝对路径","offset":0,"limit":12000}',
    desc: "读文本文件，支持分段",
  },
  {
    id: "grep",
    label: "搜文本",
    doc: '{"pattern":"正则","path":"目录或文件"}',
    desc: "在目录 / 文件里搜关键字，返回命中行",
  },
  {
    id: "vision",
    label: "看图",
    doc: '{"paths":["图1","图2"],"question":"要看什么"}',
    desc: "直接把图片交给视觉模型细看，返回描述",
  },
  {
    id: "probe",
    label: "读媒体指标",
    doc: '{"path":"视频 / 音频"}',
    desc: "ffprobe：时长 / 分辨率 / 帧率 / 码率 / 黑帧段",
  },
  {
    id: "frames",
    label: "抽帧",
    doc: '{"path":"视频","count":6} 或 {"path":"视频","times":[1.2,3.4]}',
    desc: "按时间点抽帧成 PNG（上限 12 张），图片会随下一轮一起给到你",
  },
  {
    id: "transcribe",
    label: "转写语音",
    doc: '{"path":"音频 / 视频"}',
    desc: "本机 SenseVoice 逐句转写成文字",
  },
  {
    id: "pdf",
    label: "PDF 转文本",
    doc: '{"path":"...pdf"}',
    desc: "把 PDF 文本层转成 Markdown",
  },
  {
    id: "web",
    label: "联网",
    doc: '{"query":"搜索词"} 或 {"url":"https://…"}',
    desc: "搜索或抓取网页正文",
  },
  {
    id: "shell",
    label: "执行命令",
    doc: '{"command":"命令行","cwd":"可选工作目录"}',
    desc: "在本机跑一条命令（有 180 秒上限），返回 stdout / stderr",
  },
  {
    id: "write",
    label: "写文件",
    doc: '{"path":"绝对路径","content":"文本"}',
    desc: "落中间产物（会覆盖同名文件）",
  },
];

const QA_TOOL_IDS = QA_TOOLS.map((t) => t.id);

function qaClampNum(v, dflt, lo, hi) {
  const n = Number(v);
  const x = isFinite(n) ? n : dflt;
  return Math.max(lo, Math.min(hi, x));
}

function isQaKind(node) {
  return !!node && QA_KINDS.indexOf(node.kind) >= 0;
}

function qaKindMeta(node) {
  return QA_KIND_META[(node && node.kind) || ""] || QA_KIND_META.qa_file;
}

/** 思考强度：质检默认「无思考」（走的快、少绕弯），要更严的用户可在 ⚙ 里手动升档。
 *  取值词汇与文本节点同一份（off / low / medium / high / max，见 app-canvas.js）。 */
function qaEffortOf(node) {
  const raw = String((node && node.qaEffort) || "").trim();
  if (!raw) return "off";
  return typeof normalizeTextEffort === "function" ? normalizeTextEffort(raw) : "off";
}

/** 节点参数归一（缺省：抽帧 7、思考强度 无；11 个 Agent 工具恒开，不做开关）。
 *  参考样例不设条数上限：样例接了几条就全给模型，看哪些、比哪些由质检模型自己判断。 */
function qaCfg(node) {
  const n = node || {};
  return {
    frames: Math.round(qaClampNum(n.qaFrames, 7, 1, 12)),
    effort: qaEffortOf(n),
    template: String(n.qaTemplate || "").trim(),
    templateJson: qaParseTemplateJson(n.qaTemplateJson),
  };
}

/** 本次质检**实际要用**的服务商与模型：
 *   · 服务商 = node.providerId 对应的配置对象（apiCall 必须收对象：只传 id 时主进程
 *     拿不到 baseUrl，就会报「未配置接口地址」，哪怕设置里配得好好的）；
 *   · 模型 = node.model，空着就退回该服务商里第一个文本模型，并写回节点 ——
 *     ⚙ 里的模型下拉在没有 node.model 时显示的就是这个默认值，不写回就会出现
 *     「面板里明明选着模型，一点 ▶ 却说没有选质检模型」。 */
function qaModelOf(node, opts) {
  const write = !opts || opts.write !== false;
  const pid = String((node && node.providerId) || "").trim();
  const provs = (typeof S === "object" && S && S.config && S.config.providers) || [];
  const prov = pid ? provs.find((p) => p.id === pid) || null : null;
  const models =
    prov && typeof modelsOfKind === "function"
      ? modelsOfKind(S.config, prov, "text").map(String)
      : [];
  const cur = String((node && node.model) || "").trim();
  const model = cur || models[0] || "";
  if (write && node && model && model !== cur) node.model = model;
  /* 服务商能不能收图：主进程只在 provider.vision 为真时才把 images 拼进多模态请求，
     所以提示词里「随消息附上的图片」必须以它为判据，不能按图片数瞎写。 */
  const canSee = !!(prov && prov.vision);
  return { provider: pid, prov, model, models, canSee };
}

/** 上一次「没选模型 / 没配接口地址」留下的红字：现在已经能解析出可用的服务商与模型就撤掉 ——
 *  否则用户按提示去 ⚙ 选好模型，节点上仍挂着旧红字，看着像没生效。
 *  （「未配置接口地址」曾经是「provider 传成 id」的误报，服务商真有 baseUrl 时必须撤掉。） */
const QA_MODEL_ERR_RE = /没有选质检模型|在本机没有可用的文本模型|未配置接口地址|No endpoint configured/;
function qaClearStaleModelError(node) {
  const msg = String((node && node.error) || "");
  if (!msg || !QA_MODEL_ERR_RE.test(msg)) return false;
  const pick = qaModelOf(node);
  if (!pick.model || !pick.prov) return false;
  if (/未配置接口地址|No endpoint configured/.test(msg) && !String(pick.prov.baseUrl || "").trim()) return false;
  node.error = null;
  node.qaVerdict = "";
  if (node.taskStatus === "blocked") node.taskStatus = "";
  return true;
}

/** 节点本地模板覆盖（body 里改的那份 JSON）：解析失败返回 null，交给模板解析报错 */
function qaParseTemplateJson(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch (_) {
    return null;
  }
}

/* ── 输入取值 ─────────────────────────────────────────────────────────────── */

function qaNodeOf(id) {
  try {
    return typeof nodeById === "function" ? nodeById(id) : null;
  } catch (_) {
    return null;
  }
}

function qaWiresIn(node) {
  const wf = (typeof S === "object" && S && S.wf) || null;
  const wires = (wf && wf.wires) || [];
  return wires.filter((w) => w && !w.rel && w.to === node.id);
}

/** 一条线取「第一个有值的」来源；返回 {v, src} */
function qaWireValueAt(node, port) {
  for (const w of qaWiresIn(node)) {
    if (Number(w.toIndex || 0) !== port) continue;
    const src = qaNodeOf(w.from);
    if (!src) continue;
    try {
      const v = valueForInput(src, 0, node);
      if (v != null) return { v, src };
    } catch (_) {}
  }
  return null;
}

/** 只认真正的路径字段（文本节点的正文不当路径用） */
function qaValPath(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    return /^[A-Za-z]:[\\/]|^\//.test(v.trim()) ? v.trim() : "";
  }
  const p = String(v.path || v.image || v.file || v.url || "").trim();
  if (!p) return "";
  return p.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "");
}

function qaTextValueOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  const t = v.text != null ? v.text : v.value != null ? v.value : "";
  return String(t == null ? "" : t);
}

const QA_EXT_KIND = [
  [/\.(mp4|mov|mkv|webm|avi|m4v)$/i, "video"],
  [/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i, "image"],
  [/\.(mp3|wav|m4a|flac|aac|ogg|opus|aiff?)$/i, "audio"],
  [/\.(txt|md|markdown|json|ya?ml|csv|tsv|srt|vtt|js|mjs|cjs|ts|tsx|jsx|py|html?|xml|log|ini|toml)$/i, "text"],
];

function qaGuessKindOfPath(p) {
  const s = String(p || "");
  for (const [re, kind] of QA_EXT_KIND) if (re.test(s)) return kind;
  return "file";
}

/** 输入端 0：被检内容 */
function qaContentOf(node) {
  const hit = qaWireValueAt(node, 0);
  if (!hit) return null;
  const { v, src } = hit;
  const path = qaValPath(v);
  const text = qaTextValueOf(v);
  let kind = "";
  if (path) kind = qaGuessKindOfPath(path);
  else if (String(text || "").trim()) kind = "text";
  else {
    const k = String((v && v.kind) || "");
    kind = k === "video" || k === "image" || k === "audio" ? k : "file";
  }
  return {
    kind,
    path,
    text: kind === "text" ? text : "",
    src,
    srcId: src.id,
    srcKind: src.kind,
  };
}

/** 输入端 1：质检要求 —— 一条端子上同时收「文字口径」与「参考样例」，可多线：
 *    · 文本节点 / 文本文件 → 拼进 requirement（脚本 / 规格 / 打分点的原话）；
 *    · 图 / 视频 / 音频 / 其它文件 → 全部进 refs（样片、设定图、金标准文件），不设条数上限。
 *  合并前它们是两颗端子（入 1 要求/脚本 · 入 2 参考基准），现在只留这一颗。 */
function qaRequirementOf(node) {
  const texts = [];
  const refs = [];
  for (const w of qaWiresIn(node)) {
    if (Number(w.toIndex || 0) !== 1) continue;
    const src = qaNodeOf(w.from);
    if (!src) continue;
    let v = null;
    try {
      v = valueForInput(src, 0, node);
    } catch (_) {
      v = null;
    }
    const path = qaValPath(v);
    const text = String(qaTextValueOf(v) || "").trim();
    const title = String((src && src.title) || src.kind || "");
    if (path) {
      /* 文本文件当「要求文档」读：正文不整段塞 prompt，只给路径让 Agent 用 read 打开 */
      if (qaGuessKindOfPath(path) === "text") {
        texts.push(
          (texts.length ? "### " + title + "\n" : "") +
            I18n.t("（要求写在这个文件里，可用 read 工具打开：") + path + "）",
        );
      } else {
        refs.push({
          title,
          path,
          text: text.slice(0, 4000),
          kind: qaGuessKindOfPath(path),
        });
      }
      continue;
    }
    if (!text) continue;
    texts.push(texts.length ? "### " + title + "\n" + text : text);
  }
  return { text: texts.join("\n\n"), refs };
}

/** 有没有接「质检要求」：body 里的 JSON 编辑器据此切只读（入 0 被检内容不算） */
function qaHasRequirementWire(node) {
  return qaWiresIn(node).some((w) => Number(w.toIndex || 0) === 1);
}

/* 上游生成节点（输入端 0 的媒体来源）：**只**用于「生成者不自评」检查，绝不据此重跑任何节点 */
function qaUpstreamGensOf(node) {
  const out = [];
  for (const w of qaWiresIn(node)) {
    if (Number(w.toIndex || 0) !== 0) continue;
    const src = qaNodeOf(w.from);
    if (src && QA_GEN_KINDS.indexOf(src.kind) >= 0) out.push(src);
  }
  return out;
}

/* 反自评（G13）：质检模型必须与生成节点不同 —— 输入端 0 上每一颗生成节点都要比 */
function qaSelfReview(node, gens) {
  const provider = String(node.providerId || "");
  const model = String(node.model || "");
  for (const gen of gens || []) {
    const gProv = String(gen.providerId || "");
    const gModel = String(gen.model || "");
    if (model && gModel && model === gModel) {
      return (
        "生成者不自评（G13）：质检模型与上游生成节点「" +
        (gen.title || gen.kind) +
        "」用的是同一个模型（" +
        model +
        "），请换一个模型"
      );
    }
    if (provider && gProv && provider === gProv && !model) {
      return (
        "生成者不自评（G13）：质检与上游生成节点「" +
        (gen.title || gen.kind) +
        "」同一个服务商且未指定模型，请显式选一个不同的模型"
      );
    }
  }
  return "";
}

/* ── 模板（评分标准）──────────────────────────────────────────────────────── */

let qaTemplateCache = { root: "", at: 0, data: null };

async function qaTemplateList(root, force) {
  const api = typeof window !== "undefined" ? window.api : null;
  if (!api || typeof api.qaTemplates !== "function") {
    return { ok: false, error: "模板桥未就绪（preload 未加载 qaTemplates）" };
  }
  const r = String(root || "");
  if (!force && qaTemplateCache.data && qaTemplateCache.root === r && Date.now() - qaTemplateCache.at < 15000) {
    return qaTemplateCache.data;
  }
  let res;
  try {
    res = await api.qaTemplates({ root: r });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || "读模板库失败" };
  qaTemplateCache = { root: r, at: Date.now(), data: res };
  return res;
}

/** 模板结构校验：字段名与判定口径都在这里，主进程只负责读盘 */
function qaTemplateErrors(tpl, media) {
  const errs = [];
  const need = (p, ok, msg) => {
    if (!ok) errs.push({ path: p, msg });
  };
  const t = tpl && typeof tpl === "object" && !Array.isArray(tpl) ? tpl : null;
  need("", !!t, "模板必须是一个 JSON 对象");
  if (!t) return errs;
  const kind = String(t.kind || "").trim().toLowerCase();
  need(
    "kind",
    !kind || kind === "any" || kind === String(media || ""),
    "模板 kind=" + (kind || "(空)") + " 不适用于「" + String(media || "") + "」质检",
  );
  const pass = Number(t.passLine);
  need("passLine", isFinite(pass) && pass >= 0 && pass <= 100, "passLine 必须是 0–100 的数字");
  const dims = Array.isArray(t.dimensions) ? t.dimensions : [];
  need("dimensions", dims.length > 0, "dimensions 必须是非空数组（至少一维）");
  const seen = new Set();
  let wsum = 0;
  dims.forEach((raw, i) => {
    const p = "dimensions[" + i + "]";
    const d = raw && typeof raw === "object" ? raw : null;
    need(p, !!d, "维度必须是对象");
    if (!d) return;
    const id = String(d.id || "").trim();
    need(p + ".id", !!id, "维度缺少 id");
    if (id) {
      need(p + ".id", !seen.has(id), "维度 id 重复：" + id);
      seen.add(id);
    }
    need(p + ".title", !!String(d.title || id || "").trim(), "维度缺少 title");
    const w = Number(d.weight);
    need(p + ".weight", isFinite(w) && w > 0, "weight 必须是正数");
    if (isFinite(w) && w > 0) wsum += w;
    need(p + ".criteria", !!String(d.criteria || "").trim(), "维度缺少 criteria（评分细则）");
    if (d.minScore != null) {
      const ms = Number(d.minScore);
      need(p + ".minScore", isFinite(ms) && ms >= 0 && ms <= 100, "minScore 必须是 0–100");
    }
  });
  need("dimensions", wsum > 0, "所有维度的 weight 加起来必须大于 0");
  return errs;
}

/** 按节点当前类型从模板清单里取一份可用的标准；节点 body 里改过的 JSON 覆盖优先（只影响这颗节点） */
function qaTemplateResolve(node, data) {
  const tpls = (data && data.templates) || [];
  const want = String((node && node.qaTemplate) || "").trim();
  const media = qaKindMeta(node).media;
  const rawOverride = String((node && node.qaTemplateJson) || "").trim();
  if (rawOverride) {
    const parsed = qaParseTemplateJson(rawOverride);
    if (!parsed) {
      return {
        error:
          I18n.t("节点里的评分标准不是合法 JSON：请修好 body 里的 JSON，或点「恢复模板」回到模板库那一份"),
      };
    }
    const tpl = Object.assign({}, parsed, {
      id: want || "node/override",
      title: String(parsed.title || want || I18n.t("节点内标准")),
      source: "node",
      json: parsed,
    });
    const errs = qaTemplateErrors(tpl, media);
    if (errs.length) {
      return {
        error:
          I18n.t("节点里的评分标准不合法：") + errs.map((e) => e.msg).join("；"),
      };
    }
    return { tpl };
  }
  if (!want) {
    return {
      error:
        "还没有选评分标准：请打开 ⚙ 设置选一份模板（内置模板在 qa-templates/，也可以把自己的 JSON 放进 <数据目录>/qa-templates/ 或 <工程根>/qa/templates/）",
    };
  }
  const hit = tpls.filter((t) => t && t.id === want)[0];
  if (!hit) {
    return { error: "评分标准「" + want + "」找不到了（模板文件可能被删 / 改名），请重新选一份" };
  }
  if (hit.error) return { error: "评分标准「" + (hit.title || hit.id) + "」不可用：" + hit.error };
  const errs = qaTemplateErrors(hit, media);
  if (errs.length) {
    return {
      error: "评分标准「" + (hit.title || hit.id) + "」不合法：" + errs.map((e) => e.msg).join("；"),
    };
  }
  return { tpl: hit };
}

/** 模板的完整快照（写进报告，换模板后仍能复现当时的判据） */
function qaTemplateSnapshot(tpl) {
  if (tpl && tpl.json && typeof tpl.json === "object") return tpl.json;
  return {
    version: (tpl && tpl.version) || 2,
    kind: (tpl && tpl.kind) || "",
    title: (tpl && tpl.title) || "",
    passLine: Number(tpl && tpl.passLine),
    dimensions: ((tpl && tpl.dimensions) || []).map((d) => ({
      id: d.id,
      title: d.title,
      weight: d.weight,
      minScore: d.minScore == null ? null : d.minScore,
      criteria: d.criteria,
    })),
  };
}

/* ── 计分与判定 ───────────────────────────────────────────────────────────── */

function qaScoreRound(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
}

/** 总分 = Σ(维度分 × 权重) / Σ权重，归一到 0–100 */
function qaWeightedScore(scores, tpl) {
  const list = (tpl && tpl.dimensions) || [];
  let sum = 0;
  let wsum = 0;
  for (const d of list) {
    const id = String(d.id || "").trim();
    if (!id) continue;
    const w = Number(d.weight);
    if (!isFinite(w) || w <= 0) continue;
    const got = scores && scores[id];
    if (got == null || !isFinite(Number(got))) continue;
    sum += Number(got) * w;
    wsum += w;
  }
  if (!wsum) return null;
  return Math.round((sum / wsum) * 10) / 10;
}

/** verdict：缺维 → blocked；命中 minScore 硬失败线 → fail；总分 < passLine → fail */
function qaVerdictOf(report, tpl) {
  const list = (tpl && tpl.dimensions) || [];
  const scores = (report && report.scores) || {};
  const missing = list
    .map((d) => String(d.id || ""))
    .filter((id) => id && scores[id] == null);
  if (missing.length) {
    return { verdict: "blocked", why: "这些维度没有给出分数：" + missing.join("、") };
  }
  const hard = list.filter(
    (d) => d.minScore != null && isFinite(Number(scores[d.id])) && Number(scores[d.id]) < Number(d.minScore),
  );
  if (hard.length) {
    return {
      verdict: "fail",
      why:
        "命中维度硬失败线：" +
        hard.map((d) => d.id + " " + scores[d.id] + " < " + d.minScore).join("；"),
    };
  }
  const passLine = Number(tpl && tpl.passLine);
  const score = Number(report && report.score);
  if (!isFinite(score)) return { verdict: "blocked", why: "总分算不出来（没有任何维度分）" };
  if (!isFinite(passLine)) return { verdict: "blocked", why: "模板没有给 passLine" };
  if (score < passLine) return { verdict: "fail", why: "总分 " + score + " < 合格线 " + passLine };
  return { verdict: "pass", why: "总分 " + score + " ≥ 合格线 " + passLine };
}

/* ── Agent 回包解析 ───────────────────────────────────────────────────────── */

function qaStripFence(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

/** 一轮回包 → {tool,args,why} | {final} | {error} */
function qaParseAgentReply(text) {
  const raw = String(text || "").trim();
  if (!raw) return { error: "回包是空的" };
  let o;
  try {
    o = JSON.parse(qaStripFence(raw));
  } catch (e) {
    return { error: "回包不是合法 JSON：" + String((e && e.message) || e) };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "回包必须是 JSON 对象" };
  const action = String(o.action || "").trim().toLowerCase();
  if (action === "tool") {
    const tool = String(o.tool || "").trim();
    if (!tool) return { error: "tool 调用缺少 tool 名" };
    return {
      tool,
      args: o.args && typeof o.args === "object" && !Array.isArray(o.args) ? o.args : {},
      why: String(o.why || ""),
    };
  }
  if (action === "final" || (!action && Array.isArray(o.dimensions))) {
    const dims = Array.isArray(o.dimensions) ? o.dimensions : [];
    if (!dims.length) return { error: "final 里没有 dimensions（每一维都要给分数）" };
    return { final: o };
  }
  return { error: "action 只能是 tool 或 final（收到「" + action + "」）" };
}

function qaDefectsFrom(final) {
  const list = Array.isArray(final && final.defects) ? final.defects : [];
  return list
    .filter((d) => d && typeof d === "object")
    .map((d) => ({
      code: String(d.code || "other").slice(0, 40),
      dim: String(d.dim || "").slice(0, 40),
      desc: String(d.desc || d.description || "").slice(0, 400),
    }))
    .slice(0, 30);
}

function qaFixPlanFrom(final, round) {
  const f = (final && final.fix_plan) || {};
  const strategy = String(
    f.strategy || (final && final.defects && final.defects.length ? "regenerate" : "accept"),
  ).trim();
  const promptDelta = String(f.promptDelta || f.prompt_delta || "").trim();
  const seedRaw = f.nextSeed != null ? f.nextSeed : f.next_seed;
  const nextSeed = isFinite(Number(seedRaw)) ? Math.floor(Number(seedRaw)) : null;
  return { strategy, promptDelta, nextSeed, round };
}

/** 被检对象 id：优先要求里的 shot_id / id，其次文件名，最后节点标题 */
function qaTargetId(node, content, requirement) {
  let id = "";
  const raw = String(requirement || "").trim();
  if (raw && raw[0] === "{") {
    try {
      const o = JSON.parse(raw);
      if (o && (o.shot_id || o.id)) id = String(o.shot_id || o.id);
    } catch (_) {}
  }
  if (!id && content && content.path) {
    id = String(content.path).split(/[\\/]/).pop() || "";
    id = id.replace(/\.[^.]+$/, "");
  }
  if (!id) id = String((node && node.title) || "");
  id = id.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return id || "qa";
}

/* ── Agent prompt ─────────────────────────────────────────────────────────── */

function qaToolDocText() {
  return QA_TOOLS.map((t) => "- " + t.id + "：" + I18n.t(t.desc) + "  参数例：" + t.doc).join("\n");
}

function qaAgentPrompt(node, tpl, ctx, obs) {
  const meta = qaKindMeta(node);
  const snap = qaTemplateSnapshot(tpl);
  const c = ctx.content || {};
  const lines = [];
  lines.push(
    "你是 MTNode 的质检 Agent。你的唯一任务：按下面这份 JSON 评分标准检查被检对象，给出每一维 0–100 的分数、理由与证据，然后收尾。",
  );
  lines.push("");
  lines.push("## 评分标准（唯一判据 · 换标准就是换这份 JSON）");
  lines.push("```json");
  lines.push(JSON.stringify(snap, null, 2));
  lines.push("```");
  lines.push(
    "总分 = Σ(维度得分 × weight) / Σweight，归一到 0–100；合格线 passLine = " +
      String(snap.passLine) +
      "；某维低于自己的 minScore（若有）直接判不合格。",
  );
  lines.push("");
  lines.push("## 被检对象");
  lines.push("- 类型：" + meta.content);
  lines.push("- 路径：" + (c.path || "（无文件，内容在下方正文 / 由工具读取）"));
  if (c.text) {
    const t = String(c.text);
    lines.push("- 正文（" + t.length + " 字符" + (t.length > 8000 ? "，只给前 8000 字，全文用 read 工具读" : "") + "）：");
    lines.push("```");
    lines.push(t.slice(0, 8000));
    lines.push("```");
  }
  if (ctx.probe) {
    const p = ctx.probe;
    const bits = [];
    if (p.durationSec) bits.push("时长 " + Math.round(p.durationSec * 100) / 100 + "s");
    if (p.width && p.height) bits.push("分辨率 " + p.width + "×" + p.height);
    if (p.fps) bits.push("帧率 " + p.fps + "fps");
    if (p.bitrate) bits.push("码率 " + Math.round(Number(p.bitrate) / 1000) + "kbps");
    if (p.blackSpans != null) bits.push("黑帧段 " + p.blackSpans + " 处");
    if (bits.length) {
      lines.push("- 硬件指标（ffprobe 实测，技术维度直接引用）：" + bits.join(" · "));
    }
  }
  if (ctx.requirement) {
    lines.push("");
    lines.push("## 质检要求（用户给出的验收口径，优先于你的主观偏好）");
    lines.push(String(ctx.requirement).slice(0, 6000));
  }
  if (ctx.anchors && ctx.anchors.length) {
    lines.push("");
    lines.push(
      "## 质检要求里的参考样例（与它比对一致性 / 是否照做；它们不是被检对象，是基准）",
    );
    for (const a of ctx.anchors) {
      lines.push("- " + (a.title || "参考") + "：" + (a.path || String(a.text || "").slice(0, 200)));
    }
  }
  const showImgs = !!ctx.canSee && !!(ctx.images && ctx.images.length);
  const sentCount = ctx.imagesSent != null ? ctx.imagesSent : (ctx.images || []).length;
  if (showImgs) {
    lines.push("");
    lines.push(
      "## 随本消息附上的图片（" +
        sentCount +
        " 张" +
        (ctx.imagesNote ? "，" + ctx.imagesNote : "") +
        (ctx.images.length > sentCount
          ? "；参考样例较多，这一轮只带了前 " + sentCount + " 张，其余的用 vision 工具按需看"
          : "") +
        "）",
    );
  } else if (ctx.images && ctx.images.length) {
    /* 服务商没开视觉时主进程不会把图片拼进请求：不能让提示词假装「图已经给你看了」 */
    lines.push("");
    lines.push(
      "## 注意：当前服务商没有开启视觉（vision），图片不会随本消息下发。要看画面请调用 vision 工具；工具同样看不到时如实说明缺证据，不要凭文件名 / 标题猜内容。",
    );
  }
  lines.push("");
  lines.push("## 你可以用的工具（只能用这些；用不了就说明缺什么，不要假装看过）");
  lines.push(qaToolDocText());
  lines.push("");
  lines.push("## 取证要求（先看再判，没看到的不要给分）");
  lines.push("- 视频：先 probe 读时长 / 分辨率 / 帧率，再 frames 抽几帧看画面；音频：先 transcribe 看台词再判。");
  lines.push(
    showImgs
      ? "- 图像：看随消息附上的原图，或对疑点调 vision 细看。"
      : "- 图像：用 vision 工具看图；看不到就如实说明缺证据。",
  );
  lines.push("- 文本 / 文件：read / grep 读到原文再判，长文件分段读。");
  lines.push("");
  lines.push("## 回复协议（每轮只回一个 JSON 对象，不要解释、不要代码围栏）");
  lines.push('调用工具：{"action":"tool","tool":"frames","args":{"count":6},"why":"抽几帧看动作"}');
  const dimIds = (snap.dimensions || []).map((d) => String((d && d.id) || "").trim()).filter(Boolean);
  const exDims = (dimIds.length ? dimIds : ["维度id"]).slice(0, 2).map(
    (id) =>
      '{"id":' +
      JSON.stringify(id) +
      ',"score":82,"reason":"一句话说清依据","evidence":["t=1.2s 画面里…"]}',
  );
  lines.push(
    '给出结论：{"action":"final","dimensions":[' +
      exDims.join(",") +
      '],"defects":[{"code":"other","dim":"' +
      (dimIds[0] || "维度id") +
      '","desc":"…"}],"fix_plan":{"strategy":"regenerate","promptDelta":"给生成节点的提示词补丁","nextSeed":123},"notes":"一句总结"}',
  );
  if (dimIds.length) {
    lines.push("维度 id 只能取这些（逐字照抄，不要自创、不要漏维）：" + dimIds.join(" / "));
  }
  lines.push(
    "规则：dimensions 的 id 必须与上面评分标准里的 id 一一对应、每维都要有 score（0–100 的整数）；没看过画面 / 没读到内容就不要给分；证据要具体到文件、帧时间点或原文片段。",
  );
  if (obs && obs.length) {
    lines.push("");
    lines.push("## 已经收集到的证据（按时间顺序）");
    for (const o of obs) lines.push(o);
  }
  return lines.join("\n");
}

/* ── 工具执行（全部走宿主已有能力，不另起实现）───────────────────────────── */

function qaAbsPath(p) {
  const s = String(p || "").trim();
  return s;
}

function qaCapText(t, n) {
  const s = String(t == null ? "" : t);
  const lim = Math.max(200, Number(n) || 12000);
  return s.length > lim ? s.slice(0, lim) + "\n…（已截断，共 " + s.length + " 字符）" : s;
}

function qaStripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function qaToolRead(args) {
  const api = window.api;
  const p = qaAbsPath(args.path);
  if (!p) return { text: "read 需要 path（绝对路径）" };
  const r = await api.fileReadText(p);
  if (!r || r.exists === false) return { text: "读不到文件：" + p };
  const off = Math.max(0, Math.floor(Number(args.offset) || 0));
  const lim = Math.max(200, Math.min(40000, Math.floor(Number(args.limit) || 12000)));
  const all = String(r.content || "");
  const slice = all.slice(off, off + lim);
  return {
    text:
      "文件 " +
      p +
      "（共 " +
      all.length +
      " 字符，本次 " +
      off +
      "–" +
      (off + slice.length) +
      "）：\n" +
      slice,
  };
}

async function qaToolList(args) {
  const api = window.api;
  const p = qaAbsPath(args.path);
  if (!p) return { text: "list 需要 path（绝对路径）" };
  const r = await api.fileReadDir(p);
  if (!r || !r.ok) return { text: "列目录失败：" + ((r && r.error) || "无回执") };
  const items = (r.list || []).slice(0, 200);
  if (!items.length) return { text: "目录是空的：" + p };
  return {
    text:
      "目录 " +
      p +
      "（" +
      items.length +
      " 项）：\n" +
      items
        .map((it) => (it.isDir ? "[D] " : "[F] ") + it.name + (it.isDir ? "" : "  " + (it.size || 0) + "B"))
        .join("\n"),
  };
}

async function qaToolGrep(args) {
  const api = window.api;
  const pattern = String(args.pattern || "").trim();
  if (!pattern) return { text: "grep 需要 pattern（正则）" };
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch (e) {
    return { text: "正则写错了：" + String((e && e.message) || e) };
  }
  const base = qaAbsPath(args.path);
  if (!base) return { text: "grep 需要 path（目录或文件）" };
  const files = [];
  const isFile = /\.\w{1,6}$/.test(base);
  if (isFile) files.push(base);
  else {
    const r = await api.fileListDir(base);
    if (!r || !r.ok) return { text: "列目录失败：" + ((r && r.error) || "无回执") };
    for (const it of r.list || []) {
      if (it.isDir) continue;
      if (!/\.(txt|md|markdown|json|ya?ml|csv|tsv|srt|vtt|js|mjs|cjs|ts|tsx|jsx|py|html?|xml|log|ini|toml)$/i.test(it.name))
        continue;
      files.push(base.replace(/[\\/]+$/, "") + "/" + it.rel);
      if (files.length >= 60) break;
    }
  }
  const hits = [];
  for (const f of files) {
    const rd = await api.fileReadText(f);
    if (!rd || rd.exists === false) continue;
    const lines = String(rd.content || "").split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < 60; i++) {
      if (re.test(lines[i])) hits.push(f + ":" + (i + 1) + ": " + lines[i].slice(0, 240));
    }
    if (hits.length >= 60) break;
  }
  if (!hits.length) return { text: "没有命中（扫了 " + files.length + " 个文本文件）" };
  return { text: "命中 " + hits.length + " 处：\n" + hits.join("\n") };
}

async function qaToolProbe(args) {
  const api = window.api;
  const p = qaAbsPath(args.path);
  if (!p) return { text: "probe 需要 path" };
  if (!api.qaProbe) return { text: "本机没有 probe 桥" };
  const r = await api.qaProbe({ path: p });
  if (!r || !r.ok) return { text: "读媒体指标失败：" + ((r && r.error) || "无回执") };
  return { text: "媒体指标：\n" + JSON.stringify(r, null, 2) };
}

async function qaToolFrames(args, ctx) {
  const api = window.api;
  const p = qaAbsPath(args.path) || (ctx.content && ctx.content.path) || "";
  if (!p) return { text: "frames 需要 path（视频路径）" };
  if (!api.qaFrames) return { text: "本机没有抽帧桥" };
  let times = Array.isArray(args.times)
    ? args.times.map((x) => Number(x)).filter((x) => isFinite(x) && x >= 0).slice(0, 12)
    : [];
  if (!times.length) {
    let dur = 0;
    if (api.qaProbe) {
      const pr = await api.qaProbe({ path: p });
      if (pr && pr.ok) dur = Number(pr.durationSec) || 0;
    }
    const count = Math.max(1, Math.min(12, Math.round(Number(args.count) || 6)));
    if (api.qaFrameTimes && dur > 0) {
      const tt = await api.qaFrameTimes({ durationSec: dur, count });
      if (tt && tt.ok) times = tt.times || [];
    }
    if (!times.length) return { text: "抽帧失败：读不到时长，请直接给 times（秒）" };
  }
  const r = await api.qaFrames({ path: p, times });
  if (!r || !r.ok) return { text: "抽帧失败：" + ((r && r.error) || "无回执") };
  const frames = r.frames || [];
  const imgs = frames.map((f) => f.path).filter(Boolean);
  for (const img of imgs) if (ctx.images.indexOf(img) < 0 && ctx.extraImages.indexOf(img) < 0) ctx.extraImages.push(img);
  return {
    text:
      "抽了 " +
      frames.length +
      " 帧（下一轮会一起给你看）：\n" +
      frames.map((f) => "- t=" + f.t + "s → " + f.path).join("\n"),
    images: imgs,
  };
}

async function qaToolVision(args, ctx) {
  const api = window.api;
  const paths = (Array.isArray(args.paths) ? args.paths : args.path ? [args.path] : [])
    .map(qaAbsPath)
    .filter(Boolean)
    .slice(0, 6);
  if (!paths.length) return { text: "vision 需要 paths（1–6 张图片的绝对路径）" };
  const q = String(args.question || "").trim() || "仔细描述这张图里与质检标准相关的可见事实（主体、文字、瑕疵）";
  const img = paths.concat(ctx.anchors.map((a) => a.path).filter(Boolean)).slice(0, 8);
  const pk = qaModelOf(ctx.node);
  if (!pk.prov) return { text: "看图失败：本节点还没有可用的服务商（⚙ 里选一家）" };
  let rr;
  try {
    rr = await api.apiCall({
      provider: pk.prov,
      model: pk.model,
      kind: "text",
      prompt: q,
      images: img,
      texts: [],
      temperature: 0.1,
      effort: (ctx.cfg && ctx.cfg.effort) || "high",
    });
  } catch (e) {
    return { text: "看图失败：" + String((e && e.message) || e) };
  }
  if (!rr || !rr.ok) return { text: "看图失败：" + ((rr && rr.error) || "无回执") };
  return { text: "视觉模型看 " + paths.length + " 张图后回答：\n" + qaCapText(rr.text, 6000) };
}

async function qaToolTranscribe(args) {
  const api = window.api;
  const p = qaAbsPath(args.path) || "";
  if (!p) return { text: "transcribe 需要 path（音频 / 视频）" };
  if (typeof spTranscribeFile !== "function") return { text: "转写模块未加载（renderer/app-speech.js）" };
  const r = await spTranscribeFile(p, { language: String(args.language || "auto") });
  if (!r || !r.ok) return { text: "转写失败：" + ((r && r.message) || (r && r.error) || "无回执") };
  return {
    text:
      "转写完成（" +
      (r.segments || 0) +
      " 句 / " +
      Math.round(Number(r.durationSec) || 0) +
      " 秒" +
      (r.cached ? " · 命中缓存" : "") +
      "）：\n" +
      qaCapText(r.text, 12000),
  };
}

async function qaToolPdf(args) {
  const api = window.api;
  const p = qaAbsPath(args.path);
  if (!p) return { text: "pdf 需要 path" };
  if (!api.fileParsePdf) return { text: "PDF 解析桥未就绪" };
  const r = await api.fileParsePdf({ path: p });
  if (!r || !r.ok) return { text: "PDF 解析失败：" + ((r && r.error) || "无回执") };
  return { text: "PDF 文本层（Markdown）：\n" + qaCapText(r.markdown || r.text || "", 16000) };
}

async function qaToolWeb(args) {
  const api = window.api;
  if (!api.netFetch) return { text: "联网桥未就绪" };
  const url = String(args.url || "").trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) return { text: "url 必须是 http(s) 地址" };
    const r = await api.netFetch(url);
    if (!r || !r.ok) return { text: "抓取失败：" + ((r && r.error) || "无回执") };
    return { text: "网页 " + url + " 正文（已去标签）：\n" + qaCapText(qaStripTags(r.text), 8000) };
  }
  const q = String(args.query || "").trim();
  if (!q) return { text: "web 需要 query 或 url" };
  const r = await api.netFetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q));
  if (!r || !r.ok) return { text: "搜索失败：" + ((r && r.error) || "无回执") };
  const html = String(r.text || "");
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    let href = String(m[1] || "");
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch (_) {}
    }
    out.push("- " + qaStripTags(m[2]) + "\n  " + href);
  }
  if (!out.length) return { text: "搜索没有解析出结果（可以直接用 url 抓具体页面）" };
  return { text: "搜索结果（DuckDuckGo · " + q + "）：\n" + out.join("\n") };
}

async function qaToolShell(args) {
  const api = window.api;
  const cmd = String(args.command || "").trim();
  if (!cmd) return { text: "shell 需要 command" };
  const runId = "qa-shell-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const isWin = /^win/i.test(String(navigator.platform || "")) || /\r?\n/.test("\r\n");
  const spec = isWin
    ? {
        cmd: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", cmd],
        cwd: args.cwd ? qaAbsPath(args.cwd) : undefined,
        runId,
        wait: true,
        outputLimit: 40000,
      }
    : { cmd: "/bin/sh", args: ["-lc", cmd], cwd: args.cwd ? qaAbsPath(args.cwd) : undefined, runId, wait: true };
  let timedOut = false;
  let timer = null;
  const race = new Promise((resolve) => {
    timer = setTimeout(async () => {
      timedOut = true;
      try {
        await api.procKillRun(runId);
      } catch (_) {}
      resolve({ ok: false, error: "命令超过 180 秒，已终止" });
    }, 180000);
  });
  let r;
  try {
    r = await Promise.race([api.procRun(spec), race]);
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!r || !r.ok) return { text: "命令执行失败：" + ((r && r.error) || (timedOut ? "超时" : "无回执")) };
  return {
    text:
      "命令退出码 " +
      r.code +
      "\n--- stdout ---\n" +
      qaCapText(r.stdout, 12000) +
      "\n--- stderr ---\n" +
      qaCapText(r.stderr, 6000),
  };
}

async function qaToolWrite(args) {
  const api = window.api;
  const p = qaAbsPath(args.path);
  if (!p) return { text: "write 需要 path" };
  const content = String(args.content == null ? "" : args.content);
  if (content.length > 2 * 1024 * 1024) return { text: "内容太大（>2MB），拒绝写入" };
  const r = await api.fileWriteText(p, content);
  if (!r || !r.ok) return { text: "写文件失败：" + ((r && r.error) || "无回执") };
  return { text: "已写入 " + p + "（" + content.length + " 字符）" };
}

/** 执行一次工具；返回 {text, images?, denied?}。工具恒开，没有逐项开关。 */
async function qaRunTool(node, cfg, name, args, ctx) {
  const tool = String(name || "").trim();
  if (QA_TOOL_IDS.indexOf(tool) < 0) {
    return { text: "没有这个工具：" + tool + "。可用：" + QA_TOOL_IDS.join(" / ") };
  }
  try {
    if (tool === "read") return await qaToolRead(args);
    if (tool === "list") return await qaToolList(args);
    if (tool === "grep") return await qaToolGrep(args);
    if (tool === "vision") return await qaToolVision(args, ctx);
    if (tool === "probe") return await qaToolProbe(args);
    if (tool === "frames") return await qaToolFrames(args, ctx);
    if (tool === "transcribe") return await qaToolTranscribe(args);
    if (tool === "pdf") return await qaToolPdf(args);
    if (tool === "web") return await qaToolWeb(args);
    if (tool === "shell") return await qaToolShell(args);
    if (tool === "write") return await qaToolWrite(args);
  } catch (e) {
    return { text: "工具 " + tool + " 抛错：" + String((e && e.message) || e) };
  }
  return { text: "工具 " + tool + " 没有实现" };
}

/* ── 多轮 Agent 循环（不设轮数上限、不设超时；只能手动停止）───────────────── */

const QA_OBS_KEEP = 24;

async function qaAgentLoop(node, tpl, ctx) {
  const api = window.api;
  const cfg = ctx.cfg;
  const obs = [];
  const toolsUsed = [];
  const images = (ctx.images || []).slice(0, 8);
  let turns = 0;
  let parseFails = 0;
  let lastRaw = "";
  let repeatKey = "";
  let repeatCount = 0;

  for (;;) {
    if (node._aborted) {
      return { error: "已手动停止", turns, toolsUsed, transcript: obs };
    }
    turns += 1;
    if (turns > 1 && node.running) node.qaTurns = turns;
    const ctx2 = ctx;
    const sendImages = images.concat(ctx.extraImages).filter((p, i, arr) => arr.indexOf(p) === i).slice(0, 8);
    /* 样例不设条数上限，但一次请求能带的图有物理上限：只把「这一轮实际带上几张」告诉模型，
       剩下的样例它可以用 vision 工具按需看 */
    ctx2.imagesSent = sendImages.length;
    const prompt = qaAgentPrompt(node, tpl, ctx, obs);
    const pick = qaModelOf(node);
    if (!pick.prov || !pick.model) {
      return {
        error: "模型调用失败：本节点没有可用的服务商 / 模型（⚙ 里重新选一次）",
        turns,
        toolsUsed,
        transcript: obs,
      };
    }
    let rr;
    try {
      rr = await api.apiCall({
        provider: pick.prov,
        model: pick.model,
        kind: "text",
        prompt,
        images: sendImages,
        texts: [],
        temperature: 0.2,
        /* 思考强度（⚙ 可调，默认「无」）：默认不开思考，用户想要逐维细抠可在 ⚙ 升档 */
        effort: cfg.effort,
      });
    } catch (e) {
      return {
        error: "模型调用失败：" + String((e && e.message) || e),
        turns,
        toolsUsed,
        transcript: obs,
      };
    }
    if (!rr || !rr.ok) {
      return {
        error: "模型调用失败：" + ((rr && rr.error) || "无回执"),
        turns,
        toolsUsed,
        transcript: obs,
      };
    }
    lastRaw = String(rr.text || "");
    const parsed = qaParseAgentReply(lastRaw);
    if (parsed.error) {
      parseFails += 1;
      obs.push("（第 " + turns + " 轮 · 回包不可解析）" + parsed.error);
      if (parseFails >= 3) {
        return {
          error: "模型连续 3 次回包无法解析：" + parsed.error,
          turns,
          toolsUsed,
          transcript: obs,
          raw: lastRaw,
        };
      }
      obs.push("请只回一个 JSON 对象（tool 或 final），不要任何解释文字。");
      continue;
    }
    parseFails = 0;

    if (parsed.final) {
      const f = parsed.final;
      const scores = {};
      const dims = [];
      const given = {};
      for (const d of Array.isArray(f.dimensions) ? f.dimensions : []) {
        if (!d || typeof d !== "object") continue;
        given[String(d.id || "").trim()] = d;
      }
      for (const d of (tpl.dimensions || [])) {
        const id = String(d.id || "").trim();
        const got = given[id];
        if (!got) continue;
        const score = qaScoreRound(got.score);
        if (score == null) continue;
        scores[id] = score;
        dims.push({
          id,
          title: d.title || id,
          weight: Number(d.weight) || 0,
          minScore: d.minScore == null ? null : Number(d.minScore),
          score,
          reason: String(got.reason || "").slice(0, 800),
          evidence: (Array.isArray(got.evidence) ? got.evidence : []).map((x) => String(x).slice(0, 300)).slice(0, 8),
        });
      }
      return {
        scores,
        dimensions: dims,
        defects: qaDefectsFrom(f),
        fix_plan: qaFixPlanFrom(f, 0),
        notes: String(f.notes || "").slice(0, 1200),
        turns,
        toolsUsed,
        transcript: obs,
        raw: lastRaw,
      };
    }

    /* 工具轮：同一调用反复出现只提示、不中止（不设轮数上限是明面上的约定） */
    const key = parsed.tool + "|" + JSON.stringify(parsed.args || {});
    if (key === repeatKey) repeatCount += 1;
    else {
      repeatKey = key;
      repeatCount = 1;
    }
    if (repeatCount === 4) {
      obs.push("（提醒）同样的工具调用已经第 " + repeatCount + " 次了；如果证据够了就回 final，或换个参数拿到新证据。");
    }
    toolsUsed.push(parsed.tool);
    const out = await qaRunTool(node, cfg, parsed.tool, parsed.args || {}, ctx);
    const head =
      "（第 " +
      turns +
      " 轮 · 工具 " +
      parsed.tool +
      (parsed.why ? " · " + parsed.why : "") +
      "）";
    obs.push(head + "\n" + qaCapText(out.text, 9000));
    while (obs.length > QA_OBS_KEEP) obs.shift();
    if (node._aborted) {
      return { error: "已手动停止", turns, toolsUsed, transcript: obs };
    }
  }
}

/* ── 报告落盘 / manifest 回写 ─────────────────────────────────────────────── */

function qaRootOf() {
  if (typeof mfRootOf !== "function") return { error: "manifest 模块未加载（app-manifest.js）" };
  return mfRootOf(null, "");
}

async function qaWriteReport(node, report) {
  const root = qaRootOf();
  if (root.error) return { ok: false, error: root.error };
  const api = window.api;
  if (!api || typeof api.qaWriteReport !== "function") {
    return { ok: false, error: "报告桥未就绪（preload 未加载 qaWriteReport）" };
  }
  const r = await api.qaWriteReport({
    root: root.root,
    shotId: report.shot_id,
    round: Number(report.round) || 0,
    report,
  });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "写报告失败" };
  report.report_path = r.rel;
  return { ok: true, rel: r.rel, path: r.path };
}

async function qaWriteManifest(node, report) {
  if (typeof mfCall !== "function") return { ok: false, error: "manifest 桥未加载" };
  if (report.verdict !== "pass" && report.verdict !== "fail") return { ok: false, skipped: true };
  const root = qaRootOf();
  if (root.error) return { ok: false, error: root.error };
  const r = await mfCall(root.root, "qa_set", {
    id: report.shot_id,
    verdict: report.verdict,
    report: report.report_path || "",
    round: Number(report.round) || 0,
  });
  /* 非镜头类对象（文本 / 音频 / 文件）语义工程里没有这条 shot：静默跳过，不当失败 */
  return r || { ok: false, error: "manifest 无回执" };
}

/* ── 一次判定 ─────────────────────────────────────────────────────────────── */

async function qaPrepareImages(node, cfg, content, anchors) {
  const api = window.api;
  const images = [];
  let frames = [];
  let probe = null;
  let imagesNote = "";
  if (content.kind === "video") {
    if (!api.qaProbe) return { error: "抽帧桥未就绪（preload 未加载 qaProbe）" };
    const pr = await api.qaProbe({ path: content.path });
    if (!pr || !pr.ok) {
      return { error: "读视频硬指标失败：" + ((pr && pr.error) || "本机没有可用的 ffmpeg") };
    }
    probe = pr;
    const tt = api.qaFrameTimes
      ? await api.qaFrameTimes({ durationSec: pr.durationSec, count: cfg.frames })
      : { ok: false, error: "取时间点桥未就绪" };
    if (!tt || !tt.ok) return { error: (tt && tt.error) || "取抽帧时间点失败" };
    const fr = await api.qaFrames({ path: content.path, times: tt.times || [] });
    if (!fr || !fr.ok) return { error: "抽帧失败：" + ((fr && fr.error) || "无回执") };
    frames = fr.frames || [];
    for (const f of frames) images.push(f.path);
    imagesNote = "视频按时间点均匀抽了 " + frames.length + " 帧";
  } else if (content.kind === "image" && content.path) {
    images.push(content.path);
    imagesNote = "原图";
  }
  const anchorImgs = anchors.filter((a) => a.path && a.kind === "image").map((a) => a.path);
  for (const p of anchorImgs) images.push(p);
  return { images, frames, probe, imagesNote, anchorImgs };
}

async function qaRunOnce(node, tpl, content, requirement, anchors, round) {
  const api = window.api;
  const cfg = qaCfg(node);
  /* 实际使用的服务商 / 模型（node.model 空着时已在这里回填，报告与请求都按它走） */
  const pick = qaModelOf(node);
  const targetId = qaTargetId(node, content, requirement);
  const report = {
    schema: 2,
    kind: qaKindMeta(node).media,
    shot_id: targetId,
    target_id: targetId,
    verdict: "blocked",
    verdict_why: "",
    round,
    at: new Date().toISOString(),
    engine: {
      provider: String(pick.provider || ""),
      model: String(pick.model || ""),
      effort: cfg.effort,
      template: String((tpl && tpl.id) || ""),
      template_title: String((tpl && tpl.title) || ""),
    },
    content: {
      kind: content.kind,
      path: content.path || "",
      chars: content.text ? String(content.text).length : 0,
    },
    media: { path: content.path || "", kind: content.kind },
    criteria: qaTemplateSnapshot(tpl),
    passLine: Number(tpl && tpl.passLine),
    scores: {},
    dimensions: [],
    score: null,
    score01: null,
    defects: [],
    fix_plan: {},
    notes: "",
    references: anchors.map((a) => ({ title: a.title, path: a.path || "", kind: a.kind })),
    tools_used: [],
    turns: 0,
    frames: [],
    probe: null,
  };

  const prep = await qaPrepareImages(node, cfg, content, anchors);
  if (prep.error) return { report, error: prep.error };
  report.probe = prep.probe || null;
  report.frames = prep.frames || [];

  /* 上游生成节点只记进报告（留痕）并参与反自评检查 —— 质检节点不据此重跑任何人 */
  const gens = qaUpstreamGensOf(node);
  if (gens.length) {
    report.upstream = gens.map((g) => ({
      id: g.id,
      kind: g.kind,
      provider: String(g.providerId || ""),
      model: String(g.model || ""),
    }));
  }
  const self = qaSelfReview(node, gens);
  if (self) return { report, error: self };

  const ctx = {
    node,
    cfg,
    content,
    requirement,
    anchors,
    images: prep.images || [],
    extraImages: [],
    imagesNote: prep.imagesNote || "",
    canSee: pick.canSee,
    /* 视频硬指标已经由 ffprobe 读过：直接给模型，省一轮工具调用，也让技术维度有据可依 */
    probe: prep.probe || null,
  };
  const out = await qaAgentLoop(node, tpl, ctx);
  report.turns = out.turns || 0;
  report.tools_used = out.toolsUsed || [];
  report.transcript = (out.transcript || []).slice(-20);
  report.raw = String(out.raw || "").slice(0, 6000);
  if (out.error) {
    report.verdict = "blocked";
    report.verdict_why = out.error;
    report.notes = out.error;
    return { report, error: out.error };
  }
  report.scores = out.scores || {};
  report.dimensions = out.dimensions || [];
  report.defects = out.defects || [];
  report.fix_plan = out.fix_plan || {};
  report.notes = out.notes || "";
  const score = qaWeightedScore(report.scores, tpl);
  report.score = score;
  report.score01 = score == null ? null : Math.round((score / 100) * 1000) / 1000;
  const vd = qaVerdictOf(report, tpl);
  report.verdict = vd.verdict;
  report.verdict_why = vd.why;
  return { report };
}

/* ── 人工裁决（不再自动弹：fail 后由节点上的按钮按需打开）───────────────── */

/* 评分表：低于合格线 / 低于自己 minScore 的维度标红并注明 */
function qaScoreRows(report, passLine) {
  const pass = Number(passLine);
  const rows = [];
  for (const d of report.dimensions || []) {
    const v = Number(d.score);
    const low =
      (isFinite(pass) && isFinite(v) && v < pass) ||
      (d.minScore != null && isFinite(v) && v < Number(d.minScore));
    rows.push(
      '<tr><td style="padding:2px 8px 2px 0;color:#9aa4b2">' +
        String(d.id || "") +
        "（" +
        String(d.title || "") +
        "）</td><td" +
        (low ? ' style="color:#ff8a8a;font-weight:600"' : "") +
        ">" +
        (isFinite(v) ? v.toFixed(1) : "—") +
        (low
          ? " · " +
            I18n.t("低于合格线") +
            (d.minScore != null ? I18n.t("（硬失败线 ") + d.minScore + "）" : "")
          : "") +
        "</td></tr>",
    );
  }
  return rows.join("");
}

function qaAskHuman(node, report) {
  return new Promise((resolve) => {
    if (typeof openOverlay !== "function") {
      resolve("giveUp");
      return;
    }
    openOverlay(I18n.t("质检未通过 · 需人工裁决"), { persistent: true, min: false });
    const body = document.getElementById("ovBody");
    const foot = document.getElementById("ovFoot");
    if (!body || !foot) {
      resolve("giveUp");
      return;
    }
    const head = document.createElement("div");
    head.style.cssText = "font-size:12.5px;line-height:1.5;color:#e6e9ee;margin-bottom:8px";
    head.textContent =
      (node.title || node.kind) +
      " · " +
      (report.shot_id || "") +
      " · " +
      I18n.t("第 ") +
      (report.round || 1) +
      I18n.t(" 轮 · ") +
      I18n.t(String(report.verdict_why || report.verdict || ""));
    body.appendChild(head);
    const sum = document.createElement("div");
    sum.style.cssText = "font-size:12px;color:#b9c2ce;margin-bottom:8px";
    sum.textContent =
      I18n.t("总分 ") +
      (report.score == null ? "—" : report.score) +
      " / " +
      I18n.t("合格线 ") +
      report.passLine +
      " · " +
      I18n.t("标准：") +
      (report.engine && report.engine.template_title ? report.engine.template_title : "");
    body.appendChild(sum);
    const table = document.createElement("table");
    table.style.cssText = "font-size:12px;margin-bottom:8px";
    table.innerHTML = qaScoreRows(report, report.passLine);
    body.appendChild(table);
    const defects = (report.defects || []).slice(0, 6);
    if (defects.length) {
      const ul = document.createElement("ul");
      ul.style.cssText = "margin:0 0 8px 18px;padding:0;font-size:12px;line-height:1.6;color:#f0b3b3";
      for (const d of defects) {
        const li = document.createElement("li");
        li.textContent = "[" + (d.code || "other") + "] " + (d.desc || "");
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }
    const plan = report.fix_plan || {};
    const tip = document.createElement("div");
    tip.style.cssText = "font-size:12px;line-height:1.6;color:#b9c2ce;white-space:pre-wrap";
    tip.textContent =
      I18n.t("修复建议：") +
      (plan.strategy || "regenerate") +
      (plan.promptDelta ? "\n" + I18n.t("提示词补丁：") + plan.promptDelta : "") +
      (report.report_path ? "\n" + I18n.t("报告：") + report.report_path : "");
    body.appendChild(tip);
    const note = document.createElement("div");
    note.style.cssText = "font-size:11.5px;line-height:1.6;color:#8b94a3;margin-top:8px";
    note.textContent = I18n.t(
      "质检节点只判不返工：接受 = 报告记 manualOverride 并转「通过」，不会重跑上游、也不会触发下游；要让上游重做请自己在画布上重跑生成节点。",
    );
    body.appendChild(note);

    const done = (outcome) => {
      try {
        if (typeof closeOverlay === "function") closeOverlay();
      } catch (_) {}
      resolve(outcome);
    };
    const mk = (label, outcome, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = primary ? "mini primary" : "mini";
      b.textContent = label;
      b.onclick = () => done(outcome);
      foot.appendChild(b);
    };
    mk(I18n.t("接受（人工放行）"), "accept", true);
    mk(I18n.t("放弃（判失败）"), "giveUp");
  });
}

/** 节点上的「人工裁决」按钮：从节点当前报告打开裁决卡（fail 后不再自动弹卡） */
async function qaOpenVerdict(node) {
  if (!node || !isQaKind(node)) return;
  let report = null;
  try {
    report = JSON.parse(String((node.output && node.output.text) || ""));
  } catch (_) {
    report = null;
  }
  if (!report || !report.verdict) {
    toast(I18n.t("这颗节点还没有质检报告：先点 ▶ 跑一次"), "warn");
    return;
  }
  const answer = await qaAskHuman(node, report);
  if (answer !== "accept") {
    node.error = I18n.t("质检未通过，已放弃该对象");
    if (typeof renderCanvas === "function") renderCanvas();
    return;
  }
  /* 接受：只改报告与节点状态，不重触发下游（下游已经按「未过」跑过了） */
  report.verdict = "pass";
  report.manualOverride = { by: "user", at: new Date().toISOString(), from: "fail" };
  report.verdict_why = I18n.t("人工放行");
  const w = await qaWriteReport(node, report);
  const wm = await qaWriteManifest(node, report);
  qaSetNodeState(node, report);
  node.output = { kind: "text", text: JSON.stringify(report, null, 2) };
  /* 报告 JSON 就是 0 号输出端子的值：跑完立刻落盘，重开画布后「报告」端子仍有内容 */
  if (typeof scheduleSave === "function") scheduleSave();
  node.taskStatus = "";
  node.error = null;
  if (typeof renderCanvas === "function") renderCanvas();
  if (w && w.ok) toast(I18n.t("已人工放行（报告已记录 override）"), "ok");
  else toast(I18n.t("已人工放行，但报告写入失败：") + ((w && w.error) || "未知错误"), "warn");
  return wm;
}

/* ── 执行体 ───────────────────────────────────────────────────────────────── */

function qaSetNodeState(node, report) {
  node.qa = {
    shot_id: report.shot_id,
    kind: report.kind,
    verdict: report.verdict,
    round: Number(report.round) || 0,
    score: report.score,
    passLine: report.passLine,
    scores: report.scores || {},
    defects: (report.defects || []).length,
    /* 逐项结果（项 / 分数 / 原因）：body 里那份 JSON 报告要按项上色，
       0 号输出丢了也能画出来，所以这里存一份精简的 */
    dimensions: (report.dimensions || []).map((d) => ({
      id: d.id,
      title: d.title,
      score: d.score,
      minScore: d.minScore == null ? null : d.minScore,
      reason: d.reason,
    })),
    template: (report.engine && report.engine.template) || "",
    report_path: report.report_path || "",
    at: report.at || "",
  };
  node.qaVerdict = report.verdict;
}

/* 置错 + 立刻重绘：节点 body 是渲染出来的，不重绘就只剩上一版文字 ——
   点了 ▶ 却「看起来什么也没发生」是最难受的一种失败。 */
function qaBlocked(node, msg, quiet) {
  node.error = msg;
  node.taskStatus = "blocked";
  node.qaVerdict = "blocked";
  if (!quiet) toast(msg, "warn");
  if (typeof renderCanvas === "function") renderCanvas();
}

function qaContentError(node, content) {
  const meta = qaKindMeta(node);
  if (!content) {
    return (
      "输入端 0 没有内容：请把要检查的" +
      meta.tag +
      "（节点输出或文件）连进来"
    );
  }
  if (meta.media === "file") return "";
  if (meta.media === "text") {
    if (content.kind === "text" || content.path) return "";
    return "输入端 0 接的是 " + content.kind + "，文本质检需要文本或文本文件";
  }
  if (content.kind !== meta.media) {
    return (
      "输入端 0 接的是 " +
      content.kind +
      "，但这是" +
      meta.label +
      "（需要 " +
      meta.media +
      "）"
    );
  }
  return "";
}

async function playQaNode(node, quiet) {
  const cfg = qaCfg(node);
  node.error = null;
  node.qa = null;
  node.qaVerdict = "";
  node.qaTurns = 0;
  node.output = null;

  const content = qaContentOf(node);
  const contentErr = qaContentError(node, content);
  if (contentErr) {
    qaBlocked(node, contentErr, quiet);
    return { verdict: "blocked", report: null };
  }
  const pick = qaModelOf(node);
  if (!pick.provider) {
    qaBlocked(
      node,
      I18n.t("没有选质检模型：请在节点 ⚙ 设置里指定服务商与模型（要能看图就选视觉模型）"),
      quiet,
    );
    return { verdict: "blocked", report: null };
  }
  if (!pick.prov) {
    qaBlocked(
      node,
      I18n.t("质检节点的服务商在本机已不存在：请在节点 ⚙ 设置里重新选一家（原服务商可能被删掉了）"),
      quiet,
    );
    return { verdict: "blocked", report: null };
  }
  if (!String(pick.prov.baseUrl || "").trim()) {
    qaBlocked(
      node,
      I18n.t("服务商「{name}」还没填接口地址：请在「设置 · API/配置」里补上，再运行质检", {
        name: pick.prov.name || pick.provider,
      }),
      quiet,
    );
    return { verdict: "blocked", report: null };
  }
  if (!pick.model) {
    qaBlocked(
      node,
      I18n.t("服务商「{name}」在本机没有可用的文本模型：请在设置 · 模型服务里补上模型，或换一家服务商（要能看图就选视觉模型）", {
        name: (pick.prov && pick.prov.name) || pick.provider,
      }),
      quiet,
    );
    return { verdict: "blocked", report: null };
  }
  const root = qaRootOf();
  if (root.error) {
    qaBlocked(node, I18n.t("工程目录不可用：") + root.error, quiet);
    return { verdict: "blocked", report: null };
  }
  const list = await qaTemplateList(root.root, false);
  if (!list.ok) {
    qaBlocked(node, I18n.t("读评分标准失败：") + list.error, quiet);
    return { verdict: "blocked", report: null };
  }
  const resolved = qaTemplateResolve(node, list);
  if (resolved.error) {
    qaBlocked(node, resolved.error, quiet);
    return { verdict: "blocked", report: null };
  }
  const tpl = resolved.tpl;

  const req = qaRequirementOf(node);
  const requirement = req.text;
  const anchors = req.refs || [];

  /* 只跑一轮：质检节点只判，不重跑上游、不自动弹卡（重做上游是用户自己的事） */
  const run = await qaRunOnce(node, tpl, content, requirement, anchors, 1);
  const report = run.report;
  report.round = 1;
  const lastError = run.error || "";
  if (lastError) report.verdict = "blocked";

  const w = await qaWriteReport(node, report);
  if (!w.ok) {
    qaBlocked(node, I18n.t("质检报告写不进去：") + w.error, quiet);
    return { verdict: "blocked", report };
  }
  await qaWriteManifest(node, report);
  qaSetNodeState(node, report);
  node.output = { kind: "text", text: JSON.stringify(report, null, 2) };
  /* 同上：报告 / 判定两个数据端子直接读 node.output，跑完就落盘，别等用户下一次编辑 */
  if (typeof scheduleSave === "function") scheduleSave();

  if (report.verdict === "pass") {
    node.taskStatus = "";
    node.error = null;
    if (!quiet) {
      toast(I18n.t("质检通过：") + (report.shot_id || "") + " · " + report.score + " 分", "ok");
    }
    if (typeof renderCanvas === "function") renderCanvas();
    return { verdict: "pass", report };
  }

  if (report.verdict === "fail") {
    /* 未过：置「需干涉」并走「未过」控制出；放行入口是节点上的「人工裁决」按钮 */
    node.taskStatus = "blocked";
    node.error = I18n.t("质检未通过：") + (report.verdict_why || "");
    if (!quiet) {
      toast(I18n.t("质检未通过：") + (report.shot_id || "") + " · " + report.score + " 分", "warn");
    }
    if (typeof renderCanvas === "function") renderCanvas();
    return { verdict: "fail", report };
  }

  node.error = lastError || report.verdict_why || I18n.t("质检没能完成");
  node.taskStatus = "blocked";
  if (typeof renderCanvas === "function") renderCanvas();
  return { verdict: "blocked", report };
}

/* ── 节点正文（判定结果 + 可直接改的 JSON 评分标准 · 不放任何说明文字）────── */

/* body 里的 JSON 走「表单 / 源码」哪个视图：会话内状态，不进画布快照（同文本节点 NP_JSON_SRC_VIEW） */
const QA_JSON_SRC_VIEW = new Set();

/** 老画布（4 进 → 3 进）留下的线：指向已取消的端口就叫「旧图需重连」，不替用户挪线 */
function qaHasStaleWire(node) {
  const wires = S && S.wf && Array.isArray(S.wf.wires) ? S.wf.wires : [];
  return wires.some((w) => w && !w.rel && w.to === node.id && Number(w.toIndex || 0) >= 3);
}

/** 老画布（4 出 → 3 出）留下的线：旧 1 号「判定」的线在读档时已断开（见 app.js migrateWf） */
function qaHasStaleOutWire(node) {
  return !!(node && node.qaStaleOut);
}

/** 报告里逐项的「项 / 分数 / 原因」：分数 ≥ 该项硬线（没硬线就按合格线）= 成功，否则失败。
 *  数据源优先 0 号输出里的报告 JSON（与落盘报告同一份），没有就退回 node.qa 存的那份。 */
function qaReportItems(node) {
  const q = node && node.qa && typeof node.qa === "object" ? node.qa : null;
  let rep = null;
  try {
    rep = JSON.parse(String((node && node.output && node.output.text) || ""));
  } catch (_) {
    rep = null;
  }
  const dims =
    (rep && Array.isArray(rep.dimensions) && rep.dimensions.length ? rep.dimensions : null) ||
    (q && Array.isArray(q.dimensions) ? q.dimensions : []);
  const rawLine = rep && rep.passLine != null ? rep.passLine : q && q.passLine;
  const passLine = Number(rawLine);
  const out = [];
  for (const d of dims) {
    if (!d || typeof d !== "object") continue;
    const sc = d.score == null || d.score === "" ? NaN : Number(d.score);
    const score = isFinite(sc) ? sc : null;
    const hard = d.minScore == null || d.minScore === "" ? NaN : Number(d.minScore);
    const line = isFinite(hard) ? hard : isFinite(passLine) ? passLine : 60;
    out.push({
      title: String(d.title || d.id || ""),
      score: score == null ? "—" : score,
      reason: String(d.reason || ""),
      ok: score != null && score >= line,
    });
  }
  return out;
}

/** body 里额外的一份报告 JSON：只显示 项 / 分数 / 原因，成功项绿框、失败项红框。 */
function qaReportBlock(node) {
  const q = node.qa && typeof node.qa === "object" ? node.qa : null;
  const items = qaReportItems(node);
  if (!q || !q.verdict || !items.length) return null;

  const box = document.createElement("div");
  box.className = "np-json-body qa-report-json";
  box.style.cssText = "margin-top:6px";

  const bar = document.createElement("div");
  bar.className = "np-json-bar";
  const chip = document.createElement("span");
  chip.className = "n-chip on";
  chip.textContent = I18n.t("JSON 报告");
  bar.appendChild(chip);
  box.appendChild(bar);

  const scroll = document.createElement("div");
  scroll.className = "np-json-scroll";
  scroll.style.cssText = "font-size:11.5px;line-height:1.5";

  const row = (key, value, color) => {
    const r = document.createElement("div");
    r.className = "np-row";
    const k = document.createElement("span");
    k.className = "np-key";
    k.textContent = '"' + I18n.t(key) + '":';
    r.appendChild(k);
    const v = document.createElement("span");
    v.style.cssText = "flex:1 1 auto;min-width:0;word-break:break-word;color:" + (color || "#c9d1d9");
    v.textContent = String(value);
    r.appendChild(v);
    return r;
  };

  const verdictColor = q.verdict === "pass" ? "#7ee0a1" : q.verdict === "fail" ? "#ff9b9b" : "#ffcf7a";
  const verdictText =
    q.verdict === "pass" ? I18n.t("通过") : q.verdict === "fail" ? I18n.t("未过") : I18n.t("需干涉");
  scroll.appendChild(row("总分", q.score == null ? "—" : q.score));
  scroll.appendChild(row("判定", verdictText, verdictColor));

  const listHead = row("项", "[" + items.length + "]", "#9fb4c9");
  scroll.appendChild(listHead);

  for (const it of items) {
    const color = it.ok ? "#7ee0a1" : "#ff9b9b";
    const bg = it.ok ? "rgba(126,224,161,0.07)" : "rgba(255,155,155,0.07)";
    const itemBox = document.createElement("div");
    itemBox.style.cssText =
      "border:1px solid " + color + ";border-radius:6px;padding:4px 6px;margin:3px 0 3px 10px;background:" + bg;
    itemBox.appendChild(row("项", it.title, color));
    itemBox.appendChild(row("分数", it.score, color));
    itemBox.appendChild(row("原因", it.reason || "—", "#9aa4b2"));
    scroll.appendChild(itemBox);
  }
  box.appendChild(scroll);
  return box;
}

function qaBuildBody(node, body) {
  /* 模型已经能解析出来了：上一次「没有选质检模型 / 未配置接口地址」的红字不该继续挂在节点上。
     徽标（需干涉）画在 body 之前，所以清掉后要再渲染一次才能一起撤掉。 */
  if (qaClearStaleModelError(node) && typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      if (typeof renderCanvas === "function") renderCanvas();
    });
  }
  const q = node.qa && typeof node.qa === "object" ? node.qa : null;

  /* 正文只留运行结果（分数 / 判定 / 出错原因），说明性文字一律不写 */
  const wrap = document.createElement("div");
  wrap.className = "qa-body";
  wrap.style.cssText = "font-size:11.5px;line-height:1.55;color:#c9d1d9";

  const line = (text, color, title) => {
    const d = document.createElement("div");
    d.textContent = text;
    if (color) d.style.color = color;
    if (title) d.title = title;
    wrap.appendChild(d);
    return d;
  };

  if (node.error) line(node.error, "#ff9b9b");
  else if (q && q.verdict) {
    const color = q.verdict === "pass" ? "#7ee0a1" : q.verdict === "fail" ? "#ff9b9b" : "#ffcf7a";
    const score = q.score == null ? "—" : q.score;
    line(
      I18n.t("总分 ") +
        score +
        " / " +
        (q.passLine == null ? "—" : q.passLine) +
        " · " +
        (q.verdict === "pass"
          ? I18n.t("通过")
          : q.verdict === "fail"
            ? I18n.t("未过")
            : I18n.t("需干涉")),
      color,
    );
    const parts = (q.scores && Object.keys(q.scores)) || [];
    if (parts.length) {
      line(parts.map((k) => k + " " + q.scores[k]).join(" · "), "#9aa4b2");
    }
  }
  if (qaHasStaleWire(node)) {
    line(
      I18n.t("旧图需重连"),
      "#ffcf7a",
      I18n.t("还有线接在已取消的端口上（原入 2 参考基准 / 入 3 控制），那些线不生效"),
    );
  }
  if (qaHasStaleOutWire(node)) {
    line(
      I18n.t("旧图需重连"),
      "#ffcf7a",
      I18n.t("「判定」输出端子已取消（与通过 / 未过两条控制出重复），原来接在它上面的线已断开；需要判定结果请改接「报告」或「通过 / 未过」"),
    );
  }
  if (wrap.children.length) body.appendChild(wrap);

  const rep = qaReportBlock(node);
  if (rep) body.appendChild(rep);

  body.appendChild(qaJsonBlock(node));
}

/** 评分标准 JSON：沿用文本节点那套 JSON 渲染（表单 ↔ 源码可切，表单可逐键改）；
 *  入 1「质检要求」接了线 → 只读（口径由连线决定）。 */
function qaJsonBlock(node) {
  const q = node.qa && typeof node.qa === "object" ? node.qa : null;
  const ro = qaHasRequirementWire(node);
  const text = qaTemplateJsonText(node);
  const det = typeof npDetectJson === "function" ? npDetectJson(text) : { ok: false, reason: "notJson" };
  /* 模板原文不是合法 JSON（或空）时只能看源码 */
  const srcView = QA_JSON_SRC_VIEW.has(node.id) || !det.ok;

  const box = document.createElement("div");
  box.className = "np-json-body qa-json-body";
  box.style.cssText = "margin-top:6px";

  const bar = document.createElement("div");
  bar.className = "np-json-bar";
  const chip = (label, cls, title) => {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = label;
    if (title) s.title = title;
    bar.appendChild(s);
    return s;
  };
  const btn = (label, title, fn, disabled) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini";
    b.textContent = label;
    b.title = title;
    b.disabled = !!disabled;
    b.onclick = (ev) => {
      ev.stopPropagation();
      fn();
    };
    bar.appendChild(b);
    return b;
  };

  chip(srcView ? I18n.t("源码") : I18n.t("JSON 表单"), "n-chip on");
  btn(
    srcView ? I18n.t("表单") : I18n.t("源码"),
    srcView ? I18n.t("换成 JSON 表单（逐键改，改动已写回评分标准）") : I18n.t("换成源码（直接改整份 JSON）"),
    () => {
      if (srcView) {
        /* 切回表单前先确认当前这份 JSON 能被解析，否则表单没东西可渲染 */
        const cur = qaTemplateJsonText(node);
        const okNow = typeof npDetectJson === "function" ? npDetectJson(cur).ok : false;
        if (!okNow) {
          toast(I18n.t("JSON 还没写完 / 有语法错，先修好再切表单"), "warn");
          return;
        }
        QA_JSON_SRC_VIEW.delete(node.id);
      } else {
        QA_JSON_SRC_VIEW.add(node.id);
      }
      /* 视图开关只改 body 内部：形态没变，applyNodeForm 会早退 → 必须就地重建 body */
      if (typeof refreshNodeBody === "function" && refreshNodeBody(node)) return;
      if (typeof renderCanvas === "function") renderCanvas();
    },
  );
  if (ro) chip(I18n.t("只读"), "np-json-ro", I18n.t("入 1「质检要求」已接线，口径由连线决定"));
  box.appendChild(bar);

  const editor = document.createElement("div");
  editor.className = "np-json-scroll";
  editor.style.cssText = "min-height:96px";

  if (srcView) {
    /* 源码视图：整份 JSON 原文（可直接改，写回节点内的 qaTemplateJson） */
    const ta = document.createElement("textarea");
    ta.className = "n-text";
    ta.spellcheck = false;
    ta.style.cssText =
      "width:100%;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;line-height:1.45;min-height:110px;resize:vertical";
    ta.value = text;
    ta.readOnly = ro;
    if (ro) ta.style.opacity = "0.72";
    ta.addEventListener("input", () => {
      qaWriteJson(node, ta.value);
      /* 边改边给即时反馈：解析不过只标红，不弹字 */
      const okNow = (typeof npDetectJson === "function" ? npDetectJson(ta.value) : { ok: false }).ok;
      ta.style.borderColor = okNow ? "" : "#ff6b6b";
    });
    editor.appendChild(ta);
  } else if (typeof npJsonEditor === "function") {
    editor.appendChild(
      npJsonEditor(
        det.value,
        (next) => {
          if (ro) return;
          qaWriteJson(node, typeof npJsonText === "function" ? npJsonText(next) : JSON.stringify(next, null, 2));
        },
        { readOnly: ro },
      ),
    );
  }
  box.appendChild(editor);

  if (!text && !qaTemplateCache.data) {
    qaTemplateList("", false).then((res) => {
      if (res && res.ok && typeof renderCanvas === "function") renderCanvas();
    });
  }

  const ops = document.createElement("div");
  ops.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
  const opBtn = (label, title, fn, disabled) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini";
    b.textContent = label;
    b.title = title;
    b.disabled = !!disabled;
    b.onclick = (ev) => {
      ev.stopPropagation();
      fn();
    };
    ops.appendChild(b);
    return b;
  };
  if (!ro) {
    opBtn(
      I18n.t("保存为新模板"),
      I18n.t("把这份 JSON 写进 <数据目录>/qa-templates/ 并选中它（供所有节点复用）"),
      () => qaSaveAsTemplate(node, qaTemplateJsonText(node)),
      !text,
    );
    if (node.qaTemplateJson) {
      opBtn(I18n.t("恢复模板"), I18n.t("丢掉节点内的改动，回到模板库里的那一份"), () => {
        delete node.qaTemplateJson;
        if (typeof renderCanvas === "function") renderCanvas();
      });
    }
  }
  if (q && q.verdict === "fail") {
    opBtn(I18n.t("人工裁决"), I18n.t("打开裁决卡：接受（记 override 放行）/ 放弃"), () =>
      qaOpenVerdict(node),
    );
  }
  if (ops.children.length) box.appendChild(ops);
  return box;
}

/** 把 body 里改的 JSON 写回节点（只影响这一颗节点）：清空 = 回到模板库那一份 */
function qaWriteJson(node, text) {
  const v = String(text == null ? "" : text).trim();
  if (v) node.qaTemplateJson = text;
  else delete node.qaTemplateJson;
  if (typeof scheduleSave === "function") scheduleSave();
}

/** body 里显示的 JSON：节点改过就显示改过的，否则显示当前选中模板的原文 */
function qaTemplateJsonText(node) {
  const raw = String((node && node.qaTemplateJson) || "").trim();
  if (raw) return raw;
  const data = qaTemplateCache.data;
  const tpls = (data && data.templates) || [];
  const media = qaKindMeta(node).media;
  const want = String((node && node.qaTemplate) || "").trim();
  const fit = tpls.filter((t) => !t.error && (!t.kind || t.kind === "any" || t.kind === media));
  const hit = tpls.filter((t) => t && t.id === want)[0] || fit[0];
  if (!hit || hit.error) return "";
  const json = hit.json && typeof hit.json === "object" ? hit.json : qaTemplateSnapshot(hit);
  try {
    return JSON.stringify(json, null, 2);
  } catch (_) {
    return "";
  }
}

/** 「保存为新模板」：写用户模板目录并切到新模板（节点内覆盖随之清空） */
async function qaSaveAsTemplate(node, text) {
  const api = typeof window !== "undefined" ? window.api : null;
  if (!api || typeof api.qaTemplateSave !== "function") {
    toast(I18n.t("模板写入桥未就绪（preload 未加载 qaTemplateSave）"), "warn");
    return;
  }
  let obj = null;
  try {
    obj = JSON.parse(String(text || ""));
  } catch (e) {
    toast(I18n.t("JSON 不合法，先修好再保存：") + String((e && e.message) || e), "warn");
    return;
  }
  const root = qaRootOf();
  const res = await api.qaTemplateSave({
    root: root.error ? "" : root.root,
    name: String(node.title || "").trim() || node.kind,
    json: obj,
  });
  if (!res || !res.ok) {
    toast(I18n.t("保存模板失败：") + ((res && res.error) || "无回执"), "warn");
    return;
  }
  delete node.qaTemplateJson;
  node.qaTemplate = res.id;
  await qaTemplateList(root.error ? "" : root.root, true);
  if (typeof renderCanvas === "function") renderCanvas();
  toast(I18n.t("已保存为新模板：") + res.id, "ok");
}

/* ── 设置表单（⚙）────────────────────────────────────────────────────────── */

function qaReloadForm(ctx, root) {
  qaTemplateList(root, true).then(() => {
    try {
      ctx.commit({ rebuild: true });
    } catch (_) {}
  });
}

if (typeof registerNodeSettingsForm === "function") {
  const buildQaForm = (ctx) => {
    const node = ctx.node;
    if (typeof nsProviderModelFields === "function") nsProviderModelFields(ctx, node);
    /* 打开 ⚙ 就是来配模型的：把那句「没有选质检模型」撤掉，并把下拉里显示的那个默认模型落进节点
       （否则面板显示着模型、node.model 仍是空，▶ 会报没选模型） */
    qaModelOf(node);
    qaClearStaleModelError(node);

    ctx.section(I18n.t("评分标准（JSON 模板 · 决定维度、权重与合格线）"));
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
    const sel = document.createElement("select");
    sel.style.cssText = "min-width:240px;max-width:100%";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = I18n.t("（未选择）");
    sel.appendChild(opt0);
    const data = qaTemplateCache.data;
    const media = qaKindMeta(node).media;
    const tpls = ((data && data.templates) || []).filter(
      (t) => !t.kind || t.kind === "any" || t.kind === media,
    );
    for (const t of tpls) {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent =
        (t.title || t.id) +
        " · " +
        (t.source === "builtin" ? I18n.t("内置") : t.source === "project" ? I18n.t("工程") : I18n.t("用户")) +
        (t.error ? " ⚠" : "");
      if (t.id === node.qaTemplate) o.selected = true;
      sel.appendChild(o);
    }
    sel.value = node.qaTemplate || "";
    sel.addEventListener("change", () => {
      node.qaTemplate = sel.value;
      ctx.commit({ history: true });
      ctx.commit({ rebuild: true });
    });
    row.appendChild(sel);
    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mini";
      b.textContent = label;
      b.title = title;
      b.onclick = fn;
      row.appendChild(b);
    };
    const root = qaRootOf();
    mk(I18n.t("刷新"), I18n.t("重新扫描模板目录"), () => qaReloadForm(ctx, root.error ? "" : root.root));
    mk(I18n.t("打开模板目录"), I18n.t("打开用户模板目录（<数据目录>/qa-templates）"), () => {
      const dirs = (qaTemplateCache.data && qaTemplateCache.data.dirs) || [];
      const d = dirs.filter((x) => x.source === "user")[0] || dirs.filter((x) => x.writable)[0];
      if (!d) {
        toast(I18n.t("模板目录还没就绪：先点一次刷新"), "warn");
        return;
      }
      if (window.api && window.api.shellOpenPath) window.api.shellOpenPath(d.dir);
    });
    ctx.append(row);

    if (!data) ctx.hint(I18n.t("正在扫描模板目录…"));
    else {
      const broken = (data.broken || []).slice(0, 4);
      if (broken.length) ctx.hint(I18n.t("有模板读不出来：") + broken.join("；"));
      if (!tpls.length) {
        ctx.hint(
          I18n.t("这一个类型还没有模板：把 JSON 放进 <数据目录>/qa-templates/ 或 <工程根>/qa/templates/ 后点「刷新」"),
        );
      }
    }

    const cur = tpls.filter((t) => t.id === node.qaTemplate)[0];
    if (cur) {
      const errs = qaTemplateErrors(cur, media);
      if (errs.length) ctx.hint(I18n.t("模板不合法：") + errs.map((e) => e.msg).join("；"));
      else {
        const info = document.createElement("div");
        info.style.cssText = "font-size:11.5px;color:#9aa4b2;line-height:1.6";
        info.textContent =
          I18n.t("合格线 ") +
          cur.passLine +
          " · " +
          (cur.dimensions || [])
            .map((d) => d.id + "(" + d.weight + (d.minScore != null ? " / 硬线 " + d.minScore : "") + ")")
            .join(" · ");
        ctx.append(info);
      }
    }

    ctx.section(I18n.t("执行"));
    /* 抽帧只对视频有意义：文本质检 / 图像 / 音频 / 文件质检里不出现这一项。
       参考样例不设「送审条数上限」—— 接了几条就全给模型，由它自己判断比哪些。 */
    if (media === "video" && typeof nsNumber === "function") {
      nsNumber(
        ctx,
        I18n.t("抽帧数（1–12，默认 7）"),
        qaCfg(node).frames,
        { min: 1, max: 12, step: 1, fallback: 7, live: true },
        (v) => {
          node.qaFrames = Math.round(v);
        },
      );
    }

    /* 思考强度：质检默认「无」（少绕弯、跑得快）；与文本节点同一套词汇 */
    if (typeof EFFORT_LEVELS !== "undefined" && Array.isArray(EFFORT_LEVELS)) {
      const effSel = document.createElement("select");
      for (const lv of EFFORT_LEVELS) {
        const o = document.createElement("option");
        o.value = lv;
        o.textContent = I18n.t(EFFORT_LABELS[lv] || lv);
        effSel.appendChild(o);
      }
      effSel.value = qaCfg(node).effort;
      effSel.addEventListener("change", () => {
        node.qaEffort = effSel.value;
        ctx.commit({ history: true });
      });
      const effField =
        typeof ctx.field === "function"
          ? ctx.field(I18n.t("思考强度（质检默认「无」）"), effSel)
          : ctx.append(effSel);
      void effField;
    }

    /* 图像 / 视频质检要能看图：服务商没开视觉时先讲清后果，不让它凭文件名瞎打分 */
    if (media === "image" || media === "video") {
      const pick = qaModelOf(node);
      if (pick.provider && !pick.canSee) {
        ctx.hint(
          I18n.t(
            "这家服务商没有开启视觉（vision）：图片不会随请求下发，质检只能靠工具取证 —— 请在设置 · 模型服务里为它开启视觉，或换一家能看图的模型。",
          ),
        );
      }
    }
  };

  for (const kind of QA_KINDS) {
    registerNodeSettingsForm(kind, {
      gearTitle: () => I18n.t("质检标准 / 模型"),
      summary: (node) => {
        const cfg = qaCfg(node);
        /* 抽帧只对视频有意义（其它四类不显示这一项） */
        const isVideo = qaKindMeta(node).media === "video";
        const eff =
          typeof EFFORT_LABELS === "object" && EFFORT_LABELS
            ? EFFORT_LABELS[cfg.effort] || cfg.effort
            : cfg.effort;
        return (
          I18n.t("标准") +
          " " +
          (cfg.template || I18n.t("未选")) +
          (cfg.templateJson ? I18n.t("（节点内改过）") : "") +
          (isVideo ? " · " + I18n.t("抽帧") + " " + cfg.frames : "") +
          " · " +
          I18n.t("思考") +
          " " +
          I18n.t(eff) +
          " · " +
          (qaModelOf(node, { write: false }).model || I18n.t("未选模型"))
        );
      },
      build: buildQaForm,
    });
  }
}

"use strict";
/* ============ 工具构建：文件支持判定 + 节点级登记（上半） ============
 * 本文件只做两件事，不碰任何既有运行逻辑（不改 app.js / app-tools.js / app-nodes.js）：
 *
 * 一、文件支持判定（纯函数）——「这条线喂过来的文件，消费节点到底吃不吃」
 *   · fileExtOf(pathOrName)     取小写扩展名（不含点）
 *   · fileTypeOf(pathOrName)    取文件大类：text / image / video / audio / pdf / other
 *   · fileKindSupported(consumerNode, srcFiles)
 *       消费节点是否接受这批文件（按 kind 查 ACCEPT 表；未登记的 kind 一律不设限）
 *   · unsupportedFilesOf(wire)  一条线上「消费不了」的文件清单（pdf 除外，见下）
 *   口径：PDF 归 fileTypeOf → "pdf"，但**不参与本模块**——拖入 / 导入 PDF 由既有
 *   renderer/pdf-markdown.js 链（结构化解析 → 无文本层逐页识图）转成 Markdown，
 *   本模块对它既不判支持也不报不支持（unsupportedFilesOf 会跳过它）。
 *   扩展名清单与 app.js inferMediaFromSource（.mp4/.webm/.mov、.wav/.flac/.mp3、
 *   .png/.jpe?g/.webp/.gif/.bmp）保持同一口径，只在其上补齐同类常见后缀。
 *
 * 二、节点级登记（读写 / 迁移辅助）——「这个节点处理过的这个文件，工具建好了没有」
 *   node.toolBuild = { ver, status, filePath, fileType, plan, toolLibId, toolName,
 *                      inputParam, builtAt, log:[] }
 *   · ensureToolBuildState(node)  幂等归一 + 旧字段迁移（老字段就地折进 toolBuild 后删除）
 *   · toolBuildGreen(node, filePath)      该节点是否已是「该文件构建绿灯」
 *   · toolBuildBegin / Ready / Failed / Reset / Log  状态流转
 *   绿灯判据（下半的构建链与 UI 只认这一条）：status === "ready" 且 filePath /
 *   fileType / toolName / toolLibId 齐备；给了 filePath 时路径必须与登记的一致。
 *
 * 依赖：无。全部函数是纯函数或只读写传入的 node 对象（不碰 S / 画布 / DOM）。
 * 加载顺序：排在 app-tools.js 之后（同属工具生态分层），由下半的工具构建 UI 与
 * 构建链在调用期取用。
 * ─────────────────────────────────────────────────────────────────── */

/* ---------- 一、文件支持判定 ---------- */

/* 各大类认的后缀（全部小写、不含点）。text 是「纯文本类消费节点」的默认口粮；
   image / video / audio 与 app.js inferMediaFromSource 的媒体口径一致。 */
const TOOLBUILD_EXTS = {
  text: [
    "txt",
    "text",
    "md",
    "markdown",
    "csv",
    "tsv",
    "json",
    "jsonl",
    "yaml",
    "yml",
    "xml",
    "html",
    "htm",
    "ini",
    "toml",
    "log",
    "srt",
    "vtt",
  ],
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "svg"],
  video: ["mp4", "webm", "mov", "mkv", "avi", "m4v"],
  audio: ["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"],
  /* pdf 单独成类：走既有 pdf-markdown 链，本模块不判支持也不报不支持 */
  pdf: ["pdf"],
};

/* 后缀 → 大类 的反查表（建一次，之后只读） */
const TOOLBUILD_EXT_TYPE = (() => {
  const m = Object.create(null);
  Object.keys(TOOLBUILD_EXTS).forEach((type) => {
    TOOLBUILD_EXTS[type].forEach((ext) => {
      if (!m[ext]) m[ext] = type;
    });
  });
  return m;
})();

/* 消费节点（按 kind）可接受的文件大类。
   · 未出现在表里的 kind 一律「不设限」（fileKindSupported 直接 true），
     避免本模块给智能节点 / 工具节点 / 保存节点等无关节点乱设卡；
   · 影视音生成节点的「吃媒体」口径：video_gen 的参考视频与首末帧（图片）、
     tts_gen 的参考音频、music_gen 的参考音频与歌词文本。 */
const TOOLBUILD_CONSUMER_ACCEPT = {
  proc_text: ["text"],
  db_table: ["text"],
  proc_image: ["image"],
  video_gen: ["video", "image"],
  tts_gen: ["audio"],
  music_gen: ["audio", "text"],
};

/* 路径 / 文件名 → 小写扩展名（不含点）；没有后缀、或只有隐藏名（如 ".gitignore"）返回 ""。 */
function fileExtOf(pathOrName) {
  const s = String(pathOrName == null ? "" : pathOrName).trim();
  if (!s) return "";
  /* 去掉查询串 / 井号尾巴，再取最后一段（兼容 / 与 \ 两种分隔符） */
  const clean = s.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  return base.slice(i + 1).toLowerCase();
}

/* 路径 / 文件名 → 文件大类：text / image / video / audio / pdf；认不出 → "other"。 */
function fileTypeOf(pathOrName) {
  const ext = fileExtOf(pathOrName);
  return (ext && TOOLBUILD_EXT_TYPE[ext]) || "other";
}

/* 某个大类认的后缀清单（返回副本；UI 展示 / 文件对话框过滤器用）。 */
function fileExtsOfType(type) {
  const list = TOOLBUILD_EXTS[String(type || "")];
  return list ? list.slice() : [];
}

/* 消费节点的可接受大类：入参可以是节点对象（读 .kind）或直接给 kind 字符串。
   返回 null = 不设限（未登记的 kind）。 */
function fileConsumerAccept(consumerNode) {
  const kind =
    consumerNode && typeof consumerNode === "object"
      ? String(consumerNode.kind || "")
      : String(consumerNode || "");
  const accept = TOOLBUILD_CONSUMER_ACCEPT[kind];
  return Array.isArray(accept) ? accept.slice() : null;
}

/* 文件入参归一：接受字符串 / {path|file|filePath|name} / 数组 / null，一律拍平成路径字符串数组。 */
function filePathsOf(srcFiles) {
  const one = (f) => {
    if (f == null) return "";
    if (typeof f === "string") return f.trim();
    if (typeof f === "object")
      return String(f.path || f.file || f.filePath || f.name || "").trim();
    return "";
  };
  if (Array.isArray(srcFiles)) return srcFiles.map(one).filter(Boolean);
  const p = one(srcFiles);
  return p ? [p] : [];
}

/* 单文件判定：{ path, ext, type, supported, handledElsewhere, reason }
   · handledElsewhere = true → pdf：由既有 pdf-markdown 链处理，本模块不表态（supported 恒 true）。
   · 未登记的消费 kind → supported = true（不设限）。 */
function fileSupportDetail(consumerNode, srcFile) {
  const path = filePathsOf(srcFile)[0] || "";
  const ext = fileExtOf(path);
  const type = path ? fileTypeOf(path) : "";
  const accept = fileConsumerAccept(consumerNode);
  if (type === "pdf")
    return {
      path: path,
      ext: ext,
      type: type,
      supported: true,
      handledElsewhere: true,
      reason: "PDF 走 pdf-markdown 链（结构化 → 逐页识图），不由工具构建处理",
    };
  if (!accept)
    return {
      path: path,
      ext: ext,
      type: type,
      supported: true,
      handledElsewhere: false,
      reason: "该节点类型不设文件类型限制",
    };
  const ok = !!type && accept.indexOf(type) >= 0;
  return {
    path: path,
    ext: ext,
    type: type,
    supported: ok,
    handledElsewhere: false,
    reason: ok
      ? ""
      : "该节点只接受 " +
        accept.join(" / ") +
        " 类文件，当前为 " +
        (ext ? "." + ext : "未知类型"),
  };
}

/* 消费节点是否接受这批文件：空清单 → true（无文件即无判定）；
   全部文件都可接受 → true；任一不可接受 → false。srcFiles 支持单文件 / 数组。 */
function fileKindSupported(consumerNode, srcFiles) {
  const files = filePathsOf(srcFiles);
  if (!files.length) return true;
  return files.every((p) => fileSupportDetail(consumerNode, p).supported);
}

/* 一条线（wire）上「消费不了」的文件明细清单：只报真正不支持的文件，
   pdf（handledElsewhere）跳过 —— 它归 pdf-markdown 链，不算工具构建的失败。
   wire 字段：{ from, to, fromIndex, toIndex }，可选 srcFiles = 源侧文件清单；
   没有 srcFiles 时按 wireSourceFiles 从节点现场尽力推断。 */
function unsupportedFilesOf(wire) {
  if (!wire || typeof wire !== "object") return [];
  const consumer = wireConsumerNode(wire);
  const accept = fileConsumerAccept(consumer);
  if (!accept) return [];
  return wireSourceFiles(wire)
    .map((p) => fileSupportDetail(consumer, p))
    .filter((d) => !d.supported && !d.handledElsewhere);
}

/* 线的消费端节点：优先用调用方挂上的 toNode / toNodeObj，其次查画布 nodeById。 */
function wireConsumerNode(wire) {
  if (!wire) return null;
  if (wire.toNode && typeof wire.toNode === "object") return wire.toNode;
  if (wire.toNodeObj && typeof wire.toNodeObj === "object") return wire.toNodeObj;
  const id = wire.to;
  if (!id) return null;
  if (typeof nodeById === "function") {
    try {
      return nodeById(id) || null;
    } catch {
      return null;
    }
  }
  const wf = typeof S === "object" && S && S.wf;
  const nodes = (wf && wf.nodes) || [];
  return nodes.find((n) => n && String(n.id || "") === String(id)) || null;
}

/* 线的源侧文件清单（纯读，尽力而为）：
   1) wire.srcFiles / wire.files 显式给了就用它；
   2) 输入类节点读它自己的文件字段（input_image.imagePath(s) / input_* 的 files）；
   3) 其余节点在调用期取 valueForInput(node, fromIndex) 里的 path。
   取不到 → []（判定链会当成「无文件」，不误报）。 */
function wireSourceFiles(wire) {
  if (!wire || typeof wire !== "object") return [];
  const explicit = filePathsOf(wire.srcFiles || wire.files);
  if (explicit.length) return explicit;
  const from = wire.fromNode && typeof wire.fromNode === "object" ? wire.fromNode : null;
  const src =
    from ||
    (wire.from && typeof nodeById === "function"
      ? (() => {
          try {
            return nodeById(wire.from) || null;
          } catch {
            return null;
          }
        })()
      : null);
  if (!src) return [];
  if (Array.isArray(src.imagePaths) && src.imagePaths.length)
    return filePathsOf(src.imagePaths);
  if (src.imagePath) return filePathsOf(src.imagePath);
  for (const key of ["files", "filePaths", "paths"]) {
    if (Array.isArray(src[key]) && src[key].length) return filePathsOf(src[key]);
  }
  if (typeof valueForInput === "function") {
    try {
      const v = valueForInput(src, Number(wire.fromIndex || 0));
      const p = v && (v.path || v.file || (v.kind === "text" ? v.text : ""));
      if (p && /[\\/]|\.[A-Za-z0-9]{1,6}$/.test(String(p))) return filePathsOf(p);
    } catch {
      /* 运行期取不到值 = 没有文件，静默 */
    }
  }
  return [];
}

/* ---------- 二、节点级登记（node.toolBuild） ---------- */

const TOOLBUILD_STATE_VER = 1;
const TOOLBUILD_STATUSES = ["idle", "building", "ready", "failed"];

/* 旧字段 → toolBuild 的迁移表（一次性就地折算，折完删除老键，避免双份真源） */
const TOOLBUILD_LEGACY_KEYS = [
  "toolBuildState",
  "toolBuildStatus",
  "toolBuildFile",
  "toolBuildFilePath",
  "toolBuildFileType",
  "toolBuildToolName",
  "toolBuildLibId",
  "toolBuildInputParam",
  "toolBuildPlan",
  "toolBuildLog",
  "toolBuiltAt",
  "toolBuilt",
  "toolBuildReady",
];

/* 日志行：{ at, level: "info"|"warn"|"error", text }
   （保留最近 TOOLBUILD_LOG_MAX 条，防止长跑画布把状态撑爆） */
const TOOLBUILD_LOG_MAX = 200;

/* 幂等归一 + 旧字段迁移：老节点上的 toolBuild* 散键折进 node.toolBuild 后删除。
   幂等（无老键、已归一 → 无副作用）且只动传入节点，返回 node.toolBuild。 */
function ensureToolBuildState(node) {
  if (!node) return null;
  let st = node.toolBuild && typeof node.toolBuild === "object" ? node.toolBuild : null;
  if (!st) {
    st = {};
    node.toolBuild = st;
  }
  const legacy = {};
  TOOLBUILD_LEGACY_KEYS.forEach((k) => {
    if (node[k] !== undefined) {
      legacy[k] = node[k];
      delete node[k];
    }
  });
  if (legacy.toolBuildState && typeof legacy.toolBuildState === "object") {
    Object.keys(legacy.toolBuildState).forEach((k) => {
      if (st[k] === undefined) st[k] = legacy.toolBuildState[k];
    });
  }
  const urlLess = (p) => String(p == null ? "" : p).trim();
  const pick = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null || v === "") continue;
      return v;
    }
    return undefined;
  };
  if (st.filePath === undefined) {
    const p = pick(legacy.toolBuildFilePath, legacy.toolBuildFile);
    if (p !== undefined) st.filePath = urlLess(p);
  }
  if (st.fileType === undefined && legacy.toolBuildFileType !== undefined)
    st.fileType = String(legacy.toolBuildFileType || "");
  if (st.toolName === undefined && legacy.toolBuildToolName !== undefined)
    st.toolName = String(legacy.toolBuildToolName || "");
  if (st.toolLibId === undefined && legacy.toolBuildLibId !== undefined)
    st.toolLibId = String(legacy.toolBuildLibId || "");
  if (st.inputParam === undefined && legacy.toolBuildInputParam !== undefined)
    st.inputParam = String(legacy.toolBuildInputParam || "");
  if (st.plan === undefined && legacy.toolBuildPlan !== undefined)
    st.plan = legacy.toolBuildPlan;
  if (st.builtAt === undefined && legacy.toolBuiltAt !== undefined)
    st.builtAt = String(legacy.toolBuiltAt || "");
  if (st.log === undefined && Array.isArray(legacy.toolBuildLog))
    st.log = legacy.toolBuildLog.slice();
  /* 状态：显式值优先；老布尔 toolBuilt / toolBuildReady = true → ready */
  if (st.status === undefined) {
    if (legacy.toolBuilt === true || legacy.toolBuildReady === true) st.status = "ready";
  }
  /* 归一：字段类型与取值域一次到位 */
  st.ver = TOOLBUILD_STATE_VER;
  st.status = TOOLBUILD_STATUSES.indexOf(String(st.status || "")) >= 0 ? String(st.status) : "idle";
  st.filePath = String(st.filePath == null ? "" : st.filePath);
  st.fileType = String(st.fileType == null ? "" : st.fileType);
  if (st.plan === undefined || st.plan === null) st.plan = "";
  st.toolLibId = String(st.toolLibId == null ? "" : st.toolLibId);
  st.toolName = String(st.toolName == null ? "" : st.toolName);
  st.inputParam = String(st.inputParam == null ? "" : st.inputParam);
  st.builtAt = String(st.builtAt == null ? "" : st.builtAt);
  if (!Array.isArray(st.log)) st.log = [];
  st.log = st.log
    .map((e) =>
      typeof e === "string"
        ? { at: "", level: "info", text: e }
        : e && typeof e === "object"
          ? {
              at: String(e.at || ""),
              level: ["info", "warn", "error"].indexOf(String(e.level || "")) >= 0
                ? String(e.level)
                : "info",
              text: String(e.text == null ? "" : e.text),
            }
          : null,
    )
    .filter(Boolean)
    .slice(-TOOLBUILD_LOG_MAX);
  return st;
}

/* 只读取状态（不归一、不写回）：节点没登记过 → 返回一份空态副本。 */
function toolBuildStateOf(node) {
  const st = node && node.toolBuild && typeof node.toolBuild === "object" ? node.toolBuild : null;
  if (st) return st;
  return {
    ver: TOOLBUILD_STATE_VER,
    status: "idle",
    filePath: "",
    fileType: "",
    plan: "",
    toolLibId: "",
    toolName: "",
    inputParam: "",
    builtAt: "",
    log: [],
  };
}

/* 路径比较（Windows 口径：统一分隔符 + 忽略大小写 + 去首尾空白）。 */
function toolBuildSamePath(a, b) {
  const n = (p) => String(p == null ? "" : p).trim().replace(/\//g, "\\").toLowerCase();
  return n(a) === n(b);
}

/* 状态流转（全部先 ensure，全部返回 node.toolBuild）：
   Begin  —— 开工：写文件与计划、状态 building、清掉上一次的成品登记（builtAt/工具名保留？否：清空）
   Ready  —— 建成：写工具库 id / 工具名 / 入参名与文件类型、状态 ready、builtAt 打时间戳
   Failed —— 失败：状态 failed，原因进日志
   Reset  —— 回到 idle（只清状态与成品登记，日志保留） */
function toolBuildBegin(node, filePath, plan, logText) {
  const st = ensureToolBuildState(node);
  if (!st) return null;
  st.filePath = String(filePath == null ? "" : filePath).trim();
  st.fileType = st.filePath ? fileTypeOf(st.filePath) : "";
  st.plan = plan === undefined || plan === null ? "" : plan;
  st.status = "building";
  st.toolLibId = "";
  st.toolName = "";
  st.inputParam = "";
  st.builtAt = "";
  if (logText) toolBuildLog(node, logText, "info");
  return st;
}

function toolBuildReady(node, patch) {
  const st = ensureToolBuildState(node);
  if (!st) return null;
  const p = patch && typeof patch === "object" ? patch : {};
  if (p.filePath !== undefined) st.filePath = String(p.filePath || "").trim();
  if (p.fileType !== undefined) st.fileType = String(p.fileType || "");
  else if (st.filePath && !st.fileType) st.fileType = fileTypeOf(st.filePath);
  if (p.plan !== undefined) st.plan = p.plan === null ? "" : p.plan;
  if (p.toolLibId !== undefined) st.toolLibId = String(p.toolLibId || "");
  if (p.toolName !== undefined) st.toolName = String(p.toolName || "");
  if (p.inputParam !== undefined) st.inputParam = String(p.inputParam || "");
  st.status = "ready";
  st.builtAt = String(p.builtAt || new Date().toISOString());
  if (p.log) toolBuildLog(node, p.log, "info");
  return st;
}

function toolBuildFailed(node, reason, patch) {
  const st = ensureToolBuildState(node);
  if (!st) return null;
  const p = patch && typeof patch === "object" ? patch : {};
  if (p.filePath !== undefined) st.filePath = String(p.filePath || "").trim();
  if (p.fileType !== undefined) st.fileType = String(p.fileType || "");
  if (p.plan !== undefined) st.plan = p.plan === null ? "" : p.plan;
  if (p.toolLibId !== undefined) st.toolLibId = String(p.toolLibId || "");
  if (p.toolName !== undefined) st.toolName = String(p.toolName || "");
  st.status = "failed";
  st.builtAt = "";
  toolBuildLog(node, String(reason == null ? "" : reason) || "构建失败", "error");
  return st;
}

function toolBuildReset(node) {
  const st = ensureToolBuildState(node);
  if (!st) return null;
  st.status = "idle";
  st.toolLibId = "";
  st.toolName = "";
  st.inputParam = "";
  st.builtAt = "";
  return st;
}

/* 追加一行日志（超出上限裁掉最旧的），返回该行。 */
function toolBuildLog(node, text, level) {
  const st = ensureToolBuildState(node);
  if (!st) return null;
  const entry = {
    at: new Date().toISOString(),
    level: ["info", "warn", "error"].indexOf(String(level || "")) >= 0 ? String(level) : "info",
    text: String(text == null ? "" : text),
  };
  st.log.push(entry);
  if (st.log.length > TOOLBUILD_LOG_MAX) st.log = st.log.slice(-TOOLBUILD_LOG_MAX);
  return entry;
}

/* 绿灯判据（下半的构建链 / UI 唯一入口）：
   status = ready 且 文件 / 文件类型 / 工具名 / 工具库 id 齐备；给了 filePath 时路径须一致。
   入参可以是节点，也可以直接是状态对象（用 .toolBuild 或本身带 status 判定）。 */
function toolBuildGreen(node, filePath) {
  const st = node && node.toolBuild && typeof node.toolBuild === "object" ? node.toolBuild : node;
  if (!st || typeof st !== "object") return false;
  if (String(st.status || "") !== "ready") return false;
  if (!String(st.filePath || "").trim()) return false;
  if (!String(st.fileType || "").trim()) return false;
  if (!String(st.toolName || "").trim()) return false;
  if (!String(st.toolLibId || "").trim()) return false;
  if (filePath !== undefined && filePath !== null && String(filePath) !== "")
    return toolBuildSamePath(st.filePath, filePath);
  return true;
}

/* 这个文件在该节点上是否已经「工具构建绿灯」（未给文件 → 只看节点绿灯态）。 */
function toolBuildFileGreen(node, filePath) {
  return toolBuildGreen(node, filePath);
}

/* 构建结果 → 工具节点入参类型（text / image）：下半建工具时给 inputParam 选 kind 用。 */
function toolBuildInputKind(fileType) {
  return String(fileType || "") === "image" ? "image" : "text";
}

/* 命名空间出口（可选便捷入口；全局函数同时可直接调用） */
if (typeof window === "object" && window)
  window.ToolBuild = {
    EXTS: TOOLBUILD_EXTS,
    CONSUMER_ACCEPT: TOOLBUILD_CONSUMER_ACCEPT,
    STATE_VER: TOOLBUILD_STATE_VER,
    STATUSES: TOOLBUILD_STATUSES,
    fileExtOf,
    fileTypeOf,
    fileExtsOfType,
    fileConsumerAccept,
    fileKindSupported,
    fileSupportDetail,
    unsupportedFilesOf,
    wireConsumerNode,
    wireSourceFiles,
    ensureToolBuildState,
    toolBuildStateOf,
    toolBuildBegin,
    toolBuildReady,
    toolBuildFailed,
    toolBuildReset,
    toolBuildLog,
    toolBuildGreen,
    toolBuildFileGreen,
    toolBuildSamePath,
    toolBuildInputKind,
  };

/* ═══════════════ 工具构建：AI 方案 + 二次确认（中段） ═══════════════
 * 本段只做两件事，不碰构建执行与画布（构建链属下半）：
 *
 * 一、planToolBuildForFile(filePath, consumerNode) —— 「AI 检索出方案」
 *   · 先判文件类型：后缀（上半 fileTypeOf）+ 魔数（主进程读首段，见
 *     toolBuildReadHead）；后缀认不出时用魔数 / 文本嗅探兜底。
 *   · 再走一次 dshRunTask（provider / model / effort 跟随用户当前默认，
 *     noCanvas 纯文本口径，preset 走默认档）让模型给出方案 JSON：
 *     { fileType, 能力缺口说明, 方案要点, 拟建工具名,
 *       输入参数表(含 file 路径 text 参数), 输出参数表(text / image),
 *       实测用例(用该真实文件), 失败风险 }
 *   · 解析容错：能抠出 JSON 就归一成结构化 plan；抠不出就整体当摘要展示。
 *   返回 { ok, filePath, fileType, fileInfo, plan, summary, raw, text, error }。
 *   本函数只读文件、不写文件、不改节点状态（状态交由下半的构建链登记）。
 *
 * 二、两段阻塞式确认（openOverlay(…, { min:false })）
 *   · toolBuildAskEnable(file, consumerNode) ① 连线拦截：「该处理节点不支持
 *     .xxx 文件，是否启用工具构建？」→ Promise<boolean>
 *   · toolBuildAskConfirm(plan, rawText)      ② 方案展示后：「确认按此方案开发？」
 *     → Promise<boolean>
 *   词汇全部走 I18n.t()；确认窗不最小化（min:false）且 persistent（点外部不关）。
 *
 * 依赖（只在调用期取，缺了就优雅降级）：window.api（读首段 / 读文本样本 /
 * fileStat）、dshRunTask、preferredAgentProviderRoute / preferredAgentModelForRoute、
 * S.assistEffort、AGENT_PRESET_DEFAULT、openOverlay / closeOverlay / $。
 * ─────────────────────────────────────────────────────────────────── */

const TOOLBUILD_PLAN_RUNKEY = "toolbuild:plan";
const TOOLBUILD_HEAD_BYTES = 64;
const TOOLBUILD_TEXT_SAMPLE_MAX = 6000;

/* ---------- 主进程读首段（魔数用） ---------- */

function toolBuildApiBridge() {
  if (typeof window === "object" && window && window.api) return window.api;
  if (typeof api !== "undefined" && api) return api;
  return null;
}

/* 各种返回形状 → Uint8Array：{bytes|data|buffer|base64} / 数组 / Uint8Array / base64 字符串 */
function toolBuildBytesFrom(raw) {
  if (!raw) return null;
  const src =
    raw && typeof raw === "object" && !(raw instanceof Uint8Array) && !Array.isArray(raw)
      ? raw.bytes !== undefined
        ? raw.bytes
        : raw.data !== undefined
          ? raw.data
          : raw.buffer !== undefined
            ? raw.buffer
            : null
      : raw;
  const fromBase64 = (s) => {
    try {
      const bin = typeof atob === "function" ? atob(String(s)) : "";
      if (!bin) return null;
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
      return out;
    } catch (_) {
      return null;
    }
  };
  if (raw && typeof raw === "object" && typeof raw.base64 === "string" && raw.base64)
    return fromBase64(raw.base64);
  if (!src) return null;
  if (src instanceof Uint8Array) return src;
  if (typeof Uint8Array !== "undefined" && src instanceof ArrayBuffer) return new Uint8Array(src);
  if (Array.isArray(src) || (src && typeof src.length === "number" && typeof src !== "string")) {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = Number(src[i]) & 255;
    return out;
  }
  if (typeof src === "string" && src) return fromBase64(src);
  return null;
}

/* 读文件首段（只读，主进程）。优先专用读首段桥（fileProbeHead / probeFileHead /
   fileHead / fileReadHead）；都没有时退回既有 fileReadAudio（主进程带上限读字节，
   只取前 maxBytes 个）。桥不存在 / 文件过大 / 报错 → null（判型退回后缀）。 */
async function toolBuildReadHead(filePath, maxBytes) {
  const p = String(filePath == null ? "" : filePath).trim();
  if (!p) return null;
  const n = Math.max(16, Math.min(4096, Number(maxBytes) || TOOLBUILD_HEAD_BYTES));
  const b = toolBuildApiBridge();
  if (!b) return null;
  for (const name of ["fileProbeHead", "probeFileHead", "fileHead", "fileReadHead"]) {
    if (typeof b[name] !== "function") continue;
    try {
      const r = await b[name](p, n);
      const bytes = toolBuildBytesFrom(r && r.ok === false ? null : r);
      if (bytes && bytes.length) return bytes.slice(0, n);
    } catch (_) {
      /* 该桥不可用：试下一个 */
    }
  }
  if (typeof b.fileReadAudio === "function") {
    try {
      const r = await b.fileReadAudio(p, n);
      if (r && r.ok !== false && !r.tooBig) {
        const bytes = toolBuildBytesFrom(r);
        if (bytes && bytes.length) return bytes.slice(0, n);
      }
    } catch (_) {
      /* 读不到就退回后缀判型 */
    }
  }
  return null;
}

/* 读文本样本（只给 text 类，截断到 TOOLBUILD_TEXT_SAMPLE_MAX；失败 → ""） */
async function toolBuildTextSample(filePath, fileType, limit) {
  if (String(fileType || "") !== "text") return "";
  const b = toolBuildApiBridge();
  if (!b || typeof b.fileReadText !== "function") return "";
  try {
    const r = await b.fileReadText(String(filePath || ""));
    const t = r && typeof r === "object" ? String(r.content || "") : String(r || "");
    return t.slice(0, Math.max(200, Number(limit) || TOOLBUILD_TEXT_SAMPLE_MAX));
  } catch (_) {
    return "";
  }
}

/* ---------- 文件类型判定：后缀 + 魔数 + 文本嗅探 ---------- */

function toolBuildAt(bytes, i, sig) {
  for (let k = 0; k < sig.length; k++) if (bytes[i + k] !== sig[k]) return false;
  return true;
}

/* 魔数 → 大类（text / image / video / audio / pdf）；认不出 → "" */
function toolBuildMagicType(bytes) {
  if (!bytes || !bytes.length) return "";
  const b = bytes;
  if (toolBuildAt(b, 0, [0x25, 0x50, 0x44, 0x46])) return "pdf"; /* %PDF */
  if (toolBuildAt(b, 0, [0x89, 0x50, 0x4e, 0x47])) return "image"; /* PNG */
  if (toolBuildAt(b, 0, [0xff, 0xd8, 0xff])) return "image"; /* JPEG */
  if (toolBuildAt(b, 0, [0x47, 0x49, 0x46, 0x38])) return "image"; /* GIF8 */
  if (toolBuildAt(b, 0, [0x42, 0x4d])) return "image"; /* BM */
  if (toolBuildAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video"; /* EBML: mkv / webm */
  if (toolBuildAt(b, 0, [0x66, 0x4c, 0x61, 0x43])) return "audio"; /* fLaC */
  if (toolBuildAt(b, 0, [0x4f, 0x67, 0x67, 0x53])) return "audio"; /* OggS */
  if (
    toolBuildAt(b, 0, [0x49, 0x44, 0x33]) || /* ID3 */
    toolBuildAt(b, 0, [0xff, 0xfb]) ||
    toolBuildAt(b, 0, [0xff, 0xf3]) ||
    toolBuildAt(b, 0, [0xff, 0xf2])
  )
    return "audio";
  if (toolBuildAt(b, 0, [0x52, 0x49, 0x46, 0x46])) {
    /* RIFF????：WAVE / AVI / WEBP */
    const fourcc = String.fromCharCode(
      b[8] || 0,
      b[9] || 0,
      b[10] || 0,
      b[11] || 0,
    );
    if (fourcc === "WAVE") return "audio";
    if (fourcc === "AVI ") return "video";
    if (fourcc === "WEBP") return "image";
  }
  const ftyp = String.fromCharCode(b[4] || 0, b[5] || 0, b[6] || 0, b[7] || 0);
  if (ftyp === "ftyp") return "video"; /* mp4 / mov */
  return "";
}

/* 首段看起来是不是文本（无 NUL、可打印占比高；拿不到字节时不表态） */
function toolBuildLooksText(bytes) {
  if (!bytes || !bytes.length) return false;
  const n = Math.min(bytes.length, 512);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) return false;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc2) printable++;
  }
  return printable / n > 0.9;
}

/* 路径 → { path, ext, type, extType, magicType, source, headBytes }
   后缀优先（上半口径），后缀认不出时用魔数，再不行用文本嗅探，最后 "other"。 */
async function toolBuildDetectFileType(filePath) {
  const p = String(filePath == null ? "" : filePath).trim();
  const ext = typeof fileExtOf === "function" ? fileExtOf(p) : "";
  const extType = typeof fileTypeOf === "function" ? fileTypeOf(p) : "other";
  let headBytes = null;
  if (p) {
    try {
      headBytes = await toolBuildReadHead(p, TOOLBUILD_HEAD_BYTES);
    } catch (_) {
      headBytes = null;
    }
  }
  const magicType = toolBuildMagicType(headBytes);
  let type = extType && extType !== "other" ? extType : "";
  let source = type ? "ext" : "";
  if (!type && magicType) {
    type = magicType;
    source = "magic";
  }
  if (!type && toolBuildLooksText(headBytes)) {
    type = "text";
    source = "sniff";
  }
  if (!type) {
    type = "other";
    source = source || "none";
  }
  return {
    path: p,
    ext: ext,
    type: type,
    extType: extType,
    magicType: magicType || "",
    source: source,
    headBytes: headBytes,
  };
}

/* ---------- 方案 JSON：prompt / 解析 / 归一 / 摘要 ---------- */

function toolBuildPlanPrompt(info, consumerNode, sample, stat) {
  const consumerKind = consumerNode ? String(consumerNode.kind || "") : "";
  const consumerTitle = consumerNode ? String(consumerNode.title || "") : "";
  const accept =
    typeof fileConsumerAccept === "function" ? fileConsumerAccept(consumerNode) : null;
  const typeLabel =
    info.type +
    (info.magicType && info.magicType !== info.type ? "（魔数判为 " + info.magicType + "）" : "") +
    "（判定来源：" +
    (info.source === "ext" ? "扩展名" : info.source === "magic" ? "魔数" : info.source === "sniff" ? "文本嗅探" : "未知") +
    "）";
  return [
    "你是 MTNode 画布的工具构建方案设计器。用户把某个文件连到一个处理节点，但该节点不支持这种文件；请判断能力缺口，并设计一个「工具节点」把这种文件转换成该节点能消费的内容。",
    "",
    "【文件】",
    "路径：" + info.path,
    "扩展名：" + (info.ext ? "." + info.ext : "（无）"),
    "判型：" + typeLabel,
    stat && stat.size ? "体积：" + stat.size + " 字节" : "",
    "",
    "【处理节点】",
    "类型 kind：" + (consumerKind || "（未知）"),
    "标题：" + (consumerTitle || "（未命名）"),
    "可接受的文件大类：" + (accept ? accept.join(" / ") : "不设限（未登记）"),
    "",
    sample ? "【文件内容样本（前 " + sample.length + " 字）】\n" + sample : "",
    "",
    "【输出要求】只输出一个 JSON 对象，不要 markdown 围栏、不要任何解释，字段：",
    "{",
    '  "fileType": "文件类型（如 pdf / image / video / audio / 文本 / 二进制）",',
    '  "能力缺口说明": "当前处理节点为什么消费不了它（≤120 字）",',
    '  "方案要点": "工具内部怎么转换 / 抽取，落到什么输出（≤200 字）",',
    '  "拟建工具名": "简洁中文工具名（≤12 字）",',
    '  "输入参数表": [{"name":"file","kind":"text","desc":"输入文件路径"}],',
    '  "输出参数表": [{"name":"text","kind":"text","desc":"喂给处理节点的内容"}],',
    '  "实测用例": "用上面这个真实文件的路径试跑：输入什么、预期输出什么",',
    '  "失败风险": "可能失败的环节与规避办法（≤120 字）"',
    "}",
    "约束：输入参数表必须含一个名为 file 的 text 参数（值为文件绝对路径）；输出参数表的 kind 只能是 text 或 image，且要与处理节点能消费的内容一致。",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

/* 从模型回文里抠 JSON（围栏内优先，其次首尾花括号之间）；抠不出 → null */
function toolBuildExtractJson(text) {
  const s = String(text == null ? "" : text);
  if (!s.trim()) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence && fence[1]) candidates.push(fence[1]);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(s.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim());
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch (_) {
      /* 试下一个候选 */
    }
  }
  return null;
}

/* 值 → 展示文本（数组用「；」连） */
function toolBuildTextOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v))
    return v
      .map((x) => (typeof x === "string" ? x : toolBuildTextOf(x && (x.desc || x.text || x.name))))
      .filter(Boolean)
      .join("；");
  if (typeof v === "object")
    return toolBuildTextOf(v.desc || v.text || v.name || v.value || "");
  return String(v);
}

/* 参数表归一：接受 ["file", …] 或 [{name,kind,desc}]；kind 只认 text / image。 */
function toolBuildNormalizePorts(list) {
  const out = [];
  const push = (name, kind, desc) => {
    const n = String(name == null ? "" : name).trim();
    if (!n) return;
    const k = String(kind || "").toLowerCase() === "image" ? "image" : "text";
    out.push({ name: n, kind: k, desc: String(desc == null ? "" : desc).trim() });
  };
  if (Array.isArray(list)) {
    for (const it of list) {
      if (it == null) continue;
      if (typeof it === "string") push(it, "text", "");
      else if (typeof it === "object") push(it.name, it.kind || it.type, it.desc || it.description || "");
    }
  } else if (list && typeof list === "object") {
    Object.keys(list).forEach((k) => {
      const v = list[k];
      if (v && typeof v === "object") push(k, v.kind || v.type, v.desc || v.description);
      else push(k, /image|图片|图像/i.test(String(v || "")) ? "image" : "text", toolBuildTextOf(v));
    });
  }
  return out;
}

/* 模型回文 → 结构化方案；无 JSON → null（调用方把整段回文当摘要展示） */
function toolBuildNormalizePlan(raw, info) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pick = (...vals) => {
    for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
    return "";
  };
  const fileType = String(
    pick(raw.fileType, raw["文件类型"], info && info.type) || (info && info.type) || "",
  ).trim();
  const inputs = toolBuildNormalizePorts(
    pick(raw["输入参数表"], raw.inputs, raw.inputParams, raw.input_ports),
  );
  if (!inputs.some((x) => x.name.toLowerCase() === "file"))
    inputs.unshift({ name: "file", kind: "text", desc: "输入文件路径" });
  const outputs = toolBuildNormalizePorts(
    pick(raw["输出参数表"], raw.outputs, raw.outputParams, raw.output_ports),
  );
  if (!outputs.length) outputs.push({ name: "text", kind: "text", desc: "转换后的内容" });
  return {
    fileType: fileType,
    gap: toolBuildTextOf(pick(raw["能力缺口说明"], raw.gap, raw.capabilityGap)),
    approach: toolBuildTextOf(pick(raw["方案要点"], raw.approach, raw.plan, raw.solution)),
    toolName: toolBuildTextOf(pick(raw["拟建工具名"], raw.toolName, raw.name)),
    inputs: inputs,
    outputs: outputs,
    testCase: toolBuildTextOf(pick(raw["实测用例"], raw.testCase, raw.test)),
    risks: toolBuildTextOf(pick(raw["失败风险"], raw.risks, raw.risk)),
  };
}

/* 结构化方案 → 可读摘要（确认窗与节点状态展示共用；非 JSON 回文走整段原文） */
function toolBuildPlanSummaryText(plan) {
  if (!plan || typeof plan !== "object") return String(plan == null ? "" : plan);
  if (typeof plan === "string") return plan;
  const ports = (list) =>
    (Array.isArray(list) ? list : [])
      .map((p) => "  · " + p.name + "（" + (p.kind === "image" ? I18n.t("图像") : I18n.t("文本")) + "）" + (p.desc ? "：" + p.desc : ""))
      .join("\n");
  const rows = [];
  if (plan.fileType) rows.push(I18n.t("文件类型") + "：" + plan.fileType);
  if (plan.toolName) rows.push(I18n.t("拟建工具名") + "：" + plan.toolName);
  if (plan.gap) rows.push(I18n.t("能力缺口说明") + "：" + plan.gap);
  if (plan.approach) rows.push(I18n.t("方案要点") + "：" + plan.approach);
  if (plan.inputs && plan.inputs.length)
    rows.push(I18n.t("输入参数表") + "：\n" + ports(plan.inputs));
  if (plan.outputs && plan.outputs.length)
    rows.push(I18n.t("输出参数表") + "：\n" + ports(plan.outputs));
  if (plan.testCase) rows.push(I18n.t("实测用例") + "：" + plan.testCase);
  if (plan.risks) rows.push(I18n.t("失败风险") + "：" + plan.risks);
  return rows.join("\n");
}

/* ---------- ① / ② 阻塞式确认 ---------- */

/* 通用阻塞确认：openOverlay(title, { min:false, persistent:true })，
   Esc / 「取消」→ false，「确认」→ true；窗内按钮是唯一关闭路径。 */
function toolBuildOverlayConfirm(opt) {
  const o = opt && typeof opt === "object" ? opt : {};
  return new Promise((resolve) => {
    if (typeof openOverlay !== "function") {
      resolve(false);
      return;
    }
    openOverlay(String(o.title || I18n.t("确认")), { min: false, persistent: true });
    const body =
      typeof $ === "function" ? $("#ovBody") : document.getElementById("ovBody");
    const foot =
      typeof $ === "function" ? $("#ovFoot") : document.getElementById("ovFoot");
    let done = false;
    const onKey = (ev) => {
      if (ev && ev.key === "Escape") {
        ev.preventDefault();
        settle(false, true);
      }
    };
    const settle = (ans, closeDom) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      if (closeDom && typeof closeOverlay === "function") closeOverlay();
      resolve(!!ans);
    };
    document.addEventListener("keydown", onKey, true);
    if (body) {
      body.innerHTML = "";
      (Array.isArray(o.lines) ? o.lines : []).forEach((line, i) => {
        const text = String(line == null ? "" : line);
        if (!text) return;
        if (o.pre && i === 0) {
          const pre = document.createElement("pre");
          pre.style.cssText =
            "max-height:320px; overflow:auto; margin:0 0 10px; padding:10px; " +
            "background:var(--code); border:1px solid var(--bd); font-size:12px; " +
            "line-height:1.7; white-space:pre-wrap; word-break:break-word";
          pre.textContent = text;
          body.appendChild(pre);
          return;
        }
        const p = document.createElement("p");
        p.style.cssText =
          "margin:0 0 8px; line-height:1.75; font-size:13px; color:var(--fg2, inherit)";
        p.textContent = text;
        body.appendChild(p);
      });
      if (o.note) {
        const n = document.createElement("div");
        n.style.cssText = "margin-top:10px; color:var(--muted); font-size:11.5px";
        n.textContent = String(o.note);
        body.appendChild(n);
      }
    }
    if (foot) {
      foot.innerHTML = "";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "mini";
      cancel.textContent = String(o.cancelText || I18n.t("取消"));
      cancel.onclick = () => settle(false, true);
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "mini primary";
      ok.textContent = String(o.okText || I18n.t("确认"));
      ok.onclick = () => settle(true, true);
      foot.appendChild(cancel);
      foot.appendChild(ok);
    }
  });
}

/* ① 连线拦截：该处理节点不支持 .xxx 文件，是否启用工具构建？→ Promise<boolean>
   入参 file 可以是路径字符串，也可以是 fileSupportDetail 的明细对象（已判过型就不再读盘）。 */
async function toolBuildAskEnable(file, consumerNode) {
  let d = file && typeof file === "object" ? file : null;
  if (!d) {
    try {
      d = await toolBuildDetectFileType(file);
    } catch (_) {
      d = {
        path: String(file == null ? "" : file),
        ext: typeof fileExtOf === "function" ? fileExtOf(file) : "",
        type: typeof fileTypeOf === "function" ? fileTypeOf(file) : "other",
      };
    }
  }
  const extText = d.ext ? "." + d.ext : I18n.t("未知类型");
  const consumerKind = consumerNode ? String(consumerNode.kind || "") : "";
  const consumerName =
    consumerNode && (consumerNode.title || consumerNode.kind)
      ? String(consumerNode.title || "") + (consumerKind ? "（" + consumerKind + "）" : "")
      : consumerKind;
  return toolBuildOverlayConfirm({
    title: I18n.t("该处理节点不支持 {ext} 文件", { ext: extText }),
    lines: [
      d.path ? I18n.t("文件：{path}", { path: d.path }) : "",
      consumerName ? I18n.t("处理节点：{node}", { node: consumerName }) : "",
      I18n.t(
        "该文件无法被当前处理节点直接消费。可以启用「工具构建」：由 AI 先给出转换方案，确认后再在画布上搭建一个工具节点，把这种文件转换成处理节点能消费的内容。",
      ),
      I18n.t("是否启用工具构建？"),
    ],
    okText: I18n.t("启用工具构建"),
    cancelText: I18n.t("暂不"),
  });
}

/* ② 方案展示后：确认按此方案开发？→ Promise<boolean>
   plan 可以是结构化方案对象，也可以直接给纯文本摘要（非 JSON 回文的容错口径）。 */
async function toolBuildAskConfirm(plan, rawText) {
  const text =
    plan && typeof plan === "object"
      ? toolBuildPlanSummaryText(plan)
      : String(plan == null ? rawText || "" : plan);
  return toolBuildOverlayConfirm({
    title: I18n.t("确认按此方案开发？"),
    lines: [text || I18n.t("（方案为空）")],
    pre: true,
    okText: I18n.t("确认开发"),
    cancelText: I18n.t("取消"),
    note: I18n.t("确认后将按此方案在画布上搭建工具节点并接入当前连线；未确认前不会改动画布。"),
  });
}

/* ---------- 主入口：AI 检索出方案 ---------- */

/* 跟随用户当前默认的智能路由 / 模型 / 思考强度（取不到就回落官方路由与默认档） */
function toolBuildRunRoute() {
  const route =
    typeof preferredAgentProviderRoute === "function"
      ? preferredAgentProviderRoute() || "deepseek-official"
      : "deepseek-official";
  const model =
    typeof preferredAgentModelForRoute === "function"
      ? preferredAgentModelForRoute(route) || ""
      : "";
  const st = typeof S === "object" && S ? S : null;
  let effort = (st && (st.assistEffort || (st.config && st.config.assistEffort))) || "high";
  if (typeof normalizeAgentEffort === "function") {
    try {
      effort = normalizeAgentEffort(effort);
    } catch (_) {}
  }
  const preset =
    typeof AGENT_PRESET_DEFAULT === "string" && AGENT_PRESET_DEFAULT
      ? AGENT_PRESET_DEFAULT
      : "minimal";
  return { provider: route, model: model, effort: effort, preset: preset };
}

/* 一次 noCanvas 纯文本运行，生成方案；返回 { ok, filePath, fileType, fileInfo,
   plan, summary, raw, text, error }。失败不抛（error 里带原因），供上层提示与重试。 */
async function planToolBuildForFile(filePath, consumerNode) {
  const path = String(filePath == null ? "" : filePath).trim();
  if (!path) {
    return {
      ok: false,
      filePath: "",
      fileType: "",
      fileInfo: null,
      plan: null,
      summary: I18n.t("缺少文件路径"),
      raw: null,
      text: "",
      error: I18n.t("缺少文件路径"),
    };
  }
  let info = null;
  try {
    info = await toolBuildDetectFileType(path);
  } catch (_) {
    info = {
      path: path,
      ext: typeof fileExtOf === "function" ? fileExtOf(path) : "",
      type: typeof fileTypeOf === "function" ? fileTypeOf(path) : "other",
      extType: "",
      magicType: "",
      source: "none",
      headBytes: null,
    };
  }
  let stat = null;
  const b = toolBuildApiBridge();
  if (b && typeof b.fileStat === "function") {
    try {
      const r = await b.fileStat(path);
      if (r && r.ok) stat = r;
    } catch (_) {
      stat = null;
    }
  }
  const sample = await toolBuildTextSample(path, info.type);
  const prompt = toolBuildPlanPrompt(info, consumerNode, sample, stat);
  const route = toolBuildRunRoute();
  const baseName = path.split(/[\\/]/).pop() || path;
  let text = "";
  let error = "";
  try {
    if (typeof dshRunTask !== "function") throw new Error(I18n.t("智能运行入口未就绪"));
    text = await dshRunTask(prompt, {
      runKey: TOOLBUILD_PLAN_RUNKEY,
      tokTitle: I18n.t("工具构建方案") + " · " + baseName,
      provider: route.provider,
      model: route.model || undefined,
      effort: route.effort,
      preset: route.preset,
      /* noCanvas 纯文本口径：不注册画布三件套，本任务只做文本方案设计 */
      noCanvas: true,
    });
  } catch (err) {
    error = (err && err.message) || String(err || "");
    text = "";
  }
  const out = String(text == null ? "" : text).trim();
  const raw = out ? toolBuildExtractJson(out) : null;
  const plan = toolBuildNormalizePlan(raw, info);
  return {
    ok: !!out,
    filePath: path,
    fileType: info.type,
    fileInfo: info,
    plan: plan,
    /* 解析容错：非 JSON 回文整体当摘要展示 */
    summary: plan ? toolBuildPlanSummaryText(plan) : out,
    raw: raw,
    text: out,
    error: error,
  };
}

/* ═══════════════ 工具构建：建工具 → 开发会话 → 本文件实测 → 入工具库（下半） ═══════════════
 * 主入口 buildToolForFile(consumerNode, filePath, plan) 的四步（每一步都记进
 * node.toolBuild.log，状态流转复用上半的 toolBuildBegin / Ready / Failed）：
 *
 *   ① 建工具节点：按泛用开发规则新建「工具节点」（super + tool:true，参数即端子），
 *      toolConfig.inputs 第一个参数固定 = file（text · 输入文件绝对路径），
 *      outputs 取方案输出表（kind 只认 text / image）；落点在加工区右下（findToolSpot
 *      从所有现有节点的包围盒右下起找空位，逐格试探，绝不覆盖已有节点 / 绘制）；
 *      同时把内部的「开发会话契约」写好：现状 + 边界 + 必须用这个真实文件实测。
 *   ② 建绑定该工具的开发会话（createToolDevSessionForNode 同源姿势：workspace /
 *      canvasWfId / preset / provider / model / effort 全部跟随当前活动会话），
 *      agentSessionSend 后台运行，等本轮结束（等不到只记日志，不中断）。
 *   ③ 开发完成后调 testToolNode(node, [null, filePath]) 用真实文件试跑；失败则
 *      把错误回灌会话重试，最多 TOOLBUILD_TEST_ROUNDS_MAX 轮，成功才算绿灯。
 *   ④ 绿灯后走既有 saveToolFromCanvas 入工具库，回写 node.toolBuild =
 *      { status:'ready', toolLibId, toolName, inputParam }；并在**原处理节点**的卡片
 *      body 下方注入「已启用工具：X」按钮（打开工具试跑 / 管理，见 toolBuildToolDialog）。
 *      注入点不改 app-canvas.js：包装 mountNodeEl，节点卡片挂载完成后原地补一枚按钮
 *      （幂等 · 只看 node.toolBuild 是否绿灯）。
 *
 * 依赖（只在调用期取，缺了就优雅降级 / 报错返回，不抛）：
 *   addNode / uniqueNodeTitle / renderCanvas / scheduleSave / refreshNodeUi / toast /
 *   agentSessions / agentSessionById / persistAgentSession / agentSessionSend /
 *   sessionIsRunning / functionCodeOf / fnToolParamList / createToolDevSessionForNode /
 *   toolDevContractText / testToolNode / saveToolFromCanvas / toolsList。
 * ─────────────────────────────────────────────────────────────────── */

const TOOLBUILD_TEST_ROUNDS_MAX = 3;
const TOOLBUILD_DEV_WAIT_MS = 2 * 60 * 60 * 1000;
const TOOLBUILD_TOOL_GAP = 80;

/* 工具 / 函数节点的参数条形状归一（text | image，输入侧保留 list 标记） */
function toolBuildPortArray(list, kindFallback) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((e) => {
    if (e == null) return;
    const src = typeof e === "string" ? { name: e } : e;
    if (!src || typeof src !== "object") return;
    const rawName = String(src.name == null ? "" : src.name).trim();
    const name = rawName || I18n.t("参数 ") + (out.length + 1);
    let kind = String(src.kind || src.type || "").toLowerCase();
    if (kind !== "image" && kind !== "text") kind = kindFallback === "image" ? "image" : "text";
    const p = { name: name, kind: kind };
    if (src.list === true) p.list = true;
    out.push(p);
  });
  return out;
}

/* 该 toolConfig 是否已具备「file 文本入参 + 至少一个出参」的工具端子契约：
   是 → 保持会话已开发的参数表原样，不拿方案覆盖（工具构建下的实测优先）。 */
function toolBuildConfigHasFileParam(cfg) {
  const ins = (cfg && Array.isArray(cfg.inputs) && cfg.inputs) || [];
  const outs = (cfg && Array.isArray(cfg.outputs) && cfg.outputs) || [];
  const file = ins.find((e) => e && String(e.name || "").toLowerCase() === "file");
  return !!(file && outs.length);
}

/* 一次构建过程的日志：node.toolBuild.log + 控制台（日志行带 [工具构建] 前缀便于筛查） */
function toolBuildRunLog(node, text, level) {
  const line = "[工具构建] " + String(text == null ? "" : text);
  try {
    if (typeof toolBuildLog === "function") toolBuildLog(node, line, level || "info");
  } catch (_) {}
  try {
    if (typeof console === "object" && console) {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      if (typeof fn === "function") fn.call(console, line);
    }
  } catch (_) {}
  return line;
}

/* 矩形相交（含间隙判定） */
function toolBuildRectHit(r, o, gap) {
  const g = Number(gap) || 0;
  if (!r || !o) return false;
  return !(
    r.x + r.w + g <= o.x ||
    o.x + o.w + g <= r.x ||
    r.y + r.h + g <= o.y ||
    o.y + o.h + g <= r.y
  );
}

/* 画布上所有现存节点 / 绘制的包围盒（用于选落点，只读，不碰画布） */
function toolBuildOccupiedRects() {
  const rects = [];
  const nodes = (S && S.wf && S.wf.nodes) || [];
  for (const n of nodes) {
    if (!n) continue;
    rects.push({
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      w: Math.max(40, Number(n.w) || 200),
      h: Math.max(40, Number(n.h) || 120),
    });
  }
  for (const m of (S && S.wf && S.wf.marks) || []) {
    if (!m) continue;
    rects.push({
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
      w: Math.max(20, Number(m.w) || 20),
      h: Math.max(20, Number(m.h) || 20),
    });
  }
  return rects;
}

/* 落点：加工区右下找一块空地（不覆盖任何已有节点 / 绘制）。
   从「所有节点的右下角」开始逐格向右 / 向下试探，保证落在原有内容的下方或右侧。 */
function findToolSpot(w, h) {
  const W = Math.max(200, Number(w) || 340);
  const H = Math.max(160, Number(h) || 240);
  const rects = toolBuildOccupiedRects();
  const g = (typeof grid === "function" && Number(grid())) || 20;
  const snapTo = (v) => (typeof snap === "function" ? snap(v) : Math.round(v / g) * g);
  if (!rects.length) return { x: snapTo(240), y: snapTo(240) };
  let maxX = 0;
  let maxY = 0;
  for (const r of rects) {
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  const stepX = W + TOOLBUILD_TOOL_GAP;
  const stepY = H + TOOLBUILD_TOOL_GAP;
  const free = (x, y) => {
    const r = { x: x, y: y, w: W, h: H };
    return !rects.some((o) => toolBuildRectHit(r, o, 24));
  };
  /* 主位：整块内容的右下（加工区右下角）；被占（如已有工具节点）就沿右 / 下逐格漂移 */
  const baseX = snapTo(maxX + TOOLBUILD_TOOL_GAP);
  const baseY = snapTo(maxY + TOOLBUILD_TOOL_GAP);
  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 8; row++) {
      const x = snapTo(baseX + col * stepX);
      const y = snapTo(baseY + row * stepY);
      if (free(x, y)) return { x: x, y: y };
    }
  }
  /* 兜底：所有格都被占（画布极密）时沿最右侧再往外推 */
  let x = baseX;
  while (!free(x, baseY) && x < 40000) x += stepX;
  return { x: x, y: baseY };
}

/* ② 建「绑定该工具的开发会话」：完全同源 createToolDevSessionForNode 的姿势，
   但把契约换成工具构建任务书，并记住本次文件与实测要求。返回会话对象。 */
function createToolBuildSessionForNode(node, req, filePath) {
  if (!node || typeof isToolNode !== "function" || !isToolNode(node)) return null;
  if (typeof agentSessions !== "function") return null;
  const cur =
    typeof agentSessionById === "function" ? agentSessionById(S.agentActiveId) : null;
  const reqText = String(req === undefined || req === null ? "" : req).trim();
  const sess = {
    id: typeof uid === "function" ? uid("as") : "as" + Date.now(),
    title: I18n.t("开发 · ") + (toolDevNameOf(node) || I18n.t("未命名工具")),
    workspace: typeof dshWorkspaceOf === "function" ? dshWorkspaceOf(node) || "" : "",
    canvasWfId: typeof canvasWfIdForNode === "function" ? canvasWfIdForNode(node) : "",
    preset: (cur && cur.preset) || AGENT_PRESET_DEFAULT || "minimal",
    provider: (cur && cur.provider) || "deepseek-official",
    model: (cur && cur.model) || "",
    effort: (cur && cur.effort) || "high",
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  /* 契约：工具开发契约（toolDevContractText）打底 + 本文件实测要求（现状 / 边界 / 实测）。
     与 createToolDevSessionForNode 同一姿势：首条消息**只有用户关键输入**（这里通常为空），
     整份任务书走 _devContract 在每轮随系统提示注入，不占用户消息位。 */
  sess._devContract = toolBuildContractText(
    node,
    reqText,
    filePath,
    node.toolBuild && node.toolBuild.plan,
  );
  sess.messages.unshift({
    role: "user",
    content:
      reqText ||
      I18n.t("按工具构建任务书：用 ") +
        (String(filePath || "").trim() || I18n.t("给定文件")) +
        I18n.t(" 实测通过这个工具"),
    _src: "dev-node",
    _nid: node.id,
  });
  agentSessions().unshift(sess);
  if (!Array.isArray(node.toolDevSessionIds)) node.toolDevSessionIds = [];
  node.toolDevSessionIds.unshift(sess.id);
  while (node.toolDevSessionIds.length > 24) node.toolDevSessionIds.pop();
  node.toolBuildSessionId = sess.id;
  return sess;
}

/* 工具构建任务书（写进 session._devContract，每轮随系统提示注入）：
   在 toolDevContractText 之上追加「本文件实测」这一段的硬要求。 */
function toolBuildContractText(node, req, filePath, plan) {
  const base =
    typeof toolDevContractText === "function"
      ? toolDevContractText(node, req)
      : I18n.t("【工具开发任务书】") + " " + (toolDevNameOf(node) || I18n.t("未命名工具"));
  const p = plan && typeof plan === "object" ? plan : {};
  const file = String(filePath == null ? "" : filePath).trim();
  const reqText = String(req == null ? "" : req).trim();
  const lines = [base, ""];
  if (reqText && lines.indexOf(I18n.t("本次开发需求：") + reqText) < 0)
    lines.push(I18n.t("本次开发需求：") + reqText);
  lines.push(I18n.t("【本次工具构建：本文件实测要求】"));
  lines.push(
    I18n.t("目标文件：") +
      (file || I18n.t("（未给出）")) +
      (file && typeof fileTypeOf === "function" ? I18n.t("（类型：") + fileTypeOf(file) + "）" : ""),
  );
  if (p.gap) lines.push(I18n.t("能力缺口：") + p.gap);
  if (p.approach) lines.push(I18n.t("方案要点：") + p.approach);
  if (p.testCase) lines.push(I18n.t("实测用例（方案里给的）：") + p.testCase);
  if (p.risks) lines.push(I18n.t("失败风险：") + p.risks);
  lines.push(
    I18n.t(
      "硬要求：① 工具节点的 toolConfig.inputs 第一个参数必须名为 file（kind 为 text，值为输入文件的绝对路径），且 Inputs / outputs 一律按「参数即端子」维护；② 内部子图负责解析该类型文件（读取该路径的文件、按类型抽取成文本 / 生成图像），把结果汇流到工具的输出端子；③ **必须用上面这个真实文件路径实测通过**：开发完成后会自动用该文件试跑这个工具节点，试跑报错就会把错误回灌到本会话继续修，直到通过为止；④ 不要新建 / 删除 / 改动本工具节点与内部子图之外的任何画布节点或连线。",
    ),
  );
  lines.push(
    I18n.t(
      "实测的运行现场：工具节点由画布引擎执行，内部子图可用文本处理 / 智能任务 / 函数 / 保存等节点；解析文件若需要读本地文件，走函数节点的 mtnode.readText / mtnode.exec（主进程侧、无 window）. 试跑只读口径：不改工具输出、不级联下游。",
    ),
  );
  return lines.join("\n");
}

/* 等一轮会话结束（agentSessionSend 正常本轮结束才返回；忙时入队 → 这里补一轮轮询兜底） */
async function toolBuildWaitTurnEnd(st) {
  try {
    if (!st || typeof sessionIsRunning !== "function") return;
    const step = 1200;
    let waited = 0;
    while (sessionIsRunning(st) && waited < TOOLBUILD_DEV_WAIT_MS) {
      await new Promise((r) => setTimeout(r, step));
      waited += step;
    }
  } catch (_) {}
}

/* 取会话里最后一条助手正文（回执 / 结论摘要用；取不到返回 ""） */
function toolBuildLastAssistantText(st) {
  const msgs = (st && st.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && String(m.content || "").trim())
      return String(m.content).trim();
  }
  return "";
}

/* 会话摘要（进 node.toolBuild.log，只留前 400 字，避免日志被长文撑爆） */
function toolBuildBrief(text, n) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const lim = Math.max(40, Number(n) || 400);
  return t.length > lim ? t.slice(0, lim) + "…" : t;
}

/* ③ 本文件实测：走既有 testToolNode（与「试跑台」同一注入点），入参 [控制入, file]。
   testToolNode 在调用期可能还没加载（上半先于 app-tools.js 之外的加载顺序无关紧要，
   这里缺了就视为测试不可用，让调用方按失败回灌）。 */
async function toolBuildTestWithFile(node, filePath) {
  const p = String(filePath == null ? "" : filePath).trim();
  if (typeof testToolNode !== "function")
    return { ok: false, error: I18n.t("试跑入口未就绪（app-tools.js）"), ports: {}, count: 0 };
  const vals = new Array(1).fill(null);
  vals[1] =
    typeof fnTestPortValue === "function"
      ? fnTestPortValue(p, "text")
      : { kind: "text", text: p };
  try {
    const res = await testToolNode(node, vals);
    return res && typeof res === "object"
      ? res
      : { ok: false, error: I18n.t("试跑没有返回结果"), ports: {}, count: 0 };
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || String(err || ""),
      ports: {},
      count: 0,
    };
  }
}

/* 实测结果 → 可读一行（成功看第 0 号出参，失败带错误文本） */
function toolBuildTestDigest(res) {
  const r = res && typeof res === "object" ? res : {};
  const ports = r.ports || {};
  const out =
    ports.$0 != null
      ? String(ports.$0 && ports.$0.text != null ? ports.$0.text : ports.$0.path || "")
      : "";
  const head = r.ok ? I18n.t("通过") : I18n.t("未通过");
  const tail = r.ok
    ? I18n.t("输出：") + (toolBuildBrief(out, 160) || I18n.t("（空）"))
    : I18n.t("错误：") + toolBuildBrief(r.error || "—", 240);
  return head + " · " + tail;
}

/* ── ④ 入工具库 + 原处理节点上的「已启用工具」入口 ── */

/* 绿灯回写：状态 ready（toolBuildReady 里带上文件 / 类型 / 工具名 / 库 id / file 入参名） */
function toolBuildMarkReady(node, filePath, libId, toolName, inputParam) {
  return toolBuildReady(node, {
    filePath: filePath,
    fileType: fileTypeOf(filePath),
    toolLibId: libId,
    toolName: toolName,
    inputParam: inputParam || "file",
  });
}

/* 取当前卡片 DOM：优先按归属作用域查，查不到再全画布查一次 */
function toolBuildNodeEl(nodeId) {
  const id = String(nodeId == null ? "" : nodeId);
  if (!id) return null;
  const sel = '.wf-node[data-nid="' + id + '"]';
  let el = document.querySelector(sel);
  if (el) return el;
  const stage = typeof $ === "function" ? $("#stage") : document.getElementById("stage");
  if (stage && typeof stage.querySelector === "function") el = stage.querySelector(sel);
  return el || null;
}

/* 幂等：只在绿灯时补一枚「已启用工具：X」按钮（挂在该节点 body 末尾）。
   按钮打开工具试跑 / 管理对话框（toolBuildToolDialog）。 */
function toolBuildApplyReadyBadge(node) {
  if (!node || !node.id) return;
  const el = toolBuildNodeEl(node.id);
  if (!el) return;
  const body = el.querySelector(":scope > .n-body");
  if (!body) return;
  const host = body.querySelector(':scope > .toolbuild-enabled[data-tb-nid="' + node.id + '"]');
  const green = typeof toolBuildGreen === "function" && toolBuildGreen(node);
  if (!green) {
    if (host) host.remove();
    return;
  }
  const st = toolBuildStateOf(node);
  const name = st.toolName || I18n.t("（未命名工具）");
  if (host) {
    const btn = host.querySelector("button");
    if (btn) {
      btn.textContent = I18n.t("已启用工具：") + name;
      btn.title = toolBuildReadyBadgeTitle(node);
    }
    return;
  }
  const wrap = document.createElement("div");
  /* 复用开发节点那套按钮样式（.n-dev-info .n-dev-open），不新增 CSS 规则 */
  wrap.className = "toolbuild-enabled n-dev-info";
  wrap.dataset.tbNid = node.id;
  wrap.style.cssText =
    "display:flex;align-items:center;gap:6px;flex:none;margin-top:4px;min-width:0";
  const btns = document.createElement("div");
  btns.className = "n-dev-btns";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "n-dev-open";
  btn.textContent = I18n.t("已启用工具：") + name;
  btn.title = toolBuildReadyBadgeTitle(node);
  btn.onclick = (ev) => {
    ev.stopPropagation();
    toolBuildToolDialog(node);
  };
  btns.appendChild(btn);
  wrap.appendChild(btns);
  body.appendChild(wrap);
}

function toolBuildReadyBadgeTitle(node) {
  const st = toolBuildStateOf(node);
  return (
    I18n.t("工具构建绿灯：") +
    (st.toolName || "") +
    (st.filePath ? I18n.t(" · 实测文件：") + st.filePath : "") +
    I18n.t(" · 点击打开工具试跑 / 管理")
  );
}

/* 卡片挂载钩子：节点卡片渲染完成后原地补按钮（不改 app-canvas.js → 包装 mountNodeEl）。
   幂等 + 只在节点已登记 toolBuild 时才做，未用工具构建的画布零影响。 */
function toolBuildInstallBodyHook() {
  if (typeof window !== "object" || !window) return;
  if (window.__toolBuildBodyHook || typeof mountNodeEl !== "function") return;
  const orig = mountNodeEl;
  window.mountNodeEl = function (parent, n) {
    const el = orig.apply(this, arguments);
    try {
      if (n && n.toolBuild && typeof n.toolBuild === "object")
        toolBuildApplyReadyBadge(n);
    } catch (_) {}
    return el;
  };
  window.__toolBuildBodyHook = true;
}

/* 「已启用工具：X」按钮 → 工具试跑 / 管理窗：只读状态 + 实测入参回填 + 就地试跑 + 工具库入口 */
function toolBuildToolDialog(consumerNode) {
  if (!consumerNode) return;
  const st = toolBuildStateOf(consumerNode);
  const toolNode = st.toolName ? toolBuildFindToolNode(st) : null;
  openOverlay(I18n.t("已启用工具：") + (st.toolName || I18n.t("（未命名工具）")), {
    persistent: true,
  });
  const box = document.querySelector("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;min-height:0";
  const row = (label, value) => {
    const d = document.createElement("div");
    d.style.cssText = "font-size:12px;line-height:1.7;word-break:break-all";
    const b = document.createElement("span");
    b.style.cssText = "opacity:.7";
    b.textContent = label;
    d.append(b, document.createTextNode(String(value == null ? "" : value)));
    return d;
  };
  const hint = (t) => {
    const d = document.createElement("div");
    d.className = "settings-hint";
    d.style.lineHeight = "1.5";
    d.textContent = t;
    wrap.appendChild(d);
    return d;
  };
  hint(
    toolNode
      ? I18n.t("该工具已保存进工具库（绿灯）。可在下方用实测文件重新试跑，或进「工具库」改名 / 删除 / 随时可调用。")
      : I18n.t("该工具节点已不在当前画布（可能被删或被切到别的画布）；可在「工具库」里查看已保存的条目。"),
  );
  wrap.appendChild(row(I18n.t("工具名："), st.toolName));
  wrap.appendChild(row(I18n.t("实测文件："), st.filePath || I18n.t("（无）")));
  wrap.appendChild(row(I18n.t("工具库 id："), st.toolLibId || I18n.t("（未入库）")));
  wrap.appendChild(row(I18n.t("构建时间："), st.builtAt || ""));
  /* 实测入参：回填到工具节点的 toolTestInputs（第一个输入参数 = file） */
  const ins = toolNode ? fnToolParamList(toolNode, "in") : [];
  const fileIdx = Math.max(
    0,
    ins.findIndex((p) => String(p.name || "").toLowerCase() === "file"),
  );
  let fileInp = null;
  if (toolNode && ins.length) {
    const lab = document.createElement("div");
    lab.style.cssText = "font-size:11.5px;opacity:.8;margin-top:4px";
    lab.textContent = I18n.t("试跑入参 · ") + ((ins[fileIdx] && ins[fileIdx].name) || "file");
    fileInp = document.createElement("textarea");
    fileInp.rows = 2;
    fileInp.style.cssText =
      "width:100%;flex:none;resize:vertical;font-size:12px;font-family:var(--mono)";
    fileInp.value = st.filePath || "";
    const runOut = document.createElement("div");
    runOut.style.cssText =
      "font-size:12px;font-family:var(--mono);white-space:pre-wrap;word-break:break-all;max-height:220px;overflow-y:auto;border:1px solid var(--bd);border-radius:8px;padding:8px 10px;display:none";
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "mini primary";
    runBtn.textContent = I18n.t("▶ 用该文件试跑");
    runBtn.onclick = async () => {
      const p = String(fileInp.value || "").trim();
      if (!p) {
        toast(I18n.t("请先填写要试跑的文件路径"), "warn");
        return;
      }
      if (!Array.isArray(toolNode.toolTestInputs)) toolNode.toolTestInputs = [];
      toolNode.toolTestInputs[fileIdx] = p;
      runBtn.disabled = true;
      const label = runBtn.textContent;
      runBtn.textContent = I18n.t("试跑中…");
      const res = await toolBuildTestWithFile(toolNode, p);
      runBtn.disabled = false;
      runBtn.textContent = label;
      runOut.style.display = "block";
      runOut.textContent = toolBuildTestDigest(res);
      if (typeof scheduleSave === "function") {
        try {
          scheduleSave();
        } catch (_) {}
      }
      toolBuildRunLog(consumerNode, I18n.t("手动试跑（管理窗）：") + toolBuildTestDigest(res), res.ok ? "info" : "warn");
    };
    wrap.append(lab, fileInp, runBtn, runOut);
  }
  body.appendChild(wrap);
  foot.innerHTML = "";
  const openLib = document.createElement("button");
  openLib.type = "button";
  openLib.className = "mini";
  openLib.textContent = I18n.t("打开工具库");
  openLib.onclick = () => {
    if (typeof closeOverlay === "function") closeOverlay();
    if (typeof openToolsLibrary === "function") openToolsLibrary();
    else toast(I18n.t("工具库不可用"), "warn");
  };
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "mini primary";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = () => {
    if (typeof closeOverlay === "function") closeOverlay();
  };
  foot.append(openLib, closeBtn);
}

/* 在当前画布按工具库 id / 工具名找那个工具节点（找不到返回 null） */
function toolBuildFindToolNode(st) {
  const s = st || {};
  const nodes = (S && S.wf && S.wf.nodes) || [];
  const byId = nodes.find(
    (n) => n && s.toolLibId && String(n.toolLibId || "") === String(s.toolLibId),
  );
  if (byId) return byId;
  const byName = nodes.find(
    (n) =>
      typeof isToolNode === "function" &&
      isToolNode(n) &&
      s.toolName &&
      String((n.toolConfig && n.toolConfig.name) || n.title || "") === String(s.toolName),
  );
  return byName || null;
}

/* ── 主入口：开发工具 → 本文件实测 → 绿灯入工具库 ── */

async function buildToolForFile(consumerNode, filePath, plan) {
  const file = String(filePath == null ? "" : filePath).trim();
  if (!consumerNode) {
    toast(I18n.t("工具构建缺少处理节点"), "err");
    return { ok: false, error: I18n.t("缺少处理节点") };
  }
  if (!file) {
    toast(I18n.t("工具构建缺少文件路径"), "err");
    return { ok: false, error: I18n.t("缺少文件路径") };
  }
  if (typeof isToolNode !== "function" || typeof addNode !== "function") {
    toast(I18n.t("画布能力未就绪，无法搭建工具节点"), "err");
    return { ok: false, error: I18n.t("画布能力未就绪") };
  }
  const p = plan && typeof plan === "object" ? plan : {};
  const fileType = (typeof fileTypeOf === "function" && fileTypeOf(file)) || p.fileType || "other";
  const baseName = file.split(/[\\/]/).pop() || file;

  /* ── ① 建工具节点（泛用开发规则：工具节点 = super + tool:true，参数即端子） ── */
  const spot = findToolSpot(NODE_DEFAULTS.tool.w, NODE_DEFAULTS.tool.h);
  const toolTitle = uniqueNodeTitle(
    (p.toolName && String(p.toolName).trim()) || I18n.t("工具") + " · " + baseName,
    null,
  );
  let node = null;
  try {
    node = addNode("tool", spot.x, spot.y, { title: toolTitle });
  } catch (err) {
    node = null;
  }
  if (!node || !isToolNode(node)) {
    toast(I18n.t("工具节点创建失败"), "err");
    return { ok: false, error: I18n.t("工具节点创建失败") };
  }
  /* 注册构建状态：文件 / 类型 / 方案 + 状态 building（清掉上一次的成品登记） */
  if (typeof toolBuildBegin === "function") toolBuildBegin(node, file, p);
  toolBuildRunLog(node, I18n.t("开始构建：") + file + I18n.t("（类型：") + fileType + "）");
  /* toolConfig：file 文本入参 + 方案输出表（kind 只认 text / image）。
     若该工具的「开发」会话已抢先建好 file / outputs，则保留它的参数表（实测优先）。 */
  try {
    ensureFnToolNodeState(node);
    const c = node.toolConfig;
    c.name = toolTitle;
    c.description =
      String(p.approach || "").trim() ||
      I18n.t("解析 ") +
        (fileType || I18n.t("文件")) +
        I18n.t(" 文件（工具构建自动生成 · 输入 file = 文件绝对路径）");
    if (!toolBuildConfigHasFileParam(c)) {
      c.inputs = [
        {
          name: "file",
          kind: "text",
          desc: I18n.t("输入文件的绝对路径"),
          list: false,
        },
      ].concat(
        toolBuildPortArray(p.inputs, "text").filter(
          (e) => String(e.name || "").toLowerCase() !== "file",
        ),
      );
      const outs = toolBuildPortArray(p.outputs, "text").filter(
        (e) => String(e.name || "").trim() !== "",
      );
      c.outputs = outs.length ? outs : [{ name: "text", kind: "text" }];
    }
    /* 实测入参快照：file 位 = 本次文件（试跑台与「已启用工具」管理窗共用） */
    if (!Array.isArray(node.toolTestInputs)) node.toolTestInputs = [];
    node.toolTestInputs[0] = file;
  } catch (_) {}
  if (typeof scheduleSave === "function") {
    try {
      scheduleSave(true);
    } catch (_) {}
  }
  if (typeof renderCanvas === "function") {
    try {
      renderCanvas();
    } catch (_) {}
  }
  toolBuildRunLog(
    node,
    I18n.t("已建工具节点「") +
      toolTitle +
      I18n.t("」（落点 ") +
      Math.round(spot.x) +
      "," +
      Math.round(spot.y) +
      "）",
  );

  /* ── ② 绑定该工具的开发会话：后台运行（契约注入系统提示，留在画布） ── */
  let sess = null;
  try {
    sess = createToolBuildSessionForNode(node, "", file);
  } catch (err) {
    sess = null;
  }
  if (!sess) {
    toolBuildRunLog(node, I18n.t("开发会话创建失败"), "error");
    if (typeof toolBuildFailed === "function") toolBuildFailed(node, I18n.t("开发会话创建失败"));
    if (typeof refreshNodeUi === "function") refreshNodeUi(node);
    return { ok: false, error: I18n.t("开发会话创建失败"), toolNode: node };
  }
  if (typeof persistAgentSession === "function") {
    try {
      await persistAgentSession();
    } catch (_) {}
  }
  toolBuildRunLog(node, I18n.t("已创建开发会话「") + sess.title + "」· " + sess.id);
  let devErr = "";
  if (typeof agentSessionSend === "function") {
    try {
      /* 显式传 sessionId：即使画布还在动，这一轮也只落到这条绑定会话上；
         不 await（开发通常数分钟），改走下面的「等本轮结束」轮询 */
      const running = agentSessionSend("", { _devContract: true, sessionId: sess.id });
      if (running && typeof running.then === "function") running.catch(() => {});
    } catch (err) {
      devErr = (err && err.message) || String(err || "");
    }
  } else devErr = I18n.t("会话发送入口未就绪");
  if (!devErr) await toolBuildWaitTurnEnd(sess);
  const devText = toolBuildLastAssistantText(sess);
  toolBuildRunLog(
    node,
    I18n.t("开发会话本轮结束") +
      (devErr ? I18n.t("（异常：") + devErr + "）" : "") +
      (devText ? I18n.t(" · 结论：") + toolBuildBrief(devText, 400) : I18n.t("（会话无正文结论）")),
    devErr ? "warn" : "info",
  );

  /* ── ③ 本文件实测：失败回灌会话重试，最多 TOOLBUILD_TEST_ROUNDS_MAX 轮 ── */
  let res = null;
  let round = 0;
  for (round = 1; round <= TOOLBUILD_TEST_ROUNDS_MAX; round++) {
    await toolBuildWaitTurnEnd(sess);
    res = await toolBuildTestWithFile(node, file);
    toolBuildRunLog(
      node,
      I18n.t("第 ") + round + I18n.t(" 轮实测：") + toolBuildTestDigest(res),
      res && res.ok ? "info" : "warn",
    );
    if (res && res.ok) break;
    if (round >= TOOLBUILD_TEST_ROUNDS_MAX) break;
    if (typeof agentSessionSend !== "function") break;
    const errText = (res && res.error) || I18n.t("（错误信息为空）");
    const fix =
      I18n.t("【工具构建 · 本文件实测未通过，请修复后本轮内收尾】") +
      "\n" +
      I18n.t("实测文件：") +
      file +
      "\n" +
      I18n.t("试跑错误（工具节点「") +
      (toolDevNameOf(node) || toolTitle) +
      I18n.t("」）：") +
      "\n" +
      errText +
      "\n" +
      I18n.t(
        "请按此错误定位内部子图 / 参数表的问题并修好它；仍然只准改这一个工具节点与它的内部子图，不要动别的节点与连线。修完用一句话说明改了什么，宿主会自动重新实测。",
      );
    try {
      const rr = agentSessionSend(fix, { sessionId: sess.id });
      if (rr && typeof rr.then === "function") rr.catch(() => {});
    } catch (_) {}
    toolBuildRunLog(node, I18n.t("已把实测错误回灌开发会话（第 ") + round + I18n.t(" 轮）"), "warn");
  }
  if (!res || !res.ok) {
    if (typeof toolBuildFailed === "function")
      toolBuildFailed(
        node,
        I18n.t("本文件实测 ") +
          TOOLBUILD_TEST_ROUNDS_MAX +
          I18n.t(" 轮未通过：") +
          ((res && res.error) || ""),
        { filePath: file, fileType: fileType, toolName: toolDevNameOf(node) },
      );
    if (typeof refreshNodeUi === "function") refreshNodeUi(node);
    toast(
      I18n.t("工具构建未绿灯（实测 ") +
        TOOLBUILD_TEST_ROUNDS_MAX +
        I18n.t(" 轮未通过）：已记入节点日志"),
      "warn",
    );
    return {
      ok: false,
      error: (res && res.error) || I18n.t("实测未通过"),
      toolNode: node,
      sessionId: sess.id,
      rounds: round,
    };
  }

  /* ── ④ 绿灯 → 入工具库 + 回写状态 + 原处理节点上的「已启用工具」入口 ── */
  const toolName = toolDevNameOf(node) || toolTitle;
  let libId = String(node.toolLibId || "");
  let libErr = "";
  if (typeof saveToolFromCanvas === "function") {
    try {
      const saved = await saveToolFromCanvas(node);
      if (saved && saved.ok) libId = String(saved.id || libId);
      else if (!libId) libErr = I18n.t("未保存进工具库（用户取消或保存失败）");
    } catch (err) {
      libErr = (err && err.message) || String(err || "");
    }
  } else libErr = I18n.t("工具库保存入口未就绪");
  if (typeof toolBuildMarkReady === "function")
    toolBuildMarkReady(node, file, libId, toolName, "file");
  toolBuildRunLog(
    node,
    I18n.t("绿灯：") +
      toolName +
      I18n.t(" · 工具库 id=") +
      (libId || I18n.t("（未入库）")) +
      (libErr ? I18n.t("（") + libErr + I18n.t("）") : ""),
    libErr ? "warn" : "info",
  );
  /* 原处理节点：登记这支工具（UI 上显示「已启用工具：X」入口） */
  if (typeof toolBuildReady === "function")
    toolBuildReady(consumerNode, {
      filePath: file,
      fileType: fileType,
      toolLibId: libId,
      toolName: toolName,
      inputParam: "file",
    });
  toolBuildRunLog(consumerNode, I18n.t("已启用工具：") + toolName);
  if (typeof refreshNodeUi === "function") {
    try {
      refreshNodeUi(consumerNode);
    } catch (_) {}
  }
  try {
    toolBuildApplyReadyBadge(consumerNode);
    toolBuildApplyReadyBadge(node);
  } catch (_) {}
  toast(
    I18n.t("工具构建绿灯：") + toolName + I18n.t("（已用 ") + baseName + I18n.t(" 实测通过）"),
    "ok",
  );
  return {
    ok: true,
    toolNode: node,
    toolLibId: libId,
    toolName: toolName,
    inputParam: "file",
    filePath: file,
    sessionId: sess.id,
    rounds: round,
    libError: libErr,
  };
}

/* 中段出口（并入上半的 window.ToolBuild 命名空间） */
if (typeof window === "object" && window)
  window.ToolBuild = Object.assign(window.ToolBuild || {}, {
    PLAN_RUNKEY: TOOLBUILD_PLAN_RUNKEY,
    planToolBuildForFile,
    toolBuildAskEnable,
    toolBuildAskConfirm,
    toolBuildDetectFileType,
    toolBuildReadHead,
    toolBuildMagicType,
    toolBuildPlanPrompt,
    toolBuildExtractJson,
    toolBuildNormalizePlan,
    toolBuildPlanSummaryText,
    toolBuildOverlayConfirm,
  });

/* 下半出口（工具构建链 + UI） */
if (typeof window === "object" && window)
  window.ToolBuild = Object.assign(window.ToolBuild || {}, {
    TEST_ROUNDS_MAX: TOOLBUILD_TEST_ROUNDS_MAX,
    buildToolForFile,
    createToolBuildSessionForNode,
    toolBuildContractText,
    toolBuildWaitTurnEnd,
    toolBuildLastAssistantText,
    toolBuildTestWithFile,
    toolBuildTestDigest,
    toolBuildFindToolNode,
    toolBuildToolDialog,
    toolBuildApplyReadyBadge,
    toolBuildInstallBodyHook,
    toolBuildConfigHasFileParam,
    findToolSpot,
    toolBuildRunLog,
  });

/* 装卡片挂载钩子（幂等）：节点卡片渲染完成后补「已启用工具：X」入口 */
toolBuildInstallBodyHook();

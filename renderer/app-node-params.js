"use strict";
/* ============ 节点「参数」端子：用一份 JSON 覆写节点配置 ============
 *
 * 需求：所有插件节点、以及「存在配置」的节点，都在输入端**最末位**多一颗独立的
 * 「参数」端子。那条线上流过来的是一份 JSON 对象，运行时按「键 = 配置项」覆写该节点
 * 的配置（含路径，相对路径按画布工作目录解析）。
 *
 * 几条硬口径（与用户共识一致，改之前先读这一段）：
 *   1. 端子号不重排：参数端子用一个**哨兵端子号**（NP_PORT = 9001），不参与
 *      inputCount / 0..N-1 的顺序端口 —— 既有连线（首帧 / 末帧 / 参考图 / 工具参数…）
 *      的连接号一个都不动，老画布零迁移。代价：不能按 inputCount 数到它，要认常量。
 *   2. 哪些节点有它：以「已登记 ⚙ 设置窗」自动推导（NODE_SETTINGS_FORMS），再减一张
 *      排除表（纯流程 / 控制、时间与等待、网络、输入源与结构壳、工具与函数）。
 *      以后新节点只要登记了设置窗，就自动获得参数端子。
 *   3. 键名：只认节点现有的 camelCase 字段名（savePath / outputPath / imgQuality…），
 *      **区分大小写、不接受 snake_case / kebab-case 变体**（写错按未知键处理并警告）。
 *      完整键表与逐条说明见节点设置窗「参数覆写」右上的文档按钮（npOpenParamsDoc）。
 *   4. 只允许覆写**配置类字段**：结构字段（id / kind / batchMode / ro / 端子表…）与
 *      内容主体（提示词 / 正文 / task 描述 / JS 代码）写进来当未知键——忽略并警告。
 *      同名键在不同节点语义不同的，按节点类型豁免（见 NP_DENY_EXEMPT：steps 在 task 上
 *      是子步骤内容、在 video_gen 上是采样步数）。
 *   5. 生效方式：**运行时临时覆盖**，跑完恢复节点原值；不改画布、不写回节点。
 *      批量运行（batchMode=batch）时每次运行各自取当时那份参数。
 *   6. 多线：按接线顺序依次**深合并**（同键后者胜）；嵌套对象逐层合；数组整体替换；
 *      null = 该键恢复节点默认值；不支持删键。
 *   7. 异常：默认宽松（没写的键沿用节点值 / 未知键忽略 / 不合法键回退并标黄）；
 *      节点 ⚙ 里可开「参数严格校验」，开了就整份拒绝。
 *   8. 参数**只能从端子来**（用户口径）：canvas_edit 的 params 字段已经取消 —— 它会把
 *      一份参数直接挂到节点上（旧版 node.npParams），运行期压住 ⚙ 里的值，用户改不动。
 *      Agent 要给参数就建一颗 input_text 写 JSON、connect 到 9001；带 params 的编辑
 *      整笔拒绝（npEditParamsRejection）。老画布上的 npParams 由 npPurgeLegacyParams 清掉。
 *
 * 真源分工：本文件 = 参数端子的判定 / 合并 / 套用 / 设置窗明细 / JSON 表单；
 * app.js = 端子常量与连线几何（PARAM_IN_INDEX / isParamWire / inPos）；
 * app-canvas.js = 端子渲染与文本节点的 JSON 表单挂载点；
 * app-nodes.js = playNode 的运行时套用与 connectError 的参数端子分支。
 */

/* 哨兵端子号：与 app.js 的 PARAM_IN_INDEX 必须同值（那边是常量真源，这里只抄一份） */
const NP_PORT = typeof PARAM_IN_INDEX === "number" ? PARAM_IN_INDEX : 9001;

/* 排除表：这些节点不长参数端子（理由写在每行）。其余「有设置窗」的节点一律有。 */
const NP_EXCLUDE_KINDS = {
  /* 纯流程与控制：它们的「配置」就是接线与流程结构本身 */
  control: 1,
  judge: 1,
  gate: 1,
  splitter: 1,
  counter: 1,
  mutex: 1,
  sequencer: 1,
  delayer: 1,
  /* 时间与等待：只有时间 / 路径两三个字段，参数化收益有限 */
  timer: 1,
  wait_file: 1,
  /* 网络：端口与通道号被覆写容易把两侧对不上 */
  net_recv: 1,
  net_send: 1,
  /* 输入源与结构壳：没有可覆写的运行配置 */
  input_text: 1,
  input_image: 1,
  input_audio: 1,
  input_video: 1,
  input_any: 1,
  input_file: 1,
  asset: 1,
  super: 1,
  deliver: 1,
  ltout: 1,
  ltart: 1,
  db_table: 1,
  db_replica: 1,
  __empty__: 1,
};

/* 不允许被覆写的键：结构字段 + 运行期脏字段 + 内容主体（内容走连线，不走参数）。 */
const NP_DENY_KEYS = {
  id: 1, kind: 1, title: 1, w: 1, h: 1, x: 1, y: 1, note: 1, tags: 1,
  ro: 1, batch: 1, batchMode: 1, entries: 1, items: 1,
  text: 1, prompt: 1, task: 1, goal: 1, steps: 1, jscode: 1, description: 1,
  files: 1, tableDef: 1, rows: 1, toolConfig: 1,
  devStatus: 1, devFiles: 1, devPath: 1, devKind: 1, devColor: 1, devModel: 1,
  devProvider: 1, devPreset: 1, devEffort: 1,
  parentSuperId: 1, superOpen: 1, super: 1,
  outputPaths: 1, outputText: 1, pluginStatus: 1, error: 1, running: 1,
  attemptsDone: 1, ranAt: 1, output: 1, selected: 1, collapsed: 1, expanded: 1,
  /* 运行态 / 产物字段：能「覆写」它们没有任何意义（还容易被当成配置误传） */
  savedPath: 1, savedPaths: 1, savedAt: 1, savedDir: 1, autoSavePath: 1, saveAt: 1,
  boundFromId: 1, portOutputs: 1, batchOutputs: 1, lastError: 1, status: 1, progress: 1,
  yamlOff: 1, anyFile: 1, imageAsset: 1, sourceName: 1, mediaAsset: 1,
  assetId: 1, assetRel: 1, assetName: 1, assetDesc: 1,
  /* 运行期状态 / 端子迁移标记 / 绑定关系：不是「配置」，覆写它们只会让节点行为错乱
     （这些值由节点自己维护：进度、参考源回显、旧档迁移标记、绑定的保存节点）。 */
  messages: 1, convH: 1, inputH: 1, agentSessionId: 1, artifacts: 1, refSource: 1,
  remotionPct: 1, tsx: 1, tsxTsx: 1, boundSaveId: 1,
  videoPortV2: 1, videoPortV3: 1, videoPortV4: 1, videoPortV5: 1, remotionPortsV2: 1,
  wfMeta: 1, wfParamValues: 1, wfPortMap: 1, bgRmPairs: 1,
};
/* lt*（长周期任务的绑定字段）与一批运行期字段按前缀排除；*Status 是节点自己写的运行态 */
const NP_DENY_PREFIX = ["lt", "np"];

/* 同名键的按节点类型豁免（键 → 类型）。上面的名单是**全局**的，为「内容 / 结构」而设，
   但同一个名字在另一些节点上是正式配置 —— 典型是 `steps`：task 节点是子步骤标题数组
   （内容，走连线 / 节点字段），video_gen（Minimax H3）是采样步数（数字，NODE_DEFAULTS 里
   默认 20，运行时 Number(node.steps) || 20 下发给后端）。全局名单把后者一起拦了，跑 H3
   时就弹「steps 是结构 / 内容字段」并丢掉这个配置。这里只放开点名的键，其余照旧禁止。 */
const NP_DENY_EXEMPT = {
  video_gen: { steps: "number" },
};

function npIsDeniedKey(k, node) {
  const s = String(k || "");
  if (!s) return true;
  const ex = node && node.kind ? NP_DENY_EXEMPT[node.kind] : null;
  if (ex && Object.prototype.hasOwnProperty.call(ex, s)) return false;
  if (NP_DENY_KEYS[s]) return true;
  if (/Status$/.test(s)) return true;
  for (const p of NP_DENY_PREFIX) if (s.indexOf(p) === 0 && s.length > p.length) {
    /* lt* / np* 一律不进参数口（长周期绑定 + 参数自身的运行期字段） */
    return true;
  }
  return false;
}

/* 被拒时的说明：同名键另有正确写法时直接指路，别只说「不能覆写」 */
function npDenyHint(key, node) {
  const kind = (node && node.kind) || "";
  if (key === "steps" && (kind === "task" || kind === "agent_task"))
    return I18n.t("是该节点的子步骤内容，不能由参数覆写（请用节点 steps 字段 / canvas_edit 的 steps）");
  return I18n.t("是结构 / 内容字段，不能由参数覆写（已忽略）");
}

/* 键名口径：**只认正式名**（camelCase，区分大小写）。
   曾经也收下划线 / 短横线变体，但那让「写错键」变成静默成功（`output_path` 与
   `outputPath` 都对，Agent 就会继续猜别的写法），现在一律按未知键警告/拒绝。 */

function npIsParamIndex(i) {
  return Number(i) === NP_PORT;
}

/* 参数端子 Y 坐标：与 ordinary 端子同一套带宽（复用 app.js 的 inPortY），
   位置 = 排在现有全部输入端子之后的那一颗（画布渲染与连线几何共用这一处）。
   **必须留在卡片内**：端子多的节点（H3 的 R2V 有 16 个数据端子 + 控制口）按「最后一颗
   再下一格」会算到卡片下沿之外；端子圆点跑到卡片外的空中，连线端点也跟着在卡片外，
   看起来就是「线与端子分家」。上限压到底部留白内（圆心离下边框 ≥ PORT_R + 5）。 */
function npPortY(node) {
  if (!node || typeof inPortY !== "function") return 0;
  const ic = Math.max(0, Number(inputCount(node)) || 0);
  const y = inPortY(node, ic, ic);
  const h =
    typeof nodePortHeight === "function"
      ? Number(nodePortHeight(node)) || 0
      : Number(node.h) || 0;
  if (h <= 0) return y;
  const r = typeof PORT_R === "number" ? PORT_R : 5;
  return Math.min(y, Math.max(45, h - r - 5));
}

/* ───────────── 哪些节点有参数端子 ───────────── */

function npSettingsFormKey(node) {
  if (typeof nodeSettingsFormKey !== "function") return "";
  try {
    return nodeSettingsFormKey(node) || "";
  } catch (_) {
    return "";
  }
}

function npEligible(node) {
  if (!node || !node.kind) return false;
  if (NP_EXCLUDE_KINDS[node.kind]) return false;
  if (node.ro) return false;
  /* 函数 / 工具节点：也长「参数」端子，但语义不同 —— JSON 原样注入函数体 / 工具子图
     （input.params），不套节点字段白名单。判定同样走 NParam.eligible，连线校验、
     端子绘制、运行包装三处共用。 */
  if (typeof isFnToolNode === "function" && isFnToolNode(node)) return true;
  if (typeof isAssetNode === "function" && isAssetNode(node)) return false;
  const key = npSettingsFormKey(node);
  if (!key || !NODE_SETTINGS_FORMS || !NODE_SETTINGS_FORMS[key]) return false;
  return true;
}

/* ───────────── 可覆写键表（schema） ───────────── */

function npTypeOfValue(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "any";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return "object";
  return "string";
}

/** 该节点的可覆写键 → { key: { type, def } }（顺序 = 节点默认字段顺序）。 */
function npAllowedMap(node) {
  const out = Object.create(null);
  if (!node || !npEligible(node)) return out;
  /* 函数 / 工具节点：参数 JSON 原样进 input.params，不覆写节点字段 → 没有「可覆写键表」 */
  if (typeof isFnToolNode === "function" && isFnToolNode(node)) return out;
  if (typeof isPluginKind === "function" && isPluginKind(node)) {
    const def = (typeof pluginNodeDef === "function" ? pluginNodeDef(node) : null) || {};
    const modelish = !!(def.call && def.call.kind === "model");
    if (modelish || def.providerId != null || true) {
      out.providerId = { type: "string", def: "" };
      out.model = { type: "string", def: "" };
      out.temperature = { type: "number", def: 0.7 };
      out.effort = { type: "string", def: "high" };
    }
    /* 插件自己的参数（node.pluginParams.<id>）：在参数 JSON 里写 pluginParams 对象 */
    const params = def.params || [];
    if (params.length) {
      const bag = {};
      for (const p of params) {
        const t = p.type === "number" ? "number" : p.type === "checkbox" ? "boolean" : "string";
        bag[p.id] = { type: t, def: p.def };
      }
      out.pluginParams = { type: "object", def: bag, fields: bag };
    }
    return out;
  }
  const defaults = (typeof NODE_DEFAULTS === "object" && NODE_DEFAULTS && NODE_DEFAULTS[node.kind]) || null;
  if (defaults) {
    for (const k of Object.keys(defaults)) {
      if (npIsDeniedKey(k, node)) continue;
      out[k] = { type: npTypeOfValue(defaults[k]), def: defaults[k] };
    }
  }
  /* 豁免表里点名、但节点默认字段里没有的键（按表里的类型补，保证豁免真的可用） */
  const exempt = NP_DENY_EXEMPT[node.kind];
  if (exempt) {
    for (const k of Object.keys(exempt)) {
      if (!out[k]) out[k] = { type: exempt[k], def: undefined };
    }
  }
  /* 设置窗里有、默认字段里没有的常见配置（按需补；没有就靠下面这张小表兜住） */
  for (const k of NP_EXTRA_KEYS[node.kind] || []) {
    if (out[k] || npIsDeniedKey(k, node)) continue;
    out[k] = { type: "string", def: "" };
  }
  return out;
}
/* 少数「设置窗里有、NODE_DEFAULTS 里没有」的配置项（保持显式，不猜） */
const NP_EXTRA_KEYS = {
  save_pdf: ["pageSize", "margin", "fontScale"],
  remotion: ["backgroundColor"],
  video_gen: ["outputPath", "duration", "attempts", "outputRes", "postEnabled", "postInterp"],
  /* 角色 / 组名（值是名称，运行期翻译成 presetId / presetGroupId —— 见 npRunWithParams） */
  breeze_gen: ["breezePreset", "breezeGroup"],
};

/** canvas_get / 设置窗用的 schema 列表。 */
function npSchemaOf(node) {
  const map = npAllowedMap(node);
  return Object.keys(map).map((k) => ({
    key: k,
    type: map[k].type,
    def: map[k].def,
    now: node ? node[k] : undefined,
  }));
}

/* ───────────── 参数说明表（「参数覆写」右上文档按钮的数据源） ─────────────
   一条 = 一个可覆写键的一句话说明：写「这个键管什么 / 取值范围 / 空值含义」，
   不写营销话术。键名与节点字段名逐字一致（camelCase）；新节点加了配置项就在这里补一条，
   漏了也能用（文档窗会按类型 + 默认值兜一句），但补上才算完整。 */
const NP_KEY_DOC = {
  /* ── 服务商 / 模型 ── */
  providerId: "服务商：本机服务商 id 或名称；本机没有会自动按名称 / 模型归属替换",
  provider: "服务商 / 智能路由（Agent 类节点用这个键）",
  model: "模型 id；空 = 用该服务商的默认模型",
  temperature: "采样温度 0–2，越高越发散",
  effort: "思考强度：off / low / medium / high / xhigh / max（off = 无 = 关闭思考）",
  preset: "Agent 预设档（standard / code / lean…）",
  think: "think 模式：先想再画",
  /* ── Agent 行为 ── */
  agent: "按智能节点运行（可调用工具、改画布）",
  agentWorkspace: "Agent 工作目录；相对路径按画布工作目录解析",
  agentPerm: "权限：canvas 工作区沙箱 / super 全主机",
  agentPermOutside: "沙箱外路径：ask 每次询问 / direct 直接访问",
  agentPermAlwaysPaths: "已放行的外部路径清单（字符串数组）",
  chatMode: "会话模式：节点与会话内容同步",
  workspace: "工作目录；相对路径按画布工作目录解析",
  globalRefs: "允许本节点 @引用全局广播的节点",
  /* ── 通用生成参数 ── */
  attempts: "抽卡次数 1–10；多次时输出带 #1、#2…",
  seed: "随机种子；0 = 每次随机",
  rerollSeed: "每次运行后种子 +1（连抽不同结果）",
  steps: "采样步数（Minimax H3）：越多越细、越慢，常用 20；task 节点的子步骤不走这个键",
  duration: "时长（秒）",
  fps: "帧率 1–60",
  size: "尺寸 / 画幅（图像尺寸档，或视频分辨率 宽x高）",
  outputPath: "输出路径；相对路径按画布工作目录，空 = 默认目录",
  filename: "输出文件名；空 = 自动命名",
  filenamePrefix: "输出文件名前缀（可含子目录）",
  outputRes: "输出分辨率：auto / 480p / 720p / 1080p",
  offload: "auto CPU offload（显存紧张时开）",
  /* ── 音乐 / 语音 ── */
  audioDuration: "音乐时长（秒）",
  style: "风格提示词（曲风 / 情绪 / 编制）",
  lyrics: "歌词正文（结构标签独占一行）",
  abc: "ABC 谱面；空 = 按歌词生成",
  cot: "YuE2 思维链档：full / melody / off",
  srcText: "待合成正文；端口 0 有输入时以端口为准",
  refText: "参考文稿；端口 2 有输入时以端口为准",
  instruction: "音色指令：性格与语气",
  voice: "音色 id；空 = 用端口 1 的参考音频",
  voiceMode: "音色能力：auto / clone / design / direction",
  breezePreset: "角色名称（不是 id）：按名称匹配，匹配不到再按 id；对不上 = 状态行报错并停止这次合成。不给则用节点上已选的角色",
  breezeGroup: "组名（该角色下的样本组）：组名 / 「第 N 组」/ 组 id 都认；不给 = 该角色第一组；对不上 = 报错停跑。只给组名而节点没选角色同样报错",
  cfgScale: "指令 / CFG 强度（默认 4）",
  ttsFormat: "输出格式：wav / flac / mp3",
  /* ── 图像 ── */
  imgQuality: "图像质量：low / medium / high / xhigh / max / auto",
  imgBackground: "图像背景：transparent / opaque / auto",
  bgRmOn: "透明背景：双通道差分抠图",
  bgRmKey: "旧色键抠图遗留字段（已不参与算法）",
  bgRmTol: "差分抠图噪点地板（tol）",
  bgRmSoft: "差分抠图边缘羽化（soft）",
  bgRmAlign: "差分抠图第二通道自动对齐",
  ratioLockOn: "画幅锁定：与首参考图保持一致长宽比",
  ratioLockMode: "锁定档：auto 自动挑 / size 跟随节点尺寸",
  ratioPadFill: "补边填充：edge / mirror / white / black / custom",
  ratioPadColor: "custom 补边颜色（#rrggbb）",
  ratioLockExact: "出图后缩放回参考图原始像素",
  maskOn: "蒙版局部重绘开关",
  maskPath: "蒙版图路径（Alpha，透明区 = 重绘区）",
  maskBrush: "蒙版笔刷尺寸（像素）",
  maskFeather: "蒙版羽化半径（像素）",
  /* ── 本地图像（分辨率桶 / 步数 / 显存）── */
  ratioBucket: "分辨率桶（官方 11 个训练桶之一，如 1:1 / 16:9）",
  width: "输出宽（像素，由分辨率桶决定）",
  height: "输出高（像素，由分辨率桶决定）",
  numSteps: "采样步数（默认 30）",
  imgCfgScale: "参考图条件强度；1.0 = 关闭",
  vramMode: "显存档位：full / fast / balanced / low",
  /* ── 视频生成（H3）── */
  videoMode: "模式：fl2va 首末帧 / r2v 多参考",
  ratio: "尺寸比例：16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9",
  sampler: "采样器（res_multistep / euler / dpmpp_2m…）",
  scheduler: "调度器：simple / normal / karras / exp",
  denoise: "去噪强度 0–1",
  shiftVideo: "视频位移 shift（默认 12）",
  shiftAudio: "音频位移 shift（默认 3）",
  easyReuse: "EasyCache 复用阈值（0.01–0.2，越小越稳）",
  easyStart: "EasyCache 生效起点（0.15–0.6）",
  easyEnd: "EasyCache 生效终点（0.6–1）",
  lowVramHeadChunks: "LowVRAM head 分块数",
  chunkFfnChunks: "ChunkFFN 分块数",
  chunkFfnSeqThreshold: "ChunkFFN 序列阈值",
  sageMode: "Sage 注意力模式：auto / disabled…",
  sageCompile: "Sage 编译（需 Sage，更慢更占显存）",
  optEasyCache: "24G 优化：EasyCache（约 1.4–2×）",
  optSageAttn: "24G 优化：Sage Attention（需 triton + sageattention）",
  optLowVramAttn: "24G 优化：按 head 分块降峰值显存",
  optChunkFfn: "24G 优化：FFN 分块降峰值显存",
  optVramBarrier: "24G 优化：VAE 前卸模型，避免双 VAE OOM",
  refImageSize: "参考图尺寸：match 缩放匹配 / max 短边 2048",
  bitDepth: "位深：8 / 16",
  videoFormat: "封装格式：auto / mp4 / webm",
  videoCodec: "编解码：auto / h264 / vp9",
  chainEnabled: "衔接上一段视频（开启后多一个「上一段视频」端子）",
  chainFrames: "衔接引导帧数 1–60",
  chainDenoise: "衔接重绘幅度 0–1；0 = 纯引导",
  chainMention: "R2V 衔接时自动补写续写声明",
  workflowId: "自建 ComfyUI 工作流 id；空 = 用内置工作流",
  wfParams: "自建工作流的参数映射表",
  customOutputNodeId: "自建工作流的输出节点 id",
  /* ── 视频后处理 ── */
  scale: "超分倍率：2 / 4",
  targetLongSide: "目标长边像素 1280–7680",
  perBatch: "逐帧批量 per_batch",
  tile: "分块 tile 像素；0 = 后端默认 512",
  lowVram: "低显存安全档（强制逐帧）",
  multiplier: "补帧倍率：1 / 2 / 4",
  clearCacheEvery: "每 N 帧清一次缓存",
  batchSize: "逐帧批量 batch_size",
  scaleFactor: "RIFE 缩放系数（1.0 = 原分辨率）",
  precision: "精度：fp16 等",
  /* ── Remotion ── */
  bgColor: "内置台词卡左侧底色（#rrggbb）",
  /* ── 保存 ── */
  savePath: "保存路径；相对路径按画布工作目录，后缀按输入类型固定",
  auto: "上游一更新就自动保存",
  oopMode: "图像输出尺寸：orig 原样 / scale 按比例 / custom 指定像素",
  oopCrop: "裁剪：none / center 居中 / manual 指定矩形",
  oopFormat: "图像输出格式：png / jpg / webp / bmp",
  oopScale: "缩放比例 %（oopMode=scale 时生效）",
  oopWidth: "输出像素宽（oopMode=custom 时生效）",
  oopHeight: "输出像素高（oopMode=custom 时生效）",
  oopCropX: "裁剪矩形 x（源图像素）",
  oopCropY: "裁剪矩形 y（源图像素）",
  oopCropW: "裁剪矩形宽（源图像素）",
  oopCropH: "裁剪矩形高（源图像素）",
  oopQuality: "有损压缩质量 0–1（JPG / WebP）",
  pdfPageSize: "纸张：A4 / A3 / A5 / Letter / Legal",
  pdfLandscape: "横向排版（true = 横向）",
  pdfMargin: "页边距：none / narrow / normal / wide",
  pdfFontScale: "字号档：s / m / l",
  pdfPageNumbers: "页脚页码开关",
  pdfTitle: "PDF 标题；空 = 用输入节点标题",
  /* ── 可执行节点 ── */
  execPath: "要运行的程序 / 脚本绝对路径",
  execIcon: "节点图标：auto / rocket / gear / terminal…",
  execColor: "节点外框色（#rrggbb）",
};

/** 一个键的说明；没有收录时按类型 + 默认值兜一句（文档窗不留空）。 */
function npKeyDoc(key, info) {
  const hit = NP_KEY_DOC[String(key || "")];
  if (hit) return hit;
  if (/(Path|path)$/.test(String(key))) return "路径；相对路径按画布工作目录解析";
  const t = (info && info.type) || "any";
  return "该节点的 " + t + " 配置项";
}

/* ───────────── 读参数线 + 深合并 ───────────── */

function npParamWires(node) {
  if (!node || !S.wf || !Array.isArray(S.wf.wires)) return [];
  return S.wf.wires.filter(
    (w) => w && !w.rel && w.to === node.id && Number(w.toIndex) === NP_PORT,
  );
}

function npSourceText(node, w) {
  const src = typeof nodeById === "function" ? nodeById(w.from) : null;
  if (!src) return "";
  let v = null;
  try {
    v = typeof valueForInput === "function" ? valueForInput(src, Number(w.fromIndex || 0), node) : null;
  } catch (_) {
    v = null;
  }
  if (v && v.text != null) return String(v.text);
  if (v && v.image) return String(v.image);
  if (v && v.items && v.items.length)
    return v.items.map((i) => i.content ?? i.text ?? i.title ?? "").join("\n");
  return "";
}

function npIsPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 深合并：对象逐层合、数组整体替换、标量后者胜（null 也照写，由套用阶段解释）。 */
function npDeepMerge(base, patch) {
  if (!npIsPlainObject(patch)) return patch;
  const out = npIsPlainObject(base) ? Object.assign({}, base) : {};
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (npIsPlainObject(pv) && npIsPlainObject(out[k])) out[k] = npDeepMerge(out[k], pv);
    else out[k] = pv;
  }
  return out;
}

/** 读这个节点当前**全部**参数线 → { values, warnings, errors, sources, strict } */
function npRead(node) {
  const res = { values: {}, warnings: [], errors: [], sources: [], strict: !!(node && node._npStrict) };
  if (!node) return res;
  /* 只认参数线（端子 9001）。旧版 canvas_edit 的 params 写进 node.npParams 的那条路
     已经取消 —— 它就是「用户改了 ⚙ 却压不住」的根因，这里不再读它。 */
  const wires = npParamWires(node);
  for (const w of wires) {
    const src = typeof nodeById === "function" ? nodeById(w.from) : null;
    const label = (src && src.title) || (src && src.id) || I18n.t("上游");
    const text = npSourceText(node, w);
    if (!String(text || "").trim()) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      res.errors.push(I18n.t("参数线「") + label + I18n.t("」不是合法 JSON：") + (e.message || e));
      continue;
    }
    if (!npIsPlainObject(parsed)) {
      res.errors.push(I18n.t("参数线「") + label + I18n.t("」必须是 JSON 对象（{…}），数组不是一份参数表"));
      continue;
    }
    res.values = npDeepMerge(res.values, parsed);
    res.sources.push({ id: src && src.id, title: label });
  }
  /* 键名校验：未知键 / 结构字段 → 警告；类型不符 → 警告（宽松）或错误（严格） */
  const allowed = npAllowedMap(node);
  const clean = {};
  for (const rawKey of Object.keys(res.values)) {
    const key = Object.prototype.hasOwnProperty.call(allowed, rawKey) ? rawKey : "";
    const bad = (msg) => {
      const line = I18n.t("参数键「") + rawKey + I18n.t("」") + msg;
      if (res.strict) res.errors.push(line);
      else res.warnings.push(line);
    };
    if (!key) {
      bad(
        npIsDeniedKey(rawKey, node)
          ? npDenyHint(rawKey, node)
          : I18n.t("不是本节点可覆写的配置项（已忽略）"),
      );
      continue;
    }
    const want = allowed[key].type;
    const val = res.values[rawKey];
    if (val === null) {
      clean[key] = null; /* 恢复默认，套用阶段解释 */
      continue;
    }
    /* 数字宽容：字符串数字（"20"）按数字收下并转成数字，让上游 JSON 把数字写成字符串时
       不再静默失效；空串 / 非数字文本 / 对象仍按类型不符回退节点值。 */
    const numStr =
      want === "number" && typeof val === "string" && String(val).trim() !== "" && isFinite(Number(val));
    const ok =
      want === "any" ||
      want === "string" && (typeof val === "string" || typeof val === "number" || typeof val === "boolean") ||
      want === "number" && typeof val === "number" && isFinite(val) ||
      numStr ||
      want === "boolean" && typeof val === "boolean" ||
      want === "object" && npIsPlainObject(val) ||
      want === "array" && Array.isArray(val);
    if (!ok) {
      bad(I18n.t("的类型应是 ") + want + I18n.t("（收到 ") + npTypeOfValue(val) + I18n.t("，已回退节点值）"));
      continue;
    }
    clean[key] =
      want === "number" && typeof val === "string"
        ? Number(val)
        : want === "string" && typeof val !== "string"
          ? String(val)
          : val;
  }
  res.values = clean;
  return res;
}

/* ═════════════ 函数 / 工具节点的「参数」端子（9001）═════════════
   与上面「配置覆写」是两条路，别混：
   · 配置覆写（npRead / npApplyValues）：键 = 节点字段，跑完恢复，只给有设置窗的节点；
   · 本段：JSON **原样**交给函数体 / 工具子图，不查节点字段白名单，不改任何节点字段。
     - 函数节点：注入 jscode 的 input.params（无默认、无线 = {}）；
     - 工具节点：作为本次工具子图的共享参数，内部函数节点沿 parentSuperId 就近继承
       （自己的 9001 / 默认 JSON 优先于祖先）。
   · 默认值：node.paramsJson（⚙ 里手写的一份 JSON，空 = 没有）；9001 连线按接线顺序
     深合并覆盖（同键后者胜）。
   · 校验宽松：非法 JSON / 非对象 → 记一笔警告并忽略那一份；节点 ⚙ 开了「参数严格校验」
     （node._npStrict）则整份拒绝、本次不跑。
   · 本轮运行期的共享参数压在 NP_FN_PARAMS 里（节点 id → 对象），跑完删除，
     绝不写回画布。 */
const NP_FN_PARAMS = new Map();

/** JSON 文本 → 纯对象：{} / 空串 = 空对象；不合法返回 { error }。 */
function npParseParamObject(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return { value: {} };
  let parsed = null;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  if (!npIsPlainObject(parsed))
    return { error: I18n.t("必须是 JSON 对象（{…}），数组不是一份参数表") };
  return { value: parsed };
}

/** 节点自己那份参数：默认 JSON（⚙）+ 9001 各线深合并。sources / 诊断一并带回。 */
function npFnOwnParams(node) {
  const res = { values: {}, warnings: [], errors: [], sources: [] };
  if (!node) return res;
  const def = npParseParamObject(node.paramsJson);
  if (def.error)
    res.warnings.push(
      I18n.t("默认参数 JSON 不是合法对象（已按空对象跑）：") + def.error,
    );
  else res.values = npDeepMerge(res.values, def.value);
  for (const w of npParamWires(node)) {
    const src = typeof nodeById === "function" ? nodeById(w.from) : null;
    const label = (src && src.title) || (src && src.id) || I18n.t("上游");
    const text = npSourceText(node, w);
    if (!String(text || "").trim()) continue;
    const r = npParseParamObject(text);
    if (r.error) {
      res.errors.push(I18n.t("参数线「") + label + I18n.t("」不是合法参数对象：") + r.error);
      continue;
    }
    res.values = npDeepMerge(res.values, r.value);
    res.sources.push({ id: src && src.id, title: label });
  }
  return res;
}

/** 祖先工具 / 函数节点（由近到远，不含自己）：工具子图里的函数节点按它就近继承参数。 */
function npFnAncestors(node) {
  const out = [];
  if (!node || typeof nodeById !== "function") return out;
  let cur = node;
  for (let depth = 0; depth < 8; depth++) {
    const pid = String((cur && cur.parentSuperId) || "");
    if (!pid) break;
    const p = nodeById(pid);
    if (!p) break;
    if (typeof isFnToolNode === "function" && isFnToolNode(p)) out.push(p);
    cur = p;
  }
  return out;
}

/** 这次运行该用的参数对象（自身 + 祖先继承；自身优先）。 */
function fnParamsForNode(node) {
  if (!node) return {};
  let values = {};
  /* 远祖先 → 近祖先 → 自己（越近越权威） */
  const chain = npFnAncestors(node).reverse();
  for (const anc of chain) {
    const hit = NP_FN_PARAMS.get(anc.id);
    if (hit && npIsPlainObject(hit)) {
      values = npDeepMerge(values, hit);
      continue;
    }
    values = npDeepMerge(values, npFnOwnParams(anc).values);
  }
  const own = NP_FN_PARAMS.get(node.id);
  values = npDeepMerge(values, npIsPlainObject(own) ? own : npFnOwnParams(node).values);
  return values;
}

/** 函数 / 工具节点的「参数」端子入口：读参数 → 压进 NP_FN_PARAMS → 跑 → 清掉。
    没有参数线、没有默认 JSON、也没有祖先时就是一次直通（零开销）。 */
async function npFnRunWithParams(node, fn) {
  if (!node || !(typeof isFnToolNode === "function" && isFnToolNode(node)))
    return await fn();
  const read = npFnOwnParams(node);
  if (typeof toast === "function") {
    for (const w of read.warnings) toast(w, "warn");
    for (const e of read.errors) toast(e, "warn");
  }
  if (node._npStrict && read.errors.length)
    throw new Error(I18n.t("参数严格校验未通过：") + read.errors.join(I18n.t("；")));
  NP_FN_PARAMS.set(node.id, read.values);
  try {
    return await fn();
  } finally {
    NP_FN_PARAMS.delete(node.id);
  }
}

/* ───────────── 路径：相对路径按画布工作目录解析 ───────────── */

function npIsAbsPath(p) {
  const s = String(p || "").trim();
  if (!s) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (/^[\\/]{2}/.test(s)) return true;
  if (/^[\\/]/.test(s)) return true;
  return false;
}

function npPathBase() {
  try {
    const ws = typeof wfWorkspace === "function" ? String(wfWorkspace() || "").trim() : "";
    return ws;
  } catch (_) {
    return "";
  }
}

function npJoinPath(base, rel) {
  if (!base) return rel;
  const b = String(base).replace(/[\\/]+$/, "");
  const r = String(rel).replace(/^[\\/]+/, "");
  const sep = /\\/.test(b) || /^[A-Za-z]:/.test(b) ? "\\" : "/";
  return b + sep + r.replace(/[\\/]+/g, sep);
}

/** 路径类键（…Path / workspace / dir / root / folder）里的相对路径 → 按工作目录补绝对路径。
    与 save 节点「相对工作目录」同一口径；没有工作目录就原样保留（下游自己会带默认提示）。 */
function npResolvePathValue(key, val) {
  if (typeof val !== "string" || !val.trim()) return val;
  if (!/(Path|path|workspace|Workspace|dir|Dir|root|Root|folder|Folder)$/.test(String(key))) return val;
  if (npIsAbsPath(val)) return val;
  if (/^(https?|file|data):/i.test(val)) return val;
  const base = npPathBase();
  if (!base) return val;
  return npJoinPath(base, val);
}

/* ───────────── 运行时套用（临时覆盖 + 跑完恢复） ───────────── */

/* 节点 id → 本轮生效的参数摘要（只影响界面标识，不进画布快照） */
const NP_ACTIVE = new Map();

function npDefaultOf(node, key) {
  const defs = (typeof NODE_DEFAULTS === "object" && NODE_DEFAULTS && NODE_DEFAULTS[node.kind]) || {};
  if (Object.prototype.hasOwnProperty.call(defs, key)) return defs[key];
  return undefined;
}

/** 把一份参数套到节点上（临时）；返回 restore()。pluginParams 走浅合并 + 还原。 */
function npApplyValues(node, read) {
  const saved = [];
  const applied = {};
  const keys = Object.keys(read.values || {});
  for (const key of keys) {
    const val = read.values[key];
    if (key === "pluginParams") {
      const cur = npIsPlainObject(node.pluginParams) ? Object.assign({}, node.pluginParams) : {};
      saved.push(() => {
        node.pluginParams = cur;
      });
      node.pluginParams = npDeepMerge(cur, val);
      applied[key] = val;
      continue;
    }
    const had = Object.prototype.hasOwnProperty.call(node, key);
    const old = node[key];
    const nextVal =
      val === null ? npDefaultOf(node, key) : npResolvePathValue(key, val);
    if (nextVal === undefined && val === null) {
      /* 默认值不存在：该键不写，保持原样 */
      read.warnings.push(I18n.t("参数键「") + key + I18n.t("」没有节点默认值，null 已忽略"));
      continue;
    }
    saved.push(() => {
      if (had) node[key] = old;
      else delete node[key];
    });
    node[key] = nextVal;
    applied[key] = nextVal;
  }
  return {
    applied,
    restore() {
      for (let i = saved.length - 1; i >= 0; i--) {
        try {
          saved[i]();
        } catch (_) {
          /* 恢复失败不能让一次运行挂掉 */
        }
      }
    },
  };
}

/** 包住一次节点运行：先套参数 → 跑 → finally 恢复。没有参数线时零开销。
    函数 / 工具节点走另一条路（npFnRunWithParams）：JSON 原样注入 input.params，
    不覆写节点字段。 */
async function npRunWithParams(node, fn) {
  if (!node || !npEligible(node)) return fn();
  if (typeof isFnToolNode === "function" && isFnToolNode(node))
    return npFnRunWithParams(node, fn);
  const wires = npParamWires(node);
  if (!wires.length) return fn();
  const read = npRead(node);
  /* 上一次运行留下的「角色 / 组名没对上」标记先作废（本节点每次运行重新判定） */
  delete node._npPresetError;
  /* breeze_gen 的角色 / 组名：参数值是**名称**（不是 id），先翻译成 presetId / presetGroupId
     再走通用覆写。对不上不抛异常（抛了没人接，状态行一片空白）—— 记在节点上，
     由 playBreezeGenNode 落到状态行红字并停下这次合成。 */
  if (node.kind === "breeze_gen" && typeof breezeParamPicks === "function") {
    const hasPreset = Object.prototype.hasOwnProperty.call(read.values, "breezePreset");
    const hasGroup = Object.prototype.hasOwnProperty.call(read.values, "breezeGroup");
    if (hasPreset || hasGroup) {
      const presetText = hasPreset ? read.values.breezePreset : "";
      const groupText = hasGroup ? read.values.breezeGroup : "";
      delete read.values.breezePreset;
      delete read.values.breezeGroup;
      let picks = null;
      try {
        picks = await breezeParamPicks(node, presetText, groupText);
      } catch (e) {
        picks = { error: I18n.t("解析角色参数失败：") + ((e && e.message) || String(e)) };
      }
      if (picks && picks.error) node._npPresetError = picks.error;
      else if (picks) {
        read.values.presetId = String(picks.presetId || "");
        read.values.presetGroupId = String(picks.presetGroupId || "");
      }
    }
  }
  if (read.errors.length && read.strict) {
    throw new Error(I18n.t("参数严格校验未通过：") + read.errors.join(I18n.t("；")));
  }
  let handle = null;
  try {
    handle = npApplyValues(node, read);
  } catch (e) {
    handle = null;
  }
  /* 参数覆写里的服务商同样走自动替换（与 Agent 改节点 / 真跑节点同一套解析）：
     本机对不上就按 名称唯一 → 模型归属 找回；仍对不上则保留原值并拒绝这个节点。 */
  if (handle && (handle.applied.providerId != null || handle.applied.provider != null)) {
    const key = handle.applied.providerId != null ? "providerId" : "provider";
    const mode =
      typeof providerRefMode === "function" ? providerRefMode(node) : "proc_text";
    const fix =
      typeof fixProviderRefValue === "function"
        ? fixProviderRefValue(node[key], key === "providerId" ? mode : "agent", node.model)
        : null;
    if (fix && fix.value) {
      if (fix.value !== node[key]) {
        const from = node[key];
        node[key] = fix.value;
        read.warnings.push(
          I18n.t("参数覆写的服务商「") + from + I18n.t("」已按本机配置换成「") + fix.value + I18n.t("」"),
        );
        if (typeof replaceProviderAcrossCanvas === "function")
          replaceProviderAcrossCanvas(from, fix.value, fix.how);
      }
    } else if (fix) {
      read.errors.push(
        I18n.t("参数覆写的服务商「") + node[key] + I18n.t("」在本机找不到") +
          (fix.why ? I18n.t("（") + fix.why + I18n.t("）") : ""),
      );
    }
  }
  if (read.strict && read.errors.length) {
    if (handle) handle.restore();
    throw new Error(I18n.t("参数严格校验未通过：") + read.errors.join(I18n.t("；")));
  }
  NP_ACTIVE.set(node.id, {
    keys: Object.keys((handle && handle.applied) || {}),
    sources: read.sources,
    warnings: read.warnings,
    errors: read.errors,
  });
  if (typeof toast === "function") {
    for (const w of read.warnings) toast(w, "warn");
    for (const e of read.errors) toast(e, "warn");
  }
  try {
    return await fn();
  } finally {
    if (handle) handle.restore();
    NP_ACTIVE.delete(node.id);
    /* 角色 / 组名的解析结论只对这一轮有效（节点本身的值已经由 handle.restore 还原） */
    delete node._npPresetError;
    /* 卡片上的「参数覆盖中」随运行结束刷新（没有 run 时它就是静态标识） */
    if (typeof renderCanvas === "function" && typeof S !== "undefined" && S.wf) {
      try {
        renderCanvas();
      } catch (_) {
        /* 重绘失败不影响运行结果 */
      }
    }
  }
}

/* ───────────── 设置窗：覆写明细 + 严格开关 + 可覆写键表 ───────────── */

function npEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = String(text);
  return el;
}

/* 「?」小图标：说明收进悬停浮层，正文只留最短一句。
   为什么不用原生 title：系统绘制、延迟约 1 秒、样式不可控，且在设置窗里实测「移上去
   什么都没有」；所以自绘 body 级 fixed 浮层 #npQTip（设置正文 overflow 裁不到它），
   鼠标移入 / 键盘 focus 立刻出全文，多行自动折行。全文同时写在 data-np-tip 上，
   冒烟与无头环境可直接读到，不必依赖浮层渲染。 */
let _npQTipEl = null;
let _npQTipBound = false;

function npQTipEnsure() {
  if (_npQTipEl && _npQTipEl.isConnected !== false) return _npQTipEl;
  const box = document.createElement("div");
  box.className = "np-q-tip";
  box.id = "npQTip";
  box.setAttribute("role", "tooltip");
  box.hidden = true;
  (document.body || document.documentElement).appendChild(box);
  _npQTipEl = box;
  return box;
}

function npQTipHide() {
  if (_npQTipEl) _npQTipEl.hidden = true;
}

function npQTipShow(host) {
  if (!host) return;
  const txt = host.getAttribute("data-np-tip") || "";
  if (!txt) return;
  const box = npQTipEnsure();
  box.textContent = txt;
  box.hidden = false;
  /* 滚轮 / 缩放 / 点别处一律收（浮层 fixed 定位，不跟着滚会飘在错的位置） */
  if (!_npQTipBound && typeof window !== "undefined" && window.addEventListener) {
    _npQTipBound = true;
    window.addEventListener("scroll", npQTipHide, true);
    window.addEventListener("resize", npQTipHide);
    document.addEventListener("pointerdown", npQTipHide, true);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") npQTipHide();
    }, true);
  }
  let r = null;
  try {
    r = typeof host.getBoundingClientRect === "function" ? host.getBoundingClientRect() : null;
  } catch (_) {}
  if (!r) return;
  const vw = document.documentElement.clientWidth || window.innerWidth || 0;
  const vh = document.documentElement.clientHeight || window.innerHeight || 0;
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, Math.max(8, vw - bw - 8)));
  let top = r.bottom + 8;
  if (vh && top + bh > vh - 8) top = Math.max(8, r.top - bh - 8);
  box.style.left = Math.round(left) + "px";
  box.style.top = Math.round(top) + "px";
}

function npQ(text) {
  const s = npEl("span", "np-q", "?");
  const body = String(text || "");
  s.setAttribute("data-np-tip", body);
  s.setAttribute("role", "img");
  s.setAttribute("aria-label", I18n.t("说明"));
  s.setAttribute("tabindex", "0");
  s.addEventListener("mouseenter", () => npQTipShow(s));
  s.addEventListener("mouseleave", npQTipHide);
  s.addEventListener("focusin", () => npQTipShow(s));
  s.addEventListener("focusout", npQTipHide);
  s.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  s.addEventListener("mousedown", (ev) => {
    /* 在 <label> 里：点图标不该顺带切换勾选框 */
    ev.preventDefault();
    ev.stopPropagation();
  });
  return s;
}

/* 其它模块（app-canvas.js 的字段构造）用的同一枚图标；名字取通用一点，语义不变。 */
function settingsQ(text) {
  return npQ(text);
}

/* 文档图标（内联 SVG，不依赖图标字体）：写一份「所有参数的文字说明」。 */
function npDocIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of ["M4 1.9h5.2l2.9 2.9v9.3H4z", "M9.2 1.9v2.9h2.9", "M6.2 8h3.6", "M6.2 10.4h3.6"]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

/** 值的一行摘要（表格 / 文档窗共用）：对象走 JSON，空串有明确写法，过长截断。 */
function npValueText(v, limit) {
  let s = "";
  try {
    if (v === undefined) s = "";
    else if (v === null) s = "null";
    else if (typeof v === "string" && !v.trim()) s = I18n.t("（空）");
    else if (typeof v === "object") s = JSON.stringify(v);
    else s = String(v);
  } catch (_) {
    s = "";
  }
  const max = Number(limit) || 60;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 「参数说明」文档窗：这个节点**全部**可覆写键 + 一句话说明 + 类型 / 默认 / 当前值。
 *  宿主是 #mtDialog（独立于设置窗），所以能开在设置窗上面，关掉不影响设置窗。 */
function npOpenParamsDoc(node) {
  if (!node || typeof mtDialogForm !== "function") return;
  const schema = npSchemaOf(node);
  const read = (() => {
    try {
      return npRead(node);
    } catch (_) {
      return { values: {}, sources: [], warnings: [], errors: [] };
    }
  })();
  mtDialogForm({
    title: I18n.t("参数端子 · 参数说明"),
    wide: true,
    msg: I18n.t(
      "参数线传一份 JSON 对象，键必须是下表的正式名（区分大小写，不接受 snake_case / kebab-case）。运行时临时覆写、跑完恢复，不改画布上的值；null = 恢复默认；路径类的相对路径按画布工作目录解析；多条参数线按接线顺序深合并，同键后者胜、数组整体替换。",
    ),
    custom: (host) => {
      const list = document.createElement("div");
      list.className = "np-doc-list";
      if (!schema.length) {
        const none = document.createElement("div");
        none.className = "np-doc-none";
        none.textContent = I18n.t("本节点没有可覆写的参数");
        list.appendChild(none);
      }
      for (const s of schema) {
        const row = document.createElement("div");
        row.className = "np-doc-row";
        const k = document.createElement("div");
        k.className = "np-doc-k";
        k.textContent = s.key;
        row.appendChild(k);
        const meta = document.createElement("div");
        meta.className = "np-doc-m";
        meta.textContent =
          s.type +
          (s.def === undefined ? "" : I18n.t(" · 默认 ") + npValueText(s.def, 24)) +
          (s.now === undefined ? "" : I18n.t(" · 当前 ") + npValueText(s.now, 32));
        if (s.now !== undefined) meta.title = npValueText(s.now, 400);
        row.appendChild(meta);
        const d = document.createElement("div");
        d.className = "np-doc-d";
        d.textContent = npKeyDoc(s.key, s);
        row.appendChild(d);
        list.appendChild(row);
      }
      host.appendChild(list);
      if (read.sources.length) {
        const src = document.createElement("p");
        src.className = "mt-form-hint";
        src.textContent =
          I18n.t("本次参数来自：") + read.sources.map((s) => s.title).join(I18n.t(" → "));
        host.appendChild(src);
      }
    },
    actions: [{ id: "close", label: I18n.t("关闭"), primary: true }],
  });
}

function npFnParamsSection(ctx) {
  const node = ctx.node;
  const read = npFnOwnParams(node);
  const isFn = typeof isFunctionNode === "function" && isFunctionNode(node);
  const head = ctx.section(I18n.t("参数（参数端子 9001 · 注入到 JS / 工具子图）"));
  head.textContent = "";
  head.style.cssText = "display:flex;align-items:center;gap:6px";
  head.appendChild(
    npEl("span", "", I18n.t("参数（参数端子 9001 · 注入到 JS / 工具子图）")),
  );
  head.appendChild(
    npQ(
      I18n.t(
        "这里写一份 JSON 对象：运行时原样交给代码，不覆写任何节点字段。函数节点用 input.params 读到它；工具节点把它下发给内部子图，内部函数节点同样用 input.params 读。接在 9001「参数」端子上的 JSON 会按接线顺序深合并覆盖这份默认值（同键后者胜）。",
      ),
    ),
  );
  const ta = document.createElement("textarea");
  ta.className = "nsf-span";
  ta.rows = 6;
  ta.spellcheck = false;
  ta.style.cssText =
    "width:100%;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px";
  ta.placeholder = I18n.t('{\n  "阈值": 0.5,\n  "说明": "空 = 没有默认参数"\n}');
  ta.value = String(node.paramsJson || "");
  ta.addEventListener("change", () => {
    node.paramsJson = ta.value || "";
    const chk = npParseParamObject(node.paramsJson);
    ta.style.borderColor = chk.error ? "var(--red)" : "";
    if (typeof ctx.commit === "function") ctx.commit();
  });
  ctx.append(ta);
  const def = npParseParamObject(node.paramsJson);
  if (def.error) ctx.hint("✕ " + I18n.t("默认参数 JSON 不合法（运行时会按空对象跑）：") + def.error);
  const wireN = npParamWires(node).length;
  if (!wireN) {
    ctx.hint(I18n.t("9001 「参数」端子未接线：本次运行只用上面这份默认参数。"));
  } else {
    ctx.hint(
      I18n.t("9001 「参数」端子已接 ") +
        wireN +
        I18n.t(" 条线：运行时深合并覆盖默认参数。") +
        (read.sources.length
          ? I18n.t("来自：") + read.sources.map((s) => s.title).join(I18n.t(" → "))
          : ""),
    );
    const keys = Object.keys(read.values || {});
    ctx.hint(
      keys.length
        ? I18n.t("本次生效的键：") + keys.join("、")
        : I18n.t("（参数线里没有可用的键）"),
    );
  }
  if (isFn)
    ctx.hint(
      I18n.t(
        "函数体里：input.params = 这份对象（没接线也没默认值 = {}）；命名入参仍从端子 1..N 来。",
      ),
    );
  else
    ctx.hint(
      I18n.t(
        "内部子图的函数节点会自动继承这份参数（沿父壳就近继承）；子图里自己再接 9001 仍然优先。",
      ),
    );
  for (const w of read.warnings) ctx.hint("⚠ " + w);
  for (const e of read.errors) ctx.hint("✕ " + e);
  const strictWrap = document.createElement("label");
  strictWrap.className = "np-strict nsf-span";
  strictWrap.appendChild(npEl("span", "np-strict-t", I18n.t("参数严格校验")));
  strictWrap.appendChild(
    npQ(I18n.t("勾选后：参数 JSON 不合法 / 不是对象时整个节点不运行并报错，而不是按空对象继续")),
  );
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!node._npStrict;
  cb.addEventListener("change", () => {
    node._npStrict = !!cb.checked;
    if (typeof ctx.commit === "function") ctx.commit();
  });
  strictWrap.appendChild(cb);
  ctx.append(strictWrap);
}

function npSettingsSection(ctx) {
  if (!ctx || !ctx.node) return;
  const node = ctx.node;
  if (!npEligible(node)) return;
  if (typeof isFnToolNode === "function" && isFnToolNode(node))
    return npFnParamsSection(ctx);
  const read = npRead(node);
  /* 小节标题 + 右侧文档按钮（点开 = 全部参数的文字说明） */
  const head = ctx.section(I18n.t("参数覆写（参数端子）"));
  head.textContent = "";
  head.style.cssText = "display:flex;align-items:center;gap:6px";
  head.appendChild(npEl("span", "", I18n.t("参数覆写（参数端子）")));
  head.appendChild(
    npQ(
      I18n.t(
        "接一条文本节点的 JSON 覆写本节点配置：运行时临时生效、跑完恢复，不改画布上的值。路径类的相对路径按画布工作目录解析；可接多条，按接线顺序深合并，同键后者胜。",
      ),
    ),
  );
  const docBtn = document.createElement("button");
  docBtn.type = "button";
  docBtn.className = "mini np-doc-btn";
  docBtn.title = I18n.t("参数说明：本节点全部可覆写参数与写法");
  docBtn.setAttribute("aria-label", I18n.t("参数说明"));
  docBtn.style.marginLeft = "auto";
  docBtn.appendChild(npDocIcon());
  docBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    npOpenParamsDoc(node);
  });
  head.appendChild(docBtn);

  const wireN = npParamWires(node).length;
  if (!wireN) {
    ctx.hint(I18n.t("未接线：运行时按本窗的值"));
  } else {
    const table = npEl("div", "nsf-span np-ovr-table");
    table.style.cssText =
      "display:grid;grid-template-columns:minmax(90px,1.1fr) minmax(80px,1fr) minmax(80px,1fr);gap:4px 8px;font-size:11.5px;line-height:1.5";
    for (const t of [I18n.t("键"), I18n.t("节点当前值"), I18n.t("本轮生效值")]) {
      const h = npEl("div", "", t);
      h.style.cssText = "font-weight:600;opacity:.75";
      table.appendChild(h);
    }
    const keys = Object.keys(read.values);
    if (!keys.length) {
      const none = npEl("div", "", I18n.t("（参数线里没有可用的键）"));
      none.style.cssText = "grid-column:1 / -1;opacity:.7";
      table.appendChild(none);
    }
    for (const k of keys) {
      const cur = k === "pluginParams" ? JSON.stringify(node.pluginParams || {}) : String(node[k]);
      const eff =
        k === "pluginParams"
          ? JSON.stringify(read.values[k])
          : String(npResolvePathValue(k, read.values[k]));
      const a = npEl("div", "", k);
      a.style.fontFamily = "ui-monospace,Consolas,monospace";
      table.appendChild(a);
      table.appendChild(npEl("div", "", cur));
      const e = npEl("div", "", eff);
      e.style.color = "#7fd3a8";
      table.appendChild(e);
    }
    ctx.append(table);
    if (read.sources.length) {
      /* 「没有工作目录」只对真的含相对路径的那次覆写才有意义 —— 全是绝对路径时
         这句提示纯属噪音（用户会以为参数被改坏了）。 */
      const hasRel = Object.keys(read.values || {}).some((k) => {
        const v = read.values[k];
        return (
          typeof v === "string" &&
          v.trim() &&
          !npIsAbsPath(v) &&
          /(Path|path|workspace|Workspace|dir|Dir|root|Root|folder|Folder)$/.test(k)
        );
      });
      ctx.hint(
        I18n.t("来自：") +
          read.sources.map((s) => s.title).join(I18n.t(" → ")) +
          (npPathBase()
            ? I18n.t(" · 工作目录：") + npPathBase()
            : hasRel
              ? I18n.t(" · 当前没有工作目录，相对路径原样下发")
              : ""),
      );
    }
    for (const w of read.warnings) ctx.hint("⚠ " + w);
    for (const e of read.errors) ctx.hint("✕ " + e);
  }
  /* 严格校验开关：默认关（宽松逐键应用）；只影响本节点。
     一行三件：标题 + 「?」 + 勾选框（同一行，不各占一行）。 */
  const strictWrap = document.createElement("label");
  strictWrap.className = "np-strict nsf-span";
  strictWrap.appendChild(npEl("span", "np-strict-t", I18n.t("参数严格校验")));
  strictWrap.appendChild(
    npQ(I18n.t("勾选后：参数 JSON 里出现未知键 / 类型不符时整个节点不运行并报错，而不是逐键回退")),
  );
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!node._npStrict;
  cb.addEventListener("change", () => {
    node._npStrict = !!cb.checked;
    if (typeof ctx.commit === "function") ctx.commit();
  });
  strictWrap.appendChild(cb);
  ctx.append(strictWrap);
}

/* 把所有设置窗包一层：原表单后面自动接「参数覆写」一节（不改任何既有表单代码）。
   插件节点是运行期注册的，所以连注册函数一起包：以后登记的也自动带上。 */
function npDecorateSettingsForms() {
  if (typeof registerNodeSettingsForm !== "function") return;
  const wrap = (def) => {
    if (!def || typeof def.build !== "function" || def.__npWrapped) return def;
    const build0 = def.build;
    const out = Object.assign({}, def);
    out.build = function (ctx) {
      build0(ctx);
      try {
        npSettingsSection(ctx);
      } catch (e) {
        if (typeof toast === "function") toast(I18n.t("参数覆写面板出错：") + (e.message || e), "warn");
      }
    };
    out.__npWrapped = true;
    return out;
  };
  /* ① 已经登记过的表单：就地换掉 */
  try {
    for (const k of Object.keys(NODE_SETTINGS_FORMS)) NODE_SETTINGS_FORMS[k] = wrap(NODE_SETTINGS_FORMS[k]);
  } catch (_) {
    /* 登记表结构变了也不影响后面的注册包装 */
  }
  /* ② 注册入口包一层：以后登记的自动带上 */
  const orig = registerNodeSettingsForm;
  registerNodeSettingsForm = function (key, def) {
    return orig(key, wrap(def));
  };
}

/* ───────────── 卡片标识：参数覆盖中 ───────────── */

function npCardChip(node) {
  if (!npEligible(node)) return null;
  const wires = npParamWires(node);
  if (!wires.length) return null;
  const isFnTool = typeof isFnToolNode === "function" && isFnToolNode(node);
  const read = isFnTool ? npFnOwnParams(node) : npRead(node);
  const chip = document.createElement("span");
  chip.className = "n-chip np-chip" + (read.errors.length ? " bad" : "");
  chip.textContent = I18n.t("参数");
  const keys = Object.keys(read.values || {});
  chip.title =
    I18n.t("参数端子已接线") +
    (keys.length
      ? " · " + keys.join("、")
      : isFnTool
        ? I18n.t(" · 参数线里没有可用的键")
        : I18n.t(" · 暂无可用键")) +
    (read.errors.length ? I18n.t(" · 错误：") + read.errors.join(I18n.t("；")) : "");
  if (NP_ACTIVE.has(node.id)) chip.classList.add("on");
  return chip;
}

/* ───────────── 纯 JSON 识别 + JSON 表单（输入文本节点） ───────────── */

const NP_JSON_MAX_BYTES = 512 * 1024;
const NP_JSON_MAX_DEPTH = 6;
const NP_JSON_MAX_ITEMS = 500;

function npDepthOf(v, d) {
  d = d || 0;
  if (d > NP_JSON_MAX_DEPTH) return d;
  if (Array.isArray(v)) {
    let m = d;
    for (const x of v) m = Math.max(m, npDepthOf(x, d + 1));
    return m;
  }
  if (npIsPlainObject(v)) {
    let m = d;
    for (const k of Object.keys(v)) m = Math.max(m, npDepthOf(v[k], d + 1));
    return m;
  }
  return d;
}

/** 纯 JSON 识别：整段 trim 后 JSON.parse 成功、且是对象或数组、且不超过体积/深度/条数上限。 */
function npDetectJson(text) {
  const raw = String(text == null ? "" : text);
  const t = raw.trim();
  if (!t) return { ok: false, reason: "empty" };
  if (t.length > NP_JSON_MAX_BYTES) return { ok: false, reason: "tooBig" };
  if (t[0] !== "{" && t[0] !== "[") return { ok: false, reason: "notJson" };
  let value = null;
  try {
    value = JSON.parse(t);
  } catch (_) {
    return { ok: false, reason: "notJson" };
  }
  if (!npIsPlainObject(value) && !Array.isArray(value)) return { ok: false, reason: "notContainer" };
  if (npDepthOf(value) > NP_JSON_MAX_DEPTH) return { ok: false, reason: "tooDeep", value: value };
  const n = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (n > NP_JSON_MAX_ITEMS) return { ok: false, reason: "tooMany", value: value };
  return { ok: true, value: value };
}

function npJsonText(v) {
  return JSON.stringify(v, null, 2);
}

/** 一份 JSON 对象 → 批量条目（标题 + 正文）：数组按项拆，对象按「键 → 内容」拆。
    这是「JSON 优先于 YAML 批量」之后的批量入口（参数表 / 批量条目常常就是一份 JSON 数组）。 */
function npJsonToEntries(value) {
  const out = [];
  const one = (title, body) => {
    out.push({
      title: String(title == null ? "" : title),
      content: typeof body === "string" ? body : npJsonText(body),
    });
  };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const it = value[i];
      if (npIsPlainObject(it)) {
        const title = it.title ?? it.name ?? it.id ?? I18n.t("条目 ") + (i + 1);
        one(title, it);
      } else one(I18n.t("条目 ") + (i + 1), it);
    }
  } else if (npIsPlainObject(value)) {
    for (const k of Object.keys(value)) one(k, value[k]);
  }
  return out;
}

/* 当前处于「源码视图」的文本节点（会话内状态，不进画布快照） */
const NP_JSON_SRC_VIEW = new Set();

function npBtn(text, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini";
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick(ev);
  });
  return b;
}

/** JSON 表单：递归树 + 类型化控件 + 数组增删（可编辑分支）。
 *  onChange(value) 每次改动回调（调用方负责写回节点正文，不重绘，避免丢焦点）。 */
function npJsonEditor(value, onChange, opts) {
  opts = opts || {};
  const root = document.createElement("div");
  root.className = "np-json-editor";
  root.appendChild(
    npJsonEditorSub(value, (nv) => onChange(nv), {
      readOnly: !!opts.readOnly,
      depth: opts.depth || 0,
    }),
  );
  return root;
}

/** 子树编辑器：对象 / 数组各自的容器形态（递归）。 */
function npJsonEditorSub(value, onChange, opts) {
  opts = opts || {};
  const box = document.createElement("div");
  box.className = "np-sub-box";
  const isArr = Array.isArray(value);
  /* 需要一个稳定的容器：改动全部落在本地副本上，再往上抛 */
  const local = isArr ? value.slice() : Object.assign({}, value);
  function push() {
    onChange(isArr ? local.slice() : Object.assign({}, local));
  }
  function render() {
    box.textContent = "";
    const keys = isArr ? local.map((_, i) => i) : Object.keys(local);
    for (const k of keys) {
      box.appendChild(rowFor(k));
    }
    if (!opts.readOnly) {
      const ops = npEl("div", "np-ops");
      if (isArr) {
        ops.appendChild(
          npBtn(I18n.t("＋ 项"), I18n.t("在数组末尾新增一项"), () => {
            local.push("");
            push();
            render();
          }),
        );
      } else {
        const kIn = document.createElement("input");
        kIn.type = "text";
        kIn.className = "np-key-in";
        kIn.placeholder = I18n.t("新键名");
        const vIn = document.createElement("input");
        vIn.type = "text";
        vIn.className = "np-val-in";
        vIn.placeholder = I18n.t("值");
        ops.appendChild(kIn);
        ops.appendChild(vIn);
        ops.appendChild(
          npBtn(I18n.t("＋ 键"), I18n.t("新增一个键"), () => {
            const k = String(kIn.value || "").trim();
            if (!k) return;
            local[k] = String(vIn.value || "");
            push();
            render();
          }),
        );
      }
      box.appendChild(ops);
    }
  }
  function rowFor(k) {
    const val = local[k];
    const t = val === null ? "null" : Array.isArray(val) ? "array" : typeof val;
    const row = npEl("div", "np-row");
    row.appendChild(npEl("span", "np-key", isArr ? "#" + k : String(k)));
    if (t === "object" || t === "array") {
      const sub = npEl("div", "np-sub");
      sub.appendChild(
        npJsonEditorSub(val, (nv) => {
          local[k] = nv;
          push();
        }, { readOnly: opts.readOnly, depth: (opts.depth || 0) + 1 }),
      );
      row.appendChild(sub);
      return row;
    }
    let input;
    if (t === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!val;
      input.disabled = !!opts.readOnly;
      input.addEventListener("change", () => {
        local[k] = !!input.checked;
        push();
      });
    } else if (t === "number") {
      input = document.createElement("input");
      input.type = "number";
      input.className = "np-num";
      input.value = String(val);
      input.disabled = !!opts.readOnly;
      input.addEventListener("change", () => {
        const n = Number(input.value);
        local[k] = isFinite(n) ? n : val;
        push();
      });
    } else if (t === "null") {
      input = document.createElement("input");
      input.type = "text";
      input.className = "np-str";
      input.value = "null";
      input.disabled = !!opts.readOnly;
      input.addEventListener("change", () => {
        const s = String(input.value || "").trim();
        local[k] = s === "null" || !s ? null : isFinite(Number(s)) ? Number(s) : s;
        push();
      });
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.className = "np-str";
      input.value = String(val == null ? "" : val);
      input.disabled = !!opts.readOnly;
      input.addEventListener("change", () => {
        local[k] = String(input.value || "");
        push();
      });
    }
    input.title = I18n.t("类型：") + t;
    row.appendChild(input);
    if (!opts.readOnly) {
      row.appendChild(
        npBtn("✕", I18n.t("删除这一项"), () => {
          if (isArr) local.splice(Number(k), 1);
          else delete local[k];
          push();
          render();
        }),
      );
    }
    return row;
  }
  render();
  return box;
}

/** 文本节点正文的 JSON 表单视图（可编辑）。返回 true = 本函数接管了正文。
    挂载点：app-canvas.js 的 buildBody（input_text 分支）。 */
function npJsonBodyFor(node, body) {
  if (!node || node.kind !== "input_text" || !body) return false;
  if (node.batch) return false; /* 批量条目形态：条目各自的内容不转表单 */
  let text = "";
  let editable = false;
  if (node.ro) {
    text = String(node.text || "");
    editable = false;
  } else if (typeof inputInherited === "function" && inputInherited(node)) {
    const disp = typeof displayValueOf === "function" ? displayValueOf(firstSource(node), node) : null;
    if (!disp || disp.text == null) return false;
    text = String(disp.text);
    editable = false;
  } else {
    /* 用户手动切到源码视图：交回原有的 Markdown / 文本渲染 */
    if (NP_JSON_SRC_VIEW.has(node.id)) return false;
    text = String(node.text || "");
    editable = true;
  }
  const det = npDetectJson(text);
  if (!det.ok) {
    if (editable && det.reason === "tooBig")
      return false; /* 超大正文：走原有护栏（browseTextEl 长文纯文本） */
    if (editable && (det.reason === "tooDeep" || det.reason === "tooMany")) {
      const tip = npEl(
        "div",
        "n-empty",
        det.reason === "tooDeep"
          ? I18n.t("这段 JSON 嵌套太深（> 6 层），已按源码显示（表单不适用）")
          : I18n.t("这段 JSON 条目太多（> 500），已按源码显示（表单不适用）"),
      );
      body.appendChild(tip);
      return false;
    }
    return false;
  }
  const wrap = npEl("div", "np-json-body");
  const bar = npEl("div", "np-json-bar");
  bar.appendChild(npEl("span", "n-chip on", I18n.t("JSON 表单")));
  if (editable) {
    bar.appendChild(
      npBtn(I18n.t("源码"), I18n.t("切回源码视图（表单改动已写回正文）"), () => {
        NP_JSON_SRC_VIEW.add(node.id);
        if (typeof applyNodeForm === "function") applyNodeForm(node);
        else if (typeof renderCanvas === "function") renderCanvas();
      }),
    );
    const arr = Array.isArray(det.value);
    bar.appendChild(
      npBtn(
        arr ? I18n.t("拆成批量条目") : I18n.t("按键拆成条目"),
        arr
          ? I18n.t("把这份 JSON 数组拆成批量条目（标题 + 正文），开启批量模式")
          : I18n.t("把这份 JSON 对象的每个键拆成一条批量条目"),
        () => {
          const entries = npJsonToEntries(det.value);
          if (!entries.length) {
            if (typeof toast === "function") toast(I18n.t("这份 JSON 拆不出条目"), "warn");
            return;
          }
          if (typeof pushHistory === "function") pushHistory();
          node.entries = entries.map((e) => ({
            id: typeof uid === "function" ? uid("e") : String(Math.random()),
            title: e.title,
            content: e.content,
          }));
          node.batch = true;
          if (typeof clearDownstream === "function") clearDownstream(node.id);
          if (typeof scheduleSave === "function") scheduleSave();
          if (typeof renderCanvas === "function") renderCanvas();
          if (typeof toast === "function") toast(I18n.t("已拆成 ") + entries.length + I18n.t(" 条批量条目"), "ok");
        },
      ),
    );
  } else {
    bar.appendChild(npEl("span", "np-json-ro", I18n.t("只读（内容来自上游，改就在上游改）")));
  }
  wrap.appendChild(bar);
  const editor = npEl("div", "np-json-scroll");
  editor.appendChild(
    npJsonEditor(det.value, (next) => {
      if (!editable) return;
      const txt = npJsonText(next);
      if (node.text === txt) return;
      if (typeof pushHistory === "function") pushHistory();
      node.text = txt;
      if (typeof clearDownstream === "function") clearDownstream(node.id);
      if (typeof scheduleSave === "function") scheduleSave();
    }, { readOnly: !editable }),
  );
  wrap.appendChild(editor);
  body.appendChild(wrap);
  return true;
}

/* 文本节点右上角：本来 YAML 的「批量」开关对纯 JSON 会误判 —— 这里给一颗「表单」切换，
   让用户随时在 JSON 表单 / 源码之间来回切（与 NP_JSON_SRC_VIEW 同源）。 */
function npJsonSwitchChip(node) {
  if (!node || node.kind !== "input_text" || node.ro || node.batch) return null;
  if (typeof inputInherited === "function" && inputInherited(node)) return null;
  const det = npDetectJson(node.text || "");
  if (!det.ok) return null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "yaml-chip" + (NP_JSON_SRC_VIEW.has(node.id) ? " off" : "");
  b.textContent = "JSON";
  b.title = NP_JSON_SRC_VIEW.has(node.id)
    ? I18n.t("当前是源码视图 · 点击换成 JSON 表单")
    : I18n.t("这段正文是纯 JSON，已换成表单视图 · 点击切回源码");
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (NP_JSON_SRC_VIEW.has(node.id)) NP_JSON_SRC_VIEW.delete(node.id);
    else NP_JSON_SRC_VIEW.add(node.id);
    if (typeof applyNodeForm === "function") applyNodeForm(node);
    else if (typeof renderCanvas === "function") renderCanvas();
  });
  return b;
}

/* ───────────── 参数只能从端子来（写入口的闸 + 老画布清理） ───────────── */

/** canvas_edit 的 create / update 里带 `params`：整笔拒绝。
 *  返回空串 = 通过；返回错误文案 = 调用方应抛错（整笔不写）。
 *  为什么拒绝而不是忽略：params 会把参数直接挂到节点上、运行期压住 ⚙ 里的值，
 *  用户就改不动自己的参数了（旧版 npParams 的坑）。参数要给就建 input_text 接 9001。 */
function npEditParamsRejection(editParams) {
  const p = editParams || {};
  const bad = [];
  const scan = (list) => {
    for (const spec of Array.isArray(list) ? list : []) {
      if (!spec || !Object.prototype.hasOwnProperty.call(spec, "params")) continue;
      const label =
        String((spec && (spec.alias || spec.title || spec.id)) || "").trim() ||
        I18n.t("（未命名）");
      bad.push(label);
    }
  };
  scan(p.create);
  scan(p.update);
  if (!bad.length) return "";
  return (
    I18n.t(
      "canvas_edit 不再接受 params：节点参数只能通过「参数」端子传入 —— 建一颗 input_text 写参数 JSON，再 connect 到该节点的 toIndex 9001。本次编辑已整笔拒绝，冲突项：",
    ) + bad.join(I18n.t("、"))
  );
}

/** 老画布清理：删掉旧版 params 写进节点上的 npParams（运行时已不再读它）。
 *  返回被清理节点的标题数组；为空 = 什么都没做（幂等）。 */
function npPurgeLegacyParams(wf) {
  const out = [];
  for (const n of (wf && Array.isArray(wf.nodes) ? wf.nodes : [])) {
    if (!n || !Object.prototype.hasOwnProperty.call(n, "npParams")) continue;
    delete n.npParams;
    out.push(String(n.title || n.id || ""));
  }
  return out.filter((t) => t !== "");
}

/* ───────────── 对外出口 ───────────── */

const NParam = {
  PORT: NP_PORT,
  EXCLUDE_KINDS: NP_EXCLUDE_KINDS,
  eligible: npEligible,
  isParamIndex: npIsParamIndex,
  portY: npPortY,
  allowedMap: npAllowedMap,
  schemaOf: npSchemaOf,
  paramWires: npParamWires,
  read: npRead,
  resolvePath: npResolvePathValue,
  runWithParams: npRunWithParams,
  settingsSection: npSettingsSection,
  cardChip: npCardChip,
  openDocs: npOpenParamsDoc,
  isDeniedKey: npIsDeniedKey,
  keyDoc: npKeyDoc,
  KEY_DOC: NP_KEY_DOC,
  detectJson: npDetectJson,
  jsonToEntries: npJsonToEntries,
  jsonBodyFor: npJsonBodyFor,
  jsonSwitchChip: npJsonSwitchChip,
  jsonText: npJsonText,
  activeFor: (id) => NP_ACTIVE.get(id) || null,
  editParamsRejection: npEditParamsRejection,
  purgeLegacyParams: npPurgeLegacyParams,
  /* 函数 / 工具节点的「参数」端子（JSON 注入 input.params · 工具子图共享） */
  fnOwnParams: npFnOwnParams,
  fnParamsForNode: fnParamsForNode,
  fnRunWithParams: npFnRunWithParams,
  fnParseParamObject: npParseParamObject,
  fnParamsActive: (id) => NP_FN_PARAMS.get(id) || null,
};
try {
  window.NParam = NParam;
} catch (_) {
  /* 非浏览器环境（冒烟里用 vm 跑脚本片段）忽略 */
}
npDecorateSettingsForms();

"use strict";
/* ============ systemPrompt 分节装配内核（对标 Codex WorldState 分节 + render_diff） ============
 * 背景：Codex 把每轮模型可见指令拆成若干 WorldStateSection（core/src/context/world_state/mod.rs），
 * 每节支持「快照 + 差分渲染」，只有变化的分节才作为 user fragment 重注，不变 = 0 token。
 * MTNode 这边的 systemPrompt 同样由多段拼成（宿主提示 + 技能索引 + 各类注记 + 应用状态 JSON），
 * 过去每轮全量重拼、重复计费。本文件把「段」抽象成**有 id、有内容哈希、可快照**的分节：
 *
 *   · buildSections(parts) → sections[{id,text,hash}]（按规范节序排列，同 id 自动合并）
 *   · renderSections(runKey, sections, opts) → {text, hashes, changed, savedChars, sectionCache, …}
 *
 * 本阶段的边界（重要）：
 *   1. **默认全量渲染**：diff 关闭时 text 与改造前的字符串**逐字节一致**（节序 = 历史拼接顺序，
 *      分隔符沿用各调用点原有口径）。changed / savedChars 只做计量，不改变下发内容。
 *   2. **跨轮 0 token 注入尚未接通**：当前 dsh 线协议每轮新铸 session、系统提示随用户消息下发
 *      （见 dsh/DESIGN.md 与 gateway.mjs 里 [presetText, systemPrompt] 的拼接），要做到 Codex 式
 *      「只重注变化分节」必须先有跨轮 session 复用。所以 diff 开关默认关；出参 sectionCache
 *      （runKey + sig + 每节哈希）就是为那次协议升级预留的接口，网关今日忽略即降级保底。
 *   3. 内核**纯逻辑 + 零 DOM + 不依赖其他文件**，不在这里做任何隐式内容魔术：只负责排序、
 *      拼装、哈希、快照与计量，便于 test/smoke-*.js 用 vm 按名字抠出来直接跑。
 *
 * 失效规则：分节快照以 runKey 为键、以调用方传入的配置指纹 sig（沿用 app-db.js 的 dshRunSigOf：
 * workspace / model / provider / preset / effort / pure / maxTokens + 网关 runtimeKey 同源成分
 * apiKey / baseUrl / webSearchKey / persona / tools / envPatch；调用点只传它拿得到的字段，
 * 缺失按空串计）为准入条件；sig 变了 = 这一轮与快照并非同一套配置跑出来的 → 快照作废、
 * 整段全量重发。runtimeKey 同源成分必须入指纹的原因：它们漂移时网关会另起新 runtime，
 * 点名续跑旧会话必撞 id collision —— 宿主侧必须把它判成「配置变了、整轮重发」。
 * 基线档（纯净模式关、也没开「先拷问需求 / 快速热修」）与 retry 轮由调用方传 full:true 走
 * 全量旁路；基线档更进一步 —— 它是「只按本轮原话命中的分节」现算出来的（见下方
 * promptTrimSections），未命中时就是空串，不留快照。真正的纯净模式（st.pure）不查表：
 * 一节都不发。
 */

/* 规范节序（= 今天的拼接顺序，逐字节等价的依据）。
 * 前 12 节是任务书对齐 Codex 语义的核心表；后 3 节是助手宿主长文里的规则段与动态大头，插在它们
 * 原本出现的位置上（app_state 每轮都变，只有独立成节才可能单独 diff）。
 * 各调用点只取子集；同一 id 只允许对应原文里**连续**的若干段（同 id 会按出现顺序自动串接），
 * 这样拼出来的字符串与改造前逐字节相同。 */
const PROMPT_SECTION_ORDER = [
  "persona_host", // 宿主人设 / 调用方自带提示（节点链 = opts.systemPrompt）
  "scope", // 工作范围（仅当前画布 / 全局）与可用地面工具清单
  "canvas_rules", // 改画布工具口径（mtnode_canvas_edit 确认策略等）
  "superconnect_rules", // 跨节点层连接 superConnect 契约
  "devnode_rules", // 开发节点两段式规范 + 功能色卡 + devFiles 契约
  "vision_media_rules", // 识图子代理 / 图像参考 / 媒体节点 / 文件交接 / 防 N²（助手长文）
  "layout_rules", // @引用、排版分区与「可操作区靠上」、一键排版规则（助手长文）
  "principle", // 收尾原则：回答简洁、不编造节点（助手长文）
  "app_state", // 当前应用状态 JSON（每轮都变的最大头）
  "skill_index", // 内置技能索引块（mtnode-agent-skills）
  "db_grounding", // 数据库事实接地注记
  "tool_policy", // 工具许可 / 预设拒绝项注记
  "node_capability", // 画布节点能力注记（nodeLock 智能节点）
  "plan_mode", // 计划模式注记
  "lang_taste", // 语言口味注记（固定放最后：紧贴上下文尾部最容易被照做）
];

/* 分节 id 常量表（调用点不必手拼字符串；值即规范节序里的 id 本身，键序与节序一致） */
const PROMPT_SECTION_IDS = {
  persona_host: "persona_host",
  scope: "scope",
  canvas_rules: "canvas_rules",
  superconnect_rules: "superconnect_rules",
  devnode_rules: "devnode_rules",
  vision_media_rules: "vision_media_rules",
  layout_rules: "layout_rules",
  principle: "principle",
  app_state: "app_state",
  skill_index: "skill_index",
  db_grounding: "db_grounding",
  tool_policy: "tool_policy",
  node_capability: "node_capability",
  plan_mode: "plan_mode",
  lang_taste: "lang_taste",
};

/* 默认分隔符：会话/智能节点链历史上用空行拼接；助手宿主长文是各段自带换行的直接串接（传 join:""） */
const PROMPT_SECTION_JOIN = "\n\n";

/* 内核状态懒建在 globalThis 上（而不是模块级 let）：冒烟脚本用 vm 单独抠出某个函数也能跑，
 * 不必整份文件求值。
 *   snapshots: runKey → { sig, at, hashes:{id:hash} } —— 上一轮各节内容哈希
 *   stats:     runKey → 本轮计量（注入节数 / 变化节 / 省下字符 / 是否全量） */
function promptSectionStore() {
  var host =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
        ? window
        : {};
  if (!host.__mtnodePromptSections) {
    host.__mtnodePromptSections = { diff: false, snapshots: {}, stats: {} };
  }
  return host.__mtnodePromptSections;
}

/* 确定性内容哈希：FNV-1a 32bit（与 app-db.js 的 dbHash 同一算法，但内核不依赖它，以便独立抠出
 * 测试）。跨轮比对只认这一串，绝不做模糊匹配 —— 内容变一个字符就必须整节重发。 */
function promptSectionHash(s) {
  var h = 0x811c9dc5;
  var str = String(s == null ? "" : s);
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/* 规范节序里的下标；表外 id 返回 -1（排在末尾，不丢内容） */
function promptSectionRank(id) {
  var i = PROMPT_SECTION_ORDER.indexOf(String(id == null ? "" : id));
  return i < 0 ? -1 : i;
}

/* 片段 → 分节表。parts 可为 { id: text } 对象，或 [{id,text}] 数组（允许同 id 多次出现）。
 * · 节序：规范节序优先，表外 id 按首次出现顺序附在末尾
 * · 同 id 合并：按出现顺序用 opts.join（默认 "\n\n"）串起来
 * · 只丢真正无内容的节（null / ""）—— 与历史 .filter(Boolean) 同口径；空白串照旧保留，
 *   否则渲染结果与今天就不是逐字节一致了 */
function buildSections(parts, opts) {
  opts = opts || {};
  var join = opts.join == null ? PROMPT_SECTION_JOIN : String(opts.join);
  var src = parts;
  var list = [];
  if (Array.isArray(src)) {
    for (var a = 0; a < src.length; a++) {
      var it = src[a] || {};
      if (it.id == null || it.text == null) continue;
      list.push({ id: String(it.id), text: it.text });
    }
  } else {
    src = src || {};
    var keys = Object.keys(src);
    var ordered = [];
    for (var o = 0; o < PROMPT_SECTION_ORDER.length; o++) {
      if (keys.indexOf(PROMPT_SECTION_ORDER[o]) >= 0) {
        ordered.push(PROMPT_SECTION_ORDER[o]);
      }
    }
    for (var k = 0; k < keys.length; k++) {
      if (promptSectionRank(keys[k]) < 0) ordered.push(keys[k]);
    }
    for (var i = 0; i < ordered.length; i++) {
      list.push({ id: ordered[i], text: src[ordered[i]] });
    }
  }
  var bucket = {};
  var out = [];
  for (var j = 0; j < list.length; j++) {
    var id = list[j].id;
    if (list[j].text == null || list[j].text === "") continue;
    var text = String(list[j].text);
    if (Object.prototype.hasOwnProperty.call(bucket, id)) {
      bucket[id].text += join + text;
      continue;
    }
    bucket[id] = { id: id, text: text, rank: promptSectionRank(id) };
    out.push(bucket[id]);
  }
  out.sort(function (x, y) {
    var rx = x.rank < 0 ? PROMPT_SECTION_ORDER.length : x.rank;
    var ry = y.rank < 0 ? PROMPT_SECTION_ORDER.length : y.rank;
    return rx - ry; /* 表外 id 保持首次出现顺序（sort 稳定） */
  });
  return out.map(function (s) {
    return { id: s.id, text: s.text, hash: promptSectionHash(s.text) };
  });
}

/* 快照失效：runKey 省略 = 全清。配置指纹变化、整轮重发、会话被清理时由调用方点名。 */
function invalidatePromptSections(runKey) {
  var st = promptSectionStore();
  if (runKey == null) {
    st.snapshots = {};
    st.stats = {};
    return 0;
  }
  var key = String(runKey);
  var had = Object.prototype.hasOwnProperty.call(st.snapshots, key);
  delete st.snapshots[key];
  return had ? 1 : 0;
}

function promptSectionSnapshot(runKey) {
  var st = promptSectionStore();
  return st.snapshots[String(runKey == null ? "default" : runKey)] || null;
}

/* diff 开关（跨轮裁剪未变分节）。默认关闭：协议未升级前，逐轮下发的那份系统提示必须自洽完整。 */
function setPromptSectionDiff(on) {
  var st = promptSectionStore();
  st.diff = !!on;
  return st.diff;
}

function promptSectionDiffEnabled() {
  return !!promptSectionStore().diff;
}

function promptSectionStats(runKey) {
  var st = promptSectionStore();
  return st.stats[String(runKey == null ? "default" : runKey)] || null;
}

/* 渲染一轮要下发的系统提示。
 * opts:
 *   sig    调用方的配置指纹（沿用 dshRunSigOf）；与快照不符 → 快照作废并整段全量渲染
 *   diff   覆盖全局开关（true 才裁未变节；默认取 store.diff，出厂 false = 逐字节等价）
 *   full   强制全量旁路（pure 轮 / retry 轮 / 整轮重发）：不裁任何节，并作废快照
 *   join   节间分隔符（节点链默认 "\n\n"；助手宿主长文传 ""）
 *   record 默认 true：把本轮哈希表写回快照供下一轮比对；false 只渲染不改状态
 * 返回：
 *   text         本轮真正下发的字符串
 *   hashes       本轮各节内容哈希（id → hash）
 *   changed      相对上一轮快照变化的节 id（含新增节；无快照时 changed = 全部并标 first）
 *   unchanged    与上一轮逐字相同的节 id
 *   dropped      因 diff 打开而未再下发的节 id（full / 首轮 / diff 关 时恒为空）
 *   savedChars   本轮省下未下发的字符数（被裁节正文 + 其分隔符）
 *   fullRender   本轮是否全量渲染（= 未启用裁剪）
 *   first        本轮无可用快照（首次运行或刚失效）
 *   sectionCache 为跨轮注入预留的指纹出参（网关今日忽略即降级保底） */
function renderSections(runKey, sections, opts) {
  opts = opts || {};
  var st = promptSectionStore();
  var join = opts.join == null ? PROMPT_SECTION_JOIN : String(opts.join);
  var sep = join.length;
  var key = String(runKey == null ? "default" : runKey);
  var sig = opts.sig == null ? "" : String(opts.sig);
  var list = Array.isArray(sections) ? sections : buildSections(sections, { join: join });
  var record = opts.record !== false;
  var prev = st.snapshots[key] || null;
  /* 指纹变 / 显式全量旁路 → 快照作废：未变节也不能省，整轮上下文已不是那一套配置 */
  if (opts.full || (prev && sig !== "" && prev.sig !== sig)) {
    if (record) delete st.snapshots[key];
    prev = null;
  }
  var first = !prev;
  var wantDiff = opts.full
    ? false
    : opts.diff == null
      ? !!st.diff
      : !!opts.diff;
  var prevHashes = (prev && prev.hashes) || {};
  var nextHashes = {};
  var changed = [];
  var unchanged = [];
  var dropped = [];
  var kept = [];
  var n = 0;
  var bodyChars = 0;
  var savedChars = 0;
  for (var i = 0; i < list.length; i++) {
    var s = list[i] || {};
    var id = String(s.id == null ? "" : s.id);
    var text = s.text == null ? "" : String(s.text);
    if (text === "" || id === "") continue;
    nextHashes[id] = s.hash != null ? String(s.hash) : promptSectionHash(text);
    n++;
    bodyChars += text.length;
    var same = !first && prevHashes[id] === nextHashes[id];
    if (same) unchanged.push(id);
    else changed.push(id);
    /* 只裁「上一轮已下发过、且内容一字未改」的节 */
    if (wantDiff && same) {
      dropped.push(id);
      continue;
    }
    kept.push(text);
  }
  /* 计量口径：全量本应下发的字符数 − 本轮实际下发的字符数（含分隔符，逐字节精确） */
  savedChars = kept.length
    ? Math.max(0, bodyChars + sep * (n - 1) - kept.join(join).length)
    : 0;
  if (record) {
    if (Object.keys(nextHashes).length) {
      st.snapshots[key] = { sig: sig, at: Date.now(), hashes: nextHashes };
    } else {
      delete st.snapshots[key];
    }
    st.stats[key] = {
      at: Date.now(),
      sig: sig,
      injected: kept.length,
      total: Object.keys(nextHashes).length,
      changed: changed.slice(),
      dropped: dropped.slice(),
      savedChars: savedChars,
      full: !wantDiff,
      first: first,
    };
  }
  return {
    text: kept.join(join),
    hashes: nextHashes,
    changed: changed,
    unchanged: unchanged,
    dropped: dropped,
    savedChars: savedChars,
    fullRender: !wantDiff,
    first: first,
    runKey: key,
    sig: sig,
    sectionCache: {
      runKey: key,
      sig: sig,
      hashes: nextHashes,
      order: Object.keys(nextHashes),
      fullRender: !wantDiff,
      savedChars: savedChars,
      /* 跨轮「只注入变化分节」待 dsh 线协议支持 session 常驻后再启用（见文件头第 2 条） */
      diffAvailable: wantDiff,
    },
  };
}

/* ── 基线档（纯净模式关、其它模式也关）的分节命中表 ─────────────────────────────
 * 用户口径（本轮）：**普通轮就是原来那一档纯净模式的设置**，而纯净模式本身改成「真正的
 * 无 prompt」。于是这张表成了默认档：命中哪一类，就只注入这一类对应的分节；一类都没命中 →
 * 分节表为空 → 下发空 systemPrompt。
 * 纯 净 模 式（st.pure）不再查表：它一节都不发（宿主 systemPrompt 空串 + 网关强制空预设文本 +
 * 运行时 pure-prompt 插件清空 sections / contexts）。
 * 全量注入只留给「先拷问需求 / 快速热修」那两档 —— 它们的契约必须贴进 system prompt。
 *
 * 纪律：
 *   1. **一个真源**：会话侧（app-assist.js agentSessionSend）、节点 / 会话运行链
 *      （app-db.js dshRunOnce 的 trim 分支）都只问本函数，不许各写一套判据。
 *   2. **id 只用 PROMPT_SECTION_ORDER 里的**，不新增词：基线轮不引入未登记的新节。
 *   3. **只回答「命中了没有」**，不替调用点决定文案：各调用点只拼自己手上真有的那段。
 *      基线轮**工具照常全给**（基线只裁提示词，不裁能力），所以命中放行的段与当前真实
 *      工具集一致 —— 命中什么就拼什么，不再有「工具其实没有、人设却承诺了」的错位。
 */
const PURE_PROMPT_HIT_RULES = [
  {
    label: "画布 / 节点",
    ids: [
      "canvas_rules",
      "superconnect_rules",
      "layout_rules",
      "node_capability",
      "tool_policy",
      "app_state",
    ],
    re: /画布|节点|连线|端口|端子|排版|分区|分组|工作流|流程图|智能任务|canvas|node|superConnect/i,
  },
  {
    label: "开发节点 / 架构",
    ids: ["devnode_rules"],
    re: /开发节点|架构|模块|类图|细化|接口|devnode|interface/i,
  },
  {
    label: "文件读写 / 命令 / 媒体",
    ids: ["persona_host", "vision_media_rules"],
    re: /文件|目录|文件夹|路径|读写|读取|写入|保存|新建|删除|重命名|脚本|命令|终端|shell|cmd|powershell|代码|源码|项目|仓库|日志|配置|附件|表格|文档|csv|json|markdown|readme|md|txt|log|yaml|yml|ini|pdf|docx|xlsx|下载|联网|网页|链接|搜索|截图|图片|视频|音频|媒体/i,
  },
  {
    label: "内置技能索引",
    ids: ["skill_index"],
    re: /技能|skill/i,
  },
  {
    label: "应用 / 窗口 / 插件",
    ids: ["app_state"],
    re: /应用|插件|窗口|页面|界面|\bapp\b|plugin/i,
  },
  {
    label: "自检与交付纪律",
    ids: ["principle"],
    re: /自检|验收|质检|检查|核对|测试|交付|长任务|长周期|做完|收尾|复盘/i,
  },
];

/* 本轮该注入哪些分节（基线档；旧名 purePromptSections 保留为别名）。
 *   userText: 这一轮真正发给模型的原话（技能轮 = 展开后的任务书正文；空串 = 什么都不命中）
 *   opts.planMode: 计划模式是会话状态而不是关键词 → 为真时补上 plan_mode 一节
 * 返回：{ ids: [...按规范节序...], hit, has(id) } —— 一节都没命中时 ids 为空、hit=false，
 * 调用点据此下发空 systemPrompt。 */
function promptTrimSections(userText, opts) {
  opts = opts || {};
  var text = String(userText == null ? "" : userText);
  var hit = {};
  if (text.trim()) {
    for (var r = 0; r < PURE_PROMPT_HIT_RULES.length; r++) {
      var rule = PURE_PROMPT_HIT_RULES[r] || {};
      if (!rule.re || !rule.re.test(text)) continue;
      var ids = rule.ids || [];
      for (var i = 0; i < ids.length; i++) hit[ids[i]] = 1;
    }
  }
  /* 计划模式（用户点了「本轮只出计划」）：与关键词无关，命中表里补一节 */
  if (opts.planMode) hit.plan_mode = 1;
  var out = [];
  for (var k = 0; k < PROMPT_SECTION_ORDER.length; k++) {
    if (hit[PROMPT_SECTION_ORDER[k]]) out.push(PROMPT_SECTION_ORDER[k]);
  }
  /* 有命中才带语言口味（节序表把它钉在末位：紧贴上下文尾部最容易被照做） */
  if (out.length && !hit.lang_taste) out.push("lang_taste");
  var set = {};
  for (var j = 0; j < out.length; j++) set[out[j]] = 1;
  return {
    ids: out,
    hit: out.length > 0,
    has: function (id) {
      return !!set[String(id == null ? "" : id)];
    },
  };
}

/* 旧名别名（历史叫法：这张表当初只服务纯净模式）。两个名字指向同一份实现 —— 调哪个都行，
 * 但只许有一份判据。 */
const purePromptSections = promptTrimSections;

/* 调试与文档便利：规范节序的可读拷贝 */
function promptSectionCatalog() {
  return PROMPT_SECTION_ORDER.slice();
}

if (typeof window !== "undefined") {
  window.PROMPT_SECTION_ORDER = PROMPT_SECTION_ORDER;
  window.PROMPT_SECTION_IDS = PROMPT_SECTION_IDS;
  window.buildSections = buildSections;
  window.renderSections = renderSections;
  window.promptSectionHash = promptSectionHash;
  window.promptSectionRank = promptSectionRank;
  window.promptSectionStats = promptSectionStats;
  window.promptSectionCatalog = promptSectionCatalog;
  window.promptSectionSnapshot = promptSectionSnapshot;
  window.invalidatePromptSections = invalidatePromptSections;
  window.setPromptSectionDiff = setPromptSectionDiff;
  window.promptSectionDiffEnabled = promptSectionDiffEnabled;
  /* 基线档命中表：会话链（app-assist.js）与运行链（app-db.js）共用这一份 */
  window.PURE_PROMPT_HIT_RULES = PURE_PROMPT_HIT_RULES;
  window.promptTrimSections = promptTrimSections;
  window.purePromptSections = purePromptSections;
}

"use strict";
/* ============ 专家团（Team）· 数据模型与配置存储 ============
 *
 * 本文件是「专家团」这一层数据的**唯一真源**：schema、默认值、归一化、迁移与持久化
 * 全部只写在这里；UI（团队面板 / 专家编辑 / 招募 / 对话）只读这里的 getter、只走这里的
 * mutator，不得自抄一份字段表或默认值。
 *
 * 加载顺序：renderer/index.html 中位于 app-team-icons.js 之后（图标键归一化要用它）、
 * app-boot.js 之前。
 * 启动时由 app-boot.js init() 调用 MTNodeTeam.ensure(S.config) 做缺省合并 + 迁移
 * （旧配置没有 team 键就初始化，幂等；不重复落盘）。
 *
 * 持久化：window.api.configSave(S.config)（preload.js:47 的 config:save 通道），
 * 不新增任何 IPC / 主进程改动。
 *
 * 数据结构（S.config.team）：
 *   {
 *     version: 3,
 *     canvases:      [Canvas],     // 画布锚点（v1 的 projects 迁移而来；「项目」概念已取消）
 *     experts:       [Expert],
 *     chats:         [Chat],
 *     recruitDrafts: [RecruitDraft],
 *     categories:    [Category],   // 专家分类（默认内置 8 个，用户可自建 / 删除）
 *     templates:     [Template],   // 用户自建的角色模板（内置模板在 app-team-recruit.js）
 *   }
 *
 * Canvas       = { id, name, workspace, desc, fact, createdAt, updatedAt }
 *   id   = 画布 workflow id（currentVisibleWfId()；S.wf.id 兜底）
 *   name = 画布名快照（S.wf.name，空则「未命名画布」）
 *   fact = 该画布锚点的「事实库」记录（不存在 / null = 尚未建库）：
 *          { id, name, dir, assetsDir, providerId, model, temperature,
 *            docs: [ { id, name, file, reviewFile, createdAt, updatedAt } ],
 *            createdAt, updatedAt }
 *          dir / assetsDir = 绝对路径，建库时写死进配置（工作区变更不漂移）；
 *          一篇事实库文档 = 一个 docs 项（各自一份 <doc>.md + <doc>.review.json），
 *          assets/ 为整库共享的插图目录；正文与资产都不上画布，只服务「团队」。
 *          迁移：旧配置只有单条 file（无 docs）时自动折成 docs[0]（幂等，未知键保留）；
 *          file / reviewFile 在库记录上保留为首文档路径镜像，供旧调用点读。
 *   —— 用户不再手建「项目」：专家与会话都挂在画布锚点上，换画布即换团队上下文。
 * Category     = { id, name, createdAt, updatedAt }
 * Expert       = {
 *   id, canvasId, name, icon, color, image?,
 *   glyph,                    // 兼容层：旧 emoji 头像（已废弃，仅读；图标见 icon）
 *   category,                 // 分类名（"" = 未分类）；名称即分组键，重名由 addCategory 拒绝
 *   role,
 *   persona: { tagline, background, expertise[], style, tone, language },
 *   prompt:  { identity, goal, constraints, output },
 *   model:   { provider, model, effort, preset },
 *   perm:    { permissionPreset, toolAllow },
 * }
 *   icon = 图标键（renderer/app-team-icons.js 的 TEAM_ICON_CATALOG）；颜色只落在描边。
 *   projectId = canvasId 的旧名，仅作读兼容保留（新增写入只写 canvasId）。
 * Chat         = { id, expertId, canvasId, title, messages[], archived, createdAt, updatedAt }
 * RecruitDraft = Expert 的草稿形态（同 schema + status:"draft" + brief，字段可半空）
 * Template     = Expert 的形状 + custom:true（用户模板；内置模板不落配置）
 *
 * perm.toolAllow 的 key 逐字对齐 renderer/app-nodes.js:9423 agentToolCatalog()：
 *   fs_read / fs_write / web / ask_user / canvas_read = allow
 *   画布改动（节点与连线 / 控制类 / 绘图 / 排版 / 超级节点）与应用操作 = ask · shell = ask
 *   app_delete / app_dsh_plugins / subagent / goal / jobs / vision = deny
 *   （v4 起「默认开放更多权限」：专家能自行查看与核验画布，改画布 / 动应用前逐次确认；
 *     旧默认「画布与应用一律拒绝」由 migrateExpertsV4 抬到新默认，见该函数）
 * 值只用三种字符串："allow" | "ask" | "deny"（与 app-nodes.js normalizeToolMode 同词表）。
 *
 * 运行接线：一次专家发言 = 一次 dshRunTask（runKey = team:<chatId>:<expertId>，人设经
 * systemPrompt 落到 persona_host 分节，provider/model/effort/preset 与 permissionPreset
 * 取自专家自身配置）。执行入口见文件末「运行接线」一节，同时挂到 window.MTNodeTeamChat
 * （团队视图检测到它即自动让位，单聊 / 群聊共用同一条链路）。
 *
 * 公开接口：window.MTNodeTeam（同时把 team* 函数留在全局，同层脚本可直接调用）。
 */
(function () {
  var VERSION = 4;

  /* 默认分类（首次初始化时预置，用户可改名 / 删除；删空后不再自动补回）。 */
  var DEFAULT_CATEGORIES = ["研发", "设计", "产品", "数据", "运维", "安全", "商业", "内容"];

  function T(s) {
    return window.I18n && window.I18n.t ? window.I18n.t(s) : String(s);
  }

  /* ── 图标（唯一真源在 renderer/app-team-icons.js） ── */

  function icons() {
    try {
      return window.MTNodeTeamIcons || null;
    } catch (e) {
      return null;
    }
  }
  /* 归一化图标键：合法键原样返回；旧 emoji 走映射；其余走兜底键。 */
  function normalizeIcon(v, fallback) {
    var api = icons();
    if (api && typeof api.normalize === "function") return api.normalize(v, fallback);
    var k = str(v).trim();
    return k || fallback || "person";
  }
  function iconFor(name) {
    var api = icons();
    var list = api && typeof api.keys === "function" ? api.keys() : ["person"];
    return list[hashOf(name) % list.length] || "person";
  }
  /* 旧 emoji → 图标键（迁移用）；映射不到返回 ""。 */
  function iconFromGlyph(glyph) {
    var api = icons();
    if (api && typeof api.fromGlyph === "function") return str(api.fromGlyph(glyph));
    return "";
  }

  /* ───────────────────────── 工具许可（对齐 agentToolCatalog） ───────────────────────── */

  /* 顺序 = 面板展示顺序；分组 id 与 app-nodes.js agentToolCatalog() 的 cat.id 一致。 */
  var TOOL_KEYS = [
    { cat: "core", key: "fs_read", label: "读取文件" },
    { cat: "core", key: "fs_write", label: "写入文件" },
    { cat: "core", key: "shell", label: "执行命令" },
    { cat: "core", key: "web", label: "联网搜索" },
    { cat: "core", key: "ask_user", label: "反问用户" },
    { cat: "core", key: "subagent", label: "子代理" },
    { cat: "core", key: "goal", label: "目标与清单" },
    { cat: "core", key: "jobs", label: "后台作业" },
    { cat: "vision", key: "vision", label: "识图" },
    { cat: "canvas", key: "canvas_read", label: "读取画布" },
    { cat: "canvas", key: "canvas_nodes", label: "节点与连线" },
    { cat: "canvas", key: "canvas_control", label: "控制类节点" },
    { cat: "canvas", key: "canvas_draw", label: "绘图" },
    { cat: "canvas", key: "canvas_layout", label: "排版与成组" },
    { cat: "canvas", key: "canvas_super", label: "超级节点" },
    { cat: "app", key: "app_ops", label: "应用操作" },
    { cat: "app", key: "app_delete", label: "删除画布" },
    { cat: "app", key: "app_dsh_plugins", label: "插件管理" },
    { cat: "assets", key: "assets_read", label: "读素材库 / 窗口截图" },
  ];

  var TOOL_MODES = ["allow", "ask", "deny"];

  /* 专家默认许可（v4 起「默认开放更多权限」，见 migrateExpertsV4）：
     · 读文件 / 写文件 / 联网 / 反问 + **读取画布**放行 —— 专家开箱即可查看与核验画布；
     · 画布改动（节点与连线 / 控制类 / 绘图 / 排版 / 超级节点）与应用操作逐次询问：
       专家能真的动画布，但每一次都经「工具许可询问」由用户点头（团队会话不是
       agent session，app-nodes.js 的 canvasOpNeedsConfirm 那道统一确认门不覆盖它，
       所以这里保留 ask 作为人在环上）；
     · 删除画布 / 插件管理 / 子代理 / 目标 / 作业 / 识图仍拒绝（危险或与专家角色无关）。
     写文件默认放行 = 专家开箱即可读写事实库（新建 / 更新文档不再逐次弹许可卡）；
     写根之外仍受 dsh 沙箱与升权审批管辖，事实库目录另由「运行级写根」单独授权
     （expertRunParams 的 writeRoots + app-db.js 的按运行自动放行）。
     画布类放行的前提是「画布整档闸」不再一刀切：见 expertNoCanvas。 */
  var DEFAULT_TOOL_ALLOW = {
    fs_read: "allow",
    fs_write: "allow",
    shell: "ask",
    web: "allow",
    ask_user: "allow",
    subagent: "deny",
    goal: "deny",
    jobs: "deny",
    vision: "deny",
    canvas_read: "allow",
    canvas_nodes: "ask",
    canvas_control: "ask",
    canvas_draw: "ask",
    canvas_layout: "ask",
    canvas_super: "ask",
    app_ops: "ask",
    app_delete: "deny",
    app_dsh_plugins: "deny",
    /* 素材库 / 窗口截图：素材库是用户自己的目录、截图拍的是应用窗口 —— 与专家角色
       关系不大，默认拒绝（要用的专家自己在面板里放开）。 */
    assets_read: "deny",
  };

  /* 画布六类许可（与 app-nodes.js AGENT_TOOL_DENY_ALL_OF.mtnode_canvas_edit 同组）——
     「画布整档闸」按这一组判：全拒才摘掉画布三件套。 */
  var CANVAS_TOOL_KEYS = TOOL_KEYS.filter(function (x) {
    return x.cat === "canvas";
  }).map(function (x) {
    return x.key;
  });

  function toolKeys() {
    return TOOL_KEYS.map(function (x) {
      return x.key;
    });
  }
  function defaultToolAllow() {
    var out = {};
    toolKeys().forEach(function (k) {
      out[k] = DEFAULT_TOOL_ALLOW[k] || "allow";
    });
    return out;
  }
  function normalizeToolMode(v) {
    var s = str(v).trim().toLowerCase();
    if (TOOL_MODES.indexOf(s) >= 0) return s;
    if (v === true || v === "允许") return "allow";
    if (v === false || v === "reject" || v === 0 || v === "拒绝") return "deny";
    if (v === "询问") return "ask";
    return "allow";
  }
  function normalizeToolAllow(raw) {
    var base = defaultToolAllow();
    var src = raw && typeof raw === "object" ? raw : {};
    toolKeys().forEach(function (k) {
      if (src[k] !== undefined) base[k] = normalizeToolMode(src[k]);
    });
    return base;
  }
  /* 运行期真源仍是 app-nodes.js 的 agentToolCatalog()；取不到时用本文件的静态表兜底。 */
  function toolCatalog() {
    try {
      if (typeof agentToolCatalog === "function") return agentToolCatalog();
    } catch (e) {}
    return TOOL_KEYS.map(function (x) {
      return { key: x.key, cat: x.cat, label: T(x.label) };
    });
  }

  /* ───────────────────────── 外观调色板 ───────────────────────── */

  /* 兼容层：旧 emoji 头像表（已废弃）。新数据一律用 icon 图标键，
     这里的 glyphFor 只服务「读旧数据时不至于空白」，不再用于新建。 */
  var GLYPHS = ["🧭", "🧠", "🔍", "✍️", "📊", "🛠️", "🎯", "🧩", "📐", "🧪", "💡", "🗂️"];
  var COLORS = [
    "#6db4ff",
    "#45cfe6",
    "#c792ea",
    "#4dd0c4",
    "#ff8fa3",
    "#f0c14d",
    "#ff9d5c",
    "#a8e05f",
  ];

  function hashOf(s) {
    var h = 0;
    var str = String(s == null ? "" : s);
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function glyphFor(name) {
    return GLYPHS[hashOf(name) % GLYPHS.length];
  }
  function colorFor(name) {
    return COLORS[hashOf(name) % COLORS.length];
  }
  function pick(list, v, fallback) {
    var s = String(v == null ? "" : v).trim();
    return list.indexOf(s) >= 0 ? s : fallback;
  }

  /* ───────────────────────── 归一化 ───────────────────────── */

  function newId(prefix) {
    if (typeof uid === "function") return uid(prefix || "tm");
    return (
      (prefix || "tm") +
      Date.now().toString(36) +
      Math.floor(Math.random() * 46656).toString(36)
    );
  }
  function str(v) {
    return String(v == null ? "" : v);
  }
  function arr(v) {
    return Array.isArray(v) ? v.filter(function (x) {
      return x != null && String(x).trim() !== "";
    }).map(function (x) {
      return String(x);
    }) : [];
  }
  function stamp(v) {
    var n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function normalizePreset(v) {
    var s = str(v).trim();
    try {
      if (typeof AGENT_PRESET_LEGACY_IDS === "object" && AGENT_PRESET_LEGACY_IDS[s])
        s = AGENT_PRESET_LEGACY_IDS[s];
      if (Array.isArray(AGENT_PRESETS) && AGENT_PRESETS.some(function (p) {
        return p && p.id === s;
      }))
        return s;
      if (typeof AGENT_PRESET_DEFAULT === "string" && AGENT_PRESET_DEFAULT)
        return AGENT_PRESET_DEFAULT;
    } catch (e) {}
    return "minimal";
  }
  function normalizeEffort(v) {
    try {
      if (typeof normalizeAgentEffort === "function") return normalizeAgentEffort(v);
    } catch (e) {}
    return "high";
  }
  /* 温度：0–2、步进 0.1、缺省 0.7；非数字回落 0.7，越界夹取（口径同 app-canvas.js 的
     nsTemperatureField：先取 fallback 再 min/max 夹）。仅存配置供专家卡展示，不下发。 */
  function normalizeTemperature(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) n = 0.7;
    n = Math.max(0, Math.min(2, n));
    return Math.round(n * 100) / 100;
  }
  function normalizePermissionPreset(v) {
    var s = str(v).trim();
    try {
      if (typeof permissionPresetOptions === "function") {
        var opts = permissionPresetOptions();
        if (opts.some(function (x) {
          return x && x[0] === s;
        }))
          return s;
      }
    } catch (e) {}
    if (s === "workspace-write" || s === "read-only" || s === "danger-full-access")
      return s;
    return "mtnode-unattended";
  }

  function blankPersona(raw) {
    var p = raw && typeof raw === "object" ? raw : {};
    return {
      tagline: str(p.tagline),
      background: str(p.background),
      expertise: arr(p.expertise),
      style: str(p.style),
      tone: str(p.tone),
      language: str(p.language),
    };
  }
  function blankPrompt(raw) {
    var p = raw && typeof raw === "object" ? raw : {};
    return {
      identity: str(p.identity),
      goal: str(p.goal),
      constraints: str(p.constraints),
      output: str(p.output),
    };
  }
  function blankModel(raw) {
    var m = raw && typeof raw === "object" ? raw : {};
    return {
      provider: str(m.provider) || "deepseek-official",
      model: str(m.model),
      effort: normalizeEffort(m.effort),
      preset: normalizePreset(m.preset),
      temperature: normalizeTemperature(m.temperature),
    };
  }
  function blankPerm(raw) {
    var p = raw && typeof raw === "object" ? raw : {};
    return {
      permissionPreset: normalizePermissionPreset(p.permissionPreset),
      toolAllow: normalizeToolAllow(p.toolAllow),
    };
  }

  /* 保留未知键（后续版本 / 兄弟模块加的字段不被吃掉），已知键一律用归一值覆盖。 */
  function normalizeExpert(raw) {
    var x = raw && typeof raw === "object" ? Object.assign({}, raw) : {};
    var name = str(x.name);
    x.id = str(x.id) || newId("exp");
    /* 画布锚点：canvasId 为规范字段，projectId 是 v1 旧名（读兼容，写时同步镜像）。 */
    var cid = str(x.canvasId) || str(x.projectId);
    x.canvasId = cid;
    x.projectId = cid;
    x.name = name;
    /* 图标键为规范字段；旧 emoji（glyph）走映射迁移，映射不到按键哈希兜底。 */
    x.icon = normalizeIcon(x.icon || x.glyph, iconFor(name || x.id));
    x.glyph = str(x.glyph);
    x.color = pick(COLORS, x.color, colorFor(name || x.id));
    if (x.image != null) x.image = str(x.image);
    x.category = str(x.category).trim();
    x.role = str(x.role);
    x.persona = blankPersona(x.persona);
    x.prompt = blankPrompt(x.prompt);
    x.model = blankModel(x.model);
    x.perm = blankPerm(x.perm);
    x.createdAt = stamp(x.createdAt);
    x.updatedAt = stamp(x.updatedAt);
    return x;
  }

  /* 用户自建模板 = Expert 形状 + custom:true（内置 14 个模板不落配置，见 app-team-recruit.js）。 */
  function normalizeTemplate(raw) {
    var x = normalizeExpert(raw);
    x.id = str((raw && raw.id) || "") || newId("tpl");
    x.custom = true;
    x.createdAt = stamp(raw && raw.createdAt);
    x.updatedAt = stamp(raw && raw.updatedAt);
    return x;
  }

  /* v2 → v3 迁移（幂等）：写文件许可的旧默认是「询问」，专家因此每写一次事实库都要弹卡；
     现默认放行为「允许」。存量专家只在**确实还停在旧默认**（raw = "ask"）时抬到 allow，
     用户显式设成 deny 的不动。写根之外的写仍受 dsh 沙箱与升权审批管辖。 */
  function migrateExpertsV3(rawExperts) {
    if (!Array.isArray(rawExperts)) return;
    rawExperts.forEach(function (e) {
      if (!e || typeof e !== "object") return;
      var perm = e.perm && typeof e.perm === "object" ? e.perm : null;
      var ta = perm && perm.toolAllow;
      if (!ta || typeof ta !== "object") return;
      if (ta.fs_write === "ask") ta.fs_write = "allow";
    });
  }

  /* v3 → v4 迁移只要抬这一组键（旧默认 deny → 新默认 allow / ask），见 migrateExpertsV4。 */
  var V4_LIFTED_KEYS = [
    "canvas_read",
    "canvas_nodes",
    "canvas_control",
    "canvas_draw",
    "canvas_layout",
    "canvas_super",
    "app_ops",
  ];

  /* v3 → v4 迁移（幂等）：画布六类与应用操作的旧默认是「拒绝」，专家因此看不到画布
     （app-nodes.js agentDeniedToolNames 把 mtnode_canvas_get / mtnode_canvas_edit / mtnode_app
     整档摘掉），既不能核验节点也无法动画布 —— 报错里那句「工具许可只有读 / 写 / 联网 / 反问」
     即由此而来。现默认「读画布放行、改画布与应用操作逐次询问」。存量专家只在**确实还停在
     旧默认**（raw = "deny"）时抬到新默认，口径与 v2 → v3 一致（显式改过的键已不可区分，
     统一按旧默认处理，用户可在招聘 / 专家编辑面板逐项改回）。
     模板与招聘草稿同口径：它们形状就是 Expert。 */
  function migrateExpertsV4(rawExperts) {
    if (!Array.isArray(rawExperts)) return;
    rawExperts.forEach(function (e) {
      if (!e || typeof e !== "object") return;
      var perm = e.perm && typeof e.perm === "object" ? e.perm : null;
      var ta = perm && perm.toolAllow;
      if (!ta || typeof ta !== "object") return;
      /* 只抬「v3 旧默认 = deny、v4 新默认 ≠ deny」的这一组键：读画布 → allow，
         其余画布类与应用操作 → ask。仍拒绝的键（删除画布 / 插件 / 子代理 / 目标 / 作业 /
         识图）以及本来默认就不是 deny 的键（fs_read / fs_write / web / ask_user…）一律不动 ——
         那些位置上的 deny 只能是用户自己设的。 */
      V4_LIFTED_KEYS.forEach(function (k) {
        if (ta[k] === "deny") ta[k] = DEFAULT_TOOL_ALLOW[k];
      });
    });
  }

  /* 分类：名称即分组键（专家 category 存名称），重名由 addCategory 拒绝。 */
  function normalizeCategory(raw) {
    var x = raw && typeof raw === "object" ? Object.assign({}, raw) : {};
    x.id = str(x.id) || newId("cat");
    x.name = str(x.name).trim();
    x.createdAt = stamp(x.createdAt);
    x.updatedAt = stamp(x.updatedAt);
    return x;
  }

  /* ── 事实库路径小工具（渲染层无 node path；与 app-factlib.js 同口径） ── */
  function factDirNameOf(p) {
    var s = str(p).replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    if (i <= 0) return i === 0 ? s.slice(0, 1) : "";
    return s.slice(0, i);
  }
  function factBaseNameOf(p) {
    var s = str(p).replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function factStripExt(name) {
    var s = str(name);
    var i = s.lastIndexOf(".");
    return i > 0 ? s.slice(0, i) : s;
  }

  /* 单篇事实库文档（库记录 docs[] 项；未知键保留）。
     路径由 app-factlib.js 在建档时解析成绝对路径写进来，此处只做归一化。 */
  function normalizeFactDoc(raw) {
    if (!raw || typeof raw !== "object") return null;
    var d = Object.assign({}, raw);
    d.id = str(d.id) || newId("fdoc");
    d.file = str(d.file);
    d.reviewFile = str(d.reviewFile);
    d.name = str(d.name).trim();
    if (!d.name && d.file) d.name = factStripExt(factBaseNameOf(d.file));
    if (!d.name) d.name = T("文档");
    d.createdAt = stamp(d.createdAt);
    d.updatedAt = stamp(d.updatedAt);
    return d;
  }

  /* 库记录上的 file / reviewFile 镜像首篇文档路径（旧调用点仍读 f.file）。 */
  function syncFactMirror(f) {
    if (!f || typeof f !== "object") return f;
    var first = Array.isArray(f.docs) && f.docs.length ? f.docs[0] : null;
    f.file = first ? str(first.file) : "";
    f.reviewFile = first ? str(first.reviewFile) : "";
    return f;
  }

  /* 事实库记录（每个画布锚点一份库、库内多篇文档，嵌套在锚点上；未知键保留）。
     路径与资产目录在建库时由 app-factlib.js 解析成绝对路径写死进来，
     之后一律读配置里的绝对路径，不再跟着工作区漂移。
     迁移（幂等）：旧配置的单条 file（无 docs）折成 docs[0]。 */
  function normalizeFact(raw) {
    if (!raw || typeof raw !== "object") return null;
    var f = Object.assign({}, raw);
    f.id = str(f.id) || newId("fact");
    f.name = str(f.name).trim() || T("事实库");
    f.dir = str(f.dir);
    f.assetsDir = str(f.assetsDir);
    f.providerId = str(f.providerId);
    f.model = str(f.model);
    f.temperature = normalizeTemperature(f.temperature);
    var docs = [];
    if (Array.isArray(f.docs)) {
      f.docs.forEach(function (d) {
        var n = normalizeFactDoc(d);
        if (n) docs.push(n);
      });
    } else if (str(f.file)) {
      docs.push(normalizeFactDoc({ name: f.name, file: f.file }));
    }
    f.docs = docs;
    if (!f.dir && docs.length) f.dir = factDirNameOf(docs[0].file);
    syncFactMirror(f);
    f.createdAt = stamp(f.createdAt);
    f.updatedAt = stamp(f.updatedAt);
    return f;
  }

  /* 画布锚点：id = 画布 workflow id，name = 画布名快照。
     v1 的「项目」在此迁移：旧 id / name 原样保留，专家与会话因此不会丢。 */
  function normalizeCanvas(raw) {
    var x = raw && typeof raw === "object" ? Object.assign({}, raw) : {};
    var name = str(x.name).trim();
    x.id = str(x.id) || newId("cv");
    x.name = name || T("未命名画布");
    x.workspace = str(x.workspace);
    x.desc = str(x.desc);
    x.fact = normalizeFact(x.fact);
    x.createdAt = stamp(x.createdAt);
    x.updatedAt = stamp(x.updatedAt);
    return x;
  }
  /* 兼容层：normalizeProject 是 normalizeCanvas 的旧名。 */
  var normalizeProject = normalizeCanvas;

  /* 建议卡（主持人聚合产出）：字段对齐 03-multi-role-orchestration.md §4.2 的决策记录，
     是「讨论 → 资产」的最小单元。落盘 / 采纳都只读它，不再另抄一份字段表。 */
  function normalizeAdviceCard(raw) {
    var c = raw && typeof raw === "object" ? raw : {};
    return {
      title: str(c.title),
      question: str(c.question),
      conclusion: str(c.conclusion),
      rationale: str(c.rationale),
      evidence: arr(c.evidence),
      dissent: Array.isArray(c.dissent)
        ? c.dissent
            .filter(function (d) {
              return d && typeof d === "object";
            })
            .map(function (d) {
              return {
                role: str(d.role),
                point: str(d.point),
                reason: str(d.reason || d.reason_not_adopted),
              };
            })
        : [],
      unresolved: arr(c.unresolved),
      assumptions: arr(c.assumptions),
      nextActions: Array.isArray(c.nextActions)
        ? c.nextActions
            .map(function (a) {
              if (a == null) return null;
              if (typeof a === "string") return { action: str(a), owner: "", due: "" };
              return {
                action: str(a.action),
                owner: str(a.owner),
                due: str(a.due),
              };
            })
            .filter(function (a) {
              return a && a.action;
            })
        : [],
      confidence: str(c.confidence),
    };
  }

  /* 群聊消息带发言人署名（图标 / 名称 / 颜色），单聊消息不带；建议卡消息多一个 card。 */
  var MSG_SIGN_KEYS = [
    "expertId",
    "name",
    "icon",
    "glyph",
    "color",
    "error",
    "adopted",
    "adoptedPath",
    "advicePath",
  ];

  /* 上一轮实际参与人（selectParticipants 的决策结果，群聊每跑一轮覆盖一次）：
       { ids[], names[], reason, mode, round, at }
     mode = mention（用户 @ 定向，跳过选人）| host（主持人选人）| local（本地相关性回退）；
     团队视图据此回显本轮参与人与理由，聚合输入也按它拼装「本轮参与人 + 发言」。 */
  var LAST_ROUND_MODES = ["mention", "host", "local"];
  function normalizeLastRound(raw) {
    if (!raw || typeof raw !== "object") return null;
    var ids = arr(raw.ids);
    if (!ids.length) return null;
    return {
      ids: ids,
      names: arr(raw.names),
      reason: str(raw.reason),
      mode: pick(LAST_ROUND_MODES, raw.mode, "local"),
      round: Math.max(0, Math.floor(Number(raw.round) || 0)),
      at: stamp(raw.at),
    };
  }
  function lastRoundOf(chat) {
    var lp = chat && chat.lastParticipants;
    return lp && typeof lp === "object" ? lp : null;
  }
  function lastRoundIds(chat) {
    var lp = lastRoundOf(chat);
    return lp ? arr(lp.ids) : [];
  }

  function normalizeChat(raw) {
    var x = raw && typeof raw === "object" ? Object.assign({}, raw) : {};
    x.id = str(x.id) || newId("tch");
    x.kind = x.kind === "group" ? "group" : "single";
    x.expertId = str(x.expertId);
    /* 画布锚点：canvasId 规范，projectId 为旧名读兼容镜像。 */
    var ccid = str(x.canvasId) || str(x.projectId);
    x.canvasId = ccid;
    x.projectId = ccid;
    /* 群聊参与者（专家 id 列表）与主持人；单聊为空。 */
    x.participants = arr(x.participants);
    x.facilitatorId = str(x.facilitatorId);
    /* 专家被删除后保留的会话：记下当时的专家名 / 图标 / 颜色，
       团队视图据此把这条会话标成「专家已删除」，仍可回看历史（避免信息丢失）。 */
    x.expertName = str(x.expertName);
    x.expertIcon = str(x.expertIcon);
    x.expertColor = str(x.expertColor);
    x.round = Math.max(0, Math.floor(Number(x.round) || 0));
    /* 上一轮实际参与人 + 选人理由（群聊编排写入，见 selectParticipants）。 */
    x.lastParticipants = normalizeLastRound(x.lastParticipants);
    x.title = str(x.title) || T("新对话");
    x.messages = Array.isArray(x.messages)
      ? x.messages
          .filter(function (m) {
            return m && typeof m === "object";
          })
          .map(function (m) {
            var o = {
              role: m.role === "assistant" ? "assistant" : "user",
              content: str(m.content),
            };
            if (m.reasoning) o.reasoning = str(m.reasoning);
            if (Array.isArray(m.tools) && m.tools.length) o.tools = m.tools;
            if (m.kind === "advice") o.kind = "advice";
            MSG_SIGN_KEYS.forEach(function (k) {
              if (m[k] !== undefined && m[k] !== null && m[k] !== "") o[k] = str(m[k]);
            });
            if (m.card && typeof m.card === "object") o.card = normalizeAdviceCard(m.card);
            return o;
          })
      : [];
    x.archived = !!x.archived;
    x.createdAt = stamp(x.createdAt);
    x.updatedAt = stamp(x.updatedAt);
    return x;
  }

  /* 招募草稿 = 半成品专家：字段可空，但结构完全同 Expert（方便「录用」时直接落库）。 */
  function normalizeRecruitDraft(raw) {
    var x = normalizeExpert(raw);
    x.id = str((raw && raw.id) || "") || newId("rcd");
    x.status = "draft";
    x.brief = str((raw && raw.brief) || "");
    x.createdAt = stamp(raw && raw.createdAt);
    x.updatedAt = stamp(raw && raw.updatedAt);
    return x;
  }

  function listOf(raw, fn) {
    return Array.isArray(raw)
      ? raw.filter(function (x) {
          return x && typeof x === "object";
        }).map(fn)
      : [];
  }

  /* 归一化整个 team 段（幂等）。返回 { team, changed }。
   *
   * v1 → v2 迁移（幂等，专家与对话一个不丢）：
   *   · projects[] → canvases[]（旧 id / name 原样保留，旧项目名即锚点名）；
   *   · Expert / Chat / RecruitDraft 的 projectId → canvasId（normalize* 里做，并保留镜像）；
   *   · Expert / Template 的 emoji glyph → icon 图标键（映射表在 app-team-icons.js）；
   *   · categories 首次初始化时预置 8 个默认分类（用户删空后不再自动补回）。 */
  function normalizeConfig(teamRaw) {
    var raw = teamRaw && typeof teamRaw === "object" ? teamRaw : {};
    /* canvases 优先；旧配置只有 projects 时用它迁移（不删旧键，写盘时由 team 段替换）。 */
    var rawCanvases = Array.isArray(raw.canvases)
      ? raw.canvases
      : Array.isArray(raw.projects)
        ? raw.projects
        : null;
    var rawCategories = Array.isArray(raw.categories) ? raw.categories : null;
    /* v2 → v3：存量专家的写文件许可从「询问」抬到「允许」（只动旧默认值，见迁移函数）。 */
    migrateExpertsV3(raw.experts);
    /* v3 → v4：画布 / 应用操作的旧默认「拒绝」抬到「读画布放行、改画布与应用操作询问」，
       专家与用户模板 / 招聘草稿同口径（形状都是 Expert）。 */
    migrateExpertsV4(raw.experts);
    migrateExpertsV4(raw.templates);
    migrateExpertsV4(raw.recruitDrafts);
    var categories = rawCategories
      ? listOf(rawCategories, normalizeCategory).filter(function (c) {
          return !!c.name;
        })
      : DEFAULT_CATEGORIES.map(function (n) {
          return normalizeCategory({ name: n, createdAt: Date.now() });
        });
    var team = {
      version: VERSION,
      canvases: listOf(rawCanvases, normalizeCanvas),
      experts: listOf(raw.experts, normalizeExpert),
      chats: listOf(raw.chats, normalizeChat),
      recruitDrafts: listOf(raw.recruitDrafts, normalizeRecruitDraft),
      categories: categories,
      templates: listOf(raw.templates, normalizeTemplate),
    };
    /* fact 字段纳入变更判定：旧配置没有 fact / 手工改坏时也落盘一次（幂等）。 */
    var rawCanvasList = Array.isArray(rawCanvases)
      ? rawCanvases.filter(function (x) {
          return x && typeof x === "object";
        })
      : [];
    var factChanged = rawCanvasList.some(function (rc, i) {
      var before = rc.fact && typeof rc.fact === "object" ? rc.fact : null;
      var after = (team.canvases[i] && team.canvases[i].fact) || null;
      return JSON.stringify(before) !== JSON.stringify(after);
    });
    var changed =
      !teamRaw ||
      typeof teamRaw !== "object" ||
      Number(raw.version || 0) !== VERSION ||
      !Array.isArray(raw.canvases) ||
      !Array.isArray(raw.experts) ||
      !Array.isArray(raw.chats) ||
      !Array.isArray(raw.recruitDrafts) ||
      !rawCategories ||
      !Array.isArray(raw.templates) ||
      factChanged;
    return { team: team, changed: changed };
  }

  /* ───────────────────────── 配置挂载 / 持久化 ───────────────────────── */

  function configRef() {
    try {
      if (typeof S !== "undefined" && S && S.config) return S.config;
    } catch (e) {}
    return null;
  }

  /* 缺省合并 + 迁移（幂等）。cfg 省略 = 当前 S.config。
     opts.persist = true 时变更后落盘（启动路径不落盘，避免每次启动写一次配置）。 */
  function ensure(cfg, opts) {
    var c = cfg || configRef();
    if (!c || typeof c !== "object") return null;
    var had = c.team && typeof c.team === "object";
    var res = normalizeConfig(c.team);
    c.team = res.team;
    /* 旧配置有 team 但形状变了（版本升级 / 手工改坏）→ 需要时落盘一次 */
    if (res.changed && had && opts && opts.persist === true) save();
    return c.team;
  }

  function team() {
    var c = configRef();
    if (!c) return null;
    if (!c.team || typeof c.team !== "object") return ensure(c);
    return c.team;
  }

  function save() {
    var c = configRef();
    if (!c || !window.api || !window.api.configSave) return Promise.resolve(false);
    return Promise.resolve(window.api.configSave(c)).then(
      function () {
        return true;
      },
      function () {
        return false;
      },
    );
  }

  /* 统一出口：任何写操作都「先改内存 → 标 updatedAt → 落盘」。 */
  function touch(obj) {
    if (obj && typeof obj === "object") obj.updatedAt = Date.now();
    return obj;
  }

  /* ───────────────────────── 读 ───────────────────────── */

  /* ── 画布锚点 ── */

  function canvases() {
    var t = team();
    return t ? t.canvases : [];
  }
  function canvas(id) {
    var k = str(id);
    return canvases().find(function (p) {
      return p.id === k;
    }) || null;
  }
  /* 兼容层：projects / project 是 canvases / canvas 的旧名。 */
  var projects = canvases;
  var project = canvas;

  /* 当前画布 id / 名称（团队视图没有 canvasWfId，锚点就是用户此刻看到的画布）。 */
  function currentCanvasId() {
    try {
      if (typeof currentVisibleWfId === "function") {
        var id = str(currentVisibleWfId());
        if (id) return id;
      }
    } catch (e) {}
    try {
      return str(S && S.wf && S.wf.id);
    } catch (e) {
      return "";
    }
  }
  function currentCanvasName() {
    try {
      var n = str(S && S.wf && S.wf.name).trim();
      if (n) return n;
    } catch (e) {}
    return T("未命名画布");
  }
  /* 确保当前画布已有锚点（不存在就按需建一个），返回该锚点；拿不到画布 id 时返回 null。
     name 每次进团队视图时按当前画布名刷新（画布改名后锚点跟着变）。 */
  function ensureCanvas(over) {
    var t = team();
    if (!t) return null;
    var id = str(over && over.id) || currentCanvasId();
    if (!id) return null;
    var name = str(over && over.name) || currentCanvasName();
    var hit = canvas(id);
    if (hit) {
      if (name && hit.name !== name) {
        hit.name = name;
        touch(hit);
        save();
      }
      return hit;
    }
    var p = normalizeCanvas({
      id: id,
      name: name,
      workspace: str(over && over.workspace),
      desc: str(over && over.desc),
      createdAt: Date.now(),
    });
    p.updatedAt = p.createdAt;
    t.canvases.push(p);
    save();
    return p;
  }

  /* 按画布锚点取专家；省略参数 = 全部专家。 */
  function experts(canvasId) {
    var t = team();
    var list = t ? t.experts : [];
    if (canvasId === undefined || canvasId === null || canvasId === "")
      return list.slice();
    var k = str(canvasId);
    return list.filter(function (e) {
      return str(e.canvasId || e.projectId) === k;
    });
  }
  function expert(id) {
    var k = str(id);
    return experts().find(function (e) {
      return e.id === k;
    }) || null;
  }
  function chats(expertId) {
    var t = team();
    var list = t ? t.chats : [];
    if (expertId === undefined || expertId === null || expertId === "")
      return list.slice();
    var k = str(expertId);
    return list.filter(function (c) {
      return c.expertId === k;
    });
  }
  function chat(id) {
    var k = str(id);
    return chats().find(function (c) {
      return c.id === k;
    }) || null;
  }
  /* 按画布锚点取群聊（单聊按 expertId 取，见 chats）。 */
  function canvasChats(canvasId) {
    var t = team();
    var list = t ? t.chats : [];
    var k = str(canvasId);
    if (!k) return list.slice();
    return list.filter(function (c) {
      return str(c.canvasId || c.projectId) === k;
    });
  }
  function recruitDrafts(canvasId) {
    var t = team();
    var list = t ? t.recruitDrafts : [];
    if (canvasId === undefined || canvasId === null || canvasId === "")
      return list.slice();
    var k = str(canvasId);
    return list.filter(function (d) {
      return str(d.canvasId || d.projectId) === k;
    });
  }
  function recruitDraft(id) {
    var k = str(id);
    return recruitDrafts().find(function (d) {
      return d.id === k;
    }) || null;
  }
  function expertLabel(e) {
    if (!e) return "";
    var api = icons();
    var ic = str(e.icon);
    if (!ic && api && typeof api.fromGlyph === "function") ic = str(api.fromGlyph(e.glyph));
    var tag = ic && api && typeof api.label === "function" ? api.label(ic) : "";
    return (tag ? "[" + tag + "] " : "") + (e.name || e.id);
  }

  /* 分类（专家分组）：顺序 = 创建顺序，左侧栏树状图与编辑表单下拉都读它。 */
  function categories() {
    var t = team();
    return t ? t.categories : [];
  }
  function category(id) {
    var k = str(id);
    return categories().find(function (c) {
      return c.id === k;
    }) || null;
  }
  function categoryByName(name) {
    var k = str(name).trim();
    if (!k) return null;
    return categories().find(function (c) {
      return c.name === k;
    }) || null;
  }
  /* 用户自建模板（内置 14 个模板在 app-team-recruit.js，不落配置）。 */
  function templates() {
    var t = team();
    return t ? t.templates : [];
  }
  function template(id) {
    var k = str(id);
    return templates().find(function (x) {
      return x.id === k;
    }) || null;
  }

  /* ───────────────────────── 写 ───────────────────────── */

  /* 局部补丁合并：persona / prompt / model / perm 以及 perm.toolAllow 做一层深合并，
     这样 UI 只改一个开关（如 fs_write）不会把同组其它字段重置成默认值。 */
  function mergeExpertPatch(base, patch) {
    var out = Object.assign({}, base, patch || {});
    ["persona", "prompt", "model", "perm"].forEach(function (k) {
      if (patch && patch[k] && typeof patch[k] === "object")
        out[k] = Object.assign({}, base[k] || {}, patch[k]);
    });
    if (
      patch &&
      patch.perm &&
      patch.perm.toolAllow &&
      typeof patch.perm.toolAllow === "object"
    ) {
      out.perm = Object.assign({}, out.perm, {
        toolAllow: Object.assign(
          {},
          (base.perm && base.perm.toolAllow) || {},
          patch.perm.toolAllow,
        ),
      });
    }
    return out;
  }

  /* ── 画布锚点写入（用户不再手建「项目」，一般走 ensureCanvas） ── */

  function addCanvas(over) {
    var t = team();
    if (!t) return null;
    var p = normalizeCanvas(Object.assign({}, over, { createdAt: Date.now() }));
    p.updatedAt = p.createdAt;
    t.canvases.push(p);
    save();
    return p;
  }
  function updateCanvas(id, patch) {
    var p = canvas(id);
    if (!p) return null;
    var next = normalizeCanvas(Object.assign({}, p, patch || {}, { id: p.id }));
    Object.keys(p).forEach(function (k) {
      if (!(k in next)) delete p[k];
    });
    Object.assign(p, next);
    touch(p);
    save();
    return p;
  }
  /* 删画布锚点 = 连同该锚点下的专家 / 对话 / 草稿一起删（不留孤儿数据）。 */
  function removeCanvas(id) {
    var t = team();
    var p = canvas(id);
    if (!t || !p) return false;
    var eids = experts(p.id).map(function (e) {
      return e.id;
    });
    t.experts = t.experts.filter(function (e) {
      return str(e.canvasId || e.projectId) !== p.id;
    });
    t.chats = t.chats.filter(function (c) {
      return str(c.canvasId || c.projectId) !== p.id && eids.indexOf(c.expertId) < 0;
    });
    t.recruitDrafts = t.recruitDrafts.filter(function (d) {
      return str(d.canvasId || d.projectId) !== p.id;
    });
    t.canvases = t.canvases.filter(function (x) {
      return x.id !== p.id;
    });
    save();
    return true;
  }
  /* ── 事实库（每个画布锚点一份库、库内多篇文档，嵌套在锚点上） ──

     读：fact(canvasId) 返回库记录或 null（未建库）；factDocs / factDoc 读库内文档。
     写：ensureFact 建库（路径由 app-factlib.js 解析后传入 over），updateFact 局部补丁，
         ensureFactDoc / updateFactDoc / removeFactDoc 维护库内文档（按 id 或名称幂等），
         removeFact 摘掉整个库记录（磁盘上的 md / 资产由调用方按需清理）。
     删画布锚点即随锚点一起消失，无需额外级联。 */

  function fact(canvasId) {
    var p = canvas(canvasId);
    return (p && p.fact) || null;
  }
  function ensureFact(canvasId, over) {
    var p = canvas(canvasId);
    if (!p) return null;
    if (p.fact) return p.fact;
    var f = normalizeFact(
      Object.assign({}, over || {}, { id: "", createdAt: Date.now() }),
    );
    f.updatedAt = f.createdAt;
    p.fact = f;
    touch(p);
    save();
    return f;
  }
  function updateFact(canvasId, patch) {
    var p = canvas(canvasId);
    if (!p || !p.fact) return null;
    var pt = Object.assign({}, patch || {});
    /* 兼容旧单文档调用点：patch.file 表示「唯一那份正文」，落到 docs[0]（含随名重命名）。 */
    if (str(pt.file) && Array.isArray(p.fact.docs) && p.fact.docs.length === 1) {
      var d0 = Object.assign({}, p.fact.docs[0], { file: str(pt.file) });
      if (str(pt.name)) d0.name = str(pt.name);
      pt.docs = [d0];
      delete pt.file;
    }
    var next = normalizeFact(
      Object.assign({}, p.fact, pt, { id: p.fact.id }),
    );
    Object.keys(p.fact).forEach(function (k) {
      if (!(k in next)) delete p.fact[k];
    });
    Object.assign(p.fact, next);
    touch(p.fact);
    touch(p);
    save();
    return p.fact;
  }
  function removeFact(canvasId) {
    var p = canvas(canvasId);
    if (!p || !p.fact) return false;
    p.fact = null;
    touch(p);
    save();
    return true;
  }
  /* ── 库内文档（docs[]） ── */
  function factDocs(canvasId) {
    var f = fact(canvasId);
    return f && Array.isArray(f.docs) ? f.docs : [];
  }
  function factDoc(canvasId, docId) {
    var k = str(docId);
    return (
      factDocs(canvasId).filter(function (d) {
        return d.id === k;
      })[0] || null
    );
  }
  /* 幂等建文档：给了 id 命中就返回；给了 name 同名就返回；否则追加一篇新文档。 */
  function ensureFactDoc(canvasId, over) {
    var p = canvas(canvasId);
    if (!p || !p.fact) return null;
    var f = p.fact;
    if (!Array.isArray(f.docs)) f.docs = [];
    var wantId = str(over && over.id);
    if (wantId) {
      var hit = f.docs.filter(function (d) {
        return d.id === wantId;
      })[0];
      if (hit) return hit;
    }
    var wantName = str(over && over.name).trim();
    if (wantName) {
      var byName = f.docs.filter(function (d) {
        return d.name === wantName;
      })[0];
      if (byName) return byName;
    }
    var d = normalizeFactDoc(Object.assign({}, over || {}, { id: "" }));
    d.createdAt = d.createdAt || Date.now();
    d.updatedAt = d.createdAt;
    f.docs.push(d);
    syncFactMirror(f);
    touch(f);
    touch(p);
    save();
    return d;
  }
  function updateFactDoc(canvasId, docId, patch) {
    var p = canvas(canvasId);
    if (!p || !p.fact || !Array.isArray(p.fact.docs)) return null;
    var k = str(docId);
    var i = p.fact.docs.findIndex(function (d) {
      return d.id === k;
    });
    if (i < 0) return null;
    var cur = p.fact.docs[i];
    var next = normalizeFactDoc(
      Object.assign({}, cur, patch || {}, { id: cur.id }),
    );
    Object.keys(cur).forEach(function (key) {
      if (!(key in next)) delete cur[key];
    });
    Object.assign(cur, next);
    touch(cur);
    syncFactMirror(p.fact);
    touch(p.fact);
    touch(p);
    save();
    return cur;
  }
  function removeFactDoc(canvasId, docId) {
    var p = canvas(canvasId);
    if (!p || !p.fact || !Array.isArray(p.fact.docs)) return false;
    var k = str(docId);
    var before = p.fact.docs.length;
    p.fact.docs = p.fact.docs.filter(function (d) {
      return d.id !== k;
    });
    if (p.fact.docs.length === before) return false;
    syncFactMirror(p.fact);
    touch(p.fact);
    touch(p);
    save();
    return true;
  }
  /* 兼容层（已弃用）：项目级接口映射到画布锚点。 */
  var addProject = addCanvas;
  var updateProject = updateCanvas;
  var removeProject = removeCanvas;

  /* ── 画布删除即团队消失：按磁盘画布列表剪枝 ──
     只在 window.api.wfList() 成功返回非空数组时动手；拿不到列表（API 缺失 / 抛错 /
     空数组）直接返回、不删任何东西 —— S.wfBag 只含本次加载过的画布，按它剪枝会误删。
     当前画布并入存活集合兜底（新建画布可能还没进 wfList）。删除走既有 removeCanvas
     （已级联专家 / 会话 / 草稿），整批删完 save() 一次；幂等，返回删掉的锚点数。 */
  async function pruneCanvases() {
    var t = team();
    if (!t || !t.canvases.length) return 0;
    var list = null;
    try {
      if (!window.api || typeof window.api.wfList !== "function") return 0;
      list = await window.api.wfList();
    } catch (e) {
      return 0;
    }
    if (!Array.isArray(list) || !list.length) return 0;
    var alive = {};
    list.forEach(function (w) {
      var id = str(w && w.id);
      if (id) alive[id] = true;
    });
    var cur = currentCanvasId();
    if (cur) alive[cur] = true;
    var gone = t.canvases.filter(function (p) {
      return !alive[str(p.id)];
    });
    if (!gone.length) return 0;
    gone.forEach(function (p) {
      removeCanvas(p.id);
    });
    save();
    return gone.length;
  }

  /* ── 团队内容增量复制到另一张画布 ──
     只追加、绝不删除或覆盖目标画布已有内容，源画布保持不变。
     专家 / 会话 / 招聘草稿都换新 id，并重映射会话的 expertId / participants /
     facilitatorId，保证复制出来的会话指向复制出来的专家（不与源画布共用）。
     分类与用户模板是全画布共享的库，不参与复制（避免重复建同名分类）。
     返回 { experts, chats, drafts } 计数；源 / 目标相同、缺失或锚点不存在时返回全 0。 */
  function copyCanvas(fromId, toId) {
    var t = team();
    var from = str(fromId);
    var to = str(toId);
    var out = { experts: 0, chats: 0, drafts: 0 };
    if (!t || !from || !to || from === to) return out;
    if (!canvas(from) || !canvas(to)) return out;
    var idMap = {};
    experts(from).forEach(function (e) {
      var copy = normalizeExpert(
        Object.assign({}, e, {
          id: "",
          canvasId: to,
          projectId: to,
          createdAt: Date.now(),
          updatedAt: 0,
        }),
      );
      copy.updatedAt = copy.createdAt;
      idMap[e.id] = copy.id;
      t.experts.push(copy);
      out.experts++;
    });
    t.chats
      .filter(function (c) {
        return str(c.canvasId || c.projectId) === from;
      })
      .forEach(function (c) {
        var copy = normalizeChat(
          Object.assign({}, c, {
            id: "",
            canvasId: to,
            projectId: to,
            createdAt: Date.now(),
            updatedAt: 0,
          }),
        );
        copy.expertId = idMap[c.expertId] || "";
        if (copy.kind === "group") {
          copy.participants = (c.participants || [])
            .map(function (id) {
              return idMap[id] || "";
            })
            .filter(function (id) {
              return !!id;
            });
          copy.facilitatorId =
            idMap[c.facilitatorId] || copy.participants[0] || "";
        }
        /* 孤儿单聊（copy.expertId 为空，原专家已删除）也一并复制保留历史：
           expertName 随会话带过去，在目标画布里同样显示为「专家已删除」，仅可回看。 */
        copy.updatedAt = copy.createdAt;
        t.chats.push(copy);
        out.chats++;
      });
    t.recruitDrafts
      .filter(function (d) {
        return str(d.canvasId || d.projectId) === from;
      })
      .forEach(function (d) {
        var copy = normalizeRecruitDraft(
          Object.assign({}, d, {
            id: "",
            canvasId: to,
            projectId: to,
            createdAt: Date.now(),
            updatedAt: 0,
          }),
        );
        copy.updatedAt = copy.createdAt;
        t.recruitDrafts.push(copy);
        out.drafts++;
      });
    if (out.experts || out.chats || out.drafts) save();
    return out;
  }

  function addExpert(over) {
    var t = team();
    if (!t) return null;
    var e = normalizeExpert(
      Object.assign({}, over, {
        id: "",
        createdAt: Date.now(),
      }),
    );
    e.updatedAt = e.createdAt;
    t.experts.push(e);
    save();
    return e;
  }
  function updateExpert(id, patch) {
    var e = expert(id);
    if (!e) return null;
    var next = normalizeExpert(
      mergeExpertPatch(e, Object.assign({}, patch || {}, { id: e.id })),
    );
    Object.keys(e).forEach(function (k) {
      if (!(k in next)) delete e[k];
    });
    Object.assign(e, next);
    touch(e);
    save();
    return e;
  }
  /* 删除专家：只摘掉专家本身，**保留其全部会话**（避免信息丢失）。
     会话保留原 expertId，并补记当时的专家名 / 图标 / 颜色，成为「孤儿会话」：
     团队视图里标成「专家已删除」，仍可打开回看历史，只是不能再发消息。 */
  function removeExpert(id) {
    var t = team();
    var e = expert(id);
    if (!t || !e) return false;
    t.chats.forEach(function (c) {
      if (c.expertId !== e.id) return;
      if (!str(c.expertName)) c.expertName = str(e.name);
      if (!str(c.expertIcon)) c.expertIcon = str(e.icon);
      if (!str(c.expertColor)) c.expertColor = str(e.color);
    });
    t.experts = t.experts.filter(function (x) {
      return x.id !== e.id;
    });
    save();
    return true;
  }

  function addChat(over) {
    var t = team();
    if (!t) return null;
    var c = normalizeChat(
      Object.assign({}, over, { id: "", createdAt: Date.now() }),
    );
    c.updatedAt = c.createdAt;
    t.chats.push(c);
    save();
    return c;
  }
  function updateChat(id, patch) {
    var c = chat(id);
    if (!c) return null;
    var next = normalizeChat(Object.assign({}, c, patch || {}, { id: c.id }));
    Object.keys(c).forEach(function (k) {
      if (!(k in next)) delete c[k];
    });
    Object.assign(c, next);
    touch(c);
    save();
    return c;
  }
  function removeChat(id) {
    var t = team();
    var c = chat(id);
    if (!t || !c) return false;
    t.chats = t.chats.filter(function (x) {
      return x.id !== c.id;
    });
    save();
    return true;
  }

  function addRecruitDraft(over) {
    var t = team();
    if (!t) return null;
    var d = normalizeRecruitDraft(
      Object.assign({}, over, { id: "", createdAt: Date.now() }),
    );
    d.updatedAt = d.createdAt;
    t.recruitDrafts.push(d);
    save();
    return d;
  }
  function updateRecruitDraft(id, patch) {
    var d = recruitDraft(id);
    if (!d) return null;
    var next = normalizeRecruitDraft(
      mergeExpertPatch(d, Object.assign({}, patch || {}, { id: d.id })),
    );
    Object.keys(d).forEach(function (k) {
      if (!(k in next)) delete d[k];
    });
    Object.assign(d, next);
    touch(d);
    save();
    return d;
  }
  function removeRecruitDraft(id) {
    var t = team();
    var d = recruitDraft(id);
    if (!t || !d) return false;
    t.recruitDrafts = t.recruitDrafts.filter(function (x) {
      return x.id !== d.id;
    });
    save();
    return true;
  }
  /* 录用草稿：草稿字段搬进正式专家表，草稿删除。 */
  function hireRecruitDraft(id, over) {
    var d = recruitDraft(id);
    if (!d) return null;
    var src = Object.assign({}, d, over || {}, { id: "", createdAt: Date.now() });
    delete src.status;
    delete src.brief;
    var e = addExpert(src);
    removeRecruitDraft(d.id);
    return e;
  }

  /* ── 分类（用户自建） ── */

  /* 新建分类；重名（同 name）直接返回已有分类，不重复建。 */
  function addCategory(over) {
    var t = team();
    if (!t) return null;
    var name = str(over && over.name != null ? over.name : over).trim();
    if (!name) return null;
    var had = categoryByName(name);
    if (had) return had;
    var c = normalizeCategory({ name: name, createdAt: Date.now() });
    c.updatedAt = c.createdAt;
    t.categories.push(c);
    save();
    return c;
  }
  function updateCategory(id, patch) {
    var c = category(id);
    if (!c) return null;
    var name = str(patch && patch.name != null ? patch.name : "").trim();
    if (!name) return null;
    var dup = categoryByName(name);
    if (dup && dup.id !== c.id) return c;
    c.name = name;
    touch(c);
    save();
    return c;
  }
  /* 删分类：把该分类下的专家 / 模板归回「未分类」，不连带删人。 */
  function removeCategory(id) {
    var t = team();
    var c = category(id);
    if (!t || !c) return false;
    t.experts.forEach(function (e) {
      if (e.category === c.name) e.category = "";
    });
    t.templates.forEach(function (x) {
      if (x.category === c.name) x.category = "";
    });
    t.categories = t.categories.filter(function (x) {
      return x.id !== c.id;
    });
    save();
    return true;
  }

  /* ── 用户自建模板 ── */

  function addTemplate(over) {
    var t = team();
    if (!t) return null;
    var x = normalizeTemplate(
      Object.assign({}, over, { id: "", createdAt: Date.now() }),
    );
    x.updatedAt = x.createdAt;
    t.templates.push(x);
    save();
    return x;
  }
  function updateTemplate(id, patch) {
    var x = template(id);
    if (!x) return null;
    var next = normalizeTemplate(
      mergeExpertPatch(x, Object.assign({}, patch || {}, { id: x.id })),
    );
    Object.keys(x).forEach(function (k) {
      if (!(k in next)) delete x[k];
    });
    Object.assign(x, next);
    touch(x);
    save();
    return x;
  }
  function removeTemplate(id) {
    var t = team();
    var x = template(id);
    if (!t || !x) return false;
    t.templates = t.templates.filter(function (y) {
      return y.id !== x.id;
    });
    save();
    return true;
  }

  /* ───────────────────────── 运行接线：一次专家发言 = 一次 dsh run ───────────────────────── */

  /* 同一会话同一时刻可有多路在跑（群聊一轮 = 参与者并行作答，各自 runKey）：
     chatId → 该会话当前在跑的 runKey 列表（多路 = 并行的多位专家，含主持人选人 / 聚合 run），
     供「终止」在只拿到 chatId 时反查，一次取消本轮全部在跑的专家。 */
  var activeRuns = {};

  function trackRunStart(chatId, runKey) {
    var k = str(chatId);
    if (!k || !runKey) return;
    if (!Array.isArray(activeRuns[k])) activeRuns[k] = [];
    if (activeRuns[k].indexOf(runKey) < 0) activeRuns[k].push(runKey);
  }
  function trackRunEnd(chatId, runKey) {
    var k = str(chatId);
    if (!Array.isArray(activeRuns[k])) return;
    activeRuns[k] = activeRuns[k].filter(function (x) {
      return x !== runKey;
    });
    if (!activeRuns[k].length) delete activeRuns[k];
  }
  /* 该会话当前在跑的 runKey 列表（副本，调用方不会改到内部状态）。 */
  function activeRunKeys(chatId) {
    var list = activeRuns[str(chatId)];
    return Array.isArray(list) ? list.slice() : [];
  }

  /* 运行键：team:<chatId>:<expertId>
     —— 每个「会话 × 专家」一条独立 runKey：取消句柄 / 可续跑会话 / 配置指纹按专家隔离。
     群聊里 A 专家与 B 专家各自跑一轮（并行），互不抢上下文，也不会把对方的会话续跑过来。 */
  function runKeyOf(chatId, expertId) {
    return "team:" + (str(chatId) || "chat") + ":" + (str(expertId) || "expert");
  }
  /* 反查：把 "team:<chatId>" / "<chatId>" / 完整 runKey 统一解成当前在跑的 runKey
     （给完整且正在跑的键原样返回，否则取该会话第一路在跑的键）。 */
  function resolveRunKey(arg) {
    var key = str(arg);
    if (!key) return "";
    var chatId = "";
    if (key.indexOf("team:") === 0) {
      var rest = key.slice(5);
      var ci = rest.indexOf(":");
      chatId = ci < 0 ? rest : rest.slice(0, ci);
    } else {
      chatId = key;
    }
    var keys = activeRunKeys(chatId);
    if (keys.indexOf(key) >= 0) return key;
    return keys.length ? keys[0] : key;
  }

  /* 本轮绑定画布（团队视图没有 canvasWfId，取用户此刻看到的画布 = 锚点所属画布）。 */
  function boundWf() {
    try {
      if (typeof currentVisibleWf === "function")
        return currentVisibleWf() || (typeof S !== "undefined" && S ? S.wf : null);
    } catch (e) {}
    try {
      return (typeof S !== "undefined" && S && S.wf) || null;
    } catch (e) {
      return null;
    }
  }
  /* 画布工作区：锚点自身声明的 workspace 优先（未知键归一化时保留）；
     否则取该锚点对应画布的工作区 —— dshWorkspaceOfWf 口径：手填 > 项目根 > 画布目录 > 默认目录。
     都取不到时交回空串，由 dshRunOnce 走它自己的默认目录兜底。 */
  function canvasWorkspace(canvasId) {
    var p = canvas(canvasId);
    var manual = p && str(p.workspace).trim();
    if (manual) return manual;
    try {
      if (typeof dshWorkspaceOfWf === "function")
        return str(dshWorkspaceOfWf(null, boundWf())).trim();
    } catch (e) {}
    try {
      return str(S && S.dshWorkspaceFallback).trim();
    } catch (e) {
      return "";
    }
  }
  /* 兼容层：projectWorkspace 是 canvasWorkspace 的旧名。 */
  var projectWorkspace = canvasWorkspace;

  /* 事实库工作区（= 画布文件夹）：锚点手填 > 该画布的工作目录（顶栏「工作目录」wf.workspace）。
     与 canvasWorkspace 的唯一差别是**去掉「画布项目根（开发节点 devPath）」这一档**：
     事实库是这张画布自己的资料，不该跟着 devPath 走进项目源码目录 —— 项目根恰好是应用
     自身（正在开发 MTNode 的那张画布）时，库就被拽进应用文件夹，升级 / 卸载即丢失。
     取不到该画布对象时退回前台画布（仅当它就是这张画布），仍取不到交回空串，
     由 app-factlib.js 的 resolvePaths 弹目录选择让用户为这张画布定一个（选定写回画布工作目录）。 */
  function factWorkspace(canvasId) {
    var p = canvas(canvasId);
    var manual = p && str(p.workspace).trim();
    if (manual) return manual;
    var wf = canvasWfOf(canvasId);
    return wf ? str(wf.workspace).trim() : "";
  }

  /* 该画布对象：按画布 id 取（加载中的画布才取得到）；取不到时退回前台画布，
     且只在 id 对得上（或没给 id）时用，绝不把别的画布当成它。 */
  function canvasWfOf(canvasId) {
    var id = str(canvasId);
    var wf = null;
    try {
      if (id && typeof canvasWfByIdLoaded === "function") wf = canvasWfByIdLoaded(id);
    } catch (e) {}
    if (!wf) {
      var cur = boundWf();
      if (cur && (!id || str(cur.id) === id)) wf = cur;
    }
    return wf || null;
  }

  /* 该画布的「开发节点项目根」（devPath 单一真源，见 app.js devProjectRootOf）。
     事实库**绝不能**落在这里：项目根等于应用源码目录时（正在开发 MTNode 的那张画布），
     库就被拽进应用文件夹。app-factlib.js 的落点守卫与错位体检（relocateLibrary）都用它。 */
  function factDevRoot(canvasId) {
    var wf = canvasWfOf(canvasId);
    if (!wf) return "";
    try {
      if (typeof devProjectRootOf === "function")
        return str(devProjectRootOf(wf)).trim();
    } catch (e) {}
    return "";
  }

  /* 专家四段式人设提示词：身份 + 目标 + 约束 + 输出，外加一行「工具许可」实况。
     这一段经 dshRunTask 的 opts.systemPrompt 落到 persona_host 分节 —— 绝不用 hostPersona
     （dsh/gateway/gateway.mjs:1602 在 hostPersonaText 非空时整段替换系统提示）。 */
  function expertSystemPrompt(exp) {
    var p = (exp && exp.prompt) || {};
    var pe = (exp && exp.persona) || {};
    var lines = [];
    lines.push(
      T("你是「") +
        ((exp && exp.name) || T("专家")) +
        "」" +
        (exp && exp.role ? "（" + exp.role + "）" : "") +
        "。",
    );
    if (p.identity) lines.push(p.identity);
    if (pe.tagline) lines.push(T("简介：") + pe.tagline);
    if (pe.background) lines.push(T("背景：") + pe.background);
    if (pe.expertise && pe.expertise.length)
      lines.push(T("专长：") + pe.expertise.join("、"));
    if (pe.style) lines.push(T("表达风格：") + pe.style);
    if (pe.tone) lines.push(T("语气：") + pe.tone);
    if (pe.language) lines.push(T("回答语言：") + pe.language);
    if (p.goal) lines.push(T("目标：") + p.goal);
    if (p.constraints) lines.push(T("约束：") + p.constraints);
    if (p.output) lines.push(T("输出要求：") + p.output);
    var note = expertCapabilityNote(exp);
    if (note) lines.push(note);
    var fl = factLibNote(exp);
    if (fl) lines.push(fl);
    return lines.join("\n");
  }
  /* 团队事实库索引：列出库内全部文档的「名称 → 绝对路径」与共享 assets 目录，并写清
     查阅 / 建档纪律。只给路径与纪律，绝不把库正文塞进每轮系统提示（省 token）——
     正文由模型按需用文件读取工具去读。
     库还没建（锚点上没有 fact 记录 / 一篇带路径的文档都没有）时整段省略，
     免得模型去找不存在的文件。
     单聊与群聊都经 runExpert → expertRunParams → 本函数，各自独立 run 均生效。 */
  function factLibNote(exp) {
    var f = fact(exp && (exp.canvasId || exp.projectId));
    if (!f) return "";
    var docs = (Array.isArray(f.docs) ? f.docs : []).filter(function (d) {
      return str(d && d.file).trim();
    });
    if (!docs.length) return "";
    var dir = str(f.dir).trim();
    var assetsDir = str(f.assetsDir).trim();
    var lines = [];
    lines.push(
      T("团队事实库（本团队共享的事实来源；正文按需用文件读取工具查阅，不要凭空作答）："),
    );
    docs.forEach(function (d) {
      lines.push("· " + (str(d.name).trim() || T("文档")) + " → " + str(d.file).trim());
    });
    if (dir) lines.push(T("事实库目录（新文档写这里）：") + dir);
    if (assetsDir) lines.push(T("共享图片目录（全部文档共用）：") + assetsDir);
    lines.push(T("查阅与建档纪律："));
    lines.push(
      T("① 回答事实性问题前，先读上面最相关的那一篇文档，以库中记录为准；库中没有的内容不得编造。"),
    );
    lines.push(T("② 库中信息不足时，再查阅项目内容（工作区文件）补充。"));
    lines.push(
      T("③ 仍不足时，明确告知「事实库中没有该信息」，并请用户补充或确认建档 —— 不得凭记忆或推测作答。"),
    );
    lines.push(
      T("④ 对话中发现稳定事实要同步维护事实库：新主题新建独立文档（文档间内容不重叠、各司其职），已有主题就地更新对应文档；正文写进文档，不要塞进提示词。"),
    );
    if (dir)
      lines.push(
        T("事实库目录对你有写权限：新建 / 更新文档直接写入上述路径；若首次写入被沙箱拒绝，按工具提示用 sandbox_permissions + justification 原样重试一次即可（该目录已获授权，不会打扰用户）。"),
      );
    lines.push(T("引用图片时按 md 里的相对路径引用，不要改写成本机绝对路径。"));
    return lines.join("\n");
  }
  /* 本轮事实库写根：库目录 + 共享图片目录 + 库内每篇文档所在目录（绝对路径，去重）。
     文档目录一并授权 = 专家把新文档建档到库的子目录时也算「写库内」，不会因为只授权
     了库根而被判成写根外（写根外一格就退回人工审批，等于写不进去）。
     随 expertRunParams 的 writeRoots 下发 → app-db.js dshRunOnce 按 runKey 装好，
     落在写根内的沙箱升权审批由宿主直接放行 —— 专家维护事实库时不再逐次弹窗。
     单聊与群聊都经 runExpert 调本函数，两条链路都拿到同一份写根。 */
  function factWriteRoots(exp) {
    var f = fact(exp && (exp.canvasId || exp.projectId));
    if (!f) return [];
    var out = [];
    function add(p) {
      var s = str(p).trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    }
    add(f.dir);
    add(f.assetsDir);
    (Array.isArray(f.docs) ? f.docs : []).forEach(function (d) {
      var file = str(d && d.file).trim();
      if (file) add(factDirNameOf(file));
    });
    return out;
  }
  /* 工具许可实况：把 perm.toolAllow 翻成一句可读的话，让模型知道自己能干什么、哪些要问、
     哪些根本调不到（与实际下发的可见工具集一致，避免人设与工具互相打脸）。 */
  function expertCapabilityNote(exp) {
    var ta = (exp && exp.perm && exp.perm.toolAllow) || defaultToolAllow();
    var allow = [];
    var ask = [];
    var denyN = 0;
    TOOL_KEYS.forEach(function (x) {
      var m = ta[x.key] || "allow";
      if (m === "allow") allow.push(T(x.label));
      else if (m === "ask") ask.push(T(x.label));
      else denyN++;
    });
    var parts = [];
    if (allow.length) parts.push(T("可直接调用：") + allow.join("、"));
    if (ask.length) parts.push(T("需用户确认：") + ask.join("、"));
    if (denyN) parts.push(T("其余 ") + denyN + T(" 类工具一律禁止"));
    if (!parts.length) return "";
    return (
      T("你的工具许可 —— ") +
      parts.join("；") +
      "。" +
      T("工具回执里没有的结果不要声称已完成。")
    );
  }

  /* 「画布整档闸」判据（app-db.js 的 opts.noCanvas → MTNODE_NO_CANVAS，整档摘掉
     mtnode_canvas_get / mtnode_canvas_edit / mtnode_app，约省 26K 字符 / 步）：
     v4 起不再一刀切 —— 本专家把画布六类**全部**拒掉时才整档摘掉；只要放行了任意一类
     （默认许可就放行「读画布」），画布三件套照常注册给模型，专家才能查看与核验画布。
     与按运行工具许可（toolPolicy）同源、同口径，两个调用点（expertRunParams /
     app-teamview.js 的兜底运行）共用本函数，避免两处判据漂移。 */
  function expertNoCanvas(exp) {
    var ta = normalizeToolAllow(exp && exp.perm && exp.perm.toolAllow);
    return CANVAS_TOOL_KEYS.every(function (k) {
      return ta[k] === "deny";
    });
  }

  /* 一次专家运行的 dshRunTask 参数：人设走 systemPrompt、模型取专家 model 配置、
     权限走单次运行覆盖（app-db.js:2468）。
     注：exp.model.temperature 只存配置供专家卡展示，此处刻意不下发 —— dsh-llm-deepseek
     的 Config 没有 temperature 字段、温度只在单次 call options 里，宿主没有通道；
     要真实生效需另立 dsh 网关任务。 */
  function expertRunParams(chat, exp, options) {
    options = options || {};
    var m = (exp && exp.model) || {};
    var perm = (exp && exp.perm) || {};
    var ta = normalizeToolAllow(perm.toolAllow);
    var writeRoots = factWriteRoots(exp);
    /* 事实库写根常在会话工作区之外（回退到应用数据目录时必然如此）：默认
       mtnode-unattended 也是「沙箱受限 + 拒绝时询问」，升权审批有人可问；有写根时
       仍抬到 workspace-write（与默认档同沙箱、同审批口径，历史行为的显式写法），
       写根内的升权由宿主自动放行；用户显式选的其它档（read-only / danger-full-access / …）不覆盖。 */
    var preset = str(perm.permissionPreset).trim();
    if (writeRoots.length && (!preset || preset === "mtnode-unattended"))
      preset = "workspace-write";
    return {
      runKey: runKeyOf(chat && chat.id, exp && exp.id),
      workspace: canvasWorkspace(exp && (exp.canvasId || exp.projectId)),
      provider: str(m.provider) || "deepseek-official",
      model: str(m.model) || undefined,
      effort: str(m.effort) || undefined,
      preset: str(m.preset) || undefined,
      permissionPreset: preset || undefined,
      /* 按运行的工具许可：专家自带的 perm.toolAllow 经此进 app-nodes.js 的
         S._runToolPolicy[runKey]（app-db.js dshRunOnce 安装），只在这一轮生效 ——
         读 / 写文件、联网、反问与读画布放行，画布改动 / 应用操作 / 命令逐次询问，
         删除画布 / 插件 / 子代理 / 目标 / 作业 / 识图拒绝，且不污染全局「审批」预设。
         事实库目录的写权限另经 writeRoots 单独授权（见下）。 */
      toolPolicy: ta,
      /* 本轮事实库写根（绝对路径）：app-db.js 按 runKey 装好后，写根内的沙箱升权审批
         由宿主直接放行 —— 专家同步建档不再逐次弹确认；写根外照旧走人工审批。 */
      writeRoots: writeRoots.length ? writeRoots : undefined,
      systemPrompt: expertSystemPrompt(exp),
      /* 画布整档闸按本专家的许可算（见 expertNoCanvas）：默认许可放行了「读画布」，
         故默认不再摘掉画布三件套；显式把画布六类全拒的专家仍整档省下这 26K 字符。
         单聊 / 群聊同口径，群聊里每位专家各跑一轮也各自如此。 */
      noCanvas: options.noCanvas === true || expertNoCanvas(exp),
    };
  }

  /* 执行一位专家的一轮发言（单聊 = 1 位；群聊 = 逐位各调一次，各自 runKey / 模型 / 权限）。
     只负责「跑」，不落库：正文由调用方（团队视图 / 群聊编排）决定怎么呈现与持久化。 */
  async function runExpert(options) {
    options = options || {};
    var chat = options.chat || null;
    var exp = options.expert || null;
    if (!chat || !exp) throw new Error(T("缺少会话或专家"));
    if (typeof dshRunTask !== "function")
      throw new Error(T("（未接通智能引擎，无法回复）"));
    var params = expertRunParams(chat, exp, options);
    var onEvent = typeof options.onEvent === "function" ? options.onEvent : undefined;
    trackRunStart(chat.id, params.runKey);
    try {
      var final = await dshRunTask(str(options.input), Object.assign({}, params, {
        onEvent: onEvent,
      }));
      return {
        text: str(final),
        runKey: params.runKey,
        systemPrompt: params.systemPrompt,
      };
    } finally {
      trackRunEnd(chat.id, params.runKey);
    }
  }

  /* 终止：arg 可以是完整 runKey、"team:<chatId>"、chatId，或省略（= 停掉全部团队运行）。
     群聊里一轮有多位专家并行在跑 → 命中一个会话即取消该会话本轮**全部**在跑的 runKey
     （含主持人选人 / 聚合 run），不再只停在第一位。 */
  function stopExpert(arg) {
    var key = str(arg);
    var targets = [];
    function add(k) {
      if (k && targets.indexOf(k) < 0) targets.push(k);
    }
    if (!key) {
      Object.keys(activeRuns).forEach(function (c) {
        activeRunKeys(c).forEach(add);
      });
    } else {
      var chatId = "";
      if (key.indexOf("team:") === 0) {
        var rest = key.slice(5);
        var ci = rest.indexOf(":");
        chatId = ci < 0 ? rest : rest.slice(0, ci);
      } else {
        chatId = key;
      }
      activeRunKeys(chatId).forEach(add);
      if (!targets.length) add(resolveRunKey(key));
    }
    targets.forEach(function (k) {
      try {
        if (typeof dshCancelActive === "function") dshCancelActive(k);
      } catch (_) {}
    });
  }

  /* ═════════════ 群聊编排：按问题选人 · 参与者并行独立作答 · 主持聚合 · @定向 · 建议落文件 ═════════════
   *
   * 依据 docs/workspace/one-person-company/03-multi-role-orchestration.md 收敛出的 MVP 子集：
   *   M2 圆桌 / 群聊 —— 先由 selectParticipants 按问题挑选本轮参与人（不全员，@ 定向优先），
   *                   再让参与者**并行**各跑一次独立 run（各自 runKey / 模型 / 权限），
   *                   第 1 轮独立发言（互不可见，防锚定），第 2 轮起可见彼此发言；
   *   M3/M7 主持聚合 —— 主持人只做结构化聚合、不新增观点，产出一张「建议卡」；
   *   M4 @提及定向 —— 用户 @某专家时只唤起被 @ 的人，不广播；
   *   产出即文件 —— 建议卡落 <项目工作区>/advice/ADV-*.md；采纳才写 decisions/ 或 TODO.md。
   *
   * 硬边界（B1 人在环上 / B3 轮次上限 / B6 落库只走决策记录）：
   *   · 轮次上限 GROUP_ROUND_LIMIT = 2，超限即收尾；
   *   · 聚合只产出「建议」，采纳必须由用户显式点击；采纳前不写 decisions/、不生成待办。
   */

  var GROUP_ROUND_LIMIT = 2;
  var FACILITATOR_RE = /主持|facilitator|CEO|ceo|总裁|产品经理|product[\s-]*manager|\bPM\b/;

  function isGroupChat(chat) {
    return !!(chat && chat.kind === "group");
  }
  function lastUserText(chat) {
    var msgs = (chat && chat.messages) || [];
    for (var i = msgs.length - 1; i >= 0; i--)
      if (msgs[i] && msgs[i].role === "user") return str(msgs[i].content);
    return "";
  }
  /* 群聊参与者（按 chat.participants 顺序解析成专家对象；缺失回退到项目全部专家）。 */
  function chatParticipants(chat) {
    var ids = arr(chat && chat.participants);
    var list = ids
      .map(function (id) {
        return expert(id);
      })
      .filter(Boolean);
    if (!list.length) {
      var cid = str((chat && (chat.canvasId || chat.projectId)) || "");
      if (cid) list = experts(cid);
    }
    return list;
  }
  /* 主持人：显式 facilitatorId > 岗位/名称含「主持 / CEO / PM / 产品经理」> 首位参与者。
     C2：主持人只调度与聚合，不生产观点。 */
  function facilitatorOf(chat) {
    var parts = chatParticipants(chat);
    if (!parts.length) return null;
    var fid = str(chat && chat.facilitatorId);
    if (fid) {
      var hit = parts.find(function (e) {
        return e.id === fid;
      });
      if (hit) return hit;
    }
    var byRole = parts.find(function (e) {
      return FACILITATOR_RE.test(str(e.role) + " " + str(e.name));
    });
    return byRole || parts[0];
  }
  /* M4 @提及：只认参与者姓名（@财务 这类岗位名由姓名承载）。命中返回专家 id 列表。 */
  function parseMentions(text, chat) {
    var t = str(text);
    if (!t || t.indexOf("@") < 0) return [];
    var hits = [];
    chatParticipants(chat).forEach(function (e) {
      var name = str(e.name).trim();
      if (name && t.indexOf("@" + name) >= 0) hits.push(e.id);
    });
    return hits;
  }

  /* ── M2 选人：本轮谁上桌（绝不全员） ──

     硬约束：本轮参与人 2–6 位；候选 ≥3 位时至少排除 1 位（「不要全部参与」）；
     候选 <3 位时至少 2 位（候选不足 2 位就只能全部上）。 */
  var GROUP_MIN_PARTICIPANTS = 2;
  var GROUP_MAX_PARTICIPANTS = 6;

  /* 本地相关性打分（主持人选人不可用 / 解析失败时的回退，也用于给入选者排序）：
     把专家画像里的词（岗位、专长、分类、简介、人设、目标）与问题文本做
     「整串命中 + 字符二元组重合」打分 —— 命中越多、词越长分越高；
     同分保持候选原始顺序，保证同一问题下结果可复现（不做随机）。 */
  function expertRelevance(exp, text) {
    var q = str(text).replace(/\s+/g, "");
    if (!q || !exp) return 0;
    var terms = [];
    function put(v, w) {
      var s = str(v).trim();
      if (s) terms.push({ t: s.replace(/\s+/g, ""), w: w });
    }
    put(exp.role, 3);
    put(exp.name, 2);
    put(exp.category, 1);
    var pa = (exp && exp.persona) || {};
    var pr = (exp && exp.prompt) || {};
    arr(pa.expertise).forEach(function (x) {
      put(x, 3);
    });
    put(pa.tagline, 1);
    put(pa.background, 1);
    put(pa.style, 1);
    put(pr.identity, 2);
    put(pr.goal, 2);
    put(pr.output, 1);
    var score = 0;
    terms.forEach(function (k) {
      if (!k.t) return;
      if (q.indexOf(k.t) >= 0) {
        score += k.w * (k.t.length >= 2 ? 2 : 1);
        return;
      }
      /* 模糊档只给短词（专长 / 岗位这类名词），长句不参与，避免噪声。 */
      if (k.t.length > 12) return;
      var n = 0;
      for (var i = 0; i + 1 < k.t.length; i++)
        if (q.indexOf(k.t.slice(i, i + 2)) >= 0) n++;
      var ratio = n / Math.max(1, k.t.length - 1);
      if (ratio >= 0.5) score += k.w * ratio;
    });
    return score;
  }
  /* 按相关性降序排名（同分保持候选原始顺序）。 */
  function rankExperts(cands, text) {
    return (cands || [])
      .map(function (e, i) {
        return { e: e, i: i, s: expertRelevance(e, text) };
      })
      .sort(function (a, b) {
        return b.s - a.s || a.i - b.i;
      })
      .map(function (x) {
        return x.e;
      });
  }
  /* 相关性 → { 专家 id: 名次 }（名次越小越相关），用于给入选者排序与裁剪。 */
  function rankIndex(cands, text) {
    var idx = {};
    rankExperts(cands, text).forEach(function (e, i) {
      idx[e.id] = i;
    });
    return idx;
  }
  /* 把「入选 id 列表」夹到规则内：去重、只留候选、上限 6 且候选 ≥3 时必须排除至少 1 位；
     不足下限时按相关性补齐；超出上限时丢掉相关性最低者；输出顺序 = 候选原始顺序。 */
  function clampParticipants(cands, ids, text) {
    var total = (cands || []).length;
    if (!total) return [];
    var maxN = Math.min(GROUP_MAX_PARTICIPANTS, total);
    if (total >= 3) maxN = Math.min(maxN, total - 1);
    var minN = Math.min(GROUP_MIN_PARTICIPANTS, total);
    var idx = rankIndex(cands, text);
    var want = [];
    (ids || []).forEach(function (id) {
      var k = str(id);
      if (!k || want.indexOf(k) >= 0) return;
      if (!cands.some(function (e) {
        return e.id === k;
      }))
        return;
      want.push(k);
    });
    /* 超出上限：丢掉相关性最低的入选者（同相关性按入选顺序靠后优先丢）。 */
    if (want.length > maxN) {
      want = want
        .map(function (id, i) {
          return { id: id, i: i };
        })
        .sort(function (a, b) {
          var ra = idx[a.id] === undefined ? 1e9 : idx[a.id];
          var rb = idx[b.id] === undefined ? 1e9 : idx[b.id];
          return ra - rb || a.i - b.i;
        })
        .slice(0, maxN)
        .map(function (x) {
          return x.id;
        });
    }
    /* 不足下限：按相关性补齐（补进来的不再排序，稍后统一按候选顺序输出）。 */
    if (want.length < minN) {
      rankExperts(cands, text).forEach(function (e) {
        if (want.length >= minN) return;
        if (want.indexOf(e.id) < 0) want.push(e.id);
      });
    }
    return cands.filter(function (e) {
      return want.indexOf(e.id) >= 0;
    });
  }
  /* 选人决策的标准回执：专家对象数组 + id / 姓名 + 理由 + 来源。 */
  function packSelection(picked, reason, mode) {
    var list = (Array.isArray(picked) ? picked : []).filter(Boolean);
    return {
      participants: list,
      ids: list.map(function (e) {
        return e.id;
      }),
      names: list.map(function (e) {
        return str(e.name);
      }),
      reason: str(reason),
      mode: pick(LAST_ROUND_MODES, mode, "local"),
    };
  }
  /* 从模型输出里抠选人 JSON：优先 ```json 围栏，其次首个 { 到末个 }；都失败返回 null。 */
  function parseSelectionJson(text) {
    var t = str(text);
    var raw = "";
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1];
    else {
      var i = t.indexOf("{");
      var j = t.lastIndexOf("}");
      if (i >= 0 && j > i) raw = t.slice(i, j + 1);
    }
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : null;
    } catch (e) {
      return null;
    }
  }
  /* 主持人轻量选人 run 的输入：只给候选专家画像与问题，只让它挑人 + 给一句理由。 */
  function selectPrompt(chat, cands, text) {
    var lines = [];
    var p = canvas(chat && (chat.canvasId || chat.projectId));
    lines.push(T("【画布】") + ((p && p.name) || T("未命名画布")));
    lines.push(T("【用户问题】") + str(text));
    lines.push(T("【可选专家】"));
    (cands || []).forEach(function (e) {
      var bits = [];
      if (str(e.role)) bits.push(str(e.role));
      var pe = arr(e.persona && e.persona.expertise);
      if (pe.length) bits.push(T("专长：") + pe.join("、"));
      if (str(e.persona && e.persona.tagline)) bits.push(str(e.persona.tagline));
      lines.push("- " + str(e.name) + (bits.length ? "（" + bits.join("；") + "）" : ""));
    });
    lines.push(
      T("【你的任务】你是主持人，只决定本轮谁上桌发言：按与问题的相关性挑 2–6 位，**不要全员参与**。"),
    );
    lines.push(T("不要自己作答，不要新增观点，也不要解释过程。"));
    lines.push(
      T("只输出一个 ```json 围栏，字段：participants（专家姓名数组，姓名必须与上面逐字一致，2–6 位，且不得等于全员）, reason（一句话选人理由）。"),
    );
    return lines.join("\n");
  }
  /* 请主持人跑一次轻量选人 run。返回 { ids, reason }；模型不可用 / 输出不可解析 / 一位都没命中 → null。 */
  async function hostSelect(chat, cands, text) {
    var fac = facilitatorOf(chat);
    if (!fac) return null;
    var ids = [];
    var reason = "";
    try {
      var r = await runExpert({
        chat: chat,
        expert: fac,
        input: selectPrompt(chat, cands, text),
      });
      var obj = parseSelectionJson(r && r.text);
      if (!obj) return null;
      (Array.isArray(obj.participants) ? obj.participants : []).forEach(function (n) {
        var name = str(n).trim();
        if (!name) return;
        var hit = cands.filter(function (e) {
          return str(e.name).trim() === name;
        })[0];
        if (!hit)
          hit = cands.filter(function (e) {
            var en = str(e.name).trim();
            return !!en && name.indexOf(en) >= 0;
          })[0];
        if (hit && ids.indexOf(hit.id) < 0) ids.push(hit.id);
      });
      reason = str(obj.reason).trim();
    } catch (e) {
      return null;
    }
    if (!ids.length) return null;
    return { ids: ids, reason: reason };
  }
  /* 本轮参与人决策（群聊编排唯一入口）：
     ① 用户 @ 了专家 → 跳过选人，只由被 @ 者参与（@ 定向优先，不受 2–6 人数约束）；
     ② 候选不足 3 位 → 没有可裁的余地，全部参与；
     ③ 否则请主持人跑一次轻量选人 run；解析失败 / 模型不可用 → 本地相关性打分回退。
     返回 { participants, ids, names, reason, mode }（mode = mention | host | local）。 */
  async function selectParticipants(chat, text) {
    var cands = chatParticipants(chat);
    var q = str(text) || lastUserText(chat);
    var mentioned = parseMentions(q, chat);
    if (mentioned.length) {
      return packSelection(
        cands.filter(function (e) {
          return mentioned.indexOf(e.id) >= 0;
        }),
        T("用户 @ 指定：只由被 @ 的专家参与本轮。"),
        "mention",
      );
    }
    if (!cands.length) return packSelection([], "", "local");
    if (cands.length <= GROUP_MIN_PARTICIPANTS)
      return packSelection(cands.slice(), T("候选不足 3 位：本轮全部参与。"), "local");
    var host = await hostSelect(chat, cands, q);
    var ids = [];
    var reason = "";
    var mode = "local";
    if (host) {
      ids = host.ids;
      reason = host.reason || T("主持人按问题相关性选定本轮参与人。");
      mode = "host";
    } else {
      ids = rankExperts(cands, q).map(function (e) {
        return e.id;
      });
      reason = T("按专家画像与问题的相关性选出本轮参与人（主持人选人不可用时的本地回退）。");
    }
    return packSelection(clampParticipants(cands, ids, q), reason, mode);
  }

  /* 新建群聊：参与者默认取该画布锚点全部专家（超过 6 位只留前 6，硬约束「常驻 3–6」），
     主持人按 facilitatorOf 规则确定。 */
  function addGroupChat(over) {
    over = over || {};
    var canvasId = str(over.canvasId) || str(over.projectId);
    var parts = arr(over.participants);
    if (!parts.length && canvasId)
      parts = experts(canvasId).slice(0, 6).map(function (e) {
        return e.id;
      });
    var chat = addChat({
      kind: "group",
      canvasId: canvasId,
      participants: parts,
      facilitatorId: str(over.facilitatorId),
      title: str(over.title) || T("圆桌讨论"),
    });
    if (chat && !chat.facilitatorId) {
      var fac = facilitatorOf(chat);
      if (fac) updateChat(chat.id, { facilitatorId: fac.id });
    }
    return chat;
  }

  /* 一位专家本轮看到的输入：第 1 轮只有问题（互不可见），第 2 轮起附上已有发言。 */
  function groupRoundInput(chat, exp, round) {
    var lines = [];
    var p = canvas(chat && (chat.canvasId || chat.projectId));
    lines.push(T("【画布】") + ((p && p.name) || T("未命名画布")));
    lines.push(T("【用户问题】") + lastUserText(chat));
    if (Number(round) >= 2) {
      var prior = ((chat && chat.messages) || []).filter(function (m) {
        return m && m.role === "assistant" && m.expertId && m.content;
      });
      if (prior.length) {
        lines.push(T("【已有发言（供你参考并回应，不要重复别人已说的）】"));
        prior.forEach(function (m) {
          lines.push(
            "- " +
              (m.name || T("专家")) +
              "：" +
              String(m.content).replace(/\s+/g, " ").slice(0, 1200),
          );
        });
      }
    } else {
      lines.push(
        T("这是第 1 轮独立发言：请独立判断，不要假设别人会说什么，也不要替别人发言。"),
      );
    }
    lines.push(
      T("【你的任务】以「") +
        (exp.name || T("专家")) +
        T("」的身份，只就你专业那一摊给出意见，按以下小节输出："),
    );
    lines.push(
      T("立场（支持 / 反对 / 中立 / 有条件的支持）、结论（一句话）、依据（逐条可核验）、风险、代价、置信度（高 / 中 / 低）、待验证假设。"),
    );
    lines.push(T("没有依据的数字不要编造；查不到就写「数据库中没有该信息」。"));
    return lines.join("\n");
  }

  /* 圆桌一轮（M2）：先由 selectParticipants 决定本轮参与人（不全员，@ 定向优先），
     再让参与者**并行**各跑一次独立 run（各自 runKey / 模型 / 权限 / 工具许可）。
     单个专家失败只写进他自己的那条消息（msg.error），不拖垮整轮；
     结果按参与人原始顺序回收并回调 onMessage（消息带头像与角色名署名），
     调用方负责追加到同一条消息流。本轮参与人与选人理由落 chat.lastParticipants。
     options = { chat, text, round?, onEvent?(type,data,exp), onMessage?(msg,exp), shouldStop?() } */
  async function runGroupRound(options) {
    options = options || {};
    var chat = options.chat;
    if (!chat) throw new Error(T("缺少会话"));
    if (!chatParticipants(chat).length) throw new Error(T("没有可发言的专家"));
    var round = Math.max(
      1,
      Math.floor(Number(options.round) || Number(chat.round || 0) + 1),
    );
    var sel = await selectParticipants(chat, options.text);
    var targets = sel.participants;
    if (!targets.length) {
      if (parseMentions(options.text, chat).length)
        throw new Error(T("没有匹配到被 @ 的专家"));
      throw new Error(T("没有可发言的专家"));
    }
    var onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
    var onMessage = typeof options.onMessage === "function" ? options.onMessage : null;
    /* 本轮参与人与选人理由落库（团队视图回显 + 聚合输入都读它）。 */
    updateChat(chat.id, {
      lastParticipants: {
        ids: sel.ids,
        names: sel.names,
        reason: sel.reason,
        mode: sel.mode,
        round: round,
        at: Date.now(),
      },
    });
    var results = new Array(targets.length);
    async function runOne(exp, i) {
      if (options.shouldStop && options.shouldStop()) return;
      var r = null;
      var errText = "";
      try {
        r = await runExpert({
          chat: chat,
          expert: exp,
          input: groupRoundInput(chat, exp, round),
          onEvent: onEvent
            ? function (type, data) {
                onEvent(type, data, exp);
              }
            : undefined,
        });
      } catch (err) {
        errText = (err && err.message) || String(err || "");
      }
      var msg = {
        role: "assistant",
        content: r ? str(r.text) : "",
        expertId: exp.id,
        name: exp.name || "",
        icon: exp.icon || "",
        glyph: exp.glyph || "",
        color: exp.color || "",
      };
      if (errText) msg.error = errText;
      results[i] = msg;
      if (onMessage) onMessage(msg, exp);
    }
    /* 并行作答：全部参与者同时起跑，互不等待；单条失败已在 runOne 内消化。 */
    await Promise.all(
      targets.map(function (exp, i) {
        return runOne(exp, i);
      }),
    );
    var out = results.filter(function (m) {
      return !!m;
    });
    return {
      round: round,
      messages: out,
      participants: sel.ids,
      selection: sel,
    };
  }

  /* ── 聚合输入的小工具：本轮参与人 / 本轮发言 / 历史发言 ── */
  /* 本轮参与人对象（chat.lastParticipants.ids → Expert）；记不到时按本轮发言的署名专家推。 */
  function roundParticipantsFrom(lp, cur) {
    var ids = lp && Array.isArray(lp.ids) ? lp.ids : [];
    var out = ids
      .map(function (id) {
        return expert(id);
      })
      .filter(Boolean);
    if (out.length) return out;
    var seen = [];
    (cur || []).forEach(function (m) {
      var e = expert(m && m.expertId);
      if (e && seen.indexOf(e.id) < 0) seen.push(e.id);
    });
    return seen
      .map(function (id) {
        return expert(id);
      })
      .filter(Boolean);
  }
  /* 本轮发言 = 最后一条用户消息之后的署名发言（并行作答，顺序 = 参与人顺序）。 */
  function roundSpeeches(chat) {
    var msgs = (chat && chat.messages) || [];
    var out = [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (!m) continue;
      if (m.role === "user") break;
      if (m.role === "assistant" && m.expertId && m.content) out.unshift(m);
    }
    return out;
  }
  /* 本轮之前的署名发言（历史轮次），按时间正序，只留最近 12 条（省 token）。 */
  function historySpeeches(chat, cur) {
    var msgs = (chat && chat.messages) || [];
    var skip = cur || roundSpeeches(chat);
    var out = [];
    msgs.forEach(function (m) {
      if (!m || m.role !== "assistant" || !m.expertId || !m.content) return;
      if (skip.indexOf(m) >= 0) return;
      out.push(m);
    });
    return out.slice(-12);
  }
  function speechLines(msgs) {
    return (msgs || []).map(function (m) {
      return (
        "- " +
        (m.name || T("专家")) +
        "：" +
        String(m.content).replace(/\s+/g, " ").slice(0, 1600)
      );
    });
  }

  /* 主持聚合输入：主持人只做结构化，不新增观点（C2）。
     输入按「本轮参与人 + 发言」拼装：先列本轮上桌的专家（selectParticipants 的结果），
     再列本轮发言（最后一条用户消息之后的署名消息），历史轮次发言另起一段供参照。 */
  function aggregateInput(chat) {
    var lines = [];
    var p = canvas(chat && (chat.canvasId || chat.projectId));
    lines.push(T("【画布】") + ((p && p.name) || T("未命名画布")));
    lines.push(T("【用户问题】") + lastUserText(chat));
    /* 本轮参与人 = selectParticipants 的决策结果（chat.lastParticipants），
       会话里没记（旧数据 / 单聊）时退回按本轮发言推。 */
    var lp = lastRoundOf(chat);
    var cur = roundSpeeches(chat);
    var parts = roundParticipantsFrom(lp, cur);
    if (parts.length)
      lines.push(
        T("【本轮参与人】") +
          parts
            .map(function (e) {
              return e.name || T("专家");
            })
            .join("、"),
      );
    if (cur.length) {
      lines.push(T("【本轮发言（只汇总这些，未参与者本轮没有发言，不得替他们编观点）】"));
      speechLines(cur).forEach(function (x) {
        lines.push(x);
      });
    }
    var hist = historySpeeches(chat, cur);
    if (hist.length) {
      lines.push(T("【历史发言（前几轮，供参照，不重复计入本轮结论）】"));
      speechLines(hist).forEach(function (x) {
        lines.push(x);
      });
    }
    if (!cur.length && !hist.length) lines.push(T("（暂无发言）"));
    lines.push(
      T("【你的任务】你是主持人，只做聚合与结构化，不新增任何观点。请输出一张「建议卡」，"),
    );
    lines.push(
      T("并且**只输出一个 ```json 围栏**，字段：title, question, conclusion, rationale, evidence（数组）, dissent（数组，每项 {role, point, reason}，被否决的反对意见原文保留）, unresolved（数组）, assumptions（数组）, nextActions（数组，每项 {action, owner, due}）, confidence（高 / 中 / 低）。"),
    );
    lines.push(
      T("事实冲突以可核验来源为准；假设冲突不选边，改为「若 X 则 A，若 Y 则 B」；风险结论优先于收益结论；红线结论不可被推翻。"),
    );
    return lines.join("\n");
  }

  /* 从模型输出里抠出建议卡：优先 ```json 围栏，其次首个 { 到末个 }；都失败则整段当结论。 */
  function parseAdviceCard(text) {
    var t = str(text);
    var raw = "";
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1];
    else {
      var i = t.indexOf("{");
      var j = t.lastIndexOf("}");
      if (i >= 0 && j > i) raw = t.slice(i, j + 1);
    }
    var obj = null;
    if (raw) {
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        obj = null;
      }
    }
    if (!obj || typeof obj !== "object") {
      var firstLine = t.split("\n")[0] || "";
      obj = {
        title: firstLine.slice(0, 60),
        conclusion: t,
      };
    }
    return normalizeAdviceCard(obj);
  }

  /* 主持人聚合一轮：跑一次主持人的独立 run → 解析建议卡。不写文件、不落库。 */
  async function aggregateGroup(options) {
    options = options || {};
    var chat = options.chat;
    if (!chat) throw new Error(T("缺少会话"));
    var fac = facilitatorOf(chat);
    if (!fac) throw new Error(T("没有可用的主持专家"));
    var r = await runExpert({
      chat: chat,
      expert: fac,
      input: aggregateInput(chat),
      onEvent: options.onEvent,
    });
    var card = parseAdviceCard(r && r.text);
    if (!card.question) card.question = lastUserText(chat);
    return { card: card, text: str(r && r.text), facilitator: fac };
  }

  /* ── 落盘：建议文件 / 决策记录 / 待办 ── */

  function pad2(n) {
    return (Number(n) < 10 ? "0" : "") + Number(n);
  }
  function ymd(d) {
    d = d || new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }
  function joinSafe(a, b, c) {
    var parts = [str(a), str(b), str(c)].filter(function (x) {
      return x !== "";
    });
    try {
      if (typeof joinPath === "function") return joinPath.apply(null, parts);
    } catch (e) {}
    try {
      if (window.api && typeof window.api.pathJoin === "function")
        return window.api.pathJoin.apply(null, parts);
    } catch (e) {}
    return parts
      .join("/")
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/");
  }
  /* 建议 / 决策目录：<画布工作区>/advice 或 /decisions；工作区取不到返回空串。 */
  function adviceDir(chat, kind) {
    var ws = canvasWorkspace(chat && (chat.canvasId || chat.projectId));
    if (!ws) return "";
    return joinSafe(ws, kind === "decisions" ? "decisions" : "advice");
  }

  /* 建议卡 / 决策记录 Markdown（YAML 头 + 正文），对齐 §4.2 Schema。 */
  function adviceMarkdown(chat, card, opts) {
    opts = opts || {};
    var c = normalizeAdviceCard(card);
    var fac = facilitatorOf(chat);
    var parts = ((chat && chat.messages) || [])
      .filter(function (m) {
        return m && m.role === "assistant" && m.expertId;
      })
      .map(function (m) {
        return m.name || m.expertId;
      });
    var uniq = [];
    parts.forEach(function (x) {
      if (uniq.indexOf(x) < 0) uniq.push(x);
    });
    var lines = [];
    lines.push("---");
    lines.push("id: " + str(opts.id || ""));
    lines.push("title: " + c.title);
    lines.push("status: " + str(opts.status || "待确认"));
    lines.push("date: " + new Date().toISOString().slice(0, 10));
    lines.push("owner: 用户");
    lines.push("facilitator: " + ((fac && fac.name) || ""));
    lines.push("participants: [" + uniq.join(", ") + "]");
    lines.push("question: " + c.question);
    lines.push("confidence: " + c.confidence);
    lines.push("---");
    lines.push("");
    lines.push("# " + (c.title || c.conclusion.slice(0, 40)));
    lines.push("");
    lines.push("## 结论");
    lines.push(c.conclusion || "（无）");
    if (c.rationale) {
      lines.push("");
      lines.push("## 理由");
      lines.push(c.rationale);
    }
    if (c.evidence.length) {
      lines.push("");
      lines.push("## 依据");
      c.evidence.forEach(function (x) {
        lines.push("- " + x);
      });
    }
    if (c.dissent.length) {
      lines.push("");
      lines.push("## 少数意见（原文保留）");
      c.dissent.forEach(function (d) {
        lines.push(
          "- **" +
            (d.role || "") +
            "**：" +
            d.point +
            (d.reason ? "（未采纳原因：" + d.reason + "）" : ""),
        );
      });
    }
    if (c.unresolved.length) {
      lines.push("");
      lines.push("## 未收敛分歧");
      c.unresolved.forEach(function (x) {
        lines.push("- " + x);
      });
    }
    if (c.assumptions.length) {
      lines.push("");
      lines.push("## 待验证假设");
      c.assumptions.forEach(function (x) {
        lines.push("- " + x);
      });
    }
    if (c.nextActions.length) {
      lines.push("");
      lines.push("## 下一步");
      c.nextActions.forEach(function (a) {
        lines.push(
          "- " +
            a.action +
            (a.owner ? "（" + a.owner + "）" : "") +
            (a.due ? " 截止 " + a.due : ""),
        );
      });
    }
    lines.push("");
    return lines.join("\n");
  }

  /* 写入建议文件（产出即文件）：<项目工作区>/advice/ADV-YYYYMMDD-NN.md，重名自动加序号。
     这是「讨论产物」本身，不属于采纳动作；采纳动作见 adoptAdvice。 */
  async function writeAdviceFile(chat, card) {
    if (!window.api || typeof window.api.fileWriteText !== "function")
      throw new Error(T("（未接通文件写入，无法落盘建议）"));
    var dir = adviceDir(chat, "advice");
    if (!dir) throw new Error(T("画布没有可用工作区，无法写入建议文件"));
    var base = "ADV-" + ymd();
    var path = "";
    var id = "";
    for (var n = 1; n <= 99; n++) {
      id = base + "-" + pad2(n);
      path = joinSafe(dir, id + ".md");
      var exists = false;
      try {
        exists = await window.api.fileExists(path);
      } catch (e) {
        exists = false;
      }
      if (!exists) break;
    }
    await window.api.fileWriteText(path, adviceMarkdown(chat, card, { id: id }));
    return path;
  }

  /* 一键采纳（用户显式动作，采纳前无副作用）：
       mode="todo"     → 追加到 <工作区>/advice/TODO.md（待办清单）
       mode="decision" → 写 <工作区>/decisions/DEC-YYYYMMDD-NN.md（状态=已确认） */
  async function adoptAdvice(chat, card, mode) {
    if (!window.api || typeof window.api.fileWriteText !== "function")
      throw new Error(T("（未接通文件写入，无法采纳）"));
    var ws = canvasWorkspace(chat && (chat.canvasId || chat.projectId));
    if (!ws) throw new Error(T("画布没有可用工作区，无法采纳"));
    var c = normalizeAdviceCard(card);
    if (mode === "todo") {
      var p = joinSafe(ws, "advice", "TODO.md");
      var prev = "";
      try {
        var rr = await window.api.fileReadText(p);
        prev = rr && rr.exists ? str(rr.content) : "";
      } catch (e) {
        prev = "";
      }
      if (!prev) prev = "# 待办\n";
      var add = [];
      add.push("");
      add.push("## " + (c.title || c.conclusion.slice(0, 40)));
      if (c.nextActions.length) {
        c.nextActions.forEach(function (a) {
          add.push(
            "- [ ] " +
              a.action +
              (a.owner ? "（" + a.owner + "）" : "") +
              (a.due ? " 截止 " + a.due : ""),
          );
        });
      } else {
        add.push("- [ ] " + (c.conclusion || c.title));
      }
      await window.api.fileWriteText(
        p,
        prev.replace(/\s*$/, "") + "\n" + add.join("\n") + "\n",
      );
      return p;
    }
    var dir = joinSafe(ws, "decisions");
    var base = "DEC-" + ymd();
    var path = "";
    var id = "";
    for (var n = 1; n <= 99; n++) {
      id = base + "-" + pad2(n);
      path = joinSafe(dir, id + ".md");
      var exists = false;
      try {
        exists = await window.api.fileExists(path);
      } catch (e) {
        exists = false;
      }
      if (!exists) break;
    }
    await window.api.fileWriteText(
      path,
      adviceMarkdown(chat, c, { id: id, status: "已确认" }),
    );
    return path;
  }

  /* ───────────────────────── 导出 ───────────────────────── */

  var API = {
    VERSION: VERSION,
    TOOL_KEYS: TOOL_KEYS,
    GLYPHS: GLYPHS,
    COLORS: COLORS,
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    DEFAULT_TOOL_ALLOW: DEFAULT_TOOL_ALLOW,

    toolKeys: toolKeys,
    defaultToolAllow: defaultToolAllow,    normalizeToolMode: normalizeToolMode,
    normalizeToolAllow: normalizeToolAllow,
    normalizeTemperature: normalizeTemperature,
    toolCatalog: toolCatalog,
    glyphFor: glyphFor,
    normalizeIcon: normalizeIcon,
    iconFor: iconFor,
    iconFromGlyph: iconFromGlyph,
    colorFor: colorFor,
    newId: newId,

    normalizeExpert: normalizeExpert,
    normalizeCanvas: normalizeCanvas,
    normalizeProject: normalizeProject,
    normalizeChat: normalizeChat,
    normalizeRecruitDraft: normalizeRecruitDraft,
    normalizeCategory: normalizeCategory,
    normalizeTemplate: normalizeTemplate,
    normalizeFact: normalizeFact,
    normalizeFactDoc: normalizeFactDoc,
    normalizeConfig: normalizeConfig,
    mergeExpertPatch: mergeExpertPatch,
    ensure: ensure,
    team: team,
    save: save,

    /* 画布锚点（projects / project 为旧名兼容） */
    canvases: canvases,
    canvas: canvas,
    projects: projects,
    project: project,
    currentCanvasId: currentCanvasId,
    currentCanvasName: currentCanvasName,
    canvasId: currentCanvasId,
    canvasName: currentCanvasName,
    ensureCanvas: ensureCanvas,
    pruneCanvases: pruneCanvases,
    canvasChats: canvasChats,
    experts: experts,
    expert: expert,
    chats: chats,
    chat: chat,
    recruitDrafts: recruitDrafts,
    recruitDraft: recruitDraft,
    categories: categories,
    category: category,
    categoryByName: categoryByName,
    templates: templates,
    template: template,
    expertLabel: expertLabel,

    /* 事实库（嵌套在画布锚点上，见 normalizeFact）：一份库 + 库内多篇文档 */
    fact: fact,
    ensureFact: ensureFact,
    updateFact: updateFact,
    removeFact: removeFact,
    factDocs: factDocs,
    factDoc: factDoc,
    ensureFactDoc: ensureFactDoc,
    updateFactDoc: updateFactDoc,
    removeFactDoc: removeFactDoc,

    addCanvas: addCanvas,
    updateCanvas: updateCanvas,
    removeCanvas: removeCanvas,
    copyCanvas: copyCanvas,
    addProject: addProject,
    updateProject: updateProject,
    removeProject: removeProject,
    addExpert: addExpert,
    updateExpert: updateExpert,
    removeExpert: removeExpert,
    addChat: addChat,
    updateChat: updateChat,
    removeChat: removeChat,
    addRecruitDraft: addRecruitDraft,
    updateRecruitDraft: updateRecruitDraft,
    removeRecruitDraft: removeRecruitDraft,
    hireRecruitDraft: hireRecruitDraft,

    /* 分类与用户模板 */
    addCategory: addCategory,
    updateCategory: updateCategory,
    removeCategory: removeCategory,
    addTemplate: addTemplate,
    updateTemplate: updateTemplate,
    removeTemplate: removeTemplate,

    /* 运行接线 */
    runKeyOf: runKeyOf,
    resolveRunKey: resolveRunKey,
    activeRunKeys: activeRunKeys,
    canvasWorkspace: canvasWorkspace,
    projectWorkspace: projectWorkspace,
    factWorkspace: factWorkspace,
    factDevRoot: factDevRoot,
    expertSystemPrompt: expertSystemPrompt,
    expertCapabilityNote: expertCapabilityNote,
    factLibNote: factLibNote,
    factWriteRoots: factWriteRoots,
    expertNoCanvas: expertNoCanvas,
    expertRunParams: expertRunParams,
    runExpert: runExpert,
    stopExpert: stopExpert,

    /* 群聊编排 */
    GROUP_ROUND_LIMIT: GROUP_ROUND_LIMIT,
    isGroupChat: isGroupChat,
    lastUserText: lastUserText,
    chatParticipants: chatParticipants,
    facilitatorOf: facilitatorOf,
    parseMentions: parseMentions,
    addGroupChat: addGroupChat,
    /* 本轮参与人决策（不全员）与上一轮参与人回执 */
    GROUP_MIN_PARTICIPANTS: GROUP_MIN_PARTICIPANTS,
    GROUP_MAX_PARTICIPANTS: GROUP_MAX_PARTICIPANTS,
    selectParticipants: selectParticipants,
    clampParticipants: clampParticipants,
    rankExperts: rankExperts,
    lastRoundOf: lastRoundOf,
    lastRoundIds: lastRoundIds,
    roundSpeeches: roundSpeeches,
    roundParticipantsFrom: roundParticipantsFrom,
    groupRoundInput: groupRoundInput,
    runGroupRound: runGroupRound,
    aggregateInput: aggregateInput,
    parseAdviceCard: parseAdviceCard,
    aggregateGroup: aggregateGroup,
    normalizeAdviceCard: normalizeAdviceCard,
    adviceDir: adviceDir,
    adviceMarkdown: adviceMarkdown,
    writeAdviceFile: writeAdviceFile,
    adoptAdvice: adoptAdvice,
  };

  window.MTNodeTeam = API;

  /* 独立执行引擎入口：团队视图（app-teamview.js）检测到它就自动让位 ——
     单聊与后续群聊都走这一条链路，runKey / 人设 / 模型 / 权限只在这里定一次。 */
  window.MTNodeTeamChat = {
    run: runExpert,
    stop: stopExpert,
    runKeyOf: runKeyOf,
    systemPromptOf: expertSystemPrompt,
    paramsOf: expertRunParams,
    workspaceOf: projectWorkspace,
    /* 群聊：一轮 = 先选人（不全员）再并行独立 run；聚合 = 主持人独立 run。 */
    runGroupRound: runGroupRound,
    selectParticipants: selectParticipants,
    activeRunKeys: activeRunKeys,
    aggregate: aggregateGroup,
    parseAdviceCard: parseAdviceCard,
    writeAdviceFile: writeAdviceFile,
    adoptAdvice: adoptAdvice,
  };

  /* 全局别名：同层脚本可直接 teamExpert(id) / teamAddExpert({...})。 */
  window.teamToolKeys = toolKeys;
  window.teamDefaultToolAllow = defaultToolAllow;
  window.teamExpertNoCanvas = expertNoCanvas;
  window.teamNormalizeToolAllow = normalizeToolAllow;
  window.teamGlyphFor = glyphFor;
  window.teamColorFor = colorFor;
  window.teamEnsureConfig = ensure;
  window.teamConfig = team;
  window.teamSave = save;
  window.teamCanvases = canvases;
  window.teamCanvas = canvas;
  window.teamCurrentCanvasId = currentCanvasId;
  window.teamCurrentCanvasName = currentCanvasName;
  window.teamCanvasId = currentCanvasId;
  window.teamCanvasName = currentCanvasName;
  window.teamEnsureCanvas = ensureCanvas;
  window.teamPruneCanvases = pruneCanvases;
  window.teamCanvasChats = canvasChats;
  window.teamProjects = projects;
  window.teamProject = project;
  window.teamExperts = experts;
  window.teamExpert = expert;
  window.teamChats = chats;
  window.teamChat = chat;
  window.teamRecruitDrafts = recruitDrafts;
  window.teamRecruitDraft = recruitDraft;
  window.teamCategories = categories;
  window.teamCategory = category;
  window.teamCategoryByName = categoryByName;
  window.teamTemplates = templates;
  window.teamTemplate = template;
  window.teamAddCategory = addCategory;
  window.teamUpdateCategory = updateCategory;
  window.teamRemoveCategory = removeCategory;
  window.teamAddTemplate = addTemplate;
  window.teamUpdateTemplate = updateTemplate;
  window.teamRemoveTemplate = removeTemplate;
  window.teamExpertLabel = expertLabel;
  window.teamFact = fact;
  window.teamEnsureFact = ensureFact;
  window.teamUpdateFact = updateFact;
  window.teamRemoveFact = removeFact;
  window.teamAddCanvas = addCanvas;
  window.teamUpdateCanvas = updateCanvas;
  window.teamRemoveCanvas = removeCanvas;
  window.teamCopyCanvas = copyCanvas;
  window.teamAddProject = addProject;
  window.teamUpdateProject = updateProject;
  window.teamRemoveProject = removeProject;
  window.teamAddExpert = addExpert;
  window.teamUpdateExpert = updateExpert;
  window.teamRemoveExpert = removeExpert;
  window.teamAddChat = addChat;
  window.teamUpdateChat = updateChat;
  window.teamRemoveChat = removeChat;
  window.teamAddRecruitDraft = addRecruitDraft;
  window.teamUpdateRecruitDraft = updateRecruitDraft;
  window.teamRemoveRecruitDraft = removeRecruitDraft;
  window.teamHireRecruitDraft = hireRecruitDraft;
  window.teamRunKeyOf = runKeyOf;
  window.teamResolveRunKey = resolveRunKey;
  /* 事实库解析走**画布文件夹**口径（factWorkspace，不含开发节点项目根）；
     app-factlib.js 的 resolvePaths 只认这个入口。canvasWorkspace 仍供专家轮次 /
     建议目录用（那两处要能落到项目根，便于读写代码）。 */
  window.teamCanvasWorkspace = factWorkspace;
  window.teamFactWorkspace = factWorkspace;
  /* 该画布的开发节点项目根：事实库落点守卫与错位体检用（app-factlib.js）。 */
  window.teamFactDevRoot = factDevRoot;
  window.teamProjectWorkspace = projectWorkspace;
  window.teamExpertSystemPrompt = expertSystemPrompt;
  window.teamExpertCapabilityNote = expertCapabilityNote;
  window.teamFactLibNote = factLibNote;
  window.teamFactWriteRoots = factWriteRoots;
  window.teamExpertRunParams = expertRunParams;
  window.teamRunExpert = runExpert;
  window.teamStopExpert = stopExpert;
  window.teamIsGroupChat = isGroupChat;
  window.teamLastUserText = lastUserText;
  window.teamChatParticipants = chatParticipants;
  window.teamFacilitatorOf = facilitatorOf;
  window.teamParseMentions = parseMentions;
  window.teamSelectParticipants = selectParticipants;
  window.teamClampParticipants = clampParticipants;
  window.teamRankExperts = rankExperts;
  window.teamLastRoundOf = lastRoundOf;
  window.teamActiveRunKeys = activeRunKeys;
  window.teamAddGroupChat = addGroupChat;
  window.teamRunGroupRound = runGroupRound;
  window.teamParseAdviceCard = parseAdviceCard;
  window.teamAggregateGroup = aggregateGroup;
  window.teamWriteAdviceFile = writeAdviceFile;
  window.teamAdoptAdvice = adoptAdvice;
  window.teamAdviceDir = adviceDir;
})();

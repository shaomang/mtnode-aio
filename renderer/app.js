"use strict";
/* MTNode AI编排器 · 节点编辑器 */
const $ = (s) => document.querySelector(s);
const svgNS = "http://www.w3.org/2000/svg";
/* i18n：使用 i18n.js 挂到 window 的完整 API。勿再声明身份桩，否则会盖掉 setLocale/applyDom。 */
const I18n =
  window.I18n || {
    t: (s) => s,
    setLocale: (l) => (l === "en" ? "en" : "zh"),
    getLocale: () => "zh",
    applyDom: () => {},
    listJoin: (a) => (a || []).join("、"),
    agentLangCode: () => "zh",
    agentLangLabel: () => "中文（简体）",
    agentLangTaste: () => "",
  };

/* 全局运行状态（跨分片共享） */
const S = {
  config: null,
  wf: null,
  cam: { x: 90, y: 80, z: 1 },
  sel: null,
  selWire: null,
  pendingRel: null, /* 关系线两步连接：起点节点 id（点击目标节点完成） */
  drag: null,
  saveTimer: null,
  saving: false,
  lastSaved: null,
  refMenu: null,
  slashMenu: null,
  /* uiOpenNode 已废除：节点「设置」不再就地展开在 body 里，统一走 ⚙ 跳窗
     （见 app-canvas.js openNodeSettingsDialog / NODE_SETTINGS_FORMS）。 */
  uiBgRmNode: null,
  undoStack: [],
  redoStack: [],
  preDragSnap: null,
  runPromises: new Map(),
  playLocks: new Map(), /* playNode 入场锁：并行补跑同一上游时复用同一次执行 */
  appVersion: "0.0.0",
  /* 运行时思考内容（不持久化）：S.thinking[nodeId] = [尝试0文本, 尝试1…] */
  thinking: {},
  thinkOpen: null,
  openDshTools: {},
  /* 工作流对象袋：切画布时保留仍有运行中节点的 wf，避免内容丢失 / 串画布 */
  wfBag: {},
  /* 智能运行画布编辑绑定栈（canvas 事件写入对应 wf，而非当前展示的 S.wf） */
  canvasRunWf: null,
  canvasRunStack: [],
  /* 节点所属画布 id（运行期间），便于后台完成后写回正确画布 */
  nodeWfId: {},
  /* 已删画布黑名单：id → { at, name }。主进程删除成功后，这张画布在磁盘上
     已不存在，此后任何一次 wfSave 都会凭空复活一个空壳画布（或把旧内容串写
     进同名新建画布），所以 persist / persistWf / flushCurrentWf 命中即丢弃。 */
  _deletedWfIds: {},
  /* 被删画布【对象】的墓碑：同名画布之后被合法重建（default 最常见）时只解
     id 黑名单，旧对象引用依然写不进新画布，防 agent 拿残留引用串写。 */
  _deadWfObjs: typeof WeakSet === "function" ? new WeakSet() : null,
  /* 后台对非当前画布做 canvas 编辑时为 false，禁止 renderCanvas 闪到别的画布 */
  _canvasEditVisible: true,
  /* 前台画布唯一真源：用户当前看到的那个画布对象。只由用户可见的切换
     （ensureWorkflow / loadWorkflow / newWorkflowDialog / createWorkflowNamed /
     adoptImportedWorkflow / 删除后重建默认画布）经 setForegroundWf 赋值；
     runAgainstWf 等后台编辑只临时换 S.wf，绝不改这里。 */
  _fgWf: null,
  /* 后台换画布编辑的在飞行计数（runAgainstWf 进出 ±1，异常也减）。
     >0 期间 S.wf 可能正指向别的画布，「保存当前画布」只准写 currentVisibleWf()。 */
  _bgCanvasDepth: 0,
  /* 多选节点集合（框选 / Ctrl+点击），S.sel 保持为主选中项（兼容旧逻辑） */
  selSet: new Set(),
  selGroup: null, /* 选中的「组」id */
  selMark: null, /* 选中的画布标注（绘制）id */
  selMarkSet: new Set(), /* 多选绘制（框选 / Ctrl+点击） */
  boxMode: false, /* 框选模式开关 */
  hideWires: false, /* 顶栏「隐藏线」：临时把连线压到几乎不可见（纯视觉，不落画布） */
  sidebarOpen: false,
  sideCollapsed: {}, /* 边栏分类折叠状态 */
  sideSuperCollapsed: {}, /* 超级节点树折叠状态 */
  /* 右侧全局助手 */
  assistOpen: false,
  assistLive2d: false,
  assistMessages: [],
  assistRunning: false,
  assistPending: "",
  assistLiveTools: [],
  assistRunActive: false, /* 全局助手运行中：画布 edit 需用户确认 */
  /* 助手预设：空串 = 跟随默认档（AGENT_PRESET_DEFAULT，本对象定义在它之前，不能直引）；
     开机读配置时（app-boot.js）才填成实际生效的那一档 */
  assistPreset: "",
  assistProvider: "deepseek-official",
  assistModel: "",
  assistEffort: "high",
  assistWorkspace: "",
  /* 全局助手本次运行冻结的工作目录（切画布也不改） */
  assistRunWorkspace: null,
  /* current = 仅当前画布；global = 可参考/切换其他画布 */
  assistScope: "current",
  assistW: 320, /* 右侧助手栏宽度：最小 320，最大半屏 */
  agentSideW: 280, /* 会话左栏宽度：默认即最小 280，可拖拽加宽（最大半屏） */
  /* 会话「计划」清单的最小高度：默认即最小（app-plan.js PLAN_LIST_MIN_H），
     清单上方的把手可继续向上拖高（上限按当下窗口与输入区实测），全局偏好、松手落盘 */
  agentPlanH: 120,
  /* 排队等待上游执行的节点 id（▶ 显示 pending 动效） */
  pendingRun: new Set(),
  /* 任务节点「进入」：只显示 parentTaskId === taskFocus 的节点 */
  taskFocus: "",
  taskStack: [],
  /* 超级节点内部：只显示 parentSuperId === superFocus 的节点 */
  superFocus: "",
  superStack: [],
  /* 画布查找 / 替换（Ctrl+F / Ctrl+G，仅当前工作流） */
  findBar: {
    open: false,
    replaceMode: false,
    query: "",
    replace: "",
    matches: [],
    idx: -1,
  },
  /* 应用插件目录缓存（appPluginsCatalog 快照）：菜单项可见性 / 节点未安装警示条用。
     启动时与插件对话框增删后刷新（refreshAppPluginsCache）。 */
  plugins: [],
};

/* 节点粘贴板（Ctrl+C 复制 / Ctrl+V 粘贴）：仅保存最近一次。
   保存选中节点（含全部后代）与两端都在复制集内的连线；
   内部子节点归属（parentTaskId / parentSuperId）随节点一起保存，粘贴时重建。 */
let nodeClipboard = null;

/* ── 应用插件目录缓存：菜单项可见性 / 节点未安装警示条 ──
   刷新 S.plugins = appPluginsCatalog().plugins 快照。启动时（app-boot）与
   插件对话框增删后（app-plugins）调用；appPluginInstalled(id) 判断某插件是否已安装。
   remotion：主进程目录对宿主型插件 installed 恒为 true（占位），这里用
   remotionStatus IPC 异步修正为真实状态（未安装 → 菜单隐藏 + 节点警示条）。 */
async function refreshAppPluginsCache() {
  try {
    if (!window.api || !window.api.appPluginsCatalog) return;
    const cat = await window.api.appPluginsCatalog();
    let list = Array.isArray(cat && cat.plugins) ? cat.plugins : [];
    if (window.api.remotionStatus) {
      try {
        const st = await window.api.remotionStatus();
        list = list.map((p) =>
          p && p.id === "remotion"
            ? Object.assign({}, p, {
                installed: !!(st && st.installed && st.runtimeReady),
              })
            : p,
        );
      } catch (_) {
        /* 状态查询失败：保留目录占位值 */
      }
    }
    S.plugins = list;
  } catch (_) {
    /* 目录拉取失败：保留旧缓存（首启为空 → 菜单不显示插件节点，安全） */
  }
}
function appPluginInstalled(id) {
  return !!(
    S.plugins &&
    (S.plugins || []).some((p) => p && p.id === id && p.installed)
  );
}

const HEAD = 28;
const PORT_R = 4;
/* 相邻端子间距 = 直径 + 间隙；间隙与端子半径一致（12 = 8 + 4） */
const PORT_STEP = PORT_R * 3;
const PORT_OFF = 7; /* 端子圆心到节点左右边缘的距离：端子内嵌在节点板内的左右接线排上（圆心距边缘 7px，全部在节点外框之内） */
/* 节点边框宽度（.wf-node border:1px）。.port 绝对定位相对的是 padding box（内缩边框），
   而连线端点公式以节点 border-box 原点为基准，二者相差 1 个边框宽度；
   所有"端子孔圆心"公式统一加回 NODE_BORDER，保证连线终点精确落在插孔中心。 */
const NODE_BORDER = 1;
/* 画布缩放范围：下限放宽便于大工作流总览 */
const CAM_Z_MIN = 0.08;
const CAM_Z_MAX = 2.5;
/* 平移时允许视野超出内容边界的最大空白（px） */
const CAM_PAN_PAD = 640;

/* 输出节点（proc_text / proc_image）几何约束：
   输出面板可大幅放大（旧上限 440px 移除），输入框（左侧）保持最小宽度不被挤压；
   节点自身缩放时按内容宽度限制下限，避免输出面板出界 */
const PROC_OUT_MIN = 120; /* 输出面板最小宽度 */
const PROC_OUT_MAX = 2000; /* 输出面板最大宽度（宽到接近无限，供大内容浏览） */
const PROC_LEFT_MIN = 160; /* 输入框（提示词区域）最小宽度 */
const PROC_PAD = 16; /* n-body 左右内边距（8+8） */
const PROC_GAP = 8; /* n-proc-row 列间距 */
const PROC_BORDER = 4; /* wf-node 左右边框余量（box-sizing 计入宽度） */
/* 带输出面板的节点最小总宽度 */
function procMinNodeW(outW) {
  return (
    PROC_PAD +
    PROC_LEFT_MIN +
    PROC_GAP +
    (outW == null ? PROC_OUT_MIN : outW) +
    PROC_BORDER
  );
}

const KIND_CLS = {
  input_text: "in",
  input_image: "in",
  input_file: "in",
  /* 音频 / 视频输入：与图像输入同族（in 青色描边），nodeElement 再补 .in-media */
  input_audio: "in",
  input_video: "in",
  /* 素材节点（素材库内容打包）：纯内容源，与输入族同族同色；卡片另打 .asset-node */
  asset: "in",
  db_table: "db-tbl",
  proc_text: "proc",
  proc_image: "proc-img",
  save: "sv",
  save_text: "sv",
  save_image: "sv",
  task: "task",
  agent_task: "agent",
  control: "ctrl",
  wait_file: "wait",
  timer: "timer",
  judge: "judge",
  delayer: "delayer",
  sequencer: "sequencer",
  gate: "gate",
  splitter: "splitter",
  counter: "counter",
  mutex: "mutex",
  global: "global",
  music_gen: "music",
  /* SoVITS 语音生成：复用 .wf-node.tts 样式族（紫调，与音乐/视频同族不同色） */
  tts_gen: "tts",
  video_gen: "video",
  remotion: "video",
  net_recv: "net",
  net_send: "net",
  execute: "exec",
  function: "proc",
  tool: "proc",
  super: "super",
  super_io: "super-io",
  db_replica: "db",
};

/* 节点标题栏拖动手柄图标（SVG，stroke=currentColor） */
const KIND_ICON_SVG = {
  /* 输入 · 文本：三行文字 */
  input_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h8M3 11.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  /* 输入 · 图像：相框风景 */
  input_image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="7" r="1.1" fill="currentColor"/><path d="M3.5 11.2l3.2-3.2 2.1 2.1 1.6-1.6 2.1 2.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 输入 · 文件：文档 + 折角 + 字符行 */
  input_file:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 2.6h6.2l2.9 2.9v8a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V2.6z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.4 2.8v2.7H12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.4 8.2h5.2M5.4 10.3h5.2M5.4 12.4h3.4" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 输入 · 音频：喇叭 + 声波（选择本机文件 · 输出 URL） */
  input_audio:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 6.2h2.1L8.4 3.6v8.8L5.3 9.8H3.2a.7.7 0 0 1-.7-.7V6.9a.7.7 0 0 1 .7-.7z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M10.8 6.1c.8.9.8 3 0 3.9M12.7 4.4c1.5 1.7 1.5 5.5 0 7.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 输入 · 视频：胶片框 + 播放三角（选择本机文件 · 输出 URL） */
  input_video:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3.6" width="12" height="8.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M2 6.1h12M2 9.9h12" fill="none" stroke="currentColor" stroke-width="1" opacity=".65"/><path d="M6.9 7.1l2.6 1.9-2.6 1.9V7.1z" fill="currentColor"/></svg>',
  /* 素材节点（素材库打包）：托盘 + 三层内容（文本 / 图像 / 媒体） */
  asset:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 6.1L8 3l5.8 3.1L8 9.2 2.2 6.1z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M2.2 9.1L8 12.2l5.8-3.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity=".85"/><path d="M2.2 11.9L8 15l5.8-3.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" opacity=".55"/></svg>',
  /* 处理 · 表（建表）：表格框 + 表头行 */
  db_table:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.8" width="11.2" height="10.4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M2.4 5.6h11.2M6.6 5.6v7.6M10.8 5.6v7.6" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4.2 4.2h1.6M8.4 4.2h1.6" fill="currentColor" stroke-linecap="round"/></svg>',
  /* 处理 · 文本 LLM：文档 + 火花（生成） */
  proc_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h5.2L12 5.6V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.1 2.9V5.5H11.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.8 8.2h4.4M5.8 10.4h3.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M11.6 9.1l.55 1.35 1.4.35-1.15.9.35 1.4-1.15-.85-1.15.85.35-1.4-1.15-.9 1.4-.35z" fill="currentColor"/></svg>',
  /* 处理 · 图像生成：画框 + 闪光笔触 */
  proc_image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.2" width="9.2" height="7.6" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.4 9.4l2.4-2.5 1.6 1.5 1.3-1.2 1.5 2.2" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.2 10.2c.7-.15 1.35-.55 1.85-1.15.35.7.4 1.5.15 2.25-.55-.1-1.15 0-1.65.35-.15-.55-.2-1.05-.35-1.45z" fill="currentColor"/><path d="M13.6 6.2l.35.85.9.2-.75.55.2.9-.7-.55-.7.55.2-.9-.75-.55.9-.2z" fill="currentColor"/></svg>',
  /* 保存 · 按输入自判文本/图像/音频/视频 */
  save:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.2 7.2L8 10l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 12.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  save_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.2 7.2L8 10l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 12.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.5 4.2h1.8M5.5 6h2.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
  save_image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.2 7.2L8 10l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 12.5h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="10.2" y="3" width="3.2" height="2.6" rx=".4" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  /* 任务 · 规划步骤 */
  task:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M4.6 6.1l1.5 1.5 3.4-3.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.6 10.6h6.8M4.6 12.4h4.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 超级节点 */
  super:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.25"/><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" fill="none" stroke="currentColor" stroke-width="1.15" opacity=".85"/><path d="M5.6 8h4.8M8 5.6v4.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  super_io:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 8h5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  /* 数据库副本 */
  db_replica:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.4" rx="5" ry="1.7" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3 3.4v9.2c0 .94 2.24 1.7 5 1.7s5-.76 5-1.7V3.4" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3 8c0 .94 2.24 1.7 5 1.7s5-.76 5-1.7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  /* 数据库（金色通用图标：库体 + 三层盘面） */
  db:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.4" rx="5" ry="1.7" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3 3.4v9.2c0 .94 2.24 1.7 5 1.7s5-.76 5-1.7V3.4" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3 8c0 .94 2.24 1.7 5 1.7s5-.76 5-1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 12.6c0 .94 2.24 1.7 5 1.7s5-.76 5-1.7" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".7"/></svg>',
  /* 开发节点（功能块）：立方体模块 + 顶面分界线 */
  dev:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.1l5.5 2.95v5.9L8 13.9l-5.5-2.95v-5.9L8 2.1z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M2.5 5.05L8 8l5.5-2.95M8 8v5.9" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" opacity=".9"/></svg>',
  /* 函数节点：花括号 {} + 行（JS 计算） */
  function:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.8 2.9h6.4a1 1 0 0 1 1 1v2.2c0 .6-.4 1-1 1-.3 0-.5.2-.5.5v.8c0 .3.2.5.5.5.6 0 1 .4 1 1v2.2a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1V9.9c0-.6.4-1 1-1 .3 0 .5-.2.5-.5v-.8c0-.3-.2-.5-.5-.5-.6 0-1-.4-1-1V3.9a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.5 5.9h3M6.5 10.1h3" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 工具节点（super + tool:true · Agent 可调用 · 参数即端子）：开口扳手 */
  tool:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.1 5.7a3.4 3.4 0 0 1-5 3.1L3.6 14.3a1.5 1.5 0 0 1-2.1-2.1l5.5-5.5a3.4 3.4 0 0 1 3.1-5L8.3 3.5l1.9 1.9 2.3-2.2c.6.5 1.1 1.1 1.6 1.7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.6 8.6l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 智能任务 */
  agent_task:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l1.1 2.4 2.6.3-2 1.8.6 2.6L8 7.9 5.7 9.3l.6-2.6-2-1.8 2.6-.3L8 2.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="12.4" r="1.35" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 9.6v1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 控制 */
  control:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 5.8l4.2 2.2-4.2 2.2V5.8z" fill="currentColor"/></svg>',
  ctrl_start:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 5.6l4.4 2.4-4.4 2.4V5.6z" fill="currentColor"/></svg>',
  ctrl_end_ok:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.2 8.2l1.8 1.8 3.8-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ctrl_end_fail:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 6l4 4M10 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  judge:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4l5.4 5.6L8 13.6 2.6 8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.2v2.2M8 10.4h.01" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  /* 需求等待 */
  wait_file:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h5.2L12 5.6V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.1 2.9V5.5H11.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="9.2" r="2.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 8.1v1.4l.9.5" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 定时触发器 */
  timer:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.6v3.6l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 2.8l1.3 1.3M12.8 2.8l-1.3 1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 延时器 */
  delayer:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h4.2M8.8 8H13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 6.6v1.6l1.1.7" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 序列器 */
  sequencer:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.2" cy="4.2" r="1.15" fill="currentColor"/><circle cx="3.2" cy="8" r="1.15" fill="currentColor"/><circle cx="3.2" cy="11.8" r="1.15" fill="currentColor"/><path d="M5.2 4.2h3.2L12 8 8.4 11.8H5.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 6.4V9.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 闸门 AND */
  gate:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 3.6v8.8" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M2.8 8h3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6 4.2c3.2 0 5.6 1.7 5.6 3.8S9.2 11.8 6 11.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="3.2" cy="4.4" r="1" fill="currentColor"/><circle cx="3.2" cy="8" r="1" fill="currentColor"/><circle cx="3.2" cy="11.6" r="1" fill="currentColor"/><circle cx="13" cy="8" r="1.15" fill="currentColor"/></svg>',
  /* 分发 并行扇出 */
  splitter:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.2" cy="8" r="1.2" fill="currentColor"/><path d="M4.6 8h3.2M7.8 8l3.4-3.4M7.8 8l3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12.4" cy="4.2" r="1.15" fill="currentColor"/><circle cx="12.4" cy="8" r="1.15" fill="currentColor"/><circle cx="12.4" cy="11.8" r="1.15" fill="currentColor"/></svg>',
  /* 计数 */
  counter:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2.8" width="10" height="10.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.4 10.2V5.8h1.7c1.15 0 1.85.55 1.85 1.45 0 .7-.4 1.2-1.05 1.4L9.8 10.2H8.3l-1.1-1.85H6.7v1.85H5.4z" fill="currentColor"/></svg>',
  /* 互斥 */
  mutex:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.2" cy="4.2" r="1.15" fill="currentColor"/><circle cx="3.2" cy="11.8" r="1.15" fill="currentColor"/><path d="M4.6 4.2h2.4L9.4 8 7 11.8H4.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12.2" cy="8" r="1.2" fill="currentColor"/><path d="M9.4 6.2l1.8 1.8-1.8 1.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 节点指南 */
  node_guide:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 2.6h7.4A1.4 1.4 0 0 1 12.2 4v9.2H4.6A1.2 1.2 0 0 1 3.4 12V2.6z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M12.2 13.2h.8V4.4A1.4 1.4 0 0 0 11.6 3" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><path d="M5.6 5.2h4.2M5.6 7.4h4.2M5.6 9.6h2.6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 拆分 */
  split:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h4.2M7.7 8l3.3-3.2M7.7 8l3.3 3.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><circle cx="3.2" cy="8" r="1.2" fill="currentColor"/><circle cx="12.3" cy="4.5" r="1.2" fill="currentColor"/><circle cx="12.3" cy="11.5" r="1.2" fill="currentColor"/></svg>',
  /* 合并 */
  merge:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.5 8H8.3M8.3 8L5 4.8M8.3 8L5 11.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12.8" cy="8" r="1.2" fill="currentColor"/><circle cx="3.7" cy="4.5" r="1.2" fill="currentColor"/><circle cx="3.7" cy="11.5" r="1.2" fill="currentColor"/></svg>',
  /* 全局 · 广播参考 */
  global:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.3" fill="none" stroke="currentColor" stroke-width="1.3"/><ellipse cx="8" cy="8" rx="2.4" ry="5.3" fill="none" stroke="currentColor" stroke-width="1.15"/><path d="M2.8 8h10.4M3.6 5.2h8.8M3.6 10.8h8.8" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
  /* 音乐生成 */
  music_gen:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 11.2a1.8 1.8 0 1 1-1.6-1.78V4.4l7.2-1.4v6.9a1.8 1.8 0 1 1-1.6-1.78V5.1L6.2 6v5.2z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>',
  /* SoVITS 语音生成：喇叭 + 声波条（文本转语音） */
  tts_gen:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.1 6.3h1.9L7.9 3.9v8.2L5 9.7H3.1a.7.7 0 0 1-.7-.7V7a.7.7 0 0 1 .7-.7z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M10.4 6.3v3.4M12.2 4.9v6.2M14 6.9v2.2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  /* 视频生成 */
  video_gen:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M6.4 6.2l4.2 2.2-4.2 2.2V6.2z" fill="currentColor"/></svg>',
  /* Remotion 视频（React 动效合成 · 本地渲染）：播放框 + 右上生成星火 */
  remotion:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M6.4 6.2l4.2 2.2-4.2 2.2V6.2z" fill="currentColor"/><path d="M12.5 2.3l.45 1.05.9.25-.9.25-.45 1.05-.45-1.05-.9-.25.9-.25z" fill="currentColor"/></svg>',
  /* 网络 · 接收：圆节点 + 上方接收箭头 + 下横线 */
  net_recv:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M8 5.7V2.4M8 2.4L5.9 4.5M8 2.4L10.1 4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 11.6h9.6M5.2 13.4h5.6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 网络 · 发送：圆节点 + 下方发送箭头 + 上横线 */
  net_send:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M8 10.3v3.3M8 13.6L5.9 11.5M8 13.6L10.1 11.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 2.6h9.6M5.2 4.4h5.6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 执行节点：圆角方框 + 播放键（一键启动绑定文件） */
  execute:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.8" width="11.2" height="10.4" rx="2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M6.3 5.6l4.4 2.4-4.4 2.4V5.6z" fill="currentColor"/></svg>',
  /* 绘制 · 笔 + 画板 */
  draw:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.8" width="8.6" height="7.4" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M7.4 12.6l5.2-5.2 1.15 1.15-5.2 5.2H7.4v-1.15z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M11.5 8.5l1.15 1.15" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 5.2h5.2M4 7.2h3.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
  /* 其他节点 · 收纳盒（盒体 + 省略号） */
  other:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 5.6h11.2v6.2a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V5.6z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M4.6 5.6V4.2a1 1 0 0 1 1-1h4.8a1 1 0 0 1 1 1v1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.2 9.1h.01M8 9.1h.01M10.8 9.1h.01" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  /* 构建工作流：左列节点 + 汇流线 + 生成星标 */
  build_wf:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.6" y="2.2" width="4.4" height="3.4" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="1.6" y="10.4" width="4.4" height="3.4" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.9h1.9v4.1M6 12.1h1.9V8" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.2 3.2l.95 2.15L15.3 6.3l-2.15.95-.95 2.15-.95-2.15L9.1 6.3l2.15-.95z" fill="currentColor"/><path d="M11 11.2l.55 1.25 1.25.55-1.25.55L11 14.85l-.55-1.3-1.25-.55 1.25-.55z" fill="currentColor" opacity=".75"/></svg>',
  /* 菜单操作 */
  menu_copy:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.2" y="4.2" width="7.2" height="8.4" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3.6 10.6V3.8A1.1 1.1 0 0 1 4.7 2.7h6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  menu_delete:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 4.6h9.2M6.2 4.6V3.5h3.6v1.1M5.2 4.6l.6 8h4.4l.6-8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  menu_color:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6c2.9 0 5.4 2.1 5.4 5.1 0 1.7-1.1 2.6-2.2 2.6-.7 0-1.1-.4-1.1-1.1 0-.3.1-.7.1-1 0-1.5-1.2-2.6-2.2-2.6S5.8 6.7 5.8 8.2c0 .3.1.7.1 1 0 .7-.4 1.1-1.1 1.1-1.1 0-2.2-.9-2.2-2.6C2.6 4.7 5.1 2.6 8 2.6z" fill="none" stroke="currentColor" stroke-width="1.25"/><circle cx="5.6" cy="6.4" r=".8" fill="currentColor"/><circle cx="8" cy="5.2" r=".8" fill="currentColor"/><circle cx="10.4" cy="6.4" r=".8" fill="currentColor"/></svg>',
  menu_ungroup:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="3.4" width="6.4" height="5.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.4"/><rect x="7" y="7.2" width="6.4" height="5.4" rx="1" fill="none" stroke="currentColor" stroke-width="1.25"/></svg>',
  menu_cut:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.2" cy="11.4" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="11.8" cy="11.4" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 10.4L12.2 3.4M10.5 10.4L3.8 3.4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  menu_saveas:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6v7.4M5.4 7.4L8 10.2 10.6 7.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.4 12.6h9.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  menu_preview:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 8c1.6-2.8 3.6-4.2 5.6-4.2S12 5.2 13.6 8c-1.6 2.8-3.6 4.2-5.6 4.2S4 10.8 2.4 8z" fill="none" stroke="currentColor" stroke-width="1.25"/><circle cx="8" cy="8" r="1.7" fill="none" stroke="currentColor" stroke-width="1.25"/></svg>',
  mark_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3.4h8M8 3.4v9.2M5.4 12.6h5.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  mark_box:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3.4" width="10" height="9.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  mark_arrow:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 8h9.2M9.2 4.8L13.2 8 9.2 11.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 关系线（直线 · 双向箭头 · 仅表示关系） */
  menu_link:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 11.4V7.2h6.8v-3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M11.4 1.9l1.6 2.3-2.7.5z" fill="currentColor"/><path d="M4.6 14.1l-1.6-2.3 2.7-.5z" fill="currentColor"/></svg>',
  /* 细化（洋葱层 · 展开一层） */
  menu_refine:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="2.6" width="4.6" height="4.6" rx="1" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M7.2 4.9h3.2v3.2M10.4 8.1v3.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="8.8" y="8.8" width="2.5" height="2.5" rx=".7" fill="none" stroke="currentColor" stroke-width="1.15"/><rect x="11.6" y="11.6" width="1.9" height="1.9" rx=".6" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  /* 文件夹 */
  folder:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 4.3h3.4l1.1 1.15h6.7c.44 0 .8.36.8.8v5.55c0 .44-.36.8-.8.8H2.4a.8.8 0 0 1-.8-.8V5.1c0-.44.36-.8.8-.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>',
};

function nodeKindIconKey(node) {
  if (!node) return "proc_text";
  if (node.kind === "proc_text" && node.agent) return "agent_task";
  if (node.kind === "control") {
    if (node.ctrlRole === "start") return "ctrl_start";
    if (node.ctrlRole === "endSuccess") return "ctrl_end_ok";
    if (node.ctrlRole === "endFail") return "ctrl_end_fail";
  }
  /* 工具节点变体（super + tool:true）：扳手图标 */
  if (node.kind === "super" && node.tool) return "tool";
  return node.kind || "proc_text";
}

function nodeKindIconCls(node) {
  if (!node) return "proc";
  if (node.kind === "control") {
    if (node.ctrlRole === "endSuccess") return "ctrl-ok";
    if (node.ctrlRole === "endFail") return "ctrl-fail";
    if (node.ctrlRole === "start") return "ctrl-start";
  }
  return KIND_CLS[node.kind] || "proc";
}

function fillNodeKindIcon(el, node) {
  if (!el) return;
  let key = nodeKindIconKey(node);
  /* 数据库超级节点 / 副本：数据库图标（金色） */
  if (node.kind === "db_replica" || (node.kind === "super" && node.db)) {
    key = "db";
    el.classList.add("db-ico");
    el.classList.remove("dev-ico");
  } else if (node.kind === "super" && node.dev) {
    /* 开发节点（功能块）：立方体图标（青色） */
    key = "dev";
    el.classList.add("dev-ico");
    el.classList.remove("db-ico");
  } else if (node.kind === "super" && node.tool) {
    /* 工具节点（super + tool:true）：扳手图标 */
    key = "tool";
    el.classList.remove("db-ico");
    el.classList.remove("dev-ico");
    el.classList.remove("exec-ico");
  } else if (node.kind === "execute") {
    /* 执行节点：启动器图标（橙红） */
    key = "execute";
    el.classList.add("exec-ico");
    el.classList.remove("db-ico");
    el.classList.remove("dev-ico");
  } else {
    el.classList.remove("db-ico");
    el.classList.remove("dev-ico");
    el.classList.remove("exec-ico");
  }
  const svg = KIND_ICON_SVG[key] || KIND_ICON_SVG.proc_text;
  el.innerHTML = svg;
  el.dataset.kindIcon = key;
}
/* gpt-image-2-vip 支持的尺寸（含 auto） */
const IMAGE_SIZES = [
  "auto",
  "1280x1280",
  "848x1280",
  "1280x848",
  "960x1280",
  "1280x960",
  "1024x1280",
  "1280x1024",
  "720x1280",
  "1280x720",
  "1280x544",
  "2048x2048",
  "1360x2048",
  "2048x1360",
  "1536x2048",
  "2048x1536",
  "1632x2048",
  "2048x1632",
  "1152x2048",
  "2048x1152",
  "2048x864",
  "2880x2880",
  "2336x3520",
  "3520x2336",
  "2480x3312",
  "3312x2480",
  "2560x3216",
  "3216x2560",
  "2160x3840",
  "3840x2160",
  "3840x1632",
];
const DEFAULT_IMAGE_SIZE = "2048x1360";
/* Remotion 视频输出分辨率预设（宽x高，px）——app-canvas.js / app-nodes.js 共用 */
const REMOTION_SIZES = [
  "1280x720",
  "1920x1080",
  "720x1280",
  "1080x1920",
  "1024x1024",
  "1080x1080",
];
/* Agent 预设（对应 dsh/gateway/gateway.mjs 的 PRESETS）——渲染层唯一真源：
   会话模型菜单、右侧助手栏「预设」下拉（syncAssistPresetOptions）、智能节点面板「预设」、
   设置「Agent 预设」下拉、开发节点 🧠 弹层与 agentPresetLabel() 都遍历此表，
   任何一处自抄一份都会漏档（选不到 / 丢档）。
   labelKey：菜单与当前档回显用的短名；settingsLabelKey：设置里带括号说明的长名；
   hint：悬停说明（tooltip）。文本存 i18n key，取用时再 I18n.t（切语言即生效）。
   node / pure / bongochat 由宿主内部指定，刻意不上 UI 列表；新增可见档位只改这里。
   **表序 = 菜单与设置下拉的显示序**：默认档排第一（一眼看到的就是出厂那一档）。 */
const AGENT_PRESETS = [
  {
    id: "minimal",
    labelKey: "极简模式",
    settingsLabelKey: "极简模式（默认 · 直奔结果，少解释）",
    hint: "省事档：最少步骤、最少废话，直接给结果",
  },
  {
    id: "standard",
    labelKey: "标准模式",
    settingsLabelKey: "标准模式（通用档：画布 / 文件 / 内容任务）",
    hint: "通用档：画布编排、文件与内容任务兼顾",
  },
  {
    id: "lean",
    labelKey: "思维精简",
    settingsLabelKey: "思维精简（思考压成符号骨架：先骨架后干活，最省 token）",
    hint: "思维精简档：思考压成 GOAL / APPROACH / EDGE 符号骨架；思考强度仍按你的设置走",
  },
  {
    id: "code",
    labelKey: "PTC 模式",
    settingsLabelKey: "PTC 模式（写代码 / 改文件 / 跑命令）",
    hint: "工程档：先读文件再改，改完说明改动与验证方式",
  },
  {
    id: "cordis",
    labelKey: "创造模式",
    settingsLabelKey: "创造模式（自定义 Preset）",
    hint: "Cordis 插件开发档：遵循 Service / ctx.effect / 类型化事件约定",
  },
];
/* 预设档位的兜底 = 默认档（第一档 = minimal 极简）：新会话 / 新智能节点 / 设置缺省
   与读到未知 id 时全部回落到它。任何一处再写死 "standard" 都会造成第二套默认，
   一律用这个常量。 */
const AGENT_PRESET_DEFAULT = "minimal";
/* 历史 id 兼容：本档原名 sketch（旧中文档位名已随改名废弃），旧会话 / 智能节点存的
   仍是 sketch。网关侧也有一份同样的归一（gateway.mjs 的 LEGACY_PRESET_IDS），
   两侧都要认，否则旧值会在界面上静默显示成「标准模式」。 */
const AGENT_PRESET_LEGACY_IDS = { sketch: "lean" };
/* Agent 会话 / 助手 / 智能节点的思考强度档（对应 dsh/gateway/reasoning-effort.mjs 的
   EFFORT_ORDER）——渲染层唯一真源：
   - AGENT_EFFORT_ORDER：可选用档词汇 low/medium/high/xhigh/max，全档合法（旧 high/max
     原样合法），旧档（off/none/无/空）与未知值 → high 兜底默认；归一化不迁移不重置
     已存会话的档位（值在词汇表内一律原样保留）。
   - AGENT_EFFORT_UI_ORDER：UI 露出档（助手栏下拉 / 会话思考强度菜单），表序 = 菜单序，
     轻 / 标准 / 强 / 最强。medium 不在露出集：默认 deepseek-official 路由把 medium 按
     同侧最近低档夹到 low（见 dsh/DESIGN.md「思考强度契约」），露出来会在默认路由静默
     降档；若能力查证确认有真实可消费 medium 的路由/模型，把 "medium" 插进
     AGENT_EFFORT_UI_ORDER 即可——词汇表与白名单归一已含 medium，无需再改其它迁移。
   - AGENT_EFFORT_LABELS：档位短名（zh 文本同时是 i18n key，取用时 I18n.t 即切语言）。 */
const AGENT_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const AGENT_EFFORT_UI_ORDER = ["low", "high", "xhigh", "max"];
const AGENT_EFFORT_LABELS = {
  low: "轻",
  medium: "中",
  high: "标准",
  xhigh: "强",
  max: "最强",
};
function agentPresetId(id) {
  const raw = id == null ? "" : String(id);
  return Object.prototype.hasOwnProperty.call(AGENT_PRESET_LEGACY_IDS, raw)
    ? AGENT_PRESET_LEGACY_IDS[raw]
    : raw;
}
function agentPresetById(id) {
  const want = agentPresetId(id);
  return (
    AGENT_PRESETS.find((p) => p.id === want) ||
    AGENT_PRESETS.find((p) => p.id === AGENT_PRESET_DEFAULT) ||
    AGENT_PRESETS[0]
  );
}
/* ── 思考强度归一与显示名 ─────────────────────────────────────────────
   会话 / 助手 / 智能节点共用。选哪档就按哪档下发：网关已取消按预设压档
   （历史上「思维精简」会把「标准」自动降到 low），预设只管思考的表达形式，
   思考预算由用户设置说了算。路由能力不足时网关把请求夹到同侧最近低档并回传
   effort 事件（回显 = 下发契约），渲染层不再拍平（medium/xhigh 原样放行）。 */
/* 白名单归一：词汇表内原样返回（旧值 high/max 原样合法），旧档 / 未知 → high 默认。 */
function normalizeAgentEffort(v) {
  const raw = String(v == null ? "" : v).trim().toLowerCase();
  if (raw === "无") return "high";
  return AGENT_EFFORT_ORDER.includes(raw) ? raw : "high";
}
/* 档位短名（本地化）：词汇表内任一档（含未露出 UI 的 medium）都有可显示名。 */
function agentEffortLabelOf(v) {
  return I18n.t(AGENT_EFFORT_LABELS[normalizeAgentEffort(v)] || "标准");
}
function agentEffortDisplayLabel(st) {
  return agentEffortLabelOf((st || {}).effort);
}
const NODE_DEFAULTS = {
  input_text: {
    w: 240,
    h: 130,
    title: "文本",
    text: "",
    batch: false,
    entries: [],
  },
  input_image: {
    w: 220,
    h: 170,
    title: "图像",
    imageAsset: "",
    sourceName: "",
    batch: false,
    entries: [],
  },
  /* 音频 / 视频输入节点：选择本机文件并预览，引用原绝对路径（不复制进资产，
     音视频可能很大）；不进执行引擎（静态源），但有 1 个数据输出端子 =
     该文件的 file:/// URL（见 mediaInputValueOf），可连进媒体参考端子、可被 @ 引用。 */
  input_audio: {
    w: 300,
    h: 220,
    title: "音频",
    mediaAsset: "",
    sourceName: "",
  },
  input_video: {
    w: 300,
    h: 220,
    title: "视频",
    mediaAsset: "",
    sourceName: "",
  },
  /* 素材节点（素材库 · 纯内容类节点）：把一堆文本 / 图像 / 音频 / 视频打包成一个可复用
     的内容源。节点本体只是「绑定」——assetId + 相对素材库根目录的 assetRel（不存绝对路径，
     换盘后按 id→相对路径重定位），内容实体永远在素材夹里，删画布也不丢。
     items = 内容条目快照 [{id,title,type}]：端子唯一真源 —— 一个条目 = 一个输入端子 +
     一个输出端子（第 i 入 ↔ 第 i 出，端子标题即条目标题），无控制端子、不参与控制流。
     端子数随条目增删 / 重排而变（app-canvas.js buildAssetBody 渲染、app-assets.js 读写库）。 */
  asset: {
    w: 300,
    h: 250,
    title: "素材",
    assetId: "",
    assetRel: "",
    assetName: "",
    assetDesc: "",
    items: [],
  },
  /* 数据库 · 文件节点：批量导入任意文件（复制进数据库子文件夹），供「表」读取 */
  input_file: {
    w: 280,
    h: 180,
    title: "文件",
    files: [],
  },
  /* 数据库 · 表节点：从「文件节点」读取，agent 抽元数据→用户确认表单→按表单建表 */
  db_table: {
    w: 360,
    h: 240,
    title: "表",
    tableDef: null,
    rows: [],
    schemaFile: "",
    dataFile: "",
    builtAt: 0,
    building: false,
    error: "",
  },
  proc_text: {
    w: 380,
    h: 200,
    title: "文本处理",
    prompt: "",
    providerId: "",
    model: "",
    temperature: 0.7,
    effort: "low",
    batchMode: "batch",
    agent: false,
    agentWorkspace: "",
    globalRefs: false,
    agentPerm: "canvas",
    agentPermOutside: "",
    agentPermAlwaysPaths: [],
    output: null,
    batchOutputs: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  proc_image: {
    w: 360,
    h: 200,
    title: "图像生成",
    prompt: "",
    providerId: "",
    model: "",
    size: DEFAULT_IMAGE_SIZE,
    batchMode: "batch",
    bgRmOn: false,
    /* 透明背景 = 双通道差分抠图：tol 噪点地板 / soft 边缘羽化 / align 第 2 通道自动对齐
       bgRmKey 是旧「色键抠图」遗留字段，现已不再参与算法，仅保留以兼容旧画布 */
    bgRmKey: "#FF00FF",
    bgRmTol: 24,
    bgRmSoft: 32,
    bgRmAlign: true,
    bgRmPairs: [],
    globalRefs: false,
    output: null,
    batchOutputs: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  save: {
    w: 320,
    h: 240,
    title: "保存",
    savePath: "",
    auto: true,
    batchMode: "batch",
    savedPath: "",
    savedPaths: [],
    savedAt: 0,
    boundFromId: "",
  },
  /* 旧工作流别名：hydrate 会迁成 save */
  save_text: {
    w: 320,
    h: 220,
    title: "保存文本",
    savePath: "",
    auto: true,
    batchMode: "batch",
    savedPath: "",
    savedPaths: [],
    savedAt: 0,
    boundFromId: "",
  },
  save_image: {
    w: 290,
    h: 240,
    title: "保存图像",
    savePath: "",
    auto: true,
    batchMode: "batch",
    savedPath: "",
    savedPaths: [],
    savedAt: 0,
    boundFromId: "",
  },
  split: { w: 260, h: 190, title: "拆分" },
  merge: { w: 230, h: 150, title: "合并" },
  global: { w: 260, h: 160, title: "全局", tagFilter: [], tags: [] },
  task: {
    w: 320,
    h: 280,
    title: "任务",
    goal: "",
    steps: [],
    parentTaskId: "",
    taskStatus: "pending",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  super: {
    w: 280,
    h: 200,
    title: "超级节点",
    note: "",
    expandW: 720,
    expandH: 480,
    superOpen: false,
    subFolder: "",
    innerPanX: 0,
    innerPanY: 0,
    parentTaskId: "",
    parentSuperId: "",
    /* 数据库超级节点：收纳事实（信息节点 + 子文件夹文件），编译生成副本 */
    db: false,
    /* db 节点展示形态：super=超节点形态；db=数据库形态（内嵌查询/调试控制台） */
    dbMode: "super",
    /* 开发节点自定义外框颜色（#rrggbb；空 = 按元素类型默认色） */
    devColor: "",
    /* 开发节点 Agent 模型（devModel 空 = 未选择，跟随默认；devProvider 为智能
       路由，由模型自动推断，未选模型时无意义）；子块未选择时继承上层 */
    devModel: "",
    devProvider: "",
    /* 开发节点 Agent 预设与思考强度（与会话语义同一张表 AGENT_PRESETS）：
       devPreset = 预设档 id（minimal/standard/lean/code/cordis），devEffort = 思考
       强度（只认 high / max，预设不再压档——思考预算只由这一项决定）。空串 = 跟随
       默认（默认档 = AGENT_PRESET_DEFAULT）；子块未选择时与 devModel 一样就近向上继承。 */
    devPreset: "",
    devEffort: "",
    /* 开发节点「核心文件列表」：本块最关键的源码文件路径（相对本块项目根，
       分隔符统一 '/'；也容忍绝对路径），最多 DEV_CORE_FILES_MAX 个。
       最外层开发节点（项目节点）不列举。口径见 app-devnode.js 同名小节。 */
    devFiles: [],
    /* 工具节点变体（tool:true，沿用 db:/dev: 变体模式）：Agent 可调用工具 ·
       参数即端子。toolConfig = { name, description, inputs:[{name,kind}],
       outputs:[{name,kind}] }；标题默认 = 工具名，手动改名后 name 独立。 */
    tool: false,
    toolConfig: null,
  },
  super_io: {
    w: 132,
    h: 72,
    title: "端口",
    superIo: "in",
    superIoIndex: 0,
    parentTaskId: "",
    parentSuperId: "",
    pinned: true,
  },
  db_replica: {
    w: 300,
    h: 240,
    title: "数据库副本",
    dbNodeId: "",
    dbName: "",
    compiledAt: 0,
    count: 0,
    parentTaskId: "",
    parentSuperId: "",
  },
  agent_task: {
    w: 380,
    h: 380,
    title: "智能任务",
    task: "",
    messages: [],
    convH: 200,
    inputH: 64,
    workspace: "",
    batchMode: "batch",
    effort: "high",
    /* 智能节点默认走默认预设：跑起来时 app-db.js 会把「默认档」换成内部 node 档
       （办事不改图），所以这里存的是界面档，不是网关档。 */
    preset: AGENT_PRESET_DEFAULT,
    provider: "",
    agentSessionId: "",
    chatMode: false,
    globalRefs: false,
    /* canvas=工作区沙箱（跟随全局权限预设）；super=全主机超级权限 */
    agentPerm: "canvas",
    /* 首次切到超级权限时选定：ask=外部路径询问；direct=直接访问 */
    agentPermOutside: "",
    agentPermAlwaysPaths: [],
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  control: {
    w: 240,
    h: 140,
    title: "控制",
    ctrlAction: "run",
    ctrlFillOnly: false,
    ctrlRole: "",
    ctrlPinned: false,
    running: false,
  },
  judge: {
    w: 260,
    h: 180,
    title: "判断",
    prompt: "",
    providerId: "",
    model: "",
    globalRefs: false,
    output: null,
    error: null,
    ranAt: 0,
    running: false,
    judgeResult: "",
  },
  wait_file: {
    w: 300,
    h: 200,
    title: "需求等待",
    waitPath: "",
    waitIntervalSec: 2,
    output: null,
    error: null,
    ranAt: 0,
    running: false,
    waitStatus: "",
    waitReady: false,
  },
  timer: {
    w: 340,
    h: 280,
    title: "定时触发器",
    timerMode: "interval",
    timerAt: "",
    timerEverySec: 3600,
    timerCron: "0 * * * *",
    timerArmed: false,
    timerLastAt: 0,
    timerNextAt: 0,
    timerFireCount: 0,
    timerStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  delayer: {
    w: 320,
    h: 220,
    title: "延时器",
    delaySec: 60,
    delayStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  sequencer: {
    w: 320,
    h: 240,
    title: "序列器",
    seqOutputs: 3,
    seqGapSec: 0,
    seqStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  gate: {
    w: 300,
    h: 220,
    title: "闸门",
    gateInputs: 2,
    gateArrived: {},
    gateStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  splitter: {
    w: 300,
    h: 220,
    title: "分发",
    splitOutputs: 3,
    splitStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  counter: {
    w: 300,
    h: 200,
    title: "计数",
    counterEvery: 2,
    counterCount: 0,
    counterStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  mutex: {
    w: 300,
    h: 240,
    title: "互斥",
    mutexInputs: 2,
    mutexMode: "first",
    mutexStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  music_gen: {
    w: 360,
    h: 300,
    /* 一级菜单「音频生成」成员：新建节点默认标题用后端名 */
    title: "Minimax Music 3 节点",
    attempts: 1,
    audioDuration: 60,
    seed: 0,
    rerollSeed: true,
    outputPath: "",
    filename: "",
    boundSaveId: "",
    offload: true,
    musicStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  /* SoVITS 语音生成（GPT-SoVITS 本机后端 · 文本转语音）：
     端子与音乐节点同构 —— 输入 端口0=待合成文本 · 端口1=控制输入；
     输出 端口0=音频内容 · 端口1=控制输出。尺寸参照 music_gen。 */
  tts_gen: {
    w: 360,
    h: 300,
    /* 一级菜单「音频生成」成员：新建节点默认标题用后端名 */
    title: "SoVITS 语音节点",
    attempts: 1,
    voice: "", /* 音色（GPT-SoVITS 音色库名，空 = 用后端默认） */
    speed: 1.0, /* 语速倍率（0.5–2.0） */
    ttsFormat: "wav", /* 输出格式 wav | mp3 */
    outputPath: "",
    ttsStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  video_gen: {
    w: 400,
    h: 340,
    /* 一级菜单「视频生成」成员：新建节点默认标题用后端名 */
    title: "Minimax H3 节点",
    attempts: 1,
    videoMode: "fl2va",
    videoPortV2: true, /* 端口布局 v2：端口0=控制输入（固定）· 端口1=提示词 · 端口2+=参考（旧档无此标记=旧布局，加载时迁移） */
    duration: 5,
    ratio: "16:9",
    outputRes: "auto", /* auto | 480p | 720p | 1080p（输出分辨率档位） */
    seed: 0,
    rerollSeed: true,
    steps: 20,
    sampler: "res_multistep",
    scheduler: "simple",
    denoise: 1,
    shiftVideo: 12,
    shiftAudio: 3,
    easyReuse: 0.2,
    easyStart: 0.15,
    easyEnd: 0.95,
    lowVramHeadChunks: 4,
    chunkFfnChunks: 2,
    chunkFfnSeqThreshold: 4096,
    sageMode: "auto",
    sageCompile: false,
    fps: 24,
    bitDepth: 8,
    videoFormat: "auto",
    videoCodec: "auto",
    filenamePrefix: "video/MiniMax_H3",
    /* 24G 工作流优化：默认开，节点设置可关（TeaCache 已移除，仅 EasyCache） */
    optEasyCache: true,
    optSageAttn: true,
    optLowVramAttn: true,
    optChunkFfn: true,
    optVramBarrier: true,
    refImageSize: "match",
    /* 自建 ComfyUI 工作流（空 workflowId = 内置 FL2VA/R2V 链，零回归） */
    workflowId: "",
    wfParams: [],           /* 提升为节点参数的映射表 [{key,label,type,source:{nodeId,field},defaultValue}] */
    wfPortMap: {},          /* 端口→参数 key：{"1":textParamKey,"2":fileParamKey,…}；空=按类型顺序预填 */
    wfParamValues: {},      /* 面板直填值 { [paramKey]: value }（素材为绝对路径）*/
    wfMeta: null,           /* h3WorkflowGet 缓存 {title,validation,suggested,candidates,outputs} */
    customOutputNodeId: "", /* 可手动指定输出节点 id（空=默认取最后一个视频产物） */
    outputPath: "",
    filename: "",
    boundSaveId: "",
    videoStatus: "",
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  /* Remotion 视频（应用插件 remotion · React 动效合成 → 本地渲染 mp4）：
     描述文本 → LLM 生成 Composition.tsx → 主进程 remotion/main-remotion.js 渲染。
     端口0=控制输入（固定）· 端口1=描述文本输入。 */
  remotion: {
    w: 400,
    h: 320,
    title: "Remotion 视频",
    duration: 5,
    fps: 30,
    size: "1280x720", /* 输出分辨率 宽x高（16:9） */
    seed: 0,
    rerollSeed: true,
    providerId: "",
    model: "",
    temperature: 0.4,
    /* 输出路径由下游「保存」节点负责（渲染产物在主进程插件安装目录 out/） */
    filename: "",
    boundSaveId: "",
    remotionStatus: "",
    remotionPct: 0,
    tsx: "", /* 最近一次 LLM 生成的 Composition.tsx（展示用，宿主当前按结构化参数渲染模板） */
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  net_recv: {
    w: 320,
    h: 190,
    title: "接收",
    netChannel: 0,
    netProto: "tcp",
    netHost: "127.0.0.1",
    netPort: 40999 /* 监听端口（默认 40999；0 = 用全局设置端口） */,
    netListening: false,
    netAutoListen: true /* 监听模式：启动/切画布时自动进入监听状态 */,
    netStatus: "",
    netCount: 0,
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  net_send: {
    w: 340,
    h: 205,
    title: "发送",
    netChannel: 0,
    netProto: "tcp",
    netHost: "127.0.0.1",
    netPort: 41000 /* 目标端口（默认 41000，与监听端口分离；0 = 用全局设置端口） */,
    netStatus: "",
    netCount: 0,
    output: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  /* 执行节点：绑定可执行文件（.exe/.bat/.cmd 或任何系统可打开的文件）· 一键启动 */
  execute: {
    w: 230,
    h: 170,
    title: "执行",
    execPath: "",
    execIcon: "auto",
    execColor: "",
    execStatus: "",
    ranAt: 0,
    running: false,
  },
  /* 函数节点：纯 JS 计算（渲染层宽松执行 · 契约见 js-exec.js 与 docs/tool-function-nodes.md）。
     inputs/outputs = 参数端子列表 [{name, kind}]（kind: text|image，缺省 text）；
     jscode = 函数体：入参对象 input = { 参数名: 值 }，return 即输出。
     端子：输入 0 = 控制入（固定）+ 各输入参数；输出 0..n-1 = 各输出参数 + 末位控制出。 */
  function: {
    w: 380,
    h: 240,
    title: "函数",
    fnName: "",
    description: "",
    jscode: "",
    inputs: [],
    outputs: [],
    fnTestInputs: [],
    output: null,
    batchOutputs: null,
    error: null,
    ranAt: 0,
    running: false,
  },
  /* 工具节点：创建 kind 写 "tool"，落盘形态＝超级节点变体（kind:"super" + tool:true，
     见 NODE_FORM_OF_KIND）——由此直接继承超级节点的全部子画布能力（展开壳 / 进入 /
     拖入收纳 / 内外桥接），不再维护第二套形态。真正的默认值在 NODE_DEFAULTS 之后由
     超级默认值与本段字段合成。
     toolConfig = { name, description, inputs:[{name,kind}], outputs:[{name,kind}] }；
     端子（参数优先 · 与画布连线无关）：输入 0 = 控制入（固定）+ 各输入参数；
     输出 0..n-1 = 各输出参数 + 末位控制出。 */
  tool: {
    w: 320,
    h: 220,
    title: "工具",
    toolConfig: {
      name: "",
      description: "",
      inputs: [],
      outputs: [],
    },
    /* 「试跑」台的输入快照（按输入参数序号存字符串：text = 文本，image = 文件路径）。
       与函数节点的 fnTestInputs 各自独立，仅测试用 · 不参与画布运行。 */
    toolTestInputs: [],
    output: null,
    batchOutputs: null,
    error: null,
    ranAt: 0,
    running: false,
  },
};

/* 工具节点默认值＝超级节点默认值（壳层字段一处不漏：note / expandW·expandH /
   superOpen / subFolder / innerPanX·innerPanY / db / dbMode / devModel…）叠加
   tool 专有字段，并钉死变体标记 tool:true。makeNode 把创建 kind "tool" 换算成
   实际落盘的 kind "super"，判定仍只认 isToolNode()。 */
NODE_DEFAULTS.tool = Object.assign({}, NODE_DEFAULTS.super, NODE_DEFAULTS.tool, {
  tool: true,
});

const TASK_STATUS_LABEL = {
  pending: "待办",
  running: "进行中",
  done: "完成",
  failed: "失败",
  blocked: "需干涉",
  skipped: "跳过",
};

function currentTaskFocus() {
  return S.taskFocus || "";
}
function currentSuperFocus() {
  return S.superFocus || "";
}
/* 当前聚焦的超级节点是否为「数据库」超级节点（其内部右键菜单只给「文件节点 / 表」） */
function currentDbSuper() {
  const sf = currentSuperFocus();
  if (!sf) return null;
  const n = nodeById(sf);
  return n && n.kind === "super" && n.db ? n : null;
}
function nodeParentTaskId(n) {
  return (n && n.parentTaskId) || "";
}
function nodeParentSuperId(n) {
  return (n && n.parentSuperId) || "";
}
function markParentTaskId(m) {
  return (m && m.parentTaskId) || "";
}
function markParentSuperId(m) {
  return (m && m.parentSuperId) || "";
}
function nodeInCurrentScope(n) {
  if (!n) return false;
  const sf = currentSuperFocus();
  if (sf) return nodeParentSuperId(n) === sf;
  let sid = nodeParentSuperId(n);
  if (sid) {
    const seen = new Set();
    while (sid && !seen.has(sid)) {
      seen.add(sid);
      const host = nodeById(sid);
      if (!host || host.kind !== "super" || !host.superOpen) return false;
      if (nodeParentTaskId(host) !== currentTaskFocus()) return false;
      sid = nodeParentSuperId(host);
    }
    return true;
  }
  return nodeParentTaskId(n) === currentTaskFocus();
}
function markInCurrentScope(m) {
  if (!m) return false;
  const sf = currentSuperFocus();
  if (sf) return markParentSuperId(m) === sf;
  let sid = markParentSuperId(m);
  if (sid) {
    const seen = new Set();
    while (sid && !seen.has(sid)) {
      seen.add(sid);
      const host = nodeById(sid);
      if (!host || host.kind !== "super" || !host.superOpen) return false;
      if (nodeParentTaskId(host) !== currentTaskFocus()) return false;
      sid = nodeParentSuperId(host);
    }
    return true;
  }
  return markParentTaskId(m) === currentTaskFocus();
}
function visibleWfNodes() {
  return ((S.wf && S.wf.nodes) || []).filter(
    (n) => !isSuperIoNode(n) && nodeInCurrentScope(n),
  );
}
function visibleMarks() {
  return marksOf().filter(markInCurrentScope);
}
function taskChildrenOf(id) {
  if (!id || !S.wf) return [];
  return (S.wf.nodes || []).filter((n) => n.parentTaskId === id);
}
function superChildrenOf(id) {
  if (!id || !S.wf) return [];
  return (S.wf.nodes || []).filter((n) => n.parentSuperId === id);
}
function isSuperNode(n) {
  return !!(n && n.kind === "super");
}
/* 类超级节点 = 超级节点及其工具节点变体（super + tool:true）：数据 I/O 走同一条
   「外侧输入 / 内侧汇流」通道。数据解析器里凡按 kind==="super" 区分内外通道的位置，
   一律用本判定（运行时执行引擎 app-nodes.js 的 runToolNode）。 */
function isSuperLikeNode(n) {
  return !!(n && (n.kind === "super" || isToolNode(n)));
}
function isSuperIoNode(n) {
  return !!(n && n.kind === "super_io");
}
function superDisplaySize(n) {
  if (!n || n.kind !== "super")
    return { w: (n && n.w) || 240, h: (n && n.h) || 160 };
  if (superIsOpenShell(n)) {
    return {
      w: Math.max(320, Number(n.expandW) || 720),
      h: Math.max(220, Number(n.expandH) || 480),
    };
  }
  return { w: n.w || 280, h: n.h || 200 };
}
function superInnerOrigin(s) {
  if (!superIsOpenShell(s)) return { ox: 10, oy: 40 };
  const el = document.querySelector('.wf-node[data-nid="' + s.id + '"]');
  const stage = el && el.querySelector(".super-stage");
  if (el && stage) {
    const nr = el.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const z = S.cam.z > 0 ? S.cam.z : 1;
    if (nr.width > 0 && sr.width > 0) {
      return {
        ox: (sr.left - nr.left) / z,
        oy: (sr.top - nr.top) / z,
      };
    }
  }
  /* head 28 + border ≈ 29；展开时 body 无上边距，舞台贴齐标题下沿 */
  return { ox: 0, oy: 29 };
}
function superInnerPan(s) {
  return {
    x: Number(s && s.innerPanX) || 0,
    y: Number(s && s.innerPanY) || 0,
  };
}
function nodeByIdIn(id, wf) {
  return ((wf && wf.nodes) || []).find((n) => n.id === id) || null;
}
function stripSuperIoNodes(wf) {
  wf = wf || S.wf;
  if (!wf || !Array.isArray(wf.nodes)) return wf;
  const proxies = wf.nodes.filter((n) => isSuperIoNode(n));
  if (!proxies.length) return wf;
  for (const proxy of proxies) {
    const hostId = proxy.parentSuperId;
    if (!hostId) continue;
    const idx = Number(proxy.superIoIndex) || 0;
    for (const w of wf.wires || []) {
      if (w.to === proxy.id) {
        w.to = hostId;
        w.toIndex = idx;
      }
      if (w.from === proxy.id) {
        w.from = hostId;
        w.fromIndex = idx;
      }
    }
  }
  wf.nodes = wf.nodes.filter((n) => !isSuperIoNode(n));
  return wf;
}
/** 外侧输入（含控制线），用于占位 / 控制隧穿 */
function superExternalInWiresAll(superNode, wf) {
  wf = wf || S.wf;
  if (!superNode || !wf) return [];
  return (wf.wires || [])
    .filter((x) => {
      if (x.rel) return false;
      if (x.to !== superNode.id) return false;
      const from = nodeByIdIn(x.from, wf);
      if (!from || isSuperIoNode(from)) return false;
      return nodeParentSuperId(from) !== superNode.id;
    })
    .sort((a, b) => a.toIndex - b.toIndex);
}
/** 外侧输入数据线（直接控制源排除；勿用 wireFromIsControl，避免与超节点隧穿互相递归） */
function superExternalInWires(superNode, wf) {
  wf = wf || S.wf;
  if (!superNode || !wf) return [];
  return superExternalInWiresAll(superNode, wf).filter((x) => {
    const from = nodeByIdIn(x.from, wf);
    return !!(from && !isControlKind(from));
  });
}
function superInternalOutFeedsAll(superNode, wf) {
  wf = wf || S.wf;
  if (!superNode || !wf) return [];
  return (wf.wires || [])
    .filter((x) => {
      if (x.rel) return false;
      if (x.to !== superNode.id) return false;
      const from = nodeByIdIn(x.from, wf);
      return from && nodeParentSuperId(from) === superNode.id;
    })
    .sort((a, b) => a.toIndex - b.toIndex);
}
function superInternalOutFeeds(superNode, wf) {
  wf = wf || S.wf;
  if (!superNode || !wf) return [];
  return superInternalOutFeedsAll(superNode, wf).filter((x) => {
    const from = nodeByIdIn(x.from, wf);
    return !!(from && !isControlKind(from));
  });
}
function superExternalOutWiresAll(superNode, wf) {
  wf = wf || S.wf;
  if (!superNode || !wf) return [];
  return (wf.wires || [])
    .filter((x) => {
      if (x.rel) return false;
      if (x.from !== superNode.id) return false;
      const to = nodeByIdIn(x.to, wf);
      return to && nodeParentSuperId(to) !== superNode.id;
    })
    .sort((a, b) => (a.fromIndex || 0) - (b.fromIndex || 0));
}
/** 外侧输出：与旧逻辑一致（宿主本身不是 control kind，全部外线参与数据拓扑） */
function superExternalOutWires(superNode, wf) {
  return superExternalOutWiresAll(superNode, wf);
}
function superInternalBridgeWiresAll(superNode, wf) {
  wf = wf || S.wf;
  if (!superNode || !wf) return [];
  return (wf.wires || [])
    .filter((x) => {
      if (x.rel) return false;
      if (x.from !== superNode.id) return false;
      const to = nodeByIdIn(x.to, wf);
      return to && nodeParentSuperId(to) === superNode.id;
    })
    .sort((a, b) => (a.fromIndex || 0) - (b.fromIndex || 0));
}
/** 内侧桥接数据线：外侧同号端子纯控制时排除 */
function superInternalBridgeWires(superNode, wf) {
  wf = wf || S.wf;
  if (!superNode || !wf) return [];
  return superInternalBridgeWiresAll(superNode, wf).filter(
    (x) => !superInPortIsControl(superNode, x.fromIndex, wf),
  );
}
/** 来源是否为控制（含上游超级节点的控制输出） */
function nodeEmitsControlOnPort(node, portIndex, wf, seen) {
  wf = wf || S.wf;
  if (!node) return false;
  if (isControlKind(node)) return true;
  /* 网络·接收：端口1 为控制输出（收到消息时触发控制信号） */
  if (node.kind === "net_recv") return Number(portIndex || 0) >= 1;
  /* 音乐 / 视频 / 语音 / Remotion：端口1 为控制输出（生成完成后触发下游控制目标） */
  if (
    node.kind === "music_gen" ||
    node.kind === "tts_gen" ||
    node.kind === "video_gen" ||
    node.kind === "remotion"
  )
    return Number(portIndex || 0) >= 1;
  /* 函数 / 工具节点：输出末位固定为控制出（参数即端子，不随连线推断） */
  if (isFnToolNode(node)) return fnToolOutPortIsControl(node, portIndex);
  if (node.kind === "super")
    return superOutPortIsControl(node, portIndex, wf, seen);
  return false;
}
/**
 * 外侧输入端子是否为「纯控制」。
 * 同端子若仍有数据线，优先保持数据（兼容旧档双线；新连接已互斥占用）。
 */
function superInPortIsControl(superNode, portIndex, wf) {
  wf = wf || S.wf;
  if (!superNode || !wf) return false;
  const ti = Number(portIndex || 0);
  /* 工具节点（super + tool:true）：输入 0 = 控制入，固定不随连线漂移 */
  if (isToolNode(superNode)) return fnToolInPortIsControl(superNode, ti);
  let hasCtrl = false;
  let hasData = false;
  for (const x of superExternalInWiresAll(superNode, wf)) {
    if (Number(x.toIndex) !== ti) continue;
    const from = nodeByIdIn(x.from, wf);
    if (!from) continue;
    if (nodeEmitsControlOnPort(from, x.fromIndex, wf)) hasCtrl = true;
    else hasData = true;
  }
  return hasCtrl && !hasData;
}
/**
 * 外侧输出端子是否为「纯控制」。
 * 同号汇流若同时有数据源，优先保持数据通道。
 */
function superOutPortIsControl(superNode, portIndex, wf, seen) {
  wf = wf || S.wf;
  if (!superNode || !wf) return false;
  const fi = Number(portIndex || 0);
  /* 工具节点：输出末位 = 控制出（参数即端子），不看内部汇流是什么类型 */
  if (isToolNode(superNode)) return fnToolOutPortIsControl(superNode, fi);
  seen = seen || new Set();
  const key = superNode.id + ":" + fi;
  if (seen.has(key)) return false;
  seen.add(key);
  let hasCtrl = false;
  let hasData = false;
  for (const x of superInternalOutFeedsAll(superNode, wf)) {
    if (Number(x.toIndex) !== fi) continue;
    const from = nodeByIdIn(x.from, wf);
    if (!from) continue;
    if (nodeEmitsControlOnPort(from, x.fromIndex, wf, seen)) hasCtrl = true;
    else hasData = true;
  }
  return hasCtrl && !hasData;
}
/** 收起：仅已占用槽位数；展开：至少 1 个并可多一个空闲槽 */
function superDynamicPortCount(maxIdx, open) {
  /* 收起态也至少保留 1 个外侧输入/输出端子，便于从外部开始连线 */
  if (maxIdx < 0) return 1;
  return open ? maxIdx + 2 : maxIdx + 1;
}
function superWireInnerLink(wire) {
  if (!wire) return null;
  const from = nodeById(wire.from);
  const to = nodeById(wire.to);
  if (!from || !to) return null;
  if (from.kind === "super" && nodeParentSuperId(to) === from.id)
    return { super: from, child: to, dir: "out" };
  if (to.kind === "super" && nodeParentSuperId(from) === to.id)
    return { super: to, child: from, dir: "in" };
  return null;
}
/** Expanded shell on the main canvas (宿主全屏进入态自身不算壳层；其它超级节点仍可展开). */
function superIsOpenShell(n) {
  return !!(
    n &&
    n.kind === "super" &&
    n.superOpen &&
    n.id !== currentSuperFocus()
  );
}
/** If this wire should be drawn inside an open super stage, return that host. */
function wireOpenSuperHost(w, from, to) {
  from = from || (w && nodeById(w.from));
  to = to || (w && nodeById(w.to));
  if (!w || !from || !to) return null;
  const link = superWireInnerLink(w);
  if (link && superIsOpenShell(link.super)) return link.super;
  const sid = nodeParentSuperId(from);
  if (sid && sid === nodeParentSuperId(to)) {
    const host = nodeById(sid);
    if (superIsOpenShell(host)) return host;
  }
  return null;
}
function ensureSuperWiresSvg(stage) {
  if (!stage) return null;
  let svg = stage.querySelector(":scope > svg.super-wires");
  if (!svg) {
    svg = document.createElementNS(svgNS, "svg");
    svg.classList.add("super-wires");
    svg.setAttribute("aria-hidden", "true");
    const vp = stage.querySelector(":scope > .super-stage-viewport");
    if (vp) stage.insertBefore(svg, vp);
    else stage.insertBefore(svg, stage.firstChild);
  }
  const hostEl = stage.closest(".wf-node");
  const host = hostEl && nodeById(hostEl.dataset.nid);
  const fallbackW = host ? Math.max(80, superDisplaySize(host).w - 20) : 80;
  const fallbackH = host ? Math.max(120, superDisplaySize(host).h - 56) : 120;
  const w = Math.max(1, stage.clientWidth || fallbackW);
  const h = Math.max(1, stage.clientHeight || fallbackH);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  return svg;
}
function superStageLocalOut(n, fromIndex, host, pan) {
  const sz = nodeDrawSize(n);
  const hNode = Object.assign({}, n, { h: sz.h, w: sz.w });
  return {
    x: (pan.x || 0) + n.x + sz.w - PORT_OFF - NODE_BORDER,
    y: (pan.y || 0) + n.y + outPortY(hNode, fromIndex || 0) + NODE_BORDER,
  };
}
function superStageLocalIn(n, toIndex, host, pan) {
  const sz = nodeDrawSize(n);
  const hNode = Object.assign({}, n, { h: sz.h, w: sz.w });
  return {
    x: (pan.x || 0) + n.x + PORT_OFF + NODE_BORDER,
    y: (pan.y || 0) + n.y + inPortY(hNode, toIndex, inputCount(n)) + NODE_BORDER,
  };
}
function superStageHeight(host) {
  const el =
    host && document.querySelector('.wf-node[data-nid="' + host.id + '"]');
  const stage = el && el.querySelector(".super-stage");
  if (stage && stage.clientHeight > 0) return stage.clientHeight;
  const sz = superDisplaySize(host);
  /* head≈29 + 底边 resize 垫高≈14 */
  return Math.max(120, sz.h - 43);
}
function superBridgeLocalY(host, i) {
  return superInnerPortY(
    superStageHeight(host),
    i || 0,
    inputCount(host),
  );
}
function superSinkLocalY(host, i) {
  return superInnerPortY(
    superStageHeight(host),
    i || 0,
    outputCount(host),
  );
}
function superStageBridgePos(host, fromIndex, stageW) {
  return {
    x: 2 + PORT_R,
    y: superBridgeLocalY(host, fromIndex || 0),
  };
}
function superStageSinkPos(host, toIndex, stageW) {
  return {
    x: Math.max(PORT_R, (stageW || 0) - 2 - PORT_R),
    y: superSinkLocalY(host, toIndex || 0),
  };
}
/* 连线双层描边：每条连线由两条 path 组成——
   下层 .fn-edge-ring（宽描边、暗色外圈）与上层 .fn-edge（原色线芯），同路径、外圈先插入。 */
function ensureWireRing(svg, coreEl, ringId) {
  let r = document.getElementById(ringId);
  if (!r) {
    r = document.createElementNS(svgNS, "path");
    r.id = ringId;
    r.setAttribute("class", "fn-edge-ring");
    if (coreEl) svg.insertBefore(r, coreEl);
    else svg.appendChild(r);
  }
  return r;
}
/* 外圈跟随线芯：同步路径、状态类（sel/linked/类型/temp）与显隐 */
function syncRingFromCore(core) {
  if (!core) return;
  const r = document.getElementById(core.id + "-r");
  if (!r) return;
  const cls = core.getAttribute("class") || "";
  let rcls = "fn-edge-ring";
  if (cls.includes(" sel")) rcls += " sel";
  if (cls.includes(" linked")) rcls += " linked";
  if (cls.includes(" rel")) rcls += " rel";
  else if (cls.includes(" ctrl")) rcls += " ctrl";
  else if (cls.includes(" img")) rcls += " img";
  else if (cls.includes(" aud")) rcls += " aud";
  else if (cls.includes(" vid")) rcls += " vid";
  if (cls.includes(" temp")) rcls += " temp";
  r.setAttribute("class", rcls);
  r.setAttribute("d", core.getAttribute("d") || "");
  r.style.display = core.style.display || "";
}
function applyWirePathClass(p, w, from) {
  let wcls = "fn-edge";
  if (S.selWire === w.id) wcls += " sel";
  else if (linkedToSelectedNode(w)) wcls += " linked";
  if (w.rel) wcls += " rel";
  else if (wireFromIsControl(w) || isControlKind(nodeById(w.to))) wcls += " ctrl";
  else if (isImageWireFrom(from, w.fromIndex)) wcls += " img";
  else if (isAudioWireFrom(from, w.fromIndex)) wcls += " aud";
  else if (isVideoWireFrom(from, w.fromIndex)) wcls += " vid";
  if (isPinnedWire(w)) wcls += " pinned";
  p.setAttribute("class", wcls);
  /* 外圈跟随线芯状态（sel/linked/类型/temp） */
  syncRingFromCore(p);
}
/* 选中节点时，与其相连的连线高亮（.fn-edge.linked） */
function linkedToSelectedNode(w) {
  if (!w) return false;
  const set =
    S.selSet && S.selSet.size ? S.selSet : S.sel ? new Set([S.sel]) : null;
  return !!set && (set.has(w.from) || set.has(w.to));
}
function showRelWireMenu(clientX, clientY, w) {
  if (!w || !w.rel) return;
  showCtx(clientX, clientY, [
    [
      I18n.t("关系线操作"),
      [
        {
          label: I18n.t("✎ 编辑线上文字…"),
          iconKey: "mark_text",
          iconCls: "draw",
          run: () => editRelWireLabel(w),
        },
        {
          label: I18n.t("箭头方向"),
          iconKey: "mark_arrow",
          iconCls: "draw",
          submenu: [
            {
              label: I18n.t("←→ 双向"),
              run: () => setRelArrow(w, "both"),
            },
            {
              label: I18n.t("→ 正向（起点 → 终点）"),
              run: () => setRelArrow(w, "forward"),
            },
            {
              label: I18n.t("← 反向（终点 → 起点）"),
              run: () => setRelArrow(w, "backward"),
            },
            {
              label: I18n.t("— 无箭头"),
              run: () => setRelArrow(w, "none"),
            },
          ],
        },
        {
          label: I18n.t("✕ 删除关系线"),
          iconKey: "menu_cut",
          iconCls: "danger",
          cls: "ctx-danger",
          run: () => {
            pushHistory();
            removeWire(w.id);
            S.selWire = null;
            renderCanvas();
            scheduleSave(true);
            renderStatus();
          },
        },
      ],
    ],
  ]);
}
function bindWirePathInteractions(p, w) {
  if (p.dataset.bound === "1") return;
  p.dataset.bound = "1";
  p.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    clearSelection();
    S.selWire = w.id;
    renderCanvas();
  });
  if (w.rel) {
    /* 关系线：双击编辑线上文字 */
    p.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      editRelWireLabel(relWireById(w.id) || w);
    });
  }
  p.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    clearSelection();
    S.selWire = w.id;
    renderCanvas();
    if (w.rel) {
      showRelWireMenu(ev.clientX, ev.clientY, relWireById(w.id) || w);
      return;
    }
    showCtx(ev.clientX, ev.clientY, [
      [
        I18n.t("连线操作"),
        [
          {
            label: I18n.t("✕ 删除连线"),
            iconKey: "menu_cut",
            iconCls: "danger",
            cls: "ctx-danger",
            run: () => {
              if (isPinnedWire(w)) {
                toast(I18n.t("该连线已固定，无法删除"), "warn");
                return;
              }
              pushHistory();
              removeWire(w.id);
              S.selWire = null;
              renderCanvas();
              scheduleSave(true);
              renderStatus();
            },
          },
        ],
      ],
    ]);
  });
}
function updateSuperInnerWires(host, touchIds) {
  if (!superIsOpenShell(host)) return;
  const el = document.querySelector('.wf-node[data-nid="' + host.id + '"]');
  const stage = el && el.querySelector(".super-stage");
  if (!stage) return;
  const svg = ensureSuperWiresSvg(stage);
  if (!svg) return;
  const filter =
    touchIds && typeof touchIds.has === "function" && touchIds.size
      ? touchIds
      : null;
  const pan = superInnerPan(host);
  const fallbackW = Math.max(80, superDisplaySize(host).w - 20);
  const stageW = Math.max(80, stage.clientWidth || fallbackW);
  const present = new Set();
  for (const w of S.wf.wires || []) {
    if (w.rel) continue;
    const from = nodeById(w.from);
    const to = nodeById(w.to);
    if (!from || !to) continue;
    if (wireOpenSuperHost(w, from, to) !== host) continue;
    const id = "swire-" + w.id;
    present.add(id);
    present.add(id + "-r");
    if (
      filter &&
      !filter.has(w.from) &&
      !filter.has(w.to) &&
      !filter.has(host.id)
    )
      continue;
    const link = superWireInnerLink(w);
    let a;
    let b;
    if (link && link.dir === "out") {
      a = superStageBridgePos(host, w.fromIndex || 0, stageW);
      b = superStageLocalIn(to, w.toIndex, host, pan);
    } else if (link && link.dir === "in") {
      a = superStageLocalOut(from, w.fromIndex || 0, host, pan);
      b = superStageSinkPos(host, w.toIndex || 0, stageW);
    } else {
      a = superStageLocalOut(from, w.fromIndex || 0, host, pan);
      b = superStageLocalIn(to, w.toIndex, host, pan);
    }
    let p = svg.querySelector("#" + CSS.escape(id));
    if (!p) {
      ensureWireRing(svg, null, id + "-r");
      p = document.createElementNS(svgNS, "path");
      p.id = id;
      bindWirePathInteractions(p, w);
      svg.appendChild(p);
    } else {
      ensureWireRing(svg, p, id + "-r");
    }
    p.setAttribute("d", wirePathAB(a.x, a.y, b.x, b.y));
    applyWirePathClass(p, w, from);
  }
  for (const p of [...svg.querySelectorAll(":scope > path.fn-edge")]) {
    if (p.id === "swireTemp" || p.id === "swireTemp-r") continue;
    /* 关系线（rsw-*）由 renderRelWiresPass 自己管理，别当残留删掉 */
    if (p.id.indexOf("rsw-") === 0 || / rel$/.test(p.getAttribute("class") || ""))
      continue;
    if (!present.has(p.id)) p.remove();
  }
  let t = svg.querySelector("#swireTemp");
  if (!t) {
    ensureWireRing(svg, null, "swireTemp-r");
    t = document.createElementNS(svgNS, "path");
    t.id = "swireTemp";
    t.setAttribute("class", "fn-edge temp");
    svg.appendChild(t);
  }
  const d = S.drag;
  if (d && d.mode === "wire") {
    const from = nodeById(d.fromId);
    let show = false;
    let a = null;
    if (d.superInnerBridge && from && from.id === host.id) {
      a = superStageBridgePos(host, d.fromIndex || 0, stageW);
      show = true;
    } else if (from && nodeParentSuperId(from) === host.id) {
      /* 反向拖线（内部节点输入端 → 输出端/桥端子）：起点用子画布局部输入端点 */
      a = d.fromInput
        ? superStageLocalIn(from, d.fromIndex || 0, host, pan)
        : superStageLocalOut(from, d.fromIndex || 0, host, pan);
      show = true;
    }
    if (show && a) {
      /* 末端用超级舞台本地坐标，与内侧连线 SVG 同一套空间 */
      const b = clientToLocal(stage, d.mx, d.my);
      t.setAttribute("d", wirePathAB(a.x, a.y, b.x, b.y));
      let tcls = "fn-edge temp";
      if (
        isControlKind(from) ||
        (from &&
          from.kind === "super" &&
          d.superInnerBridge &&
          superInPortIsControl(from, d.fromIndex || 0))
      )
        tcls += " ctrl";
      else if (from && isImageWireFrom(from, d.fromIndex || 0)) tcls += " img";
      t.setAttribute("class", tcls);
      t.style.display = "";
      syncRingFromCore(t);
      return;
    }
  }
  if (!filter) {
    t.style.display = "none";
    syncRingFromCore(t);
  }
}
function refreshAllSuperInnerWires(touchIds) {
  for (const n of (S.wf && S.wf.nodes) || []) {
    if (!superIsOpenShell(n)) continue;
    if (
      touchIds &&
      typeof touchIds.has === "function" &&
      touchIds.size &&
      !touchIds.has(n.id) &&
      !superChildrenOf(n.id).some((c) => touchIds.has(c.id))
    )
      continue;
    updateSuperInnerWires(n, touchIds);
  }
}

function bindSuperInnerBridgePort(p, host, pi) {
  bindPortTip(p, host, "out", pi, "inner-bridge");
  p.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startWireDrag(host.id, ev, pi, { superInnerBridge: true });
  });
  p.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const ahead = (S.wf.wires || []).filter((w) => {
      if (w.from !== host.id || Number(w.fromIndex || 0) !== pi) return false;
      const to = nodeById(w.to);
      return to && nodeParentSuperId(to) === host.id;
    }).length;
    if (!ahead) {
      toast(I18n.t("该内侧输入端子没有连线"), "warn");
      return;
    }
    pushHistory();
    const rem = removeSuperInnerPortWires(host, "bridge", pi);
    clearDownstream(host.id);
    toast(I18n.t("已移除内侧输入端子连线 ") + rem + I18n.t(" 条"), "ok");
    renderCanvas();
    scheduleSave(true);
    renderStatus();
  });
}
function bindSuperInnerSinkPort(p, host, poi) {
  bindPortTip(p, host, "in", poi, "inner-sink");
  p.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const ahead = (S.wf.wires || []).filter((w) => {
      if (w.to !== host.id || Number(w.toIndex) !== poi) return false;
      const from = nodeById(w.from);
      return from && nodeParentSuperId(from) === host.id;
    }).length;
    if (!ahead) {
      toast(I18n.t("该内侧输出端子没有连线"), "warn");
      return;
    }
    pushHistory();
    const rem = removeSuperInnerPortWires(host, "sink", poi);
    clearDownstream(host.id);
    toast(I18n.t("已移除内侧输出端子连线 ") + rem + I18n.t(" 条"), "ok");
    renderCanvas();
    scheduleSave(true);
    renderStatus();
  });
}
/** 展开壳层：在 viewport 内直接挂载子节点与标注（避免两阶段查找失败） */
function fillSuperShellViewport(viewport, hostId) {
  if (!viewport || !hostId) return;
  const kids = superChildrenOf(hostId).filter((c) => !isSuperIoNode(c));
  for (const c of kids) {
    mountNodeEl(viewport, c);
  }
  for (const m of marksOf()) {
    if (markParentSuperId(m) !== hostId) continue;
    viewport.appendChild(markElement(m));
  }
}
function clearSuperFocusPorts() {
  const layer = document.getElementById("superFocusPortLayer");
  if (layer) layer.remove();
  const stage = $("#stage");
  if (stage) {
    stage
      .querySelectorAll(":scope > .super-focus-port")
      .forEach((el) => el.remove());
  }
}
/** 全屏进入态：端子钉在画布可视区左右边缘（不随舞台平移） */
function mountSuperFocusPorts(host) {
  clearSuperFocusPorts();
  if (!host || host.kind !== "super" || currentSuperFocus() !== host.id) return;
  const canvas = $("#canvas");
  if (!canvas) return;
  const layer = document.createElement("div");
  layer.id = "superFocusPortLayer";
  layer.className = "super-focus-port-layer";
  const h = Math.max(120, canvas.clientHeight || 400);
  const ic = inputCount(host);
  for (let pi = 0; pi < ic; pi++) {
    const p = document.createElement("div");
    const info = superInnerPortInfo(host, "in", pi);
    p.className =
      "port out super-port super-inner-bridge super-focus-port" +
      (info.ctrl ? " ctrl" : "") +
      (info.img ? " img" : "");
    p.dataset.node = host.id;
    p.dataset.fromIndex = String(pi);
    p.title = info.title;
    if (info.badge) {
      const b = document.createElement("span");
      b.className = "port-badge zh-label";
      b.textContent = info.badge;
      p.appendChild(b);
    }
    p.style.top = superInnerPortY(h, pi, ic) - PORT_R + "px";
    bindSuperInnerBridgePort(p, host, pi);
    layer.appendChild(p);
  }
  const oc = outputCount(host);
  for (let poi = 0; poi < oc; poi++) {
    const p = document.createElement("div");
    const info = superInnerPortInfo(host, "out", poi);
    p.className =
      "port in super-port super-inner-sink super-focus-port" +
      (info.ctrl ? " ctrl" : "") +
      (info.img ? " img" : "");
    p.dataset.node = host.id;
    p.dataset.idx = String(poi);
    p.title = info.title;
    if (info.badge) {
      const b = document.createElement("span");
      b.className = "port-badge zh-label";
      b.textContent = info.badge;
      p.appendChild(b);
    }
    p.style.top = superInnerPortY(h, poi, oc) - PORT_R + "px";
    bindSuperInnerSinkPort(p, host, poi);
    layer.appendChild(p);
  }
  canvas.appendChild(layer);
}
function refreshSuperFocusPortLayout() {
  const host = nodeById(currentSuperFocus());
  const layer = document.getElementById("superFocusPortLayer");
  if (!host || host.kind !== "super" || !layer) return;
  const canvas = $("#canvas");
  const h = Math.max(120, (canvas && canvas.clientHeight) || 400);
  const ic = inputCount(host);
  const oc = outputCount(host);
  layer.querySelectorAll(".super-inner-bridge").forEach((p) => {
    const pi = Number(p.dataset.fromIndex || 0);
    p.style.top = superInnerPortY(h, pi, ic) - PORT_R + "px";
  });
  layer.querySelectorAll(".super-inner-sink").forEach((p) => {
    const poi = Number(p.dataset.idx || 0);
    p.style.top = superInnerPortY(h, poi, oc) - PORT_R + "px";
  });
}

function findSuperAtWorld(x, y, exceptIds, requireOpen) {
  const skip = exceptIds || new Set();
  let best = null;
  let bestArea = Infinity;
  for (const n of (S.wf && S.wf.nodes) || []) {
    if (!n || n.kind !== "super") continue;
    if (skip.has(n.id)) continue;
    if (nodeParentTaskId(n) !== currentTaskFocus()) continue;
    if (currentSuperFocus()) continue;
    if (requireOpen && !n.superOpen) continue;
    /* 嵌套超级节点仅在祖先链均展开时可见可投 */
    if (nodeParentSuperId(n) && !nodeInCurrentScope(n)) continue;
    const wp = nodeWorldPos(n);
    const sz =
      superIsOpenShell(n)
        ? superDisplaySize(n)
        : { w: n.w || 280, h: n.h || 200 };
    const o = superInnerOrigin(n);
    const x0 = wp.x + (superIsOpenShell(n) ? o.ox : 8);
    const y0 = wp.y + (superIsOpenShell(n) ? o.oy : 36);
    const x1 = wp.x + sz.w - 8;
    const y1 = wp.y + sz.h - 10;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      const area = sz.w * sz.h;
      if (area < bestArea) {
        best = n;
        bestArea = area;
      }
    }
  }
  return best;
}
let _superHoverExpandBackup = null;
function restoreSuperHoverExpand() {
  if (!_superHoverExpandBackup) return;
  const n = nodeById(_superHoverExpandBackup.id);
  if (n && !_superHoverExpandBackup.wasOpen) n.superOpen = false;
  _superHoverExpandBackup = null;
}
function updateSuperHoverExpand(ev, dragIds) {
  if (currentSuperFocus()) return;
  const d = S.drag;
  if (!d || d.mode !== "node" || !d.moved) {
    clearSuperDropHot();
    return;
  }
  const pt = toStage(ev.clientX, ev.clientY);
  const skip = new Set(dragIds || d.ids || []);
  let host =
    findOpenSuperAtWorld(pt.x, pt.y, skip) ||
    findSuperAtWorld(pt.x, pt.y, skip, false);
  if (host && !host.superOpen) {
    if (
      !_superHoverExpandBackup ||
      _superHoverExpandBackup.id !== host.id
    ) {
      restoreSuperHoverExpand();
      _superHoverExpandBackup = { id: host.id, wasOpen: false };
      host.superOpen = true;
      renderCanvas();
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const dx = (ev.clientX - d.sx) / z;
      const dy = (ev.clientY - d.sy) / z;
      applyNodeDragVisual(d, dx, dy);
    }
    host = nodeById(host.id);
  }
  clearSuperDropHot();
  if (!host) return;
  const el = document.querySelector('.wf-node[data-nid="' + host.id + '"]');
  if (el) el.classList.add("super-drop-hot");
  const stage = el && el.querySelector(".super-stage");
  if (stage) stage.classList.add("super-drop-hot");
}
function clearSuperDropHot(keepExpanded) {
  document
    .querySelectorAll(".super-stage.super-drop-hot, .wf-node.super.super-drop-hot")
    .forEach((el) => el.classList.remove("super-drop-hot"));
  if (keepExpanded === true) {
    _superHoverExpandBackup = null;
  } else if (keepExpanded === false) {
    restoreSuperHoverExpand();
  }
}
function toggleSuperOpen(node, open) {
  if (!node || node.kind !== "super") return;
  /* 若正处在该节点的全屏进入态，先退出再展开壳层 */
  if (currentSuperFocus() === node.id) {
    resetSuperFocus();
  }
  const visuallyOpen = superIsOpenShell(node);
  const next = open === undefined ? !visuallyOpen : !!open;
  pushHistory();
  node.superOpen = next;
  if (next) {
    node.expandW = Math.max(320, Number(node.expandW) || 720);
    node.expandH = Math.max(220, Number(node.expandH) || 480);
    alignSuperContentTopLeft(node);
    /* 展开后按内容撑开：否则壳层固定 720×480，子节点与关系线会被裁掉 */
    fitSuperShellToContent(node);
  }
  scheduleSave(true);
  renderCanvas();
}
/** 将超级节点内部平移到内容包围盒左上对齐（少量边距） */
function alignSuperContentTopLeft(superNode) {
  if (!superNode || superNode.kind !== "super") return;
  const PAD = 16;
  let minX = Infinity;
  let minY = Infinity;
  let any = false;
  for (const n of superChildrenOf(superNode.id)) {
    if (isSuperIoNode(n)) continue;
    any = true;
    minX = Math.min(minX, Number(n.x) || 0);
    minY = Math.min(minY, Number(n.y) || 0);
  }
  for (const m of marksOf()) {
    if (markParentSuperId(m) !== superNode.id) continue;
    const b = markBounds(m);
    if (!b) continue;
    any = true;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
  }
  if (!any) {
    superNode.innerPanX = 0;
    superNode.innerPanY = 0;
    return;
  }
  superNode.innerPanX = PAD - minX;
  superNode.innerPanY = PAD - minY;
}
/** 展开壳层按内部内容（含标注）真实范围撑开，避免子节点与关系线被裁掉。
   排版 / 细化 / 拖入子节点后调用；只放大不缩小（缩壳交给用户手动 resize）。 */
function fitSuperShellToContent(superNode, opts) {
  opts = opts || {};
  if (!superNode || superNode.kind !== "super") return false;
  const PAD = 18;
  const PORT = 26; /* 右侧端子排留位 */
  const HEAD = 43; /* head ≈29 + 底部 resize 垫高 ≈14 */
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    any = false;
  for (const n of superChildrenOf(superNode.id)) {
    if (isSuperIoNode(n)) continue;
    const sz = nodeDrawSize(n);
    any = true;
    minX = Math.min(minX, Number(n.x) || 0);
    minY = Math.min(minY, Number(n.y) || 0);
    maxX = Math.max(maxX, (Number(n.x) || 0) + sz.w);
    maxY = Math.max(maxY, (Number(n.y) || 0) + sz.h);
  }
  for (const m of marksOf()) {
    if (markParentSuperId(m) !== superNode.id) continue;
    const b = markBounds(m);
    if (!b) continue;
    any = true;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!any) return false;
  /* 内部平移后的可见范围 */
  const panX = Number(superNode.innerPanX) || 0;
  const panY = Number(superNode.innerPanY) || 0;
  const needW = Math.ceil(maxX - minX + PAD * 2 + PORT);
  const needH = Math.ceil(maxY - minY + PAD * 2 + HEAD);
  const haveW = Math.max(320, Number(superNode.expandW) || 720);
  const haveH = Math.max(220, Number(superNode.expandH) || 480);
  const nextW = opts.shrink ? Math.max(320, needW) : Math.max(haveW, needW);
  const nextH = opts.shrink ? Math.max(220, needH) : Math.max(haveH, needH);
  let changed = false;
  if (nextW !== haveW) {
    superNode.expandW = nextW;
    changed = true;
  }
  if (nextH !== haveH) {
    superNode.expandH = nextH;
    changed = true;
  }
  if (changed && (minX + panX < 0 || minY + panY < 0)) {
    alignSuperContentTopLeft(superNode);
  }
  return changed;
}
/** 所有展开壳层按内容撑开（排版 / 批量创建 / 收纳节点后调用） */
function fitAllOpenSuperShells(opts) {
  if (!S.wf) return 0;
  let n = 0;
  const list = (S.wf.nodes || []).filter(
    (x) => x.kind === "super" && superIsOpenShell(x),
  );
  /* 由内向外：内层撑开后外层才量得准 */
  list.sort((a, b) => superNestDepth(b) - superNestDepth(a));
  for (const s of list) if (fitSuperShellToContent(s, opts)) n++;
  return n;
}
function nodeIsNestedInOpenSuper(n) {
  if (!n) return false;
  const sid = nodeParentSuperId(n);
  if (!sid) return false;
  /* 全屏进入的宿主用主画布展示子节点，不走壳层内嵌 */
  if (sid === currentSuperFocus()) return false;
  const host = nodeById(sid);
  return !!(host && host.kind === "super" && host.superOpen);
}
/** 祖先超级节点 id 是否包含 ancestorId（含自身） */
function isSuperAncestorOf(ancestorId, nodeId) {
  if (!ancestorId || !nodeId) return false;
  let sid = nodeId;
  const seen = new Set();
  while (sid && !seen.has(sid)) {
    if (sid === ancestorId) return true;
    seen.add(sid);
    const n = nodeById(sid);
    sid = n ? nodeParentSuperId(n) : "";
  }
  return false;
}
function canMoveNodeIntoSuper(host, n) {
  if (!host || host.kind !== "super" || !n) return false;
  if (host.id === n.id || isSuperIoNode(n)) return false;
  /* 不可把节点收进自己的子孙超级节点（会成环） */
  if (n.kind === "super" && isSuperAncestorOf(n.id, host.id)) return false;
  return true;
}
function superNestDepth(n) {
  let d = 0;
  let sid = nodeParentSuperId(n);
  const seen = new Set();
  while (sid && !seen.has(sid)) {
    seen.add(sid);
    d++;
    const h = nodeById(sid);
    sid = h ? nodeParentSuperId(h) : "";
  }
  return d;
}
function nodeWorldPos(n, _seen) {
  if (!n) return { x: 0, y: 0 };
  if (!nodeIsNestedInOpenSuper(n)) return { x: n.x, y: n.y };
  const seen = _seen || new Set();
  if (seen.has(n.id)) return { x: n.x, y: n.y };
  seen.add(n.id);
  const host = nodeById(n.parentSuperId);
  if (!host) return { x: n.x, y: n.y };
  const o = superInnerOrigin(host);
  const pan = superInnerPan(host);
  const hw = nodeWorldPos(host, seen);
  return {
    x: hw.x + o.ox + pan.x + n.x,
    y: hw.y + o.oy + pan.y + n.y,
  };
}
function nodeDrawSize(n) {
  if (!n) return { w: 240, h: 160 };
  if (n.kind === "super") return superDisplaySize(n);
  return { w: n.w || 240, h: n.h || 160 };
}
function normalizeSuperSubFolder(raw) {
  return String(raw || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}
function superRelPrefixFor(node) {
  const parts = [];
  let sid = node && node.parentSuperId;
  const seen = new Set();
  while (sid && !seen.has(sid)) {
    seen.add(sid);
    const host = nodeById(sid);
    if (!host) break;
    const sf = normalizeSuperSubFolder(host.subFolder);
    if (sf) parts.unshift(sf);
    sid = host.parentSuperId;
  }
  return parts.join("/");
}
/** 相对路径挂到祖先超级节点 subFolder 下；绝对路径或已含前缀则不改 */
function applySuperRelToPath(node, p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  if (isAbsPath(raw)) return raw;
  const norm = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const prefix = superRelPrefixFor(node);
  if (!prefix) return norm;
  if (norm === prefix || norm.startsWith(prefix + "/")) return norm;
  return prefix + "/" + norm.replace(/^\/+/, "");
}
/** 节点落入超级节点后：把相对保存/输出/监视路径改写到 subFolder 下 */
function rewriteNodePathsForSuperContext(node) {
  if (!node || !superRelPrefixFor(node)) return;
  if (isSaveNode(node) && String(node.savePath || "").trim()) {
    node.savePath = applySuperRelToPath(
      node,
      preferRelativeSavePath(node.savePath),
    );
    applySavePathExt(node);
  }
  if (
    (node.kind === "music_gen" ||
      node.kind === "tts_gen" ||
      node.kind === "video_gen" ||
      node.kind === "remotion") &&
    String(node.outputPath || "").trim()
  ) {
    node.outputPath = applySuperRelToPath(
      node,
      preferRelativeSavePath(node.outputPath),
    );
  }
  if (node.kind === "wait_file" && String(node.waitPath || "").trim()) {
    node.waitPath = applySuperRelToPath(
      node,
      preferRelativeSavePath(node.waitPath),
    );
  }
}
function findOpenSuperAtWorld(x, y, exceptIds) {
  const skip = exceptIds || new Set();
  let best = null;
  let bestArea = Infinity;
  for (const n of (S.wf && S.wf.nodes) || []) {
    if (!n || n.kind !== "super" || !n.superOpen) continue;
    if (skip.has(n.id)) continue;
    if (nodeParentTaskId(n) !== currentTaskFocus()) continue;
    if (currentSuperFocus()) continue;
    if (nodeParentSuperId(n) && !nodeInCurrentScope(n)) continue;
    const wp = nodeWorldPos(n);
    const sz = superDisplaySize(n);
    const o = superInnerOrigin(n);
    const x0 = wp.x + o.ox;
    const y0 = wp.y + o.oy;
    const x1 = wp.x + sz.w - 8;
    const y1 = wp.y + sz.h - 10;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      const area = sz.w * sz.h;
      if (area < bestArea) {
        best = n;
        bestArea = area;
      }
    }
  }
  return best;
}
/** 该世界坐标落点会归属哪个超级壳层（展开壳优先，其次卡片范围）—— makeNode 与
    子画布右键菜单共用同一判定，保证「菜单里列出的入口」与「实际落点层级」不漂移。
    工具节点（super + tool:true）同样算壳层。 */
function superHostAtWorld(x, y) {
  if (x == null || y == null) return null;
  return (
    findOpenSuperAtWorld(x, y) || findSuperAtWorld(x, y, new Set(), false)
  );
}
function promptSuperSubFolder(node) {
  if (!node || node.kind !== "super") return;
  openOverlay(I18n.t("超级节点子文件夹"), { persistent: true });
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = I18n.t(
    "设置后，此超级节点内部节点的相对路径会落在「工作目录 / 子文件夹」下；内部已有相对路径会自动补上该前缀。",
  );
  body.appendChild(hint);
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("子文件夹（相对工作目录）")));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "assets/batch-a";
  inp.value = String(node.subFolder || "");
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("确定");
  ok.onclick = () => {
    pushHistory();
    node.subFolder = normalizeSuperSubFolder(inp.value);
    for (const c of (S.wf.nodes || [])) {
      if (!c || c.id === node.id) continue;
      if (!isSuperAncestorOf(node.id, c.id)) continue;
      rewriteNodePathsForSuperContext(c);
    }
    closeOverlay();
    scheduleSave(true);
    renderCanvas();
    toast(
      node.subFolder
        ? I18n.t("子文件夹已设为：") + node.subFolder
        : I18n.t("已清除子文件夹"),
      "ok",
    );
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  setTimeout(() => inp.focus(), 0);
}
/** 超级节点描述（文件夹标题下方的小字）：点头部「描述」按钮编辑 */
function promptSuperNote(node) {
  if (!node || node.kind !== "super") return;
  openOverlay(I18n.t("超级节点描述"), { persistent: true });
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = I18n.t(
    "描述会以小字显示在超级节点「文件夹」标题下方；文字过多时自动截断，鼠标悬停可查看全文。留空则不显示。",
  );
  body.appendChild(hint);
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("描述内容")));
  const ta = document.createElement("textarea");
  ta.className = "n-text";
  ta.spellcheck = false;
  ta.rows = 5;
  ta.style.width = "100%";
  ta.style.minHeight = "104px";
  ta.style.resize = "vertical";
  ta.style.fontFamily = "var(--font, inherit)";
  ta.placeholder = I18n.t("描述此超级节点收纳的内容与用途…");
  ta.value = String(node.note || "");
  lab.appendChild(ta);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("确定");
  ok.onclick = () => {
    pushHistory();
    node.note = ta.value;
    closeOverlay();
    scheduleSave(true);
    renderCanvas();
    toast(
      String(node.note || "").trim()
        ? I18n.t("描述已更新")
        : I18n.t("已清除描述"),
      "ok",
    );
  };
  const clear = document.createElement("button");
  clear.className = "mini";
  clear.textContent = I18n.t("清空");
  clear.onclick = () => {
    ta.value = "";
    ta.focus();
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(clear);
  foot.appendChild(ok);
  setTimeout(() => ta.focus(), 0);
}
function wireKeepsSuperBoundary(w) {
  const from = nodeById(w && w.from);
  const to = nodeById(w && w.to);
  if (!from || !to) return false;
  if (from.kind === "super" && nodeParentSuperId(to) === from.id) return true;
  if (to.kind === "super" && nodeParentSuperId(from) === to.id) return true;
  return nodeParentSuperId(from) === nodeParentSuperId(to);
}
function pruneInvalidSuperBoundaryWires() {
  if (!S.wf || !Array.isArray(S.wf.wires)) return 0;
  const before = S.wf.wires.length;
  S.wf.wires = S.wf.wires.filter((w) => wireKeepsSuperBoundary(w));
  return before - S.wf.wires.length;
}
function finalizeNodeDragNest(ids, curWorld) {
  if (currentSuperFocus()) return false;
  const skipHosts = new Set();
  for (const id of ids || []) {
    const n = nodeById(id);
    if (n && n.kind === "super") skipHosts.add(id);
  }
  const list = [];
  for (const id of ids || []) {
    const n = nodeById(id);
    if (!n || isSuperIoNode(n)) continue;
    list.push(n);
  }
  if (!list.length) return false;
  let changed = false;
  for (const n of list) {
    const sz = nodeDrawSize(n);
    let wx;
    let wy;
    if (curWorld && curWorld[n.id]) {
      wx = curWorld[n.id].x;
      wy = curWorld[n.id].y;
    } else {
      const wp = nodeWorldPos(n);
      wx = wp.x;
      wy = wp.y;
    }
    const cx = wx + sz.w / 2;
    const cy = wy + sz.h / 2;
    let host = findOpenSuperAtWorld(cx, cy, skipHosts);
    if (host && !canMoveNodeIntoSuper(host, n)) host = null;
    const cur = nodeParentSuperId(n);
    if (host) {
      const o = superInnerOrigin(host);
      const pan = superInnerPan(host);
      const hwp = nodeWorldPos(host);
      const nx = snap(wx - hwp.x - o.ox - pan.x);
      const ny = snap(wy - hwp.y - o.oy - pan.y);
      if (host.id !== cur || n.x !== nx || n.y !== ny) {
        n.parentSuperId = host.id;
        n.parentTaskId = host.parentTaskId || "";
        n.x = nx;
        n.y = ny;
        changed = true;
      }
    } else if (cur) {
      const host0 = nodeById(cur);
      n.parentSuperId = "";
      n.parentTaskId = host0 ? host0.parentTaskId || "" : currentTaskFocus();
      n.x = snap(wx);
      n.y = snap(wy);
      changed = true;
    }
  }
  if (changed) pruneInvalidSuperBoundaryWires();
  return changed;
}
function taskChildTasksOf(id) {
  return taskChildrenOf(id).filter((n) => n.kind === "task");
}
function ctrlRoleOf(n) {
  return n && n.kind === "control" ? String(n.ctrlRole || "") : "";
}
function isExecStart(n) {
  return ctrlRoleOf(n) === "start";
}
function isExecEnd(n) {
  const r = ctrlRoleOf(n);
  return r === "endSuccess" || r === "endFail";
}
function isPinnedCtrl(n) {
  return !!(n && n.kind === "control" && n.ctrlPinned);
}
function isSaveKind(kind) {
  return kind === "save" || kind === "save_text" || kind === "save_image";
}
function isSaveNode(n) {
  return !!(n && isSaveKind(n.kind));
}
function isPinnedWire(w) {
  return !!(w && w.pinned);
}
const BOUND_SAVE_GAP = 48;
const SAVE_EXT = { text: ".yaml", image: ".png", audio: ".wav", video: ".mp4" };
function saveExtForMedia(media) {
  return SAVE_EXT[media] || SAVE_EXT.text;
}
function forcePathExt(p, ext) {
  const s = String(p || "").trim();
  let e = String(ext || "").trim() || ".yaml";
  if (!e.startsWith(".")) e = "." + e;
  if (!s) return e;
  const cur = extOf(s);
  if (cur) return s.slice(0, -cur.length) + e;
  return s + e;
}
function stemOfFilename(name) {
  return String(name || "")
    .trim()
    .replace(/\.(ya?ml|png|jpe?g|webp|gif|wav|flac|mp3|mp4|webm|mov)$/i, "");
}
function dirOfPath(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(0, i) : "";
}
/* ── 媒体端子值：路径 ⇄ file:/// URL 的成对换算（音视频节点输出的唯一口径）──
   对外（画布端子值、@引用、保存与下游展示）给 URL；真正把文件交给后端
   （H3 参考图/参考视频/参考音频、保存节点复制源）必须先归一回本机绝对路径，
   否则 fs.existsSync / fileCopyAssetTo 拿到 "file:///E:/…" 一律判为文件不存在。
   非 URL 的字符串原样返回，所以归一函数可以无脑套在任何取数口上。 */
function pathFromMediaUrl(u) {
  const s = String(u || "").trim();
  if (!s || !/^file:\/\//i.test(s)) return s;
  let p = "";
  try {
    const url = new URL(s);
    p = decodeURIComponent(url.pathname || "");
    /* UNC：file://host/share/x → \\host\share\x */
    if (url.hostname && url.hostname !== "localhost")
      return "\\\\" + url.hostname + "\\" + p.replace(/^[\\/]+/, "").replace(/\//g, "\\");
  } catch {
    p = s.replace(/^file:\/\/+/i, "");
  }
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); /* /E:/a.wav → E:/a.wav */
  if (/^[a-zA-Z]:/.test(p)) p = p.replace(/\//g, "\\"); /* 仅 Windows 盘符路径才翻斜杠 */
  return p;
}
/** 端子值（或裸字符串）→ 本机绝对路径：path 优先，回落 url / text 里的 file URL。 */
function pathFromMediaValue(v) {
  if (!v) return "";
  if (typeof v === "string") return pathFromMediaUrl(v);
  const p = String(v.path || "").trim();
  if (p) return pathFromMediaUrl(p);
  const u = String(v.url || "").trim();
  if (u) return pathFromMediaUrl(u);
  return pathFromMediaUrl(String(v.text || "").trim());
}
/* 本机路径 → file:/// URL。渲染层统一走 preload 的 toFileUrl（Node pathToFileURL，
   中文 / 空格自动百分号编码）；没有桥的环境（测试沙箱）用等价回退，口径不变。 */
function mediaFileUrlOf(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (/^file:\/\//i.test(s)) return s;
  try {
    if (typeof window !== "undefined" && window.api && window.api.toFileUrl) {
      const u = String(window.api.toFileUrl(s) || "");
      if (u) return u;
    }
  } catch {}
  const abs = s.replace(/\\/g, "/");
  const body = /^[a-zA-Z]:\//.test(abs) ? abs : abs.replace(/^\/+/, "");
  /* 按段百分号编码；盘符冒号是合法路径字符，编码后要还原（与 pathToFileURL 同口径） */
  return (
    "file:///" +
    body
      .split("/")
      .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
      .join("/")
  );
}
/** 音视频输入节点的端子值：{ kind, path（本机绝对路径）, url, text = url }；未选文件 = 未就绪 → null。 */
function mediaInputValueOf(node) {
  const p = String((node && node.mediaAsset) || "").trim();
  if (!p) return null;
  const kind = node.kind === "input_video" ? "video" : "audio";
  const url = mediaFileUrlOf(p);
  return { kind, path: p, url, text: url };
}
/* ═════ 素材节点（kind "asset"）：素材库内容条目 = 该节点的端子 ═════
   判定与数端子的口径只写在这一处，app-canvas.js（端子 / body）、
   app-nodes.js（连线校验）一律调过来，不再各写一套。
   · 节点上只存绑定（assetId + 相对素材库根目录的 assetRel）与条目快照 items；
   · 一个条目 = 第 i 个输入端子 ↔ 第 i 个输出端子（无控制端子、不参与控制流）；
   · 端子标题 = 条目标题，端子类型 = 条目类型（text|image|audio|video）。 */
const ASSET_ITEM_TYPES = { text: 1, image: 1, audio: 1, video: 1 };
function isAssetNode(n) {
  return !!(n && n.kind === "asset");
}
/** 条目快照（端子唯一真源）：字段缺失就地兜底，不回写节点数据。 */
function assetItems(n) {
  const raw = n && Array.isArray(n.items) ? n.items : [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] || {};
    out.push({
      id: String(it.id || ""),
      title: String(it.title || "").trim() || I18n.t("内容 ") + (i + 1),
      type: ASSET_ITEM_TYPES[String(it.type)] ? String(it.type) : "text",
    });
  }
  return out;
}
/** 素材节点端子号 → 内容类型；非素材节点 / 越界 → null（调用方回落旧口径）。
    输入与输出同一数法，与工具 / 函数节点的 fnToolPortKind 扮演同一角色。 */
function assetPortKind(node, dir, idx) {
  if (!isAssetNode(node)) return null;
  const items = assetItems(node);
  const i = Number(idx);
  if (!isFinite(i) || i < 0 || i >= items.length) return null;
  return items[i].type;
}
/** 端子准入：条目类型必须与来源端子类型一致。写盘按类型落扩展名，
    混填等于把散文写进 .wav —— 宁可让用户改接，也不静默污染库文件。 */
function assetPortAccepts(itemType, mediaType) {
  return !!itemType && itemType === mediaType;
}
/** 素材节点第 idx 个条目端子上现有的那条数据线（无则 null）。
    一个条目只挂一条数据线（不是数组端子），控制线不算占用。 */
function assetInWireAt(node, idx) {
  if (!node || !S.wf || !Array.isArray(S.wf.wires)) return null;
  const i = Number(idx);
  return (
    S.wf.wires.find(
      (w) =>
        !w.rel &&
        w.to === node.id &&
        Number(w.toIndex) === i &&
        !wireFromIsControl(w),
    ) || null
  );
}
function assetInPortOccupied(node, idx) {
  return !!assetInWireAt(node, idx);
}
/** 一条来自 (from, fromIndex) 的数据线该落到哪个条目端子：
    第一个「类型匹配且空闲」的条目，挑不到返回 null（由调用方给点名式错误）。
    拖线自动落点与 connectError 校验共用这一个函数 —— 校验的端子必须与落地的端子同一个。 */
function assetFreeInPortIndex(node, from, fromIndex) {
  if (!isAssetNode(node)) return null;
  const items = assetItems(node);
  const want = wireSourceMediaType(from, fromIndex);
  for (let i = 0; i < items.length; i++) {
    if (assetInPortOccupied(node, i)) continue;
    if (assetPortAccepts(items[i].type, want)) return i;
  }
  return null;
}
/** 条目类型短名（端子 tooltip 与 body 类型徽标共用） */
function assetItemTypeLabel(type) {
  const k = ASSET_ITEM_TYPES[String(type)] ? String(type) : "text";
  return I18n.t(
    k === "text" ? "文本" : k === "image" ? "图像" : k === "audio" ? "音频" : "视频",
  );
}
/** 条目集合签名：判断「端子集」有没有变（id + 标题 + 类型，顺序也算） */
function assetSigOfItems(items) {
  return (items || [])
    .map((it) => String(it.id || "") + "\u0000" + it.title + "\u0000" + it.type)
    .join("\u0001");
}
/** 新旧条目集的端子映射：perm[旧序号] = 新序号，-1 = 新条目集里已经没有这一项。
    两趟配对，先认身份再认名字：
      ① item id 相同 —— 库里改名 / 重排，身份没变，线跟着条目走（改名不甩线）；
      ② 标题相同 —— 重绑成另一个素材，只有名字对得上的条目保留连线。
    同名重复条目按出现顺序一一对应，不会两条线挤到同一个端子上。 */
function assetItemPerm(oldItems, newItems) {
  const used = new Set();
  const perm = new Array((oldItems || []).length).fill(-1);
  const byId = new Map();
  (newItems || []).forEach((it, i) => {
    if (it.id && !byId.has(String(it.id))) byId.set(String(it.id), i);
  });
  (oldItems || []).forEach((it, i) => {
    if (!it.id) return;
    const j = byId.get(String(it.id));
    if (j != null && !used.has(j)) {
      perm[i] = j;
      used.add(j);
    }
  });
  const byTitle = new Map();
  (newItems || []).forEach((it, i) => {
    if (used.has(i)) return;
    const k = String(it.title || "").trim().toLowerCase();
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(i);
  });
  (oldItems || []).forEach((it, i) => {
    if (perm[i] >= 0) return;
    const q = byTitle.get(String(it.title || "").trim().toLowerCase());
    if (!q || !q.length) return;
    perm[i] = q.shift();
    used.add(perm[i]);
  });
  return perm;
}
/** 端子号随条目变了 → 该节点两侧的数据线按 perm 一起搬；perm[i] = -1 的线断开。
    关系线（不占端子）与别的节点的线一律不动。返回 {moved, dropped}。
    调用方负责先 pushHistory —— 断线是可撤销的，不是静默丢数据。 */
function assetRemapItemWires(node, perm) {
  const res = { moved: 0, dropped: 0 };
  if (!node || !S.wf || !Array.isArray(S.wf.wires)) return res;
  const keep = [];
  for (const w of S.wf.wires) {
    if (!w || w.rel) {
      keep.push(w);
      continue;
    }
    let drop = false;
    if (w.from === node.id) {
      const i = Number(w.fromIndex || 0);
      const j = perm[i];
      if (j == null || j < 0) drop = true;
      else if (j !== i) {
        w.fromIndex = j;
        res.moved++;
      }
    }
    if (!drop && w.to === node.id) {
      const i = Number(w.toIndex || 0);
      const j = perm[i];
      if (j == null || j < 0) drop = true;
      else if (j !== i) {
        w.toIndex = j;
        res.moved++;
      }
    }
    if (drop) res.dropped++;
    else keep.push(w);
  }
  S.wf.wires = keep;
  return res;
}
/** 条目重排的 perm 口径：与 fnToolMoveParam 里那段循环逐字同一套数法
    （perm[旧序号] = 新序号：把 from 移到 to，中间元素顺移一格；原地 / 越界 → null）。
    素材侧只此一个数法，不另发明一套 —— 库里的新条目顺序 = 这个 perm 作用在旧顺序上，
    画布一侧再由 assetItemPerm（先认 id）得到同一个 perm 去搬端子号与连线。 */
function assetMovePerm(n, from, to) {
  const N = Number(n);
  const f = Number(from);
  const t = Number(to);
  if (!isFinite(N) || N <= 0) return null;
  if (!isFinite(f) || f < 0 || f >= N) return null;
  if (!isFinite(t) || t < 0 || t >= N) return null;
  if (f === t) return null;
  const perm = [];
  for (let i = 0; i < N; i++) {
    if (i === f) perm[i] = t;
    else if (f < t && i > f && i <= t) perm[i] = i - 1;
    else if (f > t && i >= t && i < f) perm[i] = i + 1;
    else perm[i] = i;
  }
  return perm;
}
/** 按同一 perm 把条目数组搬成新顺序：返回 { list, perm }，位置非法返回 null。 */
function assetMoveItem(list, from, to) {
  const arr = Array.isArray(list) ? list : [];
  const perm = assetMovePerm(arr.length, from, to);
  if (!perm) return null;
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[perm[i]] = arr[i];
  return { list: out, perm: perm };
}
/** 绑定 / 重绑的唯一写入口：把素材库摘要写进节点。内容实体永远在库，节点上只有
    assetId + 相对根目录的 assetRel + 端子快照 items（不存绝对路径 → 换盘后按 id 重定位）。
    端子号按 assetItemPerm 保号，对不上的连线断开。调用方一律先 pushHistory。
    参数不合法返回 null（不碰节点）。 */
function assetBindNode(node, summary) {
  if (!isAssetNode(node) || !summary || !String(summary.id || "").trim())
    return null;
  const oldItems = assetItems(node);
  const oldAssetId = String(node.assetId || "");
  node.assetId = String(summary.id);
  node.assetRel = String(summary.rel || "");
  node.assetName = String(summary.displayName || summary.folder || "");
  node.assetDesc = String(summary.desc || "");
  /* 快照走 assetItems 同一份归一（空标题→「内容 N」、野类型→text）：
     库里读回来的形状与节点上存的形状从此只有这一个口径 */
  node.items = assetItems(summary).map((it) => ({
    id: it.id,
    title: it.title,
    type: it.type,
  }));
  const r = assetRemapItemWires(node, assetItemPerm(oldItems, assetItems(node)));
  r.oldAssetId = oldAssetId;
  return r;
}
/* ── 素材节点取值（引擎侧唯一入口）─────────────────────────────────────
 * 内容实体恒在素材库，节点上只有绑定（assetId / assetRel）与条目快照，所以端子值
 * 只有两个来源：① 素材库最近一次扫描的摘要（每条带 absPath / bytes / missing ——
 * 媒体端子不必逐条读盘就有值）；② 渲染层向库发过一次读取后缓存下来的正文
 * （文本条目只能靠它，app-assets.js · ASSET_ITEM_VIEW）。
 * 输出形状与既有静态源逐字同口径：文本 → {kind:"text",text}；
 * 图像 / 音频 / 视频 → {kind,path,url,text=url}（与 mediaInputValueOf 同一形状，
 * 下游 proc_image / video_gen / music_gen 的媒体端子直接可用）。 */
/** 条目在库摘要里的那一项（没扫过 / 库里没这条 → null） */
function assetItemSummary(node, itemId) {
  if (!node || !itemId) return null;
  if (typeof assetSummaryById !== "function") return null;
  const a = assetSummaryById(node.assetId);
  if (!a || !Array.isArray(a.items)) return null;
  for (const it of a.items)
    if (it && String(it.id) === String(itemId)) return it;
  return null;
}
/** 条目实体文件的绝对路径（缓存优先，其次库摘要）；库里没有 / 文件缺失 → "" */
function assetItemAbsPath(node, it) {
  if (!node || !it) return "";
  const cached =
    typeof assetItemViewGet === "function" &&
    assetItemViewGet(node.assetId, it.id);
  if (cached && !cached.missing && String(cached.absPath || ""))
    return String(cached.absPath);
  const s = assetItemSummary(node, it.id);
  if (!s || s.missing) return "";
  return String(s.absPath || "");
}
/** 素材节点第 idx 个输出端子的值。库里内容还没读到时返回 null（＝端子未就绪，
 *  下游按「无输入」处理），同时把读取发出去 —— 到货后 body 会自己重画。 */
function assetItemValueOf(node, idx) {
  if (!isAssetNode(node)) return null;
  const items = assetItems(node);
  const i = Number(idx);
  if (!isFinite(i) || i < 0 || i >= items.length) return null;
  const it = items[i];
  if (!String(node.assetId || "").trim() || !it.id) return null;
  if (typeof assetNodeIsLost === "function" && assetNodeIsLost(node)) return null;
  const sum = assetItemSummary(node, it.id);
  if (it.type === "text") {
    const cached =
      typeof assetItemViewGet === "function" &&
      assetItemViewGet(node.assetId, it.id);
    /* 只认库里那份（savedText）：body 里正在输入还没失焦的草稿不算内容 */
    if (cached && typeof cached.savedText === "string")
      return { kind: "text", text: cached.savedText };
    if (typeof assetItemViewLoad === "function")
      assetItemViewLoad(node.assetId, it.id);
    /* 库里明确是 0 字节 ＝ 这条确实还没内容：给空串，别报「未就绪」 */
    if (sum && !sum.missing && !Number(sum.bytes))
      return { kind: "text", text: "" };
    return null;
  }
  const p = assetItemAbsPath(node, it);
  if (!p) {
    if (typeof assetItemViewLoad === "function")
      assetItemViewLoad(node.assetId, it.id);
    return null;
  }
  const url = mediaFileUrlOf(p);
  return { kind: it.type, path: p, url: url, text: url };
}
/** 本机文件路径 / file:/// URL 两种写法都收（图像端子存绝对路径，音视频端子存 URL） */
function assetLocalPathOfValue(v) {
  if (!v) return "";
  const raw =
    String(v.path || "").trim() ||
    (typeof v.text === "string" && /^file:\/\//i.test(v.text)
      ? String(v.text).trim()
      : "");
  if (!raw) return "";
  if (/^file:\/\//i.test(raw)) return fileUrlToPath(raw);
  if (typeof isAbsPath === "function" && isAbsPath(raw)) return raw;
  if (typeof absImagePathOf === "function") return absImagePathOf(raw);
  return raw;
}
/** 素材节点第 idx 个输入端子「连进来」的值，归一成写库用的形状：
 *  文本 → {kind:"text",text}；媒体 → {kind:<条目类型>,path:<本机绝对路径>}。
 *  没连线 / 上游此刻没值 → null（同步与提示都以此为准，不猜）。 */
function assetPortInboundValue(node, idx) {
  const items = assetItems(node);
  const i = Number(idx);
  if (!isAssetNode(node) || !isFinite(i) || i < 0 || i >= items.length)
    return null;
  const w = assetInWireAt(node, i);
  if (!w) return null;
  const src = nodeById(w.from);
  if (!src) return null;
  const v = valueForInput(src, Number(w.fromIndex || 0), node);
  if (!v) return null;
  const type = items[i].type;
  if (type === "text") {
    if (v.kind === "text") return { kind: "text", text: String(v.text || "") };
    const p = assetLocalPathOfValue(v);
    return p ? { kind: "text", text: p } : null;
  }
  const p = assetLocalPathOfValue(v);
  return p ? { kind: type, path: p } : null;
}
/** 素材节点对外可读内容（@引用 / 下游预览口径）：一条 = 一条内容。
 *  只有一条时摊平成 {text} / {image}，多条按类型分组，与合并节点同一形状。 */
function assetDisplayValueOf(node) {
  const items = assetItems(node);
  const texts = [];
  const images = [];
  let one = null;
  let got = 0;
  for (let i = 0; i < items.length; i++) {
    const v = assetItemValueOf(node, i);
    if (!v) continue;
    got++;
    one = { it: items[i], v: v };
    if (v.kind === "text")
      texts.push({ title: items[i].title, content: String(v.text || "") });
    else if (v.kind === "image")
      images.push({ title: items[i].title, path: v.path });
    else texts.push({ title: items[i].title, content: String(v.url || v.text || "") });
  }
  if (!got) return null;
  if (items.length === 1 && one)
    return one.v.kind === "image"
      ? { image: one.v.path, title: one.it.title }
      : { text: String(one.v.text || "") };
  if (texts.length && images.length) return { items: texts, images: images };
  if (texts.length) return { items: texts };
  return { images: images };
}
/* 来源节点这条线的媒体类型（不含端子声明的那一层，见 wireSourceMediaType）。
   工具 / 函数节点按真正接出来的那个端子取实际值判断，其余节点仍只看 0 号端子（行为逐字不变）。 */
function inferMediaFromSource(from, fromIndex) {
  if (!from) return "text";
  if (from.kind === "music_gen" || from.kind === "tts_gen") return "audio";
  if (from.kind === "video_gen" || from.kind === "remotion") return "video";
  if (from.kind === "input_image" || from.kind === "proc_image") return "image";
  /* 音视频输入节点：输出的就是这个本机文件（值见 mediaInputValueOf），按文件类型判定 */
  if (from.kind === "input_audio") return "audio";
  if (from.kind === "input_video") return "video";
  if (from.kind === "split" || from.kind === "merge") {
    const v = valueForInput(from, 0);
    if (v && v.kind === "image") return "image";
    if (v && v.kind === "audio") return "audio";
    if (v && v.kind === "video") return "video";
  }
  /* 工具 / 函数节点：按真正接出来的那个端子取值；普通节点仍只看 0 号端子 */
  const v = valueForInput(
    from,
    isFnToolNode(from) ? Number(fromIndex || 0) : 0,
  );
  if (v && v.kind === "image") return "image";
  if (v && v.kind === "audio") return "audio";
  if (v && v.kind === "video") return "video";
  if (v && (v.kind === "text" || v.text)) {
    const t = String((v.path || v.text) || "").trim();
    if (/\.(mp4|webm|mov)$/i.test(t)) return "video";
    if (/\.(wav|flac|mp3)$/i.test(t)) return "audio";
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(t)) return "image";
  }
  return "text";
}
function saveDataLinks(node) {
  if (!node || !S.wf) return [];
  const out = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src || isControlKind(src)) continue;
    out.push({ src: src, fromIndex: Number(w.fromIndex || 0) });
  }
  return out;
}
function saveDataSources(node) {
  return saveDataLinks(node).map((l) => l.src);
}
/** 来源节点「某个输出端子」流向下游的媒体类型（单一真源）。
    ⓪ 素材节点：条目类型就是该端子的声明类型（text|image|audio|video，不看实际值 ——
       库里的图像条目即使还没读出内容也仍是图像端子）；
    ① 工具 / 函数节点：以该端子声明的数据类型为准（参数 kind ∈ text | image，声明优先于实际值，
       控制端子无声明 → 回落 ②）；② 其余节点 / 未声明时：按节点 kind 与该端子实际值推断。
    保存节点自动选型、连线校验、连线着色、拖线建节点候选菜单都走这里。 */
function wireSourceMediaType(node, fromIndex) {
  if (isAssetNode(node)) return assetPortKind(node, "out", fromIndex) || "text";
  const declared = fnToolPortKind(node, "out", fromIndex);
  if (declared) return declared === "image" ? "image" : "text";
  return inferMediaFromSource(node, fromIndex);
}
function saveMediaKind(node) {
  if (!node) return "text";
  if (node.boundFromId) {
    const g = nodeById(node.boundFromId);
    if (g && g.kind === "music_gen") return "audio";
    if (g && (g.kind === "video_gen" || g.kind === "remotion")) return "video";
  }
  const links = saveDataLinks(node);
  if (!links.length) {
    if (!links.length && node.legacySaveMedia) return node.legacySaveMedia;
    if (node.kind === "save_image") return "image";
    if (node.kind === "save_text") return "text";
    const p = String(node.savePath || node.savedPath || "");
    if (/\.png$/i.test(p)) return "image";
    if (/\.(wav|flac|mp3)$/i.test(p)) return "audio";
    if (/\.mp4$/i.test(p)) return "video";
    return "text";
  }
  for (const l of links) {
    const m = wireSourceMediaType(l.src, l.fromIndex);
    if (m !== "text") return m;
  }
  return "text";
}
function boundSaveOf(gen) {
  if (!gen || !gen.boundSaveId) return null;
  const n = nodeById(gen.boundSaveId);
  return isSaveNode(n) ? n : null;
}
function mediaGenOfBoundSave(sv) {
  if (!sv || !sv.boundFromId) return null;
  const n = nodeById(sv.boundFromId);
  return isMediaGenNode(n) ? n : null;
}
function applySavePathExt(node) {
  if (!isSaveNode(node)) return;
  const ext = saveExtForMedia(saveMediaKind(node));
  const raw = String(node.savePath || "").trim();
  if (!raw) return;
  node.savePath = applySuperRelToPath(
    node,
    preferRelativeSavePath(forcePathExt(raw, ext)),
  );
}
/** Combine node.outputPath (+ optional filename) into one file path string. */
function mediaGenOutputRaw(node) {
  if (!node) return "";
  const raw = String(node.outputPath || "").trim();
  const fn = String(node.filename || "").trim();
  if (!raw && !fn) return "";
  if (!raw) return fileName(fn);
  const base = fileName(raw);
  const hasFileExt = /\.(wav|flac|mp3|mp4|webm|mov)$/i.test(base);
  if (fn && !hasFileExt) {
    return raw.replace(/[\\/]+$/, "") + "/" + fileName(fn);
  }
  return raw;
}
function mediaGenExt(node) {
  if (node && node.kind === "tts_gen")
    return String(node.ttsFormat || "").toLowerCase() === "mp3" ? ".mp3" : ".wav";
  return saveExtForMedia(
    node && (node.kind === "video_gen" || node.kind === "remotion")
      ? "video"
      : "audio",
  );
}
/**
 * Resolve music/video export to { ok, outputDir, filename, path }.
 * Path must be set on the node (no bound save). Relative paths need workspace.
 */
function resolveMediaGenExport(node) {
  const ext = mediaGenExt(node);
  const combined = mediaGenOutputRaw(node);
  if (!combined) return { ok: false, code: "empty", outputDir: "", filename: "" };
  /* Legacy default "output" without a real filename → treat as unset */
  if (/^output$/i.test(combined.replace(/\\/g, "/").replace(/^\.\//, ""))) {
    return { ok: false, code: "empty", outputDir: "", filename: "" };
  }
  const forced = forcePathExt(combined, ext);
  const r = resolveSavePath(forced, node);
  if (!r.ok) return { ok: false, code: r.code || "empty", outputDir: "", filename: "" };
  const pth = forcePathExt(r.path, ext);
  const dir = dirOfPath(pth);
  return {
    ok: true,
    outputDir: dir || ".",
    filename: fileName(pth),
    path: pth,
  };
}
function requireMediaGenExport(node, quiet) {
  const exp = resolveMediaGenExport(node);
  if (exp && exp.ok) return exp;
  const msg = savePathResolveError(exp && exp.code);
  if (!quiet) toast(msg, "warn");
  if (node) {
    if (node.kind === "music_gen") node.musicStatus = msg;
    if (node.kind === "tts_gen") node.ttsStatus = msg;
    if (node.kind === "video_gen") node.videoStatus = msg;
    if (node.kind === "remotion") node.remotionStatus = msg;
  }
  return null;
}
async function pathExistsAbs(p) {
  const abs = String(p || "").trim();
  if (!abs) return false;
  try {
    return !!(window.api && window.api.fileExists && (await window.api.fileExists(abs)));
  } catch {
    return false;
  }
}
/** If preferred file exists, allocate stem_1 / stem_2 … to avoid overwrite. */
async function allocateUniqueMediaExport(exp) {
  if (!exp || !exp.ok) return exp;
  const dir = String(exp.outputDir || "").trim() || ".";
  let name = String(exp.filename || "").trim();
  if (!name) name = "out" + (exp.path && /\.mp4$/i.test(exp.path) ? ".mp4" : ".wav");
  const ext = extOf(name) || (/\.mp4$/i.test(name) ? ".mp4" : ".wav");
  const stem = stemOfFilename(name) || "out";
  let candidate = joinPath(dir, name);
  if (!(await pathExistsAbs(candidate))) {
    return Object.assign({}, exp, { path: candidate, filename: name });
  }
  for (let i = 1; i < 10000; i++) {
    const fn = stem + "_" + i + ext;
    candidate = joinPath(dir, fn);
    if (!(await pathExistsAbs(candidate))) {
      return Object.assign({}, exp, {
        path: candidate,
        filename: fn,
        renamed: true,
        baseFilename: name,
      });
    }
  }
  return Object.assign({}, exp, { ok: false, code: "empty" });
}
function mediaGenRollSuffix(rollIndex) {
  return "_" + String(rollIndex).padStart(2, "0");
}
/** Multi-roll export: stem_01.ext … stem_10.ext (single roll keeps configured name). */
function resolveMediaGenRollExport(node, rollIndex, totalRolls) {
  const exp = resolveMediaGenExport(node);
  if (!exp || !exp.ok) return exp;
  if (totalRolls <= 1) return exp;
  const ext = extOf(exp.filename) || mediaGenExt(node);
  const stem = stemOfFilename(exp.filename) || "out";
  const fn = stem + mediaGenRollSuffix(rollIndex) + ext;
  return Object.assign({}, exp, {
    filename: fn,
    path: joinPath(exp.outputDir, fn),
  });
}
async function prepareMediaGenRollExport(node, rollIndex, totalRolls) {
  let exp = resolveMediaGenRollExport(node, rollIndex, totalRolls);
  if (!exp || !exp.ok) return null;
  if (totalRolls <= 1 && rollIndex === 1) {
    exp = await allocateUniqueMediaExport(exp);
    if (!exp || !exp.ok) return null;
  }
  return exp;
}
function formatGenElapsed(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const bits = [];
  if (h) bits.push(h + I18n.t(" 时"));
  if (m) bits.push(m + I18n.t(" 分"));
  if (s || !bits.length) bits.push(s + I18n.t(" 秒"));
  return bits.join("");
}
function mediaGenDoneMsg(elapsedMs) {
  return I18n.t("完成") + " · " + formatGenElapsed(elapsedMs);
}
async function fetchMediaGenLock() {
  if (!window.api) return null;
  const fn =
    window.api.mediaGenGetLock ||
    window.api.music3GetLock ||
    window.api.h3GetLock;
  if (!fn) return null;
  try {
    const r = await fn();
    return r && r.lock ? r.lock : null;
  } catch {
    return null;
  }
}
function mediaGenLockBusyMsg(lock) {
  const other = lock && lock.nodeId ? nodeById(lock.nodeId) : null;
  const name = (other && other.title) || (lock && lock.nodeId) || "?";
  return I18n.t("已有音视频生成任务进行中（全局仅 1 个，禁止并行）：") + name;
}
function mediaGenRollProgressTag(node) {
  const nRolls = attemptCount(node);
  if (nRolls <= 1 || !node.running) return "";
  const cur = Math.min(nRolls, Math.max(1, (node.genRollDone || 0) + 1));
  return cur + "/" + nRolls + " · ";
}
async function resolveMediaGenActionPath(node) {
  const display = await resolveMediaGenDisplayPath(node);
  if (display) return display;
  const exp = resolveMediaGenExport(node);
  return (exp && exp.ok && exp.path) || "";
}
/** Last output if present on disk, else configured path if file exists. */
async function resolveMediaGenDisplayPath(node) {
  if (!node) return "";
  const out = (node.output && (node.output.path || node.output.text)) || "";
  if (out && (await pathExistsAbs(out))) return out;
  const exp = resolveMediaGenExport(node);
  if (exp && exp.ok && exp.path && (await pathExistsAbs(exp.path))) return exp.path;
  return "";
}
/** Remove legacy media↔save pairs; migrate savePath → outputPath, then delete the save node. */
function detachBoundMediaSaves(wf) {
  wf = wf || S.wf;
  if (!wf || !Array.isArray(wf.nodes)) return;
  const removeIds = new Set();
  for (const gen of wf.nodes) {
    if (!isMediaGenNode(gen)) continue;
    let sv =
      (gen.boundSaveId && wf.nodes.find((n) => n.id === gen.boundSaveId)) ||
      wf.nodes.find((n) => isSaveNode(n) && n.boundFromId === gen.id) ||
      null;
    if (!sv) {
      const pinned = (wf.wires || []).find((w) => {
        if (w.from !== gen.id || !w.pinned) return false;
        const t = wf.nodes.find((n) => n.id === w.to);
        return t && isSaveNode(t);
      });
      if (pinned) sv = wf.nodes.find((n) => n.id === pinned.to) || null;
    }
    if (sv) {
      const sp = String(sv.savePath || "").trim();
      const cur = mediaGenOutputRaw(gen);
      if (sp && (!cur || /^output$/i.test(cur))) {
        gen.outputPath = preferRelativeSavePath(
          forcePathExt(sp, mediaGenExt(gen)),
        );
        gen.filename = "";
      }
      removeIds.add(sv.id);
    }
    gen.boundSaveId = "";
  }
  for (const n of wf.nodes) {
    if (!isSaveNode(n) || !n.boundFromId) continue;
    const g = wf.nodes.find((x) => x.id === n.boundFromId);
    if (g && isMediaGenNode(g)) {
      const sp = String(n.savePath || "").trim();
      const cur = mediaGenOutputRaw(g);
      if (sp && (!cur || /^output$/i.test(cur))) {
        g.outputPath = preferRelativeSavePath(
          forcePathExt(sp, mediaGenExt(g)),
        );
        g.filename = "";
      }
      g.boundSaveId = "";
      removeIds.add(n.id);
    }
    n.boundFromId = "";
  }
  if (!removeIds.size) return;
  wf.wires = (wf.wires || []).filter(
    (w) => !removeIds.has(w.from) && !removeIds.has(w.to),
  );
  wf.nodes = wf.nodes.filter((n) => !removeIds.has(n.id));
  for (const g of wf.groups || []) {
    if (!g || !Array.isArray(g.nodeIds)) continue;
    g.nodeIds = g.nodeIds.filter((id) => !removeIds.has(id));
  }
  if (typeof S !== "undefined" && S) {
    if (S.selSet) for (const id of removeIds) S.selSet.delete(id);
    if (S.sel && removeIds.has(S.sel)) S.sel = null;
  }
}
function expandBoundPairIds(ids) {
  /* Bound media-save pairing removed; keep identity for callers. */
  return [...(ids || [])];
}
function snapBoundSaves() {
  /* no-op: media gens no longer drag a paired save node */
}
function syncGenFilenameFromSave() {
  /* no-op: media gens no longer mirror a bound save path */
}
function placeBoundSave() {
  /* no-op */
}
function syncBoundSaveFilename() {
  /* no-op */
}
function ensureBoundSaveForMedia() {
  /* no-op: media gens use in-node outputPath */
  return null;
}
function outputCount(n) {
  if (!n) return 0;
  if (n.kind === "global") return 0;
  if (isSaveNode(n)) return 0;
  if (isExecEnd(n)) return 0;
  if (n.kind === "execute") return 0; /* 执行节点：独立工具 · 无输出 */
  /* 素材节点：输出端子 = 内容条目（第 i 出 = 第 i 个条目的内容），无控制输出端子 */
  if (n.kind === "asset") return assetItems(n).length;
  /* 音频 / 视频输入：各 1 个数据输出端子，值是该本机文件的 file:/// URL（见 mediaInputValueOf） */
  if (n.kind === "input_audio" || n.kind === "input_video") return 1;
  /* 函数 / 工具节点：输出 0..n-1 = 各输出参数（数据），末位 = 控制输出（固定 1 控制出） */
  if (isFnToolNode(n)) return fnToolParamList(n, "out").length + 1;
  if (n.kind === "super") {
    const open = superIsOpenShell(n);
    const ext = superExternalOutWiresAll(n);
    const intF = superInternalOutFeedsAll(n);
    const maxFrom = ext.reduce(
      (m, w) => Math.max(m, Number(w.fromIndex) || 0),
      -1,
    );
    const maxTo = intF.reduce((m, w) => Math.max(m, Number(w.toIndex) || 0), -1);
    /* 收起时外部输出仅在内部有汇入时出现；展开时保留可连接的内侧槽 */
    const maxIdx = open ? Math.max(maxFrom, maxTo) : maxTo;
    return superDynamicPortCount(maxIdx, open);
  }
  if (n.kind === "judge" || n.kind === "task") return 2;
  if (n.kind === "net_recv") return 2; /* 端口0=信息输出(数据) · 端口1=控制输出 */
  if (n.kind === "net_send") return 0; /* 发送无输出（末端） */
  /* 音乐 / 语音 / 视频 / Remotion：端口0=内容输出(数据) · 端口1=控制输出（完成后触发下游控制目标） */
  if (
    n.kind === "music_gen" ||
    n.kind === "tts_gen" ||
    n.kind === "video_gen" ||
    n.kind === "remotion"
  )
    return 2;
  if (n.kind === "sequencer")
    return Math.max(2, Math.min(8, Math.round(Number(n.seqOutputs) || 3)));
  if (n.kind === "splitter")
    return Math.max(2, Math.min(8, Math.round(Number(n.splitOutputs) || 3)));
  return 1;
}
function uniqueTitleInWf(wf, desired) {
  const base = String(desired || I18n.t("节点")).trim() || I18n.t("节点");
  const taken = new Set(((wf && wf.nodes) || []).map((n) => n.title));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + " " + i)) i++;
  return base + " " + i;
}
function ensureTaskScaffold(task, wf) {
  wf = wf || S.wf;
  if (!task || task.kind !== "task" || !wf) return;
  if (!Array.isArray(wf.nodes)) wf.nodes = [];
  const kids = wf.nodes.filter((n) => n.parentTaskId === task.id);
  const mk = (role, x, y, title) => {
    const d = NODE_DEFAULTS.control;
    const node = {
      id: uid("n"),
      kind: "control",
      x: snap(x),
      y: snap(y),
      w: 180,
      h: 96,
    };
    for (const [k, v] of Object.entries(d)) {
      if (k === "w" || k === "h") continue;
      node[k] = JSON.parse(JSON.stringify(v));
    }
    node.parentTaskId = task.id;
    node.ctrlRole = role;
    node.ctrlPinned = true;
    node.ctrlAction = "run";
    node.title = uniqueTitleInWf(wf, I18n.t(title));
    wf.nodes.push(node);
    return node;
  };
  if (!kids.some(isExecStart)) mk("start", 48, 96, "起点");
  if (!kids.some((n) => ctrlRoleOf(n) === "endSuccess"))
    mk("endSuccess", 520, 48, "成功终点");
  if (!kids.some((n) => ctrlRoleOf(n) === "endFail"))
    mk("endFail", 520, 200, "失败终点");
}
function taskStartOf(taskId, wf) {
  wf = wf || S.wf;
  return (
    ((wf && wf.nodes) || []).find(
      (n) => n.parentTaskId === taskId && isExecStart(n),
    ) || null
  );
}
function taskDescendantIds(taskId, wf) {
  wf = wf || S.wf;
  const out = [];
  const q = [taskId];
  const seen = new Set();
  while (q.length) {
    const id = q.shift();
    for (const n of (wf && wf.nodes) || []) {
      if (n.parentTaskId !== id || seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n.id);
      if (n.kind === "task") q.push(n.id);
    }
  }
  return out;
}
function normalizeTaskSteps(node) {
  if (!node || node.kind !== "task") return;
  if (!Array.isArray(node.steps)) node.steps = [];
  for (const s of node.steps) {
    if (!s || typeof s !== "object") continue;
    if (!s.id) s.id = uid("ts");
    if (typeof s.title !== "string") s.title = "";
    s.done = !!s.done;
  }
  node.steps = node.steps.filter((s) => s && typeof s === "object");
  if (typeof node.goal !== "string") node.goal = "";
  if (!node.taskStatus) node.taskStatus = "pending";
  if (typeof node.parentTaskId !== "string") node.parentTaskId = "";
}
function taskAncestorChain(taskId) {
  const chain = [];
  const seen = new Set();
  let id = taskId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const n = nodeById(id);
    if (!n || n.kind !== "task") break;
    chain.unshift(n);
    id = n.parentTaskId || "";
  }
  return chain;
}
function resetTaskFocus() {
  S.taskFocus = "";
  S.taskStack = [];
  resetSuperFocus();
  renderTaskCrumb();
}
function setTaskFocus(taskId, opts) {
  opts = opts || {};
  const id = taskId || "";
  if (id) {
    const n = nodeById(id);
    if (!n || n.kind !== "task") return;
    S.taskFocus = id;
    S.taskStack = taskAncestorChain(id).map((x) => x.id);
  } else {
    S.taskFocus = "";
    S.taskStack = [];
  }
  S.sel = null;
  if (S.selSet) S.selSet.clear();
  S.selWire = null;
  S.selGroup = null;
  renderTaskCrumb();
  if (opts.render !== false) {
    renderCanvas();
    renderStatus();
  }
}
function tidyLayoutScope(nodes, opts) {
  opts = opts || {};
  const list = (nodes || []).filter(Boolean);
  if (!list.length) return { ok: false, nodes: 0 };
  if (opts.history && !S._skipCanvasHistory) pushHistory();
  const ids = new Set(list.map((n) => n.id));
  const wires = ((S.wf && S.wf.wires) || []).filter(
    (w) => ids.has(w.from) && ids.has(w.to),
  );
  for (const n of list) sizeNodeForTidy(n);
  const origin = opts.origin || { x: snap(48), y: snap(48) };
  layoutFlowEx(list, wires, origin, [], {
    gapX: opts.gapX != null ? opts.gapX : 80,
    gapY: opts.gapY != null ? opts.gapY : 48,
    prioritizeEditable: true,
  });
  if (opts.fit !== false) fitNodes(list);
  if (opts.render !== false) {
    renderCanvas();
    if (opts.save !== false) scheduleSave(true);
  }
  return { ok: true, nodes: list.length };
}
function enterTask(node, opts) {
  opts = opts || {};
  if (!node || node.kind !== "task") return;
  setTaskFocus(node.id, { render: false });
  const kids = taskChildrenOf(node.id);
  if (kids.length) {
    tidyLayoutScope(kids, {
      history: false,
      fit: true,
      render: false,
      save: false,
      origin: { x: snap(48), y: snap(48) },
    });
  }
  renderCanvas();
  renderStatus();
  if (opts.toast !== false)
    toast(I18n.t("已进入任务：") + (node.title || I18n.t("任务")), "ok");
}
function leaveTask() {
  const stack = S.taskStack || [];
  if (!stack.length) {
    resetTaskFocus();
    renderCanvas();
    renderStatus();
    return;
  }
  stack.pop();
  const prev = stack[stack.length - 1] || "";
  setTaskFocus(prev);
}

function resetSuperFocus() {
  S.superFocus = "";
  S.superStack = [];
  renderTaskCrumb();
}
function setSuperFocus(superId, opts) {
  opts = opts || {};
  const id = superId || "";
  if (id) {
    const n = nodeById(id);
    if (!n || n.kind !== "super") return;
    S.superFocus = id;
    const stack = [];
    let cur = n;
    while (cur && cur.kind === "super") {
      stack.unshift(cur.id);
      cur = nodeById(cur.parentSuperId);
    }
    S.superStack = stack;
  } else {
    S.superFocus = "";
    S.superStack = [];
  }
  S.sel = null;
  if (S.selSet) S.selSet.clear();
  S.selWire = null;
  S.selGroup = null;
  renderTaskCrumb();
  if (opts.render !== false) {
    renderCanvas();
    renderStatus();
  }
}
function enterSuper(node, opts) {
  opts = opts || {};
  if (!node || node.kind !== "super") return;
  /* 进入完整画布时收起壳层展开态，避免与 focus 模式叠套 */
  node.superOpen = false;
  setSuperFocus(node.id, { render: false });
  const kids = superChildrenOf(node.id).filter((c) => !isSuperIoNode(c));
  renderCanvas();
  renderStatus();
  if (kids.length) fitNodes(kids);
  else fitCanvas();
  if (opts.toast !== false)
    toast(I18n.t("已进入超级节点：") + (node.title || I18n.t("超级节点")), "ok");
}
function leaveSuper() {
  const stack = S.superStack || [];
  if (!stack.length) {
    resetSuperFocus();
    renderCanvas();
    renderStatus();
    return;
  }
  stack.pop();
  const prev = stack[stack.length - 1] || "";
  setSuperFocus(prev);
}
function ensureSuperIoPorts(_superNode, _wf) {
  /* no-op: super_io proxy nodes removed; edge ports only */
}
function externalValueIntoSuper(superNode, index, seen) {
  if (!superNode) return null;
  const i = Number(index) || 0;
  /* 工具节点被 Agent 工具调用（func call）时：模型入参按端子序号优先注入。
     node._agentCallArgs = 长度 (入参数+1) 的值数组，索引 0 = 控制入（置 null），
     参数 i 在索引 i+1（契约见 docs/tool-function-nodes.md §2）；元素为
     {kind,text|path} 或 null。由渲染层 app-tools.js 在执行前设置、执行后清除，
     只对本次调用生效，不落盘。 */
  const callArgs = superNode._agentCallArgs;
  let value; /* undefined = 注入点没覆盖这个端子，仍走外侧连线取数 */
  let fromArgs = false;
  if (callArgs && Array.isArray(callArgs) && i < callArgs.length) {
    fromArgs = true;
    value = callArgs[i] === undefined ? null : callArgs[i];
  }
  if (value === undefined) {
    const w = superExternalInWires(superNode).find(
      (x) => Number(x.toIndex) === Number(index),
    );
    if (!w) return normFnToolPortValue(superNode, "in", i, null).value;
    /* consumer 用本超级节点：嵌套时上游若也是超级节点，才能走其外侧输入通道 */
    value = valueForInput(
      nodeById(w.from),
      Number(w.fromIndex || 0),
      superNode,
      seen,
    );
  }
  /* 端子声明类型 ↔ 实际值对齐（唯一归一处 normPortValueByKind）：
     工具 / 函数节点按本端子声明归一，普通超级节点无声明 → 原样（行为逐字不变）。
     注入点（Agent func call / 「测试」台）按 loose 口径：参数类型是定义里写明的，
     字符串一律视作路径；连线取数只认带图像扩展名的路径文本，不把散文臆造成图像。 */
  return normFnToolPortValue(superNode, "in", i, value, { loose: fromArgs })
    .value;
}
function valueForSuperOutput(superNode, index, seen) {
  if (!superNode) return null;
  const w = superInternalOutFeeds(superNode).find(
    (x) => Number(x.toIndex) === Number(index),
  );
  let v = null;
  if (w) {
    /* consumer 用汇入子节点，避免把超级节点自身当成 consumer 误走输出通道 */
    const ch = nodeById(w.from);
    v = valueForInput(ch, Number(w.fromIndex || 0), ch, seen);
  }
  /* 工具节点的外侧输出端子是壳内实际值的「申报口径」：下游（保存节点 / 函数入参）
     必须拿到与该端子声明同形状的值，否则声明类型形同虚设。普通超级节点没有端子
     声明（fnToolPortKind 返回 null）→ 原样返回，取数链路逐字不变。 */
  return normFnToolPortValue(superNode, "out", index, v).value;
}
/** 沿连线取值：源为超级节点时用 fromIndex，并以 consumer 区分内外通道 */
function valueFromWire(w, consumer, batchIdx, seen) {
  if (!w) return null;
  const src = nodeById(w.from);
  if (!src) return null;
  const idx =
    isSuperLikeNode(src)
      ? Number(w.fromIndex || 0)
      : batchIdx == null
        ? 0
        : batchIdx;
  return valueForInput(src, idx, consumer || null, seen);
}
function superPortIdxFromWire(src, w) {
  if (!src || !isSuperLikeNode(src) || !w) return undefined;
  return Number(w.fromIndex || 0);
}
/** 移除超级节点某一内侧端子上的连线（桥接 / 汇流） */
function removeSuperInnerPortWires(superNode, dir, index) {
  if (!superNode || !S.wf) return 0;
  const idx = Number(index || 0);
  const before = (S.wf.wires || []).length;
  if (dir === "bridge") {
    S.wf.wires = (S.wf.wires || []).filter((w) => {
      if (w.from !== superNode.id || Number(w.fromIndex || 0) !== idx)
        return true;
      const to = nodeById(w.to);
      return !(to && nodeParentSuperId(to) === superNode.id);
    });
  } else if (dir === "sink") {
    S.wf.wires = (S.wf.wires || []).filter((w) => {
      if (w.to !== superNode.id || Number(w.toIndex) !== idx) return true;
      const from = nodeById(w.from);
      return !(from && nodeParentSuperId(from) === superNode.id);
    });
  }
  return before - (S.wf.wires || []).length;
}
function moveNodesIntoSuper(superNode, nodes) {
  if (!superNode || superNode.kind !== "super") return 0;
  const list = (nodes || []).filter((n) => canMoveNodeIntoSuper(superNode, n));
  if (!list.length) return 0;
  pushHistory();
  const open = superIsOpenShell(superNode);
  const o = superInnerOrigin(superNode);
  let minX = Infinity,
    minY = Infinity;
  for (const n of list) {
    const wp = nodeWorldPos(n);
    minX = Math.min(minX, wp.x);
    minY = Math.min(minY, wp.y);
  }
  for (const n of list) {
    const wp = nodeWorldPos(n);
    n.parentSuperId = superNode.id;
    n.parentTaskId = superNode.parentTaskId || "";
    if (open) {
      const pan = superInnerPan(superNode);
      const hwp = nodeWorldPos(superNode);
      n.x = snap(Math.max(8, wp.x - hwp.x - o.ox - pan.x));
      n.y = snap(Math.max(8, wp.y - hwp.y - o.oy - pan.y));
    } else {
      n.x = snap(Math.max(160, wp.x - minX + 160));
      n.y = snap(Math.max(48, wp.y - minY + 48));
    }
    rewriteNodePathsForSuperContext(n);
  }
  pruneInvalidSuperBoundaryWires();
  scheduleSave(true);
  return list.length;
}
function moveNodesOutOfSuper(nodes) {
  const list = (nodes || []).filter((n) => n && nodeParentSuperId(n) && !isSuperIoNode(n));
  if (!list.length) return 0;
  pushHistory();
  for (const n of list) {
    const host = nodeById(n.parentSuperId);
    const wp = nodeWorldPos(n);
    n.parentSuperId = "";
    n.parentTaskId = host ? host.parentTaskId || "" : currentTaskFocus();
    n.x = snap(wp.x);
    n.y = snap(wp.y);
  }
  pruneInvalidSuperBoundaryWires();
  scheduleSave(true);
  return list.length;
}
/** 框选合并：新建展开超级节点，外框覆盖选区（类似组框），并把选中节点收纳进去 */
function wrapSelectionAsSuper() {
  const raw = selNodes().filter((n) => n && !isSuperIoNode(n));
  if (!raw.length) {
    toast(I18n.t("请先框选 / 选中要合并的节点"), "warn");
    return null;
  }
  const parents = new Set(raw.map((n) => nodeParentSuperId(n) || ""));
  if (parents.size > 1) {
    toast(I18n.t("请选择同一层级内的节点（不能跨超级节点边界）"), "warn");
    return null;
  }
  const commonParent = [...parents][0] || "";
  const selIds = new Set(raw.map((n) => n.id));
  /* 若同时选中了某超级节点及其内部子节点，只收纳顶层选中项 */
  const list = raw.filter((n) => {
    let sid = nodeParentSuperId(n);
    const seen = new Set();
    while (sid && !seen.has(sid)) {
      if (selIds.has(sid)) return false;
      seen.add(sid);
      const h = nodeById(sid);
      sid = h ? nodeParentSuperId(h) : "";
    }
    return true;
  });
  if (!list.length) {
    toast(I18n.t("请先框选 / 选中要合并的节点"), "warn");
    return null;
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of list) {
    const wp = nodeWorldPos(n);
    const sz = nodeDrawSize(n);
    minX = Math.min(minX, wp.x);
    minY = Math.min(minY, wp.y);
    maxX = Math.max(maxX, wp.x + sz.w);
    maxY = Math.max(maxY, wp.y + sz.h);
  }
  if (!Number.isFinite(minX)) {
    toast(I18n.t("请先框选 / 选中要合并的节点"), "warn");
    return null;
  }
  const PAD = GROUP_PAD;
  const HEAD = 29;
  const worldX = snap(minX - PAD);
  const worldY = snap(minY - HEAD - PAD);
  const expandW = Math.max(320, Math.ceil(maxX - minX + PAD * 2));
  const expandH = Math.max(220, Math.ceil(maxY - minY + HEAD + PAD * 2));

  pushHistory();
  const d = NODE_DEFAULTS.super;
  const host = {
    id: uid("n"),
    kind: "super",
    x: worldX,
    y: worldY,
    w: d.w,
    h: d.h,
  };
  for (const [k, v] of Object.entries(d)) {
    if (k === "w" || k === "h") continue;
    host[k] = JSON.parse(JSON.stringify(v));
  }
  host.title = uniqueNodeTitle(I18n.t("超节点"));
  host.superOpen = true;
  host.expandW = expandW;
  host.expandH = expandH;
  host.innerPanX = 0;
  host.innerPanY = 0;
  host.note = "";
  host.parentTaskId = currentTaskFocus();
  host.parentSuperId = commonParent;
  if (commonParent) {
    const p = nodeById(commonParent);
    host.parentTaskId = p ? p.parentTaskId || "" : currentTaskFocus();
    const o = superInnerOrigin(p);
    const pan = superInnerPan(p);
    const pwp = nodeWorldPos(p);
    host.x = snap(worldX - pwp.x - o.ox - pan.x);
    host.y = snap(worldY - pwp.y - o.oy - pan.y);
  }
  S.wf.nodes.push(host);

  const ox = 0;
  const oy = HEAD;
  for (const n of list) {
    const wp = nodeWorldPos(n);
    n.parentSuperId = host.id;
    n.parentTaskId = host.parentTaskId || "";
    n.x = snap(wp.x - worldX - ox);
    n.y = snap(wp.y - worldY - oy);
    rewriteNodePathsForSuperContext(n);
  }
  pruneInvalidSuperBoundaryWires();
  S.sel = host.id;
  S.selSet = new Set([host.id]);
  S.selWire = null;
  S.selGroup = null;
  if (S.selMarkSet) S.selMarkSet.clear();
  S.selMark = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(I18n.t("已合并为超节点：") + host.title, "ok");
  return host;
}
function renderTaskCrumb() {
  const el = $("#taskCrumb");
  if (!el) return;
  const focus = currentTaskFocus();
  const sf = currentSuperFocus();
  if (!focus && !sf) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = "";
  const root = document.createElement("button");
  root.type = "button";
  root.className = "task-crumb-item";
  root.textContent = I18n.t("画布");
  root.title = I18n.t("返回顶层画布");
  root.onclick = (ev) => {
    ev.stopPropagation();
    resetSuperFocus();
    setTaskFocus("");
  };
  el.appendChild(root);
  if (focus) {
    const chain = taskAncestorChain(focus);
    chain.forEach((n, i) => {
      const sep = document.createElement("span");
      sep.className = "task-crumb-sep";
      sep.textContent = "/";
      el.appendChild(sep);
      const b = document.createElement("button");
      b.type = "button";
      b.className =
        "task-crumb-item" + (!sf && i === chain.length - 1 ? " on" : "");
      b.textContent = n.title || I18n.t("任务");
      b.title = I18n.t("进入任务：") + (n.title || "");
      b.onclick = (ev) => {
        ev.stopPropagation();
        resetSuperFocus();
        enterTask(n, { toast: false });
      };
      el.appendChild(b);
    });
  }
  if (sf) {
    const chain = [];
    let cur = nodeById(sf);
    while (cur && cur.kind === "super") {
      chain.unshift(cur);
      cur = nodeById(cur.parentSuperId);
    }
    chain.forEach((n, i) => {
      const sep = document.createElement("span");
      sep.className = "task-crumb-sep";
      sep.textContent = "/";
      el.appendChild(sep);
      const b = document.createElement("button");
      b.type = "button";
      b.className =
        "task-crumb-item" + (i === chain.length - 1 ? " on" : "");
      b.textContent = n.title || I18n.t("超级节点");
      b.title = I18n.t("进入超级节点：") + (n.title || "");
      b.onclick = (ev) => {
        ev.stopPropagation();
        enterSuper(n, { toast: false });
      };
      el.appendChild(b);
    });
  }
  const back = document.createElement("button");
  back.type = "button";
  back.className = "task-crumb-back mini";
  back.textContent = I18n.t("← 返回");
  back.title = I18n.t("返回上一层");
  back.onclick = (ev) => {
    ev.stopPropagation();
    if (currentSuperFocus()) leaveSuper();
    else leaveTask();
  };
  el.appendChild(back);
}
function groupVisibleInScope(g) {
  if (!g) return false;
  ensureGroupArrays(g);
  if ((g.nodeIds || []).some((id) => nodeInCurrentScope(nodeById(id))))
    return true;
  const f = currentTaskFocus();
  return (g.markIds || []).some((id) => {
    const m = (S.wf.marks || []).find((x) => x.id === id);
    return m && markParentTaskId(m) === f;
  });
}
function topoOrderByWires(nodes) {
  const list = (nodes || []).filter(Boolean);
  if (list.length <= 1) return list.slice();
  const ids = new Set(list.map((n) => n.id));
  const incoming = {};
  for (const n of list) incoming[n.id] = 0;
  for (const w of (S.wf && S.wf.wires) || []) {
    if (w.rel) continue;
    if (!ids.has(w.from) || !ids.has(w.to)) continue;
    incoming[w.to] = (incoming[w.to] || 0) + 1;
  }
  const ready = list
    .filter((n) => !incoming[n.id])
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  const seen = new Set();
  while (ready.length) {
    const n = ready.shift();
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    for (const w of S.wf.wires || []) {
      if (w.rel) continue;
      if (w.from !== n.id || !ids.has(w.to)) continue;
      incoming[w.to] -= 1;
      if (incoming[w.to] <= 0) {
        const t = list.find((x) => x.id === w.to);
        if (t && !seen.has(t.id)) ready.push(t);
        ready.sort((a, b) => a.y - b.y || a.x - b.x);
      }
    }
  }
  for (const n of list.sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!seen.has(n.id)) out.push(n);
  }
  return out;
}
function taskSummaryText(node, ran) {
  normalizeTaskSteps(node);
  const lines = [];
  lines.push("# " + (node.title || I18n.t("任务")));
  if (node.goal) {
    lines.push("");
    lines.push(node.goal);
  }
  if (node.steps.length) {
    lines.push("");
    lines.push(I18n.t("步骤："));
    for (const s of node.steps) {
      lines.push((s.done ? "- [x] " : "- [ ] ") + (s.title || ""));
    }
  }
  const kids = taskChildTasksOf(node.id);
  if (kids.length) {
    lines.push("");
    lines.push(I18n.t("子任务："));
    for (const k of kids) {
      const st = TASK_STATUS_LABEL[k.taskStatus] || k.taskStatus || "pending";
      lines.push("- " + (k.title || I18n.t("任务")) + " · " + I18n.t(st));
    }
  }
  if (ran && ran.length) {
    lines.push("");
    lines.push(I18n.t("已执行：") + I18n.listJoin(ran));
  }
  const r = selResult(node);
  if (r && r.output && r.output.kind === "text" && r.output.text && !ran)
    return r.output.text;
  return lines.join("\n");
}

const PROVIDER_TYPE_LABELS = [
  ["text_openai", "文本 · OpenAI 兼容（chat/completions）"],
  ["image_openai", "图像 · OpenAI 兼容（images/generations / edits）"],
  ["image_stability", "图像 · Stability AI（v2beta core）"],
  ["image_mj", "图像 · Midjourney（自定义接口）"],
];

/* ============ dsh agent 能力（契约见 dsh/DESIGN.md）============ */

/* agent 能力走 DeepSeek 路由：取第一个 DeepSeek 兼容文本服务商 */
function dshProvider() {
  const provs = (S.config && S.config.providers) || [];
  for (const p of provs) {
    if (p.type !== "text_openai" || !p.baseUrl) continue;
    try {
      const host = new URL(p.baseUrl).hostname.toLowerCase();
      if (host.includes("deepseek")) return p;
    } catch {}
  }
  return null;
}

/* 智能路由 → 配置里的文本服务商（校验 API Key / 展示名称） */
function providerForAgentRoute(route) {
  const r = String(route || "deepseek-official").trim() || "deepseek-official";
  if (r === "deepseek-official") return dshProvider();
  if (r.startsWith("mtnode_")) {
    const id = r.slice("mtnode_".length);
    return (
      ((S.config && S.config.providers) || []).find(
        (p) => p.id === id && p.type === "text_openai",
      ) || null
    );
  }
  return null;
}

/* 默认智能路由：优先其它文本服务商；无可用时再回退 DeepSeek 官方 */
function defaultAgentProviderRoute() {
  const mt = mtnodePiProviders();
  if (mt.length) return "mtnode_" + mt[0].route;
  const dp = dshProvider();
  if (dp && String(dp.apiKey || "").trim()) return "deepseek-official";
  return "deepseek-official";
}

/** 与全局助手一致：优先 assistProvider，再 API 模式 providerId，最后默认路由 */
function preferredAgentProviderRoute() {
  const routes = agentRouteOptions();
  const assist = String(
    S.assistProvider || (S.config && S.config.assistProvider) || "",
  ).trim();
  if (assist && routes.has(assist)) return assist;
  const firstText = (S.config.providers || []).find(
    (p) => p && p.type === "text_openai",
  );
  const fromApi = agentRouteFromProviderId(firstText && firstText.id);
  if (fromApi && routes.has(fromApi)) return fromApi;
  return defaultAgentProviderRoute();
}

function preferredAgentModelForRoute(route) {
  const assistModel = String(
    S.assistModel || (S.config && S.config.assistModel) || "",
  ).trim();
  if (assistModel && agentModelFitsRoute(route, assistModel)) return assistModel;
  const models = agentModelsForRoute(route);
  return models[0] || "";
}

/** 原 API 模式 providerId → 智能路由（DeepSeek 配置走官方路由，其余走 mtnode_） */
function agentRouteFromProviderId(providerId) {
  const id = String(providerId || "").trim();
  if (!id) return "";
  const p = (S.config.providers || []).find(
    (x) => x.id === id && x.type === "text_openai",
  );
  if (!p || !String(p.apiKey || "").trim()) return "";
  let host = "";
  try {
    host = new URL(p.baseUrl || "").hostname.toLowerCase();
  } catch {}
  if (host.includes("deepseek")) return "deepseek-official";
  if (!String(p.baseUrl || "").trim() || !(p.models || []).length) return "";
  return "mtnode_" + (p.id || "");
}

function agentRouteOptions() {
  const routes = new Set(["deepseek-official"]);
  for (const p of mtnodePiProviders()) routes.add("mtnode_" + p.route);
  return routes;
}

function agentModelFitsRoute(route, model) {
  const m = String(model || "").trim();
  if (!m) return false;
  const models = agentModelsForRoute(route);
  if (!models.length) return true;
  if (models.includes(m)) return true;
  return models.some(
    (x) =>
      x.toLowerCase() === m.toLowerCase() ||
      x.endsWith("/" + m) ||
      x.endsWith(m),
  );
}

/**
 * 智能节点：仅补全空路由；DeepSeek 路由与模型明显不匹配时改路由（非改模型）。
 * 不强行把已选本地/其它模型换成 DeepSeek。
 */
function syncAgentProviderRoute(node, opts) {
  opts = opts || {};
  if (!node || !isDshTask(node)) return null;
  const routes = agentRouteOptions();
  const fromApi = agentRouteFromProviderId(node.providerId);
  const prevRoute = String(node.provider || "").trim();
  const prevModel = String(node.model || "").trim();
  let route = prevRoute;

  if (!route || !routes.has(route)) {
    if (fromApi && routes.has(fromApi)) route = fromApi;
    else route = preferredAgentProviderRoute();
  }

  if (
    route === "deepseek-official" &&
    prevModel &&
    !agentModelFitsRoute("deepseek-official", prevModel) &&
    fromApi &&
    fromApi !== "deepseek-official" &&
    routes.has(fromApi)
  ) {
    route = fromApi;
  }

  let dirty = false;
  if (route && node.provider !== route) {
    node.provider = route;
    node.vision = null;
    dirty = true;
  }
  if (!prevModel) {
    const pick =
      preferredAgentModelForRoute(node.provider || route) ||
      (agentModelsForRoute(node.provider || route)[0] || "");
    if (pick && node.model !== pick) {
      node.model = pick;
      node.vision = null;
      dirty = true;
    }
  }

  if (dirty && opts.save) scheduleSave(true);
  return { route: node.provider, model: node.model };
}

/* 智能能力永久启用(1.1.0 起不再提供关闭开关) */
function dshEnabled() {
  return true;
}

/* 能否使用 agent 能力；不可用时给出面向用户的原因(其他文本服务商同样支持) */
function dshSupported() {
  const provs = (S.config && S.config.providers) || [];
  const hasKey = provs.some(
    (p) => p.type === "text_openai" && String(p.apiKey || "").trim(),
  );
  if (!hasKey)
    return {
      ok: false,
      reason: I18n.t("未配置带 API Key 的文本服务商（设置 · API/配置 → 模型服务）"),
    };
  return { ok: true, provider: dshProvider() };
}

/* 模型下拉标签:视觉模型带「图」标记 */
function modelLabel(m, vis) {
  const base = m.name && m.name !== m.id ? m.id + " · " + m.name : m.id;
  return base + (vis && vis.has(m.id) ? I18n.t(" 图") : "");
}

/* 节点默认工作目录，优先级：节点/会话手填目录 > 画布项目根（开发节点 devPath 单一真源，
   见 devProjectRootOf；多根歧义时另置 S.devProjectRootAmbiguous = true 供 UI 提示）>
   画布统一目录 wf.workspace > 应用默认数据目录。
   ⚠ 同名副本有两份：renderer/app.js 与 renderer/app-agent.js（后者后加载生效），
   两份必须与 devProjectRootOf 保持同一逻辑，任何改动都要逐字同步。 */
function dshWorkspaceOf(node) {
  const manual = node && (node.agentWorkspace || node.workspace);
  if (manual) return manual;
  const projRoot = devProjectRootOf();
  if (projRoot) return projRoot;
  if (S.wf && S.wf.workspace) return S.wf.workspace;
  return S.dshWorkspaceFallback || "";
}

/* ── 图像输入与视觉模型(智能任务节点连接图像时) ── */
function modelIsVision(m) {
  return !!(m && Array.isArray(m.input) && m.input.includes("image"));
}
/* 供应商的目录来源(与网关 catalogIdOf 同款判定):优先用保存的 source,
   缺失时按 baseURL + 模型集回查 pi-ai 目录(老配置/手填目录服务商也能识别)。 */
function catalogSourceOf(p) {
  if (!p) return "";
  if (p.source) return p.source;
  const base = String(p.baseUrl || "").trim().toLowerCase().replace(/\/+$/, "");
  const ids = new Set((Array.isArray(p.models) ? p.models : []).map((m) => String(m)));
  if (!base || !ids.size) return "";
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  let best = "";
  let bestCount = 0;
  for (const prov of c.piai || []) {
    let hit = false;
    let count = 0;
    for (const m of prov.models || []) {
      if ((m.api || "openai-completions") !== "openai-completions") continue;
      const mb = String(m.baseUrl || "").trim().toLowerCase().replace(/\/+$/, "");
      if (mb && mb === base) hit = true;
      if (ids.has(m.id)) count++;
    }
    /* 部分命中即可（用户可能另加了目录外自定义模型），取重合最多的目录源 */
    if (!hit || count === 0) continue;
    if (count > bestCount) {
      best = prov.id;
      bestCount = count;
    }
  }
  return best;
}
/* 全目录视觉模型索引：id → 目录条目（跨服务商回查） */
function visionModelIndex() {
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  const map = new Map();
  for (const m of c.deepseek || []) {
    if (modelIsVision(m)) map.set(m.id, m);
  }
  for (const prov of c.piai || []) {
    for (const m of prov.models || []) {
      if (modelIsVision(m)) map.set(m.id, m);
    }
  }
  return map;
}
/* 该供应商可用的视觉模型（顺序 = 用户模型列表优先级）：
   1) 目录源中的视觉模型 ∩ 已保存模型列表（按已保存顺序）
   2) 已保存模型 id 在任意目录中标为视觉
   3) 勾选了「支持视觉」时，已保存模型全部作为候选（手填服务商） */
function visionModelsForProvider(providerId) {
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  if (providerId === "deepseek-official")
    return (c.deepseek || []).filter(modelIsVision);
  const pid = String(providerId || "").replace(/^mtnode_/, "");
  const p = (S.config.providers || []).find((x) => x.id === pid);
  if (!p) return [];
  const modelIds = Array.isArray(p.models) ? p.models.map(String) : [];
  const byId = new Map();
  const src = catalogSourceOf(p);
  const pp = src ? (c.piai || []).find((x) => x.id === src) : null;
  for (const m of (pp && pp.models) || []) {
    if (modelIsVision(m) && m.id) byId.set(String(m.id), m);
  }
  if (!byId.size) {
    const idx = visionModelIndex();
    for (const id of modelIds) {
      const m = idx.get(id);
      if (m) byId.set(String(id), m);
    }
  }
  const out = [];
  const seen = new Set();
  for (const id of modelIds) {
    const m = byId.get(id);
    if (!m || seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  if (!out.length && p.vision && modelIds.length) {
    for (const id of modelIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: id, input: ["text", "image"] });
    }
  }
  return out;
}

/* DeepSeek 官方纯文本模型不支持图；目录中带 image 的多模态模型除外。
   无图主机上的「手填 vision」兜底仍应降到次选。 */
function providerHostBlocksVision(p) {
  if (!p || !p.baseUrl) return false;
  try {
    const host = new URL(String(p.baseUrl).trim()).hostname.toLowerCase();
    if (host.includes("deepseek")) return true;
  } catch {}
  return false;
}
/* 节点已连接的图像输入节点（含全局节点广播） */
function imageInputsOf(node, idx) {
  const out = [];
  const seen = new Set();
  const pushImg = (src) => {
    if (!src || seen.has(src.id)) return;
    if (src.kind !== "input_image" && src.kind !== "proc_image") return;
    seen.add(src.id);
    out.push({
      id: src.id,
      title: itemTitleOf(src, idx == null ? 0 : idx) || src.title || I18n.t("图像"),
    });
  };
  for (const w of wiresTo(node.id)) pushImg(nodeById(w.from));
  /* 全局广播图像：只有任务/提示词里明文 @ 命中的来源才算已连接图像输入 */
  for (const src of globalRefSourcesForRun(node, procPromptForRun(node)))
    pushImg(src);
  return out;
}

/* 智能任务实际携带的图像路径。
   批量逐条运行时只带「当前条目」对应图像，避免 N 次运行各塞入全部 N 张 → N² token。
   聚合 / 非批量：可带上已连接源的全部图像。 */
function collectTaskImagePaths(node, spec, idx) {
  const out = [];
  const push = (p) => {
    if (p && typeof p === "string" && !out.includes(p)) out.push(p);
  };
  const i = idx == null ? 0 : idx;
  const perItem = !!(node && isBatch(node) && node.batchMode !== "agg");
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    if (isSuperLikeNode(src)) {
      const portIdx = Number(w.fromIndex || 0);
      if (perItem) {
        const v = valueForInput(src, portIdx, node);
        if (v && v.kind === "image" && v.path) push(v.path);
      } else {
        for (const it of allImageItems(src, node, portIdx)) push(it.path);
      }
      continue;
    }
  }
  for (const n of imageInputsOf(node, i)) {
    const src = nodeById(n.id);
    if (!src) continue;
    if (perItem) {
      const v = valueForInput(src, i, node);
      if (v && v.kind === "image" && v.path) push(v.path);
      continue;
    }
    for (const it of allImageItems(src, node)) push(it.path);
  }
  for (const p of (spec && spec.images) || []) push(p);
  return out;
}

/* 其他已配置供应商中的视觉模型候选(排除当前供应商；含 DeepSeek 官方) */
function visionCandidatesForNode(node) {
  const curProv = node.provider || "deepseek-official";
  const out = [];
  const pushRoute = (provider, providerName) => {
    if (provider === curProv) return;
    for (const m of visionModelsForProvider(provider)) {
      out.push({
        provider,
        providerName: providerName || provider,
        model: m.id,
        modelName: m.name || m.id,
      });
    }
  };
  pushRoute(
    "deepseek-official",
    providerDisplayName("deepseek-official"),
  );
  for (const p of S.config.providers || []) {
    if (p.type && p.type !== "text_openai") continue;
    /* 无 Key 的不列入（无法实际调用）；与 mtnode 路由一致 */
    if (!String(p.apiKey || "").trim()) continue;
    pushRoute("mtnode_" + p.id, p.name || p.id);
  }
  return out;
}

/* 确认改用视觉模型(确认后写入 node.vision 持续使用,不再询问) */
function confirmVisionSwitch(node, cands, curModel) {
  return new Promise((resolve) => {
    openOverlay(I18n.t("图像输入需要视觉模型"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const hint = document.createElement("div");
    hint.className = "settings-hint";
    hint.textContent =
      I18n.t("当前选择的模型「") +
      (curModel || I18n.t("未选择")) +
      I18n.t("」不支持识图。以下已保存的视觉模型可选，是否改用？");
    body.appendChild(hint);
    const sel = document.createElement("select");
    sel.className = "n-field";
    sel.style.width = "100%";
    for (let i = 0; i < cands.length; i++) {
      const cd = cands[i];
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent =
        cd.providerName + " · " + (cd.modelName || cd.model) + I18n.t(" 图");
      sel.appendChild(o);
    }
    body.appendChild(sel);
    const note = document.createElement("div");
    note.className = "settings-hint";
    note.textContent =
      I18n.t("确认后将一直使用该供应商 / 模型处理本节点的图像任务（在节点 API 面板更换供应商或模型后重新询问）。");
    body.appendChild(note);
    const foot = $("#ovFoot");
    const cancel = document.createElement("button");
    cancel.className = "mini";
    cancel.textContent = I18n.t("不使用");
    cancel.onclick = () => {
      node.vision = { declined: true };
      scheduleSave();
      closeOverlay();
      resolve(false);
    };
    const ok = document.createElement("button");
    ok.className = "mini primary";
    ok.textContent = I18n.t("确认使用");
    ok.onclick = () => {
      const cd = cands[Number(sel.value)] || cands[0];
      if (!cd) {
        closeOverlay();
        resolve(false);
        return;
      }
      node.vision = { provider: cd.provider, model: cd.model };
      scheduleSave(true);
      closeOverlay();
      resolve(true);
    };
    foot.appendChild(cancel);
    foot.appendChild(ok);
  });
}

/* 供应商显示名(用于视觉询问文案) */
function providerDisplayName(provider) {
  if (provider === "deepseek-official") {
    const dp = dshProvider();
    return (dp && dp.name) || I18n.t("DeepSeek 官方");
  }
  if (String(provider || "").startsWith("mtnode_")) {
    const mp = mtnodePiProviders().find(
      (x) => "mtnode_" + x.route === provider,
    );
    return (mp && mp.name) || provider;
  }
  return provider || I18n.t("当前");
}

/* 图像运行决策:返回 {provider, model}(视觉可用)或 null(不可识图)。
   - 已确认的供应商/模型 → 直接使用;
   - 当前选择的模型已支持识图 → 原样返回当前供应商/模型;
   - 智能节点(agent_task / 文本智能模式) → 可用 mtnode_vision，不再弹窗或自动切换主模型;
   - 否则 → 从全部已保存供应商(含当前)的视觉模型中选取:
       · proc_text（原模式）自动切到第一个候选并提示;
       · 其他弹窗询问，确认后写入 node.vision 持续使用;拒绝则 declined。 */
async function resolveVisionForRun(node) {
  const curProv = node.provider || "deepseek-official";
  const cur = node.model;
  const curVis = visionModelsForProvider(curProv);
  /* 当前选择的模型已支持识图:原样使用 */
  if (cur && curVis.some((m) => m.id === cur)) {
    return { provider: curProv, model: cur };
  }
  /* 智能节点：靠 mtnode_vision 识图，不切换主模型、不弹窗 */
  if (isDshTask(node)) return null;
  /* 之前已确认的供应商/模型:校验仍存在后直接使用 */
  if (node.vision && node.vision.provider && node.vision.model) {
    const provOk =
      node.vision.provider === "deepseek-official" ||
      (S.config.providers || []).some(
        (p) => "mtnode_" + p.id === node.vision.provider,
      );
    if (provOk) return { provider: node.vision.provider, model: node.vision.model };
    node.vision = null; /* 已失效,重新评估 */
  }
  if (node.vision && node.vision.declined) return null; /* 此前选择不用 */
  /* 候选 = 当前供应商的视觉模型 + 其他供应商的视觉模型(去重) */
  const cands = [];
  const seen = new Set();
  const curName = providerDisplayName(curProv);
  for (const m of curVis) {
    const key = curProv + "|" + m.id;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push({
      provider: curProv,
      providerName: curName,
      model: m.id,
      modelName: m.name || m.id,
    });
  }
  for (const c of visionCandidatesForNode(node)) {
    const key = c.provider + "|" + c.model;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push(c);
  }
  if (!cands.length) {
    if (Date.now() - (S._visionToastAt || 0) > 5000) {
      S._visionToastAt = Date.now();
      toast(
        I18n.t("检测到图像输入，但已保存的服务商都没有视觉模型；请在「模型服务」添加支持图像的服务商（如 opencode 等）并选择其视觉模型"),
        "warn",
      );
    }
    return null;
  }
  /* 文本处理节点原模式：自动切到第一个视觉模型（不弹窗） */
  if (node.kind === "proc_text") {
    const pick = cands[0];
    node.vision = { provider: pick.provider, model: pick.model };
    if (pick.provider !== curProv || pick.model !== cur) {
      node.provider = pick.provider;
      node.model = pick.model;
      toast(
        I18n.t("已自动切换至视觉模型：") +
          pick.providerName +
          " / " +
          (pick.modelName || pick.model),
        "ok",
      );
      scheduleSave(true);
    }
    return { provider: pick.provider, model: pick.model };
  }
  if (node._visionAsking) return node._visionAsking;
  node._visionAsking = confirmVisionSwitch(node, cands, cur).then((ok) => {
    node._visionAsking = null;
    return ok && node.vision && node.vision.provider
      ? { provider: node.vision.provider, model: node.vision.model }
      : null;
  });
  return node._visionAsking;
}

/* 工作流级统一工作目录(设置后所有智能节点只读继承) */
function wfWorkspace() {
  return (S.wf && S.wf.workspace) || "";
}

/* 保存路径：绝对路径原样使用；相对路径相对于顶栏工作目录解析。
   有工作目录时新建保存节点默认写相对路径，改工作目录即可统一切换落盘位置。 */
function isAbsPath(p) {
  try {
    return !!(window.api && window.api.pathIsAbsolute && window.api.pathIsAbsolute(p));
  } catch {
    const s = String(p || "");
    return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\") || (s.startsWith("/") && !s.startsWith("//"));
  }
}
function joinPath(...parts) {
  if (window.api && window.api.pathJoin) return window.api.pathJoin(...parts);
  return parts.filter((x) => x != null && String(x) !== "").join("/").replace(/\/+/g, "/");
}
function relPath(from, to) {
  if (window.api && window.api.pathRelative) return window.api.pathRelative(from, to);
  return String(to || "");
}
function resolveSavePath(p, node) {
  const raw = String(p || "").trim();
  if (!raw) return { ok: false, code: "empty" };
  if (isAbsPath(raw)) return { ok: true, path: raw };
  const rel = node
    ? applySuperRelToPath(node, raw)
    : raw.replace(/\\/g, "/");
  const base = String(wfWorkspace() || "").trim();
  if (!base) return { ok: false, code: "no_ws", path: rel };
  return { ok: true, path: joinPath(base, rel) };
}
/* 若绝对路径落在工作目录内，存成相对路径（正斜杠），便于换工作目录时统一切换 */
function preferRelativeSavePath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  if (!isAbsPath(raw)) return raw.replace(/\\/g, "/");
  const base = String(wfWorkspace() || "").trim();
  if (!base) return raw;
  const rel = relPath(base, raw);
  if (!rel || rel === "" || rel.startsWith("..") || isAbsPath(rel)) return raw;
  return String(rel).replace(/\\/g, "/");
}
function ensureDefaultSavePath(node) {
  if (!isSaveNode(node)) return;
  if (String(node.savePath || "").trim()) {
    applySavePathExt(node);
    return;
  }
  if (!String(wfWorkspace() || "").trim() && !mediaGenOfBoundSave(node)) return;
  const ext = saveExtForMedia(saveMediaKind(node));
  const base = safeFile(node.title || "output") + ext;
  node.savePath = applySuperRelToPath(node, base);
}
function savePathResolveError(code) {
  if (code === "no_ws")
    return I18n.t("相对路径需要先设置工作目录（顶栏），或改用绝对路径");
  return I18n.t("请先指定保存路径（可用「浏览」选择）");
}

/* dsh 指标格式化：与 dsh 客户端一致的表达,如
   "6 轮 · 329 步 | LLM 63m49s · 工具调用 10m46s | 首 token 平均 3.5s · 91 tok/s | 缓存命中 100% | 输入 90.5M tok · 输出 243K tok · 子代理 2 · 后台任务 1" */
function fmtDur(ms) {
  if (!(ms > 0)) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? m + "m" + r + "s" : m + "m";
}
function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
function fmtDshMetrics(m) {
  if (!m) return "";
  const parts = [];
  parts.push((m.turns || 0) + I18n.t(" 轮 · ") + (m.steps || 0) + I18n.t(" 步"));
  parts.push("LLM " + fmtDur(m.llmMs) + I18n.t(" · 工具调用 ") + fmtDur(m.toolMs));
  if (m.firstTokenAvgMs > 0)
    parts.push(
      I18n.t("首 token 平均 ") + (m.firstTokenAvgMs / 1000).toFixed(1) + "s · " + Math.round(m.tokPerSec || 0) + " tok/s",
    );
  parts.push(I18n.t("缓存命中 ") + Math.round(m.cacheHitPct || 0) + "%");
  parts.push(
    I18n.t("输入 ") + fmtTok(m.inputTokens) + I18n.t(" tok · 输出 ") + fmtTok(m.outputTokens) + " tok",
  );
  if (m.subagents) parts.push(I18n.t("子代理 ") + m.subagents);
  if (m.jobs) parts.push(I18n.t("后台任务 ") + m.jobs);
  return parts.join(" | ");
}

/* footer:当前会话本轮 token 消耗统计。
   运行中按网关 usage 事件实时累积;完成后以 d.metrics 为准。 */
function currentSessionOrNull() {
  const list = agentSessions();
  const id = activeAgentId();
  return list.find((s) => s.id === id) || list[0] || null;
}
function fmtSessionFooterStat(m, running) {
  if (!m) return "";
  const parts = [];
  parts.push(
    I18n.t("输入 ") +
      fmtTok(m.inputTokens) +
      " · " +
      I18n.t("输出 ") +
      fmtTok(m.outputTokens) +
      " · " +
      I18n.t("推理 ") +
      fmtTok(m.reasoningTokens) +
      " tok",
  );
  if (!running) {
    if ((m.llmMs || 0) > 0) parts.push("LLM " + fmtDur(m.llmMs));
    if (m.tools && m.tools.length)
      parts.push(I18n.t("工具 ") + m.tools.length + I18n.t(" 次"));
  }
  return parts.join(" · ");
}
function sessionFooterTitle(st, m, running) {
  const rows = [];
  if (m) {
    rows.push((m.turns || 0) + I18n.t(" 轮 · ") + (m.steps || 0) + I18n.t(" 步"));
    if ((m.llmMs || 0) > 0)
      rows.push(
        "LLM " + fmtDur(m.llmMs) + I18n.t(" · 工具调用 ") + fmtDur(m.toolMs),
      );
    if ((m.firstTokenAvgMs || 0) > 0)
      rows.push(
        I18n.t("首 token 平均 ") + (m.firstTokenAvgMs / 1000).toFixed(1) + "s",
      );
    rows.push(I18n.t("缓存命中 ") + Math.round(m.cacheHitPct || 0) + "%");
    rows.push(
      I18n.t("输入 ") +
        fmtTok(m.inputTokens) +
        " · " +
        I18n.t("输出 ") +
        fmtTok(m.outputTokens) +
        " · " +
        I18n.t("推理 ") +
        fmtTok(m.reasoningTokens) +
        " tok",
    );
    if ((m.contextWindow || 0) > 0)
      rows.push(
        I18n.t("上下文 ") +
          fmtTok((m.inputTokens || 0) + (m.outputTokens || 0)) +
          " / " +
          fmtTok(m.contextWindow) +
          " tok",
      );
    if (m.subagents) rows.push(I18n.t("子代理 ") + m.subagents);
    if (m.jobs) rows.push(I18n.t("后台任务 ") + m.jobs);
  }
  if (running) rows.push(I18n.t("运行中"));
  return rows.join("\n");
}
function renderSessionFooterStat() {
  const el = $("#statSession");
  if (!el) return;
  const st = currentSessionOrNull();
  if (!st) {
    el.textContent = "";
    el.title = I18n.t("当前会话本轮 token 消耗（运行会话后显示）");
    return;
  }
  const running = !!(st.running || liveNodeForSession(st));
  const m = st.metrics || st._usageLive || null;
  if (!running && !m) {
    el.textContent = "";
    el.title = I18n.t("当前会话本轮 token 消耗（运行会话后显示）");
    return;
  }
  const prefix =
    I18n.t("会话 · ") + (running ? I18n.t("运行中") + " · " : I18n.t("本轮 "));
  const txt = m
    ? prefix + fmtSessionFooterStat(m, running)
    : prefix + I18n.t("输入 ") + "0 tok";
  el.textContent = txt;
  el.title = sessionFooterTitle(st, m, running);
}
function recordDshMetrics(node, m) {
  if (!m) return;
  if (node) {
    node.dshMetrics = m;
    if (m.tools && m.tools.length) node.dshTools = m.tools;
  }
  S.lastDshMetrics = m;
  renderStatus();
}

/* 思考强度映射（下发网关前的最后归一，词汇与 dsh/gateway/reasoning-effort.mjs 对齐）:
   - 会话 / 助手 / 智能节点：low/medium/high/xhigh/max 全档原样下发（medium/xhigh 不再拍平）
   - 旧档 none/off/无/空 与未知值 → high（兜底默认，兼容已存工作流）
   - 智能文本节点（proc_text agent，自带 无/低/中/高 四档，fromProcText=true）：
     off → high（agent 链上思考不能关闭）；高 → max（历史口径：文本节点顶档 = dsh 顶档，
     已存节点语义不变）；低 → low、中 → medium（跟随档位词汇原样） */
function dshEffortOf(v, fromProcText) {
  let raw = String(v == null || v === "" ? "high" : v).toLowerCase();
  if (raw === "无" || raw === "off" || raw === "none") return "high";
  if (raw === "high") return fromProcText ? "max" : "high";
  return AGENT_EFFORT_ORDER.includes(raw) ? raw : "high";
}

/* 中断智能运行:dsh 线协议无逐轮取消,只能关掉该次运行自己的运行时进程。
   runKey = 那次运行登记的 cancelTag(会话 agent:<id> / 节点 node.id / 助手 assist),
   网关据此精确关闭,不会波及同工作目录里其它并行会话;缺省 = 中断全部在途运行。 */
function dshCancelActive(runKey) {
  const map = (S && S._runCancels) || {};
  const keys = runKey ? [String(runKey)] : Object.keys(map);
  const list = [];
  for (const k of keys) {
    const h = map[k];
    if (!h) continue;
    delete map[k];
    list.push({ cancelTag: h.cancelTag || k, workspace: h.workspace });
    /* 用户点「终止」= 这一轮的宿主确认框立刻作废：先本地自毁，不等网关回帧
       （否则框还挂着，点「确认」只会写进一个即将被关掉的 socket） */
    if (typeof canvasConfirmDropRun === "function") canvasConfirmDropRun(k);
  }
  if (!list.length) return Promise.resolve();
  return Promise.all(list.map((p) => window.api.dshCancel(p).catch(() => {})));
}

function isCancelishError(msg) {
  return /中止|取消|cancel|abort|aborted|已终止|已手动停止|已请求终止|已请求中断/i.test(
    String(msg || ""),
  );
}

function stripStreamErrors(text) {
  return String(text || "")
    .replace(/(?:^|\n)⚠[^\n]*/g, "")
    .trim();
}

/* mtnode 服务商(非 DeepSeek 官方)同步给引擎:经 pi-ai 手写 profile 路由 */
function mtnodePiProviders() {
  const out = [];
  const provs = (S.config && S.config.providers) || [];
  provs.forEach((p, i) => {
    if (p.type !== "text_openai" || !String(p.apiKey || "").trim()) return;
    let host = "";
    try { host = new URL(p.baseUrl || "").hostname.toLowerCase(); } catch {}
    if (host.includes("deepseek")) return; /* DeepSeek 走官方路由 */
    /* 引擎只注册 baseUrl 与模型齐全的服务商 */
    if (!String(p.baseUrl || "").trim() || !(p.models || []).length) return;
    out.push({
      route: p.id || "p" + (i + 1),
      name: p.name || p.id,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      api: p.api || "openai-completions",
      models: p.models || [],
    });
  });
  return out;
}

/** 0 或未设正数 = 不限制单次输出 maxTokens */
function effectiveDshMaxTokens(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
function dshRunMaxTokens() {
  return effectiveDshMaxTokens(
    (S.config && S.config.dsh && S.config.dsh.maxTokens) || 0,
  );
}

/* ============ 撤销 / 重做 ============ */

function snapshotState() {
  return JSON.parse(
    JSON.stringify({
      nodes: S.wf.nodes,
      wires: S.wf.wires,
      groups: S.wf.groups,
      marks: S.wf.marks || [],
      /* 素材库文件在画布快照之外，这一格撤销「顺带要回滚哪些库内容」记在这里：
         [{assetId,itemId,type,title,prevFile,prevEmpty}]（prevFile ＝ .versions/ 里那份
         旧文件的绝对路径，"" ＝ 改之前本来就是空的）。写库动作先 pushHistory 拿到
         快照对象，再往它的 assetEdits 上追加（见 app-assets.js · assetRecordEdit）。
         不记这一笔的话「撤销」只回滚画布，磁盘上库里那份内容仍是被改过的状态。 */
      assetEdits: [],
    }),
  );
}
/* 在操作前调用：把「操作前状态」压入撤销栈 */
function pushHistory(snap) {
  /* 后台写非当前画布时不污染当前画布的撤销栈 */
  if (S._canvasEditVisible === false) return;
  if (S._skipCanvasHistory) return;
  S.undoStack.push(snap || snapshotState());
  if (S.undoStack.length > 100) S.undoStack.shift();
  S.redoStack = [];
}
function blurMarkEditing() {
  const ae = document.activeElement;
  if (
    ae &&
    ae.isContentEditable &&
    ae.classList &&
    ae.classList.contains("mk-text")
  ) {
    try {
      ae.blur();
    } catch (_) {}
  }
}
function applySnap(s) {
  /* 撤销/重做必须立刻重绘绘制层，不可被文字编辑 defer 挡住 */
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  S.wf.nodes = s.nodes;
  S.wf.wires = s.wires;
  S.wf.groups = s.groups || [];
  S.wf.marks = Array.isArray(s.marks) ? s.marks : [];
  clearSelection();
  /* 撤销 / 重做换上来的是一批深拷贝的新对象：设置窗绑的还是旧节点，
     继续开着就会把修改写进孤儿对象，这里跟着关掉（skipSave —— 本函数末尾自己落盘）。 */
  closeNodeSettingsDialogIfStale({ silentRerender: true, skipSave: true });
  closeBgRmPop();
  renderCanvas();
  renderStatus();
  scheduleSave(true);
}
/** 撤销 / 重做走同一台机器：把目标那格快照换到画布上，再按它记的 assetEdits
 *  回滚素材库文件；回滚本身又会产出一批「旧的现在态」，反向记到对面那一格上，
 *  于是 redo 能原样再贴回去 —— 不需要在写库时提前留副本。
 *  纯画布那一大类撤销（assetEdits 为空）行为与从前逐字相同。 */
async function stepHistory(kind) {
  const from = kind === "undo" ? S.undoStack : S.redoStack;
  const to = kind === "undo" ? S.redoStack : S.undoStack;
  if (!from.length) {
    toast(kind === "undo" ? I18n.t("没有可撤销的操作") : I18n.t("没有可重做的操作"), "warn");
    return;
  }
  const s = from[from.length - 1];
  const edits = s && Array.isArray(s.assetEdits) ? s.assetEdits.slice() : [];
  if (edits.length && typeof assetRollbackBusy === "function" && assetRollbackBusy()) {
    toast(I18n.t("素材库正在回滚，请稍等一下再撤销 / 重做"), "warn");
    return;
  }
  const cur = snapshotState();
  from.pop();
  to.push(cur);
  applySnap(s);
  if (!edits.length) {
    toast(kind === "undo" ? I18n.t("已撤销") : I18n.t("已重做"), "ok");
    return;
  }
  /* applySnap 已经落盘过一次画布；库回滚是异步的，完成后要按新库内容重画节点 body */
  let r = { done: 0, failed: edits.length };
  try {
    if (typeof assetRollbackEdits === "function")
      r = (await assetRollbackEdits(edits, cur)) || r;
  } catch (e) {
    r = { done: 0, failed: edits.length };
  }
  const what = kind === "undo" ? I18n.t("已撤销") : I18n.t("已重做");
  if (!r || !r.failed)
    toast(
      what +
        I18n.t(" · 素材库内容已回滚（{n} 项）", { n: (r && r.done) || 0 }),
      "ok",
    );
  else
    toast(
      what +
        I18n.t(" · 素材库有 {n} 项没能回滚", { n: r.failed }) +
        I18n.t("（旧内容仍在该素材的 .versions 目录里）"),
      "warn",
    );
}
function undo() {
  stepHistory("undo");
}
function redo() {
  stepHistory("redo");
}
function clearHistory() {
  S.undoStack = [];
  S.redoStack = [];
}

/* ============ 多选 / 选择辅助 ============ */

function clearSelection() {
  S.sel = null;
  S.selWire = null;
  S.selGroup = null;
  S.selMark = null;
  if (S.selSet) S.selSet.clear();
  if (S.selMarkSet) S.selMarkSet.clear();
  /* 取消选中 → 关系线的高亮 / 淡出一起撤掉 */
  refreshRelWireStates();
}
/* Ctrl+A：全选当前范围内的节点与绘制（与框选同一套命中口径：nodes 按 nodeInCurrentScope、
   marks 按 markInCurrentScope；可复制文本的「输出区」不在此列，保持原生全选） */
function selectAllNodesInScope() {
  const wf = S.wf;
  if (!wf) return;
  const nodes = (wf.nodes || []).filter((n) => nodeInCurrentScope(n));
  const marks = marksOf().filter((m) => markInCurrentScope(m));
  if (!nodes.length && !marks.length) return;
  S.selSet = new Set(nodes.map((n) => n.id));
  S.sel = nodes.length ? nodes[nodes.length - 1].id : null;
  const mset = ensureSelMarkSet();
  mset.clear();
  for (const m of marks) mset.add(m.id);
  S.selMark = marks.length ? marks[marks.length - 1].id : null;
  S.selGroup = null;
  S.selWire = null;
  renderCanvas();
}
function ensureSelMarkSet() {
  if (!S.selMarkSet) S.selMarkSet = new Set();
  return S.selMarkSet;
}
function syncMarkSelDom() {
  document
    .querySelectorAll(".wf-mark.sel")
    .forEach((el) => el.classList.remove("sel"));
  const set = S.selMarkSet;
  if (!set || !set.size) {
    if (S.selMark) {
      const el = document.querySelector('.wf-mark[data-mid="' + S.selMark + '"]');
      if (el) el.classList.add("sel");
    }
    return;
  }
  for (const id of set) {
    const el = document.querySelector('.wf-mark[data-mid="' + id + '"]');
    if (el) el.classList.add("sel");
  }
}
function selectedMarks() {
  const set = ensureSelMarkSet();
  if (set.size) return marksOf().filter((m) => set.has(m.id));
  const m = S.selMark ? markById(S.selMark) : null;
  return m ? [m] : [];
}
function isSel(id) {
  return !!S.selSet && S.selSet.has(id);
}
function selNodes() {
  return S.wf.nodes.filter((n) => S.selSet.has(n.id));
}
/* 当前选中的节点列表：selSet 为空时回退到 S.sel（兼容直接设置 S.sel 的调用方） */
function currentSelection() {
  const ns = selNodes();
  if (ns.length) return ns;
  const p = S.sel ? nodeById(S.sel) : null;
  return p ? [p] : [];
}

/* ============ 基础工具 ============ */

function uid(p) {
  return (
    (p || "n") +
    Date.now().toString(36) +
    Math.floor(Math.random() * 46656).toString(36)
  );
}
function grid() {
  return Math.max(4, Math.min(64, Number(S.config && S.config.snap) || 24));
}
function snap(v) {
  return Math.round(v / grid()) * grid();
}
/* 尺寸落到网格；若低于最小值则抬到不小于 min 的最近网格点 */
function snapDim(v, minV) {
  const g = grid();
  const min = Math.max(0, Number(minV) || 0);
  let s = Math.round(Number(v) / g) * g;
  if (s < min) s = Math.ceil(min / g) * g;
  return s;
}
function gridMod(a, n) {
  return ((a % n) + n) % n;
}
/* 背景点阵间距 = snap×zoom；点径随 zoom 缩小，拉远时网格点不会显得过大 */
function syncCanvasGrid() {
  const canvas = $("#canvas");
  if (!canvas || !S.cam) return;
  const g = grid();
  const z = S.cam.z > 0 && isFinite(S.cam.z) ? S.cam.z : 1;
  const gs = g * z;
  const dotR = Math.max(0.3, Math.min(1, z));
  const dotEnd = dotR * 1.5;
  canvas.style.setProperty("--grid-size", gs + "px");
  canvas.style.setProperty("--grid-x", gridMod(S.cam.x, gs) + "px");
  canvas.style.setProperty("--grid-y", gridMod(S.cam.y, gs) + "px");
  canvas.style.setProperty("--grid-dot-r", dotR + "px");
  canvas.style.setProperty("--grid-dot-end", dotEnd + "px");
}
function fmtTime(d) {
  const x = new Date(d);
  return (
    String(x.getHours()).padStart(2, "0") +
    ":" +
    String(x.getMinutes()).padStart(2, "0") +
    ":" +
    String(x.getSeconds()).padStart(2, "0")
  );
}
function nodeById(id) {
  return S.wf ? S.wf.nodes.find((n) => n.id === id) : null;
}
function isControlKind(n) {
  /* 控制 / 起点终点 / 需求等待 / 定时 / 延时 / 序列 / 闸门 / 分发 / 计数 / 互斥 / 判断 / 任务：指挥线 */
  return !!(
    n &&
    (n.kind === "control" ||
      n.kind === "wait_file" ||
      n.kind === "timer" ||
      n.kind === "delayer" ||
      n.kind === "sequencer" ||
      n.kind === "gate" ||
      n.kind === "splitter" ||
      n.kind === "counter" ||
      n.kind === "mutex" ||
      n.kind === "judge" ||
      n.kind === "task")
  );
}
function hasFixedInPorts(n) {
  return !!(
    n &&
    (n.kind === "gate" ||
      n.kind === "mutex" ||
      n.kind === "music_gen" ||
      n.kind === "tts_gen" ||
      n.kind === "video_gen" ||
      n.kind === "remotion" ||
      n.kind === "task" ||
      n.kind === "super" ||
      n.kind === "net_send" ||
      /* 素材节点：端子号 = 内容条目序号，断一条线绝不能把后面的端子号左移（会串条目） */
      n.kind === "asset" ||
      isFnToolNode(n))
  );
}
function wireFromIsControl(w, wf) {
  wf = wf || S.wf;
  if (!w) return false;
  const from = nodeByIdIn(w.from, wf);
  if (!from) return false;
  if (isControlKind(from)) return true;
  /* 网络·接收：端口1 为控制输出（收到消息时触发控制信号） */
  if (from.kind === "net_recv" && Number(w.fromIndex || 0) >= 1) return true;
  /* 音乐 / 视频 / 语音 / Remotion：端口1 为控制输出（生成完成后触发下游控制目标） */
  if (
    (from.kind === "music_gen" ||
      from.kind === "tts_gen" ||
      from.kind === "video_gen" ||
      from.kind === "remotion") &&
    Number(w.fromIndex || 0) >= 1
  )
    return true;
  /* 函数 / 工具节点：输出 0..n-1 = 各输出参数（数据），末位 = 控制输出（端子契约见下） */
  if (fnToolOutPortIsControl(from, w.fromIndex)) return true;
  const to = nodeByIdIn(w.to, wf);
  if (!to) return false;
  /* 内侧桥接：外侧同号输入若为控制，则内线亦为控制（原数据线随之变控制线） */
  if (from.kind === "super" && nodeParentSuperId(to) === from.id) {
    return superInPortIsControl(from, w.fromIndex, wf);
  }
  /* 外侧输出：内侧同号汇流来自控制时，外线亦为控制 */
  if (from.kind === "super" && nodeParentSuperId(to) !== from.id) {
    return superOutPortIsControl(from, w.fromIndex, wf);
  }
  return false;
}
/* 数据输入（不含控制节点连入的指挥线；关系线不参与数据流） */
function wiresTo(id) {
  return S.wf.wires
    .filter((w) => w.to === id && !w.rel && !wireFromIsControl(w))
    .sort((a, b) => a.toIndex - b.toIndex);
}
/* 全部输入连线（含控制线，用于端子占位；关系线不占端子） */
function allWiresTo(id) {
  return S.wf.wires
    .filter((w) => w.to === id && !w.rel)
    .sort((a, b) => a.toIndex - b.toIndex);
}
function hasOutput(n) {
  return outputCount(n) > 0;
}
function isTextSource(n) {
  return (
    n.kind === "input_text" ||
    n.kind === "proc_text" ||
    n.kind === "agent_task" ||
    n.kind === "merge" ||
    n.kind === "split" ||
    /* 音视频输入：输出的是该文件的 URL，本质就是一段可用的文件地址文本
       （与 music_gen / video_gen 把产物路径当文本对外同口径），可进文本 / 媒体路径端子 */
    n.kind === "input_audio" ||
    n.kind === "input_video" ||
    n.kind === "music_gen" ||
    n.kind === "tts_gen" ||
    n.kind === "video_gen" ||
    n.kind === "remotion" ||
    n.kind === "super" ||
    n.kind === "function" ||
    isToolNode(n)
  );
}
function isImageSource(n) {
  return (
    n.kind === "input_image" ||
    n.kind === "proc_image" ||
    n.kind === "merge" ||
    n.kind === "split"
  );
}
/* 连线着色：从图像类节点拉出的数据线（控制线仍用金色）。
   工具 / 函数节点没有「图像类 kind」可看，改按真正接出来的那个端子的声明类型判定；
   素材节点同理 —— 整节点既可能是文本也可能是图像，只有条目端子说得清（assetPortKind）。
   其余节点仍只看源节点 kind（行为逐字不变）。 */
function isImageWireFrom(n, fromIndex) {
  if (!n) return false;
  if (isFnToolNode(n) || isAssetNode(n))
    return wireSourceMediaType(n, fromIndex) === "image";
  return n.kind === "input_image" || n.kind === "proc_image";
}
function isAudioWireFrom(n, fromIndex) {
  if (!n) return false;
  if (isFnToolNode(n) || isAssetNode(n))
    return wireSourceMediaType(n, fromIndex) === "audio";
  return (
    n.kind === "music_gen" ||
    n.kind === "tts_gen" ||
    n.kind === "input_audio"
  );
}
function isVideoWireFrom(n, fromIndex) {
  if (!n) return false;
  if (isFnToolNode(n) || isAssetNode(n))
    return wireSourceMediaType(n, fromIndex) === "video";
  return (
    n.kind === "video_gen" ||
    n.kind === "remotion" ||
    n.kind === "input_video"
  );
}

/* ── 工具节点 / 函数节点：单一真源判定与参数模型（渲染层全量契约见 docs/tool-function-nodes.md）
   ① 工具节点 = 超级节点变体 kind super + tool:true（沿用 db:/dev: 变体模式），因此白得
      超级节点的整套子画布能力（展开壳 / 进入 / 拖入收纳 / 内外桥接 / 尺寸）。引擎按
      isToolNode() 分发（不再看 kind 字面值）；旧存档的普通 kind "tool" 在加载 / 插入时
      经 migrateToolNodeToSuperForm() 一次性原地转成该变体（见 migrateWf 与 app-tools.js）。
      两类形态统一以 toolConfig{name,description,inputs,outputs} 存储，参数增删即端子增删
      （端子数以参数为准，与画布连线无关），标题默认 = 工具名、手动改名后 name 独立。
   ② 函数节点 = 普通 kind "function"；字段 fnName/description/jscode/inputs/outputs。
   两类共享同一份参数条目模型 [{name, kind}]，kind ∈ text | image（缺省 text）。 */
function isToolNode(n) {
  return !!(
    n &&
    ((n.kind === "super" && !!n.tool && !n.db) || n.kind === "tool")
  );
}
/* 工具节点形态归一（一次性 · 幂等）：旧 kind:"tool" 节点原地转成 super + tool:true 变体。
   只改「形态字段」：id / 标题 / 坐标 / 尺寸 / toolConfig / toolLibId / 父子归属
   （parentSuperId 与其内部子节点）一律原样保留，连线两端仍是同一批 id 与端子序号，
   所以既不需要改写连线，也不会改动画布内容。已是新形态（或不是工具节点）时返回 false。 */
function migrateToolNodeToSuperForm(n) {
  if (!n || n.kind !== "tool") return false;
  n.kind = "super";
  /* 超级壳层字段以 NODE_DEFAULTS.super 为准补缺（已有值一律保留 → 重复调用无副作用） */
  for (const [k, v] of Object.entries(NODE_DEFAULTS.super || {})) {
    if (k === "w" || k === "h" || k === "title") continue;
    if (n[k] === undefined) n[k] = JSON.parse(JSON.stringify(v));
  }
  n.tool = true;
  return true;
}
function isFunctionNode(n) {
  return !!n && n.kind === "function";
}
function isFnToolNode(n) {
  return isToolNode(n) || isFunctionNode(n);
}
/* ── 端子契约（参数优先）：工具 / 函数节点的端子数与性质由 toolConfig 参数钉死，
   与画布连线无关 —— 输入 0 = 控制入、1..N = 各输入参数；输出 0..M-1 = 各输出参数、
   M（末位）= 控制出。普通超级节点的端子随连线伸缩、控制性由连线推断（见下方
   superInPortIsControl / superOutPortIsControl），工具节点必须改按序号固定判定，
   否则展开子画布后内侧桥接 / 汇流端子的控制色与取数通道会随连线漂移。 */
function fnToolInPortIsControl(node, i) {
  return isFnToolNode(node) && Number(i || 0) === 0;
}
function fnToolOutPortIsControl(node, i) {
  if (!isFnToolNode(node)) return false;
  return Number(i || 0) >= fnToolParamList(node, "out").length;
}
/** 某个端子是否已被「外侧输入线」占用（内侧汇流同样 to=宿主，superExternalInWiresAll 已排除） */
function fnToolInPortOccupied(host, idx) {
  return superExternalInWiresAll(host).some(
    (w) => Number(w.toIndex) === idx,
  );
}
/** 某个输出端子是否已被「内侧汇流线」占用 */
function fnToolOutPortOccupied(host, idx) {
  return superInternalOutFeedsAll(host).some(
    (w) => Number(w.toIndex) === idx,
  );
}
/** 固定端子节点的下一个空闲端子；无空闲返回 null。
    dir = "in"：外侧输入（wantCtrl = 控制线 → 端口0；数据线 → 参数端子 1..N）
    dir = "out"：内侧汇流到外侧输出（wantCtrl → 末位控制出；数据 → 输出参数 0..M-1） */
function fnToolFreePortIndex(host, dir, wantCtrl) {
  if (!host || !isFnToolNode(host)) return null;
  const nIn = fnToolParamList(host, "in").length;
  const nOut = fnToolParamList(host, "out").length;
  if (dir === "in") {
    if (wantCtrl) return fnToolInPortOccupied(host, 0) ? null : 0;
    for (let i = 1; i <= nIn; i++) if (!fnToolInPortOccupied(host, i)) return i;
    return null;
  }
  if (wantCtrl)
    return fnToolOutPortOccupied(host, nOut) ? null : nOut;
  for (let i = 0; i < nOut; i++) if (!fnToolOutPortOccupied(host, i)) return i;
  return null;
}
/** 子画布内侧端子（桥接 / 汇流）的徽标与提示：工具节点显示参数名 —— 参数名即端子名；
    普通超级节点仍显示「端子 N」。dir = "in"（外侧输入 → 内侧桥接）/ "out"（内侧汇流 → 外侧输出）。 */
function superInnerPortInfo(host, dir, i) {
  const idx = Number(i || 0);
  const n = idx + 1;
  const fixed = isFnToolNode(host);
  const pl = fixed ? fnToolParamList(host, dir) : [];
  const ctrl = fixed
    ? dir === "in"
      ? idx === 0
      : idx >= pl.length
    : dir === "in"
      ? superInPortIsControl(host, idx)
      : superOutPortIsControl(host, idx);
  const pname =
    fixed && !ctrl
      ? String((pl[dir === "in" ? idx - 1 : idx] || {}).name || "")
      : "";
  const base =
    dir === "in"
      ? I18n.t("内侧输入端子 ") + n
      : I18n.t("内侧输出端子 ") + n;
  /* 工具 / 函数节点的内侧端子同样是「参数即端子」：提示里带上数据类型，
     控制端子无声明（fnToolPortKind 返回 null）→ 不标注，普通超级节点行为不变 */
  const pk = fixed && !ctrl ? fnToolPortKind(host, dir, idx) : null;
  const tail =
    dir === "in"
      ? I18n.t("（对应外侧输入 · 拖到内部节点 · 右键移除）")
      : I18n.t("（对应外侧输出 · 从内部节点拖入 · 右键移除）");
  return {
    ctrl: ctrl,
    img: pk === "image",
    badge: fixed ? (ctrl ? I18n.t("控制") : clipStr(pname || String(n), 8)) : "",
    title:
      base +
      (pname ? I18n.t(" · 参数：") + pname : "") +
      (pk === "image" ? I18n.t("（图像）") : pk === "text" ? I18n.t("（文本）") : "") +
      tail,
  };
}
/* 参数表（只读视图）：dir = "in"（inputs）/ "out"（outputs）；两类都读 inputs/outputs 数组 */
function fnToolParamList(node, dir) {
  const key = dir === "in" ? "inputs" : "outputs";
  if (isFunctionNode(node)) return Array.isArray(node[key]) ? node[key] : [];
  if (isToolNode(node)) {
    const c =
      node.toolConfig && typeof node.toolConfig === "object"
        ? node.toolConfig
        : {};
    return Array.isArray(c[key]) ? c[key] : [];
  }
  return [];
}

/* ── 参数重排（需求：工具 / 函数节点允许调整输入输出参数顺序） ──
 * 参数即端子：inputs[i] ↔ 外侧输入端子 i+1、outputs[j] ↔ 输出端子 j。
 * 把某一参数从 from 移到 to（数组下标，to = 移入后的位置；支持上移 / 下移 /
 * 拖动 insert 整段移位）后，凡指向该节点的数据线要按「参数跟端子走」重映射端子号，
 * 否则换序只改了名字、线仍连旧端子 —— 语义错位。重映射口径：
 *   输入方向（dir="in"）：线 to === node.id，数据端子号 ∈ 1..N → 依 perm 重映射；
 *   输出方向（dir="out"）：线 from === node.id，数据端子号 ∈ 0..M-1 → 依 perm 重映射。
 * 控制端子（输入 0 / 输出末位）、关系线、与该节点无关的线一律不动；
 * 超级壳（工具节点变体）内侧桥接 / 汇流线同样按端子号重映射（另一头是否壳内子节点
 * 不影响「端子号 = 参数位置」的语义）。返回 perm（oldIdx → newIdx）供冒烟断言；
 * S.wf 缺失（纯数据环境）时仍返回 perm，只是不真正改线。 */
function fnToolMoveParam(node, dir, from, to) {
  const list = fnToolParamList(node, dir);
  const n = list.length;
  const f = Number(from);
  const t = Number(to);
  if (!node || !isFnToolNode(node) || !n) return null;
  if (!isFinite(f) || f < 0 || f >= n) return null;
  if (!isFinite(t) || t < 0 || t >= n) return null;
  if (f === t) return null;
  /* perm[oldIdx] = newIdx：把旧下标 f 的元素移到新下标 t，中间元素顺移一格 */
  const perm = [];
  for (let i = 0; i < n; i++) {
    if (i === f) perm[i] = t;
    else if (f < t && i > f && i <= t) perm[i] = i - 1;
    else if (f > t && i >= t && i < f) perm[i] = i + 1;
    else perm[i] = i;
  }
  /* 真正改参数表 */
  const item = list.splice(f, 1)[0];
  list.splice(t, 0, item);
  fnToolRemapParamWires(node, dir, n, perm);
  return perm;
}

/* 参数重排后按 perm（oldIdx → newIdx）重映射节点数据线端子号。
 * 工具节点 = 超级壳变体，同一节点上有四类线都要按端子号跟参数走：
 *   ① 外侧输入：w.to === node.id（来源非壳内子节点）→ toIndex ∈ 1..N（dir in）
 *   ② 内侧桥接：w.from === node.id 且目标是壳内子节点 → fromIndex ∈ 1..N（dir in）
 *   ③ 外侧输出：w.from === node.id（目标非壳内子节点）→ fromIndex ∈ 0..M-1（dir out）
 *   ④ 内侧汇流：w.to === node.id 且来源是壳内子节点 → toIndex ∈ 0..M-1（dir out）
 * 函数节点无壳，只命中 ①③。控制端子（输入 0 / 输出末位）、关系线不参与。
 * 纯函数：不依赖 UI，S.wf 存在才实际改写线；返回是否改过。 */
function fnToolRemapParamWires(node, dir, n, perm) {
  if (!node || !S.wf || !Array.isArray(S.wf.wires)) return false;
  const wires = S.wf.wires;
  let changed = false;
  for (const w of wires) {
    if (!w || w.rel) continue;
    const isIn = dir === "in";
    const from = nodeByIdIn(w.from, S.wf);
    const to = nodeByIdIn(w.to, S.wf);
    const fromIsInner = !!(
      from && isFnToolNode(node) && nodeParentSuperId(from) === node.id
    );
    const toIsInner = !!(
      to && isFnToolNode(node) && nodeParentSuperId(to) === node.id
    );
    if (isIn) {
      /* ① 外侧输入：数据端子号 1..N */
      if (!fromIsInner && w.to === node.id) {
        const t = Number(w.toIndex) || 0;
        if (t < 1 || t > n) continue;
        const nv = Number(perm[t - 1]) + 1;
        if (nv !== t) {
          w.toIndex = nv;
          changed = true;
        }
        continue;
      }
      /* ② 内侧桥接（宿主输入端子 → 壳内子节点） */
      if (toIsInner && w.from === node.id) {
        const t = Number(w.fromIndex) || 0;
        if (t < 1 || t > n) continue;
        const nv = Number(perm[t - 1]) + 1;
        if (nv !== t) {
          w.fromIndex = nv;
          changed = true;
        }
        continue;
      }
    } else {
      /* ③ 外侧输出：数据端子号 0..M-1 */
      if (!toIsInner && w.from === node.id) {
        const t = Number(w.fromIndex) || 0;
        if (t < 0 || t >= n) continue;
        const nv = Number(perm[t]);
        if (nv !== t) {
          w.fromIndex = nv;
          changed = true;
        }
        continue;
      }
      /* ④ 内侧汇流（壳内子节点 → 宿主输出端子） */
      if (fromIsInner && w.to === node.id) {
        const t = Number(w.toIndex) || 0;
        if (t < 0 || t >= n) continue;
        const nv = Number(perm[t]);
        if (nv !== t) {
          w.toIndex = nv;
          changed = true;
        }
        continue;
      }
    }
  }
  return changed;
}
/** 端子数据类型（单一真源）：dir = "in" / "out"，idx = 端子序号（按端子契约数端子）。
    工具 / 函数节点的数据端子返回其声明类型 "text" | "image"（条目缺 kind 按 text，与旧画布口径一致）；
    控制端子（输入 0、输出末位）以及不是这两类节点的端子一律返回 null = 无端子级类型声明，
    调用方须回落到「按节点 kind / 该端子实际值推断」的旧口径（普通节点行为逐字不变）。 */
function fnToolPortKind(node, dir, idx) {
  if (!isFnToolNode(node)) return null;
  const i = Number(idx || 0);
  const list = fnToolParamList(node, dir === "in" ? "in" : "out");
  let e = null;
  if (dir === "in") {
    if (i > 0) e = list[i - 1]; /* 输入端子 0 = 控制入 → 无类型声明 */
  } else if (i < list.length) {
    e = list[i]; /* 输出端子末位 = 控制出 → 无类型声明 */
  }
  if (!e) return null; /* 控制端子 / 越界 */
  return String(e.kind || "text") === "image" ? "image" : "text";
}
/** 端子是否「列表端子」（该端子的值是一组值，供下游逐项展开）—— 连线校验与取值的唯一真源。
    与 fnToolPortKind 完全同一数端子口径：输入 0 = 控制入、1..N = 各输入参数；
    输出 0..M-1 = 各输出参数、末位 = 控制出。控制端子 / 越界 / 非工具·函数节点 → false。
    输出方向恒 false：list 只是输入侧的取值语义，归一时已从输出参数上清掉，这里再挡一道，
    免得旧数据把「参数即端子」的列表语义曲解到输出方向。 */
function fnToolPortIsList(node, dir, idx) {
  if (!isFnToolNode(node) || dir !== "in") return false;
  const i = Number(idx || 0);
  if (i <= 0) return false; /* 输入端子 0 = 控制入，无列表语义 */
  const e = fnToolParamList(node, "in")[i - 1];
  return !!(e && e.list === true);
}
/* 端子值 ↔ 端子声明类型的唯一归一处（只做形状转换，不吞数据）：工具 / 函数节点、
   Agent func-call、「测试」台注入、超级壳层内外桥接全部复用这一份，不再各写一套。
   · 声明 image，实际拿到的是路径文本（"E:\a.png" / {kind:"text",text:"E:\a.png"} /
     {kind:"path",path}）→ 转 {kind:"image",path,text}，下游保存节点与图像端子才认它是图像；
     opts.loose = true（注入点口径：参数类型是定义里写明的，字符串一律按路径收下）时
     不检查扩展名，否则只认图像扩展名 —— 不把散文臆造成图像。
   · 声明 text，实际拿到图像值 → 取其路径作文本（fix = "text"：形状降级，调用方据此
     在节点摘要提示一句，路径本身不丢）。
   · 值本身为空、端子无声明（普通节点 / 控制端子 / 旧画布）、音频 / 视频值（参数类型域
     只有 text|image）一律原样返回：不改既有非工具节点路径，也不吞媒体数据。
   返回 { value, fix }：fix = "" | "image"（文本→图像，补齐形状）| "text"（图像→文本，降级）。 */
const FN_TOOL_IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i; /* 与 js-exec mediaKindOfPath / inferMediaFromSource 同一图像扩展名口径 */
function normPortValueByKind(value, kind, opts) {
  const res = { value: value, fix: "" };
  const o = opts || {};
  if (value == null) return res;
  if (kind !== "image" && kind !== "text") return res;
  const obj = typeof value === "object" ? value : null;
  const vk = obj ? String(obj.kind || "") : "";
  /* 音视频不在参数类型域内：原样放行，别把媒体压成文本 */
  if (vk === "audio" || vk === "video") return res;
  const s = obj
    ? String(obj.path != null && obj.path !== "" ? obj.path : obj.text != null ? obj.text : "")
    : String(value);
  if (kind === "image") {
    if (vk === "image") return res; /* 已是图像端子值 */
    const t = s.trim();
    if (!t) return res;
    if (!o.loose && !FN_TOOL_IMG_EXT_RE.test(t)) return res;
    res.value = { kind: "image", path: t, text: t };
    res.fix = "image";
    return res;
  }
  /* kind === "text" */
  if (!obj) {
    /* 裸标量（数字 / 布尔 / 字符串）→ 文本端子值形状 */
    res.value = { kind: "text", text: String(value) };
    return res;
  }
  if (vk === "image") {
    res.value = { kind: "text", text: s };
    res.fix = "text";
    return res;
  }
  return res;
}
/** 按「工具 / 函数节点某个端子的声明类型」归一值：无声明（普通节点 / 控制端子 /
    越界）时原样返回，保证普通链路逐字不变。dir = "in" | "out"，idx = 端子序号。 */
function normFnToolPortValue(node, dir, idx, value, opts) {
  const k = fnToolPortKind(node, dir, idx);
  if (!k) return { value: value, fix: "" };
  return normPortValueByKind(value, k, opts);
}
/* 归一提示：只有「图像值被降级成路径文本」这类用户会察觉的形状变化才记一笔
   （文本→图像是补齐，不打扰）。transient 字段 _portKindFix = [文案…]，节点摘要读取。 */
function notePortKindFix(node, dir, idx, fix, name) {
  if (!node || fix !== "text") return;
  const pn = String(name || "").trim() || I18n.t("参数 ") + (Number(idx) + 1);
  const msg = I18n.t("「{p}」是文本端子，收到的图像已按其路径取文本", { p: pn });
  if (!Array.isArray(node._portKindFix)) node._portKindFix = [];
  if (node._portKindFix.indexOf(msg) < 0) node._portKindFix.push(msg);
  while (node._portKindFix.length > 4) node._portKindFix.shift();
}
/* 单条参数归一：确保 {name, kind[, list]}，name 空补默认名，kind 只认 text|image（缺省 text）。
   dir = "in" 时保留 list 布尔（列表入参：一条线喂一组值，供 fnToolPortIsList 判定）；
   dir = "out"（含省略）时一律清掉 list —— 列表只是输入侧的取值语义，输出方向「参数即端子」
   的端子表必须与 kind 一一对应，留着它会让输出端子被曲解成可展开的多值端子。 */
function normFnToolEntry(e, i, dir) {
  if (e == null || typeof e !== "object") e = {};
  const name = String(e.name == null ? "" : e.name).trim();
  let kind = String(e.kind || "text");
  if (kind !== "image") kind = "text";
  const p = { name: name, kind: kind };
  if (dir === "in") p.list = e.list === true || e.list === "true";
  return p;
}
/* 结构归一（幂等）：工具节点补 toolConfig，函数节点补字符串/数组字段；
   两类节点的参数条目走完全同一口径归一 —— 缺失 name 补「参数 N」占位，kind 只留
   text|image，list 只在输入侧保留、输出侧清掉（判定真源见 fnToolPortIsList）。 */
function ensureFnToolNodeState(node) {
  if (!node) return;
  if (isFunctionNode(node)) {
    if (typeof node.fnName !== "string") node.fnName = "";
    if (typeof node.description !== "string") node.description = "";
    if (typeof node.jscode !== "string") node.jscode = "";
    /* 「测试」台输入快照：按输入参数序号存字符串（text 参数 = 文本，image 参数 =
       文件路径）。仅测试用 · 不参与画布运行；参数增删不清空，重新加回同名参数时
       旧值仍在（超出参数数的尾巴只是暂存，永不参与取数）。 */
    if (!Array.isArray(node.fnTestInputs)) node.fnTestInputs = [];
    if (!Array.isArray(node.inputs)) node.inputs = [];
    if (!Array.isArray(node.outputs)) node.outputs = [];
    node.inputs = node.inputs.map((e, i) => {
      const p = normFnToolEntry(e, i, "in");
      if (!p.name) p.name = I18n.t("参数 ") + (i + 1);
      return p;
    });
    node.outputs = node.outputs.map((e, i) => {
      const p = normFnToolEntry(e, i, "out");
      if (!p.name) p.name = I18n.t("参数 ") + (i + 1);
      return p;
    });
  } else if (isToolNode(node)) {
    /* 「试跑」台输入快照（与函数节点 fnTestInputs 同机制 · 独立字段）：
       按输入参数序号存字符串，仅测试用 · 不参与画布运行。 */
    if (!Array.isArray(node.toolTestInputs)) node.toolTestInputs = [];
    const c =
      node.toolConfig && typeof node.toolConfig === "object"
        ? node.toolConfig
        : {};
    if (typeof c.name !== "string") c.name = "";
    if (typeof c.description !== "string") c.description = "";
    if (!Array.isArray(c.inputs)) c.inputs = [];
    if (!Array.isArray(c.outputs)) c.outputs = [];
    c.inputs = c.inputs.map((e, i) => {
      const p = normFnToolEntry(e, i, "in");
      if (!p.name) p.name = I18n.t("参数 ") + (i + 1);
      return p;
    });
    c.outputs = c.outputs.map((e, i) => {
      const p = normFnToolEntry(e, i, "out");
      if (!p.name) p.name = I18n.t("参数 ") + (i + 1);
      return p;
    });
    node.toolConfig = c;
  }
}
/* 工具名与标题联动：设置里改 toolConfig.name 时，只要标题还是旧名（或尚未命名时的
   默认「工具[N]」）就同步改名，否则视为手动改过标题、name 独立。 */
function applyToolConfigName(node, name) {
  if (!isToolNode(node)) return;
  ensureFnToolNodeState(node);
  const c = node.toolConfig;
  const old = c.name;
  const next = String(name == null ? "" : name).trim();
  c.name = next;
  if (!next) return;
  const titleNow = String(node.title || "");
  const isDefaultTitle = titleNow === old || (!old && /^工具(\s\d+)?$/.test(titleNow));
  if (isDefaultTitle) {
    if (titleNow !== next) {
      const want = uniqueNodeTitle(next, node.id);
      if (want !== node.title) {
        node.title = want;
        toast(I18n.t("已同步标题：") + node.title, "ok");
      }
    }
  }
}
function canUseGlobalRefs(node) {
  return !!(
    node &&
    (node.kind === "proc_text" ||
      node.kind === "proc_image" ||
      node.kind === "agent_task" ||
      node.kind === "judge")
  );
}

function usesGlobalRefs(node) {
  return canUseGlobalRefs(node) && !!node.globalRefs;
}

function toggleNodeGlobalRefs(node) {
  if (!canUseGlobalRefs(node)) return false;
  if (node.running) {
    toast(I18n.t("请先终止当前运行"), "warn");
    return false;
  }
  pushHistory();
  node.globalRefs = !node.globalRefs;
  clearDownstream(node.id);
  scheduleSave(true);
  renderCanvas();
  toast(
    node.globalRefs
      ? I18n.t("已引用全局节点")
      : I18n.t("已关闭全局节点引用"),
    "ok",
  );
  return true;
}

function isRefableSource(n) {
  return !!(n && (isTextSource(n) || isImageSource(n)));
}

function globalRefSources(exceptId) {
  const out = [];
  const seen = new Set();
  for (const g of (S.wf && S.wf.nodes) || []) {
    if (!g || g.kind !== "global") continue;
    for (const w of wiresTo(g.id)) {
      const n = nodeById(w.from);
      if (!n || seen.has(n.id) || n.id === exceptId) continue;
      if (!isRefableSource(n)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

/* ===== @ 引用切词（标题 / 标签可以含空格的唯一真源）=====
   节点标题与 Tag 都可能带空格（重名自动编号本身就是「文本节点 2」），而旧写法
   一律 `/@([^\s@，。；、！？：,!?;:]+)/`「遇空格就断」，于是 @文本节点 2 只切出
   「文本节点」→ 走前缀兜底时撞上另一个同前缀节点（错误引用），写回整条标题后
   剩下的「 2」还留在正文里（回显与实发都多出一截残渣）。统一改成 atMentionsOf：
     1 整名优先：@ 之后能整段等上某个已知候选名（标题 / Tag；名字里的空格在正文里
       可多可少可省略，但 @ 与首字之间不许插空格）→ 连空格一起消费掉。
       不含空格的名字要求右邻是分隔符 / 结尾，免得 @图片处理 被切成 @图片。
     2 半截标题：整名等不上时按旧口径切非空白 token；若它正好是某个候选名的开头，
       且正文接着把剩下的字也写完了 → 一并消费（不再留残渣）。
     3 都没命中：保留旧的短 token，交给调用方按「全等 → 去尾标点 → 前缀」判一次，
       判不中就报未解析。
   resolveRefs / resolveRefsAgg / 提示词高亮 / 节点浏览态高亮 / 明文 @ 命中判定 /
   !@数据库 引用全部走这里，避免各处各写一套切词又互相对不上。 */
const AT_REF_STOP = /[^\s@，。；、！？：,!?;:]/;
const AT_REF_EDGE = /[\s@，。；、！？：,!?;:()（）"'「」【】]/;
const AT_REF_WS_TEXT = /[ \t]/;

/* 候选名表：去空去重，长的排前面（「素材 备份」不能输给「素材」） */
function atRefNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const n = String(raw == null ? "" : raw).trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.sort((a, b) => b.length - a.length);
}

/* 某个消费者可用的候选名 = 引用候选标题 + 本画布 Tag 目录 */
function atRefNamesFor(cands) {
  const list = [];
  for (const c of Array.isArray(cands) ? cands : []) list.push(c && c.title);
  for (const t of wfTagCatalog()) list.push(t);
  return atRefNames(list);
}

/* 从 s[from] 起按候选名逐字比对：skip = 正文里已经打出来的非空格字数；
   名字里的空格在正文里可多可少（lead 为真时才允许开头就空着，用于半截标题续接）。
   返回消费到的末尾下标，对不上返回 -1。换行永远不参与跳过（引用不跨行）。 */
function atRefSpanEnd(s, from, name, skip, lead) {
  const chars = Array.from(String(name || ""));
  let i = 0;
  while (i < chars.length && skip > 0) {
    if (!/\s/.test(chars[i])) skip--;
    i++;
  }
  if (skip > 0) return -1;
  let p = from;
  for (; i < chars.length; i++) {
    if (/\s/.test(chars[i])) continue;
    if (p > from || lead)
      while (p < s.length && AT_REF_WS_TEXT.test(s.charAt(p))) p++;
    if (s.charAt(p) !== chars[i]) return -1;
    p++;
  }
  return p > from ? p : -1;
}

/* 扫出正文里所有 @ 引用（opts.bang = 只认 !@数据库标题，span 含前面的 !）。
   返回按出现顺序的 [{ start, end, name, token }]：name = 命中的候选名原文，
   没命中时为空串、token 退回旧的「到第一个空白 / 标点为止」片段。 */
function atMentionsOf(text, names, opts) {
  const s = String(text == null ? "" : text);
  const out = [];
  if (s.indexOf("@") < 0) return out;
  const bang = !!(opts && opts.bang);
  const list = atRefNames(names).map((n) => ({
    name: n,
    hasWs: /\s/.test(n),
    head: Array.from(n)
      .filter((ch) => !/\s/.test(ch))
      .join(""),
  }));
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf("@", i);
    if (at < 0) break;
    if (bang && s.charAt(at - 1) !== "!") {
      i = at + 1;
      continue;
    }
    const start = bang ? at - 1 : at;
    const from = at + 1;
    let hit = null;
    for (const c of list) {
      const end = atRefSpanEnd(s, from, c.name, 0, false);
      if (end < 0) continue;
      if (!c.hasWs && end < s.length && !AT_REF_EDGE.test(s.charAt(end)))
        continue;
      hit = { start, end, name: c.name, token: "" };
      break;
    }
    if (!hit) {
      let p = from;
      while (p < s.length && AT_REF_STOP.test(s.charAt(p))) p++;
      const tok = s.slice(from, p);
      if (!tok) {
        i = at + 1;
        continue;
      }
      const tailKey = tok; // 非空白 token，本身不含空格
      for (const c of list) {
        if (c.head.length <= tailKey.length || !c.head.startsWith(tailKey))
          continue;
        const end = atRefSpanEnd(s, p, c.name, tailKey.length, true);
        if (end < 0) continue;
        hit = { start, end, name: c.name, token: "" };
        break;
      }
      if (!hit) hit = { start, end: p, name: "", token: tok };
    }
    out.push(hit);
    i = hit.end;
  }
  return out;
}

/* 逐段走正文：普通文本交 onText（不传 = 原样），每段 @ 引用交 onMention(hit, rawSeg)，
   其返回值即替换文本（null / undefined = 原样保留那一段）。拼好整串返回。 */
function eachAtMention(text, names, onText, onMention, opts) {
  const s = String(text == null ? "" : text);
  const plain = (seg) => (onText ? String(onText(seg)) : seg);
  const hits = atMentionsOf(s, names, opts);
  if (!hits.length) return plain(s);
  let out = "";
  let last = 0;
  for (const h of hits) {
    if (h.start > last) out += plain(s.slice(last, h.start));
    const seg = s.slice(h.start, h.end);
    const rep = onMention ? onMention(h, seg) : seg;
    out += rep == null ? seg : String(rep);
    last = h.end;
  }
  if (last < s.length) out += plain(s.slice(last));
  return out;
}

/* 只要替换逻辑的简写：fn(hit, rawSeg) 返回替换文本，或 null 保留原样 */
function mapAtMentions(text, names, fn, opts) {
  return eachAtMention(text, names, null, fn, opts);
}

/* ===== @ 明文引用命中判定（全局广播注入的唯一门槛）=====
   与 resolveRefs / resolveRefsAgg / promptRefBackdropHtml 用同一套切词（atMentionsOf）
   与同一套匹配规则（findCandidateByTitle / tagByAtToken + nodeHasTag），
   保证「提示词里明文 @ 命中的来源」与「实际被解析注入的来源」严格一致。 */
function atTokensOf(text, names) {
  return atMentionsOf(text, names).map((h) => h.name || h.token);
}

/* 从候选来源里只保留被明文 @ 命中的：@标题（含 resolveRefs 的「全等 → 去尾标点 → 前缀」三级规则）
   或 @Tag（该来源确实带这个 Tag）。返回顺序与入参一致，去重。 */
function mentionedRefSources(prompt, srcs) {
  const list = [];
  const dedup = new Set();
  for (const s of Array.isArray(srcs) ? srcs : []) {
    if (!s || !s.id || dedup.has(s.id)) continue;
    dedup.add(s.id);
    list.push(s);
  }
  if (!list.length) return [];
  const toks = atTokensOf(
    prompt,
    atRefNames(list.map((s) => s.title).concat(wfTagCatalog())),
  );
  if (!toks.length) return [];
  const out = [];
  for (const src of list) {
    let hit = false;
    for (const tok of toks) {
      if (findCandidateByTitle([src], tok)) {
        hit = true;
        break;
      }
      const tag = tagByAtToken(tok);
      if (tag && nodeHasTag(src, tag)) {
        hit = true;
        break;
      }
    }
    if (hit) out.push(src);
  }
  return out;
}

/* 本次运行真正应注入的全局来源：既要开着彩虹开关（globalRefs），
   也要在提示词/任务正文里明文 @ 命中，二者缺一律不注入。 */
function globalRefSourcesForRun(node, prompt) {
  if (!usesGlobalRefs(node)) return [];
  return mentionedRefSources(prompt, globalRefSources(node.id));
}

function wfTagCatalog() {
  if (!S.wf) return [];
  if (!Array.isArray(S.wf.tagCatalog)) S.wf.tagCatalog = [];
  return S.wf.tagCatalog;
}

function normalizeTagName(name) {
  return String(name == null ? "" : name).trim().replace(/\s+/g, " ");
}

function ensureTagInCatalog(name) {
  const t = normalizeTagName(name);
  if (!t) return "";
  const cat = wfTagCatalog();
  if (!cat.includes(t)) cat.push(t);
  return t;
}

function normalizeNodeTags(node) {
  if (!node) return [];
  if (!Array.isArray(node.tags)) node.tags = [];
  const seen = new Set();
  const out = [];
  for (const raw of node.tags) {
    const t = normalizeTagName(raw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  node.tags = out;
  return out;
}

function normalizeGlobalTagFilter(node) {
  if (!node || node.kind !== "global") return [];
  if (!Array.isArray(node.tagFilter)) node.tagFilter = [];
  const seen = new Set();
  const out = [];
  for (const raw of node.tagFilter) {
    const t = normalizeTagName(raw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  node.tagFilter = out;
  return out;
}

function nodeHasTag(node, tag) {
  const t = normalizeTagName(tag);
  return !!(t && normalizeNodeTags(node).includes(t));
}

function addTagToNode(node, tag) {
  const t = normalizeTagName(tag);
  if (!node || !t) return false;
  const list = normalizeNodeTags(node);
  if (list.includes(t)) return false;
  list.push(t);
  node.tags = list;
  return true;
}

function removeTagFromNode(node, tag) {
  const t = normalizeTagName(tag);
  if (!node || !t) return false;
  const list = normalizeNodeTags(node);
  const next = list.filter((x) => x !== t);
  if (next.length === list.length) return false;
  node.tags = next;
  return true;
}

function deleteTagEverywhere(tag) {
  const t = normalizeTagName(tag);
  if (!t || !S.wf) return;
  S.wf.tagCatalog = wfTagCatalog().filter((x) => x !== t);
  for (const n of S.wf.nodes || []) {
    removeTagFromNode(n, t);
    if (n.kind === "global") {
      n.tagFilter = normalizeGlobalTagFilter(n).filter((x) => x !== t);
    }
  }
}

function globalWiredSources(gNode) {
  const out = [];
  const seen = new Set();
  if (!gNode) return out;
  for (const w of wiresTo(gNode.id)) {
    const n = nodeById(w.from);
    if (!n || seen.has(n.id) || !isRefableSource(n)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

function globalDisplaySources(gNode) {
  const all = globalWiredSources(gNode);
  const filters = normalizeGlobalTagFilter(gNode);
  if (!filters.length) return all;
  return all.filter((n) => filters.some((t) => nodeHasTag(n, t)));
}

function stampTagsOntoGlobalWired(gNode, tags) {
  const list = (tags || []).map(normalizeTagName).filter(Boolean);
  if (!gNode || !list.length) return 0;
  let n = 0;
  for (const src of globalWiredSources(gNode)) {
    for (const t of list) {
      if (addTagToNode(src, t)) n++;
    }
  }
  return n;
}

function globalChipKindCls(n) {
  if (!n) return "proc";
  if (n.kind === "split") return "split";
  if (n.kind === "merge") return "merge";
  return nodeKindCls(n);
}

function inputCount(node) {
  /* 只读 / 需求等待 / 定时 / 起点 / 执行：无输入端子 */
  if (
    node.ro ||
    node.kind === "wait_file" ||
    node.kind === "timer" ||
    node.kind === "db_replica" ||
    node.kind === "execute" ||
    isExecStart(node)
  )
    return 0;
  /* 素材节点：输入端子 = 内容条目（第 i 入 ↔ 第 i 出 · 一个条目最多挂一条数据线），
     没有控制端子 → 与 input_* 同族：只当内容源，不参与控制流。 */
  if (node.kind === "asset") return assetItems(node).length;
  /* 函数 / 工具节点：输入 0 = 控制入（固定）+ 各输入参数（参数增删即端子增删） */
  if (isFnToolNode(node)) return fnToolParamList(node, "in").length + 1;
  if (node.kind === "super") {
    const open = superIsOpenShell(node);
    const ext = superExternalInWiresAll(node);
    const bridges = superInternalBridgeWiresAll(node);
    const maxExt = ext.reduce((m, w) => Math.max(m, Number(w.toIndex) || 0), -1);
    const maxBr = bridges.reduce(
      (m, w) => Math.max(m, Number(w.fromIndex) || 0),
      -1,
    );
    /* 收起时外部输入仅在内部已桥接时出现；展开时保留可连接的内侧槽 */
    const maxIdx = open ? Math.max(maxExt, maxBr) : maxBr;
    return superDynamicPortCount(maxIdx, open);
  }
  if (node.kind === "task") return 1;
  if (node.kind === "gate")
    return Math.max(2, Math.min(8, Math.round(Number(node.gateInputs) || 2)));
  if (node.kind === "mutex")
    return Math.max(2, Math.min(8, Math.round(Number(node.mutexInputs) || 2)));
  if (node.kind === "music_gen") return 3; /* 端口0=提示词 · 端口1=歌词 · 端口2=控制输入 */
  if (node.kind === "tts_gen") return 2; /* 端口0=待合成文本 · 端口1=控制输入 */
  if (node.kind === "video_gen") return videoGenInputCount(node) + 1; /* 端口0=控制输入（固定）· 端口1+=数据槽 */
  if (node.kind === "remotion") return 2; /* 端口0=控制输入（固定）· 端口1=描述文本输入 */
  if (node.kind === "net_recv") return 0; /* 接收是异步源，无数据输入 */
  if (node.kind === "net_send") return 2; /* 端口0=信息输入(数据) · 端口1=控制输入 */
  return Math.max(1, allWiresTo(node.id).length + 1);
}

/** MiniMax H3 端子：提示词 + 渐进参考图/视频/音频（路径文本） */
function videoGenMode(node) {
  return node && node.videoMode === "r2v" ? "r2v" : "fl2va";
}
function videoGenMaxImages(node) {
  return videoGenMode(node) === "fl2va" ? 2 : 9;
}
function videoGenMaxVideos(node) {
  return videoGenMode(node) === "r2v" ? 3 : 0;
}
function videoGenMaxAudios(node) {
  return videoGenMode(node) === "r2v" ? 3 : 0;
}
/* ───── 自建 ComfyUI 工作流模式：端口布局由 wfParams 驱动 ───── */
function isCustomVideoGen(node) {
  return !!(node && String(node.workflowId || "").trim());
}
/** 自定义模式素材类参数（按类型顺序映射到文件端口 2+） */
function videoGenWfFileParams(node) {
  const list = Array.isArray(node && node.wfParams) ? node.wfParams : [];
  return list.filter((p) => p && ["image", "video", "audio"].includes(String(p.type || "")));
}
/** 自定义模式文本参数（端口1 绑定；无则返回 null） */
function videoGenWfTextParam(node) {
  const list = Array.isArray(node && node.wfParams) ? node.wfParams : [];
  return list.find((p) => p && p.type === "text") || null;
}
function customWfInputCount(node) {
  const files = videoGenWfFileParams(node);
  const nImg = Math.min(9, files.filter((p) => p.type === "image").length);
  const nVid = Math.min(3, files.filter((p) => p.type === "video").length);
  const nAud = Math.min(3, files.filter((p) => p.type === "audio").length);
  return 1 + nImg + nVid + nAud; /* 端口0=控制 · 端口1=文本 · 端口2+=文件槽 */
}
function customWfSlotMeta(node, index) {
  if (index === 0) return { kind: "ctrl", key: "ctrl", label: "控制" };
  if (index === 1) {
    const tp = videoGenWfTextParam(node);
    return {
      kind: "text",
      key: tp ? String(tp.key || "wfText") : "wfText",
      label: tp ? clipStr(String(tp.label || tp.key), 6) : "提示词",
      param: tp,
    };
  }
  const files = videoGenWfFileParams(node);
  const p = files[index - 2];
  if (!p) return { kind: "text", key: "wfText", label: "提示词", param: null };
  return {
    kind: p.type === "image" ? "image" : p.type === "video" ? "video" : "audio",
    key: String(p.key || "p" + index),
    label: clipStr(String(p.label || p.key), 6),
    param: p,
  };
}
function videoGenSlotOccupied(node, index) {
  return (S.wf.wires || []).some(
    (w) => w.to === node.id && Number(w.toIndex) === index && !wireFromIsControl(w),
  );
}
function videoGenProgressiveCount(occupiedPrefix, max) {
  if (max <= 0) return 0;
  let n = 1;
  for (let i = 0; i < max - 1; i++) {
    if (occupiedPrefix(i)) n = i + 2;
    else break;
  }
  return Math.min(max, n);
}
function videoGenInputCount(node) {
  /* 返回数据槽总数（端口1=提示词 … 末尾=最后一个数据槽）；端口0 固定为控制输入 */
  if (isCustomVideoGen(node)) return customWfInputCount(node);
  const maxImg = videoGenMaxImages(node);
  const maxVid = videoGenMaxVideos(node);
  const maxAud = videoGenMaxAudios(node);
  const imgN =
    videoGenMode(node) === "fl2va"
      ? maxImg
      : videoGenProgressiveCount((i) => videoGenSlotOccupied(node, 2 + i), maxImg);
  const vidBase = 1 + maxImg;
  const vidN = videoGenProgressiveCount((i) => videoGenSlotOccupied(node, vidBase + 1 + i), maxVid);
  const audBase = 1 + maxImg + maxVid;
  const audN = videoGenProgressiveCount((i) => videoGenSlotOccupied(node, audBase + 1 + i), maxAud);
  return 1 + imgN + vidN + audN;
}
function videoGenSlotMeta(node, index) {
  /* 端口0 = 控制输入（固定，不随数据槽数变化）；端口1+ = 数据槽 */
  if (isCustomVideoGen(node)) return customWfSlotMeta(node, index);
  const maxImg = videoGenMaxImages(node);
  const maxVid = videoGenMaxVideos(node);
  if (index === 0) return { kind: "ctrl", key: "ctrl", label: "控制" };
  const i0 = index - 1;
  if (i0 === 0) return { kind: "text", key: "prompt", label: "P" };
  if (i0 >= 1 && i0 <= maxImg) {
    const i = i0 - 1;
    if (videoGenMode(node) === "fl2va") {
      return { kind: "image", key: i === 0 ? "first" : "last", label: i === 0 ? "F" : "L" };
    }
    return { kind: "image", key: "ref" + i, label: "I" + (i + 1) };
  }
  if (i0 > maxImg && i0 <= maxImg + maxVid) {
    const i = i0 - 1 - maxImg;
    return { kind: "video", key: "vid" + i, label: "V" + (i + 1) };
  }
  const i = i0 - 1 - maxImg - maxVid;
  return { kind: "audio", key: "aud" + i, label: "A" + (i + 1) };
}
/* 节点最小宽/高：保证标题栏按钮与体内控件不溢出到节点外（只抬不缩） */
function minWFor(n) {
  const k = n && n.kind;
  switch (k) {
    case "super_io":
      return 96;
    case "input_image":
      return 180;
    case "input_text":
      return 220;
    case "input_audio":
    case "input_video":
      return 260;
    case "proc_text":
    case "proc_image":
      return 360;
    case "agent_task":
      return 380;
    case "music_gen":
      return 320;
    case "tts_gen":
      return 320;
    case "video_gen":
      return 340;
    case "remotion":
      return 360;
    case "net_recv":
      return 300;
    case "net_send":
      return 320;
    case "task":
      return 280;
    case "global":
      return 260;
    case "save":
    case "save_text":
    case "save_image":
      return 280;
    case "judge":
      return 260;
    case "wait_file":
      return 280;
    case "super":
      return 240;
    default:
      return 240;
  }
}
function minHFor(n) {
  const k = n && n.kind;
  switch (k) {
    case "super_io":
      return 56;
    case "music_gen":
      return 220;
    case "tts_gen":
      return 220;
    case "video_gen":
      return 260;
    case "remotion":
      return 280;
    case "net_recv":
      return 130;
    case "net_send":
      return 140;
    case "agent_task":
      return 240;
    case "task":
      return 180;
    case "proc_text":
    case "proc_image":
      return 140;
    case "save":
    case "save_text":
    case "save_image":
      return 160;
    case "input_image":
      return 120;
    case "input_text":
      return 110;
    case "input_audio":
    case "input_video":
      return 170;
    case "global":
      return 120;
    case "wait_file":
      return 140;
    case "judge":
      return 120;
    case "super":
      /* 文件夹外观：标签页 + 大标题 + 描述小字 + 右下计数所需最小高度 */
      return 132;
    default:
      return 96;
  }
}
function clampNodeToMinSize(n) {
  if (!n) return;
  if (n.kind === "super" && superIsOpenShell(n)) {
    n.expandW = snapDim(Math.max(Number(n.expandW) || 0, 320), 320);
    n.expandH = snapDim(Math.max(Number(n.expandH) || 0, 220), 220);
    return;
  }
  const mw = minWFor(n);
  const mh = minHFor(n);
  n.w = snapDim(Math.max(Number(n.w) || 0, mw), mw);
  n.h = snapDim(Math.max(Number(n.h) || 0, mh), mh);
}
/** 挂载后按标题栏 / 体内行实测抬宽（只抬不缩），避免菜单钮或参数条溢出 */
function fitNodeChrome(el, n) {
  if (!el || !n || isPinnedCtrl(n)) return false;
  if (n.kind === "super" && superIsOpenShell(n)) return false;
  const head = el.querySelector(":scope > .n-head");
  let need = minWFor(n);
  if (head) {
    const TITLE_FLOOR = 40;
    const PAD = 16;
    const GAP = 6;
    let w = PAD;
    const kids = head.children;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.classList.contains("n-title")) w += TITLE_FLOOR;
      else w += Math.ceil(c.getBoundingClientRect().width);
      if (i) w += GAP;
    }
    need = Math.max(need, w + 4);
  }
  const body = el.querySelector(":scope > .n-body");
  if (body) {
    const row = body.querySelector(".mg-params");
    if (row) need = Math.max(need, Math.ceil(row.scrollWidth) + 20);
  }
  const mh = minHFor(n);
  let changed = false;
  if ((n.w || 0) < need) {
    n.w = snapDim(need, minWFor(n));
    el.style.width = n.w + "px";
    changed = true;
  }
  n._chromeMinW = need;
  if ((n.h || 0) < mh) {
    n.h = snapDim(mh, mh);
    el.style.height = n.h + "px";
    changed = true;
  }
  /* 超级节点文件夹标题：DOM 尺寸稳定后再按实测宽度缩字 */
  if (n.kind === "super") fitSuperFolderCard(el);
  return changed;
}
function mountNodeEl(parent, n) {
  const el = nodeElement(n);
  parent.appendChild(el);
  if (fitNodeChrome(el, n)) refreshPorts(el, n);
  return el;
}

/* ============ 多次尝试（attempts） ============ */

function attemptCount(n) {
  return Math.max(1, Math.min(10, Math.round(Number(n && n.attempts) || 1)));
}
function attemptIdx(n) {
  return Math.min(Math.max(0, (n && n.attemptIdx) || 0), attemptCount(n) - 1);
}
/* 某次尝试的结果槽：{output, batchOutputs, error, ranAt}。
   单次尝试（attempts<=1）兼容旧数据：节点自身即为结果槽。 */
function resultOf(n, i) {
  if (!n) return null;
  if (attemptCount(n) > 1) {
    const a = (n.attemptOutputs || [])[i];
    return a || null;
  }
  return n;
}
function selResult(n) {
  return resultOf(n, attemptIdx(n));
}

function toast(msg, kind) {
  const box = $("#toastBox");
  const d = document.createElement("div");
  d.className = "toast" + (kind ? " " + kind : "");
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 3400);
}

/* ===== 运行队列悬浮窗（左下：处理中 / 等待中） ===== */
function nodeKindCls(node) {
  if (!node) return "proc";
  if (node.kind === "proc_text" && node.agent) return "agent";
  /* 开发节点（super+dev）：队列行用独立 kind-dev 类（样式 + 标签） */
  if (node.kind === "super" && node.dev && !node.db) return "dev";
  /* 工具节点是超级变体，但队列 / 端子提示里的配色沿用迁移前的 proc（不当超级节点看） */
  if (isToolNode(node)) return KIND_CLS.tool || "proc";
  return KIND_CLS[node.kind] || "proc";
}
function nodeKindLabel(node) {
  if (!node) return "";
  if (node.kind === "proc_text" && node.agent) return I18n.t("智能");
  if (node.kind === "super" && node.dev && !node.db) return I18n.t("开发");
  /* 工具 / 函数节点：标签说清自己，不落到 map.super「超级节点」上 */
  if (isToolNode(node)) return I18n.t("工具");
  if (isFunctionNode(node)) return I18n.t("函数");
  const map = {
    proc_text: "文本处理",
    proc_image: "图像生成",
    agent_task: "智能任务",
    save: "保存",
    save_text: "保存",
    save_image: "保存",
    task: "任务",
    wait_file: "等待",
    timer: "定时",
    delayer: "延时",
    sequencer: "序列",
    gate: "闸门",
    splitter: "分发",
    counter: "计数",
    mutex: "互斥",
    control: "控制",
    judge: "判断",
    execute: "执行",
    input_text: "文本",
    input_image: "图像",
    input_audio: "音频",
    input_video: "视频",
    input_file: "文件",
    db_table: "表",
    global: "全局",
    music_gen: "Minimax Music 3",
    video_gen: "Minimax H3",
    tts_gen: "SoVITS 语音",
    remotion: "Remotion 视频",
    net_recv: "接收",
    net_send: "发送",
    super: "超级节点",
    super_io: "端口",
  };
  return I18n.t(map[node.kind] || "节点");
}

/* 菜单/节点 hover：短标题留在画面上，括号里的说明用于解释节点作用 */
function splitCtxParenLabel(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(.*?)(?:\s*[（(]([^）)]+)[）)])\s*$/);
  if (!m) return { label: t, hint: "" };
  const label = String(m[1] || "").trim();
  const hint = String(m[2] || "").trim();
  if (!label || !hint) return { label: t, hint: "" };
  return { label, hint };
}

function nodeKindPurposeKey(node) {
  if (!node) return "";
  if (node.kind === "proc_text" && node.agent) {
    return "智能任务（读文件 / 联网 / 执行命令）";
  }
  if (isToolNode(node)) return "工具节点（参数即端子 · 可展开子画布 · Agent 可调用）";
  if (node.kind === "control") return "";
  const map = {
    input_text: "输入节点（仅输出）",
    input_image: "输入节点（仅输出）",
    input_audio: "音频输入（输出该文件的 URL）",
    input_video: "视频输入（输出该文件的 URL）",
    asset: "素材节点（绑定素材库 · 内容条目即端子）",
    input_file: "文件节点（批量导入任意文件）",
    db_table: "表（读取文件 · agent 建表）",
    proc_text: "文本处理（LLM）",
    proc_image: "图像生成（文生图）",
    music_gen: "Minimax Music 3（音乐生成 · 提示词 + 歌词）",
    video_gen: "Minimax H3（视频生成 · 文本 / 图像 / 音频 / 视频）",
    tts_gen: "SoVITS 语音生成（文本转语音 · GPT-SoVITS）",
    remotion: "Remotion 视频（React 动效合成 · 本地渲染 mp4）",
    net_recv: "网络 · 接收（监听通道 · 异步转发收到的文本）",
    net_send: "网络 · 发送（把通道文本推送到远端）",
    execute: "执行节点（绑定可执行文件 · 一键启动）",
    function: "函数节点（JS 计算 · 参数即端子）",
    save: "保存（按输入自判文本 / 图像 / 音频 / 视频）",
    save_text: "保存（按输入自判文本 / 图像 / 音频 / 视频）",
    save_image: "保存（按输入自判文本 / 图像 / 音频 / 视频）",
    split: "拆分（批次 → 单项只读节点）",
    merge: "合并（多节点 → 批次）",
    agent_task: "智能任务（读文件 / 联网 / 执行命令）",
    task: "任务（规划 · 可进入分段解决）",
    super: "超级节点（收纳 · 展开子画布）",
    wait_file: "需求等待（监视文件）",
    timer: "定时触发器（计划 / Cron）",
    delayer: "延时器（等待后继续）",
    sequencer: "序列器（按序多路）",
    gate: "闸门（全部到达才放行）",
    splitter: "分发（并行多路）",
    counter: "计数（每 N 次放行）",
    mutex: "互斥（多入选一）",
    judge: "判断（是 / 否）",
    global: "全局节点（仅连入 · 点左上角彩虹图标引用）",
  };
  return map[node.kind] || "";
}

function nodeKindPurpose(node) {
  const key = nodeKindPurposeKey(node);
  if (!key) return "";
  return splitCtxParenLabel(I18n.t(key)).hint;
}

/* 开发节点在运行队列里的来源说明（自身 / 子节点 / 绑定会话 / 建议·问询调研），
   与画布呼吸灯/徽标的 devNodeRunningState 判定同源。
   wfNodes：跨画布条目要按「该节点归属的那张画布」扫后代与绑定会话（缺省 = 当前画布）。 */
function devRunStateText(node, wfNodes) {
  const st =
    typeof devNodeRunningState === "function"
      ? devNodeRunningState(node, wfNodes)
      : null;
  if (st === "self") return I18n.t("自身运行中");
  if (st === "desc") return I18n.t("子节点运行中");
  if (st === "sess") {
    /* 绑定会话在跑：副标题直接写具体开发内容（本次开发需求 / 细化范围），
       不再只写固定的「绑定会话运行中」；取不到需求行（旧会话 / 空要求）再回退固定文案 */
    const req = devRunningRequestText(node);
    if (req) return clipStr(req, 40);
    return I18n.t("绑定会话运行中");
  }
  if (st === "sug") {
    /* 只读调研：问询在跑显示「问询中」，否则按「建议调研中」；
       附上实时耗时与只读工具调用次数，让队列行本身就能看到进度 */
    const sugBusy =
      typeof devSuggestJobBusy === "function" ? devSuggestJobBusy(node) : null;
    const askBusy =
      typeof devAskJobBusy === "function" ? devAskJobBusy(node) : null;
    const busy = askBusy && !sugBusy ? askBusy : sugBusy;
    const prog = busy
      ? " · " + busy.elapsed + " · " + busy.toolCount + I18n.t(" 次只读调用")
      : "";
    return (askBusy && !sugBusy ? I18n.t("问询中") : I18n.t("建议调研中")) + prog;
  }
  return "";
}

/* 开发块 · 队列展示用的绑定会话：最近一个正在运行的开发 / 细化会话（全局会话表里找）。
   与 devNodeRunningState 的 sess 判定同源；运行队列的副标题与悬浮全文都从它身上取内容。
   口径 = sessionBusyForUi（自己那一轮 ∪ 名下计划并行组），并行组在跑时也要能取到
   这条会话，否则队列行只剩「绑定会话运行中」而拿不到具体开发需求。 */
function devRunningSessionOf(node) {
  if (!node) return null;
  const sessions = typeof agentSessions === "function" ? agentSessions() : [];
  for (const id of devSessionIdsOf(node)) {
    const st = sessions.find((s) => s && s.id === id);
    if (!st) continue;
    const busy =
      typeof sessionBusyForUi === "function"
        ? sessionBusyForUi(st)
        : typeof sessionIsRunning === "function"
          ? sessionIsRunning(st)
          : !!st.running;
    if (busy) return st;
  }
  return null;
}
/* 绑定会话的「具体开发内容」：开发会话取任务书里的「本次开发需求」行，
   细化会话取「用户指定的细化范围」行（由新到旧找第一条） */
function devRunningRequestText(node) {
  const sess = devRunningSessionOf(node);
  if (!sess) return "";
  const msgs = sess.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const req = devReqTextOfMessage(m);
    if (req) return req;
    const body = String(m.content || "");
    const scopePrefixes = [I18n.t("用户指定的细化范围："), "用户指定的细化范围："];
    for (const prefix of scopePrefixes) {
      const at = body.indexOf(prefix);
      if (at < 0) continue;
      const line = body.slice(at + prefix.length).split("\n")[0].trim();
      if (line) return line;
    }
  }
  return "";
}
/* 绑定会话的「全部用户输入」：首条关键输入（本次开发需求 / 细化范围）+ 会话中的后续追问，悬浮全文展示用 */
function devRunningUserInputText(node) {
  const sess = devRunningSessionOf(node);
  if (!sess) return "";
  const parts = [];
  for (const m of sess.messages || []) {
    if (!m || m.role !== "user") continue;
    const t = String(m.content || "").trim();
    if (t) parts.push(t);
  }
  return parts.join("\n\n");
}

function collectRunQueue() {
  const running = [];
  const waiting = [];
  const seen = new Set();
  const push = (n, list) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    list.push(n);
  };
  const nodes = (S.wf && S.wf.nodes) || [];
  for (const n of nodes) {
    if (n.running) push(n, running);
  }
  /* 开发节点（super+dev）：自身 / 后代节点 / 绑定会话任一运行 → 进「处理中」
     （与处理节点同款展示：点击定位、逐条停止；判定与画布呼吸灯/徽标同源） */
  if (typeof devRunningNodes === "function") {
    for (const n of devRunningNodes(nodes)) {
      if (!seen.has(n.id)) push(n, running);
    }
  }
  /* 后台画布上仍在跑的节点（跨工作流补跑时） */
  if (S.runPromises) {
    for (const id of S.runPromises.keys()) {
      if (seen.has(id)) continue;
      let n = nodeById(id);
      if (!n) {
        for (const wid of Object.keys(S.wfBag || {})) {
          const w = S.wfBag[wid];
          n = (w && w.nodes || []).find((x) => x.id === id);
          if (n) break;
        }
      }
      if (n && n.running) push(n, running);
    }
  }
  if (S.pendingRun) {
    for (const id of S.pendingRun) {
      if (seen.has(id)) continue;
      const n = nodeById(id);
      if (n && !n.running) push(n, waiting);
    }
  }
  return { running, waiting };
}

/* ===== 运行队列统一条目（全应用运行总览的取数层） =====
   collectRunQueue() 只回答「哪些节点在跑」，stopAllRuns 依赖它 {running,waiting}
   数组契约，一律不改。下面这层在它之上包一层：再补齐 其它画布上 running 的节点、
   独立智能会话、全局助手、后端音/视频生成，并做「同一件事只出一行」的去重，
   交给左下角面板分组渲染（点击定位 / 逐条终止）。
   条目：{key,type,id,title,kindCls,kindLabel,stateText,sub,state,wfId,wfName,node?,sess?}
     type  node 处理节点 · dev 开发块 · session 独立智能会话 · assist 全局助手
           media 只有后端在跑（画布上已无 running）的生成任务
     state run 处理中 · wait 等待中    sub 次要信息：节点 = 画布名，会话 = 工作目录分组 */
function runQueueLookupNode(id) {
  if (!id) return null;
  const n = typeof nodeById === "function" ? nodeById(id) : null;
  if (n) return n;
  for (const wid of Object.keys(S.wfBag || {})) {
    const w = S.wfBag[wid];
    const hit = ((w && w.nodes) || []).find((x) => x && x.id === id);
    if (hit) return hit;
  }
  return null;
}
/* 节点归属画布：跨画布条目要显示画布名，点行时也要先切画布再定位 */
function runQueueOwnerOf(node) {
  let w = null;
  try {
    w = typeof ownerWfOfNode === "function" ? ownerWfOfNode(node) : S.wf;
  } catch (_) {
    w = S.wf;
  }
  return w || S.wf || null;
}
/* 状态文案拼接（自身运行中 · 会话：xxx · 后端生成中），空段自动跳过 */
function runQueueJoinText(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x) return y;
  if (!y) return x;
  return x + " · " + y;
}
/* ---------- 计划的「并行任务」组 → 运行队列一行（看得见 · 停得掉） ----------
 * 并行期间 owner 会话 st.running 故意为 false（保用户随时改口，见 app-plan.js
 * planParBegin 的注释），所以 ③ 的会话扫描扫不到它 —— 左下角既看不见也停不掉。
 * st._planPar 是那一组的运行时记账（组名 / 每条子任务的 runKey / done / total / at），
 * 下面两个纯函数只读它和子任务的 t._live 轨迹，绝不写任何状态。 */
function runQueueParActive(st) {
  const par = st && st._planPar;
  if (!par || typeof par !== "object") return null;
  /* 「还忙不忙」只有一处判定：app-plan.js planParBusy（会话列表条目与开发块徽标
     用的就是它）；沙箱里没有那个函数时才自己按 done / total 兜底算一次。 */
  if (typeof planParBusy === "function") return planParBusy(st) ? par : null;
  const total = Math.max(0, Number(par.total) || 0);
  if (!total) return null; /* 空组：没有东西在跑 */
  if (Math.max(0, Number(par.done) || 0) >= total) return null; /* 全了结 = 正在收尾 */
  return par;
}
/* 汇总文案：「2/3 · 🔧 write_file · 42s」= 组内进度 · 最近一次工具调用 · 已跑时长。
   工具名来自子任务的 live 轨迹（app-plan.js planLiveFeed），拿不到就只报进度与时长。 */
function runQueueParText(st) {
  const par = runQueueParActive(st);
  if (!par) return "";
  const bits = [];
  const total = Math.max(0, Number(par.total) || 0);
  const done = Math.min(total, Math.max(0, Number(par.done) || 0));
  bits.push(done + "/" + total);
  let tool = "";
  let toolAt = -1;
  try {
    const pe = st._planExec;
    let cur = pe && Array.isArray(pe.cur) && pe.cur.length ? pe.cur : null;
    if (!cur && typeof planSteps === "function")
      cur = (planSteps(st) || []).filter((s) => s && s.status === "active" && s._live);
    for (const t of cur || []) {
      const lv = t && t._live;
      if (!lv || typeof lv !== "object") continue;
      if (!lv.lastTool) continue;
      const at = Number(lv.lastAt) || 0;
      if (at >= toolAt) {
        toolAt = at;
        tool = String(lv.lastTool);
      }
    }
  } catch (_) {}
  if (tool)
    bits.push(
      "🔧 " +
        (typeof clipStr === "function" ? clipStr(tool, 22) : String(tool).slice(0, 22)),
    );
  const at = Number(par.at) || 0;
  if (at) {
    const ms = Math.max(0, Date.now() - at);
    bits.push(typeof fmtDur === "function" ? fmtDur(ms) : Math.round(ms / 1000) + "s");
  }
  return bits.join(" · ");
}
function collectRunQueueAll() {
  const items = [];
  const byKey = new Map();
  const byNodeId = new Map();
  const addItem = (it) => {
    if (!it) return null;
    if (byKey.has(it.key)) return byKey.get(it.key);
    byKey.set(it.key, it);
    if (it.node && it.node.id) byNodeId.set(it.node.id, it);
    items.push(it);
    return it;
  };
  const mkNodeItem = (n, runState) => {
    if (!n || !n.id) return null;
    const isDev = !!(n.kind === "super" && n.dev && !n.db);
    const w = runQueueOwnerOf(n);
    const wfName = (w && (w.name || w.id)) || "";
    return addItem({
      key: (isDev ? "dev:" : "node:") + n.id,
      type: isDev ? "dev" : "node",
      id: n.id,
      title: n.title || I18n.t("（未命名）"),
      kindCls: nodeKindCls(n),
      kindLabel: nodeKindLabel(n),
      /* 开发块：文案说明是「自身 / 子节点 / 绑定会话」哪种运行（面板 tooltip 与去重都靠它）。
         跨画布的开发块要按它归属的那张画布扫后代，扫不到再回退当前画布的判定。 */
      stateText: isDev
        ? devRunStateText(n, w && w.nodes) || devRunStateText(n)
        : "",
      sub: wfName,
      state: runState,
      wfId: (w && w.id) || "",
      wfName,
      /* 不在当前画布：点行要先切画布（loadWorkflow）再 focusNode */
      crossWf: !!(w && S.wf && w.id !== S.wf.id),
      node: n,
      sess: null,
    });
  };
  /* ① + ② 当前画布：处理节点 + 开发块 + 等待队列（沿用 collectRunQueue 的判定口径） */
  const { running, waiting } = collectRunQueue();
  for (const n of running) mkNodeItem(n, "run");
  for (const n of waiting) mkNodeItem(n, "wait");
  /* 其它画布（后台补跑 / 另一个标签页）上正在运行的节点与开发块 */
  for (const wid of Object.keys(S.wfBag || {})) {
    const w = S.wfBag[wid];
    const ns = (w && w.nodes) || [];
    for (const n of ns) {
      if (!n || !n.running || byNodeId.has(n.id)) continue;
      mkNodeItem(n, "run");
    }
    if (typeof devRunningNodes === "function") {
      for (const n of devRunningNodes(ns)) {
        if (byNodeId.has(n.id)) continue;
        mkNodeItem(n, "run");
      }
    }
  }
  /* ⑤ 后端音/视频生成：排队项进「等待中」，在途项进「处理中」；
     节点本身已经出过行的绝不再加一行（同一件事两行是旧版的毛病） */
  const mediaQueued = [];
  const mediaBusy = [];
  try {
    if (typeof mediaGenWaiters !== "undefined" && mediaGenWaiters)
      for (const id of mediaGenWaiters.keys()) mediaQueued.push(id);
  } catch (_) {}
  try {
    if (typeof mediaBackendRunWatchers !== "undefined" && mediaBackendRunWatchers)
      for (const id of mediaBackendRunWatchers.keys()) mediaBusy.push(id);
    if (typeof mediaGenRestoreTimers !== "undefined" && mediaGenRestoreTimers)
      for (const id of mediaGenRestoreTimers.keys()) mediaBusy.push(id);
  } catch (_) {}
  const mkMediaItem = (n, runState) => {
    const w = runQueueOwnerOf(n);
    const wfName = (w && (w.name || w.id)) || "";
    return addItem({
      key: "media:" + n.id,
      type: "media",
      id: n.id,
      title: n.title || I18n.t("（未命名）"),
      kindCls: "media",
      kindLabel: nodeKindLabel(n),
      stateText: runState === "wait" ? I18n.t("排队生成") : I18n.t("在途生成"),
      sub: wfName,
      state: runState,
      wfId: (w && w.id) || "",
      wfName,
      crossWf: !!(w && S.wf && w.id !== S.wf.id),
      node: n,
      sess: null,
    });
  };
  /* 后端条目按既有工具还原成画布上的生成节点（跨画布也能找到） */
  const mediaNodeOf = (id) => {
    try {
      if (typeof findMediaGenNodeById === "function") return findMediaGenNodeById(id);
    } catch (_) {}
    const n = runQueueLookupNode(id);
    if (!n) return null;
    try {
      if (typeof isMediaGenNode === "function") return isMediaGenNode(n) ? n : null;
    } catch (_) {}
    return n;
  };
  for (const id of mediaQueued) {
    const n = mediaNodeOf(id);
    if (!n) continue;
    const it = byNodeId.get(id);
    if (it) it.mediaQueued = true;
    else mkMediaItem(n, "wait");
  }
  for (const id of mediaBusy) {
    const n = mediaNodeOf(id);
    if (!n) continue;
    const it = byNodeId.get(id);
    if (it) {
      /* 画布上还在跑：只在原行上补「后端生成中」；已经落到等待队列的只打标记 */
      if (it.state === "run")
        it.stateText = runQueueJoinText(it.stateText, I18n.t("后端生成中"));
      it.backendBusy = true;
      continue;
    }
    mkMediaItem(n, "run");
  }
  /* ③ 独立智能会话：被「运行中的宿主智能节点」或「sess 态开发块」代表的，
     折进那一行的状态文案里（带上会话标题），不再单独出条 */
  const sessIsRun = (st) => {
    if (!st || !st.id) return false;
    try {
      return typeof sessionIsRunning === "function"
        ? !!sessionIsRunning(st)
        : !!st.running;
    } catch (_) {
      return !!st.running;
    }
  };
  const sessRunning = [];
  try {
    if (typeof agentSessions === "function")
      for (const st of agentSessions()) if (sessIsRun(st)) sessRunning.push(st);
  } catch (_) {}
  /* 开发节点名下「在跑」的绑定会话（devSessionIdsOf ∩ sessRunning）：
     同一节点多次「开发 / 细化」并行时，每一条会话都该在队列里单独成行
     （可单独停止 / 跳转），而不是全被折进那一条开发块行 —— 旧版只看得到 1 行。 */
  const devRunningSessionsOf = (n) => {
    try {
      if (!n || typeof devSessionIdsOf !== "function") return [];
      const ids = devSessionIdsOf(n);
      return sessRunning.filter((st) => st && ids.indexOf(st.id) >= 0);
    } catch (_) {
      return [];
    }
  };
  const repOfSession = (sid) => {
    for (const it of items) {
      const n = it.node;
      if (!n || it.state !== "run") continue;
      if (n.agentSessionId && n.agentSessionId === sid) return it;
      if (it.type === "dev") {
        let dst = null;
        try {
          const ow = runQueueOwnerOf(n);
          dst =
            typeof devNodeRunningState === "function"
              ? devNodeRunningState(n, (ow && ow.nodes) || null) ||
                devNodeRunningState(n)
              : null;
        } catch (_) {}
        if (
          dst === "sess" &&
          typeof devSessionIdsOf === "function" &&
          devSessionIdsOf(n).indexOf(sid) >= 0
        ) {
          /* 只在该节点「唯一」在跑的会话时才折进开发块行（保留「定位节点」语义）；
             多条在跑会话各自成行（见下方 dropSessOnlyDevRows），不再折叠成 1 行 */
          if (devRunningSessionsOf(n).length === 1) return it;
        }
      }
    }
    return null;
  };
  for (const st of sessRunning) {
    const rep = repOfSession(st.id);
    if (rep) {
      rep.sessTitles = rep.sessTitles || [];
      rep.sessTitles.push(st.title || I18n.t("新会话"));
      rep.sessions = rep.sessions || [];
      rep.sessions.push(st);
      continue;
    }
    let grp = "";
    try {
      grp = typeof wsGroupOf === "function" ? wsGroupOf(st.workspace) : "";
    } catch (_) {}
    addItem({
      key: "sess:" + st.id,
      type: "session",
      id: st.id,
      title: st.title || I18n.t("新会话"),
      kindCls: "sess",
      kindLabel: I18n.t("会话"),
      stateText: I18n.t("运行中"),
      sub: grp || "",
      state: "run",
      wfId: "",
      wfName: "",
      node: null,
      sess: st,
    });
  }
  /* ③b 计划并行组：这一组跑起来时 owner 会话 st.running 是 false（见上面的说明），
     ③ 的扫描看不见它 → 按 st._planPar 补一条。type 仍用 "session"：
     点行 = 切回这条会话的视图（复用 jumpRunQueueItem 的会话分支），
     行内 ■ = 精确取消这一组的每个 runKey（见 stopSessionRuns）。 */
  const parTitleOf = (par) => {
    const g = String(par.group || "").trim() || I18n.t("未命名并行组");
    const n = Math.max(0, Number(par.total) || 0);
    return I18n.t("并行任务") + " · " + g + "/" + n;
  };
  try {
    if (typeof agentSessions === "function") {
      for (const st of agentSessions()) {
        const par = runQueueParActive(st);
        if (!par) continue;
        /* 去重兜底：同一条会话已经出行（并行期间它自己的轮次通常不在跑，故互斥天然成立），
           就只把并行进度折进那一行的文案，绝不再加一行「同一件事两行」。 */
        const sessIt = byKey.get("sess:" + st.id);
        if (sessIt) {
          sessIt.stateText = runQueueJoinText(sessIt.stateText, runQueueParText(st));
          sessIt.planParBusy = true; /* 只补文案：这一行仍然是那条会话自己的行 */
          continue;
        }
        let grp = "";
        try {
          grp = typeof wsGroupOf === "function" ? wsGroupOf(st.workspace) : "";
        } catch (_) {}
        addItem({
          key: "planpar:" + st.id,
          type: "session",
          id: st.id,
          title: parTitleOf(par),
          kindCls: "sess",
          kindLabel: I18n.t("并行"),
          stateText: runQueueParText(st),
          sub: grp || "",
          state: "run",
          wfId: "",
          wfName: "",
          node: null,
          sess: st,
          /* 这一行代表的就是并行组：停止提示与悬浮全文都靠它识别 */
          planPar: true,
        });
      }
    }
  } catch (_) {}
  for (const it of items)
    if (it.sessTitles && it.sessTitles.length)
      it.stateText = runQueueJoinText(
        it.stateText,
        I18n.t("会话") + "：" + it.sessTitles.join("、"),
      );
  /* 同一开发节点有多条「开发 / 细化」会话同时在跑：每条已在上面单独成行
     （可单独停止 / 跳转）。若开发块行只因会话在跑（sess 态）而存在，此时整行
     删除 —— 否则队列又回到「1 行折叠 N 条」的老毛病（本 bug 的根因）。
     节点自身 / 后代 / 只读调研在跑的开发块行不受影响（dst 不是 sess）。 */
  const dropSessOnlyDevRows = () => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it || it.type !== "dev" || !it.node) continue;
      let dst = null;
      try {
        const ow = runQueueOwnerOf(it.node);
        dst =
          typeof devNodeRunningState === "function"
            ? devNodeRunningState(it.node, (ow && ow.nodes) || null) ||
              devNodeRunningState(it.node)
            : null;
      } catch (_) {}
      if (dst !== "sess" || devRunningSessionsOf(it.node).length < 2) continue;
      items.splice(i, 1);
      if (byKey.has(it.key)) byKey.delete(it.key);
      if (it.node.id && byNodeId.has(it.node.id)) byNodeId.delete(it.node.id);
    }
  };
  dropSessOnlyDevRows();
  /* ④ 全局助手：全应用同时只有一个，合成一条（无宿主节点，点击 = 打开助手侧栏） */
  const assistOn = !!(S.assistRunning || S.assistRunActive);
  const assist = assistOn
    ? addItem({
        key: "assist",
        type: "assist",
        id: "assist",
        title: I18n.t("全局助手执行中"),
        kindCls: "assist",
        kindLabel: I18n.t("助手"),
        stateText: "",
        sub: (S.wf && (S.wf.name || S.wf.id)) || "",
        state: "run",
        wfId: (S.wf && S.wf.id) || "",
        wfName: (S.wf && (S.wf.name || S.wf.id)) || "",
        node: null,
        sess: null,
      })
    : null;
  /* 展示顺序：助手 → 会话 → 开发块 → 处理节点 → 后端生成 → 等待中 */
  const rank = (it) =>
    (it.state === "wait" ? 90 : 0) +
    (it.type === "assist"
      ? 0
      : it.type === "session"
        ? 1
        : it.type === "dev"
          ? 2
          : it.type === "node"
            ? 3
            : 4);
  items.sort((a, b) => rank(a) - rank(b));
  const counts = { node: 0, dev: 0, session: 0, assist: 0, media: 0, run: 0, wait: 0 };
  for (const it of items) {
    counts[it.type] = (counts[it.type] || 0) + 1;
    counts[it.state === "wait" ? "wait" : "run"]++;
  }
  return { items, running, waiting, assist, counts, hasQueue: items.length > 0 };
}
/* 队列行的次要信息（画布名 / 目录分组 / 「自身·子节点·绑定会话运行中」）：
   行内只放必要的一条，其余进 title 悬浮，避免撑爆行宽。
   同画布的处理节点不重复显示画布名；跨画布项必须显示（否则用户不知道去哪找）。 */
function runQueueSubOf(it) {
  if (!it) return "";
  const bits = [];
  if (it.stateText) bits.push(it.stateText);
  if (it.sub && (it.crossWf || it.type === "session" || it.type === "media"))
    bits.push(it.sub);
  return bits.join(" · ");
}
function runQueueJumpHint(it) {
  if (!it) return "";
  if (it.type === "assist") return I18n.t("点击打开全局助手");
  if (it.type === "session") return I18n.t("点击打开该会话");
  if (it.type !== "node" && it.type !== "dev" && it.type !== "media") return "";
  /* 开发块的「建议 / 问询」只读调研在跑：点行 = 打开对应的进度窗口（见 jumpRunQueueItem） */
  if (it.type === "dev") {
    const n = it.node;
    try {
      if (
        n &&
        ((typeof devSuggestJobBusy === "function" && devSuggestJobBusy(n)) ||
          (typeof devAskJobBusy === "function" && devAskJobBusy(n)))
      )
        return I18n.t("点击查看调研进度");
    } catch (_) {}
  }
  return it.crossWf ? I18n.t("跨画布定位") : I18n.t("点击定位到节点");
}
function runQueueStopHint(it) {
  if (!it) return I18n.t("停止运行");
  if (it.type === "session") {
    /* 独立并行组行 / 折进会话行的并行进度：文案说清楚这一枪会打掉什么 */
    if (it.planPar) return I18n.t("停止该并行任务组");
    if (it.planParBusy) return I18n.t("停止该会话与并行任务组");
    return I18n.t("停止该会话");
  }
  if (it.type === "assist") return I18n.t("停止全局助手");
  return I18n.t("停止运行");
}
/* 悬浮全文：标题一行 + 状态 / 归属画布 / 目录 + 点击语义 */
function runQueueTipOf(it) {
  const bits = [];
  if (it.stateText) bits.push(it.stateText);
  if (it.sub)
    bits.push(
      (it.type === "session" ? I18n.t("工作目录") : I18n.t("画布")) + "：" + it.sub,
    );
  /* 并行任务行：整行说的是「哪个会话跑的并行组」，悬浮要把 owner 会话标题写明 */
  if (it.planPar && it.sess && it.sess.title)
    bits.push(I18n.t("会话") + "：" + it.sess.title);
  /* 开发块绑定会话在跑：悬浮给出全部用户输入（开发 / 细化任务书全文），
     副标题只放一行摘要，完整内容在这里看 */
  if (it.type === "dev" && it.node) {
    const ui = devRunningUserInputText(it.node);
    if (ui) bits.push(I18n.t("用户输入") + "：\n" + ui);
  }
  const hint = runQueueJumpHint(it);
  if (hint) bits.push(hint);
  return bits.join(" · ");
}

/* 左下角「运行队列」= 全应用运行总览：
   全局助手 → 智能会话 → 处理中（普通节点 + 开发块）→ 后端生成中 → 等待中。
   取数一律走 collectRunQueueAll()（跨画布节点 / 独立会话 / 助手 / 后端媒体 + 去重），
   以前只有会话在跑时整条被隐藏（用户看不见也停不掉），现在会话与助手同样计入 hasQueue。 */
function updateRunQueuePanel() {
  const el = $("#runQueue");
  const btn = $("#btnRunQueue");
  const btnTxt = $("#btnRunQueueTxt");
  let q;
  try {
    q = collectRunQueueAll();
  } catch (_) {
    q = { items: [], hasQueue: false }; /* 取数异常时只隐藏面板，不打断调用方渲染 */
  }
  const items = q.items || [];
  const runItems = [];
  const waitItems = [];
  for (const it of items) (it.state === "wait" ? waitItems : runItems).push(it);
  const countOf = (type) =>
    runItems.reduce((m, it) => m + (it.type === type ? 1 : 0), 0);
  const nAssist = countOf("assist");
  /* 会话行里「并行任务」单独计数：它代表的是计划并行组，不是一条普通对话轮次 */
  const nPar = runItems.reduce(
    (m, it) => m + (it.type === "session" && it.planPar ? 1 : 0),
    0,
  );
  const nSess = countOf("session") - nPar;
  const nNode = countOf("node") + countOf("dev");
  const nMedia = countOf("media");
  const hasQueue = !!items.length;
  /* 心跳：有运行项才定时重绘面板（解决长任务期间「看着不动」），队列空即停 */
  syncRunQueueTicker(hasQueue);
  /* 汇总文案（条状按钮 title 与面板 rq-count 同一份，口径不分叉） */
  const summary = [];
  if (nAssist) summary.push(I18n.t("助手执行中"));
  if (nNode) summary.push(nNode + I18n.t(" 处理中"));
  if (nSess) summary.push(nSess + I18n.t(" 会话"));
  if (nPar) summary.push(nPar + I18n.t(" 并行任务"));
  if (nMedia) summary.push(nMedia + I18n.t(" 后端生成中"));
  if (waitItems.length) summary.push(waitItems.length + I18n.t(" 等待"));
  /* 条状折叠按钮：有队列（含只有会话 / 只有助手在跑）时显示，并高亮呼吸灯 */
  if (btn) {
    if (!hasQueue) {
      btn.hidden = true;
      btn.classList.remove("has-queue");
    } else {
      btn.hidden = false;
      btn.classList.add("has-queue");
      btn.title = summary.join(" · ") + I18n.t("（点击展开 / 收起运行队列）");
      if (btnTxt)
        btnTxt.textContent = String(
          runItems.length || waitItems.length || "◉",
        );
    }
  }
  if (!el) return;
  if (!hasQueue) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  /* 收起态：只显示条状按钮，悬浮窗隐藏 */
  if (S._rqCollapsed) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "rq-head";
  const title = document.createElement("b");
  title.textContent = I18n.t("运行队列");
  head.appendChild(title);
  const count = document.createElement("span");
  count.className = "rq-count";
  count.textContent = summary.join(" · ");
  head.appendChild(count);
  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "rq-fold mini";
  fold.textContent = "—";
  fold.title = I18n.t("收起为左下角条状按钮");
  fold.onclick = (ev) => {
    ev.stopPropagation();
    S._rqCollapsed = true;
    updateRunQueuePanel();
  };
  head.appendChild(fold);
  const stopAll = document.createElement("button");
  stopAll.type = "button";
  stopAll.className = "rq-stop-all mini danger";
  stopAll.textContent = I18n.t("全部终止");
  stopAll.title = I18n.t("一键终止队列中全部运行与等待任务（含全局助手）");
  stopAll.onclick = (ev) => {
    ev.stopPropagation();
    stopAllRuns();
  };
  head.appendChild(stopAll);
  el.appendChild(head);
  const body = document.createElement("div");
  body.className = "rq-body";
  const mkRow = (it) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className =
      "rq-item kind-" +
      (it.kindCls || "proc") +
      (it.state === "run" ? " is-run" : " is-wait");
    row.title = ((it.title || "") + "\n" + runQueueTipOf(it)).trim();
    const icon = document.createElement("span");
    icon.className = "rq-icon";
    icon.setAttribute("aria-hidden", "true");
    /* icon 表示状态：◉ 处理中 · ○ 等待 */
    icon.textContent = it.state === "run" ? "◉" : "○";
    const nm = document.createElement("span");
    nm.className = "rq-title";
    nm.textContent = it.title || I18n.t("（未命名）");
    row.appendChild(icon);
    row.appendChild(nm);
    const sub = runQueueSubOf(it);
    if (sub) {
      const s = document.createElement("span");
      s.className = "rq-sub";
      s.textContent = sub;
      row.appendChild(s);
    }
    const kd = document.createElement("span");
    kd.className = "rq-kind";
    kd.textContent = it.kindLabel || "";
    row.appendChild(kd);
    row.onclick = () => {
      jumpRunQueueItem(it);
    };
    /* 逐条终止：队列里有 N 个视频 / 音乐任务时，不想只有一刀切的全部终止 */
    const stop = document.createElement("span");
    stop.className = "rq-stop";
    stop.setAttribute("role", "button");
    stop.tabIndex = 0;
    stop.textContent = "■";
    stop.title = runQueueStopHint(it);
    stop.onclick = (ev) => {
      ev.stopPropagation();
      stopRunQueueItem(it);
    };
    row.appendChild(stop);
    return row;
  };
  const addSec = (label, list) => {
    if (!list.length) return;
    const sec = document.createElement("div");
    sec.className = "rq-sec";
    sec.textContent = label;
    /* 小计徽标：一眼看出这一节有几条在跑 */
    const n = document.createElement("span");
    n.className = "rq-sec-n";
    n.textContent = String(list.length);
    sec.appendChild(n);
    body.appendChild(sec);
    for (const it of list) body.appendChild(mkRow(it));
  };
  const pick = (type) => runItems.filter((it) => it.type === type);
  addSec(I18n.t("全局助手"), pick("assist"));
  addSec(I18n.t("智能会话"), pick("session"));
  addSec(
    I18n.t("处理中"),
    runItems.filter((it) => it.type === "node" || it.type === "dev"),
  );
  addSec(I18n.t("后端生成中"), pick("media"));
  addSec(I18n.t("等待中"), waitItems);
  el.appendChild(body);
}

/* 轻量心跳：队列非空时每 ~2s 只重绘一次「运行队列」面板本身
   （不 renderCanvas、不 scheduleSave —— 纯面板级 DOM 重建）。
   长任务期间节点文案 / 后端在途 / 会话轮次都在悄悄变，光靠事件刷新会「看着不动」。
   队列一空立刻自毁，平时零常驻开销。思路同 app-assist.js 的 startAgentSideTimeTicker。 */
const RUN_QUEUE_TICK_MS = 2000;
let _runQueueTicker = null;
function stopRunQueueTicker() {
  if (!_runQueueTicker) return;
  try {
    clearInterval(_runQueueTicker);
  } catch (_) {}
  _runQueueTicker = null;
}
function syncRunQueueTicker(on) {
  if (!on) {
    stopRunQueueTicker();
    return;
  }
  if (_runQueueTicker || typeof setInterval !== "function") return;
  _runQueueTicker = setInterval(() => {
    try {
      updateRunQueuePanel();
    } catch (_) {
      /* 取数 / 重绘异常：停掉心跳，不让它每 2s 反复抛 */
      stopRunQueueTicker();
    }
  }, RUN_QUEUE_TICK_MS);
}

/* 点队列行 = 定位：助手 → 打开右侧助手栏；会话 → 切到会话视图并选中它；
   节点 / 开发块 / 生成任务 → 先切到它归属的画布（跨画布，loadWorkflow 会保留
   运行中的内存对象，不打断任务）再 focusNode。旧版直接 toast「节点不在当前画布」。 */
async function jumpRunQueueItem(it) {
  if (!it) return;
  if (it.type === "assist") {
    try {
      setAssistOpen(true);
    } catch (_) {}
    return;
  }
  if (it.type === "session") {
    const st =
      it.sess ||
      (typeof agentSessionById === "function" ? agentSessionById(it.id) : null);
    if (!st) {
      toast(I18n.t("会话已不存在"), "warn");
      updateRunQueuePanel();
      return;
    }
    try {
      if (S.view !== "agent") setView("agent");
      S.agentActiveId = st.id;
      await persistAgentSession();
      renderAgentSession();
      renderAgentSessionSidebar();
    } catch (_) {}
    updateRunQueuePanel();
    return;
  }
  const n = it.node || runQueueLookupNode(it.id);
  if (!n) {
    toast(I18n.t("节点已不存在"), "warn");
    updateRunQueuePanel();
    return;
  }
  try {
    if (it.crossWf && it.wfId && S.wf && it.wfId !== S.wf.id)
      await loadWorkflow(it.wfId);
    if (S.view === "agent") setView("workflow");
    if (!nodeById(n.id)) {
      toast(I18n.t("节点不在当前画布"), "warn");
      return;
    }
    focusNode(n.id);
    /* 开发块的「建议 / 问询」只读调研在跑：点行 = 打开对应的进度窗口
       （devSuggestShowJob / devAskShowJob），而不是只定位节点 */
    if (it.type === "dev") {
      try {
        let opened = false;
        if (
          typeof devSuggestJobBusy === "function" &&
          typeof devSuggestShowJob === "function"
        ) {
          const sj = devSuggestJobBusy(n);
          if (sj) {
            devSuggestShowJob(sj);
            opened = true;
          }
        }
        if (
          !opened &&
          typeof devAskJobBusy === "function" &&
          typeof devAskShowJob === "function"
        ) {
          const aj = devAskJobBusy(n);
          if (aj) devAskShowJob(aj);
        }
      } catch (_) {}
    }
  } catch (_) {}
  updateRunQueuePanel();
}

/* 计划「并行任务」这一组的停止：组里每个子任务各有自己的 runKey（app-plan.js
   planParRunKey），并行期间会话自己的 agent:<id> 并不在途 → 只能逐个取消。
   取消后各 run 以 rejected 落回 planRunParallel 现有的失败收尾（结果行显示
   「失败：…」），游标的 runId 守卫已有，不改它的续跑契约。 */
function stopPlanParRuns(st) {
  const par = st && st._planPar;
  const keys = par && Array.isArray(par.runKeys) ? par.runKeys.filter(Boolean) : [];
  if (!par || !keys.length) return false;
  /* 会话此刻自己有轮次在跑 → st._cancelled 那一轮需要它，收尾由那轮的 finally 负责 */
  const hadRound = !!st.running;
  for (const k of keys) {
    try {
      dshCancelActive(String(k));
    } catch (_) {}
  }
  if (!hadRound) armPlanParCancelReset(st, par);
  return true;
}
/* 并行期间会话自己没有轮次在跑，所以这个作废标记没有「轮次收尾」替它擦除：
   留着它，planExecContinue 续跑的下一轮一结束就被 app-assist 当成「已终止」
   （outcome=cancelled → planDrop）→ 整份计划被静默清掉，停一组等于废全案。
   给本组记一个令牌，等这一组了结（planParEnd 摘掉 st._planPar）就把标记擦回原样；
   令牌被后来的 ■ 顶掉时一律闭嘴，绝不越权擦别人的标记。 */
function armPlanParCancelReset(st, par) {
  if (typeof setTimeout !== "function" || !st || !st.id) return;
  const token = "planpar:" + String(par.runId || par.at || "");
  st._parCancelToken = token;
  let tries = 0;
  const poll = () => {
    if (!st || st._parCancelToken !== token) return; /* 标记已易手，收工 */
    /* 还挂着这一组就继续等它了结（取消慢也要等到，不能让标记漂到下一轮） */
    if (st._planPar === par && ++tries <= 1500) {
      setTimeout(poll, 200);
      return;
    }
    st._parCancelToken = "";
    st._cancelled = false;
  };
  poll();
}
/* 停一条会话名下的运行：左下角队列行与会话视图的 ■ 共用这一份口径。
   先按 runKey 精确取消并行组，再照旧作废并取消会话自己那一轮
   （agent:<id> 没在途时 dshCancelActive 就是空操作，不会误伤别的会话）。
   clearRunning：队列行沿用旧口径（立刻置 running=false）；
   会话视图里不提前置 false —— 那一轮的 finally 自己收尾，避免抢跑。 */
function stopSessionRuns(st, clearRunning) {
  if (!st || !st.id) return false;
  st._cancelled = true;
  const par = stopPlanParRuns(st); /* 先读 st.running 判定有没有轮次在飞 */
  if (clearRunning) st.running = false;
  try {
    dshCancelActive("agent:" + st.id);
  } catch (_) {}
  return par;
}

/* 行内 ■ = 只停这一条（语义与各处的单条停止完全一致，不动别的运行项）：
   节点沿用 stopNode（开发块分支会递归停后代 + 绑定会话，生成节点走
   music_gen/video_gen 分支：关监视器 + 作废排队 + 取消后端任务）；
   会话与「全部终止」里同款：标记作废 + 关掉该会话自己的运行时进程，
   并在跑的是计划并行组时逐个取消那一组的 runKey（stopSessionRuns）。 */
async function stopRunQueueItem(it) {
  if (!it) return;
  if (it.type === "assist") {
    try {
      assistStop();
    } catch (_) {
      S.assistRunActive = false;
    }
    updateRunQueuePanel();
    return;
  }
  if (it.type === "session") {
    const st =
      it.sess ||
      (typeof agentSessionById === "function" ? agentSessionById(it.id) : null);
    if (!st) {
      toast(I18n.t("会话已不存在"), "warn");
      updateRunQueuePanel();
      return;
    }
    /* 会话名下的两路运行：自己那一轮 + 计划并行组。stopSessionRuns 按各自的 runKey
       逐个取消（并行组的 runKey 停不掉 = 用户点 ■ 后任务还在偷偷跑）。 */
    stopSessionRuns(st, true);
    if (S.view === "agent") renderAgentSession();
    updateRunQueuePanel();
    return;
  }
  const n = it.node || runQueueLookupNode(it.id);
  if (!n) {
    toast(I18n.t("节点已不存在"), "warn");
    updateRunQueuePanel();
    return;
  }
  try {
    await stopNode(n);
  } catch (_) {}
  /* 开发块的后代 / 绑定会话可能各自成行，整列状态都要跟着刷新 */
  updateRunQueuePanel();
}

/* 一键终止：运行中 + 排队中（含隐藏的媒体排队）+ 后端生成任务 + 定时触发 + 全局助手/会话。
   关键：先递增全局终止代号并给每个「有活干」的节点打停止标记，再取消主进程后端任务，
   最后关掉所有轮询；否则「结束所有节点任务」只是把 running 置 false，
   队列与后端会自己把视频 / 音乐任务重新拉起来。
   函数 / 工具节点是例外：它们的执行体在主进程的独立线程里，光打标记停不掉 ——
   必须按 runId 取消（terminate 线程 + 连进程树回收），所以本函数是 async，
   等这些取消真的落地之后再刷新界面与 toast（数字要诚实）。 */
async function stopAllRuns() {
  const { running, waiting } = collectRunQueue();
  const assistOn = !!S.assistRunning;
  /* 「在跑」用展示口径：名下只有计划并行组在跑的会话也算（st.running 是 false），
     否则「全部终止」既不会为它去中断 dsh（needDsh 判空），也取消不了那一组 runKey。 */
  const sessRunning = agentSessions().filter((s) =>
    typeof sessionBusyForUi === "function"
      ? sessionBusyForUi(s)
      : !!(s && s.running),
  );
  if (
    !running.length &&
    !waiting.length &&
    !assistOn &&
    !sessRunning.length &&
    !hasAnyMediaGenActivity() &&
    !hasAnyComputeExecActivity()
  ) {
    toast(I18n.t("当前没有运行中的任务"), "warn");
    return;
  }
  /* ① 全局作废代号 */
  markGlobalStop();
  /* ② 媒体生成：清排队 + 关轮询 + 取消后端任务（释放大锁），返回在途任务数 */
  let nMedia = 0;
  try {
    nMedia = stopAllMediaGen();
  } catch (_) {}
  /* ③ 统一中断 dsh 引擎（智能节点 / 助手 / 会话共用一次） */
  const needDsh =
    running.some((n) => isDshTask(n)) ||
    assistOn ||
    sessRunning.length > 0;
  if (needDsh) {
    try {
      dshCancelActive();
    } catch (_) {}
  }
  /* ③b 开发块的「建议 / 问询」只读调研：它们不是 dsh 任务节点，③ 的
     dshCancelActive() 不会主动命中各自的 runKey——不显式取消的话，「全部终止」
     后队列里还会残留「建议调研中 / 问询中」的行。只动 running 的作业：
     已完成但未查看的作业（phase options/ready）不在此列，别误删（见 devSuggestJobDrop）。 */
  let nDevJob = 0;
  for (const n of running) {
    if (!n || n.kind !== "super" || !n.dev || n.db) continue;
    try {
      const sj =
        typeof devSuggestJobOf === "function" ? devSuggestJobOf(n) : null;
      if (sj && sj.running && typeof devSuggestJobAbort === "function" && typeof devSuggestJobDrop === "function") {
        devSuggestJobAbort(sj);
        devSuggestJobDrop(sj);
        nDevJob++;
      }
      const aj =
        typeof devAskJobOf === "function" ? devAskJobOf(n) : null;
      if (aj && aj.running && typeof devAskJobAbort === "function" && typeof devAskJobDrop === "function") {
        devAskJobAbort(aj);
        devAskJobDrop(aj);
        nDevJob++;
      }
    } catch (_) {}
  }
  /* ④ 当前画布 + 后台工作流：一次线性扫描，凡是「有活干」的节点全部作废 */
  const pendingIds = new Set(S.pendingRun || []);
  const runIds = new Set(S.runPromises ? S.runPromises.keys() : []);
  const isBusy = (n) =>
    !!n &&
    (n.running ||
      pendingIds.has(n.id) ||
      runIds.has(n.id) ||
      (S.playLocks && S.playLocks.has(n.id)) ||
      /* 计算执行类：线程在主进程里，槽位已占 / 排队中都可能没进上面任何一本台账，
         这里按活动真源再问一次，别让「全部终止」漏掉一个正在起跑或排队的函数运行 */
      (isComputeExecKind(n) &&
        (typeof computeExecNodeActive === "function"
          ? computeExecNodeActive(n)
          : typeof fnHasLiveRun === "function" && fnHasLiveRun(n))));
  let nStop = 0;
  /* 函数 / 工具的取消是异步的（等主进程 terminate 线程 + 回收进程树）：攒起来，
     ⑦ 统一等完再刷新界面与 toast，数字才诚实 */
  const fnStops = [];
  /* 逐个工作流就地扫描，不复制大数组（节点再多也只走一遍） */
  const eachKnown = (fn) => {
    if (S.wf && S.wf.nodes) for (const n of S.wf.nodes) fn(n);
    for (const wid of Object.keys(S.wfBag || {})) {
      const w = S.wfBag[wid];
      if (w && w.nodes && (!S.wf || w.id !== S.wf.id)) for (const n of w.nodes) fn(n);
    }
  };
  eachKnown((n) => {
    if (!isBusy(n)) return;
    if (isMediaGenNode(n)) return; /* 已在 ② 处理（状态文案不同） */
    bumpNodeStop(n);
    /* 函数 / 工具节点：执行体在主进程的独立线程里，通用「置 running=false」是假停止
       —— 只打标记 + 按 runId 取消这次运行（terminate 线程、连进程树回收），
       界面状态与「已手动停止」交给运行体自己的 finally。 */
    if (isComputeExecKind(n)) {
      const wasRunning = !!n.running;
      if (typeof fnCancelRunsOf === "function") {
        fnStops.push(fnCancelRunsOf(n));
      } else {
        n.running = false;
        n.error = I18n.t("已手动停止");
      }
      if (wasRunning) nStop++;
      return;
    }
    if (n._abKey) {
      try {
        window.api.apiAbort(n._abKey);
      } catch (_) {}
    }
    if (n.running) nStop++;
    n.running = false;
    if (n.kind !== "wait_file") n.error = I18n.t("已手动停止");
    if (n.kind === "agent_task" && n.agentSessionId) {
      const sess = agentSessions().find((s) => s.id === n.agentSessionId);
      if (sess) sess.running = false;
    }
  });
  /* ⑤ 解除定时触发：否则定时器会按点继续往队列里塞任务 */
  let nTimer = 0;
  eachKnown((n) => {
    if (n.kind === "timer" && (n.timerArmed || n.running)) {
      try {
        disarmTimerNode(n, true);
        nTimer++;
      } catch (_) {}
    }
  });
  /* ⑥ 清空等待队列显示（含隐藏的媒体排队） */
  if (S.pendingRun && S.pendingRun.size) clearPendingRun([...S.pendingRun]);
  S._scheduledRunIds = null;
  if (assistOn) {
    try {
      assistStop();
    } catch (_) {
      S.assistRunActive = false;
    }
  }
  for (const sess of sessRunning) {
    /* 一律走 stopSessionRuns：会话自己那一轮 + 名下计划并行组的 runKeys 一起取消，
       只置 running=false 会让那一组并行任务在「全部终止」之后继续偷跑。 */
    try {
      stopSessionRuns(sess, true);
    } catch (_) {
      sess._cancelled = true;
      sess.running = false;
    }
    nStop++;
  }
  /* ⑦ 函数 / 工具节点：等主进程真的 terminate 掉线程、连进程树回收完，
     再刷新界面与报数 —— 界面变暗的那一刻起，它绑定的线程与进程就一定不在了。 */
  let nFnProc = 0;
  if (fnStops.length) {
    const rs = await Promise.all(
      fnStops.map((p) => Promise.resolve(p).catch(() => null)),
    );
    for (const r of rs) if (r && r.procs) nFnProc += Number(r.procs) || 0;
  }
  renderCanvas();
  renderStatus();
  updateRunQueuePanel();
  if (S.view === "agent") renderAgentSession();
  scheduleSave(true);
  const bits = [];
  if (nStop) bits.push(nStop + I18n.t(" 个运行"));
  if (waiting.length) bits.push(waiting.length + I18n.t(" 个等待"));
  if (nMedia) bits.push(nMedia + I18n.t(" 个生成任务"));
  if (nTimer) bits.push(nTimer + I18n.t(" 个定时"));
  if (nDevJob) bits.push(nDevJob + I18n.t(" 个调研"));
  if (nFnProc) bits.push(I18n.t("回收 ") + nFnProc + I18n.t(" 个进程"));
  if (assistOn) bits.push(I18n.t("全局助手"));
  toast(
    I18n.t("已全部终止") + (bits.length ? "：" + bits.join(" · ") : ""),
    "warn",
  );
}

let overlayPersistent = false;
let overlayKind = "";
/* 仅当 mousedown 落在蒙层本身时才允许 click 关闭，避免在弹窗内拖选文字松手到蒙层误关 */
let _overlayBgPointerDown = false;
function openOverlay(title, opts) {
  opts = opts || {};
  overlayPersistent = !!opts.persistent;
  overlayKind = "";
  _overlayBgPointerDown = false;
  S.thinkOpen = null; // 打开新弹窗时结束上一弹窗的思考流式更新
  const box = $("#overlay .overlay-box");
  if (box) {
    box.classList.remove("wide");
    box.classList.remove("tpl-store");
    box.classList.remove("g-ref-wide");
    /* 上一个宿主确认框的归属标识必须随弹窗一起作废：残留会让确认框自毁时
       把「正在显示的别的弹窗」误认成自己而 closeOverlay（见 app-nodes.js
       confirmAssistAction 的 overlayIsMine） */
    if (box.dataset.ixConfirmId) delete box.dataset.ixConfirmId;
  }
  const ovBody = $("#ovBody");
  if (ovBody) ovBody.classList.remove("tpl-store-body", "g-ref-ov");
  $("#ovTitle").textContent = title;
  $("#ovBody").innerHTML = "";
  $("#ovFoot").innerHTML = "";
  $("#overlay").style.display = "flex";
}
/* 带可编辑输入控件的弹窗视为需显式关闭（与 overlayPersistent 等效） */
function overlayHasEditableFields() {
  const root = document.getElementById("overlay");
  if (!root || root.style.display !== "flex") return false;
  return !!root.querySelector(
    'textarea, select, input[type="text"], input[type="number"], input[type="password"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input[type="file"], input:not([type]), [contenteditable="true"]',
  );
}
function overlayShouldStayOpen() {
  return overlayPersistent || overlayHasEditableFields();
}
function closeOverlay() {
  S.thinkOpen = null;
  _overlayBgPointerDown = false;
  closeTplSubOverlay();
  const box = $("#overlay .overlay-box");
  if (box) {
    box.classList.remove("wide");
    box.classList.remove("tpl-store");
    box.classList.remove("g-ref-wide");
    if (box.dataset.ixConfirmId) delete box.dataset.ixConfirmId;
  }
  const body = $("#ovBody");
  if (body) body.classList.remove("tpl-store-body", "g-ref-ov");
  document.querySelectorAll("#overlay > .plugin-pop").forEach((el) => el.remove());
  $("#overlay").style.display = "none";
  /* 蒙层没了 = 设置窗也没了（#overlay 全应用独一份，不能叠窗）：把节点绑定作废。
     不清的话，撤销 / 切画布链路会拿着一个早已不在屏上的窗去判断，还会误弹一次
     「设置窗口已关闭」。closeNodeSettingsDialog 自己先清了引用，这里不会重复做事。 */
  if (typeof discardNodeSettingsDialog === "function") discardNodeSettingsDialog();
}

/* 独立于 #overlay 的深色确认 / 输入框（设置等弹窗打开时也能用，不冲掉内容） */
let _mtDialogSeq = 0;
function ensureMtDialog() {
  let host = document.getElementById("mtDialog");
  if (host) return host;
  host = document.createElement("div");
  host.id = "mtDialog";
  host.className = "mt-dialog";
  host.innerHTML =
    '<div class="mt-dialog-box" role="dialog" aria-modal="true">' +
    '<div class="mt-dialog-head"><b id="mtDlgTitle"></b></div>' +
    '<div class="mt-dialog-body" id="mtDlgBody"></div>' +
    '<div class="mt-dialog-foot" id="mtDlgFoot"></div>' +
    "</div>";
  document.body.appendChild(host);
  return host;
}

function closeMtDialog() {
  const host = document.getElementById("mtDialog");
  if (host) host.classList.remove("on");
}

function confirmDialog(message, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const host = ensureMtDialog();
    const seq = ++_mtDialogSeq;
    const titleEl = document.getElementById("mtDlgTitle");
    const body = document.getElementById("mtDlgBody");
    const foot = document.getElementById("mtDlgFoot");
    if (titleEl) titleEl.textContent = opts.title || I18n.t("确认");
    if (body) {
      body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "mt-dialog-msg";
      p.textContent = String(message || "");
      body.appendChild(p);
    }
    if (foot) foot.innerHTML = "";
    let done = false;
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      }
    };
    const finish = (ok) => {
      if (done || seq !== _mtDialogSeq) return;
      done = true;
      host.removeEventListener("keydown", onKey);
      closeMtDialog();
      resolve(!!ok);
    };
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mini";
    cancel.textContent = opts.cancelText || I18n.t("取消");
    cancel.onclick = () => finish(false);
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = opts.danger ? "mini danger" : "mini primary";
    ok.textContent = opts.okText || I18n.t("确定");
    ok.onclick = () => finish(true);
    if (foot) {
      foot.appendChild(cancel);
      foot.appendChild(ok);
    }
    host.classList.add("on");
    host.addEventListener("keydown", onKey);
    setTimeout(() => {
      try {
        ok.focus();
      } catch (_) {}
    }, 0);
  });
}

function promptDialog(message, defaultValue, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const host = ensureMtDialog();
    const seq = ++_mtDialogSeq;
    const titleEl = document.getElementById("mtDlgTitle");
    const body = document.getElementById("mtDlgBody");
    const foot = document.getElementById("mtDlgFoot");
    if (titleEl) titleEl.textContent = opts.title || I18n.t("输入");
    let inp = null;
    if (body) {
      body.innerHTML = "";
      if (message) {
        const p = document.createElement("p");
        p.className = "mt-dialog-msg";
        p.textContent = String(message);
        body.appendChild(p);
      }
      inp = document.createElement("input");
      inp.type = opts.inputType || "text";
      inp.className = "mt-dialog-input";
      inp.value = defaultValue == null ? "" : String(defaultValue);
      if (opts.placeholder) inp.placeholder = opts.placeholder;
      body.appendChild(inp);
    }
    if (foot) foot.innerHTML = "";
    let done = false;
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        finish(null);
      }
    };
    const finish = (val) => {
      if (done || seq !== _mtDialogSeq) return;
      done = true;
      host.removeEventListener("keydown", onKey);
      closeMtDialog();
      resolve(val);
    };
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mini";
    cancel.textContent = opts.cancelText || I18n.t("取消");
    cancel.onclick = () => finish(null);
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "mini primary";
    ok.textContent = opts.okText || I18n.t("确定");
    ok.onclick = () => finish(inp ? inp.value : "");
    if (inp) {
      inp.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          finish(inp.value);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          finish(null);
        }
      };
      setTimeout(() => {
        try {
          inp.focus();
          inp.select();
        } catch (_) {}
      }, 0);
    }
    if (foot) {
      foot.appendChild(cancel);
      foot.appendChild(ok);
    }
    host.classList.add("on");
    host.addEventListener("keydown", onKey);
  });
}

/* 信息展示 + 文本输入的通用对话框（开发 / 细化等动作用）。
 * opts: { title, wide, rows:[[k,v]], note:{label,text}, list:{label,items}, msg, warn,
 *         textarea:{label,placeholder,value}, hint, requireText,
 *         actions:[{id,label,primary,danger}] }
 * resolve({action,text}) ；取消 / Esc → null。requireText 且输入为空时不关闭。 */
function mtDialogForm(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const host = ensureMtDialog();
    const seq = ++_mtDialogSeq;
    const box = host.querySelector(".mt-dialog-box");
    if (box) {
      box.classList.add("mt-form-box");
      if (opts.wide) box.classList.add("mt-form-wide");
    }
    const titleEl = document.getElementById("mtDlgTitle");
    const bodyEl = document.getElementById("mtDlgBody");
    const footEl = document.getElementById("mtDlgFoot");
    if (titleEl) titleEl.textContent = opts.title || I18n.t("确认");
    let ta = null;
    let errP = null;
    let customSelect = null;
    /* 实时把输入交给调用方留存（opts.onText）：
       取消、Esc、被其它弹窗顶掉、切画布甚至重载应用，都不该让用户白写一轮 */
    const emitDraft = () => {
      if (!ta || typeof opts.onText !== "function") return;
      try {
        opts.onText(String(ta.value || ""));
      } catch (_) {}
    };
    if (bodyEl) {
      bodyEl.innerHTML = "";
      const frag = document.createDocumentFragment();
      if (Array.isArray(opts.rows) && opts.rows.length) {
        const wrap = document.createElement("div");
        wrap.className = "mt-form-rows";
        for (const r of opts.rows) {
          const row = document.createElement("div");
          row.className = "mt-form-row";
          const k = document.createElement("span");
          k.className = "mt-form-k";
          k.textContent = String((r && r[0]) || "");
          const v = document.createElement("span");
          v.className = "mt-form-v";
          v.textContent = String((r && r[1]) || "");
          row.appendChild(k);
          row.appendChild(v);
          wrap.appendChild(row);
        }
        frag.appendChild(wrap);
      }
      const _noteTwo =
        opts.note &&
        (opts.note.design !== undefined || opts.note.impl !== undefined);
      const _noteBody = String((opts.note && opts.note.text) || "").trim();
      if (opts.note && (_noteTwo || _noteBody)) {
        const nb = document.createElement("div");
        nb.className = "mt-form-note";
        const nl = document.createElement("i");
        nl.textContent = opts.note.label || I18n.t("概述");
        nb.appendChild(nl);
        if (_noteTwo) {
          /* 两段式概述：一项两行 —— 功能段（人话）+ 实现段（技术梗概） */
          const pd = document.createElement("p");
          pd.textContent =
            I18n.t("模块功能（面向非技术）：") +
            (String(opts.note.design || "").trim() ||
              I18n.t("（暂无 · 请先说明该模块在业务上做什么、给谁用）"));
          nb.appendChild(pd);
          const pi = document.createElement("p");
          pi.textContent =
            I18n.t("实现要点（面向技术）：") +
            (String(opts.note.impl || "").trim() ||
              I18n.t("（暂无 · 细化或开发时按两段式规范补全）"));
          nb.appendChild(pi);
        } else {
          const np = document.createElement("p");
          np.textContent = _noteBody;
          nb.appendChild(np);
        }
        frag.appendChild(nb);
      } else if (opts.note) {
        const nb = document.createElement("div");
        nb.className = "mt-form-note empty";
        nb.textContent =
          (opts.note.label || I18n.t("概述")) + "：" + I18n.t("（暂无概述）");
        frag.appendChild(nb);
      }
      if (opts.list && Array.isArray(opts.list.items) && opts.list.items.length) {
        const lb = document.createElement("div");
        lb.className = "mt-form-list";
        const lt = document.createElement("i");
        lt.textContent = opts.list.label || "";
        lb.appendChild(lt);
        const ul = document.createElement("div");
        for (const it of opts.list.items.slice(0, 30)) {
          const li = document.createElement("span");
          li.className = "mt-form-li";
          li.textContent = String(it);
          ul.appendChild(li);
        }
        if (opts.list.items.length > 30) {
          const li = document.createElement("span");
          li.className = "mt-form-li more";
          li.textContent = "… +" + (opts.list.items.length - 30);
          ul.appendChild(li);
        }
        lb.appendChild(ul);
        frag.appendChild(lb);
      }
      if (opts.msg) {
        const p = document.createElement("p");
        p.className = "mt-dialog-msg";
        p.textContent = String(opts.msg);
        frag.appendChild(p);
      }
      if (opts.warn) {
        const p = document.createElement("p");
        p.className = "mt-form-warn";
        p.textContent = String(opts.warn);
        frag.appendChild(p);
      }
      if (opts.textarea) {
        const lab = document.createElement("label");
        lab.className = "mt-form-lab";
        lab.textContent = opts.textarea.label || I18n.t("说明");
        frag.appendChild(lab);
        ta = document.createElement("textarea");
        ta.className = "mt-form-input";
        ta.rows = Number(opts.textarea.rows || 5);
        ta.placeholder = opts.textarea.placeholder || "";
        ta.value = String(opts.textarea.value || "");
        frag.appendChild(ta);
        /* 草稿提示：本框回填了上次未提交的内容（见 opts.onText 的实时留存），
           并给一个显式丢弃入口 —— 不想接着写上「清空草稿」即可，不必手动全选删除 */
        if (opts.textarea.draft && String(ta.value || "").trim()) {
          const dn = document.createElement("div");
          dn.className = "mt-form-draft";
          const ds = document.createElement("span");
          ds.textContent = I18n.t("已恢复上次未提交的内容");
          dn.appendChild(ds);
          const db = document.createElement("button");
          db.type = "button";
          db.className = "mini";
          db.textContent = I18n.t("清空草稿");
          db.title = I18n.t("丢弃上次未提交的内容，重新填写");
          db.onclick = () => {
            ta.value = "";
            ta.focus();
            emitDraft();
            dn.remove();
          };
          dn.appendChild(db);
          frag.appendChild(dn);
        }
        errP = document.createElement("p");
        errP.className = "mt-form-err";
        errP.textContent = opts.textarea.requiredMsg || I18n.t("请先填写内容");
        errP.hidden = true;
        frag.appendChild(errP);
        ta.addEventListener("input", () => {
          emitDraft();
          if (!String(ta.value || "").trim()) return;
          ta.classList.remove("invalid");
          if (errP) errP.hidden = true;
        });
      }
      if (opts.hint) {
        const p = document.createElement("p");
        p.className = "mt-form-hint";
        p.textContent = String(opts.hint);
        frag.appendChild(p);
      }
      if (typeof opts.custom === "function") {
        const c = document.createElement("div");
        c.className = "mt-form-custom";
        frag.appendChild(c);
        opts.custom(c, (value) => {
          if (customSelect) customSelect(value);
        });
      }
      bodyEl.appendChild(frag);
    }
    const acts =
      Array.isArray(opts.actions) && opts.actions.length
        ? opts.actions
        : [
            { id: "cancel", label: I18n.t("取消") },
            { id: "ok", label: I18n.t("确定"), primary: true },
          ];
    if (footEl) footEl.innerHTML = "";
    let done = false;
    const cleanup = () => {
      host.removeEventListener("keydown", onKey);
      closeMtDialog();
      if (box) {
        box.classList.remove("mt-form-box");
        box.classList.remove("mt-form-wide");
      }
    };
    const finish = (action, force) => {
      if (done || seq !== _mtDialogSeq) return;
      const text = ta ? String(ta.value || "") : "";
      if (
        !force &&
        action &&
        opts.requireText &&
        !String(text).trim() &&
        errP
      ) {
        errP.hidden = false;
        ta.classList.add("invalid");
        try {
          ta.focus();
        } catch (_) {}
        return;
      }
      done = true;
      cleanup();
      resolve(action ? { action, text } : null);
    };
    customSelect = (value) => {
      if (done || seq !== _mtDialogSeq) return;
      done = true;
      cleanup();
      resolve({ action: "ok", custom: value });
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        finish(null, true);
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        const pri = acts.find((a) => a.primary) || acts[acts.length - 1];
        finish(pri ? pri.id : "ok");
      }
    };
    let primaryBtn = null;
    for (const a of acts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = a.primary ? "mini primary" : a.danger ? "mini danger" : "mini";
      b.textContent = a.label || a.id;
      b.onclick = () => {
        if (a.id === "cancel") finish(null, true);
        else finish(a.id);
      };
      if (a.primary) primaryBtn = b;
      if (footEl) footEl.appendChild(b);
    }
    host.classList.add("on");
    host.addEventListener("keydown", onKey);
    setTimeout(() => {
      try {
        if (ta) ta.focus();
        else if (primaryBtn) primaryBtn.focus();
      } catch (_) {}
    }, 0);
  });
}

function nodeGuideId(node) {
  if (!node) return "";
  if (isSaveNode(node)) return "save";
  if (node.kind === "control") {
    if (node.ctrlRole === "start") return "ctrl-start";
    if (node.ctrlRole === "endSuccess") return "ctrl-end-ok";
    if (node.ctrlRole === "endFail") return "ctrl-end-fail";
    return "control";
  }
  return node.kind || "";
}

function closeNodeGuideDlg() {
  const host = document.getElementById("nodeGuideDlg");
  if (host) host.classList.remove("on");
}

function ensureNodeGuideDlg() {
  let host = document.getElementById("nodeGuideDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "nodeGuideDlg";
  host.className = "mt-dialog node-guide-dlg";
  host.innerHTML =
    '<div class="mt-dialog-box node-guide-box" role="dialog" aria-modal="false">' +
    '<div class="mt-dialog-head node-guide-head">' +
    '<b id="nodeGuideTitle"></b>' +
    '<button type="button" class="mini node-guide-x" id="nodeGuideClose" title="">✕</button>' +
    "</div>" +
    '<div class="mt-dialog-body node-guide-body md" id="nodeGuideBody"></div>' +
    '<div class="mt-dialog-foot">' +
    '<button type="button" class="mini" id="nodeGuideOk"></button>' +
    "</div></div>";
  document.body.appendChild(host);
  const close = () => closeNodeGuideDlg();
  host.querySelector("#nodeGuideClose").onclick = close;
  host.querySelector("#nodeGuideOk").onclick = close;
  host.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });
  return host;
}

function renderGuideMarkdown(text, assets) {
  let html = renderMarkdown(text);
  assets = assets || {};
  html = html.replace(/<img src="([^"]+)"/g, (m, u) => {
    const raw = String(u || "").trim();
    const hit = assets[raw] || assets[decodeURIComponent(raw)];
    if (hit) return '<img src="' + hit + '"';
    return m;
  });
  return html;
}

async function openNodeGuide(node) {
  const id = nodeGuideId(node);
  if (!id) {
    toast(I18n.t("找不到该节点指南"), "warn");
    return;
  }
  const host = ensureNodeGuideDlg();
  const titleEl = host.querySelector("#nodeGuideTitle");
  const body = host.querySelector("#nodeGuideBody");
  const footBtn = host.querySelector("#nodeGuideOk");
  const xBtn = host.querySelector("#nodeGuideClose");
  const name = node.title || I18n.t(nodeKindLabel(node)) || id;
  if (titleEl) titleEl.textContent = I18n.t("节点指南") + " · " + name;
  if (footBtn) footBtn.textContent = I18n.t("关闭");
  if (xBtn) xBtn.title = I18n.t("关闭");
  if (body) body.innerHTML = "<p class='n-empty'>" + I18n.t("载入中…") + "</p>";
  host.classList.add("on");
  try {
    const loc = I18n.getLocale ? I18n.getLocale() : "zh";
    const r = await window.api.guideLoad(id, loc);
    if (!r || !r.ok) {
      if (body)
        body.innerHTML =
          "<p class='n-empty'>" +
          I18n.t("找不到该节点指南") +
          " <code>" +
          id +
          "</code></p>";
      return;
    }
    if (body) body.innerHTML = renderGuideMarkdown(r.markdown, r.assets);
  } catch (e) {
    if (body)
      body.innerHTML =
        "<p class='n-empty'>" +
        I18n.t("载入失败：") +
        ((e && e.message) || String(e)) +
        "</p>";
  }
}

const APP_DOCS = {
  catalog: null,
  pageId: "",
  filter: "",
  chat: [],
  busy: false,
  askOpen: false,
  bundle: "",
  pageTitle: "",
};

function docsLocale() {
  return I18n.getLocale && I18n.getLocale() === "en" ? "en" : "zh";
}

function docsLocText(obj, fallback) {
  if (!obj) return fallback || "";
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object") return fallback || "";
  const loc = docsLocale();
  return obj[loc] || obj.zh || obj.en || fallback || "";
}

function closeAppDocs() {
  const host = document.getElementById("appDocsDlg");
  if (!host) return;
  host.classList.remove("on", "ask-on");
  APP_DOCS.askOpen = false;
  const btn = $("#btnDocs");
  if (btn) btn.classList.remove("on");
}

function appDocsOnEscape() {
  const host = document.getElementById("appDocsDlg");
  if (!host || !host.classList.contains("on")) return;
  if (APP_DOCS.askOpen) {
    setDocsAskOpen(false);
    return;
  }
  closeAppDocs();
}

function setDocsAskOpen(on) {
  APP_DOCS.askOpen = !!on;
  const host = document.getElementById("appDocsDlg");
  if (host) host.classList.toggle("ask-on", APP_DOCS.askOpen);
  const toggle = host && host.querySelector("#appDocsAskBtn");
  if (toggle) toggle.classList.toggle("on", APP_DOCS.askOpen);
  if (APP_DOCS.askOpen) {
    const ta = host && host.querySelector("#appDocsAskInput");
    if (ta) setTimeout(() => ta.focus(), 0);
  }
}

function paintAppDocsChrome() {
  const host = document.getElementById("appDocsDlg");
  if (!host) return;
  const title = host.querySelector("#appDocsTitle");
  const askBtn = host.querySelector("#appDocsAskBtn");
  const closeBtn = host.querySelector("#appDocsClose");
  const filter = host.querySelector("#appDocsFilter");
  const askTitle = host.querySelector("#appDocsAskTitle");
  const askSub = host.querySelector("#appDocsAskSub");
  const askSend = host.querySelector("#appDocsAskSend");
  const askHide = host.querySelector("#appDocsAskHide");
  const inp = host.querySelector("#appDocsAskInput");
  if (title) title.textContent = I18n.t("使用手册");
  if (askBtn) {
    askBtn.textContent = I18n.t("答疑");
    askBtn.title = I18n.t("文档答疑：仅根据本手册回答，不会操作画布");
  }
  if (closeBtn) closeBtn.title = I18n.t("关闭");
  if (filter) filter.placeholder = I18n.t("筛选目录…");
  if (askTitle) askTitle.textContent = I18n.t("文档答疑");
  if (askSub)
    askSub.textContent = I18n.t("仅根据内置手册作答，不会改画布");
  if (askSend) askSend.textContent = I18n.t("发送");
  if (askHide) askHide.title = I18n.t("关闭");
  if (inp)
    inp.placeholder = I18n.t("问手册…（Enter 发送，Shift+Enter 换行）");
}

function ensureAppDocsDlg() {
  let host = document.getElementById("appDocsDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "appDocsDlg";
  host.className = "mt-dialog app-docs-dlg";
  host.innerHTML =
    '<div class="mt-dialog-box app-docs-box" role="dialog" aria-modal="true">' +
    '<div class="app-docs-head">' +
    '<b id="appDocsTitle"></b>' +
    '<div class="app-docs-head-actions">' +
    '<button type="button" class="mini" id="appDocsAskBtn"></button>' +
    '<button type="button" class="mini node-guide-x" id="appDocsClose">✕</button>' +
    "</div></div>" +
    '<div class="app-docs-main">' +
    '<aside class="app-docs-nav">' +
    '<input id="appDocsFilter" class="app-docs-filter" type="text">' +
    '<nav class="app-docs-tree" id="appDocsTree"></nav>' +
    "</aside>" +
    '<article class="app-docs-article md" id="appDocsBody"></article>' +
    '<aside class="app-docs-ask" id="appDocsAskPane">' +
    '<div class="app-docs-ask-head">' +
    '<b id="appDocsAskTitle"></b>' +
    '<span class="app-docs-ask-sub" id="appDocsAskSub"></span>' +
    '<button type="button" class="mini" id="appDocsAskHide">✕</button>' +
    "</div>" +
    '<div class="app-docs-ask-list" id="appDocsAskList"></div>' +
    '<div class="app-docs-ask-foot">' +
    '<textarea id="appDocsAskInput" rows="2"></textarea>' +
    '<button type="button" class="mini primary" id="appDocsAskSend"></button>' +
    "</div></aside></div></div>";
  document.body.appendChild(host);
  host.querySelector("#appDocsClose").onclick = () => closeAppDocs();
  host.querySelector("#appDocsAskBtn").onclick = () =>
    setDocsAskOpen(!APP_DOCS.askOpen);
  host.querySelector("#appDocsAskHide").onclick = () => setDocsAskOpen(false);
  host.querySelector("#appDocsAskSend").onclick = () => sendDocsAsk();
  host.addEventListener("click", (ev) => {
    if (ev.target === host) closeAppDocs();
  });
  const filter = host.querySelector("#appDocsFilter");
  filter.addEventListener("input", () => {
    APP_DOCS.filter = filter.value || "";
    renderDocsNav();
  });
  host.querySelector("#appDocsBody").addEventListener("click", (ev) => {
    const a = ev.target.closest && ev.target.closest("a");
    if (!a) return;
    const href = String(a.getAttribute("href") || "");
    if (href.charAt(0) === "#") {
      ev.preventDefault();
      const id = href.slice(1).replace(/[^a-z0-9_-]/gi, "");
      if (id) loadDocsPage(id);
      return;
    }
    if (/^https?:/i.test(href)) {
      ev.preventDefault();
      if (window.api && window.api.openInAppDialog)
        window.api.openInAppDialog({ kind: "url", target: href });
      else if (window.api && window.api.openExternal) window.api.openExternal(href);
    }
  });
  const ta = host.querySelector("#appDocsAskInput");
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendDocsAsk();
    }
  });
  renderDocsAskList();
  return host;
}

function renderDocsNav() {
  const host = document.getElementById("appDocsDlg");
  const tree = host && host.querySelector("#appDocsTree");
  if (!tree) return;
  const cat = APP_DOCS.catalog;
  const q = String(APP_DOCS.filter || "")
    .trim()
    .toLowerCase();
  tree.innerHTML = "";
  if (!cat || !Array.isArray(cat.sections)) {
    const empty = document.createElement("p");
    empty.className = "n-empty";
    empty.textContent = I18n.t("找不到该文档");
    tree.appendChild(empty);
    return;
  }
  let shown = 0;
  for (const sec of cat.sections) {
    const pages = (sec.pages || []).filter((p) => {
      if (!q) return true;
      const t =
        docsLocText(p.title, p.id) +
        " " +
        docsLocText(sec.title, sec.id) +
        " " +
        (p.id || "");
      return t.toLowerCase().indexOf(q) >= 0;
    });
    if (!pages.length) continue;
    const wrap = document.createElement("div");
    wrap.className = "app-docs-sec";
    const h = document.createElement("div");
    h.className = "app-docs-sec-title";
    h.textContent = docsLocText(sec.title, sec.id);
    wrap.appendChild(h);
    for (const page of pages) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "app-docs-page-btn";
      if (page.id === APP_DOCS.pageId) b.classList.add("on");
      b.textContent = docsLocText(page.title, page.id);
      b.onclick = () => loadDocsPage(page.id);
      wrap.appendChild(b);
      shown += 1;
    }
    tree.appendChild(wrap);
  }
  if (!shown) {
    const empty = document.createElement("p");
    empty.className = "n-empty";
    empty.textContent = I18n.t("无匹配项");
    tree.appendChild(empty);
  }
}

function docsPageMeta(id) {
  const cat = APP_DOCS.catalog;
  if (!cat) return null;
  for (const sec of cat.sections || []) {
    for (const page of sec.pages || []) {
      if (page.id === id)
        return {
          section: docsLocText(sec.title, sec.id),
          title: docsLocText(page.title, page.id),
        };
    }
  }
  return null;
}

async function loadDocsPage(id) {
  const host = ensureAppDocsDlg();
  const body = host.querySelector("#appDocsBody");
  const safe = String(id || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) return;
  APP_DOCS.pageId = safe;
  const meta = docsPageMeta(safe);
  APP_DOCS.pageTitle = meta
    ? meta.section + " / " + meta.title
    : safe;
  renderDocsNav();
  if (body) body.innerHTML = "<p class='n-empty'>" + I18n.t("载入中…") + "</p>";
  try {
    const r = await window.api.docsLoad(safe, docsLocale());
    if (!r || !r.ok) {
      if (body)
        body.innerHTML =
          "<p class='n-empty'>" +
          I18n.t("找不到该文档") +
          " <code>" +
          safe +
          "</code></p>";
      return;
    }
    if (body) {
      body.innerHTML = renderGuideMarkdown(r.markdown, r.assets);
      body.scrollTop = 0;
    }
  } catch (e) {
    if (body)
      body.innerHTML =
        "<p class='n-empty'>" +
        I18n.t("载入失败：") +
        ((e && e.message) || String(e)) +
        "</p>";
  }
}

function renderDocsAskList() {
  const host = document.getElementById("appDocsDlg");
  const list = host && host.querySelector("#appDocsAskList");
  if (!list) return;
  list.innerHTML = "";
  if (!APP_DOCS.chat.length) {
    const hint = document.createElement("div");
    hint.className = "app-docs-ask-hint";
    hint.textContent = I18n.t(
      "可以问「闸门为什么不放行」「如何配置 API Key」等。回答只依据左侧手册。",
    );
    list.appendChild(hint);
    return;
  }
  for (const msg of APP_DOCS.chat) {
    const row = document.createElement("div");
    row.className =
      "app-docs-ask-msg " + (msg.role === "user" ? "me" : "ai");
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    if (msg.role === "assistant") {
      const md = document.createElement("div");
      md.className = "md";
      md.innerHTML = renderMarkdown(msg.content || "");
      bubble.appendChild(md);
    } else {
      bubble.innerHTML = plainTextToLinkHtml(msg.content || "");
    }
    row.appendChild(bubble);
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

function docsSystemPrompt() {
  const loc = docsLocale();
  if (loc === "en") {
    return (
      "You are the built-in manual assistant for MTNode AI Orchestrator. " +
      "Answer ONLY from the manual text provided. Do not operate the canvas, " +
      "call tools, or invent features. If the manual does not say, say you don't know " +
      "and point the user to a section name or the per-node right-click Node guide. " +
      "Cite section titles when possible. Reply in the user's language.\n\n" +
      "Current page: " +
      (APP_DOCS.pageTitle || APP_DOCS.pageId || "") +
      "\n\n--- MANUAL ---\n" +
      (APP_DOCS.bundle || "")
    );
  }
  return (
    "你是 MTNode AI编排器 的内置文档答疑助手。只能根据下方「内置手册」回答。" +
    "不要操作画布、不要调用工具、不要编造手册里没有的功能。" +
    "手册没写到就明确说不知道，并建议用户去对应章节，或右键节点打开「节点指南」。" +
    "回答时尽量指出一级/二级章节名。用用户提问的语言作答。\n\n" +
    "当前页面：" +
    (APP_DOCS.pageTitle || APP_DOCS.pageId || "") +
    "\n\n--- 内置手册 ---\n" +
    (APP_DOCS.bundle || "")
  );
}

async function sendDocsAsk() {
  const host = document.getElementById("appDocsDlg");
  const ta = host && host.querySelector("#appDocsAskInput");
  const text = ta ? String(ta.value || "").trim() : "";
  if (!text || APP_DOCS.busy) return;
  const prov =
    (S.config &&
      (S.config.providers || []).find(
        (p) => p.type === "text_openai" && String(p.apiKey || "").trim(),
      )) ||
    null;
  if (!prov) {
    toast(
      I18n.t("未配置带 API Key 的文本服务商（设置 · API/配置 → 模型服务）"),
      "warn",
    );
    return;
  }
  if (ta) ta.value = "";
  APP_DOCS.chat.push({ role: "user", content: text });
  APP_DOCS.chat.push({ role: "assistant", content: "" });
  APP_DOCS.busy = true;
  renderDocsAskList();
  const last = APP_DOCS.chat[APP_DOCS.chat.length - 1];
  if (!APP_DOCS.bundle) {
    try {
      const b = await window.api.docsBundle(docsLocale());
      APP_DOCS.bundle = (b && b.ok && b.text) || "";
    } catch (_) {
      APP_DOCS.bundle = "";
    }
  }
  if (!APP_DOCS.bundle) {
    last.content = I18n.t("找不到该文档");
    APP_DOCS.busy = false;
    renderDocsAskList();
    return;
  }
  const history = [];
  const prior = APP_DOCS.chat.slice(0, -1);
  const start = Math.max(0, prior.length - 8);
  for (let i = start; i < prior.length; i++) {
    const m = prior[i];
    history.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    });
  }
  const spec = {
    provider: prov,
    kind: "text",
    model: (prov.models && prov.models[0]) || "",
    temperature: 0.2,
    prompt: "",
    texts: [],
    images: [],
    chatMessages: [{ role: "system", content: docsSystemPrompt() }].concat(
      history,
    ),
  };
  let acc = "";
  let raf = 0;
  const flush = () => {
    raf = 0;
    last.content = acc;
    renderDocsAskList();
  };
  try {
    const r = await apiCallTextStream(spec, null, (t) => {
      acc += t || "";
      if (!raf) raf = requestAnimationFrame(flush);
    });
    last.content = (r && r.text) || acc || last.content || "";
  } catch (e) {
    last.content =
      I18n.t("助手失败：") + ((e && e.message) || String(e));
  } finally {
    if (raf) cancelAnimationFrame(raf);
    APP_DOCS.busy = false;
    renderDocsAskList();
  }
}

async function refreshAppDocsIfOpen() {
  const host = document.getElementById("appDocsDlg");
  if (!host || !host.classList.contains("on")) return;
  paintAppDocsChrome();
  APP_DOCS.bundle = "";
  try {
    const r = await window.api.docsCatalog();
    if (r && r.ok) APP_DOCS.catalog = r.catalog;
  } catch (_) {}
  renderDocsNav();
  if (APP_DOCS.pageId) await loadDocsPage(APP_DOCS.pageId);
  renderDocsAskList();
}

async function openAppDocs(pageId) {
  const host = ensureAppDocsDlg();
  paintAppDocsChrome();
  host.classList.add("on");
  const btn = $("#btnDocs");
  if (btn) btn.classList.add("on");
  if (APP_DOCS.askOpen) host.classList.add("ask-on");
  const body = host.querySelector("#appDocsBody");
  if (body && !APP_DOCS.pageId)
    body.innerHTML = "<p class='n-empty'>" + I18n.t("载入中…") + "</p>";
  try {
    const r = await window.api.docsCatalog();
    if (!r || !r.ok) {
      if (body)
        body.innerHTML =
          "<p class='n-empty'>" +
          I18n.t("载入失败：") +
          ((r && r.error) || I18n.t("找不到该文档")) +
          "</p>";
      APP_DOCS.catalog = { sections: [] };
      renderDocsNav();
      return;
    }
    APP_DOCS.catalog = r.catalog;
  } catch (e) {
    if (body)
      body.innerHTML =
        "<p class='n-empty'>" +
        I18n.t("载入失败：") +
        ((e && e.message) || String(e)) +
        "</p>";
    return;
  }
  const fallback =
    (APP_DOCS.catalog && APP_DOCS.catalog.defaultPage) || "overview";
  const want = String(pageId || APP_DOCS.pageId || fallback);
  await loadDocsPage(want);
}

function yamlEscape(s) {
  s = String(s == null ? "" : s);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_.\-，。、\u4e00-\u9fa5]+$/.test(s) && !s.includes(":"))
    return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
function yamlDump(entries) {
  const counts = {};
  for (const e of entries) {
    const k = e.key || "input";
    counts[k] = (counts[k] || 0) + 1;
  }
  const used = {};
  const lines = [];
  for (const e of entries) {
    let key = e.key || "input";
    used[key] = (used[key] || 0) + 1;
    if (counts[key] > 1 && used[key] > 1) key = key + " (" + used[key] + ")";
    const text = String(e.text == null ? "" : e.text);
    if (text.includes("\n")) {
      lines.push(yamlEscape(key) + ": |");
      for (const ln of text.split("\n")) lines.push("  " + ln);
    } else {
      lines.push(yamlEscape(key) + ": " + yamlEscape(text));
    }
  }
  return lines.join("\n") + "\n";
}

/* YAML 键：仅批条目标题 / 字段名；节点标题与空键一律不加外壳 */
function yamlSaveKey(preferred, nodeTitle) {
  const k = String(preferred == null ? "" : preferred).trim();
  const nt = String(nodeTitle == null ? "" : nodeTitle).trim();
  if (k && (!nt || k !== nt)) return k;
  return "";
}

/* 落盘正文：单路原样写出（纯 YAML/文本，不包节点标题或 input:）；
   多路且均有批字段名 → YAML 映射；否则多文档拼接 */
function yamlSaveBody(entries) {
  const list = (entries || []).filter((e) => e && e.text != null);
  if (!list.length) return "";
  if (list.length === 1) {
    const t = String(list[0].text || "");
    return t.endsWith("\n") ? t : t + "\n";
  }
  const keyed = [];
  for (const e of list) {
    const k = String(e.key || "").trim();
    if (k) keyed.push({ key: k, text: e.text });
  }
  if (keyed.length === list.length) return yamlDump(keyed);
  return (
    list
      .map((e) => String(e.text || "").replace(/\s+$/g, ""))
      .filter((t) => t.length)
      .join("\n---\n") + "\n"
  );
}

/* 简单 YAML 解析（缩进感知）：
   - 顶层（基准缩进）的 key: value / key: | 块 / - key: value 列表项 → 条目
   - 更深缩进的行视为当前条目的续行内容（嵌套结构不会产生垃圾条目） */
function unquoteYaml(s) {
  s = String(s);
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))
  )
    return s.slice(1, -1);
  return s;
}
function parseSimpleYaml(text) {
  const entries = [];
  let cur = null;
  let baseIndent = -1;
  const push = () => {
    if (cur && cur.title) entries.push(cur);
    cur = null;
  };
  for (const raw of String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.replace(/^\s+/, "").length;
    if (baseIndent === -1) baseIndent = indent;
    if (indent > baseIndent) {
      if (cur) {
        // 块续行 / 嵌套内容 → 归入当前条目，不新建条目
        const content = trimmed;
        cur.content = cur.content ? cur.content + "\n" + content : content;
      }
      continue;
    }
    push();
    if (trimmed.startsWith("- ")) {
      const m = trimmed
        .slice(2)
        .trim()
        .match(/^([^:]+):\s*(.*)$/);
      if (m)
        cur = {
          title: unquoteYaml(m[1].trim()),
          content: unquoteYaml(m[2].trim()),
        };
      continue;
    }
    const block = trimmed.match(/^([^:]+):\s*\|/);
    const kv = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (block) cur = { title: unquoteYaml(block[1].trim()), content: "" };
    else if (kv)
      cur = {
        title: unquoteYaml(kv[1].trim()),
        content: unquoteYaml(kv[2].trim()),
      };
  }
  push();
  return entries;
}

function safeFile(s) {
  return (
    String(s || "item")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "") || "item"
  );
}
function extOf(p) {
  const m = /\.([^.\\/]+)$/.exec(String(p));
  return m ? m[0] : "";
}
/* 路径扩展名（小写，不含点）；无扩展名返回空串 */
function fileExtNoDot(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p || ""));
  return m ? m[1].toLowerCase() : "";
}
/* 音频 / 视频输入节点与文件对话框共用的扩展名清单（浏览器 <audio>/<video> 可播的优先） */
const AUDIO_FILE_EXTS = [
  "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "amr", "aiff", "aif", "weba",
];
const VIDEO_FILE_EXTS = [
  "mp4", "m4v", "webm", "mov", "avi", "mkv", "wmv", "flv", "3gp", "mpg", "mpeg", "ogv",
];
/* 该路径按扩展名属于哪种媒体：'audio' | 'video' | '' */
function mediaKindOfPath(p) {
  const e = fileExtNoDot(p);
  if (!e) return "";
  if (AUDIO_FILE_EXTS.indexOf(e) >= 0) return "audio";
  if (VIDEO_FILE_EXTS.indexOf(e) >= 0) return "video";
  return "";
}
/* 拖文件进画布时用的图像清单：只列 Chromium <img> 能直接显示的格式
   （tiff / heic 等不进图像节点，落到「其他」→ 开发文件块，避免建出一个瞎图） */
const IMAGE_FILE_EXTS = [
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "ico", "avif", "apng",
];
/* 可当正文读进「文本节点」的扩展名：文档 / 数据 / 代码 / 配置 / 脚本 */
const TEXT_FILE_EXTS = [
  "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "log", "json",
  "json5", "jsonc", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "properties", "env", "csv", "tsv", "xml", "html", "htm", "css", "scss",
  "sass", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts",
  "vue", "svelte", "py", "pyw", "rb", "go", "rs", "java", "kt", "kts",
  "swift", "c", "h", "cpp", "hpp", "cc", "cs", "php", "lua", "pl", "r",
  "sql", "sh", "bash", "zsh", "bat", "cmd", "ps1", "nsh", "nsi", "proto",
  "graphql", "gql", "tpl", "njk", "mustache", "po", "pot", "srt", "vtt",
];
/* 外部拖入的文件该建哪种节点：'image' | 'text' | 'audio' | 'video' | 'other'
   （other = 未知/二进制，一律建成开发节点「文件」块，只留路径引用） */
function classifyDropFile(p) {
  const e = fileExtNoDot(p);
  if (!e) return "other";
  if (IMAGE_FILE_EXTS.indexOf(e) >= 0) return "image";
  const m = mediaKindOfPath(p);
  if (m) return m;
  if (TEXT_FILE_EXTS.indexOf(e) >= 0) return "text";
  return "other";
}
/* 路径无扩展名时补上 fallback（如 .png），避免批量保存立绘变成无后缀文件 */
function ensurePathHasExt(p, fallbackExt) {
  const s = String(p || "");
  if (extOf(s)) return s;
  let e = String(fallbackExt || ".png").trim();
  if (!e) e = ".png";
  if (!e.startsWith(".")) e = "." + e;
  return s + e;
}
function batchOutPath(p, title, fallbackExt) {
  const pathStr = ensurePathHasExt(p, fallbackExt);
  const e = extOf(pathStr);
  const base = e ? pathStr.slice(0, -e.length) : pathStr;
  return base + "_" + safeFile(title) + e;
}
function fileName(p) {
  return String(p).split(/[\\/]/).pop() || p;
}
/* 图像路径去扩展名后的主名（用于标题 / 角色名） */
function imageStem(p) {
  const n = fileName(p).replace(/\.[^.]+$/, "");
  return String(n || "").trim();
}
/* 条目标题：手动 title → 载入时记住的源文件名 sourceName → 资产路径名 → 占位 */
function entryDisplayTitle(e, idx) {
  const t = String((e && e.title) || "").trim();
  if (t) return t;
  const sn = String((e && e.sourceName) || "").trim();
  if (sn) return sn;
  const p = e && (e.path || (e.value && e.value.path) || e.imageAsset);
  if (p) {
    const n = imageStem(p);
    if (n) return n;
  }
  if (idx != null) return "item" + (idx + 1);
  return I18n.t("条目");
}
/* 单图节点标题：sourceName → 资产路径名 → 节点标题 */
function singleImageTitle(node) {
  if (!node) return I18n.t("图像");
  const sn = String(node.sourceName || "").trim();
  if (sn) return sn;
  if (node.imageAsset) {
    const n = imageStem(node.imageAsset);
    if (n) return n;
  }
  return node.title || I18n.t("图像");
}
/* 复制本机图像到工作流资产，并返回原始文件名（不含扩展名）供下游作标题 */
async function copyImageFromPath(srcPath, nameHint) {
  const sourceName = imageStem(srcPath) || "img";
  const hint = String(nameHint || "img").replace(/[^\w.-]+/g, "_") || "img";
  const res = await window.api.assetCopy(
    srcPath,
    S.wf.id,
    hint + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e4),
  );
  if (!res || !res.path) throw new Error(I18n.t("复制失败"));
  invalidateImageMeta(res.path);
  return { path: res.path, sourceName };
}
function makeImageBatchEntry(path, sourceName, title) {
  const sn = String(sourceName || "").trim() || imageStem(path) || "img";
  const ti = String(title != null ? title : sn).trim() || sn;
  return { id: uid("e"), title: ti, sourceName: sn, path };
}

/* ============ 端子 / 连线几何（居中分布） ============ */

function nodePortHeight(node) {
  if (node && node.kind === "super") return superDisplaySize(node).h;
  return (node && node.h) || 160;
}
/* 端子 Y：在“从上至下”的接线排内分布（与插排占满高度一致）。
   opts: top 内容起点、bottom 底部留白、bandA/bandB 带上下界比例、min 最小 Y、
   step 相邻端子间距（缺省 = PORT_STEP；超级节点内侧端子排用更宽的呼吸间距）。
   端子从靠近顶端开始、逐次向下排列；端子过多放不下时退回整段可用区内居中，避免溢出节点。 */
function portBandY(totalH, i, count, opts) {
  const o = opts || {};
  const step = Number(o.step) > 0 ? Number(o.step) : PORT_STEP;
  const h = Math.max(1, totalH || 1);
  const inner = Math.max(1, h - (o.top || 0) - (o.bottom || 0));
  const bandTop = (o.top || 0) + inner * (o.bandA == null ? 0.18 : o.bandA);
  const bandBot = (o.top || 0) + inner * (o.bandB == null ? 0.82 : o.bandB);
  const span = Math.max(0, (count || 1) - 1) * step;
  let start;
  if (span <= bandBot - bandTop) {
    /* 插槽从靠近顶端开始，逐次向下（不再居中分布） */
    start = Math.round(bandTop);
  } else {
    start = (o.top || 0) + Math.round((inner - span) / 2);
    if (start < (o.top || 0)) start = o.top || 0;
  }
  return Math.max(o.min || 0, start + i * step);
}
function inPortY(node, i, ic) {
  return portBandY(nodePortHeight(node), i, ic, {
    top: 45, bottom: 5, min: 45, bandA: 0, bandB: 1,
  });
}
function outPortY(node, i, oc) {
  const n = oc == null ? outputCount(node) : oc;
  return portBandY(nodePortHeight(node), i, n, {
    top: 45, bottom: 5, min: 45, bandA: 0, bandB: 1,
  });
}
function superInnerPortY(stageH, i, count) {
  const h = Math.max(120, stageH || 200);
  /* 起点必须由 top 给，不能只靠 min 兜底（与上面 inPortY / outPortY 的 min == top 同一口径）：
     bandA=0 时 portBandY 的 start = top，返回 max(min, start + i*step)。旧口径传
     top:0 + min:24 → 第 1、2、3 个端子全被算成 max(24, 0|12|24)=24，整列压在同一点上。
     普通超级节点的端子随连线伸缩、往往就 1 个，看不出来；工具节点「参数即端子」两侧各
     ≥2 个（控制 + 参数），展开壳 / 进入内部画布后内侧输入端子与内侧输出端子各自重合，
     分不清也点不中。内侧端子排挂在整面子画布的左右缘，间距放宽到 22px（端子命中座
     高 20px），相邻端子的命中区不再互相压盖。 */
  return portBandY(h, i, count, {
    top: 24, bottom: 12, min: 24, bandA: 0, bandB: 1, step: 22,
  });
}
/** 全屏进入态：内侧端子钉在 #canvas 可视区左右边缘（屏幕坐标→舞台坐标） */
function superFocusBridgePos(host, fromIndex) {
  const canvas = $("#canvas");
  if (!canvas) return { x: 16, y: 120 };
  const r = canvas.getBoundingClientRect();
  const y =
    r.top +
    superInnerPortY(r.height, fromIndex || 0, inputCount(host));
  return toStage(r.left + 10 + PORT_R, y);
}
function superFocusSinkPos(host, toIndex) {
  const canvas = $("#canvas");
  if (!canvas) return { x: 800, y: 120 };
  const r = canvas.getBoundingClientRect();
  const y =
    r.top +
    superInnerPortY(r.height, toIndex || 0, outputCount(host));
  return toStage(r.right - 10 - PORT_R, y);
}
function outPos(n, i, peer, wire) {
  const link = wire ? superWireInnerLink(wire) : null;
  if (link && link.super.id === n.id && link.dir === "out") {
    if (currentSuperFocus() === n.id) {
      return superFocusBridgePos(n, Number(wire.fromIndex || 0));
    }
    const p = nodeWorldPos(n);
    const o = superInnerOrigin(n);
    return {
      x: p.x + o.ox + 2 + PORT_R,
      y: p.y + o.oy + superBridgeLocalY(n, Number(wire.fromIndex || 0)),
    };
  }
  const p = nodeWorldPos(n);
  const sz = nodeDrawSize(n);
  const hNode = Object.assign({}, n, { h: sz.h, w: sz.w });
  return {
    x: p.x + sz.w - PORT_OFF - NODE_BORDER,
    y: p.y + outPortY(hNode, i || 0) + NODE_BORDER,
  };
}
function inPos(n, i, peer, wire) {
  const link = wire ? superWireInnerLink(wire) : null;
  if (link && link.super.id === n.id && link.dir === "in") {
    if (currentSuperFocus() === n.id) {
      return superFocusSinkPos(n, Number(wire.toIndex || 0));
    }
    const p = nodeWorldPos(n);
    const o = superInnerOrigin(n);
    const sz = superDisplaySize(n);
    const stageW = Math.max(80, sz.w - o.ox);
    return {
      x: p.x + o.ox + stageW - 2 - PORT_R,
      y: p.y + o.oy + superSinkLocalY(n, Number(wire.toIndex || 0)),
    };
  }
  const p = nodeWorldPos(n);
  const sz = nodeDrawSize(n);
  const hNode = Object.assign({}, n, { h: sz.h, w: sz.w });
  return {
    x: p.x + PORT_OFF + NODE_BORDER,
    y: p.y + inPortY(hNode, i, inputCount(n)) + NODE_BORDER,
  };
}
function wirePathAB(ax, ay, bx, by) {
  /* 真实电线感：以两端点中点为控制点向下自然下垂（重力弧度），
     不再使用 S 形三次贝塞尔，更接近实际线缆的松弛形态；
     下垂幅度随线长增大（min 14 / max 52），配合连线的投影阴影
     让电线看起来是悬空垂挂在画布上方 */
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const sag = Math.min(52, Math.max(14, len * 0.15));
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2 + sag * 2.5;
  return `M ${ax} ${ay} Q ${mx} ${my} ${bx} ${by}`;
}
function wirePath(from, to, idx, fromIndex, wire) {
  const a = outPos(from, fromIndex || 0, to, wire),
    b = inPos(to, idx, from, wire);
  return wirePathAB(a.x, a.y, b.x, b.y);
}

/* ============ 关系线（rel）：UML 风格直线关系线 ============
   仅表达模块 / 元素之间的关系，不参与数据流与执行；走线就是一条普通直线段。
   同一层级（主画布 / 展开壳层舞台）内的所有关系线一起规划：
   · 出射边选择（中心连线穿过哪条边）· 同侧多线扇形分散锚点 · 近似重合的直线彼此滑开
   → 避免多条线完全重合无法辨认。
   点选节点：与该节点相关（或以其为宿主）的关系线亮起，其余关系线退到背景。 */
const REL_ARROWS = ["forward", "backward", "both", "none"];
function relArrowOf(w) {
  const a = w && w.relArrow;
  return REL_ARROWS.indexOf(a) >= 0 ? a : "forward";
}
function relWireById(id) {
  if (!S.wf) return null;
  for (const w of S.wf.wires || []) if (w.id === id && w.rel) return w;
  return null;
}
/* 直线关系线：端点离边框留白 / 线上文字偏移 / 叠线错开的步长与尝试次数 */
const REL_END_GAP = 4;
const REL_LABEL_GAP = 9;
const REL_SEP_TOL = 11;
const REL_SEP_STEP = 14;
const REL_SEP_MAX = 8;
/* 节点矩形（世界坐标；给宿主时返回展开壳层舞台内的局部坐标） */
function relWireRect(n, host) {
  const sz = nodeDrawSize(n);
  if (host) {
    if (n.id === host.id) {
      /* 宿主自身：用整个舞台边界作为锚定矩形 */
      const stageW = Math.max(80, superDisplaySize(host).w - 8);
      const stageH = Math.max(60, superStageHeight(host));
      return { x: 4, y: 4, w: stageW - 8, h: stageH - 8 };
    }
    const pan = superInnerPan(host);
    return { x: pan.x + n.x, y: pan.y + n.y, w: sz.w, h: sz.h };
  }
  const p = nodeWorldPos(n);
  return { x: p.x, y: p.y, w: sz.w, h: sz.h };
}
function relRectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
/* 该关系线当前是否可见（与节点同层级） */
function relWireInScope(from, to) {
  const sf = currentSuperFocus();
  const focusInner = !!(
    sf &&
    ((from.id === sf && nodeInCurrentScope(to)) ||
      (to.id === sf && nodeInCurrentScope(from)))
  );
  if (focusInner) return true;
  return nodeInCurrentScope(from) && nodeInCurrentScope(to);
}
/* 直线锚点用的边：从方块中心朝对端引线，与边框的交点落在哪一条边 */
function relBorderAnchor(rect, toward) {
  const c = relRectCenter(rect);
  const dx = toward.x - c.x,
    dy = toward.y - c.y;
  if (!dx && !dy) return { x: c.x, y: rect.y, side: "t" };
  const hw = Math.max(1, rect.w / 2),
    hh = Math.max(1, rect.h / 2);
  const sx = dx ? hw / Math.abs(dx) : Infinity;
  const sy = dy ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return {
    x: c.x + dx * s,
    y: c.y + dy * s,
    side: sx < sy ? (dx > 0 ? "r" : "l") : dy > 0 ? "b" : "t",
  };
}
function relSidePoint(rect, side, along) {
  switch (side) {
    case "l":
      return { x: rect.x, y: along };
    case "r":
      return { x: rect.x + rect.w, y: along };
    case "t":
      return { x: along, y: rect.y };
    default:
      return { x: along, y: rect.y + rect.h };
  }
}
/* 同一节点同一侧多条线：按对端位置排序后沿该边均匀散开（扇形锚点）。
   返回与 peers 同序的坐标数组（沿该边方向的绝对坐标）。 */
function relSpreadSide(rect, side, peers) {
  const horiz = side === "l" || side === "r";
  const lo = horiz ? rect.y : rect.x;
  const len = Math.max(24, horiz ? rect.h : rect.w);
  const inset = Math.min(18, len * 0.14);
  let from = lo + inset,
    to = lo + len - inset;
  const n = peers.length;
  if (n <= 1) return [(from + to) / 2];
  /* 该边太短放不下最小间距时，保持中心不变向外撑开 */
  const need = (n - 1) * 20;
  if (to - from < need) {
    const c = (from + to) / 2;
    from = c - need / 2;
    to = c + need / 2;
  }
  const order = peers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p || a.i - b.i);
  const out = new Array(n);
  order.forEach((o, k) => {
    out[o.i] = from + ((to - from) * k) / (n - 1);
  });
  return out;
}
/* 点到线段的最短距离（判断两条直线是否贴得「看起来像一条」） */
function relPointSegDist(px, py, x0, y0, x1, y1) {
  const vx = x1 - x0,
    vy = y1 - y0;
  const L = vx * vx + vy * vy;
  const t = L ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / L)) : 0;
  return Math.hypot(px - (x0 + vx * t), py - (y0 + vy * t));
}
/* 两条直线段是否过近（采样点里有 3 个以上落在容差内即算叠线） */
function relSegsTooClose(s1, s2) {
  const ax = s1[0],
    ay = s1[1],
    bx = s1[2],
    by = s1[3];
  const cx = s2[0],
    cy = s2[1],
    dx = s2[2],
    dy = s2[3];
  let hit = 0;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    if (
      relPointSegDist(ax + (bx - ax) * t, ay + (by - ay) * t, cx, cy, dx, dy) <
      REL_SEP_TOL
    )
      hit++;
    if (hit > 4) break;
    if (
      relPointSegDist(cx + (dx - cx) * t, cy + (dy - cy) * t, ax, ay, bx, by) <
      REL_SEP_TOL
    )
      hit++;
    if (hit > 4) break;
  }
  return hit >= 3;
}
/* 一条直线：两端点 → { d, mid }（mid = 中点沿法线让开一点，放线上文字） */
function relStraightPath(a, b) {
  const r1 = (v) => Math.round(v * 10) / 10;
  let dx = b.x - a.x,
    dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len,
    uy = dy / len;
  const g = Math.min(REL_END_GAP, len / 4);
  const x0 = a.x + ux * g,
    y0 = a.y + uy * g;
  const x1 = b.x - ux * g,
    y1 = b.y - uy * g;
  let nx = -uy,
    ny = ux;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  return {
    d: "M " + r1(x0) + " " + r1(y0) + " L " + r1(x1) + " " + r1(y1),
    mid: {
      x: (x0 + x1) / 2 + nx * REL_LABEL_GAP,
      y: (y0 + y1) / 2 + ny * REL_LABEL_GAP,
    },
  };
}
/* 叠在一起的直线：把两端沿各自所在的边同步滑开（仍然贴边，只是换个进出点） */
function relSeparateStraight(items) {
  const placed = [];
  for (const it of items) {
    let A = it.a,
      B = it.b;
    for (let k = 0; k <= REL_SEP_MAX; k++) {
      const n = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2);
      const step = n * REL_SEP_STEP;
      A = relSidePoint(it.ra, it.sides[0], it.alongA + step);
      B = relSidePoint(it.rb, it.sides[1], it.alongB + step);
      const seg = [A.x, A.y, B.x, B.y];
      if (k === REL_SEP_MAX || !placed.some((s) => relSegsTooClose(seg, s))) {
        placed.push(seg);
        break;
      }
    }
    it.a = A;
    it.b = B;
  }
}
/* 一趟锚点规划：贴边出射 → 同一节点同一侧的多条线沿该边扇形散开。
   refine=false：按「对端方块中心」排序（第一趟）。
   refine=true ：按「对端上一趟算出的锚点」排序 —— 汇聚到同一侧的几条线按真实来向定序，
                 两端互相呼应，消掉这一类必然出现的 X 形交叉。 */
function relPlanAnchors(items, refine) {
  const attach = new Map();
  for (const it of items) {
    const ca = relRectCenter(it.ra),
      cb = relRectCenter(it.rb);
    /* 直线天然出射点：中心连线与边框的交点（单根线就用它，多根线才沿边散开） */
    const ba = relBorderAnchor(it.ra, cb),
      bb = relBorderAnchor(it.rb, ca);
    const sa = ba.side,
      sb = bb.side;
    it.sides = [sa, sb];
    const alongOf = (side, p) => (side === "l" || side === "r" ? p.y : p.x);
    const push = (key, rec) => {
      if (!attach.has(key)) attach.set(key, []);
      attach.get(key).push(rec);
    };
    push(it.from.id + "|" + sa, {
      it,
      end: "a",
      rect: it.ra,
      side: sa,
      peer:
        refine && it.b
          ? alongOf(sa, it.b)
          : sa === "l" || sa === "r"
            ? cb.y
            : cb.x,
      natural: alongOf(sa, ba),
    });
    push(it.to.id + "|" + sb, {
      it,
      end: "b",
      rect: it.rb,
      side: sb,
      peer:
        refine && it.a
          ? alongOf(sb, it.a)
          : sb === "l" || sb === "r"
            ? ca.y
            : ca.x,
      natural: alongOf(sb, bb),
    });
  }
  for (const list of attach.values()) {
    list.sort((x, y) => x.peer - y.peer);
    /* 只有一根线：直接走中心连线的出射点（最直的直线） */
    if (list.length === 1) {
      const rec = list[0];
      const pt = relSidePoint(rec.rect, rec.side, rec.natural);
      if (rec.end === "a") {
        rec.it.alongA = rec.natural;
        rec.it.a = pt;
      } else {
        rec.it.alongB = rec.natural;
        rec.it.b = pt;
      }
      continue;
    }
    const vals = relSpreadSide(
      list[0].rect,
      list[0].side,
      list.map((x) => x.peer),
    );
    list.forEach((rec, i) => {
      const along = vals[i];
      const pt = relSidePoint(rec.rect, rec.side, along);
      if (rec.end === "a") {
        rec.it.alongA = along;
        rec.it.a = pt;
      } else {
        rec.it.alongB = along;
        rec.it.b = pt;
      }
    });
  }
}
/* 同一节点同一侧的几条线：本端沿边顺序与「对端锚点顺序」相反的配对数。
   这正是视觉上 X 形交叉的来源（两条线进出同一块方块的顺序颠倒了）。 */
function relFanInversions(items) {
  const groups = new Map();
  const vert = (side) => side === "l" || side === "r";
  for (const it of items) {
    if (!it.a || !it.b || !it.sides) continue;
    const put = (key, along, far) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ along, far });
    };
    put(
      it.from.id + "|" + it.sides[0],
      it.alongA,
      vert(it.sides[1]) ? it.b.y : it.b.x,
    );
    put(
      it.to.id + "|" + it.sides[1],
      it.alongB,
      vert(it.sides[0]) ? it.a.y : it.a.x,
    );
  }
  let bad = 0;
  for (const list of groups.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if ((list[i].along - list[j].along) * (list[i].far - list[j].far) < 0)
          bad++;
  return bad;
}
/* 两条线段是否 X 形穿越（端点附近相接不算：几根线连到同一块方块 ≠ 互相交叉） */
function relSegsCross(s1, s2) {
  const d = (s1[0] - s1[2]) * (s2[1] - s2[3]) - (s1[1] - s1[3]) * (s2[0] - s2[2]);
  if (!d) return false;
  const t =
    ((s1[0] - s2[0]) * (s2[1] - s2[3]) - (s1[1] - s2[1]) * (s2[0] - s2[2])) / d;
  const u =
    ((s1[0] - s2[0]) * (s1[1] - s1[3]) - (s1[1] - s2[1]) * (s1[0] - s1[2])) / d;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}
/* 当前锚点下直线两两 X 交叉的对数（看得见的毛病，排序首要目标） */
function relGeomScore(items) {
  const segs = [];
  for (const it of items) {
    if (!it.a || !it.b) continue;
    segs.push([it.a.x, it.a.y, it.b.x, it.b.y]);
  }
  let n = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++)
      if (relSegsCross(segs[i], segs[j])) n++;
  return n;
}
function relAnchorSnapshot(items) {
  return items.map((it) => ({
    a: it.a,
    b: it.b,
    alongA: it.alongA,
    alongB: it.alongB,
    sides: it.sides,
  }));
}
/* 锚点收敛的趟数上限与线数上限（打分是 O(E²)，超限就只走第一趟） */
const REL_REFINE_MAX = 120;
/* 规划一个层级（scope）内所有关系线的几何：
   贴边锚点 → 汇聚侧按「对端真实来向」重新散开（只在交叉确实变少时接受，抖动/变差立刻回退）
   → 近似重合的直线彼此滑开 → 一条直线段 → 文字避让 */
function relPlanScope(items) {
  relPlanAnchors(items, false);
  /* 主：直线互相穿越的对数；次：同侧汇聚顺序颠倒的对数（打平时继续往下收敛） */
  const scoreOf = (list) => relGeomScore(list) * 1000 + relFanInversions(list);
  if (items.length > 1 && items.length <= REL_REFINE_MAX) {
    let snap = relAnchorSnapshot(items);
    let best = scoreOf(items);
    for (let pass = 0; pass < 2 && best > 0; pass++) {
      relPlanAnchors(items, true);
      const sc = scoreOf(items);
      if (sc >= best) {
        items.forEach((it, i) => Object.assign(it, snap[i]));
        break;
      }
      best = sc;
      snap = relAnchorSnapshot(items);
    }
  }
  relSeparateStraight(items);
  /* 线上文字：放在中点法线一侧，并与已放文字互相让开 */
  const txtRects = [];
  for (const it of items) {
    const g = relStraightPath(it.a, it.b);
    it.d = g.d;
    let mx = g.mid.x,
      my = g.mid.y;
    const txt = String(it.w.relLabel || "").trim();
    if (txt) {
      const lw = Math.max(28, txt.length * 11),
        lh = 15;
      let guard = 0;
      while (
        guard++ < 8 &&
        txtRects.some(
          (r) =>
            Math.abs(r.x - mx) < (r.w + lw) / 2 &&
            Math.abs(r.y - my) < (r.h + lh) / 2,
        )
      )
        my += lh + 3;
      txtRects.push({ x: mx, y: my, w: lw, h: lh });
    }
    it.mid = { x: mx, y: my };
  }
}
function collectRelWireScopes(filter) {
  const order = [];
  const byHost = new Map();
  for (const w of (S.wf && S.wf.wires) || []) {
    if (!w.rel) continue;
    const from = nodeById(w.from),
      to = nodeById(w.to);
    if (!from || !to) continue;
    if (!relWireInScope(from, to)) continue;
    if (filter && !filter.has(w.from) && !filter.has(w.to)) continue;
    const host = wireOpenSuperHost(w, from, to) || null;
    const key = host ? host.id : "@main";
    let sc = byHost.get(key);
    if (!sc) {
      sc = { host, items: [] };
      byHost.set(key, sc);
      order.push(sc);
    }
    sc.items.push({
      w,
      from,
      to,
      ra: relWireRect(from, host),
      rb: relWireRect(to, host),
    });
  }
  return order;
}
/* 箭头 marker：每个宿主 svg 一套（id 不重复），常态 / 选中 / 关联 / 淡出四色；
   markerUnits=userSpaceOnUse → 箭头大小不随线宽缩水 */
function relMarkerBaseId(host) {
  return host ? "relArrow-" + host.id : "relArrow";
}
function ensureRelMarkers(svg, host) {
  if (!svg) return "";
  const base = relMarkerBaseId(host);
  if (svg.querySelector(":scope > defs.rel-defs")) return base;
  const defs = document.createElementNS(svgNS, "defs");
  defs.setAttribute("class", "rel-defs");
  const mkOne = (id, cls) => {
    const mk = document.createElementNS(svgNS, "marker");
    mk.id = id;
    mk.setAttribute("viewBox", "0 0 10 10");
    mk.setAttribute("refX", "9.2");
    mk.setAttribute("refY", "5");
    mk.setAttribute("markerWidth", "12");
    mk.setAttribute("markerHeight", "12");
    mk.setAttribute("markerUnits", "userSpaceOnUse");
    mk.setAttribute("orient", "auto-start-reverse");
    const tri = document.createElementNS(svgNS, "path");
    tri.setAttribute("d", "M 0.4 0.5 L 9.6 5 L 0.4 9.5 L 2.4 5 z");
    tri.setAttribute("class", "rel-arrow-head " + cls);
    mk.appendChild(tri);
    defs.appendChild(mk);
  };
  mkOne(base, "");
  mkOne(base + "-hi", "hi");
  mkOne(base + "-lk", "lk");
  mkOne(base + "-dim", "dim");
  svg.insertBefore(defs, svg.firstChild);
  return base;
}
/* 箭头方向 → 两端 marker（state 决定配色：sel 橙 / linked 青 / dim 淡） */
function relArrowMarkerUrl(base, state) {
  const suf = state === "sel" ? "-hi" : state === "linked" ? "-lk" : state === "dim" ? "-dim" : "";
  return "url(#" + base + suf + ")";
}
function setRelArrowMarkers(p, w, base, state) {
  const url = relArrowMarkerUrl(base, state);
  const a = relArrowOf(w);
  if (a === "both" || a === "backward") p.setAttribute("marker-start", url);
  else p.removeAttribute("marker-start");
  if (a === "both" || a === "forward") p.setAttribute("marker-end", url);
  else p.removeAttribute("marker-end");
}
/* 当前选中的节点集合（单选 / 框选都算） */
function relSelNodeSet() {
  if (S.selSet && S.selSet.size) return S.selSet;
  if (S.sel) return new Set([S.sel]);
  return null;
}
/* 高亮上下文：选中节点 + 「这批关系线里有没有连着选中节点的」
   （没有就不淡出别的线，否则点一个孤立块会让整张架构图消失） */
function relHighlightInfo() {
  const set = relSelNodeSet();
  if (!set) return { set: null, any: false };
  let any = false;
  for (const w of (S.wf && S.wf.wires) || []) {
    if (!w.rel) continue;
    if (set.has(w.from) || set.has(w.to)) {
      any = true;
      break;
    }
  }
  return { set, any };
}
/* 一条关系线本帧的视觉状态：sel（点线本身）/ linked（点它连的节点）/ dim（别的线） */
function relWireVisualState(w, host, hi) {
  if (S.selWire === w.id) return "sel";
  const set = hi && hi.set;
  if (set && (set.has(w.from) || set.has(w.to) || (host && set.has(host.id))))
    return "linked";
  return hi && hi.any ? "dim" : "";
}
function relWireDom(w, host) {
  const pid = (host ? "rsw-" : "rw-") + w.id;
  return {
    core: document.getElementById(pid),
    ring: document.getElementById(pid + "-r"),
    lab: document.getElementById((host ? "rswl-" : "rwl-") + w.id),
  };
}
/* 只改状态类与箭头配色，不动几何（几何在 drawRelWire 里单独写） */
function applyRelWireState(p, ring, lab, w, base, host, hi) {
  const st = relWireVisualState(w, host, hi);
  const cls = "fn-edge rel" + (st ? " " + st : "");
  if (p.getAttribute("class") !== cls) p.setAttribute("class", cls);
  if (ring) {
    const rcls = "fn-edge-ring rel" + (st ? " " + st : "");
    if (ring.getAttribute("class") !== rcls) ring.setAttribute("class", rcls);
  }
  setRelArrowMarkers(p, w, base, st);
  if (lab) {
    const lcls = "wire-rel-label" + (st ? " " + st : "");
    if (lab.getAttribute("class") !== lcls) lab.setAttribute("class", lcls);
  }
  return st;
}
/* 选中变化后（没有重排几何的场合）把高亮立刻刷到已有的线上 */
function refreshRelWireStates() {
  const hi = relHighlightInfo();
  document.querySelectorAll("path.fn-edge.rel[data-wid]").forEach((p) => {
    const w = relWireById(p.dataset.wid);
    if (!w) return;
    const host = p.dataset.relhost ? nodeById(p.dataset.relhost) : null;
    const base = p.dataset.relmk || relMarkerBaseId(host);
    applyRelWireState(
      p,
      document.getElementById(p.id + "-r"),
      document.getElementById(
        p.id.replace(/^rsw-/, "rswl-").replace(/^rw-/, "rwl-"),
      ),
      w,
      base,
      host,
      hi,
    );
  });
}
function relScopeSvg(host) {
  if (!host) return $("#wfSvg");
  const el = document.querySelector('.wf-node[data-nid="' + host.id + '"]');
  const stage = el && el.querySelector(".super-stage");
  return ensureSuperWiresSvg(stage);
}
/* 画一条关系线（外圈 + 线芯 + 线上文字） */
function drawRelWire(svg, it, host, base, hi) {
  const w = it.w;
  const pid = (host ? "rsw-" : "rw-") + w.id;
  const lid = (host ? "rswl-" : "rwl-") + w.id;
  /* 另一层级的残留 DOM 清掉（线在壳层与主画布之间迁移） */
  const other = host ? "rw-" : "rsw-";
  const otherL = host ? "rwl-" : "rswl-";
  for (const suf of ["", "-r"]) {
    const st = document.getElementById(other + w.id + suf);
    if (st) st.remove();
  }
  const stL = document.getElementById(otherL + w.id);
  if (stL) stL.remove();
  let ring = document.getElementById(pid + "-r");
  if (!ring) {
    ring = document.createElementNS(svgNS, "path");
    ring.id = pid + "-r";
    ring.setAttribute("class", "fn-edge-ring rel");
    svg.appendChild(ring);
  }
  let p = document.getElementById(pid);
  if (!p) {
    p = document.createElementNS(svgNS, "path");
    p.id = pid;
    p.dataset.wid = w.id;
    p.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      clearSelection();
      S.selWire = w.id;
      renderCanvas();
    });
    p.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      editRelWireLabel(relWireById(w.id) || w);
    });
    p.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const live = relWireById(w.id);
      if (!live) return;
      clearSelection();
      S.selWire = w.id;
      renderCanvas();
      showRelWireMenu(ev.clientX, ev.clientY, live);
    });
    svg.appendChild(p);
  }
  p.dataset.relmk = base;
  p.dataset.relhost = host ? host.id : "";
  applyRelWireState(p, ring, document.getElementById(lid), w, base, host, hi);
  p.setAttribute("d", it.d);
  ring.setAttribute("d", it.d);
  let lab = document.getElementById(lid);
  if (!lab) {
    lab = document.createElementNS(svgNS, "text");
    lab.id = lid;
    lab.setAttribute("text-anchor", "middle");
    lab.setAttribute("dominant-baseline", "middle");
    lab.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      clearSelection();
      S.selWire = w.id;
      renderCanvas();
    });
    lab.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      editRelWireLabel(relWireById(w.id) || w);
    });
    svg.appendChild(lab);
    applyRelWireState(p, ring, lab, w, base, host, hi);
  }
  lab.setAttribute("x", it.mid.x);
  lab.setAttribute("y", it.mid.y);
  const txt = String(w.relLabel || "").trim();
  if (lab.textContent !== txt) lab.textContent = txt;
  lab.style.display = txt ? "" : "none";
}
/* 本帧所有关系线（updateWires 末尾调用；晚于壳层内部连线，避免被当残留删掉）。
   规划时始终看全量关系线（锚点扇形 / 叠线错开是层级整体的性质），
   filter 只决定哪些线重画几何 —— 拖节点时不会让没动的线锚点乱跳，
   但没重画的线仍会刷新高亮状态。 */
function renderRelWiresPass(filter) {
  const hi = relHighlightInfo();
  const scopes = collectRelWireScopes(null);
  for (const sc of scopes) {
    const svg = relScopeSvg(sc.host);
    if (!svg) continue;
    const base = ensureRelMarkers(svg, sc.host);
    relPlanScope(sc.items);
    for (const it of sc.items) {
      if (
        filter &&
        !filter.has(it.w.from) &&
        !filter.has(it.w.to) &&
        !(sc.host && filter.has(sc.host.id))
      ) {
        const dom = relWireDom(it.w, sc.host);
        if (dom.core)
          applyRelWireState(dom.core, dom.ring, dom.lab, it.w, base, sc.host, hi);
        continue;
      }
      drawRelWire(svg, it, sc.host, base, hi);
    }
  }
  if (!filter) cleanupStaleRelWires();
}
/* 清理已不存在的关系线 DOM（线芯 / 外圈 / 线上文字） */
function cleanupStaleRelWires() {
  const alive = new Set();
  for (const w of (S.wf && S.wf.wires) || []) if (w.rel) alive.add(w.id);
  document
    .querySelectorAll('[id^="rw-"], [id^="rwl-"], [id^="rsw-"], [id^="rswl-"]')
    .forEach((el) => {
      const id = el.id
        .replace(/^rswl-|^rwl-|^rsw-|^rw-/, "")
        .replace(/-r$/, "");
      if (!alive.has(id)) el.remove();
    });
}
/* 编辑线上文字 */
async function editRelWireLabel(w) {
  if (!w || !w.rel) return;
  const val = await promptDialog(
    I18n.t("关系线上的文字（如：调用 / 依赖 / 实现 / 包含）"),
    w.relLabel || "",
    { title: I18n.t("编辑线上文字") },
  );
  if (val == null) return;
  pushHistory();
  w.relLabel = String(val).trim();
  updateWires();
  scheduleSave(true);
}
function setRelArrow(w, mode) {
  if (!w || !w.rel || REL_ARROWS.indexOf(mode) < 0) return;
  pushHistory();
  w.relArrow = mode;
  updateWires();
  scheduleSave(true);
}
/* ============ 关系线创建（两步点击） ============ */
function startRelFromNode(node) {
  if (!node) return;
  S.pendingRel = node.id;
  const c = $("#canvas");
  if (c) c.classList.add("rel-pending");
  toast(
    I18n.t("关系线：点击目标节点完成连接 · Esc 取消"),
    "ok",
  );
}
function cancelPendingRel(silent) {
  if (!S.pendingRel) return;
  S.pendingRel = null;
  const c = $("#canvas");
  if (c) c.classList.remove("rel-pending");
  if (!silent) toast(I18n.t("已取消关系线"), "warn");
}
async function finishRelAtNode(node) {
  const fromId = S.pendingRel;
  S.pendingRel = null;
  const c = $("#canvas");
  if (c) c.classList.remove("rel-pending");
  if (!fromId || !node || node.id === fromId) return;
  const from = nodeById(fromId);
  if (!from) return;
  const err = relConnectError(fromId, node.id);
  if (err) {
    toast(err, "warn");
    return;
  }
  pushHistory();
  addRelWire(fromId, node.id, { relArrow: "both" });
  renderCanvas();
  scheduleSave(true);
  const w = (S.wf.wires || []).find(
    (x) => x.rel && x.from === fromId && x.to === node.id,
  );
  if (w) {
    const val = await promptDialog(
      I18n.t("关系线上的文字（可留空，之后双击线可编辑）"),
      "",
      { title: I18n.t("线上文字") },
    );
    if (val != null && String(val).trim()) {
      w.relLabel = String(val).trim();
      scheduleSave(true);
    }
  }
  renderCanvas();
}

/* ============ 执行节点（绑定可执行文件 · 一键启动） ============ */
function isExecuteNode(n) {
  return !!n && n.kind === "execute";
}
/* 用户可选图标目录（键名存 execIcon；auto = 默认启动器图标） */
const EXEC_ICON_CATALOG = [
  {
    key: "auto",
    label: "默认",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.4 5.5l4.5 2.5-4.5 2.5V5.5z" fill="currentColor"/></svg>',
  },
  {
    key: "rocket",
    label: "火箭",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2c2.2 1.2 3.3 3.1 3.4 5.5L12.2 11 8 9.4 3.8 11l.8-3.5C4.7 5.1 5.8 3.2 8 2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="6.2" r="1.1" fill="none" stroke="currentColor" stroke-width="1.15"/><path d="M5.4 11.2l-2.1 2.1M6.8 12.4l-1.4 1.4M10.6 11.2l2.1 2.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  },
  {
    key: "gear",
    label: "齿轮",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  },
  {
    key: "terminal",
    label: "终端",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="3" width="11.2" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M4.6 6.4l2.6 2.2-2.6 2.2M8.6 10.8h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    key: "play",
    label: "播放",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.2l6.5 4.8-6.5 4.8V3.2z" fill="currentColor"/></svg>',
  },
  {
    key: "bolt",
    label: "闪电",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.8 1.8L3.6 9h3.4l-.8 5.2 5.2-7.2H7.8l1-5.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  },
  {
    key: "wrench",
    label: "扳手",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.6 3.4a4 4 0 0 0-5.1 4.9L3 12.8a1.4 1.4 0 0 0 2 2l4.5-4.5a4 4 0 0 0 4.9-5.1l-2 2-1.9-.5-.5-1.9 2-2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  },
  {
    key: "folder",
    label: "文件夹",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 4.2h4l1.2 1.4h6.4v6.6a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V4.2z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>',
  },
  {
    key: "file",
    label: "文件",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 2.6h6l2.8 2.8v8a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1V2.6z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.4 2.8v2.7h2.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  },
  {
    key: "power",
    label: "电源",
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M4.6 4.4a5 5 0 1 0 6.8 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  },
];
/* 用户可选 body 颜色盘（键存 execColor 十六进制；空 = 默认） */
const EXEC_COLOR_CATALOG = [
  { key: "", label: "默认" },
  { key: "#1e5f4f", label: "青绿" },
  { key: "#24507a", label: "蓝" },
  { key: "#4a3a78", label: "紫" },
  { key: "#7a4a1e", label: "橙" },
  { key: "#6e2f3a", label: "红" },
  { key: "#6b3354", label: "粉" },
  { key: "#2e5a2e", label: "绿" },
  { key: "#5a4a2a", label: "棕" },
  { key: "#3a4049", label: "灰蓝" },
];
function execIconKeyOf(node) {
  const k = node && node.execIcon;
  return EXEC_ICON_CATALOG.some((x) => x.key === k) ? k : "auto";
}
function execIconSvg(key) {
  const it = EXEC_ICON_CATALOG.find((x) => x.key === key);
  return it ? it.svg : EXEC_ICON_CATALOG[0].svg;
}
function execColorOf(node) {
  const c = node && node.execColor;
  return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "";
}
/* 执行绑定文件：独立进程启动（win32 走 cmd /c start → 新控制台 + 新进程组，
   不随 MTNode 主程序退出而关闭）；旧版 preload 无 detached 通道时回退 shellOpenPath */
async function runExecuteNode(node) {
  if (!isExecuteNode(node)) return;
  const p = String(node.execPath || "").trim();
  if (!p) {
    toast(I18n.t("尚未绑定可执行文件：请先右键节点「绑定可执行文件」"), "warn");
    return;
  }
  let ex = false;
  try {
    ex = !!(await window.api.fileExists(p));
  } catch (_) {}
  if (!ex) {
    node.error = I18n.t("文件不存在：") + p;
    node.execStatus = node.error;
    node._armed = false;
    scheduleSave();
    renderCanvas();
    toast(node.error, "warn");
    return;
  }
  node.error = null;
  node.running = true;
  node._armed = false;
  node.execStatus = I18n.t("正在启动…");
  renderCanvas();
  let r = null;
  try {
    r = await (window.api.shellOpenPathDetached
      ? window.api.shellOpenPathDetached(p)
      : window.api.shellOpenPath(p));
  } catch (err) {
    r = { ok: false, error: (err && err.message) || String(err) };
  }
  node.running = false;
  node.ranAt = Date.now();
  if (r && r.ok) {
    node.execStatus = I18n.t("已启动：") + fileName(p);
    toast(I18n.t("已启动：") + fileName(p), "ok");
  } else {
    node.error = (r && r.error) || I18n.t("启动失败");
    node.execStatus = node.error;
    toast(I18n.t("启动失败：") + node.error, "warn");
  }
  scheduleSave();
  renderCanvas();
}
/* 绑定可执行文件（文件对话框，默认过滤 .exe/.bat/.cmd/.lnk 等） */
async function pickExecForNode(node) {
  if (!isExecuteNode(node)) return;
  const r = await window.api.fileOpenDialog({
    title: I18n.t("选择要绑定的可执行文件（.exe / .bat / .cmd / .lnk 或任意系统可打开的文件）"),
    filters: [
      { name: I18n.t("可执行文件"), extensions: ["exe", "bat", "cmd", "lnk", "com", "msi", "ps1", "jar"] },
      { name: I18n.t("全部文件"), extensions: ["*"] },
    ],
  });
  if (!r || !r.path) return;
  pushHistory();
  node.execPath = r.path;
  node.error = null;
  node.execStatus = "";
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已绑定：") + r.path, "ok");
}
/* 在开发功能块（超级节点）内部新建执行节点：启动器与所属模块放在一起 */
function addExecNodeInsideSuper(host) {
  if (!host || host.kind !== "super") return;
  let n = null;
  if (superIsOpenShell(host)) {
    const o = superInnerOrigin(host);
    const pan = superInnerPan(host);
    const hwp = nodeWorldPos(host);
    n = addNode("execute", hwp.x + o.ox + pan.x + 32, hwp.y + o.oy + pan.y + 32);
  } else {
    n = addNode("execute", host.x + 32, host.y + 32);
  }
  if (!n) return;
  if (n.parentSuperId !== host.id) {
    pushHistory();
    n.parentSuperId = host.id;
    n.parentTaskId = host.parentTaskId || "";
    n.x = 32;
    n.y = 32;
    renderCanvas();
    scheduleSave(true);
  }
  pickExecForNode(n);
}
/* 选择图标（网格对话框 · 立即应用） */
async function pickExecIconDialog(node) {
  if (!isExecuteNode(node)) return;
  const cur = execIconKeyOf(node);
  const res = await mtDialogForm({
    title: I18n.t("选择图标 · ") + (node.title || I18n.t("执行节点")),
    hint: I18n.t("点击图标立即应用到该执行节点（便于快速定位）"),
    actions: [{ id: "cancel", label: I18n.t("取消") }],
    custom: (c, select) => {
      c.className = "exec-icon-grid";
      for (const it of EXEC_ICON_CATALOG) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "exec-icon-item" + (it.key === cur ? " on" : "");
        b.title = I18n.t(it.label);
        b.innerHTML = it.svg;
        b.onclick = () => select(it.key);
        c.appendChild(b);
      }
    },
  });
  if (!res) return;
  pushHistory();
  node.execIcon = res.custom;
  scheduleSave();
  renderCanvas();
}
/* 选择 body 颜色（网格对话框 · 立即应用） */
async function pickExecColorDialog(node) {
  if (!isExecuteNode(node)) return;
  const cur = execColorOf(node);
  const res = await mtDialogForm({
    title: I18n.t("选择颜色 · ") + (node.title || I18n.t("执行节点")),
    hint: I18n.t("点击颜色立即应用到该执行节点的 body（便于快速定位）"),
    actions: [{ id: "cancel", label: I18n.t("取消") }],
    custom: (c, select) => {
      c.className = "exec-color-grid";
      for (const it of EXEC_COLOR_CATALOG) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "exec-color-item" + (it.key === cur ? " on" : "");
        b.title = I18n.t(it.label);
        b.style.background = it.key || "#33383f";
        b.onclick = () => select(it.key);
        c.appendChild(b);
      }
    },
  });
  if (!res) return;
  pushHistory();
  node.execColor = res.custom || "";
  scheduleSave();
  renderCanvas();
}

/* ============ 开发节点：元素类型（devKind）与细化 ============ */
const DEV_KINDS = ["module", "file", "class", "interface", "enum"];
const DEV_KIND_LABEL = {
  module: "模块",
  file: "文件",
  class: "类",
  interface: "接口",
  enum: "枚举",
};
function devKindOf(node) {
  if (!node || node.kind !== "super" || !node.dev) return "";
  return DEV_KINDS.indexOf(node.devKind) >= 0 ? node.devKind : "module";
}
function devStatusOf(node) {
  const s = node && node.devStatus;
  return s === "done" || s === "wip" ? s : "pending";
}
function devStatusText(s) {
  return s === "done"
    ? I18n.t("已完成")
    : s === "wip"
      ? I18n.t("进行中")
      : I18n.t("待开发");
}
/* 功能块内的下层元素（排除超级节点端子等内部桥接节点） */
function devChildrenOf(node) {
  if (!node || !S.wf) return [];
  return (S.wf.nodes || []).filter(
    (x) => nodeParentSuperId(x) === node.id && !isSuperIoNode(x),
  );
}
function devChildLabel(k) {
  const kk = devKindOf(k) || (k.kind === "super" && k.dev ? "module" : k.kind);
  const design = devNoteParts(k && k.note).design;
  return (
    (k.title || k.id) +
    "（" +
    (DEV_KIND_LABEL[kk] ? I18n.t(DEV_KIND_LABEL[kk]) : kk) +
    "）" +
    (design ? "：" + design : "")
  );
}
/* 本块子树内的全部下层开发块（带层级；排除端子等桥接节点与非开发节点） */
function devDescendantBlocksOf(node) {
  const isDevBlock = (x) => !!x && x.kind === "super" && !!x.dev;
  const out = [];
  const seen = new Set();
  const walk = (parent, level) => {
    if (!parent || seen.has(parent.id)) return;
    seen.add(parent.id);
    for (const k of devChildrenOf(parent)) {
      if (!isDevBlock(k)) continue;
      out.push({ node: k, level });
      walk(k, level + 1);
    }
  };
  walk(node, 1);
  return out;
}
/* 递归统计本块子树的「细化深度」现状：层数 / 叶子元素类型分布 / 尚未到文件级的块 */
function devDescendantStatsOf(node) {
  const isDevBlock = (x) => !!x && x.kind === "super" && !!x.dev;
  const blocks = devDescendantBlocksOf(node);
  const st = {
    levels: 0, // 本块之下的层数（1 = 只有一层子块）
    count: blocks.length, // 子树内开发块总数
    leafKinds: {}, // 叶子元素类型分布 { module: 3, file: 12, ... }
    shallow: [], // 叶子仍是模块：尚未细化到文件级
    fileLeaves: [], // 叶子已到文件级（可选继续拆类 / 接口 / 枚举）
  };
  for (const b of blocks) {
    if (b.level > st.levels) st.levels = b.level;
    if (devChildrenOf(b.node).some(isDevBlock)) continue; // 非叶子
    const kk = devKindOf(b.node) || "module";
    st.leafKinds[kk] = (st.leafKinds[kk] || 0) + 1;
    if (kk === "module") st.shallow.push(b.node);
    else if (kk === "file") st.fileLeaves.push(b.node);
  }
  return st;
}
/* 一句话深度现状：当前已 N 层 · M 个块未到文件级（示例）/ 已细化到文件级 */
function devDepthSummaryText(node) {
  const st = devDescendantStatsOf(node);
  if (!st.count) return I18n.t("当前 0 层（尚未展开下层元素）");
  if (!st.shallow.length)
    return I18n.t("当前已 {n} 层 · 已细化到文件级", { n: st.levels });
  const eg = st.shallow
    .slice(0, 3)
    .map((x) => x.title || x.id)
    .join("、");
  return (
    I18n.t("当前已 {n} 层 · {m} 个块未到文件级", {
      n: st.levels,
      m: st.shallow.length,
    }) + (eg ? I18n.t("（如 {eg}）", { eg }) : "")
  );
}
/* 细化「深度」档位：deep = 逐层下钻到无法再细（默认）· once = 只展开本层 */
const DEV_REFINE_DEPTHS = [
  {
    key: "deep",
    label: "深度细化到无法再细",
    desc: "默认：拆出的每个子块都继续判断能否再细，一路下钻到无法进一步细化为止（一般到文件级；文件还可拆类 / 接口 / 枚举），产物为多层开发节点树。",
  },
  {
    key: "once",
    label: "只展开本层",
    desc: "仅在本块内创建 1 层子元素，不下钻；之后可在各子块上分别点「细化」。",
  },
];
/* 无需 / 无法继续细化：类图元素本身最细；整棵子树叶子都已到文件 / 类级则视为「细化到底」 */
function devRefineBlockedReason(node) {
  const dk = devKindOf(node) || "module";
  if (dk === "class" || dk === "interface" || dk === "enum")
    return I18n.t(
      "类 / 接口 / 枚举已是架构的最细粒度元素，无需继续细化。",
    );
  const isDevBlock = (x) => !!x && x.kind === "super" && !!x.dev;
  const kids = devChildrenOf(node).filter(isDevBlock);
  const FINEST = ["class", "interface", "enum"];
  if (dk === "file") {
    if (
      kids.length &&
      kids.every((k) => FINEST.indexOf(devKindOf(k) || "module") >= 0)
    )
      return I18n.t("该文件已展开为类 / 接口 / 枚举，已细化到无法再细。");
    return "";
  }
  const st = devDescendantStatsOf(node);
  if (st.count && !st.shallow.length)
    return (
      I18n.t(
        "本功能块已细化到无法再细：子树 {n} 层，每片叶子都已到文件 / 类级（未到文件级的块为 0）。",
        { n: st.levels },
      ) +
      I18n.t(
        "若还想把某个文件继续拆成类 / 接口 / 枚举，请在该文件块上单独点「细化」。",
      )
    );
  return "";
}
/* 细化任务书：注入细化会话。细化按「深度」而非单层程度——先按深度判断可否下钻，
   再输出多层规划树、一次确认后自顶向下逐层创建，直到无法再细（一般文件级） */
function devRefinePrompt(node, scopeText, depth) {
  const kind = devKindOf(node) || "module";
  const deep = depth !== "once";
  const lines = [];
  lines.push(
    I18n.t("【细化任务】") +
      " " +
      (node.title || I18n.t("未命名")) +
      "（" + I18n.t(DEV_KIND_LABEL[kind] || "模块") + "）",
  );
  lines.push(
    I18n.t("本次细化深度：") +
      (deep
        ? I18n.t("深度细化（逐层下钻到无法再细，一般到文件级）")
        : I18n.t("只展开本层（1 层 · 不下钻）")),
  );
  lines.push(I18n.t("当前子树深度：") + devDepthSummaryText(node));
  const scope = String(scopeText || "").trim();
  if (scope) lines.push(I18n.t("用户指定的细化范围：") + scope);
  const kids = devChildrenOf(node);
  lines.push(
    I18n.t("现有子元素：") +
      (kids.length ? "" : I18n.t("（无）")),
  );
  for (const k of kids.slice(0, 40)) lines.push("  - " + devChildLabel(k));
  lines.push("");
  lines.push(
    I18n.t(
      "请按以下步骤细化（「细化」指的是**深度**：拆出的子块是否继续下钻，而不是本层展开多少个）：",
    ),
  );
  lines.push(
    deep
      ? I18n.t(
          "· 本次为深度细化：规划与创建都必须覆盖多层，一路下钻到无法进一步细化为止（一般 devKind=file；文件还可继续拆类 / 接口 / 枚举，拆不动就停），不得只规划一层就收工。",
        )
      : I18n.t(
          "· 本次为只展开本层：仅在本块内创建 1 层子块，不做下钻；每个子块各自还需不需要继续细化，请在梗概里说明，之后由用户到该子块上分别点「细化」。",
        ),
  );
  lines.push("");
  lines.push(
    I18n.t(
      "0. 先按深度判断该不该细化：本块是否还能继续下钻、已经下钻到哪一层（见上方「当前子树深度」）。若本元素已无下层结构、或项目根目录内找不到可对应的真实内容，请直接告诉用户「无需 / 无法继续细化」并说明原因（如已细化到无法再细、无对应真实代码），不要创建任何节点。",
    ),
  );
  lines.push(
    I18n.t(
      "1. 基于项目根目录内的真实代码/文件，规划本块之下的**整棵结构**：元素层级为 模块 → 文件 → 类 / 接口 / 枚举。深度细化时每一片叶子都要自问「还能不能再拆」：模块拆到真实文件、文件拆到类 / 接口 / 枚举，确实拆不动了才算到底；只展开本层时只需规划紧接下一层。",
    ),
  );
  lines.push(
    I18n.t(
      "2. 先输出**多层规划树**（缩进表示层级，同层按创建顺序排列）：每个拟建子块标注【名称 · 类型（模块 / 文件 / 类 / 接口 / 枚举）· 是否还需继续下钻（是 / 否 + 一句理由）· 【功能】拟稿（≤80字，面向非技术的说明）· 【实现】拟稿（≤120字，工程实现梗概）· 将用颜色】，供用户审阅；深度模式下叶子应全部落在文件 / 类级，若因证据不足中途停在某个模块块上，请在该节点标注「待续下钻」并在结尾说明。",
    ),
  );
  lines.push(
    I18n.t(
      "3. 一次确认覆盖整棵规划树：明确询问用户是否按这棵树创建（不是逐层反复追问）；在用户确认之前，禁止修改画布。",
    ),
  );
  lines.push(
    I18n.t(
      "4. 用户确认后，自顶向下**逐层创建**：每层各一次 mtnode_canvas_edit —— 该层子块的 kind=super、dev=true、devKind=module|file|class|interface|enum、parentSuperId 指向它的直接父块（第一层的父块 = 本节点，更深层的父块 = 上一层刚创建的块，可用同一批 create 里的 alias 引用），note 必须按两段式规范书写（【功能】非技术说明 + 【实现】工程梗概，与该子块拟稿一致，禁止只写一段）；每个新建的模块块都要顺手带上 devFiles（本模块的核心文件 · 最多 10 条 · 每项是相对项目根 devPath 的路径，如 renderer/app-devnode.js；文件 / 类 / 接口 / 枚举块可留空，最外层项目节点一律不填），别留给以后补。禁止把不同层级一次性平铺到同一层。",
    ),
  );
  lines.push(
    I18n.t(
      "5. 护栏：单层子块过多（约 >12 个）时分批创建，并在规划树里标出本批未建的部分；本次新建节点总数以约 60 个为上限，触顶或项目内证据不足时立即停下，报告已建到哪一层、还剩哪些分支未展开，并询问用户是否继续下钻（也可让用户在剩余分支的块上各自点「细化」）。",
    ),
  );
  lines.push(
    I18n.t(
      "6. 落定后回写各父块概述：本节点与本次新建的每个中间层块，都要在 note 第二段「【实现】工程梗概」末尾补一行「子块：A / B / C」（列直接子块名，保持两段式规范，别把整棵子树塞进去）；第一段【功能】仅在职责变化时调整。",
    ),
  );
  lines.push(
    I18n.t(
      "7. 结尾报告最终结果：本次新增到第几层、共多少块、叶子元素类型分布（如：新增 3 层 · 18 块，叶子 = 14 文件 + 4 类），以及还有哪些块标注了「待续下钻」。",
    ),
  );
  lines.push(
    I18n.t(
      "8. 元素类型与配色请保持准确：模块按功能色卡归类（core 核心运行时 #6db4ff · canvas 画布与交互 #45cfe6 · ai AI 与 Agent #c792ea · data 数据与存储 #4dd0c4 · media 媒体与本地后端 #ff8fa3 · plugin 插件与生态 #f0c14d · build 构建与诊断 #ff9d5c · test 测试与质量 #a8e05f；新建 module 块系统会自动套用，归类不对时再补丁纠正，禁止自创色值），文件 / 类 / 接口 / 枚举 不传 devColor（保留类型默认色 蓝 / 橙 / 紫 / 粉）。",
    ),
  );
  lines.push(
    I18n.t(
      "9. 元素之间的关系用关系线表达（connect 项加 rel:true，可带 relLabel 文字与 relArrow 箭头，关系线不传数据）；文件节点的标题用相对项目根的路径（如 renderer/app.js，便于「打开」按钮定位源码）。",
    ),
  );
  lines.push(
    I18n.t(
      "10. 若项目根目录存在 AGENTS.md（Agent 共识文件），先读并遵守：文件节点的路径与新建内容都要符合「目录约定」，不要触碰「不要修改」清单里的路径。",
    ),
  );
  lines.push(
    I18n.t(
      "11. 本会话按本任务书的步骤执行即可：不要调用 mtnode-dev-architect 技能（该技能仅用于在 MTNode 画布上从零构建开发节点架构，细化任务书已内置全部规则）。",
    ),
  );
  return lines.join("\n");
}
/* 「细化」：弹对话框确认 → 新会话运行细化任务（无需/无法细化时也在对话框内提示） */
async function refineDevNode(node) {
  if (!node || node.kind !== "super" || !node.dev) return;
  const dk = devKindOf(node) || "module";
  const blocked = devRefineBlockedReason(node);
  const p = devPathOf(node);
  const kids = devChildrenOf(node);
  let warn = blocked;
  if (!warn && !p)
    warn = I18n.t(
      "尚未设置项目根目录（devPath）：Agent 无法依据项目真实代码判断可展开的下层内容，建议先在顶层功能块上设置。",
    );
  const rows = [
    [I18n.t("元素类型"), I18n.t(DEV_KIND_LABEL[dk] || "模块")],
    [
      I18n.t("Agent 模型"),
      typeof devModelDialogText === "function"
        ? devModelDialogText(node)
        : I18n.t("自动（跟随默认）"),
    ],
    [I18n.t("项目根目录"), p || I18n.t("（未设置）")],
    [
      I18n.t("现有子元素"),
      kids.length ? String(kids.length) + I18n.t(" 个") : I18n.t("（无）"),
    ],
    [I18n.t("细化深度"), devDepthSummaryText(node)],
  ];
  /* 深度单选（默认「深度细化到无法再细」）：点选项只改闭包变量，不关闭对话框。
     选过的深度也随草稿留存，取消后再开不用重选 */
  const savedDepth = devDraftOf(node, "refineDepth");
  let depth =
    savedDepth &&
    (DEV_REFINE_DEPTHS || []).some((it) => it.key === savedDepth)
      ? savedDepth
      : "deep";
  const res = await mtDialogForm({
    title: I18n.t("细化") + " · " + (node.title || I18n.t("开发节点")),
    wide: true,
    rows,
    note: devNoteDialogField(node, I18n.t("当前概述")),
    list: kids.length
      ? { label: I18n.t("现有子元素"), items: kids.map(devChildLabel) }
      : null,
    msg: blocked
      ? I18n.t(
          "如果确实要在这里继续展开，请先通过节点右键菜单把「元素类型」改为文件 / 模块；或到具体的下层文件块上分别点「细化」。",
        )
      : I18n.t(
          "确认后将新建一个细化会话：Agent 依据项目真实代码分析本模块的下层元素，先给出内容梗概清单，经你确认后才在该功能块内补充内容。若分析后认为无需或无法继续细化，它会直接告知你原因。",
        ),
    warn,
    textarea: blocked
      ? null
      : devDraftTextareaOpts(node, "refine", {
          label: I18n.t("细化范围（可选）"),
          placeholder: I18n.t(
            "例如：只展开 renderer 目录下的文件；或仅细化某个子模块。留空 = 由 Agent 自行判断。",
          ),
          rows: 4,
        }),
    /* 边写边留存：取消 / 被别的事务顶出对话框都不丢，下次打开原样回填 */
    onText: (t) => devDraftSet(node, "refine", t),
    hint: blocked
      ? ""
      : I18n.t(
          "确认 = 新会话后台运行（工作区 = 项目根目录 · 标题「细化 · 模块名」· 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Esc 取消",
        ),
    custom: blocked
      ? null
      : (c) => {
          const lab = document.createElement("label");
          lab.className = "mt-form-lab";
          lab.textContent = I18n.t("细化深度（单选）");
          c.appendChild(lab);
          const listEl = document.createElement("div");
          listEl.className = "mt-sug-opts";
          const rowsEl = [];
          for (const it of DEV_REFINE_DEPTHS) {
            const row = document.createElement("label");
            row.className = "mt-sug-opt" + (it.key === depth ? " on" : "");
            const rb = document.createElement("input");
            rb.type = "radio";
            rb.name = "devRefineDepth";
            rb.checked = it.key === depth;
            const txt = document.createElement("div");
            txt.className = "mt-sug-txt";
            const tt = document.createElement("b");
            tt.className = "mt-sug-title";
            tt.textContent = I18n.t(it.label);
            txt.appendChild(tt);
            const dd = document.createElement("div");
            dd.className = "mt-sug-desc";
            dd.textContent = I18n.t(it.desc);
            txt.appendChild(dd);
            row.appendChild(rb);
            row.appendChild(txt);
            /* 点选项只改闭包变量 + 选中态，不调 select（不立即关闭对话框） */
            row.onclick = (ev) => {
              ev.preventDefault();
              depth = it.key;
              devDraftSet(node, "refineDepth", it.key);
              for (const r of rowsEl) {
                r.row.classList.toggle("on", r.key === depth);
                r.rb.checked = r.key === depth;
              }
            };
            rowsEl.push({ key: it.key, row, rb });
            listEl.appendChild(row);
          }
          c.appendChild(listEl);
        },
    actions: blocked
      ? [{ id: "cancel", label: I18n.t("知道了") }]
      : [
          { id: "cancel", label: I18n.t("取消") },
          { id: "none", label: I18n.t("无需细化") },
          { id: "go", label: I18n.t("确认细化"), primary: true },
        ],
  });
  if (!res) return;
  if (res.action === "none") {
    toast(I18n.t("已跳过细化：该功能块保持现状"), "ok");
    return;
  }
  if (res.action !== "go") return;
  /* 已确认开工：清掉本框草稿（范围文本 + 深度选择），下次打开重新填 */
  devDraftSet(node, "refine", "");
  devDraftSet(node, "refineDepth", "");
  const sess = createDevSessionForNode(node, "refine");
  if (!sess) return;
  /* 细化任务书并入会话契约 _devContract（发送时注入系统提示，不占用户消息位）：
     首条消息只保留用户关键输入（细化深度 + 细化范围；范围留空则只给深度说明） */
  const refineBrief = devRefinePrompt(node, res.text, depth);
  sess._devContract = String(sess._devContract || "") + "\n\n" + refineBrief;
  const scopeText = String(res.text || "").trim();
  const depthLine =
    depth === "once"
      ? I18n.t("只展开本层（1 层）细化该功能块")
      : I18n.t("深度细化该功能块：逐层下钻到无法再细（一般文件级）");
  const visibleText = scopeText
    ? depthLine + "\n" + I18n.t("用户指定的细化范围：") + scopeText
    : depthLine;
  const firstMsg = (sess.messages || [])[0];
  if (firstMsg && firstMsg._src === "dev-node") {
    firstMsg.content = visibleText;
  } else {
    sess.messages.unshift({ role: "user", content: visibleText, _src: "dev-node" });
  }
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  renderCanvas();
  /* 细化会话同样绑进该功能块：运行队列按「绑定会话」口径立刻重算一次 */
  updateRunQueuePanel();
  toast(
    I18n.t("已创建细化会话「") +
      (sess.title || "") +
      I18n.t("」并在后台运行（留在画布 · 左下角队列 / 会话列表可看进度）"),
    "ok",
  );
  try {
    await agentSessionSend("", { _devContract: true });
  } catch (err) {
    toast(I18n.t("细化会话启动失败：") + ((err && err.message) || String(err)), "err");
  }
}

/* 端子悬浮：立刻列出已连接节点名，可移入点击以镜头定位 */
let _portTipHideTimer = null;
function portLinkedNodes(node, dir, idx, portKind) {
  if (!node || !S.wf) return [];
  const seen = new Set();
  const out = [];
  const add = (n) => {
    if (!n || seen.has(n.id) || n.id === node.id) return;
    seen.add(n.id);
    out.push(n);
  };
  if (node.kind === "super") {
    const i = Number(idx || 0);
    if (portKind === "inner-bridge") {
      for (const w of superInternalBridgeWiresAll(node)) {
        if (Number(w.fromIndex || 0) === i) add(nodeById(w.to));
      }
    } else if (portKind === "inner-sink") {
      for (const w of superInternalOutFeedsAll(node)) {
        if (Number(w.toIndex) === i) add(nodeById(w.from));
      }
    } else if (dir === "in") {
      for (const w of superExternalInWiresAll(node)) {
        if (Number(w.toIndex) === i) add(nodeById(w.from));
      }
    } else {
      for (const w of superExternalOutWiresAll(node)) {
        if (Number(w.fromIndex || 0) === i) add(nodeById(w.to));
      }
    }
    return out;
  }
  if (dir === "in") {
    for (const w of S.wf.wires || []) {
      if (w.rel) continue;
      if (w.to === node.id && Number(w.toIndex) === Number(idx))
        add(nodeById(w.from));
    }
  } else {
    for (const w of S.wf.wires || []) {
      if (w.rel) continue;
      if (w.from === node.id && Number(w.fromIndex || 0) === Number(idx || 0))
        add(nodeById(w.to));
    }
  }
  return out;
}
function hidePortTip() {
  if (_portTipHideTimer) {
    clearTimeout(_portTipHideTimer);
    _portTipHideTimer = null;
  }
  const tip = $("#portTip");
  if (tip) {
    tip.hidden = true;
    tip.innerHTML = "";
  }
}
function scheduleHidePortTip() {
  if (_portTipHideTimer) clearTimeout(_portTipHideTimer);
  _portTipHideTimer = setTimeout(hidePortTip, 280);
}
function showPortTip(portEl, node, dir, idx, portKind) {
  if (_portTipHideTimer) {
    clearTimeout(_portTipHideTimer);
    _portTipHideTimer = null;
  }
  const peers = portLinkedNodes(node, dir, idx, portKind);
  const tip = $("#portTip");
  if (!tip || !portEl || !peers.length) {
    hidePortTip();
    return;
  }
  tip.innerHTML = "";
  tip.hidden = false;
  const head = document.createElement("div");
  head.className = "port-tip-head";
  head.textContent =
    dir === "in" ? I18n.t("来自") : I18n.t("连向");
  tip.appendChild(head);
  for (const n of peers) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "port-tip-item kind-" + nodeKindCls(n);
    const tag = document.createElement("span");
    tag.className = "port-tip-kind";
    tag.textContent = nodeKindLabel(n);
    const nm = document.createElement("span");
    nm.className = "port-tip-name";
    nm.textContent = n.title || I18n.t("（未命名）");
    b.appendChild(tag);
    b.appendChild(nm);
    b.title = I18n.t("点击定位到该节点");
    b.addEventListener("mousedown", (ev) => {
      /* 避免触发画布拖线 / 节点拖动 */
      ev.preventDefault();
      ev.stopPropagation();
    });
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hidePortTip();
      focusNode(n.id);
    };
    tip.appendChild(b);
  }
  tip.onmouseenter = () => {
    if (_portTipHideTimer) {
      clearTimeout(_portTipHideTimer);
      _portTipHideTimer = null;
    }
  };
  tip.onmouseleave = () => scheduleHidePortTip();
  const pr = portEl.getBoundingClientRect();
  tip.style.visibility = "hidden";
  tip.style.left = "0px";
  tip.style.top = "0px";
  const tw = tip.offsetWidth || 160;
  const th = tip.offsetHeight || 40;
  let left = dir === "out" ? pr.right + 4 : pr.left - tw - 4;
  let top = pr.top + pr.height / 2 - th / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
  tip.style.left = left + "px";
  tip.style.top = top + "px";
  tip.style.visibility = "visible";
}
function bindPortTip(portEl, node, dir, idx, portKind) {
  portEl.addEventListener("mouseenter", () => {
    if (S.drag && S.drag.mode === "wire") return;
    showPortTip(portEl, node, dir, idx, portKind);
  });
  portEl.addEventListener("mouseleave", () => scheduleHidePortTip());
}

/** 将客户区坐标映射到某元素的本地坐标（已计入祖先 transform / 缩放） */
function clientToLocal(el, cx, cy) {
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  const w = el.clientWidth || parseFloat(el.style.width) || 0;
  const h = el.clientHeight || parseFloat(el.style.height) || 0;
  const sx = w > 0 ? r.width / w : S.cam && S.cam.z > 0 ? S.cam.z : 1;
  const sy = h > 0 ? r.height / h : S.cam && S.cam.z > 0 ? S.cam.z : 1;
  return {
    x: (cx - r.left) / (sx > 0 && isFinite(sx) ? sx : 1),
    y: (cy - r.top) / (sy > 0 && isFinite(sy) ? sy : 1),
  };
}
function toStage(cx, cy) {
  const st = $("#stage");
  if (!st) return { x: 0, y: 0 };
  /* 直接用 #stage 屏幕矩形反推：含 canvas 边框/内边距与 translate+scale，
     避免旧公式 (canvasRect + cam) / 实测 zoom 与 S.cam 不一致导致拖线末端偏离鼠标 */
  return clientToLocal(st, cx, cy);
}
function applyTransform() {
  const st = $("#stage");
  if (!st) return;
  clampCam();
  st.style.transform = `translate(${S.cam.x}px, ${S.cam.y}px) scale(${S.cam.z})`;
  syncCanvasGrid();
}

/* 相机变换合并到下一帧，避免平移/缩放时 mousemove/wheel 触发多次强制布局 */
function applyTransformSoon() {
  if (S._camRaf) {
    S._camDirty = true;
    return;
  }
  S._camDirty = true;
  S._camRaf = requestAnimationFrame(() => {
    S._camRaf = 0;
    if (!S._camDirty) return;
    S._camDirty = false;
    applyTransform();
    /* 全屏进入态内侧端子钉在屏幕边缘，平移/缩放后需重算主 SVG 连线端点 */
    if (currentSuperFocus()) {
      refreshSuperFocusPortLayout();
      updateWires();
    }
    if (S._zoomStatusPending) {
      S._zoomStatusPending = false;
      renderStatus();
    }
  });
}

function setCanvasPanning(on) {
  const canvas = $("#canvas");
  if (canvas) canvas.classList.toggle("is-panning", !!on);
  const st = $("#stage");
  if (st) {
    if (on) st.style.willChange = "transform";
    else st.style.willChange = "";
  }
}

/* 一键居中：重新定位到当前画布可见内容中心 */
function fitCanvas() {
  const bounds = canvasWorldBounds();
  if (!bounds) return;
  const pad = 60;
  const minX = bounds.minX;
  const minY = bounds.minY;
  const maxX = bounds.maxX;
  const maxY = bounds.maxY;
  const vw = $("#canvas").clientWidth;
  const vh = $("#canvas").clientHeight;
  const z = Math.min(
    vw / (maxX - minX + pad * 2),
    vh / (maxY - minY + pad * 2),
    1.2,
  );
  S.cam.z = Math.max(CAM_Z_MIN, Math.min(CAM_Z_MAX, z));
  S.cam.x = (vw - (maxX - minX) * S.cam.z) / 2 - minX * S.cam.z;
  S.cam.y = (vh - (maxY - minY) * S.cam.z) / 2 - minY * S.cam.z;
  applyTransform();
  updateWires();
  renderStatus();
}

function canvasWorldBounds() {
  const nodes = visibleWfNodes();
  const marks = visibleMarks();
  const groups = (S.wf && S.wf.groups) || [];
  if (!nodes.length && !marks.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y, w, h) => {
    x = Number(x);
    y = Number(y);
    w = Number(w);
    h = Number(h);
    if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const n of nodes) {
    const p = nodeWorldPos(n);
    const sz = nodeDrawSize(n);
    include(p.x, p.y, sz.w, sz.h);
  }
  for (const m of marks) {
    const b = markBounds(m);
    if (!b) continue;
    include(b.x, b.y, b.w, b.h);
  }
  for (const g of groups) {
    if (!groupVisibleInScope(g)) continue;
    const b = groupBounds(g);
    if (!b) continue;
    include(b.x - GROUP_PAD, b.y - GROUP_PAD, b.w + GROUP_PAD * 2, b.h + GROUP_PAD * 2);
  }
  if (!isFinite(minX) || !isFinite(minY)) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** 限制相机平移：视野不得离当前可见内容过远，避免在空白区迷失 */
function clampCam() {
  const bounds = canvasWorldBounds();
  if (!bounds || !S.cam) return;
  const canvas = $("#canvas");
  if (!canvas) return;
  const vw = canvas.clientWidth || 800;
  const vh = canvas.clientHeight || 600;
  const z = S.cam.z > 0 && isFinite(S.cam.z) ? S.cam.z : 1;
  const pad = CAM_PAN_PAD;
  const { minX, minY, maxX, maxY } = bounds;
  const minCamX = vw - pad - maxX * z;
  const maxCamX = pad - minX * z;
  const minCamY = vh - pad - maxY * z;
  const maxCamY = pad - minY * z;
  S.cam.x =
    minCamX <= maxCamX
      ? Math.max(minCamX, Math.min(maxCamX, S.cam.x))
      : (minCamX + maxCamX) / 2;
  S.cam.y =
    minCamY <= maxCamY
      ? Math.max(minCamY, Math.min(maxCamY, S.cam.y))
      : (minCamY + maxCamY) / 2;
}

function waitCanvasPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(resolve, 24));
    });
  });
}

function flushCamTransform() {
  if (S._camRaf) {
    cancelAnimationFrame(S._camRaf);
    S._camRaf = 0;
  }
  S._camDirty = false;
  applyTransform();
}

function loadDataUrlImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(I18n.t("生成总览图失败：") + "image"));
    img.src = dataUrl;
  });
}

function safeOverviewName() {
  const raw = String((S.wf && S.wf.name) || "canvas");
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "canvas";
  return cleaned.slice(0, 60) + "-overview.png";
}

async function captureCanvasTile(cssX, cssY, cssW, cssH) {
  const r = await window.api.captureRect({
    x: cssX,
    y: cssY,
    width: cssW,
    height: cssH,
  });
  if (!r || r.ok === false || !r.dataUrl) {
    throw new Error((r && r.error) || I18n.t("未知错误"));
  }
  return loadDataUrlImage(r.dataUrl);
}

async function exportCanvasOverviewPng() {
  if (S.view === "agent") {
    toast(I18n.t("请先切换到画布"), "warn");
    return;
  }
  if (!S.wf) {
    toast(I18n.t("当前没有打开的画布"), "err");
    return;
  }
  const bounds = canvasWorldBounds();
  if (!bounds) {
    toast(I18n.t("当前没有可导出的画布内容"), "warn");
    return;
  }
  const ok = await confirmDialog(
    I18n.t("将导出当前画布全部节点、连线与标注的高清总览图。生成时画面会短暂移动，完成后恢复你的视角。是否继续？"),
    { title: I18n.t("生成高清总览图") },
  );
  if (!ok) return;

  const btn = $("#btnCanvasShot");
  if (btn) btn.disabled = true;
  const canvasEl = $("#canvas");
  const rq = $("#runQueue");
  const rqWasHidden = !rq || rq.hidden;
  const savedCam = { x: S.cam.x, y: S.cam.y, z: S.cam.z };
  const stEl = $("#saveState");
  let veil = null;
  S._capturingCanvas = true;
  try {
    if (rq) rq.hidden = true;
    if (canvasEl) canvasEl.classList.add("is-snapshot");
    const tip = $("#portTip");
    if (tip) tip.hidden = true;
    const ctxMenu = $("#ctx");
    if (ctxMenu) ctxMenu.style.display = "none";
    veil = document.createElement("div");
    veil.style.cssText =
      "position:fixed;inset:0;z-index:5000;background:transparent;cursor:wait";
    document.body.appendChild(veil);

    const pad = 72;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const MAX_PX = 16384;
    let scale = Math.min(CAM_Z_MAX, 1.7);
    const worldW = Math.max(1, bounds.w + pad * 2);
    const worldH = Math.max(1, bounds.h + pad * 2);
    if (worldW * scale * dpr > MAX_PX) scale = MAX_PX / (worldW * dpr);
    if (worldH * scale * dpr > MAX_PX) scale = MAX_PX / (worldH * dpr);
    scale = Math.max(CAM_Z_MIN, scale);

    const outW = Math.max(1, Math.ceil(worldW * scale));
    const outH = Math.max(1, Math.ceil(worldH * scale));
    const view = canvasEl.getBoundingClientRect();
    const vw = Math.max(64, Math.floor(view.width));
    const vh = Math.max(64, Math.floor(view.height));
    const tilesX = Math.ceil(outW / vw);
    const tilesY = Math.ceil(outH / vh);
    const total = tilesX * tilesY;
    const originX = -(bounds.minX - pad) * scale;
    const originY = -(bounds.minY - pad) * scale;

    flushCamTransform();
    S.cam.z = scale;
    S.cam.x = originX;
    S.cam.y = originY;
    applyTransform();
    await waitCanvasPaint();

    const firstTw = Math.min(vw, outW);
    const firstTh = Math.min(vh, outH);
    const firstImg = await captureCanvasTile(view.left, view.top, firstTw, firstTh);
    const tileDprX = firstImg.width / firstTw;
    const tileDprY = firstImg.height / firstTh;
    const pixW = Math.round(outW * tileDprX);
    const pixH = Math.round(outH * tileDprY);
    const out = document.createElement("canvas");
    out.width = pixW;
    out.height = pixH;
    const g = out.getContext("2d");
    if (!g) throw new Error(I18n.t("未知错误"));
    g.fillStyle = "#0a0e13";
    g.fillRect(0, 0, pixW, pixH);
    g.drawImage(firstImg, 0, 0);

    let done = 1;
    if (stEl) {
      stEl.textContent = I18n.t("正在生成高清总览图 {cur}/{total}…", {
        cur: done,
        total: total,
      });
      stEl.className = "warn";
    }

    for (let ty = 0; ty < outH; ty += vh) {
      for (let tx = 0; tx < outW; tx += vw) {
        if (tx === 0 && ty === 0) continue;
        const tw = Math.min(vw, outW - tx);
        const th = Math.min(vh, outH - ty);
        S.cam.z = scale;
        S.cam.x = originX - tx;
        S.cam.y = originY - ty;
        applyTransform();
        await waitCanvasPaint();
        const img = await captureCanvasTile(view.left, view.top, tw, th);
        g.drawImage(
          img,
          Math.round(tx * tileDprX),
          Math.round(ty * tileDprY),
        );
        done += 1;
        if (stEl) {
          stEl.textContent = I18n.t("正在生成高清总览图 {cur}/{total}…", {
            cur: done,
            total: total,
          });
        }
      }
    }

    const blob = await new Promise((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png");
    });

    S.cam.x = savedCam.x;
    S.cam.y = savedCam.y;
    S.cam.z = savedCam.z;
    applyTransform();
    if (canvasEl) canvasEl.classList.remove("is-snapshot");
    if (rq && !rqWasHidden) rq.hidden = false;
    if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    veil = null;
    S._capturingCanvas = false;

    const dest = await window.api.fileSaveDialog({
      title: I18n.t("生成高清总览图"),
      defaultName: safeOverviewName(),
      filters: [{ name: I18n.t("PNG 图像"), extensions: ["png"] }],
    });
    if (!dest || !dest.path) {
      toast(I18n.t("已取消"), "warn");
      return;
    }
    const buf = await blob.arrayBuffer();
    const wr = await window.api.fileWriteBytes(dest.path, new Uint8Array(buf));
    if (wr && wr.ok === false) throw new Error(wr.error || I18n.t("保存失败"));
    toast(I18n.t("已保存总览图：") + dest.path, "ok");
    try {
      await window.api.shellShowItem(dest.path);
    } catch (_) {}
  } catch (e) {
    toast(I18n.t("生成总览图失败：") + ((e && e.message) || String(e)), "err");
  } finally {
    S.cam.x = savedCam.x;
    S.cam.y = savedCam.y;
    S.cam.z = savedCam.z;
    applyTransform();
    if (canvasEl) canvasEl.classList.remove("is-snapshot");
    if (rq && !rqWasHidden) rq.hidden = false;
    if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    S._capturingCanvas = false;
    if (btn) btn.disabled = false;
    renderStatus();
  }
}

function fitNodes(nodes) {
  if (!nodes || !nodes.length) {
    fitCanvas();
    return;
  }
  const pad = 80;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const canvas = $("#canvas");
  if (!canvas) return;
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  if (!(vw > 0 && vh > 0)) return;
  const z = Math.min(
    vw / Math.max(1, maxX - minX + pad * 2),
    vh / Math.max(1, maxY - minY + pad * 2),
    1.15,
  );
  S.cam.z = Math.max(CAM_Z_MIN, Math.min(CAM_Z_MAX, z));
  S.cam.x = (vw - (maxX - minX) * S.cam.z) / 2 - minX * S.cam.z;
  S.cam.y = (vh - (maxY - minY) * S.cam.z) / 2 - minY * S.cam.z;
  applyTransform();
  updateWires();
  renderStatus();
}

/* ============ 批量模式 / 输入继承 ============ */

/* 输入节点是否已有连线（内容将变为只读并继承输入） */
function inputInherited(n) {
  return (
    !!n &&
    (n.kind === "input_text" || n.kind === "input_image") &&
    wiresTo(n.id).length > 0
  );
}
function firstSource(n) {
  const w = wiresTo(n.id)[0];
  return w ? nodeById(w.from) : null;
}

/* 合并节点：每个输入 = 批次中的一项（含批量源的展开） */
function mergeItems(node) {
  const out = [];
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    const portIdx = superPortIdxFromWire(src, w);
    for (const it of allTextItems(src, node, portIdx))
      out.push({
        kind: "text",
        title: it.title,
        value: { kind: "text", text: it.text },
      });
    for (const it of allImageItems(src, node, portIdx))
      out.push({
        kind: "image",
        title: it.title,
        value: { kind: "image", path: it.path },
      });
  }
  return out;
}

/* 拆分节点：批次中选中项的实时副本（单输入单输出；输入不存在该项 → 空） */
function splitItems(node) {
  const out = [];
  const w = wiresTo(node.id)[0] || null;
  const src = w ? nodeById(w.from) : null;
  if (!src) return out;
  const portIdx = superPortIdxFromWire(src, w);
  for (const it of allTextItems(src, node, portIdx))
    out.push({ title: it.title, value: { kind: "text", text: it.text } });
  for (const it of allImageItems(src, node, portIdx))
    out.push({ title: it.title, value: { kind: "image", path: it.path } });
  return out;
}
function splitSelected(node) {
  if (node.splitItemTitle == null) return null;
  return splitItems(node).find((i) => i.title === node.splitItemTitle) || null;
}

function isBatchInput(n) {
  if (!n || (n.kind !== "input_text" && n.kind !== "input_image")) return false;
  if (n.ro) return false;
  if (inputInherited(n)) {
    const src = firstSource(n);
    if (!src) return false;
    /* 继承自超级节点：只看其外侧输入是否批量，避免经内侧汇入再 isBatch(super) 死循环 */
    if (isSuperLikeNode(src)) {
      const link = inboundWire(n);
      const slot = Number((link && link.fromIndex) || 0);
      const ext = superExternalInWires(src).find(
        (x) => Number(x.toIndex) === slot,
      );
      const up = ext ? nodeById(ext.from) : null;
      return !!(up && isBatch(up));
    }
    if (n.kind === "input_text") {
      const v = inheritedValue(n, 0);
      if (
        !n.yamlOff &&
        v &&
        v.kind === "text" &&
        parseSimpleYaml(v.text).length
      )
        return true; // 继承文本符合 YAML → 批量（可被 yamlOff 关闭）
    }
    return isBatch(src);
  }
  return !!n.batch;
}

function batchMemo(id, seen) {
  if (seen[id]) return false;
  seen[id] = true;
  const n = nodeById(id);
  if (!n) return false;
  if (isSuperLikeNode(n)) {
    /* 仅沿外侧输入传播；内侧汇入可能继承本超级节点，会与 isBatchInput 互相递归 */
    for (const w of superExternalInWires(n)) {
      const src = nodeById(w.from);
      if (!src || isControlKind(src)) continue;
      if (isBatchInput(src)) return true;
      if (src.kind === "merge" && wiresTo(src.id).length) return true;
      if (batchMemo(src.id, seen)) return true;
    }
    return false;
  }
  for (const w of S.wf.wires) {
    if (w.rel) continue;
    if (w.to !== id) continue;
    const src = nodeById(w.from);
    if (!src || isControlKind(src)) continue;
    if (isBatchInput(src)) return true;
    if (src.kind === "merge" && wiresTo(src.id).length) return true; // 合并节点输出恒为批次
    if (src.kind === "split") continue; // 拆分节点输出为单个项 → 下游不再批量
    if (
      (src.kind === "proc_text" ||
        src.kind === "proc_image" ||
        src.kind === "agent_task") &&
      src.batchMode === "agg"
    )
      continue; // 聚合模式输出为单个 → 下游不再批量
    if (isSuperLikeNode(src)) {
      if (batchMemo(src.id, seen)) return true;
      continue;
    }
    if (batchMemo(src.id, seen)) return true;
  }
  return false;
}
function isBatch(node) {
  if (!node) return false;
  if (node.kind === "input_text" || node.kind === "input_image")
    return isBatchInput(node);
  if (node.kind === "merge") return wiresTo(node.id).length > 0;
  if (node.kind === "super") return batchMemo(node.id, {});
  return batchMemo(node.id, {});
}

function originBatchInput(node, seen) {
  seen = seen || {};
  if (seen[node.id]) return null;
  seen[node.id] = 1;
  if (node.kind === "merge") return node;
  for (const w of wiresTo(node.id)) {
    const src = nodeById(w.from);
    if (!src) continue;
    if (src.kind === "input_text" || src.kind === "input_image") {
      if (src.batch && (src.entries || []).length) return src; // 自有批量
      if (src.kind === "input_text" && inputInherited(src) && !src.yamlOff) {
        const v = inheritedValue(src, 0);
        if (v && v.kind === "text" && parseSimpleYaml(v.text).length)
          return src; // YAML 继承批量
      }
      continue; // 普通继承的输入节点 → 继续向上找真正的批量源
    }
    if (isBatch(src)) {
      const o = originBatchInput(src, seen);
      if (o) return o;
    }
  }
  return null;
}

function dedupeTitles(titles) {
  const seen = {},
    out = [];
  for (const t of titles) {
    let k = t,
      n = 1;
    while (seen[k]) {
      n++;
      k = t + " (" + n + ")";
    }
    seen[k] = 1;
    out.push(k);
  }
  return out;
}
function batchTitles(node) {
  if (!isBatch(node)) return null;
  if (node.kind === "merge") {
    const es = mergeItems(node);
    if (!es.length) return [I18n.t("条目")];
    /* 空标题也占位，避免与 mergeItems 下标错位导致后缀丢失/错配；图像回退文件名 */
    return dedupeTitles(es.map((i, idx) => entryDisplayTitle(i, idx)));
  }
  let o = originBatchInput(node);
  if (!o && (node.kind === "input_text" || node.kind === "input_image")) {
    // 节点自身就是批量源（自有批量 或 YAML 继承）
    if (node.batch && (node.entries || []).length) o = node;
    else if (node.kind === "input_text" && inputInherited(node)) {
      const v = inheritedValue(node, 0);
      if (v && v.kind === "text" && parseSimpleYaml(v.text).length) o = node;
    }
  }
  if (!o) return [I18n.t("条目")];
  let es = null;
  if (o.kind === "merge") {
    es = mergeItems(o);
  } else if (o.kind === "input_text" && inputInherited(o)) {
    const v = inheritedValue(o, 0);
    es = v && v.kind === "text" ? parseSimpleYaml(v.text) : [];
  } else if (o.kind === "input_image") {
    /* 与 valueForInput / itemTitleOf 一致：只计有 path 的条目，避免下标错位 */
    es = (o.entries || []).filter((e) => e && e.path);
  } else {
    es = o.entries || [];
  }
  if (!es.length) return [o.title || I18n.t("条目")];
  /* 勿丢弃空标题占位；图像空标题回退文件名，保证文本/图像批次输出能看到文件名 */
  return dedupeTitles(es.map((e, idx) => entryDisplayTitle(e, idx)));
}

function clearDownstream(startId) {
  const seen = new Set([startId]);
  const q = [startId];
  const invalidate = (n) => {
    if (n.kind === "proc_text" || n.kind === "proc_image" || n.kind === "agent_task") {
      n.output = null;
      n.batchOutputs = null;
      n.error = null;
      n.ranAt = 0;
      n.attemptOutputs = null;
      n.attemptsDone = 0;
    }
    if (n.kind === "wait_file") {
      n.output = null;
      n.error = null;
      n.ranAt = 0;
      n.waitStatus = "";
      n.waitReady = false;
    }
    if (n.kind === "task") {
      n.output = null;
      n.error = null;
      n.ranAt = 0;
      n.taskStatus = "pending";
    }
    if (S.thinking && S.thinking[n.id]) S.thinking[n.id] = [];
    if (isSaveNode(n)) {
      /* 上游失效：清除「已保存」状态，避免预览继续显示旧文件 */
      n.savedPaths = [];
      n.savedPath = "";
      n.savedAt = 0;
    }
  };
  const fanoutGlobal = (g) => {
    if (!g || g.kind !== "global") return;
    for (const n of (S.wf && S.wf.nodes) || []) {
      if (!usesGlobalRefs(n) || seen.has(n.id) || isControlKind(n)) continue;
      seen.add(n.id);
      q.push(n.id);
      invalidate(n);
    }
  };
  fanoutGlobal(nodeById(startId));
  while (q.length) {
    const id = q.shift();
    if (isControlKind(nodeById(id))) continue;
    for (const w of S.wf.wires) {
      if (w.rel) continue;
      if (w.from !== id) continue;
      const n = nodeById(w.to);
      if (!n || seen.has(n.id) || isControlKind(n)) continue;
      seen.add(n.id);
      q.push(n.id);
      invalidate(n);
      fanoutGlobal(n);
    }
  }
}

/* ── 批次拆分：批次源 → N 个单一节点，下游级联拆分；聚合节点扇入连接 ── */

function isAggFanInNode(n) {
  if (!n) return false;
  if (
    n.kind !== "proc_text" &&
    n.kind !== "proc_image" &&
    n.kind !== "agent_task" &&
    !isSaveNode(n)
  )
    return false;
  return n.batchMode === "agg";
}

/* 可拆成单一节点的批次条目（优先自有 entries / YAML） */
function explodeBatchEntriesOf(node) {
  if (!node) return [];
  if (node.kind === "input_text") {
    if (node.batch && (node.entries || []).length)
      return (node.entries || []).map((e, idx) => ({
        title: entryDisplayTitle(e, idx),
        kind: "text",
        text: (e && e.content) || "",
      }));
    if (inputInherited(node) && !node.yamlOff) {
      const v = inheritedValue(node, 0);
      if (v && v.kind === "text") {
        const es = parseSimpleYaml(v.text);
        if (es.length >= 2)
          return es.map((e, idx) => ({
            title: entryDisplayTitle(e, idx),
            kind: "text",
            text: (e && e.content) || "",
          }));
      }
    }
    return [];
  }
  if (node.kind === "input_image") {
    if (node.batch && (node.entries || []).length) {
      return (node.entries || [])
        .filter((e) => e && e.path)
        .map((e, idx) => ({
          title: entryDisplayTitle(e, idx),
          kind: "image",
          path: e.path,
          sourceName: e.sourceName || "",
        }));
    }
    const imgs = allImageItems(node);
    if (imgs.length >= 2)
      return imgs.map((it) => ({
        title: it.title,
        kind: "image",
        path: it.path,
        sourceName: "",
      }));
    return [];
  }
  return [];
}

function canExplodeBatch(node) {
  return explodeBatchEntriesOf(node).length >= 2;
}

function collectDataDownstreamIds(startId) {
  const seen = new Set([startId]);
  const order = [];
  const q = [startId];
  while (q.length) {
    const id = q.shift();
    for (const w of S.wf.wires) {
      if (w.rel) continue;
      if (w.from !== id) continue;
      const n = nodeById(w.to);
      if (!n || seen.has(n.id) || isControlKind(n)) continue;
      seen.add(n.id);
      order.push(n.id);
      if (isAggFanInNode(n)) continue; /* 聚合节点扇入终点，不再向下级联拆分 */
      q.push(n.id);
    }
  }
  return order;
}

function clearNodeRunState(cp) {
  cp.output = null;
  cp.batchOutputs = null;
  cp.error = null;
  cp.ranAt = 0;
  cp.attemptOutputs = null;
  cp.attemptIdx = 0;
  cp.attemptsDone = 0;
  cp.running = false;
  cp.agentSessionId = "";
  if (isSaveNode(cp)) {
    cp.savedPaths = [];
    cp.savedPath = "";
    cp.savedAt = 0;
  }
  if (cp.kind === "wait_file") {
    cp.waitStatus = "";
    cp.waitReady = false;
  }
  if (cp.kind === "timer") {
    cp.timerArmed = false;
    cp.timerStatus = "";
    cp.timerNextAt = 0;
  }
  if (cp.kind === "delayer") {
    cp.delayStatus = "";
  }
  if (cp.kind === "sequencer") {
    cp.seqStatus = "";
  }
  if (cp.kind === "gate") {
    cp.gateStatus = "";
    cp.gateArrived = {};
  }
  if (cp.kind === "splitter") {
    cp.splitStatus = "";
  }
  if (cp.kind === "counter") {
    cp.counterStatus = "";
    cp.counterCount = 0;
  }
  if (cp.kind === "mutex") {
    cp.mutexStatus = "";
  }
}

function materializeSingleFromBatchEntry(root, entry, x, y) {
  const title = uniqueNodeTitle(entry.title || root.title || I18n.t("条目"));
  if (root.kind === "input_image" || entry.kind === "image") {
    const n = makeNode("input_image", x, y);
    n.w = root.w || n.w;
    n.h = root.h || n.h;
    n.batch = false;
    n.entries = [];
    n.imageAsset = entry.path || "";
    n.sourceName = entry.sourceName || "";
    n.title = title;
    n.ro = false;
    return n;
  }
  const n = makeNode("input_text", x, y);
  n.w = root.w || n.w;
  n.h = root.h || n.h;
  n.batch = false;
  n.entries = [];
  n.text = entry.text || "";
  n.yamlOff = false;
  n.title = title;
  n.ro = false;
  return n;
}

function cloneDownstreamForExplode(src, entryTitle, x, y) {
  const cp = JSON.parse(JSON.stringify(src));
  cp.id = uid("n");
  cp.x = snap(x);
  cp.y = snap(y);
  clearNodeRunState(cp);
  const suffix = String(entryTitle || "").trim();
  cp.title = uniqueNodeTitle(
    suffix ? src.title + " · " + suffix : src.title + I18n.t(" 副本"),
  );
  /* 拆分后每条链为单一输入，不再以批次模式运行 */
  if (cp.batchMode === "batch") cp.batchMode = "batch";
  if (cp.kind === "input_text" || cp.kind === "input_image") {
    cp.batch = false;
    cp.entries = [];
  }
  /* 批量保存曾用 {路径}_{条目标题}；拆成单链后把该后缀写进 savePath，与拆解前落盘名一致 */
  if (
    (isSaveNode(cp)) &&
    suffix &&
    String(src.savePath || "").trim()
  ) {
    const fb = saveExtForMedia(saveMediaKind(cp));
    cp.savePath = batchOutPath(String(src.savePath).trim(), suffix, fb);
  }
  return cp;
}

async function explodeBatchNode(root) {
  if (!S.wf || !root) return;
  const entries = explodeBatchEntriesOf(root);
  const N = entries.length;
  if (N < 2) {
    toast(I18n.t("该节点不是可拆分的批次（至少 2 条）"), "warn");
    return;
  }
  /* 与批量保存 batchTitles / batchOutPath 同一套去重后缀，保证文件名一致 */
  const fileTitles = dedupeTitles(
    entries.map(
      (e, idx) => String((e && e.title) || "").trim() || "item" + (idx + 1),
    ),
  );
  const downIds = collectDataDownstreamIds(root.id);
  const fanInCount = downIds.filter((id) => isAggFanInNode(nodeById(id))).length;
  const explodeCount = downIds.filter((id) => {
    const n = nodeById(id);
    return n && !isAggFanInNode(n) && n.kind !== "split";
  }).length;
  if (
    !(await confirmDialog(
      I18n.t("将批次拆分为 ") +
        N +
        I18n.t(" 个单一节点") +
        (explodeCount
          ? I18n.t("，并级联拆分下游 ") + explodeCount + I18n.t(" 个节点")
          : "") +
        (fanInCount
          ? I18n.t("；") + fanInCount + I18n.t(" 个聚合节点将接入全部新节点")
          : "") +
        I18n.t("。原批次节点会被移除。是否继续？"),
      { title: I18n.t("拆分批次"), danger: true },
    ))
  )
    return;

  pushHistory();
  const g = grid();
  const fanInIds = new Set(
    downIds.filter((id) => isAggFanInNode(nodeById(id))),
  );
  const skipIds = new Set(
    downIds.filter((id) => {
      const n = nodeById(id);
      return n && n.kind === "split";
    }),
  );
  const explodeIds = downIds.filter(
    (id) => !fanInIds.has(id) && !skipIds.has(id),
  );

  /* oldId → [newId × N]；聚合节点不进 map */
  const map = Object.create(null);
  map[root.id] = [];

  for (let i = 0; i < N; i++) {
    const y = snap(root.y + i * ((root.h || 120) + g * 2));
    const single = materializeSingleFromBatchEntry(
      root,
      entries[i],
      root.x,
      y,
    );
    S.wf.nodes.push(single);
    map[root.id].push(single.id);
  }

  for (const oldId of explodeIds) {
    const old = nodeById(oldId);
    if (!old) continue;
    map[oldId] = [];
    for (let i = 0; i < N; i++) {
      const y = snap(old.y + i * ((old.h || 120) + g * 2));
      const cp = cloneDownstreamForExplode(old, fileTitles[i], old.x, y);
      S.wf.nodes.push(cp);
      map[oldId].push(cp.id);
    }
  }

  const pending = []; /* {from, to, toIndex?} */
  const pushPending = (from, to, toIndex) => {
    if (!from || !to || from === to) return;
    pending.push({ from, to, toIndex: toIndex == null ? null : toIndex });
  };

  for (const w of S.wf.wires.slice()) {
    if (w.rel) continue; /* 关系线不参与批次拆分级联 */
    const fromId = w.from;
    const toId = w.to;
    if (skipIds.has(fromId) || skipIds.has(toId)) continue;

    const fromArr = map[fromId];
    const toArr = map[toId];
    const fromFan = fanInIds.has(fromId);
    const toFan = fanInIds.has(toId);
    const fromCtrl = isControlKind(nodeById(fromId));

    /* 控制线 → 拆分后的各副本 */
    if (fromCtrl) {
      if (toArr) {
        for (let i = 0; i < N; i++) pushPending(fromId, toArr[i], null);
      } else if (toId === root.id) {
        for (let i = 0; i < N; i++) pushPending(fromId, map[root.id][i], null);
      }
      continue;
    }

    if (toFan && fromArr) {
      for (let i = 0; i < N; i++) pushPending(fromArr[i], toId, null);
      continue;
    }
    if (fromArr && toArr) {
      for (let i = 0; i < N; i++) pushPending(fromArr[i], toArr[i], w.toIndex);
      continue;
    }
    if (fromFan && toArr) {
      for (let i = 0; i < N; i++) pushPending(fromId, toArr[i], w.toIndex);
      continue;
    }
    /* 外部 → 被拆节点：接到每一条链 */
    if (!fromArr && !fromFan && toArr) {
      for (let i = 0; i < N; i++) pushPending(fromId, toArr[i], w.toIndex);
      continue;
    }
    /* 被拆节点 → 外部非聚合：扇入到该外部节点 */
    if (fromArr && !toArr && !toFan && !skipIds.has(toId) && nodeById(toId)) {
      for (let i = 0; i < N; i++) pushPending(fromArr[i], toId, null);
      continue;
    }
  }

  const toDelete = [root.id].concat(explodeIds, [...skipIds]);
  /* 断开智能会话关联，避免 quiet 删除时顺带清掉会话记录 */
  for (const id of toDelete) {
    const n = nodeById(id);
    if (n && (n.kind === "agent_task" || (n.kind === "super" && n.dev))) {
      n.agentSessionId = "";
      if (Array.isArray(n.devSessionIds)) n.devSessionIds = [];
    }
  }
  deleteNodes(toDelete, true);

  for (const p of pending) {
    if (!nodeById(p.from) || !nodeById(p.to)) continue;
    if (wouldCycle(p.from, p.to)) continue;
    const err = connectError(p.from, p.to, null);
    if (err) continue;
    addWire(p.from, p.to, null, { notify: false, save: false });
  }

  const created = map[root.id] || [];
  S.selSet = new Set(created);
  S.sel = created[0] || null;
  S.selGroup = null;
  S.selWire = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(
    I18n.t("已拆分批次：") + N + I18n.t(" 条") +
      (explodeCount ? I18n.t(" · 下游 ") + explodeCount + I18n.t(" 个节点") : ""),
    "ok",
  );

  if (
    await confirmDialog(
      I18n.t(
        "批次拆分已完成。是否进行重新排版？\n\n将按连线关系整理节点位置。",
      ),
      { title: I18n.t("一键排版"), okText: I18n.t("开始排版") },
    )
  ) {
    oneClickAutoLayout({ skipConfirm: true });
  }
}

/* ============ @ 引用 ============ */

/** 单条数据输入线可 @ 的来源：直连 + 经超级节点隧穿的上游（可嵌套） */
function refSourcesForWire(w, consumer) {
  const out = [];
  const seen = new Set();
  const pushRefSource = (n, cons, portHint) => {
    if (!n || seen.has(n.id) || !isRefableSource(n)) return;
    seen.add(n.id);
    out.push(n);
    if (n.kind !== "super") return;
    const port = portHint == null ? null : Number(portHint);
    if (cons && nodeParentSuperId(cons) === n.id) {
      for (const ext of superExternalInWires(n)) {
        if (port != null && Number(ext.toIndex) !== port) continue;
        pushRefSource(nodeById(ext.from), cons, ext.fromIndex);
      }
    } else {
      for (const feed of superInternalOutFeeds(n)) {
        if (port != null && Number(feed.toIndex) !== port) continue;
        pushRefSource(nodeById(feed.from), cons, feed.fromIndex);
      }
    }
  };
  const src = nodeById(w.from);
  if (!src) return out;
  pushRefSource(src, consumer || null, w.fromIndex);
  return out;
}

/** 自动附加背景时优先叶子源，避免超级节点与隧穿上游重复同一段文字 */
function refLeafSourcesForWire(w, consumer) {
  const all = refSourcesForWire(w, consumer);
  const leaves = all.filter((n) => n && n.kind !== "super");
  return leaves.length ? leaves : all;
}

function isRefTextSourceKind(src) {
  return !!(
    src &&
    (src.kind === "input_text" ||
      src.kind === "proc_text" ||
      src.kind === "agent_task" ||
      src.kind === "merge" ||
      src.kind === "split")
  );
}

/** @ 引用可注入的文字：文本端子取正文；音 / 视频端子取其 `text`
    （音视频输入节点 = 该文件的 file:/// URL，生成节点 = 产物路径），
    这样 @音频节点 能把地址写进提示词，图像与无值来源仍走各自的分支。 */
function refTextFromValue(v) {
  if (!v) return null;
  if (v.kind === "text") return v.text == null ? "" : String(v.text);
  if ((v.kind === "audio" || v.kind === "video") && v.text != null)
    return String(v.text);
  return null;
}

/** @ 引用 / 取值时用的端口条目索引（含超级节点隧穿） */
function refInputIdxFor(node, src, batchIdx) {
  if (!src) return batchIdx == null ? 0 : batchIdx;
  for (const w of wiresTo(node.id)) {
    const from = nodeById(w.from);
    if (!from) continue;
    if (from.id === src.id) {
      return from.kind === "super"
        ? Number(w.fromIndex || 0)
        : batchIdx == null
          ? 0
          : batchIdx;
    }
    if (from.kind === "super") {
      const port = Number(w.fromIndex || 0);
      if (nodeParentSuperId(node) === from.id) {
        const ext = superExternalInWires(from).find(
          (x) =>
            Number(x.toIndex) === port && nodeById(x.from)?.id === src.id,
        );
        if (ext) return Number(ext.fromIndex || 0);
      }
      const feed = superInternalOutFeeds(from).find(
        (x) =>
          Number(x.toIndex) === port && nodeById(x.from)?.id === src.id,
      );
      if (feed) return Number(feed.fromIndex || 0);
    }
  }
  return batchIdx == null ? 0 : batchIdx;
}

function refCandidates(node) {
  /* 已连接输入 + 全局节点广播的来源（处理节点可 @ 引用） */
  const out = [];
  const seen = new Set();
  const push = (n) => {
    if (!n || seen.has(n.id) || !isRefableSource(n)) return;
    seen.add(n.id);
    out.push(n);
  };
  for (const w of wiresTo(node.id)) {
    for (const n of refSourcesForWire(w, node)) push(n);
  }
  if (usesGlobalRefs(node)) {
    for (const n of globalRefSources(node.id)) push(n);
  }
  return out;
}

function valueForInput(src, idx, consumer, seen) {
  if (!src || isControlKind(src)) return null;
  if (isSuperLikeNode(src)) {
    const cons = consumer || null;
    const key =
      "super:" +
      src.id +
      ":" +
      Number(idx || 0) +
      ":" +
      (cons && nodeParentSuperId(cons) === src.id ? "in" : "out");
    if (seen && seen.has(key)) return null;
    const next = new Set(seen || []);
    next.add(key);
    if (cons && nodeParentSuperId(cons) === src.id)
      return externalValueIntoSuper(src, idx, next);
    return valueForSuperOutput(src, idx, next);
  }
  if (src.kind === "task") {
    const r = selResult(src);
    return r && r.output && r.output.kind === "text"
      ? { kind: "text", text: r.output.text }
      : { kind: "text", text: taskSummaryText(src) };
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    return it ? it.value : null;
  }
  if (src.kind === "merge") {
    const items = mergeItems(src);
    if (!items.length) return null;
    const it = items[Math.min(idx || 0, items.length - 1)];
    return it ? it.value : null;
  }
  if (src.kind === "input_text") {
    if (inputInherited(src)) {
      /* 把当前节点作为 consumer 传入，超级节点才能走「外侧输入」而非「内侧输出」 */
      const w = inboundWire(src);
      const up = valueForInput(
        w ? nodeById(w.from) : null,
        wireSourceIndex(w, idx),
        src,
        seen,
      );
      if (up && up.kind === "text" && !src.yamlOff) {
        const es = parseSimpleYaml(up.text);
        if (es.length) {
          // 继承文本符合 YAML → 按批量条目取值
          const e = es[Math.min(idx || 0, es.length - 1)];
          return e ? { kind: "text", text: e.content || "" } : null;
        }
      }
      return up;
    }
    if (src.batch) {
      const es = src.entries || [];
      const e = es[idx] || es[es.length - 1];
      return e ? { kind: "text", text: e.content || "" } : null;
    }
    return { kind: "text", text: src.text || "" };
  }
  if (src.kind === "input_image") {
    if (inputInherited(src)) {
      const w = inboundWire(src);
      return valueForInput(
        w ? nodeById(w.from) : null,
        wireSourceIndex(w, idx),
        src,
        seen,
      );
    }
    if (src.batch) {
      const es = (src.entries || []).filter((e) => e.path);
      const e = es[idx] || es[es.length - 1];
      return e ? { kind: "image", path: e.path } : null;
    }
    return src.imageAsset ? { kind: "image", path: src.imageAsset } : null;
  }
  /* 音频 / 视频输入：静态源，端子值 = 本机文件（path）+ file:/// URL（url / text）。
     未选文件时返回 null → 端子显示未就绪，下游按「无输入」处理。 */
  if (src.kind === "input_audio" || src.kind === "input_video") {
    return mediaInputValueOf(src);
  }
  /* 素材节点：同样是静态源，只是「一个端子 = 素材库里的一条内容」——
     第 idx 出 ↔ 第 idx 条，值按条目类型给（见 assetItemValueOf）。 */
  if (src.kind === "asset") return assetItemValueOf(src, idx);
  if (src.kind === "proc_text" || src.kind === "agent_task") {
    const r = selResult(src);
    /* 聚合模式：下游应取单次结果，勿优先旧的 batchOutputs */
    if (src.batchMode === "agg") {
      return r && r.output && r.output.kind === "text"
        ? { kind: "text", text: r.output.text }
        : null;
    }
    if (r && r.batchOutputs && r.batchOutputs.length) {
      const x =
        r.batchOutputs[idx] || r.batchOutputs[r.batchOutputs.length - 1];
      return x && x.ok && x.output
        ? { kind: "text", text: x.output.text }
        : null;
    }
    return r && r.output && r.output.kind === "text"
      ? { kind: "text", text: r.output.text }
      : null;
  }
  if (src.kind === "function") {
    /* 函数节点：多输出分发后按端子取值（引擎把 return 对象按键名写进
       portOutputs.$<端子序号>）；该端子无值 / 旧存档只有单输出时回落 node.output */
    const r = selResult(src);
    const po = (r && r.portOutputs) || null;
    const key = "$" + (Number(idx) || 0);
    if (po && Object.prototype.hasOwnProperty.call(po, key))
      return po[key] || null;
    return r && r.output ? r.output : null;
  }
  if (src.kind === "music_gen" || src.kind === "tts_gen") {
    const r = selResult(src);
    const p =
      (r && r.output && (r.output.path || r.output.text)) ||
      (src.output && (src.output.path || src.output.text)) ||
      "";
    if (!p) return null;
    /* 与音视频输入节点同口径：path 供本机后端直接用，url 是对外输出地址 */
    return { kind: "audio", path: String(p), url: mediaFileUrlOf(p), text: String(p) };
  }
  if (src.kind === "video_gen" || src.kind === "remotion") {
    const r = selResult(src);
    const p =
      (r && r.output && (r.output.path || r.output.text)) ||
      (src.output && (src.output.path || src.output.text)) ||
      "";
    if (!p) return null;
    return {
      kind: "video",
      path: String(p),
      url: mediaFileUrlOf(p),
      text: String(p),
    };
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      return r && r.output && r.output.kind === "image"
        ? { kind: "image", path: r.output.path }
        : null;
    }
    if (r && r.batchOutputs && r.batchOutputs.length) {
      const x =
        r.batchOutputs[idx] || r.batchOutputs[r.batchOutputs.length - 1];
      return x && x.ok && x.output
        ? { kind: "image", path: x.output.path }
        : null;
    }
    return r && r.output && r.output.kind === "image"
      ? { kind: "image", path: r.output.path }
      : null;
  }
  return null;
}

/* 输入节点的继承值（取第一个输入） */
function inboundWire(n) {
  return wiresTo(n.id)[0] || null;
}
function wireSourceIndex(w, fallbackIdx) {
  const src = w && nodeById(w.from);
  if (src && isSuperLikeNode(src)) return Number(w.fromIndex || 0);
  return fallbackIdx == null ? 0 : fallbackIdx;
}
function inheritedValue(n, idx) {
  if (!inputInherited(n)) return null;
  const w = inboundWire(n);
  if (!w) return null;
  return valueForInput(nodeById(w.from), wireSourceIndex(w, idx), n);
}

/* 聚合模式：取某个源的全部条目（批量源 → 每个条目；普通源 → 单个） */
function allTextItems(src, consumer, portIdx) {
  if (!src) return [];
  if (isSuperLikeNode(src)) {
    let slot = 0;
    if (portIdx != null && portIdx !== "") slot = Number(portIdx) || 0;
    else if (consumer) {
      const link = (S.wf.wires || []).find(
        (x) =>
          (x.from === src.id && x.to === consumer.id) ||
          (x.to === src.id && x.from === consumer.id),
      );
      if (link && link.from === src.id) slot = Number(link.fromIndex || 0);
      else if (link && link.to === src.id) slot = Number(link.toIndex || 0);
    }
    if (consumer && nodeParentSuperId(consumer) === src.id) {
      const ext = superExternalInWires(src).find(
        (x) => Number(x.toIndex) === slot,
      );
      return ext ? allTextItems(nodeById(ext.from), src) : [];
    }
    const feed = superInternalOutFeeds(src).find(
      (x) => Number(x.toIndex) === slot,
    );
    return feed ? allTextItems(nodeById(feed.from), src) : [];
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    return it && it.value.kind === "text"
      ? [{ title: it.title, text: it.value.text }]
      : [];
  }
  if (src.kind === "merge")
    return mergeItems(src)
      .filter((i) => i.kind === "text")
      .map((i) => ({ title: i.title, text: i.value.text }));
  if (src.kind === "input_text") {
    if (inputInherited(src)) {
      const w = inboundWire(src);
      const inner = allTextItems(w ? nodeById(w.from) : null, src);
      if (inner.length > 1) return inner; // 继承批量 → 全部条目
      if (inner.length === 1 && !src.yamlOff) {
        const es = parseSimpleYaml(inner[0].text); // 继承文本符合 YAML → 解析为条目
        if (es.length)
          return es.map((e) => ({ title: e.title, text: e.content }));
        return [{ title: src.title, text: inner[0].text }];
      }
      return inner.length === 1 ? [{ title: src.title, text: inner[0].text }] : [];
    }
    if (src.batch && (src.entries || []).length)
      return src.entries.map((e) => ({
        title: e.title,
        text: e.content || "",
      }));
    return [{ title: src.title, text: src.text || "" }];
  }
  if (src.kind === "proc_text" || src.kind === "agent_task") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      if (r && r.output && r.output.kind === "text")
        return [{ title: src.title, text: r.output.text }];
      return [];
    }
    if (r && r.batchOutputs && r.batchOutputs.length)
      return r.batchOutputs.map((x) => ({
        title: x.title,
        text: x.ok && x.output ? x.output.text : "",
      }));
    if (r && r.output && r.output.kind === "text")
      return [{ title: src.title, text: r.output.text }];
    return [];
  }
  if (src.kind === "function") {
    const r = selResult(src);
    if (r && r.output && r.output.kind === "text")
      return [{ title: src.title, text: r.output.text }];
    return [];
  }
  if (src.kind === "task") {
    const r = selResult(src);
    const t =
      r && r.output && r.output.kind === "text"
        ? r.output.text
        : taskSummaryText(src);
    return t ? [{ title: src.title, text: t }] : [];
  }
  if (src.kind === "net_recv") {
    const o = src.output;
    return o && o.kind === "text" ? [{ title: src.title, text: o.text }] : [];
  }
  return [];
}
function allImageItems(src, consumer, portIdx) {
  if (!src) return [];
  if (isSuperLikeNode(src)) {
    let slot = 0;
    if (portIdx != null && portIdx !== "") slot = Number(portIdx) || 0;
    else if (consumer) {
      const link = (S.wf.wires || []).find(
        (x) =>
          (x.from === src.id && x.to === consumer.id) ||
          (x.to === src.id && x.from === consumer.id),
      );
      if (link && link.from === src.id) slot = Number(link.fromIndex || 0);
      else if (link && link.to === src.id) slot = Number(link.toIndex || 0);
    }
    if (consumer && nodeParentSuperId(consumer) === src.id) {
      const ext = superExternalInWires(src).find(
        (x) => Number(x.toIndex) === slot,
      );
      return ext ? allImageItems(nodeById(ext.from), src) : [];
    }
    const feed = superInternalOutFeeds(src).find(
      (x) => Number(x.toIndex) === slot,
    );
    return feed ? allImageItems(nodeById(feed.from), src) : [];
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    return it && it.value.kind === "image"
      ? [{ title: it.title, path: it.value.path }]
      : [];
  }
  if (src.kind === "merge")
    return mergeItems(src)
      .filter((i) => i.kind === "image")
      .map((i) => ({ title: i.title, path: i.value.path }));
  if (src.kind === "input_image") {
    if (inputInherited(src)) {
      const w = inboundWire(src);
      const inner = allImageItems(w ? nodeById(w.from) : null, src);
      if (inner.length > 1) return inner;
      if (inner.length === 1)
        return [
          {
            title: inner[0].title || src.title,
            path: inner[0].path,
          },
        ];
      return [];
    }
    if (src.batch && (src.entries || []).length)
      return (src.entries || [])
        .filter((e) => e.path)
        .map((e) => ({
          title: entryDisplayTitle(e) || src.title || I18n.t("图像"),
          path: e.path,
        }));
    if (src.imageAsset) {
      return [
        {
          title: singleImageTitle(src),
          path: src.imageAsset,
        },
      ];
    }
    return [];
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      if (r && r.output && r.output.kind === "image")
        return [{ title: src.title, path: r.output.path }];
      return [];
    }
    if (r && r.batchOutputs && r.batchOutputs.length)
      return r.batchOutputs
        .filter((x) => x.ok && x.output)
        .map((x) => ({ title: x.title, path: x.output.path }));
    if (r && r.output && r.output.kind === "image")
      return [{ title: src.title, path: r.output.path }];
    return [];
  }
  if (src.kind === "function") {
    /* 函数节点：主输出为图像路径时按图像条目返回 */
    const r = selResult(src);
    if (r && r.output && r.output.path && r.output.kind === "image")
      return [{ title: src.title, path: r.output.path }];
    return [];
  }
  return [];
}
function dedupeBlockTitles(blocks) {
  const seen = {};
  return blocks.map((b) => {
    let t = b.title || I18n.t("输入");
    const base = t;
    let n = 1;
    while (seen[t]) {
      n++;
      t = base + " (" + n + ")";
    }
    seen[t] = 1;
    return { title: t, text: b.text };
  });
}

/* 某源在第 idx 个条目上的标题：批量源的条目 field / 图像文件名，非批量 = 节点标题 */
function itemTitleOf(src, idx, consumer) {
  if (!src) return I18n.t("输入");
  const fallback = src.title || I18n.t("输入");
  const at = Math.min(idx || 0, 999999);
  if (isSuperLikeNode(src)) {
    if (consumer && nodeParentSuperId(consumer) === src.id) {
      const ext = superExternalInWires(src).find(
        (x) => Number(x.toIndex) === at,
      );
      if (ext)
        return (
          itemTitleOf(nodeById(ext.from), Number(ext.fromIndex || 0)) || fallback
        );
    } else {
      const feed = superInternalOutFeeds(src).find(
        (x) => Number(x.toIndex) === at,
      );
      if (feed)
        return (
          itemTitleOf(
            nodeById(feed.from),
            Number(feed.fromIndex || 0),
          ) || fallback
        );
    }
    return fallback;
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    return it ? it.title : fallback;
  }
  if (src.kind === "merge") {
    const items = mergeItems(src);
    if (items.length) {
      const it = items[Math.min(at, items.length - 1)];
      return it.title || fallback;
    }
    return fallback;
  }
  if (src.kind === "input_text") {
    if (inputInherited(src)) {
      const v = inheritedValue(src, 0);
      if (v && v.kind === "text") {
        const es = parseSimpleYaml(v.text);
        if (es.length) {
          const e = es[Math.min(at, es.length - 1)];
          return e.title || fallback;
        }
      }
      const w = inboundWire(src);
      return (
        itemTitleOf(
          w ? nodeById(w.from) : null,
          wireSourceIndex(w, idx),
          src,
        ) || fallback
      );
    }
    if (src.batch && (src.entries || []).length) {
      const e = src.entries[Math.min(at, src.entries.length - 1)];
      return (e && e.title) || fallback;
    }
    return fallback;
  }
  if (src.kind === "input_image") {
    if (inputInherited(src)) {
      const w = inboundWire(src);
      return (
        itemTitleOf(
          w ? nodeById(w.from) : null,
          wireSourceIndex(w, idx),
          src,
        ) || fallback
      );
    }
    if (src.batch && (src.entries || []).length) {
      /* 与 valueForInput 一致：只计有 path 的条目 */
      const es = (src.entries || []).filter((e) => e.path);
      if (!es.length) return fallback;
      const e = es[Math.min(at, es.length - 1)];
      return entryDisplayTitle(e) || fallback;
    }
    if (src.imageAsset) return singleImageTitle(src);
    return fallback;
  }
  if (src.kind === "proc_text" || src.kind === "agent_task") {
    const r = selResult(src);
    if (src.batchMode !== "agg" && r && r.batchOutputs && r.batchOutputs.length) {
      const x = r.batchOutputs[Math.min(at, r.batchOutputs.length - 1)];
      return (x && x.title) || fallback;
    }
    return fallback;
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
    if (src.batchMode !== "agg" && r && r.batchOutputs && r.batchOutputs.length) {
      const x = r.batchOutputs[Math.min(at, r.batchOutputs.length - 1)];
      return (x && x.title) || fallback;
    }
    return fallback;
  }
  return fallback;
}

/* 用于只读展示的节点值描述：{text} | {image} | {items:[{title,content}]} | {images:[{title,path}]} */
function displayValueOf(src, consumer) {
  if (!src) return null;
  if (isSuperLikeNode(src)) {
    let idx = 0;
    if (consumer) {
      const link = (S.wf.wires || []).find(
        (x) =>
          (x.from === src.id && x.to === consumer.id) ||
          (x.to === src.id && x.from === consumer.id),
      );
      if (link && link.from === src.id) idx = Number(link.fromIndex || 0);
      else if (link && link.to === src.id) idx = Number(link.toIndex || 0);
    }
    const v = valueForInput(src, idx, consumer || null);
    if (!v) return null;
    if (v.kind === "text") return { text: v.text };
    if (v.kind === "image") return { image: v.path, title: src.title };
    return null;
  }
  if (src.kind === "task") {
    const r = selResult(src);
    if (r && r.output && r.output.kind === "text") return { text: r.output.text };
    const t = taskSummaryText(src);
    return t ? { text: t } : null;
  }
  if (src.kind === "split") {
    const it = splitSelected(src);
    if (!it) return null;
    return it.value.kind === "text"
      ? { text: it.value.text }
      : { image: it.value.path };
  }
  if (src.kind === "merge") {
    const items = mergeItems(src);
    const t = items
      .filter((i) => i.kind === "text")
      .map((i) => ({ title: i.title, content: i.value.text }));
    const g = items
      .filter((i) => i.kind === "image")
      .map((i) => ({ title: i.title, path: i.value.path }));
    if (t.length && g.length) return { items: t, images: g };
    if (t.length) return { items: t };
    if (g.length) return { images: g };
    return null;
  }
  if (src.kind === "input_text") {
    if (inputInherited(src)) return displayValueOf(firstSource(src), src);
    if (src.batch && (src.entries || []).length)
      return {
        items: src.entries.map((e) => ({ title: e.title, content: e.content })),
      };
    return { text: src.text || "" };
  }
  if (src.kind === "input_image") {
    if (inputInherited(src)) return displayValueOf(firstSource(src), src);
    if (src.batch && (src.entries || []).length)
      return {
        images: (src.entries || [])
          .filter((e) => e.path)
          .map((e) => ({
            title: entryDisplayTitle(e),
            path: e.path,
          })),
      };
    return src.imageAsset
      ? { image: src.imageAsset, title: singleImageTitle(src) }
      : null;
  }
  if (src.kind === "proc_text" || src.kind === "agent_task") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      if (r && r.output && r.output.kind === "text")
        return { text: r.output.text };
      return null;
    }
    if (r && r.batchOutputs && r.batchOutputs.length)
      return {
        items: r.batchOutputs.map((x) => ({
          title: x.title,
          content: x.ok && x.output ? x.output.text : I18n.t("(失败)"),
        })),
      };
    if (r && r.output && r.output.kind === "text")
      return { text: r.output.text };
    return null;
  }
  if (src.kind === "proc_image") {
    const r = selResult(src);
    if (src.batchMode === "agg") {
      if (r && r.output && r.output.kind === "image")
        return { image: r.output.path };
      return null;
    }
    if (r && r.batchOutputs && r.batchOutputs.length)
      return {
        images: r.batchOutputs
          .filter((x) => x.ok && x.output)
          .map((x) => ({ title: x.title, path: x.output.path })),
      };
    if (r && r.output && r.output.kind === "image")
      return { image: r.output.path };
    return null;
  }
  if (src.kind === "net_recv") {
    const o = src.output;
    if (o && o.kind === "text") return { text: o.text };
    if (typeof o === "string") return { text: o };
    return null;
  }
  /* 音视频输入：静态源，对外可读内容 = 该文件的 file:/// URL（与端子值同口径） */
  if (src.kind === "input_audio" || src.kind === "input_video") {
    const v = mediaInputValueOf(src);
    return v ? { text: String(v.text || "") } : null;
  }
  /* 素材节点：逐条内容对外可读（单条摊平成 {text}/{image}，多条按类型分组） */
  if (src.kind === "asset") return assetDisplayValueOf(src);
  if (src.kind === "function") {
    const r = selResult(src);
    if (r && r.output && r.output.kind === "text") return { text: r.output.text };
    if (r && r.output && r.output.kind === "image" && r.output.path)
      return { image: r.output.path, title: src.title };
    return null;
  }
  return null;
}

function inputValuesFor(node, idx) {
  return wiresTo(node.id).map((w) => {
    const src = nodeById(w.from);
    const fromIdx =
      src && isSuperLikeNode(src)
        ? Number(w.fromIndex || 0)
        : idx;
    return {
      title: src ? itemTitleOf(src, fromIdx, node) : I18n.t("输入"),
      value: valueForInput(src, fromIdx, node),
    };
  });
}

function findCandidateByTitle(cands, tok) {
  let t = tok;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = cands.find((c) => c.title === t);
    if (c) return c;
    if (attempt === 0) t = tok.replace(/[，。；、！？：,.!?;:]+$/, "");
  }
  return cands.find((c) => c.title && c.title.startsWith(tok)) || null;
}

function tagByAtToken(tok) {
  const t = normalizeTagName(tok);
  return t && wfTagCatalog().includes(t) ? t : "";
}

function nodesForTagRef(tag, exceptId) {
  const t = normalizeTagName(tag);
  if (!t) return [];
  return ((S.wf && S.wf.nodes) || []).filter(
    (n) =>
      n &&
      n.id !== exceptId &&
      n.kind !== "global" &&
      isRefableSource(n) &&
      nodeHasTag(n, t),
  );
}

function refTagCandidates(node) {
  const out = [];
  for (const t of wfTagCatalog()) {
    if (nodesForTagRef(t, node && node.id).length) out.push(t);
  }
  return out.sort((a, b) => a.localeCompare(b, "zh"));
}

function refMenuEntries(node) {
  const isAgg =
    node &&
    (node.kind === "proc_text" ||
      node.kind === "proc_image" ||
      node.kind === "agent_task") &&
    node.batchMode === "agg" &&
    batchTitles(node);
  if (isAgg) return aggCandidates(node).map((n) => ({ kind: "node", node: n }));
  const entries = [];
  for (const n of refCandidates(node)) entries.push({ kind: "node", node: n });
  for (const t of refTagCandidates(node)) entries.push({ kind: "tag", tag: t });
  return entries;
}

function collectTagRefContent(tag, node, idx, ctx) {
  const nodes = nodesForTagRef(tag, node && node.id);
  if (!nodes.length) return false;
  ctx.seenTagNodes = ctx.seenTagNodes || new Set();
  for (const src of nodes) {
    if (ctx.seenTagNodes.has(src.id)) continue;
    ctx.seenTagNodes.add(src.id);
    for (const it of allTextItems(src, node)) {
      ctx.textSources.push({
        id: src.id + "@tag:" + tag,
        title: "Tag·" + tag + " / " + (it.title || src.title),
        text: it.text,
      });
    }
    for (const it of allImageItems(src, node)) {
      const path = it.path;
      if (!path) continue;
      if (ctx.refImages.indexOf(path) < 0) ctx.refImages.push(path);
    }
  }
  return true;
}

function collectTagRefBlocksAgg(tag, node, tagBlocks, refImages, seenNodes) {
  const nodes = nodesForTagRef(tag, node && node.id);
  if (!nodes.length) return false;
  for (const src of nodes) {
    if (seenNodes.has(src.id)) continue;
    seenNodes.add(src.id);
    for (const it of allTextItems(src, node)) {
      tagBlocks.push({
        title: "Tag·" + tag + " / " + (it.title || src.title),
        text: it.text,
      });
    }
    for (const it of allImageItems(src, node)) {
      const path = it.path;
      if (!path) continue;
      if (refImages.indexOf(path) < 0) refImages.push(path);
      tagBlocks.push({
        title: it.title || src.title || I18n.t("图像"),
        text:
          I18n.t("（图像输入）") +
          "\n" +
          I18n.t("标题：") +
          (it.title || src.title || I18n.t("图像")),
      });
    }
  }
  return true;
}

function escapePromptHl(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* 高亮层与 textarea 严格同源：正文一律用 textarea 的实际值，末尾恒定追加同一行占位。
   （行尾换行在 pre-wrap 镜像层里会被折叠掉，所以恒定补 "\n" 而不是按 endsWith 手工补换行，
   两层的行位置始终一致，滚动位置也能一一对应。） */
const PROMPT_HL_TAIL = "\n";

function promptRefBackdropHtml(text, node) {
  const cands = refCandidates(node);
  const tags = new Set(refTagCandidates(node));
  return (
    eachAtMention(
      text,
      atRefNamesFor(cands),
      escapePromptHl,
      (h, seg) => {
        const key = h.name || h.token;
        const tag = tagByAtToken(key);
        const cls = findCandidateByTitle(cands, key)
          ? "at-ref-node"
          : tag && tags.has(tag)
            ? "at-ref-tag"
            : "";
        return cls ? '<span class="' + cls + '">' + escapePromptHl(seg) + "</span>" : null;
      },
    ) + PROMPT_HL_TAIL
  );
}

function syncPromptRefBackdrop(ta, node) {
  if (!ta) return;
  const wrap = ta.closest(".n-prompt-wrap");
  const hl = wrap && wrap.querySelector(".n-prompt-hl");
  if (!hl) return;
  /* 与 textarea 完全相同的文本，占位已在 promptRefBackdropHtml 内统一追加 */
  hl.innerHTML = promptRefBackdropHtml(String(ta.value || ""), node);
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
}

function mountPromptTextarea(f3, ta, node, persistPrompt) {
  const wrap = document.createElement("div");
  wrap.className = "n-prompt-wrap";
  const hl = document.createElement("div");
  hl.className = "n-prompt-hl";
  hl.setAttribute("aria-hidden", "true");
  wrap.appendChild(hl);
  wrap.appendChild(ta);
  ta.classList.add("n-text-layered");
  const syncHl = () => syncPromptRefBackdrop(ta, node);
  ta.addEventListener("input", () => {
    persistPrompt(ta.value);
    refTick(ta, node);
    syncHl();
    if (isDshTask(node)) slashTick(ta, "node", persistPrompt);
  });
  ta.addEventListener("scroll", () => {
    closeRefMenu();
    closeSlashMenu();
    syncHl();
  });
  /* 除 input/scroll 外，这些时机 textarea 的实际值或滚动位置也可能已经变了：
     select / selectionchange（落在本元素的选区变化，拖拽改选时常自行滚动）、
     focus（重新聚焦时浏览器可能把光标滚回可视区而不派发 scroll）、
     compositionend（输入法上屏后的最终值）。统一补一次高亮层同步，避免漂移。 */
  for (const ev of ["select", "selectionchange", "focus", "compositionend"])
    ta.addEventListener(ev, syncHl);
  f3.appendChild(wrap);
  syncHl();
}

function resolveRefs(prompt, node, idx, opts) {
  const refImages = [];
  const unresolved = new Set();
  const textSources = [];
  const seen = new Set();
  /* !@数据库标题 引用：先替换为可读指针（并收集引用库供 dbNodesForRun/接地用） */
  const bang = resolveDbBangRefs(prompt, node);
  prompt = bang.prompt;
  const addText = (c, fromIdx) => {
    if (!c || seen.has(c.id)) return;
    seen.add(c.id);
    const useIdx = fromIdx != null ? fromIdx : idx;
    const v = valueForInput(c, useIdx, node);
    const t = refTextFromValue(v);
    if (t != null)
      textSources.push({
        id: c.id,
        title: itemTitleOf(c, useIdx, node),
        text: t,
      });
  };
  const cands = refCandidates(node);
  if (!opts || !opts.skipConnected) {
    const wiredLeaves = new Set();
    for (const w of wiresTo(node.id)) {
      for (const src of refLeafSourcesForWire(w, node)) {
        wiredLeaves.add(src.id);
        if (isRefTextSourceKind(src))
          addText(src, refInputIdxFor(node, src, idx));
      }
    }
    /* 全局广播只注入被明文 @ 命中的来源（未 @ 的全局源不进背景信息） */
    for (const src of globalRefSourcesForRun(node, prompt)) {
      if (wiredLeaves.has(src.id)) continue;
      addText(src);
    }
  }
  const out = mapAtMentions(prompt, atRefNamesFor(cands), (h, raw) => {
    const tok = h.name || h.token;
    const c = findCandidateByTitle(cands, tok);
    if (!c) {
      const tag = tagByAtToken(tok);
      if (
        tag &&
        collectTagRefContent(tag, node, idx, {
          refImages,
          textSources,
          seenTagNodes: seen,
        })
      )
        return "Tag:" + tag;
      unresolved.add(tok);
      return raw;
    }
    const useIdx = refInputIdxFor(node, c, idx);
    const v = valueForInput(c, useIdx, node);
    if (refTextFromValue(v) != null) {
      if (c.kind === "super") {
        for (const w of wiresTo(node.id)) {
          if (nodeById(w.from)?.id !== c.id) continue;
          for (const leaf of refLeafSourcesForWire(w, node)) {
            if (isRefTextSourceKind(leaf))
              addText(leaf, refInputIdxFor(node, leaf, idx));
          }
        }
      } else {
        addText(c, useIdx);
      }
      return c.title;
    }
    if (v && v.kind === "image") {
      const path = v.path;
      let n = refImages.indexOf(path);
      if (n < 0) {
        refImages.push(path);
        n = refImages.length - 1;
      }
      /* 图生图 edits 按 multipart 顺序认图，无法靠标题文字定位 → 写成「第 N 张参考图」 */
      return I18n.t("第{n}张参考图", { n: n + 1 });
    }
    return raw;
  });
  return { prompt: out, refImages, unresolved: [...unresolved], textSources };
}

/* 合并参考图路径：@ 引用优先（与「第 N 张」一致），再补连线输入；同路径只保留一次 */
function mergeImagePaths(primary, secondary) {
  const out = [];
  const seen = new Set();
  for (const list of [primary, secondary]) {
    for (const p of list || []) {
      const s = String(p || "");
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/* 将输入文字与 prompt 组合：背景信息（### 标题 + 内容） + 【内容】prompt */
function assemblePrompt(prompt, sources) {
  const blocks = [];
  for (const s of sources) {
    if (s.text === "") continue;
    blocks.push("### " + s.title + "\n" + s.text);
  }
  if (!blocks.length) return prompt;
  return "【背景信息】\n" + blocks.join("\n\n") + "\n\n【内容】\n" + prompt;
}

/* 量出光标在输入框内的位置（屏幕坐标），供 @ 引用菜单 / 技能斜杠菜单定位。
   结论（本次光标错位排查记录，勿再猜）：
   1) 节点正文的「点击 → 光标」由浏览器在 textarea 自身布局里算，#stage 的
      translate+scale 由 Blink 反过来映射，缩放不会让光标落到别的字符上；
      真正会让「看到的字」与「编辑到的字」错位的是高亮镜像层与 textarea 的
      排版几何不一致，那部分修在 css（scrollbar-gutter / 断行规则）里。
   2) 但本函数确实掺了第二处偏移：r 是已缩放的屏幕坐标，而 span.offsetLeft /
      scrollTop 都是未缩放的本地 CSS px，混着相加在画布缩放 ≠100% 时会让弹层
      整体偏离光标（偏离量 = 本地位移 ×(z-1)，越靠行尾偏得越多）。故本地量出的
      位移统一乘该元素实测渲染倍率；倍率由自身矩形反推，不读 S.cam.z ——
      助手侧栏 / 会话面板里同类输入框不在画布变换下，倍率天然是 1，一份代码
      两种场合都正确，也不需要动画布变换。
   3) 镜像的断行规则改成抄 textarea 的计算值：原先写死 word-break:break-all，
      长 URL / 连续 token 时换行点与实际正文不同，量出来会整行偏掉。 */
function caretXY(ta, atIdx) {
  const r = ta.getBoundingClientRect();
  const cs = getComputedStyle(ta);
  const kx = ta.offsetWidth > 0 ? r.width / ta.offsetWidth : 1;
  const ky = ta.offsetHeight > 0 ? r.height / ta.offsetHeight : 1;
  const mirror = document.createElement("div");
  mirror.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre-wrap;" +
    "word-break:" +
    cs.wordBreak +
    ";overflow-wrap:" +
    cs.overflowWrap +
    ";" +
    "font-family:" +
    cs.fontFamily +
    ";font-size:" +
    cs.fontSize +
    ";line-height:" +
    cs.lineHeight +
    ";" +
    "padding:" +
    cs.paddingTop +
    " " +
    cs.paddingRight +
    " " +
    cs.paddingBottom +
    " " +
    cs.paddingLeft +
    ";" +
    "width:" +
    ta.clientWidth +
    "px;letter-spacing:" +
    cs.letterSpacing +
    ";tab-size:" +
    (cs.tabSize || "4") +
    ";";
  mirror.textContent = ta.value.slice(
    0,
    atIdx == null ? ta.selectionStart || 0 : atIdx,
  );
  document.body.appendChild(mirror);
  const span = document.createElement("span");
  span.textContent = "|";
  mirror.appendChild(span);
  /* offsetLeft/Top 从镜像的 padding 边起算（镜像无边框），textarea 还要再多一层
     1px 边框才是 r 的原点；横向滚动原先漏扣，一并补上 */
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  const lx = span.offsetLeft + bl - (ta.scrollLeft || 0);
  const ly = span.offsetTop + bt + span.offsetHeight - (ta.scrollTop || 0);
  mirror.remove();
  return { x: r.left + lx * kx, y: r.top + ly * ky };
}

/* 光标前正在输入的 @token（只打了裸 @ 也算）：@ 前必须是行首或分隔符，
   避免把 xxx@yyy、邮箱之类误判成引用。返回 { start, query } 或 null。
   start = 「@」在正文里的下标；query = @ 之后已打出的片段，用来筛候选。
   names = 本节点可 @ 的候选名（标题 / 标签）。标题里本来就可能带空格（重名自动
   编号就是「文本节点 2」），所以带空格的这段只要【还是一个候选名的开头】就继续
   算正在输入（可以边打边筛）；已经打到句子上去就照旧收起菜单。 */
const REF_SEP = "\\s@，。；、！？：,.!?;:()（）\"'「」【】";
const REF_TOKEN_RE = new RegExp(
  "(^|[" + REF_SEP + "])@([^" + REF_SEP + "]*)$",
);
const REF_SEP_RE = new RegExp("^[" + REF_SEP + "]$");

/* 比对输入片段用的归一化：忽略大小写与所有空格（标题里的空格打不打都算同一串） */
function refNormKey(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");
}

function refWideTokenAt(before, names) {
  const list = Array.isArray(names) ? names : [];
  if (!list.length) return null;
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !REF_SEP_RE.test(before.charAt(at - 1))) return null;
  const q = before.slice(at + 1);
  if (!/[ \t]/.test(q)) return null;
  const k = refNormKey(q);
  if (!k) return null;
  for (const n of list) {
    if (refNormKey(n).indexOf(k) === 0) return { start: at, query: q };
  }
  return null;
}

function refTokenAt(ta, names) {
  if (!ta) return null;
  const before = String(ta.value || "").slice(0, ta.selectionStart || 0);
  const wide = refWideTokenAt(before, names);
  if (wide) return wide;
  const m = REF_TOKEN_RE.exec(before);
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] || "" };
}

function refEntryTitle(e) {
  if (!e) return "";
  return e.kind === "tag"
    ? String(e.tag || "")
    : String((e.node && e.node.title) || "");
}

/* 候选集合指纹：标题序列相同即同一批（用来决定要不要保留键盘高亮项） */
function refEntriesHash(entries) {
  return (entries || []).map((e) => refEntryTitle(e)).join("\u0001");
}

/* 按 @ 后已打出的片段筛候选：标题（或标签名）包含即命中，前缀命中排前面。
   比对忽略空格 —— 带空格的标题（「文本节点 2」）少打 / 多打一个空格也筛得出来。 */
function filterRefEntries(entries, query) {
  const q = refNormKey(query);
  if (!q) return entries;
  const pre = [];
  const rest = [];
  for (const e of entries) {
    const t = refNormKey(refEntryTitle(e));
    const hit = t.indexOf(q);
    if (hit < 0) continue;
    (hit === 0 ? pre : rest).push(e);
  }
  return pre.concat(rest);
}

function closeRefMenu() {
  if (S.refMenu) {
    const m = $("#refMenu");
    if (m) {
      m.classList.remove("slash-menu");
      m.style.display = "none";
    }
    S.refMenu = null;
  }
}

function showRefMenu(ta, node, items, query, at) {
  let entries = items
    ? items.map((n) => ({ kind: "node", node: n }))
    : refMenuEntries(node);
  entries = filterRefEntries(entries, query);
  /* 筛选后一个都不剩：收起菜单，让回车 / 上下键回到输入框原生行为 */
  if (!entries.length) {
    closeRefMenu();
    return;
  }
  closeSlashMenu();
  const menu = $("#refMenu");
  menu.classList.remove("slash-menu");
  menu.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ref-head";
  const hasTags = entries.some((e) => e.kind === "tag");
  const headT = document.createElement("span");
  headT.className = "ref-head-t";
  headT.textContent =
    node && node.batchMode === "agg"
      ? I18n.t("引用聚合条目（@条目标题）")
      : usesGlobalRefs(node) && globalRefSources(node.id).length
        ? hasTags
          ? I18n.t("全局来源需明文 @ 才注入（@标题 / @标签 · 紫色）")
          : I18n.t("全局来源需明文 @ 才注入（@标题）")
        : hasTags
          ? I18n.t("引用输入节点（@标题）或 Tag（@标签 · 紫色）")
          : I18n.t("引用输入节点（@标题）");
  const headK = document.createElement("span");
  headK.className = "ref-keys";
  headK.textContent = I18n.t("↑↓ 选择 · 回车确认 · Esc 取消");
  head.appendChild(headT);
  head.appendChild(headK);
  menu.appendChild(head);
  const list = document.createElement("div");
  list.className = "ref-list";
  entries.forEach((e, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ref-item";
    const tagEl = document.createElement("span");
    const nm = document.createElement("span");
    if (e.kind === "tag") {
      tagEl.className = "ref-tag user-tag";
      tagEl.textContent = "#";
      nm.textContent = e.tag;
    } else {
      const n = e.node;
      const imgKind =
        n.kind === "image" || n.kind === "input_image" || n.kind === "proc_image";
      tagEl.className = "ref-tag " + (imgKind ? "img" : "text");
      tagEl.textContent = imgKind ? "I" : "T";
      nm.textContent = n.title;
    }
    /* 边打边筛：把命中的片段加粗，一眼确认回车会插入哪一条 */
    const rq = String(query || "").trim().toLowerCase();
    const rTitle = refEntryTitle(e);
    const rHit = rq ? rTitle.toLowerCase().indexOf(rq) : -1;
    if (rHit >= 0) {
      nm.innerHTML =
        escapePromptHl(rTitle.slice(0, rHit)) +
        '<b class="ref-hit">' +
        escapePromptHl(rTitle.slice(rHit, rHit + rq.length)) +
        "</b>" +
        escapePromptHl(rTitle.slice(rHit + rq.length));
    }
    b.appendChild(tagEl);
    b.appendChild(nm);
    b.onmousedown = (ev) => ev.preventDefault();
    b.onclick = () => selectRefEntry(e, i);
    b.dataset.idx = String(i);
    list.appendChild(b);
  });
  menu.appendChild(list);
  /* 弹层钉在「@」那一列，不随打字右移；候选集合没变时沿用上一次的高亮项，
     否则边打字边筛时每按一键都跳回第一条，回车选到的不是用户看中的那条。 */
  const prev = S.refMenu;
  const sameSet =
    prev &&
    prev.ta === ta &&
    prev.entriesHash === refEntriesHash(entries);
  const sel = sameSet ? Math.min(prev.sel, entries.length - 1) : 0;
  const pos = caretXY(ta, typeof at === "number" ? at : undefined);
  const mw = menu.offsetWidth || 240;
  menu.style.left =
    Math.max(8, Math.min(pos.x, window.innerWidth - mw - 8)) + "px";
  menu.style.top = pos.y + 4 + "px";
  menu.style.display = "block";
  S.refMenu = {
    ta,
    node,
    entries,
    sel,
    focusable: list,
    entriesHash: refEntriesHash(entries),
  };
  paintRefSel();
}

function paintRefSel() {
  if (!S.refMenu) return;
  const menu = $("#refMenu");
  const items = menu.querySelectorAll(".ref-item");
  items.forEach((b, i) => b.classList.toggle("on", i === S.refMenu.sel));
  const cur = items[S.refMenu.sel];
  /* 键盘走到底部时把它滚进视野，否则高亮项在 240px 的滚动区外看不见 */
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}

/* 把当前正在输入的 @token 换成选中的引用：只替换这一段，正文里更早的 @引用 不动 */
function selectRefEntry(entry, i) {
  const rm = S.refMenu;
  if (!rm || !entry) return;
  const ta = rm.ta;
  const v = String(ta.value || "");
  const caret = ta.selectionStart || 0;
  const tok = refTokenAt(ta, (rm.entries || []).map(refEntryTitle));
  let at;
  if (tok) at = tok.start;
  else {
    const b = v.lastIndexOf("@", Math.max(0, caret - 1));
    at = b >= 0 ? b : caret;
  }
  const prefix = v.slice(0, at);
  const suffix = v.slice(caret);
  let token = "@" + refEntryTitle(entry);
  /* 引用后面该补空格时补一个：紧跟正文（非分隔符）不补会把标题和正文连成同一个
     @token；光标处已是文末也补一个，方便接着 @ 下一个来源。已有分隔符则不重复补。 */
  if (
    suffix === "" ||
    /^[^\s@，。；、！？：,!?;:()（）"'「」【】]/.test(suffix)
  )
    token += " ";
  ta.value = prefix + token + suffix;
  const np = prefix.length + token.length;
  ta.setSelectionRange(np, np);
  setProcPrompt(rm.node, ta.value);
  syncPromptRefBackdrop(ta, rm.node);
  ta.focus();
  closeRefMenu();
}

function selectRef(node, i) {
  selectRefEntry({ kind: "node", node }, i);
}

function refTick(ta, node) {
  const isAgg =
    (node.kind === "proc_text" ||
      node.kind === "proc_image" ||
      node.kind === "agent_task") &&
    node.batchMode === "agg" &&
    batchTitles(node);
  const items = isAgg ? aggCandidates(node) : null;
  /* 候选名一起交给 refTokenAt：标题 / 标签里带空格也能边打边筛 */
  const names = items
    ? items.map((n) => n && n.title)
    : refMenuEntries(node).map(refEntryTitle);
  const tok = refTokenAt(ta, names);
  /* 光标前没有正在输入的 @token（连裸 @ 都没打）：收起菜单 */
  if (!tok) {
    closeRefMenu();
    return;
  }
  /* 带上已打出的片段：菜单不再「一打字就关掉」，可以边打边筛再回车确认 */
  showRefMenu(ta, node, items, tok.query, tok.start);
}

/* @ 引用的键盘操作：↑↓ 选条目 · 回车 / Tab 直接确认（不用鼠标点）· Esc 收起。
   返回 true = 这次按键已被菜单消费，调用方不要再按「换行 / ▶ 运行」处理。 */
function refKey(ta, ev, node) {
  const rm = S.refMenu;
  if (!rm) return false;
  /* 输入法组词中：回车与上下键属于候选框（用来上屏），一律不截获 */
  if (ev.isComposing || ev.keyCode === 229) return false;
  const n = (rm.entries || []).length;
  if (!n) return false;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    ev.preventDefault();
    rm.sel = (rm.sel + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
    paintRefSel();
    return true;
  }
  if (ev.key === "Enter") {
    if (ev.shiftKey) return false; /* Shift+Enter 仍是正文换行 */
    /* 光标已经离开 @token（比如按了左右键）：回车交回原生行为，别硬插一条 */
    if (!refTokenAt(rm.ta)) {
      closeRefMenu();
      return false;
    }
    ev.preventDefault();
    selectRefEntry(rm.entries[rm.sel] || rm.entries[0]);
    return true;
  }
  if (ev.key === "Tab") {
    if (!refTokenAt(rm.ta)) {
      closeRefMenu();
      return false;
    }
    ev.preventDefault();
    selectRefEntry(rm.entries[rm.sel] || rm.entries[0]);
    return true;
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeRefMenu();
    return true;
  }
  return false;
}

/* 智能会话 / 助手：输入 / 或中文输入法顿号 、 呼出技能与少量斜杠命令
   （new/rename/export/permissions/help 已融入 UI，不在菜单中展示） */
const AGENT_SLASH_CMDS = [
  { name: "compact", title: "压缩上文", hint: "压缩对话上下文" },
  { name: "plan", title: "规划模式", hint: "下一轮先制定计划再执行" },
];
let _skillListCache = { at: 0, skills: [] };
let _slashTickGen = 0;

async function loadSkillsCached(force) {
  if (!force && Date.now() - _skillListCache.at < 5000) return _skillListCache.skills;
  try {
    const r = await window.api.skillList();
    _skillListCache = { at: Date.now(), skills: (r && r.skills) || [] };
  } catch {
    _skillListCache = { at: Date.now(), skills: [] };
  }
  return _skillListCache.skills;
}

async function resolveSkillByName(name) {
  const nm = String(name || "").trim();
  if (!nm || !window.api || !window.api.skillGet) return null;
  try {
    const r = await window.api.skillGet(nm);
    if (r && r.ok && r.body) return { name: r.name || nm, body: r.body };
  } catch {}
  return null;
}

function isCanvasBuildSkillName(name) {
  const n = String(name || "").toLowerCase();
  return n === "generate-workflow" || n === "generate-task";
}

function isInstallOnlySkillName(name) {
  const n = String(name || "").toLowerCase();
  return n.endsWith("-install");
}

/* 行首 /技能名 [说明]：命中已安装技能则返回包装对象，否则 null */
async function resolveSkillSlash(text, opts) {
  let t = String(text || "").trim();
  if (!t) return null;
  if (t.charAt(0) === "\u3001") t = "/" + t.slice(1);
  const m = t.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  if (opts && opts.denyCanvasSkills && isCanvasBuildSkillName(m[1])) return null;
  const skill = await resolveSkillByName(m[1]);
  if (!skill) return null;
  let title = skill.name;
  try {
    const list = await loadSkillsCached(false);
    const hit = (list || []).find((s) => s.name === skill.name);
    if (hit && hit.title) title = hit.title;
  } catch {}
  return {
    name: skill.name,
    title,
    body: skill.body,
    arg: String(m[2] || "").trim(),
    raw: t,
  };
}

function applySkillWrapToAssembled(assembled, rawUser, wrapped) {
  const src = String(assembled || "");
  const raw = String(rawUser || "").trim();
  if (raw) {
    const i = src.indexOf(raw);
    if (i >= 0) return src.slice(0, i) + wrapped + src.slice(i + raw.length);
  }
  const marker = "\n\n【内容】\n";
  const i = src.lastIndexOf(marker);
  if (i >= 0) return src.slice(0, i + marker.length) + wrapped;
  return wrapped;
}

function skillTaskPrompt(sw) {
  const extra = sw.arg
    ? sw.arg + "\n\n"
    : I18n.t("未另写说明，请按技能默认流程执行。") + "\n\n";
  return (
    I18n.t("请使用技能") +
    "「" +
    (sw.title || sw.name) +
    "」。\n" +
    extra +
    I18n.t("—— 技能说明书（必须遵循）——") +
    "\n" +
    sw.body
  );
}

/* 行首 / 或中文输入法把 / 打成的 、 均可呼出；query 可含中文以按标题筛选 */
function slashToken(ta) {
  if (!ta) return null;
  const v = String(ta.value || "");
  const caret = ta.selectionStart || 0;
  const before = v.slice(0, caret);
  const m = before.match(/(^|\n)([\/\u3001])([^\s]*)$/);
  if (!m) return null;
  return {
    start: caret - (m[3] || "").length - 1,
    query: String(m[3] || "").toLowerCase(),
    trigger: m[2],
  };
}

function slashItemMatch(it, q) {
  if (!q) return true;
  const hay = [it.name, it.title, it.hint, it.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.indexOf(q) >= 0;
}

function closeSlashMenu() {
  if (!S.slashMenu) return;
  const m = $("#refMenu");
  if (m) {
    m.classList.remove("slash-menu");
    if (!S.refMenu) m.style.display = "none";
  }
  S.slashMenu = null;
}

function paintSlashSel() {
  if (!S.slashMenu) return;
  const menu = $("#refMenu");
  menu
    .querySelectorAll(".ref-item")
    .forEach((b, i) => b.classList.toggle("on", i === S.slashMenu.sel));
}

function selectSlashItem(item) {
  const sm = S.slashMenu;
  if (!sm || !sm.ta || !item) return;
  const ta = sm.ta;
  const tok = slashToken(ta);
  if (!tok) {
    closeSlashMenu();
    return;
  }
  const v = ta.value;
  const caret = ta.selectionStart || 0;
  const prefix = v.slice(0, tok.start);
  const suffix = v.slice(caret);
  const insert = "/" + item.name + " ";
  ta.value = prefix + insert + suffix;
  const np = prefix.length + insert.length;
  ta.setSelectionRange(np, np);
  ta.focus();
  if (typeof sm.onChange === "function") sm.onChange(ta.value);
  closeSlashMenu();
}

function showSlashMenu(ta, items, scope, onChange) {
  const menu = $("#refMenu");
  if (!menu) return;
  closeRefMenu();
  menu.classList.add("slash-menu");
  menu.innerHTML = "";
  const list = document.createElement("div");
  list.className = "ref-list";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "ref-item slash-item";
    empty.style.cursor = "default";
    empty.textContent = I18n.t("暂无匹配的命令或技能");
    list.appendChild(empty);
  } else {
    items.forEach((it, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ref-item slash-item";
      const title = document.createElement("span");
      title.className = "slash-title";
      title.textContent = it.title || it.name;
      const cmd = document.createElement("span");
      cmd.className = "slash-cmd";
      cmd.textContent = "/" + it.name;
      b.appendChild(title);
      b.appendChild(cmd);
      const hintText = I18n.t(it.hint || "") || it.hint || "";
      if (hintText && hintText !== title.textContent) {
        const hint = document.createElement("span");
        hint.className = "slash-hint";
        hint.textContent = hintText;
        b.appendChild(hint);
      }
      b.onmousedown = (ev) => ev.preventDefault();
      b.onclick = () => selectSlashItem(it);
      b.dataset.idx = String(i);
      list.appendChild(b);
    });
  }
  menu.appendChild(list);
  const pos = caretXY(ta);
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.display = "block";
  const mw = menu.offsetWidth || 260;
  const mh = menu.offsetHeight || 40;
  const pad = 8;
  let left = Math.max(pad, Math.min(pos.x, window.innerWidth - mw - pad));
  let top = pos.y - mh - 4;
  if (top < pad) top = pad;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  S.slashMenu = {
    ta,
    items,
    sel: 0,
    focusable: list,
    scope: scope || "agent",
    onChange: typeof onChange === "function" ? onChange : null,
  };
  paintSlashSel();
}

async function slashTick(ta, scope, onChange) {
  const gen = ++_slashTickGen;
  const tok = slashToken(ta);
  if (!tok) {
    closeSlashMenu();
    return;
  }
  const skills = await loadSkillsCached(false);
  if (gen !== _slashTickGen) return;
  const q = tok.query;
  const sk = (skills || [])
    .filter((s) => !isInstallOnlySkillName(s && s.name))
    .filter((s) => scope !== "node" || !isCanvasBuildSkillName(s && s.name))
    .map((s) => ({
      name: s.name,
      title: s.title || s.name,
      hint: s.description || "",
      description: s.description || "",
      kind: "skill",
      builtin: !!s.builtin,
    }))
    .filter((s) => slashItemMatch(s, q))
    .sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return String(a.title || a.name).localeCompare(
        String(b.title || b.name),
        "zh",
      );
    });
  const cmds =
    scope === "assist" || scope === "node"
      ? []
      : AGENT_SLASH_CMDS.filter((c) =>
          slashItemMatch(
            { name: c.name, title: c.title, hint: c.hint },
            q,
          ),
        ).map((c) => ({
          name: c.name,
          title: c.title || c.name,
          hint: c.hint,
          kind: "cmd",
          builtin: false,
        }));
  /* 内置/植入技能优先，命令靠后 */
  showSlashMenu(ta, sk.concat(cmds), scope, onChange);
}

function slashKey(ta, ev) {
  if (!S.slashMenu) return false;
  const sm = S.slashMenu;
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    if (sm.items && sm.items.length)
      sm.sel = (sm.sel + 1) % sm.items.length;
    paintSlashSel();
    return true;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    if (sm.items && sm.items.length)
      sm.sel = (sm.sel - 1 + sm.items.length) % sm.items.length;
    paintSlashSel();
    return true;
  }
  if (ev.key === "Enter" || ev.key === "Tab") {
    ev.preventDefault();
    if (sm.items && sm.items[sm.sel]) selectSlashItem(sm.items[sm.sel]);
    return true;
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeSlashMenu();
    return true;
  }
  return false;
}

/* ============ 拖拽交互（平移 / 节点 / 缩放 / 连线） ============ */

function startNodeDrag(ev, node, opts) {
  if (S.drag) return;
  S.selWire = null;
  const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
  if (!multi) S.selGroup = null;
  const already = S.selSet.has(node.id);
  /* 点击前是否处于浏览态：首次点选会切到编辑态，重绘后需把光标送回主输入框 */
  const wasBrowse = nodeBrowseMode(node);
  if (multi) {
    /* Shift/Ctrl+点击：切换该节点的多选状态；保留已选绘制 */
    if (already) {
      S.selSet.delete(node.id);
      S.sel = S.selSet.size ? [...S.selSet][S.selSet.size - 1] : null;
      renderCanvas();
      return;
    }
    S.selSet.add(node.id);
    S.sel = node.id;
    if (wasBrowse) markFormFocusAfterRender(node);
    renderCanvas();
  } else if (!already) {
    S.selSet = new Set([node.id]);
    S.sel = node.id;
    S.selMark = null;
    if (S.selMarkSet) S.selMarkSet.clear();
    if (wasBrowse) markFormFocusAfterRender(node);
    renderCanvas();
  }
  /* 点选节点 → 相关的关系线立刻亮起（含再次点同一个节点、只改选中态不重绘的场合） */
  refreshRelWireStates();
  S.preDragSnap = snapshotState();
  const orig = {};
  const origWorld = {};
  let dragIds = expandBoundPairIds([...S.selSet]);
  const openSupers = new Set(
    dragIds.filter((id) => {
      const s = nodeById(id);
      return s && s.kind === "super" && s.superOpen;
    }),
  );
  if (openSupers.size) {
    dragIds = dragIds.filter((id) => {
      const n = nodeById(id);
      if (!n) return false;
      const ps = nodeParentSuperId(n);
      return !ps || !openSupers.has(ps);
    });
  }
  for (const id of dragIds) {
    const n = nodeById(id);
    if (n) {
      orig[id] = { x: n.x, y: n.y };
      const wp = nodeWorldPos(n);
      origWorld[id] = { x: wp.x, y: wp.y };
    }
  }
  const origMarks = {};
  const markIds = [];
  const mset = ensureSelMarkSet();
  for (const id of mset) {
    const mk = markById(id);
    if (!mk) continue;
    markIds.push(id);
    origMarks[id] = { x: mk.x, y: mk.y, w: mk.w, h: mk.h };
  }
  S.drag = {
    mode: "node",
    ids: dragIds,
    orig,
    origWorld,
    curWorld: {},
    hadNested: dragIds.some((id) => {
      const n = nodeById(id);
      return !!(n && nodeIsNestedInOpenSuper(n));
    }),
    markIds,
    origMarks,
    sx: ev.clientX,
    sy: ev.clientY,
    moved: false,
    fromHandle: !!(opts && opts.fromHandle),
    handleNid: node.id,
  };
  /* 拖拽节点期间提升连线 SVG 层级：连线不被拖起的节点遮挡 */
  setNodeDragLift(true);
}
/* 拖拽节点期间提升 / 拖拽结束后恢复连线 SVG 层级（节点拖起 z40、超节点提升 z55，均压在连线之上） */
function setNodeDragLift(on) {
  const c = $("#canvas");
  if (c) c.classList.toggle("node-drag-active", !!on);
}
/* 连线落点放大命中：在端子中心 1.5×半径（至少 6px 屏幕）内都算命中，
   elementFromPoint 命中不到时按最近端子兜底，解决端子小、难以精准连中的问题 */
const PORT_HIT_FACTOR = 1.5;
function portHitAt(x, y, sel) {
  let best = null;
  let bestD = Infinity;
  const z = S.cam.z > 0 ? S.cam.z : 1;
  const tol = Math.max(6, PORT_R * PORT_HIT_FACTOR * z);
  for (const p of document.querySelectorAll(sel)) {
    const r = p.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= tol && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}
function startWireDrag(fromId, ev, fromIndex, opts) {
  opts = opts || {};
  S.drag = {
    mode: "wire",
    fromId,
    fromIndex: fromIndex || 0,
    sx: ev.clientX,
    sy: ev.clientY,
    mx: ev.clientX,
    my: ev.clientY,
    /* 是否真的拖出去过：只在端子上原地点一下不算，避免点输出端子就弹新建菜单 */
    moved: false,
    superInnerBridge: !!opts.superInnerBridge,
    /* 反向拖线：从输入端开始拖向输出端（fromId 是输入侧节点，fromIndex 是其输入序号） */
    fromInput: !!opts.fromInput,
  };
  updateWires();
}
/* 拖线位移阈值（屏幕像素）：超过它才认为用户是「向外拉」而非点端子 */
const WIRE_DRAG_MOVED_PX = 6;
function wireDragMoved(d, ev) {
  return !!(
    d &&
    (Math.abs(ev.clientX - d.sx) > WIRE_DRAG_MOVED_PX ||
      Math.abs(ev.clientY - d.sy) > WIRE_DRAG_MOVED_PX)
  );
}
/** 拖拽中按世界坐标刷新节点 DOM；内部节点提升到主舞台以免被 overflow 裁切 */
function applyNodeDragVisual(d, dx, dy) {
  if (!d || d.mode !== "node") return;
  const stage = $("#stage");
  if (!d.curWorld) d.curWorld = {};
  for (const id of d.ids || []) {
    const n = nodeById(id);
    const ow = d.origWorld && d.origWorld[id];
    const o = d.orig && d.orig[id];
    if (!n || !ow) continue;
    const wx = snap(ow.x + dx);
    const wy = snap(ow.y + dy);
    d.curWorld[id] = { x: wx, y: wy };
    const nestedShell = nodeIsNestedInOpenSuper(n);
    if (!nestedShell && o) {
      n.x = snap(o.x + dx);
      n.y = snap(o.y + dy);
    }
    let el = document.querySelector('.wf-node[data-nid="' + id + '"]');
    if (!el) continue;
    /* 拖拽中的“惯性倾斜”：按移动速度做仿射变换（轻微旋转+放大），
       方向跟随鼠标移动方向，形成卡片被拖拽的惯性感（替代原先的规则摇晃动画） */
    if (!el.classList.contains("node-dragging"))
      el.classList.add("node-dragging");
    const zz = S.cam.z > 0 ? S.cam.z : 1;
    const vx = d._pdx == null ? 0 : (dx - d._pdx) * zz;
    d._pdx = dx;
    d._pdy = dy;
    const rot = Math.max(-7, Math.min(7, vx * 0.22));
    el.style.transform =
      "rotate(" + rot.toFixed(2) + "deg) scale(1.03)";
    if (nestedShell && stage && el.parentElement !== stage) {
      stage.appendChild(el);
      el.classList.add("super-drag-lift");
      el.style.zIndex = "55";
    }
    el.style.left = (nestedShell ? wx : n.x) + "px";
    el.style.top = (nestedShell ? wy : n.y) + "px";
  }
}
/* 清理悬空的拖拽状态：窗口移动/失焦等会吞掉 mouseup，导致 S.drag / boxSel 残留，
   后续随机的 mousemove/mouseup 会误处理陈旧状态（偶发 remove 类报错） */
function cancelDrag() {
  const box = document.getElementById("boxSel");
  if (box) box.remove();
  S.drag = null;
  setNodeDragLift(false);
  document
    .querySelectorAll(".wf-node.node-dragging")
    .forEach((el) => {
      el.classList.remove("node-dragging");
      el.style.transform = "";
    });
  S.preDragSnap = null;
  clearSuperDropHot(false);
  setCanvasPanning(false);
  const c = $("#canvas");
  if (c) c.classList.remove("midpan");
}

/* ============ 组（虚线圆角框）与框选 ============ */

function groupById(gid) {
  return (S.wf.groups || []).find((g) => g.id === gid) || null;
}
function ensureGroupArrays(g) {
  if (!g) return g;
  if (!Array.isArray(g.nodeIds)) g.nodeIds = [];
  if (!Array.isArray(g.markIds)) g.markIds = [];
  return g;
}
function groupIsEmpty(g) {
  if (!g) return true;
  ensureGroupArrays(g);
  return !g.nodeIds.length && !g.markIds.length;
}
function pruneEmptyGroups() {
  S.wf.groups = (S.wf.groups || []).filter((g) => !groupIsEmpty(g));
}
/* 文字标注的 DOM 位置同步（绘制只剩 text：框体 / 箭头已移除，归类节点请用「组」） */
function syncMarkDomPos(m) {
  if (!m) return;
  const el = document.querySelector('.wf-mark[data-mid="' + m.id + '"]');
  if (!el) return;
  el.style.left = m.x + "px";
  el.style.top = m.y + "px";
  if (m.w) el.style.width = m.w + "px";
  if (m.h) el.style.height = m.h + "px";
}
/* 组边框矩形：仅计入当前画布可见成员，避免其它任务层坐标把外框撑得过大 */
function groupBounds(g) {
  ensureGroupArrays(g);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let any = false;
  const include = (x, y, w, h) => {
    x = Number(x);
    y = Number(y);
    w = Number(w);
    h = Number(h);
    if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) return;
    any = true;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (!n || !nodeInCurrentScope(n)) continue;
    const p = nodeWorldPos(n);
    const sz = nodeDrawSize(n);
    include(p.x, p.y, sz.w, sz.h);
  }
  for (const id of g.markIds) {
    const m = markById(id);
    if (!m || !markInCurrentScope(m)) continue;
    const b = markBounds(m);
    if (!b) continue;
    include(b.x, b.y, b.w, b.h);
  }
  if (!any) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
const GROUP_PAD = 16;
/* 组边框由 groupBounds（成员真实几何）+ updateGroupFrames 自动撑合，
   不再需要「组内框体收紧」一族逻辑（绘制的框体 / 箭头已移除，归类节点只用组）。 */
/* 同步所有组框的 DOM 位置（节点拖拽 / 缩放后调用） */
function updateGroupFrames() {
  for (const g of S.wf.groups || []) {
    const el = document.querySelector('.wf-group[data-gid="' + g.id + '"]');
    if (!el) continue;
    const b = groupBounds(g);
    if (!b) {
      el.style.display = "none";
      continue;
    }
    el.style.display = "";
    const pad = GROUP_PAD;
    el.style.left = b.x - pad + "px";
    el.style.top = b.y - pad + "px";
    el.style.width = b.w + pad * 2 + "px";
    el.style.height = b.h + pad * 2 + "px";
  }
}
/* 组框元素：虚线圆角边框 + 标题（可双击改名）+ ✕ 删除 + 右下缩放把手 */
function groupElement(g) {
  const el = document.createElement("div");
  el.className = "wf-group" + (S.selGroup === g.id ? " sel" : "");
  el.dataset.gid = g.id;
  const head = document.createElement("div");
  head.className = "wg-title";
  head.textContent = g.title || I18n.t("组");
  head.title = I18n.t("拖动移动组 · 双击重命名");
  head.onmousedown = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupDrag(g, ev);
  };
  head.onclick = (ev) => {
    ev.stopPropagation();
    selectGroup(g.id);
  };
  head.ondblclick = (ev) => {
    ev.stopPropagation();
    startGroupTitleEdit(g, head);
  };
  el.appendChild(head);
  const del = document.createElement("button");
  del.className = "wg-del";
  del.textContent = "✕";
  del.title = I18n.t("删除该组（连同内部节点与绘制）");
  del.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
  });
  del.onclick = (ev) => {
    ev.stopPropagation();
    deleteGroup(g.id);
  };
  el.appendChild(del);
  const rzX = document.createElement("div");
  rzX.className = "wg-resize wg-resize-x";
  rzX.title = I18n.t("横向缩放（仅改变横向布局，纵向不变）");
  rzX.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupResize(g, ev, "x");
  });
  el.appendChild(rzX);
  const rzY = document.createElement("div");
  rzY.className = "wg-resize wg-resize-y";
  rzY.title = I18n.t("纵向缩放（仅改变纵向布局，横向不变）");
  rzY.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupResize(g, ev, "y");
  });
  el.appendChild(rzY);
  const rz = document.createElement("div");
  rz.className = "wg-resize";
  rz.title = I18n.t("整体缩放（横竖可分别拉伸；成员达到最小尺寸后停止缩放）");
  rz.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupResize(g, ev, "both");
  });
  el.appendChild(rz);
  el.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    startGroupDrag(g, ev);
  });
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectGroup(g.id);
    showCtx(ev.clientX, ev.clientY, [
      [
        I18n.t("组操作"),
        [
          {
            label: I18n.t("✕ 删除组（连同内部节点与绘制）"),
            iconKey: "menu_delete",
            iconCls: "danger",
            cls: "ctx-danger",
            run: () => deleteGroup(g.id),
          },
          {
            label: I18n.t("解散组（保留节点与绘制）"),
            iconKey: "menu_ungroup",
            iconCls: "group",
            run: () => disbandGroup(g.id),
          },
        ],
      ],
    ]);
  });
  return el;
}
function selectGroup(gid) {
  /* 选中组时保留已选节点：可「节点 + 组」同时选中，用于把节点加入组 */
  S.selWire = null;
  S.selGroup = gid;
  renderCanvas();
}
/* 组缩放（横竖独立）：以锚点 (ax, ay)（组左上角，拖拽时固定）为基准，
   每次按「拖拽起始时的成员原始几何」重算 → 组的右下角严格跟随鼠标指针，不累积漂移。
   系数先按成员原始最小尺寸钳制：任一成员达到最小宽/高后，外部整体不再继续缩放（不崩坏） */
function clampGroupScale(g, sx, sy, orig, origMarks) {
  ensureGroupArrays(g);
  let minSx = 0.3,
    minSy = 0.3;
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (!n) continue;
    const o = orig && orig[id];
    const mw = Math.max(minWFor(n), Number(n._chromeMinW) || 0);
    minSx = Math.max(minSx, mw / (o ? o.w : n.w));
    minSy = Math.max(minSy, minHFor(n) / (o ? o.h : n.h));
  }
  for (const id of g.markIds) {
    const m = markById(id);
    if (!m) continue;
    const o = origMarks && origMarks[id];
    const ow = o ? o.w : m.w || 40;
    const oh = o ? o.h : m.h || 40;
    minSx = Math.max(minSx, 40 / ow);
    minSy = Math.max(minSy, 24 / oh);
  }
  sx = Math.max(0.3, Math.min(3, sx));
  sy = Math.max(0.3, Math.min(3, sy));
  return { sx: Math.max(sx, minSx), sy: Math.max(sy, minSy) };
}
function scaleGroup(g, sx, sy, ax, ay, orig, origMarks) {
  ensureGroupArrays(g);
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (!n) continue;
    const o = orig && orig[id];
    if (!o) continue;
    n.x = ax + (o.x - ax) * sx;
    n.y = ay + (o.y - ay) * sy;
    n.w = Math.round(o.w * sx);
    n.h = Math.round(o.h * sy);
    const el = document.querySelector('.wf-node[data-nid="' + id + '"]');
    if (el) {
      el.style.left = n.x + "px";
      el.style.top = n.y + "px";
      el.style.width = n.w + "px";
      el.style.height = n.h + "px";
      refreshPorts(el, n);
    }
  }
  for (const id of g.markIds) {
    const m = markById(id);
    const o = origMarks && origMarks[id];
    if (!m || !o) continue;
    m.x = ax + (o.x - ax) * sx;
    m.y = ay + (o.y - ay) * sy;
    m.w = Math.max(40, Math.round((o.w || m.w) * sx));
    m.h = Math.max(24, Math.round((o.h || m.h) * sy));
    syncMarkDomPos(m);
  }
}
function startGroupDrag(g, ev) {
  if (S.drag) return;
  ensureGroupArrays(g);
  S.preDragSnap = snapshotState();
  selectGroup(g.id);
  const orig = {};
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (n) orig[id] = { x: n.x, y: n.y };
  }
  const origMarks = {};
  for (const id of g.markIds) {
    const m = markById(id);
    if (m) origMarks[id] = { x: m.x, y: m.y, w: m.w, h: m.h };
  }
  S.drag = {
    mode: "group",
    gid: g.id,
    orig,
    origMarks,
    sx: ev.clientX,
    sy: ev.clientY,
    moved: false,
  };
}
/* axes: "x"（右边缘把手·仅横向）| "y"（下边缘把手·仅纵向）| "both"（右下角把手） */
function startGroupResize(g, ev, axes) {
  if (S.drag) return;
  ensureGroupArrays(g);
  const b = groupBounds(g);
  if (!b) return;
  S.preDragSnap = snapshotState();
  selectGroup(g.id);
  const orig = {};
  for (const id of g.nodeIds) {
    const n = nodeById(id);
    if (n) orig[id] = { x: n.x, y: n.y, w: n.w, h: n.h };
  }
  const origMarks = {};
  for (const id of g.markIds) {
    const m = markById(id);
    if (m) origMarks[id] = { x: m.x, y: m.y, w: m.w, h: m.h };
  }
  S.drag = {
    mode: "groupresize",
    gid: g.id,
    sx: ev.clientX,
    sy: ev.clientY,
    w0: b.w,
    h0: b.h,
    ax: b.x,
    ay: b.y,
    orig,
    origMarks,
    axes: axes || "both",
    moved: false,
  };
}
function startGroupTitleEdit(g, headEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "wg-title-input";
  input.value = g.title || I18n.t("组");
  input.title = I18n.t("回车确认 · Esc 取消");
  headEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== g.title) {
      pushHistory();
      g.title = v;
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
/* 「组」按钮 / 快捷键 G：有组选中 → 解散；有节点/绘制选中 → 创建组 */
/* 把选中节点/绘制加入指定组（从其它组移出，避免重复归属） */
function addMembersToGroup(gid, nodes, marks) {
  const g = groupById(gid);
  if (!g) return;
  ensureGroupArrays(g);
  nodes = nodes || [];
  marks = marks || [];
  if (!nodes.length && !marks.length) return;
  const addedN = [];
  const addedM = [];
  for (const n of nodes) {
    if (g.nodeIds.includes(n.id)) continue;
    for (const og of S.wf.groups || []) {
      if (og.id === gid) continue;
      ensureGroupArrays(og);
      og.nodeIds = og.nodeIds.filter((id) => id !== n.id);
    }
    addedN.push(n.id);
  }
  for (const m of marks) {
    if (g.markIds.includes(m.id)) continue;
    for (const og of S.wf.groups || []) {
      if (og.id === gid) continue;
      ensureGroupArrays(og);
      og.markIds = og.markIds.filter((id) => id !== m.id);
    }
    addedM.push(m.id);
  }
  if (!addedN.length && !addedM.length) {
    toast(I18n.t("所选内容已在该组中"), "warn");
    return;
  }
  pushHistory();
  g.nodeIds.push(...addedN);
  g.markIds.push(...addedM);
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  const parts = [];
  if (addedN.length)
    parts.push(I18n.t("{n} 个节点", { n: addedN.length }));
  if (addedM.length)
    parts.push(I18n.t("{n} 个绘制", { n: addedM.length }));
  toast(
    I18n.t("已将 {parts} 加入组「{title}」", {
      parts: parts.join(I18n.getLocale() === "en" ? ", " : "、"),
      title: g.title || I18n.t("组"),
    }),
    "ok",
  );
}
function addNodesToGroup(gid, nodes) {
  addMembersToGroup(gid, nodes, []);
}
/* 把节点/绘制移出组（空组自动删除） */
function removeMembersFromGroup(gid, nodeIds, markIds) {
  const g = groupById(gid);
  if (!g) return;
  ensureGroupArrays(g);
  nodeIds = nodeIds || [];
  markIds = markIds || [];
  if (!nodeIds.length && !markIds.length) return;
  const nset = new Set(nodeIds);
  const mset = new Set(markIds);
  pushHistory();
  g.nodeIds = g.nodeIds.filter((id) => !nset.has(id));
  g.markIds = g.markIds.filter((id) => !mset.has(id));
  if (groupIsEmpty(g))
    S.wf.groups = S.wf.groups.filter((x) => x.id !== gid);
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(
    I18n.t("已将 {n} 项移出组", { n: nodeIds.length + markIds.length }),
    "ok",
  );
}
function removeNodesFromGroup(gid, ids) {
  removeMembersFromGroup(gid, ids, []);
}
function toggleGroupAction() {
  const ns = selNodes();
  const ms = selectedMarks();
  /* 场景1：选中了「组」→ 有选中成员则加入该组，否则解散 */
  if (S.selGroup) {
    if (ns.length || ms.length) addMembersToGroup(S.selGroup, ns, ms);
    else disbandGroup(S.selGroup);
    return;
  }
  if (!ns.length && !ms.length) {
    toast(I18n.t("请先框选 / 选中节点或绘制，或选中一个组"), "warn");
    return;
  }
  /* 场景2：所选成员都在同一个组内 → 脱离该组 */
  const groupsOfSel = new Map();
  for (const n of ns) {
    const g = (S.wf.groups || []).find((x) => {
      ensureGroupArrays(x);
      return x.nodeIds.includes(n.id);
    });
    if (g) groupsOfSel.set("n:" + n.id, g.id);
  }
  for (const m of ms) {
    const g = (S.wf.groups || []).find((x) => {
      ensureGroupArrays(x);
      return x.markIds.includes(m.id);
    });
    if (g) groupsOfSel.set("m:" + m.id, g.id);
  }
  const total = ns.length + ms.length;
  const allInSameGroup =
    groupsOfSel.size === total &&
    new Set(groupsOfSel.values()).size === 1;
  if (allInSameGroup) {
    const gid = [...groupsOfSel.values()][0];
    removeMembersFromGroup(
      gid,
      ns.map((n) => n.id),
      ms.map((m) => m.id),
    );
    return;
  }
  /* 场景3：创建新组（排除已在组内的成员） */
  const nodeIds = ns
    .filter((n) => !groupsOfSel.has("n:" + n.id))
    .map((n) => n.id);
  const markIds = ms
    .filter((m) => !groupsOfSel.has("m:" + m.id))
    .map((m) => m.id);
  if (!nodeIds.length && !markIds.length) {
    toast(I18n.t("所选内容分属多个组，请先单独选择同一组内的成员"), "warn");
    return;
  }
  promptGroupTitle(nodeIds, markIds);
}
function promptGroupTitle(nodeIds, markIds) {
  nodeIds = nodeIds || [];
  markIds = markIds || [];
  openOverlay(I18n.t("创建组"), { persistent: true });
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  const count = nodeIds.length + markIds.length;
  hint.innerHTML =
    I18n.t("将选中的 <b>") +
    count +
    I18n.t("</b> 个成员（节点 / 绘制）组成一个组（快捷键 G）。组标题仅用于显示；点击组框可整体移动 / 缩放 / 删除。");
  body.appendChild(hint);
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("组标题")));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = I18n.t("组 1");
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("创建");
  ok.onclick = () => {
    closeOverlay();
    const t = inp.value.trim();
    pushHistory();
    S.wf.groups.push({
      id: uid("g"),
      title: t || I18n.t("组"),
      nodeIds: nodeIds.slice(),
      markIds: markIds.slice(),
    });
    S.selGroup = S.wf.groups[S.wf.groups.length - 1].id;
    S.sel = null;
    S.selWire = null;
    S.selSet.clear();
    if (S.selMarkSet) S.selMarkSet.clear();
    S.selMark = null;
    renderCanvas();
    scheduleSave(true);
    renderStatus();
    toast(I18n.t("已创建组：") + (t || I18n.t("组")), "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
}
/* 解散组：删除组框，节点与绘制全部保留 */
function disbandGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  pushHistory();
  S.wf.groups = S.wf.groups.filter((x) => x.id !== gid);
  if (S.selGroup === gid) S.selGroup = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(I18n.t("已解散组（节点与绘制保留）"), "ok");
}
/* 删除组：连同内部节点、绘制与相关连线一起删除 */
function deleteGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  ensureGroupArrays(g);
  const n = g.nodeIds.length;
  const m = g.markIds.length;
  const markIds = g.markIds.slice();
  const nodeIds = g.nodeIds.slice();
  pushHistory();
  /* 先摘掉组，避免 deleteNodes 因仅剩绘制而误删/误留 */
  S.wf.groups = (S.wf.groups || []).filter((x) => x.id !== gid);
  if (S.selGroup === gid) S.selGroup = null;
  if (nodeIds.length) deleteNodes(nodeIds, true);
  if (markIds.length) deleteMarks(markIds, true);
  renderCanvas();
  scheduleSave(true);
  toast(
    I18n.t("已删除组（含 {n} 个节点{marks}）", {
      n,
      marks: m ? I18n.t("、{m} 个绘制", { m }) : "",
    }),
    "ok",
  );
}
/* 批量删除节点：同时清理相关连线与组；超级节点递归移除全部后代与内部绘制 */
async function deleteNodes(ids, quiet) {
  if (!ids || !ids.length) return;
  let expanded = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of S.wf.nodes || []) {
      if (expanded.has(n.id)) continue;
      if (n.parentTaskId && expanded.has(n.parentTaskId)) {
        expanded.add(n.id);
        grew = true;
        continue;
      }
      if (n.parentSuperId && expanded.has(n.parentSuperId)) {
        expanded.add(n.id);
        grew = true;
      }
    }
  }
  const blocked = [];
  const finalIds = [];
  for (const id of expanded) {
    const n = nodeById(id);
    if (!n) continue;
    if (isPinnedCtrl(n) && !(n.parentTaskId && expanded.has(n.parentTaskId))) {
      blocked.push(n);
      continue;
    }
    finalIds.push(id);
  }
  if (blocked.length && !finalIds.length) {
    if (!quiet) toast(I18n.t("固定节点无法删除（起点 / 终点）"), "warn");
    return false;
  }
  if (blocked.length && !quiet)
    toast(I18n.t("已跳过固定节点（起点 / 终点）"), "warn");
  ids = finalIds;
  if (!ids.length) return false;
  /* 数据库节点删除联动：其副本节点一并删除 */
  for (const n of S.wf.nodes) {
    if (
      n &&
      n.kind === "db_replica" &&
      n.dbNodeId &&
      ids.includes(n.dbNodeId) &&
      !ids.includes(n.id)
    ) {
      ids.push(n.id);
    }
  }
  /* 网络接收节点删除：停止监听并释放端口引用 */
  for (const id of ids) {
    const n = nodeById(id);
    if (n && n.kind === "net_recv") netUnsubRecv(n);
  }
  /* 智能任务 / 开发节点删除联动:其关联的智能会话一并删除(先提示确认) */
  const delSet = new Set(ids);
  const linkedSessions = [];
  for (const n of S.wf.nodes) {
    if (!delSet.has(n.id)) continue;
    let sessIds = [];
    if (n.kind === "agent_task" && n.agentSessionId) sessIds = [n.agentSessionId];
    else if (n.kind === "super" && n.dev) sessIds = devSessionIdsOf(n);
    for (const sid of sessIds) {
      const sess = agentSessions().find((s) => s.id === sid);
      if (sess && !linkedSessions.includes(sess)) linkedSessions.push(sess);
    }
  }
  if (linkedSessions.length) {
    if (!quiet) {
      const names = I18n.listJoin(linkedSessions.map((s) => s.title || I18n.t("新会话")));
      if (
        !(await confirmDialog(
          I18n.t("删除节点将一并删除其关联的智能会话：\n") +
            names +
            I18n.t("\n\n会话记录不可恢复，确定删除？"),
          { title: I18n.t("确认删除"), danger: true, okText: I18n.t("删除") },
        ))
      )
        return false;
    }
    const list = agentSessions();
    for (const s of linkedSessions) {
      const i = list.indexOf(s);
      if (i >= 0) list.splice(i, 1);
    }
    if (linkedSessions.some((s) => s.id === activeAgentId()))
      S.agentActiveId = (list[0] && list[0].id) || "";
    persistAgentSession().catch(() => {});
    renderAgentSessionSidebar();
    renderAgentSession();
  }
  if (!quiet) pushHistory();
  const set = new Set(ids);
  if (S.taskFocus && set.has(S.taskFocus)) {
    const cur = nodeById(S.taskFocus);
    const up = cur && cur.parentTaskId && !set.has(cur.parentTaskId)
      ? cur.parentTaskId
      : "";
    setTaskFocus(up, { render: false });
  }
  if (S.superFocus && set.has(S.superFocus)) {
    let pid = "";
    const cur = nodeById(S.superFocus);
    pid = (cur && cur.parentSuperId) || "";
    while (pid && set.has(pid)) {
      const p = nodeById(pid);
      pid = (p && p.parentSuperId) || "";
    }
    if (pid && nodeById(pid)) setSuperFocus(pid, { render: false });
    else resetSuperFocus();
  }
  for (const n of S.wf.nodes) {
    if (!n.parentTaskId || !set.has(n.parentTaskId) || set.has(n.id)) continue;
    const p = nodeById(n.parentTaskId);
    n.parentTaskId = (p && p.parentTaskId) || "";
  }
  /* 函数 / 工具节点删除即回收：它们在主进程独立线程里的运行、以及由此拉起的外部进程，
     不能因为节点对象从画布上消失就变成没人管的孤儿（进程还活着、锁还没释放）。
     ids 上面已展开成「含全部后代」，所以停外壳就等于连内部图一起停。
     取消后运行体自己 await 到「已手动停止」并收尾（清 running、释放并发槽位）。 */
  const delStopped = [];
  for (const id of ids) {
    const n = nodeById(id);
    if (!n) continue;
    if (
      isComputeExecKind(n) &&
      (n.running ||
        (typeof computeExecNodeActive === "function"
          ? computeExecNodeActive(n)
          : typeof fnHasLiveRun === "function" && fnHasLiveRun(n)))
    ) {
      bumpNodeStop(n);
      delStopped.push(n);
    }
  }
  if (delStopped.length) {
    let procs = 0;
    const rs = await Promise.all(
      delStopped.map((n) =>
        Promise.resolve(fnCancelRunsOf(n)).catch(() => null),
      ),
    );
    for (const r of rs) if (r && r.procs) procs += Number(r.procs) || 0;
    if (procs && !quiet)
      toast(I18n.t("已回收 ") + procs + I18n.t(" 个进程"), "warn");
  }
  /* 内部绘制随超级节点一并移除 */
  const markDel = (S.wf.marks || [])
    .filter((m) => {
      const sid = markParentSuperId(m);
      return sid && set.has(sid);
    })
    .map((m) => m.id);
  if (markDel.length) deleteMarks(markDel, true);
  S.wf.nodes = S.wf.nodes.filter((n) => !set.has(n.id));
  /* 删掉的节点里若有设置窗正在绑着的那个：窗必须一起关（它写的是孤儿对象），
     并明确告知用户窗为什么不见了。后面的 renderCanvas / scheduleSave 由本函数收尾。 */
  closeNodeSettingsDialogIfStale({
    silentRerender: true,
    skipSave: true,
    quiet: !!quiet,
  });
  S.wf.wires = S.wf.wires.filter(
    (w) => !set.has(w.from) && !set.has(w.to),
  );
  for (const id of ids) {
    stopMediaBackendProbe(id);
    stopMediaBackendRunWatcher(id);
  }
  for (const g of S.wf.groups || []) {
    ensureGroupArrays(g);
    g.nodeIds = g.nodeIds.filter((id) => !set.has(id));
  }
  pruneEmptyGroups();
  for (const id of ids) if (S.thinking && S.thinking[id]) S.thinking[id] = [];
  if (ids.includes(S.sel)) S.sel = null;
  for (const id of ids) if (S.selSet) S.selSet.delete(id);
  S.selGroup = null;
  if (!quiet) {
    renderCanvas();
    if (S.sidebarOpen) renderSidebar();
    scheduleSave(true);
    renderStatus();
    toast(I18n.t("已删除 ") + ids.length + I18n.t(" 个节点"), "ok");
  }
  return true;
}
/* 批量复制选中节点（含全部后代与内部内容；整体错开一格网格）。
   保持两端都在复制集内的连线；标题保持原名（不加「副本」）；
   相对路径的保存节点不复制保存目标（复制后需重新指定）；
   图像节点相对路径固化为绝对路径，复制品正确引用同一图像。 */
function duplicateNodes(nodes) {
  if (!nodes || !nodes.length) return;
  const srcs = collectWithDescendants(nodes);
  const { cps, idMap } = cloneNodesDeep(srcs, { keepOrphanParent: true });
  if (!cps.length) {
    toast(I18n.t("起点 / 终点为固定节点，无法复制"), "warn");
    return;
  }
  pushHistory();
  const dx = grid() * 4;
  const dy = grid() * 4;
  const innerSids = copiedSuperIdsOf(cps);
  for (const cp of cps) {
    /* super 内部节点使用内部坐标系：外壳偏移即可，内部坐标保持不动 */
    if (cp.parentSuperId && innerSids.has(cp.parentSuperId)) continue;
    cp.x = snap((cp.x || 0) + dx);
    cp.y = snap((cp.y || 0) + dy);
  }
  const wireCps = cloneWiresForSet(S.wf.wires, idMap);
  S.wf.nodes.push(...cps);
  if (wireCps.length) S.wf.wires.push(...wireCps);
  for (const cp of cps) {
    if (cp.kind === "task") ensureTaskScaffold(cp);
    if (isMediaGenNode(cp)) {
      probeMediaBackend(cp, { quiet: true });
    }
  }
  S.selSet = new Set(cps.map((c) => c.id));
  S.sel = cps[0].id;
  S.selGroup = null;
  S.selWire = null;
  S.selMark = null;
  if (S.selMarkSet) S.selMarkSet.clear();
  renderCanvas();
  scheduleSave(true);
  renderStatus();
}
/* 复制绘制标注（错开一格，便于模板复用） */
function duplicateMarks(list) {
  const marks = (list || []).filter(Boolean);
  if (!marks.length) return;
  pushHistory();
  const cps = [];
  const off = grid() * 4;
  marks.forEach((m, i) => {
    const cp = JSON.parse(JSON.stringify(m));
    cp.id = uid("mk");
    const dy = i * grid();
    cp.x = snap((cp.x || 0) + off);
    cp.y = snap((cp.y || 0) + off + dy);
    cps.push(cp);
  });
  marksOf().push(...cps);
  const mset = ensureSelMarkSet();
  mset.clear();
  for (const c of cps) mset.add(c.id);
  S.selMark = cps[0].id;
  S.sel = null;
  if (S.selSet) S.selSet.clear();
  S.selGroup = null;
  S.selWire = null;
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(I18n.t("已复制绘制：") + cps.length, "ok");
}
function duplicateSelection() {
  const ns = currentSelection();
  const marks = selectedMarks();
  if (!ns.length && !marks.length) return false;
  if (ns.length && marks.length) {
    /* 混合选区：一次复制节点 + 绘制，并保持两者同时选中（节点含全部后代与连线） */
    pushHistory();
    const srcs = collectWithDescendants(ns);
    const { cps: nodeCps, idMap } = cloneNodesDeep(srcs, {
      keepOrphanParent: true,
    });
    const ndx = grid() * 4;
    const ndy = grid() * 4;
    const innerSids = copiedSuperIdsOf(nodeCps);
    for (const cp of nodeCps) {
      /* super 内部节点使用内部坐标系：外壳偏移即可，内部坐标保持不动 */
      if (cp.parentSuperId && innerSids.has(cp.parentSuperId)) continue;
      cp.x = snap((cp.x || 0) + ndx);
      cp.y = snap((cp.y || 0) + ndy);
    }
    const wireCps = cloneWiresForSet(S.wf.wires, idMap);
    const markCps = [];
    const off = grid() * 4;
    marks.forEach((m, i) => {
      const cp = JSON.parse(JSON.stringify(m));
      cp.id = uid("mk");
      const dy = i * grid();
      cp.x = snap((cp.x || 0) + off);
      cp.y = snap((cp.y || 0) + off + dy);
      markCps.push(cp);
    });
    S.wf.nodes.push(...nodeCps);
    if (wireCps.length) S.wf.wires.push(...wireCps);
    for (const cp of nodeCps) {
      if (cp.kind === "task") ensureTaskScaffold(cp);
      if (isMediaGenNode(cp)) probeMediaBackend(cp, { quiet: true });
    }
    marksOf().push(...markCps);
    S.selSet = new Set(nodeCps.map((c) => c.id));
    S.sel = nodeCps[0].id;
    const mset = ensureSelMarkSet();
    mset.clear();
    for (const c of markCps) mset.add(c.id);
    S.selMark = markCps[0].id;
    S.selGroup = null;
    S.selWire = null;
    blurMarkEditing();
    S._deferCanvasForMarkEdit = false;
    renderCanvas();
    scheduleSave(true);
    renderStatus();
    toast(
      I18n.t("已复制 ") +
        nodeCps.length +
        I18n.t(" 个节点") +
        " · " +
        markCps.length +
        I18n.t(" 项绘制"),
      "ok",
    );
    return true;
  }
  if (ns.length) {
    duplicateNodes(ns);
    return true;
  }
  duplicateMarks(marks);
  return true;
}
/* ============ 节点粘贴板（Ctrl+C / Ctrl+V） ============ */
/* 扩展节点集：任意深度的任务子节点 / 超级节点内部节点一并收入（父在集合内即迭代至不再变化） */
function collectWithDescendants(srcs, wf) {
  wf = wf || S.wf;
  const seen = new Set();
  const out = [];
  for (const n of srcs) {
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  if (out.length) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of wf.nodes) {
        if (seen.has(n.id)) continue;
        const p = n.parentTaskId || n.parentSuperId;
        if (p && seen.has(p)) {
          seen.add(n.id);
          out.push(n);
          changed = true;
        }
      }
    }
  }
  return out;
}
/* 图像引用路径：相对路径固化为绝对路径（相对工作区），保证复制品引用同一图像文件；
   绝对路径或空值原样返回（无法解析的相对路径保持原样，由调用方兜底）。 */
function absImagePathOf(raw) {
  const s = String(raw || "").trim();
  if (!s || isAbsPath(s)) return raw;
  const base = String(wfWorkspace() || "").trim();
  if (!base) return raw;
  return joinPath(base, s.replace(/\\/g, "/"));
}
/* 克隆节点集：深拷贝 → 新 id → 标题唯一化（保持原名，不加「副本」）→ 运行时字段清空。
   相对路径的保存节点不复制保存目标（复制品与源会写同一文件，需重新指定）；
   图像节点（input_image）的相对路径固化为绝对路径，复制品才能正确引用同一图像。
   第二遍把父子归属 / 媒体-保存绑定（boundSaveId / boundFromId）按新 id 重映射：
   另一端也在复制集内 → 指向新 id；否则断开（keepOrphanParent 时父归属保留原值）。 */
function cloneNodesDeep(srcs, opts) {
  opts = opts || {};
  const cps = [];
  const idMap = new Map();
  for (const src of srcs) {
    if (!src || isPinnedCtrl(src)) continue;
    const cp = JSON.parse(JSON.stringify(src));
    const nid = uid("n");
    idMap.set(src.id, nid);
    cp.id = nid;
    cp.title = uniqueTitleInWf(S.wf, src.title);
    cp.output = null;
    cp.batchOutputs = null;
    cp.error = null;
    cp.ranAt = 0;
    cp.attemptOutputs = null;
    cp.attemptIdx = 0;
    cp.attemptsDone = 0;
    if (isMediaGenNode(cp)) {
      cp.running = false;
      cp.backendUi = {
        ok: null,
        probing: false,
        lastAt: 0,
        info: null,
        genPct: 0,
        genMsg: "",
      };
    }
    /* 复制的智能节点不带会话关联：每个智能任务节点对应唯一会话 */
    cp.agentSessionId = "";
    if (isSaveNode(cp)) {
      cp.savedPaths = [];
      cp.savedPath = "";
      /* 使用相对路径的保存节点：不复制保存目标（相对路径仍指向源同一位置） */
      if (String(cp.savePath || "").trim() && !isAbsPath(cp.savePath))
        cp.savePath = "";
    }
    /* 图像节点：相对路径固化为绝对路径，复制品与源引用同一图像（绝对路径保持原样） */
    if (cp.kind === "input_image") {
      if (cp.imageAsset) cp.imageAsset = absImagePathOf(cp.imageAsset);
      if (Array.isArray(cp.entries)) {
        for (const e of cp.entries) {
          if (!e || typeof e !== "object") continue;
          if (e.path) e.path = absImagePathOf(e.path);
          if (e.value && typeof e.value === "object" && e.value.path)
            e.value.path = absImagePathOf(e.value.path);
          if (e.imageAsset) e.imageAsset = absImagePathOf(e.imageAsset);
        }
      }
    }
    cps.push(cp);
  }
  for (const cp of cps) {
    cp.parentTaskId =
      cp.parentTaskId && idMap.has(cp.parentTaskId)
        ? idMap.get(cp.parentTaskId)
        : opts.keepOrphanParent
          ? cp.parentTaskId
          : "";
    cp.parentSuperId =
      cp.parentSuperId && idMap.has(cp.parentSuperId)
        ? idMap.get(cp.parentSuperId)
        : opts.keepOrphanParent
          ? cp.parentSuperId
          : "";
    if (isMediaGenNode(cp))
      cp.boundSaveId =
        cp.boundSaveId && idMap.has(cp.boundSaveId)
          ? idMap.get(cp.boundSaveId)
          : "";
    if (isSaveNode(cp))
      cp.boundFromId =
        cp.boundFromId && idMap.has(cp.boundFromId)
          ? idMap.get(cp.boundFromId)
          : "";
  }
  return { cps, idMap };
}
/* 保持连线：仅复制两端都在复制集内的连线（数据 / 控制 / 关系线），按新 id 重建 */
function cloneWiresForSet(wires, idMap) {
  const out = [];
  for (const w of wires || []) {
    if (!idMap.has(w.from) || !idMap.has(w.to)) continue;
    const cpw = {
      id: uid("w"),
      from: idMap.get(w.from),
      to: idMap.get(w.to),
      fromIndex: Number(w.fromIndex || 0),
      toIndex: Number(w.toIndex || 0),
    };
    if (w.pinned) cpw.pinned = true;
    if (w.rel) {
      cpw.rel = true;
      cpw.relArrow = w.relArrow || "forward";
      cpw.relLabel = w.relLabel || "";
    }
    out.push(cpw);
  }
  return out;
}
/* 复制集内的 super 节点 id 集合：其内部节点使用内部坐标系（superInnerOrigin），
   整体复制时外壳偏移即可，内部节点坐标保持不动 */
function copiedSuperIdsOf(cps) {
  const s = new Set();
  for (const c of cps) if (c && c.kind === "super") s.add(c.id);
  return s;
}
/* 复制：把选中的节点连同其全部后代（任意深度的任务子节点 / 超级节点内部节点）与选中绘制
   存入临时粘贴板（仅保存最近一次）。保持两端都在复制集内的连线；内部父子归属在粘贴时重建。 */
function copyNodesToClipboard() {
  const ns = currentSelection();
  const marks = selectedMarks();
  if (!ns.length && !marks.length) return false;
  const srcs = collectWithDescendants(ns);
  /* 固定起点 / 终点（ctrlPinned）不入粘贴板：粘贴任务节点时由 ensureTaskScaffold 重新生成 */
  const nodeList = srcs.filter((n) => !isPinnedCtrl(n));
  if (!nodeList.length && !marks.length) {
    toast(I18n.t("起点 / 终点为固定节点，无法复制"), "warn");
    return true;
  }
  /* 保持连线：仅收录两端都在复制集内的连线 */
  const copyIds = new Set(nodeList.map((n) => n.id));
  const wireList = (S.wf.wires || []).filter(
    (w) => copyIds.has(w.from) && copyIds.has(w.to),
  );
  nodeClipboard = {
    wfId: S.wf && S.wf.id,
    nodes: nodeList.map((n) => JSON.parse(JSON.stringify(n))),
    wires: wireList.map((w) => JSON.parse(JSON.stringify(w))),
    marks: marks.map((m) => JSON.parse(JSON.stringify(m))),
  };
  toast(
    I18n.t("已复制 ") +
      nodeList.length +
      I18n.t(" 个节点到粘贴板（Ctrl+V 粘贴）"),
    "ok",
  );
  return true;
}
/* 粘贴：把粘贴板中的节点 / 绘制复制到当前画布，包围盒中心对准当前视口中心（吸附网格）。
   复制后的节点拿到新 id；内部父子归属按新 id 重建，父不在粘贴集内的一律落为顶层；
   两端都在粘贴集内的连线一并重建。 */
function pasteNodesFromClipboard() {
  const clipNodes = (nodeClipboard && nodeClipboard.nodes) || [];
  const clipMarks = (nodeClipboard && nodeClipboard.marks) || [];
  if (!clipNodes.length && !clipMarks.length) {
    toast(I18n.t("粘贴板为空，请先 Ctrl+C 复制节点"), "warn");
    return false;
  }
  pushHistory();
  /* 克隆节点：新 id、标题唯一化（不加「副本」）、运行时字段清空；
     相对路径的保存节点不复制保存目标（避免复制品与源写同一文件）；
     图像节点相对路径固化为绝对路径（复制品正确引用同一图像） */
  const { cps, idMap } = cloneNodesDeep(clipNodes);
  /* 跨画布粘贴：复制时相对路径已固化为绝对路径，绝对引用直接保留以正确引用图像；
     仅仍为非绝对的路径（无法解析的无效引用）清空，避免指向不存在的文件 */
  if (nodeClipboard.wfId && S.wf && S.wf.id !== nodeClipboard.wfId) {
    for (const cp of cps) {
      if (cp.kind !== "input_image") continue;
      if (cp.imageAsset && !isAbsPath(cp.imageAsset)) {
        cp.imageAsset = "";
        cp.sourceName = "";
      }
      if (Array.isArray(cp.entries)) {
        for (const e of cp.entries) {
          if (e && e.path && !isAbsPath(e.path)) e.path = "";
        }
      }
    }
  }
  /* 重建内部父子归属：父在粘贴集内 → 指到新 id；否则落为当前任务 / 超级节点作用域（忽略外部关系） */
  const taskFocus = currentTaskFocus();
  const superFocus = currentSuperFocus();
  const sfHost = superFocus ? nodeById(superFocus) : null;
  const inSuper = !!(sfHost && sfHost.kind === "super");
  for (const cp of cps) {
    cp.parentTaskId =
      cp.parentTaskId && idMap.has(cp.parentTaskId)
        ? idMap.get(cp.parentTaskId)
        : "";
    cp.parentSuperId =
      cp.parentSuperId && idMap.has(cp.parentSuperId)
        ? idMap.get(cp.parentSuperId)
        : "";
    if (cp.parentTaskId || cp.parentSuperId) continue;
    /* 无内部父级（顶层节点）：落到当前任务 / 超级节点作用域，与新建节点一致 */
    if (inSuper) {
      cp.parentSuperId = superFocus;
      cp.parentTaskId = sfHost.parentTaskId || "";
    } else if (taskFocus) {
      cp.parentTaskId = taskFocus;
    }
  }
  /* 粘贴位置：粘贴集包围盒中心对准当前视口中心（吸附网格），避免与源节点重叠 */
  const cv = $("#canvas");
  const vw = cv ? cv.clientWidth : window.innerWidth;
  const vh = cv ? cv.clientHeight : window.innerHeight;
  const z = S.cam && S.cam.z > 0 ? S.cam.z : 1;
  const cx = (vw / 2 - (S.cam ? S.cam.x : 0)) / z;
  const cy = (vh / 2 - (S.cam ? S.cam.y : 0)) / z;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const extend = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const n of clipNodes) {
    extend(n.x, n.y);
    extend((n.x || 0) + (Number(n.w) || 180), (n.y || 0) + (Number(n.h) || 96));
  }
  for (const m of clipMarks) {
    const b = markBounds(m);
    if (b) {
      extend(b.x, b.y);
      extend(b.x + b.w, b.y + b.h);
    }
  }
  let dx = 0,
    dy = 0;
  if (Number.isFinite(minX)) {
    dx = snap(cx - (minX + maxX) / 2);
    dy = snap(cy - (minY + maxY) / 2);
  }
  /* 粘贴位置：super 内部节点用内部坐标系，不参与整体偏移（外壳偏移即可） */
  const innerSids = copiedSuperIdsOf(cps);
  for (const cp of cps) {
    if (cp.parentSuperId && innerSids.has(cp.parentSuperId)) continue;
    cp.x = snap((cp.x || 0) + dx);
    cp.y = snap((cp.y || 0) + dy);
  }
  /* 顶层节点粘贴进展开的超级节点：绝对坐标换算为该壳的内部坐标系 */
  if (inSuper) {
    const o = superInnerOrigin(sfHost);
    const pan = superInnerPan(sfHost);
    for (const cp of cps) {
      if (cp.parentSuperId !== superFocus) continue;
      cp.x = snap(Math.max(8, cp.x - sfHost.x - o.ox - pan.x));
      cp.y = snap(Math.max(8, cp.y - sfHost.y - o.oy - pan.y));
    }
  }
  S.wf.nodes.push(...cps);
  /* 保持连线：两端都在复制集内的连线按新 id 重建 */
  const wireCps = cloneWiresForSet(nodeClipboard && nodeClipboard.wires, idMap);
  if (wireCps.length) S.wf.wires.push(...wireCps);
  for (const cp of cps) {
    if (cp.kind === "task") ensureTaskScaffold(cp);
    if (isMediaGenNode(cp)) probeMediaBackend(cp, { quiet: true });
  }
  const mkCps = [];
  for (const m of clipMarks) {
    const cp = JSON.parse(JSON.stringify(m));
    cp.id = uid("mk");
    cp.x = snap((cp.x || 0) + dx);
    cp.y = snap((cp.y || 0) + dy);
    /* 标注归属与节点一致：父在粘贴集内指新 id，否则落当前作用域 */
    cp.parentTaskId =
      cp.parentTaskId && idMap.has(cp.parentTaskId)
        ? idMap.get(cp.parentTaskId)
        : "";
    cp.parentSuperId =
      cp.parentSuperId && idMap.has(cp.parentSuperId)
        ? idMap.get(cp.parentSuperId)
        : "";
    if (!cp.parentTaskId && !cp.parentSuperId) {
      if (inSuper) {
        cp.parentSuperId = superFocus;
        cp.parentTaskId = sfHost.parentTaskId || "";
      } else if (taskFocus) {
        cp.parentTaskId = taskFocus;
      }
    }
    mkCps.push(cp);
  }
  /* 顶层标注粘贴进展开的超级节点：坐标换算为该壳的内部坐标系 */
  if (inSuper) {
    const o = superInnerOrigin(sfHost);
    const pan = superInnerPan(sfHost);
    for (const cp of mkCps) {
      if (cp.parentSuperId !== superFocus) continue;
      cp.x = snap((cp.x || 0) - sfHost.x - o.ox - pan.x);
      cp.y = snap((cp.y || 0) - sfHost.y - o.oy - pan.y);
    }
  }
  marksOf().push(...mkCps);
  const mset = ensureSelMarkSet();
  mset.clear();
  for (const c of mkCps) mset.add(c.id);
  S.selSet = new Set(cps.map((c) => c.id));
  S.sel = cps.length ? cps[0].id : null;
  S.selGroup = null;
  S.selWire = null;
  S.selMark = mkCps.length ? mkCps[0].id : null;
  blurMarkEditing();
  S._deferCanvasForMarkEdit = false;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(
    I18n.t("已粘贴 ") +
      cps.length +
      I18n.t(" 个节点") +
      (mkCps.length ? " · " + mkCps.length + I18n.t(" 项绘制") : ""),
    "ok",
  );
  return true;
}
function syncGroupBtns() {
  const bg = $("#btnGroup");
  if (bg) {
    const ns = selNodes();
    const ms = selectedMarks();
    let inGroup = false;
    for (const n of ns) {
      if (
        (S.wf.groups || []).some((g) => {
          ensureGroupArrays(g);
          return g.nodeIds.includes(n.id);
        })
      ) {
        inGroup = true;
        break;
      }
    }
    if (!inGroup) {
      for (const m of ms) {
        if (
          (S.wf.groups || []).some((g) => {
            ensureGroupArrays(g);
            return g.markIds.includes(m.id);
          })
        ) {
          inGroup = true;
          break;
        }
      }
    }
    bg.classList.toggle("on", !!(S.selGroup || inGroup));
    bg.title = S.selGroup
      ? ns.length || ms.length
        ? I18n.t("将选中的节点/绘制加入当前组")
        : I18n.t("解散当前组（保留内部节点与绘制）")
      : I18n.t(
          "组：把选中的节点或绘制组成一个组（快捷键 G）；选中组后再次点击可加入或解散",
        );
  }
  const bs = $("#btnWrapSuper");
  if (bs) {
    const canWrap = selNodes().some((n) => n && !isSuperIoNode(n));
    bs.classList.toggle("on", canWrap);
    bs.disabled = !canWrap;
    bs.title = I18n.t(
      "超节点：将选中节点合并为展开的超级节点（覆盖选区范围）",
    );
  }
}

/* ============ 左侧边栏（节点树状图 + 筛选） ============ */

/* 左侧栏「当前画布」分类：必须覆盖全部节点类型，否则该类型的节点不出现在列表里。
 * 开发节点 = kind "super" + dev:true（含普通超级节点），单独归类便于定位。 */
/* 分类归属判定：工具节点的规范形态是超级变体（kind 字面值 "super"），但侧栏仍归
   「工具节点」分类 ——  kinds 里带 "tool" 的那个分类就是它的归属，不吃 kind 字面值。 */
function sideCatMatches(n, kinds) {
  if (isToolNode(n)) return kinds.includes("tool");
  return kinds.includes(n.kind);
}
const SIDE_CATS = [
  ["输入节点", ["input_text", "input_image", "input_audio", "input_video", "input_file", "db_table"]],
  ["全局节点", ["global"]],
  ["处理节点", ["proc_text", "proc_image", "music_gen", "tts_gen", "video_gen", "remotion"]],
  ["保存节点", ["save"]],
  ["工具节点", ["split", "merge", "function", "tool"]],
  ["网络节点", ["net_recv", "net_send"]],
  ["智能节点", ["agent_task"]],
  ["任务节点", ["task"]],
  ["控制节点", ["control", "wait_file", "timer", "delayer", "sequencer", "gate", "splitter", "counter", "mutex", "judge"]],
  ["执行节点", ["execute"]],
  ["数据库", ["db_replica"]],
  ["超级/开发节点", ["super"]],
];
const KIND_TAGS = {
  input_text: "文本",
  input_image: "图像",
  input_audio: "音频",
  input_video: "视频",
  /* 素材节点（素材库内容打包） */
  asset: "素材",
  input_file: "文件",
  db_table: "表",
  proc_text: "LLM",
  proc_image: "文生图",
  music_gen: "音乐",
  tts_gen: "语音",
  video_gen: "视频",
  remotion: "视频",
  net_recv: "接收",
  net_send: "发送",
  execute: "执行",
  save: "保存",
  save_text: "保存",
  save_image: "保存",
  split: "拆分",
  merge: "合并",
  function: "函数",
  tool: "工具",
  global: "全局",
  wait_file: "等待",
  timer: "定时",
  delayer: "延时",
  sequencer: "序列",
  gate: "闸门",
  splitter: "分发",
  counter: "计数",
  mutex: "互斥",
  agent_task: "智能",
  task: "任务",
  control: "控制",
  judge: "判断",
  super: "超节点",
  db_replica: "数据库",
};
function sidebarSupersInTask() {
  const task = currentTaskFocus();
  return ((S.wf && S.wf.nodes) || []).filter(
    (n) => n && n.kind === "super" && nodeParentTaskId(n) === task,
  );
}
function sidebarSuperChildren(supers, parentId) {
  const pid = parentId || "";
  return supers
    .filter((n) => (nodeParentSuperId(n) || "") === pid)
    .sort((a, b) =>
      String(a.title || "").localeCompare(String(b.title || ""), "zh"),
    );
}
function sidebarSuperRoots(supers) {
  const ids = new Set(supers.map((n) => n.id));
  return supers
    .filter((n) => {
      const p = nodeParentSuperId(n);
      return !p || !ids.has(p);
    })
    .sort((a, b) =>
      String(a.title || "").localeCompare(String(b.title || ""), "zh"),
    );
}
/** 边栏：进入超级节点画布并适配内部节点 */
function focusSuperFromSidebar(id) {
  const n = nodeById(id);
  if (!n || n.kind !== "super") return;
  const wantTask = nodeParentTaskId(n);
  if (wantTask !== currentTaskFocus()) {
    setTaskFocus(wantTask, { render: false });
  }
  enterSuper(n, { toast: true });
  if (S.sidebarOpen) renderSidebar();
}
/** 左侧列表右键：删除（超级节点会递归删内部） */
function bindSidebarNodeCtx(el, node) {
  if (!el || !node) return;
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const items = [];
    if (node.kind === "super") {
      items.push(
        ctxAction(I18n.t("进入"), () => enterSuper(node), "expand"),
        ctxAction(I18n.t("定位"), () => focusSuperFromSidebar(node.id), "expand"),
      );
    } else {
      items.push(
        ctxAction(I18n.t("定位"), () => focusNode(node.id), "expand"),
      );
    }
    if (!isPinnedCtrl(node)) {
      items.push(
        ctxAction(
          I18n.t("删除"),
          () => deleteNodes([node.id]),
          "menu_delete",
          { iconCls: "danger", cls: "ctx-danger" },
        ),
      );
    }
    showCtx(ev.clientX, ev.clientY, [[I18n.t("节点操作"), items]]);
  });
}
function renderSuperSidebarTree(tree, filter) {
  if (!tree) return false;
  const supers = sidebarSupersInTask();
  if (!supers.length && !filter) return false;
  const f = String(filter || "").trim().toLowerCase();
  const matchIds = new Set();
  if (f) {
    for (const n of supers) {
      const title = String(n.title || "").toLowerCase();
      const sub = String(n.subFolder || "").toLowerCase();
      if (title.includes(f) || sub.includes(f)) matchIds.add(n.id);
    }
    if (!matchIds.size) return false;
    /* 保留祖先链，树形不断档 */
    for (const id of [...matchIds]) {
      let sid = nodeParentSuperId(nodeById(id));
      const seen = new Set();
      while (sid && !seen.has(sid)) {
        seen.add(sid);
        matchIds.add(sid);
        sid = nodeParentSuperId(nodeById(sid));
      }
    }
  }
  const visible = f ? supers.filter((n) => matchIds.has(n.id)) : supers;
  if (!visible.length) return false;

  const sec = document.createElement("div");
  sec.className = "side-section side-section-super";
  const sep = document.createElement("div");
  sep.className = "side-section-sep";
  sep.setAttribute("role", "separator");
  sec.appendChild(sep);

  const head = document.createElement("div");
  head.className = "side-cat-head side-section-head";
  const collapsed = !!S.sideCollapsed["__super_tree__"];
  head.textContent =
    (collapsed ? "▸ " : "▾ ") +
    I18n.t("超级节点") +
    "（" +
    visible.length +
    "）";
  head.title = collapsed
    ? I18n.t("展开超级节点树")
    : I18n.t("折叠超级节点树");
  head.onclick = () => {
    S.sideCollapsed["__super_tree__"] = !collapsed;
    renderSidebar();
  };
  sec.appendChild(head);

  if (!collapsed) {
    const focusId = currentSuperFocus();
    const stack = new Set(S.superStack || []);
    const appendRow = (n, depth) => {
      const kids = sidebarSuperChildren(visible, n.id);
      const row = document.createElement("div");
      row.className =
        "side-item side-super-item" +
        (focusId === n.id ? " sel" : "") +
        (stack.has(n.id) && focusId !== n.id ? " on-path" : "");
      row.style.setProperty("--depth", String(depth));
      row.title =
        I18n.t("进入超级节点画布并定位：") + (n.title || I18n.t("超级节点"));
      const twisty = document.createElement("button");
      twisty.type = "button";
      twisty.className = "side-super-twisty";
      const nodeCollapsed = !!S.sideSuperCollapsed[n.id];
      if (kids.length) {
        twisty.textContent = nodeCollapsed ? "▸" : "▾";
        twisty.title = nodeCollapsed ? I18n.t("展开") : I18n.t("折叠");
        twisty.onclick = (ev) => {
          ev.stopPropagation();
          S.sideSuperCollapsed[n.id] = !nodeCollapsed;
          renderSidebar();
        };
      } else {
        twisty.textContent = "·";
        twisty.disabled = true;
        twisty.classList.add("leaf");
      }
      const tag = document.createElement("span");
      tag.className = "side-tag";
      tag.textContent = I18n.t("超节点");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = n.title || I18n.t("（未命名）");
      const nChild = superChildrenOf(n.id).filter((c) => !isSuperIoNode(c))
        .length;
      const tip = document.createElement("span");
      tip.className = "side-tag-list";
      tip.textContent = String(nChild);
      tip.title = I18n.t("内部节点数：") + nChild;
      row.appendChild(twisty);
      row.appendChild(tag);
      row.appendChild(t);
      row.appendChild(tip);
      row.onclick = () => focusSuperFromSidebar(n.id);
      bindSidebarNodeCtx(row, n);
      sec.appendChild(row);
      if (kids.length && !nodeCollapsed) {
        for (const c of kids) appendRow(c, depth + 1);
      }
    };
    for (const root of sidebarSuperRoots(visible)) appendRow(root, 0);
  }
  tree.appendChild(sec);
  return true;
}
/** 画布左侧边栏只在画布视图存在：会话视图（自带会话列表 .agent-side）一律收起。
 *  用户偏好仍记在 S.sidebarOpen，切回画布自动恢复。 */
function applySidebarVisibility() {
  const open = !!S.sidebarOpen && S.view !== "agent";
  const layout = $("#layout");
  if (layout) layout.classList.toggle("sidebar-open", open);
  const btn = $("#btnSidebar");
  if (btn) btn.classList.toggle("on", open);
  return open;
}
function toggleSidebar() {
  /* 会话视图不允许展开画布边栏（两套左侧栏互斥，避免运行时串场误弹） */
  if (S.view === "agent") {
    applySidebarVisibility();
    toast(I18n.t("会话视图不使用画布边栏：请在「画布」视图中查看节点列表"), "warn");
    return;
  }
  S.sidebarOpen = !S.sidebarOpen;
  applySidebarVisibility();
  if (S.sidebarOpen) renderSidebar();
  renderStatus();
}
function renderSidebar() {
  /* 不变式：边栏显隐始终与当前视图一致（会话视图永不显示画布边栏） */
  applySidebarVisibility();
  if (S.view === "agent") {
    renderAgentSessionSidebar();
    return;
  }
  const tree = $("#sideTree");
  if (!tree) return;
  const filterEl = $("#sideFilter");
  const f = filterEl ? filterEl.value.trim().toLowerCase() : "";
  tree.innerHTML = "";
  const visMarks = visibleMarks();
  const hasAny =
    S.wf &&
    ((S.wf.nodes && S.wf.nodes.length) || (S.wf.marks && S.wf.marks.length));
  if (!S.wf || !hasAny) {
    const e = document.createElement("div");
    e.className = "side-empty";
    e.textContent = I18n.t("暂无节点或绘图");
    tree.appendChild(e);
    return;
  }

  const canvasSec = document.createElement("div");
  canvasSec.className = "side-section side-section-canvas";
  const canvasHead = document.createElement("div");
  canvasHead.className = "side-cat-head side-section-head";
  const canvasCollapsed = !!S.sideCollapsed["__canvas_list__"];
  canvasHead.textContent =
    (canvasCollapsed ? "▸ " : "▾ ") + I18n.t("当前画布");
  canvasHead.title = canvasCollapsed
    ? I18n.t("展开当前画布列表")
    : I18n.t("折叠当前画布列表");
  canvasHead.onclick = () => {
    S.sideCollapsed["__canvas_list__"] = !canvasCollapsed;
    renderSidebar();
  };
  canvasSec.appendChild(canvasHead);
  tree.appendChild(canvasSec);

  let any = false;
  const appendCat = (cat, totalCount, shown, makeRow) => {
    if (!shown.length) return;
    any = true;
    const catEl = document.createElement("div");
    catEl.className = "side-cat";
    const head = document.createElement("div");
    head.className = "side-cat-head";
    const collapsed = !!S.sideCollapsed[cat];
    head.textContent =
      (collapsed ? "▸ " : "▾ ") +
      I18n.t(cat) +
      "（" +
      totalCount +
      "）" +
      (f ? " · " + shown.length : "");
    head.title = collapsed ? I18n.t("展开分类") : I18n.t("折叠分类");
    head.onclick = () => {
      S.sideCollapsed[cat] = !collapsed;
      renderSidebar();
    };
    catEl.appendChild(head);
    if (!collapsed) {
      for (const item of shown) catEl.appendChild(makeRow(item));
    }
    canvasSec.appendChild(catEl);
  };
  if (!canvasCollapsed) {
  for (const [cat, kinds] of SIDE_CATS) {
    const items = S.wf.nodes.filter(
      (n) =>
        sideCatMatches(n, kinds) &&
        (f ? true : nodeInCurrentScope(n)),
    );
    if (!items.length) continue;
    const shown = f
      ? items.filter((n) => (n.title || "").toLowerCase().includes(f))
      : items;
    appendCat(cat, items.length, shown, (n) => {
      const it = document.createElement("div");
      it.className = "side-item" + (isSel(n.id) ? " sel" : "");
      it.title = I18n.t("画布居中定位到：") + (n.title || "");
      const tag = document.createElement("span");
      tag.className = "side-tag";
      let tagText = KIND_TAGS[n.kind] || n.kind;
      /* 开发节点（kind=super + dev）标注元素类型，便于与普通超级节点区分；
         工具节点（kind=super + tool）保持「工具」标注（形态迁移后不再靠 kind 区分）。 */
      if (n.kind === "super" && n.dev) {
        tagText =
          "开发·" +
          I18n.t(DEV_KIND_LABEL[devKindOf(n) || "module"] || "模块");
      } else if (isToolNode(n)) {
        tagText = I18n.t(KIND_TAGS.tool);
      } else if (n.kind === "super") {
        tagText = I18n.t(KIND_TAGS.super);
      }
      tag.textContent = tagText;
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = n.title || I18n.t("（未命名）");
      it.appendChild(tag);
      it.appendChild(t);
      const nodeTags = normalizeNodeTags(n);
      if (nodeTags.length) {
        const tip = document.createElement("span");
        tip.className = "side-tag-list";
        tip.textContent = nodeTags.slice(0, 3).join(" · ");
        if (nodeTags.length > 3) tip.textContent += "…";
        tip.title = nodeTags.join(" · ");
        it.appendChild(tip);
      }
      it.onclick = () => focusNode(n.id);
      bindSidebarNodeCtx(it, n);
      return it;
    });
  }
  {
    const catalog = wfTagCatalog().slice().sort((a, b) => a.localeCompare(b, "zh"));
    for (const tagName of catalog) {
      const items = S.wf.nodes.filter(
        (n) =>
          n.kind !== "global" &&
          nodeHasTag(n, tagName) &&
          (f ? true : nodeInCurrentScope(n)),
      );
      if (!items.length && !f) continue;
      const shown = f
        ? items.filter(
            (n) =>
              (n.title || "").toLowerCase().includes(f) ||
              tagName.toLowerCase().includes(f),
          )
        : items;
      if (!shown.length) continue;
      appendCat("Tag · " + tagName, items.length, shown, (n) => {
        const it = document.createElement("div");
        it.className = "side-item" + (isSel(n.id) ? " sel" : "");
        it.title = I18n.t("画布居中定位到：") + (n.title || "");
        const tag = document.createElement("span");
        tag.className = "side-tag side-tag-user";
        tag.textContent = tagName;
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = n.title || I18n.t("（未命名）");
        it.appendChild(tag);
        it.appendChild(t);
        it.onclick = () => focusNode(n.id);
        bindSidebarNodeCtx(it, n);
        return it;
      });
    }
  }
  const markPool = f ? marksOf() : visMarks;
  const markShown = markPool.filter((m) => {
    if (!f && !markInCurrentScope(m)) return false;
    if (!f) return true;
    const title = markSidebarTitle(m).toLowerCase();
    const kind = markKindLabel(m.kind).toLowerCase();
    return (
      title.includes(f) ||
      kind.includes(f) ||
      String(m.id || "").toLowerCase().includes(f)
    );
  });
  appendCat("绘图", markPool.length, markShown, (m) => {
    const selected =
      S.selMark === m.id || (S.selMarkSet && S.selMarkSet.has(m.id));
    const it = document.createElement("div");
    it.className = "side-item" + (selected ? " sel" : "");
    const label = markSidebarTitle(m);
    it.title = I18n.t("画布居中定位到：") + label;
    const tag = document.createElement("span");
    tag.className = "side-tag";
    tag.textContent = markKindLabel(m.kind);
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = label;
    it.appendChild(tag);
    it.appendChild(t);
    it.onclick = () => focusMark(m.id);
    return it;
  });
  if (!any) {
    const maybeSuperHit =
      !!f &&
      sidebarSupersInTask().some((n) => {
        const title = String(n.title || "").toLowerCase();
        const sub = String(n.subFolder || "").toLowerCase();
        return title.includes(f) || sub.includes(f);
      });
    if (!maybeSuperHit) {
      const e = document.createElement("div");
      e.className = "side-empty";
      if (currentTaskFocus() && !f) {
        e.textContent =
          I18n.t("当前任务内部暂无节点或绘图") +
          " · " +
          I18n.t("可从右键菜单添加，或返回上层");
      } else if (currentSuperFocus() && !f) {
        e.textContent =
          I18n.t("当前超级节点内部暂无节点或绘图") +
          " · " +
          I18n.t("可从右键菜单添加，或返回上层");
      } else {
        e.textContent = I18n.t("没有匹配「{q}」的节点或绘图", {
          q: filterEl ? filterEl.value : "",
        });
      }
      canvasSec.appendChild(e);
    }
  }
  } /* !canvasCollapsed */

  const hasSuperTree = renderSuperSidebarTree(tree, f);
  if (!any && !hasSuperTree && canvasCollapsed) {
    const e = document.createElement("div");
    e.className = "side-empty";
    e.textContent = I18n.t("暂无节点或绘图");
    tree.appendChild(e);
  }
}
/* 画布居中到指定节点并选中 */
function focusNode(id) {
  const n = nodeById(id);
  if (!n) return;
  const want = nodeParentTaskId(n);
  if (want !== currentTaskFocus()) setTaskFocus(want, { render: false });
  /* 节点在超级节点内：确保目标 super 处于可见状态。
   * - 宿主是展开壳（superOpen）且非当前 focus → 直接定位（nodeWorldPos 会算世界坐标）。
   * - 宿主收起 / 处于 focus 模式 → 进入宿主 focus 视图（S.superFocus = 直接宿主），
   *   使 nodeInCurrentScope 命中、nodeWorldPos 返回本地坐标，再定位。 */
  const hostSuperId = nodeParentSuperId(n);
  if (hostSuperId) {
    const host = nodeById(hostSuperId);
    if (host && host.kind === "super") {
      const inOpenShell = host.superOpen && hostSuperId !== currentSuperFocus();
      if (!inOpenShell) {
        setSuperFocus(hostSuperId, { render: false });
        /* 进入 focus 视图后，宿主作为根展示其子节点；task 焦点重置 */
        if (nodeParentTaskId(host) !== currentTaskFocus())
          setTaskFocus(nodeParentTaskId(host), { render: false });
      }
    }
  }
  const vw = $("#canvas").clientWidth,
    vh = $("#canvas").clientHeight;
  const p = nodeWorldPos(n);
  const sz = nodeDrawSize(n);
  S.cam.x = vw / 2 - (p.x + sz.w / 2) * S.cam.z;
  S.cam.y = vh / 2 - (p.y + sz.h / 2) * S.cam.z;
  S.selSet = new Set([id]);
  S.sel = id;
  S.selGroup = null;
  S.selWire = null;
  S.selMark = null;
  if (S.selMarkSet) S.selMarkSet.clear();
  renderCanvas();
  renderStatus();
}

/* ── 画布查找 / 替换（标题 + 可编辑内容，仅当前画布） ── */

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAllInString(hay, find, repl) {
  if (!find) return String(hay == null ? "" : hay);
  return String(hay == null ? "" : hay).replace(
    new RegExp(escapeRegExp(find), "gi"),
    () => String(repl == null ? "" : repl),
  );
}

function stringContainsQuery(hay, q) {
  if (!q) return false;
  return String(hay == null ? "" : hay)
    .toLowerCase()
    .includes(String(q).toLowerCase());
}

function nodeOutputSearchText(n) {
  const o = n && n.output;
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (typeof o.text === "string") return o.text;
  if (o.kind === "text" && typeof o.text === "string") return o.text;
  return "";
}

/* 可搜索 / 可替换的字段（标题 + 内容） */
function nodeFindFields(n) {
  if (!n) return [];
  const fields = [{ key: "title", get: () => n.title || "", set: (v) => (n.title = v) }];
  if (n.kind === "input_text" || n.text != null)
    fields.push({ key: "text", get: () => n.text || "", set: (v) => (n.text = v) });
  if (
    n.kind === "proc_text" ||
    n.kind === "proc_image" ||
    n.kind === "judge" ||
    n.prompt != null
  )
    fields.push({
      key: "prompt",
      get: () => n.prompt || "",
      set: (v) => (n.prompt = v),
    });
  if (n.kind === "agent_task" || n.task != null)
    fields.push({ key: "task", get: () => n.task || "", set: (v) => (n.task = v) });
  if (n.systemPrompt != null)
    fields.push({
      key: "systemPrompt",
      get: () => n.systemPrompt || "",
      set: (v) => (n.systemPrompt = v),
    });
  if (n.kind === "task" || n.goal != null)
    fields.push({ key: "goal", get: () => n.goal || "", set: (v) => (n.goal = v) });
  if (isSaveNode(n) || n.savePath != null)
    fields.push({
      key: "savePath",
      get: () => n.savePath || "",
      set: (v) => (n.savePath = v),
    });
  if (n.kind === "wait_file" || n.waitPath != null)
    fields.push({
      key: "waitPath",
      get: () => n.waitPath || "",
      set: (v) => (n.waitPath = v),
    });
  if (Array.isArray(n.steps)) {
    n.steps.forEach((step, i) => {
      if (!step || typeof step !== "object") return;
      fields.push({
        key: "steps." + i + ".title",
        get: () => step.title || "",
        set: (v) => {
          step.title = v;
        },
      });
    });
  }
  if (Array.isArray(n.messages)) {
    n.messages.forEach((msg, i) => {
      if (!msg || typeof msg !== "object") return;
      fields.push({
        key: "messages." + i + ".content",
        get: () => msg.content || "",
        set: (v) => {
          msg.content = v;
        },
      });
    });
  }
  const out = nodeOutputSearchText(n);
  if (out) {
    fields.push({
      key: "output",
      get: () => nodeOutputSearchText(n),
      set: (v) => {
        if (n.output && typeof n.output === "object") n.output.text = v;
        else n.output = { kind: "text", text: v };
      },
    });
  }
  return fields;
}

function nodeMatchesFindQuery(n, q) {
  if (!n || !q) return false;
  return nodeFindFields(n).some((f) => stringContainsQuery(f.get(), q));
}

function uniqueTitleExcept(wf, desired, exceptId) {
  const base = String(desired || I18n.t("节点")).trim() || I18n.t("节点");
  const taken = new Set(
    ((wf && wf.nodes) || [])
      .filter((n) => n && n.id !== exceptId)
      .map((n) => n.title),
  );
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + " " + i)) i++;
  return base + " " + i;
}

function replaceInNodeFields(n, find, repl) {
  if (!n || !find) return false;
  let changed = false;
  for (const f of nodeFindFields(n)) {
    const before = f.get();
    const after = replaceAllInString(before, find, repl);
    if (after === before) continue;
    if (f.key === "title")
      f.set(uniqueTitleExcept(S.wf, after, n.id));
    else f.set(after);
    changed = true;
  }
  return changed;
}

function collectCanvasFindMatches(q) {
  const query = String(q || "").trim();
  if (!query || !S.wf || !Array.isArray(S.wf.nodes)) return [];
  return S.wf.nodes.filter((n) => nodeMatchesFindQuery(n, query)).map((n) => n.id);
}

function isCanvasFindBarTarget(el) {
  const bar = document.getElementById("canvasFindBar");
  return !!(bar && el && bar.contains(el));
}

function ensureCanvasFindBar() {
  const canvas = $("#canvas");
  if (!canvas) return null;
  let bar = document.getElementById("canvasFindBar");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "canvasFindBar";
  bar.className = "canvas-find-bar";
  bar.hidden = true;
  bar.innerHTML =
    '<input id="canvasFindQ" type="text" class="canvas-find-q" autocomplete="off" spellcheck="false" />' +
    '<span id="canvasFindCount" class="canvas-find-count">0/0</span>' +
    '<button type="button" id="canvasFindPrev" class="mini btn-sq" title="">↑</button>' +
    '<button type="button" id="canvasFindNext" class="mini btn-sq" title="">↓</button>' +
    '<div id="canvasFindReplRow" class="canvas-find-repl-row" hidden>' +
    '<input id="canvasFindRepl" type="text" class="canvas-find-repl" autocomplete="off" spellcheck="false" />' +
    '<button type="button" id="canvasFindReplace" class="mini"></button>' +
    '<button type="button" id="canvasFindReplaceAll" class="mini"></button>' +
    "</div>" +
    '<button type="button" id="canvasFindClose" class="mini btn-sq">✕</button>';
  canvas.appendChild(bar);

  const q = bar.querySelector("#canvasFindQ");
  const repl = bar.querySelector("#canvasFindRepl");
  const paintLabels = () => {
    q.placeholder = I18n.t("查找节点（标题 / 内容）…");
    repl.placeholder = I18n.t("替换为…");
    bar.querySelector("#canvasFindPrev").title = I18n.t("上一个（Shift+Enter）");
    bar.querySelector("#canvasFindNext").title = I18n.t("下一个（Enter）");
    bar.querySelector("#canvasFindReplace").textContent = I18n.t("替换");
    bar.querySelector("#canvasFindReplaceAll").textContent = I18n.t("全部替换");
    bar.querySelector("#canvasFindClose").title = I18n.t("关闭（Esc）");
  };
  paintLabels();
  bar._paintLabels = paintLabels;

  const syncQuery = () => {
    S.findBar.query = q.value;
    canvasFindRefresh({ keepIdx: true, focus: false });
  };
  q.addEventListener("input", syncQuery);
  repl.addEventListener("input", () => {
    S.findBar.replace = repl.value;
  });
  q.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) canvasFindPrev();
      else canvasFindNext();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeCanvasFindBar();
    }
  });
  repl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      canvasFindReplaceOne();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeCanvasFindBar();
    }
  });
  bar.querySelector("#canvasFindPrev").onclick = () => canvasFindPrev();
  bar.querySelector("#canvasFindNext").onclick = () => canvasFindNext();
  bar.querySelector("#canvasFindReplace").onclick = () => canvasFindReplaceOne();
  bar.querySelector("#canvasFindReplaceAll").onclick = () => canvasFindReplaceAll();
  bar.querySelector("#canvasFindClose").onclick = () => closeCanvasFindBar();
  bar.addEventListener("mousedown", (ev) => ev.stopPropagation());
  return bar;
}

function paintCanvasFindCount() {
  const el = document.getElementById("canvasFindCount");
  if (!el || !S.findBar) return;
  const n = (S.findBar.matches || []).length;
  const i = S.findBar.idx;
  el.textContent = n ? i + 1 + "/" + n : "0/0";
}

function canvasFindRefresh(opts) {
  opts = opts || {};
  if (!S.findBar) return;
  const prevId =
    S.findBar.idx >= 0 && S.findBar.matches
      ? S.findBar.matches[S.findBar.idx]
      : null;
  const q = String(
    opts.query != null ? opts.query : S.findBar.query || "",
  ).trim();
  S.findBar.query = q;
  S.findBar.matches = collectCanvasFindMatches(q);
  if (!q) {
    S.findBar.idx = -1;
  } else if (opts.keepIdx && prevId) {
    const j = S.findBar.matches.indexOf(prevId);
    S.findBar.idx = j >= 0 ? j : S.findBar.matches.length ? 0 : -1;
  } else if (S.findBar.matches.length) {
    S.findBar.idx = 0;
  } else {
    S.findBar.idx = -1;
  }
  paintCanvasFindCount();
  if (opts.focus !== false && S.findBar.idx >= 0)
    focusNode(S.findBar.matches[S.findBar.idx]);
}

function openCanvasFindBar(opts) {
  opts = opts || {};
  if (S.view && S.view !== "workflow") setView("workflow");
  const bar = ensureCanvasFindBar();
  if (!bar || !S.findBar) return;
  if (typeof bar._paintLabels === "function") bar._paintLabels();
  S.findBar.open = true;
  S.findBar.replaceMode = !!opts.replace;
  bar.hidden = false;
  const row = bar.querySelector("#canvasFindReplRow");
  if (row) row.hidden = !S.findBar.replaceMode;
  const q = bar.querySelector("#canvasFindQ");
  const repl = bar.querySelector("#canvasFindRepl");
  if (q) {
    q.value = S.findBar.query || "";
    q.focus();
    q.select();
  }
  if (repl) repl.value = S.findBar.replace || "";
  canvasFindRefresh({
    keepIdx: true,
    focus: !!(S.findBar.query && S.findBar.query.trim()),
  });
}

function closeCanvasFindBar() {
  if (!S.findBar) return false;
  if (!S.findBar.open) return false;
  S.findBar.open = false;
  const bar = document.getElementById("canvasFindBar");
  if (bar) bar.hidden = true;
  return true;
}

function canvasFindGoto(delta) {
  if (!S.findBar) return;
  const qEl = document.getElementById("canvasFindQ");
  if (qEl) S.findBar.query = qEl.value;
  canvasFindRefresh({ keepIdx: true, focus: false });
  const list = S.findBar.matches || [];
  if (!list.length) {
    paintCanvasFindCount();
    toast(I18n.t("未找到匹配的节点"), "warn");
    return;
  }
  let i = S.findBar.idx;
  if (i < 0) i = delta > 0 ? 0 : list.length - 1;
  else if (S.sel !== list[i]) {
    /* 已有匹配但尚未选中：先落到当前项，不跳下一项 */
    paintCanvasFindCount();
    focusNode(list[i]);
    return;
  } else {
    i = (i + delta + list.length) % list.length;
  }
  S.findBar.idx = i;
  paintCanvasFindCount();
  focusNode(list[i]);
}

function canvasFindNext() {
  canvasFindGoto(1);
}
function canvasFindPrev() {
  canvasFindGoto(-1);
}

function canvasFindReplaceOne() {
  if (!S.findBar || !S.wf) return;
  const qEl = document.getElementById("canvasFindQ");
  const rEl = document.getElementById("canvasFindRepl");
  const find = String((qEl && qEl.value) || S.findBar.query || "").trim();
  const repl = rEl ? rEl.value : S.findBar.replace || "";
  S.findBar.query = find;
  S.findBar.replace = repl;
  if (!find) {
    toast(I18n.t("请输入要查找的文本"), "warn");
    return;
  }
  canvasFindRefresh({ keepIdx: true, focus: false });
  if (!S.findBar.matches.length || S.findBar.idx < 0) {
    toast(I18n.t("未找到匹配的节点"), "warn");
    return;
  }
  const id = S.findBar.matches[S.findBar.idx];
  const n = nodeById(id);
  if (!n || !nodeMatchesFindQuery(n, find)) {
    canvasFindNext();
    return;
  }
  pushHistory();
  replaceInNodeFields(n, find, repl);
  scheduleSave();
  canvasFindRefresh({ keepIdx: false, focus: false });
  const j = S.findBar.matches.indexOf(id);
  if (j >= 0) {
    S.findBar.idx = j;
    focusNode(id);
  } else if (S.findBar.matches.length) {
    S.findBar.idx = Math.min(S.findBar.idx, S.findBar.matches.length - 1);
    if (S.findBar.idx < 0) S.findBar.idx = 0;
    focusNode(S.findBar.matches[S.findBar.idx]);
  } else {
    S.findBar.idx = -1;
    renderCanvas();
    renderStatus();
  }
  paintCanvasFindCount();
}

function canvasFindReplaceAll() {
  if (!S.findBar || !S.wf) return;
  const qEl = document.getElementById("canvasFindQ");
  const rEl = document.getElementById("canvasFindRepl");
  const find = String((qEl && qEl.value) || S.findBar.query || "").trim();
  const repl = rEl ? rEl.value : S.findBar.replace || "";
  S.findBar.query = find;
  S.findBar.replace = repl;
  if (!find) {
    toast(I18n.t("请输入要查找的文本"), "warn");
    return;
  }
  const ids = collectCanvasFindMatches(find);
  if (!ids.length) {
    toast(I18n.t("未找到匹配的节点"), "warn");
    return;
  }
  pushHistory();
  let count = 0;
  for (const id of ids) {
    const n = nodeById(id);
    if (n && replaceInNodeFields(n, find, repl)) count++;
  }
  scheduleSave();
  S.findBar.matches = [];
  S.findBar.idx = -1;
  paintCanvasFindCount();
  renderCanvas();
  renderStatus();
  toast(I18n.t("已替换 ") + count + I18n.t(" 个节点"), "ok");
}

function markSidebarTitle(m) {
  if (!m) return I18n.t("（未命名）");
  if (m.kind === "text") {
    const t = String(m.text || "").replace(/\s+/g, " ").trim();
    return t || I18n.t("说明文字");
  }
  return markKindLabel(m.kind);
}

function focusMark(id) {
  const m = markById(id);
  if (!m) return;
  const want = markParentTaskId(m);
  if (want !== currentTaskFocus()) setTaskFocus(want, { render: false });
  const b = markBounds(m) || { x: Number(m.x) || 0, y: Number(m.y) || 0, w: 40, h: 40 };
  const vw = $("#canvas").clientWidth,
    vh = $("#canvas").clientHeight;
  S.cam.x = vw / 2 - (b.x + b.w / 2) * S.cam.z;
  S.cam.y = vh / 2 - (b.y + b.h / 2) * S.cam.z;
  const mset = ensureSelMarkSet();
  mset.clear();
  mset.add(id);
  S.selMark = id;
  S.sel = null;
  if (S.selSet) S.selSet.clear();
  S.selGroup = null;
  S.selWire = null;
  renderCanvas();
  renderStatus();
}

/* 数据库超级节点处于「展开」态时，其内部空白处右键也可用数据库专属节点菜单 */
function dbCreateMenuOpenAt(pt) {
  if (!pt || currentSuperFocus()) return false;
  const host = findOpenSuperAtWorld(pt.x, pt.y, new Set());
  return !!(host && host.kind === "super" && host.db);
}
function canvasCreateMenuGroups(pt) {
  /* 数据库超级节点内部：右键菜单只提供「文件节点」和「表」（钻入或展开均生效） */
  if (currentDbSuper() || dbCreateMenuOpenAt(pt)) {
    return [
      [
        I18n.t("输入节点（仅输出）"),
        [
          ctxKindItem("input_file", I18n.t("文件节点（批量导入任意文件）"), () =>
            addNode("input_file", pt.x, pt.y),
          ),
        ],
      ],
      [
        I18n.t("处理节点（提示词 + Play）"),
        [
          ctxKindItem("db_table", I18n.t("表（读取文件 · agent 建表）"), () =>
            addNode("db_table", pt.x, pt.y),
          ),
        ],
      ],
    ];
  }
  /* 子画布内（在展开的超级 / 工具壳层里右键，或全屏进入壳层后右键）：这两类节点可以
     继续往里加 —— 工具内部还能套工具与函数。顶层画布与子画布都列在「工具」一级菜单下
     （这里就是工具 / 函数节点的创建入口；顶栏「工具库」只管已保存的工具包，不建节点）；
     开发 / 数据库壳层是架构与事实容器，不列。 */
  const sfHost = currentSuperFocus()
    ? nodeById(currentSuperFocus())
    : superHostAtWorld(pt && pt.x, pt && pt.y);
  const inFlowShell =
    !!sfHost && isSuperLikeNode(sfHost) && !sfHost.db && !sfHost.dev;
  const allowToolMenu = !sfHost || inFlowShell;
  return [
    [
      "",
      [
        ctxAction(
          I18n.t("构建工作流（选择生成技能 · 填写要求）"),
          () => promptBuildWorkflow(pt),
          "build_wf",
          { iconCls: "wf" },
        ),
      ],
    ],
    [
      I18n.t("输入节点（仅输出）"),
      [
        ctxKindItem("input_text", I18n.t("文本节点"), () =>
          addNode("input_text", pt.x, pt.y),
        ),
        ctxKindItem("input_image", I18n.t("图像节点"), () =>
          addNode("input_image", pt.x, pt.y),
        ),
        /* 音频 / 视频输入：本机媒体文件选择 + 预览，输出端子给该文件的 file:/// URL */
        ctxKindItem("input_audio", I18n.t("音频节点（选择文件 · 输出 URL）"), () =>
          addNode("input_audio", pt.x, pt.y),
        ),
        ctxKindItem("input_video", I18n.t("视频节点（选择文件 · 输出 URL）"), () =>
          addNode("input_video", pt.x, pt.y),
        ),
      ],
    ],
    [
      /* 素材节点单列一组：这一组标题写的是「仅输出」，而素材每条内容都有一对端子
         （输入端子用来把新内容连进库），放进来会自相矛盾。 */
      I18n.t("素材节点（绑定素材库 · 内容条目即端子）"),
      [
        ctxKindItem(
          "asset",
          I18n.t("素材节点（绑定素材库 · 内容条目即端子）"),
          () => addNode("asset", pt.x, pt.y),
        ),
      ],
    ],
    [
      I18n.t("全局节点（仅连入 · 点左上角彩虹图标引用）"),
      [
        ctxKindItem(
          "global",
          I18n.t("全局节点（仅连入 · 点左上角彩虹图标引用）"),
          () => addNode("global", pt.x, pt.y),
        ),
      ],
    ],
    [
      I18n.t("处理节点（提示词 + Play）"),
      [
        ctxKindItem("proc_text", I18n.t("文本处理（LLM）"), () =>
          addNode("proc_text", pt.x, pt.y),
        ),
        ctxKindItem("proc_image", I18n.t("图像生成（文生图）"), () =>
          addNode("proc_image", pt.x, pt.y),
        ),
        /* 音频 / 视频生成：各自收进一个一级子菜单，成员按后端命名
           （菜单只显示括号前的短名，括号内为说明） */
        ctxSubmenu(I18n.t("视频生成"), "video_gen", "video", [
          ctxKindItem(
            "video_gen",
            I18n.t("Minimax H3（视频生成 · 文本 / 图像 / 音频 / 视频）"),
            () => addNode("video_gen", pt.x, pt.y),
          ),
          /* Remotion 插件节点：仅当已安装「remotion」应用插件时显示 */
          ...(appPluginInstalled("remotion")
            ? [
                ctxKindItem(
                  "remotion",
                  I18n.t("Remotion 视频（React 动效合成）"),
                  () => addNode("remotion", pt.x, pt.y),
                ),
              ]
            : []),
        ]),
        ctxSubmenu(I18n.t("音频生成"), "music_gen", "music", [
          ctxKindItem(
            "music_gen",
            I18n.t("Minimax Music 3（音乐生成 · 提示词 + 歌词）"),
            () => addNode("music_gen", pt.x, pt.y),
          ),
          ctxKindItem(
            "tts_gen",
            I18n.t("SoVITS 语音生成（文本转语音 · GPT-SoVITS）"),
            () => addNode("tts_gen", pt.x, pt.y),
          ),
        ]),
      ],
    ],
    [
      I18n.t("保存节点（接收最终输出）"),
      [
        ctxKindItem("save", I18n.t("保存（按输入自判）"), () =>
          addNode("save", pt.x, pt.y),
        ),
      ],
    ],
    [
      I18n.t("智能节点（读文件 / 联网 / 执行命令）"),
      [
        ctxKindItem(
          "agent_task",
          I18n.t("智能任务（读文件 / 联网 / 执行命令）"),
          () => addNode("agent_task", pt.x, pt.y),
        ),
      ],
    ],
    /* 「工具」一级菜单＝工具节点 / 函数节点的创建入口（顶栏只剩「工具库」管理已保存的包）。
       子画布内同样列出 → 工具内部可以继续套工具与函数。 */
    ...(allowToolMenu
      ? [
          [
            "",
            [
              ctxSubmenu(
                I18n.t("工具"),
                "tool",
                "proc",
                [
                  ctxKindItem(
                    "tool",
                    I18n.t("工具（Agent 可调用 · 入参出参端子）"),
                    () => addNode("tool", pt.x, pt.y),
                  ),
                  ctxKindItem(
                    "function",
                    I18n.t("函数（JS 计算 · 自定义入参出参）"),
                    () => addNode("function", pt.x, pt.y),
                  ),
                ],
              ),
            ],
          ],
        ]
      : []),
    [
      I18n.t("任务节点（规划 / 控制流执行）"),
      [
        ctxKindItem("task", I18n.t("任务（规划 · 可进入分段解决）"), () =>
          addNode("task", pt.x, pt.y),
        ),
        ctxKindItem("super", I18n.t("超级节点（收纳 · 展开子画布）"), () =>
          addNode("super", pt.x, pt.y),
        ),
      ],
    ],
    [
      "",
      [
        {
          label: I18n.t("开发节点（项目架构 · 功能块）"),
          iconKey: "dev",
          iconCls: "dev",
          submenu: [
            ctxKindItem(
              "super",
              I18n.t("功能块（模块 · 可细化 · 绑定开发会话）"),
              () =>
                addNode("super", pt.x, pt.y, {
                  dev: true,
                  devKind: "module",
                  devStatus: "pending",
                  title: I18n.t("功能块"),
                }),
              { iconKey: "dev", iconCls: "dev" },
            ),
            ctxKindItem(
              "super",
              I18n.t("文件（细化产物 · 指向源码文件）"),
              () =>
                addNode("super", pt.x, pt.y, {
                  dev: true,
                  devKind: "file",
                  devStatus: "pending",
                  title: I18n.t("文件"),
                }),
              { iconKey: "dev", iconCls: "dk-file" },
            ),
            ctxKindItem(
              "super",
              I18n.t("类（类图元素）"),
              () =>
                addNode("super", pt.x, pt.y, {
                  dev: true,
                  devKind: "class",
                  devStatus: "pending",
                  title: I18n.t("类"),
                }),
              { iconKey: "dev", iconCls: "dk-class" },
            ),
            ctxKindItem(
              "super",
              I18n.t("接口（类图元素）"),
              () =>
                addNode("super", pt.x, pt.y, {
                  dev: true,
                  devKind: "interface",
                  devStatus: "pending",
                  title: I18n.t("接口"),
                }),
              { iconKey: "dev", iconCls: "dk-interface" },
            ),
            ctxKindItem(
              "super",
              I18n.t("枚举（类图元素）"),
              () =>
                addNode("super", pt.x, pt.y, {
                  dev: true,
                  devKind: "enum",
                  devStatus: "pending",
                  title: I18n.t("枚举"),
                }),
              { iconKey: "dev", iconCls: "dk-enum" },
            ),
            ctxKindItem(
              "execute",
              I18n.t("执行（绑定 .exe / .bat / 任意文件 · 双击运行）"),
              () => addNode("execute", pt.x, pt.y),
            ),
          ],
        },
        {
          label: I18n.t("控制节点"),
          iconKey: "control",
          iconCls: "ctrl",
          submenu: [
            ctxKindItem("control", I18n.t("执行 / 清空"), () =>
              addNode("control", pt.x, pt.y),
            ),
            ctxKindItem("wait_file", I18n.t("需求等待（监视文件）"), () =>
              addNode("wait_file", pt.x, pt.y),
            ),
            ctxKindItem("timer", I18n.t("定时触发器（计划 / Cron）"), () =>
              addNode("timer", pt.x, pt.y),
            ),
            ctxKindItem("delayer", I18n.t("延时器（等待后继续）"), () =>
              addNode("delayer", pt.x, pt.y),
            ),
            ctxKindItem("sequencer", I18n.t("序列器（按序多路）"), () =>
              addNode("sequencer", pt.x, pt.y),
            ),
            ctxKindItem("gate", I18n.t("闸门（全部到达才放行）"), () =>
              addNode("gate", pt.x, pt.y),
            ),
            ctxKindItem("splitter", I18n.t("分发（并行多路）"), () =>
              addNode("splitter", pt.x, pt.y),
            ),
            ctxKindItem("counter", I18n.t("计数（每 N 次放行）"), () =>
              addNode("counter", pt.x, pt.y),
            ),
            ctxKindItem("mutex", I18n.t("互斥（多入选一）"), () =>
              addNode("mutex", pt.x, pt.y),
            ),
            ctxKindItem("judge", I18n.t("判断（是 / 否）"), () =>
              addNode("judge", pt.x, pt.y),
            ),
            ctxKindItem(
              "control",
              I18n.t("成功终点"),
              () =>
                addNode("control", pt.x, pt.y, {
                  ctrlRole: "endSuccess",
                  title: I18n.t("成功终点"),
                }),
              { ctrlRole: "endSuccess", iconCls: "ctrl-ok" },
            ),
            ctxKindItem(
              "control",
              I18n.t("失败终点"),
              () =>
                addNode("control", pt.x, pt.y, {
                  ctrlRole: "endFail",
                  title: I18n.t("失败终点"),
                }),
              { ctrlRole: "endFail", iconCls: "ctrl-fail" },
            ),
          ],
        },
        {
          label: I18n.t("其他节点（网络 · 批次拆分 / 合并）"),
          iconKey: "other",
          iconCls: "other",
          submenu: [
            ctxKindItem(
              "net_recv",
              I18n.t("网络 · 接收（监听通道 · 异步转发文本）"),
              () =>
                addNode("net_recv", pt.x, pt.y, {
                  netChannel: nextNetChannel(),
                  netProto: "tcp",
                }),
            ),
            ctxKindItem(
              "net_send",
              I18n.t("网络 · 发送（推送到通道 · TCP / UDP）"),
              () =>
                addNode("net_send", pt.x, pt.y, {
                  netChannel: nextNetChannel(),
                  netProto: "tcp",
                }),
            ),
            ctxKindItem("split", I18n.t("拆分（批次 → 单项只读节点）"), () =>
              addNode("split", pt.x, pt.y),
            ),
            ctxKindItem("merge", I18n.t("合并（多节点 → 批次）"), () =>
              addNode("merge", pt.x, pt.y),
            ),
          ],
        },
        {
          label: I18n.t("绘制"),
          iconKey: "draw",
          iconCls: "draw",
          submenu: [
            ctxAction(
              I18n.t("文本"),
              () => addMark("text", pt.x, pt.y),
              "mark_text",
              { iconCls: "draw" },
            ),
            /* 框体与箭头已移除：归类节点改用「组」，在习惯入口上给出替代方案指引 */
            ctxAction(
              I18n.t("【废弃】：框改为用「组」（选中节点后按 G）"),
              null,
              "menu_ungroup",
              { iconCls: "group" },
            ),
          ],
        },
      ],
    ],
  ];
}
function showCanvasCreateMenu(clientX, clientY, worldPt) {
  showCtx(clientX, clientY, canvasCreateMenuGroups(worldPt));
}

/* ============ 右键 · 构建工作流（选工具 = 工作流生成类技能 + 填写要求） ============ */

/* 「工作流生成」大类内部的优先顺序；画布规范类只是约束，不能当生成工具 */
const WF_BUILD_TYPE_RANK = { 画布搭建: 0, 开发架构: 1 };
const WF_BUILD_SKIP_TYPES = { 画布规范: true };
/* 这些内置技能带 .mtnode-internal 标记（skillList 不展示），需单独探测 */
const WF_BUILD_INTERNAL_SKILLS = ["mtnode-dev-architect"];

/** 从 SKILL.md 正文取 title / description（front matter，缺省回退首个 # 标题） */
function parseSkillMarkdownMeta(text) {
  const raw = String(text || "");
  const out = { title: "", description: "" };
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  const src = fm ? fm[1] : raw.slice(0, 6000);
  const t = src.match(/^title:[ \t]*(.+)$/m);
  if (t) out.title = String(t[1]).trim().replace(/^['"]|['"]$/g, "");
  const d = src.match(/^description:[ \t]*(.+)$/m);
  if (d) out.description = String(d[1]).trim().replace(/^['"]|['"]$/g, "");
  if (!out.title) {
    const h = raw.match(/^#\s+(.+)$/m);
    if (h) out.title = String(h[1]).trim();
  }
  out.title = out.title.slice(0, 40);
  out.description = out.description.replace(/\s+/g, " ").slice(0, 180);
  return out;
}

function wfBuildRank(s) {
  const r = s && WF_BUILD_TYPE_RANK[s.type];
  return typeof r === "number" ? r : 5;
}

/**
 * 构建工作流对话框的候选「工具」列表。
 * build = 工作流 / 画布生成类技能（默认只展示这些）；all = 全部可用技能。
 */
async function collectWorkflowBuildSkills() {
  const installed = ((await loadSkillsCached(false)) || []).filter(
    (s) => s && s.name && !isInstallOnlySkillName(s.name),
  );
  const all = [];
  const seen = new Set();
  for (const s of installed) {
    const c = skillMenuClassify(s);
    all.push({
      name: s.name,
      title: s.title || s.name,
      description: s.description || "",
      cat: c.cat,
      type: c.type,
    });
    seen.add(s.name);
  }
  /* 内置（隐藏）的画布构建技能：skillList 拿不到，逐个探测 */
  for (const nm of WF_BUILD_INTERNAL_SKILLS) {
    if (seen.has(nm)) continue;
    const sk = await resolveSkillByName(nm);
    if (!sk || !sk.body) continue;
    const meta = parseSkillMarkdownMeta(sk.body);
    const c = skillMenuClassify({
      name: nm,
      title: meta.title,
      description: meta.description,
    });
    all.push({
      name: nm,
      title: meta.title || nm,
      description: meta.description,
      cat: c.cat,
      type: c.type,
      internal: true,
    });
    seen.add(nm);
  }
  all.sort((a, b) => {
    const d = wfBuildRank(a) - wfBuildRank(b);
    if (d) return d;
    return String(a.title || a.name).localeCompare(
      String(b.title || b.name),
      "zh",
    );
  });
  const build = all.filter(
    (s) => s.cat === "workflow" && !WF_BUILD_SKIP_TYPES[s.type],
  );
  return { build, all };
}

/** 对话框内容：工具单选列表 + 「仅显示生成类」开关 + 要求输入框（写入 ref） */
function buildWorkflowToolPicker(host, groups, ref, state) {
  const lab = (text) => {
    const d = document.createElement("div");
    d.className = "wfb-lab";
    d.textContent = text;
    host.appendChild(d);
    return d;
  };
  lab(I18n.t("工具（工作流生成技能）"));
  const list = document.createElement("div");
  list.className = "wfb-list";
  host.appendChild(list);
  const footRow = document.createElement("div");
  footRow.className = "wfb-foot";
  host.appendChild(footRow);
  lab(I18n.t("构建要求"));
  const ta = document.createElement("textarea");
  ta.className = "mt-form-input wfb-req";
  ta.rows = 5;
  ta.placeholder = I18n.t(
    "例如：读取「素材清单」里的条目，逐条生成商品文案与主图提示词，输出 YAML 并保存；输入节点放上方，再给一个控制节点一键重跑……",
  );
  ta.value = String(state.req || "");
  host.appendChild(ta);
  const hint = document.createElement("p");
  hint.className = "mt-form-hint";
  hint.textContent = I18n.t(
    "Ctrl+Enter 开始构建 · Esc 取消 · 要求写得越具体（输入来源 / 处理步骤 / 输出格式），生成结果越接近预期",
  );
  host.appendChild(hint);
  ref.ta = ta;
  ref.focus = () => {
    setTimeout(() => {
      try {
        ta.focus();
      } catch (_) {}
    }, 0);
  };
  const render = () => {
    const shown =
      state.onlyBuild && groups.build.length ? groups.build : groups.all;
    list.innerHTML = "";
    footRow.innerHTML = "";
    if (!shown.some((s) => s.name === state.chosen))
      state.chosen = shown.length ? shown[0].name : "";
    for (const s of shown) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wfb-item" + (s.name === state.chosen ? " on" : "");
      b.title = "/" + s.name + (s.description ? "\n" + s.description : "");
      const ck = document.createElement("span");
      ck.className = "wfb-check";
      ck.textContent = s.name === state.chosen ? "✓" : "";
      const copy = document.createElement("span");
      copy.className = "wfb-copy";
      const nm = document.createElement("span");
      nm.className = "wfb-name";
      nm.textContent = s.title || s.name;
      const cmd = document.createElement("em");
      cmd.textContent = "/" + s.name;
      nm.appendChild(cmd);
      copy.appendChild(nm);
      if (s.description) {
        const ds = document.createElement("span");
        ds.className = "wfb-desc";
        ds.textContent = s.description;
        copy.appendChild(ds);
      }
      const tag = document.createElement("span");
      tag.className = "wfb-tag";
      tag.textContent = I18n.t(
        s.type || (s.cat === "workflow" ? "画布搭建" : "通用"),
      );
      b.appendChild(ck);
      b.appendChild(copy);
      b.appendChild(tag);
      b.onclick = () => {
        state.chosen = s.name;
        render();
      };
      list.appendChild(b);
    }
    if (!shown.length) {
      const e = document.createElement("div");
      e.className = "wfb-empty";
      e.textContent = I18n.t("暂无可用技能");
      list.appendChild(e);
    }
    if (groups.build.length) {
      const lb = document.createElement("label");
      lb.className = "wfb-filter";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!state.onlyBuild;
      cb.onchange = () => {
        state.onlyBuild = cb.checked;
        render();
      };
      const sp = document.createElement("span");
      sp.textContent = I18n.t("仅显示工作流生成类技能");
      lb.appendChild(cb);
      lb.appendChild(sp);
      footRow.appendChild(lb);
    }
    const cnt = document.createElement("i");
    cnt.textContent =
      I18n.t("共 ") +
      (state.onlyBuild && groups.build.length
        ? groups.build.length
        : groups.all.length) +
      I18n.t(" 个可选工具");
    footRow.appendChild(cnt);
  };
  render();
}

/* ============ 构建工作流 → 新建独立绑定会话（不再借用全局助手） ============ */

/* 会话标题「构建 · 画布名」：同一画布的构建会话靠它认出来（标题会随会话一起落盘，重启后仍有效） */
function wfBuildSessionTitle() {
  return I18n.t("构建 · ") + ((S.wf && S.wf.name) || I18n.t("未命名画布"));
}

/* 契约消息（会话首条）：只交代目标画布与工作边界；
   技能正文 + 构建要求由首轮「/技能名 要求」注入，正文不在上下文里重复两遍 */
function wfBuildContractText() {
  const name = (S.wf && S.wf.name) || I18n.t("未命名画布");
  const ws = wfWorkspace();
  const lines = [
    I18n.t("【画布构建任务书】") + " " + name,
    I18n.t(
      "本会话由画布右键「构建工作流」新建并绑定该画布：技能流程、构建要求与后续迭代都在这里进行，不再占用右侧全局助手。",
    ),
    I18n.t("工作范围：仅当前画布「") +
      name +
      I18n.t("」；动手改画布前先 mtnode_canvas_get 看清现状，不要编造已有节点。"),
  ];
  if (ws) lines.push(I18n.t("会话工作区：") + ws);
  lines.push(
    I18n.t(
      "严格按技能说明书写的流程执行：技能要求由用户提供信息（项目路径 / 拆解粒度 / 方案取舍）时，先询问并等待确认，不要臆测。",
    ),
  );
  return lines.join("\n");
}

/* 同一画布已有在跑的构建会话：两条会话同时改一张画布会互相覆盖，先挡住。
   占用判断走展示口径 sessionBusyForUi：它名下跑着计划并行组时 st.running 是 false，
   但那些子任务照样在往画布上写 —— 只看 sessionIsRunning 会放行第二条构建。 */
function runningWfBuildSession() {
  const title = wfBuildSessionTitle();
  return (
    agentSessions().find(
      (s) =>
        s &&
        s.title === title &&
        (typeof sessionBusyForUi === "function"
          ? sessionBusyForUi(s)
          : sessionIsRunning(s)),
    ) || null
  );
}

/* 每次发起构建都新建会话运行：上下文干净（首轮 = 任务书），工作区 = 画布统一目录，
   provider / model 跟随当前默认智能路由（与开发节点绑定会话同一套做法） */
function createWfBuildSession() {
  if (!S.wf) return null;
  const route =
    typeof preferredAgentProviderRoute === "function"
      ? preferredAgentProviderRoute()
      : "deepseek-official";
  const sess = {
    id: uid("as"),
    title: wfBuildSessionTitle(),
    workspace: dshWorkspaceOf(null),
    /* 所属画布 = 发起构建时用户看到的那张图（此后不随切画布漂移） */
    canvasWfId: currentVisibleWfId(),
    preset: AGENT_PRESET_DEFAULT,
    provider: route || "deepseek-official",
    model:
      typeof preferredAgentModelForRoute === "function"
        ? preferredAgentModelForRoute(route) || ""
        : "",
    effort: "high",
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  sess.messages.unshift({
    role: "user",
    content: wfBuildContractText(),
    _src: "wf-build",
    at: Date.now(),
  });
  agentSessions().unshift(sess);
  return sess;
}

/**
 * 右键 · 构建工作流：选择工作流生成类技能（工具）+ 填写要求
 * → 确认后将新建一个绑定当前画布的独立 agent 会话，在其中执行（改画布仍按用户的审批设置生效）。
 * 不再投递给全局助手：一轮架构还原会把大量扫描与画布编辑上下文灌进助手会话，污染全局助手。
 */
async function promptBuildWorkflow(pt, retryState) {
  if (!S.wf) return;
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  const groups = await collectWorkflowBuildSkills();
  if (!groups.all.length) {
    toast(
      I18n.t(
        "未找到可用的工作流生成技能：请先在 设置 → 技能 安装 generate-workflow / generate-task",
      ),
      "warn",
    );
    return;
  }
  const state = {
    chosen:
      (retryState && retryState.chosen) ||
      (groups.build.length ? groups.build[0].name : groups.all[0].name),
    req: (retryState && retryState.req) || "",
    onlyBuild: groups.build.length ? true : false,
  };
  const ref = {};
  const res = await mtDialogForm({
    title: I18n.t("构建工作流"),
    wide: true,
    rows: [
      [I18n.t("目标画布"), S.wf.name || I18n.t("未命名画布")],
    ],
    msg: I18n.t(
      "选择要使用的工具（工作流生成类技能），并填写要求。确认后将新建一个绑定当前画布的独立会话在其中执行（不使用全局助手）。",
    ),
    actions: [
      { id: "cancel", label: I18n.t("取消") },
      { id: "build", label: I18n.t("开始构建"), primary: true },
    ],
    custom: (host) => {
      buildWorkflowToolPicker(host, groups, ref, state);
      if (ref.focus) ref.focus();
    },
  });
  if (!res || res.action !== "build") return;
  const skill = groups.all.find((s) => s.name === state.chosen) || groups.all[0];
  const req = String((ref.ta && ref.ta.value) || "").trim();
  if (!req) {
    toast(I18n.t("请先填写构建要求"), "warn");
    await promptBuildWorkflow(pt, { chosen: skill.name, req: "" });
    return;
  }
  /* 先确认技能正文真取到了：内置技能（skillList 探测不到）读不到就直接中止，绝不静默丢技能 */
  const resolved = await resolveSkillByName(skill.name);
  if (!resolved || !String(resolved.body || "").trim()) {
    toast(
      I18n.t("技能正文读取失败，未发起构建：") + (skill.title || skill.name),
      "err",
    );
    return;
  }
  /* 占用判断只看构建会话自身（不再看全局助手是否在跑） */
  const busy = runningWfBuildSession();
  if (busy) {
    toast(
      I18n.t("该画布的构建会话正在执行中：请等待完成或先终止，再发起构建"),
      "warn",
    );
    return;
  }
  const sess = createWfBuildSession();
  if (!sess) return;
  S.agentActiveId = sess.id;
  await persistAgentSession();
  renderAgentSessionSidebar();
  updateRunQueuePanel();
  toast(
    I18n.t("已创建构建会话「") +
      (sess.title || "") +
      I18n.t("」并在后台运行（留在画布 · 左下角队列 / 会话列表可看进度）"),
    "ok",
  );
  try {
    /* 首轮注入「技能正文 + 构建要求」：正常走行首斜杠命令（agentSessionSend →
       resolveSkillSlash → skillTaskPrompt 就地展开成技能说明书），会话记录里只留一行
       /技能名，正文不重复入库。技能名含斜杠命令正则不接受的字符时展开不了，
       就直接注入正文，绝不静默丢技能。
       显式带 sessionId：这轮的归属就是刚建的构建会话，用户中途切会话也不会串台。 */
    const slashOk = /^[a-zA-Z0-9_-]+$/.test(String(skill.name || ""));
    const turn = slashOk
      ? "/" + skill.name + " " + req
      : skillTaskPrompt({
          name: skill.name,
          title: skill.title || skill.name,
          body: resolved.body,
          arg: req,
        });
    await agentSessionSend(turn, { sessionId: sess.id });
  } catch (err) {
    toast(
      I18n.t("构建会话启动失败：") + ((err && err.message) || String(err)),
      "err",
    );
  }
}


function bindCanvas() {
  const canvas = $("#canvas");
  /* 捕获阶段监听：即使鼠标在节点 / 组内部（其冒泡阶段可能 stopPropagation 或拦截事件），
     中键平移也能优先接管，避免节点过大挡住画布时无法拖动 */
  canvas.addEventListener(
    "mousedown",
    (ev) => {
      if (S._capturingCanvas) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.button === 1) {
        /* 中键：无论指针在节点 / 组 / 空白处都平移画布，且不改变当前选中 */
        ev.preventDefault();
        ev.stopPropagation();
        canvas.classList.add("midpan");
        setCanvasPanning(true);
        S.drag = {
          mode: "pan",
          button: 1,
          sx: ev.clientX,
          sy: ev.clientY,
          px: S.cam.x,
          py: S.cam.y,
          moved: false,
        };
        return;
      }
      if (ev.target === canvas || ev.target.id === "stage") {
        /* 关系线待定点在空白处：取消 */
        if (S.pendingRel) cancelPendingRel(true);
        /* 阻止原生拖选（否则拖动画布会误选到上方菜单等文字） */
        ev.preventDefault();
        const doBox = S.boxMode || ev.ctrlKey || ev.metaKey;
        if (ev.button === 0 && doBox) {
          /* 框选：拖拽矩形同时选择节点与绘制 */
          const pt = toStage(ev.clientX, ev.clientY);
          S.drag = {
            mode: "box",
            sx: ev.clientX,
            sy: ev.clientY,
            x0: pt.x,
            y0: pt.y,
            moved: false,
          };
          const r = document.createElement("div");
          r.id = "boxSel";
          r.className = "box-sel";
          $("#stage").appendChild(r);
          return;
        }
        S.drag = {
          mode: "pan",
          button: 0,
          sx: ev.clientX,
          sy: ev.clientY,
          px: S.cam.x,
          py: S.cam.y,
          moved: false,
        };
        setCanvasPanning(true);
      }
    },
    true,
  );
  /* 画布内禁止原生文字框选（输入框 / 节点输出 / 聊天 / 文字标注等可复制区除外）：
     鼠标拖动（节点 / 组 / 空白 / 端子 / 绘制等）一律不产生大范围选区，避免干扰画布操作 */
  document.addEventListener("selectstart", (ev) => {
    const t = ev.target;
    if (!t || typeof t.closest !== "function") return;
    if (!t.closest("#canvas")) return;
    if (
      t.closest(
        "input, textarea, select, [contenteditable], .n-out, .agent-conv, .chat-list, .mk-text",
      )
    )
      return;
    ev.preventDefault();
  });
  canvas.addEventListener(
    "wheel",
    (ev) => {
      if (S._capturingCanvas) {
        ev.preventDefault();
        return;
      }
      /* 节点内滚轮默认不缩放；展开超级节点内部舞台例外（与画布一致缩放镜头） */
      if (
        ev.target.closest(".wf-node") &&
        !ev.target.closest(".super-stage")
      )
        return;
      ev.preventDefault();
      /* 以鼠标位置为中心缩放：缩放前后鼠标下的舞台坐标保持不变 */
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left,
        my = ev.clientY - rect.top;
      const nz = Math.min(
        CAM_Z_MAX,
        Math.max(CAM_Z_MIN, S.cam.z * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)),
      );
      const ratio = nz / S.cam.z;
      S.cam.x = mx - (mx - S.cam.x) * ratio;
      S.cam.y = my - (my - S.cam.y) * ratio;
      S.cam.z = nz;
      /* 缩放只改 stage transform，连线在 stage 内无需重算；状态栏合并到下一帧 */
      S._zoomStatusPending = true;
      applyTransformSoon();
    },
    { passive: false },
  );

  window.addEventListener("mousemove", (ev) => {
    const d = S.drag;
    if (!d) return;
    /* 鼠标已松开（拖动窗口标题栏 / 鼠标移出后松开导致 mouseup 丢失）：
       清理悬空拖拽，避免陈旧状态被后续事件误处理。
       左键(1)或中键(4)都未按下视为已松开——中键平移同样走这套清理 */
    if (ev.buttons !== undefined && (ev.buttons & 5) === 0) {
      cancelDrag();
      return;
    }
    const dx = ev.clientX - d.sx,
      dy = ev.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.mode === "pan") {
      S.cam.x = d.px + dx;
      S.cam.y = d.py + dy;
      /* 平移只改相机 transform；连线随 #stage 一起移动，禁止每帧 updateWires */
      applyTransformSoon();
    } else if (d.mode === "node") {
      if (d.fromHandle && !d.moved) return;
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const dx = (ev.clientX - d.sx) / z,
        dy = (ev.clientY - d.sy) / z;
      applyNodeDragVisual(d, dx, dy);
      /* 框选混合选区：一并移动已选绘制 */
      if (d.origMarks) {
        for (const id of Object.keys(d.origMarks)) {
          const m = markById(id);
          const o = d.origMarks[id];
          if (!m || !o) continue;
          m.x = snap(o.x + dx);
          m.y = snap(o.y + dy);
          syncMarkDomPos(m);
        }
      }
      updateGroupFrames();
      snapBoundSaves(d.ids);
      updateSuperHoverExpand(ev, d.ids);
      {
        const touch = d.idSet || (d.idSet = new Set(d.ids));
        for (const id of d.ids) {
          const n = nodeById(id);
          if (!n || n.kind !== "super" || !n.superOpen) continue;
          for (const c of superChildrenOf(n.id)) touch.add(c.id);
        }
        updateWires(touch);
      }
    } else if (d.mode === "box") {
      const pt = toStage(ev.clientX, ev.clientY);
      const r = document.getElementById("boxSel");
      if (r) {
        const x = Math.min(d.x0, pt.x),
          y = Math.min(d.y0, pt.y);
        r.style.left = x + "px";
        r.style.top = y + "px";
        r.style.width = Math.abs(pt.x - d.x0) + "px";
        r.style.height = Math.abs(pt.y - d.y0) + "px";
      }
      if (Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) > 3)
        d.moved = true;
    } else if (d.mode === "group") {
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const dx = (ev.clientX - d.sx) / z,
        dy = (ev.clientY - d.sy) / z;
      for (const id of Object.keys(d.orig || {})) {
        const n = nodeById(id);
        if (!n) continue;
        n.x = snap(d.orig[id].x + dx);
        n.y = snap(d.orig[id].y + dy);
        const el = document.querySelector('.wf-node[data-nid="' + id + '"]');
        if (el) {
          el.style.left = n.x + "px";
          el.style.top = n.y + "px";
        }
      }
      for (const id of Object.keys(d.origMarks || {})) {
        const m = markById(id);
        const o = d.origMarks[id];
        if (!m || !o) continue;
        m.x = snap(o.x + dx);
        m.y = snap(o.y + dy);
        syncMarkDomPos(m);
      }
      updateGroupFrames();
      snapBoundSaves(Object.keys(d.orig || {}));
      updateWires(d.idSet || (d.idSet = new Set(Object.keys(d.orig || {}))));
    } else if (d.mode === "groupresize") {
      const g = groupById(d.gid);
      if (!g) return;
      const pt = toStage(ev.clientX, ev.clientY);
      let sx = d.axes !== "y" ? (pt.x - d.ax - GROUP_PAD) / d.w0 : 1;
      let sy = d.axes !== "x" ? (pt.y - d.ay - GROUP_PAD) / d.h0 : 1;
      const c = clampGroupScale(g, sx, sy, d.orig, d.origMarks);
      scaleGroup(g, c.sx, c.sy, d.ax, d.ay, d.orig, d.origMarks);
      updateGroupFrames();
      updateWires(d.idSet || (d.idSet = new Set(Object.keys(d.orig || {}))));
    } else if (d.mode === "superpan") {
      const n = nodeById(d.id);
      if (!n || n.kind !== "super") return;
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const pdx = (ev.clientX - d.sx) / z;
      const pdy = (ev.clientY - d.sy) / z;
      n.innerPanX = d.ox + pdx;
      n.innerPanY = d.oy + pdy;
      const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
      const stage = el && el.querySelector(".super-stage");
      const vp = stage && stage.querySelector(".super-stage-viewport");
      if (vp) {
        vp.style.transform =
          "translate(" + n.innerPanX + "px," + n.innerPanY + "px)";
      }
      if (stage) {
        const gg = grid();
        stage.style.setProperty(
          "--super-grid-x",
          gridMod(n.innerPanX || 0, gg) + "px",
        );
        stage.style.setProperty(
          "--super-grid-y",
          gridMod(n.innerPanY || 0, gg) + "px",
        );
      }
      updateWires(
        d.idSet ||
          (d.idSet = new Set(
            [n.id].concat(superChildrenOf(n.id).map((c) => c.id)),
          )),
      );
    } else if (d.mode === "resize") {
      const n = nodeById(d.id);
      if (!n) return;
      /* 有输出面板时（含智能运行中），节点最小宽度需容纳输入框最小宽 + 输出面板宽，避免出界 */
      const r = selResult(n);
      const hasOut =
        !!(n.running && isDshTask(n)) ||
        !!(r && (r.output || r.batchOutputs || r.error));
      const chromeMin = Math.max(minWFor(n), Number(n._chromeMinW) || 0);
      const minW = hasOut ? Math.max(chromeMin, procMinNodeW(n.outW)) : chromeMin;
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const openSuper = superIsOpenShell(n);
      if (openSuper) {
        n.expandW = snapDim(d.ow + dx / z, 320);
        n.expandH = snapDim(d.oh + dy / z, 220);
      } else {
        n.w = snapDim(d.ow + dx / z, minW);
        n.h = snapDim(d.oh + dy / z, minHFor(n));
      }
      const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
      if (el) {
        const sz = n.kind === "super" ? superDisplaySize(n) : { w: n.w, h: n.h };
        el.style.width = sz.w + "px";
        el.style.height = sz.h + "px";
        refreshPorts(el, n);
        /* 拉宽 / 收窄超级节点：文件夹标题随可用宽度重新缩字 */
        if (n.kind === "super") fitSuperFolderCard(el);
      }
      updateGroupFrames();
      updateWires(d.idSet || (d.idSet = new Set([d.id])));
    } else if (d.mode === "outresize") {
      const n = nodeById(d.id);
      if (!n) return;
      /* 左侧边缘拖动:向左拉宽(+dx 为负 → 加宽),向右收窄 */
      n.outW = Math.max(
        PROC_OUT_MIN,
        Math.min(PROC_OUT_MAX, Math.round(d.ow - dx / S.cam.z)),
      );
      n.w = Math.max(n.w, procMinNodeW(n.outW));
      const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
      if (el) {
        el.style.width = n.w + "px";
        const out = el.querySelector(".n-out");
        if (out) out.style.width = n.outW + "px";
        refreshPorts(el, n);
      }
      /* 输出宽度变化后，节点高度随之自适应 */
      autoFitOutputHeight(n);
    } else if (d.mode === "entryresize") {
      const n = nodeById(d.id);
      if (!n) return;
      const e = (n.entries || []).find((x) => x.id === d.eid);
      if (!e) return;
      e.h = Math.max(40, Math.min(320, Math.round(d.oh + dy / S.cam.z)));
      const el = document.querySelector(
        '.wf-node[data-nid="' +
          n.id +
          '"] .bentry-text[data-eid="' +
          e.id +
          '"]',
      );
      if (el) el.style.height = e.h + "px";
    } else if (d.mode === "vresize") {
      const n = nodeById(d.id);
      if (!n) return;
      /* 把手在框体顶部：上拖增高、下拖变矮（与底部把手方向相反） */
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const h = Math.max(
        d.minH,
        Math.min(
          d.maxH,
          Math.round(d.oh - (ev.clientY - d.sy) / z),
        ),
      );
      n[d.key] = h;
      const box = document.querySelector(
        '.wf-node[data-nid="' + d.id + '"] [data-vbox="' + d.key + '"]',
      );
      if (box) box.style.height = h + "px";
    } else if (d.mode === "mark") {
      const z = S.cam.z > 0 ? S.cam.z : 1;
      const mdx = (ev.clientX - d.sx) / z,
        mdy = (ev.clientY - d.sy) / z;
      const ids = d.ids && d.ids.length ? d.ids : d.id ? [d.id] : [];
      for (const id of ids) {
        const m = markById(id);
        const o = d.orig && d.orig[id];
        if (!m) continue;
        if (o) {
          m.x = snap(o.x + mdx);
          m.y = snap(o.y + mdy);
        } else {
          /* 兼容旧单元素拖拽字段（绘制只剩 text，无箭头端点） */
          m.x = snap(d.ox + mdx);
          m.y = snap(d.oy + mdy);
        }
        syncMarkDomPos(m);
      }
      /* 框选混合选区：一并移动已选节点 */
      if (d.origNodes) {
        for (const id of Object.keys(d.origNodes)) {
          const n = nodeById(id);
          const o = d.origNodes[id];
          if (!n || !o) continue;
          n.x = snap(o.x + mdx);
          n.y = snap(o.y + mdy);
          const el = document.querySelector('.wf-node[data-nid="' + id + '"]');
          if (el) {
            el.style.left = n.x + "px";
            el.style.top = n.y + "px";
          }
        }
        updateWires(
          d.nodeIdSet ||
            (d.nodeIdSet = new Set(Object.keys(d.origNodes))),
        );
      }
      updateGroupFrames();
    } else if (d.mode === "markresize") {
      const m = markById(d.id);
      if (!m || m.kind !== "text") return;
      const z = S.cam.z > 0 ? S.cam.z : 1;
      m.w = Math.max(40, Math.round(d.ow + (ev.clientX - d.sx) / z));
      m.h = Math.max(24, Math.round(d.oh + (ev.clientY - d.sy) / z));
      const el = document.querySelector('.wf-mark[data-mid="' + m.id + '"]');
      if (el) {
        el.style.width = m.w + "px";
        el.style.height = m.h + "px";
      }
    } else if (d.mode === "wire") {
      d.mx = ev.clientX;
      d.my = ev.clientY;
      if (!d.moved && wireDragMoved(d, ev)) d.moved = true;
      /* 反向拖线（输入端→输出端）时悬停目标为 .port.out，否则为 .port.in */
      const selCls = d.fromInput ? ".port.out" : ".port.in";
      document
        .querySelectorAll(selCls + ".hover")
        .forEach((p) => p.classList.remove("hover"));
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      let port = el && el.closest ? el.closest(selCls) : null;
      /* 命中不到时按 1.5×端子半径近邻兜底，悬停高亮更宽容 */
      if (!port) port = portHitAt(ev.clientX, ev.clientY, selCls);
      if (port) port.classList.add("hover");
      updateWires();
    }
  });
  window.addEventListener("mouseup", (ev) => {
    const d = S.drag;
    if (!d) return;
    document
      .querySelectorAll(".port.in.hover, .port.out.hover")
      .forEach((p) => p.classList.remove("hover"));
    if (d.mode === "wire") {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const fromId = d.fromId;
      const fromIndex = d.fromIndex || 0;
      const fromBridge = !!d.superInnerBridge;
      const fromInput = !!d.fromInput;
      const movedDrag = !!d.moved;
      S.drag = null;
      updateWires();
      if (fromInput) {
        /* 反向拖线：起点是某节点的输入端子，终点落在输出端子上 → 存为 输出端 → 输入端 */
        let port = el && el.closest ? el.closest(".port.out") : null;
        if (!port) port = portHitAt(ev.clientX, ev.clientY, ".port.out");
        if (port) {
          const outId = port.dataset.node;
          const outIdx = Number(port.dataset.fromIndex || 0);
          const inNode = nodeById(fromId);
          const outNode = nodeById(outId);
          if (port.classList.contains("super-inner-bridge")) {
            /* 落在超级节点内侧输入端子（桥）：等价于 桥 → 内部节点输入 */
            if (
              !inNode ||
              !outNode ||
              outNode.kind !== "super" ||
              nodeParentSuperId(inNode) !== outId
            ) {
              toast(
                I18n.t("内侧输入端子只能连接到超级节点内部的节点"),
                "warn",
              );
            } else {
              connect(outId, fromId, fromIndex, outIdx);
            }
          } else {
            connect(outId, fromId, fromIndex, outIdx);
          }
        }
      } else {
        let port = el && el.closest ? el.closest(".port.in") : null;
        if (!port) port = portHitAt(ev.clientX, ev.clientY, ".port.in");
        if (port) {
          const toId = port.dataset.node;
          const toNode = nodeById(toId);
          const fromNode = nodeById(fromId);
          if (fromBridge) {
            if (!toNode || nodeParentSuperId(toNode) !== fromId) {
              toast(I18n.t("内侧输入端子只能连接到超级节点内部的节点"), "warn");
            } else {
              connect(fromId, toId, Number(port.dataset.idx), fromIndex);
            }
          } else if (
            port.classList.contains("super-inner-sink") &&
            (!toNode ||
              toNode.kind !== "super" ||
              nodeParentSuperId(fromNode) !== toId)
          ) {
            toast(I18n.t("内侧输出端子只能接收超级节点内部的连线"), "warn");
          } else {
            connect(fromId, toId, Number(port.dataset.idx), fromIndex);
          }
        } else {
          /* 没有落在任何输入端子上：向外拉出后松手在画布空白处 → 就地弹出「可连入的节点」菜单，
             选一个即在该位置建节点并把这条线连进去（判定与 connectError 同一套规则） */
          maybeOpenWireDropCreateMenu({
            ev,
            el,
            fromId,
            fromIndex,
            fromBridge,
            moved: movedDrag,
          });
        }
      }
    } else if (d.mode === "box") {
      const pt = toStage(ev.clientX, ev.clientY);
      const r = document.getElementById("boxSel");
      if (r) r.remove();
      S.drag = null;
      if (d.moved) {
        const x0 = Math.min(d.x0, pt.x),
          y0 = Math.min(d.y0, pt.y),
          x1 = Math.max(d.x0, pt.x),
          y1 = Math.max(d.y0, pt.y);
        const sel = S.wf.nodes.filter((n) => {
          if (!nodeInCurrentScope(n)) return false;
          const p = nodeWorldPos(n);
          const sz = nodeDrawSize(n);
          return p.x <= x1 && p.x + sz.w >= x0 && p.y <= y1 && p.y + sz.h >= y0;
        });
        const markSel = marksOf().filter((m) => {
          const b = markBounds(m);
          return b && b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0;
        });
        S.selSet = new Set(sel.map((n) => n.id));
        S.sel = sel.length ? sel[sel.length - 1].id : null;
        const mset = ensureSelMarkSet();
        mset.clear();
        for (const m of markSel) mset.add(m.id);
        S.selMark = markSel.length ? markSel[markSel.length - 1].id : null;
        S.selGroup = null;
        S.selWire = null;
      } else {
        clearSelection();
      }
      renderCanvas();
    } else if (d.mode === "node") {
      const fromHandle = !!d.fromHandle;
      const handleNid = d.handleNid;
      const wasMoved = !!d.moved;
      const dragIds = d.ids || [];
      const curWorld = d.curWorld || null;
      const hadNested = !!d.hadNested;
      S.drag = null;
      /* 拖拽结束：移除拖拽 class 并复位仿射变换（利用基础 transition 惯性回落） */
      document
        .querySelectorAll(".wf-node.node-dragging")
        .forEach((el) => {
          el.classList.remove("node-dragging");
          el.style.transform = "";
        });
      setNodeDragLift(false);
      if (wasMoved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      } else {
        S.preDragSnap = null;
      }
      let nested = false;
      if (wasMoved) {
        nested = finalizeNodeDragNest(dragIds, curWorld);
        if (hadNested) nested = true;
      }
      clearSuperDropHot(!!nested);
      updateGroupFrames();
      const skipToggle =
        ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0;
      if (
        fromHandle &&
        !wasMoved &&
        !skipToggle &&
        toggleNodeGlobalRefs(nodeById(handleNid))
      ) {
        /* 点击手柄已切换全局引用并重绘 */
      } else if (nested) {
        renderCanvas();
        scheduleSave(true);
      } else {
        scheduleSave();
      }
    } else if (d.mode === "group" || d.mode === "groupresize") {
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      }
      updateGroupFrames();
      scheduleSave();
      renderStatus();
    } else if (d.mode === "superpan") {
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      } else {
        S.preDragSnap = null;
      }
      scheduleSave();
    } else if (d.mode === "mark" || d.mode === "markresize") {
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      }
      scheduleSave();
    } else if (
      d.mode === "resize" ||
      d.mode === "outresize" ||
      d.mode === "entryresize" ||
      d.mode === "vresize"
    ) {
      const resizedId = d.id;
      const wasExpand =
        d.mode === "resize" &&
        (() => {
          const n = nodeById(d.id);
          return !!(n && n.kind === "super" && n.superOpen);
        })();
      S.drag = null;
      if (d.moved && S.preDragSnap) {
        pushHistory(S.preDragSnap);
        S.preDragSnap = null;
      }
      scheduleSave();
      if (wasExpand) renderCanvas();
      /* 输入/会话框高度变化后，让节点高度跟随左侧内容 */
      if (d.mode === "vresize") {
        const n = nodeById(resizedId);
        if (n) autoFitOutputHeight(n);
      }
    } else if (d.mode === "pan") {
      const wasMid = d.button === 1;
      S.drag = null;
      setCanvasPanning(false);
      canvas.classList.remove("midpan");
      /* 中键平移不改变当前选择；左键在空白处点击（未拖动）才清空选择 */
      if (!d.moved && !wasMid) {
        clearSelection();
        renderCanvas();
      }
    }
  });

  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.target === canvas || ev.target.id === "stage") {
      showCanvasCreateMenu(ev.clientX, ev.clientY, toStage(ev.clientX, ev.clientY));
    }
  });

  canvas.addEventListener("dragover", (ev) => ev.preventDefault());
  canvas.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    const files = [...(ev.dataTransfer.files || [])];
    if (!files.length) return;
    const pt = toStage(ev.clientX, ev.clientY);
    /* 数据库超级节点：拖入文件 → 复制到子文件夹（入库待编译） */
    const dbTarget = S.wf.nodes.find(
      (n) => {
        if (n.kind !== "super" || !n.db) return false;
        const ds = superDisplaySize(n);
        return (
          pt.x >= n.x &&
          pt.x <= n.x + (ds.w || n.w) &&
          pt.y >= n.y &&
          pt.y <= n.y + (ds.h || n.h)
        );
      },
    );
    if (dbTarget) {
      const dir = dbNodeDir(dbTarget);
      if (!dir) {
        toast(I18n.t("先设置工作目录与数据库子文件夹，再拖入文件"), "warn");
        return;
      }
      let copied = 0;
      for (const f of files) {
        const p = window.api.getPathForFile(f);
        if (!p) continue;
        const dest = window.api.pathJoin(dir, f.name || "file");
        const r = await window.api.fileCopyAssetTo(p, dest).catch(() => null);
        if (r && r.ok !== false) copied++;
      }
      if (copied) {
        toast(
          I18n.t("已放入 {n} 个文件到数据库子文件夹 · 点击 ⚙ 编译（增量）入库", {
            n: copied,
          }),
          "ok",
        );
      }
      return;
    }
    const target = S.wf.nodes.find(
      (n) =>
        n.kind === "input_image" &&
        pt.x >= n.x &&
        pt.x <= n.x + n.w &&
        pt.y >= n.y &&
        pt.y <= n.y + n.h,
    );
    /* 数据库「文件节点」：拖入任意文件 → 复制进数据库子文件夹 */
    const fileTarget = S.wf.nodes.find(
      (n) =>
        n.kind === "input_file" &&
        pt.x >= n.x &&
        pt.x <= n.x + n.w &&
        pt.y >= n.y &&
        pt.y <= n.y + n.h,
    );
    if (fileTarget) {
      const dir = dbSuperDir(fileTarget);
      if (!dir) {
        toast(I18n.t("未设置数据库子文件夹，无法导入文件"), "warn");
        return;
      }
      let added = 0;
      for (const f of files) {
        const p = window.api.getPathForFile(f);
        if (!p) continue;
        const name = String(f.name || "file");
        const dest = await dbUniqueDest(dir, name);
        await window.api.fileCopyAssetTo(p, dest).catch(() => {});
        const st = await window.api.fileStat(dest).catch(() => null);
        (fileTarget.files = fileTarget.files || []).push({
          id: uid("f"),
          name: String(dest).split(/[\\/]/).pop() || name,
          path: dest,
          rel: window.api.pathRelative(dir, dest) || name,
          size: (st && st.size) || 0,
          mtime: (st && st.mtime) || 0,
          type: dbFileType(dest),
        });
        added++;
      }
      if (added) {
        clearDownstream(fileTarget.id);
        scheduleSave();
        renderCanvas();
        toast(I18n.t("已导入 ") + added + I18n.t(" 个文件"), "ok");
      }
      return;
    }
    /* 音频 / 视频输入节点：拖入同类型媒体文件 → 直接替换引用（原绝对路径） */
    const mediaTarget = S.wf.nodes.find(
      (n) =>
        (n.kind === "input_audio" || n.kind === "input_video") &&
        pt.x >= n.x &&
        pt.x <= n.x + n.w &&
        pt.y >= n.y &&
        pt.y <= n.y + n.h,
    );
    if (mediaTarget) {
      const want = mediaTarget.kind === "input_video" ? "video" : "audio";
      let picked = "";
      for (const f of files) {
        const p = window.api.getPathForFile(f);
        if (p && mediaKindOfPath(p) === want) {
          picked = p;
          break;
        }
      }
      if (!picked) {
        toast(
          want === "video"
            ? I18n.t("此节点只接收视频文件（mp4 / mov / webm…）")
            : I18n.t("此节点只接收音频文件（mp3 / wav / ogg…）"),
          "warn",
        );
        return;
      }
      pushHistory();
      setNodeMedia(mediaTarget, picked);
      renderCanvas();
      toast(I18n.t("已载入：") + fileName(picked), "ok");
      return;
    }
    if (!target) {
      /* 落点没有可接收文件的节点：不再弹「请拖到图像节点」警告，
         而是按扩展名逐文件自动建节点（图像 / 文本 / 音频 / 视频 / 其他→开发文件块） */
      await createNodesFromDroppedFiles(files, pt);
      return;
    }
    if (target.ro) {
      toast(I18n.t("拆分出的只读节点，不可修改"), "warn");
      return;
    }
    if (inputInherited(target)) {
      toast(I18n.t("该节点已继承输入，内容只读"), "warn");
      return;
    }
    if (target.batch) {
      let added = 0;
      for (const f of files) {
        const p = window.api.getPathForFile(f);
        if (!p) continue;
        const copied = await copyImageFromPath(p, target.id);
        target.entries.push(
          makeImageBatchEntry(copied.path, copied.sourceName),
        );
        added++;
      }
      if (added) {
        clearDownstream(target.id);
        scheduleSave();
        renderCanvas();
        toast(I18n.t("已载入 ") + added + I18n.t(" 张图像到批量节点"), "ok");
      }
      return;
    }
    const p = window.api.getPathForFile(files[0]);
    if (!p) {
      toast(I18n.t("无法读取该文件路径"), "err");
      return;
    }
    const copied = await copyImageFromPath(p, target.id);
    if (target.imageAsset) invalidateImageMeta(target.imageAsset);
    target.imageAsset = copied.path;
    target.sourceName = copied.sourceName;
    clearDownstream(target.id);
    scheduleSave();
    renderCanvas();
    toast(I18n.t("图像已载入输入节点"), "ok");
  });

  /* 记录最近一次鼠标点击的元素（捕获阶段）：Ctrl+A 需判断焦点是否落在「可复制文本的输出区」 */
  let _lastClickEl = null;
  document.addEventListener(
    "mousedown",
    (ev) => {
      _lastClickEl = ev.target && ev.target.nodeType === 1 ? ev.target : null;
    },
    true,
  );
  /* 允许浏览器原生全选（Ctrl+A）的容器：输入框由 inField 单独放行，这里是输出 / 弹层等可复制文本区 */
  const SELECTABLE_TEXT_HOSTS =
    ".assist-list, .agent-list, .agent-body, .chat-list, .agent-conv, .n-out, " +
    ".app-docs-article, .app-docs-box, .md, .dsh-msg-body, .overlay, .mt-dialog";

  window.addEventListener("keydown", (ev) => {
    const tag = (ev.target.tagName || "").toLowerCase();
    const inField =
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      !!ev.target.isContentEditable;
    const docsHost = document.getElementById("appDocsDlg");
    if (docsHost && docsHost.classList.contains("on")) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        appDocsOnEscape();
      }
      return;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    const key = (ev.key || "").toLowerCase();
    /* Ctrl+F / Ctrl+G：当前画布查找 / 替换（输入框内也拦截，避免落到浏览器查找） */
    if (mod && (key === "f" || key === "g") && !ev.altKey) {
      if (S.view === "workflow" || S.view === "agent") {
        if (S.view === "agent") setView("workflow");
        ev.preventDefault();
        openCanvasFindBar({ replace: key === "g" });
        return;
      }
    }
    if (ev.key === "Escape" && closeCanvasFindBar()) {
      ev.preventDefault();
      return;
    }
    /* Esc 收起画布菜单（右键「新建节点」/ 拖线落点「新建并连入」）：菜单没有焦点，靠 Esc 关掉 */
    if (ev.key === "Escape" && hideOpenCtx()) {
      ev.preventDefault();
      return;
    }
    /* 开发节点的弹出层（HSV 色板 / Agent 模型清单）：Esc 收起（在 Hex 输入框里也生效） */
    if (ev.key === "Escape" && (S.uiDevColorNode || S.uiDevModelNode)) {
      ev.preventDefault();
      if (S.uiDevModelNode && typeof closeDevModelPicker === "function")
        closeDevModelPicker();
      if (S.uiDevColorNode && typeof closeDevColorPicker === "function")
        closeDevColorPicker();
      return;
    }
    /* 查找栏内：不触发画布 Delete / G 等快捷键 */
    if (isCanvasFindBarTarget(ev.target)) return;
    /* 节点 / 绘制文字等输入中：不触发任何画布快捷键。
       @ 引用菜单由输入框自己的 keydown 调 refKey 处理——这里不能再调一次，
       否则一次上下键会被消费两遍（跳两格）。 */
    if (inField) return;
    /* Ctrl+A：输入框内由浏览器全选；可复制文本的输出区（助手 / 会话 / 聊天 / 文档 / 弹层等）
       保留原生全选；其余场合（画布 / 普通面板焦点）拦截，避免整页文字被框选——
       画布视图改为全选当前范围内的节点与绘制（与框选同一套命中口径） */
    if (mod && key === "a") {
      if (S.view !== "workflow") return;
      const host =
        (ev.target && ev.target.nodeType === 1 ? ev.target : null) ||
        _lastClickEl;
      if (host && host.closest && host.closest(SELECTABLE_TEXT_HOSTS)) return;
      ev.preventDefault();
      selectAllNodesInScope();
      return;
    }
    /* Ctrl+C：有文字选区时交给浏览器复制；否则把选中的节点（含子节点）/ 绘制存入临时粘贴板 */
    if (mod && key === "c") {
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).length) return;
      const assistPane = document.getElementById("assistPane");
      if (
        assistPane &&
        ((ev.target && assistPane.contains(ev.target)) ||
          (document.activeElement &&
            assistPane.contains(document.activeElement)))
      )
        return;
      ev.preventDefault();
      if (!copyNodesToClipboard())
        toast(I18n.t("请先选中节点或绘制"), "warn");
      return;
    }
    /* Ctrl+V：把粘贴板中的节点 / 绘制粘贴到当前视口中心（输入框 / 文字选区内不拦截，交给原生粘贴） */
    if (mod && key === "v") {
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).length) return;
      const assistPane = document.getElementById("assistPane");
      if (
        assistPane &&
        ((ev.target && assistPane.contains(ev.target)) ||
          (document.activeElement &&
            assistPane.contains(document.activeElement)))
      )
        return;
      ev.preventDefault();
      pasteNodesFromClipboard();
      return;
    }
    if (mod && key === "z") {
      ev.preventDefault();
      if (ev.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === "y") {
      ev.preventDefault();
      redo();
      return;
    }
    if (key === "g" && !mod) {
      ev.preventDefault();
      toggleGroupAction();
      return;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      if (S.selWire) {
        pushHistory();
        removeWire(S.selWire);
        S.selWire = null;
        renderCanvas();
        scheduleSave(true);
        renderStatus();
      } else {
        const markIds =
          S.selMarkSet && S.selMarkSet.size
            ? [...S.selMarkSet]
            : S.selMark
              ? [S.selMark]
              : [];
        const nodeIds = S.selSet && S.selSet.size ? [...S.selSet] : [];
        if (markIds.length && nodeIds.length) {
          (async () => {
            const delSet = new Set(nodeIds);
            const linkedSessions = [];
            for (const n of S.wf.nodes) {
              if (!delSet.has(n.id)) continue;
              let sessIds = [];
              if (n.kind === "agent_task" && n.agentSessionId)
                sessIds = [n.agentSessionId];
              else if (n.kind === "super" && n.dev) sessIds = devSessionIdsOf(n);
              for (const sid of sessIds) {
                const sess = agentSessions().find((s) => s.id === sid);
                if (sess && !linkedSessions.includes(sess)) linkedSessions.push(sess);
              }
            }
            if (linkedSessions.length) {
              const names = I18n.listJoin(
                linkedSessions.map((s) => s.title || I18n.t("新会话")),
              );
              if (
                !(await confirmDialog(
                  I18n.t("删除节点将一并删除其关联的智能会话：\n") +
                    names +
                    I18n.t("\n\n会话记录不可恢复，确定删除？"),
                  {
                    title: I18n.t("确认删除"),
                    danger: true,
                    okText: I18n.t("删除"),
                  },
                ))
              )
                return;
            }
            pushHistory();
            deleteMarks(markIds, true);
            await deleteNodes(nodeIds, true);
            renderCanvas();
            scheduleSave(true);
            renderStatus();
            toast(
              I18n.t("已删除 ") +
                nodeIds.length +
                I18n.t(" 个节点") +
                " · " +
                markIds.length +
                I18n.t(" 项绘制"),
              "ok",
            );
          })();
        } else if (markIds.length) {
          deleteMarks(markIds);
        } else if (nodeIds.length) {
          /* 有节点选中（可能与组同时选中）→ 先删除节点，组内成员自动清理 */
          deleteNodes(nodeIds);
        } else if (S.selGroup) {
          deleteGroup(S.selGroup);
        }
      }
    } else if (ev.key === "Escape") {
      const box = document.getElementById("boxSel");
      if (box) box.remove();
      if (S.drag && S.drag.mode === "box") S.drag = null;
      if (S.pendingRel) {
        cancelPendingRel(true);
        renderCanvas();
        return;
      }
      clearSelection();
      closeRefMenu();
      renderCanvas();
    }
  });

  window.addEventListener(
    "mousedown",
    (ev) => {
      if (S.refMenu) {
        const m = $("#refMenu");
        if (!m.contains(ev.target)) closeRefMenu();
      }
      if (S.slashMenu) {
        const m = $("#refMenu");
        if (!m.contains(ev.target)) closeSlashMenu();
      }
      /* 节点「设置」已改为跳窗（#overlay · persistent），不再有点外部就地收起的内联面板；
         关窗只走「完成并关闭」/ ✕ / 切画布 / 撤销 / 删节点（见 closeNodeSettingsDialog）。 */
      if (S.uiBgRmNode) {
        const pop = $("#bgRmPop");
        if (pop && pop.classList.contains("on") && !pop.contains(ev.target)) {
          const btn = document.querySelector(
            '.wf-node[data-nid="' + S.uiBgRmNode + '"] .n-bgrm-btn',
          );
          if (!btn || !btn.contains(ev.target)) closeBgRmPop();
        }
      }
      if (S.uiDevModelNode) {
        const pop = $("#devModelPop");
        if (pop && pop.classList.contains("on") && !pop.contains(ev.target)) {
          const btn = document.querySelector(
            '.wf-node[data-nid="' + S.uiDevModelNode + '"] .n-dev-model',
          );
          if (!btn || !btn.contains(ev.target)) closeDevModelPicker();
        }
      }
      if (S.uiDevColorNode) {
        const pop = $("#devColorPop");
        if (pop && pop.classList.contains("on") && !pop.contains(ev.target)) {
          const btn = document.querySelector(
            '.wf-node[data-nid="' + S.uiDevColorNode + '"] .n-dev-color',
          );
          if (!btn || !btn.contains(ev.target)) closeDevColorPicker();
        }
      }
    },
    true,
  );
}

/* ============ 右键菜单 ============ */

function applyCtxParenHover(el, raw) {
  if (el) el.removeAttribute("title");
  return splitCtxParenLabel(raw).label;
}

function appendCtxItem(parent, it) {
  if (!it) return;
  if (Array.isArray(it.submenu) && it.submenu.length) {
    const fly = document.createElement("div");
    fly.className = "ctx-fly";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-fly-btn" + (it.cls ? " " + it.cls : "");
    if (it.iconKey) {
      const svg = KIND_ICON_SVG[it.iconKey];
      if (svg) {
        const ic = document.createElement("span");
        ic.className = "ctx-kind-icon kind-" + (it.iconCls || "ctrl");
        ic.innerHTML = svg;
        b.appendChild(ic);
      }
    }
    const lab = document.createElement("span");
    lab.textContent = applyCtxParenHover(b, it.label);
    const caret = document.createElement("span");
    caret.className = "ctx-caret";
    caret.textContent = "›";
    b.appendChild(lab);
    b.appendChild(caret);
    const sub = document.createElement("div");
    sub.className = "ctx-sub";
    for (const child of it.submenu) appendCtxItem(sub, child);
    const CTX_SUB_LINGER_MS = 320;
    const clearFlyHide = () => {
      if (fly._ctxHideTimer) {
        clearTimeout(fly._ctxHideTimer);
        fly._ctxHideTimer = null;
      }
    };
    const openFly = () => {
      clearFlyHide();
      const root = fly.closest(".fn-ctx") || parent;
      root.querySelectorAll(".ctx-fly.open").forEach((el) => {
        if (el !== fly) {
          if (el._ctxHideTimer) {
            clearTimeout(el._ctxHideTimer);
            el._ctxHideTimer = null;
          }
          el.classList.remove("open");
        }
      });
      placeSub();
      fly.classList.add("open");
    };
    const scheduleCloseFly = () => {
      clearFlyHide();
      fly._ctxHideTimer = setTimeout(() => {
        fly.classList.remove("open");
        fly._ctxHideTimer = null;
      }, CTX_SUB_LINGER_MS);
    };
    const placeSub = () => {
      sub.classList.remove("open-left");
      sub.style.top = "";
      sub.style.bottom = "";
      sub.style.maxHeight = "";
      const wasOpen = fly.classList.contains("open");
      fly.classList.add("open");
      const pad = 8;
      const fr = fly.getBoundingClientRect();
      const sr0 = sub.getBoundingClientRect();
      const sw = sr0.width || 200;
      if (fr.right + 2 + sw > window.innerWidth - pad && fr.left - 2 - sw >= pad)
        sub.classList.add("open-left");
      const sh = sub.getBoundingClientRect().height || sr0.height;
      const maxH = Math.max(80, window.innerHeight - pad * 2);
      /* 二级菜单向上展开：底部与一级选项底边对齐；上方空间不够时贴顶并限制高度 */
      if (sh > maxH || fr.bottom - sh < pad) {
        sub.style.bottom = "auto";
        sub.style.top = pad - fr.top + "px";
        sub.style.maxHeight = maxH + "px";
      } else {
        sub.style.top = "auto";
        sub.style.bottom = "0px";
      }
      if (!wasOpen) fly.classList.remove("open");
    };
    fly.addEventListener("mouseenter", openFly);
    fly.addEventListener("mouseleave", scheduleCloseFly);
    b.addEventListener("focus", openFly);
    b.addEventListener("blur", () => {
      /* 焦点仍在本 fly（如进了二级按钮）则不关 */
      requestAnimationFrame(() => {
        if (!fly.contains(document.activeElement)) scheduleCloseFly();
      });
    });
    fly.appendChild(b);
    fly.appendChild(sub);
    parent.appendChild(fly);
    return;
  }
  const b = document.createElement("button");
  b.type = "button";
  if (it.cls) b.className = it.cls;
  const kindSvg = it.iconKey && KIND_ICON_SVG[it.iconKey];
  if (kindSvg) {
    b.classList.add("ctx-kind");
    const ic = document.createElement("span");
    ic.className = "ctx-kind-icon kind-" + (it.iconCls || "proc");
    ic.innerHTML = kindSvg;
    const lab = document.createElement("span");
    lab.className = "ctx-kind-lab";
    lab.textContent = applyCtxParenHover(b, it.label);
    b.appendChild(ic);
    b.appendChild(lab);
  } else {
    b.textContent = applyCtxParenHover(b, it.label);
  }
  b.onclick = () => {
    hideCtx();
    if (typeof it.run === "function") it.run();
  };
  parent.appendChild(b);
}

function ctxKindItem(kind, label, run, extra) {
  extra = extra || {};
  const dummy = { kind: kind, ctrlRole: extra.ctrlRole || "" };
  return {
    label,
    iconKey: extra.iconKey || nodeKindIconKey(dummy),
    iconCls: extra.iconCls || nodeKindIconCls(dummy),
    run,
  };
}

/* 一级菜单项（带二级子菜单）：与 ctxKindItem 同族，只是不直接建节点而是展开成员清单 */
function ctxSubmenu(label, iconKey, iconCls, submenu) {
  return { label, iconKey, iconCls, submenu };
}

function ctxAction(label, run, iconKey, extra) {
  extra = extra || {};
  const key = iconKey || extra.iconKey || "";
  return {
    label,
    run,
    iconKey: key,
    iconCls: extra.iconCls || key,
    cls: extra.cls,
  };
}

/* ============ 拖线落在画布空白处：就地「新建并连入」 ============
   从输出端子向外拉、松手在画布空白处 → 在松手处弹出「这条线能连进哪些节点」的菜单；
   选一项即在落点建好该节点，并把这条线连进它的输入端子。
   「能不能连」不在这里另写一套规则：临时用真实 makeNode 造一个候选节点（落点相同 → 父子层级相同），
   跑一遍真正的 connectError 判定，规则只有一份真源——端子占用 / 文本图像限制 / 控制线约束都自动跟着变。 */
/* 候选目标清单：只列「值得在这里新建」的类型（顺序 = 菜单里的优先级）。
   刻意不收：定时 / 需求等待 / 接收 / 执行（没有输入端子，试连也过不去）；
   音频 / 视频输入（只是本机媒体文件选择器，不进执行引擎，连进去没有意义）。 */
const WIRE_DROP_TARGETS = [
  { kind: "proc_text", g: "处理节点" },
  { kind: "proc_image", g: "处理节点" },
  { kind: "music_gen", g: "处理节点" },
  { kind: "tts_gen", g: "处理节点" },
  { kind: "video_gen", g: "处理节点" },
  { kind: "remotion", g: "处理节点", plugin: "remotion" },
  { kind: "agent_task", g: "智能节点" },
  { kind: "save", g: "保存节点" },
  { kind: "tool", g: "工具节点" },
  { kind: "function", g: "工具节点" },
  { kind: "task", g: "任务节点" },
  { kind: "super", g: "任务节点" },
  { kind: "control", g: "控制节点", label: "执行 / 清空" },
  { kind: "judge", g: "控制节点" },
  { kind: "delayer", g: "控制节点" },
  { kind: "sequencer", g: "控制节点" },
  { kind: "gate", g: "控制节点" },
  { kind: "splitter", g: "控制节点" },
  { kind: "counter", g: "控制节点" },
  { kind: "mutex", g: "控制节点" },
  {
    kind: "control",
    g: "控制节点",
    label: "成功终点",
    titleKey: "成功终点",
    ctrlRole: "endSuccess",
  },
  {
    kind: "control",
    g: "控制节点",
    label: "失败终点",
    titleKey: "失败终点",
    ctrlRole: "endFail",
  },
  { kind: "split", g: "批次节点" },
  { kind: "merge", g: "批次节点" },
  { kind: "net_send", g: "网络节点", net: true },
  { kind: "global", g: "全局节点" },
  { kind: "input_text", g: "输入节点" },
  { kind: "input_image", g: "输入节点" },
  /* 素材节点：有内容条目时才有输入端子（条目类型决定这条线能不能落），
     未绑定 / 无条目的候选节点会被真实 connectError 自动挡在菜单外。 */
  { kind: "asset", g: "输入节点" },
];

/** 候选项建节点时要带的参数（试连与真正建节点共用同一份，保证判定结果一致） */
function wireDropExtraOf(spec) {
  const extra = {};
  if (spec.ctrlRole) extra.ctrlRole = spec.ctrlRole;
  if (spec.net) {
    extra.netChannel = nextNetChannel();
    extra.netProto = "tcp";
  }
  return extra;
}

/** 菜单项文案：与右键「新建节点」同一批 i18n key（括号说明由 ctx 菜单自动转成 hover 提示） */
function wireDropLabelOf(spec) {
  if (spec.label) return I18n.t(spec.label);
  const purpose = nodeKindPurposeKey({ kind: spec.kind });
  if (purpose) return I18n.t(purpose);
  const d = NODE_DEFAULTS[spec.kind];
  return I18n.t((d && d.title) || "节点");
}

/** 试连：候选节点临时插入当前工作流跑真实 connectError，判定完立刻摘掉（不渲染 / 不入历史 / 不落盘） */
function wireDropConnectError(fromNode, spec, extra, worldPt, fromIndex) {
  const probe = makeNode(spec.kind, worldPt.x, worldPt.y);
  if (!probe) return I18n.t("未知节点类型");
  for (const k of Object.keys(extra || {})) probe[k] = extra[k];
  ensureDefaultSavePath(probe);
  S.wf.nodes.push(probe);
  let err = null;
  try {
    err = connectError(fromNode.id, probe.id, null, Number(fromIndex || 0));
  } catch (e) {
    err = String((e && e.message) || e || "connect check failed");
  }
  const i = S.wf.nodes.indexOf(probe);
  if (i >= 0) S.wf.nodes.splice(i, 1);
  return err;
}

/** 组装这条线在落点处能连的节点菜单（分组 + 建节点并连线） */
function wireDropMenuGroups(fromNode, fromIndex, worldPt) {
  const out = [];
  const byTitle = new Map();
  for (const spec of WIRE_DROP_TARGETS) {
    if (spec.plugin && !appPluginInstalled(spec.plugin)) continue;
    const extra = wireDropExtraOf(spec);
    if (wireDropConnectError(fromNode, spec, extra, worldPt, fromIndex)) continue;
    const gt = I18n.t(spec.g);
    let items = byTitle.get(gt);
    if (!items) {
      items = [];
      byTitle.set(gt, items);
      out.push([gt, items]);
    }
    const titleKey = spec.titleKey;
    items.push(
      ctxKindItem(
        spec.kind,
        wireDropLabelOf(spec),
        () => {
          if (!nodeById(fromNode.id)) return;
          const node = addNode(
            spec.kind,
            worldPt.x,
            worldPt.y,
            Object.assign({}, extra, titleKey ? { title: I18n.t(titleKey) } : null),
          );
          if (!node || !nodeById(node.id)) return;
          connect(fromNode.id, node.id, null, Number(fromIndex || 0));
        },
        { ctrlRole: spec.ctrlRole || "" },
      ),
    );
  }
  return out;
}

/** 松手这一下会紧跟着派发 click，而 click 冒泡到 window 上就是 hideCtx ——
    菜单刚弹出会被立刻关掉。这里吞掉这一次 click，等它过去了再开菜单。 */
function showCtxAfterMouseClick(clientX, clientY, groups) {
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    window.removeEventListener("click", swallowClick, true);
    showCtx(clientX, clientY, groups);
  };
  function swallowClick(e) {
    e.stopPropagation();
    e.preventDefault();
    open();
  }
  window.addEventListener("click", swallowClick, true);
  /* 没有紧随的 click（例如在窗口外松手）也要开菜单：兜底一个短延时 */
  setTimeout(open, 160);
}

/** 松手处算不算「画布空白处」：画布空白与展开壳内的空白算；命中节点卡片、端子或画布外不算 */
function wireDropLandsOnEmptyCanvas(el) {
  if (!el || typeof el.closest !== "function") return false;
  if (!el.closest("#canvas") || el.closest("#ctx")) return false;
  if (el.closest(".port")) return false;
  /* 展开的超级节点：壳里每个子节点都是宿主 .wf-node 的后代，宿主卡片本身也在 .super-stage 之外 */
  if (el.closest(".super-stage-viewport .wf-node")) return false;
  if (el.closest(".wf-node") && !el.closest(".super-stage")) return false;
  return true;
}

/** 拖线松手落在空白处：判定 + 弹出可连入的节点菜单 */
function maybeOpenWireDropCreateMenu(a) {
  const ev = a && a.ev;
  /* 只在原地点一下端子（moved=false）、壳层内侧桥接端子：保持原有行为，不弹菜单 */
  if (!ev || !a.moved || a.fromBridge) return;
  if (!wireDropLandsOnEmptyCanvas(a.el)) return;
  const from = nodeById(a.fromId);
  if (!from || !hasOutput(from)) return;
  const worldPt = toStage(ev.clientX, ev.clientY);
  const groups = wireDropMenuGroups(from, Number(a.fromIndex || 0), worldPt);
  if (!groups.length) return;
  showCtxAfterMouseClick(ev.clientX, ev.clientY, groups);
}

function showCtx(x, y, groups) {
  hideNodeTitleTip();
  const ctx = $("#ctx");
  ctx.innerHTML = "";
  for (const entry of groups || []) {
    if (!Array.isArray(entry)) continue;
    const gtitle = entry[0];
    const items = entry[1];
    if (!Array.isArray(items) || !items.length) continue;
    if (gtitle) {
      const g = document.createElement("div");
      g.className = "ctx-group";
      g.textContent = applyCtxParenHover(g, gtitle);
      ctx.appendChild(g);
    } else if (ctx.childNodes.length) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      ctx.appendChild(sep);
    }
    for (const it of items) appendCtxItem(ctx, it);
  }
  ctx.style.display = "block";
  const vw = window.innerWidth,
    vh = window.innerHeight;
  const rect = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, vw - Math.max(rect.width, 168) - 8) + "px";
  ctx.style.top = Math.min(y, vh - Math.max(rect.height, 40) - 8) + "px";
}
function hideCtx() {
  hideNodeTitleTip();
  const ctx = $("#ctx");
  if (ctx) {
    ctx.querySelectorAll(".ctx-fly").forEach((fly) => {
      if (fly._ctxHideTimer) {
        clearTimeout(fly._ctxHideTimer);
        fly._ctxHideTimer = null;
      }
      fly.classList.remove("open");
    });
    ctx.style.display = "none";
  }
}
/** 画布菜单（右键新建 / 拖线落点新建）当前是否开着：开着就收起并返回 true */
function hideOpenCtx() {
  const ctx = $("#ctx");
  if (!ctx || ctx.style.display === "none" || !ctx.childElementCount) return false;
  hideCtx();
  return true;
}

/* 输出面板图像右键菜单：另存为 */
function bindImgSaveAs(img) {
  img.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const p = img.dataset.path;
    showCtx(ev.clientX, ev.clientY, [
      [
        I18n.t("图像操作"),
        [
          p
            ? ctxAction(I18n.t("另存为…"), () => saveImageAs(p), "menu_saveas", {
                iconCls: "sv",
              })
            : ctxAction(I18n.t("（图像尚未生成）"), () => {}, "menu_preview", {
                iconCls: "muted",
              }),
          p
            ? ctxAction(
                I18n.t("预览图像"),
                () => openImageLightbox(p, img.alt || ""),
                "menu_preview",
                { iconCls: "in" },
              )
            : null,
        ].filter(Boolean),
      ],
    ]);
  });
}

/* 工作流内图像预览弹窗（点击缩略图） */
function closeImageLightbox() {
  const el = $("#imgLightbox");
  if (el) {
    el.classList.remove("on");
    const body = el.querySelector("#imgLbBody");
    if (body) body.innerHTML = "";
  }
}
function openImageLightbox(path, title) {
  const p = String(path || "").trim();
  if (!p) {
    toast(I18n.t("文件不存在或无法预览"), "warn");
    return;
  }
  let el = $("#imgLightbox");
  if (!el) {
    el = document.createElement("div");
    el.id = "imgLightbox";
    el.className = "img-lightbox";
    el.innerHTML =
      '<div class="img-lb-box">' +
      '<div class="img-lb-head"><b id="imgLbTitle"></b>' +
      '<button type="button" class="mini" id="imgLbClose">✕</button></div>' +
      '<div class="img-lb-body" id="imgLbBody"></div>' +
      '<div class="img-lb-foot" id="imgLbFoot"></div></div>';
    document.body.appendChild(el);
    el.querySelector("#imgLbClose").onclick = closeImageLightbox;
    el.addEventListener("click", (ev) => {
      if (ev.target === el) closeImageLightbox();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && el.classList.contains("on")) {
        closeImageLightbox();
      }
    });
  }
  const name = title || fileName(p) || I18n.t("预览图像");
  el.querySelector("#imgLbTitle").textContent = name;
  const body = el.querySelector("#imgLbBody");
  body.innerHTML = "";
  body.classList.add("checker");
  const img = document.createElement("img");
  img.className = "img-lb-img";
  img.alt = name;
  img.src = fileUrlWithBust(p, Date.now());
  img.onerror = () => {
    body.innerHTML = "";
    body.classList.remove("checker");
    const g = document.createElement("div");
    g.className = "img-lb-ph";
    g.textContent = I18n.t("文件不存在或无法预览");
    body.appendChild(g);
  };
  body.appendChild(img);
  const foot = el.querySelector("#imgLbFoot");
  foot.innerHTML = "";
  const pathHint = document.createElement("span");
  pathHint.className = "img-lb-path";
  pathHint.textContent = p;
  pathHint.title = p;
  foot.appendChild(pathHint);
  const saveBtn = document.createElement("button");
  saveBtn.className = "mini";
  saveBtn.textContent = I18n.t("另存为…");
  saveBtn.onclick = () => saveImageAs(p);
  foot.appendChild(saveBtn);
  const closeBtn = document.createElement("button");
  closeBtn.className = "mini primary";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = closeImageLightbox;
  foot.appendChild(closeBtn);
  el.classList.add("on");
}

/* 绑定缩略图点击 → 大图预览；path 可写在 dataset.path，便于后续刷新 src */
function bindImagePreview(img, path, title) {
  if (!img) return img;
  const p0 = path || img.dataset.path || "";
  if (p0) img.dataset.path = p0;
  if (title) img.alt = title;
  img.classList.add("img-previewable");
  const tip = I18n.t("点击查看大图");
  if (!img.title) img.title = tip;
  else if (img.title.indexOf(tip) < 0) img.title = tip + " · " + img.title;
  if (img.dataset.previewBound === "1") return img;
  img.dataset.previewBound = "1";
  img.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const p = img.dataset.path || path;
    if (!p) {
      toast(I18n.t("文件不存在或无法预览"), "warn");
      return;
    }
    openImageLightbox(p, title || img.alt || fileName(p));
  });
  return img;
}
async function saveImageAs(p) {
  const ext = (extOf(p) || ".png").toLowerCase();
  const filters =
    ext === ".jpg" || ext === ".jpeg"
      ? [{ name: I18n.t("JPEG 图像"), extensions: ["jpg", "jpeg"] }]
      : ext === ".gif"
        ? [{ name: I18n.t("GIF 图像"), extensions: ["gif"] }]
        : ext === ".webp"
          ? [{ name: I18n.t("WebP 图像"), extensions: ["webp"] }]
          : [{ name: I18n.t("PNG 图像"), extensions: ["png"] }];
  const r = await window.api.fileSaveDialog({
    title: I18n.t("另存为"),
    defaultName: fileName(p),
    filters,
  });
  if (!r.path) return;
  try {
    await window.api.fileCopyAssetTo(p, r.path);
    toast(I18n.t("已保存：") + r.path, "ok");
  } catch {
    toast(I18n.t("保存失败"), "err");
  }
}

function assignDefaultProvider(node) {
  if (node.kind === "proc_text" || node.kind === "remotion") {
    const prov = (S.config.providers || []).find((p) => p.type === "text_openai");
    if (prov) {
      node.providerId = prov.id;
      node.model = (prov.models || [])[0] || "";
    }
  } else if (node.kind === "proc_image") {
    const prov = (S.config.providers || []).find((p) =>
      String(p.type || "").startsWith("image_"),
    );
    if (prov) {
      node.providerId = prov.id;
      node.model = (prov.models || [])[0] || "";
    }
  }
}

/* 节点「创建 kind」→「存储形态」换算：工具节点的规范形态是超级节点变体
   （kind:"super" + tool:true，沿用 db:/dev: 变体模式，契约见 docs/tool-function-nodes.md）。
   右键「工具」一级菜单、拖线落点候选、工具包快照等入口一律写 "tool"，落盘在此统一换算；
   判定永远走 isToolNode()，不要再比较 kind === "tool"。 */
const NODE_FORM_OF_KIND = { tool: "super" };

function makeNode(kind, x, y) {
  if (kind === "save_text" || kind === "save_image") kind = "save";
  const d = NODE_DEFAULTS[kind];
  if (!d) return null;
  const node = {
    id: uid("n"),
    kind: NODE_FORM_OF_KIND[kind] || kind,
    x: snap(x),
    y: snap(y),
    w: d.w,
    h: d.h,
  };
  for (const [k, v] of Object.entries(d)) {
    if (k === "w" || k === "h") continue;
    node[k] = JSON.parse(JSON.stringify(v));
  }
  assignDefaultProvider(node);
  if (node.kind === "agent_task") syncAgentProviderRoute(node);
  node.parentTaskId = currentTaskFocus();
  const sf = currentSuperFocus();
  const sfHost = sf ? nodeById(sf) : null;
  if (sf && sfHost && sfHost.kind === "super") {
    node.parentSuperId = sf;
    node.parentTaskId = sfHost.parentTaskId || "";
  } else {
    /* superFocus 失效（指向已不存在的超级节点）时不挂幽灵父级，退回按坐标找宿主 */
    const host = superHostAtWorld(x, y);
    if (host) {
      const o = superInnerOrigin(host);
      const pan = superInnerPan(host);
      node.parentSuperId = host.id;
      node.parentTaskId = host.parentTaskId || "";
      node.x = snap(Math.max(8, x - host.x - o.ox - pan.x));
      node.y = snap(Math.max(8, y - host.y - o.oy - pan.y));
    } else {
      node.parentSuperId = "";
    }
  }
  return node;
}

function uniqueNodeTitle(desired, exceptId) {
  const base = String(desired || "").trim() || I18n.t("节点");
  const taken = new Set(
    (S.wf.nodes || [])
      .filter((n) => n.id !== exceptId)
      .map((n) => n.title),
  );
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + " " + i)) i++;
  return base + " " + i;
}

function addNode(kind, x, y, extra) {
  if (kind === "save_text" || kind === "save_image") kind = "save";
  const d = NODE_DEFAULTS[kind];
  if (!d) return;
  const node = makeNode(kind, x, y);
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (k === "title") continue;
      node[k] = v;
    }
  }
  const want =
    extra && extra.title
      ? extra.title
      : (() => {
          const raw = I18n.t(d.title);
          /* 「超级节点」等标题已含「节点」，勿再拼成「超级节点节点」 */
          if (/节点\s*$/.test(raw) || /node\s*$/i.test(raw)) return raw;
          return raw + I18n.t("节点");
        })();
  if (extra && extra.title) node.title = uniqueNodeTitle(want);
  else {
    const same = S.wf.nodes.filter((n) => n.title === want).length;
    node.title = same ? want + " " + (same + 1) : want;
  }
  /* 开发节点（右键「开发节点 · 功能块」等 addNode 入口）：创建即按功能色卡上色。
     extra 里显式给了 devColor 时优先；未归类块保持元素类型默认色。 */
  if (typeof devAutoColorNode === "function") devAutoColorNode(node);
  ensureDefaultSavePath(node);
  pushHistory();
  S.wf.nodes.push(node);
  if (kind === "task") ensureTaskScaffold(node);
  S.sel = node.id;
  S.selWire = null;
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(I18n.t("已添加节点：") + node.title, "ok");
  if (isMediaGenNode(node)) {
    ensureBackendUiState(node).ok = null;
    probeMediaBackend(node, { quiet: true });
  }
  return node;
}

/* ============ 拖外部文件进画布空白处：按类型自动建节点 ============
 * 图像 → input_image（复制进工作流资产）；文本/代码 → input_text（读正文，超大截断）；
 * 音频 / 视频 → input_audio / input_video（只引用原绝对路径）；
 * 其他（未知扩展名、二进制、无扩展名）→ 开发节点「文件」块，路径写进概述。
 * 先把所有磁盘 IO 做完（复制失败 / 读不出来的文件降级成文件块），再一次性建节点：
 * 一次 pushHistory（一步撤销全部）、网格排布、建完全选、一条汇总 toast。 */
const DROP_FILE_STEP_X = 340;
const DROP_FILE_STEP_Y = 250;
/* 文本节点正文保留上限（字节）：超过只留开头一段并在正文里标注截断 */
const DROP_TEXT_KEEP_BYTES = 2 * 1024 * 1024;
/* 超过这个大小干脆不读入：避免把上百 MB 文本经 IPC 灌进渲染层，只留路径提示 */
const DROP_TEXT_MAX_READ_BYTES = 32 * 1024 * 1024;

/* 拖入文件名 → 节点标题：开发文件块保留扩展名，输入节点用主名（与图像节点口径一致） */
function dropNodeTitle(p, keepExt) {
  const name = String(fileName(p) || "").trim() || I18n.t("文件");
  if (keepExt) return name;
  return name.replace(/\.[^.]+$/, "").trim() || name;
}

/* 字节数 → 可读文案（真源是 app-canvas.js 的 formatBytes，它在本文件之后加载，故做存在性兜底） */
function humanBytes(n) {
  return typeof formatBytes === "function"
    ? formatBytes(n)
    : Math.round(Number(n) || 0) + " B";
}

/* 拖入的「其他」文件 → 开发节点文件块概述（两段式：【功能】设计说明 + 【实现】路径） */
function devFileBlockNote(absPath) {
  return I18n.t(
    "【功能】外部拖入画布的文件资源：{name}，仅作引用与快速打开，不参与工作流数据流。\n【实现】绝对路径：{path}",
    { name: fileName(absPath) || I18n.t("文件"), path: absPath },
  );
}

/* 读取拖入的文本文件；返回 null = 读不出来（调用方降级成文件块） */
async function readDroppedTextFile(p, size) {
  if (size > DROP_TEXT_MAX_READ_BYTES) {
    return {
      text: I18n.t("（文件过大，未读入内容 {size}）完整文件见：\n{path}", {
        size: humanBytes(size),
        path: p,
      }),
      truncated: true,
    };
  }
  const rr = await window.api.fileReadText(p).catch(() => null);
  if (!rr || !rr.exists) return null;
  let text = String(rr.content || "");
  let truncated = false;
  if (text.length > DROP_TEXT_KEEP_BYTES) {
    text = text.slice(0, DROP_TEXT_KEEP_BYTES);
    truncated = true;
  }
  if (truncated) {
    text +=
      "\n\n" +
      I18n.t("…（正文超过 {size}，已截断，完整内容见原文件：\n{path}）", {
        size: humanBytes(DROP_TEXT_KEEP_BYTES),
        path: p,
      });
  }
  return { text, truncated };
}

/* files：DataTransfer.files（或同形的 [{path}]）；pt：落点（舞台坐标） */
async function createNodesFromDroppedFiles(files, pt) {
  const list = [...(files || [])];
  const items = [];
  /* noPath = 连本机路径都取不到（无法登记）；unreadable = 内容/复制失败，已降级成文件块 */
  let noPath = 0;
  let unreadable = 0;
  for (const f of list) {
    const p =
      (f && f.path) ||
      (window.api.getPathForFile ? window.api.getPathForFile(f) : "");
    if (!p) {
      noPath++;
      continue;
    }
    items.push({ path: p, kind: classifyDropFile(p), name: fileName(p) });
  }
  if (!items.length) {
    toast(I18n.t("无法读取该文件路径"), "err");
    return;
  }
  /* 先做完磁盘 IO：图像复制进资产、文本读正文；失败的一律降级成开发文件块 */
  for (const it of items) {
    if (it.kind === "image") {
      try {
        it.copied = await copyImageFromPath(
          it.path,
          dropNodeTitle(it.path, false),
        );
      } catch (_) {
        it.copied = null;
        it.kind = "other";
        unreadable++;
      }
    } else if (it.kind === "text") {
      const st = await window.api.fileStat(it.path).catch(() => null);
      it.size = (st && st.size) || 0;
      const rd = await readDroppedTextFile(it.path, it.size);
      if (!rd) {
        it.text = "";
        it.kind = "other";
        unreadable++;
      } else {
        it.text = rd.text;
        if (rd.truncated) it.truncated = true;
      }
    }
  }
  const cols = items.length <= 2 ? items.length : items.length <= 6 ? 3 : 4;
  const count = { image: 0, text: 0, audio: 0, video: 0, other: 0 };
  let truncated = 0;
  pushHistory();
  const created = [];
  const originX = (pt && Number(pt.x)) || 0;
  const originY = (pt && Number(pt.y)) || 0;
  items.forEach((it, i) => {
    const x = originX + (i % cols) * DROP_FILE_STEP_X;
    const y = originY + Math.floor(i / cols) * DROP_FILE_STEP_Y;
    let node = null;
    if (it.kind === "image") {
      node = makeNode("input_image", x, y);
      if (node) {
        node.imageAsset = it.copied.path;
        node.sourceName = it.copied.sourceName;
        node.title = uniqueNodeTitle(dropNodeTitle(it.path, false));
        count.image++;
      }
    } else if (it.kind === "text") {
      node = makeNode("input_text", x, y);
      if (node) {
        node.text = it.text || "";
        node.title = uniqueNodeTitle(dropNodeTitle(it.path, false));
        count.text++;
        if (it.truncated) truncated++;
      }
    } else if (it.kind === "audio" || it.kind === "video") {
      node = makeNode(it.kind === "video" ? "input_video" : "input_audio", x, y);
      if (node) {
        setNodeMedia(node, it.path);
        node.title = uniqueNodeTitle(dropNodeTitle(it.path, false));
        count[it.kind]++;
      }
    } else {
      node = makeNode("super", x, y);
      if (node) {
        node.dev = true;
        node.devKind = "file";
        node.devStatus = "pending";
        node.devColor = "";
        node.note = devFileBlockNote(it.path);
        node.title = uniqueNodeTitle(it.name || dropNodeTitle(it.path, true));
        count.other++;
      }
    }
    if (!node) return;
    if (typeof devAutoColorNode === "function") devAutoColorNode(node);
    ensureDefaultSavePath(node);
    S.wf.nodes.push(node);
    created.push(node.id);
  });
  if (!created.length) {
    toast(I18n.t("创建节点失败"), "err");
    return;
  }
  clearSelection();
  S.selSet = new Set(created);
  S.sel = created[0];
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  const parts = [];
  if (count.image) parts.push(I18n.t("图像") + " " + count.image);
  if (count.text) parts.push(I18n.t("文本") + " " + count.text);
  if (count.audio) parts.push(I18n.t("音频") + " " + count.audio);
  if (count.video) parts.push(I18n.t("视频") + " " + count.video);
  if (count.other) parts.push(I18n.t("文件") + " " + count.other);
  let msg =
    I18n.t("已创建 {n} 个节点：", { n: created.length }) + parts.join(" / ");
  if (truncated)
    msg += " · " + I18n.t("{n} 个文件过大，正文已截断", { n: truncated });
  if (unreadable)
    msg += " · " + I18n.t("{n} 个文件读不出内容，改为文件块", { n: unreadable });
  if (noPath)
    msg += " · " + I18n.t("{n} 个文件取不到本机路径，已跳过", { n: noPath });
  toast(msg, truncated || unreadable || noPath ? "warn" : "ok");
  return created;
}

function toggleBatch(node) {
  pushHistory();
  node.batch = !node.batch;
  if (node.batch) {
    if (node.kind === "input_text" && !node.entries.length && node.text) {
      node.entries.push({
        id: uid("e"),
        title: node.title,
        content: node.text,
      });
    }
    if (
      node.kind === "input_image" &&
      !node.entries.length &&
      node.imageAsset
    ) {
      const sn =
        String(node.sourceName || "").trim() ||
        imageStem(node.imageAsset) ||
        "img";
      node.entries.push(makeImageBatchEntry(node.imageAsset, sn, sn));
      node.sourceName = "";
    }
  }
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
}

/* 停止运行：立即中止模型请求并回到未处理状态 */
async function stopNode(node) {
  /* 函数 / 工具节点（计算执行类）先记账：它（含工具壳内）到底在不在跑 / 在不在排队。
     下面的 bumpNodeStop 会把排队项就地打掉，之后再问就什么都问不出来了。 */
  const computeRunning =
    isComputeExecKind(node) &&
    (!!node.running ||
      (typeof fnRunInFlight === "function"
        ? fnRunInFlight(node)
        : typeof fnHasLiveRun === "function" && fnHasLiveRun(node)));
  const computeQueued =
    isComputeExecKind(node) &&
    typeof fnRunQueued === "function" &&
    fnRunQueued(node);
  const computeBusy = computeRunning || computeQueued;
  /* 作废本节点当前批次（在途 + 排队中的）：之后所有下游驱动一律拦掉 */
  bumpNodeStop(node);
  if (node.kind === "timer") {
    if (node.timerArmed || node.running) disarmTimerNode(node, false);
    return;
  }
  /* 开发节点（super+dev）：运行态可能来自后代节点 / 绑定会话（自身 running 未必为 true）。
     逐条停止 = 递归停掉块内运行的后代（含嵌套开发块与其会话）+ 本块绑定的运行会话。 */
  if (node.kind === "super" && node.dev && !node.db) {
    const devRun =
      typeof devNodeRunningState === "function" ? devNodeRunningState(node) : null;
    if (!devRun) return;
    /* 「建议 / 问询」只读调研在后台跑（devNodeRunningState = "sug"）：只取消这轮调研
       作业本身（dshCancelActive + 清 job），不牵连块内节点与绑定会话——
       那是「自身 / 后代 / 会话」态才走的递归停止。 */
    if (devRun === "sug") {
      let hit = false;
      if (
        typeof devSuggestJobOf === "function" &&
        typeof devSuggestJobAbort === "function" &&
        typeof devSuggestJobDrop === "function"
      ) {
        const job = devSuggestJobOf(node);
        if (job) {
          devSuggestJobAbort(job);
          devSuggestJobDrop(job);
          hit = true;
        }
      }
      if (
        typeof devAskJobOf === "function" &&
        typeof devAskJobAbort === "function" &&
        typeof devAskJobDrop === "function"
      ) {
        const job = devAskJobOf(node);
        if (job) {
          devAskJobAbort(job);
          devAskJobDrop(job);
          hit = true;
        }
      }
      toast(
        hit
          ? I18n.t("已停止该功能块的调研（建议 / 问询）")
          : I18n.t("该功能块已无建议或问询调研"),
        "warn",
      );
      renderCanvas();
      renderStatus();
      updateRunQueuePanel();
      if (S.view === "agent") renderAgentSession();
      scheduleSave(true);
      return;
    }
    let nStop = 0;
    /* 块内嵌套的函数 / 工具节点：它们的线程在主进程里，直接置 running=false 是假停止
       —— 先登记，递归结束后统一按 runId 取消（terminate 线程 + 连进程树回收）。 */
    const fnInside = [];
    let nFnProc = 0;
    /* 停一条绑定会话名下的运行一律走 stopSessionRuns：它既作废并取消会话自己那一轮
       （agent:<会话id>），也逐个取消该会话名下的计划并行组 runKey。
       「在不在跑」用展示口径 sessionBusyForUi 判定 —— 并行组在跑时 st.running 是 false，
       旧写法会出现「块亮着运行中、点 ■ 却提示没有运行任务」。 */
    const stopBoundSession = (s) => {
      if (!s) return;
      const busy =
        typeof sessionBusyForUi === "function"
          ? sessionBusyForUi(s)
          : typeof sessionIsRunning === "function"
            ? sessionIsRunning(s)
            : !!s.running;
      if (!busy) return;
      try {
        stopSessionRuns(s, true);
        nStop++;
      } catch (_) {}
    };
    const stopSubtree = (host) => {
      const all = (S.wf && S.wf.nodes) || [];
      for (const c of all) {
        if (!c || nodeParentSuperId(c) !== host.id) continue;
        if (typeof isSuperIoNode === "function" && isSuperIoNode(c)) continue;
        if (c.kind === "super" && c.dev && !c.db) {
          if (
            typeof devNodeRunningState === "function" &&
            devNodeRunningState(c)
          ) {
            stopSubtree(c);
            for (const s of devSessionsOf(c)) stopBoundSession(s);
          }
        } else if (
          c.running ||
          (isComputeExecKind(c) &&
            (typeof computeExecNodeActive === "function"
              ? computeExecNodeActive(c)
              : typeof fnHasLiveRun === "function" && fnHasLiveRun(c)))
        ) {
          bumpNodeStop(c);
          if (c._abKey) {
            try {
              window.api.apiAbort(c._abKey);
            } catch (_) {}
          }
          /* 函数 / 工具后代：线程 + 外部进程都由主进程托管，按 runId 真取消，
             状态（running / 「已手动停止」）交给它自己的运行收尾，这里不抢着写。
             判定含「只在排队」的那一半 —— 它们还没置 running，但已经占了一个排队位。 */
          if (isComputeExecKind(c)) {
            fnInside.push(c);
            nStop++;
            continue;
          }
          c._aborted = true;
          c.running = false;
          c.error = I18n.t("已手动停止");
          nStop++;
        }
      }
    };
    stopSubtree(node);
    for (const s of devSessionsOf(node)) stopBoundSession(s);
    /* 块内函数 / 工具节点：等线程真的终止、进程树真的回收（界面状态由它们自己的收尾写） */
    for (const c of fnInside) {
      try {
        const r = await fnCancelRunsOf(c);
        if (r && r.procs) nFnProc += Number(r.procs) || 0;
      } catch (_) {}
    }
    node._aborted = true;
    if (node.running) {
      node.running = false;
      node.error = I18n.t("已手动停止");
      nStop++;
    }
    toast(
      (nStop > 0
        ? I18n.t("已停止该功能块的运行任务") + "（" + nStop + "）"
        : I18n.t("该功能块已无运行任务")) +
        (nFnProc
          ? I18n.t(" · 回收 ") + nFnProc + I18n.t(" 个进程")
          : ""),
      "warn",
    );
    renderCanvas();
    renderStatus();
    updateRunQueuePanel();
    if (S.view === "agent") renderAgentSession();
    scheduleSave(true);
    return;
  }
  if (node.kind === "delayer" || node.kind === "sequencer" || node.kind === "splitter") {
    if (!node.running) return;
    node._aborted = true;
    toast(
      node.kind === "delayer"
        ? I18n.t("已请求取消延时…")
        : node.kind === "splitter"
          ? I18n.t("已请求取消分发…")
          : I18n.t("已请求取消序列…"),
      "warn",
    );
    renderCanvas();
    return;
  }
  if (
    node.kind === "music_gen" ||
    node.kind === "tts_gen" ||
    node.kind === "video_gen" ||
    node.kind === "remotion"
  ) {
    /* 单节点停止也要：关监视器 + 作废排队 + 取消主进程在途任务（释放大锁）。
       旧实现只把 running 置 false，串行队列 / 后端任务照跑，稍后节点又回到运行队列。
       语音（tts_gen）例外于「取消主进程任务」：GPT-SoVITS 无取消接口，靠 bumpNodeStop
       让在途合成在返回时被作废（不写产物、不驱动下游）。 */
    if (!node.running && !mediaGenWaiters.has(node.id)) return;
    if (mediaGenWaiters.has(node.id)) {
      mediaGenWaiters.delete(node.id);
      clearPendingRun([node.id]);
    }
    stopMediaBackendRunWatcher(node.id);
    stopMediaGenRestoreWatch(node.id);
    const wasRunning = !!node.running;
    node.running = false;
    if (wasRunning) mediaGenCancelRemote(node);
    if (node.kind === "music_gen") node.musicStatus = I18n.t("已取消");
    else if (node.kind === "tts_gen") node.ttsStatus = I18n.t("已取消");
    else if (node.kind === "video_gen") node.videoStatus = I18n.t("已取消");
    else node.remotionStatus = I18n.t("已取消");
    node.error = null;
    toast(
      I18n.t(
        node.kind === "music_gen"
          ? "已取消音乐生成"
          : node.kind === "tts_gen"
            ? "已取消语音合成"
            : node.kind === "video_gen"
              ? "已取消视频生成"
              : "已取消 Remotion 渲染",
      ),
      "warn",
    );
    renderCanvas();
    updateRunQueuePanel();
    return;
  }
  /* 函数 / 工具节点（计算执行类）：执行体在主进程的独立线程里（根目录 fn-runtime.js），
     它拉起的外部进程由隐藏宿主按 runId 记账（main-proc-host.js）。
     通用「直接把 running 置 false」在这里是假停止：界面暗了，线程照跑、进程照活，
     而且运行体自己的 finally 随后又把状态改回来，两边打架。
     正确停法：bumpNodeStop（作废本批 + 打掉排队项，上面已做）→ 按 runId 取消这次运行
     （主进程先 terminate 线程、再 taskkill 连进程树回收）；界面状态与「已手动停止」
     文案一律交给 runComputeExecNode 的 finally 收尾，本函数只负责「真的把它停掉」
     并把回收到的进程数告诉用户。工具节点连带停壳内内部图（见 fnCancelRunsOf）。 */
  if (isComputeExecKind(node)) {
    if (!computeBusy) return;
    /* 一律走统一取消入口：它同时负责三件事 —— 取消在途线程（terminate + 连进程树回收）、
       打掉壳内排队项、给「还没来得及注册句柄」的那一瞬补上待取消标记。
       只在排队、线程还没起的节点，bumpNodeStop 已把它从「等待中」摘掉并作废
       （运行体在出队点直接收尾，绝不起了线程再杀） */
    const r =
      typeof fnCancelRunsOf === "function"
        ? await fnCancelRunsOf(node)
        : { runs: 0, procs: 0 };
    /* 措辞分四档：只在排队 → 取消排队；真杀掉了线程并回收了进程 → 报进程数；
       杀掉了线程但没起过进程 → 已停止；这次没问到可取消的线程（还卡在上游补跑 /
       内部图的模型请求上）→ 只说「已请求停止」，状态由运行体自己的收尾落定，
       绝不谎报「已经停了」。
       （不再在这里补 _aborted / running：顶部 bumpNodeStop 已经打过标记，
       这里再写会和刚起跑的新一次运行抢状态） */
    let msg;
    if (!computeRunning && !r.runs && !r.procs)
      msg = I18n.t("已取消该节点的排队运行");
    else if (r.procs)
      msg = I18n.t("已停止并回收 ") + r.procs + I18n.t(" 个进程");
    else if (r.runs) msg = I18n.t("已停止该节点的运行");
    else msg = I18n.t("已请求停止运行…");
    toast(msg, "warn");
    renderCanvas();
    renderStatus();
    updateRunQueuePanel();
    scheduleSave(true);
    return;
  }
  if (!node.running) return;
  if (node.kind === "wait_file") {
    node._aborted = true;
    toast(I18n.t("已请求停止等待…"), "warn");
    renderCanvas();
    return;
  }
  if (node.kind === "task") {
    /* 任务里的函数 / 工具节点：执行体在主进程独立线程里，只打标记停不掉，
       abortTaskTree 顺带把「算在跑」的计算执行节点登记出来，这里按 runId 真取消 */
    const seenFn = new Set();
    const fnIn = (abortTaskTree(node, []) || []).filter((c) => {
      if (!c || !c.id || seenFn.has(String(c.id))) return false;
      seenFn.add(String(c.id));
      return true;
    });
    let nFnProc = 0;
    for (const c of fnIn) {
      try {
        const r = await fnCancelRunsOf(c);
        if (r && r.procs) nFnProc += Number(r.procs) || 0;
      } catch (_) {}
    }
    toast(
      I18n.t("已请求停止任务…") +
        (nFnProc
          ? I18n.t(" · 回收 ") + nFnProc + I18n.t(" 个进程")
          : ""),
      "warn",
    );
    renderCanvas();
    updateRunQueuePanel();
    return;
  }
  if (node.kind === "judge") {
    node._aborted = true;
    toast(I18n.t("已请求停止判断…"), "warn");
    renderCanvas();
    return;
  }
  if (isDshTask(node)) {
    /* dsh 线协议无逐轮取消:关掉「这一次运行」自己的运行时进程
       （网关按 cancelTag 精确定位，不再按工作目录整批关，不会波及别的会话） */
    dshCancelActive(node.id);
    node._aborted = true;
    node.running = false;
    node.error = I18n.t("已请求中断本次运行");
    if (node.kind === "agent_task" && node.agentSessionId) {
      const sess = agentSessions().find((s) => s.id === node.agentSessionId);
      if (sess) {
        /* 绑定会话可能是从「会话视图」起跑的（runKey = agent:<会话id>），
           只 cancel node.id 停不掉它 → 两个键都停，并标记成用户主动终止 */
        sess._cancelled = true;
        sess.running = false;
        dshCancelActive("agent:" + sess.id);
      }
    }
    toast(I18n.t("已请求中断本次运行…"), "warn");
    renderCanvas();
    renderStatus();
    if (S.view === "agent") renderAgentSession();
    scheduleSave(true);
    return;
  }
  node._aborted = true;
  if (node._abKey) window.api.apiAbort(node._abKey);
  node.running = false;
  node.error = I18n.t("已手动停止");
  renderCanvas();
  renderStatus();
  scheduleSave(true);
}

/* Markdown 渲染（先转义 HTML 防注入，再解析；链接仅允许 http/https/mailto）
   额外把裸 URL / 本地路径做成可点击打开 */
function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlUnescape(text) {
  return String(text == null ? "" : text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripLinkTrailPunct(s) {
  return String(s || "").replace(
    /[.,;:!?。，；：！？、)\]}>」』》〉】）》」]+$/g,
    "",
  );
}

/* 在已转义的纯文本片段中识别 URL / 本地路径，包成可点击链接 */
function linkifyEscapedText(text) {
  const src = String(text || "");
  if (!src) return src;
  const re =
    /https?:\/\/[^\s<&]+|file:\/\/\/?[^\s<&]+|(?:[A-Za-z]:(?:\\|\/)|\\\\[^\\\s<&]+)[^\s<&|?*]+/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    let raw = m[0];
    const cleaned = stripLinkTrailPunct(raw);
    const trail = cleaned.length < raw.length ? raw.slice(cleaned.length) : "";
    raw = cleaned;
    if (!raw) continue;
    const isUrl = /^https?:\/\//i.test(raw);
    const isFileUrl = /^file:/i.test(raw);
    if (!isUrl && !isFileUrl && raw.length < 4) continue;
    out += src.slice(last, m.index);
    const kind = isUrl ? "url" : isFileUrl ? "file" : "path";
    out +=
      '<a class="mt-link" href="' +
      raw +
      '" data-mt-open="' +
      kind +
      '" title="' +
      I18n.t("点击打开") +
      '">' +
      raw +
      "</a>" +
      trail;
    last = m.index + m[0].length;
  }
  out += src.slice(last);
  return out;
}

/* 对 HTML 中标签外的文本做链接化（跳过已有 <a>） */
function linkifyHtml(html) {
  return String(html || "").replace(
    /(<a\b[^>]*>[\s\S]*?<\/a>)|([^<]+)|(<[^>]+>)/gi,
    (m, anchor, text, tag) => {
      if (anchor) return anchor;
      if (tag) return tag;
      return linkifyEscapedText(text);
    },
  );
}

function plainTextToLinkHtml(text) {
  return linkifyEscapedText(escapeHtml(text));
}

function fileUrlToPath(u) {
  let s = htmlUnescape(u).replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  try {
    s = decodeURIComponent(s);
  } catch (_) {}
  return s;
}

function isYamlFilePath(p) {
  return /\.ya?ml$/i.test(String(p || "").trim());
}

function resolveOpenableFilePath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  if (isAbsPath(raw)) return raw;
  try {
    const r = resolveSavePath(raw);
    if (r && r.ok && r.path) return r.path;
  } catch (_) {}
  return raw;
}

function highlightYamlValue(val) {
  const v = String(val);
  if (!v) return "";
  if (/^#/.test(v.trim())) return '<span class="yaml-c">' + escapeHtml(v) + "</span>";
  if (/^(true|false|null|~)$/i.test(v.trim()))
    return '<span class="yaml-b">' + escapeHtml(v) + "</span>";
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(v.trim()))
    return '<span class="yaml-n">' + escapeHtml(v) + "</span>";
  if (
    (v.trim().startsWith('"') && v.trim().endsWith('"')) ||
    (v.trim().startsWith("'") && v.trim().endsWith("'"))
  )
    return '<span class="yaml-s">' + escapeHtml(v) + "</span>";
  if (/^[&*]/.test(v.trim()))
    return '<span class="yaml-a">' + escapeHtml(v) + "</span>";
  return '<span class="yaml-s">' + escapeHtml(v) + "</span>";
}

function highlightYamlLine(rawLine) {
  const line = String(rawLine ?? "");
  const trimmed = line.trim();
  if (!trimmed)
    return escapeHtml(line);
  if (trimmed.startsWith("#"))
    return '<span class="yaml-c">' + escapeHtml(line) + "</span>";

  const leadMatch = line.match(/^(\s*)(.*)$/);
  const lead = leadMatch ? leadMatch[1] : "";
  const rest = leadMatch ? leadMatch[2] : line;

  if (rest.startsWith("- ")) {
    const afterDash = rest.slice(2);
    const km = afterDash.match(/^([^:#]+?)(\s*:)(\s*)(.*)$/);
    if (km) {
      return (
        escapeHtml(lead) +
        '<span class="yaml-p">- </span>' +
        '<span class="yaml-k">' +
        escapeHtml(km[1]) +
        "</span>" +
        '<span class="yaml-p">' +
        escapeHtml(km[2]) +
        "</span>" +
        escapeHtml(km[3]) +
        highlightYamlValue(km[4])
      );
    }
    return (
      escapeHtml(lead) +
      '<span class="yaml-p">- </span>' +
      highlightYamlValue(afterDash)
    );
  }

  const km = rest.match(/^([^:#]+?)(\s*:)(\s*)(.*)$/);
  if (km) {
    return (
      escapeHtml(lead) +
      '<span class="yaml-k">' +
      escapeHtml(km[1]) +
      "</span>" +
      '<span class="yaml-p">' +
      escapeHtml(km[2]) +
      "</span>" +
      escapeHtml(km[3]) +
      highlightYamlValue(km[4])
    );
  }
  return escapeHtml(lead) + highlightYamlValue(rest);
}

function buildYamlOutline(text) {
  const items = [];
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.replace(/^\s+/, "").length;
    const depth = Math.min(2, Math.floor(indent / 2));
    let label = "";
    if (trimmed.startsWith("- ")) {
      const after = trimmed.slice(2);
      const m = after.match(/^([^:#]+?)\s*:/);
      label = m ? "- " + m[1].trim() : trimmed.slice(0, 48);
    } else {
      const m = trimmed.match(/^([^:#]+?)\s*:/);
      if (!m) continue;
      label = m[1].trim();
    }
    if (!label) continue;
    if (depth === 0 || items.length < 80) {
      items.push({ line: i + 1, label, depth });
    }
    if (items.length >= 120) break;
  }
  return items;
}

let _yamlViewerState = {
  path: "",
  wrap: false,
  outline: true,
  w: 0,
  h: 0,
  editing: false,
  raw: "",
};

function closeYamlViewer() {
  const host = document.getElementById("yamlViewerDlg");
  if (host) host.classList.remove("on");
}

function ensureYamlViewer() {
  let host = document.getElementById("yamlViewerDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "yamlViewerDlg";
  host.className = "yaml-viewer-dlg";
  host.innerHTML =
    '<div class="yaml-viewer-box" id="yamlViewerBox" role="dialog" aria-modal="true">' +
    '<div class="yaml-viewer-head">' +
    "<b>" +
    I18n.t("YAML 阅读器") +
    "</b>" +
    '<span class="yaml-viewer-title" id="yamlViewerTitle"></span>' +
    '<div class="yaml-viewer-actions">' +
    '<button type="button" class="mini" id="yamlViewerOutlineBtn"></button>' +
    '<button type="button" class="mini" id="yamlViewerWrapBtn"></button>' +
    '<button type="button" class="mini" id="yamlViewerReloadBtn"></button>' +
    '<button type="button" class="mini" id="yamlViewerCopyBtn"></button>' +
    '<button type="button" class="mini" id="yamlViewerRevealBtn"></button>' +
    '<button type="button" class="mini" id="yamlViewerEditBtn"></button>' +
    '<button type="button" class="mini primary" id="yamlViewerSaveBtn" disabled></button>' +
    '<button type="button" class="mini" id="yamlViewerCloseBtn">✕</button>' +
    "</div></div>" +
    '<div class="yaml-viewer-path" id="yamlViewerPath"></div>' +
    '<div class="yaml-viewer-main">' +
    '<div class="yaml-viewer-outline" id="yamlViewerOutline">' +
    '<div class="yaml-viewer-outline-h">' +
    I18n.t("大纲") +
    "</div>" +
    '<div class="yaml-viewer-outline-list" id="yamlViewerOutlineList"></div>' +
    "</div>" +
    '<div class="yaml-viewer-body" id="yamlViewerBody"></div>' +
    "</div>" +
    '<div class="yaml-viewer-foot">' +
    '<span class="yaml-viewer-meta" id="yamlViewerMeta"></span>' +
    '<button type="button" class="mini primary" id="yamlViewerClose2">' +
    I18n.t("关闭") +
    "</button></div>" +
    '<div class="yaml-viewer-resize" id="yamlViewerResize" title="' +
    I18n.t("拖拽调整大小") +
    '"></div>' +
    "</div>";
  document.body.appendChild(host);

  const close = () => closeYamlViewer();
  host.querySelector("#yamlViewerCloseBtn").onclick = close;
  host.querySelector("#yamlViewerClose2").onclick = close;
  host.addEventListener("click", (ev) => {
    if (ev.target === host) close();
  });
  document.addEventListener("keydown", (ev) => {
    if (!host.classList.contains("on")) return;
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) {
      if (_yamlViewerState.editing) {
        ev.preventDefault();
        ev.stopPropagation();
        saveYamlViewer();
      }
      return;
    }
    if (ev.key === "Escape") {
      closeYamlViewer();
    }
  });

  host.querySelector("#yamlViewerOutlineBtn").onclick = () => {
    _yamlViewerState.outline = !_yamlViewerState.outline;
    applyYamlViewerChrome();
  };
  host.querySelector("#yamlViewerWrapBtn").onclick = () => {
    _yamlViewerState.wrap = !_yamlViewerState.wrap;
    applyYamlViewerChrome();
  };
  host.querySelector("#yamlViewerReloadBtn").onclick = () => {
    if (_yamlViewerState.path) openYamlViewer(_yamlViewerState.path, { force: true });
  };
  host.querySelector("#yamlViewerCopyBtn").onclick = async () => {
    const ed = host.querySelector("#yamlViewerEditor");
    const pre = host.querySelector("#yamlViewerCode");
    const text = ed
      ? ed.value
      : pre && pre.dataset.raw != null
        ? pre.dataset.raw
        : "";
    try {
      if (navigator.clipboard && navigator.clipboard.writeText)
        await navigator.clipboard.writeText(text);
      else if (window.api && window.api.clipboardWriteText)
        await window.api.clipboardWriteText(text);
      toast(I18n.t("已复制"), "ok");
    } catch (e) {
      toast(I18n.t("复制失败") + ": " + ((e && e.message) || e), "warn");
    }
  };
  host.querySelector("#yamlViewerRevealBtn").onclick = () => {
    const p = _yamlViewerState.path;
    if (p && window.api && window.api.shellShowItem) window.api.shellShowItem(p);
  };
  /* 编辑 / 保存：编辑模式 = 全文可改的 textarea，Ctrl+S 或「保存」写回文件 */
  host.querySelector("#yamlViewerEditBtn").onclick = () => {
    _yamlViewerState.editing = !_yamlViewerState.editing;
    renderYamlViewerContent(_yamlViewerState.raw);
  };
  host.querySelector("#yamlViewerSaveBtn").onclick = () => saveYamlViewer();

  const box = host.querySelector("#yamlViewerBox");
  const rz = host.querySelector("#yamlViewerResize");
  rz.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const rect = box.getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;
    const onMove = (e) => {
      const nw = Math.max(560, Math.min(window.innerWidth - 24, startW + (e.clientX - startX)));
      const nh = Math.max(420, Math.min(window.innerHeight - 24, startH + (e.clientY - startY)));
      box.style.width = nw + "px";
      box.style.height = nh + "px";
      _yamlViewerState.w = nw;
      _yamlViewerState.h = nh;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  return host;
}

function applyYamlViewerChrome() {
  const host = document.getElementById("yamlViewerDlg");
  if (!host) return;
  const outline = host.querySelector("#yamlViewerOutline");
  const code = host.querySelector("#yamlViewerCode");
  const ob = host.querySelector("#yamlViewerOutlineBtn");
  const wb = host.querySelector("#yamlViewerWrapBtn");
  if (outline)
    outline.style.display = _yamlViewerState.editing || !_yamlViewerState.outline ? "none" : "";
  if (code) code.classList.toggle("wrap", !!_yamlViewerState.wrap);
  if (ob) {
    ob.textContent = I18n.t("大纲");
    ob.classList.toggle("on", !!_yamlViewerState.outline);
    ob.title = _yamlViewerState.outline
      ? I18n.t("隐藏大纲")
      : I18n.t("显示大纲");
  }
  if (wb) {
    wb.textContent = I18n.t("换行");
    wb.classList.toggle("on", !!_yamlViewerState.wrap);
    wb.title = _yamlViewerState.wrap
      ? I18n.t("取消自动换行")
      : I18n.t("自动换行");
  }
  const rb = host.querySelector("#yamlViewerReloadBtn");
  if (rb) {
    rb.textContent = I18n.t("刷新");
    rb.title = I18n.t("重新加载文件");
  }
  const cb = host.querySelector("#yamlViewerCopyBtn");
  if (cb) {
    cb.textContent = I18n.t("复制");
    cb.title = I18n.t("复制全文");
  }
  const rv = host.querySelector("#yamlViewerRevealBtn");
  if (rv) {
    rv.textContent = I18n.t("位置");
    rv.title = I18n.t("在文件夹中显示");
  }
  const eb = host.querySelector("#yamlViewerEditBtn");
  if (eb) {
    eb.textContent = _yamlViewerState.editing ? I18n.t("取消编辑") : I18n.t("编辑");
    eb.title = _yamlViewerState.editing
      ? I18n.t("放弃修改，回到预览")
      : I18n.t("编辑并保存此文件（Ctrl+S 保存）");
    eb.classList.toggle("on", !!_yamlViewerState.editing);
  }
  const sb = host.querySelector("#yamlViewerSaveBtn");
  if (sb) {
    sb.textContent = I18n.t("保存");
    sb.title = I18n.t("写回文件（Ctrl+S）");
    sb.disabled = !_yamlViewerState.editing;
  }
}

function renderYamlViewerContent(text) {
  const host = ensureYamlViewer();
  const body = host.querySelector("#yamlViewerBody");
  const list = host.querySelector("#yamlViewerOutlineList");
  const meta = host.querySelector("#yamlViewerMeta");
  body.innerHTML = "";
  list.innerHTML = "";

  const raw = String(text ?? "");
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  _yamlViewerState.raw = raw;
  if (_yamlViewerState.editing) {
    /* 编辑模式：全文可改 textarea，Ctrl+S 或「保存」写回文件 */
    const ta = document.createElement("textarea");
    ta.className = "viewer-editor";
    ta.id = "yamlViewerEditor";
    ta.value = raw;
    ta.spellcheck = false;
    body.appendChild(ta);
    meta.textContent =
      lines.length + I18n.t(" 行") + " · " + I18n.t("编辑模式：Ctrl+S 保存");
    applyYamlViewerChrome();
    ta.focus();
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "yaml-viewer-code" + (_yamlViewerState.wrap ? " wrap" : "");
  pre.id = "yamlViewerCode";
  pre.dataset.raw = raw;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement("div");
    row.className = "yaml-line";
    row.id = "yaml-line-" + (i + 1);
    const ln = document.createElement("span");
    ln.className = "yaml-ln";
    ln.textContent = String(i + 1);
    const lt = document.createElement("span");
    lt.className = "yaml-lt";
    lt.innerHTML = highlightYamlLine(lines[i]);
    row.appendChild(ln);
    row.appendChild(lt);
    frag.appendChild(row);
  }
  pre.appendChild(frag);
  body.appendChild(pre);

  const outline = buildYamlOutline(raw);
  outline.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "yaml-outline-item depth-" + it.depth;
    b.textContent = it.label;
    b.title = I18n.t("行号") + " " + it.line;
    b.onclick = () => {
      const el = document.getElementById("yaml-line-" + it.line);
      if (!el) return;
      body.querySelectorAll(".yaml-line.hl").forEach((n) => n.classList.remove("hl"));
      el.classList.add("hl");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    list.appendChild(b);
  });
  if (!outline.length) {
    const empty = document.createElement("div");
    empty.className = "yaml-viewer-empty";
    empty.style.padding = "12px";
    empty.style.fontSize = "12px";
    empty.textContent = I18n.t("无大纲条目");
    list.appendChild(empty);
  }

  const bytes = new Blob([raw]).size;
  meta.textContent =
    lines.length +
    I18n.t(" 行") +
    " · " +
    bytes +
    " B" +
    (outline.length ? " · " + outline.length + I18n.t(" 个键") : "");
  applyYamlViewerChrome();
}

/* 把当前编辑内容写回文件（YAML 阅读器） */
async function saveYamlViewer() {
  const host = document.getElementById("yamlViewerDlg");
  const ed = host && host.querySelector("#yamlViewerEditor");
  const p = _yamlViewerState.path;
  if (!host || !ed || !p) return;
  const content = ed.value;
  try {
    const r = await window.api.fileWriteText(p, content);
    if (r && r.ok === false) throw new Error((r && r.error) || "write failed");
    _yamlViewerState.raw = content;
    _yamlViewerState.editing = false;
    toast(I18n.t("已保存"), "ok");
    renderYamlViewerContent(content);
  } catch (e) {
    toast(I18n.t("保存失败：") + ((e && e.message) || e), "err");
  }
}

async function openYamlViewer(filePath, opts) {
  opts = opts || {};
  const resolved = resolveOpenableFilePath(filePath);
  if (!resolved) {
    toast(I18n.t("无法打开路径"), "warn");
    return;
  }
  if (!window.api || !window.api.fileReadText) {
    toast(I18n.t("无法打开路径"), "warn");
    return;
  }
  const host = ensureYamlViewer();
  const box = host.querySelector("#yamlViewerBox");
  if (_yamlViewerState.w > 0 && _yamlViewerState.h > 0) {
    box.style.width = _yamlViewerState.w + "px";
    box.style.height = _yamlViewerState.h + "px";
  }
  _yamlViewerState.path = resolved;
  _yamlViewerState.editing = false;
  _yamlViewerState.raw = "";
  host.querySelector("#yamlViewerTitle").textContent = fileName(resolved) || "YAML";
  host.querySelector("#yamlViewerPath").textContent = resolved;
  host.querySelector("#yamlViewerPath").title = resolved;

  const body = host.querySelector("#yamlViewerBody");
  body.innerHTML =
    '<div class="yaml-viewer-empty">' + I18n.t("加载中…") + "</div>";
  host.classList.add("on");
  applyYamlViewerChrome();

  try {
    const rr = await window.api.fileReadText(resolved);
    if (!rr || !rr.exists) {
      body.innerHTML =
        '<div class="yaml-viewer-empty">' +
        I18n.t("文件不存在或无法预览") +
        "</div>";
      host.querySelector("#yamlViewerMeta").textContent = "";
      return;
    }
    renderYamlViewerContent(rr.content || "");
  } catch (e) {
    body.innerHTML =
      '<div class="yaml-viewer-empty">' +
      escapeHtml(I18n.t("无法打开路径：") + ((e && e.message) || e)) +
      "</div>";
  }
}

function bindYamlViewerIpc() {
  if (document.documentElement._mtYamlViewerBound) return;
  document.documentElement._mtYamlViewerBound = true;
  if (window.api && typeof window.api.onYamlViewerOpen === "function") {
    window.api.onYamlViewerOpen((data) => {
      const p = data && data.path;
      if (p) openYamlViewer(p);
    });
  }
}

/* ============ Markdown 阅读器（查看 + 大纲 + 编辑 / 保存） ============
 * 与 YAML 阅读器同窗体样式（复用 yaml-viewer-* 类），内容区渲染为文档；
 * 「编辑」切换为全文可改的 textarea，Ctrl+S 或「保存」写回文件。 */
function isMdFilePath(p) {
  return /\.(md|markdown|mdown)$/i.test(String(p || "").trim());
}

let _mdViewerState = {
  path: "",
  outline: true,
  w: 0,
  h: 0,
  editing: false,
  raw: "",
};

function closeMdViewer() {
  const host = document.getElementById("mdViewerDlg");
  if (host) host.classList.remove("on");
}

function ensureMdViewer() {
  let host = document.getElementById("mdViewerDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "mdViewerDlg";
  host.className = "yaml-viewer-dlg";
  host.innerHTML =
    '<div class="yaml-viewer-box" id="mdViewerBox" role="dialog" aria-modal="true">' +
    '<div class="yaml-viewer-head">' +
    "<b>" +
    I18n.t("Markdown 阅读器") +
    "</b>" +
    '<span class="yaml-viewer-title" id="mdViewerTitle"></span>' +
    '<div class="yaml-viewer-actions">' +
    '<button type="button" class="mini" id="mdViewerOutlineBtn"></button>' +
    '<button type="button" class="mini" id="mdViewerReloadBtn"></button>' +
    '<button type="button" class="mini" id="mdViewerCopyBtn"></button>' +
    '<button type="button" class="mini" id="mdViewerRevealBtn"></button>' +
    '<button type="button" class="mini" id="mdViewerEditBtn"></button>' +
    '<button type="button" class="mini primary" id="mdViewerSaveBtn" disabled></button>' +
    '<button type="button" class="mini" id="mdViewerCloseBtn">✕</button>' +
    "</div></div>" +
    '<div class="yaml-viewer-path" id="mdViewerPath"></div>' +
    '<div class="yaml-viewer-main">' +
    '<div class="yaml-viewer-outline" id="mdViewerOutline">' +
    '<div class="yaml-viewer-outline-h">' +
    I18n.t("大纲") +
    "</div>" +
    '<div class="yaml-viewer-outline-list" id="mdViewerOutlineList"></div>' +
    "</div>" +
    '<div class="yaml-viewer-body" id="mdViewerBody"></div>' +
    "</div>" +
    '<div class="yaml-viewer-foot">' +
    '<span class="yaml-viewer-meta" id="mdViewerMeta"></span>' +
    '<button type="button" class="mini primary" id="mdViewerClose2">' +
    I18n.t("关闭") +
    "</button></div>" +
    '<div class="yaml-viewer-resize" id="mdViewerResize" title="' +
    I18n.t("拖拽调整大小") +
    '"></div>' +
    "</div>";
  document.body.appendChild(host);

  const close = () => closeMdViewer();
  host.querySelector("#mdViewerCloseBtn").onclick = close;
  host.querySelector("#mdViewerClose2").onclick = close;
  host.addEventListener("click", (ev) => {
    if (ev.target === host) close();
  });
  document.addEventListener("keydown", (ev) => {
    if (!host.classList.contains("on")) return;
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) {
      if (_mdViewerState.editing) {
        ev.preventDefault();
        ev.stopPropagation();
        saveMdViewer();
      }
      return;
    }
    if (ev.key === "Escape") {
      closeMdViewer();
    }
  });

  host.querySelector("#mdViewerOutlineBtn").onclick = () => {
    _mdViewerState.outline = !_mdViewerState.outline;
    applyMdViewerChrome();
  };
  host.querySelector("#mdViewerReloadBtn").onclick = () => {
    if (_mdViewerState.path) openMdViewer(_mdViewerState.path, { force: true });
  };
  host.querySelector("#mdViewerCopyBtn").onclick = async () => {
    const ed = host.querySelector("#mdViewerEditor");
    const text = ed ? ed.value : _mdViewerState.raw;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText)
        await navigator.clipboard.writeText(text);
      else if (window.api && window.api.clipboardWriteText)
        await window.api.clipboardWriteText(text);
      toast(I18n.t("已复制"), "ok");
    } catch (e) {
      toast(I18n.t("复制失败") + ": " + ((e && e.message) || e), "warn");
    }
  };
  host.querySelector("#mdViewerRevealBtn").onclick = () => {
    const p = _mdViewerState.path;
    if (p && window.api && window.api.shellShowItem) window.api.shellShowItem(p);
  };
  /* 编辑 / 保存：编辑模式 = 全文可改的 textarea，Ctrl+S 或「保存」写回文件 */
  host.querySelector("#mdViewerEditBtn").onclick = () => {
    _mdViewerState.editing = !_mdViewerState.editing;
    renderMdViewerContent(_mdViewerState.raw);
  };
  host.querySelector("#mdViewerSaveBtn").onclick = () => saveMdViewer();

  const box = host.querySelector("#mdViewerBox");
  const rz = host.querySelector("#mdViewerResize");
  rz.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const rect = box.getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;
    const onMove = (e) => {
      const nw = Math.max(560, Math.min(window.innerWidth - 24, startW + (e.clientX - startX)));
      const nh = Math.max(420, Math.min(window.innerHeight - 24, startH + (e.clientY - startY)));
      box.style.width = nw + "px";
      box.style.height = nh + "px";
      _mdViewerState.w = nw;
      _mdViewerState.h = nh;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  return host;
}

function applyMdViewerChrome() {
  const host = document.getElementById("mdViewerDlg");
  if (!host) return;
  const outline = host.querySelector("#mdViewerOutline");
  const ob = host.querySelector("#mdViewerOutlineBtn");
  if (outline)
    outline.style.display = _mdViewerState.editing || !_mdViewerState.outline ? "none" : "";
  if (ob) {
    ob.textContent = I18n.t("大纲");
    ob.classList.toggle("on", !!_mdViewerState.outline && !_mdViewerState.editing);
    ob.title = _mdViewerState.outline
      ? I18n.t("隐藏大纲")
      : I18n.t("显示大纲");
  }
  const rb = host.querySelector("#mdViewerReloadBtn");
  if (rb) {
    rb.textContent = I18n.t("刷新");
    rb.title = I18n.t("重新加载文件");
  }
  const cb = host.querySelector("#mdViewerCopyBtn");
  if (cb) {
    cb.textContent = I18n.t("复制");
    cb.title = I18n.t("复制全文");
  }
  const rv = host.querySelector("#mdViewerRevealBtn");
  if (rv) {
    rv.textContent = I18n.t("位置");
    rv.title = I18n.t("在文件夹中显示");
  }
  const eb = host.querySelector("#mdViewerEditBtn");
  if (eb) {
    eb.textContent = _mdViewerState.editing ? I18n.t("取消编辑") : I18n.t("编辑");
    eb.title = _mdViewerState.editing
      ? I18n.t("放弃修改，回到预览")
      : I18n.t("编辑并保存此文件（Ctrl+S 保存）");
    eb.classList.toggle("on", !!_mdViewerState.editing);
  }
  const sb = host.querySelector("#mdViewerSaveBtn");
  if (sb) {
    sb.textContent = I18n.t("保存");
    sb.title = I18n.t("写回文件（Ctrl+S）");
    sb.disabled = !_mdViewerState.editing;
  }
}

function buildMdOutline(text) {
  const items = [];
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const level = m[1].length;
    const label = m[2].trim().replace(/[#*_`[\]()]/g, "").slice(0, 60);
    if (!label) continue;
    items.push({ line: i + 1, label, depth: Math.min(2, level - 1) });
    if (items.length >= 120) break;
  }
  return items;
}

function renderMdViewerContent(text) {
  const host = ensureMdViewer();
  const body = host.querySelector("#mdViewerBody");
  const list = host.querySelector("#mdViewerOutlineList");
  const meta = host.querySelector("#mdViewerMeta");
  body.innerHTML = "";
  list.innerHTML = "";

  const raw = String(text ?? "");
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  _mdViewerState.raw = raw;
  if (_mdViewerState.editing) {
    /* 编辑模式：全文可改 textarea，Ctrl+S 或「保存」写回文件 */
    const ta = document.createElement("textarea");
    ta.className = "viewer-editor";
    ta.id = "mdViewerEditor";
    ta.value = raw;
    ta.spellcheck = false;
    body.appendChild(ta);
    meta.textContent =
      lines.length + I18n.t(" 行") + " · " + I18n.t("编辑模式：Ctrl+S 保存");
    applyMdViewerChrome();
    ta.focus();
    return;
  }

  const doc = document.createElement("div");
  doc.className = "md-viewer-doc md";
  doc.innerHTML = renderMarkdown(raw);
  /* 给渲染出的标题按顺序编锚点，供大纲跳转定位 */
  const heads = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
  heads.forEach((h, i) => {
    h.id = "md-h-" + i;
  });
  body.appendChild(doc);

  const outline = buildMdOutline(raw);
  outline.forEach((it, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "yaml-outline-item depth-" + it.depth;
    b.textContent = it.label;
    b.title = I18n.t("行号") + " " + it.line;
    b.onclick = () => {
      const el = document.getElementById("md-h-" + i);
      if (!el) return;
      doc.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((n) => n.classList.remove("hl"));
      el.classList.add("hl");
      el.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    list.appendChild(b);
  });
  if (!outline.length) {
    const empty = document.createElement("div");
    empty.className = "yaml-viewer-empty";
    empty.style.padding = "12px";
    empty.style.fontSize = "12px";
    empty.textContent = I18n.t("无大纲条目");
    list.appendChild(empty);
  }

  const bytes = new Blob([raw]).size;
  meta.textContent =
    lines.length +
    I18n.t(" 行") +
    " · " +
    bytes +
    " B" +
    (outline.length ? " · " + outline.length + I18n.t(" 个标题") : "");
  applyMdViewerChrome();
}

/* 把当前编辑内容写回文件（Markdown 阅读器） */
async function saveMdViewer() {
  const host = document.getElementById("mdViewerDlg");
  const ed = host && host.querySelector("#mdViewerEditor");
  const p = _mdViewerState.path;
  if (!host || !ed || !p) return;
  const content = ed.value;
  try {
    const r = await window.api.fileWriteText(p, content);
    if (r && r.ok === false) throw new Error((r && r.error) || "write failed");
    _mdViewerState.raw = content;
    _mdViewerState.editing = false;
    toast(I18n.t("已保存"), "ok");
    renderMdViewerContent(content);
  } catch (e) {
    toast(I18n.t("保存失败：") + ((e && e.message) || e), "err");
  }
}

async function openMdViewer(filePath, opts) {
  opts = opts || {};
  const resolved = resolveOpenableFilePath(filePath);
  if (!resolved) {
    toast(I18n.t("无法打开路径"), "warn");
    return;
  }
  if (!window.api || !window.api.fileReadText) {
    toast(I18n.t("无法打开路径"), "warn");
    return;
  }
  const host = ensureMdViewer();
  const box = host.querySelector("#mdViewerBox");
  if (_mdViewerState.w > 0 && _mdViewerState.h > 0) {
    box.style.width = _mdViewerState.w + "px";
    box.style.height = _mdViewerState.h + "px";
  }
  _mdViewerState.path = resolved;
  _mdViewerState.editing = false;
  _mdViewerState.raw = "";
  host.querySelector("#mdViewerTitle").textContent = fileName(resolved) || "Markdown";
  host.querySelector("#mdViewerPath").textContent = resolved;
  host.querySelector("#mdViewerPath").title = resolved;

  const body = host.querySelector("#mdViewerBody");
  body.innerHTML =
    '<div class="yaml-viewer-empty">' + I18n.t("加载中…") + "</div>";
  host.classList.add("on");
  applyMdViewerChrome();

  try {
    const rr = await window.api.fileReadText(resolved);
    if (!rr || !rr.exists) {
      body.innerHTML =
        '<div class="yaml-viewer-empty">' +
        I18n.t("文件不存在或无法预览") +
        "</div>";
      host.querySelector("#mdViewerMeta").textContent = "";
      return;
    }
    renderMdViewerContent(rr.content || "");
  } catch (e) {
    body.innerHTML =
      '<div class="yaml-viewer-empty">' +
      escapeHtml(I18n.t("无法打开路径：") + ((e && e.message) || e)) +
      "</div>";
  }
}

function bindMdViewerIpc() {
  if (document.documentElement._mtMdViewerBound) return;
  document.documentElement._mtMdViewerBound = true;
  if (window.api && typeof window.api.onMdViewerOpen === "function") {
    window.api.onMdViewerOpen((data) => {
      const p = data && data.path;
      if (p) openMdViewer(p);
    });
  }
}

/* 按扩展名选择应用内文本阅读器（Markdown / YAML；其它文本退回 YAML 行视图） */
async function openTextViewer(filePath) {
  const resolved = resolveOpenableFilePath(filePath);
  if (!resolved) {
    toast(I18n.t("无法打开路径"), "warn");
    return;
  }
  if (isMdFilePath(resolved)) return openMdViewer(resolved);
  return openYamlViewer(resolved);
}

async function openContentRef(href, kind) {
  const raw = htmlUnescape(String(href || "").trim());
  if (!raw) return;
  if (kind === "url" || /^https?:\/\//i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) {
      toast(I18n.t("已阻止不安全链接"), "warn");
      return;
    }
    try {
      if (window.api && window.api.openInAppDialog) {
        const r = await window.api.openInAppDialog({ kind: "url", target: raw });
        if (r && r.ok === false)
          toast(I18n.t("无法打开链接：") + (r.error || ""), "warn");
      } else if (window.api && window.api.openExternal) {
        await window.api.openExternal(raw);
      }
    } catch (e) {
      toast(I18n.t("无法打开链接：") + ((e && e.message) || e), "warn");
    }
    return;
  }
  if (kind === "mailto" || /^mailto:/i.test(raw)) {
    try {
      if (window.api && window.api.openExternal) await window.api.openExternal(raw);
    } catch (e) {
      toast(I18n.t("无法打开链接：") + ((e && e.message) || e), "warn");
    }
    return;
  }
  let path = raw;
  if (kind === "file" || /^file:/i.test(raw)) path = fileUrlToPath(raw);
  path = String(path || "").trim();
  if (!path) return;
  if (isMdFilePath(path)) {
    await openMdViewer(path);
    return;
  }
  if (isYamlFilePath(path)) {
    await openYamlViewer(path);
    return;
  }
  try {
    if (window.api && window.api.openInAppDialog) {
      const r = await window.api.openInAppDialog({ kind: "path", target: path });
      if (r && r.ok === false)
        toast(I18n.t("无法打开路径：") + (r.error || ""), "warn");
      return;
    }
    if (!window.api || !window.api.shellOpenPath) {
      toast(I18n.t("无法打开路径"), "warn");
      return;
    }
    const r = await window.api.shellOpenPath(path);
    if (r && r.ok === false)
      toast(I18n.t("无法打开路径：") + (r.error || ""), "warn");
  } catch (e) {
    toast(I18n.t("无法打开路径：") + ((e && e.message) || e), "warn");
  }
}

function bindOpenableContentClicks() {
  if (document.documentElement._mtLinkBound) return;
  document.documentElement._mtLinkBound = true;
  document.addEventListener(
    "click",
    (ev) => {
      const a = ev.target && ev.target.closest && ev.target.closest("a");
      if (!a) return;
      const inContent =
        a.classList.contains("mt-link") ||
        a.closest(".md") ||
        a.closest(".dsh-msg-body") ||
        a.closest(".dsh-tool-body") ||
        a.closest(".dsh-think") ||
        a.closest(".chat-bubble") ||
        a.closest(".app-docs-ask-msg");
      if (!inContent) return;
      const href = String(a.getAttribute("href") || "");
      if (!href || href.charAt(0) === "#") return;
      const kind = a.getAttribute("data-mt-open") || "";
      if (
        !kind &&
        !/^https?:\/\//i.test(href) &&
        !/^file:/i.test(href) &&
        !/^mailto:/i.test(href)
      )
        return;
      ev.preventDefault();
      ev.stopPropagation();
      if (/^mailto:/i.test(href)) {
        if (window.api && window.api.openExternal) window.api.openExternal(href);
        return;
      }
      openContentRef(href, kind);
    },
    true,
  );
}

function renderMarkdown(text) {
  const esc = escapeHtml(text);
  let html = "";
  try {
    html = window.marked
      ? marked.parse(esc, { gfm: true, breaks: true })
      : "<pre>" + esc + "</pre>";
  } catch {
    html = "<pre>" + esc + "</pre>";
  }
  html = html.replace(/<a href="([^"]*)"/g, (m, u) => {
    if (/^(https?:|mailto:)/i.test(u) || u.charAt(0) === "#") return m;
    return I18n.t('<a href="#" title="已阻止不安全链接"');
  });
  return linkifyHtml(html);
}

/* 解析 Hex 颜色（#RRGGBB / RRGGBB） */
function parseHexColor(h) {
  if (typeof h !== "string") return null;
  const m = h.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* 图像生成 · 透明背景（双通道差分抠图 Two-Pass Difference Matting）
   第 1 次生成纯白背景，随后自动生成严格对齐的纯黑背景第 2 通道，两图差分出真实 Alpha。
   成像模型：A = F·α + 255·(1-α)（白底）  B = F·α（黑底）
   ⇒ α = (255 - A + B) / 255    F = (A + B - 255·(1-α)) / (2α)                       */
/* 双通道差分抠图的算法参数：
   bgRmTol  = 噪点地板（0-128，越大越敢把半透明像素判成完全透明，用于压掉生图噪声/边缘灰雾）
   bgRmSoft = 边缘羽化（0-128，只糊 Alpha 通道，不动颜色，让抠图边缘更自然）
   bgRmAlign= 自动对齐修正（默认开：把第 2 通道按前景包围盒对齐到第 1 通道）
   bgRmKey  = 旧「色键抠图」遗留字段，保留读写仅为兼容旧画布，本算法不再使用 */
function normalizeBgRm(node) {
  if (!node || node.kind !== "proc_image") return;
  if (node.bgRmOn == null) node.bgRmOn = false;
  if (!parseHexColor(node.bgRmKey)) node.bgRmKey = "#FF00FF";
  else node.bgRmKey = "#" + node.bgRmKey.trim().replace(/^#/, "").toUpperCase();
  const tol = Number(node.bgRmTol);
  node.bgRmTol = Number.isFinite(tol) ? Math.max(0, Math.min(128, Math.round(tol))) : 24;
  const soft = Number(node.bgRmSoft);
  node.bgRmSoft = Number.isFinite(soft)
    ? Math.max(0, Math.min(128, Math.round(soft)))
    : 32;
  if (node.bgRmAlign == null) node.bgRmAlign = true;
  if (!Array.isArray(node.bgRmPairs)) node.bgRmPairs = [];
}
/* 注入段用 ASCII 标记包裹：中英文界面下都能被精确剥离，用户正文永不污染第 2 通道 */
const MATTE_BLOCK_HEAD = "\n\n[[MTNODE-MATTE-PASS]]";
const MATTE_BLOCK_TAIL = "[[/MTNODE-MATTE-PASS]]";
const MATTE_BLOCK_RE = /\n\n\[\[MTNODE-MATTE-PASS\]\][\s\S]*?\[\[\/MTNODE-MATTE-PASS\]\]/g;
function stripMatteBlocks(prompt) {
  return String(prompt || "").replace(MATTE_BLOCK_RE, "");
}
function matteBlock(text) {
  return MATTE_BLOCK_HEAD + "\n" + text + "\n" + MATTE_BLOCK_TAIL;
}
/* 第 1 通道：纯白背景 */
function bgRmPromptSuffix(node) {
  if (!node || node.kind !== "proc_image" || !node.bgRmOn) return "";
  normalizeBgRm(node);
  return matteBlock(
    I18n.t(
      "【透明背景 · 双通道差分抠图｜第 1 通道：纯白背景】请把画面中除主体以外的全部背景区域（含天空、地面、投影、环境细节）绘制成完全均匀的纯白 #FFFFFF：无渐变、无纹理、无阴影、无反射、无暗角、无地面投影。主体保持完整清晰，边缘锐利干净，构图居中稳定、四周留出一圈空白边距，主体不得触碰或超出画面边缘。除背景外，不要改变主体的造型、颜色与细节。",
    ),
  );
}
/* 第 2 通道：纯黑背景（anchor=true 时把第 1 通道作为参考图下发，要求逐像素复刻只换背景） */
function bgRmSecondSuffix(node, anchor) {
  if (!node || node.kind !== "proc_image" || !node.bgRmOn) return "";
  normalizeBgRm(node);
  return matteBlock(
    anchor
      ? I18n.t(
          "【透明背景 · 双通道差分抠图｜第 2 通道：纯黑背景】请把参考图的背景整体替换为完全均匀的纯黑 #000000：无渐变、无纹理、无光晕、无投影。除背景颜色以外，画面的一切内容必须与参考图逐像素完全一致——主体的位置、大小、比例、朝向、姿态、轮廓、颜色、纹理、细节、光照、构图与画幅都不得有任何变化；不要重绘主体，不要移动，不要缩放，不要裁切，不要加边框。",
        )
      : I18n.t(
          "【透明背景 · 双通道差分抠图｜第 2 通道：纯黑背景】请把画面中除主体以外的全部背景区域（含天空、地面、投影、环境细节）绘制成完全均匀的纯黑 #000000：无渐变、无纹理、无阴影、无反射、无暗角、无地面投影。主体保持完整清晰，边缘锐利干净，构图居中稳定、四周留出一圈空白边距，主体不得触碰或超出画面边缘。除背景外，不要改变主体的造型、颜色与细节；本通道必须与第 1 通道完全对齐。",
        ),
  );
}
function withBgRmPrompt(node, prompt) {
  return String(prompt || "") + bgRmPromptSuffix(node);
}
/* 由第 1 通道请求规格派生第 2 通道请求：剥掉白底注入段，换上黑底注入段 */
function bgRmSecondPrompt(node, prompt, anchor) {
  return stripMatteBlocks(prompt) + bgRmSecondSuffix(node, anchor);
}
function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(I18n.t("无法读取图像")));
    img.src = url;
  });
}
function makeRgbaCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w | 0);
  c.height = Math.max(1, h | 0);
  return { c, ctx: c.getContext("2d", { willReadFrequently: true }) };
}
/* 读本地图像为 RGBA 像素（含 canvas 与 ctx，便于后续变换绘制） */
async function readImageRGBA(path) {
  const img = await loadImageFromUrl(fileUrlWithBust(path, Date.now()));
  const w = Math.max(1, img.naturalWidth || img.width || 1);
  const h = Math.max(1, img.naturalHeight || img.height || 1);
  const { c, ctx } = makeRgbaCanvas(w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { img, c, ctx, id: ctx.getImageData(0, 0, w, h), w, h };
}
/* 前景包围盒：与背景色（纯白 / 纯黑）足够不同的像素才算主体 */
function matteFgBBox(id, w, h, bg, thr) {
  const d = id.data;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1,
    n = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) << 2;
      const dr = Math.abs(d[i] - bg[0]);
      const dg = Math.abs(d[i + 1] - bg[1]);
      const db = Math.abs(d[i + 2] - bg[2]);
      if (Math.max(dr, dg, db) <= thr) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  /* 主体过小说明这一通道几乎被背景吃掉（模型没按指令出图）或是噪点，不做仿射对齐 */
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (n < Math.max(8, w * h * 0.0015) || bw < 4 || bh < 4) return null;
  return { x: x0, y: y0, w: bw, h: bh, n };
}
/* Alpha 逐通道估计：α = (255 - 白底值 + 黑底值) / 255 */
function matteAlphaOf(ar, ag, ab, br, bg, bb) {
  let r = (255 - ar + br) / 255;
  let g = (255 - ag + bg) / 255;
  let b = (255 - ab + bb) / 255;
  r = r < 0 ? 0 : r > 1 ? 1 : r;
  g = g < 0 ? 0 : g > 1 ? 1 : g;
  b = b < 0 ? 0 : b > 1 ? 1 : b;
  return (r + g + b) / 3;
}
/* 对齐质量评分：过渡带上「三通道 Alpha 是否互相吻合」，越吻合说明两通道对得越准 */
function matteShiftScore(a, b, w, h, dx, dy) {
  let sum = 0,
    cnt = 0;
  /* 取 B 的 (x+dx, y+dy) 与 A 的 (x,y) 比对：源坐标必须留在画面内，否则会跨行取样 */
  const x0 = dx < 0 ? -dx : 0;
  const x1 = w - (dx > 0 ? dx : 0);
  const y0 = dy < 0 ? -dy : 0;
  const y1 = h - (dy > 0 ? dy : 0);
  for (let y = y0; y < y1; y += 3) {
    const row = y * w;
    for (let x = x0; x < x1; x += 3) {
      const i = (row + x) << 2;
      const j = ((y + dy) * w + (x + dx)) << 2;
      const al = matteAlphaOf(
        a[i],
        a[i + 1],
        a[i + 2],
        b[j],
        b[j + 1],
        b[j + 2],
      );
      if (al < 0.08 || al > 0.92) continue; // 只看边缘过渡像素
      let r = (255 - a[i] + b[j]) / 255;
      let g = (255 - a[i + 1] + b[j + 1]) / 255;
      let bl = (255 - a[i + 2] + b[j + 2]) / 255;
      const mx = r > g ? (r > bl ? r : bl) : g > bl ? g : bl;
      const mn = r < g ? (r < bl ? r : bl) : g < bl ? g : bl;
      sum += mx - mn;
      cnt++;
    }
  }
  return cnt < 24 ? Infinity : sum / cnt;
}
/* 半分辨率小图（对齐搜索用，省掉数倍像素遍历） */
function downscaleRGBA(src, sw, sh, scale) {
  const w = Math.max(8, Math.round(sw * scale));
  const h = Math.max(8, Math.round(sh * scale));
  const { c, ctx } = makeRgbaCanvas(w, h);
  ctx.drawImage(src, 0, 0, w, h);
  return { id: ctx.getImageData(0, 0, w, h), w, h };
}
/* 把第 2 通道（黑底）对齐到第 1 通道（白底）：前景包围盒仿射 + 小范围平移搜索 */
function alignMatteSecond(aFull, bFull, node) {
  const w = aFull.w,
    h = aFull.h;
  const sameSize = bFull.w === w && bFull.h === h;
  const { c, ctx } = makeRgbaCanvas(w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const bbA = matteFgBBox(aFull.id, w, h, [255, 255, 255], 40);
  const bbB = matteFgBBox(bFull.id, bFull.w, bFull.h, [0, 0, 0], 40);
  let sx = 1,
    sy = 1,
    tx = 0,
    ty = 0;
  if (!sameSize) {
    /* 尺寸不一致（服务商按宽高比取整等）：等比铺满到第 1 通道尺寸，不再做仿射 */
    ctx.drawImage(bFull.c, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }
  if (node.bgRmAlign && bbA && bbB) {
    /* 前景包围盒对齐：把第 2 通道的主体框映射到第 1 通道的主体框上 */
    sx = Math.max(0.5, Math.min(2, bbA.w / bbB.w));
    sy = Math.max(0.5, Math.min(2, bbA.h / bbB.h));
    tx = bbA.x - bbB.x * sx;
    ty = bbA.y - bbB.y * sy;
  }
  ctx.save();
  ctx.setTransform(sx, 0, 0, sy, tx, ty);
  ctx.drawImage(bFull.c, 0, 0);
  ctx.restore();
  const placed = ctx.getImageData(0, 0, w, h);
  if (!node.bgRmAlign) return placed;
  /* 平移微调：在半分辨率上找最吻合的整数偏移，再映射回全分辨率 */
  const sa = downscaleRGBA(aFull.c, w, h, 0.5);
  const sb = downscaleRGBA(c, w, h, 0.5);
  const range = 6;
  let bestDx = 0,
    bestDy = 0,
    best = matteShiftScore(sa.id.data, sb.id.data, sa.w, sa.h, 0, 0);
  if (!Number.isFinite(best)) return placed;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      if (!dx && !dy) continue;
      const s = matteShiftScore(sa.id.data, sb.id.data, sa.w, sa.h, dx, dy);
      if (s < best) {
        best = s;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  if (!bestDx && !bestDy) return placed;
  const c2 = makeRgbaCanvas(w, h);
  c2.ctx.drawImage(c, bestDx * 2, bestDy * 2);
  return c2.ctx.getImageData(0, 0, w, h);
}
/* Alpha 通道单独羽化（只糊透明度，不动颜色） */
function featherMatteAlpha(out, w, h, radius) {
  if (radius < 1) return;
  const n = w * h;
  const tmp = new Float32Array(n);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = out[i << 2 | 3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0,
        c = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        s += a[y * w + xx];
        c++;
      }
      tmp[y * w + x] = s / (c || 1);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0,
        c = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        s += tmp[yy * w + x];
        c++;
      }
      out[(y * w + x) << 2 | 3] = Math.round(s / (c || 1));
    }
  }
}
/* 核心：两通道差分 → 透明 PNG 像素 */
function differenceMattePixels(aId, bId, node) {
  normalizeBgRm(node);
  const a = aId.data,
    b = bId.data;
  const out = new Uint8ClampedArray(a.length);
  const floor = (node.bgRmTol / 128) * 0.5;
  for (let i = 0; i < a.length; i += 4) {
    const ar = a[i], ag = a[i + 1], ab = a[i + 2];
    const br = b[i], bg = b[i + 1], bb = b[i + 2];
    let al = matteAlphaOf(ar, ag, ab, br, bg, bb);
    if (floor > 0) al = al <= floor ? 0 : (al - floor) / (1 - floor);
    if (al > 0.985) al = 1;
    if (al <= 0) {
      out[i + 3] = 0;
      continue;
    }
    /* 直出非预乘色：取白底/黑底两条估计的均值再除以 α，噪声最低 */
    const inv = 1 / al;
    const pr = (ar - 255 * (1 - al) + br) * 0.5 * inv;
    const pg = (ag - 255 * (1 - al) + bg) * 0.5 * inv;
    const pb = (ab - 255 * (1 - al) + bb) * 0.5 * inv;
    out[i] = pr < 0 ? 0 : pr > 255 ? 255 : pr;
    out[i + 1] = pg < 0 ? 0 : pg > 255 ? 255 : pg;
    out[i + 2] = pb < 0 ? 0 : pb > 255 ? 255 : pb;
    out[i + 3] = Math.round(al * 255);
  }
  const w = aId.width,
    h = aId.height;
  featherMatteAlpha(out, w, h, Math.max(0, Math.min(4, Math.round(node.bgRmSoft / 32))));
  const { c, ctx } = makeRgbaCanvas(w, h);
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
  return c;
}
async function differenceMatteAssetPath(node, whitePath, blackPath, outName) {
  const a = await readImageRGBA(whitePath);
  const b = await readImageRGBA(blackPath);
  const aligned = alignMatteSecond(a, b, node);
  const canvas = differenceMattePixels(a.id, aligned, node);
  const b64 = canvas.toDataURL("image/png").split(",")[1];
  const res = await window.api.assetWriteBase64(S.wf.id, outName, b64, "png");
  if (!res || !res.ok || !res.path)
    throw new Error((res && res.error) || I18n.t("透明背景写入失败"));
  return res.path;
}
/* 记录两通道配对（白底 / 黑底 / 透明结果），改参数后可「立即重算」而不必再次消耗 Token */
function rememberMattePair(node, whitePath, blackPath, outPath) {
  if (!Array.isArray(node.bgRmPairs)) node.bgRmPairs = [];
  node.bgRmPairs = node.bgRmPairs.filter(
    (p) => p && p.white !== whitePath && p.out !== outPath,
  );
  node.bgRmPairs.push({ white: whitePath, black: blackPath, out: outPath });
  if (node.bgRmPairs.length > 12) node.bgRmPairs.shift();
}
/* 第 2 通道请求：OpenAI 兼容生图带上白底那张当参考图（edits），对齐度远高于重新文生图 */
async function runBgRmSecondPass(node, spec, whitePath, itemTitle, attemptT) {
  const ptype = (spec.provider && spec.provider.type) || "";
  const anchor = ptype === "image_openai" && !!whitePath;
  const base = Array.isArray(spec.images) ? spec.images.slice() : [];
  const spec2 = Object.assign({}, spec, {
    prompt: bgRmSecondPrompt(node, spec.prompt, anchor),
    images: anchor ? base.concat([whitePath]) : base,
  });
  if (anchor) spec2.refImage = spec2.images[0] || "";
  const rr = await window.api.apiCall(spec2);
  if (node._aborted) throw new Error(I18n.t("已手动停止"));
  if (!rr || !rr.ok)
    throw new Error((rr && rr.error) || I18n.t("第 2 通道（纯黑背景）调用失败"));
  if (!rr.base64) throw new Error(I18n.t("第 2 通道响应无图像数据"));
  const res = await window.api.assetWriteBase64(
    S.wf.id,
    assetName(node, itemTitle, attemptT, "matteB"),
    rr.base64,
    rr.ext || "png",
  );
  if (!res || !res.ok || !res.path)
    throw new Error((res && res.error) || I18n.t("第 2 通道写入失败"));
  return res.path;
}
/* 图像生成节点出图后的收尾：透明背景开启时内部自动补第 2 通道并抠图。
   对用户全程无感知 —— 正常输入提示词即可，失败时退回白底原图并提示原因。 */
async function finishProcImageOutput(node, spec, path, itemTitle, attemptT) {
  if (!node || node.kind !== "proc_image" || !path) return path;
  normalizeBgRm(node);
  if (!node.bgRmOn) return path;
  if (node._aborted) throw new Error(I18n.t("已手动停止"));
  const t0 = Date.now();
  try {
    const blackPath = await runBgRmSecondPass(node, spec, path, itemTitle, attemptT);
    const out = await differenceMatteAssetPath(
      node,
      path,
      blackPath,
      assetName(node, itemTitle, attemptT, "alpha"),
    );
    rememberMattePair(node, path, blackPath, out);
    scheduleSave(true);
    /* 只在单张出图时提示，批量 × 多次尝试时不打扰（每条都弹一次会变成刷屏） */
    const single = !node.batchOutputs && (typeof attemptCount !== "function" || attemptCount(node) <= 1);
    if (single)
      toast(
        I18n.t("透明背景完成（双通道差分抠图，耗时 ") +
          Math.max(1, Math.round((Date.now() - t0) / 1000)) +
          I18n.t(" 秒）"),
        "ok",
      );
    return out;
  } catch (e) {
    if (node._aborted) throw e;
    toast(
      I18n.t("透明背景抠图未完成，已交付白底原图：") + (e.message || e),
      "warn",
    );
    return path;
  }
}
async function reprocessProcImageBgRm(node) {
  if (!node || node.kind !== "proc_image") return 0;
  normalizeBgRm(node);
  if (!node.bgRmOn) {
    toast(I18n.t("请先开启透明背景"), "warn");
    return 0;
  }
  /* 只复用本节点已生成的两通道记录重算：不再调用 API，因此不额外耗 Token */
  const pairs = (node.bgRmPairs || []).filter((p) => p && p.white && p.black);
  if (!pairs.length) {
    toast(I18n.t("没有可复用的两通道记录：请点 ▶ 重新生成一次"), "warn");
    return 0;
  }
  const map = new Map();
  for (const p of pairs) {
    try {
      const out = await differenceMatteAssetPath(
        node,
        p.white,
        p.black,
        assetName(node, "", 0, "alpha"),
      );
      map.set(p.out, out);
      map.set(p.white, out);
      p.out = out;
    } catch (e) {
      toast(I18n.t("重算失败：") + (e.message || e), "warn");
    }
  }
  const rewrite = (obj) => {
    if (!obj || !obj.path || !map.has(obj.path)) return;
    obj.path = map.get(obj.path);
  };
  if (node.output) rewrite(node.output);
  if (node.batchOutputs) {
    for (const x of node.batchOutputs) if (x && x.output) rewrite(x.output);
  }
  if (Array.isArray(node.attemptOutputs)) {
    for (const a of node.attemptOutputs) {
      if (!a) continue;
      if (a.output) rewrite(a.output);
      if (a.batchOutputs) {
        for (const x of a.batchOutputs) if (x && x.output) rewrite(x.output);
      }
    }
  }
  scheduleSave(true);
  renderCanvas();
  const done = new Set([...map.values()]).size;
  if (done)
    toast(I18n.t("已按新参数重算 ") + done + I18n.t(" 张透明背景图像"), "ok");
  return done;
}
function closeBgRmPop() {
  S.uiBgRmNode = null;
  const el = $("#bgRmPop");
  if (el) el.classList.remove("on");
}
/* Hover 提示：开关两态各一条，把「2 张图 / 2 倍 Token」的代价说在前面 */
function bgRmTipOn() {
  return I18n.t(
    "透明背景 · 双通道差分抠图：已开启\n\n开启后本节点生成的图像会自动变为透明背景（带 Alpha 的 PNG）。\n算法：第 1 次生成纯白背景，随后自动补生成一张完全一致、严格对齐的纯黑背景图，两图逐像素差分出真实 Alpha（半透明边缘也能保留）。\n\n⚠ 整个过程在内部完成，你只需正常写提示词；但每次出图实际要生成 2 张，Token 与耗时约为 2 倍，请慎用。\n\n单击 = 关闭 · 右键 = 调整抠图参数",
  );
}
function bgRmTipOff() {
  return I18n.t(
    "透明背景 · 双通道差分抠图：已关闭（单击开启）\n\n开启后生成的图像会变为透明背景：先出纯白背景，再自动出严格对齐的纯黑背景，两图差分抠出 Alpha。\n\n⚠ 需要生成 2 次图像，因此耗费 2 倍 Token，请慎用。\n\n右键 = 调整抠图参数",
  );
}
/* 抠图参数面板：开关已上移到节点头部 Toggle，这里只放算法微调（右键 Toggle 打开） */
function openBgRmPop(node, anchorEl) {
  if (!node || node.kind !== "proc_image") return;
  normalizeBgRm(node);
  S.uiBgRmNode = node.id;
  let el = $("#bgRmPop");
  if (!el) {
    el = document.createElement("div");
    el.id = "bgRmPop";
    el.className = "bg-rm-pop";
    el.innerHTML =
      '<div class="bg-rm-head"><b></b><button type="button" class="mini" data-act="close">✕</button></div>' +
      '<label class="bg-rm-row"><input type="checkbox" data-f="on"/> <span></span></label>' +
      '<label class="bg-rm-row"><input type="checkbox" data-f="align"/> <span></span></label>' +
      '<label class="bg-rm-field"><span data-l="tol"></span>' +
      '<input type="number" data-f="tol" min="0" max="128" step="1"/></label>' +
      '<label class="bg-rm-field"><span data-l="soft"></span>' +
      '<input type="number" data-f="soft" min="0" max="128" step="1"/></label>' +
      '<p class="bg-rm-hint" data-f="hint"></p>' +
      '<div class="bg-rm-actions">' +
      '<button type="button" class="mini" data-act="apply">' +
      "</button></div>";
    document.body.appendChild(el);
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.querySelector('[data-act="close"]').onclick = () => closeBgRmPop();
  }
  el.querySelector(".bg-rm-head b").textContent = I18n.t(
    "透明背景 · 双通道差分抠图",
  );
  el.querySelector('[data-f="on"]').nextElementSibling.textContent = I18n.t(
    "启用（自动生成白底 + 黑底两张图后差分抠图，2 倍 Token）",
  );
  el.querySelector('[data-f="align"]').nextElementSibling.textContent = I18n.t(
    "自动对齐修正（按前景包围盒与边缘吻合度对齐第 2 通道）",
  );
  el.querySelector('[data-l="tol"]').textContent = I18n.t(
    "噪点地板（越低越保留半透明，越高越敢判为全透明，0-128）",
  );
  el.querySelector('[data-l="soft"]').textContent = I18n.t(
    "边缘羽化（只平滑 Alpha 通道，0-128）",
  );
  el.querySelector('[data-f="hint"]').textContent = I18n.t(
    "第 1 通道注入纯白背景要求，第 2 通道自动注入完全一致的纯黑背景要求（OpenAI 兼容生图会把第 1 张当参考图下发，对齐度更高），两图按 α=(255-白+黑)/255 逐像素求出 Alpha。提示词正文由你正常书写，注入段不会显示在你的输入里。",
  );
  el.querySelector('[data-act="apply"]').textContent = I18n.t(
    "用已存的两通道重算抠图",
  );

  const onBox = el.querySelector('[data-f="on"]');
  const alignBox = el.querySelector('[data-f="align"]');
  const tolIn = el.querySelector('[data-f="tol"]');
  const softIn = el.querySelector('[data-f="soft"]');
  const syncFromNode = () => {
    normalizeBgRm(node);
    onBox.checked = !!node.bgRmOn;
    alignBox.checked = !!node.bgRmAlign;
    tolIn.value = String(node.bgRmTol);
    softIn.value = String(node.bgRmSoft);
  };
  syncFromNode();
  onBox.onchange = () => {
    pushHistory();
    node.bgRmOn = !!onBox.checked;
    scheduleSave();
    renderCanvas();
    const btn = document.querySelector(
      '.wf-node[data-nid="' + node.id + '"] .n-bgrm-btn',
    );
    openBgRmPop(node, btn);
  };
  alignBox.onchange = () => {
    pushHistory();
    node.bgRmAlign = !!alignBox.checked;
    scheduleSave();
  };
  tolIn.onchange = () => {
    pushHistory();
    node.bgRmTol = Math.max(0, Math.min(128, Math.round(Number(tolIn.value) || 0)));
    tolIn.value = String(node.bgRmTol);
    scheduleSave();
  };
  softIn.onchange = () => {
    pushHistory();
    node.bgRmSoft = Math.max(
      0,
      Math.min(128, Math.round(Number(softIn.value) || 0)),
    );
    softIn.value = String(node.bgRmSoft);
    scheduleSave();
  };
  el.querySelector('[data-act="apply"]').onclick = async () => {
    try {
      await reprocessProcImageBgRm(node);
    } catch (e) {
      toast(I18n.t("重算失败：") + (e.message || e), "err");
    }
  };

  const r = (anchorEl || document.body).getBoundingClientRect();
  el.classList.add("on");
  const pad = 8;
  let left = r.left;
  let top = r.bottom + 6;
  const w = 300;
  const h = el.offsetHeight || 320;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (left < pad) left = pad;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);
  el.style.left = left + "px";
  el.style.top = top + "px";
}
/* 节点头部的「透明背景」Toggle：
   关 = 灰白格图标；开 = 图标内容隐去，整颗按钮只剩一圈旋转的彩虹边缘动效 */
function bgRmButtonEl(node) {
  normalizeBgRm(node);
  const on = !!node.bgRmOn;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "n-play n-bgrm-btn n-matte-toggle" + (on ? " on" : "");
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", on ? "true" : "false");
  btn.setAttribute("aria-label", I18n.t("透明背景"));
  btn.dataset.on = on ? "1" : "0";
  btn.innerHTML = '<span class="n-bgrm-ico" aria-hidden="true"></span>';
  btn.title = on ? bgRmTipOn() : bgRmTipOff();
  btn.onclick = (ev) => {
    ev.stopPropagation();
    closeBgRmPop();
    pushHistory();
    node.bgRmOn = !node.bgRmOn;
    scheduleSave(true);
    renderCanvas();
    toast(
      node.bgRmOn
        ? I18n.t(
            "透明背景已开启：每次生成会出 2 张图（白底 + 对齐的黑底），Token 与耗时约 2 倍",
          )
        : I18n.t("透明背景已关闭"),
      node.bgRmOn ? "warn" : "ok",
    );
  };
  btn.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (S.uiBgRmNode === node.id) {
      closeBgRmPop();
      return;
    }
    openBgRmPop(node, btn);
  };
  return btn;
}

/* ============ 思考内容（模型 reasoning，流式） ============ */

/* 追加思考增量到 nodeId 的尝试槽；刷新节点 icon 与思考弹窗（rAF 节流） */
const thinkRAF = {};
function pushThinking(nid, attempt, txt) {
  if (!txt) return;
  if (!S.thinking) S.thinking = {};
  if (!S.thinking[nid]) S.thinking[nid] = [];
  if (!S.thinking[nid][attempt]) S.thinking[nid][attempt] = "";
  S.thinking[nid][attempt] += txt;
  refreshThinkingUI(nid);
}
function thinkingTextOf(node) {
  if (!node || !S.thinking || !S.thinking[node.id]) return "";
  /* 只给思考正文：旧版缓冲里残留的「🔧 工具名」行不再混进思考区 */
  return stripToolLines(S.thinking[node.id][attemptIdx(node)] || "");
}
/* 运行中会话:思考内容默认折叠,仅展开时刷新正文,避免每个 reasoning 块都重写大文本(降低运行期负载) */
function agentThinkText(st, live) {
  if (live) return thinkingTextOf(live) || "";
  return (
    (S.thinking &&
      S.thinking["agent:" + ((st && st.id) || "")] &&
      S.thinking["agent:" + ((st && st.id) || "")][0]) || ""
  );
}
/* 思考区（reasoning 正文）的阅读位置：整表重绘时 details/pre 都是新元素，
   所以把 scrollTop 与「是否跟随底部」按会话 id 存到 S 上，重建后还原。
   跟随判定只看几何：用户上翻 → 脱离跟随；自己滚回底部 → 恢复跟随。
   程序写入 scrollTop 期间（_convAutoScroll）不重新判定，避免与用户抢滚动条。 */
const THINK_STICK_SLACK = 24;
function agentThinkKey(st) {
  return (st && st.id) || "agent";
}
function agentThinkStickOf(st) {
  return !(
    S._agentThinkStick && S._agentThinkStick[agentThinkKey(st)] === false
  );
}
function rememberAgentThinkScroll(st, pre) {
  if (!pre) return;
  /* details 收起时 pre 不参与布局（clientHeight=0），此刻读到的 scrollTop
     没有意义，不能拿它覆盖已存的阅读位置 */
  if (!pre.clientHeight) return;
  const k = agentThinkKey(st);
  if (!S._agentThinkScroll) S._agentThinkScroll = {};
  if (!S._agentThinkStick) S._agentThinkStick = {};
  S._agentThinkScroll[k] = pre.scrollTop;
  S._agentThinkStick[k] = isScrollNearBottom(pre, THINK_STICK_SLACK);
}
/* force = 用户真实点击展开且本就贴底 → 直接定位到底；否则按跟随状态还原 */
function applyAgentThinkScroll(st, pre, force) {
  if (!pre) return;
  if (force || agentThinkStickOf(st)) {
    setConvScrollTop(pre, pre.scrollHeight);
  } else {
    const top =
      (S._agentThinkScroll && S._agentThinkScroll[agentThinkKey(st)]) || 0;
    if (pre.scrollTop !== top) setConvScrollTop(pre, top);
  }
  if (!force) rememberAgentThinkScroll(st, pre);
}
/* 用户在内层 pre 上滚动 → 记录阅读位置与跟随状态（按 st.id 隔离） */
function bindAgentThinkScroll(st, pre) {
  if (!pre || pre._thinkStickBound) return pre;
  pre._thinkStickBound = true;
  let raf = 0;
  const recompute = () => {
    if (raf || typeof requestAnimationFrame !== "function") return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (pre._convAutoScroll) return;
      rememberAgentThinkScroll(st, pre);
    });
  };
  pre.addEventListener(
    "scroll",
    () => {
      /* 程序滚动不改写用户意图（守卫解除后由下一次真实滚动重新判定） */
      if (!pre._convAutoScroll) recompute();
    },
    { passive: true },
  );
  return pre;
}
let _thinkSumRAF = 0;
function updateAgentThinkEl(st, live) {
  if (_thinkSumRAF) return;
  _thinkSumRAF = requestAnimationFrame(() => {
    _thinkSumRAF = 0;
    const det = document.getElementById("agent-think");
    if (!det) return;
    const txt = agentThinkText(st, live);
    const sum = det.querySelector("summary");
    if (sum)
      sum.textContent =
        I18n.t("思考过程 · ") + txt.length + I18n.t(" 字") + I18n.t(" · 点击查看");
    /* 仅展开时写正文;关闭状态只更新字数摘要 */
    if (det.open) {
      const pre = document.getElementById("agent-think-body");
      if (pre) {
        pre.textContent = txt;
        /* 不再无条件拽到底：贴底才跟随，用户上翻就停在原地继续读 */
        applyAgentThinkScroll(st, pre, false);
      }
    }
  });
}
/* 对话 / 会话列表：仅在已贴底（或强制）时自动滚到底，避免运行中上翻历史被拽回。
   「贴底」以用户意图为准（_convStick）：只有用户自己滚到底部才跟随；用户一旦
   上翻（哪怕一点）立刻脱离跟随，直到用户自己再滚回底部。程序写入 scrollTop
   不打断该判定（_convAutoScroll 守卫），避免与用户抢滚动条。 */
const CONV_SCROLL_SLACK = 56;
function isScrollNearBottom(el, slack) {
  if (!el) return true;
  const s = slack == null ? CONV_SCROLL_SLACK : slack;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - s;
}
const CONV_STICK_SLACK = 24;
/* 程序滚动：写完后一帧内到达的 scroll 事件视为自己造成的，不反过来改用户意图 */
function setConvScrollTop(el, top) {
  if (!el) return;
  el._convAutoScroll = true;
  el.scrollTop = top;
  if (typeof requestAnimationFrame === "function")
    requestAnimationFrame(() => {
      el._convAutoScroll = false;
    });
  else el._convAutoScroll = false;
}
function convStickOf(el) {
  return !(el && el._convStick === false);
}
function markConvStick(el, v) {
  if (el) el._convStick = !!v;
}
function bindConvStick(el) {
  if (!el || el._convStickBound) return el;
  el._convStickBound = true;
  /* _convStick 只由「用户自己的滚动」决定：undefined = 还没表过态 → 默认跟随。
     不能按当前几何初始化：节点内联会话每次重绘都是新元素（scrollTop=0），
     一初始化成 false 就再也不会跟到底了。 */
  let raf = 0;
  const recompute = () => {
    if (raf || typeof requestAnimationFrame !== "function") return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (el._convAutoScroll) return;
      el._convStick = isScrollNearBottom(el, CONV_STICK_SLACK);
    });
  };
  el.addEventListener(
    "scroll",
    () => {
      if (el._convAutoScroll) return;
      recompute();
    },
    { passive: true },
  );
  /* 向上滚：立刻脱离跟随（不等下一帧，避免同帧内的程序滚动抢先把它拽回去）；
     向下滚：交给 scroll 事件重新判定，滚到底自然恢复跟随。
     若这一帧列表其实没动（滚轮落在内层代码块 / 折叠块上），撤销这次脱离。 */
  el.addEventListener(
    "wheel",
    (ev) => {
      if ((ev.deltaY || 0) >= 0) {
        recompute();
        return;
      }
      const before = el.scrollTop;
      const prev = el._convStick;
      el._convStick = false;
      if (typeof requestAnimationFrame !== "function") return;
      requestAnimationFrame(() => {
        if (el.scrollTop === before) el._convStick = prev;
      });
    },
    { passive: true },
  );
  el.addEventListener("touchmove", recompute, { passive: true });
  el.addEventListener("pointerdown", recompute);
  el.addEventListener("keydown", (ev) => {
    const k = ev.key;
    if (k === "ArrowUp" || k === "PageUp" || k === "Home")
      el._convStick = false;
    else if (k === "ArrowDown" || k === "PageDown" || k === "End") recompute();
  });
  return el;
}
function scrollElToBottomIfStuck(el, force) {
  if (!el) return;
  bindConvStick(el);
  if (force) {
    markConvStick(el, true);
    setConvScrollTop(el, el.scrollHeight);
    return;
  }
  /* 节点内联会话的跟随状态也记在元素几何上，两者任一成立才滚 */
  if (!convStickOf(el) && !isScrollNearBottom(el, CONV_STICK_SLACK)) return;
  setConvScrollTop(el, el.scrollHeight);
}
/* 阅读锚点：视口里最靠上的那条消息 + 它在视口内的偏移。
   重绘 / 历史折叠会突变上方内容高度，用锚点还原才不会让画面突然跳走。 */
function convRows(el) {
  const out = [];
  if (!el) return out;
  for (const c of el.children || []) {
    if (c.classList && c.classList.contains("dsh-msg")) out.push(c);
  }
  return out;
}
/* 行在滚动内容坐标系里的顶部位置。offsetTop 会随 offsetParent 变化（历史轨道
   包裹层是后来插入的），所以用 rect 差值换算；base 每次批量测量算一次即可。 */
function convScrollBase(el) {
  try {
    if (el._convBorderTop == null)
      el._convBorderTop = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
    return el.getBoundingClientRect().top - el.scrollTop + el._convBorderTop;
  } catch {
    return 0;
  }
}
function convRowTop(el, r, base) {
  const b = base == null ? convScrollBase(el) : base;
  try {
    return r.getBoundingClientRect().top - b;
  } catch {
    return r.offsetTop;
  }
}
function convAnchorOf(el) {
  const top = el.scrollTop;
  const base = convScrollBase(el);
  const rows = convRows(el);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const t = convRowTop(el, r, base);
    if (t + r.offsetHeight > top + 1)
      return {
        key: r.dataset && r.dataset.histKey ? r.dataset.histKey : "",
        idx: i,
        off: t - top,
      };
  }
  return null;
}
function captureConvStick(el, force) {
  if (!el) return { stick: true, top: 0, prevH: 0, anchor: null };
  bindConvStick(el);
  const stick = !!(
    force ||
    convStickOf(el) ||
    isScrollNearBottom(el, CONV_STICK_SLACK)
  );
  if (force) markConvStick(el, true);
  return {
    stick,
    top: el.scrollTop,
    prevH: el.scrollHeight,
    anchor: stick ? null : convAnchorOf(el),
  };
}
function restoreConvStick(el, cap) {
  if (!el || !cap) return;
  if (cap.stick) {
    setConvScrollTop(el, el.scrollHeight);
    return;
  }
  const a = cap.anchor;
  if (a) {
    const rows = convRows(el);
    let r = a.key
      ? rows.find((x) => x.dataset && x.dataset.histKey === a.key)
      : null;
    if (!r) r = rows[a.idx] || null;
    if (r) {
      setConvScrollTop(el, Math.max(0, convRowTop(el, r) - a.off));
      return;
    }
  }  /* 锚点消失（可见轮次切片变化等）→ 按比例还原，绝不回落到「滚到底」 */
  if (cap.prevH > 0 && el.scrollHeight !== cap.prevH) {
    setConvScrollTop(
      el,
      Math.max(0, Math.round((cap.top * el.scrollHeight) / cap.prevH)),
    );
    return;
  }
  setConvScrollTop(el, cap.top);
}

/* ── 内层滚动块（思考过程 pre / 节点内联思考等自带 max-height 的块）───────
   这些块以前每次流式增量都无条件 scrollTop = scrollHeight，用户根本翻不上去。
   统一走这里的薄封装：判定与守卫全部复用上面会话列表那套（bindConvStick /
   convStickOf / isScrollNearBottom / setConvScrollTop），语义一致：
     · 只有「用户自己待在底部」才跟随，上翻（哪怕一点）立刻脱离；
     · 程序写入由 _convAutoScroll 守卫，不反过来污染用户意图；
     · 元素每次重绘都是新节点 → 跟随状态和阅读位置按 key 存到登记表，
       重建后用 restoreStickPos 搬回去（重绘把 scrollTop 冲成 0 也是这个 bug 的一半）。 */
const STICK_POS_SLACK = 24;
const _stickPos = new Map();
/* 流式内容变高后调用：贴底才跟到底；已在底部则不重复写，避免无谓的 scroll 抖动 */
function stickScrollToBottom(el, force) {
  if (!el) return false;
  bindConvStick(el);
  if (el.scrollHeight <= el.clientHeight + STICK_POS_SLACK) return false;
  if (force) {
    markConvStick(el, true);
    setConvScrollTop(el, el.scrollHeight);
    return true;
  }
  if (!convStickOf(el) && !isScrollNearBottom(el, STICK_POS_SLACK)) return false;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return false;
  setConvScrollTop(el, el.scrollHeight);
  return true;
}
/* 重建前（或每次更新后）快照，供下一次重建还原 */
function saveStickPos(el, key) {
  if (!el || !key) return;
  bindConvStick(el);
  _stickPos.set(key, {
    top: el.scrollTop,
    prevH: el.scrollHeight,
    stick: !!(
      convStickOf(el) ||
      isScrollNearBottom(el, STICK_POS_SLACK) ||
      el.scrollTop + el.clientHeight >= el.scrollHeight - 1
    ),
  });
}
/* 重建后还原：没有快照（首次展开）→ 按「跟随」起步，直接贴底 */
function restoreStickPos(el, key) {
  if (!el) return;
  bindConvStick(el);
  const s = key ? _stickPos.get(key) : null;
  if (!s) {
    markConvStick(el, true);
    if (el.scrollHeight > el.clientHeight + STICK_POS_SLACK)
      setConvScrollTop(el, el.scrollHeight);
    return;
  }
  markConvStick(el, s.stick);
  if (s.stick) {
    setConvScrollTop(el, el.scrollHeight);
    return;
  }
  /* 上方内容高度没变（流式只在末尾追加）→ 原样回到阅读位置 */
  if (Math.abs(el.scrollHeight - s.prevH) <= STICK_POS_SLACK) {
    setConvScrollTop(el, Math.max(0, s.top));
    return;
  }
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const top =
    s.prevH > 0 ? Math.round((s.top * el.scrollHeight) / s.prevH) : s.top;
  setConvScrollTop(el, Math.min(Math.max(0, top), max));
}
/* 会话 / 节点销毁时清登记，避免按 id 无限增长 */
function clearStickPos(key) {
  if (key) _stickPos.delete(key);
}

/* 智能任务节点：会话列表（与智能会话同款：用户输入 + agent 输出 / 思考 / 工具） */
function agentConvListEl(node) {
  const conv = document.createElement("div");
  conv.className = "agent-conv";
  conv.addEventListener("mousedown", (ev) => ev.stopPropagation());
  conv.addEventListener(
    "scroll",
    () => {
      /* 程序滚动（自动跟随 / 还原位置）不改写用户的跟随意图 */
      if (conv._convAutoScroll) return;
      node._convNearBottom = isScrollNearBottom(conv);
      node._convScrollTop = conv.scrollTop;
    },
    { passive: true },
  );
  const msgs = Array.isArray(node.messages) ? node.messages : [];
  if (!msgs.length && !node.running) {
    const h = document.createElement("div");
    h.className = "agent-empty n-empty";
    h.textContent = I18n.t("输入任务后点击 ▶ 发送；历史对话将保留在此（只读）");
    conv.appendChild(h);
  }
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    /* 末条助手回复若未带 tools，补挂本轮轨迹，保证可展开查看 */
    if (
      m.role === "assistant" &&
      i === msgs.length - 1 &&
      !(Array.isArray(m.tools) && m.tools.length) &&
      node.dshTools &&
      node.dshTools.length
    ) {
      m.tools = node.dshTools.map((t) => Object.assign({}, t));
    }
    conv.appendChild(dshMsgBlock(m, node.id, i));
  }
  if (node.running) {
    const row = document.createElement("div");
    row.className = "dsh-msg dsh-ai";
    const head = document.createElement("div");
    head.className = "dsh-msg-head";
    const role = document.createElement("span");
    role.className = "dsh-role live";
    role.textContent = I18n.t("AI · 运行中");
    head.appendChild(role);
    row.appendChild(head);
    const think = document.createElement("div");
    think.className = "dsh-think-live";
    think.id = "agent-node-think-" + node.id;
    think.textContent = thinkingTextOf(node) || "";
    /* 此处 conv 尚未挂进文档，滚不动：用户的阅读位置由流式更新处
       （app-db.js onDshNodeEvent → restoreStickPos）在元素已入文档后搬回 */
    row.appendChild(think);
    const tools = document.createElement("div");
    tools.className = "dsh-tools";
    tools.id = "agent-node-tools-" + node.id;
    const liveTools = (S.nodeTools && S.nodeTools[node.id]) || [];
    for (const t of liveTools) tools.appendChild(dshToolDetailsEl(t, true, node.id));
    row.appendChild(tools);
    const body = document.createElement("div");
    body.className = "dsh-msg-body dsh-stream";
    body.id = "agent-node-stream-" + node.id;
    body.textContent = traceSayDisplay(node.id, node._pendingAnswer);
    row.appendChild(body);
    conv.appendChild(row);
  }
  /* 节点内会话末尾：同一份 Token 消耗累计报告（点击展开按模型明细） */
  if (typeof tokBadgeEl === "function" && typeof tokOwnerForRun === "function") {
    try {
      const owner = tokOwnerForRun({ node, runKey: node.id });
      const badge = owner && tokBadgeEl(owner);
      if (badge) {
        badge.style.margin = "6px 6px 2px";
        conv.appendChild(badge);
      }
    } catch {}
  }
  scheduleHistoryCollapse(conv);
  return conv;
}
function scrollAgentConv(node, force) {
  const list = document.querySelector(
    '.wf-node[data-nid="' + node.id + '"] .agent-conv',
  );
  if (!list) return;
  /* 节点内联思考块（dsh-think-live 自带 max-height 独立滚动条）：节点重绘会把它
     换成全新元素、scrollTop 被冲成 0，这里在元素已入文档后把用户的阅读位置搬回来；
     流式增量时的「贴底才跟随」由 app-db.js 走同一套 helper 判定。 */
  const tKey = "agent-node-think-" + node.id;
  const tEl = document.getElementById(tKey);
  if (tEl && !tEl._convStickBound) restoreStickPos(tEl, tKey);
  if (force) {
    node._convNearBottom = true;
    setConvScrollTop(list, list.scrollHeight);
    return;
  }
  if (node._convNearBottom === false) {
    if (node._convScrollTop != null) setConvScrollTop(list, node._convScrollTop);
    return;
  }
  scrollElToBottomIfStuck(list);
}
/* 顶部中间竖向拖拽把手：调整框体上下高度（高度存于 node[key]，随工作流持久化） */
function vResizeHandleEl(node, key, minH, maxH) {
  const h = document.createElement("div");
  h.className = "vresize-handle";
  h.title = I18n.t("拖拽调整上下高度");
  h.dataset.vkey = key;
  h.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    S.preDragSnap = snapshotState();
    S.drag = {
      mode: "vresize",
      id: node.id,
      key,
      sy: ev.clientY,
      oh: Number(node[key]) || 0,
      minH,
      maxH,
      moved: false,
    };
  });
  return h;
}
/* 不再随输出内容自动增高节点：会打乱画布排版。
   输出区已有 overflow:auto，内容变多时在面板内滚动即可。 */
function autoFitOutputHeight(_node) {}
function refreshThinkingUI(nid) {
  const node = nodeById(nid);
  if (!node) return;
  const icon = document.querySelector(
    '.wf-node[data-nid="' + nid + '"] .n-think',
  );
  const has = !!(
    S.thinking &&
    S.thinking[nid] &&
    S.thinking[nid].some((s) => s && s.length)
  );
  if (icon) {
    icon.classList.toggle("show", !!has);
    icon.classList.toggle("live", !!has && !!node.running);
    icon.textContent = node.running ? I18n.t("◉ 思考中") : I18n.t("◉ 思考");
  }
  if (
    node &&
    node.kind === "agent_task" &&
    node.agentSessionId &&
    S.view === "agent"
  ) {
    const st = agentSessionState();
    if (st && st.id === node.agentSessionId) {
      const el = document.getElementById("agent-think");
      if (el) updateAgentThinkEl(st, node);
    }
  }
  if (S.thinkOpen === nid) {
    if (thinkRAF[nid]) cancelAnimationFrame(thinkRAF[nid]);
    thinkRAF[nid] = requestAnimationFrame(() => {
      const pre = document.getElementById("thinkPre");
      if (pre) {
        const pKey = "thinkPre:" + nid;
        pre.textContent = traceThinkDisplay(nid, thinkingTextOf(node));
        /* 思考弹窗自身限高滚动：贴底才跟随最新内容，用户上翻后不再被拽回 */
        if (pre._convStickBound) stickScrollToBottom(pre);
        else restoreStickPos(pre, pKey);
        saveStickPos(pre, pKey);
      }
      const toolsBox = document.getElementById("thinkTools");
      if (toolsBox) {
        toolsBox.innerHTML = "";
        const tools = (S.nodeTools && S.nodeTools[nid]) || [];
        for (const t of tools) toolsBox.appendChild(dshToolDetailsEl(t, false, nid));
      }
    });
  }
}

/* 点击思考 icon：弹窗上半 = 「思考」（模型 reasoning，按步分段，不含工具行），
   下半 = 「输出」（工具调用轨迹，走已有 #thinkTools 区） */
function showThinking(node) {
  const running = !!node.running;
  openOverlay((running ? I18n.t("思考中 · ") : I18n.t("思考 · ")) + node.title);
  S.thinkOpen = node.id;
  const bodyEl = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = running
    ? I18n.t(
        "上方是模型思考（reasoning），按步分段流式显示；工具调用不写进思考，见下方「输出 · 工具调用轨迹」。",
      )
    : I18n.t(
        "上方是本轮模型的思考（reasoning，仅保留在内存中，不写入存档）；工具调用见下方「输出 · 工具调用轨迹」。",
      );
  bodyEl.appendChild(hint);
  const thinkTitle = document.createElement("div");
  thinkTitle.className = "settings-sec-title";
  thinkTitle.style.marginTop = "8px";
  thinkTitle.textContent = I18n.t("思考 · 模型 reasoning");
  bodyEl.appendChild(thinkTitle);
  const pre = document.createElement("pre");
  pre.id = "thinkPre";
  pre.className = "think-pre";
  pre.textContent = traceThinkDisplay(node.id, thinkingTextOf(node));
  bodyEl.appendChild(pre);
  /* 重开弹窗：搬回上次关掉时的阅读位置；首次打开无快照 → 按「跟随」贴底 */
  restoreStickPos(pre, "thinkPre:" + node.id);
  const toolsTitle = document.createElement("div");
  toolsTitle.className = "settings-sec-title";
  toolsTitle.style.marginTop = "8px";
  toolsTitle.textContent = I18n.t("输出 · 工具调用轨迹（点击展开参数与结果）");
  bodyEl.appendChild(toolsTitle);
  const toolsBox = document.createElement("div");
  toolsBox.id = "thinkTools";
  toolsBox.className = "dsh-tools";
  {
    const tools = (S.nodeTools && S.nodeTools[node.id]) || [];
    for (const t of tools) toolsBox.appendChild(dshToolDetailsEl(t, false, node.id));
  }
  bodyEl.appendChild(toolsBox);
  const foot = $("#ovFoot");
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = I18n.t("复制");
  copy.onclick = () => {
    const pre2 = document.getElementById("thinkPre");
    if (!pre2 || !pre2.textContent) {
      toast(I18n.t("暂无思考内容"), "warn");
      return;
    }
    navigator.clipboard
      .writeText(pre2.textContent)
      .then(() => toast(I18n.t("已复制思考内容"), "ok"));
  };
  foot.appendChild(close);
  foot.appendChild(copy);
}

/* 会话模式（agent_task chatMode）：点击回复前的「思考内容」按钮 → 弹窗显示该条回复的思考内容 */
function showMsgThinking(node, msg) {
  openOverlay(I18n.t("思考内容 · ") + (node ? node.title : I18n.t("对话")));
  const bodyEl = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent =
    I18n.t("以下为模型生成该条回复前的思考内容（随对话记录保存）。");
  bodyEl.appendChild(hint);
  const pre = document.createElement("pre");
  pre.className = "think-pre";
  pre.textContent = (msg && msg.reasoning) || "";
  bodyEl.appendChild(pre);
  const foot = $("#ovFoot");
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = I18n.t("关闭");
  close.onclick = closeOverlay;
  const copy = document.createElement("button");
  copy.className = "mini primary";
  copy.textContent = I18n.t("复制");
  copy.onclick = () => {
    navigator.clipboard
      .writeText(pre.textContent || "")
      .then(() => toast(I18n.t("已复制思考内容"), "ok"));
  };
  foot.appendChild(close);
  foot.appendChild(copy);
}

/* ============ 多次尝试（attempts）UI ============ */

/* Output 下一行的方形 Tabs：1..N 左对齐小方块，点击切换选中尝试（下游引用随之切换） */
function attemptTabsEl(node) {
  const tabs = document.createElement("div");
  tabs.className = "n-att-tabs";
  const nA = attemptCount(node);
  for (let t = 0; t < nA; t++) {
    const sq = document.createElement("button");
    sq.type = "button";
    sq.className = "n-att-tab" + (t === attemptIdx(node) ? " on" : "");
    sq.textContent = String(t + 1);
    sq.title =
      I18n.t("尝试 ") +
      (t + 1) +
      I18n.t("：点击切换查看该次结果，后续节点引用当前选中的尝试内容");
    sq.onclick = (ev) => {
      ev.stopPropagation();
      setAttempt(node, t);
    };
    tabs.appendChild(sq);
  }
  return tabs;
}

/* 切换选中尝试：pushHistory 支持撤销；下游派生（拆分/合并）内容随之更新 */
function setAttempt(node, i) {
  if (i === attemptIdx(node)) return;
  pushHistory();
  node.attemptIdx = i;
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已切换到尝试 ") + (i + 1), "ok");
}

/* 多次尝试按钮：弹出次数输入（整数 1-10，默认 1） */
function promptAttempts(node) {
  openOverlay(I18n.t("多次尝试 · ") + node.title, { persistent: true });
  const body = $("#ovBody");
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.innerHTML =
    I18n.t("并行运行 <b>N</b> 次该节点（N 为 1-10 的整数）。N &gt; 1 时：运行后输出面板（Output 下一行）出现 <b>1..N 方块 Tab</b>，") +
    I18n.t("点击切换查看对应尝试的结果，<b>下游节点引用当前选中的尝试内容</b>。");
  body.appendChild(hint);
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("尝试次数（1-10，默认 1）")));
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = 1;
  inp.max = 10;
  inp.step = 1;
  inp.value = attemptCount(node);
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("确定");
  ok.onclick = () => {
    let v = Math.round(Number(inp.value));
    if (!Number.isFinite(v)) v = 1;
    v = Math.max(1, Math.min(10, v));
    closeOverlay();
    if (v === attemptCount(node)) {
      if (v === 1 && !node.attemptOutputs) return; // 本就是单次且无结果，无需操作
      toast(I18n.t("尝试次数未变化（") + v + "）", "warn");
      return;
    }
    pushHistory();
    node.attempts = v;
    node.attemptIdx = 0;
    node.attemptOutputs = null;
    node.output = null;
    node.batchOutputs = null;
    node.error = null;
    node.ranAt = 0;
    node.attemptsDone = 0;
    if (S.thinking && S.thinking[node.id]) S.thinking[node.id] = [];
    clearDownstream(node.id);
    scheduleSave();
    renderCanvas();
    toast(v > 1 ? I18n.t("已设置多次尝试 ×") + v : I18n.t("已恢复单次尝试"), "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
  inp.select();
}

/* 需求等待：轮询监视文件路径，未生成则阻塞后续；生成后放行，不输出内容 */
async function playWaitFileNode(node, quiet) {
  if (!node || node.kind !== "wait_file") return;
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return;
  }
  beginNodeRun(node);
  let pendingIds = null;
  if (!quiet) {
    pendingIds = collectPendingRunIds(node, true);
    addPendingRun(pendingIds);
    const ran = [];
    try {
      await ensureProcessedAll(procSourcesOf(node), ran);
    } catch (e) {
      clearPendingRun(pendingIds);
      throw e;
    }
    if (ran.length) toast(I18n.t("已自动执行上游节点：") + I18n.listJoin(ran), "ok");
  }
  const clearPendingEarly = () => {
    if (pendingIds) clearPendingRun(pendingIds);
    else if (S.pendingRun) {
      S.pendingRun.delete(node.id);
      renderCanvas();
      updateRunQueuePanel();
    }
  };
  const pathCheck = resolveSavePath(node.waitPath, node);
  if (!pathCheck.ok) {
    clearPendingEarly();
    node.error = savePathResolveError(pathCheck.code);
    node.output = null;
    node.waitReady = false;
    node.waitStatus = "";
    if (!quiet) toast(node.error, "warn");
    renderCanvas();
    return;
  }
  const absPath = pathCheck.path;
  const intervalSec = Math.max(
    1,
    Math.min(60, Math.round(Number(node.waitIntervalSec) || 2)),
  );
  node.waitIntervalSec = intervalSec;
  if (S.pendingRun) S.pendingRun.delete(node.id);
  node.running = true;
  node.error = null;
  node._aborted = false;
  node.output = null;
  node.waitReady = false;
  node.waitStatus = I18n.t("检查中：") + absPath;
  if (S.wf) {
    rememberWf(S.wf);
    S.nodeWfId = S.nodeWfId || {};
    S.nodeWfId[node.id] = S.wf.id;
  }
  renderCanvas();
  renderStatus();
  const runP = (async () => {
    try {
      let checks = 0;
      while (!node._aborted) {
        let exists = false;
        try {
          exists =
            window.api && window.api.fileExists
              ? !!(await window.api.fileExists(absPath))
              : false;
        } catch {
          exists = false;
        }
        checks++;
        if (exists) {
          node.waitReady = true;
          node.output = null;
          node.ranAt = Date.now();
          node.waitStatus = I18n.t("文件已就绪");
          node.error = null;
          if (!quiet)
            toast(I18n.t("需求文件已生成：") + fileName(absPath), "ok");
          return;
        }
        node.waitStatus =
          I18n.t("等待中（第 ") +
          checks +
          I18n.t(" 次）· 每 ") +
          intervalSec +
          I18n.t(" 秒检查 · ") +
          fileName(absPath);
        renderCanvas();
        renderStatus();
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
      }
      node.error = I18n.t("已停止等待");
      node.output = null;
      node.waitReady = false;
      node.waitStatus = "";
      if (!quiet) toast(I18n.t("已停止等待"), "warn");
    } catch (e) {
      node.error = (e && e.message) || String(e);
      node.output = null;
      node.waitReady = false;
      node.waitStatus = "";
      if (!quiet) toast(node.error, "err");
    } finally {
      node.running = false;
      if (S.runPromises.get(node.id) === runP) S.runPromises.delete(node.id);
      if (pendingIds) clearPendingRun(pendingIds);
      renderCanvas();
      renderStatus();
      scheduleSave(true);
    }
  })();
  S.runPromises.set(node.id, runP);
  await runP;
}

/* ============ 定时触发器（系统时间 / 间隔 / cron） ============ */

let _timerSchedulerId = null;
const _timerFiring = new Set();

function cronFieldMatch(field, value, min, max) {
  const f = String(field || "").trim();
  if (!f) return false;
  if (f === "*") return true;
  const vals = new Set();
  for (const part of f.split(",")) {
    const m = String(part)
      .trim()
      .match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return false;
    const step = m[2] ? Math.max(1, Number(m[2])) : 1;
    let a;
    let b;
    if (m[1] === "*") {
      a = min;
      b = max;
    } else if (m[1].indexOf("-") >= 0) {
      const bits = m[1].split("-").map(Number);
      a = bits[0];
      b = bits[1];
    } else {
      a = b = Number(m[1]);
    }
    if (!isFinite(a) || !isFinite(b) || a > b) return false;
    for (let i = a; i <= b; i += step) {
      if (i >= min && i <= max) vals.add(i);
    }
  }
  return vals.has(value);
}

function cronDowMatch(field, dow) {
  const f = String(field || "").trim();
  if (f === "*") return true;
  const vals = new Set();
  for (const part of f.split(",")) {
    const m = String(part)
      .trim()
      .match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return false;
    const step = m[2] ? Math.max(1, Number(m[2])) : 1;
    let a;
    let b;
    if (m[1] === "*") {
      a = 0;
      b = 7;
    } else if (m[1].indexOf("-") >= 0) {
      const bits = m[1].split("-").map(Number);
      a = bits[0];
      b = bits[1];
    } else {
      a = b = Number(m[1]);
    }
    if (!isFinite(a) || !isFinite(b)) return false;
    for (let i = a; i <= b; i += step) {
      const v = i === 7 ? 0 : i;
      if (v >= 0 && v <= 6) vals.add(v);
    }
  }
  return vals.has(dow);
}

function cronMatchesDate(expr, d) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [fMin, fHour, fDom, fMon, fDow] = parts;
  if (!cronFieldMatch(fMin, d.getMinutes(), 0, 59)) return false;
  if (!cronFieldMatch(fHour, d.getHours(), 0, 23)) return false;
  if (!cronFieldMatch(fMon, d.getMonth() + 1, 1, 12)) return false;
  const domAny = fDom === "*";
  const dowAny = fDow === "*";
  const domOk = cronFieldMatch(fDom, d.getDate(), 1, 31);
  const dowOk = cronDowMatch(fDow, d.getDay());
  if (!domAny && !dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

function nextCronFireMs(expr, afterMs) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return 0;
  let t = Math.floor(Number(afterMs) / 60000) * 60000 + 60000;
  const end = t + 366 * 86400000;
  while (t < end) {
    if (cronMatchesDate(expr, new Date(t))) return t;
    t += 60000;
  }
  return 0;
}

function parseTimerAtMs(s) {
  const raw = String(s || "").trim();
  if (!raw) return 0;
  const norm = raw.indexOf("T") >= 0 ? raw : raw.replace(" ", "T");
  const d = new Date(norm);
  const ms = d.getTime();
  return isFinite(ms) ? ms : 0;
}

function formatTimerWhen(ms) {
  if (!ms || !isFinite(ms)) return "—";
  const d = new Date(ms);
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return (
    d.getFullYear() +
    "-" +
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    " " +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes()) +
    ":" +
    p(d.getSeconds())
  );
}

/* 时长：天(0–7) / 时(0–23) / 分(0–59)；合计最少 1 分钟、最多 7 天 */
const DUR_MAX_SEC = 86400 * 7;
const DUR_MIN_SEC = 60;

function clampDurationSec(sec) {
  const n = Math.round(Number(sec) || 0);
  if (!isFinite(n) || n < DUR_MIN_SEC) return DUR_MIN_SEC;
  if (n > DUR_MAX_SEC) return DUR_MAX_SEC;
  return n;
}

function durationPartsFromSec(sec) {
  let s = clampDurationSec(sec);
  const days = Math.floor(s / 86400);
  s %= 86400;
  const hours = Math.floor(s / 3600);
  s %= 3600;
  const minutes = Math.floor(s / 60);
  return { days, hours, minutes };
}

function durationSecFromParts(days, hours, minutes) {
  const d = Math.max(0, Math.min(7, Math.round(Number(days) || 0)));
  const h = Math.max(0, Math.min(23, Math.round(Number(hours) || 0)));
  const m = Math.max(0, Math.min(59, Math.round(Number(minutes) || 0)));
  return clampDurationSec(d * 86400 + h * 3600 + m * 60);
}

function formatDurationLabel(sec) {
  const p = durationPartsFromSec(sec);
  const bits = [];
  if (p.days) bits.push(p.days + I18n.t(" 天"));
  if (p.hours) bits.push(p.hours + I18n.t(" 时"));
  if (p.minutes || !bits.length) bits.push(p.minutes + I18n.t(" 分"));
  return bits.join(" ");
}

function appendDurationFields(parent, sec, onChange, opts) {
  opts = opts || {};
  const allowZero = !!opts.allowZero;
  const row = document.createElement("div");
  row.className = "dur-row";
  const parts =
    allowZero && !(Number(sec) > 0)
      ? { days: 0, hours: 0, minutes: 0 }
      : durationPartsFromSec(sec);
  const fields = [
    ["days", I18n.t("天"), 0, 7, parts.days],
    ["hours", I18n.t("时"), 0, 23, parts.hours],
    ["minutes", I18n.t("分"), 0, 59, parts.minutes],
  ];
  const inputs = {};
  const emit = () => {
    const d = Math.max(0, Math.min(7, Math.round(Number(inputs.days.value) || 0)));
    const h = Math.max(0, Math.min(23, Math.round(Number(inputs.hours.value) || 0)));
    const m = Math.max(0, Math.min(59, Math.round(Number(inputs.minutes.value) || 0)));
    let next = d * 86400 + h * 3600 + m * 60;
    if (!allowZero) next = clampDurationSec(next);
    else if (next > DUR_MAX_SEC) next = DUR_MAX_SEC;
    const sync =
      allowZero && next === 0
        ? { days: 0, hours: 0, minutes: 0 }
        : durationPartsFromSec(next || DUR_MIN_SEC);
    if (allowZero && next === 0) {
      inputs.days.value = "0";
      inputs.hours.value = "0";
      inputs.minutes.value = "0";
    } else {
      inputs.days.value = String(sync.days);
      inputs.hours.value = String(sync.hours);
      inputs.minutes.value = String(sync.minutes);
    }
    onChange(next);
  };
  for (const [key, lab, min, max, val] of fields) {
    const wrap = document.createElement("label");
    wrap.className = "dur-field";
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = String(min);
    inp.max = String(max);
    inp.step = "1";
    inp.value = String(val);
    inp.title = lab + "（" + min + "–" + max + "）";
    inp.onchange = emit;
    inputs[key] = inp;
    wrap.appendChild(inp);
    wrap.appendChild(document.createTextNode(lab));
    row.appendChild(wrap);
  }
  parent.appendChild(row);
  return row;
}

function normalizeTimerNode(node) {
  if (!node || node.kind !== "timer") return;
  const mode = String(node.timerMode || "interval");
  node.timerMode =
    mode === "once" || mode === "cron" || mode === "interval" ? mode : "interval";
  if (typeof node.timerAt !== "string") node.timerAt = "";
  /* 旧配置可能是秒级；UI 改为天/时/分后至少 1 分钟 */
  let every = Math.round(Number(node.timerEverySec) || 3600);
  if (every > 0 && every < DUR_MIN_SEC) every = DUR_MIN_SEC;
  node.timerEverySec = clampDurationSec(every || 3600);
  if (typeof node.timerCron !== "string" || !String(node.timerCron).trim())
    node.timerCron = "0 * * * *";
  node.timerArmed = !!node.timerArmed;
  node.timerLastAt = Number(node.timerLastAt) || 0;
  node.timerNextAt = Number(node.timerNextAt) || 0;
  node.timerFireCount = Math.max(0, Math.round(Number(node.timerFireCount) || 0));
  if (typeof node.timerStatus !== "string") node.timerStatus = "";
}

function normalizeDelayerNode(node) {
  if (!node || node.kind !== "delayer") return;
  node.delaySec = clampDurationSec(node.delaySec || 60);
  if (typeof node.delayStatus !== "string") node.delayStatus = "";
}

function normalizeSequencerNode(node) {
  if (!node || node.kind !== "sequencer") return;
  node.seqOutputs = Math.max(
    2,
    Math.min(8, Math.round(Number(node.seqOutputs) || 3)),
  );
  node.seqGapSec = Math.max(
    0,
    Math.min(DUR_MAX_SEC, Math.round(Number(node.seqGapSec) || 0)),
  );
  if (typeof node.seqStatus !== "string") node.seqStatus = "";
}

function normalizeGateNode(node) {
  if (!node || node.kind !== "gate") return;
  node.gateInputs = Math.max(
    2,
    Math.min(8, Math.round(Number(node.gateInputs) || 2)),
  );
  if (!node.gateArrived || typeof node.gateArrived !== "object")
    node.gateArrived = {};
  if (typeof node.gateStatus !== "string") node.gateStatus = "";
}

function normalizeSplitterNode(node) {
  if (!node || node.kind !== "splitter") return;
  node.splitOutputs = Math.max(
    2,
    Math.min(8, Math.round(Number(node.splitOutputs) || 3)),
  );
  if (typeof node.splitStatus !== "string") node.splitStatus = "";
}

function normalizeCounterNode(node) {
  if (!node || node.kind !== "counter") return;
  node.counterEvery = Math.max(
    2,
    Math.min(99, Math.round(Number(node.counterEvery) || 2)),
  );
  node.counterCount = Math.max(0, Math.round(Number(node.counterCount) || 0));
  if (typeof node.counterStatus !== "string") node.counterStatus = "";
}

function normalizeMutexNode(node) {
  if (!node || node.kind !== "mutex") return;
  node.mutexInputs = Math.max(
    2,
    Math.min(8, Math.round(Number(node.mutexInputs) || 2)),
  );
  if (
    node.mutexMode !== "first" &&
    node.mutexMode !== "priority" &&
    node.mutexMode !== "random"
  )
    node.mutexMode = "first";
  if (typeof node.mutexStatus !== "string") node.mutexStatus = "";
}

function gateProgressLabel(node) {
  normalizeGateNode(node);
  const n = node.gateInputs;
  const needed = [];
  for (let i = 0; i < n; i++) needed.push(String(i));
  const got = needed.filter((k) => node.gateArrived && node.gateArrived[k])
    .length;
  const wired = new Set(allWiresTo(node.id).map((w) => String(w.toIndex)));
  const unwired = needed.filter((k) => !wired.has(k)).length;
  let s =
    I18n.t("已到 ") + got + "/" + n + I18n.t(" · 全部到达后放行");
  if (unwired)
    s +=
      I18n.t(" · 尚有 ") +
      unwired +
      I18n.t(" 路未接线");
  return s;
}

function mutexModeLabel(mode) {
  if (mode === "priority") return I18n.t("端口优先（小号优先）");
  if (mode === "random") return I18n.t("随机一路");
  return I18n.t("先到优先");
}

function validateTimerConfig(node) {
  normalizeTimerNode(node);
  if (node.timerMode === "once") {
    if (!parseTimerAtMs(node.timerAt))
      return I18n.t("请填写计划时间（系统本地时间）");
  } else if (node.timerMode === "cron") {
    const parts = String(node.timerCron || "").trim().split(/\s+/);
    if (parts.length !== 5) return I18n.t("Cron 需为 5 段：分 时 日 月 周");
    if (!nextCronFireMs(node.timerCron, Date.now()))
      return I18n.t("无法解析 Cron 表达式");
  } else if (node.timerEverySec < DUR_MIN_SEC) {
    return I18n.t("间隔无效（至少 1 分钟）");
  }
  return "";
}

function computeTimerNextAt(node, afterMs) {
  normalizeTimerNode(node);
  const from = Number(afterMs) || Date.now();
  if (node.timerMode === "once") {
    const at = parseTimerAtMs(node.timerAt);
    if (!at) return 0;
    return at;
  }
  if (node.timerMode === "cron") return nextCronFireMs(node.timerCron, from);
  const every = node.timerEverySec * 1000;
  if (node.timerLastAt > 0) {
    let n = node.timerLastAt + every;
    while (n <= from) n += every;
    return n;
  }
  return from + every;
}

function timerOutTargets(node, wf) {
  wf = wf || S.wf;
  if (!node || !wf) return [];
  const out = [];
  const seen = new Set();
  for (const w of wf.wires || []) {
    if (w.rel) continue;
    if (w.from !== node.id) continue;
    const n = (wf.nodes || []).find((x) => x.id === w.to);
    if (!n || seen.has(n.id) || !canControlRun(n)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

function allKnownWorkflows() {
  const map = new Map();
  if (S.wf && S.wf.id) map.set(S.wf.id, S.wf);
  for (const id of Object.keys(S.wfBag || {})) {
    const w = S.wfBag[id];
    if (w && w.id) map.set(w.id, w);
  }
  return [...map.values()];
}

async function withWorkflowContext(wf, fn) {
  const prev = S.wf;
  try {
    if (wf) S.wf = wf;
    return await fn();
  } finally {
    S.wf = prev;
  }
}

async function runTimerTargets(node, quiet) {
  const targets = timerOutTargets(node);
  if (!targets.length) {
    if (!quiet) toast(I18n.t("未连接任何目标节点"), "warn");
    return 0;
  }
  const running = targets.filter((n) => n.running && n.kind !== "control");
  if (running.length) {
    if (!quiet)
      toast(
        I18n.t("请先终止当前运行") +
          "：" +
          I18n.listJoin(running.map((n) => n.title)),
        "warn",
      );
    return 0;
  }
  invalidateControlRunTargets(targets);
  const seen = new Set([node.id]);
  const ctrl = { id: node.id, _aborted: !!node._aborted, running: true };
  await runControlRunnableQueue(ctrl, targets, seen);
  return targets.length;
}

function refreshTimerStatus(node) {
  normalizeTimerNode(node);
  if (node.timerArmed) {
    node.timerStatus =
      I18n.t("已武装 · 下次 ") + formatTimerWhen(node.timerNextAt);
  } else if (node.timerLastAt) {
    node.timerStatus =
      I18n.t("上次 ") +
      formatTimerWhen(node.timerLastAt) +
      " · " +
      node.timerFireCount +
      I18n.t(" 次");
  } else {
    node.timerStatus = I18n.t("未武装");
  }
}

function disarmTimerNode(node, quiet) {
  if (!node || node.kind !== "timer") return;
  node.timerArmed = false;
  node.running = false;
  node._aborted = true;
  refreshTimerStatus(node);
  if (!quiet) toast(I18n.t("已停止定时触发器：") + (node.title || ""), "warn");
  renderCanvas();
  renderStatus();
  scheduleSave(true);
}

function armTimerNode(node, quiet) {
  if (!node || node.kind !== "timer") return false;
  const err = validateTimerConfig(node);
  if (err) {
    node.error = err;
    if (!quiet) toast(err, "warn");
    renderCanvas();
    return false;
  }
  node._aborted = false;
  node.error = null;
  node.timerArmed = true;
  node.running = true;
  let next = computeTimerNextAt(node, Date.now());
  if (node.timerMode === "once") {
    const at = parseTimerAtMs(node.timerAt);
    if (at && at <= Date.now()) next = Date.now();
  }
  node.timerNextAt = next || 0;
  refreshTimerStatus(node);
  ensureTimerScheduler();
  if (!quiet)
    toast(
      I18n.t("定时触发器已武装：") +
        (node.title || "") +
        " · " +
        formatTimerWhen(node.timerNextAt),
      "ok",
    );
  renderCanvas();
  renderStatus();
  scheduleSave(true);
  if (node.timerMode === "once" && next && next <= Date.now() + 200) {
    fireTimerNode(node, S.wf, { quiet: !!quiet });
  }
  return true;
}

async function fireTimerNode(node, wf, opts) {
  opts = opts || {};
  if (!node || node.kind !== "timer") return;
  if (_timerFiring.has(node.id)) return;
  _timerFiring.add(node.id);
  try {
    await withWorkflowContext(wf || S.wf, async () => {
      normalizeTimerNode(node);
      node.timerLastAt = Date.now();
      node.timerFireCount += 1;
      node.ranAt = node.timerLastAt;
      node.error = null;
      if (node.timerMode === "once") {
        node.timerArmed = false;
        node.running = false;
        node.timerNextAt = 0;
      } else if (node.timerArmed) {
        node.timerNextAt = computeTimerNextAt(node, node.timerLastAt);
        node.running = true;
      } else {
        node.timerNextAt = computeTimerNextAt(node, node.timerLastAt);
        node.running = false;
      }
      refreshTimerStatus(node);
      const n = await runTimerTargets(node, !!opts.quiet);
      if (!opts.quiet)
        toast(
          I18n.t("定时触发：") +
            (node.title || "") +
            (n ? I18n.t(" · 已启用 ") + n + I18n.t(" 个目标") : ""),
          "ok",
        );
    });
  } catch (e) {
    node.error = (e && e.message) || String(e);
  } finally {
    _timerFiring.delete(node.id);
    renderCanvas();
    renderStatus();
    scheduleSave(true);
  }
}

async function tickAllTimers() {
  const now = Date.now();
  for (const wf of allKnownWorkflows()) {
    for (const node of wf.nodes || []) {
      if (!node || node.kind !== "timer" || !node.timerArmed) continue;
      normalizeTimerNode(node);
      if (!node.timerNextAt) {
        node.timerNextAt = computeTimerNextAt(node, now);
        refreshTimerStatus(node);
        continue;
      }
      if (now + 50 < node.timerNextAt) continue;
      await fireTimerNode(node, wf, { quiet: true });
    }
  }
}

function ensureTimerScheduler() {
  if (_timerSchedulerId != null) return;
  _timerSchedulerId = setInterval(() => {
    tickAllTimers().catch(() => {});
  }, 1000);
}

async function waitForTimerPulse(node, task) {
  normalizeTimerNode(node);
  const err = validateTimerConfig(node);
  if (err) {
    node.error = err;
    return "blocked";
  }
  let next = computeTimerNextAt(node, Date.now());
  if (node.timerMode === "once") {
    const at = parseTimerAtMs(node.timerAt);
    if (at && at <= Date.now()) next = Date.now();
  }
  if (!next) {
    node.error = I18n.t("无法计算下次触发时间");
    return "blocked";
  }
  node.timerNextAt = next;
  node.error = null;
  const wasArmed = !!node.timerArmed;
  node.running = true;
  node.timerStatus = I18n.t("控制流等待触发 · ") + formatTimerWhen(next);
  renderCanvas();
  while (
    !(task && task._aborted) &&
    !node._aborted &&
    Date.now() + 20 < node.timerNextAt
  ) {
    await new Promise((r) =>
      setTimeout(r, Math.min(1000, Math.max(50, node.timerNextAt - Date.now()))),
    );
  }
  if ((task && task._aborted) || node._aborted) {
    node.running = wasArmed;
    refreshTimerStatus(node);
    return "abort";
  }
  node.timerLastAt = Date.now();
  node.timerFireCount += 1;
  node.ranAt = node.timerLastAt;
  if (node.timerMode === "once") {
    node.timerArmed = false;
    node.running = false;
    node.timerNextAt = 0;
  } else {
    node.timerNextAt = computeTimerNextAt(node, node.timerLastAt);
    node.running = wasArmed;
  }
  refreshTimerStatus(node);
  return "ok";
}

async function playTimerNode(node, quiet) {
  if (!node || node.kind !== "timer") return;
  if (node.timerArmed && node.running) {
    disarmTimerNode(node, quiet);
    return;
  }
  armTimerNode(node, quiet);
}

function extractCronExpression(text) {
  const s = String(text || "").trim();
  const m = s.match(
    /(?:^|\n)\s*((?:[\d*,/\-]+|\*)(?:\s+(?:[\d*,/\-]+|\*)){4})\s*(?:$|\n)/,
  );
  if (m) return m[1].trim();
  const line = s.split(/\n/).map((x) => x.trim()).find((x) => {
    const p = x.split(/\s+/);
    return p.length === 5 && p.every((t) => /^[\d*,/\-]+$/.test(t));
  });
  return line || "";
}

async function smartFillTimerCron(node) {
  if (!node || node.kind !== "timer") return;
  const need = await promptDialog(
    I18n.t(
      "描述你的定时计划（例如：每个工作日上午 9 点；每小时的第 0 分；每周日 22:30）",
    ),
    "",
    { title: I18n.t("智能填写 Cron"), placeholder: I18n.t("用自然语言描述…") },
  );
  if (need == null) return;
  const text = String(need).trim();
  if (!text) {
    toast(I18n.t("请填写计划需求"), "warn");
    return;
  }
  const prov = pickTextProviderForJudge(node);
  if (!prov) {
    toast(I18n.t("未配置带 API Key 的文本服务商"), "warn");
    return;
  }
  toast(I18n.t("正在生成 Cron…"), "ok");
  try {
    const rr = await window.api.apiCall({
      provider: prov,
      kind: "text",
      model: node.model || (prov.models || [])[0] || "",
      prompt:
        I18n.t(
          "你是 Cron 表达式生成器。根据用户的自然语言定时需求，只输出一行标准五段 Cron（分 时 日 月 周），使用本地时间；周日用 0 或 7。不要解释、不要代码块、不要其它文字。\n\n用户需求：\n",
        ) + text,
      texts: [],
      images: [],
      temperature: 0.1,
      effort: "low",
    });
    if (!rr || !rr.ok) {
      toast((rr && rr.error) || I18n.t("生成失败"), "err");
      return;
    }
    const cron = extractCronExpression(rr.text);
    if (!cron || !nextCronFireMs(cron, Date.now())) {
      toast(
        I18n.t("无法解析模型返回的 Cron：") +
          String(rr.text || "").slice(0, 120),
        "err",
      );
      return;
    }
    pushHistory();
    node.timerMode = "cron";
    node.timerCron = cron;
    node.timerNextAt = computeTimerNextAt(node, Date.now());
    node.error = null;
    refreshTimerStatus(node);
    scheduleSave(true);
    renderCanvas();
    toast(I18n.t("已填写 Cron：") + cron, "ok");
  } catch (e) {
    toast(I18n.t("生成失败：") + ((e && e.message) || String(e)), "err");
  }
}

async function sleepMs(ms, shouldAbort) {
  const total = Math.max(0, Number(ms) || 0);
  if (total <= 0) return false;
  const end = Date.now() + total;
  while (Date.now() < end) {
    if (shouldAbort && shouldAbort()) return true;
    await new Promise((r) =>
      setTimeout(r, Math.min(250, Math.max(20, end - Date.now()))),
    );
  }
  return !!(shouldAbort && shouldAbort());
}

async function waitForDelayerPulse(node, task) {
  normalizeDelayerNode(node);
  const ms = node.delaySec * 1000;
  node.error = null;
  node.running = true;
  node.delayStatus =
    I18n.t("延时中… ") + formatDurationLabel(node.delaySec);
  renderCanvas();
  const aborted = await sleepMs(ms, () =>
    !!(task && task._aborted) || !!node._aborted,
  );
  node.running = false;
  if (aborted) {
    node.delayStatus = I18n.t("已取消");
    return "abort";
  }
  node.ranAt = Date.now();
  node.delayStatus =
    I18n.t("已延时 ") + formatDurationLabel(node.delaySec);
  return "ok";
}

async function playDelayerNode(node, quiet) {
  if (!node || node.kind !== "delayer") return;
  if (node.running) {
    node._aborted = true;
    return;
  }
  node._aborted = false;
  const r = await waitForDelayerPulse(node, null);
  if (r === "abort") {
    if (!quiet) toast(I18n.t("延时已取消"), "warn");
    renderCanvas();
    return;
  }
  const n = await runTimerTargets(node, !!quiet);
  if (!quiet)
    toast(
      I18n.t("延时结束：") +
        (node.title || "") +
        (n ? I18n.t(" · 已启用 ") + n + I18n.t(" 个目标") : ""),
      "ok",
    );
  renderCanvas();
  scheduleSave(true);
}

async function pulseSequencer(node, task, seen) {
  normalizeSequencerNode(node);
  const nOut = outputCount(node);
  const gapMs = Math.max(0, Number(node.seqGapSec) || 0) * 1000;
  node.running = true;
  node.error = null;
  const results = [];
  for (let i = 0; i < nOut; i++) {
    if ((task && task._aborted) || node._aborted) {
      node.running = false;
      node.seqStatus = I18n.t("已取消");
      return "abort";
    }
    node.seqStatus = I18n.t("序列 ") + (i + 1) + "/" + nOut;
    renderCanvas();
    if (i > 0 && gapMs > 0) {
      const aborted = await sleepMs(gapMs, () =>
        !!(task && task._aborted) || !!node._aborted,
      );
      if (aborted) {
        node.running = false;
        node.seqStatus = I18n.t("已取消");
        return "abort";
      }
    }
    /* 每路独立 seen 副本，避免前一路节点挡住后一路汇合路径 */
    const branchSeen = new Set(seen);
    results.push(
      mergePulseResults(await pulseExecOutgoing(node, i, task, branchSeen)),
    );
  }
  node.running = false;
  node.ranAt = Date.now();
  node.seqStatus = I18n.t("序列完成");
  return mergePulseResults(results);
}

async function playSequencerNode(node, quiet) {
  if (!node || node.kind !== "sequencer") return;
  if (node.running) {
    node._aborted = true;
    return;
  }
  normalizeSequencerNode(node);
  node._aborted = false;
  node.running = true;
  node.error = null;
  const nOut = outputCount(node);
  const gapMs = Math.max(0, Number(node.seqGapSec) || 0) * 1000;
  try {
    for (let i = 0; i < nOut; i++) {
      if (node._aborted) break;
      node.seqStatus = I18n.t("序列 ") + (i + 1) + "/" + nOut;
      renderCanvas();
      if (i > 0 && gapMs > 0) {
        const aborted = await sleepMs(gapMs, () => !!node._aborted);
        if (aborted) break;
      }
      const targets = [];
      const seen = new Set();
      for (const w of (S.wf && S.wf.wires) || []) {
        if (w.from !== node.id || Number(w.fromIndex || 0) !== i) continue;
        const t = nodeById(w.to);
        if (!t || seen.has(t.id) || !canControlRun(t)) continue;
        seen.add(t.id);
        targets.push(t);
      }
      if (targets.length) {
        invalidateControlRunTargets(targets);
        const ctrl = { id: node.id, _aborted: !!node._aborted, running: true };
        await runControlRunnableQueue(ctrl, targets, new Set([node.id]));
      }
    }
    node.ranAt = Date.now();
    node.seqStatus = node._aborted ? I18n.t("已取消") : I18n.t("序列完成");
    if (!quiet)
      toast(
        (node._aborted ? I18n.t("序列已取消：") : I18n.t("序列完成：")) +
          (node.title || ""),
        node._aborted ? "warn" : "ok",
      );
  } catch (e) {
    node.error = (e && e.message) || String(e);
    if (!quiet) toast(I18n.t("序列失败：") + node.error, "err");
  } finally {
    node.running = false;
    renderCanvas();
    scheduleSave(true);
  }
}

function gateConnectedKeys(node) {
  normalizeGateNode(node);
  const keys = [];
  for (let i = 0; i < node.gateInputs; i++) keys.push(String(i));
  return keys;
}

async function pulseGate(node, task, seen, toIndex) {
  normalizeGateNode(node);
  const needed = gateConnectedKeys(node);
  const key =
    toIndex == null || !isFinite(Number(toIndex))
      ? null
      : String(Number(toIndex));
  if (key == null || !needed.includes(key)) {
    node.gateStatus = I18n.t("脉冲未落在配置输入口内");
    return "open";
  }
  if (!node.gateArrived || typeof node.gateArrived !== "object")
    node.gateArrived = {};
  node.gateArrived[key] = true;
  const got = needed.filter((k) => node.gateArrived[k]).length;
  const wired = new Set(allWiresTo(node.id).map((w) => String(w.toIndex)));
  const unwired = needed.filter((k) => !wired.has(k)).length;
  node.gateStatus =
    I18n.t("已到 ") +
    got +
    "/" +
    needed.length +
    (unwired
      ? I18n.t(" · 尚有 ") + unwired + I18n.t(" 路未接线")
      : "");
  node.error = null;
  renderCanvas();
  if (!needed.every((k) => node.gateArrived[k])) return "open";
  if (node._gateFiring) return "open";
  node._gateFiring = true;
  node.gateArrived = {};
  node.running = true;
  node.gateStatus = I18n.t("闸门已放行");
  try {
    const fireSeen = new Set(seen);
    fireSeen.add(node.id);
    const r = mergePulseResults(
      await pulseExecOutgoing(node, 0, task, fireSeen),
    );
    node.ranAt = Date.now();
    return r;
  } finally {
    node.running = false;
    node._gateFiring = false;
    renderCanvas();
  }
}

async function playGateNode(node, quiet) {
  if (!node || node.kind !== "gate") return;
  normalizeGateNode(node);
  beginNodeRun(node);
  node.gateArrived = {};
  node.error = null;
  node.running = true;
  node.gateStatus = I18n.t("强制放行");
  renderCanvas();
  try {
    const n = await runTimerTargets(node, !!quiet);
    node.ranAt = Date.now();
    node.gateStatus = I18n.t("闸门已放行");
    if (!quiet)
      toast(
        I18n.t("闸门放行：") +
          (node.title || "") +
          (n ? I18n.t(" · 已启用 ") + n + I18n.t(" 个目标") : ""),
        "ok",
      );
  } catch (e) {
    node.error = (e && e.message) || String(e);
    if (!quiet) toast(I18n.t("闸门失败：") + node.error, "err");
  } finally {
    node.running = false;
    renderCanvas();
    scheduleSave(true);
  }
}

async function pulseSplitter(node, task, seen) {
  normalizeSplitterNode(node);
  const nOut = outputCount(node);
  node.running = true;
  node.error = null;
  node.splitStatus = I18n.t("并行分发 ") + nOut;
  renderCanvas();
  try {
    const jobs = [];
    for (let i = 0; i < nOut; i++) {
      const branchSeen = new Set(seen);
      branchSeen.add(node.id);
      jobs.push(pulseExecOutgoing(node, i, task, branchSeen));
    }
    const parts = await Promise.all(jobs);
    const flat = [];
    for (const p of parts) {
      if (Array.isArray(p)) flat.push(...p);
      else flat.push(p);
    }
    node.ranAt = Date.now();
    node.splitStatus = I18n.t("分发完成");
    return mergePulseResults(flat);
  } finally {
    node.running = false;
    renderCanvas();
  }
}

async function playSplitterNode(node, quiet) {
  if (!node || node.kind !== "splitter") return;
  if (node.running) {
    node._aborted = true;
    return;
  }
  normalizeSplitterNode(node);
  node._aborted = false;
  node.running = true;
  node.error = null;
  const nOut = outputCount(node);
  try {
    node.splitStatus = I18n.t("并行分发 ") + nOut;
    renderCanvas();
    const jobs = [];
    for (let i = 0; i < nOut; i++) {
      const targets = [];
      const seen = new Set();
      for (const w of (S.wf && S.wf.wires) || []) {
        if (w.from !== node.id || Number(w.fromIndex || 0) !== i) continue;
        const t = nodeById(w.to);
        if (!t || seen.has(t.id) || !canControlRun(t)) continue;
        seen.add(t.id);
        targets.push(t);
      }
      if (targets.length) {
        invalidateControlRunTargets(targets);
        const ctrl = { id: node.id, _aborted: !!node._aborted, running: true };
        jobs.push(runControlRunnableQueue(ctrl, targets, new Set([node.id])));
      }
    }
    await Promise.all(jobs);
    node.ranAt = Date.now();
    node.splitStatus = node._aborted ? I18n.t("已取消") : I18n.t("分发完成");
    if (!quiet)
      toast(
        (node._aborted ? I18n.t("分发已取消：") : I18n.t("分发完成：")) +
          (node.title || ""),
        node._aborted ? "warn" : "ok",
      );
  } catch (e) {
    node.error = (e && e.message) || String(e);
    if (!quiet) toast(I18n.t("分发失败：") + node.error, "err");
  } finally {
    node.running = false;
    renderCanvas();
    scheduleSave(true);
  }
}

async function pulseCounter(node, task, seen) {
  normalizeCounterNode(node);
  node.counterCount = (Number(node.counterCount) || 0) + 1;
  const every = node.counterEvery;
  node.error = null;
  node.counterStatus = I18n.t("当前 ") + node.counterCount + "/" + every;
  renderCanvas();
  if (node.counterCount < every) return "open";
  node.counterCount = 0;
  node.running = true;
  node.counterStatus = I18n.t("计数放行");
  try {
    const fireSeen = new Set(seen);
    fireSeen.add(node.id);
    const r = mergePulseResults(
      await pulseExecOutgoing(node, 0, task, fireSeen),
    );
    node.ranAt = Date.now();
    return r;
  } finally {
    node.running = false;
    renderCanvas();
  }
}

async function playCounterNode(node, quiet) {
  if (!node || node.kind !== "counter") return;
  normalizeCounterNode(node);
  beginNodeRun(node);
  node.counterCount = (Number(node.counterCount) || 0) + 1;
  const every = node.counterEvery;
  node.error = null;
  node.counterStatus = I18n.t("当前 ") + node.counterCount + "/" + every;
  renderCanvas();
  if (node.counterCount < every) {
    if (!quiet)
      toast(
        I18n.t("计数 ") + node.counterCount + "/" + every + " · " + (node.title || ""),
        "ok",
      );
    scheduleSave(true);
    return;
  }
  node.counterCount = 0;
  node.running = true;
  node.counterStatus = I18n.t("计数放行");
  try {
    const n = await runTimerTargets(node, !!quiet);
    node.ranAt = Date.now();
    if (!quiet)
      toast(
        I18n.t("计数放行：") +
          (node.title || "") +
          (n ? I18n.t(" · 已启用 ") + n + I18n.t(" 个目标") : ""),
        "ok",
      );
  } catch (e) {
    node.error = (e && e.message) || String(e);
    if (!quiet) toast(I18n.t("计数失败：") + node.error, "err");
  } finally {
    node.running = false;
    renderCanvas();
    scheduleSave(true);
  }
}

function mutexPickPort(node, preferredIndex) {
  normalizeMutexNode(node);
  const wires = allWiresTo(node.id);
  if (!wires.length) return null;
  const ports = [...new Set(wires.map((w) => Number(w.toIndex) || 0))].sort(
    (a, b) => a - b,
  );
  if (node.mutexMode === "first") {
    if (preferredIndex != null && ports.includes(Number(preferredIndex)))
      return Number(preferredIndex);
    return ports[0];
  }
  if (node.mutexMode === "random")
    return ports[Math.floor(Math.random() * ports.length)];
  /* priority: 小号优先；若有 preferred 且存在则用它，否则取最小 */
  if (preferredIndex != null && ports.includes(Number(preferredIndex))) {
    /* 端口优先：仍允许先到触发，但 ▶ 试跑取最小口 */
    return Number(preferredIndex);
  }
  return ports[0];
}

async function pulseMutex(node, task, seen, toIndex) {
  normalizeMutexNode(node);
  const wires = allWiresTo(node.id);
  if (!wires.length) {
    node.mutexStatus = I18n.t("未连接输入");
    return "open";
  }
  const win =
    toIndex != null && isFinite(Number(toIndex))
      ? Number(toIndex)
      : Number(wires[0].toIndex) || 0;
  node.mutexStatus =
    I18n.t("选中输入 ") +
    (win + 1) +
    " · " +
    mutexModeLabel(node.mutexMode);
  node.running = true;
  node.error = null;
  try {
    const fireSeen = new Set(seen);
    fireSeen.add(node.id);
    const r = mergePulseResults(
      await pulseExecOutgoing(node, 0, task, fireSeen),
    );
    node.ranAt = Date.now();
    return r;
  } finally {
    node.running = false;
    renderCanvas();
  }
}

async function playMutexNode(node, quiet) {
  if (!node || node.kind !== "mutex") return;
  normalizeMutexNode(node);
  beginNodeRun(node);
  const win = mutexPickPort(node, null);
  if (win == null) {
    if (!quiet) toast(I18n.t("请先连接互斥输入"), "warn");
    return;
  }
  node.mutexStatus =
    I18n.t("选中输入 ") + (win + 1) + " · " + mutexModeLabel(node.mutexMode);
  node.running = true;
  node.error = null;
  renderCanvas();
  try {
    const n = await runTimerTargets(node, !!quiet);
    node.ranAt = Date.now();
    if (!quiet)
      toast(
        I18n.t("互斥放行：") +
          (node.title || "") +
          I18n.t(" · 输入 ") +
          (win + 1) +
          (n ? I18n.t(" · 已启用 ") + n + I18n.t(" 个目标") : ""),
        "ok",
      );
  } catch (e) {
    node.error = (e && e.message) || String(e);
    if (!quiet) toast(I18n.t("互斥失败：") + node.error, "err");
  } finally {
    node.running = false;
    renderCanvas();
    scheduleSave(true);
  }
}

function addInnerTask(parent) {
  if (!parent || parent.kind !== "task") return;
  pushHistory();
  ensureTaskScaffold(parent);
  const n = taskChildTasksOf(parent.id).length;
  const start = taskStartOf(parent.id);
  const endOk =
    (S.wf.nodes || []).find(
      (x) => x.parentTaskId === parent.id && ctrlRoleOf(x) === "endSuccess",
    ) || null;
  const child = makeNode(
    "task",
    start ? start.x + (start.w || 180) + 72 : 240,
    start ? start.y : 280 + n * 36,
  );
  child.parentTaskId = parent.id;
  child.title = uniqueNodeTitle(I18n.t("任务"));
  child.goal = "";
  child.taskStatus = "pending";
  S.wf.nodes.push(child);
  ensureTaskScaffold(child);
  /* 默认串进控制流：起点 → 子任务 → 成功终点 */
  if (start) {
    const err = connectError(start.id, child.id, null, 0);
    if (!err) addWire(start.id, child.id, null, { fromIndex: 0 });
  }
  if (endOk) {
    const err = connectError(child.id, endOk.id, null, 0);
    if (!err) addWire(child.id, endOk.id, null, { fromIndex: 0 });
  }
  scheduleSave(true);
  renderCanvas();
  toast(I18n.t("已添加子任务：") + child.title, "ok");
}

function pickTextProviderForJudge(node) {
  const list = (S.config && S.config.providers) || [];
  if (node && node.providerId) {
    const hit = list.find(
      (p) => p.id === node.providerId && p.type === "text_openai",
    );
    if (hit && String(hit.apiKey || "").trim()) return hit;
  }
  return list.find(
    (p) => p.type === "text_openai" && String(p.apiKey || "").trim(),
  ) || null;
}

function parseJudgeYesNo(text) {
  const s = String(text || "")
    .trim()
    .toUpperCase();
  if (/^(YES|Y|TRUE|是|达成|成功)\b/.test(s) || s === "YES" || s === "是")
    return true;
  if (/^(NO|N|FALSE|否|未达成|失败)\b/.test(s) || s === "NO" || s === "否")
    return false;
  if (/\bYES\b/.test(s) && !/\bNO\b/.test(s)) return true;
  if (/\bNO\b/.test(s)) return false;
  if (s.indexOf("是") >= 0 && s.indexOf("否") < 0) return true;
  if (s.indexOf("否") >= 0) return false;
  return null;
}

async function playJudgeNode(node, quiet) {
  if (!node || node.kind !== "judge") return null;
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return node.judgeResult === "yes"
      ? true
      : node.judgeResult === "no"
        ? false
        : null;
  }
  node.running = true;
  beginNodeRun(node);
  node.error = null;
  node.judgeResult = "";
  renderCanvas();
  const runP = (async () => {
    try {
      const parent = nodeById(node.parentTaskId);
      const goal =
        String((node.prompt || "").trim() || (parent && parent.goal) || "").trim();
      if (!goal) {
        node.error = I18n.t("请先填写任务目标或判断标准");
        return null;
      }
      const bits = [];
      const seen = new Set();
      const addBit = (src, w) => {
        if (!src || seen.has(src.id)) return;
        seen.add(src.id);
        const v = w ? valueFromWire(w, node, 0) : valueForInput(src, 0, node);
        if (v && v.kind === "text" && v.text)
          bits.push("### " + (src.title || "") + "\n" + String(v.text));
      };
      for (const w of wiresTo(node.id)) addBit(nodeById(w.from), w);
      /* 全局广播：需同时满足「开启彩虹开关」+「判断标准里明文 @ 引用」，否则一律不注入 */
      for (const src of globalRefSourcesForRun(node, procPromptForRun(node)))
        addBit(src, null);
      const prov = pickTextProviderForJudge(node);
      if (!prov) {
        node.error = I18n.t("未配置带 API Key 的文本服务商");
        return "blocked";
      }
      const prompt =
        I18n.t(
          "你是任务裁决器。根据「目标」和「已有结果」判断目标是否已经达成。只输出一行：YES 或 NO，不要解释。",
        ) +
        "\n\n【目标】\n" +
        goal +
        (bits.length ? "\n\n【已有结果】\n" + bits.join("\n\n") : "");
      const rr = await window.api.apiCall({
        provider: prov,
        kind: "text",
        model: node.model || (prov.models || [])[0] || "",
        prompt,
        texts: [],
        images: [],
        temperature: 0.1,
        effort: "low",
      });
      if (node._aborted) return "abort";
      if (!rr || !rr.ok) {
        node.error = (rr && rr.error) || I18n.t("判断调用失败");
        return "blocked";
      }
      const yn = parseJudgeYesNo(rr.text);
      if (yn == null) {
        node.error = I18n.t("无法从模型回复中解析是/否");
        node.output = { kind: "text", text: String(rr.text || "") };
        return "blocked";
      }
      node.judgeResult = yn ? "yes" : "no";
      node.output = { kind: "text", text: yn ? "YES" : "NO" };
      node.ranAt = Date.now();
      if (!quiet)
        toast(
          I18n.t("判断：") + (yn ? I18n.t("是") : I18n.t("否")),
          yn ? "ok" : "warn",
        );
      return yn;
    } catch (e) {
      node.error = e.message || String(e);
      return "blocked";
    } finally {
      node.running = false;
      renderCanvas();
      scheduleSave(true);
    }
  })();
  S.runPromises.set(node.id, runP);
  try {
    return await runP;
  } finally {
    if (S.runPromises.get(node.id) === runP) S.runPromises.delete(node.id);
  }
}

function execOutWires(node, fromIndex) {
  const fi = Number(fromIndex || 0);
  return ((S.wf && S.wf.wires) || []).filter(
    (w) => w.from === node.id && Number(w.fromIndex || 0) === fi,
  );
}

async function pulseExecFrom(node, task, seen, toIndex) {
  if (!node || !task) return "open";
  if (task._aborted) return "abort";

  /* 闸门 / 计数 / 互斥可多次进入，不走通用 seen 拦截 */
  if (node.kind === "gate") {
    return pulseGate(node, task, seen, toIndex);
  }
  if (node.kind === "counter") {
    return pulseCounter(node, task, seen);
  }
  if (node.kind === "mutex") {
    return pulseMutex(node, task, seen, toIndex);
  }
  if (node.kind === "splitter") {
    if (seen.has(node.id)) return "open";
    seen.add(node.id);
    return pulseSplitter(node, task, seen);
  }

  if (seen.has(node.id)) return "open";
  seen.add(node.id);
  const role = ctrlRoleOf(node);
  if (role === "endSuccess") return "success";
  if (role === "endFail") return "fail";

  if (node.kind === "judge") {
    const yn = await playJudgeNode(node, true);
    if (task._aborted) return "abort";
    if (yn === "abort") return "abort";
    if (yn === "blocked" || yn == null) return "blocked";
    return mergePulseResults(
      await pulseExecOutgoing(node, yn ? 0 : 1, task, seen),
    );
  }

  if (node.kind === "timer") {
    const r = await waitForTimerPulse(node, task);
    if (task._aborted || r === "abort") return "abort";
    if (r === "blocked") return "blocked";
    return mergePulseResults(await pulseExecOutgoing(node, 0, task, seen));
  }

  if (node.kind === "delayer") {
    const r = await waitForDelayerPulse(node, task);
    if (task._aborted || r === "abort") return "abort";
    return mergePulseResults(await pulseExecOutgoing(node, 0, task, seen));
  }

  if (node.kind === "sequencer") {
    return pulseSequencer(node, task, seen);
  }

  if (role !== "start") {
    try {
      if (node.kind === "task") {
        await playTaskNode(node, true, { emitOut: false });
        if (task._aborted) return "abort";
        if (node.taskStatus === "blocked") return "blocked";
        const fi = taskControlOutIndex(node);
        if (fi < 0) {
          if (node.taskStatus === "pending") return "abort";
          return "fail";
        }
        return mergePulseResults(await pulseExecOutgoing(node, fi, task, seen));
      } else if (node.kind === "wait_file") await playWaitFileNode(node, true);
      else if (isSaveNode(node))
        await saveNodeAction(node);
      else if (
        node.kind === "proc_text" ||
        node.kind === "proc_image" ||
        node.kind === "agent_task"
      )
        await playNode(node, true);
    } catch (e) {
      node.error = e.message || String(e);
    }
    if (task._aborted) return "abort";
    if (node.kind === "wait_file" && node.running) return "blocked";
    if (
      node.kind === "agent_task" &&
      node.running &&
      String(node.error || "").indexOf("等待") >= 0
    )
      return "blocked";
  }
  return mergePulseResults(await pulseExecOutgoing(node, 0, task, seen));
}

async function pulseExecOutgoing(node, fromIndex, task, seen) {
  const wires = execOutWires(node, fromIndex);
  if (!wires.length) return ["open"];
  const out = [];
  for (const w of wires) {
    if (task._aborted) {
      out.push("abort");
      break;
    }
    const next = nodeById(w.to);
    if (!next) continue;
    /* 控制脉冲经超级节点端子隧穿到另一侧 */
    if (next.kind === "super" && nodeParentSuperId(node) !== next.id) {
      const ti = Number(w.toIndex || 0);
      let any = false;
      for (const bw of superInternalBridgeWiresAll(next)) {
        if (Number(bw.fromIndex || 0) !== ti) continue;
        const child = nodeById(bw.to);
        if (!child) continue;
        if (nodeParentTaskId(child) !== task.id && child.id !== task.id) continue;
        any = true;
        out.push(
          await pulseExecFrom(child, task, seen, Number(bw.toIndex || 0)),
        );
      }
      if (!any) out.push("open");
      continue;
    }
    if (next.kind === "super" && nodeParentSuperId(node) === next.id) {
      const ti = Number(w.toIndex || 0);
      let any = false;
      for (const ow of superExternalOutWiresAll(next)) {
        if (Number(ow.fromIndex || 0) !== ti) continue;
        const dest = nodeById(ow.to);
        if (!dest) continue;
        if (nodeParentTaskId(dest) !== task.id && dest.id !== task.id) continue;
        any = true;
        out.push(
          await pulseExecFrom(dest, task, seen, Number(ow.toIndex || 0)),
        );
      }
      if (!any) out.push("open");
      continue;
    }
    if (nodeParentTaskId(next) !== task.id && next.id !== task.id) continue;
    out.push(
      await pulseExecFrom(next, task, seen, Number(w.toIndex || 0)),
    );
  }
  return out.length ? out : ["open"];
}

function mergePulseResults(list) {
  /* 多路控制流优先级：失败 < 需干涉 < 成功（任一路到达成功即成功，忽略途中失败节点） */
  const arr = Array.isArray(list) ? list : [list];
  if (arr.includes("abort")) return "abort";
  if (arr.includes("success")) return "success";
  if (arr.includes("blocked")) return "blocked";
  if (arr.includes("fail")) return "fail";
  return "open";
}

function abortTaskTree(node, out) {
  if (!node) return out;
  /* 统一走 bumpNodeStop：整棵子树（含任务内的媒体 / 处理节点）批次作废，
     在途运行体在下一个检查点退出，排队项也不再起跑 */
  bumpNodeStop(node);
  /* 函数 / 工具节点：线程在主进程里，光打标记停不掉 —— 登记下来交给调用方按 runId
     真取消（否则「停了任务，任务里的函数线程照跑、外部进程照活」） */
  if (out && isComputeExecKind(node) && computeExecNodeActive(node))
    out.push(node);
  for (const t of taskChildTasksOf(node.id)) abortTaskTree(t, out);
  for (const n of taskChildrenOf(node.id)) {
    if (n.running) bumpNodeStop(n);
    if (out && isComputeExecKind(n) && computeExecNodeActive(n)) out.push(n);
  }
  return out;
}

function askAssistDecomposeTask(node) {
  if (!node || node.kind !== "task") return;
  const sup = dshSupported();
  if (!sup.ok) {
    toast(sup.reason, "warn");
    return;
  }
  S.sel = node.id;
  if (S.selSet) {
    S.selSet.clear();
    S.selSet.add(node.id);
  }
  S.selWire = null;
  setAssistOpen(true);
  const goal = String(node.goal || "").trim();
  const arg = [
    "请拆解任务节点「" +
      (node.title || I18n.t("任务")) +
      "」（id=" +
      node.id +
      "）。",
    goal
      ? "任务目标：" + goal
      : "请根据标题理解目标；必要时先更新该节点的 goal。",
  ].join("\n");
  assistSend("/generate-task " + arg);
}

async function playTaskNode(node, quiet, opts) {
  opts = opts || {};
  const emitOut = opts.emitOut !== false;
  if (!node || node.kind !== "task") return;
  if (node.running) {
    const p = S.runPromises.get(node.id);
    if (p) await p;
    return;
  }
  let pendingIds = null;
  if (!quiet) {
    pendingIds = collectPendingRunIds(node, true);
    addPendingRun(pendingIds);
    const ranUp = [];
    try {
      await ensureProcessedAll(procSourcesOf(node), ranUp);
    } catch (e) {
      if (pendingIds) clearPendingRun(pendingIds);
      throw e;
    }
  }
  if (S.pendingRun) S.pendingRun.delete(node.id);
  ensureTaskScaffold(node);
  node.running = true;
  node.error = null;
  node._aborted = false;
  node.taskStatus = "running";
  renderCanvas();
  renderStatus();
  const runP = (async () => {
    try {
      const start = taskStartOf(node.id);
      if (!start) {
        node.taskStatus = "failed";
        node.error = I18n.t("缺少起点");
        return;
      }
      const outcome = await pulseExecFrom(start, node, new Set());
      if (node._aborted || outcome === "abort") {
        node.error = I18n.t("已手动停止");
        node.taskStatus = "pending";
        return;
      }
      if (outcome === "blocked") {
        node.taskStatus = "blocked";
        node.error = node.error || I18n.t("需要干涉后才能继续");
        if (!quiet) toast(I18n.t("任务需要干涉：") + (node.title || ""), "warn");
        return;
      }
      if (outcome === "fail") {
        node.taskStatus = "failed";
        node.ranAt = Date.now();
        node.output = {
          kind: "text",
          text: taskSummaryText(node, [I18n.t("到达失败终点")]),
        };
        if (!quiet)
          toast(I18n.t("任务失败：") + (node.title || I18n.t("任务")), "err");
        return;
      }
      if (outcome === "success") {
        node.taskStatus = "done";
        node.ranAt = Date.now();
        node.output = {
          kind: "text",
          text: taskSummaryText(node, [I18n.t("到达成功终点")]),
        };
        if (!quiet)
          toast(I18n.t("任务完成：") + (node.title || I18n.t("任务")), "ok");
        return;
      }
      node.taskStatus = "failed";
      node.error = I18n.t("控制流未到达终点");
      if (!quiet) toast(I18n.t("控制流未到达终点"), "err");
    } catch (e) {
      node.error = node._aborted
        ? I18n.t("已手动停止")
        : e.message || String(e);
      node.taskStatus = "failed";
      if (!quiet && !node._aborted)
        toast(I18n.t("任务执行失败：") + node.error, "err");
    } finally {
      node.running = false;
      if (pendingIds) clearPendingRun(pendingIds);
      renderCanvas();
      renderStatus();
      scheduleSave(true);
    }
  })();
  S.runPromises.set(node.id, runP);
  try {
    await runP;
  } finally {
    if (S.runPromises.get(node.id) === runP) S.runPromises.delete(node.id);
  }
  if (emitOut) await fireTaskControlOutputs(node);
}

function taskControlOutIndex(node) {
  if (!node) return -1;
  if (node.taskStatus === "done") return 0;
  if (node.taskStatus === "failed") return 1;
  return -1;
}

async function fireTaskControlOutputs(node, seen) {
  if (!node || node.kind !== "task") return;
  const fi = taskControlOutIndex(node);
  if (fi < 0) return;
  seen = seen || new Set();
  seen.add(node.id);
  const wires = execOutWires(node, fi);
  for (const w of wires) {
    const next = nodeById(w.to);
    if (!next || seen.has(next.id)) continue;
    if (nodeParentTaskId(next) === node.id) continue;
    if (!canControlRun(next)) continue;
    try {
      await runControlledNode(next, seen);
    } catch (e) {
      if (next) next.error = (e && e.message) || String(e);
    }
  }
}

async function importFileToText(node, pathOverride) {
  let p = pathOverride;
  if (!p) {
    const r = await window.api.fileOpenDialog({
      title: I18n.t("选择文本文件（文件参考）"),
      filters: [
        {
          name: I18n.t("文本"),
          extensions: [
            "txt",
            "md",
            "json",
            "yaml",
            "yml",
            "csv",
            "log",
            "xml",
            "html",
            "js",
            "py",
            "ts",
            "sql",
            "ini",
            "cfg",
          ],
        },
        { name: I18n.t("全部文件"), extensions: ["*"] },
      ],
    });
    if (!r.path) return;
    p = r.path;
  }
  const rd = await window.api.fileReadText(p);
  if (!rd.exists) {
    toast(I18n.t("无法读取文件"), "err");
    return;
  }
  const bytes = new Blob([rd.content]).size;
  pushHistory();
  node.text = rd.content;
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已导入文件内容（") + Math.round(bytes / 1024) + "KB）", "ok");
}

async function importYaml(node) {
  const r = await window.api.fileOpenDialog({
    title: I18n.t("导入 YAML（field=标题，内容=内容）"),
    filters: [{ name: "YAML", extensions: ["yaml", "yml", "txt"] }],
  });
  if (!r.path) return;
  const rd = await window.api.fileReadText(r.path);
  if (!rd.exists) {
    toast(I18n.t("文件不存在"), "err");
    return;
  }
  const es = parseSimpleYaml(rd.content);
  if (!es.length) {
    toast(I18n.t("未解析到条目（格式：标题: 内容）"), "warn");
    return;
  }
  pushHistory();
  node.entries = es.map((e) => ({
    id: uid("e"),
    title: e.title,
    content: e.content,
  }));
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已导入 ") + es.length + I18n.t(" 条"), "ok");
}

async function pasteYaml(node) {
  const text = await window.api.clipboardReadText();
  if (!text || !text.trim()) {
    toast(I18n.t("剪贴板为空"), "warn");
    return;
  }
  const es = parseSimpleYaml(text);
  if (!es.length) {
    toast(I18n.t("未解析到条目（格式：标题: 内容）"), "warn");
    return;
  }
  pushHistory();
  node.entries = es.map((e) => ({
    id: uid("e"),
    title: e.title,
    content: e.content,
  }));
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("已从剪贴板写入 ") + es.length + I18n.t(" 条"), "ok");
}

/* ============ 节点内小工具 ============ */

async function pickImage(node) {
  if (node.ro) {
    toast(I18n.t("拆分出的只读节点，不可修改"), "warn");
    return;
  }
  if (inputInherited(node)) {
    toast(I18n.t("该节点已继承输入，内容只读"), "warn");
    return;
  }
  const r = await window.api.fileOpenDialog({
    title: I18n.t("选择图像（输入节点）"),
    filters: [
      {
        name: I18n.t("图像"),
        extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
      },
      { name: I18n.t("全部文件"), extensions: ["*"] },
    ],
  });
  if (!r.path) return;
  const copied = await copyImageFromPath(r.path, node.id);
  if (node.imageAsset) invalidateImageMeta(node.imageAsset);
  node.imageAsset = copied.path;
  node.sourceName = copied.sourceName;
  clearDownstream(node.id);
  scheduleSave();
  renderCanvas();
  toast(I18n.t("图像已载入输入节点"), "ok");
}

/* ============ 音频 / 视频输入节点（选本机文件 · 输出该文件的 URL） ============ */

/* 打开系统文件框选一个媒体文件（kind: 'audio' | 'video'）；取消返回 "" */
async function pickMediaFile(kind) {
  const isVid = kind === "video";
  const r = await window.api.fileOpenDialog({
    title: isVid ? I18n.t("选择视频（输入节点）") : I18n.t("选择音频（输入节点）"),
    filters: [
      {
        name: isVid ? I18n.t("视频") : I18n.t("音频"),
        extensions: isVid ? VIDEO_FILE_EXTS : AUDIO_FILE_EXTS,
      },
      { name: I18n.t("全部文件"), extensions: ["*"] },
    ],
  });
  return (r && r.path) || "";
}

/* 给音视频输入节点设定文件：直接引用本机绝对路径，不复制进工作流资产。
   返回 true = 已写入（调用方负责 pushHistory / renderCanvas）。 */
function setNodeMedia(node, absPath) {
  if (!node || (node.kind !== "input_audio" && node.kind !== "input_video"))
    return false;
  const p = String(absPath || "").trim();
  if (!p) return false;
  node.mediaAsset = p;
  node.sourceName = imageStem(p) || fileName(p);
  clearDownstream(node.id);
  scheduleSave();
  return true;
}

/* 节点内「选择…」按钮：文件框 → 设定路径 */
async function pickMediaForNode(node) {
  const kind = node.kind === "input_video" ? "video" : "audio";
  const p = await pickMediaFile(kind);
  if (!p) return;
  pushHistory();
  if (!setNodeMedia(node, p)) return;
  renderCanvas();
  toast(
    (kind === "video" ? I18n.t("视频已载入输入节点") : I18n.t("音频已载入输入节点")),
    "ok",
  );
}

/* ============ 实时保存 ============ */

/* ── 已删画布黑名单（防复活 / 防串写）──
   主进程删除是物理删（软删同理：列表里已经不再有它）：画布文件一旦没了，
   渲染层残留的任何一次 wfSave 都会在磁盘上凭空写出一个 JSON —— 用户看到
   「删掉的画布又回来了」。更糟的是同名重建（default 最常见）时，agent 手里
   的旧对象写回会把旧内容串进新画布。所以删除确认后：
   ① id 记进黑名单  ② 被删对象盖墓碑  ③ 它在渲染层的残留状态全部摘掉，
   persist / persistWf / flushCurrentWf / rememberWf 命中即丢弃，agent 写入
   入口（画布编辑 / 重命名 / 再删）直接抛「画布已删除」，不再静默落盘。 */
function wfBlacklist() {
  if (!S._deletedWfIds || typeof S._deletedWfIds !== "object")
    S._deletedWfIds = {};
  return S._deletedWfIds;
}
/* 该 id 是否已被登记为「已删除」（同名画布合法重建后由 reviveWf 解禁） */
function wfIsDeleted(id) {
  const k = id == null ? "" : String(id);
  return !!k && !!wfBlacklist()[k];
}
/* 目标画布对象是否禁止写盘：对象墓碑（优先，同名重建也拦得住）或 id 在黑名单 */
function wfWriteBlocked(wf) {
  if (!wf) return false;
  try {
    if (S._deadWfObjs && typeof S._deadWfObjs.has === "function" && S._deadWfObjs.has(wf))
      return true;
  } catch (_) {}
  return wfIsDeleted(wf.id);
}
/* 给 agent / 用户看的统一错误文案（画布已删后继续写回的调用用它） */
function deletedWfError(wf) {
  const nm = String((wf && (wf.name || wf.id)) || "").trim();
  return nm ? I18n.t("画布已删除：") + nm : I18n.t("画布已删除");
}
/* 删除成功后的统一收口：掐待保存定时器 + 摘内存袋 + 剔运行栈 + 清节点归属 + 记黑名单 */
function forgetDeletedWf(id, wf) {
  const key = String((id == null ? "" : id) || (wf && wf.id) || "");
  if (!key) return;
  /* 被删对象优先取显式传入，其次前台真源 / 袋里那一份（用于盖墓碑） */
  let dead = wf && String(wf.id) === key ? wf : null;
  if (!dead && S.wf && String(S.wf.id) === key) dead = S.wf;
  if (!dead && currentVisibleWf && String((currentVisibleWf() || {}).id || "") === key)
    dead = currentVisibleWf();
  if (!dead && S.wfBag && S.wfBag[key] && String(S.wfBag[key].id) === key)
    dead = S.wfBag[key];
  wfBlacklist()[key] = { at: Date.now(), name: String((dead && dead.name) || key) };
  if (dead) {
    try {
      if (S._deadWfObjs && typeof S._deadWfObjs.add === "function")
        S._deadWfObjs.add(dead);
    } catch (_) {}
  }
  /* 画布被删除 = 它名下函数 / 工具节点的运行也必须跟着没：对象从袋里摘掉之后再没人
     能点 ■（连节点都查不到），线程与它拉起的外部进程就成了孤儿。这里就地作废这批
     批次并按 runId 取消（主进程 terminate 线程 + 连进程树回收）；运行体自己 await 到
     「已手动停止」收尾。取消是异步的，删除流程不等你 —— 兜底还有 before-quit 的 killAll。 */
  if (dead && Array.isArray(dead.nodes)) {
    try {
      for (const n of dead.nodes) {
        if (!n || !isComputeExecKind(n)) continue;
        if (!n.running && !(typeof computeExecNodeActive === "function" ? computeExecNodeActive(n) : fnHasLiveRun(n))) continue;
        try {
          bumpNodeStop(n);
        } catch (_) {}
      }
      if (typeof fnCancelRunsOfNodes === "function")
        Promise.resolve(fnCancelRunsOfNodes(dead.nodes)).catch(() => {});
    } catch (_) {}
  }
  /* 250ms 的待保存定时器必须在摘对象之前掐掉，否则它回调时把已删画布写回磁盘 */
  clearTimeout(S.saveTimer);
  S.saving = false;
  if (S.wfBag) delete S.wfBag[key];
  /* 运行绑定栈：按 id 与对象身份双口径剔除，别把幽灵留在栈顶当写入目标 */
  if (Array.isArray(S.canvasRunStack)) {
    S.canvasRunStack = S.canvasRunStack.filter(
      (w) => w && String(w.id) !== key && w !== dead,
    );
  } else S.canvasRunStack = [];
  if (S.canvasRunWf && (String(S.canvasRunWf.id) === key || S.canvasRunWf === dead))
    S.canvasRunWf = S.canvasRunStack.length
      ? S.canvasRunStack[S.canvasRunStack.length - 1]
      : null;
  /* 节点归属表里指向这张画布的条目一并清掉（ownerWfOfNode 靠它找回画布） */
  if (S.nodeWfId && typeof S.nodeWfId === "object") {
    for (const nid of Object.keys(S.nodeWfId))
      if (String(S.nodeWfId[nid]) === key) delete S.nodeWfId[nid];
  }
}
/* 解禁某 id：新建 / 导入 / 从磁盘成功加载同名画布时调用（只解 id，墓碑保留） */
function reviveWf(id) {
  const k = String(id == null ? "" : id);
  if (!k) return;
  const bag = wfBlacklist();
  if (bag[k]) delete bag[k];
}

function rememberWf(wf) {
  if (!wf || !wf.id) return;
  /* 已删画布不得再入袋：入袋就等于给它留了一条被 persistWf 写回磁盘的路 */
  if (wfWriteBlocked(wf)) return;
  S.wfBag[wf.id] = wf;
}
function wfHasRunning(wf) {
  if (!wf || !Array.isArray(wf.nodes)) return false;
  if (wf.nodes.some((n) => n && n.running)) return true;
  /* 函数 / 工具节点的执行体在主进程的独立线程里：只在排队（还没置 running）也算
     「这张画布有活」。少了这一半，切回该画布会用磁盘副本换掉节点对象，
     那次排队 / 在飞的运行就成了看不见、也停不掉的幽灵（线程与进程没人管）。 */
  return !!(
    typeof computeExecActivityInWf === "function" &&
    computeExecActivityInWf(wf)
  );
}
function beginCanvasRun(wf) {
  if (!wf) return;
  /* 已删画布不再被绑成写入目标：agent 后续 canvas 事件落到真正活着的前台画布 */
  if (wfWriteBlocked(wf)) return;
  rememberWf(wf);
  if (!Array.isArray(S.canvasRunStack)) S.canvasRunStack = [];
  S.canvasRunStack.push(wf);
  S.canvasRunWf = wf;
}
function endCanvasRun(wf) {
  const st = Array.isArray(S.canvasRunStack) ? S.canvasRunStack : [];
  for (let i = st.length - 1; i >= 0; i--) {
    if (st[i] === wf) {
      st.splice(i, 1);
      break;
    }
  }
  S.canvasRunStack = st;
  S.canvasRunWf = st.length ? st[st.length - 1] : null;
}
function canvasTargetWf() {
  return S.canvasRunWf || S.wf;
}
/* 该画布此刻是否正被某一轮在飞运行当「所属画布」绑着写：beginCanvasRun 进栈、
   endCanvasRun 出栈（会话轮 / 智能节点轮 / 规划并行子任务都经这一对），栈里出现它的 id
   就说明「这张图有人在写，内存袋里那份才是最新」。切回该画布时据此复用袋中对象，
   不重新读盘 —— 见 loadWorkflow。 */
function wfInCanvasRun(id) {
  const key = String(id == null ? "" : id);
  if (!key) return false;
  const st = Array.isArray(S.canvasRunStack) ? S.canvasRunStack : [];
  if (st.some((w) => w && String(w.id) === key)) return true;
  const cur = S.canvasRunWf;
  return !!(cur && String(cur.id) === key);
}
/* ── 前台画布唯一真源（可判定锁）──
   currentVisibleWf() 永远返回用户界面上「当前画布」那个对象：后台换画布编辑
   （runAgainstWf 临时把 S.wf 换成别的画布）不会污染它，删除 / 定位目标的入口都读这里。 */
function currentVisibleWf() {
  return S._fgWf || S.wf || null;
}
/* 用户可见的画布切换（打开 / 新建 / 导入 / 删除后重建）唯一经此赋值 */
function setForegroundWf(wf) {
  S._fgWf = wf;
  S.wf = wf;
  return wf;
}
/* 是否正有画布写入在飞（前台或后台换画布）：>0 期间 S.wf 未必是用户看到的画布 */
function bgCanvasWriteActive() {
  return (S._bgCanvasDepth || 0) > 0;
}
/* ── 会话「所属画布」→ 画布对象（一轮开轮绑定的唯一解析入口，app-db.js 用）──
   会话跑着的时候用户切去别的画布干活是常态，所以「本轮写哪张图」不看 S.wf 现在是谁、
   也不看运行栈栈顶，只按会话登记 stable 的 canvasWfId 去找：
   ① 前台画布就是它（绝大多数轮次；顺带覆盖后台换画布编辑在飞、S.wf 恰好指着它的情况）；
   ② 内存袋 S.wfBag 里有活对象 → 用它（可能正被另一条会话写，绝不重新读盘换对象）；
   ③ 都没有 → 从磁盘 wfLoad 一份并 rememberWf 入袋，后续 persistWf / ownerWfOfNode 才认它。
   命中已删黑名单 / 对象墓碑，或磁盘上根本读不出来 → 抛「本会话所属画布已被删除」：
   宁可这一轮明确失败，也绝不把会话的改动静默写进用户此刻正开着的另一张图。 */
function sessionWfDeletedError(wf) {
  const key = String((wf && (wf.id || wf.name)) || "").trim();
  const black = key ? wfBlacklist()[key] : null;
  const nm = String((wf && wf.name) || (black && black.name) || "").trim();
  return new Error(
    nm
      ? I18n.t("本会话所属画布已被删除：") + nm
      : I18n.t("本会话所属画布已被删除"),
  );
}
async function wfOfCanvasIdForRun(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  /* 命中就是它：先验活性（墓碑 / 黑名单都算死），死了直接抛，绝不退到前台画布 */
  const alive = (w) => {
    if (!w || String(w.id) !== key) return null;
    if (wfWriteBlocked(w)) throw sessionWfDeletedError(w);
    return w;
  };
  const hit =
    alive(currentVisibleWf()) ||
    alive(S.wf) ||
    alive(S.wfBag && S.wfBag[key]) ||
    null;
  if (hit) return hit;
  if (wfIsDeleted(key)) throw sessionWfDeletedError({ id: key });
  let r = null;
  try {
    r = await window.api.wfLoad(key);
  } catch (_) {
    r = null;
  }
  if (!r || !r.ok || !r.data) throw sessionWfDeletedError({ id: key });
  const wf = r.data;
  /* 磁盘上读得出来 = 这张画布是活的（例如删掉后又同名重建），解禁黑名单再入袋 */
  reviveWf(key);
  wf.id = key;
  if (wfWriteBlocked(wf)) throw sessionWfDeletedError(wf);
  rememberWf(wf);
  return wf;
}
/* 「所属画布」的同步读法（给工作区解析、侧栏显示这类不能等 IO 的入口用）：
   只看内存里已有的对象（前台 / 袋），没加载就是 null —— 由调用方决定退回什么口径。
   与 wfOfCanvasIdForRun 的区别只有「不读盘、不抛错」，判定顺序保持一致。 */
function canvasWfByIdLoaded(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  const fg = currentVisibleWf();
  if (fg && String(fg.id) === key && !wfWriteBlocked(fg)) return fg;
  if (S.wf && String(S.wf.id) === key && !wfWriteBlocked(S.wf)) return S.wf;
  const bag = S.wfBag && S.wfBag[key];
  if (bag && String(bag.id) === key && !wfWriteBlocked(bag)) return bag;
  return null;
}
/* 「所属画布」的显示名（同步版，给会话侧栏行与工作目录悬浮说明用）：
   一次渲染几十行，绝不为取名字去读盘。取名顺序 = 内存里的活对象 → 已删标记（直说它没了，
   不留一个「看着还在」的名字）→ 顶部标签条 visitedWorkflows 的 {id,name} 快照
   （用户看过这张图就会在里面）→ 短 id。
   画布没加载又不在标签条里时显示短 id 而不是瞎猜一个名字。 */
function wfNameOfId(id) {
  const key = String(id || "").trim();
  if (!key) return "";
  const wf = typeof canvasWfByIdLoaded === "function" ? canvasWfByIdLoaded(key) : null;
  if (wf) return String(wf.name || wf.id || key);
  /* 已删判据放在标签条之前：那张图的标签可能还没被用户关掉，
     侧栏里不能出现一个「看着还在」的画布名（下面会明说它已没了）。 */
  if (typeof wfIsDeleted === "function" && wfIsDeleted(key)) {
    const dead = String((wfBlacklist()[key] || {}).name || "");
    const nm = dead && dead !== key ? dead : I18n.t("画布");
    return nm + I18n.t("（已删除）");
  }
  const tabs =
    S && S.config && Array.isArray(S.config.visitedWorkflows)
      ? S.config.visitedWorkflows
      : [];
  for (const t of tabs) {
    if (t && String(t.id) === key && t.name) return String(t.name);
  }
  return key.length > 10 ? key.slice(0, 10) + "…" : key;
}
/* 一轮运行的生效工作区（dshWorkspaceOf 的「所属画布」版）：优先级一字不改 ——
   节点 / 会话手填 > 该画布项目根（开发块 devPath）> 该画布统一目录 > 应用默认目录。
   唯一区别是「该画布」= 本轮绑定（会话所属）的那张图，而不是用户此刻看到的图：
   会话运行中用户切去别的画布干活，工作目录不能跟着漂（漂了产物就落错项目）。
   绑定的就是前台画布时逐字等价于 dshWorkspaceOf，零回归。 */
function dshWorkspaceOfWf(node, wf) {
  const manual = node && (node.agentWorkspace || node.workspace);
  if (manual) return manual;
  /* 绑定的就是眼下挂着的画布对象 → 逐字走老路（连歧义标记的刷新口径都不变） */
  if (!wf || wf === S.wf) return dshWorkspaceOf(node);
  const projRoot = devProjectRootOf(wf);
  if (projRoot) return projRoot;
  if (wf.workspace) return wf.workspace;
  return S.dshWorkspaceFallback || "";
}
/* 编辑锁外壳：进入 +1、收尾 -1（成功 / 失败 / 异常都减，且只减一次），
   让 await 期间 currentVisibleWf() 与 persist() 的归属判定始终可依赖。 */
function runAgainstWf(wf, fn) {
  S._bgCanvasDepth = (S._bgCanvasDepth || 0) + 1;
  let closed = false;
  const closeBg = () => {
    if (closed) return;
    closed = true;
    S._bgCanvasDepth = Math.max(0, (S._bgCanvasDepth || 1) - 1);
  };
  try {
    const out = runAgainstWfInner(wf, fn);
    if (out && typeof out.then === "function") {
      return Promise.resolve(out).then(
        (v) => {
          closeBg();
          return v;
        },
        (e) => {
          closeBg();
          throw e;
        },
      );
    }
    closeBg();
    return out;
  } catch (e) {
    closeBg();
    throw e;
  }
}
/* 在指定工作流上下文中执行（canvas 事件 / 后台写回），visible=false 时不刷新当前画面 */
function runAgainstWfInner(wf, fn) {
  const fg = currentVisibleWf();
  const target = wf || fg;
  /* 目标就是用户看到的那个画布，且 S.wf 没被外层后台换走：不换手，也不污染 _fgWf */
  if (target === fg && S.wf === fg) {
    S._canvasEditVisible = true;
    return fn(true);
  }
  const prev = S.wf;
  S.wf = target;
  /* 换到后台画布时禁止 renderCanvas；换回前台画布（嵌套调用）才允许刷新 */
  S._canvasEditVisible = target === fg;
  const restore = () => {
    /* 期间用户切了画布（loadWorkflow 改了 S.wf）就别把手换回去，避免覆盖新画布。
       反向也一样：期间用户切「到」了这张正在被后台编辑的画布（loadWorkflow 复用了
       袋中同一个对象，见 wfInCanvasRun），此刻 S.wf === target 指的是用户正看着的图，
       换回 prev 会让前台视图的上下文指向另一张画布 —— 保持不动。 */
    if (S.wf === target && currentVisibleWf() !== target) S.wf = prev;
    /* 还有外层后台编辑在飞行时保持「非可见」，不让内层收尾把画布闪出来 */
    const outerInFlight = (S._bgCanvasDepth || 0) > 1;
    S._canvasEditVisible = !outerInFlight && S.wf === currentVisibleWf();
  };
  try {
    const out = fn(false);
    if (out && typeof out.then === "function") {
      return Promise.resolve(out).then(
        (v) => {
          restore();
          return v;
        },
        (e) => {
          restore();
          throw e;
        },
      );
    }
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}
function persistWf(wf) {
  if (!wf || !wf.id) return;
  /* 已删画布：直接丢弃这次写回（后台节点跑完的兜底写盘最容易踩到） */
  if (wfWriteBlocked(wf)) return;
  rememberWf(wf);
  let data;
  try {
    data = JSON.parse(JSON.stringify(wf));
  } catch (e) {
    const msg = I18n.t("画布包含无法序列化的数据：") + (e.message || e);
    toast(I18n.t("保存失败：") + msg, "err");
    return;
  }
  window.api.wfSave(wf.id, data).catch((err) => {
    toast(I18n.t("保存失败：") + ((err && err.message) || String(err)), "err");
  });
}
function ownerWfOfNode(node) {
  if (!node) return S.wf;
  const id = S.nodeWfId && S.nodeWfId[node.id];
  if (id && S.wfBag[id] && !wfWriteBlocked(S.wfBag[id])) return S.wfBag[id];
  if (!wfWriteBlocked(S.wf) && S.wf && Array.isArray(S.wf.nodes) && S.wf.nodes.some((n) => n.id === node.id))
    return S.wf;
  for (const wid of Object.keys(S.wfBag || {})) {
    const w = S.wfBag[wid];
    if (wfWriteBlocked(w)) continue;
    if (w && Array.isArray(w.nodes) && w.nodes.some((n) => n.id === node.id))
      return w;
  }
  return S.wf;
}
function refreshNodeUi(node) {
  const owner = ownerWfOfNode(node);
  if (owner && S.wf && owner.id === S.wf.id) {
    renderCanvas();
    renderStatus();
    if (S.sidebarOpen) renderSidebar();
  }
  if (S.view === "agent") renderAgentSession();
}

async function flushCurrentWf() {
  /* 前台画布锁：_bgCanvasDepth>0 期间 S.wf 可能正被后台换成别的画布，
     这里只准落 currentVisibleWf() 对应的对象（对象与 id 同源，绝不把后台内容
     写进前台 id）。后台画布的内容走 persistWf(wf)，按它自己的 id 落盘。 */
  const wf = bgCanvasWriteActive() ? currentVisibleWf() : S.wf;
  if (!wf || !wf.id) return;
  clearTimeout(S.saveTimer);
  /* 已删画布：这次落盘直接丢弃（写下去就是凭空复活一个空壳画布） */
  if (wfWriteBlocked(wf)) {
    S.saving = false;
    return;
  }
  rememberWf(wf);
  try {
    const data = JSON.parse(JSON.stringify(wf));
    await window.api.wfSave(wf.id, data);
    S.lastSaved = Date.now();
  } catch (e) {
    toast(I18n.t("保存失败：") + ((e && e.message) || String(e)), "err");
  }
}

function persist() {
  /* 同上：保存「当前（用户看到的）画布」，后台换画布在飞时以 _fgWf 为准 */
  const wf = bgCanvasWriteActive() ? currentVisibleWf() : S.wf;
  if (!wf || !wf.id) return;
  clearTimeout(S.saveTimer);
  /* 已删画布（含 250ms 定时器迟到回调 / 失焦 flushNow）：丢弃，绝不落盘复活 */
  if (wfWriteBlocked(wf)) {
    S.saving = false;
    renderStatus();
    return;
  }
  S.saving = true;
  renderStatus();
  rememberWf(wf);
  let data;
  try {
    data = JSON.parse(JSON.stringify(wf)); // 去除 Promise/函数等不可克隆字段，防御 IPC 序列化失败
  } catch (e) {
    S.saving = false;
    const msg = I18n.t("画布包含无法序列化的数据：") + (e.message || e);
    $("#saveState").textContent = I18n.t("保存失败：") + msg;
    $("#saveState").className = "err";
    toast(I18n.t("保存失败：") + msg, "err");
    return;
  }
  window.api
    .wfSave(wf.id, data)
    .then(() => {
      S.saving = false;
      S.lastSaved = Date.now();
      renderStatus();
      autoSaveSaves();
    })
    .catch((err) => {
      S.saving = false;
      const msg = err && err.message ? err.message : String(err);
      $("#saveState").textContent = I18n.t("保存失败：") + msg;
      $("#saveState").className = "err";
      toast(I18n.t("保存失败：") + msg, "err");
    });
}
function scheduleSave(immediate) {
  if (!S.wf) return;
  if (immediate) {
    clearTimeout(S.saveTimer);
    persist();
    return;
  }
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(persist, 250);
  $("#saveState").textContent = I18n.t("待保存…");
  $("#saveState").className = "warn";
}

/* 窗口失焦 / 关闭前立即落盘：确保最后的输出/编辑一定写入存档 */
function flushNow() {
  if (!S.wf) return;
  clearTimeout(S.saveTimer);
  persist();
}

/* ============ 工作流管理 ============ */

/* 「文本对话（chat）」节点已移除 → 旧节点原地迁移为智能任务的会话模式。
   两者的对话记录结构完全一致（{ role, content, at, reasoning?, tools? }），
   所以会话内容、标题、位置、尺寸都能原样搬过去；系统提示词折进首条
   system 消息，服务商 providerId 折成智能体路由。只改这一个节点，不碰连线。 */
function migrateChatNodeToAgent(n) {
  const msgs = [];
  const sys = String(n.systemPrompt || "").trim();
  if (sys) msgs.push({ role: "system", content: sys, at: Date.now() });
  for (const m of Array.isArray(n.messages) ? n.messages : []) {
    if (!m || typeof m !== "object") continue;
    const role =
      m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant";
    const content = String(m.content == null ? "" : m.content);
    if (role === "system") {
      /* 旧对话节点只有一条系统提示词的位置：再遇到 system 就并入首条 */
      const first = msgs.find((x) => x.role === "system");
      if (first) {
        first.content = first.content
          ? first.content + "\n\n" + content
          : content;
        continue;
      }
    }
    const copy = { role, content, at: Number(m.at) || Date.now() };
    if (typeof m.reasoning === "string" && m.reasoning.trim())
      copy.reasoning = m.reasoning;
    if (Array.isArray(m.tools) && m.tools.length) copy.tools = m.tools;
    if (Array.isArray(m.segments) && m.segments.length) copy.segments = m.segments;
    msgs.push(copy);
  }
  /* 「▶ 重跑」的默认输入 = 最近一次用户提问（会话模式会带上全部历史） */
  let lastAsk = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      lastAsk = msgs[i].content;
      break;
    }
  }
  n.kind = "agent_task";
  n.chatMode = true;
  n.messages = msgs;
  n.task = String(typeof n.task === "string" && n.task.trim() ? n.task : lastAsk);
  n.workspace = String(n.agentWorkspace || "");
  n.convH = 200;
  n.inputH = 64;
  n.w = Math.max(380, Number(n.w) || 380);
  n.effort = normalizeAgentEffort(n.effort);
  n.preset = n.preset || AGENT_PRESET_DEFAULT;
  n.batchMode = "batch";
  n.agentSessionId = "";
  n.globalRefs = !!n.globalRefs;
  n.output = null;
  n.error = null;
  n.ranAt = 0;
  n.running = false;
  /* 对话节点用的是 API 服务商（providerId）：能折成智能体路由就折，
     否则留空，交给 syncAgentProviderRoute / 播放时回落默认路由 */
  if (!String(n.provider || "").trim()) {
    const fromApi =
      typeof agentRouteFromProviderId === "function" && n.providerId
        ? agentRouteFromProviderId(n.providerId)
        : "";
    n.provider = fromApi || "";
  }
  if (!String(n.model || "").trim()) n.model = "";
  delete n.providerId;
  delete n.systemPrompt;
  delete n.temperature;
  delete n.agent;
  delete n.agentWorkspace;
  if (typeof syncAgentProviderRoute === "function") {
    try {
      syncAgentProviderRoute(n);
    } catch (_) {}
  }
  return n;
}

function migrateWf(wf) {
  wf.nodes = wf.nodes || [];
  wf.wires = wf.wires || [];
  wf.groups = Array.isArray(wf.groups) ? wf.groups : [];
  wf.marks = Array.isArray(wf.marks) ? wf.marks : [];
  stripSuperIoNodes(wf);
  if (typeof wf.workspace !== "string") wf.workspace = "";
  {
    const seen = new Set();
    const cat = [];
    for (const raw of Array.isArray(wf.tagCatalog) ? wf.tagCatalog : []) {
      const t = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
      if (!t || seen.has(t)) continue;
      seen.add(t);
      cat.push(t);
    }
    wf.tagCatalog = cat;
  }
  /* 绘制只剩 text：框体（box）/ 箭头（arrow）已移除，归类节点请用「组」。
     老画布一次性迁移：box/arrow 直接丢弃（5 分钟自动备份 save-backups/ 可回找），
     其余未知类型收敛为 text，并清掉只服务框体/箭头的字段（stroke/x2/y2/dx/dy）；
     group.markIds 与空组在下方「清理组」段一并处理。 */
  {
    const keptMarks = [];
    const keptMarkIds = new Set();
    for (const m of wf.marks) {
      if (!m.id) m.id = uid("mk");
      if (m.kind === "box" || m.kind === "arrow") continue;
      if (m.kind !== "text") m.kind = "text";
      if (typeof m.x !== "number") m.x = 0;
      if (typeof m.y !== "number") m.y = 0;
      if (!m.color) m.color = "#38d6ff";
      if (typeof m.text !== "string") m.text = I18n.t("说明文字");
      if (!m.fontSize) m.fontSize = 16;
      if (!m.w) m.w = 200;
      if (!m.h) m.h = 44;
      delete m.stroke;
      delete m.x2;
      delete m.y2;
      delete m.dx;
      delete m.dy;
      keptMarkIds.add(m.id);
      keptMarks.push(m);
    }
    wf.marks = keptMarks;
    for (const g of wf.groups || []) {
      if (!Array.isArray(g.markIds)) continue;
      g.markIds = g.markIds.filter((id) => keptMarkIds.has(id));
    }
  }
  for (const n of wf.nodes) {
    n.title = n.title || I18n.t("未命名节点");
    delete n.runPromise; // 清理旧版本误存的运行期 Promise
    {
      const seen = new Set();
      const tags = [];
      for (const raw of Array.isArray(n.tags) ? n.tags : []) {
        const t = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
        if (!t || seen.has(t)) continue;
        seen.add(t);
        tags.push(t);
        if (!wf.tagCatalog.includes(t)) wf.tagCatalog.push(t);
      }
      n.tags = tags;
    }
    if (n.kind === "global") {
      const seen = new Set();
      const filters = [];
      for (const raw of Array.isArray(n.tagFilter) ? n.tagFilter : []) {
        const t = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
        if (!t || seen.has(t)) continue;
        seen.add(t);
        filters.push(t);
        if (!wf.tagCatalog.includes(t)) wf.tagCatalog.push(t);
      }
      n.tagFilter = filters;
    } else if (n.tagFilter != null) {
      delete n.tagFilter;
    }
    if (n.kind === "save_text") {
      if (!n.legacySaveMedia) n.legacySaveMedia = "text";
      n.kind = "save";
    } else if (n.kind === "save_image") {
      if (!n.legacySaveMedia) n.legacySaveMedia = "image";
      n.kind = "save";
    }
    /* 「文本对话（chat）」节点已移除：旧画布上的对话节点原地迁移成
       智能任务节点的「会话模式」（chatMode）——两者消息结构同为
       { role, content, at }，对话记录、标题、位置与尺寸原样保留，
       旧画布不报错、会话内容不丢。系统提示词并进首条 system 消息。 */
    if (n.kind === "chat") migrateChatNodeToAgent(n);
    /* 工具节点一次性迁移为超级节点变体（kind:"super" + tool:true）：规范形态见
       docs/tool-function-nodes.md §0。只改形态字段并补齐超级壳层默认值，id / 标题 /
       位置尺寸 / toolConfig / parentSuperId 与内部子节点关系一律不动，连线两端仍是
       同一批 id 与端子序号，故无需改写连线。幂等：已是变体时不触发，旧画布反复加载
       逐字不变（新形态不会再被本分支命中）。 */
    if (n.kind === "tool") migrateToolNodeToSuperForm(n);
    if (n.kind === "input_text" || n.kind === "input_image") {
      if (n.batch == null) n.batch = false;
      if (!Array.isArray(n.entries)) n.entries = [];
    }
    if (n.kind === "input_audio" || n.kind === "input_video") {
      /* 音视频输入：只记原绝对路径（不复制进资产）· 旧档缺字段时补齐 */
      if (typeof n.mediaAsset !== "string") n.mediaAsset = "";
      if (typeof n.sourceName !== "string") n.sourceName = "";
      n.running = false;
    }
    if (n.kind === "input_image") {
      if (typeof n.sourceName !== "string") n.sourceName = "";
      for (const e of n.entries) {
        if (!e || typeof e !== "object") continue;
        if (typeof e.sourceName !== "string" || !e.sourceName.trim()) {
          const fromTitle = String(e.title || "").trim();
          /* 已有可读标题则记为 sourceName；随机资产名不作源名 */
          if (fromTitle && !/^[a-z0-9]+_\w+_\w+$/i.test(fromTitle))
            e.sourceName = fromTitle;
          else e.sourceName = "";
        }
      }
    }
    if (
      n.kind === "proc_text" ||
      n.kind === "proc_image" ||
      isSaveNode(n)
    ) {
      if (n.batchMode !== "agg") n.batchMode = "batch";
    }
    if (n.kind === "proc_text" || n.kind === "proc_image") {
      if (!n.size) n.size = DEFAULT_IMAGE_SIZE;
      n.batchOutputs = n.batchOutputs || null;
      n.running = false;
    }
    if (n.kind === "proc_image") {
      normalizeBgRm(n);
    }
    /* 函数 / 工具节点（含 super + tool:true 变体）：旧画布加载归一 */
    if (typeof ensureFnToolNodeState === "function") ensureFnToolNodeState(n);
    /* 素材节点：绑定字段归一。assetLost 是运行期判定结果（库里还有没有这个素材），
       加载时先抹掉，等 app-assets.js 静默扫描重新给 —— 旧画布不该带着上次退出时的
       「失联」标记误导用户。 */
    if (n.kind === "asset") {
      if (typeof n.assetId !== "string") n.assetId = "";
      if (typeof n.assetRel !== "string") n.assetRel = "";
      if (typeof n.assetName !== "string") n.assetName = "";
      if (typeof n.assetDesc !== "string") n.assetDesc = "";
      if (!Array.isArray(n.items)) n.items = [];
      delete n.assetLost;
    }
    if (typeof n.parentTaskId !== "string") n.parentTaskId = "";
    if (n.kind === "anim") {
      const gifPath =
        (n.output && n.output.path) ||
        (selResult(n) && selResult(n).output && selResult(n).output.path) ||
        "";
      n.kind = "input_image";
      n.imageAsset = gifPath || "";
      n.sourceName = n.sourceName || "";
      n.batch = false;
      if (!Array.isArray(n.entries)) n.entries = [];
      n.w = NODE_DEFAULTS.input_image.w;
      n.h = NODE_DEFAULTS.input_image.h;
      n.title = n.title || I18n.t("图像节点");
      delete n.animCols;
      delete n.animRows;
      delete n.animKey;
      delete n.output;
      delete n.batchOutputs;
    }
    if (n.kind === "proc_text" || n.kind === "proc_image") {
      if (n.attempts == null) n.attempts = 1;
      if (n.attemptIdx == null) n.attemptIdx = 0;
    }
    if (
      n.kind === "music_gen" ||
      n.kind === "tts_gen" ||
      n.kind === "video_gen" ||
      n.kind === "remotion"
    ) {
      if (n.attempts == null) n.attempts = 1;
    }
    /* SoVITS 语音节点：字段归一（语速 0.5–2.0，输出格式 wav|mp3） */
    if (n.kind === "tts_gen") {
      if (typeof n.voice !== "string") n.voice = "";
      if (n.ttsFormat !== "mp3") n.ttsFormat = "wav";
      if (typeof n.ttsStatus !== "string") n.ttsStatus = "";
      if (typeof n.outputPath !== "string") n.outputPath = "";
      const sp = Number(n.speed);
      n.speed = sp > 0 ? Math.max(0.5, Math.min(2, sp)) : 1;
    }
    if (n.kind === "task") {
      normalizeTaskSteps(n);
      n.running = false;
      n.output = n.output || null;
      if (n.taskStatus === "running") n.taskStatus = "pending";
      if (n.taskStatus !== "done" && n.taskStatus !== "failed" && n.taskStatus !== "blocked")
        n.taskStatus = n.taskStatus || "pending";
    }
    if (n.kind === "super") {
      if (typeof n.note !== "string") n.note = "";
      if (!n.expandW) n.expandW = 720;
      if (!n.expandH) n.expandH = 480;
      if (typeof n.subFolder !== "string") n.subFolder = "";
      if (typeof n.parentSuperId !== "string") n.parentSuperId = "";
      if (n.superOpen == null) n.superOpen = false;
      if (!Number.isFinite(Number(n.innerPanX))) n.innerPanX = 0;
      if (!Number.isFinite(Number(n.innerPanY))) n.innerPanY = 0;
    }
    if (isSaveNode(n)) {
      if (!Array.isArray(n.savedPaths))
        n.savedPaths = n.savedPath ? [n.savedPath] : [];
      n.savedPaths = n.savedPaths.filter(Boolean);
    }
    if (n.kind === "proc_text") {
      if (n.agent) {
        /* 智能模式走 dsh：档位词汇内原样保留（high/max 原样合法，medium/xhigh/low 不再拍平），
           旧 off/none → high */
        n.effort = normalizeAgentEffort(n.effort);
      } else {
        n.effort = normalizeTextEffort(n.effort);
      }
    }
    if (n.kind === "proc_text") {
      if (n.agent == null) n.agent = false;
      if (typeof n.agentWorkspace !== "string") n.agentWorkspace = "";
    }
    if (n.kind === "agent_task") {
      if (typeof n.task !== "string") n.task = "";
      if (!Array.isArray(n.messages)) n.messages = [];
      if (typeof n.workspace !== "string") n.workspace = "";
      if (n.batchMode !== "agg") n.batchMode = "batch";
      n.effort = normalizeAgentEffort(n.effort);
      if (!n.preset) n.preset = AGENT_PRESET_DEFAULT;
      if (typeof n.agentSessionId !== "string") n.agentSessionId = "";
      if (!n.convH || n.convH < 60) n.convH = 140; /* 会话历史框高度 */
      if (!n.inputH || n.inputH < 40) n.inputH = 56; /* 输入框高度 */
      n.running = false;
      n.output = n.output || null;
    }
    if (n.kind === "control") {
      if (n.ctrlAction !== "clear") n.ctrlAction = "run";
      n.ctrlFillOnly = !!n.ctrlFillOnly;
      n.ctrlRole = n.ctrlRole || "";
      n.ctrlPinned = !!n.ctrlPinned;
      n.running = false;
    }
    if (n.kind === "judge") {
      if (typeof n.prompt !== "string") n.prompt = "";
      n.judgeResult = n.judgeResult || "";
      n.running = false;
      n.output = n.output || null;
    }
    if (canUseGlobalRefs(n)) {
      n.globalRefs = !!n.globalRefs;
    }
    if (n.kind === "wait_file") {
      if (typeof n.waitPath !== "string") n.waitPath = "";
      n.waitIntervalSec = Math.max(
        1,
        Math.min(60, Math.round(Number(n.waitIntervalSec) || 2)),
      );
      if (typeof n.waitStatus !== "string") n.waitStatus = "";
      /* 旧版用 output 路径文本表示就绪；现改为控制节点，仅 waitReady，不输出内容 */
      if (n.waitReady == null) {
        n.waitReady = !!(n.output && n.output.kind === "text" && n.output.text);
      } else {
        n.waitReady = !!n.waitReady;
      }
      n.output = null;
      n.running = false;
    }
    if (n.kind === "timer") {
      normalizeTimerNode(n);
      n.output = null;
      n.running = !!n.timerArmed;
      if (n.timerArmed) {
        n.timerNextAt = computeTimerNextAt(n, Date.now()) || n.timerNextAt;
        refreshTimerStatus(n);
      }
    }
    if (n.kind === "delayer") {
      normalizeDelayerNode(n);
      n.output = null;
      n.running = false;
    }
    if (n.kind === "sequencer") {
      normalizeSequencerNode(n);
      n.output = null;
      n.running = false;
    }
    if (n.kind === "gate") {
      normalizeGateNode(n);
      n.output = null;
      n.running = false;
    }
    if (n.kind === "splitter") {
      normalizeSplitterNode(n);
      n.output = null;
      n.running = false;
    }
    if (n.kind === "counter") {
      normalizeCounterNode(n);
      n.output = null;
      n.running = false;
    }
    if (n.kind === "mutex") {
      normalizeMutexNode(n);
      n.output = null;
      n.running = false;
    }
    if (n.kind === "music_gen") {
      const d = Math.round(Number(n.audioDuration) || 60);
      n.audioDuration = Math.max(10, Math.min(150, isFinite(d) ? d : 60));
    }
  }
  /* 移除音乐/视频配对保存节点，并把旧保存路径迁入节点 outputPath */
  detachBoundMediaSaves(wf);
  for (const n of wf.nodes) {
    if (!isMediaGenNode(n)) continue;
    if (/^output$/i.test(String(n.outputPath || "").trim()) && !String(n.filename || "").trim())
      n.outputPath = "";
    n.boundSaveId = "";
  }
  /* 修复音乐节点固定端子 toIndex 被压缩错位（P=0 / L=1） */
  {
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));
    const isCtrl = (id) => isControlKind(byId.get(id));
    for (const n of wf.nodes) {
      if (n.kind !== "music_gen") continue;
      const dataWs = (wf.wires || []).filter(
        (w) => w.to === n.id && !isCtrl(w.from),
      );
      if (dataWs.length < 1) continue;
      const idxs = dataWs.map((w) => Number(w.toIndex));
      const uniq = new Set(idxs.filter((i) => i === 0 || i === 1));
      if (uniq.size === dataWs.length && dataWs.length <= 2) continue;
      dataWs
        .slice()
        .sort((a, b) => Number(a.toIndex) - Number(b.toIndex) || String(a.id).localeCompare(String(b.id)))
        .forEach((w, i) => {
          w.toIndex = Math.min(i, 1);
        });
    }
  }
  /* 视频节点控制输入端子固定为端口0（不随数据槽数变化）。
     旧布局（无 videoPortV2 标记）= 端口0=提示词 + 数据槽 + 末尾动态控制槽；
     新布局 = 端口0=控制 + 端口1=提示词 + 数据槽。
     旧档迁移：数据线全部 +1（提示词 0→1），控制线迁到端口0，并打标防止重复迁移。 */
  let videoPortMigrated = false;
  {
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));
    const isCtrl = (id) => isControlKind(byId.get(id));
    for (const n of wf.nodes) {
      if (n.kind !== "video_gen") continue;
      if (n.videoPortV2) continue; /* 已是新布局 */
      n.videoPortV2 = true;
      videoPortMigrated = true;
      const dataWs = (wf.wires || []).filter((w) => w.to === n.id && !isCtrl(w.from));
      const ctrlWs = (wf.wires || []).filter((w) => w.to === n.id && isCtrl(w.from));
      /* 数据线整体后移一位（端口0 让给控制） */
      for (const w of dataWs) {
        const ti = Number(w.toIndex);
        w.toIndex = ti + 1;
      }
      /* 控制线统一落到端口0 */
      for (const w of ctrlWs) w.toIndex = 0;
      /* 删除旧字段 */
      delete n.videoCtrlPort;
    }
  }
  {
    const ids = new Set(wf.nodes.map((n) => n.id));
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));
    for (const n of wf.nodes) {
      if (n.parentTaskId && !ids.has(n.parentTaskId)) n.parentTaskId = "";
    }
    /* 孤儿超级节点引用自愈：父级不存在或不是超级节点时清空，
       避免节点挂到幽灵父级后从层级视图 / 左侧栏中消失（历史数据损坏的降级：
       节点回到顶层画布，至少可见可操作，不再整体消失）。
       工具节点＝超级节点变体（super + tool:true）：其子节点 parentSuperId 天然合法。 */
    for (const n of wf.nodes) {
      const host = n.parentSuperId ? byId.get(n.parentSuperId) : null;
      if (n.parentSuperId && (!host || !isSuperLikeNode(host))) n.parentSuperId = "";
    }
    for (const n of wf.nodes) {
      if (n.kind === "task") ensureTaskScaffold(n, wf);
    }
    for (const w of wf.wires || []) {
      if (w.fromIndex == null || !isFinite(Number(w.fromIndex))) w.fromIndex = 0;
    }
    /* 任务节点仅控制信号：去掉内容入线；输出 fromIndex 钳制为成功(0)/失败(1) */
    {
      const byId2 = new Map(wf.nodes.map((n) => [n.id, n]));
      wf.wires = (wf.wires || []).filter((w) => {
        if (w.rel) return true; /* 关系线：仅表达关系，不受数据流规则裁剪 */
        const to = byId2.get(w.to);
        const from = byId2.get(w.from);
        if (!to || !from) return false;
        if (to.kind === "task" && !isControlKind(from)) return false;
        if (from.kind === "task") {
          const fi = Number(w.fromIndex || 0);
          w.fromIndex = fi === 1 ? 1 : 0;
        }
        return true;
      });
    }
    for (const m of wf.marks || []) {
      if (typeof m.parentTaskId !== "string") m.parentTaskId = "";
      if (m.parentTaskId && !ids.has(m.parentTaskId)) m.parentTaskId = "";
      if (typeof m.parentSuperId !== "string") m.parentSuperId = "";
      const mhost = m.parentSuperId ? byId.get(m.parentSuperId) : null;
      if (m.parentSuperId && (!mhost || mhost.kind !== "super")) m.parentSuperId = "";
    }
  }
  /* 需求等待 / 起点无输入端子：去掉指向它们的旧连线；终点无输出端子 */
  {
    const noIn = new Set(
      wf.nodes
        .filter(
          (n) =>
            n.kind === "wait_file" || n.kind === "timer" || isExecStart(n),
        )
        .map((n) => n.id),
    );
    const noOut = new Set(wf.nodes.filter(isExecEnd).map((n) => n.id));
    if (noIn.size || noOut.size)
      wf.wires = wf.wires.filter(
        (w) => w.rel || (!noIn.has(w.to) && !noOut.has(w.from)),
      );
  }
  /* 清理组：移除指向不存在节点的引用，空组删除 */
  for (const g of wf.groups) {
    if (!Array.isArray(g.nodeIds)) g.nodeIds = [];
    if (!Array.isArray(g.markIds)) g.markIds = [];
    g.nodeIds = g.nodeIds.filter((id) => wf.nodes.some((n) => n.id === id));
    g.markIds = g.markIds.filter((id) =>
      (wf.marks || []).some((m) => m.id === id),
    );
    g.title = g.title || I18n.t("组");
  }
  wf.groups = wf.groups.filter(
    (g) => (g.nodeIds && g.nodeIds.length) || (g.markIds && g.markIds.length),
  );
  return videoPortMigrated; /* true = 发生了视频端口迁移，调用方应立即落盘 */
}

async function ensureWorkflow() {
  /* 切画布前先收掉设置窗：skipSave —— 这张画布即将 flush / 或已不属于前台，
     再 persist 一次可能把刚删掉的画布写回磁盘。 */
  closeNodeSettingsDialog({ silentRerender: true, skipSave: true });
  closeBgRmPop();
  clearHistory();
  const list = await window.api.wfList();
  let id = S.config.activeWorkflowId;
  if (!list.some((w) => w.id === id)) id = "default";
  if (!list.some((w) => w.id === id)) id = list.length ? list[0].id : null;
  if (!id) {
    id = "default";
    S.wf = { id, name: I18n.t("默认画布"), nodes: [], wires: [], groups: [], marks: [] };
    reviveWf(id); /* 新建的是一张全新画布：允许落盘（旧同名对象仍有墓碑拦着） */
    await window.api.wfSave(id, S.wf);
  } else {
    const r = await window.api.wfLoad(id);
    S.wf = r.ok ? r.data : { id, name: id, nodes: [], wires: [], groups: [], marks: [] };
  }
  S.wf.id = id;
  setForegroundWf(S.wf); /* 用户可见的画布切换：登记前台真源 */
  if (migrateWf(S.wf)) scheduleSave(true); /* 视频端口迁移：立即落盘打标 */
  resetTaskFocus();
  rememberWf(S.wf);
  S.config.activeWorkflowId = id;
  await sanitizeWfEnvironment({ quiet: false });
  await window.api.configSave(S.config);
  trackWorkflow(id, S.wf.name);
}

async function loadWorkflow(id, opts) {
  const skipFlush = !!(opts && opts.skipFlush);
  if (S.wf && S.wf.id === id) return;
  /* 切画布前先收掉设置窗：设置都是即时写回的，skipSave 只跳过关窗那一下多余落盘
     （紧接着就要 flush，skipFlush 时这张画布甚至已被删除，persist 会把它复活）。 */
  closeNodeSettingsDialog({ silentRerender: true, skipSave: true });
  /* 先落盘当前画布；若有运行中节点则保留内存对象，避免任务结果/会话丢失。
     skipFlush=true：切换前这张画布已被删除（删除后的落点切换），此时任何写盘
     都会把刚删掉的画布凭空复活，绝不能 rememberWf / flushCurrentWf。 */
  if (S.wf && !skipFlush) {
    rememberWf(S.wf);
    await flushCurrentWf();
  }
  closeBgRmPop();
  clearHistory();
  let wf = null;
  /* 袋里那份能不能顶掉磁盘副本：两种情况必须复用内存对象，否则整份读盘覆盖 =
     丢掉内存里已经写进去的改动，而且用户下一次编辑落盘会把这些改动彻底冲没。
     ① 该画布有节点在跑 / 在排队（老判据：换对象会把在飞运行变成看不见、停不掉的幽灵）；
     ② 该画布正被某条在飞会话轮当「所属画布」绑着写（本轮需求：用户切去别的画布干活是常态，
        会话在后台往自己那张图写节点；此刻切回来必须看到 agent 刚写的那份，
        而不是开轮之前的旧副本 —— 旧副本一旦成为前台，随后的保存就把它盖回磁盘）。 */
  const bagWf = S.wfBag[id];
  if (bagWf && (wfHasRunning(bagWf) || wfInCanvasRun(id))) {
    wf = bagWf;
  } else {
    const r = await window.api.wfLoad(id);
    if (!r.ok) {
      toast(I18n.t("打开失败：") + r.error, "err");
      return;
    }
    /* 磁盘上确实读得出这张画布 = 它是活的（例如删除后又新建了同名 id），解禁黑名单 */
    reviveWf(id);
    wf = r.data;
    wf.id = id;
    if (migrateWf(wf)) S._pendingVideoPortMigrateSave = true;
    /* 若袋中仍有该画布的运行中节点（极少：id 冲突），合并回写 */
    const live = S.wfBag[id];
    if (live && wfHasRunning(live)) {
      const byId = new Map((wf.nodes || []).map((n) => [n.id, n]));
      for (const n of live.nodes || []) {
        if (
          n.running ||
          (S.nodeWfId && S.nodeWfId[n.id] === id) ||
          (typeof computeExecNodeActive === "function" &&
            computeExecNodeActive(n))
        )
          byId.set(n.id, n);
      }
      wf.nodes = [...byId.values()];
      wf.wires = live.wires || wf.wires;
      wf.groups = live.groups || wf.groups;
    }
  }
  setForegroundWf(wf); /* 用户可见的画布切换：_fgWf 与 S.wf 同步换 */
  rememberWf(wf);
  resetTaskFocus();
  if (S._pendingVideoPortMigrateSave) {
    S._pendingVideoPortMigrateSave = false;
    scheduleSave(true); /* 视频端口迁移：立即落盘打标 */
  }
  if (S.findBar && S.findBar.open) canvasFindRefresh({ keepIdx: false, focus: false });
  S.config.activeWorkflowId = id;
  await sanitizeWfEnvironment({ quiet: false });
  await window.api.configSave(S.config);
  renderAll();
  /* 切换到该画布：其中的接收节点（监听模式）自动进入监听状态 */
  autoListenNetRecvNodes(true).catch(() => {});
  trackWorkflow(id, S.wf.name);
  try { restoreMediaGenLocks(); } catch {}
  try { ensureMediaBackendProbesForWorkflow({ reset: true }); } catch {}
  toast(I18n.t("已打开画布：") + (S.wf.name || id), "ok");
}

/* ── 画布 Tab 条(Edge 风格):下拉选中或新建画布时加入标签页 ── */
function trackWorkflow(id, name) {
  const list = S.config.visitedWorkflows || (S.config.visitedWorkflows = []);
  const ex = list.find((w) => w.id === id);
  if (ex) ex.name = name || ex.name;
  else list.push({ id, name: name || id });
  if (list.length > 12) list.splice(0, list.length - 12);
  renderWfTabs();
}
function renderWfTabs() {
  const bar = $("#wfTabs");
  if (!bar) return;
  const list = S.config.visitedWorkflows || [];
  const cur = S.wf ? S.wf.id : null;
  bar.innerHTML = "";
  for (const w of list) {
    const tab = document.createElement("div");
    tab.className = "wf-tab" + (w.id === cur ? " active" : "");
    tab.title = I18n.t("切换到画布：") + w.name;
    const nm = document.createElement("span");
    nm.className = "wf-tab-name";
    nm.textContent = w.name || w.id;
    tab.appendChild(nm);
    const x = document.createElement("button");
    x.className = "wf-tab-close";
    x.textContent = "×";
    x.title = I18n.t("关闭标签（仅从标签条移除，不删除画布）");
    x.onclick = async (ev) => {
      ev.stopPropagation();
      const i = list.findIndex((t) => t.id === w.id);
      if (i >= 0) list.splice(i, 1);
      await window.api.configSave(S.config);
      renderWfTabs();
    };
    tab.appendChild(x);
    tab.onclick = () => {
      if (w.id !== cur) loadWorkflow(w.id);
    };
    bar.appendChild(tab);
  }
}

/* 顶栏工作流下拉：与 Tab 条并存,选中即切换并加入标签 */
async function refreshWfSelect() {
  const sel = $("#wfSelect");
  if (!sel) return;
  const list = await window.api.wfList();
  sel.innerHTML = "";
  for (const w of list) {
    const o = document.createElement("option");
    o.value = w.id;
    o.textContent = w.name + "（" + w.nodes + I18n.t(" 节点）");
    sel.appendChild(o);
  }
  /* 选中的那一项必须是「用户正看着的画布」：后台换画布编辑（runAgainstWf）在飞时
     S.wf 是别人的画布，直接拿它当值会把下拉框 / 标签高亮跳到用户没在看的那一张。 */
  const shown = (typeof currentVisibleWf === "function" ? currentVisibleWf() : null) || S.wf;
  sel.value = shown ? shown.id : "";
  sel.title = I18n.t("打开画布（共 ") + list.length + I18n.t(" 个，切换即加载并加入标签）");
  renderWfTabs();
}

/* 工作流级统一工作目录：设置后本画布所有智能节点固定为该目录(只读) */
function renderWfWorkspace() {
  const box = $("#wfWsBox");
  if (!box) return;
  box.innerHTML = "";
  const lab = document.createElement("span");
  lab.className = "wf-ws-label";
  lab.textContent = I18n.t("工作目录");
  lab.title = I18n.t("设置后,本画布智能节点与保存节点的相对路径都相对该目录;改目录即可统一切换落盘位置;留空则各节点单独设置");
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = wfWorkspace();
  inp.placeholder = I18n.t("统一目录(留空 = 各节点单独设置)…");
  inp.addEventListener("change", async () => {
    if (!S.wf) return;
    const v = inp.value.trim();
    if (v && !(await pathIsExistingDir(v))) {
      S.wf.workspace = "";
      scheduleSave(true);
      renderWfWorkspace();
      renderCanvas();
      await showInfoOverlay(
        I18n.t("工作目录无效"),
        I18n.t(
          "该路径不存在或不是有效文件夹，已自动清空。请重新选择有效的工作目录。",
        ),
        v,
      );
      syncAssistWorkspaceChrome();
      return;
    }
    S.wf.workspace = v;
    scheduleSave(true);
    renderCanvas();
    renderWfWorkspace();
    syncAssistWorkspaceChrome();
  });
  const br = workspaceBrowseButton(inp, (p) => {
    if (!S.wf) return;
    S.wf.workspace = p;
    scheduleSave(true);
    renderCanvas();
    renderWfWorkspace();
    syncAssistWorkspaceChrome();
  });
  const openBtn = workspaceOpenButton(() => inp.value || wfWorkspace());
  const cl = document.createElement("button");
  cl.className = "mini btn-sq";
  cl.textContent = "×";
  cl.title = I18n.t("清除统一目录,恢复各节点单独设置");
  cl.onclick = () => {
    if (!S.wf) return;
    S.wf.workspace = "";
    scheduleSave(true);
    renderCanvas();
    renderWfWorkspace();
    syncAssistWorkspaceChrome();
  };
  box.appendChild(lab);
  box.appendChild(inp);
  box.appendChild(openBtn);
  box.appendChild(br);
  box.appendChild(cl);
}

function renameWorkflowDialog() {
  const wf = S.wf;
  if (!wf) return;
  openOverlay(I18n.t("更改画布名称"), { persistent: true });
  /* 点击外框不关闭，仅「取消 / 保存」关闭 */
  const body = $("#ovBody");
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("画布名称")));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = wf.name || "";
  lab.appendChild(inp);
  body.appendChild(lab);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("保存");
  ok.onclick = async () => {
    wf.name = inp.value.trim() || wf.name;
    closeOverlay();
    scheduleSave(true);
    renderTop();
    trackWorkflow(wf.id, wf.name);
    toast(I18n.t("画布已重命名：") + wf.name, "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
}

/* 上下文分布弹窗(参考 dsh 的 token 计量展开) */
function openMetricsDistribution(metrics) {
  if (!metrics) return;
  openOverlay(I18n.t("上下文分布 · 最近一次智能运行"));
  const body = $("#ovBody");
  const rows = [
    [I18n.t("轮数 / 步数"), (metrics.turns || 0) + I18n.t(" 轮 · ") + (metrics.steps || 0) + I18n.t(" 步")],
    [I18n.t("LLM 用时"), fmtDur(metrics.llmMs)],
    [I18n.t("工具调用"), fmtDur(metrics.toolMs) + " · " + (metrics.tools ? metrics.tools.length : 0) + I18n.t(" 次")],
    [I18n.t("首 token 平均"), metrics.firstTokenAvgMs > 0 ? (metrics.firstTokenAvgMs / 1000).toFixed(1) + "s" : "—"],
    [I18n.t("生成速度"), Math.round(metrics.tokPerSec || 0) + " tok/s"],
    [I18n.t("输入 token"), fmtTok(metrics.inputTokens)],
    [I18n.t("缓存读入"), fmtTok(metrics.cacheReadTokens || 0)],
    [I18n.t("缓存写入"), fmtTok(metrics.cacheWriteTokens || 0)],
    [I18n.t("输出 token"), fmtTok(metrics.outputTokens)],
    [I18n.t("推理 token"), fmtTok(metrics.reasoningTokens)],
    [I18n.t("缓存命中"), Math.round(metrics.cacheHitPct || 0) + "%"],
    [I18n.t("墙钟用时"), fmtDurLong(metrics.wallMs || 0)],
    [I18n.t("上下文窗口"), metrics.contextWindow > 0 ? fmtTok(metrics.contextWindow) + " tok" : "—"],
    [I18n.t("子代理"), String(metrics.subagents || 0)],
    [I18n.t("后台任务"), String(metrics.jobs || 0)],
  ];
  const table = document.createElement("table");
  table.className = "dsh-metrics-table";
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = k;
    const td2 = document.createElement("td");
    td2.textContent = v;
    tr.appendChild(td1);
    tr.appendChild(td2);
    table.appendChild(tr);
  }
  body.appendChild(table);
  /* 本次运行的逐模型台账（模型不同，单价与缓存表现完全不同） */
  if (Array.isArray(metrics.models) && metrics.models.length) {
    const t = document.createElement("div");
    t.className = "settings-sec-title";
    t.style.marginTop = "8px";
    t.textContent = I18n.t("按模型（本次运行）");
    body.appendChild(t);
    const mt = document.createElement("table");
    mt.className = "tok-badge-table metrics-model-table";
    const head = document.createElement("tr");
    for (const h of [
      I18n.t("模型 / 服务商"),
      I18n.t("计费输入"),
      I18n.t("缓存读"),
      I18n.t("命中"),
      I18n.t("输出"),
      I18n.t("推理"),
      I18n.t("调用"),
      "LLM",
      I18n.t("工具"),
    ]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    mt.appendChild(head);
    for (const b of metrics.models) {
      const billed =
        (b.inputTokens || 0) + (b.cacheReadTokens || 0) + (b.cacheWriteTokens || 0);
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = b.model || "?";
      const prov = document.createElement("span");
      prov.className = "tok-badge-prov";
      prov.textContent = b.provider || "";
      name.appendChild(prov);
      tr.appendChild(name);
      const cells = [
        fmtTok(billed),
        fmtTok(b.cacheReadTokens || 0),
        Math.round(billed > 0 ? ((b.cacheReadTokens || 0) / billed) * 100 : 0) + "%",
        fmtTok(b.outputTokens || 0),
        fmtTok(b.reasoningTokens || 0),
        String(b.calls || 0),
        fmtDurLong(b.llmMs || 0),
        fmtDurLong(b.toolMs || 0),
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      mt.appendChild(tr);
    }
    body.appendChild(mt);
  }
  if (metrics.tools && metrics.tools.length) {
    const t = document.createElement("div");
    t.className = "settings-sec-title";
    t.style.marginTop = "8px";
    t.textContent = I18n.t("工具调用轨迹");
    body.appendChild(t);
    const ul = document.createElement("div");
    ul.className = "dsh-trace-list";
    for (const x of metrics.tools) {
      const row = document.createElement("div");
      row.className = "dsh-trace-row";
      row.textContent = "🔧 " + x.name + (x.at ? " · " + fmtTime(x.at) : "");
      ul.appendChild(row);
    }
    body.appendChild(ul);
  }
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("关闭");
  ok.onclick = closeOverlay;
  foot.appendChild(ok);
}

/* 会话分支(参考 dsh fork):复制当前会话为新会话(fork) */
async function forkAgentSession(id) {
  const list = agentSessions();
  const src = list.find((s) => s.id === id);
  if (!src) return;
  /* 防串线:运行中的会话不允许分支(避免复制到一半的运行状态) */
  if (sessionIsRunning(src)) {
    toast(I18n.t("运行中的会话不能分支，请等待完成或先终止"), "warn");
    return;
  }
  /* 防误操作:分支前确认(分支是复制操作,不破坏原会话) */
  if (
    !(await confirmDialog(
      I18n.t("分支会话「") + (src.title || I18n.t("新会话")) + I18n.t("」？\n\n将复制该会话的全部消息与设置到新会话，原会话保持不变。"),
      { title: I18n.t("分支会话"), okText: I18n.t("分支") },
    ))
  )
    return;
  /* 深拷贝消息(含工具日志):fork 与原会话不共享任何数组,互不串线 */
  const cloneMsgs = (msgs) =>
    (msgs || []).map((m) => {
      const o = Object.assign({}, m);
      if (Array.isArray(m.tools))
        o.tools = m.tools.map((t) => Object.assign({}, t));
      return o;
    });
  const copy = {
    id: uid("as"),
    title: (src.title || I18n.t("新会话")) + I18n.t(" · 分支"),
    workspace: src.workspace || "",
    /* 分支继承源会话的所属画布（源没有就按当前画布补绑），不改判到别的图 */
    canvasWfId: src.canvasWfId || currentVisibleWfId(),
    preset: src.preset || AGENT_PRESET_DEFAULT,
    provider: src.provider || "deepseek-official",
    model: src.model || "",
    effort: src.effort || "high",
    pure: !!src.pure,
    messages: cloneMsgs(src.messages),
    planNext: !!src.planNext,
    forkedFrom: src.id,
    archived: false,
    updatedAt: Date.now(),
  };
  /* 插入到同「项目文件夹」分组的顶部,而不是全局最前:
     避免分支后该会话所属文件夹在侧边栏的排序被整体挪动 */
  const gKey = wsGroupOf(src.workspace);
  let gIdx = list.findIndex((x) => !x.archived && wsGroupOf(x.workspace) === gKey);
  if (gIdx < 0) gIdx = list.findIndex((x) => !x.archived);
  if (gIdx < 0) gIdx = 0;
  list.splice(gIdx, 0, copy);
  S.agentActiveId = copy.id;
  await persistAgentSession();
  renderAgentSessionSidebar();
  renderAgentSession();
  toast(I18n.t("已分支新会话：") + copy.title, "ok");
}

/* 智能任务节点 ↔ 智能会话 双向内容同步。
   remotion 节点复用同一会话绑定（💬 查看过程/编辑迭代）：无 task/messages 字段，
   下方 node-task 同步与多轮历史同步对其自动跳过（空值短路），agent_task 行为不变。 */
function ensureAgentSessionForNode(node) {
  if (!node || (node.kind !== "agent_task" && node.kind !== "remotion")) return null;
  const list = agentSessions();
  let sess = list.find((s) => s.id === node.agentSessionId);
  if (!sess) {
    sess = {
      id: uid("as"),
      title: node.title || I18n.t("智能任务"),
      workspace: node.workspace || dshWorkspaceOf(node),
      /* 节点绑定会话：所属画布 = 该节点所在的画布 */
      canvasWfId: canvasWfIdForNode(node),
      preset: node.preset || AGENT_PRESET_DEFAULT,
      provider: node.provider || "deepseek-official",
      model: node.model || "",
      effort: node.effort || "high",
      messages: [],
      archived: false,
      updatedAt: Date.now(),
    };
    node.agentSessionId = sess.id;
    list.unshift(sess);
  } else {
    /* 节点参数优先:展开时把节点上的预设/供应商/模型/强度/标题同步到会话 */
    sess.preset = node.preset || sess.preset || AGENT_PRESET_DEFAULT;
    sess.provider = node.provider || sess.provider || "deepseek-official";
    sess.model = node.model || sess.model || "";
    sess.effort = node.effort || sess.effort || "high";
    if (node.workspace) sess.workspace = node.workspace;
    if (node.title) sess.title = node.title;
  }
  /* 节点内容 → 会话(任务描述);任务消息带 _src 标记,之后节点任务文本修改会同步更新该条消息 */
  if (String(node.task || "").trim()) {
    const marked = sess.messages.find((m) => m._src === "node-task");
    if (marked) {
      if (marked.content !== node.task) marked.content = node.task;
    } else {
      sess.messages.unshift({
        role: "user",
        content: node.task,
        _src: "node-task",
        at: Number(sess.createdAt || sess.updatedAt) || Date.now(),
      });
    }
  }
  /* 多轮会话历史同步进会话（去重追加，保持节点与会话一致） */
  for (const m of node.messages || []) {
    const has = sess.messages.some(
      (x) => x.role === m.role && x.content === m.content,
    );
    if (!has) {
      const copy = { role: m.role, content: m.content };
      if (m.reasoning) copy.reasoning = m.reasoning;
      if (Array.isArray(m.tools) && m.tools.length)
        copy.tools = m.tools.map((t) => Object.assign({}, t));
      sess.messages.push(copy);
    } else {
      const ex = sess.messages.find(
        (x) => x.role === m.role && x.content === m.content,
      );
      if (ex && m.role === "assistant") {
        if (m.reasoning && !ex.reasoning) ex.reasoning = m.reasoning;
        if (Array.isArray(m.tools) && m.tools.length && !(ex.tools && ex.tools.length))
          ex.tools = m.tools.map((t) => Object.assign({}, t));
      }
    }
  }
  return sess;
}
/* ============ 开发节点（dev super）：项目功能块 · 绑定开发会话 ============ */
/* 项目根路径：自身 devPath 优先，否则向上找最近的开发节点祖先 */
function devPathOf(node) {
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 64) {
    const p = String(cur.devPath || "").trim();
    if (p) return p;
    cur = cur.parentSuperId ? nodeById(cur.parentSuperId) : null;
  }
  return "";
}
/* ── 同一套「就近继承」逻辑的指定画布版 ──
   会话在自己所属的后台画布上跑时，解析项目根不能再看前台 S.wf（那会把用户此刻开着的
   另一张图的目录当成本轮工作区）。取父节点同理：给了 wf 就在该画布节点表里找。
   不传 wf 的调用点逐字走上面的老路（nodeById = 前台口径），零回归。 */
function devParentOf(node, wf) {
  if (!node || !node.parentSuperId) return null;
  if (wf && Array.isArray(wf.nodes))
    return wf.nodes.find((n) => n && n.id === node.parentSuperId) || null;
  return nodeById(node.parentSuperId);
}
function devPathOfIn(node, wf) {
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 64) {
    const p = String(cur.devPath || "").trim();
    if (p) return p;
    cur = cur.parentSuperId ? devParentOf(cur, wf) : null;
  }
  return "";
}
/* 开发节点块判定（单一真源）：super + dev:true，数据库超级节点（db:true）不算。
   devProjectRootOf 与「核心文件列表」（app-devnode.js 的 devCoreFilesOf）共用此口径。 */
function devIsDevBlock(node) {
  return !!(node && node.kind === "super" && node.dev && !node.db);
}
/* 顶层开发块 = 项目节点：祖先链上再没有别的开发块（父级是普通超级节点仍算顶层）。
   走链思路与 app-devnode.js 的 devAncestorChain 一致，这里只做存在性判定；
   「核心文件列表最外层不列举」也用它，两处永不分叉。 */
function devIsTopBlock(node, wf) {
  if (!devIsDevBlock(node)) return false;
  let cur = node.parentSuperId ? devParentOf(node, wf) : null;
  let guard = 0;
  while (cur && guard++ < 64) {
    if (devIsDevBlock(cur)) return false;
    cur = cur.parentSuperId ? devParentOf(cur, wf) : null;
  }
  return true;
}
/* 画布项目根（单一真源）：扫描画布上的开发节点块（kind super + dev:true），就近解析
   devPath（含祖先继承），优先顶层块（devPath 约定设在顶层块、子块继承）；空值与相对路径忽略。
   多块解析出多个不同根时：若存在共同祖先目录就用祖先（一个根覆盖全部），
   否则取文档序第一个，并置 S.devProjectRootAmbiguous = true 供 UI 提示。
   歧义标记在每次调用本函数时刷新（无开发块 / 单根时为 false），UI 读取前先调用一次。
   本结果由 dshWorkspaceOf 并入工作区解析优先级（app.js / app-agent.js 两份逐字同步）。
   可选 wf = 按「那张画布」解析（会话所属画布不是前台时用，见 dshWorkspaceOfWf）；
   只解析非前台画布时不碰 S.devProjectRootAmbiguous —— 那是界面提示前台画布用的。 */
function devProjectRootOf(wf) {
  const canvas = wf || S.wf;
  const live = !wf || wf === S.wf;
  if (live) S.devProjectRootAmbiguous = false;
  if (!canvas) return "";
  const clean = (raw) => String(raw || "").trim().replace(/[\\/]+$/, "");
  const fwd = (p) => {
    const s = String(p).replace(/\\/g, "/");
    return s.startsWith("//")
      ? "//" + s.slice(2).replace(/\/{2,}/g, "/")
      : s.replace(/\/{2,}/g, "/");
  };
  /* 比较键：Windows 盘符路径忽略大小写，POSIX 路径区分大小写 */
  const keyOf = (p) => {
    const t = fwd(p);
    return /^[a-zA-Z]:/.test(t) ? t.toLowerCase() : t;
  };
  /* 判定统一走共用函数 devIsDevBlock / devIsTopBlock（与本函数同一节，切片可独立运行） */
  const isDevBlock = devIsDevBlock;
  const isTopDevBlock = (n) => devIsTopBlock(n, canvas);
  const devBlocks = (canvas.nodes || []).filter(isDevBlock);
  if (!devBlocks.length) return "";
  const rootsIn = (list) => {
    const out = [];
    const seen = new Set();
    for (const n of list) {
      const p = clean(devPathOfIn(n, canvas));
      if (!p || !isAbsPath(p)) continue;
      const k = keyOf(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out;
  };
  let roots = rootsIn(devBlocks.filter(isTopDevBlock));
  if (!roots.length) roots = rootsIn(devBlocks);
  if (!roots.length) return "";
  if (roots.length === 1) return roots[0];
  /* 共同祖先：拆成「锚点（盘符 / UNC 共享 / 文件系统根）+ 段」逐段比对，
     只剩锚点本身（如 E: / ）不算有意义的共同祖先，交给调用方标歧义 */
  const split = (p) => {
    const t = fwd(p);
    const m = /^(\/\/[^/]+\/[^/]+|[a-zA-Z]:|\/)/.exec(t);
    const anchor = m ? m[1] : "";
    if (!anchor) return null;
    return { anchor, segs: t.slice(anchor.length).split("/").filter(Boolean) };
  };
  const parts = roots.map(split);
  let common = "";
  if (parts.every((x) => !!x)) {
    const win = /^[a-zA-Z]:/.test(parts[0].anchor);
    const sameAnchor = parts.every(
      (x) =>
        win === /^[a-zA-Z]:/.test(x.anchor) &&
        (win ? x.anchor.toLowerCase() === parts[0].anchor.toLowerCase() : x.anchor === parts[0].anchor),
    );
    if (sameAnchor) {
      const eq = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
      let i = 0;
      while (i < parts[0].segs.length && parts.every((x) => x.segs[i] !== undefined && eq(x.segs[i], parts[0].segs[i]))) i++;
      if (i) {
        const head = parts[0].anchor === "/" ? "" : parts[0].anchor;
        common = head + "/" + parts[0].segs.slice(0, i).join("/");
        if (roots[0].includes("\\")) common = common.replace(/\//g, "\\");
      }
    }
  }
  if (common) return common;
  if (live) S.devProjectRootAmbiguous = true;
  return roots[0];
}
/* 开发任务书：节点概述 + 项目根 + 上层模块 + 本次开发需求（注入会话的契约消息） */
function devNodeContractText(node, req) {
  const lines = [];
  const dk = devKindOf(node) || "module";
  lines.push(
    I18n.t("【开发任务书】") +
      " " +
      (node.title || I18n.t("未命名模块")) +
      "（" +
      I18n.t(DEV_KIND_LABEL[dk] || "模块") +
      "）",
  );
  const noteParts = devNoteParts(node && node.note);
  lines.push(
    I18n.t("模块功能（面向非技术）：") +
      (noteParts.design || I18n.t("（暂无 · 请先说明该模块在业务上做什么、给谁用）")),
  );
  lines.push(
    I18n.t("实现要点（面向技术）：") +
      (noteParts.impl || I18n.t("（暂无 · 细化或开发时按两段式规范补全）")),
  );
  const reqText = String(req === undefined || req === null ? "" : req).trim();
  if (reqText) lines.push(I18n.t("本次开发需求：") + reqText);
  /* 「先拷问需求」开关（node.devGrill · 开发对话框 toggle）：开启时在需求行之后、
     默认回写要求之前多插一段拷问契约。任务书每轮随系统提示注入（sess._devContract），
     所以追问轮次同样受约束；关闭时任务书逐字不变（零回归）。 */
  if (node && node.devGrill === true) {
    lines.push(
      I18n.t(
        "【拷问模式·本轮先问不做】该功能块已开启「先拷问需求」：请先用 skill 工具加载内置技能 mtnode-grill-me 并严格照它执行——把本次需求映射成决策树，每轮用 ask_user_question 工具跳出 MTNode 询问窗，一次把整个前沿的全部问题问完（题面写进 question、候选写进 options、推荐项放第一位并在 label 末尾标「（推荐）」、理由写 description）；禁止把问题编号列在回复正文里、让用户在输入框作答；需要事实就自己用只读工具去查、不要拿环境问题问用户；本轮不得修改任何文件、不得改画布、不得回写 note / devStatus / devFiles、不得出实施计划、不得开工，答案回来后据此重算前沿继续下一轮，直到前沿为空、并用最后一次询问窗得到用户明确「确认无歧义」后才开始实施，实施收尾再按本任务书回写概述（note）、状态（devStatus）与本模块核心文件列表（devFiles）。",
      ),
    );
  }
  const p = devPathOf(node);
  if (p) lines.push(I18n.t("项目根目录：") + p);
  if (p)
    lines.push(
      I18n.t(
        "项目根目录若有 AGENTS.md（Agent 共识文件），请先读并遵守其中的「目录约定」与「不要修改」清单；新文件按约定放置，清单内路径一律不要改动。",
      ),
    );
  const parent = node.parentSuperId ? nodeById(node.parentSuperId) : null;
  if (parent && parent.dev) {
    lines.push(
      I18n.t("所属上层模块：") +
        (parent.title || "") +
        (String(parent.note || "").trim()
          ? "（" + String(parent.note).trim() + "）"
          : ""),
    );
  }
  const kids = devChildrenOf(node);
  if (kids.length) {
    lines.push(I18n.t("本模块已有子元素："));
    for (const k of kids.slice(0, 40)) {
      lines.push(
        "  - " +
          (k.title || k.id) +
          "（" +
          I18n.t(DEV_KIND_LABEL[devKindOf(k) || "module"] || "模块") +
          "）" +
          (String(k.note || "").trim() ? "：" + String(k.note).trim() : ""),
      );
    }
  }
  lines.push(
    I18n.t(
      "本会话由该功能块的「开发 / 细化」对话框新建，只负责该模块；请以项目根目录内的真实代码为准，不要臆测。",
    ),
  );
  lines.push(
    I18n.t(
      "完成后按两段式规范（【功能】非技术说明 + 【实现】工程梗概）回写该开发节点的概述（note），并更新状态（devStatus），同时用 mtnode_canvas_edit 的 devFiles 补丁回写本模块的核心文件列表（最多 10 条 · 每项是相对项目根的文件路径 · 最外层项目节点不填），用一句话向用户汇报改了什么。",
    ),
  );
  lines.push(
    I18n.t(
      "本会话是代码开发工作：不要调用 mtnode-dev-architect 技能（该技能仅用于在 MTNode 画布上构建开发节点架构，开发 / 细化绑定会话不需要它）。",
    ),
  );
  lines.push(
    I18n.t(
      "本次开发需求已在任务书中一次性完整给出：请按此执行，不要分两次会话输入重复提交（重复输入会造成上下文割裂与重复开工）。",
    ),
  );
  return lines.join("\n");
}
/* 该功能块名下的会话（细化 / 开发历史 + 最近绑定） */
function devSessionIdsOf(node) {
  const out = [];
  if (!node) return out;
  const arr = Array.isArray(node.devSessionIds) ? node.devSessionIds : [];
  for (const id of arr) if (id && out.indexOf(id) < 0) out.push(id);
  if (node.agentSessionId && out.indexOf(node.agentSessionId) < 0)
    out.push(node.agentSessionId);
  return out;
}
function devSessionsOf(node) {
  const ids = devSessionIdsOf(node);
  return agentSessions()
    .filter((s) => ids.indexOf(s.id) >= 0)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}
/* 计划只属于发起它的那个会话：新建「开发 / 细化」绑定会话一律从干净上下文开始，
   不再跨会话沿用旧计划（旧计划留在它自己的会话里，由面板「▶ 继续执行」续跑）。
   devSessionsOf 仍服务「最近一次要求」展示（devLastRequestOf）。 */
function devSessionTitleOf(node, mode) {
  return (
    (mode === "refine"
      ? I18n.t("细化 · ")
      : mode === "ask"
        ? I18n.t("问询") + " · "
        : I18n.t("开发 · ")) + (node.title || I18n.t("开发节点"))
  );
}
/* 节点改名 → 其名下的细化 / 开发会话标题跟随（保留各自前缀） */
function syncDevSessionTitles(node) {
  if (!node) return;
  const ids = devSessionIdsOf(node);
  if (!ids.length) return;
  let touched = false;
  for (const s of agentSessions()) {
    if (ids.indexOf(s.id) < 0) continue;
    const m = String(s.title || "").match(/^(细化|开发|Refine|Dev)\s*·\s*/i);
    const want =
      (m ? m[0] : I18n.t("开发 · ")) + (node.title || I18n.t("开发节点"));
    if (s.title !== want) {
      s.title = want;
      touched = true;
    }
  }
  if (touched) {
    try {
      renderAgentSessionSidebar();
    } catch (_) {}
  }
}
/* 每次「开发 / 细化」都新建会话运行：上下文干净，工作区 = 项目根 */
function createDevSessionForNode(node, mode, req) {
  if (!node || node.kind !== "super" || !node.dev) return null;
  /* 该功能块（或就近上层功能块）选定的 Agent 模型：新建绑定会话直接沿用；
     都没选则保持原有默认（DeepSeek 官方路由 + 引擎默认模型） */
  const eff =
    typeof devAgentModelOf === "function" ? devAgentModelOf(node) : null;
  /* 预设与思考强度同理：本块或就近上层选过就用它，没选回落默认档（AGENT_PRESET_DEFAULT，即极简）/ high
     （与改动前逐字一致，老画布行为不变） */
  const st =
    typeof devAgentSettingsOf === "function" ? devAgentSettingsOf(node) : null;
  const list = agentSessions();
  const sess = {
    id: uid("as"),
    title: devSessionTitleOf(node, mode),
    workspace: devPathOf(node) || dshWorkspaceOf(node),
    /* 开发 / 细化绑定会话：所属画布 = 该功能块所在画布（不是开轮时用户看到的画布） */
    canvasWfId: canvasWfIdForNode(node),
    preset: (st && st.preset) || AGENT_PRESET_DEFAULT,
    provider: (eff && eff.provider) || "deepseek-official",
    model: (eff && eff.model) || "",
    effort: (st && st.effort) || "high",
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  /* 任务书整份写入会话契约 _devContract（发送时注入系统提示，见 agentSessionSend）：
     不占用户消息位 —— 会话里只显示用户填写的关键输入（本次开发需求 / 细化范围） */
  sess._devContract = devNodeContractText(node, req);
  const reqText = String(req === undefined || req === null ? "" : req).trim();
  sess.messages.unshift({
    role: "user",
    content:
      mode === "refine"
        ? I18n.t("细化该功能块")
        : reqText
          ? I18n.t("本次开发需求：") + reqText
          : sess._devContract,
    _src: "dev-node",
    _nid: node.id,
  });
  /* 每个「开发 / 细化」绑定会话 = 独立干净上下文（首轮只有一条用户关键输入消息，
     任务书整份在 _devContract 里随系统提示注入，不占消息位）：
     不再整份沿用上一份没跑完的计划，也不注入「沿用旧计划」指令 ——
     跨会话沿用正是「新会话开始时就突然执行旧计划」的直接来源，已取消。 */
  list.unshift(sess);
  node.agentSessionId = sess.id;
  if (!Array.isArray(node.devSessionIds)) node.devSessionIds = [];
  node.devSessionIds.unshift(sess.id);
  while (node.devSessionIds.length > 24) node.devSessionIds.pop();
  return sess;
}
/* 从任务书 / 首条 dev-node 消息里取「本次开发需求」行（还原最近一次要求；
   新会话首条消息就是「本次开发需求：」+ 用户输入，旧会话则是整份任务书里的那一行） */
function devReqTextOfMessage(m) {
  if (!m || m.role !== "user") return "";
  const body = String(m.content || "");
  /* 任务书在创建会话时按当时 UI 语言写入，解析时兼容当前语言与中文原文 */
  const prefixes = [I18n.t("本次开发需求："), "本次开发需求："];
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    for (const prefix of prefixes) {
      if (line.indexOf(prefix) !== 0) continue;
      const req = line.slice(prefix.length).trim();
      if (req) return req;
    }
  }
  return "";
}
/* 对话框里展示「最近一次要求」，方便用户接着迭代 */
function devLastRequestOf(node) {
  const sess = devSessionsOf(node)[0];
  if (!sess) return "";
  const msgs = sess.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user" || m._src) continue;
    const t = String(m.content || "").trim();
    if (!t) continue;
    return t.length > 160 ? t.slice(0, 160) + "…" : t;
  }
  /* 会话首轮只有合并后的任务书单条消息：从「本次开发需求：」行还原 */
  for (let i = msgs.length - 1; i >= 0; i--) {
    const req = devReqTextOfMessage(msgs[i]);
    if (req) return req.length > 160 ? req.slice(0, 160) + "…" : req;
  }
  return "";
}
/* 直接回到该节点最近一次的会话（不新建、不弹框） */
async function openBoundDevSession(node) {
  const sess = devSessionsOf(node)[0];
  if (!sess) {
    toast(I18n.t("该功能块还没有开发会话"), "warn");
    return;
  }
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  setView("agent");
}
/* 「开发」：弹对话框 → 显示模块标题与现状 + 填写本次开发内容 → 确认后新会话运行 */
async function developDevNode(node) {
  if (!node || node.kind !== "super" || !node.dev) return;
  const dk = devKindOf(node) || "module";
  const st = devStatusOf(node);
  const p = devPathOf(node);
  const kids = devChildrenOf(node);
  const last = devLastRequestOf(node);
  const rows = [
    [I18n.t("元素类型"), I18n.t(DEV_KIND_LABEL[dk] || "模块")],
    [I18n.t("开发状态"), devStatusText(st)],
    [
      I18n.t("Agent 模型"),
      typeof devModelDialogText === "function"
        ? devModelDialogText(node)
        : I18n.t("自动（跟随默认）"),
    ],
    [I18n.t("项目根目录"), p || I18n.t("（未设置）")],
    [
      I18n.t("下层元素"),
      kids.length
        ? kids
            .map((k) => {
              const kk = devKindOf(k) || "module";
              return (k.title || k.id) + "（" + I18n.t(DEV_KIND_LABEL[kk] || "模块") + "）";
            })
            .slice(0, 6)
            .join("、") + (kids.length > 6 ? " …" : "")
        : I18n.t("（无 · 可点「细化」展开）"),
    ],
  ];
  if (last) rows.push([I18n.t("最近一次要求"), last]);
  const res = await mtDialogForm({
    title: I18n.t("开发") + " · " + (node.title || I18n.t("开发节点")),
    wide: true,
    rows,
    note: devNoteDialogField(node),
    msg: I18n.t("请说明本次要开发或迭代的内容；确认后将新建一个绑定该模块的开发会话并在其中运行。"),
    warn: p
      ? ""
      : I18n.t(
          "尚未设置项目根目录（devPath）：会话工作区将退回默认目录，建议在顶层功能块上先设置项目路径。",
        ),
    textarea: devDraftTextareaOpts(node, "dev", {
      label: I18n.t("本次希望开发 / 迭代的内容"),
      placeholder: I18n.t(
        "例如：补该模块的错误处理与日志；按现有风格新增 XX 接口；重构某文件但不改变对外 API…",
      ),
      rows: 6,
      requiredMsg: I18n.t("请填写本次希望开发或迭代的内容"),
    }),
    /* 边写边留存：取消 / Esc / 被别的事务顶出对话框都不丢，下次打开原样回填 */
    onText: (t) => devDraftSet(node, "dev", t),
    hint: I18n.t(
      "确认 = 新会话后台运行（工作区 = 项目根目录 · 标题「开发 · 模块名」· 状态转为进行中 · 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · 下方「先拷问需求」开关留在该功能块上（下次打开仍在）· Ctrl+Enter 提交 · Esc 取消",
    ),
    /* 「先拷问需求」：开关状态真源是 node.devGrill（布尔 · 随画布落盘），不塞进
       devDraft —— 那是文本草稿、提交后会清掉，而本开关的语义是「这个模块我就是要
       先被问清再动手」，属于粘在功能块上的偏好。真正生效在 devNodeContractText：
       开启时任务书里多一段【拷问模式】，要求会话先加载内置技能 mtnode-grill-me
       按轮问需求，未经用户确认达成共识前不得改任何东西。 */
    custom: (c) => {
      const lab = document.createElement("label");
      lab.className = "mt-form-lab";
      lab.textContent = I18n.t("开发前需求确认（可选）");
      c.appendChild(lab);
      const listEl = document.createElement("div");
      listEl.className = "mt-sug-opts";
      const row = document.createElement("label");
      const on = node.devGrill === true;
      row.className = "mt-sug-opt" + (on ? " on" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = on;
      cb.onchange = () => {
        node.devGrill = !!cb.checked;
        row.classList.toggle("on", !!cb.checked);
        scheduleSave();
      };
      const txt = document.createElement("div");
      txt.className = "mt-sug-txt";
      const tt = document.createElement("b");
      tt.className = "mt-sug-title";
      tt.textContent = I18n.t("先拷问需求（grill-me）");
      txt.appendChild(tt);
      const dd = document.createElement("div");
      dd.className = "mt-sug-desc";
      dd.textContent = I18n.t(
        "开启 = 本次开发会话先用内置技能 mtnode-grill-me 按轮问清需求，达成共识并经你确认后才动手。",
      );
      txt.appendChild(dd);
      row.appendChild(cb);
      row.appendChild(txt);
      listEl.appendChild(row);
      c.appendChild(listEl);
    },
    requireText: true,
    actions: [
      { id: "cancel", label: I18n.t("取消") },
      { id: "go", label: I18n.t("开始开发"), primary: true },
    ],
  });
  if (!res || res.action !== "go") return;
  /* 已提交进会话：草稿使命完成，清掉，避免下次打开重复带上同一份内容 */
  devDraftSet(node, "dev", "");
  await startDevSessionWithText(node, String(res.text || "").trim());
}
/* 「开发」与「建议 → 开发」共用的收尾：新建绑定会话 → 状态转进行中 → 后台运行（留在画布，不跳会话视图）。
 * 会话运行中在画布上由节点「运行中」徽标（sess 态）+ 左下角运行队列展示，用户可随时去会话列表查看。 */
async function startDevSessionWithText(node, text) {
  const body = String(text || "").trim();
  if (!node || node.kind !== "super" || !node.dev || !body) return;
  const sess = createDevSessionForNode(node, "dev", body);
  if (!sess) return;
  if (node.devStatus !== "done") node.devStatus = "wip";
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  renderCanvas();
  /* 功能块刚绑上这条开发会话：运行队列按「自身 / 绑定会话」口径立刻重算一次 */
  updateRunQueuePanel();
  toast(
    I18n.t("已创建开发会话「") +
      (sess.title || "") +
      I18n.t("」并在后台运行（留在画布 · 左下角队列 / 会话列表可看进度）"),
    "ok",
  );
  try {
    /* 任务书整份在会话契约 _devContract 里（发送时注入系统提示），首条消息只有
       用户关键输入；发这条单消息即可启动本轮（_devContract 分支只读首条 dev-node 消息） */
    await agentSessionSend("", { _devContract: true });
  } catch (err) {
    toast(I18n.t("开发会话启动失败：") + ((err && err.message) || String(err)), "err");
  }
}
/* ---------- 「问询」= 该功能块的只读会话（与「开发 / 细化」同一套会话机制） ----------
 * 旧实现把问询跑在弹窗作业上（devAskJobs + #mtDialog 单宿主视图）：视图被顶掉或
 * 点了「返回后台」之后，结算时没有地方渲染回答，问询就「无法查看」。会话承载后
 * 问答永久留在会话里，与弹窗活不活着无关。
 * 与开发会话的两点刻意差别：
 *   1) 契约是「只读问询任务书」（app-devnode.js devAskContractText），只回答问题，
 *      不改文件、不改画布、不回写本模块的 note / devStatus / devFiles；
 *   2) 会话 id 记在 node.devAskSessionId，不进 devSessionIds / agentSessionId ——
 *      那两处是「最近一次要求」与「会话 N」跳转的口径，混进问询会污染开发语义。
 * 同一功能块复用同一条问询会话：多轮追问落在同一上下文里。 */
function devAskSessionOf(node) {
  if (!node || node.kind !== "super" || !node.dev) return null;
  const list = typeof agentSessions === "function" ? agentSessions() : [];
  if (!node.devAskSessionId || !list.length) return null;
  const sess = list.find((s) => s && s.id === node.devAskSessionId) || null;
  if (!sess) return null;
  /* 旧版「问询记录会话」（只补写问答、没有契约）不复用：它只是历史留档 */
  if (!String(sess._devContract || sess.devContract || "").trim()) return null;
  return sess;
}
async function startDevAskSession(node, question) {
  const q = String(question || "").trim();
  if (!node || node.kind !== "super" || !node.dev || !q) return;
  if (typeof agentSessions !== "function") return;
  const list = agentSessions();
  const contract =
    typeof devAskContractText === "function"
      ? String(devAskContractText(node) || "").trim()
      : "";
  let sess = devAskSessionOf(node);
  if (sess) {
    /* 追问：契约按模块最新现状刷新（拿不到任务书就保留原来的），
       问题作为普通一轮用户消息发进同一会话 */
    if (contract) sess._devContract = contract;
    sess.updatedAt = Date.now();
    S.agentActiveId = sess.id;
    await persistAgentSession();
    scheduleSave(true);
    try {
      await agentSessionSend(q);
    } catch (err) {
      toast(I18n.t("问询会话启动失败：") + ((err && err.message) || String(err)), "err");
    }
    return;
  }
  const eff =
    typeof devAgentModelOf === "function" ? devAgentModelOf(node) : null;
  /* 预设 / 思考强度就近继承本块或上层功能块的选择；未选择回落默认档（AGENT_PRESET_DEFAULT，即极简）/ high */
  const st =
    typeof devAgentSettingsOf === "function" ? devAgentSettingsOf(node) : null;
  sess = {
    id: uid("as"),
    title: devSessionTitleOf(node, "ask"),
    workspace: devPathOf(node) || dshWorkspaceOf(node),
    /* 问询会话同样归属该功能块所在画布 */
    canvasWfId: canvasWfIdForNode(node),
    preset: (st && st.preset) || AGENT_PRESET_DEFAULT,
    provider: (eff && eff.provider) || "deepseek-official",
    model: (eff && eff.model) || "",
    effort: (st && st.effort) || "high",
    messages: [],
    archived: false,
    updatedAt: Date.now(),
  };
  /* 只读问询任务书 = 会话契约：每轮（含追问）随系统提示注入，不占用户消息位 */
  sess._devContract = contract;
  /* 首条消息只放用户的问题；_src:"dev-node" 让它走契约发送分支（标题不被首轮文本覆盖） */
  sess.messages.push({ role: "user", content: q, _src: "dev-node", _nid: node.id });
  list.unshift(sess);
  node.devAskSessionId = sess.id;
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  renderCanvas();
  /* 会话已开始运行：左下角运行队列立刻补上这一行（点行即可进会话看回答） */
  updateRunQueuePanel();
  toast(
    I18n.t("已创建问询会话「") +
      (sess.title || "") +
      I18n.t("」并在后台只读运行（留在画布 · 回答永久留在该会话里，可随时回看与追问）"),
    "ok",
  );
  try {
    await agentSessionSend("", { _devContract: true });
  } catch (err) {
    toast(I18n.t("问询会话启动失败：") + ((err && err.message) || String(err)), "err");
  }
}
function assistantMsgFromNode(node, text) {
  const msg = { role: "assistant", content: text };
  /* 思考与输出彻底分家：content = 模型输出正文（下游数据口径不变），
     reasoning = 纯思考（按步分段，段间空行，不含「🔧」），
     segments  = 本轮轨迹的段快照（think/say/err 带正文，tool 只留 callId 与 step） */
  const rsn =
    traceThinkDisplay(node && node.id, "") || (node ? thinkingTextOf(node) : "");
  if (String(rsn).trim()) msg.reasoning = String(rsn);
  /* 段快照与落盘限长 / 可还原校验统一走 attachTraceSegments */
  attachTraceSegments(msg, node && node.id);
  const tools = (S.nodeTools && S.nodeTools[node.id]) || [];
  if (tools.length) msg.tools = tools.map((t) => Object.assign({}, t));
  const r = node ? selResult(node) : null;
  const at = Number((r && r.ranAt) || (node && node.ranAt) || Date.now()) || 0;
  if (at > 0) msg.at = at;
  return msg;
}
async function expandAgentTaskToSession(node) {
  const sess = ensureAgentSessionForNode(node);
  if (!sess) return;
  /* 运行中由 live 行展示思考/工具/正文,不把半成品写成已完成消息 */
  const r = selResult(node);
  if (!node.running && r && r.output && r.output.kind === "text") {
    const hasAi = sess.messages.some(
      (m) => m.role === "assistant" && m.content === r.output.text,
    );
    if (!hasAi) sess.messages.push(assistantMsgFromNode(node, r.output.text));
  }
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  setView("agent");
  toast(I18n.t("已扩展为智能会话（内容完全同步）"), "ok");
}
/* Remotion 节点 ↔ 智能会话 打通：一键打开绑定会话，查看生成过程 / 编辑迭代。
   生成记录（node.output / node.tsx / node.error）以 assistant 消息补写进会话，
   去重追加（同内容不重复），之后在会话里可直接查看/复制 TSX 或改节点参数回画布重跑。 */
async function openRemotionSession(node) {
  if (!node || node.kind !== "remotion") return;
  const sess = ensureAgentSessionForNode(node);
  if (!sess) return;
  const recap = remotionSessionRecapText(node);
  if (recap) {
    const hasAi = sess.messages.some(
      (m) => m.role === "assistant" && m.content === recap,
    );
    if (!hasAi) sess.messages.push(assistantMsgFromNode(node, recap));
  }
  S.agentActiveId = sess.id;
  await persistAgentSession();
  scheduleSave(true);
  setView("agent");
  toast(I18n.t("已打开会话：可查看过程与编辑迭代"), "ok");
}
/* 生成过程摘要（assistant 消息正文）：成功（视频路径 + 参数）/ 失败 / 已取消 + TSX 代码块 */
function remotionSessionRecapText(node) {
  if (!node) return "";
  const lines = [];
  const out = node.output;
  if (node.error) {
    lines.push(I18n.t("上次生成失败：") + String(node.error));
  } else if (out && out.path) {
    const meta = [];
    if (String(node.size || "").trim())
      meta.push(String(node.size).trim().replace("x", "×"));
    if (node.duration) meta.push(node.duration + "s");
    if (node.fps) meta.push(node.fps + "fps");
    lines.push(
      I18n.t("上次生成完成：视频已输出到 ") +
        out.path +
        (meta.length ? "（" + meta.join(" · ") + "）" : ""),
    );
  } else if (
    !node.running &&
    String(node.remotionStatus || "").indexOf(I18n.t("已取消")) >= 0
  ) {
    lines.push(I18n.t("上次生成已取消"));
  }
  if (String(node.tsx || "").trim()) {
    lines.push(I18n.t("生成的动效代码（TSX，可在会话中编辑迭代）："));
    lines.push("```tsx");
    lines.push(String(node.tsx).trim());
    lines.push("```");
  }
  return lines.join("\n");
}
function syncAgentTaskToSession(node, input, output) {
  if (!node || !node.agentSessionId || !output) return;
  const list = agentSessions();
  const sess = list.find((s) => s.id === node.agentSessionId);
  if (!sess) return;
  /* 标题映射:节点标题 → 会话名称(双向,后写优先) */
  if (node.title && sess.title !== node.title) sess.title = node.title;
  /* 运行参数同步到会话,保证节点与会话参数一致 */
  if (node.preset) sess.preset = node.preset;
  if (node.provider) sess.provider = node.provider;
  if (node.model) sess.model = node.model;
  if (node.effort) sess.effort = node.effort;
  /* 内容映射:节点任务文本 ↔ 会话中的对应消息(标记 _src 的 user 消息) */
  const taskText = String(node.task || "").trim();
  const marked = sess.messages.find((m) => m._src === "node-task");
  if (taskText) {
    if (marked) {
      if (marked.content !== taskText) marked.content = taskText;
    } else {
      sess.messages.unshift({
        role: "user",
        content: taskText,
        _src: "node-task",
        at: Date.now(),
      });
    }
  }
  const hasUser = sess.messages.some(
    (m) => m.role === "user" && m.content === String(input || "").trim(),
  );
  if (!hasUser && String(input || "").trim())
    sess.messages.push({ role: "user", content: String(input).trim(), at: Date.now() });
  const hasAi = sess.messages.some(
    (m) => m.role === "assistant" && m.content === output,
  );
  if (!hasAi) sess.messages.push(assistantMsgFromNode(node, output));
  sess.running = false;
  sess._pending = "";
  sess._liveTools = [];
  sess.updatedAt = Date.now();
  persistAgentSession().catch(() => {});
}
function syncAgentTaskFromSession(sessionId) {
  if (!S.wf) return;
  const touched = [];
  for (const n of S.wf.nodes) {
    if (n.kind !== "agent_task" || n.agentSessionId !== sessionId) continue;
    const list = agentSessions();
    const sess = list.find((s) => s.id === sessionId);
    if (!sess) continue;
    /* 标题映射:会话名称 → 节点标题(双向,后写优先) */
    if (sess.title) n.title = sess.title;
    /* 会话参数回写节点:预设/供应商/模型/强度完全同步 */
    if (sess.preset) n.preset = sess.preset;
    if (sess.provider) n.provider = sess.provider;
    if (sess.model) n.model = sess.model;
    if (sess.effort) n.effort = sess.effort;
    const last = [...sess.messages].reverse().find((m) => m.role === "assistant");
    if (last) {
      n.output = { kind: "text", text: last.content };
      n.ranAt = Date.now();
      n.error = null;
      touched.push(n);
    }
  }
  if (touched.length) {
    scheduleSave(true);
    renderCanvas();
  }
}

function newWorkflowDialog() {
  openOverlay(I18n.t("新建画布"), { persistent: true });
  const body = $("#ovBody");
  const lab = document.createElement("label");
  lab.className = "n-field";
  lab.appendChild(document.createTextNode(I18n.t("画布名称")));
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = I18n.t("画布 ") + new Date().toLocaleDateString().replace(/\//g, "-");
  lab.appendChild(inp);
  body.appendChild(lab);

  const wsLab = document.createElement("label");
  wsLab.className = "n-field";
  wsLab.style.marginTop = "10px";
  wsLab.appendChild(document.createTextNode(I18n.t("工作目录（必填）")));
  const wsRow = document.createElement("div");
  wsRow.style.cssText = "display:flex;gap:6px;align-items:center";
  const wsInp = document.createElement("input");
  wsInp.type = "text";
  wsInp.placeholder = I18n.t("请选择已存在的文件夹…");
  wsInp.style.flex = "1";
  wsRow.appendChild(wsInp);
  wsRow.appendChild(workspaceBrowseButton(wsInp));
  wsLab.appendChild(wsRow);
  const wsHint = document.createElement("div");
  wsHint.className = "settings-hint";
  wsHint.style.marginTop = "6px";
  wsHint.textContent = I18n.t(
    "新建画布必须指定工作目录。智能节点与相对保存路径都相对该目录，缺少目录会导致读写失败。",
  );
  wsLab.appendChild(wsHint);
  body.appendChild(wsLab);

  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("创建");
  ok.onclick = async () => {
    const ws = String(wsInp.value || "").trim();
    if (!ws) {
      toast(I18n.t("请选择工作目录"), "err");
      wsInp.focus();
      return;
    }
    if (!(await window.api.fileIsDir(ws))) {
      toast(I18n.t("工作目录不存在或不是有效文件夹"), "err");
      wsInp.focus();
      return;
    }
    const id = "wf_" + Date.now().toString(36);
    clearHistory();
    setForegroundWf({
      id,
      name: inp.value.trim() || I18n.t("未命名画布"),
      nodes: [],
      wires: [],
      groups: [],
      marks: [],
      workspace: ws,
    }); /* 用户可见的画布切换：新建的即前台画布 */
    await window.api.wfSave(id, S.wf);
    S.config.activeWorkflowId = id;
    await window.api.configSave(S.config);
    closeOverlay();
    renderAll();
    trackWorkflow(id, S.wf.name);
    toast(I18n.t("已创建新画布"), "ok");
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  inp.focus();
}

function deleteWorkflowDialog() {
  const wf = S.wf;
  if (!wf || !wf.id) {
    toast(I18n.t("当前没有打开的画布"), "err");
    return;
  }
  /* 弹窗打开的一刻就锁定删除目标：此后即使用户切换了画布、后台改掉了图，
     确认时校验的仍是这份快照，绝不会删成「此刻恰好打开的那张画布」。 */
  const snap = {
    wf,
    id: wf.id,
    name: String(wf.name || wf.id),
    nodeCount: Array.isArray(wf.nodes) ? wf.nodes.length : 0,
  };
  openOverlay(I18n.t("删除画布"));
  const body = $("#ovBody");
  const w = document.createElement("div");
  w.className = "settings-hint";
  w.innerHTML =
    I18n.t("将删除画布 <b>") +
    esc(snap.name) +
    I18n.t("</b>（id <code>") +
    esc(snap.id) +
    I18n.t("</code> · 节点 <b>") +
    esc(String(snap.nodeCount)) +
    I18n.t(
      "</b> 个）及其全部本地数据文件（含节点图像资产）。此操作不可恢复。",
    ) +
    "<br>" +
    I18n.t("请先核对上面的 id 与节点数，确认要删的就是它。");
  body.appendChild(w);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini danger";
  ok.textContent = I18n.t("确认删除");
  ok.onclick = async () => {
    /* 三重复核 ① 弹窗打开后画布被切走：对象与 id 都必须仍是快照那一个 */
    if (!S.wf || S.wf !== snap.wf || S.wf.id !== snap.id) {
      closeOverlay();
      toast(
        I18n.t("当前画布已切换，本框只删除打开时锁定的画布，请重新发起删除"),
        "err",
      );
      return;
    }
    /* 三重复核 ② 有画布写入在飞（智能体后台编辑画布）时不允许删除 */
    if (bgCanvasWriteActive()) {
      toast(I18n.t("智能体正在后台写入画布，请稍候"), "warn");
      return;
    }
    ok.disabled = true;
    try {
      /* 三重复核 ③ 目标 id 仍在画布列表里（已被别处删掉就不再往下走） */
      let list = [];
      try {
        list = await window.api.wfList();
      } catch (e) {
        toast(
          I18n.t("读取画布列表失败：") + ((e && e.message) || String(e)),
          "err",
        );
        return;
      }
      if (!wfInList(list, snap.id)) {
        closeOverlay();
        toast(I18n.t("画布已不存在，可能已被删除：") + snap.name, "warn");
        return;
      }
      /* 删除前唯一的写盘：把当前画布未保存的改动落掉，不留「待保存…」脏状态 */
      await flushCurrentWf();
      /* 上面两次 await 之间状态可能又变了：派发删除前按同一口径再核一遍 */
      if (!S.wf || S.wf !== snap.wf || S.wf.id !== snap.id) {
        closeOverlay();
        toast(
          I18n.t("当前画布已切换，本框只删除打开时锁定的画布，请重新发起删除"),
          "err",
        );
        return;
      }
      if (bgCanvasWriteActive()) {
        toast(I18n.t("智能体正在后台写入画布，请稍候"), "warn");
        return;
      }
      let list2 = [];
      try {
        list2 = await window.api.wfList();
      } catch (e) {
        toast(
          I18n.t("读取画布列表失败：") + ((e && e.message) || String(e)),
          "err",
        );
        return;
      }
      if (!wfInList(list2, snap.id)) {
        closeOverlay();
        toast(I18n.t("画布已不存在，可能已被删除：") + snap.name, "warn");
        return;
      }
      /* 删除结果必须看返回值：失败就不谎报成功，也不重建默认画布。
         主进程无论物理删还是软删（进回收站），只要回 ok 就代表这张画布
         「对用户已不存在、对渲染层已不可写」，后面统一按已删收口。 */
      const r = await window.api.wfDelete(snap.id);
      if (!r || !r.ok) {
        toast(
          I18n.t("删除失败：") + ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
        return;
      }
      closeOverlay();
      /* 已删画布绝不能再落盘：掐待保存定时器 + 摘 wfBag + 剔运行绑定栈 +
         清 nodeWfId 归属，并把 id 记进黑名单（此后 persist 类写回一律丢弃）。 */
      forgetDeletedWf(snap.id, snap.wf);
      /* 落点要在摘标签之前选定：需要在原标签序列里找「下一个」标签 */
      const land = await pickLandingWfAfterDelete(snap.id);
      const visited = S.config.visitedWorkflows || [];
      const vi = visited.findIndex((t) => t.id === snap.id);
      if (vi >= 0) visited.splice(vi, 1);
      let landed = false;
      if (land.exists) {
        /* 切到落点走真实加载：workspace / tagCatalog 等字段随磁盘数据一起回来，
           不再手工拼 S.wf（原来这里造的是没有 workspace 的空壳对象） */
        await loadWorkflow(land.id, { skipFlush: true });
        landed = !!(S.wf && S.wf.id === land.id);
        if (landed)
          toast(
            I18n.t("画布已删除，已切换到：") + (S.wf.name || land.id),
            "ok",
          );
      }
      if (!landed) {
        /* ③ 只有磁盘上确实不存在 default.json（或落点加载失败）时才新建空默认画布 */
        await createDefaultWorkflowFresh();
        toast(I18n.t("画布已删除，已重建默认画布"), "ok");
      }
      await refreshWfSelect();
    } finally {
      ok.disabled = false;
    }
  };
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

/* 目标画布是否仍存在于画布列表（wfList 项：{id,name,mtime,nodes}） */
function wfInList(list, id) {
  return (
    !!id &&
    Array.isArray(list) &&
    list.some((t) => t && String(t.id) === String(id))
  );
}

/* ── 删除画布后的落点选择 ──
   曾经的 bug（R1）：删除任何画布后都无条件 wfSave("default", {nodes:[],…})，
   把磁盘上已存在的「默认画布」整个清空 —— 用户看到的就是「别的画布被删了」。
   现在按顺序找落点，且只有 default.json 真的不存在时才新建空画布：
   ① 标签条（visitedWorkflows）里删除后仍存在的「下一个」标签
   ② 画布列表（wfList 按 mtime 倒序）里任意仍存在的画布
   ③ 都没有 → 新建空默认画布 */
async function pickLandingWfAfterDelete(deletedId) {
  const del = String(deletedId || "");
  let list = [];
  try {
    list = await window.api.wfList();
  } catch {
    list = [];
  }
  const alive = (Array.isArray(list) ? list : []).filter(
    (w) => w && String(w.id) !== del,
  );
  const inList = (id) => alive.some((w) => String(w.id) === String(id));
  const visited = (S.config && S.config.visitedWorkflows) || [];
  const at = visited.findIndex((t) => t && String(t.id) === del);
  const tabs = visited.filter((t) => t && String(t.id) !== del && inList(t.id));
  if (tabs.length) {
    /* ① tabs 已剔除被删那一项：下标 at 就是原先紧跟其后的那个标签 */
    const i = at >= 0 ? Math.min(at, tabs.length - 1) : 0;
    return { id: String(tabs[Math.max(0, i)].id), exists: true };
  }
  /* ② 标签条没有可用页：落到画布列表里任意仍存在的画布（wfList 按 mtime 倒序，
     即最近动过的那张）。不按名字偏爱 default。 */
  if (alive.length) return { id: String(alive[0].id), exists: true };
  /* ③ 一张画布都不剩（default.json 也确实不存在）→ 由调用方新建空默认画布 */
  return { id: "default", exists: false };
}

/* 新建一张空默认画布并切为前台（仅在 default.json 确实不存在时调用） */
async function createDefaultWorkflowFresh() {
  const id = "default";
  clearHistory();
  setForegroundWf({
    id,
    name: I18n.t("默认画布"),
    nodes: [],
    wires: [],
    groups: [],
    marks: [],
    workspace: "",
  });
  /* 刚删掉 default 又重建同名画布是正常路径：解禁 id（被删的旧对象仍有墓碑），
     否则这张新画布会被黑名单永久拦成「存不下去」。 */
  reviveWf(id);
  await window.api.wfSave(id, S.wf);
  S.config.activeWorkflowId = id;
  rememberWf(S.wf);
  renderAll();
  trackWorkflow(id, S.wf.name);
  await window.api.configSave(S.config);
}

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/* ============ 画布导出 / 导入（.mtnodes 二进制包） ============ */

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function mkMiniBtn(label, onclick, primary) {
  const b = document.createElement("button");
  b.className = primary ? "mini primary" : "mini";
  b.textContent = label;
  b.onclick = onclick;
  return b;
}
function mkIconBtn(icon, title, onclick, opts) {
  const b = document.createElement("button");
  b.type = "button";
  let cls = "mini btn-sq tpl-ico";
  if (opts && opts.primary) cls += " primary";
  if (opts && opts.on) cls += " on";
  if (opts && opts.danger) cls += " danger";
  b.className = cls;
  b.textContent = icon;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = onclick;
  return b;
}
/* 模板商店：按视图与可用面积估算每页条数（上限 48） */
function tplBrowsePageSize() {
  const box = document.querySelector("#overlay .overlay-box");
  const body = $("#ovBody");
  const w = Math.max(360, (body && body.clientWidth) || (box && box.clientWidth) || 900);
  const boxH = (box && box.clientHeight) || Math.min(window.innerHeight * 0.9, 860);
  const availH = Math.max(220, boxH - 230);
  if (TPL_ST.view === "list") {
    const rowH = 72;
    const rows = Math.max(4, Math.floor(availH / rowH));
    return Math.min(48, Math.max(10, rows));
  }
  const cardW = 136;
  const cardH = 206;
  const cols = Math.max(2, Math.floor((w - 24) / cardW));
  const rows = Math.max(2, Math.floor(availH / cardH));
  return Math.min(48, Math.max(8, cols * rows));
}

function hintEl(text) {
  const d = document.createElement("div");
  d.className = "settings-hint";
  d.textContent = text;
  return d;
}

/* 序列化当前画布为可打包的纯数据对象（去除 Promise/函数等不可克隆字段） */
function cloneWfForExport() {
  try {
    return JSON.parse(JSON.stringify(S.wf));
  } catch (e) {
    return null;
  }
}

/* 创意工坊上传：去掉工作流/节点上的本机工作目录 */
function stripWorkspacesForStoreUpload(wf) {
  if (!wf || typeof wf !== "object") return wf;
  wf.workspace = "";
  for (const n of wf.nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.workspace === "string") n.workspace = "";
    if (typeof n.agentWorkspace === "string") n.agentWorkspace = "";
  }
  return wf;
}

async function stripStoreMtNodesBase64(base64) {
  const r = await window.api.mtnodesStripWorkspaceBase64(base64);
  if (!r || !r.ok) {
    throw new Error((r && r.error) || I18n.t("未知错误"));
  }
  return r;
}

/* 文件导出（复用主进程保存对话框） */
async function doExportFile() {
  const data = cloneWfForExport();
  if (!data) {
    toast(I18n.t("导出失败：画布包含无法序列化的数据"), "err");
    return;
  }
  const r = await window.api.mtnodesExport(data);
  if (r && r.ok) {
    toast(I18n.t("画布已导出（") + fmtBytes(r.bytes) + "）", "ok");
  } else if (r && r.error !== I18n.t("已取消")) {
    toast(I18n.t("导出失败：") + r.error, "err");
  }
}

/* 文件导入（复用主进程打开对话框） */
async function doImportFile() {
  const r = await window.api.mtnodesImport();
  if (!r) return;
  if (!r.ok) {
    if (r.error !== I18n.t("已取消")) toast(I18n.t("导入失败：") + r.error, "err");
    return;
  }
  adoptImportedWorkflow(r.workflow);
}

/* 导入成功后接管画布 */
async function adoptImportedWorkflow(workflow) {
  clearHistory();
  setForegroundWf(workflow); /* 导入接管画布：用户可见切换，_fgWf 同步 */
  S.wf.id = workflow.id;
  migrateWf(S.wf);
  S.config.activeWorkflowId = S.wf.id;
  await sanitizeWfEnvironment({ quiet: false });
  reviveWf(S.wf.id); /* 导入的是全新对象：同名 id 曾被删时，解禁让这张新画布能落盘 */
  await window.api.wfSave(S.wf.id, S.wf);
  await window.api.configSave(S.config);
  renderAll();
  refreshWfSelect();
  trackWorkflow(S.wf.id, S.wf.name);
  toast(I18n.t("画布已导入：") + (S.wf.name || S.wf.id), "ok");
}

/* ── 无效工作目录 / 服务商 · 模型：导入或打开他人模板后的修复 ── */
async function wipeMatchingWorkspaces(badPath) {
  const bad = String(badPath || "").trim();
  if (!bad) return;
  let changed = false;
  const clr = (obj, key) => {
    if (obj && String(obj[key] || "").trim() === bad) {
      obj[key] = "";
      changed = true;
    }
  };
  if (S.wf) {
    clr(S.wf, "workspace");
    for (const n of S.wf.nodes || []) {
      clr(n, "workspace");
      clr(n, "agentWorkspace");
    }
  }
  if (String(S.assistWorkspace || "").trim() === bad) {
    S.assistWorkspace = "";
    if (S.config) S.config.assistWorkspace = "";
    changed = true;
  }
  for (const sess of agentSessions()) clr(sess, "workspace");
  if (changed) {
    scheduleSave(true);
    try {
      if (S.config) await window.api.configSave(S.config);
    } catch (_) {}
  }
}

async function pathIsExistingDir(p) {
  const s = String(p || "").trim();
  if (!s) return true;
  try {
    return !!(await window.api.fileIsDir(s));
  } catch (_) {
    return false;
  }
}

function showInfoOverlay(title, summary, detail) {
  return new Promise((resolve) => {
    openOverlay(title || I18n.t("提示"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent = summary || "";
    body.appendChild(p);
    if (detail) {
      const pre = document.createElement("pre");
      pre.style.cssText =
        "max-height:280px; overflow:auto; background:var(--code); border:1px solid var(--bd); padding:8px; font-size:11px; white-space:pre-wrap; word-break:break-all";
      pre.textContent = detail;
      body.appendChild(pre);
    }
    foot.innerHTML = "";
    const ok = document.createElement("button");
    ok.className = "mini primary";
    ok.textContent = I18n.t("知道了");
    ok.onclick = () => {
      closeOverlay();
      resolve();
    };
    foot.appendChild(ok);
  });
}

async function sanitizeInvalidWorkspaces(opts) {
  opts = opts || {};
  const cleared = [];
  const wipe = async (label, getter, setter) => {
    const v = String(getter() || "").trim();
    if (!v) return;
    if (await pathIsExistingDir(v)) return;
    setter("");
    cleared.push(label + "\n  " + v);
  };
  if (S.wf) {
    await wipe(I18n.t("画布工作目录"), () => S.wf.workspace, (v) => {
      S.wf.workspace = v;
    });
    for (const n of S.wf.nodes || []) {
      const title = n.title || n.id || I18n.t("节点");
      if (typeof n.workspace === "string" && n.workspace.trim()) {
        await wipe(title + " · workspace", () => n.workspace, (v) => {
          n.workspace = v;
        });
      }
      if (typeof n.agentWorkspace === "string" && n.agentWorkspace.trim()) {
        await wipe(title + " · agentWorkspace", () => n.agentWorkspace, (v) => {
          n.agentWorkspace = v;
        });
      }
    }
  }
  await wipe(
    I18n.t("全局助手工作目录"),
    () => S.assistWorkspace,
    (v) => {
      S.assistWorkspace = v;
      if (S.config) S.config.assistWorkspace = v;
    },
  );
  for (const sess of agentSessions()) {
    if (!sess || typeof sess.workspace !== "string") continue;
    await wipe(
      I18n.t("智能会话") + " · " + (sess.title || sess.id || ""),
      () => sess.workspace,
      (v) => {
        sess.workspace = v;
      },
    );
  }
  if (!cleared.length) return 0;
  scheduleSave(true);
  if (S.config) {
    try {
      await window.api.configSave(S.config);
    } catch (_) {}
  }
  if (!opts.quiet) {
    await showInfoOverlay(
      I18n.t("工作目录无效"),
      I18n.t(
        "以下工作目录不存在或不是有效文件夹，已自动清空。请重新选择有效目录，以免影响全局助手、智能任务与相对路径保存。",
      ),
      cleared.join("\n\n"),
    );
  }
  return cleared.length;
}

function apiProvidersForKind(kind) {
  const list = (S.config && S.config.providers) || [];
  if (kind === "proc_image" || kind === "image")
    return list.filter((p) => String(p.type || "").startsWith("image_"));
  return list.filter((p) => p.type === "text_openai");
}

function agentProviderRouteValid(route) {
  const s = String(route || "").trim() || "deepseek-official";
  if (s === "deepseek-official") return true;
  if (s.startsWith("mtnode_")) {
    const id = s.slice("mtnode_".length);
    return (S.config.providers || []).some(
      (p) => p.id === id && p.type === "text_openai",
    );
  }
  return false;
}

function apiProviderValid(providerId, kind) {
  const p = (S.config.providers || []).find((x) => x.id === providerId);
  if (!p) return false;
  if (kind === "proc_image") return String(p.type || "").startsWith("image_");
  return p.type === "text_openai";
}

/* 按「无效服务商键」分组：每组稍后单独弹窗批量替换 */
function collectInvalidProviderGroups(wf) {
  const map = new Map();
  const bump = (key, meta, node) => {
    let g = map.get(key);
    if (!g) {
      g = Object.assign({ key, nodes: [] }, meta);
      map.set(key, g);
    }
    g.nodes.push(node);
  };
  for (const n of (wf && wf.nodes) || []) {
    const agentish =
      n.kind === "agent_task" ||
      (n.kind === "proc_text" && n.agent);
    if (agentish) {
      const route = String(n.provider || "deepseek-official").trim() || "deepseek-official";
      if (!agentProviderRouteValid(route)) {
        bump("agent:" + route, {
          mode: "agent",
          type: "text",
          badLabel: route,
          modelOnly: false,
        }, n);
      } else {
        const models = agentModelsForRoute(route);
        if (n.model && models.length && !models.includes(String(n.model))) {
          bump("agent-model:" + route + ":" + n.model, {
            mode: "agent",
            type: "text",
            badLabel: route + " · " + n.model,
            modelOnly: true,
            keepRoute: route,
          }, n);
        }
      }
      continue;
    }
    if (n.kind !== "proc_text" && n.kind !== "proc_image")
      continue;
    const pid = String(n.providerId || "").trim();
    if (!apiProviderValid(pid, n.kind)) {
      bump("api:" + (pid || "(empty)") + ":" + n.kind, {
        mode: "api",
        type: n.kind === "proc_image" ? "image" : "text",
        badLabel: pid || I18n.t("（未设置）"),
        modelOnly: false,
        nodeKind: n.kind,
      }, n);
    } else {
      const p = (S.config.providers || []).find((x) => x.id === pid);
      const models = ((p && p.models) || []).map(String);
      if (n.model && models.length && !models.includes(String(n.model))) {
        bump("api-model:" + pid + ":" + n.model, {
          mode: "api",
          type: n.kind === "proc_image" ? "image" : "text",
          badLabel: (p.name || pid) + " · " + n.model,
          modelOnly: true,
          keepProviderId: pid,
          nodeKind: n.kind,
        }, n);
      }
    }
  }
  return [...map.values()];
}

function promptReplaceProviderGroup(group) {
  return new Promise((resolve) => {
    openOverlay(I18n.t("无效服务商 / 模型"));
    overlayPersistent = true;
    const body = $("#ovBody");
    const foot = $("#ovFoot");
    body.innerHTML = "";
    const titles = group.nodes
      .map((n) => n.title || n.id)
      .filter(Boolean)
      .slice(0, 12);
    const more =
      group.nodes.length > titles.length
        ? I18n.t(" …共 ") + group.nodes.length + I18n.t(" 个节点")
        : "";
    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 10px; line-height:1.7; font-size:13px";
    p.textContent =
      I18n.t("检测到无效服务商 / 模型「") +
      group.badLabel +
      I18n.t("」，影响节点：") +
      titles.join("、") +
      more +
      I18n.t("。请选择要批量替换成的本地服务商与模型。");
    body.appendChild(p);

    const provLab = document.createElement("label");
    provLab.className = "n-field";
    provLab.style.display = "block";
    provLab.style.marginBottom = "8px";
    provLab.appendChild(document.createTextNode(I18n.t("替换为服务商")));
    const provSel = document.createElement("select");
    provSel.className = "n-field";
    provSel.style.width = "100%";
    const modelLab = document.createElement("label");
    modelLab.className = "n-field";
    modelLab.style.display = "block";
    modelLab.appendChild(document.createTextNode(I18n.t("模型")));
    const modelSel = document.createElement("select");
    modelSel.className = "n-field";
    modelSel.style.width = "100%";

    const fillModels = () => {
      modelSel.innerHTML = "";
      let models = [];
      if (group.mode === "agent") {
        models = agentModelsForRoute(provSel.value).map((id) => ({
          id,
          name: id,
        }));
      } else {
        const p = (S.config.providers || []).find((x) => x.id === provSel.value);
        models = ((p && p.models) || []).map((id) => ({ id, name: id }));
      }
      if (!models.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = I18n.t("（无可用模型）");
        modelSel.appendChild(o);
        return;
      }
      for (const m of models) {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.name || m.id;
        modelSel.appendChild(o);
      }
    };

    if (group.mode === "agent") {
      const dp = dshProvider();
      {
        const o = document.createElement("option");
        o.value = "deepseek-official";
        o.textContent = (dp && dp.name) || I18n.t("DeepSeek 官方");
        provSel.appendChild(o);
      }
      for (const p of mtnodePiProviders()) {
        const o = document.createElement("option");
        o.value = "mtnode_" + p.route;
        o.textContent = p.name;
        provSel.appendChild(o);
      }
      if (group.modelOnly && group.keepRoute) {
        const hit = [...provSel.options].some((o) => o.value === group.keepRoute);
        if (hit) provSel.value = group.keepRoute;
      }
    } else {
      const list = apiProvidersForKind(group.type);
      if (!list.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = I18n.t("（请先在设置中添加服务商）");
        provSel.appendChild(o);
      } else {
        for (const p of list) {
          const o = document.createElement("option");
          o.value = p.id;
          o.textContent = p.name || p.id;
          provSel.appendChild(o);
        }
        if (group.modelOnly && group.keepProviderId) {
          const hit = list.some((p) => p.id === group.keepProviderId);
          if (hit) provSel.value = group.keepProviderId;
        }
      }
    }
    provSel.onchange = fillModels;
    fillModels();
    provLab.appendChild(provSel);
    modelLab.appendChild(modelSel);
    body.appendChild(provLab);
    body.appendChild(modelLab);

    foot.innerHTML = "";
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      closeOverlay();
      resolve(val);
    };
    const skip = document.createElement("button");
    skip.className = "mini";
    skip.textContent = I18n.t("跳过此服务商");
    skip.onclick = () => finish(null);
    const ok = document.createElement("button");
    ok.className = "mini primary";
    ok.textContent = I18n.t("批量替换");
    ok.onclick = () => {
      const pv = provSel.value;
      const mv = modelSel.value;
      if (!pv) {
        toast(I18n.t("请先在设置中添加可用的服务商"), "warn");
        return;
      }
      if (!mv) {
        toast(I18n.t("请选择模型"), "warn");
        return;
      }
      if (group.mode === "agent") finish({ route: pv, model: mv });
      else finish({ providerId: pv, model: mv });
    };
    foot.appendChild(skip);
    foot.appendChild(ok);
  });
}

async function sanitizeInvalidProviders(wf, opts) {
  opts = opts || {};
  if (!wf) return 0;
  const groups = collectInvalidProviderGroups(wf);
  if (!groups.length) return 0;
  if (!opts.quiet) {
    await showInfoOverlay(
      I18n.t("检测到无效模型配置"),
      I18n.t(
        "当前画布含有本机不存在的服务商或模型（常见于他人模板）。接下来将按每个无效服务商分别询问，批量替换为你自己的服务商。",
      ),
      groups
        .map(
          (g) =>
            "· " +
            g.badLabel +
            " → " +
            g.nodes.length +
            I18n.t(" 个节点"),
        )
        .join("\n"),
    );
  }
  let nChanged = 0;
  for (const g of groups) {
    const pick = await promptReplaceProviderGroup(g);
    if (!pick) continue;
    for (const node of g.nodes) {
      if (g.mode === "agent") {
        node.provider = pick.route;
        node.model = pick.model;
        node.vision = null;
      } else {
        node.providerId = pick.providerId;
        node.model = pick.model;
      }
      nChanged++;
    }
  }
  if (nChanged) scheduleSave(true);
  return nChanged;
}

async function sanitizeWfEnvironment(opts) {
  opts = opts || {};
  if (S._sanitizingEnv) return;
  S._sanitizingEnv = true;
  try {
    await sanitizeInvalidWorkspaces(opts);
    if (S.wf) await sanitizeInvalidProviders(S.wf, opts);
  } finally {
    S._sanitizingEnv = false;
  }
}

/* Base64 导出结果展示：含多媒体或体积较大时提示改用文件 */
async function doExportBase64() {
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.innerHTML = "";
  foot.innerHTML = "";
  const data = cloneWfForExport();
  if (!data) {
    body.appendChild(hintEl(I18n.t("导出失败：画布包含无法序列化的数据")));
    foot.appendChild(mkMiniBtn(I18n.t("返回"), exportWorkflowDialog));
    return;
  }
  const r = await window.api.mtnodesExportBase64(data);
  if (!r || !r.ok) {
    body.appendChild(hintEl(I18n.t("导出失败：") + ((r && r.error) || I18n.t("未知错误"))));
    foot.appendChild(mkMiniBtn(I18n.t("返回"), exportWorkflowDialog));
    return;
  }
  if (r.assets > 0 || r.bytes > 1024 * 1024) {
    const warn = hintEl(
      I18n.t("⚠ 本画布包含图像等多媒体资产或体积较大（约 ") +
        fmtBytes(r.bytes) +
        I18n.t("），Base64 会明显膨胀，建议改用「导出为文件」以保证完整可靠。"),
    );
    warn.style.color = "#e6a23c";
    body.appendChild(warn);
  }
  const ta = document.createElement("textarea");
  ta.className = "b64-area";
  ta.readOnly = true;
  ta.spellcheck = false;
  ta.value = r.base64;
  body.appendChild(ta);
  foot.appendChild(mkMiniBtn(I18n.t("返回"), exportWorkflowDialog));
  foot.appendChild(
    mkMiniBtn(I18n.t("复制到剪贴板"), async () => {
      const c = await window.api.clipboardWriteText(r.base64);
      toast(
        c && c.ok
          ? I18n.t("已复制 Base64 到剪贴板（") + fmtBytes(r.bytes) + "）"
          : I18n.t("复制失败：") + ((c && c.error) || I18n.t("未知错误")),
        c && c.ok ? "ok" : "err",
      );
    }, true),
  );
  toast(I18n.t("Base64 已生成（") + fmtBytes(r.bytes) + "）", "ok");
}

/* 导出方式选择 */
function exportWorkflowDialog() {
  if (!S.wf) {
    toast(I18n.t("当前没有已加载的画布"), "err");
    return;
  }
  openOverlay(I18n.t("导出画布"), { persistent: true });
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.appendChild(
    hintEl(
      I18n.t("文件方式适合含图像或体积较大的画布；Base64 适合纯文本小画布，可复制到剪贴板后粘贴到另一台客户端。"),
    ),
  );
  foot.appendChild(mkMiniBtn(I18n.t("取消"), closeOverlay));
  foot.appendChild(mkMiniBtn(I18n.t("导出为文件"), async () => {
    closeOverlay();
    await doExportFile();
  }));
  foot.appendChild(mkMiniBtn(I18n.t("复制为 Base64"), doExportBase64, true));
}

/* Base64 粘贴导入 */
function doImportBase64() {
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.innerHTML = "";
  foot.innerHTML = "";
  body.appendChild(hintEl(I18n.t("粘贴 .mtnodes 的 Base64 内容：")));
  const ta = document.createElement("textarea");
  ta.className = "b64-area";
  ta.placeholder = I18n.t("粘贴 Base64 内容…");
  ta.spellcheck = false;
  body.appendChild(ta);
  foot.appendChild(mkMiniBtn(I18n.t("返回"), importWorkflowDialog));
  foot.appendChild(mkMiniBtn(I18n.t("导入"), async () => {
    const r = await window.api.mtnodesImportBase64(ta.value);
    if (!r || !r.ok) {
      toast(I18n.t("导入失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
      return;
    }
    closeOverlay();
    adoptImportedWorkflow(r.workflow);
  }, true));
}

/* 导入方式选择 */
function importWorkflowDialog() {
  openOverlay(I18n.t("导入画布"), { persistent: true });
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.appendChild(hintEl(I18n.t("选择导入方式：从 .mtnodes 文件，或粘贴 Base64 内容。")));
  foot.appendChild(mkMiniBtn(I18n.t("取消"), closeOverlay));
  foot.appendChild(mkMiniBtn(I18n.t("从文件导入"), async () => {
    closeOverlay();
    await doImportFile();
  }));
  foot.appendChild(mkMiniBtn(I18n.t("粘贴 Base64"), doImportBase64, true));
}


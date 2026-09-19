"use strict";
/* ============ 专家团 · 图标目录（空心线条 SVG） ============
 *
 * 本文件是「专家头像图标」的**唯一真源**：图标键、中文标签、分组与 SVG 路径只写在这里；
 * 数据层（app-team.js）的 Expert.icon 只存键，渲染层（app-teamview.js / app-team-recruit.js）
 * 一律用 teamIconSvg(key) 取图，不得自抄一份路径表。
 *
 * 统一口径（与用户要求一致）：
 *   · 全部为 16×16 空心线条图标：fill:none、stroke:currentColor、stroke-width 1.3、圆头圆角；
 *   · 颜色不写死 —— 由宿主元素（.team-avatar 等）的 color 决定，专家色只落在描边上；
 *   · 头像底色用主题色（var(--panel2)），因此图标在深色 / 浅色主题下都清晰。
 *
 * 加载顺序：renderer/index.html 中位于 app-team.js 之前（数据层归一化要用到 teamIconFromGlyph）。
 *
 * 公开接口：window.MTNodeTeamIcons（同时把 teamIcon* 函数留在全局）。
 *   teamIconKeys()            → ["person", ...]
 *   teamIconCatalog()         → [{ key, label, group, svg }]
 *   teamIconSvg(key, opts)    → 完整 <svg>…</svg> 字符串（opts.size 默认 16）
 *   teamIconInner(key)        → 仅路径内容（供自行拼 svg 的调用方）
 *   teamIconLabel(key)        → 中文标签（有 I18n 时走翻译）
 *   teamIconGroup(key)        → 分组名
 *   teamIconFromGlyph(emoji)  → 旧 emoji 头像迁移到图标键（映射不到返回 ""）
 *   teamIconHas(key)          → 是否为合法图标键
 */
(function () {
  /* 默认图标：迁移映射不到、或键非法时兜底。 */
  var DEFAULT_ICON = "person";

  /* 分组顺序 = 图标选择器里的分组顺序。 */
  var GROUPS = [
    { id: "role", label: "角色" },
    { id: "roleplay", label: "角色扮演" },
    { id: "dev", label: "研发" },
    { id: "data", label: "数据" },
    { id: "ops", label: "运维" },
    { id: "design", label: "设计" },
    { id: "business", label: "商业" },
    { id: "content", label: "内容" },
  ];

  /* 每个图标的 svg 只存 <svg> 内部内容（viewBox 0 0 16 16），统一由 teamIconSvg 包壳。 */
  var CATALOG = [
    /* ── 角色 ── */
    {
      key: "person",
      label: "人物",
      group: "role",
      svg: '<circle cx="8" cy="5.2" r="2.4"/><path d="M3.2 13.5c0-2.6 2.1-4.2 4.8-4.2s4.8 1.6 4.8 4.2"/>',
    },
    {
      key: "users",
      label: "团队",
      group: "role",
      svg: '<circle cx="6" cy="5.4" r="2"/><path d="M2 13.2c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6"/><path d="M11 4.2a2 2 0 0 1 0 3.9"/><path d="M12 9.9c1.4.4 2.4 1.5 2.4 3.1"/>',
    },
    {
      key: "crown",
      label: "负责人",
      group: "role",
      svg: '<path d="M2.5 11.5 1.6 4.6l3.4 2.3L8 3.2l3 3.7 3.4-2.3-.9 6.9z"/><path d="M3 13.4h10"/>',
    },
    {
      key: "robot",
      label: "AI",
      group: "role",
      svg: '<rect x="3" y="5" width="10" height="7.5" rx="2"/><path d="M8 5V2.6"/><circle cx="8" cy="2.2" r=".7"/><circle cx="6" cy="8.4" r=".9"/><circle cx="10" cy="8.4" r=".9"/><path d="M6.4 10.8h3.2"/>',
    },
    {
      key: "compass",
      label: "战略",
      group: "role",
      svg: '<circle cx="8" cy="8" r="6.2"/><path d="m10.6 5.4-1.5 3.7-3.7 1.5 1.5-3.7z"/>',
    },
    {
      key: "target",
      label: "目标",
      group: "role",
      svg: '<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="3.4"/><circle cx="8" cy="8" r=".7"/>',
    },
    {
      key: "chat",
      label: "沟通",
      group: "role",
      svg: '<path d="M13.5 8.6c0 2.5-2.5 4.5-5.5 4.5-.6 0-1.2-.1-1.8-.2L3 14.4l.9-2.4C2.9 11.2 2.5 10 2.5 8.6c0-2.5 2.5-4.5 5.5-4.5s5.5 2 5.5 4.5Z"/>',
    },
    {
      key: "shield",
      label: "安全",
      group: "role",
      svg: '<path d="M8 1.8 13 3.6v4c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6v-4z"/>',
    },
    {
      key: "scale",
      label: "法务",
      group: "role",
      svg: '<path d="M8 2.2v11.6M4.4 13.8h7.2"/><path d="M8 4.2 3 5.6l-1.4 3h4.8z"/><path d="M8 4.2l5 1.4 1.4 3h-4.8z"/>',
    },
    {
      key: "briefcase",
      label: "商务",
      group: "role",
      svg: '<rect x="2" y="5.4" width="12" height="8" rx="1.6"/><path d="M6 5.4V4a1.4 1.4 0 0 1 1.4-1.4h1.2A1.4 1.4 0 0 1 10 4v1.4"/><path d="M2 8.6h12"/>',
    },

    /* ── 角色扮演（情绪陪伴类角色头像） ── */
    {
      key: "cat",
      label: "猫娘",
      group: "roleplay",
      svg: '<path d="M4.4 5.4 3.6 2.6l2.7 1.4"/><path d="M11.6 5.4 12.4 2.6l-2.7 1.4"/><circle cx="8" cy="8.6" r="4.2"/><circle cx="6.3" cy="8.2" r=".6"/><circle cx="9.7" cy="8.2" r=".6"/><path d="M7.2 10.4c.5.4 1.1.4 1.6 0"/><path d="M1.8 7.4h2M12.2 7.4h2"/>',
    },
    {
      key: "heart",
      label: "倾听",
      group: "roleplay",
      svg: '<path d="M8 13.2S2.6 9.9 2.6 6.6A3 3 0 0 1 8 4.9a3 3 0 0 1 5.4 1.7c0 3.3-5.4 6.6-5.4 6.6Z"/>',
    },
    {
      key: "moon",
      label: "深夜",
      group: "roleplay",
      svg: '<path d="M12.6 9.6A5.4 5.4 0 0 1 6.4 3.4a5.4 5.4 0 1 0 6.2 6.2Z"/><path d="M11 2.8v1.6M10.2 3.6h1.6"/>',
    },
    {
      key: "sun",
      label: "元气",
      group: "roleplay",
      svg: '<circle cx="8" cy="8" r="3"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3"/>',
    },

    /* ── 研发 ── */
    {
      key: "code",
      label: "代码",
      group: "dev",
      svg: '<path d="m5.6 5-3.4 3 3.4 3M10.4 5l3.4 3-3.4 3M9.2 3.4 6.8 12.6"/>',
    },
    {
      key: "terminal",
      label: "终端",
      group: "dev",
      svg: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><path d="m4.6 6.4 2 1.8-2 1.8M8.4 10.2h3"/>',
    },
    {
      key: "bug",
      label: "调试",
      group: "dev",
      svg: '<path d="M5 6.2a3 3 0 0 1 6 0v2.2a3 3 0 0 1-6 0z"/><path d="M6 3.4 4.8 2.2M10 3.4l1.2-1.2M5 8.4H2.6M11 8.4h2.4M5.4 11l-1.4 1.6M10.6 11l1.4 1.6"/>',
    },
    {
      key: "test",
      label: "测试",
      group: "dev",
      svg: '<path d="M6 2.2h4v2.2l3 6.4a1.8 1.8 0 0 1-1.6 2.6H4.6A1.8 1.8 0 0 1 3 10.8l3-6.4z"/><path d="M5 2.2h6M4.6 9.6h6.8"/>',
    },
    {
      key: "database",
      label: "数据库",
      group: "dev",
      svg: '<ellipse cx="8" cy="3.6" rx="4.8" ry="1.9"/><path d="M3.2 3.6v8.8c0 1 2.1 1.9 4.8 1.9s4.8-.9 4.8-1.9V3.6"/><path d="M3.2 8c0 1 2.1 1.9 4.8 1.9S12.8 9 12.8 8"/>',
    },
    {
      key: "server",
      label: "服务器",
      group: "dev",
      svg: '<rect x="2.4" y="2.6" width="11.2" height="4.4" rx="1.2"/><rect x="2.4" y="9" width="11.2" height="4.4" rx="1.2"/><path d="M4.8 4.8h.01M4.8 11.2h.01"/>',
    },
    {
      key: "cloud",
      label: "云",
      group: "dev",
      svg: '<path d="M4.6 12.4h7a2.9 2.9 0 0 0 .3-5.8A3.8 3.8 0 0 0 4.6 7.3a2.6 2.6 0 0 0 0 5.1Z"/>',
    },
    {
      key: "api",
      label: "接口",
      group: "dev",
      svg: '<rect x="1.8" y="4.4" width="12.4" height="7.2" rx="1.6"/><path d="M1.8 8h12.4M4.6 6.2h.01M6.8 6.2h.01"/>',
    },
    {
      key: "branch",
      label: "分支",
      group: "dev",
      svg: '<circle cx="4.4" cy="3.8" r="1.5"/><circle cx="4.4" cy="12.2" r="1.5"/><circle cx="11.6" cy="6.2" r="1.5"/><path d="M4.4 5.3v5.4M5.9 6.2h4.2"/>',
    },
    {
      key: "chip",
      label: "算力",
      group: "dev",
      svg: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.2"/><path d="M6.8 1.8v2.8M9.2 1.8v2.8M6.8 11.4v2.8M9.2 11.4v2.8M1.8 6.8h2.8M1.8 9.2h2.8M11.4 6.8h2.8M11.4 9.2h2.8"/>',
    },
    {
      key: "mobile",
      label: "移动端",
      group: "dev",
      svg: '<rect x="4.4" y="1.8" width="7.2" height="12.4" rx="1.8"/><path d="M7.2 12.2h1.6"/>',
    },
    {
      key: "browser",
      label: "前端",
      group: "dev",
      svg: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6"/><path d="M1.8 5.6h12.4M4.2 4.1h.01M6 4.1h.01"/>',
    },
    {
      key: "module",
      label: "模块",
      group: "dev",
      svg: '<rect x="1.8" y="1.8" width="5.2" height="5.2" rx="1.2"/><rect x="9" y="1.8" width="5.2" height="5.2" rx="1.2"/><rect x="1.8" y="9" width="5.2" height="5.2" rx="1.2"/><rect x="9" y="9" width="5.2" height="5.2" rx="1.2"/>',
    },
    {
      key: "wrench",
      label: "工具",
      group: "dev",
      svg: '<path d="M10.6 2.2a3.4 3.4 0 0 0-3 5.3L2.6 12.5l1 1 5-5a3.4 3.4 0 0 0 4.2-4.4l-2 2-1.6-.4-.4-1.6z"/>',
    },
    {
      key: "rocket",
      label: "部署",
      group: "dev",
      svg: '<path d="M8 1.8c2.2 1 3.4 3.2 3.4 5.6 0 1.4-.5 2.6-1.2 3.6H5.8c-.7-1-1.2-2.2-1.2-3.6C4.6 5 5.8 2.8 8 1.8Z"/><circle cx="8" cy="7" r="1.1"/><path d="m5.8 11-.8 3 2-1.2h2l2 1.2-.8-3"/>',
    },

    /* ── 数据 ── */
    {
      key: "chart-bar",
      label: "柱状图",
      group: "data",
      svg: '<path d="M2.2 13.4h11.6"/><rect x="3.4" y="8" width="2.4" height="4.2"/><rect x="6.8" y="5.2" width="2.4" height="7"/><rect x="10.2" y="9.4" width="2.4" height="2.8"/>',
    },
    {
      key: "chart-line",
      label: "趋势",
      group: "data",
      svg: '<path d="M2.2 13.4h11.6M3 10.6l3-3 2.2 2.2 4.4-4.6"/><circle cx="12.6" cy="5.2" r=".8"/>',
    },
    {
      key: "table",
      label: "表格",
      group: "data",
      svg: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4"/><path d="M1.8 6.2h12.4M6.4 6.2v7M10.6 6.2v7"/>',
    },
    {
      key: "funnel",
      label: "筛选",
      group: "data",
      svg: '<path d="M2.2 3h11.6l-4.4 5v4.6l-2.8 1.4V8z"/>',
    },
    {
      key: "sigma",
      label: "统计",
      group: "data",
      svg: '<path d="M11.4 3H4.6l3.6 5-3.6 5h6.8"/>',
    },
    {
      key: "brain",
      label: "分析",
      group: "data",
      svg: '<path d="M7.4 2.6A2.6 2.6 0 0 0 4 4.4a2.2 2.2 0 0 0-1 4 2.4 2.4 0 0 0 1.6 3.6A2.4 2.4 0 0 0 7.4 13z"/><path d="M8.6 2.6A2.6 2.6 0 0 1 12 4.4a2.2 2.2 0 0 1 1 4 2.4 2.4 0 0 1-1.6 3.6A2.4 2.4 0 0 1 8.6 13z"/><path d="M8 2.4v10.8"/>',
    },

    /* ── 运维 ── */
    {
      key: "gear",
      label: "配置",
      group: "ops",
      svg: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4"/>',
    },
    {
      key: "monitor",
      label: "监控",
      group: "ops",
      svg: '<rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.4"/><path d="M5.6 14h4.8M8 11.2V14"/><path d="M4.4 7.6h1.8l1-1.6 1.2 3 .9-1.4h2.3"/>',
    },
    {
      key: "network",
      label: "网络",
      group: "ops",
      svg: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="2.6" r="1.2"/><circle cx="3.2" cy="12" r="1.2"/><circle cx="12.8" cy="12" r="1.2"/><path d="M8 3.8v2.2M6.6 9.3 4.2 11.1M9.4 9.3l2.4 1.8"/>',
    },
    {
      key: "lock",
      label: "权限",
      group: "ops",
      svg: '<rect x="3.4" y="7" width="9.2" height="6.4" rx="1.6"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7M8 9.6v2"/>',
    },
    {
      key: "key",
      label: "密钥",
      group: "ops",
      svg: '<circle cx="5.4" cy="10.6" r="2.6"/><path d="m7.4 8.6 5.4-5.4M10.4 5.6l1.4 1.4M12 4l1.4 1.4"/>',
    },
    {
      key: "clock",
      label: "时效",
      group: "ops",
      svg: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.4V8l2.6 1.6"/>',
    },
    {
      key: "refresh",
      label: "迭代",
      group: "ops",
      svg: '<path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8"/><path d="M13.6 2.6v2.6h-2.6"/>',
    },
    {
      key: "bell",
      label: "告警",
      group: "ops",
      svg: '<path d="M4.4 11.2V7.4a3.6 3.6 0 0 1 7.2 0v3.8l1.2 1.4H3.2z"/><path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0"/>',
    },

    /* ── 设计 ── */
    {
      key: "pen",
      label: "写作",
      group: "design",
      svg: '<path d="M11.4 2.4 13.6 4.6 6 12.2l-3.4 1.4 1.4-3.4z"/><path d="m9.8 4 2.2 2.2"/>',
    },
    {
      key: "palette",
      label: "设计",
      group: "design",
      svg: '<path d="M8 2a6 6 0 0 0 0 12c1 0 1.6-.7 1.6-1.5 0-.5-.2-.8-.5-1.1-.3-.3-.5-.6-.5-1 0-.8.7-1.4 1.5-1.4H11A3 3 0 0 0 14 6c0-2.2-2.7-4-6-4Z"/><circle cx="5.4" cy="6.4" r=".8"/><circle cx="8.6" cy="5" r=".8"/><circle cx="11" cy="7.4" r=".8"/>',
    },
    {
      key: "layout",
      label: "布局",
      group: "design",
      svg: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.4"/><path d="M1.8 6.4h12.4M6.6 6.4v7"/>',
    },
    {
      key: "image",
      label: "视觉",
      group: "design",
      svg: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.4"/><circle cx="5.6" cy="6.2" r="1.2"/><path d="m2.6 12.2 3.6-3.4 2.4 2.2 2-1.8 2.8 2.6"/>',
    },
    {
      key: "type",
      label: "字体",
      group: "design",
      svg: '<path d="M3 4.4V3h10v1.4M8 3v10M6 13h4"/>',
    },
    {
      key: "book",
      label: "文档",
      group: "design",
      svg: '<path d="M2.4 3.2A1.4 1.4 0 0 1 3.8 1.8h4.4v12.4H3.8A1.4 1.4 0 0 0 2.4 12.8z"/><path d="M13.6 3.2A1.4 1.4 0 0 0 12.2 1.8H7.8v12.4h4.4a1.4 1.4 0 0 1 1.4 1.4z"/>',
    },

    /* ── 商业 ── */
    {
      key: "coin",
      label: "财务",
      group: "business",
      svg: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6v6.8"/><path d="M10 6.2c-.4-.6-1.1-1-2-1-1.1 0-2 .6-2 1.4 0 1.8 4 1 4 2.8 0 .8-.9 1.4-2 1.4-.9 0-1.6-.4-2-1"/>',
    },
    {
      key: "wallet",
      label: "预算",
      group: "business",
      svg: '<rect x="1.8" y="4" width="12.4" height="9" rx="1.6"/><path d="M1.8 7h12.4M11 10h1.4"/>',
    },
    {
      key: "megaphone",
      label: "增长",
      group: "business",
      svg: '<path d="M13 3.4v9.2l-5-2.6H3.8A1.4 1.4 0 0 1 2.4 8.6V7.4A1.4 1.4 0 0 1 3.8 6H8z"/><path d="M5.4 10v2.6a1.2 1.2 0 0 0 2.4 0V10.6"/>',
    },
    {
      key: "globe",
      label: "本地化",
      group: "business",
      svg: '<circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4"/><path d="M8 1.8c1.8 1.8 2.6 4 2.6 6.2S9.8 12.4 8 14.2C6.2 12.4 5.4 10.2 5.4 8S6.2 3.6 8 1.8Z"/>',
    },
    {
      key: "calendar",
      label: "排期",
      group: "business",
      svg: '<rect x="1.8" y="3.4" width="12.4" height="10" rx="1.4"/><path d="M1.8 6.6h12.4M5 1.8v3.2M11 1.8v3.2"/>',
    },
    {
      key: "folder",
      label: "归档",
      group: "business",
      svg: '<path d="M1.8 4.4A1.4 1.4 0 0 1 3.2 3h2.8l1.4 1.6h5.4A1.4 1.4 0 0 1 14.2 6v6.2a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z"/>',
    },

    /* ── 内容 ── */
    {
      key: "search",
      label: "检索",
      group: "content",
      svg: '<circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3.2 3.2"/>',
    },
    {
      key: "lightbulb",
      label: "创意",
      group: "content",
      svg: '<path d="M8 1.8a4.2 4.2 0 0 1 2.6 7.5c-.5.4-.8.9-.8 1.5H6.2c0-.6-.3-1.1-.8-1.5A4.2 4.2 0 0 1 8 1.8Z"/><path d="M6.4 12.6h3.2M6.9 14.2h2.2"/>',
    },
    {
      key: "mail",
      label: "邮件",
      group: "content",
      svg: '<rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.4"/><path d="m2.4 4.4 5.6 4 5.6-4"/>',
    },
    {
      key: "mic",
      label: "语音",
      group: "content",
      svg: '<rect x="6" y="1.8" width="4" height="7.4" rx="2"/><path d="M3.8 8a4.2 4.2 0 0 0 8.4 0M8 12.2v2M6.2 14.2h3.6"/>',
    },
    {
      key: "video",
      label: "视频",
      group: "content",
      svg: '<rect x="1.8" y="4" width="9" height="8" rx="1.6"/><path d="m10.8 8 3.4-2.2v4.4z"/>',
    },
    {
      key: "star",
      label: "品牌",
      group: "content",
      svg: '<path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
    },
  ];

  /* 旧 emoji 头像 → 图标键（v1→v2 迁移用）。映射不到返回 ""，由调用方走默认键。 */
  var GLYPH_MAP = {
    "🧭": "compass",
    "🧠": "brain",
    "🔍": "search",
    "✍️": "pen",
    "✍": "pen",
    "📊": "chart-bar",
    "📈": "chart-line",
    "🛠️": "wrench",
    "🛠": "wrench",
    "🔧": "wrench",
    "🎯": "target",
    "🧩": "module",
    "📐": "layout",
    "🧪": "test",
    "🧫": "test",
    "💡": "lightbulb",
    "🗂️": "folder",
    "🗂": "folder",
    "📖": "book",
    "📝": "pen",
    "👤": "person",
    "🧑": "person",
    "👥": "users",
    "🤖": "robot",
    "👑": "crown",
    "🛡️": "shield",
    "🛡": "shield",
    "⚖️": "scale",
    "⚖": "scale",
    "💼": "briefcase",
    "💻": "code",
    "🖥️": "monitor",
    "🖥": "monitor",
    "🐞": "bug",
    "🐛": "bug",
    "🗄️": "database",
    "🗄": "database",
    "☁️": "cloud",
    "☁": "cloud",
    "🔌": "api",
    "🔀": "branch",
    "📱": "mobile",
    "🌐": "globe",
    "🚀": "rocket",
    "⚙️": "gear",
    "⚙": "gear",
    "🔒": "lock",
    "🔑": "key",
    "⏱️": "clock",
    "⏱": "clock",
    "🕐": "clock",
    "🔔": "bell",
    "🎨": "palette",
    "🖼️": "image",
    "🖼": "image",
    "🔤": "type",
    "💰": "coin",
    "💵": "coin",
    "👛": "wallet",
    "📣": "megaphone",
    "📅": "calendar",
    "📁": "folder",
    "📬": "mail",
    "🎤": "mic",
    "🎬": "video",
    "⭐": "star",
    "🌟": "star",
    "🧮": "sigma",
    "📋": "table",
    "📉": "chart-line",
  };

  var BY_KEY = {};
  CATALOG.forEach(function (ic) {
    BY_KEY[ic.key] = ic;
  });
  var GROUP_BY_ID = {};
  GROUPS.forEach(function (g) {
    GROUP_BY_ID[g.id] = g;
  });

  function T(s) {
    try {
      return window.I18n && window.I18n.t ? window.I18n.t(s) : String(s);
    } catch (e) {
      return String(s);
    }
  }

  function icon(key) {
    return BY_KEY[String(key == null ? "" : key).trim()] || null;
  }
  function has(key) {
    return !!icon(key);
  }
  function keys() {
    return CATALOG.map(function (ic) {
      return ic.key;
    });
  }
  function catalog() {
    return CATALOG.map(function (ic) {
      return {
        key: ic.key,
        label: T(ic.label),
        group: ic.group,
        groupLabel: (GROUP_BY_ID[ic.group] && T(GROUP_BY_ID[ic.group].label)) || ic.group,
        svg: ic.svg,
      };
    });
  }
  function groups() {
    return GROUPS.map(function (g) {
      return { id: g.id, label: T(g.label) };
    });
  }
  function inner(key) {
    var ic = icon(key) || BY_KEY[DEFAULT_ICON];
    return ic ? ic.svg : "";
  }
  function label(key) {
    var ic = icon(key);
    return ic ? T(ic.label) : "";
  }
  function groupOf(key) {
    var ic = icon(key);
    return ic ? ic.group : "";
  }
  function svg(key, opts) {
    var size = opts && Number(opts.size) > 0 ? Math.floor(Number(opts.size)) : 16;
    var cls = opts && opts.className ? " " + String(opts.className) : " team-icon";
    return (
      '<svg class="' +
      String(cls).trim() +
      '" viewBox="0 0 16 16" width="' +
      size +
      '" height="' +
      size +
      '" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      inner(key) +
      "</svg>"
    );
  }
  /* 旧 emoji → 图标键；命中返回键，否则返回 ""（调用方用 DEFAULT_ICON 兜底）。 */
  function fromGlyph(glyph) {
    var s = String(glyph == null ? "" : glyph).trim();
    if (!s) return "";
    if (GLYPH_MAP[s]) return GLYPH_MAP[s];
    /* 兼容「emoji + 空格 / 变体选择符」写法：逐个字符尝试。 */
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (GLYPH_MAP[ch]) return GLYPH_MAP[ch];
    }
    return "";
  }
  /* 归一化任意输入（图标键 / 旧 emoji / 空）→ 合法图标键。 */
  function normalize(keyOrGlyph, fallback) {
    var k = String(keyOrGlyph == null ? "" : keyOrGlyph).trim();
    if (has(k)) return k;
    var g = fromGlyph(k);
    if (g) return g;
    return has(fallback) ? fallback : DEFAULT_ICON;
  }

  var API = {
    DEFAULT_ICON: DEFAULT_ICON,
    GROUPS: GROUPS,
    GLYPH_MAP: GLYPH_MAP,
    keys: keys,
    catalog: catalog,
    groups: groups,
    has: has,
    icon: icon,
    inner: inner,
    svg: svg,
    label: label,
    group: groupOf,
    fromGlyph: fromGlyph,
    normalize: normalize,
  };
  window.MTNodeTeamIcons = API;

  window.teamIconKeys = keys;
  window.teamIconCatalog = catalog;
  window.teamIconGroups = groups;
  window.teamIconHas = has;
  window.teamIconSvg = svg;
  window.teamIconInner = inner;
  window.teamIconLabel = label;
  window.teamIconGroup = groupOf;
  window.teamIconFromGlyph = fromGlyph;
  window.teamIconNormalize = normalize;
})();

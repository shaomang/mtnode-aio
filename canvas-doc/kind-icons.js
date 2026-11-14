/* canvas-doc/kind-icons.js —— 节点标题栏那颗**种类图标**（16×16 线性 SVG，stroke=currentColor）
 * ============================================================================
 * 一句话：kind（以及 agent / control 角色 / db / dev / tool 这些变体键）→ 一枚内联 SVG 字符串。
 *
 * 为什么单独成文件：这枚图标要画在**两个地方**，而且必须是同一份：
 *   · 应用里的节点标题栏（renderer/app.js 的 fillNodeKindIcon → const KIND_ICON_SVG = MTKindIcons.SVG）
 *   · 画布读侧内核的场景树（canvas-doc/canvas-doc-render.js 的 nodeTree → button.n-drag-handle）
 *     —— take 单文件回放页 / 宿主预览都走这一条，页面里没有 app.js。
 * 复制第二份的话，两边迟早长得不一样（这正是「回放里的节点和源画布不一样」的由来）。
 *
 * 两处入口（与 canvas-take / canvas-doc-render 同一口径）：
 *   · 浏览器：页面先引本文件，挂 globalThis.MTKindIcons
 *   · Node（主进程 / 脚本 / 冒烟）：require("canvas-doc/kind-icons.js") 拿同一份
 *
 * 纪律：
 *   · 只放「图标长什么样」。哪种节点用哪个键由各自的真源决定：应用侧 nodeKindIconKey()，
 *     内核侧 iconKeyOf() —— 两边都只算键，不碰 SVG 内容。
 *   · 这个对象是可变的：插件（app-nodeplugins.js）与内置应用（app-appnode.js）会往里加键，
 *     所以对外暴露的是**同一个对象引用**，不是拷贝。
 * ============================================================================
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTKindIcons = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* 节点标题栏拖动手柄图标（SVG，stroke=currentColor） */
  const SVG = {
  /* 输入 · 文本：三行文字 */
  input_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h8M3 11.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  /* 输入 · 图像：相框风景 */
  input_image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="7" r="1.1" fill="currentColor"/><path d="M3.5 11.2l3.2-3.2 2.1 2.1 1.6-1.6 2.1 2.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 输入 · 文件：文档 + 折角 + 字符行 */
  input_file:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 2.6h6.2l2.9 2.9v8a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V2.6z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.4 2.8v2.7H12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.4 8.2h5.2M5.4 10.3h5.2M5.4 12.4h3.4" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 输入 · 泛用文件（上传任意文件 → 自动转为对应输入节点）：托盘 + 向上箭头 */
  input_any:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.3v6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5.5 4.8L8 2.3l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.6 9.2v3.1a1.2 1.2 0 0 0 1.2 1.2h8.4a1.2 1.2 0 0 0 1.2-1.2V9.2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  /* 输入 · 音频：喇叭 + 声波（选择本机文件 · 输出 URL） */
  input_audio:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 6.2h2.1L8.4 3.6v8.8L5.3 9.8H3.2a.7.7 0 0 1-.7-.7V6.9a.7.7 0 0 1 .7-.7z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M10.8 6.1c.8.9.8 3 0 3.9M12.7 4.4c1.5 1.7 1.5 5.5 0 7.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 输入 · 视频：胶片框 + 播放三角（选择本机文件 · 输出 URL） */
  input_video:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3.6" width="12" height="8.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M2 6.1h12M2 9.9h12" fill="none" stroke="currentColor" stroke-width="1" opacity=".65"/><path d="M6.9 7.1l2.6 1.9-2.6 1.9V7.1z" fill="currentColor"/></svg>',
  /* 输入 · 表单：表单框 + 勾选行（结构化 JSON · 可拖入素材 · 图像/视频带描述与注释） */
  input_form:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M4.6 5.2h6.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4.6 8h3.4M4.6 10.8h3.4" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><path d="M9.9 9.6l1.1 1.1 2.1-2.3" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
  /* PDF 生成：文档纸 + 折角 + 导出箭头（与保存族同色） */
  save_pdf:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.6h5.2L12 5.6V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.6z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.1 2.9V5.5H11.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 7.3v3.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M6.5 9.4L8 10.9l1.5-1.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 交付节点：收件箱 + 勾选（长周期任务的人工交付落点） */
  deliver:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 9.2 4 3.4h8l1.6 5.8V12a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V9.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.4 9.2h3.2l.7 1.4h3.4l.7-1.4h3.2" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="M6.3 6.1l1.3 1.3 2.4-2.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 产出节点：文档纸 + 铅笔（长周期任务执行中产出的可编辑落点） */
  ltout:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 2.6h5.4l3 3v7.8a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1V2.6z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M8.9 2.9v2.9h2.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.7 8.1h3.2M5.7 10.2h2.2" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><path d="M12.9 8.2l1 1-2.7 2.7-1.3.3.3-1.3z" fill="currentColor" opacity=".85"/></svg>',
  /* 任务 · 规划步骤 */
  task:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M4.6 6.1l1.5 1.5 3.4-3.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.6 10.6h6.8M4.6 12.4h4.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 节点层 */
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
  /* 质检节点（五种共用「对勾徽标」语汇：主体 = 被检对象的样子，右下角永远有一枚勾，
     一眼分清「检的是什么」而不必读标题） */
  qa_text:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 3.2h10.8M2.6 6.2h8.6M2.6 9.2h5.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9.2 12.6l1.4 1.4 3-3.2" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  qa_image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.8" width="11.6" height="8.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><circle cx="5.4" cy="5.6" r="1" fill="currentColor"/><path d="M3.2 9.7l2.6-2.6 1.7 1.6 1.4-1.3 1.7 2.3" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.2 12.6l1.4 1.4 3-3.2" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  qa_video:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.6" width="11.6" height="8.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M2.2 5.1h11.6M2.2 8.3h11.6" fill="none" stroke="currentColor" stroke-width="1" opacity=".6"/><path d="M6.9 5.9l2.6 1.8-2.6 1.8V5.9z" fill="currentColor"/><path d="M9.2 12.6l1.4 1.4 3-3.2" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  qa_audio:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 6.1h1.9L7 3.7v8.2L4.3 9.5H2.4a.6.6 0 0 1-.6-.6V6.7a.6.6 0 0 1 .6-.6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 5.9c.8.9.8 2.8 0 3.7M10.8 4.3c1.5 1.7 1.5 5.2 0 6.9" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><path d="M9.4 12.8l1.3 1.3 2.8-3" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  qa_file:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 2.4h5.6l2.8 2.8v6.4a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V2.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.8 2.6v2.5h2.5" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="M5.2 7.2h4.2M5.2 9.2h2.8" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path d="M9.4 12.8l1.3 1.3 2.8-3" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 需求等待 */
  wait_file:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h5.2L12 5.6V13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.8z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.1 2.9V5.5H11.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="9.2" r="2.1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 8.1v1.4l.9.5" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 定时触发器 */
  timer:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.6v3.6l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 2.8l1.3 1.3M12.8 2.8l-1.3 1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  /* 延时器 */
  delayer:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h4.2M8.8 8H13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 6.6v1.6l1.1.7" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
  /* 弹窗节点：浮层窗 + 两行文字（控制流触发时弹出，内容可编辑） */
  popup:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.6" width="11.6" height="8.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M4.4 2.8v1.9h7.2V2.8" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".8"/><path d="M4.6 6.2h6.8M4.6 8.3h4.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M5.4 11.2l-.6 2.2 2.6-2.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
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
  /* YuE2 音乐生成：音符 + 下方 ABC 谱线（歌词 → 整曲 · 可编辑谱面） */
  yue_gen:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.6 9.4a1.5 1.5 0 1 1-1.3-1.48V3.6l4.2-.85v4.9a1.5 1.5 0 1 1-1.3-1.48V4.15L9.6 4.55v4.85z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.2 12.4h11.6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M2.2 14.2h11.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity=".7"/><path d="M5.1 9.1V13M8 9.6V12.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
  /* Breeze 语音生成：麦克风 + 底座（音色克隆 / 设计 / 导演） */
  breeze_gen:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6.1" y="1.9" width="3.8" height="8" rx="1.9" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3.4 7.4v.7a4.6 4.6 0 0 0 9.2 0v-.7M8 12.7v1.5M5.6 14.2h4.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M8 4.3v3.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity=".75"/></svg>',
  /* 视频生成 */
  video_gen:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M6.4 6.2l4.2 2.2-4.2 2.2V6.2z" fill="currentColor"/></svg>',
  /* Remotion 视频（React 动效合成 · 本地渲染）：播放框 + 右上生成星火 */
  remotion:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M6.4 6.2l4.2 2.2-4.2 2.2V6.2z" fill="currentColor"/><path d="M12.5 2.3l.45 1.05.9.25-.9.25-.45 1.05-.45-1.05-.9-.25.9-.25z" fill="currentColor"/></svg>',
  /* 视频超分（独立后处理）：画框 + 四角放大箭头 */
  video_upscale:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M6.6 6.6L3 3M6.6 6.6H4.4M6.6 6.6V4.4M9.4 9.4L13 13M9.4 9.4h2.2M9.4 9.4v2.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  /* 视频补帧（独立后处理）：两张叠帧 + 中间加号 */
  video_interp:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="3" width="6.6" height="6.6" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="7" y="6.4" width="6.6" height="6.6" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".85"/><path d="M11.6 3.2v3.2M10 4.8h3.2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
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
/* InfiniteTalk 数字人：与视频生成节点同一枚图标（产物同为 mp4），不另画一套 */
SVG.infinitetalk_gen = SVG.video_gen;
/* SoulX-FlashHead Lite：同一枚视频图标 */
SVG.soulxflashhead_gen = SVG.video_gen;
SVG.flux3klein_gen = SVG.proc_image;
SVG.qwenimage_gen = SVG.proc_image;
/* MOSS-Music 音乐理解：与音乐生成节点同一枚音符图标（输入音频 / 视频，产出分析文本） */
SVG.moss_music = SVG.music_gen;
/* DeepSeek 云端语音合成：麦克风 + 云端小云朵（与本地 Breeze 语音区分「云端」） */
SVG.deepseek_tts =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.2" y="1.7" width="3.4" height="7" rx="1.7" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M2 6.8v.6a4 4 0 0 0 8 0v-.6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M6 10.4v1.5M4.2 11.9h3.6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><path d="M10.2 12.6a2.1 2.1 0 0 1 .4-4.15 2.7 2.7 0 0 1 5.1.75 1.85 1.85 0 0 1-.5 3.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
/* DeepSeek 云端语音识别：声波 + 云端小云朵 */
SVG.deepseek_asr =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 8h1.3M4.2 5.6v4.8M6.8 3.4v9.2M9.4 6.2v3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.2 12.6a2.1 2.1 0 0 1 .4-4.15 2.7 2.7 0 0 1 5.1.75 1.85 1.85 0 0 1-.5 3.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

  /** 按图标键取 SVG；查不到就落到「文本处理」那枚（与 app.js fillNodeKindIcon 的兜底同口径） */
  function get(key) {
    return SVG[String(key == null ? "" : key)] || SVG.proc_text || "";
  }

  return { SVG: SVG, get: get };
});
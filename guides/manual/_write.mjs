/* one-shot: write built-in app manual (zh + en) + SVG diagrams */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(root, "img");
fs.mkdirSync(imgDir, { recursive: true });
fs.mkdirSync(path.join(root, "en"), { recursive: true });

function svgEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function box(x, y, w, h, label, stroke, fill) {
  const tx = x + w / 2;
  const ty = y + h / 2 + 4;
  return `  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>
  <text x="${tx}" y="${ty}" text-anchor="middle" fill="#e8eef6" font-size="12" font-family="Segoe UI,sans-serif">${svgEscape(label)}</text>`;
}

function arrow(x1, y1, x2, y2, color) {
  const c = color || "#f0c14d";
  return `  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="1.8" marker-end="url(#arr)"/>`;
}

function caption(w, h, text) {
  return `  <text x="${w / 2}" y="${h - 12}" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">${svgEscape(text)}</text>`;
}

function diagram(inner, w, h) {
  const W = w || 560;
  const H = h || 200;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0d1016"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#f0c14d"/>
    </marker>
  </defs>
${inner}
</svg>
`;
}

const GOLD = "#f0c14d";
const CYAN = "#38d6ff";
const ORNG = "#ff8f2e";
const GRN = "#5fd68a";
const RED = "#ff6b6b";
const FILL_C = "#1a1610";
const FILL_D = "#101820";
const FILL_P = "#1a140e";
const FILL_G = "#101610";

const diagrams = {
  "first-run": diagram(
    [
      box(24, 48, 110, 48, "1 配置 Key", CYAN, FILL_D),
      arrow(134, 72, 168, 72, CYAN),
      box(168, 48, 120, 48, "2 添加节点", ORNG, FILL_P),
      arrow(288, 72, 322, 72, ORNG),
      box(322, 48, 110, 48, "3 连线", GOLD, FILL_C),
      arrow(432, 72, 466, 72, GOLD),
      box(466, 48, 90, 48, "4 ▶ 运行", GRN, FILL_G),
      caption(580, 160, "第一次使用：设置 → 编排 → 运行"),
    ].join("\n"),
    580,
    160,
  ),
  "ui-tour": diagram(
    [
      `  <rect x="20" y="18" width="520" height="28" rx="4" fill="#161b24" stroke="${ORNG}" stroke-width="1.4"/>`,
      `  <text x="36" y="37" fill="${ORNG}" font-size="11" font-family="Segoe UI,sans-serif">顶栏 · 工作流 / 智能会话 / 文档 / 插件 / 审批</text>`,
      `  <rect x="20" y="52" width="92" height="108" rx="4" fill="${FILL_D}" stroke="${CYAN}" stroke-width="1.4"/>`,
      `  <text x="66" y="108" text-anchor="middle" fill="#e8eef6" font-size="11" font-family="Segoe UI,sans-serif">节点树</text>`,
      `  <rect x="120" y="52" width="320" height="108" rx="4" fill="#12161e" stroke="${GOLD}" stroke-width="1.4"/>`,
      `  <text x="280" y="108" text-anchor="middle" fill="#e8eef6" font-size="12" font-family="Segoe UI,sans-serif">画布</text>`,
      `  <rect x="448" y="52" width="92" height="108" rx="4" fill="${FILL_P}" stroke="${ORNG}" stroke-width="1.4"/>`,
      `  <text x="494" y="108" text-anchor="middle" fill="#e8eef6" font-size="11" font-family="Segoe UI,sans-serif">助手栏</text>`,
      caption(560, 188, "界面分区：顶栏 · 左侧节点树 · 中央画布 · 右侧全局助手"),
    ].join("\n"),
    560,
    188,
  ),
  "nodes-wires": diagram(
    [
      box(30, 54, 120, 52, "文本输入", CYAN, FILL_D),
      arrow(150, 80, 214, 80, CYAN),
      box(214, 54, 130, 52, "文本处理", ORNG, FILL_P),
      arrow(344, 80, 408, 80, ORNG),
      box(408, 54, 120, 52, "保存 YAML", GRN, FILL_G),
      caption(560, 160, "从输出端子拖到输入端子；运行会自动先跑上游"),
    ].join("\n"),
    560,
    160,
  ),
  batch: diagram(
    [
      box(24, 36, 100, 40, "条目 A", CYAN, FILL_D),
      box(24, 88, 100, 40, "条目 B", CYAN, FILL_D),
      arrow(124, 56, 178, 80, CYAN),
      arrow(124, 108, 178, 80, CYAN),
      box(178, 58, 120, 44, "处理 · 批量", ORNG, FILL_P),
      arrow(298, 80, 352, 80, ORNG),
      box(352, 36, 110, 40, "结果 A", GRN, FILL_G),
      box(352, 88, 110, 40, "结果 B", GRN, FILL_G),
      caption(490, 168, "批量：逐条运行；聚合则合并为一次"),
    ].join("\n"),
    490,
    168,
  ),
  "io-proc": diagram(
    [
      box(20, 50, 96, 48, "输入", CYAN, FILL_D),
      arrow(116, 74, 156, 74, CYAN),
      box(156, 50, 110, 48, "处理 / 智能", ORNG, FILL_P),
      arrow(266, 74, 306, 74, ORNG),
      box(306, 50, 96, 48, "保存", GRN, FILL_G),
      box(420, 50, 110, 48, "对话 / 任务", GOLD, FILL_C),
      caption(550, 150, "数据沿连线流动；任务与对话走控制流或会话"),
    ].join("\n"),
    550,
    150,
  ),
  "task-flow": diagram(
    [
      box(24, 62, 88, 40, "起点", GOLD, FILL_C),
      arrow(112, 82, 150, 82, GOLD),
      box(150, 62, 100, 40, "工作步骤", ORNG, FILL_P),
      arrow(250, 82, 288, 82, GOLD),
      box(288, 30, 92, 40, "成功终点", GRN, FILL_G),
      box(288, 94, 92, 40, "失败终点", RED, "#1a1010"),
      arrow(250, 74, 288, 50, GRN),
      arrow(250, 90, 288, 114, RED),
      caption(420, 170, "▶ 点燃起点；到达哪一类终点决定任务成败"),
    ].join("\n"),
    420,
    170,
  ),
  timers: diagram(
    [
      box(24, 58, 130, 48, "定时触发器", GOLD, FILL_C),
      arrow(154, 82, 210, 82, GOLD),
      box(210, 30, 110, 40, "目标 A", ORNG, FILL_P),
      box(210, 94, 110, 40, "目标 B", ORNG, FILL_P),
      arrow(154, 74, 210, 50, GOLD),
      arrow(154, 90, 210, 114, GOLD),
      caption(360, 170, "▶ = 打开闹钟；到点后沿金色控制线脉冲下游"),
    ].join("\n"),
    360,
    170,
  ),
  routing: diagram(
    [
      box(16, 28, 90, 36, "输入 1", CYAN, FILL_D),
      box(16, 78, 90, 36, "输入 2", CYAN, FILL_D),
      box(16, 128, 90, 36, "输入 3", CYAN, FILL_D),
      arrow(106, 46, 150, 88, GOLD),
      arrow(106, 96, 150, 96, GOLD),
      arrow(106, 146, 150, 104, GOLD),
      box(150, 74, 100, 44, "闸门 AND", GOLD, FILL_C),
      arrow(250, 96, 296, 96, GOLD),
      box(296, 74, 100, 44, "下游", ORNG, FILL_P),
      caption(430, 188, "闸门按配置的输入路数等待；未接线的端口也会挡住"),
    ].join("\n"),
    430,
    188,
  ),
  dsh: diagram(
    [
      box(20, 58, 120, 48, "智能任务", ORNG, FILL_P),
      arrow(140, 82, 186, 82, ORNG),
      box(186, 20, 100, 36, "读文件", CYAN, FILL_D),
      box(186, 64, 100, 36, "联网", CYAN, FILL_D),
      box(186, 108, 100, 36, "命令", CYAN, FILL_D),
      arrow(286, 38, 332, 70, GOLD),
      arrow(286, 82, 332, 82, GOLD),
      arrow(286, 126, 332, 94, GOLD),
      box(332, 58, 110, 48, "完成结果", GRN, FILL_G),
      caption(460, 176, "智能能力：读文件 / 联网 / 执行命令后给出结果"),
    ].join("\n"),
    460,
    176,
  ),
  providers: diagram(
    [
      box(24, 50, 140, 52, "设置 · 模型服务", GOLD, FILL_C),
      arrow(164, 76, 214, 76, GOLD),
      box(214, 50, 140, 52, "填写 API Key", CYAN, FILL_D),
      arrow(354, 76, 404, 76, CYAN),
      box(404, 50, 130, 52, "节点自动读取", ORNG, FILL_P),
      caption(558, 150, "Key 只保存在本机；节点从全局配置取服务商与模型"),
    ].join("\n"),
    558,
    150,
  ),
};

for (const [id, svg] of Object.entries(diagrams)) {
  fs.writeFileSync(path.join(imgDir, id + ".svg"), svg, "utf8");
}

const catalog = {
  defaultPage: "overview",
  sections: [
    {
      id: "start",
      title: { zh: "入门", en: "Getting started" },
      pages: [
        { id: "overview", title: { zh: "欢迎与产品简介", en: "Welcome" } },
        { id: "first-run", title: { zh: "第一次使用", en: "First run" } },
        { id: "ui-tour", title: { zh: "界面导览", en: "Interface tour" } },
        { id: "shortcuts", title: { zh: "快捷键", en: "Shortcuts" } },
      ],
    },
    {
      id: "canvas",
      title: { zh: "画布", en: "Canvas" },
      pages: [
        { id: "nodes-wires", title: { zh: "节点、端子与连线", en: "Nodes and wires" } },
        { id: "batch", title: { zh: "批量、拆分与合并", en: "Batch, split, merge" } },
        { id: "marks-groups", title: { zh: "绘制、框选与组", en: "Marks, box, groups" } },
        { id: "super-nodes", title: { zh: "超级节点", en: "Super nodes" } },
        { id: "workflows", title: { zh: "工作流与创意工坊", en: "Workflows & workshop" } },
      ],
    },
    {
      id: "nodes",
      title: { zh: "节点", en: "Nodes" },
      pages: [
        { id: "io-proc", title: { zh: "输入 / 处理 / 保存", en: "Input / process / save" } },
        { id: "task-chat", title: { zh: "任务与对话", en: "Tasks and chat" } },
        { id: "agent-nodes", title: { zh: "智能任务与智能会话", en: "Agent task & session" } },
        { id: "node-guide", title: { zh: "节点指南", en: "Node guides" } },
      ],
    },
    {
      id: "flow",
      title: { zh: "控制流", en: "Control flow" },
      pages: [
        { id: "task-flow", title: { zh: "任务控制流", en: "Task graph" } },
        { id: "timers", title: { zh: "定时与延时", en: "Timer and delay" } },
        { id: "routing", title: { zh: "闸门、分发与互斥", en: "Gate, split, mutex" } },
      ],
    },
    {
      id: "agent",
      title: { zh: "智能能力", en: "Agent" },
      pages: [
        { id: "dsh", title: { zh: "智能能力是什么", en: "What agent mode is" } },
        { id: "approvals", title: { zh: "审批与权限", en: "Approvals & permissions" } },
        { id: "plugins-skills", title: { zh: "插件、技能与 MCP", en: "Plugins, skills, MCP" } },
      ],
    },
    {
      id: "setup",
      title: { zh: "设置与数据", en: "Settings & data" },
      pages: [
        { id: "providers", title: { zh: "服务商与 API", en: "Providers & API" } },
        { id: "workspace", title: { zh: "工作目录与存档", en: "Workspace & archives" } },
        { id: "update", title: { zh: "版本更新", en: "Updates" } },
      ],
    },
    {
      id: "faq",
      title: { zh: "问答", en: "FAQ" },
      pages: [{ id: "faq", title: { zh: "常见问题", en: "Common questions" } }],
    },
  ],
};

fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");

const pages = {
  overview: {
    zh: fs.readFileSync(path.join(root, "overview.md"), "utf8"),
    en: fs.readFileSync(path.join(root, "en", "overview.md"), "utf8"),
  },
  "first-run": {
    zh: `# 第一次使用

![四步上手](img/first-run.svg)

1. **配置服务商**  
   打开「设置 · API/配置」，从目录选择文本服务商（如 DeepSeek 官方），填写 **API Key**。Key 只保存在本机。图像能力另加图像服务商。
2. **添加节点**  
   在画布**空白处右键**，选「文本节点」或「文本处理节点」。标题可点击改名。
3. **连线**  
   从上游输出端子（右侧圆点）拖到下游输入端子（左侧圆点）。提示词里输入 \`@\` 可引用已连接节点。
4. **运行**  
   点处理节点上的 **▶**。若上游还没跑过，会自动先执行上游。

> 智能办事（读文件 / 联网 / 命令）见 [智能能力是什么](#dsh)。桌宠等可选组件见右上角「插件」。
`,
    en: `# First run

![Four steps](img/first-run.svg)

1. **Configure a provider**  
   Open **Settings · API/Config**, pick a text provider (e.g. DeepSeek Official), enter an **API Key**. Keys stay on this machine. Add an image provider for generation.
2. **Add nodes**  
   **Right-click empty canvas** → Text Node or Text Processing Node. Click the title to rename.
3. **Wire**  
   Drag from an output port (right) to an input port (left). Type \`@\` in a prompt to reference connected nodes.
4. **Run**  
   Click **▶** on a process node. Unprocessed upstream nodes run automatically first.

> Agent mode (files / web / shell) is in [What agent mode is](#dsh). Optional components: top-right **Plugins**.
`,
  },
  "ui-tour": {
    zh: fs.readFileSync(path.join(root, "ui-tour.md"), "utf8"),
    en: fs.readFileSync(path.join(root, "en", "ui-tour.md"), "utf8"),
  },
  shortcuts: {
    zh: `# 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 撤销 | \`Ctrl+Z\` |
| 重做 | \`Ctrl+Y\` 或 \`Ctrl+Shift+Z\` |
| 查找节点（标题 / 内容） | \`Ctrl+F\`（画布顶端悬浮框，仅当前画布） |
| 替换 / 全部替换 | \`Ctrl+G\` |
| 复制选中节点 / 绘制 | \`Ctrl+C\`（有文字选区时交给系统复制） |
| 删除选中 | \`Delete\` / \`Backspace\` |
| 组成组 / 解散组 | \`G\` |
| 取消选择 / 关闭部分弹窗 | \`Esc\` |
| 框选 | \`Ctrl+左键\` 拖拽，或开启顶栏「▭ 框选」后左键拖拽 |
| 缩放画布 | 滚轮 |
| 重命名节点 | 点击节点标题 |

对话 / 智能会话的发送键可在设置里改：**Enter 发送** 或 **Enter 换行 + Ctrl+Enter 发送**。
`,
    en: `# Shortcuts

| Action | Keys |
| --- | --- |
| Undo | \`Ctrl+Z\` |
| Redo | \`Ctrl+Y\` or \`Ctrl+Shift+Z\` |
| Find nodes (title / content) | \`Ctrl+F\` (floating bar on canvas; current canvas only) |
| Replace / Replace all | \`Ctrl+G\` |
| Duplicate selected nodes / marks | \`Ctrl+C\` (system copy if text is selected) |
| Delete selection | \`Delete\` / \`Backspace\` |
| Group / ungroup | \`G\` |
| Clear selection / close some dialogs | \`Esc\` |
| Box-select | \`Ctrl+drag\`, or enable toolbar **▭ Box** then drag |
| Zoom canvas | Mouse wheel |
| Rename node | Click the node title |

Chat / agent-session send keys are in Settings: **Enter to send** or **Enter newline + Ctrl+Enter send**.
`,
  },
  "nodes-wires": {
    zh: fs.readFileSync(path.join(root, "nodes-wires.md"), "utf8"),
    en: fs.readFileSync(path.join(root, "en", "nodes-wires.md"), "utf8"),
  },
  batch: {
    zh: `# 批量、拆分与合并

![批量](img/batch.svg)

## 开启批量

输入节点右上角「批量」：文本用 ＋ / 导入 / 粘贴 YAML（\`标题: 内容\`）；图像可多选或一次拖入多张。

## 处理方式

处理节点头部 **批量 / 聚合**：

- **批量**：每条单独跑，输出多条。
- **聚合**：所有条目一次送入，输出一条。

## 拆分 / 合并

- **拆分**：从批次里抽出单项，生成只读节点。
- **合并**：多个输入汇成一个批次，下游按批量处理。

保存节点在批量链上按 \`{文件名}_{输入节点标题}\` 命名。详见 [输入 / 处理 / 保存](#io-proc)。
`,
    en: `# Batch, split, merge

![Batch](img/batch.svg)

## Enable batch

Input node **Batch**: text uses ＋ / import / paste YAML (\`title: body\`); images accept multi-select or a drop of several files.

## Process mode

Process header **Batch / Aggregate**:

- **Batch**: one run per item, many outputs.
- **Aggregate**: all items in one run, one output.

## Split / Merge

- **Split**: extract items into read-only nodes.
- **Merge**: several inputs become one batch for downstream.

Save nodes on a batch chain name files \`{filename}_{input title}\`. See [Input / process / save](#io-proc).
`,
  },
  "marks-groups": {
    zh: `# 绘制、框选与组

## 绘制

右键空白处可加箭头、框体、说明文字。它们只是标注，不参与运行。可改颜色 / 线宽 / 字号，\`Ctrl+C\` 复制绘制。

## 框选

\`Ctrl+左键\` 拖空白，或打开顶栏「▭ 框选」后直接拖。框内节点（及绘制）一并选中，可移动 / 删除 / 复制。

## 组

选中多个节点后按 \`G\` 或点「◫ 组」，输入标题。虚线圆角框可整体拖动；边缘把手横竖分别缩放。再按 \`G\` 或点组按钮解散（节点保留）。

## 超节点（收纳）

框选后点顶栏 **「超节点」**，或右键空白添加超级节点，把相关节点收成子图。可展开壳层编辑、↪ 进入完整内部画布，并用边端子隧穿数据。详见 [超级节点](#super-nodes)。

## 排版

「自动排版」按连线方向把节点铺开，减少重叠。若画布含超级节点，会询问是否**同时排版内部**。
`,
    en: `# Marks, box select, groups

## Marks

Right-click empty canvas for arrows, boxes, notes. They are annotations only. Change color / stroke / size; \`Ctrl+C\` copies marks.

## Box select

\`Ctrl+left-drag\` empty space, or enable toolbar **▭ Box** then drag. Nodes (and marks) inside are selected for move / delete / copy.

## Groups

Select nodes, press \`G\` or **◫ Group**, enter a title. Dashed frame moves together; edge handles scale axes independently. Press \`G\` again to dissolve (nodes remain).

## Wrap super

After selecting nodes, toolbar **Wrap super** (or right-click → Super) packs them into a subgraph. Expand the shell, **↪ Enter** for a full inner canvas, and tunnel data via edge ports. See [Super nodes](#super-nodes).

## Layout

**Auto layout** spreads nodes by wires. If the canvas has supers, you can choose to tidy **inside supers** as well.
`,
  },
  "super-nodes": {
    zh: fs.readFileSync(path.join(root, "super-nodes.md"), "utf8"),
    en: fs.readFileSync(path.join(root, "en", "super-nodes.md"), "utf8"),
  },
  workflows: {
    zh: `# 工作流与创意工坊

## 本地工作流

顶栏可 **新建 / 切换 / 改名 / 删除**。默认工作流 id 为 \`default\`，删掉会自动重建。编辑后数百毫秒内自动保存；启动恢复上次现场。

## 导入 / 导出

- **导出**：打包为 \`.mtnodes\`（含节点、连线、提示词与图像资产），或复制 Base64（适合小纯文本画布）。
- **导入**：从文件或粘贴 Base64 还原。他人模板若引用了你没有的服务商，会引导批量替换。

## 创意工坊

顶栏「创意工坊」浏览 / 搜索公开模板并下载。上传需要注册登录，可管理标题、预览图、描述与标签。
`,
    en: `# Workflows & workshop

## Local workflows

Toolbar **New / switch / rename / delete**. Default id is \`default\` (recreated if deleted). Edits auto-save within a few hundred ms; the last session restores on startup.

## Import / export

- **Export**: \`.mtnodes\` pack (nodes, wires, prompts, image assets) or Base64 (small text canvases).
- **Import**: from file or pasted Base64. Shared templates that reference missing providers prompt a batch replace.

## Creative Workshop

Browse / search public templates and download. Upload requires an account; you can manage title, preview, description, and tags.
`,
  },
  "io-proc": {
    zh: `# 输入 / 处理 / 保存

![数据流](img/io-proc.svg)

## 输入

- **文本**：就地编辑；📄 可导入 txt / md / json / yaml 等（超过 500KB 拒绝）。
- **图像**：点击选择或拖入文件。

## 处理

- **文本处理**：提示词 + 输入调用 LLM。可开「🐋 智能」变成任务（见 [智能任务](#agent-nodes)）。
- **图像生成**：文生图；带参考图走图生图。需要视觉时请勾选服务商「支持视觉」（DeepSeek 官方不识图）。
- **动画**：把图像按网格切成 GIF 帧，可设透明色键。

**▶ 运行 · ◈ 预览完整请求 · API** 选服务商 / 模型 / 温度 / 尺寸。**多次尝试**（1–10）并行抽卡，输出面板用方块 Tab 切换，下游引用当前选中的那次。处理完成后自动跑下游；下游已有内容时询问覆盖或不继续。

输出头上的「浏览 / 复制 / 清空」可大窗查看或重置。

## 保存

指定路径后 ▶ 写出 YAML 或图像。可勾选「输入变化时自动保存」。有工作目录时可用相对路径，见 [工作目录与存档](#workspace)。
`,
    en: `# Input / process / save

![Flow](img/io-proc.svg)

## Input

- **Text**: edit in place; 📄 imports txt / md / json / yaml (rejected over 500KB).
- **Image**: click or drop a file.

## Process

- **Text**: prompt + inputs → LLM. **🐋 Agent** turns it into a task ([Agent task](#agent-nodes)).
- **Image generation**: text-to-image; reference images use edit APIs. Vision needs “Vision” enabled (DeepSeek Official has no vision).
- **Anim**: slice an image on a grid into a GIF; chroma key optional.

**▶ run · ◈ preview · API** for provider / model / temperature / size. **Attempts** (1–10) run in parallel; square tabs pick which result downstream sees. When a process node finishes, downstream runs automatically; if they already have output, choose overwrite or stop.

Output **Browse / Copy / Clear** opens a large viewer or resets.

## Save

Set a path, then ▶ writes YAML or an image. Optional auto-save on input change. Relative paths need a workspace; see [Workspace](#workspace).
`,
  },
  "task-chat": {
    zh: fs.readFileSync(path.join(root, "task-chat.md"), "utf8"),
    en: fs.readFileSync(path.join(root, "en", "task-chat.md"), "utf8"),
  },
  "agent-nodes": {
    zh: `# 智能任务与智能会话

## 智能任务节点

右键 → 智能节点。提示词就是任务描述，支持 \`@\`、输入 \`/\` 呼出技能、多输入、批量 / 聚合、模型选择、输出浏览。工作目录用文件夹窗口选择。不做「多次尝试」（多步执行，不是并行抽卡）。开启智能模式的文本处理 / 对话节点能力相同。

可一键**扩展为智能会话**（节点与会话内容同步）。删除节点时会提示一并删除关联会话。

### 智能节点允许做的事

在工作区完成任务，不改画布。具体包括（仍受顶栏「审批」与权限预设约束）：

- 按任务描述多步推理并给出结果
- **读 / 写 / 编辑**工作区文件
- 在工作区执行命令
- 联网搜索与抓取网页
- 使用已安装技能与已连接的 MCP 工具
- 识图（\`mtnode_vision\`）
- 使用连入的 \`@\` 引用、批量 / 聚合、所选模型

智能节点**不能**：读取或编辑画布、修改工作流、创建任务图或节点/连线、重命名或删除工作流。需要搭图时用智能会话或全局助手。

## 智能会话

顶栏切换到「智能会话」：多会话、按工作目录分组、归档、分支、斜杠命令（输入 \`/\` 呼出技能与 \`/new\` \`/compact\` \`/plan\` \`/help\` 等）。除读写文件、联网、命令外，还可以查看并修改当前画布。

## 让助手搭工作流

在**智能会话**或全局助手里说「实现 xxx 的工作流」，模型会在当前画布**创建节点、改标题、连线、写 @引用**并自动排版。你再改提示词与保存路径后点 ▶。画布上的智能节点不会改图。

全局助手（画布右侧 ✦）也能看状态、搭图，但改画布会先确认。**文档答疑助手不会改画布。**
`,
    en: `# Agent task & session

## Agent task node

Right-click → Agent node. The prompt is the task. Supports \`@\`, type \`/\` for skills, multi-input, batch / aggregate, model picker, browse. Pick the workspace with a folder dialog. No “attempts” (multi-step, not parallel sampling). Text / chat nodes with Agent on have the same capabilities.

**Expand to agent session** keeps node and session in sync. Deleting the node can delete the linked session (you are asked).

### What an agent node may do

Finish work in the workspace; it does **not** edit the canvas. Allowed (still gated by Approvals / the permission preset):

- Multi-step reasoning to complete the prompt
- **Read / write / edit** workspace files
- Run commands in the workspace
- Web search and fetch
- Installed skills and connected MCP tools
- Vision (\`mtnode_vision\`)
- Wired \`@\` refs, batch / aggregate, the selected model

An agent node **cannot** read or edit the canvas, change workflows, or create task graphs / nodes / wires. Use Agent session or the global assistant to build a graph.

## Agent session

Top bar **Agent session**: many sessions, grouped by workspace, archive, fork, slash commands (type \`/\` for skills and \`/new\` \`/compact\` \`/plan\` \`/help\`). Besides files / network / commands, it can inspect and edit the current canvas.

## Let the assistant build a workflow

In **Agent session** or the global assistant, say “build a workflow for xxx”. The model **creates nodes, titles, wires, @refs** and lays them out. Then you edit prompts/paths and ▶. Canvas agent nodes will not change the graph.

The global assistant (✦) can inspect and edit the graph with confirmation. **The docs Q&A assistant never edits the canvas.**
`,
  },
  "node-guide": {
    zh: `# 节点指南

任意节点右键 → **节点指南**，打开该类型的 Markdown 图示（文件在 \`guides/nodes/\`）。

- 手册讲**整个应用怎么用**；节点指南讲**这一种节点的端口、按钮、失败原因**。
- 控制节点（定时、闸门、互斥等）建议先看节点指南，再回到本手册的 [控制流](#task-flow) 章节串起来。

找不到指南时，对话框会提示缺失，不影响画布。
`,
    en: `# Node guides

Right-click any node → **Node guide** for that kind’s Markdown diagrams (\`guides/nodes/\`).

- This manual covers **the whole app**; node guides cover **ports, buttons, and failure modes of one kind**.
- For timers, gates, mutex, start with the node guide, then this manual’s [Control flow](#task-flow) section.

A missing guide shows an error in the dialog and does not touch the canvas.
`,
  },
  "task-flow": {
    zh: `# 任务控制流

![任务图](img/task-flow.svg)

每个任务内部固定有：

1. **起点**（任务自动创建，不出现在添加菜单）
2. 中间的工作步骤、子任务、判断（是/否分流）
3. **成功终点 / 失败终点**

▶ 从起点沿控制线推进。到达成功终点即成功；失败终点或跑不下去则失败。父任务格子反映子任务状态。

判断节点根据「目标 / 标准」和已有结果让文本模型只答 YES/NO，再分流。需要已配置 API Key 的文本服务商。
`,
    en: `# Task graph

![Task graph](img/task-flow.svg)

Every task contains:

1. **Start** (created automatically; not in the add menu)
2. Steps, sub-tasks, judges (yes/no)
3. **Success end / fail end**

▶ advances along control wires from start. Reaching success completes the task; fail end or a stuck graph fails. Parent tiles mirror sub-tasks.

The judge node asks a text model for YES/NO from the goal and existing results. A text provider with an API Key is required.
`,
  },
  timers: {
    zh: `# 定时与延时

![定时](img/timers.svg)

## 定时触发器

把闹钟连到要启动的节点（金色控制线）。间隔以**天 / 时 / 分**填写（最短 1 分钟，最长 7 天），也可用 Cron **智能填写**。

节点上的 **▶ 是打开闹钟**，不是「立刻跑一遍业务节点」。到点后向下游发脉冲。再点可关掉闹钟。

## 延时器

收到上游脉冲后等待设定时间，再放行。可用于拉开步骤间隔。

两种节点的端口含义以右键 **节点指南** 为准。
`,
    en: `# Timer and delay

![Timer](img/timers.svg)

## Timer

Wire the alarm to nodes you want to start (gold control wires). Interval is **days / hours / minutes** (min 1 minute, max 7 days), or Cron **smart fill**.

**▶ opens the alarm**—it does not immediately run the business nodes. At fire time a pulse is sent downstream. ▶ again disarms.

## Delayer

Waits the configured time after an upstream pulse, then releases. Use it to space steps.

See each node’s **Node guide** for ports.
`,
  },
  routing: {
    zh: `# 闸门、分发与互斥

![闸门](img/routing.svg)

控制类节点统一**金色外圈**，内部颜色仍表示种类。

| 节点 | 作用 |
| --- | --- |
| **闸门** | AND：配置了几路输入，就要几路脉冲到齐才放行（**没接线的端口也会挡住**） |
| **分发** | 一入多出，把脉冲送到多路 |
| **序列器** | 按顺序依次触发下游 |
| **计数** | 计满 N 次再放行 |
| **互斥** | 多路里按模式只放行一路（先到 / 端口优先 / 随机） |
| **需求等待** | 监视某个文件出现或变化后再继续 |

▶ 多为试跑 / 标记，具体见各节点指南。
`,
    en: `# Gate, split, mutex

![Gate](img/routing.svg)

Control nodes share a **gold outer ring**; inner color still shows the kind.

| Node | Role |
| --- | --- |
| **Gate** | AND: as many pulses as **configured** inputs (unwired ports still block) |
| **Splitter** | One in, many out |
| **Sequencer** | Fire downstream in order |
| **Counter** | Release after N pulses |
| **Mutex** | Pick one lane (first / port order / random) |
| **Wait file** | Continue when a file appears or changes |

▶ is often a trial pulse; see each **Node guide**.
`,
  },
  dsh: {
    zh: `# 智能能力是什么

![智能能力](img/dsh.svg)

接入 DeepSeek Harness（dsh）后，模型不只生成文字，还能**读/写工作目录文件、联网搜索、执行命令、派子代理**。运行时随应用自带，**不用另装 Node**。

需要先配置带 API Key 的**文本服务商**。智能任务、智能会话、对话节点的「智能助手」、文本处理的「🐋 智能」都走这条引擎。

## 过程可见

运行中显示「◉ 思考中」，可展开思考与 **🔧 工具调用**。智能模式按任务完成计费，一次任务可能多次调用模型。

写文件前请确认 [工作目录](#workspace) 正确。权限过宽或过严见 [审批与权限](#approvals)。
`,
    en: `# What agent mode is

![Agent](img/dsh.svg)

With DeepSeek Harness (dsh) the model can **read/write the workspace, search the web, run commands, and spawn sub-agents**. The runtime ships with the app—**no extra Node install**.

Configure a **text provider** with an API Key first. Agent task, agent session, chat “Agent”, and text-process **🐋 Agent** all use this engine.

## Visible process

Runs show **◉ Thinking** with expandable thoughts and **🔧 tool calls**. Billing is per completed task and may call the model several times.

Confirm the [workspace](#workspace) before writes. See [Approvals](#approvals) for permission presets.
`,
  },
  approvals: {
    zh: `# 审批与权限

右上角 **审批** 管两件事：

1. **权限预设**（沙箱 + 询问策略）  
   - 无人值守（默认，工作区读写且不弹窗）  
   - 工作区读写 · 逐项审批  
   - 只读 · 逐项审批  
   - 完全放行（不限目录、不询问）
2. **工具许可**：画布节点 / 控制 / 绘图 / 排版、应用操作、读写下文件 / 终端 / 联网 / 子代理、识图。可另存自定义预设。

「逐项审批」时，越权工具会弹出卡片：**允许一次 / 拒绝**。画布修改、应用级危险操作、识图是硬拦截，即使预设较松也会确认。

任务中途模型还可能 **向用户提问**（选项或填空），答完继续跑。
`,
    en: `# Approvals & permissions

Top-right **Approvals** covers:

1. **Permission presets** (sandbox + prompts)  
   - Unattended (default: workspace read/write, no prompts)  
   - Workspace write · approve each  
   - Read-only · approve each  
   - Full access (no directory limit, no prompts)
2. **Tool permissions**: canvas / control / drawing / layout, app actions, files / shell / web / sub-agents, vision. Save custom presets.

**Approve each** shows a card: **Allow once / Deny**. Canvas edits, risky app actions, and vision are hard gates.

The model may also **ask the user** mid-task (choices or free text) before continuing.
`,
  },
  "plugins-skills": {
    zh: `# 插件、技能与 MCP

## 应用插件（右上角「插件」）

插件**列表从云端目录更新**（\`http://mt-agent.com/mtnode/plugins/catalog.json\`），可不升级主程序看到新插件。离线时使用上次缓存或内置列表。

- **讨论区**：按需下载的聊天窗口，登录创意工坊同一账户后聊天；可运行、卸载、更新。
- **桌宠 BongoChat**：按需下载的透明置顶窗口，可运行、卸载。
- **窗口插件**：目录里新增的 zip 包可直接下载安装并运行，无需发新版安装包。若插件类型当前版本不认识，会提示先升级应用。

## DSH 插件 / 技能 / MCP

在「设置 · 智能能力」或在线浏览里管理：

- **DSH 插件**：扩展 agent 能力，安装到配置目录（升级后保留）；安装后引擎会重启。
- **技能 Skills**：Markdown 说明书。智能会话 / 智能任务 / 智能文本 / 智能对话输入 \`/\` 即可选择；运行时会带上该技能全文。
- **MCP 服务器**：连接后智能节点获得该服务器的工具（stdio 或远程 URL）。

官方扩展目录：\`http://mt-agent.com/mtnode/ext/catalog.json\`（在线浏览预置「MTNode 官方」标签；也可「＋ 添加源」自行添加）。本地仓库在 \`ext-repo/\`，用 \`npm run ext:sync\` 同步到云端。

详细卡片可在设置里搜索、安装、启停、移除。
`,
    en: `# Plugins, skills, MCP

## App plugins (top-right **Plugins**)

The **plugin list is fetched from the cloud catalog** (\`http://mt-agent.com/mtnode/plugins/catalog.json\`), so new plugins can appear without an app upgrade. Offline, the last cache or the built-in list is used.

- **Forum**: optional download; sign in with the Creative Workshop account to chat; run, uninstall, or update.
- **Desktop pet (BongoChat)**: optional download; transparent always-on-top window; run or uninstall.
- **Window plugins**: new zip packages in the catalog can be downloaded and run without a new installer. Unknown plugin kinds prompt you to upgrade the app.

## DSH plugins / Skills / MCP

Manage under Settings · Agent (or Browse online):

- **DSH plugins**: extend the agent; installed under the config data directory (survive app updates); install restarts the engine.
- **Skills**: Markdown instructions. Type \`/\` in agent session / agent task / agent text / agent chat to pick one; the skill body is attached at run time.
- **MCP servers**: tools appear on agent nodes after connect (stdio or remote URL).

Official extension catalog: \`http://mt-agent.com/mtnode/ext/catalog.json\` (Browse online includes the **MTNode official** tab; you can also **+ Add source**). Local repo is \`ext-repo/\`; sync with \`npm run ext:sync\`.

Search, install, enable, or remove from Settings cards.
`,
  },
  providers: {
    zh: `# 服务商与 API

![服务商](img/providers.svg)

打开 **设置 · API/配置 → 模型服务**：

1. **从目录添加**（推荐）：选服务商 → 填 Key → 自动载入模型列表与接口地址。含 DeepSeek 官方与 pi-ai 等目录。
2. **手动配置**：OpenAI 兼容的 Base URL + 模型名逗号分隔。

勾选 **支持视觉** 后，图像才能作为多模态输入。DeepSeek 官方不支持识图，请换支持视觉的服务商。

温度、思考强度（低 / 中 / 高）、图像尺寸在节点 API 面板覆盖全局默认。

> API Key 仅存本机，不会随工作流上传。创意工坊上传的是你选择的模板文件，不含 Key。
`,
    en: `# Providers & API

![Providers](img/providers.svg)

Open **Settings · API/Config → Model services**:

1. **From catalog** (recommended): pick provider → Key → models and Base URL load. Includes DeepSeek Official and pi-ai catalogs.
2. **Manual**: OpenAI-compatible Base URL + comma-separated model names.

Enable **Vision** so images become multimodal. DeepSeek Official has no vision—use another provider.

Temperature, thinking effort (low / mid / high), and image size override defaults on the node API panel.

> API keys stay on this machine and are not exported with workflows. Workshop uploads are the template files you pick, without keys.
`,
  },
  workspace: {
    zh: fs.readFileSync(path.join(root, "workspace.md"), "utf8"),
    en: fs.readFileSync(path.join(root, "en", "workspace.md"), "utf8"),
  },
  update: {
    zh: `# 版本更新

发现新版本时，右上角出现高光 **更新**。点击后确认，再**差分下载**（只拉变更块），然后**静默安装**并自动重启（不弹出安装向导）。

语言按钮仍在最右侧；出现更新按钮时，「审批 / 插件 / 文档」会向左让位。

若下载失败，检查网络后再次点击更新。版本号也显示在顶栏副标题与作者弹窗中。
`,
    en: `# Updates

When a new version exists, top-right **Update** highlights. Confirm, then a **delta download** (blockmap) runs, followed by a **silent install** and restart (no installer wizard).

The language button stays at the far right; Approvals / Plugins / Docs shift left when Update is shown.

If the download fails, retry after checking the network. The version also appears in the logo subtitle and the author popup.
`,
  },
  faq: {
    zh: fs.readFileSync(path.join(root, "faq.md"), "utf8"),
    en: fs.readFileSync(path.join(root, "en", "faq.md"), "utf8"),
  },
};

for (const [id, pair] of Object.entries(pages)) {
  fs.writeFileSync(path.join(root, id + ".md"), pair.zh.trim() + "\n", "utf8");
  fs.writeFileSync(path.join(root, "en", id + ".md"), pair.en.trim() + "\n", "utf8");
}

console.log("manual pages:", Object.keys(pages).length, "diagrams:", Object.keys(diagrams).length);

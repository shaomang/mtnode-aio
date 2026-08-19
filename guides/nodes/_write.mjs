/* one-shot: write node guide markdown + simple SVG diagrams */
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

function diagram(id, inner, w, h) {
  const W = w || 520;
  const H = h || 180;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0d1016"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#f0c14d"/>
    </marker>
  </defs>
${inner}
  <text x="${W / 2}" y="${H - 10}" text-anchor="middle" fill="#5a6472" font-size="10" font-family="Segoe UI,sans-serif">placeholder · ${svgEscape(id)} · replace guides/nodes/img/${svgEscape(id)}.svg</text>
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

const diagrams = {
  "input_text": diagram("input_text", [
    box(30, 50, 110, 52, "文本输入", CYAN, FILL_D),
    arrow(140, 76, 200, 76, CYAN),
    box(200, 50, 120, 52, "处理 / 保存", ORNG, FILL_P),
  ].join("\n")),
  "input_image": diagram("input_image", [
    box(30, 50, 110, 52, "图像输入", CYAN, FILL_D),
    arrow(140, 76, 200, 76, CYAN),
    box(200, 50, 140, 52, "图像处理 / 存图", ORNG, FILL_P),
  ].join("\n")),
  "proc_text": diagram("proc_text", [
    box(20, 50, 90, 52, "输入", CYAN, FILL_D),
    arrow(110, 76, 160, 76, CYAN),
    box(160, 50, 120, 52, "文本处理", ORNG, FILL_P),
    arrow(280, 76, 330, 76, ORNG),
    box(330, 50, 100, 52, "输出", GRN, "#101610"),
  ].join("\n")),
  "proc_image": diagram("proc_image", [
    box(20, 50, 90, 52, "提示/图", CYAN, FILL_D),
    arrow(110, 76, 160, 76, CYAN),
    box(160, 50, 120, 52, "图像生成", "#ff5ea8", "#1a1016"),
    arrow(280, 76, 330, 76, "#ff5ea8"),
    box(330, 50, 100, 52, "图像", GRN, "#101610"),
  ].join("\n")),
  "save": diagram("save", [
    box(20, 50, 90, 52, "任意输出", CYAN, FILL_D),
    arrow(110, 76, 180, 76, CYAN),
    box(180, 50, 140, 52, "保存 · 自判", GRN, "#101610"),
  ].join("\n")),
  "save_text": diagram("save_text", [
    box(30, 50, 110, 52, "文本来源", CYAN, FILL_D),
    arrow(140, 76, 210, 76, CYAN),
    box(210, 50, 120, 52, "保存 · yaml", GRN, "#101610"),
  ].join("\n")),
  "save_image": diagram("save_image", [
    box(30, 50, 110, 52, "图像来源", CYAN, FILL_D),
    arrow(140, 76, 210, 76, CYAN),
    box(210, 50, 120, 52, "保存 · png", GRN, "#101610"),
  ].join("\n")),
  "split": diagram("split", [
    box(30, 64, 100, 48, "批量源", CYAN, FILL_D),
    arrow(130, 88, 190, 88, CYAN),
    box(190, 64, 90, 48, "拆分", ORNG, FILL_P),
    arrow(280, 88, 340, 48, ORNG),
    arrow(280, 88, 340, 128, ORNG),
    box(340, 24, 100, 40, "条目 A", GRN, "#101610"),
    box(340, 108, 100, 40, "条目 B", GRN, "#101610"),
  ].join("\n")),
  "merge": diagram("merge", [
    box(30, 24, 100, 40, "文本 A", CYAN, FILL_D),
    box(30, 108, 100, 40, "文本 B", CYAN, FILL_D),
    arrow(130, 44, 190, 80, CYAN),
    arrow(130, 128, 190, 88, CYAN),
    box(190, 64, 90, 48, "合并", ORNG, FILL_P),
    arrow(280, 88, 340, 88, ORNG),
    box(340, 64, 110, 48, "一份文本", GRN, "#101610"),
  ].join("\n")),
  "task": diagram("task", [
    box(20, 60, 80, 44, "起点", GOLD, FILL_C),
    arrow(100, 82, 150, 82),
    box(150, 60, 90, 44, "子任务", "#3ecfcf", "#101818"),
    arrow(240, 82, 290, 50),
    arrow(240, 82, 290, 114),
    box(290, 28, 90, 40, "成功终点", GRN, "#101610"),
    box(290, 96, 90, 40, "失败终点", RED, "#1a1010"),
  ].join("\n")),
  "chat": diagram("chat", [
    box(40, 50, 140, 52, "对话节点", "#7ee8e0", "#101818"),
    arrow(180, 76, 250, 76, "#7ee8e0"),
    box(250, 50, 140, 52, "多轮消息", CYAN, FILL_D),
  ].join("\n")),
  "agent_task": diagram("agent_task", [
    box(20, 50, 90, 52, "任务描述", CYAN, FILL_D),
    arrow(110, 76, 160, 76, CYAN),
    box(160, 50, 130, 52, "智能任务", "#4d8cff", "#10141c"),
    arrow(290, 76, 340, 76, "#4d8cff"),
    box(340, 50, 110, 52, "结果 / 文件", GRN, "#101610"),
  ].join("\n")),
  "control": diagram("control", [
    box(30, 50, 120, 52, "执行 / 清空", GOLD, FILL_C),
    arrow(150, 76, 220, 76),
    box(220, 24, 100, 40, "处理 A", ORNG, FILL_P),
    box(220, 88, 100, 40, "处理 B", ORNG, FILL_P),
  ].join("\n")),
  "ctrl-start": diagram("ctrl-start", [
    box(30, 60, 90, 44, "起点", GOLD, FILL_C),
    arrow(120, 82, 180, 82),
    box(180, 60, 100, 44, "工作节点", ORNG, FILL_P),
    arrow(280, 82, 340, 82),
    box(340, 60, 100, 44, "终点", GRN, "#101610"),
  ].join("\n")),
  "ctrl-end-ok": diagram("ctrl-end-ok", [
    box(40, 60, 120, 44, "控制流", GOLD, FILL_C),
    arrow(160, 82, 230, 82, GRN),
    box(230, 60, 120, 44, "成功终点", GRN, "#101610"),
  ].join("\n")),
  "ctrl-end-fail": diagram("ctrl-end-fail", [
    box(40, 60, 120, 44, "控制流", GOLD, FILL_C),
    arrow(160, 82, 230, 82, RED),
    box(230, 60, 120, 44, "失败终点", RED, "#1a1010"),
  ].join("\n")),
  "judge": diagram("judge", [
    box(20, 60, 80, 44, "脉冲", GOLD, FILL_C),
    arrow(100, 82, 150, 82),
    box(150, 54, 90, 56, "判断", "#c9a0ff", "#181220"),
    arrow(240, 70, 300, 40, GRN),
    arrow(240, 94, 300, 124, RED),
    box(300, 20, 90, 40, "是", GRN, "#101610"),
    box(300, 104, 90, 40, "否", RED, "#1a1010"),
  ].join("\n")),
  "wait_file": diagram("wait_file", [
    box(30, 60, 110, 44, "需求等待", GOLD, FILL_C),
    arrow(140, 82, 210, 82),
    box(210, 60, 130, 44, "文件就绪后放行", GRN, "#101610"),
  ].join("\n")),
  "timer": diagram("timer", [
    box(30, 60, 120, 44, "定时触发器", GOLD, FILL_C),
    arrow(150, 82, 220, 82),
    box(220, 36, 110, 36, "目标 A", ORNG, FILL_P),
    box(220, 92, 110, 36, "目标 B", ORNG, FILL_P),
  ].join("\n")),
  "delayer": diagram("delayer", [
    box(20, 60, 80, 44, "脉冲", GOLD, FILL_C),
    arrow(100, 82, 150, 82),
    box(150, 60, 100, 44, "延时器", GOLD, FILL_C),
    arrow(250, 82, 310, 82),
    box(310, 60, 100, 44, "继续", ORNG, FILL_P),
  ].join("\n")),
  "sequencer": diagram("sequencer", [
    box(20, 64, 80, 44, "脉冲", GOLD, FILL_C),
    arrow(100, 86, 150, 86),
    box(150, 64, 90, 44, "序列器", GOLD, FILL_C),
    arrow(240, 86, 300, 40),
    arrow(240, 86, 300, 86),
    arrow(240, 86, 300, 132),
    box(300, 20, 90, 36, "1 →", "#c9a0ff", "#181220"),
    box(300, 68, 90, 36, "2 →", "#c9a0ff", "#181220"),
    box(300, 116, 90, 36, "3 →", "#c9a0ff", "#181220"),
  ].join("\n"), 520, 200),
  "gate": diagram("gate", [
    box(20, 20, 90, 36, "入 1", GOLD, FILL_C),
    box(20, 72, 90, 36, "入 2", GOLD, FILL_C),
    box(20, 124, 90, 36, "入 3", GOLD, FILL_C),
    arrow(110, 38, 170, 86),
    arrow(110, 90, 170, 90),
    arrow(110, 142, 170, 94),
    box(170, 68, 90, 44, "闸门 AND", GOLD, FILL_C),
    arrow(260, 90, 320, 90),
    box(320, 68, 100, 44, "放行", GRN, "#101610"),
  ].join("\n"), 520, 200),
  "splitter": diagram("splitter", [
    box(20, 64, 80, 44, "脉冲", GOLD, FILL_C),
    arrow(100, 86, 150, 86),
    box(150, 64, 90, 44, "分发", GOLD, FILL_C),
    arrow(240, 86, 300, 40),
    arrow(240, 86, 300, 86),
    arrow(240, 86, 300, 132),
    box(300, 20, 90, 36, "同时", "#7ec8e8", "#101820"),
    box(300, 68, 90, 36, "同时", "#7ec8e8", "#101820"),
    box(300, 116, 90, 36, "同时", "#7ec8e8", "#101820"),
  ].join("\n"), 520, 200),
  "counter": diagram("counter", [
    box(20, 60, 90, 44, "脉冲×N", GOLD, FILL_C),
    arrow(110, 82, 170, 82),
    box(170, 60, 110, 44, "计数 每N次", GOLD, FILL_C),
    arrow(280, 82, 340, 82),
    box(340, 60, 90, 44, "放行", GRN, "#101610"),
  ].join("\n")),
  "mutex": diagram("mutex", [
    box(20, 24, 90, 36, "入 1", GOLD, FILL_C),
    box(20, 108, 90, 36, "入 2", GOLD, FILL_C),
    arrow(110, 42, 170, 82),
    arrow(110, 126, 170, 90),
    box(170, 64, 90, 44, "互斥 OR", GOLD, FILL_C),
    arrow(260, 86, 320, 86),
    box(320, 64, 100, 44, "一路出", GRN, "#101610"),
  ].join("\n"), 520, 180),
};

const guides = {
  input_text: {
    title: "文本输入",
    body: `在节点内直接编辑文本，或开启批量后添加多条。输出沿数据端子传到处理 / 保存节点。

## 端子
- **输入**：一般无（可被上游覆盖为只读继承）
- **输出**：文本

## 常用
- 批量：多条文本，下游可「逐条」或「聚合」
- 拖入 / 导入 YAML 可快速填条目`,
  },
  input_image: {
    title: "图像输入",
    body: `拖入图片到节点，或批量添加多张。输出给图像处理或存图节点。

## 端子
- **输入**：一般无
- **输出**：图像`,
  },
  proc_text: {
    title: "文本处理",
    body: `用大模型按提示词处理上游文本。可开「智能助手」走 agent（读文件 / 联网）。

## 端子
- **输入**：文本（可多路 / @引用）
- **输出**：处理后的文本

## 提示
提示词里用 \`@节点名\` 引用其他节点输出。`,
  },
  proc_image: {
    title: "图像生成",
    body: `按提示词生成图像。可接文本或图像输入；支持尺寸、背景移除等。

## 端子
- **输入**：文本或图像
- **输出**：图像`,
  },
  save: {
    title: "保存",
    body: `按输入内容自判落盘类型（旧版「保存文本 / 保存图像」打开后会升级为本节点）：

- **文本** → \`.yaml\`
- **图像** → \`.png\`
- **音频**（音乐生成）→ \`.wav\`
- **视频**（视频生成）→ \`.mp4\`

路径相对工作目录或绝对路径。可开自动保存。不同媒体用不同预览（文本 / 缩略图 / 音频播放器 / 视频播放器）。

放置**音乐生成**或**视频生成**时，会在其右侧自动绑定一个保存节点：相对位置固定、连线不可删除。生成节点会把文件名写入该保存节点。

## 端子
- **输入**：文本 / 图像 / 音频 / 视频（按来源自判）
- **输出**：无（落盘）`,
  },
  save_text: {
    title: "保存文本（已合并）",
    body: `已并入统一「保存」节点。打开旧画布时 \`save_text\` 会升级为 \`save\`，仍按 YAML 保存文本。详见「保存」。`,
  },
  save_image: {
    title: "保存图像（已合并）",
    body: `已并入统一「保存」节点。打开旧画布时 \`save_image\` 会升级为 \`save\`，图像固定 \`.png\`。详见「保存」。`,
  },
  split: {
    title: "拆分",
    body: `把批量输入拆成多条并行链（每条一个下游副本）。

## 端子
- **输入**：批量源（1 路）
- **输出**：拆分后的条目`,
  },
  merge: {
    title: "合并",
    body: `把多路文本合成一份，再交给下游。

## 端子
- **输入**：多路文本
- **输出**：合并文本`,
  },
  task: {
    title: "任务",
    body: `容器节点：进入后是一张控制流图（起点 → 工作 / 子任务 / 判断 → 成功或失败终点）。父级格子展示子任务。

## 端子
- **输入 / 输出**：控制（任务本身可被控制流点燃）

## 运行
点 ▶ 从内部**起点**发脉冲，到达哪类终点决定任务成功或失败。`,
  },
  chat: {
    title: "对话",
    body: `多轮文本对话。可开智能助手走 agent 会话；历史存在本节点。

## 端子
- **输入**：无
- **输出**：对话结果文本（视配置）`,
  },
  agent_task: {
    title: "智能任务",
    body: `通用 agent：按任务描述读文件、联网、执行命令，结果回填输出。服务商走 DeepSeek 路由。

## 端子
- **输入**：文本 / 引用
- **输出**：任务产物文本

## 许可
工具能力由顶栏「审批」预设控制。`,
  },
  control: {
    title: "执行 / 清空",
    body: `批控节点。把要操作的节点连到本节点（连出或连入均可），点 ▶ 一次执行或清空。

## 端子
- **输入 / 输出**：控制（双向都算目标）

## 模式
- **执行**：对已连接节点跑 ▶
- **清空**：清掉已连接节点的结果
- **补缺**：只跑还没有输出的节点`,
  },
  "ctrl-start": {
    title: "起点",
    body: `任务内部固定入口。点任务 ▶ 时从此发出控制脉冲。无法删除。

## 端子
- **输入**：无
- **输出**：控制`,
  },
  "ctrl-end-ok": {
    title: "成功终点",
    body: `控制流到达此处 → 所属任务标记为成功。任务自带一个固定成功终点；也可再加额外终点。

## 端子
- **输入**：控制
- **输出**：无`,
  },
  "ctrl-end-fail": {
    title: "失败终点",
    body: `控制流到达此处 → 所属任务标记为失败。

## 端子
- **输入**：控制
- **输出**：无`,
  },
  judge: {
    title: "判断",
    body: `用文本模型对照任务目标（或本节点填写的标准）裁决是否达成。

## 端子
- **输入**：控制脉冲
- **输出**：上 = **是**，下 = **否**

无可用 Key 时任务会进入「需干涉」。`,
  },
  wait_file: {
    title: "需求等待",
    body: `监视一个文件路径。文件尚未生成时挡住后续；就绪后放行。不输出文件内容，下游自己读约定路径。

## 端子
- **输入**：无
- **输出**：控制（连到下游，避免下游提前跑）`,
  },
  timer: {
    title: "定时触发器",
    body: `按**系统本地时间**到点后，给输出端连接的节点发一次「可以开始了」的信号。

## 怎么打开 / 关掉

节点上的 **▶** 不是立刻跑下游，而是**打开闹钟**：

1. 先选好模式和时间。
2. 点 **▶**：开始盯着时钟，等到设定时刻才触发。
3. 点 **■ / 停止**：取消等待，闹钟关掉。

状态条会显示下次触发时间。点「立即触发」可以现在就发一次信号，不影响闹钟是否开着。

## 模式
- **一次**：只响一次，到点触发后闹钟自动关掉
- **间隔**：每隔若干天 / 时 / 分再响一次（闹钟保持开着）
- **Cron**：按五段表达式循环；可用「智能填写」

## 端子
- **输入**：无
- **输出**：控制（连到要被定时启动的节点）

也可以接在任务控制流里：上游脉冲到达后，本节点会等到**下一次**计划时刻，再把信号传给下游。`,
  },
  delayer: {
    title: "延时器",
    body: `控制脉冲到达后等待设定时长（天 / 时 / 分），再沿输出继续。

## 端子
- **输入**：控制
- **输出**：控制

▶ 可立即开始一次延时并启用已连接目标。`,
  },
  sequencer: {
    title: "序列器",
    body: `一路入、多路出。脉冲到达后**按顺序**点燃输出 1…N，可设步间间隔（全 0 则立即接续）。

## 端子
- **输入**：控制
- **输出**：2–8 路（带编号）`,
  },
  gate: {
    title: "闸门",
    body: `多路输入 **AND**：按配置的输入路数，**每一口**都要收到脉冲才放行一次，然后清零到达标记。未接线的口也会挡住放行。

## 端子
- **输入**：2–8 路（编号固定，断开不会挤位）
- **输出**：控制 1 路

▶ 强制放行（忽略到达状态）。`,
  },
  splitter: {
    title: "分发",
    body: `一路入、多路出。脉冲到达后**同时**点亮全部输出（序列器的并行版）。

## 端子
- **输入**：控制
- **输出**：2–8 路`,
  },
  counter: {
    title: "计数",
    body: `每收到 N 次控制脉冲，放行一次并清零计数。

## 端子
- **输入**：控制
- **输出**：控制

▶ 计入一次；达到阈值则放行。`,
  },
  mutex: {
    title: "互斥",
    body: `多路输入 **OR**：任一输入脉冲即沿输出放行（先到即触发）。

## 选择模式（▶ 试跑时标记）
- **先到优先**
- **端口优先**（小号优先）
- **随机一路**

## 端子
- **输入**：2–8 路
- **输出**：控制 1 路`,
  },
};

const en = {
  input_text: { title: "Text input", body: `Edit text on the node, or enable batch for multiple entries. Output is data for process / save nodes.

## Ports
- **In**: usually none (may inherit read-only)
- **Out**: text` },
  input_image: { title: "Image input", body: `Drop images onto the node or add a batch.

## Ports
- **In**: usually none
- **Out**: image` },
  proc_text: { title: "Text process", body: `LLM processes upstream text from a prompt. Enable assistant mode for agent tools.

## Ports
- **In**: text (multi / @refs)
- **Out**: text` },
  proc_image: { title: "Image generate", body: `Generate an image from a prompt. Accepts text or image input.

## Ports
- **In**: text or image
- **Out**: image` },
  save: { title: "Save", body: `One save node infers type from its input (legacy save_text / save_image upgrade on load):

- **text** → \`.yaml\`
- **image** → \`.png\`
- **audio** (music gen) → \`.wav\`
- **video** (video gen) → \`.mp4\`

Placing music or video gen also creates a bound save node on the right (fixed offset, pinned wire). The gen node writes its filename into that save node.

## Ports
- **In**: text / image / audio / video
- **Out**: none` },
  save_text: { title: "Save text (merged)", body: `Merged into the unified Save node. Old \`save_text\` workflows still load.` },
  save_image: { title: "Save image (merged)", body: `Merged into the unified Save node. Images always use \`.png\`.` },
  split: { title: "Split", body: `Explode a batch into parallel item chains.

## Ports
- **In**: one batch source
- **Out**: items` },
  merge: { title: "Merge", body: `Join multiple text inputs into one.

## Ports
- **In**: many texts
- **Out**: one text` },
  task: { title: "Task", body: `A container with its own control graph: start → work / subtasks / judge → success or fail end.

▶ fires the inner **start** port.` },
  chat: { title: "Chat", body: `Multi-turn chat. Assistant mode uses an agent session stored on this node.

## Ports
- **In**: none
- **Out**: chat text` },
  agent_task: { title: "Agent task", body: `Agent run: files, web, shell. Output is filled from the run. Tool allowlist is the Approvals preset.` },
  control: { title: "Run / Clear", body: `Batch control. Wire targets in or out, then ▶ to run or clear them. Fill-only skips nodes that already have output.` },
  "ctrl-start": { title: "Start", body: `Fixed task entry. Task ▶ pulses from here. Cannot delete.

## Ports
- **In**: none
- **Out**: control` },
  "ctrl-end-ok": { title: "Success end", body: `Reaching here marks the task successful.

## Ports
- **In**: control
- **Out**: none` },
  "ctrl-end-fail": { title: "Fail end", body: `Reaching here marks the task failed.

## Ports
- **In**: control
- **Out**: none` },
  judge: { title: "Judge", body: `A text model decides yes/no against the task goal (or this node's criterion).

## Ports
- **Out top**: yes
- **Out bottom**: no` },
  wait_file: { title: "Wait for file", body: `Watch a path. Blocks until the file exists, then releases. Does not emit file contents.

## Ports
- **In**: none
- **Out**: control` },
  timer: { title: "Timer", body: `At the scheduled **local time**, send a “you may start” pulse to whatever is wired on the output.

## Turn it on / off

The node’s **▶** does **not** run targets immediately. It **starts the alarm**:

1. Pick a mode and time.
2. Click **▶** to watch the clock until the next due time.
3. Click **stop** to cancel waiting.

The status line shows the next fire time. **Fire now** sends one pulse immediately without changing whether the alarm is on.

## Modes
- **Once**: fires once, then turns itself off
- **Interval**: repeats every given days / hours / minutes
- **Cron**: five-field expression; use Smart fill

## Ports
- **In**: none
- **Out**: control (wire to nodes that should start on schedule)

In a task control flow, an incoming pulse waits until the **next** scheduled time, then continues downstream.` },
  delayer: { title: "Delayer", body: `Wait the configured duration after a pulse, then continue.

## Ports
- **In / Out**: control` },
  sequencer: { title: "Sequencer", body: `One in, many outs. Fires lanes **in order**, optional gap.

## Ports
- **Out**: 2–8 numbered` },
  gate: { title: "Gate", body: `AND join: every **configured** input port must receive a pulse (unwired ports still block). Then fires once and resets.

▶ force-releases.` },
  splitter: { title: "Splitter", body: `One in, many outs. Fires all lanes **in parallel**.` },
  counter: { title: "Counter", body: `Release once every N pulses, then reset.

▶ counts once.` },
  mutex: { title: "Mutex", body: `OR join: any input pulse releases the single output. ▶ marks a lane by first / priority / random.` },
};

const index = {
  localeDefault: "zh",
  ids: Object.keys(guides),
};

fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(index, null, 2));

for (const [id, spec] of Object.entries(guides)) {
  const md = `# ${spec.title}\n\n![diagram](img/${id}.svg)\n\n${spec.body}\n`;
  fs.writeFileSync(path.join(root, id + ".md"), md);
  if (diagrams[id]) fs.writeFileSync(path.join(imgDir, id + ".svg"), diagrams[id]);
  const e = en[id];
  if (e) {
    fs.writeFileSync(
      path.join(root, "en", id + ".md"),
      `# ${e.title}\n\n![diagram](img/${id}.svg)\n\n${e.body}\n`,
    );
  }
}

console.log("wrote", Object.keys(guides).length, "guides");

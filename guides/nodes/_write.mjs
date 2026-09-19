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
  "input_audio": diagram("input_audio", [
    box(20, 50, 100, 52, "音频输入", CYAN, FILL_D),
    arrow(120, 76, 178, 76, CYAN),
    box(178, 50, 150, 52, "该文件的 URL", "#8b97a8", "#12151b"),
    arrow(328, 60, 380, 44, GRN),
    arrow(328, 92, 380, 108, GRN),
    box(380, 24, 120, 40, "H3 参考音频", ORNG, FILL_P),
    box(380, 90, 120, 40, "保存 · 音频", GRN, "#101610"),
    `  <text x="250" y="150" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">1 个数据输出端子 = file:/// URL · 可 @引用</text>`,
  ].join("\n"), 520, 180),
  "input_video": diagram("input_video", [
    box(20, 50, 100, 52, "视频输入", CYAN, FILL_D),
    arrow(120, 76, 178, 76, CYAN),
    box(178, 50, 150, 52, "该文件的 URL", "#8b97a8", "#12151b"),
    arrow(328, 60, 380, 44, GRN),
    arrow(328, 92, 380, 108, GRN),
    box(380, 24, 120, 40, "H3 参考视频", ORNG, FILL_P),
    box(380, 90, 120, 40, "保存 · 视频", GRN, "#101610"),
    `  <text x="250" y="150" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">1 个数据输出端子 = file:/// URL · 可 @引用</text>`,
  ].join("\n"), 520, 180),
  "music_gen": diagram("music_gen", [
    box(20, 36, 90, 40, "提示词", CYAN, FILL_D),
    box(20, 92, 90, 40, "歌词", CYAN, FILL_D),
    arrow(110, 56, 156, 66, CYAN),
    arrow(110, 112, 156, 96, CYAN),
    box(156, 44, 140, 64, "Minimax Music 3", "#ff8fa3", "#1a1014"),
    arrow(296, 62, 350, 48, GRN),
    arrow(296, 96, 350, 116, GOLD),
    box(350, 28, 130, 40, "音频 · wav", GRN, "#101610"),
    box(350, 98, 130, 40, "控制下游", GOLD, FILL_C),
    `  <text x="250" y="152" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">自带输出路径 · 全局仅 1 个音视频任务</text>`,
  ].join("\n"), 520, 180),
  "tts_gen": diagram("tts_gen", [
    box(20, 56, 90, 44, "文本", CYAN, FILL_D),
    arrow(110, 78, 156, 78, CYAN),
    box(156, 44, 140, 68, "SoVITS 语音", "#ff8fa3", "#1a1014"),
    arrow(296, 62, 350, 44, GRN),
    arrow(296, 96, 350, 112, GOLD),
    box(350, 24, 130, 40, "语音 · wav", GRN, "#101610"),
    box(350, 94, 130, 40, "控制下游", GOLD, FILL_C),
    `  <text x="250" y="152" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">本地 GPT-SoVITS · 端口0=文本 · 端口1=控制</text>`,
  ].join("\n"), 520, 180),
  "video_gen": diagram("video_gen", [
    box(20, 30, 90, 36, "脉冲", GOLD, FILL_C),
    box(20, 76, 90, 36, "文本", CYAN, FILL_D),
    box(20, 122, 90, 36, "图像", CYAN, FILL_D),
    arrow(110, 48, 156, 62),
    arrow(110, 94, 156, 78, CYAN),
    arrow(110, 140, 156, 94, CYAN),
    box(156, 44, 140, 68, "Minimax H3", "#ff8fa3", "#1a1014"),
    arrow(296, 62, 350, 44, GRN),
    arrow(296, 96, 350, 112, GOLD),
    box(350, 24, 130, 40, "视频 · mp4", GRN, "#101610"),
    box(350, 94, 130, 40, "控制下游", GOLD, FILL_C),
    `  <text x="250" y="156" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">端口0=控制 · 端口1+=参考图 / 文本 / 音 / 视频</text>`,
  ].join("\n"), 520, 190),
  "video_upscale": diagram("video_upscale", [
    box(20, 30, 90, 36, "脉冲", GOLD, FILL_C),
    box(20, 84, 90, 36, "视频", CYAN, FILL_D),
    arrow(110, 48, 156, 64),
    arrow(110, 102, 156, 86, CYAN),
    box(156, 44, 140, 68, "视频超分", "#ff8fa3", "#1a1014"),
    arrow(296, 62, 350, 44, GRN),
    arrow(296, 96, 350, 112, GOLD),
    box(350, 24, 130, 40, "视频 · mp4", GRN, "#101610"),
    box(350, 94, 130, 40, "控制下游", GOLD, FILL_C),
    `  <text x="250" y="156" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">端口0=控制 · 端口1=源视频 · Real-ESRGAN x4 / x2 → 输出长边</text>`,
  ].join("\n"), 520, 190),
  "video_interp": diagram("video_interp", [
    box(20, 30, 90, 36, "脉冲", GOLD, FILL_C),
    box(20, 84, 90, 36, "视频", CYAN, FILL_D),
    arrow(110, 48, 156, 64),
    arrow(110, 102, 156, 86, CYAN),
    box(156, 44, 140, 68, "视频补帧", "#ff8fa3", "#1a1014"),
    arrow(296, 62, 350, 44, GRN),
    arrow(296, 96, 350, 112, GOLD),
    box(350, 24, 130, 40, "视频 · mp4", GRN, "#101610"),
    box(350, 94, 130, 40, "控制下游", GOLD, FILL_C),
    `  <text x="250" y="156" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">端口0=控制 · 端口1=源视频 · RIFE 2x/4x · fps 按倍数重算</text>`,
  ].join("\n"), 520, 190),
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
  input_audio: {
    title: "音频输入（选择文件 · 输出 URL）",
    body: `放一段本机音频当**素材**：点「选择音频」，或直接把 mp3 / wav / ogg / flac / m4a / aac 等文件拖到节点上。

## 端子
- **输入**：默认 1 个（端子存在、也能连线，但内容就是你在本节点选的那个文件，接上游不会产生任何效果）
- **输出**：1 个数据端子 —— 值是该文件的 \`file:///…\` URL（中文与空格自动百分号编码）

## 怎么用
- 连进 **Minimax H3** 的参考音频端子：接收端会把 URL 归一回本机绝对路径再交给后端，你不用手动转
- 连进 **保存** 节点：按音频落盘（复制到你指定的路径）
- \`@\` 引用：注入到提示词里的那段文本就是这个 URL

## 说明
- 只记录文件的**原始绝对路径**（不复制进工作流资产，音频可能很大）；文件被移走后要重新选一次
- 拖错类型（比如视频）会提示，不会改节点内容
- 要**生成**音频：语音用「音频生成 › SoVITS 语音」，音乐用「音频生成 › Minimax Music 3」`,
  },
  input_video: {
    title: "视频输入（选择文件 · 输出 URL）",
    body: `放一段本机视频当**素材**：点「选择视频」，或直接把 mp4 / webm / mov / mkv / avi 等文件拖到节点上。

## 端子
- **输入**：默认 1 个（端子存在、也能连线，但内容就是你在本节点选的那个文件，接上游不会产生任何效果）
- **输出**：1 个数据端子 —— 值是该文件的 \`file:///…\` URL（中文与空格自动百分号编码）

## 怎么用
- 连进 **Minimax H3** 的参考视频端子：接收端会把 URL 归一回本机绝对路径再交给后端
- 连进 **保存** 节点：按视频落盘（复制到你指定的路径）
- \`@\` 引用：注入到提示词里的那段文本就是这个 URL

## 说明
- 只记录文件的**原始绝对路径**（不复制进工作流资产，视频可能很大）；文件被移走后要重新选一次
- 预览走系统播放器内核，编码不支持时只显示提示文字
- 要**生成**视频：实拍感用「视频生成 › Minimax H3」，动效用「视频生成 › Remotion 视频」`,
  },
  music_gen: {
    title: "Minimax Music 3（音乐生成）",
    body: `画布右键 → **处理节点 › 音频生成 › Minimax Music 3**。本地 MiniMax Music 3 后端（Gradio）。**每次运行只生成一个音频文件**（\`.wav\`），写入节点自带的 \`outputPath\`，不需要再挂保存节点。

## 端子
- **输入**：端口 0 = 提示词 · 端口 1 = 歌词（可选，不接则按纯器乐 `[instrumental]` 生成）· 端口 2 = 控制输入
- **输出**：端口 0 = 音频（下游可试听 / 保存）· 端口 1 = 控制输出

## 参数
点节点头部 **⚙ 设置** 打开设置窗口来改；改完即时生效，节点卡片上只显示一行当前摘要。

- **输出路径**：\`.wav\` 保存位置（相对工作目录 / 超级节点子文件夹）
- **抽卡次数**：多次尝试（1–10），取其中一次结果
- **种子**：固定种子可复现；每次抽卡种子 +1

## 注意
- 全局同一时刻只允许 **1 个音视频任务**（音乐 / 视频互斥），其它任务会排队等待。
- 每个后端实例全局只有一个，多个音乐节点共享同一后端。
- 歌词与风格提示词的写法见**内置技能** \`minimax-music-lyrics\`（端口 1）/ \`minimax-music-prompt\`（端口 0）——两份随应用一起发版，**不用再去创意工坊下载**，在会话里打 \`/minimax-music-prompt 你的想法\` 就能直接用。风格提示词的产出形态固定为**一段六句英文散文**：曲风+情绪 → 速度与律动 → 乐器 → 人声 → 段落对比 → 制作混音。`,
  },
  tts_gen: {
    title: "SoVITS 语音生成（GPT-SoVITS）",
    body: `画布右键 → **处理节点 › 音频生成 › SoVITS 语音生成**。把文本合成成**语音**：后端是插件「GPT-SoVITS 语音合成」在本机拉起的 OpenAI 兼容服务。**每次运行只生成一个音频文件**（\`.wav\` / \`.mp3\`），写入节点自带的 \`outputPath\`，不需要再挂保存节点。

## 端子
- **输入**：端口 0 = 待合成文本 · 端口 1 = 控制输入
- **输出**：端口 0 = 语音音频（下游可试听 / 保存）· 端口 1 = 控制输出

## 参数
点节点头部 **⚙ 设置** 打开设置窗口来改；改完即时生效，节点卡片上只显示一行当前摘要。

- **输出路径**：音频保存位置（相对工作目录 / 超级节点子文件夹）
- **音色**：GPT-SoVITS 音色库里的音色名，留空则交给后端默认音色
- **语速**：0.5 – 2.0（默认 1.0）
- **输出格式**：\`.wav\` / \`.mp3\`
- **抽卡次数**：多次尝试（1–10），取其中一次结果

## 注意
- 后端没装 / 没起时节点会先尝试拉起并等待在线（最长 3 分钟），失败会把可照着做的提示写在节点状态行上；安装与音色准备都在 **插件 › GPT-SoVITS 语音合成** 里完成。
- 与音乐 / 视频走同一条**串行链**（同一时刻只跑一个生成任务），但 SoVITS 是独立进程、**不占主进程的音视频全局锁**，显存另算。
- 只要一段文本就能出声：文本可以来自文本输入 / 文本处理节点，也可以 \`@\` 引用。`,
  },
  video_gen: {
    title: "Minimax H3（视频生成）",
    body: `画布右键 → **处理节点 › 视频生成 › Minimax H3**。本地 MiniMax H3 后端（ComfyUI）。**每次运行只生成一个视频文件**（\`.mp4\`），写入节点自带的 \`outputPath\`，不需要再挂保存节点。

## 端子
- **输入**：**端口 0 = 控制输入（固定放在第一个端子，与视频超分 / 补帧 / Remotion 同构）** · **提示词 = 端口 1** · **R2V** 模式：端口 2–10 = 参考图 I1–I9、端口 11–13 = 参考视频 V1–V3、端口 14–16 = 参考音频 A1–A3（三组端子一次排全）· **FL2VA** 模式：端口 2–3 = 首帧 F / 末帧 L。数据端口号与面板 / 文档里的「端子 N」（数据槽号）**完全同号**，与后端 \`ref_image_0..8\` / \`ref_video_0..2\` / \`ref_audio_0..2\` 一一对应；数据线连端口 0 会被挡下（那颗是控制开关）
- **输出**：端口 0 = 视频（下游可试看）· 端口 1 = 控制输出

## 参数
点节点头部 **⚙ 设置** 打开设置窗口来改；改完即时生效，节点卡片上只显示一行当前摘要。

- **输出路径**：\`.mp4\` 保存位置（相对工作目录 / 超级节点子文件夹）
- **生成模式**：\`fl2va\` = 首末帧（默认）；\`r2v\` = 多参考图
- **时长**：4–15 秒（默认 5）
- **分辨率**：auto（按比例默认）/ 480p / 720p / 1080p（显存不足自动降档）
- **后处理**：本节点**不再**跑超分 / 补帧——需要时另建 **视频超分** / **视频补帧** 节点单独运行
- **抽卡次数**：多次尝试（1–10）

## 自建 ComfyUI 工作流（可选）

节点默认走内置 H3 链（首末帧 / 多参考）。想跑**自己搭的 ComfyUI 图**：点节点头部 **⚙ 设置** 打开设置窗口 → 「工作流来源」选 **自建 ComfyUI 工作流**。

- **库**：工作流存在本机全局库（\`<数据目录>/h3-workflows/\`），在 **H3 管理窗口 · 自建工作流库** 里导入（拖 JSON 文件 / 粘贴 JSON），ComfyUI 的 **API 格式**与 **UI 格式**都能识别（UI 格式自动转 API 格式，自动丢掉 Reroute / Note / 常量原语等前端节点）。「管理」按钮直接打开那个窗口。
- **打开**：库里每条模板右侧都有「打开」，点一下就在**内嵌的 ComfyUI 编辑器**里编辑这一条（后端没跑会先问一句再拉起）。这只是「拿出去改」，**不会覆盖库里的模板**——改完想回到库里 / 上画布，仍然只有 ComfyUI 里「导出 (API)」→ 回管理窗口「导入 JSON」这一条路。
- **端子**：图里被「提升为节点参数」的字段会在设置窗口里各占一个数据端子——**数据端子 1 = 文本 · 2+ = 素材（图 / 视频 / 音频）**（v5：端口号 ≡ 数据槽号，**端口 0 仍是控制输入**），顺序就是参数表顺序，可用 ▲▼ 调整。默认参数表取扫描建议（提示词 / LoadImage / 种子…），可增删改名。
- **直填值**：每个参数都可在设置窗口里直接填值；**端子接了数据时端子优先**，端子没接才用直填值，都没有就沿用工作流 JSON 里的原值。素材填本机绝对路径，生成时自动上传到 ComfyUI。
- **输出节点**：图里有多个 \`Save*\` 时指定取哪一个当本节点的产物；留空 = 最后一个视频产物。
- **失效与校验**：↻ 会把参数表与库里最新的图重新同步（图上改掉的落点标「落点已失效」，不静默删）；「校验节点包」按后端 \`/object_info\` 比对自定义节点是否装了（后端没运行则跳过，**不阻断生成**）。
- 种子沿用节点上的 **种子 / 摇数**：一次执行把该种子统一下发到图里**所有** \`seed\` / \`noise_seed\` 类字段。
- 自建模式下 **时长 / 分辨率 / 采样等内置参数一律失效**（由工作流图自己决定，设置窗口里也不再出现这些项），也不做 24G 钳制；抽卡、进度、取消、输出路径与全局互斥照常。

## 注意
- 全局同一时刻只允许 **1 个音视频任务**（音乐 / 视频互斥）。
- **本节点只出原生片**：超分 / 补帧已拆成独立节点（处理节点 › 视频生成 › 视频超分 / 视频补帧），按需单独运行，也可串联 **H3 → 视频超分 → 视频补帧**。
- 24G 显存上限会限制分辨率档位；超分 / 补帧的显存建议见对应节点指南。
- 参考图 / 参考音频 / 参考视频都可以直接连**图像输入**、**音频输入**、**视频输入**节点：媒体端子给的是 \`file:///…\` URL，本节点会自动归一回本机路径。`,
  },
  video_upscale: {
    title: "视频超分（Real-ESRGAN x4 / x2 · 独立后处理）",
    body: `画布右键 → **处理节点 › 视频生成 › 视频超分**。给一段**已有视频**单独做超分：Real-ESRGAN 逐帧放大，再缩放到输出长边。它**不再跟着 Minimax H3 生成一起跑**——H3 只出原生片，超分按需单独运行。**每次运行只出一个视频文件**（\`.mp4\`），写入节点自带的 \`outputPath\`，不需要再挂保存节点。

## 端子
- **输入**：端口 0 = 控制输入（固定）· 端口 1 = 源视频 · 端口 2+ = 可选素材（渐进展开）
- **输出**：端口 0 = 视频（下游可试看）· 端口 1 = 控制输出

源视频可以来自 **Minimax H3** 的输出、**视频输入**节点，或任何产出视频的上游；本节点只接受视频，接图像会拒绝。

## 参数
点节点头部 **⚙ 设置** 打开设置窗口来改；改完即时生效，节点卡片上只显示一行当前摘要。

- **超分倍率**：**x4**（默认，画质最好）或 **x2**（输出只放大 2 倍，更快）。倍率是输出上限：**输出 = min(目标长边, 源长边 × 倍率)** —— x2 时 720p 源出 2560、1080p 源出 3840，不会被目标长边拉成 4 倍。
- **超分模型**：\`RealESRGAN_x4plus.pth\`（通用 x4）或 \`RealESRGAN_x2plus.pth\`（原生 x2，可选权重）——下发给超分的值必须是**文件名（含扩展名）**，缺扩展名会被判 \`value_not_in_list\` 拒图（应用已自动补齐）。选 **x2 倍率**时若本机有 x2 权重会**自动优先用它**（显存与耗时都低一档）；没有也能跑：用 x4 权重超分后缩到 2 倍。
- **目标长边（像素）**：1280–7680（默认 3840 = 4K），是**输出长边的上限**；逐帧分块流式下**不再受内存限制**，只是输出尺寸与耗时的选择。x2 倍率时还会被「源长边 × 2」封顶，源分辨率未知时不追加缩放（保留权重原生尺寸）
- **逐帧批量 per_batch**：每次交给超分模型的帧数（默认 1）；**低显存安全档保持 1**（流式链本来就是逐帧，此项只影响回退到 ComfyUI 图链时的批大小）
- **分块 tile（像素）**：0–1024（默认 512）。流式超分的**分块大小**：显存只跟它有关，**512 适合 16G 机器**；0 = 后端默认 512
- **低显存安全档（强制逐帧）**：默认开；开 = **分块 fp16 省显存，16G 机器也能跑 15 秒片**，关 = 按上面的 \`per_batch\` 批量 / 更大分块（更快但更吃显存）
- **抽卡次数**：多次处理（1–10），多次时输出命名为 \`#1\`、\`#2\` …
- **输出路径**：\`.mp4\` 保存位置（相对工作目录 / 超级节点子文件夹）

## 内存 / 显存使用建议
- **默认走逐帧分块流式链**（\`h3-pack/post/stream_upscale.py\`）：源视频用 PyAV 顺序解码，按 \`tile\` 分块过 Real-ESRGAN，
  **每帧处理完立刻编码写盘**，常驻内存只跟「一个分块 + 一帧输出画布」有关 —— **与视频时长、分辨率、倍率都无关**，
  所以 **16G 内存也能完成 15 秒级视频的 x2 / x4 超分**。（旧版把整段视频的帧张量外加 float32 副本攒在 RAM 里，
  峰值 ≈ 帧数 × 源像素 × 倍率²，15 秒片连 64G 都不够 —— 这条链已改为默认不走。）
- **显存只跟 tile 与精度有关**：默认分块 512 + fp16；显存偏小或没开安全档时后端会落 fp32、必要时把分块减半。
  分块越小越省、越大越快；目标长边与视频时长都不影响能不能跑。
- **音轨原样直拷**：输出容器从源文件直接复制音频包，不重编码。
- 首次 OOM 时后端会**自动降一档重试一次**（分块减半 + fp32，不动目标长边 / 倍率），结果写在节点状态行上。
- **兜底链才会回到旧口径**：脚本 / venv 缺失或流式链非 OOM 失败时，后端自动回退 ComfyUI 图链（控制台写明
  「已回退图路径 + 原因」，日志与旧版一致）：那时整段帧张量攒在 RAM，峰值 ≈ 源像素 × 倍率² × 帧数，
  长边越大越吃内存 —— 会用 \`--cache-ram\` 限制缓存留存，并可能压长边 / 预缩放源帧。
- **跑多单不会「越跑越紧」**：流式链每次运行都是独立子进程，进程结束即回收，没有常驻内存累积；只有兜底图链仍走常驻
  ComfyUI 后端（内存护栏按单收尾量系统内存，超限才后台重启回收，见 H3 控制台「24G 启动优化」）。

## 注意
- 全局同一时刻只允许 **1 个音视频任务**（音乐 / 语音 / 视频 / 超分 / 补帧互斥），其它任务排队等待。
- 超分与补帧是两个**互相独立**的节点，可单独用，也可串联：**H3 → 视频超分 → 视频补帧**。
- 后端没起时节点会先尝试拉起 H3 后端并等待在线，失败会把可照着做的提示写在节点状态行上。
- 与 H3 生成共用同一套后端与媒体互斥锁；后处理在提交前会先释放生成占用的模型，避免显存叠加。`,
  },
  video_interp: {
    title: "视频补帧（RIFE · 独立后处理）",
    body: `画布右键 → **处理节点 › 视频生成 › 视频补帧**。给一段**已有视频**单独补帧：RIFE VFI 按倍数插帧，帧率按倍数重算（2x / 4x）。它**不再跟着 Minimax H3 生成一起跑**——H3 只出原生片，补帧按需单独运行。**每次运行只出一个视频文件**（\`.mp4\`），写入节点自带的 \`outputPath\`，不需要再挂保存节点。

## 端子
- **输入**：端口 0 = 控制输入（固定）· 端口 1 = 源视频 · 端口 2+ = 可选素材（渐进展开）
- **输出**：端口 0 = 视频（下游可试看）· 端口 1 = 控制输出

源视频可以来自 **Minimax H3** 的输出、**视频输入**节点，或任何产出视频的上游；本节点只接受视频，接图像会拒绝。

## 参数
点节点头部 **⚙ 设置** 打开设置窗口来改；改完即时生效，节点卡片上只显示一行当前摘要。

- **补帧倍率**：\`2x\`（推荐）/ \`4x\` / \`1x\`（仅重编码）；fps 按倍数重算（源 24fps → 2x 得 48fps）。逐帧流式下倍率不再受内存限制，只影响输出帧数与耗时
- **清缓存间隔（帧）**：每 N 帧清一次缓存（默认 2）；流式档每帧算完即写盘，此项只影响回退到 ComfyUI 图链时的表现
- **逐帧批量 batch_size**：每次交给 RIFE 的帧数（默认 1）；流式档逐帧处理，此项只影响回退到 ComfyUI 图链时的表现
- **缩放系数 scale_factor**：RIFE 内部缩放系数（默认 1.0 = 原分辨率）；流式档同样生效，不改变输出分辨率
- **低显存安全档**：默认开；开 = 低精度 fp16 + 逐帧 + 极小缓存清理间隔，峰值最低
- **抽卡次数**：多次处理（1–10），多次时输出命名为 \`#1\`、\`#2\` …
- **输出路径**：\`.mp4\` 保存位置（相对工作目录 / 超级节点子文件夹）

## 内存 / 显存使用建议
- **默认走逐帧流式链**（\`h3-pack/post/stream_interp.py\`）：源视频用 PyAV 顺序解码，同一时刻只持有**相邻两帧 + 一张中间帧**，
  **每帧算完立刻编码写盘**，常驻内存只跟「相邻两帧 + 模型」有关 —— **与视频时长、分辨率、倍率都无关**，
  所以 **16G 内存也能完成 15 秒级视频的 2x / 4x 补帧**。（旧版把整段视频的帧解出来再全片收集补帧结果，
  15 秒 1080p 30fps 一份帧数组约 11GB、4x 后约 45GB，连 64G 都不够 —— 这条链已改为默认不走。）
- **显存只跟精度与缩放系数有关**：默认 fp16；显存偏小或没开安全档时后端会落 fp32。倍率越大越慢，但不影响能不能跑。
- **音轨原样直拷**：输出容器从源文件直接复制音频包，不重编码。
- 首次 OOM 时后端会**自动降一档重试一次**（精度落 fp32，必要时预缩放长边降一档，倍率不动），结果写在节点状态行上。
- **兜底链才会回到旧口径**：脚本 / venv / RIFE 权重缺失或流式链非 OOM 失败时，后端自动回退 ComfyUI 图链（控制台写明
  「已回退图路径 + 原因」，日志与旧版一致）：那时整段帧数组攒在 RAM，长边越大越吃内存，可能压长边 / 预缩放源帧。
- **跑多单不会「越跑越紧」**：流式链每次运行都是独立子进程，进程结束即回收，没有常驻内存累积；只有兜底图链仍走常驻
  ComfyUI 后端（内存护栏按单收尾量系统内存，超限才后台重启回收，见 H3 控制台「24G 启动优化」）。

## 注意
- **音轨原样带走**：源视频的音轨会一起进产物，补帧只改画面帧率。
- 全局同一时刻只允许 **1 个音视频任务**（音乐 / 语音 / 视频 / 超分 / 补帧互斥），其它任务排队等待。
- 超分与补帧是两个**互相独立**的节点，可单独用，也可串联：**H3 → 视频超分 → 视频补帧**。
- 后端没起时节点会先尝试拉起 H3 后端并等待在线，失败会把可照着做的提示写在节点状态行上。`,
  },
  proc_text: {
    title: "文本处理",
    body: `用大模型按提示词处理上游文本。可开「智能助手」走 agent（读文件 / 联网）。

## 端子
- **输入**：文本（可多路 / @引用）
- **输出**：处理后的文本

## 设置
**服务商 / 模型 / 温度**都在节点头部 **⚙ 设置** 打开的设置窗口里改（◈ 预览看的是运行时真正发出去的请求）；节点卡片上只显示一行当前摘要。提示词属于内容，仍写在节点里。

## 运行显示
开了「智能助手」后，**思考与输出分开显示**：思考折叠成 **「◉ 思考 · N 字」** 段（N 只数思考的字数），模型说出来的话以正常字号逐段显示，**🔧 工具**调用就近插在发生位置。输出端子给下游的仍是完整正文。

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
  agent_task: {
    title: "智能任务",
    body: `通用 agent：按任务描述读文件、联网、执行命令，结果回填输出。服务商走 DeepSeek 路由。

## 端子
- **输入**：文本 / 引用
- **输出**：任务产物文本

## 设置
**预设 / 供应商 / 模型 / 思考强度**都在节点头部 **⚙ 设置** 打开的设置窗口里改（预设与「智能会话」同一张表）；节点卡片上只显示一行当前摘要。任务描述属于内容，仍写在节点里。

## 会话模式（💬）
点头部的 **💬** 切成会话模式：微信风格气泡（助手左、用户右），历史随节点保存，多轮追问就在节点里进行。旧的「文本对话」节点已移除，打开旧画布时会自动迁移成这种带会话模式的智能任务节点。

## 运行显示
**思考与输出分开显示**：运行时按发生顺序分段 —— **「◉ 思考 · N 字」** 只折叠模型内部推理（N 只数思考的字数），中间步骤说出来的话以正常字号**正文**逐段显示，**🔧 工具**调用就近插在发生位置，错误以 ⚠ 附在正文里。每调用一次工具或进入新一步推理就另起一段；点节点头部的 **「◉ 思考」** 按钮可放大查看（上半思考、下半输出）。

## 许可
工具能力由顶栏「审批」预设控制。`,
  },
  control: {
    title: "执行 / 清空",
    body: `批控节点。把要操作的节点连到本节点（连出或连入均可），点 ▶ 一次执行或清空。

## 设置
**动作（执行 / 清空）、「补缺」与「固定节点」**在节点头部 **⚙ 设置** 打开的设置窗口里改；要改「管哪些节点」仍在画布上连线，设置窗口里只列清单。

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

## 设置
**监视路径与轮询间隔**在节点头部 **⚙ 设置** 打开的设置窗口里改；「浏览 / 位置」是动作按钮，仍留在节点上。

## 端子
- **输入**：无
- **输出**：控制（连到下游，避免下游提前跑）`,
  },
  timer: {
    title: "定时触发器",
    body: `按**系统本地时间**到点后，给输出端连接的节点发一次「可以开始了」的信号。

## 怎么打开 / 关掉

节点上的 **▶** 不是立刻跑下游，而是**打开闹钟**：

1. 先在节点头部 **⚙ 设置** 打开的设置窗口里选好模式和时间（模式 / 计划时间 / 间隔 / Cron 全在那里改）。
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

## 设置
**延时时长**在节点头部 **⚙ 设置** 打开的设置窗口里改；节点上只显示一行当前摘要。

## 端子
- **输入**：控制
- **输出**：控制

▶ 可立即开始一次延时并启用已连接目标。`,
  },
  sequencer: {
    title: "序列器",
    body: `一路入、多路出。脉冲到达后**按顺序**点燃输出 1…N，可设步间间隔（全 0 则立即接续）。

## 设置
**输出路数与步间间隔**在节点头部 **⚙ 设置** 打开的设置窗口里改；节点上只显示一行当前摘要。

## 端子
- **输入**：控制
- **输出**：2–8 路（带编号）`,
  },
  gate: {
    title: "闸门",
    body: `多路输入 **AND**：按配置的输入路数，**每一口**都要收到脉冲才放行一次，然后清零到达标记。未接线的口也会挡住放行。

## 设置
**输入路数**在节点头部 **⚙ 设置** 打开的设置窗口里改；节点上只显示一行当前摘要，「清除到达」是动作按钮留在节点上。

## 端子
- **输入**：2–8 路（编号固定，断开不会挤位）
- **输出**：控制 1 路

▶ 强制放行（忽略到达状态）。`,
  },
  splitter: {
    title: "分发",
    body: `一路入、多路出。脉冲到达后**同时**点亮全部输出（序列器的并行版）。

## 设置
**输出路数**在节点头部 **⚙ 设置** 打开的设置窗口里改；节点上只显示一行当前摘要。

## 端子
- **输入**：控制
- **输出**：2–8 路`,
  },
  counter: {
    title: "计数",
    body: `每收到 N 次控制脉冲，放行一次并清零计数。

## 设置
**N（每几次放行）**在节点头部 **⚙ 设置** 打开的设置窗口里改；节点上只显示一行当前摘要，「清零计数」是动作按钮留在节点上。

## 端子
- **输入**：控制
- **输出**：控制

▶ 计入一次；达到阈值则放行。`,
  },
  mutex: {
    title: "互斥",
    body: `多路输入 **OR**：任一输入脉冲即沿输出放行（先到即触发）。

## 设置
**输入路数与择一模式**在节点头部 **⚙ 设置** 打开的设置窗口里改；节点上只显示一行当前摘要。

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
  input_audio: { title: "Audio input (pick a file · outputs a URL)", body: `Hold a local audio file as **material**: click “Pick audio”, or drop an mp3 / wav / ogg / flac / m4a / aac file onto the node.

## Ports
- **In**: 1 by default (the port exists and can be wired, but the content is the file you picked here — an upstream connection has no effect)
- **Out**: 1 data port — its value is the file's \`file:///…\` URL (CJK and spaces percent-encoded)

## Using it
- Wire it into a **Minimax H3** reference-audio slot: the receiver turns the URL back into a local absolute path before handing it to the backend
- Wire it into a **Save** node: written out as audio (copied to your path)
- \`@\` reference: the text injected into a prompt is that URL

## Notes
- Stores the file's **original absolute path** only (nothing is copied into the workflow assets, audio can be large). Move the file away and you need to pick it again.
- Dropping the wrong media type is refused with a hint.
- To **generate** audio: speech via “Audio gen › SoVITS speech”, music via “Audio gen › Minimax Music 3”.` },
  input_video: { title: "Video input (pick a file · outputs a URL)", body: `Hold a local video file as **material**: click “Pick video”, or drop an mp4 / webm / mov / mkv / avi file onto the node.

## Ports
- **In**: 1 by default (the port exists and can be wired, but the content is the file you picked here — an upstream connection has no effect)
- **Out**: 1 data port — its value is the file's \`file:///…\` URL (CJK and spaces percent-encoded)

## Using it
- Wire it into a **Minimax H3** reference-video slot: the receiver turns the URL back into a local absolute path before handing it to the backend
- Wire it into a **Save** node: written out as video (copied to your path)
- \`@\` reference: the text injected into a prompt is that URL

## Notes
- Stores the file's **original absolute path** only (nothing is copied into the workflow assets, video can be large). Move the file away and you need to pick it again.
- Playback uses the built-in player; an unsupported codec shows a hint instead.
- To **generate** video: live-action style via “Video gen › Minimax H3”, motion graphics via “Video gen › Remotion video”.` },
  music_gen: { title: "Minimax Music 3 (music generation)", body: `Right-click the canvas → **Process › Audio generation › Minimax Music 3**. Local MiniMax Music 3 backend (Gradio). **Each run produces exactly one audio file** (\`.wav\`) written to the node's own \`outputPath\` — no separate save node needed.

## Ports
- **Input**: port 0 = prompt · port 1 = lyrics (optional — leave it unwired to generate pure instrumental `[instrumental]`) · port 2 = control input
- **Output**: port 0 = audio (play / save downstream) · port 1 = control output

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Output path**: \`.wav\` destination (relative to workspace / super subfolder)
- **Attempts**: gacha rolls (1–10); keep one result
- **Seed**: fixed seed reproduces; each roll bumps the seed by +1

## Notes
- Only **1 audio/video task** is allowed globally at a time (music and video are mutually exclusive); other tasks queue.
- One backend instance per plugin; multiple music nodes share it.
- Lyrics and style-prompt conventions live in the **built-in skills** \`minimax-music-lyrics\` (port 1) / \`minimax-music-prompt\` (port 0) — both ship with the app, **no Creative Workshop download needed**; type \`/minimax-music-prompt <your idea>\` in a session to use them. A style prompt is delivered as **one English paragraph of six sentences**: style + mood → tempo & groove → instruments → vocals → structure & contrast → production.` },
  tts_gen: { title: "SoVITS speech (GPT-SoVITS)", body: `Right-click the canvas → **Process › Audio generation › SoVITS speech**. Turns text into **speech**: the backend is the local OpenAI-compatible service started by the “GPT-SoVITS speech” plugin. **Each run produces exactly one audio file** (\`.wav\` / \`.mp3\`) written to the node's own \`outputPath\` — no separate save node needed.

## Ports
- **Input**: port 0 = text to speak · port 1 = control input
- **Output**: port 0 = speech audio (play / save downstream) · port 1 = control output

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Output path**: audio destination (relative to workspace / super subfolder)
- **Voice**: a name from the GPT-SoVITS voice library; empty = whatever the backend defaults to
- **Speed**: 0.5 – 2.0 (default 1.0)
- **Format**: \`.wav\` / \`.mp3\`
- **Attempts**: gacha rolls (1–10); keep one result

## Notes
- If the backend is missing or stopped the node starts it and waits for it to come online (up to 3 minutes); failures are written on the node's status line as an actionable hint. Installing the backend and preparing voices happens in **Plugins › GPT-SoVITS speech**.
- Speech runs on the same **serial chain** as music / video (one generation task at a time), but SoVITS is a separate process and does **not** hold the app's audio/video global lock — its VRAM is its own budget.
- One text is enough: feed port 0 from a text input / text process node, or with an \`@\` reference.` },
  video_gen: { title: "Minimax H3 (video generation)", body: `Right-click the canvas → **Process › Video generation › Minimax H3**. Local MiniMax H3 backend (ComfyUI). **Each run produces exactly one video file** (\`.mp4\`) written to the node's own \`outputPath\` — no separate save node needed.

## Ports
- **Input**: **port 0 = control input (pinned first, same shape as video upscale / interpolation / Remotion)** · port 1 = prompt · data ports 2+ = data slots (R2V images 2–10, videos 11–13, audios 14–16; FL2VA first/last frame 2–3). Data port numbers are **identical to the "terminal N" numbers** shown in the panel / docs (and to the backend \`ref_image_0..8\` / \`ref_video_0..2\` / \`ref_audio_0..2\`); a data wire on port 0 is rejected — that one is the control switch
- **Output**: port 0 = video (preview downstream) · port 1 = control output

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Output path**: \`.mp4\` destination (relative to workspace / super subfolder)
- **Mode**: \`fl2va\` = first/last frame (default); \`r2v\` = multiple reference images
- **Duration**: 4–15 s (default 5)
- **Resolution**: auto (proportional) / 480p / 720p / 1080p (auto-downscaled when VRAM is low)
- **Post**: this node **no longer** runs upscale / interpolation — add a **Video upscale** / **Video interpolation** node and run it separately
- **Attempts**: gacha rolls (1–10)

## Custom ComfyUI workflow (optional)

By default the node runs the built-in H3 chain (first/last frame or multi-reference). To run **a graph you built yourself**: click **⚙ Settings** in the node header → set **Workflow source** to **Custom ComfyUI workflow**.

- **Library**: workflows live in a machine-wide library (\`<data dir>/h3-workflows/\`), imported in the **H3 manager window · custom workflow library** (drop a JSON file / paste JSON). Both the ComfyUI **API format** and the **UI format** are detected (UI graphs are converted, front-end-only nodes such as Reroute / Note / primitives are dropped). The **Manage** button opens that window.
- **Open**: every library entry carries an **Open** action — it edits *that one workflow* inside an **embedded ComfyUI editor** (if the backend is down it asks before starting it). This only hands the graph out for editing and **never overwrites the library entry** — getting your edits back into the library (and onto the canvas) still has exactly one route: ComfyUI's **Export (API)** → **Import JSON** in the manager window.
- **Ports**: every field you promote to a node parameter takes one input port — **port 1 = text · port 2+ = media (image / video / audio)** — in parameter-table order (▲▼ reorders), all listed in the settings window. The initial table comes from the graph scan (prompt / LoadImage / seed…) and is fully editable.
- **Manual values**: each parameter also accepts a literal value in the settings window; **a wired port wins over the manual value**, and if neither is given the value stored in the workflow JSON is kept. Media values are absolute local paths, uploaded to ComfyUI at run time.
- **Output node**: when the graph has several \`Save*\` nodes, pick which artifact this node returns (blank = last video output).
- **Refresh & validation**: ↻ re-syncs the parameter table with the stored graph (targets that vanished are flagged, never silently deleted); **Validate nodes** diffs node classes against the backend \`/object_info\` (skipped while the backend is down — it never blocks generation).
- The node's **Seed / Reroll** control drives seeding: one run writes that seed into **every** \`seed\` / \`noise_seed\`-style field in the graph.
- In custom mode the built-in **duration / resolution / sampler** options no longer apply — the graph decides them and the settings window stops showing them; no 24G clamping happens either. Rolls, progress, cancel, output path and the global media lock stay as they are.

## Notes
- Only **1 audio/video task** is allowed globally at a time (music and video are mutually exclusive).
- **This node outputs the native clip only**: upscale / interpolation are separate nodes (Process › Video generation › Video upscale / Video interpolation); run them on demand, or chain **H3 → Video upscale → Video interpolation**.
- 24G VRAM caps the resolution tiers; upscale / interpolation VRAM guidance lives in their own node guides.
- Reference images / audio / video can come straight from an **image / audio / video input** node: media ports carry a \`file:///…\` URL and this node normalizes it back to a local path.
- **Sage Attention** (optional speed tier, about 1.5–2×) needs \`triton-windows\` *and* a prebuilt \`sageattention\` wheel matching this venv — one without the other counts as missing. **Nothing breaks when they are absent**: the plugin probes the venv before every run and simply leaves the Sage node out (just slower). Probe and install are one click in the **H3 plugin window → the \`Sage 加速\` button** (it picks the wheel for your Python / torch / CUDA and re-verifies right after).` },
  video_upscale: { title: "Video upscale (Real-ESRGAN x4 / x2 · standalone post-process)", body: `Right-click the canvas → **Process › Video generation › Video upscale**. Upscales an **existing video** on its own: Real-ESRGAN enlarges each frame, then the result is scaled to the output long side. It **no longer runs together with Minimax H3 generation** — H3 only outputs the native clip, and upscaling runs separately when you ask for it. **Each run produces exactly one video file** (\`.mp4\`) written to the node's own \`outputPath\` — no separate save node needed.

## Ports
- **Input**: port 0 = control input (fixed) · port 1 = source video · port 2+ = optional material (grows as needed)
- **Output**: port 0 = video (preview downstream) · port 1 = control output

The source video can come from a **Minimax H3** output, a **video input** node, or any upstream node that produces video; this node only accepts video and refuses images.

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Upscale ratio**: **x4** (default, best quality) or **x2** (output magnified 2× only, faster). The ratio caps the output: **output = min(target long side, source long side × ratio)** — with x2 a 720p source yields 2560 and a 1080p source yields 3840, never 4× just because the target says so.
- **Upscale model**: \`RealESRGAN_x4plus.pth\` (general x4) or \`RealESRGAN_x2plus.pth\` (native x2, optional weight) — the value sent to the upscaler must be the **file name including its extension**; a bare \`RealESRGAN_x4plus\` is rejected with \`value_not_in_list\` (the app appends the extension automatically). With the **x2 ratio** the app **automatically prefers a native x2 weight when one is installed** (one tier lighter on both VRAM and time); without one it still works — the x4 weight upscales and the tail is scaled back down to 2×.
- **Target long side (px)**: 1280–7680 (default 3840 = 4K) — a **cap** on the output long side; with per-frame tiled streaming it is **no longer limited by system RAM**, it only trades output size against time. With the x2 ratio it is additionally capped at source long side × 2, and no scaling is added when the source size is unknown (the weight's native size is kept)
- **Per-frame batch (per_batch)**: frames handed to the upscale model at a time (default 1); the **low-VRAM safe tier keeps it at 1** (the stream path is per-frame anyway; this only sets the batch size when falling back to the ComfyUI graph)
- **Tile (px)**: 0–1024 (default 512). The **tile size** of streaming upscale: VRAM depends only on it, and **512 suits a 16 GB machine**; 0 = backend default 512
- **Low-VRAM safe tier (force per-frame)**: on by default; on = **tiled fp16 keeps VRAM low — a 16 GB machine can handle a 15-second clip**, off = batch by \`per_batch\` / larger tiles (faster, hungrier)
- **Attempts**: repeated runs (1–10); multiple outputs are named \`#1\`, \`#2\` …
- **Output path**: \`.mp4\` destination (relative to workspace / super subfolder)

## RAM / VRAM guidance
- **By default this runs a per-frame tiled streaming chain** (\`h3-pack/post/stream_upscale.py\`): the source is decoded sequentially with PyAV, upscaled tile by tile according to \`tile\`, and **each frame is encoded to disk as soon as it is done**. Resident memory depends only on one tile plus one output frame — **independent of clip length, resolution and ratio** — so **a 16 GB machine can finish an x2 / x4 upscale of a 15-second clip**. (The old path piled the whole clip's frame tensors plus a float32 copy into RAM — peak ≈ frames × source pixels × ratio², which a 15-second clip can blow past even with 64 GB — and is no longer the default.)
- **VRAM depends only on the tile and the precision**: default tile 512 + fp16; on low-VRAM machines, or when the safe tier is off, the backend drops to fp32 and halves the tile when needed. Smaller tiles are lighter, larger ones faster; neither the target long side nor the clip length decides whether it fits.
- **The audio track is copied verbatim**: audio packets go straight from the source file into the output container, no re-encode.
- On the first OOM the backend **drops one tier and retries once** (tile halved + fp32, target long side / ratio untouched) and reports the result on the node's status line.
- **Only the fallback chain follows the old rules**: if the script / venv is missing, or the stream path fails for a non-OOM reason, the backend falls back to the ComfyUI graph (the console says “fell back to the graph path + why”, and the logs match the previous release). There the whole clip's frame tensors pile up in RAM — peak ≈ source pixels × ratio² × frames, so a bigger long side costs more RAM; \`--cache-ram\` caps retained caches and the long side / source may be pre-scaled.
- **Running many clips no longer gets tighter and tighter**: every streaming run is its own subprocess and its memory is reclaimed when it exits. Only the fallback graph chain still uses the resident ComfyUI backend (its memory rail measures system memory per run and recycles the backend in the background when over budget — see “24G startup optimizations” in the H3 console).

## Notes
- Only **1 audio/video task** is allowed globally at a time (music / speech / video / upscale / interpolation are mutually exclusive); other tasks queue.
- Upscale and interpolation are two **independent** nodes — use either alone, or chain them: **H3 → Video upscale → Video interpolation**.
- If the backend is down the node starts the H3 backend and waits for it to come online; failures are written on the node's status line as an actionable hint.
- It shares the backend and the media mutex with H3 generation; before submitting, post-processing frees the generation models so the two never stack in VRAM.` },
  video_interp: { title: "Video interpolation (RIFE · standalone post-process)", body: `Right-click the canvas → **Process › Video generation › Video interpolation**. Interpolates an **existing video** on its own: RIFE VFI inserts frames by a multiplier and the frame rate is recomputed from it (2x / 4x). It **no longer runs together with Minimax H3 generation** — H3 only outputs the native clip, and interpolation runs separately when you ask for it. **Each run produces exactly one video file** (\`.mp4\`) written to the node's own \`outputPath\` — no separate save node needed.

## Ports
- **Input**: port 0 = control input (fixed) · port 1 = source video · port 2+ = optional material (grows as needed)
- **Output**: port 0 = video (preview downstream) · port 1 = control output

The source video can come from a **Minimax H3** output, a **video input** node, or any upstream node that produces video; this node only accepts video and refuses images.

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Multiplier**: \`2x\` (recommended) / \`4x\` / \`1x\` (re-encode only); the frame rate is recomputed (24 fps source → 48 fps at 2x). With per-frame streaming the multiplier is no longer limited by RAM — it only affects the frame count and the time it takes
- **Clear-cache interval (frames)**: flush the cache every N frames (default 2); the stream path writes each frame as soon as it is done, so this only affects the ComfyUI graph fallback
- **Per-frame batch (batch_size)**: frames handed to RIFE at a time (default 1); the stream path is per-frame, so this only affects the ComfyUI graph fallback
- **Scale factor**: RIFE's internal scale (default 1.0 = source resolution); it applies to the stream path too and never changes the output resolution
- **Low-VRAM safe tier**: on by default; on = low-precision fp16 plus per-frame handling and a tiny cache interval for the lowest peak
- **Attempts**: repeated runs (1–10); multiple outputs are named \`#1\`, \`#2\` …
- **Output path**: \`.mp4\` destination (relative to workspace / super subfolder)

## Memory / VRAM guidance
- **The per-frame streaming path is the default** (\`h3-pack/post/stream_interp.py\`): the source is decoded sequentially with PyAV and only **two adjacent frames plus one intermediate frame** are held at a time,
  and **every frame is encoded to disk as soon as it is done**. Resident memory depends only on "two adjacent frames + the model" — **not on clip length, resolution or multiplier**,
  so **a 16 GB machine can do 2x / 4x interpolation on a 15-second video**. (The old path decoded the whole clip and collected every interpolated frame in a single array — about 11 GB for 15 s of 1080p30, ~45 GB after 4x — so even 64 GB was not enough; that path is no longer used by default.)
- **VRAM depends only on precision and the scale factor**: fp16 by default; the backend drops to fp32 when VRAM is small or the safe tier is off. A larger multiplier is slower but does not decide whether it runs.
- **The audio track is copied as is**: the output container copies audio packets straight from the source, no re-encode.
- On the first OOM the backend **automatically drops one tier and retries once** (precision to fp32, plus one step down in pre-scaled long side if needed; the multiplier is untouched) and reports the result on the node's status line.
- **Only the fallback path returns to the old behaviour**: when the script / venv / RIFE weights are missing or the stream path fails for a non-OOM reason, the backend falls back to the ComfyUI graph (the console states
  "已回退图路径" plus the reason, with the same logging as before). That path holds whole frame arrays in RAM, so a larger long side costs more memory and may force the long side down / pre-scaling of source frames.
- **Running many clips does not get tighter over time**: each streaming run is its own subprocess and everything is reclaimed when it exits, so there is no accumulated resident memory; only the graph fallback still uses the resident
  ComfyUI backend (its memory guard measures system RAM after each run and restarts in the background only when over budget — see the H3 console's "24G startup optimisation").

## Notes
- **The audio track is carried over as is**: the source audio goes into the result; interpolation only changes the picture frame rate.
- Only **1 audio/video task** is allowed globally at a time (music / speech / video / upscale / interpolation are mutually exclusive); other tasks queue.
- Upscale and interpolation are two **independent** nodes — use either alone, or chain them: **H3 → Video upscale → Video interpolation**.
- If the backend is down the node starts the H3 backend and waits for it to come online; failures are written on the node's status line as an actionable hint.` },
  proc_text: { title: "Text process", body: `LLM processes upstream text from a prompt. Enable assistant mode for agent tools.

## Ports
- **In**: text (multi / @refs)
- **Out**: text

## Settings
**Provider / model / temperature** are changed in the settings window opened by **⚙ Settings** in the node header (◈ previews the exact request that will be sent); the card itself shows a one-line summary. The prompt is content, so it stays in the node.

## While it runs
With the assistant on, **thinking and output are shown apart**: reasoning collapses into **“◉ Thinking · N chars”** blocks (N counts reasoning only), what the model says appears as normal body text, and **🔧 tool** calls sit inline where they happened. The output port still hands downstream the full text.` },
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
  agent_task: { title: "Agent task", body: `Agent run: files, web, shell. Output is filled from the run. Tool allowlist is the Approvals preset.

## Settings
**Preset / provider / model / thinking effort** are changed in the settings window opened by **⚙ Settings** in the node header (the preset list is the same one the agent chat uses); the card itself shows a one-line summary. The task text is content, so it stays in the node.

## Chat mode (💬)
The **💬** button in the node header switches to chat mode: WeChat-style bubbles (assistant left, user right), history saved with the node, follow-ups right on the canvas. The old standalone “Chat” node was removed — opening an older canvas migrates it into an agent task in chat mode.

## While it runs
**Thinking and output are shown apart.** The run renders in chronological segments: **“◉ Thinking · N chars”** collapses the model's private reasoning (N counts reasoning only), text the model says mid-run shows as **normal body text**, **🔧 tool** calls sit inline where they happened, errors append as ⚠. Every tool call or new reasoning step starts a fresh segment; the node header's **「◉ Thinking」** button opens the big view (reasoning on top, output below). The output port still hands downstream the full text.` },
  control: { title: "Run / Clear", body: `Batch control. Wire targets in or out, then ▶ to run or clear them. Fill-only skips nodes that already have output.

## Settings
**The action (run / clear), “fill gaps” and “pinned”** are edited in the settings window opened by **⚙ Settings** in the node header; which nodes it governs is still changed by wiring on the canvas — the window just lists them.` },
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

## Settings
The **watched path and poll interval** are edited in the settings window opened by **⚙ Settings** in the node header; Browse / Reveal stay on the node — they are actions, not settings.

## Ports
- **In**: none
- **Out**: control` },
  timer: { title: "Timer", body: `At the scheduled **local time**, send a “you may start” pulse to whatever is wired on the output.

## Turn it on / off

The node’s **▶** does **not** run targets immediately. It **starts the alarm**:

1. Pick the mode and time in the settings window opened by **⚙ Settings** in the node header (mode / scheduled time / interval / Cron all live there).
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

## Settings
**The delay length** is edited in the settings window opened by **⚙ Settings** in the node header; the node keeps a one-line summary.

## Ports
- **In / Out**: control` },
  sequencer: { title: "Sequencer", body: `One in, many outs. Fires lanes **in order**, optional gap.

## Settings
**Output count and the gap between steps** are edited in the settings window opened by **⚙ Settings** in the node header; the node keeps a one-line summary.

## Ports
- **Out**: 2–8 numbered` },
  gate: { title: "Gate", body: `AND join: every **configured** input port must receive a pulse (unwired ports still block). Then fires once and resets.

## Settings
**Input count** is edited in the settings window opened by **⚙ Settings** in the node header; the node keeps a one-line summary, and “Clear arrivals” stays on the node as an action.

▶ force-releases.` },
  splitter: { title: "Splitter", body: `One in, many outs. Fires all lanes **in parallel**.

## Settings
**Output count** is edited in the settings window opened by **⚙ Settings** in the node header; the node keeps a one-line summary.` },
  counter: { title: "Counter", body: `Release once every N pulses, then reset.

## Settings
**N (hits before passing)** is edited in the settings window opened by **⚙ Settings** in the node header; the node keeps showing a one-line summary, and “Reset count” stays on the node as an action.

▶ counts once.` },
  mutex: { title: "Mutex", body: `OR join: any input pulse releases the single output. ▶ marks a lane by first / priority / random.

## Settings
**Input count and the pick mode** are edited in the settings window opened by **⚙ Settings** in the node header; the node keeps a one-line summary.` },
};

/* 已随发布版同步的节点指南以磁盘 md 为准（正文比这里的内嵌模板新，
   例如「图像生成」的双通道抠图段、「保存」的超级节点路径段）：
   再生成时不要把它们覆盖回旧内容。 diagrams 仍会刷新。
   video_gen / music_gen / tts_gen：磁盘两版都补了「分段衔接 / 后处理独立节点 /
   插件报错弹窗与自动修复」这些新口径，内嵌模板还没跟上 → 一并交给磁盘。 */
const diskOwned = new Set(["proc_image", "save", "video_gen", "music_gen", "tts_gen"]);

/* 已移除的节点 kind：清单里不再出现（旧 md 由本次运行后手工删除） */
const removedKinds = new Set(["chat"]);

const indexFile = path.join(root, "index.json");
let prevIds = [];
try {
  const prev = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  prevIds = Array.isArray(prev && prev.ids) ? prev.ids : [];
} catch (_) {}

/* 清单 = 旧清单（保持磁盘顺序，含只手写未进模板的页面）+ 本文件新增页面；
   丢掉已删除的 kind 与文件已被删掉的条目。 */
const ids = [];
for (const id of [...prevIds, ...Object.keys(guides)]) {
  if (removedKinds.has(id) || ids.indexOf(id) >= 0) continue;
  if (!fs.existsSync(path.join(root, id + ".md"))) continue;
  ids.push(id);
}
fs.writeFileSync(
  indexFile,
  JSON.stringify({ localeDefault: "zh", ids }, null, 2) + "\n",
);

for (const [id, spec] of Object.entries(guides)) {
  if (diagrams[id]) fs.writeFileSync(path.join(imgDir, id + ".svg"), diagrams[id]);
  if (diskOwned.has(id)) continue;
  const md = `# ${spec.title}\n\n![diagram](img/${id}.svg)\n\n${spec.body}\n`;
  fs.writeFileSync(path.join(root, id + ".md"), md);
  const e = en[id];
  if (e) {
    fs.writeFileSync(
      path.join(root, "en", id + ".md"),
      `# ${e.title}\n\n![diagram](img/${id}.svg)\n\n${e.body}\n`,
    );
  }
}

console.log("wrote", ids.length, "guides (index ids)");

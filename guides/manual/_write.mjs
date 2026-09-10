/* one-shot: write the built-in app manual catalog + all diagrams (zh is authored on disk; en pages are kept as-is)
 *
 * 口径（与 guides/manual/manual-notes.md 一致）：
 *   - 目录：本文件的 catalog → index.json（唯一真源）。
 *   - 正文：以磁盘上的 guides/manual/<id>.md 为准（磁盘有就原样保留），
 *           重跑本脚本**不会**把新结构覆盖回旧的内嵌模板。
 *   - 英文：磁盘上已有 en/<id>.md 的保持不动；缺失时应用按 id 回落中文。
 *   - 图示：全部由本文件生成到 guides/manual/img/，命名 mtnode-{章节}-{序号}-{类型}.{ext}，
 *           章节 = start|canvas|flow|agent|share|edit|app，类型 = ui|flow|state|demo|demo-static。
 *           类型 demo 的动效图另配一份同名 -demo-static 静态回退。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(root, "img");
fs.mkdirSync(imgDir, { recursive: true });

/* ─────────────────────────── SVG 渲染 ─────────────────────────── */

const GOLD = "#f0c14d";
const CYAN = "#38d6ff";
const ORNG = "#ff8f2e";
const GRN = "#5fd68a";
const RED = "#ff6b6b";
const PUR = "#c792ea";
const FILL_C = "#1a1610"; /* 金 / 控制 */
const FILL_D = "#101820"; /* 青 / 输入 */
const FILL_P = "#1a140e"; /* 橙 / 处理 */
const FILL_G = "#101610"; /* 绿 / 输出 */
const FILL_R = "#1a1010"; /* 红 / 失败 */
const FILL_U = "#161020"; /* 紫 / 智能 */

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/* 简写：把图内容写成数据，别手写 SVG */
const bx = (x, y, w, h, label, color, fill) => ({ t: "box", x, y, w, h, label, color, fill });
const ar = (x1, y1, x2, y2, color) => ({ t: "arrow", x1, y1, x2, y2, color });
const tx = (x, y, label, color, size, anchor) => ({ t: "text", x, y, label, color, size, anchor });
const bd = (x, y, w, h, label, color) => ({ t: "band", x, y, w, h, label, color });
const dl = (x, y, w, h, label, color) => ({ t: "diamond", x, y, w, h, label, color });
const ln = (x1, y1, x2, y2, color) => ({ t: "line", x1, y1, x2, y2, color });

function render(spec, anim) {
  const W = spec.w || 560;
  const H = spec.h || 200;
  const out = [];
  out.push(`  <rect width="${W}" height="${H}" fill="#0d1016"/>`);
  const mark = (id, c) =>
    `  <marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${c}"/></marker>`;
  out.push(
    [
      "  <defs>",
      mark("arr-gold", GOLD),
      mark("arr-cyan", CYAN),
      mark("arr-orange", ORNG),
      mark("arr-green", GRN),
      mark("arr-red", RED),
      mark("arr-purple", PUR),
      "  </defs>",
    ].join("\n"),
  );
  const markerOf = (c) =>
    c === CYAN ? "arr-cyan" : c === ORNG ? "arr-orange" : c === GRN ? "arr-green" : c === RED ? "arr-red" : c === PUR ? "arr-purple" : "arr-gold";

  for (const it of spec.items || []) {
    if (it.t === "box") {
      const cx = it.x + it.w / 2;
      const cy = it.y + it.h / 2 + 4;
      out.push(`  <rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="6" fill="${it.fill || FILL_C}" stroke="${it.color || GOLD}" stroke-width="1.6"/>`);
      for (const [i, lineStr] of String(it.label).split("\n").entries()) {
        out.push(
          `  <text x="${cx}" y="${cy + (i - (String(it.label).split("\n").length - 1) / 2) * 13}" text-anchor="middle" fill="#e8eef6" font-size="12" font-family="Segoe UI,sans-serif">${esc(lineStr)}</text>`,
        );
      }
    } else if (it.t === "diamond") {
      const cx = it.x + it.w / 2;
      const cy = it.y + it.h / 2;
      out.push(
        `  <polygon points="${cx},${it.y} ${it.x + it.w},${cy} ${cx},${it.y + it.h} ${it.x},${cy}" fill="${FILL_C}" stroke="${it.color || GOLD}" stroke-width="1.6"/>`,
      );
      out.push(`  <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#e8eef6" font-size="11" font-family="Segoe UI,sans-serif">${esc(it.label)}</text>`);
    } else if (it.t === "band") {
      out.push(`  <rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="4" fill="#141a24" stroke="${it.color || ORNG}" stroke-width="1.3"/>`);
      out.push(`  <text x="${it.x + 10}" y="${it.y + it.h / 2 + 4}" fill="${it.color || ORNG}" font-size="11" font-family="Segoe UI,sans-serif">${esc(it.label)}</text>`);
    } else if (it.t === "arrow" || it.t === "line") {
      const c = it.color || GOLD;
      const end = it.t === "arrow" ? ` marker-end="url(#${markerOf(c)})"` : "";
      out.push(`  <line x1="${it.x1}" y1="${it.y1}" x2="${it.x2}" y2="${it.y2}" stroke="${c}" stroke-width="1.8"${end}/>`);
    } else if (it.t === "text") {
      out.push(
        `  <text x="${it.x}" y="${it.y}"${it.anchor ? ` text-anchor="${it.anchor}"` : ""} fill="${it.color || "#5a6472"}" font-size="${it.size || 11}" font-family="Segoe UI,sans-serif">${esc(it.label)}</text>`,
      );
    }
  }
  if (anim) {
    if (spec.motion) {
      out.push(
        `  <circle r="4.5" fill="${spec.motionColor || CYAN}"><animateMotion dur="${spec.motionDur || "6s"}" repeatCount="indefinite" path="${spec.motion}"/></circle>`,
      );
    }
    for (const b of spec.blink || []) {
      out.push(
        `  <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="none" stroke="${b.color || GRN}" stroke-width="2.4" opacity="0.3"><animate attributeName="opacity" values="0.15;1;0.15" dur="${b.dur || "2.4s"}" repeatCount="indefinite"/></rect>`,
      );
    }
  }
  if (spec.caption) {
    out.push(
      `  <text x="${W / 2}" y="${H - 12}" text-anchor="middle" fill="#5a6472" font-size="11" font-family="Segoe UI,sans-serif">${esc(spec.caption)}</text>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
${out.join("\n")}
</svg>
`;
}

/* ─────────────────────────── 图示清单 ─────────────────────────── */

const diagrams = {};

/* 第 1 章 上手 */
diagrams["mtnode-start-01-ui"] = {
  w: 560,
  h: 200,
  caption: "界面分区：顶栏 · 左侧 ☰ 边栏 · 中央画布 · 右侧 ✦ 助手 · 左下角总览图与运行队列",
  items: [
    bd(20, 18, 520, 28, "顶栏 · 画布 / 智能会话 / 专家团 · 撤销 组 排版 · 设置 插件 素材库 工坊 · 文档 审批 账户 更新 语言", ORNG),
    bx(20, 54, 92, 108, "☰ 边栏\n节点树\n超级节点树", CYAN, FILL_D),
    bx(120, 54, 320, 108, "画布\n右键加节点 · 端子连线 · @ 引用", GOLD, FILL_C),
    bx(448, 54, 92, 108, "✦ 助手\n看状态\n改图先确认", ORNG, FILL_P),
    bx(20, 170, 160, 24, "左下角：总览图 / 运行队列", "#5a6472", "#12161e"),
  ],
};
diagrams["mtnode-start-02-ui"] = {
  w: 560,
  h: 170,
  caption: "从目录添加 → 填 API Key → 模型列表与接口地址自动载入 → 节点读取（Key 只存本机）",
  items: [
    bx(24, 56, 150, 52, "设置 · 模型服务", GOLD, FILL_C),
    ar(174, 82, 216, 82, GOLD),
    bx(216, 56, 140, 52, "填 API Key", CYAN, FILL_D),
    ar(356, 82, 398, 82, CYAN),
    bx(398, 56, 138, 52, "模型列表载入", GRN, FILL_G),
  ],
};
diagrams["mtnode-start-02-demo"] = {
  w: 560,
  h: 170,
  anim: true,
  motionDur: "5s",
  motion: "M 244,82 L 356,82",
  caption: "动效（约 5 秒循环）：粘贴 Key → 校验 → 模型列表出现在节点下拉里",
  items: [
    bx(24, 56, 150, 52, "设置 · 模型服务", GOLD, FILL_C),
    ar(174, 82, 244, 82, GOLD),
    bx(244, 56, 112, 52, "校验 Key", CYAN, FILL_D),
    ar(356, 82, 424, 82, CYAN),
    bx(424, 56, 112, 52, "模型列表", GRN, FILL_G),
  ],
  blink: [{ x: 424, y: 56, w: 112, h: 52, color: GRN, dur: "2.5s" }],
};
diagrams["mtnode-start-03-flow"] = {
  w: 580,
  h: 160,
  caption: "第一次使用：加节点 → 连线 → 写 @ 引用 → ▶ 运行（上游未跑过会自动递归执行）",
  items: [
    bx(20, 48, 120, 48, "1 加节点", CYAN, FILL_D),
    ar(140, 72, 172, 72, CYAN),
    bx(172, 48, 110, 48, "2 连线", GOLD, FILL_C),
    ar(282, 72, 314, 72, GOLD),
    bx(314, 48, 110, 48, "3 写 @ 引用", ORNG, FILL_P),
    ar(424, 72, 456, 72, ORNG),
    bx(456, 48, 100, 48, "4 ▶ 运行", GRN, FILL_G),
  ],
};
diagrams["mtnode-start-04-state"] = {
  w: 580,
  h: 180,
  caption: "画布自动保存 → 数据目录 save/ → 每 5 分钟快照到 save-backups/ → 启动恢复现场",
  items: [
    bx(20, 52, 120, 48, "编辑画布", CYAN, FILL_D),
    ar(140, 76, 172, 76, CYAN),
    bx(172, 52, 130, 48, "自动保存", ORNG, FILL_P),
    ar(302, 76, 334, 76, ORNG),
    bx(334, 52, 120, 48, "save\\ 存档", GOLD, FILL_C),
    ar(454, 76, 486, 76, GOLD),
    bx(486, 52, 80, 48, "恢复现场", GRN, FILL_G),
    tx(20, 130, "每 5 分钟另存快照到 save-backups/（每条画布保留最近 72 份，设置 →「画布备份」打开）", "#5a6472", 11),
  ],
};

/* 第 2 章 画布 */
diagrams["mtnode-canvas-01-ui"] = {
  w: 600,
  h: 250,
  caption: "右键菜单的大类：输入 / 处理 / 保存 / 智能 / 任务 / 控制 / 工具 / 开发 / 数据库 / 拆分合并 / 绘制",
  items: [
    bd(16, 18, 568, 24, "画布空白处右键 → 节点大类", ORNG),
    bx(16, 52, 108, 40, "输入\n文本 图像 音频 视频", CYAN, FILL_D),
    bx(132, 52, 108, 40, "处理\n文本 图像 动画", ORNG, FILL_P),
    bx(248, 52, 96, 40, "保存\nYAML 图像 .md", GRN, FILL_G),
    bx(352, 52, 108, 40, "智能\n智能任务 会话", PUR, FILL_U),
    bx(468, 52, 116, 40, "任务\n起点 判断 终点", GOLD, FILL_C),
    bx(16, 100, 108, 40, "控制\n定时 闸门 互斥", GOLD, FILL_C),
    bx(132, 100, 108, 40, "工具 / 函数\n参数即端子", CYAN, FILL_D),
    bx(248, 100, 96, 40, "开发\n模块 文件 类", PUR, FILL_U),
    bx(352, 100, 108, 40, "数据库\n⛁ 编译副本", GOLD, FILL_C),
    bx(468, 100, 116, 40, "拆分 / 合并\n批次的进出", CYAN, FILL_D),
    bx(16, 148, 130, 40, "拆分 / 合并\n逐条抽出 · 汇成一批", CYAN, FILL_D),
    bx(154, 148, 150, 40, "媒体生成 / 网络 / 执行\n音视频 · net · .exe", ORNG, FILL_P),
    bx(312, 148, 130, 40, "绘制（标注）\n框体 箭头 文字", "#5a6472", "#12161e"),
    bx(450, 148, 134, 40, "超节点 / 开发 / 数据库\n都是 super 的形态", GOLD, FILL_C),
  ],
};
diagrams["mtnode-canvas-02-flow"] = {
  w: 600,
  h: 190,
  caption: "三种线：数据线传值 · 金色控制线只传脉冲 · 关系线只表达依赖",
  items: [
    bx(20, 40, 120, 48, "输出端子", CYAN, FILL_D),
    ar(140, 64, 190, 64, CYAN),
    bx(190, 40, 120, 48, "输入端子", ORNG, FILL_P),
    tx(20, 110, "数据线（青 / 橙 / 绿）：上游结果沿连线成为下游输入", "#5a6472", 11),
    ln(20, 130, 580, 130, "#2a3140"),
    bx(20, 146, 130, 32, "控制线（金色）", GOLD, FILL_C),
    ar(150, 162, 220, 162, GOLD),
    bx(220, 146, 130, 32, "只传脉冲", GOLD, FILL_C),
    bx(360, 146, 140, 32, "关系线（UML 直线）", "#8a94a6", "#12161e"),
    tx(508, 166, "不执行", "#5a6472", 11),
  ],
};
diagrams["mtnode-canvas-02-demo"] = {
  w: 600,
  h: 200,
  anim: true,
  motionDur: "6s",
  motion: "M 150,74 L 290,74",
  caption: "动效（约 6 秒循环）：拖节点 → 输出端子拉线 → 落入输入端子变绿 → 落空白处生出新节点",
  items: [
    bx(30, 50, 120, 48, "文本输入", CYAN, FILL_D),
    ar(150, 74, 290, 74, GOLD),
    bx(290, 50, 120, 48, "文本处理", ORNG, FILL_P),
    ar(410, 74, 470, 74, GRN),
    bx(470, 50, 100, 48, "保存", GRN, FILL_G),
    bx(30, 130, 120, 40, "落空处新生", "#8a94a6", "#12161e"),
    ar(150, 150, 290, 150, RED),
    bx(290, 130, 120, 40, "类型匹配后连上", GRN, FILL_G),
  ],
  blink: [
    { x: 290, y: 50, w: 120, h: 48, color: GRN, dur: "3s" },
    { x: 290, y: 130, w: 120, h: 40, color: GRN, dur: "3s" },
  ],
};
diagrams["mtnode-canvas-03-flow"] = {
  w: 560,
  h: 170,
  caption: "框选（Ctrl+左键）→ 组（G，整体拖动 / 分轴缩放）→ 自动排版（可同时排超节点内部）",
  items: [
    bx(20, 50, 110, 48, "框选一片", CYAN, FILL_D),
    ar(130, 74, 176, 74, CYAN),
    bx(176, 50, 110, 48, "按 G 成组", GOLD, FILL_C),
    ar(286, 74, 332, 74, GOLD),
    bx(332, 50, 110, 48, "自动排版", ORNG, FILL_P),
    ar(442, 74, 488, 74, ORNG),
    bx(488, 50, 60, 48, "干净", GRN, FILL_G),
  ],
};
diagrams["mtnode-canvas-04-state"] = {
  w: 580,
  h: 200,
  caption: "边端子隧穿：外侧输入/输出 ↔ 壳层内侧桥接/汇流；控制线同号也跟着变色过壳",
  items: [
    bx(16, 56, 110, 60, "外侧输入", CYAN, FILL_D),
    ar(126, 86, 176, 86, CYAN),
    bx(176, 40, 228, 108, "超级节点壳层\n（展开壳层 / ↪ 进入内部）", GOLD, FILL_C),
    ar(404, 86, 454, 86, CYAN),
    bx(454, 56, 110, 60, "外侧输出", GRN, FILL_G),
    tx(176, 168, "内侧输入（桥接）→ 内部节点 → 内侧输出（汇流）", "#5a6472", 11),
  ],
};
diagrams["mtnode-canvas-05-ui"] = {
  w: 580,
  h: 190,
  caption: "Ctrl+F 查找当前画布 · ☰ 边栏（节点/绘图 + 超级节点树）· 左下角总览图快速平移",
  items: [
    bd(16, 18, 548, 26, "Ctrl+F 悬浮查找框（标题 + 内容，仅当前画布）", CYAN),
    bx(16, 54, 130, 96, "☰ 边栏\n节点 / 绘图\n超级节点树\n筛选框", CYAN, FILL_D),
    bx(154, 54, 280, 96, "画布", GOLD, FILL_C),
    bx(442, 54, 122, 96, "定位\n点一条即居中", ORNG, FILL_P),
    bx(16, 158, 150, 24, "左下角：总览图", "#5a6472", "#12161e"),
    bx(180, 158, 150, 24, "Ctrl+G 替换", "#5a6472", "#12161e"),
  ],
};
diagrams["mtnode-canvas-06-ui"] = {
  w: 580,
  h: 190,
  caption: "节点指南按类型索引：右键节点 → 节点指南；本手册讲全局，指南讲这一种节点",
  items: [
    bx(20, 40, 150, 48, "右键节点", CYAN, FILL_D),
    ar(170, 64, 220, 64, CYAN),
    bx(220, 40, 150, 48, "节点指南", ORNG, FILL_P),
    ar(370, 64, 420, 64, ORNG),
    bx(420, 40, 140, 48, "端口 / 按钮 / 失败", GRN, FILL_G),
    tx(20, 120, "本手册 → 整个应用怎么用；节点指南 → 这一种节点怎么接", "#5a6472", 11),
    tx(20, 146, "控制类节点：先看节点指南，再回《控制流与判断》串起来", "#5a6472", 11),
  ],
};

/* 第 3 章 做一条工作流 */
diagrams["mtnode-flow-01-flow"] = {
  w: 560,
  h: 160,
  caption: "输入 → 处理 → 保存；保存可写 YAML / 图像 / 默认 .md，相对路径需工作目录",
  items: [
    bx(20, 52, 110, 48, "输入", CYAN, FILL_D),
    ar(130, 76, 176, 76, CYAN),
    bx(176, 52, 130, 48, "处理 / 智能", ORNG, FILL_P),
    ar(306, 76, 352, 76, ORNG),
    bx(352, 52, 110, 48, "保存", GRN, FILL_G),
    bx(482, 52, 66, 48, ".yaml\n.png\n.md", "#5a6472", "#12161e"),
  ],
};
diagrams["mtnode-flow-02-flow"] = {
  w: 580,
  h: 170,
  caption: "节点头部：⚙ 设置（服务商 / 模型 / 温度 / 思考强度 / 尺寸）· ▶ 运行 · ◈ 预览完整请求 · API",
  items: [
    bd(20, 20, 540, 26, "节点头部", ORNG),
    bx(20, 56, 130, 44, "⚙ 设置", GOLD, FILL_C),
    bx(160, 56, 110, 44, "▶ 运行", GRN, FILL_G),
    bx(280, 56, 150, 44, "◈ 预览完整请求", CYAN, FILL_D),
    bx(440, 56, 120, 44, "多次尝试 1–10", ORNG, FILL_P),
    tx(20, 128, "结果面板用方块 Tab 切换抽卡结果；下游引用当前选中的那一次", "#5a6472", 11),
  ],
};
diagrams["mtnode-flow-02-demo"] = {
  w: 580,
  h: 170,
  anim: true,
  motionDur: "5s",
  motion: "M 150,84 L 470,84",
  caption: "动效（约 5 秒循环）：打开 ⚙ 设置 → 改模型 / 温度 → ▶ → 输出面板出现结果",
  items: [
    bx(20, 58, 130, 52, "⚙ 设置打开", GOLD, FILL_C),
    ar(150, 84, 240, 84, GOLD),
    bx(240, 58, 110, 52, "改参数", CYAN, FILL_D),
    ar(350, 84, 410, 84, CYAN),
    bx(410, 58, 150, 52, "▶ 输出结果", GRN, FILL_G),
  ],
  blink: [{ x: 410, y: 58, w: 150, h: 52, color: GRN, dur: "2.5s" }],
};
diagrams["mtnode-flow-03-state"] = {
  w: 600,
  h: 210,
  caption: "透明底双通道：① 纯黑基准图 → ② 以它为参考图复刻纯白 → 逐像素差分出 Alpha（服务商不支持时只交第 1 通道）",
  items: [
    bx(20, 46, 140, 52, "① 出纯黑基准", CYAN, FILL_D),
    ar(160, 72, 210, 72, CYAN),
    bx(210, 46, 160, 52, "② 参考基准出纯白", ORNG, FILL_P),
    ar(370, 72, 420, 72, ORNG),
    bx(420, 46, 160, 52, "逐像素差分 Alpha", GRN, FILL_G),
    dl(250, 128, 140, 60, "服务商能当参考图下发？", GOLD),
    ar(320, 128, 320, 104, GOLD),
    tx(410, 150, "不能 → 只交第 1 通道（不抠图）", RED, 11),
  ],
};
diagrams["mtnode-flow-04-flow"] = {
  w: 600,
  h: 210,
  caption: "batch：每条一次运行、每次只看该条；agg：所有条目一次送入、只出一条",
  items: [
    bx(20, 30, 110, 34, "条目 A", CYAN, FILL_D),
    bx(20, 74, 110, 34, "条目 B", CYAN, FILL_D),
    ar(130, 47, 180, 90, CYAN),
    ar(130, 91, 180, 90, CYAN),
    bx(180, 68, 130, 44, "处理 · batch", ORNG, FILL_P),
    ar(310, 90, 360, 90, ORNG),
    bx(360, 30, 100, 34, "结果 A", GRN, FILL_G),
    bx(360, 74, 100, 34, "结果 B", GRN, FILL_G),
    ln(20, 124, 580, 124, "#2a3140"),
    bx(20, 140, 110, 40, "A + B", CYAN, FILL_D),
    ar(130, 160, 180, 160, CYAN),
    bx(180, 140, 130, 40, "处理 · agg", ORNG, FILL_P),
    ar(310, 160, 360, 160, ORNG),
    bx(360, 140, 100, 40, "一条结果", GRN, FILL_G),
  ],
};
diagrams["mtnode-flow-04-demo"] = {
  w: 600,
  h: 210,
  anim: true,
  motionDur: "6s",
  motion: "M 130,47 L 180,90 L 310,90 L 360,47",
  caption: "动效（约 6 秒循环）：batch 逐条触发三次；右半屏 agg 三条合成一次（严禁把整批又塞进每次运行）",
  items: [
    bx(20, 30, 110, 34, "条目 1", CYAN, FILL_D),
    bx(20, 74, 110, 34, "条目 2", CYAN, FILL_D),
    bx(20, 118, 110, 34, "条目 3", CYAN, FILL_D),
    ar(130, 47, 190, 86, CYAN),
    ar(130, 91, 190, 86, CYAN),
    ar(130, 135, 190, 86, CYAN),
    bx(190, 64, 130, 44, "batch：逐条", ORNG, FILL_P),
    ar(320, 86, 370, 86, ORNG),
    bx(370, 26, 100, 30, "结果 1", GRN, FILL_G),
    bx(370, 66, 100, 30, "结果 2", GRN, FILL_G),
    bx(370, 106, 100, 30, "结果 3", GRN, FILL_G),
    bx(490, 66, 96, 40, "agg：合一次", GOLD, FILL_C),
  ],
  blink: [{ x: 190, y: 64, w: 130, h: 44, color: ORNG, dur: "3s" }],
};
diagrams["mtnode-flow-05-flow"] = {
  w: 560,
  h: 170,
  caption: "拆分：从批次里抽单项 → 只读节点；合并：多路输入汇成一个批次",
  items: [
    bx(20, 36, 110, 40, "批次", CYAN, FILL_D),
    ar(130, 56, 180, 56, CYAN),
    bx(180, 36, 120, 40, "拆分", ORNG, FILL_P),
    ar(300, 56, 350, 56, ORNG),
    bx(350, 36, 110, 40, "单项（只读）", GRN, FILL_G),
    bx(20, 112, 90, 34, "输入 1", CYAN, FILL_D),
    bx(20, 154, 90, 34, "输入 2", CYAN, FILL_D),
    ar(110, 129, 180, 150, CYAN),
    ar(110, 171, 180, 150, CYAN),
    bx(180, 132, 120, 40, "合并", ORNG, FILL_P),
    ar(300, 152, 350, 152, ORNG),
    bx(350, 132, 110, 40, "一个批次", GRN, FILL_G),
  ],
};
diagrams["mtnode-flow-06-flow"] = {
  w: 600,
  h: 190,
  caption: "本地后端节点：音频生成（Music 3 / SoVITS）、视频生成（H3 / Remotion）；自带 outputPath 直接写文件",
  items: [
    bx(20, 40, 140, 44, "音频生成", ORNG, FILL_P),
    ar(160, 62, 210, 62, ORNG),
    bx(210, 40, 120, 44, "Music 3 / SoVITS", CYAN, FILL_D),
    ar(330, 62, 380, 62, CYAN),
    bx(380, 40, 140, 44, ".wav / .mp3", GRN, FILL_G),
    bx(20, 110, 140, 44, "视频生成", ORNG, FILL_P),
    ar(160, 132, 210, 132, ORNG),
    bx(210, 110, 120, 44, "H3 / Remotion", CYAN, FILL_D),
    ar(330, 132, 380, 132, CYAN),
    bx(380, 110, 140, 44, ".mp4（Remotion 需 save）", GRN, FILL_G),
    tx(20, 176, "全局同时只允许 1 个音视频任务（媒体生成互斥锁）", RED, 11),
  ],
};
diagrams["mtnode-flow-06-demo"] = {
  w: 600,
  h: 190,
  anim: true,
  motionDur: "7s",
  motion: "M 160,62 L 330,62 L 380,62",
  caption: "动效（约 7 秒循环）：▶ → 进度环 → 写出 .wav / .mp4 → 冲突时提示全局锁",
  items: [
    bx(20, 40, 140, 44, "▶ 开始生成", ORNG, FILL_P),
    ar(160, 62, 240, 62, ORNG),
    bx(240, 40, 120, 44, "进度环", CYAN, FILL_D),
    ar(360, 62, 420, 62, CYAN),
    bx(420, 40, 150, 44, "写出文件", GRN, FILL_G),
    bx(240, 112, 330, 44, "已有任务在跑 → 提示「全局仅 1 个媒体任务」", RED, FILL_R),
  ],
  blink: [{ x: 420, y: 40, w: 150, h: 44, color: GRN, dur: "3s" }],
};
diagrams["mtnode-flow-07-flow"] = {
  w: 580,
  h: 190,
  caption: "global 只连入：源 → global → 多个消费节点；消费端还要开 globalRefs 并写 @源标题",
  items: [
    bx(20, 60, 120, 48, "来源节点", CYAN, FILL_D),
    ar(140, 84, 190, 84, CYAN),
    bx(190, 60, 110, 48, "global", GOLD, FILL_C),
    ar(300, 84, 360, 46, GOLD),
    ar(300, 84, 360, 90, GOLD),
    ar(300, 84, 360, 134, GOLD),
    bx(360, 26, 190, 40, "消费 A（globalRefs + @来源）", GRN, FILL_G),
    bx(360, 70, 190, 40, "消费 B（globalRefs + @来源）", GRN, FILL_G),
    bx(360, 114, 190, 40, "消费 C（globalRefs + @来源）", GRN, FILL_G),
  ],
};
diagrams["mtnode-flow-08-flow"] = {
  w: 620,
  h: 230,
  caption: "任务自带起点 / 成功终点 / 失败终点；判断只有 YES 与 NO 两个输出；控制节点统一金色外圈",
  items: [
    bx(16, 30, 90, 40, "起点", GOLD, FILL_C),
    ar(106, 50, 150, 50, GOLD),
    bx(150, 30, 110, 40, "工作步骤", ORNG, FILL_P),
    ar(260, 50, 304, 50, GOLD),
    dl(304, 18, 120, 64, "判断", GOLD),
    ar(424, 38, 470, 24, GRN),
    bx(470, 8, 130, 34, "成功终点", GRN, FILL_G),
    ar(424, 62, 470, 84, RED),
    bx(470, 66, 130, 34, "失败终点", RED, FILL_R),
    ln(16, 112, 604, 112, "#2a3140"),
    bx(16, 126, 96, 36, "定时 / 延时", GOLD, FILL_C),
    bx(120, 126, 86, 36, "等待文件", GOLD, FILL_C),
    bx(214, 126, 86, 36, "序列器", GOLD, FILL_C),
    bx(308, 126, 86, 36, "闸门 AND", GOLD, FILL_C),
    bx(402, 126, 86, 36, "分发", GOLD, FILL_C),
    bx(496, 126, 56, 36, "计数", GOLD, FILL_C),
    bx(560, 126, 44, 36, "互斥", GOLD, FILL_C),
    tx(16, 186, "▶ 从起点沿控制线推进；到达成功终点即成功，走到失败终点或跑不动则失败", "#5a6472", 11),
  ],
};
diagrams["mtnode-flow-09-flow"] = {
  w: 580,
  h: 180,
  caption: "net_send / net_recv：TCP 或 UDP 文本通道，通道号 0–65535，端口 0 = 全局设置",
  items: [
    bx(20, 50, 140, 48, "net_send\n本机 A", CYAN, FILL_D),
    ar(160, 74, 300, 74, GOLD),
    bx(300, 50, 140, 48, "net_recv\n本机 B", ORNG, FILL_P),
    tx(160, 130, "通道号对齐即可互通；接收端可选择「启动即监听」", "#5a6472", 11),
    tx(160, 154, "TCP = 可靠、UDP = 低延迟，跨机器请放行防火墙端口", "#5a6472", 11),
  ],
};
diagrams["mtnode-flow-10-flow"] = {
  w: 560,
  h: 170,
  caption: "执行节点：绑定 .exe / .bat / .cmd / .lnk，无数据端子，画布上一键启动本机程序",
  items: [
    bx(20, 50, 150, 48, "执行节点\n.execPath", ORNG, FILL_P),
    ar(170, 74, 240, 74, ORNG),
    bx(240, 50, 150, 48, "本机程序启动", GRN, FILL_G),
    tx(20, 128, "图标与主题色可在节点上设置；不参与数据流，只做「启动」这件事", "#5a6472", 11),
  ],
};
diagrams["mtnode-flow-11-flow"] = {
  w: 600,
  h: 190,
  caption: "工具节点：参数即端子（输入 0 = 控制入、1..N = 入参；输出 0..M-1、末位 = 控制出）；函数节点跑主进程独立线程",
  items: [
    bx(20, 40, 150, 52, "工具节点\n参数 = 端子", GOLD, FILL_C),
    ar(170, 66, 220, 66, GOLD),
    bx(220, 40, 140, 52, "可被 Agent 调用", PUR, FILL_U),
    bx(20, 112, 150, 52, "函数节点\njscode", CYAN, FILL_D),
    ar(170, 138, 220, 138, CYAN),
    bx(220, 112, 140, 52, "独立线程 · 可停", ORNG, FILL_P),
    tx(390, 70, "list:true 端子可连多条线", "#5a6472", 11),
    tx(390, 142, "kind: text / image 决定相接与着色", "#5a6472", 11),
  ],
};
diagrams["mtnode-flow-12-flow"] = {
  w: 600,
  h: 190,
  anim: true,
  motionDur: "6s",
  motion: "M 150,86 L 330,86",
  caption: "动效（约 6 秒循环）：说需求 → 它在自己那张画布上逐个建节点、连线、写 @ 引用并自动排版",
  items: [
    bx(20, 62, 130, 48, "说需求", PUR, FILL_U),
    ar(150, 86, 220, 86, PUR),
    bx(220, 62, 110, 48, "建节点", CYAN, FILL_D),
    ar(330, 86, 390, 86, CYAN),
    bx(390, 62, 110, 48, "连线 + @", GOLD, FILL_C),
    ar(500, 86, 545, 86, GOLD),
    bx(545, 62, 45, 48, "▶", GRN, FILL_G),
  ],
  blink: [{ x: 220, y: 62, w: 110, h: 48, color: CYAN, dur: "3s" }],
};

/* 第 5 章 AI 干活 */
diagrams["mtnode-agent-01-ui"] = {
  w: 600,
  h: 200,
  caption: "智能体在工作区里干活：读/写文件 · 联网 · 命令 · 子代理 · 技能 / MCP · 识图；不改画布",
  items: [
    bx(20, 66, 120, 48, "智能节点 / 会话", PUR, FILL_U),
    ar(140, 90, 190, 90, PUR),
    bx(190, 26, 110, 32, "读 / 写文件", CYAN, FILL_D),
    bx(190, 66, 110, 32, "联网搜索", CYAN, FILL_D),
    bx(190, 106, 110, 32, "执行命令", CYAN, FILL_D),
    bx(310, 26, 110, 32, "子代理", ORNG, FILL_P),
    bx(310, 66, 110, 32, "技能 / MCP", ORNG, FILL_P),
    bx(310, 106, 110, 32, "识图 vision", ORNG, FILL_P),
    ar(420, 90, 470, 90, GOLD),
    bx(470, 66, 110, 48, "工作区结果", GRN, FILL_G),
    tx(20, 168, "硬边界：不读画布、不建节点与连线、不改工作流（要搭图用智能会话或右侧 ✦ 助手）", RED, 11),
  ],
};
diagrams["mtnode-agent-02-ui"] = {
  w: 580,
  h: 180,
  caption: "智能任务节点：prompt 就是任务；头部 💬 切成会话模式；可扩展为智能会话",
  items: [
    bx(20, 50, 150, 52, "智能任务节点\n任务描述 = prompt", PUR, FILL_U),
    ar(170, 76, 220, 76, PUR),
    bx(220, 50, 130, 52, "💬 会话模式\n多轮气泡", CYAN, FILL_D),
    ar(350, 76, 400, 76, CYAN),
    bx(400, 50, 160, 52, "扩展为智能会话", GRN, FILL_G),
    tx(20, 132, "支持 @ 引用、/ 技能、多输入、批量 / 聚合、模型选择；不做「多次尝试」", "#5a6472", 11),
  ],
};
diagrams["mtnode-agent-03-state"] = {
  w: 600,
  h: 210,
  caption: "会话在建立的那一刻认下一张画布；之后你切去别的画布，它仍只读写自己那张",
  items: [
    bx(20, 40, 150, 48, "建会话：正看着的 A", CYAN, FILL_D),
    ar(170, 64, 220, 64, CYAN),
    bx(220, 40, 160, 48, "会话 A 所属 = 画布 A", GOLD, FILL_C),
    bx(20, 120, 150, 48, "之后切去画布 B", ORNG, FILL_P),
    ar(170, 144, 220, 144, ORNG),
    bx(220, 120, 160, 48, "会话仍写画布 A", GOLD, FILL_C),
    bx(410, 80, 170, 48, "跨画布 → 右侧 ✦ 助手\n（工作范围切全局）", PUR, FILL_U),
    tx(20, 188, "侧栏每条会话标题下的 ▣ 就是它所属的画布；该画布已删除会标出来", "#5a6472", 11),
  ],
};
diagrams["mtnode-agent-04-ui"] = {
  w: 580,
  h: 180,
  caption: "右侧 ✦ 全局助手：看状态 / 切画布 / 居中 / 建图（改图先确认）；另有「工作范围」与「与画布无关」开关",
  items: [
    bx(400, 20, 160, 140, "✦ 全局助手\n\n看状态\n切画布\n居中\n建图（先确认）", ORNG, FILL_P),
    bx(20, 40, 340, 100, "画布（你正看着的那张）", GOLD, FILL_C),
    tx(20, 164, "助手改画布会先弹确认；文档答疑助手从不改画布", "#5a6472", 11),
  ],
};
diagrams["mtnode-agent-05-ui"] = {
  w: 600,
  h: 200,
  caption: "审批面板：4 档权限预设 + 工具许可（画布 / 应用操作 / 文件 / 终端 / 联网 / 子代理 / 识图）",
  items: [
    bd(16, 18, 568, 24, "右上角「审批」", ORNG),
    bx(16, 52, 270, 44, "权限预设：无人值守（默认）", GOLD, FILL_C),
    bx(16, 104, 270, 44, "工作区读写 · 逐项审批", GOLD, FILL_C),
    bx(314, 52, 270, 44, "只读 · 逐项审批", GOLD, FILL_C),
    bx(314, 104, 270, 44, "完全放行（不限目录）", RED, FILL_R),
    tx(16, 176, "工具许可逐项开关；画布修改 / 应用级危险操作 / 识图是硬拦截，预设再松也会确认", "#5a6472", 11),
  ],
};
diagrams["mtnode-agent-05-demo"] = {
  w: 600,
  h: 190,
  anim: true,
  motionDur: "4s",
  motion: "M 150,80 L 300,80",
  caption: "动效（约 4 秒循环）：越权工具被拦 → 弹出审批卡片 → 允许一次 → 这一轮继续跑",
  items: [
    bx(20, 56, 130, 48, "越权工具调用", RED, FILL_R),
    ar(150, 80, 220, 80, RED),
    bx(220, 56, 150, 48, "审批卡片出现", GOLD, FILL_C),
    ar(370, 80, 430, 80, GOLD),
    bx(430, 56, 150, 48, "允许一次继续", GRN, FILL_G),
  ],
  blink: [{ x: 220, y: 56, w: 150, h: 48, color: GOLD, dur: "2s" }],
};
diagrams["mtnode-agent-06-ui"] = {
  w: 600,
  h: 210,
  caption: "预设五档：极简（默认）/ 标准 / 思维精简 / PTC / 创造；四处可切，思考强度只由设置决定",
  items: [
    bx(16, 24, 110, 40, "极简（默认）", GRN, FILL_G),
    bx(134, 24, 110, 40, "标准", CYAN, FILL_D),
    bx(252, 24, 110, 40, "思维精简", ORNG, FILL_P),
    bx(370, 24, 110, 40, "PTC", PUR, FILL_U),
    bx(488, 24, 96, 40, "创造", GOLD, FILL_C),
    tx(16, 96, "四处入口：智能会话模型菜单 · 右侧助手栏 · 智能节点 ⚙ 设置 · 设置 · 智能能力", "#5a6472", 11),
    bx(16, 118, 270, 44, "思考强度：标准 / 最强", GOLD, FILL_C),
    bx(300, 118, 284, 44, "界面写的就是实际下发的", GRN, FILL_G),
  ],
};
diagrams["mtnode-agent-07-ui"] = {
  w: 600,
  h: 190,
  caption: "「扩展能力管理」一个对话框：DSH / Skill / MCP 三个标签，左侧卡片清单、右侧详情与操作",
  items: [
    bd(16, 18, 568, 24, "设置 · 智能能力 → 扩展能力 → 管理…", ORNG),
    bx(16, 52, 120, 110, "DSH\n插件", PUR, FILL_U),
    bx(144, 52, 120, 110, "Skill\n技能", CYAN, FILL_D),
    bx(272, 52, 120, 110, "MCP\n服务器", ORNG, FILL_P),
    bx(404, 52, 180, 110, "详情：挂载 / 停用 / 移除\n🌐 在线浏览", GRN, FILL_G),
  ],
};
diagrams["mtnode-agent-08-ui"] = {
  w: 580,
  h: 180,
  caption: "专家团视图：按画布管理专家并与专家对话；角色分工可参考一人公司工作流",
  items: [
    bx(20, 40, 140, 48, "专家团视图", ORNG, FILL_P),
    ar(160, 64, 210, 64, ORNG),
    bx(210, 40, 140, 48, "按画布挂专家", GOLD, FILL_C),
    ar(350, 64, 400, 64, GOLD),
    bx(400, 40, 160, 48, "与专家对话", PUR, FILL_U),
    tx(20, 120, "一人公司工作流：角色分工 + 事实库 + 多画布并行；角色系统仍在完善中", "#5a6472", 11),
  ],
};
diagrams["mtnode-agent-09-ui"] = {
  w: 580,
  h: 180,
  caption: "事实库：本机目录 + 全文检索；智能节点接地后一切事实走 mtnode_db，答不上就说「数据库中没有该信息」",
  items: [
    bx(20, 40, 140, 48, "事实库目录", CYAN, FILL_D),
    ar(160, 64, 210, 64, CYAN),
    bx(210, 40, 140, 48, "FTS5 全文检索", ORNG, FILL_P),
    ar(350, 64, 400, 64, ORNG),
    bx(400, 40, 160, 48, "有据可查的回答", GRN, FILL_G),
    tx(20, 120, "断言必须带 [记录id · 标题] 引用；数字计算走 calc，禁止凭记忆补全", "#5a6472", 11),
  ],
};
diagrams["mtnode-agent-10-ui"] = {
  w: 600,
  h: 200,
  caption: "开发节点：模块 → 文件 → 类 / 接口 / 枚举；devPath 绑项目根，头部「建议 / 开发 / 细化」，关系线表达依赖",
  items: [
    bx(20, 30, 130, 40, "模块", ORNG, FILL_P),
    ar(150, 50, 190, 50, ORNG),
    bx(190, 30, 120, 40, "文件", CYAN, FILL_D),
    ar(310, 50, 350, 50, CYAN),
    bx(350, 30, 100, 40, "类 / 接口", PUR, FILL_U),
    bx(458, 30, 100, 40, "枚举", PUR, FILL_U),
    bx(20, 96, 170, 44, "devPath = 项目根", GOLD, FILL_C),
    bx(200, 96, 170, 44, "建议 / 开发 / 细化", GRN, FILL_G),
    bx(380, 96, 178, 44, "AGENTS.md 共识文件", CYAN, FILL_D),
    tx(20, 172, "devModel / devPreset / devEffort 各自就近向上继承；思考强度只由设置决定", "#5a6472", 11),
  ],
};
diagrams["mtnode-agent-10-demo"] = {
  w: 600,
  h: 200,
  anim: true,
  motionDur: "8s",
  motion: "M 150,50 L 350,50 L 458,50",
  caption: "动效（约 8 秒循环）：点「细化」→ 模块逐层下钻成文件级、再拆到类 / 接口 / 枚举子块",
  items: [
    bx(20, 30, 130, 40, "模块（顶层）", ORNG, FILL_P),
    ar(150, 50, 200, 50, ORNG),
    bx(200, 30, 130, 40, "文件子块", CYAN, FILL_D),
    ar(330, 50, 380, 50, CYAN),
    bx(380, 30, 178, 40, "类 / 接口 / 枚举", PUR, FILL_U),
    bx(20, 100, 170, 44, "细化 = 逐层下钻到底", GRN, FILL_G),
    bx(210, 100, 348, 44, "每层一个功能块，可绑 devModel / devPreset / devEffort", GOLD, FILL_C),
  ],
  blink: [
    { x: 200, y: 30, w: 130, h: 40, color: CYAN, dur: "4s" },
    { x: 380, y: 30, w: 178, h: 40, color: PUR, dur: "4s" },
  ],
};
diagrams["mtnode-agent-11-flow"] = {
  w: 600,
  h: 190,
  caption: "数据库节点：信息 / 文件节点 → ⚙ 编译 → db_replica → 智能节点用 mtnode_db 查询（一切事实走库）",
  items: [
    bx(20, 50, 140, 48, "数据库 super\n收纳事实", GOLD, FILL_C),
    ar(160, 74, 210, 74, GOLD),
    bx(210, 50, 130, 48, "⚙ 编译", ORNG, FILL_P),
    ar(340, 74, 390, 74, ORNG),
    bx(390, 50, 130, 48, "db_replica", GRN, FILL_G),
    ar(520, 74, 560, 74, GRN),
    bx(410, 120, 180, 44, "智能节点 mtnode_db", PUR, FILL_U),
    tx(20, 132, "查不到就说「数据库中没有该信息」，绝不猜", RED, 11),
  ],
};

/* 第 6 章 素材与记录 */
diagrams["mtnode-share-01-ui"] = {
  w: 600,
  h: 190,
  caption: "素材库：分类打包文本 / 图像 / 音频 / 视频；素材节点一条内容 = 一对端子；删画布不丢",
  items: [
    bx(16, 40, 120, 100, "素材库\n文本\n图像\n音频\n视频", CYAN, FILL_D),
    ar(136, 90, 186, 90, CYAN),
    bx(186, 40, 150, 100, "素材节点\n一条内容 = 一对端子", ORNG, FILL_P),
    ar(336, 90, 386, 90, ORNG),
    bx(386, 40, 200, 100, "改内容即改库\n传媒体输出 file:/// URL", GRN, FILL_G),
    tx(16, 164, "失了根目录会「失联」→ 重新绑定；撤销时连库一起回滚", "#5a6472", 11),
  ],
};
diagrams["mtnode-share-02-flow"] = {
  w: 580,
  h: 170,
  caption: "导出 .mtnodes（含节点 / 连线 / 提示词 / 图像资产）或 Base64；导入后还原",
  items: [
    bx(20, 50, 130, 48, "画布 A", CYAN, FILL_D),
    ar(150, 74, 210, 74, CYAN),
    bx(210, 50, 150, 48, "导出 .mtnodes", ORNG, FILL_P),
    ar(360, 74, 420, 74, ORNG),
    bx(420, 50, 140, 48, "导入还原", GRN, FILL_G),
  ],
};
diagrams["mtnode-share-02-demo"] = {
  w: 580,
  h: 170,
  anim: true,
  motionDur: "5s",
  motion: "M 160,84 L 430,84",
  caption: "动效（约 5 秒循环）：导出 .mtnodes → 新画布导入 → 节点与连线一起还原",
  items: [
    bx(20, 60, 140, 48, "导出 .mtnodes", ORNG, FILL_P),
    ar(160, 84, 240, 84, ORNG),
    bx(240, 60, 110, 48, "文件包", CYAN, FILL_D),
    ar(350, 84, 430, 84, CYAN),
    bx(430, 60, 130, 48, "导入还原", GRN, FILL_G),
  ],
  blink: [{ x: 430, y: 60, w: 130, h: 48, color: GRN, dur: "2.5s" }],
};
diagrams["mtnode-share-03-ui"] = {
  w: 580,
  h: 180,
  caption: "创意工坊：浏览 / 搜索 / 下载公开模板；登录后可上传与管理（标题 / 预览图 / 描述 / 标签）",
  items: [
    bx(20, 40, 140, 48, "浏览 / 搜索", CYAN, FILL_D),
    ar(160, 64, 210, 64, CYAN),
    bx(210, 40, 140, 48, "下载模板", ORNG, FILL_P),
    ar(350, 64, 400, 64, ORNG),
    bx(400, 40, 160, 48, "登录后上传", GRN, FILL_G),
    tx(20, 120, "下载的模板若引用你没有的服务商，导入时会引导批量替换", "#5a6472", 11),
  ],
};
diagrams["mtnode-share-04-state"] = {
  w: 600,
  h: 190,
  caption: "撤销 / 重做 → save-backups/ 快照找回 → 误删画布进 trash\\ 手动放回",
  items: [
    bx(20, 50, 140, 48, "Ctrl+Z / Ctrl+Y", CYAN, FILL_D),
    ar(160, 74, 210, 74, CYAN),
    bx(210, 50, 150, 48, "save-backups 快照", ORNG, FILL_P),
    ar(360, 74, 410, 74, ORNG),
    bx(410, 50, 170, 48, "trash\\ 手动放回", GRN, FILL_G),
    tx(20, 130, "撤销连库一起回滚；本版本没有「一键恢复」按钮", "#5a6472", 11),
  ],
};

/* 第 7 章 编辑器与工作目录 */
diagrams["mtnode-edit-01-ui"] = {
  w: 580,
  h: 180,
  caption: "Markdown 阅读器：大纲 + 编辑模式（Ctrl+S 保存）；代码文件在工作目录内可直接打开编辑",
  items: [
    bx(20, 40, 120, 100, "大纲", CYAN, FILL_D),
    bx(148, 40, 280, 100, "Markdown / 代码 正文", GOLD, FILL_C),
    bx(436, 40, 124, 100, "编辑模式\nCtrl+S", ORNG, FILL_P),
    tx(20, 164, "只有工作目录内的文件才能在应用里打开写回", "#5a6472", 11),
  ],
};
diagrams["mtnode-edit-02-state"] = {
  w: 600,
  h: 200,
  caption: "批注锚定在选区 → 让 AI 依据批注修订 → 版本链 +1 → 采用当前版写回原文件",
  items: [
    bx(20, 40, 140, 48, "拖选正文", CYAN, FILL_D),
    ar(160, 64, 210, 64, CYAN),
    bx(210, 40, 150, 48, "浮空便笺批注", ORNG, FILL_P),
    ar(360, 64, 410, 64, ORNG),
    bx(410, 40, 170, 48, "AI 依据批注修订", PUR, FILL_U),
    bx(20, 116, 170, 44, "版本回看 / 回滚", GOLD, FILL_C),
    bx(206, 116, 170, 44, "采用当前版", GRN, FILL_G),
    bx(392, 116, 188, 44, "写回原文件", GRN, FILL_G),
  ],
};
diagrams["mtnode-edit-02-demo"] = {
  w: 600,
  h: 200,
  anim: true,
  motionDur: "7s",
  motion: "M 160,70 L 410,70",
  caption: "动效（约 7 秒循环）：拖选正文 → 浮空便笺 → 点「让 AI 依据批注修订」→ 版本链 +1",
  items: [
    bx(20, 46, 140, 48, "拖选正文", CYAN, FILL_D),
    ar(160, 70, 210, 70, CYAN),
    bx(210, 46, 150, 48, "浮空便笺", ORNG, FILL_P),
    ar(360, 70, 410, 70, ORNG),
    bx(410, 46, 170, 48, "依据批注修订", PUR, FILL_U),
    bx(20, 122, 250, 44, "版本链：审阅前 / 修订 1 / 修订 2", GOLD, FILL_C),
    bx(286, 122, 294, 44, "采用某一版写回原文件", GRN, FILL_G),
  ],
  blink: [{ x: 410, y: 46, w: 170, h: 48, color: PUR, dur: "3.5s" }],
};
diagrams["mtnode-edit-03-state"] = {
  w: 600,
  h: 190,
  caption: "工作目录 → 相对路径落点；数据目录 %APPDATA%\\pipeline-console（应用目录绝不落数据）",
  items: [
    bx(20, 40, 150, 48, "顶栏工作目录", CYAN, FILL_D),
    ar(170, 64, 220, 64, CYAN),
    bx(220, 40, 160, 48, "节点相对路径", ORNG, FILL_P),
    ar(380, 64, 430, 64, ORNG),
    bx(430, 40, 150, 48, "本机数据目录", GRN, FILL_G),
    bx(20, 116, 250, 44, "超级节点：工作目录 / 子文件夹 / …", GOLD, FILL_C),
    bx(286, 116, 294, 44, "启动体检：数据落进应用目录 → 报警", RED, FILL_R),
  ],
};

/* 第 8 章 设置与维护 */
diagrams["mtnode-app-01-ui"] = {
  w: 600,
  h: 190,
  caption: "设置各节：模型服务 · 智能能力（预设 / 扩展能力）· 画布备份 · 存档位置 · 发送键 · 主题（3 套）· 语言",
  items: [
    bx(16, 30, 180, 40, "模型服务", GOLD, FILL_C),
    bx(204, 30, 180, 40, "智能能力 / 预设", PUR, FILL_U),
    bx(392, 30, 192, 40, "扩展能力管理…", ORNG, FILL_P),
    bx(16, 82, 180, 40, "画布备份 / 存档位置", CYAN, FILL_D),
    bx(204, 82, 180, 40, "交互 / 发送键", CYAN, FILL_D),
    bx(392, 82, 192, 40, "主题 3 套 · 语言 中/EN", GRN, FILL_G),
    tx(16, 156, "模型列表可拖拽排序；主题只有 dsh 默认 / industrial / light 三套", "#5a6472", 11),
  ],
};
diagrams["mtnode-app-02-ui"] = {
  w: 560,
  h: 180,
  caption: "账户：创意工坊与讨论区共用同一账户；Key 与账号数据只存本机",
  items: [
    bx(20, 40, 140, 48, "右上角「账户」", CYAN, FILL_D),
    ar(160, 64, 210, 64, CYAN),
    bx(210, 40, 140, 48, "登录 / 退出", ORNG, FILL_P),
    ar(350, 64, 400, 64, ORNG),
    bx(400, 40, 140, 48, "工坊 + 讨论区", GRN, FILL_G),
  ],
};
diagrams["mtnode-app-03-ui"] = {
  w: 600,
  h: 190,
  caption: "更新：检测到新版 → 差分下载（只拉变更块）→ 静默安装并重启；失败可重试",
  items: [
    bx(20, 40, 140, 48, "高光「更新」", ORNG, FILL_P),
    ar(160, 64, 210, 64, ORNG),
    bx(210, 40, 150, 48, "差分下载", CYAN, FILL_D),
    ar(360, 64, 410, 64, CYAN),
    bx(410, 40, 170, 48, "静默安装 + 重启", GRN, FILL_G),
    tx(20, 120, "版本号唯一真源：仓库根 version 文件与 package.json（用 node version.js bump）", "#5a6472", 11),
  ],
};
diagrams["mtnode-app-04-ui"] = {
  w: 600,
  h: 210,
  caption: "排错：症状 → 原因 → 处理；常用诊断是启动体检 auditAppDirData 与 token 用量审计脚本",
  items: [
    bx(16, 34, 150, 40, "没 Key / 模型空", RED, FILL_R),
    bx(16, 82, 150, 40, "不识图", RED, FILL_R),
    bx(16, 130, 150, 40, "上游没跑 / 路径错", RED, FILL_R),
    bx(182, 34, 150, 40, "端口占用", RED, FILL_R),
    bx(182, 82, 150, 40, "媒体任务冲突", RED, FILL_R),
    bx(182, 130, 150, 40, "素材失联", RED, FILL_R),
    ar(332, 100, 372, 100, GOLD),
    bx(372, 60, 212, 84, "诊断：\nauditAppDirData 体检\nscripts/audit-token-usage.mjs\ncrash-report.js", GRN, FILL_G),
  ],
};
diagrams["mtnode-app-05-ui"] = {
  w: 580,
  h: 180,
  caption: "FAQ：按现象查表；每条都给原因与处理，能点到的页面直接跳转",
  items: [
    bx(20, 40, 140, 48, "我的现象", CYAN, FILL_D),
    ar(160, 64, 210, 64, CYAN),
    bx(210, 40, 150, 48, "常见错误表", ORNG, FILL_P),
    ar(360, 64, 410, 64, ORNG),
    bx(410, 50, 150, 28, "原因", GRN, FILL_G),
    bx(410, 86, 150, 28, "处理 / 跳转", GRN, FILL_G),
  ],
};

/* ─────────────────────────── 写图 ─────────────────────────── */
let svgCount = 0;
for (const [name, spec] of Object.entries(diagrams)) {
  const isDemo = /-demo$/.test(name);
  fs.writeFileSync(path.join(imgDir, name + ".svg"), render(spec, isDemo), "utf8");
  svgCount += 1;
  if (isDemo) {
    fs.writeFileSync(path.join(imgDir, name + "-static.svg"), render(spec, false), "utf8");
    svgCount += 1;
  }
}

/* 兼容保留：en/ 下尚未随中文一起重写的旧页仍引用这些老文件名，
 * 用同名（旧名）重新生成一份，避免老页面断图。中文页一律用新命名。*/
const legacyAlias = {
  "first-run": "mtnode-start-03-flow",
  "ui-tour": "mtnode-start-01-ui",
  "nodes-wires": "mtnode-canvas-02-flow",
  batch: "mtnode-flow-04-flow",
  "io-proc": "mtnode-flow-01-flow",
  "task-flow": "mtnode-flow-08-flow",
  timers: "mtnode-flow-08-flow",
  routing: "mtnode-flow-07-flow",
  dsh: "mtnode-agent-01-ui",
  providers: "mtnode-start-02-ui",
};
for (const [oldName, srcName] of Object.entries(legacyAlias)) {
  fs.writeFileSync(path.join(imgDir, oldName + ".svg"), render(diagrams[srcName], false), "utf8");
}

/* ─────────────────────────── 目录 ─────────────────────────── */

const catalog = {
  defaultPage: "overview",
  sections: [
    {
      id: "start",
      title: { zh: "上手", en: "Get started" },
      pages: [
        { id: "overview", title: { zh: "从这里开始", en: "Start here" } },
        { id: "ui-tour", title: { zh: "界面在哪儿", en: "Where things are" } },
        { id: "providers", title: { zh: "配置服务商与 API", en: "Providers & API" } },
        { id: "first-run", title: { zh: "第一条工作流", en: "Your first flow" } },
        { id: "shortcuts", title: { zh: "快捷键", en: "Shortcuts" } },
      ],
    },
    {
      id: "canvas",
      title: { zh: "画布与节点", en: "Canvas & nodes" },
      pages: [
        { id: "nodes-wires", title: { zh: "加节点、连线与 @ 引用", en: "Nodes, wires, @ refs" } },
        { id: "marks-groups", title: { zh: "框选、组与排版", en: "Box, groups, layout" } },
        { id: "super-nodes", title: { zh: "超级节点（收纳子图）", en: "Super nodes" } },
        { id: "canvas-tools", title: { zh: "查找、总览与边栏", en: "Find, overview, sidebar" } },
      ],
    },
    {
      id: "build",
      title: { zh: "做一条工作流", en: "Build a workflow" },
      pages: [
        { id: "io-proc", title: { zh: "输入 / 处理 / 保存", en: "Input / process / save" } },
        { id: "params-runs", title: { zh: "参数与运行调试", en: "Parameters & runs" } },
        { id: "batch", title: { zh: "批量、拆分与合并", en: "Batch, split, merge" } },
        { id: "media-gen", title: { zh: "出音乐 / 语音 / 视频", en: "Music / speech / video" } },
        { id: "media-net", title: { zh: "网络与执行节点", en: "Network & launch" } },
        { id: "control-flow", title: { zh: "控制流与判断", en: "Control flow & judges" } },
        { id: "tools-functions", title: { zh: "工具节点与函数节点", en: "Tool & function nodes" } },
        { id: "workflows", title: { zh: "保存、导入导出与工坊", en: "Save, import/export, workshop" } },
        { id: "global-broadcast", title: { zh: "全局节点广播", en: "Global node" } },
      ],
    },
    {
      id: "agent",
      title: { zh: "AI 干活", en: "Work with agents" },
      pages: [
        { id: "dsh", title: { zh: "智能能力是什么", en: "What agent mode is" } },
        { id: "agent-nodes", title: { zh: "智能任务与智能会话", en: "Agent task & session" } },
        { id: "approvals", title: { zh: "审批与权限", en: "Approvals" } },
        { id: "plugins-skills", title: { zh: "插件、技能与 MCP", en: "Plugins, skills, MCP" } },
        { id: "dev-nodes", title: { zh: "开发节点：让 AI 写项目", en: "Dev nodes" } },
        { id: "database-nodes", title: { zh: "数据库节点与事实纪律", en: "Database nodes" } },
        { id: "fact-library", title: { zh: "事实库", en: "Fact library" } },
        { id: "one-person-company", title: { zh: "AI 团队与多角色", en: "AI team & roles" } },
      ],
    },
    {
      id: "assets",
      title: { zh: "素材与记录", en: "Assets & history" },
      pages: [
        { id: "asset-library", title: { zh: "素材库与素材节点", en: "Asset library" } },
        { id: "editors", title: { zh: "Markdown 与代码编辑", en: "Markdown & code editing" } },
        { id: "ai-review", title: { zh: "AI 审阅：批注与修订", en: "AI review: notes & revisions" } },
        { id: "workspace", title: { zh: "工作目录与存档", en: "Workspace & archives" } },
        { id: "rollback", title: { zh: "撤销与回滚", en: "Undo & rollback" } },
      ],
    },
    {
      id: "app",
      title: { zh: "设置与维护", en: "Settings & upkeep" },
      pages: [
        { id: "settings", title: { zh: "设置总览", en: "Settings" } },
        { id: "account", title: { zh: "登录与账号", en: "Account & sign-in" } },
        { id: "update", title: { zh: "版本更新", en: "Updates" } },
        { id: "troubleshoot", title: { zh: "排错与诊断", en: "Troubleshooting" } },
        { id: "faq", title: { zh: "常见问题", en: "FAQ" } },
      ],
    },
    {
      id: "ref",
      title: { zh: "参考", en: "Reference" },
      pages: [
        { id: "node-guide", title: { zh: "节点指南索引", en: "Node guide index" } },
        { id: "glossary", title: { zh: "名词表", en: "Glossary" } },
        { id: "manual-notes", title: { zh: "这本手册怎么维护", en: "How this manual is built" } },
      ],
    },
  ],
};

fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");

/* ─────────────────────────── 正文：磁盘为准 ───────────────────────────
 * 只有磁盘上还没有正文的 id 才用下面的兜底模板写一版（统一骨架）。
 * 已存在的 guides/manual/<id>.md **原样保留**，所以重跑不会把新结构盖回旧稿。
 */
const pageIds = catalog.sections.flatMap((s) => s.pages.map((p) => p.id));

const LEGACY_REDIRECTS = {
  "task-chat": {
    to: "agent-nodes",
    title: "任务与对话（已并入其他页面）",
    zh: `# 任务与对话（已并入其他页面）

> 一句话目标：这一页的内容已经拆开并入别处，老链接来这里给你指路。

## 目标

把原来挤在这一页的四件事接到它们该在的位置，避免与新结构重复。

## 前置条件

- 无。这是一页导航。

## 步骤

1. **看任务节点**：见 [控制流与判断](#control-flow)。
2. **看超级节点**：见 [超级节点（收纳子图）](#super-nodes)。
3. **看会话模式（💬）**：见 [智能任务与智能会话](#agent-nodes)。
4. **看控制 · 执行 / 清空**：见 [控制流与判断](#control-flow)。

## 结果

你被带到了真正讲这件事的页面。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 从旧链接进来发现内容没了 | 本页已拆分合并 | 按上面的步骤跳转 |

## 下一步

- [智能任务与智能会话](#agent-nodes)
`,
  },
  "task-flow": { to: "control-flow", title: "任务控制流（已并入控制流与判断）", zh: redirectBody("任务控制流", "control-flow") },
  timers: { to: "control-flow", title: "定时与延时（已并入控制流与判断）", zh: redirectBody("定时与延时", "control-flow") },
  routing: { to: "control-flow", title: "闸门、分发与互斥（已并入控制流与判断）", zh: redirectBody("闸门、分发与互斥", "control-flow") },
};

function redirectBody(oldTitle, targetId) {
  return `# ${oldTitle}（已并入其他页面）

> 一句话目标：这一页已经并入 [控制流与判断](#${targetId})，老链接来这里给你指路。

## 目标

把你带到讲这件事的当前页面，避免同一件事在两页各写一半。

## 前置条件

- 无。这是一页导航。

## 步骤

1. **打开新页面**：点 [控制流与判断](#${targetId}) 继续。
2. **看端口细节**：右键节点 → 节点指南。

## 结果

你被带到了当前页面。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 旧链接内容变了 | 页面已合并 | 按上面的链接跳转 |

## 下一步

- [控制流与判断](#${targetId})
- [节点指南索引](#node-guide)
`;
}

function fallbackPage(page) {
  return `# ${page.title.zh}

> 一句话目标：这一页正在撰写中，先把结构定下来。

## 目标

（待补：这一页帮用户完成什么）

## 前置条件

- （待补）

## 步骤

1. **（待补）**：把要做的事写成动词开头的编号步骤。

## 结果

（待补：做完后屏幕上应该看到什么）

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 内容缺失 | 本页尚未写完 | 参考同章节其它页面；面板里点 ⚙ 设置 可看当前默认值 |

## 下一步

- [从这里开始](#overview)
`;
}

let written = 0;
for (const page of catalog.sections.flatMap((s) => s.pages)) {
  const file = path.join(root, page.id + ".md");
  if (!fs.existsSync(file)) {
    const tpl = LEGACY_REDIRECTS[page.id];
    fs.writeFileSync(file, ((tpl && tpl.zh) || fallbackPage(page)).trim() + "\n", "utf8");
    written += 1;
  }
}
for (const [id, tpl] of Object.entries(LEGACY_REDIRECTS)) {
  const file = path.join(root, id + ".md");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, String(tpl.zh).trim() + "\n", "utf8");
    written += 1;
  }
}

/* 英文：磁盘上已存在的 en/<id>.md 保持不动；缺失时不生成（应用按 id 回落中文）。*/

/* ── agent-nodes 的关键小节模板 ──────────────────────────────────────────────
 * 正文以磁盘为准（上面那段循环不会覆盖它），这里再保留一份同口径模板：
 * 重生成流程若哪天退回「内嵌模板优先」，也不会把「会话属于哪张画布」写回旧口径。
 */
const AGENT_NODES_SECTION_ZH = `### 会话属于哪张画布

会话在**建立的那一刻**就认下一张画布：你当时正看着哪张，它日后就读写哪张；在开发节点上点「开发 / 细化 / 问询」建的会话，所属画布就是那个功能块所在的画布。之后**你可以随意切去其他画布继续干活**，会话本轮的读写图、工作目录、数据库接地全部精准落在它自己那张图上，**不会串到你此刻正看着的画布**，也不会误改、误删你正在编辑的那张。侧栏每条会话标题下的 ▣ 与悬浮说明写的就是它的所属画布（该画布已删除会标出来）。

会话**不跨画布**读写：要参考或切换其他画布，用画布右侧的**全局助手**（✦），并把它的「工作范围」切到「全局」。

![会话属于哪张画布](img/mtnode-agent-03-state.svg)
*图 2：会话在建立那一刻认下一张画布，之后切画布也不会串图*

![全局助手](img/mtnode-agent-04-ui.svg)
*图 3：画布右侧的全局助手 ✦——工作范围可切「仅当前画布 / 全局」，改画布前会先向你确认*`;

const AGENT_NODES_SECTION_EN = `### Which canvas does a session belong to?

A session adopts its canvas **the moment it is created**: whichever canvas you are looking at then, and for sessions started from a dev node's 开发 / 细化 / 问询 button, the canvas that feature block lives on. From then on **you are free to switch to other canvases and keep working** — that session's graph reads/writes, working directory and database grounding all land precisely on **its own** canvas, never on the one now on your screen, so it can't overwrite or delete what you are editing. The ▣ under each session title (and its tooltip) shows which canvas it owns (marked as deleted if that canvas is gone).

Sessions do **not** reach across canvases: to look at or switch between several, use the **global assistant** (✦) right of the canvas with its **work scope set to global**.`;

console.log(
  "manual pages on disk:",
  pageIds.length,
  "| placeholder written:",
  written,
  "| diagrams:",
  svgCount,
);

/* guides/manual/_write.mjs — 生成应用内手册目录（index.json）与 14 张清晰图示（img/*.svg）。
 *
 * 约定：
 *   - 目录真源：本文件的 catalog → guides/manual/index.json（7 章 26 页，默认首页 overview）。
 *   - 正文以磁盘上的 guides/manual/<id>.md 与 en/<id>.md 为准，重跑本脚本不会覆盖正文。
 *   - 图示采用高对比度深色卡片样式（浅底/深底主题下均清晰可读），文字全部通过 WCAG 对比度基线。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));
const imgDir = path.join(root, "img");
fs.mkdirSync(imgDir, { recursive: true });

/* ─────────────────────────── 调色与 SVG 渲染 ─────────────────────────── */

const BG = "#11151d";
const FRAME = "#242c3c";
const CARD = "#181e2a";
const INK = "#f1f5f9";
const MUTED = "#a8b5c8";

const CYAN = "#38bdf8";
const ORNG = "#f59e0b";
const PUR = "#c792ea";
const GRN = "#4ade80";
const ROSE = "#fb7185";
const SLATE = "#64748b";

const FILL_D = "#12212e";
const FILL_P = "#261d12";
const FILL_U = "#21182c";
const FILL_G = "#12241b";
const FILL_R = "#29151c";
const FILL_S = "#1a202c";

const FONT = 'system-ui, -apple-system, "Microsoft YaHei UI", "PingFang SC", sans-serif';

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const card = (x, y, w, h, title, sub, color, fill, badge) => ({
  t: "card",
  x,
  y,
  w,
  h,
  title,
  sub: sub || "",
  color: color || CYAN,
  fill: fill || CARD,
  badge: badge || "",
});
const pill = (x, y, w, h, label, color, fill) => ({
  t: "pill",
  x,
  y,
  w,
  h,
  label,
  color: color || CYAN,
  fill: fill || FILL_S,
});
const zone = (x, y, w, h, label, color) => ({
  t: "zone",
  x,
  y,
  w,
  h,
  label,
  color: color || SLATE,
});
const ar = (x1, y1, x2, y2, color, label) => ({
  t: "arrow",
  x1,
  y1,
  x2,
  y2,
  color: color || MUTED,
  label: label || "",
});
const curve = (d, color) => ({ t: "curve", d, color: color || MUTED });
const tx = (x, y, label, color, size, anchor, weight) => ({
  t: "text",
  x,
  y,
  label,
  color: color || MUTED,
  size: size || 12,
  anchor: anchor || "start",
  weight: weight || 400,
});

function render(spec) {
  const W = spec.w || 680;
  const H = spec.h || 240;
  const out = [];
  const mark = (id, c) =>
    `    <marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,1 L7,4 L0,7 z" fill="${c}"/></marker>`;
  out.push("  <defs>");
  for (const [id, c] of [
    ["arr-cyan", CYAN],
    ["arr-orange", ORNG],
    ["arr-purple", PUR],
    ["arr-green", GRN],
    ["arr-rose", ROSE],
    ["arr-muted", MUTED],
  ]) {
    out.push(mark(id, c));
  }
  out.push("  </defs>");
  const markerOf = (c) =>
    c === CYAN
      ? "arr-cyan"
      : c === ORNG
        ? "arr-orange"
        : c === PUR
          ? "arr-purple"
          : c === GRN
            ? "arr-green"
            : c === ROSE
              ? "arr-rose"
              : "arr-muted";

  out.push(`  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${BG}" stroke="${FRAME}"/>`);

  if (spec.title) {
    out.push(
      `  <text x="20" y="28" fill="${INK}" font-size="14" font-weight="700" font-family='${FONT}'>${esc(spec.title)}</text>`,
    );
  }
  if (spec.subtitle) {
    out.push(
      `  <text x="20" y="46" fill="${MUTED}" font-size="11.5" font-family='${FONT}'>${esc(spec.subtitle)}</text>`,
    );
  }

  for (const it of spec.items || []) {
    if (it.t === "zone") {
      out.push(
        `  <rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="8" fill="#141923" stroke="${it.color}" stroke-width="1.2" stroke-dasharray="5 4"/>`,
      );
      if (it.label) {
        out.push(
          `  <text x="${it.x + 12}" y="${it.y + 18}" fill="${it.color}" font-size="11" font-weight="600" font-family='${FONT}'>${esc(it.label)}</text>`,
        );
      }
    } else if (it.t === "card") {
      out.push(
        `  <rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="8" fill="${it.fill}" stroke="${it.color}" stroke-width="1.5"/>`,
      );
      out.push(
        `  <rect x="${it.x + 1}" y="${it.y + 1}" width="${it.w - 2}" height="4" rx="2" fill="${it.color}" opacity="0.85"/>`,
      );
      const cx = it.x + it.w / 2;
      if (it.badge) {
        const bw = Math.max(22, it.badge.length * 8 + 12);
        out.push(
          `  <rect x="${it.x + 10}" y="${it.y + 12}" width="${bw}" height="18" rx="9" fill="${it.color}" opacity="0.2"/>`,
        );
        out.push(
          `  <text x="${it.x + 10 + bw / 2}" y="${it.y + 24.5}" text-anchor="middle" fill="${it.color}" font-size="10.5" font-weight="700" font-family='${FONT}'>${esc(it.badge)}</text>`,
        );
      }
      const titleLines = String(it.title).split("\n");
      const subLines = it.sub ? String(it.sub).split("\n") : [];
      const totalH = titleLines.length * 16 + (subLines.length ? 4 + subLines.length * 14 : 0);
      let y0 = it.y + (it.badge ? 42 : Math.max(24, (it.h - totalH) / 2 + 13));
      for (const line of titleLines) {
        out.push(
          `  <text x="${cx}" y="${y0}" text-anchor="middle" fill="${INK}" font-size="13" font-weight="700" font-family='${FONT}'>${esc(line)}</text>`,
        );
        y0 += 16;
      }
      if (subLines.length) {
        y0 += 2;
        for (const line of subLines) {
          out.push(
            `  <text x="${cx}" y="${y0}" text-anchor="middle" fill="${MUTED}" font-size="11" font-family='${FONT}'>${esc(line)}</text>`,
          );
          y0 += 14.5;
        }
      }
    } else if (it.t === "pill") {
      out.push(
        `  <rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="6" fill="${it.fill}" stroke="${it.color}" stroke-width="1.25"/>`,
      );
      const lines = String(it.label).split("\n");
      const cx = it.x + it.w / 2;
      const startY = it.y + it.h / 2 + 4 - ((lines.length - 1) * 14) / 2;
      lines.forEach((line, idx) => {
        out.push(
          `  <text x="${cx}" y="${startY + idx * 14}" text-anchor="middle" fill="${idx === 0 ? INK : MUTED}" font-size="${idx === 0 ? 12 : 10.5}" font-weight="${idx === 0 ? 600 : 400}" font-family='${FONT}'>${esc(line)}</text>`,
        );
      });
    } else if (it.t === "arrow") {
      out.push(
        `  <line x1="${it.x1}" y1="${it.y1}" x2="${it.x2}" y2="${it.y2}" stroke="${it.color}" stroke-width="1.8" marker-end="url(#${markerOf(it.color)})"/>`,
      );
      if (it.label) {
        const mx = (it.x1 + it.x2) / 2;
        const my = (it.y1 + it.y2) / 2 - 7;
        out.push(
          `  <text x="${mx}" y="${my}" text-anchor="middle" fill="${MUTED}" font-size="10.5" font-family='${FONT}'>${esc(it.label)}</text>`,
        );
      }
    } else if (it.t === "curve") {
      out.push(
        `  <path d="${it.d}" fill="none" stroke="${it.color}" stroke-width="1.7" marker-end="url(#${markerOf(it.color)})"/>`,
      );
    } else if (it.t === "text") {
      out.push(
        `  <text x="${it.x}" y="${it.y}" text-anchor="${it.anchor}" fill="${it.color}" font-size="${it.size}" font-weight="${it.weight}" font-family='${FONT}'>${esc(it.label)}</text>`,
      );
    }
  }

  if (spec.caption) {
    out.push(
      `  <text x="${W / 2}" y="${H - 12}" text-anchor="middle" fill="${MUTED}" font-size="11.5" font-family='${FONT}'>${esc(spec.caption)}</text>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n${out.join("\n")}\n</svg>\n`;
}

/* ─────────────────────────── 14 张图示 ─────────────────────────── */

const diagrams = {};

/* 1. 认识 MTNode（overview） */
diagrams["mtnode-overview-ui"] = {
  w: 680,
  h: 286,
  title: "MTNode 工作台一览",
  subtitle: "四大视图随时切换，所有文件与产出默认保存在你自己的电脑上",
  caption: "提示：顶栏切换主视图，底部状态栏放常用快捷工具（F1–F4 与 Ctrl+Tab）",
  items: [
    zone(18, 60, 644, 44, "", FRAME),
    pill(28, 68, 96, 28, "画布", ORNG, FILL_P),
    pill(132, 68, 96, 28, "会话", CYAN, FILL_D),
    pill(236, 68, 96, 28, "专家团", PUR, FILL_U),
    pill(340, 68, 96, 28, "研究", GRN, FILL_G),
    pill(452, 68, 64, 28, "插件", SLATE, FILL_S),
    pill(522, 68, 64, 28, "工坊", SLATE, FILL_S),
    pill(592, 68, 62, 28, "设置", SLATE, FILL_S),
    card(18, 116, 130, 102, "左侧栏", "节点列表\n项目文件树", SLATE, FILL_S),
    card(160, 116, 344, 102, "主工作区", "拖拽节点、连线、运行流程\n或在这里与 AI 连续协作", ORNG, FILL_P),
    card(516, 116, 146, 102, "右侧全局助手 ✦", "一句话搭流程\n随时问答与整理", PUR, FILL_U),
    zone(18, 228, 644, 34, "", FRAME),
    tx(32, 249, "底部状态栏：Ctrl+Tab 补全  ·  F1 快捷会话  ·  F2 DeepSeek  ·  F3 语音播报  ·  F4 语音输入  ·  AI 工作中", INK, 11, "start", 500),
  ],
};

/* 2. 配置模型与 API Key（providers） */
diagrams["mtnode-start-01-ui"] = {
  w: 680,
  h: 230,
  title: "接入 AI 模型的三种方式",
  subtitle: "在「设置 → 模型服务」里配置，任选一种就能立刻开工",
  caption: "API Key 等同账号与余额凭证，切勿截图或发给他人；所有配置改完自动保存",
  items: [
    card(20, 66, 200, 122, "方式一：填官方 API Key", "去 DeepSeek / 千问 / 智谱 / Kimi\n官网注册 → 创建 Key\n粘贴进「模型服务」即可", CYAN, FILL_D, "推荐"),
    card(240, 66, 200, 122, "方式二：MTNode 中转", "登录并充值后自动出现\n免填 Key、模型自动同步\n也可复制给其他软件用", ORNG, FILL_P, "省心"),
    card(460, 66, 200, 122, "方式三：本机免费模型", "在顶栏「插件」装 llama.cpp\n下载模型跑在自己显卡上\n完全离线、不花 API 费用", GRN, FILL_G, "离线"),
  ],
};

/* 3. 底栏快捷工具、语音与快捷键（quick-tools） */
diagrams["mtnode-quick-tools-ui"] = {
  w: 680,
  h: 224,
  title: "底部状态栏快捷入口",
  subtitle: "从左到右按顺序排开，在主窗口与应用窗口里都可用快捷键唤出",
  caption: "语音播报与语音输入默认跑在本机离线引擎，也可以右键切到 DeepSeek 云端",
  items: [
    card(18, 66, 118, 116, "输入补全", "边打字边预测\n按 Tab 采纳", PUR, FILL_U, "Ctrl+Tab"),
    card(148, 66, 118, 116, "快捷会话", "置顶小窗下指令\n只看最终回复", ORNG, FILL_P, "F1"),
    card(278, 66, 118, 116, "DeepSeek", "右侧对话抽屉\n随时查资料闲聊", CYAN, FILL_D, "F2"),
    card(408, 66, 118, 116, "语音播报", "朗读 AI 回复\n右键换音色引擎", GRN, FILL_G, "F3"),
    card(538, 66, 124, 116, "语音输入", "说话直接变文字\n按住 F4 或持续听", ROSE, FILL_R, "F4"),
  ],
};

/* 4. 文字与图像生成（io-proc） */
diagrams["mtnode-flow-01-ui"] = {
  w: 680,
  h: 210,
  title: "最基础的一条内容生成链",
  subtitle: "放好素材 → 交给 AI 处理 → 自动保存成文件，以后改上游就能一键重跑",
  caption: "在提示词里输入 @节点标题 引用上游内容；改完素材点 ▶ 就能重跑整条链",
  items: [
    card(20, 66, 140, 102, "1. 输入节点", "放文字 / 图片\n音频 / 表单", CYAN, FILL_D),
    ar(160, 117, 198, 117, CYAN),
    card(198, 66, 152, 102, "2. 处理节点", "AI 写文案 / 画图\n用 @ 引用上游", ORNG, FILL_P),
    ar(350, 117, 388, 117, ORNG),
    card(388, 66, 130, 102, "3. 保存节点", "自动存成\n.md / .png / .pdf", GRN, FILL_G),
    ar(518, 117, 552, 117, GRN),
    card(552, 66, 108, 102, "▶ 开始按钮", "连到起跑节点\n一键全流程重跑", PUR, FILL_U),
  ],
};

/* 5. 音视频与本地插件（media-gen） */
diagrams["mtnode-flow-02-flow"] = {
  w: 680,
  h: 254,
  title: "音乐、语音、视频与成片流水线",
  subtitle: "先生成单条音画素材，再交给 Remotion 合成带字幕的完整视频",
  caption: "本地音视频后端共享显卡排队，同一时间只跑一个重型任务；点插件卡片即可安装启停",
  items: [
    card(18, 68, 124, 68, "文稿 / 歌词", "风格词、口播稿", CYAN, FILL_D),
    card(18, 150, 124, 68, "图片 / 音频", "首帧图、参考音色", ORNG, FILL_P),
    ar(142, 102, 184, 92, CYAN),
    ar(142, 184, 184, 184, ORNG),
    pill(184, 66, 168, 44, "音乐与音频\nMusic 3 · YuE2 · MOSS", PUR, FILL_U),
    pill(184, 122, 168, 44, "语音合成与识别\nBreeze 本地 · DeepSeek 云端", PUR, FILL_U),
    pill(184, 178, 168, 44, "视频与数字人\nH3 · InfiniteTalk · SoulX", PUR, FILL_U),
    ar(352, 88, 400, 132, PUR),
    ar(352, 144, 400, 144, PUR),
    ar(352, 200, 400, 156, PUR),
    card(400, 96, 130, 96, "Remotion 合成", "字幕、卡片动画\n多片段拼装", ORNG, FILL_P),
    ar(530, 144, 562, 144, ORNG),
    card(562, 96, 100, 96, "保存成片", "输出 .mp4\n直接播放", GRN, FILL_G),
  ],
};

/* 6. AI 审阅（ai-review） */
diagrams["mtnode-edit-01-ui"] = {
  w: 680,
  h: 214,
  title: "AI 审阅：边批注边让 AI 改稿",
  subtitle: "不用自己重写整段，像批改作业一样标出哪里要改",
  caption: "每一版都会完整保留，不满意随时点回滚；点「采用当前版」才写回节点",
  items: [
    card(18, 68, 122, 104, "1. 打开审阅", "在节点输出框\n点「审阅」按钮", CYAN, FILL_D),
    ar(140, 120, 166, 120, CYAN),
    card(166, 68, 134, 104, "2. 标出批注", "选中某句写意见\n或写全文要求", ORNG, FILL_P),
    ar(300, 120, 326, 120, ORNG),
    card(326, 68, 134, 104, "3. AI 按批注改", "自动生成新版本\n保留历史版本", PUR, FILL_U),
    ar(460, 120, 486, 120, PUR),
    card(486, 68, 176, 104, "4. 核对并采纳", "满意 → 采用当前版写回\n不满意 → 继续批注或回滚", GRN, FILL_G),
  ],
};

/* 7. 图像蒙版（image-edit） */
diagrams["mtnode-edit-02-ui"] = {
  w: 680,
  h: 214,
  title: "局部重绘：只改你想改的那一块",
  subtitle: "给图涂上蒙版，蒙版外的画面严格保持不变",
  caption: "提示：蒙版里只写「这块要变成什么」，不要把整张图重新描述一遍",
  items: [
    card(18, 68, 130, 104, "1. 放入原图", "把原图接进\n图像节点的第 1 口", CYAN, FILL_D),
    ar(148, 120, 180, 120, CYAN),
    card(180, 68, 146, 104, "2. 涂抹蒙版", "点开编辑蒙版\n擦出要重绘的区域", ORNG, FILL_P),
    ar(326, 120, 358, 120, ORNG),
    card(358, 68, 152, 104, "3. 写重绘说明", "只描述擦掉的地方\n想要替换成什么", PUR, FILL_U),
    ar(510, 120, 542, 120, PUR),
    card(542, 68, 120, 104, "4. 生成并保存", "自动锁定原图尺寸\n蒙版外像素不动", GRN, FILL_G),
  ],
};

/* 8. 一句话搭工作流（workflows） */
diagrams["mtnode-agent-01-flow"] = {
  w: 680,
  h: 210,
  title: "一句话让助手帮你搭好工作流",
  subtitle: "不用自己一个个找节点，先把想法说出来，再按需要微调",
  caption: "助手默认只在空白处新增节点，不会删你原有的东西；不满意随时 Ctrl+Z 撤销",
  items: [
    card(20, 66, 194, 102, "1. 描述你的目标", "打开右侧助手 ✦ 说清：\n输入是什么 → 怎么处理 → 要什么成品", CYAN, FILL_D),
    ar(214, 117, 250, 117, CYAN),
    card(250, 66, 194, 102, "2. 助手自动搭建", "在当前画布创建节点、\n写好提示词、连线并排版", PUR, FILL_U),
    ar(444, 117, 480, 117, PUR),
    card(480, 66, 180, 102, "3. 换素材 · 点 ▶ 跑", "把示例内容换成你的资料\n点开始按钮一键出结果", GRN, FILL_G),
  ],
};

/* 9. 智能会话（dsh / agent-nodes） */
diagrams["mtnode-agent-02-ui"] = {
  w: 680,
  h: 244,
  title: "智能会话：怎么和 AI 顺畅协作",
  subtitle: "会话会记住上下文，也能读写你的项目文件、联网查资料、操作画布",
  caption: "提示：会话在创建时就绑定当前画布，之后切换别的画布也不会串台",
  items: [
    card(18, 66, 196, 140, "开工前挑好设定", "· 工作区：限定操作目录\n· 模型与思考强度\n· 预设档（默认极简）\n· 附件（PDF/Word/表）与联网", CYAN, FILL_D),
    ar(214, 136, 246, 136, CYAN),
    card(246, 66, 200, 140, "干活中随时看与控", "· 简报模式：只看通俗结论\n· 边跑边发：排队或 ⚡插话\n· 需确认时弹审批 / 询问卡\n· 底部「AI 工作中」看进度", PUR, FILL_U),
    ar(446, 136, 478, 136, PUR),
    card(478, 66, 184, 140, "太长时轻装继续", "· 点「压缩上下文」收成摘要\n· 原文折叠留档不丢失\n· 按住 Ctrl+滚轮调字号\n· 支持批注与贴图追问", GRN, FILL_G),
  ],
};

/* 10. 工具与函数节点（tools-functions） */
diagrams["mtnode-canvas-02-ui"] = {
  w: 680,
  h: 226,
  title: "把常用步骤封装成可复用工具",
  subtitle: "在参数表里加一个参数，节点左右就会自动多出一个接口",
  caption: "注册进「工具库」后，别的画布能直接拖出来用，智能会话里的 AI 也能自动调用",
  items: [
    card(18, 66, 180, 62, "函数节点", "写几行 JS 做计算或整理数据", PUR, FILL_U),
    card(18, 138, 180, 62, "工具节点", "把一组画布节点打包成小工具", ORNG, FILL_P),
    ar(198, 97, 244, 122, PUR),
    ar(198, 169, 244, 144, ORNG),
    card(244, 72, 224, 122, "参数表 = 节点接口", "· 每个入参 → 左侧输入口\n· 每个出参 → 右侧输出口\n· 标注类型（文字/图片）防接错", CYAN, FILL_D),
    ar(468, 133, 502, 133, CYAN),
    card(502, 72, 160, 122, "放进工具库复用", "跨画布拖拽使用\nAI 会话也能直接调", GRN, FILL_G),
  ],
};

/* 11. 长周期任务（longtask） */
diagrams["mtnode-longtask-flow"] = {
  w: 680,
  h: 218,
  title: "长周期任务：AI 自动推进 + 关键节点人工把关",
  subtitle: "把复杂的多阶段项目画成流程图，该自动的自动跑，该你拍板的地方会停下来等你",
  caption: "所有阶段产出都会摆在画布上，你可以直接改内容，后面的步骤会接着用你的修改版",
  items: [
    card(18, 68, 142, 108, "1. 顶部任务条", "看全流程阶段图\n谁在跑、谁在等你", CYAN, FILL_D),
    ar(160, 122, 188, 122, CYAN),
    card(188, 68, 146, 108, "2. 自动执行环节", "AI 跑完把结果\n写进「产出节点」", PUR, FILL_U),
    ar(334, 122, 362, 122, PUR),
    card(362, 68, 148, 108, "3. 人工把关环节", "审批通过 / 写驳回理由\n或在交付节点传素材", ORNG, FILL_P),
    ar(510, 122, 538, 122, ORNG),
    card(538, 68, 124, 108, "4. 汇总与复用", "关键成品收进\n「产物节点」留档", GRN, FILL_G),
  ],
};

/* 12. 研究视图（research） */
diagrams["mtnode-research-flow"] = {
  w: 680,
  h: 222,
  title: "研究视图：从零散资料到知识图谱与演示",
  subtitle: "所有笔记与资料都以纯 Markdown 存在你的项目文件夹里，随时可带走",
  caption: "用 [[笔记名]] 和 [@文献] 写出关联，知识图谱就会自动长出来",
  items: [
    card(18, 68, 142, 110, "1. 投入资料", "拖入文稿 / PDF\n贴链接或写检索式", CYAN, FILL_D),
    ar(160, 123, 188, 123, CYAN),
    card(188, 68, 148, 110, "2. 精读与笔记", "三遍读法拆解\n选句批注 / 问 AI", PUR, FILL_U),
    ar(336, 123, 364, 123, PUR),
    card(364, 68, 146, 110, "3. 知识图谱", "看笔记、论断与术语\n之间的关联路径", ORNG, FILL_P),
    ar(510, 123, 538, 123, ORNG),
    card(538, 68, 124, 110, "4. 一键做演示", "排成可放映讲义\n或导出 HTML / 视频", GRN, FILL_G),
  ],
};

/* 13. 开发节点（dev-nodes） */
diagrams["mtnode-app-01-ui"] = {
  w: 680,
  h: 228,
  title: "开发节点：像画地图一样组织代码项目",
  subtitle: "先定项目骨架，再逐块细化与开发，每个模块都有独立的 AI 对话上下文",
  caption: "项目根目录会维护一份 AGENTS.md 共识文件，让每次开发都遵守同一套规矩",
  items: [
    card(210, 62, 260, 56, "项目块（顶层架构）", "写清项目目录、目标与整体约束", ORNG, FILL_P),
    ar(270, 118, 124, 146, ORNG),
    ar(340, 118, 340, 146, ORNG),
    ar(410, 118, 556, 146, ORNG),
    card(24, 146, 200, 58, "模块块", "建议 · 开发 · 细化", CYAN, FILL_D),
    card(240, 146, 200, 58, "文件块", "点「打开」直接读写源码", PUR, FILL_U),
    card(456, 146, 200, 58, "类 / 接口 / 枚举", "按需继续往下拆分", GRN, FILL_G),
  ],
};

/* 14. 开发一个应用（app-dev） */
diagrams["mtnode-app-02-ui"] = {
  w: 680,
  h: 222,
  title: "应用中心：用说话的方式做一个桌面小应用",
  subtitle: "不用从零配开发环境，选好风格就能边聊边改，做好后可独立开窗或上架分享",
  caption: "应用数据自动存进你自己的数据目录，升级或重装软件都不会丢",
  items: [
    card(18, 68, 146, 110, "1. 选风格新建", "7 套预设视觉风格\n或选「自定义」", CYAN, FILL_D),
    ar(164, 123, 192, 123, CYAN),
    card(192, 68, 148, 110, "2. 边聊边改", "在开发页会话里\n描述想要的界面功能", PUR, FILL_U),
    ar(340, 123, 368, 123, PUR),
    card(368, 68, 144, 110, "3. 实时预览", "中栏当场看效果\n点「启动」独立开窗", ORNG, FILL_P),
    ar(512, 123, 540, 123, ORNG),
    card(540, 68, 122, 110, "4. 收藏或上架", "留在「库」里自用\n或上架分享多版本", GRN, FILL_G),
  ],
};

/* ─────────────────────────── 写图 ─────────────────────────── */
let svgCount = 0;
for (const [name, spec] of Object.entries(diagrams)) {
  fs.writeFileSync(path.join(imgDir, name + ".svg"), render(spec), "utf8");
  svgCount += 1;
}

/* ─────────────────────────── 目录（7 章 26 页）─────────────────────────── */

const catalog = {
  defaultPage: "overview",
  sections: [
    {
      id: "start",
      title: { zh: "快速上手", en: "Get started" },
      pages: [
        { id: "overview", title: { zh: "认识 MTNode", en: "Meet MTNode" } },
        { id: "providers", title: { zh: "配置模型与 API Key", en: "Models & API keys" } },
        { id: "quick-tools", title: { zh: "底栏工具、语音与快捷键", en: "Quick tools, voice & hotkeys" } },
      ],
    },
    {
      id: "canvas",
      title: { zh: "画布与创作", en: "Canvas & creation" },
      pages: [
        { id: "nodes-wires", title: { zh: "画布基础：节点、连线与排版", en: "Canvas basics: nodes, wires & layout" } },
        { id: "io-proc", title: { zh: "文字与图像生成", en: "Text & image generation" } },
        { id: "image-edit", title: { zh: "图像编辑与蒙版重绘", en: "Image editing & masks" } },
        { id: "ai-review", title: { zh: "AI 审阅与文本编辑", en: "AI review & text editing" } },
        { id: "fim", title: { zh: "输入补全（边打字边预测）", en: "Inline completion (FIM)" } },
        { id: "media-gen", title: { zh: "音乐、语音、视频与本地插件", en: "Music, speech, video & local plugins" } },
      ],
    },
    {
      id: "session",
      title: { zh: "智能会话", en: "Agent sessions" },
      pages: [
        { id: "dsh", title: { zh: "智能会话与权限", en: "Agent sessions & permissions" } },
        { id: "agent-nodes", title: { zh: "智能节点与画布归属", en: "Agent nodes & canvas ownership" } },
        { id: "agent-browser", title: { zh: "让 AI 帮你操作浏览器", en: "Browser automation" } },
        { id: "paseo-bridge", title: { zh: "用手机接管会话（Paseo）", en: "Phone handoff (Paseo)" } },
      ],
    },
    {
      id: "workflow",
      title: { zh: "工作流与素材", en: "Workflows & assets" },
      pages: [
        { id: "workflows", title: { zh: "工作流管理与一句话搭流程", en: "Workflows & one-sentence builder" } },
        { id: "longtask", title: { zh: "长周期任务（多步骤与把关）", en: "Long-running tasks" } },
        { id: "tools-functions", title: { zh: "工具节点与函数节点", en: "Tool & function nodes" } },
        { id: "asset-library", title: { zh: "素材库与素材节点", en: "Asset library" } },
      ],
    },
    {
      id: "knowledge",
      title: { zh: "研究与专家团", en: "Research & team" },
      pages: [
        { id: "research", title: { zh: "研究视图：笔记、图谱与演示", en: "Research: notes, graph & slides" } },
        { id: "one-person-company", title: { zh: "AI 团队与多角色", en: "AI team & roles" } },
        { id: "ai-facts", title: { zh: "AI 事实库", en: "AI fact library" } },
      ],
    },
    {
      id: "build",
      title: { zh: "开发与扩展", en: "Build & extend" },
      pages: [
        { id: "dev-nodes", title: { zh: "开发节点：用画布做项目", en: "Dev nodes" } },
        { id: "app-dev", title: { zh: "打造自己的桌面应用", en: "Build a desktop app" } },
        { id: "app-publish", title: { zh: "上架应用与多版本管理", en: "Publish & manage app versions" } },
        { id: "mcp-server", title: { zh: "MCP 扩展与第三方接入", en: "MCP extensions & external clients" } },
      ],
    },
    {
      id: "help",
      title: { zh: "社区与帮助", en: "Community & help" },
      pages: [
        { id: "community", title: { zh: "创意工坊与讨论区", en: "Workshop & forum" } },
        { id: "faq", title: { zh: "常见问题与名词速查", en: "FAQ & glossary" } },
      ],
    },
  ],
};

fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");

/* ─────────────────────────── 正文：磁盘为准 ─────────────────────────── */
const pageIds = catalog.sections.flatMap((s) => s.pages.map((p) => p.id));

function fallbackPage(page) {
  return `# ${page.title.zh}

这一页正在整理中，先到「⚙ 设置」或相邻章节看看吧。

- [认识 MTNode](#overview)
`;
}

let written = 0;
for (const page of catalog.sections.flatMap((s) => s.pages)) {
  const file = path.join(root, page.id + ".md");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, fallbackPage(page), "utf8");
    written += 1;
  }
}

console.log(
  "manual pages on disk:",
  pageIds.length,
  "| placeholder written:",
  written,
  "| diagrams:",
  svgCount,
);

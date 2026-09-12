/* one-shot: write the built-in app manual catalog + all diagrams (zh is authored on disk; en pages are kept as-is)
 *
 * 口径（与 guides/manual/README.md §1.5 一致）：
 *   - 目录：本文件的 catalog → index.json（唯一真源）；现行 defaultPage = providers，共 10 章 20 页。
 *   - 正文：以磁盘上的 guides/manual/<id>.md 为准（磁盘有就原样保留），
 *           重跑本脚本**不会**把新结构覆盖回旧的内嵌模板。
 *   - 内容真源：正文按画布「快速开始」的说明卡片重写（分区 = 章节，卡片 = 页内小节）；
 *           卡片里有的必须写进去，卡片没提的内容不写。
 *   - 英文：磁盘上已有 en/<id>.md 的保持不动；缺失时应用按 id 回落中文。
 *   - 图示：全部由本文件生成到 guides/manual/img/，命名 mtnode-{章节}-{序号}-{类型}.svg，
 *           章节 = start|canvas|flow|agent|share|edit|app，类型 = ui|flow|state
 *           （自 2026-09 起只出静态图，不再生成 demo 动效图与 -static 回退）。
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

/* ─────────────────────────── 图示清单 ───────────────────────────
 * 口径：画布「快速开始」10 个分区 → 手册 20 页；只给 10 个关键页配静态图
 * （ui / flow / state），命名 mtnode-{章节}-{序号}-{类型}.svg，
 * 章节 = start|canvas|flow|agent|share|edit|app，与 guides/manual/README.md 一致。
 */

const diagrams = {};

/* 上手 · 配置服务商与 API（providers） */
diagrams["mtnode-start-01-ui"] = {
  w: 560,
  h: 170,
  caption: "拿到 API Key 并填进 MTNode 的三步：注册 → 创建 Key → 填进设置 · 模型服务",
  items: [
    bx(24, 56, 150, 52, "1 注册服务商", CYAN, FILL_D),
    ar(174, 82, 214, 82, CYAN),
    bx(214, 56, 140, 52, "2 创建 API Key", GOLD, FILL_C),
    ar(354, 82, 394, 82, GOLD),
    bx(394, 56, 140, 52, "3 填进 MTNode", GRN, FILL_G),
    tx(24, 140, "Key = 账号 + 钱的凭证：不截图、不外传、不写进公开仓库，只在官方平台创建", "#5a6472", 11),
  ],
};

/* 内容生成 · 输入 / 处理 / 保存（io-proc） */
diagrams["mtnode-flow-01-ui"] = {
  w: 580,
  h: 170,
  caption: "输入 → 处理 → 保存，再用控制节点 ▶ 一键重跑整条链",
  items: [
    bx(20, 50, 120, 48, "输入节点\n文本 / 图像", CYAN, FILL_D),
    ar(140, 74, 172, 74, CYAN),
    bx(172, 50, 130, 48, "处理节点\n文本 / 图像生成", ORNG, FILL_P),
    ar(302, 74, 334, 74, ORNG),
    bx(334, 50, 110, 48, "保存节点\n.md / .png", GOLD, FILL_C),
    ar(444, 74, 476, 74, GOLD),
    bx(476, 50, 90, 48, "▶ 控制节点", GRN, FILL_G),
    tx(20, 140, "上游改完重跑，下游跟着更新；控制节点 ▶ 用控制线直连到每个该重跑的节点", "#5a6472", 11),
  ],
};

/* 内容生成 · 出音乐 / 语音 / 视频（media-gen） */
diagrams["mtnode-flow-02-flow"] = {
  w: 620,
  h: 226,
  caption: "文本、图片、音频进，音乐 / 语音 / 视频与 Remotion 成片出",
  items: [
    bx(16, 46, 110, 44, "文本\n歌词 / 风格", CYAN, FILL_D),
    bx(16, 100, 110, 44, "图片 / 音频", ORNG, FILL_P),
    ar(126, 68, 168, 68, CYAN),
    ar(126, 122, 168, 122, ORNG),
    bx(168, 46, 120, 44, "音乐生成\nMusic 3", PUR, FILL_U),
    bx(168, 100, 120, 44, "语音合成\nSoVITS", PUR, FILL_U),
    bx(168, 154, 120, 44, "视频生成\nH3", PUR, FILL_U),
    ar(288, 68, 330, 68, PUR),
    ar(288, 122, 330, 122, PUR),
    ar(288, 176, 330, 176, PUR),
    bx(330, 100, 120, 44, "Remotion\n合成", GOLD, FILL_C),
    ar(450, 122, 492, 122, GOLD),
    bx(492, 100, 110, 44, "成片落盘\n.mp4", GRN, FILL_G),
    tx(16, 212, "音乐 / 语音 / 视频共享同一把互斥锁，同一时间只跑一个音视频任务", "#5a6472", 11),
  ],
};

/* 内容生成 · AI 审阅（ai-review） */
diagrams["mtnode-edit-01-ui"] = {
  w: 580,
  h: 196,
  caption: "输出框点「审阅」→ 全文 / 局部批注 → 让 AI 依据批注修订 → 采用当前版写回节点",
  items: [
    bx(16, 44, 140, 46, "生成一次文本", CYAN, FILL_D),
    ar(156, 67, 196, 67, CYAN),
    bx(196, 44, 140, 46, "输出框 · 审阅", ORNG, FILL_P),
    ar(336, 67, 376, 67, ORNG),
    bx(376, 44, 180, 46, "批注：全文 / 局部", GOLD, FILL_C),
    bx(16, 120, 180, 46, "让 AI 依据批注修订", PUR, FILL_U),
    ar(196, 143, 236, 143, PUR),
    bx(236, 120, 160, 46, "每版完整留存", GOLD, FILL_C),
    ar(396, 143, 436, 143, GOLD),
    bx(436, 120, 130, 46, "采用当前版写回", GRN, FILL_G),
    tx(16, 186, "仅当前版可编辑；回滚 = 该版重设为当前可编辑，其后各版作废但仍可回看", "#5a6472", 11),
  ],
};

/* 内容生成 · 图像编辑与蒙版（image-edit） */
diagrams["mtnode-edit-02-ui"] = {
  w: 580,
  h: 172,
  caption: "原图 → 涂抹蒙版（透明区 = 重绘）→ 局部重绘 → 保存",
  items: [
    bx(20, 50, 110, 48, "原图\n（第 1 张）", CYAN, FILL_D),
    ar(130, 74, 160, 74, CYAN),
    bx(160, 50, 130, 48, "涂抹蒙版\n透明区 = 重绘", ORNG, FILL_P),
    ar(290, 74, 320, 74, ORNG),
    bx(320, 50, 150, 48, "局部重绘\n只描述重绘区", PUR, FILL_U),
    ar(470, 74, 500, 74, PUR),
    bx(500, 50, 70, 48, "保存", GRN, FILL_G),
    tx(20, 132, "蒙版要亲手涂，AI 无法代画；带蒙版时请求尺寸被钉成首张参考图的像素尺寸", "#5a6472", 11),
    tx(20, 150, "模型不遵循蒙版时，MTNode 也会强制蒙版外像素不被改动", "#5a6472", 11),
  ],
};

/* 全局助手与工作流 · 五条示例链（workflows） */
diagrams["mtnode-canvas-01-flow"] = {
  w: 600,
  h: 204,
  caption: "画布「快速开始」的五条示例链：改输入 → 点该区 ▶ 一键重跑",
  items: [
    bx(16, 44, 180, 40, "① 文字处理：原文 → 口播文案", CYAN, FILL_D),
    bx(16, 92, 180, 40, "② 图像处理：提示词 → 配图", ORNG, FILL_P),
    bx(16, 140, 180, 40, "③ 图像转文案：识图 → 社媒文案", GOLD, FILL_C),
    bx(216, 44, 190, 40, "④ 一键口播视频：文稿 → 口播稿\n→ 语音 → 字幕视频", PUR, FILL_U),
    bx(216, 92, 190, 40, "⑤ 复杂示例：产品资料 → 长介绍\n+ 社媒短文案 + 横版 / 方版图", GRN, FILL_G),
    bx(216, 140, 190, 40, "　　分镜脚本 / 首帧 → TTS 配音\n→ H3 短片", GRN, FILL_G),
    tx(16, 196, "每区只需改输入、点该区的 ▶；助手一般只新增、不动你已有的节点", "#5a6472", 11),
  ],
};

/* 全局助手与工作流 · 一句话搭工作流（quick-build） */
diagrams["mtnode-agent-01-flow"] = {
  w: 580,
  h: 166,
  caption: "一句话交给右侧栏助手 → 助手在本画布建节点 / 连线 / 排版 → 你改输入、点 ▶ 重跑",
  items: [
    bx(20, 50, 180, 48, "一句话：输入 → 处理 → 产物", CYAN, FILL_D),
    ar(200, 74, 240, 74, CYAN),
    bx(240, 50, 150, 48, "助手建节点\n连线 / 排版", PUR, FILL_U),
    ar(390, 74, 430, 74, PUR),
    bx(430, 50, 130, 48, "改输入 · 点 ▶", GRN, FILL_G),
    tx(20, 140, "也可以用 / 或 、 打开「生成工作流」工具；不满意随时 Ctrl+Z 撤销", "#5a6472", 11),
  ],
};

/* 开发节点（dev-nodes） */
diagrams["mtnode-app-01-ui"] = {
  w: 620,
  h: 200,
  caption: "开发节点按「模块 → 文件 → 类 / 接口 / 枚举」逐层细化，块上是建议 / 开发 / 细化 / 打开四个按钮",
  items: [
    bx(16, 44, 210, 50, "项目块（模块）\ndevStatus / devFiles", GOLD, FILL_C),
    ln(121, 94, 130, 120, GOLD),
    ln(121, 94, 300, 120, GOLD),
    ln(121, 94, 470, 120, GOLD),
    bx(60, 120, 140, 44, "模块块", CYAN, FILL_D),
    bx(230, 120, 140, 44, "文件块", ORNG, FILL_P),
    bx(400, 120, 140, 44, "类 / 接口 / 枚举", GRN, FILL_G),
    tx(16, 186, "块上说明分两段（功能 / 实现）；收尾回写「核心文件」清单并更新项目根 AGENTS.md", "#5a6472", 11),
  ],
};

/* 会话 · 智能任务与智能会话（agent-nodes） */
diagrams["mtnode-agent-02-ui"] = {
  w: 620,
  h: 200,
  caption: "会话的三个入口与四组开关：模型 · 预设档 · 思考强度 · 工具许可 / 审批",
  items: [
    bx(16, 44, 180, 44, "全局助手 ✦\n看画布 · 改画布", ORNG, FILL_P),
    bx(16, 100, 180, 44, "智能节点\n读文件 + 多步 + 写文件", PUR, FILL_U),
    bx(16, 156, 180, 44, "开发节点的开发 / 细化", GOLD, FILL_C),
    ar(196, 66, 240, 66, ORNG),
    ar(196, 122, 240, 122, PUR),
    ar(196, 178, 240, 178, GOLD),
    bx(240, 44, 360, 156, "四组开关\n· 模型：flash 级够用，长文 / 写代码换更强\n· 预设档：决定人设与工具面\n· 思考强度：off / low / high / max\n· 工具许可与审批：放开哪些工具、哪些动作要弹窗", CYAN, FILL_D),
  ],
};

/* 工具节点与函数节点（tools-functions） */
diagrams["mtnode-canvas-02-ui"] = {
  w: 600,
  h: 192,
  caption: "参数表就是端子表：加一个参数就多一个端子",
  items: [
    bx(16, 44, 180, 48, "函数节点\nJS：input → return", PUR, FILL_U),
    bx(16, 120, 180, 48, "工具节点\n超级节点 + 注册", GOLD, FILL_C),
    ar(196, 68, 250, 68, PUR),
    ar(196, 144, 250, 144, GOLD),
    bx(250, 44, 330, 124, "参数表 = 端子表\n输入端子 0 = 控制入，1..N 依次是各入参\n输出端子 0..M-1 是各出参，末位是控制出\n端子类型 text / image 决定能不能相接", CYAN, FILL_D),
    tx(16, 184, "注册后会话与智能节点可直接调用它，把工作流固化成可复用的能力", "#5a6472", 11),
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

/* ─────────────────────────── 目录 ─────────────────────────── */

const catalog = {
  defaultPage: "providers",
  sections: [
    {
      id: "start",
      title: { zh: "上手", en: "Get started" },
      pages: [
        { id: "providers", title: { zh: "配置服务商与 API", en: "Providers & API" } },
      ],
    },
    {
      id: "content",
      title: { zh: "内容生成", en: "Content generation" },
      pages: [
        { id: "io-proc", title: { zh: "输入 / 处理 / 保存", en: "Input / process / save" } },
        { id: "media-gen", title: { zh: "出音乐 / 语音 / 视频", en: "Music / speech / video" } },
        { id: "ai-review", title: { zh: "AI 审阅：批注与修订", en: "AI review: notes & revisions" } },
        { id: "image-edit", title: { zh: "图像编辑与蒙版", en: "Image editing & masks" } },
      ],
    },
    {
      id: "assistant",
      title: { zh: "全局助手与工作流", en: "Assistant & workflows" },
      pages: [
        { id: "workflows", title: { zh: "保存、导入导出与工坊", en: "Save, import/export, workshop" } },
        { id: "quick-build", title: { zh: "一句话搭工作流", en: "Build a flow in one sentence" } },
      ],
    },
    {
      id: "dev",
      title: { zh: "开发节点", en: "Dev nodes" },
      pages: [
        { id: "dev-nodes", title: { zh: "开发节点：让 AI 写项目", en: "Dev nodes" } },
      ],
    },
    {
      id: "session",
      title: { zh: "会话", en: "Sessions" },
      pages: [
        { id: "dsh", title: { zh: "智能能力是什么", en: "What agent mode is" } },
        { id: "agent-nodes", title: { zh: "智能任务与智能会话", en: "Agent task & session" } },
        { id: "approvals", title: { zh: "审批与权限", en: "Approvals" } },
      ],
    },
    {
      id: "tools",
      title: { zh: "工具与函数节点", en: "Tool & function nodes" },
      pages: [
        { id: "tools-functions", title: { zh: "工具节点与函数节点", en: "Tool & function nodes" } },
      ],
    },
    {
      id: "assets",
      title: { zh: "素材库", en: "Asset library" },
      pages: [
        { id: "asset-library", title: { zh: "素材库与素材节点", en: "Asset library" } },
      ],
    },
    {
      id: "team",
      title: { zh: "专家团", en: "Expert team" },
      pages: [
        { id: "one-person-company", title: { zh: "AI 团队与多角色", en: "AI team & roles" } },
      ],
    },
    {
      id: "community",
      title: { zh: "社区", en: "Community" },
      pages: [
        { id: "community", title: { zh: "创意工坊与讨论区", en: "Workshop & forum" } },
      ],
    },
    {
      id: "misc",
      title: { zh: "其他", en: "More" },
      pages: [
        { id: "nodes-wires", title: { zh: "加节点、连线与 @ 引用", en: "Nodes, wires, @ refs" } },
        { id: "marks-groups", title: { zh: "框选、组与排版", en: "Box, groups, layout" } },
        { id: "rollback", title: { zh: "撤销与回滚", en: "Undo & rollback" } },
        { id: "glossary", title: { zh: "名词表", en: "Glossary" } },
        { id: "faq", title: { zh: "常见问题", en: "FAQ" } },
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
    fs.writeFileSync(file, fallbackPage(page).trim() + "\n", "utf8");
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

/**
 * MCP prompts 模板正文（三份：接手画布 / 建工作流 / 审阅画布）。
 *
 * 为什么正文写在这里而不是插件里：prompts 是 MCP 面的东西，自家 Agent 没有这个概念，
 * 所以它没有「插件真源」可抄 —— 但**能力口径**仍然只指向真源（资源 URI 与技能名），
 * 不在这里复述建图硬规则（那是 mtnode-canvas-edit-rules 的事）。
 *
 * 每份模板都用同一套骨架：① 先只读看清现状 ② 再动手（写操作要带 baseHash）
 * ③ 收尾自证（回执即事实，别复述）——这是 MTNode 自家 Agent 一路在用的纪律。
 */
"use strict";

const COMMON = [
  "你是通过 MCP 连到本机 MTNode 桌面端的客户端。可用工具（名字与参数以 tools/list 为准）：",
  "- mtnode_canvas_get / mtnode_canvas_edit：读 / 改画布（节点、连线、绘制、分组、超级节点）",
  "- mtnode_app：应用级动作（状态、画布列表、改名、选中、撤销重做、导出 PNG、插件管理、长任务图存取）",
  "- mtnode_db / mtnode_facts：数据库副本查询 / 每画布一份的 AI 事实库",
  "- lt_state：长任务本轮共享状态（读写本轮声明的键）",
  "- mtnode_assets：素材库（清单 / 读条目 / 窗口静帧截图）",
  "- mtnode_vision：识图子代理（读本机图片的像素，用于核对生成结果）",
  "",
  "两条硬纪律：",
  "1) 改画布前必须先 mtnode_canvas_get 读一遍，并把回执里的 contentHash 作为 baseHash 原样传回；对不上就重新读。",
  "2) 读图默认 detail:\"minimal\"（纯节点索引），要配置用 \"standard\"，要正文用 ids:[...] + \"full\"，只查连线用 sections:[\"nodes\",\"wires\"]。",
  "建图 / 连线 / 批次的完整硬规则在资源 mtnode://skill/mtnode-canvas-edit-rules —— 动手前读它，不要凭记忆建图。",
  "",
  "画布参数：省略 canvas = 当前打开的画布；也可以用画布 id 或精确名称操作其它画布（清单见资源 mtnode://canvases）。",
].join("\n");

function takeoverCanvas(args) {
  const canvas = String((args && args.canvas) || "").trim();
  return [
    "# 接手这张画布",
    "",
    COMMON,
    "",
    "## 这次要做的",
    "1. 用 mtnode_canvas_get 读" + (canvas ? "画布「" + canvas + "」" : "当前画布") + "（先 detail:\"minimal\" 拿节点索引）。",
    "2. 用一句话向用户复述你看到的现状：几张画布、这张图上有哪些节点、有没有明显断链（节点没有上游 / 没有下游 / 没接保存）。",
    "3. 问用户要改什么（或按用户已经说的那句需求直接做）。要改的节点比较多时，先按 detail:\"standard\" 读一次它们的配置与端子（ports / portRule）再动手。",
    "4. 一次 mtnode_canvas_edit 把这一批改动做完（create / update / connect 可以同批），带上 baseHash；回执是自足的，不要为核对再整图重读。",
    "5. 收尾只说「改了什么、哪些没做成」——回执里已经有 x/y/w/h 与 warnings，不要复述整张图。",
  ].join("\n");
}

function buildWorkflow(args) {
  const goal = String((args && args.goal) || "").trim() || "（用户未给出目标，先问清楚要做什么）";
  const canvas = String((args && args.canvas) || "").trim();
  return [
    "# 在 MTNode 画布上建一条可重跑的工作流",
    "",
    COMMON,
    "",
    "## 目标",
    goal,
    "",
    "## 这次要做的",
    "1. 先 mtnode_canvas_get 读" + (canvas ? "画布「" + canvas + "」" : "当前画布") + "，看清已有节点与布局（别把新图叠在旧图上）。",
    "2. 读资源 mtnode://skill/mtnode-canvas-edit-rules，按它给的 kind 与端子口径设计：输入（input_text / input_image / input_file）→ 处理（proc_text / proc_image / …）→ 保存（save / save_text / save_image / save_pdf）。",
    "3. 一次 mtnode_canvas_edit 建完整子图（节点 + 连线 + 分区框 createMarks box），并给入口留一个 control 节点（带 ctrlAction:\"run\"），让用户在界面上点一下就能重跑。",
    "4. 保存类节点的 savePath / outputPath 只能落在用户的数据目录或用户指定的项目目录 —— 绝不写进应用安装目录。",
    "5. 回执里逐条核 warnings：端子连错、缺必填参数、保存后缀不符都会写在那里；有问题就在同一轮修完再回复。",
    "6. 收尾告诉用户：建了哪些节点、从哪个 control 节点起跑、跑完结果落在哪个路径。",
  ].join("\n");
}

function reviewCanvas(args) {
  const canvas = String((args && args.canvas) || "").trim();
  return [
    "# 只读审阅这张画布",
    "",
    COMMON,
    "",
    "## 这次要做的（**不要改图**）",
    "1. mtnode_canvas_get 读" + (canvas ? "画布「" + canvas + "」" : "当前画布") + "：先 detail:\"minimal\"，再对可疑节点用 detail:\"standard\" + sections:[\"nodes\",\"wires\"] 看端子与连线。",
    "2. 逐条检查这些硬问题（每条都要指出具体节点名）：",
    "   - 断链：有输入端子的节点没有上游、处理节点没有下游、末端没有保存节点；",
    "   - 参数缺口：proc_text 没写 prompt、proc_image 没写 prompt / size、save 没写路径、timer / net / judge 的关键参数空着；",
    "   - 批量与文生图：batchMode=\"batch\" 的输入却把整批内容灌进单次运行、proc_image 一次想出多张；",
    "   - 端子错接：参考图接在端口 0（prompt 位）、固定端子节点接线顺序与 ports 不符；",
    "   - 保存落点：路径落在应用安装目录（会被升级带走）、后缀与数据类型不符。",
    "3. 输出一份逐条清单：问题 → 影响 → 建议改法（写清用哪个工具、改哪些字段）。等用户确认后再改。",
    "4. 全程只读：不要调用 mtnode_canvas_edit / mtnode_app 的写动作。",
  ].join("\n");
}

module.exports = { takeoverCanvas, buildWorkflow, reviewCanvas };

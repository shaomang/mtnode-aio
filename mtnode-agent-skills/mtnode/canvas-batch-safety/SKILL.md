---
name: mtnode-canvas-batch-safety
title: 画布批量与文生图防 N²
description: MTNode 画布 batchMode=batch 时每次运行只能处理单条输入，禁止把整批 N 条重复塞进每次运行；文生图 proc_image 每次只出 1 张。Use when designing batch workflows, proc_image, split nodes, or user reports duplicate API calls / token explosion.
---

# 画布批量与文生图安全

## batchMode=batch（逐条并行）

- 每次运行 **只应看到当前这一条** 输入
- **禁止**把整批 N 张图 / N 条文本再全部塞进每一次运行的参考图或提示词（否则约 N×N 次调用）
- 需要「从一批里只处理一项」时：先接 **split（拆分）** 节点选出单项，再连下游处理
- 要一次看全部才用 `batchMode=agg`（聚合）
- 两条批量源不要交叉接到同一文生图节点

## proc_image（文生图）

- 每次运行 **只生成 1 张图**
- prompt 里 **不要**写「生成多张 / 几张图」
- 需要多图：批量 1 条 1 张、多个 proc_image 节点、或 `attempts`×N
- **端子**：端口 0 = 提示词 / 文本入口 · **端口 1+ = 数据槽（连一条多一个 · 文本与图像引用都收 —— 图生图的参考图就接这里，勿接端口 0）**；输出 端口 0 = 图像 · 末尾 = 控制输出。空白节点只列得出端口 0，**别据此断定「没有图像参考端子」**：完整口径随 `canvas_get` 的 `ports`（定端口节点）或 `portRule`（增量端子节点）返回，一眼读全，不需要试连一条线看 warnings 反推接法
- 蒙版局部重绘 / 画幅锁定都只认「第 1 张参考图」：要它们生效，图像输入要连进来（`maskOn` 需连图，服务商须 OpenAI 兼容）

## 尺寸

- `size` 须为 `canvas_get` 的 `imageSizes` 之一（如 `2048x1360`、`1280x1280`、`auto`）；这三张静态表（kinds / imageSizes / defaultImageSize）不再随任何快照返回，需要时 `canvas_get` 传 `sections:["refs"]`

## 智能节点与保存

- **不要**给 `agent_task` 或 `proc_text(agent:true)` 后接 `save_*`：智能节点自己写文件，保存节点只会落无关对话文本
- `music_gen` / `video_gen` 在节点内 `outputPath` 直接写音视频，**无**配对保存节点
- **逐条批量（`batchMode=batch`）优先用普通 `proc_text` / `proc_image`**：智能节点每条都会带一份会话噪声，长批量链又贵又慢；要一次看全部再用 `batchMode=agg`，聚合模式才适合智能节点

## 文件交接

- 尽量不要把智能节点作为 **数据输入** 接到其他节点
- 优先：智能节点写出文件 → `wait_file`（控制线）阻塞下游 → 下游按约定路径读文件
- `wait_file` 无输入端子、不输出内容

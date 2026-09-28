# MTNode AI编排器 — Microsoft Store 上架文案与素材

> 用途：Partner Center「产品说明 / 简短说明 / 商店图像」直接复制即用。
> 素材产物统一放 `docs/assets/store/`；文生图提示词见文末，可在画布「Store 商店素材」区改词重跑。
> 版本对应：v1.2.4（2026-09）。

---

## 1. 产品说明（长描述 · 中文 · zh-CN）

**MTNode AI编排器——把 AI 能力画成流程图，一键跑起来。**

MTNode 是一款免费、在本机运行的桌面 AI 工作流编排工具。你不需要写代码，也不需要记住各种 API 参数：在画布上摆几个节点、连几条线，就得到一条可以反复一键重跑的 AI 流水线——文本、图像、音乐、视频、语音、本地大模型都能串进去。

**它最擅长这几件事：**

- **可视化工作流画布**：拖节点、连线、写提示词，点一下运行就出结果；批量逐条或聚合处理，进度可见；相关节点可以收进"壳"里，复杂流程也保持整洁。
- **AI 助手替你干活**：右侧助手能读文件、联网搜索、直接修改画布上的工作流；复杂任务先给方案、你确认后再动手。画布上的智能节点同样能对话、能调工具。
- **出图、出片、出声**：文生图（不再有恼人的超时打断）、AI 音乐生成、AI 视频生成、语音合成，既可走云端，也可完全在你自己的电脑上跑本地模型（音乐、视频、TTS、llama.cpp 均有本地后端）。
- **有据可查的记忆**：导入文件编成"事实库"，AI 回答必须从库里取证、注明出处，数字一律实算，不靠猜。
- **改坏了能回头**：工作流每 5 分钟自动备份，随时回滚到上一个好版本；节点改坏了不用重来。
- **配置一次，处处可用**：多家模型服务商粘贴即导入，一个界面管理文本、图像与本地模型；DSH 插件、技能、MCP 统一在"扩展能力"里管理。
- **懂开发的画布**：开发节点可以把软件项目画成多层架构图，每个模块就地发起"建议 / 开发 / 细化"，AI 直接在你的项目目录里干活。
- **纯净与自由**：MIT 开源；所有数据与密钥只留在本机；会话可开"纯净模式"，让模型只看到你写的原话。

适合内容创作者、独立开发者、游戏与小说策划、以及任何想"把 AI 串成自己的流水线"的人。

## 2. 产品功能简短摘要（≤200 字 · 商店"简短说明"用）

MTNode AI编排器是一款免费、本机运行的桌面AI工作流工具：在画布上连节点即可把文本、图像、音乐、视频、语音与本地大模型串成一键复跑的流水线。内置AI助手可读文件、联网、直接改画布，先出方案再开工；支持文生图、AI音乐/视频、语音合成与本地模型，事实数据库让回答有据可查，每5分钟自动备份可回滚。多服务商一键导入，插件/技能/MCP统一管理，MIT开源，数据不出本机。

（191 字）

## 3. 商店图像素材

| 文件 | 规格 | 用途 |
| --- | --- | --- |
| `docs/assets/store/ms-store-poster-9x16.png` | 2160×3840（9:16） | Partner Center「海报艺术」；对 Windows 10/11 客户用作主视觉徽标 |
| `docs/assets/store/ms-store-tile-2048x2048.png` | 2048×2048 | 1:1 磁贴源图（留档 / 重缩放用） |
| `docs/assets/store/ms-store-tile-300x300.png` | 300×300 | 1:1 应用磁贴图标（Microsoft Store 风格，与应用 Icon 同源：橙色描边方块 + 深色渐变 + 双青色像素角点） |

## 4. 文生图提示词（模型：gpt-image-2-vip）

### 4.1 9:16 海报（size `2160x3840`）

```text
Vertical 9:16 app-store hero poster for a desktop AI workflow orchestrator. Deep midnight-navy
background with a subtle diagonal gradient (#0f1320 to #1b2230) and a faint dot grid. In the upper
third glows a pixel-style emblem: a square with a thick flat orange (#ff8f2e) border, dark gradient
fill, and two small glowing cyan (#38d6ff) squares at its top-left and bottom-right corners. Below
it, an elegant floating node graph: rounded-rectangular UI cards with soft cyan and orange edge
glow, linked by smooth glowing bezier wires carrying tiny light particles; cards hold abstract
icons only — a sparkle (AI), a waveform (audio), a filmstrip (video), a database cylinder, an
image thumbnail. Cinematic volumetric glow, clean flat-design with slight 3D depth, premium
software marketing art, ultra detailed. Absolutely no text, no letters, no words, no logos, no
watermark.
```

### 4.2 1:1 应用磁贴（size `2048x2048`，生成后缩至 300×300）

```text
Flat vector square app icon in Microsoft Store Fluent style. A dark rounded-square tile filled
edge to edge with a smooth diagonal gradient from #1b2230 to #0f1320, framed by a bold flat
orange (#ff8f2e) square border. Inside, two small glowing cyan (#38d6ff) pixel squares — one at
the top-left corner, one at the bottom-right corner — connected by a thin glowing cyan diagonal
wire with one small orange node dot at its center. Minimal geometric pixel style, crisp edges,
subtle inner glow, centered composition, dark background, no text, no letters, no watermark.
```

### 4.3 重跑方式

- **画布**：本架构图画布下方「Store 商店素材」区，改提示词后点控制节点 ▶ 即可重抽；保存节点自动落盘到本目录。
- **命令行**：`node docs/assets/store/gen-store-images.mjs`（读取本机已配置的图像服务商，重新生成以上三个文件，并把磁贴自动缩到 300×300；`--resize-only` 可只做缩放不重抽）。

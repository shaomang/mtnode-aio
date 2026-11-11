# 图像模型规格与提示词参数

主技能 `../SKILL.md` 的补充表。数值来自上游源（Higgsfield 快照 2026-09-26、Black Forest Labs FLUX 指南），未标注者为平台默认值。

## 一、一步到位选型

| 需求 | 模型 | 关键参数 |
| --- | --- | --- |
| 人脸匹配 / 角色卡 / 一行小修 | Nano Banana 2 | 2 credits/次；1K / 2K / 4K；16:9 / 9:16 / 4:3 / 3:4；`@` Elements |
| 快速试版 / 草图转图 | Nano Banana | 1 credit/次；3:4；Draw（手绘转图） |
| 多元素复杂提示 / 海报 / 分镜格 | Nano Banana Pro（Gemini 3 Pro Image Preview） | 2 credits/次；16:9；1K；先内部推理再出图 |
| 服装 / 造型 / 品牌服饰 | GPT Image 2 | `quality` low / medium；1k / 2k |
| 地点 / 环境 / 电影感静帧 | Soul Cinema | 平台内最电影化 |
| 奇幻生物 / 非人角色 | Seedream 5.0（Pro / Flash / Lite） | 5.0 Lite / 4.5 适合线稿 + 平涂 |
| 文字排版 / 招牌 / 说明图 | FLUX.2 `flex` | `steps` 1–50、`guidance` 1.5–10；排版 `steps=50, guidance=7` |
| 批量 / 便宜变体 | FLUX.2 `klein` 4B / 9B | 参考图 ≤4；无 prompt upsampling |
| 主视觉 / 最高质量 | FLUX.2 `max` | 参考图 ≤8（API）/ 10（playground） |
| 修图 / 去物 / 补区 | FLUX.1 Fill | 局部重绘 |
| 本地免费 | FLUX.2 `dev` | 约 13GB 显存；非商用 |

## 二、Nano Banana 家族

| 档位 | 底层模型 | credits | 分辨率 | 强项 |
| --- | --- | --- | --- | --- |
| Nano Banana | Gemini 2.5 Flash Image | 1 | 1K 级 | 速度、批量、Draw |
| Nano Banana Pro | Gemini 3 Pro Image Preview | 2 | 1K | 复杂多元素、图中文字、分镜/连载图 |
| Nano Banana 2 | Gemini 3 Pro Image | — | 1K / 2K / 4K | 人脸匹配、保住输入图、一行式小修 |

用法要点：

- **一行式修正**优于整张重写：`Change only the jacket color to #2F4F4F, keep face, pose and background identical.`
- Pro 有内部推理阶段，长提示词不会像 Flash 那样丢后半段；适合「多元素 + 精确文字」。
- 同名 `@` 元素要先在平台保存，再在提示词里引用。

## 三、Seedream 家族

| 档位 | 强项 | 备注 |
| --- | --- | --- |
| Seedream 5.0 Pro | 从零建卡（服装纹理）、高保真 | 奇幻生物首选档 |
| Seedream 5.0 Flash | 速度 | 中等质量 |
| Seedream 5.0 Lite | 线稿 + 平涂 + 文字/分格排版 | 动漫/漫画风 |
| Seedream 4.5 | 通用 | 写实卡片仍优先 Soul / GPT Image 2 / Nano Banana Pro |

风格锚点用**年代/流派锚**（`early 2000s retro anime, soft painted cel-shading, vintage proportions`），不要用单个画师名。

## 四、FLUX 提示词规则（全系通用）

### 结构

```
[Subject] + [Action/Pose] + [Style/Medium] + [Context] + [Lighting] + [Technical]
```

扩写版：`[主体] + [属性/服装] + [动作] + [环境] + [风格/媒介] + [光] + [构图] + [技术：机身/镜头/胶片]`。

### 硬规则

1. **不支持 negative prompt。** 一律写想要的东西：`no glasses` → `visible eyes, unobstructed gaze`；`no text` → `clean unmarked surfaces`。
2. **写散文，不写关键词堆。** `woman, portrait, beautiful, blonde, studio, 8k` 会被平均化。
3. **重要元素前置。** 词序即权重：`A knight in shining armor stands in a forest, soft dappled light through the canopy` 优于把场景写在前面。
4. **长度 30–80 词最优**，上限 512 token。太短没方向，太长会失焦。
5. **必须写光。** 对画质影响最大的一项。
6. **改一个变量再出下一张**，否则不知道是什么起了作用。
7. **hex 色值要配颜色名与对象**：`#FF6B6B (coral pink) case`；一次 3–5 色最佳。
8. **文字要引号 + 字体 + 层级 + 位置**：`"DESIGN SUMMIT 2025" in bold condensed sans-serif, centered in the upper third`。文字 1–4 个词最稳。
9. **图生图要同时写「改什么」与「保留什么」**：`Transform to nighttime while maintaining the exact composition, outfit colors and lighting direction.`
10. **多参考要编号并分配角色**：`Image 1: face/identity; Image 2: pose; Image 3: style; Image 4: environment`。

### 分档提示词口味

| 档位 | 口味 |
| --- | --- |
| `klein` | 叙事散文，重光与氛围，40–70 词，主体前置 |
| `pro` | 均衡细节，可开 upsampling |
| `max` | 技术 + 描述混合：机身、镜头、光圈、胶片型号都写 |
| `flex` | 排版导向：引号文字、字体风格、层级、位置、色值 |
| `dev` | 同 `pro` |

### JSON 结构化（多元素/流水线时用）

```json
{
  "subjects": [{"id": "A", "desc": "elderly craftsman, weathered hands", "pos": "seated at workbench"}],
  "scene": {"setting": "traditional workshop", "time": "morning"},
  "composition": {"layout": "triangular", "focal_point": "center-left"},
  "technical": {"lighting": "natural window light from right", "lens": "50mm f/2"}
}
```

规则：主体给 ID、关注点分离（场景/主体/风格/技术各一层）、术语统一、执行前**压平成自然语言**再发。

## 五、常见参数换算

| 项 | 值 |
| --- | --- |
| 参考图上限 | klein ≤4；pro / flex ≤8；max ≤8（API）/ 10（playground） |
| 分辨率计价 | 按百万像素：`(首 MP + (输出 MP - 1) × 每 MP 价) + 输入 MP × 每 MP 价` |
| 1 MP 参考价 | klein 4B `$0.014` T2I / `$0.015` I2I；pro `$0.03` / `$0.045`；max `$0.07` / `$0.10`；flex `$0.06` / `$0.12` |
| 并发 | FLUX.2 系列 24；Kontext Max 6 |
| 扫描件门槛 | 漫画/分镜扫描 ≥300 dpi，数字稿 ≥1500px 宽（推荐 2000px+） |
| 交付分辨率 | 视频链路一律按目标画幅裁切后再喂；720p 足够发国内平台 |

## 六、图生图的「保留清单」写法

```
Change: [只改这一项].
Preserve: face, pose, framing, background, lighting direction, color of [指定衣物].
```

禁忌：`Make it look better`（无判据）、`Change the background`（范围过大）。逐步改优于一次大改：家具 → 壁炉 → 灯光 → 做旧，四步各出一张。

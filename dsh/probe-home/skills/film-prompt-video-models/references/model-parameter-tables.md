# 视频模型参数与路由速查

主技能 `../SKILL.md` 的补充表。所有数值来自上游源（OSideMedia 模型快照 2026-09-26、OpenMontage 路由表、fal.ai 定价），**源里没有的不写**；确实需要补充的写「通用经验值」。

## 一、按交付形态选模型

| 交付形态 | 首选 | 理由 |
| --- | --- | --- |
| 电影感 / 预告 / 高动态多镜 | Seedance 2.0 `standard` | 单次生成内多镜 + 原生同步音频 + 导演级运镜，Elo 1269（2026-02 口径） |
| 单次 15–30s 长片、多参考（角色+场景+道具） | Seedance 2.5 `omni_reference` | 4–30s 一次成型，≤30 图 + ≤50 项参考 |
| 人物对白/情绪戏、要稳的脸 | Kling 3.0 | 角色与运镜两项均 5 星，3–15s，自带音频 |
| 预算紧 / 快速迭代 | Seedance 2.0 `fast`、Kling 3.0 Turbo、Veo 3.1 Lite | 牺牲 1080p/4K 与部分运镜保真度 |
| 环境/自然/稳定长镜 | Veo 3.1（4/6/8s 档） | 生态稳定，首尾帧 + 声音意向写清即可 |
| 物理/流体/特效量大 | MiniMax H3（Hailuo 3.0） | 2K 输出，4–15s，显式摄影机指令响应好 |
| 本地/离线出片 | LTX-2.3 22B（ComfyUI / Modal A100-80GB） | 约 5s 短片，161 帧，可固定 `seed` |
| B-roll 铺量 | Wan 2.7（60fps）/ Wan 3.0（2–30s） | 画幅档多，`generate_audio` 可开 |

## 二、Seedance 2.0：模型 ID 与计价

fal.ai 模型 ID：

```
bytedance/seedance-2.0/text-to-video
bytedance/seedance-2.0/image-to-video
bytedance/seedance-2.0/reference-to-video      # 9 img + 3 vid + 3 audio
bytedance/seedance-2.0/fast/text-to-video
bytedance/seedance-2.0/fast/image-to-video
bytedance/seedance-2.0/fast/reference-to-video
```

Replicate：`bytedance/seedance-2.0` / `bytedance/seedance-2.0-fast`。

定价（fal.ai，720p）：standard `$0.3034/s`（T2V）、`$0.3024/s`（I2V）；fast `$0.2419/s`。

字节侧参考价：Pro 约 `$0.15 / 5s`，Lite 约 `$0.010/s`（BytePlus ModelArk，按 token 计）。

格式优先级（实测排序）：

| 形态 | 适用 | 写法 |
| --- | --- | --- |
| Transformation | 平静 → 威胁 → 变身 → 余波 | 6 个编号镜头 × 2.5s，共 15s |
| Orbs | 单镜连续 POV | 1 镜 15s，hyper-chaotic handheld |
| Fights | 打斗编排 | 逐拍 + 明确强弱差 + `RAMPS` / `SNAPS` |
| POV | 锁定视角反应 | 连续镜头，「no cuts no zoom」贯穿 |
| Animation | 风格化 3D | `@image` 关键帧 + 分段计时 |

## 三、Seedance 2.5：模式与计费后果

| 用户想要 | `mode` | 提示词本质 |
| --- | --- | --- |
| 纯文字描述出片 | `t2v` | 场景 brief（九段式） |
| 用户给了图/视频/音频 | `omni_reference` | 角色映射表 + 场景 brief |
| 改已有视频里的某样东西 | `video_edit` | 编辑指令：母版 + 范围 + 保留清单 |
| 在已有视频前后加戏 | `video_extension` | 边界契约 + 新内容 |

- 首尾帧、关键帧 3+、故事板网格、白模，**全部属于 `omni_reference`**；平台 `start_image` / `end_image` 只在 `omni_reference` 合法。
- `video_edit` 按源视频时长计费，`duration` 与 `aspect_ratio` 都不可设；`video_extension` 跟随源画幅，只有延长时长可设。
- 换人保像素的 v2v 走 `omni_reference` + 视频参考，`duration` 必须等于源时长，源片需 ≥4s。
- 没有 `genre` 参数——类型感要靠提示词里的 visual-style 子句承担。

## 四、Kling 3.0 / Veo / H3 / Wan 参数

| 模型 | 关键参数 | 备注 |
| --- | --- | --- |
| Kling 3.0 | `mode` std / pro / 4k；3–15s；16:9 / 9:16 / 1:1 | 原生音频；角色一致性最强的档位 |
| Kling 3.0 Turbo | 720p / 1080p；3–15s | 预算档，单张起始帧动画 |
| Kling 3.0 Motion Control | 3–30s | 从参考视频迁移动作；失败多在上游素材而非提示词 |
| Veo 3.1 | 4 / 6 / 8s；16:9 / 9:16；`quality` basic / high / ultra | 目录只暴露 `start_image`，首尾帧/延长/4K 走 UI |
| Veo 3.1 Fast | 同 3.1 | 目录默认变体 `veo-3-1-fast` |
| MiniMax H3 | 4–15s；2K；`batch_size` 1–4 | 首尾帧或图/视频/音频参考；音频参考需至少一个视觉参考 |
| MiniMax H3 Max | 5–15s；480p / 768p | 「快」档，参考角色与 H3 相同，上限 768p |
| Wan 3.0 | 2–30s 或 `-1`（智能，按 10s 计费）；`enable_thinking` | `end_image` 必须配 `start_image`；帧不能与参考媒体混用 |
| Wan 2.7 | 2–15s；60fps | T2V/I2V/R2V/编辑 + 首尾帧 |
| Gemini Omni Flash 1.1 | 3–10s；`mode` 必填（t2v / i2v / r2v / edit） | 编辑模式用源时长，上限 30s |
| LTX-2.3 | `--num-frames`（默认 161）、`--width/--height`、`--quality fast`、`--seed` | 约 5s；`MODAL_LTX2_ENDPOINT_URL` 需先配 |

## 五、时长换算（写分镜前先算）

- Seedance：`镜头数 × 2.5s ≈ 需要时长`；15s 上限 → 最多 6 镜。
- 2.5 的 30s：建议 8–10 镜，给结尾留 1–2s 反应与余味。
- Veo 只有 4 / 6 / 8s 三档，不要写 5s 或 7s。
- MiniMax H3 / Kling 3.0：4s 是短动作下限（眨眼、看一眼给 4–5s，不要给 2s）。
- 素材侧：Kling Motion Control 的源片若短于 4s，需冻结末帧补齐。

## 六、参数自检清单

- [ ] `duration` 在该模型档位内（Veo 只认 4/6/8）
- [ ] `aspect_ratio` 在该模型枚举内；竖屏 9:16 是否真的需要
- [ ] `resolution` 没有超出档位（2.0 Fast 无 1080p；2.5 无 4K）
- [ ] 参考数量没超上限，且首尾帧只在 `omni_reference`
- [ ] 需要音频时 `generate_audio` 显式打开；不需要时写 `No music`
- [ ] 台词用引号包裹并标说话人（`Character says: "..."`），单句 ≤6 词
- [ ] 需要可复现时给了 `seed`

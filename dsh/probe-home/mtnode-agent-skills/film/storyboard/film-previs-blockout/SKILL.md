---
name: film-previs-blockout
title: 白模预演：分镜到 3D layout
description: 把分镜编译成可播放的三维白模预演：定坐标与时间、写相机关键帧、选普通/关节后端、渲染 MP4 并用解码器核对时长帧率。需要验证机位与走位、排查空间说不清的镜头、给生成模型三维参照时用。
tags: 白模预演, previs, 机位关键帧, 走位, Blender, 渲染核对
version: 1.0.0
---

# 白模预演：分镜到 3D layout

## 何时用

- 用户明确说「做个白模预演 / blockout / 三维走位推演 / 出个机位参考视频」。
- 二维分镜说不清空间：人从哪出来、两人隔多远、机位怎么绕过柱子、镜头什么时候跟过去。
- 复杂运镜（环绕、穿越、长跟拍）要在烧生成预算前先验证一遍几何。
- 打斗、持械、抓取、缠绕等有接触的段落，要先证明接触点在几何上成立。
- 要给图生视频模型一份「预演帧 + 提示词」的可执行输入包。
- **不适用**：创意讨论、方案比较、「看看效果」——这些不构成渲染授权，按文字阶段交付即可；城市飞跃、爆炸、大场面（环境即镜头主体）也不适合白模，改走 AI 关键帧概念图。

## 核心原则

1. **只锁四件事**：空间（墙、门、距离）、机位（在哪、朝哪、怎么动）、调度（谁站哪、谁先动）、关键动作节点（何时侧移、何时倒地）。步伐、惯性、微表演**故意不规定**。
2. **资产是空间符号**。角色 = 有固定颜色的人形代理，车 = 长方体，墙 = 尺寸位置正确的盒子。不为一个不会出现在成片里的预演做模型细节；武器与服装做得越具体，生成模型就多一层必须复制的东西。
3. **第一交付是 MP4**。截图、编辑器界面、`.blend`、参数表、静态关键帧都不能替代可播放视频。没有能打开的 MP4，只能报「未完成」。
4. **默认值必须可追踪**。每个补出来的数值标来源：`explicit` / `semantic_mapping` / `derived` / `deterministic_default` / `unresolved`；默认值一律带 `prediction_claim: false`。
5. **预演不预测像素**。它证明的是当前编译解释里的镜头、空间、走位、切镜与节奏，不证明正式模型会生成相同的表演、材质或特效。
6. **不编造未实现的能力**。没有对应后端的主体类别（四足、车辆等）在编译阶段就报能力缺口，不许改成人形或球体冒充。
7. **打斗先过单动作门**。先用一个 2–4 秒的单动作镜头证明关节、握点、共享接触点、冻结帧与反作用，过了才允许扩成长段。只移动根节点 + 切机位不算打斗预演。
8. **切点对齐整帧**。镜头必须从 0 开始连续覆盖，不允许重叠与空档；时间以秒写，按顶层 `fps` 转帧。

## 工作流

1. **确认授权与输入**。输入：用户请求 + 已写好的提示词或分镜行。动作：确认「要实际出片」；完整保留原提示词，不改写。产出：原始提示词 + 目标时长/画幅（可缺省）。
2. **拆镜**。输入：提示词。动作：只有镜号、时间码、硬切、「切到」、明确转场才拆镜；「随后/然后/接着」默认同镜先后。未写镜头数却要求「蒙太奇/快速切换」→ 标 `unresolved`，不编分镜。产出：镜头列表（起止秒）。
3. **编译成契约**。输入：镜头列表。动作：按模板 3 写 `previs-compiler/1.0`：`meta` → `playback` → `compile` → `scene` → `cast` → `camera` → `timeline` → `validation_targets`。产出：`previs_compiled.json`。
4. **补默认值并标注来源**。输入：契约。动作：按模板 5 补时长、焦段、机位高度、运动距离，每项写进 `compile.assumptions[]`，带 `source` 与 `prediction_claim:false`。产出：带假设清单的契约。
5. **跑校验**。输入：契约。动作：查时间重叠/空档、缺摄影机、人物引用错误、不可执行的歧义；打斗规格查 `previs-action/1.0` 完整性。失败就在渲染前拒绝。产出：`previs_validation.json` 第一段（编译校验）。
6. **选后端**。输入：动作类型。动作：普通走位与机位 → 普通后端；有合格动作扩展的接触段落 → 关节后端。关节后端失败**必须停止**，不许暗回落到体块路径。产出：后端选择 + 依赖探测结果（Blender/FFmpeg 路径）。
7. **渲染**。输入：契约 + 后端。动作：按每镜首/中/尾帧渲染；相机运动必须来自真实三维位移或旋转，不许二维平移/变焦冒充。产出：分段帧序列 + 拼接 MP4（默认 24fps、960×540、16:9）。
8. **解码核对**。输入：MP4。动作：用实际解码器（`ffprobe`）读帧数、帧率、分辨率、时长；与契约逐项比。产出：`previs_validation.json` 第二段（实际解码）。
9. **观看检查**。输入：成片。动作：逐镜检查首帧、中点、尾帧、切镜前后；确认前后景有可感知视差、人物起中终位可见。产出：观看记录（逐镜通过/不通过）。
10. **交付**。输入：以上。动作：先给 MP4，再说明默认值、未解决项与边界；`.blend` 只作可选后台产物。产出：交付包。

## 关键参数与模板

### 1. 输出合同（每次执行至少四件）

| 产物 | 内容 | 作用 |
| --- | --- | --- |
| `previs.mp4` | 可播放白模视频 | 第一交付，唯一能证明预演成立的证据 |
| `previs_compiled.json` | 提示词的三维执行解释 | 可审计：为什么是这个机位、这个时长 |
| `previs_validation.json` | 时长/帧数/分辨率/切点/解码/观看检查 | 防「看起来像成了」 |
| `*.blend`（可选） | 可编辑工程 | 只作后台产物，不代替视频 |

### 2. 坐标与时间约定

- 右手坐标：`X` 向右、`Y` 向场景深处、`Z` 向上；地面 `Z=0`。
- 位置与尺寸单位米；时间单位秒；帧 = 秒 × 顶层 `fps`。
- 人物 `facing` 为角度，`0°` 面向 `+Y`，`90°` 面向 `+X`。
- 镜头从 `0` 连续覆盖到总时长，不允许重叠与空档。
- `lens_mm` 按 36mm 宽全画幅换算水平视角。

### 3. 契约骨架（`previs-compiler/1.0`，按上游字段名照填；完整字段字典、`previs-action/1.0` 与校验命令见 `references/previs-schema.md`）

```json
{
  "schema_version": "previs-compiler/1.0",
  "meta": { "title": "楼道信封", "purpose": "camera_and_blocking_previs", "prediction_claim": false },
  "playback": { "fps": 24, "resolution": [960, 540], "aspect_ratio": "16:9",
                "duration_s": 4, "duration_origin": "deterministic_default" },
  "compile": { "status": "ready_with_defaults", "assumptions": [], "unresolved": [], "warnings": [] },
  "scene": { "units": "meter", "geometry": [
    { "id": "floor", "type": "grid_plane", "center": [0, 0, 0], "size": [14, 12] },
    { "id": "door",  "type": "box", "center": [0, 0, 1.05], "size": [0.9, 0.1, 2.1] }
  ]},
  "cast": [{
    "id": "A", "rig": "humanoid", "height": 1.65, "tone": 0.92,
    "keyframes": [
      { "time_s": 0,   "position": [-0.4, 0.6, 0], "facing": 0,  "action": "idle" },
      { "time_s": 2.4, "position": [0, 0.2, 0],    "facing": 10, "action": "reach" }
    ]
  }],
  "camera": { "sensor_width_mm": 36, "rigs": [
    { "id": "cam_main", "shot_id": "S01", "keyframes": [
      { "time_s": 0,   "position": [1.1, -1.2, 1.55], "look_at": [0, 0.3, 1.5], "lens_mm": 35, "easing": "smooth" },
      { "time_s": 4.0, "position": [1.1, -0.9, 1.55], "look_at": [0, 0.3, 1.5], "lens_mm": 35, "easing": "smooth" }
    ]}
  ]},
  "timeline": {
    "shots": [{ "id": "S01", "label": "MCU PUSH", "start_s": 0, "end_s": 4.0, "camera": "cam_main" }],
    "cuts": []
  },
  "validation_targets": {
    "duration_tolerance_frames": 1,
    "require_decodable_mp4": true,
    "require_visible_camera_motion_when_requested": true
  }
}
```

- 场景几何首版只支持 `grid_plane` 与 `box`；人形代理支持 `humanoid` 与 `humanoid_mecha`；非人形双臂悬浮用 `two-arm-hover`。
- 补出来的数值写进 `compile.assumptions`（值 + 来源 + `prediction_claim:false`），有默认值时只能叫「诊断预演」；关键信息全部明确且通过校验，才可叫「忠实执行预演」。
- 焦段/机距/主体高度/必须看见的环境参照互斥时，写进 `compile.warnings` 或 `compile.unresolved`，不许静默改焦段来「凑成」。例：50mm、距 2 m 高人物 2.5 m 正后方跟拍，与「左右护栏产生明显视差」物理冲突。

### 4. 相机关键帧字段

| 字段 | 含义 | 取值 | 坑 |
| --- | --- | --- | --- |
| `time_s` | 全局时间，秒 | 必须落在该镜 `start_s`–`end_s` 内 | 用了镜内相对时间，机位会跳 |
| `position` | 摄影机中心 | `[x, y, z]`，米 | 写成视点而不是机位，景别全错 |
| `look_at` | 焦点/朝向目标 | `[x, y, z]` | 与 `position` 同点 → 退化，无法出图 |
| `lens_mm` | 全画幅等效焦段（`sensor_width_mm` 默认 36） | 默认 35；广角 24；长焦 85 | 用变焦代替机位移动 |
| `easing` | 缓动 | `linear` / `smooth` | 「缓慢」默认 `smooth`，「匀速」用 `linear` |

### 5. 默认值表（未写时按此补，并标来源）

| 缺什么 | 默认 | 备注 |
| --- | --- | --- |
| 单镜时长 | 4 秒 | `deterministic_default` |
| 多镜无时长 | 每镜 3 秒 | 同上 |
| 只给总时长 + 明确镜数 | 平均分配 | 同上 |
| 摄影机运动 | 静止 | 不自动加「电影感漂移」 |
| 「推进」无距离 | 前移初始机距 15% | `semantic_mapping` |
| 「横移」无距离 | 横移初始机距 25% | 同上 |
| 「环绕」无角度 | 20° | 同上 |
| 「升高/下降」无距离 | 主体高度 50% | 同上 |
| 「跟拍」 | 保持开始时的相对偏移 | 同上 |
| 焦段 | 35mm（广角 24mm / 长焦 85mm） | `deterministic_default` |
| 景别 | 中全景 | 同上 |
| 机位高度 | 普通 75% 主体高；低机位 25%；高机位 150% | 同上 |
| 场景 | 地面网格 + 地平线 + 必要前中后景参照 | 不编造环境美术 |
| 人物动作 | 原地保持 | — |
| 只写「打斗」无顺序/方向/接触时刻 | 双方对峙 + 标记调度未定义 | 不自动编武打 |

### 6. 两种数据方案

| 方案 | 数据结构 | 适用 |
| --- | --- | --- |
| A：`previs-compiler/1.0` | 顶层 `meta/playback/compile/scene/cast/camera/timeline`；相机用绝对关键帧（`time_s/position/look_at/lens_mm/easing`） | 任意提示词、单镜到多镜、需要审计默认值；可接 Blender 渲染 |
| B：Slate `storyboard.json` | 顶层 `project/w/h/fps/set/actors/shots[]`；`shots[]` 用 `cam` 语义档（`wide/near/two/cu/ots`）+ 运镜参数 | 对话/短剧等固定机位关系镜头；2D 引擎秒级迭代，字段少、改得快 |

方案 B 的镜字段（可直接写进分镜表）：

```json
{"id":"S02","dur":3.0,"cam":"ots","host":"A","target":"B","fov":40,
 "line":"谁在那儿？","speaker":"A","move":"dolly:in",
 "action":"指尖停在信封上方","prompt_cn":"…","prompt_en":"…",
 "lines":[{"at":0.4,"dur":1.6,"speaker":"A","line":"谁在那儿？"}]}
```

- `cam` 语义档：`wide` 全景建立（后退看人物中点）、`near` 某角色身后看桌、`two` 双人中景、`cu` 单人特写、`ots` 越肩反打（正反打自动成立）。
- 运镜参数按镜内进度插值：`dolly:"in"|"out"`、`pan:度数`、`whip:1`、`truck:米`、`orbit:度数`、`crane:米`、`zoom:倍率`。
- 显式 `pos`/`look`（世界坐标）优先于自动机位，用于 1:1 复刻。
- 长镜头多句台词用 `lines[]`，不要把 `dur` 拉长到塞不下。

### 7. 打斗门的五个条件（缺一只能出失败诊断）

1. 有关节枢轴或骨骼的进攻、格挡、受击姿势。
2. 武器与双手的握持约束，武器不许漂浮。
3. 进攻武器与防守肢体共享**同一个实际接触点**。
4. 接触前蓄力与减速、接触时冻结、恢复后的双向反作用。
5. 未读提示词的观看者，只看视频就能说清「谁用什么攻击、谁怎么挡、在哪里接触、双方怎么弹开」。

### 8. 完成门（八项全过才能说「已生成」）

- [ ] MP4 存在、非空、由实际解码器打开。
- [ ] 时长、帧率、分辨率、镜头边界与契约一致。
- [ ] 请求的相机运动来自真实三维位移/旋转，不是二维平移或变焦。
- [ ] 人物起点、中点、终点，以及切镜前后状态可见。
- [ ] 场景参照产生可感知的三维视差。
- [ ] 已观看完整视频，或逐镜检查首帧/中点/尾帧。
- [ ] 已写明所有默认值、未解决项与「不证明」的边界。
- [ ] 打斗段：独立观看者能辨认进攻方、武器、格挡方、接触点与反作用；持物段：握点与接触点落在最终渲染几何上并跨帧保持。

## 常见坑

- **切镜后机位没动，人物却换了位置**：症状是「看起来像穿模」。原因：把演员关键帧写成了镜内相对时间。修法：所有 `time` 用全局秒；同一世界里的人物不因切镜移动，只切摄影机。
- **景别写了没用**：症状是标着「特写」但画面还是全身。原因：景别只写了标签，没落到距离/高度/`look_at`/`lens_mm` 四件套。修法：用模板 4 实际构成，别指望标签。
- **推镜像变焦**：症状是透视不变、背景不放大。原因：只改 `lens_mm` 没改 `position`。修法：机位前移，`lens_mm` 保持不变；要推拉变焦就两件同时反向改。
- **打斗像方块互撞**：症状是武器穿模、接触点漂浮。原因：只移动根节点 + 切机位。修法：走关节后端 + `previs-action/1.0` 动作扩展，先过 2–4 秒单动作门。
- **视频「差不多」但没法验收**：症状是没人能说出时长对不对。原因：没用解码器核对，只看了播放器进度条。修法：`ffprobe -v quiet -print_format json -show_format -show_streams` 读实际值，逐项对契约。
- **渲染出不来还硬交**：症状是交了一堆截图和 `.blend`。原因：想用中间产物替代 MP4。修法：直接报「未完成 + 卡在哪一步（依赖/校验/后端）」，截图只作诊断附图。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| 62656456/ai-film-skills | 107 | Apache-2.0 | `experimental/whitebox-previs-executor` 的输出合同（MP4 + `previs_compiled.json` + `previs_validation.json` + 可选 `.blend`）、编译边界与默认值纪律、打斗五条件与单动作门、完成门八条；上游 `prompt-to-previs.md` 的切镜优先级、数值来源五档、最小默认表；`previs-spec.md` 的坐标系、人物/镜头/effects/tethers 字段 |
| coracoo/Slate | 51 | MIT | `previs_system/docs/白模方法论-空间符号与三分法.md` 的「资产=空间符号」「只把必须确定的信息交给 Blender」「三分法：预演管空间/参考图管长相/提示词管表演」；`previs_system/templates/storyboard.template.json` 与 `.codex/skills/video-previs/references/storyboard_schema.md` 的 `storyboard.json` 字段（`cam` 语义档、运镜参数、`lines[]`、`staging`/`pose` 覆盖）；`video-previs` 的「2D 对话白模秒级迭代、奇观大场面不要用」边界 |

- 抓取日期：2026-11-04
- 合并的上游技能：`whitebox-previs-executor`（prompt-to-previs、previs-spec）、Slate `video-previs`（storyboard schema、storyboard.template.json、白模方法论）
- 冲突与取舍：数据层两套——方案 A（62656456）用 `previs-compiler/1.0` 绝对坐标 + 相机关键帧，字段多但可审计、可直接驱动 Blender 与关节后端；方案 B（Slate）用 `storyboard.json` 的 `cam` 语义档（`wide/near/two/cu/ots`）+ 运镜参数字符串，字段少、2D 引擎可秒级改，适合对话与短剧。正文并存：**先用 B 快速定机位与节奏，定稿后再编译成 A 做正式渲染**；两者的公共字段是 `id / dur / actor id / shot 语义 / 台词`，转换只改表达不改决定。另一处冲突是「时长」：62656456 规定未写时长时单镜 4 秒、多镜每镜 3 秒；Slate 的模板每镜 3–4 秒，两者一致，故取前者为默认表。第三处是适用范围：Slate 明确「奇观大场面不要用白模」，62656456 允许任意提示词但要求「请求了运镜时前中后景必须有参照」；正文合并为——大场面可用白模验证机位，但环境美术仍走 AI 关键帧，不指望白模出成片质感。

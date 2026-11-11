---
name: film-post-jianying
title: 剪映草稿交接
description: 把成片工程导成剪映专业版可继续编辑的草稿：目录结构、draft_content.json 的轨道与片段字段、字幕素材与时间单位，以及交付后人工接手要注意的坑。需要客户或同事在剪映里改字幕、换镜头、调音时用。
tags: 剪映, 草稿, 交付, 时间线, 字幕, 多轨, JSON
version: 1.0.0
---

# 剪映草稿交接

## 何时用

- 成片已出，但客户／同事要在剪映里继续改字幕、换 B-roll、调节奏，需要一份能直接打开的工程。
- 剪辑由脚本或 ffmpeg 完成，交付物不能只有一个 MP4，还要可编辑时间线。
- 需要把原片、旁白、BGM、字幕、图片叠层分别放到独立轨道，而不是烧死在一起。
- 上一版草稿在别的机器上打开丢素材，要找原因并修目录结构。
- 要把「哪些能改、哪些已烧录」写清楚，避免接手的人以为字幕能逐条改。
- 不适用：只需要交付成片（直接给 MP4 + 字幕文件）；还在剪内容（用 `film-edit-narrative`）；平台规格（用 `film-deliver-platform`）。

## 核心原则

1. **草稿引用未烧录的源片，不是成片**。视频轨放原片区间（`source_path` 指原片），字幕／配音各自成轨；这样接手的人才能改。原片自带的硬字幕会保留，需要时在剪映里遮罩。
2. **最终判定仍是 ffmpeg 成片**。草稿是给人改的旁支产物；`recap_*.mp4` 或 `final_*.mp4` 才是验收对象，不能用「草稿能打开」代替成片质检。
3. **时间单位统一微秒，只在边界换算一次**。`start` / `duration` 全部是整数微秒；秒到微秒的转换只写一处（`round(秒 × 1_000_000)`），不要在多个函数里各转一次。
4. **轨道顺序就是层级**。音频（20000）< 视频（40000）< 图片叠层（50000）< 字幕（90000）< 普通文字（100000）；同类型多条轨道按 `name`、`name-1`、`name-2` 递增，`flag` 第一条为 0、后续为 2。
5. **同轨片段不得重叠**。半开区间排布，相邻段可复用同轨；真正重叠就新开后缀轨，绝不把两段硬塞在同一条轨上。
6. **素材必须打包并用占位符引用**。复制到 `Resources/local/{video,audio,image}`，`path` 写 `##_draftpath_placeholder_<固定 GUID>_##/Resources/local/...`，否则换机器或改目录名就丢素材。
7. **写草稿时剪映必须关闭，且不覆盖已有目录**。剪映运行中会覆写 `draft_content.json`；目标目录非空就改用 `_2` 后缀，不删别人的工程。
8. **只写流水线真实产出的轨道**。转场、蒙版、调色、贴纸、特效留给人工在剪映里加；不要伪造 `transitions`／`masks` 材质假装做过。

## 工作流

1. **确定可编辑范围**。输入：成片 + 工程。动作：列出「必须可编辑」（原片选段、旁白、BGM、字幕、图片叠层）与「已烧录／不提供」（调色、特效、转场）。产出：交接范围表。
2. **准备时间线**。输入：剪辑工程。动作：导出 `timeline.json`（秒为单位，`canvas` / `duration` / `tracks`），视频轨只放 base video，音轨分 narration／bgm／original，字幕单独 `subtitle` 轨。产出：通过字段校验的 `timeline.json`。
3. **探测素材**。输入：时间线引用的全部文件。动作：对每个文件跑 `ffprobe` 取宽高与时长（微秒），确认路径存在、时长 > 0。产出：素材清单（路径／时长／宽高／类型）。
4. **选模板**。输入：剪映版本。动作：方案 A 用固定版本模板（`version: 360000`、`new_version: "111.0.0"`、`app_version: "5.9.5-beta1"`）；方案 B 在本机剪映新建一个空草稿，复制它的 `draft_content.json` 当模板（版本升级后用这个）。产出：一份可填充的 JSON 模板。
5. **生成草稿**。输入：模板 + 时间线。动作：填 `canvas_config`、`duration`、`fps`、`id`、`materials`（46 个并行数组，只填 audios／videos／texts）、`tracks`；视频段写 `source_timerange` 与 `target_timerange`，字幕材质写 `type: "subtitle"`。产出：`draft_content.json`、`draft_info.json`（同内容副本）、`draft_meta_info.json`。
6. **打包素材**。输入：草稿目录。动作：按类型复制到 `Resources/local/{video,audio,image}`，同名冲突加 `_1`；`path` 换成占位符路径；`draft_meta_info.json` 的 `draft_materials[type=0].value` 写入每条素材的 `file_Path`／`md5`／`duration`／`width`／`height`。产出：自包含草稿目录。
7. **写入剪映草稿目录**。输入：草稿目录。动作：关闭剪映，复制到 `%LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft\<草稿名>\`；目录名即草稿名，`draft_meta_info.draft_fold_path` 写绝对路径。产出：可在剪映草稿列表看到的新草稿。
8. **人工验收**。输入：剪映里打开的草稿。动作：逐轨检查片段位置、字幕文字与位置、音量关键帧；导出一次与 ffmpeg 成片对比时长与音画同步。产出：验收记录 + 交接说明（模板 6）。

## 关键参数与模板

### 1. 草稿目录结构

```text
<草稿名>/
├─ draft_content.json          # 时间线主体：canvas_config / materials / tracks
├─ draft_info.json             # 与 draft_content.json 内容一致（同字节副本）
├─ draft_meta_info.json        # 草稿元信息与素材索引
└─ Resources/
   └─ local/
      ├─ video/                # 原片、图片（type=photo 也放这里）
      ├─ audio/                # 旁白分段 _placed_*.wav、BGM
      └─ image/                # 叠层图片
```

- Windows 草稿根目录（通用经验值）：`C:\Users\<用户名>\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft`。
- 剪映只在启动时扫描草稿列表：写完草稿后**完全退出再打开**，否则看不到新草稿。
- 目录名不要含 `/`、`\`、`.`、`..`；重名时用 `_2`，不要覆盖。

### 2. 三个 JSON 的字段

`draft_content.json`（根）

| 字段 | 值／类型 | 说明 |
| --- | --- | --- |
| `version` | `360000` | 草稿协议版本；跨大版本时以本机空草稿为准 |
| `new_version` | `"111.0.0"` | 剪映 5.9.x 口径 |
| `app_version` | `"5.9.5-beta1"` | 与 `platform`／`last_modified_platform` 内一致 |
| `id` | 32 位大写十六进制 | 草稿 ID，与 `draft_meta_info.draft_id` 相同 |
| `canvas_config` | `{"width":1080,"height":1920,"ratio":"original"}` | 画布尺寸；比例写 `original` 不要写 `9:16` |
| `fps` | `30.0` | 浮点；与素材帧率一致 |
| `duration` | 整数微秒 | 时间线总长，不是素材总长 |
| `materials` | 46 个并行数组 | 只填 `audios`／`videos`／`texts`，其余留空数组 |
| `tracks` | 轨道数组 | 顺序即层级，见模板 3 |
| `config` / `keyframes` / `platform` | 结构体 | 从模板继承，不改语义；设备指纹字段清空 |

`draft_meta_info.json`

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `draft_id` | 同 `id` | 必须一致 |
| `draft_name` | 草稿名 | 与目录名一致 |
| `draft_fold_path` | 绝对路径 | 草稿所在目录 |
| `tm_duration` | 整数微秒 | 与 `duration` 一致 |
| `tm_draft_create` / `tm_draft_modified` | 毫秒时间戳 | 写当前时间 |
| `draft_timeline_materials_size_` | 字节数 | 打包素材总大小 |
| `draft_materials[type=0].value` | 素材索引数组 | 每条含 `file_Path`／`md5`／`metetype`／`duration` |

### 3. 轨道与片段

完整的根 JSON 骨架、46 个材质数组、素材索引与逐项校验命令见 `references/draft-json-schema.md`。

| 轨道 | `type` | 语义层级 | 内容 |
| --- | --- | --- | --- |
| `audio`（narration／bgm／original） | `audio` | 20000 | 旁白分段、BGM、原声 |
| `video` | `video` | 40000 | base video / 原片区间 |
| `image` | `video` | 50000 | 图片叠层（材质 `type: "photo"`） |
| `subtitle` | `text` | 90000 | 解说字幕 |
| `text` | `text` | 100000 | 普通文字／花字 |

轨道对象：

```json
{
  "attribute": 0,
  "flag": 0,
  "id": "A1B2C3D4E5F60718293A4B5C6D7E8F90",
  "is_default_name": true,
  "name": "subtitle",
  "segments": [],
  "type": "text"
}
```

- 同类型第一条 `flag: 0`，后续 `flag: 2`；`name` 冲突时用 `subtitle-1`。
- 片段对象核心字段（其余从模板继承，不要手删）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `id` | 32 位大写十六进制 | 片段 ID |
| `material_id` | 材质 ID | 必须指向 `materials` 里某条 |
| `target_timerange` | `{"start":μs,"duration":μs}` | 在时间线上的位置 |
| `source_timerange` | `{"start":μs,"duration":μs}` | 在素材内的取用区间；字幕为 `start=0` |
| `speed` | `1.0` | 变速才改，改后要重算 `target_timerange` |
| `volume` | `1.0` | 有音量关键帧时设 1.0，关键帧写 `common_keyframes` |
| `clip.transform` | `{"x":0.0,"y":-0.72}` | 字幕默认下移；`y` 为归一化坐标 |
| `clip.scale` | `{"x":1.0,"y":1.0}` | 图片叠层缩放 |
| `render_index` | `2` | 保持模板默认，不要与语义层级混用 |
| `visible` / `last_nonzero_volume` | `true` / `1.0` | 常规默认值 |

### 4. 字幕材质

字幕不是 SRT，而是 `materials.texts` 里一条 text 材质，`content` 是**富文本 JSON 的字符串**：

```json
{
  "id": "11AA22BB33CC44DD55EE66FF77008899",
  "type": "subtitle",
  "alignment": 1,
  "font_size": 8.0,
  "text_color": "#FFFFFF",
  "line_spacing": 0.02,
  "letter_spacing": 0.0,
  "check_flag": 15,
  "content": "{\"text\":\"他以为门后是空的\",\"styles\":[{\"fill\":{\"alpha\":1.0,\"content\":{\"render_type\":\"solid\",\"solid\":{\"alpha\":1.0,\"color\":[1.0,1.0,1.0]}}},\"font\":{\"id\":\"\",\"path\":\"\"},\"range\":[0,8],\"size\":8.0}]}"
}
```

- `range` 的结束值是**字符数按 UTF-16 码元计**：中文 1 个字算 1，emoji 算 2；算错会导致后半句丢样式。
- `type` 用 `subtitle` 才会进字幕分类；普通文字用 `text`。
- `font_size: 8.0` 是剪映内部的相对字号，不是像素；换画布或换字体后必须在剪映里目视确认字高，再决定是否调大。

### 5. 素材打包与占位符

```text
##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##/Resources/local/audio/_placed_0000.wav
```

- 占位符 GUID 必须与剪映约定一致；写成绝对路径在换机器后必丢。
- `draft_meta_info.draft_materials` 的 `type: 0` 组里，每条素材要有 `file_Path`（`./Resources/local/...`）、`md5`、`metetype`（`video`／`music`／`photo`）、`duration`、`width`、`height`。
- `draft_timeline_materials_size_` 是所有打包素材字节数之和，写 0 会让剪映显示异常大小。

### 6. 交接说明模板

```markdown
# 剪映草稿交接

- 草稿名：`ep07_v03`
- 剪映版本：5.9.x（协议版本 360000）
- 画布：1080×1920 / 30fps / 总长 00:03:12
- 工程位置：`<项目>/jianying/ep07_v03/`

[可编辑]
- 视频轨：原片 12 段，按 `source_timerange` 取用，可重排、可换段
- 音频轨：narration 逐段 `_placed_*.wav`、bgm 一条，音量关键帧已写入
- 字幕轨：32 条，`type=subtitle`，位置 y=-0.72

[不可编辑（已烧录/未提供）]
- 调色、转场、蒙版、贴纸：未写入草稿，需在剪映里自行添加
- 原片自带硬字幕：仍在画面上，必要时用遮罩
- 成片以 `out/final_1080x1920.mp4` 为准

[已知差异]
- 草稿基于未烧录源片，导出结果与成片在调色与转场上会不同
- 图片叠层共 4 张，已打包进 Resources/local/image
```

## 常见坑

- **症状：草稿能打开，但素材全是红色离线。** 原因：`path` 写了绝对路径，或素材没复制进 `Resources/local`。修法：改用占位符路径并打包，`draft_meta_info` 补索引；移动目录后整体搬运。
- **症状：剪映启动后草稿列表里没有新草稿。** 原因：剪映启动时才扫描目录，或目录名与 `draft_name` 不一致。修法：完全退出剪映再开；确认目录名 = `draft_name` = 列表显示名。
- **症状：字幕只显示前半句，后半句没有样式。** 原因：`styles[].range` 按字符数算，emoji 或组合字算错。修法：按 UTF-16 码元计算结束位置（`len(text.encode('utf-16-le')) // 2`）。
- **症状：打开后片段位置整体偏后／时长翻倍。** 原因：把秒当微秒写，或 `target_timerange.duration` 用了源时长。修法：所有时间统一 `int(round(秒 × 1_000_000))`；`target` 用时间线时长，`source` 用素材内区间。
- **症状：剪映保存一次后草稿结构变了、脚本再写就冲突。** 原因：剪映会重写 JSON 并补全字段。修法：约定「剪映是唯一编辑入口」，脚本只在新建草稿时写；人工改过之后不要再用脚本覆盖。
- **症状：同一条轨上两段字幕叠在一起，导出只看到一条。** 原因：同轨片段区间重叠。修法：按半开区间分配轨道，重叠就开 `subtitle-1`，并检查 `target_timerange` 是否首尾相接。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| zenstory-ai/video-recap-skills | 601 | MIT | 剪映草稿导出完整口径：三份 JSON 的字段与骨架、轨道层级与 `flag`／`render_index`、微秒时间、字幕 text 材质与 UTF-16 `range`、占位符路径与 `Resources/local` 打包、素材索引与 `draft_timeline_materials_size_`、草稿目录防覆盖 |
| kajisho5/ffmpeg-skill | 4475 | MIT | 素材探测（时长／宽高）与 `-movflags +faststart`、交付编码参数、成片为最终判定对象的口径 |

- 抓取日期：2026-11-04
- 合并的上游技能：zenstory `video-assemble`（`scripts/jianying/*`、`references/jianying/*`、`docs/timeline-and-jianying.md`、`docs/capcut-jianying-draft-export.md`）、kajisho5/ffmpeg-skill 的探测与交付编码段落
- 冲突与取舍：zenstory 走「固定版本模板 + 全量 46 数组」，本技能保留为方案 A，并补方案 B「用本机空草稿当模板」以应对剪映版本升级；zenstory 的导出器会重算音量关键帧，本技能写明「脚本只在新建时写、人工改过后不再覆盖」，避免两套写法互相覆盖。上游草稿 JSON 属 MIT 协议，本技能只摘字段与结构，不复制其代码。

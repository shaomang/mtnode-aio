# 剪映草稿 JSON 结构与校验

## 1. `draft_content.json` 根结构

```json
{
  "canvas_config": {"width": 1080, "height": 1920, "ratio": "original"},
  "color_space": 0,
  "config": {
    "adjust_max_index": 1,
    "attachment_info": [],
    "combination_max_index": 1,
    "export_range": null,
    "extract_audio_last_index": 1,
    "lyrics_recognition_id": "",
    "lyrics_sync": true,
    "lyrics_taskinfo": [],
    "maintrack_adsorb": true,
    "material_save_mode": 0,
    "multi_language_current": "none",
    "multi_language_list": [],
    "multi_language_main": "none",
    "multi_language_mode": "none",
    "original_sound_last_index": 1,
    "record_audio_last_index": 1,
    "sticker_max_index": 1,
    "subtitle_keywords_config": null,
    "subtitle_recognition_id": "",
    "subtitle_sync": true,
    "subtitle_taskinfo": [],
    "system_font_list": [],
    "video_mute": false,
    "zoom_info_params": null
  },
  "cover": null,
  "create_time": 0,
  "duration": 192000000,
  "extra_info": null,
  "fps": 30.0,
  "free_render_index_mode_on": false,
  "group_container": null,
  "id": "3F2A9C0D4B6E48A19F7C2D5E8B1A4C60",
  "keyframe_graph_list": [],
  "keyframes": {"adjusts": [], "audios": [], "effects": [], "filters": [], "handwrites": [], "stickers": [], "texts": [], "videos": []},
  "last_modified_platform": {"app_id": 3704, "app_source": "lv", "app_version": "5.9.5-beta1", "device_id": "", "hard_disk_id": "", "mac_address": "", "os": "windows", "os_version": "10.0"},
  "materials": {"audios": [], "videos": [], "texts": []},
  "mutable_config": null,
  "name": "ep07_v03",
  "new_version": "111.0.0",
  "platform": {"app_id": 3704, "app_source": "lv", "app_version": "5.9.5-beta1", "device_id": "", "hard_disk_id": "", "mac_address": "", "os": "windows", "os_version": "10.0"},
  "relationships": [],
  "render_index_track_mode_on": false,
  "retouch_cover": null,
  "source": "default",
  "static_cover_image_path": "",
  "time_marks": null,
  "tracks": [],
  "update_time": 0,
  "version": 360000
}
```

要点：

- `duration` 是微秒：192000000 = 192 秒。
- `materials` 必须是 46 个并行数组（缺数组的老版本可能容忍，新版本会报结构错误）。写作时先放齐全空数组，再往 `audios`／`videos`／`texts` 里填。
- `platform` 与 `last_modified_platform` 的 `device_id`／`hard_disk_id`／`mac_address` 一律清空，不要带上原模板的机器指纹。

## 2. `materials` 的 46 个键

```text
ai_translates, audio_balances, audio_effects, audio_fades, audio_track_indexes,
audios, beats, canvases, chromas, color_curves, digital_humans, drafts, effects,
flowers, green_screens, handwrites, hsl, images, log_color_wheels, loudnesses,
manual_deformations, masks, common_mask, material_animations, material_colors,
multi_language_refs, placeholders, plugin_effects, primary_color_wheels,
realtime_denoises, shapes, smart_crops, smart_relights, sound_channel_mappings,
speeds, stickers, tail_leaders, text_templates, texts, time_marks, transitions,
video_effects, video_trackings, videos, vocal_beautifys, vocal_separations
```

只填三类：

| 数组 | 材质对象关键字段 |
| --- | --- |
| `videos` | `id`、`path`、`material_name`、`duration`（微秒）、`width`、`height`、`type`（`video`／`photo`） |
| `audios` | `id`、`path`、`material_name`、`duration`、`type`（`extract`／`music`）、`name` |
| `texts` | `id`、`type`（`subtitle`／`text`）、`content`（富文本 JSON 字符串）、`font_size`、`text_color`、`alignment`、`check_flag` |

## 3. 片段（segment）骨架

```json
{
  "id": "7C1E5A9B2D4F4680A3B6C8D0E2F4A6B8",
  "material_id": "11AA22BB33CC44DD55EE66FF77008899",
  "target_timerange": {"start": 0, "duration": 25000000},
  "source_timerange": {"start": 243000000, "duration": 25000000},
  "speed": 1.0,
  "volume": 1.0,
  "last_nonzero_volume": 1.0,
  "visible": true,
  "render_index": 2,
  "track_render_index": 0,
  "clip": {
    "alpha": 1.0,
    "flip": {"horizontal": false, "vertical": false},
    "rotation": 0.0,
    "scale": {"x": 1.0, "y": 1.0},
    "transform": {"x": 0.0, "y": 0.0}
  },
  "uniform_scale": {"on": true, "value": 1.0},
  "hdr_settings": {"intensity": 1.0, "mode": 1, "nits": 1000},
  "common_keyframes": [],
  "keyframe_refs": [],
  "extra_material_refs": [],
  "is_placeholder": false,
  "template_scene": "default"
}
```

- `source_timerange.start` 是素材内偏移；字幕固定 0，视频用原片入点。
- 变速后 `target_timerange.duration = source_timerange.duration ÷ speed`，两者不能同时照抄。
- `extra_material_refs` 指向 `speeds`／`audio_fades` 等辅助材质；不做变速与淡入淡出就留空。
- 片段 ID 与材质 ID 都必须 32 位大写十六进制且全草稿唯一。

## 4. 音量关键帧

```json
{
  "id": "9A8B7C6D5E4F40312233445566778899",
  "material_id": "",
  "property_type": "KFTypeVolume",
  "keyframe_list": [
    {"id": "0A1B2C3D4E5F60718293A4B5C6D7E8F9", "time_offset": 0, "values": [0.85],
     "curveType": "Line", "graphID": "",
     "left_control": {"x": 0.0, "y": 0.0}, "right_control": {"x": 0.0, "y": 0.0}}
  ]
}
```

- `time_offset` 是相对片段起点的微秒，不是绝对时间。
- 音量关键帧存在时，片段 `volume` 写 1.0，否则两处相乘会得到错误电平。

## 5. `draft_meta_info.json`

```json
{
  "draft_id": "3F2A9C0D4B6E48A19F7C2D5E8B1A4C60",
  "draft_name": "ep07_v03",
  "draft_fold_path": "C:/Users/me/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft/ep07_v03",
  "tm_duration": 192000000,
  "tm_draft_create": 1765203775977,
  "tm_draft_modified": 1765203775977,
  "draft_timeline_materials_size_": 73400320,
  "draft_materials": [
    {"type": 0, "value": [
      {"duration": 25000000, "height": 1920, "id": "5B6C7D8E9F00112233445566778899AA",
       "md5": "9f2c1b7a4e6d8031c5b9a7f2e4d6c8b0", "metetype": "video", "type": 0,
       "width": 1080, "create_time": 1765203775, "extra_info": "orig.mp4",
       "file_Path": "./Resources/local/video/orig.mp4", "import_time": 1765203775,
       "import_time_ms": 1765203775977, "item_source": 1,
       "roughcut_time_range": {"duration": 25000000, "start": 0},
       "sub_time_range": {"duration": -1, "start": -1}}
    ]},
    {"type": 1, "value": []},
    {"type": 2, "value": []},
    {"type": 3, "value": []},
    {"type": 6, "value": []},
    {"type": 7, "value": []},
    {"type": 8, "value": []}
  ]
}
```

- `draft_materials` 的 `type: 0` 是素材索引，`1/2/3/6/7/8` 保留空数组。
- `metetype` 取 `video`／`music`／`photo`；与 `materials` 里 `type` 不是同一套枚举。
- `file_Path` 以 `./Resources/` 开头；`draft_fold_path` 用正斜杠绝对路径。

## 6. 校验命令

```bash
# JSON 语法
python -m json.tool draft_content.json > $null
python -m json.tool draft_meta_info.json > $null

# PowerShell 版
Get-Content -Raw draft_content.json | ConvertFrom-Json | Out-Null
```

结构自检（逐条过）：

- [ ] `version` 为 `360000`，`new_version` 为字符串。
- [ ] `duration` 与 `draft_meta_info.tm_duration` 一致，单位为微秒。
- [ ] `canvas_config.width/height` 与视频素材的主流分辨率匹配。
- [ ] `materials` 含 46 个键，`audios`／`videos`／`texts` 里每个 `id` 唯一。
- [ ] 每个片段 `material_id` 都能在 `materials` 里找到。
- [ ] 同一轨道内片段按 `target_timerange.start` 升序且不重叠。
- [ ] 所有片段 `target_timerange.start + duration ≤ duration`。
- [ ] 字幕 `content` 能被再次 `json.loads`，`styles[].range[1]` 等于文本 UTF-16 码元数。
- [ ] 每个 `path` 以占位符或 `./Resources/` 开头，且对应文件存在。
- [ ] 设备指纹字段为空。

## 7. 版本兼容

| 剪映版本 | 协议 `version` | `new_version` | 处理 |
| --- | --- | --- | --- |
| 5.9.x | 360000 | 111.0.0 | 用本文件模板 |
| 6.x 及以上 | 以本机空草稿为准 | 以本机为准 | 新建空草稿导出 JSON 当模板，字段结构可能新增 |

- 剪映升级后第一次导出，先做一份 3 段素材、1 条字幕的最小草稿验证，再批量生成。
- 不要混用不同版本的模板与 `draft_meta_info`；两个文件的 `app_version` 必须同源。

## 8. 打包后的自检

```bash
# 目录结构
Get-ChildItem -Recurse <草稿目录> | Select-Object FullName, Length

# 素材数量应与 draft_meta_info 的 type=0 条目数一致
(Get-Content -Raw draft_meta_info.json | ConvertFrom-Json).draft_materials[0].value.Count

# 总大小应与 draft_timeline_materials_size_ 接近（允许差异 < 1 MB）
```

最后一步只能人工做：在剪映里打开草稿，逐轨看片段是否在预期位置、字幕是否可编辑、导出一次与 ffmpeg 成片比对时长与音画同步。

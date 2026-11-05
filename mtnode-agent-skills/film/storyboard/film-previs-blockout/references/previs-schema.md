# 预演数据结构与校验

正文 `film-previs-blockout` 引用本文件。

## 一、`previs-compiler/1.0` 字段字典

| 层级 | 字段 | 必填 | 说明 |
| --- | --- | --- | --- |
| 顶层 | `schema_version` | 是 | 固定 `previs-compiler/1.0` |
| `meta` | `title` / `purpose` | 是 | `purpose` 固定 `camera_and_blocking_previs` |
| `meta` | `prediction_claim` | 是 | 恒为 `false`：不预测模型像素 |
| `meta` | `execution_backend` | 打斗时 | `rigged_joint_solver_v1` |
| `playback` | `fps` / `resolution` / `aspect_ratio` | 是 | 默认 24 / `[960,540]` / `16:9` |
| `playback` | `duration_s` / `duration_origin` | 是 | 来源标 `explicit` 或 `deterministic_default` |
| `compile` | `status` | 是 | `ready` / `ready_with_defaults` / `blocked` |
| `compile` | `assumptions[]` | 有默认值时 | 每项 `{field, value, source, prediction_claim}` |
| `compile` | `unresolved[]` / `warnings[]` | 否 | 会影响镜头职责的歧义必须进 `unresolved` |
| `scene` | `units` | 是 | 固定 `meter` |
| `scene` | `geometry[]` | 是 | `grid_plane` 或 `box`；`box` 用 `center` + `size` |
| `cast[]` | `id` / `rig` / `height` / `tone` | 是 | `rig`: `humanoid` / `humanoid_mecha` / `two-arm-hover` |
| `cast[]` | `keyframes[]` | 是 | `{time_s, position, facing, action}` |
| `cast[]` | `weapon` | 否 | `{type:"sword", length:3.6}`；只作方向与接触点代理 |
| `camera` | `sensor_width_mm` | 是 | 默认 36（全画幅水平） |
| `camera` | `rigs[]` | 是 | 每个机位含 `id` / `shot_id` / `keyframes[]` |
| `timeline` | `shots[]` | 是 | `{id, label, start_s, end_s, camera}` |
| `timeline` | `cuts[]` | 是 | 切点时间，必须对齐整帧 |
| `validation_targets` | `duration_tolerance_frames` | 是 | 默认 1 帧 |
| `validation_targets` | `require_decodable_mp4` | 是 | `true` |
| `validation_targets` | `require_visible_camera_motion_when_requested` | 是 | `true` |

`action` 允许值（普通后端）：`idle`、`walk`、`run`、`turn`、`sit`、`reach`；打戏压力测试另有：`dash`、`guard`、`slash`、`slash_hold`、`block`、`thrust`、`recoil`（`slash_hold` 用于碰撞停帧期间保持劈砍终点）。

`facing`：`0°` 面向 `+Y`，`90°` 面向 `+X`。

## 二、`previs-action/1.0`（仅动作密集段落）

```json
{
  "meta": { "execution_backend": "rigged_joint_solver_v1" },
  "action_program": {
    "schema_version": "previs-action/1.0",
    "backend": "baked_joint_ik",
    "profile": "implemented_action_profile",
    "contact_frame": 29,
    "hold_frames": 6,
    "constraints": {
      "weapon_grips": ["primary_hand", "secondary_hand"],
      "weapon_contact_socket": "weapon_impact_face",
      "defense_contact_sockets": ["defender_contact_a", "defender_contact_b"],
      "single_shared_contact": true,
      "no_root_only_fight": true
    },
    "beats": [
      { "id": "anticipation", "start_frame": 1,  "end_frame": 12 },
      { "id": "attack",       "start_frame": 13, "end_frame": 28 },
      { "id": "contact_hold", "start_frame": 29, "end_frame": 34 },
      { "id": "recoil",       "start_frame": 35, "end_frame": 67 }
    ]
  }
}
```

- 动作节拍必须从第 1 帧连续覆盖到末帧；握点、接触参与方、唯一共享接触不可省略。
- 校验器在 `require_attack_block_contact_recoil_readability=true` 时，必须拒绝没有动作扩展的旧体块规格。
- 失败判据（任一条即不通过）：武器在接触帧不在攻击方向前方；武器与防守肢体没有实际相遇、只靠碰撞球；部件绕自身中心旋转、形不成关节剪影；接触前后只有根节点位移；独立观看者只能说「方块靠近/穿插/分开」。

## 三、默认值 → 关键帧的换算

| 提示词写法 | 换算 | 例（初始机距 7 m） |
| --- | --- | --- |
| 「推进」无距离 | 前移初始机距 15% | `position.y` −7 → −5.95，`lens_mm` 不变 |
| 「横移」无距离 | 横移初始机距 25% | `position.x` 0 → +1.75 |
| 「环绕」无角度 | 20° | 绕 `look_at` 转 20°，同时保持机距 |
| 「升高/下降」无距离 | 主体高度 50% | 主体 1.65 m → `z` ±0.825 |
| 「跟拍」 | 保持开始时的相对偏移 | 机位 = 主体位置 + 初始偏移（逐帧） |
| 「缓慢」 | `easing: "smooth"` | — |
| 「匀速」 | `easing: "linear"` | — |
| 未写运动 | 静止（单关键帧） | 不要加漂移 |

机位高度的百分比口径：普通机位 = 主体高度 75%，低机位 = 25%，高机位 = 150%。例：1.65 m 的人，普通机位 `z ≈ 1.24`。

## 四、Slate `storyboard.json` 字段（方案 B）

| 层级 | 字段 | 说明 |
| --- | --- | --- |
| 顶层 | `project` / `w` / `h` / `fps` | 默认 `960` / `540` / `24` |
| 顶层 | `set` | 环境与道具（`type:"tatami"`、`table:{x,z,w,d,h,dishes}`） |
| 顶层 | `actors{}` | 键为 ID：`name`、`pos:[x,z]`、`shirt:[r,g,b]`、`style:"seated"|"stand"` |
| 顶层 | `shots[]` | 每镜一条，见下 |
| 镜 | `id` / `dur` | 镜号与秒数 |
| 镜 | `cam` | `wide` / `near` / `two` / `cu` / `ots` |
| 镜 | `fov` | 视场角（度），与 `cam` 配合 |
| 镜 | `line` / `speaker` | 单句台词与说话人（渲染为【角色名】台词） |
| 镜 | `lines[]` | 长镜头多句：`{at, dur, speaker, line}`，按镜内秒出现 |
| 镜 | `move` | 顶部条显示的运镜文字 |
| 镜 | `action` / `prompt` | 动作提示与 AI 提示词槽位 |
| 镜 | `pos` / `look` | 显式世界坐标，优先于自动机位（1:1 复刻） |
| 镜 | `staging` | `{角色ID:[x,z]}`，仅本镜临时站位 |
| 镜 | `table` | 本镜临时道具覆盖 |
| 镜 | `pose` | `{角色ID: seated|stand|ride}`，逐镜姿态覆盖 |
| 镜 | `serve` | 执行盛饭/伸手动作的角色 ID |
| 镜 | `scene` | `room` / `field`（场景切换） |
| 镜 | `performance` | 表演层：`{status, packet, input_hash, attempts, warnings[]}`，`packet.shot_id` 必须等于镜 `id` |

运镜参数（按镜内进度插值）：`dolly:"in"|"out"`、`pan:度数`、`whip:1`、`truck:米`、`orbit:度数`、`crane:米`、`zoom:倍率`。

`cam` 语义档的自动机位：

| 档 | 机位规则 | 附加字段 |
| --- | --- | --- |
| `wide` | 桌侧后退看人物中点 | — |
| `near` | 某角色身后看桌，前景背影最大 | `focus`，可选 `serve` |
| `two` | 双人中景 | `host`、`target` |
| `cu` | 单人特写 | `target` |
| `ots` | 越肩反打，正反打自动成立 | `host`（前景肩）、`target`（后景） |

表演层约束：`beats[]` 只允许可见表演字段（`at, duration, intent, posture, gaze, gesture, expression, voice`），每个 beat 必须完整落在 `dur` 内；`status` 不是 `ready` 的草稿不得进入图生视频；`input_hash` 用于判断分镜改动后是否过期。

## 五、校验与渲染命令

```bash
# 1. 编译校验（时间重叠、空档、缺摄影机、人物引用、不可执行歧义）
python scripts/validate_compiled_previs.py previs_compiled.json

# 2. 普通走位 + 机位
python scripts/run_blender_previs.py --runtime-dir <dir> --blender <path> previs_compiled.json

# 3. 关节动作（仅打斗规格）
python scripts/run_blender_rigged_fight.py --runtime-dir <dir> --blender <path> previs_compiled.json

# 4. 实际解码核对
ffprobe -v quiet -print_format json -show_format -show_streams previs.mp4
```

Slate 侧校验：

```bash
python scripts/validate_dialogue.py storyboard.json    # 对白白模
python scripts/validate_storyboard.py storyboard.json  # 走位/动作白模（含 path、pitch）
```

## 六、依赖定位顺序

| 依赖 | 顺序 | 纪律 |
| --- | --- | --- |
| Blender | `--blender` → `WHITEBOX_BLENDER` → `PATH` → `_runtime/blender-*-windows-x64/blender.exe` | 指定路径无效时直接报错，不暗换版本 |
| FFmpeg | `--ffmpeg` → `WHITEBOX_FFMPEG` → `PATH` | 找不到就报未完成 |
| FFprobe | `--ffprobe` → `WHITEBOX_FFPROBE` → `PATH` → FFmpeg 同目录 | — |
| 运行时目录 | 必须显式 `--runtime-dir` | 结构/后端/依赖检查失败时不创建运行缓存 |

## 七、白模帧的两种输出

| 用途 | 画面 | 说明 |
| --- | --- | --- |
| 给人看 | 带 HUD：顶部镜号+运镜、右上动作+提示词、底部台词 | 方便对稿 |
| 给模型看 | **干净帧**：无任何叠加文字 | 图生视频的参考帧必须用这一份，HUD 是污染 |

导出包建议：每镜一份 `clean_<shotid>.png` + 一份 `prompt.txt`（只留表演意图，剥离已由画面表达的机位与景别）。

## 八、2D 与 3D 引擎怎么选

| 需求 | 选 2D 对话白模 | 选 3D 白模 |
| --- | --- | --- |
| 对话、室内对峙、采访、围坐 | 是（秒级迭代） | 可，但更慢 |
| 需要真实视差、绕行、穿越、俯冲 | 否 | 是 |
| 大场面环境即主体（城市飞跃、爆炸） | 否 | 否，改 AI 关键帧概念图 |
| 需要验证接触点（打斗、抓取） | 否 | 是（关节后端 + 动作门） |
| 只改台词与镜头顺序 | 是 | 否 |

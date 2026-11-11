---
name: film-storyboard-prompt
title: 分镜图提示词：九槽位与负面清单
description: 把分镜行写成能直接出图的关键帧提示词：按九槽位固定顺序排构图与光位，用身份锚点锁角色一致性，分层写负面清单，并给中英对照的完整示例。要做分镜图、首尾帧、角色设定图，或图老是换脸、长乱字时用。
tags: 分镜图, 关键帧提示词, 身份一致性, 光位, 负面清单, 中英对照
version: 1.0.0
---

# 分镜图提示词：九槽位与负面清单

## 何时用

- 要把分镜表的一行变成一张能出图的关键帧（首帧 / 尾帧 / 分镜格）。
- 出图总在换脸、换服装、换房间，需要一套把「什么不许变」写死的结构。
- 画面里的文字总长成乱码，或背景总多出一堆路人。
- 要写角色设定图（多视图）与状态变体（伤妆、湿发、换装），并且要求「换景不换脸」。
- 要把中文提示词给中文团队看、英文提示词投给模型，两版必须表达同一件事。
- 不适用：还在定景别与轴线（用 `film-shot-language`）；要写视频运动提示词（用 `film-shot-list-breakdown` 的 clip 边界 + 模型自带视频模板）；要出白模（用 `film-previs-blockout`）。

## 核心原则

1. **顺序不是排版，是控制面**。九槽位顺序固定：镜号 → 画幅 → 景别机位 → 主体 → 动作与终态 → 环境 → 光与色 → 材质与成像 → 约束。模型按前 20–30 个 token 定主体与构图，把身份与机位写在最前。
2. **身份锚点一字不改**。同一角色的锚点原文（年龄/脸型/发缝走向/瞳色/体态）在所有图里逐字复用；改一个字就换一个人。
3. **机位写成可见后果，不写测量值**。「85mm，距 1.5 m」要与「走廊被压成竖条、门框边缘笔直」一起出现，否则模型只当风格词。
4. **光位四件套齐全**：方向（相对钟点）+ 质感（硬/柔）+ 明暗比 + 色温。缺一项，模型就自己发明，而且每张都不一样。
5. **负面清单分三层**：通用层（水印、乱字、多肢）→ 场景层（本片真会犯的错）→ 镜头层（这一镜的真实风险）。三层合计 8–14 条，不要堆 50 条。
6. **画内文字零容忍**。要文字就留空位（`a blank nameplate, no lettering`）+ 后期贴，绝不要求模型生成。
7. **一张图只讲一个瞬间**。关键帧是「某一帧」，不是「一段动作」；写清这一帧的终态，运动交给视频提示词。
8. **先锁资产再写提示词**。角色/场景/道具未 `locked` 就出图，等于用最贵的方式做测试。

## 工作流

1. **取分镜行并确认资产门禁**。输入：分镜表一行。动作：列出该镜所有 `@tag@version`，逐个核对是否 `locked`；有 draft 就停下，先回资产环节。产出：资产清单（标签 + 版本 + 参考图路径）。
2. **定这一帧的角色**。输入：镜号。动作：标 `kf-first` / `kf-last` / `panel` / `sheet` / `plate`。产出：帧角色 + 文件名 `PROJ_SC07-04_v01_kf-first.png`。
3. **写九槽位**。输入：分镜行字段。动作：按模板 1 顺序填，每槽一行，槽内不换序。产出：结构化提示词草稿。
4. **压构图句**。输入：景别/机位/焦段。动作：写成「主体在画框哪一侧、占多少、头顶与视线余量、前景遮挡占几成」。产出：构图句 1–2 句。
5. **写光位四件套**。输入：分镜的 `光比/光位`。动作：方向用钟点（10 点方向主光）+ 质感 + 比例 + 色温（3200K 钨丝）。产出：光句 1 句。
6. **贴身份锚点**。输入：角色卡。动作：把锚点原文整段粘进「主体」槽，后面才写本图变体（湿发、伤妆、换装）。产出：主体槽（锚点 + 变体）。
7. **配负面清单**。输入：风险档。动作：通用 4–6 条 + 场景 2–3 条 + 本镜 2–4 条。产出：负面块。
8. **出中英双版**。输入：中文草稿。动作：英文版按同一槽位顺序重写（不是逐字直译），术语用词表里的英文。产出：中英对照两份。
9. **QC**。输入：出图结果。动作：按模板 5 六项核对：脸、服装、机位高度、光向、构图占比、有无乱字。产出：通过或修法（改哪一槽，不改哪一槽）。
10. **登记**。输入：通过图。动作：记 `seed`、参考图、锚点版本、提示词版本号。产出：资产登记行，供下一镜复用。

## 关键参数与模板

### 1. 九槽位顺序（照填，不要重排）

| # | 槽位 | 写什么 | 不许写 |
| ---: | --- | --- | --- |
| 1 | 镜号 / 帧角色 | `PROJ_SC07-04 / kf-first` | 只写「分镜图」 |
| 2 | 画幅与用途 | `16:9, storyboard keyframe` | 「电影感画幅」 |
| 3 | 景别 + 机位 + 焦段 | `MCU, camera at 1.55m eye level, 35° off axis on A side, 85mm, 1.2m from face` | 只写「特写」 |
| 4 | 主体（身份锚点 + 本图变体） | 锚点原文 + `wet hair, torn right shoulder` | 「帅气青年」 |
| 5 | 动作与终态（这一帧） | `right hand stops 5cm above the envelope` | 「正在犹豫」 |
| 6 | 环境（前/中/后三层） | 前景门框 25%、中景人、后景走廊压暗 | 「一个楼道」 |
| 7 | 光与色（四件套） | `key from 10 o'clock, hard, 6:1, 3200K tungsten; no fill` | 「氛围光」 |
| 8 | 材质与成像 | `35mm film grain, halation on highlights, no digital sharpening` | 「电影质感」 |
| 9 | 约束尾巴 | `same face, same coat, same room; only X changes` + 负面块 | 「保持一致性」 |

### 2. 机位词（写进第 3 槽，中英并置）

| 中文 | English | 何时用 |
| --- | --- | --- |
| 眼平 | eye level | 中性、平等 |
| 胸高 | chest height | 略压、观察 |
| 腰高 | waist height | 环境参与、服装 |
| 膝高 / 地面 | knee height / ground level | 压迫、儿童与动物 |
| 眼上 30cm | slightly above eye level | 机构视角 |
| 俯拍 45° | 45° high angle | 被审判 |
| 俯拍 90° | top-down / overhead | 图案、命运 |
| 仰拍 15° / 30° | low angle 15° / 30° | 权威、威胁（超过 30° 变漫画） |
| 荷兰角 8° | 8° dutch tilt | 失衡（一片 ≤2 次） |
| 过肩 | over-the-shoulder, foreground shoulder soft | 对话张力 |
| 主观 | POV, hands entering frame | 代入 |
| 轴线 A 侧 35° | 35° off axis, A side | 保证反向镜能剪 |

### 3. 光位四件套

| 项 | 取值 | 写法 |
| --- | --- | --- |
| 方向 | 钟点法：12 点=正前，3 点=右，9 点=左，6 点=正后 | `key light from 10 o'clock` |
| 质感 | hard / soft / mixed | `hard key, unmodified` |
| 明暗比 | 2:1 柔 / 4:1 剧情 / 6:1 硬朗 / 8:1 黑色电影 | `6:1, no fill on the shadow side` |
| 色温 | 2700–3200K 钨丝 / 4300–5600K 日光 / 6500K+ 阴天 | `3200K tungsten, 5600K window as rim` |

常用组合：

| 场景 | 组合 |
| --- | --- |
| 门缝窥视 | 主光 10 点硬光 6:1 + 门缝漏光当轮廓 + 无补光 |
| 双人对峙 | 侧逆 45° 硬光 4:1，两人各有一个亮边，中间暗 |
| 黄金时刻外景 | 低角度逆光 + 薄雾 + 发梢金边 + 阴影抬 1 档 |
| 夜晚霓虹 | 招牌当主光（绿/品红）+ 无补光 + 湿地面反射 |
| 审讯 | 顶光 12 点偏前 + 眼窝阴影 + 背景压成单色 |

### 4. 身份锚点六段（角色设定图 / 状态变体）

```text
① 主体与身份锚点（不可变）：28 岁，东亚女性，鹅蛋脸，下颌线柔，发缝偏左 1/3，
   黑色直发至锁骨，瞳色深棕近黑，身高 165cm，体态偏薄，右眉尾有一道 1cm 浅疤。
② 当前变体：湿发贴额，米色风衣袖口有雨水痕，右手提一只磨旧的牛皮纸袋。
③ 构图与视角：正面 / 侧面 / 四分之三 / 背面 / 全身，五视图等距排列，纯白背景，
   机位 1.55m 眼平，85mm。
④ 光色与材质：主光 10 点柔光 3:1，5600K，皮肤保留毛孔与细汗，布料有真实褶皱。
⑤ 背景边界：纯白无缝背景，无地平线，无陈设。
⑥ 禁止项：换发型、改服装颜色、多配饰、文字水印、美颜磨皮、塑料感皮肤。
```

锚点 ① 与 ⑥ 必须逐字复用；只有 ② 允许改。

### 5. 三个完整示例（中英对照，可直接投喂）

**示例 A｜单人门缝（CU，侧逆硬光）**

```text
【中】
PROJ_SC07-04 / kf-first。16:9 分镜关键帧。
近景（CU），机位 1.55m 眼平，轴线 A 侧 35°，85mm，距脸 1.2m。
主体：28 岁东亚女性，鹅蛋脸，发缝偏左 1/3，黑色直发至锁骨，瞳色深棕近黑，
右眉尾 1cm 浅疤（锚点原文不改）；此刻左眼贴近门缝，湿发贴额。
动作终态：右手停在信封上方 5cm，未触碰；肩膀抬起 2cm，屏住呼吸。
环境：前景门框占画面左侧 25% 并轻微失焦；中景是她的侧脸；后景走廊压成一条暗竖带，无尽头细节。
光：主光来自 10 点方向硬光，明暗比 6:1，3200K 钨丝；门缝漏光在她颧骨上形成一条亮边，暗面不补光。
材质：35mm 胶片颗粒，高光有轻微光晕，无数码锐化。
约束：同一张脸、同一件米色风衣、同一扇门；只有眼睛位置与手的悬停高度变化。
负面：换脸、换发型、多余手指、门缝里出现人形、画面文字、水印、过曝窗光、塑料皮肤、卡通感。

【EN】
PROJ_SC07-04 / kf-first. 16:9 storyboard keyframe.
Close-up, camera at 1.55 m eye level, 35° off axis on the A side, 85 mm, 1.2 m from her face.
Subject: 28-year-old East Asian woman, oval face, hair parted one third to the left, black
shoulder-length straight hair, near-black brown eyes, a 1 cm pale scar at the right brow tail
(anchor copied verbatim); now her left eye is pressed to the door gap, wet hair on her forehead.
End state: her right hand stops 5 cm above the envelope, not touching; shoulders lifted 2 cm, breath held.
Environment: foreground door frame occupies 25% of frame left, slightly soft; midground her profile;
background corridor compressed into one dark vertical band with no readable depth.
Light: hard key from 10 o'clock, 6:1 ratio, 3200 K tungsten; light leaking through the gap draws a
bright edge on her cheekbone; no fill on the shadow side.
Texture: 35 mm film grain, slight halation on highlights, no digital sharpening.
Constraints: same face, same beige trench coat, same door; only the eye position and hover height change.
Negative: changed face, different hairstyle, extra fingers, a figure inside the gap, text, watermark,
blown-out window light, plastic skin, cartoon look.
```

**示例 B｜双人过肩对峙（OTS，侧逆 4:1）**

```text
【中】
PROJ_SC12-06 / kf-first。16:9 分镜关键帧。
过肩中近景（OTS MCU），机位 1.5m，轴线 A–B 的 A 侧，35mm，距前景肩 0.6m、距后景人物 2.2m。
主体：前景是男人 A 的右肩与后颈（占画面左下 30%，柔焦）；后景是女人 B 的正面，
锚点原文不改（32 岁，方脸，短发齐耳，左眉有断口，戴细框眼镜）。
动作终态：B 的手停在桌面文件上，指尖压住纸角；A 的肩膀前倾 5cm 挡住她半张脸。
环境：会议室，后景玻璃隔断外走廊灯亮成一条水平线；桌面只有一份文件和一杯未动的水。
光：B 的主光来自 10 点侧逆硬光 4:1，5600K 日光；A 的肩只吃到轮廓光；背景压暗 1.5 档。
材质：数字 Alexa 质感，肤色不过度磨皮，镜片有轻微反光但不遮眼。
约束：A 只出现肩与后颈，不露脸；B 的眼镜与眉形不变；桌面只有两件物品。
负面：A 露脸、B 换眼镜、多余杯子、屏幕上的文字、水印、双人对称摆拍、平光。

【EN】
PROJ_SC12-06 / kf-first. 16:9 storyboard keyframe.
Over-the-shoulder medium close-up, camera at 1.5 m, A side of the A–B axis, 35 mm,
0.6 m behind the foreground shoulder, 2.2 m from the facing actor.
Subject: foreground is man A's right shoulder and nape, 30% of frame bottom-left, softly out of focus;
background is woman B facing camera, anchor verbatim (32, square face, ear-length dark hair,
a notch in her left eyebrow, thin-rimmed glasses).
End state: B's hand rests on the document, fingertip pinning the corner; A's shoulder leans 5 cm in,
covering half her face.
Environment: meeting room; beyond the glass partition a corridor light reads as one horizontal line;
only a document and an untouched glass of water on the table.
Light: B's key is a hard 10 o'clock side-back light, 4:1, 5600 K daylight; A's shoulder catches only
a rim; background 1.5 stops down.
Texture: digital large-format look, skin not retouched, faint reflection on the lenses without hiding the eyes.
Constraints: A shows only shoulder and nape, never the face; B's glasses and brow shape unchanged;
exactly two objects on the table.
Negative: A's face visible, different glasses, extra cups, screen text, watermark, symmetrical two-shot,
flat frontal lighting.
```

**示例 C｜静物插入 + 环境建场（两条可同批出）**

```text
【中·插入】
PROJ_SC07-05 / panel。16:9 分镜格。
大特写（ECU），机位 0.35m 贴近地面，俯 25°，100mm 微距，距信封 0.25m。
主体：牛皮纸信封的一角压在门槛下，纸边起毛，封口胶带有一道指纹。
动作终态：一枚硬币从信封下滑出 1cm，停在门槛金属压条上。
环境：前景地毯纤维清晰可数；后景全部虚化成米色。
光：单一 10 点硬光 8:1，3200K，硬币边缘一道锐利高光；无补光。
材质：微距下的纸纤维与金属划痕，胶片颗粒。
约束：信封无字、无邮票、无地址；只有硬币位置变化。
负面：信封上出现文字、邮票、手指入画、塑料质感、过曝高光、水印。

【EN】
PROJ_SC07-05 / panel. 16:9 storyboard panel.
Extreme close-up, camera 0.35 m above the floor, 25° downward, 100 mm macro, 0.25 m from the envelope.
Subject: one corner of a kraft envelope pinned under the door, frayed edge, a fingerprint in the tape.
End state: a coin has slid 1 cm out from under it and stopped on the metal threshold strip.
Environment: carpet fibres countable in the foreground; everything behind falls into beige blur.
Light: single hard key from 10 o'clock, 8:1, 3200 K; one sharp specular line on the coin rim; no fill.
Texture: paper fibre and metal scratches at macro scale, film grain.
Constraints: no writing, no stamp, no address on the envelope; only the coin position changes.
Negative: lettering on the envelope, stamp, fingers entering frame, plastic look, blown highlights, watermark.

【中·建场】
PROJ_SC07-01 / kf-first。16:9 分镜关键帧。
超远景（EWS），机位 2.2m，俯 12°，24mm，距楼体 14m。
主体：一栋六层旧公寓，三层走廊灯亮着，唯一亮窗在画面右下三分之一；人在画面里高约 1/40。
环境：前景梧桐枝占上方 15% 并轻微失焦；中景楼体；后景城市天际线压成灰蓝剪影。
光：黄昏后 20 分钟，天空 6500K 冷蓝，走廊灯 2700K 钨丝暖黄；明暗比 4:1；薄雾。
材质：35mm 颗粒，暗部保留细节，高光不过曝。
约束：只有一扇窗亮灯；楼体无招牌、无空调外机文字。
负面：多扇窗亮灯、霓虹招牌、文字、水印、航拍畸变、过度锐化、白天光线。

【EN】
PROJ_SC07-01 / kf-first. 16:9 storyboard keyframe.
Extreme wide shot, camera at 2.2 m, 12° downward, 24 mm, 14 m from the building.
Subject: a six-storey old apartment block, third-floor corridor lights on, the single lit window in the
lower-right third; a figure about 1/40 of frame height.
Environment: foreground plane-tree branches occupy the top 15%, slightly soft; midground the facade;
background skyline flattened into a grey-blue silhouette.
Light: 20 minutes after sunset, 6500 K cold sky against 2700 K tungsten corridor lamps, 4:1, light haze.
Texture: 35 mm grain, shadow detail retained, highlights unclipped.
Constraints: exactly one lit window; no signage, no lettering on the AC units.
Negative: many lit windows, neon signs, text, watermark, drone distortion, over-sharpening, daylight.
```

### 6. QC 六项（每张图都跑；负面词表、一致性十条与失败诊断见 `references/negative-and-consistency.md`）

| 项 | 通过标准 | 不过关先改哪一槽 |
| --- | --- | --- |
| 脸 | 与锚点同一个人（眉、眼距、下颌） | 第 4 槽锚点是否被改写；参考图权重 |
| 服装/道具 | 版本与状态对得上 | 第 4/5 槽 |
| 机位高度 | 与写的 cm 一致（看地平线与桌面切点） | 第 3 槽；补「可见后果」 |
| 光向 | 影子方向与钟点一致 | 第 7 槽；明暗比是否被补光破坏 |
| 构图占比 | 前景遮挡占比误差 ≤10% | 第 6 槽 |
| 乱字 | 画面内零文字 | 负面层 + 留空位描述 |

## 常见坑

- **每张脸都不一样**：症状是同一角色在三张图里像三个人。原因：每张都重写描述，或把锚点「优化」了。修法：锚点原文整段复制，只改变体段；同批图共用同一参考图与 `seed`。
- **写了 85mm 却拍出大鼻子**：症状是透视像广角。原因：只写焦段没写机距与透视证据。修法：焦段 + 距离 + 「走廊被压成竖条」三件一起写。
- **背景多出一堆人**：症状是空楼道里站着三个人。原因：只写「楼道」。修法：环境槽写「无人，只有一扇关着的门与一盏灯」，并在负面层加 `extra people`。
- **文字全是乱码**：症状是门牌上出现象形乱码。原因：要求模型生成文字。修法：`blank nameplate, no lettering` + 后期贴；负面层加 `text, lettering, signage`。
- **光每张都不同**：症状是同一场戏光向乱跳。原因：光只写「柔和侧光」。修法：钟点 + 质感 + 比例 + 色温四件套，写进每张图，一字不改。
- **越修越远**：症状是改了三版还不如第一版。原因：在失败图上继续改。修法：回到已批准的基准图，重写完整提示词；失败图只做诊断，不作为输入。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| wuwangzhang1216/DirectorSKILL | 311 | MIT | `assets/keyframe-prompt-template.md` 的九槽位顺序与「槽位不许重排」的理由、约束尾巴、QC 清单；上游 `image-model-adapters.md` 的模型控制面与一致性工具；`lighting-and-color.md` 的光位与明暗比口径 |
| coracoo/Slate | 51 | MIT | `workbench/skills/image-style/identity-anchor.md` 的身份锚点六段式（「换景不换脸」）；`directing/wes-symmetry.md` 等风格卡的「写明居中对称与主色」写法；`image-style/cinematic-real.md` 的写实成像口径 |
| Rylaispirit/cinematic-video-prompt-skill | 174 | MIT | 上游 `02-lighting.md` 的自然光/时间/光位英文词表，`03-composition.md` 的构图词，`06-materials-weather-pose.md` 的材质与天气描述 |
| jijiutong/ai-visual-director | 180 | MIT | 全局负面清单（`no watermark, no logo, no random large text, no garbled Chinese, no broken faces, no duplicated limbs …`）与「提示词 QC 后才算执行包」的门禁 |
| machina-exm/film-studio-skills | 169 | 无许可证 | `asset-passport` 的资产护照（描述词 + 参考图 + 版本）与「未 locked 不出图」门禁；`shot-prompt` 的版本化提示词与 `selects/` 归档习惯 |

- 抓取日期：2026-11-04
- 合并的上游技能：`cinematic-director`（keyframe-prompt-template、image-model-adapters、lighting-and-color）、Slate `image-style/identity-anchor` 与 `directing/*`、`cinematic-video-prompt-skill`（lighting、composition、materials）、`ai-visual-director`（negative-prompt）、`asset-passport` / `shot-prompt`
- 冲突与取舍：提示词结构两套——方案 A 九槽位（镜号→…→约束尾巴，适合关键帧与分镜格，能逐槽 QC）；方案 B 身份锚点六段式（主体锚点→变体→构图→光色→背景→禁止项，适合角色设定图与状态变体）。两者的差别在「先锁人还是先锁镜头」：A 先锁镜头，B 先锁人。正文并存，规则是——**分镜关键帧用 A 打底、把 B 的第①⑥段整段塞进 A 的第 4 槽**；角色设定图直接用 B。另一处冲突是负面词数量：jijiutong 的全局负面清单有 13 条且要求「按需合并」，DirectorSKILL 主张「只列本镜真实风险 3–6 条」；正文取分层法（通用 4–6 + 场景 2–3 + 本镜 2–4，合计 8–14），既保留全局兜底，也不让负面词淹掉主体描述。

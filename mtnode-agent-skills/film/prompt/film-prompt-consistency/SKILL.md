---
name: film-prompt-consistency
title: 跨镜头一致性提示词
description: 让角色、场景、风格在多个镜头与多段续写里不漂：三类锁定策略、omni-reference 与多图参考的角色映射、continuation 续写写法，并给可逐条打勾的一致性检查清单。
tags: 一致性,角色锁定,参考图,omni-reference,续写,场景复现
version: 1.0.0
---

# 跨镜头一致性提示词

一致性不是「多贴几张图」，而是**三类锁各用一套机制**：角色靠逐字复用的身份块 + 单张身份参考；场景靠空间拓扑描述 + 场景板；风格靠一段全局声明。三者混在一句长描述里，必然漂。

## 何时用

- 同一角色要出现在 2 个以上镜头 / 2 段以上视频里。
- 同一场景要在不同时间、不同机位反复出现。
- 要做连续剧集、系列短片、多段续写（`继续`、`接着往下写`、`下一镜`）。
- 一次要给 5 张以上参考图/视频/音频，需要说清「哪张锁什么、不继承什么」。
- 交付前要跑一致性验收。
- 不适用：单镜头一次性出片；只写首帧图像提示词；成片已出后的崩坏诊断（见 `film-prompt-qc`）。

## 核心原则

1. **一个必须保持的元素，配一张参考。** 脸、服装、道具、地点、风格各一张。50 项参考是上限不是目标；参考集里互相竞争的脸会把身份拉平。
2. **身份块逐字复用。** 同一角色的固定描述（脸型、发型、标志性细节）写成一段，之后每个镜头**一字不改**地贴进去。改写措辞等于扩大采样范围。
3. **参考要写「锁什么」和「不继承什么」。** `图片1锁定女主身份与服装；图片2锁定走廊布局。视频1只参考闪避步法与动作衔接，不继承人物、场景和声音。`
4. **编号映射全程不变。** 图片 1 永远是女主，图片 2 永远是走廊。中途换号，模型会换人。
5. **不在场的 `@tag` 不要写。** 参考里出现了但这一镜不该有的对象，写进排除句；否则模型会把它塞进画面。
6. **场景锁写拓扑，不写形容词。** 「同一个客厅」没用；写「门在画面左后方、沙发背对窗、窗在右墙、地面是深色木地板」。
7. **风格只声明一次，放在最上面。** 一条 `GLOBAL STYLE` + 胶片/色彩响应，之后每镜不再重复；重复会让每镜各自解释一遍。
8. **续写从故事状态接，不一定从尾帧接。** 尾帧接续（last-frame anchor）适合动作未完成；换景别/换机位时从故事状态接更自然，硬贴尾帧反而被复制构图。
9. **可见事实即使参考里有，也要写进文字。** 小字、logo、指定色值，模型会丢。
10. **状态变化要显式登记。** 谁受伤了、衣服湿了、道具换手了——写进「本段状态」表，否则下一个镜头会回到初始状态。

## 工作流

1. **建资产清单（输入：剧本/分镜）** → 输出表格：`ID | 类型 | 锁什么 | 参考文件 | 版本`。ID 用 `char_lin_v1`、`loc_office_v2` 这种带版本的命名。
2. **写身份块** → 每个主要角色一段（年龄/体型/脸/发/辨识细节/服装构造/配饰），存成可复制文本。**这段文本从此冻结**，只允许在造型变化时升版本。
3. **写场景块** → 每个复现场景一段：空间拓扑（门/窗/家具相对位置）+ 光源与 K 值 + 材质 + 尺度参照。
4. **写风格块** → 一段 `GLOBAL STYLE`：类型、色彩、胶片或数码质感、画幅、快门行为，以及「必须不出现」的东西。
5. **排参考映射（分支）** →
   - 少参考（≤3）：Seedance 2.0 的 `[reference_image: name]` + `[identity_lock]`，或 `@Image1 as the main character`。
   - 多参考（≥4，含视频/音频）：Seedance 2.5 `omni_reference`，写角色映射句 + 排除句。
   - 图像编辑/换装：FLUX.2 的 `Image 1..n`，每张编号分配角色（face/pose/style/environment）。
6. **写镜头正文** → 每镜只写**变化**：动作、机位、新信息。身份/场景/风格块整段复用或直接省略（有参考图时）。
7. **写续写（分支）** → 按第 4 节三种桥接选一种：换景别（同一戏剧动作）、match-on-action（动作未完成）、新 15s 镜头组（上一段弧已闭合）。
8. **跑检查清单** → 第 4 节清单逐条打勾；任何一条不过，先修提示词再生成。
9. **交付** → 附两行：`本段锁定：char_A 身份 + loc_office 拓扑 + GLOBAL STYLE` / `本段允许变化：服装湿度、道具位置`。

## 关键参数与模板

资产登记表、跨镜对照表与序列失败图谱见 `references/consistency-checklists.md`；可直接粘贴的中英文锁定语句见 `references/lock-phrase-library.md`。

### 三类锁的分工

| 锁什么 | 载体 | 写法 | 失效症状 |
| --- | --- | --- | --- |
| 角色身份 | 单张清晰身份图 + 逐字身份块 | `@Image1 as the main character. [身份块原文]` | 第 3–4 个切点后脸变成「通用脸」 |
| 服装/造型 | 单独一张服装参考（可与身份图分开） | `Do not alter clothing category or primary color` | 颜色对但版型变（长风衣变短夹克） |
| 场景 | 场景板（`no people`）+ 拓扑描述 | `@Image2 as the environment` + 门窗家具相对位置 | 房间布局每镜不同、光源方向乱跳 |
| 道具 | 道具特写图 | `@Image3 as the prop` + `same geometry and material` | 武器/产品每镜换造型 |
| 风格 | 一段 `GLOBAL STYLE` 文本 | 类型 + 色彩 + 胶片响应 + 禁用项 | 前段写实后段塑料 CG |
| 动作/步法 | 视频参考 | `视频1只参考闪避步法与动作衔接` | 动作对了但人物服装被一起继承 |

### 身份块模板（冻结使用）

```
IDENTITY — char_lin_v1:
Chinese woman, 28, 165cm, slim build. Oval face, high cheekbones, single eyelid, small mole under
the left eye. Black hair, blunt shoulder-length cut, parted left. Wearing a charcoal wool overcoat
over a cream knit turtleneck, silver thin-frame glasses, no other jewelry.
```

复用规则：整段贴，不改词序、不加同义词、不省略。需要变化时新建版本（`char_lin_v2` 加「右颊擦伤」）。

### 参考映射模板（Seedance 2.5 `omni_reference`）

```
@Image1 as the main character — identity lock, verbatim descriptor below.
@Image2 as the environment — corridor layout only; do not import any people from it.
@Video1 as motion reference for the dodge step only; do not inherit its performers, costumes,
setting or sound.
@Audio1 as voice identity for the female lead only; the spoken lines come from this script,
not from the recording's music.
The camera follows this shot list, not the reference video's camera.
```

四种参考的权威边界（**只能给需要的维度**）：

| 参考 | 可以控制 | 不会自动带来 |
| --- | --- | --- |
| 图片 | 身份、服装、道具、空间、外观、边界状态 | 动作、声音、剧情 |
| 视频 | 动作、机位路径、节奏、场景、声音 | 人物身份、服装、配乐、台词 |
| 音频 | 音色、台词内容、语气/口音、环境声、音乐 | 台词文本（脚本优先）、画面 |

### 多图参考语法（按平台）

| 平台/模型 | 写法 |
| --- | --- |
| Seedance 2.0（Higgsfield） | `@Image1 as the main character` / `@Image2 as the environment` / `@Image3 as the prop`；或 `@material[角色图]` 引用已上传素材 |
| Seedance 2.0（API 括号式） | `[reference_image: hero.png]` + `[identity_lock]`，随后写身份锚点句 |
| Seedance 2.5 | 最多 30 图 / 10 视频 / 10 音频，含首尾帧总量 ≤50；用角色句 + 排除句 |
| FLUX.2 | `Image 1..n` 编号分配角色：`Image 1: face/identity; Image 2: pose; Image 3: style; Image 4: environment` |
| Kling 3.0 | 参考图 + `start_image` / `end_image`；参考工作流要说明「哪些保持一致、哪些改变」 |

### 续写模板（continuation）

```
【接续判断】
上一段结尾状态：[人物位置 / 情绪 / 道具在谁手上 / 光与时间]
下一段情绪推进：[一句]
连续性注意：[服装湿度、伤口、道具损耗]

【本段锁定】
char_lin_v1 身份块；loc_corridor_v1 拓扑；GLOBAL STYLE 不变。

【本段允许变化】
外套已湿、右袖有灰；手上多了手电。

【下一段最终视频提示词】
[从上一段结束状态写起，只写新的运动与信息]
```

三种桥接方式（按上一段结尾形态选）：

| 上一段结尾 | 桥接方式 | 写法 |
| --- | --- | --- |
| 动作未完成（手还在伸、门半开） | match-on-action | 下一段从同一动作的中段开始，机位可换 |
| 一段小弧已闭合（她已坐下） | 换景别/换机位 | 同一戏剧动作换角度，不要复制尾帧构图 |
| 明确要接帧 | last-frame anchor | `Continuing from the prior clip — [尾帧所见]. [新动作].`，且尾帧要有可继续的运动余量 |

### 一致性检查清单

- [ ] 每个主要角色都有唯一 ID，身份块一字未改地出现在每个镜头
- [ ] 角色的参考图只有一张主身份图（多余的只作补充角度，不参与投票）
- [ ] 场景用拓扑描述，门窗家具位置在每镜一致
- [ ] 光的方向与 K 值跨镜一致，且与时间/天气自洽
- [ ] `GLOBAL STYLE` 只在开头出现一次，后续不重复改写
- [ ] 每个参考都写了「锁什么 + 不继承什么」
- [ ] 参考编号映射全程没有换号
- [ ] 不在场的对象都写了排除句
- [ ] 状态变化（伤、湿、脏、道具换手）已登记并在下一段出现
- [ ] 续写从上一段结束状态开始，没有把上一段整段重写一遍
- [ ] 台词文本以脚本为准，没有被音频参考的即兴内容替换

## 常见坑

- **症状：前两镜还是同一个人，第三镜开始换脸。** 原因：身份块被改写/省略，或参考图太多互相竞争。修法：身份块逐字复用；把补充角度图撤掉，只留一张主身份图；在切点前后各补一句 `same character, no face morph`。
- **症状：房间每次都不一样，窗户跑到另一边。** 原因：只写了「同一个客厅」。修法：写拓扑（门在后左、窗在右墙、沙发背窗），并配一张 `no people` 的场景板。
- **症状：人物对了，但衣服颜色每镜变。** 原因：身份块里没写服装色值，或服装参考和身份参考互相冲突。修法：服装单独一张参考 + 写 `Do not alter clothing category or primary color`；必要时给 hex。
- **症状：用了动作参考视频，结果人物、服装、场景全被继承。** 原因：没写排除句。修法：`only the dodge step and the action continuity; do not inherit performers, costumes, setting or sound.`
- **症状：续写第二段像重拍第一段。** 原因：把上一段整段描述复制过来，或死贴尾帧。修法：只写「上一段结束状态 + 新动作」；换景别接续时不要复制尾帧构图。
- **症状：参考图里有个不该出现的道具，生成时它总在画面里。** 原因：参考图在场但没写排除。修法：明确 `the set contains only what @Image2 shows, excluding [对象]`，或直接裁掉该区域再当参考。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| jnMetaCode/ai-shortfilm-prompts | 515 | MIT | 「五官百分百还原、杜绝美化」的身份锁定口径、服装/场景三行式设定、用运动方向接两个片段 |
| beshuaxian/higgsfield-seedance2-jineng | 1020 | 无许可证 | `@material[名称]` 引用素材、9 图 / 3 视频 / 3 音频 / 共 12 项的参考配额、面板序列的阅读顺序与过渡指定 |
| OSideMedia/higgsfield-ai-prompt-skill | 850 | MIT | 参考的四种语义角色（Character / Last-Frame / Environment / Prop）、`@Image1 as …` 句式、身份块逐字复用规则、「不在场的 tag 不要写」、Seedance 2.5 `omni_reference` 的角色映射与排除句 |
| CyberJ0605/cinematic-video-prompt-engineer-skill | 142 | MIT | 多模态参考权威边界（图/视频/音频各控制什么）、续写工作流与【接续判断】结构、三种桥接方式、「从故事状态接续而非复制尾帧」 |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | 命名锁（`[identity_lock]`）与 `hard cut` 分镜、参考集「一个元素一张图」原则、v2v 换人保像素的时长约束 |
| ZeroLu/awesome-seedance | 2812 | MIT | 多镜实战中「场景与人物分开描述」的范例结构 |

- 抓取日期：2026-11-04
- 合并的上游技能：shortfilm-prompt、awesome-seedance、seedance-cinematic（01-cinematic）、higgsfield-ai-prompt-skill、cinematic-video-prompt-engineer、seedance-2-0、seedance-2-5、kling-official
- 冲突与取舍：
  - **续写起点**：一份要求「用上一条尾帧继续」，另一份明确「从故事状态接续、不必复制尾帧」。两套并列，按上一段结尾形态选（动作未完成 → 尾帧/match-on-action；小弧已闭合 → 换景别接故事状态）。
  - **身份描述量**：一份主张参考图在场时身份文本极简（只留 1–2 个锚点），另一份主张整段身份块逐字复用。取后者作默认（多镜更稳），单镜或短表场景退回极简。
  - **参考数量**：12 项（2.0）与 50 项（2.5）并存，按模型分流；两套都强调「不是越多越好」。

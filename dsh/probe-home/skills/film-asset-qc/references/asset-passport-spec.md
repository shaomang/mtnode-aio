# 资产护照写法与登记表

## 1. 护照 = 资产的记忆

护照里的 `Canonical descriptor` 与已批准参考图会被**原样**复制进后续每条提示词。
因此护照写不全 = 资产缺项，而不是「以后再补」。

一次只做一个资产、一份护照。类型只有三种：character / location / prop。
状态变体是独立资产（`@cal`、`@cal_wet`、`@cal_blood` 是三个资产、三份护照、三行登记）。

## 2. 护照模板

```markdown
# @lin — version 2
Status: draft
Type: character
Scenes: S04, S07, S11
Seed files: assets/characters/lin-v2_face.png（pending 时写 pending）

## Canonical descriptor
（一段完整散文，穷尽视觉身份：脸、发、年龄线索、体形、皮肤、服装、
鞋、随身物与磨损、识别细节。不提供简写版，不为简洁省略细节。
永久身份与「本场动作/构图/机位」必须分开写。）

## Reference-sheet prompt
（把上面的描述原文逐字粘进来；中性灰底；正面、3/4、侧面、背面、特写五视图；
 不带无关地点、陈设、叙事动作与戏剧化打光。）

## Reference files
- assets/characters/lin-v2_sheet.png
- assets/characters/lin-v2_face.png

## Stress test
（矩阵与结果见下；未跑就留空）
```

## 3. 描述写什么（按类型）

| 类型 | 必写项 |
| --- | --- |
| character | face、hair、age cues、build、skin、wardrobe、footwear、carried items、wear、distinctive details |
| prop | form、scale、material、colour、finish、wear、markings、moving parts、distinctive details |
| location | layout、surfaces、architecture、fixed objects、scale、weathering、spatial landmarks + 主/辅/强调色、光特性、内置影调 |

地点或道具的色与光未定时，向用户确认，不要替用户发明。
用户说不出取什么的参考图（「就是喜欢」），在补充说明前不进板。

## 4. 参考板提示词要求

- 同一个资产，中性灰底，五视图：正面、3/4、侧面、背面、特写（人物或细节）。
- 描述原文逐字进入提示词。
- 不带无关地点、陈设、叙事动作与戏剧化打光。
- 状态变体：写全不变的身份 + 该变体的确切可见变化。
- 每张图存到对应 `/assets/<type>/` 目录，文件名带版本，路径写进护照。

## 5. 登记表

固定列：`tag · type · version · seed file · scenes · status`。

- 按 tag 与 version 精确定位行；没有就追加，有就更新那一行 draft。
- 不静默合并两个 tag、不改已有 tag。
- `seed file` 填护照路径或参考板路径，跟随项目既有约定。
- 新护照一律先写 `draft`；建资产的人**不得**写 `locked`。

```markdown
| tag | type | version | seed file | scenes | status |
| @lin | character | 2 | assets/characters/lin-v2.md | S04 S07 S11 | locked |
| @loc_workshop | location | 1 | assets/locations/workshop-v1.md | S07 S11 | draft |
| @syringe | prop | 1 | assets/props/syringe-v1.md | S07 S11 | draft |
```

## 6. 锁定流程

1. 找到精确的登记行（tag + version）。
2. 要求 draft 护照 + 完整描述 + 参考文件。缺任何一项，停止锁定并点名回 `film-asset-character` 补。
3. 跑矩阵，逐行判 `pending/pass/miss`。
4. 角色要求 10/10；地点或道具要用户显式通过决定。
5. 通过后：登记行 `draft → locked`；护照 `Status: locked`；在 `## Stress test` 写锁定决策与结果路径。
6. 描述逐字保留，不因锁定而改写。

## 7. 版本与命名

| 规则 | 说明 |
| --- | --- |
| 一个版本一个文件 | `<tag-without-@>-v<version>.md` |
| 参考图不重命名 | 新版本生成新文件，绝不覆盖 |
| 变体单独编号 | 湿透、受伤、换装、年龄段均独立 |
| 备注只增不改 | 历史决策留痕，便于回滚 |

## 8. 「未解决字段」怎么写

护照尾部可以留一段未解决清单，但必须写清缺什么、卡在谁身上：

```markdown
## 未解决
- 左眉尾疤的长度（1cm / 2cm）：待用户确认
- 鞋型：等待道具组 @boots 定版后回填
```

不许把未解决项藏进描述里含糊带过。

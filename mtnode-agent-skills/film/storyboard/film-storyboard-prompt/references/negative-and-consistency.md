# 负面清单与一致性约束

正文 `film-storyboard-prompt` 引用本文件。

## 一、负面清单三层结构

| 层 | 条数 | 内容 | 复用方式 |
| --- | ---: | --- | --- |
| 通用层 | 4–6 | 每张图都真会犯的错（乱字、多肢、水印、塑料皮肤） | 全项目复制，一次写好 |
| 场景层 | 2–3 | 本片/本场的世界规则（时代道具、天气、服装制度） | 每场一次 |
| 镜头层 | 2–4 | 这一镜的真实风险（门缝里的人形、多扇亮窗） | 每镜重写 |

合计 8–14 条。超过 20 条时模型开始丢失主体描述，负面词会反噬。

## 二、词表（按失效类别取用）

| 类别 | 常用负面词 |
| --- | --- |
| 人脸与身体 | `changed face`、`different hairstyle`、`plastic skin`、`over-smoothed skin`、`broken teeth`、`duplicated limbs`、`extra fingers`、`six fingers`、`warped ears`、`crossed eyes` |
| 文字与标识 | `text`、`lettering`、`signage`、`watermark`、`logo`、`subtitle`、`garbled Chinese`、`speech bubbles`（漫画格式除外） |
| 构图 | `symmetrical two-shot`（非刻意时）、`centered flat composition`、`cropped head`、`heavily tilted horizon`、`extreme lens distortion`、`fisheye`（已主动采用时删掉） |
| 光 | `flat frontal lighting`、`even soft fill`、`blown highlights`、`harsh on-camera flash`、`green cast`、`magenta cast` |
| 成像 | `oversharpened`、`HDR look`、`CGI sheen`、`cartoon look`、`illustration`、`3D render`、`AI gloss`、`depth-of-field cutout edges` |
| 内容 | `extra people in background`、`modern objects`、`visible camera crew`、`reflections of the crew`、`wrong era props`、`airbrushed clouds` |
| 风格越界 | `anime`、`oil painting`、`low-poly`、`stock-photo smile`、`marketing poster style` |

写法纪律：负面词用**模型能看见的失败**，不用抽象判断。写 `six fingers` 而不是 `bad anatomy`；写 `extra people in background` 而不是 `composition problem`。

## 三、角色一致性约束（十条）

1. **锚点原文落盘**。把六段式的 ①（身份锚点）与 ⑥（禁止项）存成一个文本文件，所有提示词从这里复制，禁止手打。
2. **只改 ②**。变体段是唯一允许改动的部分；改了 ① 就等于换人。
3. **先出五视图再出戏**。正面/侧面/四分之三/背面/全身，同一 `seed`、同一光位、纯白背景；五视图通过后才进场景。
4. **同批生成**。同一场的图在同一会话、同一模型、同一 `seed` 基线、同一参考图权重下出；跨会话会漂移。
5. **参考图 1–3 张**。一张正面清晰、一张侧面或全身、一张本片光位近似；超过 3 张会互相打架。
6. **参考强度分档**：脸与发型用高权重（0.7–0.9）；姿态与构图用中权重（0.4–0.6）；只要色调就用低权重（0.2–0.3）。
7. **每张图都写「只有 X 变化」**。约束尾巴里明确列出本图相对基准变了什么（眼睛位置、手的悬停高度、湿度）。
8. **失败图不许当输入**。失败图只用于诊断；修图从已批准基准重写完整提示词，不拿坏图继续喂。
9. **`seed` 与版本登记**。每张通过的图记 `seed`、参考图路径、锚点版本、提示词版本；工具不暴露 `seed` 就记 `null`。
10. **状态变体单独版本号**。湿发、伤妆、换装各是一个 `@tag@v2`，不要在一张图里叠两个变体。

## 四、光位与材质速查（中英对照）

| 中文 | English | 典型比例 |
| --- | --- | --- |
| 主光 10 点方向 | key light from 10 o'clock | — |
| 侧逆光 | 45° back-side light | 4:1 |
| 轮廓光 | rim light / edge light | — |
| 硬光（无修饰） | hard key, unmodified | 6:1–8:1 |
| 柔光（大柔光箱/窗光） | soft key through a large diffuser | 2:1–3:1 |
| 无补光 | no fill on the shadow side | — |
| 实用光源驱动 | practical-motivated lighting | — |
| 体积光 / 可见光柱 | volumetric light shaft, haze | — |
| 色温 3200K 钨丝 | 3200 K tungsten | — |
| 色温 5600K 日光 | 5600 K daylight | — |
| 胶片颗粒 | 35 mm film grain | — |
| 高光晕染 | halation on highlights | — |
| 湿表面反光 | wet-surface specular reflection | — |
| 布料褶皱 | real fabric folds with weight | — |
| 毛孔与细汗 | visible pores, faint sheen of sweat | — |

## 五、失败诊断表

| 症状 | 最可能原因 | 修法（改哪一槽） |
| --- | --- | --- |
| 换脸 | 锚点被改写 / 参考图 >3 张 / 跨会话 | 第 4 槽锚点原文 + 同批同 seed |
| 服装颜色漂 | 只写「深色外套」 | 第 4 槽写具体颜色与材质 |
| 机位高度不对 | 只写「低角度」 | 第 3 槽写 cm + 可见后果（桌面切点） |
| 光向翻转 | 只写「侧光」 | 第 7 槽写钟点 |
| 背景多路人 | 环境槽太短 | 第 6 槽写「无人，只有…」 + 负面 `extra people` |
| 画面出字 | 要求生成文字 | 改留空位 + 后期贴 |
| 皮肤塑料 | 未写材质 | 第 8 槽「visible pores, no retouch」 + 负面 `plastic skin` |
| 构图被居中 | 未指定位置 | 第 6 槽写「主体占画面左侧三分之一」 |
| 越修越差 | 在失败图上迭代 | 回基准图重写完整提示词 |
| 手部畸变 | 手是主体且占比大 | 改机位让手出画或用道具遮挡；负面 `extra fingers` |

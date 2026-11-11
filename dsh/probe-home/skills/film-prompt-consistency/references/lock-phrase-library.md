# 锁定语句库（可直接粘贴）

按用途分组。英文句用于 Seedance / Veo / Kling 英文界面与 API；中文句用于中文端模型与人工审阅。两套语义等价，可混排但不要同义反复堆叠。

## 一、身份锁（Identity lock）

```
@Image1 as the main character. Identity and costume match the reference exactly.
```

```
same character across different scenes / all shots
maintain exact appearance from reference image
no deformation, no drift, no face morph
```

```
[reference_image: hero_portrait.png]
[identity_lock]
The same character — [外貌三要点] — consistent across all shots.
```

```
IDENTITY LOCK: the face is the reference's face. Do not beautify, do not slim the jaw,
do not change the nose width, do not add makeup.
```

中文版：

```
图片1锁定女主身份与服装；五官、脸型、发型与参考完全一致，不美化、不瘦脸。
```

```
同一角色贯穿全片；不换脸、不变形、不改变五官比例。
```

## 二、服装锁

```
Do not alter clothing category or primary color.
```

```
The coat is charcoal wool, matte, knee-length. Keep the cut, the lapels and the button count.
```

```
服装：哑光黑色皮质长风衣，金属腰带为哑光质地，腰带核心为暗红色水晶。
```

## 三、场景锁（拓扑写法）

```
@Image2 as the environment. The corridor runs screen-left to screen-right, the door is at the far
left end, the window is on the right wall, a single ceiling light is above the door.
```

```
同一空间：门在画面左后方，窗在右墙，沙发背对窗，深色木地板。光源只来自右墙的窗。
```

```
the set contains only what the reference shows
```

## 四、道具锁

```
@Image3 as the prop. Same geometry, same material, same wear marks. The character holds it in
the right hand throughout.
```

## 五、风格锁（只写一次）

```
GLOBAL STYLE — photorealistic, 35mm film grain, halation on highlights, low-saturation teal-grey
grade, 21:9, 24fps shutter. No CGI look, no plastic skin, no lens flare spam.
```

中文版：

```
风格：写实电影感，变形宽银幕，35mm 胶片颗粒，低饱和灰蓝调，杜绝游戏 CG 感。
```

## 六、排除句（不继承什么）

```
视频1只参考闪避步法与动作衔接，不继承人物、场景和声音；摄影机按本段分镜执行。
音频1只提供女主音色，台词使用本段中文原文，不采用录音里的配乐。
```

```
@Video1 as motion reference only — step timing and body mechanics. Do not inherit its performers,
costumes, setting, camera path or sound.
```

```
Use @Image1 for identity only. Its background, pose and lighting are not part of this shot.
```

## 七、续写开场句

```
Continuing from the prior clip — she is still standing at the window, right hand raised halfway.
She turns her head toward the door.
```

```
继续上一个镜头：她仍站在窗边，右手抬到一半。现在她转向门口。
```

```
从上一段结束状态继续：[位置/情绪/道具]。只写新的运动与新信息。
```

## 八、状态登记句

```
STATE: coat wet at both shoulders, right sleeve dusted grey, cut on the left eyebrow, phone in the
left hand since 0:12.
```

```
状态：外套双肩已湿，右袖有灰，左眉有擦伤，手机自 0:12 起在左手。
```

## 九、可见文字/标识（参考里有也要写）

```
The badge reads "SECURITY" in white sans-serif on a navy patch, left chest.
```

```
胸牌为藏青底白字 "SECURITY"，位于左胸，不要改字、不要镜像。
```

## 十、组合模板（多参考一次写完）

```
@Image1 as the main character — identity verbatim, costume as shown.
@Image2 as the environment — layout and light only, no people.
@Image3 as the prop — same geometry and wear.
@Video1 as motion reference — dodge step only; do not inherit performers, costumes, setting or sound.
@Audio1 as voice identity for the female lead only; lines come from this script.

GLOBAL STYLE — [一句风格声明].
[镜头正文，只写变化。]
```

## 用法提醒

- 同一句锁不要重复三次以上；重复会挤掉动作描述的位置。
- 锁句放在主体句之后、运动句之前，模型读到的顺序即权重顺序。
- 中文端模型对「不美化」这类否定句响应良好；英文端的 Seedance 更认「正向事实 + `no X` brief negative」组合，不要写成长否定清单。
- 每次交付把用到的锁句版本记下来，下一段直接复用同一份文本。

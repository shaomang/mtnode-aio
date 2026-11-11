# 失败模式详解（症状 → 机制 → 对策 → 例）

每条四段：**症状 / 机制 / 对策 / 例**。定位靠症状，不靠猜模型。

## 一、动作与物理

### 1. 动作被截断——切点落在结果之前

**症状** 每个镜头都「像」，但整段没有一件事真正完成：盖子还在合、手还在伸、门半掩。
**机制** 镜头按「包含什么」被定价，不按「必须完成什么」；没有任何帧被指定为可结束点，于是任何一帧都可以切。
**对策** 把完成态写成可见事实并让它稳定一瞬：`the lid seats flush and stays there`、`the glass comes to rest on the wood`、`her hand closes fully around the handle`。节奏确实需要早切，就让**下一镜从结果已成立**开始（笔记本已合、房间已暗）。
**例** 反：`she closes the laptop and leaves` → 正：`she closes the laptop; the lid meets the base and the screen goes dark; she stands`。

### 2. 手势空演——手在动，物体不动

**症状** 拉抽屉、翻页、拧瓶盖，手型对但物体毫无响应，像在空气里比划。
**机制** 提示词只写了手的轨迹，没写操作对象的物理反馈；模型把物体当静态贴片。
**对策** 给物体写响应与阻力：`the drawer slides out on its runners`、`the page buckles and turns`、`the cap gives with a click`。
**例** 反：`he opens the drawer quickly` → 正：`he pulls; the drawer slides out on its runners and stops with a knock`。

### 3. 孤儿肢体 / 多人穿模

**症状** 群像里多出一条腿；两人拥抱时手臂从对方身体里穿出。
**机制** 人数不确定 + 站位重叠；模型不维护「每个人一套肢体」的账。
**对策** 写人数锁（`exactly four people`）、拉开站位（`one meter apart`）、把接触改成前后景分离或剪影；实在需要接触就拆成单人镜 + 反打。
**例** 反：`a crowd hugs` → 正：`exactly three people; the two in front embrace, the third stands one meter behind, screen-left`。

### 4. 走路像滑行

**症状** 人物前进但脚不落地，或步频与位移不匹配。
**机制** 行走是模型最难的动作：需要交替支撑、重心转移、地面反作用力同时成立。
**对策** 拆成 2–3 个短镜（起步 / 中段 / 停下），每镜只写一个阶段；写 `heel strikes first, weight shifts onto the front foot`；能不给全身就不给全身。
**例** 反：`she walks down the corridor for 10 seconds` → 正：`she takes two steps and stops; heel first, coat hem swinging`。

### 5. 空间错乱

**症状** 走廊方向反了；人物穿过桌子；门在下一镜跑到另一侧。
**机制** 只写了「同一个房间」，没写拓扑；模型每镜重新布置一次。
**对策** 写拓扑（门在左后、窗在右墙、桌在中景偏右）+ 一张 `no people` 的场景板；跨空间移动写「连接口 + 中间地标 + 可见顺序」。
**例** 反：`she enters the office` → 正：`she enters through the door at screen-left rear, passes the desk on her right, stops at the window on the right wall`。

### 6. 多运动叠加导致画面崩

**症状** 画面同时旋转、上升、推进，什么都看不清。
**机制** 一镜叠了多个运镜轴，模型把它们并行渲染成抖动。
**对策** 只留一个主运动；复合运动拆成带秒数的阶段（`rises 0–3s, holds, pushes in 4–8s`）。
**例** 反：`handheld orbit while craning up and pushing in` → 正：`orbit clockwise at constant radius; at 4s the camera stops and holds`。

## 二、身份与表演

### 7. 身份漂移

**症状** 前两镜是同一人，第三、四个切点后变成「通用脸」；多人同框时越切越像。
**机制** 参考集里多张脸互相投票；提示词里的外貌文字与参考图冲突；切点越多，漂移越明显。
**对策** 身份块逐字复用；只留一张主身份图；写 `no face morph`；多人镜每人一张参考，且不要让人物挤在同一景别里。
**例** 正：`IDENTITY LOCK — the face is @Image1's face: high cheekbones, single eyelid, mole under the left eye. No beautification, no jaw slimming.`

### 8. 口型不符 / 台词串音

**症状** 嘴在动但字不对；或听起来像另一个人在配音。
**机制** 台词没引号、说话人未标、单句太长说不完；音色参考没有绑定到具体角色。
**对策** `Character says: "..."`，单句 ≤6 词；按「2.5 秒一句话」排时长；台词前后留 0.3s 静默；音色参考写 `for [角色] only`。
**例** 反：`she tells him she's leaving` → 正：`She says: "I'm leaving." Then silence for half a second.`

### 9. 情绪演不出来

**症状** 该崩溃的镜头只有一张平静的脸。
**机制** 写了情绪标签（`she is devastated`），没写可见行为。
**对策** 写肌肉级通道：`eyes glassy, jaw tight, breath shallow, hands still`；给一个具体动作（把杯子放下、扶住桌沿）。

## 三、画面与质感

### 10. 重复帧 / 卡顿

**症状** 逐帧看有连续重复帧；请求 24fps，实际节奏像 12–18fps。
**机制** 模型在负载或密集动作下掉有效帧率，用重复帧补时长。
**对策** 在提示词正文写帧率（不只在参数里）；降低动作密度；换 `standard` 档而非 `fast`；必要时后期补帧。
**例** 正：`24fps, natural motion cadence, no frame holds`。

### 11. 塑料感 / 游戏 CG 味

**症状** 皮肤像蜡、金属像贴图、光线没有衰减。
**机制** 缺写实锚点；参考图过度美颜；只写了 `cinematic`。
**对策** 加 `no 3D, no cartoon, no VFX aesthetic — photorealistic textures, real skin pores, authentic fabric detail`；补材质与光源衰减；换掉美颜参考图。
**例** 正：`35mm film grain, halation on highlights, skin with visible pores and faint redness at the knuckles`。

### 12. 频闪段落显得一跳一跳

**症状** 闪光/频闪段里身体像被定住再启动。
**机制** 逐拍光脉冲被渲染成运动停顿。
**对策** 加连续运动子句：`nothing is ever frozen between flashes; every body is in continuous motion at all times, it is only the light that stops them`；仍不行就改成缓慢连续的光涌，最后退回常亮。
**例** 正：`the strobe pulses at 12Hz, yet all motion is continuous — only the light cuts`。

### 13. 提示词过载 → 画面糊

**症状** 细节全都「有」，但没有一处清晰；构图散。
**机制** 要素太多，模型平均化处理；词数超过 100 后听从度下降。
**对策** 删到 30–100 词的核心；把次要元素移出本镜；一次只交代一个视觉重点。

### 14. 关键帧迫使发明

**症状** 提示词要求首帧里根本没有的东西（从冰箱上取下拍立得），结果手部穿模、物体凭空出现。
**机制** 首帧是硬约束，文字要求与之冲突时模型只能在画面里「造」。
**对策** 改文字去匹配首帧；或补一张含该元素的首帧；或把该动作挪到下一镜。

## 四、音频

### 15. 短台词被填成胡说

**症状** 一句 5 个词的台词被念成一串含糊音节。
**机制** 台词时长与镜头时长不匹配，模型用填充音补时间。
**对策** 缩短台词、延长镜头、或拆成两句分镜；给足静默余量。

### 16. 音乐压过对白

**症状** 上传的对白被背景音乐盖住。
**机制** 音频参考只写了一条，模型把音乐当主轨。
**对策** 对白与音乐分轨上传；提示词写 `dialogue is the primary audio layer, music at −18 dB under it`（**通用经验值**）。

## 五、按模型补充

| 模型 | 高频失败 | 优先检查 |
| --- | --- | --- |
| Seedance 2.0 | 结构碎裂、动作截断、重复帧 | 第一句结构声明；完成态；帧率与档位 |
| Seedance 2.5 | 多参考串味、镜数过多导致后段崩 | 参考映射与排除句；镜数 ≤8–10 |
| Kling 3.0 | 动作控制不生效 | 上游素材（参考片时长、角色图朝向、场景源） |
| Veo 3.1 | 时长档不匹配（写了 5s/7s） | 只认 4/6/8 |
| MiniMax H3 | 音频参考无画面、时长超 15s | 音频需至少一个视觉参考 |

# 镜头词表（中英对照）

正文 `film-shot-language` 引用本文件。规则计算走六级阶梯；本文件只解决「叫什么、怎么读、写进提示词用哪个词」。

焦段一律为 **35mm 全画幅等效**。Super-35 标称值 ×1.4、APS-C ×1.5、MFT ×2、手机主摄约 ×4–7。

## 一、景别：中文工业细目 → 六级阶梯

| 编号 | 中文 | 英文 | 画框 | 阶梯级 |
| --- | --- | --- | --- | ---: |
| CM1 | 超远景 | Extreme Long Shot (ELS) | 人物极小，建立世界 | 1 |
| CM2 | 远景 | Long Shot (LS) | 环境主导，留白多 | 2 |
| CM3 | 全景 | Full Shot (FS) | 全身入镜 | 2 |
| CM4 | 中景 | Medium Shot (MS) | 半身 | 3 |
| CM5 | 中近景 | Medium Close-Up (MCU) | 胸以上 | 4 |
| CM6 | 近景 | Close-Up (CU) | 面部占画幅约 80% | 5 |
| CM7 | 大特写 | Extreme Close-Up (ECU) | 眼/唇/手指 | 6 |
| CM8 | 微距特写 | Macro Shot | 皮肤纹理、睫毛、汗 | 6（需另注微距） |
| CM9 | 过肩 | Over the Shoulder (OTS) | 前景肩部虚化 | 3–4（按后景人物尺寸定） |
| CM10 | 双人中景 | Two-Shot | 两人腰以上同框 | 3 |
| CM11 | 三人中景 | Three-Shot | 三人同框 | 3 |
| CM12 | 半身像 | Half Shot | 大腿中以上 | 3 |
| CM13 | 牛仔镜头 | Cowboy Shot | 膝以上（西部片武器位） | 3 |
| CM14 | 意大利式特写 | Italian Close-Up | 眼部极度放大 | 6 |
| CM15 | 插入镜头 | Insert | 手、道具、局部 | 6 |

AI 可靠性：MS–CU 一带最稳。EWS 容易造出畸形的远景脸与多余路人，ECU 容易糊牙、糊眼、多数手指。极端镜头能静态出图就别硬生成运动。

## 二、角度 21 项

| 编号 | 中文 | 英文 | 读作 |
| --- | --- | --- | --- |
| AN1 | 平视 | Eye Level | 客观、平等、观察 |
| AN2 | 低角度仰拍 | Low Angle | 权威、威胁、神话 |
| AN3 | 极低角度 | Worm's Eye | 巨物压迫 |
| AN4 | 高角度俯拍 | High Angle | 弱势、被审判 |
| AN5 | 鸟瞰 | Bird's-eye / God's Eye | 系统、命运、棋盘 |
| AN6 | 荷兰角 | Dutch / Canted | 失衡、疯狂（一片不超过两次） |
| AN7 | 轻度荷兰角 | Slight Dutch（5–10°） | 潜意识不安 |
| AN8 | 侧面平视 | Profile Eye Level | 沉思、不肯交底 |
| AN9 | 侧面仰拍 | Profile Low | 侧面威严、剪影 |
| AN10 | 侧面俯拍 | Profile High | 审视、脆弱 |
| AN11 | 四分之三正面 | Three-Quarter Front（45°） | 立体、经典肖像 |
| AN12 | 四分之三背面 | Three-Quarter Back | 神秘、离去 |
| AN13 | 正背面 | Straight Back | 孤独、未知前方 |
| AN14 | 正侧面 | Straight Profile | 对峙、平行关系 |
| AN15 | 主观视角 | POV | 第一人称、沉浸 |
| AN16 | 过肩 POV | OTS POV | 对话代入 |
| AN17 | 窥视视角 | Keyhole / Voyeuristic | 禁忌、偷窥 |
| AN18 | 监控视角 | CCTV / Security Cam | 被监视、冷酷客观 |
| AN19 | 鱼眼 | Fisheye | 荒诞、扭曲 |
| AN20 | 倾斜过肩 | Dutch OTS | 不安的对峙 |
| AN21 | 正反打 | Shot / Reverse Shot | 张力、加压（几何见 `axis-and-continuity.md`） |

## 三、运镜 66 项

### A. 基础 16

| 编号 | 中文 | 英文 | 用法注意 |
| --- | --- | --- | --- |
| MV1 | 固定 | Static / Locked-off | 画面内必须有运动，否则像静帧 |
| MV2 | 推近 | Push In / Dolly In | 写距离 + 时长 |
| MV3 | 拉远 | Pull Out / Dolly Out | 写起幅与落幅 |
| MV4 | 慢推 | Slow Push In | 观众应几乎察觉不到 |
| MV5 | 慢拉 | Slow Pull Out | 用于释怀与离去 |
| MV6 | 摇左 | Pan Left | 起幅/落幅各是什么 |
| MV7 | 摇右 | Pan Right | 24fps 下 5 秒内扫满幅会频闪 |
| MV8 | 上摇 | Tilt Up | 强化高低关系 |
| MV9 | 下摇 | Tilt Down | 揭示下方 |
| MV10 | 跟镜前 | Tracking Forward | 速度 = 主体速度 |
| MV11 | 跟镜后 | Tracking Backward | 揭示身后 |
| MV12 | 横移 | Tracking Sideways | 拓展空间、伴随走位 |
| MV13 | 环绕左 | Orbit Left | 默认 20°，写方向 |
| MV14 | 环绕右 | Orbit Right | 静态对话上慎用 |
| MV15 | 升 | Crane / Boom Up | 揭示全局 |
| MV16 | 降 | Crane / Boom Down | 压迫、沉入 |

### B. 进阶 26

| 编号 | 中文 | 英文 | 用法注意 |
| --- | --- | --- | --- |
| MV17 | 疾推 | Crash Zoom | 冲击、揭露 |
| MV18 | 疾拉 | Crash Zoom Out | 荒诞反转 |
| MV19 | 变焦转移 | Rack Focus | 必须落在拍点上，起点/终点各是什么 |
| MV20 | 手持 | Handheld | 写 `small reframing, not shake` |
| MV21 | 剧烈手持 | Shaky Handheld | 只给物理冲击的那几帧 |
| MV22 | 斯坦尼康 | Steadicam | 平滑跟随、入场长镜头 |
| MV23 | 航拍上升 | Drone Ascend | 建场 |
| MV24 | 航拍穿越 | Drone Fly-Through | 空间探索 |
| MV25 | 航拍俯冲 | Drone Dive | 坠落感 |
| MV26 | 甩镜 | Whip Pan | 两端都要设计 |
| MV27 | 推拉变焦 | Dolly Zoom / Vertigo | 推轨与变焦方向相反 |
| MV28 | 子弹时间 | Bullet Time | 环绕冻结 |
| MV29 | 分焦屈光 | Split Diopter | 缝要藏在竖直边缘（门框/柱） |
| MV30 | 胸挂机 | SnorriCam | 迷失、错乱 |
| MV31 | 摇臂弧线 | Jib Arm Arc | 优雅揭示 |
| MV32 | 微距横移 | Slider Micro-Move | 细节观察 |
| MV33 | 贴地稳定器跟拍 | Low Gimbal Tracking | 速度感 |
| MV34 | 车载跟拍 | Car Mount Tracking | 追逐 |
| MV35 | 水下 | Underwater | 失重、窒息 |
| MV36 | 揭示升降 | Crane Reveal | 从遮挡后升起 |
| MV37 | 螺旋环绕 | Spiral Orbit | 眩晕、升维 |
| MV38 | 过肩跟随 | OTS Tracking | 代入 + 关系 |
| MV39 | 缓变焦 | Slow Zoom | 只改裁切，不改观看位置 |
| MV40 | 滑轨 | Slider Shot | 稳定、秩序 |
| MV41 | 稳定器跟拍 | Gimbal Tracking | 穿行长镜头 |
| MV42 | 变速运镜 | Variable Speed Move | 速度曲线要显式写 |

### C. 导演级动作 24

| 编号 | 中文 | 英文 | 用法注意 |
| --- | --- | --- | --- |
| MV43 | 前景遮挡运镜 | Foreground Occlusion Move | 前景占画 10–30% |
| MV44 | 穿越运镜 | Pass-Through Shot | 穿门窗、穿人群 |
| MV45 | 低机位推进 | Low-Angle Push In | 力量、压迫 |
| MV46 | 高机位移动 | High-Angle Tracking | 渺小、疏离 |
| MV47 | 长镜头调度 | Sequence Shot / Oner | 单条 clip 撑不住就链式拼接 |
| MV48 | 倾斜运镜 | Dutch Angle Movement | 失衡 |
| MV49 | 推拉变焦组合 | Push-Zoom Combo | 推进 + 同向变焦 |
| MV50 | 抽离 | Pull-Away Shot | 余韵 |
| MV51 | 弧线跟进 | Arc Tracking Approach | 试探、逼近 |
| MV52 | 反向包抄 | Reverse Envelopment | 由背绕到正面，局势翻转 |
| MV53 | 侧向切入 | Side Sweep-In | 突发 |
| MV54 | 压迫式逼近 | Oppressive Approach | 长焦缩短呼吸空间 |
| MV55 | 退让式让位 | Yielding Reveal | 边退边让出新主体 |
| MV56 | 交叉穿行 | Cross-Weaving | 群戏、追逐 |
| MV57 | 贴地掠行 | Ground-Skimming | 速度冲击 |
| MV58 | 顶视旋落 | Top-Down Spiral Descent | 宿命、崩塌 |
| MV59 | 侧背尾随 | Side-Back Trailing | 潜行、跟踪 |
| MV60 | 突停凝视 | Sudden Stop Gaze | 运动骤停定格 |
| MV61 | 回撤揭示 | Pull-Back Reveal | 从局部撤回全局 |
| MV62 | 双主体摆渡 | Dual-Subject Shuttle | 谈判拉扯 |
| MV63 | 斜向俯冲 | Diagonal Dive | 攻击性 |
| MV64 | 纵深穿堂 | Depth Penetration | 未知牵引 |
| MV65 | 节奏点爆发 | Rhythm-Burst | 卡音乐/动作节点 |
| MV66 | 悬停审视 | Hovering Survey | 冷静压制 |

## 四、焦段 11 项

| 编号 | 焦段 | 类型 | 效果 | 用途 |
| --- | --- | --- | --- | --- |
| FL1 | 14–24mm | 超广角 | 强透视变形、空间炸开 | 大场景、压迫、车内 |
| FL2 | 24–35mm | 广角 | 自然广角、轻微变形 | 环境交代、群戏 |
| FL3 | 35mm | 经典广角 | 纪实感 | 街拍、环境人像 |
| FL4 | 50mm | 标准 | 接近人眼 | 对话、日常 |
| FL5 | 85mm | 人像 | 轻压缩、自然 | 特写、肖像 |
| FL6 | 100mm | 中长焦/微距 | 明显压缩 | 细节、分离主体 |
| FL7 | 135mm | 中长焦 | 明显压缩 | 远距特写、被监视 |
| FL8 | 200mm+ | 长焦 | 强压缩、扁平 | 困住、热浪 |
| FL9 | Anamorphic | 变形宽银幕 | 椭圆焦外、水平拉丝 | 宽银幕质感 |
| FL10 | Tilt-Shift | 移轴 | 选择性焦平面 | 建筑取景、微缩感 |
| FL11 | Macro | 微距 | 极近放大 | 纹理、微观 |

景深速算（全画幅，主体 2 m，f/2）：24mm ≈ 0.85 m；50mm ≈ 0.19 m；85mm ≈ 0.07 m（小于一颗头的厚度）。主体距离翻倍 ≈ 景深 ×4；焦段翻倍 ≈ 景深 ÷4；开大一档 ≈ 景深 ×0.7。

## 五、画幅 10 项

| 编号 | 比例 | 对走位的影响 | 失效条件 |
| --- | --- | --- | --- |
| AR1 | 1:1 | 横向纵向都压死，强制居中 | 任何有关系的戏，第二个人无处可放 |
| AR2 | 4:3 | 竖向构图，一个人自然填满 | 需要两人并排或风景尺度 |
| AR3 | 16:9 | 安全默认，几乎容忍任何调度 | 画幅本身想表态时 |
| AR4 | 9:16 | 只能纵深调度 | 按 16:9 习惯拍全景 |
| AR5 | 2.39:1 | 横向调度，两张脸可共享一个近景距离 | 高个子、楼梯、站姿——头顶与地面浪费 |
| AR6 | 1.37:1 | 接近方形，脸在竖向被填满 | 需要宽银幕的横向并置 |
| AR7 | 1.43:1 | IMAX 沉浸 | 交付端不支持 |
| AR8 | 2:3 | 海报/出版物 | 视频交付 |
| AR9 | 32:9 | 超宽双屏 | 单屏观看 |
| AR10 | 4:5 | 竖幅印刷、信息流 | 关系镜头 |

9:16 三条硬规则：① 景别整体紧一级（WS→MS，MS→MCU），但不要反射性地紧到 ECU；② 两人同框必须靠纵深（近者占下半幅、远者更高更小），且机位略高于眼平、留住地面；③ 人脸与烧录文字留在画幅高度的中间约 60%，上下各 10–12% / 18–25% 是平台 UI。

## 六、转场 10 项

| 编号 | 中文 | 英文 | 读法 |
| --- | --- | --- | --- |
| TR1 | 跳切 | Jump Cut | 时间跳跃、焦虑 |
| TR2 | 匹配剪辑 | Match Cut | 形状/动作/声音/颜色，只用一个载体 |
| TR3 | 冲击切 | Smash Cut | 静到爆 |
| TR4 | 淡入淡出 | Fade | 场开始/结束 |
| TR5 | 叠化 | Dissolve | 时间流逝、内心（6–10f 掩瑕疵；24–48f 真转场） |
| TR6 | 划像 | Wipe | 几何擦除、章节感 |
| TR7 | 黑场切 | Cut to Black | 章节结束、死亡 |
| TR8 | 白场切 | Cut to White | 超脱、觉醒 |
| TR9 | 定格 | Freeze Frame | 关键瞬间 |
| TR10 | 速度 ramp | Speed Ramp | 动作强调 |

## 七、构图词表（写提示词时可直接用）

| 中文 | English | 一句读法 |
| --- | --- | --- |
| 三分法 | rule of thirds | 自然、有动势，滥用则「正确但无态度」 |
| 中心/对称 | symmetry / centered | 仪式、权威、荒诞、情感死寂 |
| 负空间 | negative space | 缺席、威胁、孤独（空处必须有质感） |
| 框中框 | frame within frame | 禁闭、监视、社会压力 |
| 前景遮挡 | foreground obstruction | 秘密、窥视、部分知情（别挡住要看的拍点） |
| 引导线 | leading lines | 必然性、注意力方向（线必须通向主体） |
| 对角线 | diagonal lines | 动势、冲突路线 |
| 黄金分割 | golden section (1:1.618) | 古典平衡 |
| 奇数法则 | rule of odds | 3/5 个主体更耐看 |
| 视线余量 | lookroom / noseroom | 正面居中；四分之三约 60/40；正侧最多 2/3 在前 |
| 头顶余量 | headroom | MS 留 5–10% 画高；CU 眼睛压上三分线、颅顶出画 |
| 纵深分层 | deep staging / layering | 前中后三层，缺一层就只剩两个平面 |
| 明暗分区 | chiaroscuro blocking | 用亮度分区代替切镜 |
| 质感对比 | figure-ground | 主体与背景必须分离 |
| 视觉重量 | visual weight | 亮度、色彩差、体量、清晰度、脸、文字、运动六项相加 |

## 八、写进提示词的十条替换

| 别写 | 改写 |
| --- | --- |
| 特写，浅景深，电影感镜头 | 85mm 近景，机位距脸 1.5 m，睫毛与杯沿清晰，身后 4 m 书架化为不可读的柔和竖条，无圆形高光 |
| 手持 | 小幅重新构图的手持，不是抖动 |
| 慢动作 | 长快门拖影 + 重复帧顿挫（两者都写才拿得到） |
| 广角 | 24mm，机位距人 0.8 m，墙角在画面边缘向外弯 |
| 俯拍 | 机位在 3.5 m，向下 60°，地面占画幅三分之二，人在右下角 |
| 电影宽银幕黑边 | 直接按 2.39:1 出图/出片，黑边在后期加 |
| 她很悲伤 | 眉毛内侧抬起，下唇轻微内收，视线落在桌面某一点 |
| 人群 | 3–5 个具名路人各做一件不同的事 |
| 氛围压抑 | 明暗比 6:1，暗面不补光，背景压成单色平面 |
| 镜头缓缓推进 | slow dolly-in，25cm over 6s，终点停在他的眼睛与门缝同高 |

# 镜头卡索引（124 张）

按上游 `video-shotcraft` 的卡片分类整理，保留原卡名、一句话意图与能量位。
用法：先按「这一拍要给什么信息」选族，再按卡名回到主技能的模式族取参数；
上游每张卡另有参数表、已知坑与 demo 源码，本索引只做选型，不复述实现。

能量位：高 = 全片重音位（30s 片子里 ≤6 次）；中高 = 主推进段；中 = 常规叙事；低 = 呼吸位。

## 目录

- 开场（opening）
- 运镜（camera）
- 字形与排版（typography）
- UI 入场（ui-entrance）
- 特效与材质（effects）
- 数据可视化（data）
- 交互演示（interaction）
- 节奏与剪法（rhythm）
- 转场（transition）
- 收尾（outro）

## opening

**开场**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| brand-ink-open | 低 | 墨线十字准星描画→字标逐字压印→打字机副标→满一秒静止再上浮消散 |
| crane-rise-reveal | 中高 | 升降臂拉升揭示——开场怼在一行数据特写，相机沿 Y 轴减速升起后拉，行行涌入直到整面 dashboard 铺满全幅 |
| dataviz-landscape-open | 低开缓升 | 暗场支流线束地景开场——多条流线汇入主干、虚构 ID 标签浮在线上、相机重景深低速飞越 |
| fracture | 高 | 5×5 瓦片从 3D 碎片态按中心波纹逐圈聚合成整面海报，停一拍亮字，随后全部碎片背离中心加速旋转飞出画面 |
| icon-field-colorize | 中 | 灰阶小图标点阵错峰浮现铺满全屏，停一拍后多道品牌色横带波纹极快向下扫翻全场——"功能全景先摆满，品牌一瞬间点亮"的开场/收束卡 |
| letterspace-materialize | 低 | 大字距字标全字符并行连续描画结晶——所有字母同帧起笔、笔画像手写一样连续生长、同帧齐收成词；氛围底景上的品牌字标显影 |
| magician-card-flourish | 高 | 午夜蓝暗场上蓝色星芒闪现 0.3s（X 形针状光束旋转 90°+中心辉光放射小光芒），卡片从闪光点弹射而出——极速自旋弧线飞向镜头、自旋随靠近衰减、瞬间硬定格（卡高 86% 画高）、光脉冲 + sheen 扫光，右侧文案随后逐行揭示 |
| orbit-ring-title-open | 中 | 石墨暗场上八张 16:9 暗色内容卡按 45° 均布在 720×380 椭圆上匀速公转（卡身永不倾斜，纵深只由 sin θ 给出 ±12% 缩放、z 序与远处压暗失焦），环撑开期间卡内容冻结首帧、f24 之后八张一起开播；居中两级标题逐字解糊下沉落定，关键词到位那一刻荧光马克块自左横扫铺满、扫过处字反白为墨，mono 副行随后浮出；可选末段整行失焦淡出、环继续转着交棒下一镜 |
| spotlight-hero-card | 中 | 关灯的剧场里一束钨丝聚光（带体积光柱）扫过页面锁定一张卡，斜侧推进后卡片弹起悬浮、香槟色光束沿轮廓两圈、连同 3D 注记一起贴回原位 |
| stroke-segment-build | 低起中收 | 断笔成字——标题拆成十几段互不相连的笔画乱序逐段点亮，前 70% 不可读，末段落位瞬间语义"啪"地成立 |
| text-as-mask | 中高 | 文字视频遮罩——瓷白舞台上切出超粗大标题字，字内部透出缓慢平移的暗色实时产品面板，结尾吸一口气后字形指数冲入放大 46 倍溢出、内部画面接管全屏 |

## camera

**运镜**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| basic-3d-scene | 中 | impress.js 式空间演示：卡片以不同位置/旋转/缩放散布 3D 空间，相机取各步姿态之逆依次飞行对齐，末步拉到 OVERVIEW 总览 |
| crash-zoom-punch | 高 | 全景一拍急推到目标特写（6f），落位二选一——过冲回弹（弹性）或撞停震屏（重量） |
| cursor-flyover | 中 | 整页俯瞰后，相机依次飞到四个功能区 zoom-in 特写，SVG 光标先一步到位指点、点击留下涟漪并触发界面响应，最后拉回俯瞰 |
| depth-layer-moves | 中 | 分层深度运镜——多层视差滑轨：3 层速度梯度横移出纵深，滑轨落定时主角浮起 |
| graze-face-tour | 中高 | 大倾角贴面游走特写——镜头贴着 UI 表面低飞掠过（侧栏树/顶栏/列表当地形），页面文字初始悬浮在界面上空带同形软影，随镜头行进先后加速贴落回界面 |
| overhead-camera-moves | A 中 / B 中高 | 俯拍揭示两式——tilt-reveal 俯仰抬正揭示、overhead-tabletop-drop 桌面卡阵横滑骤降扎入 |
| space-camera-moves | 高 | 3D 空间化运镜两式——exploded-view 爆炸分解（构件沿 Z 炸开再合体）、drone-dive-landing 无人机俯冲降落 |
| steep-tilt-glide | 中高 | 固定镜头下直立页面以 60° 强透视侧立（右近左远），页面自身沿其 3D 横面方向滑移掠过镜头（物动镜不动），滑移带速度重影、文字组件悬空贴落、由暗揭亮 |
| tension-camera-moves | A 高 / B 低收 | 情绪运镜两式——bullet-time 冻结环绕、pull-back 拉远孤立，相机替观众"感受"而非"看" |
| terminal-3d | 中 | 三个终端窗散布 3D 空间，相机窗间飞行、途中正弦拉远，每到一窗打字机敲命令、结果逐行滑出——命令执行的空间叙事流 |

## typography

**字形与排版**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| blur-slide | 低 | 标题逐词入场，y 0.38em→0 + blur 18→0 + opacity 0→1 三通道走同一条 ease-out 同步收敛，词间隔约 4f；副标题在标题收完前就错峰跟进 |
| brace-expand | 中 | 一对紧贴的小花括号先在正中出现，随即带一次过冲向左右弹开并放大到标题级，文字 clip 宽度严格绑括号内缘、像被拉开幕布般从中间揭示，落定后字距再细微松弛 |
| countdown-arc-scatter | 高 | 纸面表盘 9 个等大数字沿大弧切向排布，整盘扫过 96° 后减速急停，"5" 停在弧顶随即平移落位成标题首字符，其余数字带 blur 原地散去，标题逐词模糊淡入、末词转强调色 |
| document-typewriter-reveal | 低中 | 悬浮在暗场里的整页真排版文档窗口在光标后自己"写"出来、侧栏跟进、历史条目逐个落入轨道，相机从斜侧标题特写一路后撤到全窗 |
| flying-words | 高 | 22 个关键词按黄金角铺在扁椭圆截面上，沿 z 轴从远处飞到相机前擦身而过，透明度走 [0,1,0.5,0.2,0] 生命曲线，跑满 2 整圈首尾无缝 |
| glitch-cycle | 中高 | 同一行等宽槽位循环轮播 4 条状态短语，每条头尾按概率关键帧 [1,0,0,0.1,0,0,1] 全乱码、中段偶发单字抖动，切换瞬间叠 RGB 分离与整行位移；末条概率收 0 保证收尾干净 |
| gradient-word-sweep | 高 | 黑底标语里关键词被渐变彩光从左到右快速扫过"充能"——波前字符辉光最强向后衰减，填满后字符间勾连细紫红闪电、整词稳态泛光呼吸 |
| lead-word-zoom-assemble | 中高 | 首词以 2.3 倍字号占据画面中央、hold 期间继续推近 6%，随后一条曲线同时完成「缩回终字号」与「整行左滑归位」，后续词各自从槽位右侧 0.5em 被推进来；支点横向钉首词中心、纵向钉基线（挂载时实测），整行上移的同一时窗副行浮出，停一拍后整幕 crash-zoom 推近失焦交棒 |
| marker-underline-title | 低 | 大标题落定后，关键词下方马克笔下划线从左到右快速描画——变宽笔形、毛糙边缘、微上斜跟随斜体字势，贴着字底 |
| outline-word-fill | 高 | 空心词（细暖灰描边、500 字重）从 3.2 倍急缓收缩落位，虚线大圆随后从 2.8 倍收到字周围并缓慢自转，左右水平虚线从画框边缘内伸；描边先微微增亮，实心白热字在一帧内硬切点亮，一闪辉光即定格 |
| paper-title-card | 低 | 一句话逐词压印上纸、一个词标强调色斜体、短划线收束 |
| pill-chip-slot-cycle-handled | 中 | 白底句式 "Your `chip` Handled" 里深色胶囊内词竖向滚轮轮换，胶囊宽度按预量文本宽插值平滑伸缩、两侧文字被自然挤开收拢，胶囊上下露出 13% 透明度的灰色幽灵项 |
| pill-slot-cycle | 中 | 句中词槽轮换——固定句干钉死不动，句尾 pill 徽章每 ~0.7s 老虎机滚一格（旧的上飞加速淡出、新的从下带模糊滑入），连换 N 个功能词后落成完整句子收束 |
| text-column-converge | 中低 | 双词对峙合拢——左"NEW"右特性词钉死在等屏边距两侧硬切轮换、全程零收缩，换到最后一词才唯一一次 ease-in-out 滑到居中咬合成短语，下方小字近乎硬切浮现；收尾揭晓型文字卡 |
| title-demote-to-label | 低中 | 大标题降格为节标签两式——A 大标题居中显影站稳一拍后连续缩小 0.3x 平移到左上角落成小节标签、内容区在其下生长；B 同套路但登场时带文本选中态高亮块扫入再撤掉 |
| type-assembly-moves | A 中 / B 中高 / C 中 | 文字集结三式——split-text-stagger 逐字裂升、letterform-drift-assembly 漂移合拢、text-on-path 沿线流入 |
| type-entrance-moves | 中高 | 标题文字入场一式——letter-drop-physics 字符坠落（重力砸落、弹跳、歪斜站定，最后一拍集体立正归位） |
| type-rhythm-sync | A 高 | 文字随声同步两式——font-weight-pump 字重脉冲（笔画随鼓点变粗弹回）与 karaoke-fill-sync 卡拉OK填色（词随旁白逐个点亮） |
| typewriter-moves | 中低 | 打字机 error-retype——误删重打的"改口"三幕剧：打出平庸词 → 犹豫 → 退格删掉 → 更快打出卖点词 |
| vertical-word-roll-blur-cycle | 中 | 句尾词换成竖向滚轮，3 次换词各 0.55s（outQuint 七成 + outBack 三成，前快后极慢带微过冲），相邻行按距离上垂直 blur 与灰度，中心词落定瞬间从灰染成强调色 |
| word-relay-filmstrip | 中低 | 左列黑白相间等高页面卡步进滚动（焦点卡全亮、邻卡离焦压暗）、右侧衬线大词原位接力（名词恒定+动词轮换）——切词瞬间才滚动一格，词块垂直中心与当前页面卡中点精确对齐 |
| word-relay-geometry | 中高 | 三个利益词各带一套专属几何接力——虚线大圆减速自转 + 彗星弧飞跑 → 三实线圆 trim 依次生长后收拢咬紧 → 镀铬金属 sheen 扫过后一拍收成纯白；旧词缩到 0.86 淡出，新词描边→填充揭示 |

## ui-entrance

**UI 入场**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| avatar-bracket-carousel | 中 | "Your ___ agent" 填空排版，四角对焦框钉在句中不动，头像队列在框内垂直 spring 轮换三次，入框放大清晰、出框按距离缩小淡化模糊，角色标签同步更换，切换瞬间对焦框呼吸 7% |
| bezier-source-converge-merge | 中 | 左侧四个来源节点各有一条细贝塞尔曲线连向右侧同一汇聚点，曲线先错峰由左向右 draw-on，节点沿自己的曲线滑向汇聚点并三段式加速缩小到消失，强调色数据包全程沿路径滑行，吞并完成后曲线从左端反向擦除只留品牌标志（demo：白瓷圆片托 video-shotcraft 镜刻标志） |
| card-stack | 中高 | 一组模板卡（demo 9 张）从屏幕下方逐张 spring 弹入、越落越快叠成一摞，全员落位后整摞一次性展成扇面——每张按序号偏转 6.5°、横移 138px，最后中心卡被抽出 |
| carousel-3d | 中 | 8 张卡排成圆环整环自转一圈（匀速底 + 每 45° 一次停靠的分步），每卡只绕 Y 公转、自身 billboard 朝外，正反两层同向贴图配 backface-visibility:hidden 保证任何时刻都正立不倒置，正前方卡被点亮、环下字幕随之换字，相机全程钉在浅俯角 |
| cloner-depth-echo | 中 | 克隆纵队——主卡瞬间"复印"出 7 个半透明分身沿斜向纵深排开成队，停一拍后全体加速吸回本体合一+弹跳 |
| deck-deal-flyin | 高 | 暗色石墨桌面上的实体牌堆特写环绕开局，灯从牌堆亮到旁边的页面板，一摞卡像发牌一样硬加速甩进网格，相机追着发牌升起后仰、落在整块满板的跑道式俯瞰上定格 |
| doc-park-left-pill-deal | 低 | 文档不淡出而是向左滑出只露约 35% 宽并微缩到 0.92，右侧按旁白节奏慢速发牌三张白底描边药丸（outBack 弹入），每张落定后其下方字幕逐词加深、下一张到来前整句淡出，左侧文档全程极缓慢自动滚动保持"正在被读" |
| draw-svg-trace | 中 | 描边生长圈注——一条带笔头的墨线沿元素轮廓跑一圈把它"画"出来，闭合瞬间闪黑交棒、内容淡入；同套路可给标题画下划线 |
| element-body-moves | A 低中 | 元素身体感——contact-shadow-lift 接触阴影离面抬升：卡抬起时桌上的阴影同步放大变淡，纸片离桌被阴影证明 |
| integration-hub-map | 中高 | 旧页面一次性快翻 180°（侧棱瞬间亮闪）落成新中枢页，五个集成 app 图标同帧弹现、随即五条彩虹光管同帧齐连，光管内输送脉冲持续流动——"翻开新一页，生态一齐接入" |
| list-reveal | 低 | 垂直菜单 6 项按 10f 的间隔依次 scale 找位、软 back 轻微过冲落定，同时整个列表容器全程匀速上移——逐项入场与整体漂移是两层不相干的运动 |
| list-stack-press | 中 | 列表卡从画面底部逐张飞上摞起，每张落地压弹整摞、计数器同步跳一格 |
| neon-frame-forerun | 中高 | 强透视直角霓虹框自左缘两头奔画先行成型，页面在框内由暗转亮，同时框内组件/文字从 3D 上空带同形软影错峰贴落、随页面点亮同步完成贴合，背景霓虹群（demo 为同形框纵深回声隧道）终段熄灭让位 |
| neon-frame-orbit-drop | 中高 | 霓虹框先行描框后，镜头绕页面左→右弧线旋转，页面全部组件/文字**同帧**从空中往下贴合（同形软影同步收敛）——整体登场式的框内安放 |
| page-waterfall-wall | 中 | 页面瀑布墙——真实页面截图切成 3–4 列在 3D 后仰墙面上差速反向无限滚动，视差 + 镜头缓推做"内容多到流不完"的一览 |
| product-card-progressive-assemble | 中 | 详情卡像被逐字段抓取般自建——一枚"填充光标"领先跳格，图→标题→分类 pill 依次 pop→原价出现后被划线降级、强调色新价 spring 跳出→正文逐行揭示且高亮块由左向右刷过→色卡点亮→按钮填满，整卡全程极慢 scale 前推 |
| radial-wave | 中高 | 17×9 圆点阵列按到波源的欧氏距离错峰点亮，每点 scale 过冲到 1.5 再落回常亮，第一道波扫完后第二道亮蓝脉冲从外圈反向收拢回中心 |
| research-card-stack-scroll | 中高 | 深色论文卡每 12 帧一张沿右下轴线飞入中心叠压，落位带 1 帧压缩，只有最上一张全清晰渲染标题+作者+摘要，下方卡按堆积深度递增模糊变暗只露标题条，背景横向 grid 同步下移做速度参照 |
| row-embed | 中 | 内容行像卡片一样从空中降下、rotateX 收平、嵌入瞬间底边亮一道强调色的缝 |
| value-stagger-gradient | 中高 | 16 根柱入场时 delay 是时间错峰，同时高度/色相/位移/模糊四个属性各自铺成从首到末的数值梯度；第二拍把错峰原点换成中心，脉冲幅度以中心为最大重新铺开 |
| wall-reveal-moves | 中 | 整墙批量入场两式——bento 逐格点亮、蓝图描线成形，全部原位显形不位移，与 deck-deal-flyin 的飞入位移型互补成品类矩阵 |

## effects

**特效与材质**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| assemble-then-type-flyin | 中高 | 空的暗底网格上，无文字的组件骨架先从四面八方飞入贴合；随后各处文字逐字从 3D 空间旋转着飞来落位，先大标题后小标注，全部落位后页面成形 |
| aurora-bloom-bg-flip | 由低到高 | 浅灰底从底部升起紫橙柔焦 blob，随后整个底色在约 0.36s 内压暗到近黑、blob 压成余晖；文案同步 blur-out 换句 blur-in，换句间留空档不 cross-fade |
| brand-frame-snap | 中 | 品牌色画框语法——一圈粗纯色画框先于内容长出包住全屏，录屏窗口落进框内；模式切换时整圈画框同帧硬翻色+窗内布局同帧换，一个 borderColor 干完章节导航/状态提示/品牌露出三件事 |
| fui-hud-moves | 中高 | FUI/HUD 准星咬合——reticle-lock-on 四个 L 形角标组成的取景框从画外飞入、超调回弹后咬合锁定目标 |
| glow-flyline-moves | A 低 | 暗场光斑与飞线三式——glow-orb-ambient 光斑底噪、flyline-arc 飞线连接、orb-flyline-relay 同帧共振组合 |
| icon-performance-moves | 蓄势引入 | 图标表演——attention-bounce 求关注弹跳（图标连跳递增+落地压扁+镜头被吸引） |
| impact-feedback | 高 | 命中反馈两式——hit-counter 连招计数（顿帧+伤害数字+combo 跳字）、anime-impact 动漫打击帧（负片+集中线+色散） |
| light-play-moves | A 中 / B 低 | 光效两式——spotlight-sweep 聚光扫字、sheen 单点扫光 |
| radial-ripple-phone-chips | 低 | 暖沙底四层同心圆错相呼吸如水波，中央手机 mockup 屏内 feed 自动缓滚，两侧白色 chip 先后 spring pop 入场并悬浮 |
| riso-print-hits | 高 | 套印错位冲击帧——riso-misregistration-hit 单发：标题撞停瞬间裂成双色 riso 印版，抖两下"啪"地套准 |
| scan-bracket-sweep | 中低 | 文档弹到中央，四角落下 L 形取景括号，一条扫描光带拖着渐变尾迹在文档上往复扫 5 趟——文档全程静止，只有光在读它 |
| scanline-annotate-focus | 中 | 一条扫描线自上而下匀速掠过已存在的页面，越过哪块区块的下缘，哪块就被四角取景框从外扩处弹簧收拢对准（一次过冲），随后贴出一枚逐字打出的机器标签，顶部状态行同步计数 00/06→06/06 |
| scanline-assemble-flyin | 中高 | 页面开场是一张只有网格与虚线槽位的蓝图画板，一条亮扫描线自上而下掠过；扫到每个槽位，该处组件就从画外飞入过冲贴合，带方向性残影模糊与落位咬合角标——扫完整页恰好装配完成 |
| slam-entrance-moves | 高 | 高能砸入三式——kanada-perspective-snap 金田透视急停、score-slam 比分砸落、impact-burst-kit 落点冲击套件（波及邻卡） |
| spotlight-sweep-moves | 中低 | 暗场聚光显影三式——A 醒睡扫过（光到即亮光走即暗）、B 贴边泛光横摇（紫光贴 UI 边缘渗入+聚光匀速右移）、C 角落匀速显影（径向聚光从角落匀速扩张点亮全屏）；黑场里"光即叙事"的 UI 展示 |

## data

**数据可视化**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| before-after-slider-scrub | 中 | 前后对比拉杆——"处理前/后"两版叠放，分割杆先猛甩后慢扫，杆过处新版"显影"揭出 |
| chart-live-moves | 中高 | 活体图表三式——oscilloscope-stream 示波流线（曲线右端实时写入+突发尖峰）、unit-dot-swarm-regroup 点阵重组（点群三幕迁徙聚成数字）、axis-rescale-shock 轴爆表重标（新值冲出画框逼 y 轴重标） |
| gauge-readout-moves | 中高 | 仪表读数两式——needle-sweep-selftest 满弧扫针（点火自检指针甩满全弧再回落真值）与 tape-scroll-fixed-pointer 滚带定针（针不动刻度带滚过+冲刺刹车） |
| scroll-brake-moves | 高开中收 | 长卷急刹两式——changelog-scroll-brake 基本款（高速长卷指数减速精准停位+目标抬升）与 brake-reticle-lock 组合款（急刹帧同帧准星咬合） |
| timeline-travel | 中高 | 时间轴横移——镜头沿水平刻度轴加速掠过版本刻度，每过一格卡片弹立短停，末刻度急停推近 |

## interaction

**交互演示**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| autolayout-gap-dial | 中 | 间距拨盘驱动布局——一排链接块带框选描边+缝隙间距标注，徽章数字逐格跳动、块被参数实时推开再弹簧回弹归位；"参数驱动布局"的可视化 |
| canvas-materialize-moves | 中 | 内容"物化上画布"两式——panel-to-canvas 行倒卡（面板表格行沿弧线飞出、跨容器变形成画布卡片）与 diagram-cascade 级联生成树（prompt 打字后节点逐层弹出、连线先于节点生长） |
| chip-grid-single-select-blackout | 中低 | 五个选项 chip 以 3+2 居中排布逐个淡入；选中帧先插一帧灰色按压块，紧接数帧内底色变墨黑、文字变白并做 1→1.04→1 极轻回弹，其余 chip 淡到 18% 但位置锁死；随后余项归零，黑 chip 上移收窄，下方升起结算价格 |
| collab-cursor-moves | A 低中 | 协作光标当演员——cast-ensemble 五光标群演氛围层（错峰飞入+正弦漂移+打字 cameo+聚拢围观） |
| glass-pill-dictation-typing | 低 | 一条定宽玻璃胶囊以约 1.25 倍略大弹出后缓落到位，内部自左淡到右浓铺一层强调色暖光；光标先行、随后匀速打出听写句，光（连同胶囊背后的环境光）随打字进度渐渐退去，收尾成一条中性的磨砂玻璃条 |
| hashtag-to-pill-materialize | 中 | 话题词打字实体化——居中打出 "#word"（红实心光标恒亮），1 帧硬切变成宽大胶囊标签，hold 后缩小左移落到页面标签位，再 1 帧硬切揭示成品页；"两次硬切一次滑动"的节奏骨架 |
| picker-carousel-feature-cycle | 中 | 移动端风竖向选择器——焦点药丸不动、内容穿过它，每项带明显 outQuint 减速吸附后完全静止，按到中心距离分层控制透明度/字号/灰度，落定时药丸做 scaleY 极轻呼吸 |
| segmented-thumb-hero | 中 | 分段控件 thumb 位移当主角特写——超大胶囊 segmented control 弹簧浮入，描边箭头光标画外滑入按下，白 thumb 8f ease-out 滑到另一段，到位瞬间新图标 spring 弹出、旧图标收起 |
| theme-switch-moves | A 中 / B 中高 | 主题切换两式——theme-sweep 斜向扫场（边界扫过处就地换肤）与 palette-ripple 组合款（⌘K 面板收缩成点、涟漪从点荡开换肤） |
| type-and-filter | 中 | 真实 UI 上打字搜索、网格自己收敛成一张卡、点击穿透进详情页 |
| voice-waveform-live | 中 | 录音胶囊实时声纹——64 根细竖条随"说话"起伏，说话时中部高耸、停顿缩成点线，波形从右往左滚动；说→停→说→提交塌缩的完整表演 |

## rhythm

**节奏与剪法**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| beat-cut-moves | 高 | 硬切当节拍乐器——连闪定格：三次白闪各硬切同一画面的一个裁切（全景→卡片→特写），快门余韵沉降后停在特写收束 |
| beat-step-list-theme-cycle | 高 | 三通道节拍器——深色场形容词列表逐拍上移一行，视口中央固定胶囊"接住"下一个词并换色，整场底色同拍跟换；行、色、场三通道锁死同一拍点 |
| panel-grid-moves | 中高 | 分格节奏——comic-panel-split 漫画斜格劈出同一主体的三个机位，咔咔咔三格定格后末格斜边吃屏成海报 |
| quad-split-parallel-scenes | 高 | 画面硬切 2×2 四宫格，四个象限并行跑各自的微场景（打字、急推、逐词、交互链），关键节拍错开 3–6 帧制造信息轰炸 |
| rhythm-interrupt-moves | A 中 | 打断节奏——jump-cut-punch-in 三级跳切推近：同构图三次无补间硬跳放大，逐级逼近目标 |
| sakuga-timing-shift | 中高 | 一拍三转一拍一——元素先以每 3 帧一步的手翻书顿挫移动，高潮瞬间切成逐帧丝滑冲刺，帧率量化的突变本身就是看点 |
| speed-ramp-freeze | 中高 | 帧号非线性 remap 的节奏手法——定格标注（流动→定格圈注→解冻） |
| trailer-grammar-moves | A 高 | 预告片语法一式——trailer-bumper 前置速剪钩子：三镜 9f 速剪 + 黑场静默一拍，再开场标题 |

## transition

**转场**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| bottom-push-stack-wipe | 中 | 底边上推换章——新场景连底色整屏从底边向上推入，把旧场景物理顶出画外，连推数章各配一种饱和底色，内容钉死在各自色底坐标系里随底色走 |
| card-flip-reveal | 中高 | 功能卡 3D 翻面揭示——卡片沿 Y 轴翻 180°，正面 UI 翻到侧棱最薄处掠过一道随角度移动的受光，背面揭出大号结论数字，逐张错峰扫过整排 |
| card-flock-tumble | 极高 | 三张 UI 页卡从侧棱薄边 3D 翻飞成阶梯站定（全程清晰、样条连续丝滑），站定后保持慢转不停，快速收束吸入中心，炸出单个湍流烟雾环扩散，巨字横贯收场 |
| circle-match-iris | 中高 | 圆心匹配光圈切——光圈从页面上圆形元素的圆心炸开，圈内新页的圆形图表接在同一个圆上；匹配剪辑给光圈一个语义锚点 |
| gradient-transition | 低 | 背景在 linear、radial、conic 三类 CSS 渐变间平滑过渡——角度、色标、中心、半径逐参数插值，段间交叉淡化换类型 |
| line-carry-transition | 中 | 线条接力横移转场——场景 A 的进度条延伸出画，镜头跟线横移，线在移动中拐角围出场景 B 的卡框，全程无剪切 |
| mosaic-reframe | 中 | 12 张瓦片在规则网格、feature mosaic、对角瀑布串三种排版间连续变形，位置宽高各自插值、逐片微错峰，段间留 hold |
| page-turn-transitions | 中高 | 整页体块转场——barn-door-split 对开门裂幕（旧页裂两半滑出、新页迎上） |
| print-texture-transitions | 中 | 印刷质感转场——ink-bleed-reveal 墨渗揭示（须状渗边洇开吃掉旧景） |
| shot-transitions | n/a | 镜头交棒三式——推进流白、whip-pan 甩镜（急刹款）、mask-wipe 穿窗（纵深款），按能量落差与接缝语义选型 |
| tear-streak-transitions | 高 | 撕裂转场——glitch-displace 噪声撕裂（16 横条错位抖动中硬切），数字故障语义的条带级撕裂 |
| transition-hidden-cut | n/a | 藏切点转场三式——前景遮挡隐形切、对撞开屏、暖色漏光，硬切藏进遮挡/撞击/光峰的 1-3 帧里，观众看不见剪刀 |
| transition-travel | n/a | 穿越式转场——字腔穿越：巨型章节标题的字形就是一扇窗，镜头钻进字形笔画完成换景 |
| white-flash-logo-simplify-cut | 中高 | 液态金属质感的彩色词标静置流光，蓄力后从字心炸出一记白闪过曝，曝光回落时同一位置已是扁平版字标——一次闪白完成质感降维 |
| wipe-transitions | 中 | 几何擦除转场——blinds-slice 百叶窗切条（12 根 3D 叶片错峰翻面成波，波扫过后整页由 A 换成 B） |

## outro

**收尾**

| 卡名 | 能量 | 一句话 |
| --- | --- | --- |
| grain-dissolve | 中高 | 整行字爆裂成沸腾颗粒噪点并浮现斜纹选区框，噪点云急速凝聚成更大号发光短字标，位移衰减归零定格 |
| logo-shrink-wordmark-lockup | 中 | 霓虹切口大环快速收束成中央实心小白 O、过冲刹车时换成 video-shotcraft 标志，图标左移让位，字标字母逐个滑入完成 lockup，强调色标语收尾 |
| neon-triple-marquee | 中高 | 三行对向霓虹跑马灯 recap——三连词空心霓虹灯管巨字上中下排满一面斜拍的砖墙，奇偶行反向匀速无限横滚，三行按 1/3 相位轮流点亮，结尾逐行断电 |
| outro-group-photo-launch | 峰值 | 全片元素从四面八方飞来围住字标合影，crane 落机位+舞台光+金尘做成发布会收场 |
| ui-strip-away-outro | 中 | 减法式收尾——点击 Publish 后整个编辑器 UI 从外围到中心层层错峰蒸发，黑场上只剩那颗按钮滑到屏心放大，按钮再淡出交棒字标定版 |
| ui-to-brand-morph | 中高 | UI 变品牌两式——icon-flip-bloom 图标 Y 轴翻扁成竖线、从竖线撑开成品牌标志（琥珀斜切随后划入）+ wordmark 逐字落定，与 input-morph-assemble 输入框收缩成取景框竖笔、三块图元落进构造槽位拼成完整标志 |

---

## 选型速查

| 这一拍要给什么 | 先看哪族 | 代表卡 |
| --- | --- | --- |
| 「点名」某个功能/数字 | 运镜 | crash-zoom-punch、cursor-flyover |
| 信息量大、源源不断 | UI 入场 | deck-deal-flyin、page-waterfall-wall |
| 一句主张要立住 | 字形与排版 | blur-slide、marker-underline-title、type-entrance-moves |
| 数据在动 | 数据可视化 | chart-live-moves、gauge-readout-moves |
| 换章、换语境 | 转场 | shot-transitions、transition-hidden-cut |
| 副歌/重音 | 节奏与剪法 | beat-cut-moves、quad-split-parallel-scenes |
| 收住、留品牌 | 收尾 | logo-shrink-wordmark-lockup、ui-strip-away-outro |
| 铺垫、留白 | 开场 / 特效 | brand-ink-open、aurora-bloom-bg-flip |

## 使用纪律（来自上游判例）

1. 一种手法全片只当一次主角；同族卡片互斥选用，不在同一片里重复。
2. 高能量卡在 30s 片子里合计 ≤6 次，且不要连续两张都放高。
3. 每张卡的参数是**占位素材上的调校起点**，首次实战必须用真实素材回验。
4. 卡片自带 demo 时长（多数 120–250 帧）；缩短时先砍 hold，不砍动作弧。


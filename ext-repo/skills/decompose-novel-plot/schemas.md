# 小说剧情拆解 — YAML 模板

各 `input_text` 的 `text` 与对应 `.yaml` 文件内容一致。可增字段，勿删下列核心键。

## 人物.yaml（本幕）

```yaml
act: 1
act_title: 暮色密约
characters:
  - name: 林夏
    ref: 人物/林夏
    role_in_act: 主角
    aliases: []
    goal: 取回被扣的信物
    obstacle: 守夜人盘问
    state_in: 疲惫、戒备
    state_out: 握有信物、对同盟产生怀疑
    relations:
      - target: 顾衡
        type: 临时同盟
        note: 本幕末出现裂痕
    evidence: 明示
```

## 情节.yaml

```yaml
act: 1
act_title: 暮色密约
summary: 一句话本幕梗概
beats:
  - order: 1
    title: 潜入
    what: 林夏翻墙进入旧仓
    cause: 信物被藏于此
    effect: 惊动守夜人
  - order: 2
    title: 对峙
    what: 与顾衡短暂合作脱身
    cause: 共同敌人出现
    effect: 信物到手，信任动摇
conflict:
  external: 守夜人追捕
  internal: 是否相信顾衡
climax: 屋顶交换信物时顾衡隐瞒来源
outcome: 林夏带信物离开，约定次日河埠见面
hooks_to_next:
  - 河埠可能是陷阱
```

## 结构.yaml

```yaml
act: 1
act_title: 暮色密约
arc:
  setup: 旧仓、夜色、任务目标明确
  rising: 潜入失败风险升高，引入同盟
  climax: 信物交接与隐瞒
  falling: 撤离与约定
pov: 有限第三人称偏林夏
timeline:
  story_time: 秋季某夜至黎明前
  narrative_order: 顺叙
foreshadowing:
  - plant: 顾衡袖口泥印与河埠一致
    payoff_act: null
devices:
  - 信息差
  - 不可靠同盟
```

## 主题.yaml

```yaml
act: 1
act_title: 暮色密约
themes:
  - name: 信任的代价
    how: 合作必要却伴随隐瞒
  - name: 夜与边界
    how: 城墙内外、合法与违法的模糊
symbols:
  - item: 信物
    meaning: 身份与把柄的双重象征
act_function: 建立核心人物关系张力，抛出主线物件
```

## 环境背景.yaml

```yaml
act: 1
act_title: 暮色密约
setting:
  era: 近古城邦
  season: 秋
  time_of_day: 夜→黎明
locations:
  - name: 旧仓
    ref: 场景/旧仓
    role_in_act: 主场
    atmosphere: 潮冷、尘土、远处更鼓
  - name: 城墙外侧
    ref: 场景/城墙外侧
    role_in_act: 进出路径
social_rules:
  - 宵禁后民人不得近仓区
background_facts:
  - 旧仓曾属商会，现由守夜人代管
```

## 语言风格.yaml

```yaml
act: 1
act_title: 暮色密约
tone: 克制紧张，偶有冷幽默
diction: 短句为主，动作动词密集
rhetoric:
  - 通感（夜色的重量）
  - 少用直白心理，多用动作暗示
dialogue:
  style: 半文半白，信息量大、情绪压低
  sample_traits:
    - 林夏：简短、回避解释
    - 顾衡：圆滑、话里有话
pacing: 前慢后快，高潮处段落缩短
style_tags:
  - 悬疑
  - 硬派潜入
  - 低调抒情
reusable_notes: 续写时可保持「动作先于解释」的叙述习惯
```

## 全局：人物/{姓名}.yaml

```yaml
name: 林夏
aliases: [夏姐]
refs_from_acts: [1, 2]
identity: 前商会学徒
appearance:
  age_look: 二十出头
  features: 左手旧烫伤疤
personality: 冷静、多疑、重诺
motivation: 查清商会旧案
abilities: [翻墙、开简易锁]
relationships:
  - target: 顾衡
    type: 不稳定同盟
state_timeline:
  - act: 1
    state: 取回信物，开始怀疑顾衡
costume_variants: []
facts: []
inferences: []
notes: []
revisions: []
```

## 全局：场景/{场景名}.yaml

```yaml
name: 旧仓
aliases: [北仓]
refs_from_acts: [1]
location_type: 仓储建筑
era: 近古城邦
layout: 两层木构，屋顶可通行
entrances: [西侧墙洞, 正门（宵禁锁闭）]
exits: [屋顶→城墙]
landmarks: [锈蚀吊钩, 商会旧印]
lighting: 月光从破窗切入
weather_default: 秋夜有雾
atmosphere: 潮冷、灰尘、远处更鼓
interactive_objects: [木箱堆, 信物暗格]
scene_variants:
  - act: 1
    state: 夜、有守夜人巡逻
notes: []
revisions: []
```

## 全局：索引.yaml（可选）

```yaml
characters:
  - name: 林夏
    path: 人物/林夏.yaml
scenes:
  - name: 旧仓
    path: 场景/旧仓.yaml
last_updated_act: 1
```

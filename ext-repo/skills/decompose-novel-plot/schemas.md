# 小说剧情拆解 — YAML 模板

各 `input_text` 的 `text` 与对应 `.yaml` 一致。可增字段，勿删核心键。  
`evidence` 形如：`{ quote, approx_locus, confidence }`；快速档可省略 `quote`。

---

## 幕内：人物.yaml

```yaml
act: 1
act_title: 暮色密约
active_slice: true
characters:
  - name: 林夏
    ref: 人物/林夏
    status: 正式
    role_in_act: 主角
    aliases: []
    goal: 取回被扣的信物
    obstacle: 守夜人盘问
    state_in: 疲惫、戒备
    state_out: 握有信物、对同盟产生怀疑
    relation_stages:
      - target: 顾衡
        stage: 临时同盟→裂痕
    evidence:
      - quote: 她摸了摸袖中空处
        approx_locus: 段首
        confidence: explicit
```

## 幕内：情节.yaml

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
    evidence: []
conflict:
  external: 守夜人追捕
  internal: 是否相信顾衡
climax: 屋顶交换信物时顾衡隐瞒来源
outcome: 林夏带信物离开，约定次日河埠见面
hooks_to_next:
  - 河埠可能是陷阱
```

## 幕内：结构.yaml

```yaml
act: 1
act_title: 暮色密约
arc:
  setup: 旧仓、夜色、任务目标明确
  rising: 潜入风险升高，引入同盟
  climax: 信物交接与隐瞒
  falling: 撤离与约定
pov: 有限第三人称偏林夏
timeline:
  story_time: 秋季某夜至黎明前
  narrative_order: 顺叙
devices:
  - 信息差
  - 不可靠同盟
```

## 幕内：主题.yaml

```yaml
act: 1
act_title: 暮色密约
themes:
  - name: 信任的代价
    how: 合作必要却伴随隐瞒
symbols:
  - item: 信物
    meaning: 身份与把柄的双重象征
act_function: 建立关系张力，抛出主线物件
```

## 幕内：环境背景.yaml

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
forces_active:
  - ref: 势力/守夜人
social_rules_slice:
  - 宵禁后民人不得近仓区
```

## 幕内：语言风格.yaml

```yaml
act: 1
act_title: 暮色密约
tone: 克制紧张，偶有冷幽默
diction: 短句为主，动作动词密集
rhetoric:
  - 通感（夜色的重量）
dialogue:
  style: 半文半白，情绪压低
  sample_traits:
    - 林夏：简短、回避解释
    - 顾衡：圆滑、话里有话
pacing: 前慢后快
style_tags: [悬疑, 硬派潜入]
feed_to_style_asset: true
```

## 幕内：伏笔.yaml

```yaml
act: 1
act_title: 暮色密约
items:
  - ledger_id: FORESHADOW-001
    action: plant
    content: 顾衡袖口泥印与河埠一致
    status: 待兑现
    evidence:
      - quote: 袖口一道干泥
        confidence: explicit
  - ledger_id: FORESHADOW-001
    action: advance
    content: 约定河埠见面，泥印暗示关联
    status: 紧急
```

## 幕内：事实.yaml

```yaml
act: 1
act_title: 暮色密约
facts:
  - ledger_id: FACT-001
    text: 信物曾藏于旧仓暗格
    confidence: explicit
    evidence: []
inferences:
  - ledger_id: FACT-INF-001
    text: 顾衡可能早到过河埠
    confidence: inferred
    evidence: []
```

---

## 世界书 / 规则：世界概要.yaml

```yaml
name: 近古城邦
genre_base: 悬疑 / 江湖
era_background: 近古、宵禁城邦
core_theme: 信任与把柄
tone_tags: [压抑, 阴谋]
summary: 商会旧案阴影下的夜城
```

## 世界书 / 规则：世界规则.yaml

```yaml
reality_stability: stable
supernatural_visibility: hidden
power_ceiling: low
death_reversibility: none
truth_accessibility: partial
core_taboos:
  - 不轻易复活关键死者
narrative_constraints:
  - 信息差驱动，避免全知开挂
recommended_conflict_types:
  - 同盟背叛
  - 机构压迫
```

---

## 世界书 / 人物：人物/{姓名}.yaml

```yaml
name: 林夏
aliases: [夏姐]
depth: 标准
status: 正式
refs_from_acts: [1, 2]
identity: 前商会学徒
appearance:
  age_look: 二十出头
  features: 左手旧烫伤疤
appearance_timeline:
  - act: 1
    look: 夜行短打
    costume: 深色劲装
    state: 疲惫戒备
    scene_anchor: 旧仓屋顶
personality: 冷静、多疑、重诺
motivation: 查清商会旧案
abilities: [翻墙, 开简易锁]
relationships:
  - target: 顾衡
    type: 不稳定同盟
    stage: 裂痕初现
known_facts:
  - FACT-001
state_timeline:
  - act: 1
    state_in: 疲惫、戒备
    state_out: 握有信物、怀疑同盟
    pressure: 宵禁与追捕
facts: []
inferences: []
notes: []
revisions: []
```

## 世界书 / 人物：待确认/{姓名}.yaml

```yaml
name: 守夜人甲
status: 待确认
depth: 简要
refs_from_acts: [1]
identity: null
role_guess: 障碍型龙套
appearance: {}
notes:
  - 仅本幕追捕出现，身份锚点不足
promote_to: null
```

---

## 世界书 / 场景：场景/{场景名}.yaml

```yaml
name: 旧仓
aliases: [北仓]
refs_from_acts: [1]
location_type: 仓储建筑
level: core_scene
public_image: 废弃商会仓库
hidden_truth: 暗格曾藏信物
function: 潜入与交接主场
access_rule: 宵禁后禁入
exit_cost: 惊动守夜人
risks: [巡逻, 屋顶湿滑]
story_value: 承载第一次同盟裂痕
layout: 两层木构，屋顶可通行
entrances: [西侧墙洞]
exits: [屋顶→城墙]
landmarks: [锈蚀吊钩, 商会旧印]
lighting: 月光破窗
atmosphere: 潮冷、灰尘、更鼓
interactive_objects: [木箱堆, 信物暗格]
linked_forces: [势力/守夜人]
scene_variants:
  - act: 1
    state: 夜、有巡逻
notes: []
revisions: []
```

---

## 世界书 / 势力：阵营/{名}.yaml

```yaml
name: 守秘派
belief: 旧案真相不可外泄
goal: 维持城邦表面秩序
fear: 商会黑幕公开
methods: [封锁, 夜巡]
style: 低调高压
narrative_value: 制度性压迫来源
```

## 世界书 / 势力：势力/{名}.yaml

```yaml
name: 守夜人
belongs_to_faction: 阵营/守秘派
nature: 机构
scope: local
public_identity: 城防治安
hidden_agenda: 替商会旧势力看守仓库
resources: [宵禁权, 兵器]
methods: [盘问, 追捕]
pressure_style: 合法暴力与地盘封锁
story_value: 本幕外部冲突发动机
```

## 世界书 / 势力：特殊要素/{名}.yaml

```yaml
name: 信物
category: item
effect: 证明旧案关键环节
cost: 持有即成把柄
risk: 被多方争夺
rarity: unique
controlled_by: []
known_by: [人物/林夏, 人物/顾衡]
story_value: 主线麦高芬与信任试金石
```

## 世界书 / 势力：关系.yaml

```yaml
force_relations:
  - from: 势力/守夜人
    to: 势力/旧商会残部
    relation: exploitative
    reason: 代为看守
    stability: unstable
location_control:
  - location: 场景/旧仓
    controlled_by: 势力/守夜人
    control_type: covert
element_links:
  - element: 特殊要素/信物
    owner_type: location
    owner_id: 场景/旧仓
    relation_type: seal
```

---

## 世界书 / 账本：伏笔账本.yaml

```yaml
items:
  - id: FORESHADOW-001
    content: 顾衡袖口泥印指向河埠
    planted_act: 1
    expected_payoff_act: null
    status: 紧急
    related_chars: [顾衡, 林夏]
    related_locs: [场景/旧仓]
    history:
      - act: 1
        action: plant
      - act: 1
        action: advance
```

状态枚举：`待兑现` | `紧急` | `已回收` | `失效`

## 世界书 / 账本：事实账本.yaml

```yaml
facts:
  - id: FACT-001
    text: 信物曾藏于旧仓暗格
    established_act: 1
    confidence: explicit
    status: 有效
    refs_from_acts: [1]
inferences:
  - id: FACT-INF-001
    text: 顾衡可能早到过河埠
    established_act: 1
    confidence: inferred
    status: 有效
    promotes_to_fact: null
```

---

## 世界书 / 写法：写法资产.yaml

```yaml
version: 1
sources_acts: [1]
narrative_rules:
  - 动作先于解释
  - 信息差驱动场景
character_voice_rules:
  - 林夏：短句、回避动机说明
  - 顾衡：圆滑、话中有话
pacing_rules:
  - 潜入段可慢，冲突段加快、段落缩短
anti_template:
  - 少用空洞抒情与解释性旁白
  - 避免「不禁想起」式套话
feature_pool:
  - id: STY-001
    text: 通感写夜色重量
    enabled: true
    from_act: 1
```

---

## 世界书根：索引.yaml

```yaml
depth_used: 标准
last_updated_act: 1
characters:
  - name: 林夏
    path: 人物/林夏.yaml
    status: 正式
pending_characters:
  - name: 守夜人甲
    path: 待确认/守夜人甲.yaml
scenes:
  - name: 旧仓
    path: 场景/旧仓.yaml
factions:
  - name: 守秘派
    path: 势力/阵营/守秘派.yaml
forces:
  - name: 守夜人
    path: 势力/势力/守夜人.yaml
elements:
  - name: 信物
    path: 势力/特殊要素/信物.yaml
ledgers:
  foreshadow: 账本/伏笔账本.yaml
  facts: 账本/事实账本.yaml
style_asset: 写法/写法资产.yaml
act_slices:
  - act: 1
    title: 暮色密约
    path_prefix: 第1幕/
    active_chars: [林夏, 顾衡]
    active_scenes: [旧仓]
    active_forces: [守夜人]
```

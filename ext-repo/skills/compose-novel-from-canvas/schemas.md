# 画布合成小说 — 大纲与成稿模板

本 skill 的主交付是**小说正文**（Markdown）。可选在画布写入「成稿大纲」YAML，便于续写与对账。  
字段可增，勿删核心键。拆解侧 YAML 形态见同仓库 `decompose-novel-plot/schemas.md`。

---

## 成稿大纲.yaml

```yaml
source: canvas
skill: compose-novel-from-canvas
depth: 标准   # 速写 | 标准 | 长卷
pov: 有限第三人称偏林夏
tense: 过去时叙述
title: 暮色密约·合成稿
acts_used:
  - act: 1
    act_title: 暮色密约
    chapter: 1
    chapter_title: 旧仓
  - act: 2
    act_title: 河埠
    chapter: 2
    chapter_title: 空船
worldbook_refs:
  - 人物/林夏
  - 人物/顾衡
  - 场景/旧仓
  - 写法/写法资产
foreshadowing_plan:
  - id: fb_01
    action: plant   # plant | advance | payoff
    in_chapter: 1
  - id: fb_01
    action: payoff
    in_chapter: 2
gaps:
  - note: 顾衡来历仅 inferred，正文保持含糊
omissions:
  - note: 速写略去守夜人编制细节
```

---

## 合成小说.md（正文约定）

- 使用 Markdown：`#` 书名/总题，`##` 章，`###` 可选节。
- 一章对应一幕，或按用户要求合并/拆分；章序与 `acts_used` 一致。
- 正文为连贯叙事，**不要**把 YAML 键名写进读者可见段落。
- 章末可自然承接下一幕钩子，勿写「（钩子：…）」元注释。
- 若分节点存章：文件名 `合成小说/第01章-{短标题}.md`。

### 示例骨架

```markdown
# 暮色密约

## 第一章 旧仓

（叙事……）

## 第二章 河埠

（叙事……）
```

---

## 对账清单（撰写后自检）

- [ ] 每幕 climax / outcome 是否在对应章出现  
- [ ] 世界书人物名、别名、称谓是否统一  
- [ ] 本应回收的伏笔是否兑现；未到期的未提前剧透  
- [ ] 场景进入限制 / 宵禁等规则是否被违反却无交代  
- [ ] 语气是否符合写法资产与角色对话特征  
- [ ] 未把 `inferred` 写成铁板事实  

---

## 与幕内文件的映射（阅读用）

| 幕内文件 | 合成时用法 |
|----------|------------|
| 情节.yaml | 章骨架与事件顺序 |
| 人物.yaml | 本场谁出场、动机、状态进出 |
| 结构.yaml | 节奏、视角、时间 |
| 主题.yaml | 母题与象征落点（忌说教） |
| 环境背景.yaml | 时空、地点、氛围 |
| 语言风格.yaml | 句长、修辞、对话口吻 |
| 伏笔.yaml | 植入/推进/回收 |
| 事实.yaml | 可写实的硬信息边界 |

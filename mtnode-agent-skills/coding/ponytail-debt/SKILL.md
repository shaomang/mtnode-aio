---
name: ponytail-debt
title: 技术债台账（shortcut 标记扫集）
description: 把仓库里所有 `shortcut:` 注释（老代码可能是 `ponytail:`）扫成一张技术债台账，一次只读、不改码：每条按「文件:行号、简化了什么、ceiling、upgrade」一行，按文件分组；没写升级触发条件的那几条打 `no-trigger` 标记（这类才会悄悄烂掉），收尾报「N 条标记，M 条无触发条件」。用户说「ponytail 欠了多少债」「列一下哪些捷径」「技术债台账」时用。
version: 1.0.0
tags: 技术债,shortcut标记,台账,no-trigger,升级触发条件,扫集
---

# 技术债台账（`shortcut:` 标记扫集）

每一处「有意为之的 ponytail 捷径」都应该用一条 `shortcut:` 注释标注它的上限（ceiling）与升级条件（upgrade）。本技能把它们收进同一张台账，免得一次「先这样」悄悄变成永久。

标记写法与升级纪律来自同库主技能 `ponytail`（第 2 步的硬规则）；本技能只做**扫集与登记**，不改代码、不替用户判断该不该还债。

## 何时用

- 用户说「ponytail 欠了多少债」「列一下哪些捷径」「技术债台账」「把 shortcut 都找出来」。
- 交付前要确认「先这样」的几处是否都写了升级条件。
- 不适用：要评审某一笔改动 → `ponytail-review`；整仓体检 → `ponytail-audit`；要动手还债 → `ponytail`。
- **硬规则：只读。** 报告就是产出；用户明确要求落盘时才写台账文件（见下节）。

## 核心原则

1. **`shortcut:` 标记是一份合同**：`shortcut: <上限是什么>, <什么时候该升级>`。台账只负责把合同抄出来，判断由用户做。
2. **没写升级条件的那条才是问题**：有上限 + 有触发条件 = 决定；没触发条件 = 会烂掉的债。台账必须把两者分开。
3. **只认注释里的标记**：正文里提到这条约定的散文（文档、技能说明、示例）不进台账，否则每次都会多出几条假债。
4. **不是所有命中都是债**：谈键盘快捷键（keyboard shortcut）、变量名里带 shortcut 的，都不算。
5. **数量与名单都要给**：结尾报总数与「无触发条件」的条数，缺这一行用户就无法判断债的规模。

## 工作流

### 第 1 步：确认扫描口径

- 默认标记词 `shortcut`，同时兼容老写法 `ponytail`（`:ponytail` 曾在早期版本里当标记用）。
- 用户点名了别的标记词（例如「按 TODO 列」「按 FIXME 列」），就用那个词扫，其余口径不变。
- 排除范围：`.git`、以及所有 `.gitignore` 已经忽略的东西（依赖目录、构建产物、缓存、日志），任何技术栈都这样处理。

### 第 2 步：扫

主命令（有 git 就用它，`--exclude-standard` 会自动跳过被忽略的文件）：

```
git grep --no-index --exclude-standard -nE '(#|//|/[*]) ?(shortcut|ponytail):'
```

- 技术栈用别的注释前缀（`;`、`--`、`<!--`、`"""`）就把它加进那个括号里，例如 `(#|//|/[*]|--|<!--) ?(shortcut|ponytail):`。
- 要按标记词换成 TODO / FIXME：把 `(shortcut|ponytail)` 换成那个词。
- 本机没装 git 或目录不是仓库时，用编辑器 / `Select-String` 做全局搜索，但**必须手动排除依赖与构建产物目录**，否则命中量会被 node_modules 之类淹掉。

### 第 3 步：逐条清洗

- 每个命中 = 一行台账，但先过一遍：不是「有意为之的简化」的命中直接跳过（键盘快捷键说明、示例代码、变量名）。
- 从注释里**直抄** ceiling 与 upgrade，不要改写、不要补全、不要替作者许愿。
- 注释里只有上限、没写「什么时候该升级」的 → 打 `no-trigger`。
- 注释里既没上限也没触发条件（只写了一句「先这样」）→ 同样 `no-trigger`，并在那一行写明「只有一句说明」。

### 第 4 步：出台账

按文件分组，一个标记一行（模板见下节），结尾给计数行。要责任人时加 `git blame`：

```
git blame -L<line>,<line> -- <file>
```

## 关键参数与模板

### 台账行（默认一行三条信息）

```
<file>:<line>，简化了什么：<一句话>。ceiling：<注释里写的上限>。upgrade：<注释里写的升级触发条件>。
<file>:<line>，简化了什么：<一句话>。ceiling：<注释里写的上限或「未写」>。upgrade：未写 → `no-trigger`
```

完整示例：

```
## src/sync/queue.js
- src/sync/queue.js:41，简化了什么：队列满时直接丢最老的一条。ceiling：单进程、每秒不超过 100 条。upgrade：接入多实例或吞吐超过 100/s → 换成持久化队列。
- src/sync/queue.js:88，简化了什么：重试用固定 3 次退避。ceiling：未写。upgrade：未写 → `no-trigger`

## scripts/build.mjs
- scripts/build.mjs:12，简化了什么：只支持 x64 产物。ceiling：本机 x64 开发机。upgrade：要出 arm64 包时补交叉编译。
```

### 结尾计数行

```
<N> 条标记，<M> 条无触发条件（no-trigger）。
```

一条都没有：

```
没有 shortcut 债，台账是干净的。
```

### 落盘（用户明确要求时）

用户说「存下来」才写，默认文件名 `PONYTAIL-DEBT.md`，放在仓库根（用户指定别的路径就用他的）。写的是同一份台账，不夹建议、不改代码。

## 常见坑

- **把散文里的规则说明当成债**：技能文档、README、示例里出现的 `shortcut:` 说明会污染台账。只认注释前缀（`#` / `//` / `/*` 等），这是唯一的过滤手段。
- **扫到依赖目录**：忘了 `--exclude-standard`（或忘了手动排除 `node_modules`）会让台账变成几万行。
- **自己补全 upgrade**：作者没写就是没写。台账替人补全，等于把「会烂掉的债」洗成「已管理的债」。
- **不标 `no-trigger`**：这是本技能唯一真正有价值的产出，漏掉它，报告就只是把注释抄了一遍。
- **顺手改代码还债**：本技能只登记。要还债另开一轮（切 `ponytail`），并重新跑一次扫集确认标记已删。
- **忘了老写法 `ponytail:`**：早期代码里的标记词是 `ponytail`，只扫 `shortcut` 会漏掉一批。
- **只报总数不报名单**：总数让用户知道规模，名单让用户能挑着还；两个都要。

## 来源与合并说明

| 上游仓库 | 许可 | 贡献内容 |
| --- | --- | --- |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | MIT | `skills/ponytail-debt/SKILL.md` 全文：`shortcut:`（兼容老的 `ponytail:`）标记扫集、`git grep --no-index --exclude-standard` 扫描命令、按文件分组的台账行格式（`file:line` + ceiling + upgrade）、`no-trigger` 标记、结尾计数行、只读与「用户要求才落盘」的边界 |

- 抓取日期：2026-11-04。上游原文逐字留档：`docs/skill-imports/DietrichGebert--ponytail/skills/ponytail-debt/SKILL.md`。
- 独立成技能而不并入 `ponytail`：写代码时不会同时想列台账，两件事的触发条件完全不同；混在一起会让「主动简化时留标记」这条纪律被台账工序盖过去。
- 本地化改动（相对上游原文）：① `/ponytail-debt` 斜杠命令改成口语触发；② 补上 Scanner 之外的两步 —— 「逐条清洗」（哪些命中不算债）与「落盘口径」，上游这两块只有一句话；③ 明确「无上限也无触发条件」也算 `no-trigger` 并要写清「只有一句说明」；④ 给了完整台账示例与 `no-trigger` 的行内写法；⑤ 补「常见坑」一节；⑥ 正文译中文，`shortcut:` / `ceiling` / `upgrade` / `no-trigger` 与命令保留原文。
- 上游的扫描命令、行格式与 `<N> markers, <M> with no trigger.` 结尾计数，原样保留（计数行译成中文但字段口径不变）。

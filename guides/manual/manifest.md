# 项目 manifest：资产登记与增量重建

文本到视频这类长链路，最容易烂在「一致性」上：角色换了新版三视图，分镜里还有一半镜头在用旧图；
台词改了，配音与成片却没人重做。项目 manifest 就是给这条链路一张**可核对的资产账本**：
谁是什么版本、哪个镜头吃的是哪一版、改了以后哪些镜头必须重跑。

> 名字容易撞：本文说的 manifest 是**项目 manifest**（`<画布工作目录>/manifest.json`）；
> 交付清单是长任务落盘的 `<画布工作目录>/mtnode-deliverables/<uid>/manifest.json`，两者互不相干。

## 它管什么

| 概念 | 字段 | 说明 |
| --- | --- | --- |
| 资产 | `assets[id]` | 角色 / 场景 / 道具 / 声音…… 记 `kind`、`files`（工程内相对路径）、`anchor`（模型 / 种子 / LoRA 等）、`deps`、`rev` |
| 镜头 | `shots[id]` | 记 `assets:["char_lin@3"]`、`deps`、`specRef`、`final`、`candidates`、`qa`、`gen`、`rev`、`stale` |
| 依赖图 | `edges` | 由镜头引用自动推导（`asset:char_lin@3 → shot:S03_005@1`）+ 手工边 |
| 待确认 | `needsReview` | 非美术阶段写进来的资产（`stage≠"art"`）会被标记，等人工点过才算数 |

## 版本怎么涨

- 首次登记 `rev = 1`；
- 再登记同一份内容（同一批文件字节、同一 anchor）**不升版本** —— 反复登记不会把下游白标脏；
- 文件字节变了、或 anchor / kind / deps 变了 → `rev + 1`；
- 引用一律写 `id@rev`（如 `char_lin@3`）：引用不存在的资产、或 @ 了过期版本，登记镜头时**直接拒写**并点名。

## 增量重建怎么走

1. 资产改版（`asset_set` 升了 rev）；
2. 只有**直接引用它**的镜头被标 `stale`，并写明原因（`char_lin 2 → 3`）——不跨镜头传递；
3. `stale_plan` 给出重建清单（镜头 id / rev / 原因）；
4. 重跑这些镜头，重新 `shot_set`（钉到新 rev，stale 自动清掉），或用 `rebuild_done` 显式清脏。

系统**不会自己跑节点**：重建计划只是清单，由 Agent 或人来执行 —— 要不要重跑、按什么顺序，是人的决定。

## 怎么用

### Agent（会话里）

Agent 有一个工具 `mtnode_manifest`，动作：`init` / `get` / `asset_set` / `asset_del` / `shot_set` /
`shot_del` / `edge_add` / `edge_del` / `stale_plan` / `validate` / `validate_refs` / `rebuild_done`。
工程根缺省取**画布工作目录**（顶栏那格），也能显式传 `root`；两者都没有就报错，不会偷偷找地方建一份。

典型对话：

- 「把这个项目的角色三视图登记成资产」→ Agent 先 `init`（若还没建），再逐个 `asset_set`（`stage:"art"`）；
- 「S03_005 用了哪些资产？」→ `get` 按 id 读回来；
- 「角色换新版了，哪些镜头要重做？」→ 改完资产后 `stale_plan`；
- 「检查一遍资产引用」→ `validate`（缺文件、缺资产、@ 过期版本都会逐条列出）。

### 生成节点（requireAsset）

`proc_image` / `video_gen` 的 ⚙ 设置里有「资产锚定」：勾上**必须引用资产**后，这个节点必须填
`char_lin@3` 这样的引用，运行前会对照 `manifest.json` 校验；引用缺失、版本过期、或一条都没填
（纯文本直出）→ **直接拒跑并说明缺哪一项**。不勾 = 老行为，画布零迁移。

## 纪律

- 资产只能写美术阶段（`stage:"art"`）；其它阶段的写入会带 `needsReview`，回执里会明说要人工确认；
- 资产文件只认**工程内相对路径**且必须已存在（绝对路径 / `..` 一律拒）——工程拷走即可复现；一条 `files` 都没有的资产不算登记成功（没有文件就没有可比对的版本指纹）；
- 写操作可带 `expectRev`：多会话同时改时对不上就拒写并回当前 rev，不静默覆盖；
- `stale` 的镜头，它旧的 `final` / `qa` 文件**已经过期**，别当成当前版本交付。

## 相关

- 长任务与人工验收：见「长周期任务」手册；
- 素材库（item 级版本）是另一套：素材库存的是**素材条目**，项目 manifest 记的是**这个工程用了哪一版**。

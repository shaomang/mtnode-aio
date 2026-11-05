# 应用节点（appnode）

把「应用中心」里的一个应用钉在画布上：点卡片就在**画布区**里展开一块可关闭的全屏界面，
界面正文就是这个应用的静态页（`index.html` + 相对路径资源原样跑）。

## 怎么用

1. 右键画布 → 「应用节点（点开全屏应用界面）」，或侧栏「应用节点」分类里加一颗。
2. 卡片上点 **选择应用** → 从本机全部应用里选一个（开发中的 + 已下载的都在列）。
   **选一次即固定**：之后卡片上不再有换应用的入口，只有应用在本机找不到了才会露出「重新绑定」。
   选择确认的同时会在画布工作目录里建好这个节点的数据目录。
3. 点卡片正文 = 进入应用界面；界面右上角有 **停止** 与 **收起** 两颗钮：
   - **收起**（✕ / Esc）= 回后台，应用继续跑，长任务不会因为你去干别的被打断；
   - **停止** = 真正结束这次运行、释放内存（数据已保存），下次点卡片重新启动。
   收起后卡片上会显示「后台运行中」，并留着 **完全停止应用** 按钮，不用先回到界面才能停。
4. 界面跟着画布走：左右边栏、右侧助手栏、窗口缩放都会让它实时改变大小；
   切到会话 / 团队视图会隐藏（后台照跑），回到这张画布再自动出现。

## 界面里能拿到什么（`window.appHost`）

界面是 `mtnode-preview://<应用id>/<入口页>?_host=1&_anode=1` 的一只 iframe，
宿主注入了一座桥，页面里直接用：

| 命名空间 | 能做什么 |
| --- | --- |
| `appHost.dataRead / dataWrite / storage* / dataDirGet / dataDirOpen` | 这个节点自己的数据（落在画布工作目录里，见下） |
| `appHost.canvas` | 读整张图（节点 / 连线 / 组 / 绘制）、增删改节点、连线 / 断线、选中、视图、保存；**`runNode(id, {attempts})` 真跑一颗节点并等它出结果、`nodeOutput(id)` 读最近一次产物、`cancelNode(id)` 等同画布「终止」**（见下节）；`canvas.onChange(cb)` 订阅画布变化 |
| `appHost.agent` | `sessions()` 列左侧栏会话、`bind(id)` 绑定一条、`send(text)` 发一轮、`onEvent(cb)` 收过程、`cancel()` |
| `appHost.fs` | 画布工作目录内的读 / 写 / 列目录 / 建目录 / 删 |
| `appHost.tools` | `list()` 已登记的后端工具、`call(id, args)` 调一次 |
| `appHost.net` | `fetch(url)` 经宿主联网取数据 |
| `appHost.textGenStream / imageGen / imageEdit / transcribe / pickImage / account …` | 与应用窗口里同一批能力 |

**逐类白名单**：桥按命名空间一个一个方法地名开放（见 `renderer/app-appnode.js` 的
`APPNODE_METHODS`），不是把主窗口的 `window.api` 整包丢给页面。要开新能力必须显式加名字。

页面改画布是全量读写，每次写入都会先进撤销栈 —— 用户 `Ctrl+Z` 能整批回退。
agent 与手写操作同一把权限。

## 在画布上跑图像节点（应用侧）

应用不只能建图像节点，还能**真跑起来并拿到图**：

```js
const H = window.appHost;
const txt = await H.canvas.addNode({ kind: "input_text", x: 0, y: 0 });
const img = await H.canvas.addNode({ kind: "proc_image", x: 320, y: 0 });
await H.canvas.updateForm(txt.id, { 文本: "雨夜的霓虹街角，电影感" });
await H.canvas.connect({ from: txt.id, to: img.id, toIndex: 0 });

const r = await H.canvas.runNode(img.id, { attempts: 1 });   // 等出图
r.images;                                                   // 本机绝对路径
r.meta;                                                     // seed / size / model / attemptErrors
await H.canvas.nodeOutput(img.id);                          // 之后想再取，不用重跑
await H.canvas.cancelNode(img.id);                          // 随时终止
```

| 口径 | 说明 |
| --- | --- |
| 与手点 ▶ 同一条路 | 上游没处理自动补齐、级联、运行态 / 进度、产物落画布资产目录，全部同源；执行完自动存盘 |
| 出几张 | `runNode(id, { attempts })` 默认 **1 张**（不继承节点自己存的多次，1–10），跑完把原值还回去 |
| 已在跑 | 等那一轮结束直接回它的产物 —— 不重复出图、不多花一次钱 |
| 没有工作目录 | 回 `no_workspace`，**不弹窗**（应用窗口里没人能替你选目录） |
| 终止 | `cancelNode` = 画布「终止」：这颗节点在跑的都停（含用户手点那次）；正在等的 `runNode` 回 `code:"cancelled"`，已落盘的产物还在 `nodeOutput` 里 |
| 超时 | 宿主**不挂超时**：长任务自己 `Promise.race` + `cancelNode` 收口 |
| 范围 | 任意 kind 可跑（含 `save` / 控制类 / `super`），不设白名单；产物一律本机绝对路径 |
| 需要的能力位 | `capabilities.canvasHost`（首次调用宿主弹一次授权） |

## 数据放在哪

`<画布工作目录>/apps-data/<应用id>/data.json`

- 跟着**画布工作目录**走（画布拷给别人，数据一起走），与应用中心窗口那份 `apps-data` 互不相干。
- 节点卡片上能看到这个路径，并有「打开数据文件夹」。
- 上限 2MB（与应用窗口同口径），写盘是 tmp + rename 的原子写。

## 边界（别踩）

- **纯启动器**：无端子、不参与运行 —— 执行引擎不会跑到它，也不能被连线喂数据。
- 界面同时只开一个；后台也同时只允许一个应用节点存活（开新的会把上一个停掉）。
- 存活到「节点被删 / 切换画布 / 退出 MTNode / 点停止」为止；关界面只是收起。
- 离开画布视图（会话 / 团队）会隐藏界面，但不会结束运行；回到这张画布会自动恢复。
- 关界面不弹二次确认，数据自动落盘。
- 页面只能读写**画布工作目录**里的文件，越界一律拒绝（主进程再守一道）。

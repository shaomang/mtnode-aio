# 设置面板与端子视觉：输出参数可选类型

一次性任务汇报（并行任务 · 设置面板与端子视觉）。只改渲染层与样式，未动运行期取数口径。

## 改动

### 1. 输出参数可选类型 · 参数行类型标记 — `renderer/app-canvas.js`

`buildFnToolSettings` → `renderParams()`：

- 原「文本 / 图像」下拉只在 `dir === "in"` 出现，现改为**输入 / 输出参数同一口径**，每行都渲染 `select`；改类型仍走既有 `commit(true)` → `clearDownstream(node.id) + scheduleSave() + renderCanvas()`（不新增历史推送，与输入参数完全一致）。
- 参数行左侧新增类型标记 `<span class="fn-p-kind">`（图像加 `.img`），内容为一点 `●`，`title` = 「类型：图像 / 文本」；类型改完 `renderCanvas()` 重建面板，标记随端子一起刷新。

### 2. 端子按类型区分视觉与 tooltip — `renderer/app-canvas.js` `nodeElement`

统一走 `renderer/app.js` 既有单一真源 `fnToolPortKind(node, dir, idx)`（数据端子返回 `text|image`，控制端子返回 `null`）：

- 输入端子（`0 = 控制入`，`1..N = 入参`）：`inKind === "image"` → 类名加 `.img`；tooltip 由「输入参数 X」变为「输入参数 X（图像 / 文本）」。
- 输出端子（`0..M-1 = 出参`，末位控制出）：`outKind === "image"` → 类名加 `.img`；tooltip 「输出参数 X（图像 / 文本）」。控制出分支不变，仍是「控制输出…」。
- 非工具 / 函数节点 `fnToolPortKind` 返回 `null` → 类名与 tooltip 逐字不变。

### 3. 内侧桥接 / 汇流端子 — `renderer/app.js` `superInnerPortInfo`

返回值新增 `img` 布尔，并在 `title` 的「· 参数：名称」后插入「（图像）/（文本）」；控制端子（`pk === null`）与普通超级节点（`fixed === false`）不加标注。三处渲染点同步套 `.img` 视觉类：

- `app-canvas.js` 展开壳层 `super-inner-bridge` / `super-inner-sink`；
- `app.js` `mountSuperFocusPorts` 全屏进入态钉边端子。

### 4. 摘要标注「（图像）」 — `renderer/app-canvas.js`

- 工具 body 的 `ioLine(入参 / 出参)`：`kind === "image"` 的参数名后追加「（图像）」，文本参数不加标注以免噪音。
- `fnToolOutSummaryEl`：端子声明（`fnToolPortKind(node,"out",0)`）或实际值 `output.kind` 为 image 时，摘要前加「（图像）」，避免图像路径被当成普通文本结果。

### 5. 样式 — `renderer/css/canvas.css`

- 新增 `.port.img { --rim: #a8407a }`（紧挨 `.port.ctrl` 同写法），配 `.port.img>.port-badge`、`.port.img.hover`、`.port.img.hover::before` 的粉色描边与辉光（识别色取图像节点既有 `#ff5ea8` 一族）；声明在 `.port.in` / `.port.out` 之后，同特异性靠后者生效，图像端子不再与文本端子同色。
- 新增 `.fn-p-kind` / `.fn-p-kind.img`（设置面板行左侧标记，蓝 = 文本、粉 = 图像）。

### 6. i18n — `renderer/i18n.js`

补 3 条英文词条：`（图像）`、`（文本）`、`该端子的数据类型（文本 / 图像）· 改类型即改端子视觉与下游取数口径`。

## 校验

`node --check renderer/app-canvas.js`、`renderer/app.js`、`renderer/i18n.js` 全部通过。按任务边界未跑测试 / 构建。

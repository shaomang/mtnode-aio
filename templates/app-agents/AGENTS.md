# AGENTS.md — 这个应用的开发共识

> 本文件是**应用自己的**共识文件（与 MTNode 主程序根目录的 `AGENTS.md` 同一职能，但只管这一个应用）。
> 任何接手这个应用的人或 AI 会话，动手前先读它。由 MTNode 应用脚手架**默认生成**；
> 若你所在目录已有一份 `AGENTS.md`，说明是此前写下的共识 —— **不要覆盖，只按需补充**。

## 一、目录约定

```
index.html      入口页（app.json 的 entry；宿主只认 .html）。资源一律相对路径（./app.js、./assets/a.png）
apphost.js      宿主桥探测与优雅降级（window.AppHost）——两套宿主窗口都认
app-model.js    模型选择位（右上「模型」按钮 + 下拉；分「文本模型 / 图像后端」两区，都从 MTNode 继承）
model.css       模型选择位与示例区样式
store.js        内容落盘（脏标记 + 防抖 + flush）
close.js        关窗收尾登记（AppClose.on）
app.js          业务逻辑
style.css       结构与排版（颜色 / 字体走 styles/<id>.css 的语义变量）
styles/         设计风格变量（minimal / tech / warm / editorial / terminal / glass / retro）
app.json        自描述元数据（id / entry / version / window 等；发布时与云端 catalog 词条对齐）
assets/         图标 / 图片 / 字体 / 静态 json
```

- **界面文案两份**：DOM 里 `[data-lang="zh"]` / `[data-lang="en"]`，`<html lang>` 选一份（见 `style.css`）；
  JS 里的文案走一张字典（见 `app-model.js` 的 `ZH` / `EN`）。
- **样式**：结构与排版写在 `style.css` / `model.css`，颜色与质感只写在 `styles/<id>.css` 的变量里；
  不要在一个文件里混写风格与结构。
- 新文件优先放应用根目录，按上面这张表的职能归类；新增目录要写进本节的表里。

## 二、不要修改清单

- **`apphost.js` 的探测口径不要绕过**：只能调用 `typeof host.x === "function"` 判过的能力，
  不许发明接口、不许直接假设某个方法存在。
- **不要改 `store.js` / `close.js` 的收尾语义**：写盘与退订必须仍然挂在关窗前那一次（`AppClose.on`）。
- **不要往应用安装目录写任何数据**：数据只走 `AppHost`（`dataWrite` / `dataSet` / `storage*`），落在
  `<数据目录>/apps-data/<id>/`；升级与卸载会整目录替换，写进去就是丢。
- **不要把凭据写进任何文件**：服务商、API Key、token 一律只留 MTNode 主进程，应用侧一个字节都不落。
- **不要删掉模型选择位**（`#modelBtn` + `#modelMenu` + `app-model.js`）：换皮肤可以挪位置，但不能没有。
- 不改 `app.json` 的 `id`（= 目录名 = 云端词条 id）；改它等于换一个应用。
- **`app.json` 的 `capabilities` 是能力声明**：`textInput` 为真才带语音模块（`speech.js` / `speech.css`），
  没声明就是「不携带语音转文字」；`showDictate` 为真才在**应用窗口底部**显示宿主注入的那条听写条
  （默认 **false** = 隐藏，挂上的条带 `data-mtnode-hidden` + `display:none`，应用自己调
  `apSpeechReveal()` 仍能唤起）；`imageGen` 只是声明要出图。它是静态声明、不是权限闸 ——
  桥上的接口始终可调，别拿它去拦代码。

## 三、能力桥用法（appHost / pluginApi → window.AppHost）

统一从 `window.AppHost` 走（`apphost.js` 已把两套宿主桥统一）：

| 想做 | 用 |
| --- | --- |
| 存 / 读内容 | `Store.create(...)` / `AppHost.getData()` / `setData(data)`（数据落 `apps-data/<id>/data.json`） |
| 数据文件夹 | `AppHost.dataDirGet()` / `dataDirPick()`（用户亲自选） / `dataDirOpen()` / `dataDirReset()` |
| 账号摘要 | `AppHost.accountText()` |
| **列模型 / 选模型** | `AppHost.models()` / `modelGet()` / `modelSet(id)`（只认 MTNode 已配置的模型清单） |
| **文字 + 图像问模型** | `AppHost.text(prompt, { images: [路径或 dataURL], model, onDelta })` |
| 选一张本机图 | `AppHost.pickImage()`（用户取消 → `{ ok:false, code:"cancelled" }`，不是报错） |
| **出图** | `AppHost.image(prompt, { model, images, onProgress })`（云端图像服务商或本机 SenseNova，每次一张；取消走 `AppHost.cancelImage(reqId)`） |
| 列图像后端 / 选 | `AppHost.imageModels()` / `imageModelGet()` / `imageModelSet(id)` |
| 语音转写（可选） | `AppHost.pickAudio()` / `transcribe()` / `transcribeWav(b64)`（**只有声明了 `capabilities.textInput` 的应用才带脚手架的语音模块**；窗口底部那条宿主注入的听写条另看 `capabilities.showDictate`，缺省隐藏，脚本可用 `apSpeechReveal()` 唤起） |
| 关窗 | `AppHost.close()`；收尾挂 `AppClose.on(cb)` |
| 语言 / 外观 | 只改 `<html lang>` 与 `styles/<id>.css`，不动其它文件的文案与配色 |

**模型能力的硬线**：模型从 MTNode 继承（服务商与 Key 不回传）；界面上必须有选模型的位置；
没有可用模型 / 断网 / 模型不支持识图时**明确提示、绝不降级**（错误码见 `app-model.js` 的 `ERR` 表）。

## 四、数据落盘

- 内容：整份 JSON 走 `dataWrite` / `dataSet`，落 `<数据目录>/apps-data/<id>/data.json`（原子写、上限 2MB）；
  **不用 localStorage 当存档**（`file://` 下来源不稳），**不往应用目录写文件**。
- 数据文件夹：默认跟 MTNode 数据目录走；用户可以在窗口里改成自己的文件夹（只有用户亲自选的那一次生效）。
  换目录**不搬旧数据**，原文件留在原处。
- 键值式的小设置可用 `storageGet` / `storageSet`（内部同样落 `data.json` 的 `kv`）。

## 五、设计规范

- 动手改界面前先加载内置技能 `impeccable`（`SKILL.md` 入门，`reference/craft-floor.md` 是底线），
  按它的口径审一遍层级、间距、对齐、状态与空态。
- 无框窗口：`.drag` 是拖动区、里面的按钮加 `.no-drag`，否则点不动。
- 窗口默认透明、无系统标题栏 → **必须自带关闭按钮**（已接 `AppHost.close()`）。
- 布局自适应窗口区间（腿窄时不要横向溢出、长串要能断行）；关键动作要有明确的成功 / 失败反馈，
  错误提示要写「怎么办」，不能只写「失败」。
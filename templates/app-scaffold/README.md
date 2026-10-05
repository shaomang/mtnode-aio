# MTNode 应用脚手架（templates/app-scaffold）

**首次开发某个应用时，把本目录整份复制进它的安装子文件夹**（本地开发目录或 `<应用安装根目录>/<id>/` 的对位子目录），
再把占位符替换成该应用自己的名字与实现。它是**源**，不是运行期依赖：应用跑起来后不再引用本目录。

随包分发（`build.json` 的 `files` 已含 `templates/**`），仓库内路径 `templates/app-scaffold/`。

**复制时同时把 `templates/app-agents/AGENTS.md` 复制成该应用自己的 `AGENTS.md`**（应用根，与 `index.html` 同级）：
**默认就建，不要问用户**；目标目录里已经有 `AGENTS.md` 的**不要覆盖**（那是用户自己写的约定）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 入口：无框窗口骨架、拖动区、模型选择位、降级横幅位、数据文件夹一行、便签示例、文字+图像示例 |
| `apphost.js` | **宿主桥探测与优雅降级**：同时认 `window.appHost`（应用中心窗口）与 `window.pluginApi`（插件窗口），统一成 `window.AppHost`：`getData` / `setData` / `dataDirGet` / `dataDirPick` / `dataDirOpen` / `dataDirReset` / `storageGet…` / `accountText` / `request` / `on` / `onShown` / `offAll` / `onWillClose` / `close` / `quit`，外加**模型四件**：`models()` / `modelGet()` / `modelSet(id)` / `pickImage()`、`text(prompt, {images})` 与**结构化输出** `json(opts)`（关思考 + 剥围栏 + 截断感知 + 重试一次） |
| `app-model.js` | **模型选择位**：右上「模型」按钮 + 下拉，分「文本模型 / 图像后端」两区（文本首项 = 跟随 MTNode 默认、每项标「支持识图」；图像后端 = 云端服务商 + 本机 SenseNova）；`AppModel.errorText(res)` 把宿主的错误码翻成一句人话，`AppModel.imageErrorText(res)` 管出图那条路的码（`busy_media` / `cuda_oom`…）。两行接入，见文件尾注 |
| `model.css` | 模型选择位与示例区样式（颜色仍走 `styles/<id>.css` 的语义变量） |
| `store.js` | **落盘脚手架**：`Store.create({host, file, debounceMs})` → `set(data)` 标脏 + 防抖自动写盘，`load()` 读回，`flush()` 立即写盘；没有宿主时退化为内存态（`store.persisted === false`） |
| `speech.js` | **底部语音听写（按需）**：footer 里一枚话筒（本机内置语音识别，官方本地 SenseVoice）+ 一枚「音频转文字」（选本机录音文件），结果进结果小窗、一键复制。`Speech.mount(el)` 挂载，`Speech.create()` 拿纯接口（`file()` / `wav(base64)` / `record()` / `status()` / `prepare()` / `onState()`）；桥缺席时整块禁用并写清原因。**只有该应用声明了 `capabilities.textInput` 才复制本文件**（见下「能力位」一节） |
| `speech.css` | 听写条与结果小窗的样式（颜色只取语义变量，换风格自动跟随）。与 `speech.js` 同一条口径：**只有声明了 `textInput` 才复制** |
| `close.js` | **关窗收尾脚手架**：`AppClose.on(cb)` 登记钩子，宿主关窗前（`apps:willClose`）跑完再关；`visibilitychange` / `pagehide` / `beforeunload` 三处兜底冲刷 |
| `app.js` | 最小业务示范：便签落盘（脏标记 + 防抖 + 关窗冲刷）、数据文件夹显示 / 更改 / 打开、模型选择位初始化、文字+图像调用、关闭按钮 |
| `style.css` | 深色主题样式；`.drag` / `.no-drag` 无框窗口拖动约定 |
| `app.json` | 应用自描述元数据（字段口径对齐云端 `catalog.json` 词条） |

## 三件基础设施（任何应用都要有）

1. **正确关闭**：关闭按钮 → `AppHost.close()`（= 宿主 `apps:closeWindow`）。宿主**不会**直接 `w.close()`，
   而是先发 `apps:willClose`，等应用把 `AppClose.on(...)` 的钩子跑完（上限 1.5s）才真关；
   主程序退出（`before-quit`）走的也是同一条。所以「写盘 + 退订」挂在 `AppClose.on` 里就够了。
   `AppHost.quit()` 是「连 MTNode 一起退出」，只有真需要才用。
2. **内容落盘**：只走 `Store`（内部是 `AppHost.getData` / `setData`），数据落 **`<数据目录>/apps-data/<id>/data.json`**
   （默认数据根；2MB 上限、原子写）。**不要写 localStorage**（`file://` 下来源不稳），**更不要写应用安装目录**
   （升级 / 卸载会带走，启动体检还会报警）。
3. **数据文件夹**：`AppHost.dataDirGet()` 拿当前落点、`dataDirPick()` 让用户亲自选（**只有用户点过、系统目录框里选的那一次生效**，
   应用传不了路径）、`dataDirOpen()` 在资源管理器中打开、`dataDirReset()` 回默认位置。换目录**不搬旧数据**，
   原目录内容原样留着；宿主只允许写「默认数据根 + 用户选过的那个文件夹」，别的路径一律拒绝。

## 模型能力：从 MTNode 继承（需求硬线）

- **模型不在应用里配**：应用侧永远拿不到服务商与 API Key —— 只能在 MTNode 已配置的模型清单里挑一个。
  `AppHost.models()` 列清单（首项是 `{id:"auto"}` = 跟随 MTNode 默认），`AppHost.modelSet(id)` 改选择，
  宿主按**应用 id 持久化**（关窗重启还记得）。
- **界面上必须有一个选模型的位置**：`index.html` 的 `#modelBtn` + `#modelMenu`（`app-model.js` 负责填与画）。
  这是给用户看的入口，别把它删了；应用换皮肤可以挪位置，但**不能没有**。
- **文字 + 图像一起发**（多模态）：
  ```js
  var r = await AppHost.text("图里有什么？", {
    model: M.model(),                 // 空串 = 跟随 MTNode 默认
    images: ["C:/pics/a.png"]         // 本机绝对路径，或 data:image/png;base64,…
  });
  if (!r.ok) show(AppModel.errorText(r));   // 结构化错误码 → 一句人话
  else show(r.text);
  ```
  图像可以来自 `AppHost.pickImage()`（系统选图框，回 `{ok,path}`；用户取消回 `{ok:false,code:"cancelled"}`，
  **不是报错**）或页面自己手里的 dataURL。读盘 / 解码 / 缩放（长边 ≤1080）全在宿主做；
  一条消息最多 8 张图、合计 10MB，超了回 `too_many_images` / `too_large`。
- **不降级**：没有服务商 / 断网 / 模型不支持识图 / 模型不在清单里，一律回结构化错误码
  （`no_provider` / `no_vision` / `offline` / `bad_model` / `http_401`…），界面用 `AppModel.errorText()` 明确告知，
  **不静默换模型、不丢图、不假装成功**。
- **思考默认关，别拿 `maxTokens` 卡预算**：应用通道不传 `thinking` 就是关思考（要开显式传
  `off / on(=high) / low / high / max`，非法值回 `bad_thinking`）。要模型给 JSON 时更不要自己设
  `maxTokens`：它是「思考 + 正文」共用的预算，给小了正文会被截断成半截 JSON，
  应用只会看到「回复不是可用 JSON」——实测 deepseek-v4 开思考 + `maxTokens: 1200` 时 6 次里 4 次被截断。
- **要 JSON 用 `AppHost.json()`**（别自己 `text()` + `JSON.parse()`）：
  ```js
  var r = await AppHost.json({ system: "You output strict JSON.", prompt: "…" });
  if (!r.ok) show(r.error);        // code: truncated / not_json / no_provider …
  else use(r.data);                // 已解析好的对象
  ```
  它剥 ``` 围栏、截取首个 `{`/`[` 到末个 `}`/`]`，解析失败自动重试一次（`opts.retries` 可调）；
  上一次被截断时，重试会自动丢掉 `maxTokens`。返回里带 `finishReason` / `truncated` / `reasoningChars`，
  想自己判也能判。`AppHost.text()` 同样回这几个字段。

## 复制后要做的替换

1. `app.json`：`id`（= 目录名 = catalog 词条 id）、`title` / `subtitle` / `icon` / `description`、`version`、`minAppVersion`、`window` 尺寸。
2. `index.html`：`<title>`、`#appTitle`、`#appSub`、图标字符（`#speechBar` 那一格是听写条，别删；
   页脚文案已按本轮共识去掉，要写说明自己写）。
3. `app.js`：把便签与示例逻辑换成真实实现；`state` 的形状与落盘的 `data.json` 保持一致。
4. 需要更多宿主能力时，只往 `apphost.js` 的 `cap` 表里加**已探测**的方法，别直接假设接口存在。
5. 复制 `templates/app-agents/AGENTS.md` 成应用根目录的 `AGENTS.md`（已有就保留，别覆盖）。
6. **按能力位决定复制哪些文件**：目标应用的 `app.json` 里 `capabilities.textInput` 为真才复制 `speech.js` /
   `speech.css`（并在入口页挂上听写条）；没声明就**不要**带这两个文件 —— 默认应用不携带语音转文字。
   `capabilities.showDictate`（默认 **false**）决定**应用窗口底部那条宿主注入的听写条**显不显示
   （见 `renderer/app-speech-ui.js`：默认带 `data-mtnode-hidden` + `display:none`，脚本仍可 `apSpeechReveal()` 唤起）。
   `capabilities.imageGen` 只是声明（出图接口与文本接口一样，始终可调），界面按需自己写出图入口。

## 图像生成：用 MTNode 已配好的图像能力

应用侧的图像后端**从 MTNode 继承**（与文本模型同一套思路）：云端图像服务商，或本机 SenseNova 后端。
服务商与 Key 留在主进程，应用只挑 id、只给提示词。

```js
/* ① 有哪些图像后端可选（首项不是 auto —— "auto" = 跟随 MTNode 默认：云端优先，其次本机） */
var list = await AppHost.imageModels();      // { ok, models:[{id,label,providerName,local}], selected, hasAny, hasCloud, hasLocal, busy }
if (!list.hasAny) show('MTNode 里还没有可用的图像后端：到「设置 · 模型服务」配一个图像服务商，或装本机 SenseNova');

/* ② 出图（每次一张）：opts.images 可带参考图（本机路径或 dataURL）→ 后端走图生图 / 图像编辑 */
var r = await AppHost.image('一只戴帽子的猫', {
  model: M.imageModel(),                       // 空串 = 跟随 MTNode 默认
  size: '1024x1024',                           // 语义尺寸，后端自己对齐（本机后端按官方分辨率桶）
  images: [refPath],                           // 可选：参考图；读盘 / 缩放在主进程做
  onProgress: function (p) { bar(p.pct); },    // 可选：本机后端要几十秒到几分钟，给用户看进度
});
if (!r.ok) show(AppModel.imageErrorText(r));    // no_provider / bad_model / busy_media / cuda_oom / http_4xx…
else img.src = r.dataUrl;                       // 同时有 r.base64 / r.bytes / r.file（本机后端给落盘路径）
```

- **长任务要留取消入口**：本机后端出图很慢，`r.reqId` 交给 `AppHost.cancelImage(reqId)` 即可取消；
  用户在界面上主动取消 → `code:"cancelled"`，**不是错误**，恢复按钮就行。
- **本机后端与音乐 / 视频共用一个全局锁**：忙时回 `code:"busy_media"`，界面提示等待 / 重试，不要自动重发。
- **不降级**：一个后端都没配 → `no_provider`；模型不在清单里 → `bad_model`；显存不够 → `cuda_oom`。
  一律明确告知，绝不偷偷换后端、更不假装出图成功。

## 能力位（app.json 的 capabilities）

应用的自述能力位写在 `app.json`：`{ "textInput": false, "showDictate": false, "imageGen": false }`
（**默认三项都不勾**）。它是**静态声明**，不是权限闸 —— 桥上的接口始终可调，它决定的是
「起步模板带不带语音模块 / 应用窗口底部那条宿主注入的听写条显不显示」：

| 位 | 为真时 | 为假 / 没声明时（缺省） |
| --- | --- | --- |
| `textInput` | 脚手架带语音听写模块（`speech.js` / `speech.css`） | 默认应用不带任何语音转文字 |
| `showDictate` | 应用窗口底部显示宿主注入的听写条（🎤 听写 / 🎧 音频转文字） | **默认隐藏**（那条条挂上就带 `data-mtnode-hidden` + `display:none`，脚本仍可 `apSpeechReveal()` 唤起） |
| `imageGen` | 声明这个应用要出图（界面自己写出图入口） | 只是没声明；接口照旧可调，只是模板不带 |

新建应用时那几个复选框、以及开发页 ⋯「应用能力…」改的就是它；改了任一位宿主会按模板重生成入口页
（你在入口页里手改过的内容会没了）。**复制脚手架时按这份声明决定要不要带 `speech.js` / `speech.css`。**

## 语音转写（本机内置，官方本地 SenseVoice）

识别跑在 MTNode 的 dsh 运行时里（与主界面状态栏那枚话筒同一条通道），**应用侧只需要调桥**：

```js
var r = await AppHost.pickAudio();                       // 系统选音频框：{ ok, path }
if (r.ok) {
  var t = await AppHost.transcribe({ path: r.path });     // → { ok, text, audioSeconds }
  if (t.ok) show(t.text);
}
var st = await AppHost.speechStatus();                    // { ok, available, ready, downloading, phase, … }
if (!st.ready) await AppHost.speechPrepare({});           // 首次约 239MB，进度走 onSpeechState(cb)
```

- **只允许转写你在这个应用里选过的音频**（`pickAudio()` 那一次）或**本应用数据文件夹里的音频**；
  应用自己传别的路径一律回 `path_denied`（应用页没有文件系统能力，这是有意的）。
- 应用自己录音也行：`getUserMedia` + `AudioContext` 采到 **16 kHz 单声道 PCM16 WAV**，
  转 base64 后 `AppHost.transcribeWav(b64)`（应用窗口的 media 权限由宿主放行，见 `speech.js`）。
- 模型没下载时不降级：`speechStatus().phase` 会如实说 `unprepared / downloading / failed`，
  `speechPrepare()` 只负责把下载跑起来（幂等），**不假装识别成功**。
- 结果只展示 + 复制，**不自动往你的界面控件里塞**（插到哪儿由应用自己决定）。

## 契约（照做，别省）

- 纯静态 HTML/JS/CSS，**没有 Node、没有 `window.api`**；资源一律相对路径。
- **本身不依赖 appHost**：桥缺席（浏览器直接打开 `index.html`、旧版宿主、桥被裁剪）时仍要能启动
  （内存态 + 明确提示），禁止白屏 / 抛异常。
- 落盘只走 `Store` / `AppHost.*`；**不写应用目录**，不把 token / 密钥写进数据文件。
- 模型能力只走 `AppHost.text` / `AppHost.models`：**服务商与 Key 留在主进程**，应用侧只能给提示词、图像与模型 id。
  要内建跟画布同级的本地后端能力，升级为本地后端插件（见技能 `mtnode-plugin-dev`）。
- 无框窗口必须自带关闭按钮（脚手架已接 `AppHost.close()`）。

完整规范见内置技能 `mtnode-app-dev`（随包内置，技能名 `mtnode-app-dev`）。
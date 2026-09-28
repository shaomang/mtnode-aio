# 素材库（Asset Library）设计文档

> 状态：已实现（主进程 `assets-store.js` · 渲染层 `renderer/app-assets.js` / `app.js` / `app-canvas.js` / `app-nodes.js` / `app-boot.js` · 顶栏入口 `renderer/index.html` `#btnAssets` · 样式 `css/components.css` `.asset-lib-*` `.asset-set-*` 与 `css/layout.css` `.btn-assets`）
> 配套：节点指南 `guides/nodes/asset.md`（英文 `guides/nodes/en/asset.md`）· 应用内手册：`guides/manual/asset-library.md`（英文 `guides/manual/en/asset-library.md`，目录见 `guides/manual/index.json`）
> 同类先例：`docs/tool-library.md`（跨画布可复用仓库）· `docs/tool-function-nodes.md`（「参数即端子」机制）

## 1. 一句话与边界

**素材库 = 独立于画布的本机内容仓库**：按分类把「素材」（一个文件夹）打包若干**内容条目**（文本 / 图像 / 音频 / 视频）；画布上的**素材节点**绑定某个素材，**一条内容 = 一对端子**（第 i 入 ↔ 第 i 出）。

三条硬语义（所有实现都围绕它们）：

| 语义 | 落地方式 |
|---|---|
| **改内容＝改库** | 内容实体恒在库内，节点上只有绑定与条目快照；读写一律经 `assets:*` IPC |
| **删画布不丢** | 库目录与画布存档互不相干（画布回收站在 `main.js` 另有一套），删画布 / 删节点都不碰库文件 |
| **跨画布共享** | 同一素材可被任意多张画布的节点绑定；各画布以库为准（打开 / 刷新 / 重扫 / 写库后回填） |

**库界面（对话框 persistent，不点外部关闭）**：左栏＝**分类 + 素材一体树**（分类行可展开，展开后列出该分类下的素材行：显示名 + **类型徽标** + 内容数；另有「全部素材（根目录）」行），右栏＝**所选素材的内容详情**（素材名 / 描述 / 相对路径 + 动作行 **设置 / 复制到画布 / 删除 / 打开文件夹（资源管理器）**，正文＝可编辑的内容条目列表）；未选素材或处于绑定 pick 模式时，右栏回落为当前分类的**素材卡片**（设置 / 插入到画布 / 删除）。

**永不实删**：删除一律进 `<root>/.trash/`，覆盖写盘一律先留 `<素材夹>/.versions/`。

## 2. 根目录与配置

- 根路径存 `<数据目录>/config.json` 的 **`assetRoot`** 字段（与服务商配置同文件，读写沿用 `config-providers.js` 的 `readJson / writeJson`＝tmp + rename 原子写）。
- 默认建议值是 `<数据目录>/asset-lib`。**不能叫 `assets`** —— 那个目录已被「每画布的图像 / 媒体资产」按 wfId 占用（`main.js` 的 `assetDirPath()`），混进去会被当成分类扫描。
- `assets:getRoot` **只读不建目录**，返回 `{path, defaultPath, configured, exists}`；未指定时 `configured:false`，渲染层据此走首次引导（二次说明 → `file:openDialog({directory:true})` → `assets:setRoot`；用户不选则本次不开库）。
- `assets:setRoot` 只接受**绝对路径**（且已存在的路径必须是文件夹），目录不存在则创建；返回 `{path, previous, changed, scan}`。`changed:true` ＝ 真的换过根 → 渲染层必须重扫并按 id 重定位绑定（§9 / §10 失联）。
- 其余写类通道走 `ensureRoot()`（会 `mkdir -p`），未指定根时 `assets:scan` 返回 `{ok:false, needRoot:true}`，渲染层据此弹引导而不是报错。

## 3. 目录格式（唯一真源）

```
<root>/                                  ← 用户指定的「项目目录」
├── <分类名>/                            ← 没有标记文件的子目录 ＝ 分类（可继续嵌套）
│   ├── <子分类名>/
│   │   └── <素材夹>/                    ← 有标记文件的目录 ＝ 素材
│   │       ├── .mtnode-asset.json       ← 素材标记 ＋ 元数据（§4）
│   │       └── items/                   ← 内容实体文件（§5）
│   └── <素材夹>/
│       ├── .mtnode-asset.json
│       ├── items/
│       │   ├── itlxx1.png
│       │   └── itlxx2.txt
│       └── .versions/                   ← 覆盖写盘留下的旧内容（§6）
└── .trash/                              ← 根级回收站（§7）
    └── 2026-06-09T04-00-00-000Z__旧素材名/
```

判定只有一条规则：**目录里有 `.mtnode-asset.json` ＝ 素材，没有 ＝ 分类**。素材夹**不下探**（它自己的子目录不是分类，`items/` 里的散落文件也不算内容条目）——素材夹因此在遍历里天然成为叶子。

扫描口径（`scanLibrary`）：

- 遍历跳过：名字以 `.` 开头的目录（天然排除 `.trash` / `.versions`）、`SKIP_DIRS`（`.trash` `.versions` `.git` `node_modules` `Thumbs.db`）、以及 `items`。
- 只认目录；标记文件读不出（不是合法 JSON、不是对象、或没有 `items` 数组）按「不是素材」处理，不炸整次扫描。
- 返回 `{ tree, categories, assets }`：
  - `tree` —— 嵌套结构，节点 `{kind:"cat"|"asset", rel, name, children, asset?}`（分类节点名用文件夹名，素材节点名优先 `displayName`）；
  - `categories` —— 平铺分类 `{rel, name, assetCount}`，计数**含子分类**里的素材（按 `catRel` 前缀匹配）；
  - `assets` —— 平铺素材摘要，按 `updatedAt`（无则 `createdAt`）**倒序**。
- 根目录不存在时返回空树（不报错）——「还没建过东西」是正常状态。
- 每次打开素材库、每次写库之后都重扫；`findAssetDir(root,id)` 每次现走目录树（**不缓存**）。所以在资源管理器里挪素材夹、改分类名，回到应用立刻生效。渲染层用 `ASSET_LIB.scanned` 记录「本轮会话是否成功扫过」，作为失联判定的前提（§9）。

## 4. `.mtnode-asset.json`（schema 1）

```jsonc
{
  "schema": 1,
  "id": "as<时间戳36><随机>",        // 绑定标识；^[A-Za-z0-9_-]{4,80}$，改显示名 / 挪目录都不变
  "displayName": "显示名",            // 界面显示用，与端子无关
  "desc": "描述",                     // 只给人看
  "items": [
    {
      "id": "it<时间戳36><随机>",     // 条目标识 = 端子与实体文件的锚点（同一 id 规则）
      "title": "端子标题",            // 显示在节点左右两端的端子上
      "type": "text" | "image" | "audio" | "video",
      "file": "items/itlxx1.png",     // 恒为「相对素材夹」＋「/」分隔；正文不入 JSON
      "bytes": 123456,
      "createdAt": 0, "updatedAt": 0
    }
  ],
  "createdAt": 0, "updatedAt": 0
}
```

- **数组顺序 = 端子顺序**（`items[i]` ↔ 第 i 对端子）。
- 内容**不写进 JSON**：文本也在 `items/*.txt` 里（与媒体同口径，撤销回滚只有一套文件动作）。
- `normItems()` 是唯一归一口径（读写都过它）：`id` 不合规模板或重复 → 整条丢弃；非法 `type` → `text`；空 `title` → 补「内容 N」（`t()` 双语）；`file` 的反斜杠一律转正斜杠。渲染层还有一份**同名同口径**的 `assetItems()`（节点快照上的同一份归一，不能各说各话）。
- 写入走 `writeMarker()`（tmp + rename），并刷新 `meta.updatedAt`。

## 5. `items/` 命名、类型映射与净化

- 文件名恒为 **`items/<itemId><扩展名>`**，撞名时 `itemId_2<ext>`、`itemId_3<ext>`…（`uniqueItemFile`）。**改标题不碰磁盘**：itemId 终身不变 ⇒ 端子与连线可按 id 稳定重映射。
- 扩展名：源文件扩展名与该条目声明类型一致时**保留源扩展名**（`.jpg` 就是 `.jpg`，不强扭成 `.png`）；否则用类型默认值 `{text:".txt", image:".png", audio:".wav", video:".mp4"}`（`extOf` 兜底 `.bin`）。
- 类型按扩展名表 `EXT_TYPE` 判定（决定条目 type，也决定 `EXT_OF_TYPE` 默认名）：
  - **image** `png jpg jpeg webp gif bmp svg avif tiff ico`
  - **audio** `mp3 wav ogg oga flac aac m4a opus mid midi amr`
  - **video** `mp4 mov webm avi mkv m4v flv wmv mpeg mpg`
  - **text** `txt md markdown json jsonc yaml yml csv tsv xml html htm css js mjs cjs ts tsx jsx py lua sh bat ps1 ini log srt ass lrc`
  - 表外扩展名 → **不收**（`importDir` / `importFiles` 计入 `skipped` 并回执给用户）。
- 入库方式只有**复制**（自包含）：`itemAdd` / `importDir` / `importFiles` 一律把实体文件复制进 `items/`，**不记原始绝对路径**——库可整体搬移，源文件被删也不影响库。文本条目落盘即 `content` 写进 `.txt`；**只给 `srcPath` 的文本**（从本机上传一个 `.txt` / `.md` …）走 `readTextSrc()`：按 **utf8 整读**再写 `.txt`，上限 **16 MB**（`TEXT_IMPORT_MAX`，超限报错——撤销回滚要把整份内容在内存里搬进搬出，几百 MB 的日志当「文本」入库会把主进程拖死）。
- 名字净化 `safeName(s, fallback)`：`\ / : * ? " < > |` 与控制字符 → `_`、折叠空白、去首尾点与空格、限长 80；结果为空 / `.` / `..` → 兜底名（默认 `untitled`）。所有落盘名字（分类、素材夹、条目文件）都出自它。
- 越界防护 `relToAbs(root, rel)`：逐段 `safeName` + 段内出现 `..` 直接抛错，最后 `path.resolve` 做**前缀校验**，越出根目录抛「非法路径（越出素材库根目录）」。`assets:mkdir / rename / remove / create` 的 `rel` 入参全走它。
- 同级重名自动 `名称 2`、`名称 3`（`uniqueName`，素材夹与分类都适用）。

## 6. `.versions/` —— 撤销的实体支撑

- 任何**覆盖写**（`itemUpdateText` / `itemUpdateBytes`）前，旧文件被 `stashVersion()` 搬进 `<素材夹>/.versions/<itemId>__<ISO时间戳><原扩展名>`（时间戳里的 `:` 与 `.` 换成 `-`）；搬不动（占用 / 跨卷）退回复制。
- 同一 `itemId` 只留最近 **5 份**（`VERSION_KEEP`），按 mtime 从新到旧裁掉更旧的；裁剪失败不阻断写入。`listVersions(dir,itemId)` 给设置框与回滚用。
- **0 字节视为「还没有内容」**：往空条目里写第一份**不留版本**（否则每填一条素材都塞一个空文件，把真历史挤掉）。此时回传 `prevEmpty:true`，渲染层把「撤销」解释成「清回 0 字节」。
- **自指保护**：`srcPath` 就是该条目此刻那份文件时返回 `{noop:true}` 什么都不做。不拦的话：旧文件先被搬进 `.versions/`，随后复制报「源文件不存在」，条目凭空空掉（用户在文件框里挑了库里自己那份，是很常见的误操作）。渲染层据 `noop` **不记撤销账**（什么都没变）。
- 文本条目**就地改写**（`itemUpdateText` 与「文本条目收到 `srcPath`」的 `itemUpdateBytes` 都复用旧路径）：扩展名与文件名不随内容或源文件漂移，库内文本恒为 `.txt`；媒体条目按新扩展名重命名并删掉旧路径那份（旧文件此时已在 `.versions/`）。
- `assets:itemRead(id,itemId,version)` 的 `version` 传 `.versions/` 里的文件名即可读回历史份（撤销回滚走的就是这条路）。

## 7. `.trash/` —— 删除的唯一去处

`moveToTrash(root, abs, label)`：目标 `<root>/.trash/<ISO时间戳>__<label>`（时间戳同样把 `:` `.` 换成 `-`；重名由 `uniqueName` 叠序号），`label` 由调用方给：

| 动作 | 进入回收站的名字 |
|---|---|
| 删分类 / 删素材（`assets:remove` / `assets:delete`） | 文件夹名（连 `items/` 与 `.versions/` 一起走） |
| 删内容条目（`assets:itemRemove`） | 该条目的实体文件名 `<itemId><ext>` |

- 占用 / 跨卷导致 `rename` 失败时退回 **copy + rm**，语义仍是「进回收站」，绝不静默实删。
- **`shell.trashItem` 兑现不等于搬走了**：Windows 上系统回收站可能回一个 fulfilled 却一个字节都没动。所以走完系统回收站后要 `fs.existsSync` 复核一次，没搬走就继续走库内 `.trash` 回退；两条路都试过东西还在原地（目录里有文件被别的程序占着）才 `throw`，由 `assets:remove` / `assets:delete` 回 `{ok:false,error}` —— 宁可报「删除失败」，也绝不回一个假的「已删除」。
- **没有「清空回收站」按钮**（也没有应用内恢复入口）：空间与找回都留给用户在资源管理器里做，避免一键抹掉可恢复的历史。
- **非空分类可以直接删**（空 / 非空同一入口同一动作）：`assetRemoveCategory` 只负责把「会一起没掉什么」数清（`catRel` 前缀下的素材数 / 内容条目数 / 子分类数）写进确认框，并说明引用这些素材的节点会变「素材失联」；主进程 `assets:remove` 只按 `rel` 搬整只目录、不区分素材还是分类 —— 界面是唯一入口，代价说清在那里即可。早期版本在这里硬拦「非空分类不许删」，用户看到的就是「删除文件夹在有内容时失效」，已改掉。
- 删素材**不删节点**：节点转为「素材失联」（§9），端子与连线原样留着。

## 8. IPC 通道（`preload.js` 白名单桥 `api.assets*`）

渲染层没有 fs，一切读写经此。注册位与 `tools-store.js` 同处（`registerAssetsIpc({getDataDir, t})`，`main.js` 里紧跟 `registerToolsIpc` 之下）。所有返回 `{ok:true,…}` / `{ok:false,error}`；错误串经 `t()` 双语。

| channel | 参数 | 结果（`ok:true` 时） |
|---|---|---|
| `assets:getRoot` | — | `{path, defaultPath, configured, exists}` |
| `assets:setRoot` | `path` | `{path, previous, changed, scan}` |
| `assets:scan` | — | `{root, configured:true, scan}`；未指定根 → `{ok:false, needRoot:true}` |
| `assets:mkdir` | `parentRel, name` | `{rel, name}`（分类可嵌套） |
| `assets:rename` | `rel, name, toCatRel?` | `{rel, name, oldRel?}`；`toCatRel` ＝同一次改名顺带**移动到分类**（原地改名不返回 `oldRel`） |
| `assets:remove` | `rel` | `{trash}` |
| `assets:create` | `{catRel?, displayName?, desc?}` | `{asset}` |
| `assets:saveMeta` | `{id, displayName?, desc?, items?:[{id,title}]}` | `{asset}`；**提交的 items 顺序＝新条目顺序**，未知 / 重复 id 不参与，未提交的按原相对顺序挂末尾（改名与重排靠它，且绝不丢条目） |
| `assets:delete` | `id` | `{trash, rel}` |
| `assets:itemAdd` | `{id, type?, title?, content? \| srcPath? \| base64?}` | `{item, asset}`（文本走 `content`，也可只给 `srcPath` ＝ **上传本机文本文件**：`readTextSrc` 按 utf8 读进来再落 `.txt`；媒体走 `srcPath` / base64） |
| `assets:itemRead` | `id, itemId, version?` | `{kind:"text"\|"file", type, title, text, absPath, bytes, versions[]}`；带 `version` → `{version, kind, text, absPath}`；实体文件不在 → `error:"内容文件缺失"` |
| `assets:itemUpdateText` | `id, itemId, content, title?` | `{item, prevVersion, prevEmpty, asset}` |
| `assets:itemUpdateBytes` | `id, itemId, {srcPath? \| base64? \| empty?}` | 同上；**条目 type=text 时按 utf8 归一**（`readTextSrc` → 就地写 `.txt`，源扩展名不漂）；`empty:true` 清回 0 字节；自指 → 加 `noop:true` |
| `assets:itemSame` | `id, itemId, {content? \| srcPath?}` | `{same, bytes, empty?}` —— **按字节**判定「连进来的和库里是不是同一份」 |
| `assets:itemRemove` | `id, itemId` | `{removed, trash, asset}` |
| `assets:importDir` | `{srcPath, catRel?, displayName?, desc?}` | `{asset, found, skipped}`（本机文件夹 → 当前分类下新素材） |
| `assets:importFiles` | `id, paths[]` | `{items, skipped, asset}`（追加条目到既有素材） |

- **写类通道不返回 `scan`**：渲染层统一在 `assetAfterLibWrite(summary, msg, kind)` 里做「摘要回填节点 → `assets:scan` 重扫 → `scheduleSave` → 重画对话框 / 设置框 / 节点」。少一处「忘了刷新」的机会。
- 摘要 `assetSummary`：`{id, rel, folder, catRel, displayName, desc, itemCount, createdAt, updatedAt, items[]}`；条目 `itemSummary`：`{id, title, type, file, absPath, bytes, missing, createdAt, updatedAt}`。`absPath` ＝ 条目实体绝对路径、`missing` ＝ 文件不在 ⇒ 媒体字节复用现成 `asset:readDataUrl`，**不另开一条 base64 管道**。
- `itemSame` 的口径：文本按 utf8 字节比；媒体先比大小、再整读比内容；超过 **64 MB**（`SAME_FULL_READ`）只比大小——为一个提示把 2 GB 视频整读进内存不值当，宁可少提示一次。
- `importDir` **拍平**嵌套子目录（嵌套文件的标题取相对路径，一眼看出原层级），一次最多收 4000 个文件（`collectFiles` 上限，防误选大目录卡死）；`found` 是扫到的文件数、`skipped` 是不支持类型与写入失败数。`importFiles` 的 `skipped` 是**带原因的字符串数组**（逐项列出）。
- 按 id 定位素材夹（`findAssetDir`）：整树遍历找标记文件里的 `id`，找不到返回 `null`（⇒「失联」）。所以**绑定的真源是 id，不是路径**。

## 9. 渲染层口径（端子 / 绑定 / 失联）

**端子唯一真源**（`renderer/app.js`）：

- `inputCount(node)` / `outputCount(node)` 的 asset 分支都返回 `assetItems(node).length` —— 第 i 入 ↔ 第 i 出，**无控制端子**；`hasFixedInPorts` 纳入 asset（断一条线绝不把后面的端子号左移）。
- 节点上只存 `{assetId, assetRel, assetName, assetDesc, items:[{id,title,type}]}`；`assetItems()` 与主进程 `normItems()` 同口径兜底（空标题 → 「内容 N」，非法 type → `text`）。
- 类型判定链：`assetPortKind(node,dir,idx)` → `wireSourceMediaType()` 加「素材」分支（**声明优先于实际值**）⇒ `isImageWireFrom / isAudioWireFrom / isVideoWireFrom`、连线着色、下游端子接受度全部自动正确。
- `connectError`（`app-nodes.js`）四道：挡控制线；无条目时点名去设置里加内容；`toIndex` 缺省走 `assetFreeInPortIndex`（校验与落点同一个端子）；逐号占用检查 + **类型必须一致**（不像工具节点允许图像降级成文本路径——写盘按类型定扩展名，混填等于把散文写进 `.wav`）。
- 端子标题＝条目标题，带类型徽标（`app-canvas.js` 端子渲染；image 复用 `.img`，新增 `.aud` / `.vid` 配色）。

**绑定与重映射**：

- 唯一写入口 `assetBindNode(node, summary)`：写绑定 → `assetItemPerm(旧,新)` 算条目对应 → `assetRemapItemWires(node, perm)` 重写 `toIndex / fromIndex`（`rel` 关系线不动）。非法入参返回 `null`，**不碰节点**。
- `assetItemPerm(old,new)`：先认 `id`，再认去空格小写的**标题**，重名按出现顺序消费；`-1` ＝ 对不上号 → 该端子上的线断开（回执「n 条对不上标题的连线已断开（可撤销）」）。所以库里**改标题不甩线、重排线跟着内容走、删条目只断那一对**。
- `assetMovePerm / assetMoveItem` 的 perm 语义与「参数即端子」的 `fnToolMoveParam` 逐格一致（同一套端子重排规则，不另发明一份）。
- `migrateWf` 归一 asset 字段并 **`delete n.assetLost`**：失联是运行期派生判定，不许跨会话沉淀成存档事实。

**失联**：`assetNodeIsLost(node)` ＝ **已成功扫过库**（`ASSET_LIB.scanned`）且按 `assetId` 定位不到。任何读库失败都不下失联结论（宁可不显示占位，也不要在盘抖一下时误伤正常素材）。失联时 `items` 快照与连线**原样保留**（避免端子数漂移把线甩到别的端子上），body 给占位 + **重新绑定… / 重新扫描 / 打开素材库**。**任何路径都不会删用户的节点。**

**条目视图缓存**：`ASSET_ITEM_VIEW`（键 `assetViewKey(assetId,itemId)`）+ `assetItemViewLoad/Get/Set` + `assetItemsEnsure`（**单飞去重**）+ `assetViewRerenderSoon`（多条到货合并一次重画）+ `assetItemViewInvalidate / assetItemsViewPrune / assetItemsViewInvalidateAll`（写库后精确失效）。缓存不覆盖本地未提交的 dirty 文本；**文本失焦才写盘**（库是全应用共享的，不能每个键落一次盘）。

**四种类型都能「从本机上传」**（`ASSET_PICK_FILTERS` 含 `text` 一族，扩展名白名单与主进程 `EXT_TYPE` 同一口径）：

- 设置框「＋ 文本」＝小菜单两条并列：`assetSetAddMedia("text")`（多选 → `importFiles`，一个文件一条内容）/ `assetSetAddText()`（表单，字段带一颗 `assetTextUploadFieldAction()` → `assetPickLocalText()` 按 utf8 读进正文框，仍可继续手改，点确定才写库）。
- 条目行：文本行除「编辑文本」外另有「上传文件」＝ `assetItemReplaceFile(aid,itemId,title,"text")` → 与媒体同一出口 `assetWriteItem({srcPath})`（旧正文进 `.versions/`、撤销连库回滚）。
- 节点 body：`assetItemOps()` 四类型共用一行操作（选择 / 更换 + 在文件夹中显示），文本条目也吃上传，不再只有 textarea。

**拖放添加（资源管理器 → 素材库）**：唯一入口 `assetWireFileDrop(el, opts)`（挂 `dragenter / dragover / dragleave / drop`），一次拖入的分流在 `assetDropHandle(paths, opts)` —— **有追加目标＝追加内容条目，否则在指定 / 当前分类下新建素材**。`opts.target()` 给追加目标的素材摘要（空 = 新建），`opts.catRel` 给新建落进哪个分类（缺省 `ASSET_LIB.selCat`），`opts.holder` 是该区域的内部拖拽状态宿主，`opts.skip(t)` 让更里层的落点先接管（避免套娃高亮）。桥不在（`api.getPathForFile` / `api.assetsPathKind` 任一缺失 ＝ 老壳 / 非桌面环境）就整个不接管；内部拖拽（条目 ⠿ 重排 `holder.dragFrom ≥ 0`、侧栏 `application/x-mtnode-files`）一律放过；`ASSET_LIB.busy` 为真时 drop 直接忽略。拖放期间只加 `.asset-drop-hot` 视觉态与提示块 `.asset-drop-zone` 文案（「拖入本机文件 / 文件夹即可添加」→「松开即可添加」），**写库全在 drop 里做**。

| 落点 | 挂法 | 结果 |
|---|---|---|
| 左树分类行 `.asset-lib-catrow` | `catRel: rel` | **在该分类下新建素材**（弹命名框） |
| 左树素材行 | `target: () => a` | **追加内容条目**到该素材 |
| 右栏素材卡片 `.asset-lib-card` | `target: () => a` | 同上 |
| 内容条目列表（右栏详情 / 素材设置框 `.asset-set-rows`） | `target: () => a` | 同上（只收文件；拖文件夹提示「文件夹请拖到素材库空白处」） |
| 右栏库框主体 `.asset-lib-main-body` / 卡片网格 `#assetLibCards` 空白 | `target: assetDropLibTarget` | **详情态（已选素材）＝追加到该素材；卡片态（未选）＝在当前分类下新建素材** |

- **新建素材**（`assetDropNewAsset`）先弹 `assetFormDialog`「将新建素材」（唯一字段 **显示名称**，默认值 ＝ 首个拖入项的 basename、拖的是文件夹则取目录名；「创建」/ 取消，**取消＝什么都不做**），再按类型分流：首个是目录 → `assets:importDir`（整包拍平，单次最多 4000 个文件），是文件 → `assets:create` 建壳 + 同批其余文件走 `assets:importFiles` 追加成内容条目；同批里**第 2 个及以后的目录**建不了第二个素材，计入 `skipped`。
- **追加内容**（`assetDropAppend`）**不弹命名框**，文件逐个 `assets:importFiles` 追加；目录一个都不收（提示同上）。
- **表外扩展名一律跳过**（判定口径同 §5 的 `EXT_TYPE`）：新建的 toast 为「已上传为素材：<名>（内容 n 条 · 跳过 s 个不支持的文件）」，追加为「已添加 n 条内容（s 个文件类型素材库不收，已跳过）」；整批没有一个可用 → 「拖入的内容素材库不收：这里只收文本 / 图像 / 音频 / 视频文件或文件夹」。文本文件按 utf8 整读落 `.txt`，单份 > 16 MB（`TEXT_IMPORT_MAX`）计入跳过。

## 10. 执行引擎

- 素材节点＝**静态内容源**：`isCascadeWalkKind` 含 `asset`（与输入族一样「只穿过不执行」，级联能收进它下游的节点）。
- 取数（`valueForInput` 的 asset 分支 → `assetItemValueOf`）：
  - 文本 → `{kind:"text", text}`，**只认库里那份**（`savedText`）；body 里正在输入、还没失焦的草稿不算内容；库里明确 0 字节 → 给空串（别报「未就绪」）。
  - 图像 / 音频 / 视频 → `{kind:类型, path, url, text:url}`（`file:///` URL，与 `input_audio` / `input_video` 同口径）⇒ 下游 `proc_image` / `video_gen` / `music_gen` / `tts_gen` / `save` 的媒体端子直接可用。
  - 读不到（未绑定 / 失联 / `missing` / 正文尚未到货）→ **null**，按无输入处理并顺手 `assetItemViewLoad` 去取；**绝不拿快照猜旧值**。
- 运行前后各挂一次同步检查（都在 `app-nodes.js`，`try/catch` 包住，素材库读写挂了不拖累本轮执行）：
  - `playNodeBody` 之前 `assetPrepareForRun(node)`：本节点与被它连到的素材节点，把条目正文读齐 + 空条目自动同步。
  - `playNode` 拿到结果之后 `assetSyncConsumers(node)`：刚产出的值直连的素材端子再查一遍。
- 同步判定 `assetSyncCheckPort(node, idx)` 返回四态：`"none"`（没连线 / 没值 / 未绑定 / 失联）、`"wrote"`（库里这条是空的 → 已自动写进去）、`"same"`（连入的与库里字节相同 → 不亮不写）、`"pending"`（不同 → **⟳ 点亮，点击才换**，值暂存 `ASSET_SYNC_PENDING`）。空不空按 `assetItemCurBytes() <= 0` 判。
- 素材节点没有 `batch`（NODE_DEFAULTS 里不存在），也不接受控制线（§9），因此不参与批量 / 聚合 / 控制流。

## 11. 撤销账：`snapshotState().assetEdits`

现成撤销只回滚**画布 JSON 快照**（`pushHistory / snapshotState / applySnap`），库文件在快照之外；而库是多画布共享的——不回滚就等于「撤销后数据仍被改」。所以：

1. `snapshotState()` 多一个字段 `assetEdits: []`。
2. 任何写库前先 `assetHistorySlot()`：压一格**操作前**快照，并拿回**真正进栈那个对象**——`pushHistory` 有闸（后台写非当前画布 / `_skipCanvasHistory`），没压进去就返回 `null` ⇒ 这次**不记账**（旧内容仍在 `.versions/`，只是撤销不回滚库）。
3. 写成功后 `assetRecordEdit(snap, e)` 记 `{assetId, itemId, type, title, prevFile, prevEmpty}`：`prevFile` ＝ `.versions/` 里那份旧文件的绝对路径，`""` ＝ 改之前本来就是空的（撤销＝清回空）。
4. `undo()` / `redo()` 收敛为 `stepHistory(kind)`：`applySnap` 之后若那格记了库改动，`assetRollbackEdits(edits, cur)` 按账把库贴回去（`assetRestoreEdit` 是单项动作），并给对面那格记上反向账（redo 能原样贴回，不需要额外副本）。toast：`已撤销 · 素材库内容已回滚（n 项）`；有失败则 `已撤销 · 素材库有 n 项没能回滚（旧内容仍在该素材的 .versions 目录里）`。回滚在途（`assetRollbackBusy()`）时挡住新的撤销 / 重做。

写库的**唯一出口**是 `assetWriteItem(assetId, itemId, payload, opts)`（body 文本提交、浏览换文件、设置框编辑、端子 ⟳ 点击、运行期自动同步全走它），保证「压快照 → 写库 → 记账 → 作废缓存 → 回填节点」顺序一致；`opts.light` 给批量同步用（只丢缓存，不整框重画）。

## 12. 文件与函数地图

| 层 | 位置 | 关键成员 |
|---|---|---|
| 主进程存储 | `assets-store.js` | `registerAssetsIpc` · `rootPath / ensureRoot` · `safeName / relToAbs / toRel / uniqueName` · `normItems / readMarker / writeMarker` · `scanLibrary / findAssetDir / walkDirs` · `assetSummary / itemSummary` · `createAssetDir / addItemEntry / replaceItemFile / uniqueItemFile / stashVersion / listVersions / moveToTrash` · `collectFiles / copyPath / rmrf` · `readTextSrc`（`TEXT_IMPORT_MAX` 16MB）|
| 桥 | `preload.js` | `api.assets*`（与 `tools*` 同风格） |
| 画布机制 | `renderer/app.js` | `NODE_DEFAULTS.asset` · `assetItems / isAssetNode / assetPortKind / assetPortAccepts / assetFreeInPortIndex / assetItemPerm / assetRemapItemWires / assetBindNode / assetMovePerm` · `assetItemValueOf / assetItemAbsPath / assetPortInboundValue / assetDisplayValueOf` · `inputCount / outputCount / hasFixedInPorts / wireSourceMediaType` · `snapshotState / stepHistory` |
| 库界面与动作 | `renderer/app-assets.js` | `openAssetsLibrary` · `assetScanCall / assetApplyScan / assetRescan / assetChangeRoot` · **左树** `paintAssetTree`（分类 + 素材一体树：`.asset-lib-caret` 展开箭头、`.asset-lib-assetrow` 素材行、展开态 `ASSET_LIB.expanded`、选中态 `ASSET_LIB.selAssetId`）· **右栏** `paintAssetLib`（未选素材 / pick 模式回落 `paintAssetCards`；选中素材走 `paintAssetDetail`＝`.asset-detail-head` 素材名 · 描述 · 相对路径 + `.asset-detail-acts` **设置 / 复制到画布 / 删除 / 打开文件夹**（`openAssetSettings` / `assetInsertToCanvas` / `assetDeleteAsset` / `assetOpenPath(rel)`），正文＝可编辑的内容条目列表）· **编辑目标与写库收尾** `assetEditAssetId / assetEditAssetFor / assetEditAfterWrite`（设置框与右栏详情共用同一条写库路径，不再写死 `ASSET_SET.id`）· `assetNodeBind / assetNodeUpload / assetNodeRebind / assetNodeReveal / assetNodeOpenSettings` · `openAssetPicker`（绑定选择复用同一渲染） · `openAssetSettings` 一族 · `ASSET_PICK_FILTERS`（含 `text`）· `assetItemReplaceFile / assetPickLocalText / assetFormLoadText / assetTextUploadFieldAction` · `assetWriteItem / assetHistorySlot / assetRecordEdit / assetSyncCheckPort / assetRunPrepare / assetSyncConsumers / assetRollbackEdits` · **类型徽标** `assetTypeCounts / assetKindOf / assetKindLabel / assetKindChip`（左树素材行 · 卡片 · 详情头共用：整包单一类型显示「文本 / 图像 / 音频 / 视频」，两种以上显示「混合」，无内容显示「空」；tooltip 给逐类型数量） |
| 节点界面 | `renderer/app-canvas.js` | `buildAssetBody`（未绑定 / 失联 / 正常三态）· `assetItemOps`（四类型共用的「选择 / 更换 + 在文件夹中显示」）· 端子标题与徽标 · ⟳ 两态 tooltip |
| 执行 | `renderer/app-nodes.js` | `connectError` asset 分支 · `playNodeBody` 前置准备 · `playNode` 后置同步 · `sizeNodeForTidy / layoutNodePriority` |
| 接线 | `renderer/app-boot.js` + `renderer/index.html` | `#btnAssets` 点击 → `openAssetsLibrary`；脚本顺序 `app-tools.js` → `app-assets.js` → `app-boot.js` |

## 13. 不变量清单（改这里之前先读）

1. 判定素材只看 `.mtnode-asset.json`；素材夹不下探，`items/` 里的散落文件不算条目。
2. `itemId` 与 `items/<itemId><ext>` 一旦生成就**永不改**：改标题、改显示名、移动素材、换根目录都不碰它——端子与连线全靠它保号。
3. `items[]` 的数组顺序就是端子顺序；任何重排必须**同时**落到库（`saveMeta` 提交顺序）与画布（`assetRemapItemWires`）。
4. 节点上**永不存内容实体**（正文 / 图片字节 / 绝对路径），只存绑定（id + 相对路径）与 `{id,title,type}` 快照。
5. 覆盖写必留 `.versions`（0 字节除外），删除必进 `.trash`，任何路径都不实删。
6. 「是不是同一份」只看**字节**（`assets:itemSame`），不看路径。
7. 读库失败**不等于**失联；失联必须有「已成功扫过」这个前提，且失联不许改动画布端子与连线。
8. 写库必配撤销账（`assetHistorySlot` 返回 `null` 时不写账）；没有账就不该写。
9. 素材节点不执行、不吃控制线、不参与批量；它只是取值时的一个静态源。
10. 顶栏 `#btnAssets` 的接线在 `app-boot.js`，界面逻辑只在 `app-assets.js`（`index.html` 脚本顺序＝分层：`app-tools.js` → `app-assets.js` → `app-boot.js`）。
11. **端子号 = 内容条目号**：任何按连线取值的入口（`valueForInput` / `refInputIdxFor` / `wireSourceIndex` / `inputValuesFor` / `valueFromWire` / `superPortIdxFromWire`）对素材线都必须用 `w.fromIndex`，拿批量下标去取会串条目。素材是「条目型静态源」，判定唯一真源 `isItemPortSource()`。
12. **素材内容可被下游引用**：闸门只有一处 `isRefableSource()`（有条目的素材＝合法来源，`@` 候选 / 全局广播 / Tag 候选共用），注入按「节点 + 端子号」防重（一个素材接进同一消费者多条内容要逐条进背景），条目展开走 `assetRefItems()` 供 `allTextItems` / `allImageItems` 复用。回归：`test/smoke-asset-refs.js`。

## 14. 已知边界（下一轮候选）

- **Agent / 会话侧未接入**：没有 `mtnode_assets` 网关工具（会话不能 list / query / 写入素材），素材只能从素材库界面或素材节点操作。网关改动要遵守 `dsh/DESIGN.md` 三层契约，单独一轮做。（画布侧已通：素材的内容端子可被下游 `@` 引用并自动进背景信息，见上节第 12 条。）
- 素材库界面无搜索、无跨分类拖拽（用右键「移动到分类…」）。
- 单一根目录（不支持多库 / 云同步）；根目录变更＝重新扫描，失联节点需手动重绑。
- `.trash` 无应用内恢复入口（资源管理器手工找回）；`.versions` 有 `itemRead(version)` 可读，但界面上没有历史浏览 / 逐份还原。
- 同一素材被多张画布同时编辑时**后写的赢**（无字段级合并 / 冲突提示）。
- 二进制条目单次全量读写（无分块 / 流式），超大文件靠 `itemSame` 的 64 MB 只比大小兜住提示开销。

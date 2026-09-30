# 应用市场（store-saas · /api/apps + /mtnode/apps/catalog.json）

MTNode 的「应用」= 用户自建 / 云端分发的本机小应用（一个文件夹一份，自带 `index.html` + `assets`，
客户端 `apps-store.js` 开独立窗口跑）。本文只讲**云端这一侧**：store-saas 的应用市场接口、
静态目录口径、上传脚本与部署。客户端安装 / 导出 / 冲突三态见 `apps-store.js` 与 `renderer/app-apps.js`。

## 一、数据落点（沿用 store-saas 既有口径）

| 内容 | 落点 |
| --- | --- |
| 应用记录（元数据 / 版本 / sha256 / 归属） | `DATA_DIR/db.json` 的 `apps[]`（与 `templates` / `skills` 同一份库、同一套 `saveDb`） |
| 应用包 | `DATA_DIR/apps/<id>.zip`（单版口径）；多版本模式见 §七：`DATA_DIR/apps/<id>/<version>.zip`，`<id>.zip` 保留为最新版 |
| 图标 | `DATA_DIR/app-icons/<id>.png｜jpg｜webp`（图片口径同预览图：png/jpeg/webp，≤500KB） |
| 账户 / 会话 / 身份 | 仍走 `account-store.mjs`（`users` / `sessions` / `identities`），应用市场不碰 |

`DATA_DIR` 默认 `<store-saas>/data`，线上为 `/opt/mtnode-store/data`。owner **一律由服务端按登录态
绑定**（`POST /api/apps` 时取 `authUser(req)` 的 `user.id`），请求体里的 `userId` / `owner` 一律忽略。

## 二、接口

鉴权口径与 templates / skills 一致：`Authorization: Bearer <登录 token>`；列表 / 详情 / 下载免登录，
写操作必须登录；改 / 删仅 **owner**（`isAdmin` 可代删，同 templates）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/apps` | 列表：`q`、`sort`（`new` / `downloads` / `title`）、`page`、`pageSize`（≤50）、**`owner`**（username 或 userId，按归属过滤） |
| GET | `/api/apps/catalog` | 静态目录文档（与 `/mtnode/apps/catalog.json` 同一份字段，见第三节；静态目录写不进去时客户端就回退这里） |
| GET | `/api/apps/pub` | 静态目录体检：`{ok, dir, dbApps, diskApps, fallback, missingOnDisk, checks, last}`（免登录、只读） |
| GET | `/api/apps/:id` | 详情（`item` = 统一字段 + `ownerUser` / `mine` / `canDelete` / `hasIcon`） |
| GET | `/api/apps/:id/file` | 下载包：默认回 JSON（`base64` + `sha256` + `bytes`）；`?format=raw` 直出 `application/zip`（带 `X-Content-SHA256`），同时计数 downloads |
| GET | `/api/apps/:id/icon` | 图标（无图标 404） |
| POST | `/api/apps` | 上传（**必须登录**）。体：`id`、`title`、`fileBase64`（或 `zipBase64`）、`version`、`description`（或 `desc`）、`entry`、`tags`、`icon`、`iconBase64` |
| PATCH | `/api/apps/:id` | 更新（仅 owner）：覆盖 zip / 图标 / 元数据；**未传 `version` 时服务端自动 +1**（`x.y.z → x.y.(z+1)`） |
| DELETE | `/api/apps/:id` | 删除（仅 owner；管理员可代删），同时删 zip 与图标 |

多版本的追加 / 删除 / 下架与配额、声明留痕见 **§七**（2026-09 新增，本节只保留单版口径）。

> **所有写操作（`POST` / `PATCH` / `DELETE` / 版本增删 / 上下架）都会在改完库之后立刻把静态目录
> 重新发布一次**（`catalog.json` + 该应用的 zip / 图标），见第五节「静态目录 = 接口变更自动落盘」。
> 发布失败不影响接口本身的成功：业务不回滚，只记日志告警，客户端自动降级走 `/api/apps/catalog`。

约束与校验：

- **id** = 客户端安装目录名（也是安装后的文件夹名与画布 id 口径）：2–64 位字母 / 数字 / `.` `_` `-`，
  统一**小写**入库，Windows 保留名（`con` / `nul` / `com1`…）拒绝；已存在同 id → `409 APP_EXISTS`
  （更新请走 PATCH，仅 owner 可改，避免误覆盖别人的应用）。
- **zip** ≤ 24MB（base64 后约 32MB，仍在服务端 `MAX_BODY` 40MB 与 nginx `client_max_body_size 40m` 内）；
  上传时读 zip 中央目录校验：必须是合法 zip、条目路径不得越界、**包内必须有入口页**
  （`entry` 声明的那个，否则顶层 `index.html`，再否则唯一的顶层 html）。
- 标题 ≤80 字、说明 ≤2000 字、版本走 `normalizeVersion`（`[A-Za-z0-9][A-Za-z0-9._+-]{0,31}`）。
- 下载与删除会同步账号的 `downloadsReceived`（与 templates / skills 同一套计数口径）。

## 三、静态目录口径（`http://mt-agent.com/mtnode/apps/catalog.json`）

客户端（`apps-store.js`）只读**目录文档**（`MTNODE_APPS_URL`，默认 `http://mt-agent.com/mtnode/apps`
+ `/catalog.json`），所以**静态清单与接口共用同一份条目字段**（服务端 `appCatalogEntry()` 是唯一实现）：

| 字段 | 说明 |
| --- | --- |
| `id` | 应用 id（安装目录名，小写） |
| `title` | 标题（客户端也认 `{zh,en}` 形式） |
| `version` | 版本号 |
| `desc` / `description` | 说明（同义两字段，写哪个都认） |
| `icon` | 图标地址；服务端存了图标文件时给相对本目录的 `icons/<id>.<ext>`，否则用上传时写的 `icon` 字符串（可为绝对 URL） |
| `zipUrl` / `url` | 应用包地址；**相对本目录**写 `<id>.zip`，客户端会解析成 `http://mt-agent.com/mtnode/apps/<id>.zip`（同源限制：zipUrl 只允许与静态目录 / 云端接口同主机） |
| `sha256` | 包校验和（客户端装了才校验；声明了就必须一致） |
| `owner` | 归属账号 username（服务端按登录态绑定） |
| `entry`、`tags`、`bytes`、`downloads`、`createdAt`、`updatedAt` | 附加字段，客户端按需读 |

文档结构：

```json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "feed": "http://mt-agent.com/mtnode/apps",
  "apps": [
    {
      "id": "my-app",
      "title": "我的应用",
      "version": "1.0.1",
      "desc": "一句话说明",
      "description": "一句话说明",
      "icon": "icons/my-app.png",
      "zipUrl": "my-app.zip",
      "url": "my-app.zip",
      "sha256": "…64 位小写十六进制…",
      "owner": "ms2308",
      "entry": "index.html"
    }
  ]
}
```

两条产出路径，字段完全一致：

1. **接口**：`GET /api/apps/catalog`（直接回上面这份结构，`apps` 按创建时间倒序）。
   **服务端在每次应用变更后自动把这份文档落盘成静态目录**（见第五节「单一真源」），
   所以线上目录与库不会再漂移；客户端在静态目录为空 / 拉不到时也直接读这个接口。
   `python upload-app.py --catalog-out store-saas/apps/catalog.json` 仍可把当前目录写到本地文件。
2. **手写清单**：`store-saas/apps/catalog.json`（模板，随 `upload.py` 一起发布；只在线上**没有**目录时
   才会被装上，绝不覆盖线上真实目录）。与库里记录冲突时以库（`/api/apps/catalog`）为准。

> 客户端读目录的顺序（`apps-store.js`）：静态目录 → 云端接口 `/api/apps/catalog` → 本机缓存
> （`<数据目录>/apps-cache/catalog.json`）→ 空列表。响应里的 `source` 是 `remote` / `api` / `cache` /
> `empty`，每一层失败的原因累加在 `remoteError` 里；渲染层据此区分「云端目录已更新 / 云端接口 /
> 本机缓存（云端暂时拉不到）」。**静态目录 0 条视为不可用**（不是「云端没有应用」），会继续往下回退。

## 四、上传脚本 `store-saas/upload-app.py`

与 `upload.py` 同一套配置口径（只读环境变量，凭据不落盘），但**走 HTTP API 而不是 SFTP**：登录 →
`POST /api/apps` 新建，或 `--update` 走 `PATCH /api/apps/<id>`（版本 +1 并覆盖 zip）。

```bash
# 凭据（与 seed-skills.mjs 同口径）
export MTNODE_STORE_URL=https://www.mt-agent.com/mtnode/store-api   # 默认值
export MTNODE_STORE_USER=ms2308
export MTNODE_STORE_PASS_FILE=/opt/mtnode-store/.store-pass          # 或 MTNODE_STORE_PASS

# 新建（id 已存在会报错并提示加 --update）
python store-saas/upload-app.py --zip "我的应用.zip" --id my-app --title "我的应用" \
    --desc "一句话说明" --version 1.0.0 --icon store-saas/apps/icons/my-app.png \
    --tags 工具,效率 --catalog-out store-saas/apps/catalog.json

# 更新自己的应用（覆盖 zip、版本 +1：也可 --version 显式指定）
python store-saas/upload-app.py --zip "我的应用.zip" --id my-app --update

# 查自己名下的应用 / 删除自己的应用 / 只看请求不发送
python store-saas/upload-app.py --list
python store-saas/upload-app.py --id my-app --delete
python store-saas/upload-app.py --zip "我的应用.zip" --id my-app --title x --dry-run
```

脚本会本地算 sha256 并在上传后与服务端回的 `catalog.sha256` 比对，不一致直接报错退出。

## 五、部署

```bash
python store-saas/upload.py        # SFTP：server.mjs + apps/ 目录 → /tmp/mtnode-store-upload
                                   # 远端自动跑 deploy.sh
```

`deploy.sh` 会：建 `data/apps`、`data/app-icons`、`/var/www/mtnode/apps/icons`；把 `apps/*.zip` 与
`apps/icons/*` 装进 `/var/www/mtnode/apps/`（上传包里有就装）；跑 `patch-nginx.py` 补
`location ^~ /mtnode/apps/`（alias `/var/www/mtnode/apps/`）；重启服务后从**本机** `GET /api/apps/catalog`
拉一次真实清单落盘，再自检 `/mtnode/apps/catalog.json`（含条数、每个 `zipUrl` / `icon` 的 HTTP 码）、
`/mtnode/store-api/api/apps`、`/mtnode/store-api/api/apps/pub`。

> **不会再用仓库里的空模板覆盖线上目录。** 早先 `deploy.sh` 无条件把 `store-saas/apps/catalog.json`
> （模板内容 `apps: []`）`install` 到 `/var/www/mtnode/apps/catalog.json`：模板是空的、包里也没有 zip，
> 于是每次部署都把线上目录刷成 120 字节的空清单 —— 客户端表现为「应用库未连入云端」（实测事故）。
> 现在只在线上**没有**该文件时才放上传目录，其余情况保留线上文件、由 `server.mjs` 启动发布接管。

### 静态目录 = 接口变更自动落盘（单一真源）

`server.mjs` 启动时、以及**每一次应用变更之后**（新建 / 更新 / 追加版本 / 删版本 / 下架 /
重新发布 / 删除应用），都会把 `appCatalogDoc()` 原子写进静态目录，并把该应用的
`<id>.zip`（多版本还有 `<id>/<version>.zip`）与 `icons/<id>.<ext>` 一起同步过去：

- 目标目录：`MTNODE_APPS_WEB_DIR`（默认 `/var/www/mtnode/apps`，本机开发可指向临时目录）；
- 写目录的时机是「内容先落齐、清单最后写」—— 目录里出现的条目，包与图标一定已经在盘上；
- 上一次发布写下、这一次不再需要的文件按 `.mtnode-apps-static.json` 清单清掉（只删自己写过的）；
- 发布失败（缺权限 / 路径不存在）只记日志 + 告警，**不回滚业务**，客户端自动降级走接口目录；
- 体检：`GET /api/apps/pub` 回 `{ok, dir, dbApps, diskApps, fallback, missingOnDisk, checks}`。

所以典型发布只需要一步：

```bash
# 上传包（接口侧立即生效；服务端随即把静态目录刷成同一状态）
python store-saas/upload-app.py --zip "我的应用.zip" --id my-app --title "我的应用" --update \
    --accept-declaration
# 改了 server.mjs 本人才需要走部署
python store-saas/upload.py
```

`--catalog-out`（写本地手写清单）仍可用，但不再是客户端目录生效的必要条件。静态目录写不进去时，
客户端（`apps-store.js`）会回退 `<MTNODE_STORE_URL>/api/apps/catalog`（与静态目录同一份字段），
下载与图标按来源解析 —— 见 §6 与 §7.7。

### 多版本模式（`MTNODE_APP_VERSIONS=1`）的部署

1. **服务端开开关**：在 `store-saas/mtnode-store.service` 的 `Environment=` 里加
   `MTNODE_APP_VERSIONS=1`（或 systemd 的 drop-in），重启服务。包会落到
   `DATA_DIR/apps/<id>/<version>.zip`，同时把最新版刷成 `DATA_DIR/apps/<id>.zip`。
2. **静态目录带上每一版**：`deploy.sh` 会把 `apps/<id>/` 子目录一起装进 `/var/www/mtnode/apps/`
   （`upload.py` 本来就递归上传 `apps/`），所以每一版的包都从
   `http://mt-agent.com/mtnode/apps/<id>/<version>.zip` 可取。
3. **目录条目**：`python store-saas/upload-app.py --catalog-out store-saas/apps/catalog.json`
   写出的清单里，每个应用多两项 —— `latestVersion` 与 `versions[]`（每项自带自己的 `zipUrl` /
   `sha256` / `bytes`）。手写清单照这个形状写即可；客户端在缺 `versions` 时退回单版行为。
4. **回滚**：去掉环境变量重启即回到旧的覆盖式行为（磁盘上多出来的 `<id>/` 目录不会影响旧口径）。

> ⚠️ `upload-app.py` 现在对上传 / 更新路径强制要求 `--accept-declaration`（服务端也强制校验
> `acceptDeclaration === true`，见 §七.3）。这是法律声明口径的**有意变更**：老命令要补上这个参数
> 才能继续上传（`--list` / `--delete` / `--dry-run` 不受影响）。


## 六、自检

```bash
curl -sS http://127.0.0.1:8787/api/health                      # apps 计数
curl -sS http://127.0.0.1:8787/api/apps?pageSize=5             # 列表
curl -sSI http://127.0.0.1:8787/api/apps/<id>/file?format=raw   # 包（X-Content-SHA256）
curl -sS http://127.0.0.1:8787/api/apps/pub                     # 静态目录体检（条数 / 缺文件 / 降级）
curl -sS -H 'Host: mt-agent.com' http://127.0.0.1/mtnode/apps/catalog.json
```

**「应用库未连入云端」排查顺序**（照这个顺序走，别跳）：

1. `GET /mtnode/store-api/api/apps` 有货、`GET /mtnode/apps/catalog.json` 是空 `apps: []` 或 404
   → 静态目录没跟上：看服务日志 `apps static dir`（发布失败会带原因：权限 / 路径），
   再看 `GET /api/apps/pub` 的 `fallback: true` 与 `missingOnDisk`；
   权限问题就 `chown` / `chmod` 那个目录，或设 `MTNODE_APPS_WEB_DIR` 指到可写目录并重启服务。
2. 目录里有条目、但 `<id>.zip` / `icons/<id>.png` 404 → 包没同步：
   重启一次服务（启动即重发），或 `deploy.sh` 的自检行 `apps-file:` 会直接点名哪个文件拿不到。
3. 线上目录 120 字节 + `updatedAt 2026-01-01` → 是**旧版部署链**留下的空模板覆盖，
   按上面的部署口径更新 `deploy.sh` 与 `server.mjs` 后重发一次即可（新链会立即刷成真实目录）。
4. 客户端仍显示缓存 → 应用中心「刷新」；`apps-store.js` 会按 静态 → 接口 → 缓存 的顺序各试一遍，
   每一层的原因都写在响应 `remoteError` 里，也打在主进程日志 `[apps-store]`。

已知边界：

- `owner` 过滤认 username 或 userId，两者都对不上就是空列表；未登录也看不到 `mine` / `canDelete`。
- 命令式列出 / 更新只按 **应用 id** 定位（id 全局唯一、小写）；一个账号可以有多条应用，互不影响。
- 静态目录现在是**服务端自动落盘的产物**（上面「单一真源」一节）：手改 `/var/www/mtnode/apps/catalog.json`
  会被下一次发布覆盖回去，要改目录内容请改库（接口）而不是改那份文件。
- 客户端安装 / 更新只替换本机账本里的载荷，用户数据（`storage/`、应用自己的画布）不动 ——
  云端这边不参与，也不该参与。

## 七、上架与多版本（**接口契约 = 本节；服务端 / 客户端两条流都以此为准**）

「上架应用」= 客户端开发页把当前应用打成 zip（`apps-store.js` 的 `exportZip`）→ AI 生成元信息 →
用户核对编辑 → 勾选声明 → `POST /api/apps`（或追加版本）→ 云端按**一个应用收纳多个版本**。
开关：环境变量 `MTNODE_APP_VERSIONS`（`1` / `true` / `yes` / `on` 打开，**默认关**）。

### 7.1 多版本开关的两种行为

| | 关（默认，旧口径不变） | 开（`MTNODE_APP_VERSIONS=1`） |
| --- | --- | --- |
| 包落点 | `DATA_DIR/apps/<id>.zip`（一版一份，覆盖） | `DATA_DIR/apps/<id>/<version>.zip`（一版一份）；同时把**最新版**刷成 `DATA_DIR/apps/<id>.zip` 供老客户端 / 静态目录 |
| 版本记录 | `apps[].version` 单个字段 | `apps[].versions[]`（追加）+ `apps[].latestVersion` |
| 更新 | `PATCH /api/apps/:id` 覆盖包、版本 +1 | 用 `POST /api/apps/:id/versions` 追加；`PATCH` 仍可用（等价「只改元信息 / 覆盖最新版」，追加一条版本记录） |
| `GET /api/apps/:id/file` | 回单包 | 默认回 `latestVersion`；`?version=x.y.z` 回指定版本 |

开关**关闭**时调 `POST /api/apps/:id/versions` / `DELETE /api/apps/:id/versions/:version` 一律回
`409 APP_VERSIONS_DISABLED`（中文提示改走 `PATCH`）—— 多版本请求**不静默降级**成覆盖写；
`GET /api/apps/:id/versions` 与 `unpublish` / `publish` 两种状态下都可用（下架过滤与开关无关）。
**声明与配额两条门槛始终强制**（与开关无关）：否则关掉开关就能绕过声明与限额。

### 7.2 记录扩展字段（`db.json` 的 `apps[]`）

```jsonc
{
  "id": "my-app", "userId": "…", "title": "我的应用", "description": "…",
  "version": "1.2.0",              // = 最新版版本号（老字段，语义不变）
  "latestVersion": "1.2.0",        // 开关打开时写；等于 versions 里最新的那一版
  "unpublished": false,            // 作者下架 = true（记录与包都保留，目录不显示）
  "unpublishedAt": 0,
  "versions": [                    // 开关打开时写；按追加顺序
    {
      "version": "1.2.0",
      "parentVersion": "1.1.0",    // 上一版版本号；首版 = ""
      "bytes": 123456,             // 该版 zip 原始字节数
      "sha256": "…64 位小写十六进制…",
      "entry": "index.html",
      "note": "修了导出按钮",       // 版本说明（≤200 字）
      "uploader": "ms2308",        // username
      "uploaderId": "…",
      "createdAt": 1730000000000,
      "declarationAt": 1730000000000
    }
  ]
}
```

开关关闭时上面三个字段一律不写（`versions` 缺失 = 单版条目，客户端据此退回旧行为）。

### 7.3 声明留痕（`db.json` 的 `appDeclarations[]`）

每次应用写操作（新建 / 追加版本 / 更新）都必须 `acceptDeclaration === true`，
否则 `400 DECLARATION_REQUIRED`（不落任何盘）。通过后追加一条：

```jsonc
{ "at": 1730000000000, "userId": "…", "username": "ms2308", "ip": "1.2.3.4",
  "id": "my-app", "version": "1.2.0", "action": "create|version|update" }
```

声明正文（客户端逐字展示，中文）：**本人保证该应用符合中华人民共和国法律法规，
不含违法有害内容，不侵犯他人知识产权；因该应用产生的全部责任由上传者承担。**

### 7.4 接口（新增，全部 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/apps/:id/versions` | 版本树数据（免登录，公开信息）：`{ok,id,latestVersion,unpublished,versions:[{version,bytes,sha256,parentVersion,uploader,createdAt,note,current}]}`；`current` = 是不是最新版 |
| POST | `/api/apps/:id/versions` | 追加版本（仅 owner，必须 `acceptDeclaration:true`）。体：`version`（必填，不能与已有版本重复）、`parentVersion`（缺省 = 当前 `latestVersion`）、`versionNote`/`note`、`zipBase64`、`entry`、`iconBase64`、`title`/`description`/`tags`（可选，同步元信息）。回 `{ok,item,catalog,version}` |
| DELETE | `/api/apps/:id/versions/:version` | 删该版（仅 owner）：**包与版本记录一起下掉**（不留灰行），配额当场释放；若删的是最新版 → `latestVersion` 指向剩余最高版；全删光 → 应用随之下架（`unpublished=true`）。回 `{ok,latestVersion,versions}` |
| POST | `/api/apps/:id/unpublish` | 下架（仅 owner）：目录与公开列表不再显示；记录与所有版本的包保留 |
| POST | `/api/apps/:id/publish` | 重新发布（仅 owner）：清 `unpublished` |

既有 `POST /api/apps`（新建）语义扩展：开关打开时同时写 `versions[]` 的首版 + `latestVersion`；
两处都必须带 `acceptDeclaration:true`。

### 7.5 配额（服务端强制，**落盘之前**校验）

| 常量 | 值 | 口径 |
| --- | --- | --- |
| `MAX_ACCOUNT_APP_BYTES` | 50 MB（`52428800`） | 一个账号**云端已存包总量** = 名下所有应用所有版本 `bytes` 之和（新建 / 追加版本后不得超过） |
| `MAX_ACCOUNT_APPS` | 5 | 一个账号最多 **5 个应用**（给已有应用追加版本不计入） |

超限返回 `413` + `{ok:false, code:"QUOTA_BYTES"|"QUOTA_APPS", used, limit, error}`，
`error` 为中文并带当前用量（客户端据此提示「先删旧版」）。配额检查只认「已通过全部校验」的请求。

### 7.6 静态目录（客户端唯一入口）扩展

`appCatalogEntry()` 增加：`latestVersion`、`versions[]`（每项带自己的 `zipUrl: "<id>/<version>.zip"`、
`sha256`、`bytes`、`parentVersion`、`uploader`、`createdAt`、`note`）。**已下架（`unpublished`）
的应用不进 `appCatalogDoc()`**，也不进 `GET /api/apps` 的公开列表（`?owner=` 查自己时带
`includeUnpublished=1` 才看得到）。每一版的包都要在静态目录里：
`/var/www/mtnode/apps/<id>/<version>.zip` —— 现由 `server.mjs` 的发布流程自动同步（不再依赖人工上传 `apps/`）。

### 7.7 客户端行为（`renderer/app-apps.js` + `apps-store.js`）

- **目录双源**：静态目录（首选）→ 云端接口 `GET /api/apps/catalog`（兜底）→ 本机缓存 → 空列表；
  响应带 `source`（`remote` / `api` / `cache` / `empty`）与 `sourceBase`（该来源的基址）。
- **下载与图标按来源解析**（`zipUrlsOf()`，主进程算好随目录一起下发，渲染层不重复推导）：
  - 静态来源：`<FEED>/<id>.zip`、`<FEED>/<id>/<version>.zip`、`<FEED>/icons/<id>.<ext>`；
  - 接口来源：`<store>/api/apps/<id>/file?[version=]<v>&format=raw` 与 `<store>/api/apps/<id>/icon`。
  多版本条目在接口来源下**不能**再下静态路径（静态目录里没有那个文件），安装时按上面的地址取包。
- 安全口径不变且更明确：解析只允许 http(s)，host 必须命中「静态目录 / 云端接口」两个允许基址之一
  （`base` 由目录来源决定，目录内容改不了下载源）。
- `normSpec()` 读 `versions[]` / `latestVersion`；**目录条目没有 `versions` 时退回单版行为**
  （`versions = [{version: spec.version, zipUrl: spec.zipUrl, sha256: spec.sha256}]`），绝不报错。
- 应用详情区新增「版本」块：按 `parentVersion` 缩进成树；每行 = 版本号 · 时间 · 大小 · 上传者 ·
  版本说明 · 状态（`最新` / `本机已装`）；点某行 = 按该版本下载（`appsInstall(id, mode, version)`）；
  父版已被删除时在树里显示 `根版本（已删）` 占位行承接子版。
- 「更新」按钮恒指向 `latestVersion`；`mine` 条目显示「下架 / 重新发布」。

## 八、作者 · 开发中名单 · 二次开发（fork）分支

本节是本轮（作者显示 + 校验值收纳 + 库/开发名单分工 + fork 声明）的**唯一契约**：
服务端字段、客户端判据与落盘口径都在这里；实现分别落在 `store-saas/server.mjs`、
`apps-store.js`、`renderer/app-apps.js`、`renderer/app-apps-flow.js`、`renderer/app-publish.js`。

### 8.1 应用身份 = 应用 id + 作者 uid

- **应用 id 仍然全局唯一**（`POST /api/apps` 同 id 直接 409，改 / 删仅 owner）——本节**不改**这条。
- 「同一个应用被不同作者二次开发」= 各自上架成**各自 id** 的条目，条目上用 `forkOf` 指回源应用。
- 作者身份一律以 **uid（`users[].id`）为准**：`forkOf.ownerId`、账本里的 `ownerId` 都是它；
  `username` 只用于界面显示（用户看不懂 uid）。

### 8.2 条目字段 `forkOf`（可选；原创不出现这个字段）

```jsonc
{
  "id": "my-app-fork",
  "userId": "u_作者的uid",
  "forkOf": { "id": "src-app", "ownerId": "u_源作者uid" }   // 只存这两个字段
}
```

- **只认 `{ id, ownerId }`**：`id` 走 `normalizeAppId`，`ownerId` 非空字符串；两者任一不合法 →
  一律当「没有声明」（不报错、不落脏数据）。
- **不校验源条目是否还在**：作者删掉自己的应用不该让别人后续版本永远传不上去；源不可见时
  客户端显示「（已声明）<id>」那一项，归组照旧。
- **自指**（`forkOf.id === 自己的 id`）一律当没声明。
- 写入口（三处，语义一致）：`POST /api/apps`（新建）、`POST /api/apps/:id/versions`（追加版本）、
  `PATCH /api/apps/:id`（更新）。追加版本 / PATCH 只在**请求带了这个键**时才改它：
  `forkOf: null` 或空对象 = 清回原创，不带键 = 保持原样（追加一版不该悄悄抹掉上一版的来源）。
- 目录与接口输出：`appCatalogEntry()` 与 `publicApp()` 都带上
  `forkOf: { id, ownerId, owner }`（`owner` = 源作者 username，账号已被删就是空串）。静态目录
  `/mtnode/apps/catalog.json` 与 `/api/apps/catalog` 因此同形，客户端只有一条读路径。

### 8.3 客户端落盘口径

| 位置 | 字段 | 谁写 / 什么时候 |
| --- | --- | --- |
| `<应用目录>/app.json` | `author` | 新建应用、迁移到开发（**只在没写过时**写当前登录账号）、上架成功后写回 |
| `<应用目录>/app.json` | `dev: true` | 新建应用、从「库」迁移到开发；**安装 / 更新 / 换风格一律继承原值**，绝不覆盖 |
| `<应用目录>/app.json` | `forkOf: { id, ownerId, owner }` | 上架成功后按表单声明写回；导出 zip 时**随包带上**（换电脑 / 重新下载后仍知道来源） |
| `<应用目录>/installed.json`（安装账本） | `owner` / `ownerId` | 每次安装 / 更新按目录条目的 `owner` / `ownerId` 写 —— 「同作者」判定用它 |

- 导出 zip 时 **`dev` 被剔除**（本机状态，跟包跑出去会让下载者把应用当成「开发中」而不列进「库」），
  `author` 与 `forkOf` 照常随包。
- 覆盖安装 / 更新前先读本机 `app.json` 的 `dev` 与 `forkOf` 并在重写时继承（`apps-store.js` 的
  `keepMan`）—— 否则一次云端更新就会把应用从「开发」页踢回「库」页。

### 8.4 界面口径（客户端）

- **作者显示**：应用页卡片 + 详情、库页行、开发页顶栏都显示作者。取值顺序
  = 云端条目 `owner` → 本机 `app.json.author` → 当前登录账号（未登录 → 不显示作者行，不编造）。
- **校验值收纳**：`sha256` 不再整串摊在界面上 —— 应用详情、开发页导出结果、上架成功回执三处
  统一收进「ⓘ 校验」小按钮（默认只显示算法名 + 前 8 位，点开小窗看全文并可复制）；
  应用 id / 作者 uid / 入口页 / 需要版本 / 下载地址 / 窗口尺寸 / 本机目录这些技术字段一并收进
  详情里默认折叠的「开发者信息 ▾」。
- **「库」页只列非开发中的应用，「开发」页只列开发中的应用**（两边不重叠）：
  - 新建应用入口只留在开发页；
  - 库页顶部一行「从库迁移到开发」：写 `dev:true` + 建**同名画布** + 建开发节点（应用目录原地不动），
    迁完自动切到开发页并选中该应用；
  - **同 id 冲突一律拒绝**（本机已有同名画布即停手并说清），避免误覆盖；
  - 开发页补「卸载」（开发中的应用的唯一卸载入口）；绑定情况只在开发页显示（库页那枚徽标已去掉）。
- **卡片按钮随状态**：未装 = 下载；已装 = 启动（不再显示下载）；同作者有新版本 = 「更新到 vX」；
  存在其他作者分支 = 「切换分支 ▾」（列出同源条目：作者 · 版本 · 是否已装）。
  「同作者」判定：账本 `ownerId`（都记过才判）→ 账本 `owner` → `app.json.author` → 两边都没信息按同作者。
- **开发中的应用被更新要先确认**：写明会覆盖 `app.json` / 入口页 / `assets`（本机存储与该应用自己的
  画布不动）。
- **分支归组键 = 源应用 id**（`forkOf.id`；源条目自己用自己的 `id`）。服务端 id 全局唯一，所以用 id 就够：
  静态目录里源条目只有 `owner`（username）、接口目录才带 uid，若把作者拼进键反而会把同一源拆成两组。
  `forkOf.ownerId` 仍照契约保存与展示，只不作为归组键（「同作者」判定另走 8.4 那一条）。
- **分支各装各的**：分支条目有自己的 id，切换分支 = 装到**它自己的 id 目录**（已装就直接启动它）——
  本机可以同时存在多个分支，彼此独立、不覆盖任何数据。
- 上架窗新增「基于哪个应用二次开发（可选）」：默认带出本机已有声明（`app.json.forkOf`），
  否则带出「本机这份是从哪个云端条目装下来的」（安装账本），可改成目录里任意条目，也可选
  「（原创：不声明来源）」。上架成功后把 `author` 与 `forkOf` 写回本机 `app.json`。

### 8.5 本轮未做的（明确留白）

「上架前自检清单 / 关窗不丢草稿 / id 冲突前置提示 / 元信息规范化 / 应用页筛选排序」本轮**不做**；
上架链只新增了作者与 fork 声明两项。
# 应用市场（store-saas · /api/apps + /mtnode/apps/catalog.json）

MTNode 的「应用」= 用户自建 / 云端分发的本机小应用（一个文件夹一份，自带 `index.html` + `assets`，
客户端 `apps-store.js` 开独立窗口跑）。本文只讲**云端这一侧**：store-saas 的应用市场接口、
静态目录口径、上传脚本与部署。客户端安装 / 导出 / 冲突三态见 `apps-store.js` 与 `renderer/app-apps.js`。

## 一、数据落点（沿用 store-saas 既有口径）

| 内容 | 落点 |
| --- | --- |
| 应用记录（元数据 / 版本 / sha256 / 归属） | `DATA_DIR/db.json` 的 `apps[]`（与 `templates` / `skills` 同一份库、同一套 `saveDb`） |
| 应用包 | `DATA_DIR/apps/<id>.zip` |
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
| GET | `/api/apps/catalog` | 静态目录文档（与 `/mtnode/apps/catalog.json` 同一份字段，见第三节） |
| GET | `/api/apps/:id` | 详情（`item` = 统一字段 + `ownerUser` / `mine` / `canDelete` / `hasIcon`） |
| GET | `/api/apps/:id/file` | 下载包：默认回 JSON（`base64` + `sha256` + `bytes`）；`?format=raw` 直出 `application/zip`（带 `X-Content-SHA256`），同时计数 downloads |
| GET | `/api/apps/:id/icon` | 图标（无图标 404） |
| POST | `/api/apps` | 上传（**必须登录**）。体：`id`、`title`、`fileBase64`（或 `zipBase64`）、`version`、`description`（或 `desc`）、`entry`、`tags`、`icon`、`iconBase64` |
| PATCH | `/api/apps/:id` | 更新（仅 owner）：覆盖 zip / 图标 / 元数据；**未传 `version` 时服务端自动 +1**（`x.y.z → x.y.(z+1)`） |
| DELETE | `/api/apps/:id` | 删除（仅 owner；管理员可代删），同时删 zip 与图标 |

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

客户端（`apps-store.js`）读的是**静态目录**（`MTNODE_APPS_URL`，默认 `http://mt-agent.com/mtnode/apps`
+ `/catalog.json`），所以**手写静态清单与接口共用同一份条目字段**（服务端 `appCatalogEntry()` 是唯一实现）：

| 字段 | 说明 |
| --- | --- |
| `id` | 应用 id（安装目录名，小写） |
| `title` | 标题（客户端也认 `{zh,en}` 形式） |
| `version` | 版本号 |
| `desc` / `description` | 说明（同义两字段，写哪个都认） |
| `icon` | 图标地址；服务端存了图标文件时给相对本目录的 `icons/<id>.<ext>`，否则用上传时写的 `icon` 字符串（可为绝对 URL） |
| `zipUrl` / `url` | 应用包地址；**相对本目录**写 `<id>.zip`，客户端会解析成 `http://mt-agent.com/mtnode/apps/<id>.zip`（同源限制：zipUrl 只允许与目录同主机） |
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
   `python upload-app.py --catalog-out store-saas/apps/catalog.json` 会把它写成本地静态清单，
   并把本次的 zip / 图标按静态目录布局放好（`<id>.zip`、`icons/<id>.<ext>`）——
   再跑一次 `upload.py` 就把 `/mtnode/apps/` 发布成目录里写的样子。
2. **手写清单**：`store-saas/apps/catalog.json`（随 `upload.py` 一起发布）。手写条目时字段照上表写即可；
   与库里记录冲突时以库（`/api/apps/catalog`）为准。

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

`deploy.sh` 会：建 `data/apps`、`data/app-icons`、`/var/www/mtnode/apps/icons`；把 `apps/catalog.json`
装到 `/var/www/mtnode/apps/catalog.json`；把 `apps/*.zip` 与 `apps/icons/*` 装进 `/var/www/mtnode/apps/`；
跑 `patch-nginx.py` 补 `location ^~ /mtnode/apps/`（alias `/var/www/mtnode/apps/`）；最后自检
`/mtnode/apps/catalog.json`、`/mtnode/store-api/api/apps` 的 HTTP 码。

典型发布一条新应用的完整链路：

```bash
# ① 上传包（接口侧立即生效；--catalog-out 顺手写好静态清单与本地 zip / 图标）
python store-saas/upload-app.py --zip "我的应用.zip" --id my-app --title "我的应用" --update \
    --catalog-out store-saas/apps/catalog.json
# ② 发布静态目录（客户端唯一入口）
python store-saas/upload.py
```

接口不直接对客户端目录生效（客户端只读 `/mtnode/apps/catalog.json`）：更新应用必须走 ②，
或手工把 zip 与 catalog.json 放进 `/var/www/mtnode/apps/`。

## 六、自检

```bash
curl -sS http://127.0.0.1:8787/api/health                      # apps 计数
curl -sS http://127.0.0.1:8787/api/apps?pageSize=5             # 列表
curl -sSI http://127.0.0.1:8787/api/apps/<id>/file?format=raw   # 包（X-Content-SHA256）
curl -sS -H 'Host: mt-agent.com' http://127.0.0.1/mtnode/apps/catalog.json
```

已知边界：

- `owner` 过滤认 username 或 userId，两者都对不上就是空列表；未登录也看不到 `mine` / `canDelete`。
- 命令式列出 / 更新只按 **应用 id** 定位（id 全局唯一、小写）；一个账号可以有多条应用，互不影响。
- 静态清单是**独立文件**：手改 `/var/www/mtnode/apps/catalog.json` 只影响客户端看到的目录，
  不写回 `db.json`；反过来 `POST` / `PATCH` 只写库与 `DATA_DIR`，不会自动更新那份静态文件
  （要同步就 `--catalog-out` + `upload.py`）。
- 客户端安装 / 更新只替换本机账本里的载荷，用户数据（`storage/`、应用自己的画布）不动 ——
  云端这边不参与，也不该参与。
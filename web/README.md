# MTNode AI工作站 下载页 (web/)

单页下载站点，静态页面与下载文件托管于**阿里云 OSS**：

- Bucket：`mtnode-download`（地域 `oss-cn-beijing`）
- 默认首页：`index.html`
- 下载文件：`downloads/` 下的安装包与源码包

## 目录

- `index.html` — 单页站点（纯文字、无图像；开头为下载链接，footer 署名 ms2308；样式内联）
- `tutorial.html` — 使用教程（左侧章节树 + 右侧正文）
- `changelog.html` — 更新日志（由 `site-src/gen-changelog.mjs` 从仓库 `changelog/*.md` 生成，**不要手改**）
- `site-src/gen-changelog.mjs` — 更新日志页生成脚本（`node web/site-src/gen-changelog.mjs`）
- `site-src/publish.mjs` — OSS 上传 CLI（`upload <本地文件> <OSS key>`）
- `downloads/`
  - `MTNodeAIO-Setup-1.0.7.exe`（73.4 MB，当前版本安装包）
  - `MTNodeAIO-src-1.0.7.zip`（源码包，不含 node_modules）
  - `MTNodeAIO-Setup-1.0.3.exe` / `MTNodeAIO-src-1.0.4.zip`（历史版本，保留兼容旧链接）
- `assets/` — 旧版图像素材（新版页面已不使用，保留存档）

## 发布流程

1. 在 `pipeline-console/` 运行 `node version.js` 确认版本，`build.cmd` 构建产物（安装包在项目根目录）。
2. 复制 `MTNodeAIO-Setup-<ver>.exe` 到 `web/downloads/`；打包 `MTNodeAIO-src-<ver>.zip`（用 7z，文件清单见历史 zip）。
3. 更新 `web/index.html` 中的版本号、文件名与下载链接；有新版就在仓库 `changelog/` 补 `v<ver>.md`，然后重跑 `node web/site-src/gen-changelog.mjs` 刷新 `web/changelog.html`。
4. 上传至 OSS（`site-src/publish.mjs`，凭据读 `E:\dev\tools\oss-config.json`、SDK 读 `E:\dev\tools\oss\node_modules\ali-oss`）：

   ```bat
   node web/site-src/publish.mjs upload web/index.html index.html --allow-root-index
   node web/site-src/publish.mjs upload web/tutorial.html tutorial.html
   node web/site-src/publish.mjs upload web/changelog.html changelog.html
   node web/site-src/publish.mjs upload web/downloads/MTNodeAIO-Setup-<ver>.exe downloads/MTNodeAIO-Setup-<ver>.exe
   node web/site-src/publish.mjs upload web/downloads/MTNodeAIO-src-<ver>.zip downloads/MTNodeAIO-src-<ver>.zip
   ```

   本地路径以 `web/` 为准（历史文档里出现的 `E:\dev\tools\web` 已废弃，该目录不存在）。

## 公开访问

bucket ACL 当前为 `private`。需要把 bucket 改为**公共读**（控制台 Bucket 权限 → 读写权限 → 公共读），或给子账号 RAM 策略授权 `oss:PutBucketAcl` / `oss:PutBucketPolicy` 后执行：

- `putBucketACL(bucket, 'public-read')`
- 或添加 Bucket Policy：`{Version:'1', Statement:[{Effect:'Allow',Action:['oss:GetObject'],Principal:['*'],Resource:['acs:oss:*:*:mtnode-download/*']}]}`

启用后访问地址：
- 页面：`http://mtnode-download.oss-cn-beijing.aliyuncs.com/` 或 `http://mtnode-download.oss-cn-beijing.aliyuncs.com/index.html`
- 安装包：`http://mtnode-download.oss-cn-beijing.aliyuncs.com/downloads/MTNodeAIO-Setup-1.0.7.exe`
- 源码包：`http://mtnode-download.oss-cn-beijing.aliyuncs.com/downloads/MTNodeAIO-src-1.0.7.zip`

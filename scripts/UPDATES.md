# 内置版本更新（发布说明）

## 原理

- 客户端用 **electron-updater** 检查 `http://mt-agent.com/mtnode/updates/latest.yml`
- 安装包为 NSIS；配套 **`.blockmap`** 做差分下载——已安装旧版时只拉取变更块，包体远小于整包
- 用户看到顶栏「更新」→ 确认 → 下载 → **自动安装并重启**

## 发版步骤（build 与 release 分离）

> **一次发版必须同时出 NSIS 安装包与 Microsoft Store（MSIX）包，两包版本号必须一致。**
> 推荐用 `npm run release` 一条链跑完（`scripts/release.mjs`）：版本校验（根 `version` ↔ `package.json`）
> → `npm run dist` → 校验 `dist/latest.yml` 版本一致 → `make-msix.mjs --skip-build`（复用同一份
> `win-unpacked`）→ `stage-updates.mjs` → 把 `.msix` 另存进 `dist\msix-publish\` 并打印 Partner Center
> 上传指引 → **源码完整入库**（`scripts/release-git.mjs`）。任一步失败即非零退出，不会留下半截发布。
> 只出 Store 包用 `npm run release:store`（跳过 NSIS 打包与 stage-updates，但同样跑源码入库）。
> 发版前可先干跑 `node scripts/release.mjs --dry-run`：只做版本一致性校验并打印六步顺序，不构建 / 不打包 / 不上传 / 不提交；
> 只审源码是否漏传用 `node scripts/release-git.mjs --dry-run`（不改 git 状态）。
> **MSIX 只能人工拖进 Partner Center 上传框，不做自动上传**；Store 链细节见 `docs/msix-store-publish.md`。
> 下面的 `build*.cmd` / `release.cmd` 是旧的 OSS 手工程序，仍可用，但不含 Store 包，也不做源码入库。

### 源码入库（release-git.mjs）

发版收尾以前只靠人手 `git add -A && git commit`，而 `git add -A` 会**静默跳过被 .gitignore 命中的文件**；
`.gitignore` 又曾整目录忽略 `scripts/` `docs/` `test/` `build.json`，于是发版后仓库里缺文件
（`renderer/app-apps.js`、`preload-app.js`、`apps-store.js`、`scripts/*.mjs` 等 58 个源文件就是这样漏的），
而 `git status` 看不出问题（它们显示为 ignored，不是 untracked）。现在由 `scripts/release-git.mjs` 兜住：

1. 版本前置校验（根 `version` ↔ `package.json`）+ 构建产物（`dist/` 等）未被跟踪
2. **漏传审计**：① 随安装包发版（`build.json` 的 `files` 白名单）却不在 Git 里的源码 → **硬失败**；
   ② 各 `*-pack/`（`extraResources`）里随包却被忽略的源码 → **硬失败**；
   ③ 已入库却被 `.gitignore` 命中的路径 → 逐条报出
3. `git add -A`（含删除；忽略规则照旧生效）并打印「新增 / 修改 / 删除 + 分类」统计
4. 暂存区敏感复查：命中 `.env` / 证书私钥 / 日志 / 临时脚本 / Python 缓存 / 模型权重 / 运行时数据 → 硬失败
5. `commit` = `发布 vX.Y.Z（源码同步，web/更新通道由 OSS 发布）` + 轻量 `tag vX.Y.Z`
6. `push origin`（远端失败即非零退出，避免「本地提交了、远端没有」）
7. 收尾校验 `git status --porcelain` 必须干净

开关：`--no-push` 只本地提交；`--no-tag` 不打 tag；`--dry-run` 只审计与统计。
整链跳过用 `npm run release -- --no-git`（不推荐，等于回到「发版不管源码」的老样子）。
**升版仍用 `node version.js bump`，版本号真源仍是根 `version` 文件。**

1. **构建**
   - `E:\dev\tools\compile.cmd` — 只编译 `dist/win-unpacked`，**不**打 NSIS 安装包（本地试跑）
   - `E:\dev\tools\build.cmd` — 用当前 `version` 构建安装包，**不改**版本号  
   - `E:\dev\tools\build_vup.cmd` — **小版本号 +1**（如 1.1.12→1.1.13）再构建  
   后两者：electron-builder → 本地 `dist/`（含 `latest.yml` + `.blockmap`）  
   **不**上传、**不**推 git。

2. **发布**（`E:\dev\tools\release.cmd`）  
   - **不**再次编译，**不**自动增加版本号（仅 `build_vup` 会 +1）  
   - 读取本地 `dist/latest.yml` 版本，与线上 `updates/latest.yml` 比对  
   - **版本一致 → 提示并跳过**整次发布  
   - 否则：上传落地页 / downloads / updates → 尝试 git（失败则跳过）

也可手动：`npm run dist` + `npm run release:stage` 后自行上传 OSS `updates/`；
想一条命令同时出 NSIS 与 Store 包（推荐），用 `npm run release`。

验证:

```bash
curl -I http://mt-agent.com/mtnode/updates/latest.yml
curl -I -H "Range: bytes=0-100" http://mt-agent.com/mtnode/updates/MTNodeAIO-Setup-x.y.z.exe
```

Range 应返回 `206 Partial Content`。

## 客户端行为

| 场景 | 行为 |
|------|------|
| 开发态 `npm start` | 不检查更新 |
| 已安装 NSIS 版 | 启动约 8s 后静默检查；有更新则显示高光「更新」|
| 点击「更新」 | 确认框 → 差分下载 → 静默 quitAndInstall(`/S`)，装完自动重启 |

可用环境变量:

- `MTNODE_UPDATE_URL` — 覆盖更新源（默认 `http://mt-agent.com/mtnode/updates`）
- `MTNODE_FORCE_UPDATE=1` — 强制在非标准路径下也启用更新器（自测）

## 目录约定

```
/var/www/html/mtnode/updates/
  latest.yml
  MTNodeAIO-Setup-1.1.13.exe
  MTNodeAIO-Setup-1.1.13.exe.blockmap
```

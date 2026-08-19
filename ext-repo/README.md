# MTNode 扩展目录（插件 / 技能 / MCP）

自建源，发布后地址：

`http://mt-agent.com/mtnode/ext/catalog.json`

在 MTNode「设置 · 智能能力 → 🌐 在线浏览 → ＋ 添加源」里填该 URL（类型选「MTNode 目录」或插件/技能/MCP 任一）。应用内也会预置 **MTNode 官方** 标签。

## 目录

```
ext-repo/
  catalog.json          由 build 生成，客户端只读这份
  skills/<id>/SKILL.md  技能（可另从仓库根 skills/ 自动收录）
  plugins/              DSH 插件：plugin.json + 可选 .tgz
  mcp/<id>.json         MCP 服务器描述（stdio / HTTP）
```

## 添加内容

- **技能**：新建 `skills/my-skill/SKILL.md`（kebab-case 目录名，含 YAML frontmatter）。
- **插件**：在 `plugins/<id>/` 放 `plugin.json`，`install` 可以是 npm 包名、GitHub 地址，或相对路径 `.tgz`。
- **MCP**：在 `mcp/` 放 JSON，字段见 `mcp/memory.json`。

## 同步到云服务器

在仓库根目录：

```bat
npm run ext:sync
```

或双击 / 运行 `ext-repo\sync.cmd`。

只生成、不上传：

```bat
npm run ext:build
```

上传使用本机 SFTP 配置（不入库）：

1. 环境变量 `MTNODE_SFTP_JSON` 指向含 `host` / `username` / `password`（或 `privateKey`）的 JSON；或
2. 默认读取 `E:\dev\mt-ai-router\.vscode\sftp.json`；或
3. `MTNODE_SSH_HOST` + `MTNODE_SSH_USER` + `MTNODE_SSH_PASSWORD`（可选 `MTNODE_SSH_PORT`）。

远程落盘：`/var/www/mtnode/ext/`，nginx 路径 `/mtnode/ext/`。

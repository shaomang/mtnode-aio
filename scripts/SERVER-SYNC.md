# 云端 → 本地镜像同步（scripts/server-sync.py）

把 `mt-agent.com`（118.190.216.22）上的内容**单向拉回**本地镜像，只传差异，删除不直接删。

- 方向：**服务器 → 本地**。脚本对服务器只有 `listdir` / `get` / 只读 `exec`（登记证书有效期），**永不回写**。
- 落点：`Z:\Dev\mtnode-aio`（可用 `--root` 改）。
- 脚本：`scripts/server-sync.py`（Python + paramiko，只读服务器）。
- 配套：仓库里 9 个上传 / 诊断脚本的默认凭据路径已统一指向 `E:\dev\tools\ssh\sftp-mtnode-store.json`。

> ⚠️ 镜像里含 `/etc/mtnode-store.env` 等**原样拉取的生产密钥**（按明确要求不做脱敏）。
> `Z:\Dev\mtnode-aio` 本身即敏感目录：不要放进任何 git 仓库、云盘同步目录或截图范围。

## 一、命令行

```bat
python scripts/server-sync.py --list                 :: 列出目标名
python scripts/server-sync.py --dry-run              :: 预览：只说会做什么，不落任何本地文件
python scripts/server-sync.py                        :: 全量增量同步（默认）
python scripts/server-sync.py --only store,www       :: 只同步其中几项
python scripts/server-sync.py --root D:\mirror       :: 换镜像根目录
python scripts/server-sync.py --quiet                :: 控制台只打摘要，逐文件明细只进日志
```

| 开关 | 作用 | 默认 |
| --- | --- | --- |
| `--only <名,…>` | 只同步指定目标（`store` / `www` / `nginx` / `units` / `ssl`，别名见 `--list`；`all` = 全部） | 全部 |
| `--dry-run` | 预览，**不写镜像、不写索引、不清理回收站** | 关 |
| `--compare-repo` / `--no-compare-repo` | 仓库 `store-saas/` 与线上逐文件比哈希（只报不写） | 开 |
| `--repo-prefix` | 仓库比对时镜像里的子路径前缀（`auto` 自动判断，`.` = 直接用相对路径） | `auto` |
| `--ignore-repo <片段>` | 仓库比对忽略的路径片段，可重复（如 `--ignore-repo .bak-`） | 无 |
| `--no-sha-repo` | 仓库比对只比大小、不算哈希（更快） | 算哈希 |
| `--trash-days N` | 回收站保留天数（`0` = 永不清理） | 30 |
| `--retries N` | 单文件下载重试次数 | 3 |
| `--hash-max N` | 参与哈希计算的单文件上限（字节） | 8MB |

## 二、同步目标

| 名 | 服务器路径 | 镜像位置 | 说明 |
| --- | --- | --- | --- |
| `store` | `/opt/mtnode-store` | `store/` | 服务端代码 + `data/`（`db.json`、`apps`、`skills`、`files`、`forum-images`、`app-icons`、`previews`）+ `rollback/`、`backup-*`、`*.bak-*` 历史备份 |
| `www` | `/var/www/mtnode` | `www/` | 静态站与分发包：`admin` `apps` `assets` `downloads` `ext` `h3` `music3` `pay-done` `plugins` + `index.html` / `README.md` |
| `nginx` | `/etc/nginx/sites-available` | `nginx/sites-available/` | 站点配置（含 `.bak-*`），另有 `nginx/ssl-inventory.txt` |
| `units` | `/etc/systemd/system` | `systemd/` | 白名单 unit：`mtnode-store` / `mt-ai-router` / `mt-teach` / `mt-ai-router-mongod` |
| `ssl` | `/etc/nginx/ssl` | `nginx/ssl-inventory.txt` | **只登记**：文件名 / 大小 / mtime / `openssl x509` 的 subject 与 notAfter；**不下载私钥内容** |

目标表在脚本顶部的 `TARGETS` / `SSL_TARGET` 常量里，加一行即可扩目标（`code` = `--only` 用的短名）。

## 三、行为口径

1. **只拉差异**：逐级列举远端目录树，与本地索引（`_sync/index.json`）比 `size` + `mtime`（容差 1 秒）；
   本地文件缺失也算差异。删掉索引 = 下次全量重扫一遍。远端目录树每次都列（保证「服务器上删了」能被发现）。
2. **删除安全**：服务器上已不存在（或已改名）而镜像里还留着的文件，**移进 `.sync-trash/<时间戳>-<目标>/`**，
   原相对路径保留，可直接手工拷回；空目录顺带回收，超过 `--trash-days` 的旧回收站自动清理。
3. **时间戳**：本地文件的 mtime 写成服务器上原来的 mtime（`os.utime`，失败只记日志不中断）。
4. **写入原子性**：先下到 `<文件名>.part` 再 `os.replace` 落位，中途断了不会留下半截文件。
5. **仓库比对（只报不写）**：`/opt/mtnode-store` ↔ 仓库 `store-saas/`，跳过 `data/`、`rollback/`、`admin/`；
   三类差异分别报：`大小不同` / `同大小但内容不同`（sha1 比对）/ `仓库缺少`。**仓库文件一律不动**。
6. **留痕**：
   - `_sync/manifest.json`：本次时间、源主机、各目标条目与字节数、逐条 `items`、`repoDiffs`、失败项；
   - `_sync/sync.log`：追加日志（每次运行一段，含逐文件明细）；
   - 退出码：`0` 正常 / `1` 有目标失败 / `2` 未选中任何目标。

## 四、凭据

优先级与既有上传脚本**同源**，只是默认文件换成了新位置：

1. 环境变量 `MTNODE_SFTP_JSON` 指向的 json；
2. 默认 `E:\dev\tools\ssh\sftp-mtnode-store.json`（字段：`host` / `port` / `username` / `privateKey` / `remotePath` / `name`）；
   `privateKey` 写绝对路径，或相对该 json 所在目录的文件名（脚本会自己补全）；
3. 再退 `MTNODE_SSH_HOST` + `MTNODE_SSH_USER` + `MTNODE_SSH_PASSWORD`（或 `MTNODE_SSH_KEY`）。

旧机器路径 `E:\dev\mt-ai-router\.vscode\sftp.json` 在本机已不存在，**不再作为兼容候选**，
以下文件已硬替换（共 9 处）：

`scripts/deploy-ssl.py`、`scripts/patch-wechat-redirect.py`、`scripts/upload-h3.py`、
`scripts/upload-music3.py`、`scripts/upload-plugins.py`、`scripts/upload-privacy.py`、
`store-saas/upload.py`、`ext-repo/upload.py`、`store-saas/_diag_unionid_readonly.py`。

Node 侧（`ext-repo/build.mjs`）用 `MTNODE_SFTP_JSON` + `MTNODE_SSH_KEY_FILE`：
`$env:MTNODE_SSH_KEY_FILE = "E:\dev\tools\ssh\id_ed25519_mtnode"`。

## 五、镜像布局与取回

```
Z:\Dev\mtnode-aio\
  store\                  ← /opt/mtnode-store
  www\                    ← /var/www/mtnode
  nginx\
    sites-available\      ← /etc/nginx/sites-available
    ssl-inventory.txt     ← /etc/nginx/ssl 的登记（不含私钥内容）
  systemd\                ← 白名单 unit
  _sync\                  ← index.json（增量索引）/ manifest.json（本次清单）/ sync.log
  .sync-trash\<时间戳>-<目标>\   ← 服务器上已删除、从镜像里挪走的文件
```

取回被挪走的文件：把 `.sync-trash/<时间戳>-<目标>/` 里的文件按原相对路径拷回镜像对应目录，
再跑一次 `python scripts/server-sync.py`（它会把索引补回一致状态）。

## 六、当前同步状态（2026-10-05 首同步实测）

| 目标 | 镜像位置 | 文件数 | 体积 |
| --- | --- | --- | --- |
| store | `store/` | 78 | 10.3MB |
| www | `www/` | 46 | 76.8MB |
| nginx | `nginx/sites-available/` | 13 | 94.9KB |
| units | `systemd/` | 4 | 4.6KB |
| 合计 | — | **141** | **87.2MB** |

- 第二次运行结果：`新增 0 · 更新 0 · 未变 141 · 进回收站 0 · 传输 0B`（增量判定与幂等已达预期）。
- `/etc/nginx/ssl` 登记：`www.mt-agent.com/fullchain.pem`（subject `CN = www.mt-agent.com`，
  notAfter `Dec 7 23:59:59 2026 GMT`）与 `www.mt-agent.com/privkey.pem`（只登记大小与 mtime）。
- **仓库比对差异 9 条**（`/opt/mtnode-store` 比仓库 `store-saas/` 新，仓库文件未被改动）：
  - 大小不同（线上更大）：`server.mjs`、`relay.mjs`、`tips.mjs`、`comments.mjs`、`deploy.sh`
  - 仓库缺少（只存在于服务器）：`server.mjs.bak-20260909-132911`、`backup-recharge-20261003-201549/{server.mjs,wallet.mjs,mtnode-store.service}`

## 七、已知边界

- 服务器日志（nginx access/error、journalctl）**不在**同步范围（体积无上限）；要用时临时拉。
- 不做双向、不做回推：要上线仍走既有上传链（`python store-saas/upload.py` 等）。
- 没有 `--resume` 断点续传：大目录中断后重跑即可（已下完的文件按 size+mtime 判为未变，不会重下）。
- 镜像里的 `store/data/` 是生产数据的**只读副本**，不要在它上面跑本地服务，也不要回传。

# 只读诊断报告：微信 unionid 归属与线上版本

- 执行时间：本轮（2026-09 之后，服务器时区 +0800）
- 通道：`store-saas/upload.py` 同款 paramiko（凭据 `E:\dev\mt-ai-router\.vscode\sftp.json`，root@118.190.216.22:22）
- 脚本：`store-saas/_diag_unionid_readonly.py`（只读：md5sum / stat / ls / cat / `node -e` 只读扫描；无 put / rm / 重启 / 部署）

## ① 线上版本指纹

| 项 | 值 |
|---|---|
| `/opt/mtnode-store/server.mjs` md5 | `7db9ac65955ebfdb6fb7e82698e5b4d8` |
| size | 89776 |
| mtime | 2026-09-09 15:51:12 +0800 |

结论：与预期一致，线上仍是旧版 `7db9ac65…`（另有 `server.mjs.bak-20260909-132911` 备份，54209 字节）。

## ② 运行时账户存储后端

systemd unit `/etc/systemd/system/mtnode-store.service`：`WorkingDirectory=/opt/mtnode-store`、`ExecStart=/usr/bin/node /opt/mtnode-store/server.mjs`、`EnvironmentFile=-/etc/mtnode-store.env`。

`/etc/mtnode-store.env`（脱敏）关键项：

```
MTNODE_ACCOUNT_STORE=aliyun-tablestore
MTNODE_OTS_ENDPOINT=https://mtnode.ap-southeast-1.ots.aliyuncs.com
MTNODE_OTS_INSTANCE=mtnode
MTNODE_OTS_TABLE_PREFIX=mtnode_
（MTNODE_OTS_ACCESS_KEY_ID / _SECRET 已脱敏）
```

因此**真实生效的账户后端是 Tablestore**（表 `mtnode_users` / `mtnode_sessions` / `mtnode_identities`）；`/opt/mtnode-store/data/db.json` 只承载 templates / skills / likes / forum 等非账户数据。注意：不带 env 直接跑脚本会误判为 json 后端（第一次即如此），必须以环境文件为准。

## ③ 微信 unionid 归属

Tablestore 全量只读扫描结果：users=12、identities=13、wechat_unionid 身份仅 1 条。

| 项 | 值 |
|---|---|
| unionid | `oMsFr5rKaYWzvUTaaooyUU_sfS1A` |
| owner id | `u_842d979ba0e3b630` |
| nickname | `Mang Shao` |
| username | `u_785bb258`（account-store 自动占位名，非用户设定） |
| 有 phone | 否 |
| 有 pass（pass+salt） | 否 |
| user.wechatUnionId | `oMsFr5rKaYWzvUTaaooyUU_sfS1A` |
| 名下 identities | `username:u_785bb258`（占位）+ `wechat_unionid:oMsFr5rKaYWzvUTaaooyUU_sfS1A` |
| 真实身份（剔除占位 username） | 仅 `wechat_unionid:oMsFr5rKaYWzvUTaaooyUU_sfS1A` |
| 名下 templates | **0** |
| 名下 skills | **0** |

owner 是本次迁移后新出现的第 12 个账号（createdAt 1788957862476，最新），未出现在旧 json 库的 identities 快照里。

### 结论（供任务 2 的合并判据使用）

1. **owner 确为「纯微信临时账号」**：无 phone、无 pass、真实身份仅该 unionid（`username:u_785bb258` 是 account-store 的 `newPlaceholderUsername` 自动占位名，不代表可登录身份）。→ 走**直接合并**分支，不需要冲突提示。
2. **没有模板/技能需要迁移**：该 owner 名下 templates=0、skills=0。线上 4 个模板与 5 个技能全部属于 `u_b33738db79310ff5`（`ms2308`，管理员账号），与本次 unionid 无关。
3. 合并后只需处理 `mtnode_identities` 中 `wechat_unionid:oMsFr5rKaYWzvUTaaooyUU_sfS1A` 的 owner 指向与占位账号清理；**不涉及任何 template/skill 数据搬迁**。

## 只读声明

本次全程未写入、未删除、未部署：仅执行 `md5sum`/`stat`/`ls`/`cat`/`systemctl cat` 与一段 `node --input-type=module -e` 只读脚本（`createAccountStore().listUsers()/listIdentities()` 走 Tablestore scan，`ready()` 为空实现；`db.json` 只读解析）。未上传任何文件、未重启服务。

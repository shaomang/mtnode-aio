"""生产只读诊断：/opt/mtnode-store 版本指纹 + 微信 unionid 归属（不写、不删、不部署）。

只读口径：
- 远端只执行 md5sum / stat / ls / cat（systemd unit、/etc/mtnode-store.env 脱敏打印）
  与 `node --input-type=module -e <只读脚本>`；不 put / rm / 重启 / 部署。
- node 脚本只调用 account-store.mjs 的 listUsers() / listIdentities()（Tablestore scan 只读）
  并读 DATA_DIR/db.json 统计模板归属。

用法: python store-saas/_diag_unionid_readonly.py
"""
from __future__ import annotations

import json
import shlex
from pathlib import Path

import paramiko

SFTP_JSON = Path(r"E:\dev\mt-ai-router\.vscode\sftp.json")

NODE_SCRIPT = r"""
import fs from "node:fs";
import { createAccountStore } from "./account-store.mjs";
const out = {};
const store = createAccountStore({});
out.backend = store.backend;
out.describe = typeof store.describe === "function" ? store.describe() : null;
await store.ready();
const users = await store.listUsers();
const identities = await store.listIdentities();
const dataDir = process.env.DATA_DIR || "/opt/mtnode-store/data";
out.dataDir = dataDir;
let db = { templates: [], skills: [] };
try { db = JSON.parse(fs.readFileSync(dataDir + "/db.json", "utf8")); } catch (e) { out.dbError = String(e && e.message); }
out.userCount = users.length;
out.identityCount = identities.length;
out.templateCount = Array.isArray(db.templates) ? db.templates.length : -1;
out.skillCount = Array.isArray(db.skills) ? db.skills.length : -1;
out.users = users.map((u) => ({
  id: u.id, username: u.username, nickname: u.nickname,
  hasPhone: !!u.phone, phone: u.phone || "",
  hasPass: !!(u.pass && u.salt),
  wechatUnionId: u.wechatUnionId || "",
  createdAt: u.createdAt,
}));
out.identities = identities.map((i) => ({ kind: i.kind, value: i.value, userId: i.userId }));
out.allTemplates = (db.templates || []).map((t) => ({ id: t.id, title: t.title, userId: t.userId, createdAt: t.createdAt, downloads: t.downloads }));
out.allSkills = (db.skills || []).map((s) => ({ id: s.id, title: s.title, userId: s.userId, createdAt: s.createdAt }));
const wx = identities.filter((i) => i.kind === "wechat_unionid");
out.wechatOwners = wx.map((i) => {
  const owner = users.find((u) => u.id === i.userId) || null;
  const ownIds = identities.filter((x) => x.userId === i.userId).map((x) => x.kind + ":" + x.value);
  const mine = (db.templates || []).filter((t) => t.userId === i.userId);
  const mySkills = (db.skills || []).filter((s) => s.userId === i.userId);
  // 自动占位用户名形如 u_ + 8 位 hex（account-store newPlaceholderUsername），不算可登录身份。
  const realIds = ownIds.filter((x) => !/^username:u_[0-9a-f]{8}$/.test(x));
  return {
    unionid: i.value,
    ownerId: i.userId,
    ownerExists: !!owner,
    nickname: owner ? owner.nickname : null,
    username: owner ? owner.username : null,
    hasPhone: !!(owner && owner.phone),
    hasPass: !!(owner && owner.pass && owner.salt),
    ownerWechatUnionId: owner ? (owner.wechatUnionId || "") : null,
    ownerIdentities: ownIds,
    realIdentities: realIds,
    templateCount: mine.length,
    skillCount: mySkills.length,
    templates: mine.map((t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, downloads: t.downloads })),
    pureWechatTemp: !!(owner && !owner.phone && !(owner.pass && owner.salt)
      && realIds.length === 1 && realIds[0] === "wechat_unionid:" + i.value),
  };
});
console.log(JSON.stringify(out, null, 2));
"""


def connect() -> paramiko.SSHClient:
    cfg = json.loads(SFTP_JSON.read_text(encoding="utf-8"))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=cfg["host"], port=int(cfg.get("port") or 22),
              username=cfg.get("username") or "root",
              password=cfg.get("password") or "", timeout=25)
    return c


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 180):
    _i, o, e = c.exec_command(cmd, timeout=timeout)
    return o.channel.recv_exit_status(), o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")


def mask_env(text: str) -> str:
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            out.append(line)
            continue
        k, v = s.split("=", 1)
        if any(x in k.upper() for x in ("SECRET", "PASS", "KEY", "TOKEN")):
            v = (v[:4] + "***") if v else ""
        out.append(k + "=" + v)
    return "\n".join(out)


def main() -> None:
    c = connect()
    try:
        print("=== ① server.mjs 版本指纹 ===")
        _c, out, err = run(c, "md5sum /opt/mtnode-store/server.mjs; "
                             "stat -c 'size=%s mtime=%y' /opt/mtnode-store/server.mjs; "
                             "ls -la /opt/mtnode-store/")
        print(out.rstrip())
        if err.strip():
            print("stderr:", err.rstrip())

        print("\n=== ② systemd unit ===")
        _c, out, err = run(c, "systemctl cat mtnode-store.service 2>/dev/null "
                             "|| cat /opt/mtnode-store/mtnode-store.service 2>/dev/null "
                             "|| echo NO_UNIT_FOUND")
        print(out.rstrip())

        print("\n=== ②b /etc/mtnode-store.env（脱敏） ===")
        _c, out, err = run(c, "ls -la /etc/mtnode-store.env; echo '---'; cat /etc/mtnode-store.env")
        print(mask_env(out).rstrip())
        env_pairs = [s.strip() for s in out.splitlines()
                     if s.strip() and not s.strip().startswith("#") and "=" in s]
        prefix = " ".join(shlex.quote(k) + "=" + shlex.quote(v)
                          for k, v in (p.split("=", 1) for p in env_pairs))

        print("\n=== ③ 只读 node 诊断（account-store + db.json） ===")
        cmd = ("cd /opt/mtnode-store && " + (prefix + " " if prefix else "")
               + "node --input-type=module -e " + shlex.quote(NODE_SCRIPT))
        code, out, err = run(c, cmd)
        print(out.rstrip())
        if err.strip():
            print("stderr:", err.rstrip())
        print("[node exit]", code)
    finally:
        c.close()


if __name__ == "__main__":
    main()

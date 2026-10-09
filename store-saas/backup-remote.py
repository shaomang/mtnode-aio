"""线上回滚点备份（只读远端 + 新增备份文件，不改动任何在跑的配置）。

用同一条 SFTP 凭据（E:\\dev\\tools\\ssh\\sftp-mtnode-store.json，私钥认证）连上线上主机：
  ① 把 /opt/mtnode-store/server.mjs 与 deploy.sh 各复制一份 server.mjs.bak-<时间戳> / deploy.sh.bak-<时间戳>；
  ② 打印当前 /opt/mtnode-store 下的版本文件清单与 server.mjs 的 sha256（与本地对比，确认线上跑的就是这一版）；
  ③ 不改动 .service、不重启服务、不动 /etc/mtnode-store.env。

用法：python store-saas/backup-remote.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

try:
    import paramiko
except Exception as exc:  # pragma: no cover
    print("需要 paramiko：pip install paramiko（当前：" + str(exc) + "）")
    sys.exit(2)

DEFAULT_SFTP = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")
REMOTE_DIR = "/opt/mtnode-store"
FILES = ("server.mjs", "deploy.sh")


def load_cfg() -> dict:
    p = Path(os.environ.get("MTNODE_SFTP_JSON", "") or DEFAULT_SFTP)
    if not p.is_file():
        print("找不到 SFTP 凭据：" + str(p))
        sys.exit(2)
    return json.loads(p.read_text(encoding="utf-8"))


def main() -> int:
    cfg = load_cfg()
    host = cfg.get("host")
    port = int(cfg.get("port") or 22)
    user = cfg.get("username") or "root"
    key_path = cfg.get("privateKey")
    if not key_path or not Path(key_path).is_file():
        print("凭据里没有可用的私钥：" + str(key_path))
        return 2

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    key = paramiko.Ed25519Key.from_private_key_file(key_path)
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(hostname=host, port=port, username=user, pkey=key, timeout=25)
    try:
        def run(cmd: str) -> str:
            _in, out, err = cli.exec_command(cmd, timeout=60)
            text = out.read().decode("utf-8", "replace")
            etext = err.read().decode("utf-8", "replace")
            return (text + etext).strip()

        print("connect " + user + "@" + host)
        for name in FILES:
            src = REMOTE_DIR + "/" + name
            dst = src + ".bak-" + stamp
            print(run("cp -p '{0}' '{1}' && ls -l '{1}'".format(src, dst)))
        print("远端 sha256：")
        print(run("sha256sum " + REMOTE_DIR + "/server.mjs " + REMOTE_DIR + "/deploy.sh"))
        print("备份文件清单：")
        print(run("ls -1t " + REMOTE_DIR + " | head -20"))
    finally:
        cli.close()

    local = Path(__file__).resolve().parent / "server.mjs"
    digest = hashlib.sha256(local.read_bytes()).hexdigest()
    print("本地 server.mjs sha256：" + digest)
    print("回滚命令： cp -p " + REMOTE_DIR + "/server.mjs.bak-" + stamp + " " + REMOTE_DIR + "/server.mjs && systemctl restart mtnode-store")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

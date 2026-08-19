"""Upload dist/ext-publish to mt-agent.com /var/www/mtnode/ext/."""
from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

try:
    import paramiko
except ImportError:
    sys.exit("需要 paramiko：pip install paramiko")

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / "dist" / "ext-publish"
REMOTE_TMP = "/tmp/mtnode-ext-upload"
DEFAULT_SFTP = Path(r"E:\dev\mt-ai-router\.vscode\sftp.json")


def load_cfg() -> dict:
    env_path = os.environ.get("MTNODE_SFTP_JSON", "").strip()
    candidates = []
    if env_path:
        candidates.append(Path(env_path))
    candidates.append(DEFAULT_SFTP)
    for p in candidates:
        if p.is_file():
            cfg = json.loads(p.read_text(encoding="utf-8"))
            return {
                "host": cfg.get("host"),
                "port": int(cfg.get("port") or 22),
                "username": cfg.get("username") or "root",
                "password": cfg.get("password") or "",
                "privateKey": cfg.get("privateKey") or cfg.get("identityFile") or "",
            }
    host = os.environ.get("MTNODE_SSH_HOST", "").strip()
    if not host:
        sys.exit(
            "未找到 SFTP 配置。设置 MTNODE_SFTP_JSON，或 MTNODE_SSH_HOST + "
            "MTNODE_SSH_USER + MTNODE_SSH_PASSWORD"
        )
    return {
        "host": host,
        "port": int(os.environ.get("MTNODE_SSH_PORT") or 22),
        "username": os.environ.get("MTNODE_SSH_USER") or "root",
        "password": os.environ.get("MTNODE_SSH_PASSWORD") or "",
        "privateKey": os.environ.get("MTNODE_SSH_KEY") or "",
    }


def mkdir_p(sftp: paramiko.SFTPClient, remote: str) -> None:
    parts = remote.strip("/").split("/")
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def rm_tree(sftp: paramiko.SFTPClient, remote: str) -> None:
    try:
        st = sftp.stat(remote)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(st.st_mode):
        for name in sftp.listdir(remote):
            rm_tree(sftp, remote.rstrip("/") + "/" + name)
        sftp.rmdir(remote)
    else:
        sftp.remove(remote)


def put_dir(sftp: paramiko.SFTPClient, local: Path, remote: str) -> int:
    n = 0
    mkdir_p(sftp, remote)
    for path in local.rglob("*"):
        rel = path.relative_to(local).as_posix()
        dest = remote.rstrip("/") + "/" + rel
        if path.is_dir():
            mkdir_p(sftp, dest)
            continue
        mkdir_p(sftp, dest.rsplit("/", 1)[0])
        sftp.put(str(path), dest)
        n += 1
    return n


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 60) -> None:
    print("remote:", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print(err.rstrip())
    if code != 0:
        raise SystemExit(f"remote exit {code}: {cmd}")


def main() -> None:
    if not LOCAL.is_dir():
        sys.exit("先运行 node ext-repo/build.mjs（缺少 dist/ext-publish）")
    cfg = load_cfg()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect = {
        "hostname": cfg["host"],
        "port": cfg["port"],
        "username": cfg["username"],
        "timeout": 20,
    }
    if cfg.get("privateKey"):
        connect["key_filename"] = cfg["privateKey"]
    elif cfg.get("password"):
        connect["password"] = cfg["password"]
    else:
        sys.exit("SFTP 配置缺少 password 或 privateKey")
    print("connect", cfg["username"] + "@" + cfg["host"])
    c.connect(**connect)
    sftp = c.open_sftp()
    try:
        rm_tree(sftp, REMOTE_TMP)
        n = put_dir(sftp, LOCAL, REMOTE_TMP)
        sftp.put(str(ROOT / "ext-repo" / "patch-nginx.py"), REMOTE_TMP + "/patch-nginx.py")
        sftp.put(str(ROOT / "ext-repo" / "deploy.sh"), REMOTE_TMP + "/deploy.sh")
        print("uploaded", n, "files to", REMOTE_TMP)
    finally:
        sftp.close()
    run(c, "chmod +x /tmp/mtnode-ext-upload/deploy.sh && bash /tmp/mtnode-ext-upload/deploy.sh")
    c.close()
    print("ok http://mt-agent.com/mtnode/ext/catalog.json")


if __name__ == "__main__":
    main()

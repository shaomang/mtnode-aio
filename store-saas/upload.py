"""Upload store-saas to mt-agent.com /opt/mtnode-store/ (same SFTP as ext-repo)."""
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

ROOT = Path(__file__).resolve().parent
REMOTE_TMP = "/tmp/mtnode-store-upload"
DEFAULT_SFTP = Path(r"E:\dev\mt-ai-router\.vscode\sftp.json")
UPLOAD_FILES = (
    "server.mjs",
    "package.json",
    "mtnode-store.service",
    "deploy.sh",
    "patch-nginx.py",
    "seed-skills.mjs",
)
SKILLS_LOCAL = ROOT.parent / "ext-repo" / "skills"
REMOTE_SKILLS = "/tmp/mtnode-store-skills"


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


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 90) -> None:
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


def main() -> None:
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
        mkdir_p(sftp, REMOTE_TMP)
        for name in UPLOAD_FILES:
            src = ROOT / name
            if not src.is_file():
                print("skip missing", name)
                continue
            sftp.put(str(src), REMOTE_TMP + "/" + name)
            print("put", name)
        if SKILLS_LOCAL.is_dir():
            rm_tree(sftp, REMOTE_SKILLS)
            n = put_dir(sftp, SKILLS_LOCAL, REMOTE_SKILLS)
            print("uploaded skills", n, "files to", REMOTE_SKILLS)
    finally:
        sftp.close()
    run(c, "chmod +x /tmp/mtnode-store-upload/deploy.sh && bash /tmp/mtnode-store-upload/deploy.sh")
    c.close()
    print("ok http://mt-agent.com/mtnode/store-api/api/health")
    print("seed hint:")
    print(
        "  MTNODE_STORE_URL=http://127.0.0.1:8787 "
        "MTNODE_SKILLS_DIR=/tmp/mtnode-store-skills "
        "MTNODE_STORE_PASS_FILE=/opt/mtnode-store/.store-pass "
        "node /opt/mtnode-store/seed-skills.mjs"
    )


if __name__ == "__main__":
    main()

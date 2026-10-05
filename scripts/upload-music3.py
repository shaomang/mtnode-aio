"""Upload dist/music3-publish to mt-agent.com /var/www/mtnode/music3/."""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import paramiko
except ImportError:
    sys.exit("需要 paramiko：pip install paramiko")

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / "dist" / "music3-publish"
REMOTE = "/var/www/mtnode/music3"
DEFAULT_SFTP = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")


def load_cfg() -> dict:
    cfg = json.loads(DEFAULT_SFTP.read_text(encoding="utf-8"))
    return {
        "host": cfg.get("host"),
        "port": int(cfg.get("port") or 22),
        "username": cfg.get("username") or "root",
        "password": cfg.get("password") or "",
        "privateKey": cfg.get("privateKey") or cfg.get("identityFile") or "",
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


def main() -> None:
    if not LOCAL.is_dir():
        sys.exit("缺少 dist/music3-publish")
    files = [
        p
        for p in LOCAL.iterdir()
        if p.is_file() and p.name != "README.txt" and not p.name.startswith("_")
    ]
    if not files:
        sys.exit("无可上传文件")
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
        mkdir_p(sftp, REMOTE)
        for path in sorted(files, key=lambda p: (p.suffix != ".json", p.name)):
            dest = REMOTE.rstrip("/") + "/" + path.name
            print("put", path.name, "→", dest)
            sftp.put(str(path), dest)
        print("uploaded", len(files), "files to", REMOTE)
    finally:
        sftp.close()
    _i, o, e = c.exec_command(
        "chmod -R a+rX /var/www/mtnode/music3 && "
        "curl -sS http://127.0.0.1/mtnode/music3/manifest.json "
        "-H 'Host: mt-agent.com' | head -c 200",
        timeout=60,
    )
    print(o.read().decode("utf-8", "replace"))
    err = e.read().decode("utf-8", "replace")
    if err.strip():
        print(err.rstrip())
    c.close()
    print("ok http://mt-agent.com/mtnode/music3/manifest.json")


if __name__ == "__main__":
    main()

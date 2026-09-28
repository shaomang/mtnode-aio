"""Upload dist/plugins-publish to mt-agent.com /var/www/mtnode/plugins/."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

try:
    import paramiko
except ImportError:
    sys.exit("需要 paramiko：pip install paramiko")

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / "dist" / "plugins-publish"
REMOTE = "/var/www/mtnode/plugins"
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
        sys.exit("先运行 node scripts/stage-plugins.mjs（缺少 dist/plugins-publish）")
    files = [
        p
        for p in LOCAL.iterdir()
        if p.is_file() and p.name != "README.txt" and not p.name.startswith("_")
    ]
    if not files:
        sys.exit("dist/plugins-publish 内无可上传文件")
    if not any(p.name == "catalog.json" for p in files):
        sys.exit("缺少 catalog.json")

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
    run(
        c,
        "chmod -R a+rX /var/www/mtnode/plugins && "
        "curl -sS -o /tmp/plugins-cat.json -w 'plugins:%{http_code}\\n' "
        "-H 'Host: mt-agent.com' http://127.0.0.1/mtnode/plugins/catalog.json",
    )
    c.close()
    print("ok http://mt-agent.com/mtnode/plugins/catalog.json")


if __name__ == "__main__":
    main()

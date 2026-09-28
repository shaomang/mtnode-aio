"""Upload web/privacy to mt-agent.com /var/www/mtnode/privacy/ and wire nginx.

阶段开关（npm run deploy:privacy 串起 upload→patch；不带参数 = 两步都跑）：
  --upload-only  只传目录 + chmod + 送 patch 脚本
  --patch-only   只跑远端 patch → nginx -t → reload → 验证
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    import paramiko
except ImportError:
    sys.exit("需要 paramiko：pip install paramiko")

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / "web" / "privacy"
PATCH = ROOT / "scripts" / "patch-nginx-privacy.py"
REMOTE = "/var/www/mtnode/privacy"
REMOTE_TMP = "/tmp/mtnode-privacy-upload"
CONF = "/etc/nginx/sites-available/mt-ai-router.conf"
ENABLED = "/etc/nginx/sites-enabled/mt-ai-router.conf"
BACKUP = CONF + ".bak-privacy"
DEFAULT_SFTP = Path(r"E:\dev\mt-ai-router\.vscode\sftp.json")
SITE = "mt-agent.com"
# 目录页 + 无斜杠 302；两页都必须 text/html 且无 Content-Disposition
PATHS = ("/mtnode/privacy/", "/mtnode/privacy")


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
        print("put", rel, "→", dest)
        n += 1
    return n


def exec_(c: paramiko.SSHClient, cmd: str, timeout: int = 60) -> tuple[int, str]:
    print("remote:", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = out + ("\n" + err if err.strip() else "")
    if text.strip():
        print(text.rstrip())
    return code, text


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 60) -> str:
    code, text = exec_(c, cmd, timeout=timeout)
    if code != 0:
        raise SystemExit(f"remote exit {code}: {cmd}")
    return text


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def fetch(url: str, follow: bool = True) -> tuple[int, object]:
    """返回 (状态码, 响应头)；响应头用 email.message.Message，取键大小写不敏感。"""
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(_NoRedirect())
    req = urllib.request.Request(url, headers={"User-Agent": "mtnode-deploy-privacy"})
    try:
        with opener.open(req, timeout=25) as r:
            return r.status, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers


def verify_remote(c: paramiko.SSHClient) -> None:
    for p in PATHS:
        exec_(c, f"curl -sS -o /dev/null -D - -H 'Host: {SITE}' http://127.0.0.1{p}")


def verify_public() -> None:
    """本机 curl 验证外网两个 URL：200 + text/html + 无 Content-Disposition。"""
    bad: list[str] = []
    for p in PATHS:
        url = f"http://{SITE}{p}"
        if p.endswith("/"):
            code, head = fetch(url)
        else:
            c302, h302 = fetch(url, follow=False)
            loc = h302.get("Location", "")
            print(f"GET {url} -> {c302} Location: {loc}")
            if c302 != 302 or "/mtnode/privacy/" not in loc:
                bad.append(f"{url}: 期望 302 → /mtnode/privacy/，实得 {c302} {loc!r}")
            code, head = fetch(url)
        ct = head.get("Content-Type", "")
        cd = head.get("Content-Disposition")
        print(f"GET {url} -> {code} Content-Type: {ct or '(无)'} Content-Disposition: {cd or '(无)'}")
        if code != 200:
            bad.append(f"{url}: HTTP {code}（期望 200）")
        if "text/html" not in ct:
            bad.append(f"{url}: Content-Type={ct!r}（期望 text/html）")
        if cd:
            bad.append(f"{url}: 仍有 Content-Disposition={cd!r}（下载页头被继承）")
    if bad:
        sys.exit("外网验证失败：\n  " + "\n  ".join(bad))
    print("public check ok:", " ".join(f"http://{SITE}{p}" for p in PATHS))


def stage_upload(c: paramiko.SSHClient) -> None:
    """sftp 上传 web/privacy 整目录 → /var/www/mtnode/privacy/，并把 patch 脚本送到 /tmp。"""
    sftp = c.open_sftp()
    try:
        n = put_dir(sftp, LOCAL, REMOTE)
        mkdir_p(sftp, REMOTE_TMP)
        sftp.put(str(PATCH), REMOTE_TMP + "/patch-nginx-privacy.py")
        print("uploaded", n, "files to", REMOTE)
    finally:
        sftp.close()
    run(c, f"chmod -R a+rX {REMOTE}")


def stage_patch(c: paramiko.SSHClient) -> None:
    """远端跑 patch（幂等）→ nginx -t → 通过才 reload，失败用备份还原并报错退出。"""
    remote_patch = REMOTE_TMP + "/patch-nginx-privacy.py"
    if exec_(c, f"test -f {remote_patch}")[0] != 0:
        sftp = c.open_sftp()
        try:
            mkdir_p(sftp, REMOTE_TMP)
            sftp.put(str(PATCH), remote_patch)
        finally:
            sftp.close()
    code, out = exec_(c, f"python3 {remote_patch}")
    if code != 0:
        sys.exit("远端 patch 失败，nginx 未 reload")
    patched = "inserted nginx" in out

    code, _ = exec_(c, "nginx -t 2>&1")
    if code != 0:
        if patched and exec_(c, f"test -f {BACKUP}")[0] == 0:
            exec_(
                c,
                f"cp -a {BACKUP} {CONF} && "
                f"if [ -f {ENABLED} ] && [ ! -L {ENABLED} ]; then cp -a {BACKUP} {ENABLED}; fi && "
                "nginx -t 2>&1 || true",
            )
            print(f"nginx -t 失败：已用备份还原 {BACKUP}")
        else:
            print("nginx -t 失败：本次未改动配置，不自动还原，请人工检查")
        sys.exit("nginx -t 失败，未 reload")
    run(c, "systemctl reload nginx")
    verify_remote(c)


def main() -> None:
    argv = sys.argv[1:]
    only_upload = "--upload-only" in argv
    only_patch = "--patch-only" in argv
    if not LOCAL.is_dir():
        sys.exit("缺少 web/privacy")
    if not only_patch and not any(p.is_file() for p in LOCAL.rglob("*")):
        sys.exit("web/privacy 内无可上传文件")
    if not PATCH.is_file():
        sys.exit("缺少 scripts/patch-nginx-privacy.py")

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

    try:
        if not only_patch:
            stage_upload(c)
        if not only_upload:
            stage_patch(c)
    finally:
        c.close()

    if not only_upload:
        # 本机 curl 验证外网两个 URL
        verify_public()
        print("ok http://mt-agent.com/mtnode/privacy/  (en: /mtnode/privacy/en/)")


if __name__ == "__main__":
    main()

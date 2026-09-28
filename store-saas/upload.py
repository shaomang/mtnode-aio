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
    "sms-provider.mjs",
    "account-store.mjs",
    "migrate-accounts.mjs",
    "package.json",
    "mtnode-store.service",
    "deploy.sh",
    "patch-nginx.py",
    "seed-skills.mjs",
    # 充值 / 钱包（见 docs/recharge-design.md）
    "wallet.mjs",
    "alipay-provider.mjs",
    "alipay-keygen.mjs",
    # 线上只读探针：查这个 APPID 到底签约了哪些支付产品（控制台看不到接口权限）
    "alipay-probe.mjs",
    "qr-encode.mjs",
    "migrate-wechat-owner.mjs",
)
# 管理台静态页（独立界面，站点不设入口）：整目录上传，deploy.sh 同时装进
# /opt/mtnode-store/admin（服务自身 /admin/ 路由）与 /var/www/mtnode/admin（nginx 静态）。
ADMIN_LOCAL = ROOT / "admin"
REMOTE_ADMIN = REMOTE_TMP + "/admin"
# 支付同步跳回页（return_url，支付宝收银台付完款跳回这里）：整目录上传，
# deploy.sh 装进 /var/www/mtnode/pay-done（nginx 静态）。站点无入口、noindex、不参与入账。
PAYDONE_LOCAL = ROOT / "pay-done"
REMOTE_PAYDONE = REMOTE_TMP + "/pay-done"
# 应用目录静态清单与 zip / 图标（客户端读 http://mt-agent.com/mtnode/apps/catalog.json，
# 条目里的 zipUrl / icon 相对该目录）：整目录上传，deploy.sh 装进 /var/www/mtnode/apps。
# catalog.json 手写或由 `python upload-app.py --catalog-out apps/catalog.json` 生成。
APPS_LOCAL = ROOT / "apps"
REMOTE_APPS = REMOTE_TMP + "/apps"
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
        if ADMIN_LOCAL.is_dir():
            rm_tree(sftp, REMOTE_ADMIN)
            n = put_dir(sftp, ADMIN_LOCAL, REMOTE_ADMIN)
            print("uploaded admin", n, "files to", REMOTE_ADMIN)
        else:
            print("skip missing admin/")
        if PAYDONE_LOCAL.is_dir():
            rm_tree(sftp, REMOTE_PAYDONE)
            n = put_dir(sftp, PAYDONE_LOCAL, REMOTE_PAYDONE)
            print("uploaded pay-done", n, "files to", REMOTE_PAYDONE)
        else:
            print("skip missing pay-done/")
        if APPS_LOCAL.is_dir():
            rm_tree(sftp, REMOTE_APPS)
            n = put_dir(sftp, APPS_LOCAL, REMOTE_APPS)
            print("uploaded apps", n, "files to", REMOTE_APPS)
        else:
            print("skip missing apps/")
        if SKILLS_LOCAL.is_dir():
            rm_tree(sftp, REMOTE_SKILLS)
            n = put_dir(sftp, SKILLS_LOCAL, REMOTE_SKILLS)
            print("uploaded skills", n, "files to", REMOTE_SKILLS)
    finally:
        sftp.close()
    run(c, "chmod +x /tmp/mtnode-store-upload/deploy.sh && bash /tmp/mtnode-store-upload/deploy.sh")
    c.close()
    print("ok http://mt-agent.com/mtnode/store-api/api/health")
    print("apps: http://mt-agent.com/mtnode/apps/catalog.json （静态清单 + <id>.zip / icons/）")
    print("      上传自己的应用包：python upload-app.py --zip <AppName>.zip --id <app-id> --title <标题>")
    print("admin: https://www.mt-agent.com/mtnode/admin/  (站点无入口，仅白名单微信扫码登录)")
    print("seed hint:")
    print(
        "  MTNODE_STORE_URL=http://127.0.0.1:8787 "
        "MTNODE_SKILLS_DIR=/tmp/mtnode-store-skills "
        "MTNODE_STORE_PASS_FILE=/opt/mtnode-store/.store-pass "
        "node /opt/mtnode-store/seed-skills.mjs"
    )
    print("微信归属迁移 hint（先 dry-run，确认无误再去掉 --dry-run）:")
    print(
        "  cd /opt/mtnode-store && set -a && . /etc/mtnode-store.env && set +a && "
        "node migrate-wechat-owner.mjs --unionid=<unionid> --target=ms2308 --dry-run"
    )
    print("充值通道 hint（支付宝当面付 · 公钥模式，详见 docs/recharge-design.md §凭据）:")
    print("  1) 服务器上生成应用密钥对（私钥只落 /etc/mtnode-store/alipay，0600，不进仓库不打印）:")
    print("     cd /opt/mtnode-store && node alipay-keygen.mjs --appid <开放平台APPID> --print env")
    print("  2) 把打印出的「应用公钥」裸 base64 粘到 开放平台 → 应用 → 开发设置 → 接口加签方式")
    print("     （自定义密钥/公钥模式，官方口径 https://opendocs.alipay.com/common/055l5k）")
    print("  3) 控制台返回的「支付宝公钥」存成 /etc/mtnode-store/alipay/alipay_public_key.pem")
    print("  4) 把 --print env 那段（APPID / _PRIVATE_KEY_PATH / _PUBLIC_KEY_PATH / _NOTIFY_URL）")
    print("     追加进 /etc/mtnode-store.env → systemctl restart mtnode-store")
    print("     注意 NOTIFY_URL 必须用 www 域名：apex 会 301，支付宝不跟随重定向 = 丢异步通知")
    print("  5) 自检：curl -s https://www.mt-agent.com/mtnode/store-api/api/pay/alipay/status")
    print("     → configured:true 且 notifyWarning 为空")


if __name__ == "__main__":
    main()

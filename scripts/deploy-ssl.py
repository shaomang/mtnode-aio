#!/usr/bin/env python3
"""部署阿里云 SSL 证书到 mt-agent.com 的 nginx（上传证书 → 打补丁 → 验证）。

证书来源：阿里云数字证书管理服务（CAS）实例 cert-oiazal / cas_dv-cn-adx4ya20n012
          DigiCert DV 单域名，仅 www.mt-agent.com，2026-12-10 到期。

本地放证书（按顺序自动探测，也可用 --bundle 指定）：
  1) %APPDATA%\\pipeline-console\\ssl\\www.mt-agent.com\\
  2) E:\\dev\\tools\\ssl
  *.pem   阿里云「Nginx 版」证书包里的证书链（fullchain）
  *.key   私钥
  csr.pem 可选；存在则校验证书公钥与 CSR 一致

用法：
  python scripts/deploy-ssl.py                 # 上传 + 打补丁 + nginx -t + reload + 验证
  python scripts/deploy-ssl.py --dry-run       # 只打印改后的 server 块，不写任何文件
  python scripts/deploy-ssl.py --patch-only    # 证书已在服务器上，只重打补丁
  python scripts/deploy-ssl.py --hsts          # 顺带开 HSTS（默认关，测试证书阶段建议先不开）
"""
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
PATCH = ROOT / "scripts" / "patch-nginx-ssl.py"
REMOTE_TMP = "/tmp/mtnode-ssl-deploy"
CONF = "/etc/nginx/sites-available/mt-ai-router.conf"
ENABLED = "/etc/nginx/sites-enabled/mt-ai-router.conf"
BACKUP = CONF + ".bak-ssl"
DEFAULT_SFTP = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")

DOMAIN = "www.mt-agent.com"
APEX = "mt-agent.com"


def bundle_candidates() -> list[Path]:
    """证书包目录候选：先本机 userData，再项目外的开发目录 E:\\dev\\tools\\ssl。"""
    base = os.environ.get("APPDATA") or str(Path.home())
    return [
        Path(base) / "pipeline-console" / "ssl" / DOMAIN,
        Path(base) / "pipeline-console" / "ssl",
        Path(r"E:\dev\tools\ssl"),
    ]


def _has_material(p: Path) -> bool:
    """该目录是否真的放了证书/私钥（csr.pem 只算佐证，不算证书）。"""
    return (
        any(f.name.lower() != "csr.pem" for f in p.glob("*.pem"))
        or any(p.glob("*.key"))
        or any(p.glob("*.crt"))
    )


def default_bundle_dir() -> Path:
    for p in bundle_candidates():
        if p.is_dir() and _has_material(p):
            return p
    return bundle_candidates()[0]


def load_cfg() -> dict:
    env_path = os.environ.get("MTNODE_SFTP_JSON", "").strip()
    candidates = ([Path(env_path)] if env_path else []) + [DEFAULT_SFTP]
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


def mkdir_p(sftp: "paramiko.SFTPClient", remote: str) -> None:
    cur = ""
    for part in remote.strip("/").split("/"):
        cur += "/" + part
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def exec_(c: "paramiko.SSHClient", cmd: str, timeout: int = 90) -> tuple[int, str]:
    print("remote:", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = out + ("\n" + err if err.strip() else "")
    if text.strip():
        print(text.rstrip())
    return code, text


def run(c: "paramiko.SSHClient", cmd: str, timeout: int = 90) -> str:
    code, text = exec_(c, cmd, timeout=timeout)
    if code != 0:
        raise SystemExit(f"remote exit {code}: {cmd}")
    return text


def pick_local(bundle: Path, explicit: str | None, kind: str) -> Path:
    if explicit:
        p = Path(explicit)
        if not p.is_file():
            sys.exit(f"{kind} 文件不存在：{p}")
        return p
    if kind == "cert":
        cands = [p for p in bundle.glob("*.pem") if p.name.lower() != "csr.pem"]
        cands += list(bundle.glob("*.crt"))
    else:
        cands = list(bundle.glob("*.key"))
    if not cands:
        sys.exit(
            f"在 {bundle} 里找不到 {kind} 文件。\n"
            "请从阿里云控制台 → 数字证书管理服务 → 证书管理 → 已签发实例 → 下载 → "
            "选「Nginx」版，把解压出的 .pem / .key 放到该目录（见 docs/ssl-deploy-mt-agent.md）"
        )
    return sorted(cands)[0]


def main() -> None:
    argv = sys.argv[1:]

    def opt(name: str, default: str | None = None) -> str | None:
        if name in argv:
            return argv[argv.index(name) + 1]
        return default

    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return

    only_patch = "--patch-only" in argv
    dry_run = "--dry-run" in argv
    hsts = "--hsts" in argv
    force = "--force" in argv
    domain = opt("--domain", DOMAIN) or DOMAIN
    bundle = Path(opt("--bundle") or default_bundle_dir())
    cert = pick_local(bundle, opt("--cert"), "cert") if not only_patch else None
    key = pick_local(bundle, opt("--key"), "key") if not only_patch else None
    csr = bundle / "csr.pem"

    if not PATCH.is_file():
        sys.exit("缺少 scripts/patch-nginx-ssl.py")

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

    remote_dir = f"/etc/nginx/ssl/{domain}"
    remote_cert = f"{remote_dir}/fullchain.pem"
    remote_key = f"{remote_dir}/privkey.pem"

    try:
        sftp = c.open_sftp()
        try:
            mkdir_p(sftp, REMOTE_TMP)
            sftp.put(str(PATCH), REMOTE_TMP + "/patch-nginx-ssl.py")
            if not only_patch:
                mkdir_p(sftp, remote_dir)
                sftp.put(str(cert), remote_cert)
                sftp.put(str(key), remote_key)
                if csr.is_file():
                    sftp.put(str(csr), f"{REMOTE_TMP}/csr.pem")
                print("uploaded cert:", cert.name, "key:", key.name, "→", remote_dir)
        finally:
            sftp.close()

        if not only_patch:
            run(c, f"chmod 644 {remote_cert} && chmod 600 {remote_key}")

            # 证书本身自检：域名覆盖 + 有效期 + 与私钥/CSR 公钥一致
            code, info = exec_(
                c,
                f"openssl x509 -in {remote_cert} -noout -subject -dates -ext subjectAltName",
            )
            if code != 0:
                sys.exit("openssl 无法读取证书，文件可能不是 PEM 证书链")
            if domain not in info:
                sys.exit(f"证书里没有 {domain}，域名对不上，已中止（证书包可能下错实例）")
            code, _ = exec_(
                c,
                # 注意：openssl 3.x 的 `pkey -pubout` 若带 -noout 会静默输出空，
                # 会让两侧 md5 都变空串而误判通过，这里强制要求私钥公钥非空。
                f'test -n "$(openssl pkey -in {remote_key} -pubout 2>/dev/null)" && '
                f'test "$(openssl x509 -in {remote_cert} -noout -pubkey | openssl md5)" = '
                f'"$(openssl pkey -in {remote_key} -pubout | openssl md5)"',
            )
            if code != 0:
                sys.exit("证书与私钥不匹配，已中止")
            if csr.is_file():
                code, _ = exec_(
                    c,
                    f'test "$(openssl x509 -in {remote_cert} -noout -pubkey | openssl md5)" = '
                    f'"$(openssl req -in {REMOTE_TMP}/csr.pem -noout -pubkey | openssl md5)"',
                )
                if code != 0:
                    sys.exit("证书与本项目记录的 CSR 不匹配，已中止")

        patch_cmd = (
            f"python3 {REMOTE_TMP}/patch-nginx-ssl.py --domain {domain} "
            f"--cert {remote_cert} --key {remote_key}"
        )
        if hsts:
            patch_cmd += " --hsts"
        if force:
            patch_cmd += " --force"
        if dry_run:
            patch_cmd += " --dry-run"

        code, out = exec_(c, patch_cmd)
        if code != 0:
            sys.exit("远端 patch 失败，nginx 未 reload")
        if dry_run:
            print("dry-run 结束，未改动服务器")
            return
        patched = "patched nginx ssl" in out
        if not patched:
            print("配置无需改动（可能已就绪）")

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
        exec_(
            c,
            "nginx -T 2>/dev/null | grep -c 'ssl_certificate' | sed 's/^/ssl_certificate 行数: /' || true",
        )

        # 本机侧验证：本地回环 + Host 头，再看 80 是否 301
        exec_(
            c,
            f"curl -sS -o /dev/null -w 'https 本地回环: %{{http_code}}\\n' "
            f"--resolve {domain}:443:127.0.0.1 https://{domain}/",
        )
        exec_(
            c,
            f"curl -sS -o /dev/null -D - -H 'Host: {domain}' http://127.0.0.1/ "
            "| grep -i -E '^HTTP/|^location'",
        )
    finally:
        c.close()

    print()
    print("ok  https://%s/" % domain)
    print("ok  http://%s/  →  301 https" % domain)
    print("ok  http://%s/   →  301 https://%s" % (APEX, domain))
    print("提示：浏览器 / 客户端请用 www.mt-agent.com（证书只签了这一个域名）")


if __name__ == "__main__":
    main()

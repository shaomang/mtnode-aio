#!/usr/bin/env python3
"""把微信扫码回调 MTNODE_WECHAT_REDIRECT 从 http 切到 https（幂等 + 失败自动还原）。

背景：docs/auth-deployment.md §4 规定回调地址必须是
      https://mt-agent.com/mtnode/store-api/api/auth/wechat/callback
      但服务器实际下发的是 http 版本，扫码后回调先吃一次 301，且微信侧对 http 回调兼容性差。
      注意开放平台登记的**授权回调域是裸域 mt-agent.com**，所以这里保持裸域、不要换成 www。

做法：复用 scripts/deploy-ssl.py 的 paramiko + E:\\dev\\mt-ai-router\\.vscode\\sftp.json 连法，
      读取 systemd 服务单元 / 环境文件里的 MTNODE_WECHAT_REDIRECT，幂等替换为 https 版本；
      改前备份，systemctl daemon-reload + restart 后 curl POST /api/auth/wechat/start，
      断言 authUrl 里的 redirect_uri 已 percent-encoded 为 https；断言失败自动还原并重启。

边界：只改 MTNODE_WECHAT_REDIRECT 这一行，不动 APPID / SECRET，不动 nginx。

用法：
  python scripts/patch-wechat-redirect.py              # 备份 → 替换 → 重启 → 断言（失败还原）
  python scripts/patch-wechat-redirect.py --status     # 只打印当前值，不改动
  python scripts/patch-wechat-redirect.py --dry-run    # 只打印将要改动的内容，不写服务器
  python scripts/patch-wechat-redirect.py --url URL    # 覆盖目标回调地址（默认见 TARGET）
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

try:
    import paramiko
except ImportError:
    sys.exit("需要 paramiko：pip install paramiko")

DEFAULT_SFTP = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")

SERVICE = "mtnode-store"
TARGET = "https://mt-agent.com/mtnode/store-api/api/auth/wechat/callback"
APEX = "mt-agent.com"
VAR = "MTNODE_WECHAT_REDIRECT"

# 服务单元默认位置（FragmentPath 拿不到时的兜底）
DEFAULT_UNIT = "/etc/systemd/system/mtnode-store.service"
# EnvironmentFile 兜底候选
FALLBACK_ENV_FILES = ["/etc/mtnode-store.env", "/etc/default/mtnode-store"]
BACKUP_SUFFIX = ".bak-wechat-https"

LOCAL_START = "http://127.0.0.1:8787/api/auth/wechat/start"


def load_cfg() -> dict:
    """与 scripts/deploy-ssl.py 同一套连法：MTNODE_SFTP_JSON 或 sftp.json，其次 MTNODE_SSH_*。"""
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


def exec_(c: "paramiko.SSHClient", cmd: str, timeout: int = 60) -> tuple[int, str]:
    print("remote:", cmd)
    _i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = out + ("\n" + err if err.strip() else "")
    if text.strip():
        print(text.rstrip())
    return code, text


def run(c: "paramiko.SSHClient", cmd: str, timeout: int = 60) -> str:
    code, text = exec_(c, cmd, timeout=timeout)
    if code != 0:
        raise SystemExit(f"remote exit {code}: {cmd}")
    return text


def sftp_read(sftp: "paramiko.SFTPClient", path: str) -> str | None:
    try:
        with sftp.open(path, "r") as f:
            return f.read().decode("utf-8", "replace")
    except FileNotFoundError:
        return None


def sftp_write(sftp: "paramiko.SFTPClient", path: str, text: str) -> None:
    with sftp.open(path, "w") as f:
        f.write(text.encode("utf-8"))


# 匹配 `MTNODE_WECHAT_REDIRECT=值`（允许 systemd 的 `Environment=` 前缀、行首空白、可选引号）
LINE_RE = re.compile(
    r"^(?P<prefix>\s*(?:Environment\s*=\s*)?)" + VAR + r"\s*=\s*(?P<val>.*?)\s*$"
)


def parse_value(line: str) -> str:
    v = line.split("=", 1)[1].strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v


def find_assignment(text: str) -> tuple[int, str] | None:
    """返回 (行号, 当前值)；找不到返回 None。"""
    for i, line in enumerate(text.splitlines()):
        if LINE_RE.match(line):
            return i, parse_value(line)
    return None


def wait_ready(c: "paramiko.SSHClient", timeout: int = 45) -> None:
    """等服务监听就绪：Tablestore 账户后端初始化需要数秒，过早 curl 会 Connection refused。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, _ = exec_(c, f"curl -sS -o /dev/null http://127.0.0.1:8787/api/health")
        if code == 0:
            return
        time.sleep(1.5)
    print(f"警告：{timeout}s 内 /api/health 仍未就绪，继续尝试断言（可能失败并触发还原）")


def unit_candidates(c: "paramiko.SSHClient") -> tuple[str, list[str]]:
    """解析服务单元：返回 (unit_path, 该 unit 声明的 EnvironmentFile 列表)。"""
    code, out = exec_(c, f"systemctl show {SERVICE} -p FragmentPath --value")
    unit = out.strip() if code == 0 and out.strip() else DEFAULT_UNIT
    code, out = exec_(c, f"cat {unit}")
    if code != 0:
        raise SystemExit(f"读不到服务单元 {unit}")
    env_files: list[str] = []
    for line in out.splitlines():
        m = re.match(r"^\s*EnvironmentFile\s*=\s*-?(?P<p>\S+)\s*$", line)
        if m:
            p = m.group("p")
            if not p.startswith("/"):
                p = "/etc/systemd/system/" + p
            env_files.append(p)
    return unit, env_files


def main() -> None:
    argv = sys.argv[1:]
    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return

    status_only = "--status" in argv
    dry_run = "--dry-run" in argv
    target = TARGET
    if "--url" in argv:
        target = argv[argv.index("--url") + 1]
    if not target.startswith("https://"):
        sys.exit(f"目标回调地址必须是 https：{target}")
    if APEX not in target or "www." in target:
        sys.exit(f"目标回调地址必须用裸域 {APEX}（开放平台登记的授权回调域）：{target}")

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
        sftp = c.open_sftp()
        try:
            unit, env_files = unit_candidates(c)
            print("unit:", unit)
            print("EnvironmentFile:", ", ".join(env_files) or "(无)")

            # 依次探测：服务单元 → 它声明的环境文件 → 兜底环境文件
            probes = [unit] + env_files + [p for p in FALLBACK_ENV_FILES if p not in env_files]
            hit: tuple[str, str, int, str] | None = None  # (path, text, lineno, value)
            for path in probes:
                text = sftp_read(sftp, path)
                if text is None:
                    continue
                found = find_assignment(text)
                if found:
                    hit = (path, text, found[0], found[1])
                    break

            if not hit:
                sys.exit(
                    f"在服务单元与候选环境文件里都找不到 {VAR}。\n"
                    f"候选：{', '.join(probes)}\n"
                    f"请先在环境文件里加上 {VAR}={target} 再重跑本脚本。"
                )

            path, text, lineno, current = hit
            print(f"\n当前 {VAR}（{path}:{lineno + 1}）:\n  {current}")

            if current == target:
                print("\n已是 https 目标值，无需改动（幂等）。")
                if status_only:
                    return
                # 仍然做一次运行态断言，确认线上确实生效
            elif status_only:
                print(f"\n待改为:\n  {target}")
                return

            if "www." in current:
                print("警告：当前值含 www.，与开放平台登记的授权回调域（裸域）不一致，本次会一并纠正为裸域。")

            if current != target:
                new_line = LINE_RE.sub(lambda m: m.group("prefix") + VAR + "=" + target, text.splitlines()[lineno])
                lines = text.splitlines()
                lines[lineno] = new_line
                new_text = "\n".join(lines) + ("\n" if text.endswith("\n") else "")

                if dry_run:
                    print(f"\n[dry-run] {path} 将写入:\n  {new_line}")
                    print("[dry-run] 未改动服务器。")
                    return

                backup = path + BACKUP_SUFFIX
                run(c, f"cp -a {path} {backup}")
                print(f"已备份：{backup}")
                sftp_write(sftp, path, new_text)
                print(f"已写入：{path}")
        finally:
            sftp.close()

        if dry_run:
            print("[dry-run] 未改动服务器。")
            return

        # 生效并断言
        run(c, "systemctl daemon-reload")
        run(c, f"systemctl restart {SERVICE}")
        wait_ready(c)

        ok = False
        code, out = exec_(c, f"curl -sS -X POST {LOCAL_START}")
        if code == 0:
            try:
                data = json.loads(out.strip())
            except json.JSONDecodeError:
                data = {}
            auth_url = str(data.get("authUrl") or data.get("auth_url") or "")
            want = "redirect_uri=" + quote(target, safe="")
            print("\n期望: " + want)
            if want in auth_url:
                ok = True
                print("断言通过：authUrl 的 redirect_uri 已是 percent-encoded 的 https 回调。")
            elif not auth_url:
                print("断言失败：/api/auth/wechat/start 未返回 authUrl（微信可能未配置）。")
            else:
                m = re.search(r"redirect_uri=[^&]*", auth_url)
                print("断言失败：实际 " + (m.group(0) if m else "(未找到 redirect_uri)"))

        if not ok:
            print("\n断言失败，开始自动还原…")
            exec_(c, f"test -f {path}{BACKUP_SUFFIX} && cp -a {path}{BACKUP_SUFFIX} {path}")
            exec_(c, "systemctl daemon-reload")
            exec_(c, f"systemctl restart {SERVICE}")
            sys.exit("已还原并重启，服务器回到改动前状态。请人工排查。")

        print()
        print("ok  %s = %s" % (VAR, target))
        print("ok  systemctl daemon-reload + restart %s 已执行" % SERVICE)
        print("ok  本地断言：POST %s 的 redirect_uri 为 percent-encoded https" % LOCAL_START)
    finally:
        c.close()


if __name__ == "__main__":
    main()

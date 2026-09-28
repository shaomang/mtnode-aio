#!/usr/bin/env python3
"""把阿里云 SSL 证书接入 mt-agent.com 的 nginx 站点（幂等 · 改动前备份）。

在服务器上执行（通常由 scripts/deploy-ssl.py 上传后自动调用）：

  python3 patch-nginx-ssl.py \
      --domain www.mt-agent.com \
      --cert /etc/nginx/ssl/www.mt-agent.com/fullchain.pem \
      --key  /etc/nginx/ssl/www.mt-agent.com/privkey.pem \
      [--dry-run] [--hsts] [--no-redirect] [--force]

做四件事：
  1. 在候选站点配置里找到 server_name 命中 --domain 的 server 块；
  2. 该块加 listen 443 ssl + ssl_certificate(_key) + 现代 TLS 参数；
  3. server_name 补上 --domain（证书只签了它，裸域靠跳转兜底）；
  4. 80 请求 301 → HTTPS，裸域统一跳到 --domain。

已有 443 ssl 则跳过（幂等）；--force 会替换已有的 ssl_certificate 两行。
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

CANDIDATES = [
    Path("/etc/nginx/sites-available/mt-ai-router.conf"),
    Path("/etc/nginx/sites-enabled/mt-ai-router.conf"),
    Path("/etc/nginx/conf.d/mt-agent.conf"),
    Path("/etc/nginx/conf.d/mt-ai-router.conf"),
    Path("/etc/nginx/sites-available/default"),
    Path("/etc/nginx/sites-enabled/default"),
]

TLS_CIPHERS = (
    "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:"
    "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:"
    "ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"
)


def nginx_version() -> tuple[int, ...]:
    """取 nginx 版本；拿不到就当新版（用 http2 on）。"""
    try:
        out = subprocess.run(
            ["nginx", "-v"], capture_output=True, text=True, timeout=10
        ).stderr
        m = re.search(r"nginx/(\d+)\.(\d+)\.(\d+)", out)
        if m:
            return tuple(int(x) for x in m.groups())
    except Exception:  # noqa: BLE001
        pass
    return (99, 99, 99)


def server_blocks(text: str) -> list[tuple[int, int, int]]:
    """返回 [(server 起始下标, '{' 下标, '}' 下标)]，跳过注释与字符串。"""
    blocks: list[tuple[int, int, int]] = []
    i, n = 0, len(text)
    in_comment = False
    while i < n:
        ch = text[i]
        if in_comment:
            if ch == "\n":
                in_comment = False
            i += 1
            continue
        if ch == "#":
            in_comment = True
            i += 1
            continue
        m = re.match(r"server\s*\{", text[i:])
        if m and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
            open_idx = i + m.end() - 1
            depth, j, in_c, in_str = 1, open_idx + 1, False, False
            while j < n and depth:
                c = text[j]
                if in_c:
                    if c == "\n":
                        in_c = False
                elif c == "#":
                    in_c = True
                elif c == '"':
                    in_str = not in_str
                elif not in_str:
                    if c == "{":
                        depth += 1
                    elif c == "}":
                        depth -= 1
                j += 1
            blocks.append((i, open_idx, j - 1))
            i = j
            continue
        i += 1
    return blocks


def server_names(block: str) -> list[str]:
    m = re.search(r"(?m)^\s*server_name\s+([^;]+);", block)
    return m.group(1).split() if m else []


def matches(name: str, domain: str) -> bool:
    if name == domain or name == "_":
        return True
    if name.startswith("*."):
        return domain.endswith(name[1:])
    return False


def build_ssl_block(domain: str, cert: str, key: str, hsts: bool) -> str:
    ver = nginx_version()
    listen = "    listen 443 ssl;\n    listen [::]:443 ssl;\n"
    if ver >= (1, 25, 1):
        listen += "    http2 on;\n"
    else:
        listen = (
            "    listen 443 ssl http2;\n"
            "    listen [::]:443 ssl http2;\n"
        )
    hsts_line = ""
    if hsts:
        hsts_line = '    add_header Strict-Transport-Security "max-age=31536000" always;\n'
    return (
        "    # === 阿里云 SSL 证书（scripts/patch-nginx-ssl.py 写入）===\n"
        f"{listen}"
        f"    ssl_certificate     {cert};\n"
        f"    ssl_certificate_key {key};\n"
        "    ssl_protocols       TLSv1.2 TLSv1.3;\n"
        f"    ssl_ciphers         {TLS_CIPHERS};\n"
        "    ssl_prefer_server_ciphers off;\n"
        "    ssl_session_cache   shared:SSL:10m;\n"
        "    ssl_session_timeout 1d;\n"
        "    ssl_session_tickets off;\n"
        f"{hsts_line}"
    )


def build_redirect(domain: str, apex: str | None) -> str:
    out = "    # === HTTP → HTTPS ===\n"
    if apex and apex != domain:
        out += (
            f"    if ($host = {apex}) {{\n"
            f"        return 301 https://{domain}$request_uri;\n"
            "    }\n"
        )
    out += (
        '    if ($scheme != "https") {\n'
        "        return 301 https://$host$request_uri;\n"
        "    }\n"
    )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="www.mt-agent.com")
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--hsts", action="store_true")
    ap.add_argument("--no-redirect", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    path = next((p for p in CANDIDATES if p.exists()), None)
    if path is None:
        sys.exit("nginx 配置未找到：" + " / ".join(str(p) for p in CANDIDATES))
    if not Path(args.cert).is_file() or not Path(args.key).is_file():
        sys.exit(f"证书文件不存在：{args.cert} / {args.key}")

    text = path.read_text(encoding="utf-8", errors="replace")
    domain = args.domain
    apex = domain.split(".", 1)[1] if domain.count(".") >= 2 else None

    target = None
    fallback = None
    for start, open_idx, close_idx in server_blocks(text):
        block = text[start : close_idx + 1]
        names = server_names(block)
        if any(matches(nm, domain) for nm in names):
            target = (start, open_idx, close_idx, block, names)
            break
        if fallback is None and apex and apex in names:
            fallback = (start, open_idx, close_idx, block, names)
    if target is None:
        target = fallback
    if target is None:
        sys.exit(f"没有找到 server_name 命中 {domain} 的 server 块，请人工确认配置")

    start, open_idx, close_idx, block, names = target
    extra = [nm for nm in names if nm not in ("_", domain, apex) and not matches(nm, domain)]
    if extra and not args.force:
        sys.exit(
            "目标 server 块的 server_name 还包含证书不覆盖的域名："
            + " ".join(extra)
            + "\n给该块加 443 会让这些域名收到 www.mt-agent.com 的证书（浏览器报错）。"
            "\n请把 mt-agent.com 拆成独立 server 块后再跑，或确认无误时加 --force 强制继续。"
        )
    if "ssl_certificate" in block and not args.force:
        cur = re.search(r"ssl_certificate\s+([^;]+);", block)
        print(f"nginx 已配置 SSL（{cur.group(1).strip() if cur else '?'}）；未改动")
        print("如需换成本次证书，加 --force 重跑")
        return

    if "listen" in block and re.search(r"listen[^;]*\bssl\b", block) and not args.force:
        print("nginx 已有 listen ... ssl；未改动（--force 可替换证书路径）")
        return

    new_block = block
    if args.force:
        new_block = re.sub(r"(?m)^\s*ssl_certificate(_key)?\s+[^;]+;\n", "", new_block)
        new_block = re.sub(r"(?m)^\s*# === 阿里云 SSL 证书.*\n", "", new_block)
    ssl_part = build_ssl_block(domain, args.cert, args.key, args.hsts)
    redirect = "" if args.no_redirect else build_redirect(domain, apex)
    # 插到 server 块的 '{' 之后
    insert_at = new_block.index("{") + 1
    new_block = new_block[:insert_at] + "\n" + ssl_part + redirect + new_block[insert_at:]

    # server_name 补 --domain（注意 group(1) 含 "server_name " 前缀，只改 group(2) 的域名列表）
    if not any(matches(nm, domain) for nm in names):
        def _fix(m: re.Match) -> str:
            cur = m.group(2).split()
            cur.append(domain)
            return m.group(1) + " ".join(cur) + ";"

        new_block, cnt = re.subn(
            r"(?m)^(\s*server_name\s+)([^;]+);", _fix, new_block, count=1
        )
        if cnt == 0:
            sys.exit("目标 server 块没有 server_name，请人工确认配置")

    new_text = text[:start] + new_block + text[close_idx + 1 :]

    # 兜底自检：server 块数量必须不变，且不能出现 "server server" 这类拼接事故
    if re.search(r"(?m)^\s*server\s+server\b", new_text):
        sys.exit("补丁结果异常（server 关键字重复），未写入")
    if len(re.findall(r"(?m)^\s*server\s*\{", new_text)) != len(
        re.findall(r"(?m)^\s*server\s*\{", text)
    ):
        sys.exit("补丁结果异常（server 块数量变化），未写入")

    if args.dry_run:
        print("---- DRY RUN: 以下为改动后的 server 块 ----")
        print(new_block)
        print("---- DRY RUN 结束，未写入 ----")
        return

    backup = Path(str(path) + ".bak-ssl")
    shutil.copy2(path, backup)
    path.write_text(new_text, encoding="utf-8")
    print("patched nginx ssl; backup", backup)


if __name__ == "__main__":
    main()

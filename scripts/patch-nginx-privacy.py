#!/usr/bin/env python3
"""Ensure nginx locations for /mtnode/privacy/ (same family as patch-nginx-h3.py).

在服务器上执行（正常由 scripts/upload-privacy.py 经 SSH 调用）：
向 /etc/nginx/sites-available/mt-ai-router.conf 的「# === MTNode AI编排器 下载页」注释前
插入两条 location —— 隐私政策静态页目录 + 无斜杠 302。
幂等：已含该 location 就打印并退出 0；写前备份 .conf.bak-privacy。
"""
from pathlib import Path
import shutil
import sys

CONF_PATHS = (
    "/etc/nginx/sites-available/mt-ai-router.conf",
    "/etc/nginx/sites-enabled/mt-ai-router.conf",
)
ENABLED = Path("/etc/nginx/sites-enabled/mt-ai-router.conf")
MARKER = "location ^~ /mtnode/privacy/"
NEEDLE = "# === MTNode AI编排器 下载页"
BACKUP_SUFFIX = ".bak-privacy"

# 下载页那段带 hide（Content-Disposition）头；这里单独一个 ^~ location，
# 只声明 text/html + no-cache，本 location 不写 add_header 之外的任何下载头。
BLOCK = """    # === MTNode 隐私政策（静态 HTML：text/html，无 Content-Disposition）===
    location ^~ /mtnode/privacy/ {
        alias /var/www/mtnode/privacy/;
        default_type text/html;
        add_header Cache-Control "no-cache";
    }

    location = /mtnode/privacy {
        return 302 /mtnode/privacy/;
    }

"""


def main() -> int:
    path = next((Path(p) for p in CONF_PATHS if Path(p).is_file()), None)
    if path is None:
        print("nginx config not found: " + " / ".join(CONF_PATHS), file=sys.stderr)
        return 1

    text = path.read_text(encoding="utf-8", errors="replace")
    if MARKER in text:
        print("nginx /mtnode/privacy/ location already present")
        return 0

    lines = text.splitlines(keepends=True)
    idx = next((i for i, ln in enumerate(lines) if ln.lstrip().startswith(NEEDLE)), None)
    if idx is None:
        print(f"nginx needle not found in {path}: {NEEDLE}; edit manually", file=sys.stderr)
        return 1

    backup = path.with_suffix(path.suffix + BACKUP_SUFFIX)
    shutil.copy2(path, backup)
    lines.insert(idx, BLOCK)
    path.write_text("".join(lines), encoding="utf-8")
    # sites-enabled 可能是实体文件而非软链
    if ENABLED.is_file() and ENABLED.resolve() != path.resolve():
        ENABLED.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"inserted nginx /mtnode/privacy/; backup {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

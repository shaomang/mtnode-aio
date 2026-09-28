#!/usr/bin/env python3
"""Insert ^~ /mtnode/updates/ static location for electron-updater (Range required)."""
from pathlib import Path
import shutil
import sys

CANDIDATES = [
    Path("/etc/nginx/sites-enabled/default"),
    Path("/etc/nginx/sites-available/default"),
    Path("/etc/nginx/conf.d/mt-agent.conf"),
]

nginx_path = next((p for p in CANDIDATES if p.exists()), None)
if nginx_path is None:
    print("nginx config not found; edit manually", file=sys.stderr)
    sys.exit(1)

text = nginx_path.read_text(encoding="utf-8", errors="replace")
if "location ^~ /mtnode/updates/" in text:
    print("nginx updates location already present")
    sys.exit(0)

block = """
    location ^~ /mtnode/updates/ {
        alias /var/www/html/mtnode/updates/;
        autoindex off;
        add_header Cache-Control "no-cache";
        # electron-updater differential downloads need HTTP Range
        add_header Access-Control-Allow-Origin *;
    }
"""

needle = "location ^~ /mtnode/store-api/"
if needle in text:
    text = text.replace(needle, block + "\n    " + needle, 1)
else:
    idx = text.find("server {")
    if idx < 0:
        print("cannot find server block", file=sys.stderr)
        sys.exit(1)
    brace = text.find("{", idx)
    text = text[: brace + 1] + "\n" + block + text[brace + 1 :]

backup = Path(str(nginx_path) + ".bak-updates")
shutil.copy2(nginx_path, backup)
nginx_path.write_text(text, encoding="utf-8")
print("inserted updates location; backup", backup)

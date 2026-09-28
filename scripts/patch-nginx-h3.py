#!/usr/bin/env python3
"""Ensure nginx location for /mtnode/h3/ exists before the OSS regex."""
from pathlib import Path

path = Path("/etc/nginx/sites-available/mt-ai-router.conf")
if not path.is_file():
    path = Path("/etc/nginx/sites-enabled/mt-ai-router.conf")
text = path.read_text(encoding="utf-8")

BLOCK = """
    # === MTNode Minimax H3 脚手架 ===
    location ^~ /mtnode/h3/ {
        alias /var/www/mtnode/h3/;
        autoindex off;
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control "public, max-age=60";
        types {
            application/json json;
            application/zip zip;
            text/plain txt;
        }
        default_type application/octet-stream;
    }

"""

if "location ^~ /mtnode/h3/" in text:
    print("nginx /mtnode/h3/ location already present")
    raise SystemExit(0)

needle = "location ~ ^/mtnode/(.*)$"
if needle not in text:
    raise SystemExit("OSS regex needle missing; abort")

backup = path.with_suffix(path.suffix + ".bak-h3")
backup.write_text(text, encoding="utf-8")
path.write_text(text.replace(needle, BLOCK + "    " + needle, 1), encoding="utf-8")
enabled = Path("/etc/nginx/sites-enabled/mt-ai-router.conf")
if enabled.is_file() and enabled.resolve() != path.resolve():
    enabled.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
print("inserted nginx /mtnode/h3/; backup", backup)

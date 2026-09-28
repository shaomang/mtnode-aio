#!/usr/bin/env python3
"""Ensure nginx location for /mtnode/music3/ exists before the OSS regex."""
from pathlib import Path

path = Path("/etc/nginx/sites-available/mt-ai-router.conf")
if not path.is_file():
    path = Path("/etc/nginx/sites-enabled/mt-ai-router.conf")
text = path.read_text(encoding="utf-8")

BLOCK = """
    # === MTNode Minimax Music 3 脚手架 ===
    location ^~ /mtnode/music3/ {
        alias /var/www/mtnode/music3/;
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

if "location ^~ /mtnode/music3/" in text:
    print("nginx /mtnode/music3/ location already present")
    raise SystemExit(0)

# Insert before OSS catch-all regex for /mtnode/
needle = "location ~ ^/mtnode/(.*)$"
if needle not in text:
    # fallback: after plugins block
    needle2 = "location ^~ /mtnode/plugins/"
    if needle2 not in text:
        raise SystemExit("nginx needle not found for music3 insert")
    # find end of plugins block roughly by inserting before OSS
    raise SystemExit("OSS regex needle missing; abort")

backup = path.with_suffix(path.suffix + ".bak-music3")
backup.write_text(text, encoding="utf-8")
path.write_text(text.replace(needle, BLOCK + "    " + needle, 1), encoding="utf-8")
# sites-enabled may be a symlink to sites-available
enabled = Path("/etc/nginx/sites-enabled/mt-ai-router.conf")
if enabled.is_file() and enabled.resolve() != path.resolve():
    enabled.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
print("inserted nginx /mtnode/music3/; backup", backup)

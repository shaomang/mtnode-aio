#!/usr/bin/env python3
"""Ensure nginx locations for store-api and /mtnode/plugins/ exist before the OSS regex."""
from pathlib import Path

path = Path("/etc/nginx/sites-available/mt-ai-router.conf")
text = path.read_text(encoding="utf-8")
changed = False

STORE = """
    # === MTNode 模板商店 API ===
    location ^~ /mtnode/store-api/ {
        client_max_body_size 40m;
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;
        proxy_read_timeout 120s;
    }

"""

PLUGINS = """
    # === MTNode 应用插件目录（本地静态，覆盖 OSS 反代） ===
    location ^~ /mtnode/plugins/ {
        alias /var/www/mtnode/plugins/;
        autoindex off;
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control "public, max-age=60";
        types {
            application/json json;
            application/zip zip;
        }
        default_type application/octet-stream;
    }

"""

needle = "    # === MTNode AI编排器 下载页"
if needle not in text:
    raise SystemExit("nginx needle not found: MTNode AI编排器 下载页")

insert = ""
if "location ^~ /mtnode/store-api/" not in text:
    insert += STORE
if "location ^~ /mtnode/plugins/" not in text:
    insert += PLUGINS
if "location ^~ /mtnode/ext/" not in text:
    insert += """
    # === MTNode 扩展目录（插件 / 技能 / MCP） ===
    location ^~ /mtnode/ext/ {
        alias /var/www/mtnode/ext/;
        autoindex off;
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control "public, max-age=60";
        types {
            application/json json;
            application/gzip tgz;
            text/markdown md;
            text/plain txt;
        }
        default_type application/octet-stream;
    }

"""

if not insert:
    print("nginx store-api + plugins locations already present")
    raise SystemExit(0)

backup = path.with_suffix(".conf.bak-plugins")
backup.write_text(text, encoding="utf-8")
path.write_text(text.replace(needle, insert + needle, 1), encoding="utf-8")
print("inserted nginx locations; backup", backup)

#!/usr/bin/env python3
"""Insert ^~ /mtnode/store-api/ before the OSS regex location."""
from pathlib import Path

path = Path("/etc/nginx/sites-available/mt-ai-router.conf")
text = path.read_text(encoding="utf-8")
if "location ^~ /mtnode/store-api/" in text:
    print("nginx store-api location already present")
    raise SystemExit(0)

snippet = """
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
needle = "    # === MTNode AI编排器 下载页"
if needle not in text:
    raise SystemExit("nginx needle not found: MTNode AI编排器 下载页")
backup = path.with_suffix(".conf.bak-store")
backup.write_text(text, encoding="utf-8")
path.write_text(text.replace(needle, snippet + needle, 1), encoding="utf-8")
print("inserted store-api location; backup", backup)

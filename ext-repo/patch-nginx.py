#!/usr/bin/env python3
"""Ensure nginx location for /mtnode/ext/ exists before the OSS regex."""
from pathlib import Path

path = Path("/etc/nginx/sites-available/mt-ai-router.conf")
text = path.read_text(encoding="utf-8")

EXT = """
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

# needle 必须与服务器上现有 nginx 配置里的注释逐字一致（本文件不改写远端配置）：
# 产品中文名已改为「MTNode AI工作站」，而这行注释仍是旧名「MTNode AI编排器」，
# 所以这里保持旧名；待服务器那行注释同步改成新名后，再把 needle 一起改成新名。
needle = "    # === MTNode AI编排器 下载页"
if needle not in text:
    raise SystemExit("nginx needle not found: MTNode AI编排器 下载页")

if "location ^~ /mtnode/ext/" in text:
    print("nginx /mtnode/ext/ location already present")
    raise SystemExit(0)

backup = path.with_suffix(".conf.bak-ext")
backup.write_text(text, encoding="utf-8")
path.write_text(text.replace(needle, EXT + needle, 1), encoding="utf-8")
print("inserted nginx /mtnode/ext/; backup", backup)

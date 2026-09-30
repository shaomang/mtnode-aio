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

RELAY = """
    # === MTNode 中转站（内部测试：DeepSeek 文本/识图 + gpt-image-2.5 图像）===
    # 与 store-api 同一进程（127.0.0.1:8787），但这一段必须比 /mtnode/store-api/ 更长前缀
    # 才会被选中（^~ 取最长匹配），且要单独放宽超时并关掉缓冲：
    #   · 流式 SSE 一旦被缓冲，客户端就看不到逐字输出（表现为「卡住不吐字」）；
    #   · 图像单张 90-150s、4K 更久，沿用 store-api 的 120s 一定超时；
    #   · 上游图像接口「客户端断开也计费」，超时掐断等于钱花了没结果。
    location ^~ /mtnode/store-api/relay/ {
        client_max_body_size 40m;
        proxy_pass http://127.0.0.1:8787/relay/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
        add_header X-Accel-Buffering no;
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

APPS = """
    # === MTNode 应用目录（本机静态，覆盖 OSS 反代） ===
    # 客户端读 /mtnode/apps/catalog.json；条目里的 zipUrl / icon 相对本目录。
    location ^~ /mtnode/apps/ {
        alias /var/www/mtnode/apps/;
        autoindex off;
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control "public, max-age=60";
        types {
            application/json json;
            application/zip zip;
            image/png png;
            image/jpeg jpg;
        }
        default_type application/octet-stream;
    }

"""

ADMIN = """
    # === MTNode 充值管理台（独立界面 · 站点不设入口 · 仅白名单微信扫码登录）===
    # 无斜杠必须 302 到带斜杠：页面里的 admin.css / admin.js 走相对路径，
    # 停在 /mtnode/admin 上会被解析成 /mtnode/admin.css → 404，页面全白（本机复现过）。
    location = /mtnode/admin {
        return 302 /mtnode/admin/;
    }
    location ^~ /mtnode/admin/ {
        alias /var/www/mtnode/admin/;
        autoindex off;
        add_header Cache-Control "no-store";
        add_header X-Robots-Tag "noindex, nofollow, noarchive";
        types {
            text/html html;
            text/css css;
            application/javascript js;
            image/svg+xml svg;
        }
        default_type application/octet-stream;
    }

"""

PAYDONE = """
    # === MTNode 支付同步跳回页（return_url）===
    # 只有从支付宝收银台付完款跳回来才会被看到；站点任何地方都没有入口，也不被索引。
    # 这一页不参与入账（入账只认服务端验签过的异步 notify 与 trade.query 轮询），
    # 所以它 404 也不影响钱到账 —— 但会让用户看不到「支付完成」的确认，体验上要有。
    location = /mtnode/pay-done {
        return 302 /mtnode/pay-done/;
    }
    location ^~ /mtnode/pay-done/ {
        alias /var/www/mtnode/pay-done/;
        autoindex off;
        add_header Cache-Control "no-store";
        add_header X-Robots-Tag "noindex, nofollow, noarchive";
        types {
            text/html html;
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
if "location ^~ /mtnode/store-api/relay/" not in text:
    insert += RELAY
if "location ^~ /mtnode/plugins/" not in text:
    insert += PLUGINS
if "location ^~ /mtnode/admin/" not in text:
    insert += ADMIN
if "location ^~ /mtnode/pay-done/" not in text:
    insert += PAYDONE
if "location ^~ /mtnode/apps/" not in text:
    insert += APPS
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
    print("nginx store-api + relay + plugins + admin + apps locations already present")
    raise SystemExit(0)

backup = path.with_suffix(".conf.bak-plugins")
backup.write_text(text, encoding="utf-8")
path.write_text(text.replace(needle, insert + needle, 1), encoding="utf-8")
print("inserted nginx locations; backup", backup)

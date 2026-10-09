#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生产 nginx 补丁（本轮 1000 条目录验证）：
  1) nginx.conf 开 gzip_types application/json —— 否则 add_header 之外，静态 catalog.json 永远不压缩
     （nginx 默认只压 text/html；生产实测就是这样：客户端每次进应用中心都拉 1.5~2MB 明文）
  2) /mtnode/apps/ 段加 gzip_static on —— server.mjs 现在会同时落 catalog.json.gz，直接发它
  3) （可选 --sandbox）加 /mtnode/scale-sandbox/ 段代理到 127.0.0.1:8791，用于本轮公网压测

安全：每一步先备份（.bak-scale-<时间戳>），改完跑 nginx -t，不通过立即回滚并退出非 0。
"""
import os
import re
import shutil
import subprocess
import sys
import time

NGINX_CONF = "/etc/nginx/nginx.conf"
SITE = "/etc/nginx/sites-available/mt-ai-router.conf"
STAMP = time.strftime("%Y%m%d-%H%M%S")
SANDBOX = "--sandbox" in sys.argv
PORT = 8791

GZIP_LINE = "\tgzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;\n"


def backup(p):
    b = p + ".bak-scale-" + STAMP
    shutil.copy2(p, b)
    return b


def test_and_reload(backups):
    r = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    if r.returncode != 0:
        print("nginx -t 失败，回滚：\n" + (r.stderr or ""))
        for src, dst in backups:
            shutil.copy2(src, dst)
        return False
    r2 = subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True)
    if r2.returncode != 0:
        print("reload 失败：\n" + (r2.stderr or ""))
        return False
    return True


def patch_gzip_types():
    src = open(NGINX_CONF, "r", encoding="utf-8").read()
    if re.search(r"^\s*gzip_types\s", src, re.M):
        print("[nginx] gzip_types 已存在，跳过")
        return None
    # 插到 gzip on; 那一行后面（保持缩进）
    m = re.search(r"^(\s*)gzip\s+on\s*;.*$", src, re.M)
    if not m:
        print("[nginx] 找不到 gzip on;，跳过")
        return None
    indent = m.group(1)
    line = indent + "gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;"
    out = src[: m.end()] + "\n" + line + src[m.end():]
    b = backup(NGINX_CONF)
    open(NGINX_CONF, "w", encoding="utf-8").write(out)
    print("[nginx] 已加 gzip_types（备份 " + b + "）")
    return (b, NGINX_CONF)


def patch_apps_static():
    src = open(SITE, "r", encoding="utf-8").read()
    if "gzip_static on;" in src:
        print("[nginx] /mtnode/apps 已有 gzip_static，跳过")
        return None
    anchor = "    location ^~ /mtnode/apps/ {\n"
    if anchor not in src:
        print("[nginx] 找不到 /mtnode/apps/ 段")
        return None
    add = anchor + "        # 本轮优化：server.mjs 同时落 catalog.json.gz，这里直接发它（省掉每次现场压缩）\n        gzip_static on;\n"
    out = src.replace(anchor, add, 1)
    b = backup(SITE)
    open(SITE, "w", encoding="utf-8").write(out)
    print("[nginx] 已给 /mtnode/apps 加 gzip_static（备份 " + b + "）")
    return (b, SITE)


def patch_sandbox(public_prefix="/mtnode/scale-sandbox/"):
    src = open(SITE, "r", encoding="utf-8").read()
    if public_prefix in src:
        print("[nginx] 沙箱段已存在，跳过")
        return None
    block = (
        "\n    # === 1000 条目录隔离沙箱（本轮验证用；压测完删掉这一段即可） ===\n"
        "    location ^~ " + public_prefix + " {\n"
        "        proxy_pass http://127.0.0.1:" + str(PORT) + "/;\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host $host;\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        client_max_body_size 40m;\n"
        "        proxy_read_timeout 120s;\n"
        "    }\n"
    )
    marker = "    location ^~ /mtnode/apps/ {"
    if marker in src:
        out = src.replace(marker, block + "\n" + marker, 1)
    else:
        out = src.rstrip() + "\n" + block + "\n"
    b = backup(SITE)
    open(SITE, "w", encoding="utf-8").write(out)
    print("[nginx] 已加沙箱代理段 " + public_prefix + "（备份 " + b + "）")
    return (b, SITE)


def main():
    backups = []
    for fn in (patch_gzip_types, patch_apps_static):
        r = fn()
        if r:
            backups.append(r)
    if SANDBOX:
        r = patch_sandbox()
        if r:
            backups.append(r)
    if not backups:
        print("[nginx] 没有任何改动")
        return 0
    if not test_and_reload(backups):
        return 2
    print("[nginx] nginx -t 通过并已 reload；备份：" + ", ".join(b for b, _ in backups))
    return 0


if __name__ == "__main__":
    sys.exit(main())

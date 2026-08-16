#!/bin/bash
set -euo pipefail
SRC=/tmp/mtnode-store-upload
mkdir -p /opt/mtnode-store/data/files /opt/mtnode-store/data/previews
install -m 644 "$SRC/server.mjs" /opt/mtnode-store/server.mjs
install -m 644 "$SRC/package.json" /opt/mtnode-store/package.json
install -m 644 "$SRC/mtnode-store.service" /etc/systemd/system/mtnode-store.service
python3 "$SRC/patch-nginx.py"
nginx -t
systemctl daemon-reload
systemctl enable mtnode-store
systemctl restart mtnode-store
systemctl reload nginx
sleep 0.8
echo "local: $(curl -sS http://127.0.0.1:8787/api/health)"
echo "proxy: $(curl -sS -H 'Host: mt-agent.com' http://127.0.0.1/mtnode/store-api/api/health)"
systemctl is-active mtnode-store

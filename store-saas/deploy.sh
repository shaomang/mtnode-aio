#!/bin/bash
set -euo pipefail
SRC=/tmp/mtnode-store-upload
mkdir -p /opt/mtnode-store/data/files /opt/mtnode-store/data/skills /opt/mtnode-store/data/previews /opt/mtnode-store/data/forum-images
mkdir -p /var/www/mtnode/plugins
install -m 644 "$SRC/server.mjs" /opt/mtnode-store/server.mjs
install -m 644 "$SRC/package.json" /opt/mtnode-store/package.json
install -m 644 "$SRC/mtnode-store.service" /etc/systemd/system/mtnode-store.service
if [ -f "$SRC/seed-skills.mjs" ]; then
  install -m 644 "$SRC/seed-skills.mjs" /opt/mtnode-store/seed-skills.mjs
fi
if [ -f "$SRC/catalog.json" ]; then
  install -m 644 "$SRC/catalog.json" /var/www/mtnode/plugins/catalog.json
fi
shopt -s nullglob
for z in "$SRC"/*.zip; do
  install -m 644 "$z" "/var/www/mtnode/plugins/$(basename "$z")"
done
shopt -u nullglob
python3 "$SRC/patch-nginx.py"
nginx -t
systemctl daemon-reload
systemctl enable mtnode-store
systemctl restart mtnode-store
systemctl reload nginx
sleep 0.8
echo "local: $(curl -sS http://127.0.0.1:8787/api/health)"
echo "proxy: $(curl -sS -H 'Host: mt-agent.com' http://127.0.0.1/mtnode/store-api/api/health)"
echo "plugins: $(curl -sS -o /tmp/plugins-cat.json -w '%{http_code}' -H 'Host: mt-agent.com' http://127.0.0.1/mtnode/plugins/catalog.json)"
echo "forum: $(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: mt-agent.com' http://127.0.0.1/mtnode/store-api/api/forum/messages?room=general)"
systemctl is-active mtnode-store

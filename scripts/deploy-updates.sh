#!/bin/bash
# 在云服务器上部署更新通道目录 + nginx（与 store-saas/deploy.sh 同机）
set -euo pipefail
SRC=/tmp/mtnode-updates-upload
DEST=/var/www/html/mtnode/updates
mkdir -p "$DEST"
if [[ -d "$SRC" ]]; then
  rsync -a --delete "$SRC/" "$DEST/"
  echo "synced updates → $DEST"
  ls -lah "$DEST" | head -n 30
else
  echo "no $SRC — only patching nginx"
fi
if [[ -f "$SRC/patch-nginx-updates.py" ]]; then
  python3 "$SRC/patch-nginx-updates.py"
elif [[ -f /tmp/mtnode-updates-upload/patch-nginx-updates.py ]]; then
  python3 /tmp/mtnode-updates-upload/patch-nginx-updates.py
fi
nginx -t
systemctl reload nginx
echo "probe: $(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/mtnode/updates/latest.yml || true)"

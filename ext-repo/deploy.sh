#!/bin/bash
set -euo pipefail
SRC=/tmp/mtnode-ext-upload
DEST=/var/www/mtnode/ext
mkdir -p "$DEST"
if [ -f "$SRC/patch-nginx.py" ]; then
  python3 "$SRC/patch-nginx.py"
fi
# Replace tree contents but keep DEST itself.
find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$SRC/." "$DEST/"
rm -f "$DEST/patch-nginx.py" "$DEST/deploy.sh"
nginx -t
systemctl reload nginx
sleep 0.5
echo "ext: $(curl -sS -o /tmp/ext-cat.json -w '%{http_code}' -H 'Host: mt-agent.com' http://127.0.0.1/mtnode/ext/catalog.json)"

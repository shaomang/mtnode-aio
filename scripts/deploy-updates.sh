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

# Range 自检：electron-updater 的差分下载全靠 206，拿不到就整包下载（170MB）。
# 走 localhost + --resolve，验的是这台机器上刚改完的 vhost 与 TLS，不打外网。
# -L：/mtnode/updates/ 默认 302 到 OSS（本机出口带宽只有 ~100 Mbps），
# 跟着跳过去之后最后一段必须是 206，且跳过去的地址是桶而不是本站。
EXE="$(ls -1t "$DEST"/MTNodeAIO-Setup-*.exe 2>/dev/null | head -n 1 || true)"
if [[ -n "$EXE" ]]; then
  read -r CODE VER <<<"$(curl -sS -k -L --resolve www.mt-agent.com:443:127.0.0.1 -o /dev/null \
    -w '%{http_code} %{http_version}' -r 0-1023 \
    "https://www.mt-agent.com/mtnode/updates/$(basename "$EXE")" || true)"
  echo "range probe: $CODE http/$VER  (expect 206 after redirects)"
  if [[ "$CODE" != "206" ]]; then
    echo "FAIL: Range 没有 206 -> 差分更新会退化成整包下载，请回滚 nginx 配置"
    exit 1
  fi
  [[ "$VER" == "2" ]] || echo "WARN: 还是 HTTP/$VER，确认 listen 443 ... http2 已生效并 reload 过"
fi

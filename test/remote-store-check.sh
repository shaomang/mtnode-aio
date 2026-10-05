#!/bin/bash
# 线上 store-saas 多版本自检（只读）——在服务器上跑：ssh mtnode-store 'bash -s' < test/remote-store-check.sh
set -uo pipefail
echo "== /api/health（appVersions / apps / recharge）"
curl -sS http://127.0.0.1:8787/api/health | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("  appVersions =", d.get("appVersions"))
print("  apps        =", d.get("apps"))
print("  recharge.open =", (d.get("recharge") or {}).get("open"))'
echo "== 应用列表与版本树（逐条）"
curl -sS http://127.0.0.1:8787/api/apps | python3 -c 'import json,sys
d=json.load(sys.stdin)
for a in (d.get("apps") or d.get("items") or []):
    print("  -", a.get("id"), "version=", a.get("version"), "latestVersion=", a.get("latestVersion"), "versions=", len(a.get("versions") or []))'
for id in $(curl -sS http://127.0.0.1:8787/api/apps | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(" ".join([a.get("id") for a in (d.get("apps") or d.get("items") or [])]))'); do
  echo "== GET /api/apps/$id/versions"
  curl -sS "http://127.0.0.1:8787/api/apps/$id/versions" | head -c 400; echo
  echo "== GET /api/apps/$id/file（下载这条最新版，只看状态与版本号）"
  curl -sS "http://127.0.0.1:8787/api/apps/$id/file" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("  ok =", d.get("ok"), "version =", d.get("version"), "zipUrl =", d.get("zipUrl"), "bytes =", d.get("bytes"))' 2>&1 | head -3
done
echo "== 静态目录里的每一版包（应为 200）"
curl -sS https://www.mt-agent.com/mtnode/apps/catalog.json | python3 -c 'import json,sys
d=json.load(sys.stdin)
for e in (d.get("apps") or []):
    for rel in [e.get("zipUrl") or ""] + [v.get("zipUrl") or "" for v in (e.get("versions") or [])]:
        if rel: print(rel)' | sort -u | while read -r rel; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "https://www.mt-agent.com/mtnode/apps/$rel")
  echo "  $code  $rel"
done
echo "== 开关落点（环境文件里是否显式写了 MTNODE_APP_VERSIONS）"
if [ -f /etc/mtnode-store.env ]; then
  grep -n 'MTNODE_APP_VERSIONS' /etc/mtnode-store.env || echo "  （未显式写 = 跟随代码默认：开）"
fi
echo "== 部署文件与运行中的版本是否一致"
md5sum /opt/mtnode-store/server.mjs /opt/mtnode-store/deploy.sh 2>/dev/null
systemctl is-active mtnode-store

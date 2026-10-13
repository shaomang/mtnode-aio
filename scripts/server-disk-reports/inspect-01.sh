set -u
R=/root/mtnode-disk-cleanup-20261014-010649
echo "=== 备份目录 ==="
ls -la "$R"
echo "=== manifest 条目 ==="
python3 - "$R/manifest.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for i in d["items"]:
    print("%-22s %-8s %s" % (i["id"], i["status"], i["path"]))
print("failures:", d.get("failures"))
PY
echo "=== 备份内容 ==="
find "$R/backup" -maxdepth 8 | head -60
echo "=== 备份体积 ==="
du -sh "$R"
echo "=== 当前 vscode servers ==="
ls -la /root/.vscode-server/cli/servers
echo "=== code-* 目录 ==="
ls -d /root/.vscode-server/code-* 2>/dev/null
echo "=== npm cacache ==="
du -sh /root/.npm/_cacache 2>/dev/null
echo "=== apt lists / cache ==="
du -sh /var/lib/apt/lists /var/cache/apt
echo "=== df ==="
df -h / | tail -1

set -u
echo "=== 1) df 根分区 ==="
df -h /
echo "=== 2) 备份目录占用 ==="
du -sh /root/mtnode-disk-cleanup-20261014-010649
du -sh /root/mtnode-disk-cleanup-20261014-010649/backup/* 2>/dev/null
echo "=== 3) 清理项前后（当前值） ==="
du -sh /root/.vscode-server /root/.npm/_cacache /var/lib/apt/lists /var/cache/apt /tmp /var/log/journal /opt/mtnode-store/data 2>/dev/null
echo "--- 目录是否已不在 ---"
for p in /root/mt-ai-router /root/.npm/_cacache; do [ -e "$p" ] && echo "存在: $p" || echo "已不在: $p"; done
echo "--- vscode servers 只剩在跑版本 ---"
ls -1 /root/.vscode-server/cli/servers
echo "--- code-* 目录 ---"
ls -d /root/.vscode-server/code-* 2>/dev/null || echo "无 code-* 目录"
echo "=== 4) journald 与保留策略 ==="
journalctl --disk-usage
cat /etc/systemd/journald.conf.d/10-mtnode-retention.conf
grep -n 'rotate' /etc/logrotate.d/nginx | head -3
echo "=== 5) nginx / 服务状态 ==="
nginx -t 2>&1
systemctl is-active nginx mtnode-store systemd-journald ssh vaproj-backend
systemctl is-active mt-ai-router-mongod; ss -lntp | grep 27017 || echo "27017 无监听"
echo "=== 6) sshd ==="
sshd -t && echo "sshd -t OK"; sshd -T | grep -i loglevel
echo "=== 7) 站内 HTTP ==="
for u in https://www.mt-agent.com/mtnode/h3/manifest.json https://www.mt-agent.com/mtnode/music3/manifest.json https://www.mt-agent.com/mtnode/store-api/api/health; do
  printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' -m 15 -k "$u"
done
echo "=== 8) 业务数据只读比对 ==="
find /opt/mtnode-store/data -type f | wc -l
stat -c '%s %Y' /opt/mtnode-store/data/db.json
echo "=== 9) 备份里的清单与恢复脚本 ==="
ls -la /root/mtnode-disk-cleanup-20261014-010649/

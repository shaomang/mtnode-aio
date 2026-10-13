set -u
echo '=== 1) cron 是否已收录这份 cron.d（安装时刻的日志）==='
grep -i 'cron' /var/log/syslog 2>/dev/null | tail -8 || echo 'syslog 无 cron 记录'
echo '--- 再试 journalctl -u cron ---'
journalctl -u cron --no-pager -n 8 2>/dev/null || true
echo '=== 2) 最终态核对 ==='
ls -l /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check
sha256sum /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check
bash -n /usr/local/sbin/mtnode-disk-check.sh && echo 'bash -n OK'
echo '=== 3) 再跑一次常规路径（应跳过）==='
/usr/local/sbin/mtnode-disk-check.sh
echo "exit_code=$?"
tail -1 /var/log/mtnode-disk-check.log
echo '=== 4) 服务与站点终检 ==='
nginx -t 2>&1
systemctl is-active nginx mtnode-store systemd-journald ssh cron
sshd -t >/dev/null 2>&1 && echo 'sshd -t rc=0'
for u in https://www.mt-agent.com/mtnode/h3/manifest.json https://www.mt-agent.com/mtnode/music3/manifest.json https://www.mt-agent.com/mtnode/store-api/api/health; do
  printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' -m 15 -k "$u"
done
echo '=== 5) 业务数据只读终检（应 83 / 65262 1791906938）==='
find /opt/mtnode-store/data -type f | wc -l
stat -c '%s %Y' /opt/mtnode-store/data/db.json
echo '=== 6) df / 目录占用终态 ==='
df -h /
journalctl --disk-usage
du -sh /var/log/nginx /tmp /root/.npm 2>/dev/null || true

set -u
echo '=== 1) 运行前基线 ==='
df -h /
echo -n 'used_pct_now: '; df -P / | awk 'NR==2 {print $5}'
echo -n 'log_exists_before: '; ls -l /var/log/mtnode-disk-check.log 2>/dev/null || echo 'NOT-EXIST'
echo -n '/tmp entries: '; ls -1 /tmp | wc -l
echo -n '/tmp old(>30d) upload|archive: '
find /tmp -xdev -mindepth 1 -mtime +30 \( -type d \( -iname '*upload*' -o -iname '*dist*' \) -o -type f \( -iname '*.tgz' -o -iname '*.tar.gz' -o -iname '*.zip' -o -iname '*.gz' -o -iname '*.rar' -o -iname '*.7z' -size -200M \) \) 2>/dev/null | wc -l
echo -n 'npm_cacache_exists: '; test -d /root/.npm/_cacache && echo yes || echo no
echo -n 'journal_usage_before: '; journalctl --disk-usage
echo '=== 2) /tmp 快照（前 40 行，含 mtime）==='
ls -la --time-style=long-iso /tmp | head -40
echo '=== 3) journal 文件快照 ==='
ls -la /var/log/journal/*/ 2>/dev/null | head -20
echo '=== 4) nginx 日志快照 ==='
ls -la --time-style=long-iso /var/log/nginx/ 2>/dev/null
echo '=== 5) 手动运行脚本（当前低于阈值，应直接退出）==='
/usr/local/sbin/mtnode-disk-check.sh
echo "exit_code=$?"
echo '=== 6) 运行后：日志文件 ==='
ls -l /var/log/mtnode-disk-check.log 2>/dev/null || echo 'LOG-NOT-CREATED'
cat /var/log/mtnode-disk-check.log 2>/dev/null || true
echo '=== 7) 运行后：/tmp 未被动过 ==='
echo -n '/tmp entries: '; ls -1 /tmp | wc -l
ls -la --time-style=long-iso /tmp | head -40
echo '=== 8) 运行后：journal 未被动过 ==='
journalctl --disk-usage
echo '=== 9) 运行后：nginx 日志未被动过 ==='
ls -la --time-style=long-iso /var/log/nginx/ 2>/dev/null
echo '=== 10) 运行后：npm cache 未被动过 ==='
test -d /root/.npm/_cacache && echo 'npm_cacache: still-present' || echo 'npm_cacache: MISSING'
echo '=== 11) df 运行后 ==='
df -h /
echo '=== 12) cron 安装位与内容 ==='
ls -l /etc/cron.d/mtnode-disk-check
cat /etc/cron.d/mtnode-disk-check
echo -n 'cron_service_active: '; systemctl is-active cron 2>/dev/null || systemctl is-active crond 2>/dev/null || echo 'no-cron-service'
systemctl status cron --no-pager 2>/dev/null | head -5 || true

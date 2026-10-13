set -u
echo '=== 1) journald drop-in（最终内容）==='
cat /etc/systemd/journald.conf.d/10-mtnode-retention.conf
echo '=== 2) nginx logrotate rotate 行 ==='
grep -n 'rotate' /etc/logrotate.d/nginx
echo '=== 3) nginx 站点：access_log off 命中 ==='
grep -rn 'access_log off' /etc/nginx/sites-available/ | head -10
echo '=== 4) /mtnode/yue/ 反代现状 ==='
grep -n -A6 'mtnode/yue' /etc/nginx/sites-available/mt-ai-router.conf | head -30
echo '=== 5) sshd LogLevel ==='
grep -n '^LogLevel' /etc/ssh/sshd_config
echo '=== 6) vaproj drop-in ==='
cat /etc/systemd/system/vaproj-backend.service.d/10-mtnode-loglevel.conf 2>/dev/null || echo 'MISSING'
echo '=== 7) mongod 现状 ==='
systemctl is-active mt-ai-router-mongod; systemctl is-enabled mt-ai-router-mongod 2>&1 | head -1
ls -l /etc/systemd/system/mt-ai-router-mongod.service 2>/dev/null || echo 'unit 文件已不在（在备份里）'
which mongod
ss -lntp 2>/dev/null | grep 27017 || echo '27017 无监听'
echo '=== 8) 备份目录 ==='
ls -d /root/mtnode-disk-cleanup-* 2>/dev/null
du -sh /root/mtnode-disk-cleanup-* 2>/dev/null
ls -l /root/mtnode-disk-cleanup-20261014-010649/RESTORE.sh
echo '=== 9) df ==='
df -h /
echo '=== 10) 兜底脚本与 cron 最终态 ==='
ls -l /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check /var/log/mtnode-disk-check.log
sha256sum /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check
crontab -l 2>/dev/null | head -5 || echo '(root crontab 为空)'
echo '=== 11) 本机 cron 认不认这份 cron.d（日志佐证）==='
grep -i mtnode /var/log/syslog 2>/dev/null | tail -3 || echo '(syslog 里暂无 mtnode 记录，首跑在周一 04:30)'

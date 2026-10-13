set -u
echo '=== A) 清理判据的实际命中面（只列不删）==='
echo '--- A1 journal 侧当前占用 ---'
journalctl --disk-usage
echo '--- A2 logrotate 当前配置（rotate 份数 / 目标）---'
cat /etc/logrotate.d/nginx
echo '--- A3 /tmp 命中（>30 天 且 (upload|dist 目录 或 归档 <200M)）---'
find /tmp -xdev -depth -mindepth 1 -mtime +30 \( -type d \( -iname '*upload*' -o -iname '*dist*' \) -o -type f \( -iname '*.tgz' -o -iname '*.tar.gz' -o -iname '*.zip' -o -iname '*.gz' -o -iname '*.rar' -o -iname '*.7z' -size -200M \) \) 2>/dev/null | sort
echo '(以上为完整命中清单，供逐条核对)'
echo -n 'A3 hit count: '
find /tmp -xdev -depth -mindepth 1 -mtime +30 \( -type d \( -iname '*upload*' -o -iname '*dist*' \) -o -type f \( -iname '*.tgz' -o -iname '*.tar.gz' -o -iname '*.zip' -o -iname '*.gz' -o -iname '*.rar' -o -iname '*.7z' -size -200M \) \) 2>/dev/null | wc -l
echo '--- A4 npm cache ---'
test -d /root/.npm/_cacache && echo 'present' || echo 'absent(上一轮清理已搬走)'
echo '--- A5 nginx 日志文件数 / 体积（清理前基线）---'
ls -1 /var/log/nginx | wc -l
du -sh /var/log/nginx
echo '--- A6 logrotate -d 预演（只报不删）---'
logrotate -d /etc/logrotate.d/nginx 2>&1 | grep -E 'rotating|removing|considering|Renaming|log needs' | head -20
echo '=== B) 强制清理预演：把阈值临时设为 0 跑一次（真正执行清理）==='
echo '(先记下将被动到的具体文件)'
ls -1 /var/log/nginx | sort > /tmp/task3-nginx-before.txt
cat /tmp/task3-nginx-before.txt
echo '--- B1 执行 MN_DISK_THRESHOLD=0 /usr/local/sbin/mtnode-disk-check.sh ---'
MN_DISK_THRESHOLD=0 /usr/local/sbin/mtnode-disk-check.sh
echo "exit_code=$?"
echo '=== C) 清理后核对 ==='
echo '--- C1 日志行 ---'
tail -3 /var/log/mtnode-disk-check.log
echo '--- C2 journal 占用 ---'
journalctl --disk-usage
echo '--- C3 nginx 日志文件数 / 体积 / 清单 ---'
ls -1 /var/log/nginx | wc -l
du -sh /var/log/nginx
ls -1 /var/log/nginx | sort
echo '--- C4 相对基线新增/消失的文件 ---'
ls -1 /var/log/nginx | sort > /tmp/task3-nginx-after.txt
echo '[only-before]'; comm -23 /tmp/task3-nginx-before.txt /tmp/task3-nginx-after.txt
echo '[only-after]'; comm -13 /tmp/task3-nginx-before.txt /tmp/task3-nginx-after.txt
echo '--- C5 nginx 是否仍健康（清理后）---'
nginx -t 2>&1
systemctl is-active nginx mtnode-store systemd-journald ssh vaproj-backend
for u in https://www.mt-agent.com/mtnode/h3/manifest.json https://www.mt-agent.com/mtnode/music3/manifest.json https://www.mt-agent.com/mtnode/store-api/api/health; do
  printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' -m 15 -k "$u"
done
echo '--- C6 业务数据只读复核（应与开工前后一致：83 文件 / db.json 65262）---'
find /opt/mtnode-store/data -type f | wc -l
stat -c '%s %Y' /opt/mtnode-store/data/db.json
echo '--- C7 重复运行（幂等）---'
MN_DISK_THRESHOLD=0 /usr/local/sbin/mtnode-disk-check.sh
echo "second_exit_code=$?"
tail -2 /var/log/mtnode-disk-check.log
echo '--- C8 非强制路径仍应跳过（阈值 80）---'
/usr/local/sbin/mtnode-disk-check.sh
echo "skip_exit_code=$?"
tail -1 /var/log/mtnode-disk-check.log
echo '--- C9 df ---'
df -h /

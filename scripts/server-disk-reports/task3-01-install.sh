set -u
echo '--- 0) 时间与时区 ---'
date
timedatectl 2>/dev/null | head -4 || true
echo '--- 1) 上传落地 ---'
ls -l /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check
echo '--- 2) 权限与属主 ---'
chmod 0755 /usr/local/sbin/mtnode-disk-check.sh
chmod 0644 /etc/cron.d/mtnode-disk-check
chown root:root /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check
ls -l /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check
echo '--- 3) sha256 ---'
sha256sum /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check
echo '--- 4) 纯 ASCII 校验 ---'
for f in /usr/local/sbin/mtnode-disk-check.sh /etc/cron.d/mtnode-disk-check; do
  c=$(LC_ALL=C tr -d '\000-\177' < "$f" | wc -c)
  echo "non-ascii-bytes $f = $c"
done
echo '--- 5) 语法检查 ---'
bash -n /usr/local/sbin/mtnode-disk-check.sh && echo 'bash -n OK'
echo '--- 6) df 现状 ---'
df -h /

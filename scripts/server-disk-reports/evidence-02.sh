set -u
echo "=== sshd 配置生效与授权 ==="
sshd -T >/dev/null && echo "sshd -T rc=0 (配置可加载)"
sshd -t >/dev/null && echo "sshd -t rc=0"
echo -n "authorized_keys 行数: "; wc -l < /root/.ssh/authorized_keys
echo -n "authorized_keys 指纹: "; sha256sum /root/.ssh/authorized_keys | cut -c1-16
grep -n '^LogLevel' /etc/ssh/sshd_config
echo "=== 当前 ssh 会话（说明登录未断） ==="
ss -tnp 2>/dev/null | grep -c ':22 ' || true
echo "=== nginx 反代脚手架端点（本地直连） ==="
for p in /mtnode/h3/manifest.json /mtnode/music3/manifest.json /mtnode/store-api/api/health; do
  printf '127.0.0.1%s -> ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' -m 10 "http://127.0.0.1$p"
done
echo "=== 备份目录内已搬走的路径清单（前 12 条） ==="
find /root/mtnode-disk-cleanup-20261014-010649/backup -maxdepth 4 -mindepth 1 \( -type f -o -type d \) -printf '%y %p\n' 2>/dev/null | awk 'NR<=12'
echo "=== mongod 二进制仍在（只是服务停用，可按需恢复） ==="
which mongod; systemctl is-enabled mt-ai-router-mongod 2>&1 | head -2
ls /etc/systemd/system/mt-ai-router*.service 2>/dev/null

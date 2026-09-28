#!/bin/bash
set -euo pipefail
SRC=/tmp/mtnode-store-upload
mkdir -p /opt/mtnode-store/data/files /opt/mtnode-store/data/skills /opt/mtnode-store/data/previews /opt/mtnode-store/data/forum-images
# 应用市场：记录进 db.json 的 apps[]，zip / 图标落这两个目录
mkdir -p /opt/mtnode-store/data/apps /opt/mtnode-store/data/app-icons
mkdir -p /var/www/mtnode/plugins
mkdir -p /var/www/mtnode/apps/icons
install -m 644 "$SRC/server.mjs" /opt/mtnode-store/server.mjs
install -m 644 "$SRC/sms-provider.mjs" /opt/mtnode-store/sms-provider.mjs
install -m 644 "$SRC/account-store.mjs" /opt/mtnode-store/account-store.mjs
install -m 644 "$SRC/migrate-accounts.mjs" /opt/mtnode-store/migrate-accounts.mjs
install -m 644 "$SRC/package.json" /opt/mtnode-store/package.json
install -m 644 "$SRC/mtnode-store.service" /etc/systemd/system/mtnode-store.service
# 充值 / 钱包：订单与流水模块、支付宝当面付、二维码编码（服务端自绘 SVG，零依赖）、
# 微信归属迁移运维脚本（人工跑，见 docs/recharge-design.md §归属迁移）
install -m 644 "$SRC/wallet.mjs" /opt/mtnode-store/wallet.mjs
install -m 644 "$SRC/alipay-provider.mjs" /opt/mtnode-store/alipay-provider.mjs
# 应用密钥对生成器（人工跑：node alipay-keygen.mjs --appid … --print env；私钥只落 /etc/mtnode-store/alipay）
install -m 644 "$SRC/alipay-keygen.mjs" /opt/mtnode-store/alipay-keygen.mjs
# 通道只读探针（人工跑：set -a && . /etc/mtnode-store.env && set +a && node alipay-probe.mjs）：
# 用真实应用私钥签名去问网关，列出「哪些支付产品已签约」——控制台看不到接口权限，
# 而 configured:true 只代表密钥齐全，真下单才会撞 ACQ.ACCESS_FORBIDDEN。
install -m 644 "$SRC/alipay-probe.mjs" /opt/mtnode-store/alipay-probe.mjs
install -m 644 "$SRC/qr-encode.mjs" /opt/mtnode-store/qr-encode.mjs
install -m 644 "$SRC/migrate-wechat-owner.mjs" /opt/mtnode-store/migrate-wechat-owner.mjs
# 管理台（独立界面，站点不设入口，仅微信扫码 + 白名单账号可登录）：
#   · /opt/mtnode-store/admin  → 服务自身 GET /admin/ 用（本机 curl 自检与兜底）
#   · /var/www/mtnode/admin    → nginx 静态目录，对外走 https://mt-agent.com/mtnode/admin/
install -d -m 755 /opt/mtnode-store/admin /var/www/mtnode/admin
if [ -d "$SRC/admin" ]; then
  for f in "$SRC"/admin/*; do
    [ -f "$f" ] || continue
    install -m 644 "$f" "/opt/mtnode-store/admin/$(basename "$f")"
    install -m 644 "$f" "/var/www/mtnode/admin/$(basename "$f")"
  done
fi
# 支付同步跳回页（return_url）：nginx 静态目录，站点无入口、noindex、不参与入账
install -d -m 755 /var/www/mtnode/pay-done
if [ -d "$SRC/pay-done" ]; then
  for f in "$SRC"/pay-done/*; do
    [ -f "$f" ] || continue
    install -m 644 "$f" "/var/www/mtnode/pay-done/$(basename "$f")"
  done
fi
if [ -f "$SRC/seed-skills.mjs" ]; then
  install -m 644 "$SRC/seed-skills.mjs" /opt/mtnode-store/seed-skills.mjs
fi
if [ -f "$SRC/catalog.json" ]; then
  install -m 644 "$SRC/catalog.json" /var/www/mtnode/plugins/catalog.json
fi
shopt -s nullglob
for z in "$SRC"/*.zip; do
  install -m 644 "$z" "/var/www/mtnode/plugins/$(basename "$z")"
done
shopt -u nullglob
# 应用目录静态清单与 zip / 图标：客户端读 http://mt-agent.com/mtnode/apps/catalog.json，
# 条目里的 zipUrl / icon 相对本目录（<id>.zip / icons/<id>.png），所以包也放这里。
if [ -f "$SRC/apps/catalog.json" ]; then
  install -m 644 "$SRC/apps/catalog.json" /var/www/mtnode/apps/catalog.json
fi
shopt -s nullglob
for z in "$SRC"/apps/*.zip; do
  install -m 644 "$z" "/var/www/mtnode/apps/$(basename "$z")"
done
for f in "$SRC"/apps/icons/*; do
  [ -f "$f" ] || continue
  install -m 644 "$f" "/var/www/mtnode/apps/icons/$(basename "$f")"
done
shopt -u nullglob
python3 "$SRC/patch-nginx.py"
nginx -t
systemctl daemon-reload
systemctl enable mtnode-store
systemctl restart mtnode-store
systemctl reload nginx
# 重启后端口不是立刻就绪（实测要 ~13s：Tablestore 拉全量 users/sessions/identities），
# 只 sleep 0.8 会让 curl 报 (7)、自检行整条变空/假失败 —— 这里静默轮询等它监听，最多 30s。
for _i in $(seq 1 60); do
  if curl -s -o /dev/null http://127.0.0.1:8787/api/health 2>/dev/null; then break; fi
  sleep 0.5
done
# 自检一律走 www 的 https 真实 URL：nginx 里有 `if ($host = mt-agent.com) { return 301 https://www.mt-agent.com$request_uri; }`，
# 用 -H 'Host: mt-agent.com' 打 http://127.0.0.1 会让**每一行**都变 301（踩过：管理台明明已上线却误报 WRONG-PAGE）。
BASE="https://www.mt-agent.com"
code() { curl -sS -o /tmp/deploy-chk.out -w '%{http_code}' "$1" || echo "curl-fail"; }
echo "local: $(curl -sS http://127.0.0.1:8787/api/health)"
echo "proxy: $(curl -sS $BASE/mtnode/store-api/api/health)"
echo "plugins: $(code $BASE/mtnode/plugins/catalog.json)"
echo "apps-catalog: $(code $BASE/mtnode/apps/catalog.json)"
echo "apps-api: $(code $BASE/mtnode/store-api/api/apps)"
echo "forum: $(code $BASE/mtnode/store-api/api/forum/topics)"
# 管理台与充值通道的部署自检：静态页要 200 **且**内容真是管理台（只看状态码会漏掉
# 「location 没生效 → 落到 location ~ ^/mtnode/(.*)$ 的 OSS 反代 → 返回下载页首页 200」这一类事故），
# /mtnode/admin（无斜杠）要 301/302 到带斜杠，支付宝状态只回「配好没配好 + 缺哪些 env」，不带凭据内容。
ADMIN_BODY=$(curl -sS $BASE/mtnode/admin/)
if printf '%s' "$ADMIN_BODY" | grep -q 'MTNode 管理平台'; then
  ADMIN_VERDICT="ok"
else
  ADMIN_VERDICT="WRONG-PAGE（返回的不是管理台：patch-nginx 的 /mtnode/admin/ location 没生效，被 OSS 反代兜底了）"
fi
echo "admin-page: $(code $BASE/mtnode/admin/) $ADMIN_VERDICT"
echo "admin-slash: $(curl -sS -o /dev/null -w '%{http_code} -> %{redirect_url}' $BASE/mtnode/admin)"
echo "admin-assets: css=$(code $BASE/mtnode/admin/admin.css) js=$(code $BASE/mtnode/admin/admin.js)"
# 扫码登录自检：管理页 CSP 的 frame-src 必须放行「qrconnect + 微信回调域两跳（apex 与 www）」。
# 少放行时浏览器在发请求之前就拦掉 iframe 回跳 → 服务端一次 callback 都收不到 → 没有 ticket →
# 轮询 pending 到设备码过期（线上踩过，用户报「admin 扫码后无效」，nginx 日志里只有 poll）。
# 只认 CSP meta 那一行：页面注释里也会出现「frame-src」这个词（讲这个坑），
# 直接 grep 全文会先命中注释 → 误报 BAD（本机复现过）。
CSP_META=$(printf '%s' "$ADMIN_BODY" | grep -o 'http-equiv="Content-Security-Policy" content="[^"]*"' | head -1)
FRAME_SRC=$(printf '%s' "$CSP_META" | grep -o 'frame-src[^;"]*')
FRAME_OK=1
[ -n "$CSP_META" ] || FRAME_OK=0
for _o in https://open.weixin.qq.com https://mt-agent.com https://www.mt-agent.com; do
  printf '%s' "$FRAME_SRC" | grep -q "$_o" || FRAME_OK=0
done
if [ "$FRAME_OK" = "1" ]; then
  echo "admin-login-frame: ok（frame-src 放行 qrconnect + 回调域两跳）"
elif [ -z "$CSP_META" ]; then
  echo "admin-login-frame: BAD（线上页面没有 CSP meta：返回的可能根本不是管理台）"
else
  echo "admin-login-frame: BAD（线上 frame-src='$FRAME_SRC' 少放行 qrconnect 或回调域 → 扫码后回跳被 CSP 拦掉 = 扫码无效；改 MTNODE_WECHAT_REDIRECT 域名时要同步改 admin/index.html）"
fi
# 支付通道自检：configured 必须为 true，且 gatewayWarning 必须为空。
# 网关写成 /router/rest（网页端地址）时不会报错，而是所有接口都 302 到 auth.alipay.com 登录页
# —— 线上实测踩过，表现是「配置齐全但一下单就 HTTP 302」，所以这里直接判死。
PAY_BODY=$(curl -sS $BASE/mtnode/store-api/api/pay/alipay/status)
echo "pay-status: $PAY_BODY"
if printf '%s' "$PAY_BODY" | grep -q '"configured":true'; then
  if printf '%s' "$PAY_BODY" | grep -q '"gatewayWarning":""'; then
    echo "pay-gateway: ok（configured=true，网关体检无告警）"
  else
    echo "pay-gateway: BAD（gatewayWarning 非空 → 照提示改 MTNODE_ALIPAY_GATEWAY，否则下单/查单一律 HTTP 302）"
  fi
else
  echo "pay-config: 未配齐（missing 见上行）→ 客户端显示「通道未配置」并禁用付款，不留假支付路径"
fi
# 通道与跳回页自检：默认通道是 page（电脑网站支付），付完款浏览器要能跳回 /mtnode/pay-done/。
# 只认页面内容（「支付完成」），因为 /mtnode/ 整段有 OSS 反代兜底，200 也可能是下载页。
if printf '%s' "$PAY_BODY" | grep -q '"channel":"precreate"'; then
  echo "pay-channel: precreate（当面付·窗内扫码）→ 需已签约当面付，否则下单回 ACQ.ACCESS_FORBIDDEN"
else
  echo "pay-channel: page（电脑网站支付·浏览器收银台）"
  DONE_BODY=$(curl -sS $BASE/mtnode/pay-done/)
  DONE_CODE=$(code $BASE/mtnode/pay-done/)
  if [ "$DONE_CODE" = "200" ] && printf '%s' "$DONE_BODY" | grep -q '支付完成'; then
    echo "pay-return-page: 200 ok"
  else
    echo "pay-return-page: BAD（$DONE_CODE，内容不是回执页 → return_url 会跳到 OSS 下载页；检查 /var/www/mtnode/pay-done/ 与 nginx location）"
  fi
  if printf '%s' "$PAY_BODY" | grep -q '"hasReturnUrl":true'; then
    echo "pay-return-env: ok（MTNODE_ALIPAY_RETURN_URL 已配）"
  else
    echo "pay-return-env: 未配 MTNODE_ALIPAY_RETURN_URL → 付完停在支付宝成功页（不影响入账，但用户不确定充上没）"
  fi
fi
systemctl is-active mtnode-store

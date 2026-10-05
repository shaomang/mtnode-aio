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
# 打赏（鲸圆币）+ 评论 + 消息：被 server.mjs import（漏传即 Cannot find module './tips.mjs'），
# 编排逻辑分别在 tips.mjs（打赏，只经 wallet.adjustBalance 动钱）、comments.mjs（评论 / 五星评分）
# 与 notifications.mjs（消息 / 通知，只落 db.notifications，绝不碰钱包）。
install -m 644 "$SRC/tips.mjs" /opt/mtnode-store/tips.mjs
install -m 644 "$SRC/comments.mjs" /opt/mtnode-store/comments.mjs
install -m 644 "$SRC/notifications.mjs" /opt/mtnode-store/notifications.mjs
install -m 644 "$SRC/alipay-provider.mjs" /opt/mtnode-store/alipay-provider.mjs
# 应用密钥对生成器（人工跑：node alipay-keygen.mjs --appid … --print env；私钥只落 /etc/mtnode-store/alipay）
install -m 644 "$SRC/alipay-keygen.mjs" /opt/mtnode-store/alipay-keygen.mjs
# 通道只读探针（人工跑：set -a && . /etc/mtnode-store.env && set +a && node alipay-probe.mjs）：
# 用真实应用私钥签名去问网关，列出「哪些支付产品已签约」——控制台看不到接口权限，
# 而 configured:true 只代表密钥齐全，真下单才会撞 ACQ.ACCESS_FORBIDDEN。
install -m 644 "$SRC/alipay-probe.mjs" /opt/mtnode-store/alipay-probe.mjs
install -m 644 "$SRC/qr-encode.mjs" /opt/mtnode-store/qr-encode.mjs
install -m 644 "$SRC/migrate-wechat-owner.mjs" /opt/mtnode-store/migrate-wechat-owner.mjs
# 中转站（内置内部测试入口：DeepSeek 文本/识图 + gpt-image-2.5 图像，鉴权 = 账号登录 token，
# 门禁 = 可用余额 > 0，按用量扣费）。上游 Key 只走 /etc/mtnode-store.env，代码里没有 Key。
#   · relay.mjs      —— 中转站本体，由 server.mjs require（缺它会 Cannot find module './relay.mjs'）
#   · relay-key.mjs  —— 人工发放中转 Key（= 账号登录 token）：node relay-key.mjs --user <用户名>
install -m 644 "$SRC/relay.mjs" /opt/mtnode-store/relay.mjs
install -m 644 "$SRC/relay-key.mjs" /opt/mtnode-store/relay-key.mjs
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
#
# **绝不用仓库里的空模板覆盖线上目录**（踩过：模板 apps:[] → 线上 120 字节空目录 →
# 客户端「应用库未连入云端」）。口径：
#   · 线上已存在 catalog.json → 原样保留（下一次服务重启会由 server.mjs 刷成库里的真实状态）；
#   · 不存在 → 不放占位空清单，交给 server.mjs 的启动发布（data/apps 有包才会写目录）。
if [ -f /var/www/mtnode/apps/catalog.json ]; then
  echo "apps-catalog-static: 保留线上已有目录（不用仓库模板覆盖）"
elif [ -f "$SRC/apps/catalog.json" ]; then
  echo "apps-catalog-static: 线上没有目录，且本次上传带目录 → 装它"
  install -m 644 "$SRC/apps/catalog.json" /var/www/mtnode/apps/catalog.json
else
  echo "apps-catalog-static: 线上没有目录 → 交给 server.mjs 启动发布（data/apps 有包才会写）"
fi
# 上传包里的 zip / 图标仍照静态布局装进去（有就用上传的，没有就等 server.mjs 发布）。
shopt -s nullglob
for z in "$SRC"/apps/*.zip; do
  install -m 644 "$z" "/var/www/mtnode/apps/$(basename "$z")"
done
# 多版本：catalog 的 versions[].zipUrl = <id>/<version>.zip，所以 apps/<id>/ 子目录也要装进去
# （upload.py 递归上传 apps/）。icons 是图标目录，不能当成某个应用的版本目录。
for d in "$SRC"/apps/*/; do
  [ -d "$d" ] || continue
  _app="$(basename "$d")"
  if [ "$_app" = "icons" ]; then
    continue
  fi
  mkdir -p "/var/www/mtnode/apps/$_app"
  for f in "$d"*.zip; do
    [ -f "$f" ] || continue
    install -m 644 "$f" "/var/www/mtnode/apps/$_app/$(basename "$f")"
  done
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
# 静态目录收尾：服务重启时 server.mjs 已按库里真实状态发布过一次（含 zip / 图标）；
# 这里再从**本机**拉一次真实清单原样落盘，并做「条数 + 包可达」自检 ——
# 就是这一步在以前是人工手动跑的（docs/apps-market.md 旧第②步），漏跑就整个应用库断云端。
curl -sS http://127.0.0.1:8787/api/apps/catalog -o /tmp/deploy-apps-catalog.json 2>/dev/null || true
if python3 - "$SRC" <<'PY' 2>&1
import json, os, shutil, sys
src = sys.argv[1]
try:
    with open("/tmp/deploy-apps-catalog.json", "r", encoding="utf-8") as f:
        doc = json.load(f)
except Exception as e:
    print("apps-static-write: BAD（本机 /api/apps/catalog 不是合法 JSON：%s）" % e)
    sys.exit(0)
if not isinstance(doc, dict) or not isinstance(doc.get("apps"), list):
    print("apps-static-write: BAD（本机 /api/apps/catalog 结构不对）")
    sys.exit(0)
cat = "/var/www/mtnode/apps/catalog.json"
os.makedirs("/var/www/mtnode/apps/icons", exist_ok=True)
with open(cat, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
for e in doc["apps"]:
    _id = e.get("id")
    if not _id:
        continue
    for rel, sdir in (("{0}.zip".format(_id), "apps"), ("icons/{0}".format(os.path.basename(e.get("icon") or "")), "apps/icons")):
        s = os.path.join(src, sdir, os.path.basename(rel))
        d = os.path.join("/var/www/mtnode/apps", rel)
        if os.path.isfile(s) and not os.path.isfile(d):
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copyfile(s, d)
print("apps-static-write: ok（由本机接口清单落盘，条数={0}）".format(len(doc["apps"])))
PY
then
  :
fi
# 自检一律走 www 的 https 真实 URL：nginx 里有 `if ($host = mt-agent.com) { return 301 https://www.mt-agent.com$request_uri; }`，
# 用 -H 'Host: mt-agent.com' 打 http://127.0.0.1 会让**每一行**都变 301（踩过：管理台明明已上线却误报 WRONG-PAGE）。
BASE="https://www.mt-agent.com"
code() { curl -sS -o /tmp/deploy-chk.out -w '%{http_code}' "$1" || echo "curl-fail"; }
echo "local: $(curl -sS http://127.0.0.1:8787/api/health)"
echo "proxy: $(curl -sS $BASE/mtnode/store-api/api/health)"
echo "plugins: $(code $BASE/mtnode/plugins/catalog.json)"
echo "apps-catalog: $(code $BASE/mtnode/apps/catalog.json)"
echo "apps-api: $(code $BASE/mtnode/store-api/api/apps)"
# 多版本自检：catalog 的 versions[].zipUrl = <id>/<version>.zip，静态目录里必须真有它
# （少装一层目录时客户端按旧版安装「明明有新版却说已是最新」）。
_ver_zip=""
for f in "$SRC"/apps/*/*.zip; do
  [ -f "$f" ] || continue
  _ver_zip="$f"
  break
done
if [ -n "$_ver_zip" ]; then
  _ver_rel="${_ver_zip#"$SRC"/apps/}"
  echo "apps-version: $(code $BASE/mtnode/apps/$_ver_rel)  ($_ver_rel)"
else
  echo "apps-version: （本次上传里没有多版本包 <id>/<version>.zip，跳过）"
fi
# 应用目录深度自检：只看状态码会漏掉「120 字节空目录 + 包 404」这类无声事故
# （线上目录被部署链刷空过、包里一个应用都没有 —— 客户端表现为「应用库未连入云端」）。
# 这里把条数、包 / 图标可达性直接判死，并顺带做一份「本地静态目录 vs 接口」的一致性对照。
CAT_BODY=$(curl -sS "$BASE/mtnode/apps/catalog.json")
CAT_APPS=$(printf '%s' "$CAT_BODY" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(len(d.get("apps") or []))
except Exception:
    print("bad-json")')
echo "apps-catalog: $(code $BASE/mtnode/apps/catalog.json) · 条数=$CAT_APPS"
if [ "$CAT_APPS" = "bad-json" ]; then
  echo "apps-static: BAD（线上 catalog.json 不是合法 JSON → 客户端整库读不到）"
elif [ "$CAT_APPS" = "0" ]; then
  echo "apps-static: WARN（静态目录 0 条；云端确实没有应用时正常，否则检查 GET /api/apps/pub 的 fallback 与 server.mjs 启动日志）"
fi
if [ "$CAT_APPS" != "bad-json" ] && [ "$CAT_APPS" != "0" ]; then
  # 多版本目录自检：**每一个** versions[].zipUrl 都要可达（开关打开后客户端只按它取包）。
  printf '%s' "$CAT_BODY" | python3 -c 'import json,sys
d=json.load(sys.stdin)
n=0
for e in (d.get("apps") or []):
    for v in (e.get("versions") or []):
        if v.get("zipUrl"):
            n+=1
print("apps-catalog-versions: {0} 项 versions[].zipUrl（多版本口径；0 项 = 全部老单版记录）".format(n))' 2>/dev/null || echo "apps-catalog-versions: （目录解析失败，见上行 apps-static）"
  printf '%s' "$CAT_BODY" | python3 -c 'import json,sys
BASE="https://www.mt-agent.com/mtnode/apps"
d=json.load(sys.stdin)
bad=[]
for e in (d.get("apps") or []):
    for rel in [e.get("zipUrl") or ""] + [v.get("zipUrl") or "" for v in (e.get("versions") or [])] + [e.get("icon") or ""]:
        if rel:
            print(rel)
' | sort -u | while read -r _rel; do
    [ -n "$_rel" ] || continue
    _rc=$(code "$BASE/$_rel")
    case "$_rc" in
      200) echo "apps-file: 200 ok  $_rel" ;;
      *) echo "apps-file: BAD（$_rc）$_rel ← 目录里声明了但静态目录里拿不到，客户端会装不上 / 图标破图" ;;
    esac
  done
fi
# 接口侧体检（server.mjs 的静态目录发布闸）：ok=false 就说明 /var/www/mtnode/apps 写不进去
PUB_BODY=$(curl -sS $BASE/mtnode/store-api/api/apps/pub)
echo "apps-pub: $PUB_BODY"
if printf '%s' "$PUB_BODY" | grep -q '"fallback":true'; then
  echo "apps-pub: BAD（静态目录发布失败 → 客户端已降级走接口目录；按日志修目录权限或 MTNODE_APPS_WEB_DIR）"
fi
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
# 充值闸门自检：`recharge.open` 必须为 true —— 充值对所有已注册账号开放（名单口径已作废，
# 只剩一个显式的全局关闭开关 MTNODE_RECHARGE_CLOSED）。false 时非白名单账号会撞
# 403 RECHARGE_NOT_OPEN（用户读到「充值功能尚未对该账号开放」），去环境文件里清掉那个开关。
HEALTH_BODY=$(curl -sS http://127.0.0.1:8787/api/health)
# 多版本开关自检：`/api/health` 的 appVersions 必须是 true。关着时作者点「上传新版本（追加版本）」
# 会撞 409 APP_VERSIONS_DISABLED，而客户端只把服务端那句中文原样显示给用户
# （线上踩过：开关从没打开过，「服务端未启用应用多版本」一直挂着）。
# 开关默认开，只有 /etc/mtnode-store.env 里显式写了 0/false/no/off 才关 —— 命中就报 BAD 并给出改法。
if printf '%s' "$HEALTH_BODY" | grep -q '"appVersions":true'; then
  echo "apps-versions-gate: ok（多版本开启：一版一包 <id>/<version>.zip + 最新版镜像）"
else
  echo "apps-versions-gate: BAD（appVersions != true → 检查 /etc/mtnode-store.env 的 MTNODE_APP_VERSIONS，去掉该项或设 1 后 systemctl restart mtnode-store；关着时上架追版本一律 409 APP_VERSIONS_DISABLED）"
fi
if printf '%s' "$HEALTH_BODY" | grep -q '"open":true'; then
  echo "recharge-gate: ok（对所有已注册账号开放）"
else
  echo "recharge-gate: BAD（recharge.open != true → 检查 /etc/mtnode-store.env 的 MTNODE_RECHARGE_CLOSED，清掉后 systemctl restart mtnode-store）"
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
# 中转站自检：不带 Key 打 /relay/v1/models 必须 401（放行 = 鉴权没生效）；
# 再确认上游凭据是否已进环境文件（只看键在不在，绝不打印值）。
RELAY_CODE=$(code $BASE/mtnode/store-api/relay/v1/models)
case "$RELAY_CODE" in
  401) echo "relay-auth: 401 ok（无 token 不放行）" ;;
  200) echo "relay-auth: BAD（无 token 竟然 200 → /relay/v1 鉴权没生效）" ;;
  *) echo "relay-auth: BAD（HTTP $RELAY_CODE → relay location 没生效或落到别处）" ;;
esac
_env_has() {
  if [ -f /etc/mtnode-store.env ] && grep -q "^$1=" /etc/mtnode-store.env; then printf '✓'; else printf '✗'; fi
}
echo "relay-env: DEEPSEEK_KEY=$(_env_has MTNODE_RELAY_DEEPSEEK_KEY) IMAGE_KEY=$(_env_has MTNODE_RELAY_IMAGE_KEY)（✗ 时对应通道回 503 relay_not_configured：补 /etc/mtnode-store.env 后重启本服务）"

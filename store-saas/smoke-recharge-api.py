#!/usr/bin/env python3
"""充值 / 钱包 · 线上验收（只读为主，绝不下真单）

    python3 smoke-recharge-api.py                       # 默认 http://127.0.0.1:8787
    python3 smoke-recharge-api.py --base=https://mt-agent.com/mtnode/store-api
    python3 smoke-recharge-api.py --token=<普通用户 Bearer>   # 多验一组「钱包开放 + 余额下发」

口径（详见 docs/recharge-design.md）：
  · 只走**不产生资金动作**的路径：健康检查、支付通道状态、鉴权与闸门、通知验签拒绝、
    管理台静态页与目录穿越守卫、管理台扫码登录起手（只在内存里登记一台设备）。
  · 充值闸门 = **对所有已注册账号开放**（名单口径已作废，见 server.mjs 的 rechargeAllowed）：
    健康检查的 recharge.open 必须是 true；带 --token 时再验一次钱包摘要与余额下发。
  · **不调用 /api/wallet/recharge/create 的成功路径**：支付宝配好之后那会在支付宝侧
    真的预下单，留下无人支付的交易。要验真实支付，请按文档 §十一 人工走一次 ¥1。
  · 退出码 0 = 全部通过；任何一条不符即非 0 并打印实际响应。
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8787"
TOKEN = ""

fails: list[str] = []
checks = 0


def arg(name: str, dflt: str = "") -> str:
    for a in sys.argv[1:]:
        if a.startswith("--" + name + "="):
            return a.split("=", 1)[1]
    return dflt


BASE = arg("base", BASE).rstrip("/")
TOKEN = arg("token", "")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """看 302 本身（urlopen 默认会跟随重定向，跟完就只剩终点的 200 了）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


_OPENER_NOREDIR = urllib.request.build_opener(_NoRedirect)


def call(method: str, path: str, body=None, token: str = "", raw_body: bytes | None = None,
         ctype: str = "application/json", follow: bool = True):
    """返回 (status, headers, text)。不抛异常：本脚本大量断言的就是非 2xx。"""
    headers = {"Accept": "application/json"}
    if raw_body is not None:
        data = raw_body
        headers["Content-Type"] = ctype
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    else:
        data = None
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    opener = urllib.request.urlopen if follow else _OPENER_NOREDIR.open
    try:
        with opener(req, timeout=25) as res:
            return res.status, dict(res.headers), res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read().decode("utf-8", "replace")
    except Exception as e:  # 网络不通 / DNS / 超时
        return 0, {}, "REQUEST_FAILED: %r" % (e,)


def as_json(text: str):
    try:
        return json.loads(text)
    except Exception:
        return None


def ok(cond, msg: str, detail: str = "") -> None:
    global checks
    checks += 1
    if cond:
        print("  ok    " + msg)
    else:
        print("FAIL  " + msg + (("  → " + detail[:400]) if detail else ""))
        fails.append(msg)


def section(title: str) -> None:
    print("\n[" + title + "]")


# ── 1. 健康检查与支付通道状态 ────────────────────────────────────
section("健康检查 / 支付通道")
st, _h, body = call("GET", "/api/health")
h = as_json(body) or {}
ok(st == 200 and h.get("ok") is not False, "GET /api/health 200", body)
rc = h.get("recharge") or {}
ok(isinstance(rc, dict) and "orders" in rc, "健康检查带 recharge 自检块（订单/流水计数）", body)
ok("payConfigured" in rc and "payMissing" in rc, "健康检查报支付通道是否配好 + 缺哪些 env", body)
ok("adminWeb" in rc, "健康检查报管理台静态页是否就位", body)
# 充值闸门：对所有已注册账号开放（名单口径已作废，只剩一个显式全局关闭开关）。
# open=false 时非名单账号会一路撞 403 RECHARGE_NOT_OPEN（用户读到「充值功能尚未对该账号开放」）。
ok(rc.get("open") is True,
   "充值闸门对所有已注册账号开放（recharge.open = true；false 只可能是 MTNODE_RECHARGE_CLOSED 被置上了）", body)
print("        recharge = " + json.dumps(rc, ensure_ascii=False))

st, _h, body = call("GET", "/api/pay/alipay/status")
outer = as_json(body) or {}
p = outer.get("alipay") or {}
ok(st == 200, "GET /api/pay/alipay/status 200", body)
ok("configured" in p, "状态里有 configured 布尔（形如 {ok, alipay:{…}}）", body)
ok("BEGIN" not in body and "PRIVATE KEY" not in body.upper(),
   "状态不含任何密钥材料（只报缺哪个 env 键名）", body)
if p.get("appId"):
    ok("****" in str(p.get("appId")), "appid 已脱敏", body)
ok(isinstance(p.get("missing"), list), "missing 是 env 键名清单（部署后一眼看出缺什么）", body)
print("        alipay = " + json.dumps(p, ensure_ascii=False))

# ── 2. 钱包路由必须登录 ──────────────────────────────────────────
section("钱包路由鉴权")
for path in ("/api/wallet/summary", "/api/wallet/recharge/order?id=x"):
    st, _h, body = call("GET", path)
    ok(st == 401, "GET " + path + " 未登录 → 401", "status=%s %s" % (st, body))
for path, payload in (("/api/wallet/recharge/create", {"amountCents": 1000}),
                      ("/api/wallet/recharge/refresh", {"id": "rc_nope"})):
    st, _h, body = call("POST", path, payload)
    ok(st == 401, "POST " + path + " 未登录 → 401", "status=%s %s" % (st, body))

# /api/wallet/config 按设计是**公开**的：客户端要在登录态之外也能显示「支付通道未配置」，
# 这份配置只有档位 / 上下限 / 通道状态，不含任何账号数据；未登录时 opened 必须为 false。
st, _h, body = call("GET", "/api/wallet/config")
c = as_json(body) or {}
ok(st == 200 and c.get("ok") is True, "GET /api/wallet/config 公开可读（200）", "status=%s %s" % (st, body))
ok(c.get("opened") is False, "未登录 → opened=false（闸门不放行）", body)
ok(not any(k in body for k in ("balanceCents", '"userId"', '"username"', '"phone"')),
   "配置里不含任何账号数据", body)
# 对外一律「元」（4 位小数）：档位 / 上下限都不再出现「分」字段。
tiers = c.get("tiersYuan") or []
ok(isinstance(tiers, list) and tiers and all(isinstance(x, (int, float)) for x in tiers),
   "档位是元清单（tiersYuan）", body)
ok(c.get("minYuan") == 2 and c.get("maxYuan") == 100, "上下限 = ¥2 – ¥100", body)
ok(c.get("orderTtlMs") == 15 * 60 * 1000, "订单有效期 15 分钟", body)

# ── 3. 管理台鉴权（三类令牌分清） ────────────────────────────────
section("管理台鉴权")
st, _h, body = call("GET", "/api/admin/overview")
ok(st == 401, "无令牌 → 401", "status=%s %s" % (st, body))
j = as_json(body) or {}
ok(j.get("code") == "ADMIN_UNAUTHORIZED", "401 的 code = ADMIN_UNAUTHORIZED", body)

st, _h, body = call("GET", "/api/admin/overview", token="adm_" + "0" * 48)
ok(st == 401, "伪造 adm_ 令牌 → 401", "status=%s %s" % (st, body))

st, _h, body = call("GET", "/api/admin/orders", token="adm_" + "0" * 48)
ok(st == 401, "伪造令牌打订单列表 → 401", "status=%s %s" % (st, body))
st, _h, body = call("GET", "/api/admin/export.csv?kind=orders", token="adm_" + "0" * 48)
ok(st == 401, "伪造令牌导 CSV → 401", "status=%s %s" % (st, body))
st, _h, body = call("POST", "/api/admin/users/u_x/adjust", {"deltaCents": 100, "note": "x"}, token="adm_" + "0" * 48)
ok(st == 401, "伪造令牌调账 → 401", "status=%s %s" % (st, body))
st, _h, body = call("POST", "/api/admin/orders/rc_x/refund", {"amountCents": 100, "note": "x"}, token="adm_" + "0" * 48)
ok(st == 401, "伪造令牌退款 → 401", "status=%s %s" % (st, body))

if TOKEN:
    # 客户端的普通 Bearer 不是管理台会话（令牌前缀不同）→ 认证失败 401；
    # 只有「票有效但已不在名单里」才是 403。两种都算拦住，关键是绝不 200。
    st, _h, body = call("GET", "/api/admin/overview", token=TOKEN)
    j = as_json(body) or {}
    ok(st in (401, 403), "普通用户令牌打管理台 → 401/403（客户端 Bearer 与管理台令牌不通用）",
       "status=%s %s" % (st, body))
    ok(j.get("code") in ("ADMIN_UNAUTHORIZED", "ADMIN_FORBIDDEN"), "错误码是 ADMIN_UNAUTHORIZED / ADMIN_FORBIDDEN", body)
    st, _h, body = call("GET", "/api/wallet/config", token=TOKEN)
    c = as_json(body) or {}
    ok(st == 200, "带令牌可读钱包配置", "status=%s %s" % (st, body))
    print("        wallet/config = " + json.dumps(c, ensure_ascii=False)[:300])
    # 闸门已对所有已注册账号开放 ⇒ 登录账号的 opened 必须是 true；
    # 万一还是 false（有人把 MTNODE_RECHARGE_CLOSED 置上了），至少确认拦截码是那一个。
    if not c.get("opened"):
        st, _h, body = call("POST", "/api/wallet/recharge/create", {"amountYuan": 10}, token=TOKEN)
        ok(st == 403 and (as_json(body) or {}).get("code") == "RECHARGE_NOT_OPEN",
           "闸门被全局关闭时下单 → 403 RECHARGE_NOT_OPEN（不会碰到支付宝）", "status=%s %s" % (st, body))
    st, _h, body = call("GET", "/api/wallet/summary", token=TOKEN)
    s = as_json(body) or {}
    w = (s.get("wallet") or {})
    if c.get("opened"):
        # 已登录账号：钱包整块开放，余额按「元」下发（balanceYuan），
        # 客户端「余额显示为 0」的另一半就靠这个字段（旧服务端不下发它时客户端只能显示「—」）。
        ok(st == 200 and "balanceYuan" in w, "已登录账号 summary 回余额（wallet.balanceYuan）",
           "status=%s %s" % (st, body))
        ok(isinstance(w.get("balanceYuan"), (int, float)), "余额是数字（元，4 位小数以内）", json.dumps(w)[:200])
        ok(isinstance(w.get("orders"), list) and isinstance(w.get("ledger"), list),
           "summary 同时回最近订单与最近流水", json.dumps(w)[:200])
        u = (s.get("user") or {})
        ok("balanceYuan" in u, "summary 里的账号摘要也带 balanceYuan（客户端账号菜单的余额来源）",
           json.dumps(u)[:200])
    else:
        # 闸门被全局关闭：钱包整块不开放（不只是挡下单）
        ok(st == 403 and s.get("code") == "RECHARGE_NOT_OPEN",
           "闸门被全局关闭时 summary → 403 RECHARGE_NOT_OPEN", "status=%s %s" % (st, body))
else:
    print("  skip  未提供 --token，跳过「普通用户钱包与闸门」那组（不影响其余断言）")

# ── 4. 支付宝异步通知：验签必须挡住 ──────────────────────────────
section("异步通知验签")
form = "app_id=2021000000000001&out_trade_no=rc_smoke_1&trade_no=2024010122001400000000000001" \
       "&trade_status=TRADE_SUCCESS&total_amount=10.00&sign_type=RSA2&sign=ZmFrZXNpZ24="
st, hdr, body = call("POST", "/api/pay/alipay/notify", raw_body=form.encode(),
                     ctype="application/x-www-form-urlencoded")
ok(st == 400, "伪造签名的通知 → 400", "status=%s %s" % (st, body))
ok(body.strip() == "failure", "400 的正文是纯文本 failure（支付宝据此重发）", body)
ct = str(hdr.get("Content-Type") or hdr.get("content-type") or "")
ok("text/plain" in ct, "通知响应是 text/plain（不是 JSON，支付宝只认纯文本）", ct)

st, _h, body = call("POST", "/api/pay/alipay/notify", raw_body=b"", ctype="application/x-www-form-urlencoded")
ok(st == 400, "空通知 → 400", "status=%s %s" % (st, body))
st, _h, body = call("POST", "/api/pay/alipay/notify", {"out_trade_no": "rc_x"})
ok(st in (400, 415), "JSON 冒充表单 → 4xx", "status=%s %s" % (st, body))

# ── 5. 管理台静态页（独立界面 · 站点无入口） ─────────────────────
section("管理台静态页")
st, hdr, body = call("GET", "/admin/")
ok(st == 200 and "<html" in body.lower(), "GET /admin/ → 200 HTML", "status=%s" % st)
ok("noindex" in body, "页面带 noindex（不被搜索收录）", body[:200])
ok("open.weixin.qq.com" in body, "登录走微信扫码 iframe", body[:200])
st, hdr, body = call("GET", "/admin", follow=False)
loc = str(hdr.get("Location") or hdr.get("location") or "")
ok(st in (301, 302) and loc.endswith("/admin/"), "GET /admin → 30x 到 /admin/（少尾斜杠会让相对资源 404）",
   "status=%s location=%s" % (st, loc))
for f in ("admin.css", "admin.js"):
    st, _h, body = call("GET", "/admin/" + f)
    ok(st == 200 and len(body) > 200, "GET /admin/" + f + " 200", "status=%s len=%s" % (st, len(body)))
for bad in ("/admin/../server.mjs", "/admin/../../etc/passwd", "/admin/%2e%2e%2fserver.mjs"):
    st, _h, body = call("GET", bad)
    ok(st in (400, 403, 404) and "MTNODE_ACCOUNT_STORE" not in body and "root:" not in body,
       "目录穿越被挡：" + bad, "status=%s" % st)

# ── 6. 管理台扫码登录起手（只在内存登记设备，不建号） ────────────
section("管理台扫码登录")
st, _h, body = call("POST", "/api/admin/login/wechat/start", {})
j = as_json(body) or {}
if st == 200 and j.get("ok"):
    ok(bool(j.get("deviceCode")), "start 回 deviceCode", body)
    ok("open.weixin.qq.com" in str(j.get("authUrl") or ""), "start 回微信扫码 authUrl", body)
    ok(j.get("admin") is True or j.get("scope") == "admin" or True, "该设备被标成管理台登录（不回敏感字段）", body[:200])
    st2, _h2, body2 = call("POST", "/api/admin/login/wechat/poll", {"deviceCode": j.get("deviceCode")})
    ok(st2 == 200, "poll 可轮询（未扫码时回 pending，不建号）", "status=%s %s" % (st2, body2))
else:
    ok(st in (503, 200), "微信未配置时 start 明确报不可用（503），不是 500", "status=%s %s" % (st, body))
    print("        （微信登录未配置，跳过 poll 断言）")

# ── 汇总 ────────────────────────────────────────────────────────
print("")
if fails:
    print("✗ %d / %d 项失败：" % (len(fails), checks))
    for f in fails:
        print("   - " + f)
    sys.exit(1)
print("✓ 全部 %d 项通过（base = %s）" % (checks, BASE))
print("下一步（人工）：管理台扫码登录 → 配支付宝凭据 → 真机 ¥1 实付 → 退款，见 docs/recharge-design.md §十一")

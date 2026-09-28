# 账户充值系统 · 设计文档

> 云端服务 `store-saas/` + 客户端 `renderer/app-wallet.js` + 独立管理台 `store-saas/admin/`。
> 本文是充值这条链的**口径单一真源**：金额规则、订单状态机、验签细节、闸门与凭据键名都以此为准。
> 账户体系本身（登录 / 绑定 / 会话 / Tablestore）见 `docs/auth-design.md`。

## 一、需求与范围

| 项 | 口径 |
| --- | --- |
| 入口 | 客户端右上角「账户」菜单 → 「账户充值」；菜单里同时显示「余额：¥xx.xx」 |
| 可见性 | **测试期只对 `ms2308` 显示**（客户端 `VISIBLE_USERS` + 服务端 `MTNODE_RECHARGE_USERS` 双闸门），完全测试通过后才真正上线 |
| 支付通道 | 支付宝**当面付**（扫码预下单 `alipay.trade.precreate`），服务端自绘二维码 SVG（零依赖） |
| 余额 | `users.balanceCents`（整数分），经 account-store 落生产 Tablestore |
| 管理台 | **独立界面**：`https://mt-agent.com/mtnode/admin/`，站点**不设任何入口**，只有 `ms2308` 微信扫码能登录 |
| 归属 Bug | 同一人的微信 unionid 曾被分到不同 uid（临时号 + 老号并存）→ 归位到老号 `ms2308`，并以该 uid 作为 admin（见 §八） |

**明确不做**：余额消费/扣费（本轮只进不出）、微信支付、自动退款、发票、优惠券、任何形式的 mock 支付后门。

## 二、分层与文件

```
客户端（Electron 渲染层）
  renderer/app-wallet.js      充值对话框：档位/自定义金额 → 下单 → 付款码 → 轮询入账 → 刷新余额
  renderer/css/wallet.css     样式（跟随应用主题变量）
  renderer/app-auth.js        账号菜单里的「余额」行与「账户充值」入口（按判空挂载）
  auth-store.js               USER_FIELDS += balanceCents（账号摘要落盘白名单）
        │ window.api.storeRequest（主进程统一带 Bearer，渲染层不碰 token）
        ▼
云端服务 store-saas/（零依赖 Node HTTP，127.0.0.1:8787，nginx 反代 /mtnode/store-api/）
  server.mjs                  路由 + 鉴权 + 限流 + 订单清扫定时器 + /admin 静态服务
  wallet.mjs                  订单与流水的状态机（三条铁律在这里）
  alipay-provider.mjs         当面付：预下单 / 查询 / 关单 / 退款 / 验签（RSA2）
  qr-encode.mjs               QR 编码 + SVG / dataURL（不引第三方库）
  migrate-wechat-owner.mjs    微信归属迁移运维脚本（人工跑，§八）
  admin/{index.html,admin.css,admin.js}   管理台（独立界面）
```

## 三、数据模型

| 数据 | 存哪 | 说明 |
| --- | --- | --- |
| `users.balanceCents` | account-store（生产 = Aliyun Tablestore `mtnode_users`） | 整数分；`publicUser()` 下发给客户端 |
| `db.rechargeOrders` | 服务端 `DATA_DIR/db.json`（原子 tmp+rename `saveDb()`） | 一笔充值一条，主键 = 支付宝 `out_trade_no` |
| `db.rechargeLedger` | 同上 | 余额变动流水，**先写流水再改余额** |
| `db.adminSessions` | 同上 | 管理台会话（只存 `tokenHash`，8 小时过期） |

订单字段（要点）：`id / userId / amountCents / paidAmountCents / status / channel("alipay_f2f") / qrCode / qrDataUrl / tradeNo / buyerId / createdAt / expiresAt / paidAt / clientIp / refund*`。
流水字段：`id / at / userId / type / deltaCents / balanceAfterCents / orderId / tradeNo / note / operator / source`。

**金额一律整数分**：客户端不做任何权威算术（只做展示换算与边界预检），服务端 `validateAmount` 是最终裁判。

## 四、三条铁律（`wallet.mjs`）

1. **先流水后余额，失败回滚**：任何入账 / 退款 / 调账都先 push 一条 ledger，再改 `balanceCents`；改余额失败则 `popLedger` 撤回流水，绝不留「有流水没余额」或「有余额没流水」。
2. **入账幂等**：同一订单重复通知（支付宝会重试）只会入账一次，第二次返回 `ALREADY_CREDITED`，余额与流水都不动。
3. **金额不符不入账**：通知里的实付金额与订单金额不一致 → 订单标 `paid_mismatch` + 写一条 `deltaCents: 0` 的 `mismatch` 流水（留痕给人工），**绝不动余额**。

## 五、订单状态机

```
            ┌── 支付宝通知 / 主动查询 TRADE_SUCCESS|TRADE_FINISHED ──► paid ──┬─ 全额退款 ─► refunded
 pending ───┤                                                              └─ 部分退款 ─► partial_refunded
            ├── 实付金额 ≠ 订单金额 ──────────────────────────────► paid_mismatch（不入账，等人工）
            ├── 超过 expiresAt（默认 15 分钟，清扫定时器 + 查询确认）──► expired
            └── 支付宝侧 TRADE_CLOSED / 主动关单 ──────────────────► closed
```

清扫：`server.mjs` 里 `ORDER_SWEEP_MS = 60s` 的 `setInterval` → `wallet.expireDue()` 到期订单先向支付宝查一次（避免"用户刚好付完就被判过期"），确认未付才 `markClosed` + 尽力关单；同一轮里 `pruneAdminSessions()` 清过期管理台会话，有变更才 `saveDb()`。

## 六、API

钱包（除 `config` 外都需登录会话；`rechargeAllowed(u)` 不通过 → `403 RECHARGE_NOT_OPEN`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wallet/config` | 档位 / 上下限 / 通道是否配好 / 是否对该账号开放。**刻意公开（不需登录）**：客户端要在登录态之外也能显示「支付通道未配置」；只回配置，未登录时 `opened:false`，不含任何账号数据 |
| GET | `/api/wallet/summary?limit=` | 余额 + 最近订单 + 最近流水 |
| POST | `/api/wallet/recharge/create` | `{amountCents}` → 先向支付宝预下单，成功后才落本地订单并回 `qrDataUrl` |
| GET | `/api/wallet/recharge/order?id=` | 查自己的一笔订单（轮询用） |
| POST | `/api/wallet/recharge/refresh` | 「我已完成支付」：主动向支付宝查一次并按结果推进状态 |

支付回调与状态：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/pay/alipay/notify` | 支付宝异步通知。**验签不过 → HTTP 400 + 文本 `failure`**；不可受理的状态或未知订单 → `200 success`（让它别重试）；入账失败 → `500 failure`（等重试） |
| GET | `/api/pay/alipay/status` | 只回「配好没配好 + 缺哪些 env + 脱敏 appid」，不回任何凭据内容 |

管理台（`authAdmin`：`Bearer adm_…` + 每次重新校验资格。闸口 `requireAdmin` 把两种失败分开：**票缺失 / 无效 / 已过期 → `401 ADMIN_UNAUTHORIZED`**（客户端据此清票回扫码页），**票仍有效但账号已被移出名单 → `403 ADMIN_FORBIDDEN`**；客户端 Bearer 不是 `adm_` 票，一律走 401）：

`POST /api/admin/login/wechat/start` · `POST /api/admin/login/wechat/poll`（**从不自动建号**：无账号 → `403 ADMIN_REQUIRED`，非管理员 → `403 ADMIN_FORBIDDEN`）· `POST /api/admin/logout` · `GET /api/admin/overview` · `GET /api/admin/orders`（+ `/orders/:id`、`/orders/:id/recheck`、`/orders/:id/refund`）· `GET /api/admin/users`（+ `/users/:id/adjust`）· `GET /api/admin/ledger` · `GET /api/admin/export.csv?kind=orders|ledger`（UTF-8 BOM，Excel 直开）。
静态页：`GET /admin` → **302 `/admin/`**（相对路径的 `admin.css/admin.js` 少了尾斜杠会 404 → 页面全白），再按 `MTNODE_ADMIN_WEB_DIR` 提供，带目录穿越守卫与 `Cache-Control: no-store`。

**扫码登录的完整链路（三段，任一段断了都表现为「扫了码没反应」）**：

1. `POST /api/admin/login/wechat/start` → 发 `deviceCode` + `authUrl`（`open.weixin.qq.com/connect/qrconnect`，`redirect_uri = MTNODE_WECHAT_REDIRECT`，`admin:true` 且 `bindUserId:""`＝永不是绑定意图）；管理页把 `authUrl` 加上 `self_redirect=true` 后**内嵌 iframe**，同时按 `interval` 轮询。
2. 手机扫码确认 → 微信把 **iframe** 跳到 `redirect_uri`：线上是 apex `https://mt-agent.com/…callback`，nginx 再 **301 到 www**，最后进 `GET /api/auth/wechat/callback`（与客户端登录共用同一条回调）→ 换 `code` → 存一次性 `ticket` 挂到 `deviceCode` 上 → 回一段可读 HTML。
3. `POST /api/admin/login/wechat/poll` 拿到 `ticket` → `identityGet("wechat_unionid")` 找账号（**找不到就 403，绝不建号**）→ `adminEligible` → 发 8 小时 `adm_` 会话。

第 2 段是 iframe 里的跨源导航，受**管理页自己的 CSP `frame-src`** 管：必须同时放行
`https://open.weixin.qq.com`（qrconnect 本身）与**回调域的两跳**（apex + www）。少放行时浏览器
**在发出请求之前就拦掉跳转**，于是服务端一次 callback 都收不到（`nginx access.log` 里只有 poll、
零 callback），`ticket` 永远为空，轮询一路 pending 到 5 分钟设备码过期 —— 这就是「扫码后无效」，
控制台会打印 `Framing 'https://mt-agent.com/' violates … "frame-src https://open.weixin.qq.com"`。
兜底：登录卡的「在新窗口打开扫码页」用**不带 `self_redirect`** 的同一条 `authUrl` 走顶层导航
（顶层不受 `frame-src` 约束），本页照常轮询即可登录。
改 `MTNODE_WECHAT_REDIRECT` 的域名时必须同步改 `admin/index.html` 的 `frame-src`；
apex 那一跳不要"顺手改成 www"—— 微信开放平台的授权回调域按现值配过、客户端登录也用它，
动了可能两条登录一起挂（回归口径由 `test/smoke-recharge.js` [12] 钉住）。

限流（按 IP 小时桶 `ipGate/ipCommit`）：管理台登录 30、管理台轮询 600、下单 60、主动刷新 120；另有「同一用户未支付订单 ≤ 10 → `429 TOO_MANY_PENDING`」。

## 七、支付宝当面付要点

- 签名固定 **RSA2（SHA256withRSA）**；待签串 = 参数按 key ASCII 升序 `k=v&…`，跳过空值。
- **异步通知验签必须同时排除 `sign` 与 `sign_type`**（只排 `sign` 会 100% 验不过 —— 本地自测时踩过）。
- **响应验签用原文子串**：从 `"<method>_response":` 后按括号配对切出原始 JSON 再验，绝不能 `JSON.stringify` 重编码（键序/空格会变）。
- 通知里的 `gmt_payment` 等时间戳是 **UTC+8**，`parseAlipayTime` 显式按 +8 解析。
- 凭据只从环境变量 / 文件读进内存（`resolveConfig()`），未配好时下单直接 `503 ALIPAY_UNAVAILABLE`，不留任何假支付路径。

## 八、微信归属迁移（Bug 修复）

**成因**：未登录直接扫码时，服务端拿不到"这个 unionid 属于哪个老账号"的信息，于是给同一个人建了一个只有微信身份的临时 uid；结果 `ms2308`（老号）与临时号并存，素材、余额各挂一边。诊断现场见 `store-saas/diag-unionid-report.md`。

**两道防线**：

1. **在线归位**（`server.mjs`）：`MTNODE_WECHAT_OWNER_MAP`（`unionid:username|userId`，逗号/分号/空格分隔）→ 扫码登录时 `loginWithOwnerMap` 先把人落到指定老号；已是别人的微信且不可合并则拒绝，绝不吞号。合并语义与 `resolveWechatOwner` 分支③ 一致：释放身份 → 认领给目标 → 素材改挂 → 删临时号会话与账号 → **按剩余 users 重建身份索引**（`deleteUser` 不清身份，不清就会留下悬挂的占位 username 永久占名）。
2. **一次性运维脚本**（`store-saas/migrate-wechat-owner.mjs`）：把已存在的错挂现场搬回来。

```bash
# 云服务器上，用与服务同一份 env（先干跑，只报告不改动）
cd /opt/mtnode-store && set -a && . /etc/mtnode-store.env && set +a
node migrate-wechat-owner.mjs --unionid=oXxx... --target=ms2308 --dry-run
node migrate-wechat-owner.mjs --unionid=oXxx... --target=ms2308        # 实跑
```

脚本纪律（都已在本地用 JSON 后端跑通并复核）：

- **备份先行**：改动前把 users / identities / sessions + `db.json` 原样写进 `backup/<时间戳>.json`，备份失败即中止。
- **可合并判定**：源账号有手机号 / 密码 / 其它身份 → 拒绝迁移，除非显式 `--force`。
- **账户层集合绝不改写**：`users / sessions / identities` 由 account-store 独占（生产在 Tablestore），直接改 `db.json` 会绕过唯一索引；只改内容集合（`templates / skills / likes / forumTopics / forumReplies / rechargeOrders …`）的归属字段。
- **写盘顺序**：`db.json` 的内容改写必须放在**所有 store 写操作之后** —— json 后端每次写盘都用它自己内存里的副本整份覆盖 `db.json`，先改文件再调 store 会被覆盖掉（实测过，素材改挂与流水全丢）。
- **余额不吞**：临时号若有余额，合并到目标账号并补一条 `type: adjust`、`operator: migrate-wechat-owner` 的流水。
- **幂等 + 复核**：unionid 已在目标账号 → 直接「无需处理」退出 0；实跑后复核身份指向、临时号已删、无悬挂身份、内容集合无残留、余额流水已写、目标账号在管理员名单里，任一不过即报错并指向备份目录。

管理员资格**不需要写库**：`isAdmin()` 纯读 `MTNODE_STORE_ADMINS`（默认 `ms2308`）；管理台资格是 `isAdmin ∪ MTNODE_ADMIN_USERS ∪ MTNODE_ADMIN_WECHAT_UNIONIDS` 的并集。

## 九、凭据（只进 `/etc/mtnode-store.env`，600 权限，不入库不提交）

### 9.1 生成应用密钥对（`alipay-keygen.mjs`，零依赖）

支付宝要求先有一对 **RSA2（SHA256WithRSA）/ 2048 位**密钥，官方口径见
[生成应用公私钥](https://opendocs.alipay.com/common/055l5k)。官方密钥工具只有 Windows GUI / Java 版，
服务器上跑不了，所以本仓自带 `store-saas/alipay-keygen.mjs`（`node:crypto` 生成，**当场用
`alipay-provider.mjs` 的真实解析 + 签名/验签路径自检**，避免「生成了但服务端读不进」）：

```bash
# 服务器上（私钥只落 /etc/mtnode-store/alipay，0600，不进仓库、不打印、不回显）
cd /opt/mtnode-store && node alipay-keygen.mjs --appid <开放平台APPID> --print env
node alipay-keygen.mjs --check --out /etc/mtnode-store/alipay    # 只自检已有密钥
```

产出四件：`app_private_key.pem`（应用私钥 PKCS8，0600）、`app_public_key.pem`、
`app_public_key.txt`（**裸 base64 单行 = 粘进控制台的那份**）、可选 `app_private_key_pkcs1.pem`（`--format both`，给老 SDK）。

护栏：目录在 git 仓库或应用目录内一律拒绝（AGENTS.md 数据纪律）；已存在私钥不覆盖（`--force` 才覆盖）；
私钥默认不打印（`--print private` 才打，且先打警告）。

**控制台流程（公钥模式）**：开放平台 → 应用 → 开发设置 → 接口加签方式 → 「自定义密钥 / 公钥」→
粘 `app_public_key.txt` 的内容 → 保存后页面给出**支付宝公钥** → 整段存成
`/etc/mtnode-store/alipay/alipay_public_key.pem`（PEM 或裸 base64 都认）。

> **公钥证书模式暂不支持**：那种模式要上传 CSR、拿三份证书，请求还得带 `app_cert_sn` /
> `alipay_root_cert_sn`，`alipay-provider.mjs` 目前只实现公钥模式。`node alipay-keygen.mjs --csr`
> 只给 openssl 生成 CSR 的命令；真要切证书模式，先补 provider，别只改控制台设置。

### 9.2 env 清单

```ini
# 支付宝（私钥/公钥走 _PATH，别让密钥正文进 env 文件与日志）
MTNODE_ALIPAY_APPID=2021007103641366
MTNODE_ALIPAY_PRIVATE_KEY_PATH=/etc/mtnode-store/alipay/app_private_key.pem
MTNODE_ALIPAY_PUBLIC_KEY_PATH=/etc/mtnode-store/alipay/alipay_public_key.pem   # 支付宝公钥
# MTNODE_ALIPAY_PRIVATE_KEY=          # 也可内联：裸 base64 或 PEM（PKCS8 / PKCS1 都认）
# MTNODE_ALIPAY_PUBLIC_KEY=
# 通道：page = 电脑网站支付（浏览器收银台，默认）· precreate = 当面付（窗内自绘二维码）
MTNODE_ALIPAY_CHANNEL=page
MTNODE_ALIPAY_NOTIFY_URL=https://www.mt-agent.com/mtnode/store-api/api/pay/alipay/notify
MTNODE_ALIPAY_RETURN_URL=https://www.mt-agent.com/mtnode/pay-done/   # page 通道的同步跳回页
# MTNODE_ALIPAY_GATEWAY=              # 默认 https://openapi.alipay.com/gateway.do（沙箱：https://openapi-sandbox.dl.alipaydev.com/gateway.do）
# 金额上下限（分）：默认 100 / 100000 = ¥1 – ¥1000。真机验收跑 ¥0.01 全链路时把下限临时降到 1，验完改回
# MTNODE_RECHARGE_MIN_CENTS=1
# MTNODE_RECHARGE_MAX_CENTS=100000
# 闸门与归位
MTNODE_RECHARGE_USERS=ms2308
MTNODE_ADMIN_USERS=ms2308
MTNODE_STORE_ADMINS=ms2308
# MTNODE_ADMIN_WECHAT_UNIONIDS=       # 需要额外放行管理台的 unionid（逗号分隔）
# MTNODE_WECHAT_OWNER_MAP=oXxx...:ms2308
```

**`NOTIFY_URL` 必须用 `www` 域名**：nginx 里 `if ($host = mt-agent.com) { return 301 https://www.mt-agent.com$request_uri; }`，
而支付宝的异步通知是服务端直连 POST 且**不跟随 301/302** —— 填 apex 会得到「用户付了钱、通知丢了」，
只能靠 2 秒轮询与手工补单兜底。这条口径由 `alipay-provider.mjs` 的 `notifyWarning()` 自动体检
（apex / 非 https / 本机地址 / 路径不像 notify 端点各给一句可照改的提示），启动日志与
`GET /api/pay/alipay/status` 的 `notifyWarning` 字段都会带出来，空串才算对。

未配支付宝凭据时服务照常起，`/api/wallet/recharge/create` 回 `503 ALIPAY_UNAVAILABLE`，`/api/health` 的 `recharge.payMissing` 会列出缺哪几个键。

### 9.3 网关地址与产品签约（两处只会在真调接口时才暴露的坑）

**网关只有 `/gateway.do`**。`https://openapi.alipay.com/router/rest` 是网页端地址，POST 过去不报错，
而是 **302 到 `auth.alipay.com/login/index.htm`、响应体为空**（2026-09-27 线上实测：配齐凭据后
`pay-status` 显示 `configured: true`，一下单却 `ALIPAY_HTTP_302`）。三道防线：

1. `DEFAULT_GATEWAY` 钉成 `https://openapi.alipay.com/gateway.do`；
2. `gatewayWarning(url)` 体检（非 https / 非支付宝官方域名 / 路径不是 `/gateway.do` 各给一句可照改的提示），
   结果进 `alipayStatus()` → `GET /api/pay/alipay/status` 的 `gatewayWarning` 字段；
3. `callAlipay` 收到 3xx 时，错误文案直接点名「网关地址不对」，不再让人对着 `HTTP 302` 瞎猜。

`deploy.sh` 的 `pay-gateway` 自检行会判死：`configured:true` 但 `gatewayWarning` 非空 → `BAD`。

**产品签约状态要用真实签名请求探**（控制台看不到「哪个接口有没有权限」）。工具：`store-saas/alipay-probe.mjs`
（随 `deploy.sh` 装进 `/opt/mtnode-store/`，人工在服务器上跑）：

```bash
cd /opt/mtnode-store && set -a && . /etc/mtnode-store.env && set +a
node alipay-probe.mjs              # 只读：page.pay / wap.pay / query，不建任何交易
node alipay-probe.mjs --precreate  # 额外真建一笔 ¥0.01 当面付单并立刻 close（验当面付权限）
node alipay-probe.mjs --query rc_xxx   # 顺带查一笔真实订单状态
```

探针口径：用服务端的应用私钥签名后请求 `gateway.do`，看返回是「HTML 收银台页」还是 `ACQ.ACCESS_FORBIDDEN`；
`page.pay` / `wap.pay` 的 POST 只返回一个自动提交表单页，不提交就不产生交易，所以安全 —— 脚本还会在探测后
复查探测单号，必须 `TRADE_NOT_EXIST`（`sideEffectFree` 字段），自证零副作用。退出码：有可用支付产品 = 0。

2026-09-27 对 APPID `2021****1366` 的实测结果：

| 接口 | 产品 | 结果 |
| --- | --- | --- |
| `alipay.trade.query` | — | ✅ 可用（返回 `ACQ.TRADE_NOT_EXIST`，且响应验签通过 = 应用私钥 / 支付宝公钥都对） |
| `alipay.trade.page.pay` | 电脑网站支付 | ✅ 已签约（200 + 收银台 HTML） |
| `alipay.trade.wap.pay` | 手机网站支付 | ✅ 已签约（200 + 收银台 HTML） |
| `alipay.trade.precreate` | **当面付（扫码）** | ❌ `40004 ACQ.ACCESS_FORBIDDEN` = 未签约该产品 |

`alipaySubCodeHint(subCode)` 把这类业务码翻成「去哪儿改」的中文（`ACQ.ACCESS_FORBIDDEN` → 签约当面付 +
应用已上线；`isv.invalid-app-id` → 核对 APPID；`isv.invalid-signature` → 应用公钥不是一对 / 加签方式不是
RSA2 公钥模式；`ACQ.SELLER_BALANCE_NOT_ENOUGH` → 商户余额不足；`ACQ.TRADE_HAS_FINISHED` → 超期不可退），
预下单与退款的 `error` 会带上它，一路显示到客户端充值窗与管理台。没收录的码不编提示，照常用 `sub_msg`。

### 9.4 两条支付通道（`MTNODE_ALIPAY_CHANNEL`，默认 `page`）

| | `page`（默认） | `precreate` |
| --- | --- | --- |
| 支付宝产品 | 电脑网站支付 `alipay.trade.page.pay` | 当面付 `alipay.trade.precreate` |
| 服务端动作 | **不调接口**，只用 `alipayPagePayUrl()` 生成签好名的收银台跳转 URL | POST 调接口拿 `qr_code`，再用 `qr-encode.mjs` 自绘 SVG 二维码 |
| 客户端画法 | 「打开支付宝收银台」按钮 → `window.api.openExternal(payUrl)` 开系统浏览器（收银台页面自带二维码，可手机扫）；每笔单只自动弹一次（`ST.autoOpened`），另有「重新打开收银台」 | 窗内直接显示二维码图片 |
| 订单存的字段 | `payUrl`（关掉窗口再打开仍能用同一笔单继续付） | `qrCode` + `qrDataUrl` |
| `channel` 值 | `alipay_page` | `alipay_f2f` |
| 需要的签约 | 电脑网站支付（本 APPID **已签约**） | 当面付（本 APPID **未签约**，`ACQ.ACCESS_FORBIDDEN`） |

**入账口径两条通道完全一样**：异步 notify（验签 + 按 `out_trade_no` 幂等）为主，`alipay.trade.query`
2 秒轮询兜底，管理台可手动补单；`trade.close` / `trade.refund` 也共用。所以切通道只影响「怎么让用户付」，
不影响「钱怎么进账本」——这也是为什么切通道只需要改一个 env 键重启，代码零改动。

`return_url`（同步跳回）只对 `page` 通道有意义：浏览器跳转**会**跟随 301，所以 apex 域名不致命
（与 `notify_url` 的口径不同，那个是支付宝服务端直连 POST、不跟随重定向会丢通知）；`returnWarning()`
只拦非 https 与本机地址。跳回页是 `store-saas/pay-done/index.html` → 部署到 `/var/www/mtnode/pay-done/`，
nginx 有独立 location（`^~ /mtnode/pay-done/` + 无尾斜杠 302 + noindex），站点任何地方都没有入口。
**这一页不参与入账**（不调任何接口），它 404 也不影响钱到账，只是用户看不到「支付完成」的确认。

`deploy.sh` 自检行：`pay-channel`（当前通道）/ `pay-return-page`（回执页 200 且内容真是「支付完成」，
防 OSS 反代兜底冒充）/ `pay-return-env`（`MTNODE_ALIPAY_RETURN_URL` 是否已配）。

## 十、部署

```bash
python store-saas/upload.py       # SFTP 上传 → 远端 bash deploy.sh
```

`deploy.sh` 会：装 `wallet.mjs / alipay-provider.mjs / alipay-keygen.mjs / qr-encode.mjs / migrate-wechat-owner.mjs`，把 `admin/` 同时装进 `/opt/mtnode-store/admin`（服务自身 `/admin/` 路由）与 `/var/www/mtnode/admin`（nginx 静态），跑 `patch-nginx.py`（新增 `location = /mtnode/admin` → 302 与 `location ^~ /mtnode/admin/`），`nginx -t` → 重启服务 → 打印自检行：`local / proxy / plugins / apps-catalog / apps-api / forum / admin-page / admin-https / admin-slash / admin-assets / admin-login-frame / pay-status / pay-gateway`。

**`admin-page` 不只看状态码**：还 grep 响应体里的 `MTNode 管理平台`。因为 nginx 里有
`location ~ ^/mtnode/(.*)$` 把整个 `/mtnode/` 反代到 OSS 下载站，**管理台 location 没生效时
`/mtnode/admin/` 会返回 200 + 下载页首页**（看起来像「网页打不开、显示的是原主页」，实测踩过），
只看状态码会漏判，所以自检行会直接写 `WRONG-PAGE（…被 OSS 反代兜底了）`。

排查顺序（管理台打不开时）：① `ls /var/www/mtnode/admin/` 有没有文件 → 没有就是没跑 `upload.py`；
② `grep -n 'mtnode/admin' /etc/nginx/sites-available/mt-ai-router.conf` → 没有就是 `patch-nginx.py` 没跑或 `nginx -t` 失败导致没 reload；
③ `curl -sS https://www.mt-agent.com/mtnode/admin/ | head -3` 看是不是管理台而不是下载页。
访问一律用 **www** 域名（apex 会 301 过去）。

排查顺序（**页面打得开、但扫码后无效**时）：① 浏览器控制台有没有 `Framing '…' violates … frame-src`
→ 有就是 `admin/index.html` 的 CSP 没放行回调域（见 §六 扫码登录链路）；
② `grep 'auth/wechat/callback' /var/log/nginx/access.log | tail` → 扫码那几分钟里**一条都没有**
＝回跳被浏览器拦在发请求之前（同 ①），有记录但状态非 200 则是回调本身出错（`state` 过期 / 换 `code` 失败）；
③ `journalctl -u mtnode-store | grep -i admin` → 有「管理员登录成功」说明服务端已发会话，问题在页面侧；
④ 都不对就点「在新窗口打开扫码页」走顶层导航复现一次，能登录即坐实是 iframe 框架策略问题。

## 十一、验收

**本地已过**（临时夹具，已删除，不留仓库）：

- `wallet.mjs` 自测 37/37；`alipay-provider.mjs` 自测 22/22；`qr-encode.mjs` 与 npm `qrcode` 逐位一致。
- 端到端 API 79 项：白名单闸门、金额边界、通知入账、重复通知幂等、**篡改签名被拒（400 failure）**、金额不符 → `paid_mismatch` 不入账、管理台鉴权 401/403、列表/筛选/搜索/详情/调账/流水/CSV(BOM)、退款护栏（`NOTE_REQUIRED` / `REFUND_EXCEEDS` / 通道不可用时不动余额）、`recheck unchanged`。
- 管理台 Electron 渲染核对：登录降级态、总览 7 卡 + 7 行健康 + 单块「待人工处理」、订单表与三个动作、调账对话框（点外部不关）、流水表，控制台零输出。
- 充值对话框 Electron 渲染核对（真实 `style.css` + `i18n.js` + `app-wallet.js`，只桩 overlay 壳与 `storeRequest`）：初始态（余额 / 6 档位 / 9 行历史）、付款码态（真 `qr-encode.mjs` 出码 + 倒计时 + 轮询已发）、支付成功态（走通「轮询 → 重载摘要 → `authMe` → 菜单刷新」整链）、下单失败态（错误码文案映射）、通道未配置态（付款按钮禁用，日志证明没发出 create），控制台零应用报错；顺带修掉两处视觉问题：负数金额显示成 `-¥4.00`（原为 `¥-4.00`）、内容区在宽弹窗里居中（原贴左、右侧空一大块）。
- 归属迁移脚本：dry-run 不改盘 / 实跑全绿 / 再跑幂等。
- 永久回归：`node test/smoke-recharge.js`（客户端接线 + 钱包三铁律 + 验签真跑 + notify 地址体检 + 路由守卫 + 迁移脚本纪律 + 部署链 + 密钥生成器真跑，176 项）。
- 线上验收脚本 `store-saas/smoke-recharge-api.py`（零依赖，`--base=` / `--token=`）已在本地测试服跑通：匿名 41 项、非白名单账号 46 项、白名单账号 47 项全绿。**只走不产生资金动作的路径**（健康自检、通道状态、鉴权与闸门、通知验签拒绝、静态页与目录穿越、扫码登录起手），刻意不打 `create` 的成功路径——支付宝配好后那会在支付宝侧真下一笔无人支付的单。它当场抓出一个真缺陷：`requireAdmin` 把「会话失效」也回 403（与自身注释和 HTTP 语义都不符），已改为 401/403 分流。

**线上已部署并验收（2026-09-27）**：

- `upload.py` 部署完成，服务 `active` / `NRestarts=0`，启动日志四段齐全（account store / alipay f2f / recharge / admin platform / apps market）。
- 管理台：`https://www.mt-agent.com/mtnode/admin/` → 200 且内容真是管理台（5046B，含 CSP 与 noindex）；`admin.css` / `admin.js` 200；无尾斜杠 → 302；目录穿越 404。
- 线上验收脚本两遍全绿：`--base=http://127.0.0.1:8787`（服务器上）43/43、`--base=https://www.mt-agent.com/mtnode/store-api`（过 nginx）43/43。
- 应用密钥对已在服务器生成（`/etc/mtnode-store/alipay/`，私钥 0600，未回显未外传），`--check` 自检 OK。
- `/etc/mtnode-store.env` 已追加支付宝段（`APPID` 待填、`_PRIVATE_KEY_PATH` 已就位、`_PUBLIC_KEY_PATH` 待取消注释、`_NOTIFY_URL` 用 www）；`pay-status` 现回 `missing: [MTNODE_ALIPAY_APPID, MTNODE_ALIPAY_PUBLIC_KEY]`、`hasNotifyUrl: true`、`notifyWarning: ""`。
- 微信归属迁移：dry-run 报「该 unionid 已在目标账号 ms2308 上 → 无需处理」（用户此前在登录态下扫码，已走服务端合并分支归位），所以管理台扫码即可登录，本轮**没有**改写任何账户数据。
- 回滚位：`/opt/mtnode-store/rollback/{server.mjs,mt-ai-router.conf,mtnode-store.service,mtnode-store.env}.<时间戳>.bak`。

**凭据已配齐、签名链路已线上验证（2026-09-27 第二轮）**：

- 用户在开放平台粘完应用公钥后，把「支付宝公钥」（`alipayPublicKey_RSA2.txt`，裸 base64 单行）交回；
  已存成 `/etc/mtnode-store/alipay/alipay_public_key.pem`（0600，服务端 `toPem` 也认裸 base64），
  `MTNODE_ALIPAY_APPID=2021007103641366`、`_PUBLIC_KEY_PATH` 已取消注释；改 env 前备份到
  `/opt/mtnode-store/rollback/env-<时间戳>`。
- `pay-status` → `configured: true`、`missing: []`、`gatewayWarning: ""`、`notifyWarning: ""`；`/api/health` 的 `recharge.payConfigured: true`。
- **签名链路真跑通**（决定性证据）：`alipay.trade.query` 一笔不存在的单 → `ACQ.TRADE_NOT_EXIST`「交易不存在」，
  且**响应验签通过**（否则会回 `ALIPAY_SIGN_INVALID`）＝ APPID 有效、服务器上的应用私钥与控制台里的应用公钥是一对、
  刚装的支付宝公钥能验接口响应。
- 途中修掉一个真缺陷：`DEFAULT_GATEWAY` 写成了 `/router/rest`（网页端地址，会 302 到登录页）→ 全部接口
  `ALIPAY_HTTP_302`。已改 `/gateway.do` + `gatewayWarning()` 体检 + 3xx 报错点名 + `deploy.sh` 的 `pay-gateway` 自检（见 §9.3）。
  本轮只定向推送 `alipay-provider.mjs`（md5 与本地逐一核对），**没有**动线上 `server.mjs`（本地正被另一会话共编）。
- **唯一剩余阻塞在支付宝控制台侧**：`alipay.trade.precreate`（当面付）回 `40004 ACQ.ACCESS_FORBIDDEN` = 该应用未签约「当面付」；
  同一 APPID 的 `alipay.trade.page.pay`（电脑网站支付）与 `alipay.trade.wap.pay`（手机网站支付）实测**已签约可用**（见 §9.3 表）。

**剩余（需要人工决定 / 操作）**：

1. 二选一：① 在开放平台给该应用签约「当面付」（需企业/个体工商户主体，可能有审核周期）→ 现有扫码流程零改动直接可用；
   ② 或把支付通道改走**已签约的电脑网站支付**（`page.pay`）：充值窗改为「去支付」打开系统浏览器收银台，
   入账仍走 notify + `trade.query` 轮询（`query` 已实测可用），需改 `alipay-provider.mjs` + `server.mjs` 的 create 路由 + `app-wallet.js` 的付款码区。
2. 通道打通后做真机 ¥1 实付验证：客户端（账号 `ms2308`）下单 → 付款 → 自动入账 → 余额与流水正确 → 管理台可见该单 → 退款 ¥1 走通
   （`refund` / `close` 的权限只能在有真实交易后验证）。全部通过后再考虑放开 `MTNODE_RECHARGE_USERS` 与客户端 `VISIBLE_USERS`（**两处都要改**才算真正上线）。


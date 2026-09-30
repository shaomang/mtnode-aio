# MTNode 中转服务（AI 中转站）· 管理台与客户端同步

> 服务端实现：`store-saas/relay.mjs` + `store-saas/server.mjs` + `store-saas/admin/`；
> 客户端实现：`main.js`（`relay:me` / `providerAuthKey`）+ `preload.js` + `renderer/app-relay.js` +
> `renderer/app-settings.js`（只读服务商卡）。
> 回归：`test/smoke-relay.js`（服务端 · 96+ 项）与 `test/smoke-relay-client.js`（客户端 · 静态钉死）。

## 一、这份东西解决什么

1. **管理员界面 ↔ 中转服务打通**：管理台「中转服务」页配置上游模型提供商（Base URL / 通道 /
   超时 / API Key）、上架本中转站对外的模型清单（模型 id ↔ 上游、按行价目）、改动留痕与用量账；
   页内还有**会话测试**：发一张 30 分钟的 `mtr_test_` 短时 Key 打 `/relay/v1/*`，按真实用量
   扣当前管理员账号，用来确认「这条链路真的能用」。
2. **清单自动进 MTNode 的提供商**：客户端「设置 · 提供商」里出现一张**只读**的
   「MTNode 中转服务」卡，地址与模型清单由云端下发；登录成功、充值成功、打开该卡（快照 >24h）
   与手动「刷新」都会同步。
3. **只对有充值的账号开放**：从没充过值的账号在客户端连这张卡都没有（`everRecharged=false`）；
   有过充值（支付充值或后台人工调账）就**永久显示**，余额花光只置灰，不消失。

## 二、服务端接口

**金额口径（本轮共识）：一律「元」，4 位小数（0.0001 元）** —— 界面上、接口字段里都不出现「分」，
也不出现美元与汇率：文本按「元 / 百万 token」计价，图像直接按「元 / 张」计价（`perImageYuan`）。
钱包内部的 `balanceCents` + `relaySubCents` 只是**内部存储**（见 `wallet.mjs`），出接口时用
`yuanOfCents()` 换算成元，入参用 `centsOfYuan()` 换算回分；字段名统一 `*Yuan`
（`balanceYuan` / `totalYuan` / `spentYuan` / `costYuan` / `chargedYuan` / `shortfallYuan` /
`amountYuan` / `refundedYuan` / `deltaYuan` / `balanceAfterYuan` / `tiersYuan` / `minYuan` /
`maxYuan` / `perImageYuan`）。旧配置里的 `perImageUsd` 读入时按固定 1 美元 = 7 元折成元/张，
之后只认元。

| 接口 | 谁用 | 说明 |
| --- | --- | --- |
| `GET /relay/v1/models` | 中转客户端 | 鉴权 = 账号登录 token（或 `mtr_test_` 测试票）；无 token → 401 |
| `POST /relay/v1/chat/completions` | 文本 / 识图 | 自动注入 `stream_options.include_usage`（计费要 usage） |
| `POST /relay/v1/images/generations` `…/images/edits` | 图像 | 图像按张计价；客户端中途断开也照扣（上游计费口径） |
| `GET /relay/v1/usage` | 自查 | 回余额、已扣、最近明细（字段一律 `*Yuan`，元 / 4 位小数） |
| `GET/POST /api/admin/relay` `…/config` `…/upstream-models` `…/audit` `…/usage` `…/test-key` | 管理台 | 读配置 / 保存并热生效 / 拉上游模型名 / 留痕 / 用量 / 发测试 Key |
| `GET /api/relay/me` | **客户端同步** | 见下节；未登录 401 |

门禁：可用余额（**元**）≤ 0 的账号一律 402 `insufficient_quota`，
`/api/relay/me` 同时回空清单 —— 两处口径必须一致，不诱导用户白跑。

## 三、客户端同步契约（`GET /api/relay/me`）

```jsonc
{
  "ok": true,
  "baseUrl": "https://www.mt-agent.com/mtnode/store-api/relay/v1", // 地址只由服务端下发，客户端不硬编码
  "providerName": "MTNode 中转服务",
  "enabled": true,          // = 模型清单非空（= 可用余额 > 0）
  "everRecharged": true,    // = 本人账本里有 recharge 或**正向 adjust**（人工调账也算）
  "balanceYuan": 0.3536,    // 可用余额（元，4 位小数；内部存储仍是整数分 + 亚分零头，不出接口）
  "totalYuan": 0.3536,      // 界面显示的可用余额（= balanceYuan）
  "models": [{ "id": "deepseek-flash", "kind": "text", "upstream": "deepseek" }],
  "reason": "",             // 清单为空时给出可执行的原因（「充值后即可使用」）
  "updatedAt": 1730000000000
}
```

两条硬约定（都被回归钉住）：

- **`models[].kind` 是通道形态 `text` / `image`**，不是上游 id。生产配置的上游 id 叫
  `deepseek` / `image`，客户端判不出形态、图像节点会选不到模型，所以 `relay.mjs` 的
  `userModels()` 统一映射成 `text` / `image`，客户端把它写进
  `config.modelKinds["mtnode-relay"]`（与用户手工纠正形态同一张覆盖表）。
- **`everRecharged` 只认本人流水**：整账本里有别人的充值不算；`recharge`（支付）与
  `adjust` 且金额为正（后台人工调账）都算。

## 四、客户端行为（`renderer/app-relay.js`）

同步时机：**登录成功后**（账号变了必重拉）、**充值成功后**（余额 0 → 正，立刻回拉）、
**打开该卡 / 打开设置**（快照 >24h 才拉）、**手动「刷新」**（提供商页标题栏与卡里各一个）。

落进 `config.json` 的形状：

```jsonc
{
  "id": "mtnode-relay",
  "name": "MTNode 中转服务",
  "source": "mtnode-relay",
  "type": "text_openai",              // 文本 + 图像混挂一张卡，靠 modelKinds 区分形态
  "baseUrl": "…由云端下发…",
  "apiKey": "mtnode-account-token",   // **占位串**，真凭据不落盘（见第五节）
  "vision": true,
  "models": ["deepseek-flash", "gpt-image-2.5-vip"], // 当前**可选**清单；余额耗尽时为空
  "relay": {
    "everRecharged": true,
    "models": ["…"],      // 最近一次成功快照（置灰时仍列给用户看）
    "kinds": { "deepseek-flash": "text" },
    "at": 1730000000000,  // 上次成功同步
    "error": "",          // 上次失败原因（失败沿用旧快照，只挂原因）
    "balanceYuan": 0.3536, "totalYuan": 0.3536,
    "blocked": false      // true = 余额耗尽 / 服务端回空清单
  },
  "disabled": false       // 用户手动停用（刷新不会自动开回来）
}
```

| 情形 | 行为 |
| --- | --- |
| 从没充过值 / 退出登录 / 换到没充值的账号 | **连卡都不建**（已存在则收掉），模型选择器里自然也没有它 |
| 有过充值、余额 > 0 | 卡正常，模型可选；用户可调本机优先级、可手动停用 |
| 有过充值、余额耗尽 | 卡**永久在**但整卡置灰、标「余额不足，充值后刷新」，`models` 为空 ⇒ 各处模型选择器里列不到它（不允许被引用）；画布上早已绑着它的节点保持原样，运行前由 `main.js` 的 `checkProvider` 给出可执行的错 |
| 拉取失败（断网 / 服务不可用） | 沿用上次成功快照，卡上标「刷新失败：原因 + 上次同步时间」；没有快照时什么都不建 |
| 手动停用后刷新 | 尊重用户：不会自动启用（卡上标「已停用」，勾回来即可） |
| 位置 | 名下还有别的「真能用」的服务商（有 Key 有地址）⇒ 追加到末尾；一个都没有 ⇒ 置顶为当前优先使用。已有位置在刷新时保持不变 |

只读边界：**类型 / 形态 / 名称 / Base URL / API Key / 模型清单全部只读**（`<code>` 展示，
`relay-ro`），能改的只有「启用开关」与「本机优先级 ↑↓」；**不提供删除**，也不提供
「复制为自定义服务商」。选不到 ≠ 消失：卡照旧在设置里，用户看得见、能恢复。

## 五、凭据链（明文 token 一辈子不进 config.json）

1. 中转站的 Key **就是账号登录 token**（`relay-key.mjs` 用 account-store 的会话表发放，
   人工跑：`node relay-key.mjs --user <用户名> [--days 7] [--list] [--json]`）。
2. 客户端登录后 token 由主进程 `auth-store.js`（safeStorage 加密）保管，**绝不回传渲染层**。
3. 配置里只落占位串 `mtnode-account-token`：渲染层各处「有没有填 Key」的闸门因此照旧通过，
   而请求下发前由 `main.js` 的 `providerAuthKey()` 换成真 token：
   - 普通节点 / 会话模型调用：`buildRequestSpec()` 的 Authorization；
   - 智体会话（DSH 网关）：`dshParamsWithRelayKey()` 把 `apiKey` / `mtnodeProviders[].apiKey` 换掉；
   - 主进程插件宿主（Music3 / H3）：`dsh/mtnode-llm-creds.js` 的 `setRelayKeyResolver()`
     由 `main.js` 注入同一解析器；解析不到（独立进程解不开加密凭据）就**跳过该服务商**，
     宁可信报「未配置可用的文本服务商」，也不拿占位串去撞 401。
4. 渲染层不出现中转站地址：`test/smoke-relay.js` 的 [2] 扫描 `renderer/*.js`，命中
   `store-api/relay` 即失败（`source` 标识 `mtnode-relay` 是本地来源标记，允许存在）。

## 六、部署与上线

```bash
# 本机（仓库根）：上传 store-saas（整目录——写进 deploy.sh 的文件一个都不能漏）
python store-saas/upload.py            # → 服务器 /tmp/mtnode-store-upload
# 服务器：
bash /tmp/mtnode-store-upload/deploy.sh
```

`deploy.sh` 会把 `relay.mjs` / `relay-key.mjs` / 管理台三件套装到 `/opt/mtnode-store` 与
`/var/www/mtnode/admin`，跑 `patch-nginx.py`（新增 `location ^~ /mtnode/store-api/relay/`，
`proxy_buffering off` + 长读超时），重启服务，并在末尾自查：`relay-auth`（无 token 打
`/relay/v1/models` 必须 401）、`relay-env`（`MTNODE_RELAY_DEEPSEEK_KEY` /
`MTNODE_RELAY_IMAGE_KEY` 在不在 `/etc/mtnode-store.env`）、管理台页面与 CSP frame-src。

上游 Key 只走环境文件（`store-saas/relay.env.example` 是模板），**代码里没有任何 Key**，
`db.json` 也不会把 env 兜底的 Key 搬进库；管理台只回 `keyFrom` / 后四位。

## 七、已知边界

- 管理台「会话测试」按真实用量从管理员账号扣费（测试即计费），不是 dry-run。
- 插件宿主独立进程里若解不开 safeStorage 凭据，中转服务商在那边不可用（见第五节 3）——
  这是刻意选择：宁可明确报「没有可用服务商」，也不发出一个必然 401 的假 Key。
- 客户端快照写在 `config.json` 的 provider 上（设备本地），换机器后首次登录会重新拉。

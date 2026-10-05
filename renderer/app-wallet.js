/* 余额（钱包）：余额展示 + 支付宝扫码充值 + 订单/流水查看。
 *
 * 口径（与云端 store-saas 一致，详见 docs/recharge-design.md）：
 *   · 传输与存储一律「元」（4 位小数）：服务端只下发 / 只接收元，前端不做分↔元换算，
 *     也不做算术决策。
 *   · **界面一律「鲸圆币」**（1 币 = ¥0.02，见 renderer/app-whalecoin.js）：余额、档位、
 *     订单与流水都以币显示（余额四舍五入取整、<0.5 币显示「<1 币」）；只有两处仍写元 ——
 *     支付宝实际收付的「实付金额」与部分退款说明。用户按币选档位 / 输入币数，提交给云端
 *     的仍是元（yuanOfCoins 反算，最多 2 位小数）。
 *     可用性与上下限判定始终按真实元值，不因为显示取整而改口径。
 *   · 入口**对所有已登录账号开放**（原来的测试期白名单账号常量已去掉，见 visibleFor）；
 *     云端 MTNODE_RECHARGE_USERS 同步放开，两边一致才算真正上线。服务端另有
 *     403 RECHARGE_NOT_OPEN 兜底（服务端还没部署到新版时用户会看到它）。
 *   · 下单成功才展示二维码（服务端先向支付宝预下单、再落本地订单），轮询只查自己的订单。
 *   · 弹窗 persistent + 可最小化；关闭 / 被别的弹窗顶掉后，轮询必须停（用代次 gen + isConnected 双保险）。
 *
 * 依赖：window.api.storeRequest（主进程统一带 Bearer）、app.js 的 openOverlay、
 *       window.MtCoin（换算与金币图标）、I18n。
 */
(function () {
  "use strict";

  /* 档位（元）：2 / 10 / 20 / 50 = 100 / 500 / 1000 / 2500 币。中转定位「临时使用」，
     档位一律 ≤ ¥50（= 2500 币），与 store-saas/wallet.mjs 的 RECHARGE_TIERS_CENTS 同源；
     服务端 tiersYuan 回来后按真值重画（见 loadConfig）。 */
  var FALLBACK_TIERS = [2, 10, 20, 50];
  /* 客户端硬闸（本轮需求的真口径，云端**只允许更严**）：单笔档位 ≤ ¥50（2500 币）、
     自定义 ¥2 – ¥100（100 – 5000 币）。线上服务还是老版本时它回的是旧档位
     （¥100 / ¥1000 这种大额），照单收下就等于把收紧口径又弹回去了 —— 所以档位与
     上下限一律经 clampTiers / Math.max·min 过滤，见 loadConfig。 */
  var TIER_MAX_YUAN = 50;
  var MIN_YUAN_FLOOR = 2;
  var MAX_YUAN_CEIL = 100;
  /* 生效值：先用硬闸自身打底，云端配置回来后只允许更严（下限抬、上限压） */
  var MIN_YUAN = MIN_YUAN_FLOOR;
  var MAX_YUAN = MAX_YUAN_CEIL;
  var POLL_MS = 2000;

  /* 文案一律走 I18n.t；带变量的用 {占位} 键（第二参），不要拼接——英文语序不同会散架。 */
  function T(s, vars) {
    return window.I18n && window.I18n.t ? window.I18n.t(s, vars) : s;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  /* 金额一律「元」（显示保留 **1 位小数**，如 ¥10.0）：服务端只下发 / 只接收元，
     这里不做分↔元换算。**只在「实付金额」这类真正走支付宝的元金额上用**（如 ¥10.0）；
     余额 / 档位 / 订单流水这些账户资产走下面的 coin* 系列（鲸圆币）。 */
  function money(yuan) {
    return "¥" + Number(yuan || 0).toFixed(1);
  }
  /* 鲸圆币换算与元件（renderer/app-whalecoin.js）：模块缺席时退回纯数字，不炸界面 */
  function coinsOfYuan(y) {
    return window.MtCoin ? window.MtCoin.coinsOfYuan(y) : Number(y || 0) * 50;
  }
  function yuanOfCoins(c) {
    return window.MtCoin ? window.MtCoin.yuanOfCoins(c) : Math.round(Number(c || 0) * 2) / 100;
  }
  function coinNum(coins) {
    return window.MtCoin ? window.MtCoin.coinNumText(coins) : String(Math.round(Number(coins) || 0));
  }
  /* 「金币 + 数量」元件；opts 见 app-whalecoin.js 的 coinEl */
  function coinEl(value, opts) {
    if (window.MtCoin && window.MtCoin.coinEl) return window.MtCoin.coinEl(value, opts);
    return el("span", "coin-amt", coinNum(value));
  }
  /* 鲸圆币图标元件（本轮口径：币数后面跟它，不再写「币」字） */
  function coinIconOf(size) {
    if (window.MtCoin && window.MtCoin.coinIcon) return window.MtCoin.coinIcon(size);
    return el("span", "coin-ico ico-miss");
  }
  /* 余额元件（自动处理 <1 币的零头文案） */
  function balanceEl(yuan) {
    if (window.MtCoin && window.MtCoin.balanceEl) return window.MtCoin.balanceEl(yuan);
    return el("span", "coin-bal", coinNum(coinsOfYuan(yuan)));
  }
  /* 入口可见性：**只要登录了就一定显示**余额行与「余额（充值）」入口，未登录整块不显示
     （余额是账号资产，没有账号就无处可取）。
     **判据只认「有没有账号对象」，不再看用户名、余额、有没有中转卡**：
     充值入口是全应用唯一那一个（右上角账户菜单），它一旦跟着数据缺失一起消失，用户就
     再也找不到充值的地方 —— 现场症状正是「已充值账号连充值入口也没了」（老版本判据是
     用户名白名单，此后又要求 username 非空，账号摘要缺该字段时整块被吃掉）。
     判据留在本模块（app-auth.js 只问「能不能显示」，不自己抄一份账号名单）。 */
  function visibleFor(u) {
    return !!u;
  }
  /* 账号摘要里的余额是不是**有效数字**（0 也算：真的花光了）——
     旧版服务端的 PublicUser 不含 balanceYuan，undefined 绝不能被当成 0。 */
  function snapshotBalance(u) {
    var raw = u && u.balanceYuan;
    if (raw == null || raw === "") return null;
    var n = Number(raw);
    return isFinite(n) ? n : null;
  }
  /* 供界面显示用：本机账号摘要有效就用它，否则退回从 /api/wallet/summary 现拉的值；
     两边都没有回 0（只给算术 / 判定用，界面另看 balanceKnownYuan）。 */
  function balanceOf(u) {
    var snap = snapshotBalance(u);
    if (snap != null) return snap;
    var known = balanceKnownYuan();
    return known == null ? 0 : known;
  }
  /* 已确知的余额（元）：只有真取到过才算数，没取到回 null（界面据此显示「—」）。
     注意：**取不到 ≠ 0** —— 从没取到过显示「—」；取到过之后再现拉失败，保留上次已知值
     （ST.balanceFrom 不被改写），绝不把余额清零、也不把已知值降级成未知。 */
  function balanceKnownYuan() {
    return ST.balanceFrom ? ST.balanceYuan : null;
  }
  /* 余额取数时间（ms）：跟着「真取到过」的余额走，界面据此显示「更新于 HH:MM」。
     一次都没取到过 = 0（此时界面显示「—」，没有时间可报）。 */
  function balanceTimeMs() {
    return ST.balanceFrom ? ST.balanceAt : 0;
  }
  /* 把一次钱包摘要里的余额写进状态（余额的**唯一**权威入口，见 loadSummary）。
     只有服务端真的给了有效数字才认：0 算有效（真的花光了），null / 空串一律不认。 */
  function applyWalletBalance(raw) {
    if (raw == null || raw === "") return false;
    var n = Number(raw);
    if (!isFinite(n)) return false;
    ST.balanceYuan = n;
    ST.balanceFrom = "wallet";
    ST.balanceAt = Date.now();
    return true;
  }
  /* 一次在途的余额补拉。**并发去重**：账号菜单、余额窗、充值成功后可能同时来问。
     force=true 时即使 60s 缓存还有效也真去打一次（余额窗与账号菜单每次打开都走它：
     用户要的是「打开就看到当前余额」，不是「最多 60 秒前的余额」）。
     失败不写状态（保留上次已知值），界面绝不被清零。 */
  var BAL_CACHE_MS = 60 * 1000;
  var balanceFetchedAt = 0;
  var balanceFetching = null;
  function ensureBalance(force) {
    if (balanceFetching) return balanceFetching;
    if (!force && balanceFetchedAt && Date.now() - balanceFetchedAt < BAL_CACHE_MS) {
      return Promise.resolve(balanceKnownYuan());
    }
    balanceFetching = api("GET", "/api/wallet/summary?limit=1")
      .then(function (r) {
        if (!r || !r.ok || !r.data) {
          /* 这次没取到：保留上次已知值，并把它标成「可能不是最新」（见 paintBalance）；
             401 = 会话过期，记下来供余额行给一键重登（见 paintAuthNote）。 */
          if (balanceKnownYuan() != null) ST.balanceStale = true;
          ST.balanceErr = Number(r && r.status) === 401 ? "401" : "other";
          return balanceKnownYuan();
        }
        balanceFetchedAt = Date.now();
        ST.balanceErr = "";
        /* 摘要里的余额是**权威来源**（见 loadSummary 同一口径） */
        if (applyWalletBalance((r.data.wallet || {}).balanceYuan)) ST.balanceStale = false;
        return balanceKnownYuan();
      })
      .catch(function () {
        if (balanceKnownYuan() != null) ST.balanceStale = true;
        ST.balanceErr = "other";
        return balanceKnownYuan();
      })
      .then(
        function (v) {
          balanceFetching = null;
          return v;
        },
        function () {
          balanceFetching = null;
          return balanceKnownYuan();
        },
      );
    return balanceFetching;
  }
  function tsText(ms) {
    if (!ms) return "—";
    var d = new Date(Number(ms));
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  var CODE_TEXT = {
    ALIPAY_UNAVAILABLE: "支付通道尚未配置，暂时无法充值",
    RECHARGE_NOT_OPEN: "充值功能尚未对该账号开放",
    INVALID_AMOUNT: "金额无效",
    TOO_MANY_PENDING: "未支付订单过多，请先完成或等其过期",
    RATE_LIMITED: "请求过于频繁，请稍后再试",
    ORDER_NOT_FOUND: "订单不存在或已失效",
    UNAUTHORIZED: "请先登录",
    ALIPAY_ERROR: "支付宝接口异常，请稍后重试",
  };

  var ST = {
    cfg: null,
    balanceYuan: 0,
    /* 余额是否真的取到过：
       · "snapshot" = 来自本机账号摘要（auth-store 的 user.balanceYuan，旧版服务端可能是 undefined）
       · "wallet"   = 来自 /api/wallet/summary 现拉
       · ""         = 谁都没给过 → 界面显示「—」而不是「0 币」
       缺这个标记时，「快照里没有余额字段」与「余额真的是 0」在界面上长得一模一样，
       这正是「已充值账号余额显示 0」的观感来源。 */
    balanceFrom: "",
    /* 余额取数时间（ms）：与 balanceFrom 同源 —— 有来源才有时刻。
       界面只在 *这次没拉到* 时把它显示出来（见 paintBalance 的 stale 分支）。 */
    balanceAt: 0,
    /* 最近一次余额现拉是不是失败了：
       false = 界面上的数字就是刚取回来的；true = 这次没取到，显示的是上次已知值 ——
       此时余额行旁边标出它的取数时刻，用户能自己判断新旧；从没取到过则显示「—」。 */
    balanceStale: false,
    /* 最近一次余额现拉的失败档（""|"401"|"other"）：401 = 会话过期（余额行给一键重登），
       other = 暂时取不到（只说明原因）。两个都不改登录态、不清余额 —— 见 paintAuthNote。 */
    balanceErr: "",
    tiers: FALLBACK_TIERS.slice(),
    pickedYuan: 0,
    order: null,
    orders: [],
    ledger: [],
    gen: 0,
    timer: 0,
    busy: false,
    root: null,
    // 已经自动弹过浏览器收银台的订单号：每笔单只自动开一次（重绘 / 轮询不重复弹窗）。
    autoOpened: "",
  };

  function api(method, path, json) {
    return window.api.storeRequest({ method: method, path: path, json: json });
  }

  function errText(r) {
    var code = r && r.data && r.data.code;
    if (code && CODE_TEXT[code]) return T(CODE_TEXT[code]);
    var raw = r && r.data && r.data.error;
    if (raw) return String(raw);
    if (r && r.status) return T("请求失败（HTTP {code}）", { code: String(r.status) });
    return T("网络请求失败");
  }

  /* 支付完成后同步账号快照（余额）：主进程 /api/me → 落盘 → 重绘账号菜单。 */
  function refreshUser() {
    return Promise.resolve()
      .then(function () {
        return window.api && window.api.authMe ? window.api.authMe() : null;
      })
      .catch(function () {
        return null;
      })
      .then(function () {
        if (window.MTNodeAuth && window.MTNodeAuth.refresh) return window.MTNodeAuth.refresh();
      })
      .catch(function () {
        /* 刷新失败不影响充值结果本身，余额下次打开会重新拉 */
      });
  }

  function stopPoll() {
    if (ST.timer) {
      clearTimeout(ST.timer);
      ST.timer = 0;
    }
  }

  function dialogAlive() {
    return !!(ST.root && ST.root.isConnected && ST.gen === liveGen);
  }
  var liveGen = 0;

  /* ---------- 数据加载 ---------- */

  /* 云端档位 → 客户端硬闸（只留 ¥2 – ¥50 之间的档；去重、升序、空则用兜底）。
     旧版服务端会回 ¥10/100/1000 这种大额档，必须在**画之前**滤掉。 */
  function clampTiers(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (y) {
      var v = Number(y);
      if (!isFinite(v) || v <= 0) return;
      if (v < MIN_YUAN_FLOOR || v > TIER_MAX_YUAN) return;
      if (out.indexOf(v) < 0) out.push(v);
    });
    out.sort(function (a, b) {
      return a - b;
    });
    return out.length ? out : FALLBACK_TIERS.slice();
  }

  function loadConfig() {
    return api("GET", "/api/wallet/config")
      .then(function (r) {
        if (r && r.ok && r.data) {
          ST.cfg = r.data;
          if (Array.isArray(r.data.tiersYuan) && r.data.tiersYuan.length) ST.tiers = clampTiers(r.data.tiersYuan);
          /* 上下限：云端只允许**更严**（下限只能抬高、上限只能压低），否则线上老服务端
             的 maxYuan=1000 会把界面又拉回大额。 */
          if (Number(r.data.minYuan)) MIN_YUAN = Math.max(MIN_YUAN_FLOOR, Number(r.data.minYuan));
          if (Number(r.data.maxYuan)) MAX_YUAN = Math.min(MAX_YUAN_CEIL, Number(r.data.maxYuan));
          /* 界面是在配置回来**之前**用兜底值画的：档位、金额上下限、主按钮文案都要按服务端
             真值重画一次，否则 env 调过限额时，输入框的 min/max 与「100 – 5,000」提示还停在
             兜底值，与实际校验口径不一致（限额仍是元口径，界面按 50:1 换算成币显示）。 */
          if (ST.tiers.indexOf(ST.pickedYuan) < 0) ST.pickedYuan = ST.tiers[0];
          paintTiers();
          paintCustomRange();
          /* opened=false（服务端闸门未开）→ 当场把充值块换成说明块：
             用户不会点了才知道，也不会只拿到一句 403 红字（见 paintRecharge）。 */
          paintRecharge();
        }
      })
      .catch(function () {
        ST.cfg = null;
      });
  }

  function loadSummary() {
    return api("GET", "/api/wallet/summary?limit=10")
      .then(function (r) {
        if (!r || !r.ok || !r.data) throw r;
        /* 这一次现拉成功了：清掉上一次的失败标记（余额行那条提示跟着撤掉） */
        ST.balanceErr = "";
        var w = r.data.wallet || {};
        /* 订单与流水：历史区（paintHistory）只读这两个数组，摘要回来了就整批换掉 */
        ST.orders = Array.isArray(w.orders) ? w.orders : [];
        ST.ledger = Array.isArray(w.ledger) ? w.ledger : [];
        /* 余额来源优先级：以 /api/wallet/summary 的服务端口径为准（它直读账户行的余额），
           账号摘要的 balanceYuan 只作补充 —— 快照缺字段（旧版服务端）或还没刷新时，
           这一条就不会在界面留下 0。
           注：这里原本写作「两个星号加粗 + 斜杠开头的路径」，而那两个星号紧跟斜杠会把块注释
           提前闭合 —— app-wallet.js 整只脚本当场语法报错、window.MtWallet 根本不挂载，
           于是账号菜单的余额行与「余额」入口一起消失（现场就是「连充值入口也没了」）。
           本文件的注释里同样不要出现反引号（与上面那个坑同源，都会让整只脚本报错）。 */
        var n = Number(w.balanceYuan);
        if (w.balanceYuan != null && isFinite(n)) {
          ST.balanceYuan = n;
          ST.balanceFrom = "wallet";
          ST.balanceAt = Date.now();
          ST.balanceStale = false;
        }
        if (r.data.user) {
          var raw = r.data.user.balanceYuan;
          var b = Number(raw);
          /* 只有摘要里给了**有效数字**才认（0 也认：真的花光了）；undefined / 空串不再当 0。 */
          if (raw != null && raw !== "" && isFinite(b) && !ST.balanceFrom) {
            ST.balanceYuan = b;
            ST.balanceFrom = "snapshot";
            ST.balanceAt = Date.now();
          }
        }
        return true;
      })
      .catch(function (e) {
        /* 现拉失败：**保留上次已知值**（不清零、也不降级成未知）并标成可能过期，
           界面上那个数字旁边会带上它的取数时刻；从没取到过才显示「—」。
           401 = 会话过期：余额行给「登录已过期，点这里重新登录」（不擅自清登录态，
           见本文件头与 app-auth.js 的口径）；其余失败 = 暂时取不到。 */
        if (balanceKnownYuan() != null) ST.balanceStale = true;
        ST.balanceErr = Number(e && e.status) === 401 ? "401" : "other";
        setNotice(errText(e), "err");
        return false;
      });
  }

  /* ---------- 界面 ---------- */

  function setNotice(text, kind) {
    if (!dialogAlive()) return;
    var n = ST.root && ST.root.querySelector("#wlNotice");
    if (!n) return;
    n.textContent = text || "";
    n.className = "wl-notice" + (kind ? " " + kind : "") + (text ? "" : " hidden");
  }

  /* 会话过期 / 暂时取不到的提示（余额窗的余额行里那半句）：
     401 → 「登录已过期，点这里重新登录」（点它开现有登录窗，成功后原地刷新余额）；
     其它失败 → 「余额暂时取不到，稍后重试」。两种都在同一条 tip 上原地改写，不叠节点。 */
  function paintAuthNote(host) {
    if (!host) return;
    var old = host.querySelector(".wl-authhint");
    var txt = "";
    if (ST.balanceErr === "401") txt = T("登录已过期，点这里重新登录");
    else if (ST.balanceErr) txt = T("余额暂时取不到，稍后重试");
    if (!txt) {
      if (old) old.remove();
      return;
    }
    var n = old || el("span", "wl-authhint tip-stat-warn-t");
    n.textContent = txt;
    n.classList.toggle("clickable", ST.balanceErr === "401");
    n.title = ST.balanceErr === "401" ? T("点这里重新登录") : "";
    if (!old) {
      /* 点它 = 一键重登（只 401 时是活的；其余失败只是说明） */
      n.addEventListener("click", function () {
        if (ST.balanceErr === "401") openRelogin();
      });
      host.appendChild(n);
    }
  }

  /* 一键重登：走 app-auth.js 的登录窗（全应用唯一入口），成功后原地刷一次余额 */
  function openRelogin() {
    var A = window.MTNodeAuth;
    if (A && typeof A.open === "function") {
      A.open();
      return;
    }
    setNotice(T("请先登录"), "err");
  }

  function paintBalance() {
    if (!dialogAlive()) return;
    var v = ST.root.querySelector("#wlBalance");
    if (!v) return;
    /* 余额以鲸圆币显示（原本读的是 balanceYuan 的元值，显示时换算）；判定不改口径。
       **取不到 ≠ 0**：一次都没取到过显示「—」（显示成「0 币」会让人以为钱没了）；
       取到过之后再现拉失败，保留上次已知值，并在它旁边标出取数时刻（用户能看到这是旧数）——
       取数正常时不显示时间，免得每次打开都多一行噪音。
       401（会话过期）与「暂时取不到」分档：前者给一键重登，后者只说清原因（见 paintAuthNote）。 */
    v.textContent = "";
    if (balanceKnownYuan() == null) {
      v.appendChild(el("span", "coin-bal coin-unknown", "—"));
      paintAuthNote(v);
      return;
    }
    v.appendChild(balanceEl(ST.balanceYuan));
    if (ST.balanceStale && balanceTimeMs()) {
      /* 键是不带空格的「更新于」（i18n 里有 EN 词条），空格由这里拼 ——
         键里带尾部空格会让 EN 查表落空（英文界面会显示中文），已踩过。 */
      var at = el("span", "coin-time muted", T("更新于") + " " + tsText(balanceTimeMs()).slice(11));
      at.title = T("这次没取到最新余额，显示的是上次取到的值");
      v.appendChild(at);
    }
    paintAuthNote(v);
  }

  /* 充值块是否可用：服务端 /api/wallet/config 的 opened（判据在服务端 rechargeAllowed：
     已登录即开放，除非运维用 MTNODE_RECHARGE_CLOSED 全局关闸）。
     配置还没拉回来时按「可用」画（老服务端不回这个字段时不能把入口锁死），
     拉回来若为 false 才换成说明块。 */
  function rechargeOpened() {
    return !(ST.cfg && ST.cfg.opened === false);
  }

  /* 重画充值块：可用 = 金额档位 / 自定义金额 / 支付宝付款按钮（原来的那一块）；
     不可用 = 换成说明块，付款按钮从 DOM 里摘掉（不是置灰 —— 置灰的按钮点不动也不说原因），
     余额与流水照旧显示（它们只是读账户，不受充值闸门影响）。
     **付款按钮只由 pickEl 建**（它和档位同一行，按 id 找得到即可）：这里不再另建一个
     挂在宿主上的按钮 —— 那一个在下一次 pickEl 重建时本来就会被整块换掉，留着只会让人
     以为有两条建按钮的路径。 */
  function paintRecharge() {
    if (!dialogAlive()) return;
    var host = ST.root.querySelector("#wlPick");
    if (!host) return;
    var opened = rechargeOpened();
    if (opened) {
      var old = host.querySelector("#wlClosed");
      if (old) old.remove();
      if (!host.querySelector("#wlTiers")) {
        host.textContent = "";
        host.appendChild(pickEl());
      }
      paintTiers();
      paintCustomRange();
      setBusy(ST.busy);
      return;
    }
    var pick = host.querySelector(".wl-pick");
    if (pick) pick.remove();
    if (!host.querySelector("#wlClosed")) {
      var box = el("div", "wl-closed");
      box.id = "wlClosed";
      box.appendChild(el("div", "wl-closed-t", T("充值暂未开放（服务端闸门未开启）")));
      box.appendChild(el("div", "wl-closed-l", T("当前账号可以查看余额与流水；充值入口由服务端决定，请稍后重试或联系管理员。")));
      host.appendChild(box);
    }
  }

  /* 金额选择块（档位 + 自定义金额 + 汇率 + 支付宝付款按钮）：档位与自定义都按**币**选，
     pay 之前才反算成元提交（见 createOrder）。整块由 paintRecharge 挂进 / 摘出 #wlPick —— 
     抽成函数是为了「闸门没开」时能原样摘掉再原样装回来（状态都在 ST 里，重装不丢选择）。
     付款按钮**与档位同一行**（.wl-tier-row，按钮在档位右侧）：原来它单独占一行且写着一行文字，
     现在按需求把那句文字直接换成支付宝 logo（官方方形标，画法见 alipayLogoEl / paintPayBtn）。 */
  function pickEl() {
    var pick = el("div", "wl-pick");
    /* 二维码区随充值块一起摘挂：闸门没开时不能留着上一单的二维码（它属于可支付的界面） */
    var qr = el("div", "wl-qr hidden");
    qr.id = "wlQr";
    pick.appendChild(qr);
    pick.appendChild(el("div", "wl-k", T("充值金额")));
    var row = el("div", "wl-tier-row");
    var tiers = el("div", "wl-tiers");
    tiers.id = "wlTiers";
    row.appendChild(tiers);
    /* 付款按钮跟着档位行一起画（同一行、档位右侧）：文案与 logo 由 paintPayBtn 按 busy 画 */
    var pay = el("button", "wl-btn wl-pay");
    pay.id = "wlPay";
    pay.type = "button";
    pay.onclick = createOrder;
    paintPayBtn(pay, false);
    row.appendChild(pay);
    pick.appendChild(row);
    var custom = el("div", "wl-custom");
    var inp = el("input");
    inp.id = "wlCustom";
    inp.type = "number";
    inp.min = String(Math.ceil(coinsOfYuan(MIN_YUAN)));
    inp.max = String(Math.floor(coinsOfYuan(MAX_YUAN)));
    inp.step = "1";
    inp.placeholder = T("自定义金额（币）");
    inp.addEventListener("input", function () {
      ST.pickedYuan = 0;
      paintTiers();
      setNotice("");
    });
    custom.appendChild(inp);
    var range = el("span", "wl-hint", coinNum(coinsOfYuan(MIN_YUAN)) + " – " + coinNum(coinsOfYuan(MAX_YUAN)));
    range.id = "wlRange";
    custom.appendChild(range);
    pick.appendChild(custom);
    /* 汇率提示（本行 = 全应用唯一可见的「¥1 = 50 币」）：
       需求口径「账户里不提示汇率，只在充值界面提示」—— 账号菜单余额行与设置里的
       中转卡余额都不再带汇率，只有这里明写一行，用户不必悬停才知道币值多少钱。 */
    var rate = el("div", "wl-rate muted", T("¥1 = 50 币（1 币 = ¥0.02）"));
    rate.id = "wlRate";
    pick.appendChild(rate);
    return pick;
  }

  /* 支付宝 logo（付款按钮的按钮面）＝随包的支付宝官方方形 logo 位图。
     为什么用位图而不是内联 SVG：需求就是把「去支付宝付款」这句文字直接换成**支付宝的 logo**，
     画的图形再像也不是官方标；这里用源文件里的官方方形标（蓝底白「支」+ 自带透明圆角），
     由构建期等比缩到 96px 落在 renderer/alipay-logo.png（源图是 2500px，直接随包没必要）。
     路径写法与 style.css / index.html 一致：app 里就是 renderer/index.html 同目录的裸文件名，
     相对路径按文档基准解析；档位上这条按钮挂的是 .wl-pay-logo（尺寸见 css/wallet.css）。
     文案不再画在按钮里（需求口径「直接改为 logo」），但按钮仍带 aria-label / title，
     读屏与悬停拿到的还是 i18n 的「去支付宝付款 / 生成支付宝付款码」（payLabel）。 */
  function alipayLogoEl() {
    var img = el("img", "wl-pay-logo");
    img.src = "alipay-logo.png";
    img.alt = "";
    img.draggable = false;
    return img;
  }

  /* 付款按钮画法（唯一一处）：常态 = 支付宝 logo 铺在按钮上（文案只留在 aria-label / title）；
     忙 = 换成「处理中…」文字（这时候再摆 logo 会像是还能点）。 */
  function paintPayBtn(btn, busy) {
    if (!btn) return;
    btn.textContent = "";
    var label = payLabel();
    btn.setAttribute("aria-label", label);
    btn.title = label;
    if (busy) {
      btn.appendChild(el("span", "wl-pay-t", T("处理中…")));
      return;
    }
    btn.appendChild(alipayLogoEl());
  }

  function paintTiers() {
    if (!dialogAlive()) return;
    var box = ST.root.querySelector("#wlTiers");
    if (!box) return;
    box.textContent = "";
    /* 档位来自云端 tiersYuan（元）：按钮显示币数，下方小字标出这一档实付多少元 ——
       用户的资产是币，但支付宝收的是元，两个数字都要看得见。 */
    ST.tiers.forEach(function (yuan) {
      var b = el("button", "wl-tier" + (ST.pickedYuan === yuan ? " on" : ""));
      b.type = "button";
      b.appendChild(coinEl(coinsOfYuan(yuan), { title: T("鲸圆币") }));
      b.appendChild(el("span", "wl-tier-yuan", money(yuan)));
      b.onclick = function () {
        ST.pickedYuan = yuan;
        var inp = ST.root.querySelector("#wlCustom");
        if (inp) inp.value = "";
        paintTiers();
      };
      box.appendChild(b);
    });
    var custom = el("button", "wl-tier" + (ST.pickedYuan === 0 ? " on" : ""), T("自定义"));
    custom.type = "button";
    custom.onclick = function () {
      ST.pickedYuan = 0;
      paintTiers();
      var inp = ST.root.querySelector("#wlCustom");
      if (inp) inp.focus();
    };
    box.appendChild(custom);
  }

  /* 金额上下限按服务端真值刷到输入框与提示上（配置回来之前用的是兜底值）。
     输入框收的是**币数**（整数），上下限由元口径换算而来。 */
  function paintCustomRange() {
    if (!dialogAlive()) return;
    var inp = ST.root.querySelector("#wlCustom");
    if (inp) {
      inp.min = String(Math.ceil(coinsOfYuan(MIN_YUAN)));
      inp.max = String(Math.floor(coinsOfYuan(MAX_YUAN)));
    }
    var hint = ST.root.querySelector("#wlRange");
    if (hint) hint.textContent = coinNum(coinsOfYuan(MIN_YUAN)) + " – " + coinNum(coinsOfYuan(MAX_YUAN));
  }

  /* 选中的充值金额（**币**）：点过档位取档位换算值，否则读自定义输入框。
     调用点只有 createOrder —— 提交前一律经 yuanOfCoins 反算成元。 */
  function pickedCoins() {
    if (ST.pickedYuan > 0) return coinsOfYuan(ST.pickedYuan);
    var inp = ST.root && ST.root.querySelector("#wlCustom");
    var v = inp ? Number(inp.value) : 0;
    if (!isFinite(v) || v <= 0) return 0;
    return Math.floor(v);
  }

  function paintQr() {
    if (!dialogAlive()) return;
    var panel = ST.root.querySelector("#wlQr");
    if (!panel) return;
    panel.textContent = "";
    var o = ST.order;
    if (!o) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    if (o.status === "paid") {
      panel.appendChild(el("div", "wl-qr-ok", "✓ " + T("充值成功")));
      /* 到账写币、实付写元（支付宝实际收的是元）；币数走图标口径（本轮：不再写「币」字） */
      var paidLine = el("div", "wl-qr-sub");
      paidLine.appendChild(document.createTextNode(
        T("{amount} 已到账", { amount: coinNum(coinsOfYuan(o.paidAmountYuan || o.amountYuan)) }),
      ));
      paidLine.appendChild(coinIconOf("sm"));
      panel.appendChild(paidLine);
      panel.appendChild(el("div", "wl-qr-sub muted", T("订单号：{id}", { id: o.id })));
      return;
    }
    if (o.status === "expired" || o.status === "closed") {
      panel.appendChild(el("div", "wl-qr-bad", T("订单已过期")));
      panel.appendChild(el("div", "wl-qr-sub muted", T("请重新发起充值")));
      return;
    }
    if (o.status === "paid_mismatch") {
      panel.appendChild(el("div", "wl-qr-bad", T("实付金额与订单不符")));
      panel.appendChild(el("div", "wl-qr-sub muted", T("已记录，请联系管理员核对后处理")));
      return;
    }
    /* 左栏按通道分两种画法（由订单实际带的字段决定，重开旧单也对）：
       · payUrl    电脑网站支付 → 「打开支付宝收银台」按钮，用系统浏览器付（页面自带二维码可手机扫）
       · qrDataUrl 当面付        → 窗内直接显示服务端自绘的付款二维码 */
    var left = el("div", "wl-qr-left");
    /* 支付金额按元写（支付宝收的确实是元），到账币数另起一行 —— 用户最关心的是「付多少、得多少」 */
    var coinsRow = el("div", "wl-qr-coins");
    coinsRow.appendChild(
      el("span", "", T("到账 ") + coinNum(coinsOfYuan(o.amountYuan))),
    );
    coinsRow.appendChild(coinIconOf("sm"));
    if (o.payUrl) {
      var go = el("button", "wl-btn primary wl-pay-open", T("打开支付宝收银台"));
      go.type = "button";
      go.onclick = function () { openPayUrl(o.payUrl); };
      left.appendChild(go);
      left.appendChild(el("div", "wl-qr-amount", T("实付 ") + money(o.amountYuan)));
      left.appendChild(coinsRow);
      left.appendChild(el("div", "wl-pay-hint muted", T("会在系统浏览器里打开支付宝收银台，可用手机支付宝扫码付款")));
      if (ST.autoOpened !== o.id) {
        // 用户刚点了「充值」，直接把收银台打开（每笔单只自动开一次，重绘不重复弹浏览器）。
        ST.autoOpened = o.id;
        openPayUrl(o.payUrl);
      }
    } else {
      var img = el("img", "wl-qr-img");
      img.alt = T("支付宝付款码");
      if (o.qrDataUrl) img.src = o.qrDataUrl;
      left.appendChild(img);
      left.appendChild(el("div", "wl-qr-amount", T("实付 ") + money(o.amountYuan)));
      left.appendChild(coinsRow);
    }
    panel.appendChild(left);

    var right = el("div", "wl-qr-right");
    right.appendChild(el("div", "wl-qr-title", o.payUrl ? T("在浏览器里完成支付") : T("用支付宝扫码付款")));
    var cd = el("div", "wl-qr-count", "");
    cd.id = "wlCountdown";
    right.appendChild(cd);
    right.appendChild(el("div", "wl-qr-sub muted", T("订单号：{id}", { id: o.id })));
    var done = el("button", "wl-btn", T("我已完成支付"));
    done.type = "button";
    done.onclick = manualRefresh;
    right.appendChild(done);
    if (o.payUrl) {
      var again = el("button", "wl-btn ghost", T("重新打开收银台"));
      again.type = "button";
      again.onclick = function () { openPayUrl(o.payUrl); };
      right.appendChild(again);
    }
    var cancel = el("button", "wl-btn ghost", T("放弃本单"));
    cancel.type = "button";
    cancel.onclick = function () {
      stopPoll();
      ST.order = null;
      ST.autoOpened = "";
      paintQr();
      setBusy(false);
    };
    right.appendChild(cancel);
    panel.appendChild(right);
    paintCountdown();
  }

  /** 用系统浏览器打开收银台（渲染层没有 shell 权限，走 preload 暴露的 openExternal）。 */
  function openPayUrl(u) {
    var url = String(u || "");
    if (!url) return;
    if (window.api && typeof window.api.openExternal === "function") {
      try {
        window.api.openExternal(url);
        return;
      } catch (e) { /* 落到下面的提示 */ }
    }
    setNotice(T("无法自动打开浏览器，请手动访问：{url}", { url: url }), "err");
  }

  function paintCountdown() {
    if (!dialogAlive()) return;
    var n = ST.root.querySelector("#wlCountdown");
    if (!n || !ST.order) return;
    var left = Math.max(0, Math.ceil((Number(ST.order.expiresAt || 0) - Date.now()) / 1000));
    var m = Math.floor(left / 60);
    var s = left % 60;
    n.textContent = T("剩余 {t}", { t: m + ":" + String(s).padStart(2, "0") });
    n.className = "wl-qr-count" + (left <= 60 ? " warn" : "");
    if (left <= 0 && ST.order.status === "pending") {
      ST.order.status = "expired";
      stopPoll();
      paintQr();
      setBusy(false);
    }
  }

  function paintHistory() {
    if (!dialogAlive()) return;
    var box = ST.root.querySelector("#wlHistory");
    if (!box) return;
    box.textContent = "";
    if (!ST.orders.length && !ST.ledger.length) {
      box.appendChild(el("div", "muted", T("暂无充值记录")));
      return;
    }
    if (ST.orders.length) {
      box.appendChild(el("div", "wl-h-title", T("最近订单")));
      var t = el("table", "wl-table");
      var head = el("tr");
      [T("时间"), T("金额"), T("状态"), T("订单号")].forEach(function (h) {
        head.appendChild(el("th", "", h));
      });
      t.appendChild(head);
      var ST_TEXT = {
        pending: T("待支付"),
        paid: T("已支付"),
        partial_refunded: T("部分退款"),
        refunded: T("已退款"),
        expired: T("已过期"),
        closed: T("已关单"),
        paid_mismatch: T("金额不符"),
      };
      ST.orders.slice(0, 8).forEach(function (o) {
        var tr = el("tr");
        tr.appendChild(el("td", "", tsText(o.createdAt)));
        /* 订单金额按币显示（账户资产口径）；已退款 / 部分退款那两态另用小字把实际退回的元补出来 */
        var amtTd = el("td", "num");
        amtTd.appendChild(coinEl(coinsOfYuan(o.amountYuan), { size: "sm" }));
        if ((o.status === "refunded" || o.status === "partial_refunded") && Number(o.refundedYuan)) {
          amtTd.appendChild(el("div", "wl-tier-yuan", T("已退 ") + money(o.refundedYuan)));
        }
        tr.appendChild(amtTd);
        tr.appendChild(el("td", "st st-" + o.status, ST_TEXT[o.status] || o.status));
        tr.appendChild(el("td", "mono", o.id));
        t.appendChild(tr);
      });
      box.appendChild(t);
    }
    if (ST.ledger.length) {
      box.appendChild(el("div", "wl-h-title", T("余额变动")));
      var t2 = el("table", "wl-table");
      var h2 = el("tr");
      [T("时间"), T("类型"), T("变动"), T("变动后余额")].forEach(function (h) {
        h2.appendChild(el("th", "", h));
      });
      t2.appendChild(h2);
      var TY = { recharge: T("充值入账"), refund: T("退款"), adjust: T("人工调账"), mismatch: T("金额不符") };
      ST.ledger.slice(0, 8).forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", "", tsText(e.at)));
        tr.appendChild(el("td", "", TY[e.type] || e.type));
        /* 负数要显示成 -500 而不是 500-：符号在数量外面才读得顺 */
        var dv = Number(e.deltaYuan) || 0;
        var d = el("td", "num " + (dv >= 0 ? "pos" : "neg"));
        d.textContent = (dv >= 0 ? "+" : "-") + coinNum(coinsOfYuan(Math.abs(dv)));
        tr.appendChild(d);
        var afterTd = el("td", "num");
        afterTd.appendChild(coinEl(coinsOfYuan(e.balanceAfterYuan), { size: "sm" }));
        tr.appendChild(afterTd);
        t2.appendChild(tr);
      });
      box.appendChild(t2);
    }
  }

  /** 付款按钮的文案（现在只用在 aria-label / title 上：按钮面已经换成 logo）：
      page = 去浏览器收银台付款 · precreate = 窗内出二维码。 */
  function payLabel() {
    var ch = ST.cfg && ST.cfg.channel;
    return ch === "alipay_f2f" ? T("生成支付宝付款码") : T("去支付宝付款");
  }

  function setBusy(on) {
    ST.busy = !!on;
    if (!dialogAlive()) return;
    var b = ST.root.querySelector("#wlPay");
    if (b) {
      b.disabled = !!on || !payEnabled();
      /* 忙 / 闲只换按钮内容（logo + 文案 ↔ 处理中…），见 paintPayBtn */
      paintPayBtn(b, !!on);
    }
  }

  function payEnabled() {
    if (!ST.cfg) return true; // 配置还没拉到时不禁用，点了才知道结果
    return !!ST.cfg.payConfigured;
  }

  /* MTNode 中转服务的警示元件（余额窗开头与设置里的中转卡共用同一份文案）：
     ① 标题行**明写「不建议使用任何中转服务」**（含本中转）——中转只供临时使用，别把它
        当成长期主力通道；
     ② 三行说明：一句说清「这里有什么模型」，一句讲 LLM 走非官方中转的风险（换模型 /
        收集隐私 / 装恶意软件），最后一句把图像 / 视频 / 音频因输出内容受限、风险相对低说明白；
     ③ 下方给两个出口：DeepSeek 官方充值网址（走系统浏览器打开）与「申请 API Key 与设置方法」
        文档入口（应用内手册《配置服务商与 API》，见 renderer/app.js 的 openAppDocs）。
     官方网址与设置里那条「DeepSeek 官方充值通道」同一真源 URL（app-settings.js
     DEEPSEEK_TOPUP_URL），这里再写一份常量：本模块自带兜底样式 / 文案，不与设置模块互相 require。 */
  function warnLines() {
    return [
      T("MTNode 中转仅提供最基本的 DeepSeek 与 GPT-Image-2.5 官方原价模型，供临时使用。"),
      T("LLM 模型（如 GPT / Claude 等）请不要轻易相信官方以外的任何中转站：它可以轻松把请求换成廉价模型、收集你的隐私信息，甚至直接在本机安装恶意软件。"),
      T("图像 / 视频 / 音频等因输出内容受限，相对安全。"),
    ];
  }
  var DEEPSEEK_TOPUP_URL = "https://platform.deepseek.com/";
  /* 在系统浏览器里打开外链（渲染层没有 shell 权限，走 preload 的 openExternal）；
     打不开就退回 window.open，两条都失败不抛错（警示框里的链接不值得把窗搞炸）。 */
  function openOutbound(url) {
    var u = String(url || "");
    if (!u) return;
    try {
      if (window.api && typeof window.api.openExternal === "function") {
        window.api.openExternal(u);
        return;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      window.open(u, "_blank");
    } catch (e2) { /* 忽略：链接点不动也不该影响余额窗其它部分 */ }
  }
  /* 应用内手册《配置服务商与 API》（guides/manual/providers.md）：申请 Key 与填进 MTNode 的
     方法都在那一页，这里只做入口，不再抄一份说明文字（手册是唯一真源）。
     手册窗挂在 #overlay 之上；本窗是 persistent，点手册不会把余额窗关掉。 */
  function openProvidersDoc() {
    try {
      if (typeof openAppDocs === "function") {
        openAppDocs("providers");
        return;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    openOutbound(DEEPSEEK_TOPUP_URL);
  }
  function relayWarnEl() {
    var box = el("div", "wl-warn");
    box.appendChild(el("div", "wl-warn-t", T("⚠ 不建议使用任何中转服务（含本中转）")));
    warnLines().forEach(function (line) {
      box.appendChild(el("div", "wl-warn-l", line));
    });
    /* ① DeepSeek 官方充值网址（可点，直接开系统浏览器） */
    var rows = el("div", "wl-warn-rows");
    var topupRow = el("div", "wl-warn-row");
    topupRow.appendChild(el("span", "wl-warn-k", T("DeepSeek 官方充值：")));
    var topupLink = el("a", "wl-warn-a", DEEPSEEK_TOPUP_URL);
    topupLink.href = DEEPSEEK_TOPUP_URL;
    topupLink.title = DEEPSEEK_TOPUP_URL + T("（在浏览器中打开）");
    topupLink.onclick = function (ev) {
      ev.preventDefault();
      openOutbound(DEEPSEEK_TOPUP_URL);
    };
    topupRow.appendChild(topupLink);
    rows.appendChild(topupRow);
    /* ② 文档引导：申请 API Key 与设置方法 */
    var docRow = el("div", "wl-warn-row");
    docRow.appendChild(el("span", "wl-warn-k", T("申请 API Key 与设置方法：")));
    var docLink = el("a", "wl-warn-a", T("查看文档《配置服务商与 API》") + " →");
    docLink.href = "#";
    docLink.title = T("打开应用内文档，查看怎么申请 API Key 并填进 MTNode");
    docLink.onclick = function (ev) {
      ev.preventDefault();
      openProvidersDoc();
    };
    docRow.appendChild(docLink);
    rows.appendChild(docRow);
    box.appendChild(rows);
    return box;
  }

  /* ---------- 动作 ---------- */

  function createOrder() {
    if (ST.busy) return;
    /* 用户选 / 填的是币；提交给云端的永远是元（反算，最多 2 位小数 = 分位）。
       上下限仍按服务端给的元口径判（MIN_YUAN / MAX_YUAN 来自 wallet/config）。 */
    var coins = pickedCoins();
    if (!coins) {
      setNotice(T("请选择或输入充值金额"), "err");
      return;
    }
    var yuan = yuanOfCoins(coins);
    if (yuan < MIN_YUAN || yuan > MAX_YUAN) {
      setNotice(
        T("充值金额需在 {min} – {max} 之间", {
          min: coinNum(coinsOfYuan(MIN_YUAN)),
          max: coinNum(coinsOfYuan(MAX_YUAN)),
        }),
        "err",
      );
      return;
    }
    setBusy(true);
    setNotice("");
    api("POST", "/api/wallet/recharge/create", { amountYuan: yuan })
      .then(function (r) {
        if (!dialogAlive()) return;
        if (!r || !r.ok || !r.data) throw r;
        ST.order = r.data.order;
        paintQr();
        startPoll();
      })
      .catch(function (e) {
        if (!dialogAlive()) return;
        setNotice(errText(e), "err");
      })
      .then(function () {
        if (dialogAlive()) setBusy(false);
      });
  }

  function startPoll() {
    stopPoll();
    var gen = ST.gen;
    var step = function () {
      if (!dialogAlive() || gen !== ST.gen) return;
      /* 本次定时器已经触发：必须先把句柄清零，否则末尾的「!ST.timer」判定会以为「还有一个
         定时器在排队」而不再续期 —— 轮询链只跑一次就断，付了钱也永远等不到自动入账
         （只能靠用户手点「我已完成支付」）。这个 bug 由 Electron 实渲染夹具抓出来。
         注：注释里不要用反引号包标识符（现场的 app-wallet.js 就因为一行注释里的反引号
         让整只脚本语法报错、window.MtWallet 整个不挂载）。 */
      ST.timer = 0;
      var o = ST.order;
      if (!o || o.status !== "pending") return;
      api("GET", "/api/wallet/recharge/order?id=" + encodeURIComponent(o.id))
        .then(function (r) {
          if (!dialogAlive() || gen !== ST.gen) return;
          if (r && r.ok && r.data && r.data.order) {
            var next = r.data.order;
            var was = ST.order.status;
            ST.order = next;
            if (next.status !== was) paintQr();
            paintCountdown();
            if (next.status === "paid") {
              stopPoll();
              onPaid();
              return;
            }
            if (next.status === "expired" || next.status === "closed" || next.status === "paid_mismatch") {
              stopPoll();
              setBusy(false);
              return;
            }
          }
        })
        .catch(function () {
          /* 单次轮询失败不提示、不中断：下一轮继续 */
        })
        .then(function () {
          if (dialogAlive() && gen === ST.gen && ST.order && ST.order.status === "pending" && !ST.timer) {
            ST.timer = setTimeout(step, POLL_MS);
          }
        });
    };
    ST.timer = setTimeout(step, POLL_MS);
  }

  function onPaid() {
    setNotice(T("充值成功，余额已更新"), "ok");
    loadSummary().then(function () {
      paintBalance();
      paintHistory();
    });
    refreshUser();
    /* 充值到账 → 中转服务那张只读卡当场出现 / 恢复可用（renderer/app-relay.js）：
       余额从 0 变正时服务端才开始下发模型清单，这里强制拉一次，不等下次登录。 */
    try {
      if (window.MtRelay && window.MtRelay.sync) window.MtRelay.sync({ force: true });
    } catch (e) {}
  }

  function manualRefresh() {
    if (!ST.order) return;
    setBusy(true);
    api("POST", "/api/wallet/recharge/refresh", { id: ST.order.id })
      .then(function (r) {
        if (!dialogAlive()) return;
        if (!r || !r.ok) throw r;
        var d = r.data || {};
        if (d.order) ST.order = d.order;
        paintQr();
        if (d.paid) {
          stopPoll();
          onPaid();
        } else if (d.closed) {
          stopPoll();
        } else {
          setNotice(T("支付宝侧还未收到款项，请稍等或重新扫码"), "");
        }
      })
      .catch(function (e) {
        if (dialogAlive()) setNotice(errText(e), "err");
      })
      .then(function () {
        if (dialogAlive()) setBusy(false);
      });
  }

  /* ---------- 打开对话框 ---------- */

  function openWallet() {
    if (!window.api || !window.api.storeRequest) {
      window.alert(T("账户服务未就绪"));
      return;
    }
    stopPoll();
    liveGen = (liveGen + 1) % 100000;
    ST.gen = liveGen;
    ST.order = null;
    ST.pickedYuan = (ST.tiers[0] || 10);

    openOverlay(T("余额"), { persistent: true, min: true });
    var body = document.getElementById("ovBody");
    var foot = document.getElementById("ovFoot");
    if (!body) return;
    body.innerHTML = "";
    if (foot) foot.innerHTML = "";

    var root = el("div", "wallet-root");
    ST.root = root;
    body.appendChild(root);

    /* 中转服务警示：**窗口内容最顶端**（余额行之上）——打开余额窗第一眼就该看到
       「不建议使用任何中转服务」以及官方充值网址与文档入口（见 relayWarnEl）。
       设置 · 提供商里的中转卡仍挂同一份元件（真源只有这一个函数）。 */
    root.appendChild(relayWarnEl());

    /* 余额（鲸圆币；零头显示「<1 币」，判定仍按真实元值） */
    var bal = el("div", "wl-balance");
    bal.appendChild(el("div", "wl-k", T("当前鲸圆币")));
    var bv = el("div", "wl-v", "—");
    bv.id = "wlBalance";
    bal.appendChild(bv);
    var rb = el("button", "wl-btn ghost sm", T("刷新"));
    rb.type = "button";
    rb.onclick = function () {
      loadSummary().then(function () {
        paintBalance();
        paintHistory();
      });
      refreshUser();
    };
    bal.appendChild(rb);
    root.appendChild(bal);

    /* 提示条 */
    var notice = el("div", "wl-notice hidden");
    notice.id = "wlNotice";
    root.appendChild(notice);

    /* 充值块宿主（#wlPick）：里面装「能充值时」的金额选择，或「闸门没开时」的说明块。
       两块由 paintRecharge 互斥切换 —— 服务端 opened 一回来就换，用户不会点了才知道。 */
    var pickHost = el("div", "wl-pick-host");
    pickHost.id = "wlPick";
    pickHost.appendChild(pickEl());
    root.appendChild(pickHost);

    /* 二维码区：**在充值块里**（见 pickEl）—— 闸门没开时整块被摘掉，不会留着上一单的码。 */

    /* 历史 */
    var hist = el("div", "wl-history");
    hist.id = "wlHistory";
    root.appendChild(hist);

    /* 底部 */
    if (foot) {
      var tip = el("div", "wl-foot-tip muted", T("充值到账后可在余额中查看；如长时间未到账，请用「我已完成支付」核对或联系管理员。"));
      foot.appendChild(tip);
      var close = el("button", "wl-btn", T("关闭"));
      close.type = "button";
      close.onclick = function () {
        stopPoll();
        liveGen++;
        closeOverlay();
      };
      foot.appendChild(close);
    }

    paintTiers();
    setBusy(false);
    loadConfig().then(function () {
      if (!dialogAlive()) return;
      if (ST.cfg && !ST.cfg.payConfigured && rechargeOpened()) {
        setNotice(T("支付通道尚未配置，暂时无法充值"), "err");
      }
      setBusy(false);
    });
    /* 摘要现拉（余额的唯一权威来源）：它同时把 ST.balanceFrom 置成 "wallet"，
       所以本机账号摘要缺 balanceYuan（老服务端）也不会把余额画成 0 —— 拉回来之前是「—」。
       打开窗时**无条件**真打一次（这条路径不吃 60s 缓存）：用户要的是「打开就看到当前余额」，
       不是「最多 60 秒前的余额」；失败保留上次已知值 + 它的取数时间（见 paintBalance）。
       注：余额只有这一个数据源 —— 别再叠一次 ensureBalance，那是同一份摘要的重复请求。 */
    loadSummary().then(function () {
      paintBalance();
      paintHistory();
    });
  }

  /* 账号菜单里的余额行由 app-auth.js 调用（对**所有已登录账号**显示，见 visibleFor）。
     返回币数（真实值是元，这里按 50:1 换算后取整）；单位是鲸圆币图标，**不再写「币」字**
     （本轮口径：全应用统一换图标）。账号摘要与现拉缓存都没有余额时回「余额：—」，
     不把「还不知道」显示成 0 币（已充值账号被提示「余额 0」的观感来源）。
     纯文本调用方（无法插图标的）请改用 balanceCoinTextOf：它给「数字 + 币名」的字符串。 */
  function balanceText(u) {
    if (snapshotBalance(u) == null && balanceKnownYuan() == null) return T("余额：") + "—";
    return T("余额：{amount}", { amount: coinNum(coinsOfYuan(balanceOf(u))) });
  }
  /* 纯文本口径的余额（日志 / 冒泡 / 无法插图标的场合）：数字 + 币名（英文 W coins，中文「鲸圆币」）。
     与 balanceText 的区别只在于「中文界面这里必须给一个单位词」，见调用方需要。 */
  function balanceCoinTextOf(u) {
    if (snapshotBalance(u) == null && balanceKnownYuan() == null) return T("余额：") + "—";
    return T("余额：{amount}", {
      amount: coinNum(coinsOfYuan(balanceOf(u))) + " " + (window.MtCoin && window.MtCoin.shortName ? window.MtCoin.shortName() : T("鲸圆币")),
    });
  }

  window.MtWallet = {
    visibleFor: visibleFor,
    money: money,
    coinsOfYuan: coinsOfYuan,
    yuanOfCoins: yuanOfCoins,
    coinNum: coinNum,
    coinEl: coinEl,
    balanceEl: balanceEl,
    balanceOf: balanceOf,
    /* 现拉一次余额（并发去重，失败保留旧值）：账号菜单在本机快照缺 balanceYuan 时用它补，
       避免「已充值账号」在菜单上被显示成 0 币。 */
    ensureBalance: ensureBalance,
    balanceKnownYuan: balanceKnownYuan,
    /* 最近一次余额现拉的失败档（""|"401"|"other"）：账号菜单的余额行据此显示
       「登录已过期，点这里重新登录」（见 app-auth.js 的 paintMenu 余额行）。 */
    balanceErr: function () {
      return ST.balanceErr;
    },
    /* 点「登录已过期」时的动作：开现有登录窗（唯一入口），不擅自清登录态。 */
    openRelogin: openRelogin,
    snapshotBalance: snapshotBalance,
    balanceText: balanceText,
    balanceCoinTextOf: balanceCoinTextOf,
    coinIcon: coinIconOf,
    relayWarnEl: relayWarnEl,
    open: openWallet,
    refreshUser: refreshUser,
    state: function () {
      return { balanceYuan: ST.balanceYuan, config: ST.cfg };
    },
  };
})();

/* 打赏（鲸圆币）——自包含模块，挂 window.MtTips
 *
 * 一、它是什么
 *   用户之间用鲸圆币支持作者：工坊条目（模板 / Skill）、应用条目、论坛话题与回复四处
 *   共用一套入口。鲸圆币换算与金币图标复用 renderer/app-whalecoin.js（window.MtCoin）。
 *
 * 二、口径（真源 store-saas/tips.mjs + docs/tips-comments-design.md，本文件只做界面）
 *   · 档位与限额**全部由服务端下发**（GET /api/tips/config）：档位、单笔上限、可用余额。
 *     渲染层不做任何算术决策 —— 余额够不够、能不能打，一律按服务端回的数值与错误码判定
 *     （与钱包「不做分↔元换算」同口径）。
 *   · **界面上不再出现「本月剩余额度」**（需求口径：用户不该看到额度这种限制）：
 *     服务端的月额度闸门仍在（超额回 TIP_MONTH_LIMIT），但客户端**不提前显示额度、也不据它置灰** ——
 *     真打到上限时由服务端回执给出那句话（见 openTipDialog 的 TIP_MONTH_LIMIT 分支）。
 *   · 会话过期（接口回 401）不走「余额 0」：余额行显示「登录已过期，点这里重新登录」，
 *     点它打开现有登录窗，登录成功后原地刷新余额（见 paintStat 的 401 分支）。
 *   · 一次打赏 = 服务端两条 wallet 流水（转出 / 转入），客户端只管发起与刷新。
 *   · 打赏记录（`GET /api/tips/list`）按视角分两份：**作者本人**看这一条的全部名单（要名字，对账用）；
 *     **其他登录用户只拿回自己打赏出去的那几笔**（`scope:"mine"`，名单里没有第三人）。
 *     **累计被打赏总额对所有人可见** —— 它来自公开投影（opts.tips 或
 *     GET /api/tips/authors 回的 tips 字段），不是名单。
 *   · 应用条目有**多个作者**（同一应用的同源分支）时按比例分账：GET /api/tips/authors 取这一组
 *     作者，界面上一人一行输入框，最后一个非本人作者自动补齐剩余；POST /api/tips 带
 *     `splits:[{authorId, cents}]`（分），Σcents 必须 = 总额。自己那一份固定 0（服务端拒绝自赏）。
 *   · 界面一律「鲸圆币」；金额字段从服务端来时是元（4 位小数），显示时经
 *     window.MtCoin.coinsOfYuan 换算成币。
 *   · **打赏窗内不出现「¥」**（需求口径：鲸圆币只用于账户钱包与 MTNode 中转模型调用）——
 *     档位、卡片摘要、名单、累计行一律只写币数；真正按元收付的支付宝金额只在
 *     充值窗（renderer/app-wallet.js 的「实付 ¥…」与「¥1 = 50 币」）里出现。
 *
 * 三、`state()` 的态（按钮文案与置灰的唯一依据）
 *   服务端的闸门在，客户端只把它翻译成人话，不自己算：
 *     · not_login   → 未登录（按钮可点，点了先弹登录）
 *     · no_balance  → 余额不足（按钮**反而可点**，点了拉起钱包充值窗）
 *     · tipped_today→ 今天已给这个对象打赏过（置灰）
 *     · ok          → 可打赏
 *   月额度**不是**客户端的一个态（不再显示、不再置灰）。
 *
 * 四、依赖
 *   window.api.storeRequest（主进程统一带 Bearer）、app.js 的 toast、
 *   window.MTNodeAuth（登录态）、window.MtCoin、optional I18n、
 *   optional window.MtWallet（余额不足时拉起充值窗）。
 *
 * 五、弹窗用的是**自带二级浮层** `#mtPop`（见 popRoot）：全应用只有一只 #overlay，
 *   从工坊 / 应用中心 / 讨论区的卡片上开打赏窗会把宿主窗清空 —— 所以本模块不碰 #overlay。
 */
(function () {
  "use strict";

  /* ── 小工具 ─────────────────────────────────────────────── */

  function T(s, vars) {
    return window.I18n && window.I18n.t ? window.I18n.t(s, vars) : s;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function coinOf(yuan) {
    return window.MtCoin && window.MtCoin.coinsOfYuan ? window.MtCoin.coinsOfYuan(yuan) : Number(yuan || 0) * 50;
  }
  /* 币数文案（千分位整数；小额保留到 2 位小数 —— 与钱包的显示口径一致） */
  function coinText(coins) {
    var n = Number(coins) || 0;
    if (Math.abs(n - Math.round(n)) < 1e-9) {
      return window.MtCoin && window.MtCoin.coinNumText ? window.MtCoin.coinNumText(n) : String(Math.round(n));
    }
    return window.MtCoin && window.MtCoin.coinCostText ? window.MtCoin.coinCostText(n) : String(n);
  }
  /* 金币图标（转手给 MtCoin；模块缺席时给一个空 span，不留裸露文字） */
  function coinIcon(size) {
    if (window.MtCoin && window.MtCoin.coinIcon) return window.MtCoin.coinIcon(size);
    return el("span", "coin-ico ico-miss");
  }
  /* 「数字 + 鲸圆币图标」内联元件（**本轮口径：中文界面不再写「币」字，单位就是这枚图标**）。
     用法与 el() 类似，只是允许在文本节点之间插入图标：
       coinInline("累计被打赏 ", coinText(coins)) → 「累计被打赏 20 [icon]」
     MtCoin 缺席时退回纯文本 + 一个空 span，绝不抛错（夹具 / 预览页单独加载本模块时会走到）。 */
  function coinInline(parts) {
    var span = el("span", "coin-inline");
    var list = Array.prototype.slice.call(arguments).filter(function (x) {
      return x != null && x !== "";
    });
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (typeof x === "string" || typeof x === "number") span.appendChild(document.createTextNode(String(x)));
      else span.appendChild(x);
    }
    span.appendChild(coinIcon("sm"));
    return span;
  }
  /* toast / mkMiniBtn 都是 app.js 顶层的全局函数（同 app-store.js 的用法），
     这里仍做一次存在性判断：模块被单测 / 预览页单独加载时不至于抛错。 */
  function toastSafe(msg, kind) {
    if (typeof toast === "function") toast(msg, kind);
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

  /* 目标类型（服务端 targetKind）→ 中文名（列表与提示里用） */
  var KIND_TEXT = {
    template: "模板",
    skill: "Skill",
    app: "应用",
    forum_topic: "话题",
    forum_reply: "回复",
  };
  function kindText(k) {
    return T(KIND_TEXT[k] || "条目");
  }

  function signedIn() {
    var A = window.MTNodeAuth;
    if (!A || typeof A.state !== "function") return false;
    var s = A.state();
    return !!(s && s.signedIn && s.user);
  }
  function meId() {
    var A = window.MTNodeAuth;
    if (!A || typeof A.state !== "function") return "";
    var s = A.state();
    return (s && s.user && (s.user.id || s.user.userId)) || "";
  }

  function api(method, path, json) {
    if (!window.api || typeof window.api.storeRequest !== "function") {
      return Promise.resolve({ ok: false, status: 0, error: T("账户服务未就绪") });
    }
    return window.api.storeRequest({ method: method, path: path, json: json });
  }
  function errText(r) {
    if (!r) return T("网络请求失败");
    if (r.data && r.data.error) return r.data.error;
    if (r.error) return r.error;
    return "HTTP " + (r.status || "");
  }
  function codeOf(r) {
    return (r && r.data && r.data.code) || "";
  }

  /* ── 二级浮层（打赏窗 / 评论窗共用的壳） ─────────────────────
     为什么不用 app.js 的 #overlay：全应用只有**一只** #overlay，openOverlay 会把
     #ovBody 清空 —— 而工坊、应用中心、讨论区本身就在它里面（或各自是独立窗口），
     从卡片上点「打赏 / 评论」就会把宿主窗整块冲掉。所以这里自带一只浮层：
     `#mtPop`，盖在 #overlay 之上，互不干扰（与 app-store.js 的 #tplSubOv 同一思路，
     只是这份要同时服务打赏与评论，所以挂在 window.MtPop 上共用）。 */
  function popRoot() {
    var el0 = document.getElementById("mtPop");
    if (el0) return el0;
    el0 = el("div", "mt-pop");
    el0.id = "mtPop";
    var box = el("div", "mt-pop-box");
    var head = el("div", "mt-pop-head");
    var title = el("b", "mt-pop-title");
    title.id = "mtPopTitle";
    var closeBtn = el("button", "mt-pop-close", "✕");
    closeBtn.type = "button";
    closeBtn.title = T("关闭");
    closeBtn.addEventListener("click", popClose);
    head.appendChild(title);
    head.appendChild(closeBtn);
    var body = el("div", "mt-pop-body");
    body.id = "mtPopBody";
    box.appendChild(head);
    box.appendChild(body);
    el0.appendChild(box);
    /* persistent：点蒙层不关（浮层里有未提交的输入），只走 ✕ / Esc / 窗内关闭按钮 */
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && el0.classList.contains("on")) popClose();
    });
    document.body.appendChild(el0);
    return el0;
  }
  /* opts.noClose = 本窗**不要内部 ✕**（需求口径：打赏窗移除内部的 X 按钮）。
     关闭出口只剩底部的「关闭」按钮与 Esc —— persistent 的口径不变（点蒙层照旧什么都不做）。
     ✕ 是共用壳上那一只：这里只给壳加一个 no-close 类，评论窗（不传 noClose）照旧带 ✕。 */
  function popOpen(title, opts) {
    var o = opts || {};
    var root = popRoot();
    document.getElementById("mtPopTitle").textContent = title || "";
    var body = document.getElementById("mtPopBody");
    body.innerHTML = "";
    root.classList.toggle("no-close", !!o.noClose);
    root.classList.add("on");
    return body;
  }
  function popClose() {
    var root = document.getElementById("mtPop");
    if (!root) return;
    root.classList.remove("on");
    var body = document.getElementById("mtPopBody");
    if (body) body.innerHTML = "";
  }

  /* ── 配置缓存 ───────────────────────────────────────────────
     GET /api/tips/config 一进界面就要用（卡片上的按钮状态、档位、额度），
     但卡片是成片渲染的：缓存 60 秒，并在打赏成功后立刻失效重取。 */
  var CFG = { data: null, at: 0, inflight: null, err: "" };
  var CFG_TTL_MS = 60 * 1000;

  /* 读配置失败的状态码（"401" = 会话过期，其余 = 暂时取不到）：供余额行分档显示。
     只在**本次**真打了接口时更新，缓存的 CFG.data 不被这个标记污染。 */
  function cfgErrOf() {
    return CFG.err;
  }

  function invalidate() {
    CFG.data = null;
    CFG.at = 0;
  }

  function config(force) {
    var t = Date.now();
    if (!force && CFG.data && t - CFG.at < CFG_TTL_MS) return Promise.resolve(CFG.data);
    if (CFG.inflight) return CFG.inflight;
    CFG.inflight = api("GET", "/api/tips/config")
      .then(function (r) {
        if (r && r.ok && r.data) {
          CFG.data = r.data;
          CFG.at = Date.now();
          CFG.err = "";
          return CFG.data;
        }
        /* 未登录会回 401（服务端把免登录的静态口径也给了，所以这里只有真异常才走到）：
           记下状态码，余额行据此显示「登录已过期」而不是「余额 0」。 */
        CFG.err = String((r && r.status) || "") || "net";
        return null;
      })
      .catch(function () {
        CFG.err = "net";
        return null;
      })
      .then(function (v) {
        CFG.inflight = null;
        return v;
      });
    return CFG.inflight;
  }

  /* 服务端 config 的额度字段仍在（月闸门留在服务端），但界面既不显示也不据它置灰 ——
     见文件头第二节。「今天给这个对象打赏过没有」按对象判定，由调用方（按钮 / 弹窗）
     把 target 传进来，与 config 一起合成按钮态。 */
  function stateOf(cfg, target) {
    if (!signedIn()) return { key: "not_login", text: T("登录后可打赏") };
    if (!cfg) return { key: "unknown", text: T("正在读取打赏信息…") };
    var today = (cfg.today && target && cfg.today[targetKey(target.kind, target.id)]) || false;
    if (today) return { key: "tipped_today", text: T("今天已打赏过，明天再来") };
    if (Number(cfg.balanceYuan) <= 0) return { key: "no_balance", text: T("余额不足，去充值") };
    return { key: "ok", text: T("打赏作者") };
  }

  function targetKey(kind, id) {
    return String(kind || "") + ":" + String(id || "");
  }

  /* ── 卡片上的打赏摘要 + 按钮 ─────────────────────────────────
     形态：`🪙 1,200 · 3 次`（数字后跟鲸圆币图标；没人打赏过就整块不显示）。
     点一下开打赏窗（含名单，仅作者可见）。 */

  /* 卡片摘要的**纯文本**形态（日志 / 冒泡用）：中文界面不再写「币」字，单位靠图标；
     要带图标的地方走 metaEl / coinInline。 */
  function summaryText(tips) {
    var c = Number((tips && tips.count) || 0);
    var total = coinOf((tips && tips.totalYuan) || 0);
    if (!c) return "";
    return coinText(total) + " · " + T("{n} 次", { n: c });
  }

  /* 卡片摘要元件（只读，点了等同于点打赏按钮） */
  function metaEl(target, tips, opts) {
    var o = opts || {};
    var box = el("span", "tip-meta");
    var c = Number((tips && tips.count) || 0);
    var total = coinOf((tips && tips.totalYuan) || 0);
    if (!c) {
      /* 没人打赏过：卡片上不占位（不给 0 币的假数据），但详情里要保留一句可点的引导 */
      if (!o.alwaysShow) return null;
      box.classList.add("empty");
      box.appendChild(el("span", "tip-meta-t", T("还没有人打赏")));
    } else {
      /* 「1,200 [鲸圆币图标] · 3 次」：数字与「次」是文本，单位是图标（本轮口径） */
      box.appendChild(coinInline(coinText(total) + " · " + T("{n} 次", { n: c })));
      box.title = tipSumTitle(tips);
    }
    if (o.clickable !== false) {
      box.classList.add("clickable");
      box.addEventListener("click", function () {
        /* 把这一份公开汇总带进窗里 —— 窗里的「累计被打赏」对所有人可见（见 openTipDialog） */
        openTipDialog(target, { authorId: o.authorId, tips: tips, onDone: o.onDone });
      });
    }
    return box;
  }

  /* 打赏按钮（卡片与详情共用）：占位先出，配置回来后决定置灰与否。
     图标统一走鲸圆币 icon（本轮口径：全应用把「币」字 / 金币 emoji 换成它）。 */
  function buttonEl(target, tips, opts) {
    var o = opts || {};
    var btn = el("button", "tip-btn");
    btn.type = "button";
    btn.innerHTML = "";
    var ico = el("span", "tip-btn-ico");
    ico.appendChild(coinIcon("sm"));
    btn.appendChild(ico);
    var label = el("span", "tip-btn-t", T("打赏"));
    btn.appendChild(label);
    var c = Number((tips && tips.count) || 0);
    if (c) {
      /* 摘要也走图标口径：`20 [icon] · 3 次` */
      btn.appendChild(coinInline(coinText(coinOf((tips && tips.totalYuan) || 0)) + " · " + T("{n} 次", { n: c })));
    }
    btn.title = T("打赏作者（鲸圆币）");
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openTipDialog(target, { authorId: o.authorId, tips: tips, onDone: o.onDone });
    });
    if (o.compact) btn.classList.add("compact");
    /* outline = **橙色 outlined、中间透明**（需求口径；应用卡片与详情的打赏入口都用它） */
    if (o.outline) btn.classList.add("outline");
    return btn;
  }

  /* 累计打赏的悬停文案：**只给币数**（打赏窗内不出现「¥」的口径见文件头第二节）。
     没人打赏过时给「还没有人打赏」——卡片上只剩一枚金币 icon 时，汇总量就靠这句话出
     （需求口径：汇总不占卡片正文，收进 icon 的 tooltip）。
     中文界面不再写「币」字（单位由卡片上的图标承担），英文界面仍有 "W coins"。 */
  function tipSumTitle(tips) {
    var n = Number((tips && tips.count) || 0);
    if (!n) return T("还没有人打赏");
    return T("累计打赏 {v}（{n} 次）", {
      v: coinText(coinOf((tips && tips.totalYuan) || 0)),
      n: n,
    });
  }

  /* ── 打赏窗（档位 + 余额/额度 + 名单） ───────────────────────── */

  /* 名单查询（仅作者本人与管理员）。others 时静默失败，只显示一句说明。 */
  function loadList(target, limit) {
    var q =
      "/api/tips/list?targetKind=" + encodeURIComponent(target.kind) +
      "&targetId=" + encodeURIComponent(target.id) +
      "&limit=" + encodeURIComponent(String(limit || 20));
    return api("GET", q);
  }

  /* 这一组待分账作者（应用的同源分支可能来自多个作者）。仅应用类目标有这个接口；
     未登录 / 接口不存在 / 单作者时回空名单 = 退回老的单作者口径，不报错、不弹红。
     注意：**不要**把非 ok 的回执吞成 null —— 调用方要靠 status 404 分辨「云端没有这一条」
     （本机自建、还没上架的应用），只有真正的传输异常才回 null。 */
  function loadAuthors(target) {
    var q =
      "/api/tips/authors?targetKind=" + encodeURIComponent(target.kind) +
      "&targetId=" + encodeURIComponent(target.id);
    return api("GET", q).catch(function () {
      return null;
    });
  }

  function openTipDialog(target, opts) {
    var o = opts || {};
    if (!signedIn()) {
      if (window.MTNodeAuth && typeof window.MTNodeAuth.open === "function") {
        window.MTNodeAuth.open();
        return;
      }
      toastSafe(T("请先登录"), "err");
      return;
    }
    /* 二级浮层（见 popRoot 注释）：宿主可能是工坊 / 应用中心 / 讨论区本身，
       绝不能用 app.js 的 openOverlay（那会把宿主窗清空）。
       noClose：打赏窗**不带内部 ✕**（需求口径），关闭只走底部「关闭」与 Esc。 */
    var body = popOpen(T("打赏作者"), { noClose: true });
    if (!body) return;

    /* 正文先挂、动作区后挂：底部动作区必须排在正文**之后** ——
       原先是先把 foot 塞进 body，「确认打赏」就跑到正文上方的左上角了
       （需求口径：打赏按钮放在下方，不是左上角）。 */
    var root = el("div", "tip-root");
    body.appendChild(root);

    var head = el("div", "tip-head");
    head.appendChild(el("div", "tip-head-t", T("用鲸圆币支持作者")));
    head.appendChild(el("div", "tip-head-s", T("打赏所得可用于作者调用 MTNode 中转模型")));
    root.appendChild(head);

    /* 公开总额行：**所有人都能看到这个条目被打赏了多少**（需求口径）。
       数值来自公开投影 —— 调用方传的 o.tips，或 GET /api/tips/authors 回的 tips 字段；
       这不是打赏人名单（名单仍仅作者本人与管理员可见）。 */
    var totalLine = el("div", "tip-total");
    root.appendChild(totalLine);
    function paintTotal(tips) {
      totalLine.innerHTML = "";
      var c = Number((tips && tips.count) || 0);
      if (!c) {
        totalLine.className = "tip-total empty";
        totalLine.appendChild(el("span", "tip-total-t", T("还没有人打赏")));
        return;
      }
      totalLine.className = "tip-total";
      /* 「累计被打赏 20 [鲸圆币图标]」——单位是图标，中文界面不写「币」字（本轮口径） */
      var tline = el("span", "tip-total-t");
      tline.appendChild(document.createTextNode(T("累计被打赏") + " "));
      tline.appendChild(coinInline(coinText(coinOf(tips.totalYuan || 0))));
      totalLine.appendChild(tline);
      totalLine.appendChild(el("span", "tip-total-n", T("· {n} 次", { n: c })));
    }
    if (o.tips) paintTotal(o.tips);
    /* 本机自建、云端还没上架的条目（见 app-apps.js 的 appsCloudTarget）：服务端没有这条记录，
       /api/tips/authors 会 404 —— 那种情况下「0 次打赏」是假数据，必须说清是「还没上架」，
       而不是「还没有人打赏」（需求口径：修「详细或外部看显示没有打赏」这个错报）。
       注意：这句话**只在真正 404 且重试后仍然 404**时才出（见下面打开时那一段），
       刚上架时的时序 404 或 401 / 网络失败都不许变成这句话。 */
    var cloudMissing = !!(o.tips && o.tips.cloudMissing);
    function paintTotalCloudMissing() {
      totalLine.innerHTML = "";
      totalLine.className = "tip-total empty";
      totalLine.appendChild(el("span", "tip-total-t", T("该条目尚未上架云端，打赏记录不可用")));
    }
    if (cloudMissing) paintTotalCloudMissing();

    /* 余额行：数值一律用服务端回的（见文件头第二节）。**额度行已按需求移除** ——
       界面不再显示「本月剩余额度」，服务端的月闸门仍在（真超额由提交后的回执说清）。
       余额取不到时分两档：401 = 会话过期（给一键重登），其余 = 暂时取不到。 */
    var stat = el("div", "tip-stat");
    var balK = el("div", "tip-stat-k", T("当前余额"));
    var balV = el("div", "tip-stat-v tip-stat-warn");
    balV.hidden = true;
    var balNum = el("div", "tip-stat-v", "—");
    stat.appendChild(balK);
    stat.appendChild(balNum);
    stat.appendChild(balV);
    root.appendChild(stat);
    var authExpired = false;
    /* 会话过期：余额数字位整块让给提示文案，并挂一键重登（需求口径：不擅自登出，
       只在余额行说清 + 给重登入口）。其余失败：数字位保留「—」，下面补一句原因。 */
    function setAuthExpired(on) {
      authExpired = !!on;
      balV.hidden = false;
      balNum.hidden = !!on;
      balV.classList.toggle("clickable", !!on);
      balV.title = on ? T("点这里重新登录") : "";
    }
    function paintAuthWarn(msg) {
      balV.innerHTML = "";
      balV.appendChild(el("span", "tip-stat-warn-t", msg));
    }
    function openRelogin() {
      var A = window.MTNodeAuth;
      if (A && typeof A.open === "function") {
        A.open();
        return;
      }
      toastSafe(T("请先登录"), "err");
    }
    balV.addEventListener("click", function () {
      if (authExpired) openRelogin();
    });

    var notice = el("div", "tip-notice hidden");
    root.appendChild(notice);
    function setNotice(text, kind) {
      notice.textContent = text || "";
      notice.className = "tip-notice" + (kind ? " " + kind : "") + (text ? "" : " hidden");
    }

    var pick = el("div", "tip-pick");
    pick.appendChild(el("div", "tip-k", T("打赏金额")));
    var tiers = el("div", "tip-tiers");
    pick.appendChild(tiers);
    root.appendChild(pick);

    /* 名单区（打赏人名单**仅作者本人与管理员**可见）。非作者看这个区：什么都不画 ——
       需求口径「移除显示仅作者和管理员才能见到打赏」，只保留上面的公开总额行。 */
    var listBox = el("div", "tip-list");
    root.appendChild(listBox);

    /* 多作者分账区：只有这一组作者 ≥2 时才出现（例如同一应用的同源分支）。 */
    var splitBox = el("div", "tip-split hidden");
    root.appendChild(splitBox);

    var picked = 0;
    var AUTHORS = []; /* [{id,username,nickname,isSelf}]；空 = 退回单作者口径（老路径不动） */
    var shares = Object.create(null); /* uid → 币（整数） */
    var fillIdx = -1; /* 补差位 = 最后一个非本人作者 */
    var fillIn = null; /* 补差位那个输入框 */
    var sumEl = null;

    /* 币 → 分（服务端 splits 用分）：1 币 = ¥0.02 = 2 分。汇率只从 MtCoin 推，界面里不写死。 */
    function centsOfCoins(coins) {
      var perYuan = coinOf(1) || 50;
      return Math.round(((Number(coins) || 0) / perYuan) * 100);
    }
    /* 分账的总额口径 = **币**（用户按下的档位换算成币：2 元 = 100 币）。
       输入框里填的是币数，提交给服务端的是分 —— 两个口径都从这一个数推。 */
    function totalCoins() {
      return Math.max(0, Math.round(coinOf(picked)));
    }
    /* 能收这份钱的作者（自己不能给自己打赏 → 自己那一份固定 0，不进分账） */
    function payIdx() {
      var a = [];
      for (var i = 0; i < AUTHORS.length; i++) if (!AUTHORS[i].isSelf) a.push(i);
      return a;
    }
    function shareOf(a) {
      return Math.max(0, Math.round(Number(shares[a.id]) || 0));
    }
    /* 可输入作者之和（跳过本人、跳过补差位；exceptIdx 再跳过正在输入的那一位） */
    function editableSum(exceptIdx) {
      var s = 0;
      AUTHORS.forEach(function (a, i) {
        if (a.isSelf || i === fillIdx || i === exceptIdx) return;
        s += shareOf(a);
      });
      return s;
    }
    /* 补差位 = 总额 − 其他作者的份数（永远 ≥0，因为别处都被夹过上限） */
    function fillCoins() {
      return Math.max(0, totalCoins() - editableSum(null));
    }
    /* 默认按作者平均分摊（需求「按比例打赏」的顺手起点，可逐格改），余数给补差位 */
    function resetShares() {
      AUTHORS.forEach(function (a) {
        shares[a.id] = 0;
      });
      var idx = payIdx();
      var total = totalCoins();
      if (!idx.length || total <= 0) return;
      var per = Math.floor(total / idx.length);
      idx.forEach(function (i) {
        shares[AUTHORS[i].id] = per;
      });
      shares[AUTHORS[idx[idx.length - 1]].id] = per + (total - per * idx.length);
    }
    function syncSplit() {
      if (fillIn) fillIn.value = String(fillCoins());
      if (!sumEl) return;
      var sum = fillIdx >= 0 ? editableSum(null) + fillCoins() : 0;
      sumEl.textContent = T("合计") + " " + coinText(sum);
      sumEl.classList.toggle("over", sum > totalCoins());
    }
    function onSplitType(i, inp) {
      var raw = String(inp.value || "").replace(/[^\d]/g, "");
      var v = parseInt(raw || "0", 10);
      if (!isFinite(v) || v < 0) v = 0;
      var room = Math.max(0, totalCoins() - editableSum(i)); /* 总数不得超过用户按的那个数（币） */
      if (v > room) {
        v = room;
        setNotice(T("总数不能超过你按的 {v}，已按上限调整", { v: coinText(totalCoins()) }), "warn");
      } else {
        setNotice("");
      }
      shares[AUTHORS[i].id] = v;
      inp.value = String(v);
      syncSplit();
      syncSend();
    }
    function paintSplit() {
      splitBox.innerHTML = "";
      fillIn = null;
      sumEl = null;
      fillIdx = -1;
      if (AUTHORS.length <= 1 || totalCoins() <= 0) {
        splitBox.classList.add("hidden");
        return;
      }
      splitBox.classList.remove("hidden");
      splitBox.appendChild(el("div", "tip-k", T("按作者分配（这一个条目有多个作者）")));
      splitBox.appendChild(
        el(
          "div",
          "tip-split-hint",
          T("每位作者右侧填币数：合计不得超过 {v}，最后一个作者自动补齐剩余", {
            v: coinText(totalCoins()),
          }),
        ),
      );
      var idx = payIdx();
      fillIdx = idx.length ? idx[idx.length - 1] : -1;
      AUTHORS.forEach(function (a, i) {
        var row = el("div", "tip-split-row");
        row.appendChild(
          el("div", "tip-split-who", (a.nickname || a.username || T("作者")) + (a.isSelf ? T("（你自己）") : "")),
        );
        var inp = document.createElement("input");
        inp.type = "text";
        inp.inputMode = "numeric";
        inp.autocomplete = "off";
        inp.className = "tip-split-in";
        inp.value = String(shareOf(a));
        inp.setAttribute("aria-label", (a.nickname || a.username || T("作者")) + " " + T("鲸圆币"));
        if (a.isSelf) {
          inp.disabled = true;
          inp.title = T("不能给自己打赏：你那一份固定为 0");
        } else if (i === fillIdx) {
          inp.readOnly = true;
          inp.classList.add("auto");
          inp.title = T("自动补齐：这一份 = 总额 − 其他作者的份数");
          fillIn = inp;
        } else {
          inp.addEventListener("input", function () {
            onSplitType(i, inp);
          });
        }
        row.appendChild(inp);
        /* 单位 = 鲸圆币图标（本轮口径：中文界面不再写「币」字） */
        var unit = el("span", "tip-split-unit");
        unit.appendChild(coinIcon("sm"));
        row.appendChild(unit);
        splitBox.appendChild(row);
      });
      sumEl = el("div", "tip-split-sum", "");
      splitBox.appendChild(sumEl);
      syncSplit();
      if (cfgNow) syncSend();
    }
    /* 提交给服务端的分账（分）：只带 >0 的份，自己那一份不带 */
    function payloadSplits() {
      var out = [];
      AUTHORS.forEach(function (a, i) {
        if (a.isSelf) return;
        var coins = i === fillIdx ? fillCoins() : shareOf(a);
        if (coins <= 0) return;
        out.push({ authorId: a.id, cents: centsOfCoins(coins) });
      });
      return out;
    }
    function splitSumCents() {
      var t = 0;
      payloadSplits().forEach(function (s) {
        t += s.cents;
      });
      return t;
    }

    /* 底部动作区：**排在正文之后**（下方），「确认打赏」是橙色 outlined（见 tips.css）。
       打赏窗没有内部 ✕ —— 关闭出口 = 底部「关闭」与 Esc。 */
    var foot = el("div", "mt-pop-foot tip-foot");
    var send = el("button", "wl-btn primary tip-send", T("确认打赏"));
    send.type = "button";
    send.disabled = true;
    foot.appendChild(send);
    var closeBtn = el("button", "wl-btn ghost", T("关闭"));
    closeBtn.type = "button";
    closeBtn.addEventListener("click", popClose);
    foot.appendChild(closeBtn);
    body.appendChild(foot);

    function paintTiers(list) {
      tiers.innerHTML = "";
      (list || []).forEach(function (yuan) {
        var b = el("button", "wl-tier tip-tier");
        b.type = "button";
        /* **只写币数**（不写实付元）：打赏窗内不出现「¥」，见文件头第二节。 */
        var coins = coinOf(yuan);
        b.appendChild(el("span", "tip-tier-c", coinText(coins)));
        b.appendChild(coinIcon("sm"));
        if (Number(yuan) === Number(picked)) b.classList.add("on");
        b.addEventListener("click", function () {
          picked = Number(yuan);
          setNotice("");
          paintTiers(list);
          resetShares(); /* 换档位 = 重新按作者平均分摊 */
          paintSplit();
          syncSend();
        });
        tiers.appendChild(b);
      });
    }

    var cfgNow = null;
    function syncSend() {
      var st = stateOf(cfgNow, target);
      var okAmount = picked > 0;
      /* 余额不足时按钮**反而必须可点**（点了直接去充值）；「今天已打赏过」与服务端口径一致地置灰。
         月额度**不再进置灰判据**（界面不显示额度）：真打到上限由提交后的回执说清。 */
      send.disabled = st.key === "tipped_today" || (st.key === "no_balance" ? false : !okAmount);
      if (st.key === "no_balance") {
        send.textContent = T("余额不足，去充值");
      } else if (st.key === "tipped_today") {
        send.textContent = T("今天已打赏过");
      } else {
        send.textContent = okAmount
          ? T("打赏 {v}", { v: coinText(coinOf(picked)) })
          : T("确认打赏");
      }
      send.dataset.mode = st.key;
    }

    /* 余额行：401 = 会话过期（给一键重登）；其余取不到 = 暂时取不到（保留「—」并说明）。
       额度行已移除（见文件头第二节），这里不再画任何额度数值。 */
    function paintStat(cfg) {
      cfgNow = cfg;
      var expired = !cfg && cfgErrOf() === "401";
      setAuthExpired(expired);
      if (expired) {
        paintAuthWarn(T("登录已过期，点这里重新登录"));
      } else if (!cfg) {
        balNum.textContent = "—";
        paintAuthWarn(T("余额暂时取不到，稍后重试"));
      } else {
        balV.innerHTML = "";
        balNum.innerHTML = "";
        balNum.appendChild(document.createTextNode(coinText(coinOf(Number(cfg.balanceYuan) || 0)) + " "));
        balNum.appendChild(coinIcon("sm"));
      }
      var st = stateOf(cfg, target);
      if (st.key === "no_balance" || st.key === "tipped_today") setNotice(st.text, "warn");
      paintTiers((cfg && cfg.tiersYuan) || []);
      syncSend();
    }

    function paintList(r) {
      listBox.innerHTML = "";
      /* 未登录 / 会话过期：整块不画（窗本来就要求登录，这里只是兜底） */
      if (!r) return;
      if (r.status === 401) return;
      if (!r.ok || !r.data) {
        /* 旧版服务端（非作者名单仍回 403）只对非作者静默：作者仍然要看到失败原因 */
        if (r.status === 403) {
          listBox.appendChild(el("div", "tip-k", T("打赏名单")));
          listBox.appendChild(el("div", "tip-list-empty", T("名单暂时取不到，稍后重试")));
          return;
        }
        listBox.appendChild(el("div", "tip-k", T("打赏名单")));
        listBox.appendChild(el("div", "tip-list-empty", errText(r)));
        return;
      }
      var d = r.data;
      /* scope 由服务端给：owner = 我是这个对象的作者（看全部名单）；
         mine = 不是作者（只看得到自己打赏出去的那几笔，名单里没有第三人）。 */
      var isOwner = d.scope !== "mine";
      var items = (d.items || []).filter(function (x) {
        return x && (isOwner ? !x.revoked : true);
      });
      listBox.appendChild(el("div", "tip-k", isOwner ? T("打赏名单") : T("我的打赏记录")));
      if (!items.length) {
        listBox.appendChild(
          el("div", "tip-list-empty", isOwner ? T("还没有人打赏") : T("您还没有打赏过这个对象")),
        );
        return;
      }
      /* 汇总行：作者看这一条收到的全部；其他人看自己打赏出去的合计（需求口径：合计人人可见，
         名字只给作者与自己）。 */
      var sumV = 0;
      var sumN = 0;
      items.forEach(function (it) {
        if (it.revoked) return;
        sumN++;
        sumV += coinOf(Number(it.amountYuan) || 0);
      });
      /* 汇总行的数字后用鲸圆币图标当单位（本轮口径：不再写「币」字） */
      var sum = el("div", "tip-list-sum");
      sum.appendChild(document.createTextNode(
        isOwner
          ? T("累计 {v} · {n} 次", { v: coinText(sumV), n: Number(d.count || sumN) })
          : T("您已打赏 {v} · {n} 次", { v: coinText(sumV), n: sumN }),
      ));
      sum.appendChild(coinIcon("sm"));
      listBox.appendChild(sum);
      var ul = el("div", "tip-rows");
      items.forEach(function (it) {
        var row = el("div", "tip-row" + (it.revoked ? " revoked" : ""));
        /* 作者看得到是谁打赏的（对账要用）；非作者这一列只有自己，写「您」比写账号名更贴口径 */
        var who = isOwner
          ? (it.from && (it.from.nickname || it.from.username)) || T("匿名用户")
          : T("您");
        row.appendChild(el("span", "tip-row-who", who));
        var amt = el("span", "tip-row-amt");
        amt.appendChild(document.createTextNode(coinText(coinOf(it.amountYuan)) + " "));
        amt.appendChild(coinIcon("sm"));
        row.appendChild(amt);
        row.appendChild(el("span", "tip-row-at", tsText(it.at)));
        if (it.revoked) row.appendChild(el("span", "tip-row-rev", T("已作废")));
        ul.appendChild(row);
      });
      listBox.appendChild(ul);
    }

    /* 打开即拉一次配置（可能已过期）+ 名单 + 这一组作者；配置回来后按钮才可点 */
    send.dataset.busy = "";
    Promise.all([config(true), loadList(target, 20), loadAuthors(target)]).then(function (arr) {
      paintStat(arr[0]);
      paintList(arr[1]);
      var au = arr[2];
      var d = au && au.ok && au.data ? au.data : null;
      AUTHORS = d && Array.isArray(d.authors) ? d.authors : [];
      /* 公开总额：调用方给的优先（卡片 / 详情本来就有 spec.tips），否则用作者接口回的公开汇总，
         再否则用名单接口回的那一份（作者本人拿得到全部、其他人拿到自己那几笔，正好当兜底）。 */
      function paintPublicTotal() {
        if (cloudMissing) return paintTotalCloudMissing();
        if (o.tips) return;
        if (d && d.tips) return paintTotal(d.tips);
        if (arr[1] && arr[1].ok && arr[1].data) paintTotal(arr[1].data);
      }
      /* 「该条目尚未上架云端」只认**真正**的 404（TIP_TARGET_NOT_FOUND = 云端根本没有这条记录）。
         刚上架时目录与打赏表可能还没同步，头一次 404 不能当真 —— 等一会儿再问一次，
         仍然 404 才按未上架显示（需求口径：实际有记录时不允许出现这句话）。
         其余失败（401 / 网络 / 5xx）一律保留调用方给的公开合计，绝不改写成「尚未上架」。 */
      if (!(au && Number(au.status) === 404)) return paintPublicTotal();
      totalLine.innerHTML = "";
      totalLine.className = "tip-total empty";
      totalLine.appendChild(el("span", "tip-total-t", T("正在读取打赏记录…")));
      var again = setTimeout(function () {
        if (!listBox.isConnected) return; /* 窗已关：不再回写 */
        loadAuthors(target).then(function (r2) {
          if (!listBox.isConnected) return;
          if (r2 && Number(r2.status) === 404) cloudMissing = true;
          else if (r2 && r2.ok && r2.data) {
            var d2 = r2.data;
            if (Array.isArray(d2.authors) && d2.authors.length) AUTHORS = d2.authors;
            d = d2;
          }
          paintPublicTotal();
          resetShares();
          paintSplit();
        });
      }, 1500);
      void again;
      resetShares();
      paintSplit();
    });

    send.addEventListener("click", function () {
      if (send.dataset.mode === "no_balance") {
        if (window.MtWallet && typeof window.MtWallet.open === "function") {
          window.MtWallet.open();
        } else {
          setNotice(T("余额不足：请到账号菜单里的「余额」充值"), "err");
        }
        return;
      }
      if (!picked) return;
      if (send.dataset.busy) return;
      /* 多作者：分账之和必须**正好等于**用户按下的那个数（补差位保证了这点）；
         凑不齐就当场说清，不发这一笔（服务端也会拒 TIP_SPLIT_INVALID）。 */
      var payload = { targetKind: target.kind, targetId: target.id, amountYuan: picked };
      if (AUTHORS.length > 1) {
        payload.splits = payloadSplits();
        /* 分账之和（分）必须正好等于这一笔总额（档位换算成币再换成分） */
        if (!payload.splits.length || splitSumCents() !== centsOfCoins(totalCoins())) {
          setNotice(T("分账之和必须等于你按的 {v}", { v: coinText(totalCoins()) }), "err");
          return;
        }
      }
      send.dataset.busy = "1";
      send.disabled = true;
      var want = picked;
      send.textContent = T("正在打赏…");
      api("POST", "/api/tips", payload)
        .then(function (r) {
          if (r && r.ok) {
            setNotice(T("打赏成功，感谢支持！"), "ok");
            invalidate();
            if (typeof o.onDone === "function") o.onDone(r.data || {});
            /* 刷新数值与名单（余额 / 今天是否已打赏都变了；额度只在服务端算，界面不显示） */
            return Promise.all([config(true), loadList(target, 20)]).then(function (arr) {
              paintStat(arr[0]);
              paintList(arr[1]);
              picked = 0;
              resetShares();
              paintSplit();
              syncSend();
            });
          }
          var code = codeOf(r);
          if (code === "BALANCE_INSUFFICIENT") {
            setNotice(T("鲸圆币余额不足，先去充值"), "err");
            if (window.MtWallet && typeof window.MtWallet.open === "function") window.MtWallet.open();
          } else if (code === "TIP_MONTH_LIMIT") {
            setNotice(T("本月打赏额度已用完（每月 1 日重置）"), "err");
          } else if (code === "TIP_DAILY_LIMIT") {
            setNotice(T("今天已给这个对象打赏过，明天再来"), "err");
          } else if (code === "SELF_TIP" || code === "TIP_SELF_TARGET") {
            setNotice(T("不能给自己打赏"), "err");
          } else if (code === "TIP_SPLIT_INVALID") {
            setNotice(T("分账金额不合法：请让合计正好等于你按的数额，且作者都在这一组里"), "err");
          } else {
            setNotice(errText(r), "err");
          }
          return config(true).then(paintStat);
        })
        .catch(function (e) {
          setNotice(String((e && e.message) || e), "err");
        })
        .then(function () {
          send.dataset.busy = "";
          syncSend();
        });
    });
  }

  /* ── 对外 ───────────────────────────────────────────────── */

  window.MtTips = {
    config: config,
    invalidate: invalidate,
    state: stateOf,
    targetKey: targetKey,
    kindText: kindText,
    metaEl: metaEl,
    buttonEl: buttonEl,
    open: openTipDialog,
    list: loadList,
    coinText: coinText,
    coinIcon: coinIcon,
    summaryText: summaryText,
    /* 累计打赏的悬停文案：卡片上只剩一枚金币 icon 时，汇总（`N 币 · M 次`）由它出
       （见 app-apps.js 的 appsAppsIconRow；没人打赏过时那句「还没有人打赏」也在它里面）。 */
    tipSumTitle: tipSumTitle,
  };
  /* 二级浮层壳：评论窗（app-comments.js）与打赏窗共用同一只，不各自造一只。 */
  window.MtPop = { open: popOpen, close: popClose };
})();

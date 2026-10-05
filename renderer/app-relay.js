"use strict";
/* MTNode 中转服务（账号托管）—— 自包含新模块，全局 window.MtRelay
 *
 * 它是什么：服务端 store-saas 的中转站（relay.mjs）在客户端只表现为「设置 · 提供商」
 * 里一张**只读**服务商卡。模型清单与接口地址由云端下发，凭据是账号登录态（主进程现取现用），
 * 所以卡上没有一处可手改的接入信息 —— 用户能改的只有「启用开关」与「本机优先级」。
 *
 * 数据流（契约见 docs/relay-admin.md）：
 *   登录成功 / 启动载入配置后 / 充值成功 / 换账号 / 打开设置与卡 / 手动「刷新」
 *     → window.api.relayMe()（主进程带账号 token 打 GET /api/relay/me，见 main.js 的 relay:me）
 *     · **本地已有快照就不再打扰服务端**：中转 Key 就是账号登录 token，长期不变，
 *       所以快照不设新鲜期、不按 24h 重拉；只有本地没有卡/没有快照时才拉
 *       （换账号、退出登录除外 —— 那时旧卡作废，必须重拉）。
 *     → 本模块把快照合进 S.config：
 *         · providers[] 里 upsert 一张 source="mtnode-relay" 的卡（保留用户排好的位置与停用开关）
 *         · modelKinds["mtnode-relay"] 写入服务端给的 text / image 形态
 *           （app-model-kind.js 的覆盖表，与用户手工纠正形态同一张表）
 *     → configSave 落盘 + 回刷提供商网格与画布
 *
 * 三条硬口径：
 *   1. **只有充值过的账号才有卡**：everRecharged=false ⇒ 连卡都不建（不是「建了再停用」）；
 *      有过充值 ⇒ 卡永久在，余额花光只置灰（relay.blocked）不消失。
 *   2. **凭据就是卡上的 apiKey（明文）**：中转 Key 由主进程写进本机 config.json 那张卡，
 *      设置卡上显示全文并给复制按钮（用户拿去给 Codex 等 OpenAI 兼容客户端用，
 *      Base URL 就是卡上那行）；桌宠 / 插件宿主是独立进程，读同一份配置即可用。
 *      KEY_PLACEHOLDER 只作「这张卡还没拿到真票」的识别标记，绝不下发（见 main.js 的
 *      providerAuthKey / relay:keyInfo）。渲染层不再做任何打码。
 *      「更换 Key」按钮走主进程 relay:rotateKey（服务端按账号自然日限 5 次）。
 *   3. **服务端是唯一真源**：清单 / 地址 / 形态一律以云端为准，本地只保留「顺序」与「停用」。
 *   4. **卡片类型是云端口径**：恒为 text_openai（文本 + 图像混挂一张卡，形态靠 modelKinds
 *      逐模型给出）。运行期「按模型纠类型」只改本次请求的副本（app-nodes.js
 *      requestProviderOf），本地卡被改坏时这里自动纠回（healType）。
 *
 * 依赖：window.api.relayMe（preload.js）、S.config / configSave（app.js）、
 *       I18n、可选 repaintSettingsProvTiles（app-settings.js）与 renderCanvas（app.js）。
 */
(function () {
  var PROVIDER_ID = "mtnode-relay";
  var SOURCE = "mtnode-relay";
  /* 配置里落的占位串：只作「这张卡还没拿到真票」的识别标记 —— 主进程读它来决定
     要不要去本机凭据档兜底（main.js 的 providerAuthKey），**绝不下发给上游**。 */
  var KEY_PLACEHOLDER = "mtnode-account-token";
  /* 快照新鲜期：只作为「卡上那行状态」的时间口径保留（见 stateText），
     不再用它决定要不要重拉 —— 拉取时机唯一条款是「本地有没有快照」。 */
  var FRESH_MS = 24 * 3600 * 1000;
  /* 本地没卡又拉失败时的自愈重试间隔（只补一次，之后交给设置页的「刷新中转清单」） */
  var RETRY_GAP_MS = 10 * 1000;

  var LISTENERS = [];
  var lastUserId = "";
  var syncing = null;
  /* 登录态比 S.config 先到（app-auth.js 在 DOMContentLoaded 刷新登录态，
     配置要等 app-boot.js 的 init() 才载入）：这一刻拉不到本地卡片，
     记一笔待补，config 载入后由 flush() 补一次（见 app-boot.js）。 */
  var pendingFlush = false;
  var pendingForce = false;
  var retryTimer = null;
  /* 正在续期凭据（renewDue 命中时 sync({force:true}) 跑着）：只挡并发，不做失败节流 */
  var renewing = false;

  function T(s, vars) {
    return window.I18n && window.I18n.t ? window.I18n.t(s, vars) : s;
  }
  function cfg() {
    if (typeof S === "undefined" || !S) return null;
    return S.config || null;
  }
  function providers() {
    var c = cfg();
    return c && Array.isArray(c.providers) ? c.providers : [];
  }
  function isRelay(p) {
    return !!p && String(p.source || "") === SOURCE;
  }
  function providerOf() {
    var list = providers();
    for (var i = 0; i < list.length; i++) if (isRelay(list[i])) return list[i];
    return null;
  }
  /* 卡上那份快照（relay 元数据）：模型清单 / 上次同步时间 / 余额 / 打码凭据都从这里读 */
  function meta(p) {
    return (isRelay(p) && p.relay) || {};
  }
  function isBlocked(p) {
    return meta(p).blocked === true;
  }
  /* key = 卡上那串真 Key（有票时非空）；authKey = 账号凭据到没到；
     keyIssue = 没到时的原因（"" = 没登录 / "decrypt_failed" 等 = 凭据在手却解不开）；
     rotate = 手动换票的当日余量（{ left, limit, day }，服务端口径）。
     这些都只用于「卡上 API Key 那一格怎么显示 / 换 Key 按钮还能不能点」，
     不参与任何鉴权判断 —— 鉴权真源仍是 providerAuthKey 读到的这一串。 */
  function keyViewOf(p) {
    var m = meta(p);
    return {
      authKey: m.authKey === true,
      key: String(p && p.apiKey ? p.apiKey : ""),
      keyIssue: String(m.keyIssue || ""),
      fromRelayKey: m.fromRelayKey === true,
      expiresAt: Number(m.expiresAt || 0) || 0,
      renewDue: m.renewDue === true,
      rotate: m.rotate || null,
    };
  }
  /* 主进程回的那一份（relayKeyInfo 的字段）→ 本模块内部口径（只做一次映射）。 */
  function keyViewFromInfo(r) {
    return {
      authKey: !!String(r.key || ""),
      key: String(r.key || ""),
      keyIssue: String(r.readIssue || r.writeIssue || ""),
      /* 凭据来源与有效期（卡上那几行状态文案用）：fromConfig = 配置卡上那份
         （Codex / 桌宠读的就是它），fromRelayKey = 本机凭据档里也有同一张。 */
      fromConfig: r.fromConfig === true,
      fromRelayKey: r.fromRelayKey === true,
      expiresAt: Number(r.expiresAt || 0) || 0,
      renewDue: r.renewDue === true,
      rotate: r.rotate || null,
    };
  }
  /* 最近一次取到的凭据（**还没落进卡时**的暂存）：第一次成功同步会新建整张卡，
     那一刻 applyDoc 拿不到旧值；不留这份暂存，卡建出来的当次会显示成「还没拿到票」。 */
  var cachedKeyView = null;
  /* 凭据只用于界面显示与落盘：把它从卡上抹掉（换账号 / 退出登录时调，下一次同步会重新取）。
     抹掉 = 卡上 apiKey 退回占位标记（识别「还没拿到真票」），真票由主进程重新写回。 */
  function resetKeyView() {
    cachedKeyView = null;
    var p = providerOf();
    if (!p) return;
    p.apiKey = KEY_PLACEHOLDER;
    if (!p.relay) return;
    p.relay = Object.assign({}, p.relay, {
      authKey: false,
      keyIssue: "",
      fromConfig: false,
      fromRelayKey: false,
      expiresAt: 0,
      renewDue: false,
      rotate: null,
    });
  }
  function syncKeyInfo() {
    if (!window.api || !window.api.relayKeyInfo) return Promise.resolve(null);
    return Promise.resolve(window.api.relayKeyInfo()).then(
      function (r) {
        if (!r || !r.ok) return null;
        var key = keyViewFromInfo(r);
        cachedKeyView = key;
        var p = providerOf();
        /* 落进快照给界面显示 + 把真票写进卡上的 apiKey（随下一次 configSave 一起写盘；
           磁盘上那份是主进程写的，这里只是让内存里的卡与它一致）。 */
        if (p) {
          p.apiKey = key.key || KEY_PLACEHOLDER;
          p.relay = Object.assign({}, meta(p), {
            authKey: key.authKey,
            keyIssue: key.keyIssue,
            fromConfig: key.fromConfig,
            fromRelayKey: key.fromRelayKey,
            expiresAt: key.expiresAt,
            renewDue: key.renewDue,
            rotate: key.rotate,
          });
        }
        return key;
      },
      function () {
        return null;
      },
    );
  }
  /* 卡上那行 API Key 的取值，优先级：**本次刚取到的** > 卡上那份 > 空（还没拿到票）。
     为什么「刚取到的」排第一：applyDoc 重建整张卡时，本次 syncKeyInfo 的结果可能只落在
     旧 provider 引用上（旧引用随后被整张新卡替换掉），照旧值走会把新取到的票丢掉。 */
  function keyViewFor(prov) {
    var v = cachedKeyView || (prov ? keyViewOf(prov) : null);
    var key = String((v && v.key) || "");
    if (!key && prov) {
      var own = String(prov.apiKey || "");
      if (own && own !== KEY_PLACEHOLDER) key = own;
    }
    return {
      authKey: !!(v && v.authKey) || !!key,
      key: key,
      keyIssue: String((v && v.keyIssue) || ""),
      fromConfig: !!(v && v.fromConfig),
      fromRelayKey: !!(v && v.fromRelayKey),
      expiresAt: Number((v && v.expiresAt) || 0) || 0,
      renewDue: !!(v && v.renewDue),
      rotate: (v && v.rotate) || null,
    };
  }
  function tsText(ms) {
    if (!ms) return "—";
    var d = new Date(Number(ms));
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
  }
  /* 金额一律「元」（显示保留 1 位小数，真源 = MtWallet.money）：入参已经是元，
     这里只格式化，不做分↔元换算。
     **只在真正走支付宝的元金额上用**（充值窗的「实付 ¥…」与退款说明）。
     中转余额 / 档位 / 订单流水这些账户资产一律走鲸圆币（window.MtCoin /
     MtWallet.balanceEl / coinEl），本函数不要再拿去画余额 —— 那会把 ¥ 又带回来。 */
  function money(yuan) {
    if (window.MtWallet && window.MtWallet.money) return window.MtWallet.money(yuan);
    return "¥" + Number(yuan || 0).toFixed(1);
  }

  function emit(kind) {
    for (var i = 0; i < LISTENERS.length; i++) {
      try {
        LISTENERS[i](kind);
      } catch (e) {
        /* 监听者自己的错不拖垮同步 */
      }
    }
    /* 网格 / 会话里的模型清单都要跟着变：能刷就刷，刷不了（模块缺席）也不报错 */
    if (typeof repaintSettingsProvTiles === "function") {
      try {
        repaintSettingsProvTiles();
      } catch (e) {}
    }
    if (typeof renderCanvas === "function") {
      try {
        renderCanvas();
      } catch (e) {}
    }
  }
  function saveConfig() {
    if (!window.api || !window.api.configSave) return Promise.resolve(false);
    var c = cfg();
    if (!c) return Promise.resolve(false);
    return Promise.resolve(window.api.configSave(c)).then(
      function () {
        return true;
      },
      function () {
        return false;
      },
    );
  }

  /* 别的服务商里「真能用」的（有 Key / 有地址）：中转卡该置顶还是追加，看它有没有 */
  function hasUsableOther(self) {
    return providers().some(function (p) {
      return (
        p &&
        p !== self &&
        String(p.source || "") !== SOURCE &&
        String(p.apiKey || "").trim() &&
        String(p.baseUrl || "").trim()
      );
    });
  }

  /* 本地优先级顺序保留：按 id 取交集，新模型追加末尾（刷新不重排用户拖过的顺序） */
  function mergeOrder(prev, ids) {
    var old = (prev || []).map(String);
    var set = {};
    for (var i = 0; i < ids.length; i++) set[ids[i]] = true;
    var keep = old.filter(function (id) {
      return set[id];
    });
    var added = ids.filter(function (id) {
      return old.indexOf(id) < 0;
    });
    return keep.concat(added);
  }

  function kindsOf(doc) {
    var out = {};
    var list = (doc && doc.models) || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      if (!m.id) continue;
      out[String(m.id)] = m.kind === "image" ? "image" : "text";
    }
    return out;
  }

  /* 把卡收掉（从没充过值 / 退出登录 / 换账号）。换账号时本地那份凭据属于上一个账号，
     一并丢掉（新卡由下一次 applyDoc + syncKeyInfo 重新取），免得把别人的 Key 留在
     新账号脸上。 */
  function dropProvider() {
    var c = cfg();
    if (!c || !Array.isArray(c.providers)) return false;
    var before = c.providers.length;
    resetKeyView();
    c.providers = c.providers.filter(function (p) {
      return !isRelay(p);
    });
    if (c.modelKinds && c.modelKinds[PROVIDER_ID]) delete c.modelKinds[PROVIDER_ID];
    return c.providers.length !== before;
  }

  /* 逐模型价目（云端下发的那一份，见 store-saas/relay.mjs 的 userModels）：只留数值字段，
     键 = 模型 id —— 本地「中转按币」计价（app-cost.js）就吃这张表，不再自己猜价。
     服务端没下发（老部署）时这里是 {}，计价侧按「无价目」处理（显示 —，不猜价）。 */
  function pricesOf(doc) {
    var out = {};
    ((doc && doc.models) || []).forEach(function (m) {
      var id = String((m && m.id) || "").trim();
      var p = m && m.price;
      if (!id || !p || typeof p !== "object") return;
      var kind = String(p.kind || (m && m.kind) || "text");
      if (kind === "image") {
        out[id] = { kind: "image", perImageYuan: Number(p.perImageYuan) || 0 };
        return;
      }
      out[id] = {
        kind: "text",
        cacheHit: Number(p.cacheHit) || 0,
        cacheMiss: Number(p.cacheMiss) || 0,
        output: Number(p.output) || 0,
        peakMultiplier: Number(p.peakMultiplier) || 1,
      };
    });
    return out;
  }

  /* 把云端快照写进 config —— 返回是否真的有改动（没改就不写盘，省一次备份快照） */
  function applyDoc(doc, at) {
    var c = cfg();
    if (!c) return false;
    if (!Array.isArray(c.providers)) c.providers = [];
    var prov = providerOf();
    var ids = ((doc && doc.models) || []).map(function (m) {
      return String(m && m.id ? m.id : "");
    }).filter(Boolean);
    var blocked = !doc.enabled || !ids.length;
    var prevOrder = prov ? (meta(prov).models || prov.models || []) : [];
    var ordered = mergeOrder(prevOrder, ids);
    /* 卡上那行 API Key 的口径：**明文真票**（主进程写盘的那一串，见 relay:keyInfo）；
       还没拿到票时退回占位标记（识别「这张卡还没拿到真票」，绝不下发）。
       取值优先级都收在 keyViewFor 里（见上）。 */
    var keyView = keyViewFor(prov);
    var next = {
      id: PROVIDER_ID,
      name: String(doc.providerName || "") || T("MTNode 中转服务"),
      source: SOURCE,
      type: "text_openai",
      baseUrl: String(doc.baseUrl || ""),
      /* 真票落在 apiKey 上：设置卡显示全文 + 复制按钮，Codex / 桌宠读同一份配置即可用。 */
      apiKey: keyView.key || KEY_PLACEHOLDER,
      vision: true,
      /* models = 当前可被节点选中的清单；余额耗尽时为空 ⇒ 各处模型选择器自动列不到它
         （真正的快照留在 relay.models，卡置灰时照旧列给用户看） */
      models: blocked ? [] : ordered.slice(),
      relay: {
        everRecharged: true,
        models: ordered,
        kinds: kindsOf(doc),
        /* 逐模型真实价目 + 峰谷判据的两半（节假日豁免日期 / 鲸圆币汇率）：
           本地「中转按币」计价与云端同源，见 store-saas/relay.mjs 的 textCostYuan。 */
        prices: pricesOf(doc),
        peaks: ((doc && doc.peaks) || []).map(function (s) {
          return String(s || "").trim();
        }).filter(Boolean),
        coinYuan: Number(doc && doc.coinYuan) || 0,
        at: Number(at) || Date.now(),
        error: "",
        errorAt: 0,
        reason: String(doc.reason || ""),
        /* 余额一律「元」（4 位小数）：服务端快照只给 Yuan 字段，客户端不做分↔元换算。 */
        balanceYuan: Number(doc.balanceYuan) || 0,
        totalYuan: Number(doc.totalYuan) || 0,
        blocked: blocked,
        /* 凭据一并落在卡的 relay 元数据里给界面显示（真票本身在 provider.apiKey 上）；
           有效期 / 续期状态一起带上（卡上「凭据」那一行要说得清什么时候该换票）。 */
        authKey: keyView.authKey,
        keyIssue: keyView.keyIssue,
        fromConfig: keyView.fromConfig,
        fromRelayKey: keyView.fromRelayKey,
        expiresAt: keyView.expiresAt,
        renewDue: keyView.renewDue,
        rotate: keyView.rotate,
      },
    };
    if (prov) next.disabled = prov.disabled === true;
    else next.disabled = false;

    var changed = !prov || JSON.stringify(prov) !== JSON.stringify(next);
    if (!prov) {
      /* 位置：名下还有别的「真能用」的服务商就追加到末尾，一个都没有才置顶 ——
         不让中转卡抢走别人已经配好并跑着的默认服务商。 */
      if (hasUsableOther(null)) c.providers.push(next);
      else c.providers.unshift(next);
    } else {
      c.providers[c.providers.indexOf(prov)] = next;
    }
    if (!c.modelKinds || typeof c.modelKinds !== "object") c.modelKinds = {};
    c.modelKinds[PROVIDER_ID] = next.relay.kinds;
    return changed;
  }

  /* 本地有没有这张卡 / 这份快照：拉取时机的唯一条款（有就不打扰服务端） */
  function hasLocalSnapshot() {
    var prov = providerOf();
    return !!(prov && Number(meta(prov).at) > 0);
  }

  /* 凭据该不该续期（纯本地问一次主进程，不打服务端）：中转 Key 是独立的 3650 天票
     （见 store-saas/server.mjs 的 issueRelayKey），剩余不足续期窗口就该重领一张 ——
     否则一张票用到最后一天，用户会在毫无预兆的情况下撞「凭据已失效」401。
     判据只来自主进程 relay:keyInfo 的 renewDue。
     「卡上还没有票」也算到期：服务端会借这次续期把票补上，
     用户不必自己去点「刷新中转清单」。 */
  function renewDue() {
    if (!window.api || typeof window.api.relayKeyInfo !== "function") return Promise.resolve(false);
    return Promise.resolve(window.api.relayKeyInfo()).then(
      function (info) {
        var i = info || {};
        return !!(i.signedIn && (!String(i.key || "") || i.renewDue));
      },
      function () {
        return false;
      },
    );
  }

  /* 卡片类型自愈（只动本地，不打服务端）：中转卡的类型是**云端口径**，恒为 text_openai，
     文本 / 图像形态由 relay.kinds → config.modelKinds 逐模型给出（见 applyDoc）。
     老版本 / 曾被运行期「按模型纠类型」改写成 image_openai 的卡，其**文本模型**会从会话与
     节点的模型选择器里一起消失（那些地方只认 text_openai 的服务商），用户得手动点一次
     「刷新中转清单」才回来。这里就地把类型改回 text_openai 并落盘，打开设置 /
     登录态刷新即自动恢复。返回 Promise<boolean>（是否真的改过）。 */
  function healType() {
    var prov = providerOf();
    if (!prov || String(prov.type || "") === "text_openai")
      return Promise.resolve(false);
    prov.type = "text_openai";
    return saveConfig().then(
      function () {
        emit("synced");
        return true;
      },
      function () {
        return false;
      },
    );
  }

  /* 拉一次快照并合并。**只在本地还没有快照时才拉**（Key = 账号登录 token，长期不变）；
     opts.force=true = 用户显式点「刷新中转清单」（换账号、充值到账、修好网络后自己重拉）。 */
  function sync(opts) {
    var o = opts || {};
    if (!window.api || !window.api.relayMe) {
      return Promise.resolve({ ok: false, error: "relay-bridge-missing" });
    }
    /* 配置还没载入（启动竞态）：本地状态未知 → 不能当成「没有卡」去拉，
       记一笔待补，等 app-boot.js 载入配置后 flush() 再来（新装应用登录后
       中转卡建不出来的根因就在这里：以前这一拉静默失败，之后再无重试）。 */
    if (!cfg()) {
      pendingFlush = true;
      pendingForce = pendingForce || !!o.force;
      return Promise.resolve({ ok: false, error: "config-not-ready", needsConfig: true });
    }
    if (hasLocalSnapshot() && !o.force) {
      return Promise.resolve({ ok: true, skipped: true, reason: "local" });
    }
    if (syncing && !o.force) return syncing;
    syncing = Promise.resolve()
      .then(function () {
        /* 凭据打码串先取一次（纯本地，不打服务端）：卡上「API Key」那一行立刻有内容，
           拉清单失败也照旧看得见凭据在不在（见 syncKeyInfo）。 */
        return syncKeyInfo().then(function () {
          return window.api.relayMe();
        });
      })
      .then(function (r) {
        var prov = providerOf();
        if (!r || !r.ok) {
          /* 拉取失败（断网 / 服务不可用 / 未登录）：沿用上次成功的快照，只把原因挂回卡上，
             没有卡时什么都不做（下次成功同步再建）。 */
          if (prov) {
            /* 打码凭据先取一次：脱离服务端也能显示「凭据在不在」（syncKeyInfo 只问主进程的
               账号凭据，不发网络请求），下面挂失败原因时按现值合并，不把它冲掉 */
            return syncKeyInfo().then(function () {
              prov.relay = Object.assign({}, meta(prov), {
                error: String((r && r.error) || T("中转服务暂时不可用，请稍后重试")),
                errorAt: Date.now(),
              });
              return saveConfig().then(function () {
                emit("error");
                return {
                  ok: false,
                  error: prov.relay.error,
                  status: Number((r && r.status) || 0) || 0,
                };
              });
            });
          }
          return {
            ok: false,
            error: String((r && r.error) || T("中转服务暂时不可用，请稍后重试")),
            status: Number((r && r.status) || 0) || 0,
          };
        }
        var doc = (r && r.doc) || {};
        /* 领到票的那一刻就把凭据落进卡里（不再等下一次登录 / 下次打开设置）：
           主进程在这一次响应里已经把新票写进本机凭据档与 config.json 那张卡（keyState），
           这里直接认它 —— 少了这一步，卡上还是占位标记、顶部横幅也照旧亮着，
           用户会以为「重新登录根本没领到」，正是上报的那个死循环。 */
        var ks = (r && r.keyState) || null;
        var ksKey = String((ks && ks.key) || (r && r.key) || "");
        if (ks && ksKey) {
          cachedKeyView = {
            authKey: true,
            key: ksKey,
            keyIssue: "",
            fromConfig: ks.fromConfig === true,
            fromRelayKey: ks.fromRelayKey === true,
            expiresAt: Number(ks.expiresAt || (r && r.keyExpiresAt) || 0) || 0,
            renewDue: ks.due === true,
            rotate: (r && r.rotate) || ks.rotate || null,
          };
        } else if (ks && ks.writeIssue) {
          /* 服务端发了票、本机写不下去（写后回读校验拦下：见 auth-store.js）——
             把原因摆在卡上，别再让用户对着「重新登录一次即可」反复重登。
             配置卡仍可能救回来（那是另一条落盘路径），所以这里只说凭据档的问题。 */
          cachedKeyView = {
            authKey: false,
            key: "",
            keyIssue: String(ks.writeIssue),
            fromRelayKey: false,
            expiresAt: 0,
            renewDue: false,
            rotate: (r && r.rotate) || null,
          };
        } else if (!ks && r && r.issuedRelayKey === false) {
          /* 服务端没发独立票（老服务端）：说清是服务端这一侧的事，不是用户没登录 */
          cachedKeyView = {
            authKey: false,
            key: "",
            keyIssue: "server_no_relay_key",
            fromRelayKey: false,
            expiresAt: 0,
            renewDue: false,
            rotate: null,
          };
        }
        if (!doc.everRecharged) {
          /* 从没充过值：连卡都不该在（含退出登录 / 换到没充值的账号） */
          var removed = dropProvider();
          return (removed ? saveConfig() : Promise.resolve(false)).then(function () {
            if (removed) emit("removed");
            return { ok: true, everRecharged: false, changed: removed };
          });
        }
        var changed = applyDoc(doc, r.at);
        return saveConfig().then(function (saved) {
          emit("synced");
          /* 领到票的这一刻，两条界面提示都要立刻改口径：卡上「凭据」那一行（emit 已经回刷了
             网格与正在开着的卡）与顶部那条横幅（快到期 / 凭据解不开时亮的那条）——
             横幅读的是主进程的 relay:keyInfo，所以要再问一次（纯本地，不打服务端）。 */
          if (ksKey && typeof MtRelayAuth !== "undefined" && MtRelayAuth.refresh) {
            try {
              MtRelayAuth.refresh();
            } catch (e) {}
          }
          return { ok: true, everRecharged: true, changed: changed || saved };
        });
      })
      .catch(function (e) {
        return { ok: false, error: String((e && e.message) || e) };
      });
    var done = function () {
      syncing = null;
    };
    syncing.then(done, done);
    var out = syncing;
    /* 本地没卡又拉不到（断网 / 服务端抖一下）：10 秒后自己再试一次 —— 用户刚登录
       却看不到中转卡，最可能的是一次瞬时失败；再失败就等设置页的「刷新中转清单」。
       用户显式点刷新（o.force）不排自愈重试：那一条由用户自己掌握节奏。 */
    if (!hasLocalSnapshot() && !o.force) {
      var retry = function () {
        if (hasLocalSnapshot()) return;
        if (!cfg() || !window.MTNodeAuth || !window.MTNodeAuth.state) return;
        var st = window.MTNodeAuth.state() || {};
        if (!st.signedIn) return;
        sync({});
      };
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(retry, RETRY_GAP_MS);
      if (retryTimer && retryTimer.unref) retryTimer.unref();
    }
    return out;
  }

  /* 打开设置 / 提供商卡 / 登录态每次刷新时用：**本地有快照就什么都不做**
     （不按时间重拉、也不做失败节流 —— 失败一次就不再重试正是「新装应用登录后
     一直缺中转 key」的老毛病；重试入口始终在：设置页的「刷新中转清单」与登录态刷新）。
     唯一例外是卡上还没有真票（老快照 / 刚被 401 清过）：顺手问一次主进程补上，
     让老快照的卡也能显示 Key（纯本地，不打服务端）。 */
  function syncIfStale() {
    var heal = healType();
    /* 凭据到期（或本机还没有独立票）时先续一次：入口 /api/relay/me 在服务端同时是发放口，
       这一次同步会把新的 3650 天票领回本机（见 main.js 的 relay:me）。登录 / 启动 /
       打开设置卡片都经过这里，所以续期是「顺带发生」的，不靠用户记得去点刷新。
       票丢了 / 被顶掉（本机有卡但票没了）不靠这里兜底 —— 那条路由主进程的
       ensureRelayCredential 在请求前与撞 401 时自己补（见 main.js），用户零操作。
       renewing 只挡并发：续期失败就是失败，下一轮（下次打开设置 / 下次登录态刷新）还会再来，
       不做失败节流。 */
    return renewDue().then(function (due) {
      if (due) {
        if (!renewing) {
          renewing = true;
          var retry = function () {
            renewing = false;
          };
          heal = heal.then(function () {
            return sync({ force: true }).then(retry, retry);
          });
        }
        return heal.then(function () {
          return { ok: true, skipped: true, reason: "renewing" };
        });
      }
      if (hasLocalSnapshot()) {
        var p = providerOf();
        var ownKey = String((p && p.apiKey) || "");
        if (p && (!ownKey || ownKey === KEY_PLACEHOLDER)) {
          return heal
            .then(function () {
              return syncKeyInfo();
            })
            .then(function () {
              return { ok: true, skipped: true };
            });
        }
        return heal.then(function () {
          return { ok: true, skipped: true };
        });
      }
      return heal.then(function () {
        return sync({});
      });
    });
  }

  /* 登录态变化（app-auth.js 每次 refresh 后调）：换了账号必须重拉（清单跟着账号走，
     且旧账号的卡必须先作废，免得把上一个账号的模型留在新账号脸上）；
     同一账号只看本地有没有快照；退出登录把卡收掉。 */
  function onAuthState(user) {
    var uid = user && user.id ? String(user.id) : "";
    if (!uid) {
      lastUserId = "";
      if (providerOf()) {
        dropProvider();
        return saveConfig().then(function () {
          emit("logout");
        });
      }
      return Promise.resolve();
    }
    if (uid === lastUserId) return syncIfStale();
    lastUserId = uid;
    /* 换账号：本地那份快照属于上一个账号，先作废（只动内存，紧接着的 sync 会连盘一起写） */
    dropProvider();
    return sync({ force: true });
  }

  /* 配置载入完成后的补拉（app-boot.js 的 init() 在 S.config 就绪后调一次）：
     启动时登录态往往比配置先到，那次同步只能记 pending；config 一到就补上，
     保证「新装应用 + 重新登录充值账号」一进界面就有中转卡与凭据。 */
  function flush() {
    if (!pendingFlush) return Promise.resolve({ ok: true, skipped: true, reason: "idle" });
    var force = pendingForce;
    pendingFlush = false;
    pendingForce = false;
    var u = null;
    try {
      if (window.MTNodeAuth && window.MTNodeAuth.state) {
        var st = window.MTNodeAuth.state() || {};
        u = st.signedIn ? st.user : null;
      }
    } catch (e) {}
    if (!u) return Promise.resolve({ ok: true, skipped: true, reason: "signed-out" });
    var uid = String(u.id || "");
    /* 换账号（含启动前那份快照属于别的账号）才强制重拉；同账号照旧只看本地有没有快照 */
    var needForce = force || (uid && uid !== lastUserId);
    lastUserId = uid;
    if (needForce) {
      dropProvider();
      return sync({ force: true });
    }
    return syncIfStale();
  }

  function onChange(cb) {
    if (typeof cb !== "function") return function () {};
    LISTENERS.push(cb);
    return function () {
      var i = LISTENERS.indexOf(cb);
      if (i >= 0) LISTENERS.splice(i, 1);
    };
  }

  /* 手动更换中转 Key（中转卡上那个按钮）：
     走主进程 relay:rotateKey → POST /api/relay/me { rotate: true }（幂发口径下
     GET 只会拿回同一张票，换票必须走这个显式入口）；服务端按账号自然日限 5 次，
     超限回 429「今日更换次数已用完（5/5）」，旧票立即失效。
     成功后把新票写进内存里的卡并落盘（磁盘上那份已由主进程写好），
     失败原样回报（含 status / code / rotate 余量），由调用方给提示。 */
  function rotateKey() {
    if (!window.api || typeof window.api.relayRotateKey !== "function") {
      return Promise.resolve({ ok: false, error: "relay-bridge-missing" });
    }
    return Promise.resolve(window.api.relayRotateKey()).then(function (r) {
      var res = r || {};
      if (!res.ok) return res;
      var key = String(res.key || "");
      if (!key) return { ok: false, error: T("服务端没有下发新的中转 Key，请稍后重试") };
      var p = providerOf();
      var view = {
        authKey: true,
        key: key,
        keyIssue: "",
        fromConfig: true,
        fromRelayKey: !!(cachedKeyView && cachedKeyView.fromRelayKey),
        expiresAt: Number(res.keyExpiresAt || 0) || 0,
        renewDue: false,
        rotate: res.rotate || null,
      };
      cachedKeyView = view;
      if (p) {
        p.apiKey = key;
        p.relay = Object.assign({}, meta(p), {
          authKey: true,
          keyIssue: "",
          fromConfig: true,
          fromRelayKey: view.fromRelayKey,
          expiresAt: view.expiresAt,
          renewDue: false,
          rotate: view.rotate,
        });
      }
      return saveConfig().then(function () {
        emit("synced");
        try {
          if (typeof MtRelayAuth !== "undefined" && MtRelayAuth.refresh) MtRelayAuth.refresh();
        } catch (e) {}
        return res;
      });
    });
  }

  window.MtRelay = {
    PROVIDER_ID: PROVIDER_ID,
    SOURCE: SOURCE,
    KEY_PLACEHOLDER: KEY_PLACEHOLDER,
    /* 卡上那行 API Key 的取值口径（**明文真票**；没票时为空串，由卡片给动作提示）：
       导出给 app-settings.js 与回归用，别在别处再手抄一遍优先级。 */
    keyView: keyViewFor,
    /* 手动更换中转 Key（服务端按账号自然日限 5 次） */
    rotateKey: rotateKey,
    FRESH_MS: FRESH_MS,
    isRelay: isRelay,
    provider: providerOf,
    meta: meta,
    isBlocked: isBlocked,
    sync: sync,
    syncIfStale: syncIfStale,
    onAuthState: onAuthState,
    flush: flush,
    hasLocalSnapshot: hasLocalSnapshot,
    onChange: onChange,
    tsText: tsText,
    money: money,
    /* 卡上那一行状态文案的取值口径（app-settings.js 与回归都读它） */
    stateText: function (prov) {
      var m = meta(prov);
      if (m.error) return T("刷新失败：") + m.error;
      if (m.blocked) return m.reason || T("余额不足，充值后刷新");
      if (!m.at) return T("未同步（点「刷新中转清单」重试）");
      return T("上次同步 ") + tsText(m.at);
    },
  };
})();

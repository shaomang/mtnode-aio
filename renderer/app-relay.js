"use strict";
/* MTNode 中转服务（账号托管）—— 自包含新模块，全局 window.MtRelay
 *
 * 它是什么：服务端 store-saas 的中转站（relay.mjs）在客户端只表现为「设置 · 提供商」
 * 里一张**只读**服务商卡。模型清单与接口地址由云端下发，凭据是账号登录态（主进程现取现用），
 * 所以卡上没有一处可手改的接入信息 —— 用户能改的只有「启用开关」与「本机优先级」。
 *
 * 数据流（契约见 docs/relay-admin.md）：
 *   登录成功 / 充值成功 / 打开卡（快照 >24h）/ 手动「刷新」
 *     → window.api.relayMe()（主进程带账号 token 打 GET /api/relay/me，见 main.js 的 relay:me）
 *     → 本模块把快照合进 S.config：
 *         · providers[] 里 upsert 一张 source="mtnode-relay" 的卡（保留用户排好的位置与停用开关）
 *         · modelKinds["mtnode-relay"] 写入服务端给的 text / image 形态
 *           （app-model-kind.js 的覆盖表，与用户手工纠正形态同一张表）
 *     → configSave 落盘 + 回刷提供商网格与画布
 *
 * 三条硬口径：
 *   1. **只有充值过的账号才有卡**：everRecharged=false ⇒ 连卡都不建（不是「建了再停用」）；
 *      有过充值 ⇒ 卡永久在，余额花光只置灰（relay.blocked）不消失。
 *   2. **凭据不落盘**：provider.apiKey 只落占位串（KEY_PLACEHOLDER），真 token 由主进程
 *      在请求时现取；渲染层从头到尾看不到 token，也不硬编码中转站地址。
 *   3. **服务端是唯一真源**：清单 / 地址 / 形态一律以云端为准，本地只保留「顺序」与「停用」。
 *
 * 依赖：window.api.relayMe（preload.js）、S.config / configSave（app.js）、
 *       I18n、可选 repaintSettingsProvTiles（app-settings.js）与 renderCanvas（app.js）。
 */
(function () {
  var PROVIDER_ID = "mtnode-relay";
  var SOURCE = "mtnode-relay";
  /* 配置里落的占位串：渲染层各处「有没有填 Key」的闸门因此照旧通过，
     真正下发的 Authorization 由主进程换成账号 token（main.js 的 providerAuthKey）。 */
  var KEY_PLACEHOLDER = "mtnode-account-token";
  var FRESH_MS = 24 * 3600 * 1000;
  var RETRY_GAP_MS = 60 * 1000;

  var LISTENERS = [];
  var lastUserId = "";
  var syncing = null;
  var lastAttemptAt = 0;

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
  function meta(p) {
    return (isRelay(p) && p.relay) || {};
  }
  function isBlocked(p) {
    return meta(p).blocked === true;
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
  /* 金额一律「元」（4 位小数）：入参已经是元，这里只格式化，不做分↔元换算。 */
  function money(yuan) {
    if (window.MtWallet && window.MtWallet.money) return window.MtWallet.money(yuan);
    return "¥" + Number(yuan || 0).toFixed(4);
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

  function dropProvider() {
    var c = cfg();
    if (!c || !Array.isArray(c.providers)) return false;
    var before = c.providers.length;
    c.providers = c.providers.filter(function (p) {
      return !isRelay(p);
    });
    if (c.modelKinds && c.modelKinds[PROVIDER_ID]) delete c.modelKinds[PROVIDER_ID];
    return c.providers.length !== before;
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
    var next = {
      id: PROVIDER_ID,
      name: String(doc.providerName || "") || T("MTNode 中转服务"),
      source: SOURCE,
      type: "text_openai",
      baseUrl: String(doc.baseUrl || ""),
      apiKey: KEY_PLACEHOLDER,
      vision: true,
      /* models = 当前可被节点选中的清单；余额耗尽时为空 ⇒ 各处模型选择器自动列不到它
         （真正的快照留在 relay.models，卡置灰时照旧列给用户看） */
      models: blocked ? [] : ordered.slice(),
      relay: {
        everRecharged: true,
        models: ordered,
        kinds: kindsOf(doc),
        at: Number(at) || Date.now(),
        error: "",
        errorAt: 0,
        reason: String(doc.reason || ""),
        /* 余额一律「元」（4 位小数）：服务端快照只给 Yuan 字段，客户端不做分↔元换算。 */
        balanceYuan: Number(doc.balanceYuan) || 0,
        totalYuan: Number(doc.totalYuan) || 0,
        blocked: blocked,
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

  /* 拉一次快照并合并。opts.force=true 时忽略「正在同步」标记强制重来 */
  function sync(opts) {
    var o = opts || {};
    if (!window.api || !window.api.relayMe) {
      return Promise.resolve({ ok: false, error: "relay-bridge-missing" });
    }
    if (syncing && !o.force) return syncing;
    lastAttemptAt = Date.now();
    syncing = Promise.resolve()
      .then(function () {
        return window.api.relayMe();
      })
      .then(function (r) {
        var prov = providerOf();
        if (!r || !r.ok) {
          /* 拉取失败（断网 / 服务不可用 / 未登录）：沿用上次成功的快照，只把原因挂回卡上，
             没有卡时什么都不做（下次成功同步再建）。 */
          if (prov) {
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
          }
          return {
            ok: false,
            error: String((r && r.error) || T("中转服务暂时不可用，请稍后重试")),
            status: Number((r && r.status) || 0) || 0,
          };
        }
        var doc = (r && r.doc) || {};
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
    return syncing;
  }

  /* 打开设置 / 提供商卡时用：快照还新鲜（24h 内）就不打扰服务端 */
  function syncIfStale() {
    var prov = providerOf();
    var at = Number(meta(prov).at) || 0;
    if (prov && at && Date.now() - at < FRESH_MS) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    if (Date.now() - lastAttemptAt < RETRY_GAP_MS && !prov) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    return sync({});
  }

  /* 登录态变化（app-auth.js 每次 refresh 后调）：换了账号必须重拉（清单跟着账号走），
     同一账号则只在快照过期时拉；退出登录把卡收掉。 */
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
    return sync({ force: true });
  }

  function onChange(cb) {
    if (typeof cb !== "function") return function () {};
    LISTENERS.push(cb);
    return function () {
      var i = LISTENERS.indexOf(cb);
      if (i >= 0) LISTENERS.splice(i, 1);
    };
  }

  window.MtRelay = {
    PROVIDER_ID: PROVIDER_ID,
    SOURCE: SOURCE,
    KEY_PLACEHOLDER: KEY_PLACEHOLDER,
    FRESH_MS: FRESH_MS,
    isRelay: isRelay,
    provider: providerOf,
    meta: meta,
    isBlocked: isBlocked,
    sync: sync,
    syncIfStale: syncIfStale,
    onAuthState: onAuthState,
    onChange: onChange,
    tsText: tsText,
    money: money,
    /* 卡上那一行状态文案的取值口径（app-settings.js 与回归都读它） */
    stateText: function (prov) {
      var m = meta(prov);
      if (m.error) return T("刷新失败：") + m.error;
      if (m.blocked) return m.reason || T("余额不足，充值后刷新");
      return T("上次同步 ") + tsText(m.at);
    },
  };
})();

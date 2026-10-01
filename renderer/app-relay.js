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
 *   2. **凭据不落盘**：provider.apiKey 只落占位串（KEY_PLACEHOLDER），真 token 由主进程
 *      在请求时现取；渲染层从头到尾看不到 token，也不硬编码中转站地址。
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
  /* 配置里落的占位串：渲染层各处「有没有填 Key」的闸门因此照旧通过，
     真正下发的 Authorization 由主进程换成账号 token（main.js 的 providerAuthKey）。 */
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
  /* 凭据打码串（前 4 + **** + 后 4）：**主进程算好再交过来**，渲染层拿不到明文 token
     （见 main.js 的 maskSecret / relay:keyInfo）。没有凭据时退回占位串的打码，
     让用户至少看得见「这里用的是账号托管凭据」。 */
  function maskKey(raw) {
    var s = String(raw == null ? "" : raw);
    if (!s) return "";
    if (s.length <= 7) return new Array(s.length + 1).join("*");
    return s.slice(0, 4) + "****" + s.slice(-4);
  }
  /* keyMasked = 主进程算的打码串（有凭据时）；authKey = 账号凭据到没到；
     keyIssue = 没到时的原因（"" = 没登录 / "decrypt_failed" 等 = 凭据在手却解不开）。
     三者只用于「只读卡上那一行怎么显示」，不参与任何鉴权判断。 */
  function keyViewOf(p) {
    var m = meta(p);
    var auth = m.authKey === true;
    var masked = String(m.keyMasked || "") || maskKey(KEY_PLACEHOLDER);
    return { authKey: auth, maskedKey: masked, keyIssue: String(m.keyIssue || "") };
  }
  /* 主进程回的那一份（relayKeyInfo 的字段名是 maskedKey）→ 本模块内部口径。
     两处字段名不一样，这里只做一次映射，别在别处再手抄一遍（抄错就是空打码串）。 */
  function keyViewFromInfo(r) {
    return {
      authKey: r.signedIn === true,
      maskedKey: String(r.maskedKey || "") || maskKey(KEY_PLACEHOLDER),
      keyIssue: String(r.readIssue || ""),
    };
  }
  /* 最近一次取到的打码凭据（**还没落进卡时**的暂存）：第一次成功同步会新建整张卡，
     那一刻 applyDoc 拿不到旧值；不留这份暂存，卡建出来的当次会显示成占位串打码，
     要等下一次同步才补上。取不到（模块缺席 / 主进程老版本）就留空，退回占位串打码。 */
  var cachedKeyView = null;
  /* 打码凭据只用于界面显示：把它从卡上抹掉（换账号 / 退出登录时调，下一次同步会重新取） */
  function resetKeyView() {
    cachedKeyView = null;
    var p = providerOf();
    if (!p || !p.relay) return;
    p.relay = Object.assign({}, p.relay, {
      authKey: false,
      keyMasked: maskKey(KEY_PLACEHOLDER),
      keyIssue: "",
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
        /* 落进快照给界面显示：卡上那份用落盘口径的字段名（keyMasked），
           随下一次 configSave 一起写盘；这里不额外写盘。 */
        if (p) {
          p.relay = Object.assign({}, meta(p), {
            authKey: key.authKey,
            keyMasked: key.maskedKey,
            keyIssue: key.keyIssue,
          });
        }
        return key;
      },
      function () {
        return null;
      },
    );
  }
  /* 卡上那行 API Key 的取值，优先级：**本次刚取到的** > 卡上那份旧快照 > 占位串打码。
     为什么「刚取到的」排第一：applyDoc 重建整张卡时，本次 syncKeyInfo 的结果可能只落在
     旧 provider 引用上（旧引用随后被整张新卡替换掉），照旧值走会把新取到的打码串丢掉。
     **返回值一律是三个字段齐全的对象**，且 maskedKey 一定是非空串 ——
     别让「取不到」变成 undefined：那会在 JSON 化时整条字段消失，界面上就成了空白。 */
  function keyViewFor(prov) {
    var v = cachedKeyView || (prov ? keyViewOf(prov) : null);
    var masked = String((v && v.maskedKey) || "");
    return {
      authKey: !!(v && v.authKey),
      maskedKey: masked || maskKey(KEY_PLACEHOLDER),
      keyIssue: String((v && v.keyIssue) || ""),
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

  /* 把卡收掉（从没充过值 / 退出登录 / 换账号）。换账号时本地那份打码凭据属于上一个账号，
     一并丢掉（新卡由下一次 applyDoc + syncKeyInfo 重新取），免得把别人的 Key 尾巴
     留在新账号脸上。 */
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
    /* 卡上那行 API Key 的口径：主进程算的打码串（前 4 + **** + 后 4）——
       取值优先级与「取不到时退回占位串打码」都收在 keyViewFor 里（见上）。 */
    var keyView = keyViewFor(prov);
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
        /* 凭据只以**打码串**落在这里给界面显示（真 token 由主进程现取现用，从不落盘） */
        authKey: keyView.authKey,
        keyMasked: keyView.maskedKey,
        keyIssue: keyView.keyIssue,
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
     唯一例外是凭据打码串：它纯本地（account 凭据），有卡却没有时顺手补一次，
     让老快照的卡也能显示 Key（不打扰服务端，也不重写清单）。 */
  function syncIfStale() {
    var heal = healType();
    if (hasLocalSnapshot()) {
      var p = providerOf();
      if (p && !String(meta(p).keyMasked || "")) {
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

  window.MtRelay = {
    PROVIDER_ID: PROVIDER_ID,
    SOURCE: SOURCE,
    KEY_PLACEHOLDER: KEY_PLACEHOLDER,
    /* 打码口径（只读卡上「API Key」那一行显示用）：前 4 + **** + 后 4。
       导出是给 app-settings.js 兜底（还没有 keyMasked 时也显示得像一张凭据，
       而不是一片空白）；主进程用的同一口径见 main.js 的 maskSecret。 */
    maskKey: maskKey,
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

/* apphost.js — 宿主桥探测与优雅降级（**跟应用源码一起走，不是运行期依赖**）
 *
 * MTNode 里「应用」有两种窗口宿主，window 上暴露的名字不同：
 *   ① 应用中心窗口（apps-store.js + preload-app.js）→ window.appHost
 *        close / quit / onWillClose · dataDirGet / dataDirPick / dataDirOpen ·
 *        dataRead / dataWrite · storageGet / Set / All / Remove · account ·
 *        textGenStream / imageGen
 *   ② 插件窗口（plugins/preload-window.js）→ window.pluginApi（= window.forumApi）
 *        close · dataGet / dataSet · authGetState / authMe · storeRequest ·
 *        onShown / onAuthChanged · pickImage / compressImage / cacheImage …
 *
 * 本文件把两套都探测出来，统一成一套 window.AppHost：
 *   · 桥缺席（浏览器直接打开 index.html、旧版宿主、桥被裁剪）时**照样启动**，
 *     能力全 false，落盘退回内存态 —— 界面必须提示「不会保存」，绝不允许白屏或抛异常；
 *   · 只调用 `typeof host.x === "function"` 判过的能力，不发明接口。
 *
 * 统一后的字段：cap · host · hostName · id
 *   getData / setData        整份数据读写（读：优先 dataRead，退 dataGet；写：dataWrite，退 dataSet）
 *   dataGet / dataSet        老名字，等价上面两个（老应用不用改一行）
 *   dataDirGet / dataDirPick / dataDirOpen   数据文件夹（只有 ① 有；没有就 null / no_host）
 *   storageGet / storageSet / storageAll / storageRemove   键值存储
 *   accountText()            账号摘要一句话
 *   request(method, path, json)  服务端请求（只有 ② 有）
 *   on(event, cb) / offAll() 事件订阅与统一退订
 *   close() / quit()         关自己窗口 / 退出 MTNode
 */
(function () {
  "use strict";

  var appHost = window.appHost || null; /* ① 应用中心窗口 */
  var pluginApi = window.pluginApi || window.forumApi || null; /* ② 插件窗口 */
  var host = appHost || pluginApi || null;
  var hostName = appHost ? "appHost" : pluginApi ? "pluginApi" : "";

  function isFn(v) {
    return typeof v === "function";
  }
  function has(h, name) {
    return !!(h && isFn(h[name]));
  }

  /* 能力表：只认「真的是函数」的接口 —— 有对象不等于有方法 */
  var cap = {
    host: !!host,
    hostName: hostName,
    id: !!(host && host.id),
    close: has(host, "close"),
    quit: has(host, "quit"),
    /* 整份数据读写（两套桥都算数） */
    data: has(host, "dataRead") || has(host, "dataGet") || has(host, "dataWrite") || has(host, "dataSet"),
    /* 数据文件夹（只有应用中心窗口这一套有） */
    dataDir: has(host, "dataDirGet"),
    dataDirPick: has(host, "dataDirPick"),
    dataDirOpen: has(host, "dataDirOpen"),
    dataDirReset: has(host, "dataDirReset"),
    willClose: has(host, "onWillClose"),
    storage: has(host, "storageGet") && has(host, "storageSet"),
    account: has(host, "account") || has(host, "authGetState"),
    net: has(host, "storeRequest"),
    image: has(host, "imageGen") || has(host, "pickImage"),
    text: has(host, "textGenStream"),
    shown: has(host, "onShown"),
  };

  var subs = [];

  async function getData(opts) {
    if (!cap.data) return { ok: false, error: "no_host", data: null };
    try {
      var r = has(host, "dataRead") ? await host.dataRead(opts || {}) : await host.dataGet();
      if (r && r.ok !== false) {
        return {
          ok: true,
          data: r.data && typeof r.data === "object" ? r.data : {},
          migrated: !!r.migrated,
          file: r.file || "",
        };
      }
      return { ok: false, error: (r && r.error) || "read_failed", data: null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), data: null };
    }
  }

  async function setData(data, opts) {
    if (!cap.data) return { ok: false, error: "no_host" };
    var body = data && typeof data === "object" ? data : {};
    try {
      var r = has(host, "dataWrite") ? await host.dataWrite(body, opts || {}) : await host.dataSet(body);
      return {
        ok: !!(r && r.ok !== false),
        error: (r && r.error) || "",
        file: (r && r.file) || "",
        bytes: (r && r.bytes) || 0,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* 数据文件夹：应用窗口这套桥才有（默认 <数据目录>/apps-data/<id>/，用户可在窗口里改） */
  async function dataDirGet() {
    if (!cap.dataDir) return { ok: false, error: "no_host", dir: "" };
    try {
      return await host.dataDirGet();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), dir: "" };
    }
  }
  async function dataDirPick() {
    if (!cap.dataDirPick) return { ok: false, error: "no_host" };
    try {
      return await host.dataDirPick();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  async function dataDirOpen() {
    if (!cap.dataDirOpen) return { ok: false, error: "no_host" };
    try {
      return await host.dataDirOpen();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  /** 回到默认数据文件夹（只删「用户选过」的指针，原目录数据不动） */
  async function dataDirReset() {
    if (!cap.dataDirReset) return { ok: false, error: "no_host" };
    try {
      return await host.dataDirReset();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function storageGet(key) {
    if (!cap.storage) return { ok: false, error: "no_host" };
    try {
      return await host.storageGet(key);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  async function storageSet(key, value) {
    if (!cap.storage) return { ok: false, error: "no_host" };
    try {
      return await host.storageSet(key, value);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  async function storageAll() {
    if (!has(host, "storageAll")) return { ok: false, error: "no_host", kv: {} };
    try {
      return await host.storageAll();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), kv: {} };
    }
  }
  async function storageRemove(key) {
    if (!has(host, "storageRemove")) return { ok: false, error: "no_host" };
    try {
      return await host.storageRemove(key);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** 账号摘要；未登录 / 无宿主都回一句话，调用方不必再判 */
  async function accountText() {
    if (!cap.account) return "未接入宿主";
    try {
      if (has(host, "account")) {
        var r = await host.account();
        if (!r || !r.loggedIn) return "未登录";
        var u = r.user || {};
        return String(u.nickname || u.name || "已登录");
      }
      var st = await host.authGetState();
      if (!st || !st.loggedIn) return "未登录";
      if (has(host, "authMe")) {
        var me = await host.authMe();
        var u2 = (me && me.user) || {};
        if (u2.nickname || u2.name) return String(u2.nickname || u2.name);
      }
      return "已登录";
    } catch (e) {
      return "读取失败";
    }
  }

  /** 服务端请求（token 由主进程带，窗口不接触凭据）；只有插件窗口那套桥有 */
  async function request(method, path, json) {
    if (!cap.net) return { ok: false, error: "no_host" };
    try {
      return await host.storeRequest({ method: method || "GET", path: path, json: json });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** 事件订阅：统一登记，便于一次退订；桥没有这个事件就回 false（不假装成功） */
  function on(event, cb) {
    if (!host || !isFn(host[event])) return false;
    var off = host[event](cb);
    if (isFn(off)) subs.push(off);
    return true;
  }
  /** 桥没有 onShown 时退化成 visibilitychange：老桥也能拿到「窗口又被看见」这一件事 */
  function onShown(cb) {
    if (on("onShown", cb)) return true;
    var fn = function () {
      if (document.visibilityState === "visible") {
        try {
          cb();
        } catch (e) {}
      }
    };
    document.addEventListener("visibilitychange", fn);
    subs.push(function () {
      document.removeEventListener("visibilitychange", fn);
    });
    return true;
  }

  function offAll() {
    while (subs.length) {
      var off = subs.pop();
      try {
        off();
      } catch (e) {}
    }
  }

  function close() {
    if (cap.close) {
      try {
        return host.close();
      } catch (e) {}
    }
    return null;
  }
  function quit() {
    if (cap.quit) {
      try {
        return host.quit();
      } catch (e) {}
    }
    /* 老桥没有 quit：只能关自己的窗口（MTNode 本身由用户关） */
    return close();
  }
  /** 关窗收尾钩子：新桥直传，老桥交给 AppClose 自己兜底 */
  function onWillClose(cb) {
    if (cap.willClose) {
      try {
        var off = host.onWillClose(cb);
        if (isFn(off)) return off;
      } catch (e) {}
    }
    if (window.AppClose && isFn(window.AppClose.on)) return window.AppClose.on(cb);
    return function () {};
  }

  window.AppHost = {
    host: host,
    hostName: hostName,
    cap: cap,
    id: (host && host.id) || "",
    getData: getData,
    setData: setData,
    /* 老名字：老应用写的 AppHost.getData / setData / dataGet / dataSet 都照旧能跑 */
    dataGet: getData,
    dataSet: setData,
    dataDirGet: dataDirGet,
    dataDirPick: dataDirPick,
    dataDirOpen: dataDirOpen,
    dataDirReset: dataDirReset,
    storageGet: storageGet,
    storageSet: storageSet,
    storageAll: storageAll,
    storageRemove: storageRemove,
    accountText: accountText,
    request: request,
    on: on,
    onShown: onShown,
    offAll: offAll,
    onWillClose: onWillClose,
    close: close,
    quit: quit,
  };
})();
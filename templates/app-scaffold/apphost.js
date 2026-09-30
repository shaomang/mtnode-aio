/* apphost.js — 宿主桥探测与优雅降级（**跟应用源码一起走，不是运行期依赖**）
 *
 * MTNode 里「应用」有两种窗口宿主，window 上暴露的名字不同：
 *   ① 应用中心窗口（apps-store.js + preload-app.js）→ window.appHost
 *        close / quit / onWillClose · dataDirGet / dataDirPick / dataDirOpen ·
 *        dataRead / dataWrite · storageGet / Set / All / Remove · account ·
 *        textGenStream（支持文字 + 图像多模态）/ imageGen ·
 *        hostModels / hostSetModel / pickImage（模型从 MTNode 继承 + 选本机图）
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
 *
 * 模型能力（只有 ① 有，且模型从 MTNode 继承 —— 服务商与 API Key 永远留在主进程）：
 *   models()                 列出可用模型（首项 = 跟随默认；每项带 vision 是否支持识图）
 *   modelGet() / modelSet(id)  读 / 改本应用的模型选择（宿主按应用 id 持久化）
 *   pickImage()              弹系统选图框 → { ok, path }；取消 → { ok:false, code:"cancelled" }
 *   text(prompt, opts)       文本生成（流式；opts.images 可带本机路径 / dataURL → 多模态）
 *                            失败回 { ok:false, code }：bad_image / too_many_images / too_large /
 *                            no_provider / no_vision / bad_model / offline / http_4xx…
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
    /* 结构化输出助手（本文件 json()）：只要有文本桥就能用，不额外要求宿主新接口 */
    json: has(host, "textGenStream"),
    /* 模型继承：三件套齐了才算可用（只列清单不算 —— 不能改选择等于没有「位置」可选） */
    models: has(host, "hostModels") && has(host, "hostSetModel"),
    pick: has(host, "pickImage"),
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

  /* ── 模型（从 MTNode 继承；服务商与 Key 留在主进程，应用只挑 id） ──
     没有这套接口时：models() 回空清单 + hasAny:false，界面按「无可用模型」置灰提示，
     绝不假装成功、也不退回某个内置模型。 */
  async function models() {
    if (!cap.models) return { ok: false, error: "no_host", models: [], selected: "auto", hasAny: false, hasVision: false };
    try {
      return await host.hostModels();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), models: [], selected: "auto", hasAny: false, hasVision: false };
    }
  }
  async function modelGet() {
    if (!cap.models) return { ok: false, error: "no_host", selected: "auto", hasAny: false, hasVision: false };
    try {
      return await host.hostModel();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), selected: "auto", hasAny: false, hasVision: false };
    }
  }
  async function modelSet(id) {
    if (!cap.models) return { ok: false, error: "no_host" };
    try {
      return await host.hostSetModel(String(id == null ? "" : id));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  /** 选一张本机图：{ ok, path } / 取消 { ok:false, code:"cancelled" }；只回路径，读盘由宿主做 */
  async function pickImage() {
    if (!cap.pick) return { ok: false, code: "no_host", error: "no_host" };
    try {
      return await host.pickImage();
    } catch (e) {
      return { ok: false, code: "pick_failed", error: String((e && e.message) || e) };
    }
  }
  /** 文本生成（流式）。opts = { system, messages, model, images, temperature, thinking, maxTokens }
   *  images = 本机绝对路径或 data:image/... 的数组 → 与 prompt 一起下发（多模态，需视觉模型）。
   *  thinking = 思考档：**不传 = off**（宿主默认关思考），要开就显式给 on / low / high / max。
   *  maxTokens 能不给就不给：它是「思考 + 正文」共用的预算，给小了正文会被截断（返回里
   *  finishReason === "length" / truncated === true）。
   *  返回 { ok, text, reasoningChars, finishReason, truncated, code }；cb(delta) 可选，收流式增量。 */
  async function text(prompt, opts) {
    if (!cap.text) return { ok: false, code: "no_host", error: "宿主未提供文本生成能力" };
    var o = opts && typeof opts === "object" ? opts : {};
    var body = { prompt: String(prompt == null ? "" : prompt) };
    if (o.system) body.system = String(o.system);
    if (o.messages) body.messages = o.messages;
    if (o.model) body.model = String(o.model);
    if (o.temperature != null) body.temperature = o.temperature;
    if (o.maxTokens != null) body.maxTokens = o.maxTokens;
    /* 思考档原样交给宿主（宿主认 off / on / low / high / max，非法值回 code:"bad_thinking"）；
       不传就是关——别在这里补默认值，免得把宿主的默认口径抄第二遍 */
    if (o.thinking != null) body.thinking = String(o.thinking);
    /* 带图：把 images 拼成 messages 里的多模态分片（prompt 作为同一条 user 消息的文字部分） */
    var imgs = Array.isArray(o.images) ? o.images.filter(Boolean).slice(0, 8) : [];
    if (imgs.length) {
      var parts = [];
      if (body.prompt) parts.push({ type: "text", text: body.prompt });
      for (var i = 0; i < imgs.length; i++) parts.push({ type: "image_url", image_url: { url: imgs[i] } });
      var msgs = Array.isArray(body.messages) ? body.messages.slice() : [];
      if (body.system) msgs.unshift({ role: "system", content: String(body.system) });
      msgs.push({ role: "user", content: parts });
      body.messages = msgs;
      body.prompt = "";
      body.system = "";
    }
    var cb = typeof o.onDelta === "function" ? o.onDelta : null;
    try {
      return await host.textGenStream(body, function (msg) {
        if (!cb || !msg) return;
        if (msg.type === "delta" || msg.type === "reasoning") cb(msg.text, msg.type);
      });
    } catch (e) {
      return { ok: false, code: "transport", error: String((e && e.message) || e) };
    }
  }

  /* ── 结构化输出助手：要模型给 JSON 时**用它，别自己写 text() + JSON.parse()** ──────
   *
   * 为什么必须有：让模型「只回 JSON」是一件会失败的事，而失败有两种，症状却一样 ——
   *   ① 输出被上限截断（finishReason === "length"）：正文是半截的，JSON 必然解不出来；
   *      根因常见是「思考 token 把 max_tokens 吃光了」（宿主应用通道默认关思考就是为这个）；
   *   ② 模型就是带了点散文 / 围栏 / 前后缀。
   * 调用方只看 r.ok，就会把「被截断」误报成「模型不会给 JSON」，用户照着改提示词也没用。
   *
   * 用法（两种写法等价）：
   *   var r = await AppHost.json({ system: "You output strict JSON.", prompt: "…" });
   *   var r = await AppHost.json("…", { system: "You output strict JSON." });
   *   if (!r.ok) show(r.error); else use(r.data);
   * 它做三件事：① 思考档照传（不传 = 宿主默认关）；② 剥 ``` 围栏 + 截取首个 {/[ 到末个 }/] 再解析；
   * ③ 解析失败自动重试一次（opts.retries 可调，0 = 不重试）—— 上一次被截断时，重试**丢掉
   *   maxTokens**（截断的根因就是上限太小，带着重试只会再截一次）。
   *
   * 返回 { ok, data, text, code, error, attempts, finishReason, truncated, reasoningChars }
   *   code：truncated（两次都被截断）/ not_json（两次都解不出）/ 宿主错误码（no_provider / bad_model …）
   *   —— 宿主没配服务商这种错**不重试**，原样抛给调用方去提示用户。 */
  function jsonSlice(s) {
    var t = String(s == null ? "" : s).replace(/```[a-zA-Z0-9_-]*/g, "");
    var a = t.search(/[{[]/);
    if (a < 0) return "";
    var close = t.charAt(a) === "{" ? "}" : "]";
    var b = t.lastIndexOf(close);
    return b > a ? t.slice(a, b + 1) : "";
  }
  function jsonParseLoose(s) {
    var slice = jsonSlice(s);
    if (!slice) return { error: "not_json" };
    try {
      return { data: JSON.parse(slice) };
    } catch (e) {
      return { error: "not_json" };
    }
  }
  async function json(prompt, opts) {
    var o =
      typeof prompt === "string"
        ? Object.assign({}, opts && typeof opts === "object" ? opts : {}, { prompt: prompt })
        : prompt && typeof prompt === "object"
          ? prompt
          : {};
    if (!cap.text) return { ok: false, code: "no_host", error: "宿主未提供文本生成能力", attempts: 0 };
    var retries = Number(o.retries) >= 0 ? Math.min(3, Math.round(Number(o.retries))) : 1;
    var use = {
      system: o.system,
      messages: o.messages,
      model: o.model,
      images: o.images,
      temperature: o.temperature,
      thinking: o.thinking,
      maxTokens: o.maxTokens,
      onDelta: o.onDelta,
    };
    var last = {
      ok: false,
      code: "not_json",
      error: "模型回复里没有可用的 JSON",
      text: "",
      finishReason: "",
      truncated: false,
      reasoningChars: 0,
      attempts: 0,
    };
    for (var i = 0; i <= retries; i++) {
      /* 上一次是被截断的 → 这一次别带上限（上限就是截断的根因） */
      if (i > 0 && last.truncated) delete use.maxTokens;
      var r = await text(o.prompt == null ? "" : o.prompt, use);
      last.attempts = i + 1;
      if (!r || r.ok === false) {
        /* 配置类错误（无服务商 / 模型不在清单 / 非法思考档）重试也没用：原样回报 */
        return {
          ok: false,
          code: (r && r.code) || "text_failed",
          error: (r && r.error) || "text_failed",
          text: String((r && r.text) || ""),
          finishReason: "",
          truncated: false,
          reasoningChars: 0,
          attempts: i + 1,
        };
      }
      var p = jsonParseLoose(r.text);
      if (!p.error)
        return {
          ok: true,
          data: p.data,
          text: String(r.text || ""),
          code: "",
          error: "",
          finishReason: String(r.finishReason || ""),
          truncated: !!r.truncated,
          reasoningChars: Number(r.reasoningChars) || 0,
          attempts: i + 1,
        };
      last = {
        ok: false,
        code: r.truncated ? "truncated" : "not_json",
        error: r.truncated
          ? "模型回复被输出上限截断，JSON 不完整（别把 maxTokens 设小，或让应用显式开思考时留足预算）"
          : "模型回复里没有可用的 JSON",
        text: String(r.text || ""),
        finishReason: String(r.finishReason || ""),
        truncated: !!r.truncated,
        reasoningChars: Number(r.reasoningChars) || 0,
        attempts: i + 1,
      };
    }
    return last;
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
    /* 模型继承 + 多模态（应用中心窗口那一套；插件窗口没有时 cap 全 false，调用方按能力降级） */
    models: models,
    modelGet: modelGet,
    modelSet: modelSet,
    pickImage: pickImage,
    text: text,
    /* 要模型给 JSON 就用这个：关思考 + 剥围栏 + 截断感知 + 重试一次（见 json() 头部注释） */
    json: json,
    on: on,
    onShown: onShown,
    offAll: offAll,
    onWillClose: onWillClose,
    close: close,
    quit: quit,
  };
})();
/* app-model.js — 模型选择位 + 图像多模态调用（脚手架第五件，跟应用源码一起走）
 *
 * 为什么必须有这个「位置」：应用的模型能力是从 MTNode 继承的（服务商与 API Key 永远留在主进程），
 * 所以应用渲染页里要有一个让用户看得见、点得到的地方来挑模型 —— 就是本文件挂到顶栏的那个按钮。
 *   · 列清单走 AppHost.models()（首项 = 跟随 MTNode 默认，每项带 vision 是否支持识图）；
 *   · 改动走 AppHost.modelSet(id)，宿主按应用 id 持久化，关窗重启还记得；
 *   · 桥没有这套接口 / MTNode 里一个模型都没配 → 按钮置灰并在菜单里写清原因 + 去哪里配，
 *     **不做任何降级**（不偷偷换模型、不静默丢图）。
 *
 * 调用模型时用 AppHost.text(prompt, { images: [...] })：
 *   images 里放「本机绝对路径」（AppHost.pickImage() 选来的，或应用自己知道的图）或 dataURL；
 *   宿主读盘 / 解码 / 缩放到长边 ≤1080 后与文字一起发给模型（上限：一条消息 8 张、合计 10MB）。
 *   失败一律回结构化错误码（no_provider / no_vision / bad_image / too_large / offline / http_401…），
 *   errorText() 给中文一句话，humanText() 给当前界面语言的一句话。
 *
 * 接法（两行）：
 *   const M = window.AppModel.create({ host: window.AppHost, btn: $("modelBtn"), menu: $("modelMenu") });
 *   await M.init();
 * 之后 M.selected() 就是当前选择（"auto" = 跟随 MTNode 默认），M.model() 是每次请求要带的 model 参数。
 */
(function () {
  "use strict";

  var ZH = {
    model: "模型",
    models: "模型",
    loading: "正在读取 MTNode 的模型清单…",
    noHost: "本版本宿主没有模型选择接口：请在 MTNode 里更新到最新版。",
    noModels: "MTNode 里还没有可用的文本模型：请在 MTNode「设置 · 模型服务」里填好服务商与 API Key。",
    noVision: "MTNode 里还没有支持识图的模型：请在「设置 · 模型服务」里配置支持图像的服务商（如 DeepSeek 官方）。",
    auto: "跟随 MTNode 默认",
    vision: "支持识图",
    current: "当前",
    modelPick: "选择模型",
    unnamed: "（未命名）",
  };
  var EN = {
    model: "Model",
    models: "Model",
    loading: "Reading the model list from MTNode…",
    noHost: "This host build has no model-selection bridge: please update MTNode.",
    noModels: "No text model is configured in MTNode yet: add a provider and API key under Settings · Model services.",
    noVision: "No vision-capable model in MTNode yet: configure a provider that accepts images (e.g. DeepSeek Official).",
    auto: "Follow MTNode default",
    vision: "Reads images",
    current: "current",
    modelPick: "Choose a model",
    unnamed: "(unnamed)",
  };
  /* 结构化错误码 → 一句话（中英各一份；未知码原样显示，方便开发者定位） */
  var ERR = {
    bad_image: { zh: "图像读不出或格式不支持（支持 png / jpg / webp / gif）", en: "Image unreadable or unsupported (png / jpg / webp / gif)" },
    too_many_images: { zh: "一条消息里的图片太多（上限 8 张）", en: "Too many images in one message (max 8)" },
    too_large: { zh: "图片总大小超出上限（10MB）", en: "Images exceed the 10MB total limit" },
    no_provider: { zh: "MTNode 里没有可用的文本服务商：请在「设置 · 模型服务」里填好 API Key", en: "No usable text provider in MTNode: fill in an API key under Settings · Model services" },
    no_vision: { zh: "当前模型不支持识图：请换一个带「支持识图」的模型", en: "The current model reads no images: pick one marked “Reads images”" },
    bad_model: { zh: "这个模型不在 MTNode 已配置的清单里：请在「模型」里重新选", en: "That model is not in MTNode's configured list: choose again under Model" },
    offline: { zh: "连不上模型服务（网络不可用或地址不通），请检查网络后重试", en: "Cannot reach the model service (offline or unreachable): check the network and retry" },
    cancelled: { zh: "已取消选择", en: "Selection cancelled" },
    not_app: { zh: "调用方不是应用窗口", en: "Caller is not an app window" },
    no_host: { zh: "宿主未接入：模型能力不可用", en: "No host: model capability unavailable" },
    pick_failed: { zh: "打开系统选图框失败", en: "Could not open the system file picker" },
    transport: { zh: "与宿主通信失败", en: "Communication with the host failed" },
  };
  function isZh() {
    return /^zh/i.test(document.documentElement.lang || navigator.language || "");
  }
  function L(k) {
    var d = isZh() ? ZH : EN;
    return d[k] || (ZH[k] || k);
  }
  /** 错误码 → 当前界面语言的一句话（未登记的码原样显示） */
  function humanText(code, fallback) {
    var e = ERR[String(code || "")];
    if (e) return isZh() ? e.zh : e.en;
    return String(fallback || code || "");
  }
  function withHttp(code) {
    var m = /^http_(\d{3})$/.exec(String(code || ""));
    if (!m) return "";
    return isZh()
      ? "模型服务返回 HTTP " + m[1] + "（鉴权 / 限流 / 余额等问题，请在 MTNode 设置里检查服务商）"
      : "Model service returned HTTP " + m[1] + " (auth / rate limit / balance — check the provider in MTNode settings)";
  }
  /** 任何 { ok:false, code } 都能过这一手：返回适合直接弹给用户的一句话 */
  function errorText(res) {
    var r = res && typeof res === "object" ? res : { error: String(res || "") };
    return withHttp(r.code) || humanText(r.code, r.error);
  }

  function findBtn(sel) {
    if (!sel) return null;
    if (typeof sel === "string") return document.querySelector(sel);
    return sel;
  }

  /** 建一个模型选择位：btn（顶栏那个按钮）+ menu（它下面的下拉）。
   *  opts: { host, btn, menu, backdrop, onChange } */
  function create(opts) {
    var o = opts && typeof opts === "object" ? opts : {};
    var H = o.host || window.AppHost || null;
    var btn = findBtn(o.btn);
    var menu = findBtn(o.menu);
    var backdrop = findBtn(o.backdrop);
    var state = { models: [], selected: "auto", hasAny: false, hasVision: false, ready: false };
    var listeners = [];
    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](state.selected);
        } catch (e) {}
      }
    }
    function closeMenu() {
      if (menu) menu.hidden = true;
      if (backdrop) backdrop.hidden = true;
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
    function openMenu() {
      if (backdrop) backdrop.hidden = false;
      if (menu) menu.hidden = false;
      if (btn) btn.setAttribute("aria-expanded", "true");
    }

    function shortLabel() {
      if (!state.ready) return L("model");
      if (!state.hasAny) return L("model");
      if (state.selected === "auto") return L("auto");
      var hit = null;
      for (var i = 0; i < state.models.length; i++) if (state.models[i].id === state.selected) hit = state.models[i];
      return hit ? hit.label || hit.id : L("model");
    }
    function paintBtn() {
      if (!btn) return;
      var label = shortLabel();
      /* 按钮文案由本文件接管（原来的 [data-lang] 双语 span 被替换掉，语言切换后靠 render() 重画） */
      btn.textContent = label;
      btn.title = (state.ready && state.hasAny ? L("modelPick") : L("model")) + "：" + label;
      btn.disabled = state.ready && !state.hasAny;
      btn.setAttribute("aria-label", btn.title);
    }
    function hintLine(text) {
      var d = document.createElement("div");
      d.className = "model-note";
      d.textContent = text;
      return d;
    }
    function render() {
      paintBtn();
      if (!menu) return;
      menu.textContent = "";
      if (!state.ready) {
        menu.appendChild(hintLine(L("loading")));
        return;
      }
      if (!state.host) {
        menu.appendChild(hintLine(L("noHost")));
        return;
      }
      if (!state.hasAny) {
        menu.appendChild(hintLine(L("noModels")));
        return;
      }
      for (var i = 0; i < state.models.length; i++) {
        (function (m) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "model-item" + (m.id === state.selected ? " is-on" : "");
          b.setAttribute("role", "menuitemradio");
          b.setAttribute("aria-checked", m.id === state.selected ? "true" : "false");
          b.dataset.model = m.id;
          var name = document.createElement("span");
          name.className = "model-name";
          name.textContent = m.id === "auto" ? L("auto") : m.label || m.id || L("unnamed");
          b.appendChild(name);
          if (m.providerName) {
            var pv = document.createElement("span");
            pv.className = "model-prov";
            pv.textContent = m.providerName;
            b.appendChild(pv);
          }
          if (m.vision) {
            var v = document.createElement("span");
            v.className = "model-tag";
            v.textContent = L("vision");
            b.appendChild(v);
          }
          b.addEventListener("click", function () {
            setModel(m.id);
          });
          menu.appendChild(b);
        })(state.models[i]);
      }
      if (!state.hasVision) menu.appendChild(hintLine(L("noVision")));
    }

    function onChange(cb) {
      if (typeof cb === "function") listeners.push(cb);
    }
    async function refresh() {
      /* 选择由宿主持久化：先问一次当前选择（hostModel），再拉清单（hostModels）。
         两者缺一个就按「桥没这套能力」处理，不猜。 */
      var sel = H && H.modelGet ? await H.modelGet() : { ok: false, error: "no_host" };
      var r = H && H.models ? await H.models() : { ok: false, error: "no_host" };
      state.host = !!(r && r.ok !== false);
      state.models = (r && r.models) || [];
      state.selected = (sel && sel.ok !== false && sel.selected) || (r && r.selected) || "auto";
      state.hasAny = !!(r && r.hasAny);
      state.hasVision = !!(r && r.hasVision);
      state.ready = true;
      render();
      return r;
    }
    async function setModel(id) {
      var r = H && H.modelSet ? await H.modelSet(id) : { ok: false, error: "no_host" };
      if (r && r.ok === false) {
        state.err = errorText(r);
        render();
        if (menu) menu.appendChild(hintLine(state.err));
        return r;
      }
      state.selected = (r && r.selected) || id;
      state.err = "";
      render();
      closeMenu();
      emit();
      return r;
    }
    function bind() {
      if (btn && menu) {
        btn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (menu.hidden) {
            refresh().then(function () {
              openMenu();
            });
          } else closeMenu();
        });
        /* 点空白关菜单只许走那块透明蒙层（蒙层在菜单下面、按钮下面），
           不给 document 挂点外部即关 —— 与 MTNode 的「对话框一律 persistent」同口径，
           免得用户点一下别处就把列表点没了。Esc 同样只关列表。 */
        if (backdrop) backdrop.addEventListener("click", closeMenu);
        document.addEventListener("keydown", function (ev) {
          if (ev.key === "Escape") closeMenu();
        });
      }
      /* 语言切换（<html lang> 由应用自己改）后重画文案 —— 见 app.js 的 paintLang */
    }

    return {
      init: async function () {
        bind();
        render();
        var r = await refresh();
        return r;
      },
      refresh: refresh,
      render: render,
      selected: function () {
        return state.selected;
      },
      /** 请求时带的 model 参数：auto 时给空串（= 跟随 MTNode 默认） */
      model: function () {
        return state.selected === "auto" ? "" : state.selected;
      },
      stats: function () {
        return {
          models: state.models.slice(),
          selected: state.selected,
          hasAny: state.hasAny,
          hasVision: state.hasVision,
        };
      },
      onChange: onChange,
      close: closeMenu,
      errorText: errorText,
      humanText: humanText,
    };
  }

  window.AppModel = { create: create, errorText: errorText, humanText: humanText };
})();
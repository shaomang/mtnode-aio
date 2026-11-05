"use strict";
/* ============================================================
 * DeepSeek 官方 API Key · 首次使用引导
 * ------------------------------------------------------------
 * 口径（本轮需求）：
 *   ① 默认提供商 = 官方 DeepSeek（配置里 id "deepseek"，baseUrl https://api.deepseek.com），
 *      默认模型 = deepseek-flash（第一只）+ deepseek-v4-pro（第二只，同为官方清单里的可选项）；
 *   ② 官方 DeepSeek 供应商**不允许删除**（模型仍可手动增删 / 排序，方便以后官方上新模型）；
 *   ③ 用户一旦要用任何模型能力（会话、节点、识图、预览、团队……），而官方 DeepSeek 的
 *      API Key 还没配置 → 弹这张引导窗：图文海报教怎么注册 / 充值 / 拿 Key，并预留 Key
 *      输入框；**验证成功后才写入供应商配置**（验证走主进程 GET /models，零 Token 消耗）；
 *   ④ 已经改用别家服务商（mtnode_xxx 且有 Key）的用户不被这条闸拦住 —— 闸只拦「这一轮
 *      实际要跑的路由就是 DeepSeek 官方 / 还没选过路由（默认官方）」。
 *
 * 三个入口保证「任何模型能力」都挡得住：
 *   · renderer 侧共享漏斗：apiCallTextStream（app-nodes.js）与 runOnce / runOnceAgg 的出图调用；
 *   · 智能会话：dshRunTask（app-db.js）开跑前；
 *   · 主进程兜底：main.js 的 checkProvider 发现「官方 DeepSeek 没 Key」时广播 ds:needKey，
 *     本模块订阅后弹同一张窗（覆盖 app-qa / 识图 / 其它直接调 apiCall 的地方）。
 * ============================================================ */
(function () {
  const DS_BASE_URL = "https://api.deepseek.com";
  const DS_PLATFORM_URL = "https://platform.deepseek.com/";
  const DS_KEYS_URL = "https://platform.deepseek.com/api_keys";
  const DS_DEFAULT_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

  function dsT(key) {
    try {
      return I18n.t(key);
    } catch (_) {
      return key;
    }
  }

  /* 配置里的官方 DeepSeek 供应商：id 优先（默认播种 / 用户手建都用这个 id），
     退一步按官方域名认（用户把 id 改了也还认得出是官方端点）。 */
  function dsOfficialProvider() {
    const list =
      S && S.config && Array.isArray(S.config.providers) ? S.config.providers : [];
    const byId = list.find((p) => p && String(p.id || "") === "deepseek");
    if (byId) return byId;
    return (
      list.find((p) => {
        if (!p || typeof p !== "object") return false;
        const t = String(p.type || "");
        if (t && t !== "text_openai") return false;
        try {
          return new URL(String(p.baseUrl || "")).hostname
            .toLowerCase()
            .includes("deepseek");
        } catch (_) {
          return false;
        }
      }) || null
    );
  }

  /* 这个服务商条目是不是「官方 DeepSeek」（设置页据此禁掉删除） */
  function dsIsOfficialProvider(prov) {
    if (!prov || typeof prov !== "object") return false;
    if (String(prov.id || "") === "deepseek") return true;
    try {
      return new URL(String(prov.baseUrl || "")).hostname
        .toLowerCase()
        .includes("deepseek");
    } catch (_) {
      return false;
    }
  }

  function dsKeyOf(prov) {
    return String((prov && prov.apiKey) || "").trim();
  }

  /* 官方通道是否已经可用（有 Key 且指向官方端点） */
  function dsKeyReady() {
    const p = dsOfficialProvider();
    return !!(p && dsKeyOf(p));
  }

  /* 把官方供应商补齐到配置里（用户把整份列表清空 / 老配置里丢了 id 时用）。
     模型清单一律以用户现有那份为准：只在**空清单**时补默认的 flash + pro。 */
  function dsEnsureProvider() {
    if (!S || !S.config) return null;
    if (!Array.isArray(S.config.providers)) S.config.providers = [];
    let p = dsOfficialProvider();
    if (!p) {
      p = {
        id: "deepseek",
        name: "DeepSeek",
        type: "text_openai",
        baseUrl: DS_BASE_URL,
        apiKey: "",
        models: DS_DEFAULT_MODELS.slice(),
      };
      S.config.providers.unshift(p);
    }
    if (!String(p.baseUrl || "").trim()) p.baseUrl = DS_BASE_URL;
    if (!Array.isArray(p.models) || !p.models.length)
      p.models = DS_DEFAULT_MODELS.slice();
    /* 「不允许删除」的持久侧：删除清单里不能留 deepseek（否则重启后它会被当成
       用户主动删掉的默认项，永远不再播种） */
    if (Array.isArray(S.config.removedProviders)) {
      const next = S.config.removedProviders.filter(
        (id) => String(id || "") !== "deepseek",
      );
      if (next.length !== S.config.removedProviders.length)
        S.config.removedProviders = next;
    }
    return p;
  }

  /* 这条路由是不是「DeepSeek 官方」：空路由 = 还没选过 = 默认官方 */
  function dsRouteIsOfficial(route) {
    const r = String(route || "").trim();
    return !r || r === "deepseek-official" || r === "deepseek";
  }

  /* ── 闸门：调用方在真正发起模型请求之前问一句 ────────────────────────────────
     参数可以是路由字符串（"deepseek-official" / "mtnode_xxx" / ""）或服务商对象。
     返回 true = 放行；false = 已弹引导窗，调用方应中止本次请求。
     · 路由是别家（mtnode_xxx）→ 放行（那是另一家的 Key，主进程 checkProvider 会照常校验）；
     · 路由是官方 / 未选 → 官方有 Key 就放行；没有就弹窗。 */
  function dsEnsureModelReady(target) {
    let official = true;
    if (target && typeof target === "object") {
      official = dsIsOfficialProvider(target);
    } else if (target != null && String(target).trim() !== "") {
      official = dsRouteIsOfficial(target);
    }
    if (!official) return true;
    if (dsKeyReady()) return true;
    try {
      dsOpenOnboard();
    } catch (_) {}
    return false;
  }

  function dsMissingKeyError() {
    return new Error(
      dsT("还没有配置 DeepSeek 官方 API Key：请在引导窗里填入并验证后再运行"),
    );
  }

  function dsOpenUrl(url) {
    const u = String(url || "");
    if (!u) return;
    try {
      if (window.api && typeof window.api.openExternal === "function") {
        window.api.openExternal(u);
        return;
      }
    } catch (_) {}
    try {
      window.open(u, "_blank");
    } catch (_) {}
  }

  /* ── 引导窗（persistent：点蒙层不关，关闭只走窗内按钮 / ✕ / Esc）────────────── */
  let dsDlgEl = null;
  let dsEscHandler = null;

  function dsEnsureDlg() {
    if (dsDlgEl && document.body.contains(dsDlgEl)) return dsDlgEl;
    const host = document.createElement("div");
    host.id = "dsKeyDlg";
    host.className = "mt-dialog ds-key-dlg";
    host.tabIndex = -1;
    host.innerHTML =
      '<div class="mt-dialog-box ds-key-box" role="dialog" aria-modal="true" aria-labelledby="dsKeyDlgTitle">' +
      '<div class="mt-dialog-head ds-key-head">' +
      '<b id="dsKeyDlgTitle"></b>' +
      '<span class="ds-key-head-note" id="dsKeyHeadNote"></span>' +
      '<button type="button" class="ds-key-x" id="dsKeyClose" aria-label="close">✕</button>' +
      "</div>" +
      '<div class="mt-dialog-body ds-key-body">' +
      '<p class="ds-key-lead" id="dsKeyLead"></p>' +
      '<div class="ds-key-poster-wrap" id="dsKeyPosterWrap">' +
      '<img class="ds-key-poster" id="dsKeyPoster" src="deepseek-guide.svg" alt="" />' +
      "</div>" +
      '<div class="ds-key-links">' +
      '<button type="button" class="mini primary" id="dsKeyOpenPlatform"></button>' +
      '<button type="button" class="mini" id="dsKeyOpenKeys"></button>' +
      "</div>" +
      '<div class="ds-key-form">' +
      '<label class="ds-key-label" for="dsKeyInput" id="dsKeyInputLabel"></label>' +
      '<div class="ds-key-form-row">' +
      '<input type="text" id="dsKeyInput" class="mt-dialog-input ds-key-input" autocomplete="off" spellcheck="false" />' +
      '<button type="button" class="mini primary" id="dsKeySave"></button>' +
      "</div>" +
      '<div class="ds-key-status" id="dsKeyStatus" role="status" aria-live="polite"></div>' +
      "</div>" +
      '<div class="ds-key-note" id="dsKeyNote"></div>' +
      "</div>" +
      '<div class="mt-dialog-foot"><button type="button" class="mini" id="dsKeyLater"></button></div>' +
      "</div>";
    document.body.appendChild(host);
    dsDlgEl = host;

    const $id = (id) => host.querySelector("#" + id);
    $id("dsKeyDlgTitle").textContent = dsT("DeepSeek 官方 API Key");
    $id("dsKeyHeadNote").textContent = dsT("首次使用引导");
    $id("dsKeyLead").textContent = dsT(
      "使用模型能力前，需要先配置 DeepSeek 官方 API Key。按下面这张海报 5 步就能拿到：",
    );
    $id("dsKeyPoster").alt = dsT(
      "海报：如何获取 DeepSeek API Key（注册 / 充值 / 创建 Key / 填进 MTNode）",
    );
    $id("dsKeyOpenPlatform").textContent = dsT(
      "打开 DeepSeek 开放平台（注册 / 充值）↗",
    );
    $id("dsKeyOpenKeys").textContent = dsT("API Keys 页面 ↗");
    $id("dsKeyInputLabel").textContent = dsT("API Key（粘贴后自动验证，也可点按钮重试）");
    $id("dsKeyInput").placeholder = "sk-…";
    $id("dsKeySave").textContent = dsT("验证并保存");
    $id("dsKeyNote").textContent = dsT(
      "只在验证通过后写入「设置 · 模型服务」里的 DeepSeek 供应商；验证请求只读取模型列表，不消耗 Token。",
    );
    $id("dsKeyLater").textContent = dsT("稍后配置");

    $id("dsKeyClose").onclick = dsCloseOnboard;
    $id("dsKeyLater").onclick = dsCloseOnboard;
    $id("dsKeyOpenPlatform").onclick = (ev) => {
      ev.preventDefault();
      dsOpenUrl(DS_PLATFORM_URL);
    };
    $id("dsKeyOpenKeys").onclick = (ev) => {
      ev.preventDefault();
      dsOpenUrl(DS_KEYS_URL);
    };
    $id("dsKeyPosterWrap").onclick = (ev) => {
      ev.preventDefault();
      host.classList.toggle("zoom");
    };
    $id("dsKeySave").onclick = (ev) => {
      ev.preventDefault();
      dsSubmitKey();
    };
    $id("dsKeyInput").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        dsSubmitKey();
      }
    });
    /* 「填入后自动验证」：粘贴一落进输入框就自己校验一次（不必再点按钮）。
       校验失败只在窗内报错、不写盘；成功后由 dsSubmitKey 自己完成写入与关窗。 */
    $id("dsKeyInput").addEventListener("paste", () => {
      setTimeout(() => {
        const v = String(($id("dsKeyInput") || {}).value || "").trim();
        if (v.length < 12) return;
        const p = dsOfficialProvider();
        if (p && dsKeyOf(p) === v) return; /* 同一条已存过，不重复校验 */
        dsSubmitKey();
      }, 120);
    });
    dsDlgEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        dsCloseOnboard();
      }
    });
    return host;
  }

  function dsSetStatus(text, kind) {
    const el = dsDlgEl && dsDlgEl.querySelector("#dsKeyStatus");
    if (!el) return;
    el.textContent = String(text || "");
    el.className = "ds-key-status" + (kind ? " is-" + kind : "");
  }

  function dsOpenOnboard() {
    const host = dsEnsureDlg();
    const p = dsEnsureProvider();
    const input = host.querySelector("#dsKeyInput");
    if (input && p && dsKeyOf(p)) input.value = dsKeyOf(p);
    dsSetStatus("", "");
    host.classList.remove("zoom");
    host.classList.add("on");
    if (!dsEscHandler) {
      dsEscHandler = (ev) => {
        if (ev.key !== "Escape") return;
        if (!host.classList.contains("on")) return;
        ev.preventDefault();
        dsCloseOnboard();
      };
      document.addEventListener("keydown", dsEscHandler, true);
    }
    setTimeout(() => {
      try {
        if (input) input.focus();
      } catch (_) {}
    }, 30);
    return host;
  }

  function dsCloseOnboard() {
    if (!dsDlgEl) return;
    dsDlgEl.classList.remove("on", "zoom");
    if (dsEscHandler) {
      try {
        document.removeEventListener("keydown", dsEscHandler, true);
      } catch (_) {}
      dsEscHandler = null;
    }
  }

  /* 验证 → 通过才写入供应商配置。失败只在窗内报错，绝不落盘半截 Key。 */
  function dsSubmitKey() {
    if (!dsDlgEl) return;
    const input = dsDlgEl.querySelector("#dsKeyInput");
    const btn = dsDlgEl.querySelector("#dsKeySave");
    const key = String((input && input.value) || "").trim();
    if (!key) {
      dsSetStatus(dsT("请先粘贴 API Key"), "err");
      if (input) input.focus();
      return;
    }
    if (!window.api || typeof window.api.apiValidateKey !== "function") {
      dsSetStatus(dsT("当前版本不支持在线验证，请到「设置 · 模型服务」手动填写"), "err");
      return;
    }
    const label = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = dsT("验证中…");
    }
    dsSetStatus(dsT("正在向 DeepSeek 官方校验这个 Key（不消耗 Token）…"), "busy");
    Promise.resolve(
      window.api.apiValidateKey({
        type: "text_openai",
        baseUrl: DS_BASE_URL,
        apiKey: key,
      }),
    )
      .then((r) => {
        if (!r || !r.ok) {
          const detail = r && r.error ? String(r.error) : "";
          dsSetStatus(
            dsT("验证失败，Key 未保存") + (detail ? "：" + detail : ""),
            "err",
          );
          return false;
        }
        const prov = dsEnsureProvider();
        if (!prov) {
          dsSetStatus(dsT("验证通过，但配置里找不到 DeepSeek 供应商"), "err");
          return false;
        }
        prov.apiKey = key;
        dsSetStatus(dsT("验证通过，已写入 DeepSeek 供应商"), "ok");
        try {
          if (typeof settingsSaveNow === "function")
            Promise.resolve(settingsSaveNow()).catch(() => {});
          else if (window.api && typeof window.api.configSave === "function")
            Promise.resolve(window.api.configSave(S.config)).catch(() => {});
        } catch (_) {}
        try {
          if (typeof repaintSettingsProvTiles === "function")
            repaintSettingsProvTiles();
          /* 设置页顶部那条「官方充值通道」横幅：Key 一有就收起（同源判据） */
          if (typeof repaintSettingsTopup === "function") repaintSettingsTopup();
        } catch (_) {}
        try {
          if (typeof toast === "function")
            toast(dsT("DeepSeek API Key 已验证并保存"), "ok");
        } catch (_) {}
        setTimeout(dsCloseOnboard, 420);
        return true;
      })
      .catch((err) => {
        dsSetStatus(
          dsT("验证失败，Key 未保存") +
            "：" +
            ((err && err.message) || String(err)),
          "err",
        );
      })
      .then(() => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = label || dsT("验证并保存");
        }
      });
  }

  /* 主进程广播（checkProvider 撞到「官方 DeepSeek 没 Key」时）：弹同一张窗。
     推送里只带 reason，不带任何 Key 内容。 */
  function dsBindMainNotice() {
    try {
      if (!window.api || typeof window.api.onDsNeedKey !== "function") return;
      window.api.onDsNeedKey(() => {
        if (dsKeyReady()) return;
        dsOpenOnboard();
      });
    } catch (_) {}
  }

  /* 全局导出（渲染层其它模块直接用函数名调用；本文件按 index.html 顺序加载） */
  window.dsOfficialProvider = dsOfficialProvider;
  window.dsIsOfficialProvider = dsIsOfficialProvider;
  window.dsKeyReady = dsKeyReady;
  window.dsEnsureProvider = dsEnsureProvider;
  window.dsEnsureModelReady = dsEnsureModelReady;
  window.dsMissingKeyError = dsMissingKeyError;
  window.dsOpenOnboard = dsOpenOnboard;
  window.dsCloseOnboard = dsCloseOnboard;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", dsBindMainNotice);
  } else {
    dsBindMainNotice();
  }
})();

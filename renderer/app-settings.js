"use strict";
/* ============ 设置（APIs/Config） ============ */

/* ── 设置页写剪贴板：薄封装，实现已收敛到全渲染层唯一出口 ───────────────────
   历史：这条三级链路（① navigator.clipboard.writeText → ② preload 桥
   window.api.clipboardWriteText → ③ execCommand 兜底）当初就写在这里，为修「设置页
   API Key 复制失败」—— 根因是主窗权限闸（main.js 的 setPermissionRequestHandler /
   setPermissionCheckHandler）把 clipboard-write 一律拒，裸调原生 API 的地方只拿到一个
   NotAllowedError（详见 renderer/app-clipboard.js 文件头）。
   同一类 bug 后来又在画布节点 OUTPUT 面板的「复制」上复现，于是实现整体搬去
   renderer/app-clipboard.js（appClipboardWrite），这里只留同名薄封装：老调用点
   （设置页两处复制按钮 + 别处引用 settingsClipboardWrite 的地方）一个字都不用改。
   契约不变：返回 Promise<{ ok, via, error }>。 */
function settingsClipboardWrite(text) {
  return appClipboardWrite(text);
}

/* 「打开设置并直接滚到某一节」的请求位（顶栏红色警示点进来时落在「配置数据目录」）。
   只在 openSettings(opts) 里写入、openSettingsBody 末尾消费一次，消费后即清空。 */
let settingsFocusSection = "";

function mergePluginManagedProviders(targetCfg, sourceCfg) {
  if (!targetCfg || !sourceCfg) return;
  const incoming = Array.isArray(sourceCfg.providers) ? sourceCfg.providers : [];
  const managed = incoming.filter(
    (p) => p && (p.source === "llama-plugin" || p.id === "llama-local"),
  );
  if (!managed.length) return;
  const base = (Array.isArray(targetCfg.providers) ? targetCfg.providers : []).filter(
    (p) => p && p.source !== "llama-plugin" && p.id !== "llama-local",
  );
  targetCfg.providers = base.concat(managed);
}

/* 打开设置时仅合并插件托管服务商（llama 本地等），绝不整表覆盖：
   整表覆盖会把「添加服务商」弹窗刚 push 的内存项与用户在本页的
   增/删/排序全部丢弃 —— 手动添加服务商保存后不在列表中的根因。
   注意：此处不调用 ensureDefaultProviders()——默认服务商只在启动时播种
   （app-boot.js），若每次打开设置都补默认，被用户删除的 gpt_image_2 /
   deepseek 会在列表里立刻「复活」，删除与编辑永远无法保存。 */
async function reloadConfigProvidersFromDisk() {
  if (!window.api || !window.api.configLoad || !S.config) return;
  try {
    const fresh = await window.api.configLoad();
    if (fresh && Array.isArray(fresh.providers)) {
      mergePluginManagedProviders(S.config, fresh);
    }
  } catch {}
}

/* ── 设置改动即时生效 ─────────────────────────────────────────────────
   设置窗不再有「保存并关闭」：任一设置项一改，立刻写进 S.config、该重绘的立刻重绘，
   然后落盘。configSave 是「全量写 config.json」——会话正文已拆到 agent-sessions/
   （见主进程 agent-sessions-store.js），这份文件现在只有几百 KB（本机实测 75.8 MB →
   0.38 MB），落盘从「单次主进程同步 775 ms」降到约 6 ms；主进程每次写前仍会备份一份
   快照（config-backups 只留最近 30 份），逐键写盘依旧只会把快照刷成一堆垃圾 —— 所以
   打字类改动（服务商名称 / 接口地址 / API Key / 端口 / 网格间距）走防抖合并写，
   下拉、勾选、增删与排序这类离散动作直接写。子对话框（服务商配置卡）与关窗路径一律
   先 flush。状态回显走窗底那一行小字（settingsSaveStampEl），不再用 toast 打扰用户。 */
let settingsSaveTimer = null;
let settingsSaveStampEl = null;

function settingsStamp(text, bad) {
  if (!settingsSaveStampEl) return;
  settingsSaveStampEl.textContent = text;
  settingsSaveStampEl.classList.toggle("settings-stamp-bad", !!bad);
}

/* 只刷状态行：改动已由别的路径（如 applyTheme）写盘时用，避免同一次改动写两份备份快照 */
function settingsStampSavedNow() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  settingsStamp(I18n.t("已即时生效 · ") + new Date().toLocaleTimeString(), false);
}

/* 立刻写盘（顺带取消排队中的防抖写）；返回 promise，供关窗路径 await */
function settingsSaveNow() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  if (!S.config || !window.api || !window.api.configSave) return Promise.resolve(false);
  return Promise.resolve(window.api.configSave(S.config)).then(
    () => {
      settingsStampSavedNow();
      return true;
    },
    () => {
      settingsStamp(I18n.t("保存失败：改动只在当前会话内生效"), true);
      toast(I18n.t("保存失败"), "err");
      return false;
    },
  );
}

/* 设置项改完统一走这里：省略 ms = 直接写盘；给 ms = 把这段时间内的连续打字合并成一次写 */
function settingsSaved(ms) {
  if (!ms) return settingsSaveNow();
  settingsStamp(I18n.t("正在保存…"), false);
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(settingsSaveNow, ms);
  return Promise.resolve(false);
}

/* ── 设置里的说明提示（本次需求：界面上不再有「?」，说明挂在标题 / 标签本身）──
   设置页原先平铺着十几段说明文字（小节导语、字段口径、括注），一屏里一半是灰字。
   上一版把它们收进一枚 12px 圆形「?」；本轮按用户口径把「?」整个去掉：
   鼠标移到小节标题 / 字段标签上（或键盘 focus）就出同一份全文，界面不留任何图标。
   为什么不用 ::after 伪元素（顶栏 data-tip 那套）：设置正文 .overlay-body 是
   overflow-y:auto 的滚动容器，伪元素提示会被 overflow 裁掉；所以提示走
   body 级浮层 #setQTip（position:fixed，显示前先量尺寸、按视口夹紧，放不下就翻到上方）。
   文案口径：settingsTip(中文原文) 内在绑定时就翻一次（切语言会整体重建设置页，
   见 renderer/app-boot.js 的 applyLocale），data-tip 与浮层 aria 同源。 */
let setQTipEl = null;
let setQTipBound = false;

function setQTipHide() {
  if (setQTipEl) setQTipEl.hidden = true;
}

/* 宿主里的「真控件」不弹提示：悬停按钮 / 往输入框里打字时冒出一条说明只会碍事 */
function setQTipIsControl(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag === "BUTTON" || tag === "A" || tag === "SELECT" || tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const t = String(
      (el.getAttribute && el.getAttribute("type")) || el.type || "text",
    ).toLowerCase();
    return t !== "checkbox" && t !== "radio";
  }
  return false;
}

/* 浮层只建一次：id 固定 #setQTip，宿主的 aria-describedby 指向它 */
function setQTipEnsure() {
  if (setQTipEl && setQTipEl.isConnected !== false) return setQTipEl;
  const box = document.createElement("div");
  box.className = "set-tip-pop";
  box.id = "setQTip";
  box.setAttribute("role", "tooltip");
  box.hidden = true;
  (document.body || document.documentElement).appendChild(box);
  setQTipEl = box;
  return box;
}

function setQTipShow(host) {
  if (!host) return;
  const txt = host.getAttribute("data-tip") || "";
  if (!txt) return;
  const box = setQTipEnsure();
  box.textContent = txt;
  const lab = host.getAttribute("data-tip-label") || "";
  if (lab) box.setAttribute("aria-label", lab);
  else if (typeof box.removeAttribute === "function") box.removeAttribute("aria-label");
  box.hidden = false;
  /* 只装一次：滚轮 / 缩放 / 点到别处都立刻收提示（设置正文可滚动，提示是 fixed 定位，
     不跟着滚会飘在错的位置）。 */
  if (!setQTipBound && typeof window !== "undefined" && window.addEventListener) {
    setQTipBound = true;
    window.addEventListener("scroll", setQTipHide, true);
    window.addEventListener("resize", setQTipHide);
    document.addEventListener("pointerdown", setQTipHide, true);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") setQTipHide();
    }, true);
  }
  /* 先量尺寸再定落点：默认贴标题 / 标签下方，下方放不下翻到上方，左右按视口夹紧。
     宽行（整行 label）里文字在左，所以提示贴左边出，不居中飘到行中间去。 */
  let r = null;
  try {
    r = typeof host.getBoundingClientRect === "function" ? host.getBoundingClientRect() : null;
  } catch (_) {}
  if (!r) return;
  const vw = document.documentElement.clientWidth || window.innerWidth || 0;
  const vh = document.documentElement.clientHeight || window.innerHeight || 0;
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  let left = r.width > bw ? r.left + 8 : r.left + r.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, Math.max(8, vw - bw - 8)));
  let top = r.bottom + 8;
  if (vh && top + bh > vh - 8) top = Math.max(8, r.top - bh - 8);
  box.style.left = Math.round(left) + "px";
  box.style.top = Math.round(top) + "px";
}

/* 把说明挂到宿主（小节标题 / 字段标签 / 字段行）本身上 —— 不再造「?」图标：
   鼠标移到这处标题（hover）或键盘 focus 到它，才在 #setQTip 里出全文。
   text 传中文原文（同时是 I18n 词条 key），label 可选（无障碍短名，给浮层当 aria-label）。
   宿主里还有按钮 / 输入框时，指向这些控件的那部分鼠标与焦点不弹提示（见 setQTipIsControl），
   所以「悬停标题看说明、点按钮干活、往框里打字」互不打扰。 */
function settingsTip(host, text, label) {
  if (!host || !host.setAttribute) return null;
  const body = I18n.t(text);
  host.setAttribute("data-tip", body);
  if (label) host.setAttribute("data-tip-label", I18n.t(label));
  if (host.classList && host.classList.add) host.classList.add("has-tip");
  /* 读屏：说明挂在浮层上，宿主用 aria-describedby 指过去（不用 aria-label：
     这些宿主大多是 <label>，改 aria-label 会把勾选项的名字也一起换掉） */
  host.setAttribute("aria-describedby", "setQTip");
  /* 键盘可达：宿主里没有可聚焦控件、自己也不是控件时补一个 tabindex
     （冒烟沙箱里的最小 DOM 未必有 hasAttribute / removeAttribute，一律按能力探测） */
  const hasAttr = (el, k) =>
    typeof el.hasAttribute === "function" ? el.hasAttribute(k) : el.getAttribute(k) != null;
  let focusable = false;
  try {
    focusable =
      typeof host.querySelector === "function" &&
      !!host.querySelector("input, select, textarea, button, a[href]");
  } catch (_) {}
  if (!focusable && !setQTipIsControl(host) && !hasAttr(host, "tabindex")) {
    host.setAttribute("tabindex", "0");
  }
  if (typeof host.addEventListener !== "function") return host;
  host.addEventListener("mouseover", (ev) => {
    if (setQTipIsControl(ev && ev.target)) return setQTipHide();
    setQTipShow(host);
  });
  host.addEventListener("mouseout", (ev) => {
    const to = ev && ev.relatedTarget;
    if (to && typeof host.contains === "function" && host.contains(to)) return;
    setQTipHide();
  });
  host.addEventListener("focusin", (ev) => {
    if (setQTipIsControl(ev && ev.target)) return setQTipHide();
    setQTipShow(host);
  });
  host.addEventListener("focusout", setQTipHide);
  return host;
}

/* 兼容既有调用名：说明就挂在 anchor（标题 / 字段标签本身）上 */
function settingsTipBeside(anchor, text, label) {
  return settingsTip(anchor, text, label);
}

function openSettings(opts) {
  /* opts.section === "data"：打开设置并把「配置数据目录」那一节滚进视野
     （顶栏「数据不落应用文件夹」红色警示的点击入口，见 renderer/app-boot.js）。 */
  settingsFocusSection = (opts && opts.section) || "";
  reloadConfigProvidersFromDisk().then(() => {
    openSettingsBody();
    /* 打开设置 = 用户要看提供商了：本地没有快照时顺手拉一次；快照带着失败原因 /
       超过 24 小时没同步时也自动重拉一次（retry:true）——
       设置里已无手动刷新按钮，这里是它唯一的用户侧自救入口（见 renderer/app-relay.js）。 */
    if (typeof MtRelay !== "undefined" && MtRelay.syncIfStale) {
      try {
        MtRelay.syncIfStale({ retry: true });
      } catch {}
    }
  });
}

/* ===== DeepSeek 官方充值通道（新安装默认没有 Key 时给出的第一个指引） =====
   口径：默认服务商 DeepSeek（id "deepseek"，baseUrl 指向 api.deepseek.com）的 API Key
   为空时 —— 也就是刚装好、还没填过 Key 的默认状态 —— 在「提供商配置」上方显示一条
   醒目横幅，点一下在浏览器里打开官方充值页 https://platform.deepseek.com/ 。
   填了 Key（任何非空值）就立刻收起；在服务商配置对话框里改 Key 时即时回刷
   （见 repaintSettingsTopup，卡里 Key 输入框与关窗路径各调一次），不必重开设置。 */
const DEEPSEEK_TOPUP_URL = "https://platform.deepseek.com/";

function deepseekTopupNeeded() {
  const list = (S.config && Array.isArray(S.config.providers)
    ? S.config.providers
    : []
  ).filter((p) => p && String(p.id || "") === "deepseek");
  if (!list.length) return false;
  /* 以「当前优先使用」的那一条为准：官方默认项被留空 Key 就是新安装的样子 */
  const p = list[0];
  return !String(p.apiKey || "").trim();
}

function deepseekTopupBanner() {
  const bar = document.createElement("div");
  bar.className = "ds-topup";
  const text = document.createElement("div");
  text.className = "ds-topup-text";
  const b = document.createElement("b");
  b.textContent = I18n.t("尚未填写 DeepSeek API Key");
  text.appendChild(b);
  const desc = document.createElement("span");
  desc.textContent = I18n.t(
    "首次使用请先在下方「提供商配置」里填入 Key；还没有余额可先到官方充值通道充值。",
  );
  text.appendChild(desc);
  const link = document.createElement("a");
  link.className = "ds-topup-link";
  link.href = DEEPSEEK_TOPUP_URL;
  link.textContent = I18n.t("DeepSeek 官方充值通道") + " ↗";
  link.title = DEEPSEEK_TOPUP_URL + I18n.t("（在浏览器中打开）");
  link.onclick = (ev) => {
    ev.preventDefault();
    try {
      if (window.api && window.api.openExternal) {
        window.api.openExternal(DEEPSEEK_TOPUP_URL);
        return;
      }
    } catch {}
    try {
      window.open(DEEPSEEK_TOPUP_URL, "_blank");
    } catch {}
  };
  bar.appendChild(text);
  bar.appendChild(link);
  return bar;
}

function openSettingsBody() {
  openOverlay(I18n.t("设置 · APIs/Config"));
  overlayPersistent = true; // 设置栏：点击外部不关闭，只走窗底那枚「关闭」（改动本身即时生效）
  overlayKind = "settings";
  /* 每一项改动都直接写进 S.config 并落盘（见文件头「设置改动即时生效」），
     所以下面所有控件都挂 oninput / onchange 即时处理器，末尾只有一个「关闭」。 */
  if (!S.config.dsh) S.config.dsh = {};
  const body = $("#ovBody");
  let enterSelEl = null;

  /* 很少用的小节（网络 / 配置数据目录 / 画布备份 / 存储占用与清理 / 错误与崩溃日志）
     统一沉到最下方：这里先登记，函数末尾按 tailOrder 补挂，避免它们在正文里抢占视线。
     注意：登记 ≠ 可选 —— 凡是「建了 sec 却忘了登记」的小节在界面上等于不存在
     （只剩一个游离 DOM，用户找不到入口），新增小节务必同时补 tailSecs 与 tailOrder。 */
  const tailSecs = { net: null, data: null, backup: null, storage: null, logs: null };
  const tailOrder = ["data", "backup", "storage", "net", "logs"];

  /* ═══════════ 默认模型（设置整页第一块 · 本次需求）════════════════════════
     这是全应用**唯一**一份默认模型，位置 = 设置最上方（在「提供商配置」之上）。
     内容与**会话输入区那颗「模型」菜单**对齐（模型提供商 / 预设 / 模型 / 思考强度），
     口径也同一份真源：
       · 提供商清单 = agentRouteGroupsNow()，只留**有模型**的服务商（= 已配置且有 Key、
         没被停用；没 Key 的选了也跑不动，直接不列）；
       · 模型清单 = 只列当前提供商的模型（不再跨服务商平铺成一长串，同名歧义消失）；
       · 思考强度 = AGENT_EFFORT_UI_ORDER（与会话菜单同一张档位表）；
       · 预设 = config.dsh.preset（原先在「智能能力（dsh）」小节里，整体搬到这里；
         那边只剩子代理 / 权限预设 / 自动执行下游 / 声音）。
     上下文压缩已按用户要求从设置里移除（档位改在会话侧设置：助手栏 / 会话 ⚙ 菜单），
     写回链与生效时机不变。
     生效口径：新建会话按这里播种；会话自己没选过模型时运行期回落到这里
     （见 app-db.js 的 dshRunSpec）；助手栏读写的也是这几格（不再有 config.assistProvider /
     assistModel / assistEffort 那套独立默认）。每一项都即时落盘，与设置里其它项同一条链。 */
  const dshEls = {};
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec settings-sec-lead";

    const secTitleRow = document.createElement("div");
    secTitleRow.className = "settings-sec-title settings-sec-title-row";
    const secTitleSpan = document.createElement("span");
    secTitleSpan.textContent = I18n.t("默认模型");
    secTitleRow.appendChild(secTitleSpan);
    sec.appendChild(secTitleRow);

    /* 可用服务商清单：与「会话 · 模型提供商」那一格同源（agentRouteGroupsNow），
       再滤掉「没填 Key / 一只模型都没有」的 —— 列出来选了也跑不动（本次共识：只列可用）。
       DeepSeek 官方那条即使没有 Key 也会回落到目录里的模型清单，所以 Key 这一关必须
       自己再过一遍（providerForAgentRoute 是「路由 → 服务商」的真源）。 */
    const defaultProviderKeyOk = (id) => {
      try {
        if (typeof providerForAgentRoute === "function") {
          const p = providerForAgentRoute(id);
          return !!(p && String(p.apiKey || "").trim());
        }
      } catch (_) {}
      return true;
    };
    const defaultProviderGroups = () => {
      let groups = [];
      try {
        groups =
          typeof agentRouteGroupsNow === "function"
            ? agentRouteGroupsNow() || []
            : [];
      } catch (_) {
        groups = [];
      }
      if (!groups.length) {
        /* 兜底（会话那份清单不可用）：老口径 —— dshProvider() + mtnodePiProviders() */
        const out = [];
        const dp = dshProvider();
        if (dp && Array.isArray(dp.models) && dp.models.length)
          out.push({
            id: "deepseek-official",
            name: (dp && dp.name) || I18n.t("DeepSeek 官方"),
            models: dp.models.map((m) => String(m)),
          });
        for (const p of mtnodePiProviders()) {
          const models = (p && p.models) || [];
          if (!models.length) continue;
          out.push({
            id: "mtnode_" + p.route,
            name: p.name || p.route,
            models: models.map((m) => String(m)),
          });
        }
        groups = out;
      }
      return groups.filter(
        (g) => g && g.id && (g.models || []).length && defaultProviderKeyOk(g.id),
      );
    };

    /* ── ① 模型提供商（与会话那一格同构：先选服务商，模型只列这家）── */
    const provRow = document.createElement("label");
    provRow.className = "n-field";
    provRow.appendChild(document.createTextNode(I18n.t("模型提供商")));
    const provSel = document.createElement("select");
    provRow.appendChild(provSel);
    sec.appendChild(provRow);
    dshEls.provider = provSel;

    /* ── ② 模型 ── */
    const modelRow = document.createElement("label");
    modelRow.className = "n-field";
    modelRow.appendChild(document.createTextNode(I18n.t("模型")));
    const modelSel = document.createElement("select");
    modelRow.appendChild(modelSel);
    sec.appendChild(modelRow);
    dshEls.model = modelSel;

    /* ── ③ 思考强度（默认档：新会话与助手栏都从这一档起）── */
    const effortRow = document.createElement("label");
    effortRow.className = "n-field";
    effortRow.appendChild(document.createTextNode(I18n.t("思考强度")));
    const effortSel = document.createElement("select");
    const effortOrder =
      (typeof AGENT_EFFORT_UI_ORDER !== "undefined" && AGENT_EFFORT_UI_ORDER) || [
        "off",
        "low",
        "high",
        "xhigh",
        "max",
      ];
    for (const v of effortOrder) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = I18n.t(
        (typeof AGENT_EFFORT_LABELS === "object" && AGENT_EFFORT_LABELS[v]) || v,
      );
      effortSel.appendChild(o);
    }
    effortSel.value = normalizeAgentEffort(S.config.dsh.effort || "high");
    effortRow.appendChild(effortSel);
    sec.appendChild(effortRow);
    dshEls.effort = effortSel;
    effortSel.onchange = () => {
      /* 即时生效：写进 config.dsh.effort（新建会话播种 / 助手栏 / 运行入口都读它） */
      S.config.dsh.effort = normalizeAgentEffort(effortSel.value);
      S.assistEffort = S.config.dsh.effort;
      settingsSaved(0);
    };

    /* ── ④ Agent 预设（迁移自 dsh 的 agent-presets；原先在智能能力小节，整体搬来）── */
    const presetRow = document.createElement("label");
    presetRow.className = "n-field";
    presetRow.appendChild(document.createTextNode(I18n.t("Agent 预设")));
    /* 括注（角色与行为风格）挂标签本身：悬停即出 */
    settingsTipBeside(
      presetRow,
      "Agent 预设（智能能力的角色与行为风格）",
      "Agent 预设说明",
    );
    const presetSel = document.createElement("select");
    /* 档位真源：app.js 的 AGENT_PRESETS（与智能会话 / 智能节点面板同一张表），
       这里只用带说明的 settingsLabelKey */
    for (const p of AGENT_PRESETS) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = I18n.t(p.settingsLabelKey || p.labelKey);
      if (p.hint) o.title = I18n.t(p.hint);
      presetSel.appendChild(o);
    }
    presetSel.value = S.config.dsh.preset || AGENT_PRESET_DEFAULT;
    presetRow.appendChild(presetSel);
    sec.appendChild(presetRow);
    dshEls.preset = presetSel;
    /* 即时生效：Agent 预设在下一次智能运行时读取 */
    presetSel.onchange = () => {
      S.config.dsh.preset = presetSel.value;
      settingsSaved(0);
    };

    /* ── 选中服务商后重建模型格（只列这家的模型）：空模型 = 跟随该家第一只，
       与运行期同一口径（见 app-db.js 的默认模型兜底）。 ── */
    const paintModelOptions = (provId, preferModel) => {
      const groups = defaultProviderGroups();
      const g = groups.filter((x) => x.id === provId)[0] || null;
      const models = ((g && g.models) || []).map(String);
      const all = models.slice();
      /* 保底：老配置里保存过、但已不在该家清单中的值也要能显示出来（不丢用户的选择）。
         只在这格显示的就是「存它的那一家」时才补 —— 换到别家后把 A 家的模型塞进 B 家
         清单，会让人以为可以这么配（实际运行期会按成对口径拨正）。 */
      const cur = String(preferModel || "").trim();
      const savedProv = String((S.config.dsh && S.config.dsh.provider) || "").trim();
      if (cur && (!savedProv || savedProv === provId) && all.indexOf(cur) < 0)
        all.push(cur);
      modelSel.innerHTML = "";
      if (!all.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = I18n.t("（无可用模型）");
        modelSel.appendChild(o);
        modelSel.value = "";
        return;
      }
      for (const m of all) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        modelSel.appendChild(o);
      }
      modelSel.value = cur && all.indexOf(cur) >= 0 ? cur : all[0];
    };
    /* 服务商格重建 + 回显：provider 为空（从没选过）→ 跟随实际生效的默认智能路由，
       与 dshDefaultProviderRoute 同一口径；模型为空 → 回显该家第一只（空 = 跟随）。 */
    const paintDefaultModelRows = () => {
      const groups = defaultProviderGroups();
      const cur = String(dshDefaultProviderRoute() || "");
      provSel.innerHTML = "";
      if (!groups.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = I18n.t(
          "（无可用服务商：请先在下方「提供商配置」里填 API Key）",
        );
        provSel.appendChild(o);
        provSel.value = "";
        paintModelOptions("", "");
        return;
      }
      for (const g of groups) {
        const o = document.createElement("option");
        o.value = g.id;
        o.textContent = g.name || g.id;
        o.title = g.id;
        provSel.appendChild(o);
      }
      const hit = groups.filter((g) => g.id === cur)[0] ? cur : groups[0].id;
      provSel.value = hit;
      paintModelOptions(hit, dshDefaultModelValue());
    };
    paintDefaultModelRows();

    provSel.onchange = () => {
      /* 换提供商 = 换「设置里的提供商」；模型清空（= 跟随新家的第一只），
         绝不留下「A 家的模型配 B 家路由」这种只到运行时才炸的组合。 */
      S.config.dsh.provider = String(provSel.value || "");
      S.config.dsh.model = "";
      S.assistProvider = S.config.dsh.provider;
      S.assistModel = "";
      paintModelOptions(S.config.dsh.provider, "");
      settingsSaved(0);
      /* 助手栏此刻可能开着：它的两格读的就是这一份，顺手回刷 */
      if (typeof fillAssistModelControls === "function") {
        try {
          fillAssistModelControls();
        } catch (_) {}
      }
    };
    modelSel.onchange = () => {
      S.config.dsh.model = String(modelSel.value || "").trim();
      /* 模型一旦显式选定，提供商也一并落定（否则会留下「只有模型没有提供商」的孤儿值） */
      if (!String(S.config.dsh.provider || "").trim())
        S.config.dsh.provider = String(provSel.value || "");
      S.assistProvider = S.config.dsh.provider || S.assistProvider;
      S.assistModel = S.config.dsh.model;
      settingsSaved(0);
      if (typeof fillAssistModelControls === "function") {
        try {
          fillAssistModelControls();
        } catch (_) {}
      }
    };


    body.appendChild(sec);
  }

  /* ── 提供商配置（模型服务）：紧跟「默认模型」之后 ──
     两列网格，每格只显示服务商名称（标题）；点击该格弹出对话框做具体配置
     （类型 / Base URL / API Key / 模型等）。网格顺序 = 服务商使用优先级。 */
  {
    const provSec = document.createElement("div");
    provSec.className = "settings-sec";

    const provTitleRow = document.createElement("div");
    provTitleRow.className = "settings-sec-title settings-sec-title-row";
    const provTitleSpan = document.createElement("span");
    provTitleSpan.textContent = I18n.t("提供商配置");
    provTitleRow.appendChild(provTitleSpan);
    /* MTNode 中转服务（账号托管）：清单与地址由云端下发（见 renderer/app-relay.js）。
       这里**没有手动刷新按钮**（需求：移除「刷新中转清单」）：登录态刷新、充值到账、
       打开设置时按 syncIfStale 的判据自动拉取/重试，用户零操作。 */
    const add = document.createElement("button");
    add.className = "mini";
    add.textContent = I18n.t("＋ 添加服务商");
    add.title = I18n.t("从服务商目录选择或手动配置");
    add.onclick = () => addProviderDialog();
    provTitleRow.appendChild(add);
    provSec.appendChild(provTitleRow);

    /* 无 Key（新安装默认）时的 DeepSeek 官方充值通道：就在「提供商配置」标题下方、
       服务商网格上方，填了 Key 立刻收起 */
    const topupSlot = document.createElement("div");
    topupSlot.className = "ds-topup-slot";
    const paintTopup = () => {
      topupSlot.innerHTML = "";
      if (!deepseekTopupNeeded()) {
        topupSlot.style.display = "none";
        return;
      }
      topupSlot.style.display = "";
      topupSlot.appendChild(deepseekTopupBanner());
    };
    paintTopup();
    provSec.appendChild(topupSlot);

    /* 中转服务状态行：卡在（账号有过充值）才出现，一行给出「可用余额 + 上次同步 /
       失败原因 / 余额不足」——余额与清单都来自云端，这里是它当前能不能用的一句话结论。
       余额按**鲸圆币**显示（1 币 = ¥0.02，见 renderer/app-whalecoin.js）；快照里的 totalYuan
       仍是元，判定与门禁口径一律不动。 */
    const relaySlot = document.createElement("div");
    relaySlot.className = "relay-sync-slot";
    const paintRelay = () => {
      relaySlot.innerHTML = "";
      const prov = typeof MtRelay !== "undefined" ? MtRelay.provider() : null;
      /* 没有中转卡时整行不显示（也不再挂「刷新中转清单」按钮：拉取交给 syncIfStale） */
      if (!prov) {
        relaySlot.style.display = "none";
        return;
      }
      const m = MtRelay.meta(prov);
      relaySlot.style.display = "";
      const line = document.createElement("div");
      line.className = "relay-sync" + (m.blocked || m.error ? " bad" : "");
      const name = document.createElement("b");
      name.textContent = prov.name || I18n.t("MTNode 中转服务");
      line.appendChild(name);
      const bal = document.createElement("span");
      bal.textContent = " · " + I18n.t("可用余额 ");
      bal.appendChild(relayBalanceEl(m.totalYuan));
      line.appendChild(bal);
      const state = document.createElement("span");
      state.className = "relay-sync-state";
      state.textContent = " · " + MtRelay.stateText(prov);
      line.appendChild(state);
      relaySlot.appendChild(line);
    };
    settingsRelayRepaint = paintRelay;
    paintRelay();
    provSec.appendChild(relaySlot);

    const grid = document.createElement("div");
    grid.className = "prov-tiles";
    const paintTiles = () => {
      grid.innerHTML = "";
      S.config.providers.forEach((p, i) => grid.appendChild(provTile(p, i)));
      if (!S.config.providers.length) {
        const empty = document.createElement("div");
        empty.className = "settings-hint";
        empty.style.margin = "0";
        empty.textContent = I18n.t("暂无服务商，点右上「＋ 添加服务商」新建");
        grid.appendChild(empty);
      }
    };
    /* 配置对话框关窗后回刷网格（改过名称 / 删过服务商都在这里体现）；
       充值横幅跟着 Key 走：刚填上 Key 就收起、清空 Key 就回来。
       两个句柄都注册给 repaintSettingsProvTiles / repaintSettingsTopup。 */
    settingsProvTilesRepaint = paintTiles;
    settingsTopupRepaint = paintTopup;
    paintTiles();
    provSec.appendChild(grid);
    body.appendChild(provSec);
  }

  const snapRow = document.createElement("label");
  snapRow.className = "n-field";
  snapRow.style.flexDirection = "row";
  snapRow.style.alignItems = "center";
  snapRow.appendChild(document.createTextNode(I18n.t("画布网格间距（px）：")));
  const snapInp = document.createElement("input");
  snapInp.type = "number";
  snapInp.min = 4;
  snapInp.max = 64;
  snapInp.step = 2;
  snapInp.value = S.config.snap || 24;
  snapInp.style.width = "80px";
  /* 即时生效：画布的 grid() 每次都重读 S.config.snap，改完不必重开也立刻跟手；
     打字用 400ms 防抖合并写盘，失焦 / 回车（change）再补一次确定性写入并重绘。
     命名避开 app.js 的全局 applySnap(s)（那个是画布存档快照，不是一回事） */
  const commitSnap = (repaint) => {
    S.config.snap = Math.max(4, Math.min(64, Number(snapInp.value) || 24));
    settingsSaved(repaint ? 0 : 400);
    if (repaint) renderCanvas();
  };
  snapInp.oninput = () => commitSnap(false);
  snapInp.onchange = () => commitSnap(true);
  snapRow.appendChild(snapInp);
  body.appendChild(snapRow);

  /* 节点「?」说明按钮：每个节点头部那颗小问号，点击弹出最简语言的功能说明；
     这里可以整体隐藏，默认打开（见 renderer/app-nodehelp.js 的 nodeHelpEnabled） */
  const helpRow = document.createElement("label");
  helpRow.className = "n-field";
  helpRow.style.flexDirection = "row";
  helpRow.style.alignItems = "center";
  const helpCb = document.createElement("input");
  helpCb.type = "checkbox";
  helpCb.checked = !(S.config && S.config.showNodeHelp === false);
  /* 即时生效：勾 / 取消后马上重绘画布，节点头部那颗「?」立刻出现或消失 */
  helpCb.onchange = () => {
    S.config.showNodeHelp = !!helpCb.checked;
    settingsSaved(0);
    renderCanvas();
  };
  helpRow.appendChild(helpCb);
  helpRow.appendChild(document.createTextNode(I18n.t("节点「?」说明按钮")));
  /* 括注（点了看什么、默认开）挂勾选项文字本身：悬停即出 */
  settingsTipBeside(
    helpRow,
    "节点「?」说明按钮（点击查看该节点是做什么的；取消勾选则隐藏，默认打开）",
    "节点说明按钮",
  );
  body.appendChild(helpRow);

  /* 对话发送行为(迁移自 dsh 的 Enter 行为设置) */
  const enterRow = document.createElement("label");
  enterRow.className = "n-field";
  enterRow.style.flexDirection = "row";
  enterRow.style.alignItems = "center";
  enterRow.appendChild(document.createTextNode(I18n.t("对话节点发送行为：")));
  const enterSel = document.createElement("select");
  {
    const o1 = document.createElement("option");
    o1.value = "send";
    o1.textContent = I18n.t("Enter 发送 · Shift+Enter 换行");
    const o2 = document.createElement("option");
    o2.value = "newline";
    o2.textContent = I18n.t("Enter 换行 · Ctrl+Enter 发送");
    enterSel.appendChild(o1);
    enterSel.appendChild(o2);
    enterSel.value =
      S.config.dsh.chatEnter === "newline" ? "newline" : "send";
  }
  enterRow.appendChild(enterSel);
  body.appendChild(enterRow);
  enterSelEl = enterSel;
  /* 即时生效：发送行为在下一条消息就按新档位走 */
  enterSel.onchange = () => {
    S.config.dsh.chatEnter = enterSel.value;
    settingsSaved(0);
  };

  /* 主题(2 款,默认 DSH;选完立刻换肤并由 applyTheme 写盘) */
  const themeRow = document.createElement("label");
  themeRow.className = "n-field";
  themeRow.style.flexDirection = "row";
  themeRow.style.alignItems = "center";
  themeRow.appendChild(document.createTextNode(I18n.t("主题色：")));
  const themeSel = document.createElement("select");
  for (const [v, t] of Object.entries(THEMES)) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(t.name);
    themeSel.appendChild(o);
  }
  themeSel.value = (S.config && S.config.theme) || "dsh";
  /* applyTheme 内部会自己写盘（全局共用一条路径），这里只补状态行回显，
     免得同一次换肤写出两份 config-backups 快照 */
  themeSel.addEventListener("change", () => {
    applyTheme(themeSel.value);
    settingsStampSavedNow();
  });
  themeRow.appendChild(themeSel);
  body.appendChild(themeRow);
  const themeSelEl = themeSel;

  /* ── 网络（Network）：所有网络节点共用的固定端口 ── */
  let netPortInp = null;
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("网络（Network）");
    sec.appendChild(secTitle);
    const row = document.createElement("label");
    row.className = "n-field";
    row.style.flexDirection = "row";
    row.style.alignItems = "center";
    row.appendChild(document.createTextNode(I18n.t("网络端口（全局默认）：")));
    netPortInp = document.createElement("input");
    netPortInp.type = "number";
    netPortInp.min = "1";
    netPortInp.max = "65535";
    netPortInp.step = "1";
    netPortInp.style.width = "110px";
    netPortInp.value = String(
      Math.max(1, Math.min(65535, Number(S.config && S.config.netPort) || NET_DEFAULT_PORT)),
    );
    /* 即时生效：端口只在 netPortOf() 运行时读，改完即被下一个未填端口的网络节点用到；
       重绘一次画布，把节点上「全局 40999」这类回显也一起跟上 */
    const commitPort = (repaint) => {
      S.config.netPort = Math.max(
        1,
        Math.min(65535, Number(netPortInp.value) || NET_DEFAULT_PORT),
      );
      settingsSaved(repaint ? 0 : 400);
      if (repaint) renderCanvas();
    };
    netPortInp.oninput = () => commitPort(false);
    netPortInp.onchange = () => commitPort(true);
    row.appendChild(netPortInp);
    sec.appendChild(row);
    /* 很少用 → 沉到设置最下方（见函数末尾统一补挂） */
    tailSecs.net = sec;
  }

  /* ── 配置数据目录（API Key / 工作流等；更改后需重启）──
     id = 顶栏「数据不落应用文件夹」红色警示点击后的滚动落点（见文件头的 settingsFocusSection） */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    sec.id = "setDataRootSec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("配置数据目录");
    sec.appendChild(secTitle);

    const pathRow = document.createElement("div");
    pathRow.className = "n-field";
    pathRow.style.flexDirection = "row";
    pathRow.style.alignItems = "center";
    pathRow.style.gap = "8px";
    pathRow.style.flexWrap = "wrap";
    const pathLab = document.createElement("span");
    pathLab.textContent = I18n.t("当前路径：");
    const pathEl = document.createElement("code");
    pathEl.style.wordBreak = "break-all";
    pathEl.style.fontSize = "12px";
    pathEl.textContent = "…";
    pathRow.appendChild(pathLab);
    pathRow.appendChild(pathEl);
    sec.appendChild(pathRow);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    const changeBtn = document.createElement("button");
    changeBtn.className = "mini";
    changeBtn.textContent = I18n.t("更改目录…");
    changeBtn.title = I18n.t("选择新的配置数据目录；改完需重启应用生效");

    const resetBtn = document.createElement("button");
    resetBtn.className = "mini";
    resetBtn.textContent = I18n.t("恢复默认");
    resetBtn.title = I18n.t("清除自定义路径，回到应用默认数据目录");

    const openBtn = document.createElement("button");
    openBtn.className = "mini";
    openBtn.textContent = I18n.t("打开目录");
    openBtn.title = I18n.t("在资源管理器中打开当前配置数据目录");

    let rootInfo = null;
    const refreshRoot = async () => {
      try {
        rootInfo = await window.api.dataGetRoot();
      } catch (e) {
        rootInfo = { ok: false, error: e.message || String(e) };
      }
      if (!rootInfo || !rootInfo.ok) {
        pathEl.textContent = (rootInfo && rootInfo.error) || I18n.t("未知错误");
        changeBtn.disabled = true;
        resetBtn.disabled = true;
        return;
      }
      pathEl.textContent = rootInfo.path || "";
      const locked = !!rootInfo.envLocked;
      changeBtn.disabled = locked;
      resetBtn.disabled = locked || !rootInfo.isCustom;
      if (locked) {
        changeBtn.title = I18n.t(
          "当前由环境变量 MTNODE_DATA_DIR 指定数据目录，无法在设置中更改",
        );
        resetBtn.title = changeBtn.title;
      }
    };
    refreshRoot();

    const relaunchAfter = async () => {
      toast(I18n.t("正在重启应用…"), "ok");
      try {
        await window.api.appRelaunch();
      } catch (e) {
        toast(I18n.t("重启失败：") + (e.message || String(e)), "err");
      }
    };

    changeBtn.onclick = async () => {
      if (
        !(await confirmDialog(
          I18n.t(
            "更改配置数据目录后需要重启应用才能生效。是否继续选择新目录？",
          ),
          { title: I18n.t("更改数据目录") },
        ))
      )
        return;
      const picked = await window.api.fileOpenDialog({
        title: I18n.t("选择配置数据目录"),
        directory: true,
      });
      const next = picked && picked.path;
      if (!next) return;
      const migrate = await confirmDialog(
        I18n.t("是否将现有配置（API Key、画布等）复制到新目录？") +
          "\n\n" +
          I18n.t("若新目录已有 config.json，则不会覆盖。"),
        { title: I18n.t("迁移配置"), okText: I18n.t("复制"), cancelText: I18n.t("不复制") },
      );
      try {
        const r = await window.api.dataSetRoot({ path: next, migrate });
        if (!r || !r.ok) {
          toast(
            I18n.t("更改失败：") +
              ((r && r.error) || I18n.t("未知错误")),
            "err",
          );
          return;
        }
        if (r.unchanged) {
          toast(I18n.t("目录未变化"), "ok");
          return;
        }
        if (
          !(await confirmDialog(
            I18n.t("配置数据目录已更新。需要立即重启应用才能生效，是否现在重启？"),
            { title: I18n.t("重启应用"), okText: I18n.t("立即重启") },
          ))
        ) {
          toast(I18n.t("已保存新路径，请手动重启应用后生效"), "ok");
          await refreshRoot();
          /* 顶栏「数据不落应用文件夹」警示：新数据目录也可能正好落在应用文件夹内
             （或从里面挪了出来）→ 立刻重查一次，别让警示停在旧结论上 */
          if (typeof window.checkAppDirWarn === "function") {
            try { await window.checkAppDirWarn(); } catch (_) {}
          }
          return;
        }
        await relaunchAfter();
      } catch (e) {
        toast(I18n.t("更改失败：") + (e.message || String(e)), "err");
      }
    };

    resetBtn.onclick = async () => {
      if (
        !(await confirmDialog(
          I18n.t(
            "恢复默认配置数据目录后需要重启应用才能生效。是否继续？",
          ),
          { title: I18n.t("恢复默认目录"), danger: true },
        ))
      )
        return;
      try {
        const r = await window.api.dataSetRoot({ path: null });
        if (!r || !r.ok) {
          toast(
            I18n.t("更改失败：") +
              ((r && r.error) || I18n.t("未知错误")),
            "err",
          );
          return;
        }
        if (
          !(await confirmDialog(
            I18n.t("已恢复默认目录。需要立即重启应用才能生效，是否现在重启？"),
            { title: I18n.t("重启应用"), okText: I18n.t("立即重启") },
          ))
        ) {
          toast(I18n.t("已恢复默认路径，请手动重启应用后生效"), "ok");
          await refreshRoot();
          if (typeof window.checkAppDirWarn === "function") {
            try { await window.checkAppDirWarn(); } catch (_) {}
          }
          return;
        }
        await relaunchAfter();
      } catch (e) {
        toast(I18n.t("更改失败：") + (e.message || String(e)), "err");
      }
    };

    openBtn.onclick = async () => {
      const r = await window.api.dataOpenRoot();
      if (!r || !r.ok)
        toast(
          I18n.t("无法打开目录：") +
            ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
    };

    btnRow.appendChild(changeBtn);
    btnRow.appendChild(resetBtn);
    btnRow.appendChild(openBtn);
    sec.appendChild(btnRow);
    /* 很少用 → 沉到设置最下方（见函数末尾统一补挂） */
    tailSecs.data = sec;
  }

  /* ── 画布备份（每 5 分钟自动快照到独立备份文件夹）── */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("画布备份");
    sec.appendChild(secTitle);

    const statusEl = document.createElement("div");
    statusEl.className = "n-field";
    statusEl.style.fontSize = "12px";
    statusEl.style.opacity = "0.9";
    statusEl.textContent = I18n.t("正在读取备份状态…");
    sec.appendChild(statusEl);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    const openBakBtn = document.createElement("button");
    openBakBtn.className = "mini";
    openBakBtn.textContent = I18n.t("打开备份文件夹");
    openBakBtn.title = I18n.t("在资源管理器中打开工作流备份目录");
    openBakBtn.onclick = async () => {
      const r = await window.api.wfBackupOpen();
      if (!r || !r.ok)
        toast(
          I18n.t("无法打开目录：") +
            ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
      refreshBak();
    };
    btnRow.appendChild(openBakBtn);
    sec.appendChild(btnRow);

    const refreshBak = async () => {
      try {
        const st = await window.api.wfBackupStatus();
        if (!st || !st.ok) {
          statusEl.textContent =
            I18n.t("无法读取：") + ((st && st.error) || I18n.t("未知错误"));
          return;
        }
        const bits = [
          I18n.t("备份目录：") + (st.dir || ""),
          (st.count || 0) + " " + I18n.t("份"),
        ];
        if (st.latest)
          bits.push(
            I18n.t("最近更新：") + new Date(st.latest).toLocaleString(),
          );
        statusEl.textContent = bits.join(" · ");
      } catch (e) {
        statusEl.textContent = I18n.t("无法读取：") + (e.message || String(e));
      }
    };
    refreshBak();
    /* 很少用 → 沉到设置最下方（见函数末尾统一补挂） */
    tailSecs.backup = sec;
  }

  /* ── 存储占用与清理 ──────────────────────────────────────────────────
     设置一打开就自动统计（storage:scan，主进程扫，后台跑、结果回来再渲染），
     按分类列「总占用 + 文件数 + 其中可清理大小」，每行一个「清理」按钮，底部一个「全部清理」。
     判据是「文件还被不被 MTNode 用着」，规则与落点全部在主进程 storage-clean.js：
       · 画布资产：没被任何存档 / 备份 / 回收站引用的直属文件（正在跑的画布整个跳过）
       · 画布备份 / 配置备份：超出保留份数（72 / 30）的旧快照
       · 缓存：工坊 / 应用 / 讨论区 / 截图目录
       · 回收站内容、浏览器缓存子目录（保留 Cookie）
       · 历史回滚数据（会话轮次回滚功能已移除，剩下的历史目录整目录删除）、超期会话记录（默认 7 天，可改）
     删除一律先搬进系统回收站（失败回退数据目录下的清理暂存区）；会话记录与历史回滚
     数据是永久删除（回执里注明）。 */
  let scRefresh = null;
  let scInputs = null;
  let scBusy = false;
  let scBusyText = "";
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    /* id = 顶栏「性能」面板「查看数据目录占用明细…」的滚动落点（openSettings({section:"storage"})） */
    sec.id = "setStorageSec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("存储占用与清理");
    /* 长导语收进标题本身（本次需求：说明不占界面，悬停标题才出） */
    settingsTipBeside(
      secTitle,
      "统计数据目录里各类冗余的占用，并清理「已经没被 MTNode 用着」的文件：画布资产只清没有任何存档 / 备份 / 回收站引用的；正在运行的画布与正在编辑的文件一律跳过。清理默认把文件搬进系统回收站（可在资源管理器「还原」），只有会话记录与历史回滚数据是永久删除。",
      "存储占用与清理说明",
    );
    sec.appendChild(secTitle);

    const summaryEl = document.createElement("div");
    summaryEl.className = "n-field";
    summaryEl.style.fontSize = "12px";
    summaryEl.style.opacity = "0.9";
    summaryEl.textContent = I18n.t("正在统计存储占用…");
    sec.appendChild(summaryEl);

    const listEl = document.createElement("div");
    listEl.className = "sc-list";
    sec.appendChild(listEl);

    const sessRow = document.createElement("label");
    sessRow.className = "n-field";
    sessRow.style.flexDirection = "row";
    sessRow.style.alignItems = "center";
    sessRow.style.gap = "6px";
    sessRow.appendChild(
      document.createTextNode(I18n.t("会话记录保留最近")),
    );
    const sessDays = document.createElement("input");
    sessDays.type = "number";
    sessDays.min = "1";
    sessDays.max = "365";
    sessDays.step = "1";
    sessDays.value = "7";
    sessDays.style.width = "64px";
    sessDays.title = I18n.t("超过这些天没动过的会话目录才计入「可清理」");
    sessRow.appendChild(sessDays);
    sessRow.appendChild(document.createTextNode(I18n.t("天（只统计，不自动删）")));
    sec.appendChild(sessRow);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";
    const rescanBtn = document.createElement("button");
    rescanBtn.className = "mini";
    rescanBtn.textContent = I18n.t("重新统计");
    rescanBtn.title = I18n.t("重新扫描各类占用（打开设置时会自动统计一次）");
    const cleanAllBtn = document.createElement("button");
    cleanAllBtn.className = "mini danger";
    cleanAllBtn.textContent = I18n.t("全部清理");
    cleanAllBtn.title = I18n.t("对所有有冗余的分类执行清理（逐类确认一次）");
    const openDirBtn = document.createElement("button");
    openDirBtn.className = "mini";
    openDirBtn.textContent = I18n.t("打开数据目录");
    openDirBtn.title = I18n.t("在资源管理器中打开当前配置数据目录");
    btnRow.appendChild(rescanBtn);
    btnRow.appendChild(cleanAllBtn);
    btnRow.appendChild(openDirBtn);
    sec.appendChild(btnRow);

    const statusEl = document.createElement("div");
    statusEl.className = "n-field";
    statusEl.style.fontSize = "12px";
    statusEl.style.opacity = "0.9";
    statusEl.style.whiteSpace = "pre-wrap";
    statusEl.textContent = "";
    sec.appendChild(statusEl);

    /* 正在跑的画布 + 当前打开的画布：交给主进程整个跳过它的资产目录 */
    const protectedIds = () => {
      const out = [];
      try {
        const add = (v) => {
          const s = String(v || "").trim();
          if (s && out.indexOf(s) < 0) out.push(s);
        };
        if (typeof S !== "undefined" && S && S.wf && S.wf.id) add(S.wf.id);
        const visited =
          S && S.config && Array.isArray(S.config.visitedWorkflows)
            ? S.config.visitedWorkflows
            : [];
        for (const item of visited) {
          const wf = item && item.id ? item : null;
          if (!wf) continue;
          if (!Array.isArray(wf.nodes)) continue;
          if (wf.nodes.some((n) => n && (n.running || n.pendingRun))) add(wf.id);
          if (S.pendingRun && S.pendingRun.size && wf.id === (S.wf && S.wf.id))
            add(wf.id);
        }
      } catch {}
      return out;
    };

    const scFmtSize = (n) => {
      const b = Number(n) || 0;
      if (b < 1024) return b + " B";
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
      if (b < 1024 * 1024 * 1024) return (b / 1048576).toFixed(1) + " MB";
      return (b / 1073741824).toFixed(2) + " GB";
    };

    /* 待确认的清理请求（渲染层先弹二次确认，再调到主进程） */
    let scPending = null;
    const scRows = [];
    const scPick = (rows) => {
      scPending = rows;
      listEl.innerHTML = "";
      const box = document.createElement("div");
      box.className = "sc-pick";
      const head = document.createElement("div");
      head.className = "sc-pick-head";
      let total = 0;
      for (const r of rows) total += r.cat.cleanBytes || 0;
      head.textContent = I18n.t("即将清理：") + scFmtSize(total);
      box.appendChild(head);
      for (const r of rows) {
        const line = document.createElement("div");
        line.className = "sc-pick-row";
        const who = document.createElement("b");
        who.textContent = r.cat.label;
        line.appendChild(who);
        const what = document.createElement("span");
        what.style.opacity = "0.85";
        what.textContent =
          " · " + (r.cat.cleanLabel || I18n.t("清理")) + " " +
          scFmtSize(r.cat.cleanBytes || 0) +
          (r.cat.cleanFiles ? "（" + r.cat.cleanFiles + I18n.t(" 个文件") + "）" : "");
        line.appendChild(what);
        if (r.cat.permanent) {
          const warn = document.createElement("span");
          warn.style.color = "var(--red)";
          warn.textContent = " · " + I18n.t("永久删除，不进回收站");
          line.appendChild(warn);
        }
        box.appendChild(line);
      }
      const where = document.createElement("div");
      where.className = "sc-pick-note";
      where.textContent = I18n.t(
        "非永久删除的项会先搬进系统回收站（失败时回退数据目录下的 .storage-clean 清理暂存区）；可在资源管理器里还原。",
      );
      box.appendChild(where);
      const row = document.createElement("div");
      row.className = "sc-pick-btns";
      const okBtn = document.createElement("button");
      okBtn.className = "mini danger";
      okBtn.textContent = I18n.t("确认清理");
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "mini";
      cancelBtn.textContent = I18n.t("取消清理");
      cancelBtn.onclick = () => {
        scPending = null;
        paint();
      };
      okBtn.onclick = () => doClean(rows);
      row.appendChild(okBtn);
      row.appendChild(cancelBtn);
      box.appendChild(row);
      listEl.appendChild(box);
      okBtn.focus();
    };

    const doClean = async (rows) => {
      if (scBusy) return;
      scPending = null;
      scBusy = true;
      let freed = 0;
      let removed = 0;
      let failed = 0;
      const parts = [];
      for (let i = 0; i < rows.length; i++) {
        const cat = rows[i].cat;
        scBusyText =
          I18n.t("正在清理：") + cat.label + "（" + (i + 1) + "/" + rows.length + "）";
        paint();
        try {
          const r = await window.api.storageClean({
            id: cat.id,
            runningWfIds: protectedIds(),
            sessionDays: Math.max(1, Math.min(365, parseInt(sessDays.value, 10) || 7)),
          });
          const one = (r && r.results && r.results[0]) || {};
          if (r && r.ok === false) {
            parts.push(cat.label + "：" + (r.error || I18n.t("失败")));
          } else if (one.ok === false) {
            parts.push(cat.label + "：" + (one.error || I18n.t("失败")));
          } else {
            freed += one.bytesFreed || 0;
            removed += one.removed || 0;
            failed += one.failed || 0;
            if (one.detail) parts.push(cat.label + "：" + one.detail);
          }
        } catch (err) {
          parts.push(cat.label + "：" + ((err && err.message) || String(err)));
        }
      }
      scBusy = false;
      scBusyText = "";
      statusEl.textContent =
        I18n.t("清理完成：释放 ") +
        scFmtSize(freed) +
        "，" +
        I18n.t("处理 ") +
        removed +
        I18n.t(" 项") +
        (failed ? "，" + failed + I18n.t(" 项失败（文件可能被占用）") : "") +
        (parts.length ? "\n" + parts.join("\n") : "");
      try {
        toast(
          I18n.t("已清理冗余文件，释放 ") + scFmtSize(freed),
          failed ? "warn" : "ok",
        );
      } catch {}
    };

    const paint = () => {
      if (scPending) return;
      const last = scRows.length ? scRows[scRows.length - 1] : null;
      listEl.innerHTML = "";
      if (scBusy) {
        const busy = document.createElement("div");
        busy.className = "sc-busy";
        busy.textContent = scBusyText || I18n.t("正在统计存储占用…");
        listEl.appendChild(busy);
        return;
      }
      if (!last) return;
      if (last.error) {
        const err = document.createElement("div");
        err.className = "sc-empty";
        err.textContent = I18n.t("统计失败：") + last.error;
        listEl.appendChild(err);
        return;
      }
      for (const cat of last.scan.cats || []) {
        const row = document.createElement("div");
        row.className = "sc-row";
        const left = document.createElement("div");
        left.className = "sc-row-main";
        const name = document.createElement("div");
        name.className = "sc-row-name";
        name.textContent = cat.label;
        left.appendChild(name);
        const meta = document.createElement("div");
        meta.className = "sc-row-meta";
        meta.textContent =
          scFmtSize(cat.bytes) +
          " · " +
          (cat.files || 0) +
          I18n.t(" 个文件") +
          (cat.cleanBytes
            ? " · " + I18n.t("其中可清理 ") + scFmtSize(cat.cleanBytes)
            : "") +
          (cat.items && cat.id === "sessions" ? " · " + cat.items + I18n.t(" 个会话") : "");
        left.appendChild(meta);
        if (cat.detail || cat.hint) {
          const note = document.createElement("div");
          note.className = "sc-row-note";
          note.textContent = [cat.detail, cat.hint].filter(Boolean).join(" · ");
          left.appendChild(note);
        }
        row.appendChild(left);
        const b = document.createElement("button");
        b.className = "mini";
        b.textContent = cat.cleanLabel || I18n.t("清理");
        b.disabled = !cat.cleanable;
        b.title = cat.cleanable
          ? I18n.t("清理这一类里没被引用的部分") + "（" + scFmtSize(cat.cleanBytes) + "）"
          : I18n.t("这一类暂时没有可清理的内容");
        b.onclick = () => scPick([{ cat: cat }]);
        row.appendChild(b);
        listEl.appendChild(row);
      }
    };

    const scanNow = async () => {
      if (scBusy) return;
      scBusy = true;
      scBusyText = I18n.t("正在统计存储占用…");
      statusEl.textContent = "";
      paint();
      try {
        const r = await window.api.storageScan({
          runningWfIds: protectedIds(),
          sessionDays: Math.max(1, Math.min(365, parseInt(sessDays.value, 10) || 7)),
        });
        if (!r || r.ok === false) {
          scRows.push({ error: (r && r.error) || I18n.t("未知错误") });
        } else {
          scRows.push({ scan: r });
          const t = r.totals || {};
          summaryEl.textContent =
            I18n.t("数据目录：") +
            (r.root || "") +
            "\n" +
            I18n.t("合计 ") +
            scFmtSize(t.bytes) +
            " / " +
            (t.files || 0) +
            I18n.t(" 个文件，其中可清理 ") +
            scFmtSize(t.cleanBytes) +
            "（" +
            (t.cleanFiles || 0) +
            I18n.t(" 个文件）");
        }
      } catch (err) {
        scRows.push({ error: (err && err.message) || String(err) });
      }
      scBusy = false;
      scBusyText = "";
      paint();
    };

    rescanBtn.onclick = () => scanNow();
    openDirBtn.onclick = async () => {
      const r = await window.api.dataOpenRoot();
      if (!r || !r.ok)
        toast(
          I18n.t("无法打开目录：") + ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
    };
    cleanAllBtn.onclick = () => {
      const last = scRows.length ? scRows[scRows.length - 1] : null;
      if (!last || !last.scan) {
        toast(I18n.t("还没有统计数据，请先「重新统计」"), "warn");
        return;
      }
      const rows = (last.scan.cats || [])
        .filter((c) => c.cleanable)
        .map((c) => ({ cat: c }));
      if (!rows.length) {
        toast(I18n.t("没有可清理的内容"), "ok");
        return;
      }
      scPick(rows);
    };
    sessDays.onchange = () => scanNow();
    /* 窗内自刷新入口：外部（重开设置 / 手动）想重扫时调它 */
    scRefresh = () => scanNow();
    scInputs = { sessDays: sessDays };
    /* 打开设置即自动统计（后台跑，结果回来再渲染） */
    scanNow();
    /* 很少用 → 沉到设置最下方（跟「配置数据目录 / 画布备份」挨着，见函数末尾统一补挂） */
    tailSecs.storage = sec;
  }


  /* ── 画布粘贴（剪贴板图像）：画布上 Ctrl+V 时要不要先问一句 ──
     沿用既有口径：字段缺省（没写过）= 询问；只有显式 false 才免询问。
     与询问窗里「以后不再询问」同一个开关（都写 S.config.askPasteClipImage + 立即落盘），
     这里就是它的恢复入口。 */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("画布粘贴");
    sec.appendChild(secTitle);

    const askRow = document.createElement("label");
    askRow.className = "n-field";
    askRow.style.flexDirection = "row";
    askRow.style.alignItems = "center";
    const askCb = document.createElement("input");
    askCb.type = "checkbox";
    askCb.checked = !(S.config && S.config.askPasteClipImage === false);
    askCb.onchange = () => {
      S.config.askPasteClipImage = !!askCb.checked;
      settingsSaved(0);
    };
    askRow.appendChild(askCb);
    askRow.appendChild(document.createTextNode(I18n.t("粘贴剪贴板图像时先询问")));
    settingsTipBeside(
      askRow,
      "粘贴剪贴板图像时先询问（取消勾选 = 以后不再询问）",
      "粘贴图像询问",
    );
    sec.appendChild(askRow);

    body.appendChild(sec);
  }

  /* ── 错误与崩溃日志（自动保存，可导出提交给开发者）── */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("错误与崩溃日志");
    settingsTipBeside(
      secTitle,
      "应用内部错误与崩溃会自动写入本地诊断日志（不含 API Key）。导出后可发给开发者协助排查。",
      "错误与崩溃日志说明",
    );
    sec.appendChild(secTitle);

    const statusEl = document.createElement("div");
    statusEl.className = "n-field";
    statusEl.style.fontSize = "12px";
    statusEl.style.opacity = "0.9";
    statusEl.textContent = I18n.t("正在读取日志状态…");
    sec.appendChild(statusEl);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    const exportBtn = document.createElement("button");
    exportBtn.className = "mini";
    exportBtn.textContent = I18n.t("导出诊断日志…");
    exportBtn.title = I18n.t("打包环境信息与近期错误日志为 .txt，便于提交");

    const openLogsBtn = document.createElement("button");
    openLogsBtn.className = "mini";
    openLogsBtn.textContent = I18n.t("打开日志文件夹");
    openLogsBtn.title = I18n.t("在资源管理器中打开自动保存的日志目录");

    const refreshStatus = async () => {
      try {
        const st = await window.api.crashStatus();
        if (!st || !st.ok) {
          statusEl.textContent =
            I18n.t("无法读取：") + ((st && st.error) || I18n.t("未知错误"));
          return;
        }
        const bits = [];
        bits.push(I18n.t("日志目录：") + (st.logsDir || ""));
        if (st.errorBytes)
          bits.push(
            I18n.t("error.log：") +
              Math.max(1, Math.round(st.errorBytes / 1024)) +
              " KB" +
              (st.errorMtime ? " · " + st.errorMtime : ""),
          );
        else bits.push(I18n.t("尚无 error.log"));
        if (st.latestReport)
          bits.push(
            I18n.t("最近崩溃报告：") +
              st.latestReport.name +
              (st.latestReport.mtime ? " · " + st.latestReport.mtime : ""),
          );
        else bits.push(I18n.t("尚无崩溃报告"));
        if (st.reportCount)
          bits.push(I18n.t("已保存报告数：") + st.reportCount);
        statusEl.textContent = bits.join("\n");
        statusEl.style.whiteSpace = "pre-wrap";
      } catch (e) {
        statusEl.textContent =
          I18n.t("无法读取：") + (e.message || String(e));
      }
    };
    refreshStatus();

    exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      try {
        const r = await window.api.crashExport();
        if (r && r.canceled) return;
        if (!r || !r.ok) {
          toast(
            I18n.t("导出失败：") + ((r && r.error) || I18n.t("未知错误")),
            "err",
          );
          return;
        }
        toast(I18n.t("诊断日志已导出，请将该文件发送给开发者"), "ok");
        await refreshStatus();
      } catch (e) {
        toast(I18n.t("导出失败：") + (e.message || String(e)), "err");
      } finally {
        exportBtn.disabled = false;
      }
    };

    openLogsBtn.onclick = async () => {
      const r = await window.api.crashOpenLogs();
      if (!r || !r.ok)
        toast(
          I18n.t("无法打开目录：") +
            ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
    };

    btnRow.appendChild(exportBtn);
    btnRow.appendChild(openLogsBtn);
    sec.appendChild(btnRow);
    /* 很少用 → 沉到设置最下方（见函数末尾统一补挂） */
    tailSecs.logs = sec;
  }

  /* ── 智能能力（dsh）区块 ──
     默认模型 / Agent 预设两块已整体搬到设置最上方的「默认模型」小节
     （上下文压缩已从设置移除，改在会话侧设置）。这里只留与「模型选哪只」无关的智能能力
     设置：权限预设 / 自动执行下游 / 声音 / 工具负载 / 开发工具 / 工作步骤展示档位。
     子代理（委派）的界面已按需求整块移除（连同「默认模型已搬走」的指路提示与
     「交流语言（Agent 口味）」纯回显）：配置键 config.dsh.subagent 与运行期取值不变，
     仍由 dsh-agent-policy.js 的 policyFromConfig / normalizePolicy 读取
     （缺省 = 开 / 允许 fork / 允许后台 / 深度 1）。 */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("智能能力（DeepSeek Harness / dsh）");
    sec.appendChild(secTitle);

    /* 权限预设(dsh permission-presets:沙箱模式 + 审批策略,热重载生效) */
    const permRow = document.createElement("label");
    permRow.className = "n-field";
    permRow.appendChild(
      document.createTextNode(I18n.t("权限预设")),
    );
    const permSel = document.createElement("select");
    const PERM_OPTIONS = permissionPresetOptions();
    for (const [v, l] of PERM_OPTIONS) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      permSel.appendChild(o);
    }
    permSel.value = S.config.dsh.permissionPreset || "mtnode-unattended";
    /* 即时生效：走顶栏「审批与权限」同一真源 setPermissionPreset（写盘 + 回刷 + 提示），
       下一轮智能运行即按新档位放行 */
    permSel.onchange = () => {
      setPermissionPreset(permSel.value);
      settingsStampSavedNow();
    };
    permRow.appendChild(permSel);
    sec.appendChild(permRow);
    dshEls.permissionPreset = permSel;

    /* 防失控开关：节点跑完是否自动接力下游（默认关；连跑请用控制节点 ▶） */
    const cascRow = document.createElement("label");
    cascRow.className = "n-field";
    cascRow.style.flexDirection = "row";
    cascRow.style.alignItems = "center";
    const cascCb = document.createElement("input");
    cascCb.type = "checkbox";
    try {
      cascCb.checked = localStorage.getItem("mtnode.autoRunDownstream") === "1";
    } catch {
      cascCb.checked = false;
    }
    cascCb.onchange = () => setAutoRunDownstream(cascCb.checked);
    cascRow.appendChild(cascCb);
    cascRow.appendChild(document.createTextNode(I18n.t("节点完成后自动执行下游")));
    /* 括注（默认关、连跑用控制节点）挂勾选项文字本身：悬停即出 */
    settingsTipBeside(
      cascRow,
      "节点完成后自动执行下游（默认关：连跑请用控制节点 ▶）",
      "自动执行下游说明",
    );
    sec.appendChild(cascRow);

    /* 完成音效（本次需求：只剩一把音色、一档音量）:
       只有一种声音 —— 任何一件任务跑完（含最后一件，也就是「全部完成」）都响同一声
       短促的「叮咚」（E5→A5，0.42 秒）。原来「所有任务都完成 → 同一把音色 ×1.5 音量
       再响一声」那一档已整体删除（与「全局三音上行 / 总时长超 5 分钟」的长任务音效
       一样下线了）。
       共用这个开关与下面的音量滑杆；自定义音频文件也用它（设了就用用户选的音，
       留空用内置音）。 */
    const sndRow = document.createElement("label");
    sndRow.className = "n-field";
    sndRow.style.flexDirection = "row";
    sndRow.style.alignItems = "center";
    const sndCb = document.createElement("input");
    sndCb.type = "checkbox";
    sndCb.checked = S.config.dsh.doneSound !== false;
    /* 即时生效：勾 / 取消立刻写盘，下一次任务收尾就按新档位响或不响 */
    sndCb.onchange = () => {
      S.config.dsh.doneSound = !!sndCb.checked;
      settingsSaved(0);
    };
    sndRow.appendChild(sndCb);
    sndRow.appendChild(document.createTextNode(I18n.t("任务完成音效")));
    /* 括注（什么时候响、响几声）挂勾选项文字本身：悬停即出 */
    settingsTipBeside(
      sndRow,
      "任务完成音效（任何一件任务跑完 → 一声短促的「叮咚」；全部完成也是同一声，不再额外响一次）",
      "完成音效说明",
    );
    sec.appendChild(sndRow);
    dshEls.doneSound = sndCb;
    /* 完成音效音量（本次需求）：滑杆只调这一档响度 —— 任务完成与「全部完成」同一把尺，
        没有「收尾那一声再乘 1.5」的档；自定义音频文件同理（<audio> 音量固定 0.5）。
        拖动时轻轻试听一声音量实况；即时写盘，无保存按钮。 */
    const sndVolRow = document.createElement("div");
    sndVolRow.className = "dsh-btn-row";
    const sndVol = document.createElement("input");
    sndVol.type = "range";
    sndVol.min = "0";
    sndVol.max = "100";
    sndVol.step = "5";
    /* 滑杆初值：与 app-db.js 的 doneSoundVolumePct 同一口径就地算一遍（设置面板要能在
       最小 DOM 影子 / 单测沙箱里独立跑，不依赖运行时全局函数） */
    const doneVolNow = (function () {
      const n = Number(S.config.dsh.doneSoundVolume);
      if (!isFinite(n) || n <= 0) return n === 0 ? 0 : 35;
      return Math.max(0, Math.min(100, n));
    })();
    sndVol.value = String(doneVolNow);
    sndVol.style.flex = "1";
    /* 音量口径（只有这一档 / 0 = 静音）挂在右侧百分比读数上：悬停「35%」即出，不再有「?」，
       原生 title 也不挂（两套提示会打架） */
    const sndVolLabel = document.createElement("span");
    sndVolLabel.style.minWidth = "42px";
    sndVolLabel.style.textAlign = "right";
    sndVolLabel.textContent = sndVol.value + "%";
    settingsTip(
      sndVolLabel,
      "完成音效音量（只有一个音量档；0 = 静音）",
      "完成音效音量说明",
    );
    /* 拖动时逐格试听会叠成一串：只在最后一格（180ms 静默）与松手各响一次 */
    let volPreviewTimer = null;
    const volPreview = () => {
      if (volPreviewTimer) clearTimeout(volPreviewTimer);
      volPreviewTimer = setTimeout(() => {
        volPreviewTimer = null;
        try {
          previewDoneSoundVolume();
        } catch (_) {}
      }, 180);
    };
    sndVol.oninput = () => {
      S.config.dsh.doneSoundVolume = Number(sndVol.value) || 0;
      sndVolLabel.textContent = sndVol.value + "%";
      volPreview();
    };
    /* 松手即落盘（拖动中的 oninput 只改内存值，避免每格一次写盘） */
    sndVol.onchange = () => {
      S.config.dsh.doneSoundVolume = Number(sndVol.value) || 0;
      settingsSaved(0);
      volPreview();
    };
    sndVolRow.appendChild(sndVol);
    sndVolRow.appendChild(sndVolLabel);
    sec.appendChild(sndVolRow);
    dshEls.doneSoundVolume = sndVol;
    const sndFileRow = document.createElement("div");
    sndFileRow.className = "dsh-btn-row";
    const sndFile = document.createElement("input");
    sndFile.type = "text";
    sndFile.value = S.config.dsh.doneSoundFile || "";
    sndFile.style.flex = "1";
    sndFile.readOnly = true;
    /* 音效文件路径：选完 / 清除就立刻写回 S.config 并落盘（本窗不再有「保存」按钮） */
    const setSoundFile = (el, key) => {
      S.config.dsh[key] = String(el.value || "").trim();
      settingsSaved(0);
    };
    const sndPick = document.createElement("button");
    sndPick.className = "mini";
    sndPick.textContent = I18n.t("替换…");
    sndPick.onclick = async () => {
      const r = await window.api.fileOpenDialog({
        title: I18n.t("选择完成音效"),
        filters: [{ name: I18n.t("音频"), extensions: ["mp3", "wav", "ogg", "m4a"] }],
      });
      if (r && r.path) {
        sndFile.value = r.path;
        setSoundFile(sndFile, "doneSoundFile");
      }
    };
    const sndPlay = document.createElement("button");
    sndPlay.className = "mini";
    sndPlay.textContent = I18n.t("试听");
    /* 试听就是任务跑完那一刻真实的那一声（没有「收尾更响」的另一档） */
    sndPlay.onclick = () =>
      previewDoneSound(
        sndFile.value.trim() || (S.config.dsh && S.config.dsh.doneSoundFile) || "",
      );
    const sndClear = document.createElement("button");
    sndClear.className = "mini";
    sndClear.textContent = I18n.t("清除");
    sndClear.onclick = () => { sndFile.value = ""; setSoundFile(sndFile, "doneSoundFile"); };
    sndFileRow.appendChild(sndFile);
    sndFileRow.appendChild(sndPick);
    sndFileRow.appendChild(sndPlay);
    sndFileRow.appendChild(sndClear);
    sec.appendChild(sndFileRow);
    dshEls.doneSoundFile = sndFile;

    /* 提问/审批提示音:模型请求等待回应时短促提示;可替换音频文件并试听 */
    const askRow = document.createElement("label");
    askRow.className = "n-field";
    askRow.style.flexDirection = "row";
    askRow.style.alignItems = "center";
    const askCb = document.createElement("input");
    askCb.type = "checkbox";
    askCb.checked = S.config.dsh.askSound !== false;
    /* 即时生效：勾 / 取消立刻写盘，下一次模型等待回应就按新档位提示 */
    askCb.onchange = () => {
      S.config.dsh.askSound = !!askCb.checked;
      settingsSaved(0);
    };
    askRow.appendChild(askCb);
    askRow.appendChild(document.createTextNode(I18n.t("提问/审批提示音")));
    settingsTipBeside(
      askRow,
      "提问/审批提示音（模型等待你回应时弹出并提示）",
      "提问提示音说明",
    );
    sec.appendChild(askRow);
    dshEls.askSound = askCb;
    const askFileRow = document.createElement("div");
    askFileRow.className = "dsh-btn-row";
    const askFile = document.createElement("input");
    askFile.type = "text";
    askFile.value = S.config.dsh.askSoundFile || "";
    askFile.style.flex = "1";
    askFile.readOnly = true;
    const askPick = document.createElement("button");
    askPick.className = "mini";
    askPick.textContent = I18n.t("替换…");
    askPick.onclick = async () => {
      const r = await window.api.fileOpenDialog({
        title: I18n.t("选择提示音"),
        filters: [{ name: I18n.t("音频"), extensions: ["mp3", "wav", "ogg", "m4a"] }],
      });
      if (r && r.path) {
        askFile.value = r.path;
        setSoundFile(askFile, "askSoundFile");
      }
    };
    const askPlay = document.createElement("button");
    askPlay.className = "mini";
    askPlay.textContent = I18n.t("试听");
    askPlay.onclick = () => {
      if (!playDoneSoundFile(askFile.value.trim() || (S.config.dsh && S.config.dsh.askSoundFile) || "")) builtinIxBeep();
    };
    const askClear = document.createElement("button");
    askClear.className = "mini";
    askClear.textContent = I18n.t("清除");
    askClear.onclick = () => {
      askFile.value = "";
      setSoundFile(askFile, "askSoundFile");
    };
    askFileRow.appendChild(askFile);
    askFileRow.appendChild(askPick);
    askFileRow.appendChild(askPlay);
    askFileRow.appendChild(askClear);
    sec.appendChild(askFileRow);
    dshEls.askSoundFile = askFile;

    /* 精简工具负载：本轮运行时干脆不注册「这次用不上」的可选工具（mtnode_app /
       mtnode_vision），每一次模型调用都少重发约 4.7K 字符的工具定义。默认关 =
       行为与此前逐字一致。画布智能节点另有一层裁剪（宿主本来就拒收画布工具，
       其定义一律不发），与本开关无关、始终生效。
       实测口径与取舍见 docs/codex-agent-benchmark.md「本轮落地：Token 开销」。 */
    const leanRow = document.createElement("label");
    leanRow.className = "n-field";
    leanRow.style.flexDirection = "row";
    leanRow.style.alignItems = "center";
    const leanCb = document.createElement("input");
    leanCb.type = "checkbox";
    leanCb.checked = S.config.dsh.leanToolPayload === true;
    leanRow.appendChild(leanCb);
    leanRow.appendChild(document.createTextNode(I18n.t("精简工具负载")));
    /* 括注（省什么、何时生效）挂勾选项文字本身：悬停即出 */
    settingsTipBeside(
      leanRow,
      "精简工具负载（不注册「应用操作 / 识图子代理」等可选工具，每步少发约 4.7K 字符；下一轮运行生效）",
      "精简工具负载说明",
    );
    sec.appendChild(leanRow);
    dshEls.leanToolPayload = leanCb;

    /* 开发者工具（默认开）：会话右栏的「运行轨迹」View（轨迹列表 + 工具调用可展开详情）
       与后续的 Inspect / CDP 面板。关掉 = 这些入口整体不出现，两个窗格回到只有对话的
       形态（不影响已有会话数据与运行）。消费方：renderer/app-trajectory.js 的 devOn()。 */
    const devRow = document.createElement("label");
    devRow.className = "n-field";
    devRow.style.flexDirection = "row";
    devRow.style.alignItems = "center";
    const devCb = document.createElement("input");
    devCb.type = "checkbox";
    devCb.checked = S.config.dsh.developerTools !== false;
    /* 即时生效：勾 / 取消立刻写盘，切回会话即可看到入口出现 / 消失 */
    devCb.onchange = () => {
      S.config.dsh.developerTools = !!devCb.checked;
      settingsSaved(0);
      try {
        if (window.MTNodeTrajectory && typeof window.MTNodeTrajectory.sync === "function") {
          window.MTNodeTrajectory.sync();
        }
      } catch {
        /* 面板还没建也不影响设置本身 */
      }
    };
    devRow.appendChild(devCb);
    devRow.appendChild(document.createTextNode(I18n.t("开发者工具")));
    settingsTipBeside(
      devRow,
      "开发者工具（会话右栏「运行轨迹」视图：逐步看思考 / 正文 / 工具调用，工具调用可展开详情）",
      "开发者工具说明",
    );
    sec.appendChild(devRow);
    dshEls.developerTools = devCb;

    /* 工作步骤展示（对齐上游 ChatPresentationPolicy 的四档）：**新会话的默认档位** ——
       简洁 / 标准 / 详细 / 完全展开。逐会话不再切档，而是在输入区「模式」菜单里用
       本次需求新收回来的「显示思考」开关单独隐藏 / 显示思考（存 st.showThink，
       布尔覆盖 showThink 那一位；档位本身仍决定思考与工具卡的默认展开口径）。
       本轮需求：**过程行折叠已撤掉** —— 工具与上下文注入段一律按时间线内联显示，
       四档只在「思考显不显示 / 思考与工具卡默认展不展开」上分档。
       消费方：renderer/app-assist.js 的 dshPolicyOfView / dshTranscriptViewGlobal。 */
    const tvRow = document.createElement("label");
    tvRow.className = "n-field";
    tvRow.style.flexDirection = "row";
    tvRow.style.alignItems = "center";
    tvRow.style.gap = "6px";
    const tvSel = document.createElement("select");
    for (const v of DSH_TRANSCRIPT_VIEWS) {
      const op = document.createElement("option");
      op.value = v;
      op.textContent = dshTranscriptViewLabel(v);
      if (v === dshTranscriptViewGlobal()) op.selected = true;
      tvSel.appendChild(op);
    }
    /* 即时生效：改完落盘，会话视图按新档位重绘（当下打开的那条会话若没单独覆盖就跟它走） */
    tvSel.onchange = () => {
      S.config.dsh.transcriptView = dshTranscriptViewNorm(tvSel.value) || DSH_TRANSCRIPT_DEFAULT;
      settingsSaved(0);
      try {
        if (typeof renderAgentSession === "function") renderAgentSession();
      } catch {
        /* 会话窗还没建也不影响设置本身 */
      }
    };
    tvRow.appendChild(tvSel);
    tvRow.appendChild(document.createTextNode(I18n.t("工作步骤展示")));
    settingsTipBeside(
      tvRow,
      "工作步骤展示（新会话默认档位：简洁 = 不显示思考 / 标准 / 详细 / 完全展开 = 思考与工具卡都默认摊开；工具调用一律按时间线内联、不收纳；每会话还可在输入区「模式」菜单里用「显示思考」开关单独隐藏 / 显示思考）",
      "工作步骤展示说明",
    );
    sec.appendChild(tvRow);
    dshEls.transcriptView = tvSel;
    /* 即时生效：开关只影响「下一次运行注册哪些工具」，改完立刻落盘即可 */
    leanCb.onchange = () => {
      S.config.dsh.leanToolPayload = !!leanCb.checked;
      settingsSaved(0);
    };

    /* ── 扩展能力（DSH 插件 / 技能 Skills / MCP 服务器）：设置里只留一个整合界面，
       真正的清单与增删改全部收进「管理」对话框（样式统一沿用 DSH 插件那套卡片）。── */
    const extTitle = document.createElement("div");
    extTitle.className = "settings-sec-title settings-sec-title-row";
    extTitle.style.marginTop = "8px";
    const extTitleSpan = document.createElement("span");
    extTitleSpan.textContent = I18n.t(
      "扩展能力（DSH 插件 · 技能 Skills · MCP 服务器）",
    );
    extTitle.appendChild(extTitleSpan);
    const extTitleBtns = document.createElement("div");
    extTitleBtns.className = "dsh-btn-row";
    const extBrowseBtn = document.createElement("button");
    extBrowseBtn.className = "mini";
    extBrowseBtn.textContent = I18n.t("🌐 在线浏览");
    extBrowseBtn.title = I18n.t(
      "在线浏览:线上目录(插件 / 技能 / MCP),可安装与卸载",
    );
    extBrowseBtn.onclick = () => {
      closeExtManagerDialog();
      openStoreDialog();
    };
    extTitleBtns.appendChild(extBrowseBtn);
    extTitle.appendChild(extTitleBtns);
    sec.appendChild(extTitle);

    const extHintRow = document.createElement("div");
    extHintRow.className = "dsh-plugin-manage-row";
    const extHint = document.createElement("div");
    extHint.className = "dsh-plugin-empty";
    extHint.textContent = I18n.t("（读取中…）");
    const extManage = document.createElement("button");
    extManage.className = "mini primary";
    extManage.textContent = I18n.t("管理…");
    extManage.onclick = () => openExtManagerDialog("dsh");
    extHintRow.appendChild(extHint);
    extHintRow.appendChild(extManage);
    sec.appendChild(extHintRow);
    EXT_UI.hintEl = extHint;
    refreshExtInventory();

    body.appendChild(sec);
  }

  /* ── 语音输入（全局）：状态栏最左那枚话筒的行为设置 ──
     整块由 renderer/app-voice.js 自包含提供（window.VoiceInput.settingsSection），
     设置项与按钮右键快捷菜单共用同一份配置（S.config.voice），这里只负责放进设置正文。
     缺模块（老 preload / 未加载）时整块不出现，不报错。 */
  {
    try {
      if (typeof window !== "undefined" && window.VoiceInput && typeof window.VoiceInput.settingsSection === "function") {
        const voiceSec = window.VoiceInput.settingsSection();
        if (voiceSec) body.appendChild(voiceSec);
      }
    } catch (err) {
      console.warn("[settings] 语音输入小节挂载失败：", err);
    }
  }

  /* 很少用的小节沉底：配置数据目录 → 画布备份 → 网络 → 错误与崩溃日志 */
  for (const k of tailOrder) {
    if (tailSecs[k]) body.appendChild(tailSecs[k]);
  }

  /* ── 手动更新（设置最底部，整页最后一项）──
     正常更新只在线上版本号比本机新时才可用；极小更新 / 测试包常常是同一个版本号，
     版本比较这一步会把它们整条挡掉。这里给一条手动通道：不比对版本号，直接用当前
     更新源里那份包重装一遍 —— 下载（差分包）→ 后台静默安装 → 装完自动重开，
     与正常更新完全同一条链（主进程 updater.js 的 update:reinstallSame）。 */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("手动更新（同版本号重装）");
    settingsTipBeside(
      secTitle,
      "普通更新只在线上版本号更高时才可用。这里不比对版本号：直接用更新源里那份安装包重装一遍，适合极小更新与测试。下载与静默安装过程与正常更新完全一致，安装时应用会短暂重启。",
      "手动更新说明",
    );
    sec.appendChild(secTitle);

    const verEl = document.createElement("div");
    verEl.className = "n-field";
    verEl.style.fontSize = "12px";
    verEl.style.opacity = "0.9";
    verEl.textContent = I18n.t("当前版本：v") + (S.appVersion || "");
    sec.appendChild(verEl);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    const reBtn = document.createElement("button");
    reBtn.className = "mini";
    reBtn.textContent = I18n.t("立即手动更新（重装更新源那份包）");
    reBtn.title = I18n.t(
      "不比对版本号，直接用更新源里那份包重装一次（极小更新与测试用）",
    );    reBtn.onclick = async () => {
      if (!window.api || !window.api.updateReinstallSame) {
        toast(I18n.t("当前版本不支持手动更新"), "err");
        return;
      }
      const ver = S.appVersion || "";
      const yes = await confirmDialog(
        I18n.t("确定手动更新？") +
          "\n" +
          I18n.t(
            "将不比对版本号，直接用更新源里那份安装包重装一次（可能是同一个版本号 v",
          ) +
          ver +
          I18n.t(
            "）。下载完成后会在后台静默安装并自动重新打开应用；期间请先保存当前工作。",
          ),
        { title: I18n.t("手动更新"), okText: I18n.t("开始更新") },
      );
      if (!yes) return;
      reBtn.disabled = true;
      const old = reBtn.textContent;
      reBtn.textContent = I18n.t("正在检查并下载…");
      try {
        const r = await window.api.updateReinstallSame();
        if (r && r.store) {
          toast(
            I18n.t(
              "Microsoft Store（MSIX）版不支持应用内更新，请在 Microsoft Store 中获取更新",
            ),
            "ok",
          );
          return;
        }
        if (r && r.ok === false) {
          toast(I18n.t("更新失败：") + (r.error || I18n.t("未知错误")), "err");
          return;
        }
        if (r && r.downloading) {
          toast(I18n.t("开始下载更新（差分包）…"), "ok");
          return;
        }
        if (r && r.readyToRestart) {
          toast(I18n.t("更新已下载完毕：将后台静默安装，完成后自动重新打开应用"), "ok");
          return;
        }
        toast(I18n.t("已开始手动更新，将后台静默安装"), "ok");
      } catch (e) {
        toast(I18n.t("更新失败：") + ((e && e.message) || String(e)), "err");
      } finally {
        reBtn.disabled = false;
        reBtn.textContent = old;
      }
    };
    btnRow.appendChild(reBtn);
    sec.appendChild(btnRow);
    /* 手动更新是偶尔用一次的入口：放在设置整页最底部（其余沉底小节之后） */
    body.appendChild(sec);
  }

  dshEls.collect = () => ({
    /* 提供商 / 模型 / 思考强度 = 设置最上方那块「默认模型」（本次需求）。
       格子里拿不到值（无可用服务商 / 老窗没挂上那块）时保留现值，绝不用空串覆盖用户已存的选择。 */
    provider: dshEls.provider
      ? String(dshEls.provider.value || "").trim() ||
        String((S.config.dsh && S.config.dsh.provider) || "")
      : String((S.config.dsh && S.config.dsh.provider) || ""),
    model: dshEls.model
      ? dshEls.model.value.trim() ||
        String((S.config.dsh && S.config.dsh.model) || "")
      : String((S.config.dsh && S.config.dsh.model) || ""),
    effort: dshEls.effort
      ? normalizeAgentEffort(dshEls.effort.value)
      : dshDefaultEffortValue(),
    preset: dshEls.preset
      ? dshEls.preset.value
      : String((S.config.dsh && S.config.dsh.preset) || AGENT_PRESET_DEFAULT),
    chatEnter: enterSelEl ? enterSelEl.value : "send",
    permissionPreset: dshEls.permissionPreset.value,
    doneSound: dshEls.doneSound.checked,
    doneSoundFile: dshEls.doneSoundFile ? dshEls.doneSoundFile.value.trim() : (S.config.dsh && S.config.dsh.doneSoundFile) || "",
    /* 完成音效音量（本次需求）：以滑杆那一刻为准；滑杆不在场（老窗）时保留现值 */
    doneSoundVolume: dshEls.doneSoundVolume
      ? Number(dshEls.doneSoundVolume.value) || 0
      : (function () {
          const n = Number(S.config.dsh && S.config.dsh.doneSoundVolume);
          if (!isFinite(n) || n <= 0) return n === 0 ? 0 : 35;
          return Math.max(0, Math.min(100, n));
        })(),
    askSound: dshEls.askSound ? dshEls.askSound.checked : (S.config.dsh && S.config.dsh.askSound) !== false,
    askSoundFile: dshEls.askSoundFile ? dshEls.askSoundFile.value.trim() : (S.config.dsh && S.config.dsh.askSoundFile) || "",
    leanToolPayload: dshEls.leanToolPayload
      ? !!dshEls.leanToolPayload.checked
      : !!(S.config.dsh && S.config.dsh.leanToolPayload),
    /* 开发者工具（默认开）：关窗那一刻以勾选框为准；勾选框不在场（老窗）时保留现值 */
    developerTools: dshEls.developerTools
      ? !!dshEls.developerTools.checked
      : (S.config.dsh && S.config.dsh.developerTools) !== false,
    /* 工作步骤展示档位（本次需求）：以选择框那一刻为准；选择框不在场（老窗）时保留现值 */
    transcriptView: dshEls.transcriptView
      ? dshTranscriptViewNorm(dshEls.transcriptView.value) || DSH_TRANSCRIPT_DEFAULT
      : dshTranscriptViewGlobal(),
    theme: themeSelEl ? themeSelEl.value : (S.config.dsh && S.config.dsh.theme) || "industrial",
  });

  /* 提供商配置（模型服务）已挪到函数开头（设置项最前面），这里不再重复渲染 */

  const foot = $("#ovFoot");
  /* ── 本窗没有「保存并关闭」：上面每一项都即时生效，这里只剩最后一次收口 + 关窗 ──
     收口只做两件平时不适合做的事：① 服务商字段去首尾空白并丢掉空名项（平时打字
     中途清空名称不该让整格服务商凭空消失）；② 把 dsh 各字段与默认档合并一遍，
     保证老存档里缺的键在写盘后补齐。 */
  const finalizeSettings = () => {
    for (const p of S.config.providers) {
      p.name = String(p.name || "").trim();
      p.baseUrl = String(p.baseUrl || "").trim();
      p.apiKey = String(p.apiKey || "").trim();
      if (Array.isArray(p.models)) {
        p.models = p.models.map((m) => String(m || "").trim()).filter(Boolean);
      } else {
        p.models = String(p.models || "")
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
      }
    }
    S.config.providers = S.config.providers.filter((p) => p.name);
    S.config.dsh = Object.assign(
      {
        enabled: true,
        nodePath: "",
        /* 设置最上方那块「默认模型」：provider / model / effort（本次需求） */
        provider: "",
        model: "",
        effort: "high",
        preset: AGENT_PRESET_DEFAULT,
        chatEnter: "send",
        permissionPreset: "mtnode-unattended",
        doneSound: true,
        doneSoundVolume: 35,
        askSound: true,
        developerTools: true,
        transcriptView: "standard",
        theme: "industrial",
      },
      S.config.dsh || {},
      dshEls.collect(),
    );
    /* 空名服务商可能在关窗这一刻才被丢掉：把网格里显的回刷成真实列表 */
    repaintSettingsProvTiles();
  };
  const closeBtn = document.createElement("button");
  closeBtn.className = "mini primary";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.title = I18n.t("改动已即时生效，关窗前自动补一次写盘");
  closeBtn.onclick = async () => {
    finalizeSettings();
    settingsSaveStampEl = null; // 状态行随窗作废
    await settingsSaveNow();
    closeOverlay();
    /* 关窗之后再重绘（与旧「保存设置」同一顺序）：画布上的全局端口 / 网格间距 /
       节点「?」按钮 / 顶栏档位字样一律以最终值为准刷一遍 */
    renderCanvas();
    renderStatus();
    paintApprovalsBtn();
  };
  const storageBtn = document.createElement("button");
  storageBtn.className = "mini";
  storageBtn.textContent = I18n.t("打开存档位置");
  storageBtn.title = I18n.t("打开画布保存的文件夹");
  storageBtn.onclick = async () => {
    const r = await window.api.storageOpen();
    if (!r || !r.ok)
      toast(
        I18n.t("无法打开存档位置：") + (r && r.error ? r.error : I18n.t("未知错误")),
        "err",
      );
  };
  const helpBtn = document.createElement("button");
  helpBtn.className = "mini";
  helpBtn.textContent = I18n.t("查看说明");
  helpBtn.title = I18n.t("打开使用说明");
  helpBtn.onclick = openHelp;
  /* 底部状态行：告诉用户「这一页不需要保存」，并在每次写盘后回显时间戳 */
  const stamp = document.createElement("span");
  stamp.className = "settings-save-stamp";
  stamp.textContent = I18n.t("改动即时生效");
  settingsSaveStampEl = stamp;
  foot.appendChild(storageBtn);
  foot.appendChild(helpBtn);
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  foot.appendChild(spacer);
  foot.appendChild(stamp);
  foot.appendChild(closeBtn);

  /* 请求过的落点（顶栏红色警示 → 「配置数据目录」；顶栏「性能」面板 → 「存储占用与清理」）：
     整页挂完后再滚，只消费一次。小节是沉底的，不滚的话用户进来只看到最上面的提供商配置。 */
  const focusId =
    settingsFocusSection === "data"
      ? "setDataRootSec"
      : settingsFocusSection === "storage"
        ? "setStorageSec"
        : "";
  if (focusId) {
    settingsFocusSection = "";
    const tgt = $("#" + focusId);
    if (tgt) {
      try {
        tgt.scrollIntoView({ block: "center", behavior: "auto" });
      } catch (_) {
        try { tgt.scrollIntoView(); } catch (_) {}
      }
    }
  } else if (settingsFocusSection) {
    settingsFocusSection = "";
  }
}

/* 目录中可添加的服务商(与 dsh 一致的全部内置服务商):
   每个服务商取其首选 api(优先 openai-completions,否则首个 api),
   baseUrl 取自同 api 的首个模型,模型列表 = 该 api 的模型。 */
function catalogAddableProviders() {
  const out = [];
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  const official = c.deepseek || [];
  if (official.length)
    out.push({
      id: "deepseek-official",
      name: I18n.t("DeepSeek 官方"),
      api: "openai-completions",
      baseUrl: (official[0] && official[0].baseUrl) || "https://api.deepseek.com",
      models: official,
    });
  for (const p of c.piai || []) {
    const models = p.models || [];
    if (!models.length) continue;
    let api = "";
    for (const m of models) {
      if (m.api === "openai-completions") {
        api = m.api;
        break;
      }
    }
    if (!api) api = models[0].api || "openai-completions";
    const same = models.filter((m) => (m.api || "openai-completions") === api);
    const first = same[0];
    out.push({
      id: p.id,
      name: p.id,
      api,
      baseUrl: (first && first.baseUrl) || "",
      models: same,
    });
  }
  return out;
}

/* 粘贴导入:把剪贴板 / 粘贴的配置文字解析为服务商字段
   (名称 / 接口地址 / API Key / 模型 / 类型)。按优先级尝试三种格式:
   1) JSON 对象(含 name/baseUrl/apiKey/models 等字段,models 可为数组或逗号分隔字符串)
   2) 逐行「字段名: 值」或「字段名=值」(中英文键名均可;模型可多行,值可逗号/分号分隔)
   3) 纯逐行位置:第1行=名称,第2行=接口地址,第3行=API Key,其余行=模型(每行可再拆分) */
function parseProviderText(text) {
  const t = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!t) return { ok: false, error: I18n.t("粘贴内容为空") };
  const clean = (v) =>
    String(v == null ? "" : v)
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
  const normKey = (k) =>
    String(k || "").trim().toLowerCase().replace(/[\s_-]+/g, "").replace(/[：:]/g, "");
  const splitModels = (val) => {
    const out = [];
    for (const id of String(val).split(/[,，;；\n]+/)) {
      const x = clean(id);
      if (x) out.push(x);
    }
    return out;
  };

  /* 1) JSON */
  if (t[0] === "{" || t[0] === "[") {
    try {
      const obj = JSON.parse(t);
      const src = Array.isArray(obj) ? obj[0] : obj;
      if (src && typeof src === "object") {
        const data = {
          name: clean(src.name || src.title || src.provider || src.providerName),
          baseUrl: clean(
            src.baseUrl || src.base_url || src.url || src.endpoint || src.apiBase || src.api_base,
          ),
          apiKey: clean(
            src.apiKey || src.api_key || src.key || src.token || src.secret || src.secretKey,
          ),
          type: clean(src.type || src.api || src.kind),
          models: [],
        };
        if (Array.isArray(src.models)) {
          for (const m of src.models) {
            const id = clean(m && typeof m === "object" ? m.id || m.model || m.name : m);
            if (id) data.models.push(id);
          }
        } else if (typeof src.models === "string") {
          data.models = splitModels(src.models);
        }
        if (data.name || data.baseUrl || data.apiKey || data.type || data.models.length)
          return { ok: true, data };
      }
    } catch {}
    return { ok: false, error: I18n.t("JSON 解析失败：请确认内容为有效的 JSON 配置") };
  }

  /* 2) 逐行「字段名: 值」/「字段名=值」(中英文键名) */
  const KEY_MAP = [
    [
      "name",
      ["name", "title", "provider", "providername", "服务商名称", "服务商", "供应商", "名称", "名字"],
    ],
    [
      "baseUrl",
      [
        "baseurl",
        "baseurl地址",
        "base_url",
        "api_base",
        "apibase",
        "url",
        "接口地址",
        "接口",
        "地址",
        "endpoint",
        "api地址",
        "服务器地址",
      ],
    ],
    [
      "apiKey",
      ["apikey", "api_key", "api-key", "api密钥", "api key", "key", "密钥", "token", "secret", "sk", "授权码", "authorization"],
    ],
    ["models", ["models", "model", "模型列表", "模型id", "模型", "modelslist", "modelids"]],
    ["type", ["type", "类型", "api类型", "apitype", "kind", "api"]],
  ];
  const data = { name: "", baseUrl: "", apiKey: "", type: "", models: [] };
  let labeledHits = 0;
  const extra = [];
  const lines = t.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-*•·#>\d.)、\s]+/, "");
    if (!line) continue;
    const m = line.match(/^([^=:：]+?)\s*[:=：]\s*(.*)$/);
    if (!m) {
      extra.push(line);
      continue;
    }
    const key = normKey(m[1]);
    const val = clean(m[2]);
    if (!key || !val) continue;
    let field = null;
    for (const [f, keys] of KEY_MAP) {
      if (keys.some((k) => normKey(k) === key)) {
        field = f;
        break;
      }
    }
    if (!field) continue;
    labeledHits++;
    if (field === "models") data.models = data.models.concat(splitModels(val));
    else if (!data[field]) data[field] = val;
  }
  if (labeledHits) {
    /* 无分隔符的整行并入模型(如「模型:」后另起一行的模型名);
       跳过疑似 Key / URL,避免把密钥误当模型 */
    for (const e of extra) {
      const x = clean(e);
      if (!x) continue;
      if (/^https?:\/\//i.test(x)) continue;
      if (/^sk[-_]?[a-z0-9]/i.test(x)) continue;
      if (!data.models.includes(x)) data.models.push(x);
    }
    return { ok: true, data };
  }

  /* 3) 纯逐行位置 */
  const pos = lines.map(clean).filter(Boolean);
  if (pos.length >= 2) {
    data.name = pos[0];
    data.baseUrl = pos[1];
    if (pos[2] && !/^https?:\/\//i.test(pos[2])) data.apiKey = pos[2];
    for (let i = 3; i < pos.length; i++) data.models = data.models.concat(splitModels(pos[i]));
    return { ok: true, data };
  }

  return {
    ok: false,
    error: I18n.t(
      "未能识别配置：请使用「字段名: 值」逐行、JSON 或「名称/接口地址/API Key/模型」顺序粘贴",
    ),
  };
}

/* 把粘贴 / JSON 里的类型写法归一为设置页类型值(text_openai 等) */
function normalizeProviderType(t) {
  const v = String(t || "").trim().toLowerCase();
  if (!v) return "text_openai";
  if (v.includes("stability") || v === "image_stability") return "image_stability";
  if (v.includes("midjourney") || v === "image_mj" || v === "mj") return "image_mj";
  if (v.includes("图像") || v.includes("image") || v.includes("images/generations"))
    return "image_openai";
  return "text_openai";
}

/* 添加服务商:从目录选择(选服务商 → 输 Key → 自动载入模型列表)、粘贴导入或手动配置 */
function addProviderDialog() {
  openOverlay(I18n.t("添加服务商"));
  overlayPersistent = true;
  const body = $("#ovBody");
  const srcRow = document.createElement("label");
  srcRow.className = "n-field";
  srcRow.style.flexDirection = "row";
  srcRow.style.alignItems = "center";
  srcRow.appendChild(document.createTextNode(I18n.t("来源：")));
  const srcSel = document.createElement("select");
  {
    const o1 = document.createElement("option");
    o1.value = "catalog";
    o1.textContent = I18n.t("从服务商目录选择（推荐）");
    const o2 = document.createElement("option");
    o2.value = "manual";
    o2.textContent = I18n.t("手动配置");
    srcSel.appendChild(o1);
    srcSel.appendChild(o2);
    const o3 = document.createElement("option");
    o3.value = "paste";
    o3.textContent = I18n.t("粘贴导入（一键解析）");
    srcSel.appendChild(o3);
  }
  srcRow.appendChild(srcSel);
  body.appendChild(srcRow);

  /* 目录模式容器 */
  const catBox = document.createElement("div");
  catBox.className = "store-form";
  const provRow = document.createElement("label");
  provRow.className = "n-field";
  provRow.appendChild(document.createTextNode(I18n.t("服务商")));
  const provSel = document.createElement("select");
  const provOpt = document.createElement("option");
  provOpt.value = "";
  provOpt.textContent = I18n.t("（读取目录中…）");
  provSel.appendChild(provOpt);
  provSel.disabled = true;
  provRow.appendChild(provSel);
  /* 「选择服务商后自动载入模型列表与接口地址」这条口径挂在标签本身（悬停即出） */
  settingsTipBeside(
    provRow,
    "选择服务商后自动载入其模型列表与接口地址。",
    "服务商说明",
  );
  catBox.appendChild(provRow);
  const nameRow = document.createElement("label");
  nameRow.className = "n-field";
  nameRow.appendChild(document.createTextNode(I18n.t("名称")));
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameRow.appendChild(nameInp);
  catBox.appendChild(nameRow);
  const keyRow = document.createElement("label");
  keyRow.className = "n-field";
  keyRow.appendChild(document.createTextNode("API Key"));
  const keyWrap = document.createElement("div");
  keyWrap.style.display = "flex";
  keyWrap.style.gap = "4px";
  const keyInp = document.createElement("input");
  keyInp.type = "password";
  keyInp.placeholder = I18n.t("输入 API Key（隐藏显示，仅存本机）");
  keyInp.style.flex = "1";
  const keyTest = document.createElement("button");
  keyTest.type = "button";
  keyTest.className = "mini";
  keyTest.textContent = I18n.t("验证");
  keyTest.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
  keyTest.onclick = async (ev) => {
    ev.preventDefault();
    const p = catalogAddableProviders().find((x) => x.id === provSel.value);
    await validateProviderApiKey(
      {
        type: "text_openai",
        baseUrl: (p && p.baseUrl) || "",
        apiKey: keyInp.value,
      },
      keyTest,
    );
  };
  keyWrap.appendChild(keyInp);
  keyWrap.appendChild(keyTest);
  keyRow.appendChild(keyWrap);
  catBox.appendChild(keyRow);
  body.appendChild(catBox);

  /* 手动模式容器 */
  const manBox = document.createElement("div");
  manBox.className = "store-form";
  manBox.style.display = "none";
  const mName = document.createElement("label");
  mName.className = "n-field";
  mName.appendChild(document.createTextNode(I18n.t("名称")));
  const mNameInp = document.createElement("input");
  mNameInp.type = "text";
  mName.appendChild(mNameInp);
  manBox.appendChild(mName);
  const mType = document.createElement("label");
  mType.className = "n-field";
  mType.appendChild(document.createTextNode(I18n.t("类型")));
  const mTypeSel = document.createElement("select");
  for (const [v, l] of PROVIDER_TYPE_LABELS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(l);
    mTypeSel.appendChild(o);
  }
  mType.appendChild(mTypeSel);
  manBox.appendChild(mType);
  const mUrl = document.createElement("label");
  mUrl.className = "n-field";
  mUrl.appendChild(document.createTextNode(I18n.t("接口地址 Base URL")));
  const mUrlInp = document.createElement("input");
  mUrlInp.type = "text";
  mUrl.appendChild(mUrlInp);
  manBox.appendChild(mUrl);
  const mKey = document.createElement("label");
  mKey.className = "n-field";
  mKey.appendChild(document.createTextNode(I18n.t("API Key（隐藏显示）")));
  const mKeyWrap = document.createElement("div");
  mKeyWrap.style.display = "flex";
  mKeyWrap.style.gap = "4px";
  const mKeyInp = document.createElement("input");
  mKeyInp.type = "password";
  mKeyInp.style.flex = "1";
  const mKeyTest = document.createElement("button");
  mKeyTest.type = "button";
  mKeyTest.className = "mini";
  mKeyTest.textContent = I18n.t("验证");
  mKeyTest.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
  mKeyTest.onclick = async (ev) => {
    ev.preventDefault();
    await validateProviderApiKey(
      {
        type: mTypeSel.value,
        baseUrl: mUrlInp.value,
        apiKey: mKeyInp.value,
      },
      mKeyTest,
    );
  };
  mKeyWrap.appendChild(mKeyInp);
  mKeyWrap.appendChild(mKeyTest);
  mKey.appendChild(mKeyWrap);
  manBox.appendChild(mKey);
  const mModels = document.createElement("label");
  mModels.className = "n-field";
  mModels.appendChild(document.createTextNode(I18n.t("模型（逗号分隔）")));
  const mModelsInp = document.createElement("input");
  mModelsInp.type = "text";
  mModels.appendChild(mModelsInp);
  manBox.appendChild(mModels);
  body.appendChild(manBox);

  /* 粘贴导入容器 */
  const pasteBox = document.createElement("div");
  pasteBox.className = "store-form";
  pasteBox.style.display = "none";
  /* 说明不再平铺：给它一个字段标签，口径挂在该标签上（悬停即出） */
  const pasteLabel = document.createElement("div");
  pasteLabel.className = "n-field";
  pasteLabel.style.flexDirection = "row";
  pasteLabel.style.alignItems = "center";
  pasteLabel.style.gap = "0";
  pasteLabel.appendChild(document.createTextNode(I18n.t("粘贴导入（一键解析）")));
  settingsTipBeside(
    pasteLabel,
    "把服务商配置文字粘贴到下方（支持「字段名: 值」逐行、JSON，或按 名称/接口地址/API Key/模型 顺序逐行），点「解析并填入」自动识别。",
    "粘贴导入说明",
  );
  pasteBox.appendChild(pasteLabel);
  const pasteInp = document.createElement("textarea");
  pasteInp.rows = 8;
  pasteInp.placeholder =
    "名称: SiliconFlow\n接口地址: https://api.siliconflow.cn/v1\nAPI Key: sk-xxxx\n模型: deepseek-ai/DeepSeek-V3, Qwen/Qwen2.5-7B-Instruct";
  pasteInp.style.cssText =
    "width:100%; box-sizing:border-box; font-family:monospace; margin-top:8px;";
  pasteBox.appendChild(pasteInp);
  const pasteBtns = document.createElement("div");
  pasteBtns.style.cssText = "display:flex; gap:8px; margin-top:8px;";
  const pasteClip = document.createElement("button");
  pasteClip.type = "button";
  pasteClip.className = "mini";
  pasteClip.textContent = I18n.t("读取剪贴板");
  pasteClip.title = I18n.t("从系统剪贴板读取文字并解析");
  pasteClip.onclick = async (ev) => {
    ev.preventDefault();
    let txt = "";
    try {
      if (window.api && window.api.clipboardReadText) txt = await window.api.clipboardReadText();
    } catch {}
    if (!txt || !txt.trim()) {
      toast(I18n.t("剪贴板为空：请先复制配置文字再点此按钮"), "warn");
      return;
    }
    pasteInp.value = txt;
    doParsePaste();
  };
  const pasteGo = document.createElement("button");
  pasteGo.type = "button";
  pasteGo.className = "mini primary";
  pasteGo.textContent = I18n.t("解析并填入");
  pasteGo.title = I18n.t("按行解析并填入下方表单，可再核对修改");
  pasteGo.onclick = (ev) => {
    ev.preventDefault();
    doParsePaste();
  };
  pasteBtns.appendChild(pasteClip);
  pasteBtns.appendChild(pasteGo);
  pasteBox.appendChild(pasteBtns);
  body.appendChild(pasteBox);

  /* 解析成功 → 填入手动表单并切到手动模式,用户核对后点「添加」 */
  const doParsePaste = () => {
    const r = parseProviderText(pasteInp.value);
    if (!r.ok) {
      toast(r.error, "warn");
      return;
    }
    const d = r.data;
    if (d.name) mNameInp.value = d.name;
    if (d.baseUrl) mUrlInp.value = d.baseUrl;
    if (d.apiKey) mKeyInp.value = d.apiKey;
    if (Array.isArray(d.models) && d.models.length) mModelsInp.value = d.models.join(", ");
    const t = normalizeProviderType(d.type);
    if (PROVIDER_TYPE_LABELS.some(([v]) => v === t)) mTypeSel.value = t;
    srcSel.value = "manual";
    catBox.style.display = "none";
    manBox.style.display = "";
    pasteBox.style.display = "none";
    const parts = [];
    if (d.name) parts.push(I18n.t("名称 ") + d.name);
    if (d.baseUrl) parts.push(I18n.t("接口 ") + d.baseUrl);
    if (d.apiKey) parts.push(I18n.t("API Key 已填入"));
    if (d.models.length) parts.push(d.models.length + I18n.t(" 个模型"));
    toast(I18n.t("已解析并填入（请核对后点「添加」）：") + parts.join(" · "), "ok");
  };

  srcSel.addEventListener("change", () => {
    /* 三种模式各自只显示自己那一块：手动配置 = 自定义服务商，
       上方的「服务商目录」下拉（及名称 / API Key 那两个目录专用输入）一块都不该留。 */
    catBox.style.display = srcSel.value === "catalog" ? "" : "none";
    manBox.style.display = srcSel.value === "manual" ? "" : "none";
    pasteBox.style.display = srcSel.value === "paste" ? "" : "none";
  });

  const renderCatalog = () => {
    const provs = catalogAddableProviders();
    provSel.innerHTML = "";
    if (!provs.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = I18n.t("目录暂不可用（引擎未连接）");
      provSel.appendChild(o);
      provSel.disabled = true;
      return;
    }
    provSel.disabled = false;
    const og1 = document.createElement("optgroup");
    og1.label = I18n.t("DeepSeek 官方");
    const og2 = document.createElement("optgroup");
    og2.label = I18n.t("pi-ai 目录");
    for (const p of provs) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent =
        p.name +
        " · " +
        p.api +
        "（" +
        p.models.length +
        I18n.t(" 个模型）");
      (p.id === "deepseek-official" ? og1 : og2).appendChild(o);
    }
    provSel.appendChild(og1);
    provSel.appendChild(og2);
    provSel.value = "deepseek-official";
    updateInfo();
  };
  const updateInfo = () => {
    const p = catalogAddableProviders().find((x) => x.id === provSel.value);
    nameInp.value = p ? p.name : "";
    if (!p) {
      infoRow.textContent = "";
      return;
    }
    /* 目录里同一服务商可能同时有文本模型与图像模型（如 openai 兼容网关）：
       保存时会按模型形态拆成「文本服务商 + 图像服务商」两条，各自类型正确，
       文本 / 图像节点才都选得到。 */
    const kinds = (p.models || []).map((m) => inferModelKind(m.id));
    const nImg = kinds.filter((k) => k === "image").length;
    const kindTxt =
      nImg && nImg < kinds.length
        ? I18n.t("（文本 + 图像混挂，保存时自动拆成两条服务商）")
        : nImg
          ? I18n.t("（图像模型）")
          : I18n.t("（文本模型）");
    infoRow.textContent =
      I18n.t("已载入 ") +
      p.models.length +
      I18n.t(" 个模型") +
      kindTxt +
      I18n.t(" · 接口地址 ") +
      (p.baseUrl || I18n.t("（待定）")) +
      I18n.t(" · API 类型 ") +
      p.api +
      I18n.t("。添加后自动生成模型列表。");
  };
  provSel.addEventListener("change", updateInfo);
  ensureProviderCatalog().then(renderCatalog).catch(renderCatalog);

  const foot = $("#ovFoot");
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "取消";
  /* 本对话框是从设置页的「＋ 添加服务商」进来的（#overlay 独一份，会把设置页顶掉）：
     取消要回到设置页，不能一关就把整个设置窗也带走 */
  cancel.onclick = () => {
    closeOverlay();
    openSettings();
  };
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = "添加";
  ok.onclick = () => {
    let prov = null;
    if (srcSel.value === "paste") {
      toast(I18n.t("请先粘贴配置文字并点「解析并填入」"), "warn");
      return;
    }
    if (srcSel.value === "catalog") {
      const p = catalogAddableProviders().find((x) => x.id === provSel.value);
      if (!p) {
        toast("请先选择服务商", "warn");
        return;
      }
      if (!keyInp.value.trim()) {
        toast("请填写 API Key", "warn");
        return;
      }
      /* 按模型形态拆分：目录里若混挂文本与图像模型，落成两条服务商
         （同名加「· 图像」后缀），各自的 type 与节点侧选择保持一致。 */
      const baseName = (nameInp.value || p.name).trim() || p.id;
      const all = p.models.map((m) => m.id);
      const textModels = all.filter((m) => inferModelKind(m) !== "image");
      const imageModels = all.filter((m) => inferModelKind(m) === "image");
      const mk = (models, type, name, source) => ({
        id: uid("p"),
        name,
        type,
        baseUrl: p.baseUrl || "",
        api: p.api || "openai-completions",
        source,
        apiKey: keyInp.value.trim(),
        models,
        vision: false,
      });
      const added = [];
      if (textModels.length)
        added.push(mk(textModels, providerTypeForKind("text_openai", "text"), baseName, p.id));
      if (imageModels.length)
        added.push(
          mk(
            imageModels,
            providerTypeForKind("text_openai", "image"),
            textModels.length ? baseName + " · " + I18n.t("图像") : baseName,
            /* 拆出第二条时 source 带后缀，避免下次导入被当成同一条合并 */
            textModels.length ? p.id + ":image" : p.id,
          ),
        );
      if (!added.length) added.push(mk(all, "text_openai", baseName, p.id));
      for (const a of added) S.config.providers.push(a);
      /* 即时生效：新服务商当场写盘，不依赖设置页的「保存」（该按钮已取消） */
      settingsSaved(0);
      closeOverlay();
      openSettings();
      toast(I18n.t("服务商已添加：") + added.map((a) => a.name).join(" / "), "ok");
      return;
    }
    {
      if (!mNameInp.value.trim()) {
        toast(I18n.t("请填写服务商名称"), "warn");
        return;
      }
      /* 自定义服务商没有目录兜底：接口地址必填，否则保存下来也建不出任何请求 */
      if (!mUrlInp.value.trim()) {
        toast(I18n.t("请填写接口地址 Base URL"), "warn");
        return;
      }
      prov = {
        id: uid("p"),
        name: mNameInp.value.trim(),
        type: mTypeSel.value,
        baseUrl: mUrlInp.value.trim(),
        apiKey: mKeyInp.value.trim(),
        models: mModelsInp.value.split(",").map((m) => m.trim()).filter(Boolean),
        vision: false,
      };
      /* 手动配置时用户可能把类型选错（最典型：OpenAI 兼容端点配了文本类型，
         模型却是 gpt-image-*）。类型与模型形态不符就按模型纠正，并说明原因。 */
      const k = defaultKindOfProvider(S.config, prov);
      const want = providerTypeForKind(prov.type, k);
      if (want !== prov.type) {
        prov.type = want;
        toast(
          I18n.t("按模型自动识别为") +
            I18n.t(k === "image" ? "图像服务商" : "文本服务商") +
            I18n.t("，类型已相应设置（可在列表里逐模型调整）"),
          "warn",
        );
      }
    }
    S.config.providers.push(prov);
    /* 即时生效：手动添加同样当场写盘 */
    settingsSaved(0);
    closeOverlay();
    openSettings();
    toast(I18n.t("服务商已添加：") + prov.name, "ok");
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

/* ── 在线浏览(插件 / 技能 / MCP):经主进程代取线上目录(国内可达镜像源);
   支持用户自添加 repo,以 tabs 切换 ── */
async function netJson(url) {
  const r = await window.api.netFetch(url);
  if (!r || r.ok === false) throw new Error((r && r.error) || I18n.t("网络请求失败"));
  return JSON.parse(r.text);
}
async function netText(url) {
  const r = await window.api.netFetch(url);
  if (!r || r.ok === false) throw new Error((r && r.error) || I18n.t("网络请求失败"));
  return r.text;
}

const MTNODE_EXT_CATALOG = "http://mt-agent.com/mtnode/ext/catalog.json";

/* 内置 repo(默认标签,不可移除;用户源可移除) */
const DEFAULT_REPOS = [
  {
    id: "mtnode-official",
    label: "MTNode 官方",
    kind: "catalog",
    url: MTNODE_EXT_CATALOG,
  },
  {
    id: "npmmirror-dsh",
    label: "插件",
    kind: "plugins",
    url: "https://registry.npmmirror.com/-/v1/search?text=%40deepseek-ai%2Fdsh&size=50",
  },
  {
    id: "jsdelivr-skills",
    label: "技能",
    kind: "skills",
    url: "https://data.jsdelivr.com/v1/package/gh/anthropics/skills@main",
    path: "skills",
  },
  {
    id: "jsdelivr-mcp",
    label: "MCP",
    kind: "mcp",
    url: "https://data.jsdelivr.com/v1/package/gh/modelcontextprotocol/servers@main",
    path: "src",
  },
];
function storeRepos() {
  const user = (S.config.onlineRepos || []).filter(
    (r) => r && r.label && r.url,
  );
  return DEFAULT_REPOS.concat(user);
}
function storeKindLabel(kind) {
  if (kind === "plugins") return I18n.t("插件");
  if (kind === "skills") return I18n.t("技能");
  if (kind === "mcp") return I18n.t("MCP 服务器");
  if (kind === "catalog") return I18n.t("目录");
  return "";
}
function storeRepoHint(repo) {
  const url = String(repo.url || "");
  const src =
    url.includes("/mtnode/ext/") || repo.kind === "catalog"
      ? I18n.t("MTNode 官方源")
      : url.includes("registry.npmmirror.com")
        ? I18n.t("npm 镜像 registry.npmmirror.com")
        : url.includes("jsdelivr")
          ? "jsDelivr CDN"
          : I18n.t("自定义源");
  return I18n.t("来源:") + src;
}
function storeCdnUrl(dataUrl) {
  return String(dataUrl || "").replace(
    "data.jsdelivr.com/v1/package/gh/",
    "cdn.jsdelivr.net/gh/",
  );
}
function storeResolveUrl(baseUrl, rel) {
  const r = String(rel || "").trim();
  if (!r) return "";
  if (/^https?:\/\//i.test(r) || /^github:/i.test(r)) return r;
  const base = String(baseUrl || "").replace(/\/catalog\.json$/i, "").replace(/\/$/, "");
  return base + "/" + r.replace(/^\.\//, "").replace(/^\/+/, "");
}
function isMtnodeExtCatalog(j) {
  return !!(
    j &&
    (j.format === "mtnode-ext-v1" ||
      ((Array.isArray(j.plugins) || Array.isArray(j.skills) || Array.isArray(j.mcp)) &&
        !Array.isArray(j.objects) &&
        !Array.isArray(j.files)))
  );
}
function storeItemsFromExtCatalog(j, repo) {
  const kinds =
    repo.kind === "catalog" || !repo.kind
      ? ["plugins", "skills", "mcp"]
      : [repo.kind];
  const out = [];
  for (const kind of kinds) {
    const arr = Array.isArray(j[kind]) ? j[kind] : [];
    for (const raw of arr) {
      if (!raw || !raw.id) continue;
      const pathRel =
        raw.path ||
        (kind === "skills" ? "skills/" + raw.id + "/SKILL.md" : "");
      out.push({
        id: raw.id,
        name: raw.name || raw.id,
        desc: raw.description || "",
        version: raw.version || "",
        /* 正文内容指纹（build.mjs 生成）：同版本号改了正文也能判出「有更新」 */
        sha256: String(raw.sha256 || ""),
        kind,
        install: storeResolveUrl(repo.url, raw.install || raw.tgz || ""),
        skillUrl: storeResolveUrl(repo.url, pathRel),
        transport: raw.transport || "stdio",
        command: raw.command || "npx.cmd",
        args: raw.args || "",
        mcpUrl: raw.url || "",
      });
    }
  }
  return out;
}
async function storeFetchItems(repo) {
  const j = await netJson(repo.url);
  if (isMtnodeExtCatalog(j) || repo.format === "mtnode-ext") {
    return storeItemsFromExtCatalog(j, repo);
  }
  if (repo.kind === "plugins") {
    return (j.objects || []).map((o) => ({
      id: o.package.name,
      name: o.package.name,
      desc: o.package.description || "",
      version: o.package.version,
      kind: "plugins",
    }));
  }
  /* skills / mcp:jsDelivr data 目录树 → 取子目录列表 */
  const files = Array.isArray(j.files) ? j.files : [];
  let dirs = files;
  if (repo.path) {
    const d = files.find((f) => f.name === repo.path && f.type === "directory");
    dirs = (d && d.files) || [];
  }
  return dirs
    .filter((f) => f.type === "directory")
    .map((f) => ({
      id: f.name,
      name: f.name,
      desc:
        repo.kind === "skills"
          ? I18n.t("技能（安装时从 CDN 拉取 SKILL.md）")
          : I18n.t("MCP 服务器（stdio，经 npx 运行）"),
      version: "",
      kind: repo.kind,
    }));
}

async function openStoreDialog() {
  openOverlay(I18n.t("在线浏览 · 插件 / 技能 / MCP"));
  overlayPersistent = true;
  const box = document.querySelector("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const body = $("#ovBody");
  const tabs = document.createElement("div");
  tabs.className = "store-tabs";
  body.appendChild(tabs);
  const manageRow = document.createElement("div");
  manageRow.className = "dsh-btn-row";
  manageRow.style.marginTop = "6px";
  const addSrcBtn = document.createElement("button");
  addSrcBtn.className = "mini";
  addSrcBtn.textContent = I18n.t("＋ 添加源");
  addSrcBtn.title = I18n.t("添加自定义在线源（MTNode catalog.json / npm search / jsDelivr），以标签切换");
  addSrcBtn.onclick = openAddStoreSource;
  manageRow.appendChild(addSrcBtn);
  body.appendChild(manageRow);
  const search = document.createElement("input");
  search.type = "text";
  search.className = "dsh-plugin-search";
  search.placeholder = I18n.t("筛选…");
  body.appendChild(search);
  const status = document.createElement("div");
  status.className = "settings-hint";
  body.appendChild(status);
  const grid = document.createElement("div");
  grid.className = "store-grid";
  body.appendChild(grid);
  const foot = $("#ovFoot");
  const closeBtn = document.createElement("button");
  closeBtn.className = "mini primary";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = closeOverlay;
  foot.appendChild(closeBtn);

  const repos = storeRepos();
  let active = (repos[0] && repos[0].id) || "mtnode-official";
  let activeRepo = () => storeRepos().find((r) => r.id === active) || storeRepos()[0];
  let items = [];
  const installed = { plugins: [], skills: [], mcp: [] };
  const refreshInstalled = async () => {
    try {
      const r = await window.api.dshPluginList();
      installed.plugins = (r && Array.isArray(r.plugins) && r.plugins) || [];
    } catch {}
    try {
      const r = await window.api.skillList();
      installed.skills = (r && r.skills) || [];
    } catch {}
    try {
      const r = await window.api.dshMcpList();
      installed.mcp = (r && r.servers) || [];
    } catch {}
  };
  const paintTabs = () => {
    tabs.innerHTML = "";
    for (const r of storeRepos()) {
      const b = document.createElement("button");
      b.className = "mini" + (active === r.id ? " on" : "");
      b.textContent =
        I18n.t(r.label) +
        (r.kind && r.kind !== "catalog" ? " · " + storeKindLabel(r.kind) : "");
      b.title = r.url;
      b.onclick = async () => {
        if (active === r.id) return;
        active = r.id;
        paintTabs();
        grid.innerHTML = "";
        items = [];
        await load();
        render();
      };
      tabs.appendChild(b);
      const isUser = !DEFAULT_REPOS.some((d) => d.id === r.id);
      if (isUser) {
        const x = document.createElement("button");
        x.className = "mini store-tab-x";
        x.textContent = "✕";
        x.title = I18n.t("移除该源");
        x.onclick = async (ev) => {
          ev.stopPropagation();
          if (!(await confirmDialog(I18n.t("移除在线源「{name}」？", { name: r.label }), { title: I18n.t("移除"), danger: true, okText: I18n.t("移除") }))) return;
          S.config.onlineRepos = (S.config.onlineRepos || []).filter(
            (u) => u.id !== r.id,
          );
          await window.api.configSave(S.config);
          openStoreDialog();
        };
        tabs.appendChild(x);
      }
    }
  };
  const load = async () => {
    const repo = activeRepo();
    if (!repo) return;
    status.textContent =
      I18n.t("读取线上目录中…（") + storeRepoHint(repo) + "：" + (repo.url || "") + "）";
    try {
      items = await storeFetchItems(repo);
      status.textContent =
        I18n.t("线上目录 ") +
        items.length +
        I18n.t(" 项 · ") +
        storeRepoHint(repo);
    } catch (e) {
      items = [];
      status.textContent =
        I18n.t("线上目录暂不可用（") + (e.message || String(e)) + I18n.t("）· 请检查网络或源地址后重试");
    }
  };
  /* 技能安装 / 更新共用的一步：从线上源拉 SKILL.md 落进本机技能目录。
     更新必须带 overwrite —— 否则 skillAdd 以「同名技能已存在」拒绝，
     已安装技能就只能「卸载了再装」，提示词技能改版永远进不来。 */
  const installSkillFromRepo = async (it, repo, opts) => {
    opts = opts || {};
    let mdUrl = it.skillUrl;
    if (!mdUrl) {
      const cdn = storeCdnUrl(repo.url);
      if (!cdn || !String(cdn).includes("jsdelivr")) {
        throw new Error(I18n.t("该源无法安装技能（需要 jsDelivr 或 MTNode catalog）"));
      }
      mdUrl =
        cdn +
        (repo.path ? "/" + repo.path : "") +
        "/" +
        it.id +
        "/SKILL.md";
    }
    const md = await netText(mdUrl);
    let desc = it.desc || it.id;
    const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
    if (m) {
      const dm = m[1].match(/^description:\s*(.+)$/m);
      if (dm) desc = dm[1].replace(/['"]/g, "").trim();
    }
    return window.api.skillAdd({
      name: it.id,
      description: desc,
      body: md,
      overwrite: !!opts.overwrite,
    });
  };
  /* 本机已装技能 vs 线上目录：先比正文指纹 sha256（同版本号改了正文也算有更新），
     目录没给指纹时退回版本号比较。 */
  const skillHasUpdate = (it, rec) => {
    if (!rec) return false;
    if (it.sha256 && rec.sha256)
      return String(it.sha256) !== String(rec.sha256);
    return !!(
      it.version &&
      rec.version &&
      String(it.version) !== String(rec.version)
    );
  };
  const render = () => {
    const repo = activeRepo();
    const q = search.value.trim().toLowerCase();
    grid.innerHTML = "";
    const list = items.filter(
      (x) => !q || x.name.toLowerCase().includes(q) || (x.desc || "").toLowerCase().includes(q),
    );
    if (!list.length) {
      const em = document.createElement("div");
      em.className = "dsh-plugin-empty";
      em.textContent = q ? I18n.t("无匹配项") : I18n.t("暂无条目");
      grid.appendChild(em);
      return;
    }
    for (const it of list) {
      const itemKind = it.kind || (repo && repo.kind) || "plugins";
      const card = document.createElement("div");
      card.className = "store-card";
      const nm = document.createElement("div");
      nm.className = "store-name";
      nm.textContent = it.name;
      nm.title = it.id;
      const ds = document.createElement("div");
      ds.className = "store-desc";
      ds.textContent = it.desc || "";
      const meta = document.createElement("div");
      meta.className = "store-meta";
      meta.textContent = it.version ? "v" + it.version : it.id;
      const btns = document.createElement("div");
      btns.className = "store-btns";
      if (repo && repo.kind === "catalog") {
        const kindTag = document.createElement("span");
        kindTag.className = "store-kind";
        kindTag.textContent = storeKindLabel(itemKind);
        btns.appendChild(kindTag);
      }
      const skillRec = installed.skills.find((s) => s.name === it.id);
      const isInstalled = (() => {
        if (itemKind === "plugins") return installed.plugins.some((p) => p.name === it.id);
        if (itemKind === "skills") return !!skillRec;
        return installed.mcp.some((s) => s.serverName === it.id);
      })();
      const canUninstall = itemKind !== "skills" || !(skillRec && skillRec.builtin);
      if (isInstalled) {
        const hasUpdate = itemKind === "skills" && skillHasUpdate(it, skillRec);
        const tag = document.createElement("span");
        tag.className = "store-installed";
        tag.textContent = hasUpdate ? I18n.t("有更新") : I18n.t("已安装");
        btns.appendChild(tag);
        if (itemKind === "skills" && canUninstall) {
          const upd = document.createElement("button");
          upd.className = "mini" + (hasUpdate ? " primary" : "");
          upd.textContent = I18n.t("更新");
          upd.title = hasUpdate
            ? I18n.t("线上目录已换新版，点此覆盖本机技能")
            : I18n.t("重新下载并覆盖本机技能");
          upd.onclick = async () => {
            try {
              if (
                !(await confirmDialog(
                  I18n.t("将用线上目录版本覆盖本机技能「{name}」。确定更新？", {
                    name: it.id,
                  }),
                  { title: I18n.t("更新技能") },
                ))
              )
                return;
              const rr = await installSkillFromRepo(it, repo, {
                overwrite: true,
              });
              if (rr && rr.ok === false) throw new Error(rr.error);
              toast(I18n.t("已更新 ") + it.id, "ok");
            } catch (e) {
              toast(I18n.t("更新失败：") + (e.message || String(e)), "err");
            }
            await refreshInstalled();
            render();
          };
          btns.appendChild(upd);
        }
        if (canUninstall) {
          const rm = document.createElement("button");
          rm.className = "mini danger";
          rm.textContent = I18n.t("卸载");
          rm.onclick = async () => {
            try {
              let rr;
              if (itemKind === "plugins") {
                if (!(await confirmDialog(I18n.t("卸载插件 ") + it.id + I18n.t("？引擎将自动重启。"), { title: I18n.t("卸载插件"), danger: true, okText: I18n.t("卸载") }))) return;
                rr = await window.api.dshPluginRemove(it.id);
              } else if (itemKind === "skills") {
                if (!(await confirmDialog(I18n.t("移除技能 ") + it.id + I18n.t("？"), { title: I18n.t("移除技能"), danger: true, okText: I18n.t("移除") }))) return;
                rr = await window.api.skillRemove(it.id);
              } else {
                if (!(await confirmDialog(I18n.t("移除 MCP 服务器 ") + it.id + I18n.t("？引擎将自动重启。"), { title: I18n.t("移除 MCP"), danger: true, okText: I18n.t("移除") }))) return;
                rr = await window.api.dshMcpRemove(it.id);
              }
              if (rr && rr.ok === false) throw new Error(rr.error);
              toast(I18n.t("已卸载 ") + it.id, "ok");
            } catch (e) {
              toast(I18n.t("卸载失败：") + (e.message || String(e)), "err");
            }
            await refreshInstalled();
            render();
          };
          btns.appendChild(rm);
        }
      } else {
        const inBtn = document.createElement("button");
        inBtn.className = "mini primary";
        inBtn.textContent = I18n.t("安装");
        inBtn.onclick = async () => {
          try {
            let rr;
            if (itemKind === "plugins") {
              rr = await window.api.dshPluginAdd(it.install || it.id);
            } else if (itemKind === "skills") {
              rr = await installSkillFromRepo(it, repo);
            } else {
              rr = await window.api.dshMcpAdd({
                serverName: it.id,
                transport: it.transport || "stdio",
                command: it.command || "npx.cmd",
                args: it.args || "-y @modelcontextprotocol/server-" + it.id,
                url: it.mcpUrl || "",
              });
            }
            if (rr && rr.ok === false) throw new Error(rr.error);
            toast(I18n.t("已安装 ") + it.id, "ok");
          } catch (e) {
            toast(I18n.t("安装失败：") + (e.message || String(e)), "err");
          }
          await refreshInstalled();
          render();
        };
        btns.appendChild(inBtn);
      }
      card.appendChild(nm);
      card.appendChild(ds);
      card.appendChild(meta);
      card.appendChild(btns);
      grid.appendChild(card);
    }
  };
  search.addEventListener("input", render);
  paintTabs();
  await refreshInstalled();
  await load();
  render();
}

/* 添加自定义在线源:MTNode catalog.json / npm search / jsDelivr repo */
function openAddStoreSource() {
  openOverlay(I18n.t("添加在线源"));
  overlayPersistent = true;
  const body = $("#ovBody");
  const f1 = document.createElement("label");
  f1.className = "n-field";
  f1.appendChild(document.createTextNode(I18n.t("名称（显示为标签）")));
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.placeholder = I18n.t("如「团队插件源」");
  f1.appendChild(nameInp);
  body.appendChild(f1);
  const f2 = document.createElement("label");
  f2.className = "n-field";
  f2.appendChild(document.createTextNode(I18n.t("类型")));
  const kindSel = document.createElement("select");
  for (const [v, l] of [
    ["catalog", I18n.t("MTNode 目录（插件+技能+MCP）")],
    ["plugins", I18n.t("插件（npm search 或 MTNode catalog）")],
    ["skills", I18n.t("技能（jsDelivr 或 MTNode catalog）")],
    ["mcp", I18n.t("MCP（jsDelivr 或 MTNode catalog）")],
  ]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    kindSel.appendChild(o);
  }
  f2.appendChild(kindSel);
  body.appendChild(f2);
  const f3 = document.createElement("label");
  f3.className = "n-field";
  f3.appendChild(document.createTextNode("URL"));
  settingsTipBeside(
    f3,
    "MTNode 目录填 catalog.json 即可（官方源已预置）。也可填 npm search 或 jsDelivr repo；技能子目录含 SKILL.md。",
    "在线源说明",
  );
  const urlInp = document.createElement("input");
  urlInp.type = "text";
  urlInp.placeholder = I18n.t("MTNode 目录：http://mt-agent.com/mtnode/ext/catalog.json");
  kindSel.addEventListener("change", () => {
    if (kindSel.value === "catalog" && !urlInp.value.trim()) {
      urlInp.value = MTNODE_EXT_CATALOG;
    }
  });
  f3.appendChild(urlInp);
  body.appendChild(f3);
  const f4 = document.createElement("label");
  f4.className = "n-field";
  f4.appendChild(document.createTextNode(I18n.t("子目录（可选，技能/MCP 的列表所在目录）")));
  const pathInp = document.createElement("input");
  pathInp.type = "text";
  pathInp.placeholder = I18n.t("如 skills 或 src；留空 = 仓库根目录");
  f4.appendChild(pathInp);
  body.appendChild(f4);
  const foot = $("#ovFoot");
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("添加");
  ok.onclick = async () => {
    const label = nameInp.value.trim();
    const url = urlInp.value.trim();
    if (!label || !url) {
      toast(I18n.t("请填写名称与 URL"), "warn");
      return;
    }
    if (!/^https?:\/\//.test(url)) {
      toast(I18n.t("URL 需以 http(s):// 开头"), "warn");
      return;
    }
    S.config.onlineRepos = S.config.onlineRepos || [];
    S.config.onlineRepos.push({
      id: "repo_" + Date.now().toString(36),
      label,
      kind: kindSel.value,
      url,
      path: pathInp.value.trim() || "",
      format: /\/catalog\.json$/i.test(url) || kindSel.value === "catalog" ? "mtnode-ext" : "",
    });
    await window.api.configSave(S.config);
    openStoreDialog();
    toast(I18n.t("已添加在线源：") + label, "ok");
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

/* 实时获取该服务商当前可用的模型列表（设置 · 服务商卡片「获取模型」）：
   OpenAI 兼容走主进程 GET <base>/v1/models（或 /models）——**纯 HTTP 元信息读取，
   不调用任何 AI，零 Token 消耗**；Stability 再回退账户信息里的 engines。
   结果落进一个多选对话框：已配的自动勾上（取消勾选 = 只保留不删），新增的默认勾上，
   一键批量加入模型列表；同时按模型元信息标出「能吃图 / 画图」。
   拿不到（老网关没有 /models、Key 无权限）就如实报错，退回手工填写。 */
async function fetchModelsToProvider(prov, btn) {
  if (!prov) return;
  const apiKey = String(prov.apiKey || "").trim();
  const baseUrl = String(prov.baseUrl || "").trim();
  if (!baseUrl) {
    toast(I18n.t("未配置接口地址（设置 · API/配置）"), "warn");
    return;
  }
  if (!apiKey) {
    toast(I18n.t("请填写 API Key"), "warn");
    return;
  }
  const label = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = I18n.t("读取中…");
  }
  let r = null;
  try {
    if (!window.api || !window.api.apiListModels) throw new Error(I18n.t("当前版本不支持读取模型列表"));
    r = await window.api.apiListModels({
      type: prov.type || "text_openai",
      baseUrl,
      apiKey,
    });
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label || I18n.t("获取模型");
    }
  }
  if (!r || !r.ok) {
    const detail = (r && r.error) || "";
    toast(
      (detail || I18n.t("获取模型列表失败")) + I18n.t("（可继续手工添加模型）"),
      "err",
    );
    return;
  }
  const live = (r.models || []).map(String);
  const meta = new Map(
    (r.meta || []).filter((m) => m && m.id).map((m) => [String(m.id), m]),
  );
  const have = new Set(
    (Array.isArray(prov.models) ? prov.models : []).map(String),
  );
  const added = live.filter((m) => !have.has(m));
  if (!live.length) return;
  openOverlay(I18n.t("获取模型列表"));
  overlayPersistent = true;
  const body = $("#ovBody");
  /* 口径说明挂到窗标题本身（这一屏没有字段标签可挂；悬停标题即出） */
  const ovTtl = $("#ovTitle");
  if (ovTtl) {
    settingsTipBeside(
      ovTtl,
      "已从服务商接口读取到可用模型（只读元信息，未消耗任何 Token）。勾选要加入下方模型列表的条目：已配置的默认勾上（取消勾选只是不重复添加，不会删除已有项）。",
      "获取模型列表说明",
    );
  }
  const list = document.createElement("div");
  list.className = "model-pick-list";
  const boxes = [];
  const mkRow = (id, fresh) => {
    const row = document.createElement("label");
    row.className = "mp-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.value = id;
    boxes.push(cb);
    const name = document.createElement("span");
    name.className = "mp-name";
    name.textContent = id;
    row.appendChild(cb);
    row.appendChild(name);
    const mt = meta.get(id);
    const kind = modelKindOf(S.config, prov.id, id);
    const tag = document.createElement("span");
    tag.className =
      "pk-badge pk-" + (kind === "image" ? "image" : "text");
    tag.textContent =
      kind === "image" ? I18n.t("图像") : I18n.t("文本");
    row.appendChild(tag);
    if (mt && mt.input) {
      const vis = document.createElement("span");
      vis.className = "pk-badge pk-mix";
      vis.textContent = I18n.t("能吃图");
      vis.title = I18n.t("该模型支持图片输入（视觉输入），不是「会画图」");
      row.appendChild(vis);
    }
    if (fresh) {
      const nw = document.createElement("span");
      nw.className = "mp-new";
      nw.textContent = I18n.t("新发现");
      row.appendChild(nw);
    }
    list.appendChild(row);
  };
  for (const id of live) mkRow(id, !have.has(id));
  body.appendChild(list);
  const state = document.createElement("div");
  state.className = "settings-hint";
  state.textContent = I18n.t("共 {n} 个模型 · 新发现 {m} 个")
    .replace("{n}", String(live.length))
    .replace("{m}", String(added.length));
  body.appendChild(state);
  const foot = $("#ovFoot");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "mini primary";
  okBtn.textContent = I18n.t("加入所选模型");
  okBtn.onclick = () => {
    /* 勾选顺序 = 服务商返回顺序 = 新的使用优先级（已有的排在最前，保持原顺序） */
    const picked = boxes.filter((b) => b.checked).map((b) => String(b.value));
    const kept = (Array.isArray(prov.models) ? prov.models : []).filter((m) =>
      have.has(String(m)),
    );
    if (picked.length) prov.models = Array.from(new Set(kept.concat(picked)));
    closeOverlay();
    settingsSaved(0);
    /* 回刷设置页（模型列表 / 形态标签）与画布节点的服务商下拉。
       服务商配置对话框是设置窗之上的一层独立浮层（#provCfgDlg 压着 #overlay），
       先把子浮层收掉再原地重画设置正文：不叠第二层设置窗，也不重读磁盘把刚写进去的
       改动顶掉（内存 S.config 就是刚保存的那一份）。 */
    closeProvCfgDlg();
    openSettingsBody();
    if (typeof settingsProvTilesRepaint === "function") settingsProvTilesRepaint();
    if (typeof renderCanvas === "function") {
      try {
        renderCanvas();
      } catch {}
    }
    toast(
      I18n.t("已加入 {n} 个模型（新发现 {m} 个）")
        .replace("{n}", String(picked.length))
        .replace("{m}", String(added.length)),
      "ok",
    );
  };
  foot.appendChild(cancel);
  foot.appendChild(okBtn);
}

/* 设置页：无 Token 消耗校验 API Key（主进程 GET /models 等） */
async function validateProviderApiKey(prov, btn) {
  const apiKey = String((prov && prov.apiKey) || "").trim();
  const baseUrl = String((prov && prov.baseUrl) || "").trim();
  if (!apiKey) {
    toast(I18n.t("请填写 API Key"), "warn");
    return false;
  }
  if (!baseUrl) {
    toast(I18n.t("未配置接口地址（设置 · API/配置）"), "warn");
    return false;
  }
  const label = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = I18n.t("验证中…");
  }
  try {
    const r = await window.api.apiValidateKey({
      type: (prov && prov.type) || "text_openai",
      baseUrl,
      apiKey,
    });
    if (r && r.ok) {
      toast(I18n.t("API Key 验证成功（无 Token 消耗）"), "ok");
      return true;
    }
    const detail = r && r.error ? String(r.error) : "";
    toast(
      detail.indexOf(I18n.t("API Key 验证失败")) === 0
        ? detail
        : I18n.t("API Key 验证失败") + (detail ? "：" + detail : ""),
      "err",
    );
    return false;
  } catch (e) {
    toast(
      I18n.t("API Key 验证失败") + "：" + ((e && e.message) || String(e)),
      "err",
    );
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label || I18n.t("验证");
    }
  }
}

/* 提供商网格的回刷句柄：设置窗重开时重绑，配置对话框关窗时回刷一次。
   旁边的 settingsTopupRepaint 只管「无 Key 时的 DeepSeek 官方充值通道」那条横幅，
   可以单独调用（在 Key 输入框里打字就即时收起 / 回来，不必等关窗）。 */
let settingsProvTilesRepaint = null;
let settingsTopupRepaint = null;
let settingsRelayRepaint = null;
function repaintSettingsProvTiles() {
  if (typeof settingsProvTilesRepaint === "function") {
    try {
      settingsProvTilesRepaint();
    } catch {}
  }
  repaintSettingsTopup();
  repaintSettingsRelay();
}
function repaintSettingsRelay() {
  if (typeof settingsRelayRepaint === "function") {
    try {
      settingsRelayRepaint();
    } catch {}
  }
}
function repaintSettingsTopup() {
  if (typeof settingsTopupRepaint === "function") {
    try {
      settingsTopupRepaint();
    } catch {}
  }
}

/* 提供商网格里的一格：只显示标题（服务商名称），点击弹出该服务商的配置对话框 */
function provTile(prov, i) {
  const tile = document.createElement("button");
  tile.type = "button";
  /* 角标分两种叫法：用户自己关掉的（已停用）/ 中转服务余额耗尽的（余额不足）——
     两者都不进模型选择器，但用户该做的事完全不同（一个是取消勾选，一个是去充值）。 */
  const state =
    typeof providerStateText === "function" ? providerStateText(prov) : "";
  const relay = typeof MtRelay !== "undefined" && MtRelay.isRelay(prov);
  tile.className =
    "prov-tile" +
    (i === 0 ? " pri" : "") +
    (state ? " off" : "") +
    (relay ? " relay" : "");
  tile.title =
    (i === 0 ? I18n.t("当前优先使用") + " · " : "") +
    I18n.t("点击配置该服务商") +
    /* 停用只影响「出现在模型选择器里」，卡片照旧留着、可编辑、可恢复 */
    (state ? " · " + state : "") +
    (relay ? " · " + I18n.t("接入信息由 MTNode 账号托管") : "");
  const name = document.createElement("span");
  name.className = "prov-tile-name";
  name.textContent = prov.name || I18n.t("（未命名）");
  tile.appendChild(name);
  if (state) {
    const tag = document.createElement("span");
    tag.className = "prov-tile-off";
    tag.textContent = state;
    tile.appendChild(tag);
  }
  tile.onclick = () => openProviderConfigDialog(prov);
  return tile;
}

/* 服务商具体配置对话框：独立宿主 #provCfgDlg（.mt-dialog，层级高于 #overlay）。
   #overlay 全应用独一份、不能叠窗，所以这里不用 openOverlay——设置窗原样留在
   下面，用户改到一半的其它设置项（网格间距 / 主题 / 智能能力）不会被冲掉。
   persistent：点蒙层 / 点外部一律不关，关窗只走窗内「完成」或 Esc。 */
function ensureProvCfgDlg() {
  let host = document.getElementById("provCfgDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "provCfgDlg";
  host.className = "mt-dialog prov-cfg-dlg";
  host.tabIndex = -1;
  host.innerHTML =
    '<div class="mt-dialog-box prov-cfg-box" role="dialog" aria-modal="true">' +
    '<div class="mt-dialog-head"><b id="provCfgTitle"></b></div>' +
    '<div class="mt-dialog-body" id="provCfgBody"></div>' +
    '<div class="mt-dialog-foot" id="provCfgFoot"></div>' +
    "</div>";
  document.body.appendChild(host);
  host.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    closeProvCfgDlg();
  });
  return host;
}

function closeProvCfgDlg() {
  const host = document.getElementById("provCfgDlg");
  if (host) {
    host.classList.remove("on");
    /* 中转卡那次订阅（openProviderConfigDialog 里挂的）随关窗退掉 */
    if (host.__relayOff) {
      try {
        host.__relayOff();
      } catch {}
      host.__relayOff = null;
    }
  }
  /* 收子对话框 = 打字类改动（名称 / Base URL / API Key）的防抖该落地了：
     设置页没有「保存设置」兜底，这里不 flush 就会丢掉最后一次编辑 */
  settingsSaveNow();
  repaintSettingsProvTiles();
  /* 节点上的服务商 / 模型下拉读的是 S.config.providers：改完顺手重绘一次画布，
     让「加了一家服务商」在画布上立刻可见，而不是等设置窗关掉 */
  if (typeof renderCanvas === "function") {
    try {
      renderCanvas();
    } catch {}
  }
}

function openProviderConfigDialog(prov) {
  const host = ensureProvCfgDlg();
  const titleEl = host.querySelector("#provCfgTitle");
  const bodyEl = host.querySelector("#provCfgBody");
  const footEl = host.querySelector("#provCfgFoot");
  /* 每次重画都按「服务商对象」重算下标：窗口开着时也能删 / 调优先级。
     对象在 config.providers 里被整只换掉（中转卡每次同步都会重建一份，见
     renderer/app-relay.js 的 applyDoc）时必须**按 id / source 重绑到新的那一只**，
     不能判成「已删除」：老写法只看 indexOf(prov)，中转卡一同步就把自己这张窗关掉，
     用户看到的就是「打开立刻被自动关闭」。 */
  let alive = true;
  const resolve = () => {
    const list = (S.config && Array.isArray(S.config.providers) && S.config.providers) || [];
    if (list.indexOf(prov) >= 0) return prov;
    const id = String((prov && prov.id) || "");
    const src = String((prov && prov.source) || "");
    const hit =
      (id && list.find((p) => p && String(p.id || "") === id)) ||
      (src && list.find((p) => p && String(p.source || "") === src)) ||
      null;
    return hit;
  };
  const paint = () => {
    const cur = resolve();
    if (!cur) {
      /* 真的被删掉了：收窗（关窗路径里会回刷网格）；别再把自己显示回来 */
      alive = false;
      closeProvCfgDlg();
      return;
    }
    prov = cur;
    const i = S.config.providers.indexOf(cur);
    titleEl.textContent =
      I18n.t("服务商配置") + " · " + (prov.name || I18n.t("（未命名）"));
    bodyEl.innerHTML = "";
    bodyEl.appendChild(provCard(prov, i, paint));
    footEl.innerHTML = "";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "mini primary";
    done.textContent = I18n.t("完成");
    /* 过去这里没有「保存」是因为整页设置靠底部的「保存设置」收口；现在这一页
       连那个按钮也去掉了 —— 卡片里的每一项都在改完那一刻写盘，「完成」只收窗 */
    done.title = I18n.t("这张卡的改动已即时生效，点「完成」收窗");
    done.onclick = () => closeProvCfgDlg();
    footEl.appendChild(done);
  };
  paint();
  if (!alive) return;
  /* 插件（llama 等）把新模型清单写回配置后要就地重画这张卡：settingsOnProvidersSynced
     从这里取重画入口（不重开窗、也不丢用户改到一半的输入） */
  host.__paint = () => {
    try {
      paint();
    } catch {}
  };
  host.classList.add("on");
  /* 中转服务卡：打开时本地没有快照才顺手拉一次，并把同步结果落回这张卡
     （判定见 renderer/app-relay.js 的 syncIfStale；订阅 MtRelay 的变更 → 重画，关窗时退订） */
  if (typeof MtRelay !== "undefined" && MtRelay.isRelay(prov)) {
    if (MtRelay.onChange) {
      host.__relayOff = MtRelay.onChange(() => {
        if (!alive) return;
        try {
          paint();
        } catch {}
      });
    }
    if (MtRelay.syncIfStale) {
      try {
        /* retry:true = 快照过期 / 上次失败时自动重拉（卡上没有刷新按钮了） */
        MtRelay.syncIfStale({ retry: true });
      } catch {}
    }
  } else if (host.__relayOff) {
    host.__relayOff();
    host.__relayOff = null;
  }
  try {
    host.focus();
  } catch {}
}

/* 逐模型价目的一行文字（中转只读卡专用）：价目由云端随快照下发（meta.prices），
   与本地「中转按币」计价同一份 —— 用户对不上账时能自己核。
   口径：存的是元（与云端账本同源），括号里给鲸圆币（用户看的就是币）；
   文本行标出「入（未命中 / 缓存命中）· 出」与高峰倍率，图像行给元/张。
   没有价目（老部署没下发 / 老快照）返回空串 —— 卡上不写「—」，免得看着像免费。 */
function relayPriceText(id, meta) {
  const p = ((meta && meta.prices) || {})[id] || null;
  if (!p) return "";
  const coinYuan = Number((meta && meta.coinYuan) || 0) || 0.02; /* 1 币 = ¥0.02（云端汇率优先） */
  const per = 1 / coinYuan; /* 1 元 = 多少币 */
  const y = (v) => "¥" + (Number(v) || 0);
  const c = (v) =>
    (typeof costCoinText === "function"
      ? costCoinText((Number(v) || 0) * per)
      : String(Math.round((Number(v) || 0) * per * 100) / 100) +
        (window.MtCoin && window.MtCoin.unitText ? window.MtCoin.unitText() : I18n.t(" 币")));
  if (p.kind === "image") {
    const y0 = Number(p.perImageYuan) || 0;
    return I18n.t("按张 ") + y(y0) + I18n.t("/张") + "（" + c(y0) + "）";
  }
  const peak = Number(p.peakMultiplier) || 1;
  return (
    I18n.t("入价 ") + y(p.cacheMiss) + I18n.t("/百万") +
    I18n.t("（缓存命中 ") + y(p.cacheHit) + I18n.t("）· 出价 ") + y(p.output) + I18n.t("/百万") +
    (peak > 1 ? I18n.t(" · 高峰 ×") + peak : "") +
    "（" + c(p.cacheMiss) + I18n.t("起）")
  );
}

/* ── MTNode 中转服务的余额元件（鲸圆币）──────────────────────────────
   中转余额是本机唯一「按币计费」的钱：快照里的 totalYuan 仍是元（云端不下发币），
   这里只把显示换成币（换算与金币图标见 renderer/app-whalecoin.js）。
   悬停提示**不带汇率** —— 需求口径「账户里不提示 1￥=50 币，只在充值界面提示」，
   汇率那行只写在充值窗（renderer/app-wallet.js 的 #wlRate）。
   MtCoin 缺席（老版渲染层）时退回元的 1 位小数串，界面不至于空着。 */
function relayBalanceEl(totalYuan) {
  const yuan = Number(totalYuan) || 0;
  if (window.MtCoin && window.MtCoin.balanceEl) {
    const bal = window.MtCoin.balanceEl(yuan);
    if (bal) bal.title = I18n.t("鲸圆币");
    return bal;
  }
  return document.createTextNode(
    typeof MtRelay !== "undefined" ? MtRelay.money(yuan) : "¥" + yuan.toFixed(1),
  );
}

/* ── MTNode 中转服务（账号托管）的只读卡 ──────────────────────────────
   口径（共识 · 见 renderer/app-relay.js 与 docs/relay-admin.md）：
     · **大部分设置只读** —— 类型 / 形态 / 名称 / Base URL / API Key / 模型清单
       全部由云端下发或主进程托管，卡上没有一处可编辑接入信息的输入框；
     · 用户能改的只有「启用开关」与「本机优先级 ↑↓」；
     · 不提供「✕ 删除」，也不提供「复制为自定义服务商」——这张卡跟着账号走，
       没充值过的账号根本不会有它（everRecharged=false 时连卡都不建）。 */
function relayProvCard(prov, i, onChange) {
  const card = document.createElement("div");
  card.className = "prov-card relay-card";
  const rerender = () => {
    settingsSaved(0);
    if (typeof onChange === "function") onChange();
  };
  const meta = typeof MtRelay !== "undefined" ? MtRelay.meta(prov) : {};
  const state =
    typeof providerStateText === "function" ? providerStateText(prov) : "";

  /* 头部：#序号 + 名称 + 角标 + ↑↓（没有「✕ 删除」） */
  const head = document.createElement("div");
  head.className = "prov-head";
  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = "#" + (i + 1);
  idx.title =
    i === 0
      ? I18n.t("当前优先使用")
      : I18n.t("供应商使用优先级（越小越优先）");
  head.appendChild(idx);
  const nameSpan = document.createElement("span");
  nameSpan.className = "prov-name" + (i === 0 ? " pri" : "");
  nameSpan.textContent = prov.name || I18n.t("MTNode 中转服务");
  head.appendChild(nameSpan);
  const badge = document.createElement("span");
  badge.className = "relay-badge" + (state ? " bad" : "");
  badge.textContent = state || I18n.t("账号托管");
  head.appendChild(badge);
  const move = document.createElement("span");
  move.className = "prov-move";
  const swap = (a, b) => {
    const arr = S.config.providers;
    const t = arr[a];
    arr[a] = arr[b];
    arr[b] = t;
    rerender();
  };
  const up = document.createElement("button");
  up.type = "button";
  up.className = "mini";
  up.textContent = "↑";
  up.title = I18n.t("提高供应商优先级");
  up.disabled = i === 0;
  up.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (i > 0) swap(i - 1, i);
  };
  const down = document.createElement("button");
  down.type = "button";
  down.className = "mini";
  down.textContent = "↓";
  down.title = I18n.t("降低供应商优先级");
  down.disabled = i >= S.config.providers.length - 1;
  down.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (i < S.config.providers.length - 1) swap(i + 1, i);
  };
  move.appendChild(up);
  move.appendChild(down);
  head.appendChild(move);
  card.appendChild(head);

  /* 只读字段：一律 <code> 展示，不放输入框 —— 改不了的东西别长得像能改。
     返回那个 <code> 元素，调用方要补 title / 徽标就自己补（如 API Key 那一行）。 */
  const gridEl = document.createElement("div");
  gridEl.className = "prov-grid";
  const ro = (label, value, wide, tipText, tipLabel) => {
    const f = document.createElement("div");
    f.className = "pf" + (wide ? " pf-wide" : "");
    f.appendChild(document.createTextNode(label));
    /* 说明性文字挂标签本身（见 settingsTipBeside），不再平铺一行灰字 */
    if (tipText) settingsTipBeside(f, tipText, tipLabel);
    const v = document.createElement("code");
    v.className = "relay-ro";
    v.textContent = value == null || value === "" ? "—" : String(value);
    f.appendChild(v);
    gridEl.appendChild(f);
    return v;
  };
  ro(I18n.t("类型"), I18n.t("OpenAI 兼容（由 MTNode 账号下发）"), true);
  ro(
    I18n.t("形态"),
    I18n.t("文本 + 图像（同一端点混合，按模型区分）"),
    true,
  );
  ro(I18n.t("名称"), prov.name || I18n.t("MTNode 中转服务"));
  ro(I18n.t("接口地址 Base URL"), prov.baseUrl || "", true);
  /* API Key：中转 Key 由账号托管，但**明文就在这张卡上**（主进程写进本机 config.json
     的那一串，见 docs/relay-admin.md）——这里显示完整值（等宽、可选中、长串换行）+ 复制按钮，
     用户拿它就能直接填进 Codex 等 OpenAI 兼容客户端（Base URL 即上面那行接口地址）。
     换票走「更换 Key」按钮（服务端按账号自然日限 5 次），不提供可手改的输入框：
     手改的值下一次同步就会被覆盖，只会让人白改一遍。 */
  {
    const view =
      typeof MtRelay !== "undefined" && MtRelay.keyView
        ? MtRelay.keyView(prov)
        : { key: String(prov.apiKey || ""), authKey: !!String(prov.apiKey || "") };
    const keyText = String(view.key || "");
    const rotate = meta.rotate && typeof meta.rotate === "object" ? meta.rotate : null;
    const kv = ro(
      I18n.t("API Key"),
      keyText,
      true,
      keyText
        ? "可直接用于 Codex 等 OpenAI 兼容客户端：Base URL 就是上面那行接口地址"
        : "",
      "中转 Key 用法",
    );
    kv.classList.add("relay-key");
    kv.title = keyText
      ? I18n.t("这串就是中转 Key：可直接用于 Codex 等 OpenAI 兼容客户端（Base URL 即上面的接口地址）")
      : "";
    const row = document.createElement("div");
    row.className = "relay-keyops";
    const cp = document.createElement("button");
    cp.className = "mini";
    cp.type = "button";
    cp.textContent = I18n.t("复制");
    cp.title = I18n.t("复制中转 Key 到剪贴板");
    cp.disabled = !keyText;
    cp.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!keyText) {
        toast(I18n.t("还没有取到中转 Key"), "warn");
        return;
      }
      settingsClipboardWrite(keyText).then((r) =>
        r && r.ok
          ? toast(I18n.t("中转 Key 已复制到剪贴板"), "ok")
          : toast(I18n.t("复制失败，请手动选中后按 Ctrl+C 复制"), "err"),
      );
    };
    const rb = document.createElement("button");
    rb.className = "mini";
    rb.type = "button";
    rb.textContent = I18n.t("更换 Key");
    rb.title = I18n.t("换一张新的中转 Key（旧 Key 立即失效）");
    rb.disabled = !keyText;
    rb.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const left = rotate && typeof rotate.left === "number" ? rotate.left : null;
      const okGo = await confirmDialog(
        I18n.t("确定更换中转 Key？") +
          "\n\n" +
          I18n.t(
            "换新的之后旧 Key 立即失效：正在用旧 Key 的其它客户端（Codex、桌宠、别的电脑）需要重新复制这一串。",
          ) +
          (left == null ? "" : "\n\n" + I18n.t("今日还可更换 {n} 次（每天 5 次）", { n: left })),
        {
          title: I18n.t("更换中转 Key"),
          okText: I18n.t("更换"),
          cancelText: I18n.t("取消"),
        },
      );
      if (!okGo) return;
      if (typeof MtRelay === "undefined" || !MtRelay.rotateKey) {
        toast(I18n.t("更换中转 Key 失败，请稍后重试"), "warn");
        return;
      }
      rb.disabled = true;
      try {
        const r = await MtRelay.rotateKey();
        if (r && r.ok) {
          toast(I18n.t("已更换中转 Key（旧 Key 已失效）"), "ok");
          rerender();
        } else {
          toast((r && r.error) || I18n.t("更换中转 Key 失败，请稍后重试"), "warn");
        }
      } finally {
        rb.disabled = false;
      }
    };
    row.appendChild(cp);
    row.appendChild(rb);
    /* 按钮贴着 API Key 那一格放（跟在 <code> 后面），别在网格里另起一格 */
    (kv.parentElement || gridEl).appendChild(row);
    /* 没票时的两种「下一步该做什么」属于阻断性引导，仍常显（共识：引导不藏）；
       有票时的用法说明挂在上面标签本身（悬停即出）。 */
    if (!keyText) {
      const keyHint = document.createElement("div");
      keyHint.className = "settings-hint";
      keyHint.style.margin = "0";
      keyHint.textContent =
        meta.keyIssue === "server_no_relay_key"
          ? I18n.t("服务端这次没有下发独立中转凭据：稍后会自动重试（与是否重新登录无关）")
          : I18n.t("还没有取到中转 Key：请先登录 MTNode 账号（登录后会自动拉取）");
      gridEl.appendChild(keyHint);
    }
  }

  /* 模型清单：只读视图，逐行标出形态。余额耗尽时整块置灰，但**清单照旧列出来** ——
     让用户看得见这张卡正常时能用什么；它们在节点里选不到（见 app-model-kind.js
     的 providerDisabled / providerRelayBlocked）。 */
  const modelsField = document.createElement("div");
  modelsField.className = "pf pf-wide";
  {
    /* 标题行：价目口径挂在标题文字上（说明不再平铺一行灰字） */
    const head = document.createElement("span");
    head.appendChild(
      document.createTextNode(I18n.t("模型清单（云端下发，从上到下为使用优先级）")),
    );
    settingsTipBeside(
      head,
      "价目由云端随账号下发（元为平台账本口径，括号内为鲸圆币，1 币 = ¥0.02）：会话 Token 统计里中转模型按这份价目折算成币。",
      "价目口径",
    );
    modelsField.appendChild(head);
  }
  const orderBox = document.createElement("div");
  orderBox.className = "model-order relay-model-order" + (meta.blocked ? " off" : "");
  const ids = (meta.models || []).map(String);
  if (!ids.length) {
    const empty = document.createElement("div");
    empty.className = "settings-hint";
    empty.style.margin = "0";
    empty.textContent = I18n.t("账号当前没有可用模型：充值后会自动刷新");
    orderBox.appendChild(empty);
  }
  for (const id of ids) {
    const row = document.createElement("div");
    row.className = "model-order-row relay-model-row";
    const txt = document.createElement("span");
    txt.className = "mo-name";
    txt.textContent = id;
    row.appendChild(txt);
    const kind = document.createElement("span");
    kind.className = "relay-kind";
    const k = (meta.kinds || {})[id];
    kind.textContent = k === "image" ? I18n.t("图像") : I18n.t("文本");
    row.appendChild(kind);
    const priceTxt = relayPriceText(id, meta);
    if (priceTxt) {
      const price = document.createElement("span");
      price.className = "relay-price";
      price.textContent = priceTxt;
      price.title = I18n.t("本地计价用的价目（与中转站同一份）：文本按元/百万 token、图像按元/张");
      row.appendChild(price);
    }
    orderBox.appendChild(row);
  }
  modelsField.appendChild(orderBox);
  gridEl.appendChild(modelsField);
  card.appendChild(gridEl);

  /* 余额：**没有刷新按钮**（需求：移除「刷新中转清单」/ 卡内「刷新」）——
     拉取与失败重试由 MtRelay.syncIfStale 在打开设置 / 卡时自动做，充值到账也会自动重拉。
     口径：充值入口只留一处，用户不必记「充值得去设置里找那张卡」；卡本身只有充过值的
     账号才有（everRecharged），把入口挂在卡上等于对没充值的账号把它藏起来。
     余额按鲸圆币显示（快照里的 totalYuan 仍是元，见本文件 relayBalanceEl）。 */
  const moneyRow = document.createElement("div");
  moneyRow.className = "relay-balance";
  const bal = document.createElement("b");
  bal.appendChild(document.createTextNode(I18n.t("可用余额 ")));
  bal.appendChild(relayBalanceEl(Number(meta.totalYuan) || 0));
  moneyRow.appendChild(bal);
  card.appendChild(moneyRow);

  /* 状态行：上次同步时间 / 余额不足 / 刷新失败原因（三选一，口径见 MtRelay.stateText） */
  const stateLine = document.createElement("div");
  stateLine.className =
    "settings-hint relay-sync" + (meta.blocked || meta.error ? " bad" : "");
  stateLine.style.margin = "0";
  stateLine.textContent =
    typeof MtRelay !== "undefined" ? MtRelay.stateText(prov) : "";
  card.appendChild(stateLine);

  /* 中转服务警示（与充值窗同一份文案与样式，真源 = MtWallet.relayWarnEl）：
     中转只供临时使用；LLM 模型不要轻信官方以外的中转站。MtWallet 缺席（老版渲染层）
     时整块不出现，不影响这张卡原有信息。 */
  if (window.MtWallet && window.MtWallet.relayWarnEl) {
    card.appendChild(window.MtWallet.relayWarnEl());
  }

  /* ── 启用开关（可改；手动停用后刷新不会自动恢复） ── */
  const offRow = document.createElement("label");
  offRow.className = "pf pf-inline";
  const offCb = document.createElement("input");
  offCb.type = "checkbox";
  offCb.checked =
    typeof providerManuallyOff === "function" && providerManuallyOff(prov);
  offCb.onchange = () => {
    if (offCb.checked) prov.disabled = true;
    else delete prov.disabled;
    settingsSaved(0);
    if (typeof settingsProvTilesRepaint === "function") settingsProvTilesRepaint();
  };
  offRow.appendChild(offCb);
  offRow.appendChild(document.createTextNode(I18n.t("停用该服务商")));
  /* 「停用只影响可见性」这句括注挂勾选项文字本身（悬停即出） */
  settingsTipBeside(offRow, "停用后不出现在模型选择器里", "停用说明");
  card.appendChild(offRow);
  return card;
}

/* ── llama.cpp 本地模型（插件托管那家）：状态徽标 + 「部署 / 停止」──────────────
   服务商条目上的 llamaModels 由插件每次同步写回（见 llama/provider-sync.js），
   这里只读不写：状态文字一律走 I18n（中英同源），状态本身是插件给的英文 key。 */
function llamaProviderManaged(prov) {
  return !!(
    prov &&
    (String(prov.source || "") === "llama-plugin" || String(prov.id || "") === "llama-local")
  );
}
function llamaModelRowOf(prov, modelId) {
  const rows = prov && Array.isArray(prov.llamaModels) ? prov.llamaModels : [];
  const m = String(modelId || "");
  return (
    rows.find((r) => r && (String(r.id) === m || String(r.modelId) === m)) || null
  );
}
function llamaStatusTextOf(row) {
  const s = String((row && row.status) || "downloaded");
  if (s === "running") return "运行中";
  if (s === "starting") return "加载中";
  if (s === "failed") return "加载失败";
  return "未部署";
}

/* 插件把新的模型清单写回配置后：打开着的服务商卡 / 设置页就地刷新（本轮共识 q5：
   部署 / 停止成功后已打开的界面当场刷新，不要求重开）。找不到落点时什么都不做。 */
function settingsOnProvidersSynced() {
  try {
    const dlg = document.getElementById("provCfgDlg");
    if (dlg && dlg.classList.contains("on") && typeof dlg.__paint === "function") {
      dlg.__paint();
      return true;
    }
    if (
      overlayKind === "settings" &&
      typeof openSettingsBody === "function" &&
      document.getElementById("overlay") &&
      document.getElementById("overlay").style.display === "flex"
    ) {
      openSettingsBody();
      return true;
    }
  } catch {}
  return false;
}

function provCard(prov, i, onChange) {
  /* MTNode 中转服务（账号托管）：接入信息与模型清单由云端下发，一处都不许手改，
     走上面那套只读卡（可改的只有启用开关与本机优先级）。 */
  if (typeof MtRelay !== "undefined" && MtRelay.isRelay(prov)) {
    return relayProvCard(prov, i, onChange);
  }
  const card = document.createElement("div");
  card.className = "prov-card";
  /* 类型改 / 排序 / 删除后就地重建这张卡（配置对话框内 = 重画该服务商），
     不整页重开设置，也避免 openSettings() 重读磁盘把未保存的改动吞掉。
     设置页已无「保存设置」：这张卡里的每一项改动都直接落盘（见 settingsSaved）。 */
  const rerender = () => {
    settingsSaved(0);
    if (typeof onChange === "function") onChange();
  };
  const head = document.createElement("div");
  head.className = "prov-head";
  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = "#" + (i + 1);
  idx.title = i === 0 ? I18n.t("当前优先使用") : I18n.t("供应商使用优先级（越小越优先）");
  head.appendChild(idx);
  const nameSpan = document.createElement("span");
  nameSpan.className = "prov-name" + (i === 0 ? " pri" : "");
  nameSpan.textContent = prov.name || I18n.t("（未命名）");
  head.appendChild(nameSpan);
  const move = document.createElement("span");
  move.className = "prov-move";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "mini";
  up.textContent = "↑";
  up.title = I18n.t("提高供应商优先级");
  up.disabled = i === 0;
  up.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (i <= 0) return;
    const arr = S.config.providers;
    const t = arr[i - 1];
    arr[i - 1] = arr[i];
    arr[i] = t;
    rerender();
  };
  const down = document.createElement("button");
  down.type = "button";
  down.className = "mini";
  down.textContent = "↓";
  down.title = I18n.t("降低供应商优先级");
  down.disabled = i >= S.config.providers.length - 1;
  down.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (i >= S.config.providers.length - 1) return;
    const arr = S.config.providers;
    const t = arr[i + 1];
    arr[i + 1] = arr[i];
    arr[i] = t;
    rerender();
  };
  move.appendChild(up);
  move.appendChild(down);
  head.appendChild(move);
  const del = document.createElement("span");
  del.className = "del";
  del.textContent = I18n.t("✕ 删除");
  del.title = I18n.t("删除该服务商");
  del.onclick = () => {
    const pid = prov && prov.id ? String(prov.id) : "";
    S.config.providers.splice(i, 1);
    if (pid) {
      /* 记入删除清单，随保存持久化：重启时 ensureDefaultProviders()
         不再把该默认项补回来 */
      S.config.removedProviders = Array.isArray(S.config.removedProviders)
        ? S.config.removedProviders.slice()
        : [];
      if (S.config.removedProviders.indexOf(pid) < 0)
        S.config.removedProviders.push(pid);
    }
    rerender();
  };
  head.appendChild(del);
  card.appendChild(head);

  const gridEl = document.createElement("div");
  gridEl.className = "prov-grid";

  const mkField = (label, ctrl, wide, tipText, tipLabel) => {
    const f = document.createElement("label");
    f.className = "pf" + (wide ? " pf-wide" : "");
    f.appendChild(document.createTextNode(label));
    /* 字段口径挂在字段标签本身（见 settingsTipBeside） */
    if (tipText) settingsTipBeside(f, tipText, tipLabel);
    f.appendChild(ctrl);
    gridEl.appendChild(f);
    return f;
  };

  const typeSel = document.createElement("select");
  for (const [v, l] of PROVIDER_TYPE_LABELS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(l);
    typeSel.appendChild(o);
  }
  typeSel.value = prov.type;
  typeSel.onchange = () => {
    prov.type = typeSel.value;
    rerender();
  };
  mkField(I18n.t("类型"), typeSel);

  /* 形态（文本 / 图像）：在类型旁把「这个服务商算哪一类」说清楚 ——
     过去只有类型名（text_openai / image_openai …），同一个 OpenAI 兼容端点既挂
     文本模型又挂图像模型时分不清，图像节点还会因此选不到这家。形态由模型列表
     逐个识别（见 renderer/app-model-kind.js），配错的一键纠回。 */
  const kinds = providerKinds(S.config, prov);
  const kindHint =
    kinds.length > 1
      ? I18n.t("文本 + 图像（同一端点混合，按模型区分）")
      : kinds[0] === "image"
        ? I18n.t("图像生成")
        : I18n.t("文本");
  const kindWrap = document.createElement("div");
  kindWrap.className = "pf-kind";
  const kindTag = document.createElement("span");
  kindTag.className = "pk-badge pk-" + (kinds.length > 1 ? "mix" : kinds[0]);
  kindTag.textContent = kindHint;
  kindWrap.appendChild(kindTag);
  const wantType = providerTypeForKind(prov.type, kinds[0]);
  if (wantType !== prov.type) {
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "mini";
    fix.textContent = I18n.t("按模型纠正类型");
    fix.title = I18n.t(
      "服务商类型与模型形态不符：按模型列表把类型改为对应的文本 / 图像类型，改完图像或文本节点即可选到这些模型",
    );
    fix.onclick = (ev) => {
      ev.preventDefault();
      prov.type = wantType;
      rerender();
    };
    kindWrap.appendChild(fix);
  }
  mkField(I18n.t("形态"), kindWrap, true);

  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.value = prov.name || "";
  nameInp.placeholder = I18n.t("服务商名称");
  nameInp.oninput = () => {
    prov.name = nameInp.value;
    nameSpan.textContent = nameInp.value || I18n.t("（未命名）");
    /* 打字合并写盘；空名称不立刻把整格服务商弄丢（收口在关窗时做） */
    settingsSaved(600);
  };
  mkField(I18n.t("名称"), nameInp);

  const urlInp = document.createElement("input");
  urlInp.type = "text";
  urlInp.value = prov.baseUrl || "";
  urlInp.placeholder = "https://api.example.com/v1";
  urlInp.oninput = () => {
    prov.baseUrl = urlInp.value;
    settingsSaved(600);
  };
  mkField(I18n.t("接口地址 Base URL"), urlInp, true);

  /* DeepSeek 官方服务商卡：没填 Key 时在 API Key 上方给一行官方充值通道，
     地址就贴在手边（与设置页顶部那条横幅同源，都用 DEEPSEEK_TOPUP_URL） */
  const isDsOfficial =
    String(prov.id || "") === "deepseek" ||
    /deepseek/i.test(String(prov.baseUrl || ""));
  if (isDsOfficial && !String(prov.apiKey || "").trim()) {
    const hint = document.createElement("div");
    hint.className = "ds-topup-hint";
    hint.appendChild(
      document.createTextNode(I18n.t("还没有 API Key？官方充值通道：")),
    );
    const a = document.createElement("a");
    a.className = "ds-topup-link";
    a.href = DEEPSEEK_TOPUP_URL;
    a.textContent = DEEPSEEK_TOPUP_URL;
    a.title = DEEPSEEK_TOPUP_URL + I18n.t("（在浏览器中打开）");
    a.onclick = (ev) => {
      ev.preventDefault();
      try {
        if (window.api && window.api.openExternal) {
          window.api.openExternal(DEEPSEEK_TOPUP_URL);
          return;
        }
      } catch {}
      try {
        window.open(DEEPSEEK_TOPUP_URL, "_blank");
      } catch {}
    };
    hint.appendChild(a);
    gridEl.appendChild(hint);
  }

  const keyRow = mkField("API Key", (() => {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "4px";
    wrap.style.flex = "1";
    const inp = document.createElement("input");
    inp.type = "password";
    inp.value = prov.apiKey || "";
    inp.placeholder = "API Key";
    inp.style.flex = "1";
    inp.oninput = () => {
      prov.apiKey = inp.value;
      settingsSaved(800);
      /* DeepSeek 官方这条：清空 Key 横幅立刻回来、填上立刻收起（关窗时还会再对齐一次） */
      if (isDsOfficial) repaintSettingsTopup();
    };
    const cp = document.createElement("button");
    cp.className = "mini";
    cp.textContent = I18n.t("复制");
    cp.title = I18n.t("复制 API Key 到剪贴板");
    cp.type = "button";
    cp.onclick = (ev) => {
      ev.preventDefault();
      const v = prov.apiKey || "";
      if (!v) {
        toast(I18n.t("暂无 API Key"), "warn");
        return;
      }
      settingsClipboardWrite(v).then((r) =>
        r && r.ok
          ? toast(I18n.t("API Key 已复制到剪贴板"), "ok")
          : toast(I18n.t("复制失败，请手动选中后按 Ctrl+C 复制"), "err"),
      );
    };
    const testBtn = document.createElement("button");
    testBtn.className = "mini";
    testBtn.textContent = I18n.t("验证");
    testBtn.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
    testBtn.type = "button";
    testBtn.onclick = (ev) => {
      ev.preventDefault();
      validateProviderApiKey(prov, testBtn);
    };
    wrap.appendChild(inp);
    wrap.appendChild(testBtn);
    wrap.appendChild(cp);
    return wrap;
  })(), true);

  const modelField = document.createElement("div");
  modelField.className = "pf pf-wide";
  modelField.appendChild(
    document.createTextNode(I18n.t("模型列表（从上到下为使用优先级）")),
  );
  const orderBox = document.createElement("div");
  orderBox.className = "model-order";
  /* 拖动整行调整优先级：dragFrom 记录本次拖拽的源下标，-1 = 无拖拽。
     orderBox 级监听只挂一次（拖到列表底部空白处 = 移到末尾），行级监听每次重绘重建 */
  let dragFrom = -1;
  const clearDragUI = () => {
    dragFrom = -1;
    orderBox
      .querySelectorAll(".mo-dragging,.mo-drop-before,.mo-drop-after")
      .forEach((el) =>
        el.classList.remove("mo-dragging", "mo-drop-before", "mo-drop-after"),
      );
  };
  orderBox.addEventListener("dragover", (ev) => {
    if (dragFrom < 0) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  });
  orderBox.addEventListener("drop", (ev) => {
    if (dragFrom < 0) return;
    const rowEl = ev.target && ev.target.closest
      ? ev.target.closest(".model-order-row")
      : null;
    if (rowEl) return; /* 行内 drop 由各行的处理器负责 */
    ev.preventDefault();
    const from = dragFrom;
    clearDragUI();
    const arr = prov.models;
    if (from >= 0 && from < arr.length) {
      arr.push(arr.splice(from, 1)[0]);
      paintModels();
    }
  });
  /* 模型列表的每一次增删 / 排序都算一次改动；但「刚打开对话框画第一遍」不算，
     所以用 dirty 位把首次绘制排除掉，避免只是点开看一眼就写一份配置备份 */
  let modelsDirty = false;
  const paintModels = () => {
    if (!Array.isArray(prov.models)) prov.models = [];
    orderBox.innerHTML = "";
    prov.models.forEach((mid, mi) => {
      const row = document.createElement("div");
      row.className = "model-order-row";
      row.draggable = true;
      const idxEl = document.createElement("span");
      idxEl.className = "mo-idx";
      idxEl.textContent = String(mi + 1);
      const name = document.createElement("span");
      name.className = "mo-name" + (mi === 0 ? " pri" : "");
      name.textContent = mid;
      name.title =
        mi === 0
          ? I18n.t("当前优先使用") + " · " + mid
          : I18n.t("拖动或点击箭头调整优先级");
      /* 形态徽标：点一下在「文本 / 图像」间切换（写进 config.modelKinds 覆盖自动识别）。
         徽标文字 = 当前形态；手工指定的与自动识别的差别写在 tooltip 里。 */
      const kindBtn = document.createElement("button");
      kindBtn.type = "button";
      kindBtn.className = "pk-badge pk-btn pk-" + modelKindOf(S.config, prov.id, mid);
      const isOverride = !!modelKindOverride(S.config, prov.id, mid);
      kindBtn.textContent =
        modelKindOf(S.config, prov.id, mid) === "image"
          ? I18n.t("图像")
          : I18n.t("文本");
      kindBtn.title = isOverride
        ? I18n.t("已手工指定为") +
          I18n.t(modelKindOf(S.config, prov.id, mid) === "image" ? "图像" : "文本") +
          " · " +
          I18n.t("点击切回自动识别")
        : I18n.t("自动识别为") +
          I18n.t(modelKindOf(S.config, prov.id, mid) === "image" ? "图像模型" : "文本模型") +
          " · " +
          I18n.t("点击改为另一种（并记住）");
      kindBtn.onclick = (ev) => {
        ev.preventDefault();
        const cur = modelKindOf(S.config, prov.id, mid);
        const next = cur === "image" ? "text" : "image";
        if (isOverride && next === inferModelKind(mid)) {
          /* 切回自动识别：删掉这条覆盖 */
          const per = (S.config.modelKinds || {})[prov.id] || {};
          delete per[mid];
          if (!Object.keys(per).length) delete S.config.modelKinds[prov.id];
          else S.config.modelKinds[prov.id] = per;
        } else {
          if (!S.config.modelKinds) S.config.modelKinds = {};
          if (!S.config.modelKinds[prov.id]) S.config.modelKinds[prov.id] = {};
          S.config.modelKinds[prov.id][mid] = next;
        }
        /* 整卡片重画：形态提示行与「按模型纠正类型」按钮都跟着新形态走 */
        rerender();
      };
      const up = document.createElement("button");
      up.type = "button";
      up.className = "mini";
      up.textContent = "↑";
      up.title = I18n.t("提高优先级");
      up.disabled = mi === 0;
      up.onclick = (ev) => {
        ev.preventDefault();
        if (mi <= 0) return;
        const arr = prov.models;
        const t = arr[mi - 1];
        arr[mi - 1] = arr[mi];
        arr[mi] = t;
        paintModels();
      };
      const down = document.createElement("button");
      down.type = "button";
      down.className = "mini";
      down.textContent = "↓";
      down.title = I18n.t("降低优先级");
      down.disabled = mi >= prov.models.length - 1;
      down.onclick = (ev) => {
        ev.preventDefault();
        if (mi >= prov.models.length - 1) return;
        const arr = prov.models;
        const t = arr[mi + 1];
        arr[mi + 1] = arr[mi];
        arr[mi] = t;
        paintModels();
      };
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "mini";
      rm.textContent = "✕";
      rm.title = I18n.t("移除该模型");
      rm.onclick = (ev) => {
        ev.preventDefault();
        prov.models.splice(mi, 1);
        paintModels();
      };
      const grip = document.createElement("span");
      grip.className = "mo-grip";
      grip.textContent = "⠿";
      grip.title = I18n.t("拖动或点击箭头调整优先级");
      row.appendChild(grip);
      row.appendChild(idxEl);
      row.appendChild(name);
      /* llama.cpp 本地模型（插件托管那家）：状态徽标（未部署 / 加载中 / 运行中 / 加载失败）
         + 「部署 / 停止」两颗按钮 —— 状态由插件每次同步写进 prov.llamaModels（见
         llama/provider-sync.js 的 modelRows），这里只读它画；点按钮走 llama 宿主 IPC。 */
      if (llamaProviderManaged(prov)) {
        const lrow = llamaModelRowOf(prov, mid);
        if (lrow) {
          const stBadge = document.createElement("span");
          stBadge.className = "llama-st-badge llama-st-" + String(lrow.status || "downloaded");
          stBadge.textContent = I18n.t(llamaStatusTextOf(lrow));
          stBadge.title =
            I18n.t("本机 llama.cpp 的模型状态") +
            " · " +
            String(lrow.modelId || mid) +
            (lrow.error ? " · " + lrow.error : "") +
            (lrow.status === "downloaded"
              ? " · " + I18n.t("运行时会先自动加载它再继续（最多等 10 分钟）")
              : "");
          row.appendChild(stBadge);
          const running = lrow.status === "running";
          const busy = lrow.status === "starting";
          const act = document.createElement("button");
          act.type = "button";
          act.className = "mini";
          act.textContent = running ? I18n.t("停止") : I18n.t("部署");
          act.title = running
            ? I18n.t("停止这个本地模型（后端服务照旧运行）")
            : I18n.t("现在就把这个模型加载起来（首次可能要几十秒）");
          act.disabled = busy;
          act.onclick = async (ev) => {
            ev.preventDefault();
            const fn = running
              ? window.api && window.api.llamaStopModel
              : window.api && window.api.llamaDeployModel;
            if (typeof fn !== "function") {
              toast(I18n.t("当前版本不支持在设置里管理本地模型"), "warn");
              return;
            }
            act.disabled = true;
            act.textContent = running ? I18n.t("停止中…") : I18n.t("加载中…");
            let r = null;
            try {
              r = await fn(String(lrow.modelId || mid));
            } catch (err) {
              r = { ok: false, message: (err && err.message) || String(err) };
            }
            if (!r || !r.ok) {
              toast((r && (r.message || r.error)) || I18n.t("操作失败"), "err");
            } else {
              toast(running ? I18n.t("已停止本地模型") : I18n.t("本地模型已就绪"), "ok");
            }
            /* 先把插件刚写回盘上的那一份读回来（状态徽标跟着刷新），再重画这张卡 */
            try {
              await reloadConfigProvidersFromDisk();
            } catch {}
            rerender();
          };
          row.appendChild(act);
        }
      }
      /* 被白 / 黑名单排除的模型：照旧留在表里（还要能调优先级 / 删掉），但标出来
         「模型选择器里不会出现」—— 规则的效果一眼可见，不必去别处猜为什么选不到 */
      if (!providerModelAllowed(prov, mid)) {
        const out = document.createElement("span");
        out.className = "pk-badge pk-mix";
        out.textContent = I18n.t("策略外");
        out.title = I18n.t(
          "该模型被白名单 / 黑名单排除，不会出现在任何模型选择器里（这里仍可调顺序或删除）",
        );
        row.appendChild(out);
      }
      row.appendChild(kindBtn);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(rm);
      /* 拖动整行排序：从行身（含行名 / 抓手）拖起；按下按钮不算拖拽 */
      row.addEventListener("dragstart", (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest("button")) {
          ev.preventDefault();
          return;
        }
        dragFrom = mi;
        row.classList.add("mo-dragging");
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = "move";
          try {
            ev.dataTransfer.setData("text/plain", String(mi));
          } catch (e) {
            /* 个别平台不允许 setData 时仍可拖动，忽略 */
          }
        }
      });
      row.addEventListener("dragover", (ev) => {
        if (dragFrom < 0 || dragFrom === mi) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const r = row.getBoundingClientRect();
        const before = ev.clientY < r.top + r.height / 2;
        orderBox
          .querySelectorAll(".mo-drop-before,.mo-drop-after")
          .forEach((el) =>
            el.classList.remove("mo-drop-before", "mo-drop-after"),
          );
        row.classList.add(before ? "mo-drop-before" : "mo-drop-after");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("mo-drop-before", "mo-drop-after");
      });
      row.addEventListener("drop", (ev) => {
        if (dragFrom < 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const from = dragFrom;
        const arr = prov.models;
        if (from === mi || from < 0 || from >= arr.length || mi >= arr.length) {
          clearDragUI();
          return;
        }
        const r = row.getBoundingClientRect();
        const before = ev.clientY < r.top + r.height / 2;
        /* 以移动前数组语义计算落点：目标行前半 = 插到它前面，后半 = 插到它后面 */
        let to = mi;
        if (from < mi) to = before ? mi - 1 : mi;
        else to = before ? mi : mi + 1;
        clearDragUI();
        const item = arr.splice(from, 1)[0];
        arr.splice(to, 0, item);
        paintModels();
      });
      row.addEventListener("dragend", () => clearDragUI());
      orderBox.appendChild(row);
    });
    if (!prov.models.length) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.style.margin = "0";
      empty.textContent = I18n.t("暂无模型，请在下方添加");
      orderBox.appendChild(empty);
    }
    if (modelsDirty) settingsSaved(300);
  };
  paintModels();
  modelsDirty = true;
  modelField.appendChild(orderBox);
  /* llama.cpp 本地那家的两句实话（本轮共识 q10 / q14）：
     · 后端没启动：列表照旧是本机已下载的模型（都标「未部署」），选中时运行前会自动拉起后端再加载；
     · 安装目录冲突未决：端口上跑的是另一份脚手架，本机模型先不登记（去插件卡片上做选择）。 */
  if (llamaProviderManaged(prov)) {
    const sync = prov && prov.llamaSync ? prov.llamaSync : null;
    const hints = [];
    if (sync && sync.online === false) {
      hints.push(
        I18n.t(
          "llama.cpp 后端未启动：上面列的是本机已下载的模型（都标「未部署」）；选中其中任何一个，运行前会自动拉起后端并加载它。",
        ),
      );
    }
    if (sync && sync.conflict === true) {
      hints.push(
        I18n.t("安装目录冲突未决：端口上跑的是另一份 llama.cpp，本机模型暂不登记 —— 请到顶栏「插件」的 llama.cpp 卡片上选一次。"),
      );
    }
    for (const h of hints) {
      const hint = document.createElement("div");
      hint.className = "mo-kind-hint";
      hint.textContent = h;
      modelField.appendChild(hint);
    }
  }
  const addRow = document.createElement("div");
  addRow.className = "model-order-add";
  const addInp = document.createElement("input");
  addInp.type = "text";
  addInp.placeholder = I18n.t("添加模型 id，如 gpt-4o-mini");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "mini";
  addBtn.textContent = I18n.t("添加");
  const doAdd = () => {
    const id = String(addInp.value || "").trim();
    if (!id) return;
    if (!Array.isArray(prov.models)) prov.models = [];
    if (prov.models.includes(id)) {
      toast(I18n.t("模型已存在"), "warn");
      return;
    }
    prov.models.push(id);
    addInp.value = "";
    paintModels();
  };
  addBtn.onclick = (ev) => {
    ev.preventDefault();
    doAdd();
  };
  addInp.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      doAdd();
    }
  });
  addRow.appendChild(addInp);
  addRow.appendChild(addBtn);
  modelField.appendChild(addRow);
  /* 一键识别：按模型 id 家族特征词把每个模型标成文本 / 图像（清掉手工覆盖，
     回到纯自动识别）。徽标仍可逐个手改。 */
  const kindRow = document.createElement("div");
  kindRow.className = "mo-kind-hint";
  const detectBtn = document.createElement("button");
  detectBtn.type = "button";
  detectBtn.className = "mini";
  detectBtn.textContent = I18n.t("自动识别模型类型");
  detectBtn.title = I18n.t(
    "按模型 id 识别每个模型是文本模型还是图像生成模型，结果决定它在文本 / 图像节点与保存对话框里是否可选",
  );
  detectBtn.onclick = (ev) => {
    ev.preventDefault();
    const nImg = (prov.models || []).filter(
      (m) => inferModelKind(m) === "image",
    ).length;
    if (S.config.modelKinds) delete S.config.modelKinds[prov.id];
    paintModels();
    toast(
      I18n.t("已识别 ") +
        (prov.models || []).length +
        I18n.t(" 个模型 · 图像 ") +
        nImg +
        I18n.t(" · 文本 ") +
        ((prov.models || []).length - nImg),
      "ok",
    );
  };
  kindRow.appendChild(detectBtn);
  /* 实时获取：向服务商自身的 /models 端点要一份当前可用模型（纯 HTTP 元信息读取，
     不调用 AI、不消耗 Token），多选后批量加入上面的模型列表；老网关没有该端点时
     如实报错，用户继续手工添加。 */
  const fetchBtn = document.createElement("button");
  fetchBtn.type = "button";
  fetchBtn.className = "mini";
  fetchBtn.textContent = I18n.t("获取模型");
  fetchBtn.title = I18n.t(
    "实时向服务商接口读取当前可用的模型列表并一键加入（只读元信息，不消耗 Token）",
  );
  fetchBtn.onclick = (ev) => {
    ev.preventDefault();
    fetchModelsToProvider(prov, fetchBtn);
  };
  kindRow.appendChild(fetchBtn);
  /* 徽标口径挂在这一行上（指向两个动作按钮时不弹，见 setQTipIsControl） */
  settingsTipBeside(
    kindRow,
    "徽标 = 模型类型（点一下可改）；同一端点混挂文本与图像模型时会自动区分",
    "模型类型说明",
  );
  modelField.appendChild(kindRow);
  gridEl.appendChild(modelField);

  /* ── 模型白 / 黑名单（对标 OpenCode 的 provider 配置）──
     两个文本框都是**可选**字段：留空 = 不限制（老配置什么都不填 ⇒ 行为一字不变）。
     通配语义 * 零或多个字符、? 一个字符，其余字符按字面量；匹配对象是模型 id、大小写不敏感。
     白名单先收窄、黑名单再剔除，之后所有「给用户选模型」的地方（节点设置 / 智能会话 /
     全局助手 / 开发节点的下拉，以及上面这份模型列表的徽标）都按过滤结果说话。 */
  const allowInp = document.createElement("input");
  allowInp.type = "text";
  allowInp.value = String(prov.modelAllow || "");
  allowInp.placeholder = "deepseek-*";
  allowInp.oninput = () => {
    prov.modelAllow = allowInp.value;
    paintPolicyNote();
    settingsSaved(600);
  };
  /* 失焦 / 回车时才重画模型行徽标：打字过程中不整表重排，看得见效果又不必等 */
  allowInp.onchange = () => {
    prov.modelAllow = allowInp.value;
    paintModels();
  };
  mkField(
    I18n.t("模型白名单"),
    allowInp,
    true,
    "留空 = 不限制；支持 * 与 ? 通配；白名单先收窄，黑名单再剔除",
    "模型白名单说明",
  );

  const denyInp = document.createElement("input");
  denyInp.type = "text";
  denyInp.value = String(prov.modelDeny || "");
  denyInp.placeholder = "*-vision *-exp";
  denyInp.oninput = () => {
    prov.modelDeny = denyInp.value;
    paintPolicyNote();
    settingsSaved(600);
  };
  denyInp.onchange = () => {
    prov.modelDeny = denyInp.value;
    paintModels();
  };
  mkField(I18n.t("模型黑名单"), denyInp, true);

  /* 规则生效后的实时小结（写不出「结果」用户就得一个个去数）—— 属回显，常显 */
  const policyNote = document.createElement("div");
  policyNote.className = "settings-hint pf-wide";
  policyNote.style.margin = "0";
  gridEl.appendChild(policyNote);
  function paintPolicyNote() {
    const nAllow = modelPatterns(prov.modelAllow).length;
    const nDeny = modelPatterns(prov.modelDeny).length;
    const all = Array.isArray(prov.models) ? prov.models.length : 0;
    const keep = providerModelFilter(prov, prov.models).length;
    if (!nAllow && !nDeny) {
      policyNote.textContent = I18n.t("当前不限制：全部 ") + all + I18n.t(" 个模型都可用");
      return;
    }
    policyNote.textContent =
      I18n.t("白名单 ") +
      nAllow +
      I18n.t(" 条 · 黑名单 ") +
      nDeny +
      I18n.t(" 条 · 过滤后可用 ") +
      keep +
      " / " +
      all;
  }
  paintPolicyNote();

  /* ── 请求超时（三档，毫秒）──
     连接 = 建立 TCP 连接；首字节 = 发出请求后等第一个响应字节；分块 = 响应数据块之间的空闲。
     任一档到点都会中断这次请求，并报明是哪一档超时。留空 / 非正数 = 用缺省 300000
     （老配置不填这几个字段 ⇒ 与现状完全一致）。 */
  const mkTimeoutField = (label, key, tipText, tipLabel) => {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "0";
    inp.step = "1000";
    inp.placeholder = "300000";
    const n = Number(prov[key]);
    inp.value = Number.isFinite(n) && n > 0 ? String(Math.round(n)) : "";
    inp.oninput = () => {
      const v = Number(inp.value);
      if (inp.value.trim() !== "" && Number.isFinite(v) && v > 0) prov[key] = Math.round(v);
      /* 清空 = 回到缺省：把这个键删掉，读的时候一律按 300000 */
      else delete prov[key];
      settingsSaved(600);
    };
    mkField(I18n.t(label), inp, false, tipText, tipLabel);
  };
  mkTimeoutField(
    "连接超时（毫秒）",
    "timeoutConnect",
    "三档都是毫秒，缺省 300000；留空即用缺省。哪一档等超了就在报错里写明哪一档",
    "超时说明",
  );
  mkTimeoutField("首字节超时（毫秒）", "timeoutHeader");
  mkTimeoutField("分块超时（毫秒）", "timeoutChunk");

  /* ── 停用该服务商 ──
     停用只影响**可见性**：它不再出现在任何模型选择器里（节点 / 会话 / 助手 / 开发节点，
     以及「DeepSeek 官方」这条路由），但配置与密钥原样保留，卡片也照旧在这里，
     随时取消勾选即可恢复。画布上早就绑着它的节点不受影响（跑的还是原配置）。 */
  const offRow = document.createElement("label");
  offRow.className = "pf pf-inline";
  const offCb = document.createElement("input");
  offCb.type = "checkbox";
  offCb.checked = typeof providerManuallyOff === "function" && providerManuallyOff(prov);
  offCb.onchange = () => {
    if (offCb.checked) prov.disabled = true;
    else delete prov.disabled; /* 取消勾选就删键，老配置里根本没有它 */
    settingsSaved(0);
    /* 服务商网格上的「已停用」角标立刻回刷 */
    if (typeof settingsProvTilesRepaint === "function") settingsProvTilesRepaint();
  };
  offRow.appendChild(offCb);
  offRow.appendChild(document.createTextNode(I18n.t("停用该服务商")));
  /* 括注「配置与密钥保留」挂勾选项文字本身（悬停即出） */
  settingsTipBeside(
    offRow,
    "停用后不出现在模型选择器里（配置与密钥保留）",
    "停用说明",
  );
  gridEl.appendChild(offRow);

  card.appendChild(gridEl);
  return card;
}

/* ============ 帮助 ============ */

function openHelp() {
  openAppDocs();
}

/* 作者弹窗：居中小窗口。作者名 @ms2308 本身是 B 站主页链接，下方是「MTNode 主页」
   入口，末尾一行版本号 —— 两处都只显示文字、不显示网址（本轮需求）。 */
function openAuthorPopup() {
  openOverlay("");
  /* 尺寸 / 顶边色只走 .overlay-box.author-box 这个类：以前这里内联 cssText 改的是
     全应用共享的 .overlay-box，关窗后残留的 width/max-height 会被下一个弹窗
     （设置等）继承，变得又窄又高、超出视口后底部的关闭按钮够不着。 */
  const box = $("#overlay .overlay-box");
  if (box) box.classList.add("author-box");
  const body = $("#ovBody");
  const pop = document.createElement("div");
  pop.className = "author-pop";
  /* 作者名本身就是进 B 站主页的入口（本轮需求）：不再把 B 站网址当正文显示，
     文字只有 @ms2308，点它直接用系统浏览器打开空间页。 */
  const name = document.createElement("a");
  name.className = "author-name";
  name.textContent = "@ms2308";
  name.href = "https://space.bilibili.com/16411347";
  name.title = I18n.t("在浏览器中打开");
  name.onclick = (ev) => {
    ev.preventDefault();
    window.api.openExternal(name.href);
  };
  pop.appendChild(name);
  /* 名称下方就是 MTNode 主页入口：只显示「MTNode 主页」这几个字，不显示网址。 */
  const home = document.createElement("a");
  home.className = "author-link";
  home.textContent = I18n.t("MTNode 主页");
  home.href = "http://mt-agent.com/mtnode";
  home.title = I18n.t("在浏览器中打开主页与下载页");
  home.onclick = (ev) => {
    ev.preventDefault();
    window.api.openExternal(home.href);
  };
  pop.appendChild(home);
  const ver = document.createElement("div");
  ver.className = "author-ver";
  ver.textContent = "v" + S.appVersion;
  pop.appendChild(ver);
  body.appendChild(pop);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("关闭");
  ok.onclick = closeOverlay;
  foot.appendChild(ok);
}

/* ============ 渲染外壳 ============ */

function renderTop() {
  $("#wfName").value = S.wf ? S.wf.name : "";
  refreshWfSelect();
  renderWfWorkspace();
}
function renderStatus() {
  if (!S.wf) return;
  const bcount = S.wf.nodes.filter((n) => isBatchInput(n)).length;
  $("#statWf").textContent = I18n.t("画布：") + S.wf.name;
  $("#statCounts").textContent =
    S.wf.nodes.length +
    I18n.t(" 节点 · ") +
    S.wf.wires.length +
    I18n.t(" 连线") +
    (bcount ? I18n.t(" · 批量 ") + bcount : "");
  $("#statProviders").textContent = I18n.t("服务商 ") + S.config.providers.length;
  $("#statGrid").textContent = I18n.t("网格 ") + grid() + "px";
  $("#statZoom").textContent = Math.round(S.cam.z * 100) + "%";
  const st = $("#saveState");
  if (S.saving) {
    st.textContent = I18n.t("保存中…");
    st.className = "warn";
  } else if (S.lastSaved) {
    st.textContent = I18n.t("已保存 ") + fmtTime(S.lastSaved);
    st.className = "ok";
  } else {
    st.textContent = I18n.t("就绪");
    st.className = "";
  }
  updateRunQueuePanel();
}
function renderAll() {
  renderTop();
  renderCanvas();
  renderStatus();
  renderAssistPanel();
}


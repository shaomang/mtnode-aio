"use strict";
/* ============ 用户自建应用 · 新建流程 + 开发页归属（renderer 侧） ============
 *
 * 本文件只管两件事（库页 / 开发页入口调它，不自己画库页）：
 *
 * ① 新建应用流程 appsCreateDialog() / appsCreateApp(name, id)
 *    填「标题 + 文件夹名」→ window.api.appsCreate（主进程 apps-store.js 建目录与 app.json）
 *    → 建同名画布（**既有 workflow:save**，画布 id = 文件夹名，画布 json 上写 appId
 *      **与 workspace = 应用目录** —— 画布的工作目录是必填字段，见下面的 appCanvasWf）
 *    → 在该画布建一个开发节点（super + dev:true，devPath / subFolder 指向应用目录，
 *      devFiles 填应用目录里真实存在的核心文件）。
 *    画布在后台建好并居中到那个开发节点，但**创建后一律留在应用界面**：应用中心开着
 *    （用户就是从库页 / 开发页的「＋新建应用」进来的）就不收浮层、不返回画布，并把开发页
 *    切到这条新应用 —— 接着就能写第一条开发需求；要看画布走开发页工具栏的「打开画布」。
 *    画布 / 会话 / 开发节点全部落在数据目录与既有存储里，**不往应用文件夹写用户数据**；
 *    应用目录里那份 <AppName>.mtnodes 是主进程每次 workflow:save 顺手同步的镜像
 *    （main.js 的 writeWorkflowJson → apps-store.js 的 mirrorAppCanvas，供整目录迁移）。
 *
 * ② 开发页的会话归属 appIdOfDevNode() / appSessionsOf(appId) / openAppCanvas(appId)
 *    会话对象上的 appId 标记（新建开发会话时由 app.js 的 createDevSessionForNode 写入，
 *    随 config.json 落盘见 app-assist.js 的 persistAgentSession）只服务「开发页按应用
 *    过滤会话」这一处；总会话视图与 #agentSideList 的渲染逻辑一字未改。
 *    openAppCanvas 顺带补一刀老应用画布的空工作目录（见该函数里的注释）。
 *
 * 依赖都在调用期按 typeof 取（openOverlay / addNode / loadWorkflow / agentSessions…），
 * 所以本文件与它们的加载顺序无关；只需排在 window.api 就绪之后（index.html 的生态层）。
 */
const APP_WF_ID_RE = /^[A-Za-z0-9_-]{4,120}$/;

/* 文件夹名合法化提示（与主进程 apps-store.js createApp 同一口径）：
   它同时是画布 id（main.js wfIdOk），所以点 / 空格 / 中文一律不行。 */
function appFolderNameHint() {
  return I18n.t(
    "4–64 位字母 / 数字 / 下划线 / 连字符，不能含点、空格或中文（它同时是这张画布的 id）",
  );
}
/* 由标题推一个候选文件夹名（用户仍可改）：中文标题推不出 ASCII 时给一个时间戳兜底 */
function appSlugFromTitle(title) {
  const ascii = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (ascii.length >= 4) return ascii;
  return "app-" + Date.now().toString(36);
}

/* ---------- 应用画布对象 ----------
 *
 * 「新建应用」与「二次开发」两条路都建一张 id = 应用 id 的画布，两个建图点共用一个构造函数，
 * 免得以后再改画布字段时只改一处（上一轮漏的就是 workspace）。
 *
 * **workspace = 应用目录**是必须写的：画布的工作目录（顶栏「工作目录」）就是这张画布
 * 一切「相对路径」的落点基准 —— 左栏「文件」页默认根、新建保存节点的默认相对路径、
 * 相对路径校验、智能节点工作区兜底都读它。应用开发建的画布天然就是「这个应用的项目画布」
 * （画布上那个开发节点的 devPath / subFolder 也指向同一个目录），工作目录留空只会在
 * 顶栏显示「未设置」、左栏「文件」页显示「尚未设置工作目录」，用户还得自己再选一次同一个目录。
 * 由此定成必填字段：这里写死，调用方不再各自拼 wf 字面量。 */
function appCanvasWf(id, name, dir) {
  return {
    id: String(id || ""),
    name: String(name || ""),
    appId: String(id || ""),
    /* 工作目录 = 应用目录（见上）；取不到目录时留空，绝不用别处目录顶替。
       与顶栏设置工作目录同一口径：去掉尾部斜杠（只留根「/」「E:\」这种原样）。 */
    workspace: appCanvasWsPath(dir),
    nodes: [],
    wires: [],
    groups: [],
    marks: [],
  };
}
/* 工作目录的存储形态：去首尾空白 + 去尾部路径分隔符（`E:\apps\a\` → `E:\apps\a`）；
   根路径（`/`、`E:\`、`\\host\share`）去掉分隔符会变成没有意义的 `E:`，一律原样返回。 */
function appCanvasWsPath(dir) {
  const s = String(dir || "").trim();
  if (!s) return "";
  const cut = s.replace(/[\\/]+$/, "");
  if (!cut || /^[A-Za-z]:$/.test(cut)) return s;
  return cut;
}

/* ---------- 设计风格（新建时选 / 开发页换） ----------
 *
 * 风格清单的真源在主进程 apps-store.js 的 APP_STYLES（含每套风格的一句说明与色板）；
 * 每种风格都有一张**由同一份模板真实渲染出来**的首屏预览图（templates/app-default/
 * previews/<id>.png，随包），主进程读成 data URL 随 apps:styles 回给我们 —— 浮层是
 * 动态 DOM，拿不到模板目录，所以不拼路径、也不假设渲染层能读 file://。
 * 这里只做两件事：缓存清单 + 画卡片。两处入口（新建应用浮层、⋯ 菜单的「换风格…」）
 * 共用同一份卡片渲染，避免两套长得不一样的风格选择器。
 *
 * 「自定义」是清单里唯一一个**不是预设模板**的条目（载荷里带 custom:true）：它没有
 * previews/<id>.png、也没有 styles/<id>.css，卡片用占位视觉；选中它 = 让开发会话先问
 * 用户要什么风格（用户自己提要求，或让 AI 按应用用途先提几套方案），答案回来后再把这个
 * 应用的入口页做成那个样子 —— 见下面 startCustomStyleAsk() 与 appsCreateApp 的收尾。 */
const APP_STYLE_FALLBACK_ID = "minimal";
const APP_STYLE_CUSTOM_ID = "custom";
const APP_STYLE_ST = {
  list: null, /* 清单缓存（含 preview data URL）；null = 还没取过 */
  inflight: null, /* 取清单的进行中 Promise（浮层与开发页可能同时要） */
  def: APP_STYLE_FALLBACK_ID,
  custom: APP_STYLE_CUSTOM_ID, /* 主进程回的「自定义」那一个 id（老包缺字段就用常量） */
};
function appStylesCached() {
  return APP_STYLE_ST.list;
}
/* 取风格清单（带预览图）。appStylesLoad(true) = 强制重取（图片缓存不跟着翻新时会用到）。 */
function appStylesLoad(force) {
  if (!force && APP_STYLE_ST.list) return Promise.resolve(APP_STYLE_ST.list);
  if (!force && APP_STYLE_ST.inflight) return APP_STYLE_ST.inflight;
  const p = (async () => {
    try {
      const r = await window.api.appsStyles({ preview: true });
      if (r && r.ok && Array.isArray(r.styles) && r.styles.length) {
        APP_STYLE_ST.list = r.styles;
        APP_STYLE_ST.def = String(r.defaultStyle || APP_STYLE_FALLBACK_ID);
        APP_STYLE_ST.custom = String(r.customStyle || APP_STYLE_CUSTOM_ID);
        return APP_STYLE_ST.list;
      }
    } catch (_) {}
    /* 拿不到清单（桥被裁剪 / 老包）也不让界面空着：回落成「只有默认风格」的一张卡 */
    if (!APP_STYLE_ST.list) {
      APP_STYLE_ST.list = [
        {
          id: APP_STYLE_FALLBACK_ID,
          zh: I18n.t("极简"),
          en: "Minimal",
          why: "",
          swatch: [],
          preview: "",
        },
      ];
      APP_STYLE_ST.def = APP_STYLE_FALLBACK_ID;
    }
    return APP_STYLE_ST.list;
  })();
  APP_STYLE_ST.inflight = p;
  p.then(
    () => {
      if (APP_STYLE_ST.inflight === p) APP_STYLE_ST.inflight = null;
    },
    () => {
      if (APP_STYLE_ST.inflight === p) APP_STYLE_ST.inflight = null;
    },
  );
  return p;
}
function appStyleNameOf(styles, id, lang) {
  const s = (styles || []).find((x) => String(x.id) === String(id));
  if (!s) return String(id || "");
  return (lang === "en" ? s.en : s.zh) || s.zh || s.en || s.id;
}
/* 当前界面语言（i18n 的取值口径与渲染层其它地方一致：I18n.lang）。 */
function appStyleUiLang() {
  try {
    const l = String((I18n && I18n.lang) || "");
    if (/^en/i.test(l)) return "en";
  } catch (_) {}
  return "zh";
}
/* 这一条风格是不是「自定义」（载荷带 custom:true；清单还没取回来时按 id 兜底判断）。
   界面靠它决定：卡片画占位视觉、选中它要先走「问风格要求」那一轮。 */
function appStyleEntryIsCustom(s) {
  if (!s) return false;
  if (s.custom === true) return true;
  return (
    String(s.id || "").toLowerCase() ===
    String(APP_STYLE_ST.custom || APP_STYLE_CUSTOM_ID).toLowerCase()
  );
}
/* app.json 里那份风格值 → 卡片要显示的那一个 id：
   认得的预设直接用；「自定义」原样保留（不是回落极简，否则用户看不到自己当初选了什么）。 */
function appStyleStoredId(style, styles) {
  const id = String(style == null ? "" : style).trim();
  if (!id) return APP_STYLE_ST.def || APP_STYLE_FALLBACK_ID;
  const list = styles || appStylesCached() || [];
  const lower = id.toLowerCase();
  const hit = list.find((s) => String(s.id || "").toLowerCase() === lower);
  return hit ? String(hit.id) : APP_STYLE_ST.def || APP_STYLE_FALLBACK_ID;
}
/* 卡片网格：一组 radio（键盘可用、点击整张卡选中）。
   每张卡 = 预览图（缺图回落色板）+ 风格名 + 一句说明；选中的那张有明确的边框与角标。
   返回 { grid, get(), set(id) }。 */
function appsStyleCards(opt) {
  const o = opt || {};
  const styles = o.styles || appStylesCached() || [];
  const lang = appStyleUiLang();
  const grid = document.createElement("div");
  grid.className = "style-grid";
  grid.setAttribute("role", "radiogroup");
  if (o.ariaLabel) grid.setAttribute("aria-label", o.ariaLabel);
  /* 选中态初值：o.value 认得就沿用它（含「自定义」），否则回默认那一套 */
  let cur = appStyleStoredId(o.value, styles) || String(APP_STYLE_ST.def || APP_STYLE_FALLBACK_ID);
  const boxes = new Map();
  const inputs = [];
  for (const s of styles) {
    const id = String(s.id || "");
    const card = document.createElement("label");
    card.className = "style-card";
    if (id === cur) card.classList.add("on");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = o.name || "app-style";
    radio.value = id;
    radio.checked = id === cur;
    radio.className = "style-radio";
    card.appendChild(radio);
    const shot = document.createElement("span");
    shot.className = "style-shot";
    if (appStyleEntryIsCustom(s)) {
      /* 「自定义」没有预览图（它的长相还没定）：画一个占位方块 + 一句话说清选中后会发生什么，
         绝不回落到别的风格的首屏图 —— 那会让用户以为自己选的是那一套。 */
      const ph = document.createElement("span");
      ph.className = "style-shot-custom";
      const mark = document.createElement("i");
      mark.textContent = "✎";
      mark.setAttribute("aria-hidden", "true");
      ph.appendChild(mark);
      const word = document.createElement("b");
      word.textContent = I18n.t("先问再定");
      ph.appendChild(word);
      shot.appendChild(ph);
    } else if (s.preview) {
      const img = document.createElement("img");
      img.className = "style-shot-img";
      img.src = s.preview;
      img.alt = appStyleNameOf(styles, id, lang) + I18n.t("风格预览图");
      img.loading = "lazy";
      img.decoding = "async";
      shot.appendChild(img);
    } else {
      /* 没有预览图（老包 / 图被裁掉）：用色板顶一顶，别留一个空洞 */
      const sw = document.createElement("span");
      sw.className = "style-swatch";
      for (const c of s.swatch || []) {
        const dot = document.createElement("i");
        dot.style.background = String(c);
        sw.appendChild(dot);
      }
      shot.appendChild(sw);
    }
    card.appendChild(shot);
    const meta = document.createElement("span");
    meta.className = "style-meta";
    const nm = document.createElement("b");
    nm.className = "style-name";
    nm.textContent = appStyleNameOf(styles, id, lang);
    meta.appendChild(nm);
    if (id === String(APP_STYLE_ST.def)) {
      const tag = document.createElement("span");
      tag.className = "style-tag";
      tag.textContent = I18n.t("默认");
      tag.title = I18n.t("新建应用时的默认风格");
      meta.appendChild(tag);
    }
    if (appStyleEntryIsCustom(s)) {
      /* 一句话把「这条不是预设模板、选中会被问一句」钉在卡片上，
         用户点它之前就知道接下来会发生什么 */
      const tag = document.createElement("span");
      tag.className = "style-tag style-tag-custom";
      tag.textContent = I18n.t("先问要什么风格");
      tag.title = I18n.t("选中它：开发会话先问你要什么风格（你提要求，或让 AI 按用途提几套方案），再照答案做这个应用");
      meta.appendChild(tag);
    }
    if (o.showCurrent && id === String(o.current || "")) {
      const tag = document.createElement("span");
      tag.className = "style-tag style-tag-cur";
      tag.textContent = I18n.t("当前");
      meta.appendChild(tag);
    }
    const why = document.createElement("span");
    why.className = "style-why";
    why.textContent = String((lang === "en" ? s.whyEn : s.why) || s.why || "");
    meta.appendChild(why);
    card.appendChild(meta);
    const setOn = (id2) => {
      cur = String(id2);
      for (const [k, el] of boxes) el.classList.toggle("on", k === cur);
      const hit = inputs.find((r) => r.value === cur);
      if (hit) hit.checked = true;
      if (typeof o.onPick === "function") o.onPick(cur);
    };
    radio.onchange = () => setOn(id);
    card.onclick = (ev) => {
      if (ev && ev.target === radio) return;
      setOn(id);
    };
    boxes.set(id, card);
    inputs.push(radio);
    grid.appendChild(card);
  }
  return {
    grid: grid,
    get: () => cur,
    set: (id) => {
      const k = String(id);
      if (boxes.has(k)) {
        cur = k;
        for (const [kk, el] of boxes) el.classList.toggle("on", kk === cur);
        const hit = inputs.find((r) => r.value === cur);
        if (hit) hit.checked = true;
      }
    },
  };
}

/* ---------- ① 新建应用 ---------- */

/* 打开「新建应用」对话框（库页 / 开发页的入口就是这一个函数）。 */
function appsCreateDialog() {
  openOverlay(I18n.t("新建应用"), { persistent: true });
  const body = $("#ovBody");

  const nameLab = document.createElement("label");
  nameLab.className = "n-field";
  nameLab.appendChild(document.createTextNode(I18n.t("应用标题")));
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.placeholder = I18n.t("给用户看的名字（库页卡片与窗口标题都用它）");
  nameLab.appendChild(nameInp);
  body.appendChild(nameLab);

  const idLab = document.createElement("label");
  idLab.className = "n-field";
  idLab.style.marginTop = "10px";
  idLab.appendChild(document.createTextNode(I18n.t("文件夹名")));
  const idInp = document.createElement("input");
  idInp.type = "text";
  idInp.placeholder = "my-app";
  idLab.appendChild(idInp);
  const idHint = document.createElement("div");
  idHint.className = "settings-hint";
  idHint.style.marginTop = "6px";
  idHint.textContent = appFolderNameHint();
  idLab.appendChild(idHint);
  body.appendChild(idLab);

  /* 设计风格：每张卡是「同一份模板按该风格真实渲染出来的首屏」+ 风格名 + 一句说明。
     清单与预览图从主进程取（apps:styles）；还没取回来时这块先占位，取回后原样换上 ——
     取不到也留一张「极简」，界面绝不会因为风格清单缺失而空着或报错。 */
  const styleLab = document.createElement("div");
  styleLab.className = "n-field style-field";
  const styleHead = document.createElement("div");
  styleHead.className = "style-head";
  const styleTitle = document.createElement("span");
  styleTitle.className = "style-title";
  styleTitle.textContent = I18n.t("设计风格");
  styleHead.appendChild(styleTitle);
  const styleHint = document.createElement("span");
  styleHint.className = "style-hint";
  styleHint.textContent = I18n.t("决定这个应用入口页的长相；建好之后也能在开发页「⋯ → 换风格…」里换");
  styleHead.appendChild(styleHint);
  styleLab.appendChild(styleHead);
  const styleHost = document.createElement("div");
  styleHost.className = "style-host";
  styleLab.appendChild(styleHost);
  const styleNote = document.createElement("div");
  styleNote.className = "settings-hint style-note";
  styleNote.textContent = I18n.t("预览图就是每种风格真实渲染出来的样子");
  styleLab.appendChild(styleNote);
  /* 选中「自定义」时这里换一句话：说清它没有预设长相、接下来会发生什么 */
  const styleAskNote = document.createElement("div");
  styleAskNote.className = "settings-hint style-note style-note-custom";
  styleAskNote.hidden = true;
  styleAskNote.textContent = I18n.t(
    "选「自定义」= 不套预设长相：建好后开发会话会先问你要什么风格（你直接说要求，或让 AI 按这个应用的用途先提几套方案），再照答案把入口页做出来。",
  );
  styleLab.appendChild(styleAskNote);
  body.appendChild(styleLab);

  let styleCards = null;
  const styleReady = appStylesLoad().then((list) => {
    if (!styleHost.isConnected) return null; /* 浮层已经关了：不用再画 */
    styleCards = appsStyleCards({
      styles: list,
      value: APP_STYLE_ST.def,
      name: "app-style-new",
      ariaLabel: I18n.t("设计风格"),
      /* 本地图 + 这一段说明：选中「自定义」时把上面那句话亮出来 */
      onPick: (id) => {
        const s = (list || []).find((x) => String(x.id) === String(id));
        styleAskNote.hidden = !appStyleEntryIsCustom(s);
        /* 这句是给用户看的落点提示：选了自定义，创建后要去开发页答一句风格 */
        styleNote.textContent = appStyleEntryIsCustom(s)
          ? I18n.t("创建后会停在开发页：接着答一句「要什么风格」，AI 就照它做入口页")
          : I18n.t("预览图就是每种风格真实渲染出来的样子");
      },
    });
    styleHost.textContent = "";
    styleHost.appendChild(styleCards.grid);
    return styleCards;
  });

  const rootHint = document.createElement("div");
  rootHint.className = "settings-hint";
  rootHint.style.marginTop = "10px";
  rootHint.textContent = I18n.t("应用会建在应用库根目录下的这个文件夹里（根目录可在库页修改）");
  body.appendChild(rootHint);
  window.api
    .appsRootGet()
    .then((r) => {
      if (r && r.ok && r.path) rootHint.textContent = I18n.t("应用目录：") + r.path;
    })
    .catch(() => {});

  /* 标题 → 文件夹名联动预填，用户一旦自己改过文件夹名就不再覆盖 */
  let idTouched = false;
  idInp.oninput = () => {
    idTouched = true;
  };
  nameInp.oninput = () => {
    if (!idTouched) idInp.value = appSlugFromTitle(nameInp.value);
  };

  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("创建");
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  ok.onclick = async () => {
    const name = String(nameInp.value || "").trim();
    const id = String(idInp.value || "").trim();
    if (!name) {
      toast(I18n.t("请填写应用标题"), "err");
      nameInp.focus();
      return;
    }
    if (!APP_WF_ID_RE.test(id)) {
      toast(I18n.t("文件夹名不合法：") + appFolderNameHint(), "err");
      idInp.focus();
      return;
    }
    ok.disabled = true;
    const r = await appsCreateApp(name, id, styleCards ? styleCards.get() : "");
    ok.disabled = false;
    if (r) closeOverlay();
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
  nameInp.focus();
  /* 清单晚一点到也无妨：用户先填标题 / 文件夹名，卡片落位后照常点「创建」 */
  styleReady.catch(() => {});
}

/* 新建应用的执行体：建目录 → 建同名画布（workflow:save）→ 建开发节点 → 留在应用界面。
   画布在后台建好并居中；只有应用中心没开（外部直接调 appsCreateApp）才切到画布。
   style = 选中的设计风格 id（空 = 默认）。成功回 { id, name, dir, wfId, nodeId, style }，
   失败回 null（错误已 toast）。 */
async function appsCreateApp(name, id, style) {
  const nm = String(name || "").trim();
  const aid = String(id || "").trim();
  if (!nm) {
    toast(I18n.t("请填写应用标题"), "err");
    return null;
  }
  if (!APP_WF_ID_RE.test(aid)) {
    toast(I18n.t("文件夹名不合法：") + appFolderNameHint(), "err");
    return null;
  }
  let res = null;
  /* 应用根目录没配过：先让用户选一个（与「下载应用」同一前置 —— 绝不让新建的应用
     落在用户没见过的默认目录里）。应用中心不在也照常跑：主进程用默认根目录。 */
  try {
    if (typeof appsEnsureRoot === "function") {
      const rootOk = await appsEnsureRoot();
      if (!rootOk) return null;
    }
  } catch (_) {}
  try {
    res = await window.api.appsCreate(nm, aid, String(style || ""), appFlowMeName());
  } catch (err) {
    toast(I18n.t("新建应用失败：") + ((err && err.message) || String(err)), "err");
    return null;
  }
  if (!res || !res.ok) {
    toast(
      I18n.t("新建应用失败：") +
        ((res && (res.error || res.reason)) || I18n.t("未知错误")),
      "err",
    );
    return null;
  }
  /* 画布：id = 文件夹名（与 createWorkflowNamed 同一条路：前台画布 + 既有 workflow:save）。
     appId 是本画布与应用目录的关联标记，主进程每次落盘据此同步镜像 .mtnodes；
     workspace = 应用目录（画布的工作目录必填，见 appCanvasWf）。 */
  const wf = appCanvasWf(res.id, res.name, res.dir);
  clearHistory();
  setForegroundWf(wf);
  reviveWf(res.id); /* 同名画布曾被删过：新建的是一张全新画布，解禁它的 id */
  try {
    await window.api.wfSave(res.id, wf);
  } catch (err) {
    /* 目录已建好、画布没落盘：明确说出来，别让用户以为一切正常 */
    toast(
      I18n.t("应用目录已建好，但画布保存失败：") +
        ((err && err.message) || String(err)),
      "err",
    );
    return null;
  }
  S.config.activeWorkflowId = res.id;
  await window.api.configSave(S.config);
  rememberWf(S.wf);
  /* 视图与相机都只在**后台**摆好（应用中心整屏盖着，用户看不到这一层）：focusNode 的居中
     要读 #canvas 的实际尺寸，会话 / 团队视图下它是 display:none（宽度 0 → 相机算到视口外），
     所以照旧先切到画布视图 —— 「不返回画布」指的不是这层状态，而是不收浮层、不把用户送走。 */
  setView("workflow");
  renderAll();
  trackWorkflow(res.id, S.wf.name);
  try {
    await refreshWfSelect();
  } catch (_) {}
  /* 该画布上的第一个开发节点 = 这个应用的功能块（项目根与子文件夹都指向应用目录） */
  const node = appsCreateDevNode(res);
  if (node) focusNode(node.id); /* 后台居中到开发节点（关掉应用中心时才看得到） */
  renderAll();
  scheduleSave(true);
  /* 应用中心（renderer/app-apps.js）：① 它的本机列表带缓存 —— 强制重拉一次，库页 / 开发页
     立刻就能看到这条新应用；② 应用中心正开着（用户就是从「应用界面」里点的「＋新建应用」）
     → **留在应用界面**：不收浮层、不返回画布，把开发页切到这条新应用，接着就能写第一条
     开发需求。两处都按 typeof 探测，应用中心不在也照常跑完。 */
  try {
    if (typeof appsListLoad === "function") await appsListLoad(true);
  } catch (_) {}
  try {
    if (typeof appsHubIsOpen === "function" && appsHubIsOpen()) {
      /* 开发页切到这条新应用（只重绘本页：库页停在库页、开发页换成新应用，都不回画布）；
         开发页模块缺席时至少重绘一次，别让清单停在旧内容上。 */
      if (typeof appsDevSelectApp === "function") appsDevSelectApp(res.id);
      else if (typeof appsHubPaint === "function") appsHubPaint();
    }
  } catch (_) {}
  /* 选了「自定义」：创建完就停在开发页的输入框上问风格 —— 用户提要求，或让 AI 先提方案
     （见 startCustomStyleAsk）。这一步只放一句提问、不动画布，也不替用户开工。 */
  if (typeof startCustomStyleAsk === "function") {
    try {
      startCustomStyleAsk(res.id, String(res.name || nm), "custom");
    } catch (_) {}
  }
  toast(I18n.t("已新建应用：") + res.name, "ok");
  return {
    id: res.id,
    name: res.name,
    dir: res.dir,
    root: res.root,
    wfId: res.id,
    nodeId: node ? node.id : "",
    style: String(res.style || style || ""),
  };
}

/* ---------- ①b 二次开发（库页每张卡片右侧的「二次开发」按钮） ----------
 *
 * 与「新建应用」同规格：写 dev 标记（库页据此不再列它、开发页据此列它）+ 建同名画布 +
 * 在画布上建开发节点（devPath 指向应用目录）—— **应用目录原地不动**，一个字节都不搬。
 *
 * 同 id 冲突一律拒绝（避免误覆盖）：本机已有同名画布就直接停手并说清 —— 应用目录同名是
 * 本动作的前提（要迁的那个已经在那儿），所以只需要判画布这一条。
 *
 * 作者：app.json 里已经写过就不动它；没写过才把当前登录账号写进去（未登录就不写）。
 * 返回 { id, name, wfId, nodeId }；失败回 null（错误已 toast）。 */
function appFlowMeName() {
  try {
    const A = window.MTNodeAuth;
    const st = A && typeof A.state === "function" ? A.state() || {} : {};
    return st.signedIn && st.user ? String(st.user.username || "").trim() : "";
  } catch (_) {
    return "";
  }
}
async function appsMigrateToDev(appId) {
  const id = String(appId || "").trim();
  if (!id) return null;
  if (!APP_WF_ID_RE.test(id)) {
    toast(I18n.t("应用 id 不合法"), "err");
    return null;
  }
  const app = typeof appsLocalById === "function" ? appsLocalById(id) : null;
  if (!app) {
    toast(I18n.t("这个应用不在本机：先在应用中心下载或新建它"), "err");
    return null;
  }
  if (app.dev === true) {
    toast(I18n.t("这个应用已经在开发中（在「开发」页）"), "warn");
    return null;
  }
  /* 同名画布（= 同 id）：建第二张会当场覆盖前一张的内容，宁可停下来说清楚 */
  let wfList = null;
  try {
    wfList = await window.api.wfList();
  } catch (_) {
    wfList = null;
  }
  if (Array.isArray(wfList) && wfList.some((w) => w && String(w.id) === id)) {
    toast(
      I18n.t("已经有一张同名画布（") +
        id +
        I18n.t("）：为避免误覆盖，没有迁移。请先改名或删掉那张画布再试。"),
      "err",
    );
    return null;
  }
  /* ① 写 dev 标记（顺带补作者：app.json 没写过作者才写当前登录账号） */
  const me = appFlowMeName();
  try {
    const meta = await window.api.appsSetMeta(id, {
      dev: true,
      author: String(app.author || "").trim() || me,
    });
    if (!meta || meta.ok === false) {
      toast(
        I18n.t("二次开发失败：") + ((meta && (meta.error || meta.reason)) || I18n.t("未知错误")),
        "err",
      );
      return null;
    }
  } catch (err) {
    toast(I18n.t("二次开发失败：") + ((err && err.message) || String(err)), "err");
    return null;
  }
  /* ② 同名画布（id = 应用 id，与新建应用同一条路：前台画布 + workflow:save）
     + workspace = 应用目录（画布的工作目录必填，见 appCanvasWf） */
  const wf = appCanvasWf(id, String(app.name || id), app.dir);
  clearHistory();
  setForegroundWf(wf);
  reviveWf(id); /* 同名画布曾被删过：这次建的是一张全新画布，解禁它的 id */
  try {
    await window.api.wfSave(id, wf);
  } catch (err) {
    toast(
      I18n.t("已登记为开发中，但画布保存失败：") + ((err && err.message) || String(err)),
      "err",
    );
    return null;
  }
  S.config.activeWorkflowId = id;
  await window.api.configSave(S.config);
  rememberWf(S.wf);
  setView("workflow");
  renderAll();
  trackWorkflow(id, S.wf.name);
  try {
    await refreshWfSelect();
  } catch (_) {}
  /* ③ 开发节点（与新建应用同一个实现：devPath / devFiles 都指向应用目录里的真实文件） */
  const node = appsCreateDevNode({
    id: id,
    name: app.name,
    dir: app.dir,
    coreFiles: Array.isArray(app.coreFiles) ? app.coreFiles : [],
  });
  if (node) focusNode(node.id);
  renderAll();
  scheduleSave(true);
  try {
    if (typeof appsListLoad === "function") await appsListLoad(true);
  } catch (_) {}
  return { id: id, name: String(app.name || id), wfId: id, nodeId: node ? node.id : "" };
}

/* 选了「自定义」风格之后那一步：把用户领回开发页的输入框，问一句「要什么风格」。
 *
 * 为什么落在这里而不是直接替用户开工：本流程的用户是**选了一个没有预设长相的风格**，
 * 接下来的输入必须由他给（要么一句自己的风格要求，要么一句「你按这个应用提几套方案」）。
 * 所以这一步只做三件事：① 把这一问交给开发页；② 由开发页往输入框填一句可直接发送的提问
 * （+ 一条 toast 说明）；③ 用户点发送 = 正常走首轮开发会话（createDevSessionForNode），
 * 会话会把「这一轮先问清风格、再动代码」的约束一并带给 Agent（见 appsDevStartDevSession）。
 * 输入框里已经有的字（用户自己打了一半）不覆盖 —— 那种情况下只给 toast 提示。
 *
 * 调用时机不一定是「开发页已经开着」：新建应用时用户常常还停在「库」页。开发页那边对
 * 这一问是**排队**的（appsDevAskStyle → DEVD.askStyleId），画到输入框时自动落下去，不会丢。
 * 返回 true = 此刻已经落到输入框上；false = 排着队（调用方补一句「去哪儿答」的 toast）。 */
function startCustomStyleAsk(appId, appName, mode) {
  const id = String(appId || "").trim();
  if (!id) return false;
  const name = String(appName || id).trim() || id;
  /* mode = "swap"：用户是主动换风格，让他自己写更好；"custom"（新建）给一句可直接发的默认问法 */
  const def =
    String(mode || "") === "swap"
      ? I18n.t("给「") + name + I18n.t("」定个风格：我的要求是 ")
      : I18n.t("先问你：这个应用（") +
        name +
        I18n.t("）用什么风格？你按它的用途提几套方案，或我直接说我的要求");
  if (typeof appsDevAskStyle !== "function") return false;
  const done = !!appsDevAskStyle(id, def);
  if (!done) {
    /* 开发页此刻没开（用户多半还停在「库」页）：这一问已排在开发页那边，
       等他走进开发页就会落在输入框上，所以这里只补一句「去哪儿答」 */
    toast(
      I18n.t("风格选了「自定义」：到开发页说一句要什么风格，AI 就照它做入口页"),
      "ok",
    );
  }
  return done;
}

/* ---------- ② 换风格（开发页 ⋯ 菜单那一项） ---------- *
 * 应用目录里的入口页是「新建时从模板生成的一份独立文件」，模板升级不会自动跟过去，
 * 所以换风格 = 按所选风格**重写入口页**（主进程 apps:setStyle）。确认框里写明会覆盖：
 * 用户后来在入口页里手改过的内容会没了 —— 这是本轮明确的口径（不生成备份），
 * 所以确认这一步不能省，也不许默默替换。
 *
 * 「自定义」是这里的一个特例：它没有模板可套，所以**不重写入口页**，而是记下这个选择
 * 并把用户领回开发页的输入框去答一句「要什么风格」（startCustomStyleAsk）——
 * 等答案回来，会话才照它把入口页做成那个样子。确认框在自定义时换成询问口径。 */
function appStyleSwapDialog(appId, appName, currentStyle) {
  const id = String(appId || "");
  if (!id) return;
  const curId = appStyleStoredId(currentStyle);
  openOverlay(I18n.t("换风格"), { persistent: true });
  const body = $("#ovBody");
  const lead = document.createElement("div");
  lead.className = "settings-hint style-swap-lead";
  lead.textContent =
    I18n.t("选一种设计风格，按它重写这个应用的入口页：") +
    String(appName || id);
  body.appendChild(lead);
  const host = document.createElement("div");
  host.className = "style-host";
  body.appendChild(host);
  const warn = document.createElement("div");
  warn.className = "settings-hint style-warn";
  const warnText = () =>
    I18n.t(
      "入口页会被这份风格模板覆盖：你在应用目录里手改过的页面内容会没了（assets/ 与数据文件夹不受影响）。",
    );
  const warnCustom = () =>
    I18n.t(
      "选「自定义」不会套任何模板：只记下这个选择，把你带回开发页答一句「要什么风格」（你提要求，或让 AI 按这个应用的用途先提几套方案），再照答案重做入口页。",
    );
  warn.textContent = warnText();
  body.appendChild(warn);

  let cards = null;
  const ready = appStylesLoad().then((list) => {
    if (!host.isConnected) return null;
    cards = appsStyleCards({
      styles: list,
      value: curId,
      current: curId,
      showCurrent: true,
      name: "app-style-swap",
      ariaLabel: I18n.t("设计风格"),
      /* 选中「自定义」时把下面那段说明与主按钮文案一起换成自定义口径 */
      onPick: (pid) => {
        const s = (list || []).find((x) => String(x.id) === String(pid));
        const cu = appStyleEntryIsCustom(s);
        warn.textContent = cu ? warnCustom() : warnText();
        ok.textContent = cu
          ? I18n.t("记下选择，去答「要什么风格」")
          : I18n.t("换风格并重写入口页");
      },
    });
    host.textContent = "";
    host.appendChild(cards.grid);
    return cards;
  });

  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("换风格并重写入口页");
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  ok.onclick = async () => {
    await ready.catch(() => {});
    const picked = cards ? cards.get() : curId;
    if (String(picked) === String(curId || "")) {
      toast(I18n.t("已经是这个风格了"));
      return;
    }
    const name = appStyleNameOf(appStylesCached(), picked, appStyleUiLang());
    const pickedCustom = (() => {
      const s = (appStylesCached() || []).find((x) => String(x.id) === String(picked));
      return appStyleEntryIsCustom(s);
    })();
    /* 确认这一步是口径里要求的「弹一次确认」；确认后不备份、直接重写 */
    if (typeof confirmDialog === "function") {
      const yes = await confirmDialog(
        pickedCustom
          ? I18n.t(
              "会把这个应用的风格记成「自定义」，然后带你回开发页答一句「要什么风格」；这一轮不重写入口页，等风格定下来才按它重做。",
            )
          : I18n.t(
              "会用这套风格的模板重写应用目录里的入口页（index.html）。你在里面手改过的页面内容会没了，assets/ 与数据文件夹不受影响。",
            ),
        {
          title: pickedCustom
            ? I18n.t("改成「自定义」风格？")
            : I18n.t("换成「") + name + I18n.t("」风格？"),
          okText: pickedCustom
            ? I18n.t("记下选择并去答一句")
            : I18n.t("换风格并重写入口页"),
          cancelText: I18n.t("取消"),
        },
      );
      if (!yes) return;
    }
    ok.disabled = true;
    let r = null;
    try {
      r = await window.api.appsSetStyle(id, picked);
    } catch (err) {
      r = { ok: false, error: (err && err.message) || String(err) };
    }
    ok.disabled = false;
    if (!r || !r.ok) {
      toast(I18n.t("换风格失败：") + ((r && (r.error || r.reason)) || I18n.t("未知错误")), "err");
      return;
    }
    /* 应用列表带缓存：重拉一次，开发页 / 库页都看到新的风格标记 */
    try {
      if (typeof appsListLoad === "function") await appsListLoad(true);
    } catch (_) {}
    closeOverlay();
    if (pickedCustom) {
      /* 自定义：入口页这一轮不动（主进程写的是 minimal 那套），把用户带到开发页答风格 */
      toast(
        I18n.t("已把风格记成「自定义」：在开发页答一句要什么风格，AI 就照它做入口页"),
        "ok",
      );
      if (typeof startCustomStyleAsk === "function") {
        try {
          startCustomStyleAsk(id, String(appName || id), "swap");
        } catch (_) {}
      }
      return;
    }
    toast(I18n.t("已换成「") + name + I18n.t("」风格"));
    /* 入口页变了：按开发页既有那条链校验 + 重载预览（维持状态开关照旧生效） */
    try {
      if (typeof appsDevCheckPreview === "function") await appsDevCheckPreview(true);
    } catch (_) {}
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
  ready.catch(() => {});
}

/* 在（刚建好的）应用画布上建开发节点：super + dev:true，devPath / subFolder = 应用目录，
   devFiles = 该目录里真实存在的核心文件（≤10 条 · 相对项目根，口径见 app-devnode.js）。 */
function appsCreateDevNode(app) {
  const dir = String((app && app.dir) || "");
  const nodes = (S.wf && S.wf.nodes) || [];
  const before = nodes.length;
  addNode("super", 120, 120, {
    dev: true,
    devKind: "module",
    devStatus: "pending",
    title: String((app && app.name) || "") || I18n.t("功能块"),
    /* 归属标记：开发页按它把该应用的功能块与画布 / 会话串起来 */
    appId: String((app && app.id) || ""),
    devPath: dir,
    subFolder: dir,
    /* 两段式概述（docs/dev-node-design.md §6）：【功能】/【实现】是**固定中文标记**
       （app-devnode.js 的 devNoteParts 按字面量切分），不要跟着界面语言翻译。 */
    note:
      "【功能】" +
      I18n.t("这个应用给用户做什么（待补全）。") +
      "\n" +
      "【实现】" +
      I18n.t("入口 index.html + app.json；宿主能力走 window.appHost（文本 / 图像生成、本机存储、账号摘要），模型与工具留在主进程与画布一侧。"),
  });
  /* addNode 的返回值是 undefined（它只入数组）：按调用前后取刚追加的那个节点 */
  const node = nodes.length > before ? nodes[nodes.length - 1] : null;
  if (!node || !node.dev) return null;
  const files = Array.isArray(app && app.coreFiles) ? app.coreFiles : [];
  node.devFiles =
    typeof devCoreFilesNormalize === "function"
      ? devCoreFilesNormalize(files, node)
      : files.slice(0, 10);
  return node;
}

/* ---------- ② 开发页：应用 ↔ 画布 / 开发节点 / 会话 ---------- */

/* 节点（或它所在画布）属于哪个「应用」；"" = 不属于任何应用。 */
function appIdOfDevNode(node) {
  if (!node) return "";
  const own = String(node.appId || "").trim();
  if (own) return own;
  try {
    const w =
      typeof ownerWfOfNode === "function" ? ownerWfOfNode(node) : S.wf;
    if (w && w.appId) return String(w.appId).trim();
  } catch (_) {}
  return "";
}
/* 该画布上的开发节点（应用功能块）：先认带 appId 的那个，再退回第一个有项目根的功能块。 */
function appsDevNodeOfWf(wf) {
  const w =
    wf || (typeof currentVisibleWf === "function" ? currentVisibleWf() : S.wf);
  const nodes = (w && w.nodes) || [];
  const isDev = (n) => !!n && n.kind === "super" && !!n.dev && !n.db;
  const app = String((w && w.appId) || "").trim();
  if (app) {
    const hit = nodes.find((n) => isDev(n) && String(n.appId || "").trim() === app);
    if (hit) return hit;
  }
  return nodes.find((n) => isDev(n) && String(n.devPath || "").trim()) || null;
}
/* 开发页过滤：某个应用自己的会话（会话上的 appId 标记，随 config.json 落盘）。
   总会话视图 / #agentSideList 一字不改，只有开发页用这个取数。 */
function appSessionsOf(appId) {
  const id = String(appId || "").trim();
  if (!id) return [];
  const list = typeof agentSessions === "function" ? agentSessions() : [];
  return list
    .filter((s) => s && String(s.appId || "").trim() === id)
    .sort(
      (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0),
    );
}
/* 打开某个应用的画布并居中到它的开发节点（开发页 / 库页的「打开画布」）。 */
async function openAppCanvas(appId) {
  const id = String(appId || "").trim();
  if (!APP_WF_ID_RE.test(id)) {
    toast(I18n.t("应用 id 不合法"), "err");
    return false;
  }
  const list = await window.api.wfList();
  if (!list.some((w) => w && w.id === id)) {
    toast(I18n.t("该应用的画布不存在（可能在别处被删了）"), "warn");
    return false;
  }
  /* 应用中心（整屏浮层）开着就先收掉：紧接着要把画布打开并居中，不能盖着画布 */
  try {
    if (
      typeof appsHubIsOpen === "function" &&
      appsHubIsOpen() &&
      typeof appsHubClose === "function"
    )
      appsHubClose();
  } catch (_) {}
  await loadWorkflow(id);
  /* 老画布补一刀：workspace 是后加上的必填字段，早先经「新建应用 / 二次开发」建出来的
     应用画布工作目录是空的（顶栏显示「未设置」、左栏「文件」页显示「尚未设置工作目录」）。
     应用目录本来就是它的项目根，本地登记的应用目录存在时补写成工作目录并落盘 ——
     只补空值，用户填过的一律不动；目录已被删（用户手动挪走 / 删了应用目录）时保持空，
     让用户自己重新选，绝不留一个不存在的路径在画布上。 */
  const localApp = typeof appsLocalById === "function" ? appsLocalById(id) : null;
  const appDir = String((localApp && localApp.dir) || "").trim();
  if (appDir && S.wf && !String(S.wf.workspace || "").trim()) {
    try {
      if (await window.api.fileIsDir(appDir)) {
        S.wf.workspace = appDir;
        scheduleSave(true);
      }
    } catch (_) {}
  }
  setView("workflow");
  const dev = appsDevNodeOfWf(S.wf);
  if (dev) focusNode(dev.id);
  else renderAll();
  return true;
}

/* 库页 / 开发页顶部那一行「＋ 新建应用」：应用中心（renderer/app-apps.js）的
   appsPaintLibPage / appsPaintDevPage 调它插在「应用根目录」一行下面。
   行 / 按钮样式沿用应用中心自己的（apps-rootline + mini primary），不另造一套。 */
function appsCreateAppBtnEl() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mini primary";
  btn.textContent = "＋ " + I18n.t("新建应用");
  btn.onclick = () => appsCreateDialog();
  return btn;
}
function appsCreateButtonEl() {
  const row = document.createElement("div");
  row.className = "apps-rootline";
  row.appendChild(appsCreateAppBtnEl());
  return row;
}

/* 供库页 / 开发页直接挂到按钮上的入口（同一个函数，名字跟文案走）：
   「新建应用」→ appsCreateDialog() */
window.appsCreateDialog = appsCreateDialog;
window.appsCreateApp = appsCreateApp;
window.appsMigrateToDev = appsMigrateToDev;
window.appsCreateAppBtnEl = appsCreateAppBtnEl;
window.appsCreateButtonEl = appsCreateButtonEl;
window.openAppCanvas = openAppCanvas;
window.appIdOfDevNode = appIdOfDevNode;
window.appSessionsOf = appSessionsOf;
/* 「自定义」风格那一步（新建 / 换风格都调它）：把用户领回开发页输入框问风格。
   界面上是函数声明、这里再挂一份 window 名 —— 与同文件其它入口同一写法（便于 typeof 探测）。 */
window.startCustomStyleAsk = startCustomStyleAsk;
window.appStyleEntryIsCustom = appStyleEntryIsCustom;
window.appStyleStoredId = appStyleStoredId;
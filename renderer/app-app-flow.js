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
 * 这里只做两件事：缓存清单 + 画卡片。入口只剩新建应用浮层（开发页那枚「换风格…」已下线）
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
  /* 风格只在**新建这一步**选（本轮共识：开发页那枚「换风格…」按钮已下线，界面不再提供
     换风格入口）—— 所以这句提示不再指向一个不存在的按钮，改说清「要换就让开发会话改入口页」。 */
  styleHint.textContent = I18n.t("决定这个应用入口页的长相；建好之后要换，让这个应用的开发会话按新风格重写入口页");
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

  /* 能力（app.json 的 capabilities）：**本轮共识 = 新建即三位全开，这一步不再问**
     （原先是「三项默认都不勾」的三个复选框）。要改的话在开发页中栏「预览」条那枚
     「应用设置」里改（app-apps.js 的 appsAppSettingsOpen）—— 那里保留完整编辑。 */
  const capNote = document.createElement("div");
  capNote.className = "settings-hint cap-note";
  capNote.textContent = I18n.t(
    "能力默认全开（文字输入 / 听写条 / 图像生成）：建好之后可在开发页「预览」条上的「应用设置」里逐位调整。",
  );
  body.appendChild(capNote);

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
    /* 能力位不再从这里传：appsCreateApp 的缺省 = 三位全开（本轮共识） */
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
async function appsCreateApp(name, id, style, capabilities) {
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
  /* 应用根目录**不再要求用户手选**（本轮需求）：新建的应用一律落主进程的项目根
     （apps.projectDir，默认 <数据目录>/apps-dev —— 也就是画布所在的数据目录），
     主进程在新建时顺手把默认路径固化进 config.json，所以这里没有「先选个文件夹」这一前置。 */
  try {
    res = await window.api.appsCreate(
      nm,
      aid,
      String(style || ""),
      appFlowMeName(),
      /* 能力位（app.json 的 capabilities）：**缺省三位全开**（本轮共识：新建即全开，
         新建浮层里那段复选框已删）。老调用方不传时就按这个默认；要关哪一位，
         建好之后去开发页「预览」条上的「应用设置」里改（app-apps.js 的 appsAppSettingsOpen）。 */
      capabilities && typeof capabilities === "object"
        ? capabilities
        : { textInput: true, showDictate: true, imageGen: true },
    );
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

/* 当前登录账号的显示用账号名（昵称优先、占位账号名不算），新建应用时随 apps:create 一起写进
   app.json 的 author；未登录 / 账号模块未就绪回空串（主进程按「没写过」处理）。
   与 renderer/app-apps.js 的 appsMineOwnerKey / appsAuthorOf 同源（都读 MTNodeAuth.state()）——
   本轮把「二次开发」那段整段重写时它被误删过，这条注释与 test/smoke-apps.js 的
   「定义 + 调用点都在」断言一起把它钉住。 */
function appFlowMeName() {
  try {
    const A = window.MTNodeAuth;
    const st = A && typeof A.state === "function" ? A.state() || {} : {};
    return st.signedIn && st.user ? String(st.user.username || "").trim() : "";
  } catch (_) {
    return "";
  }
}
/* ---------- ①b 二次开发 = **复制到开发目录**（本轮口径 · 用户共识） ----------
 *
 * 与「新建应用」同规格，但**不搬动库目录里那一份**：
 *   ① 主进程 apps:copyToDev 复制一份到项目根（<项目根>/<id>/）：只复制应用本体（代码 / assets），
 *      写 dev:true、**保留来源那一份的原作者与来源版本**、另写一条内部来源记录（forkOf）；
 *      库里的原件原地不动、仍列在「库」，两份互不影响、互不绑定（库页点「更新」不动开发那份）。
 *   ② 画布：本机已有同名画布（id = 应用 id）就**直接复用** —— 把画布工作目录与已有开发节点的
 *      devPath / subFolder 改指新的开发文件夹（**不新增节点**）；没有就建一张同名画布 + 一个开发
 *      节点（与「新建应用」同一个构造函数 appCanvasWf 与同一个建节点实现 appsCreateDevNode）。
 *
 * 目标已存在（项目根里已经有同一个 id）时**不在这里问**：appsCopyToDev 回 code:"exists"，
 * 由调用方（renderer/app-apps.js 的 appsSecondaryDevRun）弹「覆盖 / 交给 AI 合并」两选一，
 * 选「覆盖」再带 mode:"overwrite" 调回来（主进程会先把旧那份整目录备份到 merge-backups）。
 *
 * 返回 { id, name, wfId, nodeId, mode, dir, backupDir, reused }；
 *   { exists:true, id } = 目标已存在（不是错误，交给调用方去问）；失败回 null（错误已 toast）。 */
async function appsCopyToDevRun(appId, opts) {
  const id = String(appId || "").trim();
  if (!id) return null;
  if (!APP_WF_ID_RE.test(id)) {
    toast(I18n.t("应用 id 不合法"), "err");
    return null;
  }
  const api = window.api || {};
  if (typeof api.appsCopyToDev !== "function") {
    toast(I18n.t("开发流程模块未就绪（请重启 MTNode）"), "err");
    return null;
  }
  const o = opts && typeof opts === "object" ? opts : {};
  let r = null;
  try {
    r = await api.appsCopyToDev(id, o.mode === "overwrite" ? { mode: "overwrite" } : {});
  } catch (err) {
    r = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!r || r.ok === false) {
    if (r && String(r.code || "") === "exists") return { exists: true, id: id };
    toast(
      I18n.t("复制到开发文件夹失败：") +
        String((r && (r.error || r.reason)) || I18n.t("未知错误")),
      "err",
    );
    return null;
  }
  const dir = String(r.dir || "");
  /* 名单先刷新：下面取名字与核心文件都按**新的开发副本**取（库里那份不是这次要开发的对象） */
  try {
    if (typeof appsListLoad === "function") await appsListLoad(true);
  } catch (_) {}
  let app = null;
  try {
    app =
      (typeof appsLocalById === "function" &&
        (appsLocalById(id, "dev") || appsLocalById(id))) ||
      null;
  } catch (_) {
    app = null;
  }
  const name = String((app && app.name) || id);
  /* ① 画布：有同名画布就复用（只改路径 + 改已有开发节点），没有就建一张 */
  let wf = null;
  try {
    wf = typeof wfOfCanvasIdForRun === "function" ? await wfOfCanvasIdForRun(id) : null;
  } catch (_) {
    wf = null;
  }
  const fresh = !wf;
  if (fresh) wf = appCanvasWf(id, name, dir);
  const ws = appCanvasWsPath(dir);
  if (ws) wf.workspace = ws;
  const nodeBefore = typeof appsDevNodeOfWf === "function" ? appsDevNodeOfWf(wf) : null;
  if (nodeBefore) {
    /* 复用：把已有开发节点指到新的开发文件夹（**不新增节点**），节点其它配置一字不动 */
    nodeBefore.devPath = dir;
    nodeBefore.subFolder = dir;
  }
  if (fresh) clearHistory();
  setForegroundWf(wf);
  reviveWf(id);
  try {
    await window.api.wfSave(id, wf);
  } catch (err) {
    toast(
      I18n.t("已复制到开发文件夹，但画布保存失败：") + ((err && err.message) || String(err)),
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
  /* ② 开发节点：复用时就是上面那一个（nodeId 回它），新建的画布才建节点 ——
     与「新建应用」同一个实现：devPath / devFiles 都指向应用目录里的真实文件。 */
  let nodeId = nodeBefore ? String(nodeBefore.id || "") : "";
  if (fresh) {
    let appForNode = app;
    try {
      if (app && app.detailPending && typeof appsLocalDetailEnsure === "function") {
        appForNode = (await appsLocalDetailEnsure(app.id)) || app;
      }
    } catch (_) {}
    const node = appsCreateDevNode({
      id: id,
      name: name,
      dir: dir,
      coreFiles: Array.isArray(appForNode && appForNode.coreFiles) ? appForNode.coreFiles : [],
    });
    if (node) {
      focusNode(node.id);
      nodeId = String(node.id || "");
    }
  } else if (nodeId) {
    focusNode(nodeId);
  }
  renderAll();
  scheduleSave(true);
  return {
    id: id,
    name: name,
    wfId: id,
    nodeId: nodeId,
    mode: String(r.mode || "copy"),
    dir: dir,
    backupDir: String(r.backupDir || ""),
    reused: !fresh,
  };
}
window.appsCopyToDevRun = appsCopyToDevRun;

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

/* ---------- 能力复选框组（「应用设置」窗用；新建浮层已不再问能力） ---------- *
 * 三个能力位就是 app.json 的 capabilities（见 apps-capabilities.js）：
 *   textInput    需要文字输入 → 脚手架带上语音听写模块（本机 SenseVoice）
 *   showDictate  显示听写条 → 应用窗口底部显示宿主注入的听写条（勾上即默认可见，条尾可收起）
 *   imageGen     需要生成图片 → 用 MTNode 已配好的图像能力（云端服务商或本机 SenseNova）
 * 缺省**三项都不勾**（缺省 = 宿主不注入听写条；声明为真的应用注入进来就是可见的）。
 * 界面这边只负责「勾选 + 一句话说明」；真正的落盘、入口页重生成、语音文件补撤都在主进程
 * （apps:capabilitiesSet），渲染层不碰文件系统。
 * 返回 { box, get(), set() }：get() 回一份 { textInput, showDictate, imageGen } 布尔对象。
 * onChange（可选）＝**勾选即写盘**那条路的钩子（「应用设置」窗传它，用户口径：能力位不再单独
 * 保存，统一由勾选当场生效）：每次勾选/取消后回调一次新的能力位；写盘失败由调用方用 set()
 * 把勾选态回滚成磁盘上的真实值。不传 = 老口径（只改内存态，由调用方自己保存）。 */
function appsCapabilityChecks(value, onChange) {
  const cur = Object.assign({ textInput: false, showDictate: false, imageGen: false }, value || {});
  const box = document.createElement("div");
  box.className = "cap-list";
  const state = {
    textInput: cur.textInput === true,
    showDictate: cur.showDictate === true,
    imageGen: cur.imageGen === true,
  };
  const read = () => ({
    textInput: state.textInput === true,
    showDictate: state.showDictate === true,
    imageGen: state.imageGen === true,
  });
  const rows = [
    {
      id: "textInput",
      label: I18n.t("需要文字输入"),
      hint: I18n.t("脚手架会带上语音听写模块（本机语音识别，首次用会自动下载模型）；要不要在窗口底部显示听写条，看下面那一项"),
    },
    {
      id: "showDictate",
      label: I18n.t("显示听写条"),
      hint: I18n.t("在应用窗口底部显示宿主注入的听写条（🎤 听写 / 🎧 音频转文字）；勾上就默认显示，条尾可「收起」（只藏本次窗口，下次打开仍按本声明显示）"),
    },
    {
      id: "imageGen",
      label: I18n.t("需要图像生成"),
      hint: I18n.t("用 MTNode 已配好的图像能力出图：云端图像服务商或本机 SenseNova（没配就用不了，界面会写清去哪配）"),
    },
  ];
  for (const r of rows) {
    const lab = document.createElement("label");
    lab.className = "cap-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state[r.id] === true;
    cb.dataset.cap = r.id;
    cb.onchange = () => {
      state[r.id] = cb.checked;
      /* 勾选即写盘（「应用设置」窗那一版）：回调给调用方，由它去写 app.json 的声明 */
      if (typeof onChange === "function") {
        try {
          onChange(read());
        } catch (_) {}
      }
    };
    lab.appendChild(cb);
    const txt = document.createElement("span");
    txt.className = "cap-text";
    const b = document.createElement("b");
    b.textContent = r.label;
    txt.appendChild(b);
    const h = document.createElement("span");
    h.className = "cap-hint";
    h.textContent = r.hint;
    txt.appendChild(h);
    lab.appendChild(txt);
    box.appendChild(lab);
  }
  return {
    box: box,
    get: read,
    set: (v) => {
      const nv = v || {};
      state.textInput = nv.textInput === true;
      state.showDictate = nv.showDictate === true;
      state.imageGen = nv.imageGen === true;
      const boxes = box.querySelectorAll("input[data-cap]");
      for (const b of boxes) b.checked = state[b.dataset.cap] === true;
    },
  };
}

/* ---------- ② 应用能力（**本轮起没有独立入口**，编辑搬进「应用设置」窗） ---------- *
 * 本轮共识：开发页工具栏那枚「应用能力…」按钮下线，能力位的编辑整体搬进开发页中栏
 * 「预览」列头条上那枚「应用设置」开的窗（app-apps.js 的 appsAppSettingsOpen，
 * 它直接复用下面的 appsCapabilityChecks 与同一套「变更 → 确认 → 按模板重写入口页」口径）。
 * 这个对话框函数**留在原地不删**：它是同一套语义的第二出口（第三方 / 老调用方按名字探测），
 * 也是上面那只窗外唯一一处写清楚了「为什么要先确认」的地方。
 *
 * 改 app.json 的 capabilities。勾上「需要文字输入」= 宿主把脚手架里的 speech.js / speech.css
 * 补进应用目录；取消勾选走反向（撤那两份文件）。「显示听写条」（showDictate）只管应用窗口
 * footer 里那条宿主注入的听写条：声明为真 = 宿主注入进来即默认可见（条尾「收起」只藏本次窗口），
 * 缺省 false = 宿主根本不注入。
 * **能力位一律不写入口页**（本轮共识）：只写 app.json 的声明 —— 旧实现任何一位变了都按模板
 * 重生成入口页，用户手改过的页面内容会全没了；现在页面一个字不动，所以这条路上没有确认弹窗，
 * 只剩一句「改完是什么效果」的说明。
 * opts.kind = 改哪一套根下那一份（"dev" / "down"）。opts.canRegen 已废弃（只为兼容老调用方留着）。 */
async function appCapabilitiesDialog(appId, appName, opts) {
  const id = String(appId || "");
  if (!id) return;
  const o = opts || {};
  openOverlay(I18n.t("应用能力"), { persistent: true });
  const body = $("#ovBody");
  const lead = document.createElement("div");
  lead.className = "settings-hint cap-lead";
  lead.textContent = I18n.t("这个应用需要什么能力：") + String(appName || id);
  body.appendChild(lead);
  const loading = document.createElement("div");
  loading.className = "settings-hint";
  loading.textContent = I18n.t("正在读取…");
  body.appendChild(loading);
  let box = null;
  const read = (async () => {
    try {
      /* opts.kind = 改**哪一套根下那一份**（"dev" / "down"）：开发页传 dev ——
         同 id 在下载根也有一份时，能力位写错副本等于改了个用户看不见的文件。 */
      return await window.api.appsCapabilitiesGet(id, (o && o.kind) || "");
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  })();
  /* 打开这只窗时顺手静默清一次存量入口页里旧版内联的听写段（幂等，没痕迹不写文件） */
  try {
    if (typeof window.api.appsCapabilitiesCleanEntry === "function")
      window.api.appsCapabilitiesCleanEntry(id, (o && o.kind) || "").catch(() => {});
  } catch (_) {}
  const note = document.createElement("div");
  note.className = "settings-hint cap-warn";
  note.textContent = I18n.t(
    "能力位只写 app.json 的声明：入口页（index.html）一个字都不动，你手改过的页面内容原样保留；听写条由宿主按声明注入，语音模块文件按需补撤。",
  );
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("保存");
  ok.disabled = true;
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(cancel);
  foot.appendChild(ok);
  const r0 = await read;
  loading.remove();
  if (!r0 || !r0.ok) {
    const err = document.createElement("div");
    err.className = "settings-hint";
    err.textContent = I18n.t("读取失败：") + ((r0 && (r0.error || r0.reason)) || I18n.t("未知错误"));
    body.appendChild(err);
    return;
  }
  box = appsCapabilityChecks(r0.capabilities || {});
  body.appendChild(box.box);
  body.appendChild(note);
  ok.disabled = false;
  ok.onclick = async () => {
    const next = box.get();
    const before = r0.capabilities || {};
    const changed =
      (before.textInput === true) !== (next.textInput === true) ||
      (before.showDictate === true) !== (next.showDictate === true) ||
      (before.imageGen === true) !== (next.imageGen === true);
    if (!changed) {
      toast(I18n.t("能力没有变化"));
      return;
    }
    /* 只写声明（+ textInput 的语音模块补撤）：页面不动，所以没有「要不要覆盖」这一步 */
    ok.disabled = true;
    let r = null;
    try {
      r = await window.api.appsCapabilitiesSet(id, next, { kind: (o && o.kind) || "" });
    } catch (err) {
      r = { ok: false, error: (err && err.message) || String(err) };
    }
    ok.disabled = false;
    if (!r || !r.ok) {
      toast(I18n.t("保存失败：") + ((r && (r.error || r.reason)) || I18n.t("未知错误")), "err");
      return;
    }
    box.set(r.capabilities || next);
    toast(I18n.t("已更新能力位（入口页未改动，听写条下次打开应用窗口生效）"), "ok");
    /* 应用列表带缓存：重拉一次，卡片上的能力小标立刻跟上 */
    try {
      if (typeof appsListLoad === "function") await appsListLoad(true);
    } catch (_) {}
  };
}

/* ---------- ② 换风格（**本轮起没有 UI 入口**） ---------- *
 * 本轮共识：开发页工具栏那枚「换风格…」下线（连同「应用能力…」），界面不再提供换风格入口 ——
 * 要换就让这个应用的开发会话按新风格重写入口页（它自己能改文件，比套模板更贴用途）。
 * 这个对话框与主进程的 apps:setStyle 一并**留在原地不删**：同一套语义的第二出口
 * （第三方 / 老调用方按名字探测），也是「覆盖入口页要先确认」这条口径的落点之一。
 *
 * 应用目录里的入口页是「新建时从模板生成的一份独立文件」，模板升级不会自动跟过去，
 * 所以换风格 = 按所选风格**重写入口页**（主进程 apps:setStyle）。确认框里写明会覆盖：
 * 用户后来在入口页里手改过的内容会没了 —— 这是明确的口径（不生成备份），
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
  /* 画布上的「路径两件套」自愈（口径见 appCanvasPathHeal）：空值补写 +
     指向不存在的目录时按本机实际应用目录校准。取应用目录一律点「开发那一份」——
     还躺在下载根里的开发应用（归位没成功）也要拿得到它真实的目录。 */
  const localApp =
    typeof appsLocalById === "function"
      ? appsLocalById(id, "dev") || appsLocalById(id)
      : null;
  const appDir = String((localApp && localApp.dir) || "").trim();
  if (appDir) {
    try {
      const healed = await appCanvasPathHeal(S.wf, appDir);
      if (healed && (healed.workspace || healed.node)) scheduleSave(true);
    } catch (_) {}
  }
  setView("workflow");
  const dev = appsDevNodeOfWf(S.wf);
  if (dev) focusNode(dev.id);
  else renderAll();
  return true;
}

/* 应用画布上的「路径两件套」自愈（本轮修的 bug 的存量收尾；单独成型是为了能 vm 真跑）：
   应用画布的工作目录**应当就是应用目录**（顶上「工作目录」= 这张画布一切相对路径的基准），
   开发节点的 devPath / subFolder 同一个口径。两种情况要校准：
     ① 空值 → 补写（workspace 是后加上的必填字段，早先建出来的应用画布是空的）；
     ② 有值、但那个目录已经不在盘上 → 校准成应用目录 —— 「二次开发」在「归位到项目根」只做了
        dry-run 时，把**搬家的目标目录**（<数据目录>/apps-dev/<id>，并不存在）当成了真实位置
        写进 workspace 与 devPath（历史 bug：当年「二次开发」只跑了 dry-run，把搬家的目标目录
        当成了真实位置）。
   不动的情形：用户自己填过、且那个目录还在的；应用目录本身不在盘上的（什么也不做 ——
   绝不往画布上留一个不存在的路径，也不拿别处目录顶替）；桥探不动（老包 / 被裁剪）的，
   一律当「没问题」，宁可少改一次也不乱改用户的画布。
   返回 { workspace, node } = 这两处各自是否真的改写了（调用方据此决定落盘）。 */
async function appCanvasPathHeal(wf, appDir) {
  const out = { workspace: false, node: false };
  const dir = String(appDir || "").trim();
  if (!wf || !dir) return out;
  try {
    if (!(await window.api.fileIsDir(dir))) return out;
  } catch (_) {
    return out;
  }
  /* ① 工作目录 */
  const curWs = String(wf.workspace || "").trim();
  let wsGone = false;
  if (curWs) {
    try {
      wsGone = !(await window.api.fileIsDir(curWs));
    } catch (_) {
      wsGone = false;
    }
  }
  if (!curWs || wsGone) {
    wf.workspace = dir;
    out.workspace = true;
  }
  /* ② 开发节点的 devPath / subFolder（只改指向不存在目录的那些，节点其它配置一字不动） */
  const dev = typeof appsDevNodeOfWf === "function" ? appsDevNodeOfWf(wf) : null;
  if (dev) {
    for (const key of ["devPath", "subFolder"]) {
      const cur = String(dev[key] || "").trim();
      if (!cur) continue;
      let gone = false;
      try {
        gone = !(await window.api.fileIsDir(cur));
      } catch (_) {
        gone = false;
      }
      if (gone) {
        dev[key] = dir;
        out.node = true;
      }
    }
  }
  return out;
}

/* 按应用 id 修那张应用画布的路径两件套（`appCanvasPathHeal` 的取数壳）：
   画布 id = 应用 id（新建应用 / 二次开发都建同名画布，见本文件头部）。
   画布不在内存里时走 wfOfCanvasIdForRun（读盘 + 入袋），拿不到（已删 / 桥探不动）就返回 false：
   「宁可少改一次，也不乱改用户的画布」（与 appCanvasPathHeal 同一条纪律）。
   只在真改了东西时回写（wfSave），没改就一个字节都不写盘。
   入口：目录设置窗换根并搬过应用之后（app-apps.js 的 appsRootChange → appsRootHealAfterMove）。 */
async function appCanvasPathHealById(appId, appDir) {
  const id = String(appId || "").trim();
  const dir = String(appDir || "").trim();
  if (!id || !dir || typeof wfOfCanvasIdForRun !== "function") return false;
  let wf = null;
  try {
    wf = await wfOfCanvasIdForRun(id);
  } catch (_) {
    wf = null; /* 没有这张画布 / 它已被删：跳过（不是错误） */
  }
  if (!wf) return false;
  let hit = false;
  try {
    const h = await appCanvasPathHeal(wf, dir);
    hit = !!(h.workspace || h.node);
  } catch (_) {
    return false;
  }
  if (!hit) return false;
  try {
    await window.api.wfSave(id, wf);
  } catch (_) {
    return false;
  }
  return true;
}
/* 换根后把搬过家的应用校准一遍（目录设置窗调，见 app-apps.js 的 appsRootChange）：
   ① 该应用名下开发会话的工作区（app-apps-dev.js 的 appsDevAlignAppWorkspace：
      空值 / 指向已不存在目录 → 改指应用目录；用户手填且还在的一字不动）；
   ② 该应用的画布：开发节点 devPath / subFolder / 画布工作目录（appCanvasPathHeal）。
   **调用前必须已经把应用名单重扫过**（appsListLoad(true)）—— 两条都按「应用目录当前在哪」取数。
   返回 { sessions, canvases } 各改了几处；任何一步失败都只记不抛（换根本身已经成功了）。 */
async function appsRootHealAfterMove(moved) {
  const out = { sessions: 0, canvases: 0 };
  const list = Array.isArray(moved) ? moved : [];
  for (const m of list) {
    const id = String((m && m.id) || "").trim();
    const dir = String((m && m.to) || "").trim();
    if (!id || !dir) continue;
    try {
      if (typeof appsDevAlignAppWorkspace === "function")
        out.sessions += Number(await appsDevAlignAppWorkspace(id)) || 0;
    } catch (_) {}
    try {
      if (await appCanvasPathHealById(id, dir)) out.canvases++;
    } catch (_) {}
  }
  return out;
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
window.appCapabilitiesDialog = appCapabilitiesDialog;
window.appsCreateAppBtnEl = appsCreateAppBtnEl;
window.appsCreateButtonEl = appsCreateButtonEl;
/* 换根后校准（目录设置窗调）：应用画布路径两件套 + 该应用开发会话工作区 */
window.appCanvasPathHealById = appCanvasPathHealById;
window.appsRootHealAfterMove = appsRootHealAfterMove;
window.openAppCanvas = openAppCanvas;
window.appIdOfDevNode = appIdOfDevNode;
window.appSessionsOf = appSessionsOf;
/* 「自定义」风格那一步（新建 / 换风格都调它）：把用户领回开发页输入框问风格。
   界面上是函数声明、这里再挂一份 window 名 —— 与同文件其它入口同一写法（便于 typeof 探测）。 */
window.startCustomStyleAsk = startCustomStyleAsk;
window.appStyleEntryIsCustom = appStyleEntryIsCustom;
window.appStyleStoredId = appStyleStoredId;

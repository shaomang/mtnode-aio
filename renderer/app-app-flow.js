"use strict";
/* ============ 用户自建应用 · 新建流程 + 开发页归属（renderer 侧） ============
 *
 * 本文件只管两件事（库页 / 开发页入口调它，不自己画库页）：
 *
 * ① 新建应用流程 appsCreateDialog() / appsCreateApp(name, id)
 *    填「标题 + 文件夹名」→ window.api.appsCreate（主进程 apps-store.js 建目录与 app.json）
 *    → 建同名画布（**既有 workflow:save**，画布 id = 文件夹名，画布 json 上写 appId）
 *    → 在该画布建一个开发节点（super + dev:true，devPath / subFolder 指向应用目录，
 *      devFiles 填应用目录里真实存在的核心文件）→ 打开该画布并居中到该节点。
 *    画布 / 会话 / 开发节点全部落在数据目录与既有存储里，**不往应用文件夹写用户数据**；
 *    应用目录里那份 <AppName>.mtnodes 是主进程每次 workflow:save 顺手同步的镜像
 *    （main.js 的 writeWorkflowJson → apps-store.js 的 mirrorAppCanvas，供整目录迁移）。
 *
 * ② 开发页的会话归属 appIdOfDevNode() / appSessionsOf(appId) / openAppCanvas(appId)
 *    会话对象上的 appId 标记（新建开发会话时由 app.js 的 createDevSessionForNode 写入，
 *    随 config.json 落盘见 app-assist.js 的 persistAgentSession）只服务「开发页按应用
 *    过滤会话」这一处；总会话视图与 #agentSideList 的渲染逻辑一字未改。
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
    const r = await appsCreateApp(name, id);
    ok.disabled = false;
    if (r) closeOverlay();
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
  nameInp.focus();
}

/* 新建应用的执行体：建目录 → 建同名画布（workflow:save）→ 建开发节点 → 打开并居中。
   成功回 { id, name, dir, wfId, nodeId }，失败回 null（错误已 toast）。 */
async function appsCreateApp(name, id) {
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
    res = await window.api.appsCreate(nm, aid);
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
     appId 是本画布与应用目录的关联标记，主进程每次落盘据此同步镜像 .mtnodes。 */
  const wf = {
    id: res.id,
    name: res.name,
    appId: res.id,
    nodes: [],
    wires: [],
    groups: [],
    marks: [],
  };
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
  /* 先切到画布视图：focusNode 的居中要读 #canvas 的实际尺寸，会话 / 团队视图下它是
     display:none（宽度 0 → 相机算到视口外）。 */
  setView("workflow");
  renderAll();
  trackWorkflow(res.id, S.wf.name);
  try {
    await refreshWfSelect();
  } catch (_) {}
  /* 该画布上的第一个开发节点 = 这个应用的功能块（项目根与子文件夹都指向应用目录） */
  const node = appsCreateDevNode(res);
  if (node) focusNode(node.id); /* 打开该画布并居中到开发节点 */
  renderAll();
  scheduleSave(true);
  /* 应用中心（renderer/app-apps.js）：① 它的本机列表带缓存 —— 强制重拉一次，下次
     打开库页/开发页就能看到这条新应用；② 正开着就收掉整屏浮层，紧接着要「打开该画布
     并居中」，不能让浮层盖着画布。两处都按 typeof 探测，应用中心不在也照常跑完。 */
  try {
    if (typeof appsListLoad === "function") await appsListLoad(true);
  } catch (_) {}
  try {
    if (
      typeof appsHubIsOpen === "function" &&
      appsHubIsOpen() &&
      typeof appsHubClose === "function"
    )
      appsHubClose();
  } catch (_) {}
  toast(I18n.t("已新建应用：") + res.name, "ok");
  return {
    id: res.id,
    name: res.name,
    dir: res.dir,
    root: res.root,
    wfId: res.id,
    nodeId: node ? node.id : "",
  };
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
window.appsCreateAppBtnEl = appsCreateAppBtnEl;
window.appsCreateButtonEl = appsCreateButtonEl;
window.openAppCanvas = openAppCanvas;
window.appIdOfDevNode = appIdOfDevNode;
window.appSessionsOf = appSessionsOf;
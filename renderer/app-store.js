"use strict";
/* ============ 模板商店 ============ */
const TPL_PREV_CACHE = new Map();
/* 商店用户区对统一账户的订阅句柄（每次开商店重新订阅，避免叠加）。 */
let tplAuthUnsub = null;
const TPL_ST = {
  kind: "templates", /* templates | skills */
  tab: "browse",
  view: "grid", /* grid | list，默认网格 */
  q: "",
  tag: "",
  sort: "new",
  page: 1,
  editId: "",
  title: "",
  description: "",
  tags: [],
  version: "1.0.0",
  official: false,
  skillName: "",
  skillText: "",
  skillExtras: [],
  fileBase64: "",
  fileHint: "",
  previewBase64: "",
  previewThumbBase64: "",
  previewHint: "",
  authMode: "login",
  _localSkills: null,
};

function tplIsSkill() {
  return TPL_ST.kind === "skills";
}
function tplApiBase() {
  return tplIsSkill() ? "/api/skills" : "/api/templates";
}

/* 统一账户：登录态唯一来源 = window.MTNodeAuth（token 由主进程 safeStorage 保管，
   渲染层不缓存、不落 config.json）。这里只把账户快照适配成商店旧字段名。
   旧版 S.config.storeAuth 由主进程启动时一次性迁入统一存储，见 main.js migrateLegacyStoreAuth。 */
function tplAuthSnap() {
  const A = window.MTNodeAuth;
  if (!A || typeof A.state !== "function") return null;
  const s = A.state();
  return s && s.signedIn && s.user ? s : null;
}
function tplAuth() {
  const s = tplAuthSnap();
  if (!s) return null;
  const u = s.user || {};
  return {
    userId: u.id || u.userId || "",
    username: u.username || "",
    nickname: u.nickname || u.username || "",
    avatar: u.avatar || "",
    phone: s.phone || u.phone || "",
    likesReceived: u.likesReceived || 0,
    downloadsReceived: u.downloadsReceived || 0,
    isAdmin: !!u.isAdmin,
  };
}
/* 兼容旧调用：null = 清登录态（401 / 退出），对象 = 重新向主进程取最新账号。 */
function setTplAuth(a) {
  const A = window.MTNodeAuth;
  if (!A) return;
  if (!a) {
    if (typeof A.logout === "function") A.logout().catch(() => {});
    return;
  }
  if (typeof A.refresh === "function") A.refresh().catch(() => {});
}
/* 打开顶栏同一套登录 / 注册对话框；登录成功后执行 after。 */
let tplAuthWaitOff = null;
function openUnifiedAuth(after) {
  const A = window.MTNodeAuth;
  if (!A || typeof A.open !== "function") {
    toast(I18n.t("登录服务未就绪"), "err");
    return;
  }
  if (tplAuthWaitOff) {
    tplAuthWaitOff();
    tplAuthWaitOff = null;
  }
  if (typeof A.onChange === "function" && typeof after === "function") {
    tplAuthWaitOff = A.onChange(() => {
      if (!tplAuth()) return;
      if (tplAuthWaitOff) tplAuthWaitOff();
      tplAuthWaitOff = null;
      after();
    });
  }
  A.open();
}
const TPL_MAX_BYTES = 10 * 1024 * 1024;
const SKILL_MAX_BYTES = 200 * 1024;
function tplTooLarge(bytes) {
  const max = tplIsSkill() ? SKILL_MAX_BYTES : TPL_MAX_BYTES;
  if (bytes == null || !(bytes > max)) return false;
  toast(
    (tplIsSkill()
      ? I18n.t("每个文件不能超过 200KB（当前 ")
      : I18n.t("模板不能超过 10MB（当前 ")) +
      fmtBytes(bytes) +
      "）",
    "err",
  );
  return true;
}
function tplCanDelete(item) {
  if (!item) return false;
  if (item.canDelete) return true;
  if (item.mine) return true;
  const a = tplAuth();
  return !!(a && a.isAdmin);
}
function tplErr(r) {
  if (!r) return I18n.t("网络请求失败");
  if (r.data && r.data.error) return r.data.error;
  if (r.error) return r.error;
  return "HTTP " + (r.status || "");
}
async function tplApi(method, path, json) {
  /* 不再显式传 token：主进程 store:request 自动带上统一账户的会话。 */
  const r = await window.api.storeRequest({ method, path, json });
  if (r && r.status === 401 && tplAuth()) setTplAuth(null);
  return r;
}
async function tplPreviewSrc(id, size) {
  const sz = size === "full" ? "full" : "thumb";
  const key = (tplIsSkill() ? "s:" : "t:") + id + ":" + sz;
  if (TPL_PREV_CACHE.has(key)) return TPL_PREV_CACHE.get(key);
  const q = sz === "full" ? "?size=full" : "?size=thumb";
  const r = await tplApi(
    "GET",
    tplApiBase() + "/" + encodeURIComponent(id) + "/preview" + q,
  );
  if (!r || !r.ok || !r.base64) return "";
  const url = "data:" + (r.contentType || "image/jpeg") + ";base64," + r.base64;
  TPL_PREV_CACHE.set(key, url);
  return url;
}
function tplResetDraft() {
  TPL_ST.editId = "";
  TPL_ST.title = "";
  TPL_ST.description = "";
  TPL_ST.tags = [];
  TPL_ST.version = "1.0.0";
  TPL_ST.official = false;
  TPL_ST.skillName = "";
  TPL_ST.skillText = "";
  TPL_ST.skillExtras = [];
  TPL_ST.fileBase64 = "";
  TPL_ST.fileHint = "";
  TPL_ST.previewBase64 = "";
  TPL_ST.previewThumbBase64 = "";
  TPL_ST.previewHint = "";
  TPL_ST._clearPreview = false;
  TPL_ST._extrasTouched = false;
}

function parseSkillFrontmatterClient(text) {
  const meta = { name: "", title: "", description: "", version: "" };
  const raw = String(text || "");
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const km = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!km) continue;
      const k = km[1];
      const v = String(km[2] || "").replace(/^['"]|['"]$/g, "").trim();
      if (k === "name" || k === "title" || k === "description" || k === "version")
        meta[k] = v;
    }
  }
  if (!meta.title) {
    const h1 = raw.match(/^#\s+(.+)$/m);
    if (h1) meta.title = String(h1[1] || "").trim();
  }
  if (meta.name) meta.name = meta.name.trim().toLowerCase().replace(/_/g, "-");
  return meta;
}

function skillTextToBase64(text) {
  return btoa(unescape(encodeURIComponent(String(text || ""))));
}

function bumpSkillVersion(v) {
  const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "1.0.1";
  return m[1] + "." + m[2] + "." + (Number(m[3]) + 1);
}

function applySkillDraftFromText(text, opts) {
  const o = opts || {};
  const meta = parseSkillFrontmatterClient(text);
  TPL_ST.skillText = String(text || "");
  TPL_ST.fileBase64 = skillTextToBase64(TPL_ST.skillText);
  if (meta.name) TPL_ST.skillName = meta.name;
  if (o.fillMeta !== false) {
    if (meta.title) TPL_ST.title = meta.title;
    if (meta.description) TPL_ST.description = meta.description;
    if (meta.version) TPL_ST.version = meta.version;
  }
  return meta;
}

function isSkillMdFileName(name) {
  const n = String(name || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  return /^skill\.md$/i.test(String(n || "").trim());
}

function skillExtraFileNameOk(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(name || ""));
}

function arrayBufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function mergeSkillExtras(list, opts) {
  const o = opts || {};
  const next = o.replace ? [] : (TPL_ST.skillExtras || []).slice();
  for (const f of list || []) {
    const pathName = String((f && (f.path || f.name)) || "").trim();
    if (!pathName || isSkillMdFileName(pathName)) continue;
    if (!skillExtraFileNameOk(pathName)) {
      toast(I18n.t("文件名不合法：") + pathName, "err");
      return null;
    }
    const bytes = Number(f.bytes) || 0;
    if (tplTooLarge(bytes)) return null;
    const entry = {
      path: pathName,
      name: pathName,
      base64: f.base64,
      bytes,
    };
    const i = next.findIndex(
      (x) => String(x.path).toLowerCase() === pathName.toLowerCase(),
    );
    if (i >= 0) next[i] = entry;
    else {
      if (next.length >= 32) {
        toast(I18n.t("附加文件不能超过 32 个"), "warn");
        break;
      }
      next.push(entry);
    }
  }
  TPL_ST.skillExtras = next;
  TPL_ST._extrasTouched = true;
  return next;
}

/** 应用 SKILL.md + 附件包：自动填写标题/描述/版本/技能名 */
function applySkillUploadBundle(skill, extras, opts) {
  const o = opts || {};
  const text = String((skill && (skill.text || skill.body)) || "");
  if (!text.trim()) {
    toast(I18n.t("请包含 SKILL.md"), "err");
    return false;
  }
  const bytes =
    Number(skill && skill.bytes) ||
    new TextEncoder().encode(text).length;
  if (tplTooLarge(bytes)) return false;
  const meta = parseSkillFrontmatterClient(text);
  if (
    TPL_ST.editId &&
    TPL_ST.skillName &&
    meta.name &&
    meta.name !== TPL_ST.skillName
  ) {
    toast(I18n.t("本机技能名与工坊条目不一致，不能覆盖该条目"), "err");
    return false;
  }
  applySkillDraftFromText(text, { fillMeta: o.fillMeta !== false });
  const merged = mergeSkillExtras(extras || [], {
    replace: o.replaceExtras !== false,
  });
  if (!merged) return false;
  const skillLabel =
    (skill && (skill.name || skill.path)) || "SKILL.md";
  TPL_ST.fileHint =
    I18n.t("已载入技能包") +
    " · " +
    skillLabel +
    " · " +
    fmtBytes(bytes) +
    (merged.length
      ? " · +" + merged.length + I18n.t(" 个附件") + " · " + merged.map((f) => f.path).join(", ")
      : "");
  return true;
}

function readDirEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const pump = () => {
      reader.readEntries(
        (batch) => {
          if (!batch || !batch.length) {
            resolve(all);
            return;
          }
          all.push.apply(all, batch);
          pump();
        },
        reject,
      );
    };
    pump();
  });
}

function entryToFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** 从拖放收集文件（支持多文件，或单个技能文件夹一层） */
async function collectSkillDropFiles(dataTransfer) {
  const out = [];
  const items = dataTransfer && dataTransfer.items;
  if (items && items.length) {
    const roots = [];
    for (let i = 0; i < items.length; i++) {
      const ent =
        items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (ent) roots.push(ent);
    }
    if (roots.length) {
      for (const ent of roots) {
        if (ent.isFile) {
          out.push(await entryToFile(ent));
        } else if (ent.isDirectory) {
          const kids = await readDirEntries(ent.createReader());
          for (const k of kids) {
            if (k.isFile) out.push(await entryToFile(k));
          }
        }
      }
      return out;
    }
  }
  return Array.from((dataTransfer && dataTransfer.files) || []);
}

async function browserFileToSkillEntry(file) {
  const ab = await file.arrayBuffer();
  const name = String(file.name || "file");
  const bytes = ab.byteLength;
  const base64 = arrayBufferToBase64(ab);
  const entry = { name, path: name, bytes, base64, text: "" };
  if (isSkillMdFileName(name)) {
    entry.text = new TextDecoder("utf-8").decode(ab);
  }
  return entry;
}

async function ingestSkillDropFiles(dataTransfer) {
  const files = await collectSkillDropFiles(dataTransfer);
  if (!files.length) {
    toast(I18n.t("未检测到可上传的文件"), "warn");
    return false;
  }
  const entries = [];
  for (const f of files) {
    entries.push(await browserFileToSkillEntry(f));
  }
  const skill = entries.find((e) => isSkillMdFileName(e.name));
  const extras = entries.filter((e) => !isSkillMdFileName(e.name));
  if (!skill) {
    if (!extras.length) {
      toast(I18n.t("请包含 SKILL.md"), "err");
      return false;
    }
    const merged = mergeSkillExtras(extras, { replace: false });
    if (!merged) return false;
    TPL_ST.fileHint =
      (TPL_ST.fileHint ? TPL_ST.fileHint + " · " : "") +
      I18n.t("已选 ") +
      merged.length +
      I18n.t(" 个附件");
    toast(I18n.t("已添加附件（未含 SKILL.md，表单字段未改）"), "ok");
    return true;
  }
  return applySkillUploadBundle(skill, extras, { replaceExtras: true });
}

async function refreshLocalSkillsForStore() {
  try {
    const r = await window.api.skillList();
    TPL_ST._localSkills = (r && r.skills) || [];
  } catch {
    TPL_ST._localSkills = [];
  }
  return TPL_ST._localSkills || [];
}
function findLocalSkill(skillName) {
  const nm = String(skillName || "").toLowerCase();
  return (TPL_ST._localSkills || []).find((s) => s.name === nm) || null;
}

/* 商店二级浮层：大图 / 只读画布预览（盖在模板商店之上） */
function openTplSubOverlay(title) {
  let el = $("#tplSubOv");
  if (!el) {
    el = document.createElement("div");
    el.id = "tplSubOv";
    el.className = "tpl-sub-ov";
    el.innerHTML =
      '<div class="tpl-sub-box">' +
      '<div class="tpl-sub-head"><b id="tplSubTitle"></b>' +
      '<button type="button" class="mini" id="tplSubClose">✕</button></div>' +
      '<div class="tpl-sub-body" id="tplSubBody"></div></div>';
    document.body.appendChild(el);
    el.querySelector("#tplSubClose").onclick = closeTplSubOverlay;
    /* persistent：二级预览浮层点蒙层不关，只走 ✕ / Esc（关上级商店窗时一并收掉） */
  }
  el.querySelector("#tplSubTitle").textContent = title || "";
  el.querySelector("#tplSubBody").innerHTML = "";
  el.classList.add("on");
  return el.querySelector("#tplSubBody");
}
function closeTplSubOverlay() {
  const el = $("#tplSubOv");
  if (el) {
    el.classList.remove("on");
    const body = el.querySelector("#tplSubBody");
    if (body) body.innerHTML = "";
  }
}

async function showTplImageLightbox(item) {
  const sizePart = item.bytes ? " · " + fmtBytes(item.bytes) : "";
  const body = openTplSubOverlay((item.title || I18n.t("预览图像")) + sizePart);
  const ph = document.createElement("div");
  ph.className = "tpl-lightbox-ph";
  ph.textContent = I18n.t("加载中…");
  body.appendChild(ph);
  const src = await tplPreviewSrc(item.id, "full");
  if (!src) {
    ph.textContent = I18n.t("无预览");
    return;
  }
  const img = document.createElement("img");
  img.className = "tpl-lightbox-img";
  img.alt = item.title || "";
  img.src = src;
  body.innerHTML = "";
  body.appendChild(img);
}

/* 只读画布预览：节点色块 + 连线，自动居中显示全貌 */
function paintReadonlyWfPreview(host, wf) {
  host.innerHTML = "";
  const nodes = (wf && wf.nodes) || [];
  const wires = (wf && wf.wires) || [];
  if (!nodes.length) {
    host.appendChild(hintEl(I18n.t("（空画布）")));
    return;
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + (n.w || 200));
    maxY = Math.max(maxY, n.y + (n.h || 120));
  }
  const pad = 48;
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const wrap = document.createElement("div");
  wrap.className = "tpl-wf-prev";
  const stage = document.createElement("div");
  stage.className = "tpl-wf-stage";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tpl-wf-svg");
  stage.appendChild(svg);
  for (const n of nodes) {
    const el = document.createElement("div");
    const kcls =
      n.kind === "proc_text" && n.agent
        ? "agent"
        : KIND_CLS[n.kind] || "proc";
    el.className = "tpl-wf-node " + kcls;
    el.style.left = n.x - minX + pad + "px";
    el.style.top = n.y - minY + pad + "px";
    el.style.width = (n.w || 200) + "px";
    el.style.height = Math.min(n.h || 120, 160) + "px";
    const t = document.createElement("div");
    t.className = "tpl-wf-ntitle";
    t.textContent = n.title || I18n.t("（未命名）");
    el.appendChild(t);
    const k = document.createElement("div");
    k.className = "tpl-wf-nkind";
    k.textContent = nodeKindLabel(n);
    el.appendChild(k);
    stage.appendChild(el);
  }
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  for (const w of wires) {
    const a = byId[w.from],
      b = byId[w.to];
    if (!a || !b) continue;
    const ax = a.x - minX + pad + (a.w || 200);
    const ay = a.y - minY + pad + (a.h || 120) / 2;
    const bx = b.x - minX + pad;
    const by = b.y - minY + pad + (b.h || 120) / 2;
    const dx = Math.max(26, Math.abs(bx - ax) * 0.45);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M " + ax + " " + ay + " C " + (ax + dx) + " " + ay + ", " + (bx - dx) + " " + by + ", " + bx + " " + by,
    );
    path.setAttribute("class", "tpl-wf-wire");
    svg.appendChild(path);
  }
  const sw = bw + pad * 2;
  const sh = bh + pad * 2;
  stage.style.width = sw + "px";
  stage.style.height = sh + "px";
  svg.setAttribute("width", sw);
  svg.setAttribute("height", sh);
  wrap.appendChild(stage);
  host.appendChild(wrap);
  requestAnimationFrame(() => {
    const vw = wrap.clientWidth || 640;
    const vh = wrap.clientHeight || 400;
    const z = Math.min(vw / sw, vh / sh, 1.05) * 0.92;
    stage.style.transform =
      "translate(" +
      ((vw - sw * z) / 2) +
      "px," +
      ((vh - sh * z) / 2) +
      "px) scale(" +
      z +
      ")";
  });
}

async function tplInvalidateTplCache(id) {
  if (!id) return;
  try {
    await window.api.storeCacheDelete(id);
  } catch (_) {}
  TPL_PREV_CACHE.delete(id + ":thumb");
  TPL_PREV_CACHE.delete(id + ":full");
}

async function tplFetchFileCached(item) {
  const id = item.id;
  const remoteUpdated = item.updatedAt != null ? Number(item.updatedAt) || 0 : 0;
  const remoteBytes = item.bytes != null ? Number(item.bytes) || 0 : 0;
  const cached = await window.api.storeCacheGet(id);
  if (cached && cached.ok && cached.base64) {
    const stale =
      (remoteUpdated && cached.updatedAt && cached.updatedAt !== remoteUpdated) ||
      (remoteBytes && cached.bytes && cached.bytes !== remoteBytes) ||
      (remoteUpdated && !cached.updatedAt);
    if (!stale) {
      return {
        base64: cached.base64,
        fromCache: true,
        title: cached.title || item.title,
      };
    }
    try {
      await window.api.storeCacheDelete(id);
    } catch (_) {}
  }
  const r = await tplApi("GET", "/api/templates/" + encodeURIComponent(id) + "/file");
  if (!r || !r.ok || !r.data || !r.data.base64) {
    throw new Error(tplErr(r));
  }
  await window.api.storeCachePut({
    id,
    base64: r.data.base64,
    title: item.title || r.data.title || "",
    updatedAt: remoteUpdated || item.updatedAt || 0,
  });
  return { base64: r.data.base64, fromCache: false, title: item.title || r.data.title };
}

async function openTemplateStore() {
  openOverlay(I18n.t("创意工坊"));
  overlayPersistent = true;
  overlayKind = "tplstore";
  const box = document.querySelector("#overlay .overlay-box");
  if (box) {
    box.classList.add("wide");
    box.classList.add("tpl-store");
  }
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.innerHTML = "";
  body.classList.add("tpl-store-body");
  foot.innerHTML = "";

  const kindRow = document.createElement("div");
  kindRow.className = "tpl-top tpl-kind-row";
  const kindTpl = mkMiniBtn(I18n.t("模板"), () => {
    if (TPL_ST.kind === "templates") return;
    TPL_ST.kind = "templates";
    TPL_ST.page = 1;
    TPL_ST.tag = "";
    tplResetDraft();
    paint();
  });
  const kindSkill = mkMiniBtn("Skill", () => {
    if (TPL_ST.kind === "skills") return;
    TPL_ST.kind = "skills";
    TPL_ST.page = 1;
    TPL_ST.tag = "";
    tplResetDraft();
    paint();
  });
  kindRow.appendChild(kindTpl);
  kindRow.appendChild(kindSkill);
  body.appendChild(kindRow);

  const top = document.createElement("div");
  top.className = "tpl-top";
  const tabBrowse = mkMiniBtn(I18n.t("浏览"), () => {
    TPL_ST.tab = "browse";
    TPL_ST.page = 1;
    paint();
  });
  const tabUpload = mkMiniBtn(I18n.t("上传"), () => {
    TPL_ST.tab = "upload";
    paint();
  });
  const tabMine = mkMiniBtn(I18n.t("我的"), () => {
    TPL_ST.tab = "mine";
    TPL_ST.page = 1;
    paint();
  });
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const userEl = document.createElement("span");
  userEl.className = "tpl-user";
  top.appendChild(tabBrowse);
  top.appendChild(tabUpload);
  top.appendChild(tabMine);
  top.appendChild(spacer);
  top.appendChild(userEl);
  body.appendChild(top);
  const pane = document.createElement("div");
  pane.className = "tpl-pane";
  body.appendChild(pane);
  foot.appendChild(mkMiniBtn(I18n.t("关闭"), closeOverlay, true));

  /* 统一账户：顶栏登录 / 登出 / 绑定后，商店用户区立即跟随同一账号。
     只重画用户区（不整页重画），避免与 refreshMe → refresh → onChange 形成回环。 */
  if (window.MTNodeAuth && typeof window.MTNodeAuth.onChange === "function") {
    if (tplAuthUnsub) tplAuthUnsub();
    tplAuthUnsub = window.MTNodeAuth.onChange(() => {
      if (overlayKind !== "tplstore") return;
      paintUser();
    });
  }
  if (window.MTNodeAuth && typeof window.MTNodeAuth.refresh === "function") {
    window.MTNodeAuth.refresh().catch(() => {});
  }

  function markTabs() {
    kindTpl.classList.toggle("on", !tplIsSkill());
    kindSkill.classList.toggle("on", tplIsSkill());
    tabBrowse.classList.toggle("on", TPL_ST.tab === "browse");
    tabUpload.classList.toggle("on", TPL_ST.tab === "upload");
    tabMine.classList.toggle("on", TPL_ST.tab === "mine");
  }
  function paintUser() {
    userEl.innerHTML = "";
    const a = tplAuth();
    if (!a) {
      userEl.textContent = I18n.t("未登录");
      const loginBtn = mkMiniBtn(I18n.t("登录 / 注册"), () => openUnifiedAuth(paint));
      userEl.appendChild(document.createTextNode("  "));
      userEl.appendChild(loginBtn);
      return;
    }
    const b = document.createElement("b");
    b.textContent = a.nickname || a.username || "";
    userEl.appendChild(b);
    if (a.isAdmin) {
      const adm = document.createElement("span");
      adm.textContent = " · " + I18n.t("管理员");
      userEl.appendChild(adm);
    }
    const st = document.createElement("span");
    st.textContent =
      " · " +
      I18n.t("获赞 ") +
      (a.likesReceived || 0) +
      " · " +
      I18n.t("被下载 ") +
      (a.downloadsReceived || 0) +
      " ";
    userEl.appendChild(st);
    userEl.appendChild(
      mkMiniBtn(I18n.t("退出"), async () => {
        await setTplAuth(null);
        toast(I18n.t("已退出"), "ok");
        paint();
      }),
    );
  }
  async function refreshMe() {
    if (!tplAuth()) return;
    /* 账号摘要以主进程 auth-store 为唯一真源：先刷新 /api/me，再取统一快照。 */
    if (window.api && typeof window.api.authMe === "function") {
      await window.api.authMe().catch(() => {});
    } else {
      await tplApi("GET", "/api/me");
    }
    const A = window.MTNodeAuth;
    if (A && typeof A.refresh === "function") await A.refresh().catch(() => {});
  }

  function paintAuthForm(host, after) {
    /* 旧注册接口已停用（410 REGISTER_DISABLED）：商店不再自建账号表单，
       登录 / 注册 / 绑定统一走顶栏同一套 MTNodeAuth 对话框。 */
    const wrap = document.createElement("div");
    wrap.className = "tpl-auth";
    wrap.appendChild(hintEl(I18n.t("上传需要登录")));
    wrap.appendChild(
      hintEl(
        I18n.t(
          "商店与讨论区共用同一 MTNode 账户：手机验证码 / 微信扫码登录，旧账号可用密码登录后补绑。",
        ),
      ),
    );
    wrap.appendChild(
      mkMiniBtn(
        I18n.t("登录 / 注册"),
        () =>
          openUnifiedAuth(() => {
            if (typeof after === "function") after();
            else paint();
          }),
        true,
      ),
    );
    host.appendChild(wrap);
  }

  function fillThumb(wrap, item) {
    wrap.innerHTML = "";
    wrap.className = "tpl-thumb-wrap";
    if (!item.hasPreview) {
      const ph = document.createElement("div");
      ph.className = "tpl-thumb ph";
      ph.textContent = I18n.t("无预览");
      wrap.appendChild(ph);
      return;
    }
    const img = document.createElement("img");
    img.className = "tpl-thumb";
    img.alt = item.title || "";
    img.title = I18n.t("点击查看大图");
    img.onclick = (ev) => {
      ev.stopPropagation();
      showTplImageLightbox(item);
    };
    wrap.appendChild(img);
    tplPreviewSrc(item.id, "thumb").then((src) => {
      if (src) img.src = src;
      else {
        wrap.innerHTML = "";
        const ph = document.createElement("div");
        ph.className = "tpl-thumb ph";
        ph.textContent = I18n.t("无预览");
        wrap.appendChild(ph);
      }
    });
  }

  async function downloadTpl(item) {
    if (tplIsSkill()) {
      const skillName = item.skillName || "";
      if (!skillName) {
        toast(I18n.t("技能名无效"), "err");
        return;
      }
      const local = findLocalSkill(skillName);
      const updating = !!(local && !local.builtin);
      if (
        !(await confirmDialog(
          updating
            ? I18n.t("将用工坊版本覆盖本机技能「{name}」。确定更新？", {
                name: skillName,
              })
            : I18n.t("下载技能到本机后，智能节点可通过 / 使用。确定下载？"),
          {
            title: updating ? I18n.t("更新技能") : I18n.t("下载技能"),
          },
        ))
      )
        return;
      const r = await tplApi(
        "GET",
        "/api/skills/" + encodeURIComponent(item.id) + "/file",
      );
      if (!r || !r.ok || !r.data || !(r.data.text || r.data.base64)) {
        toast(I18n.t("下载失败：") + tplErr(r), "err");
        return;
      }
      let text = r.data.text || "";
      if (!text && r.data.base64) {
        try {
          text = decodeURIComponent(escape(atob(r.data.base64)));
        } catch {
          toast(I18n.t("技能内容解码失败"), "err");
          return;
        }
      }
      const extras = Array.isArray(r.data.extras)
        ? r.data.extras.map((f) => ({
            path: f.path,
            base64: f.base64,
            bytes: f.bytes || 0,
          }))
        : [];
      const rr = await window.api.skillAdd({
        name: skillName,
        description: item.description || "",
        body: text,
        overwrite: updating,
        files: extras,
        storeMeta: {
          storeId: item.id,
          version: item.version || r.data.version || "1.0.0",
          updatedAt: item.updatedAt || Date.now(),
          official: !!item.official,
          title: item.title || "",
        },
      });
      if (!rr || rr.ok === false) {
        toast(I18n.t("安装失败：") + ((rr && rr.error) || I18n.t("未知错误")), "err");
        return;
      }
      await refreshLocalSkillsForStore();
      _skillListCache = { at: 0, skills: [] };
      toast(
        updating
          ? I18n.t("已更新技能 ") + skillName
          : I18n.t("已下载技能 ") + skillName,
        "ok",
      );
      paint();
      return;
    }
    if (!(await confirmDialog(I18n.t("导入将打开为新画布，当前画布会保留。确定下载？"), { title: I18n.t("下载模板") }))) return;
    let pack;
    try {
      pack = await tplFetchFileCached(item);
    } catch (e) {
      toast(I18n.t("导入失败：") + ((e && e.message) || String(e)), "err");
      return;
    }
    const imp = await window.api.mtnodesImportBase64(pack.base64);
    if (!imp || !imp.ok) {
      toast(I18n.t("导入失败：") + ((imp && imp.error) || I18n.t("未知错误")), "err");
      return;
    }
    const wf = imp.workflow;
    wf.id = "wf_" + Date.now().toString(36);
    if (item.title) wf.name = item.title;
    closeTplSubOverlay();
    closeOverlay();
    await adoptImportedWorkflow(wf);
  }

  async function previewTplNodes(item) {
    if (tplIsSkill()) {
      const body = openTplSubOverlay(
        I18n.t("技能预览") +
          " · " +
          (item.title || item.skillName || I18n.t("（未命名）")) +
          (item.version ? " · v" + item.version : "") +
          (item.bytes ? " · " + fmtBytes(item.bytes) : ""),
      );
      const ph = document.createElement("div");
      ph.className = "tpl-lightbox-ph";
      ph.textContent = I18n.t("加载技能中…");
      body.appendChild(ph);
      const r = await tplApi(
        "GET",
        "/api/skills/" + encodeURIComponent(item.id) + "/file",
      );
      if (!r || !r.ok || !r.data) {
        ph.textContent = I18n.t("加载失败：") + tplErr(r);
        return;
      }
      const text = r.data.text || "";
      body.innerHTML = "";
      const note = document.createElement("div");
      note.className = "tpl-prev-note";
      const local = findLocalSkill(item.skillName);
      note.textContent =
        (item.official ? I18n.t("官方 Skill") + " · " : "") +
        (local
          ? I18n.t("本机已安装") +
            (local.version ? " v" + local.version : "") +
            (local.version && item.version && local.version !== item.version
              ? " · " + I18n.t("工坊有新版本，需手动更新")
              : "")
          : I18n.t("只读预览 · 下载后才会写入本机"));
      body.appendChild(note);
      const pre = document.createElement("pre");
      pre.className = "tpl-skill-md";
      pre.textContent = text.slice(0, 120000);
      body.appendChild(pre);
      const foot = document.createElement("div");
      foot.className = "dsh-btn-row";
      foot.style.marginTop = "8px";
      foot.appendChild(
        mkMiniBtn(
          local && !local.builtin ? I18n.t("更新到本机") : I18n.t("下载到本机"),
          () => downloadTpl(item),
          true,
        ),
      );
      foot.appendChild(mkMiniBtn(I18n.t("关闭"), closeTplSubOverlay));
      body.appendChild(foot);
      return;
    }
    const body = openTplSubOverlay(
      I18n.t("节点预览") +
        " · " +
        (item.title || I18n.t("（未命名）")) +
        (item.bytes ? " · " + fmtBytes(item.bytes) : ""),
    );
    const ph = document.createElement("div");
    ph.className = "tpl-lightbox-ph";
    ph.textContent = I18n.t("加载模板中…");
    body.appendChild(ph);
    let pack;
    try {
      pack = await tplFetchFileCached(item);
    } catch (e) {
      ph.textContent = I18n.t("加载失败：") + ((e && e.message) || String(e));
      return;
    }
    const imp = await window.api.mtnodesPeekBase64(pack.base64);
    if (!imp || !imp.ok) {
      ph.textContent =
        I18n.t("加载失败：") + ((imp && imp.error) || I18n.t("未知错误"));
      return;
    }
    const wf = imp.workflow;
    try {
      migrateWf(wf);
    } catch (_) {}
    body.innerHTML = "";
    const note = document.createElement("div");
    note.className = "tpl-prev-note";
    const sizePart = item.bytes
      ? " · " + I18n.t("大小 ") + fmtBytes(item.bytes)
      : "";
    note.textContent =
      (pack.fromCache
        ? I18n.t("只读预览 · 已缓存，下载时无需重复拉取")
        : I18n.t("只读预览 · 已写入本地缓存，下载时将直接导入")) + sizePart;
    body.appendChild(note);
    const host = document.createElement("div");
    host.className = "tpl-wf-host";
    body.appendChild(host);
    paintReadonlyWfPreview(host, wf);
    const foot = document.createElement("div");
    foot.className = "dsh-btn-row";
    foot.style.marginTop = "8px";
    foot.appendChild(
      mkMiniBtn(I18n.t("下载到画布"), () => downloadTpl(item), true),
    );
    foot.appendChild(mkMiniBtn(I18n.t("关闭"), closeTplSubOverlay));
    body.appendChild(foot);
  }
  async function likeTpl(item) {
    if (!tplAuth()) {
      toast(I18n.t("点赞需要登录"), "warn");
      TPL_ST.tab = "upload";
      TPL_ST.authMode = "login";
      paint();
      return;
    }
    const r = await tplApi(
      "POST",
      tplApiBase() + "/" + encodeURIComponent(item.id) + "/like",
      {},
    );
    if (!r || !r.ok) {
      toast(tplErr(r), "err");
      return;
    }
    await refreshMe();
    paint();
  }

  function cardEl(item, mine) {
    const list = TPL_ST.view === "list";
    const card = document.createElement("div");
    card.className = "tpl-card" + (list ? " list" : "");
    const thumb = document.createElement("div");
    card.appendChild(thumb);
    fillThumb(thumb, item);

    const body = document.createElement("div");
    body.className = "tpl-card-body";

    const title = document.createElement("div");
    title.className = "tpl-title";
    const titleTxt = item.title || I18n.t("（未命名）");
    title.textContent =
      (item.official ? "★ " : "") +
      titleTxt +
      (item.version ? " · v" + item.version : "");
    title.title = titleTxt + (item.skillName ? " (" + item.skillName + ")" : "");
    body.appendChild(title);

    if (item.description) {
      const d = document.createElement("div");
      d.className = "tpl-desc";
      d.textContent = item.description;
      d.title = item.description;
      body.appendChild(d);
    }

    const meta = document.createElement("div");
    meta.className = "tpl-meta";
    const owner =
      (item.owner && (item.owner.nickname || item.owner.username)) || "";
    const bits = [];
    if (item.official) bits.push(I18n.t("官方"));
    if (item.skillName) bits.push(item.skillName);
    if (owner) bits.push(owner);
    if (item.bytes) bits.push(fmtBytes(item.bytes));
    if (item.files && item.files.length > 1) {
      bits.push("+" + (item.files.length - 1) + I18n.t(" 个附件"));
    }
    bits.push("↓" + (item.downloads || 0));
    bits.push("♥" + (item.likes || 0));
    meta.textContent = bits.join(" · ");
    meta.title = meta.textContent;
    body.appendChild(meta);

    if (item.tags && item.tags.length) {
      const tags = document.createElement("div");
      tags.className = "tpl-card-tags";
      const full = item.tags.join(" · ");
      tags.title = full;
      item.tags.forEach((tg) => {
        const chip = document.createElement("span");
        chip.className = "tpl-tag";
        chip.textContent = tg;
        tags.appendChild(chip);
      });
      body.appendChild(tags);
      requestAnimationFrame(() => {
        if (!tags.isConnected || tags.scrollWidth <= tags.clientWidth + 1) return;
        const ell = document.createElement("span");
        ell.className = "tpl-tag tpl-tag-more";
        ell.textContent = "…";
        tags.appendChild(ell);
        while (
          tags.children.length > 2 &&
          tags.scrollWidth > tags.clientWidth + 1
        ) {
          tags.removeChild(tags.children[tags.children.length - 2]);
        }
        if (tags.scrollWidth > tags.clientWidth + 1 && tags.children.length > 1) {
          tags.removeChild(tags.children[0]);
        }
      });
    }

    const row = document.createElement("div");
    row.className = "tpl-card-actions";
    row.appendChild(
      mkIconBtn(
        tplIsSkill() ? "☰" : "◈",
        tplIsSkill() ? I18n.t("技能预览") : I18n.t("节点预览"),
        () => previewTplNodes(item),
      ),
    );
    if (tplIsSkill()) {
      const local = findLocalSkill(item.skillName);
      const installed = !!(local && !local.builtin);
      const newer =
        installed &&
        item.version &&
        local.version &&
        String(local.version) !== String(item.version);
      if (installed) {
        row.appendChild(
          mkIconBtn(
            "↻",
            newer ? I18n.t("更新") : I18n.t("已安装（可再更新）"),
            () => downloadTpl(item),
            { primary: !!newer, on: !newer },
          ),
        );
      } else {
        row.appendChild(
          mkIconBtn("⬇", I18n.t("下载"), () => downloadTpl(item), { primary: true }),
        );
      }
    } else {
      row.appendChild(
        mkIconBtn("⬇", I18n.t("下载"), () => downloadTpl(item), { primary: true }),
      );
    }
    row.appendChild(
      mkIconBtn(
        item.liked ? "♥" : "♡",
        item.liked ? I18n.t("已点赞") : I18n.t("点赞"),
        () => likeTpl(item),
        { on: !!item.liked },
      ),
    );
    if (mine) {
      row.appendChild(
        mkIconBtn("✎", I18n.t("编辑"), () => {
          TPL_ST.tab = "upload";
          TPL_ST.editId = item.id;
          TPL_ST.title = item.title || "";
          TPL_ST.description = item.description || "";
          TPL_ST.tags = (item.tags || []).slice();
          TPL_ST.version = item.version || "1.0.0";
          TPL_ST.official = !!item.official;
          TPL_ST.skillName = item.skillName || "";
          TPL_ST.skillText = "";
          TPL_ST.skillExtras = [];
          TPL_ST.fileBase64 = "";
          TPL_ST.fileHint = "";
          TPL_ST.previewBase64 = "";
          TPL_ST.previewThumbBase64 = "";
          TPL_ST.previewHint = "";
          TPL_ST._clearPreview = false;
          if (tplIsSkill()) {
            TPL_ST.fileHint = I18n.t("正在加载工坊正文…");
            tplApi(
              "GET",
              "/api/skills/" + encodeURIComponent(item.id) + "/file",
            ).then((r) => {
              if (!r || !r.ok || !r.data) {
                TPL_ST.fileHint = I18n.t("加载失败：") + tplErr(r);
                return;
              }
              applySkillDraftFromText(r.data.text || "", { fillMeta: false });
              TPL_ST.skillExtras = Array.isArray(r.data.extras)
                ? r.data.extras.map((f) => ({
                    path: f.path,
                    base64: f.base64,
                    bytes: f.bytes || 0,
                  }))
                : [];
              TPL_ST.fileHint =
                I18n.t("已加载工坊正文") +
                (item.version ? " · v" + item.version : "") +
                (TPL_ST.skillExtras.length
                  ? " · +" + TPL_ST.skillExtras.length + I18n.t(" 个附件")
                  : "") +
                " · " +
                fmtBytes(r.data.bytes || 0);
              if (TPL_ST.tab === "upload" && tplIsSkill()) paint();
            });
          }
          paint();
        }),
      );
      if (tplCanDelete(item)) {
        const del = mkIconBtn("✕", I18n.t("删除"), async () => {
          if (del.dataset.sure !== "1") {
            del.dataset.sure = "1";
            del.title = I18n.t("确认删除");
            del.classList.add("danger");
            del.classList.add("on");
            return;
          }
          const r = await tplApi(
            "DELETE",
            tplApiBase() + "/" + encodeURIComponent(item.id),
          );
          if (!r || !r.ok) {
            toast(tplErr(r), "err");
            return;
          }
          if (!tplIsSkill()) await tplInvalidateTplCache(item.id);
          toast(
            tplIsSkill() ? I18n.t("已删除技能") : I18n.t("已删除模板"),
            "ok",
          );
          await refreshMe();
          paint();
        });
        row.appendChild(del);
      }
    }
    if (list) {
      card.appendChild(body);
      card.appendChild(row);
    } else {
      body.appendChild(row);
      card.appendChild(body);
    }
    return card;
  }

  function appendTplViewToggle(host) {
    const wrap = document.createElement("span");
    wrap.className = "tpl-view-tog";
    const gridBtn = mkIconBtn("▦", I18n.t("网格视图"), () => {
      if (TPL_ST.view === "grid") return;
      TPL_ST.view = "grid";
      TPL_ST.page = 1;
      paint();
    }, { on: TPL_ST.view !== "list" });
    const listBtn = mkIconBtn("☰", I18n.t("列表视图"), () => {
      if (TPL_ST.view === "list") return;
      TPL_ST.view = "list";
      TPL_ST.page = 1;
      paint();
    }, { on: TPL_ST.view === "list" });
    wrap.appendChild(gridBtn);
    wrap.appendChild(listBtn);
    host.appendChild(wrap);
  }

  function appendTplItems(host, items, mine) {
    const grid = document.createElement("div");
    grid.className = "tpl-grid" + (TPL_ST.view === "list" ? " tpl-list" : "");
    items.forEach((it) => grid.appendChild(cardEl(it, mine)));
    host.appendChild(grid);
  }

  function appendTplPager(host, total, pageSize) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (pages <= 1) return;
    const pg = document.createElement("div");
    pg.className = "tpl-page";
    pg.appendChild(
      mkIconBtn("‹", I18n.t("上一页"), () => {
        if (TPL_ST.page > 1) {
          TPL_ST.page -= 1;
          paint();
        }
      }),
    );
    const lab = document.createElement("span");
    lab.textContent = I18n.t("第 ") + TPL_ST.page + " / " + pages + I18n.t(" 页");
    lab.title = I18n.t("共 ") + total + (tplIsSkill() ? I18n.t(" 个技能") : I18n.t(" 个模板"));
    pg.appendChild(lab);
    pg.appendChild(
      mkIconBtn("›", I18n.t("下一页"), () => {
        if (TPL_ST.page < pages) {
          TPL_ST.page += 1;
          paint();
        }
      }),
    );
    host.appendChild(pg);
  }

  async function paintBrowse() {
    pane.className = "tpl-pane";
    if (tplIsSkill()) await refreshLocalSkillsForStore();
    pane.appendChild(hintEl(I18n.t("工坊加载中…")));
    const pageSize = tplBrowsePageSize();
    const qs =
      "?q=" +
      encodeURIComponent(TPL_ST.q) +
      "&tag=" +
      encodeURIComponent(TPL_ST.tag) +
      "&sort=" +
      encodeURIComponent(TPL_ST.sort) +
      "&page=" +
      TPL_ST.page +
      "&pageSize=" +
      pageSize;
    const r = await tplApi("GET", tplApiBase() + qs);
    pane.innerHTML = "";
    if (!r || !r.ok || !r.data) {
      pane.appendChild(hintEl(I18n.t("创意工坊不可用：") + tplErr(r)));
      return;
    }
    const tags = r.data.tags || [];
    const tagRow = document.createElement("div");
    tagRow.className = "tpl-tags";
    const all = document.createElement("button");
    all.className = "tpl-tag" + (TPL_ST.tag ? "" : " on");
    all.textContent = I18n.t("全部");
    all.onclick = () => {
      TPL_ST.tag = "";
      TPL_ST.page = 1;
      paint();
    };
    tagRow.appendChild(all);
    tags.forEach((tg) => {
      const b = document.createElement("button");
      b.className = "tpl-tag" + (TPL_ST.tag === tg.name ? " on" : "");
      b.textContent = tg.name;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(tg.count);
      b.appendChild(n);
      b.title = tg.name + " (" + tg.count + ")";
      b.onclick = () => {
        TPL_ST.tag = TPL_ST.tag === tg.name ? "" : tg.name;
        TPL_ST.page = 1;
        paint();
      };
      tagRow.appendChild(b);
    });
    pane.appendChild(tagRow);

    const bar = document.createElement("div");
    bar.className = "tpl-toolbar";
    const q = document.createElement("input");
    q.type = "text";
    q.placeholder = tplIsSkill()
      ? I18n.t("搜索技能、标签或 skillName…")
      : I18n.t("搜索模板或标签…");
    q.value = TPL_ST.q;
    const go = () => {
      TPL_ST.q = q.value.trim();
      TPL_ST.page = 1;
      paint();
    };
    q.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") go();
    });
    const sel = document.createElement("select");
    const sortOpts = [
      ["new", I18n.t("最新")],
      ["downloads", I18n.t("下载量")],
      ["likes", I18n.t("点赞量")],
    ];
    if (tplIsSkill()) sortOpts.push(["official", I18n.t("官方优先")]);
    sortOpts.forEach(([v, lab]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = lab;
      if (TPL_ST.sort === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => {
      TPL_ST.sort = sel.value;
      TPL_ST.page = 1;
      paint();
    };
    bar.appendChild(q);
    bar.appendChild(mkIconBtn("⌕", I18n.t("确定"), go, { primary: true }));
    bar.appendChild(sel);
    pane.appendChild(bar);

    const items = r.data.items || [];
    const total = r.data.total || 0;
    const usedSize = r.data.pageSize || pageSize;
    const head = document.createElement("div");
    head.className = "tpl-grid-head";
    const headLab = document.createElement("span");
    headLab.textContent =
      I18n.t("共 ") + total + (tplIsSkill() ? I18n.t(" 个技能") : I18n.t(" 个模板"));
    head.appendChild(headLab);
    appendTplViewToggle(head);
    pane.appendChild(head);
    if (!items.length) {
      pane.appendChild(
        hintEl(
          TPL_ST.q || TPL_ST.tag
            ? tplIsSkill()
              ? I18n.t("没有匹配的技能")
              : I18n.t("没有匹配的模板")
            : tplIsSkill()
              ? I18n.t("暂无技能")
              : I18n.t("暂无模板"),
        ),
      );
      return;
    }
    appendTplItems(pane, items, false);
    appendTplPager(pane, total, usedSize);
  }

  async function paintUpload() {
    if (!tplAuth()) {
      paintAuthForm(pane);
      return;
    }
    const form = document.createElement("div");
    form.className = "tpl-form";
    if (TPL_ST.editId) {
      form.appendChild(hintEl(I18n.t("编辑") + " · " + (TPL_ST.title || TPL_ST.editId)));
      form.appendChild(
        mkMiniBtn(I18n.t("取消编辑"), () => {
          tplResetDraft();
          paint();
        }),
      );
    }
    const titleLab = document.createElement("label");
    titleLab.textContent = I18n.t("标题");
    const title = document.createElement("input");
    title.type = "text";
    title.maxLength = 80;
    title.placeholder = tplIsSkill() ? I18n.t("技能标题…") : I18n.t("模板标题…");
    title.value = TPL_ST.title;
    title.oninput = () => {
      TPL_ST.title = title.value;
    };
    titleLab.appendChild(title);
    form.appendChild(titleLab);

    if (tplIsSkill()) {
      const verLab = document.createElement("label");
      verLab.textContent = I18n.t("版本");
      const ver = document.createElement("input");
      ver.type = "text";
      ver.maxLength = 32;
      ver.placeholder = "1.0.0";
      ver.dataset.tplSkillVer = "1";
      ver.value = TPL_ST.version || "1.0.0";
      ver.oninput = () => {
        TPL_ST.version = ver.value;
      };
      verLab.appendChild(ver);
      form.appendChild(verLab);
      if (TPL_ST.skillName) {
        form.appendChild(
          hintEl(I18n.t("技能名（不可改）：") + TPL_ST.skillName),
        );
      }
      const auth = tplAuth();
      if (auth && auth.isAdmin) {
        const offRow = document.createElement("label");
        offRow.className = "tpl-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!TPL_ST.official;
        cb.onchange = () => {
          TPL_ST.official = !!cb.checked;
        };
        offRow.appendChild(cb);
        offRow.appendChild(document.createTextNode(" " + I18n.t("标记为官方 Skill（ms2308）")));
        form.appendChild(offRow);
      }
    }

    const descLab = document.createElement("label");
    descLab.textContent = I18n.t("功能描述");
    const desc = document.createElement("textarea");
    desc.rows = 4;
    desc.maxLength = 2000;
    desc.placeholder = tplIsSkill()
      ? I18n.t("介绍这个技能能做什么…")
      : I18n.t("介绍这个模板能做什么…");
    desc.value = TPL_ST.description;
    desc.oninput = () => {
      TPL_ST.description = desc.value;
    };
    descLab.appendChild(desc);
    form.appendChild(descLab);

    const tagLab = document.createElement("label");
    tagLab.textContent = I18n.t("标签");
    tagLab.appendChild(hintEl(I18n.t("点击选择已有标签，或输入后回车添加")));
    const chipRow = document.createElement("div");
    chipRow.className = "tpl-chip-row";
    const paintChips = () => {
      chipRow.innerHTML = "";
      TPL_ST.tags.forEach((tg, i) => {
        const b = document.createElement("button");
        b.className = "tpl-tag on";
        b.textContent = tg + " ×";
        b.onclick = () => {
          TPL_ST.tags.splice(i, 1);
          paintChips();
        };
        chipRow.appendChild(b);
      });
    };
    paintChips();
    tagLab.appendChild(chipRow);
    const tagInp = document.createElement("input");
    tagInp.type = "text";
    tagInp.placeholder = I18n.t("添加标签…");
    tagInp.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const t = tagInp.value.trim().replace(/\s+/g, " ");
      if (!t) return;
      if (TPL_ST.tags.length >= 8) {
        toast(I18n.t("最多 8 个标签"), "warn");
        return;
      }
      if (!TPL_ST.tags.includes(t)) TPL_ST.tags.push(t);
      tagInp.value = "";
      paintChips();
    });
    tagLab.appendChild(tagInp);
    const exist = document.createElement("div");
    exist.className = "tpl-tags";
    tagLab.appendChild(exist);
    form.appendChild(tagLab);
    tplApi("GET", "/api/tags?kind=" + (tplIsSkill() ? "skills" : "templates")).then((tr) => {
      if (!tr || !tr.ok || !tr.data) return;
      exist.innerHTML = "";
      (tr.data.tags || []).forEach((tg) => {
        const b = document.createElement("button");
        b.className = "tpl-tag" + (TPL_ST.tags.includes(tg.name) ? " on" : "");
        b.textContent = tg.name;
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = String(tg.count);
        b.appendChild(n);
        b.onclick = () => {
          const i = TPL_ST.tags.indexOf(tg.name);
          if (i >= 0) TPL_ST.tags.splice(i, 1);
          else if (TPL_ST.tags.length >= 8) {
            toast(I18n.t("最多 8 个标签"), "warn");
            return;
          } else TPL_ST.tags.push(tg.name);
          paintChips();
          b.classList.toggle("on", TPL_ST.tags.includes(tg.name));
        };
        exist.appendChild(b);
      });
    });

    const prevLab = document.createElement("label");
    prevLab.textContent = I18n.t("预览图像（可选，最长边 640）");
    const prevHint = hintEl(TPL_ST.previewHint || (TPL_ST.previewBase64 ? I18n.t("已选择文件：") : ""));
    const prevRow = document.createElement("div");
    prevRow.className = "dsh-btn-row";
    prevRow.appendChild(
      mkMiniBtn(I18n.t("选择预览图像"), async () => {
        const r = await window.api.storePickPreview();
        if (!r || !r.ok) {
          if (r && r.error !== I18n.t("已取消")) toast(tplErr(r), "err");
          return;
        }
        TPL_ST.previewBase64 = r.base64;
        TPL_ST.previewThumbBase64 = r.thumbBase64 || "";
        TPL_ST._clearPreview = false;
        TPL_ST.previewHint =
          I18n.t("已选择文件：") +
          (r.width || "?") +
          "×" +
          (r.height || "?") +
          " · " +
          fmtBytes(r.bytes) +
          (r.thumbBytes ? " / " + I18n.t("缩略图 ") + fmtBytes(r.thumbBytes) : "");
        prevHint.textContent = TPL_ST.previewHint;
      }),
    );
    prevRow.appendChild(
      mkMiniBtn(I18n.t("清除预览"), () => {
        TPL_ST.previewBase64 = "";
        TPL_ST.previewThumbBase64 = "";
        TPL_ST.previewHint = I18n.t("已清除预览");
        TPL_ST._clearPreview = true;
        prevHint.textContent = TPL_ST.previewHint;
      }),
    );
    prevLab.appendChild(prevRow);
    prevLab.appendChild(prevHint);
    form.appendChild(prevLab);

    const fileLab = document.createElement("label");
    if (tplIsSkill()) {
      fileLab.textContent = "SKILL.md（" + I18n.t("每个文件 ≤200KB") + "）";
      fileLab.appendChild(
        hintEl(
          TPL_ST.editId
            ? I18n.t("可直接改下方正文并保存到工坊（需新版本）；也可从本机技能载入。本机副本不会自动跟着变。")
            : I18n.t("拖入或选择 SKILL.md 与附件（可多选/整夹）；自动填写标题与描述；需含 frontmatter name（kebab-case）"),
        ),
      );
      const fileHint = hintEl(TPL_ST.fileHint || "");
      const extrasHint = hintEl(
        (TPL_ST.skillExtras || []).length
          ? I18n.t("已选 ") +
              TPL_ST.skillExtras.length +
              I18n.t(" 个附件") +
              " · " +
              TPL_ST.skillExtras.map((f) => f.path).join(", ")
          : I18n.t("未选择附件"),
      );
      const syncExtrasHint = () => {
        extrasHint.textContent =
          (TPL_ST.skillExtras || []).length
            ? I18n.t("已选 ") +
              TPL_ST.skillExtras.length +
              I18n.t(" 个附件") +
              " · " +
              TPL_ST.skillExtras.map((f) => f.path).join(", ")
            : I18n.t("未选择附件");
      };
      const fileRow = document.createElement("div");
      fileRow.className = "dsh-btn-row";
      const syncBodyUi = () => {
        bodyTa.value = TPL_ST.skillText || "";
        fileHint.textContent = TPL_ST.fileHint || "";
        if (title && TPL_ST.title) title.value = TPL_ST.title;
        if (desc && TPL_ST.description != null) desc.value = TPL_ST.description;
        if (TPL_ST.version) {
          const verInp = form.querySelector('input[data-tpl-skill-ver="1"]');
          if (verInp) verInp.value = TPL_ST.version;
        }
        syncExtrasHint();
      };
      const dropZone = document.createElement("div");
      dropZone.className = "tpl-skill-drop";
      dropZone.tabIndex = 0;
      dropZone.innerHTML =
        "<b>" +
        I18n.t("拖入 SKILL.md 与附加文件") +
        "</b><span>" +
        I18n.t("支持多选文件，或拖入整个技能文件夹；将自动填写标题、描述、版本") +
        "</span>";
      const onDropFiles = async (dt) => {
        dropZone.classList.remove("hot");
        const ok = await ingestSkillDropFiles(dt);
        if (!ok) return;
        syncBodyUi();
        paint();
      };
      dropZone.addEventListener("dragenter", (ev) => {
        ev.preventDefault();
        dropZone.classList.add("hot");
      });
      dropZone.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        dropZone.classList.add("hot");
      });
      dropZone.addEventListener("dragleave", (ev) => {
        if (!dropZone.contains(ev.relatedTarget)) dropZone.classList.remove("hot");
      });
      dropZone.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onDropFiles(ev.dataTransfer);
      });
      fileLab.appendChild(dropZone);
      fileRow.appendChild(
        mkMiniBtn(I18n.t("选择 SKILL.md / 附件…"), async () => {
          const r = await window.api.storePickSkillMd();
          if (!r || !r.ok) {
            if (r && r.error !== I18n.t("已取消")) toast(tplErr(r), "err");
            return;
          }
          if (
            !applySkillUploadBundle(
              {
                text: r.text || "",
                bytes: r.bytes,
                name: r.name,
                base64: r.base64,
              },
              r.files || [],
              { replaceExtras: true },
            )
          ) {
            return;
          }
          syncBodyUi();
          paint();
        }),
      );
      fileRow.appendChild(
        mkMiniBtn(I18n.t("使用本机技能"), async () => {
          await refreshLocalSkillsForStore();
          const list = (TPL_ST._localSkills || []).filter((s) => !s.builtin);
          if (!list.length) {
            toast(I18n.t("本机暂无可载入的技能"), "warn");
            return;
          }
          const body = openTplSubOverlay(I18n.t("选择本机技能"));
          const note = document.createElement("div");
          note.className = "tpl-prev-note";
          note.textContent = I18n.t("载入后可编辑并发布到工坊（仅上传者可更新已有条目）");
          body.appendChild(note);
          list.forEach((s) => {
            const row = document.createElement("div");
            row.className = "dsh-btn-row";
            row.style.marginBottom = "6px";
            const lab = document.createElement("span");
            lab.style.flex = "1";
            lab.textContent =
              (s.title || s.name) +
              " · " +
              s.name +
              (s.version ? " · v" + s.version : "");
            row.appendChild(lab);
            row.appendChild(
              mkMiniBtn(
                I18n.t("载入"),
                async () => {
                  if (
                    TPL_ST.editId &&
                    TPL_ST.skillName &&
                    s.name !== TPL_ST.skillName
                  ) {
                    toast(
                      I18n.t("本机技能名与工坊条目不一致，不能覆盖该条目"),
                      "err",
                    );
                    return;
                  }
                  const g = await window.api.skillGet(s.name);
                  if (!g || !g.ok || !g.body) {
                    toast(I18n.t("加载失败：") + ((g && g.error) || ""), "err");
                    return;
                  }
                  applySkillDraftFromText(g.body);
                  TPL_ST.skillExtras = Array.isArray(g.files)
                    ? g.files.map((f) => ({
                        path: f.path,
                        base64: f.base64,
                        bytes: f.bytes || 0,
                      }))
                    : [];
                  if (TPL_ST.editId) {
                    TPL_ST.version = bumpSkillVersion(TPL_ST.version || "1.0.0");
                  }
                  TPL_ST.fileHint =
                    I18n.t("已载入本机技能") +
                    " · " +
                    s.name +
                    (TPL_ST.skillExtras.length
                      ? " · +" + TPL_ST.skillExtras.length + I18n.t(" 个附件")
                      : "") +
                    " · " +
                    fmtBytes(new TextEncoder().encode(TPL_ST.skillText).length);
                  closeTplSubOverlay();
                  syncBodyUi();
                  paint();
                },
                true,
              ),
            );
            body.appendChild(row);
          });
          body.appendChild(mkMiniBtn(I18n.t("关闭"), closeTplSubOverlay));
        }),
      );
      fileRow.appendChild(
        mkMiniBtn(I18n.t("粘贴 Markdown"), () => {
          const ta = document.createElement("textarea");
          ta.className = "b64-area";
          ta.placeholder = I18n.t("粘贴完整 SKILL.md…");
          const apply = mkMiniBtn(
            I18n.t("确定"),
            () => {
              const s = ta.value;
              if (!String(s || "").trim()) {
                toast(I18n.t("内容为空"), "err");
                return;
              }
              const bytes = new TextEncoder().encode(s).length;
              if (tplTooLarge(bytes)) return;
              applySkillDraftFromText(s);
              TPL_ST.fileHint =
                I18n.t("已粘贴 Markdown") + " · " + fmtBytes(bytes);
              ta.remove();
              apply.remove();
              syncBodyUi();
            },
            true,
          );
          fileLab.appendChild(ta);
          fileLab.appendChild(apply);
        }),
      );
      fileLab.appendChild(fileRow);
      fileLab.appendChild(fileHint);

      const extrasLab = document.createElement("div");
      extrasLab.style.marginTop = "10px";
      extrasLab.textContent =
        I18n.t("附加文件（可选，如 schemas.md；每个 ≤200KB）");
      const extrasRow = document.createElement("div");
      extrasRow.className = "dsh-btn-row";
      extrasRow.appendChild(
        mkMiniBtn(I18n.t("添加附件…"), async () => {
          const r = await window.api.storePickSkillFiles();
          if (!r || !r.ok) {
            if (r && r.error !== I18n.t("已取消")) toast(tplErr(r), "err");
            return;
          }
          const next = mergeSkillExtras(r.files || [], { replace: false });
          if (!next) return;
          syncExtrasHint();
        }),
      );
      extrasRow.appendChild(
        mkMiniBtn(I18n.t("清除附件"), () => {
          TPL_ST.skillExtras = [];
          TPL_ST._extrasTouched = true;
          syncExtrasHint();
        }),
      );
      fileLab.appendChild(extrasLab);
      fileLab.appendChild(extrasRow);
      fileLab.appendChild(extrasHint);

      const bodyLab = document.createElement("div");
      bodyLab.style.marginTop = "8px";
      bodyLab.textContent = I18n.t("技能正文（可在此直接修改）");
      const bodyTa = document.createElement("textarea");
      bodyTa.className = "tpl-skill-editor";
      bodyTa.rows = 14;
      bodyTa.placeholder = I18n.t("SKILL.md 全文…");
      bodyTa.value = TPL_ST.skillText || "";
      bodyTa.oninput = () => {
        TPL_ST.skillText = bodyTa.value;
        TPL_ST.fileBase64 = skillTextToBase64(TPL_ST.skillText);
        const meta = parseSkillFrontmatterClient(TPL_ST.skillText);
        if (meta.name && !TPL_ST.editId) TPL_ST.skillName = meta.name;
        TPL_ST.fileHint =
          I18n.t("已编辑正文") +
          " · " +
          fmtBytes(new TextEncoder().encode(TPL_ST.skillText).length);
        fileHint.textContent = TPL_ST.fileHint;
      };
      fileLab.appendChild(bodyLab);
      fileLab.appendChild(bodyTa);
      form.appendChild(fileLab);
    } else {
    fileLab.textContent = ".mtnodes（" + I18n.t("最大 10MB") + "）";
    const fileHint = hintEl(
      TPL_ST.fileHint ||
        (TPL_ST.editId
          ? I18n.t("编辑时可不重新选文件（仅改标题等）；选择新画布将覆盖工坊模板")
          : ""),
    );
    const fileRow = document.createElement("div");
    fileRow.className = "dsh-btn-row";
    fileRow.appendChild(
      mkMiniBtn(I18n.t("使用当前画布"), async () => {
        const data = cloneWfForExport();
        if (!data) {
          toast(I18n.t("导出失败：画布包含无法序列化的数据"), "err");
          return;
        }
        stripWorkspacesForStoreUpload(data);
        const r = await window.api.mtnodesExportBase64(data);
        if (!r || !r.ok) {
          toast(I18n.t("导出失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
          return;
        }
        if (tplTooLarge(r.bytes)) return;
        TPL_ST.fileBase64 = r.base64;
        TPL_ST.fileHint = I18n.t("已选择当前画布") + " · " + fmtBytes(r.bytes);
        fileHint.textContent = TPL_ST.fileHint;
        if (!TPL_ST.title && S.wf && S.wf.name) {
          TPL_ST.title = S.wf.name;
          title.value = TPL_ST.title;
        }
      }),
    );
    fileRow.appendChild(
      mkMiniBtn(I18n.t("选择 .mtnodes 文件"), async () => {
        const r = await window.api.storePickMtNodes();
        if (!r || !r.ok) {
          if (r && r.error !== I18n.t("已取消")) toast(tplErr(r), "err");
          return;
        }
        if (tplTooLarge(r.bytes)) return;
        TPL_ST.fileBase64 = r.base64;
        TPL_ST.fileHint = I18n.t("已选择文件：") + (r.name || "") + " · " + fmtBytes(r.bytes);
        fileHint.textContent = TPL_ST.fileHint;
      }),
    );
    fileRow.appendChild(
      mkMiniBtn(I18n.t("粘贴 Base64"), () => {
        const ta = document.createElement("textarea");
        ta.className = "b64-area";
        ta.placeholder = I18n.t("粘贴 Base64 内容…");
        const apply = mkMiniBtn(I18n.t("确定"), () => {
          const s = ta.value.trim().replace(/\s+/g, "");
          if (!s) {
            toast(I18n.t("Base64 内容为空"), "err");
            return;
          }
          TPL_ST.fileBase64 = s;
          TPL_ST.fileHint = I18n.t("已粘贴 Base64");
          fileHint.textContent = TPL_ST.fileHint;
          ta.remove();
          apply.remove();
        }, true);
        fileLab.appendChild(ta);
        fileLab.appendChild(apply);
      }),
    );
    fileLab.appendChild(fileRow);
    fileLab.appendChild(fileHint);
    form.appendChild(fileLab);
    }

    form.appendChild(
      mkMiniBtn(
        TPL_ST.editId
          ? I18n.t("保存修改")
          : tplIsSkill()
            ? I18n.t("发布技能")
            : I18n.t("发布模板"),
        async () => {
          const titleV = (TPL_ST.title || "").trim();
          if (!titleV) {
            toast(I18n.t("请填写标题"), "err");
            return;
          }
          if (
            !TPL_ST.editId &&
            !(tplIsSkill() ? TPL_ST.skillText || TPL_ST.fileBase64 : TPL_ST.fileBase64)
          ) {
            toast(
              tplIsSkill()
                ? I18n.t("请先选择、粘贴或编写 SKILL.md")
                : I18n.t("请先选择或粘贴模板文件"),
              "err",
            );
            return;
          }
          if (tplIsSkill() && TPL_ST.skillText) {
            TPL_ST.fileBase64 = skillTextToBase64(TPL_ST.skillText);
          }
          const replacingFile = !!TPL_ST.fileBase64;
          if (tplIsSkill() && replacingFile && !(TPL_ST.version || "").trim()) {
            toast(I18n.t("请填写版本号"), "err");
            return;
          }
          if (
            tplIsSkill() &&
            TPL_ST.editId &&
            replacingFile &&
            TPL_ST.skillName
          ) {
            const meta = parseSkillFrontmatterClient(TPL_ST.skillText || "");
            if (meta.name && meta.name !== TPL_ST.skillName) {
              toast(
                I18n.t("不可更改 skill name（当前为 ") +
                  TPL_ST.skillName +
                  "）",
                "err",
              );
              return;
            }
          }
          if (
            TPL_ST.editId &&
            replacingFile &&
            !(await confirmDialog(
              tplIsSkill()
                ? I18n.t("确认覆盖工坊中的技能正文？修改立即生效；本机已下载副本需手动更新。")
                : I18n.t("确认覆盖工坊中的模板画布？本地预览/下载缓存将同步更新。"),
              {
                title: tplIsSkill() ? I18n.t("覆盖技能") : I18n.t("覆盖模板"),
                danger: true,
                okText: I18n.t("覆盖"),
              },
            ))
          ) {
            return;
          }
          const payload = {
            title: titleV,
            description: TPL_ST.description || "",
            tags: TPL_ST.tags.slice(),
          };
          if (tplIsSkill()) {
            payload.version = (TPL_ST.version || "1.0.0").trim();
            const auth = tplAuth();
            if (auth && auth.isAdmin) payload.official = !!TPL_ST.official;
            if (!TPL_ST.editId || replacingFile || TPL_ST._extrasTouched) {
              payload.files = (TPL_ST.skillExtras || []).map((f) => ({
                path: f.path,
                base64: f.base64,
              }));
            }
          }
          if (TPL_ST.fileBase64) {
            if (tplIsSkill()) {
              payload.fileBase64 = TPL_ST.fileBase64;
            } else {
              try {
                const stripped = await stripStoreMtNodesBase64(TPL_ST.fileBase64);
                TPL_ST.fileBase64 = stripped.base64;
                payload.fileBase64 = stripped.base64;
                const approx = stripped.bytes || 0;
                if (tplTooLarge(approx)) return;
              } catch (e) {
                toast(
                  I18n.t("导出失败：") + ((e && e.message) || String(e)),
                  "err",
                );
                return;
              }
            }
          }
          if (TPL_ST._clearPreview) payload.previewBase64 = "";
          else if (TPL_ST.previewBase64) {
            payload.previewBase64 = TPL_ST.previewBase64;
            if (TPL_ST.previewThumbBase64)
              payload.previewThumbBase64 = TPL_ST.previewThumbBase64;
          }
          const editId = TPL_ST.editId;
          const skillNameSnap = TPL_ST.skillName;
          const skillTextSnap = TPL_ST.skillText;
          const skillExtrasSnap = (TPL_ST.skillExtras || []).slice();
          const versionSnap = payload.version;
          const r = editId
            ? await tplApi("PATCH", tplApiBase() + "/" + encodeURIComponent(editId), payload)
            : await tplApi("POST", tplApiBase(), payload);
          if (!r || !r.ok) {
            toast(tplErr(r), "err");
            return;
          }
          if (
            tplIsSkill() &&
            skillNameSnap &&
            skillTextSnap &&
            (replacingFile || !editId || payload.files)
          ) {
            const local = findLocalSkill(skillNameSnap);
            if (local && !local.builtin) {
              try {
                await window.api.skillAdd({
                  name: skillNameSnap,
                  description: TPL_ST.description || "",
                  body: skillTextSnap,
                  overwrite: true,
                  files: skillExtrasSnap,
                  storeMeta: {
                    storeId: (r.data && r.data.item && r.data.item.id) || editId,
                    version: versionSnap || "1.0.0",
                    updatedAt:
                      (r.data && r.data.item && r.data.item.updatedAt) ||
                      Date.now(),
                    official: !!(r.data && r.data.item && r.data.item.official),
                    title: titleV,
                  },
                });
                await refreshLocalSkillsForStore();
                _skillListCache = { at: 0, skills: [] };
              } catch (_) {}
            }
          }
          if (!tplIsSkill() && editId && replacingFile) {
            const item = (r.data && r.data.item) || {};
            await tplInvalidateTplCache(editId);
            if (payload.fileBase64) {
              await window.api.storeCachePut({
                id: editId,
                base64: payload.fileBase64,
                title: titleV,
                updatedAt: item.updatedAt || Date.now(),
              });
            }
          } else if (editId && (TPL_ST._clearPreview || payload.previewBase64)) {
            TPL_PREV_CACHE.delete((tplIsSkill() ? "s:" : "t:") + editId + ":thumb");
            TPL_PREV_CACHE.delete((tplIsSkill() ? "s:" : "t:") + editId + ":full");
          }
          toast(editId ? I18n.t("已保存修改") : I18n.t("上传成功"), "ok");
          tplResetDraft();
          TPL_ST._clearPreview = false;
          TPL_ST.tab = "mine";
          paint();
        },
        true,
      ),
    );
    pane.appendChild(form);
  }

  async function paintMine() {
    pane.className = "tpl-pane";
    if (!tplAuth()) {
      paintAuthForm(pane);
      return;
    }
    if (tplIsSkill()) await refreshLocalSkillsForStore();
    pane.appendChild(hintEl(I18n.t("工坊加载中…")));
    const r = await tplApi("GET", tplIsSkill() ? "/api/me/skills" : "/api/me/templates");
    pane.innerHTML = "";
    if (!r || !r.ok || !r.data) {
      pane.appendChild(hintEl(I18n.t("加载失败：") + tplErr(r)));
      return;
    }
    if (r.data.user) {
      await refreshMe();
      paintUser();
    }
    const u = r.data.user || {};
    const allItems = r.data.items || [];
    const pageSize = tplBrowsePageSize();
    const total = allItems.length;
    const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
    if (TPL_ST.page > pages) TPL_ST.page = pages;
    const start = (TPL_ST.page - 1) * pageSize;
    const items = allItems.slice(start, start + pageSize);

    const head = document.createElement("div");
    head.className = "tpl-grid-head";
    const headLab = document.createElement("span");
    headLab.textContent =
      I18n.t("获赞 ") +
      (u.likesReceived || 0) +
      " · " +
      I18n.t("被下载 ") +
      (u.downloadsReceived || 0) +
      " · " +
      I18n.t("共 ") +
      total +
      (tplIsSkill() ? I18n.t(" 个技能") : I18n.t(" 个模板"));
    head.appendChild(headLab);
    appendTplViewToggle(head);
    pane.appendChild(head);
    if (!total) {
      pane.appendChild(
        hintEl(tplIsSkill() ? I18n.t("暂无技能") : I18n.t("暂无模板")),
      );
      return;
    }
    appendTplItems(pane, items, true);
    appendTplPager(pane, total, pageSize);
  }

  async function paint() {
    markTabs();
    paintUser();
    pane.innerHTML = "";
    if (TPL_ST.tab === "upload") await paintUpload();
    else if (TPL_ST.tab === "mine") await paintMine();
    else await paintBrowse();
  }

  await refreshMe();
  if (tplIsSkill()) await refreshLocalSkillsForStore();
  await paint();
}


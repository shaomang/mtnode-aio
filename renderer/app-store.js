"use strict";
/* ============ 模板商店 ============ */
const TPL_PREV_CACHE = new Map();
/* 商店用户区对统一账户的订阅句柄（每次开商店重新订阅，避免叠加）。 */
let tplAuthUnsub = null;
const TPL_ST = {
  kind: "templates", /* templates（画布）| workflows（工作流）| skills */
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
  /* 待继承的封面（本机工作流的 bgImage dataURL）：上传页开出来后再压成预览图，
     见 tplPreviewFromDataUrl / paintUpload 里的 applyCover。 */
  coverDataUrl: "",
  /* 工作流专用：端子清单来自封装本身（外侧桥接／汇流线现算），发布时随包带上，
     卡片与详情用它画「入 n / 出 n」；nodeCount 只是展示用的规模数字。 */
  workflowPorts: null,
  workflowNodeCount: 0,
  /* 这条工坊条目对应的本机工作流库 id（发布 / 更新成功后写回库条目的 storeId 靠它） */
  wfSourceId: "",
  authMode: "login",
  _localSkills: null,
};

function tplIsSkill() {
  return TPL_ST.kind === "skills";
}
/* 「工作流」与画布（模板）共用同一套浏览 / 详情 / 上传骨架：区别只在服务端路径、
   端子上限校验、以及下载落到本机工作流库（**不**开新画布）。 */
function tplIsWorkflow() {
  return TPL_ST.kind === "workflows";
}
function tplApiBase() {
  if (tplIsSkill()) return "/api/skills";
  return tplIsWorkflow() ? "/api/workflows" : "/api/templates";
}
/* 界面上的类别名（服务端 kind 仍是 template：这里只改文案，零迁移） */
function tplKindName() {
  if (tplIsSkill()) return I18n.t("技能");
  return tplIsWorkflow() ? I18n.t("工作流") : I18n.t("画布");
}
function tplKindTagParam() {
  return tplIsSkill() ? "skills" : tplIsWorkflow() ? "workflows" : "templates";
}
/* 卡片 / 详情里的端子徽标行（工作流专用）：入 n · 出 n + 前几个端子名 */
function tplPortChipsEl(item) {
  const ports = (item && item.ports) || null;
  if (!ports || (!Array.isArray(ports.ins) && !Array.isArray(ports.outs))) return null;
  const ins = Array.isArray(ports.ins) ? ports.ins : [];
  const outs = Array.isArray(ports.outs) ? ports.outs : [];
  const row = document.createElement("div");
  row.className = "tpl-port-chips";
  const mkSide = (list, dir) => {
    const g = document.createElement("span");
    g.className = "tpl-port-side " + dir;
    const lab = document.createElement("b");
    lab.textContent = (dir === "in" ? I18n.t("入 ") : I18n.t("出 ")) + list.length;
    g.appendChild(lab);
    list.slice(0, 4).forEach((p) => {
      const c = document.createElement("span");
      c.className = "tpl-port-chip";
      c.textContent = String((p && p.name) || "");
      c.title = c.textContent + (p && p.kind ? "（" + p.kind + "）" : "");
      g.appendChild(c);
    });
    if (list.length > 4) {
      const more = document.createElement("span");
      more.className = "tpl-port-more";
      more.textContent = "+" + (list.length - 4);
      g.appendChild(more);
    }
    return g;
  };
  row.appendChild(mkSide(ins, "in"));
  row.appendChild(mkSide(outs, "out"));
  return row;
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

/* 「数字 + 鲸圆币图标 + 尾串」内联元件（本轮需求：界面上把「币」字换成鲸圆币 icon）。
 * 中文界面单位就是那枚图标、不再写「币」字；英文界面在数字后补 " W coins"（纯图标读不出单位）。
 * 用在条目的「累计打赏」行与卡片元信息行；MtCoin 缺席（夹具 / 预览页）时退回纯文本，不抛错。 */
function storeCoinInlineEl(text, tail) {
  const span = document.createElement("span");
  span.className = "coin-inline";
  span.appendChild(document.createTextNode(String(text)));
  const en = window.I18n && I18n.getLocale && I18n.getLocale() === "en";
  if (en && window.MtCoin && window.MtCoin.shortName) span.appendChild(document.createTextNode(" " + window.MtCoin.shortName()));
  if (window.MtCoin && window.MtCoin.coinIcon) span.appendChild(window.MtCoin.coinIcon("sm"));
  if (tail) span.appendChild(document.createTextNode(String(tail)));
  return span;
}
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
  TPL_ST.coverDataUrl = "";
  TPL_ST.workflowPorts = null;
  TPL_ST.workflowNodeCount = 0;
  TPL_ST.wfSourceId = "";
  TPL_ST.wfDirectUpdate = false;
  TPL_ST._clearPreview = false;
  TPL_ST._extrasTouched = false;
}

/* 本机工作流的封面（节点层 bgImage）→ 工坊预览图：与主进程 store:pickPreview 同一口径
 * （主图长边 ≤640、缩略图 ≤240，一律 JPEG 82 / 72）。封面本身是 ≤1600 边长、≤512KB 的
 * dataURL（可能带 alpha 的 PNG），直接交给服务端会撞 500KB 的预览上限，所以上传前压一道。 */
async function tplPreviewFromDataUrl(dataUrl) {
  const src = String(dataUrl || "");
  if (!/^data:image\//i.test(src)) return null;
  const img = await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
  const w0 = (img && (img.naturalWidth || img.width)) || 0;
  const h0 = (img && (img.naturalHeight || img.height)) || 0;
  if (!w0 || !h0) return null;
  const draw = (maxEdge) => {
    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    /* 透明区在 JPEG 里会变黑：先铺工坊卡片的底色，看着才像封面而不是破图 */
    ctx.fillStyle = "#10151c";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { cv, w, h };
  };
  const full = draw(640);
  if (!full) return null;
  const thumb = draw(240);
  const cut = (u) => String(u).slice(String(u).indexOf(",") + 1);
  const base64 = cut(full.cv.toDataURL("image/jpeg", 0.82));
  const thumbBase64 = thumb ? cut(thumb.cv.toDataURL("image/jpeg", 0.72)) : "";
  return {
    base64,
    thumbBase64,
    bytes: Math.floor((base64.length * 3) / 4),
    thumbBytes: thumbBase64 ? Math.floor((thumbBase64.length * 3) / 4) : 0,
    width: full.w,
    height: full.h,
  };
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
/* 本机技能清单的「用到时必已加载」：开窗首帧不再等这次 skillList 扫描，但每一个读
   TPL_ST._localSkills 的地方都要先 await ensureLocalSkillsForStore() —— 否则「还没扫完」
   （null）会被当成「本机没装过」，卡片上的「更新」会显示成「下载」（甚至当成新装覆盖）。
   已经有一次在跑就共用同一个 promise，不重复扫描。 */
let TPL_LOCAL_SKILLS_P = null;
function ensureLocalSkillsForStore() {
  if (Array.isArray(TPL_ST._localSkills)) return Promise.resolve(TPL_ST._localSkills);
  if (!TPL_LOCAL_SKILLS_P) {
    TPL_LOCAL_SKILLS_P = Promise.resolve()
      .then(() => refreshLocalSkillsForStore())
      .catch(() => TPL_ST._localSkills || [])
      .then((list) => {
        TPL_LOCAL_SKILLS_P = null;
        return list;
      });
  }
  return TPL_LOCAL_SKILLS_P;
}

/* 本机工作流库清单：「这条工坊条目下载过没有」靠它（origin.storeId / storeId）。
   与技能同理，卡片是同步渲染的，读之前先 await ensureLocalWorkflowsForStore()。 */
async function refreshLocalWorkflowsForStore() {
  try {
    const r = await window.api.workflowsList();
    TPL_ST._localWorkflows = (r && r.ok && r.workflows) || [];
  } catch {
    TPL_ST._localWorkflows = [];
  }
  return TPL_ST._localWorkflows || [];
}
function findLocalWorkflow(item) {
  const sid = String((item && item.id) || "");
  if (!sid) return null;
  return (
    (TPL_ST._localWorkflows || []).find((w) => {
      const o = (w && w.origin) || {};
      return String((w && w.storeId) || o.storeId || "") === sid;
    }) || null
  );
}
let TPL_LOCAL_WFS_P = null;
function ensureLocalWorkflowsForStore() {
  if (Array.isArray(TPL_ST._localWorkflows))
    return Promise.resolve(TPL_ST._localWorkflows);
  if (!TPL_LOCAL_WFS_P) {
    TPL_LOCAL_WFS_P = Promise.resolve()
      .then(() => refreshLocalWorkflowsForStore())
      .catch(() => TPL_ST._localWorkflows || [])
      .then((list) => {
        TPL_LOCAL_WFS_P = null;
        return list;
      });
  }
  return TPL_LOCAL_WFS_P;
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

/* 打赏 / 评论的对象标识：工坊条目只有模板与 Skill 两类（与 store-saas 的 targetKind 同源）。
   服务端与客户端都用这一份拼法，别在别处再拼一遍。 */
function tplTipsTarget(item) {
  return { kind: tplIsSkill() ? "skill" : "template", id: item && item.id };
}

/* 条目详情窗里的「条目 / 评论」页签（工坊与应用的评论是同一套评论区，见 app-comments.js）。
   返回 { box, setTab }；内容由调用方填进两个 pane。 */
function detailTabsEl(labels, onTab) {
  const bar = document.createElement("div");
  bar.className = "detail-tabs";
  const panes = [];
  const box = document.createElement("div");
  box.className = "detail-tabs-box";
  const btns = (labels || []).map((label, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "detail-tab" + (i === 0 ? " on" : "");
    b.textContent = label;
    const pane = document.createElement("div");
    pane.className = "detail-pane" + (i === 0 ? "" : " hidden");
    panes.push(pane);
    b.addEventListener("click", () => {
      btns.forEach((x, j) => {
        x.classList.toggle("on", j === i);
        panes[j].classList.toggle("hidden", j !== i);
      });
      if (typeof onTab === "function") onTab(i);
    });
    bar.appendChild(b);
    return b;
  });
  box.appendChild(bar);
  panes.forEach((p) => box.appendChild(p));
  return { box, panes, setTab: (i) => btns[i] && btns[i].click() };
}

/* 条目详情窗：受窗口宽度限制，二级浮层里给「条目 / 评论」两个页签；
   评论页签里是 app-comments.js 的完整评论区（列表 + 互回 + 发表 + 分页）。 */
function openTplItemDetail(item) {
  if (!item || !item.id) return;
  const body = openTplSubOverlay(item.title || I18n.t("（未命名）"));
  const isSkill = !!(item.skillName || item.files);
  /* 评论 / 评分 / 打赏的 targetKind：工作流在服务端是独立的一类（评论池分开） */
  const target = {
    kind: isSkill ? "skill" : tplIsWorkflow() ? "workflow" : "template",
    id: item.id,
  };
  const tabs = detailTabsEl([I18n.t("条目"), I18n.t("评论")], (i) => {
    if (i === 1) detailMountComments();
  });
  body.appendChild(tabs.box);

  /* ── 条目页签 ── */
  const info = tabs.panes[0];
  const rows = [];
  if (item.description) rows.push([I18n.t("简介"), item.description]);
  if (item.skillName) rows.push(["Skill", item.skillName]);
  if (item.version) rows.push([I18n.t("版本"), "v" + item.version]);
  /* 工作流：外侧端子清单（入 / 出各占一行，名字直给）——别人看详情就是为了判断能不能接上 */
  if (tplIsWorkflow() && item.ports) {
    const ins = Array.isArray(item.ports.ins) ? item.ports.ins : [];
    const outs = Array.isArray(item.ports.outs) ? item.ports.outs : [];
    const names = (list) =>
      list.length ? list.map((p) => String((p && p.name) || "")).join(" · ") : I18n.t("无");
    rows.push([I18n.t("输入端子"), String(ins.length) + " · " + names(ins)]);
    rows.push([I18n.t("输出端子"), String(outs.length) + " · " + names(outs)]);
  }
  rows.push([I18n.t("作者"), (item.owner && (item.owner.nickname || item.owner.username)) || I18n.t("未知")]);
  rows.push([I18n.t("下载"), String(item.downloads || 0)]);
  rows.push([I18n.t("获赞"), String(item.likes || 0)]);
  const rate = window.MtComments ? window.MtComments.ratingText(item.rating, { empty: "" }) : "";
  if (rate) rows.push([I18n.t("评分"), rate]);
  if (item.tips && item.tips.count) {
    const coins = window.MtCoin ? window.MtCoin.coinsOfYuan(item.tips.totalYuan || 0) : 0;
    /* 单位 = 鲸圆币图标（本轮口径：中文界面不写「币」字）：`100 [icon] · 3 次`。
       行值允许是**节点**（见下面渲染那一段：字符串走 textContent，节点直接挂），
       这样才能把图标插进「数字」与「· N 次」之间。 */
    rows.push([I18n.t("累计打赏"), storeCoinInlineEl(Math.round(coins), " · " + String(item.tips.count) + I18n.t(" 次"))]);
  }
  if (item.bytes) rows.push([I18n.t("体积"), fmtBytes(item.bytes)]);
  if (item.tags && item.tags.length) rows.push([I18n.t("标签"), item.tags.join(" · ")]);
  const table = document.createElement("div");
  table.className = "apps-detail-rows";
  rows.forEach(([k, v]) => {
    const r = document.createElement("div");
    r.className = "apps-detail-row";
    const kk = document.createElement("span");
    kk.className = "apps-detail-k";
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.className = "apps-detail-v";
    /* 行值：字符串走 textContent（老口径一字不改），节点直接挂（币数那种要插图标的走这条） */
    if (v && typeof v === "object" && v.nodeType === 1) {
      vv.appendChild(v);
      vv.title = v.textContent || "";
    } else {
      vv.textContent = v;
      vv.title = v;
    }
    r.appendChild(kk);
    r.appendChild(vv);
    table.appendChild(r);
  });
  info.appendChild(table);

  /* ── 评论页签（懒挂载：第一次切过去才拉数据） ── */
  let cmtMounted = false;
  function detailMountComments() {
    if (cmtMounted || !window.MtComments) return;
    cmtMounted = true;
    window.MtComments.mount(tabs.panes[1], target, { title: item.title || "" });
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
  const r = await tplApi("GET", tplApiBase() + "/" + encodeURIComponent(id) + "/file");
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

/* ============ 工坊封面：先进视口再取图（工坊自己的小队列） ============
 * 背景：列表本身是分页 JSON（回执里没有图片字节），封面却是**逐卡一次 IPC → 整张图 base64**
 * 回来当 data URL。改动前 appendTplItems → cardEl → fillThumb 在同一个 items.forEach 里对
 * 一屏最多 48 张同时发起请求：没有 lazy、没有并发闸、没有磁盘缓存。
 * 这里的口径（与应用中心 app-apps-img.js 同一套思路，但**不依赖那个模块** —— 它绑的是 URL
 * 预取，工坊是 base64 回调）：
 *   ① 先占位：卡片进 DOM 时只挂一块纯底色骨架（.tpl-thumb-skel），一张图都不取；
 *   ② 进视口才取：IntersectionObserver（rootMargin 往外约一屏）命中才 tplPreviewSrc(id,"thumb")；
 *   ③ 并发上限 6：同时在取的张数封顶，其余排队 —— base64 走 IPC + 整张图，比一个 URL 重；
 *   ④ 一批一起显形：同一收集窗口内到货的图一起 img.src = base64 并加 .tpl-thumb-in（CSS 一次淡入）；
 *   ⑤ 收口：重绘 / 切页 / 关窗时 tplThumbFlush() 作废排队项（代际失效）；元素已脱离 DOM 的
 *      一律不再换地址 —— 不留半张卡，也不会把图换到别的卡上。
 * 无 IntersectionObserver 的运行时退化成「挂上即取」：不 lazy，但功能不缺。
 * 大图灯箱（showTplImageLightbox）不走这里：它保持「点开才拉 full」。
 * 内存缓存 TPL_PREV_CACHE 照旧（命中缓存的那次 tplPreviewSrc 直接返回，不再发请求）。 */
const TPL_THUMB_CONCURRENCY = 6;
/* 一批图的收集窗口（毫秒）：这段时间内到货的算同一批，一起换上（≈5 帧，够收一屏，又不至于等） */
const TPL_THUMB_BATCH_WINDOW = 80;
const TPL_THUMB_EL = new WeakMap(); /* img 元素 → { el, wrap, item, obs, gen, started } */
let TPL_THUMB_OBS = null; /* 视口观察器（懒建，延迟取图的唯一触发口） */
let TPL_THUMB_BATCH = null; /* { items:Set } 当前收集到的一批 */
let TPL_THUMB_TIMER = 0;
let TPL_THUMB_RUNNING = 0; /* 正在取图的张数（并发闸的读数） */
let TPL_THUMB_PEND_SEEN = false; /* 已排了「待取 → 取图」的微任务（同一轮只排一次） */
let TPL_THUMB_HALT = false; /* 刚做过一次收口（重绘 / 切页 / 关窗）：新的一批入队前不再发起取图 */
let TPL_THUMB_GEN = 0; /* 代际：收口时 +1，上一代的结果一律作废 */
const TPL_THUMB_PENDING = []; /* 刚入队、还没进文档的图（下一轮微任务处理） */
const TPL_THUMB_QUEUE = []; /* 等待取图的元素（按入队顺序） */
const TPL_THUMB_INFLIGHT = new Set(); /* 正在取图的元素 */
const TPL_THUMB_OBSERVED = new Set(); /* 已交给观察器、还在等进视口的元素 */

/* 视口观察器（懒建）：rootMargin 往外扩 480px，滚到的位置图通常已就绪。
   没有 IntersectionObserver（老运行时 / 冒烟桩）退化成「挂上即取」：功能不缺。 */
function tplThumbObserver() {
  if (TPL_THUMB_OBS) return TPL_THUMB_OBS;
  if (typeof IntersectionObserver !== "function") return null;
  try {
    TPL_THUMB_OBS = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en || !en.isIntersecting) continue;
          const el = en.target;
          const rec = TPL_THUMB_EL.get(el);
          if (!rec) continue;
          tplThumbUnobserve(rec);
          tplThumbEnqueue(el);
        }
      },
      { rootMargin: "480px 0px" },
    );
  } catch (_) {
    TPL_THUMB_OBS = null;
  }
  return TPL_THUMB_OBS;
}

function tplThumbUnobserve(rec) {
  if (!rec) return;
  if (rec.el) TPL_THUMB_OBSERVED.delete(rec.el);
  if (!rec.obs) return;
  try {
    rec.obs.unobserve(rec.el);
  } catch (_) {}
  rec.obs = null;
}

/* 元素还在文档里吗：真 DOM 用 isConnected；桩环境没有它就退回「能不能走回 document.body」 */
function tplThumbLive(el) {
  if (!el) return false;
  if (typeof el.isConnected === "boolean") return el.isConnected;
  let n = el;
  let hops = 0;
  while (n && hops++ < 128) {
    if (typeof document !== "undefined" && n === document.body) return true;
    n = n.parentNode;
  }
  return false;
}

/* 「无预览」= 终态（这条目本来就没有预览图，或者取回来是空的）；
   取图中 = .tpl-thumb-skel 纯底色骨架。两者样式不同：占位期间不写「无预览」三个字，
   否则每张卡都会先闪一句「无预览」再变成图 —— 那是在说假话。 */
function tplThumbNoPreviewEl() {
  const ph = document.createElement("div");
  ph.className = "tpl-thumb ph";
  ph.textContent = I18n.t("无预览");
  return ph;
}
function tplThumbNoPreview(wrap) {
  if (!tplThumbLive(wrap)) return; /* 元素已拆：连占位都不再动它 */
  wrap.innerHTML = "";
  wrap.appendChild(tplThumbNoPreviewEl());
}

/* 建卡时唯一入口（cardEl 调它）：先挂占位 + 交给观察器，进视口才真去取图。
   返回那个 <img>（还没进视口的卡上，它没有 src）。 */
function tplThumbFill(wrap, item) {
  wrap.innerHTML = "";
  wrap.className = "tpl-thumb-wrap";
  if (!item || !item.hasPreview) {
    wrap.appendChild(tplThumbNoPreviewEl());
    return null;
  }
  const img = document.createElement("img");
  img.className = "tpl-thumb";
  img.alt = item.title || "";
  img.title = I18n.t("点击查看大图");
  img.onclick = (ev) => {
    ev.stopPropagation();
    showTplImageLightbox(item);
  };
  img.setAttribute("data-tpl-thumb", "hold");
  const skel = document.createElement("div");
  skel.className = "tpl-thumb-skel";
  wrap.appendChild(skel);
  wrap.appendChild(img);
  const rec = {
    el: img,
    wrap: wrap,
    item: item,
    obs: null,
    gen: TPL_THUMB_GEN,
    started: false,
  };
  TPL_THUMB_EL.set(img, rec);
  const obs = tplThumbObserver();
  if (obs) {
    rec.obs = obs;
    TPL_THUMB_OBSERVED.add(img);
    try {
      obs.observe(img);
    } catch (_) {}
    return img;
  }
  tplThumbEnqueue(img); /* 没有观察器：退化「挂上即取」 */
  return img;
}

/* 入队：只进**待取队列**，真正的取图交给下一轮微任务（入队这一刻元素往往还没挂进文档） */
function tplThumbEnqueue(el) {
  TPL_THUMB_HALT = false; /* 有新的一批了：解除上一次收口的封口 */
  if (
    TPL_THUMB_PENDING.indexOf(el) >= 0 ||
    TPL_THUMB_QUEUE.indexOf(el) >= 0 ||
    TPL_THUMB_INFLIGHT.has(el)
  )
    return;
  TPL_THUMB_PENDING.push(el);
  tplThumbSchedulePump();
}
function tplThumbSchedulePump() {
  if (TPL_THUMB_PEND_SEEN) return;
  TPL_THUMB_PEND_SEEN = true;
  Promise.resolve().then(() => {
    TPL_THUMB_PEND_SEEN = false;
    tplThumbDrainPending();
  });
}
function tplThumbDrainPending() {
  if (!TPL_THUMB_PENDING.length) return;
  for (const el of TPL_THUMB_PENDING.splice(0, TPL_THUMB_PENDING.length)) TPL_THUMB_QUEUE.push(el);
  tplThumbPump();
}

/* 取图泵：并发上限内把队列里的封面真取回来，一张都不多取 */
function tplThumbPump() {
  if (TPL_THUMB_HALT) {
    /* 刚做过一次收口（上一页 / 上一次重绘的收口）：这一轮不再发起新的取图请求 */
    TPL_THUMB_QUEUE.length = 0;
    TPL_THUMB_PENDING.length = 0;
    return;
  }
  tplThumbDrainPending();
  while (TPL_THUMB_RUNNING < TPL_THUMB_CONCURRENCY && TPL_THUMB_QUEUE.length) {
    const el = TPL_THUMB_QUEUE.shift();
    if (!tplThumbLive(el)) continue; /* 已被拆掉的卡：安静出队 */
    const rec = TPL_THUMB_EL.get(el);
    if (!rec || rec.started) continue;
    rec.started = true;
    if (el.dataset) el.dataset.tplThumb = "load";
    TPL_THUMB_RUNNING++;
    TPL_THUMB_INFLIGHT.add(el);
    tplThumbFetch(rec, () => {
      TPL_THUMB_RUNNING = Math.max(0, TPL_THUMB_RUNNING - 1);
      TPL_THUMB_INFLIGHT.delete(el);
      tplThumbPump();
    });
  }
}

/* 单张取图：仍是既有的 IPC → base64 通路（tplPreviewSrc），拿到字节才换地址。
   一路只走 promise，绝不在取图途中直接写 img.src。 */
function tplThumbFetch(rec, done) {
  let finished = false;
  const fin = () => {
    if (finished) return;
    finished = true;
    done();
  };
  Promise.resolve()
    .then(() => tplPreviewSrc(rec.item.id, "thumb"))
    .catch(() => "")
    .then((src) => tplThumbSettle(rec, src))
    .then(fin, fin);
}

/* base64 到手：还在文档里 + 代际没被作废才换地址，然后进当前批次等一起显形 */
function tplThumbSettle(rec, src) {
  const el = rec && rec.el;
  if (!el) return;
  if (!tplThumbLive(el)) {
    /* 元素已脱离 DOM（切页 / 重绘 / 关窗）：不换地址 —— 图绝不跑到别的卡上 */
    if (el.dataset) el.dataset.tplThumb = "drop";
    return;
  }
  if (rec.gen !== TPL_THUMB_GEN) {
    /* 这一批已被 tplThumbFlush() 作废（排队时的收口）：结果丢弃 */
    if (el.dataset) el.dataset.tplThumb = "drop";
    return;
  }
  if (!src) {
    if (el.dataset) el.dataset.tplThumb = "empty";
    tplThumbNoPreview(rec.wrap); /* 与改动前同一口径：取不到就按「无预览」收尾 */
    return;
  }
  if (el.dataset) el.dataset.tplThumb = "ready";
  try {
    el.src = src;
  } catch (_) {}
  if (!TPL_THUMB_BATCH) TPL_THUMB_BATCH = { items: new Set() };
  TPL_THUMB_BATCH.items.add(el);
  tplThumbArmBatch();
}

/* 每有新成员都要保证收集窗口挂着（图到货时上一批往往已经收过，只 add 不重挂就永远不显形） */
function tplThumbArmBatch() {
  if (!TPL_THUMB_BATCH || TPL_THUMB_TIMER) return;
  TPL_THUMB_TIMER = setTimeout(tplThumbReveal, TPL_THUMB_BATCH_WINDOW);
}

/* 一批到点：把这一批里「已就绪且还在文档里」的图一次性显形（加 class，CSS 里做一次淡入） */
function tplThumbReveal() {
  if (TPL_THUMB_TIMER) {
    clearTimeout(TPL_THUMB_TIMER);
    TPL_THUMB_TIMER = 0;
  }
  const batch = TPL_THUMB_BATCH;
  TPL_THUMB_BATCH = null;
  if (!batch) return;
  for (const el of batch.items) {
    if (!tplThumbLive(el)) continue;
    if (!el.dataset || el.dataset.tplThumb !== "ready") continue;
    if (el.classList) el.classList.add("tpl-thumb-in");
  }
}

/* 收口（重绘 / 切页 / 关窗的唯一入口）：排队中的当场作废，正在路上的标记为上一代 ——
   结果回来时只走「已脱离 DOM / 代际不符」的静默出队，不会再有卡被换上一张半张的图。 */
function tplThumbFlush() {
  TPL_THUMB_GEN++;
  if (TPL_THUMB_TIMER) {
    clearTimeout(TPL_THUMB_TIMER);
    TPL_THUMB_TIMER = 0;
  }
  TPL_THUMB_BATCH = null; /* 还没显形的：DOM 马上要拆，不必再淡入 */
  TPL_THUMB_QUEUE.length = 0;
  TPL_THUMB_PENDING.length = 0;
  for (const el of Array.from(TPL_THUMB_OBSERVED)) {
    const rec = TPL_THUMB_EL.get(el);
    if (rec) tplThumbUnobserve(rec);
  }
  TPL_THUMB_OBSERVED.clear();
  /* 在取的那几张**不计入**置零：请求已经在路上，等它们各自回来时自然递减并发读数，
     这样紧接着的新一屏也不会因为「旧的在途」而超过上限。 */
  for (const el of Array.from(TPL_THUMB_INFLIGHT)) {
    const rec = TPL_THUMB_EL.get(el);
    if (rec) rec.gen = -1;
    if (el.dataset) el.dataset.tplThumb = "drop";
  }
  TPL_THUMB_INFLIGHT.clear();
  TPL_THUMB_HALT = true; /* 收口后不再替上一页取图，直到有新的卡入队（重绘后自然解除） */
}

/* 冒烟 / 验证台口径（生产不看它）：当前排队读数 + 手动收口 */
if (typeof window !== "undefined") {
  window.__mtnodeTplThumb = {
    stats: () => ({
      queued: TPL_THUMB_QUEUE.length,
      pending: TPL_THUMB_PENDING.length,
      running: TPL_THUMB_RUNNING,
      observed: TPL_THUMB_OBSERVED.size,
      batch: TPL_THUMB_BATCH ? TPL_THUMB_BATCH.items.size : 0,
      gen: TPL_THUMB_GEN,
      concurrency: TPL_THUMB_CONCURRENCY,
      rootMargin: "480px 0px",
    }),
    flush: () => tplThumbFlush(),
  };
}

/* 「分享到工坊」的入口（renderer/app-workflows.js 调用）：把本机工作流库那一条
   已经打包好的 .mtnodes 连同端子清单塞进上传箱，直接落在「工作流 → 上传」页。
   不重新打包、不重新剥离 —— 那一份在分享前就已经剥干净了。 */
function openWorkflowUpload(payload) {
  const p = payload || {};
  TPL_ST.kind = "workflows";
  TPL_ST.tab = "upload";
  TPL_ST.page = 1;
  TPL_ST.tag = "";
  tplResetDraft();
  TPL_ST.title = String(p.title || "");
  TPL_ST.description = String(p.description || "");
  TPL_ST.version = String(p.version || "1.0");
  TPL_ST.coverDataUrl = String(p.cover || "");
  TPL_ST.fileBase64 = String(p.fileBase64 || "");
  /* 本机库来源 id：发布 / 更新成功后把工坊条目 id 写回这条库条目，下次就能就地更新 */
  TPL_ST.wfSourceId = String(p.sourceId || "");
  /* 已发布条目 → 按「编辑 / 更新」打开（PATCH 同一条，版本号可改），不新建一条 */
  if (p.updateId) TPL_ST.editId = String(p.updateId);
  TPL_ST.wfDirectUpdate = !!p.updateId && !!p.directUpdate;
  TPL_ST.fileHint = TPL_ST.fileBase64
    ? p.updateId
      ? I18n.t("已载入本机这一版；保存即覆盖工坊条目（可先改上方版本号）")
      : I18n.t("已从本机工作流库载入，可直接发布")
    : "";
  const pp = p.ports || { ins: [], outs: [] };
  TPL_ST.workflowPorts = {
    ins: Array.isArray(pp.ins) ? pp.ins : [],
    outs: Array.isArray(pp.outs) ? pp.outs : [],
  };
  TPL_ST.workflowNodeCount = Number(pp.nodeCount) || 0;
  return openTemplateStore();
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
  /* 三类内容的同一排入口：画布（原「模板」·服务端 kind 仍是 template）/ 工作流 / Skill。
     「工作流」与服务端的第三类内容同名，卡片与详情都按端子清单展示。 */
  const setKind = (k) => {
    if (TPL_ST.kind === k) return;
    TPL_ST.kind = k;
    TPL_ST.page = 1;
    TPL_ST.tag = "";
    tplResetDraft();
    paint();
  };
  const kindTpl = mkMiniBtn(I18n.t("画布"), () => setKind("templates"));
  kindTpl.title = I18n.t("整张画布（导入时打开为新画布）");
  const kindWf = mkMiniBtn(I18n.t("工作流"), () => setKind("workflows"));
  kindWf.title = I18n.t("封装好的一颗节点层（下载进本机工作流库，插进当前画布用）");
  const kindSkill = mkMiniBtn("Skill", () => setKind("skills"));
  kindSkill.title = I18n.t("Agent 技能（下载进本机技能清单）");
  kindRow.appendChild(kindTpl);
  kindRow.appendChild(kindWf);
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
  foot.appendChild(
    mkMiniBtn(
      I18n.t("关闭"),
      () => {
        /* 关窗也是收口点：排队中的封面请求当场作废（重开时 list 会重建，不留半张卡） */
        tplThumbFlush();
        closeOverlay();
      },
      true,
    ),
  );

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
    kindTpl.classList.toggle("on", !tplIsSkill() && !tplIsWorkflow());
    kindWf.classList.toggle("on", tplIsWorkflow());
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

  /* 工作流下载的可见进度提示：全局 toast 只弹 err / warn（成功回执按口径静默），
     而工坊下载一条工作流要拉包 + 落盘，用户需要知道「正在下载」与「已下载完毕」。
     这条提示挂在工坊窗内顶部（pane 之外），页面重绘不会带走它，也不改全局 toast 口径。 */
  let _tplDlNoteEl = null;
  let _tplDlNoteTimer = 0;
  const TPL_DL_BUSY = new Set();
  function tplDlNote(text, kind, ms) {
    const host = document.getElementById("ovBody");
    if (!host) return;
    let el = _tplDlNoteEl;
    if (!el || !el.isConnected) {
      el = document.createElement("div");
      _tplDlNoteEl = el;
      host.insertBefore(el, host.firstChild);
    }
    const k = String(kind || "");
    const tone = k === "err" ? "var(--red)" : k === "ok" ? "var(--green)" : "var(--cyan)";
    el.style.cssText =
      "flex:none;margin:0 0 8px;padding:7px 10px;border-radius:6px;font-size:12px;" +
      "line-height:1.6;border:1px solid var(--bd2);border-left:3px solid " +
      tone +
      ";background:var(--code);color:var(--ink);white-space:pre-wrap";
    el.textContent = text;
    if (_tplDlNoteTimer) clearTimeout(_tplDlNoteTimer);
    _tplDlNoteTimer = 0;
    if (Number(ms) > 0)
      _tplDlNoteTimer = setTimeout(() => {
        if (el.isConnected) el.remove();
        if (_tplDlNoteEl === el) _tplDlNoteEl = null;
      }, Number(ms));
  }

  async function downloadTpl(item) {
    if (tplIsSkill()) {
      const skillName = item.skillName || "";
      if (!skillName) {
        toast(I18n.t("技能名无效"), "err");
        return;
      }
      /* 本机技能清单是首帧之后异步扫的：这里用到就先兜底 await 一次（已扫完则立刻返回） */
      await ensureLocalSkillsForStore();
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
    /* ── 工作流：只收进本机工作流库，不插当前画布、不弹新画布、不自动打开库 ──
       用户点「工作流库 → 插入」才是把它放进画布的那一刻。 */
    if (tplIsWorkflow()) {
      const wfName = item.title || I18n.t("（未命名工作流）");
      /* 同一条目连点两下不要下两次（会往库里落两条） */
      if (TPL_DL_BUSY.has(String(item.id || ""))) return;
      TPL_DL_BUSY.add(String(item.id || ""));
      /* 本机已有这条 → 「更新」：覆盖同一条目，而不是往库里再落一条 */
      await ensureLocalWorkflowsForStore();
      const localWf = findLocalWorkflow(item);
      tplDlNote(
        (localWf ? I18n.t("正在更新工作流：") : I18n.t("正在下载工作流：")) +
          wfName +
          " …",
        "busy",
      );
      try {
        let pack;
        try {
          pack = await tplFetchFileCached(item);
        } catch (e) {
          const msg = (e && e.message) || String(e);
          tplDlNote(I18n.t("下载失败：") + msg, "err", 15000);
          toast(I18n.t("下载失败：") + msg, "err");
          return;
        }
        const imp = await window.api.workflowsImportBase64({
          base64: pack.base64,
          name: item.title || "",
          description: item.description || "",
          version: item.version || "1.0",
          storeId: item.id,
          title: item.title || "",
          replaceId: localWf ? localWf.id : "",
        });
        if (!imp || !imp.ok) {
          const msg = (imp && imp.error) || I18n.t("未知错误");
          tplDlNote(I18n.t("下载失败：") + msg, "err", 15000);
          toast(I18n.t("下载失败：") + msg, "err");
          return;
        }
        await refreshLocalWorkflowsForStore();
        paint();
        tplDlNote(
          (localWf ? I18n.t("已更新到本机工作流库：") : I18n.t("已下载到本机工作流库：")) +
            (imp.name || wfName) +
            I18n.t("（用「工作流库」插入到当前画布）"),
          "ok",
          10000,
        );
      } finally {
        TPL_DL_BUSY.delete(String(item.id || ""));
      }
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
    /* 工作流条目不再提供预览（只读画布预览已移除）：工坊里只看端子清单 + 下载 */
    if (tplIsWorkflow()) return;
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
      /* 同上：本机已装状态靠 findLocalSkill，用到前先兜底一次 */
      await ensureLocalSkillsForStore();
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
    /* 封面不再在这里同步取图：先挂骨架占位，进视口才由 tplThumbFill 的队列去取 */
    tplThumbFill(thumb, item);
    /* 已从工坊下载过：预览图左上角打一枚对钩（工作流看本机工作流库，技能看本机已装） */
    const localWf = tplIsWorkflow() ? findLocalWorkflow(item) : null;
    const localSkillNow = tplIsSkill() ? findLocalSkill(item.skillName) : null;
    if (localWf || (localSkillNow && !localSkillNow.builtin)) {
      const ok = document.createElement("div");
      ok.className = "tpl-thumb-ok";
      ok.textContent = "✓";
      ok.title = I18n.t("已下载到本机");
      thumb.appendChild(ok);
    }

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

    /* 工作流卡片：先把外侧端子摊出来（入 n / 出 n + 端子名）。它是「能不能直接用」的
       第一判断依据 —— 一张只看封面的卡片对这个类别没有信息量。 */
    if (tplIsWorkflow()) {
      const pc = tplPortChipsEl(item);
      if (pc) body.appendChild(pc);
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
    /* 评分与评论数（实时来自服务端；没人评分就不出假分），失败时静默 —— 卡片元信息不因它缺失而空 */
    const cmtBits = [];
    if (window.MtComments) {
      const rt = window.MtComments.ratingText(item.rating, { empty: "" });
      if (rt) cmtBits.push(rt);
      if (item.comments) cmtBits.push(window.MtComments.commentsText(item.comments));
    }
    cmtBits.forEach((b) => bits.push(b));
    meta.textContent = bits.join(" · ");
    /* 打赏那一枚币数走图标口径：数字 + 鲸圆币图标（中文界面不写「币」字），挂在元信息行末尾 */
    if (window.MtTips && item.tips && item.tips.count) {
      const coins = window.MtCoin ? window.MtCoin.coinsOfYuan(item.tips.totalYuan || 0) : 0;
      meta.appendChild(document.createTextNode(" · " + I18n.t("打赏") + " "));
      meta.appendChild(storeCoinInlineEl(Math.round(coins), ""));
    }
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
    /* 工作流条目不出预览按钮：预览功能已从工坊移除（只看端子清单与下载） */
    if (!tplIsWorkflow()) {
      row.appendChild(
        mkIconBtn(
          tplIsSkill() ? "☰" : "◈",
          tplIsSkill() ? I18n.t("技能预览") : I18n.t("节点预览"),
          () => previewTplNodes(item),
        ),
      );
    }
    if (tplIsSkill()) {
      const local = findLocalSkill(item.skillName);
      const installed = !!(local && !local.builtin);
      /* 「有更新」判定：只比 version 会漏掉「同一版本号重新上架（改了正文）」——
         工坊每次 PATCH 都会刷新 updatedAt，用它兜住这一类；两边都可能缺字段。 */
      const remoteAt = Number(item.updatedAt) || 0;
      const localAt = Number(local && local.storeUpdatedAt) || 0;
      const newer =
        installed &&
        ((item.version &&
          local.version &&
          String(local.version) !== String(item.version)) ||
          (remoteAt && localAt && remoteAt > localAt) ||
          (remoteAt && !localAt));
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
    } else if (tplIsWorkflow()) {
      /* 本机已有这条 → 「更新」（覆盖同一条目）；否则才是「下载到本机工作流库」 */
      if (localWf) {
        row.appendChild(
          mkIconBtn(
            "↻",
            I18n.t("更新（已下载到本机，覆盖同一条目）"),
            () => downloadTpl(item),
            { primary: true },
          ),
        );
      } else {
        row.appendChild(
          mkIconBtn(
            "⬇",
            I18n.t("下载到本机工作流库"),
            () => downloadTpl(item),
            { primary: true },
          ),
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
    /* 打赏 + 评论（四类对象同一形态，见 app-tips.js / app-comments.js）。
       打赏按钮只放一枚金币图标（卡片行已经比较满，金额与次数在 meta 行里出）；
       评论按钮点开本条目的详情窗并直接切到「评论」页签。
       带上 item.tips = 服务端公开投影的累计总额：打赏窗里那一行「累计被打赏」**人人可见**，
       不是名单（名单仍仅作者本人与管理员可见）。 */
    if (window.MtTips) {
      /* 图标 = 鲸圆币本尊（本轮口径：全应用统一换掉金币 emoji 与「币」字） */
      const tipIco = window.MtCoin && window.MtCoin.coinIcon ? window.MtCoin.coinIcon("sm") : "🪙";
      row.appendChild(mkIconBtn(tipIco, I18n.t("打赏作者（鲸圆币）"), () =>
        window.MtTips.open(tplTipsTarget(item), { onDone: () => paint(), tips: item.tips }),
      ));
    }
    if (window.MtComments) {
      row.appendChild(
        mkIconBtn("💬", I18n.t("评论"), () => {
          openTplItemDetail(item);
        }),
      );
    }
    if (mine) {
      row.appendChild(
        mkIconBtn("✎", I18n.t("编辑"), () => {
          TPL_ST.tab = "upload";
          TPL_ST.editId = item.id;
          TPL_ST.title = item.title || "";
          TPL_ST.description = item.description || "";
          TPL_ST.tags = (item.tags || []).slice();
          TPL_ST.version = item.version || (tplIsWorkflow() ? "1.0" : "1.0.0");
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
          if (tplIsWorkflow()) {
            /* 编辑工作流：端子清单先按已发布那份回填（不重新选文件时原样带回去，
               免得 PATCH 把别人正在用的端子表抹成空）。 */
            const pp = item.ports || {};
            const norm = (l) =>
              (Array.isArray(l) ? l : []).map((p) => ({
                name: String((p && p.name) || ""),
                kind: String((p && p.kind) || "text"),
              }));
            TPL_ST.workflowPorts = { ins: norm(pp.ins), outs: norm(pp.outs) };
            TPL_ST.workflowNodeCount = 0;
            TPL_ST.fileHint = I18n.t(
              "编辑时会自动载入对应的本机工作流，也可在这里另选一条；保存即更新工坊条目（版本号可改）",
            );
          }
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
            tplIsSkill()
              ? I18n.t("已删除技能")
              : tplIsWorkflow()
                ? I18n.t("已删除工作流")
                : I18n.t("已删除画布"),
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
    /* 卡片的「已安装 / 有更新 / 下载」由 findLocalSkill 决定（cardEl 是同步的，不能在那里等）：
       这里兜底 await 一次本机技能清单 —— 开窗时已经后台起过一次，通常这里直接命中同一个 promise。 */
    if (tplIsSkill()) await ensureLocalSkillsForStore();
    /* 工作流同理：卡片要据此出「更新」按钮与已下载对钩 */
    if (tplIsWorkflow()) await ensureLocalWorkflowsForStore();
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
      : tplIsWorkflow()
        ? I18n.t("搜索工作流、标签…")
        : I18n.t("搜索画布或标签…");
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
      /* 打赏热度：累计打赏额高的在前（服务端 sort=tips 的口径）。条目卡上也能直接看到
         打赏总额与次数，两者同源 —— 需求口径「按热度排序时计入排序」。 */
      ["tips", I18n.t("打赏热度")],
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
      I18n.t("共 ") + total + I18n.t(" 个") + tplKindName();
    head.appendChild(headLab);
    appendTplViewToggle(head);
    pane.appendChild(head);
    if (!items.length) {
      pane.appendChild(
        hintEl(
          TPL_ST.q || TPL_ST.tag
            ? I18n.t("没有匹配的") + tplKindName()
            : I18n.t("暂无") + tplKindName(),
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
    title.placeholder = tplIsSkill()
      ? I18n.t("技能标题…")
      : tplIsWorkflow()
        ? I18n.t("工作流标题…")
        : I18n.t("画布标题…");
    title.value = TPL_ST.title;
    title.oninput = () => {
      TPL_ST.title = title.value;
    };
    titleLab.appendChild(title);
    form.appendChild(titleLab);

    /* 版本号：技能与工作流都带（工作流是「能复用的封装」，版本是它的身份证）；
       画布（模板）沿用旧口径不填版本。 */
    if (tplIsSkill() || tplIsWorkflow()) {
      const verLab = document.createElement("label");
      verLab.textContent = I18n.t("版本");
      const ver = document.createElement("input");
      ver.type = "text";
      ver.maxLength = 32;
      ver.placeholder = tplIsSkill() ? "1.0.0" : "1.0";
      ver.dataset.tplSkillVer = "1";
      ver.value = TPL_ST.version || (tplIsSkill() ? "1.0.0" : "1.0");
      ver.oninput = () => {
        TPL_ST.version = ver.value;
      };
      verLab.appendChild(ver);
      form.appendChild(verLab);
      if (tplIsSkill() && TPL_ST.skillName) {
        form.appendChild(
          hintEl(I18n.t("技能名（不可改）：") + TPL_ST.skillName),
        );
      }
      const auth = tplAuth();
      if (tplIsSkill() && auth && auth.isAdmin) {
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
      : tplIsWorkflow()
        ? I18n.t("介绍这个工作流替你做完哪一段（输入什么、输出什么）…")
        : I18n.t("介绍这个画布能做什么…");
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
    tplApi("GET", "/api/tags?kind=" + tplKindTagParam()).then((tr) => {
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
    /* 上传工作流时继承本机库那份封面（与标题 / 描述 / 版本同源）：整页重画 / 载入到上传箱
       都会带着它；这里没 await，压图回来后只更新预览那一行与状态，不打断用户输入。 */
    const applyCover = async (cover) => {
      const cv = await tplPreviewFromDataUrl(cover);
      if (!cv) return;
      TPL_ST.previewBase64 = cv.base64;
      TPL_ST.previewThumbBase64 = cv.thumbBase64;
      TPL_ST._clearPreview = false;
      TPL_ST.previewHint =
        I18n.t("已继承工作流封面") +
        " · " +
        cv.width +
        "×" +
        cv.height +
        " · " +
        fmtBytes(cv.bytes);
      prevHint.textContent = TPL_ST.previewHint;
    };
    if (TPL_ST.coverDataUrl) {
      const pendingCover = TPL_ST.coverDataUrl;
      TPL_ST.coverDataUrl = "";
      applyCover(pendingCover);
    }
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
    } else if (tplIsWorkflow()) {
      /* ── 工作流上传：只能从本机工作流库来 ──
         工作流＝一颗封装好的节点层，本机库里就是一份快照；这里再按分享口径剥一次
         （库里的条目允许带本机路径，上传出去的包里不许）。 */
      fileLab.textContent = ".mtnodes（" + I18n.t("最大 10MB") + "）";
      fileLab.appendChild(
        hintEl(
          I18n.t(
            "工作流只能从本机工作流库发布（画布右键「分享到工坊」走的也是这条路）。上传那一刻会剥掉本机路径、工作目录、节点层目录、跨画布 @引用与全局广播。",
          ),
        ),
      );
      const fileHint = hintEl(TPL_ST.fileHint || I18n.t("尚未载入工作流"));
      const portBox = document.createElement("div");
      portBox.className = "tpl-port-list";
      const syncPortBox = () => {
        portBox.innerHTML = "";
        const ports = TPL_ST.workflowPorts;
        if (!ports) return;
        const ins = ports.ins || [];
        const outs = ports.outs || [];
        const mkLine = (list, dir) => {
          const d = document.createElement("div");
          d.className = "tpl-port-line";
          d.textContent =
            (dir === "in" ? I18n.t("入 ") : I18n.t("出 ")) +
            list.length +
            " · " +
            (list.length
              ? list.map((p) => String(p.name || "")).join(" / ")
              : I18n.t("（缺）"));
          return d;
        };
        portBox.appendChild(mkLine(ins, "in"));
        portBox.appendChild(mkLine(outs, "out"));
        const note = document.createElement("div");
        note.className = "tpl-port-note";
        note.textContent =
          ins.length && outs.length
            ? I18n.t("端子清单随包带上，工坊列表与详情按它展示")
            : I18n.t(
                "分享要求外侧至少 1 个输入 + 1 个输出：先在画布上把内部节点接到壳上",
              );
        portBox.appendChild(note);
      };
      syncPortBox();

      const wfSel = document.createElement("select");
      wfSel.style.cssText = "min-width:200px;flex:1";
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = I18n.t("（选择本机工作流）");
      wfSel.appendChild(opt0);

      const loadWf = async (id, opts) => {
        const g = await window.api.workflowsGet(id);
        if (!g || !g.ok || !g.workflow) {
          toast(I18n.t("读取工作流失败：") + ((g && g.error) || ""), "err");
          return;
        }
        const wf = g.workflow;
        /* 记住包来自哪条本机库条目：发布 / 更新成功后把工坊条目 id 写回它 */
        TPL_ST.wfSourceId = String(id);
        const graph =
          typeof workflowStripForShare === "function"
            ? workflowStripForShare(wf.graph)
            : wf.graph;
        const pack = await window.api.workflowsExportBase64(id, graph);
        if (!pack || !pack.ok || !pack.base64) {
          toast(I18n.t("打包失败：") + ((pack && pack.error) || ""), "err");
          return;
        }
        if (tplTooLarge(pack.bytes || 0)) return;
        TPL_ST.fileBase64 = pack.base64;
        const ports =
          typeof workflowPortsFromGraph === "function"
            ? workflowPortsFromGraph(wf.graph)
            : null;
        TPL_ST.workflowPorts = ports
          ? {
              ins: ports.ins.map((p) => ({ name: p.name, kind: p.kind })),
              outs: ports.outs.map((p) => ({ name: p.name, kind: p.kind })),
            }
          : null;
        TPL_ST.workflowNodeCount = ports ? ports.nodeCount : 0;
        /* keepVersion：编辑已发布条目时版本号以表单里填的为准（用户可改），
           不被本机库条目的版本覆盖。 */
        if (!opts || !opts.keepVersion) {
          TPL_ST.version = String(wf.version || TPL_ST.version || "1.0");
          const verEl = form.querySelector('input[data-tpl-skill-ver="1"]');
          if (verEl) verEl.value = TPL_ST.version;
        }
        if (!opts || opts.fillMeta !== false) {
          if (wf.name) {
            TPL_ST.title = String(wf.name);
            title.value = TPL_ST.title;
          }
          if (wf.description) {
            TPL_ST.description = String(wf.description);
            desc.value = TPL_ST.description;
          }
          /* 封面也一起继承：工作流库里那一份就是节点层封面（bgImage） */
          if (wf.cover) applyCover(String(wf.cover));
        }
        TPL_ST.fileHint =
          I18n.t("已载入工作流：") +
          (wf.name || "") +
          " · " +
          fmtBytes(pack.bytes || 0) +
          (ports ? " · " + ports.nodeCount + I18n.t(" 内部节点") : "");
        fileHint.textContent = TPL_ST.fileHint;
        syncPortBox();
      };
      const fillWfSel = async () => {
        let list = [];
        try {
          const r = await window.api.workflowsList();
          list = (r && r.ok && r.workflows) || [];
          for (const w of list) {
            const o = document.createElement("option");
            o.value = w.id;
            o.textContent = String(w.name || w.id);
            wfSel.appendChild(o);
          }
          if (!list.length) {
            const o = document.createElement("option");
            o.value = "";
            o.textContent = I18n.t("本机工作流库还是空的");
            o.disabled = true;
            wfSel.appendChild(o);
          }
        } catch (_) {}
        return list;
      };
      const fileRow = document.createElement("div");
      fileRow.className = "dsh-btn-row";
      fileRow.appendChild(wfSel);
      fileRow.appendChild(
        mkMiniBtn(I18n.t("载入到上传箱"), () => {
          const id = wfSel.value;
          if (!id) {
            toast(I18n.t("请先选择一个本机工作流"), "warn");
            return;
          }
          loadWf(id);
        }),
      );
      fileLab.appendChild(fileRow);
      fileLab.appendChild(fileHint);
      fileLab.appendChild(portBox);
      form.appendChild(fileLab);
      fillWfSel().then(async (list) => {
        if (!TPL_ST.editId) return;
        /* 编辑已发布的工作流：默认就把「这条条目对应的本机库条目」预选并载入 ——
           不用再选一次节点层，直接改版本号保存即更新。对应关系优先用发布时写回
           的库 id（wfSourceId，来自工作流库的「更新到工坊」），否则按 wfSourceId
           缺失的老条目 + 同名条目兜底（同名覆盖口径）。 */
        let sid = TPL_ST.wfSourceId;
        const match = (list || []).find((w) => String(w.storeId || "") === String(TPL_ST.editId));
        if (!sid && match) sid = String(match.id || "");
        if (!sid) {
          /* 老条目（发布时还没写回库 id）：按同名兜底，重名时不猜，留给用户手选 */
          const sameName = (list || []).filter(
            (w) => String(w.name || "") === String(TPL_ST.title || ""),
          );
          if (sameName.length === 1) sid = String(sameName[0].id || "");
        }
        if (!sid) return;
        TPL_ST.wfSourceId = sid;
        wfSel.value = sid;
        /* 从库行「更新到工坊」进来时包已经带上了（本机这一版），不必再打一次包 */
        if (TPL_ST.fileBase64) {
          TPL_ST.fileHint =
            I18n.t("已载入本机这一版，保存即更新工坊条目（版本号可改）") +
            (TPL_ST.workflowNodeCount
              ? " · " + TPL_ST.workflowNodeCount + I18n.t(" 内部节点")
              : "");
          fileHint.textContent = TPL_ST.fileHint;
          return;
        }
        await loadWf(sid, { fillMeta: false, keepVersion: true });
        TPL_ST.fileHint =
          I18n.t("已载入本机这一版，保存即更新工坊条目（版本号可改）") +
          (TPL_ST.workflowNodeCount
            ? " · " + TPL_ST.workflowNodeCount + I18n.t(" 内部节点")
            : "");
        fileHint.textContent = TPL_ST.fileHint;
      });
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
            : tplIsWorkflow()
              ? I18n.t("发布工作流")
              : I18n.t("发布画布"),
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
                : tplIsWorkflow()
                  ? I18n.t("请先从本机工作流库载入一个工作流")
                  : I18n.t("请先选择或粘贴画布文件"),
              "err",
            );
            return;
          }
          /* 工作流发布硬校验：外侧至少 1 进 1 出（端子清单随包带上，缺了别人用不了） */
          if (tplIsWorkflow()) {
            const pp = TPL_ST.workflowPorts || {};
            if (!(pp.ins || []).length || !(pp.outs || []).length) {
              toast(
                I18n.t(
                  "无法发布：这颗节点层外侧至少要有 1 个输入和 1 个输出（内部节点用桥接线 / 汇流线接到壳上）",
                ),
                "err",
              );
              return;
            }
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
            !(tplIsWorkflow() && TPL_ST.wfDirectUpdate) &&
            !(await confirmDialog(
              tplIsSkill()
                ? I18n.t("确认覆盖工坊中的技能正文？修改立即生效；本机已下载副本需手动更新。")
                : tplIsWorkflow()
                  ? I18n.t("确认用本机这一版覆盖工坊中的工作流？版本号按上方填写更新，已下载的人需手动更新。")
                  : I18n.t("确认覆盖工坊中的模板画布？本地预览/下载缓存将同步更新。"),
              {
                title: tplIsSkill()
                  ? I18n.t("覆盖技能")
                  : tplIsWorkflow()
                    ? I18n.t("覆盖工作流")
                    : I18n.t("覆盖模板"),
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
          if (tplIsWorkflow()) {
            payload.version = (TPL_ST.version || "1.0").trim() || "1.0";
            const pp = TPL_ST.workflowPorts || { ins: [], outs: [] };
            const norm = (l) =>
              (Array.isArray(l) ? l : []).map((p) => ({
                name: String((p && p.name) || ""),
                kind: String((p && p.kind) || "text"),
              }));
            /* 没换文件、也没载入过端子 → 不写 ports（PATCH 缺省即保留服务端那份） */
            if (pp.ins || pp.outs) payload.ports = { ins: norm(pp.ins), outs: norm(pp.outs) };
          }
          if (TPL_ST.fileBase64) {
            if (tplIsSkill() || tplIsWorkflow()) {
              /* 工作流的剥离在上传前就做完了（workflowStripForShare + 主进程打包），
                 这里不再过画布那套 stripStoreMtNodesBase64。 */
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
          /* 工作流：把工坊条目 id / 标题 / 版本写回本机库条目 —— 库里那条从此带
             「已上传到工坊」标记，并可随时用「更新到工坊」拿当前版本覆盖。 */
          if (tplIsWorkflow()) {
            const srcId = TPL_ST.wfSourceId;
            const itemId = String((r.data && r.data.item && r.data.item.id) || editId || "");
            if (srcId && itemId) {
              try {
                await window.api.workflowsPatch(srcId, {
                  storeId: itemId,
                  storeTitle: titleV,
                  storeVersion: payload.version || "1.0",
                  /* 本地这条就是刚发出去的那一份：版本号跟着走，库行与工坊不再对不上 */
                  version: payload.version || "1.0",
                });
              } catch (_) {}
            }
          }
          if (
            tplIsSkill() &&
            skillNameSnap &&
            skillTextSnap &&
            (replacingFile || !editId || payload.files)
          ) {
            /* 覆盖本机那份之前，先确保本机技能清单已加载（否则会漏掉「本机已装 → 该覆盖」） */
            await ensureLocalSkillsForStore();
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
    if (tplIsSkill()) await ensureLocalSkillsForStore();
    pane.appendChild(hintEl(I18n.t("工坊加载中…")));
    const r = await tplApi("GET", tplIsSkill() ? "/api/me/skills" : tplIsWorkflow() ? "/api/me/workflows" : "/api/me/templates");
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
      I18n.t(" 个") +
      tplKindName();
    head.appendChild(headLab);
    appendTplViewToggle(head);
    pane.appendChild(head);
    if (!total) {
      pane.appendChild(hintEl(I18n.t("暂无") + tplKindName()));
      return;
    }
    appendTplItems(pane, items, true);
    appendTplPager(pane, total, pageSize);
  }

  async function paint() {
    /* 统一收口点：重绘 / 切页 / 换视图前，把上一批封面排队作废（下面马上要清空 pane，
       留在队列里的元素已脱离 DOM —— 再换地址就是往拆掉的卡上写，也白取一遍图）。 */
    tplThumbFlush();
    markTabs();
    paintUser();
    pane.innerHTML = "";
    if (TPL_ST.tab === "upload") await paintUpload();
    else if (TPL_ST.tab === "mine") await paintMine();
    else await paintBrowse();
  }

  /* 首帧不再等账号摘要（/api/me）与本机技能扫描（skillList）：先把列表画出来，
     这两条回来后原地更新 —— 账号行只重画用户区；本机技能清单进 TPL_ST._localSkills，
     技能页 / 下载 / 预览 / 覆盖这些「用到」的地方都有 ensureLocalSkillsForStore() 兜底。 */
  function refreshStoreAux() {
    refreshMe()
      .then(() => {
        if (overlayKind === "tplstore") paintUser();
      })
      .catch(() => {});
    /* 只有 Skill 这一侧才需要本机清单（与改动前的 if (tplIsSkill()) 同口径）；
       模板页不扫，切到 Skill 页时 paintBrowse 的 ensure 会现起一次。 */
    if (tplIsSkill()) ensureLocalSkillsForStore().catch(() => {});
  }
  refreshStoreAux();
  await paint();
}


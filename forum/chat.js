"use strict";
/* MTNode 讨论区 · 单页两级视图（① 列表页 / ② 话题详情页）+ ③ Markdown 编辑器
 *
 * 所有 IPC 都走 plugins/preload-window.js 暴露的 forumApi（contextBridge），
 * 网络请求经主进程 store:request 转发，token 不下发渲染层。
 *
 * 服务端契约：
 *   GET  /api/forum/topics?search=&status=&sort=&page=&pageSize=  → 列表（不含正文，懒加载）
 *   GET  /api/forum/topic?id=<topicId>                            → 正文 + 回复
 *   POST /api/forum/topics        { title, content, status }      → 新建话题
 *   POST /api/forum/replies       { topicId, content, replyToId? } → 回复（二级回复＝平铺引用）
 *   POST /api/forum/topic/status  { id, status }                  → 作者改状态
 *   POST /api/forum/images        { base64, mime }                → 返回 imageId
 *   GET  /api/forum/images/<imageId>                              → 图片（公开可读）
 * 列表项：{ id, title, status, user{id,username,nickname}, createdAt, updatedAt, replyCount }
 * 详情：  { item:{…列表项, body}, replies:[{ id, body, user, createdAt, replyToId, replyTo?{user,excerpt} }] }
 * 状态枚举：general（一般）/ help（求助中）/ idea（建议）/ bug / solved（已解决）
 */
(function () {
  const api = window.forumApi || window.pluginApi;
  const PAGE_SIZE = 20;
  const EMOJIS = [
    "😀", "😄", "😁", "😂", "🤣", "😊", "😍", "🤔", "😅", "😉", "😎", "🙃",
    "🤝", "👍", "👎", "👏", "🙏", "💪", "🎉", "🔥", "✨", "💡", "⚠️", "❌",
    "✅", "❓", "❗", "🚀", "🐛", "📌", "📎", "🔧", "🛠️", "⚙️", "📝", "📖",
    "⏰", "🎯", "💬", "❤️", "🧡", "💔", "😭", "😱", "😴", "🤯", "🥳", "😇",
  ];
  const ALL_STATUS = { id: "all", zh: "全部", en: "All" };
  const STATUSES = [
    { id: "general", zh: "一般", en: "General" },
    { id: "help", zh: "求助中", en: "Help" },
    { id: "suggest", zh: "建议", en: "Suggestion" },
    { id: "bug", zh: "Bug", en: "Bug" },
    { id: "solved", zh: "已解决", en: "Solved" },
  ];
  const SORTS = [
    { id: "new", zh: "最新发布", en: "Newest" },
    { id: "reply", zh: "最新回复", en: "Active" },
  ];

  const $ = (id) => document.getElementById(id);
  const whoEl = $("who");
  const btnOut = $("btnOut");
  const btnClose = $("btnClose");
  const viewList = $("viewList");
  const viewTopic = $("viewTopic");
  const qInput = $("q");
  const sortSel = $("sort");
  const btnNew = $("btnNew");
  const chipsEl = $("chips");
  const hintBar = $("hintBar");
  const hintTxt = $("hintTxt");
  const hintLogin = $("hintLogin");
  const topicList = $("topicList");
  const moreBar = $("moreBar");
  const btnMore = $("btnMore");
  const btnBack = $("btnBack");
  const tTitle = $("tTitle");
  const tBadge = $("tBadge");
  const tTime = $("tTime");
  const statusSel = $("statusSel");
  const topicScroll = $("topicScroll");
  const tBody = $("tBody");
  const replyList = $("replyList");
  const replyToBar = $("replyToBar");
  const replyToTxt = $("replyToTxt");
  const replyToClear = $("replyToClear");
  const replyErr = $("replyErr");
  const btnReply = $("btnReply");
  const authEl = $("auth");
  const authErr = $("authErr");
  const authUser = $("authUser");
  const authPass = $("authPass");
  const authPassNew = $("authPassNew");
  const authPassNew2 = $("authPassNew2");
  const authGo = $("authGo");
  const authCancel = $("authCancel");
  const modeLogin = $("modeLogin");
  const modePass = $("modePass");
  const composeEl = $("compose");
  const cTitleBar = $("cTitleBar");
  const cTitle = $("cTitle");
  const cStatus = $("cStatus");
  const cErr = $("cErr");
  const cCancel = $("cCancel");
  const cPost = $("cPost");
  const lightbox = $("lightbox");
  const lightboxImg = $("lightboxImg");
  const toastEl = $("toast");

  let locale = "zh";
  let auth = null;
  let view = "list";
  let authMode = "login";
  let pendingIntent = null;
  let detail = null; /* { item, replies } */
  let replyTo = null;
  let listBusy = false;
  let listSeq = 0;
  let detailSeq = 0;
  let postBusy = false;
  let toastTimer = null;
  const imgUrl = Object.create(null);
  const imgPending = Object.create(null);
  const state = { items: [], page: 0, hasMore: true, search: "", status: "all", sort: "new" };

  const t = (zh, en) => (locale === "en" ? en : zh);

  /* ---------------- 基础工具 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function statusMeta(id) {
    return STATUSES.find((s) => s.id === id) || STATUSES[0];
  }
  function statusLabel(id) {
    const s = STATUSES.find((x) => x.id === id);
    return s ? t(s.zh, s.en) : t("一般", "General");
  }
  function displayName(u) {
    if (!u) return t("匿名", "Anonymous");
    const nick = String(u.nickname || "").trim();
    const user = String(u.username || "").trim();
    if (nick && user && nick !== user) return nick + " · " + user;
    return nick || user || t("匿名", "Anonymous");
  }
  function formatTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return "";
    const diff = Date.now() - n;
    if (diff >= 0 && diff < 60000) return t("刚刚", "just now");
    if (diff >= 0 && diff < 3600000) return t(Math.floor(diff / 60000) + " 分钟前", Math.floor(diff / 60000) + "m ago");
    if (diff >= 0 && diff < 86400000) return t(Math.floor(diff / 3600000) + " 小时前", Math.floor(diff / 3600000) + "h ago");
    const pad = (x) => String(x).padStart(2, "0");
    const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    const now = new Date();
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
    if (d.getFullYear() === now.getFullYear()) return d.getMonth() + 1 + "/" + d.getDate() + " " + hm;
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }
  function toast(msg, bad) {
    toastEl.textContent = String(msg || "");
    toastEl.classList.toggle("bad", !!bad);
    toastEl.hidden = !msg;
    clearTimeout(toastTimer);
    if (msg) toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }
  function apiErr(r) {
    if (!r) return t("网络请求失败", "Network request failed");
    if (r.data && r.data.error) return r.data.error;
    if (r.error) return r.error;
    return "HTTP " + (r.status || "");
  }
  function myId() {
    return (auth && (auth.userId || auth.id)) || "";
  }
  function signedIn() {
    return !!auth;
  }
  // 服务端把作者放在 author:{id,username,nickname}，界面统一读 u.user；此处归一，
  // 否则 displayName(undefined) 会兜底成「匿名」。
  function normalizeUser(o) {
    if (!o || typeof o !== "object") return null;
    const raw = o.user || o.author || null;
    if (!raw || typeof raw !== "object") return null;
    return {
      id: raw.id || raw.userId || o.userId || "",
      username: raw.username || "",
      nickname: raw.nickname || "",
    };
  }
  function withUser(o) {
    if (!o || typeof o !== "object") return o;
    if (!o.user || !(o.user.id || o.user.userId)) o.user = normalizeUser(o);
    return o;
  }
  function pickItems(data) {
    if (!data) return [];
    const arr = Array.isArray(data.items) ? data.items : Array.isArray(data.topics) ? data.topics : Array.isArray(data.list) ? data.list : [];
    return arr.map(withUser);
  }
  function pickItem(data) {
    if (!data) return null;
    if (data.item && typeof data.item === "object") return withUser(data.item);
    if (data.topic && typeof data.topic === "object") return withUser(data.topic);
    return null;
  }
  function pickReplies(data) {
    if (!data) return [];
    if (Array.isArray(data.replies)) return data.replies.map(withUser);
    if (data.replies && Array.isArray(data.replies.items)) return data.replies.items.map(withUser);
    const it = pickItem(data);
    return it && Array.isArray(it.replies) ? it.replies.map(withUser) : [];
  }
  function replyCountOf(it) {
    if (!it) return 0;
    if (Number.isFinite(Number(it.replyCount))) return Number(it.replyCount);
    if (Array.isArray(it.replies)) return it.replies.length;
    return 0;
  }
  function excerptOf(s, n) {
    const x = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return x.length > (n || 80) ? x.slice(0, n || 80) + "…" : x;
  }

  /* ---------------- 统一账户（auth-store，token 只留主进程） ---------------- */
  async function refreshAuth() {
    const st = await api.authGetState();
    const u = (st && st.user) || null;
    auth = u
      ? { userId: u.id || u.userId || "", username: u.username || "", nickname: u.nickname || "" }
      : null;
    paintAccount();
    return auth;
  }
  function paintAccount() {
    const on = signedIn();
    whoEl.textContent = on ? " · " + displayName(auth) : "";
    btnOut.hidden = !on;
    hintBar.hidden = on || view !== "list";
  }
  async function signOut() {
    try { await api.authLogout(); } catch (_) {}
    auth = null;
    paintAccount();
    renderDetailHeader();
  }
  function openLogin() {
    authErr.textContent = "";
    authEl.classList.add("open");
    setAuthMode("login");
    setTimeout(() => authUser.focus(), 30);
  }
  function closeLogin() {
    authEl.classList.remove("open");
    pendingIntent = null;
    authPass.value = "";
    authPassNew.value = "";
    authPassNew2.value = "";
  }
  function needLogin(fn) {
    if (signedIn()) {
      if (fn) fn();
      return true;
    }
    pendingIntent = fn || null;
    openLogin();
    return false;
  }
  function setAuthMode(mode) {
    authMode = mode === "passwd" ? "passwd" : "login";
    modeLogin.classList.toggle("on", authMode === "login");
    modePass.classList.toggle("on", authMode === "passwd");
    authPassNew.hidden = authMode !== "passwd";
    authPassNew2.hidden = authMode !== "passwd";
    authPass.placeholder = authMode === "passwd"
      ? t("旧密码", "Current password")
      : t("密码（6-72 位）", "Password (6-72 characters)");
    authGo.textContent = authMode === "passwd" ? t("修改密码", "Change password") : t("登录", "Sign in");
    $("authTitle").textContent = authMode === "passwd" ? t("修改密码", "Change password") : t("登录后即可发帖", "Sign in to post");
  }
  async function doAuth() {
    authErr.textContent = "";
    authGo.disabled = true;
    try {
      if (authMode === "passwd") {
        const oldPassword = authPass.value;
        const newPassword = authPassNew.value;
        if (newPassword !== authPassNew2.value) {
          authErr.textContent = t("两次输入的新密码不一致", "New passwords do not match");
          return;
        }
        if (oldPassword === newPassword) {
          authErr.textContent = t("新密码不能与旧密码相同", "New password must differ from the current one");
          return;
        }
        const r = await api.authChangePassword({ username: authUser.value.trim(), oldPassword, newPassword });
        if (!r || !r.ok) {
          authErr.textContent = (r && r.error) || apiErr(r);
          return;
        }
      } else {
        const r = await api.authLoginPassword({ username: authUser.value.trim(), password: authPass.value });
        if (!r || !r.ok) {
          authErr.textContent = (r && r.error) || apiErr(r);
          return;
        }
      }
      authPass.value = "";
      authPassNew.value = "";
      authPassNew2.value = "";
      closeLogin();
      await refreshAuth();
      const go = pendingIntent;
      pendingIntent = null;
      renderDetailHeader();
      if (go) go();
    } finally {
      authGo.disabled = false;
    }
  }

  /* ---------------- 图片：ensureImage（带鉴权） / 上传 ---------------- */
  async function ensureImage(id) {
    if (!id) return "";
    if (imgUrl[id]) return imgUrl[id];
    if (imgPending[id]) return imgPending[id];
    imgPending[id] = (async () => {
      try {
        const c = await api.readCachedImage(id);
        if (c && c.ok && c.dataUrl) {
          imgUrl[id] = c.dataUrl;
          return c.dataUrl;
        }
      } catch (_) {}
      try {
        const r = await api.storeRequest({ method: "GET", path: "/api/forum/images/" + encodeURIComponent(id) });
        if (r && r.ok && r.base64) {
          const url = "data:" + (r.contentType || "image/jpeg") + ";base64," + r.base64;
          imgUrl[id] = url;
          try { await api.cacheImage(id, r.base64); } catch (_) {}
          return url;
        }
      } catch (_) {}
      return "";
    })();
    const out = await imgPending[id];
    delete imgPending[id];
    return out;
  }
  async function uploadImage(base64, mime) {
    const r = await api.storeRequest({
      method: "POST",
      path: "/api/forum/images",
      json: { base64, mime: mime || "image/jpeg" },
    });
    if (r && r.status === 401) {
      await signOut();
      toast(t("登录已失效，请重新登录", "Session expired, please sign in again"), true);
      return "";
    }
    if (!r || !r.ok) {
      toast(apiErr(r) || t("图片上传失败", "Image upload failed"), true);
      return "";
    }
    const d = r.data || {};
    const id = String(d.imageId || d.id || (d.item && d.item.imageId) || "");
    if (!id) {
      toast(t("图片上传失败", "Image upload failed"), true);
      return "";
    }
    if (base64) {
      const url = "data:" + (mime || "image/jpeg") + ";base64," + base64;
      imgUrl[id] = url;
      try { await api.cacheImage(id, base64); } catch (_) {}
    }
    return id;
  }

  /* ---------------- Markdown 渲染（先转义 → marked → 白名单清洗 → innerHTML） ---------------- */
  function sanitizeHtml(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html || "");
    tpl.content.querySelectorAll("script,style,iframe,object,embed,link,meta,base,form,svg,math").forEach((n) => n.remove());
    tpl.content.querySelectorAll("*").forEach((el) => {
      for (const a of [...el.attributes]) {
        const name = a.name.toLowerCase();
        if (name.startsWith("on")) {
          el.removeAttribute(a.name);
          continue;
        }
        if ((name === "href" || name === "src") && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value)) {
          el.removeAttribute(a.name);
        }
      }
      if (el.tagName === "A") {
        el.setAttribute("rel", "noreferrer noopener");
        el.setAttribute("target", "_blank");
      }
    });
    return tpl.innerHTML;
  }
  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.hidden = false;
  }
  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.removeAttribute("src");
  }
  function wireImages(host) {
    host.querySelectorAll("img").forEach((im) => {
      const src = String(im.getAttribute("src") || "");
      const m = /^forum:([A-Za-z0-9_-]+)$/.exec(src);
      if (!m) {
        im.removeAttribute("src");
        im.alt = t("图片外链已禁用", "External image blocked");
        return;
      }
      im.addEventListener("click", () => {
        if (im.src) openLightbox(im.src);
      });
      ensureImage(m[1]).then((url) => {
        if (url) im.src = url;
        else {
          im.removeAttribute("src");
          im.alt = t("图片加载失败", "Image failed to load");
        }
      });
    });
  }
  function renderMarkdownInto(host, src) {
    const raw = String(src == null ? "" : src);
    /* ① 先转义再 parse：`<` 是这条链路上唯一能开出标签的字符，一律转成实体，
       用户内容永远进不了标签位置；`&` 交给 marked 自己转义（预转义会被二次转义成
       &amp;amp;，代码块里就能看出来），所以引用块 / 表格 / 代码等语法都不受影响。 */
    const safe = raw.replace(/</g, "&lt;");
    let html = "";
    try {
      if (window.marked && window.marked.parse) html = window.marked.parse(safe, { gfm: true, breaks: true });
    } catch (_) {}
    if (!html) html = "<p>" + esc(raw) + "</p>";
    /* ② 白名单清洗后一次性写入，绝不用 innerHTML 直插用户原文 */
    host.innerHTML = sanitizeHtml(html);
    wireImages(host);
  }

  /* ---------------- ③ Markdown 编辑器 ---------------- */
  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function createMdEditor(host) {
    host.innerHTML = [
      '<div class="mdtools"></div>',
      '<div class="mdpanes">',
      '  <textarea class="mdsrc" spellcheck="false"></textarea>',
      '  <div class="mdprev md" hidden></div>',
      "</div>",
      '<div class="mdemoji" hidden></div>',
      '<div class="mdfoot"><span class="mdmsg"></span><button type="button" class="mdtoggle"></button></div>',
    ].join("");
    const tools = host.querySelector(".mdtools");
    const ta = host.querySelector(".mdsrc");
    const prev = host.querySelector(".mdprev");
    const emojiBox = host.querySelector(".mdemoji");
    const msgEl = host.querySelector(".mdmsg");
    const toggle = host.querySelector(".mdtoggle");
    let previewOn = false;

    function setMsg(text, bad) {
      msgEl.textContent = text || "";
      msgEl.classList.toggle("bad", !!bad);
    }
    function focusTa() {
      ta.focus();
    }
    function replaceRange(s, e, text) {
      const v = ta.value;
      ta.value = v.slice(0, s) + text + v.slice(e);
      const pos = s + text.length;
      focusTa();
      ta.setSelectionRange(pos, pos);
    }
    function wrap(before, after, ph) {
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      const inner = ta.value.slice(s, e) || ph || "";
      replaceRange(s, e, before + inner + after);
      if (!ta.value.slice(s, e)) {
        ta.setSelectionRange(s + before.length, s + before.length + inner.length);
      }
    }
    function linePrefix(pre) {
      const v = ta.value;
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      const ls = v.lastIndexOf("\n", Math.max(0, s - 1)) + 1;
      let le = v.indexOf("\n", e);
      if (le < 0) le = v.length;
      const lines = v.slice(ls, le).split("\n");
      const all = lines.every((l) => l.startsWith(pre));
      const out = lines.map((l) => (all ? l.slice(pre.length) : pre + l)).join("\n");
      ta.value = v.slice(0, ls) + out + v.slice(le);
      focusTa();
      ta.setSelectionRange(ls, ls + out.length);
    }
    function insert(text) {
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      replaceRange(s, e, text);
    }
    async function pickAndInsertImage() {
      if (!signedIn()) {
        pendingIntent = () => pickAndInsertImage();
        openLogin();
        return;
      }
      const r = await api.pickImage();
      if (!r || !r.ok) {
        if (r && r.error && r.error !== "cancelled") setMsg(r.error, true);
        return;
      }
      setMsg(t("图片上传中…", "Uploading image…"), false);
      const id = await uploadImage(r.base64, r.mime || "image/jpeg");
      if (!id) {
        setMsg(t("图片上传失败", "Image upload failed"), true);
        return;
      }
      insert("![](forum:" + id + ")");
      setMsg(t("图片已插入", "Image inserted"), false);
    }
    function showPreview() {
      renderMarkdownInto(prev, ta.value);
      prev.hidden = false;
      ta.hidden = true;
      previewOn = true;
      toggle.textContent = t("源码", "Source");
    }
    function showSource(focus) {
      prev.hidden = true;
      ta.hidden = false;
      previewOn = false;
      toggle.textContent = t("预览", "Preview");
      if (focus !== false) focusTa();
    }

    const T = [
      { label: "H", zh: "标题", en: "Heading", run: () => linePrefix("## ") },
      { label: "B", zh: "粗体", en: "Bold", run: () => wrap("**", "**", t("粗体", "bold")) },
      { label: "I", zh: "斜体", en: "Italic", run: () => wrap("*", "*", t("斜体", "italic")) },
      { label: "S", zh: "删除线", en: "Strikethrough", run: () => wrap("~~", "~~", t("删除线", "strike")) },
      { sep: true },
      { label: "❝", zh: "引用", en: "Quote", run: () => linePrefix("> ") },
      { label: "1.", zh: "有序列表", en: "Ordered list", run: () => linePrefix("1. ") },
      { label: "•", zh: "无序列表", en: "Bullet list", run: () => linePrefix("- ") },
      { label: "☑", zh: "待办", en: "Task", run: () => linePrefix("- [ ] ") },
      { sep: true },
      { label: "🔗", zh: "链接", en: "Link", run: () => wrap("[", "](https://)", t("链接文字", "link text")) },
      { label: "</>", zh: "行内代码", en: "Inline code", run: () => wrap("`", "`", "code") },
      { label: "{ }", zh: "代码块", en: "Code block", run: () => wrap("```\n", "\n```", t("代码", "code")) },
      { label: "🖼", zh: "图片", en: "Image", run: () => pickAndInsertImage() },
      { label: "▦", zh: "表格", en: "Table", run: () => insert("\n| " + t("列1", "Col 1") + " | " + t("列2", "Col 2") + " |\n| --- | --- |\n|  |  |\n") },
      { label: "―", zh: "水平线", en: "Horizontal rule", run: () => insert("\n---\n") },
      { label: "☺", zh: "表情", en: "Emoji", run: () => { emojiBox.hidden = !emojiBox.hidden; } },
    ];
    T.forEach((item) => {
      if (item.sep) {
        const sp = document.createElement("span");
        sp.className = "sep";
        tools.appendChild(sp);
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = item.label;
      b.title = t(item.zh, item.en);
      b.onclick = () => {
        if (previewOn && item.label !== "☺") showSource();
        item.run();
      };
      tools.appendChild(b);
    });
    EMOJIS.forEach((em) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = em;
      b.onclick = () => {
        if (previewOn) showSource();
        insert(em);
      };
      emojiBox.appendChild(b);
    });
    toggle.textContent = t("预览", "Preview");
    toggle.onclick = () => (previewOn ? showSource() : showPreview());

    ta.addEventListener("paste", async (ev) => {
      const items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && String(it.type || "").startsWith("image/")) {
          ev.preventDefault();
          if (!signedIn()) {
            pendingIntent = () => pickAndInsertImage();
            openLogin();
            return;
          }
          const f = it.getAsFile();
          if (!f) return;
          const buf = await f.arrayBuffer();
          const c = await api.compressImage({ base64: bytesToBase64(new Uint8Array(buf)), name: f.name || "paste.jpg" });
          if (!c || !c.ok) {
            setMsg((c && c.error) || t("无法读取图片", "Could not read image"), true);
            return;
          }
          setMsg(t("图片上传中…", "Uploading image…"), false);
          const id = await uploadImage(c.base64, c.mime || "image/jpeg");
          if (id) {
            insert("![](forum:" + id + ")");
            setMsg(t("图片已插入", "Image inserted"), false);
          }
          return;
        }
      }
    });

    return {
      value: () => ta.value,
      setValue: (v) => { ta.value = String(v || ""); },
      clear: () => { ta.value = ""; setMsg(""); if (previewOn) showSource(false); },
      focus: () => focusTa(),
      setMsg,
      el: host,
    };
  }

  /* ---------------- ① 列表页 ---------------- */
  function paintChips() {
    chipsEl.innerHTML = "";
    [ALL_STATUS].concat(STATUSES).forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (state.status === s.id ? " on" : "");
      b.textContent = t(s.zh, s.en);
      b.onclick = () => {
        if (state.status === s.id) return;
        state.status = s.id;
        paintChips();
        loadTopics(true);
      };
      chipsEl.appendChild(b);
    });
  }
  function paintSort() {
    sortSel.innerHTML = "";
    SORTS.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = t(s.zh, s.en);
      sortSel.appendChild(o);
    });
    sortSel.value = state.sort;
  }
  function paintStatusOptions(sel, withAll) {
    sel.innerHTML = "";
    (withAll ? [ALL_STATUS].concat(STATUSES) : STATUSES).forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = t(s.zh, s.en);
      sel.appendChild(o);
    });
  }
  function topicRow(it) {
    const row = document.createElement("div");
    row.className = "topic";
    const main = document.createElement("div");
    main.className = "t-main";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.dataset.s = statusMeta(it.status).id;
    badge.textContent = statusLabel(it.status);
    const title = document.createElement("span");
    title.className = "t-title";
    title.textContent = String(it.title || t("（无标题）", "(untitled)"));
    main.appendChild(badge);
    main.appendChild(title);
    const sub = document.createElement("span");
    sub.className = "t-sub";
    const n = replyCountOf(it);
    sub.innerHTML =
      esc(displayName(it.user)) + " · " + esc(formatTime(it.updatedAt || it.createdAt)) +
      ' · <b>' + n + "</b> " + t("回复", "replies");
    row.appendChild(main);
    row.appendChild(sub);
    row.onclick = () => openTopic(it.id);
    return row;
  }
  function renderList(reset) {
    if (reset) topicList.innerHTML = "";
    if (!state.items.length) {
      if (!listBusy) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = state.search || state.status !== "all"
          ? t("没有匹配的话题。", "No matching topics.")
          : t("还没有话题，点右上角「发起话题」开第一帖吧。", "No topics yet. Start one from “New topic”.");
        topicList.appendChild(empty);
      } else {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("加载中…", "Loading…");
        topicList.appendChild(empty);
      }
      return;
    }
    if (reset) state.items.forEach((it) => topicList.appendChild(topicRow(it)));
    moreBar.hidden = !state.hasMore;
  }
  async function loadTopics(reset) {
    if (!reset && (listBusy || !state.hasMore)) return;
    const seq = ++listSeq;
    listBusy = true;
    btnMore.disabled = true;
    if (reset) {
      state.page = 0;
      state.hasMore = true;
      state.items = [];
      moreBar.hidden = true;
      topicList.innerHTML = '<div class="empty">' + esc(t("加载中…", "Loading…")) + "</div>";
    }
    const page = state.page + 1;
    const r = await api.storeRequest({
      method: "GET",
      path:
        "/api/forum/topics?search=" + encodeURIComponent(state.search) +
        /* 「全部」= 不筛状态：服务端只认五个状态枚举，发 all 会被判 400「未知状态」 */
        (state.status && state.status !== "all"
          ? "&status=" + encodeURIComponent(state.status)
          : "") +
        "&sort=" + encodeURIComponent(state.sort) +
        "&page=" + page +
        "&pageSize=" + PAGE_SIZE,
    });
    if (seq !== listSeq) return; /* 已被更新的一次列表请求取代，丢弃过期响应 */
    listBusy = false;
    btnMore.disabled = false;
    if (!r || !r.ok) {
      if (r && r.status === 401) {
        await signOut();
        toast(t("登录已失效，请重新登录", "Session expired, please sign in again"), true);
      }
      if (reset) {
        topicList.innerHTML = '<div class="empty">' + esc(apiErr(r)) + "</div>";
      } else {
        toast(apiErr(r), true);
      }
      return;
    }
    const items = pickItems(r.data);
    state.items = state.items.concat(items);
    state.page = page;
    const explicit = r.data && (r.data.hasMore === true || r.data.more === true);
    const explicitNo = r.data && (r.data.hasMore === false || r.data.more === false);
    state.hasMore = explicitNo ? false : (explicit || items.length >= PAGE_SIZE);
    if (reset) renderList(true);
    else items.forEach((it) => topicList.appendChild(topicRow(it)));
    moreBar.hidden = !state.hasMore;
  }

  /* ---------------- ② 详情页 ---------------- */
  function showView(name) {
    view = name;
    viewList.hidden = name !== "list";
    viewTopic.hidden = name !== "topic";
    hintBar.hidden = signedIn() || name !== "list";
  }
  function renderDetailHeader() {
    if (!detail || !detail.item) return;
    const it = detail.item;
    tTitle.textContent = String(it.title || t("（无标题）", "(untitled)"));
    tBadge.dataset.s = statusMeta(it.status).id;
    tBadge.textContent = statusLabel(it.status);
    tTime.textContent = formatTime(it.updatedAt || it.createdAt);
    const author = !!(signedIn() && myId() && it.user && it.user.id === myId());
    if (author) {
      paintStatusOptions(statusSel, false);
      statusSel.value = statusMeta(it.status).id;
      statusSel.hidden = false;
      statusSel.title = t("切换状态（仅作者可见）", "Change status (author only)");
    } else {
      statusSel.hidden = true;
    }
  }
  function renderReplies() {
    replyList.innerHTML = "";
    const list = (detail && detail.replies) || [];
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = t("还没有回复。", "No replies yet.");
      replyList.appendChild(empty);
      return;
    }
    const byId = new Map(list.map((x) => [x.id, x]));
    list.forEach((rp) => {
      const box = document.createElement("div");
      box.className = "reply";
      const head = document.createElement("div");
      head.className = "rhead";
      const nm = document.createElement("b");
      nm.textContent = displayName(rp.user);
      const tm = document.createElement("span");
      tm.textContent = formatTime(rp.createdAt);
      const sp = document.createElement("span");
      sp.className = "sp";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "linkbtn";
      btn.textContent = t("回复", "Reply");
      btn.onclick = () => setReplyTo(rp);
      head.appendChild(nm);
      head.appendChild(tm);
      head.appendChild(sp);
      head.appendChild(btn);
      box.appendChild(head);
      /* 二级回复：平铺引用（不做树） */
      const target = rp.replyTo && typeof rp.replyTo === "object"
        ? rp.replyTo
        : (rp.replyToId && byId.get(rp.replyToId)) || null;
      if (target) {
        const quote = document.createElement("div");
        quote.className = "rquote";
        const who = displayName(target.user);
        const ex = target.excerpt != null ? target.excerpt : excerptOf(target.content || target.body, 80);
        quote.textContent = t("回复 ", "Replying to ") + who + (ex ? "：" + ex : "");
        box.appendChild(quote);
      }
      const body = document.createElement("div");
      body.className = "rbody md";
      box.appendChild(body);
      replyList.appendChild(box);
      renderMarkdownInto(body, rp.content || rp.body || "");
    });
  }
  function setReplyTo(rp) {
    replyTo = rp || null;
    if (!replyTo) {
      replyToBar.hidden = true;
      replyToTxt.textContent = "";
      return;
    }
    replyToBar.hidden = false;
    replyToTxt.textContent = t("回复 ", "Replying to ") + displayName(replyTo.user) + "：" + excerptOf(replyTo.body, 60);
    if (!signedIn()) {
      pendingIntent = () => {
        setReplyTo(rp);
        replyEditor.focus();
      };
      openLogin();
      return;
    }
    replyEditor.focus();
  }
  async function openTopic(id) {
    if (!id) return;
    const seq = ++detailSeq;
    showView("topic");
    detail = null;
    replyTo = null;
    replyToBar.hidden = true;
    replyErr.textContent = "";
    replyEditor.clear();
    tTitle.textContent = t("加载中…", "Loading…");
    tBadge.textContent = "";
    tBadge.dataset.s = "general";
    tTime.textContent = "";
    statusSel.hidden = true;
    tBody.innerHTML = '<div class="empty">' + esc(t("加载中…", "Loading…")) + "</div>";
    replyList.innerHTML = "";
    topicScroll.scrollTop = 0;
    const r = await api.storeRequest({ method: "GET", path: "/api/forum/topic?id=" + encodeURIComponent(id) });
    if (seq !== detailSeq) return; /* 用户已切到别的话题 */
    if (!r || !r.ok) {
      tBody.innerHTML = '<div class="empty">' + esc(apiErr(r)) + "</div>";
      tTitle.textContent = t("加载失败", "Failed to load");
      return;
    }
    const item = pickItem(r.data);
    if (!item) {
      tBody.innerHTML = '<div class="empty">' + esc(t("话题不存在或已删除", "Topic not found")) + "</div>";
      return;
    }
    detail = { item, replies: pickReplies(r.data) };
    renderDetailHeader();
    renderMarkdownInto(tBody, item.body || item.content || "");
    renderReplies();
  }
  async function changeStatus(next) {
    if (!detail || !detail.item) return;
    const id = detail.item.id;
    statusSel.disabled = true;
    const r = await api.storeRequest({
      method: "POST",
      path: "/api/forum/topic/status",
      json: { id, status: next },
    });
    statusSel.disabled = false;
    if (r && r.status === 401) {
      await signOut();
      toast(t("登录已失效，请重新登录", "Session expired, please sign in again"), true);
      return;
    }
    if (!r || !r.ok) {
      statusSel.value = statusMeta(detail.item.status).id;
      toast(apiErr(r), true);
      return;
    }
    detail.item.status = next;
    const updated = pickItem(r.data);
    if (updated && updated.status) detail.item.status = updated.status;
    renderDetailHeader();
    const row = state.items.find((x) => x.id === id);
    if (row) {
      row.status = detail.item.status;
      renderList(true);
    }
    toast(t("状态已更新", "Status updated"), false);
  }
  async function submitReply() {
    if (!detail || !detail.item || postBusy) return;
    const body = String(replyEditor.value() || "").trim();
    if (!body) {
      replyErr.textContent = t("回复内容不能为空", "Reply cannot be empty");
      return;
    }
    if (!signedIn()) {
      pendingIntent = () => submitReply();
      openLogin();
      return;
    }
    postBusy = true;
    btnReply.disabled = true;
    replyErr.textContent = "";
    const r = await api.storeRequest({
      method: "POST",
      path: "/api/forum/replies",
      json: { topicId: detail.item.id, content: body, replyToId: replyTo ? replyTo.id : "" },
    });
    postBusy = false;
    btnReply.disabled = false;
    if (r && r.status === 401) {
      await signOut();
      replyErr.textContent = t("登录已失效，请重新登录", "Session expired, please sign in again");
      return;
    }
    if (!r || !r.ok) {
      replyErr.textContent = apiErr(r);
      return;
    }
    const item = withUser(pickItem(r.data) || (r.data && r.data.reply) || null);
    replyEditor.clear();
    setReplyTo(null);
    if (item && item.id) {
      detail.replies.push(item);
      renderReplies();
    } else {
      /* 服务端未回传新回复对象：重新拉一次详情保证显示一致 */
      const keep = detail.item;
      await openTopic(keep.id);
      return;
    }
    const row = state.items.find((x) => x.id === detail.item.id);
    if (row) row.replyCount = (Number(row.replyCount) || 0) + 1;
    topicScroll.scrollTop = topicScroll.scrollHeight;
  }

  /* ---------------- 发起话题 ---------------- */
  function openCompose() {
    cErr.textContent = "";
    cTitle.value = "";
    paintStatusOptions(cStatus, false);
    cStatus.value = "general";
    composeEditor.clear();
    composeEl.hidden = false;
    setTimeout(() => cTitle.focus(), 30);
  }
  function closeCompose() {
    composeEl.hidden = true;
    composeEditor.clear();
    cErr.textContent = "";
  }
  async function postTopic() {
    if (postBusy) return;
    const title = String(cTitle.value || "").trim();
    const body = String(composeEditor.value() || "").trim();
    if (title.length < 2) {
      cErr.textContent = t("标题至少 2 个字", "Title needs at least 2 characters");
      return;
    }
    if (!body) {
      cErr.textContent = t("正文不能为空", "Body cannot be empty");
      return;
    }
    postBusy = true;
    cPost.disabled = true;
    cErr.textContent = "";
    const r = await api.storeRequest({
      method: "POST",
      path: "/api/forum/topics",
      json: { title, content: body, status: cStatus.value || "general" },
    });
    postBusy = false;
    cPost.disabled = false;
    if (r && r.status === 401) {
      await signOut();
      closeCompose();
      openLogin();
      return;
    }
    if (!r || !r.ok) {
      cErr.textContent = apiErr(r);
      return;
    }
    closeCompose();
    showView("list");
    state.status = "all";
    state.search = "";
    qInput.value = "";
    paintChips();
    await loadTopics(true);
    const created = pickItem(r.data);
    if (created && created.id) openTopic(created.id);
    else toast(t("发布成功", "Posted"), false);
  }

  /* ---------------- 本地化 & 启动 ---------------- */
  function applyLocale() {
    document.title = t("MTNode 讨论区", "MTNode Forum");
    qInput.placeholder = t("搜索标题…", "Search titles…");
    sortSel.title = t("排序", "Sort");
    btnNew.textContent = t("发起话题", "New topic");
    btnMore.textContent = t("加载更多", "Load more");
    hintTxt.textContent = t("登录后可发帖", "Sign in to post");
    hintLogin.textContent = t("登录", "Sign in");
    btnBack.textContent = "← " + t("返回", "Back");
    btnReply.textContent = t("回复", "Reply");
    btnOut.title = t("退出登录", "Sign out");
    btnClose.title = t("关闭", "Close");
    replyToClear.textContent = t("取消", "Cancel");
    cTitleBar.textContent = t("发起话题", "New topic");
    cTitle.placeholder = t("标题（2-120 字）", "Title (2-120 chars)");
    cCancel.textContent = t("取消", "Cancel");
    cPost.textContent = t("发布", "Post");
    $("authHint").textContent = t(
      "与创意工坊共用同一账户；登录态与 token 由主进程保管，浏览器层不接触 token。",
      "Same account as Creative Workshop. Auth/token are held by the main process; the renderer never sees the token.",
    );
    authUser.placeholder = t("用户名（3-24 位字母、数字或下划线）", "Username (3-24 letters, digits, or _)");
    authPass.placeholder = t("密码（6-72 位）", "Password (6-72 characters)");
    authPassNew.placeholder = t("新密码（6-72 位）", "New password (6-72 characters)");
    authPassNew2.placeholder = t("再次输入新密码", "Confirm new password");
    authCancel.textContent = t("继续浏览", "Browse anyway");
    modeLogin.textContent = t("登录", "Sign in");
    modePass.textContent = t("修改密码", "Change password");
    paintSort();
    paintChips();
    setAuthMode(authMode);
    paintAccount();
  }

  const replyEditor = createMdEditor($("replyHost"));
  const composeEditor = createMdEditor($("composeHost"));

  btnClose.onclick = () => api.close();
  btnOut.onclick = () => signOut();
  btnBack.onclick = () => {
    showView("list");
    window.setTimeout(() => { topicScroll.scrollTop = 0; }, 0);
  };
  btnNew.onclick = () => needLogin(() => openCompose());
  hintLogin.onclick = () => openLogin();
  btnMore.onclick = () => loadTopics(false);
  cCancel.onclick = closeCompose;
  cPost.onclick = postTopic;
  authGo.onclick = doAuth;
  authCancel.onclick = closeLogin;
  modeLogin.onclick = () => setAuthMode("login");
  modePass.onclick = () => setAuthMode("passwd");
  btnReply.onclick = () => needLogin(() => submitReply());
  replyToClear.onclick = () => setReplyTo(null);
  lightbox.onclick = closeLightbox;
  statusSel.onchange = () => {
    const next = statusSel.value;
    if (!signedIn()) {
      statusSel.value = statusMeta(detail && detail.item ? detail.item.status : "general").id;
      needLogin(() => changeStatus(next));
      return;
    }
    changeStatus(next);
  };
  sortSel.onchange = () => {
    state.sort = sortSel.value;
    loadTopics(true);
  };
  let searchTimer = null;
  qInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = qInput.value.trim();
      loadTopics(true);
    }, 320);
  });
  qInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      clearTimeout(searchTimer);
      state.search = qInput.value.trim();
      loadTopics(true);
    }
  });
  topicList.addEventListener("scroll", () => {
    if (!state.hasMore || listBusy) return;
    if (topicList.scrollHeight - topicList.scrollTop - topicList.clientHeight < 120) loadTopics(false);
  });
  [authPass, authPassNew, authPassNew2].forEach((el) => {
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") doAuth();
    });
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!lightbox.hidden) return closeLightbox();
    if (!composeEl.hidden) return closeCompose();
    if (authEl.classList.contains("open")) return closeLogin();
  });
  /* 内容区里的链接：一律走系统浏览器打开，不在窗口内导航 */
  document.addEventListener("click", (ev) => {
    const node = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (!node) return;
    const href = String(node.getAttribute("href") || "");
    ev.preventDefault();
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) api.openExternal(href).catch(() => {});
  });

  async function boot() {
    const st = await api.getAuth();
    locale = st && st.locale === "en" ? "en" : "zh";
    applyLocale();
    await refreshAuth();
    showView("list");
    await loadTopics(true);
    if (api && typeof api.onAuthChanged === "function") {
      api.onAuthChanged(async () => {
        await refreshAuth();
        renderDetailHeader();
      });
    }
    if (api && typeof api.onShown === "function") {
      api.onShown(() => {
        if (view === "list") qInput.focus();
      });
    }
  }

  boot().catch((e) => {
    topicList.innerHTML = '<div class="empty">' + esc(String((e && e.message) || e)) + "</div>";
  });
})();

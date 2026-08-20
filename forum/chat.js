"use strict";
(function () {
  const api = window.forumApi || window.pluginApi;
  const ROOMS = [
    { id: "general", zh: "综合区", en: "General" },
    { id: "bug", zh: "Bug提交区", en: "Bugs" },
    { id: "improve", zh: "功能改进区", en: "Ideas" },
  ];
  const list = document.getElementById("list");
  const input = document.getElementById("input");
  const btnSend = document.getElementById("btnSend");
  const btnClose = document.getElementById("btnClose");
  const btnOut = document.getElementById("btnOut");
  const btnImg = document.getElementById("btnImg");
  const tabsEl = document.getElementById("tabs");
  const whoEl = document.getElementById("who");
  const authEl = document.getElementById("auth");
  const foot = document.getElementById("foot");
  const pending = document.getElementById("pending");
  const pendingImg = document.getElementById("pendingImg");
  const pendingClear = document.getElementById("pendingClear");
  const zoom = document.getElementById("zoom");
  const zoomImg = document.getElementById("zoomImg");
  const authErr = document.getElementById("authErr");
  const authUser = document.getElementById("authUser");
  const authPass = document.getElementById("authPass");
  const authPassNew = document.getElementById("authPassNew");
  const authPassNew2 = document.getElementById("authPassNew2");
  const authNick = document.getElementById("authNick");
  const authGo = document.getElementById("authGo");
  const modeLogin = document.getElementById("modeLogin");
  const modeReg = document.getElementById("modeReg");
  const modePass = document.getElementById("modePass");
  const findbar = document.getElementById("findbar");
  const findInput = document.getElementById("findInput");
  const findCount = document.getElementById("findCount");
  const findPrev = document.getElementById("findPrev");
  const findNext = document.getElementById("findNext");
  const findClose = document.getElementById("findClose");
  const MSG_CAP = 500;

  let locale = "zh";
  let auth = null;
  let room = "general";
  let authMode = "login";
  let pendingImage = null;
  let busy = false;
  let pollTimer = null;
  const store = {
    rooms: { general: [], bug: [], improve: [] },
    lastRead: { general: 0, bug: 0, improve: 0 },
  };
  const dayLists = { general: [], bug: [], improve: [] };
  const expandedDays = { general: Object.create(null), bug: Object.create(null), improve: Object.create(null) };
  const dayLoading = Object.create(null);
  const imgUrl = Object.create(null);

  function hotFromTs() {
    const d = new Date();
    d.setHours(5, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  function dayKeyOf(ts) {
    const d = new Date(Number(ts) || 0);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function formatDayLabel(dayKey) {
    const parts = String(dayKey || "").split("-").map(Number);
    if (parts.length < 3 || !parts[0]) return dayKey;
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    if (locale === "en") {
      return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    }
    return parts[0] + "年" + parts[1] + "月" + parts[2] + "日";
  }
  function dayRangeLocal(dayKey) {
    const parts = String(dayKey || "").split("-").map(Number);
    const from = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime();
    const end = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999).getTime();
    return { from, to: Math.min(end, hotFromTs() - 1) };
  }
  function keepHotOnly(items) {
    const hot = hotFromTs();
    return (items || []).filter((m) => (Number(m && m.createdAt) || 0) >= hot);
  }

  function t(zh, en) {
    return locale === "en" ? en : zh;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function displayName(u) {
    if (!u) return t("匿名", "Anonymous");
    const nick = String(u.nickname || "").trim();
    const user = String(u.username || "").trim();
    if (nick && user && nick !== user) return nick + " · " + user;
    return nick || user || t("匿名", "Anonymous");
  }
  function formatMsgTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (x) => String(x).padStart(2, "0");
    const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    const now = new Date();
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      return hm;
    }
    if (d.getFullYear() === now.getFullYear()) {
      return d.getMonth() + 1 + "/" + d.getDate() + " " + hm;
    }
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  function myId() {
    return auth && (auth.userId || (auth.user && auth.user.id)) || "";
  }
  function token() {
    return (auth && auth.token) || "";
  }

  function roomLatestAt(roomId) {
    const hot = hotFromTs();
    const items = store.rooms[roomId] || [];
    let max = 0;
    for (const m of items) {
      const at = Number((m && m.createdAt) || 0) || 0;
      if (at < hot) continue;
      if (at > max) max = at;
    }
    return max;
  }

  function unreadCount(roomId) {
    if (roomId === room) return 0;
    const since = Number((store.lastRead && store.lastRead[roomId]) || 0) || 0;
    const hot = hotFromTs();
    const mine = myId();
    let n = 0;
    for (const m of store.rooms[roomId] || []) {
      const at = Number((m && m.createdAt) || 0) || 0;
      if (at < hot || at <= since) continue;
      if (mine && m.user && m.user.id === mine) continue;
      n += 1;
    }
    return n;
  }

  function markRoomRead(roomId) {
    if (!store.lastRead) store.lastRead = { general: 0, bug: 0, improve: 0 };
    const latest = roomLatestAt(roomId);
    const now = Date.now();
    const next = Math.max(Number(store.lastRead[roomId] || 0) || 0, latest, now);
    if (store.lastRead[roomId] === next) return;
    store.lastRead[roomId] = next;
    scheduleSave();
  }

  function paintTabs() {
    tabsEl.innerHTML = "";
    ROOMS.forEach((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab" + (r.id === room ? " active" : "");
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = t(r.zh, r.en);
      b.appendChild(label);
      const n = unreadCount(r.id);
      if (n > 0) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = n > 99 ? "99+" : String(n);
        b.appendChild(badge);
      }
      b.onclick = () => switchRoom(r.id);
      tabsEl.appendChild(b);
    });
  }

  function setLoggedIn(on) {
    authEl.classList.toggle("open", !on);
    list.style.display = on ? "flex" : "none";
    foot.classList.toggle("hidden", !on);
    if (!on) pending.classList.remove("show");
    btnOut.hidden = !on;
    whoEl.textContent = on ? " · " + displayName(auth) : "";
  }

  function setAuthMode(mode) {
    authMode = mode === "register" ? "register" : mode === "passwd" ? "passwd" : "login";
    modeLogin.classList.toggle("on", authMode === "login");
    modeReg.classList.toggle("on", authMode === "register");
    modePass.classList.toggle("on", authMode === "passwd");
    authNick.hidden = authMode !== "register";
    authPassNew.hidden = authMode !== "passwd";
    authPassNew2.hidden = authMode !== "passwd";
    authPass.placeholder = authMode === "passwd"
      ? t("旧密码", "Current password")
      : t("密码（6-72 位）", "Password (6-72 characters)");
    authGo.textContent = authMode === "register"
      ? t("注册", "Register")
      : authMode === "passwd"
        ? t("修改密码", "Change password")
        : t("登录", "Sign in");
    document.getElementById("authTitle").textContent = authMode === "register"
      ? t("注册账户", "Create account")
      : authMode === "passwd"
        ? t("修改密码", "Change password")
        : t("登录后即可发言", "Sign in to chat");
  }

  function applyLocale() {
    document.getElementById("authHint").textContent = t(
      "与创意工坊共用同一账户。登录后默认同步「昨天 5:00」至今；更早日期点选加载（服务器保留约 30 天）。",
      "Same account as Creative Workshop. Syncs since yesterday 5:00 by default; tap a date for older days (kept ~30 days).",
    );
    document.getElementById("pendingTxt").textContent = t(
      "待发送图片（已压缩至 1080p）",
      "Image ready (compressed to 1080p)",
    );
    pendingClear.textContent = t("去掉", "Remove");
    btnImg.title = t("发送图片", "Attach image");
    btnSend.textContent = t("发送", "Send");
    btnOut.title = t("退出登录", "Sign out");
    btnClose.title = t("关闭", "Close");
    input.placeholder = t("说点什么…", "Say something…");
    authUser.placeholder = t("用户名（3-24 位字母、数字或下划线）", "Username (3-24 letters, digits, or _)");
    authPass.placeholder = t("密码（6-72 位）", "Password (6-72 characters)");
    authPassNew.placeholder = t("新密码（6-72 位）", "New password (6-72 characters)");
    authPassNew2.placeholder = t("再次输入新密码", "Confirm new password");
    authNick.placeholder = t("昵称（1-32 位）", "Nickname (1-32 characters)");
    findInput.placeholder = t("查找…", "Find…");
    findPrev.title = t("上一处", "Previous");
    findNext.title = t("下一处", "Next");
    findClose.title = t("关闭", "Close");
    modeLogin.textContent = t("登录", "Sign in");
    modeReg.textContent = t("注册", "Register");
    modePass.textContent = t("修改密码", "Change password");
    setAuthMode(authMode);
    paintTabs();
  }

  function mergeItems(roomId, items) {
    const cur = store.rooms[roomId] || [];
    const map = new Map();
    cur.forEach((m) => map.set(m.id, m));
    (items || []).forEach((m) => {
      if (!m || !m.id) return;
      const old = map.get(m.id) || {};
      map.set(m.id, Object.assign({}, old, m));
    });
    const hot = hotFromTs();
    const expanded = expandedDays[roomId] || Object.create(null);
    let next = [...map.values()]
      .filter((m) => {
        const at = Number((m && m.createdAt) || 0) || 0;
        if (at >= hot) return true;
        return !!expanded[dayKeyOf(at)];
      })
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (next.length > MSG_CAP) next = next.slice(next.length - MSG_CAP);
    store.rooms[roomId] = next;
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const slim = {
        rooms: { general: [], bug: [], improve: [] },
        lastRead: store.lastRead,
      };
      ROOMS.forEach((r) => {
        slim.rooms[r.id] = keepHotOnly(store.rooms[r.id] || []).slice(-MSG_CAP);
      });
      api.localSave(slim).catch(() => {});
    }, 250);
  }

  function addSys(text) {
    const el = document.createElement("div");
    el.className = "msg sys";
    el.textContent = text;
    list.appendChild(el);
  }

  async function ensureImage(id) {
    if (!id) return "";
    if (imgUrl[id]) return imgUrl[id];
    const cached = await api.readCachedImage(id);
    if (cached && cached.ok && cached.dataUrl) {
      imgUrl[id] = cached.dataUrl;
      return cached.dataUrl;
    }
    if (!token()) return "";
    const r = await api.storeRequest({
      method: "GET",
      path: "/api/forum/images/" + encodeURIComponent(id),
      token: token(),
    });
    if (r && r.ok && r.base64) {
      await api.cacheImage(id, r.base64);
      const url = "data:" + (r.contentType || "image/jpeg") + ";base64," + r.base64;
      imgUrl[id] = url;
      return url;
    }
    return "";
  }

  let stickBottom = true;
  let findOpen = false;
  let findQuery = "";
  let findHit = 0;
  const findHits = [];

  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 96;
  }
  function scrollToLatest() {
    stickBottom = true;
    const go = () => {
      list.scrollTop = list.scrollHeight;
    };
    go();
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(go);
    });
    setTimeout(go, 60);
    setTimeout(go, 220);
  }

  function fillHighlighted(el, text, query) {
    el.textContent = "";
    const src = String(text || "");
    const q = String(query || "");
    if (!q) {
      el.textContent = src;
      return;
    }
    const lower = src.toLowerCase();
    const needle = q.toLowerCase();
    let from = 0;
    let idx = lower.indexOf(needle, from);
    while (idx >= 0) {
      if (idx > from) el.appendChild(document.createTextNode(src.slice(from, idx)));
      const mark = document.createElement("mark");
      mark.textContent = src.slice(idx, idx + needle.length);
      findHits.push(mark);
      el.appendChild(mark);
      from = idx + needle.length;
      idx = lower.indexOf(needle, from);
    }
    if (from < src.length) el.appendChild(document.createTextNode(src.slice(from)));
  }

  function paintFindCount() {
    if (!findOpen || !findQuery) {
      findCount.textContent = "";
      return;
    }
    if (!findHits.length) {
      findCount.textContent = t("无结果", "0");
      return;
    }
    findCount.textContent = (findHit + 1) + "/" + findHits.length;
  }

  function revealFindHit() {
    findHits.forEach((m, i) => m.classList.toggle("cur", i === findHit));
    const cur = findHits[findHit];
    if (cur && cur.scrollIntoView) {
      stickBottom = false;
      cur.scrollIntoView({ block: "center" });
    }
    paintFindCount();
  }

  function applyFind(keepIndex) {
    findHits.length = 0;
    findQuery = findOpen ? String(findInput.value || "") : "";
    const q = findQuery.trim();
    const nodes = list.querySelectorAll(".bubble [data-find-text]");
    nodes.forEach((el) => fillHighlighted(el, el.getAttribute("data-find-text") || "", q));
    if (!q || !findHits.length) {
      findHit = 0;
      paintFindCount();
      return;
    }
    if (!keepIndex) findHit = 0;
    else findHit = Math.min(Math.max(0, findHit), findHits.length - 1);
    revealFindHit();
  }

  function stepFind(dir) {
    if (!findHits.length) return;
    findHit = (findHit + dir + findHits.length) % findHits.length;
    revealFindHit();
  }

  function openFind() {
    findOpen = true;
    findbar.classList.add("open");
    findInput.focus();
    findInput.select();
    applyFind(true);
  }

  function closeFind() {
    findOpen = false;
    findbar.classList.remove("open");
    findInput.value = "";
    findQuery = "";
    findHit = 0;
    applyFind(false);
    paintFindCount();
  }

  function appendMsgEl(m, mine) {
    const el = document.createElement("div");
    const isMine = !!(mine && m.user && m.user.id === mine);
    el.className = "msg " + (isMine ? "mine" : "other");
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = displayName(m.user);
    const timeTxt = formatMsgTime(m.createdAt || m.at || m.ts);
    meta.textContent = timeTxt ? name + " · " + timeTxt : name;
    el.appendChild(meta);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (m.text) {
      const tx = document.createElement("div");
      tx.setAttribute("data-find-text", m.text);
      tx.textContent = m.text;
      bubble.appendChild(tx);
    }
    if (m.imageId) {
      const im = document.createElement("img");
      im.alt = "";
      im.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (im.src) {
          zoomImg.src = im.src;
          zoom.classList.add("open");
        }
      });
      im.addEventListener("load", () => {
        if (stickBottom) scrollToLatest();
      });
      bubble.appendChild(im);
      ensureImage(m.imageId).then((url) => {
        if (url) im.src = url;
      });
    }
    el.appendChild(bubble);
    list.appendChild(el);
  }

  function addDayChip(dayInfo) {
    const day = dayInfo.day;
    const count = Number(dayInfo.count) || 0;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "msg day-chip";
    const loading = !!dayLoading[room + ":" + day];
    const expanded = !!(expandedDays[room] && expandedDays[room][day]);
    if (expanded) {
      el.classList.add("expanded");
      el.textContent = formatDayLabel(day) + (count ? " · " + count : "");
      el.disabled = true;
    } else if (loading) {
      el.classList.add("loading");
      el.textContent = formatDayLabel(day) + " · " + t("加载中…", "Loading…");
      el.disabled = true;
    } else {
      el.textContent =
        formatDayLabel(day) +
        (count ? " · " + count + t(" 条", " msgs") : "") +
        " · " +
        t("点击加载", "Tap to load");
      el.onclick = () => expandDay(day);
    }
    list.appendChild(el);
  }

  function render(opts) {
    const forceBottom = !opts || opts.forceBottom !== false;
    if (forceBottom) stickBottom = true;
    else stickBottom = nearBottom();
    list.innerHTML = "";
    const hot = hotFromTs();
    const items = store.rooms[room] || [];
    const days = dayLists[room] || [];
    const mine = myId();

    days.forEach((d) => {
      if (!d || !d.day) return;
      addDayChip(d);
      if (expandedDays[room] && expandedDays[room][d.day]) {
        const range = dayRangeLocal(d.day);
        items
          .filter((m) => {
            const at = Number((m && m.createdAt) || 0) || 0;
            return at >= range.from && at <= range.to;
          })
          .forEach((m) => appendMsgEl(m, mine));
      }
    });

    const hotItems = items.filter((m) => (Number(m && m.createdAt) || 0) >= hot);
    if (!days.length && !hotItems.length) {
      addSys(t("还没有消息，来说第一句吧。", "No messages yet. Start the conversation."));
      if (stickBottom) scrollToLatest();
      return;
    }
    if (days.length && hotItems.length) {
      const sep = document.createElement("div");
      sep.className = "msg sys";
      sep.textContent = t("—— 昨天 5:00 至今 ——", "—— Since yesterday 5:00 ——");
      list.appendChild(sep);
    }
    hotItems.forEach((m) => appendMsgEl(m, mine));
    applyFind(true);
    if (stickBottom) scrollToLatest();
  }

  function applyDayList(id, days) {
    dayLists[id] = (days || []).filter((d) => d && d.day && (Number(d.count) || 0) > 0);
  }

  function dayListFromItems(items, beforeTs) {
    const map = new Map();
    const before = Number(beforeTs) || 0;
    for (const m of items || []) {
      const at = Number((m && m.createdAt) || 0) || 0;
      if (!at || at >= before) continue;
      const day = dayKeyOf(at);
      const cur = map.get(day) || { day, count: 0, from: at, to: at };
      cur.count += 1;
      if (at < cur.from) cur.from = at;
      if (at > cur.to) cur.to = at;
      map.set(day, cur);
    }
    return [...map.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  async function syncDays(id) {
    if (!token()) return;
    const before = hotFromTs();
    const r = await api.storeRequest({
      method: "GET",
      path:
        "/api/forum/days?room=" +
        encodeURIComponent(id) +
        "&before=" +
        encodeURIComponent(String(before)) +
        "&tzOffset=" +
        encodeURIComponent(String(new Date().getTimezoneOffset())),
      token: token(),
    });
    if (r && r.status === 401) {
      await signedOut();
      return;
    }
    if (r && r.ok && r.data && Array.isArray(r.data.days)) {
      applyDayList(id, r.data.days);
      return;
    }
    /* 兼容旧服务端：拉一次热窗口之前的消息，只用于生成日期条，不入库正文 */
    const archiveFrom = before - 30 * 24 * 3600 * 1000;
    const r2 = await api.storeRequest({
      method: "GET",
      path:
        "/api/forum/messages?room=" +
        encodeURIComponent(id) +
        "&from=" +
        encodeURIComponent(String(archiveFrom)) +
        "&to=" +
        encodeURIComponent(String(before - 1)),
      token: token(),
    });
    if (r2 && r2.status === 401) {
      await signedOut();
      return;
    }
    if (r2 && r2.ok && r2.data && Array.isArray(r2.data.items)) {
      applyDayList(id, dayListFromItems(r2.data.items, before));
    }
  }

  async function expandDay(dayKey) {
    if (!token() || !dayKey) return;
    const key = room + ":" + dayKey;
    if (dayLoading[key] || (expandedDays[room] && expandedDays[room][dayKey])) return;
    dayLoading[key] = true;
    render({ forceBottom: false });
    const range = dayRangeLocal(dayKey);
    if (!(range.to >= range.from)) {
      dayLoading[key] = false;
      expandedDays[room][dayKey] = true;
      render({ forceBottom: false });
      return;
    }
    const r = await api.storeRequest({
      method: "GET",
      path:
        "/api/forum/messages?room=" +
        encodeURIComponent(room) +
        "&from=" +
        encodeURIComponent(String(range.from)) +
        "&to=" +
        encodeURIComponent(String(range.to)),
      token: token(),
    });
    dayLoading[key] = false;
    if (r && r.status === 401) {
      await signedOut();
      return;
    }
    if (r && r.ok && r.data && Array.isArray(r.data.items)) {
      expandedDays[room][dayKey] = true;
      mergeItems(room, r.data.items);
      scheduleSave();
      if (!r.data.items.length) {
        /* 旧服务端可能忽略 from/to：用本地已有或再提示 */
      }
    } else {
      addSys(apiErr(r) || t("加载失败", "Failed to load"));
    }
    render({ forceBottom: false });
  }

  async function syncRoom(id) {
    if (!token()) return;
    const from = hotFromTs();
    const since = roomLatestAt(id);
    const r = await api.storeRequest({
      method: "GET",
      path:
        "/api/forum/messages?room=" +
        encodeURIComponent(id) +
        "&from=" +
        encodeURIComponent(String(from)) +
        "&includeDays=1" +
        "&tzOffset=" +
        encodeURIComponent(String(new Date().getTimezoneOffset())) +
        (since ? "&since=" + encodeURIComponent(String(since)) : ""),
      token: token(),
    });
    if (r && r.status === 401) {
      await signedOut();
      return;
    }
    if (!r || !r.ok || !r.data || !Array.isArray(r.data.items)) {
      await syncDays(id);
      if (id === room) render({ forceBottom: false });
      paintTabs();
      return;
    }
    /* 旧服务端可能仍返回热窗口外消息：先据此生成日期条 */
    const derived = dayListFromItems(r.data.items, from);
    if (derived.length) applyDayList(id, derived);
    if (Array.isArray(r.data.days)) applyDayList(id, r.data.days);
    else if (!(dayLists[id] && dayLists[id].length)) await syncDays(id);
    mergeItems(id, r.data.items);
    scheduleSave();
    if (id === room) {
      markRoomRead(id);
      render({ forceBottom: false });
    }
    paintTabs();
  }

  async function syncAllRooms() {
    if (!token()) return;
    for (const r of ROOMS) {
      await syncRoom(r.id);
    }
  }

  async function switchRoom(id) {
    if (!ROOMS.some((r) => r.id === id)) return;
    room = id;
    markRoomRead(id);
    paintTabs();
    render({ forceBottom: true });
    await syncRoom(id);
    markRoomRead(id);
    paintTabs();
    scrollToLatest();
  }

  async function signedOut() {
    auth = null;
    await api.setAuth(null);
    setLoggedIn(false);
    setAuthMode("login");
  }

  function apiErr(r) {
    if (!r) return t("网络请求失败", "Network request failed");
    if (r.data && r.data.error) return r.data.error;
    if (r.error) return r.error;
    return "HTTP " + (r.status || "");
  }

  async function doAuth() {
    authErr.textContent = "";
    let path = "/api/login";
    let payload = { username: authUser.value.trim(), password: authPass.value };
    if (authMode === "register") {
      path = "/api/register";
      payload.nickname = authNick.value.trim();
    } else if (authMode === "passwd") {
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
      path = "/api/change-password";
      payload = { username: authUser.value.trim(), oldPassword, newPassword };
    }
    const r = await api.storeRequest({ method: "POST", path, json: payload });
    if (!r || !r.ok || !r.data || !r.data.token) {
      authErr.textContent = apiErr(r);
      return;
    }
    const u = r.data.user || {};
    auth = {
      token: r.data.token,
      userId: u.id,
      username: u.username,
      nickname: u.nickname,
    };
    await api.setAuth(auth);
    authPass.value = "";
    authPassNew.value = "";
    authPassNew2.value = "";
    setAuthMode("login");
    setLoggedIn(true);
    await syncAllRooms();
    markRoomRead(room);
    paintTabs();
    scrollToLatest();
  }

  async function logout() {
    if (token()) {
      await api.storeRequest({ method: "POST", path: "/api/logout", json: {}, token: token() });
    }
    await signedOut();
  }

  function showPending(img) {
    pendingImage = img;
    if (!img) {
      pending.classList.remove("show");
      pendingImg.removeAttribute("src");
      return;
    }
    pendingImg.src = "data:image/jpeg;base64," + img.base64;
    pending.classList.add("show");
  }

  async function takeImage(base64, name) {
    const r = await api.compressImage({ base64, name: name || "image.jpg" });
    if (!r || !r.ok) {
      addSys((r && r.error) || t("无法读取图片", "Could not read image"));
      return;
    }
    showPending(r);
  }

  async function send() {
    if (busy || !token()) return;
    const text = String(input.value || "").trim();
    if (!text && !pendingImage) return;
    busy = true;
    btnSend.disabled = true;
    const payload = { room, text };
    if (pendingImage && pendingImage.base64) payload.imageBase64 = pendingImage.base64;
    const r = await api.storeRequest({
      method: "POST",
      path: "/api/forum/messages",
      json: payload,
      token: token(),
    });
    busy = false;
    btnSend.disabled = false;
    if (r && r.status === 401) {
      await signedOut();
      return;
    }
    if (!r || !r.ok || !r.data || !r.data.item) {
      addSys(apiErr(r));
      return;
    }
    const item = r.data.item;
    if (item.imageId && pendingImage && pendingImage.base64) {
      await api.cacheImage(item.imageId, pendingImage.base64);
      imgUrl[item.imageId] = "data:image/jpeg;base64," + pendingImage.base64;
    }
    input.value = "";
    showPending(null);
    mergeItems(room, [item]);
    markRoomRead(room);
    scheduleSave();
    render({ forceBottom: true });
    paintTabs();
  }

  async function boot() {
    const st = await api.getAuth();
    locale = st && st.locale === "en" ? "en" : "zh";
    applyLocale();
    const local = await api.localLoad();
    if (local && local.ok && local.data && local.data.rooms) {
      ROOMS.forEach((r) => {
        if (Array.isArray(local.data.rooms[r.id])) {
          const arr = keepHotOnly(local.data.rooms[r.id]);
          store.rooms[r.id] = arr.length > MSG_CAP ? arr.slice(arr.length - MSG_CAP) : arr;
        }
      });
    }
    if (local && local.ok && local.data && local.data.lastRead) {
      ROOMS.forEach((r) => {
        const v = Number(local.data.lastRead[r.id] || 0) || 0;
        store.lastRead[r.id] = v;
      });
    }
    /* 首次无已读位点：把本地已有消息视为已读，避免一打开就刷满 badge */
    ROOMS.forEach((r) => {
      if (!store.lastRead[r.id]) {
        const latest = roomLatestAt(r.id);
        store.lastRead[r.id] = latest || Date.now();
      }
    });
    auth = (st && st.auth) || null;
    setLoggedIn(!!token());
    render({ forceBottom: true });
    paintTabs();
    if (token()) {
      const me = await api.storeRequest({ method: "GET", path: "/api/me", token: token() });
      if (me && me.status === 401) await signedOut();
      else if (me && me.ok && me.data && me.data.user) {
        auth = Object.assign({}, auth, {
          userId: me.data.user.id,
          username: me.data.user.username,
          nickname: me.data.user.nickname,
        });
        await api.setAuth(auth);
        whoEl.textContent = " · " + displayName(auth);
      }
      await syncAllRooms();
      markRoomRead(room);
      paintTabs();
      scrollToLatest();
    }
    pollTimer = setInterval(async () => {
      if (!token()) {
        const st = await api.getAuth();
        if (st && st.auth && st.auth.token) {
          auth = st.auth;
          locale = st.locale === "en" ? "en" : locale;
          setLoggedIn(true);
          await syncAllRooms();
          markRoomRead(room);
          paintTabs();
        }
        return;
      }
      await syncAllRooms();
    }, 12000);
  }

  btnClose.onclick = () => api.close();
  btnOut.onclick = logout;
  btnSend.onclick = send;
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });
  btnImg.onclick = async () => {
    const r = await api.pickImage();
    if (r && r.ok && r.base64) showPending(r);
    else if (r && r.error && r.error !== "cancelled") addSys(r.error);
  };
  pendingClear.onclick = () => showPending(null);
  modeLogin.onclick = () => setAuthMode("login");
  modeReg.onclick = () => setAuthMode("register");
  modePass.onclick = () => setAuthMode("passwd");
  authGo.onclick = doAuth;
  [authPass, authPassNew, authPassNew2, authNick].forEach((el) => {
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") doAuth();
    });
  });
  zoom.onclick = () => {
    zoom.classList.remove("open");
    zoomImg.removeAttribute("src");
  };
  list.addEventListener("scroll", () => {
    stickBottom = nearBottom();
  });
  findInput.addEventListener("input", () => applyFind(false));
  findInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (ev.shiftKey) stepFind(-1);
      else stepFind(1);
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeFind();
    }
  });
  findPrev.onclick = () => stepFind(-1);
  findNext.onclick = () => stepFind(1);
  findClose.onclick = closeFind;
  document.addEventListener("keydown", (ev) => {
    const key = String(ev.key || "").toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && key === "f") {
      ev.preventDefault();
      ev.stopPropagation();
      openFind();
      return;
    }
    if (ev.key === "F3") {
      ev.preventDefault();
      if (!findOpen) openFind();
      else stepFind(ev.shiftKey ? -1 : 1);
      return;
    }
    if (ev.key === "Escape" && findOpen) {
      ev.preventDefault();
      closeFind();
    }
  }, true);
  if (api && typeof api.onShown === "function") {
    api.onShown(() => scrollToLatest());
  }
  document.addEventListener("paste", async (ev) => {
    if (!token()) return;
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && String(it.type || "").startsWith("image/")) {
        ev.preventDefault();
        const f = it.getAsFile();
        if (!f) return;
        const buf = await f.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        await takeImage(btoa(bin), f.name || "paste.jpg");
        return;
      }
    }
  });

  boot().catch((e) => {
    addSys(String((e && e.message) || e));
  });
  window.addEventListener("unload", () => {
    if (pollTimer) clearInterval(pollTimer);
  });
})();

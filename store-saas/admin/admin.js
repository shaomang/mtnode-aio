/* MTNode 管理平台（零依赖 · 独立界面 · 仅管理员微信扫码登录）
 *
 * 口径：
 *   · 所有接口都走 /api/admin/*，凭 `adm_` 前缀的 8 小时独立会话（与客户端 Bearer 完全分开）。
 *   · 登录只有一条路：微信扫码（iframe 内嵌 qrconnect，self_redirect=true 让跳转留在 iframe 里），
 *     页面按 deviceCode 轮询 /api/admin/login/wechat/poll；服务端拒绝一切非管理员账号。
 *     iframe 方案要求 index.html 的 frame-src 放行「微信域 + 本站回调域」两跳，否则扫码确认后
 *     回跳被拦、callback 根本到不了服务端（表现＝扫了码但页面毫无反应，轮询到过期）。
 *     兜底：#lnkNewWin 用同一条 authUrl 走顶层新窗口（顶层导航不受 frame-src 约束）。
 *   · 弹窗一律 persistent：只能点「取消 / 确定」或 Esc 关闭，点外部不关（避免填一半被吞）。
 *   · 金额一律「分」整数存储，展示时才转元；不做任何前端算术决策（校验以服务端为准）。
 */
(() => {
  "use strict";

  /* ---------- API 基址：/mtnode/admin/ → /mtnode/store-api；本机 /admin → 同源根 ---------- */
  const PREFIX = location.pathname.replace(/\/admin\/.*$/, "").replace(/\/admin$/, "");
  const API = new URLSearchParams(location.search).get("api") || (PREFIX ? PREFIX + "/store-api" : "");
  const TOKEN_KEY = "mtnodeAdminToken";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };

  let TOKEN = localStorage.getItem(TOKEN_KEY) || "";

  async function api(method, path, body, opt) {
    const headers = {};
    if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(API + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    // noRelogin：登录轮询自己的 403（该微信没绑账号 / 不是管理员）**不能**触发自动重开扫码页——
    // 新二维码会把服务端给的原因盖掉，用户看到的又只是「扫码后无效」。这种情况落到下面的
    // 通用分支，抛出服务端原文（如「该账号不是管理平台管理员」）由 poll 的 catch 显示。
    if ((res.status === 401 || res.status === 403) && !(opt && opt.noRelogin)) {
      const code = data && data.code;
      if (code === "ADMIN_UNAUTHORIZED" || code === "ADMIN_FORBIDDEN") {
        TOKEN = "";
        localStorage.removeItem(TOKEN_KEY);
        showLogin();
        throw new ApiError((data && data.error) || "管理会话已失效，请重新扫码登录", res.status, code);
      }
    }
    if (!res.ok || !data || data.ok !== true) {
      throw new ApiError((data && (data.error || data.code)) || "请求失败（HTTP " + res.status + "）", res.status, data && data.code);
    }
    return data;
  }

  class ApiError extends Error {
    constructor(msg, status, code) {
      super(msg);
      this.status = status || 0;
      this.code = code || "";
    }
  }

  /* ---------- 展示助手 ---------- */

  const money = (cents) => "¥" + (Number(cents || 0) / 100).toFixed(2);
  const ts = (ms) => {
    if (!ms) return "—";
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  };
  const ST_TEXT = {
    pending: "待支付",
    paid: "已支付",
    partial_refunded: "部分退款",
    refunded: "已退款",
    expired: "已过期",
    closed: "已关单",
    paid_mismatch: "金额不符",
  };
  const stClass = (s) => (s === "paid" ? "st-paid" : s === "pending" ? "st-pending" : ["refunded", "partial_refunded", "paid_mismatch", "expired", "closed"].includes(s) ? "st-bad" : "st-muted");
  const LEDGER_TEXT = { recharge: "充值入账", refund: "退款", adjust: "人工调账", mismatch: "金额不符" };

  let toastTimer = 0;
  function toast(msg, kind) {
    const n = $("toast");
    n.textContent = String(msg || "");
    n.className = "toast " + (kind || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => n.classList.add("hidden"), 3200);
  }

  /* ---------- 弹窗（persistent：按钮 / Esc 关闭，点外部不关） ---------- */

  let dlgOk = null;
  function openDialog(title, fields, onOk, okText) {
    $("dlgTitle").textContent = title;
    const body = $("dlgBody");
    body.textContent = "";
    const inputs = {};
    for (const f of fields) {
      if (f.kind === "note") {
        body.appendChild(el("div", "hint", f.text));
        continue;
      }
      const lab = el("label", "", f.label);
      const inp = el(f.type === "textarea" ? "textarea" : "input");
      if (f.type !== "textarea") inp.type = f.type || "text";
      if (f.value != null) inp.value = f.value;
      if (f.placeholder) inp.placeholder = f.placeholder;
      if (f.type === "textarea") inp.rows = 3;
      if (f.required) inp.required = true;
      lab.appendChild(inp);
      body.appendChild(lab);
      inputs[f.name] = inp;
    }
    $("dlgOk").textContent = okText || "确定";
    $("dlg").classList.remove("hidden");
    const first = Object.values(inputs)[0];
    if (first) first.focus();
    dlgOk = async () => {
      const vals = {};
      for (const k of Object.keys(inputs)) vals[k] = inputs[k].value.trim();
      $("dlgOk").disabled = true;
      try {
        const keepOpen = await onOk(vals);
        if (!keepOpen) closeDialog();
      } catch (e) {
        toast((e && e.message) || "操作失败", "err");
      } finally {
        $("dlgOk").disabled = false;
      }
    };
  }
  function closeDialog() {
    $("dlg").classList.add("hidden");
    $("dlgCancel").classList.remove("hidden"); // 详情弹窗会藏掉「取消」，关闭时统一复位
    $("dlgOk").textContent = "确定";
    $("dlgOk").disabled = false;
    dlgOk = null;
  }
  $("dlgCancel").addEventListener("click", closeDialog);
  $("dlgOk").addEventListener("click", () => dlgOk && dlgOk());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("dlg").classList.contains("hidden")) closeDialog();
  });

  /* ---------- 表格助手 ---------- */

  function renderTable(table, columns, rows, emptyText) {
    table.textContent = "";
    const thead = el("thead");
    const htr = el("tr");
    for (const c of columns) htr.appendChild(el("th", c.cls || "", c.title));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el("tbody");
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "muted", emptyText || "暂无数据");
      td.colSpan = columns.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    for (const r of rows) {
      const tr = el("tr");
      for (const c of columns) {
        const td = el("td", c.cls || "");
        if (c.render) c.render(td, r);
        else td.textContent = c.get ? c.get(r) : "";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  /** 在容器里新建一张表并渲染（详情弹窗 / 概览待处理区用）。 */
  function mountTable(parent, columns, rows, emptyText) {
    const table = el("table");
    parent.appendChild(table);
    renderTable(table, columns, rows, emptyText);
    return table;
  }

  function renderPager(node, total, page, pageSize, go) {    node.textContent = "";
    const pages = Math.max(1, Math.ceil(total / pageSize));
    node.appendChild(el("span", "", "共 " + total + " 条 · 第 " + page + "/" + pages + " 页"));
    const prev = el("button", "btn btn-sm", "上一页");
    prev.disabled = page <= 1;
    prev.addEventListener("click", () => go(page - 1));
    const next = el("button", "btn btn-sm", "下一页");
    next.disabled = page >= pages;
    next.addEventListener("click", () => go(page + 1));
    node.appendChild(prev);
    node.appendChild(next);
  }

  /* ---------- 登录 ---------- */

  let pollTimer = 0;
  let pollTries = 0;

  function showLogin() {
    $("app").classList.add("hidden");
    $("login").classList.remove("hidden");
    startLogin();
  }

  function setLoginStatus(text, kind) {
    const n = $("loginStatus");
    n.textContent = text;
    n.className = "login-status " + (kind || "");
  }

  async function startLogin() {
    clearTimeout(pollTimer);
    pollTries = 0;
    const box = $("qrBox");
    box.textContent = "";
    box.appendChild(el("div", "qr-tip", "正在准备二维码…"));
    $("btnRetry").classList.add("hidden");
    setLoginStatus("正在获取二维码…");
    let start;
    const lnk = $("lnkNewWin");
    try {
      start = await api("POST", "/api/admin/login/wechat/start");
    } catch (e) {
      box.textContent = "";
      box.appendChild(el("div", "qr-tip", "无法获取二维码：" + ((e && e.message) || e)));
      lnk.classList.add("hidden");
      setLoginStatus("微信登录不可用", "err");
      $("btnRetry").classList.remove("hidden");
      return;
    }
    // iframe 内嵌：self_redirect=true 让微信回跳留在 iframe 内，本页继续轮询。
    // 回跳目标 = 服务端 MTNODE_WECHAT_REDIRECT（线上是 apex，会再 301 到 www），index.html 的
    // frame-src 必须把这两跳都放行；少放行 = 浏览器在发请求前就拦掉跳转 = 服务端收不到
    // callback = 没有 ticket = 轮询一直 pending 到设备码过期（用户看到的「扫码后无效」）。
    const authUrl = String(start.authUrl || "");
    const url = authUrl.replace("#wechat_redirect", "&self_redirect=true#wechat_redirect");
    box.textContent = "";
    const fr = el("iframe");
    fr.src = url;
    fr.title = "微信扫码登录";
    fr.setAttribute("scrolling", "no");
    box.appendChild(fr);
    // 兜底：新窗口打开同一条 authUrl（顶层导航不受 frame-src 约束）。刻意不带 self_redirect：
    // 新标签里微信直接顶层回跳到本站回调页，本页照旧轮询即可拿到会话。
    lnk.href = authUrl;
    lnk.classList.toggle("hidden", !authUrl);
    setLoginStatus("请使用管理员微信扫码（二维码 " + Math.floor((start.expiresIn || 300) / 60) + " 分钟内有效）");
    poll(start.deviceCode, Math.max(1, start.interval || 2));
  }

  function poll(deviceCode, interval) {
    const step = async () => {
      pollTries++;
      try {
        const r = await api("POST", "/api/admin/login/wechat/poll", { deviceCode }, { noRelogin: true });
        if (r.status === "done" && r.token) {
          TOKEN = r.token;
          localStorage.setItem(TOKEN_KEY, TOKEN);
          clearTimeout(pollTimer);
          enterApp(r.user, r.expiresIn);
          return;
        }
        setLoginStatus("等待扫码确认…（" + pollTries + "）");
      } catch (e) {
        const code = e && e.code;
        clearTimeout(pollTimer);
        if (code === "CODE_EXPIRED") {
          setLoginStatus("二维码已过期，请重新获取", "err");
          $("btnRetry").classList.remove("hidden");
          return;
        }
        if (code === "ADMIN_REQUIRED" || code === "ADMIN_FORBIDDEN") {
          // 服务端已给出明确原因（该微信没绑账号 / 不是管理员）：把二维码收起来，
          // 别让人对着一张注定登不进去的码反复扫。
          const box = $("qrBox");
          box.textContent = "";
          box.appendChild(el("div", "qr-tip", (e && e.message) || "该微信没有管理平台权限"));
          $("lnkNewWin").classList.add("hidden");
          setLoginStatus("扫码已确认，但这个微信登不进管理平台", "err");
          $("btnRetry").classList.remove("hidden");
          return;
        }
        setLoginStatus((e && e.message) || "登录失败", "err");
        $("btnRetry").classList.remove("hidden");
        return;
      }
      pollTimer = setTimeout(step, interval * 1000);
    };
    pollTimer = setTimeout(step, interval * 1000);
  }

  $("btnRetry").addEventListener("click", startLogin);

  /* ---------- 主界面 ---------- */

  let ME = null;
  let OV = null;

  function enterApp(user, expiresIn) {
    ME = user || null;
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("whoName").textContent = ME ? ME.nickname || ME.username || ME.id : "";
    refreshSessionLabel(expiresIn);
    switchView("overview");
  }

  function refreshSessionLabel(expiresInSec) {
    if (expiresInSec) {
      localStorage.setItem("mtnodeAdminExpire", String(Date.now() + expiresInSec * 1000));
    }
    const exp = Number(localStorage.getItem("mtnodeAdminExpire") || 0);
    $("whoExpire").textContent = exp ? "会话至 " + ts(exp) : "";
  }

  function switchView(name) {
    for (const b of document.querySelectorAll("#tabs .tab")) b.classList.toggle("active", b.dataset.view === name);
    for (const v of document.querySelectorAll(".view")) v.classList.toggle("hidden", v.id !== "view-" + name);
    if (name === "overview") loadOverview();
    if (name === "orders") loadOrders(ordersPage);
    if (name === "users") loadUsers(usersPage);
    if (name === "ledger") loadLedger();
  }
  for (const b of document.querySelectorAll("#tabs .tab")) {
    b.addEventListener("click", () => switchView(b.dataset.view));
  }

  $("btnLogout").addEventListener("click", async () => {
    try {
      await api("POST", "/api/admin/logout");
    } catch {}
    TOKEN = "";
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("mtnodeAdminExpire");
    showLogin();
  });

  /* ---------- 概览 ---------- */

  // 重入保护：切页 / 刷新可能并发触发两次加载，交错写入会把同一区块渲染两遍
  let ovSeq = 0;

  async function loadOverview() {
    const seq = ++ovSeq;
    try {
      OV = await api("GET", "/api/admin/overview");
    } catch (e) {
      toast((e && e.message) || "加载概览失败", "err");
      return;
    }
    if (seq !== ovSeq) return; // 已有更新的加载在进行，本次结果作废
    ME = OV.admin || ME;
    $("whoName").textContent = ME ? ME.nickname || ME.username || ME.id : "";
    if (OV.sessionExpiresAt) {
      localStorage.setItem("mtnodeAdminExpire", String(OV.sessionExpiresAt));
      $("whoExpire").textContent = "会话至 " + ts(OV.sessionExpiresAt);
    }
    const s = OV.stats || {};
    const cards = [
      ["已收款", money(s.paidCents), "money"],
      ["已退款", money(s.refundedCents), "money"],
      ["净入账", money(s.netCents), "money"],
      ["订单总数", String(s.orders || 0), ""],
      ["流水条数", String(s.ledger || 0), ""],
      ["待支付", String((s.byStatus && s.byStatus.pending) || 0), ""],
      ["金额不符（需人工）", String((s.byStatus && s.byStatus.paid_mismatch) || 0), ""],
    ];
    const box = $("ovCards");
    box.textContent = "";
    for (const [k, v, cls] of cards) {
      const c = el("div", "card");
      c.appendChild(el("div", "k", k));
      c.appendChild(el("div", "v " + cls, v));
      box.appendChild(c);
    }

    const pay = OV.alipay || {};
    const rows = [
      ["当前管理员", (ME && (ME.username || ME.id)) || "—"],
      ["支付宝当面付", pay.configured ? "已配置（appid " + pay.appId + (pay.sandbox ? " · 沙箱" : "") + "）" : "未配置，缺少 " + (pay.missing || []).join(" / ")],
      ["异步通知地址", pay.notifyUrl || "（未配置：只能靠轮询 / 手动补单入账）"],
      ["微信登录", OV.wechat && OV.wechat.configured ? "已配置" : "未配置（管理页无法扫码登录）"],
      ["微信归属映射", (OV.wechat && OV.wechat.ownerMapEntries) + " 条"],
      ["充值白名单", ((OV.config && OV.config.rechargeUsers) || []).join(", ") || "（空）"],
      ["充值区间", money(OV.config && OV.config.minCents) + " – " + money(OV.config && OV.config.maxCents)],
    ];
    const hp = $("ovHealth");
    hp.textContent = "";
    const dl = el("dl");
    for (const [k, v] of rows) {
      dl.appendChild(el("dt", "", k));
      const dd = el("dd");
      if (k === "支付宝当面付" || k === "微信登录") {
        dd.appendChild(el("span", "badge " + (String(v).startsWith("已配置") ? "ok" : "bad"), v));
      } else dd.textContent = v;
      dl.appendChild(dd);
    }
    hp.appendChild(dl);

    // 待人工处理：金额不符 / 过期后才到账的订单，必须人工核对
    const att = $("ovAttention");
    try {
      const mm = await api("GET", "/api/admin/orders?status=paid_mismatch&pageSize=50");
      if (seq !== ovSeq) return;
      att.textContent = "";
      if (!mm.items.length) {
        att.appendChild(el("div", "muted", "暂无需要人工处理的订单。"));
      } else {
        att.appendChild(el("div", "hint", "以下订单实付金额与订单金额不符，已留痕但未入账，请核对支付宝账单后用「用户 → 调账」处理："));
        mountTable(att, orderColumns(false), mm.items, "暂无");
      }
    } catch (e) {
      if (seq !== ovSeq) return;
      att.textContent = "";
      att.appendChild(el("div", "muted", "加载失败：" + ((e && e.message) || e)));
    }
  }

  /* ---------- 订单 ---------- */

  let ordersPage = 1;
  const ORDERS_PAGE_SIZE = 20;

  function orderColumns(withActions) {
    const cols = [
      { title: "订单号", cls: "mono", get: (r) => r.id },
      { title: "账号", get: (r) => (r.nickname || "") + (r.username ? " @" + r.username : "") },
      { title: "金额", cls: "num", get: (r) => money(r.amountCents) },
      {
        title: "状态",
        render: (td, r) => {
          td.appendChild(el("span", "st " + stClass(r.status), (ST_TEXT[r.status] || r.status)));
          if (r.latePaid) td.appendChild(el("span", "badge warn", "过期后到账"));
        },
      },
      { title: "下单时间", get: (r) => ts(r.createdAt) },
      { title: "支付时间", get: (r) => ts(r.paidAt) },
      { title: "已退", cls: "num", get: (r) => (r.refundedCents ? money(r.refundedCents) : "—") },
      { title: "交易号", cls: "mono", get: (r) => r.tradeNo || "—" },
      { title: "入账来源", get: (r) => r.source || "—" },
    ];
    if (withActions !== false) {
      cols.push({
        title: "操作",
        render: (td, r) => {
          const box = el("div", "actions");
          box.appendChild(actBtn("详情", () => showOrderDetail(r.id)));
          if (r.status === "pending" || r.status === "expired" || r.status === "closed") {
            box.appendChild(actBtn("补单", () => recheckOrder(r.id)));
          }
          if (r.status === "paid" || r.status === "partial_refunded") {
            const b = actBtn("退款", () => refundDialog(r), "btn-danger");
            box.appendChild(b);
          }
          td.appendChild(box);
        },
      });
    }
    return cols;
  }

  function actBtn(text, fn, cls) {
    const b = el("button", "btn btn-sm " + (cls || ""), text);
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        toast((e && e.message) || "操作失败", "err");
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  async function loadOrders(page) {
    ordersPage = Math.max(1, page || 1);
    const q = encodeURIComponent($("fQuery").value.trim());
    const st = encodeURIComponent($("fStatus").value);
    try {
      const r = await api("GET", "/api/admin/orders?page=" + ordersPage + "&pageSize=" + ORDERS_PAGE_SIZE + "&q=" + q + "&status=" + st);
      renderTable($("tblOrders"), orderColumns(true), r.items, "没有匹配的订单");
      renderPager($("pgOrders"), r.total, r.page, r.pageSize, (p) => loadOrders(p));
    } catch (e) {
      toast((e && e.message) || "加载订单失败", "err");
    }
  }
  $("btnSearch").addEventListener("click", () => loadOrders(1));
  $("fQuery").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadOrders(1);
  });
  $("fStatus").addEventListener("change", () => loadOrders(1));

  async function showOrderDetail(id) {
    try {
      const r = await api("GET", "/api/admin/orders/" + encodeURIComponent(id));
      const o = r.order;
      const lines = [
        ["订单号", o.id],
        ["账号", (o.nickname || "") + " @" + (o.username || "") + "（" + o.userId + "）"],
        ["金额", money(o.amountCents) + "（" + o.amountCents + " 分）"],
        ["状态", (ST_TEXT[o.status] || o.status) + (o.latePaid ? " · 过期后到账" : "")],
        ["渠道", o.channel],
        ["下单 / 过期", ts(o.createdAt) + " → " + ts(o.expiresAt)],
        ["支付时间", ts(o.paidAt)],
        ["实付", o.paidAmountCents ? money(o.paidAmountCents) : "—"],
        ["已退", o.refundedCents ? money(o.refundedCents) : "—"],
        ["支付宝交易号", o.tradeNo || "—"],
        ["买家ID", o.buyerId || "—"],
        ["入账来源", o.source || "—"],
        ["下单IP", o.clientIp || "—"],
        ["付款串", o.qrCode || "—"],
      ];
      const refunds = (o.refunds || []).map((x) => money(x.amountCents) + " · " + ts(x.at) + " · " + (x.operator || "") + " · " + (x.note || "")).join("\n");
      openDialog(
        "订单详情 " + o.id,
        [],
        async () => false, // 「关闭」即关窗
        "关闭",
      );
      const body = $("dlgBody");
      const dl = el("dl");
      dl.style.display = "grid";
      dl.style.gridTemplateColumns = "120px 1fr";
      dl.style.gap = "6px 12px";
      for (const [k, v] of lines) {
        dl.appendChild(el("dt", "muted", k));
        const dd = el("dd");
        dd.style.margin = "0";
        dd.style.wordBreak = "break-all";
        dd.textContent = v;
        dl.appendChild(dd);
      }
      body.appendChild(dl);
      if (refunds) {
        body.appendChild(el("div", "hint", "退款记录："));
        const pre = el("div", "mono wrap-cell", refunds);
        pre.style.whiteSpace = "pre-wrap";
        body.appendChild(pre);
      }
      body.appendChild(el("div", "hint", "关联流水（" + r.ledger.length + " 条）："));
      mountTable(body, ledgerColumns(false), r.ledger, "无");
      $("dlgCancel").classList.add("hidden");
    } catch (e) {
      toast((e && e.message) || "加载详情失败", "err");
    }
  }

  async function recheckOrder(id) {
    try {
      const r = await api("POST", "/api/admin/orders/" + encodeURIComponent(id) + "/recheck");
      const what = r.paid ? "已入账" : r.closed ? "支付宝侧已关闭" : r.unchanged ? "订单已是终态，无需补单" : "支付宝侧仍未支付（" + (r.tradeStatus || "WAIT_BUYER_PAY") + "）";
      toast("补单结果：" + what, r.paid ? "ok" : "");
      loadOrders(ordersPage);
    } catch (e) {
      toast("补单失败：" + ((e && e.message) || e), "err");
    }
  }

  function refundDialog(o) {
    const remain = (o.amountCents || 0) - (o.refundedCents || 0);
    openDialog(
      "退款 · " + o.id,
      [
        { kind: "note", text: "账号：" + (o.username || o.userId) + " · 订单金额 " + money(o.amountCents) + " · 可退 " + money(remain) + " · 退款会同步扣减该账号余额（余额不足会被拒绝）。" },
        { name: "yuan", label: "退款金额（元）", type: "number", value: (remain / 100).toFixed(2), required: true },
        { name: "note", label: "退款原因（必填，进流水审计）", type: "textarea", placeholder: "例如：用户申请退款 / 误充值", required: true },
      ],
      async (v) => {
        const cents = Math.round(Number(v.yuan) * 100);
        if (!Number.isFinite(cents) || cents <= 0) {
          toast("金额无效", "err");
          return true;
        }
        if (!v.note) {
          toast("必须填写退款原因", "err");
          return true;
        }
        if (cents > remain) {
          toast("超过可退金额 " + money(remain), "err");
          return true;
        }
        try {
          const r = await api("POST", "/api/admin/orders/" + encodeURIComponent(o.id) + "/refund", { amountCents: cents, note: v.note });
          toast(
            "退款成功：" + money(cents) + "（订单转 " + (ST_TEXT[r.order.status] || r.order.status) + "）" +
              (r.fundChange === "N" ? " · 支付宝返回 fund_change=N（可能是重复请求）" : ""),
            "ok",
          );
          loadOrders(ordersPage);
          return false;
        } catch (e) {
          toast("退款失败：" + ((e && e.message) || e), "err");
          return true;
        }
      },
      "确认退款",
    );
  }

  /* ---------- 用户 ---------- */

  let usersPage = 1;
  const USERS_PAGE_SIZE = 50;

  async function loadUsers(page) {
    usersPage = Math.max(1, page || 1);
    const q = encodeURIComponent($("fUserQuery").value.trim());
    try {
      const r = await api("GET", "/api/admin/users?page=" + usersPage + "&pageSize=" + USERS_PAGE_SIZE + "&q=" + q);
      renderTable(
        $("tblUsers"),
        [
          { title: "账号ID", cls: "mono", get: (u) => u.id },
          { title: "用户名", get: (u) => u.username || "—" },
          { title: "昵称", get: (u) => u.nickname || "—" },
          { title: "手机号", cls: "mono", get: (u) => u.phone || "—" },
          {
            title: "凭据",
            render: (td, u) => {
              const parts = [];
              if (u.wechatBound) parts.push("微信");
              if (u.phone) parts.push("手机");
              if (u.hasPassword) parts.push("密码");
              td.textContent = parts.length ? parts.join(" · ") : "—";
            },
          },
          { title: "余额", cls: "num", get: (u) => money(u.balanceCents) },
          {
            title: "身份",
            render: (td, u) => {
              td.appendChild(el("span", "badge " + (u.adminEligible ? "ok" : ""), u.adminEligible ? "管理员" : "普通用户"));
            },
          },
          { title: "注册时间", get: (u) => ts(u.createdAt) },
          {
            title: "操作",
            render: (td, u) => {
              const box = el("div", "actions");
              box.appendChild(actBtn("调账", () => adjustDialog(u)));
              box.appendChild(
                actBtn("看流水", () => {
                  $("fLedgerUser").value = u.id;
                  switchView("ledger");
                }),
              );
              td.appendChild(box);
            },
          },
        ],
        r.items,
        "没有匹配的账号",
      );
      renderPager($("pgUsers"), r.total, r.page, r.pageSize, (p) => loadUsers(p));
    } catch (e) {
      toast((e && e.message) || "加载用户失败", "err");
    }
  }
  $("btnUserSearch").addEventListener("click", () => loadUsers(1));
  $("fUserQuery").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadUsers(1);
  });

  function adjustDialog(u) {
    openDialog(
      "人工调账 · " + (u.username || u.id),
      [
        { kind: "note", text: "当前余额 " + money(u.balanceCents) + "。正数 = 赠送 / 补账，负数 = 扣减；扣减不得使余额为负。所有调账都会记入流水并留下操作人。" },
        { name: "yuan", label: "调账金额（元，可带负号）", type: "number", value: "0.00", required: true },
        { name: "note", label: "备注（必填，审计留痕）", type: "textarea", placeholder: "例如：活动赠送 / 线下已收款补账 / 误充退回", required: true },
      ],
      async (v) => {
        const cents = Math.round(Number(v.yuan) * 100);
        if (!Number.isFinite(cents) || cents === 0) {
          toast("金额无效（不得为 0）", "err");
          return true;
        }
        if (!v.note) {
          toast("必须填写备注", "err");
          return true;
        }
        try {
          const r = await api("POST", "/api/admin/users/" + encodeURIComponent(u.id) + "/adjust", { deltaCents: cents, note: v.note });
          toast("调账成功：新余额 " + money(r.balanceCents), "ok");
          loadUsers(usersPage);
          return false;
        } catch (e) {
          toast("调账失败：" + ((e && e.message) || e), "err");
          return true;
        }
      },
      "确认调账",
    );
  }

  /* ---------- 流水 ---------- */

  function ledgerColumns(withUser) {
    const cols = [];
    if (withUser !== false) cols.push({ title: "账号", get: (e) => (e.username ? e.username + "（" + e.userId + "）" : e.userId || "—") });
    cols.push(
      { title: "时间", get: (e) => ts(e.at) },
      {
        title: "类型",
        render: (td, e) => td.appendChild(el("span", "badge", (LEDGER_TEXT[e.type] || e.type))),
      },
      {
        title: "变动",
        cls: "num",
        render: (td, e) => {
          const n = el("span", e.deltaCents >= 0 ? "pos" : "neg", (e.deltaCents >= 0 ? "+" : "") + money(e.deltaCents));
          td.appendChild(n);
        },
      },
      { title: "变动后余额", cls: "num", get: (e) => money(e.balanceAfterCents) },
      { title: "订单号", cls: "mono", get: (e) => e.orderId || "—" },
      { title: "交易号", cls: "mono", get: (e) => e.tradeNo || "—" },
      { title: "操作人", get: (e) => e.operator || "—" },
      { title: "备注", cls: "wrap-cell", get: (e) => e.note || "—" },
    );
    return cols;
  }

  async function loadLedger() {
    const type = encodeURIComponent($("fLedgerType").value);
    const userId = encodeURIComponent($("fLedgerUser").value.trim());
    try {
      const r = await api("GET", "/api/admin/ledger?limit=200&type=" + type + "&userId=" + userId);
      renderTable($("tblLedger"), ledgerColumns(true), r.items, "没有匹配的流水");
    } catch (e) {
      toast((e && e.message) || "加载流水失败", "err");
    }
  }
  $("btnLedgerSearch").addEventListener("click", loadLedger);
  $("fLedgerType").addEventListener("change", loadLedger);
  $("fLedgerUser").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadLedger();
  });

  /* ---------- CSV 导出（带 Bearer，只能 fetch → blob 下载） ---------- */

  async function downloadCsv(kind) {
    try {
      const res = await fetch(API + "/api/admin/export.csv?kind=" + kind, { headers: { Authorization: "Bearer " + TOKEN } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mtnode-" + kind + "-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 2000);
      toast("已导出 " + kind + " CSV", "ok");
    } catch (e) {
      toast("导出失败：" + ((e && e.message) || e), "err");
    }
  }
  $("btnCsvOrders").addEventListener("click", () => downloadCsv("orders"));
  $("btnCsvLedger").addEventListener("click", () => downloadCsv("ledger"));

  /* ---------- 启动 ---------- */

  (async function boot() {
    if (!TOKEN) return showLogin();
    try {
      OV = await api("GET", "/api/admin/overview");
      // enterApp 内部已 switchView("overview") → loadOverview()，这里不要再调一次（会重复渲染）
      enterApp(OV.admin, 0);
    } catch (e) {
      if (!(e instanceof ApiError && (e.code === "ADMIN_UNAUTHORIZED" || e.code === "ADMIN_FORBIDDEN"))) {
        toast((e && e.message) || "加载失败", "err");
      }
      // 401/403 已在 api() 里 showLogin()
      if (!TOKEN) return;
      showLogin();
    }
  })();
})();

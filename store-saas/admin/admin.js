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
 *   · 金额一律「元」（服务端下发 4 位小数）展示；界面不做换算与算术决策（校验以服务端为准）。
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

  /* 金额一律「元」：服务端已按元下发（4 位小数），界面只做格式化，不做任何换算决策。 */
  const money = (yuan) => "¥" + Number(yuan || 0).toFixed(4);
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
  const LEDGER_TEXT = { recharge: "充值入账", refund: "退款", adjust: "人工调账", mismatch: "金额不符", relay: "中转扣费" };

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

  /* ==========================================================================
   * 中转服务（上游 / 模型 / 价目 / 会话测试 / 留痕 / 用量）
   *   · 配置保存走 POST /api/admin/relay/config，服务端校验 + 落 db.json + 热生效；
   *   · 界面拿到的上游永远不含 Key 明文（只有 keyFrom / keyTail）；
   *   · 会话测试发一张 mtr_test_ 短时 Key 打 /relay/v1/*，按真实用量扣当前管理员账号。
   * ========================================================================== */

  let RL = { config: null, audit: [], usage: [] };

  const KINDS = [["text", "文本"], ["image", "图像"]];
  const numOr0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const priceText = (m) => {
    const p = (m && m.price) || {};
    if (m.upstream === "image") return "¥" + numOr0(p.perImageYuan).toFixed(4) + " / 张";
    return "命中 " + numOr0(p.cacheHit) + " / 未命中 " + numOr0(p.cacheMiss) + " / 出 " + numOr0(p.output) +
      (numOr0(p.peakMultiplier) > 1 ? "（高峰 ×" + numOr0(p.peakMultiplier) + "）" : "") + " 元·百万";
  };
  const upstreamLabel = (id) => {
    const u = (RL.config && RL.config.upstreams || []).find((x) => x.id === id);
    return u ? u.name + "（" + u.id + "）" : (id || "（未绑定）");
  };

  async function loadRelay() {
    try {
      const r = await api("GET", "/api/admin/relay?audit=100&usage=100");
      RL = { config: r.config, audit: r.audit || [], usage: r.usage || [] };
    } catch (e) {
      toast((e && e.message) || "加载中转配置失败", "err");
      return;
    }
    paintRelay();
  }

  function paintRelay() {
    const c = RL.config || { upstreams: [], models: [] };
    const unset = c.upstreams.filter((u) => !u.keyFrom);
    $("rlMeta").textContent =
      "配置来源 " + (c.source === "db" ? "管理台（db.json）" : "默认 + 环境变量") +
      " · 上游 " + c.upstreams.length + " 个（" + (unset.length ? unset.length + " 个缺 Key" : "全部已配 Key") + "）" +
      " · 上架模型 " + c.models.filter((m) => m.enabled !== false).length + " / " + c.models.length +
      " · 计费单位 元（文本 元/百万 token · 图像 元/张）" +
      " · 模型端点 " + location.origin + (API ? new URL(API, location.origin).pathname : "") + "/relay/v1";

    renderTable($("tblRelayUp"), [
      { title: "上游 id", cls: "mono", get: (u) => u.id },
      { title: "名称", get: (u) => u.name },
      { title: "通道", get: (u) => ((KINDS.find((k) => k[0] === u.kind) || [])[1] || u.kind) },
      { title: "Base URL", get: (u) => u.base || "（空：会拒保存）" },
      { title: "Key", render: (td, u) => {
        if (!u.keyFrom) { td.appendChild(el("span", "badge bad", "未配")); return; }
        td.appendChild(el("span", "badge ok", (u.keyFrom === "db" ? "库内" : "env") + " · …" + (u.keyTail || "----")));
      } },
      { title: "超时(s)", get: (u) => Math.round(numOr0(u.timeoutMs) / 1000) },
      { title: "启用", render: (td, u) => td.appendChild(el("span", "badge " + (u.enabled !== false ? "ok" : "bad"), u.enabled !== false ? "启用" : "停用")) },
      { title: "模型数", get: (u) => (u.models || []).length },
      { title: "操作", render: (td, u) => {
        const box = el("div", "actions");
        const edit = el("button", "btn btn-sm", "编辑");
        edit.addEventListener("click", () => editUpstream(u));
        const pull = el("button", "btn btn-sm", "拉取候选");
        pull.addEventListener("click", () => pullUpstreamModels(u));
        const del = el("button", "btn btn-sm btn-danger", "删除");
        del.addEventListener("click", () => {
          if (!confirm("删除上游 " + u.id + "？绑定它的模型会一起失去上游（保存时会被校验拦住）。")) return;
          RL.config.upstreams = RL.config.upstreams.filter((x) => x.id !== u.id);
          paintRelay();
          toast("已从待保存的配置里删掉 " + u.id + "，点「保存配置并热生效」生效", "warn");
        });
        box.appendChild(edit); box.appendChild(pull); box.appendChild(del);
        td.appendChild(box);
      } },
    ], c.upstreams, "还没有上游");

    renderTable($("tblRelayModels"), [
      { title: "启用", render: (td, m) => {
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = m.enabled !== false;
        cb.addEventListener("change", () => { m.enabled = cb.checked; paintRelay(); });
        td.appendChild(cb);
      } },
      { title: "模型 id", cls: "mono", get: (m) => m.id },
      { title: "通道", get: (m) => ((KINDS.find((k) => k[0] === m.upstream) || [])[1] || m.upstream) },
      { title: "绑定上游", get: (m) => upstreamLabel(m.upstreamId) },
      { title: "上游模型名", cls: "mono", get: (m) => m.upstreamModel },
      { title: "价目", get: (m) => priceText(m) + (m.priceDefault ? "（默认）" : "") },
      { title: "操作", render: (td, m) => {
        const box = el("div", "actions");
        const edit = el("button", "btn btn-sm", "编辑");
        edit.addEventListener("click", () => editModel(m));
        const del = el("button", "btn btn-sm btn-danger", "删除");
        del.addEventListener("click", () => {
          if (!confirm("删除模型 " + m.id + "？保存后客户端立刻拉不到它。")) return;
          RL.config.models = RL.config.models.filter((x) => x !== m);
          paintRelay();
        });
        box.appendChild(edit); box.appendChild(del);
        td.appendChild(box);
      } },
    ], c.models, "还没有模型（客户端会拉不到任何模型）");

    renderTable($("tblRelayAudit"), [
      { title: "时间", get: (r) => ts(r.at) },
      { title: "管理员", get: (r) => r.username || r.userId },
      { title: "动作", get: (r) => r.action },
      { title: "改动", cls: "wrap-cell", get: (r) => (r.changes || []).join("；") || "（无字段级差异）" },
    ], RL.audit, "还没有改动记录");

    renderTable($("tblRelayUsage"), [
      { title: "时间", get: (r) => ts(r.at) },
      { title: "账号", get: (r) => r.username || r.userId },
      { title: "模型", cls: "mono", get: (r) => r.model },
      { title: "类型", get: (r) => (r.kind === "image" ? "图像 ×" + (r.images || 1) : "文本") },
      { title: "入 / 出 tokens", cls: "num", get: (r) => (r.kind === "image" ? "—" : numOr0(r.promptTokens) + " / " + numOr0(r.outputTokens)) },
      { title: "应扣(元)", cls: "num", get: (r) => numOr0(r.costYuan).toFixed(4) },
      { title: "实扣(元)", cls: "num", get: (r) => numOr0(r.chargedYuan).toFixed(4) + (numOr0(r.shortfallYuan) ? "（欠 " + numOr0(r.shortfallYuan).toFixed(4) + "）" : "") },
      { title: "耗时(ms)", cls: "num", get: (r) => numOr0(r.ms) },
    ], RL.usage, "还没有调用记录");

    const sel = $("rlTestModel");
    const keep = sel.value;
    sel.textContent = "";
    for (const m of c.models.filter((x) => x.enabled !== false)) {
      const o = el("option", "", m.id + (m.upstream === "image" ? "（图像）" : ""));
      o.value = m.id;
      sel.appendChild(o);
    }
    if (keep) sel.value = keep;
    $("rlTestBalance").textContent = RL.balanceText || "";
  }

  /** 字段编辑器：返回 {row, inputs}，确定时按 inputs 取值。 */
  function fieldRow(parent, label, value, placeholder, type) {
    const lab = el("label", "", label);
    const inp = el("input");
    inp.type = type || "text";
    if (value != null) inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
    lab.appendChild(inp);
    parent.appendChild(lab);
    return inp;
  }

  function editUpstream(u) {
    const isNew = !u;
    const row = u || { id: "", name: "", kind: "text", base: "", timeoutMs: 300000, enabled: true, keyFrom: "" };
    const body = document.createDocumentFragment();
    const idInp = fieldRow(body, "上游 id（小写字母 / 数字 / - _ .）", row.id, "deepseek", "text");
    const nameInp = fieldRow(body, "名称", row.name, "DeepSeek");
    const kindLab = el("label", "", "通道");
    const kindSel = el("select");
    for (const [v, t] of KINDS) {
      const o = el("option", "", t);
      o.value = v;
      kindSel.appendChild(o);
    }
    kindSel.value = row.kind;
    kindLab.appendChild(kindSel);
    body.appendChild(kindLab);
    const baseInp = fieldRow(body, "Base URL（不含 /chat/completions）", row.base, "https://api.deepseek.com");
    const keyInp = fieldRow(body, "API Key" + (row.keyFrom ? "（当前 " + (row.keyFrom === "db" ? "库内" : "env") + " · …" + (row.keyTail || "") + "，留空即不改）" : ""), "", "sk-…");
    const toInp = fieldRow(body, "超时（毫秒）", String(row.timeoutMs || 300000), "300000", "number");
    const note = el("div", "hint", "Key 明文不会回传页面：留空 = 保持不变，重填 = 覆盖成新 Key。");
    body.appendChild(note);
    openDialog(isNew ? "添加上游" : "编辑上游 " + row.id, [{ kind: "note", text: "" }], null);
    // openDialog 的字段表只支持简单输入，这里直接把自定义 DOM 换进 dlgBody
    const dbody = $("dlgBody");
    dbody.textContent = "";
    dbody.appendChild(body);
    dlgOk = async () => {
      const id = idInp.value.trim().toLowerCase();
      if (!id) return void toast("上游 id 不能为空", "err");
      const next = {
        id: id,
        name: nameInp.value.trim() || id,
        kind: kindSel.value,
        base: baseInp.value.trim(),
        timeoutMs: Number(toInp.value) || 300000,
        enabled: row.enabled !== false,
      };
      const key = keyInp.value.trim();
      if (key) next.key = key;
      const list = RL.config.upstreams;
      const i = list.findIndex((x) => x.id === row.id);
      if (isNew) {
        if (list.some((x) => x.id === id)) return void toast("上游 id 已存在：" + id, "err");
        list.push(next);
      } else if (i >= 0) {
        list[i] = Object.assign({}, list[i], next);
      }
      if (key) {
        const t = next.id;
        const item = list.find((x) => x.id === t);
        if (item) item.__newKey = key; // 只在本次编辑里带着明文，保存后由服务端落库
      }
      closeDialog();
      paintRelay();
      toast("已加入待保存配置，点「保存配置并热生效」生效", "warn");
    };
  }

  function editModel(m) {
    const isNew = !m;
    const row = m || { id: "", upstream: "text", upstreamId: "", upstreamModel: "", enabled: true, price: {} };
    const body = document.createDocumentFragment();
    const idInp = fieldRow(body, "模型 id（客户端看到的名字）", row.id, "deepseek-flash");
    const kindLab = el("label", "", "通道");
    const kindSel = el("select");
    for (const [v, t] of KINDS) {
      const o = el("option", "", t);
      o.value = v;
      kindSel.appendChild(o);
    }
    kindSel.value = row.upstream;
    kindLab.appendChild(kindSel);
    body.appendChild(kindLab);
    const upLab = el("label", "", "绑定上游");
    const upSel = el("select");
    for (const u of RL.config.upstreams) {
      const o = el("option", "", u.name + "（" + u.id + " · " + u.kind + "）");
      o.value = u.id;
      upSel.appendChild(o);
    }
    upSel.value = row.upstreamId || ((RL.config.upstreams[0] || {}).id || "");
    upLab.appendChild(upSel);
    body.appendChild(upLab);
    const upModelInp = fieldRow(body, "上游模型名（原样透传给上游）", row.upstreamModel, "deepseek-flash");
    const p = row.price || {};
    const priceBox = el("div", "hint", "");
    body.appendChild(priceBox);
    const priceInputs = {};
    const paintPrice = () => {
      priceBox.textContent = "";
      const isImg = kindSel.value === "image";
      for (const k of Object.keys(priceInputs)) delete priceInputs[k];
      // 清掉上一次的价格行
      for (const n of Array.from(priceBox.parentNode.querySelectorAll("label.rl-price"))) n.remove();
      const mk2 = (label, key, val) => {
        const lab = el("label", "rl-price", label);
        const inp = el("input");
        inp.type = "number";
        inp.step = "0.0001";
        inp.value = String(val == null ? 0 : val);
        lab.appendChild(inp);
        priceBox.parentNode.insertBefore(lab, priceBox);
        priceInputs[key] = inp;
      };
      if (isImg) {
        mk2("图像单价（元 / 张）", "perImageYuan", p.perImageYuan);
        priceBox.textContent = "图像按「张数 × 元/张」计费（每次调用即计费，与尺寸无关）；价目一律按元。";
      } else {
        mk2("缓存命中（元 / 百万 tokens）", "cacheHit", p.cacheHit);
        mk2("缓存未命中（元 / 百万）", "cacheMiss", p.cacheMiss);
        mk2("输出（元 / 百万）", "output", p.output);
        mk2("高峰倍率（1 = 不加成）", "peakMultiplier", p.peakMultiplier == null ? 1 : p.peakMultiplier);
        priceBox.textContent = "文本按上游回的 usage 计费；DeepSeek 高峰时段按倍率加成。";
      }
    };
    kindSel.addEventListener("change", paintPrice);
    paintPrice();
    openDialog(isNew ? "添加模型" : "编辑模型 " + row.id, [{ kind: "note", text: "" }], null);
    const dbody = $("dlgBody");
    dbody.textContent = "";
    dbody.appendChild(body);
    dlgOk = async () => {
      const id = idInp.value.trim();
      if (!id) return void toast("模型 id 不能为空", "err");
      const price = {};
      for (const k of Object.keys(priceInputs)) price[k] = numOr0(priceInputs[k].value);
      const next = {
        id: id,
        upstream: kindSel.value,
        upstreamId: upSel.value,
        upstreamModel: upModelInp.value.trim() || id,
        enabled: row.enabled !== false,
        price: price,
      };
      const list = RL.config.models;
      const i = list.findIndex((x) => x.id === row.id);
      if (isNew) {
        if (list.some((x) => x.id === id)) return void toast("模型 id 已存在：" + id, "err");
        list.push(next);
      } else if (i >= 0) {
        list[i] = Object.assign({}, list[i], next);
      }
      closeDialog();
      paintRelay();
      toast("已加入待保存配置，点「保存配置并热生效」生效", "warn");
    };
  }

  async function pullUpstreamModels(u) {
    try {
      const r = await api("POST", "/api/admin/relay/upstream-models", { upstreamId: u.id });
      if (!r.items || !r.items.length) return void toast("上游 /models 没回任何模型", "warn");
      showPullDialog(u, r.items);
    } catch (e) {
      toast((e && e.message) || "拉取候选失败", "err");
    }
  }

  function showPullDialog(u, items) {
    const body = el("div", "dlg-body");
    body.appendChild(el("div", "hint", "上游 " + u.id + " 回 " + items.length + " 个模型；勾选要上架的，导入后再逐个改「上游模型名 / 价目」。"));
    const boxes = [];
    for (const it of items) {
      const lab = el("label", "", (it.added ? "（已在列表）" : "") + it.id);
      const cb = el("input");
      cb.type = "checkbox";
      cb.value = it.id;
      lab.insertBefore(cb, lab.firstChild);
      body.appendChild(lab);
      boxes.push(cb);
    }
    openDialog("从上游导入模型 · " + u.id, [{ kind: "note", text: "" }], null, "导入勾选项");
    const d = $("dlgBody");
    d.textContent = "";
    d.appendChild(body);
    dlgOk = async () => {
      const picked = boxes.filter((b) => b.checked && !/已在列表/.test(b.parentNode.textContent));
      if (!picked.length) return void toast("没有勾选新的模型", "warn");
      for (const b of picked) {
        RL.config.models.push({
          id: b.value,
          upstream: u.kind,
          upstreamId: u.id,
          upstreamModel: b.value,
          enabled: false, // 先下架状态进列表：价目还没填，避免带着 0 价上线白送
          price: u.kind === "image" ? { perImageYuan: 0 } : { cacheHit: 0, cacheMiss: 0, output: 0, peakMultiplier: 1 },
        });
      }
      closeDialog();
      paintRelay();
      toast("已导入 " + picked.length + " 个模型（默认「下架」，填好价目再勾启用）", "warn");
    };
  }

  function collectRelayDoc() {
    return {
      upstreams: RL.config.upstreams.map((u) => {
        const o = {
          id: u.id, name: u.name, kind: u.kind, base: u.base, timeoutMs: u.timeoutMs,
          enabled: u.enabled !== false,
        };
        // 只有真正新填的 Key 才回传；界面没拿到过明文，所以留空 = 服务端保持原 Key
        if (u.__newKey) o.key = u.__newKey;
        return o;
      }),
      models: RL.config.models.map((m) => ({
        id: m.id, upstream: m.upstream, upstreamId: m.upstreamId, upstreamModel: m.upstreamModel,
        enabled: m.enabled !== false, price: m.price || {},
      })),
      quota: RL.config.quota,
      peaks: RL.config.peaks,
    };
  }

  $("btnRelayReload").addEventListener("click", loadRelay);
  $("btnRelaySave").addEventListener("click", async () => {
    const btn = $("btnRelaySave");
    btn.disabled = true;
    try {
      const r = await api("POST", "/api/admin/relay/config", { config: collectRelayDoc() });
      RL.config = r.config;
      paintRelay();
      toast(r.changed ? "已保存并热生效（客户端下次刷新即拿到新列表）" : "配置没有变化", "ok");
      loadRelay();
    } catch (e) {
      toast((e && e.message) || "保存失败", "err");
    } finally {
      btn.disabled = false;
    }
  });
  $("btnRelayAddUp").addEventListener("click", () => editUpstream(null));
  $("btnRelayAddModel").addEventListener("click", () => editModel(null));

  /** 会话测试：发一张短时 Key，打 /relay/v1/*，结果与扣费额度都留在页面上。 */
  $("btnRelayTest").addEventListener("click", async () => {
    const btn = $("btnRelayTest");
    const modelId = $("rlTestModel").value;
    const prompt = $("rlTestPrompt").value.trim() || "只回一句「中转正常」";
    const stream = $("rlTestStream").checked;
    if (!modelId) return void toast("先在模型列表里上架一个模型", "err");
    const m = (RL.config.models || []).find((x) => x.id === modelId) || {};
    const isImg = m.upstream === "image";
    btn.disabled = true;
    $("rlTestOut").textContent = "";
    $("rlTestStatus").textContent = "正在发测试 Key…";
    const t0 = Date.now();
    try {
      const k = await api("POST", "/api/admin/relay/test-key", {});
      const base = (API || "") + "/relay/v1";
      const path = isImg ? "/images/generations" : "/chat/completions";
      const body = isImg
        ? { model: modelId, prompt: prompt, size: "1024x1024" }
        : { model: modelId, stream: stream, messages: [{ role: "user", content: prompt }] };
      $("rlTestStatus").textContent = "测试 Key 就绪（" + Math.round(k.expiresInSec / 60) + " 分钟有效）· 正在请求 " + modelId + " …";
      const res = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + k.token },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const ms = Date.now() - t0;
      $("rlTestOut").textContent = text.length > 6000 ? text.slice(0, 6000) + "\n…（已截断）" : text;
      let usage = null;
      try {
        usage = (JSON.parse(text) || {}).usage || null;
      } catch {
        const hit = /"usage"\s*:\s*(\{[^}]*\})/.exec(text);
        if (hit) {
          try { usage = JSON.parse(hit[1]); } catch { usage = null; }
        }
      }
      $("rlTestStatus").textContent =
        "HTTP " + res.status + " · " + ms + "ms · 模型 " + modelId + "（" + (isImg ? "图像" : "文本") + "）" +
        (usage ? " · usage " + JSON.stringify(usage) : "") +
        " · 按真实用量从管理员账号扣费，可在下面「最近调用明细」里核对实扣";
      if (res.ok) toast("测试通过：" + modelId, "ok");
      else toast("测试失败 HTTP " + res.status + "（错误体见下方输出）", "err");
      // 测试完刷新明细，让「扣了多少」当场可核
      const r = await api("GET", "/api/admin/relay?audit=100&usage=100");
      RL.config = r.config;
      RL.audit = r.audit || [];
      RL.usage = r.usage || [];
      const me = RL.usage.filter((x) => x.at >= t0 - 2000);
      if (me.length) {
        const charged = me.reduce((s, x) => s + numOr0(x.chargedYuan), 0);
        $("rlTestStatus").textContent += " · 本次实扣 " + Number(charged.toFixed(4)) + " 元";
      }
      paintRelay();
      $("rlTestBalance").textContent = "管理员账号余额 " + money(k.totalYuan) + "（" + Number(k.totalYuan).toFixed(4) + " 元）";
    } catch (e) {
      $("rlTestStatus").textContent = "测试失败：" + ((e && e.message) || e);
      toast((e && e.message) || "测试失败", "err");
    } finally {
      btn.disabled = false;
    }
  });

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
    if (name === "relay") loadRelay();
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
      ["已收款", money(s.paidYuan), "money"],
      ["已退款", money(s.refundedYuan), "money"],
      ["净入账", money(s.netYuan), "money"],
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
      ["充值区间", money(OV.config && OV.config.minYuan) + " – " + money(OV.config && OV.config.maxYuan)],
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
      { title: "金额", cls: "num", get: (r) => money(r.amountYuan) },
      {
        title: "状态",
        render: (td, r) => {
          td.appendChild(el("span", "st " + stClass(r.status), (ST_TEXT[r.status] || r.status)));
          if (r.latePaid) td.appendChild(el("span", "badge warn", "过期后到账"));
        },
      },
      { title: "下单时间", get: (r) => ts(r.createdAt) },
      { title: "支付时间", get: (r) => ts(r.paidAt) },
      { title: "已退", cls: "num", get: (r) => (r.refundedYuan ? money(r.refundedYuan) : "—") },
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
        ["金额", money(o.amountYuan) + "（" + Number(o.amountYuan).toFixed(4) + " 元）"],
        ["状态", (ST_TEXT[o.status] || o.status) + (o.latePaid ? " · 过期后到账" : "")],
        ["渠道", o.channel],
        ["下单 / 过期", ts(o.createdAt) + " → " + ts(o.expiresAt)],
        ["支付时间", ts(o.paidAt)],
        ["实付", o.paidAmountYuan ? money(o.paidAmountYuan) : "—"],
        ["已退", o.refundedYuan ? money(o.refundedYuan) : "—"],
        ["支付宝交易号", o.tradeNo || "—"],
        ["买家ID", o.buyerId || "—"],
        ["入账来源", o.source || "—"],
        ["下单IP", o.clientIp || "—"],
        ["付款串", o.qrCode || "—"],
      ];
      const refunds = (o.refunds || []).map((x) => money(x.amountYuan) + " · " + ts(x.at) + " · " + (x.operator || "") + " · " + (x.note || "")).join("\n");
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
    const remain = Number(((o.amountYuan || 0) - (o.refundedYuan || 0)).toFixed(4));
    openDialog(
      "退款 · " + o.id,
      [
        { kind: "note", text: "账号：" + (o.username || o.userId) + " · 订单金额 " + money(o.amountYuan) + " · 可退 " + money(remain) + " · 退款会同步扣减该账号余额（余额不足会被拒绝）。" },
        { name: "yuan", label: "退款金额（元）", type: "number", value: remain.toFixed(4), required: true },
        { name: "note", label: "退款原因（必填，进流水审计）", type: "textarea", placeholder: "例如：用户申请退款 / 误充值", required: true },
      ],
      async (v) => {
        const yuanAmt = Number(v.yuan);
        if (!Number.isFinite(yuanAmt) || yuanAmt <= 0) {
          toast("金额无效", "err");
          return true;
        }
        if (!v.note) {
          toast("必须填写退款原因", "err");
          return true;
        }
        if (yuanAmt > remain) {
          toast("超过可退金额 " + money(remain), "err");
          return true;
        }
        try {
          const r = await api("POST", "/api/admin/orders/" + encodeURIComponent(o.id) + "/refund", { amountYuan: yuanAmt, note: v.note });
          toast(
            "退款成功：" + money(yuanAmt) + "（订单转 " + (ST_TEXT[r.order.status] || r.order.status) + "）" +
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
          { title: "余额", cls: "num", get: (u) => money(u.balanceYuan) },
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
        { kind: "note", text: "当前余额 " + money(u.balanceYuan) + "。正数 = 赠送 / 补账，负数 = 扣减；扣减不得使余额为负。所有调账都会记入流水并留下操作人。" },
        { name: "yuan", label: "调账金额（元，可带负号）", type: "number", value: "0.0000", required: true },
        { name: "note", label: "备注（必填，审计留痕）", type: "textarea", placeholder: "例如：活动赠送 / 线下已收款补账 / 误充退回", required: true },
      ],
      async (v) => {
        const yuanAmt = Number(v.yuan);
        if (!Number.isFinite(yuanAmt) || yuanAmt === 0) {
          toast("金额无效（不得为 0）", "err");
          return true;
        }
        if (!v.note) {
          toast("必须填写备注", "err");
          return true;
        }
        try {
          const r = await api("POST", "/api/admin/users/" + encodeURIComponent(u.id) + "/adjust", { deltaYuan: yuanAmt, note: v.note });
          toast("调账成功：新余额 " + money(r.balanceYuan), "ok");
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
          const n = el("span", e.deltaYuan >= 0 ? "pos" : "neg", (e.deltaYuan >= 0 ? "+" : "") + money(e.deltaYuan));
          td.appendChild(n);
        },
      },
      { title: "变动后余额", cls: "num", get: (e) => money(e.balanceAfterYuan) },
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

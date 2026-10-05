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
  const LEDGER_TEXT = { recharge: "充值入账", refund: "退款", adjust: "人工调账", mismatch: "金额不符", relay: "中转扣费", tip_out: "打赏转出", tip_in: "打赏转入", tip_revoke_out: "撤销扣回", tip_revoke_in: "撤销退回" };
  /** 打赏对象类型（服务端 /api/admin/tips 回的 targetKind 是英文枚举，界面显示中文）。 */
  const TIP_KIND_TEXT = { template: "模板", skill: "技能", app: "应用", forum_topic: "论坛话题", forum_reply: "论坛回复" };

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
      if (f.type === "file") {
        inp.type = "file";
        if (f.accept) inp.accept = f.accept;
      } else if (f.type !== "textarea") inp.type = f.type || "text";
      if (f.value != null) inp.value = f.value;
      if (f.placeholder) inp.placeholder = f.placeholder;
      if (f.type === "textarea") inp.rows = 3;
      if (f.required) inp.required = true;
      lab.appendChild(inp);
      body.appendChild(lab);
      inputs[f.name] = inp;
    }
    $("dlgOk").classList.remove("hidden");
    $("dlgCancel").classList.remove("hidden");
    $("dlgCancel").textContent = "取消";
    $("dlgOk").textContent = okText || "确定";
    $("dlg").classList.remove("hidden");
    const first = Object.values(inputs)[0];
    if (first) first.focus();
    dlgOk = async () => {
      const vals = {};
      const files = {};
      for (const k of Object.keys(inputs)) {
        if (inputs[k].type === "file") {
          vals[k] = "";
          files[k] = (inputs[k].files && inputs[k].files[0]) || null;
        } else vals[k] = inputs[k].value.trim();
      }
      $("dlgOk").disabled = true;
      try {
        /* 文件字段：选中的文件读成 data URL（base64）再交给 onOk；没选就保持空串。 */
        for (const k of Object.keys(files)) {
          if (files[k]) vals[k] = await readFileBase64(files[k]);
        }
        const keepOpen = await onOk(vals);
        if (!keepOpen) closeDialog();
      } catch (e) {
        toast((e && e.message) || "操作失败", "err");
      } finally {
        $("dlgOk").disabled = false;
      }
    };
  }
  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("读取文件失败"));
      fr.readAsDataURL(file);
    });
  }
  /** 纯自定义弹窗（版本历史 / 技能包文件这类要放按钮的）：mount 自己往 #dlgBody 里挂东西。 */
  function openRawDialog(title, mount, okText, onOk) {
    $("dlgTitle").textContent = title;
    const body = $("dlgBody");
    body.textContent = "";
    mount(body);
    $("dlgOk").classList.toggle("hidden", !onOk);
    $("dlgOk").textContent = okText || "关闭";
    $("dlgCancel").classList.remove("hidden");
    $("dlgCancel").textContent = onOk ? "取消" : "关闭";
    $("dlg").classList.remove("hidden");
    dlgOk = onOk || null;
  }
  function closeDialog() {
    $("dlg").classList.add("hidden");
    $("dlgCancel").classList.remove("hidden"); // 详情弹窗会藏掉「取消」，关闭时统一复位
    $("dlgOk").classList.remove("hidden");
    $("dlgCancel").textContent = "取消";
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
   * 中转服务（页内二级页签：调用流水 · 配置 · 会话测试 · 改动留痕）
   *   · 不再把五块内容堆在同一页上：「调用流水」是默认页签（统计卡片 + 筛选 + 明细）；
   *   · 配置保存走 POST /api/admin/relay/config，服务端校验 + 落 db.json + 热生效；
   *   · 界面拿到的上游永远不含 Key 明文（只有 keyFrom / keyTail）；
   *   · 会话测试发一张 mtr_test_ 短时 Key 打 /relay/v1/*，按真实用量扣当前管理员账号；
   *   · 调用流水的筛选与统计走 GET /api/admin/relay/usage（服务端只读聚合，见 relay.mjs 的 usageQuery）：
   *     relayUsage 全局保留有上限，前端按明细自己加出来的窗口合计会在忙时偏小，所以统计在服务端算。
   * ========================================================================== */

  let RL = { config: null, audit: [], usage: [], usageMeta: null };

  /* ---------- 二级页签（默认停在「调用流水」） ---------- */

  const RL_SUBS = ["usage", "config", "test", "audit"];
  let relaySub = "usage";

  function showRelaySub(name) {
    const want = RL_SUBS.includes(name) ? name : "usage";
    relaySub = want;
    for (const b of document.querySelectorAll("#relaySubtabs .subtab")) b.classList.toggle("active", b.dataset.sub === want);
    for (const v of document.querySelectorAll(".subview")) v.classList.toggle("hidden", v.id !== "sub-" + want);
  }
  for (const b of document.querySelectorAll("#relaySubtabs .subtab")) {
    b.addEventListener("click", () => showRelaySub(b.dataset.sub));
  }

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
      const r = await api("GET", "/api/admin/relay?audit=100");
      RL.config = r.config;
      RL.audit = r.audit || [];
    } catch (e) {
      toast((e && e.message) || "加载中转配置失败", "err");
      return;
    }
    paintRelay();
  }

  /* ---------- 调用流水：筛选 + 统计（GET /api/admin/relay/usage，一次回明细 + 三档合计） ---------- */

  const USAGE_LIMIT = 1000; // 与 relay.mjs 的 USAGE_QUERY_MAX 同值（服务端会夹紧，界面按返回的 limit 标注）
  const USAGE_DEFAULT_WINDOW = "7d";

  const fmtNum = (n) => String(Math.round(numOr0(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fmtTok = (n) => {
    const v = numOr0(n);
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(v);
  };

  /** 当前时间窗口：取下拉值，空则回落默认「近 7 天」（HTML 上也是 selected，这里是兜底）。 */
  const usageWindowValue = () => $("fUsageWindow").value || USAGE_DEFAULT_WINDOW;

  /** 筛选 → 查询串（时间窗口 / 类型 / 模型 / 账号 / 条数上限）。 */
  function usageQueryString() {
    const q = new URLSearchParams();
    q.set("window", usageWindowValue());
    q.set("kind", $("fUsageKind").value || "");
    q.set("model", $("fUsageModel").value || "");
    q.set("userId", $("fUsageUser").value.trim());
    q.set("limit", String(USAGE_LIMIT));
    return q.toString();
  }

  async function loadUsage() {
    try {
      const r = await api("GET", "/api/admin/relay/usage?" + usageQueryString());
      RL.usage = r.items || [];
      RL.usageMeta = r;
    } catch (e) {
      toast((e && e.message) || "加载调用流水失败", "err");
      return;
    }
    paintUsageModels();
    paintUsage();
  }

  /** 模型下拉：当前上架清单 ∪ 明细里出现过的模型（历史记录里的下架模型也要能筛）。 */
  function paintUsageModels() {
    const sel = $("fUsageModel");
    const keep = sel.value;
    const ids = [];
    for (const m of (RL.config && RL.config.models) || []) if (m && m.id) ids.push(m.id);
    for (const m of (RL.usageMeta && RL.usageMeta.models) || []) if (m) ids.push(m);
    sel.textContent = "";
    const all = el("option", "", "全部模型");
    all.value = "";
    sel.appendChild(all);
    for (const id of Array.from(new Set(ids)).sort()) {
      const o = el("option", "", id);
      o.value = id;
      sel.appendChild(o);
    }
    sel.value = keep && ids.includes(keep) ? keep : "";
  }

  function paintUsage() {
    const meta = RL.usageMeta || {};
    const scope = meta.scope || {};
    const cur = usageWindowValue();

    /* 三张窗口卡片（今日 / 近 7 天 / 近 30 天）：全站口径，点一张 = 把下面明细也收窄到该窗口。 */
    const box = $("rlStatCards");
    box.textContent = "";
    for (const w of meta.windows || []) {
      const c = el("div", "card card-click" + (w.key === cur ? " on" : ""));
      c.title = "点一下：统计与明细都切到「" + w.label + "」";
      c.appendChild(el("div", "k", w.label + "（全站）"));
      c.appendChild(el("div", "v money", money(w.chargedYuan)));
      c.appendChild(el("div", "card-line", "调用 " + fmtNum(w.calls) + " 次 · 文本 " + fmtNum(w.textCalls) + " / 图像 " + fmtNum(w.imageCalls) +
        (numOr0(w.images) ? "（" + fmtNum(w.images) + " 张）" : "")));
      c.appendChild(el("div", "card-line muted", "tokens 入 " + fmtTok(w.promptTokens) + " · 出 " + fmtTok(w.outputTokens)));
      c.appendChild(el("div", "card-line muted", "未计费 " + fmtNum(w.unbilled) + " 次" +
        (numOr0(w.shortfallYuan) > 0 ? " · 欠费未计 " + money(w.shortfallYuan) : "")));
      c.addEventListener("click", () => {
        $("fUsageWindow").value = w.key;
        loadUsage();
      });
      box.appendChild(c);
    }
    $("rlStatHint").textContent =
      "卡片是「全站」口径（不受下面筛选影响）；数字为「实扣」（真正从余额扣到的钱），欠费差额另列。" +
      "「未计费」= 实扣为 0 的那几次（余额不足被夹紧 / 零费用）；上游没回 usage 的请求不写用量记录，" +
      "所以不在统计里（服务端只记日志）。时间窗口按服务器本地时区的自然日。";

    /* 明细上方的合计：本次筛选口径（含窗口 + 类型 + 模型 + 账号）与条数。 */
    const shown = (meta.items || []).length;
    let t = "命中 " + fmtNum(meta.matched) + " 条";
    if (meta.matched > shown) {
      t += "（下面显示最近 " + fmtNum(shown) + " 条，上限 " + fmtNum(meta.limit) + " 条；" +
        (cur === "all" ? "请用类型 / 模型 / 账号筛选继续收窄" : "要更早的请收窄时间范围") + "）";
    }
    t += " · 本次筛选合计 " + fmtNum(scope.calls) + " 次（文本 " + fmtNum(scope.textCalls) + " / 图像 " + fmtNum(scope.imageCalls) + "）" +
      " · 实扣 " + money(scope.chargedYuan) +
      " · tokens 入 " + fmtNum(scope.promptTokens) + " / 出 " + fmtNum(scope.outputTokens) +
      (numOr0(scope.unbilled) ? " · 未计费 " + fmtNum(scope.unbilled) + " 次" : "") +
      (numOr0(scope.shortfallYuan) > 0 ? " · 欠费未计 " + money(scope.shortfallYuan) : "");
    $("rlUsageMeta").textContent = t;

    renderTable($("tblRelayUsage"), [
      { title: "时间", get: (r) => ts(r.at) },
      { title: "账号", get: (r) => r.username || r.userId },
      { title: "模型", cls: "mono", get: (r) => r.model },
      { title: "类型", render: (td, r) => td.appendChild(el("span", "badge", r.kind === "image" ? "图像 ×" + (r.images || 1) : "文本")) },
      { title: "入 / 出 tokens", cls: "num", get: (r) => (r.kind === "image" ? "—" : fmtNum(r.promptTokens) + " / " + fmtNum(r.outputTokens)) },
      { title: "应扣(元)", cls: "num", get: (r) => numOr0(r.costYuan).toFixed(4) },
      {
        title: "实扣(元)",
        cls: "num",
        render: (td, r) => {
          const charged = numOr0(r.chargedYuan);
          const short = numOr0(r.shortfallYuan);
          td.appendChild(el("div", charged > 0 ? "" : "muted", charged.toFixed(4) + (charged > 0 ? "" : "（未计费）")));
          if (short > 0) td.appendChild(el("div", "neg", "欠 " + short.toFixed(4)));
        },
      },
      { title: "耗时(ms)", cls: "num", get: (r) => fmtNum(r.ms) },
    ], RL.usage, "没有匹配的调用记录");
  }

  $("fUsageWindow").addEventListener("change", loadUsage);
  $("fUsageKind").addEventListener("change", loadUsage);
  $("fUsageModel").addEventListener("change", loadUsage);
  $("btnUsageSearch").addEventListener("click", loadUsage);
  $("btnUsageReload").addEventListener("click", loadUsage);
  $("fUsageUser").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadUsage();
  });
  $("btnUsageReset").addEventListener("click", () => {
    $("fUsageWindow").value = USAGE_DEFAULT_WINDOW;
    $("fUsageKind").value = "";
    $("fUsageModel").value = "";
    $("fUsageUser").value = "";
    loadUsage();
  });

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
        " · 按真实用量从管理员账号扣费，可在「调用流水」页里核对实扣";
      if (res.ok) toast("测试通过：" + modelId, "ok");
      else toast("测试失败 HTTP " + res.status + "（错误体见下方输出）", "err");
      // 测试完刷新明细，让「扣了多少」当场可核（统计与明细都在「调用流水」页）
      await loadUsage();
      const me = RL.usage.filter((x) => x.at >= t0 - 2000);
      if (me.length) {
        const charged = me.reduce((s, x) => s + numOr0(x.chargedYuan), 0);
        $("rlTestStatus").textContent += " · 本次实扣 " + Number(charged.toFixed(4)) + " 元";
      }
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
    if (name === "sysinfo") loadSysinfo();
    if (name === "orders") loadOrders(ordersPage);
    if (name === "users") loadUsers(usersPage);
    if (name === "ledger") loadLedger();
    if (name === "tips") loadTips();
    if (name === "relay") {
      showRelaySub(relaySub);
      loadRelay();
      loadUsage();
    }
    if (name === "content") {
      showContentSub(cSub);
      if (cSub === "audit") loadContentAudit();
      else loadContent(cSub, cPages[cSub]);
      if (cSub === "app") loadAppPub();
    }
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
      // 打赏汇总（server 的 stats.tips = { count, totalYuan, todayYuan, revokedCount }）
      ["打赏总额", money((s.tips && s.tips.totalYuan) || 0) + " · " + String((s.tips && s.tips.count) || 0) + " 笔", "money"],
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
      /* 充值闸门：名单口径已作废（所有已注册账号一律可充），只剩一个显式全局关闭开关；
         这里把「当前到底开没开」直接写清楚，省得再去服务器上翻 env。 */
      ["充值闸门", (OV.config && OV.config.rechargeClosed) ? "已全局关闭（MTNODE_RECHARGE_CLOSED）" : "对所有注册账号开放"],
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

  /* ---------- 打赏 ---------- */

  let tipsPage = 1;
  const TIPS_PAGE_SIZE = 20;

  /** 打赏表格列（概览 / 别处要复用的话也在这里，别各写一份）。
      **没有「操作」列**：撤销打赏已停用（需求口径：前后端都不提供撤销，也不提示原因），
      表格里只留「状态」把存量已撤销记录标出来（历史数据与 CSV 的撤销列一律保留）。 */
  function tipColumns() {
    const cols = [
      { title: "时间", get: (t) => ts(t.at) },
      {
        title: "打赏人",
        get: (t) => (t.fromNickname || t.fromUsername || "—") + "（" + (t.fromUsername || t.fromUserId || "—") + " / " + (t.fromUserId || "—") + "）",
      },
      { title: "接收作者", get: (t) => (t.toNickname || t.toUsername || "—") + "（" + (t.toUsername || t.toUserId || "—") + "）" },
      { title: "对象类型", render: (td, t) => td.appendChild(el("span", "badge", TIP_KIND_TEXT[t.targetKind] || t.targetKind || "—")) },
      {
        title: "对象",
        render: (td, t) => {
          td.appendChild(el("div", "wrap-cell", t.targetLabel || "（对象已删除）"));
          td.appendChild(el("div", "mono muted", t.targetId || ""));
        },
      },
      { title: "金额", cls: "num", get: (t) => money(t.amountYuan) },
      {
        title: "状态",
        render: (td, t) => {
          td.appendChild(el("span", "st " + (t.revoked ? "st-bad" : "st-paid"), t.revoked ? "已撤销" : "正常"));
          if (t.revoked) {
            td.appendChild(el("div", "muted wrap-cell", (t.revokeReason || "") + (t.revokedBy ? "（" + t.revokedBy + "）" : "")));
          }
        },
      },
    ];
    return cols;
  }

  function paintTipCards(stats) {
    const s = stats || {};
    const cards = [
      ["打赏笔数", String(s.count || 0), ""],
      ["打赏总额", money(s.totalYuan), "money"],
      ["今日打赏", money(s.todayYuan), "money"],
      ["已撤销笔数", String(s.revokedCount || 0), ""],
    ];
    const box = $("tipCards");
    box.textContent = "";
    for (const [k, v, cls] of cards) {
      const c = el("div", "card");
      c.appendChild(el("div", "k", k));
      c.appendChild(el("div", "v " + cls, v));
      box.appendChild(c);
    }
  }

  async function loadTips(page) {
    tipsPage = Math.max(1, page || 1);
    const kind = encodeURIComponent($("fTipKind").value);
    const q = encodeURIComponent($("fTipUser").value.trim());
    try {
      const r = await api("GET", "/api/admin/tips?page=" + tipsPage + "&pageSize=" + TIPS_PAGE_SIZE + "&targetKind=" + kind + "&q=" + q);
      paintTipCards(r.stats);
      renderTable($("tblTips"), tipColumns(), r.items, "没有匹配的打赏");
      renderPager($("pgTips"), r.total, r.page, r.pageSize, (p) => loadTips(p));
    } catch (e) {
      toast((e && e.message) || "加载打赏失败", "err");
    }
  }
  $("btnTipSearch").addEventListener("click", () => loadTips(1));
  $("fTipKind").addEventListener("change", () => loadTips(1));
  $("fTipUser").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadTips(1);
  });
  if ($("btnCsvTips")) $("btnCsvTips").addEventListener("click", () => downloadCsv("tips"));

  /* 撤销打赏的入口（按钮 + 理由弹窗 + POST /api/admin/tips/revoke）已按需求整体移除：
     前后端都不提供撤销，界面上也不给任何「无法撤销」的提示 —— 存量已撤销记录照旧只读展示
     （状态列 / 汇总卡片的「已撤销笔数」/ CSV 的撤销列都还在）。 */

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

  /* ==========================================================================
   * 系统资源监控（只读 · 切页签采一次 + 手动刷新）
   *   · 页签里**没有**任何定时器：所有请求都只来自「切到本页签」与「点刷新」；
   *   · 进度条按用量百分比上色：< 80 常态、>= 80 黄、>= 90 红（阈值只在界面上，服务端不下发规则）；
   *   · 采样时间戳用服务端下发的 at，界面不自己造时间；Swap / 磁盘取不到就明说，不假装有数。
   * ========================================================================== */

  let siSeq = 0;

  const sizeText = (bytes) => {
    const n = Number(bytes) || 0;
    if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + " TB";
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  };
  const durText = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return d + " 天 " + h + " 小时";
    if (h) return h + " 小时 " + m + " 分";
    if (m) return m + " 分 " + (s % 60) + " 秒";
    return s + " 秒";
  };
  const meterClass = (pct) => (Number(pct) >= 90 ? "bad" : Number(pct) >= 80 ? "warn" : "");

  /** 一张指标卡：pct 不为空时带用量进度条（并按阈值上色）。 */
  function metricCard(label, value, pct, sub) {
    const c = el("div", "card metric");
    c.appendChild(el("div", "k", label));
    c.appendChild(el("div", "v", value));
    if (pct != null && Number.isFinite(Number(pct))) {
      const bar = el("div", "meter " + meterClass(pct));
      const fill = el("i");
      fill.style.width = Math.max(0, Math.min(100, Number(pct))) + "%";
      bar.appendChild(fill);
      c.appendChild(bar);
      c.appendChild(el("div", "sub", "用量 " + Number(pct).toFixed(1) + "%"));
    }
    if (sub) c.appendChild(el("div", "sub", sub));
    return c;
  }

  function kvPanel(node, rows) {
    node.textContent = "";
    const dl = el("dl");
    for (const [k, v] of rows) {
      dl.appendChild(el("dt", "", k));
      dl.appendChild(el("dd", "", v));
    }
    node.appendChild(dl);
  }

  async function loadSysinfo() {
    const seq = ++siSeq;
    $("siMeta").textContent = "正在采样…";
    let r = null;
    try {
      r = await api("GET", "/api/admin/sysinfo");
    } catch (e) {
      if (seq === siSeq) {
        $("siMeta").textContent = "采样失败：" + ((e && e.message) || e);
        toast((e && e.message) || "采样失败", "err");
      }
      return;
    }
    if (seq !== siSeq) return;
    const cpu = r.cpu || {};
    const mem = r.mem || {};
    const swap = r.swap || {};
    const disk = r.disk || {};
    const proc = r.proc || {};
    const host = r.host || {};
    const load = cpu.load || [0, 0, 0];
    $("siMeta").textContent =
      "采样时间 " + ts(r.at) + " · 本次采样耗时 " + (r.sampleMs || 0) + "ms · 切到本页签采一次、点「刷新」再采一次（服务端不留历史、不定时轮询）";

    const box = $("siCards");
    box.textContent = "";
    box.appendChild(metricCard("CPU 使用率", Number(cpu.usagePct || 0).toFixed(1) + " %", cpu.usagePct,
      (cpu.cores || 0) + " 核 · " + (cpu.model || "—")));
    box.appendChild(metricCard("负载（1 / 5 / 15 分钟）", load.map((n) => Number(n).toFixed(2)).join(" / "), null,
      cpu.cores ? "折合每核 1 分钟 " + (Number(load[0]) / Math.max(1, cpu.cores)).toFixed(2) : ""));
    box.appendChild(metricCard("内存", sizeText(mem.usedBytes) + " / " + sizeText(mem.totalBytes), mem.usedPct,
      "可用 " + sizeText(mem.freeBytes)));
    box.appendChild(swap.supported
      ? metricCard("Swap", sizeText(swap.usedBytes) + " / " + sizeText(swap.totalBytes), swap.usedPct, "空闲 " + sizeText(swap.freeBytes))
      : metricCard("Swap", "—", null, "本机不支持（读不到 /proc/meminfo）"));
    box.appendChild(disk.supported
      ? metricCard("磁盘（数据目录所在盘）", sizeText(disk.usedBytes) + " / " + sizeText(disk.totalBytes), disk.usedPct, "可用 " + sizeText(disk.freeBytes) + " · " + disk.path)
      : metricCard("磁盘", "—", null, "取不到磁盘信息（本机不支持 statfs）"));
    box.appendChild(metricCard("本服务内存（RSS）", sizeText(proc.rssBytes), null, "堆已用 " + sizeText(proc.heapUsedBytes)));

    kvPanel($("siProc"), [
      ["进程 PID", String(proc.pid || "—")],
      ["Node 版本", proc.node || "—"],
      ["运行时长", durText(proc.uptimeSec)],
      ["启动时间", ts(proc.startedAt)],
      ["累计 CPU 时间", Math.round((Number(proc.cpuTimeMs) || 0) / 1000) + " 秒"],
      ["RSS / 堆已用", sizeText(proc.rssBytes) + " / " + sizeText(proc.heapUsedBytes)],
    ]);
    kvPanel($("siHost"), [
      ["主机名", host.hostname || "—"],
      ["系统", (host.platform || "—") + " " + (host.release || "") + " · " + (host.arch || "")],
      ["开机时长", durText(host.uptimeSec)],
      ["CPU 型号 / 核数", (cpu.model || "—") + " · " + (cpu.cores || 0) + " 核"],
      ["数据目录", disk.path || "—"],
    ]);
  }
  if ($("btnSiRefresh")) $("btnSiRefresh").addEventListener("click", () => loadSysinfo());

  /* ==========================================================================
   * 内容管理（应用 / 模板 / 技能 / 改动留痕）
   *   · 管理员的票是 adm_，走 /api/admin/content/*：可操作**任何作者**的内容；
   *   · 编辑只到元信息（应用另可换图标）；文件正文与 zip 不在管理台换，应用的版本号也不手改；
   *   · 删除类操作先弹二次确认（写清删哪条、影响多少文件），服务端逐条写 contentAudit 留痕；
   *   · 模板 / 技能服务端本来就没有多版本链与「下架」位，界面上也不给这两类摆空按钮。
   * ========================================================================== */

  const C_SUBS = ["app", "template", "skill", "audit"];
  const C_PAGE_SIZE = 20;
  const KIND_TEXT = { app: "应用", template: "模板", skill: "技能" };
  const C_ACT_TEXT = {
    publish: "上架",
    unpublish: "下架",
    update: "编辑",
    delete: "删除",
    "delete-version": "删版本",
    republish: "重发目录",
  };
  let cSub = "app";
  const cPages = { app: 1, template: 1, skill: 1 };
  const cSeq = { app: 0, template: 0, skill: 0 };

  const cSubtabEls = () => Array.prototype.slice.call(document.querySelectorAll("#contentSubtabs .subtab"));

  function showContentSub(name) {
    const want = C_SUBS.includes(name) ? name : "app";
    cSub = want;
    for (const b of cSubtabEls()) b.classList.toggle("active", b.dataset.csub === want);
    for (const v of document.querySelectorAll(".csubview")) v.classList.toggle("hidden", v.id !== "cview-" + want);
  }
  for (const b of cSubtabEls()) {
    b.addEventListener("click", () => {
      showContentSub(b.dataset.csub);
      /* 切到哪个子页签就拉哪个列表（页签不轮询：只有点进来这一次与页内「查询 / 刷新」才请求）。 */
      if (b.dataset.csub === "audit") loadContentAudit();
      else loadContent(b.dataset.csub, cPages[b.dataset.csub]);
    });
  }

  /** 页签角标 = 全量条数（服务端 counts 恒为全量口径，不受当前筛选影响）。 */
  function paintContentCounts(counts) {
    if (!counts) return;
    for (const b of cSubtabEls()) {
      const k = b.dataset.csub;
      if (k === "app") b.textContent = "应用（" + (counts.app || 0) + "）";
      else if (k === "template") b.textContent = "模板（" + (counts.template || 0) + "）";
      else if (k === "skill") b.textContent = "技能（" + (counts.skill || 0) + "）";
    }
  }

  const kindCell = (r) => el("span", "badge", KIND_TEXT[r.kind] || r.kind);
  void kindCell;

  function acts(td, buttons) {
    const box = el("div", "row-acts");
    for (const [text, cls, fn] of buttons) {
      const b = el("button", "btn btn-sm " + (cls || ""), text);
      b.addEventListener("click", fn);
      box.appendChild(b);
    }
    td.appendChild(box);
  }

  function appColumns() {
    return [
      { title: "应用 id", get: (r) => r.id },
      { title: "标题", get: (r) => r.title },
      { title: "作者", get: (r) => r.ownerName },
      { title: "当前版本", get: (r) => "v" + (r.version || "—") + (r.versionCount > 1 ? "（共 " + r.versionCount + " 版）" : "") },
      { title: "大小", get: (r) => sizeText(r.bytes) },
      { title: "下载 / 赞", get: (r) => r.downloads + " / " + r.likes },
      { title: "状态", render: (td, r) => td.appendChild(el("span", "badge " + (r.unpublished ? "bad" : "ok"), r.unpublished ? "已下架" : "已上架")) },
      { title: "更新时间", get: (r) => ts(r.updatedAt) },
      {
        title: "操作",
        render: (td, r) =>
          acts(td, [
            [r.unpublished ? "重新上架" : "下架", "", () => contentPublish(r, !r.unpublished)],
            ["编辑", "", () => contentEdit(r)],
            ["版本历史", "", () => contentVersions(r)],
            ["下载 zip", "", () => contentDownload(r)],
            ["删除", "btn-danger", () => contentDelete(r)],
          ]),
      },
    ];
  }

  function tplColumns() {
    return [
      { title: "模板 id", get: (r) => r.id },
      { title: "标题", get: (r) => r.title },
      { title: "作者", get: (r) => r.ownerName },
      { title: "标签", get: (r) => (r.tags || []).join(" / ") || "—" },
      { title: "大小", get: (r) => sizeText(r.bytes) },
      { title: "下载 / 赞", get: (r) => r.downloads + " / " + r.likes },
      { title: "预览图", get: (r) => (r.hasPreview ? "有" : "无") },
      { title: "更新时间", get: (r) => ts(r.updatedAt) },
      {
        title: "操作",
        render: (td, r) =>
          acts(td, [
            ["编辑", "", () => contentEdit(r)],
            ["下载文件", "", () => contentDownload(r)],
            ["看预览图", "", () => contentPreview(r)],
            ["删除", "btn-danger", () => contentDelete(r)],
          ]),
      },
    ];
  }

  function skillColumns() {
    return [
      { title: "skill name", get: (r) => r.skillName || "—" },
      { title: "标题", get: (r) => r.title },
      { title: "作者", get: (r) => r.ownerName },
      { title: "版本", get: (r) => "v" + (r.version || "—") },
      { title: "官方", render: (td, r) => td.appendChild(el("span", "badge " + (r.official ? "ok" : ""), r.official ? "官方" : "非官方")) },
      { title: "文件", get: (r) => r.fileCount + " 个 · " + sizeText(r.bytes) },
      { title: "下载 / 赞", get: (r) => r.downloads + " / " + r.likes },
      { title: "更新时间", get: (r) => ts(r.updatedAt) },
      {
        title: "操作",
        render: (td, r) =>
          acts(td, [
            [r.official ? "取消官方" : "设为官方", "", () => contentOfficial(r, !r.official)],
            ["编辑", "", () => contentEdit(r)],
            ["下载", "", () => contentDownload(r)],
            ["删除", "btn-danger", () => contentDelete(r)],
          ]),
      },
    ];
  }

  function contentQueryString(kind) {
    const p = new URLSearchParams();
    p.set("kind", kind);
    p.set("page", String(cPages[kind] || 1));
    p.set("pageSize", String(C_PAGE_SIZE));
    if (kind === "app") {
      p.set("q", $("fAppQ").value.trim());
      p.set("author", $("fAppAuthor").value.trim());
      p.set("status", $("fAppStatus").value);
    } else if (kind === "template") {
      p.set("q", $("fTplQ").value.trim());
      p.set("author", $("fTplAuthor").value.trim());
    } else if (kind === "skill") {
      p.set("q", $("fSkillQ").value.trim());
      p.set("author", $("fSkillAuthor").value.trim());
      p.set("status", $("fSkillStatus").value);
    }
    return p.toString();
  }

  async function loadContent(kind, page) {
    const k = C_SUBS.includes(kind) ? kind : "app";
    if (k === "audit") return loadContentAudit();
    if (page) cPages[k] = Math.max(1, page);
    const seq = ++cSeq[k];
    try {
      const r = await api("GET", "/api/admin/content?" + contentQueryString(k));
      if (seq !== cSeq[k]) return;
      paintContentCounts(r.counts);
      if (k === "app") {
        renderTable($("tblApps"), appColumns(), r.items, "没有匹配的应用");
        renderPager($("pgApps"), r.total, r.page, r.pageSize, (p) => loadContent("app", p));
      } else if (k === "template") {
        renderTable($("tblTpls"), tplColumns(), r.items, "没有匹配的模板");
        renderPager($("pgTpls"), r.total, r.page, r.pageSize, (p) => loadContent("template", p));
      } else {
        renderTable($("tblSkills"), skillColumns(), r.items, "没有匹配的技能");
        renderPager($("pgSkills"), r.total, r.page, r.pageSize, (p) => loadContent("skill", p));
      }
    } catch (e) {
      if (seq === cSeq[k]) toast((e && e.message) || "加载内容列表失败", "err");
    }
  }

  async function loadContentAudit() {
    try {
      const r = await api("GET", "/api/admin/content/audit?limit=100");
      const items = r.items || [];
      $("cAuditMeta").textContent = "最近 " + items.length + " 条（服务端留存上限 200 条）";
      renderTable(
        $("tblContentAudit"),
        [
          { title: "时间", get: (x) => ts(x.at) },
          { title: "管理员", get: (x) => x.username || x.userId },
          { title: "动作", get: (x) => C_ACT_TEXT[x.action] || x.action },
          { title: "类型", get: (x) => KIND_TEXT[x.kind] || x.kind },
          { title: "对象", get: (x) => (x.targetTitle || x.targetId) + "（" + x.targetId + " · " + (x.targetOwnerId || "—") + "）" },
          { title: "说明", cls: "wrap-cell", get: (x) => x.detail || "" },
        ],
        items,
        "还没有内容改动",
      );
    } catch (e) {
      toast((e && e.message) || "加载改动留痕失败", "err");
    }
  }

  /** 静态目录体检（公开只读接口 /api/apps/pub）：重发后的条数与缺项一眼可见。 */
  async function loadAppPub() {
    try {
      const res = await fetch(API + "/api/apps/pub");
      const d = await res.json();
      const last = d && d.last;
      $("appPubMeta").textContent =
        "静态目录：" + (d && d.ok ? "正常" : "异常") +
        " · 库 " + ((d && d.dbApps) || 0) + " 条 / 盘 " + ((d && d.diskApps) >= 0 ? d.diskApps : "?") + " 条" +
        (d && d.fallback ? " · ⚠ 已回退接口目录（客户端读 /api/apps/catalog）" : "") +
        (last ? " · 上次发布（" + (last.reason || "—") + "）：" + (last.ok ? "成功 " + (last.apps || 0) + " 条 / " + (last.files || 0) + " 文件" : "失败") : "");
    } catch (e) {
      $("appPubMeta").textContent = "静态目录体检失败：" + ((e && e.message) || e);
    }
  }

  async function contentPublish(row, unpublish) {
    try {
      await api("POST", "/api/admin/content/publish", { id: row.id, ownerId: row.ownerId, unpublish: unpublish });
      toast((unpublish ? "已下架 " : "已重新上架 ") + row.title, "ok");
      loadContent("app", cPages.app);
      loadAppPub();
    } catch (e) {
      toast((e && e.message) || "操作失败", "err");
    }
  }

  function contentEdit(row) {
    const fields = [
      { kind: "note", text: "只改元信息：文件正文与 zip 不在管理台替换（谁上传谁改）。" },
      { name: "title", label: "标题", value: row.title },
      { name: "description", label: "简介", type: "textarea", value: row.desc },
      { name: "tags", label: "标签（逗号分隔）", value: (row.tags || []).join(",") },
    ];
    if (row.kind === "skill") fields.push({ name: "version", label: "版本号（x.y.z）", value: row.version });
    if (row.kind === "app") {
      fields.push({ kind: "note", text: "图标：" + (row.hasIcon ? "已有（选新图片即覆盖）" : "暂无（可上传 png / jpg / webp）") + "；留空 = 不改。" });
      fields.push({ name: "iconBase64", label: "图标文件（可留空）", type: "file", accept: "image/png,image/jpeg,image/webp" });
    }
    openDialog(
      "编辑" + KIND_TEXT[row.kind] + " · " + row.title,
      fields,
      async (v) => {
        const body = { kind: row.kind, id: row.id, ownerId: row.ownerId, title: v.title, description: v.description, tags: v.tags };
        if (row.kind === "skill") body.version = v.version;
        if (row.kind === "app" && v.iconBase64) body.iconBase64 = v.iconBase64;
        const r = await api("POST", "/api/admin/content/update", body);
        toast("已保存：" + ((r.changed || []).join(" / ") || "无字段变化"), "ok");
        loadContent(row.kind, cPages[row.kind]);
        if (row.kind === "app") loadAppPub();
      },
      "保存",
    );
  }

  async function contentOfficial(row, official) {
    try {
      await api("POST", "/api/admin/content/update", { kind: "skill", id: row.id, ownerId: row.ownerId, official: official });
      toast((official ? "已设为官方：" : "已取消官方：") + row.title, "ok");
      loadContent("skill", cPages.skill);
    } catch (e) {
      toast((e && e.message) || "操作失败", "err");
    }
  }

  function contentDelete(row) {
    const what =
      row.kind === "app"
        ? "应用分支「" + row.title + "」（id " + row.id + " · 作者 " + row.ownerName + "），含 " + row.versionCount + " 个版本的 zip" + (row.hasIcon ? " 与图标" : "") + (row.branchCount > 1 ? "；同 id 下还有 " + (row.branchCount - 1) + " 条别的作者分支（不动它们）" : "")
        : KIND_TEXT[row.kind] + "「" + row.title + "」（id " + row.id + " · 作者 " + row.ownerName + "），含" +
          (row.kind === "template" ? "模板文件与预览图" : row.fileCount + " 个文件与预览图");
    openDialog(
      "删除" + KIND_TEXT[row.kind],
      [
        { kind: "note", text: "将要删除：" + what + "。" + (row.kind === "app" ? "删除后会自动重发静态目录（客户端立刻看不到）。" : "") + "此操作不可撤销，并会写入改动留痕。" },
        { kind: "note", text: "确认无误点「确认删除」。" },
      ],
      async () => {
        await api("POST", "/api/admin/content/delete", { kind: row.kind, id: row.id, ownerId: row.ownerId });
        toast("已删除 " + row.title, "ok");
        loadContent(row.kind, cPages[row.kind]);
        if (row.kind === "app") loadAppPub();
      },
      "确认删除",
    );
  }

  async function contentVersions(row) {
    let r = null;
    try {
      r = await api("GET", "/api/admin/content/versions?id=" + encodeURIComponent(row.id) + "&owner=" + encodeURIComponent(row.ownerId));
    } catch (e) {
      toast((e && e.message) || "读取版本历史失败", "err");
      return;
    }
    const items = r.items || [];
    openRawDialog("版本历史 · " + row.title, (body) => {
      body.appendChild(
        el(
          "div",
          "hint",
          "应用 " + r.id + " · 作者 " + r.ownerName + " · 当前 v" + (r.latestVersion || "—") + (r.unpublished ? "（已下架）" : "") +
            " · 共 " + items.length + " 个版本" + (r.versionsOn ? "" : "（服务端未启用多版本：只有当前这一版）"),
        ),
      );
      const table = el("table");
      body.appendChild(table);
      renderTable(
        table,
        [
          { title: "版本", get: (v) => "v" + v.version + (v.current ? "（当前）" : "") },
          { title: "大小", get: (v) => sizeText(v.bytes) },
          { title: "入口", get: (v) => v.entry || "—" },
          { title: "上传时间", get: (v) => ts(v.createdAt) },
          { title: "包", get: (v) => (v.hasFile ? "在" : "缺失") },
          {
            title: "操作",
            render: (td, v) =>
              acts(td, [
                ["下载此版本", "", () => contentDownload(row, v.version)],
                ["删除此版本", "btn-danger", () => contentDeleteVersion(row, v, items.length)],
              ]),
          },
        ],
        items,
        "没有版本记录",
      );
    }, "关闭");
  }

  function contentDeleteVersion(row, v, total) {
    if (total <= 1) {
      toast("只剩这一个版本了：要清空整条分支请用「删除」", "err");
      return;
    }
    openDialog(
      "删除版本",
      [
        { kind: "note", text: "将要删除：" + row.title + " 的 v" + v.version + "（" + sizeText(v.bytes) + (v.current ? " · 这是当前版本" : "") + "）。该版本的包会一并删除，删完不可撤销，并写入改动留痕。" },
        { kind: "note", text: "全删光时服务端会自动把这条分支下架（与公开口径一致）。" },
      ],
      async () => {
        await api("POST", "/api/admin/content/delete-version", { id: row.id, ownerId: row.ownerId, version: v.version });
        toast("已删除 v" + v.version, "ok");
        closeDialog();
        loadContent("app", cPages.app);
        loadAppPub();
      },
      "确认删除",
    );
  }

  /** 技能是多文件包：>1 个文件时先让管理员挑哪个文件（下载默认 SKILL.md）。 */
  function contentDownload(row, version, file) {
    const list = row.kind === "skill" ? row.fileList || [] : [];
    if (row.kind === "skill" && !file && list.length > 1) {
      openRawDialog("下载技能文件 · " + row.title, (body) => {
        body.appendChild(el("div", "hint", "技能包共 " + list.length + " 个文件（下载不计入作者的下载量统计）："));
        const table = el("table");
        body.appendChild(table);
        renderTable(table, [
          { title: "文件", get: (f) => f },
          { title: "操作", render: (td, f) => acts(td, [["下载", "", () => contentDownload(row, version, f)]]) },
        ], list, "包内没有文件");
      }, "关闭");
      return;
    }
    const q =
      "kind=" + row.kind + "&id=" + encodeURIComponent(row.id) + "&owner=" + encodeURIComponent(row.ownerId || "") +
      (version ? "&version=" + encodeURIComponent(version) : "") + (file ? "&file=" + encodeURIComponent(file) : "") + "&format=raw";
    const name =
      row.kind === "app" ? row.id + (version ? "-v" + version : "") + ".zip"
        : row.kind === "template" ? row.id + ".mtnodes"
          : (file || "SKILL.md").split("/").pop();
    fetch(API + "/api/admin/content/download?" + q, { headers: { Authorization: "Bearer " + TOKEN } })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.blob();
      })
      .then((blob) => {
        const a = el("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 2000);
        toast("已开始下载 " + name, "ok");
      })
      .catch((e) => toast("下载失败：" + ((e && e.message) || e), "err"));
  }

  function contentPreview(row) {
    const size = row.hasPreview ? "full" : "thumb";
    const url = API + "/api/admin/content/preview?kind=" + row.kind + "&id=" + encodeURIComponent(row.id) + "&size=" + size;
    if (!row.hasPreview) {
      toast("这条没有预览图", "err");
      return;
    }
    /* 预览图带管理票，不能直接开新窗口 → 先取 blob 再开本地地址。 */
    fetch(url, { headers: { Authorization: "Bearer " + TOKEN } })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.blob();
      })
      .then((blob) => {
        const href = URL.createObjectURL(blob);
        window.open ? window.open(href, "_blank") : null;
        setTimeout(() => URL.revokeObjectURL(href), 60000);
      })
      .catch((e) => toast("预览图打不开：" + ((e && e.message) || e), "err"));
  }

  async function republishApps() {
    try {
      const r = await api("POST", "/api/admin/content/republish");
      const h = r.health || {};
      toast("静态目录已重发：" + (h.ok ? "正常" : "仍有异常") + " · 库 " + (h.dbApps || 0) + " / 盘 " + (h.diskApps >= 0 ? h.diskApps : "?") + " 条", h.ok ? "ok" : "err");
      loadAppPub();
      loadContent("app", cPages.app);
    } catch (e) {
      toast((e && e.message) || "重发失败", "err");
    }
  }

  $("btnAppSearch").addEventListener("click", () => loadContent("app", 1));
  $("fAppStatus").addEventListener("change", () => loadContent("app", 1));
  $("fAppAuthor").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadContent("app", 1);
  });
  $("fAppQ").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadContent("app", 1);
  });
  $("btnAppRepublish").addEventListener("click", () => republishApps());
  $("btnTplSearch").addEventListener("click", () => loadContent("template", 1));
  $("fTplAuthor").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadContent("template", 1);
  });
  $("fTplQ").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadContent("template", 1);
  });
  $("btnSkillSearch").addEventListener("click", () => loadContent("skill", 1));
  $("fSkillStatus").addEventListener("change", () => loadContent("skill", 1));
  $("fSkillAuthor").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadContent("skill", 1);
  });
  $("fSkillQ").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadContent("skill", 1);
  });
  $("btnCAuditRefresh").addEventListener("click", () => loadContentAudit());

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

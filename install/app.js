"use strict";
/**
 * 安装窗 UI：左侧「步骤表（第一行是『全部日志』）」，右侧日志区，失败给日志尾部 + 建议修复方法。
 *
 * 口径（与 plugins/main-install.js 分工）：
 *   · 状态机在主进程（install-steps.js）：本文件**只画**，不判成败；
 *   · 快照（snapshot）承载清单与每步状态，事件流（step / log / finish）驱动增量更新；
 *   · 日志只在窗内内存里（不落盘）；日志区默认是「全部」（整场安装按真实输出顺序合成一条流），
 *     点左侧某一步切到那一步的日志，点回「全部日志」回全文；失败时只给末尾 240 行（脚本崩溃那段）。
 *
 * 语言：界面文案跟随 MTNode 主界面语言 —— 主进程把 locale 通过 onState 的首帧带不过来，
 * 这里用 navigator.language 判定（中文环境显示中文，其余显示英文），词条表就在本文件底部。
 */
(function () {
  const api = window.mtnodeInstall;
  const $ = (id) => document.getElementById(id);

  /* ── 词条（本窗自足：安装窗不加载主窗口的 i18n 模块） ── */
  const ZH = /^zh/i.test(String(navigator.language || "zh"));
  const T = (zh, en) => (ZH ? zh : en);

  /* ── 视图状态 ── */
  let snap = null;          /* 主进程给的最新快照（{pluginId,name,installDir,steps[],logs,state,error,hint}） */
  let selected = "";        /* 右侧正在看哪一步的日志；"" = 「全部」（整场安装的日志，按真实输出顺序） */
  let follow = true;        /* 日志是否自动滚到最新 */
  let running = false;      /* 是否还在跑（决定「取消」还是「完成」按钮） */
  let cancelling = false;   /* 已发出取消、进程树还在死：按钮显示「正在停止…」并置灰 */
  let autoCreatedDir = "";  /* 这次安装的目录是本窗**自动建出来**的（本轮需求）：顶部副行加一句回执，换插件即作废 */

  /* ── 日志的「真实输出顺序」 ──────────────────────────────────────────────
     主进程按**步骤分桶**存日志（snap.logs[stepId]），分桶本身不带顺序信息。窗里自己维护一份
     「桶 → 到达序号」表：adopt 时按快照里桶的出现顺序起号（已是第几批就接着往下排），
     之后每来一行日志事件按事件的 seq 续号。渲染「全部」视图时按这个序号把各段首尾接起来，
     于是脚本崩溃时那一整段（含 PowerShell 异常块）一定在最后、默认就看得见。 */
  let logOrder = [];        /* 桶键，按首次到达顺序 */
  let logNextSeq = 1;       /* 下一个可用序号（进程内的 seq 起点对不齐时按它续） */
  let logSeqOf = Object.create(null); /* 桶键 → 该桶的起始序号 */

  function logKeyOf(stepId) {
    return String(stepId || "_");
  }
  /** 记下一个桶（第一次见到时按到达顺序起号） */
  function touchLogBucket(key, seq) {
    const k = logKeyOf(key);
    const want = Number(seq) || 0;
    if (!(k in logSeqOf)) {
      const start = want > logNextSeq ? want : logNextSeq;
      logSeqOf[k] = start;
      logOrder.push(k);
      logNextSeq = start + 1;
    } else if (want >= logNextSeq) {
      /* 事件带了主进程的绝对序号（换插件 / 重开窗后对不齐）：跟着它走，保证后面接得上 */
      logNextSeq = want + 1;
    }
    return k;
  }
  function resetLogOrder() {
    logOrder = [];
    logSeqOf = Object.create(null);
    logNextSeq = 1;
  }
  /** adopt：按快照里桶的出现顺序重建序号表（logs 是普通对象，保留主进程的插入顺序） */
  function syncLogOrderFromSnap() {
    const logs = (snap && snap.logs) || {};
    for (const k of Object.keys(logs)) if (!(k in logSeqOf)) touchLogBucket(k, 0);
  }
  /** 一行日志/一段日志追加进快照；seq 只影响「全部」视图里的排序，不改分桶语义 */
  function pushLogText(key, line, seq) {
    const k = touchLogBucket(key, seq);
    if (!snap.logs) snap.logs = {};
    snap.logs[k] = snap.logs[k] ? snap.logs[k] + "\n" + line : String(line);
    return k;
  }
  /** 「全部」视图的正文：按真实输出顺序把各步日志首尾接起来，段间加一行步骤小标题。
      为什么要按序接：各步日志是分桶存的（按 stepId 归段），直接拼接会把晚到的行排到前面；
      用户要看的是脚本真实吐出来的先后（失败时异常块一定在最后）。 */
  const ALL_VIEW_TAIL_LINES = 240;
  function stepsWithLogs() {
    return logOrder.filter((k) => {
      const t = (snap.logs && snap.logs[k]) || "";
      return !!t;
    });
  }
  function allLogText(tailLines) {
    const buckets = stepsWithLogs();
    if (!buckets.length) return "";
    const lines = [];
    for (const k of buckets) {
      if (buckets.length > 1) lines.push("===== " + (k === "_" ? T("安装过程", "install output") : stepTitle(k)) + " =====");
      lines.push(String((snap.logs && snap.logs[k]) || ""));
    }
    const text = lines.join("\n");
    const n = Number(tailLines) || 0;
    if (n <= 0) return text;
    const all = text.split(/\r?\n/);
    return all.length > n ? all.slice(all.length - n).join("\n") : text;
  }
  function stepTitle(id) {
    const s = stepOf(id);
    return (s && s.title) || id;
  }

  /* ── 工具 ── */
  function setBar(el, pct) {
    if (!el) return;
    const i = el.querySelector ? el.querySelector("i") : null;
    const target = i || el;
    target.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }
  /* ── 触发安装（安装脚本本身仍在主窗口那套 IPC 里跑，这里只是「开始」按钮 + 轮询状态） ──
     为什么这里触发：卡片「安装 / 重装」与控制台窗内的「安装」都只负责**开这只窗**，
     真正开跑由窗内按钮发起 —— 用户点了才跑，不会出现「窗还没开安装已经在跑」。 */
  const BACKEND_INSTALL_API = {
    "llama-local": "llamaInstall",
    "breeze-tts-local": "breezeInstall",
    "sensenova-local": "sensenovaInstall",
    "minimax-h3": "h3Install",
    "minimax-music3": "music3Install",
    "yue2-local": "yue2Install",
    remotion: "remotionInstall",
  };
  /* id → 选安装目录的桥 / 启动安装的桥（窗口插件与桌宠用它们自己的那两条） */
  function installApiOf(id) {
    const key = String(id || "");
    if (BACKEND_INSTALL_API[key]) {
      return { install: BACKEND_INSTALL_API[key], pick: BACKEND_INSTALL_API[key].replace(/Install$/, "PickInstallDir") };
    }
    if (key === "bongochat" || key === "pet") return { install: "petInstall", pick: "" };
    return { install: "appPluginsInstall", pick: "" };
  }
  /* 硬件门槛的逃生阀：sensenova 的「显存 <20GB / 内存 <32GB」闸门靠 install 的 forceHardware 放行。
     这个开关原本在 sensenova 控制台窗里，控制台去安装化后搬到本窗（能力不丢，位置归一）。 */
  const FORCE_HW_IDS = ["sensenova-local"];
  let pollTimer = null;
  function startPolling(id) {
    stopPolling();
    let tick = 0;
    pollTimer = setInterval(async () => {
      tick++;
      const r = await api.state(id).catch(() => null);
      if (r && r.session) adopt(r.session);
      const s = r && r.session;
      if (!s || s.state !== "running" || tick > 600) stopPolling();
    }, 2000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /* ── 卸载（「卸载」按钮 → 确认清单 → 真删） ───────────────────────────────
     口径：卸载是破坏性动作，先展开一份「删什么 / 留什么」的清单，用户点「确认卸载」才开跑；
     删除范围由主进程的路由表决定（自定义卸载口的插件交给它自己，其余删该插件的安装目录），
     本窗只说「卸载这个插件」，自己不算目录、不拼删除清单。 */
  let uninPrev = null;      /* 最近一次卸载预览（主进程给的：targets / note / keepHint） */
  let uninConfirm = false;  /* 确认块是否展开（点「卸载」展开，取消 / 换插件收起） */
  let uninRunning = false;  /* 已发出卸载、正在跑（按钮置灰，避免重复点） */
  let injErr = null;        /* 卸载预览失败原因（展开不了清单时如实说，别装作没事） */

  function isUninstall() {
    return !!snap && (snap.mode === "uninstall" || snap.action === "uninstall");
  }
  /** 现在是「卸载这条线」吗：快照是卸载那一次，或者这一趟卸载正跑着 / 确认清单还开着。 */
  function inUninstallFlow() {
    return uninRunning || uninConfirm || isUninstall();
  }

  /** 打开确认块：先问主进程「这一趟会删什么」。取不到就如实报错，不盲删。 */
  async function openUninstall() {
    uninConfirm = true;
    injErr = null;
    uninPrev = null;
    /* 卸载也要「先认得出目录」：目录为空 = 主进程读不到该插件的安装目录（配置被清 / 换过
       数据目录），清单只能是空的、真删也无从下手 —— 先把目录落地那一拍走一遍（本轮共识：
       安装 / 权重 / 卸载三条链共用同一份口径）。窗口插件 / 桌宠空目录是正常的老口径。 */
    if (snap) await ensureDirFor(snap.pluginId, {});
    renderUninstall();
    renderActions();
    const r = await api.uninstall({ action: "preview", id: snap ? snap.pluginId : "" }).catch(() => null);
    if (r && r.ok) uninPrev = r;
    else injErr = (r && (r.message || r.error)) || T("取不到卸载清单", "cannot get the uninstall list");
    /* 预览里带回来的安装目录跟着刷新（目录由本窗统一显示） */
    if (r && r.ok && r.installDir && snap) {
      snap.installDir = String(r.installDir);
      renderHead();
    }
    renderUninstall();
    renderActions();
    return r;
  }

  function closeUninstall() {
    uninConfirm = false;
    uninRunning = false;
    uninPrev = null;
    injErr = null;
    renderUninstall();
    renderActions();
  }

  async function runUninstall(opts) {
    if (!snap || uninRunning) return;
    /* 还没确认过（「重试」是失败后再来一次，不再问一遍）：先展开清单让用户确认 */
    if (!(opts && opts.confirmed)) {
      await openUninstall();
      return;
    }
    const id = snap.pluginId;
    uninRunning = true;
    injErr = null;
    renderActions();
    toast(T("卸载已开始", "uninstall started"));
    startPolling(id);
    const r = await api.uninstall({ action: "run", id }).catch(() => null);
    /* run 立刻回执（真删在后台异步跑），终局走 finish 事件；失败时这里当场如实说 */
    if (!r || !r.ok) {
      uninRunning = false;
      stopPolling();
      toast(T("卸载失败：", "uninstall failed: ") + ((r && (r.message || r.error)) || ""), "err");
      renderActions();
      return;
    }
    if (r.installDir === "" || r.started) uninConfirm = false;
    renderUninstall();
    renderActions();
  }

  function renderUninstall() {
    const box = $("insUnin");
    if (!box) return;
    /* 确认清单在「确认块展开」与「卸载正跑着」两种时候都留着：跑的时候它是这一趟的
       删除范围现场（进度与结果同时写进右侧日志区），跑完就不该再占地方。 */
    const show = !!snap && (uninConfirm || uninRunning);
    box.hidden = !show;
    if (!show) return;
    const p = uninPrev || {};
    $("insUninTitle").textContent = T("确认卸载", "Confirm uninstall") + (p.label ? "：" + p.label : "");
    $("insUninDir").textContent = p.installDir || (snap && snap.installDir) || "";
    $("insUninDir").title = $("insUninDir").textContent;
    const list = $("insUninList");
    list.innerHTML = "";
    const li = (text) => {
      const el = document.createElement("li");
      el.textContent = text;
      list.appendChild(el);
    };
    if (injErr) {
      li(T("· 取不到卸载清单：", "· cannot get the uninstall list: ") + injErr);
    } else if (!uninPrev) {
      li(T("· 正在读取要删除的内容…", "· reading what will be deleted…"));
    } else {
      for (const t of p.targets || []) {
        const rel = String(t.rel || "");
        li("· " + T("删除 ", "delete ") + (rel ? rel + " — " : "") + String(t.path || "") + (t.note && !rel ? "（" + t.note + "）" : ""));
      }
      if (!(p.targets || []).length) li("· " + T("删除该插件自己管理的运行时文件", "delete the runtime files this plugin manages"));
      for (const it of (p.items || []).slice(0, 12)) li("    · " + String(it.name || "") + (it.note ? "（" + it.note + "）" : ""));
      if ((p.items || []).length > 12) li("    · " + T("…目录里还有更多条目", "…more entries inside"));
    }
    const noteBits = [];
    if (uninPrev && uninPrev.warning) noteBits.push(uninPrev.warning);
    if (uninPrev && uninPrev.note) noteBits.push(uninPrev.note);
    if (uninPrev && uninPrev.keepHint) noteBits.push(T("保留：", "kept: ") + uninPrev.keepHint);
    if (!noteBits.length) noteBits.push(T("确认前不会动任何文件。", "Nothing is touched before you confirm."));
    $("insUninNote").textContent = noteBits.join("\n");
  }

  /* ── 「动手之前先把目录落地」这一拍（安装 / 权重 / 卸载三条链共用一份口径） ────────────
     需求：设过插件根目录之后，安装时目录该被自动建出来，不必再去系统框里手建一个。
     主进程口径在 plugins/main-install.js 的 ensureInstallDirFor → plugin-root.js 的 ensureDir。
     这里的职责只有三件：调它、把结果同步进快照、把失败**当场说清**（返回 true = 别往下走）。
     为什么要兜「有目录位的插件却回了空目录」：那是主进程与安装窗对不上（配置文件读不到 /
     换过数据目录 / 认不出这个 id），从前会一路走到宿主，报一句用户看不懂的 empty_dir ——
     本轮共识：这里就如实报错，并把「选择安装目录」留作手动兜底。 */
  async function ensureDirFor(id, opts) {
    const o = opts || {};
    const btn = o.button || null;
    const ens = typeof api.ensureDir === "function" ? await api.ensureDir(id).catch(() => null) : null;
    const needDir = !!(ens && ens.ok && ens.needs);
    if (ens && ens.ok && ens.dir) {
      const prevDir = String((snap && snap.installDir) || "");
      /* 「已自动创建」的回执写进顶部副行（不用 toast：它会被下面那句「安装已开始」当场顶掉） */
      autoCreatedDir = ens.created ? String(ens.dir) : "";
      if (snap) snap.installDir = String(ens.dir);
      if (prevDir !== String(ens.dir) || ens.created) renderHead();
      return false;
    }
    if (ens && !ens.ok && ens.error) {
      /* need_root 不算故障：老口径照旧（下面会弹系统目录框让用户选一处） */
      if (ens.error === "need_root") return false;
      if (btn) btn.disabled = false;
      toast(
        T("创建默认安装目录失败：", "could not create the default install dir: ") +
          ((ens && (ens.message || ens.error)) || "") +
          T("（可用「选择安装目录」手动选一处）", " (pick one with “Choose install dir”)"),
        "err",
      );
      return true;
    }
    if (needDir) {
      /* 主进程说「本该给它建目录」，却没回目录：如实拦下，别把「目录为空」传成宿主的 empty_dir */
      if (btn) btn.disabled = false;
      toast(
        T(
          "取不到这个插件的安装目录（插件配置里没有，主进程也没能推出来）：可用「选择安装目录」手动选一处，或先在插件界面设好插件根目录。",
          "could not resolve this plugin's install dir (not in its config, and the main process could not derive one): pick one with “Choose install dir”, or set the plugin root folder first.",
        ),
        "err",
      );
      return true;
    }
    return false;
  }

  async function runInstall() {
    if (!snap) return;
    const id = snap.pluginId;
    /* 卸载那一次：同一只窗、同一份快照，只是「动手」那条桥换成卸载（重试也走这里）。 */
    if (isUninstall()) return runUninstall({ confirmed: false });
    const m = installApiOf(id);
    let dir = snap.installDir || "";
    const btn = $("insRunBtn");
    if (btn) btn.disabled = true;
    /* ── 目录在**安装真正开始时**才落地（本轮需求）──────────────────────────────
       用户设过插件根目录后，目录其实就算得出来（根目录 + 默认子目录名），只是从前没人建、
       也没人写回插件自己的配置 —— 于是用户只能点「选择安装目录」再在系统框里手建一个。
       这里让主进程把目录建出来（连根目录一起，已存在就直接复用）并写进该插件自己的
       installDir：7 个宿主的安装函数读的就是它。窗口插件 / 桌宠回 dir:"" ，老口径不变。 */
    if (await ensureDirFor(id, { button: btn })) return;
    dir = (snap && snap.installDir) || dir;
    /* 还没选目录：先弹系统目录选择框（不是插件窗），取消就什么都不做 */
    if (!dir && m.pick) {
      const p = await api.api(m.pick, []);
      if (!p || !p.ok) {
        if (btn) btn.disabled = false;
        if (p && p.error) toast(T("选择安装目录失败：", "pick dir failed: ") + p.error, "err");
        return;
      }
      const st = await api.state(id).catch(() => null);
      if (st && st.session) adopt(st.session);
    }
    toast(T("安装已开始", "install started"));
    startPolling(id);
    /* 勾了「忽略硬件门槛」才透传 forceHardware（不勾就完全按脚本原本的门槛走）。
       桥的签名分两种：本地后端 / 桌宠收选项对象（{ action, forceHardware }），
       窗口插件的 `appPlugins:install` 收的是**插件 id 字符串**（传对象会被 String() 成
       "[object Object]" → bad_id，安装直接失败）—— 这里按桥名分派，别混着传。 */
    const forceHw = FORCE_HW_IDS.indexOf(id) >= 0 && $("insForceHw") && $("insForceHw").checked;
    const installArgs =
      m.install === "appPluginsInstall"
        ? [String(id)]
        : [Object.assign({ action: snap.action || "install" }, forceHw ? { forceHardware: true } : {})];
    const r = await api.api(m.install, installArgs);
    stopPolling();
    const now = await api.state(id).catch(() => null);
    if (now && now.session) adopt(now.session);
    if (!r || !r.ok) {
      toast(T("安装失败：", "install failed: ") + ((r && (r.message || r.error)) || ""), "err");
    }
    if (btn) btn.disabled = false;
  }

  function toast(msg, kind) {
    const el = $("insToast");
    if (!el) return;
    el.textContent = String(msg || "");
    el.className = "ins-toast" + (kind ? " is-" + kind : "");
    el.hidden = !msg;
    if (msg) setTimeout(() => { el.hidden = true; }, kind === "err" ? 6000 : 3000);
  }
  function esc(s) { return String(s == null ? "" : s); }
  function stepOf(id) { return snap && snap.steps ? snap.steps.find((s) => s.id === id) || null : null; }
  const STATUS_ICON = { pending: "○", run: "◐", ok: "✓", fail: "✕", skip: "—" };
  const STATUS_LABEL = {
    pending: () => T("待执行", "pending"),
    run: () => T("进行中", "running"),
    ok: () => T("完成", "done"),
    fail: () => T("失败", "failed"),
    skip: () => T("已跳过", "skipped"),
  };

  /* ── 渲染：步骤表 ── */
  function renderSteps() {
    const list = $("insList");
    if (!list) return;
    const cur = selected || "";
    list.innerHTML = "";
    /* 第一行永远是「全部」：整场安装的日志按真实输出顺序合成一条流。
       默认就停在它上面 —— 安装失败时脚本崩溃的那一整段（含 PowerShell 异常块）
       必须一眼看得见，这是「报错日志不显示」那次的直接教训。 */
    const allLi = document.createElement("li");
    allLi.className = "ins-step is-all" + (cur === "" ? " is-current" : "");
    allLi.dataset.id = "";
    const allIcon = document.createElement("span");
    allIcon.className = "ins-step-icon";
    allIcon.textContent = "≡";
    const allBody = document.createElement("span");
    allBody.className = "ins-step-body";
    const allTitle = document.createElement("span");
    allTitle.className = "ins-step-title";
    allTitle.textContent = T("全部日志", "All output");
    const allMeta = document.createElement("span");
    allMeta.className = "ins-step-meta";
    allMeta.textContent = T("整场安装按输出顺序", "whole install, in output order");
    allBody.appendChild(allTitle);
    allBody.appendChild(allMeta);
    allLi.appendChild(allIcon);
    allLi.appendChild(allBody);
    allLi.onclick = () => { selected = ""; renderSteps(); renderLog(); };
    list.appendChild(allLi);
    for (const s of snap.steps || []) {
      const li = document.createElement("li");
      li.className = "ins-step is-" + s.status + (s.id === cur ? " is-current" : "");
      li.dataset.id = s.id;
      const icon = document.createElement("span");
      icon.className = "ins-step-icon";
      icon.textContent = STATUS_ICON[s.status] || "○";
      const body = document.createElement("span");
      body.className = "ins-step-body";
      const title = document.createElement("span");
      title.className = "ins-step-title";
      title.textContent = esc(s.title || s.id) + (s.optional ? T("（可选）", " (optional)") : "");
      const meta = document.createElement("span");
      meta.className = "ins-step-meta";
      const bits = [STATUS_LABEL[s.status] ? STATUS_LABEL[s.status]() : s.status];
      if (s.startedAt && s.endedAt) bits.push(((s.endedAt - s.startedAt) / 1000).toFixed(1) + "s");
      /* messageText = 主进程按步骤行里的错误码 + 该包 steps.json 的 messages 表解析出的本地化文案
         （脚本本身是纯 ASCII，给人看的失败原因与建议不在脚本里）；老包没有 code 时退回脚本 message。 */
      const stepMsg = s.messageText || s.message;
      if (s.status === "fail" && stepMsg) bits.push(stepMsg);
      else if (s.status === "skip" && stepMsg) bits.push(stepMsg);
      meta.textContent = bits.join(" · ");
      body.appendChild(title);
      body.appendChild(meta);
      li.appendChild(icon);
      li.appendChild(body);
      li.onclick = () => { selected = s.id; renderSteps(); renderLog(); };
      list.appendChild(li);
    }
    const bar = $("insBar");
    if (bar) bar.style.width = Math.max(0, Math.min(100, Number(snap.pct) || 0)) + "%";
  }

  /* ── 渲染：日志（「全部」/ 选中步 / 失败时的日志尾部） ──
     三种内容，一个去处：
       · selected === ""（默认）      → 全部日志（按真实输出顺序，段间带步骤小标题）；
       · selected === "<stepId>"      → 就那一步的日志；
       · 失败 / 取消终局且还停在「全部」→ 只给**最后 240 行**（全量可能几十万行，
         失败现场在尾部；上面两种视图不受影响，仍可点任何一步看它的全部日志）。 */
  let lastLogKey = null; /* 上一次画的「视图键」：同一个视图不再整篇重画（事件追加走 appendLogLine） */
  function viewKey() {
    const failedTail = !running && snap && (snap.state === "failed" || snap.state === "cancelled");
    return selected ? "step:" + selected : failedTail ? "all-tail" : "all";
  }
  function renderLog(force) {
    const pre = $("insLog");
    if (!pre || !snap) return;
    const key = viewKey();
    /* 没换视图就不重画（日志可能很长，整篇重设 textContent 会把用户的滚动位置顶掉）；
       但日志内容变了要靠 force 或 appendLogLine 那条路。 */
    if (!force && key === lastLogKey) return;
    lastLogKey = key;
    if (selected) {
      $("insLogTitle").textContent = T("日志 · ", "log · ") + stepTitle(selected);
      pre.textContent = (snap.logs && snap.logs[selected]) || "";
    } else {
      const failedTail = !running && snap && (snap.state === "failed" || snap.state === "cancelled");
      $("insLogTitle").textContent = failedTail
        ? T("日志 · 全部（末尾 " + ALL_VIEW_TAIL_LINES + " 行）", "log · all (last " + ALL_VIEW_TAIL_LINES + " lines)")
        : T("日志 · 全部", "log · all");
      pre.textContent = allLogText(failedTail ? ALL_VIEW_TAIL_LINES : 0);
    }
    if (follow) pre.scrollTop = pre.scrollHeight;
  }
  function appendLogLine(line) {
    const pre = $("insLog");
    if (!pre) return;
    /* 用户正在看某一步：只追加那一步的行（「全部」视图按真实顺序重排，靠整篇重画） */
    if (!selected) { renderLog(true); return; }
    if (selected !== appendLogLine._bucket) return;
    pre.textContent = pre.textContent ? pre.textContent + "\n" + line : line;
    if (follow) pre.scrollTop = pre.scrollHeight;
  }

  /* ── 渲染：头部 / 底部动作 ── */
  function renderHead() {
    $("insName").textContent = snap ? (snap.name || snap.pluginId) : T("插件安装", "Plugin install");
    const stateTxt = !snap
      ? ""
      : snap.state === "running"
        ? T("安装中…", "installing…")
        : snap.state === "done"
          ? T("安装完成", "finished")
          : snap.state === "cancelled"
            ? T("已取消（你主动终止）", "cancelled (stopped by you)")
            : snap.state === "failed"
              ? T("安装失败", "failed")
              : "";
    const el = $("insState");
    el.textContent = stateTxt;
    el.className = "ins-state is-" + (snap ? snap.state : "");
    const sub = [];
    if (snap && snap.installDir) sub.push(T("安装目录：", "dir: ") + snap.installDir);
    /* 自动建出来的目录：副行给一句回执（用户设过插件根目录就不必自己建文件夹了）。
       只认与当前快照同一个目录的那一次 —— 换了插件 / 换了目录，这句话当场作废。 */
    if (snap && snap.installDir && autoCreatedDir && snap.installDir === autoCreatedDir) {
      sub.push(T("已自动创建（插件根目录 + 默认子目录名）", "auto-created (plugin root + default subfolder)"));
    }
    if (snap && snap.skillName) sub.push(T("修复技能：", "skill: ") + snap.skillName);
    $("insSub").textContent = sub.join("  ·  ");
    $("insDir").textContent = snap && snap.installDir ? snap.installDir : T("尚未确定安装目录", "no install dir yet");
    $("insDir").title = (snap && snap.installDir) || "";
    /* 窗标题跟着当前这次安装走：用户在多只窗之间切换时，任务栏一眼能认出装的是哪个插件 */
    const titleEl = $("insWinTitle");
    if (titleEl)
      titleEl.textContent = T("插件安装", "Plugin install") + (snap ? " · " + (snap.name || snap.pluginId) : "");
  }

  function mkBtn(label, cls, fn, opts) {
    const b = document.createElement("button");
    b.className = "ins-btn" + (cls ? " " + cls : "");
    b.textContent = label;
    if (opts && opts.title) b.title = opts.title;
    b.onclick = fn;
    return b;
  }

  function fullLog() {
    /* 复制 = 复制**眼前这一份**：「全部」视图给整场安装的日志（按输出顺序），
       选中某一步就给那一步的日志。 */
    return selected ? String((snap.logs && snap.logs[selected]) || "") : allLogText(0);
  }

  /* ── 写剪贴板：三级链路（主窗 app-settings.js 的同款口径，跨窗照搬） ──────
     为什么不能只写 navigator.clipboard.writeText：主进程的会话权限闸把 clipboard-write
     一律 callback(false)，未聚焦 / 被拒时渲染层只拿到 NotAllowedError，用户看到的就是
     「复制失败」四个字。preload 桥（mtnodeInstall:clipboard → 主进程 electron clipboard）
     不经这层权限闸，是权限受限时唯一稳的路；两个都不可用时再用 execCommand 兜底。
     返回 { ok, via, error } —— 调用方据此说实话，绝不凭 catch 猜「复制失败」。 */
  function clipboardWrite(text) {
    const txt = String(text == null ? "" : text);
    const execCopy = () => {
      try {
        if (!document.body || !document.execCommand)
          return Promise.resolve({ ok: false, via: "none", error: "no fallback" });
        const ta = document.createElement("textarea");
        ta.value = txt;
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const done = document.execCommand("copy");
        document.body.removeChild(ta);
        return Promise.resolve(
          done ? { ok: true, via: "exec" } : { ok: false, via: "none", error: "execCommand refused" },
        );
      } catch (err) {
        return Promise.resolve({ ok: false, via: "none", error: (err && err.message) || String(err) });
      }
    };
    const ipcCopy = () => {
      /* 走**主窗口既有那条桥**（安装窗只被允许调 INSTALL_API_CHANNELS 白名单里的名字）：
         主进程 electron clipboard，不过渲染层权限闸，权限受限时唯一稳的路。
         回执形状 = 被转发通道的原样回执（{ ok:true } / { ok:false, error }），只认显式的 ok:true。 */
      if (!api || typeof api.api !== "function") return Promise.resolve(null);
      try {
        return Promise.resolve(api.api("clipboardWriteText", [txt])).then((r) =>
          r && r.ok === true ? { ok: true, via: "ipc" } : { ok: false, via: "ipc", error: (r && (r.error || r.message)) || "bridge did not confirm" },
        );
      } catch (err) {
        return Promise.resolve(null);
      }
    };
    let first = null;
    try {
      const nb = navigator && navigator.clipboard;
      if (nb && typeof nb.writeText === "function") first = Promise.resolve(nb.writeText(txt));
    } catch (err) {
      first = null;
    }
    if (first)
      return first.then(
        () => ({ ok: true, via: "navigator" }),
        () => ipcCopy().then((r) => (r && r.ok ? r : execCopy())),
      );
    return ipcCopy().then((r) => (r && r.ok ? r : execCopy()));
  }

  /** 复制失败时的兜底：把日志区整段选中，让用户按 Ctrl+C 自己拿走（不假装复制成功） */
  function selectLogText() {
    try {
      const pre = $("insLog");
      if (!pre) return false;
      const range = document.createRange ? document.createRange() : null;
      if (range && window.getSelection) {
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      }
      if (pre.select) {
        pre.select();
        return true;
      }
    } catch {}
    return false;
  }

  async function copyLog() {
    renderLog(true); /* 先确保眼前这份是当前视图（失败尾部 / 选中步）的最新内容 */
    const text = fullLog();
    if (!text) {
      toast(T("还没有日志可复制", "nothing to copy yet"), "warn");
      return;
    }
    const r = await clipboardWrite(text);
    if (r && r.ok) {
      toast(T("日志已复制", "log copied"));
      return;
    }
    /* 全链路都失败：如实说，并把日志整段选中交给用户自己按 Ctrl+C —— 不只丢一句「复制失败」 */
    const hint = (r && r.error) || "";
    if (selectLogText()) toast(T("自动复制不可用（") + hint + T("）；已全选日志，请按 Ctrl+C"), "err");
    else toast(T("复制失败：请手动选中日志后按 Ctrl+C", "copy failed: select the log and press Ctrl+C") + (hint ? "（" + hint + "）" : ""), "err");
  }

  function renderActions() {
    const box = $("insActions");
    if (!box) return;
    box.innerHTML = "";
    if (!snap) return;
    const id = snap.pluginId;
    const idle = snap.state === "idle" || snap.state === "done";
    /* 硬件门槛逃生阀只对带这道门槛的插件显示（见 FORCE_HW_IDS） */
    const forceBox = $("insForceHwBox");
    if (forceBox) forceBox.hidden = FORCE_HW_IDS.indexOf(id) < 0;
    /* 卸载那一次：同一只窗，按钮换成「确认卸载 / 取消 / 重试」。
       判据除了快照的 mode，还要算上「确认块已展开」—— 点「卸载」是先展开清单、由用户点
       「确认卸载」才走 mode=uninstall 的那份快照，这中间那一拍也得按卸载那组按钮画。 */
    if (inUninstallFlow()) {
      renderUninstallActions(box, id);
      return;
    }
    /* idle（窗开了、安装还没跑）= 用户点「开始安装」才开跑；
       done（上一次跑完了）= 给「重新安装」。两者都是「可以发起安装」的状态。 */
    if (idle) {
      const label =
        snap.state === "done"
          ? T("重新安装", "Install again")
          : snap.action === "update"
            ? T("开始更新", "Start update")
            : T("开始安装", "Start install");
      const btn = mkBtn(label, "primary", () => runInstall());
      btn.id = "insRunBtn";
      box.appendChild(btn);
    }
    if (running) {
      const btn = mkBtn(cancelling ? T("正在停止…", "stopping…") : T("取消安装", "Cancel install"), cancelling ? "" : "", async () => {
        if (cancelling) return;
        /* 即时反馈：先把按钮切成「正在停止…」并置灰 —— 强杀进程树到快照落终局之间的这几秒
           里，界面必须看得出「点了生效了」（若什么反馈都没有，看起来还是像没反应）。 */
        cancelling = true;
        renderActions();
        const r = await api.cancel(id);
        if (!r || !r.ok) {
          cancelling = false;
          toast((r && (r.message || r.error)) || T("取消失败", "cancel failed"), "err");
          renderActions();
          return;
        }
        toast(T("已请求取消：正在停止安装脚本…", "cancel requested: stopping the install script…"));
        /* 终局快照由主进程的 finish 事件推回来（cancelInstall 里已落 cancelled）；
           万一事件丢了，这里用回执里的 state 兜一次刷新。 */
        if (r.state && snap && snap.state === "running") {
          const st = await api.state(id).catch(() => null);
          if (st && st.session) adopt(st.session);
          else renderActions();
        }
      }, { title: T("停掉正在跑的安装脚本（按进程树强杀）", "stop the running install script (kill the process tree)") });
      if (cancelling) btn.disabled = true;
      box.appendChild(btn);
      return;
    }
    /* 失败（或被取消）后：**手动重试**是第一位 —— 重跑该插件的安装脚本，
       已完成的步骤、已下好的文件由脚本自己跳过 / 续传，不重复下载。
       「交给 mtnode 会话修复」保留为次要入口（脚本仍过不去时才需要会话）；
       被取消（cancelled）不列「交给会话修复」：用户自己停的不算故障现场。 */
    if (snap.state === "failed" || snap.state === "cancelled") {
      box.appendChild(mkBtn(T("重试", "Retry"), "primary", () => runInstall(), {
        title: T("重跑该插件的安装（已完成的步骤与已就位的权重会被脚本跳过）", "re-run the install; finished steps and files already in place are skipped"),
      }));
    }
    if (snap.state === "failed") {
      box.appendChild(mkBtn(T("交给 mtnode 会话修复", "Hand to an MTNode session"), "", async () => {
        const r = await api.fix(id);
        if (!r || !r.ok) toast((r && (r.message || r.error)) || T("无法新建修复会话", "cannot open session"), "err");
        else toast(T("已新建修复会话（工作区 = 安装目录）", "repair session created (workspace = install dir)"));
      }, { title: T("脚本重试仍不过时，才新建一条看得见的会话按安装技能修", "only when retry keeps failing: open a visible session that repairs by the install skill") }));
    }
    /* 安装目录：改由本窗统一选与显示（插件控制台窗不再显示安装目录） */
    const pickApi = installApiOf(id).pick;
    if (pickApi) {
      const b = mkBtn(T("选择安装目录", "Choose install dir"), "", async () => {
        const r = await api.api(pickApi, []);
        if (!r || !r.ok) {
          if (r && r.error && r.error !== "cancelled") toast(T("选择安装目录失败：", "pick dir failed: ") + r.error, "err");
          return;
        }
        const st = await api.state(snap.pluginId).catch(() => null);
        if (st && st.session) adopt(st.session);
      }, { title: T("选安装目录（与插件卡片上的「安装」同一条路）", "same dialog as the plugin card's Install") });
      box.appendChild(b);
    }
    if (snap.state === "failed") {
      box.appendChild(mkBtn(T("打开插件控制台", "Open plugin console"), "", async () => {
        const r = await api.openConsole(id);
        if (!r || !r.ok) toast((r && (r.message || r.error)) || T("打开失败", "open failed"), "err");
      }, { title: T("在插件自己的控制台窗里看后端运行日志", "the plugin's own console window (runtime log)") }));
    }
    if (weightsInfo && weightsInfo.supported) {
      box.appendChild(
        mkBtn(
          weightsOpen ? T("收起权重指路", "Hide weight locator") : T("指定权重位置…", "Point to downloaded weights…"),
          weightsOpen ? "primary" : "",
          () => {
            weightsOpen = !weightsOpen;
            renderWeights();
            renderActions();
          },
          { title: T("把已手动下载的权重点给它，由本窗移动到插件期望的位置（只移动，不复制）", "point at manually downloaded weights; this window moves (not copies) them into place") },
        ),
      );
    }
    /* 「卸载」：本窗内唯一的破坏性动作 —— 点它先展开确认清单（删什么 / 留什么），
       确认后才真删。没会话（没开过安装窗）时不显示；正在跑安装 / 卸载时也不显示。 */
    if (!running && !uninRunning) {
      box.appendChild(
        mkBtn(T("卸载", "Uninstall"), "", () => (uninConfirm ? closeUninstall() : openUninstall()), {
          title: T("删掉该插件装在本机的东西（会先给出清单让你确认）", "remove what this plugin installed on this machine (you confirm a list first)"),
        }),
      );
    }
    /* 安装态：上面那些路径都要以「复制日志 / 完成并关闭」收尾（卸载态已在上面的
       renderUninstallActions 里自己收尾并 return 了）。 */
    box.appendChild(mkBtn(T("复制日志", "Copy log"), "", copyLog));
    box.appendChild(mkBtn(running ? T("关闭", "Close") : T("完成并关闭", "Done"), "", () => api.close(id)));
  }

  /** 卸载态的动作按钮：确认 / 取消 / 重试。与安装态共用同一只窗与同一份快照。 */
  function renderUninstallActions(box, id) {
    if (uninRunning) {
      box.appendChild(
        mkBtn(T("正在卸载…", "uninstalling…"), "", async () => {
          const r = await api.uninstall({ action: "cancel", id }).catch(() => null);
          if (!r || !r.ok) toast((r && (r.message || r.error)) || T("取消失败", "cancel failed"), "err");
          else toast(T("已请求取消：正在停手（已删掉的不恢复）", "cancel requested: stopping (files already deleted stay deleted)"));
        }, { title: T("停手：已经删掉的不会恢复", "stop: files already deleted stay deleted") }),
      );
    } else if (uninConfirm) {
      box.appendChild(mkBtn(T("取消", "Cancel"), "", () => closeUninstall()));
      const ok = mkBtn(T("确认卸载", "Uninstall now"), "primary", () => runUninstall({ confirmed: true }), {
        title: T("按上面清单删除（先停后端，再删文件）", "delete the list above (stop the backend, then remove files)"),
      });
      if (snap.state === "running" || injErr) ok.disabled = true;
      box.appendChild(ok);
    } else {
      if (snap.state === "failed" || snap.state === "cancelled") {
        box.appendChild(mkBtn(T("重试", "Retry"), "primary", () => runUninstall({ confirmed: true }), {
          title: T("再跑一次卸载（已经删掉的那些不再处理）", "run the uninstall again (already deleted items are skipped)"),
        }));
      }
      box.appendChild(mkBtn(T("卸载", "Uninstall"), snap.state === "done" ? "primary" : "", () => openUninstall(), {
        title: T("删掉该插件装在本机的东西（会先给出清单让你确认）", "remove what this plugin installed on this machine (you confirm a list first)"),
      }));
      if (snap.state === "failed") {
        box.appendChild(mkBtn(T("打开插件控制台", "Open plugin console"), "", async () => {
          const r = await api.openConsole(id);
          if (!r || !r.ok) toast((r && (r.message || r.error)) || T("打开失败", "open failed"), "err");
        }));
      }
    }
    box.appendChild(mkBtn(T("复制日志", "Copy log"), "", copyLog));
    box.appendChild(mkBtn(T("完成并关闭", "Done"), "", () => api.close(id)));
  }

  function renderAll() {
    const main = $("insMain");
    const foot = $("insFoot");
    /* 没有会话（没在跑 / 没看哪一次安装）：主区域**留空** —— 这块区域只显示「当前这次安装」，
       原先的空态文案已按需求整块移除。窗本身不该在没会话时被开出来（开窗就带一次会话），
       所以这里只是「万一」兜底，不装作有内容。 */
    if (!snap) {
      main.hidden = true;
      foot.hidden = true;
      renderHead();
      renderWeights();
      renderUninstall();
      return;
    }
    main.hidden = false;
    foot.hidden = false;
    running = snap.state === "running";
    renderHead();
    renderSteps();
    renderLog(true);
    renderActions();
    renderWeights();
    renderUninstall();
  }

  /* ── 权重指路：指定已手动下载的位置 → 移动就位（只移动、不复制） ──
     口径（本轮共识）：
       · 入口常驻（安装前 / 中 / 失败后都能用），权重步骤失败时高亮提示；
       · 源只能选目录、可多次添加；目标目录按「插件 + 安装目录」推导，不自选；
       · 自动按各插件已知的仓库结构 / 文件特征匹配，认不出的留在原地并列出；
       · 同名冲突用源覆盖；跨盘退化为复制 + 删除（逐文件，带进度）；
       · 搬完不自动开跑 —— 提示「权重已就位」，由用户点「重试」继续。 */
  let weightsInfo = null; /* { supported, info:{label,slots[]}, sources[], moving, last } */
  let weightsOpen = false;
  let weightsPreview = null;

  function fmtWBytes(n) {
    const x = Number(n) || 0;
    if (x >= 1024 ** 3) return (x / 1024 ** 3).toFixed(2) + " GB";
    if (x >= 1024 ** 2) return (x / 1024 ** 2).toFixed(1) + " MB";
    if (x >= 1024) return (x / 1024).toFixed(0) + " KB";
    return x + " B";
  }

  function renderWeights() {
    const box = $("insWeights");
    if (!box) return;
    const sup = !!(weightsInfo && weightsInfo.supported && snap);
    box.hidden = !sup;
    if (!sup) return;
    const info = weightsInfo.info || { slots: [] };
    $("insWTitle").textContent =
      T("指定权重位置（", "Point to downloaded weights (") + (info.label || weightsInfo.label || "") + "）";
    $("insWToggle").textContent = weightsOpen ? T("收起", "Hide") : T("展开", "Show");
    const body = $("insWBody");
    body.hidden = !weightsOpen;
    if (!weightsOpen) return;
    $("insWNote").textContent = snap.installDir
      ? T(
          "把已手动下载的权重点给它：本窗会把匹配到的文件**移动**到下面的目标目录（不复制）。搬完点「重试」继续安装 —— 脚本会跳过已在的权重、只补缺的。",
          "Point at the directory you downloaded weights into: this window MOVES the matched files (no copy) into the targets below. Then click Retry — the script skips files already in place.",
        )
      : T("先选安装目录：目标位置由安装目录推导。", "Choose an install dir first: targets are derived from it.");
    /* 目标目录 */
    const tl = $("insWTargets");
    tl.innerHTML = "";
    for (const s of info.slots || []) {
      const li = document.createElement("li");
      li.textContent = "· " + (s.label || s.id) + " → " + (s.dir || T("（待选安装目录）", "(no install dir yet)"));
      tl.appendChild(li);
    }
    /* 已选源目录 */
    const sl = $("insWSources");
    sl.innerHTML = "";
    const sources = weightsInfo.sources || [];
    if (!sources.length) {
      const li = document.createElement("li");
      li.textContent = T("（还没指定目录）", "(no directory chosen yet)");
      sl.appendChild(li);
    }
    for (const dir of sources) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "ins-w-src-path";
      span.textContent = dir;
      span.title = dir;
      li.appendChild(span);
      const rm = document.createElement("button");
      rm.className = "ins-mini";
      rm.textContent = T("移除", "Remove");
      rm.onclick = async () => {
        const r = await api.weights({ action: "remove", id: snap.pluginId, dir });
        if (r && !r.error) {
          weightsInfo = r;
          weightsPreview = null;
          renderWeights();
        }
      };
      li.appendChild(rm);
      sl.appendChild(li);
    }
    /* 预览 */
    const pv = $("insWPreview");
    if (weightsPreview && weightsPreview.ok) {
      const lines = [];
      for (const s of weightsPreview.slots || []) {
        lines.push("· " + (s.label || s.id) + "：" + s.count + " 个文件 / " + fmtWBytes(s.bytes));
      }
      lines.push(
        T("合计 ", "total ") + weightsPreview.total.count + T(" 个文件 / ", " files / ") + fmtWBytes(weightsPreview.total.bytes),
      );
      if (weightsPreview.unmatchedCount) {
        lines.push(
          T("未识别（留在原地）：", "unrecognised (left in place): ") +
            weightsPreview.unmatchedCount +
            T(" 项；前几项：", " items; first: ") +
            (weightsPreview.unmatched || []).slice(0, 3).map((u) => u.path).join("；"),
        );
      }
      pv.textContent = lines.join("\n");
      pv.hidden = false;
    } else if (weightsPreview && !weightsPreview.ok) {
      pv.textContent = (weightsPreview.message || weightsPreview.error || "") + "";
      pv.hidden = false;
    } else {
      pv.hidden = true;
    }
    /* 结果 */
    const res = $("insWResult");
    const last = weightsInfo.last;
    if (last) {
      res.className = "ins-w-result" + (last.ok ? "" : " is-err");
      const bits = [
        T("已移动 ", "moved ") + last.moved + T(" 个文件 / ", " files / ") + (last.bytesText || fmtWBytes(last.bytesDone)),
      ];
      if (last.failedCount) {
        bits.push(
          T("失败 ", "failed ") + last.failedCount + T(" 项（", " items (") +
            (last.failed || []).map((f) => f.src + " → " + f.error).slice(0, 2).join("；") + "）",
        );
      }
      if (last.unmatchedCount) bits.push(T("未识别留在原地 ", "left in place ") + last.unmatchedCount + T(" 项", " items"));
      bits.push(last.note || "");
      res.textContent = bits.join("；");
      res.hidden = false;
    } else {
      res.hidden = true;
    }
    /* 按钮可用性 */
    const busy = !!weightsInfo.moving;
    $("insWAdd").disabled = busy || !snap.installDir;
    $("insWScan").disabled = busy || !sources.length;
    $("insWMove").disabled = busy || !sources.length;
    $("insWReset").disabled = busy || !sources.length;
    $("insWCancel").hidden = !busy;
  }

  async function weightsAction(action, extra) {
    if (!snap) return null;
    /* 「移动到就位」要先有落点：目录为空时搬运只会在宿主机那侧报错，这里先把目录落地那一拍
       走一遍（本轮共识：安装 / 权重 / 卸载三条链共用同一份口径）。 */
    if (action === "move" && (await ensureDirFor(snap.pluginId, {}))) return null;
    const r = await api
      .weights(Object.assign({ action, id: snap.pluginId }, extra || {}))
      .catch(() => null);
    if (r && (action === "scan" || action === "move")) return r;
    if (r && !r.error) {
      weightsInfo = r;
      renderWeights();
      renderActions();
    }
    return r;
  }

  $("insWToggle").onclick = () => {
    weightsOpen = !weightsOpen;
    renderWeights();
    renderActions();
  };
  $("insWAdd").onclick = async () => {
    const r = await api.weights({ action: "pick", id: snap ? snap.pluginId : "" }).catch(() => null);
    if (r && r.cancelled) return;
    if (r && !r.error) {
      weightsInfo = r;
      weightsPreview = null;
      renderWeights();
      renderActions();
    } else if (r && r.message) toast(r.message, "err");
  };
  $("insWScan").onclick = async () => {
    $("insWScan").disabled = true;
    const r = await weightsAction("scan");
    if (r && r.ok) {
      weightsPreview = r;
      renderWeights();
    } else {
      weightsPreview = r || { ok: false, message: T("扫描失败", "scan failed") };
      renderWeights();
    }
  };
  $("insWMove").onclick = async () => {
    const r = await weightsAction("move");
    if (r && r.ok && r.started) {
      toast(T("开始搬运（只移动，不复制）", "moving (no copy)"));
      const st = await api.weights({ action: "info", id: snap.pluginId }).catch(() => null);
      if (st) weightsInfo = st;
      renderWeights();
    } else if (r) {
      toast((r && (r.message || r.error)) || T("搬运失败", "move failed"), "err");
    }
  };
  $("insWCancel").onclick = async () => {
    const r = await api.weights({ action: "cancel", id: snap.pluginId }).catch(() => null);
    if (!r || !r.ok) toast((r && (r.message || r.error)) || T("取消失败", "cancel failed"), "err");
    else toast(T("已请求取消（已搬完的留在目标目录）", "cancel requested (files already moved stay)"));
  };
  $("insWReset").onclick = async () => {
    weightsPreview = null;
    await weightsAction("reset");
  };
  api.onWeights((ev) => {
    if (!ev || !snap || ev.id !== snap.pluginId) return;
    if (ev.kind === "progress") {
      const prog = $("insWProg");
      if (prog) {
        prog.hidden = false;
        const pct = ev.bytesTotal ? Math.round((ev.bytesDone / ev.bytesTotal) * 100) : Math.round((ev.index / Math.max(1, ev.count)) * 100);
        setBar(prog, pct);
      }
      $("insWResult").hidden = false;
      $("insWResult").className = "ins-w-result";
      $("insWResult").textContent =
        T("搬运中 ", "moving ") + ev.index + "/" + ev.count + " · " + fmtWBytes(ev.bytesDone) + " / " + fmtWBytes(ev.bytesTotal);
      return;
    }
    if (ev.kind === "done") {
      $("insWProg").hidden = true;
      weightsInfo = Object.assign({}, weightsInfo || {}, { moving: false, last: ev.last });
      weightsPreview = null;
      renderWeights();
      renderActions();
      toast(
        ev.last && ev.last.cancelled
          ? T("搬运已取消", "move cancelled")
          : T("权重已就位 —— 点「重试」继续安装", "weights in place — click Retry to continue"),
      );
    }
  });

  /* ── 事件 ── */
  function adopt(next) {
    if (!next || next.empty) {
      snap = null;
      cancelling = false;
      autoCreatedDir = "";
      uninRunning = false;
      uninConfirm = false;
      uninPrev = null;
      injErr = null;
      resetLogOrder();
      renderAll();
      return;
    }
    const prevId = adopt._id;
    snap = next;
    if (!snap.logs) snap.logs = {};
    /* 快照落成终局（done / failed / cancelled）＝ 这次取消已经有了结果，按钮不再停在「正在停止…」 */
    if (snap.state !== "running") cancelling = false;
    /* 卸载那一次同理：终局 = 这一趟跑完了，动作按钮回到「卸载 / 重试」那一组 */
    if (snap.state !== "running") uninRunning = false;
    /* 换插件（或重开窗）时把选区与日志序号表归零：「全部」视图默认摆给用户看；
       权重现场也当场作废 —— 先清再画，免得新插件头上还挂着上一个插件的权重区块
       （真实回执带 id，回来后自己会补上）。 */
    const switched = prevId !== snap.pluginId;
    if (switched) {
      adopt._id = snap.pluginId;
      selected = "";
      autoCreatedDir = "";
      weightsPreview = null;
      weightsInfo = null;
      weightsOpen = false;
      /* 卸载确认块也当场作废：新插件头上不该挂着上一个插件的卸载清单 */
      uninConfirm = false;
      uninPrev = null;
      injErr = null;
      uninRunning = false;
      resetLogOrder();
    }
    syncLogOrderFromSnap();
    renderAll();
    if (switched) {
      api.weights({ action: "info", id: snap.pluginId })
        .then((r) => {
          if (r && !r.error && snap && snap.pluginId === r.id) {
            weightsInfo = r;
            renderWeights();
            renderActions();
          }
        })
        .catch(() => {});
    }
  }

  api.onState((payload) => adopt(payload));

  api.onEvent((ev) => {
    if (!ev || !snap || ev.id !== snap.pluginId) return;
    if (ev.kind === "step" && ev.step) {
      const i = Number(ev.stepIndex);
      if (i >= 0 && snap.steps[i]) snap.steps[i] = ev.step;
      else if (!stepOf(ev.step.id)) snap.steps.push(ev.step);
      else snap.steps = snap.steps.map((s) => (s.id === ev.step.id ? ev.step : s));
      snap.state = ev.state || snap.state;
      snap.pct = Number.isFinite(ev.pct) ? ev.pct : snap.pct;
      snap.error = ev.error || snap.error;
      renderSteps();
      renderLog();
      renderHead();
      return;
    }
    if (ev.kind === "log") {
      const key = pushLogText(ev.stepId, String(ev.line || ""), ev.seq);
      /* 用户切到别的步骤时不打断他：只有「正看着这一步」或「看着全部」才动日志区 */
      appendLogLine._bucket = key;
      if (!selected || selected === key) appendLogLine(String(ev.line || ""));
      return;
    }
    if (ev.kind === "finish" && ev.session) {
      /* 终局快照走 adopt（它负责把「正在停止…」复位并整屏重画）——
         失败时日志区随之切到「全部（末尾 240 行）」，脚本崩溃那一段默认就在眼前。 */
      adopt(ev.session);
      const tail = snap && snap.state === "failed" ? (snap.error || "") : "";
      if (tail) $("insLogTitle").title = tail;
    }
  });

  /* 日志跟随开关 / 复制 / 关闭 */
  $("btnLogFollow").onclick = () => {
    follow = !follow;
    $("btnLogFollow").className = "ins-mini" + (follow ? " is-on" : "");
    if (follow) renderLog();
  };
  $("btnLogFollow").className = "ins-mini is-on";
  $("btnLogCopy").onclick = copyLog;
  $("btnClose").onclick = () => api.close(snap ? snap.pluginId : "");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") api.close(snap ? snap.pluginId : "");
  });

  /* 首帧：窗可能比主进程的 begin 早/晚，两头都兜 */
  api.state("").then((r) => {
    if (r && r.session) adopt(r.session);
    else adopt(null);
  }).catch(() => adopt(null));
})();

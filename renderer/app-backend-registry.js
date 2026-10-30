"use strict";
/**
 * 重后端注册中心 · 渲染层
 *
 * 与插件体系并存：插件是官方功能的入口，这里管 Agent 在任务里现场装出来的工具。
 * 本文件提供两样东西：
 *   ① mkPagedBlock —— 插件页的通用「最多 2 行 + 翻页」分页器（商店插件 / 注册中心 / 自建插件
 *      三块各用一套，互不影响；卡片一次建好，翻页只换显示的那一段，刷新闭包不会指到旧节点）；
 *   ② buildBackendRegistryBlock —— 插件页第二块（注册中心）的卡片区 + 详情 / 登记浮层。
 *
 * 数据全部经 window.api.backendRegistry* 走主进程（main-backend-registry.js），
 * 渲染层不碰进程、不判断「装没装」—— 状态行只回显主进程给的 state。
 */

/* ── ① 通用分页器（每页 = 列数 × rows 行；列数按容器宽度算） ─────────────── */
function mkPagedBlock(items, buildCard, opts) {
  const o = opts || {};
  const minW = Math.max(80, Number(o.minWidth) || 132);
  const gap = Math.max(0, Number(o.gap) || 8);
  const rows = Math.max(1, Number(o.rows) || 2);
  const gridClass = o.gridClass || "plugin-grid";
  const block = document.createElement("div");
  block.className = "pg-block";
  const grid = document.createElement("div");
  grid.className = gridClass;
  const pager = document.createElement("div");
  pager.className = "pg-pager";
  block.appendChild(grid);
  block.appendChild(pager);

  let list = (items || []).slice();
  let cards = [];
  let page = 0;
  let cols = 4;
  let disposed = false;

  function buildAll() {
    cards = [];
    for (const it of list) {
      try {
        const c = buildCard(it);
        if (c) cards.push(c);
      } catch (err) {
        console.warn("[backend-registry] 卡片构建失败", it && it.id, err);
      }
    }
  }
  function calcCols() {
    const w = grid.clientWidth || block.clientWidth || 0;
    if (!w) return cols;
    return Math.max(1, Math.min(12, Math.floor((w + gap) / (minW + gap))));
  }
  function render() {
    if (disposed) return;
    const perPage = Math.max(1, cols * rows);
    const pages = Math.max(1, Math.ceil(cards.length / perPage));
    if (page > pages - 1) page = pages - 1;
    if (page < 0) page = 0;
    const start = page * perPage;
    grid.replaceChildren(...cards.slice(start, start + perPage));
    pager.hidden = pages <= 1;
    pager.replaceChildren();
    if (pages <= 1) return;
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "mini";
    prev.textContent = "‹";
    prev.title = I18n.t("上一页");
    prev.disabled = page <= 0;
    prev.onclick = () => {
      page--;
      render();
    };
    const label = document.createElement("span");
    label.textContent = page + 1 + " / " + pages;
    const next = document.createElement("button");
    next.type = "button";
    next.className = "mini";
    next.textContent = "›";
    next.title = I18n.t("下一页");
    next.disabled = page >= pages - 1;
    next.onclick = () => {
      page++;
      render();
    };
    pager.appendChild(prev);
    pager.appendChild(label);
    pager.appendChild(next);
  }
  const onResize = () => {
    const c = calcCols();
    if (c !== cols) {
      cols = c;
      render();
    }
  };

  buildAll();
  cols = calcCols();
  render();
  window.addEventListener("resize", onResize);
  /* 块往往是**先建好、后挂载**（对话框拼装顺序）：挂载前 clientWidth = 0，
     没有这一步就会一直按默认列数排。列数一变立刻重排。 */
  let ro = null;
  try {
    ro = new ResizeObserver(() => onResize());
    ro.observe(block);
  } catch {}

  return {
    el: block,
    grid,
    /** 换一批条目：卡片全部重建（注册中心刷新走它） */
    setItems(next) {
      list = (next || []).slice();
      buildAll();
      page = 0;
      cols = calcCols();
      grid.replaceChildren();
      render();
    },
    refresh: render,
    /** 遍历**全部**条目上的卡片（不只是当前页）：状态变化时统一重绘用 */
    eachCard(fn) {
      for (const c of cards) {
        try {
          fn(c);
        } catch {}
      }
    },
    dispose() {
      disposed = true;
      window.removeEventListener("resize", onResize);
      try {
        if (ro) ro.disconnect();
      } catch {}
    },
  };
}

/* ── ② 重后端注册中心 ─────────────────────────────────────────────── */

const BR_KIND_LABEL = { http: "HTTP", cli: "CLI" };
const BR_STATE_LABEL = {
  running: "运行中",
  starting: "启动中",
  error: "异常",
  stopped: "已停止",
  adopted: "接管",
  stateless: "免启动",
};
function brStateCls(st) {
  if (st === "running" || st === "adopted") return "on";
  if (st === "starting" || st === "stateless") return "warn";
  if (st === "error") return "err";
  return "";
}
function brTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts || "");
  }
}
function brEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * 插件页第二块。opts.onChanged：这批条目变了（通知外层计数 / 重新渲染用）。
 * 返回 { el, refresh, dispose }。
 */
function buildBackendRegistryBlock(opts) {
  const o = opts || {};
  let items = [];
  let plugins = [];
  let pager = null;
  let pop = null;
  const sec = brEl("section", "br-sec");
  const head = brEl("div", "br-head");
  const title = brEl("h4", null, I18n.t("重后端注册中心"));
  const count = brEl("span", "br-count", "");
  const note = brEl(
    "div",
    "br-note",
    I18n.t("全局共享：Agent 在任务里装完会自动登记，下一次任务直接复用（会话 / 智能节点 / 画布助手都能查到）。这里只负责安装 / 启停 / 调用 / 卸载与留痕；插件里的本机后端（视频 / 音乐 / 语音 / 渲染 / 数字人 / 出图）也在本节只读列出，启停仍在上面插件卡片。"),
  );
  const addBtn = brEl("button", "mini", I18n.t("＋ 登记工具"));
  addBtn.title = I18n.t("手动登记一个本机工具（也可以让 Agent 自己登记）");
  addBtn.onclick = () => openForm(null);
  const refreshBtn = brEl("button", "mini", I18n.t("刷新"));
  refreshBtn.onclick = () => void refresh();
  head.append(title, count, note, addBtn, refreshBtn);
  const body = brEl("div");
  /* 插件后端（只读镜像）：items 是 Agent 现场登记的，plugins 是插件宿主管的 —— 两处
     一起看才是本机全貌（Agent 侧 br_admin list 收到的是同一份数据）。 */
  const pluginLine = brEl("div", "br-note br-plugins", "");
  sec.append(head, body, pluginLine);

  function getPop() {
    if (pop && pop.isConnected) return pop;
    pop = brEl("div", "br-pop");
    pop.setAttribute("role", "dialog");
    pop.addEventListener("click", (e) => e.stopPropagation());
    /* 挂在 #overlay 里（与插件自己的 .plugin-pop 同一层）：插件对话框本身就是一只全屏
       overlay，浮层挂在 body 上会被它整块盖住（z-index 比不过 overlay 的层叠上下文，
       真机上表现为「点了卡片什么都没弹」）。overlay 一关，浮层跟着一起没了。 */
    const host = document.getElementById("overlay") || document.body;
    host.appendChild(pop);
    return pop;
  }
  function closePop() {
    if (pop) {
      pop.classList.remove("on");
      pop.replaceChildren();
    }
  }
  let popEsc = null;
  function showPop(role) {
    const p = getPop();
    p.classList.add("on");
    p.style.left = "50%";
    p.style.top = "50%";
    p.style.transform = "translate(-50%, -50%)";
    if (!popEsc) {
      popEsc = (ev) => {
        if (ev.key !== "Escape") return;
        if (!pop || !pop.classList.contains("on")) return;
        ev.preventDefault();
        ev.stopPropagation();
        closePop();
      };
      document.addEventListener("keydown", popEsc, true);
    }
    return p;
  }
  function popHead(p, text) {
    const h = brEl("h3");
    h.append(brEl("span", null, text));
    const x = brEl("button", "mini", "✕");
    x.title = I18n.t("关闭");
    x.onclick = closePop;
    h.append(x);
    p.append(h);
    return h;
  }
  function field(p, label, el) {
    const f = brEl("div", "br-field");
    f.append(brEl("label", null, label), el);
    p.append(f);
    return el;
  }
  function input(ph, value) {
    const i = document.createElement("input");
    i.type = "text";
    i.placeholder = ph || "";
    i.value = value == null ? "" : String(value);
    return i;
  }
  function area(ph, value) {
    const t = document.createElement("textarea");
    t.placeholder = ph || "";
    t.value = value == null ? "" : String(value);
    return t;
  }
  function select(options, value) {
    const s = document.createElement("select");
    for (const it of options) {
      const op = document.createElement("option");
      op.value = it[0];
      op.textContent = it[1];
      s.append(op);
    }
    s.value = value;
    return s;
  }

  /* ── 详情浮层（含调用测试 / 日志 / 留痕 / 卸载） ── */
  async function openDetail(it) {
    const p = showPop("detail");
    p.replaceChildren();
    popHead(p, it.name + " · " + (BR_KIND_LABEL[it.kind] || it.kind));

    const kv = brEl("div", "br-kv");
    kv.append(
      brEl("div", null, "id: " + it.id + " · tool: " + it.toolName),
      brEl("div", null, "状态: " + (BR_STATE_LABEL[it.state] || it.state) + (it.port ? " · 端口 " + it.port : "") + (it.pid ? " · pid " + it.pid : "")),
      brEl("div", null, "来源: " + (it.source === "adopted" ? I18n.t("接管本机已有") : I18n.t("注册中心安装")) + " · 互斥: " + ((it.lock && it.lock.class) || "cpu")),
      brEl("div", null, "目录: " + ((it.install && it.install.dir) || "—")),
      brEl("div", null, "登记: " + brTime(it.createdAt) + " · 更新: " + brTime(it.updatedAt)),
    );
    if (it.source === "adopted") kv.append(brEl("div", null, "baseUrl: " + ((it.adopt && it.adopt.baseUrl) || "")));
    if (it.launch) kv.append(brEl("div", null, "启动: " + (it.launch.cmd || []).join(" ")));
    if (it.cli) kv.append(brEl("div", null, "命令: " + (it.cli.cmd || []).join(" ")));
    if (it.kind === "http") kv.append(brEl("div", null, "调用: " + ((it.call && it.call.method) || "POST") + " " + ((it.call && it.call.path) || "/")));
    kv.append(brEl("div", null, "描述: " + it.desc));
    p.append(kv);
    if (it.lastError) p.append(brEl("div", "br-err", it.lastError));

    /* 调用测试：参数按 args 表拼 JSON，直接打到主进程 */
    const argsBox = area("调用参数 JSON（按登记的参数表填）", "{}");
    const out = brEl("pre", "br-log", "");
    if (it.kind === "cli") {
      field(p, I18n.t("参数（JSON 对象，键与参数名一致）"), argsBox);
    } else {
      field(p, I18n.t("调用参数（JSON 对象；http 会以 JSON body 发出）"), argsBox);
    }
    const runBtn = brEl("button", "mini", I18n.t("调用一次"));
    runBtn.onclick = async () => {
      let args = {};
      try {
        args = argsBox.value.trim() ? JSON.parse(argsBox.value) : {};
      } catch (err) {
        out.textContent = I18n.t("参数不是合法 JSON：") + ((err && err.message) || err);
        return;
      }
      out.textContent = I18n.t("调用中…");
      const r = await window.api.backendRegistryCall({ id: it.id, args });
      out.textContent = JSON.stringify(r, null, 2);
      void refresh();
    };
    const logBtn = brEl("button", "mini", I18n.t("看日志"));
    logBtn.onclick = async () => {
      const r = await window.api.backendRegistryLog({ id: it.id, lines: 120 });
      out.textContent = (r && r.text) || I18n.t("（没有日志）");
    };
    const auditBtn = brEl("button", "mini", I18n.t("看留痕"));
    auditBtn.onclick = async () => {
      const r = await window.api.backendRegistryAudit({ id: it.id, limit: 40 });
      const list = (r && r.items) || [];
      out.textContent = list.length
        ? list
            .map((a) => brTime(a.ts) + " · " + a.action + " · " + (a.actor || "") + (a.ok === false ? " ✕ " + (a.error || "") : "") + (a.detail ? " · " + a.detail : ""))
            .join("\n")
        : I18n.t("（没有留痕）");
    };
    const acts = brEl("div", "br-actions");
    acts.append(runBtn, logBtn, auditBtn);
    p.append(acts, out);

    const actions = brEl("div", "br-actions");
    if (it.kind === "http") {
      if (it.state === "running" || it.state === "starting") {
        const stopBtn = brEl("button", "mini", I18n.t("停止"));
        stopBtn.onclick = async () => {
          await window.api.backendRegistryStop(it.id);
          toast(I18n.t("已停止：") + it.name, "ok");
          closePop();
          void refresh();
        };
        actions.append(stopBtn);
      } else {
        const startBtn = brEl("button", "mini", I18n.t("启动"));
        startBtn.onclick = async () => {
          const r = await window.api.backendRegistryStart(it.id);
          if (r && r.ok) toast(I18n.t("已启动：") + it.name + (r.port ? " · " + r.port : ""), "ok");
          else toast(I18n.t("启动失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
          closePop();
          void refresh();
        };
        actions.append(startBtn);
      }
    }
    const dirBtn = brEl("button", "mini", I18n.t("打开目录"));
    dirBtn.onclick = () => window.api.backendRegistryOpenDir(it.id);
    const editBtn = brEl("button", "mini", I18n.t("编辑"));
    editBtn.onclick = () => openForm(it);
    const delBtn = brEl("button", "mini", I18n.t("卸载"));
    delBtn.title = I18n.t("停服务 + 删登记；磁盘文件要勾选才删");
    delBtn.onclick = () => openRemove(it);
    actions.append(dirBtn, editBtn, delBtn);
    p.append(actions);
  }

  /* ── 卸载确认（磁盘文件单独勾选） ── */
  function openRemove(it) {
    const p = showPop("remove");
    p.replaceChildren();
    popHead(p, I18n.t("卸载：") + it.name);
    p.append(
      brEl(
        "div",
        "br-kv",
        I18n.t("默认只做两件事：停掉服务、删掉这条登记。磁盘文件不动 —— 有些工具装在共享目录里，删了会连累别的东西。"),
      ),
    );
    const dir = (it.install && it.install.dir) || "";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const lab = brEl("label", null, " ");
    const wrap = brEl("div", "br-field");
    wrap.append(cb, lab);
    if (dir) {
      lab.textContent = I18n.t("同时删除磁盘目录：") + dir;
    } else {
      cb.disabled = true;
      lab.textContent = I18n.t("这条登记没有记录安装目录，磁盘文件不会被删");
    }
    p.append(wrap);
    const acts = brEl("div", "br-actions");
    const cancel = brEl("button", "mini", I18n.t("取消"));
    cancel.onclick = closePop;
    const ok = brEl("button", "mini", I18n.t("确认卸载"));
    ok.onclick = async () => {
      const r = await window.api.backendRegistryRemove({ id: it.id, deleteFiles: !!cb.checked });
      if (r && r.ok) {
        toast(I18n.t("已卸载：") + it.name + (r.warn ? " · " + r.warn : ""), r.warn ? "warn" : "ok");
      } else {
        toast(I18n.t("卸载失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
      }
      closePop();
      void refresh();
    };
    acts.append(cancel, ok);
    p.append(acts);
  }

  /* ── 登记 / 编辑表单 ── */
  function openForm(it) {
    const cur = it || {};
    const p = showPop("form");
    p.replaceChildren();
    popHead(p, it ? I18n.t("编辑：") + cur.name : I18n.t("登记一个本机工具"));

    const row1 = brEl("div", "br-row");
    const fId = field(row1, "id（字母/数字/. _ -）", input("whisperx", cur.id));
    const fName = field(row1, I18n.t("名称"), input(I18n.t("WhisperX 词级对齐"), cur.name));
    p.append(row1);

    const row2 = brEl("div", "br-row");
    const fKind = field(row2, I18n.t("形态"), select([["http", "HTTP 常驻服务"], ["cli", "一次性命令行"]], cur.kind || "http"));
    const fSource = field(row2, I18n.t("来源"), select([["managed", I18n.t("注册中心安装")], ["adopted", I18n.t("接管本机已有")]], cur.source || "managed"));
    const fLock = field(row2, "lock.class", select([["cpu", "cpu"], ["gpu", "gpu"], ["none", "none（不参与互斥）"]], (cur.lock && cur.lock.class) || "cpu"));
    p.append(row2);

    const fDesc = field(p, I18n.t("工具描述（Agent 靠它判断什么时候用这个工具）"), area("", cur.desc));

    const launchCmd = cur.launch && cur.launch.cmd ? cur.launch.cmd : [];
    const cliCmd = cur.cli && cur.cli.cmd ? cur.cli.cmd : [];
    const fCmd = field(
      p,
      I18n.t("命令（一行一段；http 可用 {port} {dir}，cli 可用 {参数名}）"),
      area("{dir}\\venv\\python.exe\n-m\nwx_server\n--port\n{port}", (cur.kind === "cli" ? cliCmd : launchCmd).join("\n")),
    );

    const row3 = brEl("div", "br-row");
    const fBase = field(row3, I18n.t("baseUrl（接管已在跑的服务时填）"), input("http://127.0.0.1:8000", (cur.adopt && cur.adopt.baseUrl) || ""));
    const fPorts = field(
      row3,
      I18n.t("端口范围"),
      input("17800-17899", cur.launch && cur.launch.portRange ? cur.launch.portRange.join("-") : "17800-17899"),
    );
    p.append(row3);

    const row4 = brEl("div", "br-row");
    const fHealth = field(row4, I18n.t("健康检查路径"), input("/health", (cur.launch && cur.launch.health && cur.launch.health.path) || "/health"));
    const fCallPath = field(row4, I18n.t("调用路径"), input("/", (cur.call && cur.call.path) || "/"));
    p.append(row4);

    const row5 = brEl("div", "br-row");
    const fDir = field(row5, I18n.t("安装 / 工作目录"), input("", (cur.install && cur.install.dir) || ""));
    const pick = brEl("button", "mini", I18n.t("选择…"));
    pick.onclick = async () => {
      const r = await window.api.backendRegistryPickDir();
      if (r && r.ok) fDir.value = r.dir;
    };
    const pickWrap = brEl("div", "br-field");
    pickWrap.append(pick);
    row5.append(pickWrap);
    p.append(row5);

    const fArgs = field(
      p,
      I18n.t("参数表（JSON 数组：名称 / 类型 / 是否必填 / 说明）"),
      area(
        '[{"name":"audio","kind":"text","required":true,"desc":"音频文件绝对路径"}]',
        JSON.stringify(cur.args || [], null, 1),
      ),
    );

    const err = brEl("div", "br-err", "");
    const acts = brEl("div", "br-actions");
    const cancel = brEl("button", "mini", I18n.t("取消"));
    cancel.onclick = closePop;
    const save = brEl("button", "mini", I18n.t("保存登记"));
    save.onclick = async () => {
      let args = [];
      try {
        args = fArgs.value.trim() ? JSON.parse(fArgs.value) : [];
      } catch (e2) {
        err.textContent = I18n.t("参数表不是合法 JSON：") + ((e2 && e2.message) || e2);
        return;
      }
      const kind = fKind.value;
      const cmd = fCmd.value
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const baseUrl = fBase.value.trim();
      const ports = fPorts.value.split(/[-:,\s]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
      const item = {
        id: fId.value.trim(),
        name: fName.value.trim(),
        kind,
        desc: fDesc.value.trim(),
        args,
        source: fSource.value,
        lock: { class: fLock.value },
        install: { dir: fDir.value.trim() },
      };
      if (kind === "cli") item.cli = { cmd };
      else {
        if (baseUrl) item.adopt = { baseUrl };
        if (cmd.length) {
          item.launch = {
            cmd,
            portRange: ports.length >= 2 ? [ports[0], ports[1]] : undefined,
            health: { path: fHealth.value.trim() || "/health" },
          };
        }
        item.call = { path: fCallPath.value.trim() || "/", method: "POST" };
      }
      const r = await window.api.backendRegistryUpsert({ item, actor: "user" });
      if (!r || !r.ok) {
        err.textContent = I18n.t("保存失败：") + ((r && r.error) || I18n.t("未知错误"));
        return;
      }
      toast(I18n.t("已登记：") + item.name, "ok");
      closePop();
      void refresh();
    };
    acts.append(cancel, save);
    p.append(err, acts);
  }

  /* ── 卡片 ── */
  function mkCard(it) {
    const card = brEl("div", "br-card");
    card.setAttribute("data-br-id", it.id);
    const logo = brEl("div", "br-logo", String(it.name || it.id || "?").slice(0, 1));
    const main = brEl("div", "br-main");
    const name = brEl("div", "br-name", it.name);
    name.title = it.desc || "";
    const meta = brEl("div", "br-meta");
    const stSpan = brEl("span", "br-state");
    stSpan.append(brEl("i", "br-dot " + brStateCls(it.state)), brEl("span", null, BR_STATE_LABEL[it.state] || it.state || ""));
    meta.append(stSpan, brEl("span", null, BR_KIND_LABEL[it.kind] || it.kind));
    if (it.source === "adopted") meta.append(brEl("span", null, I18n.t("接管")));
    if (it.port) meta.append(brEl("span", null, ":" + it.port));
    const acts = brEl("div", "br-acts");
    if (it.kind === "http") {
      if (it.state === "running" || it.state === "starting") {
        const b = mkPluginActBtn("stop", I18n.t("停止"), async () => {
          await window.api.backendRegistryStop(it.id);
          void refresh();
        });
        acts.append(b);
      } else {
        const b = mkPluginActBtn("play", I18n.t("启动"), async () => {
          const r = await window.api.backendRegistryStart(it.id);
          if (r && r.ok) toast(I18n.t("已启动：") + it.name, "ok");
          else toast(I18n.t("启动失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
          void refresh();
        });
        acts.append(b);
      }
    }
    const callBtn = mkPluginActBtn("console", I18n.t("详情 / 调用 / 日志"), () => void openDetail(it));
    acts.append(callBtn);
    main.append(name, meta, acts);
    card.append(logo, main);
    card.onclick = (ev) => {
      if (ev.target.closest(".br-acts")) return;
      void openDetail(it);
    };
    return card;
  }

  async function refresh() {
    const r = await window.api.backendRegistryList();
    items = (r && r.ok && r.items) || [];
    plugins = (r && Array.isArray(r.plugins) && r.plugins) || [];
    count.textContent = items.length ? items.length + " " + I18n.t("个") : I18n.t("空");
    /* 插件后端那一行：只读镜像（装没装 + 目录），一个都没有就整行不占地方 */
    if (!plugins.length) {
      pluginLine.textContent = "";
      pluginLine.style.display = "none";
    } else {
      const installed = plugins.filter((p) => p.installed).length;
      pluginLine.style.display = "";
      pluginLine.textContent =
        I18n.t("插件后端") +
        "（" +
        I18n.t("只读 · 启停在插件卡片") +
        "）：" +
        I18n.t("已安装") +
        " " +
        installed +
        "/" +
        plugins.length +
        " · " +
        plugins
          .map((p) => p.name + "：" + (p.installed ? I18n.t("已安装") : I18n.t("未安装")))
          .join(" · ");
      pluginLine.title = plugins
        .map((p) => p.name + "（" + p.id + "）" + (p.installDir ? "\n" + p.installDir : ""))
        .join("\n\n");
    }
    body.replaceChildren();
    if (!items.length) {
      const empty = brEl("div", "br-empty");
      empty.textContent = I18n.t(
        "还没有登记任何工具。Agent 在任务里需要什么就装什么，装完会登记到这里（全程留痕）；你也可以点右上角「＋ 登记工具」手动加入一个。这一栏为 0 是正常的 —— 它只放 Agent 现场登记的额外后端，插件里的后端看下面那一行。",
      );
      body.append(empty);
      if (pager) {
        pager.dispose();
        pager = null;
      }
      if (typeof o.onChanged === "function") o.onChanged();
      return;
    }
    if (!pager) {
      pager = mkPagedBlock(items, mkCard, { minWidth: 196, gap: 8, rows: 2, gridClass: "br-grid" });
    } else {
      pager.setItems(items);
    }
    /* 必须重新 append：上面的 body.replaceChildren() 已经把 pager.el 从 DOM 里摘掉了，
       只 setItems 不挂回去的话，第二次刷新（比如调用一次之后）整块网格会凭空消失。 */
    body.append(pager.el);
    if (typeof o.onChanged === "function") o.onChanged();
  }

  void refresh();
  return {
    el: sec,
    refresh,
    dispose() {
      if (pager) pager.dispose();
      if (popEsc) document.removeEventListener("keydown", popEsc, true);
      if (pop && pop.parentNode) pop.remove();
    },
  };
}

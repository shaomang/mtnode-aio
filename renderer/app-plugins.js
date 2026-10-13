"use strict";
/* ============ 顶栏「插件」：可选组件（桌宠等） ============ */
/* 插件对话框打开期间挂上的订阅退订口（控制台开合 / notice / 安装终局重画）——
   卡片上的安装进度订阅已随本轮需求整块下线，这里收的就只剩这些。 */
let _petProgressOff = null;
/* 用户自建插件（<数据目录>/user-plugins）的清单缓存：卡片与详情面板都按 id 从这里取 */
let _userPluginItems = [];
/* ── 安装后自检现状（本轮需求）────────────────────────────────────────────────
   卡片封面左上角的勾角标 = 该插件**最近一次自检通过**（真出过一次最小内容）。
   真源是主进程 plugins/plugin-selfcheck.js 落的数据目录结果；这里只缓存一份快照，
   打开插件界面时拉一次、安装窗跑完一次安装后再拉一次 —— 绝不在渲染层自己编结论。 */
let _pluginCheckState = { ok: false, checks: {} };
/* 勾（16 viewBox，与顶栏那批线性图标同风格） */
const PLUGIN_DONE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.6l3 3 6.2-7.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
async function loadPluginCheckState() {
  const fn = window.api && window.api.pluginSelfcheckSummary;
  if (typeof fn !== "function") return _pluginCheckState;
  try {
    const r = await fn();
    if (r && typeof r === "object") _pluginCheckState = r;
  } catch {}
  return _pluginCheckState;
}
/** 该插件 id 的自检记录（没登记 / 没测过 → null） */
function pluginCheckOf(id) {
  const m = (_pluginCheckState && _pluginCheckState.checks) || {};
  return m[String(id || "")] || null;
}
function pluginCheckPassed(id) {
  const c = pluginCheckOf(id);
  return !!(c && c.passed);
}
/** 勾上的那行提示：通过时间 + 产物路径（鼠标停一下看得见结论从哪来） */
function pluginCheckTip(id) {
  const c = pluginCheckOf(id);
  const r = c && c.result;
  if (!r) return "";
  const when = r.at ? new Date(r.at).toLocaleString() : "";
  const arts = ((r.artifacts || [])[0] || {}).path || r.artifactDir || "";
  return (
    I18n.t("安装后自检通过") +
    (when ? " · " + when : "") +
    (arts ? "\n" + I18n.t("自检产物：") + arts : "")
  );
}
/** 把勾画到（或从）卡片上：只给自检通过的卡片一个勾，其余一律不显示 */
function paintPluginDone(card, id) {
  if (!card) return;
  const old = card.querySelector(".plugin-tile-done");
  const pass = pluginCheckPassed(id);
  if (!pass) {
    if (old) old.remove();
    return;
  }
  if (old) {
    old.title = pluginCheckTip(id);
    return;
  }
  const el = document.createElement("div");
  el.className = "plugin-tile-done";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = PLUGIN_DONE_SVG;
  el.title = pluginCheckTip(id);
  card.appendChild(el);
}
/** 详情浮层里的一行「安装后自检」：通过 / 未通过 / 已跳过 / 没测过 + 时间 + 产物路径。
 *  没登记自检的插件（窗口插件 / 桌宠 / llama）不画这一行 —— 不装作有结论。 */
function paintPluginSelfcheckRow(pop, id) {
  const c = pluginCheckOf(id);
  if (!pop || !c) return;
  const r = c.result;
  const row = document.createElement("div");
  row.className = "plugin-pop-desc";
  row.style.marginTop = "8px";
  const head =
    I18n.t("安装后自检") +
    "：" +
    (!r
      ? I18n.t("还没测过")
      : r.ok
        ? I18n.t("通过")
        : r.skipped
          ? I18n.t("已跳过")
          : I18n.t("未通过")) +
    (c.running ? " · " + I18n.t("正在跑…") : "");
  row.textContent = head;
  if (r) {
    const when = r.at ? new Date(r.at).toLocaleString() : "";
    const parts = [];
    if (when) parts.push(when);
    if (!r.ok) {
      const why = r.error || r.reason || "";
      if (why) parts.push(I18n.t("原因：") + String(why).slice(0, 400));
    }
    const arts = (r.artifacts || []).map((a) => a && a.path).filter(Boolean);
    if (arts.length) parts.push(I18n.t("产物：") + arts.join(" · "));
    else if (r.artifactDir) parts.push(I18n.t("产物目录：") + r.artifactDir);
    if (parts.length) {
      const sub = document.createElement("div");
      sub.className = "plugin-pop-desc";
      sub.style.marginTop = "2px";
      sub.style.whiteSpace = "pre-wrap";
      sub.style.wordBreak = "break-all";
      sub.textContent = parts.join("\n");
      pop.appendChild(row);
      pop.appendChild(sub);
      return;
    }
  }
  pop.appendChild(row);
}

const PLUGIN_ACT_SVG = {  play:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2l8 4.8-8 4.8z" fill="currentColor"/></svg>',
  stop:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" fill="currentColor"/></svg>',
  download:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4v7.2M5.4 7.4L8 10.2 10.6 7.4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.4 12.8h9.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  update:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v8.2M8 9.7l-2.6-2.6M8 9.7l2.6-2.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11.5v1.2c0 .7.6 1.3 1.3 1.3h8.4c.7 0 1.3-.6 1.3-1.3v-1.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  /* 设置 / 状态入口（ASR 卡片用；此前缺失 → 按钮渲染成空白方块）= 齿轮 */
  gear:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M8 1.3v1.9M8 12.8v1.9M1.3 8h1.9M12.8 8h1.9M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  /* 「启用 / 停用」= 同一条启停后端动作的两种显示（此前借用 play / stop 两颗图标，
     本轮卡片固定三颗按钮后，启停这一颗用电源图标：开 = 已启用、关 = 未启用） */
  power:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9v5.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11.9 3.9a5.3 5.3 0 1 1-7.8 0" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
  /* 显式入口「控制台」（本轮新增：插件不再自己弹窗，开窗只能由用户点这里或托盘菜单） */
  console:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.9 6.6l1.9 1.7-1.9 1.7M8.4 10.2h2.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function pluginIconName(item) {
  const raw = String((item && item.icon) || (item && item.id ? item.id + ".png" : "")).replace(/\\/g, "/");
  const name = raw.split("/").pop() || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpe?g|webp)$/i.test(name)) return "";
  return name;
}
function pluginIconUrl(item) {
  if (item && typeof item.iconDataUrl === "string" && item.iconDataUrl.indexOf("data:image/") === 0)
    return item.iconDataUrl;
  const name = pluginIconName(item);
  if (!name) return "";
  try {
    return new URL("plugin-icons/" + name, document.baseURI).href;
  } catch {
    return "plugin-icons/" + name;
  }
}
function replacePluginCover(img) {
  if (!img || !img.parentNode) return;
  const ph = document.createElement("div");
  ph.className = "plugin-tile-ph";
  img.replaceWith(ph);
}
function bindPluginCover(img, item) {
  if (!img) return;
  const url = pluginIconUrl(item);
  const name = pluginIconName(item);
  if (!url) {
    replacePluginCover(img);
    return;
  }
  let triedIpc = false;
  img.onerror = () => {
    if (!triedIpc && name && window.api && window.api.appPluginsIcon) {
      triedIpc = true;
      window.api
        .appPluginsIcon(name)
        .then((r) => {
          if (r && r.dataUrl) img.src = r.dataUrl;
          else replacePluginCover(img);
        })
        .catch(() => replacePluginCover(img));
      return;
    }
    replacePluginCover(img);
  };
  img.src = url;
}
function pluginVerLabel(st, root) {
  const v =
    (st && (st.installedVersion || st.version)) ||
    (root && root.dataset && root.dataset.catalogVer) ||
    "";
  const s = String(v).replace(/^v/i, "").trim();
  return s ? "v" + s : "";
}
function setPluginVer(root, st) {
  const el = root && root.querySelector("[data-plugin-ver]");
  if (el) el.textContent = pluginVerLabel(st, root);
}
function mkPluginActBtn(kind, title, onClick, opts) {
  const b = document.createElement("button");
  b.type = "button";
  let cls = "mini btn-sq tpl-ico plugin-act";
  if (opts && opts.primary) cls += " primary";
  if (opts && opts.danger) cls += " danger";
  if (opts && opts.on) cls += " on";
  b.className = cls;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = PLUGIN_ACT_SVG[kind] || "";
  b.disabled = !!(opts && opts.disabled);
  b.onclick = (ev) => {
    ev.stopPropagation();
    if (onClick) onClick();
  };
  return b;
}
function closePluginPop(wrap, pop) {
  /* 浮层一关就停掉内嵌 console 的轮询（不留后台空转） */
  stopPluginPopConsole();
  if (!wrap) return;
  wrap.querySelectorAll(".plugin-tile.sel").forEach((el) => el.classList.remove("sel"));
  wrap.classList.remove("has-pop");
  if (pop) {
    pop.classList.remove("on", "flip", "has-console");
    pop.innerHTML = "";
  }
}
function positionPluginPop(wrap, pop, card) {
  if (!pop || !card || !pop.classList.contains("on")) return;
  const r = card.getBoundingClientRect();
  const popW = pop.offsetWidth || 240;
  const popH = pop.offsetHeight || 80;
  const gap = 10;
  let left = r.left - popW - gap;
  let flip = false;
  if (left < 8) {
    left = r.right + gap;
    flip = true;
  }
  let top = r.top;
  const maxTop = Math.max(8, window.innerHeight - popH - 8);
  if (top > maxTop) top = maxTop;
  if (top < 8) top = 8;
  pop.classList.toggle("flip", flip);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}
/* ════════════ 详情浮层里的内嵌 console（只读）════════════════════════════════
   后端状态与 console 内容显示在插件界面里 —— 点插件卡片弹出的详情浮层
   （.plugin-pop）内嵌一块日志区：
     · 状态行：运行中 / 端口 / 显存 / 托盘（每 ~16s 刷一次，避免频繁探针）；
       **不再显示安装进度** —— 安装的一切显示只属于那只独立安装窗；
     · 日志区：后端 stdout 日志尾部（每 2s 拉一次、按增量拼接）；
     · 「清屏」= **真清除**：清宿主日志文件（truncate 到 0 字节）并同步清掉本地已聚合的正文，
       不是只清显示 —— 关掉浮层再打开不会再回填旧日志；
     · 只读：启停仍走卡片按钮与控制台窗，这里不放写操作（避免两套 UI 并存）。
   浮层关掉（点同一张卡 / 点简介行 / 换插件）即停轮询，不留后台空转。 */
const POP_CONSOLE_TAIL_BYTES = 64 * 1024;
const POP_CONSOLE_MAX_CHARS = 200000;
let _popConsoleTimer = null;
let _popConsoleTeardown = null;
function stopPluginPopConsole() {
  if (_popConsoleTimer) {
    clearInterval(_popConsoleTimer);
    _popConsoleTimer = null;
  }
  if (_popConsoleTeardown) {
    try {
      _popConsoleTeardown();
    } catch {}
    _popConsoleTeardown = null;
  }
}
function stripAnsiText(s) {
  return String(s || "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}
/* 状态行文字：只列得出来的事实，缺项就不写（Remotion 没有常驻后端，不说「后端未运行」） */
function backendStatusLineText(st, spec) {
  const parts = [];
  if (spec && spec.hasService === false) {
    parts.push(st.installed ? I18n.t("已安装（无常驻后端）") : I18n.t("未安装"));
  } else {
    parts.push(st.running ? I18n.t("后端运行中") : I18n.t("后端未运行"));
  }
  if (st.port) parts.push(I18n.t("端口") + " " + st.port);
  if (_popConsoleStarting(st)) parts.push(I18n.t("启动中…"));
  const gpu = st.gpu || null;
  if (gpu && (gpu.name || gpu.memUsedMb || gpu.memTotalMb)) {
    const name = String(gpu.name || "").trim();
    const mem =
      gpu.memUsedMb && gpu.memTotalMb
        ? Math.round(Number(gpu.memUsedMb) / 1024) + "/" + Math.round(Number(gpu.memTotalMb) / 1024) + "GB"
        : "";
    parts.push([name, mem].filter(Boolean).join(" "));
  }
  if (st.trayRunning) parts.push(I18n.t("托盘常驻"));
  return parts.join(" · ");
}
function _popConsoleStarting(st) {
  return !!(st && st.wantRunning && !st.running);
}
/* 把 console 区块挂进详情浮层（只有本地后端插件才有；桌宠 / 窗口插件不受影响） */
function mountPluginPopConsole(pop, item) {
  const spec = backendSpecOf(item);
  if (!spec || !pluginApiFn(spec.api + "Status")) return false;
  const tailFn = pluginApiFn(spec.api + "ConsoleTail");
  const clearFn = pluginApiFn(spec.api + "ConsoleClear");
  pop.classList.add("has-console");
  const box = document.createElement("div");
  box.className = "plugin-console";
  box.innerHTML =
    '<div class="plugin-console-head">' +
    '<span class="plugin-console-title"></span>' +
    '<span class="plugin-console-acts">' +
    '<button type="button" class="mini plugin-console-btn" data-console-copy></button>' +
    '<button type="button" class="mini plugin-console-btn" data-console-clear></button>' +
    "</span>" +
    "</div>" +
    '<div class="plugin-console-status"></div>' +
    '<pre class="plugin-console-log" tabindex="0"></pre>';
  box.querySelector(".plugin-console-title").textContent = I18n.t("控制台");
  const copyBtn = box.querySelector("[data-console-copy]");
  const clearBtn = box.querySelector("[data-console-clear]");
  copyBtn.textContent = I18n.t("复制");
  clearBtn.textContent = I18n.t("清屏");
  const statusEl = box.querySelector(".plugin-console-status");
  const logEl = box.querySelector(".plugin-console-log");
  pop.appendChild(box);
  /* 打开详情浮层 = 用户已经看到提示：本地收掉这张卡的角标（宿主那份在开控制台窗时清） */
  let shown = "";
  let lastTail = "";
  let tick = 0;
  const render = () => {
    if (shown.length > POP_CONSOLE_MAX_CHARS) shown = shown.slice(shown.length - POP_CONSOLE_MAX_CHARS);
    const nearBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
    logEl.textContent = shown;
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
  };
  const feedTail = (text) => {
    const t = stripAnsiText(text);
    if (t === lastTail) return;
    if (lastTail && t.startsWith(lastTail)) shown += t.slice(lastTail.length);
    else shown = t; /* 日志被轮转 / 截断：整篇重来 */
    lastTail = t;
    render();
  };
  const pullTail = async () => {
    if (!tailFn) return;
    try {
      const r = await tailFn(POP_CONSOLE_TAIL_BYTES);
      feedTail((r && r.text) || "");
    } catch {}
  };
  const pullStatus = async () => {
    const statusFn = pluginApiFn(spec.api + "Status");
    if (!statusFn) return;
    try {
      const st = (await statusFn()) || {};
      statusEl.textContent = backendStatusLineText(st, spec);
      statusEl.title = st.consolePath ? String(st.consolePath) : "";
      const notice = String(st.notice || "");
      /* 求助提示同时落在日志区顶部一行（宿主也写进了日志文件；这里保证没写日志的实现也看得见），
         并把这枚提示记成「已看过」——卡片角标从此收起，直到后端再发一条新的提示。 */
      if (notice) {
        _backendNoticeSeen.set(spec.key, notice);
        /* 宿主也把这行写进了日志文件 → 已经在 tail 里就别重复贴一遍 */
        if (statusEl.dataset.notice !== notice && String(lastTail).indexOf("[notice] " + notice) < 0) {
          statusEl.dataset.notice = notice;
          shown += (shown && !shown.endsWith("\n") ? "\n" : "") + "[notice] " + notice + "\n";
          render();
        }
      }
    } catch {}
  };
  copyBtn.onclick = (ev) => {
    ev.stopPropagation();
    try {
      navigator.clipboard.writeText(logEl.textContent || "");
      toast(I18n.t("已复制控制台内容"), "ok");
    } catch {
      toast(I18n.t("复制失败：请手动选中日志"), "warn");
    }
  };
  clearBtn.onclick = async (ev) => {
    ev.stopPropagation();
    /* 清屏 = 真清除：宿主把日志文件清空（truncate 到 0 字节，运行中的后端句柄继续可用），
       这里同步丢弃本地已聚合的正文与游标 —— 关掉浮层再打开不会再回填旧日志。 */
    let r = null;
    if (clearFn) {
      try {
        r = await clearFn();
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
    }
    shown = "";
    lastTail = "";
    render();
    if (!r || !r.ok) toast(I18n.t("清空日志失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
    else toast(I18n.t("日志已清空（文件已清空，不是只清显示）"), "ok");
  };
  /* 浮层内滚轮 / 点击不要穿透到浮层外（浮层本身已 stopPropagation） */
  logEl.addEventListener("wheel", (ev) => ev.stopPropagation(), { passive: true });
  void pullStatus();
  void pullTail();
  const timer = setInterval(() => {
    tick++;
    void pullTail();
    if (tick % 8 === 0) void pullStatus(); /* 状态每 ~16s 一次：别每 2s 去 spawn 一次 nvidia-smi */
  }, 2000);
  _popConsoleTimer = timer;
  _popConsoleTeardown = () => clearInterval(timer);
  return true;
}
function openPluginPop(wrap, pop, card, item) {
  const already = card.classList.contains("sel");
  closePluginPop(wrap, pop);
  if (already) return;
  card.classList.add("sel");
  wrap.classList.add("has-pop");
  pop.setAttribute("data-np-for", item.id);
  /* 用户自建插件：详情面板换成状态 / 节点试运行 / 修复那一套（见 renderUserPluginPanel） */
  if (item && item.handler === "userplugin") {
    renderUserPluginPanel(pop, item);
    pop.classList.add("on");
    requestAnimationFrame(() => positionPluginPop(wrap, pop, card));
    return;
  }
  const title = document.createElement("div");
  title.className = "plugin-pop-title";
  title.textContent = pluginLoc(item, "title") || item.id;
  const desc = document.createElement("div");
  desc.className = "plugin-pop-desc";
  desc.textContent = pluginLoc(item, "subtitle") || I18n.t("暂无描述");
  pop.appendChild(title);
  pop.appendChild(desc);
  /* 本地后端插件：详情浮层里内嵌只读 console（状态行 + 后端日志尾部），见 mountPluginPopConsole */
  const consoleMounted = mountPluginPopConsole(pop, item);
  if (consoleMounted) setPluginNotice(card, ""); /* 角标当场收起（用户已经看到详情里的日志区） */
  /* 安装后自检的最近一次结论（本轮需求）：卡片详情里能复看「什么时候测的、产物在哪」 */
  paintPluginSelfcheckRow(pop, item.id);
  /* 安装目录**不在插件界面里显示**（本轮需求）：目录由安装窗统一显示与修改
     （底栏那一行 + 「选择安装目录」）。这里不再挂目录 / 路径这类只读文字。 */
  pop.classList.add("on");
  requestAnimationFrame(() => positionPluginPop(wrap, pop, card));
}

/* ════════════ 桌宠卡片的附加项（勾选 / 缩放 / 形象 / 导入） ══════════════════════ */
function ensurePetExtras(root) {
  let extras = root.querySelector("[data-pet-extras]");
  if (extras) return extras;
  extras = document.createElement("div");
  extras.setAttribute("data-pet-extras", "1");
  extras.style.marginTop = "10px";
  extras.style.display = "none";
  root.appendChild(extras);
  return extras;
}
async function paintPetExtras(root, st) {
  const extras = ensurePetExtras(root);
  if (!st || !st.installed) {
    extras.style.display = "none";
    extras.innerHTML = "";
    return;
  }
  extras.style.display = "block";
  extras.innerHTML = "";
  const cfg = (st.config || {});
  const row = document.createElement("div");
  row.className = "plugin-card-actions";
  row.style.marginTop = "0";

  const mkCheck = (label, key) => {
    const lab = document.createElement("label");
    lab.style.display = "inline-flex";
    lab.style.alignItems = "center";
    lab.style.gap = "6px";
    lab.style.fontSize = "12px";
    lab.style.color = "var(--muted)";
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = !!cfg[key];
    inp.onchange = async () => {
      const patch = {};
      patch[key] = !!inp.checked;
      await window.api.petSetConfig(patch);
      refreshPetPluginCard(root);
    };
    lab.appendChild(inp);
    lab.appendChild(document.createTextNode(label));
    row.appendChild(lab);
  };
  mkCheck(I18n.t("窗口穿透"), "penetrable");
  mkCheck(I18n.t("始终置顶"), "alwaysOnTop");
  mkCheck(I18n.t("镜像"), "mirror");
  mkCheck(I18n.t("悬停隐藏"), "hideOnHover");
  extras.appendChild(row);

  const row2 = document.createElement("div");
  row2.className = "plugin-card-actions";
  const scaleLab = document.createElement("label");
  scaleLab.style.fontSize = "12px";
  scaleLab.style.color = "var(--muted)";
  scaleLab.textContent = I18n.t("缩放");
  const scaleSel = document.createElement("select");
  [50, 75, 100, 125, 150].forEach((v) => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v + "%";
    if (Number(cfg.scale) === v) o.selected = true;
    scaleSel.appendChild(o);
  });
  scaleSel.onchange = async () => {
    await window.api.petSetConfig({ scale: Number(scaleSel.value) });
    refreshPetPluginCard(root);
  };
  scaleLab.appendChild(document.createTextNode(" "));
  scaleLab.appendChild(scaleSel);
  row2.appendChild(scaleLab);

  const opLab = document.createElement("label");
  opLab.style.fontSize = "12px";
  opLab.style.color = "var(--muted)";
  opLab.textContent = I18n.t("透明度");
  const opSel = document.createElement("select");
  [40, 60, 80, 100].forEach((v) => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v + "%";
    if (Number(cfg.opacity) === v) o.selected = true;
    opSel.appendChild(o);
  });
  opSel.onchange = async () => {
    await window.api.petSetConfig({ opacity: Number(opSel.value) });
    refreshPetPluginCard(root);
  };
  opLab.appendChild(document.createTextNode(" "));
  opLab.appendChild(opSel);
  row2.appendChild(opLab);
  extras.appendChild(row2);

  const row3 = document.createElement("div");
  row3.className = "plugin-card-actions";
  const skinLab = document.createElement("label");
  skinLab.style.fontSize = "12px";
  skinLab.style.color = "var(--muted)";
  skinLab.textContent = I18n.t("形象");
  const skinSel = document.createElement("select");
  (st.skins || []).forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name || s.id;
    if ((cfg.skinId || "default") === s.id) o.selected = true;
    skinSel.appendChild(o);
  });
  skinSel.onchange = async () => {
    await window.api.petSetSkin(skinSel.value);
    refreshPetPluginCard(root);
  };
  skinLab.appendChild(document.createTextNode(" "));
  skinLab.appendChild(skinSel);
  row3.appendChild(skinLab);
  const importBtn = document.createElement("button");
  importBtn.className = "mini";
  importBtn.textContent = I18n.t("导入形象…");
  importBtn.onclick = async () => {
    const r = await window.api.petImportSkin();
    if (r && r.ok) toast(I18n.t("已导入形象：") + (r.name || r.id), "ok");
    else if (r && r.error && r.error !== "cancelled")
      toast(I18n.t("导入失败：") + r.error, "err");
    refreshPetPluginCard(root);
  };
  row3.appendChild(importBtn);
  extras.appendChild(row3);

  if (st.running && st.hook === false) {
    const tip = document.createElement("div");
    tip.className = "plugin-progress-txt";
    tip.style.display = "block";
    tip.textContent = I18n.t("全局键鼠钩子未就绪（仍可使用窗口与形象功能）");
    extras.appendChild(tip);
  }
}
async function refreshPetPluginCard(root) {
  if (!root || !window.api || !window.api.petStatus) return;
  const st = await window.api.petStatus();
  const actions = root.querySelector("[data-pet-actions]");
  if (!actions) return;
  setPluginVer(root, st);
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  /* 安装 / 更新的过程与进度**只显示在安装窗**（卡片上不再有进度条与「准备下载…」小字）：
     这里只负责把窗打开，装完回来重绘卡片。 */
  const openPetInstall = async (action) => {
    await openPluginInstallWindow({ id: "bongochat", name: I18n.t("桌宠"), action: action || "install" });
    refreshPetPluginCard(root);
  };
  if (!st.installed) {
    addBtn("download", I18n.t("下载安装"), () => openPetInstall("install"), {
      primary: true,
      disabled: !!st.installing,
    });
  } else {
    if (st.running) {
      addBtn("stop", I18n.t("停止"), async () => {
        await window.api.petStop();
        refreshPetPluginCard(root);
      });
    } else {
      addBtn("play", I18n.t("运行"), async () => {
        const r = await window.api.petStart();
        if (!r || !r.ok) {
          toast(I18n.t("启动桌宠失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
        }
        refreshPetPluginCard(root);
      }, { primary: true });
    }
    if (st.updateAvailable) {
      addBtn("update", I18n.t("更新"), async () => {
        const wasRunning = !!st.running;
        if (wasRunning) await window.api.petStop();
        await openPetInstall("update");
        if (wasRunning) await window.api.petStart();
      });
    }
  }
  const extras = root.querySelector("[data-pet-extras]");
  if (extras) {
    extras.style.display = "none";
    extras.innerHTML = "";
  }
}
/* ════════════ 插件根目录（本轮需求：插件界面一个总的根目录 + 第一次打开时提示设置）════════════
   值存 <数据目录>/config.json 的 plugins.installDir（真源 plugins/plugin-root.js）：
     · 需要目录的插件（8 个本地后端）默认装到「根目录 + 默认子目录名」，
       但插件自己的 installDir 一设就优先（安装窗 / 控制台里仍可单独更换安装目录）；
     · 根目录没设时，插件对话框顶部给醒目提示，点「安装」先提示去设根目录（不弹系统目录框）；
     · 第一次打开时那条提示里的预填值 = 主进程按现有各插件 installDir 的公共父目录推断出来的，
       **只预填不写盘**，用户点「选择目录…」确认后才落。 */
let _plugRootDialog = false;
/* 根目录现状（顶栏那一行、卡片状态行与详情面板共用；每次开对话框读一次） */
let _plugRootInfo = { ok: false, installDir: "", set: false, inferred: "" };
/* 各插件「这次该装到哪」的缓存（按插件 id 一份；根目录换了 / 恢复默认后作废重取） */
let _plugRoots = new Map();
function plugRootBarEl() {
  return document.getElementById("plugRootBar");
}
/* 根目录按钮的统一动作：未设时点它 = 直接弹系统目录选择框（用推断值预填）；已设时 = 换目录。
   选完立刻按新根目录重开对话框（各插件的默认目录跟着变）。 */
async function plugRootChange() {
  const pick = pluginApiFn("appPluginsRootPick");
  if (!pick) {
    toast(I18n.t("当前版本不支持设置插件根目录"), "err");
    return { ok: false, error: "no_api" };
  }
  let r = null;
  try {
    r = await pick();
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (r && r.ok) {
    toast(I18n.t("插件根目录已设为：") + (r.installDir || ""), "ok");
    _plugRoots = new Map(); /* 各插件的默认目录缓存作废（根目录换了） */
    repaintPlugRootBar(await plugRootInfo());
    if (_plugRootDialog) openAppPluginsDialog();
    return r;
  }
  if (r && r.cancelled) return r; /* 用户取消：什么都不做，也不报错 */
  toast(I18n.t("设置插件根目录失败：") + ((r && (r.message || r.error)) || I18n.t("未知错误")), "err");
  return r || { ok: false };
}
/** 画顶部那一行（`#plugRootBar` 存在才画；它由 openAppPluginsDialog 插在列表前面）。 */
function repaintPlugRootBar(info) {
  const bar = plugRootBarEl();
  if (!bar || !info) return;
  const set = !!info.set && !!info.installDir;
  const dir = set ? String(info.installDir) : "";
  bar.setAttribute("data-root", dir);
  bar.setAttribute("data-need", set ? "" : "1");
  bar.classList.toggle("need", !set);
  const pathEl = bar.querySelector("[data-root-path]");
  const hintEl = bar.querySelector("[data-root-hint]");
  const pickBtn = bar.querySelector("[data-root-pick]");
  const openBtn = bar.querySelector("[data-root-open]");
  if (pathEl) {
    pathEl.textContent = set ? dir : I18n.t("未设置");
    pathEl.title = set ? dir : "";
    pathEl.classList.toggle("unset", !set);
  }
  if (pickBtn) pickBtn.textContent = set ? I18n.t("换目录…") : I18n.t("选择目录…");
  if (openBtn) openBtn.disabled = !(set || info.inferred);
  if (hintEl) {
    let h = "";
    if (!set) {
      h = I18n.t(
        "第一次使用先设置「插件根目录」：需要目录的插件会默认装到它下面的子目录（如 根目录\\music）。",
      );
      if (info.inferred) h += I18n.t("已按现有插件目录推断：") + info.inferred;
    } else {
      h = I18n.t("插件默认装到该根目录下的子目录；单个插件仍可在它的安装窗里换成别的目录。");
    }
    hintEl.textContent = h;
  }
  /* 对话框底部的「打开插件目录」跟着当前根目录走（没有根目录时保持原样） */
  const dirBtn = document.querySelector("#ovFoot [data-plugin-root-open]");
  if (dirBtn) dirBtn.disabled = !(set || info.inferred);
}
/** 建那一行（只在 openAppPluginsDialog 里调一次；幂等：已存在就复用）。 */
function buildPlugRootBar() {
  let bar = plugRootBarEl();
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "plugRootBar";
  bar.className = "plug-root-bar";
  const label = document.createElement("span");
  label.className = "plug-root-label";
  label.textContent = I18n.t("插件根目录");
  const pathEl = document.createElement("span");
  pathEl.className = "plug-root-path";
  pathEl.setAttribute("data-root-path", "1");
  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.className = "mini";
  pickBtn.setAttribute("data-root-pick", "1");
  pickBtn.onclick = (ev) => {
    ev.stopPropagation();
    void plugRootChange();
  };
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "mini";
  openBtn.setAttribute("data-root-open", "1");
  openBtn.textContent = I18n.t("打开");
  openBtn.onclick = async (ev) => {
    ev.stopPropagation();
    const fn = pluginApiFn("appPluginsRootOpen");
    if (!fn) return;
    const r = await fn();
    if (!r || !r.ok) toast(I18n.t("打开插件根目录失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
  };
  const head = document.createElement("div");
  head.className = "plug-root-head";
  head.appendChild(label);
  head.appendChild(pathEl);
  head.appendChild(pickBtn);
  head.appendChild(openBtn);
  const hint = document.createElement("div");
  hint.className = "plug-root-hint";
  hint.setAttribute("data-root-hint", "1");
  bar.appendChild(head);
  bar.appendChild(hint);
  return bar;
}
/* ── 卡片「安装 / 重装」的目录口径（缓存在上方模块级的 _plugRoots 里）── */
/** 缓存的原始回执 → 界面用的那一份：带上 `own`（插件自己设过的目录，空串 = 用的是默认值）。 */
function plugEntry(id, r) {
  const sid = String(id || "");
  if (r && r.ok && r.own) return r;
  /* 需根目录而根目录没设：原样透出 need_root（卡片据此提示去设置，不当成「有目录」） */
  if (r && !r.ok) return { ok: false, error: r.error || "no_dir", own: "", subDir: (r && r.subDir) || "", sub: (r && r.subDir) || "" };
  const e = { ok: true, dir: "", own: "", source: "root", subDir: "", fromRoot: false, sub: "" };
  if (r && r.ok && r.dir) {
    e.dir = r.dir;
    e.source = r.source || "root";
    e.defaultDir = r.defaultDir || "";
  }
  /* 插件没设过目录时，当前值 = 根目录 + 子目录名（主进程拼好的 defaultDir 优先；
     它还没回来就先留空，等 plugRootInfo 回来再补全）—— 状态行与详情面板都吃这份。 */
  const sub = String((r && r.subDir) || "");
  e.sub = sub;
  if (!e.dir && _plugRootInfo && _plugRootInfo.installDir && sub) {
    e.dir = String(_plugRootInfo.installDir).replace(/[\\/]+$/, "") + "\\" + sub;
    e.fromRoot = true;
  }
  return e;
}
async function plugInstallDir(id) {
  const sid = String(id || "");
  if (!sid) return { ok: false, error: "bad_id" };
  if (_plugRoots.has(sid)) return _plugRoots.get(sid);
  const fn = pluginApiFn("appPluginsInstallDirOf");
  let r = null;
  if (fn) {
    try {
      r = await fn(sid);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
  }
  if (!r || typeof r !== "object") r = { ok: false, error: "no_api" };
  const e = plugEntry(sid, r);
  _plugRoots.set(sid, e);
  return e;
}
/** 读根目录现状（状态存在模块级的 _plugRootInfo 里；顶栏那一行、状态行与详情面板都用它）。 */
async function plugRootInfo() {
  const fn = pluginApiFn("appPluginsRootStatus");
  if (!fn) return _plugRootInfo;
  let r = null;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  if (r && typeof r === "object") _plugRootInfo = r;
  return _plugRootInfo;
}
/** 未设根目录 / 设置失败时的统一提示（并把顶部那一行标红，让人知道去哪儿设）。 */
function plugRootWarn(msg) {
  if (msg) toast(msg, "warn");
  const bar = plugRootBarEl();
  if (bar) {
    bar.classList.add("warn");
    bar.scrollIntoView({ block: "nearest" });
    setTimeout(() => bar.classList.remove("warn"), 1600);
  }
}
/* ════════════ 本地后端插件（7 个）的统一卡片 + 内嵌 console ════════════════════
   本轮共识（需求：插件不再呼出独立的后端窗口、避免用户误关、静默后台拉起、状态与
   console 内容显示在插件界面的 console 里）：
     · 卡片三颗按钮 = 安装 / 启用 / 控制台（本轮需求）：「安装」常驻（已装时是「重装」）= 开那只
       安装窗；「启用」只在已安装时出现（host 的 <kind>:start / <kind>:stop）—— 点它只是把后端
       静默拉起来（后端进程本来就是 windowsHide，stdout 落日志文件），运行中显示「停用」，
       未安装时卡片上只有「安装」+「控制台」两颗。
     · 「控制台」（<kind>:open）常驻：那只独立窗仍保留（安装 / 卸载 / H3 工作流编辑器
       等重功能还在里面），但只由用户显式打开 —— 卡片按钮或托盘的「打开控制台」。
     · 后端求助信号（llama / Breeze 的 ui-signal）不再自动弹窗：卡片角标 + 状态行一句
       + 详情浮层里内嵌的 console（宿主 statusForUi 的 notice 字段）。
     · 关掉控制台窗不影响后端（后端单例不随 MTNode 退出）；Remotion 没有常驻后端
       （无 start / stop IPC），所以它只有「安装 / 重装」+「控制台」，没有「启用」。
   桥的名字一一对应 preload.js：<api>Status / Start / Stop / Install / CancelInstall /
   PickInstallDir / Open / Close / ConsoleTail / UpdateRuntime。 */
const BACKEND_PLUGIN_SPECS = {
  music3: { key: "music3", api: "music3", hasService: true, update: true },
  yue2: { key: "yue2", api: "yue2", hasService: true, update: true },
  sensenova: { key: "sensenova", api: "sensenova", hasService: true },
  h3: { key: "h3", api: "h3", hasService: true, update: true },
  llama: { key: "llama", api: "llama", hasService: true },
  breeze: { key: "breeze", api: "breeze", hasService: true },
  remotion: { key: "remotion", api: "remotion", hasService: false },
};
function backendSpecOf(item) {
  const k = item && (item.kind || item.handler);
  return (k && BACKEND_PLUGIN_SPECS[k]) || null;
}
/* 按插件 id 反查 spec（安装窗「打开插件控制台」用；id 与 kind 的对应表只有这里一份） */
function backendSpecById(id) {
  const s = String(id || "");
  if (!s) return null;
  const byKey = BACKEND_PLUGIN_SPECS[s];
  if (byKey) return byKey;
  /* 目录 / 报错总线里的 id 带 -local 后缀（llama-local / sensenova-local …），与 spec 的短名对不上 */
  const short = s.replace(/-local$/, "");
  if (BACKEND_PLUGIN_SPECS[short]) return BACKEND_PLUGIN_SPECS[short];
  const prefix = s.split("-")[0];
  return BACKEND_PLUGIN_SPECS[prefix] || null;
}
/* 安装窗的插件 id：与主进程 installHost 的 registry key 同源。
   后端插件：spec.key 加 -local（llama-local / sensenova-local / breeze-tts-local /
   minimax-h3 / minimax-music3 / yue2-local / remotion）—— 由 installTargetIdOf 统一给出；
   窗口插件与桌宠：直接用它们自己的 id。 */
const BACKEND_INSTALL_IDS = {
  music3: "minimax-music3",
  yue2: "yue2-local",
  sensenova: "sensenova-local",
  h3: "minimax-h3",
  llama: "llama-local",
  breeze: "breeze-tts-local",
  remotion: "remotion",
};
/** 开这只插件的安装窗：**唯一入口**（卡片「安装 / 重装」与控制台窗内的「安装」都走它）。 */
async function openPluginInstallWindow(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const fn = pluginApiFn("mtnodeInstallOpen");
  if (!fn) {
    toast(I18n.t("当前版本不支持安装窗"), "err");
    return { ok: false, error: "no_install_window" };
  }
  const r = await fn(Object.assign({}, p, { action: p.action || "install" }));
  if (!r || !r.ok) toast(I18n.t("打开安装窗失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
  return r || { ok: false };
}
function pluginApiFn(name) {
  return window.api && typeof window.api[name] === "function" ? window.api[name].bind(window.api) : null;
}
/* 正在启动 / 正在停止的插件：「启用」那一颗当场置灰并用 tooltip 说明状态（跨重绘保留） */
const _backendStarting = new Set();
const _backendStopping = new Set();
/* 已在详情浮层里看过提示的插件（kind → 看过的提示原文）：本地收掉角标 */
const _backendNoticeSeen = new Map();
/* 最近一次启动 / 安装的失败原因：卡片状态行要看得见（失败不静默、也不弹窗） */
const _backendLastErr = new Map();
function pluginErrLine(prefix, r) {
  return prefix + ((r && (r.message || r.error)) || I18n.t("未知错误"));
}
/* 卡片上的求助角标（后端 ui-signal 留下的提示）；空串 = 收起 */
function setPluginNotice(root, text) {
  const el = root && root.querySelector("[data-plugin-notice]");
  if (!el) return;
  const t = String(text || "").trim();
  el.hidden = !t;
  el.textContent = t ? I18n.t("后端提示") : "";
  el.title = t;
}
/* 卡片状态行：启用中 > 失败原因 > 后端求助提示（同一行只显示最要紧的那条）。
   安装 / 更新的进度与「安装中…」不再上卡片 —— 那属于独立安装窗（逐步骤 + 失败定位 + 重试）。
   **安装目录不上卡片**（本轮需求）：目录在安装窗里显示与修改（底栏一行 + 「选择安装目录」），
   卡片只留标题 / 三颗按钮 / 这几条真实状态。 */
function backendCardLine(st, spec) {
  if (_backendStarting.has(spec.key)) return I18n.t("启用中…（首次加载模型可能几分钟，按钮已置灰）");
  const err = _backendLastErr.get(spec.key);
  if (err) return err;
  const notice = String(st.notice || "");
  if (notice && _backendNoticeSeen.get(spec.key) !== notice) return notice;
  return "";
}
/* 本轮 8 个插件共用的卡片重绘 —— 各自的 refresh<Name>PluginCard 只是薄壳（保留函数名给冒烟用） */
async function refreshBackendPluginCard(root, spec, opts) {
  const o = opts || {};
  const statusFn = pluginApiFn(spec.api + "Status");
  if (!root || !statusFn) return;
  const st = (await statusFn()) || {};
  const actions = root.querySelector("[data-plugin-actions]");
  /* 卡片上只剩「状态文字行」：启用中 / 失败原因 / 后端提示。
     安装 / 更新的进度条与百分比一律不再上卡片 —— 那些只属于独立安装窗。 */
  const progTxt = root.querySelector("[data-plugin-progress-txt]");
  if (!actions) return;
  setPluginVer(root, { version: st.version, installed: !!st.installed });
  /* 真在跑 = 上一条失败提示已过期，清掉（免得卡片一直挂着旧错误） */
  if (st.running) _backendLastErr.delete(spec.key);
  setPluginNotice(root, _backendNoticeSeen.get(spec.key) === String(st.notice || "") ? "" : st.notice);
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, btnOpts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, btnOpts));
  };
  const repaint = () => refreshBackendPluginCard(root, spec, o);
  const openConsole = async () => {
    const fn = pluginApiFn(spec.api + "Open");
    if (!fn) return;
    _backendLastErr.delete(spec.key);
    const r = await fn();
    if (!r || !r.ok) toast(I18n.t("打开失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
    repaint();
  };
  const stopBackend = async () => {
    const fn = pluginApiFn(spec.api + "Stop");
    _backendStarting.delete(spec.key);
    _backendStopping.add(spec.key);
    _backendLastErr.delete(spec.key);
    repaint();
    if (!fn) {
      _backendStopping.delete(spec.key);
      return;
    }
    const r = await fn();
    _backendStopping.delete(spec.key);
    if (!r || !r.ok) _backendLastErr.set(spec.key, pluginErrLine(I18n.t("停止后端失败："), r));
    repaint();
  };
  const startBackend = async () => {
    const fn = pluginApiFn(spec.api + "Start");
    if (!fn) return;
    _backendLastErr.delete(spec.key);
    _backendStarting.add(spec.key);
    repaint();
    let r = null;
    try {
      r = await fn();
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    _backendStarting.delete(spec.key);
    /* 失败不静默、也不弹窗：写进卡片状态行（点开卡片还能在内嵌 console 里看后端日志） */
    if (!r || !r.ok) _backendLastErr.set(spec.key, pluginErrLine(I18n.t("启动失败："), r) + I18n.t(" —— 可点「控制台」看日志"));
    repaint();
  };
  const installing = !!st.installing || !!st.updating;
  const starting = _backendStarting.has(spec.key);
  const stopping = _backendStopping.has(spec.key);
  const running = !!(st.running || st.wantRunning);
  /* 本轮共识：安装**不再在卡片上静默跑**，一律开那只安装窗（逐步骤 + 失败定位 + 会话修复）。
     卡片主按钮仍是启停后端；未装 / 要重装时这里是「安装 / 重装」= 开安装窗。 */
  const installBackend = async () => {
    _backendLastErr.delete(spec.key);
    const id = BACKEND_INSTALL_IDS[spec.key] || spec.key;
    /* 这次该装到哪：插件自己设过目录就用它；没设过 = 插件根目录 + 默认子目录名。
       根目录还没设 → 不弹系统目录框、不开始安装，先把顶部那一行标红提示去设置（本轮共识）。 */
    const target = await plugInstallDir(id);
    if (!target.ok && target.error === "need_root") {
      const plugName = root._pluginItem ? pluginLoc(root._pluginItem, "title") : spec.key;
      plugRootWarn(
        I18n.t("还没有设置插件根目录：先在插件界面顶部选一个根目录，") +
          plugName +
          I18n.t("就会默认装到它下面的「") +
          (target.subDir || "") +
          I18n.t("」子目录。"),
      );
      return;
    }
    if (!target.dir) {
      plugRootWarn(I18n.t("取不到这个插件的安装目录，请重开插件界面后再试。"));
      return;
    }
    await openPluginInstallWindow({ id, action: "install", installDir: target.dir });
    _plugRoots.delete(id);
    repaint();
  };
  /* 卡片按钮口径（本轮需求：插件界面三颗按钮 = 安装 / 启用 / 控制台）：
       · 「安装」**常驻**：未装 = 主按钮「安装」，已装 / 要重装 = 次按钮「重装」——两者都只是那只安装窗的入口；
         Remotion 没有常驻后端（hasService:false），它的按钮就止于此 + 控制台。
       · 「启用」**只在已安装时出现**（未安装时这颗按钮整颗不建）：点它 = 启用（静默后台拉起后端），
         运行中显示「停用」且高亮（on），再点一次 = 停用；启停过程中置灰并在 tooltip 里说明为什么不可点
         （首次加载模型可能几分钟，卡片状态行也写着同一句）。
       · 「控制台」常驻（这只窗只由用户亲手打开）。安装 / 更新的**显示**一律不在卡片上
         （进度条、百分比、「安装中…」都已移除），进度只在安装窗里。 */
  const installingLabel = typeof o.installLabel === "function" ? o.installLabel(st) : o.installLabel;
  const reinstallLabel = typeof o.reinstallLabel === "function" ? o.reinstallLabel(st) : o.reinstallLabel;
  if (!st.installed) {
    addBtn("download", installingLabel || I18n.t("安装"), installBackend, { primary: true });
  } else {
    addBtn("download", reinstallLabel || I18n.t("重装"), installBackend);
  }
  if (st.installed && spec.hasService) {
    const title = stopping
      ? I18n.t("停用中…")
      : starting
        ? I18n.t("启用中…（首次加载模型可能几分钟）")
        : running
          ? I18n.t("停用")
          : I18n.t("启用");
    addBtn("power", title, running ? stopBackend : startBackend, {
      primary: !running,
      on: running,
      disabled: starting || stopping,
    });
  }
  /* 安装目录冲突（本轮共识 q14）：端口上跑的是**另一份**安装目录的 llama.cpp。
     不静默复用 —— 卡片上明说两份目录各是哪个，并给两个选择：
       · 换端口起自己的：把配置端口挪到空闲端口后启动我们自己那份（清单回到配置目录）；
       · 继续用这份：认下端口上那份（此后 apiKey / 模型清单都跟它走，不再报警）。
     判定与动作都在 llama/main-llama.js（statusForUi 的 rootConflict / resolveRootChoice）。 */
  if (spec.key === "llama" && st.rootConflict) {
    const warn = document.createElement("div");
    warn.className = "plugin-root-conflict";
    warn.textContent =
      I18n.t("端口 ") +
      String(st.rootConflict.port || "") +
      I18n.t(" 上跑的是另一份安装目录的 llama.cpp：") +
      String(st.rootConflict.liveRoot || "") +
      I18n.t("；当前插件配置的是 ") +
      String(st.rootConflict.configuredRoot || "") +
      I18n.t("。在你选之前，本机模型不会登记进 MTNode（避免把别人那份混进来）。");
    actions.appendChild(warn);
    const resolve = async (mode) => {
      const fn = pluginApiFn("llamaResolveRootChoice");
      if (!fn) return;
      let r = null;
      try {
        r = await fn(mode);
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      if (!r || !r.ok) {
        _backendLastErr.set(spec.key, pluginErrLine(I18n.t("处理失败："), r));
      } else if (mode === "own") {
        toast(I18n.t("已换到端口 ") + String(r.port || "") + I18n.t("；点「启用」启动这一份"), "ok");
      } else {
        toast(I18n.t("已改为继续使用端口上那份 llama.cpp"), "ok");
      }
      repaint();
    };
    addBtn("power", I18n.t("换端口起自己的"), () => resolve("own"), { primary: true });
    addBtn("gear", I18n.t("继续用这份"), () => resolve("external"), {});
  }
  /* 显式入口：那只控制台窗（卸载 / 工作流编辑器等重功能仍在窗里） */
  addBtn("console", I18n.t("控制台"), openConsole);
  if (spec.update && st.updateAvailable && pluginApiFn(spec.api + "UpdateRuntime")) {
    addBtn(
      "update",
      I18n.t("更新") + (st.latestVersion || st.feedVersion ? " → v" + (st.feedVersion || st.latestVersion) : ""),
      async () => {
        /* 更新会换掉控制台窗的 ui 资源：用户开着就先关掉，更新后按原样替他开回来
           （这是用户早就亲手开过的窗，不算「插件自己弹窗」）。进度不上卡片：过程看安装窗。 */
        const wasOpen = !!st.consoleOpen;
        const closeFn = pluginApiFn(spec.api + "Close");
        if (wasOpen && closeFn) await closeFn();
        const r = await window.api[spec.api + "UpdateRuntime"]();
        if (r && r.ok) toast(I18n.t("插件已更新") + (r.version ? " v" + r.version : ""), "ok");
        else toast(pluginErrLine(I18n.t("安装失败："), r), "err");
        if (wasOpen && r && r.ok) {
          const openFn = pluginApiFn(spec.api + "Open");
          if (openFn) await openFn();
        }
        repaint();
      },
      { disabled: installing },
    );
  }
  /* 卡片不再挂 hint 说明行（Breeze 的权重许可、SenseNova 的磁盘 / 权重说明、Remotion 的安装口径
     各占一行小字都已移除）—— 卡片上只剩图标 + 标题 + 动作按钮 + 状态行（启动失败原因 / 后端提示），
     失败不静默。 */
  /* 卡片状态行 = 显存门槛那句（已装但不达标）+ 后端自己的状态（启动失败原因 / 后端提示） */
  const vramHint = root._pluginItem ? pluginVramNoticeText(root._pluginItem) : "";
  const line = [vramHint, backendCardLine(st, spec)].filter(Boolean).join(" · ");
  if (progTxt) {
    if (line) {
      progTxt.style.display = "block";
      progTxt.textContent = line;
    } else {
      progTxt.style.display = "none";
      progTxt.textContent = "";
    }
  }
}
async function refreshMusic3PluginCard(root) {
  return refreshBackendPluginCard(root, BACKEND_PLUGIN_SPECS.music3);
}
/* ── YuE2 本地音乐（应用插件 kind yue2）：与 Music3 同族，卡片 = 安装 / 启用 / 控制台 ── */
async function refreshYuePluginCard(root) {
  return refreshBackendPluginCard(root, BACKEND_PLUGIN_SPECS.yue2);
}
async function refreshH3PluginCard(root) {
  return refreshBackendPluginCard(root, BACKEND_PLUGIN_SPECS.h3);
}

/* ── Remotion 动效视频（应用插件 kind remotion） ──
   安装走那只独立安装窗（设置目录 → 复制 remotion-pack → npm install 的步骤都在窗里显示），
   卡片只做状态展示与入口：未装 = 「安装」，已装 = 「重装」+「控制台」（它没有常驻后端，所以没有「启用」）。 */
async function refreshRemotionPluginCard(root) {
  return refreshBackendPluginCard(root, BACKEND_PLUGIN_SPECS.remotion, {
    /* 它没有常驻后端（无 start/stop）：未装 = 「安装」，已装 = 「重装」——安装走 npm install */
    reinstallLabel: I18n.t("重装"),
  });
}
async function refreshLlamaPluginCard(root) {
  return refreshBackendPluginCard(root, BACKEND_PLUGIN_SPECS.llama);
}
/* ---- Breeze TTS 2 本地 TTS（本机唯一的本地语音后端，breeze/main-breeze.js）
   卡片口径：三颗按钮 = 安装 / 启用 / 控制台 —— 「安装」（未装 / 要件不全）只开安装窗，
   「启用」只在已安装时出现（启停后端，不再开窗），「控制台」常驻（显式开窗）。
   安装 / 更新的过程与进度只显示在安装窗，卡片上不再有进度条与状态行小字。
   图标一律取 PLUGIN_ACT_SVG 里的 download / power / update / console，不自创 action kind。 */
async function refreshBreezePluginCard(root) {
  return refreshBackendPluginCard(root, BACKEND_PLUGIN_SPECS.breeze, {
    installLabel: (st) => (st.installed ? I18n.t("补装要件") : I18n.t("安装（国内镜像）")),
  });
}

/* ---- 本地语音转写：卡片已随「统一到 dsh 官方本地 SenseVoice」整块移除 ----
   从前这里有一张本地语音转写插件卡片（安装 / 控制台 / 补依赖 / 自我修复）。现在语音识别
   不再是本地 Python 后端，而是 dsh 运行时的官方 SenseVoice（模型权重由运行时自己下），
   所以：插件目录里没有这张卡片、这里没有刷新与进度订阅、preload 里也没有对应通道。
   画布节点级转写仍在（本轮起归音频 / 视频节点：renderer/app-asr.js 的转录按钮与文本区），
   它走 renderer/app-speech.js 那条通道。 */

/* ---- 本地图像生成（SenseNova-U1.5-8B-MoT）：插件卡片状态 + 控制台入口（sensenova/main-sensenova.js）
   卡片口径：三颗按钮 = 安装 / 启用 / 控制台 —— 未装 / 权重没齐时「安装（国内镜像）」只是
   开那只安装窗（脚本失败就在窗里手动重试或交会话修复，安装过程不再上卡片）；
   「启用」只在已安装时出现（点它静默后台拉起后端，不再自动开窗）；
   「控制台」常驻（原来的「状态与设置」并进它，避免两颗按钮开同一只窗）。
   注：新 kind 的按钮图标一律取自 PLUGIN_ACT_SVG（download / power / update / console），
   表里没有的 kind 会渲染成无图标的空方块（AGENTS.md 硬约定），不要自创 action kind。 */
async function refreshSensenovaPluginCard(root) {
  return refreshBackendPluginCard(root, BACKEND_PLUGIN_SPECS.sensenova, {
    installLabel: (st) => (st.installed ? I18n.t("补装权重") : I18n.t("安装（国内镜像）")),
  });
}

function pluginLoc(p, key) {  const v = p && p[key];
  if (v && typeof v === "object") {
    const loc = I18n.getLocale && I18n.getLocale() === "en" ? "en" : "zh";
    return v[loc] || v.zh || v.en || "";
  }
  return String(v || "");
}
function pluginCatalogHint(cat) {
  const src = cat && cat.source;
  /* 云端目录正常时不提示（列表本来就是云端的，再写一行说明纯属冗余）；
     只有云端不可用（缓存 / 内置兜底）时才给一句。 */
  if (src === "remote") return "";
  if (src === "cache") {
    return (
      I18n.t("云端目录暂不可用，已显示上次缓存。") +
      (cat.remoteError ? " (" + cat.remoteError + ")" : "")
    );
  }
  return (
    I18n.t("云端目录暂不可用，已显示内置列表。") +
    (cat && cat.remoteError ? " (" + cat.remoteError + ")" : "")
  );
}

/* ============ 插件显存门槛（本轮需求：显存不够的本地后端插件直接隐藏） ============
   名单与门槛的唯一真源在主进程 plugins/vram-gate.js：sensenova-local 24G · minimax-music3 24G ·
   yue2-local 16G · minimax-h3 16G。分工：
     · 主进程目录（appPluginsCatalog）已经把「显存不足且没装过」的插件滤掉了 —— 卡片、画布
       节点菜单、S.plugins 快照（节点未装警示条）都因此自动同步，渲染层不必各处再判一次；
     · 这一份不滤的现状（appPluginsVramState）只给两件事用：卡片上「本机显存可能不足」的标注，
       和对话框底部那个**低频找回入口**（「显示不支持的插件」，默认关，状态只在本次运行内存里）。
   ​口径三句话：读不到显存 → 照常显示；已装的 → 照常显示 + 标注；其余 → 藏。 */
const PLUGIN_VRAM_KNOWN_KINDS = {
  music3: "minimax-music3",
  yue2: "yue2-local",
  sensenova: "sensenova-local",
  /* H3（本地视频生成）：门槛 16G（真源 plugins/vram-gate.js） */
  h3: "minimax-h3",
};
/** 本次运行的「显示不支持的插件」开关（默认关；不落盘，重启即回默认） */
let _showUnsupportedPlugins = false;
/** 最近一次 appPluginsVramState 快照（卡片标注 + 开关文案用） */
let _pluginVramState = { ok: false, reading: null, plugins: [], hidden: [] };

/** 插件目录 id（卡片的 id 可能是 kind 别名，统一折成目录 id） */
function pluginVramIdOf(item) {
  const p = item || {};
  const id = String(p.id || "");
  if (id && id.indexOf("user-plugin:") === 0) return "";
  const kind = String(p.kind || p.handler || "");
  if (PLUGIN_VRAM_KNOWN_KINDS[kind]) {
    /* 目录里两种 id 都可能出现（minimax-music3 / music3）——门槛表只认目录 id */
    return PLUGIN_VRAM_KNOWN_KINDS[kind];
  }
  return id;
}

/** 拉一次不滤的显存门槛现状（主进程桥没有就直接回空态，界面照旧工作） */
async function pluginVramState(force) {
  const fn = window.api && window.api.appPluginsVramState;
  if (!fn) return _pluginVramState;
  try {
    const r = await fn(force === true ? { force: true } : undefined);
    if (r && typeof r === "object") _pluginVramState = r;
  } catch {}
  return _pluginVramState;
}
function pluginVramInfoOf(item) {
  const id = pluginVramIdOf(item);
  if (!id) return null;
  const list = (_pluginVramState && _pluginVramState.plugins) || [];
  return list.find((x) => x && x.id === id) || null;
}
/** 卡片当前这一份 item 上的门槛结论（主进程挂的元数据优先，其次查不滤快照） */
function pluginVramField(item) {
  const own = item && item.vram && typeof item.vram === "object" ? item.vram : null;
  if (own && (own.required === false || own.minVramGb > 0)) {
    return {
      required: own.required !== false,
      minVramGb: Number(own.minVramGb) || 0,
      vramOk: own.vramOk !== false,
      hide: own.hide === true,
      notice: String(own.notice || ""),
      reading: own.reading != null ? Number(own.reading) : null,
    };
  }
  const st = pluginVramInfoOf(item);
  if (!st) return null;
  return {
    required: true,
    minVramGb: Number(st.minVramGb) || 0,
    vramOk: st.vramOk !== false,
    hide: st.hide === true,
    notice: String(st.notice || ""),
    reading: pluginVramMachineReading(null),
  };
}
/** 本机显存读数（GB；读不到 → null）。目录挂的元数据优先，其次用不滤快照的那一次读数。 */
function pluginVramMachineReading(item) {
  const own = item && item.vram && typeof item.vram === "object" ? item.vram : null;
  if (own && own.reading != null && Number.isFinite(Number(own.reading))) return Number(own.reading);
  const r = _pluginVramState && _pluginVramState.reading;
  if (r && r.state === "ok" && r.vramGb != null && Number.isFinite(Number(r.vramGb))) return Number(r.vramGb);
  return null;
}
/** 卡片上那句「本机显存可能不足（本机 ≈XG · 需要 ≥YG）」；不达标又不该藏时才给 */
function pluginVramNoticeText(item) {
  const v = pluginVramField(item);
  if (!v || !v.required || v.vramOk) return "";
  const gb = pluginVramMachineReading(item);
  const reading = gb != null ? "≈" + gb + "G" : I18n.t("量不到");
  return I18n.t("本机显存可能不足（本机 {reading} · 需要 ≥{need}G）", {
    reading,
    need: String(v.minVramGb || 0),
  });
}
/** 显存不足的插件从目录里被滤掉了：用不滤快照把它的一条拼回列表（**只在开关打开时**用）。
 *  这条是「虚条目」：没有宿主可问，动作只留一颗置灰的按钮 + 写明原因。 */
function pluginVramHiddenItem(id, name) {
  const st = ((_pluginVramState && _pluginVramState.plugins) || []).find((x) => x && x.id === id);
  const vram = {
    required: true,
    id,
    minVramGb: st ? Number(st.minVramGb) || 0 : 0,
    vramOk: false,
    /* 开关已经打开才拼得出来，所以这里恒 false —— 卡片是可见的那一种 */
    hide: false,
    notice: st ? String(st.notice || "") : "",
    /* 带上本机读数：标注要写「本机 ≈8G」，不能因为这里没值就显示「量不到」（8G 是读到的） */
    reading: pluginVramMachineReading(null),
    readingState: "ok",
  };
  return {
    id,
    /* kind 不落 "unknown"：那条路是「认不出的云端插件，请升级主程序」，与显存无关。
       这里 kind:"vram" 让卡片渲染成普通窗口插件壳，动作只留一颗置灰的「本机显存不足」。 */
    kind: "vram",
    handler: "",
    order: 890,
    title: { zh: name || id, en: name || id },
    subtitle: {
      zh: I18n.t("本机显存不足，未显示该插件（本机 {reading} · 需要 ≥{need}G）", {
        reading: vram.reading != null ? "≈" + vram.reading + "G" : I18n.t("量不到"),
        need: String((st && st.minVramGb) || 24),
      }),
      en: "Hidden: not enough VRAM on this machine.",
    },
    version: "",
    /* compatible:false 让卡片的安装按钮置灰（「请先升级主程序」那句文案不改，它本来就是
       「这颗按钮点不动」的既有说法）；详情面板与卡片状态行都会写明显存不足的原因。 */
    compatible: false,
    vramOnly: true,
    vram,
  };
}
/** 被显存门槛滤掉、但用户勾了「显示不支持的插件」时要补回列表的那几条。
 *  **开关是这里的第一道闸**（默认关 → 返回空表，目录滤掉的那几个就不出现在列表里）；
 *  再按不滤快照确认它确实在「藏」的那一档（已装 / 门槛不适用 → 目录里本来就有，不必拼）。 */
function pluginVramHiddenItems() {
  if (_showUnsupportedPlugins !== true) return [];
  const known = [
    ["minimax-music3", "Minimax Music 3"],
    ["sensenova-local", "SenseNova 本地图像生成"],
    ["yue2-local", "YuE2 本地音乐"],
    ["minimax-h3", "Minimax H3"],
  ];
  const out = [];
  for (const [id, name] of known) {
    const st = ((_pluginVramState && _pluginVramState.plugins) || []).find((x) => x && x.id === id);
    if (!st || st.hide !== true) continue; /* 不在藏的那一档（已装 / 门槛不适用）→ 目录里本来就有 */
    out.push(pluginVramHiddenItem(id, name));
  }
  return out;
}
/** 对话框底部那一行低频入口：一句说明 + 一个开关 */
function buildPluginVramBar() {
  const row = document.createElement("div");
  row.className = "plugin-vram-bar";
  row.setAttribute("data-plugin-vram-bar", "1");
  const lab = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = _showUnsupportedPlugins === true;
  cb.setAttribute("data-plugin-vram-toggle", "1");
  cb.onchange = () => {
    _showUnsupportedPlugins = !!cb.checked;
    openAppPluginsDialog(); /* 开关只管这一张列表：原地重画（画布入口不受它影响） */
  };
  const txt = document.createElement("span");
  txt.textContent = I18n.t("显示不支持的插件");
  lab.appendChild(cb);
  lab.appendChild(txt);
  const hint = document.createElement("span");
  hint.className = "plugin-vram-hint";
  const reading = _pluginVramState && _pluginVramState.reading;
  hint.textContent =
    I18n.t("显存不足的本地后端插件默认隐藏（避免装完跑不起来）") +
    (reading && reading.state === "ok" && reading.vramGb != null
      ? " · " + I18n.t("本机显存 ≈") + reading.vramGb + "G"
      : "");
  row.appendChild(lab);
  row.appendChild(hint);
  return row;
}

function pluginErrText(err) {
  const s = String(err || "");
  if (s === "need_app_update") return I18n.t("请先升级主程序");
  if (s === "sha256_mismatch") return I18n.t("安装包校验失败");
  if (s === "not_window_plugin") return I18n.t("此插件需升级主程序后才能安装");
  if (s === "bad_zip_url") return I18n.t("下载地址无效");
  if (s === "pack_missing_entry") return I18n.t("安装包缺少入口页");
  if (s === "not_installed") return I18n.t("尚未安装");
  if (s === "not_ready") return I18n.t("尚未安装");
  if (s === "too_large") return I18n.t("安装包过大");
  if (s === "timeout") return I18n.t("下载超时");
  if (s === "busy") return I18n.t("正在安装…");
  return s || I18n.t("未知错误");
}
/* ============ 用户自建插件卡片（<数据目录>/user-plugins · 声明式） ============
   与上面的内置插件卡片同一套壳（.plugin-tile + 右侧 .plugin-pop 详情面板），但四态不同：
   正常 / 已停用 / 与当前版本不兼容 / 有错误 —— 状态一律来自主进程扫描结果（唯一真源），
   这里只负责显示与动作。动作全部走 window.api.userPlugins*（见 plugins/user-plugins.js）。 */
const USER_PLUGIN_STATE_TEXT = {
  normal: "正常",
  disabled: "已停用",
  incompatible: "与当前版本不兼容",
  error: "有错误",
};
const USER_PLUGIN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" width="56" height="56"><path d="M9 4h6a1.2 1.2 0 0 1 1.2 1.2v2.1h2.1A1.2 1.2 0 0 1 19.5 8.5v2.1h1.1a1 1 0 0 1 1 1v2.6a1 1 0 0 1-1 1h-1.1v2.1a1.2 1.2 0 0 1-1.2 1.2h-2.6v-1.1a1 1 0 0 0-1-1h-2.6a1 1 0 0 0-1 1v1.1H5.4a1.2 1.2 0 0 1-1.2-1.2v-6.4h1.1a1 1 0 0 0 1-1V8.5a1 1 0 0 0-1-1H4.2V5.2A1.2 1.2 0 0 1 5.4 4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

async function loadUserPluginItems() {
  if (!window.api || !window.api.userPluginsList) return [];
  try {
    const r = await window.api.userPluginsList(true);
    const list = (r && r.plugins) || [];
    return list.map((p) => ({
      id: "user-plugin:" + p.id,
      kind: "userplugin",
      handler: "userplugin",
      userPlugin: p,
      title: p.title || { zh: p.id, en: p.id },
      subtitle: p.subtitle || { zh: "", en: "" },
    }));
  } catch (e) {
    return [];
  }
}
function userPluginById(id) {
  const key = String(id || "").replace(/^user-plugin:/, "");
  return _userPluginItems.find((x) => x.userPlugin && x.userPlugin.id === key) || null;
}
function userPluginStateCls(p) {
  return (
    { normal: "np-ok", disabled: "np-off", incompatible: "np-warn", error: "np-err" }[p.state] ||
    "np-err"
  );
}
/** 主进程回来的原始插件对象 → 面板要用的形状（少了字段就按默认，绝不抛） */
function userPluginPanelModel(p) {
  const nodes = p.nodes || [];
  return {
    id: p.id,
    state: p.state,
    stateText: USER_PLUGIN_STATE_TEXT[p.state] || p.state,
    version: p.version || "",
    minAppVersion: p.minAppVersion || "",
    maxAppVersion: p.maxAppVersion || "",
    appVersion: p.appVersion || "",
    incompatible: p.incompatible || "",
    dir: p.dir || "",
    manifestPath: p.manifestPath || "",
    readmePath: p.readmePath || "",
    errors: p.errors || [],
    warnings: p.warnings || [],
    unknownKeys: p.unknownKeys || [],
    backend: p.backend || null,
    mcp: p.mcp || [],
    skills: p.skills || [],
    nodes: nodes,
  };
}
/** 详情面板：状态 / 版本区间 / 这个插件带来什么 / 字段说明 / 动作 */
function renderUserPluginPanel(pop, item) {
  const p = userPluginPanelModel(item.userPlugin || {});
  pop.innerHTML = "";
  const head = document.createElement("div");
  head.className = "plugin-pop-title";
  head.textContent = pluginLoc(item, "title") || p.id;
  pop.appendChild(head);
  const badge = document.createElement("div");
  badge.className = "np-badge " + userPluginStateCls(p);
  badge.textContent = I18n.t(p.stateText) + (p.version ? " · v" + p.version : "");
  pop.appendChild(badge);
  const sub = document.createElement("div");
  sub.className = "plugin-pop-desc";
  sub.textContent = pluginLoc(item, "subtitle") || "";
  pop.appendChild(sub);
  const row = (label, value) => {
    const d = document.createElement("div");
    d.className = "np-row";
    const l = document.createElement("span");
    l.className = "np-row-l";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "np-row-v";
    v.textContent = value;
    v.title = value;
    d.appendChild(l);
    d.appendChild(v);
    pop.appendChild(d);
  };
  row(I18n.t("插件目录"), p.dir);
  if (p.minAppVersion || p.maxAppVersion) {
    row(
      I18n.t("版本区间"),
      (p.minAppVersion || "—") + " ~ " + (p.maxAppVersion || "—") + " · " + I18n.t("当前 ") + p.appVersion,
    );
  }
  row(
    I18n.t("带来什么"),
    I18n.t("节点 ") + p.nodes.length + " · MCP " + p.mcp.length + " · " + I18n.t("技能 ") + p.skills.length,
  );
  if (p.incompatible) {
    const warn = document.createElement("div");
    warn.className = "np-warn-line";
    warn.textContent =
      p.incompatible === "min"
        ? I18n.t("本插件需要更新的 MTNode（") + p.minAppVersion + I18n.t(" 起）—— 请升级应用后重试")
        : I18n.t("本插件只支持到 MTNode ") + p.maxAppVersion + I18n.t("（当前 ") + p.appVersion + I18n.t("）—— 请联系插件作者更新清单");
    pop.appendChild(warn);
  }
  for (const e of p.errors) {
    const d = document.createElement("div");
    d.className = "np-err-line";
    d.textContent = "✕ " + e;
    pop.appendChild(d);
  }
  for (const w of p.warnings) {
    const d = document.createElement("div");
    d.className = "np-warn-line";
    d.textContent = "! " + w;
    pop.appendChild(d);
  }
  if (p.backend && (p.backend.hint || p.backend.healthUrl)) {
    const b = document.createElement("div");
    b.className = "np-backend";
    b.textContent =
      I18n.t("后端（插件不托管 · 需自行启动）：") +
      (p.backend.healthUrl ? " " + p.backend.healthUrl : "") +
      (pluginLocObj(p.backend.hint) ? " · " + pluginLocObj(p.backend.hint) : "");
    pop.appendChild(b);
  }
  /* 试运行此节点：每个节点一行（验证链路，不必先摆到画布上） */
  if (p.nodes.length) {
    const list = document.createElement("div");
    list.className = "np-nodes";
    for (const n of p.nodes) {
      const line = document.createElement("div");
      line.className = "np-node-line";
      const nm = document.createElement("span");
      nm.className = "np-node-name";
      nm.textContent = pluginLocObj(n.title) || n.kind;
      nm.title = n.kind;
      line.appendChild(nm);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mini";
      btn.textContent = I18n.t("试运行");
      btn.title = I18n.t("按清单声明的默认参数真跑一次（本机 HTTP 类会打你本机的接口）");
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        btn.textContent = I18n.t("运行中…");
        const r = await (typeof tryRunPluginNode === "function"
          ? tryRunPluginNode(n.kind)
          : Promise.resolve({ ok: false, error: I18n.t("插件节点模块未加载") }));
        btn.disabled = false;
        btn.textContent = I18n.t("试运行");
        if (r && r.ok) toast(I18n.t("试运行成功：") + String(r.output || "").slice(0, 120), "ok");
        else toast(I18n.t("试运行失败：") + ((r && r.error) || ""), "err");
      };
      line.appendChild(btn);
      list.appendChild(line);
    }
    pop.appendChild(list);
  }
  /* 字段说明（内置 · 可展开）：面板上没有的几条（目录 / 顶层键 / 占位符 / 安全） */
  const det = document.createElement("details");
  det.className = "np-help";
  const sum = document.createElement("summary");
  sum.textContent = I18n.t("清单要点");
  det.appendChild(sum);
  const pre = document.createElement("pre");
  pre.className = "np-help-pre";
  pre.textContent = userPluginManifestHelp();
  det.appendChild(pre);
  pop.appendChild(det);
  /* 动作区 */
  const acts = document.createElement("div");
  acts.className = "np-acts";
  const mk = (label, fn, opts) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini" + (opts && opts.primary ? " primary" : "");
    b.textContent = label;
    b.onclick = async (ev) => {
      ev.stopPropagation();
      b.disabled = true;
      try {
        await fn();
      } finally {
        b.disabled = false;
      }
    };
    acts.appendChild(b);
    return b;
  };
  mk(
    p.disabled ? I18n.t("启用（重扫）") : I18n.t("停用"),
    async () => {
      const r = await window.api.userPluginsSetEnabled(p.id, !p.disabled);
      if (!r || !r.ok) toast(I18n.t("操作失败：") + pluginErrText(r && r.error), "err");
      else {
        if (typeof loadPluginNodes === "function") await loadPluginNodes(true);
        await refreshUserPluginCard(item, true);
        toast(p.disabled ? I18n.t("已启用（重启应用后节点生效）") : I18n.t("已停用"), "ok");
      }
    },
    { primary: true },
  );
  mk(I18n.t("重扫目录"), async () => {
    await window.api.userPluginsRescan();
    if (typeof loadPluginNodes === "function") await loadPluginNodes(true);
    await refreshUserPluginCard(item, true);
    toast(I18n.t("已重扫插件目录"), "ok");
  });
  mk(I18n.t("修复"), async () => {
    const r = await window.api.userPluginsRepair(p.id);
    const lines = ((r && r.steps) || []).map(
      (s) => (s.ok === false ? "✕ " : "✓ ") + s.step + (s.note ? " · " + s.note : "") + (s.error ? " · " + s.error : ""),
    );
    if (r && r.ok) toast(I18n.t("修复完成：") + lines.join(" | ").slice(0, 200), "ok");
    else toast(I18n.t("修复未通过：") + lines.join(" | ").slice(0, 200), "warn");
    if (typeof loadPluginNodes === "function") await loadPluginNodes(true);
    await refreshUserPluginCard(item, true);
  });
  mk(I18n.t("重启应用以生效"), async () => {
    if (typeof confirmDialog === "function") {
      const yes = await confirmDialog(I18n.t("插件在应用启动时加载：现在重启 MTNode？"), {
        title: I18n.t("重启应用"),
        okText: I18n.t("立即重启"),
      });
      if (!yes) return;
    }
    await window.api.userPluginsRelaunch();
  });
  mk(I18n.t("打开插件目录"), async () => {
    await window.api.userPluginsOpenFolder(p.id);
  });
  mk(I18n.t("诊断导出"), async () => {
    const r = await window.api.userPluginsExport(p.id);
    if (r && r.ok) toast(I18n.t("诊断包已导出：") + r.path, "ok");
    else toast(I18n.t("导出失败"), "err");
  });
  if (p.state === "error" || p.state === "incompatible") {
    mk(I18n.t("交给 Agent 诊断"), async () => {
      if (typeof pluginRepairHandleError !== "function") {
        toast(I18n.t("修复会话不可用"), "warn");
        return;
      }
      await pluginRepairHandleError({
        pluginId: p.id,
        pluginName: pluginLoc(item, "title") || p.id,
        kind: "userplugin",
        installDir: p.dir,
        code: p.state === "incompatible" ? "incompatible_version" : "manifest_invalid",
        message: (p.errors[0] || "") + (p.incompatible ? I18n.t("（版本区间不匹配）") : ""),
        log: p.errors.concat(p.warnings).join("\n"),
        repairable: true,
      });
    });
  }
  pop.appendChild(acts);
}
function pluginLocObj(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v.zh || v.en || "");
  return String(v);
}
/** 清单要点（与 plugins/user-plugins.js 的 README_TEMPLATE 同一份口径）：只列面板上没交代的几条，
    字段本身在详情面板逐项回显，不在这里再抄一遍 */
function userPluginManifestHelp() {
  return [
    I18n.t("目录：<数据目录>/user-plugins/<插件id>/mtnode-plugin.json（另有 _example 模板可照抄）"),
    "",
    I18n.t("顶层键：id / title / version 见上方详情；另有 nodes[]（画布节点）、mcp[]（写进 cordis-user.yml）、skills[]（skills/<name>/SKILL.md 或内联 body）。"),
    I18n.t("backend：{hint, healthUrl, startCommand} —— 后端由你自己启动，应用不托管"),
    "",
    I18n.t("模板占位符：{input:端口id} / {inputJson:端口id} / {text} / {param:参数id} / {node:title} / {plugin:id}"),
    I18n.t("安全：插件目录里不允许任何会被执行的 JS —— 清单只是一份声明。"),
  ].join("\n");
}
async function refreshUserPluginCard(item, forceReload) {
  const r = await window.api.userPluginsList(true);
  const list = (r && r.plugins) || [];
  const p = list.find((x) => x.id === item.userPlugin.id) || null;
  if (!p) return;
  item.userPlugin = p;
  item.title = p.title || item.title;
  item.subtitle = p.subtitle || item.subtitle;
  _userPluginItems = _userPluginItems.map((x) =>
    x.id === item.id ? Object.assign({}, x, { userPlugin: p, title: item.title, subtitle: item.subtitle }) : x,
  );
  const host = document.querySelector('.plugin-tile[data-plugin-id="' + item.id + '"]');
  if (!host) return;
  host._pluginItem = item;
  setPluginVer(host, { version: p.version });
  const badge = host.querySelector(".np-state");
  if (badge) {
    badge.className = "np-state " + userPluginStateCls(p);
    badge.textContent = I18n.t(USER_PLUGIN_STATE_TEXT[p.state] || p.state);
  }
  const sum = host.querySelector(".np-sum");
  if (sum)
    sum.textContent =
      I18n.t("节点 ") + (p.nodes || []).length + " · MCP " + (p.mcp || []).length + " · " + I18n.t("技能 ") + (p.skills || []).length;
  const pop = document.querySelector("#overlay > .plugin-pop");
  const tile = pop && pop.querySelector("[data-np-for]");
  if (pop && tile && tile.getAttribute("data-np-for") === item.id) renderUserPluginPanel(pop, item);
  if (forceReload && typeof loadPluginNodes === "function") await loadPluginNodes(true);
}
function mkUserPluginCard(item) {
  const p = item.userPlugin || {};
  const card = document.createElement("div");
  card.className = "plugin-tile np-tile";
  card.setAttribute("data-plugin-id", item.id);
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  if (p.version) card.dataset.catalogVer = String(p.version);
  card.innerHTML =
    '<div class="plugin-tile-cover np-cover">' + USER_PLUGIN_SVG + "</div>" +
    '<div class="plugin-tile-title"></div>' +
    '<div class="plugin-tile-ver" data-plugin-ver></div>' +
    '<div class="np-sum"></div>' +
    '<div class="np-state"></div>' +
    '<div class="plugin-tile-actions" data-plugin-actions></div>';
  card.querySelector(".plugin-tile-title").textContent = pluginLoc(item, "title") || p.id;
  card.querySelector("[data-plugin-ver]").textContent = p.version ? "v" + p.version : "";
  card.querySelector(".np-sum").textContent =
    I18n.t("节点 ") + (p.nodes || []).length + " · MCP " + (p.mcp || []).length + " · " + I18n.t("技能 ") + (p.skills || []).length;
  const badge = card.querySelector(".np-state");
  badge.className = "np-state " + userPluginStateCls(p);
  badge.textContent = I18n.t(USER_PLUGIN_STATE_TEXT[p.state] || p.state);
  return card;
}
async function refreshUserPluginItemDlgCount() {
  try {
    const r = await window.api.userPluginsList(false);
    return ((r && r.plugins) || []).length;
  } catch {
    return 0;
  }
}
/* 顶栏「插件」对话框：自建插件区的工具条动作（导入 / 打开目录 / 重扫并重启提示） */
async function openUserPluginsImport() {
  const r = await window.api.userPluginsImport({});
  if (!r || !r.ok) {
    if (r && r.needOverwrite) {
      const yes =
        typeof confirmDialog === "function"
          ? await confirmDialog(I18n.t("同名插件已存在，覆盖安装？") + " " + r.id, {
              title: I18n.t("导入插件"),
              okText: I18n.t("覆盖"),
            })
          : false;
      if (!yes) return;
      const r2 = await window.api.userPluginsImport({ path: r.path, overwrite: true });
      if (r2 && r2.ok) toast(I18n.t("已导入插件：") + r2.id, "ok");
      else toast(I18n.t("导入失败：") + pluginErrText(r2 && r2.error), "err");
    } else if (r && r.error !== "cancelled") {
      toast(I18n.t("导入失败：") + pluginErrText(r && r.error), "err");
    }
    if (typeof loadPluginNodes === "function") await loadPluginNodes(true);
    return;
  }
  if (typeof loadPluginNodes === "function") await loadPluginNodes(true);
  toast(I18n.t("已导入插件：") + r.id + I18n.t("（重启应用后节点生效）"), "ok");
}

/* 窗口插件 / 桌宠的**安装进度不再挂在卡片上**：下载 / 校验 / 解压都走同一只安装窗，
   过程与进度在窗里逐步骤显示（plugins/main-install.js 的 reportPluginStep）。
   原来这里的 bindPluginProgress（把 pet:progress / appPlugins:progress 画成卡片进度条）
   已随本轮需求整块移除 —— 卡片只留图标 + 标题 + 动作按钮 + 状态行。 */
/* 按插件 kind 重画一张卡片（安装窗里跑完一次安装后统一重画用） */
function repaintPluginCard(card, item) {
  const k = (item && (item.kind || item.handler)) || "";
  const map = {
    pet: refreshPetPluginCard,
    music3: refreshMusic3PluginCard,
    yue2: refreshYuePluginCard,
    sensenova: refreshSensenovaPluginCard,
    h3: refreshH3PluginCard,
    remotion: refreshRemotionPluginCard,
    llama: refreshLlamaPluginCard,
    breeze: refreshBreezePluginCard,
  };
  const fn = map[k];
  if (fn) return fn(card);
  return refreshWindowPluginCard(card, card._pluginItem || item);
}
async function refreshWindowPluginCard(host, item) {
  const actions = host.querySelector("[data-plugin-actions]");
  if (!actions) return;
  const st = item || {};
  setPluginVer(host, st);
  actions.innerHTML = "";
  /* 显存门槛拼回来的虚拟条目（开关打开时才出现）：没有宿主动作可做，只标明原因 */
  if (st.vramOnly) {
    const line = host.querySelector("[data-plugin-progress-txt]");
    if (line) {
      line.style.display = "";
      line.textContent = pluginVramNoticeText(st) || I18n.t("本机显存不足");
    }
  }
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  if (!st.compatible) {
    addBtn(
      "download",
      st.vramOnly ? I18n.t("本机显存不足，无法安装") : I18n.t("请先升级主程序"),
      null,
      { disabled: true },
    );
    return;
  }
  if (st.kind === "unknown") {
    addBtn("download", I18n.t("请更新应用以使用此插件"), null, { disabled: true });
    return;
  }
  if (!st.installed) {
    addBtn("download", I18n.t("下载安装"), async () => {
      /* 窗口插件的下载 / 校验 / 解压也走同一只安装窗（本轮共识）：窗内触发 appPlugins:install，
         主进程把 phase 翻成步骤上报；卡片只重绘状态。 */
      await openPluginInstallWindow({
        id: st.id,
        name: pluginLoc(st, "title") || st.id,
        action: "install",
        kind: "window",
      });
      const cat = await window.api.appPluginsCatalog();
      const next = ((cat && cat.plugins) || []).find((p) => p.id === st.id);
      if (next) host._pluginItem = next;
      refreshWindowPluginCard(host, next || st);
    }, { primary: true });
    return;
  }
  let winOpen = false;
  if (window.api.appPluginsIsOpen) {
    try {
      const ir = await window.api.appPluginsIsOpen(st.id);
      winOpen = !!(ir && ir.open);
    } catch {}
  }
  if (winOpen) {
    addBtn("stop", I18n.t("停止"), async () => {
      if (window.api.appPluginsClose) await window.api.appPluginsClose(st.id);
      refreshWindowPluginCard(host, host._pluginItem || st);
    });
  } else {
    addBtn("play", I18n.t("运行"), async () => {
      const r = await window.api.appPluginsOpen(st.id);
      if (!r || !r.ok) toast(I18n.t("打开失败：") + pluginErrText(r && r.error), "err");
      refreshWindowPluginCard(host, host._pluginItem || st);
    }, { primary: true });
  }
  if (st.updateAvailable) {
    addBtn("update", I18n.t("更新"), async () => {
      await openPluginInstallWindow({
        id: st.id,
        name: pluginLoc(st, "title") || st.id,
        action: "update",
        kind: "window",
      });
      const cat = await window.api.appPluginsCatalog();
      const next = ((cat && cat.plugins) || []).find((p) => p.id === st.id);
      if (next) host._pluginItem = next;
      refreshWindowPluginCard(host, next || st);
    });
  }
}
function mkPluginCardShell(item) {
  const card = document.createElement("div");
  card.className = "plugin-tile";
  card.setAttribute("data-plugin-id", item.id);
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  if (item.version) card.dataset.catalogVer = String(item.version);
  const iconUrl = pluginIconUrl(item);
  const ver = pluginVerLabel(item, card);
  card.innerHTML =
    '<div class="plugin-tile-cover">' +
    (iconUrl
      ? '<img alt="" width="128" height="128">'
      : '<div class="plugin-tile-ph"></div>') +
    "</div>" +
    '<div class="plugin-tile-title"></div>' +
    '<div class="plugin-tile-ver" data-plugin-ver></div>' +
    /* 后端求助角标（本轮：ui-signal 不再自动弹窗 → 卡片上给一枚可见提示，见 setPluginNotice） */
    '<div class="plugin-tile-notice" data-plugin-notice hidden></div>' +
    '<div class="plugin-tile-actions" data-plugin-actions data-pet-actions></div>' +
    /* 卡片上不再有安装进度条（`data-plugin-progress` 已删）：安装过程与进度只显示在安装窗。
       这一行是**状态行**（启动失败原因 / 后端提示 / 启动中），与安装进度无关。 */
    '<div class="plugin-progress-txt" data-plugin-progress-txt data-pet-progress-txt style="display:none"></div>';
  card.querySelector(".plugin-tile-title").textContent = pluginLoc(item, "title") || item.id;
  card.querySelector("[data-plugin-ver]").textContent = ver;
  const img = card.querySelector(".plugin-tile-cover img");
  if (img) {
    img.alt = pluginLoc(item, "title") || item.id;
    bindPluginCover(img, item);
  }
  /* 显存门槛标注（已装但不达标 / 开关翻出来的那一档）：角标只是可见提示，
     真正的动作限制由卡片自己的动作区决定（见 refreshWindowPluginCard）。 */
  const noticeText = pluginVramNoticeText(item);
  if (noticeText) {
    const el = card.querySelector("[data-plugin-notice]");
    if (el) {
      el.hidden = false;
      el.textContent = noticeText;
      el.title = noticeText;
    }
  }
  /* 已装 + 安装后自检通过 → 封面左上角打勾（本轮需求） */
  paintPluginDone(card, item.id);
  return card;
}
async function openAppPluginsDialog() {
  openOverlay(I18n.t("插件"));
  overlayPersistent = true;
  _plugRootDialog = true;
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.innerHTML = "";
  foot.innerHTML = "";

  /* 插件根目录那一行（本轮需求：插件界面一个总的根目录）：值还没读回来之前先占位 */
  const rootBar = buildPlugRootBar();
  body.appendChild(rootBar);

  const intro = document.createElement("div");
  intro.className = "settings-hint";
  intro.style.marginBottom = "12px";
  intro.textContent = I18n.t("正在拉取云端插件目录…");
  body.appendChild(intro);

  if (_petProgressOff) {
    try { _petProgressOff(); } catch {}
    _petProgressOff = null;
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "mini";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = () => {
    _plugRootDialog = false;
    if (_petProgressOff) {
      try { _petProgressOff(); } catch {}
      _petProgressOff = null;
    }
    closeOverlay();
  };
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "mini";
  refreshBtn.textContent = I18n.t("刷新目录");
  refreshBtn.onclick = () => openAppPluginsDialog();
  /* 用户自建插件区的两个入口：导入（zip / 目录）与打开插件目录。
     与卡片上的动作同一套 IPC，不另开界面。 */
  const importBtn = document.createElement("button");
  importBtn.className = "mini";
  importBtn.textContent = I18n.t("导入插件");
  importBtn.title = I18n.t("选择插件目录或 .zip 包导入（导入后自动重扫）");
  importBtn.onclick = async () => {
    await openUserPluginsImport();
    openAppPluginsDialog();
  };
  /* 「打开插件目录」= 打开当前插件根目录（没设过就用推断出来的那个；都没有则置灰禁用）。
     用户自建插件目录 <数据目录>/user-plugins 的入口在自建插件区的工具条上，不受影响。 */
  const dirBtn = document.createElement("button");
  dirBtn.className = "mini";
  dirBtn.setAttribute("data-plugin-root-open", "1");
  dirBtn.textContent = I18n.t("打开插件目录");
  dirBtn.title = I18n.t("在文件管理器里打开插件根目录");
  dirBtn.onclick = async () => {
    const fn = pluginApiFn("appPluginsRootOpen");
    if (!fn) {
      await window.api.userPluginsOpenFolder();
      return;
    }
    const r = await fn();
    if (!r || !r.ok) toast(I18n.t("打开插件根目录失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
  };
  foot.appendChild(closeBtn);
  foot.appendChild(importBtn);
  foot.appendChild(dirBtn);
  foot.appendChild(refreshBtn);

  let cat = { ok: true, source: "fallback", plugins: [] };
  try {
    if (window.api && window.api.appPluginsCatalog)
      cat = (await window.api.appPluginsCatalog()) || cat;
  } catch (e) {
    cat.remoteError = (e && e.message) || String(e);
  }
  intro.textContent = pluginCatalogHint(cat);
  intro.hidden = !intro.textContent; /* 云端目录正常时没有说明 → 不留一个空占位 */
  /* 显存门槛现状（**不滤**的那一份）：卡片标注 + 底部开关都要它。
     顺序上必须在拼 list 之前 —— 开关打开时要用它把被滤掉的卡片拼回列表。 */
  /* 自检现状（卡片封面左上角的勾）与显存门槛现状一起先拉：都在拼卡片之前。 */
  await loadPluginCheckState();
  await pluginVramState();
  /* 根目录现状：未设的提示 + 推断出来的预填值都画进顶部那一行（只预填不写盘） */
  repaintPlugRootBar(await plugRootInfo());
  /* 一次把 8 个后端插件的「这次该装到哪」问齐（各卡片状态行要用）：并行一次，别一卡一次。
     顺序上必须晚于 plugRootInfo —— 没设过目录的插件，默认路径要用根目录拼出来。 */
  await Promise.all(
    Object.keys(BACKEND_PLUGIN_SPECS).map((k) => plugInstallDir(BACKEND_INSTALL_IDS[k] || k)),
  );
  const list = (
    Array.isArray(cat.plugins) && cat.plugins.length
      ? cat.plugins
      : [
          {
            id: "bongochat",
            kind: "pet",
            handler: "pet",
            icon: "bongochat.png",
            version: "0.3.7",
            title: { zh: "BongoChat", en: "BongoChat" },
            subtitle: { zh: I18n.t("可以聊天的BongoCat！"), en: "A BongoCat you can chat with!" },
            compatible: true,
          },
          {
            id: "llama-local",
            kind: "llama",
            handler: "llama",
            icon: "llama-local.png",
            version: "1.0.0",
            title: { zh: "llama.cpp 本地模型", en: "llama.cpp Local Models" },
            subtitle: {
              zh: I18n.t("基于 llama.cpp 的本地 GGUF 模型管理：指定目录安装、国内镜像、多模型显存管理、OpenAI 兼容 API。"),
              en: "llama.cpp local GGUF model manager with CN mirrors and VRAM management.",
            },
                        compatible: true,
            installed: true,
          },
          {
            id: "breeze-tts-local",
            kind: "breeze",
            handler: "breeze",
            icon: "breeze-tts-local.png",
            version: "1.0.0",
            title: { zh: "Breeze TTS 2 本地 TTS", en: "Breeze TTS 2 Local TTS" },
            subtitle: {
              zh: I18n.t("Breeze TTS 2（实时流式 · 音色克隆 / 设计 / 导演）：参考片段音色库、OpenAI 兼容 TTS API；画布「Breeze 语音」节点。权重仅限研究与非商用。"),
              en: "Breeze TTS 2 (streaming · clone / design / direction): reference-clip voice library, OpenAI-compatible TTS API; canvas Breeze voice node. Weights are research / non-commercial only.",
            },
            compatible: true,
            installed: true,
          },
        ]
  ).filter((p) => p && p.id !== "forum");

  /* 显存门槛：目录侧已经把「显存不足且没装过」的插件滤掉了（画布入口与节点警示条同源）。
     这里只在用户勾了「显示不支持的插件」时，用不滤快照把它们的卡片拼回来 —— 只影响这一张
     列表，画布入口保持隐藏（用户共识）。 */
  const hiddenByVram = pluginVramHiddenItems();
  if (hiddenByVram.length) list.push(...hiddenByVram);
  /* 底部那一行低频入口（默认关）：给愿意折腾的用户留一条找回路径 */
  body.appendChild(buildPluginVramBar());

  const wrap = document.createElement("div");
  wrap.className = "plugin-grid-wrap";
  const pop = document.createElement("div");
  pop.className = "plugin-pop";
  pop.setAttribute("role", "dialog");
  const grid = document.createElement("div");
  grid.className = "plugin-grid";
  wrap.appendChild(grid);
  /* 插件详情面板（role=dialog）persistent：点它周围的空白不再收起，
     关它只走「再点一次这张卡片」与「简介」那条显式切换路径 —— 见 AGENTS.md */
  const overlayEl = $("#overlay");
  overlayEl.querySelectorAll(":scope > .plugin-pop").forEach((el) => el.remove());
  overlayEl.appendChild(pop);
  pop.addEventListener("click", (e) => e.stopPropagation());
  intro.addEventListener("click", () => closePluginPop(wrap, pop));
  body.appendChild(wrap);
  const onReposition = () => {
    const sel = wrap.querySelector(".plugin-tile.sel");
    if (sel) positionPluginPop(wrap, pop, sel);
  };
  body.addEventListener("scroll", onReposition);
  window.addEventListener("resize", onReposition);

  const offs = [];
  offs.push(() => {
    body.removeEventListener("scroll", onReposition);
    window.removeEventListener("resize", onReposition);
    if (pop && pop.parentNode) pop.remove();
  });
  for (const item of list) {
    const card = mkPluginCardShell(item);
    card._pluginItem = item;
    const openPop = () => openPluginPop(wrap, pop, card, item);
    card.addEventListener("click", (ev) => {
      if (ev.target.closest(".plugin-tile-actions")) return;
      openPop();
    });
    card.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      openPop();
    });
    grid.appendChild(card);
    card._repaint = () => repaintPluginCard(card, card._pluginItem || item);
    if (item.kind === "pet" || item.handler === "pet") {
      refreshPetPluginCard(card);
    } else if (item.kind === "music3" || item.handler === "music3") {
      if (window.api && window.api.onMusic3ConsoleChanged) {
        offs.push(window.api.onMusic3ConsoleChanged(() => refreshMusic3PluginCard(card)));
      }
      refreshMusic3PluginCard(card);
    } else if (item.kind === "yue2" || item.handler === "yue2") {
      if (window.api && window.api.onYueConsoleChanged) {
        offs.push(window.api.onYueConsoleChanged(() => refreshYuePluginCard(card)));
      }
      refreshYuePluginCard(card);
    } else if (item.kind === "sensenova" || item.handler === "sensenova") {
      if (window.api && window.api.onSensenovaConsoleChanged) {
        offs.push(window.api.onSensenovaConsoleChanged(() => refreshSensenovaPluginCard(card)));
      }
      refreshSensenovaPluginCard(card);
    } else if (item.kind === "h3" || item.handler === "h3") {
      if (window.api && window.api.onH3ConsoleChanged) {
        offs.push(window.api.onH3ConsoleChanged(() => refreshH3PluginCard(card)));
      }
      refreshH3PluginCard(card);
    } else if (item.kind === "remotion" || item.handler === "remotion") {
      if (window.api && window.api.onRemotionConsoleChanged) {
        offs.push(
          window.api.onRemotionConsoleChanged(() => refreshRemotionPluginCard(card)),
        );
      }
      refreshRemotionPluginCard(card);
    } else if (item.kind === "llama" || item.handler === "llama") {
      if (window.api && window.api.onLlamaConsoleChanged) {
        offs.push(window.api.onLlamaConsoleChanged(() => refreshLlamaPluginCard(card)));
      }
      /* 后端求助（ui-signal）不再自动弹窗：收到 llama:notice 就重绘卡片（角标 + 状态行） */
      if (window.api && window.api.onLlamaNotice) {
        offs.push(window.api.onLlamaNotice(() => refreshLlamaPluginCard(card)));
      }
      /* 登记链刷新（部署 / 停止 / 托盘改过配置）：卡片上的告警行与状态跟着重画 */
      if (window.api && window.api.onLlamaProviderSynced) {
        offs.push(window.api.onLlamaProviderSynced(() => refreshLlamaPluginCard(card)));
      }
      refreshLlamaPluginCard(card);
    } else if (item.kind === "breeze" || item.handler === "breeze") {
      if (window.api && window.api.onBreezeConsoleChanged) {
        offs.push(window.api.onBreezeConsoleChanged(() => refreshBreezePluginCard(card)));
      }
      if (window.api && window.api.onBreezeNotice) {
        offs.push(window.api.onBreezeNotice(() => refreshBreezePluginCard(card)));
      }
      refreshBreezePluginCard(card);
    } else {
      if (window.api && window.api.onAppPluginsWindowChanged) {
        offs.push(
          window.api.onAppPluginsWindowChanged((data) => {
            if (!data || data.id !== item.id) return;
            refreshWindowPluginCard(card, card._pluginItem || item);
          }),
        );
      }
      refreshWindowPluginCard(card, item);
    }
  }
  _petProgressOff = () => {
    offs.forEach((fn) => {
      try { fn(); } catch {}
    });
  };
  /* 安装窗里跑完一次安装（成功 / 失败 / 取消）后主窗口并无进度事件可听：
     主进程在终局时广播 mtnodeInstall:finished —— 这里统一重画卡片 + 刷新画布插件缓存
     （卡片状态：装了 / 还没装 / 要件补齐；画布节点菜单可见性随之更新）。 */
  if (window.api && window.api.onMtnodeInstallFinished) {
    offs.push(
      window.api.onMtnodeInstallFinished(() => {
        grid.querySelectorAll("[data-plugin-id]").forEach((el) => {
          try { if (el._repaint) el._repaint(); } catch {}
        });
        if (typeof refreshAppPluginsCache === "function") {
          try { refreshAppPluginsCache().catch(() => {}); } catch {}
        }
        /* 装完那次自检的结论可能刚到：重新拉一次勾的状态并补画（勾只给自检通过的插件） */
        void loadPluginCheckState().then(() => {
          grid.querySelectorAll("[data-plugin-id]").forEach((el) => {
            try { paintPluginDone(el, el.getAttribute("data-plugin-id")); } catch {}
          });
        });
      }),
    );
  }
  /* 自检结论变了（安装窗里跑完 / 清理过）：重拉一次状态并补画勾 */
  if (window.api && window.api.onPluginSelfcheckChanged) {
    offs.push(
      window.api.onPluginSelfcheckChanged(() => {
        void loadPluginCheckState().then(() => {
          grid.querySelectorAll("[data-plugin-id]").forEach((el) => {
            try { paintPluginDone(el, el.getAttribute("data-plugin-id")); } catch {}
          });
        });
      }),
    );
  }
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "settings-hint";
    empty.textContent = I18n.t("暂无插件");
    body.appendChild(empty);
  }
  /* ── 用户自建插件（<数据目录>/user-plugins）──
     与上面的商店插件同一套卡片壳，单独一段：它们是用户自己放进目录的声明式插件，
     不随版本更新失效，坏了一键修复。段头只留位置，写法在卡片详情里看。 */
  _userPluginItems = await loadUserPluginItems();
  const sep = document.createElement("div");
  sep.className = "settings-hint np-sep";
  sep.textContent = I18n.t("自建插件") + " · " + I18n.t("目录：") + "user-plugins";
  body.appendChild(sep);
  if (_userPluginItems.length) {
    const grid2 = document.createElement("div");
    grid2.className = "plugin-grid";
    body.appendChild(grid2);
    for (const item of _userPluginItems) {
      const card = mkUserPluginCard(item);
      card._pluginItem = item;
      const openPop = () => openPluginPop(wrap, pop, card, item);
      card.addEventListener("click", (ev) => {
        if (ev.target.closest(".plugin-tile-actions")) return;
        openPop();
      });
      card.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        openPop();
      });
      grid2.appendChild(card);
      /* 卡片上的快捷动作：正常/停用 = 启停；异常 = 修复（详情面板里有全套） */
      const actions = card.querySelector("[data-plugin-actions]");
      if (actions) {
        const p = item.userPlugin || {};
        const btn = (kind, title, fn, opts) => {
          const b = mkPluginActBtn(kind, title, fn, opts);
          actions.appendChild(b);
          return b;
        };
        if (p.state === "normal" || p.state === "disabled") {
          btn(
            p.state === "normal" ? "stop" : "play",
            p.state === "normal" ? I18n.t("停用") : I18n.t("启用"),
            async () => {
              await window.api.userPluginsSetEnabled(p.id, p.state === "normal");
              if (typeof loadPluginNodes === "function") await loadPluginNodes(true);
              await refreshUserPluginCard(item, true);
            },
            { on: p.state === "normal" },
          );
        } else {
          btn(
            "gear",
            I18n.t("修复"),
            async () => {
              const r = await window.api.userPluginsRepair(p.id);
              toast(
                (r && r.ok ? I18n.t("修复完成") : I18n.t("修复未通过")) +
                  "：" +
                  (((r && r.steps) || [])
                    .map((s) => (s.ok === false ? "✕" : "✓") + s.step)
                    .join(" ")),
                r && r.ok ? "ok" : "warn",
              );
              if (typeof loadPluginNodes === "function") await loadPluginNodes(true);
              await refreshUserPluginCard(item, true);
            },
            { primary: true },
          );
        }
        btn("gear", I18n.t("详情 / 修复 / 节点"), openPop);
      }
    }
  }
}

/* ============ 扩展能力管理（DSH 插件 / 技能 Skills / MCP 服务器 统一对话框）
   设置里这三类扩展原本各占一块（DSH 插件还内联一长串列表），现整合成一个
   「扩展能力」界面，一律通过「管理」打开本对话框；DSH 插件只是其中一个分类，
   技能与 MCP 复用同一套「卡片清单 + 右侧详情」的样式（.dsh-plugin-card /
   .dsh-plugins-info），让三个分类看起来是同一个东西，而不是各写一遍的面板。
   宿主改为 #extManagerDlg，并顺带清掉旧版 #dshPluginsDlg，避免改版后残留两个实例。
   ============ */

const EXT_KINDS = [
  {
    key: "dsh",
    zh: "DSH 插件",
    tab: "DSH",
    grid: "dshPluginsGrid",
    empty: "暂无 DSH 插件（点上方「＋ 安装插件」）",
    install: true,
    newLabel: "＋ 安装插件",
  },
  {
    key: "skill",
    zh: "技能 Skills",
    tab: "Skill",
    grid: "dshSkillsGrid",
    empty: "暂无技能（点上方「＋ 创建技能」）",
    install: false,
    newLabel: "＋ 创建技能",
  },
  {
    key: "mcp",
    zh: "MCP 服务器",
    tab: "MCP",
    grid: "dshMcpGrid",
    empty: "暂无 MCP 服务器（点上方「＋ 添加服务器」）",
    install: false,
    newLabel: "＋ 添加服务器",
  },
  {
    /* MTNode 自己作为 **MCP 服务端**（与上面那条相反的方向：上面是 MTNode 去连别人的
       MCP 服务器，这一条是第三方客户端连进来操作 MTNode）。见 mcp-server.js 与
       guides/mcp-server.md；面板没有清单（只有一个服务端），右侧整块就是它。 */
    key: "server",
    zh: "MCP 服务端",
    tab: "服务端",
    grid: "dshMcpServerGrid",
    empty: "MCP 服务端未启用",
    install: false,
    newLabel: "",
    countKey: "mcpServer",
    noStore: true,
    toolbarNone: true,
  },
];

const EXT_KIND = {};
for (const k of EXT_KINDS) EXT_KIND[k.key] = k;

const EXT_UI = {
  open: false,
  kind: "dsh",
  hintEl: null,
  loaded: { dsh: false, skill: false, mcp: false, server: false },
  errors: { dsh: "", skill: "", mcp: "", server: "" },
  state: {
    dsh: { list: [], selectedKey: "", query: "" },
    skill: { list: [], selectedKey: "", query: "", editor: null },
    mcp: { list: [], selectedKey: "", query: "", editor: null },
    /* MCP 服务端：不是清单，只有一份运行状态 + 最近调用 / 抓包（见 mcpState / mcpPanel） */
    server: {
      list: [],
      selectedKey: "",
      query: "",
      info: null,
      audit: [],
      capture: [],
      busy: false,
      selfTest: null,
    },
  },
};

function extState(kind) {
  return EXT_UI.state[kind] || EXT_UI.state.dsh;
}

function extItems(kind) {
  if (kind === "skill") {
    return (EXT_UI.state.skill.list || []).filter(
      (s) => !isInstallOnlySkillName(s && s.name),
    );
  }
  return EXT_UI.state[kind] ? EXT_UI.state[kind].list || [] : [];
}

function extKeyOf(kind, it) {
  if (kind === "skill") return String((it && it.name) || "");
  if (kind === "mcp") return String((it && it.serverName) || "");
  return dshPluginKey(it);
}

function extIsOn(kind, it) {
  return !(it && it.disabled);
}

function extHay(kind, it) {
  let parts;
  if (kind === "skill") parts = [it.name, it.title, it.description];
  else if (kind === "mcp")
    parts = [it.serverName, it.transport, it.command, it.url, it.args];
  else parts = [it.name, it.id, it.title, it.description, it.purpose];
  return parts.filter(Boolean).join("\n").toLowerCase();
}

function extFilter(kind) {
  const st = extState(kind);
  const q = String(st.query || "").trim().toLowerCase();
  const list = extItems(kind);
  return q ? list.filter((it) => extHay(kind, it).includes(q)) : list.slice();
}

function extCount(kind) {
  return extItems(kind).length;
}

function extSelected(kind) {
  const st = extState(kind);
  const list = extFilter(kind);
  if (!list.length) return null;
  const sel =
    list.find((it) => extKeyOf(kind, it) === st.selectedKey) || list[0];
  st.selectedKey = extKeyOf(kind, sel);
  return sel;
}

/* ── 设置里的汇总提示 ── */

function extHintText() {
  const p = EXT_UI.state.dsh.list.length;
  const m = EXT_UI.state.dsh.list.filter((x) => !x.disabled).length;
  const zh = !(I18n && I18n.getLocale && I18n.getLocale() === "en");
  const bits = [
    I18n.t("DSH 插件 ") +
      p +
      (zh ? "（已挂载 " : " (mounted ") +
      m +
      (zh ? "）" : ")"),
    I18n.t("技能 ") + extCount("skill"),
    I18n.t("MCP ") + extCount("mcp"),
    I18n.t("MCP 服务端 ") + (EXT_UI.state.server.info && EXT_UI.state.server.info.running ? (zh ? "已启用" : "on") : zh ? "已关闭" : "off"),
  ];
  const errs = EXT_KINDS.filter((k) => EXT_UI.errors[k.key]).map(
    (k) => k.tab,
  );
  let s = bits.join(" · ");
  if (errs.length)
    s +=
      (zh ? I18n.t("（部分列表不可用：") : " (some lists unavailable: ") +
      errs.join(" / ") +
      (zh ? "）" : ")");
  return s;
}

function paintExtHint() {
  const hint = EXT_UI.hintEl;
  if (!hint) return;
  if (!EXT_UI.loaded.dsh && !EXT_UI.loaded.skill && !EXT_UI.loaded.mcp && !EXT_UI.loaded.server) {
    hint.textContent = I18n.t("（读取中…）");
    return;
  }
  hint.textContent = extHintText();
}

function dshPluginHasCjk(s) {
  return /[\u4e00-\u9fff]/.test(String(s || ""));
}

function dshPluginKey(p) {
  return String((p && p.id) || "") + "\n" + String((p && p.name) || "");
}

function dshPluginShortName(pkg) {
  const seg = String(pkg || "").split("/").pop();
  return seg.startsWith("dsh-") ? seg.slice(4) : seg;
}

function dshPluginLabel(p) {
  if (!p) return "";
  return dshPluginShortName(
    p.id && !String(p.id).startsWith("user-plugin") ? p.id : p.name,
  );
}

function dshPluginCopyFor(p) {
  const map =
    typeof window.DSH_PLUGIN_COPY === "object" && window.DSH_PLUGIN_COPY
      ? window.DSH_PLUGIN_COPY
      : {};
  return (p && (map[p.id] || map[p.name])) || null;
}

function enrichDshPluginCopy(p) {
  if (!p) return p;
  const zh = !(I18n && I18n.getLocale && I18n.getLocale() === "en");
  const copy = dshPluginCopyFor(p);
  let title = p.title || dshPluginLabel(p);
  let description = String(p.description || "").trim();
  let purpose = String(p.purpose || "").trim();
  if (zh && copy) {
    if (copy.title && !dshPluginHasCjk(title)) title = copy.title;
    if (copy.description && (!description || !dshPluginHasCjk(description))) {
      description = copy.description;
    }
    if (copy.purpose && (!purpose || !dshPluginHasCjk(purpose))) {
      purpose = copy.purpose;
    }
  }
  if (!purpose) {
    const first = description.split(/[。.!?\n]/)[0].trim();
    if (!zh) {
      const base = first || ("Extends the agent runtime (" + (p.id || p.name || "") + ")");
      purpose = /[.!?]$/.test(base) ? base : base + ".";
    } else if (!first) {
      purpose = I18n.t("用于扩展 Agent 运行时能力（{id}）。", {
        id: p.id || p.name || "",
      });
    } else if (/^用于/.test(first)) {
      purpose = /[。！？]$/.test(first) ? first : first + "。";
    } else {
      purpose = "用于" + first + (/[。！？]$/.test(first) ? "" : "。");
    }
  }
  return Object.assign({}, p, { title, description, purpose });
}

function ensureExtManagerDlg() {
  const old = document.getElementById("dshPluginsDlg");
  if (old) old.remove();
  let host = document.getElementById("extManagerDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "extManagerDlg";
  host.className = "mt-dialog dsh-plugins-dlg ext-manager-dlg";
  host.tabIndex = -1;
  host.innerHTML =
    '<div class="mt-dialog-box dsh-plugins-box ext-manager-box" role="dialog" aria-modal="true">' +
    '<div class="dsh-plugins-head">' +
    '<b id="extManagerTitle"></b>' +
    '<div class="dsh-ext-tabs" id="extManagerTabs"></div>' +
    '<input id="extManagerSearch" class="dsh-plugin-search" type="text">' +
    '<button type="button" class="mini node-guide-x" id="extManagerClose">✕</button>' +
    "</div>" +
    '<div class="dsh-ext-toolbar" id="extManagerToolbar"></div>' +
    '<div class="dsh-plugins-main">' +
    '<div class="dsh-plugins-grid" id="dshPluginsGrid"></div>' +
    '<div class="dsh-plugins-grid" id="dshSkillsGrid" style="display:none"></div>' +
    '<div class="dsh-plugins-grid" id="dshMcpGrid" style="display:none"></div>' +
    '<div class="dsh-plugins-grid" id="dshMcpServerGrid" style="display:none"></div>' +
    '<div class="dsh-plugins-info" id="extManagerInfo"></div>' +
    "</div></div>";
  document.body.appendChild(host);
  host.querySelector("#extManagerClose").onclick = () => closeExtManagerDialog();
  /* persistent：扩展能力管理里有搜索框与编辑中的表单，点蒙层不关窗，只走 ✕ / Esc */
  host.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const mt = document.getElementById("mtDialog");
    if (mt && mt.classList.contains("on")) return;
    ev.preventDefault();
    if (extState(EXT_UI.kind).editor) {
      paintExtManager();
      return;
    }
    closeExtManagerDialog();
  });
  host.querySelector("#extManagerSearch").addEventListener("input", (ev) => {
    extState(EXT_UI.kind).query = ev.target.value || "";
    paintExtManager();
  });
  return host;
}

function closeExtManagerDialog() {
  const host = document.getElementById("extManagerDlg");
  if (host) host.classList.remove("on");
  EXT_UI.open = false;
}

function paintExtTabs(host) {
  const tabs = host.querySelector("#extManagerTabs");
  if (!tabs) return;
  tabs.innerHTML = "";
  for (const k of EXT_KINDS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dsh-ext-tab" + (EXT_UI.kind === k.key ? " on" : "");
    b.textContent = I18n.t(k.tab) + " " + extCount(k.key);
    b.title = I18n.t(k.zh);
    b.onclick = () => {
      if (EXT_UI.kind === k.key) return;
      EXT_UI.kind = k.key;
      paintExtManager();
    };
    tabs.appendChild(b);
  }
}

function extInstallSubmit(host) {
  const inp = host.querySelector("#extManagerInstall");
  if (!inp) return;
  const pkg = String(inp.value || "").trim();
  if (!pkg) return;
  inp.value = "";
  extAddPlugin(pkg);
}

function paintExtToolbar(host) {
  const bar = host.querySelector("#extManagerToolbar");
  if (!bar) return;
  const kind = EXT_UI.kind;
  const meta = EXT_KIND[kind];
  bar.innerHTML = "";
  /* MCP 服务端这一页没有清单：工具栏只留一句说明（开关与令牌都在右侧面板里）。 */
  if (meta.toolbarNone) {
    const tip = document.createElement("span");
    tip.className = "dsh-ext-count";
    tip.textContent = I18n.t(
      "MTNode 作为 MCP 服务端：第三方客户端（Claude Code / Cursor / 自研 Agent）连进来操作本机 MTNode。开关、地址与令牌在右侧面板。",
    );
    bar.appendChild(tip);
    return;
  }
  if (meta.install) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.id = "extManagerInstall";
    inp.className = "dsh-plugin-search dsh-ext-install";
    inp.placeholder = I18n.t("npm 包名或 GitHub 地址，例如 @scope/pkg");
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        extInstallSubmit(host);
      }
    });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini primary";
    btn.textContent = I18n.t("＋ 安装插件");
    btn.onclick = () => extInstallSubmit(host);
    bar.appendChild(inp);
    bar.appendChild(btn);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini primary";
    btn.textContent = I18n.t(meta.newLabel);
    btn.onclick = () => {
      const st = extState(kind);
      st.editor = { mode: "new", data: null };
      st.selectedKey = "";
      paintExtManager();
    };
    bar.appendChild(btn);
  }
  const spacer = document.createElement("span");
  spacer.className = "dsh-ext-spacer";
  bar.appendChild(spacer);
  const store = document.createElement("button");
  store.type = "button";
  store.className = "mini";
  store.textContent = I18n.t("🌐 在线浏览");
  store.title = I18n.t("在线浏览:线上目录(插件 / 技能 / MCP),可安装与卸载");
  store.onclick = () => {
    closeExtManagerDialog();
    if (typeof openStoreDialog === "function") openStoreDialog();
  };
  bar.appendChild(store);
  const cnt = document.createElement("span");
  cnt.className = "dsh-ext-count";
  cnt.textContent = extCount(kind) + I18n.t(" 项");
  bar.appendChild(cnt);
}

function extFieldRow(labelText, el) {
  const lab = document.createElement("div");
  lab.className = "dsh-plugin-info-label";
  lab.textContent = labelText;
  const wrap = document.createElement("div");
  wrap.className = "dsh-ext-field";
  wrap.appendChild(lab);
  wrap.appendChild(el);
  return wrap;
}

function extTextInput(ph, value) {
  const el = document.createElement("input");
  el.type = "text";
  el.placeholder = ph;
  el.value = value || "";
  return el;
}

function extTextArea(ph, value, rows) {
  const el = document.createElement("textarea");
  el.rows = rows || 4;
  el.placeholder = ph;
  el.value = value || "";
  return el;
}

function extSelect(options, value) {
  const el = document.createElement("select");
  for (const [v, l] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(l);
    el.appendChild(o);
  }
  el.value = value;
  return el;
}

function extErrorText(e) {
  return String((e && e.message) || e || "");
}

async function extAddPlugin(pkg) {
  const host = document.getElementById("extManagerDlg");
  const cnt = host && host.querySelector(".dsh-ext-count");
  if (cnt) cnt.textContent = I18n.t("安装中（需要联网，可能需要几分钟）…");
  try {
    const rr = await window.api.dshPluginAdd(pkg);
    if (rr && rr.ok === false) throw new Error(rr.error);
    toast((rr && rr.message) || I18n.t("DSH 插件已安装：") + pkg, "ok");
  } catch (e) {
    toast(I18n.t("安装失败：") + extErrorText(e), "err");
  }
  await refreshExtInventory({ quiet: true });
  paintExtManager();
}

function renderExtManagerInfo(host) {
  const info = host.querySelector("#extManagerInfo");
  if (!info) return;
  info.innerHTML = "";
  const kind = EXT_UI.kind;
  /* MCP 服务端是单例状态页，不走「清单 + 选中」那套（见 paintMcpServerPanel）。 */
  if (kind === "server") {
    paintMcpServerPanel(info);
    return;
  }
  const st = extState(kind);
  if (st.editor) {
    buildExtEditor(info, kind, st);
    return;
  }
  const it = extSelected(kind);
  if (!it) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent =
      EXT_UI.errors[kind] || I18n.t("选择左侧条目查看说明与管理操作");
    info.appendChild(em);
    return;
  }
  if (kind === "dsh") renderDshPluginInfo(it, info);
  else if (kind === "skill") renderExtSkillInfo(it, info);
  else renderExtMcpInfo(it, info);
}

function extInfoHead(info, titleText, tags, fullname) {
  const head = document.createElement("div");
  head.className = "dsh-plugin-info-head";
  const title = document.createElement("div");
  title.className = "dsh-plugin-info-title";
  title.textContent = titleText;
  head.appendChild(title);
  const tw = document.createElement("div");
  tw.className = "dsh-plugin-info-tags";
  for (const [cls, text] of tags || []) {
    const t = document.createElement("span");
    t.className = "dsh-plugin-tag " + cls;
    t.textContent = text;
    tw.appendChild(t);
  }
  head.appendChild(tw);
  info.appendChild(head);
  if (fullname) {
    const full = document.createElement("div");
    full.className = "dsh-plugin-full";
    full.textContent = fullname;
    info.appendChild(full);
  }
}

function extInfoField(info, label, text) {
  if (!text) return;
  const lab = document.createElement("div");
  lab.className = "dsh-plugin-info-label";
  lab.textContent = label;
  info.appendChild(lab);
  const body = document.createElement("div");
  body.className = "dsh-plugin-info-text";
  body.textContent = text;
  info.appendChild(body);
}

function extInfoButtons(info, actions) {
  if (!actions || !actions.length) return;
  const btns = document.createElement("div");
  btns.className = "dsh-plugin-btns";
  for (const [label, cls, fn] of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini " + (cls || "");
    b.textContent = I18n.t(label);
    b.onclick = async (ev) => {
      ev.stopPropagation();
      await fn();
    };
    btns.appendChild(b);
  }
  info.appendChild(btns);
}

function extInfoDetails(info, label, text, cls) {
  const det = document.createElement("details");
  det.className = cls || "dsh-plugin-yaml";
  const sum = document.createElement("summary");
  sum.textContent = label;
  det.appendChild(sum);
  const pre = document.createElement("pre");
  pre.className = "dsh-plugin-detail";
  pre.textContent = text;
  det.appendChild(pre);
  info.appendChild(det);
}

/* 右侧详情：DSH 插件（沿用原样式与操作） */
function renderDshPluginInfo(p, info) {
  extInfoHead(
    info,
    p.title || dshPluginLabel(p),
    [
      [p.core ? "builtin" : p.disabled ? "off" : "on", p.core ? I18n.t("核心") : p.disabled ? I18n.t("未挂载") : I18n.t("已挂载")],
      [
        p.source === "config" ? "on" : "builtin",
        p.source === "config" ? I18n.t("配置目录") : I18n.t("应用内置"),
      ],
    ],
    p.name,
  );
  if (p.version) {
    const ver = document.createElement("div");
    ver.className = "dsh-plugin-info-ver";
    ver.textContent = "v" + p.version;
    info.appendChild(ver);
  }
  extInfoField(info, I18n.t("描述"), p.description);
  extInfoField(info, I18n.t("用途"), p.purpose);
  if (!p.description && !p.purpose) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = I18n.t("暂无描述");
    info.appendChild(em);
  }
  const actions = [];
  if (p.toggleable) {
    actions.push([p.disabled ? "挂载" : "取消挂载", "", async () => {
      try {
        const rr = await window.api.dshPluginSetEnabled(
          p.name,
          !!p.disabled,
          p.id,
        );
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(
          (p.disabled ? I18n.t("已挂载 ") : I18n.t("已取消挂载 ")) + p.name,
          "ok",
        );
      } catch (e) {
        toast(I18n.t("操作失败：") + extErrorText(e), "err");
      }
      await refreshExtInventory({ kinds: ["dsh"], quiet: true });
      paintExtManager();
    }]);
  }
  if (p.removable) {
    actions.push(["移除", "danger", async () => {
      if (
        !(await confirmDialog(
          I18n.t("移除 DSH 插件 ") + p.name + I18n.t("？引擎将自动重启。"),
          { title: I18n.t("移除插件"), danger: true, okText: I18n.t("移除") },
        ))
      )
        return;
      try {
        const rr = await window.api.dshPluginRemove(p.name);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(I18n.t("已移除 ") + p.name, "ok");
      } catch (e) {
        toast(I18n.t("移除失败：") + extErrorText(e), "err");
      }
      await refreshExtInventory({ kinds: ["dsh"], quiet: true });
      paintExtManager();
    }]);
  }
  extInfoButtons(info, actions);
  if (p.detail) extInfoDetails(info, I18n.t("配置片段"), p.detail);
}

/* 技能正文一律走内置 Markdown 阅读 / 编辑器（app.js 的 openMdViewer 虚拟文档模式）：
   不落临时文件，opts.onSave 收正文、opts.readOnly 只读（内置技能）。 */
async function openSkillMarkdownViewer(s, opts) {
  opts = opts || {};
  if (!s || !window.api || !window.api.skillGet) return false;
  let body = typeof s._body === "string" ? s._body : "";
  if (!body) {
    try {
      const g = await window.api.skillGet(s.name);
      if (!g || !g.ok) throw new Error((g && g.error) || I18n.t("未知错误"));
      body = g.body || "";
      s._body = body;
    } catch (e) {
      toast(I18n.t("加载失败：") + extErrorText(e), "err");
      return false;
    }
  }
  if (typeof openMdViewer !== "function") {
    toast(I18n.t("内置 Markdown 编辑器不可用"), "warn");
    return false;
  }
  const readOnly = opts.readOnly != null ? !!opts.readOnly : !!s.builtin;
  openMdViewer("", {
    content: body,
    title: (s.title || s.name) + " · SKILL.md",
    subtitle:
      s.name + " · SKILL.md" + (readOnly ? I18n.t(" · 只读") : ""),
    edit: !readOnly && opts.edit === true,
    readOnly: readOnly,
    onSave: opts.onSave,
  });
  return true;
}

/* 右侧详情：技能 */
function renderExtSkillInfo(s, info) {
  extInfoHead(
    info,
    s.title || s.name,
    [
      [s.builtin ? "builtin" : "on", s.builtin ? I18n.t("内置") : I18n.t("本机")],
      [
        s.storeId ? "on" : "builtin",
        s.storeId ? I18n.t("来自工坊") : I18n.t("本地创建"),
      ],
    ],
    s.name,
  );
  if (s.version) {
    const ver = document.createElement("div");
    ver.className = "dsh-plugin-info-ver";
    ver.textContent = "v" + s.version;
    info.appendChild(ver);
  }
  extInfoField(info, I18n.t("描述"), s.description);
  const body = s._body || "";
  if (body) {
    extInfoDetails(
      info,
      I18n.t("技能内容 SKILL.md") + "（" + body.length + "）",
      body,
      "dsh-plugin-yaml dsh-skill-body",
    );
  } else if (s._bodyLoading) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = I18n.t("（读取中…）");
    info.appendChild(em);
  }
  if (Array.isArray(s.files) && s.files.length) {
    extInfoField(
      info,
      I18n.t("附带文件"),
      s.files.map((f) => f.path + " (" + f.bytes + "B)").join("\n"),
    );
  }
  const actions = [];
  actions.push([s.builtin ? "阅读" : "编辑", "", async () => {
    if (s.builtin) {
      /* 内置技能只读：正文用内置 Markdown 阅读器打开（不落到下方 `<pre>` 里看原文） */
      toast(I18n.t("内置技能只读，不可修改"), "warn");
      await openSkillMarkdownViewer(s, { readOnly: true });
      return;
    }
    try {
      const g = await window.api.skillGet(s.name);
      if (!g || !g.ok) throw new Error((g && g.error) || I18n.t("未知错误"));
      s._body = g.body || "";
      s.files = g.files || [];
      extState("skill").editor = { mode: "edit", data: s };
      paintExtManager();
    } catch (e) {
      toast(I18n.t("加载失败：") + extErrorText(e), "err");
    }
  }]);
  if (!s.builtin) {
    actions.push(["移除", "danger", async () => {
      if (
        !(await confirmDialog(I18n.t("移除技能 ") + s.name + I18n.t("？"), {
          title: I18n.t("移除技能"),
          danger: true,
          okText: I18n.t("移除"),
        }))
      )
        return;
      try {
        const rr = await window.api.skillRemove(s.name);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(I18n.t("已移除技能 ") + s.name, "ok");
      } catch (e) {
        toast(I18n.t("移除失败：") + extErrorText(e), "err");
      }
      extState("skill").selectedKey = "";
      await refreshExtInventory({ kinds: ["skill"], quiet: true });
      paintExtManager();
    }]);
  }
  extInfoButtons(info, actions);
}

/* 右侧详情：MCP 服务器 */
function renderExtMcpInfo(s, info) {
  extInfoHead(
    info,
    s.serverName,
    [
      [s.disabled ? "off" : "on", s.disabled ? I18n.t("已停用") : I18n.t("已启用")],
      ["builtin", s.transport === "stdio" ? "stdio" : "streamable-http"],
    ],
    s.transport === "stdio" ? s.command : s.url,
  );
  extInfoField(
    info,
    I18n.t("命令 / 参数"),
    s.transport === "stdio" ? (s.command || "") + " " + (s.args || "") : "",
  );
  extInfoField(info, "URL", s.transport === "stdio" ? "" : s.url);
  extInfoDetails(
    info,
    I18n.t("配置片段"),
    [
      "serverName: " + s.serverName,
      "transport: " + s.transport,
      s.transport === "stdio"
        ? "command: " + (s.command || "") + "\nargs: " + (s.args || "")
        : "url: " + (s.url || ""),
      "disabled: " + (s.disabled ? "true" : "false"),
    ].join("\n"),
  );
  /* 资源清单（只读）：点一下才去连，避免每次选中服务器都冷起一个 MCP 进程。
     用的是 dsh 0.2 base 组合里已经启用的 @deepseek-ai/dsh-mcp-resources 同款能力，
     但走宿主自己的只读通道（网关 mcp-resources.mjs）—— 那边是给模型的工具面，不对外查询。 */
  extMcpResourcesPanel(info, s);
  extInfoButtons(info, [
    [s.disabled ? "启用" : "停用", "", async () => {
      try {
        const rr = await window.api.dshMcpSetEnabled(s.serverName, !!s.disabled);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(
          (s.disabled ? I18n.t("已启用 ") : I18n.t("已停用 ")) + s.serverName,
          "ok",
        );
      } catch (e) {
        toast(I18n.t("操作失败：") + extErrorText(e), "err");
      }
      await refreshExtInventory({ kinds: ["mcp"], quiet: true });
      paintExtManager();
    }],
    ["移除", "danger", async () => {
      if (
        !(await confirmDialog(
          I18n.t("移除 MCP 服务器 ") + s.serverName + I18n.t("？引擎将自动重启。"),
          { title: I18n.t("移除 MCP"), danger: true, okText: I18n.t("移除") },
        ))
      )
        return;
      try {
        const rr = await window.api.dshMcpRemove(s.serverName);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(I18n.t("已移除 ") + s.serverName, "ok");
      } catch (e) {
        toast(I18n.t("移除失败：") + extErrorText(e), "err");
      }
      extState("mcp").selectedKey = "";
      await refreshExtInventory({ kinds: ["mcp"], quiet: true });
      paintExtManager();
    }],
  ]);
}

/* ── MCP 资源面板（只读）─────────────────────────────────────────────────────
   做的一件事：让用户看见「这台 MCP 服务器有哪些资源」。dsh 0.2 的
   @deepseek-ai/dsh-mcp-resources 已经把资源读取做成了**给模型的工具**（Agent 在任务里
   自己会用），但它没有对外的查询接口 —— 所以宿主这一层用同一个官方 SDK 在网关进程里
   只读地连一次（见 dsh/gateway/mcp-resources.mjs），把清单显示出来，并把 URI 抄进剪贴板
   方便用户粘进对话当上下文。
   三条纪律：
     · 只读：只发 resources/list 与 resources/read，绝不调用服务器工具；
     · 惰性：选中服务器不连，点「读取资源清单」才连（stdio 服务器 = 临时起一个进程）；
     · 失败说话：错误原样显示在面板里（含「找不到命令」这类可自查的提示），不静默。 */
function extMcpResourcesPanel(info, s) {
  const wrap = document.createElement("div");
  wrap.className = "dsh-mcp-res";
  const bar = document.createElement("div");
  bar.className = "dsh-mcp-res-bar";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mini";
  btn.textContent = I18n.t("读取资源清单");
  btn.title = I18n.t(
    "只读：向这台服务器发 resources/list 与 resources/read，不会调用它的任何工具。stdio 服务器会临时起一个进程。",
  );
  const status = document.createElement("span");
  status.className = "dsh-mcp-res-status";
  bar.appendChild(btn);
  bar.appendChild(status);
  wrap.appendChild(bar);
  const list = document.createElement("div");
  list.className = "dsh-mcp-res-list";
  wrap.appendChild(list);
  info.appendChild(wrap);

  const setStatus = (text, cls) => {
    status.textContent = text || "";
    status.className = "dsh-mcp-res-status" + (cls ? " " + cls : "");
  };

  const serversOf = () => (EXT_UI.state.mcp.list || []).map((x) => ({
    serverName: x.serverName,
    transport: x.transport,
    command: x.command,
    args: x.args,
    url: x.url,
    disabled: !!x.disabled,
  }));

  const renderRows = (resources, templates) => {
    list.innerHTML = "";
    for (const r of resources || []) {
      const row = document.createElement("div");
      row.className = "dsh-mcp-res-row";
      const name = document.createElement("div");
      name.className = "dsh-mcp-res-name";
      name.textContent = r.title || r.name || r.uri;
      const uri = document.createElement("div");
      uri.className = "dsh-mcp-res-uri";
      uri.textContent = r.uri + (r.mimeType ? " · " + r.mimeType : "");
      if (r.description) uri.title = r.description;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "mini";
      open.textContent = I18n.t("查看");
      const body = document.createElement("pre");
      body.className = "dsh-mcp-res-body";
      body.hidden = true;
      open.onclick = async () => {
        if (!body.hidden) {
          body.hidden = true;
          open.textContent = I18n.t("查看");
          return;
        }
        open.textContent = I18n.t("读取中…");
        open.disabled = true;
        try {
          const rr = await window.api.dshMcpResources({
            action: "read",
            serverName: s.serverName,
            uri: r.uri,
            servers: serversOf(),
          });
          if (!rr || rr.ok === false) throw new Error((rr && rr.error) || I18n.t("读取失败"));
          const parts = (rr.contents || []).map((c) =>
            typeof c.text === "string"
              ? c.text
              : I18n.t("（二进制内容，") + (c.blobBytes || 0) + I18n.t(" 字节，不在界面里展开）"),
          );
          body.textContent = parts.join("\n\n").slice(0, 20000);
          body.hidden = false;
          open.textContent = I18n.t("收起");
        } catch (e) {
          body.textContent = I18n.t("读取失败：") + extErrorText(e);
          body.hidden = false;
          open.textContent = I18n.t("收起");
        } finally {
          open.disabled = false;
        }
      };
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "mini";
      copy.textContent = I18n.t("复制 URI");
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(r.uri);
          toast(I18n.t("已复制资源 URI"), "ok");
        } catch (e) {
          toast(I18n.t("复制失败：") + extErrorText(e), "err");
        }
      };
      const acts = document.createElement("div");
      acts.className = "dsh-mcp-res-acts";
      acts.appendChild(open);
      acts.appendChild(copy);
      row.appendChild(name);
      row.appendChild(uri);
      row.appendChild(acts);
      row.appendChild(body);
      list.appendChild(row);
    }
    for (const t of templates || []) {
      const row = document.createElement("div");
      row.className = "dsh-mcp-res-row dsh-mcp-res-tpl";
      const name = document.createElement("div");
      name.className = "dsh-mcp-res-name";
      name.textContent = I18n.t("模板：") + (t.title || t.name || t.uriTemplate);
      const uri = document.createElement("div");
      uri.className = "dsh-mcp-res-uri";
      uri.textContent = t.uriTemplate;
      row.appendChild(name);
      row.appendChild(uri);
      list.appendChild(row);
    }
    if (!list.childElementCount) {
      const em = document.createElement("div");
      em.className = "dsh-mcp-res-empty";
      em.textContent = I18n.t("这台服务器没有暴露资源（没有资源能力，或清单为空）");
      list.appendChild(em);
    }
  };

  btn.onclick = async (ev) => {
    ev.stopPropagation();
    btn.disabled = true;
    setStatus(I18n.t("正在连接服务器…"));
    try {
      const rr = await window.api.dshMcpResources({
        action: "list",
        serverName: s.serverName,
        servers: serversOf(),
      });
      if (!rr || rr.ok === false) throw new Error((rr && rr.error) || I18n.t("读取失败"));
      const n = (rr.resources || []).length;
      const t = (rr.templates || []).length;
      setStatus(I18n.t("资源 ") + n + I18n.t(" 条") + (t ? I18n.t(" · 模板 ") + t + I18n.t(" 条") : ""), "ok");
      renderRows(rr.resources, rr.templates);
    } catch (e) {
      setStatus(I18n.t("读取失败：") + extErrorText(e), "err");
      list.innerHTML = "";
    } finally {
      btn.disabled = false;
    }
  };
}

/* 新建 / 编辑表单（技能、MCP），同样开在右侧详情区，保持一个样式 */
function buildExtEditor(info, kind, st) {
  const ed = st.editor;
  const cur = ed.mode === "edit" ? ed.data : null;
  const title = document.createElement("div");
  title.className = "dsh-plugin-info-title";
  title.textContent = I18n.t(
    kind === "skill"
      ? cur
        ? "编辑技能"
        : "创建技能"
      : cur
        ? "MCP 服务器"
        : "添加 MCP 服务器",
  );
  info.appendChild(title);
  const form = document.createElement("div");
  form.className = "dsh-skill-form";
  info.appendChild(form);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "mini primary";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = () => {
    st.editor = null;
    paintExtManager();
  };

  if (kind === "skill") {
    const nm = extTextInput(
      I18n.t("技能名（kebab-case，如 pdf-summary）"),
      cur ? cur.name : "",
    );
    if (cur) nm.disabled = true;
    const desc = extTextInput(
      I18n.t("一句话描述（模型据此判断何时使用）"),
      cur ? cur.description || "" : "",
    );
    /* 技能正文不再用裸 textarea：表单里只给「内置 Markdown 编辑器」入口 + 渲染预览，
       正文草稿留在 bodyText，编辑器保存 / 关窗时回填（见 app.js openMdViewer 虚拟文档模式）。 */
    let bodyText = cur ? cur._body || "" : "";
    const mdWrap = document.createElement("div");
    mdWrap.className = "dsh-skill-md";
    const mdBtn = document.createElement("button");
    mdBtn.type = "button";
    mdBtn.className = "mini";
    mdBtn.textContent = I18n.t("✎ 用内置 Markdown 编辑器");
    const mdHint = document.createElement("div");
    mdHint.className = "dsh-skill-md-hint";
    const mdPrev = document.createElement("div");
    mdPrev.className = "dsh-skill-md-prev md";
    mdPrev.title = I18n.t("点击用内置 Markdown 编辑器打开");
    const paintSkillBody = () => {
      const t = String(bodyText || "");
      const has = !!t.trim();
      mdPrev.innerHTML = has ? renderMarkdown(t) : "";
      mdPrev.classList.toggle("empty", !has);
      mdHint.textContent = has
        ? I18n.t("已写 {n} 字符 · 点击用内置 Markdown 编辑器查看 / 修改", {
            n: t.length,
          })
        : I18n.t("还没有正文 · 点击用内置 Markdown 编辑器编写");
    };
    const openSkillBodyEditor = () => {
      if (typeof openMdViewer !== "function") {
        toast(I18n.t("内置 Markdown 编辑器不可用"), "warn");
        return;
      }
      openMdViewer("", {
        content: String(bodyText || ""),
        title:
          (cur ? cur.name : nm.value.trim() || I18n.t("新技能")) + " · SKILL.md",
        subtitle: I18n.t("技能正文 SKILL.md · 内置 Markdown 编辑器"),
        edit: true,
        onSave: (text) => {
          bodyText = String(text == null ? "" : text);
          paintSkillBody();
        },
      });
    };
    mdBtn.onclick = openSkillBodyEditor;
    mdPrev.onclick = openSkillBodyEditor;
    mdWrap.appendChild(mdBtn);
    mdWrap.appendChild(mdHint);
    mdWrap.appendChild(mdPrev);
    paintSkillBody();
    form.appendChild(extFieldRow(I18n.t("技能名"), nm));
    form.appendChild(extFieldRow(I18n.t("描述"), desc));
    form.appendChild(extFieldRow(I18n.t("内容"), mdWrap));
    save.textContent = I18n.t(cur ? "保存本机修改" : "创建技能");
    save.onclick = async () => {
      try {
        const rr = await window.api.skillAdd({
          name: (cur ? cur.name : nm.value).trim().toLowerCase(),
          description: desc.value.trim(),
          body: bodyText,
          overwrite: !!cur,
          files: cur && Array.isArray(cur.files) ? cur.files : undefined,
        });
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(
          cur ? I18n.t("本机技能已保存（未自动同步工坊）") : I18n.t("技能已创建，智能节点可立即使用"),
          "ok",
        );
        st.editor = null;
        st.selectedKey = (cur ? cur.name : nm.value).trim().toLowerCase();
      } catch (e) {
        toast(I18n.t("保存失败：") + extErrorText(e), "err");
        return;
      }
      await refreshExtInventory({ kinds: ["skill"], quiet: true });
      paintExtManager();
    };
  } else {
    const nm = extTextInput(
      I18n.t("服务器名（1-32 位字母/数字/_/-）"),
      cur ? cur.serverName : "",
    );
    const tr = extSelect(
      [
        ["stdio", "stdio（本地命令）"],
        ["streamable-http", "streamable-http（远程 URL）"],
      ],
      (cur && cur.transport) || "stdio",
    );
    const cmd = extTextInput(
      I18n.t("命令（如 npx.cmd 或 node 完整路径）"),
      cur ? cur.command || "" : "",
    );
    const args = extTextInput(
      I18n.t("参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem）"),
      cur ? cur.args || "" : "",
    );
    const url = extTextInput("http(s)://host/mcp", cur ? cur.url || "" : "");
    const syncTransport = () => {
      const http = tr.value !== "stdio";
      cmd.style.display = http ? "none" : "";
      args.style.display = http ? "none" : "";
      url.style.display = http ? "" : "none";
    };
    tr.addEventListener("change", syncTransport);
    form.appendChild(extFieldRow(I18n.t("服务器名"), nm));
    form.appendChild(extFieldRow(I18n.t("传输方式"), tr));
    form.appendChild(extFieldRow(I18n.t("命令"), cmd));
    form.appendChild(extFieldRow(I18n.t("参数"), args));
    form.appendChild(extFieldRow("URL", url));
    syncTransport();
    save.textContent = I18n.t("添加服务器");
    save.onclick = async () => {
      try {
        const rr = await window.api.dshMcpAdd({
          serverName: nm.value.trim(),
          transport: tr.value,
          command: cmd.value.trim(),
          args: args.value.trim(),
          url: url.value.trim(),
        });
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(I18n.t("MCP 服务器已添加，引擎重启后生效"), "ok");
        st.editor = null;
        st.selectedKey = nm.value.trim();
      } catch (e) {
        toast(I18n.t("添加失败：") + extErrorText(e), "err");
        return;
      }
      await refreshExtInventory({ kinds: ["mcp"], quiet: true });
      paintExtManager();
    };
  }
  const btns = document.createElement("div");
  btns.className = "dsh-plugin-btns";
  btns.appendChild(save);
  btns.appendChild(cancel);
  info.appendChild(btns);
}

function extCardText(kind, it) {
  if (kind === "skill") return (it && (it.title || it.name)) || "";
  if (kind === "mcp") return (it && it.serverName) || "";
  return (it && (it.title || dshPluginLabel(it))) || "";
}

function extCardTag(kind, it) {
  if (kind === "skill")
    return it.builtin
      ? [I18n.t("内置"), "builtin"]
      : [I18n.t("本机"), "on"];
  if (kind === "mcp")
    return it.disabled
      ? [I18n.t("已停用"), "off"]
      : [I18n.t("已启用"), "on"];
  return it.core
    ? [I18n.t("核心"), "builtin"]
    : it.disabled
      ? [I18n.t("未挂载"), "off"]
      : [I18n.t("已挂载"), "on"];
}

function renderExtGrid(host, kind) {
  const grid = host.querySelector("#" + EXT_KIND[kind].grid);
  if (!grid) return;
  grid.innerHTML = "";
  const st = extState(kind);
  const list = extFilter(kind);
  if (!list.length) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = st.query
      ? I18n.t("无匹配 ") + EXT_KIND[kind].tab
      : EXT_UI.loaded[kind]
        ? EXT_UI.errors[kind] || I18n.t(EXT_KIND[kind].empty)
        : I18n.t("（读取中…）");
    grid.appendChild(em);
    return;
  }
  extSelected(kind);
  for (const it of list) {
    const on = extKeyOf(kind, it) === st.selectedKey;
    const card = document.createElement("div");
    card.className =
      "dsh-plugin-card" + (extIsOn(kind, it) ? "" : " off") + (on ? " sel" : "");
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    const row = document.createElement("div");
    row.className = "dsh-plugin-card-row";
    const dot = document.createElement("span");
    dot.className = "dsh-plugin-dot" + (extIsOn(kind, it) ? " on" : "");
    dot.title = extIsOn(kind, it) ? I18n.t("已启用") : I18n.t("未启用");
    const nm = document.createElement("span");
    nm.className = "dsh-plugin-name";
    nm.textContent = extCardText(kind, it);
    nm.title =
      kind === "skill"
        ? it.description || it.name
        : kind === "mcp"
          ? it.command || it.url || it.serverName
          : it.name;
    const [tagText, tagCls] = extCardTag(kind, it);
    const tag = document.createElement("span");
    tag.className = "dsh-plugin-tag " + tagCls;
    tag.textContent = tagText;
    row.appendChild(dot);
    row.appendChild(nm);
    row.appendChild(tag);
    if (kind === "dsh" && it.source === "config") {
      const loc = document.createElement("span");
      loc.className = "dsh-plugin-tag on";
      loc.textContent = I18n.t("配置目录");
      row.appendChild(loc);
    }
    card.appendChild(row);
    const pick = () => {
      st.selectedKey = extKeyOf(kind, it);
      st.editor = null;
      paintExtManager();
    };
    card.onclick = pick;
    card.onkeydown = (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        pick();
      }
    };
    grid.appendChild(card);
  }
}

function paintExtManager() {
  if (!EXT_UI.open) return;
  const host = ensureExtManagerDlg();
  paintExtTabs(host);
  paintExtToolbar(host);
  const search = host.querySelector("#extManagerSearch");
  if (search) {
    const ph = {
      dsh: I18n.t("筛选 DSH 插件（按包名 / 行 id / 描述）…"),
      skill: I18n.t("筛选技能（按技能名 / 描述）…"),
      mcp: I18n.t("筛选 MCP 服务器（按名称 / 命令 / URL）…"),
    }[EXT_UI.kind] || I18n.t("本页没有可筛选的清单");
    search.placeholder = ph;
    search.disabled = EXT_UI.kind === "server";
    if (search.value !== (extState(EXT_UI.kind).query || ""))
      search.value = extState(EXT_UI.kind).query || "";
  }
  for (const k of EXT_KINDS) {
    const grid = host.querySelector("#" + k.grid);
    if (grid) grid.style.display = EXT_UI.kind === k.key ? "" : "none";
  }
  renderExtGrid(host, EXT_UI.kind);
  renderExtManagerInfo(host);
}

/* 三类清单一把抓：任一分类失败不影响其余分类（引擎未连接时插件分类仍会重试） */
async function fetchExtPlugins(attempt) {
  attempt = attempt || 0;
  let r = null;
  try {
    r = await window.api.dshPluginList();
  } catch (e) {
    r = { ok: false, error: extErrorText(e) };
  }
  if (!r || r.ok === false || !Array.isArray(r.plugins)) {
    if (attempt < 2) {
      await new Promise((res) => setTimeout(res, 1500));
      return fetchExtPlugins(attempt + 1);
    }
    EXT_UI.state.dsh.list = [];
    EXT_UI.errors.dsh =
      I18n.t("DSH 插件列表不可用（") +
      ((r && r.error) || I18n.t("引擎未连接")) +
      I18n.t("）· 重新打开设置重试");
    return;
  }
  EXT_UI.state.dsh.list = r.plugins.map(enrichDshPluginCopy);
  EXT_UI.errors.dsh = "";
}

async function refreshExtInventory(opts) {
  opts = opts || {};
  const want = opts.kinds || ["dsh", "skill", "mcp", "server"];
  if (!want.length) return;
  const fetchers = {
    dsh: fetchExtPlugins,
    server: async () => {
      await fetchMcpServerState();
    },
    skill: async () => {
      try {
        const r = await window.api.skillList();
        if (r && r.ok === false) throw new Error(r.error);
        EXT_UI.state.skill.list = (r && r.skills) || [];
        EXT_UI.errors.skill = "";
      } catch (e) {
        EXT_UI.state.skill.list = [];
        EXT_UI.errors.skill =
          I18n.t("技能列表不可用（") + extErrorText(e) + I18n.t("）");
      }
    },
    mcp: async () => {
      try {
        const r = await window.api.dshMcpList();
        if (!r || r.ok === false || !Array.isArray(r.servers))
          throw new Error((r && r.error) || I18n.t("引擎未连接"));
        EXT_UI.state.mcp.list = r.servers;
        EXT_UI.errors.mcp = "";
      } catch (e) {
        EXT_UI.state.mcp.list = [];
        EXT_UI.errors.mcp =
          I18n.t("MCP 列表不可用（") + extErrorText(e) + I18n.t("）");
      }
    },
  };
  for (const k of want) {
    EXT_UI.loaded[k] = true;
    try {
      await fetchers[k]();
    } catch (e) {
      EXT_UI.errors[k] = extErrorText(e);
    }
  }
  paintExtHint();
  paintExtManager();
}

async function openExtManagerDialog(kind) {
  const host = ensureExtManagerDlg();
  EXT_UI.kind = EXT_KIND[kind] ? kind : "dsh";
  EXT_UI.state[EXT_UI.kind].query = "";
  EXT_UI.open = true;
  host.classList.add("on");
  try {
    host.focus();
  } catch (_) {}
  const t = document.getElementById("extManagerTitle");
  if (t) t.textContent = I18n.t("扩展能力管理");
  /* 每次点「管理」都重新拉一遍三类清单：引擎可能刚装完插件又重启过 */
  await refreshExtInventory();
  paintExtManager();
}

/* ── 「MCP 服务端」面板 ──────────────────────────────────────────────────────
   MTNode 自己作为 MCP 服务端（第三方客户端连进来操作本机 MTNode）。与上面「MCP 服务器」
   那一类方向相反，所以它不是一份清单，而是**一个服务端的状态页**：
     · 总开关（关 = 停止监听，端口不再存在）
     · 地址 / 令牌 / 客户端标识（都能一键复制；令牌可重置）
     · stdio 客户端配置片段（Claude Code / Cursor 那一行）
     · 自检（自己走一遍 initialize → tools/list → 真读一次画布）
     · 最近调用（审计，数据目录 mcp-audit/）与原始 JSON-RPC 抓包（需显式打开）
   契约与工具表由 guides/mcp-server.md 说明，真源是 dsh/gateway/*-plugin.mjs。 */
function mcpServerState() {
  return EXT_UI.state.server;
}

async function fetchMcpServerState(opts) {
  const st = mcpServerState();
  try {
    st.info = await window.api.mcpStatus();
    EXT_UI.errors.server = "";
  } catch (e) {
    st.info = null;
    EXT_UI.errors.server = I18n.t("MCP 服务端状态不可用（") + extErrorText(e) + I18n.t("）");
  }
  await mcpServerLoadLogs(opts);
}

async function mcpServerLoadLogs() {
  const st = mcpServerState();
  try {
    const a = await window.api.mcpAudit(60);
    st.audit = (a && a.entries) || [];
  } catch (_) {
    st.audit = [];
  }
  try {
    const c = await window.api.mcpCapture(120);
    st.capture = (c && c.entries) || [];
  } catch (_) {
    st.capture = [];
  }
}

function mcpCopy(text, label) {
  const write = (t) => {
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(t);
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    ta.remove();
    return Promise.resolve();
  };
  Promise.resolve(write(String(text || "")))
    .then(() => toast(I18n.t("已复制") + (label ? "：" + label : ""), "ok"))
    .catch(() => toast(I18n.t("复制失败"), "err"));
}

function mcpClientSnippet(info) {
  const cmd = (info && info.stdioCommand) || {};
  return JSON.stringify(
    {
      mcpServers: {
        mtnode: { command: cmd.node || "node", args: [cmd.script || "mcp-stdio.js"] },
      },
    },
    null,
    2,
  );
}

function paintMcpServerPanel(info) {
  const st = mcpServerState();
  const s = st.info || {};
  const run = !!s.running;
  extInfoHead(
    info,
    I18n.t("MCP 服务端"),
    [
      [run ? "on" : "off", run ? I18n.t("已监听") : I18n.t("已关闭")],
      ["builtin", "128.0.0.1 · token"],
      ["builtin", I18n.t("工具 ") + (s.tools || 0)],
    ],
    "mcp-server",
  );
  extInfoField(
    info,
    I18n.t("这是什么"),
    I18n.t(
      "让第三方 MCP 客户端（Claude Code / Cursor / 自研 Agent）连进来操作本机 MTNode：读改画布、查数据库与事实库、素材库与识图。调用与你自己的会话走同一条执行路径，全部记进审计日志。",
    ),
  );
  if (EXT_UI.errors.server) extInfoField(info, I18n.t("状态"), EXT_UI.errors.server);
  extInfoField(info, I18n.t("地址（HTTP）"), run ? s.url : I18n.t("未监听（总开关已关）"));
  extInfoField(info, I18n.t("令牌（Bearer）"), s.token || "");
  extInfoField(info, I18n.t("工具 / 资源 / 提示词"), (s.tools || 0) + " / " + (s.resources || 0) + " / " + (s.prompts || 0));
  if (run) {
    extInfoField(
      info,
      I18n.t("监听信息"),
      "127.0.0.1:" + s.port + " · " + I18n.t("已运行 ") + Math.max(1, Math.round((s.uptimeMs || 0) / 60000)) + I18n.t(" 分钟") +
        " · " + I18n.t("本会话调用 ") + (s.calls || 0) + I18n.t(" 次") + " · " + I18n.t("连接 ") + (s.sessions || 0),
    );
  }
  extInfoField(info, I18n.t("客户端标识"), s.clientId || I18n.t("（未设置，仅用于审计归类）"));
  extInfoField(info, I18n.t("审计目录"), s.auditDir || "");
  if (s.lastError) extInfoField(info, I18n.t("最近一次错误"), s.lastError);

  extInfoDetails(
    info,
    I18n.t("stdio 客户端配置片段（Claude Code / Cursor 等）"),
    I18n.t(
      "把这段合并进客户端的 MCP 配置：桥脚本会自己从数据目录读端口与令牌，不用手填地址。",
    ) + "\n" + mcpClientSnippet(s),
  );

  extInfoButtons(info, [
    [
      run ? I18n.t("关闭服务端") : I18n.t("开启服务端"),
      run ? "" : "primary",
      async () => {
        st.busy = true;
        paintExtManager();
        try {
          const r = await window.api.mcpSetEnabled(!run);
          if (r && r.ok === false) throw new Error(r.error);
          toast(run ? I18n.t("MCP 服务端已关闭") : I18n.t("MCP 服务端已开启"), "ok");
        } catch (e) {
          toast(I18n.t("操作失败：") + extErrorText(e), "err");
        }
        st.busy = false;
        await fetchMcpServerState();
        paintExtManager();
      },
    ],
    [
      I18n.t("复制地址"),
      "",
      async () => mcpCopy(run ? s.url : s.statePath, I18n.t("地址")),
    ],
    [I18n.t("复制令牌"), "", async () => mcpCopy(s.token, I18n.t("令牌"))],
    [
      I18n.t("复制配置片段"),
      "",
      async () => mcpCopy(mcpClientSnippet(s), I18n.t("stdio 配置")),
    ],
    [
      I18n.t("重置令牌"),
      "danger",
      async () => {
        if (
          !(await confirmDialog(
            I18n.t(
              "重置令牌后，已配置好的客户端要重新复制一次配置片段才能连上。继续？",
            ),
            { title: I18n.t("重置 MCP 令牌"), danger: true, okText: I18n.t("重置") },
          ))
        )
          return;
        try {
          const r = await window.api.mcpResetToken();
          if (r && r.ok === false) throw new Error(r.error);
          toast(I18n.t("令牌已重置"), "ok");
        } catch (e) {
          toast(I18n.t("操作失败：") + extErrorText(e), "err");
        }
        await fetchMcpServerState();
        paintExtManager();
      },
    ],
    [
      I18n.t("自检"),
      "",
      async () => {
        st.busy = true;
        paintExtManager();
        try {
          st.selfTest = await window.api.mcpSelfTest();
          toast(
            st.selfTest && st.selfTest.ok
              ? I18n.t("自检通过")
              : I18n.t("自检未通过：见下方明细"),
            st.selfTest && st.selfTest.ok ? "ok" : "err",
          );
        } catch (e) {
          st.selfTest = { ok: false, error: extErrorText(e), steps: [] };
        }
        st.busy = false;
        await fetchMcpServerState();
        paintExtManager();
      },
    ],
    [
      I18n.t("编辑客户端标识"),
      "",
      async () => {
        const cur = s.clientId || "";
        const v = window.prompt(I18n.t("客户端标识（只用于审计归类，可留空）"), cur);
        if (v === null) return;
        try {
          await window.api.mcpSetClientId(String(v || ""));
          toast(I18n.t("已保存"), "ok");
        } catch (e) {
          toast(I18n.t("保存失败：") + extErrorText(e), "err");
        }
        await fetchMcpServerState();
        paintExtManager();
      },
    ],
    [
      s.capture ? I18n.t("关掉抓包") : I18n.t("打开抓包"),
      "",
      async () => {
        try {
          await window.api.mcpSetCapture(!s.capture);
          toast(s.capture ? I18n.t("抓包已关闭") : I18n.t("抓包已打开（只留最近 200 条，仅本机内存）"), "ok");
        } catch (e) {
          toast(I18n.t("操作失败：") + extErrorText(e), "err");
        }
        await fetchMcpServerState();
        paintExtManager();
      },
    ],
  ]);

  if (st.selfTest) {
    const t = st.selfTest;
    const lines = (t.steps || []).map((x) => (x.ok ? "✓ " : "✗ ") + x.name + (x.detail ? " — " + x.detail : ""));
    extInfoDetails(
      info,
      (t.ok ? I18n.t("自检结果：通过") : I18n.t("自检结果：未通过")) + (t.error ? " · " + t.error : ""),
      lines.join("\n") || I18n.t("（没有步骤记录）"),
    );
  }

  /* 最近调用（审计） */
  const auditWrap = document.createElement("div");
  auditWrap.className = "dsh-mcp-res";
  const auditBar = document.createElement("div");
  auditBar.className = "dsh-mcp-res-bar";
  const auditTitle = document.createElement("span");
  auditTitle.className = "dsh-mcp-res-status";
  auditTitle.textContent = I18n.t("最近调用（审计 · 数据目录 mcp-audit/）");
  const auditRefresh = document.createElement("button");
  auditRefresh.type = "button";
  auditRefresh.className = "mini";
  auditRefresh.textContent = I18n.t("刷新");
  auditRefresh.onclick = async () => {
    await mcpServerLoadLogs();
    paintExtManager();
  };
  auditBar.appendChild(auditTitle);
  auditBar.appendChild(auditRefresh);
  auditWrap.appendChild(auditBar);
  const auditList = document.createElement("div");
  auditList.className = "dsh-mcp-res-list";
  if (!(st.audit || []).length) {
    const em = document.createElement("div");
    em.className = "dsh-mcp-res-row dsh-mcp-res-tpl";
    em.textContent = I18n.t("暂无调用记录（第三方客户端调一次就会出现在这里）");
    auditList.appendChild(em);
  }
  for (const e of (st.audit || []).slice().reverse()) {
    const row = document.createElement("div");
    row.className = "dsh-mcp-res-row";
    const name = document.createElement("div");
    name.className = "dsh-mcp-res-name";
    name.textContent =
      (e.ok ? "✓ " : "✗ ") +
      (e.tool || e.method || "") +
      (e.canvas ? " · " + e.canvas : "") +
      (e.client ? " · " + e.client : "");
    const uri = document.createElement("div");
    uri.className = "dsh-mcp-res-uri";
    uri.textContent =
      String(e.ts || "").replace("T", " ").slice(0, 19) +
      " · " + (e.ms != null ? e.ms + "ms" : "") +
      (e.session ? " · " + e.session : "") +
      (e.error ? " · " + e.error : "") +
      (e.args ? " · " + e.args : "");
    row.appendChild(name);
    row.appendChild(uri);
    auditList.appendChild(row);
  }
  auditWrap.appendChild(auditList);
  info.appendChild(auditWrap);

  /* 原始 JSON-RPC 抓包（显式打开；只留最近 200 条，仅本机内存） */
  if (s.capture) {
    const cap = document.createElement("details");
    cap.className = "dsh-plugin-yaml";
    const sum = document.createElement("summary");
    sum.textContent = I18n.t("原始 JSON-RPC 抓包（最近 ") + (st.capture || []).length + I18n.t(" 条）");
    cap.appendChild(sum);
    const pre = document.createElement("pre");
    pre.className = "dsh-plugin-detail";
    pre.textContent = (st.capture || [])
      .map((x) => x.ts + " " + x.kind + " " + JSON.stringify(x.payload))
      .join("\n") || I18n.t("（暂无）");
    cap.appendChild(pre);
    info.appendChild(cap);
  }
}

/* ── 兼容旧命名（设置与助手工具仍在用这些名字）── */
function openDshPluginsDialog() {
  return openExtManagerDialog("dsh");
}
function closeDshPluginsDialog() {
  return closeExtManagerDialog();
}
function refreshDshPluginInventory() {
  return refreshExtInventory({ kinds: ["dsh"] });
}
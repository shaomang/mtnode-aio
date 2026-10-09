"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   顶栏「性能」面板（renderer/app-perf.js）—— 本次开发需求：原「显存」按钮改名「性能」，
   面板 = 当前显存内容（原样保留）+ 基本系统资源检测（CPU / 内存 / GPU / 磁盘 / 网络）。

   分层（读数真源在主进程，本文件只负责画）：
     · 主进程 perf-probe.js：CPU / 内存 / GPU / 磁盘 / 网速 / 连接数 / 端口监听 的采样与缓存
       （重查询必须缓存，见该文件顶部口径）；
     · renderer/app-vram.js：显存与本地模型后端那一块**整块复用**（vramRenderPanel 的
       渲染落点已改成 .vram-slot，这里只放一个宿主 div），一键释放与释放日志口径一个字不改。

   刷新（口径由用户确认）：
     · 打开面板即开始，关闭即停（不留后台定时器）；
     · 轻量项（CPU / 内存 / GPU）每 1.5s，重项（磁盘剩余 / 网速 / 连接数）每 5s；
     · 手动「刷新」= 两项各拉一次。
   读数拿不到一律写「量不到」，不画假进度条、不编造数字。

   渲染口径（本模块「界面闪烁」的修复）：
     · 一次渲染 = 一棵**结构骨架**（每张卡每行每格都有身份 key）；首帧按 key 建节点，
       之后每个 tick 只把变化的文本 / 占用条 inline 宽度 / 每核 inline 高度 / 等级 class
       写回原节点 —— 节点身份不动，所以不再每秒整树重建；
     · 只有「读数里的列表结构」变了（显卡数 / 卷数 / 网卡数 / 逻辑核数 / 端口数）才重建
       相应那一部分（清掉该部分旧 key 的节点身份，下一帧重新建）；
     · 文案、类名、区块顺序、色值一字未改；值一律走 textContent 与 style 赋值
       （与拼字符串写 innerHTML 的转义语义等价，不引入注入面）；结构骨架里没有内联事件，
       onclick 只在建节点那一次（或结构变了重建时）挂上，不重复挂。
   ═══════════════════════════════════════════════════════════════════════════ */

const PERF_FAST_MS = 1500;
const PERF_SLOW_MS = 5000;
/* 每核占用条最多画几格：32 核全画会把面板撑得很长，超出只写文字数 */
const PERF_CORE_CELLS = 32;

const perfState = {
  timer: null,
  statics: null, /* 静态事实：CPU 型号 / 核心数 / 平台 / 数据目录（面板开一次采一次） */
  sample: null, /* 最近一次轻量读数 */
  system: null, /* 最近一次慢项读数 */
  busy: false,
  lastFast: 0,
  lastSlow: 0,
  note: "",
  /* ── 增量渲染用（纯界面状态，不参与读数）── */
  nodes: new Map(), /* key → 已建的 DOM 节点（跨 tick 复用） */
  cardSig: new Map(), /* 卡 key → 结构签名；变了才重建那一张卡的列表部分 */
};

/* ── 小工具：把读数变成人话（拿不到 = 「量不到」，绝不编造） ─────────────── */

function perfEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function perfFmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return "";
  if (b < 1024) return b + "B";
  if (b < 1024 * 1024) return Math.round(b / 1024) + "KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + "MB";
  return (b / 1024 / 1024 / 1024).toFixed(1) + "GB";
}

/** 速率：字节/秒 → 「x MB/s」；没有读数时给「采样中」 */
function perfFmtRate(bps, sampled) {
  if (!Number.isFinite(Number(bps))) return sampled ? I18n.t("采样中…") : I18n.t("量不到");
  const b = Math.max(0, Number(bps));
  if (b < 1024) return b + " B/s";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB/s";
  return (b / 1024 / 1024).toFixed(2) + " MB/s";
}

function perfNA() {
  return I18n.t("量不到");
}

/** 百分比 → 数字 + 占用条；null 走「量不到」。
 *  配色语义与显存面板的状态点一致：< 70% 绿、70~90% 暖橙、≥ 90% 红。 */
function perfBarRow(label, pct, valueText, cls) {
  const p = Number(pct);
  const has = Number.isFinite(p);
  const w = has ? Math.max(0, Math.min(100, p)) : 0;
  const lvl = !has ? "na" : p >= 90 ? "hi" : p >= 70 ? "mid" : "lo";
  return (
    '<div class="perf-bar ' +
    lvl +
    " " +
    (cls || "") +
    '">' +
    '<span class="perf-bar-label">' +
    perfEscape(label) +
    "</span>" +
    '<span class="perf-bar-track"><i style="width:' +
    w +
    '%"></i></span>' +
    '<span class="perf-bar-value">' +
    perfEscape(has ? Math.round(p * 10) / 10 + "%" : I18n.t("量不到")) +
    (valueText ? " · " + perfEscape(valueText) : "") +
    "</span>" +
    "</div>"
  );
}

/** 一行「名称 → 值」（显存后端行 / 网卡行 / 端口行共用） */
function perfKvRow(name, value, extra, cls) {
  return (
    '<div class="perf-row ' +
    (cls || "") +
    '">' +
    '<span class="perf-row-name">' +
    perfEscape(name) +
    "</span>" +
    '<span class="perf-row-val">' +
    perfEscape(value) +
    "</span>" +
    (extra ? '<span class="perf-row-extra">' + perfEscape(extra) + "</span>" : "") +
    "</div>"
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   取值 → 结构骨架（spec）
   一只 spec 节点 = { k 身份, tag, cls 静态类, lvl 等级 class, text 文本,
                     style inline 样式, title 悬停文案, id, attach 只建一次的挂载点,
                     hidden 是否隐藏, children 子节点 }
   两处共用：① perfSpecHtml() 写成 HTML（首帧骨架 / 兜底整块重画）；
             ② perfSync() 建节点并只把上面那几样写回去（每 tick 的增量补丁）。
   ═══════════════════════════════════════════════════════════════════════════ */

function perfSpec(k, tag, cls, extra) {
  const spec = { k: k, tag: tag || "div", cls: cls || "", lvl: "", children: [] };
  if (extra) for (const key of Object.keys(extra)) spec[key] = extra[key];
  return spec;
}

function perfPctInfo(pct) {
  const p = Number(pct);
  const has = Number.isFinite(p);
  return {
    has: has,
    lvl: !has ? "na" : p >= 90 ? "hi" : p >= 70 ? "mid" : "lo",
    w: (has ? Math.max(0, Math.min(100, p)) : 0) + "%",
    text: has ? Math.round(p * 10) / 10 + "%" : I18n.t("量不到"),
  };
}

/** 占用条：标签 + 轨道（里面的 i 扛宽度）+ 数值 */
function perfBarSpec(k, label, pct, valueText, cls) {
  const info = perfPctInfo(pct);
  const spec = perfSpec(k, "div", "perf-bar", {
    lvl: info.lvl,
    extra: cls || "",
    children: [
      perfSpec(k + "/label", "span", "perf-bar-label", { text: String(label == null ? "" : label) }),
      perfSpec(k + "/track", "span", "perf-bar-track", {
        children: [perfSpec(k + "/fill", "i", "", { style: { width: info.w } })],
      }),
      perfSpec(k + "/value", "span", "perf-bar-value", {
        text: info.text + (valueText ? " · " + valueText : ""),
      }),
    ],
  });
  return spec;
}

/** 一行「名称 → 值」（可带一句补充） */
function perfRowSpec(k, name, value, extra, cls) {
  const children = [
    perfSpec(k + "/name", "span", "perf-row-name", { text: String(name == null ? "" : name) }),
    perfSpec(k + "/val", "span", "perf-row-val", {
      text: value == null ? "" : String(value),
    }),
  ];
  if (extra) {
    children.push(perfSpec(k + "/extra", "span", "perf-row-extra", { text: String(extra) }));
  }
  return perfSpec(k, "div", "perf-row", { extra: cls || "", children: children });
}

/** 每核一格：格子里那根柱子按占用率给 inline 高度 + 格子按等级给 class
 *  （类名/结构口径与改前逐字一致：`perf-core <等级> ` 里套一只 `i` 扛高度）。 */
function perfCoreSpec(k, pct) {
  const p = Number(pct);
  const has = Number.isFinite(p);
  const spec = perfSpec(k, "span", "perf-core", {
    lvl: !has ? "na" : p >= 90 ? "hi" : p >= 50 ? "mid" : "lo",
    title: (has ? Math.round(p * 10) / 10 + "%" : I18n.t("量不到")) + " · CPU",
    children: [
      /* 高度必须落在 i 上：格子是 flex 列且 align-items:flex-end（子项不拉伸），
         写在格子上会被 CSS 的固定 32px 覆盖，柱子就永远是空的 */
      perfSpec(k + "/fill", "i", "", {
        style: { height: (has ? Math.max(2, Math.min(100, p)) : 0) + "%" },
      }),
    ],
  });
  spec.trail = true;
  return spec;
}

function perfEmptySpec(k, text) {
  return perfSpec(k, "div", "perf-empty", { text: text == null ? "" : String(text) });
}

/** 类名口径：占用条 `perf-bar <等级> <附加>`、明细行 `perf-row <附加>`（等级 / 附加为空时那一格为空串；
 *  占用条始终留出两格，与改前的拼接逐字一致 —— 兜底字符串路径上以「尾随空格」形式体现）。 */
function perfClassOf(spec) {
  if (spec.cls === "perf-bar" || spec.trail) {
    return spec.cls + " " + (spec.lvl || "") + " " + (spec.extra || "");
  }
  return (spec.cls + " " + (spec.extra || "")).trim();
}

/** 结构骨架片段 → HTML（用值渲染时值与骨架完全同源） */
function perfSpecHtml(spec) {
  if (!spec) return "";
  const tag = spec.tag || "div";
  const cls = perfClassOf(spec);
  const parts = [];
  if (spec.id) parts.push('id="' + perfEscape(spec.id) + '"');
  if (cls) parts.push('class="' + perfEscape(cls) + '"');
  /* 显存槽是 app-vram.js 的落点，保持它原本的 `<div class="vram-slot"></div>` 干净原样 */
  if (spec.k && spec.cls !== "vram-slot") parts.push('data-k="' + perfEscape(spec.k) + '"');
  if (spec.title) parts.push('title="' + perfEscape(spec.title) + '"');
  const styleKeys = spec.style ? Object.keys(spec.style) : [];
  if (styleKeys.length) {
    const style = [];
    for (const key of styleKeys) {
      style.push(key + ":" + spec.style[key]);
    }
    parts.push('style="' + perfEscape(style.join(";")) + '"');
  }
  const inner =
    spec.text != null && spec.text !== ""
      ? perfEscape(spec.text)
      : (spec.children || []).filter(Boolean).map((c) => perfSpecHtml(c)).join("");
  return "<" + tag + (parts.length ? " " + parts.join(" ") : "") + ">" + inner + "</" + tag + ">";
}

/** 把一只节点按 spec 写成骨架：只写 class / 文本 / inline 样式 / 悬停文案，节点身份不动 */
function perfApplySpec(el, spec) {
  if (!el || !spec) return;
  /* 真 DOM 上类名归一化到 trim 过的形态（`<div class="perf-bar">` 与 `"perf-bar "` 同一只节点） */
  const cls = perfClassOf(spec).trim();
  if (el.className !== cls) el.className = cls;
  if (spec.text != null && el.textContent !== spec.text) el.textContent = String(spec.text);
  const style = spec.style || {};
  if (el.style) {
    for (const key of Object.keys(style)) {
      const v = String(style[key]);
      if (el.style[key] !== v) el.style[key] = v;
    }
    const display = spec.hidden ? "none" : "";
    if (String(el.style.display || "") !== display) el.style.display = display;
  }
  if (spec.title && el.title !== spec.title) el.title = spec.title;
  if (spec.attach && !el.__perfAttached) {
    spec.attach(el);
    el.__perfAttached = true;
  }
}

/** 建一只节点（只在索引里没有时才走这里）：真 document 逐层建，直接挂到父节点上。
 *  不复用「写 innerHTML 再取第一个孩子」那套脚手架 —— 那会在每次重建时把整棵子树
 *  重新解析一遍（正是要消灭的翻建成本），而且脚手架里会留下已搬走节点的旧引用。 */
function perfCreate(parent, spec) {
  const el = document.createElement(spec.tag || "div");
  if (spec.id) el.id = spec.id;
  const key = spec.k || "";
  if (key) {
    if (el.dataset) el.dataset.k = key;
    else if (el.setAttribute) el.setAttribute("data-k", key);
    perfState.nodes.set(key, el);
  }
  if (parent.appendChild) parent.appendChild(el);
  const kids = spec.children || [];
  for (const child of kids) {
    if (child) perfCreate(el, child);
  }
  return el;
}

/** 骨架 → 节点（已有的按 key 复用，没有才建），并把这一棵的新值写回去。
 *  回执 = 「这一棵里有没有新节点被建出来」（调用方据此决定要不要重挂只建一次的挂载点）。 */
function perfSync(host, spec) {
  if (!host || !spec) return false;
  const key = spec.k || "";
  let el = key ? perfState.nodes.get(key) || null : null;
  let built = false;
  if (!el) {
    el = perfCreate(host, spec);
    built = !!el;
  }
  if (!el) return false;
  perfApplySpec(el, spec);
  const kids = spec.children || [];
  for (const child of kids) {
    if (child && perfSync(el, child)) built = true;
  }
  /* 子节点一致性：属这一段的按骨架顺序排好，不属于的摘掉并清掉身份（结构变了 / 读数换来源）。
     每次都按**当前** children 重排，不依赖「已挂过」的标记 —— 标记一旦与实际树脱节，
     同一只节点就会被挂第二份（面板里就是整段卡片翻倍）。 */
  if (!el.children) return built;
  const cur = Array.prototype.slice.call(el.children);
  const seen = {};
  for (const child of kids) {
    if (!child || !child.k) continue;
    const node = perfState.nodes.get(child.k);
    if (node) {
      seen[child.k] = true;
      if (cur.indexOf(node) < 0 && el.appendChild) el.appendChild(node);
    }
  }
  for (const node of cur) {
    const k = perfKeyOf(node);
    if (k && !seen[k]) {
      if (el.removeChild) el.removeChild(node);
      perfState.nodes.delete(k);
    }
  }
  return built;
}

/** 节点身份 */
function perfKeyOf(el) {
  if (!el) return "";
  if (el.dataset && el.dataset.k) return String(el.dataset.k);
  if (el.attrs && el.attrs["data-k"]) return String(el.attrs["data-k"]);
  return String(el.getAttribute ? el.getAttribute("data-k") || "" : "");
}

/** 清掉一段 key（含子孙）的节点身份：结构变了，下次重新建 */
function perfDropKeys(prefix) {
  const want = prefix + "/";
  for (const k of Array.from(perfState.nodes.keys())) {
    if (k === prefix || k.indexOf(want) === 0) perfState.nodes.delete(k);
  }
}

/* ═══════════ 数据拉取（宿主桥没就绪时一律回 null，界面写「不可用」） ═══════════ */

async function perfCall(fn, arg) {
  try {
    const f = window.api && window.api[fn];
    if (typeof f !== "function") return null;
    const r = await f(arg);
    return r && r.ok !== false ? r : null;
  } catch {
    return null;
  }
}

async function perfRefreshFast() {
  const r = await perfCall("perfSample");
  if (r) {
    perfState.sample = r;
    perfState.lastFast = Date.now();
  }
  return !!r;
}

async function perfRefreshSlow(force) {
  const r = await perfCall("perfSystem", {
    force: !!force,
    /* 正在跑的画布用的后端端口由主进程补（各后端登记的 port），这里只补面板自己的关注点 */
    ports: [],
  });
  if (r) {
    perfState.system = r;
    perfState.lastSlow = Date.now();
  }
  return !!r;
}

/* ═══════════ 读数 → 各卡片骨架 ═══════════════════════════════════════════
   卡片顺序 = 性能总览 / 显存与本地模型 / CPU / 内存 / GPU / 磁盘 / 网络
   （与改前逐字一致；每张卡的文案、类名、色值口径也一字未改）。 */

function perfOverviewSpec() {
  const s = perfState.sample;
  const sys = perfState.system;
  const cpu = s && s.cpu ? s.cpu : null;
  const mem = s && s.mem ? s.mem : null;
  const gpuCard = s && s.gpu && s.gpu.available && s.gpu.cards.length ? s.gpu.cards[0] : null;
  const vol = sys && sys.volumes && sys.volumes.length ? sys.volumes[0] : null;
  if (!s && !sys) {
    return {
      sig: "1",
      node: perfSpec("overview", "div", "perf-card", {
        children: [
          perfSpec("overview/title", "div", "perf-card-title", { text: I18n.t("性能总览") }),
          perfEmptySpec("overview/empty", I18n.t("正在采集系统读数…")),
        ],
      }),
    };
  }
  return {
    sig: "1",
    node: perfSpec("overview", "div", "perf-card", {
      children: [
        perfSpec("overview/title", "div", "perf-card-title", { text: I18n.t("性能总览") }),
        perfSpec("overview/bars", "div", "perf-pairs", {
          children: [
            perfBarSpec(
              "overview/bar-0",
              I18n.t("CPU"),
              cpu ? cpu.overall : null,
              cpu && cpu.model ? cpu.model : "",
            ),
            perfBarSpec(
              "overview/bar-1",
              I18n.t("内存"),
              mem ? mem.usedPct : null,
              mem
                ? I18n.t("占用 ") + perfFmtBytes(mem.usedBytes) + " / " + perfFmtBytes(mem.totalBytes)
                : "",
            ),
            perfBarSpec(
              "overview/bar-2",
              I18n.t("GPU"),
              gpuCard ? gpuCard.utilPct : null,
              gpuCard
                ? gpuCard.name +
                    " · " +
                    I18n.t("显存 ") +
                    perfFmtBytes(gpuCard.usedMb * 1024 * 1024) +
                    " / " +
                    perfFmtBytes(gpuCard.totalMb * 1024 * 1024)
                : "",
            ),
            perfBarSpec(
              "overview/bar-3",
              I18n.t("磁盘"),
              vol ? vol.freePct : null,
              vol ? vol.letter + " " + I18n.t("空闲 ") + perfFmtBytes(vol.freeBytes) : "",
            ),
          ],
        }),
        perfSpec("overview/foot", "div", "perf-foot", { text: perfState.note || "" }),
      ],
    }),
  };
}

function perfVramSpec() {
  return {
    sig: "1",
    node: perfSpec("vram", "div", "perf-card perf-vram-card", {
      children: [
        perfSpec("vram/title", "div", "perf-card-title", { text: I18n.t("显存与本地模型") }),
        /* 显存那一块完全复用 renderer/app-vram.js：它把内容写进 .vram-slot
           （性能面板里就是这个槽；面板没开时它退回写 #ovBody，行为与以前一致） */
        perfSpec("vram/slot", "div", "vram-slot", {}),
      ],
    }),
  };
}

function perfCpuSpec() {
  const s = perfState.sample;
  const st = perfState.statics || {};
  const cpu = s && s.cpu ? s.cpu : null;
  const model = (cpu && cpu.model) || st.cpuModel || "";
  const cores = (cpu && cpu.cores) || [];
  const cells = cores.slice(0, PERF_CORE_CELLS);
  const children = [
    perfSpec("cpu/rows", "div", "perf-rows", {
      children: [
        perfRowSpec("cpu/rows/model", I18n.t("型号"), model || I18n.t("量不到")),
        perfRowSpec(
          "cpu/rows/cores",
          I18n.t("核心"),
          st.cores ? String(st.cores) : cores.length ? String(cores.length) : I18n.t("量不到"),
          I18n.t("逻辑处理器"),
        ),
      ],
    }),
  ];
  if (cells.length) {
    children.push(
      perfSpec("cpu/cores", "div", "perf-cores", {
        children: cells.map((v, i) => perfCoreSpec("cpu/core-" + i, v)),
      }),
    );
    children.push(
      perfSpec("cpu/foot", "div", "perf-foot", {
        text:
          cores.length > PERF_CORE_CELLS
            ? I18n.t("每核占用（只列出前 ") + PERF_CORE_CELLS + I18n.t(" 个逻辑核）")
            : I18n.t("每核占用"),
      }),
    );
  } else {
    children.push(
      perfSpec("cpu/foot", "div", "perf-foot", {
        text: I18n.t("每核占用：需要两次采样，稍等 1～2 秒"),
      }),
    );
  }
  return {
    sig: "1/" + cells.length,
    node: perfSpec("cpu", "div", "perf-card", {
      children: [perfSpec("cpu/title", "div", "perf-card-title", { text: I18n.t("CPU") })].concat(
        children,
      ),
    }),
  };
}

function perfMemSpec() {
  const s = perfState.sample;
  const mem = s && s.mem ? s.mem : null;
  if (!mem) {
    return {
      sig: "0",
      node: perfSpec("mem", "div", "perf-card", {
        children: [
          perfSpec("mem/title", "div", "perf-card-title", { text: I18n.t("内存") }),
          perfEmptySpec("mem/empty", I18n.t("正在采集系统读数…")),
        ],
      }),
    };
  }
  return {
    sig: "1",
    node: perfSpec("mem", "div", "perf-card", {
      children: [
        perfSpec("mem/title", "div", "perf-card-title", { text: I18n.t("内存") }),
        perfBarSpec(
          "mem/bar",
          I18n.t("物理内存"),
          mem.usedPct,
          I18n.t("占用 ") + perfFmtBytes(mem.usedBytes) + " / " + perfFmtBytes(mem.totalBytes),
        ),
        perfSpec("mem/rows", "div", "perf-rows", {
          children: [
            perfRowSpec("mem/rows/free", I18n.t("可用"), perfFmtBytes(mem.freeBytes)),
            perfRowSpec("mem/rows/total", I18n.t("总计"), perfFmtBytes(mem.totalBytes)),
          ],
        }),
      ],
    }),
  };
}

function perfGpuSpec() {
  const s = perfState.sample;
  const gpu = s && s.gpu ? s.gpu : null;
  const title = perfSpec("gpu/title", "div", "perf-card-title", { text: I18n.t("GPU（显卡）") });
  if (!gpu) {
    return {
      sig: "0",
      node: perfSpec("gpu", "div", "perf-card", {
        children: [title, perfEmptySpec("gpu/empty", I18n.t("正在采集系统读数…"))],
      }),
    };
  }
  if (!gpu.available || !gpu.cards.length) {
    return {
      sig: "0",
      node: perfSpec("gpu", "div", "perf-card", {
        children: [
          title,
          perfEmptySpec("gpu/empty", I18n.t("显卡读数：量不到（nvidia-smi 不可用）")),
        ],
      }),
    };
  }
  const labels = [I18n.t("利用率"), I18n.t("温度"), I18n.t("功耗"), I18n.t("风扇")];
  const cards = gpu.cards.map((c, i) => {
    const rows = [
      c.utilPct == null ? perfNA() : Math.round(c.utilPct * 10) / 10 + "%",
      c.tempC == null ? perfNA() : Math.round(c.tempC) + " °C",
      c.powerW == null ? perfNA() : Math.round(c.powerW * 10) / 10 + " W",
      c.fanPct == null ? perfNA() : Math.round(c.fanPct) + "%",
    ];
    return perfSpec("gpu/card-" + i, "div", "perf-gpu-one", {
      children: [
        perfBarSpec(
          "gpu/card-" + i + "/bar",
          c.name || I18n.t("GPU"),
          c.utilPct,
          I18n.t("显存 ") +
            perfFmtBytes(c.usedMb * 1024 * 1024) +
            " / " +
            perfFmtBytes(c.totalMb * 1024 * 1024) +
            (c.memPct == null ? "" : "（" + Math.round(c.memPct * 10) / 10 + "%）"),
        ),
        perfSpec("gpu/card-" + i + "/rows", "div", "perf-rows", {
          children: rows.map((v, j) =>
            perfRowSpec("gpu/card-" + i + "/rows/" + j, labels[j], v),
          ),
        }),
      ],
    });
  });
  return {
    sig: "1/" + gpu.cards.length,
    node: perfSpec("gpu", "div", "perf-card", { children: [title].concat(cards) }),
  };
}

function perfDiskSpec() {
  const sys = perfState.system;
  const title = perfSpec("disk/title", "div", "perf-card-title", { text: I18n.t("磁盘") });
  if (!sys) {
    return {
      sig: "0",
      node: perfSpec("disk", "div", "perf-card", {
        children: [title, perfEmptySpec("disk/empty", I18n.t("正在采集磁盘读数…"))],
      }),
    };
  }
  const vols = sys.volumes || [];
  const children = [title];
  if (vols.length) {
    for (let i = 0; i < vols.length; i++) {
      const v = vols[i];
      children.push(
        perfBarSpec(
          "disk/vol-" + i,
          v.letter +
            (v.role === "data"
              ? "（" + I18n.t("数据盘") + "）"
              : v.role === "app"
                ? "（" + I18n.t("应用盘") + "）"
                : "（" + I18n.t("数据盘 / 应用盘") + "）"),
          v.freePct,
          I18n.t("空闲 ") + perfFmtBytes(v.freeBytes) + " / " + perfFmtBytes(v.totalBytes),
        ),
      );
    }
  } else {
    children.push(perfEmptySpec("disk/empty", I18n.t("磁盘读数：量不到")));
  }
  children.push(
    perfSpec("disk/rows", "div", "perf-rows", {
      children: [
        perfRowSpec("disk/rows/data", I18n.t("数据目录"), sys.dataDir || I18n.t("量不到")),
        sys.appDir ? perfRowSpec("disk/rows/app", I18n.t("应用目录"), sys.appDir) : null,
      ].filter(Boolean),
    }),
  );
  children.push(
    perfSpec("disk/actions", "div", "perf-actions", {
      children: [
        perfSpec("disk/actions/detail", "button", "btn", {
          id: "perfStorageDetail",
          text: I18n.t("查看数据目录占用明细…"),
          attach: (el) => {
            el.onclick = () => {
              /* 跳去设置里现成的「存储占用与清理」小节（不在这里重做清理逻辑） */
              if (typeof openSettings === "function") openSettings({ section: "storage" });
            };
          },
        }),
      ],
    }),
  );
  children.push(
    perfSpec("disk/foot", "div", "perf-foot", {
      text: I18n.t(
        "明细与清理在「设置 · 存储占用与清理」里（这里不重做一份清理逻辑，避免误删正在用的文件）。",
      ),
    }),
  );
  return {
    sig: "1/" + vols.map((v) => String(v.letter || "")).join(",") + "/" + (sys.appDir ? 1 : 0),
    node: perfSpec("disk", "div", "perf-card", { children: children }),
  };
}

function perfNetSpec() {
  const sys = perfState.system;
  const title = perfSpec("net/title", "div", "perf-card-title", { text: I18n.t("网络") });
  if (!sys) {
    return {
      sig: "0",
      node: perfSpec("net", "div", "perf-card", {
        children: [title, perfEmptySpec("net/empty", I18n.t("正在采集网络读数…"))],
      }),
    };
  }
  const net = sys.net || {};
  const ifaces = net.ifaces || [];
  const rates = net.rates || [];
  const up = ifaces.filter((i) => i.up);
  const shown = up.length ? up : ifaces.slice(0, 3);
  const children = [title];
  if (shown.length) {
    children.push(
      perfSpec("net/ifaces", "div", "perf-ifaces", {
        children: shown.map((i, idx) => {
          const r = rates.find((x) => x.name === i.name) || null;
          const down = r ? perfFmtRate(r.rxRate, !!r.rx) : I18n.t("量不到");
          const upTxt = r ? perfFmtRate(r.txRate, !!r.tx) : I18n.t("量不到");
          const total =
            r && r.rx != null
              ? I18n.t("累计 ") +
                I18n.t("收 ") +
                perfFmtBytes(r.rx) +
                " / " +
                I18n.t("发 ") +
                perfFmtBytes(r.tx)
              : "";
          return perfRowSpec(
            "net/iface-" + idx,
            i.name,
            I18n.t("↓ ") + down + " · " + I18n.t("↑ ") + upTxt,
            [i.linkSpeed, total].filter(Boolean).join(" · "),
            i.up ? "up" : "down",
          );
        }),
      }),
    );
  } else {
    children.push(perfEmptySpec("net/empty", I18n.t("网卡读数：量不到")));
  }
  const conns = sys.conns || null;
  children.push(
    perfSpec("net/conns", "div", "perf-rows", {
      children: [
        conns
          ? perfRowSpec(
              "net/conns/tcp",
              I18n.t("本机 TCP 连接"),
              String(conns.total),
              I18n.t("已建立 ") + conns.established + " · " + I18n.t("监听 ") + conns.listening,
            )
          : perfRowSpec("net/conns/tcp", I18n.t("本机 TCP 连接"), perfNA()),
      ],
    }),
  );
  const ports = sys.ports || [];
  if (ports.length) {
    children.push(perfSpec("net/ports-sub", "div", "perf-sub", { text: I18n.t("本地后端端口") }));
    children.push(
      perfSpec("net/ports", "div", "perf-rows", {
        children: ports.map((p, i) =>
          perfRowSpec(
            "net/port-" + i,
            ":" + p.port,
            p.listening ? I18n.t("在监听") : I18n.t("未监听"),
            "",
            p.listening ? "up" : "down",
          ),
        ),
      }),
    );
  } else {
    children.push(
      perfEmptySpec("net/ports-foot", I18n.t("本地模型后端未登记端口，暂不检测端口连接。")),
    );
  }
  return {
    sig:
      "1/" +
      shown.map((i) => i.name + (i.up ? "+" : "-")).join(",") +
      "/" +
      (conns ? "c" : "-") +
      "/" +
      ports.map((p) => p.port + (p.listening ? "+" : "-")).join(","),
    node: perfSpec("net", "div", "perf-card", { children: children }),
  };
}

/** 面板全部卡片（顺序 = 概览 / 显存 / CPU / 内存 / GPU / 磁盘 / 网络） */
function perfPanelSpecs() {
  return [
    perfOverviewSpec(),
    perfVramSpec(),
    perfCpuSpec(),
    perfMemSpec(),
    perfGpuSpec(),
    perfDiskSpec(),
    perfNetSpec(),
  ];
}

/* ── 画整只面板 ───────────────────────────────────────────────────────── */

/** 面板渲染：只在**有新读数**时被调用（见 perfTick 的口径）。
 *  回执 = 本次有没有新建显存槽节点（新建过才需要把 app-vram.js 的内容挂进去一次）。 */
function perfRenderPanel() {
  const body = document.getElementById("ovBody");
  if (!body) return false;
  const wrap = body.querySelector(".perf-panel");
  if (!wrap) return false;
  const host = wrap.querySelector(".perf-data");
  if (!host) return false;

  const specs = perfPanelSpecs();
  /* 能真建节点、也能摘节点（真 DOM）才走增量补丁；极简假 DOM 退回整块 HTML，内容等价。
     这一探测只在真渲染时做一次（空转的 tick 根本进不来），建出来的探针节点也在同一 tick 被丢弃 */
  const canPatch = (function () {
    if (
      typeof document.createElement !== "function" ||
      typeof host.appendChild !== "function" ||
      typeof host.removeChild !== "function"
    ) {
      return false;
    }
    try {
      const probe = document.createElement("div");
      probe.innerHTML = "<i></i>";
      return !!(probe.children && probe.children.length && probe.children[0].removeChild);
    } catch {
      return false;
    }
  })();
  if (!canPatch) {
    /* 极简假 DOM：整块 HTML 一条路（内容与补丁路径同源同值），显存槽也当场重挂一次 */
    host.innerHTML = specs.map((x) => perfSpecHtml(x.node)).join("");
    perfMountVram();
    return true;
  }

  const keep = [];
  let freshVramSlot = false;
  for (const item of specs) {
    const key = item.node.k;
    const prev = perfState.cardSig.get(key);
    const el = perfState.nodes.get(key) || null;
    if (el && prev !== undefined && prev !== item.sig) {
      /* 结构签名变了（显卡数 / 卷数 / 网卡数 / 逻辑核数 / 端口数）：这一段（含子 key）作废重建 */
      perfDropKeys(key);
      perfState.nodes.delete(key);
      perfState.cardSig.delete(key);
    } else if (!el) {
      perfState.cardSig.set(key, item.sig);
    }
    const built = perfSync(host, item.node);
    if (built && key === "vram") freshVramSlot = true;
    const cur = perfState.nodes.get(key) || null;
    if (cur) keep.push(cur);
  }
  /* 卡片顺序照骨架，多出来的旧卡摘掉（切读数来源时可能少一张） */
  const want = new Set(keep);
  if (host.children) {
    for (const c of Array.prototype.slice.call(host.children)) {
      if (!want.has(c) && host.removeChild) host.removeChild(c);
    }
  }
  /* 显存区块只在「槽是新落的」时候挂一次内容（每 tick 连带重画正是要消灭的成本之一） */
  if (freshVramSlot) perfMountVram();
  return freshVramSlot;
}

/** 显存区块：交给 app-vram.js 的同一个渲染函数（一键释放 / 释放日志口径一个字不改）。
 *  什么时候重画（口径）：① 性能面板的显存槽**新落成**（首帧 / 结构变过重建 / 重新打开面板）；
 *  ② 用户点「刷新」（force 那一轮）；③ 收到主进程的释放回执（app-vram.js 自己的订阅，它只在
 *  面板开着且 .vram-panel 在时才重画）。1s 的空转 tick 一律不重画这一块 —— 那是纯浪费，
 *  也是原来每 tick 闪一下的来源之一。 */
function perfMountVram() {
  if (typeof vramSubscribeReleased === "function") vramSubscribeReleased();
  if (typeof vramRenderPanel === "function") vramRenderPanel();
}

/** 面板是否还开着：关掉（#overlay 收起）就不再拉读数 */
function perfPanelOpen() {
  const el = document.getElementById("overlay");
  if (!el || el.style.display === "none") return false;
  const body = document.getElementById("ovBody");
  return !!(body && body.querySelector(".perf-panel"));
}

function perfStopTimer() {
  if (perfState.timer) {
    clearInterval(perfState.timer);
    perfState.timer = null;
  }
}

/** 一轮刷新（口径）：
 *   · 轻量到点（1.5s）拉轻量、慢项到点（5s）拉慢项；手动「刷新」= force 两项各拉一次。
 *   · **本轮没拿到新读数就不重绘**：1s 表多数 tick 都在两档之间空转，空转时重画只会闪屏，
 *     所以只有真拉到新读数（或读数由「有」变「无」这种状态切换）才进渲染；
 *     没有任何新读数的 tick 连一个节点都不碰（连起来看就是「面板不动」）。 */
async function perfTick(force) {
  if (!perfPanelOpen()) {
    perfStopTimer();
    return;
  }
  if (perfState.busy) return;
  perfState.busy = true;
  let pulled = false; /* 本轮真的拿到了新读数（fast 或 slow 任一） */
  let staleChanged = false; /* 拉数失败导致读数状态切换（有 → 无，含首次拉不到） */
  try {
    const now = Date.now();
    const wantFast = !!force || now - perfState.lastFast >= PERF_FAST_MS;
    const wantSlow = !!force || now - perfState.lastSlow >= PERF_SLOW_MS;
    if (wantFast) {
      const got = await perfRefreshFast();
      if (got) pulled = true;
      else staleChanged = staleChanged || !!perfState.sample;
    }
    if (wantSlow) {
      const got = await perfRefreshSlow(!!force);
      if (got) pulled = true;
      else staleChanged = staleChanged || !!perfState.system;
    }
    if (pulled) {
      /* 时间戳只在真拉到读数时更新：空转的 tick 不改「读数更新于 …」，免得写一个没发生过的时间 */
      perfState.note =
        I18n.t("读数更新于 ") +
        new Date().toLocaleTimeString() +
        " · " +
        I18n.t("轻量项每 ") +
        PERF_FAST_MS / 1000 +
        I18n.t(" 秒、磁盘与网络每 ") +
        PERF_SLOW_MS / 1000 +
        I18n.t(" 秒自动刷新；关闭本窗即停止采样。");
    }
  } finally {
    perfState.busy = false;
  }
  if (!pulled && !staleChanged) return; /* 没有新读数：这一 tick 不碰 DOM */
  if (!perfPanelOpen()) return;
  const freshVram = perfRenderPanel();
  /* 手动「刷新」= 用户要的就是「现在重画一遍」：显存区块（走它自己的 IPC）也一起重画 */
  if (force && !freshVram) perfMountVram();
}

function perfStartTimer() {
  perfStopTimer();
  perfState.timer = setInterval(() => {
    perfTick(false);
  }, 1000);
}

/**
 * 顶栏入口：打开「性能」面板（持久浮层）。
 * 原「显存」入口就是这一格 —— 改名后显存内容仍在同一只窗里（口径由用户确认）。
 */
function openPerfPanel() {
  if (typeof openOverlay !== "function") return;
  openOverlay(I18n.t("性能"), { persistent: true });
  const body = document.getElementById("ovBody");
  const foot = document.getElementById("ovFoot");
  if (!body || !foot) return;
  /* 换窗 = 上一只面板的节点作废：清掉身份与结构签名，下一帧重新建骨架 */
  perfState.nodes = new Map();
  perfState.cardSig = new Map();
  body.innerHTML =
    '<div class="perf-panel">' +
    '<div class="perf-data"><div class="perf-empty">' +
    perfEscape(I18n.t("正在采集系统读数…")) +
    "</div></div>" +
    "</div>";
  foot.innerHTML = "";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "btn";
  refresh.id = "perfRefresh";
  refresh.textContent = I18n.t("刷新");
  refresh.onclick = () => perfTick(true);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn";
  close.textContent = I18n.t("关闭");
  close.onclick = () => {
    if (typeof closeOverlay === "function") closeOverlay();
  };
  foot.appendChild(refresh);
  foot.appendChild(close);

  /* 静态事实只采一次（CPU 型号等），失败也不影响读数区 */
  perfState.statics = null;
  perfCall("perfStatics").then((r) => {
    if (r) perfState.statics = r;
  });
  /* 首屏：轻量 + 慢项各拉一次，然后按 1.5s / 5s 两档自动刷 */
  perfState.lastFast = 0;
  perfState.lastSlow = 0;
  perfTick(true);
  perfStartTimer();
}

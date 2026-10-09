"use strict";
/* 顶栏「性能」面板回归冒烟测试 —— 纯 Node，不启动 Electron
 *   node test/smoke-perf.js
 *
 * 本次开发需求：原「显存」按钮改名「性能」，面板里除了原有的显存内容，还要给出基本系统
 * 资源的检测（磁盘 / 内存 / CPU / GPU / 网络等）。钉住的都是「错一点就会出现假读数 /
 * 每秒拉起一串 PowerShell / 显存释放能力被静默丢掉」的地方：
 *   [1] 顶栏入口：id=btnPerf、文案「性能」、内联描边图标（不再用显存条图形）、
 *       不带 data-i18n-title / data-tip（与相邻 19 颗工具按钮同一口径）、暖橙红专属色仍在。
 *   [2] 渲染层接线：index.html 在 app-vram.js 之后引入 app-perf.js；app-boot.js 绑 openPerfPanel；
 *       面板有「显存与本地模型」区块且渲染落点是 .vram-slot —— 也就是**复用** app-vram.js 的
 *       vramRenderPanel（一键释放 / 释放日志口径一个字不改）。
 *   [3] 主进程探针（perf-probe.js）：纯函数口径 + 采样结构 + **重查询缓存**（TTL 内不重复拉
 *       PowerShell）+ 子进程一律 windowsHide（不许探一次读数闪一下黑窗）。
 *   [4] 桥与打包：preload 暴露 perf:* 四个方法、main.js 注册 perf: 四个 handler、
 *       build.json 白名单补上 perf-probe.js（漏了就是打包后 Cannot find module）。
 *   [5] i18n：本轮新词条中英成对（读数取不到一律「量不到」，用 i18n.t 直接验）。
 *   [6] CSS：.btn-perf 专属色 + .perf-* 版式（占用条 / 每核格子 / 明细行）。
 */
const fs = require("fs");
const path = require("path");
const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));
const probe = require(path.join(__dirname, "..", "perf-probe.js"));

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const section = (t) => console.log("\n[" + t + "]");
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const has = (hay, needle, msg) => ok(hay.indexOf(needle) >= 0, msg);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HTML = read("renderer/index.html");
const BOOT = read("renderer/app-boot.js");
const PERF = read("renderer/app-perf.js");
const VRAM = read("renderer/app-vram.js");
const LAYOUT = read("renderer/css/layout.css");
const PERF_CSS = read("renderer/css/perf.css");
const I18N_SRC = read("renderer/i18n.js");
const PRELOAD = read("preload.js");
const MAIN = read("main.js");
const BUILD = read("build.json");
const PROBE_SRC = read("perf-probe.js");

/* 取某个按钮的开标签与整段（到 </button> 为止） */
const btnOf = (id) => {
  const at = HTML.indexOf('id="' + id + '"');
  if (at < 0) return "";
  const start = HTML.lastIndexOf("<button", at);
  const end = HTML.indexOf("</button>", at);
  return start >= 0 && end > start ? HTML.slice(start, end + 9) : "";
};

/* ═══════════════ [1] 顶栏入口 ═══════════════ */
section("1] 顶栏「性能」按钮（原名「显存」）");
{
  const box = btnOf("btnPerf");
  ok(!!box, "#btnPerf 就位（旧 id btnVram 已改名）");
  ok(!/id="btnVram"/.test(HTML), "index.html 里不再有 btnVram（改名不留旧壳）");
  const tag = box.slice(0, box.indexOf(">") + 1);
  ok(/class="[^"]*btn-ico/.test(tag) && /class="[^"]*btn-perf/.test(tag), "按钮带 .btn-ico 与 .btn-perf");
  ok(/aria-label="性能"/.test(tag), "aria-label = 性能（无障碍名随文案一起改）");
  ok(
    tag.indexOf("data-i18n-title=") < 0 && tag.indexOf("data-tip=") < 0,
    "不再挂 data-i18n-title / data-tip（与相邻 19 颗工具按钮同一口径）",
  );
  has(box, '<span class="btn-ico-txt" data-i18n="性能">性能</span>', "可见文字 = 性能（挂在 span.btn-ico-txt 上）");
  ok(!/app-icon\.png|<img/.test(box), "图标仍是内联 SVG（不引位图）");
  ok(
    /stroke="currentColor"/.test(box) && /viewBox="0 0 16 16"/.test(box),
    "图标是 16 viewBox 的描边 SVG（随主题色）",
  );
  ok(
    !/M2\.4 5\.2h11\.2v5\.6H2\.4z/.test(box),
    "旧的「显存条」图形已换掉（不再是内存条那一枚）",
  );
  /* 顶栏按钮顺序：素材库 → 性能 → 工坊（位置没动，用户找得到） */
  const atAssets = HTML.indexOf('id="btnAssets"');
  const atPerf = HTML.indexOf('id="btnPerf"');
  const atStore = HTML.indexOf('id="btnStore"');
  ok(atAssets > 0 && atPerf > atAssets && atStore > atPerf, "位置不变：素材库 → 性能 → 工坊");
  /* 专属色：暖橙红（与工具库紫 / 素材库青 / 工坊橙区分） */
  const rule = LAYOUT.slice(LAYOUT.indexOf(".topbar .btn-perf {"), LAYOUT.indexOf("}", LAYOUT.indexOf(".topbar .btn-perf {")));
  ok(/#ff8a65/.test(rule), "layout.css 的 .btn-perf 仍是暖橙红 #ff8a65（专属色没丢）");
  ok(!/\.topbar \.btn-vram\b/.test(LAYOUT), "layout.css 里不再有 .btn-vram 规则（旧选择器已清）");
}

/* ═══════════════ [2] 渲染层接线 ═══════════════ */
section("2] 渲染层接线：入口绑定 + 显存区块复用 + 刷新档位");
{
  has(BOOT, 'if ($("#btnPerf") && typeof openPerfPanel === "function")', "app-boot.js 把 #btnPerf 绑到 openPerfPanel()");
  ok(!/btnVram/.test(BOOT), "app-boot.js 里不再引用 btnVram");
  const atVram = HTML.indexOf('<script src="app-vram.js"></script>');
  const atPerf = HTML.indexOf('<script src="app-perf.js"></script>');
  ok(atVram > 0 && atPerf > atVram, "index.html 里 app-perf.js 排在 app-vram.js 之后（面板要用 vramRenderPanel）");
  ok(
    HTML.indexOf('<script src="app-boot.js"></script>') > atPerf,
    "app-perf.js 早于 app-boot.js（入口绑定时函数已定义）",
  );
  /* 骨架里的文案走 textContent 写回（不再拼 HTML 串），所以这里认的是 I18n.t 调用本身 */
  has(PERF, 'I18n.t("显存与本地模型")', "面板有「显存与本地模型」区块");
  has(PERF, '<div class="vram-slot"></div>', "该区块的内容落点是 .vram-slot");
  has(PERF, "if (typeof vramRenderPanel === \"function\") vramRenderPanel();", "内容交给 app-vram.js 的同一只渲染函数");
  has(PERF, "vramSubscribeReleased()", "释放回执订阅走 app-vram.js 的同一只幂等入口");
  has(VRAM, 'body.querySelector(".vram-slot") || body', "vramRenderPanel 优先写 .vram-slot，没有就照旧写整只 #ovBody");
  has(PERF, "const PERF_FAST_MS = 1500;", "轻量项刷新档 = 1.5s");
  has(PERF, "const PERF_SLOW_MS = 5000;", "重项刷新档 = 5s");
  has(PERF, "perfStopTimer()", "有关表的路径");
  has(PERF, 'if (!perfPanelOpen()) {\n    perfStopTimer();\n    return;\n  }', "面板一关立刻停表（不留后台采样）");
  has(PERF, 'openOverlay(I18n.t("性能"), { persistent: true })', "面板标题 = 性能，且是持久浮层（点外部不关）");
  has(PERF, 'openSettings({ section: "storage" })', "「查看数据目录占用明细…」跳设置里的存储小节");
  has(read("renderer/app-settings.js"), 'sec.id = "setStorageSec"', "设置里那一节有滚动落点 id");
  has(read("renderer/app-settings.js"), '? "setDataRootSec"\n      : settingsFocusSection === "storage"\n        ? "setStorageSec"', "落点分发认 storage");
}

/* ═══════════════ [3] 主进程探针 ═══════════════ */
section("3] perf-probe.js：纯函数口径 + 采样结构 + 缓存与静默子进程");
{
  ok(typeof probe.registerPerfIpc === "function", "导出 registerPerfIpc");
  ok(typeof probe.sample === "function" && typeof probe.system === "function", "导出 sample / system");
  /* 盘符解析 */
  ok(probe.volumeRootOf("C:\\Users\\me\\AppData") === "C", "volumeRootOf 取盘符（大写）");
  ok(probe.volumeRootOf("e:\\dev\\tools") === "E", "小写盘符也认");
  ok(probe.volumeRootOf("/home/me") === "", "非 Windows 绝对路径回空（不猜）");
  ok(probe.volumeRootOf("") === "" && probe.volumeRootOf(null) === "", "空值回空");
  /* JSON 容错：PowerShell 可能带 BOM / 半截输出 */
  ok(probe.parseJson('\uFEFF{"a":1}').a === 1, "parseJson 认 BOM");
  ok(probe.parseJson("not json") === null && probe.parseJson("") === null, "解析不了回 null（当量不到）");
  /* nvidia-smi 行解析 */
  const card = probe.parseSmiLine("NVIDIA GeForce RTX 4090, 20, 2852, 24564, 51, 73.12, 0");
  ok(card && card.name === "NVIDIA GeForce RTX 4090", "parseSmiLine 取卡名");
  ok(card.utilPct === 20 && card.usedMb === 2852 && card.totalMb === 24564, "利用率与显存读数");
  ok(card.tempC === 51 && card.powerW === 73.12 && card.fanPct === 0, "温度 / 功耗 / 风扇");
  ok(card.memPct === 11.6, "显存占比现算（2852/24564）");
  ok(probe.parseSmiLine("") === null && probe.parseSmiLine("a, b") === null, "坏行回 null");
  /* CPU 差分（合成读数：核 0 满负荷、核 1 全空闲） */
  const d = probe.cpuDelta(
    { overall: { idle: 0, total: 0 }, cores: [{ idle: 0, total: 0 }, { idle: 0, total: 0 }] },
    {
      overall: { idle: 100, total: 200 },
      cores: [{ idle: 0, total: 100 }, { idle: 100, total: 100 }],
    },
  );
  ok(d.overall === 50, "cpuDelta：全核合计 50%（空闲 100 / 总计 200）");
  ok(d.cores[0] === 100 && d.cores[1] === 0, "cpuDelta：每核分别 100% / 0%");
  ok(d.count === 2, "cpuDelta：带上逻辑核数");
  ok(probe.cpuDelta(null, { overall: { idle: 0, total: 0 }, cores: [] }) === null, "没有上一次读数回 null（面板写「量不到」，不编造）");
  /* 采样结构 */
  ok(probe.CMD_TIMEOUT_MS > 0 && probe.SLOW_TTL_MS >= 4000, "有命令超时与重项缓存 TTL");
  has(PROBE_SRC, "{ windowsHide: true", "子进程一律 windowsHide（探读数不许闪黑窗）");
  ok(
    (PROBE_SRC.match(/windowsHide: true/g) || []).length >= 1 && !/shell: true/.test(PROBE_SRC),
    "不经过 shell（避免多一层窗口与转义问题）",
  );
  has(PROBE_SRC, '["-NoProfile", "-NonInteractive", "-Command"', "PowerShell 走 -NoProfile -NonInteractive");
}

/* ═══════════════ [4] 桥 / 主进程接线 / 打包白名单 ═══════════════ */
section("4] 宿主桥与打包白名单");
{
  ["perfStatics", "perfSample", "perfSystem", "perfPorts"].forEach((m) => {
    has(PRELOAD, m + ": (", "preload 暴露 " + m);
  });
  ["perf:statics", "perf:sample", "perf:system", "perf:ports"].forEach((ch) => {
    ok(
      PROBE_SRC.indexOf('ipcMain.handle("' + ch + '"') >= 0 ||
        PROBE_SRC.indexOf('ipcMain.handle(\n    "' + ch + '"') >= 0,
      "注册 IPC " + ch,
    );
  });
  has(MAIN, 'require("./perf-probe.js")', "main.js require 探针模块");
  has(MAIN, "perfProbe.registerPerfIpc({", "main.js 接线探针 IPC");
  has(MAIN, "getBackendPorts: () => vramRelease.vramPorts()", "端口表取自各本地后端登记的 port");
  has(read("local-model-vram.js"), "function vramPorts()", "local-model-vram.js 提供 vramPorts()");
  has(read("local-model-vram.js"), "  vramPorts,", "vramPorts 已导出");
  has(BUILD, '"perf-probe.js"', "build.json 白名单含 perf-probe.js（漏了 = 打包后 Cannot find module）");
}

/* ═══════════════ [5] i18n：中英成对 ═══════════════ */
section("5] i18n 中英词条");
{
  const zh = [
    "性能总览",
    "正在采集系统读数…",
    "量不到",
    "采样中…",
    "物理内存",
    "每核占用",
    "利用率",
    "功耗",
    "风扇",
    "磁盘",
    "数据盘",
    "应用盘",
    "数据盘 / 应用盘",
    "磁盘读数：量不到",
    "查看数据目录占用明细…",
    "网卡读数：量不到",
    "本机 TCP 连接",
    "本地后端端口",
    "在监听",
    "未监听",
    "显存与本地模型",
  ];
  I18n.setLocale("en");
  const missing = zh.filter((k) => {
    const v = I18n.t(k);
    return !v || v === k || !/[A-Za-z]/.test(v);
  });
  ok(missing.length === 0, "本轮新词条都有英文译文（缺：" + (missing.join(" / ") || "无") + "）");
  ok(I18n.t("量不到") === "unavailable", "「量不到」= unavailable（读数取不到一律这句，不用假数字占位）");
  ok(I18n.t("性能") === "Performance", "「性能」= Performance（沿用文件里已有的那条）");
  I18n.setLocale("zh");
  ok(I18n.t("性能") === "性能", "中文档回显键本身");
  /* 撞键纪律：本轮不重复登记别处已有的词条 */
  const at = I18N_SRC.indexOf("系统资源面板（顶栏「性能」按钮");
  const block = I18N_SRC.slice(at, I18N_SRC.indexOf("});", I18N_SRC.indexOf("Object.assign(EN, {", at)));
  const dupKeys = ["性能", "已用 ", "剩余 ", "核心", "显存 ", "温度", "数据目录", "应用目录", "网络"].filter(
    (k) => block.indexOf('"' + k + '":') >= 0,
  );
  ok(dupKeys.length === 0, "本块不重复登记别处已有的词条（重复会悄悄覆盖前一条；重复项：" + (dupKeys.join(" / ") || "无") + "）");
}

/* ═══════════════ [6] CSS ═══════════════ */
section("6] 样式：按钮专属色 + 面板版式");
{
  [".perf-panel", ".perf-card", ".perf-bar", ".perf-core", ".perf-rows", ".perf-row", ".vram-slot"].forEach((sel) => {
    has(PERF_CSS, sel, "perf.css 有 " + sel);
  });
  has(read("renderer/style.css"), '@import url("./css/perf.css")', "style.css 引入 perf.css");
  ok(/body\.theme-light \.perf-bar-track/.test(PERF_CSS), "亮色主题有覆盖（不用写死深色底）");
  /* [d] 本轮新增的三只分组壳（只做版式，不加配色）+ 每核柱子的高度基准 */
  has(PERF_CSS, ".perf-pairs,", "perf.css 有 .perf-pairs 分组壳（总览四条）");
  has(PERF_CSS, ".perf-ifaces {", "perf.css 有 .perf-ifaces 分组壳（网卡行）");
  has(PERF_CSS, ".perf-gpu-one", "perf.css 有 .perf-gpu-one 分组壳（每张显卡一组）");
  /* 每核柱子的高度从「格子的固定高」里算：格子 align-items:flex-end（子项不被拉伸），
     柱子的内联 height:% 必须自己撑满格子宽度对应的那点高度 —— 少了这条就是 0 高的空柱 */
  const coreFill = PERF_CSS.slice(PERF_CSS.indexOf(".perf-core i {"), PERF_CSS.indexOf("}", PERF_CSS.indexOf(".perf-core i {")));
  ok(/height:\s*100%/.test(coreFill), "每核填充柱自己有高度基准（height:100% 在 .perf-core i 上）");
  ok(
    /\.perf-core \{[^}]*height:\s*32px/.test(PERF_CSS),
    "每核格子本身是固定高 32px（百分比高度的基准）",
  );
}

/* ═══════════════ [7] 面板在假 DOM 上真跑：结构 / 假读数渲染 / 关闭即停表 / 增量不翻建 ═══════════════
   假 DOM 的口径（本轮升级）：**能真挂子节点、能按选择器找到活元素、能读写 textContent /
   style / classList / dataset / innerHTML** —— 面板改成「骨架 + keyed 补丁」之后，它每 tick 走的是
   createElement / appendChild / textContent 这条路，只支持 innerHTML 字符串比对的旧假体根本量不到。
   断言一律读**活元素树**（snapshot(el) 只是把树序列化成 HTML 供既有断言继续用），不再记账字符串。 */
section("7] app-perf.js 在假 DOM 上真跑：面板结构 / 假读数渲染 / 关闭即停表 / 增量不翻建");
{
  const vm = require("vm");
  const VOID = new Set(["br", "img", "input", "hr", "meta", "link", "source", "path", "circle", "rect"]);
  const ATTRE = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-\w:.]*)\s*=\s*'([^']*)'/g;

  /** 建一只假元素：真挂父子、真记属性；没有 textContent 的属性访问器，值就是属性的值 */
  function makeEl(tag, attrs) {
    const el = {
      tag: String(tag || "div").toLowerCase(),
      id: (attrs && attrs.id) || "",
      className: (attrs && attrs.class) || "",
      attrs: attrs || {},
      style: {},
      dataset: {},
      children: [],
      parent: null,
      onClick: null,
      ons: {}, /* 事件名 → 挂载次数（onclick 重复挂载正是要盯的点） */
      textContent: "",
      __isText: String(tag || "") === "#text",
    };
    el.classList = {
      add(c) {
        const set = String(el.className).split(/\s+/).filter(Boolean);
        if (set.indexOf(c) < 0) set.push(c);
        el.className = set.join(" ");
      },
      remove(c) {
        el.className = String(el.className)
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(" ");
      },
      contains(c) {
        return String(el.className).split(/\s+/).indexOf(c) >= 0;
      },
      toggle(c, on) {
        if (on === false) this.remove(c);
        else this.add(c);
      },
    };
    Object.defineProperty(el, "innerHTML", {
      get() {
        return el.__kidsOnly ? el.children.map(snapshot).join("") : "";
      },
      set(v) {
        const s = String(v == null ? "" : v);
        for (const c of el.children) c.parent = null;
        el.children = [];
        /* 真 DOM 写 innerHTML = 解析成节点树：这里就照做，后面按选择器找得到这些活元素 */
        for (const c of parseFragment(s, el)) el.children.push(c);
        el.__wroteInnerHTML = s;
        el.__kidsOnly = true;
        el.textContent = "";
      },
    });
    el.appendChild = (c) => {
      c.parent = el;
      el.children.push(c);
      return c;
    };
    el.removeChild = (c) => {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      return c;
    };
    el.querySelector = (sel) => findOne(el, sel, true);
    el.querySelectorAll = (sel) => findAll(el, sel, true);
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : el.dataset[k.replace(/^data-/, "")] != null ? el.dataset[k.replace(/^data-/, "")] : null);
    el.setAttribute = (k, v) => {
      el.attrs[k] = String(v);
    };
    Object.defineProperty(el, "onclick", {
      get() {
        return el.onClick;
      },
      set(f) {
        el.ons.click = (el.ons.click || 0) + 1;
        el.onClick = f;
      },
    });
    return el;
  }

  function parseFragment(html, parent) {
    const out = [];
    const stack = [];
    let i = 0;
    const top = () => (stack.length ? stack[stack.length - 1] : null);
    const push = (node) => {
      const p = top();
      node.parent = p || parent;
      if (p) p.children.push(node);
      else out.push(node);
    };
    const unesc = (s) =>
      String(s).replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[k] || m);
    while (i < html.length) {
      if (html[i] === "<") {
        const end = html.indexOf(">", i);
        if (end < 0) break;
        const raw = html.slice(i + 1, end);
        i = end + 1;
        if (raw[0] === "/") {
          stack.pop();
          continue;
        }
        const selfClose = raw.endsWith("/");
        const m = /^([a-zA-Z][\w-]*)([\s\S]*)$/.exec(selfClose ? raw.slice(0, -1) : raw);
        if (!m) continue;
        const tag = m[1].toLowerCase();
        const attrs = {};
        let a;
        ATTRE.lastIndex = 0;
        while ((a = ATTRE.exec(m[2]))) attrs[(a[1] || a[3]).toLowerCase()] = unesc(a[2] != null ? a[2] : a[4]);
        const el = makeEl(tag, attrs);
        push(el);
        if (!selfClose && !VOID.has(tag)) stack.push(el);
        continue;
      }
      const nxt = html.indexOf("<", i);
      const text = html.slice(i, nxt < 0 ? html.length : nxt);
      i = nxt < 0 ? html.length : nxt;
      if (text.trim()) {
        const t = makeEl("#text");
        t.textContent = unesc(text);
        push(t);
      }
    }
    return out;
  }

  /** 序列化：既有断言读的都是「面板写出来的 HTML」，这里从活元素树现算，不再记账字符串 */
  function snapshot(el) {
    if (!el) return "";
    if (el.__isText) return el.textContent;
    const attrs = [];
    const id = el.id || el.attrs.id;
    const cls = String(el.className || el.attrs.class || "").trim();
    if (id) attrs.push('id="' + id + '"');
    if (cls) attrs.push('class="' + cls + '"');
    const dk = el.dataset.k != null ? el.dataset.k : el.attrs["data-k"];
    if (dk != null && dk !== "" && cls !== "vram-slot") attrs.push('data-k="' + dk + '"');
    if (el.attrs.title && el.title == null) attrs.push('title="' + el.attrs.title + '"');
    else if (el.title) attrs.push('title="' + el.title + '"');
    if (el.style && Object.keys(el.style).length) {
      attrs.push(
        'style="' +
          Object.keys(el.style)
            .map((k) => k + ":" + el.style[k])
            .join(";") +
          '"',
      );
    }
    const tag = el.tag;
    const inner = el.__isText ? "" : el.children.length ? el.children.map(snapshot).join("") : el.textContent || "";
    if (VOID.has(tag)) return "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">";
    return "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">" + inner + "</" + tag + ">";
  }

  /* ── 选择器：只支持 .class / #id / tag 三样本事（面板用的就这三样） ── */
  const matchesSel = (el, sel) => {
    const s = String(sel).trim();
    if (!s || el.__isText) return false;
    if (s[0] === ".") return String(el.className).split(/\s+/).indexOf(s.slice(1)) >= 0;
    if (s[0] === "#") return (el.id || el.attrs.id) === s.slice(1);
    return el.tag === s.toLowerCase();
  };
  function findOne(root, sel, skipSelf) {
    if (!skipSelf && matchesSel(root, sel)) return root;
    for (const c of root.children) {
      const hit = findOne(c, sel, false);
      if (hit) return hit;
    }
    return null;
  }
  function findAll(root, sel, skipSelf) {
    const out = [];
    const walk = (el, first) => {
      if (!(first && skipSelf) && matchesSel(el, sel)) out.push(el);
      for (const c of el.children) walk(c, false);
    };
    walk(root, true);
    return out;
  }
  const idIndex = (root) => {
    const map = new Map();
    const walk = (el) => {
      const id = el.id || el.attrs.id;
      if (id && !map.has(id)) map.set(id, el);
      for (const c of el.children) walk(c);
    };
    walk(root);
    return map;
  };

  /* ── 文档外壳（与 renderer/index.html 同结构） ── */
  const docRoot = makeEl("#document");
  const htmlRoot = makeEl("html");
  const bodyRoot = makeEl("body");
  docRoot.appendChild(htmlRoot);
  htmlRoot.appendChild(bodyRoot);
  const overlayEl = makeEl("div", { id: "overlay" });
  overlayEl.style.display = "none";
  bodyRoot.appendChild(overlayEl);
  const boxEl = makeEl("div", { class: "overlay-box" });
  overlayEl.appendChild(boxEl);
  const ovBody = makeEl("div", { class: "overlay-body", id: "ovBody" });
  const ovFoot = makeEl("div", { class: "overlay-foot", id: "ovFoot" });
  boxEl.appendChild(ovBody);
  boxEl.appendChild(ovFoot);
  /* .perf-data / .vram-slot 都是面板骨架里的活元素：按选择器现取，断言直接读它们 */
  const dataHost = () => ovBody.querySelector(".perf-data");
  const vramHost = () => ovBody.querySelector(".vram-slot");
  const HTMLofBody = () => snapshot(ovBody);
  let ovTitle = "";

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    Boolean,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    document: {
      getElementById: (id) => idIndex(docRoot).get(String(id)) || null,
      createElement: (tag) => makeEl(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    I18n: { t: (k, vars) => I18n.t(k, vars) },
    window: {},
  };
  sandbox.window = sandbox;

  /* 假读数：面板只吃结构，不看数值从哪来 */
  const CALLS = [];
  sandbox.window.api = {
    perfStatics: () => {
      CALLS.push("statics");
      return Promise.resolve({ ok: true, cores: 24, cpuModel: "Intel(R) Core(TM) i9-14900KF", dataDir: "C:\\d" });
    },
    perfSample: () => {
      CALLS.push("sample");
      return Promise.resolve({
        ok: true,
        at: Date.now(),
        cpu: { overall: 21.1, cores: [40, 0, 67, 0], count: 4, model: "Intel(R) Core(TM) i9-14900KF" },
        mem: { totalBytes: 64e9, freeBytes: 40e9, usedBytes: 24e9, usedPct: 37.5 },
        gpu: {
          available: true,
          reason: "",
          cards: [{ name: "NVIDIA GeForce RTX 4090", utilPct: 62, usedMb: 2693, totalMb: 24564, memPct: 11, tempC: 50, powerW: 52.05, fanPct: 0 }],
        },
      });
    },
    perfSystem: () => {
      CALLS.push("system");
      return Promise.resolve({
        ok: true,
        at: Date.now(),
        dataDir: "C:\\d",
        appDir: "E:\\a",
        volumes: [
          { letter: "C:", freeBytes: 116e9, usedBytes: 585e9, totalBytes: 701e9, freePct: 16.6, role: "data" },
          { letter: "E:", freeBytes: 264e9, usedBytes: 1080e9, totalBytes: 1344e9, freePct: 19.7, role: "app" },
        ],
        net: {
          ifaces: [
            { name: "以太网 3", desc: "Realtek", status: "Up", linkSpeed: "2.5 Gbps", up: true, wireless: false },
            { name: "WLAN", desc: "Intel", status: "Disconnected", linkSpeed: "1 Gbps", up: false, wireless: true },
          ],
          rates: [{ name: "以太网 3", rx: 38e9, tx: 15e9, rxRate: 4096, txRate: 1024 }],
        },
        conns: { established: 91, listening: 66, timeWait: 55, other: 17, total: 229 },
        ports: [{ port: 8188, listening: true }, { port: 11434, listening: false }],
      });
    },
    perfPorts: () => Promise.resolve({ ok: true, ports: [] }),
    vramSnapshot: () =>
      Promise.resolve({
        ok: true,
        gpu: { name: "NVIDIA GeForce RTX 4090", usedMb: 2693, totalMb: 24564 },
        backends: [{ id: "h3", label: "H3（ComfyUI 视频）", port: 8188, running: true, busy: false, idleReleasable: true }],
        log: ["[2026-01-01T00:00:00Z] [vram] 完成 H3：动作=soft"],
      }),
    vramRelease: () => Promise.resolve({ ok: true, steps: [] }),
    onVramReleased: () => () => {},
  };
  /* app-vram.js 的渲染函数：真跑（面板里显存区块就是它画的） */
  vm.createContext(sandbox);
  vm.runInContext(VRAM, sandbox, { filename: "app-vram.js" });
  vm.runInContext(PERF, sandbox, { filename: "app-perf.js" });

  /* openOverlay 假体：与真实现同一语义（清空 body / foot、显示蒙层、记标题） */
  sandbox.openOverlay = (title) => {
    ovTitle = String(title);
    ovBody.innerHTML = "";
    ovFoot.innerHTML = "";
    overlayEl.style.display = "flex";
  };
  sandbox.closeOverlay = () => {
    overlayEl.style.display = "none";
  };
  sandbox.toast = () => {};
  sandbox.openSettings = (o) => {
    sandbox.__settingsArg = o;
  };
  sandbox.escapeHtml = (s) => String(s == null ? "" : s);
  /* 面板里的 async 刷新出错时不许静默：接住并打出来（真窗口里会走 unhandledRejection 控制台） */
  process.on("unhandledRejection", (e) => {
    console.log("  [debug] unhandledRejection:", (e && e.stack) || e);
    console.log("  [debug] body=" + JSON.stringify(HTMLofBody().slice(0, 240)));
  });
  ok(typeof sandbox.vramRenderPanel === "function", "app-vram.js 的 vramRenderPanel 也在沙箱里（面板要调它）");
  ok(typeof sandbox.perfTick === "function", "perfTick 是全局函数");
  ok(typeof sandbox.perfPanelOpen === "function", "perfPanelOpen 是全局函数");
  ok(typeof sandbox.openPerfPanel === "function", "openPerfPanel 是全局函数（app-boot.js 绑得到）");

  const waitFor = (fn, ms) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const step = () => {
        if (fn()) return resolve(true);
        if (Date.now() - t0 > (ms || 3000)) return reject(new Error("等超时"));
        setTimeout(step, 20);
      };
      step();
    });

  /* 记 tick 前后的活节点：增量渲染的判据就是「上一帧的节点这一帧还在不在」 */
  const liveNodes = () => {
    const out = [];
    const walk = (el) => {
      if (el.__isText) return;
      out.push(el);
      for (const c of el.children) walk(c);
    };
    walk(ovBody);
    return out;
  };
  const tickWithSurvivors = async (force) => {
    const before = new Set(liveNodes());
    await sandbox.perfTick(force === undefined ? false : force);
    await new Promise((r) => setTimeout(r, 10));
    const after = new Set(liveNodes());
    let survivors = 0;
    for (const n of before) if (after.has(n)) survivors++;
    return { before: before.size, survivors, after: after.size };
  };

  sandbox.openPerfPanel();
  ok(ovTitle === "性能", "面板标题 = 性能（得到「" + ovTitle + "」）");
  ok(overlayEl.style.display === "flex" && /class="perf-panel"/.test(HTMLofBody()), "面板正文含 .perf-panel");
  ok(ovFoot.children.length === 2, "窗底两颗按钮（刷新 / 关闭）");
  ok(sandbox.perfPanelOpen() === true, "perfPanelOpen() 认得出面板开着");
  ok(!!ovBody.querySelector(".perf-data"), "面板开着这一刻 .perf-data 找得到");

  /* openPerfPanel 自己会踢一轮刷新（异步：轻量 + 慢项 + 显存区块各一次）——等它全部落地，
     不再另发一轮（perfState.busy 会把并发那轮挡掉，这正是要钉的行为）。 */
  waitFor(() => !!ovBody.querySelector(".perf-card"))
    .then(() => waitFor(() => !!ovBody.querySelector(".vram-row"), 6000))
    .then(async () => {
    const dataEl = dataHost();
    const html = snapshot(dataEl);
    ok(CALLS.filter((c) => c === "sample").length >= 1 && CALLS.indexOf("system") >= 0, "拉过 perf:sample 与 perf:system");
    ok(/class="perf-card"/.test(html), "画出了卡片");
    ok(html.indexOf("性能总览") >= 0, "有「性能总览」");
    ok(html.indexOf("显存与本地模型") >= 0 && /class="vram-slot"/.test(html), "有「显存与本地模型」区块与 .vram-slot");
    ok(html.indexOf("CPU") >= 0 && html.indexOf("内存") >= 0 && html.indexOf("GPU（显卡）") >= 0, "有 CPU / 内存 / GPU 卡片");
    ok(html.indexOf("磁盘") >= 0 && html.indexOf("网络") >= 0, "有磁盘与网络卡片");
    ok(/class="perf-bar /.test(html) && /class="perf-core /.test(html), "占用条与每核格子都画了");
    /* 每核柱子的高度必须落在柱子上（i 的内联 height）：落错地方 = 面板上是一排空格子 */
    const firstCore = ovBody.querySelector(".perf-core");
    const coreFillEl = firstCore ? firstCore.querySelector("i") : null;
    ok(
      !!coreFillEl && /%$/.test(String(coreFillEl.style.height || "")),
      "每核柱子的内联高度落在 i 上（" + (coreFillEl ? coreFillEl.style.height : "缺节点") + "）",
    );
    ok(html.indexOf("NVIDIA GeForce RTX 4090") >= 0, "GPU 卡片带卡名");
    ok(html.indexOf("62%") >= 0, "GPU 利用率读数上屏");
    ok(html.indexOf("°C") >= 0 && html.indexOf(" W") >= 0, "温度与功耗读数上屏");
    ok(html.indexOf("C:") >= 0 && html.indexOf("E:") >= 0, "数据盘与应用盘都列了");
    if (process.env.PERF_DEBUG) {
      const at = html.indexOf("磁盘");
      console.log("  [debug] 磁盘段=" + JSON.stringify(html.slice(at, at + 420)));
    }
    ok(html.indexOf("空闲 ") >= 0 && /GB/.test(html), "剩余空间按 GB 显示（116e9 → GB 量级）");
    ok(html.indexOf("以太网 3") >= 0 && html.indexOf("KB/s") >= 0, "网卡行带实时速率");
    ok(html.indexOf("229") >= 0, "本机 TCP 连接数上屏");
    ok(html.indexOf(":8188") >= 0 && html.indexOf("在监听") >= 0, "后端端口监听状态上屏");
    ok(!/undefined|NaN/.test(html), "渲染结果里没有 undefined / NaN");
    const slotEl = vramHost();
    ok(snapshot(slotEl).indexOf("H3（ComfyUI 视频）") >= 0, "显存区块（app-vram.js 真跑）也渲染进了 .vram-slot");
    ok(/class="vram-row/.test(ovBody.innerHTML ? snapshot(slotEl) : ""), "显存区块是真节点挂进槽里的（不是整块 innerHTML 冲页面）");
    ok(snapshot(ovBody).indexOf('class="vram-slot"') >= 0, "面板正文里性能卡片与显存槽都在（没被冲掉）");
    /* 显存区块写在槽里而不是整只 #ovBody / .perf-data：否则会把性能面板整页冲掉。
       （.vram-slot 现在是面板骨架的一部分，所以「正文里没有 vram 内容」的判据要按槽的归属来写：
        显存内容只出现在槽里、槽只挂在「显存与本地模型」那张卡上，别处一处都没有。） */
    ok(
      ovBody.querySelectorAll(".vram-slot").length === 1 &&
        slotEl.parent === ovBody.querySelector(".perf-vram-card"),
      "显存槽只有一只，且只挂在「显存与本地模型」那张卡上（没有第二处落点）",
    );
    ok(
      snapshot(dataEl.querySelector(".vram-slot")) === snapshot(ovBody.querySelector(".vram-slot")) &&
        snapshot(dataEl).split("vram-panel").length === 2,
      "显存内容只出现在这一个槽里（面板正文里没有第二份）",
    );
    ok(
      dataEl.children.length === 7 && ovBody.querySelectorAll(".perf-card").length === 7,
      "面板被显存内容冲掉了吗：没有 —— .perf-data 下 7 张卡都在（" + dataEl.children.length + " 张）",
    );
    ok(slotEl.children.length >= 1, "槽里挂的是真子节点（app-vram.js 的 .vram-panel）");

    /* ── 增量渲染：读数不变的空转 tick 一个节点都不许换 ── */
    const dataBefore = dataHost();
    const cardCount = ovBody.querySelectorAll(".perf-card").length;
    const idle = await tickWithSurvivors(false);
    ok(idle.survivors === idle.before && idle.before > 0, "空转 tick 上一帧节点全存活（" + idle.survivors + "/" + idle.before + "，一个都没被换掉）");
    ok(dataHost() === dataBefore, "空转 tick 后 .perf-data 还是同一只宿主（没有整段重建）");
    ok(ovBody.querySelectorAll(".perf-card").length === cardCount, "空转 tick 后卡片数不变（" + cardCount + " 张）");
    ok(ovBody.querySelector("#perfStorageDetail").ons.click === 1, "明细按钮的 onclick 只挂了一次（不随 tick 重挂）");
    /* 拿不到新读数那一轮不该再写一次「读数更新于 …」：把时间戳钉住，空转两轮后必须一字不变 */
    const noteEl = ovBody.querySelector(".perf-foot");
    const noteBefore = noteEl ? noteEl.textContent : "";
    ok(/读数更新于/.test(noteBefore), "面板有一行读数更新时间");
    await tickWithSurvivors(false);
    const noteAfter = (ovBody.querySelector(".perf-foot") || {}).textContent || "";
    ok(noteAfter === noteBefore, "没有新读数的 tick 不改时间戳（原文一字不变）");

    /* 关闭面板 = 停表：再 tick 不再拉读数 */
    overlayEl.style.display = "none";
    const before = CALLS.length;
    await sandbox.perfTick(false);
    ok(CALLS.length === before, "面板关掉后 perfTick 不再拉读数");
    ok(sandbox.perfPanelOpen() === false, "perfPanelOpen() 认得出面板关了");

    /* 读数拿不到时的兜底：GPU 不可用 + 卷读不到 → 面板写「量不到」而不是假数字 */
    sandbox.window.api.perfSample = () =>
      Promise.resolve({
        ok: true,
        cpu: { overall: null, cores: [], count: 4, model: "" },
        mem: { totalBytes: 64e9, freeBytes: 40e9, usedBytes: 24e9, usedPct: 37.5 },
        gpu: { available: false, reason: "nvidia-smi 不可用", cards: [] },
      });
    sandbox.window.api.perfSystem = () =>
      Promise.resolve({ ok: true, volumes: [], net: { ifaces: [], rates: [] }, conns: null, ports: [] });
    /* 重开面板：换窗 = 旧节点作废，下一轮重新建骨架（这条路径也要覆盖） */
    sandbox.openPerfPanel();
    await sandbox.perfTick(true);
    await new Promise((r) => setTimeout(r, 10));
    const h2 = snapshot(dataHost());
    ok(h2.indexOf("量不到") >= 0, "拿不到读数时写「量不到」（没有假数字）");
    ok(h2.indexOf("显卡读数：量不到") >= 0, "无 N 卡时如实写「显卡读数：量不到」");
    ok(h2.indexOf("磁盘读数：量不到") >= 0, "卷读不到时如实写出来");
    ok(!/NaN/.test(h2), "兜底路径也没有 NaN");
    overlayEl.style.display = "none";
    return runRealSampling();
  }).catch((e) => {
    fails++;
    checks++;
    console.log("FAIL  [7] 段异步断言挂掉：" + ((e && e.stack) || e));
  });
}

/* ═══════════════ [8] 真采样（真机能力探测，结构不对才算失败） ═══════════════ */
async function runRealSampling() {
  section("8] 真采样一次（结构 + 缓存 TTL）");
  const dataDir = process.env.APPDATA
    ? path.join(process.env.APPDATA, "pipeline-console")
    : path.join(__dirname, "..");
  const appDir = path.join(__dirname, "..");
  const s1 = await probe.sample();
  ok(!!s1 && s1.ok === true, "perf:sample 有回执");
  ok(!!s1.mem && s1.mem.totalBytes > 0 && s1.mem.usedPct > 0, "内存读数：总量与占用率");
  ok(Array.isArray(s1.cpu.cores), "CPU 读数带每核数组");
  ok(!!s1.gpu && typeof s1.gpu.available === "boolean", "GPU 读数带 available 标志");
  if (s1.gpu.available) {
    ok(s1.gpu.cards.length >= 1 && s1.gpu.cards[0].totalMb > 0, "有 N 卡时给出显存总量");
  } else {
    ok(!!s1.gpu.reason, "无 N 卡 / 无 nvidia-smi 时给一句原因（面板原样写「量不到」）");
  }
  const t1 = Date.now();
  const y1 = await probe.system({ dataDir, appDir, ports: [] });
  const cold = Date.now() - t1;
  ok(!!y1 && y1.ok === true && Array.isArray(y1.volumes), "perf:system 有回执与卷列表");
  ok(y1.volumes.every((v) => v.totalBytes > 0 && v.freeBytes >= 0), "卷读数字段自洽（剩余 ≤ 总量由实现保证）");
  ok(!!y1.net && Array.isArray(y1.net.ifaces), "网卡名单");
  ok(y1.conns == null || y1.conns.total >= 0, "TCP 连接数（netstat 拿不到时为 null）");
  const t2 = Date.now();
  const y2 = await probe.system({ dataDir, appDir, ports: [] });
  const warm = Date.now() - t2;
  ok(warm < Math.max(80, cold / 2), "TTL 内第二次调用走缓存（冷 " + cold + "ms → 热 " + warm + "ms）：面板 5s 档不会重复拉起 PowerShell");
  ok(typeof y2.at === "number" && y2.at >= y1.at, "缓存命中时 at 仍更新为本次时刻");
  const st = await probe.statics({ dataDir, appDir });
  ok(!!st && st.ok === true && st.cores > 0, "perf:statics：核心数");
  ok(st.dataDir === dataDir, "perf:statics 回带数据目录（面板显示用）");

  console.log(
    fails
      ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-perf)\n"
      : "\n✓ 全部 " + checks + " 项通过  (smoke-perf)\n",
  );
  process.exit(fails ? 1 : 0);
}

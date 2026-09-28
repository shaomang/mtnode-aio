"use strict";
/* 设置里的「提供商配置」改版回归（纯 Node，自带最小 DOM 影子）
 *   node test/smoke-provider-settings.js
 * 需求：提供商配置放到设置最前面；服务商以两列网格展示、每格只显示标题（名称），
 *       点某格弹出该服务商的具体配置对话框；网络 / 日志等很少用的小节沉到最下方。
 * 覆盖：
 *   [1] 设置小节顺序：提供商配置第一块（settings-sec-lead），很少用的小节在最后
 *   [2] 网格：两列（.prov-tiles）+ 每格只放名称（.prov-tile 内只有一个名字文本）
 *   [3] 点击网格 → 弹出 #provCfgDlg（.mt-dialog，persistent：无「点外部即关」监听），
 *       正文恰好一张服务商配置卡、底部「完成」可关窗
 *   [4] 已被删除的服务商再打开 → 立即收起，不把自己显示回来
 *   [5] 「＋ 添加服务商」子对话框取消后回设置页（#overlay 独一份，不能把设置窗带走）
 *   [6] DeepSeek 无 Key（新安装默认）→ 提供商配置上方给出官方充值通道
 *       https://platform.deepseek.com/ ；填了 Key 即回刷收起
 *   （默认服务商播种清单 flash+pro / 默认勾选视觉 → test/smoke-default-provider.js）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

/* ── 最小 DOM 影子（只够跑设置正文构建与配置对话框） ── */
function makeDom() {
  const ids = new Map();
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.style = {};
      this.dataset = {};
      this._cls = new Set();
      this._attrs = {};
      this._text = "";
      this._html = "";
    }
    set id(v) {
      this._id = String(v);
      ids.set(this._id, this);
    }
    get id() {
      return this._id || "";
    }
    get classList() {
      const s = this._cls;
      return {
        add: (...c) => c.forEach((x) => s.add(x)),
        remove: (...c) => c.forEach((x) => s.delete(x)),
        contains: (c) => s.has(c),
        toggle: (c, f) => {
          const want = f === undefined ? !s.has(c) : !!f;
          if (want) s.add(c);
          else s.delete(c);
        },
      };
    }
    set className(v) {
      this._cls = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    get className() {
      return [...this._cls].join(" ");
    }
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      return c;
    }
    append(...cs) {
      cs.forEach((c) => this.appendChild(c));
    }
    addEventListener() {}
    removeEventListener() {}
    set innerHTML(v) {
      this._html = String(v);
      this.children = [];
      for (const m of this._html.matchAll(/id="([^"]+)"/g)) {
        const e = new El("div");
        e.id = m[1];
        this.children.push(e);
      }
    }
    get innerHTML() {
      return this._html;
    }
    set textContent(v) {
      this._text = String(v);
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join("");
    }
    setAttribute(k, v) {
      this._attrs[k] = v;
      if (k === "id") this.id = v;
    }
    getAttribute(k) {
      return this._attrs[k];
    }
    querySelector(sel) {
      if (sel && sel[0] === "#") {
        const id = sel.slice(1);
        if (this.id === id) return this;
        return this.children.find((c) => c.id === id) || ids.get(id) || null;
      }
      return null;
    }
    querySelectorAll() {
      return [];
    }
    focus() {}
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    closest() {
      return null;
    }
  }
  const document = {
    body: new El("body"),
    createElement: (t) => new El(t),
    createTextNode: (t) => {
      const e = new El("#text");
      e._text = String(t);
      return e;
    },
    getElementById: (id) => ids.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return { document, El };
}

const { document } = makeDom();
const ovBody = document.createElement("div");
ovBody.id = "ovBody";
const ovFoot = document.createElement("div");
ovFoot.id = "ovFoot";

const providers = [
  /* 新安装默认那一条：官方 DeepSeek、Key 为空 → 「提供商配置」上方应出现官方充值通道 */
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "text_openai",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    vision: true,
  },
  {
    id: "p1",
    name: "Alpha",
    type: "text_openai",
    baseUrl: "https://a/v1",
    apiKey: "k",
    models: ["m1", "m2"],
    vision: true,
  },
  { id: "p2", name: "Beta", type: "image_openai", baseUrl: "https://b/v1", apiKey: "", models: [] },
];

const sandbox = {
  console,
  document,
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  window: { addEventListener() {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  I18n: { t: (s) => s },
  S: {
    config: {
      snap: 24,
      theme: "dsh",
      netPort: 40999,
      providers,
      dsh: {
        chatEnter: "send",
        model: "",
        preset: "standard",
        permissionPreset: "mtnode-unattended",
        doneSound: true,
        askSound: true,
        theme: "dsh",
      },
    },
  },
  PROVIDER_TYPE_LABELS: [
    ["text_openai", "文本（OpenAI 兼容）"],
    ["image_openai", "图像（OpenAI 兼容）"],
  ],
  THEMES: { dsh: { name: "DSH" } },
  AGENT_PRESETS: [{ id: "standard", settingsLabelKey: "标准" }],
  AGENT_PRESET_DEFAULT: "standard",
  NET_DEFAULT_PORT: 40999,
  $: (sel) => (sel === "#ovBody" ? ovBody : sel === "#ovFoot" ? ovFoot : null),
  overlayPersistent: false,
  overlayKind: "",
  openOverlay: () => {},
  closeOverlay: () => {},
  validateProviderApiKey: () => {},
  dshProvider: () => null,
  mtnodePiProviders: () => [],
  preferredAgentProviderRoute: () => "",
  preferredAgentModelForRoute: () => "",
  permissionPresetOptions: () => [["mtnode-unattended", "无人值守"]],
  setAutoRunDownstream: () => {},
  previewDoneSound: () => {},
  playDoneSoundFile: () => {},
  builtinIxBeep: () => {},
  EXT_UI: {},
  refreshExtInventory: () => {},
  openExtManagerDialog: () => {},
  closeExtManagerDialog: () => {},
  openStoreDialog: () => {},
  toast: () => {},
  confirmDialog: () => Promise.resolve(false),
  renderCanvas: () => {},
  renderStatus: () => {},
  paintApprovalsBtn: () => {},
};
vm.createContext(sandbox);
/* 模型形态识别（文本 / 图像生成）取真源：服务商卡片的「形态」行与模型徽标都用它，
   桩掉会把「点开服务商卡片」直接抛错（见 renderer/app-model-kind.js） */
vm.runInContext(read("renderer/app-model-kind.js"), sandbox);
vm.runInContext(read("renderer/app-settings.js"), sandbox);
const run = (code) => vm.runInContext(code, sandbox);

console.log("\n[1] 设置小节顺序：提供商配置最前，很少用的小节沉底");
run("openSettingsBody()");
const secs = ovBody.children.filter((c) => c.className.indexOf("settings-sec") === 0);
const titleOf = (sec) => {
  const t = sec.children.find((c) => c.className.indexOf("settings-sec-title") === 0);
  return t ? t.textContent : "";
};
const titles = secs.map(titleOf);
ok(
  ovBody.children[0] === secs[0] && secs[0].className.indexOf("settings-sec-lead") >= 0,
  "提供商配置是设置正文的第一块（settings-sec-lead）：「" + titles[0] + "」",
);
ok(titles[0].indexOf("提供商配置") >= 0, "首块标题为「提供商配置」");
ok(
  titles[titles.length - 1].indexOf("手动更新（同版本号重装）") >= 0,
  "最后一块是手动更新（同版本号重装）—— 设置整页最底部",
);
ok(titles[titles.length - 2].indexOf("错误与崩溃日志") >= 0, "倒数第二块是错误与崩溃日志");
ok(titles[titles.length - 3].indexOf("网络") >= 0, "倒数第三块是网络");
ok(
  titles.indexOf("智能能力（DeepSeek Harness / dsh）") < titles.indexOf("配置数据目录"),
  "常用小节（智能能力）在很少用的小节之前",
);

console.log("\n[1b] DeepSeek 无 Key（新安装默认）→ 提供商配置上方给出官方充值通道");
const sectionOf = (cls) => ovBody.children.find((c) => c.className.indexOf(cls) >= 0);
const provSec = sectionOf("settings-sec-lead");
const gridIdx = provSec.children.findIndex(
  (c) => c.className.indexOf("prov-tiles") >= 0,
);
const slotIdx = provSec.children.findIndex(
  (c) => c.className.indexOf("ds-topup-slot") >= 0,
);
ok(slotIdx >= 0 && gridIdx > slotIdx, "充值横幅在服务商网格上方（标题行 → 横幅 → 网格）");
const slot = provSec.children[slotIdx];
ok(
  ovBody.children[0] === provSec,
  "横幅挂在提供商配置块内 → 设置正文仍然以「提供商配置」开场（不另起一节抢首位）",
);
const banner = slot.children[0];
ok(!!banner && banner.className.indexOf("ds-topup") >= 0, "槽内是真横幅（.ds-topup）");
const link = banner && banner.children[1];
ok(!!link && link.className.indexOf("ds-topup-link") >= 0, "横幅右侧是充值链接（.ds-topup-link）");
ok(
  link && link.href === "https://platform.deepseek.com/",
  "链接指向 DeepSeek 官方充值通道：" + (link && link.href),
);
ok(typeof (link && link.onclick) === "function", "点链接有处理器（走主进程 openExternal，不在应用内跳转）");
const settingsSrc = read("renderer/app-settings.js");
ok(
  /window\.api\.openExternal\(DEEPSEEK_TOPUP_URL\)/.test(settingsSrc),
  "点击走 window.api.openExternal（与作者弹窗外链同口径）",
);
ok(
  /if \(isDsOfficial\) repaintSettingsTopup\(\);/.test(settingsSrc),
  "服务商卡里的 Key 输入即时回刷横幅（清空 Key 横幅立刻回来，不必等关窗）",
);

console.log("\n[2] 两列网格：每格只显示标题（服务商名称）");
const grid = provSec.children[gridIdx];
ok(grid.className === "prov-tiles", "网格容器 .prov-tiles（CSS 两列 grid-template-columns: 1fr 1fr）");
ok(grid.children.length === 3, "三个服务商 → 三格");
const tile = grid.children[1]; /* 第 1 格是官方 DeepSeek，这里点 Alpha 那一格 */
ok(tile.tagName === "BUTTON", "每格是可点击按钮");
ok(tile.className.indexOf("prov-tile") === 0, "格类名 .prov-tile（首个优先项带 .pri）");
ok(tile.textContent === "Alpha", "格内只有标题文本：" + JSON.stringify(tile.textContent));
ok(typeof tile.onclick === "function", "格挂有「打开配置对话框」处理器");
const css = read("renderer/css/components.css");
ok(
  /\.prov-tiles\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(css),
  "components.css：.prov-tiles 是两列网格",
);

console.log("\n[3] 点击网格 → 弹出该服务商的具体配置对话框");
tile.onclick();
const host = run("document.getElementById('provCfgDlg')");
ok(!!host && host.className.indexOf("mt-dialog") >= 0, "宿主 #provCfgDlg 用 .mt-dialog（层级高于 #overlay）");
ok(host.classList.contains("on"), "对话框已显示");
ok(
  run("document.getElementById('provCfgTitle').textContent").indexOf("Alpha") >= 0,
  "标题含服务商名（具体配置对得上点的那一格）",
);
const cfgBody = run("document.getElementById('provCfgBody')");
ok(
  cfgBody.children.length === 1 &&
    cfgBody.children[0].className.indexOf("prov-card") >= 0,
  "正文恰好一张服务商配置卡（类型 / Base URL / API Key / 模型列表）",
);
const cfgFoot = run("document.getElementById('provCfgFoot')");
ok(
  cfgFoot.children.length === 1 && cfgFoot.children[0].textContent === "完成",
  "底部只有「完成」按钮（显式关闭出口）",
);
/* 服务商配置卡里也要贴一手中官方充值地址（点开卡片粘 Key 的那一刻就在手边） */
const deepseekProv = providers.find((p) => p.id === "deepseek");
run("closeProvCfgDlg()");
run("openProviderConfigDialog(S.config.providers.find((p) => p.id === 'deepseek'))");
const dsCard = run("document.getElementById('provCfgBody').children[0]");
const findIn = (node, pred, found) => {
  found = found || [];
  if (!node || !node.children) return found;
  for (const c of node.children) {
    if (pred(c)) found.push(c);
    findIn(c, pred, found);
  }
  return found;
};
const hints = findIn(
  dsCard,
  (c) => String(c.className || "").indexOf("ds-topup-hint") >= 0,
  [],
);
ok(hints.length === 1, "无 Key 的 DeepSeek 卡里恰好一行充值提示（.ds-topup-hint）");
const hintLink = hints.length
  ? findIn(hints[0], (c) => String(c.className || "").indexOf("ds-topup-link") >= 0, [])[0]
  : null;
ok(
  !!hintLink && hintLink.textContent === "https://platform.deepseek.com/",
  "卡里的链接正文就是官方充值地址",
);
deepseekProv.apiKey = "sk-test";
run("openProviderConfigDialog(S.config.providers.find((p) => p.id === 'deepseek'))");
const dsCard2 = run("document.getElementById('provCfgBody').children[0]");
ok(
  findIn(dsCard2, (c) => String(c.className || "").indexOf("ds-topup-hint") >= 0, [])
    .length === 0,
  "填了 Key 再打开卡片 → 充值提示行消失",
);
deepseekProv.apiKey = "";
run("closeProvCfgDlg()");
const src = read("renderer/app-settings.js");
const dlgSrc = src.slice(src.indexOf("function ensureProvCfgDlg"));
ok(
  dlgSrc.indexOf("ev.target ===") < 0 && dlgSrc.indexOf("ev.target ==") < 0,
  "配置对话框不挂「点外部 / 点蒙层即关」（persistent，关窗只走「完成」或 Esc）",
);
ok(
  /addEventListener\("keydown",\s*\(ev\)\s*=>\s*\{[\s\S]{0,120}Escape/.test(dlgSrc),
  "Esc 是显式关窗路径之一",
);

console.log("\n[4] 已被删除的服务商：打开即收起");
run("closeProvCfgDlg()");
ok(!host.classList.contains("on"), "「完成」/ closeProvCfgDlg 收窗");
sandbox.__ghost = { id: "px", name: "Ghost", type: "text_openai", models: [] };
run("openProviderConfigDialog(__ghost)");
ok(!host.classList.contains("on"), "不在 S.config.providers 里的服务商 → 立即收起，不显示空窗");

console.log("\n[5] 添加服务商子对话框：取消后回到设置页");
const addSrc = src.slice(src.indexOf("function addProviderDialog"), src.indexOf("function openStoreDialog"));
ok(
  /cancel\.onclick = \(\) => \{\s*closeOverlay\(\);\s*openSettings\(\);\s*\}/.test(addSrc),
  "「取消」= closeOverlay + openSettings（不让子对话框把整个设置窗带走）",
);
ok(
  /S\.config\.providers\.push\(prov\);\s*\/\*[^\n]*\*\/\s*settingsSaved\(0\);\s*closeOverlay\(\);\s*openSettings\(\);/.test(
    addSrc,
  ),
  "「添加」后先当场写盘再回设置页（设置窗已无「保存设置」，不写就等于没保存）",
);
ok(
  /for \(const a of added\) S\.config\.providers\.push\(a\);\s*\/\*[^\n]*\*\/\s*settingsSaved\(0\);/.test(
    addSrc,
  ),
  "目录添加（可能拆成文本 + 图像两条）同样当场写盘",
);

console.log("\n[6] 填了 Key（或把官方项删掉）→ 回刷即收起横幅；Key 清空 → 回来");
const ds = providers.find((p) => p.id === "deepseek");
run("repaintSettingsTopup()");
ok(!!slot.children[0], "默认（Key 为空）→ 显示");
ds.apiKey = "sk-test";
run("repaintSettingsTopup()");
ok(!slot.children[0], "填上 Key → 收起（deepseekTopupNeeded 返回 false）");
ds.apiKey = "";
run("repaintSettingsTopup()");
ok(!!slot.children[0], "清空 Key → 回来");
providers.splice(providers.indexOf(ds), 1);
run("repaintSettingsTopup()");
ok(!slot.children[0], "没有 DeepSeek 官方项 → 不显示（用户自己删过就不再提示）");
providers.unshift(ds);
const cssSrc = read("renderer/css/components.css");
ok(
  /\.ds-topup\s*\{[^}]*border-left:\s*3px solid var\(--cyan\)/.test(cssSrc),
  "components.css：.ds-topup 是醒目横幅（左侧青色竖条）",
);
ok(
  /\.ds-topup-link\s*\{[^}]*cursor:\s*pointer/.test(cssSrc),
  "components.css：.ds-topup-link 可点（手型）",
);
const i18nObj = require(path.join(__dirname, "..", "renderer", "i18n.js"));
i18nObj.setLocale("en");
for (const k of [
  "尚未填写 DeepSeek API Key",
  "首次使用请先在下方「提供商配置」里填入 Key；还没有余额可先到官方充值通道充值。",
  "DeepSeek 官方充值通道",
  "（在浏览器中打开）",
]) {
  ok(i18nObj.t(k) !== k, "i18n 英文词条齐备：" + k.slice(0, 16) + "…");
}

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"),
);
process.exit(fails ? 1 : 0);

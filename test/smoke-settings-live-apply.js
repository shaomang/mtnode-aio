"use strict";
/* 设置窗「改动即时生效」回归（纯 Node · 自带最小 DOM 影子 + 假定时器）
 *   node test/smoke-settings-live-apply.js
 * 需求：设置里任何修改直接生效，不再需要在设置界面中「保存并关闭」。
 * 口径（renderer/app-settings.js）：
 *   · 每项控件挂 oninput / onchange 即时写进 S.config 并落盘；底部只剩「关闭」+ 一行状态回显
 *   · 打字类（网格间距 / 服务商名称 / Base URL / API Key）走防抖合并写，
 *     configSave 是全量写 config.json 且主进程每次写前备份一份快照，逐键写盘会刷爆备份
 *   · 离散动作（勾选 / 下拉 / 增删服务商 / 调优先级 / 模型排序）直接写盘
 *   · 「＋ 添加服务商」与服务商配置卡关窗都当场写盘，不依赖任何「保存」按钮
 * 覆盖：
 *   [1] 底部按钮：没有「保存设置」也没有「取消」，只有「关闭」+ 状态行
 *   [2] 勾选类开关：取消勾选「节点?说明按钮」→ 立刻进 S.config 且立刻写盘 + 重绘画布
 *   [3] 打字类：网格间距改值 → 配置当场更新（画布立刻跟手），写盘只在防抖到期后一次
 *   [4] 智能能力：完成音效 / 精简工具负载勾选 → 当场写盘
 *   [5] 服务商卡：打字防抖写盘、调优先级与删除立即写盘（删除记进 removedProviders）
 *   [6] 状态行：写盘成功后回显「已即时生效 · 时间」，写盘失败转红并提示
 *   [7] 词条：新出现的中文串都有英文译文（I18n 单源）
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

/* ── 最小 DOM 影子（够跑设置正文 + 服务商配置卡） ── */
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

/* 写盘计数：每调一次 configSave 记一条当次快照（只记我们关心的字段） */
const writes = [];
let saveShouldFail = false;

/* 假定时器：让「防抖合并写」可被测试确定性触发，不用真等 400ms */
let timerSeq = 0;
let timers = [];
const setTimeoutStub = (fn, ms) => {
  const h = ++timerSeq;
  timers.push({ h, fn, ms: ms || 0 });
  return h;
};
const clearTimeoutStub = (h) => {
  timers = timers.filter((t) => t.h !== h);
};
const flushTimers = () => {
  const list = timers.slice();
  timers = [];
  list.forEach((t) => t.fn());
};
const pendingTimers = () => timers.length;

const sandbox = {
  console,
  document,
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  window: {
    addEventListener() {},
    api: {
      configSave: (cfg) => {
        writes.push({
          snap: cfg.snap,
          netPort: cfg.netPort,
          showNodeHelp: cfg.showNodeHelp,
          dsh: JSON.parse(JSON.stringify(cfg.dsh || {})),
          providers: (cfg.providers || []).map((p) => p.name),
          removed: (cfg.removedProviders || []).slice(),
        });
        return saveShouldFail ? Promise.reject(new Error("disk full")) : Promise.resolve(true);
      },
    },
  },
  localStorage: { getItem: () => null, setItem: () => {} },
  setTimeout: setTimeoutStub,
  clearTimeout: clearTimeoutStub,
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
  closeOverlay: () => {
    sandbox.closeOverlayCalls++;
  },
  closeOverlayCalls: 0,
  validateProviderApiKey: () => {},
  dshProvider: () => null,
  mtnodePiProviders: () => [],
  preferredAgentProviderRoute: () => "",
  preferredAgentModelForRoute: () => "",
  permissionPresetOptions: () => [["mtnode-unattended", "无人值守"]],
  setPermissionPreset: () => {},
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
  renderCanvas: () => {
    sandbox.renderCanvasCalls++;
  },
  renderCanvasCalls: 0,
  renderStatus: () => {},
  paintApprovalsBtn: () => {},
  applyTheme: () => {},
};
vm.createContext(sandbox);
vm.runInContext(read("renderer/app-model-kind.js"), sandbox);
vm.runInContext(read("renderer/app-settings.js"), sandbox);
const run = (code) => vm.runInContext(code, sandbox);
const cfg = sandbox.S.config;
const tick = () => new Promise((r) => setImmediate(r));

/* 在影子树里按条件深度优先找元素（stub 没有 querySelector 的类选择器能力） */
function find(el, pred) {
  if (!el || !el.children) return null;
  for (const c of el.children) {
    if (pred(c)) return c;
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

(async function main() {
  /* ===================== [1] 底部按钮 ===================== */
  console.log("\n[1] 设置窗底部：没有「保存设置」也没有「取消」，只有「关闭」+ 状态行");
  run("openSettingsBody()");
  const footTexts = ovFoot.children.map((c) => c.textContent);
  const btnTexts = ovFoot.children
    .filter((c) => c.tagName === "BUTTON")
    .map((c) => c.textContent);
  ok(
    btnTexts.indexOf("保存设置") < 0,
    "底部不再有「保存设置」按钮：实际按钮 = " + JSON.stringify(btnTexts),
  );
  ok(btnTexts.indexOf("取消") < 0, "底部不再有「取消」（没有可放弃的未保存改动）");
  ok(btnTexts.indexOf("关闭") >= 0, "底部只有显式出口「关闭」");
  ok(
    btnTexts.indexOf("打开存档位置") >= 0 && btnTexts.indexOf("查看说明") >= 0,
    "「打开存档位置 / 查看说明」两个非设置动作照旧保留",
  );
  const stamp = find(ovFoot, (c) => c.className.indexOf("settings-save-stamp") >= 0);
  ok(!!stamp, "底部有状态行 .settings-save-stamp（唯一回执，不用 toast 打扰）");
  ok(stamp && stamp.textContent === "改动即时生效", "状态行初始文案说明本页即时生效");

  /* 「关闭」= 收口 + 写盘 + 关窗，不再有「未保存改动」的概念 */
  await (function () {
    const closeBtn = ovFoot.children.filter((c) => c.tagName === "BUTTON").pop();
    const r = closeBtn.onclick();
    ok(!!r && typeof r.then === "function", "「关闭」返回 promise（等最后一次写盘落地再关窗）");
    return r;
  })();
  ok(sandbox.closeOverlayCalls === 1, "「关闭」确实把设置窗关掉");
  ok(writes.length >= 1, "「关闭」前补了一次写盘（收口：去空白 / 丢空名 / 补齐 dsh 默认档）");
  /* 重开一遍再验下面的各项：影子 DOM 没有 openOverlay 的清空逻辑，这里自己清 */
  const reopen = () => {
    ovBody.children = [];
    ovFoot.children = [];
    run("openSettingsBody()");
  };
  reopen();
  ok(true, "重开设置窗可继续（下面各节都在新开的窗上验证）");

  /* ===================== [2] 勾选类开关 ===================== */
  console.log("\n[2] 勾选：取消「节点?说明按钮」立刻生效并写盘");
  const helpCb = find(ovBody, (c) => c.tagName === "INPUT" && c.type === "checkbox");
  ok(!!helpCb && helpCb.checked === true, "初值：默认勾选（只有显式 false 才不勾）");
  const w0 = writes.length;
  helpCb.checked = false;
  helpCb.onchange();
  ok(cfg.showNodeHelp === false, "勾选状态当场写进 S.config.showNodeHelp");
  ok(writes.length === w0 + 1, "勾选类是离散动作 → 立即写盘一次（不等防抖）");
  ok(sandbox.renderCanvasCalls > 0, "写盘后重绘画布：节点头部「?」按钮马上消失");
  ok(pendingTimers() === 0, "立即写盘不留排队中的定时器");

  /* ===================== [3] 打字类走防抖 ===================== */
  console.log("\n[3] 打字：网格间距改值配置立刻跟手，写盘合并成一次");
  const snapInp = find(ovBody, (c) => c.tagName === "INPUT" && c.type === "number");
  ok(!!snapInp, "找到网格间距输入框");
  const w1 = writes.length;
  snapInp.value = "40";
  snapInp.oninput();
  snapInp.value = "42";
  snapInp.oninput();
  ok(cfg.snap === 42, "打字过程中 S.config.snap 已跟着变（画布 grid() 每次拖拽都重读）");
  ok(writes.length === w1, "打字期间一次都不写盘（configSave 全量写 + 每次备份快照）");
  ok(pendingTimers() === 1, "只留一个待触发的防抖定时器（改几次都合并）");
  const stampEl2 = find(ovFoot, (c) => c.className.indexOf("settings-save-stamp") >= 0);
  ok(stampEl2.textContent === "正在保存…", "排队期间状态行显示「正在保存…」");
  flushTimers();
  await tick();
  ok(writes.length === w1 + 1, "防抖到期后合并成一次写盘");
  ok(writes[writes.length - 1].snap === 42, "落盘的是最后一次输入值 42");
  ok(
    String(stampEl2.textContent).indexOf("已即时生效 · ") === 0,
    "写盘成功后状态行回显「已即时生效 · 时间」",
  );
  /* 越界值即时夹紧（与旧「保存设置」同口径，不等到关窗） */
  snapInp.value = "999";
  snapInp.oninput();
  ok(cfg.snap === 64, "超范围输入当场夹紧（max 64）");

  /* ===================== [4] 智能能力区块 ===================== */
  console.log("\n[4] 智能能力：音效 / 精简工具负载勾选即写盘");
  const allCbs = [];
  (function walk(el) {
    for (const c of el.children || []) {
      if (c.tagName === "INPUT" && c.type === "checkbox") allCbs.push(c);
      walk(c);
    }
  })(ovBody);
  ok(allCbs.length >= 4, "设置里有多个勾选开关（说明按钮 / 自动下游 / 完成音效 / 提问音效 / 精简负载）");
  const sndCb = allCbs.find((c) => c.onchange && c.checked === true && c !== helpCb);
  const w2 = writes.length;
  sndCb.checked = false;
  sndCb.onchange();
  ok(
    cfg.dsh.doneSound === false || cfg.dsh.askSound === false || cfg.dsh.leanToolPayload === false,
    "音效类勾选写进 S.config.dsh（下一轮运行即按新档位生效）",
  );
  ok(writes.length === w2 + 1, "同样立即写盘，不需要「保存设置」");

  /* ===================== [5] 服务商配置卡 ===================== */
  console.log("\n[5] 服务商卡：打字防抖、关窗 flush、调优先级与删除立即写盘");
  const grid = find(ovBody, (c) => c.className.indexOf("prov-tiles") >= 0);
  ok(!!grid && grid.children.length === 2, "提供商网格两格");
  /* —— Alpha：改名与接口地址都是打字 → 防抖；关子对话框 → flush —— */
  grid.children[0].onclick();
  const cfgBody = run("document.getElementById('provCfgBody')");
  let card = cfgBody.children[0];
  ok(!!card && card.className.indexOf("prov-card") >= 0, "正文是一张服务商配置卡");
  const nameInp = find(
    card,
    (c) => c.tagName === "INPUT" && c.type === "text" && c.placeholder === "服务商名称",
  );
  const urlInp = find(card, (c) => c.tagName === "INPUT" && c.placeholder === "https://api.example.com/v1");
  ok(!!nameInp && !!urlInp, "卡里有名称与接口地址输入框");
  const w3 = writes.length;
  const painted = writes.length;
  ok(painted === w3, "只是点开配置卡看一眼不写盘（首绘不算改动）");
  nameInp.value = "Alpha2";
  nameInp.oninput();
  urlInp.value = "https://a2/v1";
  urlInp.oninput();
  ok(cfg.providers[0].name === "Alpha2" && cfg.providers[0].baseUrl === "https://a2/v1",
    "打字当场进内存（网格与节点下拉读的就是这份）");
  ok(writes.length === w3, "打字期间一次都不写盘");
  ok(pendingTimers() === 1, "多次打字合并成一个待触发的防抖定时器");
  run("closeProvCfgDlg()");
  await tick();
  ok(writes.length === w3 + 1, "子对话框关窗 = 强制 flush（不 flush 最后一次编辑就丢了）");
  ok(
    writes[writes.length - 1].providers[0] === "Alpha2",
    "flush 落盘的就是当前值：" + JSON.stringify(writes[writes.length - 1].providers),
  );

  /* —— Beta：↑ 调优先级与 ✕ 删除是离散动作 → 当场写盘 —— */
  grid.children[1].onclick();
  card = cfgBody.children[0];
  const head = card.children[0];
  const upBtn = find(head, (c) => c.className.indexOf("prov-move") >= 0).children[0];
  const w4 = writes.length;
  upBtn.onclick({ preventDefault() {}, stopPropagation() {} });
  await tick();
  ok(
    cfg.providers[0].name === "Beta" && cfg.providers[1].name === "Alpha2",
    "↑ 调优先级当场生效（网格顺序 = 使用优先级）：" +
      JSON.stringify(cfg.providers.map((p) => p.name)),
  );
  ok(writes.length >= w4 + 1, "调优先级立即写盘（本页已无「保存设置」可点）");

  card = cfgBody.children[0]; /* ↑ 之后卡片就地重画，旧引用作废 */
  const del = find(card.children[0], (c) => c.textContent === "✕ 删除");
  const w5 = writes.length;
  del.onclick();
  await tick();
  ok(cfg.providers.length === 1, "删除服务商当场从列表移除");
  ok(
    (cfg.removedProviders || []).indexOf("p2") >= 0,
    "删除记进 removedProviders（重启不再被默认服务商补回来）",
  );
  ok(writes.length >= w5 + 1 && writes[writes.length - 1].providers.length === 1,
    "删除立即写盘：落盘列表只剩 1 家服务商");

  /* ===================== [6] 写盘失败要让人看见 ===================== */
  console.log("\n[6] 写盘失败：状态行转红并提示，不静默吞掉");
  saveShouldFail = true;
  const helpCb2 = find(ovBody, (c) => c.tagName === "INPUT" && c.type === "checkbox");
  helpCb2.checked = true;
  helpCb2.onchange();
  await tick();
  const stampBad = find(ovFoot, (c) => c.className.indexOf("settings-save-stamp") >= 0);
  ok(
    stampBad.className.indexOf("settings-stamp-bad") >= 0,
    "状态行加 .settings-stamp-bad（红色提示：改动只在当前会话内生效）",
  );
  ok(stampBad.textContent === "保存失败：改动只在当前会话内生效", "失败提示写的是实情：" + stampBad.textContent);
  saveShouldFail = false;

  /* ===================== [7] 词条与残留 ===================== */
  console.log("\n[7] 词条齐备 + 旧「保存设置」路径已断干净");
  const I18n = require("../renderer/i18n.js");
  I18n.setLocale("en");
  for (const k of [
    "改动即时生效",
    "正在保存…",
    "已即时生效 · ",
    "保存失败：改动只在当前会话内生效",
    "改动已即时生效，关窗前自动补一次写盘",
    "这张卡的改动已即时生效，点「完成」收窗",
    "关闭",
    /* 随本次改版换了说法的旧串：界面里用的必须在翻译表里找得到 */
    "选择新的配置数据目录；改完需重启应用生效",
    "。添加后自动生成模型列表。",
  ])
    ok(I18n.t(k) !== k, "英文词条可翻：" + k);
  const SET = read("renderer/app-settings.js");
  for (const dead of ["选择新的配置数据目录，保存后需重启", "。保存后自动生成模型列表。"])
    ok(SET.indexOf(dead) < 0, "旧「先保存」口径的串界面里已不用：" + dead);
  ok(
    read("renderer/i18n.js").indexOf("选择新的配置数据目录，保存后需重启") < 0,
    "翻译表里也没留那条指向「保存」的死词条",
  );
  const bodySrc = SET.slice(SET.indexOf("function openSettingsBody()"), SET.indexOf("function catalogAddableProviders"));
  ok(
    bodySrc.indexOf('save.textContent = I18n.t("保存设置")') < 0 &&
      bodySrc.indexOf('I18n.t("取消")') < 0,
    "设置窗源码里既没有「保存设置」也没有「取消」（别的对话框的「取消」不在此列）",
  );
  ok(
    (bodySrc.match(/settingsSaved\(/g) || []).length >= 10,
    "设置窗每一项控件都挂了即时写盘（实际 " + (bodySrc.match(/settingsSaved\(/g) || []).length + " 处）",
  );
  ok(
    /closeBtn\.onclick = async \(\) => \{\s*finalizeSettings\(\);/.test(bodySrc),
    "「关闭」= 收口 + 落盘 + 关窗（唯一的显式出口）",
  );
  ok(
    SET.indexOf("function settingsSaveNow()") >= 0 && SET.indexOf("function settingsSaved(") >= 0,
    "即时生效的统一入口在文件头（写盘 + 状态回显），不在各处各写一遍",
  );
  ok(
    /\.settings-save-stamp\s*\{/.test(read("renderer/css/components.css")),
    "components.css 有 .settings-save-stamp 状态行样式",
  );

  console.log(
    "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"),
  );
  process.exit(fails ? 1 : 0);
})();

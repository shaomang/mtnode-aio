"use strict";
/* 服务商：实时获取模型列表 + 手动配置模式不残留目录区（纯 Node，自带最小 DOM 影子）
 *   node test/smoke-provider-models.js
 * 需求（本轮开发）：
 *   ① 「添加服务商 → 手动配置」是**自定义服务商**：选中后上方那块「服务商目录」
 *      下拉（以及目录专用的名称 / API Key / 提示行）必须整体收起，不再显示。
 *      旧代码写的是 catBox.style.display = paste ? "none" : "" —— 只有「粘贴导入」
 *      才收，手动配置时目录块原样留在上面（用户看到的「仍然显示服务商」）。
 *   ② 服务商卡片新增「获取模型」：向服务商自身的 /models 端点要一份当前可用模型
 *      （纯 HTTP 元信息读取，**不调用任何 AI、零 Token 消耗**），多选后批量加入模型
 *      列表；拿不到就如实报错并提示可继续手工添加。
 * 覆盖：
 *   [1] 来源切换：catalog / manual / paste 三种模式互斥（手动配置不残留目录区）
 *   [2] 手动配置的前置校验：名称 / 接口地址必填
 *   [3] 主进程 api:listModels：只读 GET、端点归一化（/v1/models 回退 /models）、
 *       401 如实报错、不发起任何 chat/completions
 *   [4] 渲染层 fetchModelsToProvider：新模型并入（已有的不重复、不丢失）+ 视觉勾选
 *   [5] 渲染层失败路径：报错并提示可手工添加，不动已有模型列表
 *   [6] preload 桥 + i18n 词条齐备
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");

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

/* ── 最小 DOM 影子：够跑设置正文 / 配置卡 / 获取模型对话框 ── */
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
      this._props = {};
      this._text = "";
      this._html = "";
      this._listeners = {};
      this.onclick = null;
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
    /* 属性 / property 都记：srcSel.value 走 setter，querySelector("[value=..]") 走属性 */
    setAttribute(k, v) {
      this._attrs[k] = v;
      if (k === "id") this.id = v;
    }
    getAttribute(k) {
      if (this._attrs[k] !== undefined) return this._attrs[k];
      return this._props[k] === undefined ? null : this._props[k];
    }
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      return c;
    }
    append(...cs) {
      cs.forEach((c) => this.appendChild(c));
    }
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
      const l = this._listeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
    dispatchEvent(ev) {
      const type = (ev && ev.type) || "change";
      (this._listeners[type] || []).forEach((fn) => fn(ev || { type }));
      return true;
    }
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
      this.children = [];
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join("");
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      const out = [];
      const want = String(sel || "");
      const match = (el) => {
        if (want.startsWith("#")) return el.id === want.slice(1);
        if (want.startsWith(".")) return el._cls.has(want.slice(1));
        const m = want.match(/^\[([\w-]+)="?([^"\]]*)"?\]$/);
        if (m) return String(el.getAttribute(m[1])) === m[2];
        return el.tagName === want.toUpperCase();
      };
      const walk = (el) => {
        for (const c of el.children) {
          if (c && match(c)) out.push(c);
          if (c && c.children) walk(c);
        }
      };
      walk(this);
      return out;
    }
    focus() {}
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    closest() {
      return null;
    }
  }
  /* value / checked / disabled 走「属性 + property」，两种读法都拿得到 */
  for (const k of ["value", "checked", "disabled", "type", "placeholder", "href"]) {
    Object.defineProperty(El.prototype, k, {
      get() {
        return this._props[k] !== undefined ? this._props[k] : this._attrs[k];
      },
      set(v) {
        this._props[k] = v;
      },
      configurable: true,
    });
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
    baseUrl: "https://a.example.com/v1",
    apiKey: "sk-a",
    models: ["qwen3.7-plus"],
    vision: false,
  },
];

let lastToast = null;
let fetchCalls = 0;
let listModelsReply = null;
const sandbox = {
  console,
  document,
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  window: {
    addEventListener() {},
    api: {
      apiListModels: () => {
        fetchCalls++;
        return Promise.resolve(listModelsReply);
      },
      configSave: () => Promise.resolve({ ok: true }),
    },
  },
  localStorage: { getItem: () => null, setItem: () => {} },
  I18n: { t: (s) => s },
  S: {
    config: {
      snap: 24,
      theme: "dsh",
      netPort: 40999,
      providers,
      dsh: { chatEnter: "send", model: "", preset: "standard" },
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
  openOverlay: () => {
    ovBody.innerHTML = "";
    ovFoot.innerHTML = "";
  },
  closeOverlay: () => {},
  settingsSaved: () => Promise.resolve(false),
  settingsSaveNow: () => Promise.resolve(true),
  toast: (msg) => {
    lastToast = String(msg);
  },
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
  confirmDialog: () => Promise.resolve(false),
  renderCanvas: () => {},
  renderStatus: () => {},
  paintApprovalsBtn: () => {},
  /* 「工作步骤展示」四档（本次需求）：设置里那一行读 app-assist.js 的四档词汇表与判定
     （真源与真逻辑由 test/smoke-session-markers.js 钉住；这里只给设置页跑起来的最小桩） */
  DSH_TRANSCRIPT_VIEWS: ["compact", "standard", "detailed", "verbose"],
  DSH_TRANSCRIPT_DEFAULT: "standard",
  dshTranscriptViewNorm: () => "",
  dshTranscriptViewLabel: (v) =>
    ({ compact: "简洁", standard: "标准", detailed: "详细", verbose: "完全展开" })[v] || "标准",
  dshTranscriptViewGlobal: () => "standard",
  repaintSettingsProvTiles: () => {},
  repaintSettingsTopup: () => {},
  settingsProvTilesRepaint: null,
  settingsTopupRepaint: null,
  openSettings: () => {},
  /* 目录能力在 app-assist.js 里（懒加载）；本文件只测自定义 / 手动路径，桩成空目录 */
  ensureProviderCatalog: () => Promise.resolve({ deepseek: [], piai: [] }),
};
vm.createContext(sandbox);
vm.runInContext(read("renderer/app-model-kind.js"), sandbox);
vm.runInContext(read("renderer/app-settings.js"), sandbox);
const run = (code) => vm.runInContext(code, sandbox);
const findIn = (node, pred, found) => {
  found = found || [];
  if (!node || !node.children) return found;
  for (const c of node.children) {
    if (pred(c)) found.push(c);
    findIn(c, pred, found);
  }
  return found;
};

/* ── [1] 来源切换：手动配置不残留目录区 ── */
console.log("\n[1] 「添加服务商」来源切换：三种模式互斥");
run("addProviderDialog()");
const srcSel = findIn(ovBody, (c) => c.tagName === "SELECT", [])[0];
ok(!!srcSel, "对话框里第一个下拉是「来源」");
ok(
  (srcSel.children || []).map((o) => o.value).join(",") === "catalog,manual,paste",
  "来源三档：从服务商目录选择 / 手动配置 / 粘贴导入",
);
const boxes = () => run("0") || findIn(ovBody, (c) => c.className.indexOf("store-form") === 0, []);
const boxOf = (labelText) =>
  boxes().find((b) => b.textContent.indexOf(labelText) >= 0) || null;
const catBox = boxOf("服务商");
const manBox = boxOf("接口地址 Base URL");
const pasteBox = boxOf("解析并填入");
ok(!!catBox && !!manBox && !!pasteBox, "目录 / 手动 / 粘贴三块都在对话框里");
ok(catBox !== manBox && catBox !== pasteBox && manBox !== pasteBox, "三块是各自独立的容器");

srcSel.value = "manual";
srcSel.dispatchEvent({ type: "change" });
ok(
  manBox.style.display === "" && catBox.style.display === "none" && pasteBox.style.display === "none",
  "选「手动配置」→ 只显示手动表单，目录块（服务商下拉 + 名称 + API Key）整体收起",
);
ok(
  catBox.style.display === "none",
  "回归旧 bug：catBox 旧写法 paste ? none : \"\" → 手动配置时目录块留在上面",
);
srcSel.value = "paste";
srcSel.dispatchEvent({ type: "change" });
ok(
  pasteBox.style.display === "" && catBox.style.display === "none" && manBox.style.display === "none",
  "选「粘贴导入」→ 只显示粘贴块",
);
srcSel.value = "catalog";
srcSel.dispatchEvent({ type: "change" });
ok(
  catBox.style.display === "" && manBox.style.display === "none" && pasteBox.style.display === "none",
  "切回「从服务商目录选择」→ 目录块回来，另两块收起",
);
const settingsSrc = read("renderer/app-settings.js");
ok(
  /catBox\.style\.display = srcSel\.value === "catalog" \? "" : "none"/.test(settingsSrc),
  "切换逻辑以「只有 catalog 模式显示目录块」收口（不是 paste ? none : \"\"）",
);

/* ── [2] 手动配置前置校验：名称 / 接口地址必填 ── */
console.log("\n[2] 手动配置（自定义服务商）前置校验");
const addSrc = settingsSrc.slice(
  settingsSrc.indexOf("function addProviderDialog"),
  settingsSrc.indexOf("function openStoreDialog"),
);
ok(
  /请填写服务商名称/.test(addSrc) && /请填写接口地址 Base URL/.test(addSrc),
  "名称与接口地址都要填（自定义服务商没有目录兜底）",
);
ok(
  addSrc.indexOf("请填写接口地址 Base URL") < addSrc.indexOf("prov = {"),
  "接口地址校验在构造 prov 之前（不填就不落库）",
);

/* ── [3] 主进程：api:listModels 只读、端点归一化、401 如实报错 ── */
console.log("\n[3] 主进程 api:listModels：只读 GET、零 Token");
const mainSrc = read("main.js");
ok(
  /ipcMain\.handle\("api:listModels"/.test(mainSrc),
  "主进程注册了 api:listModels",
);
const listSrc = mainSrc.slice(
  mainSrc.indexOf("function modelIdList"),
  mainSrc.indexOf('ipcMain.handle("api:validateKey"'),
);
ok(!!listSrc, "找到模型列表的实现段");
ok(
  /fetchJson\(\s*url,\s*\{\s*method:\s*"GET"/.test(listSrc),
  "只发 GET 请求（元信息读取，不发起 chat/completions 推理）",
);
ok(
  !/fetchJson\(\s*[^)]*chat\/completions|fetchJson\(\s*[^)]*images\/generations/.test(listSrc),
  "实现里没有任何推理 / 生图端点调用（不可能消耗 Token）",
);
ok(
  /Authorization:\s*"Bearer "\s*\+\s*apiKey/.test(listSrc),
  "用服务商自己的 API Key 鉴权",
);
ok(
  /\/v1\/models"，\s*strip \+ "\/models"/.test(listSrc) ||
    /"\/v1\/models",\s*strip \+ "\/models"/.test(listSrc) ||
    /strip \+ "\/v1\/models",\s*strip \+ "\/models"/.test(listSrc),
  "baseUrl 归一化：主机名 → /v1/models，再回退 /models",
);
ok(
  /p\.type === "image_stability"/.test(listSrc) &&
    /\/v1\/user\/account/.test(listSrc) &&
    /engines/.test(listSrc),
  "Stability 走账户信息（/v1/user/account）的 engines 兜底（该家族没有 /models）",
);
ok(
  /got\.status === 401 \|\| got\.status === 403/.test(listSrc) &&
    /API Key 验证失败/.test(listSrc),
  "Key 无权限如实报错（不当成「这个端点不存在」继续试）",
);
ok(
  /获取模型列表失败/.test(listSrc),
  "全部端点都不通时给出明确失败文案",
);

/* ── [4] 渲染层：获取到的模型并入列表 ── */
console.log("\n[4] fetchModelsToProvider：实时模型并入（不丢已配、不重复）");
listModelsReply = {
  ok: true,
  models: ["qwen3.7-plus", "qwen3.7-max", "gpt-image-2-vip"],
  meta: [
    { id: "qwen3.7-plus", input: true, image: false },
    { id: "qwen3.7-max", input: false, image: false },
    { id: "gpt-image-2-vip", input: false, image: true },
  ],
  endpoint: "https://a.example.com/v1/models",
};
const prov = providers[0];
ok(prov.models.length === 1, "调用前：该服务商只配了 1 个模型");
run("fetchModelsToProvider(S.config.providers[0])");
/* fetchModelsToProvider 是 async：等 Promise 队列排空 */
const wait = () => new Promise((r) => setTimeout(r, 0));

void (async () => {
  await wait();
  await wait();
  ok(fetchCalls === 1, "恰好向该服务商发了一次读取请求");
  const picked = findIn(ovBody, (c) => c.tagName === "INPUT" && c.type === "checkbox", []);
  ok(
    picked.length === 3 && picked.every((b) => b.checked === true),
    "3 个实时模型全部列出并默认勾选（含已配的那个）",
  );
  const rows = findIn(ovBody, (c) => c.className.indexOf("mp-row") === 0, []);
  ok(rows.length === 3, "每行一个模型（.mp-row）");
  ok(
    rows.filter((r) => r.textContent.indexOf("新发现") >= 0).length === 2,
    "已配的 1 个不标「新发现」，另外 2 个标上",
  );
  const state = findIn(ovBody, (c) => c.className === "settings-hint", [])
    .map((c) => c.textContent)
    .join(" | ");
  ok(state.indexOf("共 {n} 个模型") < 0 && state.indexOf("3") >= 0, "统计行给出真实数量：3");
  const okBtn = findIn(ovFoot, (c) => c.className.indexOf("primary") >= 0, [])[0];
  ok(!!okBtn && okBtn.textContent === "加入所选模型", "底部「加入所选模型」按钮");
  /* 取消勾选一个新模型（等价于用户不想要它） */
  picked[1].checked = false;
  okBtn.onclick();
  ok(
    JSON.stringify(prov.models) === JSON.stringify(["qwen3.7-plus", "gpt-image-2-vip"]),
    "并入后 = 已配的(qwen3.7-plus) + 勾选的新模型(gpt-image-2-vip)，不重复不乱序：" +
      JSON.stringify(prov.models),
  );
  ok(
    !prov.models.some((m) => m === "qwen3.7-max"),
    "没勾的模型不会被写进去",
  );
  ok(prov.vision === true, "元信息标了「能吃图」→ 顺手勾上支持视觉（只加不减）");
  ok(
    lastToast && lastToast.indexOf("已加入 2 个模型") >= 0,
    "给出加入结果提示（数量已替换进模板）：" + lastToast,
  );

  /* 再点一次：已全部在列 → 不重复添加，已有项不丢 */
  listModelsReply = { ok: true, models: ["qwen3.7-plus", "gpt-image-2-vip"], meta: [] };
  const before = prov.models.slice();
  run("fetchModelsToProvider(S.config.providers[0])");
  await wait();
  await wait();
  const okBtn2 = findIn(ovFoot, (c) => c.className.indexOf("primary") >= 0, [])[0];
  okBtn2.onclick();
  ok(
    JSON.stringify(prov.models) === JSON.stringify(before),
    "重复读取同样一批模型 → 列表保持不变（幂等）",
  );

  /* ── [5] 失败路径：如实报错、不动已有列表 ── */
  console.log("\n[5] 拿不到列表：报错 + 提示可手工添加，不破坏已有配置");
  listModelsReply = { ok: false, error: "HTTP 404：Not Found" };
  const keep = prov.models.slice();
  run("fetchModelsToProvider(S.config.providers[0])");
  await wait();
  await wait();
  ok(
    lastToast && lastToast.indexOf("HTTP 404") >= 0 && lastToast.indexOf("可继续手工添加模型") >= 0,
    "错误原样透出并提示可继续手工添加：" + lastToast,
  );
  ok(
    JSON.stringify(prov.models) === JSON.stringify(keep),
    "失败时模型列表一个字都不动",
  );
  ok(
    findIn(ovBody, (c) => c.className.indexOf("mp-row") === 0, []).length === 0,
    "失败时不会弹出空的模型选择窗（旧窗已被 openOverlay 清掉）",
  );

  /* ── [6] preload 桥 + i18n ── */
  console.log("\n[6] preload 桥与 i18n 词条");
  const pre = read("preload.js");
  ok(
    /apiListModels:\s*\(provider\)\s*=>\s*ipcRenderer\.invoke\('api:listModels'/.test(pre),
    "preload 暴露 apiListModels → 'api:listModels'",
  );
  ok(
    read("renderer/css/components.css").indexOf(".model-pick-list") >= 0,
    "components.css 有 .model-pick-list 样式",
  );
  const i18nObj = require(path.join(__dirname, "..", "renderer", "i18n.js"));
  i18nObj.setLocale("en");
  for (const k of [
    "获取模型",
    "获取模型列表",
    "获取模型列表失败",
    "（可继续手工添加模型）",
    "加入所选模型",
    "共 {n} 个模型 · 新发现 {m} 个",
    "已加入 {n} 个模型（新发现 {m} 个）",
    "已从服务商接口读取到可用模型（只读元信息，未消耗任何 Token）。勾选要加入下方模型列表的条目：已配置的默认勾上（取消勾选只是不重复添加，不会删除已有项）。",
  ]) {
    ok(i18nObj.t(k) !== k, "i18n 英文词条齐备：" + k.slice(0, 14) + "…");
  }

  /* ── [7] 真跑：起一个本地假服务商端点，验证「实时获取」确实只发 GET /v1/models ── */
  console.log("\n[7] 真跑一次（本地假服务商端点）：只读 GET、零 Token");
  let hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.method + " " + req.url + " auth=" + (req.headers.authorization || "-"));
    if (req.headers.authorization !== "Bearer sk-good") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid key" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "qwen3.7-plus", name: "Qwen3.7 Plus", modality: "text" },
            { id: "gpt-image-2-vip", modality: "image_generation" },
            { id: "qwen3.7-plus" },
          ],
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no such endpoint" } }));
  });
  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  const grabMain = (a, b) => {
    const i = mainSrc.indexOf(a);
    const j = mainSrc.indexOf(b, i);
    return i < 0 || j < 0 ? "" : mainSrc.slice(i, j);
  };
  const liveBox = {
    console,
    I18n: { t: (s) => s },
    setTimeout,
    /* 三档看门狗（连接 / 首字节 / 分块）会 clearTimeout 收掉自己的定时器 —— 沙箱要两个都给 */
    clearTimeout,
    URL,
    Buffer,
    http,
    https: require("https"),
    AbortSignal,
    fetch,
    FormData,
    app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() },
  };
  vm.createContext(liveBox);
  vm.runInContext(grabMain("function effectiveTimeout", "async function apiCall("), liveBox);
  vm.runInContext(grabMain("function apiErr", "/* 运行中请求的中止"), liveBox);
  vm.runInContext(
    grabMain("function modelIdList", 'ipcMain.handle("api:listModels"') +
      "\nglobalThis.listProviderModels = listProviderModels;" +
      "\nglobalThis.modelsEndpointsOf = modelsEndpointsOf;",
    liveBox,
  );
  const listLive = liveBox.listProviderModels;
  ok(
    liveBox.modelsEndpointsOf("https://api.example.com/v1/chat/completions").join(",") ===
      "https://api.example.com/v1/models",
    "误把 /chat/completions 填进 Base URL → 仍然回到 /v1/models（不跟着推理端点走）",
  );
  const live = await listLive({
    type: "text_openai",
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    apiKey: "sk-good",
  });
  ok(live.ok === true, "读到模型列表（假端点回 3 条，含 1 条重复）");
  ok(
    JSON.stringify(live.models) === JSON.stringify(["qwen3.7-plus", "gpt-image-2-vip"]),
    "去重 + 保持服务端顺序：" + JSON.stringify(live.models),
  );
  ok(
    hits.length === 1 && hits[0] === "GET /v1/models auth=Bearer sk-good",
    "只发了一次 GET，带服务商自己的 Key：" + hits.join(" | "),
  );
  ok(
    (live.meta || []).some((m) => m.id === "gpt-image-2-vip" && m.image === true),
    "元信息里认得画图模型（modality=image_generation → image:true）",
  );
  hits = [];
  const liveBad = await listLive({
    type: "text_openai",
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    apiKey: "sk-bad",
  });
  ok(
    liveBad.ok === false && liveBad.error === "API Key 验证失败" && hits.length === 1,
    "Key 不对 → 如实报 401 且立刻收手（不再试第二个端点）",
  );
  hits = [];
  const liveMiss = await listLive({
    type: "text_openai",
    baseUrl: "http://127.0.0.1:" + port + "/nope",
    apiKey: "sk-good",
  });
  ok(
    liveMiss.ok === false && liveMiss.error.indexOf("获取模型列表失败") === 0,
    "端点全不通 → 明确失败文案：" + liveMiss.error,
  );
  ok(
    hits.length > 0 &&
      hits.every((h) => h.indexOf("GET ") === 0) &&
      !hits.some((h) => /chat\/completions|images\//.test(h)),
    "全程没有任何推理 / 生图请求（不可能消耗 Token）：" + hits.join(" | "),
  );
  hits = [];
  await listLive({ type: "text_openai", baseUrl: "http://127.0.0.1:" + port, apiKey: "" });
  await listLive({ type: "text_openai", baseUrl: "", apiKey: "sk-good" });
  ok(hits.length === 0, "缺 Key / 缺地址 → 本地就拦下，一个请求都不发");
  await new Promise((r) => server.close(r));

  console.log(
    "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"),
  );
  process.exit(fails ? 1 : 0);
})();
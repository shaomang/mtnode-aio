"use strict";
/* 开发节点「建议」按钮 —— 冒烟测试（纯 Node + 迷你 DOM，不依赖 Electron）
 *   node test/smoke-dev-suggest.js
 * 覆盖：
 *   [1] 建议契约解析（JSON / 代码块 / 键名带空格 / 编号列表兜底 / 脏数据拒绝 / 缓存读写）
 *   [2] 喂给 AI 的「当前开发进度」上下文与只读纪律提示
 *   [3] 勾选结果 → 开发任务正文
 *   [3.1] AGENTS.md 共识文件（任务书 / 技能 / 文档接线）
 *   [4] 「建议」按钮全流程：确认框 → 只读调研（进度态）→ 4 条方案多选 + 补充 → 就地「开发」
 *   [5] 已有缓存：查看上次建议（不重跑模型）·「换一批」重新评估
 *   [6] 键盘：数字键多选 · Ctrl+Enter 开发 · Esc 返回（调研后台继续、不中断）
 *   [7] 异常：模型报错 / 不按契约返回 / 用户取消 / 误调非开发节点
 *   [8] 接线：脚本引入 · 两处「建议」按钮 + 文件「打开」 · 样式 · 工具描述与技能 · 英文词条 */
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
const drain = (n) =>
  new Promise((res) => {
    let k = n || 12;
    const step = () => (k-- <= 0 ? res() : setImmediate(step));
    step();
  });

/* ============================ 迷你 DOM ============================ */
function matches(el, sel) {
  if (!el || !el.__el) return false;
  if (sel.charAt(0) === ".") return el.classList.contains(sel.slice(1));
  if (sel.charAt(0) === "#") return el.id === sel.slice(1);
  return el.tagName === sel.toUpperCase();
}
function walk(el, out) {
  for (const c of el.childNodes) {
    out.push(c);
    walk(c, out);
  }
  return out;
}
function mkEl(tag) {
  const el = {
    __el: true,
    tagName: String(tag || "div").toUpperCase(),
    childNodes: [],
    parentNode: null,
    parentElement: null,
    id: "",
    _cls: "",
    _text: "",
    value: "",
    checked: false,
    hidden: false,
    type: "",
    rows: 0,
    placeholder: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 100,
    style: {},
    _l: {},
    focus() {},
    setSelectionRange() {},
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
      else if (el.parentElement) el.parentElement.removeChild(el);
    },
    appendChild(c) {
      if (c && c.__frag) {
        for (const x of c.childNodes.slice()) el.appendChild(x);
        c.childNodes.length = 0;
        return c;
      }
      c.parentNode = el;
      c.parentElement = el;
      el.childNodes.push(c);
      return c;
    },
    removeChild(c) {
      const i = el.childNodes.indexOf(c);
      if (i >= 0) el.childNodes.splice(i, 1);
      if (c) {
        c.parentNode = null;
        c.parentElement = null;
      }
      return c;
    },
    addEventListener(t, f) {
      (el._l[t] = el._l[t] || []).push(f);
    },
    removeEventListener(t, f) {
      const a = el._l[t] || [];
      const i = a.indexOf(f);
      if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) {
      const e = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, ev || {});
      for (const f of (el._l[type] || []).slice()) f(e);
    },
    querySelector(sel) {
      for (const d of walk(el, [])) if (matches(d, sel)) return d;
      return null;
    },
    querySelectorAll(sel) {
      return walk(el, []).filter((d) => matches(d, sel));
    },
  };
  Object.defineProperty(el, "firstChild", { get: () => el.childNodes[0] || null });
  Object.defineProperty(el, "className", {
    get: () => el._cls,
    set: (v) => {
      el._cls = String(v == null ? "" : v);
    },
  });
  Object.defineProperty(el, "textContent", {
    get: () => el._text + el.childNodes.map((c) => c.textContent).join(""),
    set: (v) => {
      el.childNodes.length = 0;
      el._text = String(v == null ? "" : v);
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get: () => "",
    set: (v) => {
      if (String(v) === "") for (const c of el.childNodes.slice()) el.removeChild(c);
    },
  });
  el.classList = {
    contains: (c) => el._cls.split(/\s+/).indexOf(c) >= 0,
    add: (c) => {
      if (!el.classList.contains(c)) el._cls = (el._cls + " " + c).trim();
    },
    remove: (c) => {
      el._cls = el._cls.split(/\s+/).filter((x) => x && x !== c).join(" ");
    },
    toggle: (c, on) => {
      if (on === undefined) on = !el.classList.contains(c);
      if (on) el.classList.add(c);
      else el.classList.remove(c);
    },
  };
  return el;
}

/* ==================== 沙箱：把 app.js 的依赖 stub 进去 ==================== */
function makeSandbox(modelText, runError, holdRun) {
  const nodes = [
    { id: "top", kind: "super", dev: true, devKind: "module", devStatus: "wip", title: "渲染层", note: "顶层功能块", devPath: "E:/dev/tools/pipeline-console" },
    { id: "n1", kind: "super", dev: true, devKind: "module", devStatus: "pending", title: "建议对话框", note: "开发节点的「建议 / 开发 / 细化」对话框", parentSuperId: "top" },
    { id: "n2", kind: "super", dev: true, devKind: "file", devStatus: "done", title: "app-devnode.js", parentSuperId: "n1" },
    { id: "n3", kind: "super", dev: true, devKind: "class", devStatus: "pending", title: "devSuggestDialog", parentSuperId: "n1" },
    { id: "sib", kind: "super", dev: true, devKind: "module", devStatus: "wip", title: "画布渲染", parentSuperId: "top" },
    { id: "orphan", kind: "super", dev: true, devKind: "module", devStatus: "pending", title: "游离块" },
    { id: "plain", kind: "proc_text", title: "普通节点" },
  ];
  const byId = (id) => nodes.filter((n) => n.id === id)[0] || null;
  const host = mkEl("div");
  const box = mkEl("div");
  box.className = "mt-dialog-box";
  const title = mkEl("h3");
  title.id = "mtDlgTitle";
  const body = mkEl("div");
  body.id = "mtDlgBody";
  const foot = mkEl("div");
  foot.id = "mtDlgFoot";
  [title, body, foot].forEach((x) => box.appendChild(x));
  host.appendChild(box);

  const sb = {
    console,
    setTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Error,
    document: {
      activeElement: null,
      createElement: mkEl,
      createDocumentFragment: () => {
        const f = mkEl("#fragment");
        f.__frag = true;
        return f;
      },
      /* 弹出层（HSV 色板 / 模型清单）挂在 body 上，按 id 取用 */
      body: (() => {
        const b = mkEl("body");
        b.__body = true;
        return b;
      })(),
      getElementById(id) {
        if (this.body.id === id) return this.body;
        return walk(this.body, []).filter((d) => d.id === id)[0] || null;
      },
      /* 未整盘重绘画布时，按钮就地刷新会用到 document 级查询 */
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: { innerWidth: 1280, innerHeight: 800 },
    /* [11] 开发节点 Agent 模型：智能路由 / 模型清单 / 服务商名 */
    agentRouteOptions: () => new Set(["deepseek-official", "mtnode_p1"]),
    agentModelsForRoute: (r) =>
      r === "deepseek-official"
        ? ["deepseek-v4-flash", "deepseek-v4-pro"]
        : ["gpt-5-mini"],
    providerForAgentRoute: (r) => (r === "mtnode_p1" ? { name: "Provider 1" } : null),
    /* [11] Agent 设定三格：预设档位表是 app.js 真源（AGENT_PRESETS）的最小镜像
        （**表序 = 界面序 = 默认档优先**：minimal 第一 = 默认档）；思考档不再由预设改写
        （历史上 lean 会把标准压到 low，现已取消），沙箱里 agentEffortDisplayLabel 只做
        「名义档 = 生效档」的映射，与真源同口径。AGENT_PRESET_DEFAULT 必须与真源同值，
        否则被切片求值的运行入口（建议 / 绑定会话）会因引用不到兜底常量而崩。 */
    AGENT_PRESETS: [
      { id: "minimal", labelKey: "极简模式", hint: "省事档" },
      { id: "standard", labelKey: "标准模式", hint: "通用档" },
      { id: "lean", labelKey: "思维精简", hint: "思考压成符号骨架" },
      { id: "code", labelKey: "PTC 模式", hint: "工程档" },
      { id: "cordis", labelKey: "创造模式", hint: "插件开发档" },
    ],
    AGENT_PRESET_DEFAULT: "minimal",
    agentPresetId: (id) => (String(id == null ? "" : id) === "sketch" ? "lean" : String(id == null ? "" : id)),
    agentPresetById: (id) =>
      sb.AGENT_PRESETS.filter((p) => p.id === sb.agentPresetId(id))[0] || null,
    agentEffortDisplayLabel: (st) =>
      String((st || {}).effort || "") === "max" ? "最强" : "标准",
    /* [11] 运行入口 ②：切片注入的 createDevSessionForNode 需要的 app.js 侧依赖 */
    dshWorkspaceOf: () => "E:/dev/tools/pipeline-console",
    /* 会话「所属画布」绑定（真身在 app-assist.js，按 app.js ownerWfOfNode 判归属）：
       沙箱里的节点全活在同一张画布上，所以固定返回那张图的 id */
    canvasWfIdForNode: () => sb.S.wf.id,
    devSessionTitleOf: (n, mode) => "开发·" + ((n && (n.title || n.id)) || "") + "·" + mode,
    devNodeContractText: () => "【契约】AGENTS.md 共识",
    I18n: { t: (k) => k },
    S: { wf: { id: "smoke-wf", nodes } },
    _mtDialogSeq: 0,
    ensureMtDialog: () => host,
    closeMtDialog: () => {
      host.classList.remove("on");
      host.__closed = (host.__closed || 0) + 1;
    },
    nodeById: byId,
    DEV_KINDS: ["module", "file", "class", "interface", "enum"],
    DEV_KIND_LABEL: { module: "模块", file: "文件", class: "类", interface: "接口", enum: "枚举" },
    devKindOf: (n) => n.devKind,
    devStatusOf: (n) => n.devStatus,
    devStatusText: (s) => (s === "done" ? "已完成" : s === "wip" ? "进行中" : "待开发"),
    devChildrenOf: (n) => nodes.filter((k) => k.parentSuperId === n.id),
    devSessionsOf: () => [],
    /* 「开发」对话框要显示「最近一次要求」（真身在 app.js） */
    devLastRequestOf: () => "",
    devPathOf: (n) => {
      let cur = n;
      let g = 0;
      while (cur && g++ < 32) {
        const p = String(cur.devPath || "").trim();
        if (p) return p;
        cur = cur.parentSuperId ? byId(cur.parentSuperId) : null;
      }
      return "";
    },
    /* [9] 运行状态判定（devNodeRunningState）依赖 */
    nodeParentSuperId: (n) => n.parentSuperId,
    isSuperIoNode: (n) => n.kind === "super_io",
    devSessionIdsOf: (n) => {
      const out = [];
      if (n && Array.isArray(n.devSessionIds))
        for (const id of n.devSessionIds) if (id && out.indexOf(id) < 0) out.push(id);
      if (n && n.agentSessionId && out.indexOf(n.agentSessionId) < 0)
        out.push(n.agentSessionId);
      return out;
    },
    agentSessions: () => sb.__sessions,
    sessionIsRunning: (st) => !!(st && st.running),
    scheduleSave() {
      sb.__saves++;
    },
    pushHistory() {
      sb.__hist++;
    },
    __saves: 0,
    __hist: 0,
    renderCanvas() {},
    toast() {},
    clipStr: (s, n) => {
      const t = String(s || "");
      return t.length > n ? t.slice(0, n) + "…" : t;
    },
    /* 「建议 / 问询」记录会话要造会话 id（devRecordSessionOf → uid("as")） */
    uid: (p) => (p || "n") + (++sb.__uids),
    __uids: 0,
    fmtTime: (t) => "T" + Number(t),
    __devCalls: [],
    __sessions: [],
    startDevSessionWithText: (node, text) => {
      sb.__devCalls.push({ id: node.id, text });
    },
    __runCalls: [],
    __cancel: [],
    dshSupported: () => ({ ok: true }),
    dshCancelActive: (k) => sb.__cancel.push(k),
    isCancelishError: (m) => /cancel|abort/i.test(String(m || "")),
    dshRunTask: (input, opts) => {
      sb.__runCalls.push({ input, opts });
      if (opts && typeof opts.onEvent === "function") {
        opts.onEvent("tool", { name: "read", args: '{"file_path":"src/a.js"}' });
        opts.onEvent("tool", { name: "grep", args: { pattern: "TODO" } });
      }
      if (runError) return Promise.reject(new Error(runError));
      if (holdRun)
        return new Promise((res, rej) => {
          sb.__resolveRun = res;
          sb.__rejectRun = rej;
        });
      return Promise.resolve(modelText);
    },
    __forms: [],
    __formResult: null,
    mtDialogForm: (opts) => {
      sb.__forms.push(opts);
      return Promise.resolve(sb.__formResult);
    },
  };
  sb.__host = host;
  sb.__nodes = nodes;
  const ctx = vm.createContext(sb);
  vm.runInContext(read("renderer/app-devnode.js"), ctx, { filename: "app-devnode.js" });
  return sb;
}
const ex = (sb, expr) => vm.runInContext(expr, sb);
const rowsOf = (body) =>
  body.querySelectorAll("label").filter((l) => l.classList.contains("mt-sug-opt"));
const cbOf = (row) => row.childNodes.filter((c) => c.type === "checkbox")[0];
const titleOf = (row) => {
  const t = row.querySelector(".mt-sug-title");
  return t ? t.textContent : "";
};
const priOf = (row) => {
  const t = row.querySelector(".mt-sug-pri");
  return t ? t.textContent : "";
};
const rowFor = (body, tt) =>
  rowsOf(body).filter((r) => titleOf(r).indexOf(tt) >= 0)[0] || null;
const checkedTitles = (body) =>
  rowsOf(body)
    .filter((r) => cbOf(r).checked)
    .map(titleOf)
    .join("|");
const footLabels = (host) =>
  (host.querySelector("#mtDlgFoot") || { childNodes: [] }).childNodes.map((b) => b.textContent);
const footBtn = (host, label) =>
  (host.querySelector("#mtDlgFoot") || { childNodes: [] }).childNodes.filter(
    (b) => b.textContent === label,
  )[0] || null;

const MODEL_JSON =
  "先说结论：\n```json\n" +
  JSON.stringify({
    summary: "对话框骨架已有，但勾选结果的落地逻辑缺失",
    basis: [
      "renderer/app-devnode.js:555 devSuggestPickBody 只渲染清单",
      "test/ 目录无对应冒烟测试",
    ],
    options: [
      { title: "补多选状态持久化", desc: "把 picked / supplement 写回 node.devSuggest", priority: "high" },
      { title: "加键盘操作", desc: "数字键勾选、Ctrl+Enter 开发", priority: "mid" },
      { title: "补冒烟测试", desc: "用迷你 DOM 覆盖确认 → 调研 → 开发全链路", priority: "low" },
      { title: "方案去重", desc: "同一模块重复生成时合并相似项", priority: "does-not-exist" },
    ],
  }) +
  "\n```\n以上就是四条方案。";

(async () => {
  /* ==================== [1] 契约解析 ==================== */
  console.log("\n[1] 建议契约解析");
  let sb = makeSandbox(MODEL_JSON);
  const parse = (t) => ex(sb, "devSuggestParse(" + JSON.stringify(t) + ")");
  const r = parse(MODEL_JSON);
  ok(!!r, "代码块围栏 + 前后杂文里能抠出方案");
  ok(r && r.items.length === 4, "方案数量 = 4");
  ok(r && r.items[0].title === "补多选状态持久化", "优先级最高的排第一");
  ok(
    r && r.items.map((x) => x.priority).join(",") === "high,mid,mid,low",
    "按优先级重排：优先 → 常规 → 常规 → 可延后",
  );
  const weird = r && r.items.filter((x) => x.title === "方案去重")[0];
  ok(weird && weird.priority === "mid", "认不出的优先级回退为常规");
  ok(new Set(r.items.map((x) => x.id)).size === 4, "每条方案有唯一 id（供勾选）");
  ok(r && r.summary.indexOf("落地逻辑缺失") > 0, "保留 AI 评估摘要");
  ok(r && r.basis.length === 2, "保留真实代码证据");
  const ws = parse(
    '{ "summary" : "有空格的键名也要认", "basis" : [ "a.js:1 x" ], "options" : [ { "title" : "甲方案", "desc" : "说明甲", "priority" : "high" }, { "title" : "乙方案", "desc" : "说明乙", "priority" : "low" } ] }',
  );
  ok(ws && ws.items.length === 2 && ws.summary === "有空格的键名也要认", "键名带空格的 JSON 照样解析");
  ok(parse('{"options":[{"title":"只有一条"}]}') === null, "少于 2 条判失败（不展示残缺清单）");
  const Q = String.fromCharCode(34);
  const sixOpts =
    "{" +
    Q +
    "options" +
    Q +
    ":[" +
    [1, 2, 3, 4, 5, 6]
      .map(function (i) {
        return "{" + Q + "title" + Q + ":" + Q + "方案" + i + Q + "}";
      })
      .join(",") +
    "]}";
  ok(parse(sixOpts).items.length === 4, "超过 4 条裁到 4 条");
  const lines = parse(
    "下一步建议：\n1. 【优先】落地勾选状态 —— 把 picked 写回节点\n2. 补键盘操作\n3. 低：加冒烟测试\n",
  );
  ok(lines && lines.items.length === 3, "非 JSON 时从编号列表兜底");
  ok(
    lines && lines.items[0].title === "落地勾选状态" && lines.items[0].priority === "high",
    "兜底能识别行首优先级标记并剥离",
  );
  ok(lines && lines.items[0].desc.indexOf("picked") >= 0, "兜底条目能拆出说明");
  ok(parse("模型直接开始写代码：我先把文件改了…") === null, "没有方案 → null（进失败态）");
  ok(parse("") === null, "空返回 → null");
  const sp = ex(sb, 'devSuggestSplitTitle("补测试 —— 用迷你 DOM 覆盖全链路")');
  ok(sp.title === "补测试" && sp.desc.length > 5, "标题里的「——」能拆出说明");
  sb.__r = r;
  ok(ex(sb, "devSuggestOf({ devSuggest: __r })").items.length === 4, "节点缓存可读回（devSuggestOf）");
  ok(
    ex(sb, "devSuggestOf({ devSuggest: { items: [{ title: \"x\" }] } })") === null,
    "残缺缓存当作没有（不显示半截方案）",
  );
  ok(ex(sb, "devSuggestPriorityOf(\"必须做\")") === "high", "中文「必须」归为优先");
  ok(ex(sb, "devSuggestPriorityOf(\"nice to have\")") === "low", "英文 nice to have 归为可延后");

  /* ==================== [2] 进度上下文 ==================== */
  console.log("\n[2] 「当前开发进度」上下文与只读纪律");
  const ctxTxt = ex(sb, 'devSuggestContextText(nodeById("n1"), "只看健壮性")');
  ok(ctxTxt.indexOf("建议对话框") >= 0, "含目标功能块");
  ok(ctxTxt.indexOf("E:/dev/tools/pipeline-console") >= 0, "含继承自顶层块的项目根目录");
  ok(ctxTxt.indexOf("渲染层") >= 0, "含上层链路");
  ok(ctxTxt.indexOf("app-devnode.js") >= 0, "含本块下层元素（文件）");
  ok(ctxTxt.indexOf("devSuggestDialog") >= 0, "含更深层元素（类）");
  ok(ctxTxt.indexOf("画布渲染") >= 0, "含同层兄弟块");
  ok(ctxTxt.indexOf("* 建议对话框") >= 0, "进度树用 * 标出本块");
  ok(ctxTxt.indexOf("共 6 个功能块") >= 0, "给出整体完成度统计");
  ok(ctxTxt.indexOf("只看健壮性") >= 0, "带上用户本轮关注点");
  ok(ctxTxt.indexOf("还没有开发 / 细化会话") >= 0, "没动过手就如实说没动过手");
  ok(ctxTxt.indexOf("上一次 AI 建议") < 0, "无缓存时不编造上次建议");
  const sys = ex(sb, "devSuggestSystemPrompt()");
  ["write", "edit", "mtnode_canvas_edit", "subagent", "todo_write", "create_goal"].forEach((k) =>
    ok(sys.indexOf(k) >= 0, "系统提示禁止「" + k + "」"),
  );
  ok(sys.indexOf("只输出一个 JSON 对象") >= 0, "系统提示要求只输出 JSON");
  const prompt = ex(sb, "devSuggestPrompt(nodeById('n1'),'聚焦错误处理')");
  ok(prompt.indexOf("恰好 4 条") >= 0, "任务书要求恰好 4 条方案");
  ok(prompt.indexOf("聚焦错误处理") >= 0, "任务书带用户关注点");
  ok(prompt.indexOf("只读") >= 0 && prompt.indexOf("不要全量读源码") >= 0, "任务书重申只读且限制读取量");
  ok(sys.indexOf("AGENTS.md") >= 0, "系统提示要求先读 AGENTS.md 共识");
  ok(sys.indexOf("不要修改") >= 0 && sys.indexOf("目录约定") >= 0, "系统提示遵守「目录约定 / 不要修改」清单");
  ok(prompt.indexOf("AGENTS.md") >= 0, "建议任务书要求先读 AGENTS.md 共识");

  /* ==================== [3] 勾选 → 开发任务书 ==================== */
  console.log("\n[3] 勾选结果拼成开发任务正文");
  const brief = ex(sb, "devSuggestBriefText(nodeById('n1'), __r, ['o1','o3'], '别改对外 API')");
  ok(brief.indexOf("【按「建议」确认的方案开发】 建议对话框") >= 0, "抬头写明模块名");
  ok(brief.indexOf("1. [优先] 补多选状态持久化") >= 0, "第 1 条带优先级标签");
  ok(brief.indexOf("2. [可延后] 补冒烟测试") >= 0, "第 3 条按显示序写成第 2 项");
  ok(brief.indexOf("用户已勾选 2 / 4") >= 0, "写明勾选数量");
  ok(brief.indexOf("本轮明确不做：加键盘操作、方案去重") >= 0, "未选项进「明确不做」");
  ok(brief.indexOf("用户补充：别改对外 API") >= 0, "补充说明被带上");
  ok(
    brief.indexOf("按两段式规范") >= 0 &&
      brief.indexOf("回写该开发节点的概述（note）") >= 0 &&
      brief.indexOf("更新状态（devStatus）") >= 0,
    "要求按两段式规范回写概述与状态",
  );
  const bare = ex(sb, "devSuggestBriefText(nodeById('n1'), __r, [], '只做这个')");
  ok(bare.indexOf("用户未采纳 AI 提议的方案") >= 0, "一条都没勾时按补充内容开发");

  /* ==================== [3.1] AGENTS.md 共识文件（生成开发节点时同步产出） ==================== */
  console.log("\n[3.1] AGENTS.md 共识文件（任务书 / 技能 / 文档接线）");
  ok(brief.indexOf("AGENTS.md") >= 0, "开发正文要求遵守 AGENTS.md 共识");
  const appjsA = read("renderer/app.js");
  ok(appjsA.indexOf("AGENTS.md") >= 0, "开发任务书（devNodeContractText）内置 AGENTS.md 共识");
  ok(
    appjsA.indexOf("文件节点的路径与新建内容都要符合「目录约定」") >= 0,
    "细化任务书（devRefinePrompt）内置 AGENTS.md 共识",
  );
  const skillA = read("mtnode-agent-skills/mtnode/dev-architect/SKILL.md");
  ok(skillA.indexOf("AGENTS.md 共识文件") >= 0, "dev-architect 技能新增 AGENTS.md 章节");
  ok(
    skillA.indexOf("目录约定") >= 0 && skillA.indexOf("不要修改") >= 0,
    "技能给出共识模板（目录约定 / 不要修改）",
  );
  ok(skillA.indexOf("同步产出 `AGENTS.md`") >= 0, "模式 A 建画布步骤同步产出 AGENTS.md");
  ok(skillA.indexOf("动工前") >= 0 && skillA.indexOf("共识文件") >= 0, "模式 B 动工前确认并写入共识文件");
  ok(
    read("mtnode-agent-skills/index.json").indexOf("AGENTS.md") >= 0,
    "技能索引已同步 AGENTS.md 描述",
  );
  ok(read("docs/dev-node-design.md").indexOf("AGENTS.md") >= 0, "设计文档写明 AGENTS.md 共识文件");
  ok(read("guides/manual/dev-nodes.md").indexOf("AGENTS.md") >= 0, "中文手册写明 AGENTS.md");
  ok(read("guides/manual/en/dev-nodes.md").indexOf("AGENTS.md") >= 0, "英文手册写明 AGENTS.md");
  ok(read("CHANGELOG-v1.1.md").indexOf("AGENTS.md") >= 0, "版本文档记录 AGENTS.md");

  /* ==================== [4] 全流程 ==================== */
  console.log("\n[4] 按钮全流程：确认 → 只读调研 → 多选 + 补充 → 开发");
  sb = makeSandbox(MODEL_JSON, "", true);
  sb.__formResult = { action: "go", text: "聚焦错误处理" };
  const node = sb.__nodes.filter((n) => n.id === "n1")[0];
  const p4 = ex(sb, "suggestDevNode(nodeById('n1'))");
  ok(sb.__forms.length === 1, "第一步只弹确认对话框");
  ok(sb.__runCalls.length === 0, "用户确认之前绝不调用 AI");
  const form = sb.__forms[0];
  ok(form.title.indexOf("建议") === 0, "确认框标题以「建议」开头");
  ok(form.rows.some((x) => x[0] === "元素类型") && form.rows.some((x) => x[0] === "历史会话"), "确认框列出模块现状");
  ok(
    form.note &&
      (String(form.note.text || "") + "|" + String(form.note.design || "")).indexOf(
        "建议 / 开发 / 细化",
      ) >= 0,
    "确认框显示模块概述（两段式字段含功能段）",
  );
  ok(form.msg.indexOf("只读") >= 0 && form.msg.indexOf("4 条") >= 0, "确认框讲清接下来会做什么");
  ok(form.textarea && form.textarea.label.indexOf("本轮关注点") >= 0, "可选填本轮关注点");
  ok(form.actions.map((a) => a.label).join("|") === "取消|确认生成建议", "首轮按钮 = 取消 / 确认生成建议");
  ok(form.hint.indexOf("只读评估") >= 0, "提示条说明只读评估");
  await drain();
  ok(sb.__runCalls.length === 1, "确认后才跑只读调研");
  const ropts = sb.__runCalls[0].opts;
  ok(ropts.workspace === "E:/dev/tools/pipeline-console", "调研工作区 = 项目根目录");
  ok(ropts.runKey === "devsuggest:n1", "runKey 绑定节点（停止 / 全部终止可用）");
  ok(ropts.node === undefined, "不传 node：不锁画布作用域、不回写节点");
  ok(ropts.effort === "high" && ropts.preset === "minimal", "三格未选 → 建议走默认档 minimal + 高推理档");
  ok(ropts.systemPrompt.indexOf("禁止") >= 0, "带只读禁令的系统提示");
  ok(sb.__runCalls[0].input.indexOf("聚焦错误处理") >= 0, "关注点进入任务书");
  let b = sb.__host.querySelector("#mtDlgBody");
  ok(b.textContent.indexOf("AI 正在阅读项目代码") >= 0, "调研期显示进行中文案");
  ok(b.textContent.indexOf("🔧 read") >= 0 && b.textContent.indexOf("src/a.js") >= 0, "实时显示只读工具调用");
  ok(!!footBtn(sb.__host, "停止生成"), "调研期间按钮是「停止生成」");
  sb.__resolveRun(MODEL_JSON);
  await drain();
  b = sb.__host.querySelector("#mtDlgBody");
  let rows = rowsOf(b);
  ok(rows.length === 4, "调研完成后：同一对话框变成 4 行可勾选方案");
  ok(titleOf(rows[0]) === "补多选状态持久化", "第一行是优先级最高的方案");
  ok(cbOf(rows[0]).checked === true, "最高优先级默认勾选（开发按钮立即可用）");
  ok(priOf(rows[0]) === "优先" && priOf(rows[3]) === "可延后", "每行标出优先级");
  ok(b.textContent.indexOf("renderer/app-devnode.js:555") >= 0, "显示 AI 真实读到的证据");
  ok(!!b.querySelectorAll("textarea")[0], "带「补充说明」输入框");
  ok(footLabels(sb.__host).join("|") === "取消|换一批|开发", "底部按钮 = 取消 / 换一批 / 开发");
  const pick = rowFor(b, "补冒烟测试");
  cbOf(pick).checked = true;
  cbOf(pick).onchange();
  b.querySelectorAll("textarea")[0].value = "顺手加个键盘操作说明";
  footBtn(sb.__host, "开发").onclick();
  await p4;
  ok(sb.__devCalls.length === 1, "点「开发」→ 与「开发」按钮同一条路径开工");
  ok(sb.__devCalls[0].id === "n1", "开的是本模块的会话");
  const started = sb.__devCalls[0].text;
  ok(started.indexOf("1. [优先] 补多选状态持久化") >= 0, "正文含勾选的第 1 条");
  ok(started.indexOf("[可延后] 补冒烟测试") >= 0, "正文含勾选的第 3 条");
  ok(started.indexOf("本轮明确不做：加键盘操作、方案去重") >= 0, "未勾选的写进「明确不做」");
  ok(started.indexOf("用户补充：顺手加个键盘操作说明") >= 0, "补充说明一并下发");
  ok(node.devSuggest && node.devSuggest.items.length === 4, "方案缓存到节点 devSuggest");
  ok(node.devSuggest.picked.join(",") === "o1,o3", "记住用户勾选（下次预勾选）");
  ok(node.devSuggest.supplement === "顺手加个键盘操作说明", "记住补充说明");
  ok(sb.__host.__closed === 1, "开工后对话框关闭（且只关一次）");

  /* ==================== [5] 上次建议 / 换一批 ==================== */
  console.log("\n[5] 上次建议（不重跑模型）与「换一批」");
  sb = makeSandbox(MODEL_JSON);
  sb.__formResult = { action: "go" };
  const node5 = sb.__nodes.filter((n) => n.id === "n1")[0];
  const p5 = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  footBtn(sb.__host, "取消").onclick();
  await p5;
  ok(node5.devSuggest && node5.devSuggest.items.length === 4, "取消后方案仍留着（下次还能用）");
  const runsAfterFirst = sb.__runCalls.length;
  sb.__formResult = { action: "cached" };
  const p5b = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  const form2 = sb.__forms[sb.__forms.length - 1];
  ok(form2.rows.some((x) => x[0] === "上次建议"), "确认框显示上次建议（条数 + 时间）");
  ok(
    form2.actions.map((a) => a.label).join("|") === "取消|查看上次建议|确认生成建议",
    "多出一个「查看上次建议」入口",
  );
  ok(sb.__runCalls.length === runsAfterFirst, "查看上次建议不再调用模型");
  const b2 = sb.__host.querySelector("#mtDlgBody");
  ok(rowsOf(b2).length === 4, "上次方案原样列出");
  ok(b2.textContent.indexOf("这是上一次生成的方案") >= 0, "明示这是上次结果");
  ok(checkedTitles(b2) === "补多选状态持久化", "默认只预勾选最高优先级一条");
  footBtn(sb.__host, "开发").onclick();
  await p5b;
  ok(sb.__devCalls.length === 1, "缓存视图里的「开发」也能直接开工");
  ok(sb.__devCalls[0].text.indexOf("补多选状态持久化") >= 0, "开工正文用的就是上次方案");
  sb.__formResult = { action: "cached" };
  const p5c = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  footBtn(sb.__host, "换一批").onclick();
  await drain();
  ok(sb.__runCalls.length === runsAfterFirst + 1, "「换一批」重新让 AI 评估一轮");
  ok(rowsOf(sb.__host.querySelector("#mtDlgBody")).length === 4, "新一轮仍是 4 条方案");
  footBtn(sb.__host, "取消").onclick();
  await p5c;
  ok(sb.__devCalls.length === 1, "取消不会开工");

  /* ==================== [6] 键盘 ==================== */
  console.log("\n[6] 键盘操作");
  sb = makeSandbox(MODEL_JSON);
  sb.__formResult = { action: "go" };
  const p6 = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  sb.__host.fire("keydown", { key: "2" });
  let b3 = sb.__host.querySelector("#mtDlgBody");
  ok(cbOf(rowFor(b3, "加键盘操作")).checked === true, "数字键 2 勾上第二条");
  sb.__host.fire("keydown", { key: "1" });
  b3 = sb.__host.querySelector("#mtDlgBody");
  ok(cbOf(rowFor(b3, "补多选状态持久化")).checked === false, "数字键 1 取消第一条");
  sb.__host.fire("keydown", { key: "Enter", ctrlKey: true });
  await p6;
  ok(sb.__devCalls.length === 1, "Ctrl+Enter 直接开工");
  const kb = sb.__devCalls[0].text;
  ok(kb.indexOf("1. [常规] 加键盘操作") >= 0, "勾选结果按键盘改动生效");
  ok(kb.indexOf("] 补多选状态持久化") < 0, "取消勾选的第 1 条不在实现清单里");
  ok(kb.indexOf("本轮明确不做：补多选状态持久化") >= 0, "它被移到「明确不做」");
  /* Esc：调研中按 Esc = 「返回」（只隐藏对话框，作业后台继续跑，完成后自动弹出）；
     破坏性的「停止生成」不再绑在 Esc 上，只能点按钮显式触发 */
  sb = makeSandbox(MODEL_JSON, "", true);
  sb.__formResult = { action: "go" };
  const node6 = sb.__nodes.filter((n) => n.id === "n1")[0];
  const p6b = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  sb.__host.fire("keydown", { key: "Escape" });
  await p6b;
  ok(sb.__cancel.length === 0, "Esc 不再中断调研（dshCancelActive 不被调用，后台继续）");
  ok(!node6.devSuggest, "后台继续不写坏节点缓存");
  ok(sb.__devCalls.length === 0, "Esc 不会误开工");

  /* ==================== [7] 异常 ==================== */
  console.log("\n[7] 异常与边界");
  sb = makeSandbox("", "模型超时");
  sb.__formResult = { action: "go" };
  const node7 = sb.__nodes.filter((n) => n.id === "n1")[0];
  const p7 = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  ok(sb.__host.querySelector("#mtDlgBody").textContent.indexOf("模型超时") >= 0, "模型报错就地显示");
  ok(footLabels(sb.__host).join("|") === "关闭|再试一次", "失败态给「再试一次」");
  ok(!node7.devSuggest, "失败不会写坏缓存");
  footBtn(sb.__host, "关闭").onclick();
  await p7;
  sb = makeSandbox("抱歉，我直接给你写成代码吧：function x(){}");
  sb.__formResult = { action: "go" };
  const p7b = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  ok(sb.__host.querySelector("#mtDlgBody").textContent.indexOf("没有按契约返回") >= 0, "不按契约输出 → 失败提示");
  footBtn(sb.__host, "关闭").onclick();
  await p7b;
  sb = makeSandbox(MODEL_JSON);
  sb.__formResult = null;
  await ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  ok(sb.__runCalls.length === 0, "确认框点「取消」→ 根本不跑模型");
  sb = makeSandbox(MODEL_JSON);
  sb.__formResult = { action: "go" };
  await ex(sb, "suggestDevNode(nodeById('plain'))");
  await ex(sb, "suggestDevNode(null)");
  await drain();
  ok(sb.__forms.length === 0 && sb.__runCalls.length === 0, "非开发节点 / 空节点：什么都不做");
  sb = makeSandbox(MODEL_JSON);
  sb.__formResult = { action: "go" };
  const p7c = ex(sb, "suggestDevNode(nodeById('orphan'))");
  await drain();
  footBtn(sb.__host, "取消").onclick();
  await p7c;
  ok(sb.__forms[0].warn.indexOf("devPath") >= 0, "没设项目根时先警告再去问 AI");
  ok(sb.__runCalls[0].opts.workspace === "", "没 devPath 就退回默认工作区");

  /* ==================== [8] 接线 ==================== */
  console.log("\n[8] 渲染层接线 / 样式 / 词条 / 工具描述");
  const html = read("renderer/index.html");
  ok(
    html.indexOf('<script src="app.js"></script>') <
      html.indexOf('<script src="app-devnode.js"></script>') &&
      html.indexOf('<script src="app-devnode.js"></script>') <
        html.indexOf('<script src="app-canvas.js"></script>'),
    "index.html 在 app.js 之后、app-canvas.js 之前引入 app-devnode.js",
  );
  const canvas = read("renderer/app-canvas.js");
  ok(canvas.indexOf("n-chip n-chip-suggest") < 0, "菜单栏不再有「建议」chip（动作按钮移出节点头部）");
  ok(canvas.indexOf('className = "n-dev-suggest"') >= 0, "折叠卡 body 有「建议」按钮");
  ok(canvas.indexOf('I18n.t("建议（让 AI 评估下一步该实现什么…）")') >= 0, "右键菜单有「建议」项");
  ok(canvas.split("suggestDevNode(node)").length - 1 === 2, "两处入口接到 suggestDevNode()（折叠卡按钮 + 右键菜单）");
  ok(canvas.indexOf("openDevFileNode(node)") >= 0, "文件节点下方按钮组接入「打开」openDevFileNode()");
  ok(canvas.indexOf("n-dev-sugnote") >= 0, "折叠卡显示上次建议摘要");
  ok(canvas.indexOf("devSuggestOf(node)") >= 0, "摘要读取节点缓存");
  const appjs = read("renderer/app.js");
  ok(appjs.indexOf("async function startDevSessionWithText(node, text)") >= 0, "app.js 抽出共用收尾函数");
  ok(appjs.indexOf("await startDevSessionWithText(node, String(res.text") >= 0, "「开发」按钮走同一条收尾路径");
  /* 「开发 / 细化」确认后不再直接跳转会话视图：会话后台运行，用户留在画布 */
  const devFn = appjs.slice(
    appjs.indexOf("async function startDevSessionWithText(node, text)"),
    appjs.indexOf("function assistantMsgFromNode"),
  );
  ok(
    devFn.indexOf('setView("agent")') < 0,
    "startDevSessionWithText 不再 setView(\"agent\")（开发会话后台运行 · 留在画布）",
  );
  ok(
    devFn.indexOf('I18n.t("已创建开发会话') >= 0,
    "开发会话启动后 toast「已创建开发会话…并在后台运行」",
  );
  const refFn = appjs.slice(
    appjs.indexOf("async function refineDevNode(node)"),
    appjs.indexOf("/* 端子悬浮"),
  );
  ok(
    refFn.indexOf('setView("agent")') < 0,
    "refineDevNode 不再 setView(\"agent\")（细化会话后台运行 · 留在画布）",
  );
  ok(
    refFn.indexOf('I18n.t("已创建细化会话') >= 0,
    "细化会话启动后 toast「已创建细化会话…并在后台运行」",
  );
  const cssC = read("renderer/css/canvas.css");
  const cssB = read("renderer/css/base.css");
  ok(cssC.indexOf(".n-chip.n-chip-suggest") < 0, "canvas.css：头部 chip 样式已随菜单栏按钮移除");
  ok(cssC.indexOf(".n-dev-info .n-dev-suggest") >= 0, "canvas.css：body 按钮样式");
  ok(cssC.indexOf(".n-dev-info .n-dev-file-open") >= 0, "canvas.css：文件节点「打开」按钮样式");
  ok(cssC.indexOf(".n-dev-info .n-dev-sugnote") >= 0, "canvas.css：上次建议摘要样式");
  ok(cssB.indexOf(".mt-sug-opts") >= 0 && cssB.indexOf(".mt-sug-opt.on") >= 0, "base.css：多选清单样式");
  ok(cssB.indexOf(".mt-sug-log") >= 0, "base.css：调研进度样式");
  ok(cssB.indexOf(".mt-sug-pri.pr-high") >= 0, "base.css：优先级徽标配色");
  ok(
    cssB.indexOf(".mt-dialog-box.mt-form-box.mt-form-wide.mt-sug-box") >= 0,
    "base.css：建议对话框加宽（特异性压过 mt-form-wide）",
  );
  ok(read("dsh/gateway/canvas-plugin.mjs").indexOf("建议 / 开发 / 细化") >= 0, "canvas 工具描述含「建议」");
  /* 本轮 Token 去重：开发节点细则从「网关人设」里撤走，人设只指向技能真源（见 docs/prompt-source-of-truth.md） */
  ok(read("dsh/gateway/gateway.mjs").indexOf("mtnode-dev-architect") >= 0, "网关人设指向 dev-architect 技能（不再抄「建议」细则）");
  ok(
    read("renderer/app-assist.js").indexOf("每个开发节点有「开发」「细化」「建议」「问询」按钮") >= 0,
    "助手系统提示含「建议」",
  );
  const skill = read("mtnode-agent-skills/mtnode/dev-architect/SKILL.md");
  ok(skill.indexOf("- **「建议」按钮**") >= 0, "dev-architect 技能说明「建议」按钮");
  ok(read("mtnode-agent-skills/index.json").indexOf("建议") >= 0, "技能索引已重建并含「建议」");
  ok(read("docs/dev-node-design.md").indexOf("suggestDevNode") >= 0, "设计文档写明「建议」实现");
  const I18n = require("../renderer/i18n.js");
  I18n.setLocale("en");
  const src = read("renderer/app-devnode.js");
  const keys = new Set();
  const re = /I18n\.t\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(src))) {
    let k = m[2];
    if (m[1] === "'") k = k.replace(/\\'/g, "'");
    else {
      try {
        k = JSON.parse('"' + k + '"');
      } catch (_) {}
    }
    if (k.indexOf("\n") >= 0) continue;
    keys.add(k);
  }
  const ALLOW = { "Ctrl+Enter": 1 };
  const missing = [...keys].filter((k) => I18n.t(k) === k && !ALLOW[k]);
  missing.slice(0, 10).forEach((k) => console.log("        MISSING " + JSON.stringify(k)));
  ok(missing.length === 0, "app-devnode.js 全部文案有英文词条（共 " + keys.size + " 条）");
  ok(keys.size > 50, "文案抽取本身有效（抽到 " + keys.size + " 条 I18n.t）");
  ok(I18n.t("确认生成建议") !== "确认生成建议", "「确认生成建议」有英文翻译");
  ok(I18n.t("这不是本功能的新词条") === "这不是本功能的新词条", "缺词条时安全回退中文");

  /* ==================== [9] 运行状态判定（devNodeRunningState） ==================== */
  console.log("\n[9] 开发节点运行状态判定（自身 / 后代 / 绑定会话）");
  sb = makeSandbox(MODEL_JSON);
  const stOf = (nid) =>
    ex(sb, "devNodeRunningState(nodeById(" + JSON.stringify(nid) + "))");
  const setRunning = (nid, v) => {
    const n = ex(sb, "nodeById(" + JSON.stringify(nid) + ")");
    n.running = !!v;
  };
  ok(stOf("plain") === null, "非开发节点 → null");
  ok(stOf("top") === null && stOf("n1") === null && stOf("orphan") === null, "未运行 → null");
  setRunning("top", true);
  ok(stOf("top") === "self", "自身 running → self（优先于后代扫描）");
  setRunning("top", false);
  setRunning("n2", true);
  ok(stOf("n1") === "desc", "直系子节点运行 → desc");
  ok(stOf("top") === "desc", "孙级后代运行 → 顶层块同样 desc（递归）");
  setRunning("n2", false);
  setRunning("sib", true);
  ok(stOf("n1") === null, "兄弟块内节点运行不影响本块 n1");
  ok(stOf("top") === "desc", "但祖先块 top 显示 desc（sib 也是它的后代）");
  setRunning("sib", false);
  ex(sb, 'S.wf.nodes.push({ id: "io1", kind: "super_io", parentSuperId: "n1", running: true })');
  ok(stOf("n1") === null, "super_io 桥接端子运行不计入后代");
  ex(sb, 'S.wf.nodes = S.wf.nodes.filter(function(n){ return n.id !== "io1"; })');
  ex(sb, 'nodeById("n1").devSessionIds = ["s1"]');
  sb.__sessions = [{ id: "s1", running: true }];
  ok(stOf("n1") === "sess", "绑定的开发/细化会话运行 → sess");
  sb.__sessions = [{ id: "s1", running: false }];
  ok(stOf("n1") === null, "绑定会话已停 → null（不再误报运行中）");

  /* [9.1] devRunningNodes：左下角运行队列取数（与处理节点同款展示） */
  console.log("\n[9.1] devRunningNodes 运行队列取数（自身 / 后代 / 绑定会话）");
  sb = makeSandbox(MODEL_JSON);
  const rn = (arr) =>
    ex(
      sb,
      "devRunningNodes(" +
        (arr === undefined ? "" : JSON.stringify(arr)) +
        ").map(function(n){return n.id;}).join(',')",
    );
  ok(rn() === "", "无运行 → devRunningNodes 空列表");
  setRunning("n2", true);
  ok(rn() === "top,n1,n2", "子块自身运行 + 祖先块 desc → 全部进列表（含运行中的 dev 文件块自身）");
  ok(rn(ex(sb, "S.wf.nodes")) === "top,n1,n2", "显式传 wfNodes 同样生效");
  setRunning("n2", false);
  setRunning("top", true);
  ok(rn() === "top", "自身运行（self）→ 只列自身");
  setRunning("top", false);
  ex(sb, 'nodeById("n1").devSessionIds = ["s1"]');
  sb.__sessions = [{ id: "s1", running: true }];
  ok(rn() === "n1", "绑定会话运行（sess）→ 仅会话所属块进列表");
  sb.__sessions = [{ id: "s1", running: false }];
  ok(rn() === "", "会话已停 → 列表清空");
  ex(sb, 'S.wf.nodes.push({ id: "dbsup", kind: "super", dev: true, db: true, running: true })');
  ok(rn() === "", "db 超级节点不计入开发运行列表");
  ex(sb, 'S.wf.nodes = S.wf.nodes.filter(function(n){ return n.id !== "dbsup"; })');
  ex(sb, 'S.wf.nodes.push({ id: "plain2", kind: "proc_text", running: true })');
  ok(rn() === "", "普通处理节点运行不计入（由 collectRunQueue 主循环处理）");
  ex(sb, 'S.wf.nodes = S.wf.nodes.filter(function(n){ return n.id !== "plain2"; })');

  const appRun9 = read("renderer/app.js");
  ok(appRun9.indexOf("devRunningNodes(nodes)") >= 0, "collectRunQueue 用 devRunningNodes 收录运行中的开发节点");
  ok(appRun9.indexOf("devRunStateText(n)") >= 0, "队列行 tooltip 显示运行来源（自身 / 子节点 / 会话）");
  ok(
    appRun9.indexOf('node.kind === "super" && node.dev && !node.db) return "dev"') >= 0,
    "nodeKindCls：开发节点 → kind-dev 类（独立行样式）",
  );
  ok(
    appRun9.indexOf('node.kind === "super" && node.dev && !node.db) return I18n.t("开发")') >= 0,
    "nodeKindLabel：开发节点 → 「开发」标签",
  );
  ok(appRun9.indexOf("stopSubtree(node)") >= 0, "stopNode 开发分支：递归停后代 + 绑定会话（逐条停止可用）");
  const assistRun9 = read("renderer/app-assist.js");
  ok(
    (assistRun9.match(/updateRunQueuePanel\(\)/g) || []).length === 7,
    "app-assist 会话开始 / 结束 + 助手开始 / 结束 + 消息入队 / 出队各刷一次运行队列（共 7 处）",
  );
  const cssRun9 = read("renderer/css/components.css");
  ok(cssRun9.indexOf(".rq-item.kind-dev .rq-title") >= 0, "components.css：开发节点队列行样式（模块绿）");
  const i18nRun9 = require("../renderer/i18n.js");
  i18nRun9.setLocale("en");
  ok(i18nRun9.t("自身运行中") !== "自身运行中", "「自身运行中」有英文词条");
  ok(i18nRun9.t("子节点运行中") !== "子节点运行中", "「子节点运行中」有英文词条");
  ok(i18nRun9.t("绑定会话运行中") !== "绑定会话运行中", "「绑定会话运行中」有英文词条");
  ok(i18nRun9.t("已停止该功能块的运行任务") !== "已停止该功能块的运行任务", "「已停止该功能块的运行任务」有英文词条");

  const canvasRun = read("renderer/app-canvas.js");
  ok(canvasRun.indexOf('classList.add("dev-running", "dev-running-"') >= 0, "nodeElement 给运行中的开发节点加 dev-running 类");
  ok(canvasRun.indexOf('className = "n-chip n-chip-run "') >= 0, "节点头部渲染「运行中」徽标 chip");
  const cssRun = read("renderer/css/canvas.css");
  ok(cssRun.indexOf("@keyframes devRunBreathe") >= 0, "canvas.css：呼吸灯 keyframes");
  ok(cssRun.indexOf(".n-chip.n-chip-run") >= 0, "canvas.css：头部运行徽标样式");
  ok(cssRun.indexOf("--dev-glow") >= 0, "canvas.css：按元素类型取呼吸光晕颜色");
  /* 选中运行中的开发节点：呼吸灯不能因为选中而停，且要更亮 */
  const selAt = cssRun.indexOf(".wf-node.super.dev-el.dev-running.sel {");
  ok(selAt >= 0, "canvas.css：存在「运行中 + 选中」规则（带 .super 抬高权重）");
  const selRule = selAt >= 0 ? cssRun.slice(selAt, cssRun.indexOf("}", selAt)) : "";
  ok(selRule.indexOf("animation: none") < 0, "选中时不再暂停呼吸（旧 animation:none 已移除）");
  ok(selRule.indexOf("animation-name: devRunBreatheSel") >= 0, "选中只切换动画名 → 呼吸继续进行");
  const kfBlock = (name) => {
    const m = cssRun.match(new RegExp("@keyframes " + name + " \\{[\\s\\S]*?\\n\\}"));
    return m ? m[0] : "";
  };
  const kfAlpha = (block) =>
    [...block.matchAll(/border-color: rgba\(var\(--dev-glow[^)]*\), ([\d.]+)\)/g)].map((m) =>
      parseFloat(m[1]),
    );
  const kfNorm = kfAlpha(kfBlock("devRunBreathe"));
  const kfSel = kfAlpha(kfBlock("devRunBreatheSel"));
  ok(kfNorm.length === 2 && kfSel.length === 2, "常态 / 选中两套呼吸 keyframes 都在（波谷 + 波峰）");
  ok(kfSel[0] > kfNorm[0] && kfSel[1] >= kfNorm[1], "选中态呼吸更亮：波谷抬高（不再暗下去）+ 波峰不弱于常态");
  ok(kfSel[1] > 0.9 && kfBlock("devRunBreatheSel").includes("26px"), "选中态光晕更宽更浓");
  ok(
    kfBlock("devRunBreatheSel").includes("--dev-sel-rgb"),
    "选中态把青色高亮环一起写进呼吸动画（动画优先级高于 .sel 普通规则，否则互相吞掉）",
  );
  const cssLight = read("renderer/css/theme-light.css");
  ok(
    cssLight.indexOf("body.theme-light .wf-node.super.dev-el.dev-running.sel") >= 0,
    "theme-light.css：亮色主题下运行中 + 选中的呼吸灯同样加强",
  );

  /* ==================== [9.2] collectRunQueueAll：全应用运行总览取数层 ==================== */
  console.log(
    "\n[9.2] collectRunQueueAll 统一取数（跨画布节点 / 独立会话 / 全局助手 / 后端媒体 + 去重）",
  );
  {
    /* 取数层源码住在 app.js 里：按标记切出 nodeKindCls → collectRunQueueAll，
       连同 makeSandbox 已有的开发节点 / 会话桩一起跑（其余依赖就地补桩）。 */
    const rqSrc = read("renderer/app.js");
    const rqA = rqSrc.indexOf("function nodeKindCls(node) {");
    const rqB = rqSrc.indexOf("/* 队列行的次要信息");
    ok(rqA > 0 && rqB > rqA, "[9.2] 定位到 app.js 运行队列取数层源码");
    const rqLoad = () => {
      const s = makeSandbox(MODEL_JSON);
      s.KIND_CLS = {
        proc_text: "proc",
        proc_image: "img",
        agent_task: "agent",
        chat: "chat",
        music_gen: "media",
        video_gen: "media",
        super: "super",
        task: "task",
      };
      s.S.wf.id = "wf-cur";
      s.S.wf.name = "当前画布";
      s.S.wfBag = {};
      s.S.runPromises = new Map();
      s.S.pendingRun = [];
      s.ownerWfOfNode = (n) => {
        const bag = s.S.wfBag || {};
        for (const wid of Object.keys(bag)) {
          if (((bag[wid] && bag[wid].nodes) || []).indexOf(n) >= 0) return bag[wid];
        }
        return s.S.wf;
      };
      s.wsGroupOf = (p) => (p ? "grp/" + String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "");
      s.isMediaGenNode = (n) => !!n && (n.kind === "music_gen" || n.kind === "video_gen");
      /* 取数层切片之外的依赖（工具节点变体判定 · 与 app.js:isToolNode 同口径） */
      s.isToolNode = (n) =>
        !!(n && ((n.kind === "super" && !!n.tool && !n.db) || n.kind === "tool"));
      s.isFunctionNode = (n) => !!(n && n.kind === "function");
      s.findMediaGenNodeById = (id) => {
        const all = (s.S.wf.nodes || []).concat(
          ...Object.keys(s.S.wfBag).map((k) => s.S.wfBag[k].nodes || []),
        );
        const n = all.filter((x) => x && x.id === id)[0] || null;
        return s.isMediaGenNode(n) ? n : null;
      };
      s.mediaGenWaiters = new Map();
      s.mediaBackendRunWatchers = new Map();
      s.mediaGenRestoreTimers = new Map();
      vm.runInContext(rqSrc.slice(rqA, rqB), s, { filename: "app.js#run-queue" });
      return s;
    };
    /* 在 vm 内 stringify 再于宿主解析：避开跨 realm 对象 */
    const rqView = (s) =>
      JSON.parse(
        ex(
          s,
          "JSON.stringify((function(){var r=collectRunQueueAll();" +
            "return {hasQueue:r.hasQueue,counts:r.counts,items:r.items.map(function(it){" +
            "return {type:it.type,state:it.state,id:it.id,title:it.title,kindCls:it.kindCls," +
            "stateText:it.stateText,sub:it.sub,crossWf:!!it.crossWf,wfName:it.wfName};})};})())",
        ),
      );
    const itemOf = (v, id) => v.items.filter((it) => it.id === id)[0] || null;

    /* ① 只有独立智能会话在跑（没有任何节点 running） */
    const s1 = rqLoad();
    s1.__sessions = [{ id: "s-a", title: "拆解小说", running: true, workspace: "E:/novel/x" }];
    const v1 = rqView(s1);
    ok(v1.hasQueue === true, "只有独立会话在跑 → hasQueue 为真（左下角条状按钮会出现）");
    ok(v1.items.length === 1 && v1.items[0].type === "session", "独立会话进队列（type=session）");
    ok(
      v1.items[0].kindCls === "sess" && v1.items[0].state === "run",
      "会话行 = kind-sess 类 · 归「处理中」",
    );
    ok(
      v1.items[0].title === "拆解小说" && v1.items[0].sub.indexOf("grp/") === 0,
      "会话行副标题取工作目录分组（wsGroupOf）",
    );
    ok(v1.counts.session === 1 && v1.counts.run === 1, "计数：1 个会话在跑");

    /* ①b 只有全局助手在跑 */
    const s2 = rqLoad();
    ex(s2, "S.assistRunActive = true");
    const v2 = rqView(s2);
    ok(
      v2.hasQueue === true && v2.items.length === 1 && v2.items[0].type === "assist",
      "只有全局助手在跑 → 合成一条助手行（不再整条隐藏）",
    );
    ok(
      v2.items[0].kindCls === "assist" && v2.items[0].kindCls !== "agent",
      "助手行不再与 agent_task 节点行撞同一个 kind（旧版硬编码 kind-agent）",
    );

    /* ② 宿主智能节点与它绑定的会话同时在跑 → 只出一行 */
    const s3 = rqLoad();
    s3.__sessions = [{ id: "s-b", title: "写章节", running: true }];
    ex(
      s3,
      'S.wf.nodes.push({ id: "at1", kind: "agent_task", title: "智能任务A", running: true, agentSessionId: "s-b" })',
    );
    const v3 = rqView(s3);
    ok(v3.items.length === 1 && v3.items[0].id === "at1", "会话被运行中的宿主节点代表 → 不重复出行");
    ok(v3.items[0].type === "node" && v3.counts.session === 0, "会话不单独计数（counts.session=0）");
    ok(
      v3.items[0].stateText.indexOf("会话") >= 0 && v3.items[0].stateText.indexOf("写章节") >= 0,
      "被代表的会话标题折进该行状态文案",
    );

    /* ③ 开发块 sess 态运行 → 只出开发块一行 */
    const s4 = rqLoad();
    s4.__sessions = [{ id: "s-c", title: "细化会话", running: true }];
    ex(s4, 'nodeById("n1").devSessionIds = ["s-c"]');
    const v4 = rqView(s4);
    ok(v4.items.length === 1 && v4.items[0].type === "dev", "绑定会话运行的开发块 → 只出开发块一行");
    ok(v4.counts.session === 0, "会话被 sess 态开发块代表 → 不再重复列");
    ok(
      v4.items[0].stateText.indexOf("绑定会话运行中") >= 0 &&
        v4.items[0].stateText.indexOf("细化会话") >= 0,
      "开发块行写明「绑定会话运行中」并带上会话标题",
    );

    /* ③a 同一开发节点多条「开发 / 细化」会话同时在跑 → 每条单独成行（本 bug 修复点）：
       旧版全部折进那一条开发块行，队列只看得到 1 个；现在 N 条会话 = N 行，可单独停止 / 跳转 */
    const s4b = rqLoad();
    s4b.__sessions = [
      { id: "s-d1", title: "开发 · 建议对话框", running: true, workspace: "E:/dev/tools/pipeline-console" },
      { id: "s-d2", title: "开发 · 建议对话框", running: true, workspace: "E:/dev/tools/pipeline-console" },
    ];
    ex(s4b, 'nodeById("n1").devSessionIds = ["s-d1", "s-d2"]');
    const v4b = rqView(s4b);
    ok(
      v4b.items.length === 2 && v4b.items.every((it) => it.type === "session"),
      "同一开发节点 2 条会话在跑 → 队列出 2 行（不再 1 行折叠）",
    );
    ok(v4b.counts.session === 2 && v4b.counts.dev === 0, "计数：2 个会话在跑 · 开发块行已让位（counts.dev=0）");
    ok(
      v4b.items.filter((it) => it.id === "s-d1").length === 1 &&
        v4b.items.filter((it) => it.id === "s-d2").length === 1,
      "两条会话各自成行（id 一一对应，可单独停止 / 跳转）",
    );

    /* ③b 开发节点自身也在跑（self）+ 同一节点 2 条会话 → 开发块行保留（自身运行中）
       且会话仍各占一行：开发块行只为会话而存在时才让位。
       （n1 的祖先块 top 也照常以「子节点运行中」成行 —— devRunningNodes 既有契约） */
    const s4c = rqLoad();
    s4c.__sessions = [
      { id: "s-e1", title: "开发 · 建议对话框", running: true },
      { id: "s-e2", title: "开发 · 建议对话框", running: true },
    ];
    ex(s4c, 'nodeById("n1").devSessionIds = ["s-e1", "s-e2"]');
    ex(s4c, 'nodeById("n1").running = true');
    const v4c = rqView(s4c);
    ok(
      v4c.items.filter((it) => it.type === "session").length === 2 &&
        v4c.items.filter((it) => it.type === "dev" && it.id === "n1").length === 1,
      "自身运行 + 2 会话 → 开发块行保留（自身运行中）+ 会话各占一行",
    );
    const devRow4c = v4c.items.filter((it) => it.type === "dev" && it.id === "n1")[0];
    ok(
      !!devRow4c && devRow4c.stateText.indexOf("自身运行中") >= 0,
      "该开发块行状态为「自身运行中」（不是绑定会话折叠行）",
    );
    ok(
      v4c.items.filter((it) => it.type === "dev" && it.id === "top").length === 1,
      "祖先块 top 仍以「子节点运行中」成行（devRunningNodes 既有契约不受影响）",
    );

    /* ④ 媒体：排队 → 等待中；节点在跑 + 后端在途 → 只补文案不加行 */
    const s5 = rqLoad();
    ex(s5, 'S.wf.nodes.push({ id: "v1", kind: "video_gen", title: "视频生成A" })');
    s5.mediaGenWaiters = new Map([["v1", { jobId: "j1" }]]);
    const v5 = rqView(s5);
    ok(
      v5.items.length === 1 && v5.items[0].type === "media" && v5.items[0].state === "wait",
      "mediaGenWaiters 排队项进「等待中」而非「处理中」",
    );
    ok(
      v5.items[0].stateText === "排队生成" && v5.counts.run === 0 && v5.counts.wait === 1,
      "排队生成文案 + 计数（run=0 / wait=1）",
    );
    const s6 = rqLoad();
    ex(s6, 'S.wf.nodes.push({ id: "v2", kind: "video_gen", title: "视频生成B", running: true })');
    s6.mediaBackendRunWatchers = new Map([["v2", { jobId: "j2" }]]);
    const v6 = rqView(s6);
    ok(
      v6.items.length === 1 && v6.items[0].id === "v2" && v6.counts.media === 0,
      "同一节点既 running 又在媒体在途表里 → 只留一条",
    );
    ok(v6.items[0].stateText.indexOf("后端生成中") >= 0, "原行状态文案补「后端生成中」");
    const s7 = rqLoad();
    s7.S.wfBag = {
      "wf-b": {
        id: "wf-b",
        name: "另一画布",
        nodes: [{ id: "x1", kind: "proc_text", title: "背景节点", running: true }],
      },
    };
    const x7 = itemOf(rqView(s7), "x1");
    ok(
      !!x7 && x7.crossWf === true && x7.wfName === "另一画布",
      "后台画布上 running 的节点也进队列（标 crossWf + 归属画布名，供跨画布定位）",
    );
    const s8 = rqLoad();
    ok(rqView(s8).hasQueue === false, "全都没跑 → hasQueue 为假（面板收起）");

    /* ⑤ 静态接线：面板分组 / 行操作 / 心跳 / 样式 / 英文词条 */
    const rqPanel = rqSrc.slice(
      rqSrc.indexOf("function updateRunQueuePanel()"),
      rqSrc.indexOf("/* 一键终止：运行中"),
    );
    ok(rqPanel.indexOf("collectRunQueueAll()") >= 0, "updateRunQueuePanel 一律走统一取数层");
    ok(rqPanel.indexOf('addSec(I18n.t("智能会话")') >= 0, "面板有「智能会话」分组");
    ok(rqPanel.indexOf('addSec(I18n.t("后端生成中")') >= 0, "面板有「后端生成中」分组");
    ok(
      rqPanel.indexOf("await loadWorkflow(it.wfId)") >= 0,
      "jumpRunQueueItem：跨画布先 loadWorkflow(归属画布) 再 focusNode（不再只 toast）",
    );
    ok(
      rqPanel.indexOf('dshCancelActive("agent:" + st.id)') >= 0,
      "stopRunQueueItem：停会话与「全部终止」同款语义（作废标记 + 取消该会话运行时）",
    );
    ok(rqPanel.indexOf("assistStop()") >= 0, "stopRunQueueItem：助手行走 assistStop()");
    ok(
      rqPanel.indexOf("await stopNode(n)") >= 0,
      "stopRunQueueItem：节点 / 开发块 / 媒体沿用 stopNode()",
    );
    ok(
      rqPanel.indexOf("syncRunQueueTicker(hasQueue)") >= 0 &&
        rqSrc.indexOf("const RUN_QUEUE_TICK_MS = 2000") >= 0,
      "队列非空时每 2s 轻量心跳只重绘面板，队列空即停",
    );
    ok(
      rqPanel.indexOf("renderCanvas()") < 0 && rqPanel.indexOf("scheduleSave()") < 0,
      "刷新只做面板级 DOM 重建：不 renderCanvas()、不 scheduleSave()",
    );
    const cssRq = read("renderer/css/components.css");
    ok(cssRq.indexOf(".rq-item.kind-sess .rq-title") >= 0, "components.css：会话行配色（ai 紫）");
    ok(
      cssRq.indexOf(".rq-item.kind-assist .rq-title") >= 0,
      "components.css：助手行配色（canvas 青）",
    );
    ok(
      cssRq.indexOf(".rq-item.kind-media .rq-title") >= 0,
      "components.css：后端生成行配色（build 橙）",
    );
    ok(
      cssRq.indexOf(".rq-sub") >= 0 && cssRq.indexOf(".rq-sec-n") >= 0,
      "components.css：行内次要信息（ellipsis 限宽）+ 小节小计徽标",
    );
    const reRq = /I18n\.t\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
    const rqKeys = new Set();
    let mRq;
    const rqWhole = rqSrc.slice(rqA, rqSrc.indexOf("/* 一键终止：运行中"));
    while ((mRq = reRq.exec(rqWhole))) {
      let k = mRq[2];
      if (mRq[1] === "'") k = k.replace(/\\'/g, "'");
      else {
        try {
          k = JSON.parse('"' + k + '"');
        } catch (_) {}
      }
      if (k.indexOf("\n") >= 0) continue;
      rqKeys.add(k);
    }
    const rqMissing = [...rqKeys].filter((k) => i18nRun9.t(k) === k);
    rqMissing.slice(0, 10).forEach((k) => console.log("        MISSING " + JSON.stringify(k)));
    ok(rqMissing.length === 0, "运行队列全部文案有英文词条（共 " + rqKeys.size + " 条）");
    ok(rqKeys.size >= 30, "文案抽取有效（抽到 " + rqKeys.size + " 条 I18n.t）");
    ok(i18nRun9.t("排队生成") !== "排队生成", "「排队生成」有英文词条");
    ok(i18nRun9.t("在途生成") !== "在途生成", "「在途生成」有英文词条");
    ok(i18nRun9.t("跨画布定位") !== "跨画布定位", "「跨画布定位」有英文词条");
  }

  /* ==================== [10] 开发节点颜色（菜单栏小按钮 + HSV 色板） ==================== */
  console.log("\n[10] 开发节点颜色：devColor 数据 + HSV 转换 + 菜单栏按钮");
  sb = makeSandbox(MODEL_JSON);
  ok(ex(sb, "devColorOf(nodeById('n1'))") === "", "未设 devColor → 空串（用元素类型默认色）");
  ok(ex(sb, "devColorOf(nodeById('plain'))") === "", "非开发节点 → 空串");
  ex(sb, "nodeById('n1').devColor = '#00FF88'");
  ok(ex(sb, "devColorOf(nodeById('n1'))") === "#00ff88", "devColorOf 校验并小写化 hex");
  ex(sb, "nodeById('n1').devColor = 'red'");
  ok(ex(sb, "devColorOf(nodeById('n1'))") === "", "非法颜色值 → 空串");
  ok(ex(sb, "devShownColor(nodeById('top'))") === "#6fe3a5", "module 默认色为绿色");
  ok(ex(sb, "devShownColor(nodeById('n2'))") === "#6db4ff", "file 默认色为蓝色");
  ex(sb, "nodeById('n2').devColor = '#FF8800'");
  ok(ex(sb, "devShownColor(nodeById('n2'))") === "#ff8800", "设了 devColor 优先于元素类型默认色");
  ok(ex(sb, "hexToRgbTriplet('#6fe3a5')") === "111, 227, 165", "hex → RGB 三元组（呼吸灯 --dev-glow）");
  ok(ex(sb, "hexToRgbTriplet('bad')") === null, "非法 hex → RGB null");
  ok(
    ex(sb, "JSON.stringify(hsvToRgb(0,0,0))") === JSON.stringify({ r: 0, g: 0, b: 0 }),
    "hsv(0,0,0) → 黑",
  );
  ok(
    ex(sb, "JSON.stringify(hsvToRgb(0,1,1))") === JSON.stringify({ r: 255, g: 0, b: 0 }),
    "hsv(0,1,1) → 红",
  );
  ok(
    ex(sb, "JSON.stringify(hsvToRgb(120,1,1))") === JSON.stringify({ r: 0, g: 255, b: 0 }),
    "hsv(120,1,1) → 绿",
  );
  const hsvRed = ex(sb, "rgbToHsv(255,0,0)");
  ok(
    Math.abs(hsvRed.h) < 0.001 && Math.abs(hsvRed.s - 1) < 0.001 && Math.abs(hsvRed.v - 1) < 0.001,
    "rgbToHsv(红) → h≈0 s=1 v=1",
  );
  ok(ex(sb, "hsvToHex(120,1,0.5)") === "#008000", "hsvToHex(120,1,0.5) → #008000");
  ok(
    ex(sb, "JSON.stringify(hexToHsv('#ff0000'))") === JSON.stringify({ h: 0, s: 1, v: 1 }),
    "hexToHsv('#ff0000') → 红",
  );
  const btn = ex(sb, "devColorButtonEl(nodeById('n1'))");
  ok(btn.className.indexOf("n-dev-color") >= 0, "菜单栏颜色按钮元素存在（n-dev-color）");
  ok(btn.title.indexOf("HSV") >= 0, "按钮提示含 HSV 色板说明");
  ok(typeof btn.onclick === "function", "按钮点击接到 toggleDevColorPicker");
  const canvas10 = read("renderer/app-canvas.js");
  ok(canvas10.indexOf("devColorButtonEl(node)") >= 0, "节点头部菜单栏接入颜色按钮 devColorButtonEl()");
  ok(canvas10.indexOf("dev-custom-color") >= 0, "nodeElement 给自定义颜色节点加 dev-custom-color 类");
  ok(canvas10.indexOf('setProperty("--dev-color", dc)') >= 0, "nodeElement 注入 --dev-color");
  ok(canvas10.indexOf('className = "exec-body-title"') < 0, "执行节点 body 不再渲染标题元素（只留节点头部标题）");
  const nodes10 = read("renderer/app-nodes.js");
  ok(nodes10.indexOf("devColorOf(n)") >= 0, "app-nodes 序列化 devColor");
  ok(nodes10.indexOf("patch.devColor") >= 0, "app-nodes 支持 devColor 补丁（Agent 可改颜色）");
  const appjs10 = read("renderer/app.js");
  ok(appjs10.indexOf("devColor: \"\"") >= 0, "app.js 超级节点默认 devColor 空串");
  ok(appjs10.indexOf("S.uiDevColorNode") >= 0, "app.js 全局点击关闭 HSV 色板（点外部收起）");
  const cssC10 = read("renderer/css/canvas.css");
  ok(cssC10.indexOf(".n-dev-color") >= 0, "canvas.css：菜单栏颜色按钮样式");
  ok(cssC10.indexOf(".dev-custom-color") >= 0, "canvas.css：自定义外框色样式");
  ok(cssC10.indexOf(".exec-body-title") < 0, "canvas.css：执行节点 body 标题样式已移除");
  const cssComp10 = read("renderer/css/components.css");
  ok(cssComp10.indexOf(".dev-color-pop") >= 0, "components.css：HSV 色板弹出层样式");
  ok(
    cssComp10.indexOf(".dev-color-sv") >= 0 && cssComp10.indexOf(".dev-color-hue") >= 0,
    "components.css：SV 方块 + 色相条 canvas 样式",
  );
  ok(read("docs/dev-node-design.md").indexOf("HSV") >= 0, "设计文档写明 HSV 色板功能");

  /* ==================== [11] 开发节点 Agent 设定（模型 / 预设 / 思考强度） ==================== */
  console.log("\n[11] Agent 设定：devModel · devPreset · devEffort 就近继承 + 三格弹层 + 三处运行入口");
  sb = makeSandbox(MODEL_JSON);
  ok(
    ex(sb, "devAgentRoutes().join(',')") === "deepseek-official,mtnode_p1",
    "可选智能路由来自 agentRouteOptions（官方 + 已配置服务商）",
  );
  ok(ex(sb, "devAgentModelOf(nodeById('n1'))") === null, "谁都没选 → null（跟随默认模型）");
  ok(ex(sb, "devModelDialogText(nodeById('n1'))") === "自动（跟随默认）", "未选时对话框显示「自动（跟随默认）」");
  ok(ex(sb, "devModelOwn(nodeById('plain'))") === null, "非开发节点不参与模型继承");
  ex(sb, "nodeById('top').devModel = 'deepseek-v4-pro'");
  const eff11 = ex(sb, "devAgentModelOf(nodeById('n2'))");
  ok(eff11 && eff11.model === "deepseek-v4-pro", "子块未自行选择 → 用上层功能块所选模型");
  ok(eff11 && eff11.inherited === true, "继承来的模型标 inherited（按钮虚线 / 文案注明）");
  ok(eff11 && eff11.provider === "deepseek-official", "只存了模型 → 按模型表反查智能路由");
  ok(eff11 && eff11.source.id === "top", "继承来源指向真正做了选择的那个祖先块");
  ok(
    ex(sb, "devModelDialogText(nodeById('n2'))").indexOf("继承自「渲染层」") >= 0,
    "对话框文案点名继承来源功能块",
  );
  ok(ex(sb, "devAgentModelOf(nodeById('top')).inherited") === false, "自身已选 → 不算继承");
  ex(sb, "nodeById('n2').devModel = 'gpt-5-mini'");
  const own11 = ex(sb, "devAgentModelOf(nodeById('n2'))");
  ok(own11.model === "gpt-5-mini" && own11.inherited === false, "子块自己选过 → 以子块为准（就近覆盖）");
  ok(own11.provider === "mtnode_p1", "子块模型属另一服务商 → 路由随之纠正");
  ok(ex(sb, "devAgentModelOf(nodeById('n3')).model") === "deepseek-v4-pro", "未自选的兄弟块仍继承上层");
  ex(sb, "nodeById('n2').devProvider = 'ghost-route'");
  ok(ex(sb, "devModelOwn(nodeById('n2')).provider") === "mtnode_p1", "已失效的路由被丢弃（按模型反查）");
  ex(sb, "nodeById('n2').devProvider = 'deepseek-official'");
  ok(ex(sb, "devModelOwn(nodeById('n2')).provider") === "mtnode_p1", "路由与模型不匹配 → 以模型为准");
  ok(ex(sb, "devModelFitsRoute('deepseek-official','gpt-5-mini')") === false, "模型与路由不匹配 → false");
  ok(ex(sb, "devModelFitsRoute('mtnode_p1','gpt-5-mini')") === true, "模型与路由匹配 → true");
  ok(ex(sb, "devRouteOfModel('nope-xyz')") === "", "查不到归属的模型 → 空路由");
  ok(
    ex(sb, "devAgentModelGroups().map(g => g.name).join('|')") === "DeepSeek 官方|Provider 1",
    "弹层分组标题用服务商名",
  );
  ok(
    ex(sb, "devAgentModelText(nodeById('n2'))") === "Provider 1 · gpt-5-mini",
    "生效模型展示文本 =「服务商 · 模型」",
  );
  /* ---- 菜单栏按钮 ---- */
  ex(sb, "nodeById('n2').devModel = ''");
  ex(sb, "nodeById('top').devModel = ''");
  const autoBtn = ex(sb, "devModelButtonEl(nodeById('n1'))");
  ok(autoBtn.className === "n-dev-model auto", "全未选择 → 模型按钮为 auto 态");
  ok(autoBtn.querySelector(".lbl").textContent === "自动", "未选时按钮文字为「自动」");
  ok(autoBtn.title.indexOf("子功能块") >= 0, "按钮提示写明「子功能块一并使用」");
  ex(sb, "nodeById('top').devModel = 'deepseek-v4-pro'");
  const inhBtn = ex(sb, "devModelButtonEl(nodeById('n3'))");
  ok(inhBtn.className.indexOf("inherited") >= 0, "继承上层 → 按钮标 inherited（虚线）");
  ok(inhBtn.querySelector(".lbl").textContent === "deepseek-v4-pro", "按钮直接显示当前生效模型");
  ok(inhBtn.title.indexOf("继承自「渲染层」") >= 0, "按钮提示点名继承来源");
  ok(typeof inhBtn.onclick === "function", "按钮点击接到模型选择");
  /* ---- 选择弹层 ---- */
  const tgt = sb.__nodes.filter((n) => n.id === "n1")[0];
  tgt.getBoundingClientRect = () => ({ left: 20, top: 20, right: 130, bottom: 38 });
  sb.__anchor = tgt;
  ex(sb, "toggleDevModelPicker(nodeById('n1'), __anchor)");
  const pop = ex(sb, "document.getElementById('devModelPop')");
  ok(typeof ex(sb, "closeDevModelPicker") === "function", "弹层有显式收起入口（Esc 走它）");
  ok(!!pop, "点击按钮后创建模型弹层（#devModelPop）");
  ok(pop.classList.contains("on"), "弹层展开");
  ok(sb.S.uiDevModelNode === "n1", "记录正在选择的功能块（再点按钮 / 点外部收起）");
  ok(
    pop.querySelector(".dev-model-scope").textContent.indexOf("继承自「渲染层」") >= 0,
    "弹层顶部说明当前生效模型与其来源",
  );
  const popList = pop.querySelector(".dev-model-list");
  ok(popList.querySelectorAll(".dev-model-group").length === 2, "弹层按服务商分成 2 组");
  const optBtns = popList.querySelectorAll("button");
  ok(optBtns.length === 3, "弹层列出全部 3 个可选模型");
  ok(optBtns.filter((b) => b.classList.contains("on")).length === 0, "本块未自选时没有打勾项");
  optBtns[2].onclick();
  ok(tgt.devModel === "gpt-5-mini", "点选模型 → 写入节点 devModel");
  ok(tgt.devProvider === "mtnode_p1", "同时记下智能路由");
  ok(sb.__hist > 0, "选择动作可撤销（pushHistory）");
  ok(sb.__saves > 0, "选择后即时存盘（scheduleSave）");
  ok(!pop.classList.contains("on"), "选定后收起弹层");
  ok(ex(sb, "devAgentModelOf(nodeById('n2')).model") === "gpt-5-mini", "本块选定后其子块改继承本块");
  ex(sb, "toggleDevModelPicker(nodeById('n1'), __anchor)");
  ok(
    pop
      .querySelector(".dev-model-list")
      .querySelectorAll("button")
      .filter((b) => b.classList.contains("on")).length === 1,
    "重开弹层时当前模型打勾",
  );
  ok(
    pop.querySelector(".dev-model-scope").textContent.indexOf("本功能块已选择：") >= 0,
    "已选时弹层说明改为「本功能块已选择」",
  );
  pop.querySelectorAll(".dev-model-reset")[0].onclick();
  ok(tgt.devModel === "" && tgt.devProvider === "", "「跟随默认（不指定）」清除本块选择");
  ok(ex(sb, "devAgentModelOf(nodeById('n1')).model") === "deepseek-v4-pro", "清除后退回继承上层选择");
  ex(sb, "nodeById('top').devModel = ''");
  ok(ex(sb, "devAgentModelOf(nodeById('n3'))") === null, "上层也清空 → 整棵树回到跟随默认");
  /* ---- 预设 / 思考强度：同一条就近继承链，三项各自独立生效 ---- */
  sb = makeSandbox(MODEL_JSON);
  let st11 = ex(sb, "devAgentSettingsOf(nodeById('n1'))");
  ok(
    st11.preset === "" && st11.effort === "" && st11.model === "",
    "谁都没选 → preset / effort / model 皆空（跟随默认）",
  );
  ok(
    ex(sb, "devPresetOwn(nodeById('plain'))") === "" && ex(sb, "devEffortOwn(nodeById('plain'))") === "",
    "非开发节点不参与预设 / 思考档继承",
  );
  ex(sb, "nodeById('top').devPreset = 'code'; nodeById('top').devEffort = 'max'");
  st11 = ex(sb, "devAgentSettingsOf(nodeById('n2'))");
  ok(
    st11.preset === "code" && st11.presetInherited === true && st11.effort === "max" && st11.effortInherited === true,
    "子块未自选 → 用上层功能块所选预设与思考档（均标 inherited）",
  );
  ok(st11.presetSource.id === "top" && st11.effortSource.id === "top", "两项继承来源各自指向真正做了选择的祖先块");
  ok(
    ex(sb, "devPresetDialogText(nodeById('n2'))") === "PTC 模式（继承自「渲染层」）",
    "预设对话框文案 = 档位名 + 点名继承来源",
  );
  ok(
    ex(sb, "devEffortDialogText(nodeById('n2'))") === "最强（继承自「渲染层」）",
    "思考档对话框文案点名继承来源",
  );
  ex(sb, "nodeById('n2').devPreset = 'lean'");
  st11 = ex(sb, "devAgentSettingsOf(nodeById('n2'))");
  ok(st11.preset === "lean" && st11.presetInherited === false, "子块自选预设 → 覆盖上层");
  ok(
    st11.effort === "max" && st11.effortInherited === true,
    "预设自选不牵连思考档：思考仍就近继承上层（三项各自独立）",
  );
  ok(ex(sb, "devAgentSettingsOf(nodeById('n3')).preset") === "code", "未自选的兄弟块仍继承上层预设");
  ex(sb, "nodeById('n2').devPreset = ''");
  ok(ex(sb, "devAgentSettingsOf(nodeById('n2')).preset") === "code", "清除后退回继承上层预设");
  /* ---- 取值域：脏值不入库，旧 id 归一 ---- */
  ex(sb, "nodeById('n2').devPreset = 'not-a-preset'");
  ok(ex(sb, "devPresetOwn(nodeById('n2'))") === "", "未知预设 id → 丢弃（当没选）");
  ok(ex(sb, "devAgentSettingsOf(nodeById('n2')).preset") === "code", "脏值不遮蔽上层生效预设");
  ex(sb, "nodeById('n2').devPreset = 'sketch'");
  ok(ex(sb, "devPresetOwn(nodeById('n2'))") === "lean", "旧预设 id sketch → 归一为 lean");
  ex(sb, "nodeById('n2').devPreset = ''");
  ex(sb, "nodeById('n2').devEffort = 'low'");
  ok(ex(sb, "devEffortOwn(nodeById('n2'))") === "low", "思考档扩档后 low（界面「轻」）也是功能块可设值：dev 与会话共用同一张档位表");
  ex(sb, "nodeById('n2').devEffort = 'MAX'");
  ok(ex(sb, "devEffortOwn(nodeById('n2'))") === "max", "大小写容忍后归一为 max");
  ex(sb, "nodeById('n2').devEffort = ''");
  /* ---- 思考档只看设置：预设不再压档，名义档就是生效档 ---- */
  ex(sb, "nodeById('top').devPreset = 'lean'");
  ex(sb, "nodeById('n1').devEffort = 'high'");
  ok(
    ex(sb, "devEffortDialogText(nodeById('n1'))") === "标准",
    "思维精简 + 「标准」→ 仍显示「标准」（预设不改写思考档，网关已取消压档）",
  );
  ok(
    ex(sb, "devEffortScopeText(nodeById('n1'))") === "思考强度：标准",
    "弹层思考格说明：只报所选档位，不再声明被预设降档",
  );
  ex(sb, "nodeById('n1').devEffort = 'max'");
  ok(ex(sb, "devEffortDialogText(nodeById('n1'))") === "最强", "选「最强」→ 显示最强");
  ex(sb, "nodeById('n1').devEffort = ''; nodeById('top').devEffort = ''");
  ok(
    ex(sb, "devEffortDialogText(nodeById('n1'))") === "自动（跟随默认）",
    "只选了预设、没选思考档（上层也没选）→ 思考档回到「自动（跟随默认）」，预设不代它决定档位",
  );
  ex(sb, "nodeById('top').devPreset = ''; nodeById('top').devEffort = ''");
  ok(ex(sb, "devEffortDialogText(nodeById('n1'))") === "自动（跟随默认）", "预设与思考档都没选 → 思考档回到「自动（跟随默认）」");
  /* ---- 按钮摘要：模型没选但选了预设 / 思考档也不算 auto ---- */
  ex(sb, "nodeById('top').devPreset = 'lean'");
  const pBtn11 = ex(sb, "devModelButtonEl(nodeById('n1'))");
  ok(pBtn11.className.indexOf("auto") < 0, "只选了预设 / 思考档（未选模型）→ 按钮不再是 auto 态");
  ok(pBtn11.querySelector(".lbl").textContent.indexOf("思维精简") >= 0, "按钮文字摘要带上预设短名");
  ok(pBtn11.title.indexOf("Agent 预设：") >= 0, "按钮提示列出 Agent 预设一行");
  ok(pBtn11.title.indexOf("思考强度：") >= 0, "按钮提示列出思考强度一行");
  /* ---- 弹层三格：预设 / 模型 / 思考强度 ---- */
  sb = makeSandbox(MODEL_JSON);
  ex(sb, "nodeById('top').devPreset = 'code'; nodeById('top').devEffort = 'max'");
  const tgt3 = sb.__nodes.filter((n) => n.id === "n1")[0];
  tgt3.getBoundingClientRect = () => ({ left: 20, top: 20, right: 130, bottom: 38 });
  sb.__anchor = tgt3;
  ex(sb, "toggleDevModelPicker(nodeById('n1'), __anchor)");
  const pop3 = ex(sb, "document.getElementById('devModelPop')");
  const cells11 = pop3.querySelectorAll(".dev-model-cell");
  ok(cells11.length === 3, "弹层头部为「预设 / 模型 / 思考强度」三格");
  ok(
    cells11.map((c) => c.querySelector(".dev-model-cell-label").textContent).join("|") === "预设|模型|思考强度",
    "三格标签与顺序与会话侧 Agent 菜单一致",
  );
  ok(cells11[1].classList.contains("on"), "打开弹层默认落在模型格");
  ok(
    cells11[0].querySelector(".dev-model-cell-value").textContent === "PTC 模式 ↩",
    "预设格回显继承来的生效预设并标 ↩",
  );
  ok(
    cells11[2].querySelector(".dev-model-cell-value").textContent === "最强 ↩",
    "思考格回显继承来的生效档并标 ↩",
  );
  cells11[0].onclick();
  ok(
    pop3.querySelectorAll(".dev-model-cell").filter((c) => c.classList.contains("pane-preset") && c.classList.contains("on")).length === 1,
    "点预设格 → 本格高亮",
  );
  ok(
    pop3.querySelector(".dev-model-scope").textContent.indexOf("继承自「渲染层」") >= 0,
    "预设格顶部说明点名继承来源",
  );
  const popts11 = pop3.querySelector(".dev-model-list").querySelectorAll("button");
  ok(popts11.length === 6, "预设格列出「跟随默认」+ 全部 5 个预设档位");
  ok(
    popts11.map((b) => b.querySelector(".m").textContent).join("|") ===
      "跟随默认（不指定）|极简模式|标准模式|思维精简|PTC 模式|创造模式",
    "预设清单顺序 = 档位表顺序，且默认档（极简）排第一",
  );
  ok(popts11[0].classList.contains("on"), "本块未自选预设 →「跟随默认（不指定）」打勾");
  ok(popts11.filter((b) => b.querySelector(".i")).length === 1, "继承来的那一档标「（继承）」");
  /* 按名字点，不按序号：序号会随档位表重排而漂移（本轮默认档改成极简就是例子） */
  const pickMinimal = popts11.filter((b) => b.querySelector(".m").textContent === "极简模式")[0];
  pickMinimal.onclick();
  ok(tgt3.devPreset === "minimal", "点选预设 → 写入节点 devPreset");
  ok(!pop3.classList.contains("on"), "选定后收起弹层");
  ok(ex(sb, "devAgentSettingsOf(nodeById('n2')).preset") === "minimal", "本块选定预设后其子块改继承本块");
  ex(sb, "toggleDevModelPicker(nodeById('n1'), __anchor)");
  pop3.querySelectorAll(".dev-model-cell")[2].onclick();
  const eopts11 = pop3.querySelector(".dev-model-list").querySelectorAll("button");
  ok(eopts11.length === 4, "思考强度格 = 会话同一张 UI 档表四档（轻 / 标准 / 强 / 最强；medium 合法但不露出）");
  ok(
    eopts11.map((b) => b.querySelector(".m").textContent).join("|") === "轻|标准|强|最强",
    "思考格四档与 app.js 的 AGENT_EFFORT_UI_ORDER 逐值一致（回显 = 下发）",
  );
  /* 按名字点，不按序号：序号会随扩档漂移（本文件上方「极简模式」那格同理） */
  const pickMax = eopts11.filter((b) => b.querySelector(".m").textContent === "最强")[0];
  ok(!!pickMax, "四档里能按名字找到「最强」（max）");
  pickMax.onclick();
  ok(tgt3.devEffort === "max", "点「最强」→ 写入 devEffort");
  ex(sb, "toggleDevModelPicker(nodeById('n1'), __anchor)");
  pop3.querySelectorAll(".dev-model-cell")[0].onclick();
  pop3
    .querySelector(".dev-model-list")
    .querySelectorAll("button")[0]
    .onclick();
  ok(tgt3.devPreset === "" && tgt3.devEffort === "max", "「跟随默认（不指定）」只清当前这一格（思考档保留）");
  ok(ex(sb, "devAgentSettingsOf(nodeById('n1')).preset") === "code", "清除预设后退回继承上层预设");
  ex(sb, "closeDevModelPicker()");
  /* ---- 运行入口 ①：「建议」只读调研真的用所选模型 / 预设 / 思考档 ---- */
  sb = makeSandbox(MODEL_JSON, null, true);
  ex(sb, "nodeById('top').devModel = 'deepseek-v4-pro'; nodeById('top').devProvider = 'deepseek-official'");
  ex(sb, "nodeById('top').devPreset = 'code'; nodeById('top').devEffort = 'max'");
  sb.__formResult = { action: "go" };
  const p11 = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  const form11 = sb.__forms[sb.__forms.length - 1];
  ok(
    form11.rows.some((x) => x[0] === "Agent 模型" && x[1].indexOf("deepseek-v4-pro") >= 0),
    "「建议」确认框列出 Agent 模型",
  );
  ok(
    form11.rows.some((x) => x[0] === "Agent 预设" && x[1] === "PTC 模式（继承自「渲染层」）"),
    "「建议」确认框列出 Agent 预设（含继承来源）",
  );
  ok(
    form11.rows.some((x) => x[0] === "思考强度" && x[1] === "最强（继承自「渲染层」）"),
    "「建议」确认框列出思考强度（含继承来源）",
  );
  ok(sb.__runCalls.length === 1, "确认后开始只读调研");
  ok(sb.__runCalls[0].opts.model === "deepseek-v4-pro", "「建议」调研用上层功能块所选模型");
  ok(sb.__runCalls[0].opts.provider === "deepseek-official", "调研带上对应智能路由");
  ok(sb.__runCalls[0].opts.preset === "code", "「建议」调研用就近继承来的 Agent 预设");
  ok(sb.__runCalls[0].opts.effort === "max", "「建议」调研用就近继承来的思考强度");
  const log11 = sb.__host.querySelector("#mtDlgBody").textContent;
  ok(log11.indexOf("本轮：") >= 0, "进度日志显示本轮实际使用的 Agent 设定");
  ok(
    log11.indexOf("PTC 模式（继承自「渲染层」）") >= 0 && log11.indexOf("最强") >= 0,
    "日志逐项点名预设与思考档（含来源块）",
  );
  sb.__resolveRun(MODEL_JSON);
  await drain();
  footBtn(sb.__host, "取消").onclick();
  await p11;
  /* ---- 运行入口 ①兜底：三格都没选 → 回落默认档 minimal / high ---- */
  sb = makeSandbox(MODEL_JSON, null, true);
  sb.__formResult = { action: "go" };
  const p11b = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  ok(sb.__runCalls[0].opts.preset === "minimal", "没选预设 → 建议回落默认档 minimal（默认档真源只有一个常量）");
  ok(sb.__runCalls[0].opts.effort === "high", "没选思考档 → 建议仍用 high");
  ok(
    sb.__host.querySelector("#mtDlgBody").textContent.indexOf("本轮：") < 0,
    "一格都没选 → 日志不输出「本轮：」行（与改动前一致）",
  );
  sb.__resolveRun(MODEL_JSON);
  await drain();
  footBtn(sb.__host, "取消").onclick();
  await p11b;
  /* ---- 运行入口 ②：绑定的「开发 / 细化」会话按解析值下发（切片注入 app.js 真身） ---- */
  const appjs11 = read("renderer/app.js");
  const csA11 = appjs11.indexOf("function createDevSessionForNode(node, mode, req) {");
  const csB11 = appjs11.indexOf("/* 从任务书 / 首条 dev-node 消息里取「本次开发需求」行");
  ok(csA11 > 0 && csB11 > csA11, "[11] 定位 app.js 绑定会话创建源码（createDevSessionForNode）");
  const sb11c = makeSandbox(MODEL_JSON);
  vm.runInContext(appjs11.slice(csA11, csB11), sb11c, { filename: "app.js#createDevSessionForNode" });
  ex(
    sb11c,
    "nodeById('top').devModel = 'deepseek-v4-pro'; nodeById('top').devProvider = 'deepseek-official'; nodeById('top').devPreset = 'cordis'; nodeById('top').devEffort = 'max'",
  );
  ex(sb11c, "nodeById('n1').devPreset = 'lean'");
  const sess11 = ex(sb11c, "createDevSessionForNode(nodeById('n2'), 'develop', '把三格接上')");
  ok(
    sess11.model === "deepseek-v4-pro" && sess11.provider === "deepseek-official",
    "绑定会话用就近继承来的模型与智能路由",
  );
  ok(sess11.preset === "lean", "本块链上最近的自选预设优先下发（与模型来源无关）");
  ok(sess11.effort === "max", "思考档仍就近取上层的选择（三项各自独立下发）");
  ok(ex(sb11c, "createDevSessionForNode(nodeById('sib'), 'refine', '').preset") === "cordis", "兄弟块未自选 → 用上层预设");
  const sb11d = makeSandbox(MODEL_JSON);
  vm.runInContext(appjs11.slice(csA11, csB11), sb11d, { filename: "app.js#createDevSessionForNode" });
  const sess11d = ex(sb11d, "createDevSessionForNode(nodeById('n1'), 'develop', 'x')");
  ok(
    sess11d.preset === "minimal" &&
      sess11d.effort === "high" &&
      sess11d.model === "" &&
      sess11d.provider === "deepseek-official",
    "三格都没选 → 会话回落默认档 minimal / high + 默认路由（默认档唯一真源 AGENT_PRESET_DEFAULT）",
  );
  /* ---- 运行入口 ③：问询会话同样按解析值下发 ---- */
  ok(
    (appjs11.match(/preset: \(st && st\.preset\) \|\| AGENT_PRESET_DEFAULT/g) || []).length >= 2,
    "绑定会话与问询会话两处都按解析值下发预设",
  );
  ok(
    (appjs11.match(/effort: \(st && st\.effort\) \|\| "high"/g) || []).length >= 2,
    "绑定会话与问询会话两处都按解析值下发思考档",
  );
  ok(
    (appjs11.match(/typeof devAgentSettingsOf === "function" \? devAgentSettingsOf\(node\) : null/g) || []).length >=
      2,
    "两处会话入口都取就近继承的 Agent 设定（带守卫，模块未加载也不炸）",
  );
  ok(
    read("renderer/app-devnode.js").indexOf("preset: st.preset || AGENT_PRESET_DEFAULT") >= 0 &&
      read("renderer/app-devnode.js").indexOf('effort: st.effort || "high"') >= 0,
    "「建议」调研入口同样按解析值下发（带兜底）",
  );
  /* ---- 接线：数据字段 / 会话 / 序列化 / 网关 / 样式 / 文档 ---- */
  ok(
    appjs11.indexOf('typeof devAgentModelOf === "function" ? devAgentModelOf(node) : null') >= 0,
    "createDevSessionForNode 取生效模型",
  );
  ok(
    appjs11.indexOf('provider: (eff && eff.provider) || "deepseek-official"') >= 0,
    "绑定的开发 / 细化会话用所选路由",
  );
  ok(appjs11.indexOf('model: (eff && eff.model) || ""') >= 0, "绑定的开发 / 细化会话用所选模型");
  ok(
    (appjs11.match(/I18n\.t\("Agent 模型"\)/g) || []).length >= 2,
    "「开发」与「细化」对话框都列出 Agent 模型",
  );
  ok(appjs11.indexOf('devModel: ""') >= 0, "app.js 超级节点默认 devModel 空串");
  ok(appjs11.indexOf('devPreset: ""') >= 0, "app.js 超级节点默认 devPreset 空串（跟随默认）");
  ok(appjs11.indexOf('devEffort: ""') >= 0, "app.js 超级节点默认 devEffort 空串（跟随默认）");
  ok(appjs11.indexOf("S.uiDevModelNode") >= 0, "app.js 全局点击收起模型弹层（点外部）");
  ok(
    appjs11.indexOf('if (ev.key === "Escape" && (S.uiDevColorNode || S.uiDevModelNode))') >= 0,
    "app.js：Esc 同时收起色板与模型弹层",
  );
  const canvas11 = read("renderer/app-canvas.js");
  ok(canvas11.indexOf("devModelButtonEl(node)") >= 0, "节点头部菜单栏接入模型按钮");
  ok(
    canvas11.indexOf("n-dev-model-info") < 0 &&
      canvas11.indexOf("n-dev-path") < 0 &&
      canvas11.indexOf("n-dev-status") < 0,
    "折叠卡 body 精简：不再常驻生效模型行 / 项目根目录 / 状态字样",
  );
  const nodes11 = read("renderer/app-nodes.js");
  ok(nodes11.indexOf("patch.devModel") >= 0, "app-nodes 支持 devModel 补丁（Agent 可改模型）");
  ok(nodes11.indexOf("patch.devProvider") >= 0, "app-nodes 支持 devProvider 补丁");
  ok((nodes11.match(/devModel:/g) || []).length >= 2, "devModel 随工作流保存并进画布快照（canvas_get 可见）");
  ok(nodes11.indexOf("patch.devPreset") >= 0, "app-nodes 支持 devPreset 补丁（Agent 可改预设）");
  ok(nodes11.indexOf("patch.devEffort") >= 0, "app-nodes 支持 devEffort 补丁（Agent 可改思考档）");
  ok(
    nodes11.indexOf("未知 Agent 预设：") >= 0 && nodes11.indexOf("未知思考强度档位：") >= 0,
    "未知预设 / 思考档补丁被拒并回报（画布上不留不存在的档位）",
  );
  ok(
    (nodes11.match(/devPreset:/g) || []).length >= 2 && (nodes11.match(/devEffort:/g) || []).length >= 2,
    "devPreset / devEffort 随工作流保存并进画布快照（canvas_get 可见）",
  );
  const gw11 = read("dsh/gateway/canvas-plugin.mjs");
  ok(
    (gw11.match(/devModel:/g) || []).length >= 1 && gw11.indexOf("devProvider") >= 0,
    "网关 schema 暴露 devModel / devProvider（Agent 能设 · create/update 共用同一份属性表，故只出现一次）",
  );
  ok((gw11.match(/devColor:/g) || []).length >= 1, "网关 schema 暴露 devColor（Agent 能改颜色）");
  ok(
    gw11.indexOf("dev/devPath/devStatus/devKind/devColor/devModel/devProvider") >= 0,
    "canvas_get 工具描述透出这些字段",
  );
  ok(
    (gw11.match(/devPreset:/g) || []).length >= 1 && (gw11.match(/devEffort:/g) || []).length >= 1,
    "网关属性表暴露 devPreset / devEffort（Agent 能设 · create / update 同一份表，不再各抄一遍）",
  );
  ok(
    gw11.indexOf("devModel/devProvider/devPreset/devEffort/devFiles") >= 0,
    "canvas_get 工具描述补齐 devPreset / devEffort",
  );
  ok(
    gw11.indexOf("enum: ['low', 'medium', 'high', 'xhigh', 'max', '']") >= 0,
    "devEffort 在网关侧就是完整档位词汇表（与会话 / 网关 reasoning-effort 模块同源，空串 = 跟随默认）",
  );
  const cssC11 = read("renderer/css/canvas.css");
  ok(cssC11.indexOf(".n-dev-model") >= 0, "canvas.css：头部模型按钮样式");
  ok(cssC11.indexOf(".n-dev-info .n-dev-model-info") < 0, "canvas.css：生效模型行样式已移除（body 精简）");
  const cssComp11 = read("renderer/css/components.css");
  ok(
    cssComp11.indexOf(".dev-model-pop") >= 0 && cssComp11.indexOf(".dev-model-list") >= 0,
    "components.css：模型选择弹层样式",
  );
  ok(
    cssComp11.indexOf(".dev-model-cells") >= 0 &&
      cssComp11.indexOf(".dev-model-cell-label") >= 0 &&
      cssComp11.indexOf(".dev-model-cell-value") >= 0,
    "components.css：三格 cell（预设 / 模型 / 思考强度）样式",
  );
  ok(cssComp11.indexOf("*/.dev-color-pop") < 0, "components.css：色板注释与规则不再粘连");
  const guide11 = read("guides/manual/dev-nodes.md");
  ok(guide11.indexOf("Agent 模型 / 预设 / 思考强度") >= 0, "中文手册小节改名为「Agent 模型 / 预设 / 思考强度」");
  ok(
    guide11.indexOf("devPreset") >= 0 && guide11.indexOf("devEffort") >= 0 && guide11.indexOf("三格") >= 0,
    "中文手册写明 devPreset / devEffort 与「预设 / 模型 / 思考强度」三格",
  );
  ok(guide11.indexOf("各自") >= 0 || guide11.indexOf("分别") >= 0, "中文手册写明三档分别就近继承");
  ok(guide11.indexOf("devColor") >= 0 && guide11.indexOf("HSV") >= 0, "中文手册写明节点颜色");
  const guideEn11 = read("guides/manual/en/dev-nodes.md");
  ok(
    guideEn11.indexOf("Agent model / preset / thinking effort") >= 0 && guideEn11.indexOf("devPreset") >= 0,
    "英文手册同步 Agent model / preset / thinking effort 小节",
  );
  const skill11 = read("mtnode-agent-skills/mtnode/dev-architect/SKILL.md");
  ok(skill11.indexOf("就近继承") >= 0, "dev-architect 技能说明模型就近继承");
  ok(
    skill11.indexOf("devPreset") >= 0 &&
      skill11.indexOf("devEffort") >= 0 &&
      skill11.indexOf("sketch") >= 0 &&
      skill11.indexOf("各自独立生效") >= 0,
    "dev-architect 技能补 devPreset / devEffort（旧 id 归一 · 三项各自独立继承）",
  );
  ok(skill11.indexOf("devColor") >= 0, "dev-architect 技能说明节点颜色");
  ok(read("mtnode-agent-skills/index.json").indexOf("devModel") >= 0, "技能索引已重建并含 devModel");
  ok(
    read("mtnode-agent-skills/index.json").indexOf("devPreset") >= 0,
    "技能索引已重建并含 devPreset（脚本生成，非手改）",
  );
  /* 「拷问我」内置技能：必须由脚本重建进索引（生成物，不能手改） */
  const skillIdx11 = read("mtnode-agent-skills/index.json");
  ok(skillIdx11.indexOf("mtnode-grill-me") >= 0, "技能索引已收录 mtnode-grill-me");
  ok(
    skillIdx11.indexOf('"path": "mtnode/grill-me/SKILL.md"') >= 0 ||
      skillIdx11.indexOf('"path":"mtnode/grill-me/SKILL.md"') >= 0,
    "索引指向 mtnode/grill-me/SKILL.md（与同分类内置技能同层级）",
  );
  ok(
    read("mtnode-agent-skills/INDEX.md").indexOf("mtnode-grill-me") >= 0,
    "INDEX.md 同步列出 mtnode-grill-me",
  );
  const grillSkill11 = read("mtnode-agent-skills/mtnode/grill-me/SKILL.md");
  ok(
    /^name:\s*mtnode-grill-me\s*$/m.test(grillSkill11),
    "SKILL.md frontmatter name 为 mtnode-grill-me（匹配索引的命名正则）",
  );
  ok(
    grillSkill11.indexOf("ask_user_question") >= 0 &&
      grillSkill11.indexOf("询问窗") >= 0 &&
      grillSkill11.indexOf("（推荐）") >= 0,
    "拷问技能第一纪律 = 用 ask_user_question 跳出 MTNode 询问窗，推荐项排第一位",
  );
  ok(
    grillSkill11.indexOf("把问题写成回复正文的编号列表") >= 0,
    "拷问技能明文否定「把问题当聊天正文罗列」（本轮修的 bug）",
  );
  ok(
    grillSkill11.indexOf("兜底") >= 0 && grillSkill11.indexOf("❓") >= 0,
    "旧的「❓ Q1 + ➡️ 推荐答案」正文模板只作为询问窗被权限关掉时的兜底保留",
  );
  const chg11 = read("CHANGELOG-v1.1.md");
  ok(
    chg11.indexOf("devModel") >= 0 && chg11.indexOf("就近向上继承") >= 0,
    "版本更新文档写明 Agent 模型与就近继承",
  );
  ok(
    chg11.indexOf("Agent 设定三格化") >= 0 && chg11.indexOf("devPreset") >= 0 && chg11.indexOf("devEffort") >= 0,
    "版本更新文档记录 Agent 设定三格化（新增 devPreset / devEffort）",
  );
  ok(
    read("dsh/gateway/canvas-plugin.mjs").indexOf("devPreset") >= 0 &&
      read("dsh/gateway/canvas-plugin.mjs").indexOf("devEffort") >= 0,
    "devPreset / devEffort 口径的唯一真源 = canvas 工具参数表（助手长文不再抄字段清单）",
  );
  ok(chg11.indexOf("devColor") >= 0, "版本更新文档写明节点自定义颜色");
  const i18n11 = require("../renderer/i18n.js");
  i18n11.setLocale("en");
  ok(i18n11.t("Agent 模型") !== "Agent 模型", "「Agent 模型」有英文词条");
  ok(i18n11.t("跟随默认（不指定）") !== "跟随默认（不指定）", "「跟随默认（不指定）」有英文词条");
  ok(i18n11.t("自动（跟随默认）") !== "自动（跟随默认）", "「自动（跟随默认）」有英文词条");
  ok(i18n11.t("Agent 设定") !== "Agent 设定", "「Agent 设定」（弹层标题）有英文词条");
  ok(i18n11.t("Agent 预设") !== "Agent 预设", "「Agent 预设」有英文词条");
  ok(i18n11.t("（继承）") !== "（继承）", "「（继承）」有英文词条");
  ok(i18n11.t("思考强度：") !== "思考强度：", "「思考强度：」有英文词条");
  ok(i18n11.t("本轮：") !== "本轮：", "建议作业日志「本轮：」有英文词条");
  ok(i18n11.t("未选择：跟随默认思考档（标准）。") !== "未选择：跟随默认思考档（标准）。", "思考格「未选择」说明有英文词条");
  i18n11.setLocale("zh");

  /* ==================== [12] 两段式概述（note）全链路 ==================== */
  console.log("\n[12] 两段式概述（note）：解析器 / 任务书 / 提示词 / 折叠卡展示");
  sb = makeSandbox(MODEL_JSON);
  const parts12 = (n) => ex(sb, "devNoteParts(" + JSON.stringify(n) + ")");
  const TWO_SEC =
    "【功能】积木式编排工作流：非技术用户可视化拼接\n【实现】Electron 渲染层，renderer/ 目录，app-canvas.js 负责画布";
  const pNew = parts12(TWO_SEC);
  ok(
    pNew.design === "积木式编排工作流：非技术用户可视化拼接" &&
      pNew.impl === "Electron 渲染层，renderer/ 目录，app-canvas.js 负责画布",
    "新格式：按行首【功能】/【实现】切成 design + impl",
  );
  const pHalf = parts12("【功能】: 功能说明\n【实现】: 实现说明");
  ok(
    pHalf.design === "功能说明" && pHalf.impl === "实现说明",
    "兼容半角冒号（【功能】: / 【实现】:）",
  );
  const pOnlyFn = parts12("【功能】只有功能段");
  ok(
    pOnlyFn.design === "只有功能段" && pOnlyFn.impl === "",
    "只有功能段 → impl 为空",
  );
  const pOld12 = parts12("一句话的单段概述");
  ok(
    pOld12.design === "一句话的单段概述" && pOld12.impl === "",
    "旧单段 note（无前缀）→ 整段归 design、impl 为空",
  );
  ok(parts12("").design === "" && parts12("").impl === "", "空 note → design/impl 皆空");
  /* devNodeContractText 住在 app.js（沙箱只装了 app-devnode.js）：按 [9.2] 同款方式切片注入 */
  const appjs12 = read("renderer/app.js");
  const ctA12 = appjs12.indexOf("function devNodeContractText(node");
  const ctB12 = appjs12.indexOf("/* 该功能块名下的会话");
  ok(ctA12 > 0 && ctB12 > ctA12, "[12] 定位 app.js 开发任务书源码（devNodeContractText）");
  const ctSb = makeSandbox(MODEL_JSON);
  vm.runInContext(appjs12.slice(ctA12, ctB12), ctSb, { filename: "app.js#devNodeContractText" });
  const ctNoteOf = (nid, t) =>
    ex(ctSb, "nodeById(" + JSON.stringify(nid) + ").note = " + JSON.stringify(t) + "; true");
  const ctOf = () => ex(ctSb, "devNodeContractText(nodeById('n1'))");
  ctNoteOf("n1", TWO_SEC);
  const ct12 = ctOf();
  ok(
    ct12.indexOf("模块功能（面向非技术）：") >= 0 &&
      ct12.indexOf("积木式编排工作流") >= 0,
    "开发任务书输出功能段标签与内容",
  );
  ok(
    ct12.indexOf("实现要点（面向技术）：") >= 0 &&
      ct12.indexOf("app-canvas.js 负责画布") >= 0,
    "开发任务书输出实现段标签与内容",
  );
  ok(
    ct12.indexOf("完成后按两段式规范") >= 0 &&
      ct12.indexOf("【功能】非技术说明") >= 0 &&
      ct12.indexOf("【实现】工程梗概") >= 0,
    "开发任务书收尾要求按两段式规范回写 note",
  );
  /* 「先拷问需求」开关（node.devGrill · 「开发」框 toggle）：开启 → 任务书多一段拷问契约 */
  const ctGrill12 = (mode, req) => {
    if (mode === "unset") ex(ctSb, "delete nodeById('n1').devGrill; true");
    else ex(ctSb, "nodeById('n1').devGrill = " + mode + "; true");
    return ex(
      ctSb,
      "devNodeContractText(nodeById('n1')" + (req ? ", " + JSON.stringify(req) : "") + ")",
    );
  };
  const ctOn12 = ctGrill12("true", "给下载加超时与重试");
  const grillLine12 =
    ctOn12.split("\n").filter((l) => l.indexOf("【拷问模式") === 0)[0] || "";
  ok(!!grillLine12, "devGrill 为真 → 任务书多出【拷问模式】整段（单段一行）");
  ok(
    grillLine12.indexOf("\n") < 0 && ctOn12.indexOf("mtnode-grill-me") >= 0,
    "拷问段要求先用 skill 工具加载内置技能 mtnode-grill-me",
  );
  ok(
    ctOn12.indexOf("不得修改任何文件") >= 0 &&
      ctOn12.indexOf("不得改画布") >= 0 &&
      ctOn12.indexOf("不得回写 note / devStatus / devFiles") >= 0 &&
      ctOn12.indexOf("不得出实施计划") >= 0,
    "拷问段逐项禁止：改文件 / 改画布 / 回写 note·devStatus·devFiles / 出计划",
  );
  ok(
    grillLine12.indexOf("ask_user_question") >= 0 &&
      grillLine12.indexOf("询问窗") >= 0 &&
      grillLine12.indexOf("一次把整个前沿的全部问题问完") >= 0 &&
      grillLine12.indexOf("（推荐）") >= 0,
    "拷问段写明每轮走 ask_user_question 询问窗、一次问完整前沿 + 推荐项排第一",
  );
  ok(
    grillLine12.indexOf("禁止把问题编号列在回复正文里") >= 0 &&
      grillLine12.indexOf("编号 Q1/Q2") < 0 &&
      grillLine12.indexOf("➡️") < 0,
    "拷问段明文否定「把 Q1/Q2 列在回复正文」的旧口径（grill-me 不走 MTNode 询问格式的根因）",
  );
  /* 询问窗本身要能承载拷问的答案：每题的推荐理由必须看得见（不再只挂在 title 悬浮） */
  const ixc12 = read("renderer/app-db.js");
  const ixcCss12 = read("renderer/css/dsh.css");
  ok(
    ixc12.indexOf('txt.className = "ix-opt-label"') >= 0 &&
      ixc12.indexOf('d.className = "ix-opt-desc"') >= 0 &&
      ixc12.indexOf("d.textContent = o.description") >= 0,
    "询问卡选项把 description 渲染成第二行文字（grill-me 的推荐理由在卡片里直接可见）",
  );
  ok(
    ixc12.indexOf("cb.dataset.qid = q.id") >= 0 &&
      ixc12.indexOf("cb.value = o.label") >= 0,
    "改成两行结构后勾选框仍是 value=标签 / dataset.qid=题号（回答收集口径不变）",
  );
  ok(
    /\.ix-opt-desc\s*\{[^}]*color:\s*var\(--muted\)/.test(ixcCss12) &&
      ixcCss12.indexOf(".ix-opt-label") >= 0,
    "dsh.css 有 .ix-opt-label / .ix-opt-desc 两套样式（第二行淡灰、不抢主标签）",
  );
  ok(
    ctOn12.indexOf("确认无歧义") >= 0,
    "拷问段要求得到用户明确确认后才开工",
  );
  /* 位置：本次开发需求之后、默认回写要求之前 */
  const iReq12 = ctOn12.indexOf("本次开发需求：");
  const iGrill12 = ctOn12.indexOf("【拷问模式");
  const iWrite12 = ctOn12.indexOf("完成后按两段式规范");
  ok(
    iReq12 >= 0 && iReq12 < iGrill12 && iGrill12 < iWrite12,
    "拷问段插在「本次开发需求」之后、回写要求之前",
  );
  /* 零回归：未设 / false / 真值但不是 true，任务书都逐字不变 */
  const ctOff12 = ctGrill12("unset", "给下载加超时与重试");
  ok(
    ctGrill12("false", "给下载加超时与重试") === ctOff12 &&
      ctGrill12("'yes'", "给下载加超时与重试") === ctOff12 &&
      ctGrill12("1", "给下载加超时与重试") === ctOff12,
    "devGrill 未设 / false / 非 true 的真值 → 任务书与改前逐字一致",
  );
  ok(
    ctOff12.indexOf("拷问") < 0 && ctOff12.indexOf("grill") < 0,
    "关闭时任务书里不出现任何拷问字样（不污染未开启的会话）",
  );
  ok(
    ctOn12.split("\n").filter((l) => l.indexOf("【拷问模式") !== 0).join("\n") === ctOff12,
    "开启版去掉拷问段后与关闭版完全相同（只多这一段）",
  );
  ctGrill12("unset");
  const st12 = ex(sb, "devSuggestContextText(nodeById('n1'), '')");
  ok(
    st12.indexOf("模块功能（面向非技术）：") >= 0 &&
      st12.indexOf("实现要点（面向技术）：") >= 0,
    "建议上下文同样输出两段标签",
  );
  ctNoteOf("n1", "旧版一句话概述");
  const cOld12 = ctOf();
  ok(
    cOld12.indexOf("实现要点（面向技术）：") >= 0 &&
      cOld12.indexOf("（暂无 · 细化或开发时按两段式规范补全）") >= 0,
    "旧单段 note：开发任务书实现段给「暂无」引导",
  );
  ok(
    ex(sb, "devSuggestContextText(nodeById('n1'), '')").indexOf(
      "（暂无 · 实现方案梗概待补）",
    ) >= 0,
    "建议上下文：实现段提示待补",
  );
  ctNoteOf("n1", "");
  ok(
    ctOf().indexOf("（暂无 · 请先说明该模块在业务上做什么、给谁用）") >= 0,
    "空 note：开发任务书给功能段引导文案",
  );
  ex(sb, "__r12 = " + JSON.stringify(parse(MODEL_JSON)));
  const brief12 = ex(sb, "devSuggestBriefText(nodeById('n1'), __r12, ['o1','o3'], '')");
  ok(
    brief12.indexOf("完成后按两段式规范") >= 0 &&
      brief12.indexOf("【实现】工程梗概") >= 0,
    "「建议→开发」任务书收尾同样要求按两段式回写 note",
  );
  /* 四处提示词 / 技能真源：两段式关键词在场，防日后改回单段 */
  const gw12 = read("dsh/gateway/canvas-plugin.mjs");
  ok(
    gw12.indexOf("note 两段") >= 0 &&
      gw12.indexOf("【功能】") >= 0 &&
      gw12.indexOf("【实现】") >= 0,
    "网关工具描述：note 必须两段（【功能】+【实现】）",
  );
  ok(
    (gw12.match(/两段/g) || []).length >= 2,
    "网关工具描述两处（EDIT_DESC 硬规则 + note 参数说明）保留两段约束（update 与 create 共用同一份属性表，不再各抄一遍）",
  );
  const gm12 = read("dsh/gateway/gateway.mjs");
  /* 两段式的真源 = 工具描述（参数机制）+ 助手行为纪律 + 技能；人设档不再抄第三份 */
  ok(
    gm12.indexOf("TWO sections") < 0 &&
      read("dsh/gateway/canvas-plugin.mjs").indexOf("【功能】") >= 0 &&
      read("renderer/app-assist.js").indexOf("【功能】") >= 0,
    "Agent 人设去过重：note 两段式只在工具描述与助手纪律里各一份",
  );
  const as12 = read("renderer/app-assist.js");
  ok(
    as12.indexOf("note 必须两段") >= 0 &&
      as12.indexOf("【功能】") >= 0 &&
      as12.indexOf("【实现】") >= 0,
    "助手画布提示词：note 必须两段",
  );
  const sk12 = read("mtnode-agent-skills/mtnode/dev-architect/SKILL.md");
  ok(
    sk12.indexOf("两段") >= 0 &&
      sk12.indexOf("【功能】") >= 0 &&
      sk12.indexOf("【实现】") >= 0,
    "dev-architect 技能：概述固定分两段",
  );
  /* 渲染展示：折叠卡只显功能段、tooltip 给完整两段、概览行与子元素行只用功能段 */
  const cv12 = read("renderer/app-canvas.js");
  const descAt12 = cv12.indexOf('fd.className = "super-folder-desc"');
  const descBlk12 = cv12.slice(descAt12, descAt12 + 320);
  ok(descAt12 > 0, "[12] 定位折叠卡 super-folder-desc 渲染代码");
  ok(
    descBlk12.indexOf("_p && _p.impl ? _p.design || fNote : fNote") >= 0,
    "折叠卡 desc：两段齐全时只写 design（功能段），无实现段才退回整段 note",
  );
  ok(
    descBlk12.indexOf("(_p && _p.impl) ? fNote") >= 0,
    "折叠卡 tooltip：有实现段时 hover 显示完整两段",
  );
  ok(
    cv12.indexOf("devNoteDisplayText(supNoteTxt)") >= 0,
    "「描述」按钮 tooltip 走 devNoteDisplayText（完整两段）",
  );
  ok(
    read("renderer/app-devnode.js").indexOf(
      "const design = devNoteParts(n && n.note).design",
    ) >= 0,
    "进度树概览行（devNodeBriefLine）只取功能段",
  );
  ok(
    read("renderer/app.js").indexOf(
      "const design = devNoteParts(k && k.note).design",
    ) >= 0,
    "子元素行内（devChildLabel）只显功能段",
  );

  /* ==================== [13] 细化＝深度（多层下钻，不是单层展开） ==================== */
  console.log("\n[13] 细化按「深度」：子树统计 / 对话框深度单选 / 多层任务书 / 到底拦截");
  const appjs13 = read("renderer/app.js");
  const refSrc13 = appjs13.slice(
    appjs13.indexOf("/* ============ 开发节点：元素类型（devKind）与细化 ============ */"),
    appjs13.indexOf("/* 端子悬浮"),
  );
  ok(refSrc13.length > 3000, "[13] 截出 app.js 细化实现段（devKind → refineDevNode）");
  /* 草稿三件套（devDraftOf / devDraftSet / devDraftTextareaOpts）在 app-devnode.js：
     细化 / 开发对话框都调它，切片一起装进沙箱跑真逻辑，不写假桩 */
  const devnode13Src = read("renderer/app-devnode.js");
  const draftA13 = devnode13Src.indexOf("const DEV_DRAFT_MAX");
  const draftB13 = devnode13Src.indexOf("/* ---------- 进度上下文");
  ok(draftA13 > 0 && draftB13 > draftA13, "[13] 截出 app-devnode.js 的草稿三件套源码");
  const draftSliceSrc = devnode13Src.slice(draftA13, draftB13);

  /* 把实现段真的跑起来（迷你 DOM + 依赖桩），而不是只做字符串比对 */
  function makeDepthSandbox() {
    const nodes = [
      /* t1：一路拆到底 —— 模块 → 模块 → 文件 → 类（3 层，叶子无模块） */
      { id: "t1", kind: "super", dev: true, devKind: "module", devStatus: "wip", title: "渲染层", devPath: "E:/dev/tools/pipeline-console" },
      { id: "a1", kind: "super", dev: true, devKind: "module", title: "画布交互", parentSuperId: "t1" },
      { id: "f11", kind: "super", dev: true, devKind: "file", title: "app-canvas.js", parentSuperId: "a1" },
      { id: "c11", kind: "super", dev: true, devKind: "class", title: "CanvasLayer", parentSuperId: "f11" },
      { id: "f12", kind: "super", dev: true, devKind: "file", title: "app-devnode.js", parentSuperId: "t1" },
      { id: "io1", kind: "super_io", title: "端子", parentSuperId: "a1" },
      /* t2：仍有模块叶子没拆到文件级 —— 可继续深度细化 */
      { id: "t2", kind: "super", dev: true, devKind: "module", title: "总览", devPath: "E:/dev/tools/pipeline-console" },
      { id: "a2", kind: "super", dev: true, devKind: "module", title: "网关", parentSuperId: "t2" },
      { id: "f21", kind: "super", dev: true, devKind: "file", title: "gateway.mjs", parentSuperId: "a2" },
      { id: "a3", kind: "super", dev: true, devKind: "module", title: "未拆的模块", parentSuperId: "t2" },
      { id: "t3", kind: "super", dev: true, devKind: "module", title: "空模块" },
      /* f5：文件已全拆成类图元素 · f6：空文件（还能拆） · c6：类（最细） */
      { id: "f5", kind: "super", dev: true, devKind: "file", title: "db-store.js" },
      { id: "c5", kind: "super", dev: true, devKind: "class", title: "DbStore", parentSuperId: "f5" },
      { id: "i5", kind: "super", dev: true, devKind: "interface", title: "IDb", parentSuperId: "f5" },
      { id: "f6", kind: "super", dev: true, devKind: "file", title: "main.js" },
      { id: "c6", kind: "super", dev: true, devKind: "class", title: "Foo" },
      { id: "plain", kind: "proc_text", title: "普通节点" },
    ];
    const byId = (id) => nodes.filter((n) => n.id === id)[0] || null;
    const sb = {
      console,
      setTimeout,
      Promise,
      JSON,
      S: { wf: { nodes }, agentActiveId: "" },
      /* 中文语料桩：与 i18n.js 的 {x} 插值行为一致 */
      I18n: {
        t: (k, vars) =>
          String(k).replace(/\{(\w+)\}/g, (_, n) =>
            vars && vars[n] != null ? String(vars[n]) : "",
          ),
      },
      nodeById: byId,
      nodeParentSuperId: (n) => n.parentSuperId,
      isSuperIoNode: (n) => n.kind === "super_io",
      devNoteParts: (s) => ({ design: String(s || ""), impl: "" }),
      devNoteDialogField: (n) => ({ text: String((n && n.note) || "") }),
      devPathOf: (n) => String((n && n.devPath) || ""),
      scheduleSave() {},
      pushHistory() {},
      renderCanvas() {},
      updateRunQueuePanel() {},
      persistAgentSession: () => Promise.resolve(),
      document: { createElement: (t) => mkEl(t) },
      __forms: [],
      __formResolve: null,
      __sess: null,
      __sends: [],
      __toasts: [],
      mtDialogForm: (opts) => {
        sb.__forms.push(opts);
        /* 对话框挂起等用户：点档位时不该把它 resolve 掉 */
        return new Promise((res) => {
          sb.__formResolve = res;
        });
      },
      createDevSessionForNode: (node) => {
        sb.__sess = {
          id: "sess-" + node.id,
          title: "细化 · " + node.title,
          messages: [{ role: "user", content: "（占位）", _src: "dev-node" }],
        };
        return sb.__sess;
      },
      agentSessionSend: (text, opts) => {
        sb.__sends.push({ text, opts });
        return Promise.resolve();
      },
      toast: (m) => {
        sb.__toasts.push(String(m));
      },
    };
    /* 草稿三件套（devDraftOf / devDraftSet / devDraftTextareaOpts）住在 app-devnode.js，
       细化切片要用 → 先在同一上下文里把这段真源码装进去，不写假桩 */
    const ctx13 = vm.createContext(sb);
    vm.runInContext(draftSliceSrc, ctx13, { filename: "app-devnode-draft.js" });
    vm.runInContext(refSrc13, ctx13, { filename: "app-refine-slice.js" });
    return sb;
  }
  const sb13 = makeDepthSandbox();
  const exD = (sb, expr) => vm.runInContext(expr, sb);
  ok(
    exD(sb13, "devChildrenOf(nodeById('a1')).map(function(n){return n.id}).join(',')") ===
      "f11",
    "devChildrenOf 排除 super_io 桥接端子（细化统计不被端子污染）",
  );

  /* ---- 深度统计：递归层数 / 叶子元素类型分布 / 未到文件级的块 ---- */
  const st1 = exD(sb13, "devDescendantStatsOf(nodeById('t1'))");
  ok(st1.count === 4 && st1.levels === 3, "子树统计递归到底：4 块 · 3 层（不止本层）");
  ok(st1.shallow.length === 0, "每片叶子都到文件 / 类级 → 未到文件级的块为 0");
  ok(st1.fileLeaves.length === 1 && st1.leafKinds.class === 1, "叶子类型分布可统计（1 文件 + 1 类）");
  const st2 = exD(sb13, "devDescendantStatsOf(nodeById('t2'))");
  ok(st2.levels === 2 && st2.shallow.length === 1, "模块叶子仍算「未到文件级」");
  ok(
    exD(sb13, "devDepthSummaryText(nodeById('t2'))") ===
      "当前已 2 层 · 1 个块未到文件级（如 未拆的模块）",
    "深度现状一句话：层数 + 未到文件级块数 + 示例标题",
  );
  ok(
    exD(sb13, "devDepthSummaryText(nodeById('t1'))") === "当前已 3 层 · 已细化到文件级",
    "深度现状一句话：已到文件级",
  );
  ok(
    exD(sb13, "devDepthSummaryText(nodeById('t3'))") === "当前 0 层（尚未展开下层元素）",
    "从未展开过就如实说 0 层（不编造深度）",
  );

  /* ---- 无需 / 无法细化的判定（不再只对「无子块」开口） ---- */
  ok(
    exD(sb13, "devRefineBlockedReason(nodeById('c6'))").indexOf("最细粒度") >= 0,
    "类 / 接口 / 枚举：仍按最细粒度直接拦截",
  );
  ok(
    exD(sb13, "devRefineBlockedReason(nodeById('f5'))").indexOf(
      "该文件已展开为类 / 接口 / 枚举，已细化到无法再细。",
    ) >= 0,
    "文件已全拆成类图元素 → 已细化到无法再细",
  );
  ok(exD(sb13, "devRefineBlockedReason(nodeById('f6'))") === "", "空文件块放行（还能拆类 / 接口 / 枚举）");
  const b1 = exD(sb13, "devRefineBlockedReason(nodeById('t1'))");
  ok(
    b1.indexOf("本功能块已细化到无法再细") >= 0 && b1.indexOf("子树 3 层") >= 0,
    "整棵子树叶子都已到文件 / 类级 → 拦截并说明层数",
  );
  ok(
    b1.indexOf("请在该文件块上单独点「细化」") >= 0,
    "拦截理由给出下一步（到具体文件块上单独细化）",
  );
  ok(
    exD(sb13, "devRefineBlockedReason(nodeById('t2'))") === "" &&
      exD(sb13, "devRefineBlockedReason(nodeById('t3'))") === "",
    "仍有模块未到文件级 / 从未展开 → 放行继续深度细化",
  );

  /* ---- 细化任务书：多层递归契约 ---- */
  const pDeep = exD(sb13, "devRefinePrompt(nodeById('t2'), '', 'deep')");
  const pOnce = exD(sb13, "devRefinePrompt(nodeById('t2'), '只拆网关目录', 'once')");
  const pUndef = exD(sb13, "devRefinePrompt(nodeById('t2'))");
  ok(
    pDeep.indexOf("本次细化深度：深度细化（逐层下钻到无法再细，一般到文件级）") >= 0,
    "深度档位写进任务书抬头",
  );
  ok(
    pDeep.indexOf("当前子树深度：当前已 2 层 · 1 个块未到文件级") >= 0,
    "任务书带上本块当前子树深度",
  );
  ok(pDeep.indexOf("「细化」指的是**深度**") >= 0, "任务书开头给「细化＝深度」定调");
  ok(pDeep.indexOf("不得只规划一层就收工") >= 0, "深度模式禁止只规划一层就收工");
  ok(
    pDeep.indexOf("本块是否还能继续下钻、已经下钻到哪一层") >= 0,
    "第 0 步改为按深度判断可否继续下钻",
  );
  ok(
    pDeep.indexOf("多层规划树") >= 0 && pDeep.indexOf("是否还需继续下钻") >= 0,
    "梗概输出多层树 + 每块标注是否继续下钻",
  );
  ok(
    pDeep.indexOf("一次确认覆盖整棵规划树") >= 0 && pDeep.indexOf("不是逐层反复追问") >= 0,
    "确认门禁 = 一次确认覆盖整棵规划树",
  );
  ok(
    pDeep.indexOf("自顶向下**逐层创建**") >= 0 &&
      pDeep.indexOf("每层各一次 mtnode_canvas_edit") >= 0,
    "确认后自顶向下逐层创建（每层一次 edit）",
  );
  ok(
    pDeep.indexOf("parentSuperId 指向它的直接父块") >= 0 &&
      pDeep.indexOf("上一层刚创建的块") >= 0,
    "深层子块挂到刚建好的父块（真的会多层嵌套）",
  );
  ok(pDeep.indexOf("禁止把不同层级一次性平铺到同一层") >= 0, "明确禁止把各层平铺到同一层");
  ok(
    pDeep.indexOf("约 >12 个）时分批") >= 0 && pDeep.indexOf("约 60 个为上限") >= 0,
    "护栏：单层过多分批 + 本次新建总数约 60 上限",
  );
  ok(
    pDeep.indexOf("询问用户是否继续下钻") >= 0 && pDeep.indexOf("待续下钻") >= 0,
    "触顶 / 证据不足时停下问用户，并标「待续下钻」",
  );
  ok(pDeep.indexOf("子块：A / B / C") >= 0, "要求回写各父块 note 的「子块」行");
  ok(
    pDeep.indexOf("本次新增到第几层") >= 0 && pDeep.indexOf("叶子元素类型分布") >= 0,
    "结尾报告最终层数与叶子分布",
  );
  ok(pUndef.indexOf("深度细化（逐层下钻到无法再细") >= 0, "不传 depth 时默认走深度细化");
  ok(pOnce.indexOf("只展开本层（1 层 · 不下钻）") >= 0, "「只展开本层」档位写进任务书");
  ok(pOnce.indexOf("仅在本块内创建 1 层子块，不做下钻") >= 0, "只展开本层模式明确不下钻");
  ok(pOnce.indexOf("不得只规划一层就收工") < 0, "只展开本层时不注入深度模式的强制下钻要求");
  ok(pOnce.indexOf("用户指定的细化范围：只拆网关目录") >= 0, "用户填的细化范围照旧并入任务书");
  [
    "文件节点的路径与新建内容都要符合「目录约定」",
    "不要调用 mtnode-dev-architect 技能",
    "rel:true",
    "#6db4ff",
    "【功能】非技术说明 + 【实现】工程梗概",
  ].forEach((k) => ok(pDeep.indexOf(k) >= 0, "深度任务书保留既有约束：" + k.slice(0, 18)));

  /* ---- 对话框：深度现状行 + 深度单选（点选不关窗）→ 选中值真的传进任务书 ---- */
  const custSrc = refSrc13.slice(
    refSrc13.indexOf("custom: blocked"),
    refSrc13.indexOf("actions: blocked"),
  );
  ok(
    custSrc.indexOf("ev.preventDefault()") >= 0 && custSrc.indexOf("depth = it.key") >= 0,
    "custom 槽点档位只 preventDefault + 改闭包变量",
  );
  ok(custSrc.indexOf("select(") < 0, "custom 槽不调 select（点档位不会立即关闭对话框）");

  const sbD = makeDepthSandbox();
  const pD = exD(sbD, "refineDevNode(nodeById('t2'))");
  await drain(4);
  ok(sbD.__forms.length === 1 && sbD.__sess === null, "「细化」第一步只弹确认对话框，未确认不开工");
  const form13 = sbD.__forms[0];
  ok(
    form13.rows.some((r) => r[0] === "细化深度" && r[1].indexOf("当前已 2 层") >= 0),
    "对话框 rows 列出「细化深度」现状行",
  );
  ok(typeof form13.custom === "function", "可细化时给出深度单选（custom 槽非空）");
  const cont13 = mkEl("div");
  form13.custom(cont13);
  const optRows = rowsOf(cont13);
  const rbOf = (row) => row.childNodes.filter((c) => c.type === "radio")[0] || null;
  ok(cont13.textContent.indexOf("细化深度（单选）") >= 0, "单选组带「细化深度（单选）」标题");
  ok(optRows.length === 2, "深度单选渲染出 2 个档位");
  ok(
    titleOf(optRows[0]) === "深度细化到无法再细" && titleOf(optRows[1]) === "只展开本层",
    "两个档位标题取自 DEV_REFINE_DEPTHS",
  );
  ok(
    rbOf(optRows[0]).checked &&
      rbOf(optRows[0]).name === "devRefineDepth" &&
      !rbOf(optRows[1]).checked,
    "默认选中「深度细化到无法再细」（radio 同组互斥）",
  );
  ok(
    optRows[0].classList.contains("on") && !optRows[1].classList.contains("on"),
    "选中档位带 .on 样式（沿用 mt-sug-opt 观感）",
  );
  optRows[1].onclick({ preventDefault() {} });
  ok(
    !rbOf(optRows[0]).checked && rbOf(optRows[1]).checked,
    "点「只展开本层」→ 选中态切换",
  );
  ok(
    !optRows[0].classList.contains("on") && optRows[1].classList.contains("on"),
    "两个档位的 .on 样式互斥跟随点击",
  );
  ok(sbD.__sess === null && sbD.__forms.length === 1, "点档位不关闭对话框、也不启动会话");
  /* 深度选择随草稿留存（与输入内容同一条纪律：取消后再开不用重做） */
  ok(
    exD(sbD, "nodeById('t2').devDraft && nodeById('t2').devDraft.refineDepth") === "once",
    "点过的深度档位写进 node.devDraft.refineDepth",
  );
  const sbR = makeDepthSandbox();
  exD(sbR, "nodeById('t2').devDraft = { refine: '只拆 dsh 目录', refineDepth: 'once' }");
  const pR = exD(sbR, "refineDevNode(nodeById('t2'))");
  await drain(4);
  const fR = sbR.__forms[0];
  ok(
    fR.textarea.value === "只拆 dsh 目录" && fR.textarea.draft === true,
    "重开细化框：上次未提交的细化范围原样回填 + 打上「已恢复」标记",
  );
  const contR = mkEl("div");
  fR.custom(contR);
  ok(
    rbOf(rowsOf(contR)[1]).checked === true && !rbOf(rowsOf(contR)[0]).checked,
    "重开细化框：上次选的「只展开本层」仍是选中态（深度不重选）",
  );
  fR.onText("改成拆 dsh + gateway");
  ok(
    exD(sbR, "nodeById('t2').devDraft.refine") === "改成拆 dsh + gateway",
    "细化框每次输入都实时写回草稿（onText）",
  );
  sbR.__formResolve({ action: "go", text: "改成拆 dsh + gateway" });
  await pR;
  ok(
    exD(sbR, "nodeById('t2').devDraft.refine === undefined") === true &&
      exD(sbR, "nodeById('t2').devDraft.refineDepth === undefined") === true,
    "确认开工后草稿清空（范围 + 深度），下次打开是空白默认",
  );
  sbD.__formResolve({ action: "go", text: "" });
  await pD;
  ok(!!sbD.__sess, "点「确认细化」后新建绑定的细化会话");
  ok(
    sbD.__sess._devContract.indexOf("本次细化深度：只展开本层（1 层 · 不下钻）") >= 0,
    "对话框里选中的深度值真的传进了 devRefinePrompt（并入会话任务书）",
  );
  ok(
    sbD.__sess.messages[0].content === "只展开本层（1 层）细化该功能块",
    "会话首条可见消息体现所选深度",
  );

  const sbE = makeDepthSandbox();
  const pE = exD(sbE, "refineDevNode(nodeById('t2'))");
  await drain(4);
  sbE.__formResolve({ action: "go", text: "只拆网关" });
  await pE;
  ok(
    sbE.__sess._devContract.indexOf("深度细化（逐层下钻到无法再细") >= 0,
    "不动深度单选时按默认「深度细化」下发任务书",
  );
  ok(
    sbE.__sess.messages[0].content.indexOf(
      "深度细化该功能块：逐层下钻到无法再细（一般文件级）",
    ) >= 0,
    "首条可见消息默认体现深度细化",
  );
  ok(
    sbE.__sess.messages[0].content.indexOf("用户指定的细化范围：只拆网关") >= 0,
    "填了范围时首条消息带上范围",
  );
  ok(
    sbE.__sends.length === 1 && sbE.__sends[0].opts._devContract === true,
    "细化会话按会话契约（_devContract）发送",
  );

  const sbB = makeDepthSandbox();
  const pB = exD(sbB, "refineDevNode(nodeById('t1'))");
  await drain(4);
  ok(sbB.__forms[0].warn.indexOf("已细化到无法再细") >= 0, "已细化到底 → 对话框 warn 说明原因");
  ok(sbB.__forms[0].custom === null, "拦截态不再给深度单选");
  ok(sbB.__forms[0].textarea === null, "拦截态不给细化范围输入");
  ok(
    sbB.__forms[0].actions.map((a) => a.label).join("|") === "知道了",
    "拦截态只有「知道了」一个按钮",
  );
  sbB.__formResolve({ action: "cancel" });
  await pB;
  ok(sbB.__sess === null && sbB.__sends.length === 0, "拦截态不会偷偷开细化会话");

  const sbN = makeDepthSandbox();
  await exD(sbN, "refineDevNode(nodeById('plain'))");
  await exD(sbN, "refineDevNode(null)");
  await drain(2);
  ok(sbN.__forms.length === 0, "非开发节点 / 空节点：什么都不做");

  /* ---- 入口与建议上下文的深度口径（任务 3 的接线防回归） ---- */
  const canvas13 = read("renderer/app-canvas.js");
  ok(
    canvas13.indexOf('I18n.t("细化（选择深度：只展开本层 / 下钻到无法再细…）")') >= 0,
    "右键菜单「细化」体现深度两档口径",
  );
  ok(
    canvas13.indexOf("弹窗先选「细化深度」") >= 0,
    "折叠卡「细化」按钮 tooltip 说明深度选择",
  );
  const devn13 = read("renderer/app-devnode.js");
  ok(
    devn13.indexOf("细化深度现状（细化＝深度，非本层展开数量）：") >= 0,
    "建议 / 问询上下文补「细化深度现状」行",
  );
  ok(
    (devn13.match(/devDepthLineOf\(node\)/g) || []).length >= 2,
    "建议与问询两处都取深度现状",
  );
  ok(
    devn13.indexOf("如按深度继续细化——把子块逐层下钻到文件 / 类级") >= 0,
    "「建议」把深度细化列为下一步方案",
  );

  /* ---- 英文词条：细化实现段全部文案有译文（沿用 [8] 的抽取方式） ---- */
  const i18n13 = require("../renderer/i18n.js");
  i18n13.setLocale("en");
  const keys13 = new Set();
  const re13 = /I18n\.t\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m13;
  while ((m13 = re13.exec(refSrc13))) {
    let k13 = m13[2];
    if (m13[1] === "'") k13 = k13.replace(/\\'/g, "'");
    else {
      try {
        k13 = JSON.parse('"' + k13 + '"');
      } catch (_) {}
    }
    if (k13.indexOf("\n") >= 0) continue;
    keys13.add(k13);
  }
  const missing13 = [...keys13].filter((k) => i18n13.t(k) === k);
  missing13.slice(0, 10).forEach((k) => console.log("        MISSING " + JSON.stringify(k)));
  ok(missing13.length === 0, "细化实现段全部文案有英文词条（共 " + keys13.size + " 条）");
  ok(keys13.size > 40, "细化文案抽取有效（抽到 " + keys13.size + " 条 I18n.t）");
  const depthOpts = exD(sb13, "DEV_REFINE_DEPTHS.map(function (x) { return [x.key, x.label, x.desc]; })");
  ok(
    depthOpts.length === 2 && depthOpts[0][0] === "deep" && depthOpts[1][0] === "once",
    "两档深度定义在场（deep 默认 · once 只展开本层）",
  );
  ok(
    depthOpts.filter((x) => i18n13.t(x[1]) === x[1] || i18n13.t(x[2]) === x[2]).length === 0,
    "两个深度选项的标题与说明都有英文词条",
  );
  ok(
    i18n13.t("当前已 {n} 层 · {m} 个块未到文件级", { n: 2, m: 1 }).indexOf("2 layer") >= 0 &&
      i18n13.t("当前已 {n} 层 · {m} 个块未到文件级", { n: 2, m: 1 }).indexOf("file level") >= 0,
    "深度现状词条的英文译文占位符可插值",
  );
  ok(i18n13.t("细化深度现状（细化＝深度，非本层展开数量）：") !== "细化深度现状（细化＝深度，非本层展开数量）：", "建议上下文深度行有英文词条");
  i18n13.setLocale("zh");

  /* ==================== [14] 对话框草稿：取消 / 跳出都不吞用户输入 ==================== */
  console.log("\n[14] 开发节点对话框草稿：实时留存 · 重开回填 · 一键丢弃 · 开工清空");
  const appjs14 = read("renderer/app.js");
  const devnode14 = read("renderer/app-devnode.js");
  const dlgA14 = appjs14.indexOf("function mtDialogForm(opts) {");
  const dlgB14 = appjs14.indexOf("function nodeGuideId(node) {");
  const devA14 = appjs14.indexOf("async function developDevNode(node) {");
  const devB14 = appjs14.indexOf("/* 「开发」与「建议 → 开发」共用的收尾");
  ok(dlgA14 > 0 && dlgB14 > dlgA14, "[14] 截出 app.js 真实对话框实现 mtDialogForm");
  ok(devA14 > 0 && devB14 > devA14, "[14] 截出 app.js「开发」入口 developDevNode");
  const bodyOf = (sb) => sb.__host.querySelector("#mtDlgBody");
  const listTa = (sb) => (bodyOf(sb) || { querySelectorAll: () => [] }).querySelectorAll("textarea");
  const btnIn = (sb, label) =>
    ((bodyOf(sb) || { querySelectorAll: () => [] }).querySelectorAll("button") || []).filter(
      (b) => b.textContent === label,
    )[0] || null;
  const mkDlgSandbox = () => {
    const s = makeSandbox(MODEL_JSON);
    /* 迷你 DOM 的 #mtDlg* 挂在未进 body 的宿主上：让 getElementById 查得到宿主内部 */
    s.document.getElementById = function (id) {
      if (this.body.id === id) return this.body;
      for (const d of walk(s.__host, [])) if (d.id === id) return d;
      return null;
    };
    const ctx = vm.createContext(s);
    vm.runInContext(appjs14.slice(dlgA14, dlgB14), ctx, { filename: "app.js#mtDialogForm" });
    vm.runInContext(appjs14.slice(devA14, devB14), ctx, { filename: "app.js#developDevNode" });
    return s;
  };
  const sbE14 = mkDlgSandbox();
  const n14 = sbE14.__nodes.filter((n) => n.id === "n1")[0];
  const p14a = ex(sbE14, "developDevNode(nodeById('n1'))");
  await drain();
  ok(!!listTa(sbE14)[0], "「开发」框渲染出内容输入框");
  ok(listTa(sbE14)[0].value === "", "首次打开为空白（无草稿）");
  ok(!btnIn(sbE14, "清空草稿"), "无草稿时不出现「清空草稿」");
  listTa(sbE14)[0].value = "先补超时与重试";
  listTa(sbE14)[0].fire("input");
  ok(n14.devDraft && n14.devDraft.dev === "先补超时与重试", "每次输入实时写回 node.devDraft.dev");
  ok(sbE14.__saves > 0, "草稿写入走防抖存盘（随工作流落盘）");
  listTa(sbE14)[0].value = "   ";
  listTa(sbE14)[0].fire("input");
  ok(!n14.devDraft.dev, "纯空白不存草稿（不该留下待恢复内容）");
  listTa(sbE14)[0].value = "先补超时与重试，再补日志";
  listTa(sbE14)[0].fire("input");
  /* ① 点「取消」：内容留在草稿里，且绝不开工 */
  footBtn(sbE14.__host, "取消").onclick();
  await p14a;
  ok(n14.devDraft.dev === "先补超时与重试，再补日志", "点「取消」后输入内容完整保留");
  ok(sbE14.__devCalls.length === 0, "取消不会开工");
  /* ② 再次打开：原样回填 + 给出可丢弃入口 */
  const p14b = ex(sbE14, "developDevNode(nodeById('n1'))");
  await drain();
  ok(listTa(sbE14)[0].value === "先补超时与重试，再补日志", "再次打开自动回填上次内容");
  ok(!!btnIn(sbE14, "清空草稿"), "回填了草稿 → 出现「清空草稿」按钮");
  ok(bodyOf(sbE14).textContent.indexOf("已恢复上次未提交的内容") >= 0, "草稿行说明这是恢复的内容");
  btnIn(sbE14, "清空草稿").onclick();
  ok(listTa(sbE14)[0].value === "", "「清空草稿」立刻清掉输入框");
  ok(!n14.devDraft.dev, "「清空草稿」同时抹掉留存草稿（下次不再冒出同一份）");
  /* ③ 真正提交：会话拿到内容，草稿随之清空 */
  listTa(sbE14)[0].value = "本轮只做错误处理";
  listTa(sbE14)[0].fire("input");
  footBtn(sbE14.__host, "开始开发").onclick();
  await p14b;
  ok(sbE14.__devCalls.length === 1, "点「开始开发」→ 与原来同一条路径开工");
  ok(sbE14.__devCalls[0].text === "本轮只做错误处理", "开工正文 = 框里填写的内容");
  ok(!n14.devDraft.dev, "提交后草稿清空（下次打开不带重复内容）");
  /* ④ 被别的事务顶出对话框（同一宿主被后开的框接管，本框永不结算）：内容同样不丢 */
  const sbF14 = mkDlgSandbox();
  const n14f = sbF14.__nodes.filter((n) => n.id === "n1")[0];
  ex(sbF14, "developDevNode(nodeById('n1'))");
  await drain();
  listTa(sbF14)[0].value = "写到一半被别的事打断";
  listTa(sbF14)[0].fire("input");
  ex(sbF14, "mtDialogForm({ title: '另一个弹窗', msg: '别的事务' })");
  await drain();
  ok(n14f.devDraft.dev === "写到一半被别的事打断", "被其它弹窗顶出去：已写内容留在草稿里");
  const p14c = ex(sbF14, "developDevNode(nodeById('n1'))");
  await drain();
  ok(
    listTa(sbF14)[0].value === "写到一半被别的事打断",
    "顶出去之后再开「开发」：接着上次写（不用从头敲）",
  );
  footBtn(sbF14.__host, "取消").onclick();
  await p14c;
  /* ⑤ 空内容提交：就地报错不关框，草稿不被写成空 */
  const sbG14 = mkDlgSandbox();
  const n14g = sbG14.__nodes.filter((n) => n.id === "n1")[0];
  const p14e = ex(sbG14, "developDevNode(nodeById('n1'))");
  await drain();
  footBtn(sbG14.__host, "开始开发").onclick();
  await drain(4);
  ok(sbG14.__devCalls.length === 0, "空内容点「开始开发」不会偷偷开工");
  const err14 = bodyOf(sbG14).querySelectorAll(".mt-form-err")[0];
  ok(!!err14 && !err14.hidden, "空内容就地报错（提示条可见 · 对话框不关）");
  listTa(sbG14)[0].value = "补一句就开工";
  listTa(sbG14)[0].fire("input");
  ok(n14g.devDraft.dev === "补一句就开工", "报错后继续写照样留存");
  footBtn(sbG14.__host, "开始开发").onclick();
  await p14e;
  ok(sbG14.__devCalls.length === 1, "补上内容后即可正常开工");
  /* ⑥ 「建议」方案清单：数字键重绘不吞已写的补充说明 */
  sb = makeSandbox(MODEL_JSON, "", true);
  sb.__formResult = { action: "go", text: "聚焦健壮性" };
  const node14s = sb.__nodes.filter((n) => n.id === "n1")[0];
  const p14s = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  sb.__resolveRun(MODEL_JSON);
  await drain();
  b = sb.__host.querySelector("#mtDlgBody");
  const taS = b.querySelectorAll("textarea")[0];
  ok(taS.value === "聚焦健壮性", "确认框填的关注点带进方案清单的补充框");
  taS.value = "聚焦健壮性 + 顺手补测试";
  taS.fire("input");
  ok(node14s.devDraft.supplement === "聚焦健壮性 + 顺手补测试", "补充说明实时写回草稿");
  sb.__host.fire("keydown", { key: "2" });
  b = sb.__host.querySelector("#mtDlgBody");
  ok(
    b.querySelectorAll("textarea")[0].value === "聚焦健壮性 + 顺手补测试",
    "数字键勾选触发重绘：已写的补充说明不被吞掉",
  );
  footBtn(sb.__host, "开发").onclick();
  await p14s;
  ok(sb.__devCalls.length === 1, "方案清单里的「开发」照常开工");
  ok(sb.__devCalls[0].text.indexOf("顺手补测试") >= 0, "重绘后的补充说明真的进了开发任务书");
  ok(!node14s.devDraft.supplement, "开工后补充说明草稿清空");
  /* ⑦ 接线：四个框共用同一套草稿纪律 + 样式 + 英文词条 */
  ok(
    (appjs14.match(/onText: \(t\) => devDraftSet\(node, "(dev|refine)", t\)/g) || []).length === 2,
    "「开发」「细化」两框都接上实时留存",
  );
  ok(
    (devnode14.match(/onText: \(t\) => devDraftSet\(node, "(suggest|ask)", t\)/g) || []).length === 2,
    "「建议」「问询」两框都接上实时留存",
  );
  ok(
    ((appjs14 + devnode14).match(/devDraftTextareaOpts\(node, "(dev|refine|suggest|ask)"/g) || [])
      .length === 4,
    "四个框都从草稿回填（devDraftTextareaOpts）",
  );
  ok(
    (devnode14.match(/devDraftSet\(node, "supplement", t\)/g) || []).length === 2 &&
      devnode14.indexOf('typeof opts.onSupplement === "function"') >= 0,
    "方案清单补充框：新建议 / 上次建议两条路径都实时留存",
  );
  const cssB14 = read("renderer/css/base.css");
  ok(cssB14.indexOf(".mt-form-draft") >= 0, "base.css：草稿提示行样式");
  const i18n14 = require("../renderer/i18n.js");
  i18n14.setLocale("en");
  ["已恢复上次未提交的内容", "清空草稿", "丢弃上次未提交的内容，重新填写"].forEach((k) =>
    ok(i18n14.t(k) !== k, "「" + k + "」有英文词条"),
  );
  const hintKeys14 = [
    "确认 = 新会话后台运行（工作区 = 项目根目录 · 标题「开发 · 模块名」· 状态转为进行中 · 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · 下方「先拷问需求」开关留在该功能块上（下次打开仍在）· Ctrl+Enter 提交 · Esc 取消",
    "确认 = 新会话后台运行（工作区 = 项目根目录 · 标题「细化 · 模块名」· 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Esc 取消",
    "确认 = 只读评估（工作区 = 项目根目录）· 生成后可多选 / 换一批 · 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 确认 · Esc 取消",
    "确认 = 只读回答（工作区 = 项目根目录 · 强制只读：不改文件、不改画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 提交 · Esc 取消",
  ];
  hintKeys14.forEach((k) => ok(i18n14.t(k) !== k, "提示条有英文词条：" + k.slice(0, 14) + "…"));
  i18n14.setLocale("zh");

  /* ⑧ 「开发」框的「先拷问需求（grill-me）」开关：写 node.devGrill · 重开仍勾着 · 开工后保留 */
  const sbH14 = mkDlgSandbox();
  const n14h = sbH14.__nodes.filter((n) => n.id === "n1")[0];
  const p14h = ex(sbH14, "developDevNode(nodeById('n1'))");
  await drain();
  ok(sbH14.__forms.length === 0, "⑧ 用真实 mtDialogForm 渲染（不走 __forms stub）");
  const grillRow14 = rowFor(bodyOf(sbH14), "先拷问需求（grill-me）");
  ok(!!grillRow14, "「开发」框出现可点的「先拷问需求（grill-me）」复选行");
  ok(
    bodyOf(sbH14).textContent.indexOf("开发前需求确认（可选）") >= 0,
    "开关上有分组标签「开发前需求确认（可选）」",
  );
  const grillDesc14 = grillRow14 && grillRow14.querySelector(".mt-sug-desc");
  ok(
    !!grillDesc14 && grillDesc14.textContent.indexOf("mtnode-grill-me") >= 0,
    "开关下一行说明点名内置技能 mtnode-grill-me（复用 mt-sug-desc 样式）",
  );
  const grillCb14 = cbOf(grillRow14 || { childNodes: [] });
  ok(!!grillCb14 && grillCb14.type === "checkbox", "该行是真 checkbox（不靠 onclick 手搓）");
  ok(
    !!grillCb14 && grillCb14.checked === false && !grillRow14.classList.contains("on"),
    "未设 devGrill 的模块默认不勾、不高亮",
  );
  const saves14 = sbH14.__saves;
  grillCb14.checked = true;
  grillCb14.onchange();
  ok(n14h.devGrill === true, "勾一下 → 立刻写 node.devGrill = true（真源在节点，不在文本草稿）");
  ok(!n14h.devDraft || !n14h.devDraft.dev, "开关不占用 devDraft 草稿槽（提交后不会被清掉）");
  ok(grillRow14.classList.contains("on"), "勾选后行高亮（.on 与方案清单同款式）");
  ok(sbH14.__saves > saves14, "开关切换走 scheduleSave（随画布落盘）");
  footBtn(sbH14.__host, "取消").onclick();
  await p14h;
  const p14h2 = ex(sbH14, "developDevNode(nodeById('n1'))");
  await drain();
  const grillRow14b = rowFor(bodyOf(sbH14), "先拷问需求（grill-me）");
  ok(
    !!grillRow14b && cbOf(grillRow14b).checked === true && grillRow14b.classList.contains("on"),
    "取消后再次打开「开发」：开关仍勾着（粘在该功能块上）",
  );
  listTa(sbH14)[0].value = "本轮加超时与重试";
  listTa(sbH14)[0].fire("input");
  footBtn(sbH14.__host, "开始开发").onclick();
  await p14h2;
  ok(sbH14.__devCalls.length === 1, "开着开关照常开工（不拦截提交）");
  ok(n14h.devGrill === true, "点「开始开发」后开关保留（不像草稿那样被清）");
  const p14h3 = ex(sbH14, "developDevNode(nodeById('n1'))");
  await drain();
  const grillRow14c = rowFor(bodyOf(sbH14), "先拷问需求（grill-me）");
  const grillCb14c = cbOf(grillRow14c);
  grillCb14c.checked = false;
  grillCb14c.onchange();
  ok(n14h.devGrill === false, "再点一次可取消：node.devGrill 落回 false");
  footBtn(sbH14.__host, "取消").onclick();
  await p14h3;
  ok(
    (appjs14.match(/devGrill/g) || []).length >= 4,
    "app.js 里 devGrill 是真源（对话框 + 任务书两处以上读写）",
  );
  ok(
    devnode14.indexOf("devGrill") < 0,
    "「建议 / 细化 / 问询」三框未被改动（开关只加在「开发」框）",
  );
  i18n14.setLocale("en");
  [
    "开发前需求确认（可选）",
    "先拷问需求（grill-me）",
    "开启 = 本次开发会话先用内置技能 mtnode-grill-me 按轮问清需求，达成共识并经你确认后才动手。",
  ].forEach((k) => ok(i18n14.t(k) !== k, "开关文案有英文词条：" + k.slice(0, 12) + "…"));
  ok(i18n14.t(grillLine12) !== grillLine12, "任务书【拷问模式】整段有英文词条");
  i18n14.setLocale("zh");

    console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-dev-suggest)",
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log("FAIL  测试异常：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});

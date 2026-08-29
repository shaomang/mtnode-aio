"use strict";
/* 开发节点「建议」按钮 —— 冒烟测试（纯 Node + 迷你 DOM，不依赖 Electron）
 *   node test/smoke-dev-suggest.js
 * 覆盖：
 *   [1] 建议契约解析（JSON / 代码块 / 键名带空格 / 编号列表兜底 / 脏数据拒绝 / 缓存读写）
 *   [2] 喂给 AI 的「当前开发进度」上下文与只读纪律提示
 *   [3] 勾选结果 → 开发任务正文
 *   [4] 「建议」按钮全流程：确认框 → 只读调研（进度态）→ 4 条方案多选 + 补充 → 就地「开发」
 *   [5] 已有缓存：查看上次建议（不重跑模型）·「换一批」重新评估
 *   [6] 键盘：数字键多选 · Ctrl+Enter 开发 · Esc 取消（并中断调研）
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
    I18n: { t: (k) => k },
    S: { wf: { nodes } },
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

  /* ==================== [3] 勾选 → 开发任务书 ==================== */
  console.log("\n[3] 勾选结果拼成开发任务正文");
  const brief = ex(sb, "devSuggestBriefText(nodeById('n1'), __r, ['o1','o3'], '别改对外 API')");
  ok(brief.indexOf("【按「建议」确认的方案开发】 建议对话框") >= 0, "抬头写明模块名");
  ok(brief.indexOf("1. [优先] 补多选状态持久化") >= 0, "第 1 条带优先级标签");
  ok(brief.indexOf("2. [可延后] 补冒烟测试") >= 0, "第 3 条按显示序写成第 2 项");
  ok(brief.indexOf("用户已勾选 2 / 4") >= 0, "写明勾选数量");
  ok(brief.indexOf("本轮明确不做：加键盘操作、方案去重") >= 0, "未选项进「明确不做」");
  ok(brief.indexOf("用户补充：别改对外 API") >= 0, "补充说明被带上");
  ok(brief.indexOf("完成后更新画布上该开发节点的概述") >= 0, "要求回写概述与状态");
  const bare = ex(sb, "devSuggestBriefText(nodeById('n1'), __r, [], '只做这个')");
  ok(bare.indexOf("用户未采纳 AI 提议的方案") >= 0, "一条都没勾时按补充内容开发");

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
  ok(form.note && String(form.note.text).indexOf("建议 / 开发 / 细化") >= 0, "确认框显示模块概述");
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
  ok(ropts.effort === "high" && ropts.preset === "standard", "用 standard 预设 + 高推理档");
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
  /* Esc：中断调研并关闭 */
  sb = makeSandbox(MODEL_JSON, "", true);
  sb.__formResult = { action: "go" };
  const node6 = sb.__nodes.filter((n) => n.id === "n1")[0];
  const p6b = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  sb.__host.fire("keydown", { key: "Escape" });
  await p6b;
  ok(sb.__cancel.join(",") === "devsuggest:n1", "Esc 会中断正在跑的只读调研");
  ok(!node6.devSuggest, "中断后不写坏节点缓存");
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
  ok(read("dsh/gateway/gateway.mjs").indexOf("each dev node also has a 建议 button") >= 0, "网关人设含「建议」");
  ok(
    read("renderer/app-assist.js").indexOf("每个开发节点有「建议」「开发」「细化」按钮") >= 0,
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
    (assistRun9.match(/updateRunQueuePanel\(\)/g) || []).length === 5,
    "app-assist 会话开始 / 结束各刷一次运行队列（共 5 处）",
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

  /* ==================== [11] 开发节点 Agent 模型（本块 + 未自选子块共用） ==================== */
  console.log("\n[11] Agent 模型：devModel 就近继承 + 选择弹层 + 会话 / 调研接线");
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
  /* ---- 「建议」只读调研真的用所选模型 ---- */
  sb = makeSandbox(MODEL_JSON, null, true);
  ex(sb, "nodeById('top').devModel = 'deepseek-v4-pro'; nodeById('top').devProvider = 'deepseek-official'");
  sb.__formResult = { action: "go" };
  const p11 = ex(sb, "suggestDevNode(nodeById('n1'))");
  await drain();
  const form11 = sb.__forms[sb.__forms.length - 1];
  ok(
    form11.rows.some((x) => x[0] === "Agent 模型" && x[1].indexOf("deepseek-v4-pro") >= 0),
    "「建议」确认框列出 Agent 模型",
  );
  ok(sb.__runCalls.length === 1, "确认后开始只读调研");
  ok(sb.__runCalls[0].opts.model === "deepseek-v4-pro", "「建议」调研用上层功能块所选模型");
  ok(sb.__runCalls[0].opts.provider === "deepseek-official", "调研带上对应智能路由");
  ok(
    sb.__host.querySelector("#mtDlgBody").textContent.indexOf("本轮模型：") >= 0,
    "进度日志显示本轮实际使用的模型",
  );
  sb.__resolveRun(MODEL_JSON);
  await drain();
  footBtn(sb.__host, "取消").onclick();
  await p11;
  /* ---- 接线：会话 / 序列化 / 网关 / 样式 / 文档 ---- */
  const appjs11 = read("renderer/app.js");
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
  ok(appjs11.indexOf("S.uiDevModelNode") >= 0, "app.js 全局点击收起模型弹层（点外部）");
  ok(
    appjs11.indexOf('if (ev.key === "Escape" && (S.uiDevColorNode || S.uiDevModelNode))') >= 0,
    "app.js：Esc 同时收起色板与模型弹层",
  );
  const canvas11 = read("renderer/app-canvas.js");
  ok(canvas11.indexOf("devModelButtonEl(node)") >= 0, "节点头部菜单栏接入模型按钮");
  ok(canvas11.indexOf("n-dev-model-info") >= 0, "折叠卡显示生效模型行");
  const nodes11 = read("renderer/app-nodes.js");
  ok(nodes11.indexOf("patch.devModel") >= 0, "app-nodes 支持 devModel 补丁（Agent 可改模型）");
  ok(nodes11.indexOf("patch.devProvider") >= 0, "app-nodes 支持 devProvider 补丁");
  ok((nodes11.match(/devModel:/g) || []).length >= 2, "devModel 随工作流保存并进画布快照（canvas_get 可见）");
  const gw11 = read("dsh/gateway/canvas-plugin.mjs");
  ok(
    (gw11.match(/devModel:/g) || []).length >= 2 && gw11.indexOf("devProvider") >= 0,
    "网关 schema 暴露 devModel / devProvider（Agent 能设）",
  );
  ok((gw11.match(/devColor:/g) || []).length >= 2, "网关 schema 暴露 devColor（Agent 能改颜色）");
  ok(
    gw11.indexOf("dev/devPath/devStatus/devKind/devColor/devModel/devProvider") >= 0,
    "canvas_get 工具描述透出这些字段",
  );
  const cssC11 = read("renderer/css/canvas.css");
  ok(cssC11.indexOf(".n-dev-model") >= 0, "canvas.css：头部模型按钮样式");
  ok(cssC11.indexOf(".n-dev-info .n-dev-model-info") >= 0, "canvas.css：折叠卡生效模型行样式");
  const cssComp11 = read("renderer/css/components.css");
  ok(
    cssComp11.indexOf(".dev-model-pop") >= 0 && cssComp11.indexOf(".dev-model-list") >= 0,
    "components.css：模型选择弹层样式",
  );
  ok(cssComp11.indexOf("*/.dev-color-pop") < 0, "components.css：色板注释与规则不再粘连");
  const guide11 = read("guides/manual/dev-nodes.md");
  ok(guide11.indexOf("Agent 模型 devModel") >= 0, "中文手册写明 Agent 模型");
  ok(guide11.indexOf("devColor") >= 0 && guide11.indexOf("HSV") >= 0, "中文手册写明节点颜色");
  ok(read("guides/manual/en/dev-nodes.md").indexOf("Agent model devModel") >= 0, "英文手册写明 Agent model");
  const skill11 = read("mtnode-agent-skills/mtnode/dev-architect/SKILL.md");
  ok(skill11.indexOf("就近继承") >= 0, "dev-architect 技能说明模型就近继承");
  ok(skill11.indexOf("devColor") >= 0, "dev-architect 技能说明节点颜色");
  ok(read("mtnode-agent-skills/index.json").indexOf("devModel") >= 0, "技能索引已重建并含 devModel");
  const chg11 = read("CHANGELOG-v1.1.md");
  ok(
    chg11.indexOf("devModel") >= 0 && chg11.indexOf("就近向上继承") >= 0,
    "版本更新文档写明 Agent 模型与就近继承",
  );
  ok(chg11.indexOf("devColor") >= 0, "版本更新文档写明节点自定义颜色");
  const i18n11 = require("../renderer/i18n.js");
  i18n11.setLocale("en");
  ok(i18n11.t("Agent 模型") !== "Agent 模型", "「Agent 模型」有英文词条");
  ok(i18n11.t("跟随默认（不指定）") !== "跟随默认（不指定）", "「跟随默认（不指定）」有英文词条");
  ok(i18n11.t("自动（跟随默认）") !== "自动（跟随默认）", "「自动（跟随默认）」有英文词条");
  i18n11.setLocale("zh");

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
